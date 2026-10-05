/**
 * audit — 全账号审计
 *
 * 与 doctor 的区别：
 *   doctor 看单个 zone 的配置是否浪费免费额度（可修复项为主）
 *   audit  看整个账号的资源使用是否合理（有无遗留、有无异常、成本风险）
 *
 * 输出：每个 zone 一行汇总 + 账号级风险清单。
 */

import { log, table, color, humanNum, humanBytes } from '../lib/util.mjs';

export async function run({ client, flags }) {
  const cf = client();

  log.step('账号级资源盘点');

  const accounts = await cf.listAccounts();
  const zones = await cf.listZones();

  const accountId = cf.accountId ?? accounts[0]?.id;
  let scripts = [];
  let kvNs = [];
  let d1Dbs = [];
  let r2Buckets = [];
  let pagesProjects = [];
  let tunnels = [];

  if (accountId) {
    [scripts, kvNs, d1Dbs, r2Buckets, pagesProjects, tunnels] = await Promise.all([
      cf.paginate(`/accounts/${accountId}/workers/scripts`).catch(() => []),
      cf.paginate(`/accounts/${accountId}/storage/kv/namespaces`).catch(() => []),
      cf.paginate(`/accounts/${accountId}/d1/database`).catch(() => []),
      cf.paginate(`/accounts/${accountId}/r2/buckets`).catch(() => []),
      cf.paginate(`/accounts/${accountId}/pages/projects`).catch(() => []),
      cf.paginate(`/accounts/${accountId}/cfd_tunnel`, { query: { is_deleted: false } }).catch(() => []),
    ]);
  }

  // ---------- Zone 汇总 ----------
  log.step(`Zone 盘点（${zones.length} 个）`);

  const zoneRows = [];
  const zoneIssues = [];

  for (const z of zones) {
    const [dns, pageRules, settingsRes] = await Promise.all([
      cf.paginate(`/zones/${z.id}/dns_records`).catch(() => []),
      cf.paginate(`/zones/${z.id}/pagerules`).catch(() => []),
      cf.request('GET', `/zones/${z.id}/settings`).catch(() => []),
    ]);

    const ssl = settingsRes.find((s) => s.id === 'ssl')?.value ?? '?';
    const cacheLevel = settingsRes.find((s) => s.id === 'cache_level')?.value ?? '?';
    const alwaysHttps = settingsRes.find((s) => s.id === 'always_use_https')?.value ?? '?';
    const proxied = dns.filter((r) => r.proxied).length;
    const proxiable = dns.filter((r) => r.proxiable).length;

    zoneRows.push([
      z.name,
      z.plan?.name ?? '-',
      `${dns.length}/200`,
      `${proxied}/${proxiable}`,
      ssl,
      cacheLevel,
      `${pageRules.length}/5`,
    ]);

    // 问题收集
    if (ssl === 'flexible' || ssl === 'off') {
      zoneIssues.push({ zone: z.name, level: 'bad', msg: `SSL=${ssl}（Flexible/off 会导致明文回源或重定向循环）`, fix: `cfm zone set ${z.name} ssl full_strict` });
    }
    if (cacheLevel === 'bypass') {
      zoneIssues.push({ zone: z.name, level: 'bad', msg: '缓存被全局关闭，全部请求回源', fix: `cfm zone set ${z.name} cache_level standard` });
    }
    if (alwaysHttps !== 'on') {
      zoneIssues.push({ zone: z.name, level: 'warn', msg: 'Always Use HTTPS 未开', fix: `cfm zone set ${z.name} always_use_https on` });
    }
    if (proxiable > 0 && proxied < proxiable) {
      zoneIssues.push({
        zone: z.name,
        level: 'warn',
        msg: `${proxiable - proxied} 条可代理记录未走橙云（失去缓存与防护）`,
        fix: `cfm dns proxy ${z.name} --enable`,
      });
    }
    if (dns.length >= 200) {
      zoneIssues.push({ zone: z.name, level: 'bad', msg: 'DNS 记录已达免费层上限 200 条', fix: `cfm dns list ${z.name} 后清理无用记录` });
    }
    if (pageRules.length >= 5) {
      zoneIssues.push({
        zone: z.name,
        level: 'warn',
        msg: '页面规则已用满 5 条',
        fix: `改用 Cache Rules（免费层不限条数）：cfm cache rules ${z.name} --apply static`,
      });
    }
  }

  table(['域名', '套餐', 'DNS', '已代理', 'SSL', '缓存', '页面规则'], zoneRows);

  // ---------- 账号资源 ----------
  if (accountId) {
    log.step('账号资源占用');
    table(
      ['资源', '数量', '免费上限', '占用'],
      [
        ['Worker 脚本', scripts.length, 100, `${((scripts.length / 100) * 100).toFixed(0)}%`],
        ['KV 命名空间', kvNs.length, 1000, `${((kvNs.length / 1000) * 100).toFixed(1)}%`],
        ['D1 数据库', d1Dbs.length, 10, `${((d1Dbs.length / 10) * 100).toFixed(0)}%`],
        ['R2 桶', r2Buckets.length, 1000, `${((r2Buckets.length / 1000) * 100).toFixed(1)}%`],
        ['Pages 项目', pagesProjects.length, '—', '—'],
        ['Tunnel', tunnels.length, '不限', '—'],
      ],
    );

    // R2 实际存储
    if (r2Buckets.length) {
      try {
        const base = 'https://api.cloudflare.com/client/v4/graphql';
        const data = await cf.request('POST', base, {
          body: {
            query: `query($a:String!){viewer{accounts(filter:{accountTag:$a}){r2StorageAdaptiveGroups(limit:100,filter:{}){
              max{payloadSize metadataSize objectCount} dimensions{bucketName}}}}}`,
            variables: { a: accountId },
          },
        });
        const rows = data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups ?? [];
        let bytes = 0;
        let objs = 0;
        for (const r of rows) {
          bytes += (r.max?.payloadSize ?? 0) + (r.max?.metadataSize ?? 0);
          objs += r.max?.objectCount ?? 0;
        }
        const gb = bytes / 1024 ** 3;
        console.log('');
        console.log(
          `${color.bold}R2 存储${color.reset}  ${humanBytes(bytes)} / 10 GB   ${((gb / 10) * 100).toFixed(1)}%   （${humanNum(objs)} 个对象）`,
        );
        if (gb / 10 > 0.7) {
          log.warn('R2 存储超过 70%，考虑设置 lifecycle 规则自动清理：cfm r2 lifecycle <bucket> --expire-days 30');
        }
      } catch {
        /* 忽略 */
      }
    }

    // Tunnel 健康
    if (tunnels.length) {
      const unhealthy = tunnels.filter((t) => (t.connections?.length ?? 0) === 0);
      if (unhealthy.length) {
        console.log('');
        log.warn(`${unhealthy.length} 个 Tunnel 没有活跃连接：${unhealthy.map((t) => t.name).join(', ')}`);
        log.dim('如果这些已经废弃，建议删除以免留下孤儿配置。');
      }
    }
  }

  // ---------- 问题汇总 ----------
  console.log('');
  log.step('发现的问题');

  if (!zoneIssues.length) {
    log.ok('没有发现配置层面的问题。');
  } else {
    const bad = zoneIssues.filter((i) => i.level === 'bad');
    const warn = zoneIssues.filter((i) => i.level === 'warn');

    if (bad.length) {
      console.log(`${color.red}${color.bold}必须修（${bad.length}）${color.reset}`);
      for (const i of bad) {
        console.log(`  ${color.red}✘${color.reset} [${i.zone}] ${i.msg}`);
        console.log(`      ${color.cyan}${i.fix}${color.reset}`);
      }
      console.log('');
    }
    if (warn.length) {
      console.log(`${color.yellow}${color.bold}建议改（${warn.length}）${color.reset}`);
      for (const i of warn) {
        console.log(`  ${color.yellow}⚠${color.reset} [${i.zone}] ${i.msg}`);
        console.log(`      ${color.cyan}${i.fix}${color.reset}`);
      }
    }
  }

  // ---------- JSON 输出 ----------
  if (flags.json) {
    console.log('');
    console.log(
      JSON.stringify(
        {
          zones: zoneRows,
          issues: zoneIssues,
          account: accountId
            ? { scripts: scripts.length, kv: kvNs.length, d1: d1Dbs.length, r2: r2Buckets.length, pages: pagesProjects.length, tunnels: tunnels.length }
            : null,
        },
        null,
        2,
      ),
    );
  }

  console.log('');
  log.dim('提示：本命令只读，不会修改任何配置。修复命令需要你自己执行。');
  return bad_count(zoneIssues) > 0 ? 1 : 0;
}

function bad_count(issues) {
  return issues.filter((i) => i.level === 'bad').length;
}
