# XDnode management 시작 스크립트(R3: vite preview 운영, R4: 무인 기동. Design §11.5.4·§11.5.8, Plan M5a·R4·D16·D18·D19).
#
# 순서: 로그 정리 → portproxy 확인 → (커밋이 바뀌었으면) build → .dev.vars 작성 → X_LOCAL_EXPLORER=false → preview(0.0.0.0:3000)
#       → 브리지 3120·3130 → pid 파일 → 헬스체크(GET /api/me 가 401 이면 정상).
# 운영은 별도 폴더(C:\xdm\prod, D18)에서 돈다. 개발 폴더에서는 npm run dev(127.0.0.1:3100)를 쓴다.
# LAN 에 열리는지는 방화벽 규칙 'XDnode management 3000 (LAN)'이 정한다(docs/lan-operations-runbook.md).
#
# 기동 경로는 하나다(Plan R4, Design §1.2): 재부팅·백업·Deploy·수동 재기동은 모두 작업 스케줄러의 XDnodeManagement-Autostart 를
# Start-ScheduledTask 로 실행하고, 그 작업이 이 스크립트를 -Headless 로 부른다. 작업이 등록된 PC 에서 이 스크립트를 -Headless 없이
# 3000 에 실행하면(바탕화면 바로가기) 직접 띄우지 않고 그 작업을 실행한 뒤 브라우저만 연다.
#
#   작업 스케줄러: powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\xdm\prod\scripts\Start-XDNodeManagement.ps1 -Headless
#   수동(바로가기): powershell -ExecutionPolicy Bypass -File scripts\Start-XDNodeManagement.ps1
#   점검 인스턴스:  powershell -ExecutionPolicy Bypass -File scripts\Start-XDNodeManagement.ps1 -Port 3001   (C:\xdm\staging)
#   -Rebuild   커밋이 같아도 다시 빌드한다(작업 트리를 고친 폴더에서 점검할 때). 작업 위임을 건너뛴다
#   -Headless  Read-Host·브라우저 없음. 실패하면 로그를 남기고 종료 코드 1(작업 스케줄러가 5분 간격 3회 재시도).
#              성공하면 끝나지 않고 감독자로 남는다(작업 상태 '실행 중'). Stop 이 <RunDir>\stop-<포트>.request 를 쓰면
#              자기가 띄운 preview·브리지를 끄고 끝난다. 작업이 띄운 프로세스는 다른 로그온 세션에서 끌 수 없기 때문이다.
#
# pid 파일: <RunDir>\xdm-management.pid(3000, preview 를 띄운 cmd.exe 하나의 pid. reset-admin-password·백업 기록이 읽는다),
#           그 밖의 포트는 xdm-management-<포트>.pid, 브리지는 xdm-bridge-<포트>.pid. Stop-XDNodeManagement.ps1 이 이 파일들로 끈다.
# 로그: <LogRoot>\xdm-yyyyMMdd.log(이 스크립트·Stop·Backup·Deploy 공용), preview-/bridge-/build-*.log(프로세스 출력). 14일이 지나면 지운다.
# 로그에는 요청 본문·Cookie·비밀값을 남기지 않는다(Design §7.9).
param(
  [int]$Port = 3000,
  [switch]$Rebuild,
  [switch]$Headless,
  [string]$RunDir = "C:\xdm\run",
  [string]$LogRoot = "C:\xdm\logs",
  [string]$TaskName = "XDnodeManagement-Autostart",
  [int]$HealthTimeoutSeconds = 180,
  [int]$LogRetentionDays = 14
)
$ErrorActionPreference = "Stop"

$ProjectPath = Split-Path -Parent $PSScriptRoot
$ResumeBridgePort = 3120
$ClaudeAssistantPort = 3130
$Url = "http://localhost:$Port"
$BuildRevPath = Join-Path $ProjectPath "dist\.build-rev"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$PidFile = if ($Port -eq 3000) { Join-Path $RunDir "xdm-management.pid" } else { Join-Path $RunDir "xdm-management-$Port.pid" }

foreach ($dir in @($RunDir, $LogRoot)) {
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}
$LogPath = Join-Path $LogRoot "preview-$Port-$Stamp.log"
$DailyLog = Join-Path $LogRoot ("xdm-{0}.log" -f (Get-Date -Format "yyyyMMdd"))

function Write-Log([string]$Level, [string]$Message) {
  $line = "{0} [{1}] start: {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
  if ($Level -eq "ERROR") { Write-Host $line -ForegroundColor Red } elseif ($Level -eq "WARN") { Write-Host $line -ForegroundColor Yellow } else { Write-Host $line }
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try { [System.IO.File]::AppendAllText($DailyLog, "$line`r`n", [System.Text.Encoding]::UTF8); break } catch { Start-Sleep -Milliseconds 200 }
  }
}

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
  Write-Log "ERROR" $Message
  if (-not $Headless) { Read-Host "`nPress Enter to close" | Out-Null }
  exit 1
}

# 헬스체크: 세션 없이 GET /api/me → 401(UNAUTHENTICATED·BOOTSTRAP_REQUIRED)이면 앱·D1 이 응답하는 것이다(Design §4.2.1). 그 밖의 값은 비정상.
function Get-HealthStatus([int]$HealthPort) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$HealthPort/api/me" -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 0
    return [int]$response.StatusCode
  }
  catch [System.Net.WebException] {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
    return 0
  }
  catch {
    return 0
  }
}

function Wait-Healthy([int]$HealthPort, [int]$TimeoutSeconds, $Process) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $status = 0
  while ((Get-Date) -lt $deadline) {
    if ($Process -and $Process.HasExited) { break }
    if (Test-LocalPort $HealthPort) {
      $status = Get-HealthStatus $HealthPort
      if ($status -eq 401) { return 401 }
    }
    Start-Sleep -Seconds 1
  }
  return $status
}

function Show-LogTail([string[]]$Paths) {
  foreach ($candidate in $Paths) {
    if (Test-Path -LiteralPath $candidate) {
      $tail = Get-Content -LiteralPath $candidate -Tail 20 -ErrorAction SilentlyContinue
      if ($tail) {
        Write-Host "`n--- $candidate (last 20 lines) ---" -ForegroundColor DarkGray
        $tail | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
      }
    }
  }
}

function Start-Bridge([int]$BridgePort, [string]$NpmScript, [string]$Name) {
  if (Test-LocalPort $BridgePort) { return }
  $bridgeLog = Join-Path $LogRoot "bridge-$Name-$Stamp.log"
  $bridge = Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/c", "cd /d `"$ProjectPath`" && $NpmScript") `
    -WindowStyle Hidden `
    -RedirectStandardOutput $bridgeLog `
    -RedirectStandardError "$bridgeLog.err" `
    -PassThru
  Set-Content -LiteralPath (Join-Path $RunDir "xdm-bridge-$BridgePort.pid") -Value $bridge.Id -Encoding ascii
  $script:OwnedBridges += @{ Port = $BridgePort; Id = $bridge.Id }
  Write-Log "INFO" "bridge $Name started on 127.0.0.1:$BridgePort (pid $($bridge.Id))"
}

# 감독 모드(-Headless). 작업 스케줄러가 '로그온 여부와 관계없이'(암호 저장) 띄운 프로세스는 다른 로그온 세션
# (대화형 창, Deploy, 03:00 백업 작업)에서 taskkill 하면 '액세스가 거부되었습니다'로 끌 수 없다. 그래서 이 스크립트가
# 끝나지 않고 남아 있다가, Stop-XDNodeManagement.ps1 이 남긴 정지 요청 파일을 보면 자기가 띄운 프로세스를 같은 세션에서 끈다.
$StopRequest = Join-Path $RunDir "stop-$Port.request"
$SupervisorPidFile = Join-Path $RunDir "xdm-supervisor-$Port.pid"
$script:OwnedBridges = @()

function Stop-OwnedTree([int]$ProcessId, [string]$Label) {
  if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
  $priorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { $output = & taskkill.exe /T /F /PID $ProcessId 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" } } } finally { $ErrorActionPreference = $priorPreference }
  Write-Log "INFO" ("supervisor: {0}: taskkill /T /F /PID {1} -> {2}" -f $Label, $ProcessId, (($output | Select-Object -First 1) -join " "))
}

function Invoke-Supervisor($ServerProcess) {
  Set-Content -LiteralPath $SupervisorPidFile -Value $PID -Encoding ascii
  Write-Log "INFO" "supervisor: waiting for $StopRequest (pid $PID)"
  try {
    while ($true) {
      if (Test-Path -LiteralPath $StopRequest) { break }
      if ($ServerProcess -and $ServerProcess.HasExited) {
        Write-Log "ERROR" "supervisor: preview on port $Port exited without a stop request (see $LogPath)"
        break
      }
      Start-Sleep -Seconds 2
    }
    $keepBridges = (Test-Path -LiteralPath $StopRequest) -and ((Get-Content -Raw -LiteralPath $StopRequest -ErrorAction SilentlyContinue) -match "keep-bridges")
    if ($ServerProcess) { Stop-OwnedTree $ServerProcess.Id "preview:$Port" }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    if (-not $keepBridges) {
      foreach ($bridge in $script:OwnedBridges) {
        Stop-OwnedTree $bridge.Id "bridge:$($bridge.Port)"
        Remove-Item -LiteralPath (Join-Path $RunDir "xdm-bridge-$($bridge.Port).pid") -Force -ErrorAction SilentlyContinue
      }
    }
  }
  finally {
    Remove-Item -LiteralPath $SupervisorPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $StopRequest -Force -ErrorAction SilentlyContinue
  }
  Write-Log "INFO" "supervisor: stopped port $Port"
}

# 로그 회전: 날짜별 로그와 프로세스 출력 로그를 14일 보관한다. 지금 쓰는 파일은 지워지지 않으므로 오류를 무시한다.
$cutoff = (Get-Date).AddDays(-$LogRetentionDays)
Get-ChildItem -LiteralPath $LogRoot -File -ErrorAction SilentlyContinue |
  Where-Object { ($_.Name -like "*.log" -or $_.Name -like "*.err") -and $_.LastWriteTime -lt $cutoff } |
  ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch { } }

Write-Log "INFO" ("begin port={0} headless={1} project={2}" -f $Port, [bool]$Headless, $ProjectPath)
# 지난 실행이 남긴 정지 요청(감독자가 처리하기 전에 재부팅 등)은 새 서버를 곧바로 끄므로 지운다.
Remove-Item -LiteralPath $StopRequest -Force -ErrorAction SilentlyContinue

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

# 기동 경로 하나(Plan R4): 자동 기동 작업이 등록돼 있으면 수동 실행도 그 작업으로 올린다. 대화형 세션에서 직접 띄우면
# 로그오프할 때 서버가 같이 멈추고, 세션 종류가 달라 브리지 자격 증명 동작도 달라질 수 있다.
if (-not $Headless -and -not $Rebuild -and $Port -eq 3000 -and -not (Test-LocalPort $Port)) {
  $autostart = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  # 비활성화된 작업(R4 롤백)은 건너뛰고 R3 방식으로 직접 띄운다.
  if ($autostart -and $autostart.State -ne "Disabled") {
    Write-Log "INFO" "starting through the scheduled task '$TaskName'"
    Start-ScheduledTask -TaskName $TaskName
    $status = Wait-Healthy $Port ($HealthTimeoutSeconds + 60) $null
    if ($status -ne 401) { Stop-WithMessage "The scheduled task '$TaskName' did not bring the server up (health $status). See $LogRoot." }
    Write-Log "INFO" "ready (health 401 via task)"
    Start-Process $Url
    exit 0
  }
}

$serverProcess = $null
if (-not (Test-LocalPort $Port)) {
  # 1) 빌드: dist/.build-rev 가 지금 커밋과 다르면 다시 빌드한다. vinext build 는 매번 dist 를 지운다.
  $revision = ""
  try { $revision = (& git -C $ProjectPath rev-parse HEAD 2>$null | Select-Object -First 1) } catch { $revision = "" }
  $builtRevision = if (Test-Path -LiteralPath $BuildRevPath) { (Get-Content -Raw -LiteralPath $BuildRevPath).Trim() } else { "" }
  $needsBuild = $Rebuild -or -not $revision -or ($revision -ne $builtRevision) -or -not (Test-Path -LiteralPath (Join-Path $ProjectPath "dist\server\wrangler.json"))
  if ($needsBuild) {
    $buildLog = Join-Path $LogRoot "build-$Stamp.log"
    Write-Log "INFO" "building (log: $buildLog)"
    Push-Location $ProjectPath
    try {
      # cmd.exe 안에서 리디렉션한다. PowerShell 5.1 에서 네이티브 stderr 를 리디렉션하면 경고 한 줄에도 Stop 으로 끊긴다.
      & cmd.exe /c "npm.cmd run build > `"$buildLog`" 2>&1"
      if ($LASTEXITCODE -ne 0) { Stop-WithMessage "The build failed. See $buildLog." }
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
  Write-Log "INFO" "starting preview on port $Port (log: $LogPath)"
  $serverProcess = Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/c", "cd /d `"$ProjectPath`" && $previewCommand") `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogPath `
    -RedirectStandardError "$LogPath.err" `
    -PassThru
  # pid 파일은 preview 를 띄운 cmd.exe 하나다. Stop 은 이 pid 에서 taskkill /T 로 node·workerd 까지 끈다.
  Set-Content -LiteralPath $PidFile -Value $serverProcess.Id -Encoding ascii

  $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
  while ((Get-Date) -lt $deadline -and -not (Test-LocalPort $Port)) {
    if ($serverProcess.HasExited) {
      break
    }
    Start-Sleep -Milliseconds 500
  }
}
else {
  Write-Log "INFO" "port $Port is already open; checking health only"
}

# Codex 어시스턴트 다리(3110)는 더 띄우지 않는다. 어시스턴트는 아래 Claude 다리(3130)가 맡는다.

# 이력서 분석용 Claude CLI 다리. Worker 안에서는 프로세스를 띄울 수 없어 여기서 같이 올린다.
Start-Bridge $ResumeBridgePort "npm.cmd run resume:bridge" "resume"

# HR·임금계산 보조 어시스턴트(Claude CLI). 저장소 파일은 읽지 않고 ERP 서버가 넘긴 자료로만 답한다.
Start-Bridge $ClaudeAssistantPort "npm.cmd run assistant:claude" "assistant"

# 4) 헬스체크. 401 이 아니면 실패다(작업 스케줄러는 종료 코드 1 을 보고 재시도한다).
$health = Wait-Healthy $Port 60 $serverProcess
if ($health -ne 401) {
  Write-Log "ERROR" "health check failed: GET /api/me returned $health (expected 401)"
  Show-LogTail @($LogPath, "$LogPath.err")
  Stop-WithMessage "XDnode management could not start the local server. Please verify Node.js and the project dependencies, then try again."
}
Write-Log "INFO" "ready: GET http://127.0.0.1:$Port/api/me -> 401"

# 브리지는 재시도 대상이 아니다. 늦게 뜨거나 자격 증명 오류로 죽으면 경고만 남긴다(SC-12 재부팅 리허설에서 확인).
Start-Sleep -Seconds 3
foreach ($bridgePort in @($ResumeBridgePort, $ClaudeAssistantPort)) {
  if (-not (Test-LocalPort $bridgePort)) { Write-Log "WARN" "bridge 127.0.0.1:$bridgePort is not listening yet. See $LogRoot\bridge-*.log." }
}

if ($Headless) {
  # 이미 떠 있던 서버를 확인만 했으면(이 실행이 띄운 프로세스가 없으면) 감독할 것이 없다.
  if ($serverProcess -or $script:OwnedBridges.Count -gt 0) { Invoke-Supervisor $serverProcess }
  exit 0
}
Write-Host "Ready. Opening the browser..." -ForegroundColor Green
Start-Process $Url
