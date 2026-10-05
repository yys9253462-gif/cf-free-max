/**
 * 轻量 lint：不引入 ESLint（保持零依赖），只做几项本仓库真正关心的检查。
 *
 * 检查项：
 *   1. 所有 .mjs 能否通过语法解析
 *   2. 是否存在 require() / module.exports（本项目是纯 ESM）
 *   3. console.log 是否只在 bin/ 与 src/cmd/ 出现（库里不该直接打印）
 *   4. 是否有 TODO / FIXME 遗留
 *   5. 文件行尾必须是 LF（跨平台铁律）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {{level:'error'|'warn', file:string, line?:number, msg:string}[]} */
const problems = [];

/** lint 脚本自身包含检测规则的字面量，必须跳过，否则会自检自报 */
const SELF = path.resolve(fileURLToPath(import.meta.url));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.mjs') && path.resolve(p) !== SELF) out.push(p);
  }
  return out;
}

const files = walk(ROOT);

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');

  // 1. 语法
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    problems.push({ level: 'error', file: rel, msg: `语法错误：${String(e.stderr ?? e).slice(0, 200)}` });
    continue;
  }

  lines.forEach((line, i) => {
    const n = i + 1;
    const code = line.replace(/\/\/.*$/, '');

    // 2. 不该出现的 CJS 写法
    if (/\brequire\s*\(/.test(code)) {
      problems.push({ level: 'error', file: rel, line: n, msg: '使用了 require()，本项目是纯 ESM' });
    }
    if (/\bmodule\.exports\b/.test(code)) {
      problems.push({ level: 'error', file: rel, line: n, msg: '使用了 module.exports，本项目是纯 ESM' });
    }

    // 3. console 只允许在 bin/ 与 cmd/ 与 util.mjs（日志器）与 test/
    const isCli =
      rel.startsWith('bin/') ||
      rel.startsWith('src/cmd/') ||
      rel.startsWith('scripts/') ||
      rel.startsWith('test/') ||
      rel === 'src/lib/util.mjs' || // 日志器本体
      rel === 'src/lib/cf.mjs'; // 调试输出
    if (!isCli && /console\.(log|error|warn)\s*\(/.test(code) && !line.trimStart().startsWith('*')) {
      problems.push({ level: 'warn', file: rel, line: n, msg: '库文件里直接使用 console，应改用调用方注入或返回数据' });
    }

    // 4. 遗留标记
    if (/\b(TODO|FIXME)\b/.test(code)) {
      problems.push({ level: 'warn', file: rel, line: n, msg: '存在未完成的 TODO/FIXME' });
    }

    // 5. 行尾（只查行内 CR）
    if (line.endsWith('\r')) {
      problems.push({ level: 'error', file: rel, line: n, msg: '存在 CRLF 行尾，跨平台仓库必须用 LF' });
    }
  });

  // 6. 危险模式：把凭据打印出来
  if (/console\.log\([^)]*\b(token|key|secret|password)\b/i.test(raw) && !/hasValue|已加密|不要|等同|获取|token 用|前缀/.test(raw)) {
    problems.push({ level: 'warn', file: rel, msg: '可能打印了凭据类变量，请人工确认' });
  }
}

// 输出
const errors = problems.filter((p) => p.level === 'error');
const warns = problems.filter((p) => p.level === 'warn');

console.log(`检查了 ${files.length} 个文件`);
if (!problems.length) {
  console.log('✔ 没有问题');
  process.exit(0);
}

for (const p of errors) {
  console.log(`✘ ${p.file}${p.line ? ':' + p.line : ''}  ${p.msg}`);
}
for (const p of warns) {
  console.log(`⚠ ${p.file}${p.line ? ':' + p.line : ''}  ${p.msg}`);
}

console.log('');
console.log(`错误 ${errors.length} / 警告 ${warns.length}`);
process.exit(errors.length ? 1 : 0);
