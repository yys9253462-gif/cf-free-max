@echo off
REM ═══════════════════════════════════════════════════════════════════════════
REM  cf-free-max 启动器（Windows）
REM
REM  作用：检测环境 → 必要时自动获取 Node → 启动工具箱
REM
REM  编码：本文件为 ANSI/GBK(CP936)，**不要加 chcp 65001**
REM        （加了两边都乱码：批处理自身按 ANSI 解析，而控制台切成 UTF-8）
REM
REM  注意：批处理不支持 ") else if (" 链式语法（会闪退），
REM        所有分支都用独立 if 或标签跳转。
REM ═══════════════════════════════════════════════════════════════════════════

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "ENTRY=%SCRIPT_DIR%\bin\cfm.mjs"

REM 便携版 Node 的存放位置：优先用环境变量指定，否则放用户目录
if not defined CFM_HOME set "CFM_HOME=%LOCALAPPDATA%\cf-free-max"
set "NODE_DIR=%CFM_HOME%\node"
set "NODE_EXE=%NODE_DIR%\node.exe"

REM Node 版本（LTS）
set "NODE_VERSION=22.11.0"
set "NODE_ZIP=node-v%NODE_VERSION%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%"
set "NODE_MIRROR=https://npmmirror.com/mirrors/node/v%NODE_VERSION%/%NODE_ZIP%"

title Cloudflare 免费额度工具箱
color 0B

REM ─── 入口检查 ───
if not exist "%ENTRY%" goto :missing_source

REM ─── 优先用系统 Node ───
where node >nul 2>&1
if %errorlevel%==0 goto :use_system_node

REM ─── 再找之前下载的便携版 ───
if exist "%NODE_EXE%" goto :use_portable_node

REM ─── 都没有，进入获取流程 ───
goto :need_node


REM ═══════════════════════════════════════════════════════════════════════════
REM  使用系统已安装的 Node
REM ═══════════════════════════════════════════════════════════════════════════
:use_system_node
for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
echo [启动] 使用系统 Node %NODE_VER%
echo.
node "%ENTRY%" %*
set "EXITCODE=%errorlevel%"
goto :done


REM ═══════════════════════════════════════════════════════════════════════════
REM  使用已下载的便携版 Node
REM ═══════════════════════════════════════════════════════════════════════════
:use_portable_node
echo [启动] 使用便携版 Node（%NODE_DIR%）
echo.
"%NODE_EXE%" "%ENTRY%" %*
set "EXITCODE=%errorlevel%"
goto :done


REM ═══════════════════════════════════════════════════════════════════════════
REM  需要获取 Node
REM ═══════════════════════════════════════════════════════════════════════════
:need_node
cls
echo.
echo  ╔══════════════════════════════════════════════════════════════╗
echo  ║            Cloudflare 免费额度工具箱                          ║
echo  ╚══════════════════════════════════════════════════════════════╝
echo.
echo  首次运行需要 Node.js 运行时（约 30 MB）。
echo.
echo  本工具不会安装到系统里，而是下载一个**便携版**解压到：
echo    %NODE_DIR%
echo.
echo  如果你不想下载，也可以：
echo    1. 自己去 https://nodejs.org 装 Node，然后重新运行本文件
echo    2. 用零依赖的 shell 版（需 WSL/Git Bash）：
echo       scripts\cf-quick-check.sh
echo.
echo  ────────────────────────────────────────────────────────────────
echo.
set /p "CHOICE=现在自动下载便携版 Node？[Y/n] "

REM 输入耗尽（被脚本调用/管道）时按默认处理，不卡住
if not defined CHOICE set "CHOICE=Y"
if /i "%CHOICE%"=="n" goto :user_declined
if /i "%CHOICE%"=="no" goto :user_declined
goto :download_node

:user_declined
echo.
echo  已取消。安装 Node 后重新运行本文件即可。
echo.
pause
exit /b 0


:download_node
echo.
echo [1/3] 创建目录...
if not exist "%NODE_DIR%" mkdir "%NODE_DIR%" >nul 2>&1
if not exist "%CFM_HOME%" mkdir "%CFM_HOME%" >nul 2>&1

set "TEMP_ZIP=%CFM_HOME%\%NODE_ZIP%"

REM ─── 下载（先官方源，失败则用国内镜像）───
echo [2/3] 下载 Node v%NODE_VERSION%（约 30 MB，请稍候）...
echo.

where curl >nul 2>&1
if not %errorlevel%==0 goto :download_ps

echo   尝试官方源 nodejs.org ...
curl -L --fail --progress-bar -o "%TEMP_ZIP%" "%NODE_URL%"
if %errorlevel%==0 goto :download_ok

echo.
echo   官方源失败，切换国内镜像 ...
curl -L --fail --progress-bar -o "%TEMP_ZIP%" "%NODE_MIRROR%"
if %errorlevel%==0 goto :download_ok

goto :download_failed


:download_ps
REM 没有 curl（极老的系统），用 PowerShell 下载
echo   使用 PowerShell 下载 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue';" ^
  "try { Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%TEMP_ZIP%' -UseBasicParsing } catch { try { Invoke-WebRequest -Uri '%NODE_MIRROR%' -OutFile '%TEMP_ZIP%' -UseBasicParsing } catch { exit 1 } }"
if %errorlevel%==0 goto :download_ok
goto :download_failed


:download_ok
echo.
echo   下载完成，正在校验 ...
call :verify_zip
if not %errorlevel%==0 goto :download_failed

echo [3/3] 解压 ...
REM tar.exe 是 Windows 10 1803+ 自带的，比 PowerShell 的 Expand-Archive 快很多
where tar >nul 2>&1
if not %errorlevel%==0 goto :extract_ps

tar -xf "%TEMP_ZIP%" -C "%NODE_DIR%" --strip-components=1
if not %errorlevel%==0 goto :extract_ps
goto :extract_ok

:extract_ps
echo   使用 PowerShell 解压 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "Expand-Archive -Path '%TEMP_ZIP%' -DestinationPath '%NODE_DIR%\_tmp' -Force;" ^
  "$inner = Get-ChildItem '%NODE_DIR%\_tmp' -Directory | Select-Object -First 1;" ^
  "Get-ChildItem $inner.FullName | Move-Item -Destination '%NODE_DIR%' -Force;" ^
  "Remove-Item '%NODE_DIR%\_tmp' -Recurse -Force"
if not %errorlevel%==0 goto :extract_failed

:extract_ok
del "%TEMP_ZIP%" >nul 2>&1

if not exist "%NODE_EXE%" goto :extract_failed

echo.
echo  ? 便携版 Node 已就绪
echo.
echo  ────────────────────────────────────────────────────────────────
echo.
"%NODE_EXE%" "%ENTRY%" %*
set "EXITCODE=%errorlevel%"
goto :done


:verify_zip
REM 校验下载的是 zip（防止下载到错误页面的 HTML）
REM 这是必须的：某些网络环境下会被劫持返回 HTML，直接解压会得到一堆垃圾
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$b = [System.IO.File]::ReadAllBytes('%TEMP_ZIP%');" ^
  "if ($b.Length -lt 1000000) { Write-Host '  文件太小，可能下载失败'; exit 1 };" ^
  "if ($b[0] -ne 0x50 -or $b[1] -ne 0x4B) { Write-Host '  不是有效的 zip 文件'; exit 1 };" ^
  "Write-Host ('  文件大小 ' + [math]::Round($b.Length/1MB,1) + ' MB，格式正常')"
exit /b %errorlevel%


:download_failed
echo.
echo  ? 下载失败。
echo.
echo  可能的原因：
echo    - 网络不通或被防火墙拦截
echo    - 需要代理（设置 HTTP_PROXY 环境变量后重试）
echo.
echo  手动解决办法：
echo    1. 用浏览器打开 %NODE_URL%
echo    2. 把下载的 %NODE_ZIP% 放到 %CFM_HOME%\
echo    3. 重新运行本文件
echo.
if exist "%TEMP_ZIP%" del "%TEMP_ZIP%" >nul 2>&1
pause
exit /b 1


:extract_failed
echo.
echo  ? 解压失败。
echo.
echo  请手动解压 %TEMP_ZIP% 到 %NODE_DIR%
echo  （确保 node.exe 在 %NODE_DIR%\node.exe）
echo.
pause
exit /b 1


REM ═══════════════════════════════════════════════════════════════════════════
REM  找不到源码
REM ═══════════════════════════════════════════════════════════════════════════
:missing_source
echo.
echo  ? 找不到程序文件：
echo    %ENTRY%
echo.
echo  本 .bat 必须和 bin\ 、src\ 等目录放在一起使用。
echo.
echo  如果你是单独下载了这个 .bat 文件，请到项目页面下载完整压缩包：
echo    https://github.com/yys9253462-gif/cf-free-max/releases
echo.
pause
exit /b 1


REM ═══════════════════════════════════════════════════════════════════════════
REM  结束
REM ═══════════════════════════════════════════════════════════════════════════
:done
REM 交互模式下程序自己会 pause；命令行模式直接带退出码返回
if "%EXITCODE%"=="" set "EXITCODE=0"
endlocal & exit /b %EXITCODE%
