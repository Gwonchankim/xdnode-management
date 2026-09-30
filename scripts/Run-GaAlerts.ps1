# 총무 알림 실행(general-affairs Design §5, GD-7). 메신저 '총무 알림' 채널에 오늘(KST)의 만료·반납 예정 요약을 남긴다.
# 서버 PC 에서만 동작한다: 세션 없이 루프백 + X-XDM-Task 헤더로 POST /api/general/alerts 를 부른다(원격에서는 401).
# 같은 날 두 번째 실행은 서버가 posted:false 로 끝낸다(멱등). 실패는 로그만 남기고 종료 코드 1이다.
#
#   작업 스케줄러 XDnodeManagement-Alerts(매일 09:00)와 Start-XDNodeManagement.ps1 -Headless(ready 직후)가 부른다.
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\xdm\prod\scripts\Run-GaAlerts.ps1 [-Port 3000]
param(
  [int]$Port = 3000,
  [string]$LogRoot = "C:\xdm\logs",
  [string]$Trigger = "task"
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $LogRoot)) { New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null }
$DailyLog = Join-Path $LogRoot ("xdm-{0}.log" -f (Get-Date -Format "yyyyMMdd"))

function Write-Log([string]$Level, [string]$Message) {
  $line = "{0} [{1}] ga-alerts: {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
  if ($Level -eq "ERROR") { Write-Host $line -ForegroundColor Red } else { Write-Host $line }
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try { [System.IO.File]::AppendAllText($DailyLog, "$line`r`n", [System.Text.Encoding]::UTF8); break } catch { Start-Sleep -Milliseconds 200 }
  }
}

$base = "http://127.0.0.1:$Port"
try {
  $body = @{ trigger = $Trigger } | ConvertTo-Json -Compress
  $response = Invoke-WebRequest -Uri "$base/api/general/alerts" -Method Post -UseBasicParsing -TimeoutSec 60 `
    -Headers @{ "X-XDM-Task" = "ga-alerts"; "Origin" = $base } -ContentType "application/json" -Body $body
  $result = $response.Content | ConvertFrom-Json
  Write-Log "INFO" ("runDate={0} posted={1} items={2} alreadyRan={3} members={4}" -f $result.runDate, $result.posted, $result.itemCount, $result.alreadyRan, $result.members)
  exit 0
}
catch {
  $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
  Write-Log "ERROR" "POST /api/general/alerts failed (status $status): $($_.Exception.Message)"
  exit 1
}
