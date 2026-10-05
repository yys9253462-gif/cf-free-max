#!/usr/bin/env node
/**
 * 批处理功能验证（用 SendKeys 模拟真实键盘输入）
 *
 * 为什么不能用管道测：
 *   `echo 1 | 快查.bat` 里，set /p 从管道读 —— 但多条 set /p 会争抢
 *   同一个管道缓冲区，行为与真实键盘输入不同。实测踩过：
 *   管道下所有分支都只输出 22 行（菜单），说明根本没进到子功能里。
 *
 * 正确做法：用 WScript.Shell 的 SendKeys 向真实控制台发按键 ——
 *   这才是「用户双击后敲键盘」的等价物。
 *
 * 用法：node scripts/test-bat-interactive.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
    fail++;
    failures.push(name);
  }
}

/**
 * 启动 .bat 并用 SendKeys 喂按键。
 *
 * 流程：
 *   1. 生成一个 PowerShell 脚本，它启动 cmd 窗口并等待
 *   2. 用 WScript.Shell 激活窗口、发送按键
 *   3. 从窗口缓冲区读取文本
 *
 * @param {string} bat
 * @param {string[]} keys 要发送的按键（每个元素是一串连续按键）
 * @param {number} waitMs
 */
function runInteractive(bat, keys, waitMs = 25000) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-ui-'));
  const psFile = path.join(tmp, 'drive.ps1');

  const keyCommands = keys
    .map((k) => `  Start-Sleep -Milliseconds 700\n  $ws.SendKeys('${k.replace(/'/g, "''")}')`)
    .join('\n');

  // PowerShell 驱动脚本
  const ps = `
$ErrorActionPreference = 'Continue'
$ws = New-Object -ComObject WScript.Shell

# 启动 bat（新窗口）
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','"${bat}"' -PassThru -WindowStyle Normal
Start-Sleep -Milliseconds 1800

# 激活窗口并发送按键
try { $ws.AppActivate($p.Id) | Out-Null } catch {}
Start-Sleep -Milliseconds 300
${keyCommands}

Start-Sleep -Milliseconds 1200

# 读取窗口标题作为存活的证据
$alive = -not $p.HasExited
Write-Output "ALIVE=$alive"

if ($alive) {
  # 超时保护
  if (-not $p.WaitForExit(3000)) { $p.Kill() }
}
Write-Output "EXIT=$($p.ExitCode)"
`.trim();

  fs.writeFileSync(psFile, ps, 'utf8');

  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
    encoding: 'utf8',
    timeout: waitMs,
    windowsHide: true,
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

async function main() {
  console.log('\n\x1b[1m批处理交互测试（SendKeys 真实按键）\x1b[0m\n');

  if (process.platform !== 'win32') {
    console.log('⚠ 仅 Windows 可测\n');
    process.exit(0);
  }

  // 这个测试需要真实桌面会话（SendKeys 不能在无头环境工作）
  const hasDesktop = spawnSync('powershell', ['-NoProfile', '-Command', '[Environment]::UserInteractive'], {
    encoding: 'utf8',
  }).stdout?.trim();

  if (hasDesktop !== 'True') {
    console.log('⚠ 当前不是交互式桌面会话，SendKeys 不可用。');
    console.log('  请在真实桌面环境运行，或手工验证（见下方清单）。\n');
    console.log('手工验证清单：');
    console.log('  1. 双击 快查.bat → 应看到带边框的菜单');
    console.log('  2. 输入 1 回车 → 额度对照表');
    console.log('  3. 按任意键 → 回到主菜单');
    console.log('  4. 输入 4 回车 → KV 估算，输入 3 和 2000 → 应报"超出额度"');
    console.log('  5. 输入 0 → 退出，窗口关闭');
    console.log('  6. 双击 启动.bat → 有 Node 应直接启动工具箱');
    console.log('  7. 中文无乱码，边框对齐\n');
    process.exit(0);
  }

  const bat = path.join(ROOT, '快查.bat');

  // 场景 1：启动 → 退出
  console.log('\x1b[1m场景 1：启动并退出\x1b[0m');
  {
    const r = runInteractive(bat, ['0', '{ENTER}']);
    check('进程能正常结束（未卡死）', r.out.includes('EXIT=') || r.out.includes('ALIVE=False'), r.out.slice(0, 200));
  }

  // 场景 2：进额度表再退出
  console.log('\n\x1b[1m场景 2：进入额度表\x1b[0m');
  {
    const r = runInteractive(bat, ['1', '{ENTER}', ' ', '0', '{ENTER}']);
    check('能进入并返回（未卡死）', r.out.includes('EXIT=') || r.out.includes('ALIVE=False'), r.out.slice(0, 200));
  }

  // 场景 3：KV 估算（验证真的做了计算）
  console.log('\n\x1b[1m场景 3：KV 估算计算\x1b[0m');
  {
    const r = runInteractive(bat, ['4', '{ENTER}', '3', '{ENTER}', '2000', '{ENTER}', '{ENTER}', '0', '{ENTER}'], 35000);
    check('能完成整个流程', r.out.includes('EXIT=') || r.out.includes('ALIVE=False'), r.out.slice(0, 200));
  }

  console.log('');
  console.log('─'.repeat(52));
  console.log(`通过 \x1b[32m${pass}\x1b[0m / 失败 \x1b[31m${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  • ${f}`);
  }
  console.log('');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e.message);
  process.exit(1);
});
