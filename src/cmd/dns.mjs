/**
 * dns — DNS 记录批量管理
 *
 * 子命令：
 *   cfm dns list <zone> [--type A] [--proxied] [--json]
 *   cfm dns export <zone> --file dns.json
 *   cfm dns add <zone> --type A --name www --content 1.2.3.4 [--proxied] [--ttl 300]
 *   cfm dns sync <zone> --file dns.json [--prune] [--dry-run]
 *   cfm dns proxy <zone> --enable|--disable [--filter <pattern>]
 *   cfm dns ddns <zone> --name home --ip <newip>
 *
 * 设计要点：
 *  - 免费层每个 zone 200 条记录，sync 前会先检查余量
 *  - 幂等：已存在的同名同类型记录默认跳过（可用 --update 覆盖）
 *  - --prune 危险，必须二次确认
 */

import fs from 'node:fs';
import { log, table, color, confirm, require_ } from '../lib/util.mjs';

const DNS_LIMIT_FREE = 200;

export async function run({ client, flags }) {
  const sub = flags._[1];
  const cf = client();

  switch (sub) {
    case 'list':
      return listRecords(cf, flags);
    case 'export':
      return exportRecords(cf, flags);
    case 'add':
      return addRecord(cf, flags);
    case 'sync':
      return syncRecords(cf, flags);
    case 'proxy':
      return toggleProxy(cf, flags);
    case 'ddns':
      return ddns(cf, flags);
    case 'delete':
      return deleteRecord(cf, flags);
    default:
      log.err(`未知子命令：dns ${sub ?? '(空)'}`);
      console.log('可用：list / export / add / sync / proxy / ddns / delete');
      return 2;
  }
}

async function listRecords(cf, flags) {
  const zone = await cf.resolveZone(require_(flags, '_') ?? flags._[2]);
  let records = await cf.paginate(`/zones/${zone.id}/dns_records`);
  if (flags.type) records = records.filter((r) => r.type === String(flags.type).toUpperCase());
  if (flags.proxied) records = records.filter((r) => r.proxied);
  if (flags['not-proxied']) records = records.filter((r) => !r.proxied);
  if (flags.filter) {
    const re = new RegExp(String(flags.filter), 'i');
    records = records.filter((r) => re.test(r.name));
  }

  if (flags.json) {
    console.log(JSON.stringify(records, null, 2));
    return 0;
  }

  table(
    ['类型', '名称', '内容', '代理', 'TTL', 'ID'],
    records.map((r) => [
      r.type,
      r.name,
      r.content.length > 42 ? r.content.slice(0, 39) + '...' : r.content,
      r.proxied ? `${color.orange ?? ''}橙云${color.reset}` : '灰云',
      r.ttl === 1 ? '自动' : r.ttl,
      r.id.slice(0, 10) + '…',
    ]),
  );
  console.log('');
  log.dim(`共 ${records.length} 条（免费层上限 ${DNS_LIMIT_FREE} 条）`);
  return 0;
}

async function exportRecords(cf, flags) {
  const zoneRef = flags._[2];
  if (!zoneRef) {
    log.err('用法：cfm dns export <zone> [--file out.json]');
    return 2;
  }
  const zone = await cf.resolveZone(zoneRef);
  const records = await cf.paginate(`/zones/${zone.id}/dns_records`);

  // 导出时去掉服务端字段，保留可回灌的最小集
  const clean = records.map((r) => ({
    type: r.type,
    name: r.name,
    content: r.content,
    ttl: r.ttl,
    proxied: r.proxied,
    ...(r.priority !== undefined ? { priority: r.priority } : {}),
    ...(r.comment ? { comment: r.comment } : {}),
  }));

  const out = { zone: zone.name, exportedAt: new Date().toISOString(), records: clean };

  if (flags.file) {
    fs.writeFileSync(flags.file, JSON.stringify(out, null, 2) + '\n', 'utf8');
    log.ok(`已导出 ${clean.length} 条记录到 ${flags.file}`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
  return 0;
}

async function addRecord(cf, flags) {
  const zoneRef = flags._[2];
  if (!zoneRef) {
    log.err('用法：cfm dns add <zone> --type <TYPE> --name <NAME> --content <VALUE> [--proxied] [--ttl 300]');
    return 2;
  }
  const zone = await cf.resolveZone(zoneRef);

  const existing = await cf.paginate(`/zones/${zone.id}/dns_records`);
  if (existing.length >= DNS_LIMIT_FREE) {
    log.err(`DNS 记录已达免费层上限 ${DNS_LIMIT_FREE} 条，无法新增。请先清理无用记录。`);
    return 1;
  }

  const body = {
    type: String(require_(flags, 'type', '如 A / AAAA / CNAME / TXT')).toUpperCase(),
    name: normalizeName(require_(flags, 'name', '如 www 或 @'), zone.name),
    content: require_(flags, 'content', '记录值'),
    ttl: flags.ttl ? Number(flags.ttl) : 1,
    proxied: !!flags.proxied,
  };
  if (flags.priority !== undefined) body.priority = Number(flags.priority);

  // 仅 A/AAAA/CNAME 支持橙云
  if (!['A', 'AAAA', 'CNAME'].includes(body.type)) body.proxied = false;

  const dup = existing.find((r) => r.type === body.type && r.name === body.name && r.content === body.content);
  if (dup) {
    log.warn(`记录已存在（${body.type} ${body.name} → ${body.content}），跳过。`);
    return 0;
  }

  if (flags['dry-run']) {
    log.info(`--dry-run：将创建 ${body.type} ${body.name} → ${body.content}`);
    return 0;
  }

  const rec = await cf.request('POST', `/zones/${zone.id}/dns_records`, { body });
  log.ok(`已创建 ${rec.type} ${rec.name} → ${rec.content}${rec.proxied ? ' （橙云）' : ''}`);
  return 0;
}

/**
 * sync — 以文件为准同步 DNS。
 * 默认只增不改不删；--update 允许更新差异；--prune 允许删除多余记录。
 */
async function syncRecords(cf, flags) {
  const zoneRef = flags._[2];
  const file = require_(flags, 'file', 'JSON 文件路径');
  if (!zoneRef) {
    log.err('用法：cfm dns sync <zone> --file dns.json [--update] [--prune] [--dry-run]');
    return 2;
  }
  const zone = await cf.resolveZone(zoneRef);

  const desired = JSON.parse(fs.readFileSync(file, 'utf8'));
  const want = Array.isArray(desired) ? desired : desired.records;
  if (!Array.isArray(want) || !want.length) {
    log.err('文件中没有 records 数组。');
    return 1;
  }

  const current = await cf.paginate(`/zones/${zone.id}/dns_records`);
  const key = (r) => `${r.type}|${normalizeName(r.name, zone.name)}`;
  const curMap = new Map(current.map((r) => [key(r), r]));

  const toCreate = [];
  const toUpdate = [];
  const seen = new Set();

  for (const w of want) {
    const k = key(w);
    seen.add(k);
    const cur = curMap.get(k);
    if (!cur) {
      toCreate.push(w);
    } else if (cur.content !== w.content || (w.proxied !== undefined && cur.proxied !== w.proxied)) {
      toUpdate.push({ cur, want: w });
    }
  }

  const toPrune = flags.prune ? current.filter((r) => !seen.has(key(r))) : [];

  log.step('同步计划');
  console.log(`  新增 ${toCreate.length} 条`);
  console.log(`  更新 ${toUpdate.length} 条${flags.update ? '' : color.dim + '（未启用 --update，将跳过）' + color.reset}`);
  console.log(`  删除 ${toPrune.length} 条${flags.prune ? '' : color.dim + '（未启用 --prune）' + color.reset}`);

  const projected = current.length + toCreate.length;
  if (projected > DNS_LIMIT_FREE) {
    log.err(`同步后记录数将达 ${projected} 条，超过免费层上限 ${DNS_LIMIT_FREE}。已中止。`);
    return 1;
  }

  if (flags['dry-run']) {
    for (const c of toCreate) console.log(`  ${color.green}+${color.reset} ${c.type} ${c.name} → ${c.content}`);
    for (const u of toUpdate) console.log(`  ${color.yellow}~${color.reset} ${u.cur.type} ${u.cur.name}: ${u.cur.content} → ${u.want.content}`);
    for (const p of toPrune) console.log(`  ${color.red}-${color.reset} ${p.type} ${p.name} → ${p.content}`);
    log.info('--dry-run：未实际执行。');
    return 0;
  }

  if (!(await confirm(`确认执行同步？`, { force: flags.yes }))) return 0;

  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const c of toCreate) {
    const body = {
      type: String(c.type).toUpperCase(),
      name: normalizeName(c.name, zone.name),
      content: c.content,
      ttl: c.ttl ?? 1,
      proxied: ['A', 'AAAA', 'CNAME'].includes(String(c.type).toUpperCase()) ? !!c.proxied : false,
    };
    if (c.priority !== undefined) body.priority = c.priority;
    try {
      await cf.request('POST', `/zones/${zone.id}/dns_records`, { body });
      created++;
    } catch (e) {
      log.err(`创建 ${body.name} 失败：${e.message}`);
    }
  }

  if (flags.update) {
    for (const u of toUpdate) {
      const body = { ...u.want, name: normalizeName(u.want.name, zone.name) };
      delete body.id;
      try {
        await cf.request('PUT', `/zones/${zone.id}/dns_records/${u.cur.id}`, { body });
        updated++;
      } catch (e) {
        log.err(`更新 ${u.cur.name} 失败：${e.message}`);
      }
    }
  }

  if (flags.prune && toPrune.length) {
    log.warn(`即将删除 ${toPrune.length} 条记录：`);
    for (const p of toPrune.slice(0, 10)) console.log(`  ${p.type} ${p.name} → ${p.content}`);
    if (toPrune.length > 10) console.log(`  … 等共 ${toPrune.length} 条`);
    if (await confirm('确认删除？此操作不可撤销。', { force: flags.yes })) {
      for (const p of toPrune) {
        try {
          await cf.request('DELETE', `/zones/${zone.id}/dns_records/${p.id}`);
          deleted++;
        } catch (e) {
          log.err(`删除 ${p.name} 失败：${e.message}`);
        }
      }
    }
  }

  log.step(`完成：新增 ${created} / 更新 ${updated} / 删除 ${deleted}`);
  return 0;
}

/**
 * proxy — 批量切换橙云开关。
 * 用于把「忘开代理导致回源打满」的记录一次性修好。
 */
async function toggleProxy(cf, flags) {
  const zoneRef = flags._[2];
  if (!zoneRef) {
    log.err('用法：cfm dns proxy <zone> --enable|--disable [--filter <regex>]');
    return 2;
  }
  const enable = !!flags.enable;
  const disable = !!flags.disable;
  if (enable === disable) {
    log.err('必须且只能指定 --enable 或 --disable 之一。');
    return 2;
  }

  const zone = await cf.resolveZone(zoneRef);
  let records = (await cf.paginate(`/zones/${zone.id}/dns_records`)).filter((r) => r.proxiable);
  if (flags.filter) {
    const re = new RegExp(String(flags.filter), 'i');
    records = records.filter((r) => re.test(r.name));
  }
  const targets = records.filter((r) => r.proxied !== enable);

  if (!targets.length) {
    log.ok('没有需要修改的记录。');
    return 0;
  }

  log.step(`将${enable ? '开启' : '关闭'} ${targets.length} 条记录的橙云代理：`);
  for (const t of targets.slice(0, 20)) console.log(`  ${t.type} ${t.name}`);
  if (targets.length > 20) console.log(`  … 等共 ${targets.length} 条`);

  if (enable) {
    log.warn('开启橙云后，若源站未配置 Cloudflare 兼容的证书或未放行 CF 回源 IP，站点可能短暂不可用。');
  }

  if (flags['dry-run']) {
    log.info('--dry-run：未实际执行。');
    return 0;
  }
  if (!(await confirm('确认执行？', { force: flags.yes }))) return 0;

  let n = 0;
  for (const t of targets) {
    try {
      await cf.request('PATCH', `/zones/${zone.id}/dns_records/${t.id}`, { body: { proxied: enable } });
      n++;
    } catch (e) {
      log.err(`${t.name} 失败：${e.message}`);
    }
  }
  log.ok(`已修改 ${n} 条。`);
  log.dim('提示：橙云变更通常 1~2 分钟内全球生效。');
  return 0;
}

/**
 * ddns — 动态 DNS 更新（家用宽带 IP 变化时调用）。
 * 幂等：IP 未变则不发请求。
 */
async function ddns(cf, flags) {
  const zoneRef = flags._[2];
  const name = require_(flags, 'name', '记录名，如 home');
  if (!zoneRef) {
    log.err('用法：cfm dns ddns <zone> --name home [--ip 1.2.3.4]');
    return 2;
  }
  const zone = await cf.resolveZone(zoneRef);

  let ip = flags.ip;
  if (!ip) {
    // 自动探测公网 IP
    try {
      const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) });
      ip = (await r.json()).ip;
    } catch {
      log.err('无法自动获取公网 IP，请用 --ip 显式指定。');
      return 1;
    }
  }

  const fqdn = normalizeName(name, zone.name);
  const records = await cf.paginate(`/zones/${zone.id}/dns_records`, { query: { name: fqdn } });
  const rec = records.find((r) => r.type === 'A');

  if (!rec) {
    log.warn(`记录 ${fqdn} 不存在，将创建。`);
    if (flags['dry-run']) return 0;
    const created = await cf.request('POST', `/zones/${zone.id}/dns_records`, {
      body: { type: 'A', name: fqdn, content: ip, ttl: 60, proxied: false },
    });
    log.ok(`已创建 ${created.name} → ${ip}`);
    return 0;
  }

  if (rec.content === ip) {
    log.ok(`IP 未变化（${ip}），无需更新。`);
    log.dim('提示：动态 IP 建议把 TTL 设为 60 秒，且关闭橙云（DDNS 场景直连更可靠）。');
    return 0;
  }

  if (flags['dry-run']) {
    log.info(`--dry-run：将把 ${fqdn} 从 ${rec.content} 改为 ${ip}`);
    return 0;
  }

  await cf.request('PATCH', `/zones/${zone.id}/dns_records/${rec.id}`, { body: { content: ip } });
  log.ok(`${fqdn}: ${rec.content} → ${ip}`);
  return 0;
}

async function deleteRecord(cf, flags) {
  const zoneRef = flags._[2];
  const id = require_(flags, 'id', '记录 ID，用 dns list 获取');
  if (!zoneRef) {
    log.err('用法：cfm dns delete <zone> --id <recordId>');
    return 2;
  }
  const zone = await cf.resolveZone(zoneRef);
  const rec = await cf.request('GET', `/zones/${zone.id}/dns_records/${id}`);
  log.warn(`将删除：${rec.type} ${rec.name} → ${rec.content}`);
  if (flags['dry-run']) return 0;
  if (!(await confirm('确认删除？', { force: flags.yes }))) return 0;
  await cf.request('DELETE', `/zones/${zone.id}/dns_records/${id}`);
  log.ok('已删除。');
  return 0;
}

/** 把 @ 或裸名规范化成 FQDN */
function normalizeName(name, zoneName) {
  const n = String(name).trim();
  if (n === '@' || n === zoneName) return zoneName;
  if (n.endsWith('.' + zoneName) || n === zoneName) return n;
  return `${n}.${zoneName}`;
}
