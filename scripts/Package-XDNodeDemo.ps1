# XD NODE ERP 시연용 USB 패키지 생성기.
#
# 이 데스크탑의 작업본을 다른 Windows PC(Node.js 미설치)에서 더블클릭만으로 띄울 수 있게 한 폴더로 묶는다.
#   <Destination>\
#     XD NODE ERP 시연 시작.cmd   ← 더블클릭. 동봉한 Node 를 PATH 에 넣고 app\scripts\Start-XDNodeERP.ps1 을 부른다.
#     README.txt                 ← 시연 PC 에서의 절차와 주의사항
#     runtime\node\              ← 이 PC 의 Node.js 설치 폴더 복사본(Windows 용 Node 는 폴더 복사만으로 동작)
#     app\                       ← 프로젝트(소스 + node_modules + 로컬 DB). 작업 잡파일·비밀 값은 뺀다.
#
# 비밀 값은 옮기지 않는다. .env.local 에서 로컬 신원 두 줄(LOCAL_ERP_USER_EMAIL / _NAME)만 새 파일로 쓴다.
# 클라우드플레어 토큰·구글 개인키·OAuth 토큰은 시연에 필요 없고, USB 분실 때 유출 범위를 키우기만 한다.
#
# 사용:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Package-XDNodeDemo.ps1 -Destination E:\XDNODE-Demo
#        -SkipAudio  : 면접 녹음 저장소(.wrangler\state\v3\r2, 약 175MB)를 뺀다. 개인정보 민감도가 높은 자료다.
param(
  [Parameter(Mandatory = $true)] [string] $Destination,
  [switch] $SkipAudio
)

$ErrorActionPreference = "Stop"
$ProjectPath = Split-Path -Parent $PSScriptRoot
$AppPath = Join-Path $Destination "app"
$NodeSource = Split-Path -Parent (Get-Command node.exe).Source
$NodeTarget = Join-Path $Destination "runtime\node"

function Invoke-Robocopy([string] $Source, [string] $Target, [string[]] $ExtraArgs) {
  # robocopy 는 0~7 이 성공(복사됨/차이 없음)이고 8 이상이 실패다.
  $arguments = @($Source, $Target, "/E", "/MT:16", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NP") + $ExtraArgs
  & robocopy @arguments | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "복사 실패 ($LASTEXITCODE): $Source → $Target" }
}

function Get-FolderSizeMB([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  $bytes = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  return [math]::Round(($bytes / 1MB), 0)
}

$driveRoot = Split-Path -Qualifier $Destination
if ($driveRoot -and -not (Test-Path -LiteralPath "$driveRoot\")) { throw "대상 드라이브를 찾을 수 없습니다: $driveRoot" }
# 로컬 DB 파일 경로는 app\ 아래로 약 130자가 더 붙는다. 전체가 260자를 넘으면 workerd 가 DB 파일을 열지 못해
# 화면은 뜨지만 모든 API 가 500 을 낸다(긴 임시 폴더에서 실제 재현됨). USB 루트처럼 짧은 경로를 권한다.
if (($AppPath.Length + 130) -gt 250) { throw "대상 경로가 너무 깁니다($($Destination.Length)자). USB 루트(예: E:\XDNODE-Demo)처럼 짧은 경로를 지정해 주세요." }
New-Item -ItemType Directory -Path $AppPath, $NodeTarget -Force | Out-Null

Write-Host "[1/6] 프로젝트 소스 복사 (작업 잡파일·비밀 값 제외)..." -ForegroundColor Cyan
# 이전 작업 세션의 산출물(스냅샷 tar, council 리포트, 분석 스크립트 등)은 앱과 무관하다. CLAUDE.md 의 설명과 같다.
# build\ 는 vite.config.ts 가 ./build/sites-vite-plugin 을 불러오므로 반드시 포함한다(빌드 산출물이 아니라 플러그인 소스다).
$excludeDirs = @(
  ".git", "node_modules", ".wrangler", ".vinext", ".next", "dist", "outputs", "recovery", "tmp", "tmp_modelb_refresh",
  "work", "work_compensation_update", "work_id_management", "work_incentive", "work_incentive_report",
  "analysis", "deliverables", "council_incentive_review", "examples", "__pycache__", ".claude", ".pnpm-store"
) | ForEach-Object { Join-Path $ProjectPath $_ }
# 이름 패턴 제외(robocopy /XD 는 와일드카드를 받는다): 이전 세션의 분석 캐시(.codex_analysis, .codex-sheet-analysis 등, 수백 MB).
$excludeDirPatterns = @(".codex*", "council_*", "work_*")
$excludeFiles = @("*.tar.gz", ".env*", "council-*", "*.py", "*.docx", "*.xlsx", "*.log")
Invoke-Robocopy $ProjectPath $AppPath (@("/XD") + $excludeDirs + $excludeDirPatterns + @("/XF") + $excludeFiles)

Write-Host "[2/6] node_modules 복사 (약 1GB, 파일이 많아 가장 오래 걸립니다)..." -ForegroundColor Cyan
Invoke-Robocopy (Join-Path $ProjectPath "node_modules") (Join-Path $AppPath "node_modules") @()

Write-Host "[3/6] 로컬 DB 복사..." -ForegroundColor Cyan
$stateSource = Join-Path $ProjectPath ".wrangler\state\v3"
$stateTarget = Join-Path $AppPath ".wrangler\state\v3"
Invoke-Robocopy (Join-Path $stateSource "d1") (Join-Path $stateTarget "d1") @()
if ($SkipAudio) {
  Write-Host "      면접 녹음 저장소(r2)는 -SkipAudio 로 제외했습니다." -ForegroundColor DarkYellow
} elseif (Test-Path -LiteralPath (Join-Path $stateSource "r2")) {
  Invoke-Robocopy (Join-Path $stateSource "r2") (Join-Path $stateTarget "r2") @()
}

Write-Host "[4/6] Node.js 런타임 복사 ($NodeSource)..." -ForegroundColor Cyan
Invoke-Robocopy $NodeSource $NodeTarget @()

Write-Host "[5/6] 시연용 .env.local 작성 (로컬 신원 두 줄만)..." -ForegroundColor Cyan
$envSource = Join-Path $ProjectPath ".env.local"
$identity = @()
if (Test-Path -LiteralPath $envSource) {
  $identity = @(Get-Content -LiteralPath $envSource | Where-Object { $_ -match '^(LOCAL_ERP_USER_EMAIL|LOCAL_ERP_USER_NAME)=' })
}
if ($identity.Count -lt 2) { throw ".env.local 에서 LOCAL_ERP_USER_EMAIL / LOCAL_ERP_USER_NAME 을 찾지 못했습니다. 시연 PC 에서 로그인 화면이 뜨게 됩니다." }
$envLines = @(
  "# 시연용 최소 설정. 원본 .env.local 의 토큰·개인키는 의도적으로 옮기지 않았다.",
  "# 아래 계정은 erp_user_access 와 대조되어 역할이 정해진다(로컬 단독 실행에서만 쓰임)."
) + $identity
[System.IO.File]::WriteAllLines((Join-Path $AppPath ".env.local"), [string[]]$envLines, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "[6/6] 실행 파일·안내문 작성..." -ForegroundColor Cyan
# .cmd 는 코드페이지 문제를 피하려고 ASCII 만 쓴다. 동봉한 Node 를 PATH 앞에 두어 시연 PC 의 설치 여부와 무관하게 만든다.
$launcher = @(
  "@echo off",
  "set ""PATH=%~dp0runtime\node;%PATH%""",
  "powershell -NoProfile -ExecutionPolicy Bypass -File ""%~dp0app\scripts\Start-XDNodeERP.ps1""",
  "if errorlevel 1 pause"
)
[System.IO.File]::WriteAllLines((Join-Path $Destination "XD NODE ERP 시연 시작.cmd"), [string[]]$launcher, [System.Text.Encoding]::ASCII)

$readme = @(
  "XD NODE ERP 시연 패키지",
  "",
  "[시작]",
  "1. 이 폴더 전체를 시연 PC 의 C:\XDNODE-Demo 처럼 짧은 경로로 복사한 뒤 실행하는 것을 권장합니다.",
  "   폴더 경로가 길면(예: 바탕화면 아래 여러 단계 하위 폴더) 데이터 파일을 열지 못해 화면만 뜨고 내용이 비어 보일 수 있습니다.",
  "   USB 에서 바로 실행해도 되지만 첫 기동(의존성 준비)이 USB 속도에 좌우되어 수 분 걸릴 수 있습니다.",
  "2. 'XD NODE ERP 시연 시작.cmd' 를 더블클릭합니다. 검은 창이 뜨고 준비가 끝나면 브라우저가 자동으로 열립니다.",
  "   첫 기동은 최대 5분까지 기다립니다. Windows 방화벽 허용 창이 뜨면 '허용'을 누릅니다.",
  "3. 다른 기기(태블릿 등)에서 보려면 시연 PC 의 IP 로 http://<시연PC IP>:3000 에 접속합니다.",
  "",
  "[포함된 것]",
  "- 이 데스크탑의 인사·재무·영업 데이터(로컬 DB) 그대로. 인터넷 없이 동작합니다.",
  "- Node.js 런타임(runtime\node). 시연 PC 에 Node 를 설치할 필요가 없습니다.",
  "",
  "[동작하지 않는 것]",
  "- AI 어시스턴트, 이력서 AI 분석, AI 면접질문 생성: 시연 PC 에 Claude CLI 가 설치·로그인돼 있어야 합니다.",
  "  없으면 해당 버튼만 '연결 실패' 안내가 뜨고 나머지 기능은 정상입니다.",
  "- 영업 구글 시트 동기화: 자격증명을 옮기지 않았습니다.",
  "",
  "[주의]",
  "- DB 에 재직자 인적 사항과 지원자 이력서 원문이 들어 있습니다. USB 는 암호화(BitLocker To Go)하고 시연 후 파기하세요.",
  "- 시연 중 입력한 데이터는 이 폴더의 DB 에만 남고 원본 데스크탑에는 반영되지 않습니다."
)
[System.IO.File]::WriteAllLines((Join-Path $Destination "README.txt"), [string[]]$readme, (New-Object System.Text.UTF8Encoding($true)))

Write-Host ""
Write-Host "완료: $Destination" -ForegroundColor Green
Write-Host ("  app (node_modules 포함): {0} MB" -f (Get-FolderSizeMB $AppPath))
Write-Host ("  runtime\node          : {0} MB" -f (Get-FolderSizeMB $NodeTarget))
Write-Host "  시연 PC 에서 'XD NODE ERP 시연 시작.cmd' 를 더블클릭하세요. 자세한 절차는 README.txt 에 있습니다."
