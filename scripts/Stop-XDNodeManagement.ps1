# XDnode management 정지 스크립트(R4, Design §11.5.4·§11.5.8, Plan R4).
#
# preview(cmd.exe → npm → node → workerd)와 브리지 3120·3130, 견적 PDF 도우미 3150 을 끈다. 먼저 Start-XDNodeManagement.ps1 이 쓴 pid 파일로
# taskkill /T /F 하고(workerd 까지. /T 가 없으면 workerd 가 D1 파일을 잡고 남는다), 그래도 포트가 열려 있으면 그 포트를 LISTEN 하는
# node.exe·workerd.exe 를 찾아 끈다(포트 대체 경로). 그 밖의 프로세스(견적 툴 등)는 이름이 달라 건드리지 않는다.
# 견적 PDF 도우미가 변환 중에 꺼져 남은 EXCEL.EXE 는 다음 기동 때 도우미가 pid 파일로 정리한다(quote-tool Design §6.1).
# 브리지는 운영 포트(3000)를 끌 때만 끈다. 점검 인스턴스(3001)·리허설 포트는 운영 브리지를 같이 쓰므로 남긴다.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\xdm\prod\scripts\Stop-XDNodeManagement.ps1
#   -Port 3001            점검 인스턴스만 끈다(브리지 유지)
#   -KeepBridges          3000 을 끌 때도 브리지를 남긴다
#   종료 코드: 0 = 대상 포트가 모두 닫힘, 1 = 아직 열린 포트가 있음(로그 참고)
param(
  [int]$Port = 3000,
  [int[]]$BridgePorts = @(3120, 3130, 3150),
  [switch]$KeepBridges,
  [string]$RunDir = "C:\xdm\run",
  [string]$LogRoot = "C:\xdm\logs",
  [int]$TimeoutSeconds = 30
)
$ErrorActionPreference = "Stop"

# 끌 수 있는 프로세스 이름. pid 파일은 cmd.exe(Start-Process 로 띄운 셸)를, 포트 대체 경로는 node.exe·workerd.exe 를 가리킨다.
$KillableNames = @("cmd", "node", "workerd")

if (-not (Test-Path -LiteralPath $LogRoot)) { New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null }
$DailyLog = Join-Path $LogRoot ("xdm-{0}.log" -f (Get-Date -Format "yyyyMMdd"))

function Write-Log([string]$Level, [string]$Message) {
  $line = "{0} [{1}] stop: {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
  if ($Level -eq "ERROR") { Write-Host $line -ForegroundColor Red } elseif ($Level -eq "WARN") { Write-Host $line -ForegroundColor Yellow } else { Write-Host $line }
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try { [System.IO.File]::AppendAllText($DailyLog, "$line`r`n", [System.Text.Encoding]::UTF8); break } catch { Start-Sleep -Milliseconds 200 }
  }
}

function Test-LocalPort([int]$TestPort) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try { $client.Connect("127.0.0.1", $TestPort); return $true } catch { return $false } finally { $client.Dispose() }
}

function Get-ListenerIds([int]$ListenPort) {
  @(Get-NetTCPConnection -State Listen -LocalPort $ListenPort -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 })
}

# taskkill 은 네이티브 명령이다. PowerShell 5.1 에서 stderr 가 ErrorRecord 로 바뀌어 Stop 으로 끊기지 않게 Continue 로 부른다.
function Stop-ProcessTree([int]$ProcessId, [string]$Label, $NotStartedAfter = $null) {
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  # pid 재사용 방지: pid 파일을 쓴 뒤에 시작한 프로세스는 그 pid 를 물려받은 다른 프로그램이다(재부팅 뒤 남은 pid 파일 등).
  # 다른 로그온 세션(작업 스케줄러)의 프로세스는 StartTime 을 읽을 수 없다. 읽지 못한 것은 재사용으로 보지 않는다.
  if ($NotStartedAfter) {
    $startedAt = $null
    try { $startedAt = $process.StartTime } catch { $startedAt = $null }
    if ($startedAt -and $startedAt -gt $NotStartedAfter) {
      Write-Log "WARN" "$Label pid $ProcessId was reused by another process (started after the pid file was written); left running"
      return $false
    }
  }
  if ($KillableNames -notcontains $process.ProcessName.ToLowerInvariant()) {
    Write-Log "WARN" "$Label pid $ProcessId is '$($process.ProcessName)', not an XDnode management process; left running"
    return $false
  }
  $priorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { $output = & taskkill.exe /T /F /PID $ProcessId 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" } } } finally { $ErrorActionPreference = $priorPreference }
  Write-Log "INFO" ("{0}: taskkill /T /F /PID {1} ({2}) -> {3}" -f $Label, $ProcessId, $process.ProcessName, (($output | Select-Object -First 1) -join " "))
  return $true
}

function Stop-FromPidFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $raw = (Get-Content -Raw -LiteralPath $Path -ErrorAction SilentlyContinue)
  $writtenAt = (Get-Item -LiteralPath $Path).LastWriteTime.AddSeconds(5)
  $processId = 0
  if ($raw -and [int]::TryParse($raw.Trim(), [ref]$processId) -and $processId -gt 0) {
    if (-not (Stop-ProcessTree $processId $Label $writtenAt)) { Write-Log "INFO" "$Label pid $processId from $Path is not running" }
  }
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

$pidFile = if ($Port -eq 3000) { Join-Path $RunDir "xdm-management.pid" } else { Join-Path $RunDir "xdm-management-$Port.pid" }
$targets = @(@{ Port = $Port; PidFile = $pidFile; Label = "preview:$Port" })
if ($Port -eq 3000 -and -not $KeepBridges) {
  foreach ($bridgePort in $BridgePorts) { $targets += @{ Port = $bridgePort; PidFile = (Join-Path $RunDir "xdm-bridge-$bridgePort.pid"); Label = "bridge:$bridgePort" } }
}

Write-Log "INFO" ("begin ports={0}" -f (($targets | ForEach-Object { $_.Port }) -join ","))

# 0) 감독자(Start-XDNodeManagement.ps1 -Headless, 작업 스케줄러)에게 정지 요청. 작업이 띄운 프로세스는 다른 로그온 세션에서
#    taskkill 하면 액세스 거부이므로, 감독자가 같은 세션에서 끄고 끝날 때까지 기다린다. 감독자가 없으면 아래 1)·2)로 넘어간다.
$supervisorFile = Join-Path $RunDir "xdm-supervisor-$Port.pid"
$stopRequest = Join-Path $RunDir "stop-$Port.request"
if (Test-Path -LiteralPath $supervisorFile) {
  $supervisorId = 0
  $rawSupervisor = Get-Content -Raw -LiteralPath $supervisorFile -ErrorAction SilentlyContinue
  $supervisor = $null
  if ($rawSupervisor -and [int]::TryParse($rawSupervisor.Trim(), [ref]$supervisorId)) { $supervisor = Get-Process -Id $supervisorId -ErrorAction SilentlyContinue }
  if ($supervisor -and $supervisor.ProcessName -ieq "powershell") {
    Set-Content -LiteralPath $stopRequest -Value $(if ($KeepBridges -or $Port -ne 3000) { "keep-bridges" } else { "all" }) -Encoding ascii
    Write-Log "INFO" "stop request sent to supervisor pid $supervisorId"
    $supervisorDeadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $supervisorDeadline -and (Get-Process -Id $supervisorId -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 500 }
    if (Get-Process -Id $supervisorId -ErrorAction SilentlyContinue) { Write-Log "WARN" "supervisor pid $supervisorId did not exit within ${TimeoutSeconds}s" }
    else { Write-Log "INFO" "supervisor pid $supervisorId exited" }
  }
  else {
    Write-Log "INFO" "supervisor pid file is stale; removing it"
    Remove-Item -LiteralPath $supervisorFile -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $stopRequest -Force -ErrorAction SilentlyContinue
}

# 1) pid 파일 기준
foreach ($target in $targets) { Stop-FromPidFile $target.PidFile $target.Label }

# 2) 포트 대체 경로: 아직 LISTEN 중이면 그 포트의 node·workerd 를 끈다.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$fallbackAt = (Get-Date).AddSeconds(3)
$fallbackDone = $false
while ((Get-Date) -lt $deadline) {
  $open = @($targets | Where-Object { Test-LocalPort $_.Port })
  if ($open.Count -eq 0) { break }
  if (-not $fallbackDone -and (Get-Date) -ge $fallbackAt) {
    foreach ($target in $open) {
      foreach ($listener in (Get-ListenerIds $target.Port)) { [void](Stop-ProcessTree $listener "$($target.Label) (port fallback)") }
    }
    $fallbackDone = $true
  }
  Start-Sleep -Milliseconds 500
}

$stillOpen = @($targets | Where-Object { Test-LocalPort $_.Port } | ForEach-Object { $_.Port })
if ($stillOpen.Count -gt 0) {
  Write-Log "ERROR" ("ports still listening after {0}s: {1}" -f $TimeoutSeconds, ($stillOpen -join ","))
  exit 1
}
Write-Log "INFO" "stopped (all target ports closed)"
exit 0
