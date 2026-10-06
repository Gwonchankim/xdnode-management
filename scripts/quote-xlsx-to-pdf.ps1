# 견적 xlsx → PDF (quote-tool Design §6.2). scripts/quote-pdf-helper.mjs 가 작업마다 이 스크립트를 자식 프로세스로 띄운다(shell 없음).
#
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File quote-xlsx-to-pdf.ps1 -In <in.xlsx> -Out <out.pdf> -Sheet <시트명> -PidFile <excel.pid>
#
# - New-Object -ComObject Excel.Application 은 항상 새 Excel 인스턴스를 띄운다(옛 xlsx_to_pdf.py 의 DispatchEx 와 같은 효과). 사용자 Excel 을 쓰지 않는다.
# - Excel 창 핸들 → GetWindowThreadProcessId 로 pid 를 얻어 -PidFile 에 쓴다. 도우미는 시간 초과 때 이 pid(이름 EXCEL 확인)만 끈다.
# - 매크로를 실행하지 않고(AutomationSecurity = 3), 경고·링크 갱신 대화상자를 띄우지 않는다. 읽기 전용으로 연다.
# - 견적 시트만 보이게 하고 1쪽(가로 1 × 세로 1)에 맞춰 PDF 로 내보낸다(옛 tools/xlsx_to_pdf.py).
# 종료 코드: 0 성공, 2 열기 실패, 3 시트 없음, 4 변환 실패. 출력에는 경로·시트명을 쓰지 않는다.
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Sheet,
  [Parameter(Mandatory = $true)][string]$PidFile
)
$ErrorActionPreference = "Stop"

Add-Type -Namespace XdNodeQuote -Name Win32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
'@

$code = 0
$excel = $null
$workbook = $null
$excelPid = 0
try {
  $excel = New-Object -ComObject Excel.Application
  try {
    [uint32]$found = 0
    [void][XdNodeQuote.Win32]::GetWindowThreadProcessId([System.IntPtr]$excel.Hwnd, [ref]$found)
    $excelPid = [int]$found
    if ($excelPid -gt 0) { Set-Content -LiteralPath $PidFile -Value $excelPid -Encoding ascii }
  }
  catch { $excelPid = 0 }
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.ScreenUpdating = $false
  $excel.AskToUpdateLinks = $false
  $excel.AutomationSecurity = 3   # msoAutomationSecurityForceDisable: 매크로 실행 안 함

  try { $workbook = $excel.Workbooks.Open($In, 0, $true) }   # UpdateLinks = 0, ReadOnly = True
  catch { $code = 2 }

  if ($code -eq 0) {
    $target = $null
    foreach ($worksheet in $workbook.Worksheets) { if ($worksheet.Name -eq $Sheet) { $target = $worksheet } }
    if (-not $target) {
      $code = 3
    }
    else {
      try {
        $target.Visible = -1                                                                   # xlSheetVisible
        foreach ($worksheet in $workbook.Worksheets) { if ($worksheet.Name -ne $Sheet) { $worksheet.Visible = 0 } }   # xlSheetHidden
        $target.Select()
        $target.PageSetup.Zoom = $false
        $target.PageSetup.FitToPagesWide = 1
        $target.PageSetup.FitToPagesTall = 1
        $workbook.ExportAsFixedFormat(0, $Out)                                                 # 0 = xlTypePDF
      }
      catch { $code = 4 }
    }
    $target = $null
    $worksheet = $null
  }
}
catch {
  if ($code -eq 0) { $code = 4 }
}
finally {
  if ($workbook) { try { $workbook.Close($false) } catch { } }
  if ($excel) {
    try { $excel.Quit() } catch { }
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel) } catch { }
  }
  $workbook = $null
  $excel = $null
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  # Quit 뒤 5초 안에 끝나지 않으면 이 스크립트가 띄운 Excel(pid 파일, 이름 EXCEL 확인)만 강제로 끈다.
  if ($excelPid -gt 0) {
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $excelPid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 200 }
    $left = Get-Process -Id $excelPid -ErrorAction SilentlyContinue
    if ($left -and $left.ProcessName -eq "EXCEL") { Stop-Process -Id $excelPid -Force -ErrorAction SilentlyContinue }
  }
}
exit $code
