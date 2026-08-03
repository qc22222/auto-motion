[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$HyperframesArguments
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$script:DefaultVersion = '0.7.88'
$script:ConfigFileName = '.hyperframes-local.json'
$script:ScriptPath = $MyInvocation.MyCommand.Path
$script:FinalExitCode = 0
$script:Resolutions = @{
    landscape      = @{ Width = 1920; Height = 1080 }
    portrait       = @{ Width = 1080; Height = 1920 }
    'landscape-4k' = @{ Width = 3840; Height = 2160 }
    'portrait-4k'  = @{ Width = 2160; Height = 3840 }
    square         = @{ Width = 1080; Height = 1080 }
    'square-4k'    = @{ Width = 2160; Height = 2160 }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 10
    Write-Utf8NoBom -Path $Path -Content ($json + "`n")
}

function Get-AncestorDirectories {
    param([Parameter(Mandatory = $true)][string]$StartPath)

    $current = [IO.Path]::GetFullPath($StartPath)
    while ($true) {
        $current
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) {
            break
        }
        $current = $parent.FullName
    }
}

function Test-LocalRoot {
    param([AllowNull()][string]$Candidate)

    if ([string]::IsNullOrWhiteSpace($Candidate)) {
        return $false
    }

    try {
        $fullPath = [IO.Path]::GetFullPath($Candidate)
    } catch {
        return $false
    }

    return (
        (Test-Path -LiteralPath (Join-Path $fullPath 'exampleFolder/.claude/skills') -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $fullPath 'exampleFolder/hyperframes-local.ps1') -PathType Leaf)
    )
}

function Read-RootFromLocalConfig {
    param([Parameter(Mandatory = $true)][string]$StartPath)

    foreach ($directory in Get-AncestorDirectories -StartPath $StartPath) {
        $configPath = Join-Path $directory $script:ConfigFileName
        if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
            continue
        }

        try {
            $config = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
            if ($null -ne $config.localRoot -and (Test-LocalRoot -Candidate ([string]$config.localRoot))) {
                return [IO.Path]::GetFullPath([string]$config.localRoot)
            }
        } catch {
            # 配置损坏时继续从目录层级定位，最终仍会返回明确错误。
        }
    }

    return $null
}

function Find-LocalRoot {
    if (Test-LocalRoot -Candidate $env:HYPERFRAMES_LOCAL_ROOT) {
        return [IO.Path]::GetFullPath($env:HYPERFRAMES_LOCAL_ROOT)
    }

    foreach ($startPath in @((Get-Location).Path, $PSScriptRoot)) {
        $configuredRoot = Read-RootFromLocalConfig -StartPath $startPath
        if ($null -ne $configuredRoot) {
            return $configuredRoot
        }

        foreach ($directory in Get-AncestorDirectories -StartPath $startPath) {
            if (Test-LocalRoot -Candidate $directory) {
                return [IO.Path]::GetFullPath($directory)
            }
        }
    }

    throw '无法定位项目本地 HyperFrames 环境。请设置 HYPERFRAMES_LOCAL_ROOT，并确保它指向当前视频制作项目。'
}

function Set-LocalRuntimeEnvironment {
    param([Parameter(Mandatory = $true)][string]$LocalRoot)

    $npmCache = Join-Path $LocalRoot '.codex/npm-cache'
    $puppeteerCache = Join-Path $LocalRoot '.codex/puppeteer-cache'
    $runtimeCache = Join-Path $LocalRoot '.codex/hyperframes-cache'
    $extractCache = Join-Path $runtimeCache 'extract'
    $fontCache = Join-Path $runtimeCache 'fonts'

    foreach ($directory in @($npmCache, $puppeteerCache, $extractCache, $fontCache)) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }
    }

    $env:HYPERFRAMES_LOCAL_ROOT = $LocalRoot
    $env:HYPERFRAMES_SKIP_SKILLS = '1'
    $env:npm_config_cache = $npmCache
    $env:npm_config_update_notifier = 'false'
    $env:npm_config_fund = 'false'
    $env:npm_config_audit = 'false'
    $env:PUPPETEER_CACHE_DIR = $puppeteerCache
    $env:HYPERFRAMES_EXTRACT_CACHE_DIR = $extractCache
    $env:HYPERFRAMES_FONT_CACHE_DIR = $fontCache
}

function Find-CachedHyperframes {
    param(
        [Parameter(Mandatory = $true)][string]$LocalRoot,
        [Parameter(Mandatory = $true)][string]$Version
    )

    $npxRoot = Join-Path $LocalRoot '.codex/npm-cache/_npx'
    if (-not (Test-Path -LiteralPath $npxRoot -PathType Container)) {
        return $null
    }

    $candidates = @()
    foreach ($entry in Get-ChildItem -LiteralPath $npxRoot -Directory -ErrorAction SilentlyContinue) {
        $packageRoot = Join-Path $entry.FullName 'node_modules/hyperframes'
        $packageJsonPath = Join-Path $packageRoot 'package.json'
        $cliPath = Join-Path $packageRoot 'bin/hyperframes.mjs'
        $blankTemplatePath = Join-Path $packageRoot 'dist/templates/blank'

        if (
            -not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $cliPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $blankTemplatePath -PathType Container)
        ) {
            continue
        }

        try {
            $packageJson = [IO.File]::ReadAllText($packageJsonPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
            if ([string]$packageJson.version -ne $Version) {
                continue
            }

            $candidates += [PSCustomObject]@{
                Version           = [string]$packageJson.version
                PackageRoot       = $packageRoot
                CliPath           = $cliPath
                BlankTemplatePath = $blankTemplatePath
                ModifiedAt        = (Get-Item -LiteralPath $packageJsonPath).LastWriteTimeUtc
            }
        } catch {
            # 忽略不完整或损坏的 npm 缓存项。
        }
    }

    return $candidates | Sort-Object ModifiedAt -Descending | Select-Object -First 1
}

function Ensure-CachedHyperframes {
    param(
        [Parameter(Mandatory = $true)][string]$LocalRoot,
        [Parameter(Mandatory = $true)][string]$Version
    )

    $cached = Find-CachedHyperframes -LocalRoot $LocalRoot -Version $Version
    if ($null -ne $cached) {
        return $cached
    }

    Set-LocalRuntimeEnvironment -LocalRoot $LocalRoot
    $npx = Get-Command 'npx.cmd' -ErrorAction SilentlyContinue
    if ($null -eq $npx) {
        throw "项目本地缓存中没有 HyperFrames $Version，且系统中未找到 npx.cmd，无法下载到项目缓存。"
    }

    Push-Location -LiteralPath $LocalRoot
    try {
        & $npx.Source --yes "hyperframes@$Version" --version | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "无法把 HyperFrames $Version 下载到项目本地缓存。"
        }
    } finally {
        Pop-Location
    }

    $cached = Find-CachedHyperframes -LocalRoot $LocalRoot -Version $Version
    if ($null -eq $cached) {
        throw "HyperFrames $Version 下载完成，但未在项目本地 npm 缓存中找到。"
    }

    return $cached
}

function Get-InitOptions {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    if ($Arguments.Count -lt 1 -or $Arguments[0].StartsWith('--')) {
        throw '安全初始化需要目标目录，例如：powershell.exe -File ./hyperframes-local.ps1 init videos/scene-001 --resolution=portrait'
    }

    $values = [ordered]@{
        Target     = $Arguments[0]
        Example    = 'blank'
        Resolution = 'landscape'
        Skill      = 'general-video'
        Duration   = '10'
    }

    for ($index = 1; $index -lt $Arguments.Count; $index++) {
        $argument = $Arguments[$index]
        $name = $null
        $value = $null

        if ($argument -match '^--(?<name>[a-z-]+)=(?<value>.*)$') {
            $name = $Matches.name
            $value = $Matches.value
        } elseif ($argument -match '^--(?<name>[a-z-]+)$') {
            $name = $Matches.name
            if ($index + 1 -ge $Arguments.Count -or $Arguments[$index + 1].StartsWith('--')) {
                throw "$argument 缺少参数值。"
            }
            $index++
            $value = $Arguments[$index]
        } else {
            throw "无法识别的初始化参数：$argument"
        }

        switch ($name) {
            'example'    { $values.Example = $value }
            'resolution' { $values.Resolution = $value }
            'skill'      { $values.Skill = $value }
            'duration'   { $values.Duration = $value }
            default      { throw "不支持的初始化选项：--$name" }
        }
    }

    if ($values.Example -ne 'blank') {
        throw '当前安全初始化只支持官方 blank 模板，以避开存在路径编码问题的原生 init 流程。'
    }
    if (-not $script:Resolutions.ContainsKey([string]$values.Resolution)) {
        throw "不支持的分辨率预设：$($values.Resolution)"
    }
    if ([string]$values.Skill -cnotmatch '^[a-z0-9][a-z0-9-]*$') {
        throw "无效的 skill 标识：$($values.Skill)"
    }

    $durationValue = 0.0
    $durationValid = [double]::TryParse(
        [string]$values.Duration,
        [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$durationValue
    )
    if (-not $durationValid -or $durationValue -le 0) {
        throw "无效的时长：$($values.Duration)"
    }

    return [PSCustomObject]@{
        Target       = [string]$values.Target
        Example      = [string]$values.Example
        Resolution   = [string]$values.Resolution
        Skill        = [string]$values.Skill
        DurationText = $durationValue.ToString('0.################', [Globalization.CultureInfo]::InvariantCulture)
    }
}

function Get-SafeTargetPath {
    param([Parameter(Mandatory = $true)][string]$Target)

    if ([IO.Path]::IsPathRooted($Target)) {
        $targetPath = [IO.Path]::GetFullPath($Target)
    } else {
        $targetPath = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Target))
    }

    $rootPath = [IO.Path]::GetPathRoot($targetPath)
    if ($targetPath.TrimEnd('\', '/') -eq $rootPath.TrimEnd('\', '/')) {
        throw "拒绝把磁盘根目录作为工程目标：$targetPath"
    }

    return $targetPath
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $Destination $item.Name) -Recurse -Force
    }
}

function Patch-BlankHtml {
    param(
        [Parameter(Mandatory = $true)][string]$Html,
        [Parameter(Mandatory = $true)][int]$Width,
        [Parameter(Mandatory = $true)][int]$Height,
        [Parameter(Mandatory = $true)][string]$Duration,
        [Parameter(Mandatory = $true)][string]$Resolution
    )

    $options = [Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [Text.RegularExpressions.RegexOptions]::Singleline
    $html = ([regex]::new('<video\b(?=[^>]*\bsrc\s*=\s*["'']__VIDEO_SRC__["''])[^>]*>.*?</video>', $options)).Replace($Html, '')
    $html = ([regex]::new('<audio\b(?=[^>]*\bsrc\s*=\s*["'']__VIDEO_SRC__["''])[^>]*>.*?</audio>', $options)).Replace($html, '')
    $html = ([regex]::new('<video\b(?=[^>]*\bsrc\s*=\s*["'']__VIDEO_SRC__["''])[^>]*/?>', $options)).Replace($html, '')
    $html = ([regex]::new('<audio\b(?=[^>]*\bsrc\s*=\s*["'']__VIDEO_SRC__["''])[^>]*/?>', $options)).Replace($html, '')
    $html = $html.Replace('__VIDEO_DURATION__', $Duration)
    $html = ([regex]::new('data-width=["'']\d+["'']', $options)).Replace($html, 'data-width="' + $Width + '"')
    $html = ([regex]::new('data-height=["'']\d+["'']', $options)).Replace($html, 'data-height="' + $Height + '"')
    $html = ([regex]::new('(<meta[^>]*name=["'']viewport["''][^>]*content=["''])width=\d+,\s*height=\d+', $options)).Replace($html, '${1}width=' + $Width + ', height=' + $Height)
    $html = ([regex]::new('(html\s*,\s*body\s*\{[^}]*?width:\s*)\d+px([^}]*?height:\s*)\d+px', $options)).Replace($html, '${1}' + $Width + 'px${2}' + $Height + 'px')

    $resolutionAttribute = [regex]::new('(<html\b[^>]*\bdata-resolution=["''])[^"'']*(["''])', $options)
    if ($resolutionAttribute.IsMatch($html)) {
        $html = $resolutionAttribute.Replace($html, '${1}' + $Resolution + '${2}', 1)
    } else {
        $html = ([regex]::new('<html\b([^>]*)>', $options)).Replace($html, '<html${1} data-resolution="' + $Resolution + '">', 1)
    }

    return $html
}

function Get-PackageName {
    param([Parameter(Mandatory = $true)][string]$ProjectName)

    $packageName = ($ProjectName.ToLowerInvariant() -replace '[^a-z0-9._~-]+', '-').Trim('-')
    if ([string]::IsNullOrWhiteSpace($packageName)) {
        return 'hyperframes-project'
    }
    return $packageName
}

function Write-LocalInstructions {
    param([Parameter(Mandatory = $true)][string]$TargetPath)

    $content = @'
# HyperFrames 项目本地安全入口

本工程位于 Windows 中文路径中，禁止直接执行 `npx hyperframes init`。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 lint
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 render --quality high --output renders/final.mp4
```

该入口固定使用视频制作项目内的 npm、浏览器和运行时缓存，并设置 `HYPERFRAMES_SKIP_SKILLS=1`。`skills` 命令已被阻止，不会安装或更新用户级、全局技能。
'@
    Write-Utf8NoBom -Path (Join-Path $TargetPath '本地运行说明.md') -Content $content
}

function Invoke-SafeInit {
    param(
        [Parameter(Mandatory = $true)]$Options,
        [Parameter(Mandatory = $true)][string]$LocalRoot,
        [Parameter(Mandatory = $true)]$Cached
    )

    $targetPath = Get-SafeTargetPath -Target $Options.Target
    $targetCreatedByScript = $false

    if (Test-Path -LiteralPath $targetPath) {
        if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) {
            throw "目标已存在且不是目录：$targetPath"
        }
        if (@(Get-ChildItem -LiteralPath $targetPath -Force).Count -gt 0) {
            throw "目标目录已存在且非空，拒绝覆盖：$targetPath"
        }
    } else {
        New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
        $targetCreatedByScript = $true
    }

    try {
        Copy-DirectoryContents -Source $Cached.BlankTemplatePath -Destination $targetPath
        $dimensions = $script:Resolutions[$Options.Resolution]
        $indexPath = Join-Path $targetPath 'index.html'
        $html = [IO.File]::ReadAllText($indexPath, [Text.Encoding]::UTF8)
        $patchedHtml = Patch-BlankHtml -Html $html -Width $dimensions.Width -Height $dimensions.Height -Duration $Options.DurationText -Resolution $Options.Resolution
        Write-Utf8NoBom -Path $indexPath -Content $patchedHtml

        $projectName = Split-Path -Leaf $targetPath
        $createdAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        Write-JsonFile -Path (Join-Path $targetPath 'meta.json') -Value ([ordered]@{
            id = $projectName; name = $projectName; createdAt = $createdAt
        })
        Write-JsonFile -Path (Join-Path $targetPath 'hyperframes.json') -Value ([ordered]@{
            '$schema' = 'https://hyperframes.heygen.com/schema/hyperframes.json'
            registry = 'https://hyperframes.heygen.com/registry'
            paths = [ordered]@{ blocks = 'compositions'; components = 'compositions/components'; assets = 'assets' }
            media = [ordered]@{ autoProxy = $true }
            authoringSkill = $Options.Skill
        })
        Write-JsonFile -Path (Join-Path $targetPath 'package.json') -Value ([ordered]@{
            name = Get-PackageName -ProjectName $projectName
            private = $true
            type = 'module'
            scripts = [ordered]@{
                dev = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 preview'
                check = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 check'
                render = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 render'
            }
        })

        $normalizedRoot = $LocalRoot.Replace('\', '/')
        Write-JsonFile -Path (Join-Path $targetPath $script:ConfigFileName) -Value ([ordered]@{
            localRoot = $normalizedRoot; cliVersion = $Cached.Version
        })
        Write-Utf8NoBom -Path (Join-Path $targetPath '.npmrc') -Content ("cache=$normalizedRoot/.codex/npm-cache`nupdate-notifier=false`nfund=false`naudit=false`n")

        foreach ($instructionName in @('AGENTS.md', 'CLAUDE.md')) {
            $instructionSource = Join-Path $LocalRoot ("exampleFolder/" + $instructionName)
            if (Test-Path -LiteralPath $instructionSource -PathType Leaf) {
                Copy-Item -LiteralPath $instructionSource -Destination (Join-Path $targetPath $instructionName) -Force
            }
        }

        Copy-Item -LiteralPath $script:ScriptPath -Destination (Join-Path $targetPath 'hyperframes-local.ps1') -Force
        Write-LocalInstructions -TargetPath $targetPath

        Write-Host "安全初始化完成：$targetPath"
        Write-Host "规格：$($dimensions.Width)x$($dimensions.Height)，$($Options.DurationText) 秒"
        Write-Host "HyperFrames：$($Cached.Version)（项目本地缓存）"
    } catch {
        if ($targetCreatedByScript -and (Test-Path -LiteralPath $targetPath -PathType Container)) {
            $rootPath = [IO.Path]::GetPathRoot($targetPath)
            if ($targetPath.TrimEnd('\', '/') -ne $rootPath.TrimEnd('\', '/')) {
                Remove-Item -LiteralPath $targetPath -Recurse -Force
            }
        }
        throw
    }
}

function Show-Usage {
    Write-Host @'
HyperFrames 项目本地安全入口

用法：
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 env
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 init <目录> --resolution=portrait --skill=general-video --duration=10
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 lint
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 check
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./hyperframes-local.ps1 render --quality high --output renders/final.mp4

限制：
  - init 固定复制官方 blank 模板，不调用存在中文路径编码问题的原生 init。
  - skills 命令被阻止，技能只允许维护在当前视频制作项目内。
'@
}

function Invoke-CachedCli {
    param(
        [Parameter(Mandatory = $true)][string[]]$CommandArguments,
        [Parameter(Mandatory = $true)][string]$LocalRoot,
        [Parameter(Mandatory = $true)]$Cached
    )

    Set-LocalRuntimeEnvironment -LocalRoot $LocalRoot
    & node $Cached.CliPath @CommandArguments
    $script:FinalExitCode = $LASTEXITCODE
}

function Invoke-Main {
    param([AllowEmptyCollection()][string[]]$CommandArguments)

    if ($null -eq $CommandArguments -or $CommandArguments.Count -eq 0 -or $CommandArguments[0] -in @('--help', 'help')) {
        Show-Usage
        return
    }
    if ($CommandArguments[0] -eq 'skills') {
        throw '已阻止 HyperFrames skills 命令：本项目技能固定在 exampleFolder/.claude/skills，不允许写入用户级或全局目录。'
    }

    $localRoot = Find-LocalRoot
    Set-LocalRuntimeEnvironment -LocalRoot $localRoot
    $version = if ([string]::IsNullOrWhiteSpace($env:HYPERFRAMES_VERSION)) { $script:DefaultVersion } else { $env:HYPERFRAMES_VERSION }
    $cached = Ensure-CachedHyperframes -LocalRoot $localRoot -Version $version

    switch ($CommandArguments[0]) {
        'env' {
            Write-Host "项目本地根目录：$localRoot"
            Write-Host "项目本地 npm 缓存：$(Join-Path $localRoot '.codex/npm-cache')"
            Write-Host "项目本地浏览器缓存：$(Join-Path $localRoot '.codex/puppeteer-cache')"
            Write-Host "HyperFrames：$($cached.Version)"
            Write-Host "CLI：$($cached.CliPath)"
            Write-Host '技能更新：已禁用（HYPERFRAMES_SKIP_SKILLS=1）'
        }
        'init' {
            $remaining = @()
            if ($CommandArguments.Count -gt 1) {
                $remaining = @($CommandArguments[1..($CommandArguments.Count - 1)])
            }
            $options = Get-InitOptions -Arguments $remaining
            Invoke-SafeInit -Options $options -LocalRoot $localRoot -Cached $cached
        }
        default {
            Invoke-CachedCli -CommandArguments $CommandArguments -LocalRoot $localRoot -Cached $cached
        }
    }
}

try {
    Invoke-Main -CommandArguments $HyperframesArguments
} catch {
    [Console]::Error.WriteLine("错误：$($_.Exception.Message)")
    $script:FinalExitCode = 1
}

exit $script:FinalExitCode
