# ═══════════════════════════════════════════════════════════════════════════
#  query-usage.ps1 — 查询 Cloudflare 免费额度用量
#
#  独立 .ps1 的原因见 快查.bat 顶部注释：.bat 里内嵌多行 PowerShell
#  在 GBK 编码下必然失败（中文变乱码破坏语法）。
# ═══════════════════════════════════════════════════════════════════════════

param(
    [Parameter(Mandatory = $true)]
    [string]$Token,

    [string]$AccountId = ''
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$script:headers = @{
    'Authorization' = "Bearer $Token"
    'Content-Type'  = 'application/json'
}

function Write-Bar {
    param([double]$pct, [int]$width = 20)
    $filled = [Math]::Min($width, [Math]::Round($pct / 100 * $width))
    $empty = $width - $filled
    return ('#' * $filled) + ('.' * $empty)
}

function Get-GraphQL {
    param([string]$Query, [hashtable]$Variables)
    $body = @{ query = $Query; variables = $Variables } | ConvertTo-Json -Depth 6 -Compress
    try {
        return Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/graphql' `
            -Headers $script:headers -Method Post -Body $body -TimeoutSec 30 -ErrorAction Stop
    }
    catch {
        return $null
    }
}

# ─── 确定账号 ID ───
$account = $AccountId

if ([string]::IsNullOrWhiteSpace($account)) {
    Write-Host '  未指定账号 ID，正在自动获取 ...' -ForegroundColor DarkGray
    try {
        $accts = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/accounts' `
            -Headers $script:headers -TimeoutSec 25 -ErrorAction Stop

        if ($accts.result.Count -eq 1) {
            $account = $accts.result[0].id
            Write-Host ("  账号：" + $accts.result[0].name) -ForegroundColor DarkGray
        }
        elseif ($accts.result.Count -gt 1) {
            Write-Host ''
            Write-Host '  该 Token 可见多个账号，请在 .env 里指定 CF_ACCOUNT_ID：' -ForegroundColor Yellow
            foreach ($a in $accts.result) {
                Write-Host ("    " + $a.name + "  [" + $a.id + "]") -ForegroundColor DarkGray
            }
            Write-Host ''
            exit 1
        }
        else {
            Write-Host '  该 Token 看不到账号（可能是 zone-scoped）。' -ForegroundColor Yellow
            Write-Host '  只能查询 zone 级信息，用量统计需要账号级权限。' -ForegroundColor DarkGray
            exit 1
        }
    }
    catch {
        Write-Host '  无法获取账号列表：' -NoNewline -ForegroundColor Red
        Write-Host $_.Exception.Message
        exit 1
    }
}

# ─── 时间范围：过去 24 小时 ───
$now = (Get-Date).ToUniversalTime()
$since = $now.AddHours(-24)
$fmt = 'yyyy-MM-ddTHH:mm:ssZ'
$sinceStr = $since.ToString($fmt)
$nowStr = $now.ToString($fmt)

Write-Host ''
Write-Host ("  统计范围：" + $since.ToString('MM-dd HH:mm') + " 至 " + $now.ToString('MM-dd HH:mm') + " UTC") -ForegroundColor DarkGray
Write-Host ''

$vars = @{ a = $account; s = $sinceStr; u = $nowStr }
$warned = @()

# ═══ Workers ═══
Write-Host '  ── Workers 请求 ──────────────────────────────────────────────' -ForegroundColor Cyan
$q = 'query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$s,datetime_leq:$u}){sum{requests}}}}}'
$r = Get-GraphQL -Query $q -Variables $vars
if ($r) {
    $n = 0
    foreach ($row in $r.data.viewer.accounts[0].workersInvocationsAdaptive) { $n += [int64]$row.sum.requests }
    $pct = [Math]::Round($n / 100000 * 100, 1)
    $color = if ($pct -ge 80) { 'Red' } elseif ($pct -ge 50) { 'Yellow' } else { 'Green' }
    Write-Host ("    " + $n.ToString('N0').PadLeft(12) + " / 100,000   " + (Write-Bar $pct) + ("  " + $pct + "%")) -ForegroundColor $color
    if ($pct -ge 80) { $warned += "Workers 请求已用 $pct%" }
}
else {
    Write-Host '    查询失败（可能缺 Account Analytics:Read 权限）' -ForegroundColor DarkGray
}

Write-Host ''

# ═══ KV ═══
Write-Host '  ── Workers KV ────────────────────────────────────────────────' -ForegroundColor Cyan
$q = 'query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){kvOperationsAdaptiveGroups(limit:100,filter:{datetime_geq:$s,datetime_leq:$u}){sum{requests} dimensions{actionType}}}}}'
$r = Get-GraphQL -Query $q -Variables $vars
if ($r) {
    $reads = 0; $writes = 0
    foreach ($g in $r.data.viewer.accounts[0].kvOperationsAdaptiveGroups) {
        $t = [string]$g.dimensions.actionType
        if ($t -match 'read') { $reads += [int64]$g.sum.requests }
        elseif ($t -match 'write') { $writes += [int64]$g.sum.requests }
    }

    $rp = [Math]::Round($reads / 100000 * 100, 1)
    Write-Host ("    读  " + $reads.ToString('N0').PadLeft(12) + " / 100,000   " + (Write-Bar $rp) + ("  " + $rp + "%")) -ForegroundColor DarkGray

    $wp = [Math]::Round($writes / 1000 * 100, 1)
    $wc = if ($wp -ge 80) { 'Red' } elseif ($wp -ge 50) { 'Yellow' } else { 'Green' }
    Write-Host ("    写  " + $writes.ToString('N0').PadLeft(12) + " / 1,000     " + (Write-Bar $wp) + ("  " + $wp + "%")) -ForegroundColor $wc
    if ($wp -ge 80) { $warned += "KV 写入已用 $wp%（免费层只有 1000 次/天）" }
}
else {
    Write-Host '    查询失败' -ForegroundColor DarkGray
}

Write-Host ''

# ═══ D1 ═══
Write-Host '  ── D1 数据库 ─────────────────────────────────────────────────' -ForegroundColor Cyan
$q = 'query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:100,filter:{datetime_geq:$s,datetime_leq:$u}){sum{rowsRead rowsWritten}}}}}'
$r = Get-GraphQL -Query $q -Variables $vars
if ($r) {
    $read = 0; $written = 0
    foreach ($g in $r.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups) {
        $read += [int64]$g.sum.rowsRead
        $written += [int64]$g.sum.rowsWritten
    }
    $p = [Math]::Round($read / 5000000 * 100, 2)
    $pc = if ($p -ge 80) { 'Red' } elseif ($p -ge 50) { 'Yellow' } else { 'Green' }
    Write-Host ("    扫描行  " + $read.ToString('N0').PadLeft(12) + " / 5,000,000 " + (Write-Bar $p) + ("  " + $p + "%")) -ForegroundColor $pc
    Write-Host ("    写入行  " + $written.ToString('N0').PadLeft(12) + " / 100,000") -ForegroundColor DarkGray
    if ($p -ge 80) { $warned += "D1 扫描行已用 $p%（检查索引：cfm d1 explain）" }
}
else {
    Write-Host '    查询失败' -ForegroundColor DarkGray
}

Write-Host ''

# ═══ R2 ═══
Write-Host '  ── R2 存储 ───────────────────────────────────────────────────' -ForegroundColor Cyan
try {
    $r2 = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$account/r2/buckets" `
        -Headers $script:headers -TimeoutSec 25 -ErrorAction Stop

    if ($r2.result.Count -eq 0) {
        Write-Host '    还没有 R2 桶' -ForegroundColor DarkGray
        Write-Host '    提示：R2 的 10GB 存储 + 出站流量免费，是免费层最值钱的一项' -ForegroundColor DarkGray
    }
    else {
        Write-Host ("    共 " + $r2.result.Count + " 个桶：") -ForegroundColor DarkGray
        foreach ($b in $r2.result) {
            Write-Host ("      · " + $b.name) -ForegroundColor DarkGray
        }
    }
}
catch {
    Write-Host '    查询失败（可能缺 R2 权限）' -ForegroundColor DarkGray
}

Write-Host ''

# ─── 汇总提醒 ───
if ($warned.Count -gt 0) {
    Write-Host '  ════════════════════════════════════════════════════════════════' -ForegroundColor Yellow
    Write-Host '  需要注意' -ForegroundColor Yellow
    Write-Host '  ════════════════════════════════════════════════════════════════' -ForegroundColor Yellow
    Write-Host ''
    foreach ($w in $warned) {
        Write-Host ("    ! " + $w) -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host '    解决思路：' -ForegroundColor DarkGray
    Write-Host '      KV 写入超限  → 改用 D1，或降低写入频率（批量聚合后写）' -ForegroundColor DarkGray
    Write-Host '      D1 扫描行超限 → 检查索引，避免全表扫描' -ForegroundColor DarkGray
    Write-Host '      Workers 超限 → 检查是否有循环调用或爬虫' -ForegroundColor DarkGray
}
else {
    Write-Host '  √ 全部指标在安全范围内' -ForegroundColor Green
}

Write-Host ''
Write-Host '  说明：GraphQL Analytics 有 1~5 分钟延迟。' -ForegroundColor DarkGray
Write-Host '        日额度按 UTC 00:00 重置（北京时间早上 8 点）。' -ForegroundColor DarkGray
Write-Host ''
