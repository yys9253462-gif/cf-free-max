/**
 * 初始化向导 —— 让别人也能一键搭建
 *
 * 解决的问题：
 *   分享出去的包里如果带着作者的配置（域名、D1 id、GitHub 用户名），
 *   别人拿到根本跑不起来 —— 那是作者账号里的资源。
 *
 *   但完全空白的模板又等于「让他自己填 JSON」，也不叫一键。
 *
 * 解法：
 *   包里的配置只保留「项目结构」（哪个仓库、怎么构建、需要什么绑定），
 *   把「属于账号的东西」（owner、域名、资源 ID）留空，
 *   首次运行时通过交互问答补齐，并**自动创建缺失的云资源**。
 *
 * 设计原则：
 *   1. 能自动探测的绝不让用户填（项目类型、输出目录、需要的绑定）
 *   2. 必须问的问得清楚（GitHub 用户名、要不要自定义域名）
 *   3. 资源缺失时直接建，不是给个命令让他自己跑
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, color as c, confirm, table } from '../lib/util.mjs';
import { spawn } from 'node:child_process';
import { resolveExecutable, spawnPlan } from '../lib/deploy-runner.mjs';
import { spinner } from '../lib/spinner.mjs';

/**
 * 判断配置是否「还没初始化」。
 *
 * 判据是占位符而不是「文件不存在」—— 因为包里**会带**一个配置骨架，
 * 只是关键字段是空的。
 *
 * @param {any} cfg
 * @returns {{needsInit:boolean, missing:string[]}}
 */
export function checkNeedsInit(cfg) {
  const missing = [];

  if (!cfg.repoOwner || cfg.repoOwner === 'your-github-username' || cfg.repoOwner === '') {
    missing.push('repoOwner');
  }

  for (const site of cfg.sites) {
    if (!site.repo || site.repo.startsWith('your-')) missing.push(`${site.id}.repo`);
    if (!site.project || site.project.startsWith('your-')) missing.push(`${site.id}.project`);
  }

  return { needsInit: missing.length > 0, missing };
}

/**
 * 探测 GitHub 仓库的信息（全自动识别）。
 *
 * 能识别：
 *   · 是不是 Astro / Next / Vite / 纯静态
 *   · 构建命令是什么（读 package.json 的 scripts）
 *   · 输出目录是什么（读配置或猜）
 *   · 有没有 Pages Functions（决定要不要 D1/R2 绑定）
 *
 * @param {string} owner
 * @param {string} repo
 * @param {{token?:string}} [opts]
 * @returns {Promise<any>}
 */
export async function probeRepo(owner, repo, opts = {}) {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = { 'User-Agent': 'cf-free-max', Accept: 'application/vnd.github+json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const result = {
    ok: false,
    private: false,
    hasPackageJson: false,
    hasFunctions: false,
    hasWranglerConfig: false,
    framework: null,
    buildCommand: null,
    outputDir: null,
    needsD1: false,
    needsR2: false,
    defaultBranch: 'main',
    error: null,
  };

  try {
    // 1. 仓库基本信息
    const repoRes = await fetch(api, { headers, signal: AbortSignal.timeout(20000) });
    if (repoRes.status === 404) {
      result.error = '仓库不存在，或你的账号无权访问（私有仓库需要 GitHub 授权）';
      return result;
    }
    if (!repoRes.ok) {
      result.error = `GitHub API 返回 ${repoRes.status}`;
      return result;
    }
    const repoData = await repoRes.json();
    result.ok = true;
    result.private = repoData.private;
    result.defaultBranch = repoData.default_branch || 'main';

    // 2. 根目录文件列表
    const contentsRes = await fetch(`${api}/contents`, { headers, signal: AbortSignal.timeout(20000) });
    if (!contentsRes.ok) {
      result.error = '无法读取仓库内容';
      return result;
    }
    const contents = await contentsRes.json();
    const names = new Set(contents.map((f) => f.name));

    result.hasPackageJson = names.has('package.json');
    result.hasFunctions = names.has('functions');
    result.hasWranglerConfig = names.has('wrangler.toml') || names.has('wrangler.jsonc') || names.has('wrangler.json');

    // 3. 读 package.json 判断框架与构建命令
    if (result.hasPackageJson) {
      const pkgRes = await fetch(`${api}/contents/package.json`, { headers, signal: AbortSignal.timeout(20000) });
      if (pkgRes.ok) {
        const pkgData = await pkgRes.json();
        const pkg = JSON.parse(Buffer.from(pkgData.content, 'base64').toString('utf8'));
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

        if (deps.astro) {
          result.framework = 'astro';
          result.outputDir = 'dist';
        } else if (deps.next) {
          result.framework = 'next';
          result.outputDir = 'out'; // 静态导出
        } else if (deps.vite || deps['@vitejs/plugin-react']) {
          result.framework = 'vite';
          result.outputDir = 'dist';
        } else if (deps.nuxt) {
          result.framework = 'nuxt';
          result.outputDir = 'dist';
        } else if (deps['@sveltejs/kit']) {
          result.framework = 'sveltekit';
          result.outputDir = 'build';
        } else if (pkg.scripts?.build) {
          result.framework = 'custom';
          result.outputDir = 'dist';
        }

        if (pkg.scripts?.build) {
          result.buildCommand = 'npm run build';
        }
      }
    }

    // 4. 读 wrangler 配置判断绑定需求
    if (result.hasWranglerConfig) {
      const cfgName = names.has('wrangler.jsonc')
        ? 'wrangler.jsonc'
        : names.has('wrangler.toml')
          ? 'wrangler.toml'
          : 'wrangler.json';
      const cfgRes = await fetch(`${api}/contents/${cfgName}`, { headers, signal: AbortSignal.timeout(20000) });
      if (cfgRes.ok) {
        const cfgData = await cfgRes.json();
        const raw = Buffer.from(cfgData.content, 'base64').toString('utf8');

        if (/d1_databases/i.test(raw)) result.needsD1 = true;
        if (/r2_buckets/i.test(raw)) result.needsR2 = true;

        // 从配置里读输出目录（比猜的准）
        const outMatch = raw.match(/pages_build_output_dir\s*[:=]\s*["']([^"']+)["']/);
        if (outMatch) result.outputDir = outMatch[1];
      }
    }

    // 5. 有 functions/ 目录说明用了 Pages Functions
    //    （绑定需求已在 wrangler 配置里识别）
    return result;
  } catch (e) {
    result.error = e.name === 'TimeoutError' ? '请求超时（网络问题）' : e.message;
    return result;
  }
}

/**
 * 探测站点列表里所有仓库。
 * @param {any} cfg
 * @param {{token?:string}} [opts]
 */
export async function probeAllRepos(cfg, opts = {}) {
  const results = [];
  for (const site of cfg.sites) {
    const sp = spinner(`分析 ${site.repo}`);
    const info = await probeRepo(cfg.repoOwner, site.repo, opts);
    if (info.ok) {
      sp.stop(`${site.repo} —— ${info.framework ?? '纯静态'}`);
    } else {
      sp.fail(`${site.repo} —— ${info.error}`);
    }
    results.push({ site, info });
  }
  return results;
}

/**
 * 用 wrangler 创建 D1 数据库。
 *
 * @param {string} name
 * @param {{cwd:string, token?:string, accountId?:string}} opts
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
export async function createD1Database(name, opts) {
  const r = await runWrangler(['d1', 'create', name], opts);
  if (!r.ok) {
    // 已存在也算成功，需要查出 id
    if (/already exists/i.test(r.output)) {
      const list = await runWrangler(['d1', 'list'], opts);
      const m = list.output.match(new RegExp(`${name}\\s*│\\s*([0-9a-f-]{36})`, 'i'))
        || list.output.match(new RegExp(`([0-9a-f-]{36})[\\s\\S]{0,80}${name}`, 'i'));
      if (m) return { ok: true, id: m[1] };
      return { ok: false, error: `数据库已存在但读不到 ID：\n${list.output.slice(0, 300)}` };
    }
    return { ok: false, error: r.output.slice(0, 500) };
  }

  // 从输出里提取 database_id
  const m = r.output.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i)
    || r.output.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) return { ok: true, id: m[1] };

  return { ok: false, error: `创建成功但读不到 ID，请手动查看：\n${r.output.slice(0, 300)}` };
}

/**
 * 创建 R2 桶。
 * @param {string} name
 * @param {{cwd:string, token?:string, accountId?:string}} opts
 */
export async function createR2Bucket(name, opts) {
  const r = await runWrangler(['r2', 'bucket', 'create', name], opts);
  if (r.ok) return { ok: true };
  if (/already exists/i.test(r.output)) return { ok: true, existed: true };
  return { ok: false, error: r.output.slice(0, 400) };
}

/**
 * 执行 wrangler 命令并捕获输出。
 * @param {string[]} args
 * @param {{cwd:string, token?:string, accountId?:string}} opts
 */
function runWrangler(args, opts) {
  return new Promise((resolve) => {
    const exe = resolveExecutable('npx', opts.cwd);
    const plan = spawnPlan(exe, ['--yes', 'wrangler', ...args]);

    const env = { ...process.env };
    if (opts.token) env.CLOUDFLARE_API_TOKEN = opts.token;
    if (opts.accountId) env.CLOUDFLARE_ACCOUNT_ID = opts.accountId;

    const child = spawn(plan.file, plan.args, {
      cwd: opts.cwd,
      env,
      shell: false,
      windowsHide: true,
    });

    let output = '';
    child.stdout.on('data', (d) => (output += d.toString()));
    child.stderr.on('data', (d) => (output += d.toString()));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      output += '\n[超时]';
    }, 180000);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: output + '\n' + e.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
}

/**
 * 从 wrangler 输出里解析账号 ID。
 */
export async function detectAccountId(opts) {
  const r = await runWrangler(['whoami'], opts);
  // 输出形如：│ Account Name │ abc123... │
  const m = r.output.match(/([0-9a-f]{32})/i);
  return m ? m[1] : null;
}
