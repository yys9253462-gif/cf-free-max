/**
 * 终端编码适配
 *
 * 解决的问题：
 *   Node 输出 UTF-8 字节，而中文 Windows 控制台默认是 GBK(CP936)。
 *   UTF-8 的中文字节被按 GBK 解读，显示成「鈥?鍏嶈垂棰濆害」这种乱码 ——
 *   小白看到会直接以为工具坏了。
 *
 * 实测踩过：在干净环境测试时，整个帮助界面全是乱码。
 *
 * 三种解法与取舍：
 *
 *   A. 在 .bat 里 chcp 65001（把控制台切到 UTF-8）
 *      ✓ 最简单
 *      ✗ 如果 .bat 自己是 GBK 编码，切了之后 **bat 里的中文会乱码**
 *      ✗ 全屏切换影响所有后续输出，可能干扰用户其它程序
 *
 *   B. 让 Node 把输出转成 GBK 再写
 *      ✓ 不用改控制台设置，最稳
 *      ✗ 需要 GBK 编码器（Node 无内置）
 *
 *   C. 检测代码页，只在需要时转换
 *      ✓ 两全其美
 *      ✗ 逻辑稍复杂
 *
 * 本实现用 C：中文 Windows 上把输出转 GBK，其它情况保持 UTF-8。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 是否已初始化过 */
let initialized = false;
/** 目标编码：'gbk' | 'utf8' */
let targetEncoding = 'utf8';

/**
 * 检测当前控制台的代码页。
 * @returns {number|null}
 */
function detectCodePage() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('cmd', ['/c', 'chcp'], { encoding: 'utf8', timeout: 3000 });
    const m = out.match(/(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * GBK 编码器。
 *
 * Node 内置的 TextDecoder 能解码 GBK，但没有编码器。
 * 这里用查表 + 算法实现常用区间的编码：
 *   · ASCII 直接透传
 *   · 其它字符查表（只覆盖中文常用字，够用）
 *
 * 表从哪来：用 PowerShell 的 .NET Encoding 生成一次，缓存到文件。
 * 首次运行会慢一点，之后直接用缓存。
 */
class GbkEncoder {
  constructor() {
    /** @type {Map<number, number[]>} */
    this.map = new Map();
    this.loaded = false;
  }

  /** 从 PowerShell 生成码表（一次性） */
  loadFromPowerShell() {
    let tmpScript = null;
    try {
      // ⚠️ 必须**写成文件**再执行，不能用 -Command 传多行脚本。
      //    实测踩过：脚本里的中文（变量名、字符串）经命令行传递后乱码，
      //    PowerShell 解析失败，码表整个加载不出来 ——
      //    结果所有中文都变成 `?`。
      //
      //    另外 .ps1 要带 UTF-8 BOM，否则 PS 5.1 按 ANSI 解析中文。
      tmpScript = path.join(os.tmpdir(), `cfm-gbk-table-${process.pid}.ps1`);

      const script = [
        '$ErrorActionPreference = "Stop"',
        '$gbk = [System.Text.Encoding]::GetEncoding(936)',
        '$pairs = @()',
        '# 只遍历 CJK 基本区（0x4E00-0x9FA5），覆盖 99% 的常用汉字',
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
          // 0x3F 是 PowerShell 对「无法表示」的兜底，跳过
          if (b1 !== 0x3f || b2 !== 0x3f) {
            this.map.set(code, [b1, b2]);
          }
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

  /**
   * 简化的编码 —— 只处理 ASCII 与查表，不做替代（避免递归）。
   * 用于编码替代文本本身。
   * @param {string} str
   * @returns {number[]}
   */
  encodeSimple(str) {
    const out = [];
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) {
        out.push(cp);
        continue;
      }
      const bytes = this.map.get(cp);
      if (bytes) {
        out.push(bytes[0], bytes[1]);
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

  /**
   * 把 UTF-8 字符串编码成 GBK 字节。
   * @param {string} str
   * @returns {Buffer}
   */
  encode(str) {
    if (!this.loaded) this.loadFromPowerShell();

    const out = [];
    const push = (bytes) => {
      for (const b of bytes) out.push(b);
    };

    for (const ch of str) {
      const cp = ch.codePointAt(0);

      // ASCII 直接透传
      if (cp < 0x80) {
        out.push(cp);
        continue;
      }

      // 1. 码表命中（中文常用字，从 PowerShell 生成的完整表）
      const bytes = this.map.get(cp);
      if (bytes) {
        push(bytes);
        continue;
      }

      // 2. 符号兜底表（制表符、箭头、常用标点）
      const fallback = FALLBACK_MAP[cp];
      if (fallback) {
        push(fallback);
        continue;
      }

      // 3. ASCII 替代（emoji 等 GBK 完全无法表示的字符）
      //
      //    为什么要替代而不是丢弃：
      //      直接丢会留下空洞，菜单项看起来缺字；给个 [锁定] 这样的
      //      替代文本，用户至少知道那里原本有个图标。
      const sub = SUBSTITUTE_CHAR.get(cp);
      if (sub) {
        // 替代文本本身也要走一遍编码：
        // 它可能含中文（如「[锁定]」），直接 push 码点会写出无效字节。
        const subBytes = this.encodeSimple(sub);
        push(subBytes);
        continue;
      }

      // 4. 实在没有 —— 用 '?'（GBK 的 0x3F）
      //    不丢弃：保持字符数一致，避免布局错位
      out.push(0x3f);
    }

    return Buffer.from(out);
  }
}

/**
 * 常用符号的 GBK 码表。
 *
 * ⚠️ 这些码值是**实测查出来的**（用 PowerShell 的 GetBytes 逐个查），
 *    不要凭印象写 —— 我第一版凭印象填的码值基本全错，
 *    结果 `┼` 显示成 `┏`、`→` 直接变问号。
 *
 * 查法：
 *   $gbk = [System.Text.Encoding]::GetEncoding(936)
 *   $gbk.GetBytes('┼')   # → A9 E0
 */
const FALLBACK_MAP = {
  // ─── 全角标点（中文里天天用，漏了会变成问号）───
  0x3000: [0xa1, 0xa1], // 　全角空格
  0x3001: [0xa1, 0xa2], // 、
  0x3002: [0xa1, 0xa3], // 。
  0xff01: [0xa3, 0xa1], // ！
  0xff08: [0xa3, 0xa8], // （
  0xff09: [0xa3, 0xa9], // ）
  0xff0c: [0xa3, 0xac], // ，
  0xff1a: [0xa3, 0xba], // ：
  0xff1b: [0xa3, 0xbb], // ；
  0xff1f: [0xa3, 0xbf], // ？
  0x300a: [0xa1, 0xb6], // 《
  0x300b: [0xa1, 0xb7], // 》
  0x3010: [0xa1, 0xbe], // 【
  0x3011: [0xa1, 0xbf], // 】

  // ─── 常用标点
  0x00b7: [0xa1, 0xa4], // ·
  0x2014: [0xa1, 0xaa], // —
  0x2018: [0xa1, 0xae], // '
  0x2019: [0xa1, 0xaf], // '
  0x201c: [0xa1, 0xb0], // "
  0x201d: [0xa1, 0xb1], // "
  0x2026: [0xa1, 0xad], // …

  // 方向箭头
  0x2190: [0xa1, 0xfb], // ←
  0x2191: [0xa1, 0xfc], // ↑
  0x2192: [0xa1, 0xfa], // →
  0x2193: [0xa1, 0xfd], // ↓

  // 制表符（单线）
  0x2500: [0xa9, 0xa4], // ─
  0x2501: [0xa9, 0xa5], // ━
  0x2502: [0xa9, 0xa6], // │
  0x250c: [0xa9, 0xb0], // ┌
  0x2510: [0xa9, 0xb4], // ┐
  0x2514: [0xa9, 0xb8], // └
  0x2518: [0xa9, 0xbc], // ┘
  0x251c: [0xa9, 0xc0], // ├
  0x2524: [0xa9, 0xc8], // ┤
  0x252c: [0xa9, 0xd0], // ┬
  0x2534: [0xa9, 0xd8], // ┴
  0x253c: [0xa9, 0xe0], // ┼

  // 制表符（双线）—— 注意与单线**不同**，别搞混
  0x2550: [0xa8, 0x54], // ═
  0x2551: [0xa8, 0x55], // ║
  0x2554: [0xa8, 0x58], // ╔
  0x2557: [0xa8, 0x5b], // ╗
  0x255a: [0xa8, 0x5e], // ╚
  0x255d: [0xa8, 0x61], // ╝
  0x2560: [0xa8, 0x64], // ╠
  0x2563: [0xa8, 0x67], // ╣
  0x2566: [0xa8, 0x6a], // ╦
  0x2569: [0xa8, 0x6d], // ╩
  0x256c: [0xa8, 0x70], // ╬

  // 方块与圆点
  0x2588: [0xa8, 0x80], // █
  0x25a0: [0xa1, 0xf6], // ■
  0x25b2: [0xa1, 0xf6], // ▲
  0x25bc: [0xa1, 0xf7], // ▼
  0x25c6: [0xa1, 0xf4], // ◆
  0x25cb: [0xa1, 0xf0], // ○
  0x25cf: [0xa1, 0xf1], // ●
  0x2605: [0xa1, 0xef], // ★
  0x2606: [0xa1, 0xee], // ☆
};

/**
 * GBK 无法表示、但界面上常用的字符 → ASCII 替代。
 *
 * 这些字符在 GBK 里**根本不存在**（emoji 尤其），
 * 转不过去就只能整个丢掉，会留下 `?`。
 * 主动替换成 ASCII 说法，比看到问号强。
 */
const ASCII_SUBSTITUTE = {
  0x2714: '√', // ✔ → √（GBK 里有 √ A1 CC）
  0x2713: '√', // ✓
  0x2718: 'x', // ✘
  0x2717: 'x', // ✗
  0x26a0: '!', // ⚠
  0x2705: '√', // ✅
  0x274c: 'x', // ❌
  0x1f512: '[锁定]', // 🔒
  0x1f513: '[开锁]', // 🔓
  0x1f4ca: '[图表]', // 📊
  0x1f3e5: '[体检]', // 🏥
  0x1f50d: '[审计]', // 🔍
  0x1f4d6: '[额度]', // 📖
  0x1f9ee: '[估算]', // 🧮
  0x2699: '[配置]', // ⚙
  0x1f680: '[部署]', // 🚀
  0x2753: '?', // ❓
  0x1f4e6: '[包]', // 📦
  0x1f310: '[DNS]', // 🌐
  0x26a1: '[缓存]', // ⚡
  0x1f510: '[安全]', // 🔐
  0x1f4be: '[D1]', // 💾
  0x1f5c4: '[KV]', // 🗄
  0x1f4c4: '[Pages]', // 📄
  0x1f517: '[Tunnel]', // 🔗
  0x2514: [0xa9, 0xb8],
  0x251c: [0xa9, 0xc0],
  0x25b6: [0xa1, 0xf8], // ▶
  0x2318: '#',
};

// 上面的对象里混了字符串和数组，代码里统一处理
const SUBSTITUTE_CHAR = new Map();
for (const [code, val] of Object.entries(ASCII_SUBSTITUTE)) {
  SUBSTITUTE_CHAR.set(Number(code), val);
}

const gbkEncoder = new GbkEncoder();
let gbkFailed = false;

/**
 * 初始化终端编码适配。
 * 应在程序启动最早期调用（在任何输出之前）。
 *
 * @param {{force?:boolean}} [opts]
 * @returns {{encoding:string, codePage:number|null, changed:boolean}}
 */
export function setupTerminalEncoding(opts = {}) {
  if (initialized && !opts.force) {
    return { encoding: targetEncoding, codePage: null, changed: false };
  }
  initialized = true;

  // 非 Windows 或用户显式要求，保持 UTF-8
  if (process.platform !== 'win32') {
    targetEncoding = 'utf8';
    return { encoding: 'utf8', codePage: null, changed: false };
  }

  // NO_COLOR 之类的场景不干预
  if (process.env.CFM_FORCE_UTF8) {
    targetEncoding = 'utf8';
    return { encoding: 'utf8', codePage: null, changed: false };
  }

  const cp = detectCodePage();

  // 936 = GBK/GB2312（简体中文 Windows）
  // 54936 = GB18030
  if (cp === 936 || cp === 54936) {
    // 中文控制台 —— 把输出转成 GBK
    //
    // 注意：不是「切换控制台到 UTF-8」，而是「让输出适配控制台」。
    // 后者更稳：不改变用户环境，也不影响其它程序。
    targetEncoding = 'gbk';

    // 包一层 stdout.write，把 UTF-8 转 GBK
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, encoding, cb) => {
      if (typeof chunk === 'string' && !gbkFailed) {
        try {
          return origWrite(gbkEncoder.encode(chunk), undefined, cb);
        } catch {
          // 转换失败就退回落原样写，避免整个程序挂掉
          gbkFailed = true;
          return origWrite(chunk, encoding, cb);
        }
      }
      return origWrite(chunk, encoding, cb);
    };

    const origErrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, encoding, cb) => {
      if (typeof chunk === 'string' && !gbkFailed) {
        try {
          return origErrWrite(gbkEncoder.encode(chunk), undefined, cb);
        } catch {
          gbkFailed = true;
          return origErrWrite(chunk, encoding, cb);
        }
      }
      return origErrWrite(chunk, encoding, cb);
    };

    return { encoding: 'gbk', codePage: cp, changed: true };
  }

  targetEncoding = 'utf8';
  return { encoding: 'utf8', codePage: cp, changed: false };
}

/**
 * 当前目标编码。
 */
export function getEncoding() {
  return targetEncoding;
}

/**
 * 把字符串转成「当前终端能正确显示」的 Buffer。
 * 用于需要直接写 Buffer 的场景。
 * @param {string} str
 */
export function toTerminalBytes(str) {
  if (targetEncoding === 'gbk' && !gbkFailed) {
    try {
      return gbkEncoder.encode(str);
    } catch {
      return Buffer.from(str, 'utf8');
    }
  }
  return Buffer.from(str, 'utf8');
}
