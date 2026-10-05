/**
 * deploy — 一键搭建/更新三个 Pages 站点
 *
 * 用法：
 *   cfm deploy                     全部站点，全流程（clone → build → deploy）
 *   cfm deploy --only blog         只处理某一个
 *   cfm deploy --skip clone        跳过某一步（复用已 clone 的代码）
 *   cfm deploy --only deploy       只重新部署（代码已就绪时最快）
 *   cfm deploy --list              只显示配置与当前状态，不做任何事
 *   cfm deploy --dry-run           打印将要做什么，不实际执行
 *   cfm deploy --check             环境体检（git/node/wrangler/认证）
 */

import path from 'node:path';
import fs from 'node:fs';
import { log, table, color as c, confirm, humanBytes } from '../lib/util.mjs';
import { loadConfig, inspectRepo, ConfigError } from '../lib/deploy-config.mjs';
import { applyPatches, PATCHES } from '../lib/deploy-patches.mjs';
import { progressBar } from '../lib/spinner.mjs';
import {
  stepClone,
  stepBuild,
  stepDeploy,
  verifyDeployment,
  probeCommand,
  checkNodeVersion,
  detectPackageManager,
  runCommand,
  OK,
  FAIL,
  SKIP,
} from '../lib/deploy-runner.mjs';

export async function run({ flags }) {
  // ─── 加载配置 ───
  let cfg;
  try {
    cfg = loadConfig(flags.config ? String(flags.config) : undefined);
  } catch (e) {
    if (e instanceof ConfigError) {
      log.err(e.message);
      console.log('');
      log.dim('配置模板：config/sites.json');
      log.dim('说明文档：docs/deploy.md');
      return 2;
    }
    throw e;
  }

  // ─── 子模式 ───
  if (flags.list) return listSites(cfg);
  if (flags.check) return checkEnv(cfg);
  if (flags['check-online']) return checkOnline(cfg, flags);
  if (flags['list-bindings']) return listBindings(cfg, flags);

  // ─── 选择要处理的站点 ───
  let sites = cfg.sites;
  const protectedSites = cfg.sites.filter((s) => s.protected);

  // ── 保护机制第 1 层：默认排除 ──
  // 带 protected:true 的站点（如正在服务的网盘）默认**完全不参与**
  // clone/构建/部署，连出现在待处理列表里都不会。
  if (!flags['include-protected']) {
    sites = sites.filter((s) => !s.protected);
  }

  if (flags.only) {
    const wanted = String(flags.only)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // ── 保护机制第 2 层：显式指定时也要二次确认 ──
    const protectedWanted = wanted.filter((w) => cfg.sites.some((s) => s.protected && (s.id === w || s.repo === w || s.project === w)));
    if (protectedWanted.length && !flags['include-protected']) {
      log.err(`「${protectedWanted.join(', ')}」是受保护的站点，默认不允许部署。`);
      console.log('');
      for (const w of protectedWanted) {
        const s = cfg.sites.find((x) => x.id === w || x.repo === w || x.project === w);
        console.log(`  ${c.yellow}🔒 ${s.label}（${s.id}）${c.reset}`);
        console.log(`     ${s.protectedReason}`);
        console.log(`     域名：${s.domain || '(未设置)'}  Pages 项目：${s.project}`);
      }
      console.log('');
      log.dim('如果你确实要重新部署它（会覆盖线上内容），需要同时加两个参数：');
      console.log(`  ${c.cyan}cfm deploy --only ${protectedWanted[0]} --include-protected --yes${c.reset}`);
      console.log('');
      return 3;
    }

    sites = sites.filter((s) => wanted.includes(s.id) || wanted.includes(s.repo) || wanted.includes(s.project));
    const missing = wanted.filter((w) => !cfg.sites.some((s) => s.id === w || s.repo === w || s.project === w));
    if (missing.length) {
      log.err(`找不到站点：${missing.join(', ')}`);
      log.info(`可用：${cfg.sites.map((s) => s.id).join(', ')}`);
      return 2;
    }
  }

  // ── 保护机制第 3 层：即使带了 --include-protected，也要逐站确认 ──
  const toUnprotect = sites.filter((s) => s.protected);
  if (toUnprotect.length) {
    console.log('');
    log.warn(`以下 ${toUnprotect.length} 个站点处于「只读保护」状态，本次确实要操作它们：`);
    console.log('');
    for (const s of toUnprotect) {
      console.log(`  ${c.yellow}🔒 ${s.label}（${s.id}）${c.reset}`);
      console.log(`     ${s.protectedReason}`);
      console.log(`     ${c.dim}仓库 ${s.repo} → Pages 项目 ${s.project}${c.reset}`);
      if (s.domain) console.log(`     ${c.dim}线上域名：${s.domain}${c.reset}`);
    }
    console.log('');
    log.warn('操作会重新构建并覆盖线上内容。如果只是想看看状态，用 cfm deploy --list。');
    console.log('');

    if (!flags.yes && !flags['dry-run']) {
      if (!(await confirm('确认要继续操作这些受保护的站点？', false))) {
        log.info('已取消。受保护的站点未被触碰。');
        return 0;
      }
    }
  }

  if (!sites.length) {
    log.warn('没有需要处理的站点。');
    console.log('');
    if (protectedSites.length) {
      log.dim(`${protectedSites.length} 个站点受保护，已跳过：${protectedSites.map((s) => s.id).join(', ')}`);
    }
    log.dim('用 cfm deploy --list 查看全部站点状态。');
    console.log('');
    return 0;
  }

  // ─── 决定执行哪些步骤 ───
  const skip = new Set(
    String(flags.skip ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const onlySteps = flags.steps ? String(flags.steps).split(',').map((s) => s.trim()) : null;
  const wantStep = (name) => {
    if (onlySteps) return onlySteps.includes(name);
    return !skip.has(name);
  };

  // ─── 认证 ───
  const token = flags.token ? String(flags.token) : process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';
  const accountId = flags.account || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '';

  // ─── 头部信息 ───
  console.log('');
  console.log(`${c.bold}Cloudflare Pages 一键部署${c.reset}`);
  console.log(
    `  ${c.dim}工作区${c.reset}  ${cfg.workspace}` +
      `\n  ${c.dim}站点数${c.reset}  ${sites.length}` +
      `\n  ${c.dim}认证${c.reset}    ${token ? 'API Token' : 'wrangler 登录状态'}` +
      (flags['dry-run'] ? `\n  ${c.yellow}模式      dry-run（只打印，不执行）${c.reset}` : ''),
  );
  console.log('');

  const steps = [];
  if (wantStep('clone')) steps.push('clone');
  if (wantStep('build')) steps.push('build');
  if (wantStep('deploy')) steps.push('deploy');
  console.log(`  执行步骤：${steps.join(' → ')}`);
  console.log('');

  if (!(await confirm('开始？', { force: flags.yes || flags['dry-run'] }))) {
    log.info('已取消。');
    return 0;
  }

  // ─── 逐个站点执行 ───
  /** @type {any[]} */
  const results = [];

  const overall = sites.length > 1 ? progressBar(sites.length, { label: '站点' }) : null;

  for (const site of sites) {
    console.log('');
    if (overall) overall.done();
    console.log(`${c.cyan}${'─'.repeat(60)}${c.reset}`);
    console.log(`${c.bold}${site.label}${c.reset} ${c.dim}(${site.id} → ${site.project})${c.reset}`);
    console.log(`${c.cyan}${'─'.repeat(60)}${c.reset}`);
    console.log('');

    const result = { site, status: OK, steps: {}, errors: [], url: '' };

    // ── clone ──
    if (wantStep('clone')) {
      log.step('步骤 1/3  获取代码');
      const r = await stepClone(site, cfg, { update: true });
      result.steps.clone = r.status;
      if (r.note) log.ok(r.note);
      if (r.status === FAIL) {
        log.err(r.error);
        result.status = FAIL;
        result.errors.push(`clone: ${r.error}`);
        results.push(result);
        if (!flags.continue) {
          log.dim('\n  已中止（加 --continue 可跳过失败项继续）');
          break;
        }
        continue;
      }
      log.dim(`  ${r.dir}`);
    }

    // ── build ──
    if (wantStep('build')) {
      log.step('步骤 2/3  构建');

      // 构建补丁：处理上游依赖的兼容问题（如 RSS 与 zod 4 冲突）
      const patchIds = flags['no-patches'] ? [] : site.patches ?? [];
      if (patchIds.length) {
        const pr = await applyPatches(path.join(cfg.workspace, site.repo), patchIds);
        result.patches = pr;
      }

      const r = await stepBuild(site, cfg, {});
      result.steps.build = r.status;
      if (r.note) log.ok(r.note);
      if (r.partial) log.warn('（部分页面构建失败，但主站产物完整）');
      if (r.status === FAIL) {
        log.err(r.error);
        result.status = FAIL;
        result.errors.push(`build: ${r.error}`);
        results.push(result);
        if (!flags.continue) {
          log.dim('\n  已中止（加 --continue 可跳过失败项继续）');
          break;
        }
        continue;
      }
    }

    // ── 绑定检查 ──
    if (wantStep('deploy') && site.bindings?.length && !flags['skip-binding-check']) {
      const check = await checkBindings(site, cfg, { token, accountId, quiet: true });
      if (!check.ok) {
        log.warn('绑定检查有问题：');
        for (const m of check.messages) console.log(`  ${c.dim}${m}${c.reset}`);
        if (check.blocking) {
          result.status = FAIL;
          result.errors.push(`bindings: ${check.messages.join('; ')}`);
          results.push(result);
          if (!flags.continue) {
            log.dim('\n  已中止。用 --skip-binding-check 可强制继续。');
            break;
          }
          continue;
        }
      } else if (check.messages.length) {
        for (const m of check.messages) log.ok(m);
      }
    }

    // ── deploy ──
    if (wantStep('deploy')) {
      log.step('步骤 3/3  部署');
      const r = await stepDeploy(site, cfg, {
        token,
        accountId,
        dryRun: !!flags['dry-run'],
        verbose: !!flags.verbose,
      });
      result.steps.deploy = r.status;
      if (r.note) log.ok(r.note);
      if (r.url) {
        result.url = r.url;
        log.dim(`  ${r.url}`);
      }
      if (r.status === FAIL) {
        log.err(r.error);
        result.status = FAIL;
        result.errors.push(`deploy: ${r.error}`);
        results.push(result);
        if (!flags.continue) {
          log.dim('\n  已中止（加 --continue 可跳过失败项继续）');
          break;
        }
        continue;
      }

      // ── 部署后验证 ──
      if (cfg.options.verifyAfterDeploy && r.url && !flags['no-verify'] && !flags['dry-run']) {
        log.info('验证部署是否生效 ...');
        const v = await verifyDeployment(r.url, { timeoutMs: 30000 });
        if (v.ok) {
          log.ok(`访问正常（HTTP ${v.status}，${humanBytes(v.bytes)}，第 ${v.attempts} 次尝试）`);
        } else {
          log.warn(`验证未通过：${v.error}`);
          log.dim('  这不是致命错误 —— CDN 生效通常需要几十秒。稍后手动访问确认。');
          result.errors.push(`verify: ${v.error}`);
        }
      }
    }

    results.push(result);
    if (overall) overall.advance(1, site.label);
  }

  // ─── 汇总 ───
  if (overall) overall.done();
  console.log('');
  console.log(`${c.bold}${'═'.repeat(60)}${c.reset}`);
  console.log(`${c.bold}结果汇总${c.reset}`);
  console.log(`${c.bold}${'═'.repeat(60)}${c.reset}`);
  console.log('');

  table(
    ['站点', '获取代码', '构建', '部署', '地址'],
    results.map((r) => [
      r.site.label,
      statusIcon(r.steps.clone),
      statusIcon(r.steps.build),
      statusIcon(r.steps.deploy),
      r.url || '—',
    ]),
  );

  const failed = results.filter((r) => r.status === FAIL);
  const okCount = results.length - failed.length;

  console.log('');
  if (!failed.length) {
    log.ok(`全部完成（${okCount}/${sites.length}）`);
    if (results.some((r) => r.url)) {
      console.log('');
      console.log(`  ${c.dim}部署地址${c.reset}`);
      for (const r of results) {
        if (r.url) console.log(`    ${r.site.label.padEnd(10)} ${c.cyan}${r.url}${c.reset}`);
        if (r.site.domain) console.log(`    ${''.padEnd(10)} ${c.dim}自定义域 ${r.site.domain}（可能需要几分钟生效）${c.reset}`);
      }
    }
  } else {
    log.err(`${failed.length} 个站点失败，${okCount} 个成功`);
    console.log('');
    for (const r of failed) {
      console.log(`  ${c.red}✘${c.reset} ${c.bold}${r.site.label}${c.reset}`);
      for (const e of r.errors) {
        console.log(`      ${e.split('\n').join('\n      ')}`);
      }
      console.log('');
    }
    log.dim('重新运行时会跳过已完成的步骤，不用从头来。');
  }

  console.log('');
  return failed.length ? 1 : 0;
}

// ═══════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════

function statusIcon(s) {
  if (s === OK) return `${c.green}✔${c.reset}`;
  if (s === FAIL) return `${c.red}✘${c.reset}`;
  if (s === SKIP) return `${c.dim}−${c.reset}`;
  return `${c.dim}·${c.reset}`;
}

/** 列出配置与当前状态 */
async function listSites(cfg) {
  console.log('');
  console.log(`${c.bold}配置的站点${c.reset}  ${c.dim}config/sites.json${c.reset}`);
  console.log('');

  const rows = [];
  for (const s of cfg.sites) {
    const info = inspectRepo(s, cfg.workspace);
    let state;
    if (s.protected) state = `${c.yellow}🔒 受保护${c.reset}`;
    else if (!info.exists) state = `${c.dim}未克隆${c.reset}`;
    else if (!info.cloned) state = `${c.yellow}存在但非仓库${c.reset}`;
    else state = `${c.green}${info.branch}${c.reset} ${c.dim}${info.commit ?? ''}${c.reset}`;

    rows.push([
      s.id,
      s.label,
      s.repo,
      s.project,
      s.type === 'build' ? `构建 → ${s.outputDir}` : `静态 → ${s.outputDir}`,
      s.bindings?.length ? s.bindings.map((b) => b.type.toUpperCase()).join('+') : '无',
      state,
    ]);
  }

  table(['id', '名称', '仓库', 'Pages 项目', '类型', '绑定', '本地状态'], rows);

  // 受保护站点的说明
  const protectedSites = cfg.sites.filter((s) => s.protected);
  if (protectedSites.length) {
    console.log('');
    console.log(`${c.yellow}${c.bold}受保护的站点${c.reset}  ${c.dim}（脚本不会 clone / 构建 / 部署它们）${c.reset}`);
    console.log('');
    for (const s of protectedSites) {
      console.log(`  ${c.yellow}🔒${c.reset} ${c.bold}${s.label}${c.reset} ${c.dim}(${s.id})${c.reset}`);
      console.log(`      ${s.protectedReason}`);
      if (s.domain) console.log(`      ${c.dim}线上：${s.domain}${c.reset}`);
    }
    console.log('');
    console.log(`  ${c.dim}要看它们的线上状态（只读）：cfm deploy --check-online${c.reset}`);
  }

  console.log('');
  console.log(`  ${c.dim}工作区${c.reset}  ${cfg.workspace}`);
  console.log('');
  console.log(`  ${c.dim}执行全部${c.reset}      cfm deploy                    ${c.dim}（受保护的站点自动跳过）${c.reset}`);
  console.log(`  ${c.dim}只做一个${c.reset}      cfm deploy --only blog`);
  console.log(`  ${c.dim}预演${c.reset}          cfm deploy --dry-run`);
  console.log(`  ${c.dim}环境体检${c.reset}      cfm deploy --check`);
  console.log(`  ${c.dim}线上状态${c.reset}      cfm deploy --check-online     ${c.dim}（只读）${c.reset}`);
  console.log('');

  return 0;
}

/**
 * 只读检查线上状态。
 *
 * 这是保护型站点的正确用法：不碰本地代码、不部署，只访问线上域名
 * 确认服务正常。这样「正在用的网盘」也能纳入统一巡检，
 * 又完全没有被覆盖的风险。
 */
async function checkOnline(cfg, flags) {
  const token = flags.token ? String(flags.token) : process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const account = flags.account || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;

  console.log('');
  console.log(`${c.bold}线上状态检查${c.reset}  ${c.dim}（只读，不修改任何东西）${c.reset}`);
  console.log('');

  const rows = [];

  for (const site of cfg.sites) {
    const urls = [];
    if (site.domain) urls.push(`https://${site.domain}`);
    urls.push(`https://${site.project}.pages.dev`);

    let result = `${c.dim}—${c.reset}`;

    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'cfm-check/1.0' },
          redirect: 'follow',
        });
        clearTimeout(timer);

        const text = await res.text();
        const bytes = text.length;

        if (res.status === 200 && bytes > 100) {
          result = `${c.green}HTTP 200${c.reset} ${c.dim}${humanBytes(bytes)}${c.reset}`;
        } else if (res.status === 200) {
          result = `${c.yellow}HTTP 200 但内容空${c.reset}`;
        } else {
          result = `${c.red}HTTP ${res.status}${c.reset}`;
        }
        break;
      } catch (e) {
        result = `${c.red}${e.name === 'AbortError' ? '超时' : '连接失败'}${c.reset}`;
        // 继续试下一个 URL
      }
    }

    // Cloudflare 上的项目信息（有 token 时）
    let cfInfo = '';
    if (token && account) {
      const proj = await cfApi(`/accounts/${account}/pages/projects/${site.project}`, token);
      if (proj.ok && proj.data) {
        const p = proj.data;
        const created = p.created_on ? new Date(p.created_on).toISOString().slice(0, 10) : '?';
        const latest = p.latest_deployment?.created_on
          ? new Date(p.latest_deployment.created_on).toISOString().slice(0, 10)
          : '?';
        cfInfo = `创建 ${created} / 最近部署 ${latest}`;
      } else if (proj.status === 404) {
        cfInfo = `${c.yellow}Pages 项目不存在${c.reset}`;
      }
    }

    rows.push([
      site.protected ? `${c.yellow}🔒${c.reset} ${site.id}` : site.id,
      site.label,
      site.domain || `${site.project}.pages.dev`,
      result,
      cfInfo,
    ]);
  }

  table(['id', '名称', '域名', '访问状态', 'Cloudflare 信息'], rows);

  const protectedSites = cfg.sites.filter((s) => s.protected);
  if (protectedSites.length) {
    console.log('');
    log.dim(`其中 ${protectedSites.length} 个是受保护站点（${protectedSites.map((s) => s.id).join(', ')}）：只做线上巡检，不参与部署。`);
  }

  console.log('');
  log.dim('这个命令只发 GET 请求，不改任何东西。');
  console.log('');

  return 0;
}

/** 环境体检 */
async function checkEnv(cfg) {
  console.log('');
  console.log(`${c.bold}环境体检${c.reset}`);
  console.log('');

  const checks = [];

  // Node
  const node = checkNodeVersion(18);
  checks.push({
    name: 'Node.js',
    ok: node.ok,
    detail: node.ok ? node.current : `当前 ${node.current}，需要 ${node.required}`,
    fix: node.ok ? '' : '到 https://nodejs.org 装 LTS 版本',
  });

  // git
  const git = probeCommand('git');
  checks.push({
    name: 'git',
    ok: git.available,
    detail: git.available ? git.version : git.error,
    fix: git.available ? '' : '装 Git：https://git-scm.com/download/win',
  });

  // npm / pnpm
  const npm = probeCommand('npm');
  checks.push({
    name: 'npm',
    ok: npm.available,
    detail: npm.available ? npm.version : npm.error,
    fix: npm.available ? '' : '重装 Node.js（npm 会一起装上）',
  });

  const pnpm = probeCommand('pnpm');
  checks.push({
    name: 'pnpm',
    ok: true, // 可选
    optional: true,
    detail: pnpm.available ? pnpm.version : '未安装（只有 fuwari 需要，会自动回落 npm）',
    fix: pnpm.available ? '' : '可选：npm i -g pnpm',
  });

  // wrangler
  const wrangler = probeCommand('wrangler');
  const hasLocalWrangler = cfg.sites.some((s) =>
    fs.existsSync(path.join(cfg.workspace, s.repo, 'node_modules', '.bin', 'wrangler.cmd')),
  );
  checks.push({
    name: 'wrangler',
    ok: wrangler.available || hasLocalWrangler,
    detail: wrangler.available
      ? wrangler.version
      : hasLocalWrangler
        ? '用项目内的（node_modules/.bin）'
        : '未安装，将用 npx 临时拉取',
    fix: '',
  });

  // 认证
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const wranglerAuth = fs.existsSync(
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.wrangler', 'config', 'default.toml'),
  );
  checks.push({
    name: 'Cloudflare 认证',
    ok: Boolean(token) || wranglerAuth,
    detail: token ? '已配置 API Token' : wranglerAuth ? 'wrangler 已登录' : '都没有',
    fix: token || wranglerAuth ? '' : '设置 CLOUDFLARE_API_TOKEN，或运行 npx wrangler login',
  });

  // 工作区可写
  let workspaceWritable = true;
  let workspaceDetail = cfg.workspace;
  try {
    fs.mkdirSync(cfg.workspace, { recursive: true });
    const testFile = path.join(cfg.workspace, '.write-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  } catch (e) {
    workspaceWritable = false;
    workspaceDetail = `${cfg.workspace}（不可写：${e.message}）`;
  }

  checks.push({
    name: '工作区可写',
    ok: workspaceWritable,
    detail: workspaceDetail,
    fix: workspaceWritable ? '' : '设置 workspace 到有写权限的目录，或改 config/sites.json',
  });

  // 表格用纯文本标记，不用颜色 —— 颜色码会被当可见字符参与宽度计算，
  // 显示成 undefined 并撑坏对齐（实测踩过）
  table(
    ['项目', '状态', '详情'],
    checks.map((c) => [c.name, c.ok ? '正常' : c.optional ? '可选' : '缺失', c.detail]),
  );

  const blocking = checks.filter((c) => !c.ok && !c.optional);
  console.log('');
  if (blocking.length) {
    log.err(`${blocking.length} 项需要处理：`);
    for (const b of blocking) {
      console.log(`  ${c.red}✘${c.reset} ${c.bold}${b.name}${c.reset}`);
      console.log(`      ${b.fix}`);
    }
  } else {
    log.ok('环境就绪，可以部署。');
  }
  console.log('');

  return blocking.length ? 1 : 0;
}

/**
 * 检查站点依赖的绑定是否真实存在。
 * @param {any} site
 * @param {any} cfg
 * @param {{token?:string, accountId?:string, quiet?:boolean}} opts
 */
async function checkBindings(site, cfg, opts = {}) {
  const messages = [];
  let ok = true;
  let blocking = false;

  const token = opts.token;
  const account = opts.accountId;

  if (!token || !account) {
    messages.push('未配置 Token/账号 ID，跳过绑定检查');
    return { ok: true, messages, blocking: false };
  }

  for (const b of site.bindings ?? []) {
    if (b.type === 'd1') {
      const r = await cfApi(`/accounts/${account}/d1/database/${b.id}`, token);
      if (r.ok) {
        messages.push(`D1 「${b.name}」存在`);
      } else if (r.status === 404) {
        messages.push(`D1 「${b.name}」不存在（id: ${b.id}）`);
        messages.push(`  创建：npx wrangler d1 create ${b.name}`);
        ok = false;
        if (!b.optional) blocking = true;
      } else {
        messages.push(`D1 「${b.name}」检查失败：${r.error}`);
        ok = false;
      }
    } else if (b.type === 'r2') {
      const r = await cfApi(`/accounts/${account}/r2/buckets/${b.name}`, token);
      if (r.ok) {
        messages.push(`R2 桶 「${b.name}」存在`);
      } else if (r.status === 404) {
        messages.push(`R2 桶 「${b.name}」不存在`);
        messages.push(`  创建：npx wrangler r2 bucket create ${b.name}`);
        ok = false;
        if (!b.optional) blocking = true;
      } else {
        messages.push(`R2 桶 「${b.name}」检查失败：${r.error}`);
        ok = false;
      }
    }
  }

  return { ok, messages, blocking };
}

/** 简单 CF API 调用 */
async function cfApi(pathname, token) {
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok && json.success !== false, status: res.status, data: json.result, error: json.errors?.[0]?.message };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

/** 列出账号下的 D1 / R2 资源，方便填配置 */
async function listBindings(cfg, flags) {
  const token = flags.token ? String(flags.token) : process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const account = flags.account || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;

  if (!token || !account) {
    log.err('需要 API Token 和账号 ID。');
    console.log('');
    console.log(`  ${c.dim}set CLOUDFLARE_API_TOKEN=你的token${c.reset}`);
    console.log(`  ${c.dim}set CF_ACCOUNT_ID=你的账号ID${c.reset}`);
    return 2;
  }

  console.log('');
  console.log(`${c.bold}账号下的可用资源${c.reset}`);
  console.log('');

  const d1 = await cfApi(`/accounts/${account}/d1/database`, token);
  if (d1.ok && Array.isArray(d1.data)) {
    console.log(`${c.bold}D1 数据库${c.reset}`);
    if (d1.data.length === 0) console.log(`  ${c.dim}（无）${c.reset}`);
    for (const db of d1.data) {
      console.log(`  ${db.name}`);
      console.log(`    ${c.dim}id: ${db.uuid}${c.reset}`);
    }
  } else {
    console.log(`${c.bold}D1 数据库${c.reset}  ${c.dim}查询失败：${d1.error}${c.reset}`);
  }

  console.log('');
  const r2 = await cfApi(`/accounts/${account}/r2/buckets`, token);
  if (r2.ok && Array.isArray(r2.data?.buckets ?? r2.data)) {
    const buckets = r2.data.buckets ?? r2.data;
    console.log(`${c.bold}R2 桶${c.reset}`);
    if (buckets.length === 0) console.log(`  ${c.dim}（无）${c.reset}`);
    for (const b of buckets) {
      console.log(`  ${b.name}`);
    }
  } else {
    console.log(`${c.bold}R2 桶${c.reset}  ${c.dim}查询失败：${r2.error}${c.reset}`);
  }

  console.log('');
  log.dim('把这些名字和 ID 填到 config/sites.json 的 bindings 里。');
  console.log('');

  return 0;
}
