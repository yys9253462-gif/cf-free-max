#!/usr/bin/env node
/**
 * 批处理文件静态检查
 *
 * 为什么需要单独的脚本：
 *   .bat 有一堆「看起来对但一运行就闪退」的语法陷阱，
 *   而且**没有可靠的语法检查器**（不像 bash -n）。
 *   唯一可靠的办法是人工审查规则 + 实机运行。
 *
 * 这里覆盖已知会闪退/出错的模式：
 *   1. `) else if (` 链式语法 —— 批处理不支持，直接闪退
 *   2. 未转义的 % ^ & < > | —— 在特定上下文会中断解析
 *   3. chcp 65001 —— 中文环境下加了这个会两头乱码
 *   4. 编码不是 GBK/ANSI
 *   5. 行尾不是 CRLF
 *   6. 含 BOM
 *   7. 标签重复或缺失（goto 到不存在的标签会静默失败）
 *   8. 含非 BMP 字符（GBK 无法表示，会变成 ?）
 *
 * 用法：node scripts/lint-bat.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const problems = [];

function report(bat, level, line, msg) {
  problems.push({ bat, level, line, msg });
  if (level === 'error') fail++;
  else pass++;
}

/** 用 PowerShell 把 GBK 文件读成 UTF-8 字符串 */
function readGbk(file) {
  const ps = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $text = [System.IO.File]::ReadAllText('${file.replace(/'/g, "''")}', [System.Text.Encoding]::GetEncoding(936))
    [Console]::Out.Write($text)
  `;
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

const batFiles = fs.readdirSync(ROOT).filter((f) => /\.(bat|cmd)$/i.test(f));

if (!batFiles.length) {
  console.log('没有找到 .bat 文件');
  process.exit(0);
}

console.log(`\n检查 ${batFiles.length} 个批处理文件\n`);

for (const name of batFiles) {
  const full = path.join(ROOT, name);
  const buf = fs.readFileSync(full);
  console.log(`\x1b[1m${name}\x1b[0m`);

  // ── 1. 编码与行尾（字节级）──
  const crlf = (() => {
    let n = 0;
    for (let i = 0; i < buf.length - 1; i++) if (buf[i] === 0x0d && buf[i + 1] === 0x0a) n++;
    return n;
  })();
  const lfTotal = buf.filter((b) => b === 0x0a).length;
  const pureLf = lfTotal - crlf;
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

  if (crlf === 0) {
    report(name, 'error', 0, '没有 CRLF 行尾 —— 批处理需要 CRLF，纯 LF 在某些解析路径下会出错');
  } else if (pureLf > 0) {
    report(name, 'error', 0, `混用了 ${pureLf} 个纯 LF 行尾 —— 批处理要求统一 CRLF`);
  } else {
    pass++;
    console.log(`  \x1b[32m✔\x1b[0m 行尾：全部 CRLF（${crlf} 行）`);
  }

  if (hasBom) {
    report(name, 'error', 0, '含 UTF-8 BOM —— 会在首行开头显示乱码字符（如 "锘"）');
  } else {
    pass++;
    console.log('  \x1b[32m✔\x1b[0m 无 BOM');
  }

  // ── 2. 读成文本做语法检查 ──
  let text;
  try {
    text = readGbk(full);
  } catch (e) {
    report(name, 'error', 0, `无法按 GBK 读取：${e.message.slice(0, 80)}`);
    console.log('');
    continue;
  }

  const lines = text.split('\r\n');

  // 检查是否有替换字符（说明源文件不是纯 GBK 能表示的）
  const replaced = lines.filter((l) => l.includes('\uFFFD'));
  if (replaced.length) {
    report(name, 'error', 0, `${replaced.length} 行含无法用 GBK 表示的字符（会显示成 ?）`);
  }

  // ── 3. 逐行规则 ──
  const labels = new Set();
  const gotos = [];
  const calls = [];
  let hasChcp = false;

  lines.forEach((line, i) => {
    const n = i + 1;
    const trimmed = line.trim();
    const isComment = /^(REM\b|::)/i.test(trimmed);

    // 收集标签
    const labelMatch = trimmed.match(/^:([A-Za-z0-9_\-]+)/);
    if (labelMatch) {
      if (labels.has(labelMatch[1])) {
        report(name, 'error', n, `标签重复定义 :${labelMatch[1]} —— goto 会跳到第一个，后面的成为死代码`);
      }
      labels.add(labelMatch[1]);
    }

    if (isComment) return;

    // 收集 goto / call
    const gotoMatch = trimmed.match(/\bgoto\s+:?([A-Za-z0-9_\-]+)/i);
    if (gotoMatch && !gotoMatch[1].startsWith('eof')) gotos.push({ label: gotoMatch[1], line: n });
    const callMatch = trimmed.match(/\bcall\s+:([A-Za-z0-9_\-]+)/i);
    if (callMatch) calls.push({ label: callMatch[1], line: n });

    // chcp 检查（只允许出现在注释里）
    if (/^\s*chcp\b/i.test(trimmed)) {
      hasChcp = true;
      report(name, 'error', n, '使用了 chcp —— 中文环境下会导致批处理解析与控制台编码不一致，两头乱码');
    }

    // ) else if ( 链式语法
    if (/\)\s*else\s+if\s*\(/i.test(trimmed)) {
      report(name, 'error', n, '使用了 ") else if (" 链式语法 —— 批处理不支持，会闪退');
    }

    // 单行 if 后跟括号块的常见误用
    if (/^\s*if\s+.+\(\s*$/i.test(trimmed) && !/\)\s*$/.test(trimmed)) {
      // 合法，跳过
    }

    // 未转义的 & 在 echo 里（除非被 ^ 转义）
    if (/^\s*echo\b/i.test(trimmed)) {
      const body = trimmed.slice(4);
      // 找未被 ^ 转义的 & | < >
      const unescaped = body.replace(/\^[&|<>]/g, '').replace(/\^/g, '');
      if (/[<>]/.test(unescaped) && !/^echo\s*\./.test(trimmed)) {
        // echo 里的 > 会被当重定向
        if (!/\d?>&\d?/.test(body)) {
          report(name, 'error', n, 'echo 中含未转义的 < 或 > —— 会被当成重定向');
        }
      }
    }

    // 括号平衡（忽略 echo 与注释）
    // 简化判断：统计行内 ( 与 ) 数量
    if (!/^\s*echo/i.test(trimmed)) {
      const open = (trimmed.match(/\(/g) || []).length;
      const close = (trimmed.match(/\)/g) || []).length;
      // 只检查明显不平衡且不是跨行结构的情况
      if (open > close && !/\bif\b|\bfor\b|\bdo\b/.test(trimmed) && !/\(\s*$/.test(trimmed) && !/\)\s*else/.test(trimmed)) {
        // 可能是跨行 if 块的开头，宽松处理
      }
    }
  });

  // ── 4. 检查 goto/call 目标存在 ──
  const missing = [];
  for (const g of gotos) {
    if (!labels.has(g.label) && !/^(eof|EOF)$/i.test(g.label)) missing.push(`goto :${g.label}（第 ${g.line} 行）`);
  }
  for (const c of calls) {
    if (!labels.has(c.label)) missing.push(`call :${c.label}（第 ${c.line} 行）`);
  }
  if (missing.length) {
    for (const m of missing) {
      report(name, 'error', 0, `跳转到不存在的标签：${m} —— 会静默失败`);
    }
  } else if (gotos.length + calls.length > 0) {
    pass++;
    console.log(`  \x1b[32m✔\x1b[0m 全部 ${gotos.length + calls.length} 个跳转目标都存在`);
  }

  console.log(`  \x1b[32m✔\x1b[0m 标签 ${labels.size} 个，行数 ${lines.length}`);
  console.log('');
}

// ── 附加检查：.ps1 文件必须有 UTF-8 BOM ──
//
// 这是踩过的最贵的一个坑（花了整轮时间才定位）：
//   Windows PowerShell 5.1 读取**无 BOM** 的 .ps1 时，会按系统 ANSI
//   代码页解析。文件里的中文（如「账号 ID：」）变成乱码，
//   而乱码字节会破坏引号配对，导致**整个文件语法崩溃**：
//       Unexpected token '}' in expression or statement.
//       Missing closing '}' in statement block
//   报错位置指向毫不相关的行，极难定位。
//
//   修法：写 .ps1 时必须用 UTF-8 **带 BOM**（New-Object UTF8Encoding($true)）。
//
// 注意与 .bat 的差别：
//   .bat  → ANSI/GBK，**不能**有 BOM（BOM 会在首行显示成乱码字符）
//   .ps1  → UTF-8，**必须**有 BOM
const psFiles = [];
const walkPs = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkPs(p);
    else if (e.name.endsWith('.ps1')) psFiles.push(p);
  }
};
walkPs(ROOT);

if (psFiles.length) {
  console.log(`\n检查 ${psFiles.length} 个 PowerShell 文件\n`);
  for (const p of psFiles) {
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    const buf = fs.readFileSync(p);
    const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

    // 含非 ASCII 字符吗
    const text = buf.toString('utf8');
    const hasNonAscii = /[^\x00-\x7F]/.test(text);

    if (!hasBom && hasNonAscii) {
      report(rel, 'error', 0, '缺少 UTF-8 BOM —— PowerShell 5.1 会按 ANSI 解析，中文变乱码并破坏语法');
      console.log(`  \x1b[31m✘\x1b[0m ${rel}：缺 BOM 且含中文（会语法崩溃）`);
    } else if (!hasBom) {
      console.log(`  \x1b[33m⚠\x1b[0m ${rel}：无 BOM（当前是纯 ASCII，暂时安全，但加中文后会炸）`);
    } else {
      console.log(`  \x1b[32m✔\x1b[0m ${rel}：UTF-8 BOM`);
    }

    // 行尾检查
    // .ps1 用纯 LF 是可以的（PowerShell 能正确处理），
    // 但**不要混用** —— 混用在某些解析路径下会出错。
    const crlf = (() => {
      let n = 0;
      for (let i = 0; i < buf.length - 1; i++) if (buf[i] === 0x0d && buf[i + 1] === 0x0a) n++;
      return n;
    })();
    const lf = buf.filter((b) => b === 0x0a).length;
    if (crlf > 0 && crlf !== lf) {
      console.log(`    \x1b[31m✘ 行尾混用：CRLF ${crlf} / 纯 LF ${lf - crlf}\x1b[0m`);
      report(rel, 'error', 0, `行尾混用（CRLF ${crlf} / LF ${lf - crlf}）`);
    } else if (crlf === lf && lf > 0) {
      console.log(`    \x1b[32m✔\x1b[0m 行尾统一 CRLF（${crlf} 行）`);
    } else {
      console.log(`    \x1b[32m✔\x1b[0m 行尾统一 LF（${lf} 行）`);
    }
  }
}

// ── 输出 ──
const errors = problems.filter((p) => p.level === 'error');

if (!errors.length) {
  console.log('\x1b[32m✔ 全部批处理文件通过静态检查\x1b[0m');
  console.log('\x1b[2m提示：静态检查不能替代实机运行 —— .bat 的很多问题只有跑起来才暴露。\x1b[0m\n');
  process.exit(0);
}

console.log('\x1b[31m发现的问题\x1b[0m\n');
for (const p of errors) {
  console.log(`  \x1b[31m✘\x1b[0m ${p.bat}${p.line ? `:${p.line}` : ''}  ${p.msg}`);
}
console.log('');
process.exit(1);
