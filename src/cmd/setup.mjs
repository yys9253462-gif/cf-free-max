/**
 * setup — 首次运行向导
 *
 * 目标：让别人拿到包之后，**不用手改任何配置文件**，
 * 跟着问答走完就能用。
 *
 * 流程：
 *   1. 检查凭据（没有就引导授权）
 *   2. 问 GitHub 用户名（用于找他的仓库）
 *   3. 自动分析每个仓库（框架、构建命令、输出目录、需要的绑定）
 *   4. 缺什么云资源就自动创建（D1 / R2）
 *   5. 问自定义域名（可跳过）
 *   6. 写入配置
 *
 * 用法：
 *   cfm setup              交互式初始化
 *   cfm setup --check      只检查当前配置状态
 *   cfm setup --yes        全部用默认值（快速模式）
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, table, color as c, confirm } from '../lib/util.mjs';
import { loadConfig, CONFIG_PATH, ConfigError } from '../lib/deploy-config.mjs';
import {
  checkNeedsInit,
  probeRepo,
  createD1Database,
  createR2Bucket,
  detectAccountId,
} from '../lib/deploy-init.mjs';
import { spinner } from '../lib/spinner.mjs';

export async function run({ flags, client }) {
  // ─── 只检查状态 ───
  if (flags.check) return checkStatus();

  console.log('');
  console.log(`${c.bold}初始化向导${c.reset}`);
  console.log(`${c.dim}  让部署功能能在你的账号下跑起来${c.reset}`);
  console.log('');

  // ─── 载入现有配置 ───
  let cfg;
  try {
    cfg = loadConfig(flags.config ? String(flags.config) : undefined);
  } catch (e) {
    if (e instanceof ConfigError) {
      log.err(e.message);
      console.log('');
      log.dim('配置文件应该随包提供，如果缺失请重新解压完整包。');
      return 2;
    }
    throw e;
  }

  const { needsInit, missing } = checkNeedsInit(cfg);
  if (!needsInit && !flags.force) {
    log.ok('配置已初始化，无需重新设置。');
    console.log('');
    printSummary(cfg);
    console.log('');
    log.dim('想重新配置：cfm setup --force');
    console.log('');
    return 0;
  }

  if (needsInit) {
    log.info(`需要补充：${missing.join(', ')}`);
    console.log('');
  }

  // ─── 步骤 1：GitHub 用户名 ───
  console.log(`${c.cyan}步骤 1/4${c.reset}  ${c.bold}你的 GitHub 用户名${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}用来找到你要部署的仓库${c.reset}`);
  console.log('');

  let owner = cfg.repoOwner;
  const detectedOwner = await detectGitHubUser(flags);

  if (detectedOwner) {
    console.log(`  检测到已登录的 GitHub 账号：${c.cyan}${detectedOwner}${c.reset}`);
    console.log('');
    if (flags.yes || (await confirm(`使用这个账号？`, true))) {
      owner = detectedOwner;
    } else {
      owner = await askInput('  输入 GitHub 用户名');
    }
  } else if (!owner || owner === 'your-github-username') {
    console.log(`  ${c.dim}没有检测到已登录的 GitHub CLI 账号。${c.reset}`);
    console.log(`  ${c.dim}可以在「检测授权.bat」里选 [1] 完成 GitHub 授权。${c.reset}`);
    console.log('');
    owner = await askInput('  输入 GitHub 用户名（或组织名）');
  }

  if (!owner) {
    log.err('必须提供 GitHub 用户名才能继续。');
    return 2;
  }
  cfg.repoOwner = owner;
  console.log('');
  log.ok(`GitHub：${owner}`);

  // ─── 步骤 2：分析仓库 ───
  console.log('');
  console.log(`${c.cyan}步骤 2/4${c.reset}  ${c.bold}分析项目结构${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}自动识别每个仓库的类型、构建命令、需要的云资源${c.reset}`);
  console.log('');

  const ghToken = await getGitHubToken();
  const analysis = [];

  for (const site of cfg.sites) {
    const sp = spinner(`分析 ${site.repo}`);
    const info = await probeRepo(owner, site.repo, { token: ghToken });
    analysis.push({ site, info });

    if (info.ok) {
      const parts = [];
      parts.push(info.framework ? `${info.framework}` : '纯静态');
      if (info.buildCommand) parts.push(`构建 ${info.buildCommand}`);
      parts.push(`产物 ${info.outputDir ?? '.'}`);
      if (info.needsD1) parts.push('需 D1');
      if (info.needsR2) parts.push('需 R2');
      sp.stop(`${site.repo}  ${c.dim}${parts.join(' · ')}${c.reset}`);
    } else {
      sp.fail(`${site.repo}  ${info.error}`);
    }
  }

  // 有任何一个失败就停下来问
  const failed = analysis.filter((a) => !a.info.ok);
  if (failed.length) {
    console.log('');
    log.warn(`${failed.length} 个仓库无法访问：`);
    for (const f of failed) {
      console.log(`  ${c.yellow}${f.site.repo}${c.reset}  ${f.info.error}`);
    }
    console.log('');
    console.log(`  ${c.dim}常见原因：${c.reset}`);
    console.log(`    ${c.dim}· 仓库名不对（改 config/sites.json 里的 repo 字段）${c.reset}`);
    console.log(`    ${c.dim}· 私有仓库需要 GitHub 授权（检测授权.bat → 选 [1]）${c.reset}`);
    console.log('');

    if (!flags.yes && !(await confirm('跳过这些仓库，继续配置其他的？', false))) {
      return 1;
    }
  }

  // 应用探测结果
  for (const { site, info } of analysis) {
    if (!info.ok) continue;
    if (info.buildCommand) {
      site.type = 'build';
      site.buildCommand = info.buildCommand;
      site.installCommand = 'npm install';
    } else if (info.framework === null && !info.hasPackageJson) {
      site.type = 'static';
      site.buildCommand = '';
      site.installCommand = '';
    }
    if (info.outputDir) site.outputDir = info.outputDir;
    if (info.defaultBranch) site.branch = info.defaultBranch;
  }

  // ─── 步骤 3：云资源 ───
  const needResources = analysis.filter((a) => a.info.ok && (a.info.needsD1 || a.info.needsR2));
  if (needResources.length) {
    console.log('');
    console.log(`${c.cyan}步骤 3/4${c.reset}  ${c.bold}创建云资源${c.reset}`);
    console.log('');
    console.log(`  ${c.dim}这些站点需要数据库/存储，会在你的 Cloudflare 账号下创建${c.reset}`);
    console.log('');

    // 需要账号 ID
    let accountId = flags.account || process.env.CLOUDFLARE_ACCOUNT_ID || '';
    if (!accountId) {
      const sp = spinner('获取账号 ID');
      accountId = await detectAccountId({ cwd: cfg.workspace, token: flags.token });
      if (accountId) sp.stop(`账号 ID：${accountId.slice(0, 8)}…`);
      else sp.fail('无法获取账号 ID');
    }

    if (!accountId) {
      log.warn('无法确定账号 ID，跳过资源创建。');
      log.dim('可以稍后运行：cfm setup --force');
    } else {
      fs.mkdirSync(cfg.workspace, { recursive: true });

      for (const { site, info } of needResources) {
        console.log('');
        console.log(`  ${c.bold}${site.label}${c.reset} ${c.dim}(${site.repo})${c.reset}`);

        site.bindings = site.bindings ?? [];

        if (info.needsD1) {
          const dbName = site.bindings.find((b) => b.type === 'd1')?.name ?? `${site.project}-db`;
          const bindingName = site.bindings.find((b) => b.type === 'd1')?.binding ?? 'DB';

          // 已经有 id 且有效就跳过
          const existing = site.bindings.find((b) => b.type === 'd1');
          if (existing?.id && !existing.id.startsWith('0000')) {
            console.log(`    ${c.dim}D1「${existing.name}」已有配置，跳过${c.reset}`);
          } else {
            const sp = spinner(`创建 D1 数据库 ${dbName}`);
            const r = await createD1Database(dbName, { cwd: cfg.workspace, token: flags.token, accountId });
            if (r.ok) {
              sp.stop(`D1「${dbName}」已就绪`);
              console.log(`      ${c.dim}${r.id}${c.reset}`);

              const idx = site.bindings.findIndex((b) => b.type === 'd1');
              const binding = { type: 'd1', binding: bindingName, name: dbName, id: r.id, optional: false };
              if (idx >= 0) site.bindings[idx] = binding;
              else site.bindings.push(binding);
            } else {
              sp.fail(`D1 创建失败`);
              console.log(`      ${c.dim}${r.error.split('\n')[0]}${c.reset}`);
              console.log(`      ${c.dim}可以稍后手动创建：npx wrangler d1 create ${dbName}${c.reset}`);
            }
          }
        }

        if (info.needsR2) {
          const bucketName = site.bindings.find((b) => b.type === 'r2')?.name ?? `${site.project}-uploads`;
          const bindingName = site.bindings.find((b) => b.type === 'r2')?.binding ?? 'R2';

          const sp = spinner(`创建 R2 桶 ${bucketName}`);
          const r = await createR2Bucket(bucketName, { cwd: cfg.workspace, token: flags.token, accountId });
          if (r.ok) {
            sp.stop(`R2「${bucketName}」${r.existed ? '已存在' : '已创建'}`);

            const idx = site.bindings.findIndex((b) => b.type === 'r2');
            const binding = { type: 'r2', binding: bindingName, name: bucketName, optional: true };
            if (idx >= 0) site.bindings[idx] = binding;
            else site.bindings.push(binding);
          } else {
            sp.fail('R2 创建失败');
            console.log(`      ${c.dim}${r.error.split('\n')[0]}${c.reset}`);
          }
        }
      }
    }
  } else {
    console.log('');
    console.log(`${c.cyan}步骤 3/4${c.reset}  ${c.bold}云资源${c.reset}  ${c.dim}（这些站点不需要）${c.reset}`);
  }

  // ─── 步骤 4：域名 ───
  console.log('');
  console.log(`${c.cyan}步骤 4/4${c.reset}  ${c.bold}自定义域名${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}可选。部署后会绑定到你自己的域名，不填就只用 *.pages.dev${c.reset}`);
  console.log('');

  for (const site of cfg.sites) {
    // 清掉作者留下的域名（不是用户的）
    const wasForeign = site.domain && !site.domain.endsWith('.example.com') && site._originalDomain;
    if (flags.yes) {
      // 快速模式：不带域名
      if (site.domain && !site.domain.endsWith('.example.com')) site.domain = '';
      continue;
    }

    const hasDomain = site.domain && !site.domain.endsWith('.example.com');
    if (hasDomain) {
      console.log(`  ${site.label}：当前配置了 ${c.cyan}${site.domain}${c.reset}`);
      if (await confirm(`    ${site.domain} 是你自己的域名吗？`, false)) continue;
    }

    site.domain = '';
    const answer = await askInput(`  ${site.label} 的域名（留空跳过）`);
    if (answer) site.domain = answer.trim();
  }

  // ─── 保存 ───
  console.log('');
  console.log(`${c.dim}${'─'.repeat(60)}${c.reset}`);
  console.log('');
  console.log(`${c.bold}即将保存的配置${c.reset}`);
  console.log('');

  table(
    ['站点', '仓库', 'Pages 项目', '类型', '域名', '绑定'],
    cfg.sites.map((s) => [
      s.label,
      s.repo,
      s.project,
      s.type === 'build' ? `构建 → ${s.outputDir}` : `静态 → ${s.outputDir}`,
      s.domain || '—',
      s.bindings?.length ? s.bindings.map((b) => b.type.toUpperCase()).join('+') : '无',
    ]),
  );

  console.log('');
  if (!flags.yes && !(await confirm('保存配置？', true))) {
    log.info('已取消，配置未修改。');
    return 0;
  }

  // 清理内部字段
  for (const site of cfg.sites) {
    delete site._originalDomain;
  }

  // 去掉注释性字段，写干净的配置
  const output = {
    repoOwner: cfg.repoOwner,
    workspace: '',
    sites: cfg.sites.map((s) => {
      const clean = {
        id: s.id,
        label: s.label,
        repo: s.repo,
        project: s.project,
      };
      if (s.domain) clean.domain = s.domain;
      clean.type = s.type;
      clean.buildCommand = s.buildCommand ?? '';
      clean.installCommand = s.installCommand ?? '';
      clean.outputDir = s.outputDir;
      clean.branch = s.branch ?? 'main';
      if (s.bindings?.length) clean.bindings = s.bindings;
      if (s.patches?.length) clean.patches = s.patches;
      if (s.protected) {
        clean.protected = true;
        clean.protectedReason = s.protectedReason;
      }
      return clean;
    }),
    options: {
      autoInstallDeps: true,
      cleanInstall: false,
      verifyAfterDeploy: false,
      deployTimeoutSec: 600,
      buildTimeoutSec: 900,
    },
  };

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
    console.log('');
    log.ok(`配置已保存到 config/sites.json`);
  } catch (e) {
    log.err(`保存失败：${e.message}`);
    return 1;
  }

  console.log('');
  console.log(`${c.green}${c.bold}初始化完成${c.reset}`);
  console.log('');
  console.log('  接下来可以：');
  console.log(`    ${c.cyan}cfm deploy --dry-run${c.reset}   预演，看会做什么`);
  console.log(`    ${c.cyan}cfm deploy${c.reset}             真正执行`);
  console.log('');

  return 0;
}

// ═══════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════

/** 从 gh CLI 检测已登录的用户名 */
async function detectGitHubUser(flags) {
  if (flags.owner) return String(flags.owner);

  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 15000,
    });
    if (r.status === 0) {
      const login = (r.stdout ?? '').trim();
      if (login && /^[a-z0-9-]+$/i.test(login)) return login;
    }
  } catch {
    /* gh 不可用 */
  }
  return null;
}

/** 获取 GitHub token（用于访问私有仓库） */
async function getGitHubToken() {
  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 15000,
    });
    if (r.status === 0) return (r.stdout ?? '').trim() || undefined;
  } catch {
    /* 忽略 */
  }
  return undefined;
}

/** 交互式输入（非 TTY 时用默认值或抛错） */
async function askInput(question) {
  if (!process.stdin.isTTY) return '';

  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${c.cyan}?${c.reset} ${question}: `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** 检查配置状态 */
async function checkStatus() {
  console.log('');
  console.log(`${c.bold}配置状态${c.reset}`);
  console.log('');

  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    log.err(e.message);
    return 2;
  }

  const { needsInit, missing } = checkNeedsInit(cfg);

  if (needsInit) {
    log.warn('配置未初始化');
    console.log('');
    console.log(`  缺少：${missing.join(', ')}`);
    console.log('');
    console.log(`  运行 ${c.cyan}cfm setup${c.reset} 开始初始化向导。`);
    console.log('');
    // 退出码约定（给 启动.bat 这类调用方用）：
    //   0 = 配置已就绪，无需初始化
    //   3 = 配置未初始化，需要跑向导
    //   1 = 真正的错误（配置损坏等）
    //
    // 为什么不用 0/1 区分：「未初始化」既不是成功也不是失败，
    // 用 0 会让调用方以为就绪，用 1 会被当成错误弹出报错。
    // 单独给个 3 最清楚。
    return 3;
  }

  log.ok('配置已就绪');
  console.log('');
  printSummary(cfg);
  console.log('');
  return 0;
}

function printSummary(cfg) {
  table(
    ['站点', '仓库', 'Pages 项目', '类型', '域名', '绑定', '状态'],
    cfg.sites.map((s) => [
      s.label,
      s.repo,
      s.project,
      s.type === 'build' ? '构建' : '静态',
      s.domain || '—',
      s.bindings?.length ? s.bindings.map((b) => b.type.toUpperCase()).join('+') : '无',
      s.protected ? '🔒 受保护' : '可部署',
    ]),
  );
  console.log('');
  console.log(`  ${c.dim}GitHub：${cfg.repoOwner}${c.reset}`);
}
