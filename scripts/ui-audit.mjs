#!/usr/bin/env node
/**
 * UI 走查 —— 静态分析所有菜单，找出体验问题
 *
 * 人工点一遍很慢且容易漏，这里用静态分析把可疑点全列出来：
 *   1. 需要凭据但没做前置检查的菜单
 *   2. 危险操作缺少确认
 *   3. 没有「返回」入口的菜单（用户会被困住）
 *   4. 需要用户输入但没有校验/默认值的
 *   5. 菜单项指向了不存在的 value 分支
 *   6. 长时间操作没有进度反馈
 *   7. 错误处理缺失（没有 try/catch 的 await）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'src', 'cmd', 'ui.mjs');
const src = fs.readFileSync(UI, 'utf8');
const lines = src.split('\n');

const issues = [];
function report(level, area, line, msg, hint) {
  issues.push({ level, area, line, msg, hint });
}

/**
 * 白名单：明确「有意为之」的例外。
 *
 * 走查是给人看的，不是给机器打分 —— 有些告警是设计决定而非缺陷。
 * 把它们显式记下来（连同理由），比调松检测规则更好：
 * 规则保持严格，例外逐个说明，将来 review 时能看懂为什么。
 */
const SUPPRESS = [
  {
    area: 'deployMenu',
    rule: '需要凭据但菜单入口没有 ensureCreds 检查',
    why: 'deployMenu 的「查看配置」「环境体检」是纯本地只读操作，无凭据也能用。'
      + '加统一检查会把这些有用功能一起挡掉，所以只在「部署」按钮里单独判断。',
  },
  {
    area: '菜单结构',
    rule: '「选择操作」的选项没有对应分支：budget',
    why: 'kvMenu 的 budget 分支确实存在（if (choice === \'budget\')），'
      + '是走查的文本窗口截断导致的误报。',
  },
  {
    area: '菜单结构',
    rule: '「选择操作」的选项没有对应分支：connections, ingress, setup',
    why: 'tunnelMenu 把 choice 直接当子命令名透传给命令（用途 B），'
      + '已加运行时白名单校验保证安全。',
  },
];

function suppressed(issue) {
  return SUPPRESS.find((s) => issue.area === s.area && issue.msg.includes(s.rule.replace(/^.*：/, '')));
}

// ═══════════════════════════════════════════════════════
// 1. 找出所有菜单函数
// ═══════════════════════════════════════════════════════
const menuFns = [];
lines.forEach((l, i) => {
  const m = l.match(/^async function (\w*Menu\w*|\w*View\w*|wizard)\(/);
  if (m) menuFns.push({ name: m[1], line: i + 1 });
});

console.log(`找到 ${menuFns.length} 个菜单函数\n`);

// 提取每个函数的源码体（从函数定义到下一个顶层 function）
function getFnBody(name) {
  const startIdx = lines.findIndex((l) => new RegExp(`^async function ${name}\\(`).test(l));
  if (startIdx === -1) return '';
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^(async )?function \w+\(/.test(lines[i]) || /^\/\/ ══/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

// ═══════════════════════════════════════════════════════
// 2. 逐项检查
// ═══════════════════════════════════════════════════════

const NEEDS_CREDS = ['usage', 'doctor', 'audit', 'dns', 'cache', 'zone', 'r2', 'workers', 'kv', 'd1', 'pages', 'tunnel', 'wizard', 'deploy'];

for (const fn of menuFns) {
  const body = getFnBody(fn.name);
  const isMenu = /p\.select\(/.test(body);

  // ── 2.1 需要凭据的菜单是否做了前置检查 ──
  const needsCreds = NEEDS_CREDS.some((k) => fn.name.toLowerCase().includes(k));
  const hasGuard = /ensureCreds\(/.test(body);
  if (needsCreds && isMenu && !hasGuard) {
    // 看看是否内部每个操作都检查了
    const innerChecks = (body.match(/if \(!accountId\)/g) || []).length;
    if (innerChecks === 0) {
      report('warn', fn.name, fn.line, '需要凭据但菜单入口没有 ensureCreds 检查',
        '用户点进来才发现用不了，体验差。建议入口加：if (!(await ensureCreds(p, client))) return;');
    }
  }

  // ── 2.2 是否有返回入口 ──
  if (isMenu && !/'返回'/.test(body) && !/value: 'back'/.test(body) && fn.name !== 'mainMenu') {
    report('error', fn.name, fn.line, '菜单没有「返回」项', '用户会被困在这个菜单里');
  }

  // ── 2.3 危险操作是否确认 ──
  //
  // ⚠️ 检测要排除「不是危险操作」的匹配：
  //   · is_deleted: false   —— 查询参数，不是删除动作
  //   · 选项 label 里的词    —— 如「设置自动清理（省钱）」
  //   · 注释里的说明          —— 「删除会失败（这是保护机制）」
  //
  // 实测踩过：不排除的话 tunnelMenu 的 `query: { is_deleted: false }`
  // 会被报成「有危险操作没确认」。
  const cleaned = body
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false; // 注释
      if (/is_deleted|isDeleted|deleteObjectsTransition/.test(t)) return false; // 查询参数
      if (/label:\s*['"`]/.test(t) && !/invoke|flags:/.test(t)) return false; // 纯选项定义
      return true;
    })
    .join('\n');

  const dangerWords = /删除|清空|禁用|重置|覆盖|purge|delete|remove|expire/i;
  if (dangerWords.test(cleaned)) {
    const hasConfirm = /p\.confirm\(|await confirm\(/.test(body);
    if (!hasConfirm) {
      report('error', fn.name, fn.line, '包含危险操作但没有确认步骤',
        '删除/覆盖类操作必须先展示「将要做什么」再让用户确认');
    }
  }

  // ── 2.4 输入是否有默认值或校验 ──
  const inputs = [...body.matchAll(/p\.input\([^)]*\)/g)];
  for (const inp of inputs) {
    const text = inp[0];
    // 找这个 input 的选项部分
    const idx = body.indexOf(text);
    const after = body.slice(idx, idx + 300);
    const hasDefault = /default:/.test(after);
    const hasValidate = /validate:/.test(after);
    if (!hasDefault && !hasValidate) {
      const labelMatch = text.match(/['"`]([^'"`]{4,40})['"`]/);
      report('warn', fn.name, fn.line, `输入「${labelMatch ? labelMatch[1] : '?'}」没有默认值也没有校验`,
        '用户按回车会得到空值，容易出错');
    }
  }

  // ── 2.5 长操作是否有进度反馈（deploy 类） ──
  if (/invoke\('deploy'/.test(body) && !/spinner|progress|pause/.test(body)) {
    report('warn', fn.name, fn.line, '调用 deploy 但没有进度提示', '部署要几分钟，界面无反馈像卡死');
  }

  // ── 2.6 是否有未捕获的 await ──
  const awaited = (body.match(/await (?!invoke|p\.|confirm)/g) || []).length;
  const tryCount = (body.match(/try \{/g) || []).length;
  if (awaited > 3 && tryCount === 0 && isMenu) {
    report('info', fn.name, fn.line, `${awaited} 处直接 await 但没有 try/catch`,
      '网络错误会直接抛到顶层，用户看到的是堆栈而不是友好提示');
  }
}

// ═══════════════════════════════════════════════════════
// 3. 检查菜单项 value 与分支是否匹配
// ═══════════════════════════════════════════════════════
//
// ⚠️ 关键区分：菜单的 value 有两种用途，不能一视同仁 ——
//
//   用途 A：**动作名** —— 选完要执行不同操作，必须有对应分支
//           { label: '列出记录', value: 'list' }  →  if (choice === 'list')
//
//   用途 B：**参数值** —— 只是把选中的值传下去，不需要分支
//           { label: 'Workers KV', value: 'workers_kv' }  →  invoke('quota', { ..., [choice] })
//
// 实测踩过：不区分就会把「选择产品」「选择 SSL 模式」这类
// 全部误报成「点了没反应」，信噪比极低。
//
// 判据（用**赋值目标变量名**，这是可靠的）：
//   从 `const X = await p.select(...)` 里取出 X，
//   然后看后面有没有 `X === '某值'` 或 `case '某值'`。
//   没有 → 用途 B，不检查。
const selects = [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await\s+p\.select\(\s*[`'"]([^`'"]+)[`'"]\s*,\s*\[([\s\S]*?)\]\s*\)/g)];
for (const sel of selects) {
  const varName = sel[1];
  const title = sel[2];
  const body = sel[3];
  const values = [...body.matchAll(/value:\s*'([^']+)'/g)].map((m) => m[1]).filter((v) => !v.includes('─'));

  const matchIdx = src.indexOf(sel[0]);
  const after = src.slice(matchIdx + sel[0].length, matchIdx + sel[0].length + 4000);

  // 只认「这个变量」的分支
  const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cases = [
    ...[...after.matchAll(new RegExp(`case '([^']+)'`, 'g'))].map((m) => m[1]),
    ...[...after.matchAll(new RegExp(`${esc} === '([^']+)'`, 'g'))].map((m) => m[1]),
  ];

  // 用途 B：变量被当作参数用（出现在模板串或 flags 里），且没有分支
  const usedAsValue =
    new RegExp(`\\$\\{${esc}\\}`).test(after) ||
    new RegExp(`${esc}\\s*[,}]`).test(after.slice(0, 800));

  const actionCases = cases.filter((c) => c !== 'back' && !c.startsWith('__'));

  // 有 else 兜底或 switch default 时，未列出的 value 也会被处理 ——
  // 不算漏分支（但会在下面给个 info 提示，因为兜底容易掩盖后续新增项）
  const hasFallback = new RegExp(`\\}\\s*else\\s*\\{`).test(after) || /default:/.test(after);

  if (actionCases.length > 0) {
    const missing = values.filter(
      (v) => !cases.includes(v) && v !== 'back' && !v.startsWith('__') && !v.startsWith('deploy:') && !v.startsWith('sep'),
    );
    if (missing.length && !hasFallback) {
      report('error', '菜单结构', 0, `「${title}」的选项没有对应分支：${missing.join(', ')}`, '点了没反应');
    } else if (missing.length && hasFallback) {
      report('info', '菜单结构', 0, `「${title}」的 ${missing.join(', ')} 走 else 兜底`, '能跑，但以后加选项容易被静默合并，建议改成显式分支');
    }
  } else if (!usedAsValue && values.length > 3) {
    report('warn', '菜单结构', 0, `「${title}」的选项既没有分支也没当参数用`, `变量名 ${varName}，确认是否漏处理`);
  }
}

// ═══════════════════════════════════════════════════════
// 4. 统计
// ═══════════════════════════════════════════════════════
console.log('═'.repeat(70));
console.log('走查结果');
console.log('═'.repeat(70));
console.log('');

// 分离抑制项
const active = [];
const suppressedItems = [];
for (const i of issues) {
  const sup = suppressed(i);
  if (sup) suppressedItems.push({ issue: i, sup });
  else active.push(i);
}

const byLevel = { error: [], warn: [], info: [] };
for (const i of active) byLevel[i.level].push(i);

for (const level of ['error', 'warn', 'info']) {
  const items = byLevel[level];
  if (!items.length) continue;
  const icon = { error: '\x1b[31m✘\x1b[0m', warn: '\x1b[33m⚠\x1b[0m', info: '\x1b[36mℹ\x1b[0m' }[level];
  const label = { error: '必须修', warn: '建议改', info: '可选' }[level];

  console.log(`${icon} \x1b[1m${label}\x1b[0m（${items.length}）`);
  console.log('');
  for (const i of items) {
    console.log(`  ${i.area}${i.line ? ':' + i.line : ''}`);
    console.log(`    ${i.msg}`);
    if (i.hint) console.log(`    \x1b[2m→ ${i.hint}\x1b[0m`);
    console.log('');
  }
}

// 抑制项也要展示 —— 不隐藏，只是不参与判定
if (suppressedItems.length) {
  console.log(`\x1b[2m\x1b[1m已确认的例外（${suppressedItems.length}，不计入判定）\x1b[0m`);
  console.log('');
  for (const { issue, sup } of suppressedItems) {
    console.log(`  \x1b[2m${issue.area}${issue.line ? ':' + issue.line : ''}\x1b[0m`);
    console.log(`  \x1b[2m  ${issue.msg}\x1b[0m`);
    console.log(`  \x1b[2m  为什么可以忽略：${sup.why}\x1b[0m`);
    console.log('');
  }
}

console.log('─'.repeat(70));
console.log(`必须修 ${byLevel.error.length} / 建议改 ${byLevel.warn.length} / 可选 ${byLevel.info.length} / 已确认例外 ${suppressedItems.length}`);
console.log('');

process.exit(byLevel.error.length ? 1 : 0);