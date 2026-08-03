[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Get-MojibakeDirectories {
    param([Parameter(Mandatory = $true)][string]$DriveRoot)

    return @(
        Get-ChildItem -LiteralPath $DriveRoot -Directory -Force |
            Where-Object { $_.Name.StartsWith('鑷', [StringComparison]::Ordinal) } |
            Select-Object -ExpandProperty Name |
            Sort-Object
    )
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcher = Join-Path $projectRoot 'tools/hyperframes-local.ps1'
$scratchRoot = Join-Path $projectRoot '.codex/test-temp'
$target = Join-Path $scratchRoot ('中文路径安全初始化-' + [Guid]::NewGuid().ToString('N'))
$driveRoot = [IO.Path]::GetPathRoot($projectRoot)
$before = @(Get-MojibakeDirectories -DriveRoot $driveRoot)

New-Item -ItemType Directory -Path $scratchRoot -Force | Out-Null

try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher `
        init $target `
        '--example=blank' `
        '--resolution=portrait' `
        '--skill=general-video' `
        '--duration=3'
    Assert-True -Condition ($LASTEXITCODE -eq 0) -Message "中文路径初始化失败，退出码：$LASTEXITCODE"

    foreach ($requiredFile in @(
        'index.html',
        'meta.json',
        'hyperframes.json',
        'package.json',
        '.hyperframes-local.json',
        '.npmrc',
        'hyperframes-local.ps1',
        'AGENTS.md',
        'CLAUDE.md',
        '本地运行说明.md'
    )) {
        Assert-True `
            -Condition (Test-Path -LiteralPath (Join-Path $target $requiredFile) -PathType Leaf) `
            -Message "初始化后缺少文件：$requiredFile"
    }

    $html = [IO.File]::ReadAllText((Join-Path $target 'index.html'), [Text.Encoding]::UTF8)
    Assert-True -Condition ($html -match 'data-resolution="portrait"') -Message '未写入 portrait 分辨率标记。'
    Assert-True -Condition ($html -match 'data-width="1080"') -Message '未写入 1080 宽度。'
    Assert-True -Condition ($html -match 'data-height="1920"') -Message '未写入 1920 高度。'
    Assert-True -Condition ($html -match 'data-duration="3"') -Message '未写入 3 秒时长。'
    Assert-True -Condition ($html -notmatch '__VIDEO_SRC__|__VIDEO_DURATION__|<video\b|<audio\b') -Message '官方模板媒体占位符未清理干净。'

    $configText = [IO.File]::ReadAllText((Join-Path $target '.hyperframes-local.json'), [Text.Encoding]::UTF8)
    $localConfig = $configText | ConvertFrom-Json
    Assert-True `
        -Condition ([string]$localConfig.localRoot -eq $projectRoot.Replace('\', '/')) `
        -Message '生成工程未绑定到当前项目本地缓存。'

    Push-Location -LiteralPath $target
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\hyperframes-local.ps1' lint
        Assert-True -Condition ($LASTEXITCODE -eq 0) -Message "中文路径下 lint 失败，退出码：$LASTEXITCODE"

        $previousErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $skillsOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\hyperframes-local.ps1' skills 2>&1
            $skillsExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorAction
        }
        Assert-True -Condition ($skillsExitCode -ne 0) -Message 'skills 命令未被阻止。'
        Assert-True -Condition (($skillsOutput | Out-String) -match '已阻止 HyperFrames skills') -Message 'skills 阻止提示不明确。'
    } finally {
        Pop-Location
    }

    $after = @(Get-MojibakeDirectories -DriveRoot $driveRoot)
    Assert-True `
        -Condition (($before -join "`n") -ceq ($after -join "`n")) `
        -Message '测试后磁盘根目录出现新的乱码影子目录。'

    Write-Host 'HyperFrames 中文路径安全入口测试通过。'
} finally {
    if (Test-Path -LiteralPath $target -PathType Container) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}
