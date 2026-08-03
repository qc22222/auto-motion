[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$HyperframesArguments
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcher = Join-Path $projectRoot 'exampleFolder/hyperframes-local.ps1'

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "未找到项目本地 HyperFrames 安全入口：$launcher"
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher @HyperframesArguments
exit $LASTEXITCODE
