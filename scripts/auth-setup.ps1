# ═══════════════════════════════════════════════════════════════════════════
#  auth-setup.ps1 — 授权向导（GitHub + Cloudflare）
#
#  为什么做成独立的交互式向导：
#     授权是整个流程里最容易卡住的一步 —— 用户不知道点哪个按钮、
#     要勾什么权限、拿到的东西往哪贴。
#     把它拆成一步步引导，每步只做一件事，并验证结果。
#
#  ⚠️ 本文件必须 UTF-8 **带 BOM** 保存（PowerShell 5.1 否则按 ANSI 解析）。
#
#  用法：
#    powershell -File auth-setup.ps1                 显示授权菜单
#    powershell -File auth-setup.ps1 -Action github  直接走 GitHub 授权
#    powershell -File auth-setup.ps1 -Action cf-token  Cloudflare Token 配置
#    powershell -File auth-setup.ps1 -Action cf-login  Cloudflare 浏览器登录
#    powershell -File auth-setup.ps1 -Action status    只看状态
# ═══════════════════════════════════════════════════════════════════════════

param(
    [ValidateSet('', 'github', 'cf-token', 'cf-login', 'status')]
    [string]$Action = ''
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$script:Root = Split-Path -Parent $PSScriptRoot
$script:EnvFile = Join-Path $script:Root '.env'

# ─── 工具函数 ───

<#
显示带边框的标题。

⚠️ 中文宽度要按**显示宽度**算，不能按 .Length。
   一个中文字符占 2 列，用 .Length 会导致中文标题的右边框错位 ——
   实测踩过：标题行比边框长出一截，看着很乱。
#>
function Get-DisplayWidth {
    param([string]$Text)
    $w = 0
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int][char]$ch
        # CJK 与全角字符占 2 列
        if ($code -ge 0x1100 -and (
            $code -le 0x115F -or
            ($code -ge 0x2E80 -and $code -le 0xA4CF) -or
            ($code -ge 0xAC00 -and $code -le 0xD7A3) -or
            ($code -ge 0xF900 -and $code -le 0xFAFF) -or
            ($code -ge 0xFE30 -and $code -le 0xFE6F) -or
            ($code -ge 0xFF00 -and $code -le 0xFF60) -or
            ($code -ge 0xFFE0 -and $code -le 0xFFE6)
        )) { $w += 2 } else { $w += 1 }
    }
    return $w
}

function Write-Title {
    param([string]$Text, [string]$Sub = '')
    $innerWidth = 64

    Write-Host ''
    Write-Host ('  ╔' + ('═' * $innerWidth) + '╗') -ForegroundColor Cyan

    $w = Get-DisplayWidth $Text
    $pad = $innerWidth - 4 - $w
    if ($pad -lt 0) { $pad = 0 }
    Write-Host ('  ║  ' + $Text + (' ' * $pad) + '  ║') -ForegroundColor Cyan

    if ($Sub) {
        $w2 = Get-DisplayWidth $Sub
        $pad2 = $innerWidth - 4 - $w2
        if ($pad2 -lt 0) { $pad2 = 0 }
        Write-Host ('  ║  ' + $Sub + (' ' * $pad2) + '  ║') -ForegroundColor DarkGray
    }

    Write-Host ('  ╚' + ('═' * $innerWidth) + '╝') -ForegroundColor Cyan
    Write-Host ''
}

function Test-Token {
    param([string]$Token)
    try {
        $headers = @{ 'Authorization' = "Bearer $Token" }
        $r = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' `
            -Headers $headers -TimeoutSec 20 -ErrorAction Stop
        return @{ Ok = $true; Status = $r.result.status }
    }
    catch {
        $msg = $_.Exception.Message
        return @{ Ok = $false; Error = $msg }
    }
}

function Save-Token {
    param([string]$Token, [string]$AccountId = '')

    $lines = @(
        '# Cloudflare 凭据 —— 不要把这个文件分享给别人',
        '# 由 cf-free-max 授权向导生成',
        '',
        "CF_API_TOKEN=$Token"
    )
    if ($AccountId) { $lines += "CF_ACCOUNT_ID=$AccountId" }

    $text = ($lines -join "`n") + "`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($script:EnvFile, $text, $utf8NoBom)
}

# ═══════════════════════════════════════════════════════════════
#  GitHub 授权
# ═══════════════════════════════════════════════════════════════

function Invoke-GitHubAuth {
    Write-Title 'GitHub 授权' '部署私有仓库时需要'

    # 检查 gh 是否安装
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) {
        Write-Host '  未安装 GitHub CLI（gh）。' -ForegroundColor Yellow
        Write-Host ''
        Write-Host '  gh 的作用：让脚本能访问你的私有仓库、自动完成授权。' -ForegroundColor DarkGray
        Write-Host '  只有公开仓库时不需要它。' -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '  ── 安装方式 ──────────────────────────────────────────────' -ForegroundColor Cyan
        Write-Host ''
        Write-Host '   方式一：winget（推荐，Win10 1809+ 自带）' -ForegroundColor White
        Write-Host '     winget install --id GitHub.cli -e' -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '   方式二：手动下载' -ForegroundColor White
        Write-Host '     https://cli.github.com/' -ForegroundColor DarkGray
        Write-Host ''

        $choice = Read-Host '  现在用 winget 自动安装吗？[Y/n]'
        if ($choice -notmatch '^[Nn]') {
            Write-Host ''
            Write-Host '  正在安装（可能需要几分钟）...' -ForegroundColor Gray
            & winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements 2>&1 |
                ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

            if ($LASTEXITCODE -eq 0) {
                Write-Host ''
                Write-Host '  安装完成。' -ForegroundColor Green
                Write-Host '  ⚠ 需要重开一个终端才能识别 gh 命令。' -ForegroundColor Yellow
                Write-Host '    请关闭本窗口，重新运行 启动.bat。' -ForegroundColor Yellow
                Write-Host ''
                Read-Host '  按回车返回'
                return
            }
            else {
                Write-Host ''
                Write-Host '  自动安装失败，请手动下载：https://cli.github.com/' -ForegroundColor Red
                Write-Host ''
                Read-Host '  按回车返回'
                return
            }
        }
        else {
            Write-Host ''
            Write-Host '  已跳过。' -ForegroundColor DarkGray
            Write-Host ''
            Read-Host '  按回车返回'
            return
        }
    }

    # 检查是否已登录
    $authOut = & gh auth status 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -and $authOut -match 'Logged in') {
        $user = ''
        if ($authOut -match 'account\s+(\S+)') { $user = $Matches[1] }
        Write-Host "  已经登录：$user" -ForegroundColor Green
        Write-Host ''
        Write-Host '  如果这个账号不对，需要先退出：gh auth logout' -ForegroundColor DarkGray
        Write-Host ''
        Read-Host '  按回车返回'
        return
    }

    # 未登录，开始授权
    Write-Host '  即将开始 GitHub 授权。' -ForegroundColor White
    Write-Host ''
    Write-Host '  ── 会发生什么 ────────────────────────────────────────────' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '   1. 屏幕上显示一个 8 位设备码（形如 XXXX-XXXX）' -ForegroundColor DarkGray
    Write-Host '   2. 自动打开浏览器到 github.com/login/device' -ForegroundColor DarkGray
    Write-Host '   3. 把设备码粘贴进去，点 Continue' -ForegroundColor DarkGray
    Write-Host '   4. 授权页面点 Authorize' -ForegroundColor DarkGray
    Write-Host '   5. 回到本窗口，会自动继续' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  ⚠ 浏览器没自动打开的话，手动访问：https://github.com/login/device' -ForegroundColor Yellow
    Write-Host ''

    Read-Host '  准备好了按回车开始'

    Write-Host ''
    Write-Host '  正在启动授权流程...' -ForegroundColor Gray
    Write-Host ''

    # gh auth login 的设备码流程
    # --web 用浏览器；--git-protocol https 让 git 操作也走这个凭据
    & gh auth login --hostname github.com --git-protocol https --web

    Write-Host ''
    if ($LASTEXITCODE -eq 0) {
        Write-Host '  授权成功！' -ForegroundColor Green
        Write-Host ''

        # 顺便配置 git 使用 gh 的凭据
        & gh auth setup-git 2>&1 | Out-Null
        Write-Host '  已配置 git 使用该凭据（clone/push 不再需要输密码）' -ForegroundColor DarkGray
    }
    else {
        Write-Host '  授权未完成。' -ForegroundColor Yellow
        Write-Host ''
        Write-Host '  可能的原因：' -ForegroundColor DarkGray
        Write-Host '    · 浏览器里没点最后的 Authorize' -ForegroundColor DarkGray
        Write-Host '    · 设备码过期（有效期约 15 分钟，重新运行即可）' -ForegroundColor DarkGray
        Write-Host '    · 网络无法访问 github.com（需要代理）' -ForegroundColor DarkGray
    }

    Write-Host ''
    Read-Host '  按回车返回'
}

# ═══════════════════════════════════════════════════════════════
# Cloudflare Token 配置
# ═══════════════════════════════════════════════════════════════

function Invoke-CloudflareToken {
    Write-Title 'Cloudflare Token 配置' '查用量 / 改配置时需要'

    Write-Host '  即将打开 Cloudflare 的 Token 创建页面。' -ForegroundColor White
    Write-Host ''
    Write-Host '  ── 操作步骤 ──────────────────────────────────────────────' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '   1. 点「Create Token」' -ForegroundColor DarkGray
    Write-Host '   2. 找到「Create Custom Token」，点「Get started」' -ForegroundColor DarkGray
    Write-Host '   3. Token name 随便填，比如 cf-free-max' -ForegroundColor DarkGray
    Write-Host '   4. Permissions 加这几条（第一个下拉选 Account）：' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '        Account  |  Account Analytics  |  Read' -ForegroundColor Green
    Write-Host '        Zone     |  Zone               |  Read' -ForegroundColor Green
    Write-Host ''
    Write-Host '      只想看用量的话，这两条就够了。' -ForegroundColor DarkGray
    Write-Host '      以后要用部署，再加：Account | Cloudflare Pages | Edit' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '   5. 点「Continue to summary」→「Create Token」' -ForegroundColor DarkGray
    Write-Host '   6. 复制显示出来的 Token（只显示这一次）' -ForegroundColor DarkGray
    Write-Host ''

    Read-Host '  按回车打开浏览器'

    Start-Process 'https://dash.cloudflare.com/profile/api-tokens'
    Write-Host ''
    Write-Host '  浏览器已打开。拿到 Token 后粘贴到下面。' -ForegroundColor Green
    Write-Host ''

    # 循环直到拿到有效 Token 或用户放弃
    $attempt = 0
    while ($true) {
        $attempt++
        Write-Host ''
        $input = Read-Host '  粘贴 Token（留空取消）'

        if ([string]::IsNullOrWhiteSpace($input)) {
            Write-Host ''
            Write-Host '  已取消。' -ForegroundColor DarkGray
            Write-Host ''
            Read-Host '  按回车返回'
            return
        }

        # 清洗：去引号、空格、零宽字符
        $token = $input.Trim().Trim([char]0x3000)
        if ($token.Length -ge 2) {
            $first = $token[0]; $last = $token[$token.Length - 1]
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $token = $token.Substring(1, $token.Length - 2)
            }
        }
        $token = $token -replace "[\u200B-\u200D\uFEFF]", ''
        $token = $token -replace '\s', ''

        if ($token.Length -lt 30) {
            Write-Host ''
            Write-Host "  Token 只有 $($token.Length) 个字符，看起来不完整。" -ForegroundColor Yellow
            Write-Host '  Cloudflare 的 API Token 通常有 40 个字符左右。' -ForegroundColor DarkGray
            Write-Host '  再试一次，或者留空取消。' -ForegroundColor DarkGray
            continue
        }

        Write-Host ''
        Write-Host '  正在校验 ...' -ForegroundColor Gray

        $result = Test-Token $token
        if ($result.Ok -and $result.Status -eq 'active') {
            Write-Host '  校验通过！' -ForegroundColor Green

            Save-Token $token
            Write-Host ''
            Write-Host "  已保存到：$($script:EnvFile)" -ForegroundColor DarkGray

            # 顺便查账号 ID
            Write-Host ''
            Write-Host '  正在查询账号 ...' -ForegroundColor Gray
            try {
                $headers = @{ 'Authorization' = "Bearer $token" }
                $accts = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/accounts' `
                    -Headers $headers -TimeoutSec 20 -ErrorAction Stop

                if ($accts.result.Count -eq 1) {
                    $acct = $accts.result[0]
                    Write-Host "  找到账号：$($acct.name)" -ForegroundColor Green
                    Write-Host ''
                    $save = Read-Host "  是否保存账号 ID（$($acct.id.Substring(0,8))...）？[Y/n]"
                    if ($save -notmatch '^[Nn]') {
                        Save-Token $token $acct.id
                        Write-Host '  已保存。' -ForegroundColor Green
                    }
                }
                elseif ($accts.result.Count -gt 1) {
                    Write-Host "  找到 $($accts.result.Count) 个账号：" -ForegroundColor Yellow
                    for ($i = 0; $i -lt $accts.result.Count; $i++) {
                        $a = $accts.result[$i]
                        Write-Host "    [$($i+1)] $($a.name)  $($a.id)" -ForegroundColor DarkGray
                    }
                    Write-Host ''
                    $pick = Read-Host '  选择要用的账号编号（留空跳过）'
                    $idx = 0
                    if ([int]::TryParse($pick, [ref]$idx) -and $idx -ge 1 -and $idx -le $accts.result.Count) {
                        Save-Token $token $accts.result[$idx - 1].id
                        Write-Host "  已保存账号：$($accts.result[$idx-1].name)" -ForegroundColor Green
                    }
                }
                else {
                    Write-Host '  该 Token 看不到账号（可能权限不足）。' -ForegroundColor Yellow
                    Write-Host '  想用 R2/KV/D1 功能的话，需要加 Account | Account Settings | Read' -ForegroundColor DarkGray
                }
            }
            catch {
                Write-Host '  查询账号失败（不影响基本功能）' -ForegroundColor DarkGray
            }

            Write-Host ''
            Write-Host '  配置完成！回到主菜单选 [1] 或 [2] 就能用了。' -ForegroundColor Green
            Write-Host ''
            Read-Host '  按回车返回'
            return
        }
        else {
            Write-Host ''
            Write-Host '  校验失败。' -ForegroundColor Red
            if ($result.Error) {
                Write-Host "  $($result.Error)" -ForegroundColor DarkGray
            }
            Write-Host ''
            Write-Host '  常见原因：' -ForegroundColor Yellow
            Write-Host '    · 复制不完整（漏了头尾）' -ForegroundColor DarkGray
            Write-Host '    · 创建后没点最后的「Create Token」按钮' -ForegroundColor DarkGray
            Write-Host '    · Token 已被删除' -ForegroundColor DarkGray
            Write-Host ''
        }

        if ($attempt -ge 3) {
            Write-Host '  已尝试 3 次，先返回吧。' -ForegroundColor Yellow
            Write-Host ''
            Read-Host '  按回车返回'
            return
        }
    }
}

# ═══════════════════════════════════════════════════════════════
# Cloudflare wrangler 浏览器登录
# ═══════════════════════════════════════════════════════════════

function Invoke-CloudflareLogin {
    Write-Title 'Cloudflare 浏览器登录' '部署网站时需要'

    Write-Host '  这是 Cloudflare 官方推荐的方式，不需要手动创建 Token。' -ForegroundColor White
    Write-Host ''
    Write-Host '  ── 会发生什么 ────────────────────────────────────────────' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '   1. 自动打开浏览器' -ForegroundColor DarkGray
    Write-Host '   2. 在页面上点「Allow」（授权 wrangler 访问你的账号）' -ForegroundColor DarkGray
    Write-Host '   3. 回到本窗口，会自动继续' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  凭据会保存到用户目录，只对这台电脑有效。' -ForegroundColor DarkGray
    Write-Host ''

    Read-Host '  准备好按回车开始'

    Write-Host ''
    Write-Host '  正在启动 wrangler ...' -ForegroundColor Gray
    Write-Host ''

    # 优先用项目内的 wrangler，避免依赖全局安装
    $localWrangler = Join-Path $script:Root 'node_modules\.bin\wrangler.cmd'
    if (Test-Path $localWrangler) {
        & $localWrangler login
    }
    else {
        & npx --yes wrangler login
    }

    Write-Host ''
    if ($LASTEXITCODE -eq 0) {
        Write-Host '  登录成功！部署功能可用了。' -ForegroundColor Green
    }
    else {
        Write-Host '  登录未完成。' -ForegroundColor Yellow
        Write-Host ''
        Write-Host '  可能的原因：' -ForegroundColor DarkGray
        Write-Host '    · 浏览器里没点 Allow' -ForegroundColor DarkGray
        Write-Host '    · 网络问题（wrangler 要访问 cloudflare.com）' -ForegroundColor DarkGray
        Write-Host '    · npx 下载失败（试试设置 npm 镜像）' -ForegroundColor DarkGray
    }

    Write-Host ''
    Read-Host '  按回车返回'
}

# ═══════════════════════════════════════════════════════════════
# 状态总览
# ═══════════════════════════════════════════════════════════════

function Write-AuthLine {
    param([string]$Status, [string]$Name, [string]$Detail)
    $icon = switch ($Status) {
        'ok' { '  [OK]  ' }
        'warn' { '  [!]   ' }
        'fail' { '  [X]   ' }
        default { '  [-]   ' }
    }
    $color = switch ($Status) {
        'ok' { 'Green' }
        'warn' { 'Yellow' }
        'fail' { 'Red' }
        default { 'DarkGray' }
    }

    # 名字按显示宽度补齐到 22 列（中文占 2 列）
    $w = Get-DisplayWidth $Name
    $pad = 22 - $w
    if ($pad -lt 0) { $pad = 0 }

    Write-Host $icon -NoNewline -ForegroundColor $color
    Write-Host ($Name + (' ' * $pad)) -NoNewline -ForegroundColor $color
    Write-Host $Detail -ForegroundColor DarkGray
}

function Show-AuthStatus {
    Write-Title '授权状态'

    # ── GitHub ──
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($gh) {
        $authOut = & gh auth status 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0 -and $authOut -match 'Logged in') {
            $user = ''
            if ($authOut -match 'account\s+(\S+)') { $user = $Matches[1] }
            Write-AuthLine 'ok' 'GitHub' "已登录$(if ($user) { "（$user）" })"
        }
        else {
            Write-AuthLine 'warn' 'GitHub' '未登录 —— 选 [1] 授权'
        }
    }
    else {
        Write-AuthLine 'skip' 'GitHub' '未安装 gh（只需公开仓库的话不影响）'
    }

    # ── Cloudflare Token ──
    $token = $env:CF_API_TOKEN
    $src = '环境变量'
    if (-not $token -and (Test-Path $script:EnvFile)) {
        $c = [System.IO.File]::ReadAllText($script:EnvFile, [System.Text.Encoding]::UTF8)
        if ($c -match 'CF_API_TOKEN\s*=\s*(\S+)') { $token = $Matches[1]; $src = '.env' }
    }
    if ($token) {
        $r = Test-Token $token
        if ($r.Ok) {
            Write-AuthLine 'ok' 'Cloudflare Token' "有效（$src）"
        }
        else {
            Write-AuthLine 'fail' 'Cloudflare Token' "无效（$src）—— 重新配置选 [2]"
        }
    }
    else {
        Write-AuthLine 'warn' 'Cloudflare Token' '未配置 —— 选 [2]，会打开创建页面并引导你勾权限'
    }

    # ── wrangler ──
    $wf = Join-Path $env:USERPROFILE '.wrangler\config\default.toml'
    $wfAlt = Join-Path $env:APPDATA 'xdg.config\.wrangler\config\default.toml'
    $logged = $false
    foreach ($f in @($wf, $wfAlt)) {
        if (Test-Path $f) {
            $c = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
            if ($c -match 'oauth_token|api_token') { $logged = $true; break }
        }
    }
    if ($logged) {
        Write-AuthLine 'ok' 'wrangler 登录' '已登录（部署网站可用）'
    }
    else {
        Write-AuthLine 'warn' 'wrangler 登录' '未登录 —— 部署网站需要，选 [3]'
    }

    Write-Host ''
    Write-Host '  说明：三件事互相独立，按需配置。' -ForegroundColor DarkGray
    Write-Host '        · 只看额度用量  → 只需要 Cloudflare Token' -ForegroundColor DarkGray
    Write-Host '        · 要部署网站    → 需要 wrangler 登录' -ForegroundColor DarkGray
    Write-Host '        · 部署私有仓库  → 还需要 GitHub 授权' -ForegroundColor DarkGray
    Write-Host ''
    Read-Host '  按回车返回' | Out-Null
}
# ═══════════════════════════════════════════════════════════════
# 主菜单
# ═══════════════════════════════════════════════════════════════

function Show-Menu {
    while ($true) {
        Clear-Host
        Write-Title '授权向导' '搞定 GitHub 和 Cloudflare 的登录'

        Write-Host '  授权分三件事，按需选择：' -ForegroundColor White
        Write-Host ''
        Write-Host '    [1]  GitHub 授权' -ForegroundColor Cyan
        Write-Host '         部署私有仓库时需要。走设备码流程，不用手动建 Token。' -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '    [2]  Cloudflare Token' -ForegroundColor Cyan
        Write-Host '         查用量、改配置时需要。会打开创建页面并引导你勾权限。' -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '    [3]  Cloudflare 浏览器登录' -ForegroundColor Cyan
        Write-Host '         部署网站时需要。官方推荐方式，不用建 Token。' -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '    [4]  查看授权状态' -ForegroundColor Cyan
        Write-Host '    [5]  环境检测（完整）' -ForegroundColor Cyan
        Write-Host ''
        Write-Host '    [0]  返回' -ForegroundColor DarkGray
        Write-Host ''

        $choice = Read-Host '  请选择 [0-5]'

        switch ($choice) {
            '1' { Invoke-GitHubAuth }
            '2' { Invoke-CloudflareToken }
            '3' { Invoke-CloudflareLogin }
            '4' { Show-AuthStatus }
            '5' {
                $checkScript = Join-Path $PSScriptRoot 'check-env.ps1'
                if (Test-Path $checkScript) {
                    & powershell -NoProfile -ExecutionPolicy Bypass -File $checkScript
                    Write-Host ''
                    Read-Host '  按回车返回'
                }
                else {
                    Write-Host ''
                    Write-Host '  找不到 check-env.ps1' -ForegroundColor Red
                    Read-Host '  按回车返回'
                }
            }
            '0' { return }
            default {
                Write-Host ''
                Write-Host '  无效选择。' -ForegroundColor Yellow
                Start-Sleep -Milliseconds 800
            }
        }
    }
}

# ─── 入口 ───

switch ($Action) {
    'github' { Invoke-GitHubAuth }
    'cf-token' { Invoke-CloudflareToken }
    'cf-login' { Invoke-CloudflareLogin }
    'status' { Show-AuthStatus }
    default { Show-Menu }
}
