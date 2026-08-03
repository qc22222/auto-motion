[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$HarnessArguments
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$entry = Join-Path $projectRoot 'video-harness/bin/video-harness.mjs'

if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "未找到项目本地 Video Harness 入口：$entry"
}

$env:VIDEO_HARNESS_WORKSPACE = $projectRoot
& node $entry @HarnessArguments
exit $LASTEXITCODE
