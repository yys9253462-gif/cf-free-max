#!/usr/bin/env node
/**
 * 批处理冒烟测试 —— 验证「能启动、能退出、不卡死」
 *
 * ⚠️ 关于测试方式的教训（重要）：
 *
 *   我最初用 `echo 0 | 快查.bat` 这种管道喂输入来测，结果是**假失败**：
 *   19 项断言全挂，看起来脚本坏透了。但真相是：
 *
 *     1. cmd 的 `set /p` 从管道读取时，多条 set /p 会争抢同一个缓冲区，
 *        行为与真实键盘输入完全不同 —— 管道里第二个 set /p 往往读到空值。
 *        实测：所有分支都只输出 22 行（卡在主菜单），根本没进子功能。
 *     2. 管道喂入还会让 `timeout` 报 "输入重定向不受支持" 而立即返回。
 *     3. 多行管道输入会被第一个 set /p 一次性吃掉。
 *
 *   结论：**管道测不了交互式批处理**。正确做法有两个：
 *     · 用 SendKeys 模拟真实按键 → 见 test-bat-interactive.mjs（已全过）
 *     · 只用管道验证「能启动 + 无输入时能干净退出」——本文件做的事
 *
 *   所以本文件只测三件事：
 *     · 脚本能启动并渲染出菜单
 *     · 输入耗尽时能退出而不是死循环
 *     · 关键文案存在（额度表数据、提示语）
 *
 * 用法：node scripts/test-bat.mjs
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

/** GBK 解码（Node 18+ 的 full-icu 构建支持） */
function decode(buf) {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * 运行 .bat，喂入指定输入，捕获输出。
 *
 * ⚠️ 两个必须注意的坑：
 *
 *   1. **驱动脚本要用 GBK 写，不能用 ascii**
 *      项目路径含中文（F:\脚本\...），ascii 编码会把中文变成 "?"，
 *      cmd 报 "The system cannot find the path specified"。
 *      实测踩过，一度误判成脚本本身坏了。
 *
 *   2. **不能用管道测交互**
 *      cmd 的 set /p 从管道读取时，多条 set /p 会争抢同一个缓冲区，
 *      行为与真实键盘完全不同。管道只适合测「能启动 + 无输入能退出」。
 *
 *   GBK 编码通过 PowerShell 的 .NET Encoding 完成（Node 无内置 GBK 编码器）。
 */
function runBat(batName, inputs, timeoutMs = 20000) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-bat-'));
  const outFile = path.join(tmp, 'out.txt');
  const driver = path.join(tmp, 'd.cmd');

  const script = [
    '@echo off',
    `cd /d "${ROOT}"`,
    `call "${path.join(ROOT, batName)}" > "${outFile}" 2>&1`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');

  writeGbk(driver, script);

  const r = spawnSync('cmd', ['/c', driver], {
    input: Buffer.from(inputs.join('\r\n') + '\r\n', 'utf8'),
    timeout: timeoutMs,
    encoding: 'buffer',
    windowsHide: true,
  });

  let out = '';
  if (fs.existsSync(outFile)) out = decode(fs.readFileSync(outFile));
  if (r.stdout) out += decode(r.stdout);

  fs.rmSync(tmp, { recursive: true, force: true });
  return { out, status: r.status, timedOut: r.error?.code === 'ETIMEDOUT' };
}

/**
 * 用 GBK(CP936) 写文件，无 BOM。
 *
 * Node 没有内置的 GBK 编码器（TextDecoder 只能解码不能编码），
 * 所以借 PowerShell 的 .NET Encoding 类完成。
 *
 * 传内容走临时 UTF-8 文件而不是命令行参数 —— 命令行长内容会被截断，
 * 且中文参数在 PowerShell 命令行里还要过一层编码，容易出错。
 */
function writeGbk(file, text) {
  const tmpSrc = `${file}.utf8`;
  fs.writeFileSync(tmpSrc, text, 'utf8');

  const ps = `
$ErrorActionPreference = 'Stop'
$gbk = [System.Text.Encoding]::GetEncoding(936)
$text = [System.IO.File]::ReadAllText('${tmpSrc.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText('${file.replace(/'/g, "''")}', $text, $gbk)
`.trim();

  // PowerShell 脚本本身要带 BOM 写，否则 5.1 按 ANSI 解析中文路径会乱码
  const tmpPs = `${file}.ps1`;
  fs.writeFileSync(tmpPs, '\uFEFF' + ps, 'utf8');

  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpPs], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });

  fs.rmSync(tmpSrc, { force: true });
  fs.rmSync(tmpPs, { force: true });

  if (r.status !== 0) {
    throw new Error(`GBK 写入失败：${(r.stderr ?? '').slice(0, 200)}`);
  }
}

async function main() {
  console.log('\n\x1b[1m批处理冒烟测试\x1b[0m');
  console.log('\x1b[2m（交互功能见 test-bat-interactive.mjs —— 管道测不了 set /p）\x1b[0m\n');

  if (process.platform !== 'win32') {
    console.log('⚠ 非 Windows，跳过\n');
    process.exit(0);
  }

  // ═══════════════════════════════════════════
  console.log('\x1b[1m快查.bat — 启动与渲染\x1b[0m');

  {
    const r = runBat('快查.bat', ['0']);
    check('能启动', r.out.length > 0, '没有输出');
    check('未超时（不会卡死）', !r.timedOut, '20 秒未结束');
    check('渲染了标题框', r.out.includes('╔') && r.out.includes('╝'), '缺少边框');
    check('渲染了菜单标题', r.out.includes('Cloudflare') && r.out.includes('免费额度'));
    check('渲染了全部菜单项 [1]~[7]', ['[1]', '[2]', '[3]', '[4]', '[5]', '[6]', '[7]'].every((x) => r.out.includes(x)));
    check('渲染了退出项 [0]', r.out.includes('[0]'));
    check('显示了凭据状态', r.out.includes('凭据'));
  }

  // ═══════════════════════════════════════════
  console.log('\n\x1b[1m快查.bat — 输入耗尽保护\x1b[0m');

  {
    // 关键回归测试：不喂任何输入时，脚本必须退出而不是死循环刷屏。
    // 实测踩过：最初没有 EOF 检测，管道下会无限重建菜单。
    const r = runBat('快查.bat', [], 12000);
    check('无输入时能退出（EOF 检测有效）', !r.timedOut, '无输入时死循环了 —— set /p 的 EOF 保护失效');

    const menuCount = (r.out.match(/Cloudflare 免费额度工具箱/g) || []).length;
    check('菜单没有重复刷屏', menuCount <= 2, `主菜单渲染了 ${menuCount} 次，说明在循环`);
  }

  // ═══════════════════════════════════════════
  console.log('\n\x1b[1m快查.bat — 额度表内容\x1b[0m');

  {
    // 用「先选 1，再任意输入退出」的方式。管道下 set /p 的行为受限，
    // 所以这里只验证**额度表的数据本身**是否正确（它在脚本里是静态文本，
    // 不依赖交互）—— 通过直接搜索脚本文本来验证，更可靠。
    const gbk = fs.readFileSync(path.join(ROOT, '快查.bat'));
    const text = decode(gbk);

    check('含 Workers 额度 100,000', text.includes('100,000'));
    check('含 KV 写入 1,000', text.includes('1,000'));
    check('含 D1 扫描行 5,000,000', text.includes('5,000,000'));
    check('含 R2 出站免费说明', text.includes('出站') && text.includes('不限量'));
    check('含 Pages 构建 500', text.includes('500'));
    check('含踩坑清单', text.includes('最容易踩') && text.includes('KV 每天'));
    check('含 D1 全表扫描警告', text.includes('扫描行数') || text.includes('全表扫描'));

    check('提示 R2 是最大卖点', text.includes('最大卖点'));
    check('有配置凭据的引导', text.includes('api-tokens'));
  }

  // ═══════════════════════════════════════════
  console.log('\n\x1b[1m启动.bat — 启动与降级\x1b[0m');

  {
    const r = runBat('启动.bat', ['n'], 20000);
    const hasNode = spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true }).status === 0;

    if (hasNode) {
      check('检测到系统 Node', r.out.includes('使用系统 Node') || r.out.includes('Node'), r.out.slice(0, 200));
      check('没有触发下载', !r.out.includes('30 MB') && !r.out.includes('下载便携版'), '有 Node 时不该下载');
    } else {
      check('无 Node 时给出说明', r.out.includes('Node') && (r.out.includes('下载') || r.out.includes('便携版')));
    }
  }

  {
    // 源码缺失场景：单独放下 .bat，应给出清晰错误
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-nosrc-'));
    fs.writeFileSync(path.join(tmp, 'launcher.bat'), fs.readFileSync(path.join(ROOT, '启动.bat')));
    const outFile = path.join(tmp, 'out.txt');
    const driver = path.join(tmp, 'd.cmd');
    writeGbk(
      driver,
      ['@echo off', `cd /d "${tmp}"`, `call "${path.join(tmp, 'launcher.bat')}" > "${outFile}" 2>&1`, 'exit /b 0', ''].join('\r\n'),
    );
    spawnSync('cmd', ['/c', driver], { timeout: 15000, windowsHide: true, input: Buffer.from('\r\n') });

    const out = fs.existsSync(outFile) ? decode(fs.readFileSync(outFile)) : '';
    check('源码缺失时给出清晰错误', out.includes('找不到') || out.includes('必须'), `实际输出：${out.slice(0, 150)}`);
    check('指引用户去下载完整包', out.includes('github') || out.includes('releases'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════
  console.log('');
  console.log('─'.repeat(54));
  console.log(`通过 \x1b[32m${pass}\x1b[0m / 失败 \x1b[31m${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  • ${f}`);
  }
  console.log('');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
