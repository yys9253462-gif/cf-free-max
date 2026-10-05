/**
 * 加载指示器 —— 长耗时操作期间给出进度反馈
 *
 * 为什么需要：
 *   交互模式下点「部署博客」，实际要跑几分钟（拉代码 → 装依赖 → 构建 → 上传）。
 *   这期间界面完全没有反馈，用户会以为卡死了 —— 这是体验上最致命的问题。
 *
 * 设计取舍：
 *   · 用**单行原地刷新**的 spinner，不刷屏（保持屏幕干净）
 *   · 支持「阶段文本」更新，让用户知道进行到哪一步
 *   · 非 TTY 环境自动降级为纯文本输出（CI 里不会出现乱码控制字符）
 *   · 结束时清掉 spinner 行，不留残迹
 */

import { color as c } from './util.mjs';

/**
 * 是否可做动画。
 *
 * ⚠️ 必须**运行时判断**，不能在模块顶层算一次就存下来。
 *    实测踩过：把 `const CAN_ANIMATE = process.stdout.isTTY && ...`
 *    写在模块作用域，导致测试里伪造成 TTY 也走不了动画分支 ——
 *    因为模块加载时已经把它定死了。
 *
 *    这是个真实的坑：交互程序里 stdout 可能在中途被重定向，
 *    每次判断都能跟着变，才是对的。
 */
function canAnimate() {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CFM_NO_SPINNER);
}

/** Braille 风格的 spinner 帧（比 |/-\ 更顺滑） */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** 极简环境下回落到 ASCII */
const FRAMES_ASCII = ['|', '/', '-', '\\'];

/**
 * 启动一个 spinner。
 *
 * @param {string} text 初始文本，如「正在部署」
 * @param {{ascii?:boolean, intervalMs?:number}} [opts]
 * @returns {{update:(t:string)=>void, stop:(finalText?:string)=>void, fail:(t:string)=>void}}
 *
 * @example
 *   const sp = spinner('正在部署博客');
 *   sp.update('正在安装依赖 ...');
 *   sp.stop('部署完成');
 *   // 或者
 *   sp.fail('部署失败');
 */
export function spinner(text, opts = {}) {
  const animate = canAnimate();
  const frames = opts.ascii || !animate ? FRAMES_ASCII : FRAMES;
  const interval = opts.intervalMs ?? 80;

  let current = text;
  let frame = 0;
  let timer = null;
  let stopped = false;
  let lastLen = 0;

  /** 清除当前行 */
  const clearLine = () => {
    if (!canAnimate()) return;
    process.stdout.write('\r' + ' '.repeat(lastLen) + '\r');
  };

  /** 绘制一帧 */
  const draw = () => {
    if (!canAnimate()) return;
    const line = `${c.cyan}${frames[frame]}${c.reset} ${current}`;
    // 用 \r 回到行首后重画，并记录长度以便下次清除
    process.stdout.write('\r' + line);
    lastLen = stripAnsi(line).length;
    frame = (frame + 1) % frames.length;
  };

  if (canAnimate()) {
    draw();
    timer = setInterval(draw, interval);
    // 不阻止进程退出
    if (timer.unref) timer.unref();
  } else {
    // 非 TTY：只打印一次，不刷屏
    console.log(`  ${text}`);
  }

  const finish = (symbol, finalText, color) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);

    if (canAnimate()) {
      clearLine();
      if (finalText) {
        process.stdout.write(`${c[color]}${symbol}${c.reset} ${finalText}\n`);
      }
    } else if (finalText) {
      console.log(`  ${finalText}`);
    }
  };

  return {
    /** 更新阶段文本 */
    update(t) {
      current = t;
      if (!canAnimate()) console.log(`  ${t}`);
    },
    /** 成功结束 */
    stop(finalText) {
      finish('✔', finalText, 'green');
    },
    /** 失败结束 */
    fail(finalText) {
      finish('✘', finalText, 'red');
    },
    /** 警告结束 */
    warn(finalText) {
      finish('⚠', finalText, 'yellow');
    },
    /** 静默结束（不打印任何东西） */
    silent() {
      finish('', '', 'reset');
    },
  };
}

/** 去掉 ANSI 转义，用于计算可见宽度 */
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/**
 * 带 spinner 的异步操作包装。
 *
 * @template T
 * @param {string} text 进行中的文本
 * @param {() => Promise<T>} fn 要执行的异步操作
 * @param {{done?:(r:T)=>string, fail?:(e:Error)=>string}} [opts]
 * @returns {Promise<T>}
 *
 * @example
 *   const result = await withSpinner('正在查询用量', () => fetchUsage(), {
 *     done: (r) => `查询完成（${r.count} 项）`,
 *   });
 */
export async function withSpinner(text, fn, opts = {}) {
  const sp = spinner(text);
  try {
    const result = await fn();
    sp.stop(opts.done ? opts.done(result) : text + ' 完成');
    return result;
  } catch (err) {
    sp.fail(opts.fail ? opts.fail(err) : `${text} 失败`);
    throw err;
  }
}

/**
 * 进度条（用于有明确总数的操作，如批量处理 N 个站点）。
 *
 * @param {number} total
 * @param {{width?:number, label?:string}} [opts]
 * @returns {{advance:(n?:number, label?:string)=>void, done:()=>void}}
 */
export function progressBar(total, opts = {}) {
  const width = opts.width ?? 24;
  let current = 0;
  let label = opts.label ?? '';

  const render = (force = false) => {
    if (!canAnimate()) return;
    const pct = total > 0 ? current / total : 0;
    const filled = Math.round(pct * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const line = `${c.cyan}${bar}${c.reset} ${String(current).padStart(String(total).length)}/${total}  ${c.dim}${label}${c.reset}`;
    process.stdout.write('\r' + line);
  };

  if (canAnimate()) render();

  return {
    /**
     * 推进一步
     * @param {number} [n]
     * @param {string} [newLabel]
     */
    advance(n = 1, newLabel) {
      current = Math.min(total, current + n);
      if (newLabel) label = newLabel;
      render();
    },
    /** 完成：清除进度条并换行 */
    done() {
      if (canAnimate()) {
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
      }
    },
  };
}

/**
 * 定时输出「还在跑」的心跳提示。
 *
 * 用于那些既没有进度、又可能跑很久的操作 ——
 * 有 spinner 也不够，因为用户会怀疑是不是真的在动。
 *
 * @param {string} text
 * @param {number} [everyMs]
 * @returns {{stop:()=>void}}
 */
export function heartbeat(text, everyMs = 15000) {
  const started = Date.now();
  let count = 0;

  const timer = setInterval(() => {
    count++;
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`  ${c.dim}${text}（已等待 ${elapsed} 秒）${c.reset}`);
  }, everyMs);

  if (timer.unref) timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
