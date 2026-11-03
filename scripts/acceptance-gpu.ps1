# GPU / CPU acceptance for the built engine (run on a build/acceptance machine).
# Verifies: (1) engine reports CPU only when no CUDA dir; (2) with the GPU pack (cuda dir)
# it reports CUDA on an NVIDIA machine; (3) optional real transcription on CPU and (if -ExpectGpu) GPU.
# Usage:
#   & scripts/acceptance-gpu.ps1
#   & scripts/acceptance-gpu.ps1 -ExpectGpu -ModelDir D:\models\small -Audio C:\tmp\demo.wav
param(
  [string]$EngineExe = '',
  [string]$CudaDir = '',
  [string]$ModelDir = '',
  [string]$Audio = '',
  [switch]$ExpectGpu
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
if (-not $EngineExe) { $EngineExe = Join-Path $root 'build\engine-dist\engine\engine.exe' }
if (-not $CudaDir) { $CudaDir = Join-Path $root 'cuda' }
if (-not (Test-Path $EngineExe)) { throw "engine.exe not found: $EngineExe (run scripts/build-engine.ps1 first)" }

$fail = 0
function Report($name, $ok, $detail) {
  if ($ok) { Write-Output ("PASS  {0}  {1}" -f $name, $detail) }
  else { Write-Output ("FAIL  {0}  {1}" -f $name, $detail); $script:fail++ }
}

function Invoke-Probe($cudaDirValue) {
  $old = $env:ATD_CUDA_DIR
  try {
    if ($cudaDirValue) { $env:ATD_CUDA_DIR = $cudaDirValue } else { Remove-Item Env:\ATD_CUDA_DIR -ErrorAction SilentlyContinue }
    $raw = (& $EngineExe probe 2>$null | Out-String)
    $line = ($raw -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -First 1)
    if (-not $line) { return $null }
    return ($line | ConvertFrom-Json)
  } finally {
    if ($null -ne $old) { $env:ATD_CUDA_DIR = $old } else { Remove-Item Env:\ATD_CUDA_DIR -ErrorAction SilentlyContinue }
  }
}

# 1) No CUDA dir -> must report CPU (guards findings F16 mis-detection)
$p0 = Invoke-Probe $null
Report 'probe-without-cuda' ($null -ne $p0 -and $p0.cuda -eq $false) ("cuda=" + $(if ($p0) { $p0.cuda } else { 'n/a' }))

# 2) With CUDA dir -> report CUDA if this is an NVIDIA machine
if (Test-Path $CudaDir) {
  $p1 = Invoke-Probe $CudaDir
  $gpuOk = $null -ne $p1 -and $p1.cuda -eq $true
  if ($ExpectGpu) { Report 'probe-with-cuda' $gpuOk ("cuda=" + $(if ($p1) { $p1.cuda } else { 'n/a' }) + " devices=" + $(if ($p1) { $p1.devices } else { 'n/a' })) }
  else { Write-Output ("INFO  probe-with-cuda  cuda=" + $(if ($p1) { $p1.cuda } else { 'n/a' }) + " (pass -ExpectGpu to assert)") }
} else {
  Write-Output ("INFO  cuda dir not found, skip GPU probe: $CudaDir")
}

# 3) Optional transcribe runs
function Invoke-Transcribe($device) {
  $out = Join-Path $env:TEMP ('atd-acc-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force $out | Out-Null
  & $EngineExe transcribe --input $Audio --out $out --lang zh --device $device --model $ModelDir --formats txt --progress-json *> $null
  $code = $LASTEXITCODE
  $txt = Get-ChildItem $out -Filter *.txt -ErrorAction SilentlyContinue | Select-Object -First 1
  $ok = ($code -eq 0 -and $null -ne $txt)
  Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
  return $ok
}
if ($ModelDir -and (Test-Path $ModelDir) -and $Audio -and (Test-Path $Audio)) {
  Report 'transcribe-cpu' (Invoke-Transcribe 'cpu') 'cpu real transcription'
  if ($ExpectGpu) { Report 'transcribe-cuda' (Invoke-Transcribe 'cuda') 'cuda real transcription' }
} else {
  Write-Output 'INFO  skip transcribe (pass -ModelDir and -Audio to run real transcription)'
}

if ($fail -gt 0) { Write-Output ("RESULT: FAILED ({0})" -f $fail); exit 1 }
Write-Output 'RESULT: PASSED'
