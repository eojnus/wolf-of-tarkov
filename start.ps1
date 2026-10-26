<#
  云港市 · 本地启动脚本
  用法：
    .\start.ps1              # 开发模式（热更新，端口 5173）
    .\start.ps1 -Preview     # 构建后跑构建产物（端口 4173）
    .\start.ps1 -Install     # 强制重新安装依赖
#>
[CmdletBinding()]
param(
    [switch]$Preview,
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Warn($text) { Write-Host "!!  $text" -ForegroundColor Yellow }
function Write-Fail($text) { Write-Host "xx  $text" -ForegroundColor Red }

# ---------------------------------------------------------------- 找 npm.cmd
# 优先用系统 PATH 里的 npm；找不到就回退到 WorkBuddy 托管的那份 Node。
function Find-Npm {
    $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\npm.cmd'
    )
    foreach ($path in $candidates) {
        if (Test-Path -LiteralPath $path) { return $path }
    }

    $glob = Get-ChildItem -Path 'C:\Users\Administrator\.workbuddy\binaries\node\versions' `
        -Filter 'npm.cmd' -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($glob) { return $glob.FullName }

    return $null
}

$npm = Find-Npm
if (-not $npm) {
    Write-Fail '找不到 npm.cmd。'
    Write-Host '   请先安装 Node.js LTS（https://nodejs.org/），或在脚本的 $candidates 里补上你的 npm 路径。'
    exit 1
}

Write-Step "使用 npm：$npm"

# ------------------------------------------------------------ 补齐 node 路径
# npm run 会启动 node_modules\.bin\*.cmd 这类包装脚本，它们内部直接调用 `node`。
# 本机 PATH 里没有 node 目录时，这些子进程会报「'node' 不是内部或外部命令」，
# 所以必须把 node.exe 所在目录补进当前会话的 PATH（只影响本窗口，不改系统设置）。
$nodeDir = Split-Path -Parent $npm
$nodeExe = Join-Path $nodeDir 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $nodeExe = $nodeCmd.Source
        $nodeDir = Split-Path -Parent $nodeExe
    }
}

if (Test-Path -LiteralPath $nodeExe) {
    $rest = $env:Path -split ';' | Where-Object { $_ -and ($_ -ne $nodeDir) }
    $env:Path = (@($nodeDir) + $rest) -join ';'
    $nodeVersion = ((& $nodeExe -v) 2>&1) -replace '^v', ''
    Write-Step "使用 node：$nodeExe（v$nodeVersion）"
} else {
    Write-Warn '没找到 node.exe，继续尝试，但 npm 子命令可能会失败。'
}

# ---------------------------------------------------------------- 依赖检查
$needInstall = $Install -or -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))
if ($needInstall) {
    Write-Step '安装依赖（首次运行或手动指定，可能需要一两分钟）…'
    & $npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Write-Fail '依赖安装失败，请检查网络或代理设置。'
        exit $LASTEXITCODE
    }
}

# ---------------------------------------------------------------- 启动
if ($Preview) {
    Write-Step '构建生产产物…'
    & $npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Fail '构建失败。'
        exit $LASTEXITCODE
    }
    Write-Host ''
    Write-Host '  地址：http://localhost:4173/' -ForegroundColor Green
    Write-Host '  停止：Ctrl + C' -ForegroundColor DarkGray
    Write-Host ''
    & $npm run preview
} else {
    Write-Host ''
    Write-Host '  地址：http://localhost:5173/' -ForegroundColor Green
    Write-Host '  提示：用 Chrome / Edge 独立窗口打开，不要用 IDE 内嵌预览（会拦掉鼠标锁定）' -ForegroundColor DarkGray
    Write-Host '  停止：Ctrl + C' -ForegroundColor DarkGray
    Write-Host ''
    & $npm run dev
}

if ($LASTEXITCODE -ne 0) {
    Write-Fail "命令以退出码 $LASTEXITCODE 结束。"
    Write-Warn '如果提示端口被占用，可改用：.\start.ps1 后手动执行 npm run dev -- --port 5174'
    exit $LASTEXITCODE
}
