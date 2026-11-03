# Download LGPL ffmpeg into bin/ (avoid GPL copyleft; safe for future public release).
# Only ffmpeg.exe is kept: ffprobe is no longer shipped (duration is read via `ffmpeg -i`),
# which saves ~130MB of uncompressed bundle size.
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
if (-not $ff) { throw 'ffmpeg.exe not found in archive' }
Copy-Item $ff.FullName (Join-Path $BinDir 'ffmpeg.exe') -Force
# Drop a stale ffprobe if a previous build placed one here (no longer used).
$staleProbe = Join-Path $BinDir 'ffprobe.exe'
if (Test-Path $staleProbe) { Remove-Item $staleProbe -Force; Write-Output 'Removed stale bin/ffprobe.exe (no longer used).' }

Remove-Item $tmpZip,$tmpDir -Recurse -Force -ErrorAction SilentlyContinue

$ver = & (Join-Path $BinDir 'ffmpeg.exe') -version 2>&1 | Select-Object -First 1
Write-Output "OK: $BinDir"
Write-Output $ver
$cfg = (& (Join-Path $BinDir 'ffmpeg.exe') -version 2>&1 | Select-String 'configuration:') -join ''
if ($cfg -match '--enable-gpl') { Write-Warning 'Found --enable-gpl: this build is GPL, not LGPL!' }
else { Write-Output 'License check: no --enable-gpl (LGPL build)' }
