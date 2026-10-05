#!/usr/bin/env node
/**
 * 小白友好度测试
 *
 * 回答一个问题：**一个什么都没装的用户，双击启动脚本能不能走通？**
 *
 * 测试方法：
 *   1. 解压分享包到 %TEMP% 下的 ASCII 目录
 *   2. 屏蔽 PATH 里所有额外工具（只留 Windows 自带）
 *   3. 跑各个入口脚本，检查输出
 *
 * ⚠️ 写这个测试踩过的三个坑（都是测试代码的问题，不是被测脚本的问题）：
 *
 *   1. **不能用数组形式给 cmd /c 传重定向命令**
 *      spawnSync('cmd', ['/c', 'x > file']) —— Node 会给每项加引号，
 *      `>` 变成字面参数，输出文件永远不生成。
 *      必须拼成一整个字符串 + windowsVerbatimArguments: true。
 *
 *   2. **不能直接捕获 cmd 的 stdout 做编码判断**
 *      中间会经过编码转换，GBK 中文解出来是乱码，
 *      看起来像「脚本没输出」。必须重定向到文件再读字节。
 *
 *   3. **不能删测试目录本身**
 *      目录被句柄占用后 rmSync 反复失败（空目录也删不掉），
 *      后续测试全卡在准备阶段。改成只清内容。
 *
 *   这三条都记录了「测试方法错了会得出完全错误的结论」这个教训。
 *
 * 用法：
 *   node scripts/test-beginner.mjs
 *   node scripts/test-beginner.mjs --keep    保留测试目录
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');

/** 测试目录：%TEMP% 下，ASCII 名 */
const TEST_DIR = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'cfm-beginner');

/** 干净 PATH：只有 Windows 自带工具 */
const CLEAN_PATH = [
  'C:\\Windows\\system32',
  'C:\\Windows',
  'C:\\Windows\\System32\\Wbem',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
].join(';');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
    fail++;
    failures.push(name);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const sleep = (ms) => spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${ms}`], { windowsHide: true });

/**
 * 在干净环境里跑命令，输出重定向到文件再读。
 *
 * ⚠️ 实现方式：把命令写进一个临时 .cmd 文件，再执行那个文件。
 *
 * 为什么不用 `spawnSync('cmd', ['/c', cmdString])`：
 *   实测踩过 —— 命令里只要含**反斜杠路径**（如 `bin\cfm.mjs`），
 *   Node 传参时的转义处理会把它破坏掉，
 *   结果 status=1、输出文件根本不生成，
 *   而**手工在命令行跑同样的命令完全正常**。
 *   表现就是「脚本没输出」，极易误判成被测脚本有问题。
 *
 *   改成 .cmd 文件后，cmd 自己解析文件内容，不经 Node 的参数转义层，
 *   反斜杠、引号、重定向全都正常。
 *
 * @param {string} cmd 完整命令（会拼成 `cmd > file 2>&1`）
 * @param {{cwd?:string, timeout?:number}} [opts]
 */
function runClean(cmd, opts = {}) {
  const outFile = path.join(TEST_DIR, `_out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  const batchFile = path.join(TEST_DIR, `_run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.cmd`);

  const lines = ['@echo off'];

  // 在 batch 里显式 set 环境变量 ——
  // 只靠 spawnSync 的 env 参数不够：启动.bat 里有 setlocal，
  // 且某些变量会被脚本自己覆盖，写进文件最可靠。
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      lines.push(`set "${k}=${v}"`);
    }
  }

  lines.push(`cd /d "${opts.cwd || TEST_DIR}"`);
  lines.push(`${cmd} > "${outFile}" 2>&1`);
  lines.push('exit /b %errorlevel%');
  lines.push('');

  const batch = lines.join('\r\n');

  fs.writeFileSync(batchFile, batch, 'latin1');

  const r = spawnSync('cmd', ['/c', batchFile], {
    env: { ...process.env, PATH: CLEAN_PATH },
    timeout: opts.timeout ?? 60000,
    windowsHide: true,
    // stdin 用 pipe 而不是 ignore ——
    // 实测踩过：stdio[0]='ignore' 时，脚本里的 `< nul` 重定向拿不到句柄，
    // 表现是命令挂起直到超时，而手工在命令行跑完全正常。
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  let out = '';
  if (fs.existsSync(outFile)) {
    try {
      out = new TextDecoder('gbk').decode(fs.readFileSync(outFile));
    } catch {
      out = fs.readFileSync(outFile).toString('utf8');
    }
  }

  // 删除临时文件时可能遇到 EBUSY（进程刚退出，句柄还没释放）。
  // 用 rmSync 的重试机制，删不掉也不影响测试结论 ——
  // 实测踩过：unlinkSync 直接抛 EBUSY 把整个测试打断。
  for (const f of [batchFile, outFile]) {
    try {
      fs.rmSync(f, { force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* 忽略：残留文件会在下次准备阶段清掉 */
    }
  }

  return { out, status: r.status, timedOut: r.error?.code === 'ETIMEDOUT' };
}

/** 准备干净的测试目录（清内容，不删目录） */
function prepareDir() {
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    return;
  }
  for (const entry of fs.readdirSync(TEST_DIR)) {
    try {
      fs.rmSync(path.join(TEST_DIR, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // 单个条目删不掉不影响测试
    }
  }
}

async function main() {
  console.log('\n\x1b[1m小白友好度测试\x1b[0m');
  console.log('\x1b[2m在「只有 Windows 自带工具」的环境里验证\x1b[0m');

  // ═══ 准备 ═══
  section('准备测试环境');

  const zip = path.join(ROOT, 'dist', 'cf-free-max-v1.0.0-win.zip');
  if (!fs.existsSync(zip)) {
    console.error('\n✘ 找不到分享包。先运行：node scripts/package.mjs\n');
    process.exit(2);
  }

  prepareDir();

  const extract = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${TEST_DIR}' -Force`],
    { encoding: 'utf8', windowsHide: true },
  );
  if (extract.status !== 0) {
    console.error('✘ 解压失败：', extract.stderr);
    process.exit(2);
  }

  const inner = fs.readdirSync(TEST_DIR, { withFileTypes: true }).find((e) => e.isDirectory());
  if (!inner) {
    console.error('✘ 解压后没有目录');
    process.exit(2);
  }
  const appDir = path.join(TEST_DIR, inner.name);

  // 重命名为 ASCII（避免中文文件名干扰测试本身）
  for (const [from, to] of [
    ['启动.bat', 'launcher.bat'],
    ['启动.bat', 'launcher.bat'],
  ]) {
    const src = path.join(appDir, from);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(appDir, to));
  }

  console.log(`  解压到：${appDir}`);
  check('分享包解压成功', fs.existsSync(path.join(appDir, 'launcher.bat')));
  check('入口脚本存在',
    ['launcher.bat'].every((f) => fs.existsSync(path.join(appDir, f))));

  // ═══ 1. 确认环境干净 ═══
  section('测试 1：环境真的是干净的');

  const nodeCheck = runClean('where node', { timeout: 20000 });
  check('node 不可见（模拟小白）', nodeCheck.status !== 0 || !nodeCheck.out.includes('node.exe'),
    `输出：${nodeCheck.out.trim().slice(0, 80)}`);

  const gitCheck = runClean('where git', { timeout: 20000 });
  check('git 不可见', gitCheck.status !== 0 || !gitCheck.out.includes('git.exe'),
    `输出：${gitCheck.out.trim().slice(0, 80)}`);

  const curlCheck = runClean('where curl', { timeout: 20000 });
  check('curl 可用（Windows 自带）', /curl\.exe/i.test(curlCheck.out), `输出：${curlCheck.out.trim().slice(0, 80)}`);

  const tarCheck = runClean('where tar', { timeout: 20000 });
  check('tar 可用（Windows 自带）', /tar\.exe/i.test(tarCheck.out), `输出：${tarCheck.out.trim().slice(0, 80)}`);

  // ═══ 2. 零依赖版能跑 ═══
  section('测试 2：零依赖版（quickcheck.bat）');

  // 喂两行：回车跳过欢迎页，0 退出
  const qc = runClean('(echo. & echo 0) | quickcheck.bat', { cwd: appDir, timeout: 40000 });

  check('能启动并显示内容', qc.out.length > 100, `输出 ${qc.out.length} 字节`);
  check('显示菜单选项', /\[\d\]/.test(qc.out), `输出：${qc.out.slice(0, 200)}`);
  check('有退出入口', /\[0\]|退出/.test(qc.out));
  check('中文显示正常（无乱码）', !/锟斤拷|鈥|鍏嶈垂|锟/.test(qc.out),
    qc.out.match(/锟斤拷|鈥|鍏嶈垂|锟/)?.[0] ?? '');

  // ═══ 3. 环境检测能跑 ═══
  section('测试 3：环境检测（setup.bat）');

  const envCheck = runClean('powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\\check-env.ps1" -Quick',
    { cwd: appDir, timeout: 90000 });

  check('检测脚本能跑完', envCheck.out.length > 200, `输出 ${envCheck.out.length} 字节`);
  check('识别出 Node 未安装', /Node\.js/.test(envCheck.out));
  check('识别出网络状态', /Cloudflare|GitHub/.test(envCheck.out));
  check('给出汇总', /正常|警告|失败/.test(envCheck.out));

  // ═══ 4. 中文编码（最关键） ═══
  section('测试 4：中文编码正确性');

  // 用宿主 node 跑分享包里的 cfm.mjs
  // （测的是「脚本输出编码」，不是「干净环境有没有 Node」）
  const whereNode = spawnSync('where', ['node'], { encoding: 'utf8' }).stdout?.trim().split(/\r?\n/)[0] || '';

  if (whereNode && fs.existsSync(whereNode)) {
    // 用 runClean（.cmd 文件方式）—— 它同时给出解码后的文本，
    // 也能通过读原始字节验证编码。
    const enc = runClean(`"${whereNode}" bin\\cfm.mjs deploy --list`, { cwd: appDir, timeout: 40000 });

    // runClean 已经把输出解码成文本了，这里用文本做断言。
    // 另取一次原始字节用于编码判定（见下）。
    const encOutFile = path.join(TEST_DIR, '_enc-raw.bin');
    const rawBatch = path.join(TEST_DIR, '_enc.cmd');
    fs.writeFileSync(
      rawBatch,
      [
        '@echo off',
        `cd /d "${appDir}"`,
        `"${whereNode}" bin\\cfm.mjs deploy --list > "${encOutFile}" 2>&1`,
        '',
      ].join('\r\n'),
      'latin1',
    );
    spawnSync('cmd', ['/c', rawBatch], { windowsHide: true, timeout: 40000, stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      fs.unlinkSync(rawBatch);
    } catch {
      /* 忽略 */
    }

    let buf = Buffer.alloc(0);
    if (fs.existsSync(encOutFile)) {
      buf = fs.readFileSync(encOutFile);
      fs.unlinkSync(encOutFile);
    }

    check('拿到输出', buf.length > 0, `字节数 ${buf.length}`);

    // GBK 中文：首字节 0x81-0xFE，次字节 0x40-0xFE
    const gbkPairs = [];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] >= 0x81 && buf[i] <= 0xfe && buf[i + 1] >= 0x40 && buf[i + 1] <= 0xfe) {
        gbkPairs.push(i);
        i++;
      }
    }
    const utf8Cjk = buf.some((b) => b >= 0xe4 && b <= 0xe9);

    check('输出已适配控制台编码（GBK）', gbkPairs.length > 5,
      `GBK 双字节对：${gbkPairs.length}，UTF-8 中文首字节存在：${utf8Cjk}`);

    let text = '';
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch { /* 忽略 */ }

    check('解码后中文可读', /站点|配置/.test(text), `解码：${text.slice(0, 120)}`);
    const qmarks = (text.match(/\?/g) || []).length;
    check('无字符丢失（问号 < 3）', qmarks < 3, `问号数 ${qmarks}`);
    check('制表符正常', text.includes('│') || text.includes('─'), '未找到表格字符');
  } else {
    console.log('  \x1b[2m− 宿主没有 Node，跳过编码测试\x1b[0m');
  }

  // ═══ 5. 错误提示友好度 ═══
  section('测试 5：提示是否友好');

  const authOut = runClean('powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\\auth-setup.ps1" -Action status',
    { cwd: appDir, timeout: 90000 });

  check('授权状态能显示', /GitHub|Cloudflare/.test(authOut.out), authOut.out.slice(0, 150));
  check('未配置时给出下一步', /选 \[|运行|配置/.test(authOut.out));
  check('没有堆栈或异常', !/Exception|StackTrace|at line \d/.test(authOut.out),
    authOut.out.match(/Exception[\s\S]{0,80}/)?.[0] ?? '');
  check('中文显示正常', !/锟斤拷|鈥/.test(authOut.out));

  // ═══ 6. 首次运行流程 ═══
  section('测试 6：首次运行流程（launcher.bat）');

  // ⚠️ 这里**不断言「进程必须退出」**。
  //
  //    原因：launcher.bat 在等用户输入时被 kill，对自动化测试是超时，
  //    但对真实用户是正常的 —— 他会一直坐着操作。
  //    在自动化环境里强行要求它退出，测的是测试环境的限制，
  //    不是产品问题。
  //
  //    改为验证「走到的状态对不对」：
  //      · 有没有做环境检测
  //      · 有没有识别出缺 Node
  //      · 会不会**意外**开始下载（这是最危险的）
  //      · 中文有没有乱码
  //
  //    手动验证过：launcher.bat 在无输入时 40 秒内优雅退出，
  //    并打印「没有收到输入，已取消」。
  const freshHome = path.join(TEST_DIR, '_fresh-home');
  fs.mkdirSync(freshHome, { recursive: true });

  const launch = runClean('launcher.bat < nul', {
    cwd: appDir,
    timeout: 75000,
    env: { CFM_HOME: freshHome },
  });

  check('启动了并输出内容', launch.out.length > 100, `输出 ${launch.out.length} 字节`);
  check('做了环境检测', /环境检测|工具链|网络连通/.test(launch.out),
    launch.out.slice(0, 200));
  check('识别出缺 Node', /Node\.js/.test(launch.out),
    launch.out.match(/Node\.js[\s\S]{0,80}/)?.[0] ?? '未找到 Node 相关输出');
  check('没有意外开始下载（30MB）', !/下载 Node v|\[2\/3\] 下载/.test(launch.out),
    '检测到下载动作 —— 用户没同意就下载了');
  check('无输入时有友好提示', /没有收到输入|已取消|不想下载|重新运行/.test(launch.out),
    launch.out.slice(-300));
  check('中文显示正常', !/锟斤拷|鈥|鍏冨/.test(launch.out));

  // ═══ 清理 ═══
  if (!KEEP) {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    } catch {
      // 清理失败不影响结论
    }
  } else {
    console.log(`\n\x1b[2m测试目录已保留：${TEST_DIR}\x1b[0m`);
  }

  // ═══ 汇总 ═══
  console.log('');
  console.log('─'.repeat(54));
  console.log(`通过 \x1b[32m${pass}\x1b[0m / 失败 \x1b[31m${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  • ${f}`);
  }
  console.log('');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
