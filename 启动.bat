@echo off
REM ═══════════════════════════════════════════════════════════════════════════
REM  cf-free-max 快速版（Windows，无需 Node）
REM
REM  ?? 维护须知（这些都是踩过的坑，改之前先看）：
REM
REM   1. 本文件必须 ANSI/GBK(CP936) + CRLF + 无 BOM，三者缺一不可。
REM      **不要加 chcp 65001** —— 中文环境下会两头乱码。
REM
REM   2. **绝对不要在这个文件里内嵌多行 PowerShell 命令**。
REM      实测必然失败：.bat 是 GBK，其中的中文经 cmd 代码页 →
REM      PowerShell 参数解析后变乱码，乱码里的 ? 等字符会破坏 PS 语法，
REM      报一堆 "The term '^' is not recognized"。
REM      所有 PowerShell 逻辑都要外置成独立 .ps1 文件。
REM
REM   3. 批处理不支持 ") else if (" 链式语法（会闪退），
REM      所有分支用独立 if 或标签跳转。
REM
REM   4. 读取用户输入后要检查变量是否定义（EOF 检测），
REM      否则输入耗尽时会死循环刷屏。
REM ═══════════════════════════════════════════════════════════════════════════

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PS1_DIR=%SCRIPT_DIR%\scripts"

REM ─── 路径与 Node 相关变量 ───
REM
REM 这些原本在 启动.bat 里。两个文件合并后集中定义在这里。
REM 忘了定义会怎样：set 出来是空的，后面拼路径会变成 "\node\node.exe"，
REM 报的错看不出根因。实测踩过。
set "ENTRY=%SCRIPT_DIR%\bin\cfm.mjs"
if not defined CFM_HOME set "CFM_HOME=%LOCALAPPDATA%\cf-free-max"
set "NODE_DIR=%CFM_HOME%\node"
set "NODE_EXE=%NODE_DIR%\node.exe"

REM Node 版本（LTS）。改这里就能换版本。
set "NODE_VERSION=22.11.0"
set "NODE_ZIP=node-v%NODE_VERSION%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%"
set "NODE_MIRROR=https://npmmirror.com/mirrors/node/v%NODE_VERSION%/%NODE_ZIP%"

REM 首次运行标记 —— 用来判断要不要走环境检测流程
set "FIRST_RUN_FLAG=%CFM_HOME%\.initialized"

REM 便携版 Node 如果已存在，直接加进 PATH，后面 where node 就能找到
if exist "%NODE_EXE%" set "PATH=%NODE_DIR%;%PATH%"

REM ─── 关于「字体检查」───
REM
REM 曾经在这里加过字体检测（调 check-font.ps1 读注册表），**已移除**。
REM
REM 原因：实测反馈「加上之后中文变方块了」，而用户之前是正常的。
REM 检测本身要启动 PowerShell 子进程，会继承控制台 —— 可能影响终端状态。
REM
REM 工具的价值是能干活，不是检测环境。字体问题让用户自己改就行。

REM 需要检测时显式开启：
if "%CFM_FONT_CHECK%"=="1" (
  if exist "%PS1_DIR%\check-font.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\check-font.ps1" >nul 2>&1
    if errorlevel 1 call :warn_font
  )
)
set "ENV_FILE=%SCRIPT_DIR%\.env"
title Cloudflare 免费额度工具箱
color 0B

REM ─── 读取 .env 凭据 ───
call :load_env

REM ─── 启动后先给点有用的东西，而不是空菜单 ───
REM 注意：这里**不能** goto :welcome ——
REM       那会跳过下面的首次运行流程（实测踩过：代码成了死代码）


REM ═══════════════════════════════════════════════════════════════════════════
REM  首次进入：显示概览而不是只给菜单
REM ═══════════════════════════════════════════════════════════════════════════
REM ═══════════════════════════════════════════════════════════════════════════
REM  入口：首次运行流程
REM
REM  为什么要这个：
REM    新用户双击进来时，电脑上可能什么都没有 —— 没凭据、没 git、没 Node。
REM    直接进主菜单的话，他点 [2] 查用量会失败，但不知道为什么。
REM    所以第一次运行先做一遍环境检测，把问题在入口处说清楚。
REM
REM  只在首次运行时做（用标记文件记住），之后想重跑可以从菜单选 [3]。
REM ═══════════════════════════════════════════════════════════════════════════

REM ─── 完整性检查（必须放在最前面）───
REM
REM 单独一个 .bat 是跑不起来的 —— 它要调 bin/cfm.mjs 和 scripts/*.ps1。
REM 用户如果只解压了这一个文件（或解压出错），界面能显示但什么都干不了。
REM
REM ?? 必须放在所有 goto 之前 —— 实测踩过：
REM    原来放在首次流程后面，而前面的 `if not exist check-env.ps1 goto :welcome`
REM    会先跳走，导致这段成了死代码、用户什么提示都看不到。
if not exist "%SCRIPT_DIR%\bin\cfm.mjs" goto :incomplete
if not exist "%SCRIPT_DIR%\scripts\check-env.ps1" goto :incomplete
if not exist "%SCRIPT_DIR%\config\sites.json" goto :incomplete


if exist "%FIRST_RUN_FLAG%" goto :welcome
if not exist "%PS1_DIR%\check-env.ps1" goto :welcome

REM ─── 首次运行 ───
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║                    首次运行 · 环境检测                             ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.
echo  正在检查你的环境（工具链 / 网络 / 授权 / 配置）...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\check-env.ps1"

:first_ask
echo.
echo  ────────────────────────────────────────────────────────────────
echo.
echo  接下来做什么？
echo.
echo    [1]  一键搭建（推荐）
echo         自动完成：检测环境 → 配置授权 → 配置部署 → 进主界面
echo         中间只会问你必须回答的（GitHub 用户名、要不要绑域名）
echo.
echo    [2]  先跳过，直接进主界面
echo         额度查询等功能可用；搭建可以稍后再做
echo.
echo    [0]  退出
echo.
set "FIRSTCHOICE="
set /p "FIRSTCHOICE=请选择 [0-2]: "

REM 输入耗尽（被脚本调用/管道）→ 按推荐选项走，不卡住
if not defined FIRSTCHOICE set "FIRSTCHOICE=1"

if "%FIRSTCHOICE%"=="1" goto :first_setup
if "%FIRSTCHOICE%"=="2" goto :first_done
if "%FIRSTCHOICE%"=="0" goto :quit

REM 无效输入只重问，不重跑检测
echo.
echo  无效选择，请输入 0、1 或 2。
ping -n 2 127.0.0.1 >nul 2>&1
goto :first_ask


REM ═══════════════════════════════════════════════════════════════════════════
REM  一键搭建
REM
REM  顺序：授权向导 → setup 向导 → 写标记 → 进主界面
REM
REM  ?? 必须先授权再 setup ——
REM     setup 要用 Cloudflare Token 去创建 D1/R2，没授权它做不了。
REM ═══════════════════════════════════════════════════════════════════════════
:first_setup

REM ─── 第 1 步：授权向导 ───
echo.
echo  ════════════════════════════════════════════════════════════════
echo   [1/3] 配置授权
echo  ════════════════════════════════════════════════════════════════
echo.
if not exist "%PS1_DIR%\auth-setup.ps1" (
  echo  跳过（找不到授权脚本，可能解压不完整）
  goto :first_setup_deploy
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\auth-setup.ps1"

:first_setup_deploy
REM ─── 第 2 步：部署配置向导 ───
echo.
echo  ════════════════════════════════════════════════════════════════
echo   [2/3] 配置部署
echo  ════════════════════════════════════════════════════════════════
echo.
echo  这一步会：
echo    · 自动检测你的 GitHub 账号
echo    · 自动分析每个仓库的构建方式
echo    · 自动在你账号下创建需要的数据库 / 存储
echo.

REM 确认 Node 可用（没有就问要不要下载）
where node >nul 2>&1
if %errorlevel%==0 goto :first_setup_run
if exist "%NODE_EXE%" (
  set "PATH=%NODE_DIR%;%PATH%"
  goto :first_setup_run
)

echo  配置部署需要 Node.js，当前没有可用的。
echo.
choice /c YN /n /m "  现在下载便携版 Node（约 30 MB）？[Y/N] "
if errorlevel 2 goto :first_setup_skip

REM 下载逻辑复用 :lf_download 那段（它用 goto 串联，不是子程序）。
REM 所以这里设一个标记，下载完让它回到 setup 而不是回主菜单。
set "CFM_AFTER_DOWNLOAD=setup"
goto :lf_download

:first_setup_run
node "%SCRIPT_DIR%\bin\cfm.mjs" setup
if errorlevel 1 goto :first_setup_skip

echo.
echo  ════════════════════════════════════════════════════════════════
echo   [3/3] 完成
echo  ════════════════════════════════════════════════════════════════════
echo.
echo  一键搭建完成。
echo.
goto :first_done


:first_setup_skip
echo.
echo  搭建未完成 —— 可以稍后在主界面选 [3] 重新配置。
echo.


:first_done
REM 写标记文件，下次不再走首次流程
REM 写标记文件，下次不再走首次流程
if not exist "%CFM_HOME%" mkdir "%CFM_HOME%" >nul 2>&1
echo initialized at %DATE% %TIME% > "%FIRST_RUN_FLAG%" 2>nul
echo.
echo  初始化完成，正在进入主界面 ...
ping -n 3 127.0.0.1 >nul 2>&1




:welcome
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║           Cloudflare 免费额度工具箱                     ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.

if defined CF_API_TOKEN goto :welcome_with_creds

echo   ┌─ 免费层能给你什么 ─────────────────────────────────────────────┐
echo   │                                                                │
echo   │   Workers      每天 10 万次请求    (够日活几千的小应用)          │
echo   │   R2 存储      10 GB + 出站流量完全免费  (比 S3 省 100%%)        │
echo   │   D1 数据库    每天 500 万行扫描   (加好索引够用)                │
echo   │   Pages        静态托管不限带宽    (博客白嫖首选)                │
echo   │   Tunnel       内网穿透，不限量    (不用开放任何入站端口)        │
echo   │                                                                │
echo   └────────────────────────────────────────────────────────────────┘
echo.
echo   这些额度大多数人用不完 —— 问题通常不是「不够」，而是
echo   「不知道自己有多少、被什么吃掉了」。
echo.
echo   ────────────────────────────────────────────────────────────────
echo.
echo   要看你自己的真实用量，需要配置一个 API Token（免费，2 分钟）。
echo.
echo   [7]  配置凭据  —— 向导会告诉你点哪里、勾哪个
echo   [1]  先看看额度表（不需要凭据）
echo   [4]  算算你的用法撑不撑得住（不需要凭据）
echo.
goto :menu_prompt


:welcome_with_creds
echo   ● 凭据已配置
if defined CF_ACCOUNT_ID echo   ● 账号：%CF_ACCOUNT_ID%
echo.
echo   ────────────────────────────────────────────────────────────────
echo.
goto :menu_prompt


REM ═══════════════════════════════════════════════════════════════════════════
REM  主菜单
REM ═══════════════════════════════════════════════════════════════════════════
:main_menu
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║           Cloudflare 免费额度工具箱                     ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.

if defined CF_API_TOKEN (
  echo   ● 凭据：已配置
) else (
  echo   ● 凭据：未配置 (只能看额度表，不能查实时用量)
)
if defined CF_ACCOUNT_ID echo   ● 账号：%CF_ACCOUNT_ID%
echo.
echo  ────────────────────────────────────────────────────────────────────
echo.
echo    [1]  查看免费额度对照表        离线可用
echo    [2]  查询我的实时用量          需要凭据
echo    [3]  环境检测与授权            （检测环境 / 配置授权 / 看状态）
echo    [4]  KV 写入压力估算           离线可用
echo    [5]  部署站点到 Pages
echo    [6]  启动完整版界面            （需要 Node，没有会自动询问下载）
echo    [7]  打开项目主页 / 文档
echo    [8]  配置 Cloudflare 凭据
echo.
echo    [0]  退出
echo.
echo  ────────────────────────────────────────────────────────────────────

:menu_prompt
set "CHOICE="
set /p "CHOICE=请选择 [0-8]: "

REM 输入耗尽（管道/被脚本调用）—— 直接退出，避免死循环刷屏
if not defined CHOICE goto :quit

if "%CHOICE%"=="1" goto :quota_table
if "%CHOICE%"=="2" goto :live_usage
if "%CHOICE%"=="3" goto :env_menu
if "%CHOICE%"=="4" goto :kv_est
if "%CHOICE%"=="5" goto :deploy_menu
if "%CHOICE%"=="6" goto :launch_full
if "%CHOICE%"=="7" goto :open_home
if "%CHOICE%"=="8" goto :setup_creds
if "%CHOICE%"=="0" goto :quit
if /i "%CHOICE%"=="q" goto :quit

echo.
echo  无效选择，请重新输入。
REM 用 ping 做延时而不是 timeout —— timeout 在输入重定向时
REM 会报 "输入重定向不受支持" 并立即返回，失去延时作用
ping -n 2 127.0.0.1 >nul 2>&1
goto :main_menu


REM ═══════════════════════════════════════════════════════════════════════════
REM  [1] 额度对照表
REM ═══════════════════════════════════════════════════════════════════════════
:quota_table
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║                     Cloudflare 免费额度对照表                      ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.
echo   ── Workers ─────────────────────────────────────────────────────────
echo     请求数            100,000 / 天
echo     CPU 时间          10 ms / 请求
echo     脚本大小          3 MiB (压缩后)
echo     脚本数量          100 个
echo     子请求            50 / 次调用
echo     环境变量          64 / Worker
echo.
echo   ── Workers KV ──────────────────────────────────────────────────────
echo     读                100,000 / 天
echo     写                1,000 / 天        ^<-- 最容易撞墙
echo     删除              1,000 / 天
echo     列表              1,000 / 天
echo     存储              1 GiB
echo.
echo   ── D1 数据库 ───────────────────────────────────────────────────────
echo     扫描行数          5,000,000 / 天    ^<-- 按扫描量，不是返回量
echo     写入行数          100,000 / 天
echo     存储              5 GB
echo     数据库数          10 个
echo     单库大小          500 MB
echo.
echo   ── R2 对象存储 ─────────────────────────────────────────────────────
echo     存储              10 GB / 月
echo     Class A (写/列表) 1,000,000 / 月
echo     Class B (读)      10,000,000 / 月
echo     出站流量          免费且不限量      ^<-- R2 最大卖点
echo.
echo   ── Pages ───────────────────────────────────────────────────────────
echo     构建次数          500 / 月          ^<-- 高频提交会烧光
echo     文件数            20,000 / 站
echo     单文件大小        25 MiB
echo     静态带宽          不限量
echo.
echo   ── 其它 ────────────────────────────────────────────────────────────
echo     DNS 记录          200 / 域名
echo     缓存清理          1,000 次调用 / 天
echo     页面规则          5 条 / 域名
echo     Tunnel            不限数量，免费
echo     Workers AI        10,000 neurons / 天
echo.
echo  ════════════════════════════════════════════════════════════════════
echo   最容易踩的五个坑
echo  ════════════════════════════════════════════════════════════════════
echo.
echo   1. KV 每天只有 1000 次写
echo      用 KV 做「每次请求都写」的计数器，1000 个访客就打满，
echo      之后所有写返回 429。改用 D1 (10 万行/天) 或 Durable Objects。
echo.
echo   2. D1 按「扫描行数」计费，不是返回行数
echo      缺索引的查询会全表扫描。表 10 万行时每次扣 10 万行，
echo      50 次查询就打满当天额度。务必建索引。
echo.
echo   3. Workers 单次调用最多 50 个子请求
echo      循环里批量调第三方 API 会直接抛异常，需要分批 + 限流。
echo.
echo   4. R2 的 Class A 只有 100 万次/月
echo      频繁 list 判断对象是否存在会快速消耗。改用 head (算 Class B)。
echo.
echo   5. Pages 每月 500 次构建
echo      每次 git push 触发一次。纯静态站点改用 Workers Static Assets
echo      可以不消耗构建额度。
echo.
echo.
pause
goto :main_menu


REM ═══════════════════════════════════════════════════════════════════════════
REM  [2] 实时用量
REM ═══════════════════════════════════════════════════════════════════════════
:live_usage
if not defined CF_API_TOKEN goto :usage_no_token
if not exist "%PS1_DIR%\query-usage.ps1" goto :missing_scripts
echo.
echo  正在查询用量 ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\query-usage.ps1" -Token "%CF_API_TOKEN%" -AccountId "%CF_ACCOUNT_ID%"
echo.
pause
goto :main_menu

:usage_no_token
echo.
echo  x 未配置凭据，无法查询实时用量。
echo.
echo  请先选 [7] 配置凭据，或用 [1] 查看额度对照表。
echo.
pause
goto :main_menu


REM ═══════════════════════════════════════════════════════════════════════════
REM  [3] 检查凭据
REM ═══════════════════════════════════════════════════════════════════════════
:check_creds
if not exist "%PS1_DIR%\check-creds.ps1" goto :missing_scripts
cls
echo.
if not defined CF_API_TOKEN goto :creds_no_token
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\check-creds.ps1" -Token "%CF_API_TOKEN%" -EnvFile "%ENV_FILE%"
goto :creds_end

:creds_no_token
echo   x 未配置 CF_API_TOKEN。
echo.
echo   用 [7] 配置。

:creds_end
echo.
pause
goto :main_menu


REM ═══════════════════════════════════════════════════════════════════════════
REM  [4] KV 写入压力估算
REM ═══════════════════════════════════════════════════════════════════════════
:kv_est
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║            KV 写入压力估算                                         ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.
echo  免费层 KV 每天只有 1,000 次写 —— 这是最容易撞墙的一项。
echo  下面算一下你的用法能撑住多少流量。
echo.

set "WRITES_PER_REQ="
set /p "WRITES_PER_REQ=每次请求写几次 KV？[默认 1]: "
if not defined WRITES_PER_REQ set "WRITES_PER_REQ=1"

set "DAILY_REQS="
set /p "DAILY_REQS=每天预计多少请求？[默认 1000]: "
if not defined DAILY_REQS set "DAILY_REQS=1000"

echo.
REM 纯计算，不依赖任何外部脚本
set /a NEED=%WRITES_PER_REQ%*%DAILY_REQS%
set /a PCT=%NEED%*100/1000
echo   ── 估算结果 ─────────────────────────────────────────────────────
echo.
echo   每日写入需求      %NEED% 次
echo   免费层额度        1,000 次/天
echo   占用              %PCT%%%
echo.

if %PCT% GTR 100 goto :kv_over
if %PCT% GTR 70 goto :kv_warn
echo   √ 余量充足，KV 合适。
echo.
set /a SAFE=1000*70/100/%WRITES_PER_REQ%
echo   安全线 (70%%)：每天不超过 %SAFE% 次请求
goto :kv_est_end

:kv_over
echo   x 超出额度，KV 不适合这个用量。
echo.
echo   ── 替代方案 ─────────────────────────────────────────────────────
echo.
set /a D1CAP=100000/%WRITES_PER_REQ%
echo     · D1              每日 10 万行写入 → 按你的用法能撑 %D1CAP% 请求/天
echo     · Durable Objects 免费层 10 万请求/天，强一致
echo     · 降低写入频率    改为批量聚合后写（每 N 次请求合并一次）
goto :kv_est_end

:kv_warn
echo   ! 超过 70%%，流量波动就可能撞墙。建议提前规划替代方案。

:kv_est_end
echo.
pause
goto :main_menu


REM ═══════════════════════════════════════════════════════════════════════════
REM  [5] 打开主页
REM ═══════════════════════════════════════════════════════════════════════════
:open_home
start "" "https://github.com/yys9253462-gif/cf-free-max"
goto :main_menu


REM ═══════════════════════════════════════════════════════════════════════════
REM  [6] 启动完整版
REM ═══════════════════════════════════════════════════════════════════════════
:launch_full
REM ─── 启动完整版界面 ───
REM
REM 原来这里是 call 启动.bat（两个文件互相调用）。
REM 现在合成了一个文件，这里内置 Node 检测与下载逻辑。
REM
REM 三种情况：
REM   1. 系统有 Node        → 直接用
REM   2. 有便携版 Node      → 加到 PATH 后用
REM   3. 都没有             → 询问是否下载

if not exist "%SCRIPT_DIR%\bin\cfm.mjs" goto :lf_missing

REM ── 1. 系统 Node ──
where node >nul 2>&1
if %errorlevel%==0 goto :lf_use_system

REM ── 2. 便携版 Node ──
if exist "%NODE_EXE%" (
  set "PATH=%NODE_DIR%;%PATH%"
  goto :lf_use_portable
)

REM ── 3. 都没有 —— 询问下载 ──
goto :lf_need_node


:lf_use_system
for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
echo.
echo  [启动] 使用系统 Node %NODE_VER%
echo.
node "%SCRIPT_DIR%\bin\cfm.mjs" %*
echo.
pause
goto :main_menu


:lf_use_portable
echo.
echo  [启动] 使用便携版 Node
echo         %NODE_DIR%
echo.
"%NODE_EXE%" "%SCRIPT_DIR%\bin\cfm.mjs" %*
echo.
pause
goto :main_menu


:lf_need_node
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║                    需要 Node.js 运行时                             ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.
echo  完整版界面需要 Node.js（一个 JavaScript 运行时）。
echo.
echo  本工具**不会**把它装进系统，而是下载一个便携版解压到：
echo    %NODE_DIR%
echo.
echo  大小约 30 MB。你的系统里的其它程序不受影响。
echo.
echo  ────────────────────────────────────────────────────────────────────
echo.
echo  如果不想下载，也可以：
echo    1. 自己去 https://nodejs.org 装 Node，然后重新运行本文件
echo    2. 就用本界面（额度表、估算、检测都能用，只是不能启动完整版）
echo.
echo  ────────────────────────────────────────────────────────────────────
echo.
set "DLCHOICE="
set /p "DLCHOICE=现在下载便携版 Node？[Y/n] "
if not defined DLCHOICE goto :lf_no_input
if /i "%DLCHOICE%"=="n" goto :lf_declined
if /i "%DLCHOICE%"=="no" goto :lf_declined
goto :lf_download


:lf_no_input
echo.
echo  没有收到输入，已取消。想下载请重新运行并选择 [Y]。
echo.
pause
goto :main_menu


:lf_declined
echo.
echo  好的，已跳过。想用时可以重新运行本文件。
echo.
pause
goto :main_menu


:lf_download
echo.
echo  正在下载（约 30 MB）...
echo.
if not exist "%NODE_DIR%" mkdir "%NODE_DIR%" >nul 2>&1
if not exist "%CFM_HOME%" mkdir "%CFM_HOME%" >nul 2>&1
set "TEMP_ZIP=%CFM_HOME%\node-portable.zip"

REM 先试官方源
where curl >nul 2>&1
if not %errorlevel%==0 goto :lf_dl_ps

echo  [1/3] 从 nodejs.org 下载 ...
curl -L --fail --progress-bar -o "%TEMP_ZIP%" "%NODE_URL%"
if %errorlevel%==0 goto :lf_extract

echo.
echo  官方源失败，切换国内镜像 ...
echo  [1/3] 从 npmmirror 下载 ...
curl -L --fail --progress-bar -o "%TEMP_ZIP%" "%NODE_MIRROR%"
if %errorlevel%==0 goto :lf_extract
goto :lf_dl_failed


:lf_dl_ps
echo  [1/3] 用 PowerShell 下载 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%TEMP_ZIP%' -UseBasicParsing } catch { try { Invoke-WebRequest -Uri '%NODE_MIRROR%' -OutFile '%TEMP_ZIP%' -UseBasicParsing } catch { exit 1 } }"
if not %errorlevel%==0 goto :lf_dl_failed


:lf_extract
echo.
echo  [2/3] 解压 ...
tar -xf "%TEMP_ZIP%" -C "%NODE_DIR%" --strip-components=1 >nul 2>&1
if %errorlevel%==0 goto :lf_verify

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Expand-Archive -Path '%TEMP_ZIP%' -DestinationPath '%NODE_DIR%\_tmp' -Force; $inner = Get-ChildItem '%NODE_DIR%\_tmp' -Directory | Select-Object -First 1; if ($inner) { Get-ChildItem $inner.FullName | Move-Item -Destination '%NODE_DIR%' -Force }; Remove-Item '%NODE_DIR%\_tmp' -Recurse -Force -ErrorAction SilentlyContinue"
if not %errorlevel%==0 goto :lf_extract_failed


:lf_verify
echo  [3/3] 验证 ...
if not exist "%NODE_EXE%" goto :lf_extract_failed
"%NODE_EXE%" --version >nul 2>&1
if not %errorlevel%==0 goto :lf_extract_failed

del "%TEMP_ZIP%" >nul 2>&1
echo.
echo  下载完成。
echo.
set "PATH=%NODE_DIR%;%PATH%"

REM 首次流程里下载的 → 回去继续 setup
if "%CFM_AFTER_DOWNLOAD%"=="setup" (
  set "CFM_AFTER_DOWNLOAD="
  goto :first_setup_run
)
goto :lf_use_portable


:lf_dl_failed
echo.
echo  x 下载失败。
echo.
echo  可能的原因：网络不通，或者被安全软件拦截。
echo  你可以手动下载：https://nodejs.org
echo.
del "%TEMP_ZIP%" >nul 2>&1
pause
goto :main_menu


:lf_extract_failed
echo.
echo  x 解压失败，或者解压出来的文件不完整。
echo.
echo  可以手动下载安装：https://nodejs.org
echo.
echo  解压包位置（如需手动处理）：%TEMP_ZIP%
echo.
pause
goto :main_menu


:lf_missing
echo.
echo  x 找不到 bin\cfm.mjs
echo.
echo  请确认解压完整（bin 文件夹应该和本文件在同一层）。
echo.
pause
goto :main_menu


REM ═══════════════════════════════════════════════════════════════════════════
REM  [7] 配置凭据 —— 向导式
REM ═══════════════════════════════════════════════════════════════════════════
:setup_creds
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║                    配置 Cloudflare 凭据                            ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.
echo  这里需要的是一个「API Token」，不是账号密码。
echo  它只是一个字符串，粘贴进来就行。
echo.
echo  ── 怎么拿到它（大约 2 分钟）──────────────────────────────────────
echo.
echo   1. 浏览器打开：
echo        https://dash.cloudflare.com/profile/api-tokens
echo.
echo   2. 点右上角「Create Token」
echo.
echo   3. 找到「Create Custom Token」，点「Get started」
echo.
echo   4. Token name 随便填，比如 cf-free-max
echo.
echo   5. Permissions 加这两条（点 + 号，第一个下拉选 Account）：
echo        Account  ^|  Account Analytics  ^|  Read
echo        Zone     ^|  Zone               ^|  Read
echo.
echo      只想看用量的话，上面两条就够了。
echo      以后要改 DNS 再加：Zone ^| DNS ^| Edit
echo.
echo   6. 点「Continue to summary」→「Create Token」
echo.
echo   7. 页面会显示一串 Token，只显示这一次 ——
echo      复制它（点右边的复制按钮最稳）。
echo.
echo  ────────────────────────────────────────────────────────────────
echo.
echo  提示：如果这个窗口挡住了浏览器，可以先按 Ctrl+C 退出，
echo        拿到 Token 后再回来运行本文件。
echo.
echo  ────────────────────────────────────────────────────────────────
echo.

set "TOK="
set /p "TOK=粘贴 Token（右键粘贴，然后回车；留空取消）: "
if not defined TOK goto :setup_cancel

if not exist "%PS1_DIR%\save-env.ps1" goto :missing_scripts

echo.
echo  请稍候 ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\save-env.ps1" -Token "%TOK%" -OutputFile "%ENV_FILE%"

if %errorlevel%==0 goto :setup_ask_account
if %errorlevel%==3 goto :setup_verify_failed
goto :setup_saved_but_warn

:setup_ask_account
echo.
echo  ────────────────────────────────────────────────────────────────
echo.
echo  还需要 Account ID 吗？
echo.
echo  如果要用的功能包括 R2 / KV / D1 / Pages / Tunnel，就需要。
echo  只查用量和列域名的话，不需要。
echo.
set "ACC="
set /p "ACC=粘贴 Account ID（可留空跳过）: "

if not defined ACC goto :setup_done
if "%ACC%"=="" goto :setup_done

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\save-env.ps1" -Token "%TOK%" -AccountId "%ACC%" -OutputFile "%ENV_FILE%" >nul 2>&1
set "CF_ACCOUNT_ID=%ACC%"

:setup_done
set "CF_API_TOKEN=%TOK%"
echo.
echo  配置完成。回到菜单就能查用量了。
echo.
pause
goto :main_menu

:setup_saved_but_warn
echo.
echo  凭据已保存，但校验没通过 —— 回到菜单选 [3] 可以重试诊断。
echo.
pause
goto :main_menu

:setup_verify_failed
echo.
echo  凭据已保存到 .env，但校验失败。
echo.
echo  常见原因：
echo    · Token 复制不完整（Cloudflare 的 Token 约 40 位）
echo    · Token 创建后没点最后的「Create Token」
echo    · 权限没勾够
echo.
echo  可以回到菜单选 [3] 重新检查，或选 [7] 重新配置。
echo.
pause
goto :main_menu

:setup_cancel
echo.
echo  已取消。
ping -n 2 127.0.0.1 >nul 2>&1
goto :main_menu


REM ═══════════════════════════════════════════════════════════════════════════
REM  辅助
REM ═══════════════════════════════════════════════════════════════════════════

:load_env
if not exist "%ENV_FILE%" goto :eof
for /f "usebackq tokens=1,* delims==" %%a in ("%ENV_FILE%") do (
  set "KEY=%%a"
  set "VAL=%%b"
  if not "!KEY!"=="" (
    if not "!KEY:~0,1!"=="#" (
      set "VAL=!VAL:"=!"
      if /i "!KEY!"=="CF_API_TOKEN" set "CF_API_TOKEN=!VAL!"
      if /i "!KEY!"=="CF_ACCOUNT_ID" set "CF_ACCOUNT_ID=!VAL!"
      if /i "!KEY!"=="CF_API_EMAIL" set "CF_API_EMAIL=!VAL!"
      if /i "!KEY!"=="CF_API_KEY" set "CF_API_KEY=!VAL!"
    )
  )
)
goto :eof

:missing_scripts
echo.
echo  x 找不到辅助脚本目录：
echo    %PS1_DIR%
echo.
echo  请下载完整压缩包，不要只复制单个 .bat 文件。
echo    https://github.com/yys9253462-gif/cf-free-max/releases
echo.
pause
exit /b 1

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
if not exist "%SCRIPT_DIR%\bin\cfm.mjs" goto :deploy_need_full
call "%SCRIPT_DIR%\启动.bat" deploy --list
echo.
pause
goto :deploy_menu

:deploy_online
if not exist "%SCRIPT_DIR%\bin\cfm.mjs" goto :deploy_need_full
call "%SCRIPT_DIR%\启动.bat" deploy --check-online
echo.
pause
goto :deploy_menu

:deploy_check
if not exist "%SCRIPT_DIR%\bin\cfm.mjs" goto :deploy_need_full
call "%SCRIPT_DIR%\启动.bat" deploy --check
echo.
pause
goto :deploy_menu

:deploy_blog
if not exist "%SCRIPT_DIR%\bin\cfm.mjs" goto :deploy_need_full
call "%SCRIPT_DIR%\启动.bat" deploy --only blog
echo.
pause
goto :deploy_menu

:deploy_nav
if not exist "%SCRIPT_DIR%\bin\cfm.mjs" goto :deploy_need_full
call "%SCRIPT_DIR%\启动.bat" deploy --only nav
echo.
pause
goto :deploy_menu

:deploy_all
if not exist "%SCRIPT_DIR%\bin\cfm.mjs" goto :deploy_need_full
echo.
echo  受保护的站点（如正在服务的网盘）会自动跳过。
echo.
call "%SCRIPT_DIR%\启动.bat" deploy
echo.
pause
goto :deploy_menu

:deploy_dry
if not exist "%SCRIPT_DIR%\bin\cfm.mjs" goto :deploy_need_full
call "%SCRIPT_DIR%\启动.bat" deploy --dry-run
echo.
pause
goto :deploy_menu

:deploy_need_full
echo.
echo  部署功能需要完整版（Node）。
echo.
echo  请确保压缩包解压完整，包含 bin\ 和 src\ 目录。
echo.
pause
goto :deploy_menu

REM ─── 字体警告（纯英文，因为中文此刻显示不出来）───
:warn_font
echo.
echo  ============================================================
echo   WARNING: Console font cannot display Chinese
echo  ============================================================
echo.
echo   Every Chinese character will show as a box.
echo   The tool works fine; this is only a font issue.
echo.
echo   FIX (10 seconds):
echo     1. Right-click the TITLE BAR of this window
echo     2. Choose "Properties"
echo     3. Go to the "Font" tab
echo     4. Change font to:  NSimSun  or  Consolas
echo     5. Click OK
echo.
echo   ============================================================
echo.
ping -n 4 127.0.0.1 >nul 2>&1
goto :eof


REM ═══════════════════════════════════════════════════════════════════════════
REM  [3] 环境检测与授权
REM
REM  并入原「检测授权.bat」的四项能力：
REM    · 完整环境检测（工具链 / 网络 / 授权 / 配置）
REM    · 快速检测
REM    · 授权向导（GitHub + Cloudflare）
REM    · 查看授权状态
REM
REM  为什么并到这里：
REM    原来单独一个 .bat 文件，用户看到三个图标不知道该点哪个。
REM    这些能力本来就属于「配置环境」，放主菜单里更合理。
REM ═══════════════════════════════════════════════════════════════════════════
:env_menu
cls
echo.
echo  ┌─ 环境检测与授权 ───────────────────────────────────────────────┐
echo  │                                                                │
echo  │   [1]  完整环境检测                                            │
echo  │        工具链 / 网络 / 授权 / 配置，逐项检查                   │
echo  │                                                                │
echo  │   [2]  快速检测                                                │
echo  │        只查最关键的几项，秒出结果                              │
echo  │                                                                │
echo  │   [3]  授权向导                                                │
echo  │        GitHub + Cloudflare，一步步引导                         │
echo  │                                                                │
echo  │   [4]  查看授权状态                                            │
echo  │                                                                │
echo  │   [0]  返回主菜单                                              │
echo  │                                                                │
echo  └────────────────────────────────────────────────────────────────┘
echo.

set "ENVCHOICE="
set /p "ENVCHOICE=请选择 [0-4]: "
if not defined ENVCHOICE goto :main_menu

if "%ENVCHOICE%"=="1" goto :env_full
if "%ENVCHOICE%"=="2" goto :env_quick
if "%ENVCHOICE%"=="3" goto :env_auth
if "%ENVCHOICE%"=="4" goto :env_status
if "%ENVCHOICE%"=="0" goto :main_menu

echo.
echo  无效选择。
ping -n 2 127.0.0.1 >nul 2>&1
goto :env_menu


:env_full
if not exist "%PS1_DIR%\check-env.ps1" goto :env_missing
echo.
echo  正在检查（约 10-30 秒）...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\check-env.ps1"
echo.
pause
goto :env_menu


:env_quick
if not exist "%PS1_DIR%\check-env.ps1" goto :env_missing
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\check-env.ps1" -Quick
echo.
pause
goto :env_menu


:env_auth
if not exist "%PS1_DIR%\auth-setup.ps1" goto :env_missing
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\auth-setup.ps1"
goto :env_menu


:env_status
if not exist "%PS1_DIR%\auth-setup.ps1" goto :env_missing
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DIR%\auth-setup.ps1" -Action status
echo.
pause
goto :env_menu


:env_missing
echo.
echo  找不到 scripts 目录下的检测脚本。
echo  请确认解压完整（scripts 文件夹应该和本文件在同一层）。
echo.
pause
goto :env_menu


REM ═══════════════════════════════════════════════════════════════════════════
REM  文件不完整
REM
REM  这是最容易让新手困惑的场景：他以为解压好了，双击却什么都不工作。
REM  所以要说清楚「缺什么」和「怎么办」，不要只说「出错了」。
REM ═══════════════════════════════════════════════════════════════════════════
:incomplete
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║                    文件不完整                                      ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.
echo  本工具不是单个文件，需要同目录下的这些内容一起才能用：
echo.
if not exist "%SCRIPT_DIR%\bin\cfm.mjs" echo    x  bin\cfm.mjs            （主程序）
if not exist "%SCRIPT_DIR%\scripts\check-env.ps1" echo    x  scripts\check-env.ps1  （环境检测）
if not exist "%SCRIPT_DIR%\config\sites.json" echo    x  config\sites.json      （站点配置）
echo.
echo  你可能遇到的情况：
echo.
echo    1. 直接从压缩包里双击了这个文件
echo       -^> 压缩包里的文件是分开的，必须先「全部解压」
echo.
echo    2. 解压时只拖出来了这一个文件
echo       -^> 请把整个文件夹一起解压出来
echo.
echo    3. 杀毒软件删掉了部分文件
echo       -^> 检查一下有没有被隔离的文件
echo.
echo  ────────────────────────────────────────────────────────────────
echo.
echo  正确的做法：
echo.
echo    1. 右键压缩包 -^> 「全部解压」
echo    2. 进到解压出来的文件夹
echo    3. 双击里面的 启动.bat
echo.
echo  当前目录：%SCRIPT_DIR%
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


