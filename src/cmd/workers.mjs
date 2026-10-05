/**
 * workers — Workers 脚本管理（基于 REST API，不依赖 wrangler）
 *
 * 子命令：
 *   cfm workers list
 *   cfm workers get <script-name>
 *   cfm workers delete <script-name>
 *   cfm workers secret <script-name> --set KEY=VALUE | --list
 *   cfm workers route list <zone> | add <zone> --pattern "x/*" --script s | delete <zone> <id>
 *   cfm workers subdomain
 *   cfm workers limits              打印免费层限制与当前占用
 *
 * 说明：日常开发仍推荐 wrangler（本地开发、构建打包更强）。
 *       这个命令组的用途是**批量运维与审计** —— 一次看全账号下的 Worker、
 *       找出没人用的脚本、核对路由冲突、检查是不是有脚本跑满额度。
 */

import { log, table, color, confirm, require_, humanNum } from '../lib/util.mjs';
import { FREE_TIER } from '../lib/quota.mjs';

export async function run({ client, flags }) {
  const sub = flags._[1];
  const cf = client();

  switch (sub) {
    case 'list':
      return listScripts(cf, flags);
    case 'get':
      return getScript(cf, flags);
    case 'delete':
      return deleteScript(cf, flags);
    case 'secret':
      return secrets(cf, flags);
    case 'route':
      return routes(cf, flags);
    case 'subdomain':
      return subdomain(cf, flags);
    case 'limits':
      return limits(cf, flags);
    case 'tail':
      return tailHelp(flags);
    default:
      log.err(`未知子命令：workers ${sub ?? '(空)'}`);
      console.log('可用：list / get / delete / secret / route / subdomain / limits / tail');
      return 2;
  }
}

async function listScripts(cf, flags) {
  const accountId = requireAccount(cf);
  if (!accountId) return 1;

  const scripts = await cf.paginate(`/accounts/${accountId}/workers/scripts`);
  if (flags.json) {
    console.log(JSON.stringify(scripts, null, 2));
    return 0;
  }

  if (!scripts.length) {
    log.info('账号下没有 Worker 脚本。');
    log.dim('用 wrangler 部署：npx wrangler deploy');
    return 0;
  }

  // 拉取每个脚本的元信息（创建/修改时间）
  const rows = [];
  for (const s of scripts.slice(0, 200)) {
    let meta = null;
    try {
      meta = await cf.request('GET', `/accounts/${accountId}/workers/services/${s.id}`);
    } catch {
      /* 忽略 */
    }
    rows.push([
      s.id,
      meta?.default_environment?.script?.last_deployed_from ?? '-',
      (meta?.created_on ?? s.created_on ?? '').slice(0, 10),
      (meta?.modified_on ?? s.modified_on ?? '').slice(0, 10),
    ]);
  }

  table(['脚本名', '部署来源', '创建', '最后修改'], rows);
  console.log('');
  log.dim(`共 ${scripts.length} 个脚本（免费层上限 ${FREE_TIER.workers.scripts.limit}）`);

  // 找出长期未更新的
  const stale = rows.filter((r) => {
    const d = new Date(r[3]);
    if (Number.isNaN(d.getTime())) return false;
    return Date.now() - d.getTime() > 180 * 86400 * 1000;
  });
  if (stale.length) {
    console.log('');
    log.warn(`${stale.length} 个脚本超过 180 天未更新，考虑清理：`);
    for (const s of stale.slice(0, 10)) console.log(`  • ${s[0]}（最后修改 ${s[3]}）`);
  }
  return 0;
}

async function getScript(cf, flags) {
  const accountId = requireAccount(cf);
  if (!accountId) return 1;
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm workers get <script-name>');
    return 2;
  }
  const meta = await cf.request('GET', `/accounts/${accountId}/workers/services/${name}`);
  if (flags.json) {
    console.log(JSON.stringify(meta, null, 2));
    return 0;
  }
  console.log(`\n${color.bold}${name}${color.reset}\n`);
  const env = meta.default_environment ?? {};
  console.log(`  ID          ${meta.id}`);
  console.log(`  创建        ${meta.created_on ?? '-'}`);
  console.log(`  最后修改    ${meta.modified_on ?? '-'}`);
  console.log(`  部署来源    ${env.script?.last_deployed_from ?? '-'}`);
  console.log(`  兼容日期    ${env.script?.compatibility_date ?? '-'}`);
  console.log(`  兼容标志    ${(env.script?.compatibility_flags ?? []).join(', ') || '无'}`);
  console.log(`  用量模型    ${env.script?.usage_model ?? 'bundled'}`);
  console.log(`  入口        ${env.script?.handlers?.join(', ') ?? '-'}`);
  console.log('');

  // 绑定
  if (env.script?.bindings?.length) {
    log.step('绑定');
    table(
      ['类型', '名称', '目标'],
      env.script.bindings.map((b) => [
        b.type,
        b.name,
        b.namespace_id ?? b.id ?? b.class_name ?? b.text?.slice(0, 30) ?? '-',
      ]),
    );
  }
  return 0;
}

async function deleteScript(cf, flags) {
  const accountId = requireAccount(cf);
  if (!accountId) return 1;
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm workers delete <script-name>');
    return 2;
  }
  log.warn(`将删除 Worker 脚本 ${name} 及其路由绑定。`);
  if (flags['dry-run']) return 0;
  if (!(await confirm('确认删除？', { force: flags.yes }))) return 0;
  await cf.request('DELETE', `/accounts/${accountId}/workers/scripts/${name}`, { query: { force: true } });
  log.ok('已删除。');
  return 0;
}

/**
 * secret — 环境变量/密钥管理
 *
 * 免费层每个 Worker 最多 64 个变量。
 * secret 走加密存储，text 走明文（适合配置项）。
 */
async function secrets(cf, flags) {
  const accountId = requireAccount(cf);
  if (!accountId) return 1;
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm workers secret <script-name> --list | --set KEY=VALUE [--type secret|plain_text]');
    return 2;
  }

  const env = await cf.request('GET', `/accounts/${accountId}/workers/scripts/${name}/settings`);

  if (flags.list || !flags.set) {
    const bindings = env.bindings ?? [];
    if (flags.json) {
      // 不输出明文值，只输出结构
      console.log(
        JSON.stringify(
          bindings.map((b) => ({ name: b.name, type: b.type, hasValue: b.text !== undefined })),
          null,
          2,
        ),
      );
      return 0;
    }
    if (!bindings.length) {
      log.info('没有绑定。');
      return 0;
    }
    table(
      ['名称', '类型', '值'],
      bindings.map((b) => [
        b.name,
        b.type,
        b.type === 'plain_text' ? String(b.text ?? '').slice(0, 40) : `${color.dim}(已加密)${color.reset}`,
      ]),
    );
    console.log('');
    console.log(`共 ${bindings.length}/${FREE_TIER.workers.env_vars.limit} 个变量（免费层上限）`);
    return 0;
  }

  // --set KEY=VALUE
  const kv = String(flags.set);
  const eq = kv.indexOf('=');
  if (eq === -1) {
    log.err('--set 格式必须是 KEY=VALUE');
    return 2;
  }
  const key = kv.slice(0, eq);
  const value = kv.slice(eq + 1);
  const type = flags.type === 'plain_text' ? 'plain_text' : 'secret';

  const existing = (env.bindings ?? []).filter((b) => b.name !== key);
  if (existing.length >= FREE_TIER.workers.env_vars.limit) {
    log.err(`已达 ${FREE_TIER.workers.env_vars.limit} 个变量上限。`);
    return 1;
  }

  if (flags['dry-run']) {
    log.info(`--dry-run：将设置 ${key}（类型 ${type}）`);
    return 0;
  }

  const body = {
    bindings: [
      ...existing.map((b) => {
        // 保留原有绑定，但加密类型不能回传值，需原样保留 name/type
        if (b.type === 'secret') return { name: b.name, type: 'secret', text: b.text ?? '' };
        if (b.type === 'plain_text') return { name: b.name, type: 'plain_text', text: b.text ?? '' };
        if (b.type === 'kv_namespace') return { name: b.name, type: 'kv_namespace', namespace_id: b.namespace_id };
        if (b.type === 'd1') return { name: b.name, type: 'd1', id: b.id };
        if (b.type === 'r2_bucket') return { name: b.name, type: 'r2_bucket', bucket_name: b.bucket_name };
        if (b.type === 'durable_object_namespace') return { name: b.name, type: 'durable_object_namespace', class_name: b.class_name };
        if (b.type === 'service') return { name: b.name, type: 'service', service: b.service, environment: b.environment };
        return { name: b.name, type: b.type, ...(b.text ? { text: b.text } : {}) };
      }),
      { name: key, type, text: value },
    ],
  };

  await cf.request('PUT', `/accounts/${accountId}/workers/scripts/${name}/settings`, { body });
  log.ok(`已设置 ${key}（${type}）。`);
  log.dim('注意：secret 类型的值不会再被 API 读回，只能覆盖。');
  return 0;
}

async function routes(cf, flags) {
  const action = flags._[2];
  const zoneRef = flags._[3];

  switch (action) {
    case 'list': {
      if (!zoneRef) {
        log.err('用法：cfm workers route list <zone>');
        return 2;
      }
      const zone = await cf.resolveZone(zoneRef);
      const list = await cf.paginate(`/zones/${zone.id}/workers/routes`);
      if (flags.json) {
        console.log(JSON.stringify(list, null, 2));
        return 0;
      }
      if (!list.length) {
        log.info('没有 Worker 路由。');
        return 0;
      }
      table(
        ['路由', '脚本', 'ID'],
        list.map((r) => [r.pattern, r.script ?? '(无)', r.id]),
      );
      return 0;
    }

    case 'add': {
      if (!zoneRef) {
        log.err('用法：cfm workers route add <zone> --pattern "example.com/api/*" --script my-worker');
        return 2;
      }
      const zone = await cf.resolveZone(zoneRef);
      const pattern = require_(flags, 'pattern', '如 example.com/api/*');
      const script = require_(flags, 'script', 'Worker 脚本名');

      const existing = await cf.paginate(`/zones/${zone.id}/workers/routes`);

      // 路由冲突检测
      const conflict = existing.find((r) => r.pattern === pattern);
      if (conflict) {
        log.warn(`路由 ${pattern} 已存在（指向 ${conflict.script}），将更新为 ${script}。`);
      }
      const overlapping = existing.filter((r) => patternsOverlap(r.pattern, pattern));
      if (overlapping.length) {
        log.warn(`检测到可能重叠的路由：${overlapping.map((r) => r.pattern).join(', ')}`);
        log.dim('Cloudflare 按「最具体优先」匹配，但重叠路由容易产生难以排查的行为。');
      }

      if (flags['dry-run']) {
        log.info(`--dry-run：将绑定 ${pattern} → ${script}`);
        return 0;
      }

      if (conflict) {
        await cf.request('PUT', `/zones/${zone.id}/workers/routes/${conflict.id}`, {
          body: { pattern, script },
        });
        log.ok(`已更新路由 ${pattern} → ${script}`);
      } else {
        await cf.request('POST', `/zones/${zone.id}/workers/routes`, { body: { pattern, script } });
        log.ok(`已创建路由 ${pattern} → ${script}`);
      }
      log.dim('免费层每个 zone 100 条 Worker 路由。');
      return 0;
    }

    case 'delete': {
      const id = flags._[4];
      if (!zoneRef || !id) {
        log.err('用法：cfm workers route delete <zone> <route-id>');
        return 2;
      }
      const zone = await cf.resolveZone(zoneRef);
      if (flags['dry-run']) return 0;
      if (!(await confirm('确认删除该路由？', { force: flags.yes }))) return 0;
      await cf.request('DELETE', `/zones/${zone.id}/workers/routes/${id}`);
      log.ok('已删除。');
      return 0;
    }

    default:
      log.err('用法：cfm workers route list|add|delete <zone> ...');
      return 2;
  }
}

/** 粗略判断两个路由 pattern 是否可能重叠 */
function patternsOverlap(a, b) {
  const norm = (p) => p.replace(/\*$/, '');
  const [short, long] = [norm(a), norm(b)].sort((x, y) => x.length - y.length);
  if (!short) return true; // "example.com/*"
  if (!long.startsWith(short)) return false;
  // 短的是长的前缀且短的不含通配符在中间
  const shortRaw = short === norm(a) ? a : b;
  return shortRaw.endsWith('*') || long.startsWith(short);
}

async function subdomain(cf, flags) {
  const accountId = requireAccount(cf);
  if (!accountId) return 1;
  const res = await cf.request('GET', `/accounts/${accountId}/workers/subdomain`);
  log.info(`workers.dev 子域：${color.cyan}${res.subdomain ?? '(未设置)'}${color.reset}`);
  if (res.subdomain) {
    console.log(`  Worker 可通过 https://<脚本名>.${res.subdomain}.workers.dev 访问`);
  }
  return 0;
}

/**
 * limits — 免费层限制对照 + 当前占用
 */
async function limits(cf, flags) {
  const accountId = requireAccount(cf);
  if (!accountId) return 1;

  const scripts = await cf.paginate(`/accounts/${accountId}/workers/scripts`);
  const kvNs = await cf.paginate(`/accounts/${accountId}/storage/kv/namespaces`);
  const d1 = await cf.paginate(`/accounts/${accountId}/d1/database`);
  const r2 = await cf.paginate(`/accounts/${accountId}/r2/buckets`).catch(() => []);

  log.step('免费层资源占用');
  table(
    ['资源', '已用', '上限', '占用'],
    [
      row('Worker 脚本', scripts.length, FREE_TIER.workers.scripts.limit),
      row('KV 命名空间', kvNs.length, FREE_TIER.workers_kv.namespaces.limit),
      row('D1 数据库', d1.length, FREE_TIER.workers_d1.databases.limit),
      row('R2 桶', r2.length, FREE_TIER.r2.buckets.limit),
    ],
  );

  console.log('');
  log.step('每日/每月额度（无法直接查询剩余量，用 cfm usage 看消耗趋势）');
  table(
    ['资源', '额度', '重置周期'],
    [
      ['Workers 请求', humanNum(FREE_TIER.workers.requests.limit), '每日 UTC 00:00'],
      ['Workers CPU', `${FREE_TIER.workers.cpu_ms.limit} ms/请求`, '—'],
      ['KV 读', humanNum(FREE_TIER.workers_kv.reads.limit), '每日'],
      ['KV 写', humanNum(FREE_TIER.workers_kv.writes.limit), '每日'],
      ['KV 删除', humanNum(FREE_TIER.workers_kv.deletes.limit), '每日'],
      ['KV 列表', humanNum(FREE_TIER.workers_kv.lists.limit), '每日'],
      ['D1 读行', humanNum(FREE_TIER.workers_d1.rows_read.limit), '每日'],
      ['D1 写行', humanNum(FREE_TIER.workers_d1.rows_written.limit), '每日'],
      ['R2 Class A', humanNum(FREE_TIER.r2.class_a.limit), '每月'],
      ['R2 Class B', humanNum(FREE_TIER.r2.class_b.limit), '每月'],
      ['R2 存储', `${FREE_TIER.r2.storage.limit} GB`, '—'],
    ],
  );

  return 0;
}

function row(label, used, limit) {
  const pct = limit ? (used / limit) * 100 : 0;
  return [label, humanNum(used), humanNum(limit), `${pct.toFixed(1)}%`];
}

function tailHelp(flags) {
  log.info('实时日志需要 wrangler：npx wrangler tail <script-name>');
  log.dim('REST API 不提供 tail 流。这是 Cloudflare 的限制，不是本工具的缺失。');
  log.dim('本地开发用：npx wrangler dev');
  return 0;
}

function requireAccount(cf) {
  if (!cf.accountId) {
    log.err('该操作需要账号 ID。请设置 CF_ACCOUNT_ID 环境变量。');
    log.dim('运行 cfm whoami 可以看到账号 ID。');
    return null;
  }
  return cf.accountId;
}
