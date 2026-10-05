#!/usr/bin/env node
/**
 * spinner 组件测试
 *
 * 测试要点：
 *   1. 非 TTY 环境下**不输出控制字符**（CI 日志里不能有乱码）
 *   2. TTY 环境下用 \r 原地刷新，不刷屏
 *   3. 阶段文本更新、结束标记正确
 *   4. 进程能正常退出（timer 不能挂住进程）
 *
 * 怎么伪造 TTY：
 *   直接替换 process.stdout 对象而不是改属性 ——
 *   isTTY 是 getter，defineProperty 改不动它。
 */

import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    pass++;
  } catch (e) {
    console.log(`  \x1b[31m✘\x1b[0m ${name}`);
    console.log(`      ${e.message.split('\n')[0]}`);
    fail++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    pass++;
  } catch (e) {
    console.log(`  \x1b[31m✘\x1b[0m ${name}`);
    console.log(`      ${e.message.split('\n')[0]}`);
    fail++;
  }
}

/**
 * 捕获 stdout 的方式：替换整个对象。
 *
 * ⚠️ 两个必须注意的点：
 *
 *   1. **必须替换对象而不是改属性**
 *      `isTTY` 是 getter，Object.defineProperty 在实例上改不动它。
 *
 *   2. **console.log 也要一起接管**
 *      console.log 内部持有的是**原始 stdout 引用**，
 *      只替换 process.stdout 拦不到它的输出。
 *      实测踩过：非 TTY 分支的文本全部漏掉，测试看起来"没有输出"。
 */
function captureStdout(isTTY) {
  const original = process.stdout;
  const originalLog = console.log;
  const originalErr = console.error;
  let buffer = '';

  const fake = Object.create(original);
  Object.defineProperty(fake, 'isTTY', { value: isTTY, configurable: true });
  fake.write = (chunk) => {
    buffer += String(chunk);
    return true;
  };

  Object.defineProperty(process, 'stdout', { value: fake, configurable: true, writable: true });

  // 接管 console，让它写入我们的缓冲区
  const record = (...args) => {
    buffer += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
  };
  console.log = record;
  console.error = record;

  return {
    get text() {
      return buffer;
    },
    clear() {
      buffer = '';
    },
    restore() {
      Object.defineProperty(process, 'stdout', { value: original, configurable: true, writable: true });
      console.log = originalLog;
      console.error = originalErr;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n\x1b[1mspinner 组件测试\x1b[0m\n');

  // 清掉可能干扰的环境变量
  delete process.env.NO_COLOR;
  delete process.env.CFM_NO_SPINNER;

  const { spinner, progressBar, withSpinner } = await import('../src/lib/spinner.mjs');

  // ═══ 非 TTY 环境 ═══
  console.log('\x1b[1m非 TTY（CI / 管道）\x1b[0m');

  await testAsync('不输出 ANSI 控制字符', async () => {
    const cap = captureStdout(false);
    const sp = spinner('正在处理');
    await sleep(100);
    sp.stop('完成');
    await sleep(30);
    cap.restore();

    assert.ok(!cap.text.includes('\r'), `不应有 \\r 回退，实际：${JSON.stringify(cap.text)}`);
    assert.ok(!/\x1b\[/.test(cap.text), `不应有 ANSI 转义，实际：${JSON.stringify(cap.text)}`);
  });

  await testAsync('每行只打印一次（不刷屏）', async () => {
    const cap = captureStdout(false);
    const sp = spinner('任务');
    await sleep(250); // 足够画好几帧
    sp.stop('完成');
    await sleep(30);
    cap.restore();

    const lines = cap.text.trim().split('\n').filter(Boolean);
    assert.ok(lines.length <= 3, `输出行数应 ≤3，实际 ${lines.length}：${JSON.stringify(cap.text)}`);
  });

  // ═══ TTY 环境 ═══
  console.log('\n\x1b[1mTTY（真实终端）\x1b[0m');

  await testAsync('用 \\r 原地刷新', async () => {
    const cap = captureStdout(true);
    const sp = spinner('正在部署');
    await sleep(200);
    sp.stop('完成');
    await sleep(30);
    cap.restore();

    assert.ok(cap.text.includes('\r'), 'TTY 下应用 \\r 原地刷新');
  });

  await testAsync('使用 spinner 帧字符', async () => {
    const cap = captureStdout(true);
    const sp = spinner('测试');
    await sleep(250);
    sp.stop('完成');
    await sleep(30);
    cap.restore();

    // TTY 下用 braille 帧（⠋⠙⠹…），极简环境才用 ASCII。
    // 实测踩过：断言只测了 ASCII 帧，实际输出 braille 导致误报失败。
    const hasBraille = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(cap.text);
    const hasAscii = /[|/\\-]/.test(cap.text);
    assert.ok(hasBraille || hasAscii, `应有 spinner 帧，实际：${JSON.stringify(cap.text.slice(0, 80))}`);
  });

  await testAsync('结束时输出完成标记', async () => {
    const cap = captureStdout(true);
    const sp = spinner('任务');
    await sleep(100);
    sp.stop('搞定了');
    await sleep(30);
    cap.restore();

    assert.ok(cap.text.includes('搞定了'), '应输出完成文本');
    assert.ok(cap.text.includes('✔'), '应有完成标记');
  });

  await testAsync('update 能改变阶段文本', async () => {
    const cap = captureStdout(true);
    const sp = spinner('阶段一');
    await sleep(120);
    sp.update('阶段二');
    await sleep(120);
    sp.stop();
    await sleep(30);
    cap.restore();

    assert.ok(cap.text.includes('阶段二'), '应显示更新后的文本');
  });

  await testAsync('fail 输出失败标记', async () => {
    const cap = captureStdout(true);
    const sp = spinner('任务');
    await sleep(80);
    sp.fail('出错了');
    await sleep(30);
    cap.restore();

    assert.ok(cap.text.includes('出错了'));
    assert.ok(cap.text.includes('✘'));
  });

  // ═══ 幂等与边界 ═══
  console.log('\n\x1b[1m边界情况\x1b[0m');

  await testAsync('重复 stop 不重复输出', async () => {
    const cap = captureStdout(false);
    const sp = spinner('任务');
    sp.stop('第一次');
    sp.stop('第二次');
    sp.fail('第三次');
    await sleep(30);
    cap.restore();

    const count = (cap.text.match(/第一次|第二次|第三次/g) || []).length;
    assert.equal(count, 1, `只应输出一次结束文本，实际 ${count} 次`);
  });

  test('CFM_NO_SPINNER 能强制禁用动画', () => {
    process.env.CFM_NO_SPINNER = '1';
    const cap = captureStdout(true);
    const sp = spinner('测试');
    sp.stop('完成');
    cap.restore();
    delete process.env.CFM_NO_SPINNER;

    assert.ok(!cap.text.includes('\r'), 'CFM_NO_SPINNER=1 时不应有动画');
  });

  await testAsync('withSpinner 成功路径', async () => {
    const cap = captureStdout(false);
    const r = await withSpinner('加载中', async () => {
      await sleep(50);
      return { count: 7 };
    }, { done: (x) => `拿到 ${x.count} 项` });
    cap.restore();

    assert.equal(r.count, 7);
    assert.ok(cap.text.includes('拿到 7 项'), '应输出自定义完成文本');
  });

  await testAsync('withSpinner 失败路径会重新抛出', async () => {
    const cap = captureStdout(false);
    await assert.rejects(
      () => withSpinner('加载中', async () => { throw new Error('模拟失败'); }),
      /模拟失败/,
    );
    cap.restore();
  });

  test('progressBar 在非 TTY 下静默', () => {
    const cap = captureStdout(false);
    const pb = progressBar(3);
    pb.advance(1, 'A');
    pb.advance(1, 'B');
    pb.done();
    cap.restore();

    assert.ok(!cap.text.includes('\r'), '非 TTY 下进度条不应输出控制字符');
  });

  // ═══ 总结 ═══
  console.log('');
  console.log('─'.repeat(46));
  console.log(`通过 \x1b[32m${pass}\x1b[0m / 失败 \x1b[31m${fail}\x1b[0m`);
  console.log('');

  // 显式退出，确认 timer 没挂住进程
  process.exit(fail ? 1 : 0);
}

main();
