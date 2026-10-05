/**
 * 交互式主界面 —— 不用记命令，进去选就行。
 *
 * 用法：
 *   cfm                      直接进交互（无参数时）
 *   cfm ui                   显式进交互
 *   cfm ui --advanced        进来就显示全部菜单（含危险操作）
 *
 * 设计：
 *   - 主菜单按「意图」分类，不按产品分类 ——
 *     用户想的是「我要看图省了多少」，不是「我要调 GraphQL」
 *   - 每个二级菜单里都能直接执行，不用跳出去敲命令
 *   - 危险操作（删除/清缓存）在执行前展示「将要做什么」并要求确认
 *   - q 逐级返回，主菜单按 q 退出
 */

import {
  Prompt,
  isInteractive,
  isBack,
  clearScreen,
  banner,
} from '../lib/prompt.mjs';
import { log, table, color as c, confirm as rawConfirm, humanNum, humanBytes } from '../lib/util.mjs';
import { FREE_TIER, PITFALLS } from '../lib/quota.mjs';
import { CFError } from '../lib/cf.mjs';

/**
 * 把命令模块的 run() 包成「可重复调用」的形式。
 *
 * ⚠️ 关键改进：不套 spinner。
 *   一开始我想给 invoke 加统一的 spinner，但实测发现**会互相干扰** ——
 *   deploy 之类的命令自己会更新 spinner 文本（「正在安装依赖」→
 *   「正在构建」），外面再套一层 spinner 就会出现两个动画抢同一行，
 *   输出变成乱码。
 *
 *   所以 spinner 交给**知道自己内部阶段**的命令自己去管，
 *   invoke 只负责捕获异常。
 */
async function invoke(cmd, ctx) {
  const mod = await import(`./${cmd}.mjs`);
  try {
    await mod.run(ctx);
  } catch (err) {
    if (err instanceof CFError) {
      log.err(err.toString());
    } else {
      log.err(err?.message ?? String(err));
    }
  }
}

/**
 * 需要凭据的菜单前的守卫。
 *
 * 为什么要有这个：用户点进「看用量」才发现没配 Token，
 * 体验很差。这里提前检查并给出具体怎么做，而不是等 API 报错。
 *
 * @returns {Promise<boolean>} 是否可以继续
 */
async function ensureCreds(p, client) {
  try {
    const cf = client();
    await cf.listZones();
    return true;
  } catch (err) {
    console.log('');
    if (err instanceof CFError && /未找到 Cloudflare 凭据/.test(err.message)) {
      log.warn('这个功能需要 Cloudflare 凭据。');
      console.log('');
      console.log(`${c.bold}怎么配置${c.reset}`);
      console.log(`  ${c.cyan}# 方式一：环境变量${c.reset}`);
      console.log('  export CF_API_TOKEN=你的令牌');
      console.log('  export CF_ACCOUNT_ID=你的账号ID   # R2/KV/D1/Pages 需要');
      console.log('');
      console.log(`  ${c.cyan}# 方式二：写进 .env 文件（推荐）${c.reset}`);
      console.log('  cp .env.example .env');
      console.log('  # 然后编辑 .env 填入真实值');
      console.log('');
      console.log(`${c.bold}令牌怎么拿${c.reset}`);
      console.log('  https://dash.cloudflare.com/profile/api-tokens');
      console.log(`  ${c.dim}最小权限见 README 的表格${c.reset}`);
      console.log('');
      console.log(`${c.dim}提示：额度速查与场景估算的 KV/Workers 部分不需要凭据，现在就能用。${c.reset}`);
    } else {
      log.err(`${err.message}`);
      console.log('');
      console.log(`${c.dim}检查 Token 是否有效、是否有 Zone:Read 权限。${c.reset}`);
    }
    console.log('');
    await p.pause();
    return false;
  }
}

export async function run({ client, flags }) {
  if (!isInteractive()) {
    // 提示信息走 stderr —— 它们伴随非零退出码，是错误上下文的一部分，
    // 不该混进 stdout（否则 `cfm ui > out.txt` 会写入一堆无关提示）。
    console.error(`${c.red}✘${c.reset} 交互模式需要 TTY 环境。`);
    console.error(`${c.blue}ℹ${c.reset} 在管道或 CI 中请直接用子命令，例如：cfm whoami`);
    console.error(`${c.dim}查看全部命令：cfm help${c.reset}`);
    return 2;
  }

  const p = new Prompt();

  // Ctrl+C / 异常时恢复终端
  const cleanup = () => p.close();
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    await mainMenu(p, client, flags);
  } finally {
    p.close();
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════
// 主菜单
// ═══════════════════════════════════════════════════════════

async function mainMenu(p, client, flags) {
  while (true) {
    clearScreen();
    banner('Cloudflare 免费额度工具箱', 'cfm interactive');

    // 顶部状态：一眼看到凭据是否可用（单行 + 可选的修复提示）
    const { line, hint } = await quickStatus(client);
    console.log(line);
    if (hint) console.log(`${c.yellow}  ↳${c.reset} ${hint}`);
    console.log('');

    // 无凭据时把需要 API 的项标出来，避免用户点了才发现用不了
    const noCreds = hint && /凭据/.test(hint);

    const choice = await p.select('你想做什么？', [
      { label: '📊  看用量', value: 'usage', hint: noCreds ? '需要凭据' : '各类资源用了多少、还剩多少' },
      { label: '🩺  做体检', value: 'doctor', hint: noCreds ? '需要凭据' : '找出悄悄浪费额度的配置' },
      { label: '🔍  全账号审计', value: 'audit', hint: noCreds ? '需要凭据' : 'zone 配置 + 资源占用 + 风险清单' },
      { label: '📖  额度速查', value: 'quota', hint: '离线可用 · 免费额度对照表与踩坑' },
      { label: '🧮  场景估算', value: 'estimate', hint: '部分离线可用 · 这个用法能撑多少流量？' },
      { label: '⚙️   配置与操作', value: 'ops', hint: noCreds ? '需要凭据' : 'DNS / 缓存 / R2 / Workers 等' },
      { label: '🚀  初始化向导', value: 'wizard', hint: noCreds ? '需要凭据' : '新域名接入后的一键加固' },
      { label: '📦  部署站点', value: 'deploy', hint: '一键把站点发布到 Pages' },
      { label: '❓  帮助', value: 'help', hint: '命令对照与文档' },
      { label: '退出', value: 'exit' },
    ]);

    if (isBack(choice) || choice === 'exit') return;

    switch (choice) {
      case 'usage':
        await usageMenu(p, client, flags);
        break;
      case 'doctor':
        await pickZoneAndRun(p, client, 'doctor');
        break;
      case 'audit':
        await auditView(p, client, flags);
        break;
      case 'quota':
        await quotaView(p);
        break;
      case 'estimate':
        await estimateMenu(p, client);
        break;
      case 'ops':
        await opsMenu(p, client, flags);
        break;
      case 'wizard':
        await wizard(p, client);
        break;
      case 'deploy':
        await deployMenu(p, client);
        break;
      case 'help':
        await helpView(p);
        break;
    }
  }
}

/**
 * 顶部状态行：凭据 + zone 数。
 *
 * 返回**单行**字符串 —— 之前这里会返回多行（带「怎么修」的提示），
 * 结果把菜单上方挤成两行，观感很乱。修复指引移到专门的提示区，
 * 由 mainMenu 在状态行之后单独打印。
 *
 * @returns {Promise<{line:string, hint:string|null}>}
 */
async function quickStatus(client) {
  try {
    const cf = client();
    const [accounts, zones] = await Promise.all([
      cf.listAccounts().catch(() => []),
      cf.listZones(),
    ]);

    // zone 数量多时只显示前几个，避免顶栏过长
    const names = zones.slice(0, 3).map((z) => z.name).join(', ');
    const more = zones.length > 3 ? ` 等 ${zones.length} 个` : '';
    const acct = cf.accountId
      ? `账号 ${cf.accountId.slice(0, 8)}…`
      : `${accounts.length} 个账号`;

    return {
      line: `${c.green}●${c.reset} 凭据正常 · ${acct} · ${c.cyan}${zones.length}${c.reset} 个域名${zones.length ? ` ${c.dim}(${names}${more})${c.reset}` : ''}`,
      hint: zones.length === 0 ? '账号下还没有域名。先在 Cloudflare 添加，或检查 Token 的 Zone:Read 权限。' : null,
    };
  } catch (err) {
    if (err instanceof CFError) {
      // 凭据问题的修复指引要和状态行分开
      let hint;
      if (/未找到 Cloudflare 凭据/.test(err.message)) {
        hint = '尚未配置凭据：设置环境变量 CF_API_TOKEN，或在项目根建 .env 文件（参见 .env.example）';
      } else if (err.status === 401 || err.status === 403 || err.code === 10000 || err.code === 6103) {
        hint = `Token 无效或权限不足：${err.message}。检查 Token 是否过期、是否包含所需权限`;
      } else {
        hint = `${err.message}${err.hint ? `（${err.hint}）` : ''}`;
      }
      return { line: `${c.red}●${c.reset} 凭据不可用 ${c.dim}（仍可浏览额度表与使用估算器）${c.reset}`, hint };
    }
    return { line: `${c.red}●${c.reset} 无法连接 Cloudflare`, hint: err.message };
  }
}

// ═══════════════════════════════════════════════════════════
// 用量
// ═══════════════════════════════════════════════════════════

async function usageMenu(p, client, flags) {
  if (!(await ensureCreds(p, client))) return;
  while (true) {
    clearScreen();
    banner('用量概览', '距免费上限还有多少');

    const choice = await p.select('选择操作', [
      { label: '查看全部用量', value: 'all' },
      { label: '只看 Workers 与 KV', value: 'workers' },
      { label: '只看 D1 与 R2', value: 'storage' },
      { label: '导出 JSON', value: 'json', hint: '便于接入自己的监控' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    clearScreen();
    if (choice === 'all') {
      await invoke('usage', { client, flags: { ...flags, _: ['usage'] } });
    } else if (choice === 'workers') {
      await invoke('usage', { client, flags: { ...flags, _: ['usage'], json: false } });
      // 附上 KV 场景提示
      console.log('');
      log.dim('KV 写入是最容易撞墙的一项：免费层仅 1000 次/天。');
      log.dim('跑「场景估算 → KV 写额度分析」可以算清楚你的用法能撑多少流量。');
    } else if (choice === 'storage') {
      await invoke('usage', { client, flags: { ...flags, _: ['usage'] } });
    } else if (choice === 'json') {
      await invoke('usage', { client, flags: { ...flags, _: ['usage'], json: true } });
    }

    console.log('');
    await p.pause();
  }
}

// ═══════════════════════════════════════════════════════════
// 选域名
// ═══════════════════════════════════════════════════════════

/**
 * 列出 zone 让用户选，然后跑指定命令。
 * @param {Prompt} p
 * @param {(flags:any)=>any} client
 * @param {string} action
 */
async function pickZoneAndRun(p, client, action) {
  const zone = await pickZone(p, client);
  if (!zone) return;

  clearScreen();
  await invoke(action, { client, flags: { _: [action, zone.name], zone: zone.name } });
  console.log("");
  await p.pause();
}

// ═══════════════════════════════════════════════════════════
// 审计
// ═══════════════════════════════════════════════════════════

async function auditView(p, client, flags) {
  if (!(await ensureCreds(p, client))) return;
  clearScreen();
  banner('全账号审计', '只读，不修改任何配置');
  await invoke('audit', { client, flags: { ...flags, _: ['audit'] } });
  console.log('');
  await p.pause();
}

// ═══════════════════════════════════════════════════════════
// 额度速查
// ═══════════════════════════════════════════════════════════

async function quotaView(p) {
  while (true) {
    clearScreen();
    banner('免费额度速查');

    const choice = await p.select('选择产品', [
      { label: '全部（完整表）', value: 'all' },
      { label: 'Workers', value: 'workers', hint: `${humanNum(FREE_TIER.workers.requests.limit)} 请求/天` },
      { label: 'Workers KV', value: 'workers_kv', hint: `写 ${humanNum(FREE_TIER.workers_kv.writes.limit)}/天 ← 最紧` },
      { label: 'D1', value: 'workers_d1', hint: `扫 ${humanNum(FREE_TIER.workers_d1.rows_read.limit)} 行/天` },
      { label: 'R2', value: 'r2', hint: `${FREE_TIER.r2.storage.limit}GB + 出站免费` },
      { label: 'Pages', value: 'pages', hint: `${FREE_TIER.pages.builds.limit} 构建/月` },
      { label: '⚠️  踩坑清单', value: 'pitfalls' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    clearScreen();
    if (choice === 'pitfalls') {
      await invoke('quota', { flags: { _: ['quota'], pitfalls: true } });
    } else if (choice === 'all') {
      await invoke('quota', { flags: { _: ['quota'] } });
    } else {
      await invoke('quota', { flags: { _: ['quota', choice] } });
    }
    console.log('');
    await p.pause();
  }
}

// ═══════════════════════════════════════════════════════════
// 场景估算（交互式最有价值的部分）
// ═══════════════════════════════════════════════════════════

async function estimateMenu(p, client) {
  while (true) {
    clearScreen();
    banner('场景估算', '上生产前先算清楚撑不撑得住');

    const choice = await p.select('估算什么？', [
      { label: 'KV 写额度', value: 'kv', hint: '我的用法每天写多少次？' },
      { label: 'D1 查询额度', value: 'd1', hint: '会不会全表扫描烧额度？' },
      { label: 'Pages 构建额度', value: 'pages', hint: '提交频率会不会烧光 500 次' },
      { label: 'Workers 请求额度', value: 'workers', hint: '按日活估算够不够' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    clearScreen();
    switch (choice) {
      case 'kv':
        await estimateKv(p, client);
        break;
      case 'd1':
        await estimateD1(p, client);
        break;
      case 'pages':
        await invoke('pages', { client, flags: { _: ['pages', 'budget'] } });
        break;
      case 'workers':
        await estimateWorkers(p);
        break;
    }
    console.log('');
    await p.pause();
  }
}

/** KV 写额度估算器（纯计算，不需要凭据） */
async function estimateKv(p, client) {
  const writesPerReq = await p.input('每次请求会写几次 KV？', {
    default: '1',
    validate: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? null : '请输入正整数'),
  });
  const dailyReqs = await p.input('预计每天多少请求？', {
    default: '1000',
    validate: (v) => (/^\d+$/.test(v) ? null : '请输入非负整数'),
  });

  const perReq = Number(writesPerReq);
  const reqs = Number(dailyReqs);
  const limit = FREE_TIER.workers_kv.writes.limit;
  const needed = perReq * reqs;
  const pct = (needed / limit) * 100;

  console.log('');
  log.step('估算结果');
  console.log(`  每日写次数需求    ${humanNum(needed)} 次`);
  console.log(`  免费层额度        ${humanNum(limit)} 次/天`);
  console.log(`  占用              ${pct.toFixed(1)}%`);
  console.log('');

  if (pct > 100) {
    log.err(`超出 ${(pct / 100).toFixed(1)} 倍 —— KV 不适合这个用量。`);
    console.log('');
    console.log(`${c.bold}替代方案${c.reset}`);
    const d1Capacity = Math.floor(FREE_TIER.workers_d1.rows_written.limit / perReq);
    console.log(`  • D1          每日可写 ${humanNum(FREE_TIER.workers_d1.rows_written.limit)} 行 → 按你的用法能撑 ${humanNum(d1Capacity)} 请求/天`);
    console.log(`  • Durable Objects  免费层 ${humanNum(FREE_TIER.durable_objects.requests.limit)} 请求/天，强一致，适合状态机`);
    console.log(`  • 降低写入频率   改为批量聚合后写（如每 100 次请求合并成 1 次写）`);
  } else if (pct > 70) {
    log.warn('超过 70%，流量波动就可能撞墙。建议提前规划替代方案。');
  } else {
    log.ok('余量充足，KV 合适。');
  }

  // 反推安全阈值
  const safeReqs = Math.floor(limit * 0.7 / perReq);
  console.log('');
  log.dim(`安全线（70%）：每天不要超过 ${humanNum(safeReqs)} 次请求（按每次写 ${perReq} 次算）`);
}

/** D1 估算（需要选数据库，做真实 EXPLAIN） */
async function estimateD1(p, client) {
  const cf = client();
  const accountId = cf.accountId;
  if (!accountId) {
    log.warn('需要账号 ID 才能看数据库列表。');
    log.dim('请设置 CF_ACCOUNT_ID 后重试。');
    return;
  }

  let dbs = [];
  try {
    dbs = await cf.paginate(`/accounts/${accountId}/d1/database`);
  } catch (err) {
    log.err(`无法获取 D1 列表：${err.message}`);
    return;
  }

  if (!dbs.length) {
    log.info('还没有 D1 数据库。');
    log.dim('免费层可以建 10 个，每个 500MB。');
    return;
  }

  const choice = await p.select(
    '选择数据库做查询分析',
    [...dbs.map((d) => ({ label: d.name, value: d.uuid })), { label: '返回', value: 'back' }],
  );
  if (isBack(choice) || choice === 'back') return;

  const sql = await p.input('输入一条典型查询（SELECT ...）', {
    validate: (v) => (v.trim().length > 0 ? null : '不能为空'),
  });

  console.log('');
  await invoke('d1', {
    client,
    flags: { _: ['d1', 'explain', choice], sql },
  });
}

/** Workers 请求额度估算（纯计算） */
async function estimateWorkers(p) {
  const dau = await p.input('预计日活用户数？', {
    default: '1000',
    validate: (v) => (/^\d+$/.test(v) ? null : '请输入非负整数'),
  });
  const perUser = await p.input('每个用户平均触发几次请求？', {
    default: '20',
    validate: (v) => (/^\d+$/.test(v) ? null : '请输入非负整数'),
  });

  const reqs = Number(dau) * Number(perUser);
  const limit = FREE_TIER.workers.requests.limit;
  const pct = (reqs / limit) * 100;

  console.log('');
  log.step('估算结果');
  console.log(`  每日请求预估      ${humanNum(reqs)}`);
  console.log(`  免费层额度        ${humanNum(limit)} / 天`);
  console.log(`  占用              ${pct.toFixed(1)}%`);
  console.log('');

  if (pct > 100) {
    log.err(`超出 ${(pct / 100).toFixed(1)} 倍。`);
    console.log('');
    console.log(`${c.bold}能做的优化${c.reset}`);
    console.log('  • 静态资源交给 Cache Rules —— 命中缓存的请求不经过 Worker（但走 Worker 路由的会）');
    console.log('  • 把纯静态站点改用 Workers Static Assets，不消耗 Worker 调用');
    console.log('  • 合并接口：一次请求返回多个资源，减少往返');
    console.log(`  • 确实需要更多则考虑 Workers Paid（$5/月 = 1000 万请求）`);
  } else if (pct > 70) {
    log.warn('超过 70%，增长空间有限。');
  } else {
    log.ok(`余量充足。理论上可支撑约 ${humanNum(Math.floor(limit / Number(perUser)))} 日活。`);
  }
}

// ═══════════════════════════════════════════════════════════
// 配置与操作
// ═══════════════════════════════════════════════════════════

async function opsMenu(p, client, flags) {
  if (!(await ensureCreds(p, client))) return;
  while (true) {
    clearScreen();
    banner('配置与操作');

    const choice = await p.select('选择类别', [
      { label: '🌐  DNS 记录', value: 'dns', hint: '查看 / 批量开橙云 / 同步' },
      { label: '⚡  缓存', value: 'cache', hint: '清理 / 开发模式 / Cache Rules' },
      { label: '🔒  域名设置', value: 'zone', hint: 'SSL / HTTPS / Brotli / 一键加固' },
      { label: '📦  R2 存储', value: 'r2', hint: '桶 / 用量 / 生命周期' },
      { label: '🚀  Workers', value: 'workers', hint: '脚本列表 / 路由 / 限制' },
      { label: '🗄️   KV', value: 'kv', hint: '命名空间 / 键值 / 写额度分析' },
      { label: '💾  D1 数据库', value: 'd1', hint: '库 / 查询 / 索引检查' },
      { label: '📄  Pages', value: 'pages', hint: '项目 / 部署 / 构建额度' },
      { label: '🔗  Tunnel', value: 'tunnel', hint: '内网穿透' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    switch (choice) {
      case 'dns':
        await dnsMenu(p, client);
        break;
      case 'cache':
        await cacheMenu(p, client);
        break;
      case 'zone':
        await zoneMenu(p, client);
        break;
      case 'r2':
        await r2Menu(p, client, flags);
        break;
      case 'workers':
        await workersMenu(p, client, flags);
        break;
      case 'kv':
        await kvMenu(p, client, flags);
        break;
      case 'd1':
        await d1Menu(p, client, flags);
        break;
      case 'pages':
        await pagesMenu(p, client, flags);
        break;
      case 'tunnel':
        await tunnelMenu(p, client, flags);
        break;
    }
  }
}


// ═══════════════════════════════════════════════════════════
// Zone 缓存与统一的选域名交互
// ═══════════════════════════════════════════════════════════
//
// 为什么需要缓存：
//   交互模式下几乎每个菜单都要先列 zone 让用户选。原实现每次
//   都调 cf.listZones() 发真实请求 —— 用户在主菜单和二级菜单
//   之间来回切几次就发了十几个重复请求，又慢又浪费配额。
//
// 缓存策略：
//   · 进程生命周期内有效（交互会话通常几分钟）
//   · 支持强制刷新（用户主动选「刷新列表」）
//   · 缓存 Promise 而非结果 —— 并发调用只触发一次请求

/** @type {Promise<any[]>|null} */
let zoneCache = null;
/** @type {number} */
let zoneCacheAt = 0;
const ZONE_TTL_MS = 5 * 60 * 1000;

/**
 * 获取 zone 列表（带缓存）。
 * @param {() => any} client
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<any[]>}
 */
async function getZones(client, opts = {}) {
  const now = Date.now();

  if (!opts.force && zoneCache && now - zoneCacheAt < ZONE_TTL_MS) {
    return zoneCache;
  }

  const cf = client();
  zoneCache = cf.listZones();
  zoneCacheAt = now;

  try {
    return await zoneCache;
  } catch (err) {
    // 失败时清掉缓存，避免把错误结果缓存住
    zoneCache = null;
    zoneCacheAt = 0;
    throw err;
  }
}

/** 清空缓存（修改了 zone 之后调用） */
function invalidateZones() {
  zoneCache = null;
  zoneCacheAt = 0;
}

/**
 * 统一的「选一个 zone」交互。
 *
 * 原实现散落在 6 个菜单里，每个都重复「拉列表 → 拼选项 → 处理返回」。
 * 抽出来后：加了缓存、加了刷新入口、加了套餐信息。
 *
 * @param {Prompt} p
 * @param {() => any} client
 * @param {{title?:string, allowRefresh?:boolean}} [opts]
 * @returns {Promise<any|null>} 选中的 zone，取消则 null
 */
async function pickZone(p, client, opts = {}) {
  const title = opts.title ?? '选择域名';

  while (true) {
    let zones;
    try {
      zones = await getZones(client);
    } catch (err) {
      log.err("无法获取域名列表：" + err.message);
      return null;
    }

    if (!zones.length) {
      log.warn('账号下没有可见的域名。');
      log.dim('先在 Cloudflare 添加域名，或检查 Token 的 Zone:Read 权限。');
      return null;
    }

    const choices = zones.map((z) => ({
      label: z.name,
      value: z.id,
      hint: (z.plan?.name ?? "?") + " · " + z.status,
    }));

    if (opts.allowRefresh !== false) {
      choices.push({ label: '─'.repeat(28), value: '__sep__', disabled: true });
      choices.push({ label: '刷新列表', value: '__refresh__', hint: '当前 ' + zones.length + ' 个' });
    }
    choices.push({ label: '返回', value: null });

    const picked = await p.select(title, choices);

    if (isBack(picked)) return null;
    if (picked === null) return null;
    if (picked === '__refresh__') {
      invalidateZones();
      continue;
    }
    if (picked === '__sep__') continue;

    return zones.find((z) => z.id === picked) ?? null;
  }
}

/**
 * 选一个 zone 并执行某个命令。
 * @param {Prompt} p
 * @param {() => any} client
 * @param {string} cmd
 * @param {string} sub
 * @param {Record<string,any>} [extraFlags]
 */
async function runOnZone(p, client, cmd, sub, extraFlags = {}) {
  const zone = await pickZone(p, client);
  if (!zone) return false;

  clearScreen();
  await invoke(cmd, { client, flags: { _: [cmd, sub, zone.name], ...extraFlags } });
  return true;
}

// ---------- DNS ----------

async function dnsMenu(p, client) {
  while (true) {
    clearScreen();
    banner('DNS 记录');

    const choice = await p.select('选择操作', [
      { label: '列出记录', value: 'list' },
      { label: '找出未走橙云的记录', value: 'notproxied', hint: '这些记录失去了缓存与防护' },
      { label: '批量开启橙云', value: 'proxy-on', hint: '⚠️ 会修改配置' },
      { label: '批量关闭橙云', value: 'proxy-off', hint: '⚠️ DDNS 场景常用' },
      { label: '导出为 JSON', value: 'export', hint: '做备份' },
      { label: '更新 DDNS 记录', value: 'ddns' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    if (choice === 'notproxied') {
      clearScreen();
      const cf = client();
      const zones = await getZones(client).catch(() => []);
      if (!zones.length) {
        log.warn('没有可见的域名。');
        await p.pause();
        continue;
      }
      for (const z of zones) {
        const recs = await cf.paginate(`/zones/${z.id}/dns_records`).catch(() => []);
        const notProxied = recs.filter((r) => r.proxiable && !r.proxied);
        if (notProxied.length) {
          console.log(`\n${c.bold}${z.name}${c.reset}  ${c.yellow}${notProxied.length}${c.reset} 条未代理`);
          table(
            ['类型', '名称', '内容'],
            notProxied.slice(0, 20).map((r) => [r.type, r.name, r.content.slice(0, 40)]),
          );
        }
      }
      log.dim('\n提示：不是所有记录都该开橙云。邮件（MX/TXT）、指向非 HTTP 服务的 A 记录开了会出问题。');
      await p.pause();
      continue;
    }

    if (choice === 'list') {
      await runOnZone(p, client, 'dns', 'list');
      await p.pause();
      continue;
    }
    if (choice === 'export') {
      clearScreen();
      const cf = client();
      const zc = await pickZone(p, client);
      if (!zc) continue;
      const file = await p.input('保存到文件', { default: `dns-${zc}-${Date.now()}.json` });
      await invoke('dns', { client, flags: { _: ['dns', 'export', zc], file } });
      await p.pause();
      continue;
    }
    if (choice === 'proxy-on' || choice === 'proxy-off') {
      const enable = choice === 'proxy-on';
      clearScreen();
      const ok = await runOnZone(p, client, 'dns', 'proxy', { enable, 'dry-run': true });
      if (!ok) continue;

      if (await p.confirm(`${enable ? '开启' : '关闭'}橙云会修改真实配置，确认执行？`, false)) {
        const cf = client();
        const zone2 = await pickZone(p, client, { title: '再确认一次域名', allowRefresh: false });
        const zc = zone2 ? zone2.name : null;
        await invoke('dns', { client, flags: { _: ['dns', 'proxy', zc], enable, yes: true } });
      } else {
        log.info('已取消。');
      }
      await p.pause();
      continue;
    }
    if (choice === 'ddns') {
      clearScreen();
      const cf = client();
      const zc = await pickZone(p, client);
      if (!zc) continue;
      const name = await p.input('记录名（如 home）', { default: 'home' });
      await invoke('dns', { client, flags: { _: ['dns', 'ddns', zc], name } });
      await p.pause();
      continue;
    }
  }
}

// ---------- 缓存 ----------

async function cacheMenu(p, client) {
  while (true) {
    clearScreen();
    banner('缓存管理');

    const choice = await p.select('选择操作', [
      { label: '查看 Cache Rules', value: 'rules-show' },
      { label: '应用推荐规则', value: 'rules-apply', hint: '静态长缓存——免费层最值钱的一条' },
      { label: '清理缓存', value: 'purge', hint: '⚠️ 会让请求回源' },
      { label: '开发模式', value: 'devmode', hint: '临时绕过缓存' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    if (choice === 'rules-show') {
      clearScreen();
      await runOnZone(p, client, 'cache', 'rules', { show: true });
      await p.pause();
      continue;
    }

    if (choice === 'rules-apply') {
      clearScreen();
      const profile = await p.select('选择规则模板', [
        { label: 'static（推荐）', value: 'static', hint: '静态资源 1 年 / 图片 30 天 / HTML 5 分钟 / API 不缓存' },
        { label: 'conservative', value: 'conservative', hint: '只缓存 /static 与 /assets' },
        { label: '返回', value: null },
      ]);
      if (!profile) continue;

      const cf = client();
      const zc = await pickZone(p, client);
      if (!zc) continue;

      clearScreen();
      console.log(`${c.bold}将应用 profile「${profile}」到 ${zc}${c.reset}\n`);
      if (await p.confirm('确认应用？会覆盖该域名现有的 Cache Rules', false)) {
        await invoke('cache', { client, flags: { _: ['cache', 'rules', zc], apply: profile, yes: true } });
      } else {
        log.info('已取消。');
      }
      await p.pause();
      continue;
    }

    if (choice === 'purge') {
      clearScreen();
      const mode = await p.select('清理方式', [
        { label: '按 URL 清理（推荐）', value: 'urls' },
        { label: '按主机名清理', value: 'hosts' },
        { label: '清空全部（⚠️ 风险最高）', value: 'all' },
        { label: '返回', value: null },
      ]);
      if (!mode) continue;

      const cf = client();
      const zc = await pickZone(p, client);
      if (!zc) continue;

      clearScreen();
      if (mode === 'all') {
        log.warn('清空整个域名的缓存会让下一次访问全部回源。');
        log.dim('如果源站扛不住突发流量，改用按 URL 清理。');
        if (await p.confirm(`确认清空 ${zc} 的全部缓存？`, false)) {
          await invoke('cache', { client, flags: { _: ['cache', 'purge', zc], all: true, yes: true } });
        }
      } else if (mode === 'urls') {
        const urls = await p.input('输入 URL（逗号分隔，最多 30 个）');
        if (urls) {
          await invoke('cache', { client, flags: { _: ['cache', 'purge', zc], urls } });
        }
      } else {
        const hosts = await p.input('输入主机名（逗号分隔）');
        if (hosts) {
          await invoke('cache', { client, flags: { _: ['cache', 'purge', zc], hosts } });
        }
      }
      await p.pause();
      continue;
    }

    if (choice === 'devmode') {
      clearScreen();
      await runOnZone(p, client, 'cache', 'devmode', { _: ['cache', 'devmode'] });
      await p.pause();
      continue;
    }
  }
}

// ---------- 域名设置 ----------

async function zoneMenu(p, client) {
  while (true) {
    clearScreen();
    banner('域名设置');

    const choice = await p.select('选择操作', [
      { label: '查看当前设置', value: 'show' },
      { label: '一键加固（推荐）', value: 'harden', hint: '开 HTTPS / Brotli / HTTP3 / TLS1.3 等' },
      { label: '开启 Always Use HTTPS', value: 'https' },
      { label: '修改 SSL 模式', value: 'ssl' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    if (choice === 'show') {
      clearScreen();
      await runOnZone(p, client, 'zone', 'show');
      await p.pause();
      continue;
    }

    if (choice === 'harden') {
      clearScreen();
      const withHsts = await p.confirm('是否一并开启 HSTS？（不可逆，需先确认所有子域都有有效证书）', false);
      const cf = client();
      const zc = await pickZone(p, client);
      if (!zc) continue;

      clearScreen();
      console.log(`${c.bold}将对 ${zc} 执行加固${c.reset}\n`);
      console.log('  会打开：Always Use HTTPS、Brotli、HTTP/2、HTTP/3、TLS 1.3、');
      console.log('          min TLS 1.2、Opportunistic Encryption、HTTPS Rewrites、');
      console.log('          WebSockets、IPv6、0-RTT');
      console.log('  会关闭：Rocket Loader（会破坏部分 JS）');
      if (withHsts) console.log(`  ${c.yellow}外加 HSTS（max_age=1天试水）${c.reset}`);
      console.log('');

      if (await p.confirm('确认执行？', true)) {
        await invoke('zone', {
          client,
          flags: { _: ['zone', 'harden', zc], 'with-hsts': withHsts, yes: true },
        });
        console.log('');
        log.dim('提示：跑「体检」可以复核效果。');
      } else {
        log.info('已取消。');
      }
      await p.pause();
      continue;
    }

    if (choice === 'https') {
      clearScreen();
      await runOnZone(p, client, 'zone', 'set', { _: ['zone', 'set'], yes: true });
      await p.pause();
      continue;
    }

    if (choice === 'ssl') {
      clearScreen();
      const mode = await p.select('选择 SSL 模式', [
        { label: 'full_strict（推荐）', value: 'full_strict', hint: '端到端加密且校验源站证书' },
        { label: 'full', value: 'full', hint: '加密但不校验源站证书' },
        { label: 'flexible', value: 'flexible', hint: '⚠️ 回源明文，会导致重定向循环' },
        { label: '返回', value: null },
      ]);
      if (!mode) continue;
      if (mode === 'flexible') {
        log.warn('Flexible 是很多「站点打不开」问题的根因，确认要用？');
        if (!(await p.confirm('确定吗？', false))) continue;
      }
      const cf = client();
      const zc = await pickZone(p, client);
      if (!zc) continue;
      await invoke('zone', {
        client,
        flags: { _: ['zone', 'set', zc, 'ssl', mode], yes: true },
      });
      await p.pause();
      continue;
    }
  }
}

// ---------- R2 ----------

async function r2Menu(p, client, flags) {
  while (true) {
    clearScreen();
    banner('R2 对象存储');

    const choice = await p.select('选择操作', [
      { label: '查看用量', value: 'usage', hint: '10GB 用了多少' },
      { label: '列出桶', value: 'list' },
      { label: '创建桶', value: 'create' },
      { label: '设置自动清理（省钱）', value: 'lifecycle' },
      { label: '绑定自定义域', value: 'domain' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    if (choice === 'lifecycle') {
      clearScreen();
      const cf = client();
      const accountId = cf.accountId;
      if (!accountId) {
        log.warn('需要 CF_ACCOUNT_ID。');
        await p.pause();
        continue;
      }
      const buckets = await cf.paginate(`/accounts/${accountId}/r2/buckets`).catch(() => []);
      if (!buckets.length) {
        log.info('还没有桶。');
        await p.pause();
        continue;
      }
      const b = await p.select('选择桶', [
        ...buckets.map((x) => ({ label: x.name, value: x.name })),
        { label: '返回', value: null },
      ]);
      if (!b) continue;
      const days = await p.input('多少天后自动删除这些对象？', {
        default: '90',
        validate: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? null : '请输入正整数'),
      });
      const prefix = await p.input('只清理某个前缀下的对象？（留空表示全部）', { default: '' });
      const args = { _: ['r2', 'lifecycle', b], 'expire-days': days, yes: true };
      if (prefix) args.prefix = prefix;
      await invoke('r2', { client, flags: args });
      console.log('');
      log.dim('这是防止 R2 存储费超标最有效的手段 —— 让垃圾数据自己消失。');
      await p.pause();
      continue;
    }

    if (choice === 'create') {
      clearScreen();
      const name = await p.input('桶名（小写字母/数字/连字符，3~63 位）', {
        validate: (v) =>
          /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v)
            ? null
            : '格式不对：必须小写字母数字与连字符，且首尾为字母数字',
      });
      const loc = await p.select('位置', [
        { label: 'auto（推荐）', value: 'auto' },
        { label: 'apac  亚太', value: 'apac' },
        { label: 'wnam  北美西部', value: 'wnam' },
        { label: 'enam  北美东部', value: 'enam' },
        { label: 'weur  西欧', value: 'weur' },
        { label: '返回', value: null },
      ]);
      if (!loc) continue;
      await invoke('r2', { client, flags: { _: ['r2', 'create', name], location: loc } });
      await p.pause();
      continue;
    }

    if (choice === 'domain') {
      clearScreen();
      const cf = client();
      const accountId = cf.accountId;
      if (!accountId) {
        log.warn('需要 CF_ACCOUNT_ID。');
        await p.pause();
        continue;
      }
      const buckets = await cf.paginate(`/accounts/${accountId}/r2/buckets`).catch(() => []);
      const b = await p.select('选择桶', [
        ...buckets.map((x) => ({ label: x.name, value: x.name })),
        { label: '返回', value: null },
      ]);
      if (!b) continue;
      const host = await p.input('自定义域名（如 r2.example.com）');
      await invoke('r2', { client, flags: { _: ['r2', 'domain', b], add: host } });
      await p.pause();
      continue;
    }

    clearScreen();
    await invoke('r2', { client, flags: { ...flags, _: ['r2', choice] } });
    await p.pause();
  }
}

// ---------- Workers ----------

async function workersMenu(p, client, flags) {
  while (true) {
    clearScreen();
    banner('Workers');

    const choice = await p.select('选择操作', [
      { label: '列出脚本', value: 'list' },
      { label: '限制与占用', value: 'limits', hint: '免费层各产品占用一览' },
      { label: '查看路由', value: 'routes' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    if (choice === 'routes') {
      clearScreen();
      await runOnZone(p, client, 'workers', 'route', { _: ['workers', 'route', 'list'] });
      await p.pause();
      continue;
    }

    clearScreen();
    await invoke('workers', { client, flags: { ...flags, _: ['workers', choice] } });
    await p.pause();
  }
}

// ---------- KV ----------

async function kvMenu(p, client, flags) {
  while (true) {
    clearScreen();
    banner('Workers KV');

    const choice = await p.select('选择操作', [
      { label: '列出命名空间', value: 'list' },
      { label: '写额度压力分析', value: 'budget', hint: '🔴 免费层最容易撞墙的一项' },
      { label: '查看某个命名空间的键', value: 'keys' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    const cf = client();
    const accountId = cf.accountId;
    if (!accountId) {
      clearScreen();
      log.warn('KV 操作需要账号 ID。');
      log.dim('请设置 CF_ACCOUNT_ID 环境变量后重试。');
      await p.pause();
      continue;
    }

    if (choice === 'list') {
      clearScreen();
      await invoke('kv', { client, flags: { ...flags, _: ['kv', 'list'] } });
      await p.pause();
      continue;
    }

    const namespaces = await cf.paginate(`/accounts/${accountId}/storage/kv/namespaces`).catch(() => []);
    if (!namespaces.length) {
      clearScreen();
      log.info('还没有 KV 命名空间。');
      log.dim('免费层可建 1000 个，但每日写只有 1000 次。');
      await p.pause();
      continue;
    }

    clearScreen();
    const ns = await p.select('选择命名空间', [
      ...namespaces.map((n) => ({ label: n.title, value: n.id })),
      { label: '返回', value: null },
    ]);
    if (!ns) continue;

    if (choice === 'budget') {
      clearScreen();
      const writes = await p.input('每次请求写几次 KV？', {
        default: '1',
        validate: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? null : '请输入正整数'),
      });
      const reqs = await p.input('每天预计多少请求？', { default: '' });
      const a = { _: ['kv', 'budget', ns], 'per-request-writes': writes };
      if (reqs) a['daily-requests'] = reqs;
      await invoke('kv', { client, flags: a });
      await p.pause();
      continue;
    }

    if (choice === 'keys') {
      clearScreen();
      const prefix = await p.input('键名前缀（留空看全部）', { default: '' });
      const a = { _: ['kv', 'keys', ns] };
      if (prefix) a.prefix = prefix;
      await invoke('kv', { client, flags: a });
      await p.pause();
      continue;
    }
  }
}

// ---------- D1 ----------

async function d1Menu(p, client, flags) {
  while (true) {
    clearScreen();
    banner('D1 数据库');

    const choice = await p.select('选择操作', [
      { label: '列出数据库', value: 'list' },
      { label: '索引健康检查', value: 'index', hint: '🔴 缺索引会烧光扫描行额度' },
      { label: '查询计划分析', value: 'explain', hint: '检测全表扫描' },
      { label: '执行 SQL', value: 'query' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    const cf = client();
    const accountId = cf.accountId;
    if (!accountId) {
      clearScreen();
      log.warn('D1 操作需要账号 ID。');
      await p.pause();
      continue;
    }

    if (choice === 'list') {
      clearScreen();
      await invoke('d1', { client, flags: { ...flags, _: ['d1', 'list'] } });
      await p.pause();
      continue;
    }

    const dbs = await cf.paginate(`/accounts/${accountId}/d1/database`).catch(() => []);
    if (!dbs.length) {
      clearScreen();
      log.info('还没有 D1 数据库。');
      await p.pause();
      continue;
    }

    clearScreen();
    const db = await p.select('选择数据库', [
      ...dbs.map((d) => ({ label: d.name, value: d.name })),
      { label: '返回', value: null },
    ]);
    if (!db) continue;

    clearScreen();
    if (choice === 'index') {
      await invoke('d1', { client, flags: { ...flags, _: ['d1', 'index', db] } });
    } else if (choice === 'explain') {
      const sql = await p.input('输入一条典型 SELECT 查询');
      await invoke('d1', { client, flags: { ...flags, _: ['d1', 'explain', db], sql } });
    } else if (choice === 'query') {
      const sql = await p.input('输入 SQL');
      console.log('');
      const isWrite = /^\s*(insert|update|delete|create|drop|alter|replace)\b/i.test(sql);
      if (isWrite) {
        log.warn('这是写操作，会消耗每日写额度。');
        if (!(await p.confirm('确认执行？', false))) continue;
      }
      await invoke('d1', { client, flags: { ...flags, _: ['d1', 'query', db], sql, yes: true } });
    }
    await p.pause();
  }
}

// ---------- Pages ----------

async function pagesMenu(p, client, flags) {
  while (true) {
    clearScreen();
    banner('Cloudflare Pages');

    const choice = await p.select('选择操作', [
      { label: '列出项目', value: 'list' },
      { label: '构建额度分析', value: 'budget', hint: '每月只有 500 次构建' },
      { label: '查看部署记录', value: 'deployments' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    if (choice === 'deployments') {
      clearScreen();
      const cf = client();
      const accountId = cf.accountId;
      if (!accountId) {
        log.warn('需要 CF_ACCOUNT_ID。');
        await p.pause();
        continue;
      }
      const projects = await cf.paginate(`/accounts/${accountId}/pages/projects`).catch(() => []);
      if (!projects.length) {
        log.info('还没有 Pages 项目。');
        await p.pause();
        continue;
      }
      const pr = await p.select('选择项目', [
        ...projects.map((x) => ({ label: x.name, value: x.name })),
        { label: '返回', value: null },
      ]);
      if (!pr) continue;
      clearScreen();
      await invoke('pages', { client, flags: { ...flags, _: ['pages', 'deployments', pr] } });
      await p.pause();
      continue;
    }

    clearScreen();
    await invoke('pages', { client, flags: { ...flags, _: ['pages', choice] } });
    await p.pause();
  }
}

// ---------- Tunnel ----------

async function tunnelMenu(p, client, flags) {
  while (true) {
    clearScreen();
    banner('Cloudflare Tunnel', '不用开放任何入站端口就能暴露内网服务');

    const choice = await p.select('选择操作', [
      { label: '列出隧道', value: 'list' },
      { label: '查看连接状态', value: 'connections' },
      { label: '查看 ingress 配置', value: 'ingress' },
      { label: '安装说明', value: 'setup' },
      { label: '返回', value: 'back' },
    ]);
    if (isBack(choice) || choice === 'back') return;

    const cf = client();
    const accountId = cf.accountId;
    if (!accountId) {
      clearScreen();
      log.warn('Tunnel 操作需要账号 ID。');
      await p.pause();
      continue;
    }

    if (choice === 'list') {
      clearScreen();
      await invoke('tunnel', { client, flags: { ...flags, _: ['tunnel', 'list'] } });
      await p.pause();
      continue;
    }

    const tunnels = await cf
      .paginate(`/accounts/${accountId}/cfd_tunnel`, { query: { is_deleted: false } })
      .catch(() => []);
    if (!tunnels.length) {
      clearScreen();
      log.info('还没有 Tunnel。');
      log.dim('Tunnel 免费、不限数量，且不消耗带宽额度。');
      await p.pause();
      continue;
    }

    clearScreen();
    const t = await p.select('选择隧道', [
      ...tunnels.map((x) => ({ label: x.name, value: x.name, hint: x.status })),
      { label: '返回', value: null },
    ]);
    if (!t) continue;

    clearScreen();
    await invoke('tunnel', { client, flags: { ...flags, _: ['tunnel', choice, t] } });
    await p.pause();
  }
}

// ═══════════════════════════════════════════════════════════
// 初始化向导
// ═══════════════════════════════════════════════════════════

async function wizard(p, client) {
  if (!(await ensureCreds(p, client))) return;
  clearScreen();
  banner('初始化向导', '新域名接入后的标准加固流程');

  const cf = client();
  // 用统一的 pickZone（自带缓存，不会重复请求）

  if (!zones.length) {
    log.warn('没有可见的域名。');
    log.dim('先在 Cloudflare 添加域名。');
    await p.pause();
    return;
  }

  const zone = await pickZone(p, client, { title: '选择要初始化的域名' });
  if (!zone) return;
  const zc = zone.name;

  // 步骤定义
  const steps = [
    {
      id: 'doctor',
      title: '第 1 步：体检现状',
      desc: '先看清楚有哪些问题，再动手',
      run: () => invoke('doctor', { client, flags: { _: ['doctor', zc], zone: zc } }),
    },
    {
      id: 'harden',
      title: '第 2 步：加固域名设置',
      desc: '开 HTTPS / Brotli / HTTP3 / TLS1.3 等免费加速项',
      run: (hsts) => invoke('zone', { client, flags: { _: ['zone', 'harden', zc], 'with-hsts': hsts, yes: true } }),
    },
    {
      id: 'dns',
      title: '第 3 步：检查 DNS 代理',
      desc: '把该走橙云的记录开起来',
      run: () => invoke('dns', { client, flags: { _: ['dns', 'proxy', zc], enable: true, 'dry-run': true } }),
    },
    {
      id: 'cache',
      title: '第 4 步：配置 Cache Rules',
      desc: '静态资源长缓存 —— 免费层最值钱的一条规则',
      run: () => invoke('cache', { client, flags: { _: ['cache', 'rules', zc], apply: 'static', yes: true } }),
    },
    {
      id: 'verify',
      title: '第 5 步：复核',
      desc: '再跑一次体检，确认问题已消除',
      run: () => invoke('doctor', { client, flags: { _: ['doctor', zc], zone: zc } }),
    },
  ];

  const selected = await p.multiSelect(
    '选择要执行的步骤（默认全选）',
    steps.map((s, i) => ({ label: s.title, value: i, checked: true, hint: s.desc })),
  );
  if (isBack(selected)) return;

  const hsts = await p.confirm('加固时是否一并开启 HSTS？（不可逆，需确认所有子域证书有效）', false);

  const chosen = [...selected].sort((a, b) => a - b);
  if (!chosen.length) {
    log.info('没有选择任何步骤。');
    await p.pause();
    return;
  }

  clearScreen();
  console.log(`${c.bold}即将对 ${zc} 执行以下步骤${c.reset}\n`);
  for (const i of chosen) {
    console.log(`  ${c.cyan}${i + 1}.${c.reset} ${steps[i].title}  ${c.dim}${steps[i].desc}${c.reset}`);
  }
  console.log('');

  if (!(await p.confirm('确认开始？', true))) {
    log.info('已取消。');
    await p.pause();
    return;
  }

  for (const i of chosen) {
    const step = steps[i];
    clearScreen();
    console.log(`\n${c.bold}${c.cyan}━━━ ${step.title} ━━━${c.reset}\n`);
    try {
      await step.run(hsts);
    } catch (err) {
      log.err(`步骤失败：${err.message}`);
    }
    console.log('');
    if (i !== chosen[chosen.length - 1]) {
      if (!(await p.confirm('继续下一步？', true))) break;
    }
  }

  console.log('');
  log.ok('向导完成。');
  log.dim('建议：用 cfm usage 定期看额度消耗趋势。');
  await p.pause();
}

// ═══════════════════════════════════════════════════════════
// 帮助
// ═══════════════════════════════════════════════════════════

async function helpView(p) {
  clearScreen();
  banner('帮助');

  const choice = await p.select('查看什么', [
    { label: '交互模式的按键说明', value: 'keys' },
    { label: '全部命令行用法', value: 'cli' },
    { label: '凭据配置方法', value: 'creds' },
    { label: '免费额度踩坑', value: 'pitfalls' },
    { label: '返回', value: 'back' },
  ]);
  if (isBack(choice) || choice === 'back') return;

  clearScreen();
  switch (choice) {
    case 'keys':
      console.log(`${c.bold}交互模式按键${c.reset}\n`);
      console.log('  ↑ / ↓        移动光标');
      console.log('  数字键 1-9   直接选择对应项');
      console.log('  回车         确认当前项');
      console.log('  空格         多选时切换勾选');
      console.log('  a            多选时全选/全不选（KV 用法评估里不用）');
      console.log('  q            返回上一级（主菜单按 q 退出）');
      console.log('  Ctrl+C       强制退出');
      console.log('');
      log.dim('提示：任何时候都能用命令行直接调子命令，交互模式只是入口。');
      log.dim('例如 cfm usage --json 可以在脚本里用。');
      break;

    case 'cli':
      await invoke('help', {});
      break;

    case 'creds':
      console.log(`${c.bold}凭据配置${c.reset}\n`);
      console.log('方式一（推荐）：API Token');
      console.log(`  ${c.cyan}export CF_API_TOKEN=xxx${c.reset}`);
      console.log('  或写进 .env 文件（已被 .gitignore 忽略）');
      console.log('');
      console.log('方式二：Global API Key（权限过大，仅兼容用）');
      console.log(`  ${c.cyan}export CF_API_EMAIL=you@example.com`);
      console.log(`  export CF_API_KEY=xxx${c.reset}`);
      console.log('');
      console.log(`${c.bold}还需设置的${c.reset}`);
      console.log(`  CF_ACCOUNT_ID    多账号时必须；R2/KV/D1/Pages/Tunnel 都需要`);
      console.log('');
      console.log(`${c.bold}怎么拿这些值${c.reset}`);
      console.log('  · Token：https://dash.cloudflare.com/profile/api-tokens');
      console.log('    最小权限见 README 的表格');
      console.log('  · 账号 ID：跑 cfm whoami，或看控制台 URL 里的 account id');
      console.log('');
      log.dim('本工具只读你的 Token 授权范围内的资源，不会也不该访问别人的账号。');
      break;

    case 'pitfalls':
      console.log(`${c.bold}${c.yellow}最容易踩的五个坑${c.reset}\n`);
      for (const f of PITFALLS) {
        console.log(`${c.yellow}●${c.reset} ${c.bold}${f.title}${c.reset}`);
        console.log(`  ${f.detail}\n`);
      }
      break;
  }
  await p.pause();
}

// ═══════════════════════════════════════════════════════════════════════════
// 部署站点
// ═══════════════════════════════════════════════════════════════════════════

async function deployMenu(p, client) {
  while (true) {
    clearScreen();
    banner('部署站点', '发布到 Cloudflare Pages');

    // 读配置显示站点列表
    let sites = [];
    let protectedSites = [];
    try {
      const { loadConfig } = await import('../lib/deploy-config.mjs');
      const cfg = loadConfig();
      sites = cfg.sites.filter((s) => !s.protected);
      protectedSites = cfg.sites.filter((s) => s.protected);
    } catch (err) {
      log.err(`读取部署配置失败：${err.message}`);
      if (String(err.message).includes('找不到配置文件')) {
        log.dim('配置文件：config/sites.json');
      }
      console.log('');
      await p.pause();
      return;
    }

    const choices = [
      { label: '查看配置与状态', value: 'list', hint: '只读，建议先看' },
      { label: '检查线上状态', value: 'online', hint: '只读，含受保护站点' },
      { label: '环境体检', value: 'check', hint: 'Node / git / wrangler / 认证' },
      { label: '─'.repeat(30), value: 'sep', disabled: true },
    ];

    for (const s of sites) {
      choices.push({
        label: `部署：${s.label}`,
        value: `deploy:${s.id}`,
        hint: s.domain || s.project,
      });
    }

    choices.push({ label: '─'.repeat(30), value: 'sep2', disabled: true });
    choices.push({ label: '预演（不实际执行）', value: 'dry', hint: '看会做什么' });
    // 受保护站点不提供部署入口，但说明存在
    if (protectedSites.length) {
      choices.push({
        label: `🔒 ${protectedSites.map((s) => s.label).join('、')}（受保护）`,
        value: 'protected-info',
        hint: '不参与部署，可查看状态',
      });
    }
    choices.push({ label: '返回', value: 'back' });

    const choice = await p.select('选择操作', choices);
    if (isBack(choice) || choice === 'back') return;
    if (choice === 'sep' || choice === 'sep2') continue;

    clearScreen();

    switch (choice) {
      case 'list':
        await invoke('deploy', { client, flags: { _: ['deploy'], list: true } });
        break;
      case 'online':
        await invoke('deploy', { client, flags: { _: ['deploy'], 'check-online': true } });
        break;
      case 'check':
        await invoke('deploy', { client, flags: { _: ['deploy'], check: true } });
        break;
      case 'dry':
        await invoke('deploy', { client, flags: { _: ['deploy'], 'dry-run': true } });
        break;
      case 'protected-info':
        await showProtectedInfo(p, protectedSites);
        continue;
      default:
        if (choice.startsWith('deploy:')) {
          const id = choice.slice('deploy:'.length);
          const site = sites.find((s) => s.id === id);
          if (site) await confirmAndDeploy(p, client, site);
        }
        break;
    }

    console.log('');
    await p.pause();
  }
}

/** 部署前的确认页 —— 把「将要做什么」讲清楚 */
async function confirmAndDeploy(p, client, site) {
  console.log('');
  console.log(`${c.bold}准备部署：${site.label}${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}仓库${c.reset}      ${site.repo}`);
  console.log(`  ${c.dim}Pages 项目${c.reset}  ${site.project}`);
  if (site.domain) console.log(`  ${c.dim}线上域名${c.reset}  ${site.domain}`);
  console.log(`  ${c.dim}类型${c.reset}      ${site.type === 'build' ? `构建（${site.buildCommand}）` : '纯静态'}`);
  console.log(`  ${c.dim}产物目录${c.reset}  ${site.outputDir}`);

  if (site.patches?.length) {
    console.log('');
    console.log(`  ${c.yellow}会应用 ${site.patches.length} 个构建补丁：${c.reset}`);
    for (const id of site.patches) {
      console.log(`    · ${id}`);
    }
  }

  console.log('');
  log.dim('流程：拉取代码 → 安装依赖 → 构建 → 上传到 Pages');
  log.dim('不消耗 Pages 每月 500 次的构建额度（Direct Upload）。');
  console.log('');
  log.warn('部署会更新该 Pages 项目的线上内容。');

  console.log('');
  if (!(await p.confirm(`确认部署「${site.label}」？`, false))) {
    log.info('已取消。');
    return;
  }

  console.log('');
  await invoke('deploy', { client, flags: { _: ['deploy', '--only', site.id], only: site.id, yes: true } });
}

/** 展示受保护站点的信息 */
async function showProtectedInfo(p, sites) {
  banner('受保护的站点', '脚本不会 clone / 构建 / 部署它们');
  console.log('');

  for (const s of sites) {
    console.log(`  ${c.yellow}🔒 ${c.bold}${s.label}${c.reset} ${c.dim}(${s.id})${c.reset}`);
    console.log(`      ${s.protectedReason}`);
    console.log(`      ${c.dim}仓库 ${s.repo} → Pages 项目 ${s.project}${c.reset}`);
    if (s.domain) console.log(`      ${c.dim}线上：${s.domain}${c.reset}`);
    console.log('');
  }

  console.log(`  ${c.dim}这类站点默认被三层拦截保护：${c.reset}`);
  console.log(`    ${c.dim}1. 批量部署时自动排除${c.reset}`);
  console.log(`    ${c.dim}2. 显式指定会拒绝执行${c.reset}`);
  console.log(`    ${c.dim}3. 即使加 --include-protected 也要二次确认${c.reset}`);
  console.log('');
  log.dim('想看它们是否正常，用「检查线上状态」—— 那是只读的。');
  console.log('');
  await p.pause();
}
