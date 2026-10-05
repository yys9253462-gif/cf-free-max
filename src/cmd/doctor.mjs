/**
 * doctor — 免费额度体检
 *
 * 逐项检查那些「悄悄吃掉你免费额度」的配置。
 * 每条检查给出：现状 / 判断 / 修复建议 / 一键修复命令。
 *
 * 设计原则：只读。doctor 本身绝不修改任何东西，
 * 修复动作必须以显式命令由用户执行。
 */

import { log, table, color, humanNum } from '../lib/util.mjs';

/** @typedef {{id:string, title:string, status:'ok'|'warn'|'bad'|'skip', detail:string, fix?:string}} Finding */

export async function run({ client, flags }) {
  const cf = client();
  const zones = await cf.listZones();
  if (!zones.length) {
    log.err('没有可检查的 zone。');
    return 1;
  }

  const only = flags.zone;
  const targets = only ? zones.filter((z) => z.name === only) : zones;
  if (only && !targets.length) {
    log.err(`找不到 zone：${only}`);
    return 1;
  }

  /** @type {Finding[]} */
  const findings = [];

  for (const z of targets) {
    log.step(`${z.name}`);
    const zoneFindings = await inspectZone(cf, z);
    findings.push(...zoneFindings);
    renderFindings(zoneFindings);
  }

  const bad = findings.filter((f) => f.status === 'bad');
  const warn = findings.filter((f) => f.status === 'warn');

  console.log('');
  log.step('体检结论');
  console.log(`  ${color.red}✘ 必须修${color.reset}  ${bad.length}`);
  console.log(`  ${color.yellow}⚠ 建议看${color.reset}  ${warn.length}`);
  console.log(`  ${color.green}✔ 正常${color.reset}    ${findings.filter((f) => f.status === 'ok').length}`);
  console.log(`  ${color.dim}− 跳过${color.reset}    ${findings.filter((f) => f.status === 'skip').length}`);

  if (bad.length) {
    console.log('');
    log.warn('必须修的项会直接影响站点可用性或直接烧额度：');
    for (const f of bad) console.log(`  • [${f.id}] ${f.detail}`);
  }

  return bad.length ? 1 : 0;
}

/**
 * 检查单个 zone。
 * @param {import('../lib/cf.mjs').CFClient} cf
 * @param {any} zone
 * @returns {Promise<Finding[]>}
 */
async function inspectZone(cf, zone) {
  const zid = zone.id;
  const out = [];

  // 并行拉取各项设置
  const [settings, dnsRecords, rulesets, pageRules] = await Promise.all([
    cf.request('GET', `/zones/${zid}/settings`).catch(() => []),
    cf.paginate(`/zones/${zid}/dns_records`).catch(() => []),
    cf.request('GET', `/zones/${zid}/rulesets`).catch(() => []),
    cf.paginate(`/zones/${zid}/pagerules`).catch(() => []),
  ]);

  const get = (name) => settings.find((s) => s.id === name)?.value;

  // 1. SSL 模式
  const ssl = get('ssl');
  if (ssl === 'off') {
    out.push({
      id: 'ssl-off',
      title: 'SSL 已关闭',
      status: 'bad',
      detail: 'SSL 模式为 off，全站明文传输。既是安全问题，也让 Cloudflare 无法做缓存优化。',
      fix: `cfm zone set ${zone.name} ssl full_strict`,
    });
  } else if (ssl === 'flexible') {
    out.push({
      id: 'ssl-flexible',
      title: 'SSL 模式为 Flexible',
      status: 'bad',
      detail:
        'Flexible 意味着 Cloudflare→源站是明文。会导致重定向死循环，且源站流量未加密。' +
        '这是最常见的「站点偶尔打不开」根因。',
      fix: `cfm zone set ${zone.name} ssl full_strict   # 源站需先有有效证书`,
    });
  } else if (ssl === 'full' || ssl === 'full_strict') {
    out.push({
      id: 'ssl-ok',
      title: `SSL 模式=${ssl}`,
      status: 'ok',
      detail: '端到端加密，正常。',
    });
  } else {
    out.push({ id: 'ssl-unknown', title: `SSL 模式=${ssl ?? '未知'}`, status: 'skip', detail: '需要更高权限才能读取该项。' });
  }

  // 2. Always Use HTTPS
  const auh = get('always_use_https');
  out.push(
    auh === 'on'
      ? { id: 'always-https', title: 'Always Use HTTPS 已开', status: 'ok', detail: 'HTTP 自动跳转 HTTPS。' }
      : {
          id: 'always-https',
          title: 'Always Use HTTPS 未开',
          status: 'warn',
          detail: '用户可能以明文访问，且同一份内容会以 http/https 两个 key 分别缓存，浪费缓存空间与回源。',
          fix: `cfm zone set ${zone.name} always_use_https on`,
        },
  );

  // 3. Brotli 压缩
  const brotli = get('brotli');
  out.push(
    brotli === 'on'
      ? { id: 'brotli', title: 'Brotli 已开', status: 'ok', detail: '文本资源压缩率优于 gzip。' }
      : {
          id: 'brotli',
          title: 'Brotli 未开',
          status: 'warn',
          detail: '免费层可开。开启后 HTML/CSS/JS 体积平均小 15~20%，直接省下带宽与回源。',
          fix: `cfm zone set ${zone.name} brotli on`,
        },
  );

  // 4. 0-RTT
  const ortt = get('0rtt');
  if (ortt !== undefined) {
    out.push(
      ortt === 'on'
        ? { id: '0rtt', title: '0-RTT 已开', status: 'ok', detail: '重复连接的 TLS 握手被省掉。' }
        : {
            id: '0rtt',
            title: '0-RTT 未开',
            status: 'warn',
            detail: '对回访用户可降低首字节时间。注意：0-RTT 请求不可重放，仅对幂等 GET 安全。',
            fix: `cfm zone set ${zone.name} 0rtt on`,
          },
    );
  }

  // 5. HSTS
  const hsts = get('security_header');
  const hstsOn = hsts?.strict_transport_security?.enabled;
  if (hstsOn) {
    out.push({ id: 'hsts', title: 'HSTS 已开', status: 'ok', detail: '浏览器强制 HTTPS。' });
  } else {
    out.push({
      id: 'hsts',
      title: 'HSTS 未开',
      status: 'warn',
      detail:
        'HSTS 未开。⚠️ 开启前必须确认所有子域都有有效证书，否则可能把自己锁在门外。' +
        '建议先用 max_age 较小的值试水。',
      fix: `cfm zone harden ${zone.name} --with-hsts`,
    });
  }

  // 6. 缓存级别
  const cacheLevel = get('cache_level');
  if (cacheLevel === 'bypass') {
    out.push({
      id: 'cache-bypass',
      title: '缓存被全局关闭',
      status: 'bad',
      detail: '缓存级别 = bypass，所有请求都回源。这会让源站承担全部流量，也浪费了 Cloudflare 最大的免费能力。',
      fix: `cfm zone set ${zone.name} cache_level standard`,
    });
  } else if (cacheLevel) {
    out.push({ id: 'cache-level', title: `缓存级别=${cacheLevel}`, status: 'ok', detail: '正常。' });
  }

  // 7. 缓存 TTL 与 Browser TTL
  const edgeTtl = get('edge_cache_ttl');
  if (edgeTtl === 0 || edgeTtl === undefined) {
    out.push({
      id: 'edge-ttl',
      title: '边缘缓存 TTL 未设置（尊重源站头）',
      status: 'warn',
      detail:
        '当前完全依赖源站 Cache-Control。如果源站没设，Cloudflare 默认不缓存 HTML。' +
        '建议对静态资源用 Cache Rules 显式设长 TTL。',
      fix: `cfm cache rules ${zone.name} --show`,
    });
  }

  // 8. 回源超时与重试（免费层的隐性成本）
  const dnsRecordsProxyable = dnsRecords.filter((r) => r.proxiable);
  const notProxied = dnsRecordsProxyable.filter((r) => !r.proxied);
  if (notProxied.length) {
    out.push({
      id: 'dns-unproxied',
      title: `${notProxied.length} 条记录未走橙云代理`,
      status: 'warn',
      detail:
        `这些记录直连源站，Cloudflare 的缓存/WAF/DDoS 防护全部失效：` +
        notProxied.slice(0, 5).map((r) => `${r.name}(${r.type})`).join(', ') +
        (notProxied.length > 5 ? ` 等 ${notProxied.length} 条` : ''),
      fix: `cfm dns proxy ${zone.name} --enable`,
    });
  } else {
    out.push({ id: 'dns-proxied', title: 'DNS 记录均已代理', status: 'ok', detail: '全部可代理记录都走了橙云。' });
  }

  // 9. DNS 记录数（免费上限 200）
  const dnsLimit = 200;
  if (dnsRecords.length > dnsLimit * 0.8) {
    out.push({
      id: 'dns-count',
      title: `DNS 记录数 ${dnsRecords.length}/${dnsLimit}`,
      status: dnsRecords.length >= dnsLimit ? 'bad' : 'warn',
      detail: `免费层每个 zone 上限 ${dnsLimit} 条记录。${dnsRecords.length >= dnsLimit ? '已达上限，新增记录会失败。' : '接近上限。'}`,
    });
  } else {
    out.push({
      id: 'dns-count',
      title: `DNS 记录数 ${dnsRecords.length}/${dnsLimit}`,
      status: 'ok',
      detail: '余量充足。',
    });
  }

  // 10. 源站证书有效期检查（证书过期是最常见的"莫名 5xx"）
  const aRecords = dnsRecords.filter((r) => r.type === 'A' || r.type === 'AAAA');
  if (aRecords.some((r) => /^\d/.test(r.content))) {
    out.push({
      id: 'origin-cert',
      title: '源站证书检查',
      status: 'skip',
      detail: '需连到源站才能验证。建议在源站侧跑 `cfm doctor --origin` 或使用 Cloudflare 的证书监控。',
    });
  }

  // 11. 页面规则数量（免费层 5 条）
  if (pageRules.length >= 5) {
    out.push({
      id: 'pagerules-full',
      title: `页面规则已用满（${pageRules.length}/5）`,
      status: 'bad',
      detail:
        '免费层页面规则上限 5 条，已达到。新增会失败。' +
        '建议改用 Cache Rules / Transform Rules，它们免费层不限条数（有 10 个 ruleset 限制）。',
      fix: `cfm cache rules ${zone.name} --migrate-pagerules`,
    });
  } else if (pageRules.length > 0) {
    out.push({
      id: 'pagerules',
      title: `页面规则 ${pageRules.length}/5`,
      status: 'ok',
      detail: '有余量。',
    });
  }

  // 12. Transform Rules 数量
  const customRulesets = Array.isArray(rulesets) ? rulesets.filter((r) => r.phase?.startsWith('http_')) : [];
  out.push({
    id: 'rulesets',
    title: `自定义规则集 ${customRulesets.length} 个`,
    status: 'ok',
    detail: customRulesets.map((r) => r.phase).join(', ') || '无',
  });

  // 13. Zone 是否在免费套餐上（防止意外升级）
  const plan = zone.plan?.name?.toLowerCase();
  if (plan && plan !== 'free') {
    out.push({
      id: 'paid-plan',
      title: `当前套餐：${zone.plan.name}`,
      status: 'warn',
      detail: '这不是免费套餐。如果你以为在免费层，现在就该确认一下账单。',
    });
  }

  return out;
}

/** @param {Finding[]} findings */
function renderFindings(findings) {
  const icon = { ok: `${color.green}✔${color.reset}`, warn: `${color.yellow}⚠${color.reset}`, bad: `${color.red}✘${color.reset}`, skip: `${color.dim}−${color.reset}` };
  for (const f of findings) {
    console.log(`  ${icon[f.status]} ${color.bold}${f.title}${color.reset}`);
    console.log(`      ${color.dim}${f.detail}${color.reset}`);
    if (f.fix) console.log(`      ${color.cyan}修复：${f.fix}${color.reset}`);
  }
}
