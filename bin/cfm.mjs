#!/usr/bin/env node
/**
 * cfm — Cloudflare 免费额度用满工具箱
 *
 * 用法：node bin/cfm.mjs <命令> [选项]
 *      或 pnpm cfm <命令>
 */

// ⚠️ 必须在其它 import 之前初始化终端编码 ——
//    它要包装 process.stdout.write，晚于任何输出就没意义了。
import fs from 'node:fs';
import { setupTerminalEncoding } from '../src/lib/terminal-encoding.mjs';
import { checkFontSupport } from '../src/lib/terminal-font.mjs';

setupTerminalEncoding();

// ─── 字体检查 ───
//
// 用户实测反馈：在旧版 Windows PowerShell 窗口里打开，满屏方块 ▯▯▯。
//
// 根因：conhost 默认字体 Lucida Console 是拉丁字体，没有中文字形。
// 而 Windows Terminal 默认字体带 CJK 回退 —— 所以开发时没发现。
//
// ⚠️ 方块 ≠ 乱码，两者修法完全不同：
//     乱码（鈥 鍏嶈垂）→ 编码问题，改编码层
//     方块（▯▯▯）      → 字体缺字形，改字体
//   实测时先入为主以为编码问题，查了半天才发现方向错了。
const _fontCheck = checkFontSupport();

if (!_fontCheck.canShowChinese && !process.env.CFM_NO_FONT_CHECK) {
  // ⚠️ 这一段必须**纯 ASCII**。
  //
  //    讽刺的是：这里要提示的问题就是「中文显示不出来」，
  //    所以提示本身绝不能用中文 —— 那对用户等于乱码。
  //    实测踩过：第一版提示写了中文，用户看到的还是方块，
  //    完全不知道在说什么。
  const lines = [
    '',
    '  ============================================================',
    '   PROBLEM: Console font cannot display Chinese characters',
    '  ============================================================',
    '',
    '   Your console font is: ' + (_fontCheck.font || '(unknown)'),
    '',
    '   This font has no Chinese glyphs, so every Chinese character',
    '   shows as a hollow box. The tool itself is fine.',
    '',
    '   FIX (10 seconds):',
    '     1. Right-click the TITLE BAR of this window',
    '     2. Choose "Properties"  (usually the last item)',
    '     3. Go to the "Font" tab',
    '     4. Change font to:   NSimSun    or   Consolas',
    '     5. Click OK, then close and reopen this window',
    '',
    '   Alternative: use Windows Terminal',
    '     Win11: right-click the Start button -> Terminal',
    '     It handles Chinese out of the box.',
    '',
    '  ============================================================',
    '',
    '   Press Enter to continue anyway (Chinese will be boxes) ...',
    '',
  ];
  process.stdout.write(lines.join('\n'));

  // 等待回车 —— 给用户改字体的机会。
  // stdin 不可读（管道/CI）时直接跳过，不阻塞。
  try {
    if (process.stdin.isTTY) {
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    }
  } catch {
    /* 非交互环境，直接继续 */
  }
  process.stdout.write('\n');
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
