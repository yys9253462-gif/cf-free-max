# ═══════════════════════════════════════════════════════════════════════════
#  check-font.ps1 — 检测控制台字体能否显示中文
#
#  为什么单独一个 .ps1：
#    原来想内嵌在 .bat 的 for /f 命令里，结果引号转义炸了 ——
#    批处理的 '' 双写引号在 for /f 的单引号命令里不成立，
#    PowerShell 收到一堆坏引号，直接语法错误。
#
#    （这已经是同一个坑的第 N 次了：.bat 里不要内嵌复杂 PowerShell。）
#
#  退出码：
#    0 = 字体没问题（或检测不出来）
#    1 = 字体没有中文字形
#
#  用法（由 .bat 调用）：
#    powershell -File check-font.ps1
#    if errorlevel 1 call :warn_font
# ═══════════════════════════════════════════════════════════════════════════

$ErrorActionPreference = 'SilentlyContinue'

# Windows Terminal 自带 CJK 字体回退，不用检查
if ($env:WT_SESSION) { exit 0 }

# 已知「没有中文字形」的字体
$noCjk = @(
    'Lucida Console'
    'Lucida Sans Typewriter'
    'Courier New'
    'Terminal'
    'Raster Fonts'
    'Small Fonts'
    'Fixedsys'
    'Consolas'
)

# 已知「有中文字形」的字体
$hasCjk = @(
    '新宋体', 'NSimSun', 'SimSun', '宋体',
    'SimHei', '黑体',
    'Microsoft YaHei', '微软雅黑',
    'DengXian', '等线'
)

function Get-ConsoleFace {
    # ⚠️ 注册表里的键名含**字面量** %SystemRoot%（不展开）。
    #    实测踩过：用 [Environment]::ExpandEnvironmentVariables 展开后
    #    路径变成 HKCU:\Console\C:\WINDOWS_...，那个键根本不存在，
    #    于是永远读不到字体设置。
    #
    #    正确做法：直接用字面量字符串拼键名。

    $candidates = @(
        'HKCU:\Console\%SystemRoot%_System32_WindowsPowerShell_v1.0_powershell.exe'
        'HKCU:\Console\%SystemRoot%_System32_cmd.exe'
    )

    foreach ($key in $candidates) {
        # 注意：这里**不做**环境变量展开
        $face = (Get-ItemProperty -Path $key -Name FaceName -ErrorAction SilentlyContinue).FaceName
        if ($face) { return $face }
    }

    # 最后看根键 —— 但 __DefaultTTFont__ 是占位符，不是真实字体名
    $rootFace = (Get-ItemProperty -Path 'HKCU:\Console' -Name FaceName -ErrorAction SilentlyContinue).FaceName
    if ($rootFace -and $rootFace -notlike '*__DefaultTTFont__*') {
        return $rootFace
    }

    return $null
}

$face = Get-ConsoleFace

# 查不到 → 用系统默认，通常没问题
if (-not $face) { exit 0 }

# 明确支持中文
foreach ($f in $hasCjk) {
    if ($face -like "*$f*") { exit 0 }
}

# 明确不支持
foreach ($f in $noCjk) {
    if ($face -like "*$f*") {
        # 输出字体名，供 .bat 显示
        Write-Output $face
        exit 1
    }
}

# 未知字体 —— 不阻断（可能是用户自己装的带 CJK 的回退字体）
exit 0
