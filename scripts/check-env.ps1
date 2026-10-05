# ═══════════════════════════════════════════════════════════════════════════
#  check-env.ps1 — 环境检测 + 授权引导
#
#  为什么单独一个 .ps1 而不是写在 .bat 里：
#    见 启动.bat 顶部注释 —— .bat 内嵌 PowerShell 在 GBK 编码下必然乱码。
#    所有 PowerShell 逻辑都要外置。
#
#  ⚠️ 本文件必须 UTF-8 **带 BOM** 保存，否则 PowerShell 5.1 按 ANSI 解析，
#     中文变乱码并破坏语法（实测踩过，极难定位）。
#
#  用法：
#    powershell -File check-env.ps1              完整检测
#    powershell -File check-env.ps1 -Quick       只查关键项（快）
#    powershell -File check-env.ps1 -Fix         检测并尝试自动修复
# ═══════════════════════════════════════════════════════════════════════════

param(
    [switch]$Quick,
    [switch]$Fix,
    [string]$HintOnly = ''
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# ─── 根目录 ───
#
# ⚠️ 必须基于**脚本位置**而不是当前工作目录。
#   实测踩过：脚本被从 scripts/ 目录调用时，Get-Location 指向 scripts/，
#   于是找 config/sites.json、.env 全部找不到，误报「未配置」。
$script:Root = Split-Path -Parent $PSScriptRoot

# ─── 工具函数 ───

$script:results = @()

<#
读取 UTF-8 的 JSON 文件。

⚠️ 必须显式指定 UTF-8，不能用 Get-Content -Raw。
   实测踩过：PowerShell 5.1 的 Get-Content 默认按**系统 ANSI 代码页**
   读取文件。我们的 sites.json 是 UTF-8，中文注释会被读成乱码，
   而乱码里的字符会破坏 JSON 结构，报
   「Invalid object passed in, ':' or '}' expected」——
   看起来像 JSON 写错了，实际是读取编码不对。

   这个坑很隐蔽：同一份文件 Node 读得好好的，PowerShell 读就炸。
#>
function Read-JsonFile {
    param([string]$Path)
    try {
        $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
        # 去掉可能的 BOM
        if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) {
            $text = $text.Substring(1)
        }
        return $text | ConvertFrom-Json
    }
    catch {
        throw $_
    }
}

function Add-Result {
    param(
        [string]$Name,
        [ValidateSet('ok', 'warn', 'fail', 'skip')]
        [string]$Status,
        [string]$Detail,
        [string]$FixHint = '',
        [string]$AutoFix = ''
    )
    $script:results += [PSCustomObject]@{
        Name     = $Name
        Status   = $Status
        Detail   = $Detail
        FixHint  = $FixHint
        AutoFix  = $AutoFix
    }
}

function Write-Icon {
    param([string]$Status)
    switch ($Status) {
        'ok'   { return '  [OK]  ' }
        'warn' { return '  [!]   ' }
        'fail' { return '  [X]   ' }
        'skip' { return '  [-]   ' }
        default { return '  [?]   ' }
    }
}

function Test-Command {
    param([string]$Name, [string[]]$VersionArgs = @('--version'))
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    try {
        $out = & $Name @VersionArgs 2>&1 | Select-Object -First 1
        return [PSCustomObject]@{ Path = $cmd.Source; Version = "$out".Trim() }
    }
    catch {
        return [PSCustomObject]@{ Path = $cmd.Source; Version = '(无法获取版本)' }
    }
}

# ─── 1. 基础工具链 ───

function Check-Toolchain {
    Write-Host ''
    Write-Host '  基础工具链' -ForegroundColor Cyan
    Write-Host '  ────────────────────────────────────────────────────────────'

    # Node.js —— 核心依赖
    $node = Test-Command 'node'
    if ($node) {
        $verStr = $node.Version -replace '^v', ''
        $major = 0
        if ($verStr -match '^(\d+)\.') { $major = [int]$Matches[1] }

        if ($major -ge 18) {
            Add-Result 'Node.js' 'ok' "$($node.Version)  ($($node.Path))"
        }
        else {
            Add-Result 'Node.js' 'fail' "版本过低：$($node.Version)，需要 18 以上" `
                '到 https://nodejs.org 装 LTS 版本'
        }
    }
    else {
        Add-Result 'Node.js' 'warn' '未安装（启动.bat 会自动下载便携版）' `
            '无需手动处理，双击 启动.bat 会自动获取'
    }

    # git —— 部署功能需要
    $git = Test-Command 'git'
    if ($git) {
        Add-Result 'git' 'ok' $git.Version
    }
    else {
        Add-Result 'git' 'warn' '未安装（部署功能需要）' `
            '下载：https://git-scm.com/download/win' `
            'winget install --id Git.Git -e'
    }

    # npm —— Node 自带
    $npm = Test-Command 'npm'
    if ($npm) {
        Add-Result 'npm' 'ok' $npm.Version
    }
    elseif ($node) {
        Add-Result 'npm' 'warn' 'node 存在但 npm 不可用' '重新安装 Node.js（npm 会一起装上）'
    }
    else {
        Add-Result 'npm' 'skip' '未检测（需要 Node）'
    }

    # curl —— 下载与 API 调用
    $curl = Test-Command 'curl' @('--version')
    if ($curl) {
        Add-Result 'curl' 'ok' '系统自带'
    }
    else {
        Add-Result 'curl' 'warn' '未找到（较老的系统可能没有）' 'Windows 10 1803+ 自带，升级系统即可'
    }

    # tar —— 解压 Node 压缩包
    $tar = Test-Command 'tar' @('--version')
    if ($tar) {
        Add-Result 'tar' 'ok' '系统自带'
    }
    else {
        Add-Result 'tar' 'skip' '未找到（会用 PowerShell 解压）'
    }
}

# ─── 2. 网络连通性 ───

function Test-Endpoint {
    param([string]$Url, [int]$TimeoutSec = 8)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $headers = @{ 'User-Agent' = 'cf-free-max-envcheck/1.0' }

    # ⚠️ 用 GET 而不是 HEAD。
    #   实测踩过：Cloudflare 的 API 端点对 HEAD 返回 404/403，
    #   导致「网络不可达」的误报 —— 明明通的却报红。
    #   代价是多传几十字节，换来准确的判断，值得。
    #
    # 另外：只要能拿到**任何** HTTP 响应（哪怕是 401/403），
    #   就说明网络是通的 —— 只看有没有响应，不看状态码。
    foreach ($method in @('Get', 'Head')) {
        try {
            $r = Invoke-WebRequest -Uri $Url -Method $method -TimeoutSec $TimeoutSec `
                -UseBasicParsing -Headers $headers -ErrorAction Stop
            $sw.Stop()
            return [PSCustomObject]@{ Ok = $true; Ms = $sw.ElapsedMilliseconds; Status = [int]$r.StatusCode }
        }
        catch {
            # 拿到 HTTP 状态码（4xx/5xx）也算通 —— 说明 TCP+TLS 都建立了
            $resp = $null
            if ($_.Exception.Response) { $resp = $_.Exception.Response }
            if ($resp -and $resp.StatusCode) {
                $sw.Stop()
                return [PSCustomObject]@{ Ok = $true; Ms = $sw.ElapsedMilliseconds; Status = [int]$resp.StatusCode }
            }
            # 网络层失败（DNS/连接/超时）才继续试下一种方法
            $lastError = $_.Exception.Message
        }
    }

    $sw.Stop()
    return [PSCustomObject]@{ Ok = $false; Ms = $sw.ElapsedMilliseconds; Error = $lastError }
}

function Check-Network {
    Write-Host ''
    Write-Host '  网络连通性' -ForegroundColor Cyan
    Write-Host '  ────────────────────────────────────────────────────────────'

    # 检测代理设置
    $proxy = $env:HTTPS_PROXY
    if (-not $proxy) { $proxy = $env:HTTP_PROXY }
    if ($proxy) {
        Add-Result '代理设置' 'ok' $proxy
    }

    $targets = @(
        @{ Name = 'Cloudflare API'; Url = 'https://api.cloudflare.com/client/v4'; Need = $true },
        @{ Name = 'Cloudflare 控制台'; Url = 'https://dash.cloudflare.com'; Need = $true },
        @{ Name = 'GitHub'; Url = 'https://github.com'; Need = $false },
        @{ Name = 'nodejs.org'; Url = 'https://nodejs.org'; Need = $false },
        @{ Name = 'npm 官方源'; Url = 'https://registry.npmjs.org'; Need = $false }
    )

    foreach ($t in $targets) {
        $r = Test-Endpoint $t.Url
        if ($r.Ok) {
            Add-Result $t.Name 'ok' "可达（$($r.Ms)ms）"
        }
        else {
            $need = if ($t.Need) { 'fail' } else { 'warn' }
            $hint = if ($t.Name -eq 'GitHub' -or $t.Name -eq 'npm 官方源') {
                '国内网络可能需要代理：set HTTPS_PROXY=http://127.0.0.1:端口'
            }
            else { '检查网络连接或防火墙' }
            Add-Result $t.Name $need "不可达：$($r.Error)" $hint
        }
    }
}

# ─── 3. 授权状态 ───

function Check-Auth {
    Write-Host ''
    Write-Host '  授权状态' -ForegroundColor Cyan
    Write-Host '  ────────────────────────────────────────────────────────────'

    # ── GitHub ──
    $gh = Test-Command 'gh' @('--version')
    if ($gh) {
        try {
            $authOut = & gh auth status 2>&1 | Out-String
            if ($LASTEXITCODE -eq 0 -and $authOut -match 'Logged in') {
                $user = ''
                if ($authOut -match 'account\s+(\S+)') { $user = $Matches[1] }
                Add-Result 'GitHub 授权' 'ok' "已登录$(if ($user) { "（$user）" })"
            }
            else {
                Add-Result 'GitHub 授权' 'warn' 'gh 已安装但未登录' `
                    '选 [2] 开始授权（设备码流程，会弹浏览器）' `
                    'gh auth login --hostname github.com --git-protocol https --web'
            }
        }
        catch {
            Add-Result 'GitHub 授权' 'warn' '无法获取 gh 状态' '运行 gh auth login'
        }
    }
    else {
        Add-Result 'GitHub 授权' 'warn' '未安装 gh CLI（只影响部署私有仓库）' `
            '可选安装：winget install --id GitHub.cli -e' `
            'winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements'
    }

    # ── Cloudflare：Token（环境变量或 .env）──
    $token = $env:CF_API_TOKEN
    $tokenSource = '环境变量'

    if (-not $token) {
        # 找 .env
        $rootDir = Split-Path -Parent $PSScriptRoot
        $envFiles = @(
            (Join-Path $script:Root '.env'),
            (Join-Path (Split-Path -Parent $script:Root) '.env')
        )
        foreach ($f in $envFiles) {
            if (Test-Path $f) {
                $content = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
                if ($content -match 'CF_API_TOKEN\s*=\s*(\S+)') {
                    $token = $Matches[1].Trim('"').Trim("'")
                    $tokenSource = ".env（$f）"
                    break
                }
            }
        }
    }

    if ($token) {
        $len = $token.Length
        # 实际校验
        try {
            $headers = @{ 'Authorization' = "Bearer $token" }
            $r = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' `
                -Headers $headers -TimeoutSec 15 -ErrorAction Stop
            if ($r.result.status -eq 'active') {
                Add-Result 'Cloudflare Token' 'ok' "有效（$tokenSource，$len 字符）"
            }
            else {
                Add-Result 'Cloudflare Token' 'warn' "状态 $($r.result.status)，不是 active" `
                    '重新创建一个 Token'
            }
        }
        catch {
            Add-Result 'Cloudflare Token' 'fail' "校验失败（$tokenSource）" `
                'Token 可能已过期或被删除，重新配置：选 [3]'
        }
    }
    else {
        Add-Result 'Cloudflare Token' 'warn' '未配置' `
            '选 [3] 配置（会打开创建页面并引导你粘贴）'
    }

    # ── Cloudflare：wrangler 登录（部署用）──
    $wranglerConfig = Join-Path $env:USERPROFILE '.wrangler\config\default.toml'
    $wranglerAlt = Join-Path $env:APPDATA 'xdg.config\.wrangler\config\default.toml'
    $foundWrangler = $false
    foreach ($f in @($wranglerConfig, $wranglerAlt)) {
        if (Test-Path $f) {
            $c = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
            if ($c -match 'oauth_token|api_token') { $foundWrangler = $true; break }
        }
    }
    # 检查 wrangler 是否真的可用 ——
    # 光看配置文件不够：配置文件可能存在，但 npx/wrangler 命令都不可用
    # （实测踩过：干净环境里报了「已登录」，实际根本没装 wrangler）
    $wranglerCmd = Get-Command wrangler -ErrorAction SilentlyContinue
    $npxCmd = Get-Command npx -ErrorAction SilentlyContinue

    if ($foundWrangler -and ($wranglerCmd -or $npxCmd)) {
        Add-Result 'wrangler 登录' 'ok' '已登录（部署功能可用）'
    }
    elseif ($foundWrangler -and -not ($wranglerCmd -or $npxCmd)) {
        Add-Result 'wrangler 登录' 'skip' '有登录记录但缺 Node 环境（装完 Node 后自动可用）'
    }
    elseif (-not $wranglerCmd -and -not $npxCmd) {
        Add-Result 'wrangler 登录' 'skip' '未检测（需要先有 Node 环境）'
    }
    else {
        Add-Result 'wrangler 登录' 'warn' '未登录（部署功能需要）' `
            '选 [4] 开始授权（会弹浏览器登录 Cloudflare）' `
            'npx wrangler login'
    }
}

# ─── 4. 配置完整性 ───

function Check-Config {
    Write-Host ''
    Write-Host '  配置文件' -ForegroundColor Cyan
    Write-Host '  ────────────────────────────────────────────────────────────'

    $envFile = Join-Path $script:Root '.env'
    if (Test-Path $envFile) {
        Add-Result '.env 凭据文件' 'ok' $envFile
    }
    else {
        Add-Result '.env 凭据文件' 'skip' '不存在（可以用环境变量代替）'
    }

    $cfgFile = Join-Path $script:Root 'config\sites.json'
    if (Test-Path $cfgFile) {
        try {
            $cfg = Read-JsonFile $cfgFile
            $sites = @($cfg.sites)
            $protected = @($sites | Where-Object { $_.protected })

            if ($cfg.repoOwner -eq 'your-github-username') {
                Add-Result '部署配置' 'warn' '仍是模板（repoOwner 未填）' `
                    '编辑 config\sites.json，把 repoOwner 改成你的 GitHub 用户名'
            }
            else {
                Add-Result '部署配置' 'ok' "$($sites.Count) 个站点$(if ($protected.Count) { "，其中 $($protected.Count) 个受保护" })"
            }
        }
        catch {
            Add-Result '部署配置' 'fail' "JSON 解析失败：$($_.Exception.Message)" `
                '检查 config\sites.json 的语法（逗号、引号）'
        }
    }
    else {
        Add-Result '部署配置' 'skip' '不存在（不影响额度查询功能）'
    }
}

# ─── 5. 仓库可访问性（需要 gh 已登录）──

function Check-Repos {
    $cfgFile = Join-Path $script:Root 'config\sites.json'
    if (-not (Test-Path $cfgFile)) { return }

    try {
        $cfg = Read-JsonFile $cfgFile
    }
    catch { return }

    if ($cfg.repoOwner -eq 'your-github-username') { return }

    Write-Host ''
    Write-Host '  仓库可访问性' -ForegroundColor Cyan
    Write-Host '  ────────────────────────────────────────────────────────────'

    foreach ($site in @($cfg.sites)) {
        $repo = "$($cfg.repoOwner)/$($site.repo)"
        $url = "https://github.com/$repo"

        $r = Test-Endpoint $url 6
        if ($r.Ok) {
            Add-Result $site.label 'ok' "$repo 可访问"
        }
        else {
            # 可能是私有仓库，检查 gh 是否能访问
            $ghOk = $false
            if (Get-Command gh -ErrorAction SilentlyContinue) {
                & gh repo view $repo --json name 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { $ghOk = $true }
            }
            if ($ghOk) {
                Add-Result $site.label 'ok' "$repo 私有仓库（gh 已授权可访问）"
            }
            else {
                Add-Result $site.label 'warn' "$repo 无法访问" `
                    "私有仓库需要 GitHub 授权：选 [2]；或确认仓库名是否正确"
            }
        }
    }
}

# ─── 执行检测 ───

Clear-Host
Write-Host ''
Write-Host '  ╔════════════════════════════════════════════════════════════════╗' -ForegroundColor Cyan
Write-Host '  ║                    环境检测                                    ║' -ForegroundColor Cyan
Write-Host '  ╚════════════════════════════════════════════════════════════════╝' -ForegroundColor Cyan

Check-Toolchain
Check-Network
Check-Auth
Check-Config

if (-not $Quick) {
    Check-Repos
}

# ─── 汇总 ───

Write-Host ''
Write-Host '  ────────────────────────────────────────────────────────────' -ForegroundColor Cyan
Write-Host ''

$okCount = @($script:results | Where-Object { $_.Status -eq 'ok' }).Count
$warnCount = @($script:results | Where-Object { $_.Status -eq 'warn' }).Count
$failCount = @($script:results | Where-Object { $_.Status -eq 'fail' }).Count

foreach ($r in $script:results) {
    $color = switch ($r.Status) {
        'ok' { 'Green' }
        'warn' { 'Yellow' }
        'fail' { 'Red' }
        default { 'DarkGray' }
    }
    Write-Host "$(Write-Icon $r.Status)$($r.Name.PadRight(20))" -NoNewline -ForegroundColor $color
    Write-Host $r.Detail -ForegroundColor DarkGray

    if ($r.FixHint -and $r.Status -ne 'ok') {
        Write-Host "         -> $($r.FixHint)" -ForegroundColor DarkYellow
    }
}

Write-Host ''
Write-Host "  正常 $okCount / 警告 $warnCount / 失败 $failCount" -ForegroundColor Gray
Write-Host ''

# ─── 自动修复（可选）──

if ($Fix) {
    $fixable = @($script:results | Where-Object { $_.AutoFix -and $_.Status -ne 'ok' })
    if ($fixable.Count -gt 0) {
        Write-Host '  可自动修复的项目：' -ForegroundColor Yellow
        foreach ($f in $fixable) {
            Write-Host "    - $($f.Name)" -ForegroundColor DarkYellow
            Write-Host "      $($f.AutoFix)" -ForegroundColor DarkGray
        }
        Write-Host ''
    }
}

# 返回退出码：有 fail 则为 1
if ($failCount -gt 0) { exit 1 }
exit 0
