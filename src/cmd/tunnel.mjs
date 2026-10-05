/**
 * tunnel — Cloudflare Tunnel 管理
 *
 * Tunnel 是免费层最被低估的产品：不用开放任何入站端口，
 * 就能把内网/本机服务暴露到公网，且**不消耗任何带宽额度**。
 *
 * 子命令：
 *   cfm tunnel list
 *   cfm tunnel create <name>
 *   cfm tunnel delete <name>
 *   cfm tunnel token <name>           打印 connector token
 *   cfm tunnel connections <name>     查看 connector 连接状态
 *   cfm tunnel route <name> --hostname x.com --service http://localhost:8080
 *   cfm tunnel ingress <name>         查看当前 ingress 配置
 *   cfm tunnel setup <name>           打印各平台安装命令
 */

import { log, table, color, confirm, require_ } from '../lib/util.mjs';

export async function run({ client, flags }) {
  const sub = flags._[1] ?? 'list';
  const cf = client();
  const accountId = cf.accountId;
  if (!accountId) {
    log.err('Tunnel 需要账号 ID。请设置 CF_ACCOUNT_ID。');
    return 1;
  }

  switch (sub) {
    case 'list':
      return listTunnels(cf, accountId, flags);
    case 'create':
      return createTunnel(cf, accountId, flags);
    case 'delete':
      return deleteTunnel(cf, accountId, flags);
    case 'token':
      return showToken(cf, accountId, flags);
    case 'connections':
      return connections(cf, accountId, flags);
    case 'route':
      return addRoute(cf, accountId, flags);
    case 'ingress':
      return showIngress(cf, accountId, flags);
    case 'setup':
      return setup(cf, accountId, flags);
    default:
      log.err(`未知子命令：tunnel ${sub}`);
      console.log('可用：list / create / delete / token / connections / route / ingress / setup');
      return 2;
  }
}

async function listTunnels(cf, accountId, flags) {
  const tunnels = await cf.paginate(`/accounts/${accountId}/cfd_tunnel`, {
    query: { is_deleted: false },
  });
  if (flags.json) {
    console.log(JSON.stringify(tunnels, null, 2));
    return 0;
  }
  if (!tunnels.length) {
    log.info('还没有 Tunnel。');
    log.dim('创建：cfm tunnel create my-tunnel');
    log.dim('Tunnel 免费、不限数量，且不消耗带宽额度 —— 是暴露内网服务最省的方式。');
    return 0;
  }
  table(
    ['名称', '状态', '连接数', 'ID', '创建'],
    tunnels.map((t) => [
      t.name,
      t.status === 'healthy'
        ? `${color.green}健康${color.reset}`
        : t.status === 'degraded'
          ? `${color.yellow}降级${color.reset}`
          : `${color.red}${t.status}${color.reset}`,
      t.connections?.length ?? 0,
      t.id,
      (t.created_at ?? '').slice(0, 10),
    ]),
  );
  console.log('');
  log.dim('状态为 inactive 表示没有 connector 在跑（本地 cloudflared 没启动）。');
  return 0;
}

async function createTunnel(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm tunnel create <name> [--secret <base64>]');
    return 2;
  }

  // Tunnel secret 必须是 32 字节的 base64
  const secret =
    flags.secret ??
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

  if (flags['dry-run']) {
    log.info(`--dry-run：将创建 Tunnel ${name}`);
    return 0;
  }

  const res = await cf.request('POST', `/accounts/${accountId}/cfd_tunnel`, {
    body: { name, tunnel_secret: secret, config_src: 'cloudflare' },
  });

  log.ok(`Tunnel ${res.name} 已创建`);
  console.log(`  ID      ${res.id}`);
  console.log(`  隧道令牌 ${color.dim}${res.token ?? '(需用 cfm tunnel token ' + name + ' 获取)'}${color.reset}`);
  console.log('');
  log.dim('config_src=cloudflare 表示配置由控制台/API 管理（推荐），本地无需 config.yml。');
  log.dim(`下一步：cfm tunnel route ${name} --hostname app.example.com --service http://localhost:8080`);
  return 0;
}

async function deleteTunnel(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm tunnel delete <name>');
    return 2;
  }
  const tunnels = await cf.paginate(`/accounts/${accountId}/cfd_tunnel`, { query: { is_deleted: false } });
  const t = tunnels.find((x) => x.name === name || x.id === name);
  if (!t) {
    log.err(`找不到 Tunnel：${name}`);
    return 1;
  }
  log.warn(`将删除 Tunnel ${t.name}（${t.connections?.length ?? 0} 个活跃连接）。`);
  log.dim('注意：删除前应先停止本地的 cloudflared 进程，否则会留下孤儿连接。');
  if (flags['dry-run']) return 0;
  if (!(await confirm('确认删除？', { force: flags.yes }))) return 0;
  await cf.request('DELETE', `/accounts/${accountId}/cfd_tunnel/${t.id}`);
  log.ok('已删除。');
  return 0;
}

async function showToken(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm tunnel token <name>');
    return 2;
  }
  const tunnels = await cf.paginate(`/accounts/${accountId}/cfd_tunnel`, { query: { is_deleted: false } });
  const t = tunnels.find((x) => x.name === name || x.id === name);
  if (!t) {
    log.err(`找不到 Tunnel：${name}`);
    return 1;
  }
  const res = await cf.request('GET', `/accounts/${accountId}/cfd_tunnel/${t.id}/token`);
  console.log(res);
  console.log('');
  log.warn('这个 token 等同于该 Tunnel 的完整凭据，不要提交到 git 或贴到公开场合。');
  log.dim('用法：cloudflared tunnel run --token <token>');
  return 0;
}

async function connections(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm tunnel connections <name>');
    return 2;
  }
  const tunnels = await cf.paginate(`/accounts/${accountId}/cfd_tunnel`, { query: { is_deleted: false } });
  const t = tunnels.find((x) => x.name === name || x.id === name);
  if (!t) {
    log.err(`找不到 Tunnel：${name}`);
    return 1;
  }

  const conns = t.connections ?? [];
  if (!conns.length) {
    log.warn('没有活跃连接。检查：');
    console.log('  1. cloudflared 进程是否在跑（systemctl status cloudflared）');
    console.log('  2. token 是否正确');
    console.log('  3. 出站 7844 端口（UDP/TCP）是否被防火墙拦了');
    console.log('');
    log.dim('提示：cloudflared 是出站连接，不需要开放任何入站端口 —— 这正是它适合内网的原因。');
    return 0;
  }

  table(
    ['连接 ID', '数据中心(colo)', '客户端版本', '架构', '建立时间'],
    conns.map((c) => [
      (c.id ?? '').slice(0, 12) + '…',
      c.colo_name ?? '-',
      c.client_version ?? '-',
      c.arch ?? '-',
      (c.opened_at ?? '').slice(0, 19).replace('T', ' '),
    ]),
  );

  console.log('');
  if (conns.length === 1) {
    log.warn('只有 1 个 connector 副本。单个副本挂了服务就断 —— 建议跑 2 个以上（免费无限制）。');
  } else if (conns.length >= 2) {
    log.ok(`${conns.length} 个副本，具备冗余。`);
  }
  const colos = new Set(conns.map((c) => c.colo_name));
  log.dim(`分布在 ${colos.size} 个数据中心：${[...colos].join(', ')}`);
  return 0;
}

/**
 * route — 添加主机名路由
 */
async function addRoute(cf, accountId, flags) {
  const name = flags._[2];
  const hostname = require_(flags, 'hostname', '如 app.example.com');
  const service = require_(flags, 'service', '如 http://localhost:8080');

  if (!name) {
    log.err('用法：cfm tunnel route <name> --hostname app.example.com --service http://localhost:8080');
    return 2;
  }

  const tunnels = await cf.paginate(`/accounts/${accountId}/cfd_tunnel`, { query: { is_deleted: false } });
  const t = tunnels.find((x) => x.name === name || x.id === name);
  if (!t) {
    log.err(`找不到 Tunnel：${name}`);
    return 1;
  }

  // 解析主机名的 zone
  const parts = hostname.split('.');
  let zone = null;
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    try {
      zone = await cf.findZone(candidate);
      break;
    } catch {
      /* 继续尝试更短的 */
    }
  }
  if (!zone) {
    log.err(`主机名 ${hostname} 不属于当前账号下的任何 zone。请先把域名接入 Cloudflare。`);
    return 1;
  }

  log.step(`配置路由`);
  console.log(`  主机名  ${hostname}`);
  console.log(`  服务    ${service}`);
  console.log(`  隧道    ${t.name} (${t.id})`);
  console.log(`  Zone    ${zone.name}`);

  if (flags['dry-run']) {
    log.info('--dry-run：未实际执行。');
    return 0;
  }
  if (!(await confirm('确认配置？', { force: flags.yes }))) return 0;

  // 1. 创建 DNS CNAME 指向 <tunnel-id>.cfargotunnel.com
  const target = `${t.id}.cfargotunnel.com`;
  const existing = await cf.paginate(`/zones/${zone.id}/dns_records`, { query: { name: hostname } });
  const cname = existing.find((r) => r.type === 'CNAME');

  if (cname) {
    await cf.request('PUT', `/zones/${zone.id}/dns_records/${cname.id}`, {
      body: { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 },
    });
    log.ok(`DNS 已更新：${hostname} → ${target}（橙云）`);
  } else if (existing.length) {
    log.warn(`${hostname} 已存在其他类型记录，跳过 DNS 创建。请手动确认。`);
  } else {
    await cf.request('POST', `/zones/${zone.id}/dns_records`, {
      body: { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 },
    });
    log.ok(`DNS 已创建：${hostname} → ${target}（橙云）`);
  }

  // 2. 更新 tunnel 的 ingress 配置
  const current = await cf.request('GET', `/accounts/${accountId}/cfd_tunnel/${t.id}/configurations`).catch(() => null);
  const rules = current?.config?.ingress ?? [];
  const newRules = rules.filter((r) => r.hostname !== hostname);
  newRules.push({ hostname, service });
  // 结尾必须有 catch-all
  if (!newRules.some((r) => !r.hostname)) {
    newRules.push({ service: 'http_status:404' });
  }

  await cf.request('PUT', `/accounts/${accountId}/cfd_tunnel/${t.id}/configurations`, {
    body: { config: { ...(current?.config ?? {}), ingress: newRules } },
  });
  log.ok('Ingress 规则已更新。');

  console.log('');
  log.step('在运行服务的机器上执行');
  console.log(`  ${color.cyan}cloudflared tunnel run --token <token>${color.reset}`);
  console.log(`  ${color.dim}（token 用 cfm tunnel token ${t.name} 获取）${color.reset}`);
  console.log('');
  log.dim('cloudflared 是出站连接，不需要在路由器/防火墙开放任何入站端口。');
  return 0;
}

async function showIngress(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm tunnel ingress <name>');
    return 2;
  }
  const tunnels = await cf.paginate(`/accounts/${accountId}/cfd_tunnel`, { query: { is_deleted: false } });
  const t = tunnels.find((x) => x.name === name || x.id === name);
  if (!t) {
    log.err(`找不到 Tunnel：${name}`);
    return 1;
  }
  const res = await cf.request('GET', `/accounts/${accountId}/cfd_tunnel/${t.id}/configurations`);
  const ingress = res?.config?.ingress ?? [];
  if (flags.json) {
    console.log(JSON.stringify(res?.config ?? {}, null, 2));
    return 0;
  }
  if (!ingress.length) {
    log.info('没有 ingress 规则。');
    return 0;
  }
  table(
    ['主机名', '路径', '服务'],
    ingress.map((r) => [r.hostname ?? '(catch-all)', r.path ?? '/', r.service]),
  );
  console.log('');
  log.dim('规则按从上到下匹配，第一条命中即生效。最后一条必须是没有 hostname 的 catch-all。');
  return 0;
}

async function setup(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm tunnel setup <name>');
    return 2;
  }
  const tunnels = await cf.paginate(`/accounts/${accountId}/cfd_tunnel`, { query: { is_deleted: false } });
  const t = tunnels.find((x) => x.name === name || x.id === name);
  if (!t) {
    log.err(`找不到 Tunnel：${name}`);
    return 1;
  }

  console.log(`\n${color.bold}在目标机器上安装 cloudflared${color.reset}\n`);

  console.log(`${color.cyan}Debian / Ubuntu${color.reset}`);
  console.log(`  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null`);
  console.log(`  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list`);
  console.log(`  sudo apt update && sudo apt install -y cloudflared`);
  console.log('');

  console.log(`${color.cyan}Alpine${color.reset}`);
  console.log(`  apk add cloudflared`);
  console.log('');

  console.log(`${color.cyan}Docker${color.reset}`);
  console.log(`  docker run -d --name cloudflared --restart unless-stopped \\`);
  console.log(`    cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <TOKEN>`);
  console.log('');

  console.log(`${color.cyan}systemd 服务（推荐，Debian 系）${color.reset}`);
  console.log(`  sudo cloudflared service install <TOKEN>`);
  console.log(`  sudo systemctl enable --now cloudflared`);
  console.log(`  sudo systemctl status cloudflared`);
  console.log('');

  console.log(`${color.cyan}Windows${color.reset}`);
  console.log(`  winget install --id Cloudflare.cloudflared`);
  console.log(`  cloudflared.exe service install <TOKEN>`);
  console.log('');

  log.warn('Token 等同于凭据，不要写进 git 仓库。用环境变量或 systemd 的 EnvironmentFile。');
  log.dim(`获取 token：cfm tunnel token ${t.name}`);
  return 0;
}
