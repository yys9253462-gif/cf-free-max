@echo off
REM ═══════════════════════════════════════════════════════════════════════════
REM  cf-free-max 纯批处理版（不需要 Node）
REM
REM  为什么有这个：
REM    Node 版功能完整，但要下载 30MB 运行时。有些人只是想快速看一眼
REM    额度，或者网络环境不方便下载 —— 给他们一个开箱即用的版本。
REM
REM    这里只用 Windows 自带的 curl + PowerShell，零依赖。
REM
REM  功能范围：
REM    ? 额度速查（离线，纯本地数据）
REM    ? 实时用量查询（curl 调 Cloudflare API）
REM    ? 凭据检查
REM    ? 场景估算（KV 写入压力计算）
REM    ? 体检 / 审计 / 批量操作 —— 这些需要 Node 版
REM
REM  编码：ANSI/GBK(CP936)，**不要 chcp 65001**
REM ═══════════════════════════════════════════════════════════════════════════

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
title Cloudflare 免费额度快查
color 0B

REM ─── 凭据：优先 .env，其次环境变量 ───
set "ENV_FILE=%SCRIPT_DIR%\.env"
if exist "%ENV_FILE%" (
  for /f "usebackq tokens=1,* delims==" %%a in ("%ENV_FILE%") do (
    set "KEY=%%a"
    set "VAL=%%b"
    REM 跳过注释与空行
    if not "!KEY!"=="" (
      if not "!KEY:~0,1!"=="#" (
        REM 去掉可能存在的引号
        set "VAL=!VAL:"=!"
        if /i "!KEY!"=="CF_API_TOKEN" set "CF_API_TOKEN=!VAL!"
        if /i "!KEY!"=="CF_ACCOUNT_ID" set "CF_ACCOUNT_ID=!VAL!"
        if /i "!KEY!"=="CF_API_EMAIL" set "CF_API_EMAIL=!VAL!"
        if /i "!KEY!"=="CF_API_KEY" set "CF_API_KEY=!VAL!"
      )
    )
  )
)

:main_menu
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║         Cloudflare 免费额度工具箱  ·  快速版（无需 Node）           ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.

REM ─── 凭据状态 ───
if defined CF_API_TOKEN (
  echo   ● 凭据：已配置 Token
) else (
  if defined CF_API_KEY (
    echo   ● 凭据：已配置 Global API Key
  ) else (
    echo   ● 凭据：未配置 ^(只能看额度表，不能查实时用量^)
  )
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
set "CHOICE="
set /p "CHOICE=请选择 [0-7]: "

REM 输入耗尽（管道/重定向场景）—— 直接退出，避免死循环刷屏
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
echo     脚本大小          3 MiB ^(压缩后^)
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
echo     Class A ^(写/列表^) 1,000,000 / 月
echo     Class B ^(读^)      10,000,000 / 月
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
echo      之后所有写返回 429。改用 D1 ^(10 万行/天^) 或 Durable Objects。
echo.
echo   2. D1 按「扫描行数」计费，不是返回行数
echo      缺索引的查询会全表扫描。表 10 万行时每次扣 10 万行，
echo      50 次查询就打满当天额度。务必建索引。
echo.
echo   3. Workers 单次调用最多 50 个子请求
echo      循环里批量调第三方 API 会直接抛异常，需要分批 + 限流。
echo.
echo   4. R2 的 Class A 只有 100 万次/月
echo      频繁 list 判断对象是否存在会快速消耗。改用 head ^(算 Class B^)。
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
echo.
echo  正在查询用量 ...
echo.
call :do_usage
echo.
pause
goto :main_menu

:usage_no_token
echo.
echo  ? 未配置凭据，无法查询实时用量。
echo.
echo  请先选 [7] 配置凭据，或用 [1] 查看额度对照表。
echo.
pause
goto :main_menu


:do_usage
REM 计算时间范围（过去 24 小时，UTC）
for /f "usebackq tokens=*" %%t in (`powershell -NoProfile -Command "(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')"`) do set "NOW=%%t"
for /f "usebackq tokens=*" %%t in (`powershell -NoProfile -Command "(Get-Date).ToUniversalTime().AddHours(-24).ToString('yyyy-MM-ddTHH:mm:ssZ')"`) do set "SINCE=%%t"

echo   时间范围：%SINCE%  至  %NOW%
echo.

REM ─── 取账号 ID（未显式指定时）───
if defined CF_ACCOUNT_ID goto :usage_query

echo   未指定 CF_ACCOUNT_ID，尝试自动获取 ...
for /f "usebackq tokens=*" %%a in (`powershell -NoProfile -Command ^
  "try { $h=@{Authorization='Bearer %CF_API_TOKEN%'}; $r=Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/accounts' -Headers $h -TimeoutSec 20; if ($r.result.Count -eq 1) { $r.result[0].id } elseif ($r.result.Count -gt 1) { Write-Host ('多个账号：' + ($r.result | ForEach-Object { $_.name + '=' + $_.id }) -join ', ') -ForegroundColor Yellow; $r.result[0].id } else { '' } } catch { '' }"`) do set "CF_ACCOUNT_ID=%%a"

if not defined CF_ACCOUNT_ID goto :usage_no_account

:usage_query
echo   账号：%CF_ACCOUNT_ID%
echo.

REM ─── Workers 请求数 ───
echo   ── Workers 请求 ^(24h^) ──
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$h=@{Authorization='Bearer %CF_API_TOKEN%';'Content-Type'='application/json'};" ^
  "$q=@{query='query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$s,datetime_leq:$u}){sum{requests}}}}}';" ^
  "variables=@{a='%CF_ACCOUNT_ID%';s='%SINCE%';u='%NOW%'}} | ConvertTo-Json -Depth 5;" ^
  "try { $r=Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/graphql' -Headers $h -Method Post -Body $q -TimeoutSec 30;" ^
  "$n=($r.data.viewer.accounts[0].workersInvocationsAdaptive | Measure-Object -Property @{Expression={$_.sum.requests}} -Sum).Sum;" ^
  "if (-not $n) { $n = 0 };" ^
  "$pct=[math]::Round($n/100000*100,1);" ^
  "$bar='#' * [math]::Min(20,[math]::Round($pct/5)) + '.' * (20-[math]::Min(20,[math]::Round($pct/5)));" ^
  "Write-Host ('    已用 ' + $n.ToString('N0') + ' / 100,000    ' + $bar + ' ' + $pct + '%');" ^
  "if ($pct -ge 80) { Write-Host '    ^! 接近上限' -ForegroundColor Red } }" ^
  "catch { Write-Host '    查询失败：' $_.Exception.Message -ForegroundColor Red }"

echo.
echo   ── D1 扫描行 ^(24h^) ──
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$h=@{Authorization='Bearer %CF_API_TOKEN%';'Content-Type'='application/json'};" ^
  "$q=@{query='query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:100,filter:{datetime_geq:$s,datetime_leq:$u}){sum{rowsRead rowsWritten}}}}}';" ^
  "variables=@{a='%CF_ACCOUNT_ID%';s='%SINCE%';u='%NOW%'}} | ConvertTo-Json -Depth 5;" ^
  "try { $r=Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/graphql' -Headers $h -Method Post -Body $q -TimeoutSec 30;" ^
  "$rows=$r.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups;" ^
  "$read=($rows | Measure-Object -Property @{Expression={$_.sum.rowsRead}} -Sum).Sum; if (-not $read) { $read=0 };" ^
  "$pct=[math]::Round($read/5000000*100,2);" ^
  "$bar='#' * [math]::Min(20,[math]::Round($pct/5)) + '.' * (20-[math]::Min(20,[math]::Round($pct/5)));" ^
  "Write-Host ('    扫描 ' + $read.ToString('N0') + ' / 5,000,000 行    ' + $bar + ' ' + $pct + '%');" ^
  "if ($pct -ge 80) { Write-Host '    ^! 接近上限' -ForegroundColor Red } }" ^
  "catch { Write-Host '    查询失败：' $_.Exception.Message -ForegroundColor Red }"

echo.
echo   ── KV 操作 ^(24h^) ──
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$h=@{Authorization='Bearer %CF_API_TOKEN%';'Content-Type'='application/json'};" ^
  "$q=@{query='query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){kvOperationsAdaptiveGroups(limit:100,filter:{datetime_geq:$s,datetime_leq:$u}){sum{requests} dimensions{actionType}}}}}';" ^
  "variables=@{a='%CF_ACCOUNT_ID%';s='%SINCE%';u='%NOW%'}} | ConvertTo-Json -Depth 5;" ^
  "try { $r=Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/graphql' -Headers $h -Method Post -Body $q -TimeoutSec 30;" ^
  "$g=$r.data.viewer.accounts[0].kvOperationsAdaptiveGroups;" ^
  "$rd=($g | Where-Object { $_.dimensions.actionType -match 'read' } | Measure-Object -Property @{Expression={$_.sum.requests}} -Sum).Sum; if (-not $rd) { $rd=0 };" ^
  "$wr=($g | Where-Object { $_.dimensions.actionType -match 'write' } | Measure-Object -Property @{Expression={$_.sum.requests}} -Sum).Sum; if (-not $wr) { $wr=0 };" ^
  "$pr=[math]::Round($rd/100000*100,1); $pw=[math]::Round($wr/1000*100,1);" ^
  "Write-Host ('    读 ' + $rd.ToString('N0') + ' / 100,000    ' + $pr + '%');" ^
  "Write-Host ('    写 ' + $wr.ToString('N0') + ' / 1,000      ' + $pw + '%') -ForegroundColor $(if ($pw -ge 80) {'Red'} elseif ($pw -ge 50) {'Yellow'} else {'Gray'});" ^
  "if ($pw -ge 80) { Write-Host '    ^! KV 写入接近上限，考虑改用 D1' -ForegroundColor Red } }" ^
  "catch { Write-Host '    查询失败：' $_.Exception.Message -ForegroundColor Red }"

echo.
echo   ── R2 桶 ──
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$h=@{Authorization='Bearer %CF_API_TOKEN%'};" ^
  "try { $r=Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/accounts/%CF_ACCOUNT_ID%/r2/buckets' -Headers $h -TimeoutSec 20;" ^
  "if ($r.result.Count -eq 0) { Write-Host '    还没有 R2 桶' } else { Write-Host ('    共 ' + $r.result.Count + ' 个桶：' + (($r.result | ForEach-Object { $_.name }) -join ', ')) } }" ^
  "catch { Write-Host '    查询失败（可能需要 R2 权限）' -ForegroundColor DarkGray }"

echo.
echo   提示：GraphQL Analytics 有 1~5 分钟延迟。
exit /b 0


:usage_no_account
echo.
echo  ? 无法确定账号 ID。
echo.
echo  请选 [7] 手动配置 CF_ACCOUNT_ID。
echo.
exit /b 1


REM ═══════════════════════════════════════════════════════════════════════════
REM  [3] 检查凭据
REM ═══════════════════════════════════════════════════════════════════════════
:check_creds
cls
echo.
if not defined CF_API_TOKEN goto :creds_no_token

echo   正在校验 Token ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$h=@{Authorization='Bearer %CF_API_TOKEN%';'Content-Type'='application/json'};" ^
  "try {" ^
  "  $v=Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' -Headers $h -TimeoutSec 20;" ^
  "  Write-Host ('  ? Token 有效（状态：' + $v.result.status + '）') -ForegroundColor Green;" ^
  "} catch {" ^
  "  Write-Host '  ? Token 校验失败' -ForegroundColor Red;" ^
  "  Write-Host ('    ' + $_.Exception.Message);" ^
  "  exit 1" ^
  "}" ^
  "if ($v.result.status -ne 'active') { Write-Host '  ^! Token 状态不是 active，可能已过期或被撤销' -ForegroundColor Yellow }"
if not %errorlevel%==0 goto :creds_end

echo.
echo   ── 账号 ──
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$h=@{Authorization='Bearer %CF_API_TOKEN%';'Content-Type'='application/json'};" ^
  "try { $r=Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/accounts' -Headers $h -TimeoutSec 20;" ^
  "if ($r.result.Count -eq 0) { Write-Host '    看不到任何账号（可能是 zone-scoped Token）' }" ^
  "else { $r.result | ForEach-Object { Write-Host ('    ' + $_.name + '  [' + $_.id + ']') } } }" ^
  "catch { Write-Host '    查询失败' -ForegroundColor Red }"

echo.
echo   ── 域名 ──
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$h=@{Authorization='Bearer %CF_API_TOKEN%';'Content-Type'='application/json'};" ^
  "try { $r=Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/zones?per_page=50' -Headers $h -TimeoutSec 20;" ^
  "if ($r.result.Count -eq 0) { Write-Host '    没有可见的域名' }" ^
  "else { $r.result | ForEach-Object { Write-Host ('    ' + $_.name + '  [' + $_.plan.name + ']') };" ^
  "  Write-Host ''; Write-Host ('    共 ' + $r.result_info.total_count + ' 个') } }" ^
  "catch { Write-Host '    查询失败（可能需要 Zone:Read 权限）' -ForegroundColor Red }"

goto :creds_end

:creds_no_token
echo   ? 未配置 CF_API_TOKEN。
echo.
echo   用 [7] 配置，或手动创建 .env 文件：
echo     CF_API_TOKEN=你的令牌
echo     CF_ACCOUNT_ID=你的账号ID

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
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w=%WRITES_PER_REQ%; $r=%DAILY_REQS%; $limit=1000;" ^
  "if ($w -le 0) { $w=1 };" ^
  "$need=$w*$r; $pct=[math]::Round($need/$limit*100,1);" ^
  "Write-Host '  ── 估算结果 ─────────────────────────────────────────────';" ^
  "Write-Host ('  每日写入需求      ' + $need.ToString('N0') + ' 次');" ^
  "Write-Host ('  免费层额度        ' + $limit.ToString('N0') + ' 次/天');" ^
  "Write-Host ('  占用              ' + $pct + '%');" ^
  "Write-Host '';" ^
  "if ($pct -gt 100) {" ^
  "  Write-Host '  ? 超出额度，KV 不适合这个用量。' -ForegroundColor Red;" ^
  "  Write-Host '';" ^
  "  $d1cap=[math]::Floor(100000/$w);" ^
  "  Write-Host '  ── 替代方案 ─────────────────────────────────────────────';" ^
  "  Write-Host ('  · D1              每日 10 万行写入 → 按你的用法能撑 ' + $d1cap.ToString('N0') + ' 请求/天');" ^
  "  Write-Host '  · Durable Objects 免费层 10 万请求/天，强一致';" ^
  "  Write-Host '  · 降低写入频率    改为批量聚合后写（每 N 次请求合并一次）';" ^
  "} elseif ($pct -gt 70) {" ^
  "  Write-Host '  ^! 超过 70%%，流量波动就可能撞墙。建议提前规划替代方案。' -ForegroundColor Yellow;" ^
  "} else {" ^
  "  Write-Host '  ? 余量充足，KV 合适。' -ForegroundColor Green;" ^
  "}" ^
  "Write-Host '';" ^
  "$safe=[math]::Floor($limit*0.7/$w);" ^
  "Write-Host ('  安全线（70%%）：每天不超过 ' + $safe.ToString('N0') + ' 次请求') -ForegroundColor DarkGray"

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
echo  ? 找不到 启动.bat
echo.
pause
goto :main_menu


REM ═══════════════════════════════════════════════════════════════════════════
REM  [7] 配置凭据
REM ═══════════════════════════════════════════════════════════════════════════
:setup_creds
cls
echo.
echo  ╔════════════════════════════════════════════════════════════════════╗
echo  ║            配置 Cloudflare 凭据                                    ║
echo  ╚════════════════════════════════════════════════════════════════════╝
echo.
echo  方式一：API Token（推荐，权限可控）
echo    获取：https://dash.cloudflare.com/profile/api-tokens
echo    需要权限：Account Analytics:Read、Zone:Read
echo.
echo  方式二：Global API Key（权限过大，仅兼容用）
echo.
echo  ────────────────────────────────────────────────────────────────────
echo.
echo  凭据将保存到：%ENV_FILE%
echo  ^(该文件不会被分享出去，除非你自己复制它^)
echo.

set "TOK="
set /p "TOK=粘贴 API Token（留空取消）: "
if not defined TOK goto :setup_cancel

set "ACC="
set /p "ACC=粘贴 Account ID（可留空）: "

REM ─── 写入 .env（UTF-8 无 BOM，LF 行尾）───
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$lines = @('# Cloudflare 凭据 —— 不要分享这个文件', 'CF_API_TOKEN=%TOK%');" ^
  "if ('%ACC%' -ne '') { $lines += 'CF_ACCOUNT_ID=%ACC%' };" ^
  "$text = ($lines -join \"`n\") + \"`n\";" ^
  "[System.IO.File]::WriteAllText('%ENV_FILE%', $text, (New-Object System.Text.UTF8Encoding $false));" ^
  "Write-Host '  ? 已保存到 .env' -ForegroundColor Green"

REM ─── 立即生效（当前会话）───
set "CF_API_TOKEN=%TOK%"
set "CF_ACCOUNT_ID=%ACC%"

echo.
echo  正在验证凭据 ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$h=@{Authorization='Bearer %TOK%';'Content-Type'='application/json'};" ^
  "try {" ^
  "  $v=Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' -Headers $h -TimeoutSec 20;" ^
  "  Write-Host ('  ? 凭据有效（' + $v.result.status + '）') -ForegroundColor Green" ^
  "} catch {" ^
  "  Write-Host '  ? 凭据无效，请检查是否复制完整' -ForegroundColor Red" ^
  "}"

echo.
pause
goto :main_menu

:setup_cancel
echo.
echo  已取消。
ping -n 2 127.0.0.1 >nul 2>&1
goto :main_menu


:quit
cls
echo.
echo  再见。
echo.
endlocal
exit /b 0
