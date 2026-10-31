# Package the Electron app together with engine.exe / ffmpeg / model.
# Prereq (run once):
#   & scripts/build-engine.ps1 -Python <venv-python>
#   & scripts/fetch-ffmpeg.ps1
#   models/small/model.bin must exist
# Usage:
#   & scripts/build-app.ps1            # unpacked dir  -> release/win-unpacked
#   & scripts/build-app.ps1 -Target nsis   # installer    -> release/*.exe
param(
  [ValidateSet('dir', 'nsis')]
  [string]$Target = 'dir'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root 'app'

if (-not (Test-Path (Join-Path $root 'build\engine-dist\engine\engine.exe'))) { throw "engine.exe missing. Run scripts/build-engine.ps1 first." }
if (-not (Test-Path (Join-Path $root 'bin\ffmpeg.exe'))) { throw "bin/ffmpeg.exe missing. Run scripts/fetch-ffmpeg.ps1 first." }
if (-not (Test-Path (Join-Path $root 'models\small\model.bin'))) { throw "models/small/model.bin missing." }

$env:ELECTRON_RUN_AS_NODE = $null
if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) { $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/' }
Set-Location $appDir
$eb = Join-Path $appDir 'node_modules\.bin\electron-builder.cmd'
if ($Target -eq 'dir') {
  & $eb --win --dir
} else {
  & $eb --win nsis
}
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed ($LASTEXITCODE)" }
Write-Output "OK ($Target). Output under release/"
