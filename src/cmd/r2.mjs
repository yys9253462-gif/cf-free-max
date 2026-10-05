/**
 * r2 — R2 对象存储管理
 *
 * 子命令：
 *   cfm r2 list
 *   cfm r2 create <bucket> [--location wnam|enam|weur|eeur|apac|auto]
 *   cfm r2 usage
 *   cfm r2 cors <bucket> --file cors.json
 *   cfm r2 lifecycle <bucket> --expire-days 30
 *   cfm r2 domain <bucket> --add r2.example.com | --list | --remove <id>
 *   cfm r2 public <bucket> on|off
 *
 * R2 是 Cloudflare 免费层最值钱的产品：10GB 存储 + **出站流量完全免费**。
 * 用它做静态资源/备份/图床，比任何对象存储都省钱。
 */

import fs from 'node:fs';
import { log, table, color, confirm, require_, humanBytes, humanNum } from '../lib/util.mjs';
import { FREE_TIER } from '../lib/quota.mjs';

/** R2 可用的位置提示（jurisdiction / location hint） */
const LOCATIONS = {
  auto: '自动（推荐）',
  wnam: '北美西部',
  enam: '北美东部',
  weur: '西欧',
  eeur: '东欧',
  apac: '亚太',
  oc: '大洋洲',
  sam: '南美',
  afr: '非洲',
  me: '中东',
};

export async function run({ client, flags }) {
  const sub = flags._[1];
  const cf = client();
  const accountId = cf.accountId;
  if (!accountId) {
    log.err('R2 需要账号 ID。请设置 CF_ACCOUNT_ID 或用 --account 指定。');
    log.dim('获取方式：cfm whoami 会列出账号 ID。');
    return 1;
  }

  switch (sub) {
    case 'list':
      return listBuckets(cf, accountId, flags);
    case 'create':
      return createBucket(cf, accountId, flags);
    case 'delete':
      return deleteBucket(cf, accountId, flags);
    case 'usage':
      return showUsage(cf, accountId, flags);
    case 'cors':
      return setCors(cf, accountId, flags);
    case 'lifecycle':
      return setLifecycle(cf, accountId, flags);
    case 'domain':
      return manageDomain(cf, accountId, flags);
    case 'public':
      return togglePublic(cf, accountId, flags);
    case 'metrics':
      return metrics(cf, accountId, flags);
    default:
      log.err(`未知子命令：r2 ${sub ?? '(空)'}`);
      console.log('可用：list / create / delete / usage / cors / lifecycle / domain / public / metrics');
      return 2;
  }
}

async function listBuckets(cf, accountId, flags) {
  const buckets = await cf.paginate(`/accounts/${accountId}/r2/buckets`);
  if (flags.json) {
    console.log(JSON.stringify(buckets, null, 2));
    return 0;
  }
  if (!buckets.length) {
    log.info('还没有 R2 桶。');
    log.dim(`创建：cfm r2 create my-bucket`);
    log.dim('免费层：10GB 存储 + 100 万次 Class A + 1000 万次 Class B，出站流量免费。');
    return 0;
  }
  table(
    ['桶名', '创建时间', '位置', '存储类'],
    buckets.map((b) => [
      b.name,
      (b.creation_date ?? '').slice(0, 10),
      b.location ?? 'auto',
      b.storage_class ?? 'Standard',
    ]),
  );
  console.log('');
  log.dim(`共 ${buckets.length} 个桶（免费层上限 ${humanNum(FREE_TIER.r2.buckets.limit)}）`);
  return 0;
}

async function createBucket(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm r2 create <bucket-name> [--location apac]');
    console.log(`可用位置：${Object.entries(LOCATIONS).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    return 2;
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
    log.err('桶名必须是 3~63 位小写字母、数字或连字符，且首尾为字母数字。');
    return 2;
  }

  const location = flags.location ? String(flags.location) : undefined;
  if (location && !LOCATIONS[location]) {
    log.err(`未知位置：${location}`);
    return 2;
  }

  if (flags['dry-run']) {
    log.info(`--dry-run：将创建桶 ${name}${location ? `（位置 ${location}）` : ''}`);
    return 0;
  }

  try {
    await cf.request('POST', `/accounts/${accountId}/r2/buckets`, {
      body: { name, ...(location ? { locationHint: location } : {}) },
    });
    log.ok(`桶 ${name} 已创建${location ? `（位置提示 ${location}）` : ''}`);
  } catch (e) {
    if (/already exists|10004/i.test(e.message)) {
      log.warn(`桶 ${name} 已存在。`);
      return 0;
    }
    throw e;
  }

  log.dim('位置提示只是「尽量靠近」，不保证数据驻留。');
  log.dim('下一步：cfm r2 domain ' + name + ' --add r2.你的域名');
  return 0;
}

async function deleteBucket(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm r2 delete <bucket>');
    return 2;
  }
  log.warn(`将删除桶 ${name}。桶内有对象时会失败（这是保护机制）。`);
  if (flags['dry-run']) return 0;
  if (!(await confirm('确认删除？', { force: flags.yes }))) return 0;
  await cf.request('DELETE', `/accounts/${accountId}/r2/buckets/${name}`);
  log.ok('已删除。');
  return 0;
}

/**
 * usage — R2 用量与额度占用
 */
async function showUsage(cf, accountId, flags) {
  log.step('采集 R2 用量');

  const buckets = await cf.paginate(`/accounts/${accountId}/r2/buckets`);

  // GraphQL 取存储量
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
  let rows = [];
  try {
    const data = await cf.request('POST', 'https://api.cloudflare.com/client/v4/graphql', {
      body: { query: q, variables: { accountTag: accountId } },
    });
    rows = data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups ?? [];
  } catch (e) {
    log.warn(`存储用量采集失败（${e.message}），只显示桶列表。`);
  }

  const byBucket = new Map();
  let totalBytes = 0;
  let totalObjects = 0;
  for (const r of rows) {
    const bytes = (r.max?.payloadSize ?? 0) + (r.max?.metadataSize ?? 0);
    const objs = r.max?.objectCount ?? 0;
    byBucket.set(r.dimensions?.bucketName ?? '?', { bytes, objs });
    totalBytes += bytes;
    totalObjects += objs;
  }

  // 操作次数
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const opQ = `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2OperationsAdaptiveGroups(
            limit: 100
            filter: { datetime_geq: $since, datetime_leq: $until }
          ) {
            sum { requests }
            dimensions { actionType }
          }
        }
      }
    }`;
  let classA = null;
  let classB = null;
  try {
    const data = await cf.request('POST', 'https://api.cloudflare.com/client/v4/graphql', {
      body: { query: opQ, variables: { accountTag: accountId, since: start.toISOString(), until: now.toISOString() } },
    });
    const opRows = data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups ?? [];
    classA = 0;
    classB = 0;
    for (const r of opRows) {
      const a = (r.dimensions?.actionType ?? '').toLowerCase();
      const n = r.sum?.requests ?? 0;
      if (/(put|post|copy|list|delete|create)/.test(a)) classA += n;
      else if (/(get|head)/.test(a)) classB += n;
    }
  } catch {
    /* 忽略 */
  }

  const limitBytes = FREE_TIER.r2.storage.limit * 1024 ** 3;

  if (flags.json) {
    console.log(JSON.stringify({ totalBytes, totalObjects, classA, classB, buckets: Object.fromEntries(byBucket) }, null, 2));
    return 0;
  }

  console.log('');
  table(
    ['桶名', '对象数', '存储占用'],
    buckets.map((b) => {
      const s = byBucket.get(b.name) ?? { bytes: 0, objs: 0 };
      return [b.name, humanNum(s.objs), humanBytes(s.bytes)];
    }),
  );

  console.log('');
  const pct = (totalBytes / limitBytes) * 100;
  const bar = '█'.repeat(Math.min(20, Math.round(pct / 5))) + '░'.repeat(Math.max(0, 20 - Math.round(pct / 5)));
  console.log(`${color.bold}R2 存储${color.reset}   ${humanBytes(totalBytes)} / 10 GB   ${bar} ${pct.toFixed(1)}%`);
  console.log(`${color.bold}对象总数${color.reset}   ${humanNum(totalObjects)}`);

  if (classA !== null) {
    const apct = (classA / FREE_TIER.r2.class_a.limit) * 100;
    const bpct = (classB / FREE_TIER.r2.class_b.limit) * 100;
    console.log(
      `${color.bold}Class A${color.reset}    ${humanNum(classA)} / ${humanNum(FREE_TIER.r2.class_a.limit)}（写/列表）  ${apct.toFixed(2)}%`,
    );
    console.log(
      `${color.bold}Class B${color.reset}    ${humanNum(classB)} / ${humanNum(FREE_TIER.r2.class_b.limit)}（读）        ${bpct.toFixed(2)}%`,
    );
  }

  console.log('');
  console.log(`${color.green}出站流量：免费且不限量${color.reset} —— 这是 R2 相对 S3 的核心优势。`);
  if (pct > 70) log.warn('存储已超过 70%，注意 10GB 上限。超出部分按 $0.015/GB 计费。');
  return 0;
}

async function setCors(cf, accountId, flags) {
  const bucket = flags._[2];
  if (!bucket) {
    log.err('用法：cfm r2 cors <bucket> --file cors.json');
    return 2;
  }

  let rules;
  if (flags.file) {
    rules = JSON.parse(fs.readFileSync(String(flags.file), 'utf8'));
    if (!Array.isArray(rules)) rules = rules.rules ?? [];
  } else if (flags.origins) {
    const origins = String(flags.origins).split(',').map((s) => s.trim());
    rules = [
      {
        allowed: {
          origins,
          methods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'],
          headers: ['*'],
        },
        exposeHeaders: ['ETag', 'Content-Length'],
        maxAgeSeconds: 3600,
      },
    ];
  } else {
    log.err('需要 --file cors.json 或 --origins "https://a.com,https://b.com"');
    return 2;
  }

  log.step(`为 ${bucket} 设置 CORS（${rules.length} 条规则）`);
  if (flags['dry-run']) {
    console.log(JSON.stringify(rules, null, 2));
    return 0;
  }

  await cf.request('PUT', `/accounts/${accountId}/r2/buckets/${bucket}/cors`, { body: { rules } });
  log.ok('CORS 已更新。');
  log.dim('提示：允许 origins 写 "*" 会允许任何网站直接读你的桶。生产环境请列明域名。');
  return 0;
}

/**
 * lifecycle — 生命周期规则
 * 免费层最实用的省钱手段：自动清理旧对象，让存储不涨到 10GB 以上。
 */
async function setLifecycle(cf, accountId, flags) {
  const bucket = flags._[2];
  if (!bucket) {
    log.err('用法：cfm r2 lifecycle <bucket> --expire-days 30 [--prefix tmp/]');
    return 2;
  }

  const days = Number(require_(flags, 'expire-days', '多少天后删除，如 30'));
  if (!Number.isFinite(days) || days < 1) {
    log.err('--expire-days 必须是正整数。');
    return 2;
  }

  const rule = {
    id: `expire-${days}d${flags.prefix ? '-' + String(flags.prefix).replace(/\W+/g, '') : ''}`,
    enabled: true,
    conditions: { ...(flags.prefix ? { prefix: String(flags.prefix) } : {}) },
    deleteObjectsTransition: {
      condition: { type: 'Age', maxAge: days * 86400 },
    },
  };

  log.step(`为 ${bucket} 设置生命周期规则`);
  console.log(JSON.stringify(rule, null, 2));

  if (flags['dry-run']) {
    log.info('--dry-run：未实际执行。');
    return 0;
  }
  if (!(await confirm('确认应用？', { force: flags.yes }))) return 0;

  await cf.request('PUT', `/accounts/${accountId}/r2/buckets/${bucket}/lifecycle`, {
    body: { rules: [rule] },
  });
  log.ok(`已设置：${days} 天后自动删除${flags.prefix ? `（前缀 ${flags.prefix}）` : ''}。`);
  log.dim('这是防止 R2 存储费超标最有效的机制 —— 让垃圾数据自己消失。');
  return 0;
}

/**
 * domain — 自定义域（把桶挂到自己的域名下）
 */
async function manageDomain(cf, accountId, flags) {
  const bucket = flags._[2];
  if (!bucket) {
    log.err('用法：cfm r2 domain <bucket> --list | --add <hostname> | --remove <domainId>');
    return 2;
  }

  const base = `/accounts/${accountId}/r2/buckets/${bucket}/domains/custom`;

  if (flags.list || (!flags.add && !flags.remove)) {
    const res = await cf.request('GET', `${base}/`);
    const domains = res?.domains ?? res ?? [];
    if (!domains.length) {
      log.info(`${bucket} 还没有自定义域。`);
      log.dim(`添加：cfm r2 domain ${bucket} --add r2.你的域名`);
      return 0;
    }
    table(
      ['域名', '状态', 'ID'],
      domains.map((d) => [d.domain ?? d.name, d.status?.ownership ?? d.status ?? '-', d.id ?? '-']),
    );
    return 0;
  }

  if (flags.add) {
    const hostname = String(flags.add);
    log.step(`把 ${hostname} 绑定到桶 ${bucket}`);
    if (flags['dry-run']) return 0;
    const res = await cf.request('POST', `${base}`, {
      body: { domain: hostname, enabled: true, ...(flags['min-tls'] ? { minTLS: String(flags['min-tls']) } : {}) },
    });
    log.ok(`已添加。状态：${res?.status?.ownership ?? 'pending'}`);
    log.dim('需要在 DNS 里为该域名添加 CNAME（指向桶的 r2.dev 或由 CF 自动配置）。');
    log.dim('证书签发通常需要几分钟。用 --list 查看状态变为 active。');
    return 0;
  }

  if (flags.remove) {
    if (flags['dry-run']) return 0;
    if (!(await confirm(`确认解绑域名？`, { force: flags.yes }))) return 0;
    await cf.request('DELETE', `${base}/${flags.remove}`);
    log.ok('已解绑。');
    return 0;
  }

  return 0;
}

async function togglePublic(cf, accountId, flags) {
  const bucket = flags._[2];
  const action = flags._[3];
  if (!bucket || !['on', 'off', 'status'].includes(action)) {
    log.err('用法：cfm r2 public <bucket> on|off|status');
    return 2;
  }

  const path = `/accounts/${accountId}/r2/buckets/${bucket}/domains/managed`;

  if (action === 'status') {
    const res = await cf.request('GET', path);
    console.log(`${bucket} 公共 r2.dev 域：${res?.enabled ? color.yellow + '已启用' + color.reset : color.green + '未启用' + color.reset}`);
    if (res?.domain) console.log(`  地址：https://${res.domain}`);
    return 0;
  }

  if (flags['dry-run']) return 0;
  await cf.request('PUT', path, { body: { enabled: action === 'on' } });
  log.ok(`r2.dev 公共访问已${action === 'on' ? '启用' : '关闭'}。`);
  if (action === 'on') {
    log.warn('r2.dev 域是共享域名且无缓存，仅适合测试。生产请用自定义域（cfm r2 domain ... --add）。');
  }
  return 0;
}

async function metrics(cf, accountId, flags) {
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
  const data = await cf.request('POST', 'https://api.cloudflare.com/client/v4/graphql', {
    body: { query: q, variables: { accountTag: accountId } },
  });
  const rows = data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups ?? [];
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  table(
    ['桶', '负载字节', '元数据字节', '对象数'],
    rows.map((r) => [
      r.dimensions?.bucketName ?? '?',
      humanBytes(r.max?.payloadSize ?? 0),
      humanBytes(r.max?.metadataSize ?? 0),
      humanNum(r.max?.objectCount ?? 0),
    ]),
  );
  return 0;
}
