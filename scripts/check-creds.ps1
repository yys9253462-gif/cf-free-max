# ═══════════════════════════════════════════════════════════════════════════
#  check-creds.ps1 — 检查凭据配置并提供诊断
# ═══════════════════════════════════════════════════════════════════════════

param(
    [Parameter(Mandatory = $true)]
    [string]$Token,

    [string]$EnvFile = ''
)

# ─── 输出编码适配 ───
#
# ⚠️ 必须显式设置，否则 PowerShell 5.1 默认按 UTF-8 输出，
#    而本脚本是被 GBK 编码的 .bat 调用的 ——
#    UTF-8 字节进 GBK 控制台 ⇒ 满屏「锟斤拷」。
#
#    实测（2026-10-06）：不设这行时，check-env.ps1 的输出里
#    ╔ 是 E2 95 94（UTF-8 三字节），而 .bat 期望 A9 B0（GBK 双字节）。
#
#    不能用 chcp 65001 反着来 —— .bat 自身是 GBK，控制台切 UTF-8
#    会让批处理里的中文乱码。必须让 PowerShell 迁就控制台。
[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936)
$OutputEncoding = [System.Text.Encoding]::GetEncoding(936)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$headers = @{
    'Authorization' = "Bearer $Token"
    'Content-Type'  = 'application/json'
}

# ─── Token 本身的信息 ───
Write-Host ''
Write-Host '  ── Token 校验 ────────────────────────────────────────────────' -ForegroundColor Cyan

# 显示 Token 的形态（不泄漏内容）
$len = $Token.Length
$prefix = if ($len -gt 8) { $Token.Substring(0, 4) + '...' + $Token.Substring($len - 4) } else { '(太短)' }
Write-Host ("    长度   " + $len + " 字符") -ForegroundColor DarkGray
Write-Host ("    形态   " + $prefix) -ForegroundColor DarkGray

if ($len -lt 30) {
    Write-Host ''
    Write-Host '    ! Token 偏短。Cloudflare 的 API Token 通常约 40 个字符，' -ForegroundColor Yellow
    Write-Host '      可能是复制时漏了内容。' -ForegroundColor Yellow
}

try {
    $v = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' `
        -Headers $headers -TimeoutSec 25 -ErrorAction Stop

    $status = $v.result.status
    if ($status -eq 'active') {
        Write-Host ("    状态   " + $status) -ForegroundColor Green
    }
    else {
        Write-Host ("    状态   " + $status + "（不是 active）") -ForegroundColor Yellow
    }

    if ($v.result.expires_on) {
        Write-Host ("    过期   " + $v.result.expires_on) -ForegroundColor DarkGray
    }
    else {
        Write-Host '    过期   永不过期' -ForegroundColor DarkGray
    }
}
catch {
    Write-Host ''
    Write-Host '    x 校验失败' -ForegroundColor Red
    Write-Host ''
    $msg = $_.Exception.Message

    if ($msg -match '401|403|10000|6103') {
        Write-Host '    Token 无效。常见原因：' -ForegroundColor Yellow
        Write-Host '      · 复制不完整' -ForegroundColor DarkGray
        Write-Host '      · 创建后没点最后的「Create Token」按钮' -ForegroundColor DarkGray
        Write-Host '      · Token 已被删除' -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '    解决：重新选 [7] 配置一个。' -ForegroundColor DarkGray
    }
    elseif ($msg -match 'Unable to connect|timed out|timeout|远程名称|resolution') {
        Write-Host '    连不上 api.cloudflare.com' -ForegroundColor Yellow
        Write-Host '      · 检查网络' -ForegroundColor DarkGray
        Write-Host '      · 用了代理的话，设置 HTTPS_PROXY 环境变量' -ForegroundColor DarkGray
        Write-Host '        set HTTPS_PROXY=http://127.0.0.1:端口' -ForegroundColor DarkGray
    }
    else {
        Write-Host ("    " + $msg) -ForegroundColor DarkGray
    }

    Write-Host ''
    if ($EnvFile -and (Test-Path $EnvFile)) {
        Write-Host ("    凭据文件：" + $EnvFile) -ForegroundColor DarkGray
    }
    exit 1
}

# ─── 账号 ───
Write-Host ''
Write-Host '  ── 可见账号 ──────────────────────────────────────────────────' -ForegroundColor Cyan

try {
    $accts = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/accounts' `
        -Headers $headers -TimeoutSec 25 -ErrorAction Stop

    if ($accts.result.Count -eq 0) {
        Write-Host '    看不到账号' -ForegroundColor DarkGray
        Write-Host '    （zone-scoped Token 是正常的，但用量统计需要账号级权限）' -ForegroundColor DarkGray
    }
    else {
        foreach ($a in $accts.result) {
            Write-Host ("    · " + $a.name) -ForegroundColor White
            Write-Host ("      " + $a.id) -ForegroundColor DarkGray
        }
        if ($accts.result.Count -gt 1) {
            Write-Host ''
            Write-Host '    ! 有多个账号，需在 .env 里指定 CF_ACCOUNT_ID' -ForegroundColor Yellow
        }
    }
}
catch {
    Write-Host '    查询失败（缺 Account:Read 权限？）' -ForegroundColor DarkGray
}

# ─── 域名 ───
Write-Host ''
Write-Host '  ── 可见域名 ──────────────────────────────────────────────────' -ForegroundColor Cyan

try {
    $zones = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/zones?per_page=50' `
        -Headers $headers -TimeoutSec 25 -ErrorAction Stop

    if ($zones.result.Count -eq 0) {
        Write-Host '    没有可见的域名' -ForegroundColor DarkGray
        Write-Host '    （缺 Zone:Read 权限，或账号下确实没域名）' -ForegroundColor DarkGray
    }
    else {
        foreach ($z in $zones.result) {
            $plan = if ($z.plan.name) { $z.plan.name } else { '?' }
            $statusColor = if ($z.status -eq 'active') { 'White' } else { 'Yellow' }
            Write-Host ("    · " + $z.name.PadRight(28) + " [" + $plan + "] " + $z.status) -ForegroundColor $statusColor
        }
        Write-Host ''
        Write-Host ("    共 " + $zones.result_info.total_count + " 个") -ForegroundColor DarkGray

        $paid = @($zones.result | Where-Object { $_.plan.name -and $_.plan.name.ToLower() -ne 'free' })
        if ($paid.Count -gt 0) {
            Write-Host ''
            Write-Host ("    ! 其中 " + $paid.Count + " 个不是免费套餐 —— 如果你以为在用免费层，去控制台确认一下账单") -ForegroundColor Yellow
        }
    }
}
catch {
    Write-Host '    查询失败（缺 Zone:Read 权限？）' -ForegroundColor DarkGray
}

# ─── 权限小结 ───
Write-Host ''
Write-Host '  ── 小结 ──────────────────────────────────────────────────────' -ForegroundColor Cyan
Write-Host ''
Write-Host '    本工具的功能与所需权限：' -ForegroundColor DarkGray
Write-Host '      查看用量     Account Analytics:Read' -ForegroundColor DarkGray
Write-Host '      列出域名     Zone:Read' -ForegroundColor DarkGray
Write-Host '      改 DNS       Zone:DNS:Edit' -ForegroundColor DarkGray
Write-Host '      清缓存       Zone:Cache Purge:Purge' -ForegroundColor DarkGray
Write-Host '      R2 操作      Account:Workers R2 Storage:Edit' -ForegroundColor DarkGray
Write-Host ''
Write-Host '    缺权限不影响已经能用的功能 —— 用不到的权限不用加。' -ForegroundColor DarkGray
Write-Host ''
