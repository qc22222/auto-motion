[CmdletBinding()]
# Windows PowerShell 5.1 对无 BOM UTF-8 脚本兼容有限，因此可执行字符串保持 ASCII。
param(
  [switch]$SkipDependencies,
  [switch]$SkipModels,
  [switch]$SkipAlignment,
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$sourceRoot = Join-Path $workspaceRoot ".codex/runtime/indextts2"
$pythonPath = Join-Path $sourceRoot ".venv/Scripts/python.exe"
# sentencepiece / whisper-cli use ANSI file APIs; model files must live on ASCII-only paths.
$modelRoot = "E:/models/indextts2"
$uvCache = Join-Path $sourceRoot ".codex/uv-cache"
$downloader = Join-Path $PSScriptRoot "download-indextts2-model.py"
$alignmentSetup = Join-Path $PSScriptRoot "setup-whisper-alignment.py"
$whisperRuntime = Join-Path $workspaceRoot ".codex/runtime/whisper/v1.8.6"
$whisperModel = "E:/models/hyperframes-home/.cache/hyperframes/whisper/models/ggml-small.bin"
$env:PYTHONPATH = "$sourceRoot;$sourceRoot/.venv/Lib/site-packages"

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot "pyproject.toml") -PathType Leaf)) {
  throw "Pinned IndexTTS2 source was not found: $sourceRoot"
}

$sourceCommit = (& git -C $sourceRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "Cannot read the IndexTTS2 source revision" }
if ($sourceCommit -ne "13495845e3028f0bb6ca1462ad22aa0e76349e40") {
  throw "Unexpected IndexTTS2 source revision: $sourceCommit"
}

if (-not $SkipDependencies -and -not $VerifyOnly) {
  $env:UV_CACHE_DIR = $uvCache
  & uv sync --frozen --no-dev --python "C:/Python311/python.exe" --no-progress --directory $sourceRoot
  if ($LASTEXITCODE -ne 0) { throw "IndexTTS2 dependency installation failed" }
}
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
  throw "IndexTTS2 project Python was not found: $pythonPath"
}

if (-not $SkipModels) {
  $downloadArgs = @($downloader, "--target", $modelRoot)
  if ($VerifyOnly) { $downloadArgs += "--verify-only" }
  & $pythonPath -S @downloadArgs
  if ($LASTEXITCODE -ne 0) { throw "IndexTTS2 minimal model download or verification failed" }
}

if (-not $SkipAlignment) {
  $alignmentArgs = @($alignmentSetup, "--runtime", $whisperRuntime, "--model", $whisperModel)
  if ($VerifyOnly) { $alignmentArgs += "--verify-only" }
  & "C:/Python311/python.exe" @alignmentArgs
  if ($LASTEXITCODE -ne 0) { throw "Whisper alignment setup or verification failed" }
}

$gpuCheck = 'import torch,torchaudio,indextts; assert torch.cuda.is_available(); print(torch.__version__); print(torchaudio.__version__); print(torch.cuda.get_device_name(0)); print(torch.version.cuda)'
& $pythonPath -S -c $gpuCheck
if ($LASTEXITCODE -ne 0) { throw "IndexTTS2 CUDA preflight failed; CPU fallback is disabled" }

& $pythonPath -S -m indextts.cli_v2 check --model-dir $modelRoot --device cuda:0
if ($LASTEXITCODE -ne 0) { throw "IndexTTS2 official CLI preflight failed" }

Write-Output "IndexTTS2 is ready:"
Write-Output "  source: $sourceRoot"
Write-Output "  python: $pythonPath"
Write-Output "  model: $modelRoot"
Write-Output "  policy: cuda:0 FP16 inference only; no training; no CPU fallback"
