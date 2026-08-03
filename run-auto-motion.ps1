[CmdletBinding()]
param(
    [ValidateSet("env", "test", "run")]
    [string]$Action = "env"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path $PSScriptRoot).Path
$LocalTools = Join-Path $ProjectRoot "tools"
$NpmBin = Join-Path $env:APPDATA "npm"
$HyperframesLauncher = Join-Path $LocalTools "hyperframes-local.ps1"

$GitBashCandidates = @(
    "D:\git\Git\bin\bash.exe",
    "C:\Program Files\Git\bin\bash.exe"
)
$GitBash = $GitBashCandidates |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1

if (-not $GitBash) {
    throw "未找到 Git Bash。请安装 Git for Windows，或修改脚本中的 Git Bash 路径。"
}

# 只为本次子进程注入 PATH，不修改系统或用户级环境变量。
$env:Path = @($LocalTools, $NpmBin, $env:Path) -join [IO.Path]::PathSeparator

function Convert-ToGitBashPath {
    param([string]$WindowsPath)

    $drive = $WindowsPath.Substring(0, 1).ToLowerInvariant()
    $rest = $WindowsPath.Substring(2) -replace '\\', '/'
    return "/$drive$rest"
}

function Invoke-GitBashProjectCommand {
    param([Parameter(Mandatory)][string]$Command)

    $BashRoot = Convert-ToGitBashPath $ProjectRoot
    $BashTools = "$BashRoot/tools"
    $BashNpmBin = Convert-ToGitBashPath $NpmBin
    $BashPath = "${BashTools}:${BashNpmBin}:`$PATH"
    $BashNpmCache = "$BashRoot/.codex/npm-cache"
    $BashPuppeteerCache = "$BashRoot/.codex/puppeteer-cache"
    $FullCommand = "cd '$BashRoot' && export PATH='$BashPath' && export HYPERFRAMES_LOCAL_ROOT='$BashRoot' && export HYPERFRAMES_SKIP_SKILLS='1' && export npm_config_cache='$BashNpmCache' && export PUPPETEER_CACHE_DIR='$BashPuppeteerCache' && $Command"
    & $GitBash -c $FullCommand
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

switch ($Action) {
    "env" {
        Write-Output "项目目录：$ProjectRoot"
        Write-Output "Git Bash：$GitBash"
        Write-Output "本地 jq：$LocalTools\jq.exe"
        & (Join-Path $LocalTools "jq.exe") --version
        node --version
        ffmpeg -version | Select-Object -First 1
        ffprobe -version | Select-Object -First 1
        codex --version
        claude --version
        & $HyperframesLauncher env
    }
    "test" {
        Invoke-GitBashProjectCommand "bash auto-test/run.sh"
    }
    "run" {
        Invoke-GitBashProjectCommand "codex exec --cd . --sandbox danger-full-access --ask-for-approval never - < PROMPT.md"
    }
}
