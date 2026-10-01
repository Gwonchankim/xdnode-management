# XDnode management 작업 스케줄러 등록(R4, Design §11.5.8, Plan R4·D19). 관리자 권한 PowerShell 에서 사용자와 함께 한 번 실행한다.
#
# 만드는(있으면 덮어쓰는) 작업 두 개. 'XDNODE 견적서 서버' 작업(견적 툴 8765)은 건드리지 않는다.
#   XDnodeManagement-Autostart  시스템 시작 시(1분 지연), 서버 사용자, 로그온 여부와 관계없이 실행(암호 저장),
#                               실패하면 5분 간격 3회 재시도, 동작 = Start-XDNodeManagement.ps1 -Headless
#   XDnodeManagement-Backup     매일 03:00, 같은 사용자·로그온 방식, 동작 = Backup-XDNodeManagement.ps1
# 모든 재기동(백업·Deploy·수동)은 Start-ScheduledTask XDnodeManagement-Autostart 로 한다(기동 경로 하나).
#
# 대체안(D19): 로그온하지 않은 세션에서 Claude CLI 브리지가 자격 증명을 읽지 못하면(SC-12 재부팅 리허설 실패) -Mode Logon 으로
# 다시 등록한다. 자동 기동은 '로그온 시' 트리거가 되고, 두 작업 모두 '사용자가 로그온할 때만 실행'(Interactive)이 된다.
# Windows 자동 로그온은 이 스크립트가 켜지 않는다. 사용자와 함께 따로 켜고(Sysinternals Autologon 등), 물리 보안 보완책을 정한다.
#
#   powershell -ExecutionPolicy Bypass -File C:\xdm\prod\scripts\Register-XDNodeManagementTasks.ps1                (기본: -Mode Startup, 암호 입력)
#   powershell -ExecutionPolicy Bypass -File C:\xdm\prod\scripts\Register-XDNodeManagementTasks.ps1 -Mode Logon    (대체안)
#   -WhatIf  등록하지 않고 만들 정의만 출력한다
# 암호는 Get-Credential 로 받아 Register-ScheduledTask 에만 넘긴다. 화면·로그·파일에 남기지 않는다.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet("Startup", "Logon")][string]$Mode = "Startup",
  [string]$ProdRoot = "C:\xdm\prod",
  [string]$User = "$env:USERDOMAIN\$env:USERNAME",
  [string]$BackupTime = "03:00",
  [string]$AlertsTime = "09:00",
  [string]$MirrorRoot = "",
  [System.Management.Automation.PSCredential]$Credential
)
$ErrorActionPreference = "Stop"

$AutostartTask = "XDnodeManagement-Autostart"
$BackupTask = "XDnodeManagement-Backup"
$AlertsTask = "XDnodeManagement-Alerts"
$ProtectedTasks = @("XDNODE 견적서 서버")

function Resolve-FullPath([string]$Path) { [System.IO.Path]::GetFullPath($Path).TrimEnd("\") }

function Test-Inside([string]$Child, [string]$Parent) {
  $c = Resolve-FullPath $Child
  $p = Resolve-FullPath $Parent
  return ($c -ieq $p) -or $c.StartsWith("$p\", [System.StringComparison]::OrdinalIgnoreCase)
}

# 작업은 운영 폴더의 스크립트를 가리켜야 한다. 개발 폴더(문서 폴더 아래 작업 사본)를 가리키는 작업은 만들지 않는다.
function Assert-NotDevFolder([string]$Root) {
  $full = Resolve-FullPath $Root
  $repo = Resolve-FullPath (Split-Path -Parent $PSScriptRoot)
  $documents = Resolve-FullPath ([Environment]::GetFolderPath("MyDocuments"))
  $devCopy = ($full -ieq $repo) -and -not ($repo -like "C:\xdm\*")
  if ($devCopy -or (Test-Inside $full $documents) -or -not ($full -like "C:\xdm\*")) {
    Write-Host "Refused: tasks must point at the operations folder (C:\xdm\prod), not $full." -ForegroundColor Red
    exit 3
  }
}

$ProdRoot = Resolve-FullPath $ProdRoot
Assert-NotDevFolder $ProdRoot
foreach ($name in @($AutostartTask, $BackupTask, $AlertsTask)) {
  if ($ProtectedTasks -contains $name) { throw "refusing to overwrite a protected task: $name" }
}
$startScript = Join-Path $ProdRoot "scripts\Start-XDNodeManagement.ps1"
$backupScript = Join-Path $ProdRoot "scripts\Backup-XDNodeManagement.ps1"
foreach ($script in @($startScript, $backupScript, (Join-Path $ProdRoot "scripts\Stop-XDNodeManagement.ps1"))) {
  if (-not (Test-Path -LiteralPath $script)) { throw "missing $script (deploy the R4 tag to $ProdRoot first)" }
}

$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$common = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File"
$autostartAction = New-ScheduledTaskAction -Execute $powershell -Argument "$common `"$startScript`" -Headless" -WorkingDirectory $ProdRoot
$backupArgument = "$common `"$backupScript`""
if ($MirrorRoot) { $backupArgument += " -MirrorRoot `"$MirrorRoot`"" }
$backupAction = New-ScheduledTaskAction -Execute $powershell -Argument $backupArgument -WorkingDirectory $ProdRoot
# 총무 알림(general-affairs GD-7): 매일 09:00. 스크립트가 없으면(총무 탭 전 버전) 이 작업은 만들지 않는다.
$alertsScript = Join-Path $ProdRoot "scripts\Run-GaAlerts.ps1"
$alertsAction = New-ScheduledTaskAction -Execute $powershell -Argument "$common `"$alertsScript`"" -WorkingDirectory $ProdRoot
$alertsTrigger = New-ScheduledTaskTrigger -Daily -At $AlertsTime
$alertsSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

if ($Mode -eq "Startup") {
  $autostartTrigger = New-ScheduledTaskTrigger -AtStartup
  $autostartTrigger.Delay = "PT1M"   # 네트워크·디스크가 올라올 시간을 준다
  $logonType = "Password"            # 로그온 여부와 관계없이 실행(암호 저장). S4U 는 브리지 자격 증명(DPAPI)을 못 읽는다
}
else {
  $autostartTrigger = New-ScheduledTaskTrigger -AtLogOn -User $User
  $logonType = "Interactive"         # 대체안: 사용자가 로그온할 때만 실행(자동 로그온과 함께)
}
$backupTrigger = New-ScheduledTaskTrigger -Daily -At $BackupTime

# 자동 기동: 5분 간격 3회 재시도, 실행 시간 제한 없음(스크립트는 헬스체크 뒤 끝나고 서버 프로세스는 남는다), 겹쳐 실행하지 않음.
$autostartSettings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
# 백업: 놓친 03:00 을 나중에 몰아서 돌리지 않는다(업무 시간에 서버가 멈추지 않게 StartWhenAvailable 을 켜지 않는다). 2시간 제한.
$backupSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$definitions = @(
  @{ Name = $AutostartTask; Action = $autostartAction; Trigger = $autostartTrigger; Settings = $autostartSettings; Description = "XDnode management: vite preview 3000 + bridges 3120/3130 (Start-XDNodeManagement.ps1 -Headless). All restarts go through this task." },
  @{ Name = $BackupTask; Action = $backupAction; Trigger = $backupTrigger; Settings = $backupSettings; Description = "XDnode management: daily stop-copy-verify backup to C:\xdm\backup (Backup-XDNodeManagement.ps1)." }
)
if (Test-Path -LiteralPath $alertsScript) {
  $definitions += @{ Name = $AlertsTask; Action = $alertsAction; Trigger = $alertsTrigger; Settings = $alertsSettings; Description = "XDnode management: daily 총무 알림 digest to the messenger (Run-GaAlerts.ps1, idempotent per day)." }
}

foreach ($definition in $definitions) {
  Write-Host ("{0}: {1} {2} | user {3} | logon {4}" -f $definition.Name, $definition.Action.Execute, $definition.Action.Arguments, $User, $logonType)
}
if (-not $PSCmdlet.ShouldProcess((($definitions | ForEach-Object { $_.Name }) -join ", "), "Register-ScheduledTask ($Mode)")) { return }

$password = $null
if ($logonType -eq "Password") {
  if (-not $Credential) { $Credential = Get-Credential -UserName $User -Message "Password of the server user (stored by Task Scheduler only)" }
  $User = $Credential.UserName
  $password = $Credential.GetNetworkCredential().Password
}

foreach ($definition in $definitions) {
  $arguments = @{
    TaskName = $definition.Name; Action = $definition.Action; Trigger = $definition.Trigger; Settings = $definition.Settings
    Description = $definition.Description; Force = $true
  }
  if ($logonType -eq "Password") {
    Register-ScheduledTask @arguments -User $User -Password $password -RunLevel Limited | Out-Null
  }
  else {
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask @arguments -Principal $principal | Out-Null
  }
  Write-Host "Registered $($definition.Name) ($Mode)" -ForegroundColor Green
}
$password = $null

Get-ScheduledTask -TaskName ($definitions | ForEach-Object { $_.Name }) | Select-Object TaskName, State, @{ n = "LogonType"; e = { $_.Principal.LogonType } } | Format-Table -AutoSize
Write-Host "Next: Start-ScheduledTask $AutostartTask, then check C:\xdm\logs\xdm-yyyyMMdd.log for 'ready'. Rehearse a reboot without logging on (SC-12)."
