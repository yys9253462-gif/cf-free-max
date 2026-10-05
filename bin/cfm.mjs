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

// ─── 关于「字体检测」的说明 ───
//
// 曾经在这里加过 checkFontSupport()，检测控制台字体是否支持中文，
// 不支持就打印英文指引。**已移除**，原因：
//
//   1. 它调用 execFileSync 启动 powershell 读注册表 ——
//      子进程会继承控制台，可能影响终端状态
//   2. 它用 fs.readSync(0, ...) 等用户回车 ——
//      在旧版 conhost 里这会切换 stdin 模式
//
//   实测反馈：加上这段之后，用户原本正常的中文变成了方块。
//   （用户确认「之前中文能正常显示」）
//
//   而它的价值仅仅是「告诉用户字体有问题」—— 如果检测本身
//   会搞坏显示，那就得不偿失。
//
// 所以改回最简做法：**不碰终端状态，只做编码适配**。
//
// 如果用户真的遇到字体问题（中文显示成方块），
// 那属于环境配置，可以让用户自己改字体 —— 工具不该为了
// 提示这件事去动终端。
//
// 需要检测时可以显式开启：CFM_FONT_CHECK=1
if (process.env.CFM_FONT_CHECK === '1') {
  try {
    const { checkFontSupport } = await import('../src/lib/terminal-font.mjs');
    const r = checkFontSupport();
    if (!r.canShowChinese) {
      process.stdout.write('\n');
      process.stdout.write('  [Font warning] Console font may not show Chinese: ' + r.font + '\n');
      process.stdout.write('  Change it in: title bar -> Properties -> Font -> NSimSun\n');
      process.stdout.write('\n');
    }
  } catch {
    /* 检测失败不影响主流程 */
  }
}

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
  // 终端编码切换 ——
  // 不同终端对中文编码的期望不同（旧 conhost 认 GBK，Windows Terminal 认 UTF-8），
  // 自动检测有时不准，所以给一个手动切换入口。
  encoding: () => import('../src/cmd/encoding.mjs'),
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
