/**
 * kv — Workers KV 命名空间管理
 *
 * ⚠️ 免费层最紧的额度就在 KV：**每天只有 1000 次写**。
 * 这个命令组的核心价值是让你「先看清楚自己在怎么用 KV」，再决定要不要换存储。
 *
 * 子命令：
 *   cfm kv list
 *   cfm kv create <title>
 *   cfm kv delete <namespace-id>
 *   cfm kv keys <namespace-id> [--prefix p] [--limit 1000]
 *   cfm kv get <namespace-id> <key>
 *   cfm kv put <namespace-id> <key> <value> [--ttl 3600] [--expiration 2026-12-31T00:00:00Z]
 *   cfm kv del <namespace-id> <key>
 *   cfm kv budget <namespace-id>     分析这个命名空间的写放大风险
 */

import { log, table, color, confirm, humanNum } from '../lib/util.mjs';
import { FREE_TIER } from '../lib/quota.mjs';

export async function run({ client, flags }) {
  const sub = flags._[1];
  const cf = client();
  const accountId = cf.accountId;
  if (!accountId) {
    log.err('KV 需要账号 ID。请设置 CF_ACCOUNT_ID。');
    return 1;
  }

  switch (sub) {
    case 'list':
      return listNs(cf, accountId, flags);
    case 'create':
      return createNs(cf, accountId, flags);
    case 'delete':
      return deleteNs(cf, accountId, flags);
    case 'keys':
      return listKeys(cf, accountId, flags);
    case 'get':
      return getKey(cf, accountId, flags);
    case 'put':
      return putKey(cf, accountId, flags);
    case 'del':
      return delKey(cf, accountId, flags);
    case 'budget':
      return budget(cf, accountId, flags);
    default:
      log.err(`未知子命令：kv ${sub ?? '(空)'}`);
      console.log('可用：list / create / delete / keys / get / put / del / budget');
      return 2;
  }
}

async function listNs(cf, accountId, flags) {
  const namespaces = await cf.paginate(`/accounts/${accountId}/storage/kv/namespaces`);
  if (flags.json) {
    console.log(JSON.stringify(namespaces, null, 2));
    return 0;
  }
  if (!namespaces.length) {
    log.info('还没有 KV 命名空间。');
    log.dim('创建：cfm kv create my-cache');
    return 0;
  }
  table(
    ['标题', 'ID'],
    namespaces.map((n) => [n.title, n.id]),
  );
  console.log('');
  log.dim(`共 ${namespaces.length} 个（免费层上限 ${humanNum(FREE_TIER.workers_kv.namespaces.limit)}）`);
  log.dim(`每日写额度 ${humanNum(FREE_TIER.workers_kv.writes.limit)} 次 —— 这是免费层最容易撞墙的一项。`);
  return 0;
}

async function createNs(cf, accountId, flags) {
  const title = flags._[2];
  if (!title) {
    log.err('用法：cfm kv create <标题>');
    return 2;
  }
  if (flags['dry-run']) {
    log.info(`--dry-run：将创建命名空间 ${title}`);
    return 0;
  }
  const res = await cf.request('POST', `/accounts/${accountId}/storage/kv/namespaces`, {
    body: { title },
  });
  log.ok(`已创建：${res.title}`);
  console.log(`\n把下面这行加进 wrangler.toml：\n`);
  console.log(`${color.cyan}[[kv_namespaces]]`);
  console.log(`binding = "${toBinding(title)}"`);
  console.log(`id = "${res.id}"${color.reset}\n`);
  return 0;
}

async function deleteNs(cf, accountId, flags) {
  const id = flags._[2];
  if (!id) {
    log.err('用法：cfm kv delete <namespace-id>');
    return 2;
  }
  log.warn(`将删除命名空间 ${id} 及其全部键值。此操作不可撤销。`);
  if (flags['dry-run']) return 0;
  if (!(await confirm('确认删除？', { force: flags.yes }))) return 0;
  await cf.request('DELETE', `/accounts/${accountId}/storage/kv/namespaces/${id}`);
  log.ok('已删除。');
  return 0;
}

async function listKeys(cf, accountId, flags) {
  const id = flags._[2];
  if (!id) {
    log.err('用法：cfm kv keys <namespace-id> [--prefix p] [--limit 1000]');
    return 2;
  }
  const limit = Math.min(Number(flags.limit ?? 1000), 1000);
  const all = [];
  let cursor = undefined;
  while (all.length < limit) {
    const res = await cf.request('GET', `/accounts/${accountId}/storage/kv/namespaces/${id}/keys`, {
      query: { limit: Math.min(1000, limit - all.length), cursor, prefix: flags.prefix },
    });
    if (!Array.isArray(res) || !res.length) break;
    all.push(...res);
    // Cursor 分页：下一次请求带上上一条 key 名
    if (res.length < 1000) break;
    cursor = res[res.length - 1].name;
  }

  if (flags.json) {
    console.log(JSON.stringify(all, null, 2));
    return 0;
  }
  if (!all.length) {
    log.info('没有匹配的键。');
    return 0;
  }
  table(
    ['键名', '过期时间'],
    all.slice(0, 100).map((k) => [
      k.name.length > 60 ? k.name.slice(0, 57) + '…' : k.name,
      k.expiration ? new Date(k.expiration * 1000).toISOString().slice(0, 19) : '永久',
    ]),
  );
  if (all.length > 100) console.log(`\n… 共 ${all.length} 个键，只显示前 100 个。`);
  log.dim(`注意：list 操作计入每日 lists 额度（${humanNum(FREE_TIER.workers_kv.lists.limit)}/天）与 Class A 操作。`);
  return 0;
}

async function getKey(cf, accountId, flags) {
  const [id, key] = [flags._[2], flags._[3]];
  if (!id || !key) {
    log.err('用法：cfm kv get <namespace-id> <key>');
    return 2;
  }
  const res = await cf.request('GET', `/accounts/${accountId}/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}`);
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(typeof res === 'string' ? res : JSON.stringify(res, null, 2));
  }
  return 0;
}

async function putKey(cf, accountId, flags) {
  const [id, key, value] = [flags._[2], flags._[3], flags._[4]];
  if (!id || !key) {
    log.err('用法：cfm kv put <namespace-id> <key> <value> [--ttl 3600]');
    return 2;
  }
  const body = { value: value ?? '' };
  if (flags.ttl) body.expiration_ttl = Number(flags.ttl);
  if (flags.expiration) {
    const ts = Math.floor(new Date(String(flags.expiration)).getTime() / 1000);
    if (!Number.isFinite(ts)) {
      log.err('--expiration 需要合法的时间格式，如 2026-12-31T00:00:00Z');
      return 2;
    }
    body.expiration = ts;
  }

  const valueBytes = Buffer.byteLength(body.value, 'utf8');
  if (valueBytes > FREE_TIER.workers_kv.value_size.limit * 1024 * 1024) {
    log.err(`值超过 ${FREE_TIER.workers_kv.value_size.limit} MiB 上限。`);
    return 1;
  }
  const keyBytes = Buffer.byteLength(key, 'utf8');
  if (keyBytes > FREE_TIER.workers_kv.key_size.limit) {
    log.err(`键名超过 ${FREE_TIER.workers_kv.key_size.limit} 字节上限。`);
    return 1;
  }

  if (flags['dry-run']) {
    log.info(`--dry-run：将写入 ${key}`);
    return 0;
  }

  await cf.request('PUT', `/accounts/${accountId}/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}`, {
    body,
  });
  log.ok(`已写入 ${key}（${valueBytes} 字节）`);
  log.dim(`本次消耗 1 次写额度。今日剩余写额度无法直接查询，请用 cfm usage 看趋势。`);
  return 0;
}

async function delKey(cf, accountId, flags) {
  const [id, key] = [flags._[2], flags._[3]];
  if (!id || !key) {
    log.err('用法：cfm kv del <namespace-id> <key>');
    return 2;
  }
  if (flags['dry-run']) return 0;
  if (!(await confirm(`确认删除键 ${key}？`, { force: flags.yes }))) return 0;
  await cf.request('DELETE', `/accounts/${accountId}/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}`);
  log.ok('已删除。');
  return 0;
}

/**
 * budget — 写放大分析
 *
 * 免费层 KV 每天只有 1000 次写。用 KV 做「每次请求都写」的计数器，
 * 1000 个访客就把额度打满，之后所有写返回 429。
 * 这个命令帮你算清楚：你的用法能撑住多少流量。
 */
async function budget(cf, accountId, flags) {
  const id = flags._[2];
  if (!id) {
    log.err('用法：cfm kv budget <namespace-id> [--per-request-writes 1] [--daily-requests 5000]');
    return 2;
  }

  log.step('KV 写额度压力分析');

  const totalKeys = await countKeys(cf, accountId, id);
  const dailyWrites = FREE_TIER.workers_kv.writes.limit;
  const dailyReads = FREE_TIER.workers_kv.reads.limit;

  console.log(`\n命名空间 ${color.dim}${id}${color.reset}`);
  console.log(`  当前键数量        ${humanNum(totalKeys)}`);
  console.log(`  免费层每日写额度  ${humanNum(dailyWrites)}`);
  console.log(`  免费层每日读额度  ${humanNum(dailyReads)}`);
  console.log(`  存储上限          ${FREE_TIER.workers_kv.storage.limit} GiB\n`);

  const perReqWrites = Number(flags['per-request-writes'] ?? 1);
  const safeRequests = Math.floor(dailyWrites / Math.max(1, perReqWrites));
  console.log(`${color.bold}写额度能撑住的日请求量${color.reset}`);
  console.log(`  若每次请求写 ${perReqWrites} 次 KV → 最多 ${color.cyan}${humanNum(safeRequests)}${color.reset} 次请求/天`);
  console.log(`  换算：约 ${(safeRequests / 86400).toFixed(2)} QPS 持续写入\n`);

  console.log(`${color.bold}读额度能撑住的日请求量${color.reset}`);
  console.log(`  若每次请求读 1 次 KV → 最多 ${color.cyan}${humanNum(dailyReads)}${color.reset} 次请求/天`);
  console.log(`  换算：约 ${(dailyReads / 86400).toFixed(2)} QPS 持续读取\n`);

  if (flags['daily-requests']) {
    const reqs = Number(flags['daily-requests']);
    const writesNeeded = reqs * perReqWrites;
    const pct = (writesNeeded / dailyWrites) * 100;
    console.log(`${color.bold}你的场景（${humanNum(reqs)} 请求/天）${color.reset}`);
    console.log(`  需要写入 ${humanNum(writesNeeded)} 次 → 占每日额度 ${pct.toFixed(1)}%`);
    if (pct > 100) {
      log.err('超出每日写额度！KV 不适合这个用量。');
    } else if (pct > 70) {
      log.warn('超过 70%，任何流量波动都可能导致写入失败（429）。');
    } else {
      log.ok('余量充足。');
    }
    console.log('');
  }

  console.log(`${color.bold}判断建议${color.reset}`);
  console.log(`  • 写入频率 < 1000 次/天（如配置缓存、特性开关）→ ${color.green}KV 合适${color.reset}`);
  console.log(`  • 写入频繁（计数器、日志、会话、用户状态）→ ${color.yellow}改用 D1${color.reset}（10 万行/天）`);
  console.log(`  • 需要强一致 / 事务 / 实时协作 → ${color.yellow}改用 Durable Objects${color.reset}（免费层可用）`);
  console.log(`  • 纯只读且量大（如静态配置分发）→ KV 读额度有 10 万/天，可以`);
  console.log('');
  log.dim('另注：KV 是最终一致的，写入后全球生效最长可能延迟 60 秒。需要立即一致请别用 KV。');

  return 0;
}

async function countKeys(cf, accountId, id) {
  let total = 0;
  let cursor;
  for (let i = 0; i < 50; i++) {
    const res = await cf.request('GET', `/accounts/${accountId}/storage/kv/namespaces/${id}/keys`, {
      query: { limit: 1000, cursor },
    });
    if (!Array.isArray(res) || !res.length) break;
    total += res.length;
    if (res.length < 1000) break;
    cursor = res[res.length - 1].name;
  }
  return total;
}

function toBinding(title) {
  return title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'KV';
}
