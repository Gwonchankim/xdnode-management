# XDnode management 매일 백업(R4, Design §11.5.1·§11.5.8·§7.9, Plan R4·D18·D19).
#
# 순서(Design §11.5.8. Plan 의 '재기동 → 검증'과 달리, 기록을 서버 정지 중에 하려고 검증·기록을 재기동보다 앞에 둔다)
#   1. Stop-XDNodeManagement.ps1 로 정지하고 state 파일 잠금이 풀릴 때까지 기다린다
#   2. d1·r2 메타데이터의 *.sqlite·-wal·-shm 을 <BackupRoot>\yyyy-MM-dd\v3 로 복사(저장소 밖, 경로 120자 이하)
#   3. R2 본문 blob 을 단일 저장소 <BackupRoot>\r2-blobs 로 robocopy /E(증분, 삭제하지 않음)
#   4. verify-state-snapshot.mjs 로 사본을 read-only 검사 → backup-report.json → 사본에 attrib +R
#   5. verify-state-snapshot.mjs --record-run 으로 운영 D1 의 ops_backup_runs 에 기록(성공·실패 모두)
#   6. 재기동: Start-ScheduledTask XDnodeManagement-Autostart(기동 경로는 하나) → 헬스체크 401
#   7. 날짜 폴더는 14개만 남긴다(성공한 날만 정리. blob 저장소는 지우지 않는다)
#   8. -MirrorRoot 가 있으면 날짜 폴더와 blob 저장소를 2차 매체로 복사
# 백업 성공 = 복사 완료 + integrity_check ok + 보고서 기록(+ R2 객체 본문 누락 0). .env.local 은 넣지 않는다.
# 작업 스케줄러 03:00 에서 돈다: 대화형 입력이 없고, 경로는 모두 절대 경로이며, 같은 시간에 두 번 돌지 않게 잠금 파일을 쓴다.
#
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\xdm\prod\scripts\Backup-XDNodeManagement.ps1
#   리허설(가짜 운영 폴더): ... -ProdRoot <임시>\prod -BackupRoot <임시>\backup -RunDir <임시>\run -LogRoot <임시>\logs -Port <빈 포트> -Restart None
#   종료 코드: 0 = 성공, 1 = 백업 실패(기록됨), 2 = 재기동 실패, 3 = 거부(개발 폴더·잠금·잘못된 경로)
param(
  [string]$ProdRoot = "C:\xdm\prod",
  [string]$BackupRoot = "C:\xdm\backup",
  [string]$MirrorRoot = "",
  [string]$RunDir = "C:\xdm\run",
  [string]$LogRoot = "C:\xdm\logs",
  [int]$Port = 3000,
  [string]$TaskName = "XDnodeManagement-Autostart",
  [ValidateSet("Task", "None")][string]$Restart = "Task",
  [int]$Keep = 14,
  [int]$HealthTimeoutSeconds = 300
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $LogRoot)) { New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null }
$DailyLog = Join-Path $LogRoot ("xdm-{0}.log" -f (Get-Date -Format "yyyyMMdd"))

function Write-Log([string]$Level, [string]$Message) {
  $line = "{0} [{1}] backup: {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
  if ($Level -eq "ERROR") { Write-Host $line -ForegroundColor Red } elseif ($Level -eq "WARN") { Write-Host $line -ForegroundColor Yellow } else { Write-Host $line }
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try { [System.IO.File]::AppendAllText($DailyLog, "$line`r`n", [System.Text.Encoding]::UTF8); break } catch { Start-Sleep -Milliseconds 200 }
  }
}

function Resolve-FullPath([string]$Path) { [System.IO.Path]::GetFullPath($Path).TrimEnd("\") }

function Test-Inside([string]$Child, [string]$Parent) {
  $c = Resolve-FullPath $Child
  $p = Resolve-FullPath $Parent
  return ($c -ieq $p) -or $c.StartsWith("$p\", [System.StringComparison]::OrdinalIgnoreCase)
}

# 개발 폴더(이 저장소의 작업 사본, 문서 폴더 아래)는 운영 데이터가 아니다(R3 10단계). 운영 스크립트는 그 state 를 대상으로 삼지 않는다.
# 운영 폴더(C:\xdm\prod)에 있는 이 스크립트가 자기 폴더를 대상으로 하는 것은 정상이다.
function Assert-NotDevFolder([string]$Root) {
  $full = Resolve-FullPath $Root
  $repo = Resolve-FullPath (Split-Path -Parent $PSScriptRoot)
  $documents = Resolve-FullPath ([Environment]::GetFolderPath("MyDocuments"))
  $devCopy = ($full -ieq $repo) -and -not ($repo -like "C:\xdm\*")
  if ($devCopy -or (Test-Inside $full $documents)) {
    Write-Log "ERROR" "refused: $full is the development folder, not an operations folder. Use C:\xdm\prod (or a rehearsal copy outside Documents)."
    exit 3
  }
}

function Test-LocalPort([int]$TestPort) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try { $client.Connect("127.0.0.1", $TestPort); return $true } catch { return $false } finally { $client.Dispose() }
}

function Get-HealthStatus([int]$HealthPort) {
  try { return [int](Invoke-WebRequest -Uri "http://127.0.0.1:$HealthPort/api/me" -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 0).StatusCode }
  catch [System.Net.WebException] { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }; return 0 }
  catch { return 0 }
}

# 네이티브 명령(robocopy·attrib·node)을 부르고 출력 줄을 돌려준다. PowerShell 5.1 에서 stderr 가 Stop 으로 끊기지 않게 Continue 로 부른다.
# 주의: PowerShell 변수 이름은 대소문자를 가리지 않는다. 결과 변수는 경로 변수($Verify 등)와 다른 이름을 쓴다.
function Invoke-Native([string]$File, [string[]]$Arguments) {
  $priorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = @(& $File @Arguments 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" } } | Where-Object { $_ -ne "" })
    return @{ Code = $LASTEXITCODE; Output = $output }
  }
  finally { $ErrorActionPreference = $priorPreference }
}

function Invoke-Robocopy([string]$Source, [string]$Destination, [string[]]$Options) {
  $result = Invoke-Native "robocopy.exe" (@($Source, $Destination) + $Options + @("/R:2", "/W:2", "/NP", "/NFL", "/NDL", "/NJH"))
  # robocopy 는 0~7 이 성공(복사함·같음·추가 파일 등), 8 이상이 실패다.
  if ($result.Code -ge 8) { throw ("robocopy {0} -> {1} failed with code {2}: {3}" -f $Source, $Destination, $result.Code, (($result.Output | Where-Object { $_ -match "ERROR" } | Select-Object -First 2) -join " ")) }
  return $result.Code
}

# state 파일을 다른 프로세스가 잡고 있지 않은지 본다(workerd 가 남아 있으면 복사본이 일관되지 않는다).
function Wait-FilesReleased([string[]]$Files, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ($true) {
    $locked = @()
    foreach ($file in $Files) {
      try { $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); $stream.Dispose() }
      catch { $locked += $file }
    }
    if ($locked.Count -eq 0) { return $true }
    if ((Get-Date) -gt $deadline) { Write-Log "ERROR" ("state files still in use: {0}" -f ($locked -join ", ")); return $false }
    Start-Sleep -Seconds 1
  }
}

function Remove-OldDatedFolders([string]$Root, [int]$KeepCount) {
  $dated = @(Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}(T\d{4,6})?$' } | Sort-Object Name -Descending)
  foreach ($old in ($dated | Select-Object -Skip $KeepCount)) {
    try {
      # 사본은 attrib +R 이다. -Force 가 읽기 전용 파일도 지운다.
      Remove-Item -LiteralPath $old.FullName -Recurse -Force
      Write-Log "INFO" "retention: removed $($old.FullName)"
    }
    catch { Write-Log "WARN" "retention: could not remove $($old.FullName): $($_.Exception.Message)" }
  }
}

# ── 0. 경로 확인 ────────────────────────────────────────────────────────────
$ProdRoot = Resolve-FullPath $ProdRoot
$BackupRoot = Resolve-FullPath $BackupRoot
Assert-NotDevFolder $ProdRoot
Assert-NotDevFolder $BackupRoot
if (Test-Inside $BackupRoot $ProdRoot) { Write-Log "ERROR" "refused: the backup root must be outside the operations folder ($ProdRoot)."; exit 3 }
if ($MirrorRoot) {
  $MirrorRoot = Resolve-FullPath $MirrorRoot
  if ((Test-Inside $MirrorRoot $ProdRoot) -or (Test-Inside $MirrorRoot $BackupRoot)) { Write-Log "ERROR" "refused: the mirror root must be a separate medium."; exit 3 }
}
$StateV3 = Join-Path $ProdRoot ".wrangler\state\v3"
if (-not (Test-Path -LiteralPath (Join-Path $StateV3 "d1"))) { Write-Log "ERROR" "refused: no D1 state under $StateV3"; exit 3 }
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Log "ERROR" "refused: node.exe was not found on PATH"; exit 3 }
$Verify = Join-Path $PSScriptRoot "verify-state-snapshot.mjs"
$StopScript = Join-Path $PSScriptRoot "Stop-XDNodeManagement.ps1"
$PidFile = if ($Port -eq 3000) { Join-Path $RunDir "xdm-management.pid" } else { Join-Path $RunDir "xdm-management-$Port.pid" }
foreach ($dir in @($BackupRoot, $RunDir)) { if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null } }

# 같은 시간에 두 번 돌지 않게 한다(수동 실행과 03:00 작업이 겹칠 때).
$LockPath = Join-Path $RunDir "xdm-backup.lock"
try { $lock = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
catch { Write-Log "ERROR" "refused: another backup is running ($LockPath)"; exit 3 }

$exitCode = 0
$status = "FAILED"
$failure = ""
$wasRunning = Test-LocalPort $Port
try {
  # ── 날짜 폴더(같은 날 재실행이면 yyyy-MM-ddTHHmm) ──────────────────────────
  $startedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $now = Get-Date
  $runId = $now.ToString("yyyy-MM-dd")
  if (Test-Path -LiteralPath (Join-Path $BackupRoot $runId)) { $runId = $now.ToString("yyyy-MM-dd'T'HHmm") }
  if (Test-Path -LiteralPath (Join-Path $BackupRoot $runId)) { $runId = $now.ToString("yyyy-MM-dd'T'HHmmss") }
  $BackupDir = Join-Path $BackupRoot $runId
  $BlobStore = Join-Path $BackupRoot "r2-blobs"
  $ReportPath = Join-Path $BackupDir "backup-report.json"
  Write-Log "INFO" "begin run=$runId prod=$ProdRoot backup=$BackupDir serverWasRunning=$wasRunning"
  if ("$BackupDir\".Length -gt 120) { throw "backup path is longer than 120 characters: $BackupDir" }

  # ── 1. 정지 ──────────────────────────────────────────────────────────────
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $StopScript -Port $Port -RunDir $RunDir -LogRoot $LogRoot
  if ($LASTEXITCODE -ne 0) { throw "stop failed (exit $LASTEXITCODE)" }
  $sqliteFiles = @(Get-ChildItem -LiteralPath $StateV3 -Recurse -File | Where-Object { $_.Name -match '\.sqlite(-wal|-shm)?$' } | ForEach-Object { $_.FullName })
  if (-not (Wait-FilesReleased $sqliteFiles 60)) { throw "state files are still in use after stopping" }

  $stage = "copy"
  try {
    # ── 2. sqlite(d1·r2 메타데이터와 그 -wal·-shm) → 날짜 폴더 ─────────────────
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
    [void](Invoke-Robocopy $StateV3 (Join-Path $BackupDir "v3") @("*.sqlite", "*.sqlite-wal", "*.sqlite-shm", "/E"))
    # ── 3. R2 blob → 단일 저장소(증분, /MIR 가 아니라 /E: 지우지 않는다) ─────────
    $r2 = Join-Path $StateV3 "r2"
    if (Test-Path -LiteralPath $r2) { [void](Invoke-Robocopy $r2 $BlobStore @("/E", "/XF", "*.sqlite", "*.sqlite-wal", "*.sqlite-shm")) }
    elseif (-not (Test-Path -LiteralPath $BlobStore)) { New-Item -ItemType Directory -Path $BlobStore -Force | Out-Null }

    # ── 4. 사본 검사 → backup-report.json → attrib +R ─────────────────────────
    $stage = "verify"
    $verifyResult = Invoke-Native $node @($Verify, (Join-Path $BackupDir "v3"), "--out", $ReportPath, "--blob-store", $BlobStore)
    $verifyResult.Output | ForEach-Object { Write-Log "INFO" "verify: $_" }
    if (-not (Test-Path -LiteralPath $ReportPath)) { throw "verify did not write backup-report.json (exit $($verifyResult.Code))" }
    $attrib = Invoke-Native "attrib.exe" @("+R", "$BackupDir\*", "/S")
    if ($attrib.Code -ne 0) { Write-Log "WARN" "attrib +R returned $($attrib.Code)" }
    $failure = ""
  }
  catch {
    $failure = if ($stage -eq "copy") { "백업 복사에 실패했습니다: $($_.Exception.Message)" } else { "사본 검사에 실패했습니다: $($_.Exception.Message)" }
    Write-Log "ERROR" $failure
  }

  # ── 5. 기록(서버 정지 중, 성공·실패 모두) ──────────────────────────────────
  $recordArgs = @($Verify, "--record-run", $StateV3, "--run-id", $runId, "--started-at", "$startedAt", "--backup-dir", "$BackupDir\",
    "--pid-file", $PidFile, "--port", "$Port")
  if (Test-Path -LiteralPath $ReportPath) { $recordArgs += @("--report", $ReportPath) }
  if ($failure) { $recordArgs += @("--error", $failure) }
  $recordResult = Invoke-Native $node $recordArgs
  $recordResult.Output | ForEach-Object { Write-Log "INFO" "record: $_" }
  # 기록 모드는 쓴 행을 JSON 한 줄({"recorded":…,"status":…})로 출력한다. 그 줄이 없으면 기록되지 않은 것이다.
  $recordedLine = @($recordResult.Output | Where-Object { $_ -like '{"recorded":*' }) | Select-Object -First 1
  if ($recordResult.Code -eq 0 -and $recordedLine -like '*"status":"OK"*') { $status = "OK" }
  elseif ($recordedLine) { $status = "FAILED" }
  else { $status = "FAILED"; Write-Log "ERROR" "could not record the run in ops_backup_runs (exit $($recordResult.Code))" }
  Write-Log ($(if ($status -eq "OK") { "INFO" } else { "ERROR" })) "result: $status ($BackupDir)"
}
catch {
  # 정지 전·정지 단계 실패. 서버가 떠 있을 수 있으므로 기록하지 않는다(기록 모드가 거부한다). 관리자 화면은 36시간 뒤 stale 로 알린다.
  $status = "FAILED"
  Write-Log "ERROR" "backup aborted: $($_.Exception.Message)"
}
finally {
  # ── 6. 재기동(실패해도 한다). 기동 경로는 자동 기동 작업 하나다 ──────────────
  if ($Restart -eq "Task") {
    try {
      if (-not (Test-LocalPort $Port)) {
        Start-ScheduledTask -TaskName $TaskName
        Write-Log "INFO" "restart: Start-ScheduledTask $TaskName"
      }
      $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
      $health = 0
      while ((Get-Date) -lt $deadline) { $health = Get-HealthStatus $Port; if ($health -eq 401) { break }; Start-Sleep -Seconds 2 }
      if ($health -eq 401) { Write-Log "INFO" "restart: healthy (GET /api/me -> 401)" }
      else { Write-Log "ERROR" "restart: not healthy after ${HealthTimeoutSeconds}s (last $health)"; $exitCode = 2 }
    }
    catch { Write-Log "ERROR" "restart failed: $($_.Exception.Message)"; $exitCode = 2 }
  }
  else {
    Write-Log "INFO" "restart skipped (-Restart None, rehearsal)"
  }
  $lock.Dispose()
  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}

if ($status -eq "OK") {
  # ── 7. 보관: 성공한 날에만 날짜 폴더를 14개로 줄인다 ───────────────────────
  Remove-OldDatedFolders $BackupRoot $Keep
  # ── 8. 2차 사본 ─────────────────────────────────────────────────────────
  if ($MirrorRoot) {
    try {
      [void](Invoke-Robocopy $BackupDir (Join-Path $MirrorRoot $runId) @("/E"))
      [void](Invoke-Robocopy $BlobStore (Join-Path $MirrorRoot "r2-blobs") @("/E"))
      Remove-OldDatedFolders $MirrorRoot $Keep
      Write-Log "INFO" "mirror: copied to $MirrorRoot"
    }
    catch { Write-Log "WARN" "mirror failed: $($_.Exception.Message)" }
  }
}
elseif ($exitCode -eq 0) { $exitCode = 1 }

Write-Log "INFO" "end exit=$exitCode"
exit $exitCode
