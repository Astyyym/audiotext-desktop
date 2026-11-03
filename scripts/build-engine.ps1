# Build the Python engine sidecar (PyInstaller one-folder) -> build/engine-dist/engine/engine.exe
# Usage: & scripts/build-engine.ps1 -Python "C:\path\to\venv\Scripts\python.exe"
# Or set env ATD_PYTHON to a python that has faster-whisper + pyinstaller installed.
param(
  [string]$Python = $env:ATD_PYTHON
)
# Native tools (PyInstaller) write progress to stderr; use Continue so that is not
# treated as a terminating error under Windows PowerShell. Failures are checked via exit code.
$ErrorActionPreference = 'Continue'
if (-not $Python -or -not (Test-Path $Python)) {
  throw "Pass -Python or set ATD_PYTHON to a python with faster-whisper + pyinstaller"
}
$root = Split-Path -Parent $PSScriptRoot   # Desktop/
Set-Location $root
$dist = Join-Path $root 'build\engine-dist'
$work = Join-Path $root 'build\engine-build'
$spec = Join-Path $root 'build'
$entry = Join-Path $root 'engine\pyinstaller_entry.py'
$log = Join-Path $root 'build\engine-build.log'

& $Python -m PyInstaller --noconfirm --clean --onedir --name engine `
  --paths $root `
  --collect-all faster_whisper `
  --collect-all ctranslate2 `
  --collect-all onnxruntime `
  --collect-all av `
  --collect-all tokenizers `
  --exclude-module hf_xet `
  --distpath $dist --workpath $work --specpath $spec `
  $entry *> $log
$code = $LASTEXITCODE
if ($code -ne 0) {
  Get-Content $log -Tail 40
  throw "PyInstaller failed ($code)"
}

$exe = Join-Path $dist 'engine\engine.exe'
if (-not (Test-Path $exe)) { throw "engine.exe not generated" }
Write-Output "OK: $exe"
