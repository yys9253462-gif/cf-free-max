@echo off
REM ═══════════════════════════════════════════════════════════════════════════
REM  环境检测 + 授权向导（独立入口）
REM
REM  给已经有 Node 环境的用户准备的快捷入口 —— 不启动主程序，
REM  直接跑检测或授权。
REM
REM  编码：ANSI/GBK(CP936)，不要加 chcp 65001
REM ═══════════════════════════════════════════════════════════════════════════

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PS1_DIR=%SCRIPT_DIR%\scripts"
title 环境检测与授权
color 0B

if not exist "%PS1_DIR%\check-env.ps1" goto :missing

:menu
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║              环境检测 与 授权向导                                  ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.
echo    [1]  完整环境检测
echo         检查工具链、网络、授权、配置、仓库（约 10 秒）
echo.
echo    [2]  快速检测
echo         只查关键项：Node / 网络 / 授权
echo.
echo    [3]  授权向导
echo         GitHub 授权 / Cloudflare Token / 浏览器登录，三件事一次搞定
echo.
echo    [4]  查看授权状态
echo.
echo    [0]  退出
echo.
echo  ────────────────────────────────────────────────────────────────────
echo.

set "C="
set /p "C=请选择 [0-4]: "
if not defined C goto :quit

if "%C%"=="1" goto :full
if "%C%"=="2" goto :quick
if "%C%"=="3" goto :auth
if "%C%"=="4" goto :status
if "%C%"=="0" goto :quit
goto :menu


:full
cls
echo.
echo  正在检测（约 10 秒）...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\check-env.ps1"
echo.
echo  ────────────────────────────────────────────────────────────────────
echo.
echo  检测完成后可以：
echo    · 有 [X] 失败项  → 按提示处理后重跑
echo    · 想配授权      → 选菜单的 [3]
echo.
pause
goto :menu


:quick
cls
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\check-env.ps1" -Quick
echo.
pause
goto :menu


:auth
cls
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\auth-setup.ps1"
goto :menu


:status
cls
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\auth-setup.ps1" -Action status
goto :menu


:missing
echo.
echo  ? 找不到 %PS1_DIR%\check-env.ps1
echo.
echo  请确认压缩包解压完整，包含 scripts\ 目录。
echo.
pause
exit /b 1


:quit
cls
echo.
echo  再见。
echo.
endlocal
exit /b 0
