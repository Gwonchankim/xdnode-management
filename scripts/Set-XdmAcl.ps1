# 관리자 PowerShell 에서 실행한다. C:\xdm 접근을 SYSTEM·Administrators·서버 사용자(DESKTOP-HVUV0RL\user)로 제한한다.
# 지금은 상위(C:\)에서 물려받은 'Authenticated Users: 수정', 'Users: 읽기'라서 이 PC 의 모든 로컬 계정
# (CodexSandboxOffline·CodexSandboxOnline 포함)이 백업(급여·비밀번호 해시)·운영 .dev.vars·견적 이전 데이터를 읽고 고칠 수 있다.
# 하는 일: (1) 현재 ACL 을 파일로 저장 (2) C:\xdm 상속을 끊고 세 주체만 명시 (3) 하위 전부를 상속으로 재설정 (4) 확인.
# 되돌리기: icacls C:\ /restore <저장 파일>   (저장 파일은 C:\xdm-acl-backup-*.txt, C:\ 루트에 둔다)
$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "관리자 권한 PowerShell 에서 실행하세요." }

$root = "C:\xdm"
$user = "DESKTOP-HVUV0RL\user"
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$backup = "C:\xdm-acl-backup-$stamp.txt"

"1/4 현재 ACL 저장: $backup"
& icacls $root /save $backup /T /C /Q | Out-Null
if (-not (Test-Path $backup)) { throw "ACL 저장 실패" }

"2/4 C:\xdm 상속 끊고 SYSTEM·Administrators·$user 만 허용"
# 잘 알려진 SID 로 지정해 한국어 계정 이름에 기대지 않는다(S-1-5-18 SYSTEM, S-1-5-32-544 Administrators).
& icacls $root /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "${user}:(OI)(CI)F" /C
if ($LASTEXITCODE -ne 0) { throw "C:\xdm 권한 설정 실패 (icacls $LASTEXITCODE). 되돌리기: icacls C:\ /restore $backup" }

"3/4 하위 폴더·파일을 C:\xdm 상속으로 재설정 (파일이 많아 1~3분 걸릴 수 있다)"
& icacls "$root\*" /reset /T /C /Q
$resetExit = $LASTEXITCODE
"   icacls /reset 종료 코드: $resetExit (0 이 아니면 일부 파일을 못 바꾼 것 — 아래 확인 결과를 본다)"

"4/4 확인"
& icacls $root
foreach ($p in @("$root\backup", "$root\prod\dist\server", "$root\secure", "$root\work", "$root\archive")) {
  if (Test-Path $p) {
    $acl = (Get-Acl $p).Access | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique
    "  {0}: {1}" -f $p, ($acl -join ", ")
  }
}
$leak = Get-ChildItem $root -Recurse -Force -ErrorAction SilentlyContinue -Directory | Select-Object -First 2000 | Where-Object {
  ((Get-Acl $_.FullName).Access | Where-Object { $_.IdentityReference.Value -match "Authenticated Users|\\Users$|CodexSandbox|Everyone" })
} | Select-Object -First 5
if ($leak) { "  경고: 아직 넓은 권한이 남은 폴더:"; $leak | ForEach-Object { "    " + $_.FullName } } else { "  넓은 권한(Authenticated Users·Users·Everyone·CodexSandbox)이 남은 폴더 없음(앞 2000개 폴더 검사)" }

"운영 확인"
try { Invoke-WebRequest http://127.0.0.1:3000/api/me -UseBasicParsing -TimeoutSec 5 | Out-Null } catch { "  3000 /api/me: $($_.Exception.Response.StatusCode.value__) (401 이면 정상)" }
try { "  3150 health: " + (Invoke-RestMethod http://127.0.0.1:3150/health -TimeoutSec 5 | ConvertTo-Json -Compress) } catch { "  3150 health 실패: $($_.Exception.Message)" }
"완료. 되돌리기 파일: $backup"
