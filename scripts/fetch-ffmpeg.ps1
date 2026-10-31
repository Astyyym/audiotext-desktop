# Download LGPL ffmpeg/ffprobe into bin/ (avoid GPL copyleft; safe for future public release)
# Usage: & scripts/fetch-ffmpeg.ps1
param(
  [string]$Url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip',
  [string]$BinDir = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
if (-not $BinDir) { $BinDir = Join-Path $root 'bin' }
New-Item -ItemType Directory -Force $BinDir | Out-Null

$tmpZip = Join-Path $env:TEMP ('ffmpeg-lgpl-' + [guid]::NewGuid().ToString('N') + '.zip')
$tmpDir = Join-Path $env:TEMP ('ffmpeg-lgpl-' + [guid]::NewGuid().ToString('N'))
Write-Output "Downloading $Url"
Invoke-WebRequest -Uri $Url -OutFile $tmpZip -UseBasicParsing
Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force

$ff = Get-ChildItem $tmpDir -Recurse -File -Filter 'ffmpeg.exe' | Select-Object -First 1
$fp = Get-ChildItem $tmpDir -Recurse -File -Filter 'ffprobe.exe' | Select-Object -First 1
if (-not $ff -or -not $fp) { throw 'ffmpeg.exe / ffprobe.exe not found in archive' }
Copy-Item $ff.FullName (Join-Path $BinDir 'ffmpeg.exe') -Force
Copy-Item $fp.FullName (Join-Path $BinDir 'ffprobe.exe') -Force

Remove-Item $tmpZip,$tmpDir -Recurse -Force -ErrorAction SilentlyContinue

$ver = & (Join-Path $BinDir 'ffmpeg.exe') -version 2>&1 | Select-Object -First 1
Write-Output "OK: $BinDir"
Write-Output $ver
$cfg = (& (Join-Path $BinDir 'ffmpeg.exe') -version 2>&1 | Select-String 'configuration:') -join ''
if ($cfg -match '--enable-gpl') { Write-Warning 'Found --enable-gpl: this build is GPL, not LGPL!' }
else { Write-Output 'License check: no --enable-gpl (LGPL build)' }
