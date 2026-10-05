/**
 * 部署引擎：clone → 构建 → 部署 三个站点的全流程
 *
 * 设计取向：
 *   1. **每一步都可单独执行**（--only clone / --only build / --only deploy），
 *      出问题时不用从头再来。
 *   2. **失败即停并给可操作的下一步**，不吞错误。
 *   3. **不假设环境**：Node 版本、包管理器、wrangler 都是先探测再使用。
 *   4. **不覆盖用户的改动**：clone 时不 force、构建前不清空源码目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { log, color as c } from '../lib/util.mjs';
import { assessBuildOutput } from './deploy-patches.mjs';

/** 每一步的执行结果 */
const OK = 'ok';
const FAIL = 'fail';
const SKIP = 'skip';

/**
 * @typedef {{site:any, steps:{clone:string, build?:string, deploy:string}, detail:any[], error?:string}} SiteResult
 */

/**
 * 检测可用的包管理器。
 * 优先用仓库里的锁文件决定（pnpm-lock → pnpm，yarn.lock → yarn），
 * 而不是盲目用 npm —— 用错包管理器会导致依赖树不一致。
 *
 * @param {string} repoDir
 * @returns {{manager:string, installArgs:string[], reason:string}}
 */
export function detectPackageManager(repoDir) {
  const has = (f) => fs.existsSync(path.join(repoDir, f));

  if (has('pnpm-lock.yaml')) {
    return { manager: 'pnpm', installArgs: ['install'], reason: '发现 pnpm-lock.yaml' };
  }
  if (has('yarn.lock')) {
    return { manager: 'yarn', installArgs: ['install'], reason: '发现 yarn.lock' };
  }
  if (has('package-lock.json')) {
    return { manager: 'npm', installArgs: ['ci'], reason: '发现 package-lock.json' };
  }
  if (has('package.json')) {
    return { manager: 'npm', installArgs: ['install'], reason: '只有 package.json，用 npm' };
  }
  return { manager: 'none', installArgs: [], reason: '没有 package.json（纯静态站点）' };
}

/**
 * 决定如何 spawn 一个命令 —— 这是 Windows 上最容易踩的坑。
 *
 * 背景（实测踩过两轮）：
 *   · `spawn(cmd, args, {shell:true})` → Node 18+ 报 DEP0190
 *     安全警告（参数只拼接不转义，有注入风险）
 *   · `spawn('npm.cmd', args, {shell:false})` → **EINVAL**
 *     Windows 不能直接 spawn .cmd/.bat
 *   · 手工给路径加引号后交给 `cmd /c` → 报「不是内部或外部命令」
 *     因为引号被二次转义成字面量 `\"...\"`
 *
 * 正解：把 exe 和 args 作为一个 argv 数组传给 cmd.exe，
 *   让 Node 自己处理 Windows 的引号规则，不做任何手工转义。
 *   cmd 的 /c 后面接数组时，Node 会正确地为每个元素加引号。
 *
 * @param {string} exe 已解析出的可执行文件路径
 * @param {string[]} args
 * @returns {{file:string, args:string[]}}
 */
export function spawnPlan(exe, args) {
  const lower = exe.toLowerCase();
  const isBatch = process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'));

  if (!isBatch) {
    return { file: exe, args };
  }

  // 批处理文件：交给 cmd.exe。
  //
  // ⚠️ 实测踩过的两个坑（都试错了）：
  //   1. `/s` 不能加 —— 它的语义是「把 /c 后面的内容整个当字符串」，
  //      于是数组形式失效，路径里的空格没被引号包住，
  //      报 'C:\Program' 不是内部或外部命令。
  //   2. 手工给路径加引号也不行 —— 会变成字面量 \"...\"。
  //
  // 正解：`/d`（跳过 AutoRun）+ `/c` + argv 数组，
  //       引号规则完全交给 Node 处理。
  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  return { file: comspec, args: ['/d', '/c', exe, ...args] };
}

/**
 * 解析可执行文件的真实路径。
 *
 * 为什么需要这个：
 *   Node 18+ 对 `spawn(cmd, args, {shell:true})` 会报 DEP0190 警告，
 *   而 Windows 上 npm/npx/wrangler 都是 .cmd 批处理，不起 shell 会 ENOENT。
 *   解法：手工解析出完整路径，再按类型选择 spawn 方式（见 spawnPlan）。
 *
 * @param {string} cmd
 * @param {string} [cwd]
 * @returns {string} 可直接 spawn 的路径（找不到就返回原名）
 */
export function resolveExecutable(cmd, cwd) {
  // 已经是绝对路径
  if (path.isAbsolute(cmd)) return cmd;

  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];

  // 1. 先看 cwd/node_modules/.bin（项目局部依赖）
  if (cwd) {
    const localBin = path.join(cwd, 'node_modules', '.bin');
    for (const ext of exts) {
      const p = path.join(localBin, cmd + ext);
      if (fs.existsSync(p)) return p;
    }
  }

  // 2. 在 PATH 里找
  const pathEnv = process.env.PATH || process.env.Path || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch {
        /* 忽略无权限的目录 */
      }
    }
  }

  return cmd;
}

/**
 * 执行命令并流式输出。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd:string, env?:Record<string,string>, timeout?:number, quiet?:boolean}} opts
 * @returns {Promise<{code:number, stdout:string, stderr:string, tail:string[], elapsed:number}>}
 */
export function runCommand(cmd, args, opts) {
  return new Promise((resolve) => {
    const started = Date.now();
    const exe = resolveExecutable(cmd, opts.cwd);
    const plan = spawnPlan(exe, args);

    const child = spawn(plan.file, plan.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const tail = [];
    const MAX_TAIL = 40;

    const collect = (chunk, isErr) => {
      const text = chunk.toString();
      if (isErr) stderr += text;
      else stdout += text;

      if (!opts.quiet) return;

      // 只保留最后若干行用于失败时展示，避免刷屏
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > MAX_TAIL) tail.shift();
      }
    };

    child.stdout?.on('data', (d) => collect(d, false));
    child.stderr?.on('data', (d) => collect(d, true));

    let timer = null;
    if (opts.timeout) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        stderr += `\n[超时] 超过 ${opts.timeout}ms 未完成，已终止\n`;
      }, opts.timeout);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\n[无法启动] ${err.message}`, tail, elapsed: Date.now() - started });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, tail, elapsed: Date.now() - started });
    });
  });
}

/**
 * 从命令输出里提取真正的错误信息。
 *
 * 为什么需要这个（实测踩过）：
 *   包管理器的输出里 90% 是进度行（Progress: resolved 694, reused 0...），
 *   真正的错误往往在中间。直接取末尾 15 行，用户看到的全是进度条，
 *   完全不知道哪里错了。
 *
 * 策略：按优先级匹配已知的错误特征行。
 *
 * @param {string} output
 * @returns {string} 提取出的错误（可能为空）
 */
export function extractError(output) {
  if (!output) return '';

  const lines = output.split(/\r?\n/);

  // 高优先级：明确的错误标记
  const patterns = [
    /^ERR_[A-Z_]+/i, // pnpm/npm 的错误码
    /^\s*npm ERR!/i,
    /\bERROR\b.*:/,
    /error\s+(TS\d+|E\d+)/i, // TypeScript / 系统错误码
    /^Error:/m,
    /Cannot find module/i,
    /ENOENT|EACCES|ETIMEDOUT|ECONNRESET|ENOTFOUND/i,
    /peer dep|peerDependencies/i,
    /Unsupported engine|EBADENGINE/i,
    /integrity check failed|checksum/i,
    /fatal:/i, // git
  ];

  const found = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // 跳过纯进度行
    if (/^Progress: resolved/i.test(t)) continue;
    if (/^[│├└─╭╮╰╯\s]*$/.test(t)) continue;

    for (const p of patterns) {
      if (p.test(t)) {
        found.push(t.length > 200 ? t.slice(0, 200) + '…' : t);
        break;
      }
    }
    if (found.length >= 8) break;
  }

  return found.join('\n');
}

/**
 * 检查命令是否存在且可用。
 * @param {string} cmd
 * @param {string[]} [versionArgs]
 * @returns {{available:boolean, version?:string, error?:string, path?:string}}
 */
export function probeCommand(cmd, versionArgs = ['--version']) {
  const exe = resolveExecutable(cmd);
  const plan = spawnPlan(exe, versionArgs);

  const r = spawnSync(plan.file, plan.args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 20000,
  });

  if (r.error) return { available: false, error: r.error.message };
  if (r.status !== 0) return { available: false, error: (r.stderr ?? '').slice(0, 120) || `退出码 ${r.status}` };

  const out = (r.stdout ?? '').trim() || (r.stderr ?? '').trim();
  return { available: true, version: out.split('\n')[0].slice(0, 60), path: exe };
}

/**
 * 检查 Node 版本是否满足要求。
 * @param {number} [minMajor]
 */
export function checkNodeVersion(minMajor = 18) {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    ok: major >= minMajor,
    current: process.versions.node,
    required: `>=${minMajor}`,
  };
}

// ═══════════════════════════════════════════════════════════
// 三个步骤
// ═══════════════════════════════════════════════════════════

/**
 * 步骤 1：clone 或更新仓库。
 * @param {any} site
 * @param {any} cfg
 * @param {{update?:boolean}} [opts]
 */
export async function stepClone(site, cfg, opts = {}) {
  const dir = path.join(cfg.workspace, site.repo);
  const url = `https://github.com/${cfg.repoOwner}/${site.repo}.git`;

  if (fs.existsSync(path.join(dir, '.git'))) {
    // 已存在：拉取更新（不 force，不覆盖本地改动）
    log.info(`仓库已存在，拉取更新：${site.repo}`);

    const fetch = await runCommand('git', ['fetch', 'origin', site.branch], { cwd: dir, timeout: 120000 });
    if (fetch.code !== 0) {
      return { status: FAIL, error: `git fetch 失败\n${(fetch.stderr || fetch.stdout).slice(-500)}`, dir };
    }

    // 检查本地是否有未提交改动
    const status = await runCommand('git', ['status', '--porcelain'], { cwd: dir });
    if (status.stdout.trim()) {
      log.warn(`本地有未提交改动，跳过自动合并（避免覆盖你的工作）`);
      log.dim(`  目录：${dir}`);
      return { status: OK, note: '有本地改动，仅 fetch 未合并', dir };
    }

    const merge = await runCommand('git', ['merge', '--ff-only', `origin/${site.branch}`], { cwd: dir, timeout: 60000 });
    if (merge.code !== 0) {
      return { status: FAIL, error: `合并失败（可能需要手动处理）\n${(merge.stderr || merge.stdout).slice(-500)}`, dir };
    }
    return { status: OK, note: '已更新到最新', dir };
  }

  // 不存在：全新 clone
  if (fs.existsSync(dir)) {
    // 目录存在但不是 git 仓库 —— 不能贸然删除，可能是用户放的东西
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) {
      return {
        status: FAIL,
        error:
          `目录已存在且不是 git 仓库：${dir}\n` +
          `  里面的内容：${entries.slice(0, 5).join(', ')}${entries.length > 5 ? ' …' : ''}\n` +
          `  为避免误删你的文件，已中止。请手动处理该目录后重试。`,
        dir,
      };
    }
    fs.rmdirSync(dir);
  }

  log.info(`克隆仓库：${site.repo}`);
  fs.mkdirSync(cfg.workspace, { recursive: true });

  const clone = await runCommand('git', ['clone', '--branch', site.branch, '--depth', '1', url, dir], {
    timeout: 300000,
  });

  if (clone.code !== 0) {
    const msg = (clone.stderr || clone.stdout).slice(-600);
    let hint = '';
    if (/Authentication failed|could not read Username|terminal prompts disabled/i.test(msg)) {
      hint =
        '\n\n  这是私有仓库，需要先配置访问凭据：\n' +
        '    · 用 GitHub CLI：gh auth login\n' +
        '    · 或配置 SSH 后改用 git@github.com 地址\n' +
        '    · 或在 .env 里设置 GITHUB_TOKEN';
    } else if (/Could not resolve host|unable to access/i.test(msg)) {
      hint = '\n\n  网络无法访问 GitHub。如果用了代理，设置：\n    set HTTPS_PROXY=http://127.0.0.1:端口';
    }
    return { status: FAIL, error: `clone 失败\n${msg}${hint}`, dir };
  }

  return { status: OK, note: '已克隆', dir };
}

/**
 * 步骤 2：安装依赖并构建。
 * @param {any} site
 * @param {any} cfg
 * @param {{dryRun?:boolean}} [opts]
 */
export async function stepBuild(site, cfg, opts = {}) {
  const dir = path.join(cfg.workspace, site.repo);

  if (!fs.existsSync(dir)) {
    return { status: FAIL, error: `仓库目录不存在：${dir}` };
  }

  // 纯静态站点：没有构建步骤，直接确认产物存在
  if (site.type !== 'build') {
    const outDir = path.join(dir, site.outputDir);
    if (!fs.existsSync(outDir)) {
      return { status: FAIL, error: `输出目录不存在：${outDir}` };
    }
    const files = fs.readdirSync(outDir);
    return { status: SKIP, note: `纯静态，无需构建（${files.length} 个顶层条目）`, outDir };
  }

  const nodeCheck = checkNodeVersion(18);
  if (!nodeCheck.ok) {
    return {
      status: FAIL,
      error: `Node 版本过低：当前 ${nodeCheck.current}，需要 ${nodeCheck.required}\n  升级：https://nodejs.org`,
    };
  }

  const pm = detectPackageManager(dir);

  // 安装依赖
  if (pm.manager !== 'none' && cfg.options.autoInstallDeps) {
    const pmProbe = probeCommand(pm.manager);
    if (!pmProbe.available) {
      // 回落到 npm
      if (pm.manager !== 'npm') {
        log.warn(`未找到 ${pm.manager}，回落到 npm`);
      } else {
        return { status: FAIL, error: `找不到 ${pm.manager}，请确认 Node.js 已正确安装` };
      }
    }

    const useManager = pmProbe.available ? pm.manager : 'npm';
    const installArgs = cfg.options.cleanInstall && useManager === 'npm' ? ['ci'] : pm.installArgs;

    log.info(`安装依赖（${useManager}，${pm.reason}）`);
    log.dim('  首次安装可能要几分钟，请耐心等待 ...');

    const install = await runCommand(useManager, installArgs, {
      cwd: dir,
      // 依赖安装给足时间：大项目（1000+ 包）在慢网络下可能要 10 分钟以上
      timeout: 1800000, // 30 分钟
      quiet: true,
    });

    if (install.code !== 0) {
      // 从完整输出里找真正的错误行，而不是只取末尾的进度条
      const realError = extractError(install.stdout + install.stderr);
      const tailLines = (install.tail ?? []).slice(-15).join('\n    ');

      const timeoutHint = install.stderr?.includes('[超时]')
        ? '\n  这次超时了。依赖较多时首次安装可能超过 30 分钟，可以：\n' +
          '    · 先手动在该目录跑一次 ' + useManager + ' ' + installArgs.join(' ') + '，装完后用 --skip-clone 复用\n' +
          '    · 或换更快的镜像源'
        : '';

      return {
        status: FAIL,
        error:
          `依赖安装失败（${useManager} ${installArgs.join(' ')}，退出码 ${install.code}）\n` +
          (realError ? `\n  ✘ 错误信息：\n    ${realError.split('\n').join('\n    ')}\n` : '') +
          (tailLines ? `\n  最后几行输出：\n    ${tailLines}\n` : '') +
          timeoutHint +
          `\n  常见原因：\n` +
          `    · 网络问题 —— 换镜像源\n` +
          `        npm  : npm config set registry https://registry.npmmirror.com\n` +
          `        pnpm : pnpm config set registry https://registry.npmmirror.com\n` +
          `    · 需要代理 —— set HTTPS_PROXY=http://127.0.0.1:端口\n` +
          `    · Node 版本与依赖不兼容（当前 ${process.versions.node}）\n` +
          `    · 缓存损坏 —— 删掉 node_modules 重试`,
      };
    }
  }

  // 构建
  const [cmd, ...cmdArgs] = site.buildCommand.split(/\s+/);
  log.info(`构建：${site.buildCommand}`);

  const build = await runCommand(cmd, cmdArgs, {
    cwd: dir,
    timeout: cfg.options.buildTimeoutSec * 1000,
    quiet: true,
  });

  const outDir = path.join(dir, site.outputDir);

  if (build.code !== 0) {
    // 构建失败了 —— 但先看看产物是不是「基本完整」。
    //
    // 实测场景：fuwari 的 RSS 路由因 @astrojs/rss 与 zod 4 不兼容而崩溃，
    // 但其他 235 个文件全部正常生成。这种情况下站点完全可用，
    // 不该因为一个订阅源就让整个部署失败。
    const tolerate = site.patches?.includes('tolerate-partial-build');
    const assessment = assessBuildOutput(outDir);

    if (tolerate && assessment.complete) {
      log.warn(`构建报错，但产物完整（${assessment.reason}）`);
      log.dim('  patches 里启用了 tolerate-partial-build，继续部署');
      const errLines = extractError(build.stdout + build.stderr);
      if (errLines) {
        log.dim(`  被忽略的错误：${errLines.split('\n')[0].slice(0, 120)}`);
      }
      return {
        status: OK,
        note: `部分失败但产物完整（${assessment.reason}）`,
        outDir,
        partial: true,
      };
    }

    const detail = (build.tail ?? []).slice(-20).join('\n    ');
    const realError = extractError(build.stdout + build.stderr);

    // 如果是「产物基本完整但缺 tolerate 标志」，给出明确建议
    let extraHint = '';
    if (assessment.complete && !tolerate) {
      extraHint =
        `\n\n  注意：产物其实是完整的（${assessment.reason}），` +
        `只是某个路由崩了。\n` +
        `  如果你确认崩掉的部分不影响使用，可以在 config/sites.json 的 ` +
        `"${site.id}" 里加上：\n` +
        `      "patches": ["tolerate-partial-build"]\n` +
        `  这样会照常部署已生成的部分。`;
    }

    return {
      status: FAIL,
      error:
        `构建失败（退出码 ${build.code}）\n` +
        (realError ? `\n  ✘ 错误：\n    ${realError.split('\n').join('\n    ')}\n` : '') +
        (detail ? `\n  最后几行输出：\n    ${detail}\n` : '') +
        extraHint,
      raw: build,
    };
  }

  if (!fs.existsSync(outDir)) {
    return {
      status: FAIL,
      error:
        `构建完成但输出目录不存在：${outDir}\n` +
        `  检查 config/sites.json 里 ${site.id} 的 outputDir 是否写对了\n` +
        `  该目录下现有内容：${fs.readdirSync(dir).filter((f) => !f.startsWith('.')).join(', ')}`,
    };
  }

  const count = countFiles(outDir);
  return { status: OK, note: `构建完成（${count} 个文件）`, outDir };
}

/**
 * 步骤 3：用 wrangler 部署到 Pages。
 *
 * 用 Direct Upload 而不是 Git 集成 —— 不消耗 Pages 每月 500 次的构建额度。
 *
 * @param {any} site
 * @param {any} cfg
 * @param {{token?:string, accountId?:string, dryRun?:boolean, verbose?:boolean}} [opts]
 */
export async function stepDeploy(site, cfg, opts = {}) {
  const dir = path.join(cfg.workspace, site.repo);
  const outDir = path.join(dir, site.outputDir);

  if (!fs.existsSync(outDir)) {
    return { status: FAIL, error: `输出目录不存在：${outDir}` };
  }

  // 检查 wrangler
  let wranglerCmd = 'npx';
  let wranglerArgs = ['wrangler'];

  const localWrangler = path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  if (fs.existsSync(localWrangler)) {
    wranglerCmd = localWrangler;
    wranglerArgs = [];
  } else {
    const globalProbe = probeCommand('wrangler');
    if (globalProbe.available) {
      wranglerCmd = 'wrangler';
      wranglerArgs = [];
    }
  }

  const args = [
    ...wranglerArgs,
    'pages',
    'deploy',
    site.outputDir === '.' ? '.' : site.outputDir,
    '--project-name',
    site.project,
    '--branch',
    site.branch,
    '--commit-dirty=true',
  ];

  const env = {};
  if (opts.token) env.CLOUDFLARE_API_TOKEN = opts.token;
  if (opts.accountId) env.CLOUDFLARE_ACCOUNT_ID = opts.accountId;

  const hasAuth = Boolean(opts.token) || hasWranglerAuth();
  log.info(`部署到 Pages 项目：${site.project}`);
  if (!opts.token) {
    log.dim('  未提供 API Token，将使用本地 wrangler 的登录状态');
  }

  if (opts.dryRun) {
    return { status: SKIP, note: `[dry-run] 将执行：${wranglerCmd} ${args.join(' ')}` };
  }

  const result = await runCommand(wranglerCmd, args, {
    cwd: dir,
    env,
    timeout: cfg.options.deployTimeoutSec * 1000,
    quiet: true,
  });

  const combined = result.stdout + result.stderr;

  if (result.code !== 0) {
    let hint = '';
    if (/Authentication error|10000|Invalid API Token/i.test(combined)) {
      hint =
        '\n\n  Token 无效或权限不足。需要：\n' +
        '    Account  |  Cloudflare Pages  |  Edit\n' +
        '\n  或者改用浏览器登录：npx wrangler login';
    } else if (/not found|does not exist/i.test(combined) && /project/i.test(combined)) {
      hint = `\n\n  项目「${site.project}」不存在。脚本会在下次运行时自动创建，或手动：\n    npx wrangler pages project create ${site.project}`;
    } else if (/binding|database|bucket/i.test(combined)) {
      hint =
        '\n\n  绑定配置有问题。检查 config/sites.json 里该站点的 bindings：\n' +
        '    · D1 的 id 是否正确\n' +
        '    · R2 桶是否已创建\n' +
        '  查询现有资源：cfm deploy --list-bindings';
    }
    const detail = (result.tail ?? []).slice(-20).join('\n    ');
    return { status: FAIL, error: `部署失败\n${detail}${hint}` };
  }

  // 从输出里提取部署 URL
  const urlMatch = combined.match(/https:\/\/[a-z0-9-]+\.pages\.dev/i);
  const deployUrl = urlMatch ? urlMatch[0] : `https://${site.project}.pages.dev`;

  return { status: OK, note: `已部署`, url: deployUrl };
}

/**
 * 检查 wrangler 是否已登录（读它的配置文件）。
 */
function hasWranglerAuth() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    path.join(home, '.wrangler', 'config', 'default.toml'),
    path.join(home, '.config', '.wrangler', 'config', 'default.toml'),
    path.join(home, 'AppData', 'Roaming', 'xdg.config', '.wrangler', 'config', 'default.toml'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      const text = fs.readFileSync(f, 'utf8');
      if (/oauth_token|api_token/i.test(text)) return true;
    }
  }
  return false;
}

/**
 * 部署后验证：访问 pages.dev 域名确认返回 200。
 * @param {string} url
 * @param {{timeoutMs?:number, expectText?:string}} [opts]
 */
export async function verifyDeployment(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError = '';

  while (Date.now() < deadline) {
    attempt++;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'cfm-deploy-verify/1.0' },
        redirect: 'follow',
      });
      clearTimeout(timer);

      if (res.status === 200) {
        const text = await res.text();
        // 检查是不是"空白页"—— 200 但内容为空说明部署还没生效
        if (text.length < 100) {
          lastError = `返回 200 但内容只有 ${text.length} 字节（可能还没生效）`;
        } else {
          return { ok: true, status: res.status, bytes: text.length, attempts: attempt };
        }
      } else if (res.status === 404) {
        lastError = '返回 404 —— 项目可能还没创建，或部署尚未生效';
      } else {
        lastError = `返回 ${res.status}`;
      }
    } catch (e) {
      lastError = e.name === 'AbortError' ? '请求超时' : e.message;
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  return { ok: false, error: lastError, attempts: attempt };
}

/**
 * 递归统计文件数（用于确认产物非空）。
 * @param {string} dir
 * @param {number} [limit]
 */
export function countFiles(dir, limit = 100000) {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < limit) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        // 跳过明显不该上传的目录
        if (['node_modules', '.git', '.github', '.vscode'].includes(e.name)) continue;
        stack.push(path.join(cur, e.name));
      } else {
        n++;
      }
    }
  }
  return n;
}

export { OK, FAIL, SKIP };
