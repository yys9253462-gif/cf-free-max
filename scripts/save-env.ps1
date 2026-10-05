# ═══════════════════════════════════════════════════════════════════════════
#  save-env.ps1 — 安全地写入 .env 凭据文件
#
#  为什么单独一个 .ps1 文件：
#    最初这段逻辑是内嵌在 .bat 里的 powershell -Command 多行命令。
#    实测发现**必然失败**：.bat 是 GBK 编码，其中的中文（如「凭据」「——」）
#    经过 cmd 代码页 → PowerShell 参数解析 两次转换后变成乱码，
#    而乱码中的 ? 等字符会直接破坏 PowerShell 语法，报一堆
#    "The term '^' is not recognized"。
#
#    解决办法：把 PowerShell 代码放进独立的 .ps1（UTF-8 带 BOM），
#    .bat 只负责调用，不参与任何文本传递。
#
#  参数：
#    -Token       API Token（必需）
#    -AccountId   账号 ID（可选）
#    -OutputFile  .env 的目标路径
#
#  用法（由 .bat 调用）：
#    powershell -NoProfile -ExecutionPolicy Bypass -File save-env.ps1 `
#      -Token "xxx" -AccountId "yyy" -OutputFile "C:\path\.env"
# ═══════════════════════════════════════════════════════════════════════════

param(
    [Parameter(Mandatory = $true)]
    [string]$Token,

    [string]$AccountId = '',

    [Parameter(Mandatory = $true)]
    [string]$OutputFile
)

$ErrorActionPreference = 'Stop'

# ─── 清洗输入 ───
# 用户粘贴时常带上引号、首尾空格，甚至从别的文档里带出零宽字符。
# 这些都会让 Token 校验失败，而且报错信息看不出原因。


# ─── 权限缺失诊断 ───
#
# 原实现只打一句「可能缺少 Account:Read 权限」，用户不知道去哪补。
# 这里给出完整路径：在哪个页面、加哪一条、第一个下拉选什么。
function Show-MissingAccountPermission {
    Write-Host ''
    Write-Host '  ! 这个 Token 看不到账号 —— 不是「正常」，是缺了一条权限' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  影响：R2 / KV / D1 / Pages / Tunnel 需要账号级权限，现在用不了。' -ForegroundColor DarkGray
    Write-Host '        只看用量和列域名不受影响，现在就能用。' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  补权限的办法（1 分钟）：' -ForegroundColor White
    Write-Host ''
    Write-Host '    1. 打开 https://dash.cloudflare.com/profile/api-tokens' -ForegroundColor DarkGray
    Write-Host '    2. 找到你刚建的那个 Token，点右边「...」→「Edit」' -ForegroundColor DarkGray
    Write-Host '    3. 在 Permissions 点「+ Add more」，加上这一条：' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '         Account  |  Account Settings  |  Read' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '       注意第一个下拉选 Account（不是 Zone）' -ForegroundColor DarkGray
    Write-Host '    4. 保存后回到本窗口，重新选 [7] 配置' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  或者自己找 Account ID（32 位十六进制），手动填进来：' -ForegroundColor White
    Write-Host '    · 登录 https://dash.cloudflare.com 后看浏览器地址栏' -ForegroundColor DarkGray
    Write-Host '      https://dash.cloudflare.com/<这串就是>/home' -ForegroundColor DarkGray
    Write-Host '    · 或任意域名管理页拉到底部，右下角显示 Account ID' -ForegroundColor DarkGray
    Write-Host ''
}

function Clean-Value {
    param([string]$v)
    if ($null -eq $v) { return '' }

    $s = $v

    # 去掉首尾空白（含全角空格）
    $s = $s.Trim()
    $s = $s.Trim([char]0x3000)

    # 去掉成对的引号
    if ($s.Length -ge 2) {
        $first = $s[0]
        $last = $s[$s.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $s = $s.Substring(1, $s.Length - 2)
        }
    }

    # 去掉零宽字符与 BOM（从网页/文档复制时常见）
    $s = $s -replace "[\u200B-\u200D\uFEFF]", ''

    # 去掉内部空白（Token 里不该有空格，如果有说明粘贴串行了）
    $s = $s -replace '\s', ''

    return $s
}

$token = Clean-Value $Token
$account = Clean-Value $AccountId

# ─── 校验 ───
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host '  × Token 为空' -ForegroundColor Red
    exit 1
}

# Cloudflare API Token 长度约 40 字符，User API Token 形如 v1.0-...
if ($token.Length -lt 30) {
    Write-Host ("  ! Token 只有 {0} 个字符，看起来不完整" -f $token.Length) -ForegroundColor Yellow
    Write-Host '    Cloudflare 的 API Token 通常有 40 个字符左右' -ForegroundColor DarkGray
}

# ─── 写入 .env（UTF-8 无 BOM，LF 行尾）───
$lines = @(
    '# Cloudflare 凭据 —— 不要把这个文件分享给别人'
    '# 由 cf-free-max 配置向导生成'
    ''
    "CF_API_TOKEN=$token"
)

if (-not [string]::IsNullOrWhiteSpace($account)) {
    $lines += "CF_ACCOUNT_ID=$account"
}

$text = ($lines -join "`n") + "`n"

# 确保目录存在
$dir = Split-Path -Parent $OutputFile
if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutputFile, $text, $utf8NoBom)

Write-Host '  √ 已保存到 .env' -ForegroundColor Green
Write-Host ("    " + $OutputFile) -ForegroundColor DarkGray

# ─── 立即验证 ───
Write-Host ''
Write-Host '  正在向 Cloudflare 校验 ...' -ForegroundColor Gray
Write-Host ''

try {
    $headers = @{
        'Authorization' = "Bearer $token"
        'Content-Type'  = 'application/json'
    }

    $resp = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' `
        -Headers $headers -TimeoutSec 25 -ErrorAction Stop

    if ($resp.result.status -eq 'active') {
        Write-Host '  √ 凭据有效' -ForegroundColor Green

        # 顺带查一下账号，省得用户还要自己找 Account ID
        try {
            $accts = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/accounts' `
                -Headers $headers -TimeoutSec 25 -ErrorAction Stop

            if ($accts.result.Count -eq 1) {
                Write-Host ("    可见账号：" + $accts.result[0].name) -ForegroundColor DarkGray
                Write-Host ("    账号 ID：" + $accts.result[0].id) -ForegroundColor DarkGray

                if ([string]::IsNullOrWhiteSpace($account)) {
                    Write-Host ''
                    Write-Host '  ! 建议把上面这个账号 ID 也填进去（否则 R2/KV/D1 功能用不了）' -ForegroundColor Yellow
                    Write-Host '    重新选 [7] 配置即可' -ForegroundColor DarkGray
                }
            }
            elseif ($accts.result.Count -gt 1) {
                Write-Host "    可见 $($accts.result.Count) 个账号：" -ForegroundColor DarkGray
                foreach ($a in $accts.result) {
                    Write-Host ("      " + $a.name + "  [" + $a.id + "]") -ForegroundColor DarkGray
                }
                Write-Host ''
                Write-Host '  ! 有多个账号，请在 .env 里指定 CF_ACCOUNT_ID' -ForegroundColor Yellow
            }
            else {
                Show-MissingAccountPermission
            }
        }
        catch {
            Show-MissingAccountPermission
        }

        exit 0
    }
    else {
        Write-Host ("  ! Token 状态是「" + $resp.result.status + "」，不是 active") -ForegroundColor Yellow
        exit 2
    }
}
catch {
    $msg = $_.Exception.Message

    Write-Host '  × 校验失败' -ForegroundColor Red
    Write-Host ''

    if ($msg -match '401|403|10000|6103') {
        Write-Host '    Token 无效或已过期。常见原因：' -ForegroundColor Yellow
        Write-Host '      · 复制时漏了字符（Cloudflare 的 Token 有 40 位左右）' -ForegroundColor DarkGray
        Write-Host '      · Token 创建后没点「Continue to summary」就关了页面' -ForegroundColor DarkGray
        Write-Host '      · Token 已被删除或重新生成' -ForegroundColor DarkGray
    }
    elseif ($msg -match 'Unable to connect|timeout|timed out|远程名称') {
        Write-Host '    连不上 api.cloudflare.com' -ForegroundColor Yellow
        Write-Host '      · 检查网络连接' -ForegroundColor DarkGray
        Write-Host '      · 如果用了代理，设置 HTTPS_PROXY 环境变量后重试' -ForegroundColor DarkGray
    }
    else {
        Write-Host ("    " + $msg) -ForegroundColor DarkGray
    }

    Write-Host ''
    Write-Host '  凭据已保存到 .env，修正后重新运行本工具即可。' -ForegroundColor DarkGray
    exit 3
}
