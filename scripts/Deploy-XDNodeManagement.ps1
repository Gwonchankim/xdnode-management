# XDnode management 배포(R4, Design §11.5.8 Deploy 순서, Plan R4·D18). 운영 폴더에서, 업무 시간 밖에 한다.
#
# 순서: 1 태그 확인 → 2 Stop → 3 정지 후 스냅샷과 검증 → 4 checkout → 5 (lock 이 바뀌었으면) npm ci → 6 npm run build
#       → 7 write-dev-vars 와 dist\.build-rev → 8 Start-ScheduledTask(기동 경로는 하나) → 9 헬스체크(GET /api/me 401)
# 실패하면 직전 커밋으로 되돌려 다시 빌드하고 같은 경로로 올린다. 중단 시간(2 ~ 9)을 재서 로그와 deploy-history.log 에 남긴다.
# npm test 는 운영 폴더에서 돌리지 않는다(build 가 dist 를 지운다). lint·test 는 개발 폴더에서 태그를 달기 전에 한다.
# 대상은 C:\xdm\prod 또는 C:\xdm\staging 뿐이다. 개발 폴더(이 저장소의 작업 사본)나 그 밖의 경로는 아무것도 하기 전에 거부한다.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\xdm\prod\scripts\Deploy-XDNodeManagement.ps1 -Tag r4-release-yyyyMMdd
#   종료 코드: 0 = 배포 성공, 1 = 실패 후 이전 버전으로 복구, 2 = 복구도 실패(수동 조치), 3 = 거부(경로·태그·작업 트리)
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$ProdRoot = "C:\xdm\prod",
  [string]$SnapshotRoot = "C:\xdm\snapshots",
  [string]$RunDir = "C:\xdm\run",
  [string]$LogRoot = "C:\xdm\logs",
  [int]$Port = 3000,
  [string]$TaskName = "XDnodeManagement-Autostart",
  [int]$HealthTimeoutSeconds = 300
)
$ErrorActionPreference = "Stop"

# Deploy 가 다룰 수 있는 폴더. 개발 폴더는 여기에 없으므로 거부된다.
$AllowedRoots = @("C:\xdm\prod", "C:\xdm\staging")

if (-not (Test-Path -LiteralPath $LogRoot)) { New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null }
$DailyLog = Join-Path $LogRoot ("xdm-{0}.log" -f (Get-Date -Format "yyyyMMdd"))

function Write-Log([string]$Level, [string]$Message) {
  $line = "{0} [{1}] deploy: {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
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

# 개발 폴더(이 저장소의 작업 사본, 문서 폴더 아래)는 운영 대상이 아니다. 운영 폴더에 있는 이 스크립트가 자기 폴더를 대상으로 하는 것은 정상이다.
function Assert-NotDevFolder([string]$Root) {
  $full = Resolve-FullPath $Root
  $repo = Resolve-FullPath (Split-Path -Parent $PSScriptRoot)
  $documents = Resolve-FullPath ([Environment]::GetFolderPath("MyDocuments"))
  $devCopy = ($full -ieq $repo) -and -not ($repo -like "C:\xdm\*")
  if ($devCopy -or (Test-Inside $full $documents)) {
    Write-Log "ERROR" "refused: $full is the development folder. Deploy only targets C:\xdm\prod or C:\xdm\staging."
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

function Invoke-Native([string]$File, [string[]]$Arguments) {
  $priorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = @(& $File @Arguments 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" } } | Where-Object { $_ -ne "" })
    return @{ Code = $LASTEXITCODE; Output = $output }
  }
  finally { $ErrorActionPreference = $priorPreference }
}

function Invoke-Git([string[]]$Arguments) {
  $result = Invoke-Native "git.exe" (@("-C", $ProdRoot) + $Arguments)
  if ($result.Code -ne 0) { throw ("git {0} failed: {1}" -f ($Arguments -join " "), (($result.Output | Select-Object -Last 3) -join " ")) }
  return $result.Output
}

# npm 은 cmd.exe 안에서 로그 파일로 리디렉션한다(PowerShell 5.1 의 네이티브 stderr 문제를 피한다).
function Invoke-Npm([string]$NpmArguments, [string]$LogName) {
  $log = Join-Path $LogRoot ("deploy-{0}-{1}.log" -f $LogName, (Get-Date -Format "yyyyMMdd-HHmmss"))
  & cmd.exe /c "cd /d `"$ProdRoot`" && npm.cmd $NpmArguments > `"$log`" 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "npm $NpmArguments failed (exit $LASTEXITCODE, log $log)" }
  Write-Log "INFO" "npm $NpmArguments ok (log $log)"
}

function Build-Revision([string]$Revision, [bool]$LockChanged) {
  Invoke-Git @("checkout", "--detach", $Revision) | Out-Null
  if ($LockChanged -or -not (Test-Path -LiteralPath (Join-Path $ProdRoot "node_modules"))) { Invoke-Npm "ci" "npm-ci" }
  Invoke-Npm "run build" "build"
  $devVars = Invoke-Native "node.exe" @((Join-Path $ProdRoot "scripts\write-dev-vars.mjs"))
  $devVars.Output | ForEach-Object { Write-Log "INFO" "write-dev-vars: $_" }
  if ($devVars.Code -ne 0) { throw "write-dev-vars failed (exit $($devVars.Code))" }
  $head = (Invoke-Git @("rev-parse", "HEAD") | Select-Object -First 1).Trim()
  # Start 스크립트는 build-rev 가 HEAD 와 같으면 다시 빌드하지 않는다.
  Set-Content -LiteralPath (Join-Path $ProdRoot "dist\.build-rev") -Value $head -Encoding ascii
  return $head
}

function Start-AndWait() {
  Start-ScheduledTask -TaskName $TaskName
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
  $health = 0
  while ((Get-Date) -lt $deadline) { $health = Get-HealthStatus $Port; if ($health -eq 401) { return $true }; Start-Sleep -Seconds 2 }
  Write-Log "ERROR" "not healthy after ${HealthTimeoutSeconds}s (last $health)"
  return $false
}

# ── 0. 대상 확인(아무것도 하기 전에) ─────────────────────────────────────────
$ProdRoot = Resolve-FullPath $ProdRoot
Assert-NotDevFolder $ProdRoot
if (-not ($AllowedRoots -contains $ProdRoot)) {
  Write-Log "ERROR" ("refused: {0} is not an operations folder ({1})." -f $ProdRoot, ($AllowedRoots -join ", "))
  exit 3
}
if (-not (Test-Path -LiteralPath (Join-Path $ProdRoot ".git"))) { Write-Log "ERROR" "refused: $ProdRoot is not a git checkout"; exit 3 }
$StateV3 = Join-Path $ProdRoot ".wrangler\state\v3"
$Verify = Join-Path $PSScriptRoot "verify-state-snapshot.mjs"
$StopScript = Join-Path $PSScriptRoot "Stop-XDNodeManagement.ps1"

# ── 1. 태그 확인 ────────────────────────────────────────────────────────────
try {
  $fetch = Invoke-Native "git.exe" @("-C", $ProdRoot, "fetch", "--tags", "--quiet")
  if ($fetch.Code -ne 0) { Write-Log "WARN" "git fetch --tags failed; using local tags only" }
  $target = (Invoke-Git @("rev-parse", "--verify", "refs/tags/$Tag^{commit}") | Select-Object -First 1).Trim()
  $previous = (Invoke-Git @("rev-parse", "HEAD") | Select-Object -First 1).Trim()
  $dirty = @(Invoke-Git @("status", "--porcelain", "--untracked-files=no"))
  if ($dirty.Count -gt 0) { throw "the operations working tree has local changes: $($dirty -join '; ')" }
  $lockChanged = $true
  $lockBefore = Invoke-Native "git.exe" @("-C", $ProdRoot, "rev-parse", "HEAD:package-lock.json")
  $lockAfter = Invoke-Native "git.exe" @("-C", $ProdRoot, "rev-parse", "${target}:package-lock.json")
  if ($lockBefore.Code -eq 0 -and $lockAfter.Code -eq 0) { $lockChanged = ("$($lockBefore.Output)" -ne "$($lockAfter.Output)") }
}
catch {
  Write-Log "ERROR" "refused: $($_.Exception.Message)"
  exit 3
}
if ($target -eq $previous) { Write-Log "INFO" "HEAD is already $Tag ($target); nothing to deploy"; exit 0 }
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { Write-Log "ERROR" "refused: scheduled task '$TaskName' is not registered (Register-XDNodeManagementTasks.ps1)"; exit 3 }
Write-Log "INFO" "begin tag=$Tag target=$target previous=$previous lockChanged=$lockChanged"

# ── 2. 정지(중단 시간 시작) ─────────────────────────────────────────────────
$downtime = [System.Diagnostics.Stopwatch]::StartNew()
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $StopScript -Port $Port -RunDir $RunDir -LogRoot $LogRoot
if ($LASTEXITCODE -ne 0) {
  Write-Log "ERROR" "stop failed; bringing the current version back"
  if (-not (Test-LocalPort $Port)) { [void](Start-AndWait) }
  exit 3
}

$exitCode = 0
try {
  # ── 3. 정지 후 스냅샷과 검증 ──────────────────────────────────────────────
  $snapshot = Join-Path $SnapshotRoot ("deploy-{0}-{1}" -f ($Tag -replace '[^\w.-]', '_'), (Get-Date -Format "yyyyMMdd-HHmm"))
  $copy = Invoke-Native "robocopy.exe" @($StateV3, (Join-Path $snapshot "v3"), "/E", "/R:2", "/W:2", "/NP", "/NFL", "/NDL", "/NJH")
  if ($copy.Code -ge 8) { throw "snapshot copy failed (robocopy $($copy.Code))" }
  $check = Invoke-Native "node.exe" @($Verify, (Join-Path $snapshot "v3"), "--out", (Join-Path $snapshot "snapshot-report.json"))
  $check.Output | ForEach-Object { Write-Log "INFO" "snapshot: $_" }
  if ($check.Code -ne 0) { throw "snapshot verification failed; not deploying" }
  [void](Invoke-Native "attrib.exe" @("+R", "$snapshot\*", "/S"))

  # ── 4~7. checkout → npm ci → build → .dev.vars·build-rev ────────────────
  $built = Build-Revision $target $lockChanged
  Write-Log "INFO" "built $Tag ($built)"

  # ── 8~9. 기동과 헬스체크 ──────────────────────────────────────────────────
  if (-not (Start-AndWait)) { throw "the new version did not become healthy" }
  $downtime.Stop()
  $seconds = [math]::Round($downtime.Elapsed.TotalSeconds)
  Write-Log "INFO" "deployed $Tag; downtime ${seconds}s"
  [System.IO.File]::AppendAllText((Join-Path $LogRoot "deploy-history.log"), ("{0}`t{1}`t{2}`t{3}`tdowntime={4}s`r`n" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Tag, $previous, $target, $seconds), [System.Text.Encoding]::UTF8)
}
catch {
  Write-Log "ERROR" "deploy failed: $($_.Exception.Message). Rolling back to $previous"
  $exitCode = 1
  try {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $StopScript -Port $Port -RunDir $RunDir -LogRoot $LogRoot | Out-Null
    [void](Build-Revision $previous $lockChanged)
    if (-not (Start-AndWait)) { throw "the previous version did not become healthy" }
    $downtime.Stop()
    Write-Log "WARN" ("rolled back to {0}; downtime {1}s" -f $previous, [math]::Round($downtime.Elapsed.TotalSeconds))
  }
  catch {
    Write-Log "ERROR" "rollback failed: $($_.Exception.Message). Manual action needed (docs/lan-operations-runbook.md §11)."
    $exitCode = 2
  }
}
exit $exitCode
