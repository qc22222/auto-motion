[CmdletBinding()]
param(
    [string]$Python = 'python',
    [string]$EnvironmentPath = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$requirementsPath = Join-Path $PSScriptRoot 'requirements-kokoro.txt'
$target = if ([string]::IsNullOrWhiteSpace($EnvironmentPath)) {
    Join-Path $workspaceRoot '.codex/python-audio'
} else {
    [IO.Path]::GetFullPath($EnvironmentPath)
}
$target = [IO.Path]::GetFullPath($target)
$targetTrimmed = $target.TrimEnd([IO.Path]::DirectorySeparatorChar, '/', '\')
$rootTrimmed = $workspaceRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, '/', '\')
$prefix = $rootTrimmed + [IO.Path]::DirectorySeparatorChar
$isInside = $targetTrimmed -eq $rootTrimmed -or $targetTrimmed.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)

if (-not $isInside) {
    throw "虚拟环境必须位于当前工作区内：$workspaceRoot"
}
if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf)) {
    throw "找不到固定依赖清单：$requirementsPath"
}

$venvPython = Join-Path $target 'Scripts/python.exe'
if (Test-Path -LiteralPath $target) {
    $isVenv = (Test-Path -LiteralPath (Join-Path $target 'pyvenv.cfg') -PathType Leaf) -and
        (Test-Path -LiteralPath $venvPython -PathType Leaf)
    if (-not $isVenv) {
        throw "目标目录已存在但不是可识别的 Python 虚拟环境，拒绝覆盖：$target"
    }
} else {
    & $Python -m venv $target
    if ($LASTEXITCODE -ne 0) {
        throw "创建项目专用 Python 虚拟环境失败：$target"
    }
}

& $venvPython -m pip install --disable-pip-version-check --requirement $requirementsPath
if ($LASTEXITCODE -ne 0) {
    throw '安装 Kokoro 项目依赖失败'
}

& $venvPython -c 'import kokoro_onnx, soundfile; print('kokoro deps import OK')'
if ($LASTEXITCODE -ne 0) {
    throw 'Kokoro 依赖安装完成，但导入验证失败'
}

$normalizedPython = $venvPython.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
Write-Host "项目专用 Kokoro 环境已就绪：$target"
Write-Host '请把下面一行加入视频项目根目录的 .env：'
Write-Host "HYPERFRAMES_PYTHON=$normalizedPython"
