import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = 'F:\\脚本\\cf-free-max\\repo';
const SKIP = new Set(['node_modules', '.git', '.sites', '.wrangler', 'dist']);

const report = { errors: [], warnings: [], info: [] };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT);
console.log(`扫描 ${files.length} 个文件（已跳过 .sites / node_modules / dist）\n`);

// ═══════════════════════════════════════════════
// 1. 编码检查
// ═══════════════════════════════════════════════
console.log('═══ 1. 文件编码与行尾 ═══\n');

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const buf = fs.readFileSync(f);
  const ext = path.extname(f).toLowerCase();

  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const crCount = buf.filter((b) => b === 13).length;
  const lfCount = buf.filter((b) => b === 10).length;

  // .bat 必须 GBK + CRLF + 无 BOM
  if (ext === '.bat') {
    if (hasBom) report.errors.push(`${rel}: .bat 不能有 BOM`);
    // 检测是不是合法 GBK（用 TextDecoder）
    try {
      new TextDecoder('gbk', { fatal: true }).decode(buf);
    } catch {
      report.errors.push(`${rel}: .bat 不是合法 GBK 编码`);
    }
    if (crCount === 0 && lfCount > 0) report.errors.push(`${rel}: .bat 是纯 LF，应为 CRLF`);
    if (crCount > 0 && crCount !== lfCount) report.errors.push(`${rel}: .bat 行尾混用（CR=${crCount} LF=${lfCount}）`);
  }

  // .ps1 必须 UTF-8 + BOM
  if (ext === '.ps1') {
    if (!hasBom) report.errors.push(`${rel}: .ps1 缺 BOM（PS 5.1 会按 ANSI 读，中文乱码）`);
  }

  // .mjs/.js/.json/.md 无 BOM
  if (['.mjs', '.js', '.json', '.md'].includes(ext)) {
    if (hasBom) report.errors.push(`${rel}: ${ext} 不该有 BOM`);
  }

  // 检查是否有控制字符（除了 CR/LF/TAB）
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) {
      report.errors.push(`${rel}: 第 ${i} 字节有控制字符 0x${b.toString(16)}`);
      break;
    }
  }
}

report.info.push(`编码检查完成：${files.length} 个文件`);

// ═══════════════════════════════════════════════
// 2. .bat 语法与标签检查
// ═══════════════════════════════════════════════
console.log('═══ 2. .bat 结构检查 ═══\n');

const batFile = path.join(ROOT, '启动.bat');
const batRaw = fs.readFileSync(batFile);
const batText = new TextDecoder('gbk').decode(batRaw);
const batLines = batText.split(/\r?\n/);

// 标签定义
const defined = new Set();
// 标签引用（goto / call）
const referenced = [];

for (let i = 0; i < batLines.length; i++) {
  const line = batLines[i];
  const t = line.trim();

  // 定义：行首的 :label（排除 goto 里的）
  if (/^:[a-zA-Z_]/.test(t)) defined.add(t.slice(1).trim());

  // 引用：goto :x / call :x
  const m = t.match(/\b(?:goto|call)\s+:([a-zA-Z_][\w]*)/gi);
  if (m) {
    for (const x of m) {
      const name = x.replace(/\b(?:goto|call)\s+:/i, '');
      referenced.push({ name, line: i + 1, text: t });
    }
  }
}

console.log(`  定义标签 ${defined.size} 个，引用 ${referenced.length} 处\n`);

// ⚠️ goto :eof 是 cmd 的**内置行为**（返回调用者），不需要定义标签。
//    第一版没排除它，报了 3 个假错误。
const missing = referenced.filter(
  (r) => !defined.has(r.name) && r.name.toLowerCase() !== 'eof',
);
if (missing.length) {
  for (const m of missing) {
    report.errors.push(`启动.bat:${m.line} 跳转到不存在的标签 :${m.name}  →  ${m.text.slice(0, 60)}`);
  }
} else {
  console.log('  ✔ 所有 goto/call 目标都存在');
}

// 重复定义
const seen = new Map();
for (let i = 0; i < batLines.length; i++) {
  const t = batLines[i].trim();
  if (/^:[a-zA-Z_]/.test(t)) {
    const name = t.slice(1).trim();
    if (seen.has(name)) {
      report.errors.push(`启动.bat:${i + 1} 标签 :${name} 重复定义（首次在第 ${seen.get(name)} 行）`);
    } else {
      seen.set(name, i + 1);
    }
  }
}
if (seen.size === defined.size) console.log('  ✔ 无重复标签定义');

// 检查 chcp 65001
if (/^\s*chcp\s+65001/m.test(batText)) {
  report.errors.push('启动.bat: 有 chcp 65001（GBK 批处理里会乱码）');
} else {
  console.log('  ✔ 无 chcp 65001');
}

// 检查 ) else if ( 
// ⚠️ 必须排除注释行 —— 我的文件头就写着 "批处理不支持 \" ) else if ( \" 链式语法"，
//    第一版把这个**注释文字**当成了违规代码，报了个假错误。
const elseIf = batLines.filter(
  (l) => !/^\s*REM\b/i.test(l) && !/^\s*::/.test(l) && /\)\s*else\s+if\s*\(/i.test(l),
);
if (elseIf.length) {
  report.errors.push(`启动.bat: 有 ${elseIf.length} 处 ") else if (" 链式语法（cmd 不支持，会闪退）`);
} else {
  console.log('  ✔ 无 ") else if (" 链式语法');
}

// 检查括号配对（粗略）
let parenBalance = 0;
for (let i = 0; i < batLines.length; i++) {
  const t = batLines[i].trim();
  if (t.startsWith('REM') || t.startsWith('::')) continue;
  // 只统计行尾的 ( 和 )
  const opens = (t.match(/\(/g) || []).length;
  const closes = (t.match(/\)/g) || []).length;
  parenBalance += opens - closes;
}
if (parenBalance !== 0) {
  report.warnings.push(`启动.bat: 括号粗略统计不平衡（差 ${parenBalance}）—— 可能是 echo 里的括号，需人工确认`);
} else {
  console.log('  ✔ 括号粗略配对');
}

// ═══════════════════════════════════════════════
// 3. 变量定义检查
// ═══════════════════════════════════════════════
console.log('\n═══ 3. .bat 变量定义检查 ═══\n');

// 收集所有 set "VAR=..." 定义的变量
const definedVars = new Set();
for (const line of batLines) {
  // ⚠️ 要同时匹配 set "VAR=..." 和 set /a VAR=...
  //    第一版只匹配前者，把 set /a 定义的 NEED/PCT/SAFE/D1CAP 全报成"未定义"。
  const m = line.match(/set\s+(?:\/a\s+)?"?([A-Za-z_][A-Za-z0-9_]*)=/);
  if (m) definedVars.add(m[1]);
}

// 收集所有 %VAR% 用法
const usedVars = new Map();
for (let i = 0; i < batLines.length; i++) {
  const line = batLines[i];
  // 跳过 REM
  if (/^\s*REM\b/i.test(line)) continue;
  const m = line.match(/%([A-Za-z_][A-Za-z0-9_]*)%/g);
  if (m) {
    for (const x of m) {
      const name = x.slice(1, -1);
      if (!usedVars.has(name)) usedVars.set(name, i + 1);
    }
  }
}

// 内置变量白名单
const BUILTIN = new Set([
  'CD', 'DATE', 'TIME', 'RANDOM', 'ERRORLEVEL', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
  'USERNAME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'SYSTEMROOT',
  'WINDIR', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE', 'COMPUTERNAME', 'HOMEDRIVE',
  'HOMEPATH', 'PROMPT', 'SYSTEMDRIVE', 'ALLUSERSPROFILE', 'NUMBER_OF_PROCESSORS',
]);

const undefVars = [];
for (const [name, line] of usedVars) {
  if (definedVars.has(name)) continue;
  if (BUILTIN.has(name.toUpperCase())) continue;
  undefVars.push({ name, line });
}

if (undefVars.length) {
  for (const u of undefVars) {
    report.errors.push(`启动.bat:${u.line} 使用了未定义的变量 %${u.name}%`);
  }
} else {
  console.log(`  ✔ 所有 %VAR% 都有定义（检查了 ${usedVars.size} 个变量）`);
}

// ═══════════════════════════════════════════════
// 4. Node 模块检查
// ═══════════════════════════════════════════════
console.log('\n═══ 4. Node 模块语法与导入 ═══\n');

const mjsFiles = files.filter((f) => f.endsWith('.mjs'));
let syntaxOk = 0;
for (const f of mjsFiles) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  try {
    execFileSync('node', ['--check', f], { stdio: 'pipe', timeout: 10000 });
    syntaxOk++;
  } catch (e) {
    report.errors.push(`${rel}: 语法错误 —— ${String(e.stderr).split('\n')[1] || ''}`);
  }
}
console.log(`  ${syntaxOk}/${mjsFiles.length} 个 .mjs 语法正确`);

// 检查 import 的符号是否存在
const importIssues = [];
for (const f of mjsFiles) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const content = fs.readFileSync(f, 'utf8');
  const lines = content.split('\n');

  for (const line of lines) {
    const m = line.match(/import\s+\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]/);
    if (!m) continue;
    const symbols = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const target = m[2];

    const targetPath = path.resolve(path.dirname(f), target);
    if (!fs.existsSync(targetPath)) {
      importIssues.push(`${rel}: 导入目标不存在 ${target}`);
      continue;
    }

    const targetContent = fs.readFileSync(targetPath, 'utf8');
    for (const sym of symbols) {
      const exportRe = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${sym}\\b|export\\s*\\{[^}]*\\b${sym}\\b`);
      if (!exportRe.test(targetContent)) {
        importIssues.push(`${rel}: 导入的 ${sym} 在 ${target} 里未导出`);
      }
    }
  }
}

if (importIssues.length) {
  for (const i of importIssues) report.errors.push(i);
} else {
  console.log('  ✔ 所有跨模块导入的符号都存在');
}

// ═══════════════════════════════════════════════
// 5. 命令模块是否都能加载
// ═══════════════════════════════════════════════
console.log('\n═══ 5. CLI 命令加载检查 ═══\n');

const cmdDir = path.join(ROOT, 'src', 'cmd');
const cmds = fs.readdirSync(cmdDir).filter((f) => f.endsWith('.mjs'));
let loadOk = 0;
for (const c of cmds) {
  const name = c.replace('.mjs', '');
  try {
    const out = execFileSync('node', [path.join(ROOT, 'bin', 'cfm.mjs'), name, '--help'], {
      encoding: 'utf8',
      timeout: 15000,
      cwd: ROOT,
      stdio: 'pipe',
    });
    loadOk++;
  } catch (e) {
    const err = String(e.stderr || e.message).split('\n').filter((l) => l.trim()).slice(0, 3).join(' | ');
    // help 里某些命令返回非 0 是正常的，只看是不是加载失败
    if (/SyntaxError|ReferenceError|TypeError|Cannot find|is not a function|Unexpected/.test(err)) {
      report.errors.push(`命令 ${name} 加载失败: ${err.slice(0, 120)}`);
    } else {
      loadOk++;
    }
  }
}
console.log(`  ${loadOk}/${cmds.length} 个命令模块可加载`);

// ═══════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════
console.log('');
console.log('═'.repeat(60));
console.log('排查结果');
console.log('═'.repeat(60));
console.log('');

if (report.errors.length) {
  console.log(`\x1b[31m\x1b[1m必须修（${report.errors.length}）\x1b[0m\n`);
  report.errors.forEach((e) => console.log(`  ✘ ${e}`));
  console.log('');
} else {
  console.log('\x1b[32m✔ 未发现必须修的问题\x1b[0m\n');
}

if (report.warnings.length) {
  console.log(`\x1b[33m\x1b[1m需确认（${report.warnings.length}）\x1b[0m\n`);
  report.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  console.log('');
}

process.exit(report.errors.length ? 1 : 0);
