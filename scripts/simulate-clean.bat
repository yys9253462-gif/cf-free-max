@echo off
REM ═══════════════════════════════════════════════════════════════════════════
REM  干净环境模拟器
REM
REM  作用：屏蔽掉 PATH 里所有「额外安装的工具」，只保留 Windows 自带的，
REM        用来模拟「小白拿到包时」的真实环境。
REM
REM  保留（Windows 10/11 自带）：
REM    curl.exe   tar.exe   powershell.exe   cmd.exe   where.exe
REM    find.exe   fc.exe    certutil.exe
REM
REM  屏蔽（需要用户自己装的）：
REM    node  npm  pnpm  git  gh  wrangler  python  go  java
REM
REM  用法：
REM    simulate-clean.bat                   显示当前屏蔽状态
REM    simulate-clean.bat <要运行的命令>     在干净环境里运行
REM
REM  注意：这只影响本进程树，不改系统环境变量。
REM ═══════════════════════════════════════════════════════════════════════════

setlocal EnableDelayedExpansion

REM ─── 构造一个只有系统目录的 PATH ───
set "CLEAN_PATH=%SystemRoot%\system32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0"

REM 如果传了参数，就在干净环境里执行
if "%~1"=="" goto :show_status

echo.
echo  [干净环境] 执行：%*
echo  [干净环境] PATH = %CLEAN_PATH%
echo.

REM 用干净的 PATH 启动一个新的 cmd
set "PATH=%CLEAN_PATH%"
cmd /c %*

endlocal
exit /b %errorlevel%


:show_status
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║            干净环境模拟器                                          ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.
echo  模拟「小白拿到包」的环境：只有 Windows 自带工具。
echo.
echo  ── Windows 自带（保留）───────────────────────────────────────────
echo.

set "CLEAN_PATH=%SystemRoot%\system32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0"

for %%t in (curl.exe tar.exe powershell.exe cmd.exe where.exe certutil.exe) do (
  set "FOUND="
  for %%d in ("%SystemRoot%\system32" "%SystemRoot%\System32\Wbem") do (
    if exist "%%~d\%%t" set "FOUND=%%~d\%%t"
  )
  if defined FOUND (
    echo    [OK]  %%t
    echo          !FOUND!
  ) else (
    echo    [--]  %%t  未找到
  )
)

echo.
echo  ── 需要用户自己装的（屏蔽）───────────────────────────────────────
echo.

for %%t in (node.exe npm.cmd pnpm.cmd git.exe gh.exe wrangler.cmd python.exe go.exe java.exe) do (
  set "REALPATH="
  for %%p in ("%PATH:;=" "%") do (
    if exist "%%~p\%%t" if not defined REALPATH set "REALPATH=%%~p\%%t"
  )
  if defined REALPATH (
    echo    [X]   %%t
    echo          当前已安装：!REALPATH!
    echo          干净环境下**不可见**
  ) else (
    echo    [ ]   %%t  本来就没装
  )
)

echo.
echo  ────────────────────────────────────────────────────────────────────
echo.
echo  用法：
echo    simulate-clean.bat node --version          验证 node 是否被屏蔽
echo    simulate-clean.bat "启动.bat"              在干净环境里跑启动脚本
echo    simulate-clean.bat cmd                      进入干净环境的命令行
echo.
echo  提示：这个模拟**只影响子进程**，你的系统环境不受影响。
echo.

endlocal
