Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = (Get-Location).Path
$scriptVersion = "run-all.ps1 v3.1"
$PSNativeCommandUseErrorActionPreference = $false

Write-Host $scriptVersion

function Get-DotenvValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$Default
  )

  $envFile = Join-Path $projectRoot ".env"
  if (-not (Test-Path $envFile)) {
    return $Default
  }

  $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
  if (-not $line) {
    return $Default
  }

  return (($line -split "=", 2)[1]).Trim()
}

function Test-DockerEngine {
  docker info --format '{{.ServerVersion}}' 1>$null 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Ensure-DockerReady {
  if (Test-DockerEngine) {
    return
  }

  $dockerDesktopExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  $dockerService = Get-Service -Name "com.docker.service" -ErrorAction SilentlyContinue
  if ($null -ne $dockerService -and $dockerService.Status -ne "Running") {
    Write-Host "Starting com.docker.service..."
    try {
      Start-Service -Name "com.docker.service" -ErrorAction Stop
    } catch {
      Write-Host "Could not start com.docker.service automatically. Try running PowerShell as Administrator."
    }
  }

  if (Test-Path $dockerDesktopExe) {
    Write-Host "Docker engine not reachable. Starting Docker Desktop..."
    Start-Process -FilePath $dockerDesktopExe | Out-Null
  }

  $timeoutSec = 120
  $intervalSec = 3
  $elapsed = 0
  while ($elapsed -lt $timeoutSec) {
    Start-Sleep -Seconds $intervalSec
    $elapsed += $intervalSec
    if (Test-DockerEngine) {
      Write-Host "Docker engine is ready."
      return
    }
  }

  throw "Docker engine is not running. Open Docker Desktop and wait until Engine is running, then rerun .\run-all.ps1."
}

function Invoke-ComposeChecked {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Args
  )
  docker compose @Args
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose $($Args -join ' ') failed with exit code $LASTEXITCODE."
  }
}

function Start-ComposeProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Args,
    [Parameter(Mandatory = $true)]
    [string]$OutLogPath,
    [Parameter(Mandatory = $true)]
    [string]$ErrLogPath
  )

  if (Test-Path $OutLogPath) {
    Remove-Item $OutLogPath -Force
  }
  if (Test-Path $ErrLogPath) {
    Remove-Item $ErrLogPath -Force
  }

  $allArgs = @("compose") + $Args
  return Start-Process -FilePath "docker" `
    -ArgumentList $allArgs `
    -WorkingDirectory $projectRoot `
    -NoNewWindow `
    -PassThru `
    -RedirectStandardOutput $OutLogPath `
    -RedirectStandardError $ErrLogPath
}

Ensure-DockerReady

Write-Host "Starting Prometheus + Grafana..."
Invoke-ComposeChecked -Args @("up", "-d", "prometheus", "grafana")

if (-not (Test-Path "artifacts")) {
  New-Item -ItemType Directory -Path "artifacts" | Out-Null
}

Write-Host "Running k6 (load) and Playwright (UI loop) in parallel..."
$k6OutLog = Join-Path $projectRoot "artifacts\k6.out.log"
$k6ErrLog = Join-Path $projectRoot "artifacts\k6.err.log"
$uiOutLog = Join-Path $projectRoot "artifacts\playwright.out.log"
$uiErrLog = Join-Path $projectRoot "artifacts\playwright.err.log"

$k6Proc = Start-ComposeProcess `
  -Args @("--profile", "load", "run", "--rm", "k6") `
  -OutLogPath $k6OutLog `
  -ErrLogPath $k6ErrLog
$uiProc = Start-ComposeProcess `
  -Args @("--profile", "ui", "run", "--rm", "playwright") `
  -OutLogPath $uiOutLog `
  -ErrLogPath $uiErrLog

Wait-Process -Id $k6Proc.Id, $uiProc.Id
$k6Proc.Refresh()
$uiProc.Refresh()

$k6Exit = $k6Proc.ExitCode
$uiExit = $uiProc.ExitCode

Write-Host "----- k6 output (last 120 lines) -----"
if (Test-Path $k6OutLog) {
  Get-Content $k6OutLog -Tail 80
}
if (Test-Path $k6ErrLog) {
  Get-Content $k6ErrLog -Tail 40
}
Write-Host "----- Playwright output (last 120 lines) -----"
if (Test-Path $uiOutLog) {
  Get-Content $uiOutLog -Tail 80
}
if (Test-Path $uiErrLog) {
  Get-Content $uiErrLog -Tail 40
}

Write-Host "k6 exit code: $k6Exit"
Write-Host "UI exit code: $uiExit"

if ($k6Exit -ne 0 -or $uiExit -ne 0) {
  throw "One or more processes failed. Full logs: $k6OutLog, $k6ErrLog, $uiOutLog, $uiErrLog"
}

$grafanaPort = Get-DotenvValue -Name "GRAFANA_PORT" -Default "3000"
$prometheusPort = Get-DotenvValue -Name "PROMETHEUS_PORT" -Default "9090"

Write-Host "Done."
Write-Host "Grafana: http://localhost:$grafanaPort"
Write-Host "Dashboard: http://localhost:$grafanaPort/d/k6-load-overview/k6-load-overview"
Write-Host "Prometheus: http://localhost:$prometheusPort"
Write-Host "Artifacts: ./artifacts"
