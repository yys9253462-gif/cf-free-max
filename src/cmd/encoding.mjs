/**
 * encoding — 查看/切换终端编码
 *
 * 背景：不同终端对中文编码的期望不同。
 *   · 旧版 conhost + 中文 Windows → GBK
 *   · Windows Terminal / VS Code    → UTF-8
 *
 * 自动检测有时不准（`cmd /c chcp` 是起子进程读的，
 * 子进程报的代码页可能和终端实际渲染用的不一致）。
 * 所以给一个手动切换的入口，改完记住。
 *
 * 用法：
 *   cfm encoding              查看当前设置和自动检测结果
 *   cfm encoding gbk          强制用 GBK
 *   cfm encoding utf8         强制用 UTF-8
 *   cfm encoding auto         恢复自动检测
 *   cfm encoding --test       打印测试文字（看当前设置下显示对不对）
 */

import { log, color as c, table } from '../lib/util.mjs';
import {
  getPreference,
  setEncodingMode,
  ENCODING_CONFIG_PATH,
} from '../lib/terminal-encoding.mjs';
import { execFileSync } from 'node:child_process';

export async function run({ flags }) {
  const arg = flags._[1] ? String(flags._[1]).toLowerCase() : '';

  // ─── 切换 ───
  if (arg) {
    if (!['gbk', 'utf8', 'auto'].includes(arg)) {
      log.err(`不认识的参数：${arg}`);
      console.log('');
      console.log('  可用：gbk / utf8 / auto');
      console.log('');
      return 2;
    }

    const r = setEncodingMode(arg);
    if (!r.ok) {
      log.err(r.error);
      return 1;
    }

    console.log('');
    if (arg === 'auto') {
      log.ok('已恢复自动检测');
      console.log(`  ${c.dim}下次启动时按终端类型自动选择${c.reset}`);
    } else {
      log.ok(`已切换为 ${arg.toUpperCase()}`);
      console.log(`  ${c.dim}下次启动时生效（当前进程的编码已固定）${c.reset}`);
    }
    console.log('');
    console.log(`  配置：${c.dim}${ENCODING_CONFIG_PATH}${c.reset}`);
    console.log('');
    console.log(`  ${c.dim}重新运行程序看效果。如果还是乱码，试另一个值。${c.reset}`);
    console.log('');
    return 0;
  }

  // ─── 查看 ───
  const pref = getPreference();

  console.log('');
  console.log(`${c.bold}终端编码设置${c.reset}`);
  console.log('');

  // 当前偏好
  table(
    ['项目', '值'],
    [
      ['保存的选择', pref === 'auto' ? '自动（未手动设置）' : pref.toUpperCase()],
      ['配置文件', ENCODING_CONFIG_PATH],
    ],
  );

  console.log('');

  // 探测结果
  console.log(`${c.bold}自动检测结果${c.reset}`);
  console.log('');

  const term = detectTerminal();

  table(
    ['检测项', '结果'],
    [
      ['终端类型', term.kind],
      ['期望编码', term.encoding.toUpperCase()],
      ['判断依据', term.reason],
    ],
  );

  console.log('');

  // 诊断信息
  console.log(`${c.bold}环境变量${c.reset}`);
  console.log('');
  const envKeys = ['WT_SESSION', 'TERM_PROGRAM', 'ConEmuANSI', 'CFM_ENCODING'];
  for (const k of envKeys) {
    const v = process.env[k];
    console.log(`  ${k.padEnd(16)} ${v ? c.cyan + (v.length > 20 ? v.slice(0, 20) + '…' : v) + c.reset : c.dim + '(未设置)' + c.reset}`);
  }

  let cp = '?';
  try {
    const out = execFileSync('cmd', ['/c', 'chcp'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    cp = (out.match(/(\d+)/) || [])[1] ?? '?';
  } catch {
    /* 忽略 */
  }
  console.log(`  ${'chcp'.padEnd(16)} ${cp}`);
  console.log('');

  // ─── 测试显示 ───
  console.log(`${c.bold}显示测试${c.reset}`);
  console.log('');
  console.log(`  中文：免费额度 项目说明 周期静态博客`);
  console.log(`  符号：│ ─ ┼ → · （） 【】`);
  console.log('');

  if (flags.test || flags.t) {
    console.log(`  ${c.dim}（--test 模式：上面两行如果显示正常，当前设置就是对的）${c.reset}`);
    console.log('');
  }

  // ─── 提示 ───
  console.log(`${c.bold}如果显示不正常${c.reset}`);
  console.log('');
  console.log(`  ${c.cyan}cfm encoding utf8${c.reset}    中文变乱码/方块时先试这个`);
  console.log(`  ${c.cyan}cfm encoding gbk${c.reset}     另一个方向`);
  console.log(`  ${c.cyan}cfm encoding auto${c.reset}    恢复自动`);
  console.log('');
  console.log(`  ${c.dim}改完重新运行程序生效。${c.reset}`);
  console.log('');

  return 0;
}

/** 本地检测（与 terminal-encoding 的逻辑一致，独立实现便于诊断输出） */
function detectTerminal() {
  if (process.env.WT_SESSION) {
    return { kind: 'Windows Terminal', encoding: 'utf8', reason: 'WT_SESSION 存在' };
  }
  if (process.env.TERM_PROGRAM) {
    return { kind: process.env.TERM_PROGRAM, encoding: 'utf8', reason: 'TERM_PROGRAM 存在' };
  }
  if (process.env.ConEmuANSI || process.env.ConEmuTask) {
    return { kind: 'ConEmu', encoding: 'utf8', reason: 'ConEmu 环境变量存在' };
  }
  if (process.env.VSCODE_INJECTION) {
    return { kind: 'VS Code', encoding: 'utf8', reason: 'VSCODE_INJECTION 存在' };
  }
  if (process.platform !== 'win32') {
    return { kind: 'Unix/Linux', encoding: 'utf8', reason: '非 Windows 平台' };
  }

  let cp = null;
  try {
    const out = execFileSync('cmd', ['/c', 'chcp'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    cp = Number((out.match(/(\d+)/) || [])[1]) || null;
  } catch {
    /* 忽略 */
  }

  if (cp === 65001) return { kind: '旧版控制台', encoding: 'utf8', reason: `代码页 ${cp}` };
  if (cp === 936 || cp === 54936) return { kind: '旧版控制台', encoding: 'gbk', reason: `代码页 ${cp}（中文系统）` };
  if (cp) return { kind: '旧版控制台', encoding: 'utf8', reason: `代码页 ${cp}` };

  return { kind: '未知', encoding: 'gbk', reason: '无法检测，按中文 Windows 默认' };
}
