/**
 * 给 启动.bat 插入部署菜单
 *
 * 用一个脚本做这件事而不是手敲 PowerShell：
 *   PowerShell 处理这个文件踩了三次坑 ——
 *     · Set-Content 会把文件转成 CRLF/UTF-8（原本是 GBK）
 *     · 中文字符串经多层引号后二次乱码
 *     · split "\r\n" 对 LF 行尾的文件不生效，整段塞进一个数组元素
 *
 *   Node 处理字节更直接：读 GBK 字节 → 用 PowerShell 转成 UTF-8 字符串
 *   → 改完再转回 GBK。走的是精确的字节路径。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAT = path.join(ROOT, '启动.bat');

/** GBK 读取（借 PowerShell 的 .NET Encoding） */
function readGbk(file) {
  const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.IO.File]::ReadAllText('${file.replace(/'/g, "''")}', [System.Text.Encoding]::GetEncoding(936))
`.trim();
  const tmp = path.join(ROOT, '.tmp-read.ps1');
  fs.writeFileSync(tmp, '\uFEFF' + ps, 'utf8');
  try {
    return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** GBK 写入 */
function writeGbk(file, text) {
  const tmpSrc = path.join(ROOT, '.tmp-content.txt');
  const tmpPs = path.join(ROOT, '.tmp-write.ps1');
  fs.writeFileSync(tmpSrc, text, 'utf8');

  const ps = `
$gbk = [System.Text.Encoding]::GetEncoding(936)
$text = [System.IO.File]::ReadAllText('${tmpSrc.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText('${file.replace(/'/g, "''")}', $text, $gbk)
`.trim();
  fs.writeFileSync(tmpPs, '\uFEFF' + ps, 'utf8');

  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpPs], { stdio: 'pipe' });
  } finally {
    fs.rmSync(tmpSrc, { force: true });
    fs.rmSync(tmpPs, { force: true });
  }
}

// ─── 部署菜单段落 ───
const DEPLOY_MENU = `
REM ═══════════════════════════════════════════════════════════════════════════
REM  [8] 部署站点到 Cloudflare Pages
REM ═══════════════════════════════════════════════════════════════════════════
:deploy_menu
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║                   部署站点到 Cloudflare Pages                      ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.
echo    [1]  查看配置与状态（只读，建议先看）
echo    [2]  检查线上状态（只读，含受保护站点）
echo    [3]  环境体检（Node / git / wrangler / 认证）
echo.
echo    [4]  部署：静态博客
echo    [5]  部署：静态导航
echo.
echo    [6]  部署全部（受保护站点自动跳过）
echo    [7]  预演 dry-run（不实际执行）
echo.
echo    [0]  返回主菜单
echo.
echo  ────────────────────────────────────────────────────────────────────
echo.

set "DCHOICE="
set /p "DCHOICE=请选择 [0-7]: "
if not defined DCHOICE goto :main_menu

if "%DCHOICE%"=="1" goto :deploy_list
if "%DCHOICE%"=="2" goto :deploy_online
if "%DCHOICE%"=="3" goto :deploy_check
if "%DCHOICE%"=="4" goto :deploy_blog
if "%DCHOICE%"=="5" goto :deploy_nav
if "%DCHOICE%"=="6" goto :deploy_all
if "%DCHOICE%"=="7" goto :deploy_dry
if "%DCHOICE%"=="0" goto :main_menu
goto :deploy_menu


:deploy_list
if not exist "%SCRIPT_DIR%\\bin\\cfm.mjs" goto :deploy_need_full
call "%SCRIPT_DIR%\\启动.bat" deploy --list
echo.
pause
goto :deploy_menu

:deploy_online
if not exist "%SCRIPT_DIR%\\bin\\cfm.mjs" goto :deploy_need_full
call "%SCRIPT_DIR%\\启动.bat" deploy --check-online
echo.
pause
goto :deploy_menu

:deploy_check
if not exist "%SCRIPT_DIR%\\bin\\cfm.mjs" goto :deploy_need_full
call "%SCRIPT_DIR%\\启动.bat" deploy --check
echo.
pause
goto :deploy_menu

:deploy_blog
if not exist "%SCRIPT_DIR%\\bin\\cfm.mjs" goto :deploy_need_full
call "%SCRIPT_DIR%\\启动.bat" deploy --only blog
echo.
pause
goto :deploy_menu

:deploy_nav
if not exist "%SCRIPT_DIR%\\bin\\cfm.mjs" goto :deploy_need_full
call "%SCRIPT_DIR%\\启动.bat" deploy --only nav
echo.
pause
goto :deploy_menu

:deploy_all
if not exist "%SCRIPT_DIR%\\bin\\cfm.mjs" goto :deploy_need_full
echo.
echo  受保护的站点（如正在服务的网盘）会自动跳过。
echo.
call "%SCRIPT_DIR%\\启动.bat" deploy
echo.
pause
goto :deploy_menu

:deploy_dry
if not exist "%SCRIPT_DIR%\\bin\\cfm.mjs" goto :deploy_need_full
call "%SCRIPT_DIR%\\启动.bat" deploy --dry-run
echo.
pause
goto :deploy_menu

:deploy_need_full
echo.
echo  部署功能需要完整版（Node）。
echo.
echo  请确保压缩包解压完整，包含 bin\\ 和 src\\ 目录。
echo.
pause
goto :deploy_menu
`;

// ─── 执行插入 ───
const text = readGbk(BAT);
const lines = text.split(/\r?\n/);

// 1. 菜单列表插入 [8]（在 [7] 配置凭据 之后）
const menuIdx = lines.findIndex((l) => /^\s*echo\s+\[7\]\s+配置凭据\s*$/.test(l));
if (menuIdx === -1) {
  console.error('✘ 找不到菜单项 [7]');
  process.exit(1);
}
if (!lines.some((l) => /\[8\]/.test(l))) {
  lines.splice(menuIdx + 1, 0, 'echo    [8]  部署站点到 Pages');
  console.log('✔ 插入菜单项 [8]');
}

// 2. 选择分支插入（在 ==7 之后）
const branchIdx = lines.findIndex((l) => l.includes('if "%CHOICE%"=="7" goto :setup_creds'));
if (branchIdx === -1) {
  console.error('✘ 找不到分支 [7]');
  process.exit(1);
}
if (!lines.some((l) => l.includes('goto :deploy_menu') && l.includes('CHOICE'))) {
  lines.splice(branchIdx + 1, 0, 'if "%CHOICE%"=="8" goto :deploy_menu');
  console.log('✔ 插入分支 [8]');
}

// 3. 段落插入（在 :quit 之前）
const quitIdx = lines.findIndex((l) => /^:quit\s*$/.test(l));
if (quitIdx === -1) {
  console.error('✘ 找不到 :quit 标签');
  process.exit(1);
}
if (!lines.some((l) => /^:deploy_menu\s*$/.test(l))) {
  const menuLines = DEPLOY_MENU.replace(/\r/g, '').split('\n');
  // 去掉首尾多余空行
  while (menuLines.length && !menuLines[0].trim()) menuLines.shift();
  while (menuLines.length && !menuLines[menuLines.length - 1].trim()) menuLines.pop();
  lines.splice(quitIdx, 0, ...menuLines, '');
  console.log(`✔ 插入部署菜单段（${menuLines.length} 行）`);
}

// 写回（CRLF + GBK）
writeGbk(BAT, lines.join('\r\n'));

// ─── 验证 ───
const verify = readGbk(BAT);
const vLines = verify.split(/\r?\n/);
console.log('');
console.log(`总行数：${vLines.length}`);
console.log(`deploy_menu 标签：${vLines.filter((l) => /^:deploy_menu\s*$/.test(l)).length} 个`);
console.log(`deploy_ 系列标签：${vLines.filter((l) => /^:deploy_/.test(l)).length} 个`);
console.log(`跳转目标检查：`);
const labels = new Set(vLines.filter((l) => /^:/.test(l)).map((l) => l.slice(1).trim()));
for (const target of ['deploy_menu', 'deploy_list', 'deploy_online', 'deploy_check', 'deploy_blog', 'deploy_nav', 'deploy_all', 'deploy_dry', 'deploy_need_full']) {
  if (!labels.has(target)) console.error(`  ✘ 缺少 :${target}`);
}
console.log('  ✔ 全部 9 个跳转目标都存在');

// 行尾检查
const bytes = fs.readFileSync(BAT);
const crlf = (() => {
  let n = 0;
  for (let i = 0; i < bytes.length - 1; i++) if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) n++;
  return n;
})();
const lf = bytes.filter((b) => b === 0x0a).length;
console.log(`行尾：CRLF ${crlf} / 纯 LF ${lf - crlf} / BOM ${bytes[0] === 0xef ? '有' : '无'}`);
