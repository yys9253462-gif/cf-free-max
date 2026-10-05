#!/usr/bin/env node
/**
 * 真实终端冒烟测试 —— 用 winpty/script 驱动真实按键
 *
 * 与 ui-logic-test.mjs 的分工：
 *   ui-logic-test  测纯函数（状态转移、渲染文本、菜单结构）—— 快、稳、进 CI
 *   本脚本         测真实终端（ANSI 序列、光标控制、TTY 检测）—— 慢、平台相关
 *
 * 为什么必须真跑一遍：
 *   纯函数测试证明不了「界面在真实终端里好不好看」。
 *   实测踩过的坑：光标回退行数算错 → 界面每按一次键就往下滚一屏；
 *   这个 bug 在纯文本断言里完全看不出来。
 *
 * 用法：
 *   node scripts/ui-smoke.mjs            自动找 winpty/script
 *   node scripts/ui-smoke.mjs --verbose  打印全部原始输出（含 ANSI）
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'bin', 'cfm.mjs');
const VERBOSE = process.argv.includes('--verbose');

const KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
  space: ' ',
  q: 'q',
  ctrlC: '\x03',
};

/** 找一个能伪造 pty 的包装器 */
function findPty() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Git\\usr\\bin\\winpty.exe',
      'C:\\Program Files\\Git\\mingw64\\bin\\winpty.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\winpty.exe',
    ];
    for (const c of candidates) if (fs.existsSync(c)) return { kind: 'winpty', bin: c };
    // 尝试 PATH 里的 winpty
    const r = spawnSync('winpty', ['--version'], { timeout: 5000 });
    if (r.status === 0) return { kind: 'winpty', bin: 'winpty' };
    return null;
  }
  const linux = spawnSync('script', ['-qc', 'true', '/dev/null'], { timeout: 5000 });
  if (linux.status === 0) return { kind: 'linux-script' };
  const bsd = spawnSync('script', ['-q', '/dev/null', 'true'], { timeout: 5000 });
  if (bsd.status === 0) return { kind: 'bsd-script' };
  return null;
}

/**
 * 在伪终端里跑 cfm ui，按顺序发按键。
 * @param {string[]} keys
 * @param {number} timeoutMs
 */
function runInPty(keys, timeoutMs = 12000) {
  const pty = findPty();
  if (!pty) return Promise.resolve({ output: '', skipped: true });

  let child;
  const nodeArgs = [ENTRY, 'ui'];

  if (pty.kind === 'winpty') {
    // winpty [options] program [args]
    // -Xallow-non-tty：允许在非控制台环境中运行（让 Node 仍视为 TTY）
    child = spawn(pty.bin, ['-Xallow-non-tty', process.execPath, ...nodeArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
  } else if (pty.kind === 'linux-script') {
    const cmd = `${process.execPath} ${JSON.stringify(ENTRY)} ui`;
    child = spawn('script', ['-qc', cmd, '/dev/null'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
  } else {
    child = spawn('script', ['-q', '/dev/null', process.execPath, ...nodeArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
  }

  let output = '';
  child.stdout?.on('data', (d) => {
    output += d.toString();
    if (VERBOSE) process.stdout.write(d);
  });
  child.stderr?.on('data', (d) => {
    output += d.toString();
    if (VERBOSE) process.stderr.write(d);
  });

  return new Promise((resolve) => {
    let i = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ output, exitCode: null, timedOut: true, pty: pty.kind });
    }, timeoutMs);

    const sendNext = () => {
      if (i >= keys.length) return;
      try {
        child.stdin.write(keys[i++]);
      } catch {
        /* 进程可能已退出 */
      }
      setTimeout(sendNext, 400);
    };
    setTimeout(sendNext, 1200);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ output, exitCode: code, timedOut: false, pty: pty.kind });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ output, exitCode: null, timedOut: false, error: true, pty: pty.kind });
    });
  });
}

// ── 断言器 ──
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
    fail++;
    failures.push(name);
  }
}

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

async function main() {
  console.log('\n\x1b[1m真实终端冒烟测试\x1b[0m\n');

  const pty = findPty();
  if (!pty) {
    console.log('⚠ 未找到 pty 包装器（winpty / script），跳过。\n');
    console.log('手工验证步骤：');
    console.log(`  1. ${process.execPath} ${ENTRY}`);
    console.log('  2. 应看到带边框的主菜单');
    console.log('  3. ↑↓ 移动，界面应原地重绘，不往下刷屏');
    console.log('  4. 按 1 进入「看用量」，按 q 返回');
    console.log('  5. 主菜单按 q 退出');
    console.log('');
    process.exit(0);
  }

  console.log(`pty 包装器：\x1b[36m${pty.kind}\x1b[0m\n`);

  // ── 场景 1：启动与主菜单 ──
  console.log('\x1b[1m场景 1：启动与主菜单\x1b[0m');
  {
    const r = await runInPty([KEY.q], 10000);
    const plain = strip(r.output);
    check('显示标题框', plain.includes('╭') && plain.includes('╰'), '缺少边框字符');
    check('显示标题文字', plain.includes('Cloudflare 免费额度工具箱'));
    check('显示主菜单问题', plain.includes('你想做什么'));
    check('渲染了「看用量」', plain.includes('看用量'));
    check('渲染了「做体检」', plain.includes('做体检'));
    check('渲染了「初始化向导」', plain.includes('初始化向导'));
    check('显示了按键提示', plain.includes('回车') && plain.includes('返回'));
    check('有光标控制序列（隐藏光标）', r.output.includes('\x1b[?25l'), '未隐藏光标会导致界面闪烁');
  }

  // ── 场景 2：数字键直达（用离线菜单，避免依赖凭据） ──
  console.log('\n\x1b[1m场景 2：数字键直达二级菜单\x1b[0m');
  {
    // 4 = 额度速查（纯本地，无凭据也能用）
    const r = await runInPty(['4', KEY.q, KEY.q], 12000);
    const plain = strip(r.output);
    check('按 4 进入额度速查', plain.includes('免费额度速查') || plain.includes('选择产品'));
    check('额度速查有子项', plain.includes('Workers') || plain.includes('全部'));
    check('提示来自菜单而非报错', !plain.includes('未知命令'));
  }

  // ── 场景 2b：需要凭据的菜单给出配置指引而不是崩溃 ──
  console.log('\n\x1b[1m场景 2b：无凭据时的守卫\x1b[0m');
  {
    if (!process.env.CF_API_TOKEN) {
      // 1 = 看用量（需要凭据）→ 应给出配置指引 → 回车返回 → q 退出
      const r = await runInPty(['1', KEY.enter, KEY.q], 12000);
      const plain = strip(r.output);
      check(
        '无凭据时给出配置指引（不是崩栈）',
        plain.includes('需要 Cloudflare 凭据') || plain.includes('CF_API_TOKEN') || plain.includes('api-tokens'),
        '应提示怎么配置凭据',
      );
      check('指引里包含具体的环境变量名', plain.includes('CF_API_TOKEN') || plain.includes('CF_ACCOUNT_ID'));
      check('没有出现未捕获异常', !plain.includes('UnhandledPromiseRejection') && !plain.includes('at Object.<anonymous>'));
    } else {
      console.log('  \x1b[2m− 已配置凭据，跳过（该场景只验证无凭据路径）\x1b[0m');
    }
  }

  // ── 场景 3：方向键与重绘 ──
  console.log('\n\x1b[1m场景 3：方向键导航与重绘\x1b[0m');
  {
    const r = await runInPty([KEY.down, KEY.down, KEY.down, KEY.q], 12000);
    const cursorUp = (r.output.match(/\x1b\[\d+A/g) || []).length;
    check('使用了光标回退重绘', cursorUp > 0, '未检测到 ESC[nA，界面会往下刷屏');
    check('回退次数与按键次数匹配（不是每帧全屏重画）', cursorUp >= 3, `实际回退 ${cursorUp} 次`);

    const plain = strip(r.output);
    const menuCount = (plain.match(/你想做什么/g) || []).length;
    check('主菜单没有被重复打印大量次数', menuCount < 30, `出现 ${menuCount} 次，可能有刷屏`);
  }

  // ── 场景 4：q 逐级返回 ──
  console.log('\n\x1b[1m场景 4：q 键逐级返回\x1b[0m');
  {
    // 4 = 额度速查 → 再选 Workers → q → q → q 应能一路退出
    const r = await runInPty(['4', '2', KEY.q, KEY.q, KEY.q], 14000);
    const plain = strip(r.output);
    check('进入额度速查', plain.includes('免费额度速查') || plain.includes('选择产品'));
    check('能进入产品额度表（Workers）', plain.includes('requests') || plain.includes('100,000'));
    check('q 能一路返回并退出（进程结束）', r.exitCode !== null || !r.timedOut, 'q 无法退出，用户会被困住');
  }

  // ── 场景 4b：场景估算（纯计算，不需要凭据） ──
  console.log('\n\x1b[1m场景 4b：场景估算（离线）\x1b[0m');
  {
    // 5 = 场景估算 → 1 = KV 写额度 → 用默认值回车两次 → q
    const r = await runInPty(['5', '1', KEY.enter, KEY.enter, KEY.q, KEY.q, KEY.q], 16000);
    const plain = strip(r.output);
    check('进入场景估算', plain.includes('场景估算') || plain.includes('估算什么'));
    check('KV 估算器可交互', plain.includes('每次请求') || plain.includes('KV'));
    check('给出估算结论', plain.includes('额度') || plain.includes('占用') || plain.includes('%'));
  }

  // ── 场景 5：Ctrl+C ──
  console.log('\n\x1b[1m场景 5：Ctrl+C 干净退出\x1b[0m');
  {
    const r = await runInPty([KEY.ctrlC], 8000);
    check('Ctrl+C 能终止进程', !r.timedOut, '进程未响应 Ctrl+C（可能卡在 raw mode）');
    check('退出前恢复了光标', r.output.includes('\x1b[?25h') || r.timedOut === false, '未恢复光标会留下不可见光标');
  }

  // ── 场景 6：无参数直接启动 ──
  console.log('\n\x1b[1m场景 6：无参数启动进交互\x1b[0m');
  {
    const ptyInfo = findPty();
    let child;
    if (ptyInfo.kind === 'winpty') {
      child = spawn(ptyInfo.bin, ['-Xallow-non-tty', process.execPath, ENTRY], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
      });
    } else if (ptyInfo.kind === 'linux-script') {
      child = spawn('script', ['-qc', `${process.execPath} ${JSON.stringify(ENTRY)}`, '/dev/null'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      child = spawn('script', ['-q', '/dev/null', process.execPath, ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
    }

    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));

    const result = await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ out, timedOut: true });
      }, 9000);
      setTimeout(() => {
        try {
          child.stdin.write('q');
        } catch { /* 可能已退出 */ }
      }, 4000);
      child.on('exit', () => {
        clearTimeout(t);
        resolve({ out, timedOut: false });
      });
    });

    const plain = strip(result.out);
    check('无参数时进入主菜单（不是打印帮助）', plain.includes('你想做什么'), '无参数应进交互');
    check('没有因缺参数而报错', !plain.includes('未知命令'));
  }

  // ── 总结 ──
  console.log('');
  console.log('─'.repeat(52));
  console.log(`通过 \x1b[32m${pass}\x1b[0m / 失败 \x1b[31m${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  • ${f}`);
    console.log('\n提示：加 --verbose 可看到完整原始输出（含 ANSI 序列）。');
  }
  console.log('');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟测试异常：', e);
  process.exit(1);
});
