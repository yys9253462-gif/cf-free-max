/**
 * 交互式 UI 原语 —— 零依赖，用 Node 内置 readline。
 *
 * 设计取向：
 *   1. **不用第三方库**（inquirer/prompts 都要装）。CLI 工具碰的是生产凭据，
 *      供应链面越小越好；而菜单所需的全部能力，readline + ANSI 就够了。
 *   2. **非 TTY 自动降级**。管道/CI 里跑时不能卡在等输入上 ——
 *      所有交互函数检测到非 TTY 会立刻返回默认值或抛明确错误。
 *   3. **Ctrl+C 干净退出**。恢复光标、清除 raw mode，不留烂摊子。
 */

import readline from 'node:readline';
import { log, color as c } from './util.mjs';

/** 当前是否处于可交互终端 */
export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

const CLEAR_LINE = '\x1b[2K\r';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// ═══════════════════════════════════════════════════════════
// 纯逻辑层 —— 与终端解耦，便于单元测试
// ═══════════════════════════════════════════════════════════
//
// 这几个函数不碰 stdin/stdout，只做「给定状态与按键 → 新状态」的计算。
// 把交互逻辑集中在这里的原因：真实终端驱动（pty/ConPTY）在 CI 里
// 极难搭，而 bug 几乎都出在**状态转移**（越界、跳过头、disabled 处理）
// 而不是 ANSI 序列本身。

/** 从给定位置向后找第一个可用项（不回绕） */
export function nextEnabled(choices, from, delta) {
  const n = choices.length;
  if (!n) return -1;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (!choices[i]?.disabled) return i;
  }
  return from; // 全部禁用时原地不动
}

/**
 * 单选菜单的按键处理 —— 纯函数。
 *
 * @param {{name?:string, ctrl?:boolean}} key readline 的 key 对象
 * @param {string|undefined} str 字符输入（数字键用）
 * @param {number} index 当前光标位置
 * @param {{label:string,value:any,disabled?:boolean}[]} choices
 * @returns {{type:'move',index:number}|{type:'select',value:any}|{type:'back'}|{type:'noop'}}
 */
export function handleSelectKey(key, str, index, choices) {
  const name = key?.name;

  if (key?.ctrl && name === 'c') return { type: 'abort' };

  if (name === 'up' || name === 'k') return { type: 'move', index: nextEnabled(choices, index, -1) };
  if (name === 'down' || name === 'j') return { type: 'move', index: nextEnabled(choices, index, +1) };
  if (name === 'home') return { type: 'move', index: nextEnabled(choices, -1, +1) };
  if (name === 'end') return { type: 'move', index: nextEnabled(choices, 0, -1) };

  if (name === 'return' || name === 'enter') {
    const chosen = choices[index];
    if (!chosen || chosen.disabled) return { type: 'noop' };
    return { type: 'select', value: chosen.value };
  }

  // 裸 q（不带字符输入）返回上级
  if ((name === 'q' && !str) || str === 'q') return { type: 'back' };

  // 数字键直达（1-9）
  if (str && /^[1-9]$/.test(str)) {
    const i = Number(str) - 1;
    if (i < choices.length && !choices[i].disabled) return { type: 'select', value: choices[i].value };
  }

  return { type: 'noop' };
}

/**
 * 多选菜单的按键处理 —— 纯函数。
 *
 * @param {{name?:string, ctrl?:boolean}} key
 * @param {string|undefined} str
 * @param {number} index
 * @param {{value:any,disabled?:boolean}[]} choices
 * @param {Set<number>} checked 已勾选的下标集合
 * @returns {{type:string,index?:number,checked?:Set<number>,values?:any[]}}
 */
export function handleMultiSelectKey(key, str, index, choices, checked) {
  const name = key?.name;
  const next = new Set(checked);

  if (key?.ctrl && name === 'c') return { type: 'abort' };

  if (name === 'up' || name === 'k') return { type: 'redraw', index: nextEnabled(choices, index, -1), checked: next };
  if (name === 'down' || name === 'j') return { type: 'redraw', index: nextEnabled(choices, index, +1), checked: next };

  if (name === 'space' || str === ' ') {
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return { type: 'redraw', index, checked: next };
  }

  // a 全选 / 全不选
  if (str === 'a') {
    const all = choices.every((_, i) => next.has(i));
    if (all) next.clear();
    else choices.forEach((_, i) => next.add(i));
    return { type: 'redraw', index, checked: next };
  }

  if (name === 'return' || name === 'enter') {
    return {
      type: 'select',
      values: [...next].sort((a, b) => a - b).map((i) => choices[i].value),
    };
  }

  if ((name === 'q' && !str) || str === 'q') return { type: 'back' };

  return { type: 'noop', index, checked: next };
}

/**
 * 计算重绘的 ANSI 输出 —— 纯函数，便于验证「不刷屏」。
 *
 * @param {string} text 要渲染的完整文本
 * @param {number} previouslyDrawn 上次画了多少行
 * @returns {{output:string, lines:number}}
 */
export function computeRedraw(text, previouslyDrawn) {
  const lineCount = text.split('\n').length;
  let out = '';
  if (previouslyDrawn > 0) out += `\x1b[${previouslyDrawn}A`;
  out += `${CLEAR_LINE}${text}\n`;
  // 清掉可能残留的多余行
  for (let i = lineCount; i < previouslyDrawn; i++) out += `${CLEAR_LINE}\n`;
  return { output: out, lines: lineCount };
}

/** 渲染单选菜单文本 —— 纯函数 */
export function renderSelect(title, choices, index) {
  const lines = [title];
  choices.forEach((ch, i) => {
    const cursor = i === index ? '❯' : ' ';
    const num = String(i + 1).padStart(2);
    let label = ch.label;
    if (ch.disabled) label = `(禁用) ${label}`;
    const hint = ch.hint ? `  // ${ch.hint}` : '';
    lines.push(`  ${cursor} ${num}. ${label}${hint}`);
  });
  lines.push('');
  lines.push('↑↓ 选择 · 回车确认 · 直接按数字 · q 返回');
  return lines.join('\n');
}

/** 渲染多选菜单文本 —— 纯函数 */
export function renderMultiSelect(title, choices, index, checked) {
  const lines = [title];
  choices.forEach((ch, i) => {
    const cursor = i === index ? '❯' : ' ';
    const box = checked.has(i) ? '◉' : '○';
    const hint = ch.hint ? `  // ${ch.hint}` : '';
    lines.push(`  ${cursor} ${box} ${ch.label}${hint}`);
  });
  lines.push('');
  lines.push('↑↓ 移动 · 空格勾选 · a 全选 · 回车确认 · q 返回');
  return lines.join('\n');
}

// ---------- 带色渲染（终端用；NO_COLOR 或非 TTY 时自动降级到纯文本版） ----------

const COLOR_ON = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);

const ANSI = {
  reset: COLOR_ON ? '\x1b[0m' : '',
  bold: COLOR_ON ? '\x1b[1m' : '',
  dim: COLOR_ON ? '\x1b[2m' : '',
  cyan: COLOR_ON ? '\x1b[36m' : '',
};

/** 彩色版单选渲染（结构必须与 renderSelect 一致，只多 ANSI） */
function renderSelectColored(title, choices, index) {
  const lines = [`${ANSI.bold}${title}${ANSI.reset}`];
  choices.forEach((ch, i) => {
    const cursor = i === index ? `${ANSI.cyan}❯${ANSI.reset}` : ' ';
    const num = `${ANSI.dim}${String(i + 1).padStart(2)}.${ANSI.reset}`;
    let label = ch.label;
    if (ch.disabled) label = `${ANSI.dim}${label}${ANSI.reset}`;
    else if (i === index) label = `${ANSI.bold}${label}${ANSI.reset}`;
    const hint = ch.hint ? `  ${ANSI.dim}${ch.hint}${ANSI.reset}` : '';
    lines.push(`  ${cursor} ${num} ${label}${hint}`);
  });
  lines.push('');
  lines.push(`${ANSI.dim}↑↓ 选择 · 回车确认 · 直接按数字 · q 返回${ANSI.reset}`);
  return lines.join('\n');
}

/** 彩色版多选渲染 */
function renderMultiSelectColored(title, choices, index, checked) {
  const lines = [`${ANSI.bold}${title}${ANSI.reset}`];
  choices.forEach((ch, i) => {
    const cursor = i === index ? `${ANSI.cyan}❯${ANSI.reset}` : ' ';
    const box = checked.has(i) ? `${ANSI.cyan}◉${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`;
    const hint = ch.hint ? `  ${ANSI.dim}${ch.hint}${ANSI.reset}` : '';
    lines.push(`  ${cursor} ${box} ${ch.label}${hint}`);
  });
  lines.push('');
  lines.push(`${ANSI.dim}↑↓ 移动 · 空格勾选 · a 全选 · 回车确认 · q 返回${ANSI.reset}`);
  return lines.join('\n');
}

/**
 * 交互会话：统一管理 readline 实例与光标状态。
 *
 * 为什么不用 readline/promises：
 *   方向键选择需要**逐个按键**处理（keypress 事件），
 *   promises 接口的 question() 会吃掉整行，拿不到键码。
 */
export class Prompt {
  constructor() {
    this.rl = null;
    this.closed = false;
  }

  /** 确保 readline 已初始化 */
  ensure() {
    if (this.rl || this.closed) return this.rl;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    return this.rl;
  }

  /** 关闭并恢复终端状态 */
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      process.stdout.write(SHOW_CURSOR);
    } catch {
      /* 忽略 */
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /**
   * 文本输入。
   * @param {string} question
   * @param {{default?:string, validate?:(v:string)=>string|null, password?:boolean}} [opts]
   * @returns {Promise<string>}
   */
  async input(question, opts = {}) {
    if (!isInteractive()) {
      if (opts.default !== undefined) return opts.default;
      throw new Error(`非交互环境，无法询问「${question}」`);
    }
    const rl = this.ensure();

    while (true) {
      const hint = opts.default ? ` ${c.dim}[${opts.default}]${c.reset}` : '';
      const answer = await rl.question(`${c.cyan}?${c.reset} ${question}${hint} `);
      const value = answer.trim() || opts.default || '';

      if (opts.validate) {
        const err = opts.validate(value);
        if (err) {
          log.err(err);
          continue;
        }
      }
      return value;
    }
  }

  /**
   * 确认（y/N）。
   * @param {string} question
   * @param {boolean} [defaultYes]
   * @returns {Promise<boolean>}
   */
  async confirm(question, defaultYes = false) {
    if (!isInteractive()) return defaultYes;
    const rl = this.ensure();
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = await rl.question(`${c.yellow}?${c.reset} ${question} ${c.dim}${hint}${c.reset} `);
    const t = answer.trim().toLowerCase();
    if (!t) return defaultYes;
    return t === 'y' || t === 'yes' || t === '是';
  }

  /**
   * 单选列表（方向键 + 回车；也支持直接按数字）。
   *
   * @param {string} title
   * @param {{label:string, value:any, hint?:string, disabled?:boolean}[]} choices
   * @param {{defaultIndex?:number}} [opts]
   * @returns {Promise<any>} 选中项的 value
   */
  async select(title, choices, opts = {}) {
    if (!isInteractive()) {
      // 非交互：返回第一项可选项
      const first = choices.find((ch) => !ch.disabled);
      if (!first) throw new Error('没有可选项');
      return first.value;
    }

    const rl = this.ensure();
    let index = Math.max(0, Math.min(opts.defaultIndex ?? 0, choices.length - 1));

    // 跳过禁用项
    while (choices[index]?.disabled && index < choices.length - 1) index++;

    // 渲染统一走 renderSelect（纯函数），保证测试覆盖的就是运行时逻辑
    const render = () => (COLOR_ON ? renderSelectColored(title, choices, index) : renderSelect(title, choices, index));

    return new Promise((resolve) => {
      let drawn = 0;
      const draw = () => {
        const { output, lines } = computeRedraw(render(), drawn);
        process.stdout.write(output);
        drawn = lines;
      };

      process.stdout.write(HIDE_CURSOR);
      draw();

      const onKey = (str, key) => {
        const action = handleSelectKey(key, str, index, choices);

        switch (action.type) {
          case 'abort':
            cleanup();
            process.stdout.write('\n');
            process.exit(130);
            break;
          case 'move':
            index = action.index;
            draw();
            break;
          case 'select':
            cleanup();
            process.stdout.write('\n');
            resolve(action.value);
            break;
          case 'back':
            cleanup();
            process.stdout.write('\n');
            resolve(Symbol.for('cfm.back'));
            break;
          case 'noop':
          default:
            break;
        }
      };

      const cleanup = () => {
        process.stdin.removeListener('keypress', onKey);
        process.stdout.write(SHOW_CURSOR);
      };

      readline.emitKeypressEvents(process.stdin, rl);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.on('keypress', onKey);
    });
  }

  /**
   * 多选列表（空格切换，回车确认）。
   * @param {string} title
   * @param {{label:string, value:any, checked?:boolean, hint?:string}[]} choices
   * @returns {Promise<any[]>}
   */
  async multiSelect(title, choices) {
    if (!isInteractive()) return choices.filter((ch) => ch.checked).map((ch) => ch.value);

    const rl = this.ensure();
    let index = 0;
    let checked = new Set(choices.map((ch, i) => (ch.checked ? i : -1)).filter((i) => i >= 0));

    const render = () =>
      COLOR_ON ? renderMultiSelectColored(title, choices, index, checked) : renderMultiSelect(title, choices, index, checked);

    return new Promise((resolve) => {
      let drawn = 0;
      const draw = () => {
        const { output, lines } = computeRedraw(render(), drawn);
        process.stdout.write(output);
        drawn = lines;
      };

      process.stdout.write(HIDE_CURSOR);
      draw();

      const onKey = (str, key) => {
        const action = handleMultiSelectKey(key, str, index, choices, checked);

        switch (action.type) {
          case 'abort':
            cleanup();
            process.stdout.write('\n');
            process.exit(130);
            break;
          case 'redraw':
            index = action.index;
            checked = action.checked;
            draw();
            break;
          case 'select':
            cleanup();
            process.stdout.write('\n');
            resolve(action.values);
            break;
          case 'back':
            cleanup();
            process.stdout.write('\n');
            resolve(Symbol.for('cfm.back'));
            break;
          case 'noop':
          default:
            break;
        }
      };

      const cleanup = () => {
        process.stdin.removeListener('keypress', onKey);
        process.stdout.write(SHOW_CURSOR);
      };

      readline.emitKeypressEvents(process.stdin, rl);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.on('keypress', onKey);
    });
  }

  /** 等待回车（用于「按回车返回」） */
  async pause(message = '按回车返回') {
    if (!isInteractive()) return;
    const rl = this.ensure();
    await rl.question(`${c.dim}${message}…${c.reset}`);
  }
}

/** 判断是否是「返回上级」信号 */
export function isBack(v) {
  return typeof v === 'symbol' && v === Symbol.for('cfm.back');
}

/**
 * 清屏（交互时切换页面用）。
 * 非 TTY 不输出 ANSI，避免日志里出现乱码。
 */
export function clearScreen() {
  if (!isInteractive()) return;
  process.stdout.write('\x1b[2J\x1b[H');
}

/**
 * 画一个标题框。
 * @param {string} title
 * @param {string} subtitle
 */
export function banner(title, subtitle = '') {
  const width = Math.max(52, Math.min(78, strWidth(title) + 8));
  const pad = Math.max(0, width - 4 - strWidth(title));
  console.log(`${c.cyan}╭${'─'.repeat(width - 2)}╮${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.bold}${title}${c.reset}${' '.repeat(pad)}${c.cyan}│${c.reset}`);
  if (subtitle) {
    const spad = Math.max(0, width - 4 - strWidth(subtitle));
    console.log(`${c.cyan}│${c.reset}  ${c.dim}${subtitle}${c.reset}${' '.repeat(spad)}${c.cyan}│${c.reset}`);
  }
  console.log(`${c.cyan}╰${'─'.repeat(width - 2)}╯${c.reset}`);
}

function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    w += cp > 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)) ? 2 : 1;
  }
  return w;
}
