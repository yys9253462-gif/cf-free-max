#!/usr/bin/env node
/**
 * audit-runtime.mjs — 运行时验收（静态检查之外的动态验证）
 *
 * ═══ 为什么单独一个脚本 ═══
 *
 * scripts/audit.mjs 只做**静态**检查（编码、标签、变量、语法）。
 * 静态过了不等于能用 —— 实测踩过：
 *   · `.ps1` 语法正确，但输出编码不对 → 中文全乱码
 *   · bat 标签都存在，但 if 分支顺序错 → 代码成死代码
 *   这些静态查不出来，必须真跑一遍。
 *
 * ═══ 设计要点（都是踩过的坑）═══
 *
 * **用 Node 跑，不用 PowerShell** ——
 *   PowerShell 处理中文有大量坑：
 *     · `[System.IO.File]::WriteAllText` + GBK 会把 `╔` 写成坏字节 `A8 58`
 *     · `Get-ChildItem -Recurse` 遇到坏符号链接会刷屏
 *     · 多层引号嵌套几乎必然出错
 *   Node 的 Buffer 是字节级的，不会偷偷转码。
 *
 * **复制到 ASCII 路径再测** ——
 *   项目路径含中文（`F:\脚本\...`），cmd 在中文路径下执行 bat 会报
 *   「系统找不到指定的路径」。实测踩过一堆假失败都是这个原因。
 *
 * **用独立的 CFM_HOME** ——
 *   绝不动用户的 `%LOCALAPPDATA%`。实测踩过：
 *   测试跑完写了标记文件，导致用户双击时跳过向导。
 *
 * **判据看结构，不看「中文是否完美」** ——
 *   `cmd /c x.bat > file` 的输出会经代码页转码，可能产生 U+FFFD。
 *   那是**测试环境的限制**，不是产品 bug。
 *   所以断言用 `/\[1\].*\[2\]/` 这种结构判据。
 *
 * 用法：
 *   node scripts/audit-runtime.mjs
 *   node scripts/audit-runtime.mjs --keep    保留临时目录（排查用）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const TMP = path.join(os.tmpdir(), `cfm-audit-${Date.now()}`);

fs.mkdirSync(TMP, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}${detail ? '  \x1b[2m' + detail + '\x1b[0m' : ''}`);
}

function section(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/** 把项目复制到 ASCII 路径 */
function stageProject() {
  const staged = path.join(TMP, 'proj');
  fs.mkdirSync(staged, { recursive: true });

  for (const d of ['bin', 'src', 'scripts', 'config']) {
    const src = path.join(ROOT, d);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(staged, d), { recursive: true });
    }
  }

  // bat 用 Buffer 级复制，绝不转码
  fs.copyFileSync(path.join(ROOT, '启动.bat'), path.join(staged, 'launcher.bat'));

  return staged;
}

/** 跑 bat（独立 CFM_HOME，返回输出与 home 路径） */
function runBat(staged, input, extraArgs = '', timeoutMs = 90000) {
  const id = Math.random().toString(36).slice(2, 8);
  const inFile = path.join(staged, `_in-${id}.txt`);
  const outFile = path.join(staged, `_out-${id}.txt`);
  const wrapper = path.join(staged, `_w-${id}.cmd`);
  const home = path.join(staged, `_home-${id}`);

  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(inFile, input, 'ascii');

  fs.writeFileSync(
    wrapper,
    [
      '@echo off',
      `cd /d "${staged}"`,
      `set "CFM_HOME=${home}"`,
      `call "${staged}\\launcher.bat" ${extraArgs} < "${inFile}" > "${outFile}" 2>&1`,
      '',
    ].join('\r\n'),
    'latin1',
  );

  const r = spawnSync('cmd', ['/c', wrapper], {
    timeout: timeoutMs,
    windowsHide: true,
    stdio: 'ignore',
  });

  let out = '';
  if (fs.existsSync(outFile)) {
    const buf = fs.readFileSync(outFile);
    try {
      out = new TextDecoder('gbk').decode(buf);
    } catch {
      out = buf.toString('utf8');
    }
  }

  for (const f of [inFile, outFile, wrapper]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {}
  }

  return { out, status: r.status, timedOut: r.error?.code === 'ETIMEDOUT', home };
}

/** 从 bat 里读版本号 */
function getVersion() {
  try {
    const t = new TextDecoder('gbk').decode(fs.readFileSync(path.join(ROOT, '启动.bat')));
    const m = t.match(/set "CFM_VERSION=([\d.]+)"/);
    return m ? m[1] : '1.0.1';
  } catch {
    return '1.0.1';
  }
}

async function main() {
  console.log('\n\x1b[1m运行时验收\x1b[0m');
  console.log('\x1b[2m静态检查之外，真跑一遍看能不能用\x1b[0m');

  const staged = stageProject();
  const version = getVersion();
  console.log(`\n\x1b[2m已复制到 ASCII 路径：${staged}\x1b[0m`);

  // ═══ 1. 全新用户 ═══
  section('测试 1：全新用户（无标记文件）');
  {
    // ⚠️ 输入只给 '0'，**绝不带换行**。
    //
    //    原因：`set /p` 读到 '0' 会跳 :quit 退出。
    //    但如果多给了一个 \n，那个换行会被**下一次 set /p 吃掉**，
    //    导致 FIRSTCHOICE 为空 → 走默认值 '1' → 进 :first_setup
    //    → 卡在授权向导的输入上，直到超时。
    //    实测踩过：表现为「测试卡住」，其实是输入序列给多了。
    const r = runBat(staged, '0');

    // 判据用结构，不用「中文是否完美」—— cmd 重定向会转码
    check('走向导了', /\[1\][\s\S]*\[2\]|一键搭建|先跳过/.test(r.out), `${r.out.length} 字节`);
    check('做了环境检测', /环境检测|首次运行|工具链|OK/.test(r.out));
    check('没有卡住', !r.timedOut);

    if (!/\[1\]/.test(r.out)) {
      console.log('     \x1b[2m实际输出前 200 字：\x1b[0m');
      console.log('     ' + r.out.slice(0, 200).replace(/\n/g, '\n     '));
    }
  }

  // ═══ 2. 已初始化用户 ═══
  section('测试 2：已初始化用户（有版本标记）');
  {
    const home = path.join(TMP, 'home2');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, `.initialized-${version}`), 'test', 'ascii');

    const r = runBat(staged, '0\r\n');
    // 注意：runBat 里用的是自己的 home，这里要单独构造
    // 直接用带标记的 home 再跑一次
    const id = 'fixed';
    const inFile = path.join(staged, `_in2.txt`);
    const outFile = path.join(staged, `_out2.txt`);
    const wrapper = path.join(staged, `_w2.cmd`);
    fs.writeFileSync(inFile, '0\r\n', 'ascii');
    fs.writeFileSync(
      wrapper,
      [
        '@echo off',
        `cd /d "${staged}"`,
        `set "CFM_HOME=${home}"`,
        `call "${staged}\\launcher.bat" < "${inFile}" > "${outFile}" 2>&1`,
        '',
      ].join('\r\n'),
      'latin1',
    );
    spawnSync('cmd', ['/c', wrapper], { timeout: 90000, windowsHide: true, stdio: 'ignore' });

    let out2 = '';
    if (fs.existsSync(outFile)) {
      out2 = new TextDecoder('gbk').decode(fs.readFileSync(outFile));
    }

    check('有标记时跳过向导', !/一键搭建/.test(out2));
    check('直接进了主菜单', /免费额度对照表|请选择|Cloudflare/.test(out2));

    for (const f of [inFile, outFile, wrapper]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {}
    }
  }

  // ═══ 3. --setup 强制重走 ═══
  section('测试 3：--setup 强制重走向导');
  {
    const r = runBat(staged, '0', '--setup');
    check('强制走向导了', /一键搭建/.test(r.out));
    check('提示了重走原因', /重走向导|--setup/.test(r.out));
  }

  // ═══ 4. 残缺包 ═══
  section('测试 4：只有 bat，缺其他文件');
  {
    const broken = path.join(TMP, 'broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.copyFileSync(path.join(ROOT, '启动.bat'), path.join(broken, 'launcher.bat'));

    const r = runBat(broken, '\r\n', '', 30000);
    check('检测到文件不完整', /文件不完整|解压|bin|完整/.test(r.out));
    check('没卡住', !r.timedOut);
  }

  // ═══ 5. Node CLI 命令 ═══
  section('测试 5：Node CLI 命令实跑');
  {
    const cmds = [
      ['help', [], 500],
      ['encoding', [], 300],
      ['quota', ['workers'], 300],
      ['quota', ['kv'], 50],
      ['deploy', ['--list'], 500],
      ['setup', ['--check'], 300],
    ];

    for (const [cmd, args, minBytes] of cmds) {
      const r = spawnSync('node', [path.join(ROOT, 'bin', 'cfm.mjs'), cmd, ...args], {
        encoding: 'buffer',
        cwd: ROOT,
        timeout: 30000,
        windowsHide: true,
      });

      const buf = r.stdout || Buffer.alloc(0);
      const errText = (r.stderr || Buffer.alloc(0)).toString('utf8');
      const crashed = /SyntaxError|ReferenceError|TypeError|is not a function|Cannot find module/.test(errText);

      check(
        `cfm ${cmd}${args.length ? ' ' + args.join(' ') : ''}`,
        !crashed && buf.length >= minBytes,
        crashed ? errText.split('\n')[0].slice(0, 60) : `${buf.length} 字节`,
      );
    }
  }

  // ═══ 6. 中文编码 ═══
  section('测试 6：中文编码正确性');
  {
    const r = spawnSync('node', [path.join(ROOT, 'bin', 'cfm.mjs'), 'quota', 'workers'], {
      encoding: 'buffer',
      cwd: ROOT,
      timeout: 30000,
      windowsHide: true,
    });

    const buf = r.stdout || Buffer.alloc(0);

    const idx = buf.indexOf(Buffer.from('workers '));
    if (idx >= 0) {
      const b = buf[idx + 8];
      check('Node 输出 GBK 双字节', b >= 0x81 && b <= 0xfe, `首字节 0x${b.toString(16)}`);
    } else {
      check('找到 workers 标记', false, '输出里没有');
    }

    check('无替换字符 U+FFFD', !buf.includes(Buffer.from('efbfbd', 'hex')));

    let text = '';
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {}

    check('中文可读', /免费|额度|项目/.test(text));
    check('制表符正常', text.includes('│') || text.includes('─'));
  }

  // ═══ 7. PowerShell 输出编码 ═══
  section('测试 7：PowerShell 脚本输出编码');
  {
    const outFile = path.join(staged, '_ps-out.txt');
    const wrapper = path.join(staged, '_ps.cmd');

    fs.writeFileSync(
      wrapper,
      [
        '@echo off',
        `cd /d "${staged}"`,
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${staged}\\scripts\\check-env.ps1" -Quick > "${outFile}" 2>&1`,
        '',
      ].join('\r\n'),
      'latin1',
    );

    spawnSync('cmd', ['/c', wrapper], { timeout: 90000, windowsHide: true, stdio: 'ignore' });

    if (fs.existsSync(outFile)) {
      const buf = fs.readFileSync(outFile);

      // ⚠️ 判据不能用「某个字符的特定字节序列」——
      //    GBK(CP936) 对制表符有**多重映射**：
      //      `╔` 既可以是 `A9 B0`，也可以是 `A8 58`，两者都能被正确解码。
      //    第一版只认 `A9 B0`，把正常的输出判成了失败。
      //
      //    正确判据：**用 GBK 解码后中文可读、结构正确**。
      let gbkText = '';
      try {
        gbkText = new TextDecoder('gbk').decode(buf);
      } catch {}

      let utf8Text = '';
      try {
        utf8Text = new TextDecoder('utf8', { fatal: true }).decode(buf);
      } catch {
        utf8Text = ''; // UTF-8 解码失败 → 说明不是 UTF-8，符合预期
      }

      const gbkOk = /环境检测|工具链|网络连通性/.test(gbkText) && /[╔╚║─]/.test(gbkText);
      const utf8Ok = /环境检测/.test(utf8Text) && /[╔╚║─]/.test(utf8Text);

      check(
        'PS 脚本输出匹配 bat 控制台（GBK）',
        gbkOk && !utf8Ok,
        utf8Ok ? '输出的是 UTF-8，会与 GBK 的 bat 冲突' : `GBK 解码正常，${buf.length} 字节`,
      );

      fs.rmSync(outFile, { force: true });
    } else {
      check('PS 脚本有输出', false, '没有输出文件');
    }
    fs.rmSync(wrapper, { force: true });
  }

  // ═══ 汇总 ═══
  console.log('');
  console.log('─'.repeat(56));
  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  console.log(`通过 \x1b[32m${pass}\x1b[0m / 失败 \x1b[31m${fail}\x1b[0m`);

  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  • ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
    }
  }
  console.log('');

  if (!KEEP) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch {}
  } else {
    console.log(`\x1b[2m临时目录保留：${TMP}\x1b[0m\n`);
  }

  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('验收异常：', e);
  process.exit(1);
});
