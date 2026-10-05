/**
 * 终端编码适配 v2 —— 用「探测 + 记忆」代替「猜」
 *
 * ═══ 为什么重写 ═══
 *
 * v1 的做法：跑 `cmd /c chcp` 读代码页，是 936 就输出 GBK。
 *
 * 实测失败（用户反馈）：
 *   · 快查.bat（纯批处理 GBK）显示**完全正常**
 *   · 启动.bat（Node 输出）显示**乱码**
 *
 * 乱码 ≠ 方块，说明是编码不匹配不是字体问题。
 *
 * 根因：`cmd /c chcp` 是**起子进程**读的，
 * 而子进程报告的代码页 ≠ 终端实际渲染用的编码。
 * 在 Windows Terminal / 新版 conhost 里，
 * 子进程可能报 936，但终端实际按 UTF-8 渲染
 *   → 我把输出转成 GBK，终端按 UTF-8 解 → 乱码。
 *
 * ═══ v2 的做法 ═══
 *
 * 不猜，改成三级策略：
 *
 *   1. **环境变量显式指定**（最高优先级）
 *      CFM_ENCODING=gbk / utf8 / auto
 *
 *   2. **探测现代终端**（能可靠判断的部分）
 *      WT_SESSION / TERM_PROGRAM / ConEmuANSI → 这些终端用 UTF-8
 *
 *   3. **记住上次的选择**
 *      首次运行如果 auto 判断不了，写一个配置文件；
 *      用户在界面上切换后记住，下次直接用。
 *
 *   4. 兜底：旧版 conhost → GBK（中文系统的默认）
 *
 * 另外提供 UI 里的切换入口，让用户能一键改：
 *   cfm encoding gbk    切到 GBK
 *   cfm encoding utf8   切到 UTF-8
 *   cfm encoding auto   恢复自动
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 配置存放位置 */
const CFG_DIR = path.join(process.env.CFM_HOME || path.join(os.homedir(), 'AppData', 'Local', 'cf-free-max'));
const CFG_FILE = path.join(CFG_DIR, 'encoding.json');

/** 是否已初始化 */
let initialized = false;
/** 目标编码：'gbk' | 'utf8' */
let targetEncoding = 'utf8';
/** 判定依据（用于诊断输出） */
let decisionReason = '';

// ═══════════════════════════════════════════════════════════
// 配置读写
// ═══════════════════════════════════════════════════════════

/**
 * 读取用户保存的编码偏好。
 * @returns {{mode?:string}}
 */
function readPreference() {
  try {
    if (!fs.existsSync(CFG_FILE)) return {};
    const raw = fs.readFileSync(CFG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * 保存编码偏好。
 * @param {string} mode 'gbk' | 'utf8' | 'auto'
 */
export function savePreference(mode) {
  try {
    if (!fs.existsSync(CFG_DIR)) fs.mkdirSync(CFG_DIR, { recursive: true });
    const cur = readPreference();
    cur.mode = mode;
    cur.updatedAt = new Date().toISOString();
    fs.writeFileSync(CFG_FILE, JSON.stringify(cur, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取当前偏好。
 */
export function getPreference() {
  const p = readPreference();
  return p.mode || 'auto';
}

// ═══════════════════════════════════════════════════════════
// 探测
// ═══════════════════════════════════════════════════════════

/**
 * 探测终端类型。
 *
 * @returns {{kind:string, encoding:string, reason:string}}
 */
function probeTerminal() {
  // 现代终端 —— 都是 UTF-8
  if (process.env.WT_SESSION) {
    return { kind: 'windows-terminal', encoding: 'utf8', reason: 'Windows Terminal（WT_SESSION）' };
  }
  if (process.env.TERM_PROGRAM) {
    return {
      kind: 'modern',
      encoding: 'utf8',
      reason: `${process.env.TERM_PROGRAM}（TERM_PROGRAM）`,
    };
  }
  if (process.env.ConEmuANSI || process.env.ConEmuTask) {
    return { kind: 'conemu', encoding: 'utf8', reason: 'ConEmu' };
  }
  if (process.env.VSCODE_INJECTION || process.env.TERM_PROGRAM === 'vscode') {
    return { kind: 'vscode', encoding: 'utf8', reason: 'VS Code 终端' };
  }

  // 非 Windows
  if (process.platform !== 'win32') {
    return { kind: 'unix', encoding: 'utf8', reason: '非 Windows 平台' };
  }

  // 旧版 conhost —— 看代码页
  let cp = null;
  try {
    const out = execFileSync('cmd', ['/c', 'chcp'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const m = out.match(/(\d+)/);
    cp = m ? Number(m[1]) : null;
  } catch {
    /* 读不到 */
  }

  if (cp === 65001) {
    return { kind: 'conhost-utf8', encoding: 'utf8', reason: `控制台代码页 ${cp}` };
  }
  if (cp === 936 || cp === 54936) {
    return { kind: 'conhost-gbk', encoding: 'gbk', reason: `控制台代码页 ${cp}（中文系统）` };
  }
  if (cp) {
    return { kind: 'conhost-other', encoding: 'utf8', reason: `控制台代码页 ${cp}` };
  }

  // 什么都读不到 —— 默认 GBK（中文 Windows 最常见）
  return { kind: 'unknown', encoding: 'gbk', reason: '无法检测，按中文 Windows 默认' };
}

// ═══════════════════════════════════════════════════════════
// GBK 编码器（与 v1 相同，实测有效）
// ═══════════════════════════════════════════════════════════

class GbkEncoder {
  constructor() {
    this.map = new Map();
    this.loaded = false;
    this.loadError = null;
  }

  loadFromPowerShell() {
    let tmpScript = null;
    try {
      tmpScript = path.join(os.tmpdir(), `cfm-gbk-${process.pid}.ps1`);

      const script = [
        '$ErrorActionPreference = "Stop"',
        '$gbk = [System.Text.Encoding]::GetEncoding(936)',
        '$pairs = @()',
        'for ($i = 0x4E00; $i -le 0x9FA5; $i += 256) {',
        '  $end = [Math]::Min($i + 255, 0x9FA5)',
        '  $chars = -join (($i..$end) | ForEach-Object { [char]$_ })',
        '  $bytes = $gbk.GetBytes($chars)',
        '  $pairs += ($bytes | ForEach-Object { $_.ToString("X2") }) -join ""',
        '}',
        '[Console]::Out.Write($pairs -join "|")',
      ].join('\n');

      fs.writeFileSync(tmpScript, '\uFEFF' + script, 'utf8');

      const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpScript], {
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 30 * 1024 * 1024,
      });

      const chunks = out.trim().split('|').filter((c) => c.length > 0);
      let code = 0x4e00;
      for (const chunk of chunks) {
        for (let i = 0; i + 4 <= chunk.length; i += 4) {
          const b1 = parseInt(chunk.slice(i, i + 2), 16);
          const b2 = parseInt(chunk.slice(i + 2, i + 4), 16);
          if (b1 !== 0x3f || b2 !== 0x3f) this.map.set(code, [b1, b2]);
          code++;
        }
      }
      this.loaded = this.map.size > 1000;
    } catch (e) {
      this.loadError = e.message;
      this.loaded = false;
    } finally {
      if (tmpScript) {
        try {
          fs.unlinkSync(tmpScript);
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  encodeSimple(str) {
    const out = [];
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) {
        out.push(cp);
        continue;
      }
      const b = this.map.get(cp);
      if (b) {
        out.push(b[0], b[1]);
        continue;
      }
      const fb = FALLBACK_MAP[cp];
      if (fb) {
        out.push(fb[0], fb[1]);
        continue;
      }
      out.push(0x3f);
    }
    return out;
  }

  encode(str) {
    if (!this.loaded) this.loadFromPowerShell();
    const out = [];
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) {
        out.push(cp);
        continue;
      }
      const b = this.map.get(cp);
      if (b) {
        out.push(b[0], b[1]);
        continue;
      }
      const fb = FALLBACK_MAP[cp];
      if (fb) {
        out.push(fb[0], fb[1]);
        continue;
      }
      const sub = SUBSTITUTE.get(cp);
      if (sub) {
        for (const x of this.encodeSimple(sub)) out.push(x);
        continue;
      }
      out.push(0x3f);
    }
    return Buffer.from(out);
  }
}

/** 全角标点等 */
const FALLBACK_MAP = {
  0x3000: [0xa1, 0xa1], 0x3001: [0xa1, 0xa2], 0x3002: [0xa1, 0xa3],
  0xff01: [0xa3, 0xa1], 0xff08: [0xa3, 0xa8], 0xff09: [0xa3, 0xa9],
  0xff0c: [0xa3, 0xac], 0xff1a: [0xa3, 0xba], 0xff1b: [0xa3, 0xbb],
  0xff1f: [0xa3, 0xbf], 0x300a: [0xa1, 0xb6], 0x300b: [0xa1, 0xb7],
  0x3010: [0xa1, 0xbe], 0x3011: [0xa1, 0xbf],
  0x00b7: [0xa1, 0xa4], 0x2014: [0xa1, 0xaa],
  0x2018: [0xa1, 0xae], 0x2019: [0xa1, 0xaf],
  0x201c: [0xa1, 0xb0], 0x201d: [0xa1, 0xb1], 0x2026: [0xa1, 0xad],
  0x2190: [0xa1, 0xfb], 0x2191: [0xa1, 0xfc], 0x2192: [0xa1, 0xfa], 0x2193: [0xa1, 0xfd],
  0x2500: [0xa9, 0xa4], 0x2501: [0xa9, 0xa5], 0x2502: [0xa9, 0xa6],
  0x250c: [0xa9, 0xb0], 0x2510: [0xa9, 0xb4], 0x2514: [0xa9, 0xb8], 0x2518: [0xa9, 0xbc],
  0x251c: [0xa9, 0xc0], 0x2524: [0xa9, 0xc8], 0x252c: [0xa9, 0xd0],
  0x2534: [0xa9, 0xd8], 0x253c: [0xa9, 0xe0],
  0x2550: [0xa8, 0x54], 0x2551: [0xa8, 0x55], 0x2554: [0xa8, 0x58], 0x2557: [0xa8, 0x5b],
  0x255a: [0xa8, 0x5e], 0x255d: [0xa8, 0x61], 0x2560: [0xa8, 0x64], 0x2563: [0xa8, 0x67],
  0x2566: [0xa8, 0x6a], 0x2569: [0xa8, 0x6d], 0x256c: [0xa8, 0x70],
  0x2588: [0xa8, 0x80], 0x25a0: [0xa1, 0xf6], 0x25b2: [0xa1, 0xf6], 0x25bc: [0xa1, 0xf7],
  0x25c6: [0xa1, 0xf4], 0x25cb: [0xa1, 0xf0], 0x25cf: [0xa1, 0xf1],
  0x2605: [0xa1, 0xef], 0x2606: [0xa1, 0xee], 0x25b6: [0xa1, 0xf8],
};

/** GBK 无法表示的字符 → ASCII 替代 */
const SUBSTITUTE = {
  0x2714: '√', 0x2713: '√', 0x2718: 'x', 0x2717: 'x', 0x26a0: '!',
  0x2705: '√', 0x274c: 'x',
  0x1f512: '[锁定]', 0x1f513: '[开锁]', 0x1f4ca: '[图表]', 0x1f3e5: '[体检]',
  0x1f50d: '[审计]', 0x1f4d6: '[额度]', 0x1f9ee: '[估算]', 0x2699: '[配置]',
  0x1f680: '[部署]', 0x1f4e6: '[包]', 0x1f310: '[DNS]', 0x26a1: '[缓存]',
  0x1f510: '[安全]', 0x1f4be: '[D1]', 0x1f5c4: '[KV]', 0x1f4c4: '[Pages]',
  0x1f517: '[Tunnel]',
};

const gbkEncoder = new GbkEncoder();
let gbkFailed = false;

// ═══════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════

/**
 * 初始化终端编码适配。
 *
 * 决策顺序：
 *   1. 环境变量 CFM_ENCODING（强制）
 *   2. 用户保存的偏好（cfm encoding 命令写的）
 *   3. 自动探测
 *
 * @param {{force?:boolean}} [opts]
 * @returns {{encoding:string, reason:string, source:string, terminal:string}}
 */
export function setupTerminalEncoding(opts = {}) {
  if (initialized && !opts.force) {
    return { encoding: targetEncoding, reason: decisionReason, source: 'cached', terminal: '' };
  }
  initialized = true;

  const term = probeTerminal();
  let encoding = term.encoding;
  let source = 'auto';
  let reason = term.reason;

  // 1. 环境变量
  const envMode = (process.env.CFM_ENCODING || '').toLowerCase();
  if (envMode === 'gbk' || envMode === 'utf8') {
    encoding = envMode;
    source = 'env';
    reason = `环境变量 CFM_ENCODING=${envMode}`;
  } else if (envMode === 'utf8' || envMode === 'gbk') {
    encoding = envMode;
    source = 'env';
  } else if (!process.env.CFM_ENCODING) {
    // 2. 用户偏好
    const pref = getPreference();
    if (pref === 'gbk' || pref === 'utf8') {
      encoding = pref;
      source = 'preference';
      reason = `上次保存的选择（${pref}）`;
    }
  }

  targetEncoding = encoding;
  decisionReason = reason;

  // ─── 应用 ───
  if (encoding === 'gbk' && process.platform === 'win32') {
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, enc, cb) => {
      if (typeof chunk === 'string' && !gbkFailed) {
        try {
          return origWrite(gbkEncoder.encode(chunk), undefined, cb);
        } catch {
          gbkFailed = true;
          return origWrite(chunk, enc, cb);
        }
      }
      return origWrite(chunk, enc, cb);
    };

    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, enc, cb) => {
      if (typeof chunk === 'string' && !gbkFailed) {
        try {
          return origErr(gbkEncoder.encode(chunk), undefined, cb);
        } catch {
          gbkFailed = true;
          return origErr(chunk, enc, cb);
        }
      }
      return origErr(chunk, enc, cb);
    };
  }

  return { encoding: targetEncoding, reason: decisionReason, source, terminal: term.kind };
}

export function getEncoding() {
  return targetEncoding;
}

export function getDecision() {
  return { encoding: targetEncoding, reason: decisionReason };
}

/**
 * 切换编码并保存。
 * @param {string} mode 'gbk' | 'utf8' | 'auto'
 */
export function setEncodingMode(mode) {
  const m = String(mode || '').toLowerCase();
  if (!['gbk', 'utf8', 'auto'].includes(m)) {
    return { ok: false, error: `不认识的编码模式：${mode}（可用：gbk / utf8 / auto）` };
  }
  const ok = savePreference(m);
  if (!ok) return { ok: false, error: '保存配置失败' };
  return { ok: true, mode: m, file: CFG_FILE };
}

export { CFG_FILE as ENCODING_CONFIG_PATH };
