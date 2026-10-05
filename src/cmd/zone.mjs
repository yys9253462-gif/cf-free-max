/**
 * zone — zone 级设置管理
 *
 * 子命令：
 *   cfm zone list
 *   cfm zone show <zone>
 *   cfm zone set <zone> <setting> <value> [<setting> <value> ...]
 *   cfm zone harden <zone> [--with-hsts] [--dry-run]
 */

import { log, table, color, confirm, humanBytes } from '../lib/util.mjs';

/** 允许被 set 的设置在免费层有效，且不会造成不可逆后果 */
const SAFE_SETTINGS = new Set([
  'ssl',
  'always_use_https',
  'brotli',
  '0rtt',
  'http2',
  'http3',
  'min_tls_version',
  'tls_1_3',
  'cache_level',
  'browser_cache_ttl',
  'development_mode',
  'rocket_loader',
  'mirage',
  'polish',
  'websockets',
  'opportunistic_encryption',
  'automatic_https_rewrites',
  'ipv6',
  'security_header',
  'pseudo_ipv4',
  'server_side_exclude',
  'email_obfuscation',
]);

export async function run({ client, flags }) {
  const sub = flags._[1] ?? 'list';
  const cf = client();

  switch (sub) {
    case 'list':
      return listZones(cf);
    case 'show':
      return showZone(cf, flags._[2]);
    case 'set':
      return setSettings(cf, flags);
    case 'harden':
      return harden(cf, flags);
    default:
      log.err(`未知子命令：zone ${sub}`);
      console.log('可用：list / show / set / harden');
      return 2;
  }
}

async function listZones(cf) {
  const zones = await cf.listZones();
  table(
    ['域名', 'Zone ID', '套餐', '状态', '创建时间'],
    zones.map((z) => [z.name, z.id, z.plan?.name ?? '-', z.status, (z.created_on ?? '').slice(0, 10)]),
  );
  return 0;
}

async function showZone(cf, ref) {
  if (!ref) {
    log.err('用法：cfm zone show <zone>');
    return 2;
  }
  const zone = await cf.resolveZone(ref);
  const settings = await cf.request('GET', `/zones/${zone.id}/settings`);
  console.log(`\n${color.bold}${zone.name}${color.reset}  ${color.dim}${zone.id}${color.reset}\n`);
  table(
    ['设置', '值', '可修改'],
    settings
      .filter((s) => s.editable !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => [s.id, formatValue(s.value), s.editable ? '是' : '否']),
  );
  return 0;
}

function formatValue(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function setSettings(cf, flags) {
  const zoneRef = flags._[2];
  const pairs = flags._.slice(3);
  if (!zoneRef || pairs.length < 2) {
    log.err('用法：cfm zone set <zone> <setting> <value> [<setting> <value> ...]');
    console.log(`例如：cfm zone set example.com ssl full_strict brotli on`);
    return 2;
  }
  if (pairs.length % 2 !== 0) {
    log.err('设置项必须成对出现：<setting> <value>');
    return 2;
  }

  const zone = await cf.resolveZone(zoneRef);
  const changes = [];
  for (let i = 0; i < pairs.length; i += 2) {
    changes.push({ id: pairs[i], value: coerce(pairs[i + 1]) });
  }

  const unknown = changes.filter((c) => !SAFE_SETTINGS.has(c.id));
  if (unknown.length) {
    log.warn(`以下设置在允许列表之外，仍会尝试（部分需付费套餐）：${unknown.map((u) => u.id).join(', ')}`);
  }

  log.step(`将修改 ${zone.name}：`);
  for (const c of changes) console.log(`  ${c.id} → ${color.cyan}${formatValue(c.value)}${color.reset}`);

  if (flags['dry-run']) {
    log.info('--dry-run：未实际执行。');
    return 0;
  }
  if (!(await confirm(`确认修改 ${changes.length} 项设置？`, { force: flags.yes }))) {
    log.info('已取消。');
    return 0;
  }

  for (const c of changes) {
    try {
      await cf.request('PATCH', `/zones/${zone.id}/settings/${c.id}`, { body: { value: c.value } });
      log.ok(`${c.id} = ${formatValue(c.value)}`);
    } catch (e) {
      log.err(`${c.id} 失败：${e.message}${e.hint ? `（${e.hint}）` : ''}`);
    }
  }
  return 0;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * harden — 一键打开全部免费加速与安全项。
 * 注意 HSTS 默认不开，因为它不可逆（浏览器会记住）。
 */
async function harden(cf, flags) {
  const ref = flags._[2];
  if (!ref) {
    log.err('用法：cfm zone harden <zone> [--with-hsts] [--dry-run]');
    return 2;
  }
  const zone = await cf.resolveZone(ref);

  const plan = [
    { id: 'always_use_https', value: 'on' },
    { id: 'brotli', value: 'on' },
    { id: 'http2', value: 'on' },
    { id: 'http3', value: 'on' },
    { id: 'tls_1_3', value: 'on' },
    { id: 'min_tls_version', value: '1.2' },
    { id: 'opportunistic_encryption', value: 'on' },
    { id: 'automatic_https_rewrites', value: 'on' },
    { id: 'websockets', value: 'on' },
    { id: 'ipv6', value: 'on' },
    { id: 'rocket_loader', value: 'off' }, // 会破坏部分 JS，默认关
    { id: '0rtt', value: 'on' },
  ];

  if (flags['with-hsts']) {
    plan.push({
      id: 'security_header',
      value: {
        strict_transport_security: {
          enabled: true,
          max_age: 86400, // 先用 1 天试水，确认无问题再调大
          include_subdomains: false,
          preload: false,
          nosniff: true,
        },
      },
    });
  }

  log.step(`加固 ${zone.name}（${plan.length} 项）`);
  for (const p of plan) console.log(`  ${p.id} → ${color.cyan}${formatValue(p.value)}${color.reset}`);

  const cacheLevel = await cf
    .request('GET', `/zones/${zone.id}/settings/cache_level`)
    .then((r) => r.value)
    .catch(() => null);
  if (cacheLevel === 'bypass') {
    log.warn('检测到缓存被全局关闭，将一并改为 standard。');
    plan.push({ id: 'cache_level', value: 'standard' });
  }

  if (flags['with-hsts']) {
    log.warn('HSTS 已启用，max_age=1 天。确认站点全子域证书有效后，可用 `cfm zone set ' + zone.name + ' security_header ...` 调大。');
  }

  if (flags['dry-run']) {
    log.info('--dry-run：未实际执行。');
    return 0;
  }
  if (!(await confirm(`确认加固 ${zone.name}？`, { force: flags.yes }))) return 0;

  let okCount = 0;
  for (const p of plan) {
    try {
      await cf.request('PATCH', `/zones/${zone.id}/settings/${p.id}`, { body: { value: p.value } });
      log.ok(`${p.id} 已设置`);
      okCount++;
    } catch (e) {
      log.err(`${p.id} 失败：${e.message}${e.hint ? ` ↳ ${e.hint}` : ''}`);
    }
  }
  log.step(`完成：${okCount}/${plan.length} 项成功`);
  return okCount === plan.length ? 0 : 1;
}
