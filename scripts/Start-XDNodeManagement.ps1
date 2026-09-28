$ErrorActionPreference = "Stop"

$ProjectPath = Split-Path -Parent $PSScriptRoot
$Port = 3000
$ResumeBridgePort = 3120
$ClaudeAssistantPort = 3130
$Url = "http://localhost:$Port"

function Test-LocalPort([int]$TestPort) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $client.Connect("localhost", $TestPort)
    return $true
  }
  catch {
    return $false
  }
  finally {
    $client.Dispose()
  }
}

function Remove-StaleDevLock {
  $lockPath = Join-Path $ProjectPath ".vinext\dev\lock.json"
  if ((Test-LocalPort $Port) -or -not (Test-Path -LiteralPath $lockPath)) {
    return
  }

  try {
    $lock = Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json
    $owner = Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue
    if (-not $owner -or $owner.ProcessName -ne "node") {
      Remove-Item -LiteralPath $lockPath -Force
    }
  }
  catch {
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  }
}

$LogDir = Join-Path $ProjectPath ".vinext\dev"
$LogPath = Join-Path $LogDir "launcher.log"

# Miniflare 로컬 explorer(D1 임의 SQL 실행 API)를 끈다. vite.config.ts 도 같은 값을 강제한다.
$env:X_LOCAL_EXPLORER = "false"

if (-not (Test-LocalPort $Port)) {
  Write-Host "Starting XDnode management. The first launch may take up to a few minutes (longer if project files changed since the last run)..." -ForegroundColor Cyan
  Remove-StaleDevLock
  if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
  }
  $serverProcess = Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/c", "cd /d `"$ProjectPath`" && npm.cmd run dev -- --port $Port --hostname 127.0.0.1") `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogPath `
    -RedirectStandardError "$LogPath.err" `
    -PassThru

  # Cold starts (e.g. after a vite.config.ts change forces dependency re-optimization,
  # or antivirus scanning a freshly-touched node_modules) can take well over a minute,
  # so keep polling for up to 5 minutes rather than giving up too early.
  $deadline = (Get-Date).AddSeconds(300)
  while ((Get-Date) -lt $deadline -and -not (Test-LocalPort $Port)) {
    if ($serverProcess.HasExited) {
      break
    }
    Start-Sleep -Milliseconds 500
  }
}

# Codex 어시스턴트 다리(3110)는 더 띄우지 않는다. 어시스턴트는 아래 Claude 다리(3130)가 맡는다.

# 이력서 분석용 Claude CLI 다리. Worker 안에서는 프로세스를 띄울 수 없어 여기서 같이 올린다.
if (-not (Test-LocalPort $ResumeBridgePort)) {
  $resumeLogPath = Join-Path $LogDir "claude-resume-bridge.log"
  Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/c", "cd /d `"$ProjectPath`" && npm.cmd run resume:bridge") `
    -WindowStyle Hidden `
    -RedirectStandardOutput $resumeLogPath `
    -RedirectStandardError "$resumeLogPath.err" | Out-Null
}

# HR·임금계산 보조 어시스턴트(Claude CLI). 저장소 파일은 읽지 않고 ERP 서버가 넘긴 자료로만 답한다.
if (-not (Test-LocalPort $ClaudeAssistantPort)) {
  $claudeAssistantLogPath = Join-Path $LogDir "claude-assistant.log"
  Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/c", "cd /d `"$ProjectPath`" && npm.cmd run assistant:claude") `
    -WindowStyle Hidden `
    -RedirectStandardOutput $claudeAssistantLogPath `
    -RedirectStandardError "$claudeAssistantLogPath.err" | Out-Null
}

if (-not (Test-LocalPort $Port)) {
  Write-Host "`nXDnode management could not start the local server." -ForegroundColor Red
  Write-Host "Please verify Node.js and the project dependencies, then try again." -ForegroundColor Yellow
  foreach ($candidate in @($LogPath, "$LogPath.err")) {
    if (Test-Path -LiteralPath $candidate) {
      $tail = Get-Content -LiteralPath $candidate -Tail 20 -ErrorAction SilentlyContinue
      if ($tail) {
        Write-Host "`n--- $candidate (last 20 lines) ---" -ForegroundColor DarkGray
        $tail | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
      }
    }
  }
  Read-Host "`nPress Enter to close" | Out-Null
  exit 1
}

Write-Host "Ready. Opening the browser..." -ForegroundColor Green
Start-Process $Url
