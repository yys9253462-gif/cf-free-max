/**
 * 构建补丁 —— 部署前对仓库做的临时调整
 *
 * 为什么需要这个机制：
 *   上游依赖经常有版本兼容问题（如 @astrojs/rss@4.0.14 与 zod 4 不兼容，
 *   构建到 RSS 路由就崩）。这类问题不该由用户手动改源码解决 ——
 *   手工改的东西下次 clone 就没了，而且容易忘。
 *
 *   所以把「为了能构建成功必须做的调整」写成声明式补丁，
 *   每次部署前自动应用，并记录做了什么。
 *
 * 设计原则：
 *   1. **幂等** —— 重复应用不出错（检查后再改）
 *   2. **可跳过** —— 补丁失败不中断部署，只警告
 *   3. **可追溯** —— 每次应用都打印做了什么、为什么
 *   4. **不破坏源码** —— 优先用环境变量/配置而非改代码；
 *      必须改文件时，先备份成 .cfm-backup
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, color as c } from './util.mjs';

/**
 * @typedef {{id:string, desc:string, reason:string, apply:(dir:string)=>Promise<{changed:boolean, note:string}>|{changed:boolean, note:string}}} Patch
 */

/** 可用的补丁库 */
export const PATCHES = {
  /**
   * 移除 RSS 路由 —— 绕开 @astrojs/rss 与 zod 4 的兼容问题。
   *
   * 症状：构建时 /rss.xml 报 "z.function(...).returns is not a function"，
   *       但其他所有页面都正常生成。
   * 影响：站点没有 RSS 订阅源，其余功能不受影响。
   */
  'disable-rss-route': {
    id: 'disable-rss-route',
    desc: '禁用 RSS 路由文件',
    reason: '@astrojs/rss@4.x 与 zod 4 不兼容，构建 RSS 路由时崩溃。站点其他部分不受影响。',
    apply(dir) {
      const candidates = [
        'src/pages/rss.xml.ts',
        'src/pages/rss.xml.js',
        'src/pages/rss.ts',
        'src/pages/rss.js',
        'src/pages/feed.xml.ts',
        'src/pages/feed.xml.js',
      ];

      const found = candidates.map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
      if (!found.length) {
        return { changed: false, note: '没有找到 RSS 路由文件（可能已处理过）' };
      }

      // ⚠️ 关键：不能只在原目录改扩展名。
      //    实测踩过：`rss.xml.ts` → `rss.xml.ts.cfm-disabled` 后，
      //    Astro 仍然会扫描它（因为文件名里还含 `.ts`），
      //    结果报 PARSE_ERROR，比原来更糟。
      //
      //    正解：把文件**移到仓库外的备份目录**，
      //    这样构建器完全看不到它。
      const backupDir = path.join(dir, '..', '.cfm-disabled', path.basename(dir));
      fs.mkdirSync(backupDir, { recursive: true });

      const disabled = [];
      for (const file of found) {
        const rel = path.relative(dir, file);
        const target = path.join(backupDir, rel.replace(/[/\\]/g, '__'));
        fs.renameSync(file, target);
        disabled.push(rel);
      }

      return {
        changed: true,
        note: `已移出：${disabled.join(', ')}（备份在 .cfm-disabled/）`,
      };
    },
  },

  /**
   * 从 astro.config 里移除 sitemap 集成。
   *
   * 症状：构建到 "astro:build:done" 钩子时 @astrojs/sitemap 报
   *       "An unhandled error occurred"，同样是 zod 4 兼容问题。
   * 影响：没有 sitemap.xml，搜索引擎收录会慢一些，站点本身不受影响。
   */
  'disable-sitemap': {
    id: 'disable-sitemap',
    desc: '禁用 sitemap 集成',
    reason: '@astrojs/sitemap 在 astro:build:done 钩子里崩溃（同样是 zod 4 兼容问题）。没有 sitemap.xml 只是影响收录速度。',
    apply(dir) {
      const configs = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'];
      const configPath = configs.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));

      if (!configPath) {
        return { changed: false, note: '没有找到 astro.config' };
      }

      let text = fs.readFileSync(configPath, 'utf8');
      const original = text;
      const changes = [];

      // 1. 注释掉 import 语句
      if (/^\s*import\s+sitemap\s+from\s+["']@astrojs\/sitemap["'];?\s*$/m.test(text)) {
        text = text.replace(
          /^(\s*)(import\s+sitemap\s+from\s+["']@astrojs\/sitemap["'];?)\s*$/m,
          '$1// [cfm-patch] $2',
        );
        changes.push('已注释 sitemap import');
      }

      // 2. 从 integrations 数组里移除 sitemap() 调用
      if (/^\s*sitemap\(\),?\s*$/m.test(text)) {
        text = text.replace(/^(\s*)(sitemap\(\),?)\s*$/m, '$1// [cfm-patch] $2');
        changes.push('已注释 sitemap() 调用');
      }

      if (text === original) {
        return { changed: false, note: '配置里没有 sitemap（可能已处理过）' };
      }

      // 备份（只在首次时）
      const backup = `${configPath}.cfm-backup`;
      if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup);

      fs.writeFileSync(configPath, text, 'utf8');
      return { changed: true, note: changes.join('；') };
    },
  },

  /**
   * 强制使用 npm 而不是 pnpm —— 当 pnpm 环境有问题时的兜底。
   */
  'force-npm': {
    id: 'force-npm',
    desc: '改用 npm 安装依赖',
    reason: 'pnpm 在当前环境不可用或行为异常',
    apply() {
      return { changed: false, note: '这是安装器层面的选项，由 forceNpm 标志控制' };
    },
  },

  /**
   * 移除 astro check（如果 package.json 的 build 脚本里带了）。
   *
   * 有些项目的 build 脚本是 `astro check && astro build`，
   * 类型检查失败会导致构建中断，但类型问题通常不影响运行。
   */
  'skip-astro-check': {
    id: 'skip-astro-check',
    desc: '跳过 build 前的类型检查',
    reason: 'astro check 的类型错误通常不影响运行，但会中断构建',
    apply(dir) {
      const pkgPath = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgPath)) return { changed: false, note: '没有 package.json' };

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const build = pkg.scripts?.build;
      if (!build) return { changed: false, note: '没有 build 脚本' };

      if (!/astro\s+check/.test(build)) {
        return { changed: false, note: `build 脚本不含 astro check（当前：${build}）` };
      }

      const backup = `${pkgPath}.cfm-backup`;
      if (!fs.existsSync(backup)) fs.copyFileSync(pkgPath, backup);

      pkg.scripts.build = build.replace(/astro\s+check\s*&&\s*/, '');
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

      return { changed: true, note: `build 脚本：${build} → ${pkg.scripts.build}` };
    },
  },

  /**
   * 允许构建失败但产物完整时继续部署。
   *
   * 场景：像 RSS 那种「单个路由崩了但其他都生成好了」的情况。
   * 这个补丁本身不改文件，只是改动行为标记（由 runner 读取）。
   */
  'tolerate-partial-build': {
    id: 'tolerate-partial-build',
    desc: '构建失败但产物完整时继续',
    reason: '某个路由崩溃不影响其余页面时，仍然部署已生成的部分',
    apply() {
      return { changed: false, note: '这是行为标记，由部署引擎读取' };
    },
  },

  /**
   * 把 astro.config 里的 site 域名改成实际部署的域名。
   *
   * 为什么需要：
   *   分享出去的仓库里 site 是占位符（blog.example.com），
   *   别人部署后所有页面的 canonical / og:url 都指向这个不存在的域名 ——
   *   SEO 出问题，社交分享的预览也拿不到图。
   *
   *   用补丁而不是让用户改源码：改源码的东西下次 pull 就没了。
   *
   * 域名从环境变量 CFM_SITE_URL 读（deploy 命令在调用补丁前会设置）。
   */
  'fix-astro-site-url': {
    id: 'fix-astro-site-url',
    desc: '修正 astro.config 的站点域名',
    reason: '仓库里的 site 是占位符，需改成实际部署域名，否则 canonical/og:url 会指向错误地址',
    apply(dir) {
      const configs = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'];
      const configPath = configs.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
      if (!configPath) return { changed: false, note: '没有找到 astro.config' };

      const targetUrl = process.env.CFM_SITE_URL;
      if (!targetUrl) {
        return { changed: false, note: '未提供 CFM_SITE_URL，跳过' };
      }

      let text = fs.readFileSync(configPath, 'utf8');
      const original = text;

      const re = /(\bsite\s*:\s*)(["'])([^"']*)(\2)/;
      const m = text.match(re);
      if (!m) return { changed: false, note: '配置里没有 site 字段' };

      const before = m[3];
      const clean = targetUrl.replace(/\/$/, '');
      if (before === clean || before === clean + '/') {
        return { changed: false, note: `site 已是 ${clean}` };
      }

      text = text.replace(re, `$1$2${clean}/$2`);

      const backup = `${configPath}.cfm-backup`;
      if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup);

      fs.writeFileSync(configPath, text, 'utf8');
      return { changed: true, note: `site: ${before} → ${clean}/` };
    },
  },

  /**
   * 修正 Decap CMS 的 base_url（网页后台的回调地址）。
   */
  'fix-cms-base-url': {
    id: 'fix-cms-base-url',
    desc: '修正 CMS 后台的回调域名',
    reason: 'public/admin/config.yml 里的 base_url 是占位符，不改的话后台登录会跳到错误地址',
    apply(dir) {
      const cfgPath = path.join(dir, 'public', 'admin', 'config.yml');
      if (!fs.existsSync(cfgPath)) {
        return { changed: false, note: '没有 public/admin/config.yml' };
      }

      const targetUrl = process.env.CFM_SITE_URL;
      if (!targetUrl) {
        return { changed: false, note: '未提供 CFM_SITE_URL，跳过' };
      }

      let text = fs.readFileSync(cfgPath, 'utf8');
      const original = text;
      const root = targetUrl.replace(/\/$/, '');

      const re = /(\s*base_url\s*:\s*)(\S+)/;
      const m = text.match(re);
      if (!m) return { changed: false, note: '配置里没有 base_url' };
      if (m[2] === root) return { changed: false, note: `base_url 已是 ${root}` };

      text = text.replace(re, `$1${root}`);

      const backup = `${cfgPath}.cfm-backup`;
      if (!fs.existsSync(backup)) fs.copyFileSync(cfgPath, backup);

      fs.writeFileSync(cfgPath, text, 'utf8');
      return { changed: true, note: `base_url: ${m[2]} → ${root}` };
    },
  },
};

/**
 * 应用补丁列表。
 *
 * @param {string} repoDir
 * @param {string[]} patchIds
 * @returns {Promise<{applied:string[], skipped:string[], notes:string[]}>}
 */
export async function applyPatches(repoDir, patchIds) {
  const applied = [];
  const skipped = [];
  const notes = [];

  if (!patchIds || patchIds.length === 0) return { applied, skipped, notes };

  console.log('');
  log.step(`应用构建补丁（${patchIds.length} 个）`);

  for (const id of patchIds) {
    const patch = PATCHES[id];
    if (!patch) {
      log.warn(`未知补丁「${id}」，跳过`);
      log.dim(`  可用：${Object.keys(PATCHES).join(', ')}`);
      skipped.push(id);
      continue;
    }

    try {
      const result = await patch.apply(repoDir);
      if (result.changed) {
        log.ok(`${patch.desc}`);
        log.dim(`    ${result.note}`);
        log.dim(`    原因：${patch.reason}`);
        applied.push(id);
      } else {
        log.dim(`− ${patch.desc}：${result.note}`);
        skipped.push(id);
      }
      notes.push(`${id}: ${result.note}`);
    } catch (e) {
      log.warn(`${patch.desc} 失败：${e.message}`);
      log.dim('  （补丁失败不中断部署，继续）');
      skipped.push(id);
      notes.push(`${id}: 失败 - ${e.message}`);
    }
  }

  return { applied, skipped, notes };
}

/**
 * 检查构建产物是否「足够完整」，用于 tolerate-partial-build 判断。
 *
 * 判据：产物里有 index.html 且文件数超过阈值。
 * 这样即使某个路由崩了，只要主站生成好了就照常部署。
 *
 * @param {string} outDir
 * @param {{minFiles?:number}} [opts]
 * @returns {{complete:boolean, files:number, hasIndex:boolean, reason:string}}
 */
export function assessBuildOutput(outDir, opts = {}) {
  const minFiles = opts.minFiles ?? 5;

  if (!fs.existsSync(outDir)) {
    return { complete: false, files: 0, hasIndex: false, reason: '输出目录不存在' };
  }

  let files = 0;
  let hasIndex = false;
  const stack = [outDir];

  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git'].includes(e.name)) continue;
        stack.push(full);
      } else {
        files++;
        if (e.name === 'index.html' && path.dirname(full) === outDir) hasIndex = true;
      }
    }
  }

  if (!hasIndex) {
    return { complete: false, files, hasIndex, reason: '缺少根目录 index.html' };
  }
  if (files < minFiles) {
    return { complete: false, files, hasIndex, reason: `只有 ${files} 个文件，少于 ${minFiles} 个，可能没构建完` };
  }

  return { complete: true, files, hasIndex, reason: `${files} 个文件，含 index.html` };
}
