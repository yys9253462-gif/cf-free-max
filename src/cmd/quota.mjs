import { log, table, color, humanNum } from '../lib/util.mjs';
import { FREE_TIER, PITFALLS, listProducts, formatQuota } from '../lib/quota.mjs';

/**
 * 打印免费额度对照表。
 * 用法：
 *   cfm quota              列出全部产品
 *   cfm quota workers      只看某产品
 *   cfm quota --pitfalls   只列踩坑
 */
export async function run({ flags }) {
  if (flags.pitfalls) {
    printPitfalls();
    return 0;
  }

  const target = flags._[1];

  if (flags.json) {
    console.log(JSON.stringify(target ? { [target]: FREE_TIER[target] } : FREE_TIER, null, 2));
    return 0;
  }

  if (target) {
    const q = FREE_TIER[target];
    if (!q) {
      log.err(`未知产品：${target}`);
      log.info(`可选：${listProducts().join(', ')}`);
      return 1;
    }
    console.log(`\n${color.bold}${target}${color.reset} 免费额度\n`);
    table(
      ['项目', '额度', '周期', '说明'],
      Object.entries(q).map(([k, v]) => [
        k,
        v.limit === null ? '不限量' : humanNum(v.limit),
        { day: '每日', month: '每月', total: '总量' }[v.period],
        v.note ?? '',
      ]),
    );
    console.log('');
    return 0;
  }

  console.log(`\n${color.bold}Cloudflare 免费层额度对照表${color.reset}`);
  log.dim('收录于 2026-10-05，以官方页面为准。额度是上限，不是目标。\n');

  for (const product of listProducts()) {
    console.log(`${color.bold}${color.cyan}${product}${color.reset}`);
    for (const [k, v] of Object.entries(FREE_TIER[product])) {
      const line = `  ${k.padEnd(22)} ${formatQuota(v)}`;
      console.log(v.note ? `${line}  ${color.dim}// ${v.note}${color.reset}` : line);
    }
    console.log('');
  }

  printPitfalls();
  return 0;
}

function printPitfalls() {
  console.log(`${color.bold}${color.yellow}最容易踩的坑${color.reset}\n`);
  for (const p of PITFALLS) {
    console.log(`${color.yellow}●${color.reset} ${color.bold}${p.title}${color.reset}`);
    console.log(`  ${wrap(p.detail, 88, '  ')}\n`);
  }
}

function wrap(text, width, indent) {
  const out = [];
  let line = '';
  for (const chunk of text.split(/(\s+)/)) {
    if (line.length + chunk.length > width) {
      out.push(line.trimEnd());
      line = '';
    }
    line += chunk;
  }
  if (line.trim()) out.push(line.trimEnd());
  return out.join(`\n${indent}`);
}
