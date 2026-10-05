#!/usr/bin/env node
/**
 * cfm — Cloudflare 免费额度用满工具箱
 *
 * 用法：node bin/cfm.mjs <命令> [选项]
 *      或 pnpm cfm <命令>
 */

// ⚠️ 必须在其它 import 之前初始化终端编码 ——
//    它要包装 process.stdout.write，晚于任何输出就没意义了。
import { setupTerminalEncoding } from '../src/lib/terminal-encoding.mjs';
setupTerminalEncoding();

import { loadEnvFile, log, parseArgs, color } from '../src/lib/util.mjs';
import { CFClient, CFError } from '../src/lib/cf.mjs';

// 先加载 .env（如果存在），再解析参数
loadEnvFile();

const argv = process.argv.slice(2);
const flags = parseArgs(argv);

// 无参数时进交互模式 —— 这是新手最需要的入口。
// 但在非 TTY（管道/CI）下不该卡住，此时回落到帮助。
const command = flags._[0] ?? (process.stdin.isTTY ? 'ui' : 'help');

const COMMANDS = {
  help: () => import('../src/cmd/help.mjs'),
  ui: () => import('../src/cmd/ui.mjs'),
  whoami: () => import('../src/cmd/whoami.mjs'),
  doctor: () => import('../src/cmd/doctor.mjs'),
  quota: () => import('../src/cmd/quota.mjs'),
  usage: () => import('../src/cmd/usage.mjs'),
  dns: () => import('../src/cmd/dns.mjs'),
  cache: () => import('../src/cmd/cache.mjs'),
  zone: () => import('../src/cmd/zone.mjs'),
  r2: () => import('../src/cmd/r2.mjs'),
  pages: () => import('../src/cmd/pages.mjs'),
  workers: () => import('../src/cmd/workers.mjs'),
  kv: () => import('../src/cmd/kv.mjs'),
  d1: () => import('../src/cmd/d1.mjs'),
  tunnel: () => import('../src/cmd/tunnel.mjs'),
  audit: () => import('../src/cmd/audit.mjs'),
  deploy: () => import('../src/cmd/deploy.mjs'),
  setup: () => import('../src/cmd/setup.mjs'),
};

async function main() {
  if (command === 'version' || flags.version) {
    console.log('cfm 1.0.0');
    return 0;
  }

  const loader = COMMANDS[command];
  if (!loader) {
    log.err(`未知命令：${command}`);
    console.log(`\n可用命令：${Object.keys(COMMANDS).join(', ')}`);
    console.log(`运行 ${color.cyan}cfm help${color.reset} 查看详细用法。`);
    return 2;
  }

  const mod = await loader();
  const ctx = {
    flags,
    argv,
    /** @returns {CFClient} */
    client() {
      return new CFClient({ verbose: !!flags.verbose });
    },
  };
  const code = await mod.run(ctx);
  return typeof code === 'number' ? code : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof CFError) {
      log.err(err.toString());
    } else {
      log.err(err?.message ?? String(err));
      if (process.env.CFM_DEBUG) console.error(err);
    }
    process.exit(1);
  });
