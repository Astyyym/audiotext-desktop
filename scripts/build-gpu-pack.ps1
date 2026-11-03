# Build the optional GPU acceleration pack (CUDA 12 runtime: cublas + cublasLt).
# Produces release/AudioTextDesktop-GPU-cu12-<tag>.7z + .sha256 (7-Zip LZMA: much smaller than zip)
# and updates app/gpu-pack.json so the packaged app knows the download URL / size / sha256.
# Runtime extraction uses Windows built-in tar.exe (bsdtar reads 7z) -> no bundled extractor.
# Usage: & scripts/build-gpu-pack.ps1 [-CudaDir <Desktop>\cuda] [-Tag gpu-cu12-v1] [-SevenZip <7za.exe>]
param(
  [string]$CudaDir = '',
  [string]$OutDir = '',
  [string]$Tag = 'gpu-cu12-v1',
  [string]$SevenZip = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
if (-not $CudaDir) { $CudaDir = Join-Path $root 'cuda' }
if (-not $OutDir) { $OutDir = Join-Path $root 'release' }
New-Item -ItemType Directory -Force $OutDir | Out-Null

$files = @('cublas64_12.dll', 'cublasLt64_12.dll')
foreach ($f in $files) { if (-not (Test-Path (Join-Path $CudaDir $f))) { throw "Missing $CudaDir\$f" } }

if (-not $SevenZip) {
  $cands = @()
  $cands += (Get-ChildItem (Join-Path $root 'app\node_modules\7zip-bin') -Recurse -Filter '7za.exe' -ErrorAction SilentlyContinue | Select-Object -Expand FullName)
  $cands += (Get-ChildItem (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache') -Recurse -Filter '7za.exe' -ErrorAction SilentlyContinue | Select-Object -Expand FullName)
  $cands += (Get-Command 7za -ErrorAction SilentlyContinue).Source
  $SevenZip = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $SevenZip -or -not (Test-Path $SevenZip)) { throw "7za.exe not found; pass -SevenZip <path to 7za.exe>" }

$archiveName = "AudioTextDesktop-GPU-cu12-$Tag.7z"
$archive = Join-Path $OutDir $archiveName
if (Test-Path $archive) { Remove-Item $archive -Force }
Write-Output "Compressing with 7z (LZMA) -> $archiveName ..."
Push-Location $CudaDir
try { & $SevenZip a -t7z -mx=9 -mmt=on $archive @files | Out-Null } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "7za failed ($LASTEXITCODE)" }

$size = (Get-Item $archive).Length
$sha = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower()
Set-Content -Path "$archive.sha256" -Value ("$sha  $archiveName") -Encoding ASCII

$manifest = [ordered]@{
  key     = 'cuda12'
  name    = 'GPU acceleration pack (CUDA 12)'
  version = '1'
  url     = "https://github.com/Astyyym/audiotext-desktop/releases/download/$Tag/$archiveName"
  size    = $size
  sha256  = $sha
  files   = $files
}
$manifestPath = Join-Path $root 'app\gpu-pack.json'
$json = $manifest | ConvertTo-Json -Depth 5
# UTF-8 without BOM so Node's JSON.parse (fs.readFileSync utf-8) reads it cleanly.
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Output ("OK: {0}" -f $archive)
Write-Output ("size   = {0} bytes ({1:N1} MB)" -f $size, ($size / 1MB))
Write-Output ("sha256 = {0}" -f $sha)
Write-Output ("Updated {0}" -f $manifestPath)
Write-Output "Now rebuild the installer so the packaged app carries the new gpu-pack.json."
