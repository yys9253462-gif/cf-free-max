#!/usr/bin/env node
/**
 * 交互逻辑验证 —— 纯函数层，不依赖真实终端
 *
 * 为什么这样测：
 *   真实按键驱动需要 pty/ConPTY。Linux 能用 util-linux 的 `script`，
 *   Windows 没有（见 scripts/ui-smoke.mjs 的降级提示）。
 *   而交互 bug 几乎都出在**状态转移**：
 *     · 方向键越界 / 跳过 disabled 项
 *     · 数字键索引算错（0-based vs 1-based）
 *     · 全选切换逻辑反了
 *     · 重绘时行数计算错误导致界面刷屏
 *   这些都在纯函数里，可以直接断言。
 *
 *   所以 prompt.mjs 把逻辑抽成了可导出的纯函数，
 *   select()/multiSelect() 内部调用的就是它们 —— 测的就是实际跑的代码。
 *
 * 用法：node scripts/ui-logic-test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  handleSelectKey,
  handleMultiSelectKey,
  computeRedraw,
  renderSelect,
  renderMultiSelect,
  nextEnabled,
} from '../src/lib/prompt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    pass++;
  } catch (e) {
    console.log(`  \x1b[31m✘\x1b[0m ${name}`);
    console.log(`      ${e.message.split('\n')[0]}`);
    fail++;
    failures.push(name);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const C3 = [
  { label: 'A', value: 'a' },
  { label: 'B', value: 'b' },
  { label: 'C', value: 'c' },
];

// ═══════════════════════════════════════════════════
section('nextEnabled：跳过禁用项');

check('向下移动正常', () => {
  assert.equal(nextEnabled(C3, 0, 1), 1);
  assert.equal(nextEnabled(C3, 1, 1), 2);
});

check('向下越过末尾回绕到开头', () => {
  assert.equal(nextEnabled(C3, 2, 1), 0);
});

check('向上越过开头回绕到末尾', () => {
  assert.equal(nextEnabled(C3, 0, -1), 2);
});

check('跳过中间的禁用项', () => {
  const c = [{ value: 1 }, { value: 2, disabled: true }, { value: 3 }];
  assert.equal(nextEnabled(c, 0, 1), 2, '应跳过 disabled 的中间项');
  assert.equal(nextEnabled(c, 2, -1), 0, '反向也应跳过');
});

check('全部禁用时原地不动', () => {
  const c = [{ value: 1, disabled: true }, { value: 2, disabled: true }];
  assert.equal(nextEnabled(c, 0, 1), 0);
});

check('空数组返回 -1', () => {
  assert.equal(nextEnabled([], 0, 1), -1);
});

// ═══════════════════════════════════════════════════
section('handleSelectKey：单选按键');

check('下箭头 → move', () => {
  const r = handleSelectKey({ name: 'down' }, undefined, 0, C3);
  assert.deepEqual(r, { type: 'move', index: 1 });
});

check('上箭头 → move', () => {
  const r = handleSelectKey({ name: 'up' }, undefined, 2, C3);
  assert.deepEqual(r, { type: 'move', index: 1 });
});

check('j/k 也能移动（vim 风格）', () => {
  assert.equal(handleSelectKey({ name: 'j' }, undefined, 0, C3).index, 1);
  assert.equal(handleSelectKey({ name: 'k' }, undefined, 2, C3).index, 1);
});

check('home → 第一项', () => {
  const r = handleSelectKey({ name: 'home' }, undefined, 2, C3);
  assert.equal(r.index, 0);
});

check('end → 最后一项', () => {
  const r = handleSelectKey({ name: 'end' }, undefined, 0, C3);
  assert.equal(r.index, 2);
});

check('回车 → select 当前项', () => {
  const r = handleSelectKey({ name: 'return' }, undefined, 1, C3);
  assert.deepEqual(r, { type: 'select', value: 'b' });
});

check('回车落在禁用项 → noop（不选中）', () => {
  const c = [{ value: 'x', disabled: true }];
  const r = handleSelectKey({ name: 'return' }, undefined, 0, c);
  assert.equal(r.type, 'noop');
});

check('数字键 1-9 直达（注意 0-based 换算）', () => {
  assert.deepEqual(handleSelectKey({ name: '1' }, '1', 0, C3), { type: 'select', value: 'a' });
  assert.deepEqual(handleSelectKey({ name: '3' }, '3', 0, C3), { type: 'select', value: 'c' });
});

check('数字键超出范围 → noop', () => {
  assert.equal(handleSelectKey({ name: '9' }, '9', 0, C3).type, 'noop');
});

check('数字键指向禁用项 → noop', () => {
  const c = [{ value: 'x' }, { value: 'y', disabled: true }];
  assert.equal(handleSelectKey({ name: '2' }, '2', 0, c).type, 'noop');
});

check('q → back', () => {
  assert.equal(handleSelectKey({ name: 'q' }, undefined, 0, C3).type, 'back');
});

check('Ctrl+C → abort', () => {
  assert.equal(handleSelectKey({ name: 'c', ctrl: true }, undefined, 0, C3).type, 'abort');
});

check('无关键 → noop', () => {
  assert.equal(handleSelectKey({ name: 'x' }, undefined, 0, C3).type, 'noop');
  assert.equal(handleSelectKey({}, undefined, 0, C3).type, 'noop');
});

// ═══════════════════════════════════════════════════
section('handleMultiSelectKey：多选按键');

check('空格勾选 / 取消勾选', () => {
  let checked = new Set();
  let r = handleMultiSelectKey({ name: 'space' }, ' ', 1, C3, checked);
  assert.deepEqual([...r.checked], [1], '首次空格应勾选');

  r = handleMultiSelectKey({ name: 'space' }, ' ', 1, C3, r.checked);
  assert.equal(r.checked.size, 0, '再次空格应取消');
});

check('方向键不改变勾选状态', () => {
  const checked = new Set([0]);
  const r = handleMultiSelectKey({ name: 'down' }, undefined, 0, C3, checked);
  assert.equal(r.type, 'redraw');
  assert.equal(r.index, 1);
  assert.deepEqual([...r.checked], [0], '移动不应影响勾选');
});

check('a 全选（未全选时）', () => {
  const r = handleMultiSelectKey({ name: 'a' }, 'a', 0, C3, new Set([0]));
  assert.equal(r.checked.size, 3, '应全选');
});

check('a 全不选（已全选时）', () => {
  const r = handleMultiSelectKey({ name: 'a' }, 'a', 0, C3, new Set([0, 1, 2]));
  assert.equal(r.checked.size, 0, '应全不选');
});

check('回车返回勾选项的 value，按索引排序', () => {
  const r = handleMultiSelectKey({ name: 'return' }, undefined, 0, C3, new Set([2, 0]));
  assert.deepEqual(r.values, ['a', 'c'], '应按索引顺序返回 value');
});

check('没勾选任何项时回车返回空数组', () => {
  const r = handleMultiSelectKey({ name: 'return' }, undefined, 0, C3, new Set());
  assert.deepEqual(r.values, []);
});

check('q → back', () => {
  assert.equal(handleMultiSelectKey({ name: 'q' }, undefined, 0, C3, new Set()).type, 'back');
});

check('原 checked 集合不被修改（纯函数）', () => {
  const original = new Set([0]);
  handleMultiSelectKey({ name: 'space' }, ' ', 1, C3, original);
  assert.deepEqual([...original], [0], '传入的 Set 不应被就地修改');
});

// ═══════════════════════════════════════════════════
section('computeRedraw：防刷屏');

check('首次绘制不回退光标', () => {
  const r = computeRedraw('line1\nline2', 0);
  assert.ok(!r.output.includes('\x1b[') || !/\x1b\[\d+A/.test(r.output), '首次不应有光标上移');
  assert.equal(r.lines, 2);
});

check('重绘时回退已画的行数', () => {
  const r = computeRedraw('a\nb\nc', 3);
  assert.ok(r.output.startsWith('\x1b[3A'), `应以 ESC[3A 开头，实际：${JSON.stringify(r.output.slice(0, 10))}`);
});

check('行数变少时清理残留行', () => {
  const r = computeRedraw('a', 5);
  // 应为：回退 5 行 + 画 1 行 + 清 4 个残留行
  const clearCount = (r.output.match(/\x1b\[2K/g) || []).length;
  assert.ok(clearCount >= 4, `应清理至少 4 个残留行，实际 ${clearCount}`);
});

check('行数计算正确（含空行）', () => {
  assert.equal(computeRedraw('a\nb\n\n', 0).lines, 4);
  assert.equal(computeRedraw('single', 0).lines, 1);
});

// ═══════════════════════════════════════════════════
section('renderSelect：菜单渲染');

check('渲染所有选项', () => {
  const s = renderSelect('标题', C3, 0);
  assert.ok(s.includes('标题'));
  assert.ok(s.includes('A') && s.includes('B') && s.includes('C'));
});

check('光标指向当前项', () => {
  const s = renderSelect('t', C3, 1);
  const lines = s.split('\n');
  const bLine = lines.find((l) => l.includes('B'));
  const aLine = lines.find((l) => l.includes('A'));
  assert.ok(bLine.includes('❯'), 'B 行应有光标');
  assert.ok(!aLine.includes('❯'), 'A 行不应有光标');
});

check('显示序号（1-based，两位对齐）', () => {
  const s = renderSelect('t', C3, 0);
  assert.ok(s.includes(' 1.'), '应显示 " 1."');
  assert.ok(s.includes(' 3.'), '应显示 " 3."');
});

check('禁用项有明确标记', () => {
  const s = renderSelect('t', [{ label: 'X', value: 1, disabled: true }], 0);
  assert.ok(s.includes('禁用'), '禁用项应可辨识（不能只靠颜色）');
});

check('提示行含关键按键说明', () => {
  const s = renderSelect('t', C3, 0);
  assert.ok(s.includes('回车'), '应提示回车');
  assert.ok(s.includes('q'), '应提示 q 返回');
});

check('纯文本模式不含 ANSI 转义（可安全写入日志）', () => {
  const s = renderSelect('t', C3, 0);
  assert.ok(!/\x1b\[/.test(s), `不应含 ANSI：${JSON.stringify(s.slice(0, 60))}`);
});

// ═══════════════════════════════════════════════════
section('renderMultiSelect：多选渲染');

check('渲染勾选状态', () => {
  const s = renderMultiSelect('t', C3, 0, new Set([0, 2]));
  assert.ok(s.includes('◉'), '应有已勾选标记');
  assert.ok(s.includes('○'), '应有未勾选标记');
});

check('提示行含空格与 a', () => {
  const s = renderMultiSelect('t', C3, 0, new Set());
  assert.ok(s.includes('空格'), '应提示空格勾选');
  assert.ok(s.includes('a'), '应提示 a 全选');
});

check('纯文本模式无 ANSI', () => {
  const s = renderMultiSelect('t', C3, 0, new Set());
  assert.ok(!/\x1b\[/.test(s));
});

// ═══════════════════════════════════════════════════
section('UI 菜单结构完整性');

check('主菜单每项都有 switch 分支', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/cmd/ui.mjs'), 'utf8');
  const menuMatch = src.match(/你想做什么[\s\S]*?\n\s*\]\);/);
  assert.ok(menuMatch, '找不到主菜单定义');

  const values = [...menuMatch[0].matchAll(/value:\s*'([^']+)'/g)].map((m) => m[1]);
  const switchMatch = src.match(/switch \(choice\) \{([\s\S]*?)\n    \}\n  \}/);
  const cases = switchMatch ? [...switchMatch[1].matchAll(/case '([^']+)'/g)].map((m) => m[1]) : [];

  const missing = values.filter((v) => v !== 'exit' && !cases.includes(v));
  assert.equal(missing.length, 0, `缺分支：${missing.join(', ')}`);
});

check('ui 调用的命令模块都存在', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/cmd/ui.mjs'), 'utf8');
  const invoked = [...new Set([...src.matchAll(/invoke\('([a-z0-9]+)'/g)].map((m) => m[1]))];
  const missing = invoked.filter((cmd) => !fs.existsSync(path.join(ROOT, 'src/cmd', `${cmd}.mjs`)));
  assert.equal(missing.length, 0, `缺失模块：${missing.join(', ')}`);
});

check('每个二级菜单都有返回项（防止用户被困住）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/cmd/ui.mjs'), 'utf8');
  // 匹配所有 p.select(...) 调用里的选项数组
  const selects = [...src.matchAll(/p\.select\(\s*[`'"]([^`'"]+)[`'"]\s*,\s*\[([\s\S]*?)\]\s*\)/g)];
  const noBack = [];
  for (const m of selects) {
    const title = m[1];
    const body = m[2];
    // 主菜单允许只有 "退出"
    if (title.includes('你想做什么')) continue;
    if (!body.includes("'返回'") && !body.includes('"返回"')) noBack.push(title);
  }
  assert.equal(noBack.length, 0, `这些菜单没有返回项：${noBack.join(' | ')}`);
});

// ═══════════════════════════════════════════════════
console.log('');
console.log('─'.repeat(50));
console.log(`通过 \x1b[32m${pass}\x1b[0m / 失败 \x1b[31m${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  • ${f}`);
}
console.log('');
process.exit(fail ? 1 : 0);
