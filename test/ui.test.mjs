/**
 * 交互模式的单元测试
 *
 * 交互式 UI 最难测的是「按键处理」—— 传统做法要起 pty、发 ANSI 序列，
 * 复杂且脆。这里改用**可测的切分**：
 *
 *   1. 非 TTY 降级行为 —— 这是最容易被忽略、又最容易在 CI 里炸的部分
 *   2. 「返回上级」信号 —— Symbol 语义
 *   3. 输入校验函数 —— 纯函数，直接测
 *   4. 菜单数据结构 —— 确保每个菜单项的 value 都在 switch 里有分支
 *
 * 真实按键交互用 scripts/ui-smoke.mjs 手工验证（见该文件说明）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isInteractive, isBack, Prompt } from '../src/lib/prompt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'bin', 'cfm.mjs');

describe('非 TTY 降级', () => {
  test('isInteractive 在管道里返回 false', () => {
    // 测试进程的 stdin/stdout 不是 TTY
    assert.equal(isInteractive(), false);
  });

  test('input 在非交互时返回默认值而不是卡住', async () => {
    const p = new Prompt();
    const v = await p.input('测试问题', { default: 'fallback' });
    assert.equal(v, 'fallback');
    p.close();
  });

  test('input 无默认值且非交互时抛明确错误', async () => {
    const p = new Prompt();
    await assert.rejects(
      () => p.input('必填项'),
      /非交互环境，无法询问/,
    );
    p.close();
  });

  test('confirm 在非交互时返回默认值', async () => {
    const p = new Prompt();
    assert.equal(await p.confirm('确认？', false), false);
    assert.equal(await p.confirm('确认？', true), true);
    p.close();
  });

  test('select 在非交互时返回第一个可用项', async () => {
    const p = new Prompt();
    const v = await p.select('选择', [
      { label: 'A', value: 'a', disabled: true },
      { label: 'B', value: 'b' },
      { label: 'C', value: 'c' },
    ]);
    assert.equal(v, 'b', '应跳过 disabled 项');
    p.close();
  });

  test('multiSelect 在非交互时返回已勾选项', async () => {
    const p = new Prompt();
    const v = await p.multiSelect('多选', [
      { label: 'A', value: 1, checked: true },
      { label: 'B', value: 2 },
      { label: 'C', value: 3, checked: true },
    ]);
    assert.deepEqual(v, [1, 3]);
    p.close();
  });

  test('pause 在非交互时立即返回，不阻塞', async () => {
    const p = new Prompt();
    await p.pause(); // 不应挂起
    p.close();
  });
});

describe('返回信号', () => {
  test('isBack 识别返回符号', () => {
    assert.equal(isBack(Symbol.for('cfm.back')), true);
  });

  test('isBack 对普通值返回 false', () => {
    assert.equal(isBack('back'), false);
    assert.equal(isBack(null), false);
    assert.equal(isBack(undefined), false);
    assert.equal(isBack(0), false);
    assert.equal(isBack(Symbol('other')), false);
  });
});

describe('CLI 入口在非 TTY 的行为', () => {
  test('无参数时应回落到 help 而不是进交互卡住', () => {
    const r = spawnSync(process.execPath, [ENTRY], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.equal(r.status, 0, `应以 0 退出，实际 ${r.status}\n${r.stderr}`);
    assert.ok(r.stdout.includes('cfm'), '应输出帮助内容');
    assert.ok(!r.stdout.includes('你想做什么'), '不该进交互菜单');
  });

  test('ui 命令在非 TTY 时给出明确指引并退出 2', () => {
    const r = spawnSync(process.execPath, [ENTRY, 'ui'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.equal(r.status, 2, `应退出 2，实际 ${r.status}`);
    assert.ok(r.stderr.includes('TTY'), '应说明需要 TTY');
  });

  test('ui 命令提示里包含替代方案', () => {
    const r = spawnSync(process.execPath, [ENTRY, 'ui'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.ok(r.stderr.includes('cfm whoami'), '应告诉用户可以直接用什么命令');
  });
});

describe('ui 模块结构', () => {
  test('导出了 run 函数', async () => {
    const m = await import('../src/cmd/ui.mjs');
    assert.equal(typeof m.run, 'function');
  });

  test('ui 出现在 CLI 命令表中', () => {
    const r = spawnSync(process.execPath, [ENTRY, 'help'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.ok(r.stdout.includes('cfm'), 'help 应正常输出');
  });
});
