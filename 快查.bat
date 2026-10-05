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
set "ENV_FILE=%SCRIPT_DIR%\.env"
title Cloudflare 免费额度工具箱
color 0B

REM ─── 读取 .env 凭据 ───
call :load_env

REM ─── 启动后先给点有用的东西，而不是空菜单 ───
goto :welcome


REM ═══════════════════════════════════════════════════════════════════════════
REM  首次进入：显示概览而不是只给菜单
REM ═══════════════════════════════════════════════════════════════════════════
:welcome
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║           Cloudflare 免费额度工具箱  ·  快速版                     ║
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
echo  ║           Cloudflare 免费额度工具箱  ·  快速版                     ║
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
echo    [3]  检查凭据配置
echo    [4]  KV 写入压力估算           离线可用
echo    [5]  打开项目主页 / 文档
echo    [6]  启动完整版（需要 Node，功能更全）
echo    [7]  配置凭据
echo.
echo    [0]  退出
echo.
echo  ────────────────────────────────────────────────────────────────────

:menu_prompt
set "CHOICE="
set /p "CHOICE=请选择 [0-7]: "

REM 输入耗尽（管道/被脚本调用）—— 直接退出，避免死循环刷屏
if not defined CHOICE goto :quit

if "%CHOICE%"=="1" goto :quota_table
if "%CHOICE%"=="2" goto :live_usage
if "%CHOICE%"=="3" goto :check_creds
if "%CHOICE%"=="4" goto :kv_est
if "%CHOICE%"=="5" goto :open_home
if "%CHOICE%"=="6" goto :launch_full
if "%CHOICE%"=="7" goto :setup_creds
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
if exist "%SCRIPT_DIR%\启动.bat" (
  call "%SCRIPT_DIR%\启动.bat"
  goto :main_menu
)
echo.
echo  x 找不到 启动.bat
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

:quit
cls
echo.
echo  再见。
echo.
endlocal
exit /b 0
