/**
 * cache — 缓存管理
 *
 * 子命令：
 *   cfm cache purge <zone> --all | --urls a,b,c | --tags t1,t2 | --hosts h1,h2 | --prefixes p1,p2
 *   cfm cache devmode <zone> on|off|status
 *   cfm cache rules <zone> --show | --apply <profile>
 *   cfm cache warm <zone> --file urls.txt
 *
 * 免费层注意：purge 每日 1000 次调用（不是 1000 个 URL）。
 * 一次 by-url 调用最多带 30 个 URL —— 批量清理要合并请求。
 */

import fs from 'node:fs';
import { log, table, color, confirm, require_, sleep, mapLimit } from '../lib/util.mjs';

const PURGE_DAILY_LIMIT = 1000;
const MAX_URLS_PER_CALL = 30;
const MAX_TAGS_PER_CALL = 30;

export async function run({ client, flags }) {
  const sub = flags._[1];
  const cf = client();
  switch (sub) {
    case 'purge':
      return purge(cf, flags);
    case 'devmode':
      return devMode(cf, flags);
    case 'rules':
      return cacheRules(cf, flags);
    case 'warm':
      return warm(cf, flags);
    default:
      log.err(`未知子命令：cache ${sub ?? '(空)'}`);
      console.log('可用：purge / devmode / rules / warm');
      return 2;
  }
}

async function purge(cf, flags) {
  const zoneRef = flags._[2];
  if (!zoneRef) {
    log.err('用法：cfm cache purge <zone> --all | --urls ... | --tags ... | --hosts ... | --prefixes ...');
    return 2;
  }
  const zone = await cf.resolveZone(zoneRef);

  /** @type {any} */
  let body;
  let describe;

  if (flags.all) {
    body = { purge_everything: true };
    describe = '清空整个 zone 的缓存';
  } else if (flags.urls) {
    const urls = splitList(flags.urls);
    body = { files: urls.slice(0, MAX_URLS_PER_CALL) };
    if (urls.length > MAX_URLS_PER_CALL) {
      log.warn(`一次最多 ${MAX_URLS_PER_CALL} 个 URL，本次只清理前 ${MAX_URLS_PER_CALL} 个（共给了 ${urls.length} 个）。`);
      log.dim('提示：需要清理更多 URL 时，请分批调用；或用 --prefixes（企业版）替代。');
    }
    describe = `按 URL 清理 ${body.files.length} 个`;
  } else if (flags.tags) {
    const tags = splitList(flags.tags);
    body = { tags: tags.slice(0, MAX_TAGS_PER_CALL) };
    describe = `按 Cache-Tag 清理 ${body.tags.length} 个标签`;
  } else if (flags.hosts) {
    body = { hosts: splitList(flags.hosts) };
    describe = `按主机名清理 ${body.hosts.length} 个`;
  } else if (flags.prefixes) {
    log.warn('按前缀清理（purge by prefix）需要 Enterprise 套餐，免费层会返回 403。');
    body = { prefixes: splitList(flags.prefixes) };
    describe = `按前缀清理 ${body.prefixes.length} 个`;
  } else {
    log.err('必须指定一种清理方式：--all / --urls / --tags / --hosts / --prefixes');
    return 2;
  }

  log.step(`${zone.name}：${describe}`);
  if (flags.all) {
    log.warn('--all 会让下一次访问全部回源。若源站扛不住突发流量，请改用按 URL 清理。');
  }

  if (flags['dry-run']) {
    log.info('--dry-run：未实际执行。');
    return 0;
  }
  if (!(await confirm('确认清理？', { force: flags.yes }))) return 0;

  const res = await cf.request('POST', `/zones/${zone.id}/purge_cache`, { body });
  log.ok(`清理请求已提交（id: ${res.id ?? 'n/a'}）。`);
  log.dim(`免费层每日上限 ${PURGE_DAILY_LIMIT} 次调用。频繁全量清理通常说明缓存策略需要调整。`);
  return 0;
}

async function devMode(cf, flags) {
  const zoneRef = flags._[2];
  const action = flags._[3];
  if (!zoneRef) {
    log.err('用法：cfm cache devmode <zone> on|off|status');
    return 2;
  }
  const zone = await cf.resolveZone(zoneRef);

  if (action === 'status' || !action) {
    const res = await cf.request('GET', `/zones/${zone.id}/settings/development_mode`);
    const on = res.value === 'on';
    console.log(`${zone.name} 开发模式：${on ? color.yellow + '开启' + color.reset : color.green + '关闭' + color.reset}`);
    if (on && res.time_remaining) {
      const min = Math.floor(res.time_remaining / 60);
      log.dim(`剩余 ${min} 分钟自动关闭（开启后 3 小时自动关，这是防止忘记关的机制）。`);
    }
    log.dim('开发模式开启期间：所有请求绕过缓存直连源站 —— 会显著增加源站压力，用完务必关闭。');
    return 0;
  }

  if (action !== 'on' && action !== 'off') {
    log.err('必须是 on / off / status');
    return 2;
  }

  if (flags['dry-run']) return 0;
  await cf.request('PATCH', `/zones/${zone.id}/settings/development_mode`, { body: { value: action } });
  log.ok(`开发模式已${action === 'on' ? '开启（3 小时后自动关闭）' : '关闭'}`);
  return 0;
}

/**
 * rules — Cache Rules 管理
 *
 * 免费层可用 Ruleset Engine，且**不计入 5 条页面规则限制**。
 * 这里提供几个开箱可用的 profile。
 */
const RULE_PROFILES = {
  /**
   * 静态资源长缓存 + 图片长缓存。
   * 这是免费层最值钱的一条规则：让 Cloudflare 替你扛掉绝大部分流量。
   */
  static: [
    {
      description: '静态资源：哈希文件名 → 1 年边缘+浏览器缓存',
      expression: `(http.request.uri.path matches "^/assets/.*\\.[a-f0-9]{8,}\\.") or (http.request.uri.path matches "\\.(js|css|woff2?|ttf|eot)$")`,
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        edge_ttl: { mode: 'override_origin', default: 31536000 },
        browser_ttl: { mode: 'override_origin', default: 31536000 },
      },
    },
    {
      description: '图片与字体 → 30 天缓存',
      expression: `http.request.uri.path matches "\\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$"`,
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        edge_ttl: { mode: 'override_origin', default: 2592000 },
        browser_ttl: { mode: 'override_origin', default: 604800 },
      },
    },
    {
      description: 'HTML 短缓存 + 后台校验（保证内容更新及时又不回源爆炸）',
      expression: `(http.request.uri.path eq "/" ) or (http.request.uri.path matches "\\.html?$") or (not http.request.uri.path contains ".")`,
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        edge_ttl: { mode: 'override_origin', default: 300 },
        browser_ttl: { mode: 'override_origin', default: 0 },
      },
    },
    {
      description: 'API 与后台不缓存',
      expression: `(starts_with(http.request.uri.path, "/api/")) or (starts_with(http.request.uri.path, "/admin")) or (http.request.method ne "GET")`,
      action: 'set_cache_settings',
      action_parameters: { cache: false },
    },
  ],

  /** 保守型：只缓存明确的静态目录，其余全部尊重源站 */
  conservative: [
    {
      description: '仅缓存 /static 与 /assets 下的资源',
      expression: `(starts_with(http.request.uri.path, "/static/")) or (starts_with(http.request.uri.path, "/assets/"))`,
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        edge_ttl: { mode: 'override_origin', default: 604800 },
      },
    },
  ],
};

async function cacheRules(cf, flags) {
  const zoneRef = flags._[2];
  if (!zoneRef) {
    log.err('用法：cfm cache rules <zone> --show | --apply <profile> [--dry-run]');
    console.log(`可用 profile：${Object.keys(RULE_PROFILES).join(', ')}`);
    return 2;
  }
  const zone = await cf.resolveZone(zoneRef);
  const PHASE = 'http_request_cache_settings';

  // 读取当前 ruleset
  const rulesets = await cf.request('GET', `/zones/${zone.id}/rulesets`);
  const current = (Array.isArray(rulesets) ? rulesets : []).find((r) => r.phase === PHASE);

  if (flags.show || (!flags.apply && !flags.delete)) {
    if (!current) {
      log.info(`${zone.name} 尚无 Cache Rules。`);
      log.dim(`用 cfm cache rules ${zone.name} --apply static 应用推荐规则。`);
      return 0;
    }
    const full = await cf.request('GET', `/zones/${zone.id}/rulesets/${current.id}`);
    console.log(`\n${color.bold}${zone.name} Cache Rules${color.reset}  ${color.dim}ruleset ${current.id}${color.reset}\n`);
    table(
      ['状态', '描述', '动作', '表达式'],
      (full.rules ?? []).map((r) => [
        r.enabled === false ? '停用' : '启用',
        r.description ?? '-',
        r.action,
        r.expression.length > 60 ? r.expression.slice(0, 57) + '…' : r.expression,
      ]),
    );
    console.log('');
    log.dim('免费层 Cache Rules 不限条数（受每个 zone 10 个自定义 ruleset 限制）。');
    return 0;
  }

  if (flags.apply) {
    const profile = String(flags.apply);
    const rules = RULE_PROFILES[profile];
    if (!rules) {
      log.err(`未知 profile：${profile}`);
      console.log(`可用：${Object.keys(RULE_PROFILES).join(', ')}`);
      return 2;
    }

    log.step(`将应用 profile「${profile}」到 ${zone.name}（${rules.length} 条规则）`);
    for (const r of rules) {
      console.log(`  • ${r.description}`);
      console.log(`    ${color.dim}${r.expression}${color.reset}`);
    }

    if (flags['dry-run']) {
      log.info('--dry-run：未实际执行。');
      return 0;
    }
    if (!(await confirm('确认应用？将覆盖该 zone 现有的 Cache Rules。', { force: flags.yes }))) return 0;

    const body = { rules: rules.map((r) => ({ ...r, enabled: true })) };
    if (current) {
      await cf.request('PUT', `/zones/${zone.id}/rulesets/${current.id}`, { body });
      log.ok('已更新现有 ruleset。');
    } else {
      await cf.request('POST', `/zones/${zone.id}/rulesets`, {
        body: { name: 'cfm cache rules', kind: 'zone', phase: PHASE, rules: body.rules },
      });
      log.ok('已创建 ruleset。');
    }
    log.dim('生效通常需要 1~2 分钟。可用 `cfm cache rules ' + zone.name + ' --show` 复核。');
    return 0;
  }

  if (flags.delete) {
    if (!current) {
      log.info('没有可删除的 Cache Rules。');
      return 0;
    }
    if (flags['dry-run']) return 0;
    if (!(await confirm('确认删除全部 Cache Rules？', { force: flags.yes }))) return 0;
    await cf.request('DELETE', `/zones/${zone.id}/rulesets/${current.id}`);
    log.ok('已删除。');
    return 0;
  }

  return 0;
}

/**
 * warm — 预热缓存
 *
 * 常见误区：以为预热是"免费加速"。
 * 实际上预热会立刻消耗 Workers 请求额度与回源带宽。
 * 这里加了速率控制，让你不会一次打爆。
 */
async function warm(cf, flags) {
  const zoneRef = flags._[2];
  if (!zoneRef) {
    log.err('用法：cfm cache warm <zone> --file urls.txt [--concurrency 3] [--url-base https://x]');
    return 2;
  }
  const zone = await cf.resolveZone(zoneRef);
  const file = require_(flags, 'file', 'URL 列表文件，每行一个');

  let urls = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const base = flags['url-base'] ? String(flags['url-base']).replace(/\/$/, '') : null;
  urls = urls.map((u) => (base && !/^https?:/.test(u) ? `${base}${u.startsWith('/') ? '' : '/'}${u}` : u));

  if (!urls.length) {
    log.err('文件里没有有效的 URL。');
    return 1;
  }

  const concurrency = Number(flags.concurrency ?? 3);
  log.step(`预热 ${urls.length} 个 URL（并发 ${concurrency}）`);
  log.warn('预热会产生真实回源请求与 Workers 调用额度消耗。');

  if (flags['dry-run']) {
    for (const u of urls.slice(0, 10)) console.log(`  ${u}`);
    if (urls.length > 10) console.log(`  … 等 ${urls.length} 个`);
    return 0;
  }

  let ok = 0;
  let fail = 0;
  await mapLimit(urls, concurrency, async (u) => {
    try {
      const res = await fetch(u, {
        method: 'GET',
        headers: { 'User-Agent': 'cfm-warm/1.0', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(15000),
      });
      const hit = res.headers.get('cf-cache-status') ?? '-';
      if (res.ok) {
        ok++;
        if (flags.verbose) console.log(`  ${color.green}${res.status}${color.reset} ${hit.padEnd(12)} ${u}`);
      } else {
        fail++;
        log.err(`${res.status} ${u}`);
      }
    } catch (e) {
      fail++;
      log.err(`${u} → ${e.message}`);
    }
    await sleep(100); // 轻微限速，避免把自己当 DDoS
  });

  log.step(`完成：成功 ${ok} / 失败 ${fail}`);
  log.dim('用 `curl -I <url>` 看 cf-cache-status 是否为 HIT 来确认预热生效（首次通常为 MISS/EXPIRED，第二次才 HIT）。');
  return fail ? 1 : 0;
}

function splitList(v) {
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
