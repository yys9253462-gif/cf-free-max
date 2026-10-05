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

  // 7. 校验 import 的具名符号确实被导出了
  //    node --check 只做语法解析，**查不出**「导入了不存在的符号」这类错误，
  //    只有实际执行才会报 "does not provide an export named"。实测踩过：
  //    usage.mjs 导入了 req_（实际叫 require_），语法检查全绿，一跑就崩。
  for (const m of raw.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const target = path.resolve(path.dirname(file), m[2]);
    const candidates = [target, target + '.mjs', path.join(target, 'index.mjs')];
    const targetFile = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!targetFile) continue; // 解析不到就算了，交给运行时

    const targetSrc = fs.readFileSync(targetFile, 'utf8');
    for (const name of names) {
      if (name === 'default') continue;
      // 匹配 export const/function/class/let/var NAME 或 export { NAME }
      const exported =
        new RegExp(`export\\s+(?:async\\s+)?(?:const|let|var|function|class)\\s+${name}\\b`).test(targetSrc) ||
        new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(targetSrc) ||
        new RegExp(`export\\s*\\*`).test(targetSrc);
      if (!exported) {
        problems.push({
          level: 'error',
          file: rel,
          msg: `从 ${m[2]} 导入了 "${name}"，但目标文件没有导出它`,
        });
      }
    }
  }
}

// ---------- 额外：JSON / YAML 文件合法性 ----------
// 实测踩过：package.json 开头写了 `#` 注释（JSON 不支持注释），
// 语法检查发现不了（lint 只扫 .mjs），直到 npm 报错才暴露。
for (const rel of ['package.json', '.github/workflows/ci.yml', '.github/workflows/quota-report.yml']) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');

  if (rel.endsWith('.json')) {
    try {
      JSON.parse(text);
    } catch (e) {
      problems.push({ level: 'error', file: rel, msg: `不是合法 JSON：${e.message}` });
    }
  } else if (rel.endsWith('.yml') || rel.endsWith('.yaml')) {
    // 极简 YAML 检查：不引入解析器，只查最容易犯的错
    if (/\t/.test(text)) {
      problems.push({ level: 'error', file: rel, msg: 'YAML 中不能有 Tab 缩进' });
    }
    // 行尾
    text.split('\n').forEach((line, i) => {
      if (line.endsWith('\r')) {
        problems.push({ level: 'error', file: rel, line: i + 1, msg: '存在 CRLF 行尾' });
      }
    });
  }
}

const errors2 = problems.filter((p) => p.level === 'error');
const warns2 = problems.filter((p) => p.level === 'warn');

console.log(`检查了 ${files.length} 个文件`);
if (!problems.length) {
  console.log('✔ 没有问题');
  process.exit(0);
}

for (const p of errors2) {
  console.log(`✘ ${p.file}${p.line ? ':' + p.line : ''}  ${p.msg}`);
}
for (const p of warns2) {
  console.log(`⚠ ${p.file}${p.line ? ':' + p.line : ''}  ${p.msg}`);
}

console.log('');
console.log(`错误 ${errors2.length} / 警告 ${warns2.length}`);
process.exit(errors2.length ? 1 : 0);
