/**
 * pages — Cloudflare Pages 项目管理
 *
 * 免费层的 Pages 是最容易「不知不觉超标」的产品：
 * **每月只有 500 次构建**。每次 git push 触发一次构建 ——
 * 一天推 17 次的仓库，一个月就把额度烧光，之后构建全部失败。
 *
 * 子命令：
 *   cfm pages list
 *   cfm pages create <name> --branch main
 *   cfm pages delete <name>
 *   cfm pages deployments <name>
 *   cfm pages domains <name> | --add <host> | --remove <host>
 *   cfm pages budget                  构建额度压力分析
 */

import { log, table, color, confirm, require_, humanNum } from '../lib/util.mjs';
import { FREE_TIER } from '../lib/quota.mjs';

export async function run({ client, flags }) {
  const sub = flags._[1];
  const cf = client();
  const accountId = cf.accountId;
  if (!accountId) {
    log.err('Pages 需要账号 ID。请设置 CF_ACCOUNT_ID。');
    return 1;
  }

  switch (sub) {
    case 'list':
      return listProjects(cf, accountId, flags);
    case 'create':
      return createProject(cf, accountId, flags);
    case 'delete':
      return deleteProject(cf, accountId, flags);
    case 'deployments':
      return deployments(cf, accountId, flags);
    case 'domains':
      return domains(cf, accountId, flags);
    case 'budget':
      return budget(cf, accountId, flags);
    case 'rollback':
      return rollback(cf, accountId, flags);
    default:
      log.err(`未知子命令：pages ${sub ?? '(空)'}`);
      console.log('可用：list / create / delete / deployments / domains / budget / rollback');
      return 2;
  }
}

async function listProjects(cf, accountId, flags) {
  const projects = await cf.paginate(`/accounts/${accountId}/pages/projects`);
  if (flags.json) {
    console.log(JSON.stringify(projects, null, 2));
    return 0;
  }
  if (!projects.length) {
    log.info('还没有 Pages 项目。');
    log.dim('用 wrangler 创建：npx wrangler pages project create my-site');
    return 0;
  }

  table(
    ['项目名', '子域', '生产分支', '自定义域', '最后修改'],
    projects.map((p) => [
      p.name,
      p.subdomain ?? '-',
      p.production_branch ?? '-',
      (p.domains ?? []).length,
      (p.latest_deployment?.created_on ?? p.created_on ?? '').slice(0, 10),
    ]),
  );

  console.log('');
  const totalDomains = projects.reduce((a, p) => a + (p.domains ?? []).length, 0);
  log.dim(`共 ${projects.length} 个项目，${totalDomains} 个自定义域`);
  log.dim(`每月构建额度：${humanNum(FREE_TIER.pages.builds.limit)} 次（这是 Pages 最容易超标的一项）`);
  return 0;
}

async function createProject(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm pages create <name> [--branch main] [--production]');
    return 2;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(name)) {
    log.err('项目名必须小写字母数字与连字符，最长 58 字符。');
    return 2;
  }

  if (flags['dry-run']) {
    log.info(`--dry-run：将创建 Pages 项目 ${name}`);
    return 0;
  }

  try {
    const res = await cf.request('POST', `/accounts/${accountId}/pages/projects`, {
      body: {
        name,
        production_branch: flags.branch ? String(flags.branch) : 'main',
      },
    });
    log.ok(`项目 ${res.name} 已创建`);
    console.log(`  预览域：https://${res.subdomain}.pages.dev`);
    log.dim('提示：如果源站只是静态文件，用 Workers Static Assets 可以不消耗构建额度。');
  } catch (e) {
    if (/already exists/i.test(e.message)) {
      log.warn(`项目 ${name} 已存在。`);
      return 0;
    }
    throw e;
  }
  return 0;
}

async function deleteProject(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm pages delete <name>');
    return 2;
  }
  log.warn(`将删除 Pages 项目 ${name} 及其全部部署记录。自定义域会一并解绑。`);
  if (flags['dry-run']) return 0;
  if (!(await confirm('确认删除？', { force: flags.yes }))) return 0;
  await cf.request('DELETE', `/accounts/${accountId}/pages/projects/${name}`);
  log.ok('已删除。');
  return 0;
}

async function deployments(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm pages deployments <name> [--env production|preview] [--limit 20]');
    return 2;
  }
  const limit = Math.min(Number(flags.limit ?? 20), 100);
  const env = flags.env ? String(flags.env) : undefined;
  const list = await cf.request('GET', `/accounts/${accountId}/pages/projects/${name}/deployments`, {
    query: { per_page: limit, env },
  });

  if (flags.json) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }

  const items = Array.isArray(list) ? list : (list?.result ?? []);
  if (!items.length) {
    log.info('没有部署记录。');
    return 0;
  }

  table(
    ['环境', '分支', '状态', '提交', '时间', 'ID'],
    items.map((d) => [
      d.environment ?? '-',
      (d.deployment_trigger?.metadata?.branch ?? '-').slice(0, 24),
      formatStage(d.latest_stage),
      (d.deployment_trigger?.metadata?.commit_hash ?? '').slice(0, 7) || '-',
      (d.created_on ?? '').slice(0, 19).replace('T', ' '),
      (d.id ?? '').slice(0, 10) + '…',
    ]),
  );
  return 0;
}

function formatStage(stage) {
  if (!stage) return '-';
  const map = {
    success: `${color.green}成功${color.reset}`,
    failure: `${color.red}失败${color.reset}`,
    idle: `${color.dim}空闲${color.reset}`,
    active: `${color.yellow}构建中${color.reset}`,
    canceled: `${color.dim}已取消${color.reset}`,
  };
  return map[stage.name] ?? stage.name ?? '-';
}

async function domains(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm pages domains <name> [--add host] [--remove host]');
    return 2;
  }

  if (flags.add) {
    const host = String(flags.add);
    log.step(`为 ${name} 添加自定义域 ${host}`);
    log.dim('前提：该域名所在的 zone 必须在本账号下，否则需手动加 CNAME。');
    if (flags['dry-run']) return 0;
    await cf.request('POST', `/accounts/${accountId}/pages/projects/${name}/domains`, {
      body: { name: host },
    });
    log.ok('已添加。证书签发通常几分钟内完成。');
    return 0;
  }

  if (flags.remove) {
    const host = String(flags.remove);
    if (flags['dry-run']) return 0;
    if (!(await confirm(`确认解绑 ${host}？`, { force: flags.yes }))) return 0;
    await cf.request('DELETE', `/accounts/${accountId}/pages/projects/${name}/domains/${host}`);
    log.ok('已解绑。');
    return 0;
  }

  const res = await cf.request('GET', `/accounts/${accountId}/pages/projects/${name}/domains`);
  const list = Array.isArray(res) ? res : (res?.result ?? []);
  if (flags.json) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }
  if (!list.length) {
    log.info('没有自定义域。');
    return 0;
  }
  table(
    ['域名', '状态', '验证状态'],
    list.map((d) => [d.name, d.status ?? '-', d.verification_data?.status ?? '-']),
  );
  console.log('');
  console.log(`共 ${list.length}/${FREE_TIER.pages.custom_domains.limit} 个（每项目上限）`);
  return 0;
}

/**
 * budget — 构建额度压力分析
 *
 * 500 次/月听起来很多，但一个每天多次提交的前端仓库很快就会撞墙。
 */
async function budget(cf, accountId, flags) {
  log.step('Pages 构建设额度分析');

  const projects = await cf.paginate(`/accounts/${accountId}/pages/projects`);
  const monthlyLimit = FREE_TIER.pages.builds.limit;

  console.log(`\n  每月构建上限    ${humanNum(monthlyLimit)} 次（账号级，所有项目共享）`);
  console.log(`  当前项目数      ${projects.length}`);
  console.log(`  平均每项目可用  ${Math.floor(monthlyLimit / Math.max(1, projects.length))} 次/月\n`);

  // 统计最近 30 天每个项目的部署次数
  const since = Date.now() - 30 * 86400 * 1000;
  let totalBuilds = 0;
  const rows = [];

  for (const p of projects) {
    let deploys = [];
    try {
      const res = await cf.request('GET', `/accounts/${accountId}/pages/projects/${p.name}/deployments`, {
        query: { per_page: 100 },
      });
      deploys = Array.isArray(res) ? res : (res?.result ?? []);
    } catch {
      /* 忽略 */
    }
    const recent = deploys.filter((d) => new Date(d.created_on ?? 0).getTime() > since);
    totalBuilds += recent.length;
    rows.push([p.name, recent.length, deploys.length]);
  }

  if (rows.length) {
    table(['项目', '近 30 天构建', '历史部署数'], rows);
    console.log('');
    const pct = (totalBuilds / monthlyLimit) * 100;
    const bar = '█'.repeat(Math.min(20, Math.round(pct / 5))) + '░'.repeat(Math.max(0, 20 - Math.round(pct / 5)));
    console.log(`${color.bold}近 30 天总构建${color.reset}  ${totalBuilds} / ${monthlyLimit}   ${bar} ${pct.toFixed(1)}%`);

    if (pct >= 80) {
      log.err('构建额度即将耗尽！超限后所有新部署会失败。');
    } else if (pct >= 50) {
      log.warn('已用超过一半，注意提交频率。');
    } else {
      log.ok('余量充足。');
    }
  }

  console.log('');
  log.step('省构建额度的办法');
  console.log('  1. 在提交信息里加 [skip ci]，或配置 Build watch paths 只在特定目录变更时构建');
  console.log('  2. 纯静态站点改用 Workers Static Assets —— 直接 `wrangler deploy`，不消耗构建额度');
  console.log('  3. 本地构建后直接上传产物（Direct Upload），绕过 Cloudflare 的构建环节');
  console.log('  4. 启构建缓存（Build cache），减少重复安装依赖的时间与失败率');
  console.log('');
  log.dim('注意：Direct Upload 模式的项目不消耗构建额度，但仍受 20000 文件/站 的上限约束。');
  return 0;
}

/**
 * rollback — 回滚到指定部署
 */
async function rollback(cf, accountId, flags) {
  const name = flags._[2];
  const deploymentId = flags._[3] ?? flags.id;
  if (!name || !deploymentId) {
    log.err('用法：cfm pages rollback <name> <deployment-id>');
    log.dim('用 cfm pages deployments <name> 获取 deployment ID。');
    return 2;
  }

  log.warn(`将把 ${name} 回滚到部署 ${deploymentId}`);
  if (flags['dry-run']) return 0;
  if (!(await confirm('确认回滚？', { force: flags.yes }))) return 0;

  await cf.request('POST', `/accounts/${accountId}/pages/projects/${name}/deployments/${deploymentId}/rollback`);
  log.ok('已回滚。');
  return 0;
}
