# XDnode management 시작 스크립트(R3: vite preview 운영, Design §11.5.4, Plan M5a·D16·D18).
#
# 순서: portproxy 확인 → (커밋이 바뀌었으면) build → .dev.vars 작성 → X_LOCAL_EXPLORER=false → preview(0.0.0.0:3000) → 브리지 3120·3130.
# 운영은 별도 폴더(C:\xdm\prod, D18)에서 이 스크립트로 띄운다. 개발 폴더에서는 npm run dev(127.0.0.1:3100)를 쓴다.
# LAN 에 열리는지는 방화벽 규칙 'XDnode management 3000 (LAN)'이 정한다. 첫 관리자를 만들기 전에는 규칙을 켜지 않는다
# (docs/lan-operations-runbook.md). 무인 기동(-Headless)·pid·헬스체크·로그 보관은 R4 에서 더한다.
#
#   powershell -ExecutionPolicy Bypass -File scripts\Start-XDNodeManagement.ps1            운영(3000)
#   powershell -ExecutionPolicy Bypass -File scripts\Start-XDNodeManagement.ps1 -Port 3001 점검 인스턴스(C:\xdm\staging)
#   -Rebuild  커밋이 같아도 다시 빌드한다(작업 트리를 고친 개발 폴더에서 점검할 때)
param(
  [int]$Port = 3000,
  [switch]$Rebuild
)
$ErrorActionPreference = "Stop"

$ProjectPath = Split-Path -Parent $PSScriptRoot
$ResumeBridgePort = 3120
$ClaudeAssistantPort = 3130
$Url = "http://localhost:$Port"
$LogDir = Join-Path $ProjectPath ".vinext\preview"
$LogPath = Join-Path $LogDir "preview.log"
$BuildRevPath = Join-Path $ProjectPath "dist\.build-rev"

function Test-LocalPort([int]$TestPort) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $client.Connect("127.0.0.1", $TestPort)
    return $true
  }
  catch {
    return $false
  }
  finally {
    $client.Dispose()
  }
}

function Stop-WithMessage([string]$Message) {
  Write-Host "`n$Message" -ForegroundColor Red
  Read-Host "`nPress Enter to close" | Out-Null
  exit 1
}

if (-not (Test-Path -LiteralPath $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# D21: 서버 PC 에서 온 요청(루프백)만 로그인 잠금을 건너뛰고 첫 관리자를 만들 수 있다. 포트 프록시·포워딩이 있으면
# LAN 요청이 루프백으로 보이므로, 하나라도 있으면 기동하지 않는다(Design §7.4 8번, 부록 C #7).
$portProxy = @(& netsh.exe interface portproxy show all | Where-Object { $_ -match '\S' })
if ($portProxy.Count -gt 0) {
  Stop-WithMessage "A netsh portproxy rule exists, so XDnode management will not start (LAN requests would look like the server PC). Check 'netsh interface portproxy show all', remove the rule, then try again."
}

# Miniflare 로컬 explorer(D1 임의 SQL 실행 API)를 끈다. vite.config.ts 도 같은 값을 강제한다.
$env:X_LOCAL_EXPLORER = "false"
# 브리지는 시작할 때 이 폴더에서 스키마와 buildPrompt 를 읽는다(cwd 로는 쓰지 않는다, D17). 운영에서는 운영 폴더다.
$env:XD_NODE_PROJECT_PATH = $ProjectPath

if (-not (Test-LocalPort $Port)) {
  # 1) 빌드: dist/.build-rev 가 지금 커밋과 다르면 다시 빌드한다. vinext build 는 매번 dist 를 지운다.
  $revision = ""
  try { $revision = (& git -C $ProjectPath rev-parse HEAD 2>$null | Select-Object -First 1) } catch { $revision = "" }
  $builtRevision = if (Test-Path -LiteralPath $BuildRevPath) { (Get-Content -Raw -LiteralPath $BuildRevPath).Trim() } else { "" }
  $needsBuild = $Rebuild -or -not $revision -or ($revision -ne $builtRevision) -or -not (Test-Path -LiteralPath (Join-Path $ProjectPath "dist\server\wrangler.json"))
  if ($needsBuild) {
    Write-Host "Building XDnode management (this can take a few minutes)..." -ForegroundColor Cyan
    Push-Location $ProjectPath
    try {
      # cmd.exe 안에서 리디렉션한다. PowerShell 5.1 에서 네이티브 stderr 를 리디렉션하면 경고 한 줄에도 Stop 으로 끊긴다.
      & cmd.exe /c "npm.cmd run build > `"$LogDir\build.log`" 2>&1"
      if ($LASTEXITCODE -ne 0) { Stop-WithMessage "The build failed. See $LogDir\build.log." }
    }
    finally {
      Pop-Location
    }
    if ($revision) { Set-Content -LiteralPath $BuildRevPath -Value $revision -Encoding ascii }
  }

  # 2) .dev.vars: preview 는 빌드 산출물의 vars:{} 와 dist/server/.dev.vars 만 읽는다. 허용 목록 5개만 쓴다(키 이름만 출력).
  & node.exe (Join-Path $ProjectPath "scripts\write-dev-vars.mjs")
  if ($LASTEXITCODE -ne 0) { Stop-WithMessage "Could not write dist\server\.dev.vars." }

  # 3) preview. vinext start·wrangler dev 는 쓰지 않는다(local-peer 플러그인이 실리지 않고, vinext start 는 D1·R2 가 없다).
  # vinext dev 를 0.0.0.0 으로 띄우는 것도 금지다(D16). LAN 노출은 preview 만, 방화벽 규칙으로 연다.
  if ($Port -eq 3000) {
    $previewCommand = "npm.cmd run serve:lan"
  }
  else {
    $previewCommand = "node.exe node_modules\vite\bin\vite.js preview --host 0.0.0.0 --port $Port --strictPort"
  }
  Write-Host "Starting XDnode management on port $Port..." -ForegroundColor Cyan
  $serverProcess = Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/c", "cd /d `"$ProjectPath`" && $previewCommand") `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogPath `
    -RedirectStandardError "$LogPath.err" `
    -PassThru

  $deadline = (Get-Date).AddSeconds(180)
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
