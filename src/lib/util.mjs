/**
 * 通用工具函数：参数解析、输出、确认、dotenv 读取。
 * 零依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

// ---------- 输出 ----------

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;

const c = {
  reset: COLOR ? '\x1b[0m' : '',
  bold: COLOR ? '\x1b[1m' : '',
  dim: COLOR ? '\x1b[2m' : '',
  red: COLOR ? '\x1b[31m' : '',
  green: COLOR ? '\x1b[32m' : '',
  yellow: COLOR ? '\x1b[33m' : '',
  blue: COLOR ? '\x1b[34m' : '',
  cyan: COLOR ? '\x1b[36m' : '',
};

export const log = {
  info: (m) => console.log(`${c.blue}ℹ${c.reset} ${m}`),
  ok: (m) => console.log(`${c.green}✔${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}⚠${c.reset} ${m}`),
  err: (m) => console.error(`${c.red}✘${c.reset} ${m}`),
  step: (m) => console.log(`\n${c.bold}${c.cyan}▸ ${m}${c.reset}`),
  dim: (m) => console.log(`${c.dim}${m}${c.reset}`),
  raw: (m) => console.log(m),
};

export const color = c;

/**
 * 打印表格（简易对齐）。
 * @param {string[]} headers
 * @param {(string|number)[][]} rows
 */
export function table(headers, rows) {
  if (!rows.length) {
    log.dim('（无数据）');
    return;
  }
  const widths = headers.map((h, i) =>
    Math.max(strWidth(String(h)), ...rows.map((r) => strWidth(String(r[i] ?? '')))),
  );
  const sep = widths.map((w) => '─'.repeat(w + 2)).join('┼');
  const render = (cells) =>
    cells.map((cell, i) => pad(String(cell ?? ''), widths[i])).join(' │ ');

  console.log(render(headers));
  console.log(sep);
  for (const r of rows) console.log(render(r));
}

/** 按显示宽度计算（粗略处理全角字符） */
function strWidth(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    w += cp > 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)) ? 2 : 1;
  }
  return w;
}

function pad(s, w) {
  const diff = w - strWidth(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

// ---------- 参数解析 ----------

/**
 * 极简 argv 解析。
 * 支持：--flag、--key=value、--key value、-f、位置参数
 *
 * 注意：`-1`、`-0.5` 这类负数会被当作**值**而不是标志，
 * 因为 CLI 里（--ttl -1）负数作为取值的场景比"名为 1 的短标志"常见得多。
 * @param {string[]} argv
 * @returns {{_:string[], flags:Record<string,string|boolean>, [k:string]:any}}
 */
export function parseArgs(argv) {
  const out = { _: [] };

  /** 是否是「看起来像标志」的 token */
  const isFlag = (s) =>
    typeof s === 'string' &&
    s.length > 1 &&
    s.startsWith('-') &&
    // 排除负数：-1、-1.5、-.5、-1e3
    !/^-(\d|\.\d)/.test(s);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !isFlag(next)) {
          out[key] = next;
          i++;
        } else {
          out[key] = true;
        }
      }
    } else if (isFlag(a)) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !isFlag(next)) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ---------- 交互确认 ----------

/**
 * 危险操作前的确认。CI 环境（非 TTY）下需显式传 --yes。
 * @param {string} question
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export async function confirm(question, opts = {}) {
  if (opts.force) return true;
  if (!process.stdin.isTTY) {
    log.warn('非交互环境，跳过确认。如需在 CI 中执行破坏性操作，请显式传 --yes。');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${c.yellow}?${c.reset} ${question} ${c.dim}[y/N]${c.reset} `);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

/**
 * 要求必须提供某个参数，否则抛错。
 */
export function require_(flags, name, hint) {
  const v = flags[name];
  if (v === undefined || v === true || v === '') {
    throw new Error(`缺少必填参数 --${name}${hint ? `（${hint}）` : ''}`);
  }
  return String(v);
}

// ---------- .env ----------

/**
 * 从 cwd 及上级目录查找 .env 并加载（不覆盖已存在的环境变量）。
 * 不引入 dotenv 依赖，自己解析最简单的 KEY=VALUE 格式。
 * @param {string} [startDir]
 * @returns {string|null} 加载到的文件路径
 */
export function loadEnvFile(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      applyEnvFile(candidate);
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** @param {string} file */
export function applyEnvFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    // 去掉成对的引号
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

// ---------- 其它 ----------

/**
 * 把字节数格式化成人类可读。
 * @param {number} n
 */
export function humanBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 2)} ${units[i]}`;
}

/**
 * 大数字加千分位。
 * @param {number} n
 */
export function humanNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  return Number(n).toLocaleString('en-US');
}

/**
 * 等待（promise 版）。
 * @param {number} ms
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带并发上限的 map。
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number)=>Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
