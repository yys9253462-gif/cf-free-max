/**
 * 用量采集：通过 GraphQL Analytics + REST 拉取各产品的真实消耗，
 * 算出「距免费上限还剩多少」。
 *
 * 这是本仓库的核心价值：免费额度不是靠猜，是靠读。
 * Cloudflare 控制台不给你一个统一的「还剩多少」，这里把它做出来。
 */

import { log, table, color, humanNum, humanBytes, req_ } from '../lib/util.mjs';
import { FREE_TIER } from '../lib/quota.mjs';
import { CFClient } from '../lib/cf.mjs';

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

/**
 * 执行 GraphQL 查询。
 * @param {CFClient} cf
 * @param {string} query
 * @param {Record<string, any>} variables
 */
async function gql(cf, query, variables) {
  const res = await cf.request('POST', GRAPHQL, { body: { query, variables } });
  return res;
}

// ---------- 各产品用量采集 ----------

/** Workers 请求数（按天） */
async function workersUsage(cf, accountId) {
  const until = new Date();
  const since = new Date(until.getTime() - 24 * 3600 * 1000);
  const q = `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            limit: 100
            filter: { datetime_geq: $since, datetime_leq: $until }
          ) {
            sum { requests errors subrequests }
            dimensions { scriptName }
          }
        }
      }
    }`;
  try {
    const data = await gql(cf, q, {
      accountTag: accountId,
      since: since.toISOString(),
      until: until.toISOString(),
    });
    const rows = data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    const total = rows.reduce((a, r) => a + (r.sum?.requests ?? 0), 0);
    return { total, rows: rows.map((r) => ({ name: r.dimensions?.scriptName ?? '?', requests: r.sum?.requests ?? 0 })) };
  } catch (e) {
    return { total: null, rows: [], error: e.message };
  }
}

/** KV 每日读写 */
async function kvUsage(cf, accountId) {
  // KV 用量走 GraphQL 的 kvOperationsAdaptiveGroups
  const until = new Date();
  const since = new Date(until.getTime() - 24 * 3600 * 1000);
  const q = `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          kvOperationsAdaptiveGroups(
            limit: 100
            filter: { datetime_geq: $since, datetime_leq: $until }
          ) {
            count
            sum { requests }
            dimensions { actionType }
          }
        }
      }
    }`;
  try {
    const data = await gql(cf, q, {
      accountTag: accountId,
      since: since.toISOString(),
      until: until.toISOString(),
    });
    const rows = data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups ?? [];
    const byAction = {};
    for (const r of rows) {
      const a = r.dimensions?.actionType ?? 'unknown';
      byAction[a] = (byAction[a] ?? 0) + (r.sum?.requests ?? r.count ?? 0);
    }
    return { byAction };
  } catch (e) {
    return { byAction: {}, error: e.message };
  }
}

/** R2 存储与操作 */
async function r2Usage(cf, accountId) {
  const q = `
    query($accountTag: String!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2StorageAdaptiveGroups(limit: 100, filter: {}) {
            max { payloadSize metadataSize objectCount }
            dimensions { bucketName }
          }
        }
      }
    }`;
  try {
    const data = await gql(cf, q, { accountTag: accountId });
    const rows = data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups ?? [];
    let bytes = 0;
    let objects = 0;
    for (const r of rows) {
      bytes += (r.max?.payloadSize ?? 0) + (r.max?.metadataSize ?? 0);
      objects += r.max?.objectCount ?? 0;
    }
    return { bytes, objects, buckets: rows.length };
  } catch (e) {
    return { bytes: null, objects: null, buckets: null, error: e.message };
  }
}

/** D1 用量 */
async function d1Usage(cf, accountId) {
  const until = new Date();
  const since = new Date(until.getTime() - 24 * 3600 * 1000);
  const q = `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          d1AnalyticsAdaptiveGroups(
            limit: 100
            filter: { datetime_geq: $since, datetime_leq: $until }
          ) {
            sum { rowsRead rowsWritten readQueries writeQueries }
            dimensions { databaseId }
          }
        }
      }
    }`;
  try {
    const data = await gql(cf, q, {
      accountTag: accountId,
      since: since.toISOString(),
      until: until.toISOString(),
    });
    const rows = data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
    const sum = { rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
    for (const r of rows) {
      sum.rowsRead += r.sum?.rowsRead ?? 0;
      sum.rowsWritten += r.sum?.rowsWritten ?? 0;
      sum.readQueries += r.sum?.readQueries ?? 0;
      sum.writeQueries += r.sum?.writeQueries ?? 0;
    }
    return sum;
  } catch (e) {
    return { rowsRead: null, rowsWritten: null, error: e.message };
  }
}

// ---------- 主流程 ----------

/**
 * 主入口。
 * 用法：cfm usage [--json] [--zone <name>]
 */
export async function run({ client, flags }) {
  const cf = client();

  // 确定 accountId
  let accountId = cf.accountId;
  if (!accountId) {
    const accounts = await cf.listAccounts();
    if (accounts.length === 1) {
      accountId = accounts[0].id;
    } else if (accounts.length === 0) {
      log.err('无法确定账号 ID。请设置 CF_ACCOUNT_ID。');
      return 1;
    } else {
      log.err(`有多个账号，请用 --account 或 CF_ACCOUNT_ID 指定：`);
      for (const a of accounts) console.log(`  ${a.name}  ${a.id}`);
      return 1;
    }
  }

  log.step(`采集账号用量：${color.dim}${accountId}${color.reset}`);

  const [workers, kv, r2, d1] = await Promise.all([
    workersUsage(cf, accountId),
    kvUsage(cf, accountId),
    r2Usage(cf, accountId),
    d1Usage(cf, accountId),
  ]);

  if (flags.json) {
    console.log(JSON.stringify({ accountId, workers, kv, r2, d1 }, null, 2));
    return 0;
  }

  const report = [];

  // Workers
  if (workers.total !== null) {
    report.push(makeRow('Workers 请求（24h）', workers.total, FREE_TIER.workers.requests.limit, 'requests'));
  } else {
    report.push(['Workers 请求（24h）', '采集失败', '—', workers.error ?? '']);
  }

  // KV
  const kvDaily = FREE_TIER.workers_kv;
  if (!kv.error) {
    const reads = kv.byAction.read ?? kv.byAction.readKey ?? 0;
    const writes = kv.byAction.write ?? kv.byAction.writeKey ?? 0;
    report.push(makeRow('KV 读（24h）', reads, kvDaily.reads.limit, 'ops'));
    report.push(makeRow('KV 写（24h）', writes, kvDaily.writes.limit, 'ops'));
  } else {
    report.push(['KV 读/写（24h）', '采集失败', '—', kv.error]);
  }

  // D1
  if (d1.rowsRead !== null) {
    report.push(makeRow('D1 扫描行（24h）', d1.rowsRead, FREE_TIER.workers_d1.rows_read.limit, 'rows'));
    report.push(makeRow('D1 写入行（24h）', d1.rowsWritten, FREE_TIER.workers_d1.rows_written.limit, 'rows'));
  } else {
    report.push(['D1 行数（24h）', '采集失败', '—', d1.error ?? '']);
  }

  // R2
  if (r2.bytes !== null) {
    report.push([
      'R2 存储',
      humanBytes(r2.bytes),
      `10 GB (${((r2.bytes / (10 * 1024 ** 3)) * 100).toFixed(1)}%)`,
      `${r2.buckets} 个桶 / ${humanNum(r2.objects)} 对象`,
    ]);
  } else {
    report.push(['R2 存储', '采集失败', '—', r2.error ?? '']);
  }

  table(['指标', '已用', '免费上限（占用）', '备注'], report);

  // 高水位提醒
  const warnLines = [];
  for (const r of report) {
    const pctStr = String(r[2]);
    const m = pctStr.match(/\((\d+(?:\.\d+)?)%\)/);
    if (m && Number(m[1]) >= 70) warnLines.push(`${r[0]} 已用 ${m[1]}%`);
  }
  if (warnLines.length) {
    console.log('');
    log.warn('接近上限，请注意：');
    for (const l of warnLines) console.log(`  • ${l}`);
  }

  console.log('');
  log.dim('提示：GraphQL Analytics 有 1~5 分钟延迟。Workers/KV/D1 的日额度按 UTC 00:00 重置。');
  log.dim('更多踩坑参见 `cfm quota --pitfalls`。');

  return 0;
}

/**
 * 构造一行用量报告。
 * @param {string} label
 * @param {number} used
 * @param {number} limit
 * @param {string} unit
 */
function makeRow(label, used, limit, unit) {
  const pct = limit ? (used / limit) * 100 : 0;
  const bar = meter(pct);
  return [label, `${humanNum(used)} ${unit}`, `${humanNum(limit)} ${bar} ${pct.toFixed(1)}%`, ''];
}

/** 简易进度条 */
function meter(pct) {
  const filled = Math.min(10, Math.round(pct / 10));
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  if (pct >= 90) return `${color.red}${bar}${color.reset}`;
  if (pct >= 70) return `${color.yellow}${bar}${color.reset}`;
  return `${color.green}${bar}${color.reset}`;
}
