# XDnode management LAN 운영 runbook (R3·R4)

> 근거: Plan `docs/01-plan/features/xdnode-management.plan.md` §2.1 R3(M5a, 운영 전환 순서), D10·D15·D16·D18·D19·D21.
> Design `docs/02-design/features/xdnode-management.design.md` §7(보안), §8.4(수동 시나리오), §11.5(운영 설계), 부록 C #7·#8·#25.
> R4(M5b): 무인 기동(`-Headless`)·Stop·백업·복구·Deploy·작업 스케줄러는 §1.1·§1.2와 §9~§13에 있다.
>
> 이 문서에는 비밀값을 적지 않는다. 환경변수와 파일은 이름만 적는다.

## 1. 구성 요약

| 항목 | 값 |
|------|-----|
| 운영 폴더 | `C:\xdm\prod` (D18). 검증된 R3 태그를 checkout해 빌드하고 여기서만 서빙한다 |
| 점검 인스턴스 | `C:\xdm\staging`, 포트 3001. SC-4처럼 데이터를 되돌릴 수 없게 바꾸는 점검에만 쓰고 끝나면 지운다 |
| 개발 폴더 | 저장소 작업 폴더. `npm run dev` = `vinext dev` `127.0.0.1:3100`(D16). R3 전환 10단계 뒤에는 운영 데이터 원본이 아니다 |
| 운영 런타임 | `vinext build` → `vite preview --host 0.0.0.0 --port 3000 --strictPort`(`npm run serve:lan`) |
| 서버 PC 점검용 | `npm run start` = `vite preview --host 127.0.0.1 --port 3000 --strictPort` |
| 브리지 | 3120(이력서), 3130(어시스턴트). 둘 다 `127.0.0.1` 전용. 3110 Codex 브리지는 띄우지 않는다 |
| 열리지 않아야 하는 포트 | 9229·9230(인스펙터, `inspectorPort:false`). 8765 견적 툴은 건드리지 않는다 |
| 시작 | R4부터 `Start-ScheduledTask XDnodeManagement-Autostart` 하나(§9). 작업이 없을 때만 `powershell -ExecutionPolicy Bypass -File scripts\Start-XDNodeManagement.ps1` (점검 인스턴스는 `-Port 3001`) |
| 정지 | `scripts\Stop-XDNodeManagement.ps1` (§1.2) |
| 백업 | `C:\xdm\backup\yyyy-MM-dd\` + blob 저장소 `C:\xdm\backup\r2-blobs\`, 매일 03:00(§10) |
| 로그·pid | `C:\xdm\logs\xdm-yyyyMMdd.log`(14일), `C:\xdm\run\xdm-management.pid` |

### 1.1 시작 스크립트가 하는 일 (`scripts/Start-XDNodeManagement.ps1`)

1. `netsh interface portproxy show all`에 규칙이 하나라도 있으면 기동하지 않는다(§6).
2. `$env:X_LOCAL_EXPLORER="false"`, `$env:XD_NODE_PROJECT_PATH=<이 폴더>`를 설정한다.
3. `dist\.build-rev`가 `git rev-parse HEAD`와 다르면 `npm run build`(로그: `.vinext\preview\build.log`). `-Rebuild`는 항상 빌드한다.
4. `node scripts\write-dev-vars.mjs`: `.env.local`에서 허용 목록 5개(`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_TRANSCRIPTION_MODEL`, `CLAUDE_BRIDGE_URL`, `CLAUDE_ASSISTANT_BRIDGE_URL`)만 `dist\server\.dev.vars`에 쓴다. 키 이름만 출력한다. `vinext build`는 dist를 매번 지우므로 기동할 때마다 다시 쓴다.
5. preview(3000은 `npm run serve:lan`, 그 밖의 포트는 같은 옵션의 `vite preview`)를 띄우고 포트가 열릴 때까지 기다린다. preview를 띄운 `cmd.exe`의 pid를 `C:\xdm\run\xdm-management.pid`(3000) 또는 `xdm-management-<포트>.pid`에 쓴다.
6. 브리지 3120·3130을 띄운다(이미 떠 있으면 건너뛴다). pid는 `xdm-bridge-3120.pid`·`xdm-bridge-3130.pid`.
7. 헬스체크: `GET http://127.0.0.1:<포트>/api/me`가 **401**이면 정상이다. 아니면 실패(종료 코드 1).
8. R4: `-Headless`(작업 스케줄러용)면 Read-Host와 브라우저가 없다. `-Headless` 없이 3000에 실행했는데 `XDnodeManagement-Autostart` 작업이 등록돼 있으면, 직접 띄우지 않고 그 작업을 실행한 뒤 브라우저만 연다(기동 경로 하나, §9).

로그(R4): `C:\xdm\logs\xdm-yyyyMMdd.log`(Start·Stop·Backup·Deploy 공용), `preview-<포트>-<시각>.log(.err)`, `bridge-resume-*.log`, `bridge-assistant-*.log`, `build-*.log`. 14일이 지나면 시작할 때 지운다. 로그에는 요청 본문·Cookie·비밀값을 남기지 않는다.

### 1.2 정지 (`scripts/Stop-XDNodeManagement.ps1`, R4)

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\xdm\prod\scripts\Stop-XDNodeManagement.ps1
```

- pid 파일로 `taskkill /T /F /PID <pid>`(workerd까지. `/T`가 없으면 `workerd.exe`가 남아 D1 파일을 잡고 있다). pid 파일을 쓴 뒤에 시작한 프로세스(pid 재사용)는 끄지 않는다.
- 3초 뒤에도 포트가 열려 있으면 그 포트를 LISTEN 하는 `node.exe`·`workerd.exe`를 끈다(포트 대체 경로). 다른 이름의 프로세스(견적 툴 등)는 건드리지 않는다.
- 브리지 3120·3130은 `-Port 3000`을 끌 때만 끈다(`-KeepBridges`로 남길 수 있다). `-Port 3001`(점검 인스턴스)은 운영 브리지를 남긴다.
- 종료 코드 0 = 대상 포트가 모두 닫힘, 1 = 아직 열려 있음. 확인: `netstat -ano | findstr LISTENING`.

### 1.3 지원하지 않는 런타임

- `wrangler dev`, `vinext start`는 쓰지 않는다. local-peer 플러그인이 실리지 않아 `x-xdm-peer`를 위조할 수 있고, `vinext start`는 D1·R2 바인딩이 없어 모든 API가 500이다.
- `vinext dev`를 `0.0.0.0`으로 띄우지 않는다(D16). 비상시에도 LAN 노출은 preview로만 한다.

## 2. 방화벽

- 규칙 `XDnode management 3000 (LAN)`: 인바운드 TCP 3000, Profile=Private, R0에 **꺼 둔 채로** 만들었다. 이 앱의 인바운드 규칙은 이것 하나다.
- R3 전환 7단계에서 RemoteAddress를 점검 PC IP로 바꿔 켜고, 8단계에서 `LocalSubnet`으로 넓힌다. 그대로 켜면 곧바로 LocalSubnet 전체에 열린다.
- `XDnode management 3001 (staging)`은 점검 동안만 만들고(RemoteAddress = 점검 PC IP) 끝나면 지운다.
- 브리지 3120·3130에는 규칙을 만들지 않는다(localhost 전용). 서버 PC에는 고정 LAN IP를 준다.
- 게스트망·공용 Wi-Fi에는 서버 PC를 연결하지 않는다(평문 HTTP, §7.2).

## 3. 첫 관리자 만들기 (부트스트랩)

- 계정이 0개일 때 한 번만 된다. **서버 PC 브라우저의 `http://localhost:3000`에서만** 만든다(점검 인스턴스는 `http://localhost:3001`).
- 서버 PC에서도 LAN IP(`http://192.168.x.x:3000`)로 열면 비루프백이라 거부된다(403 `BOOTSTRAP_LOCAL_ONLY`).
- 방화벽 3000 규칙을 **끈 채로** 만든다. 계정이 하나라도 생기면 이 경로는 영구히 닫힌다(409 `BOOTSTRAP_CLOSED`). 이후 계정은 계정 관리 탭에서만 만든다.
- 막는 층: Node(local-peer 플러그인, 비루프백 403) → Worker(교차 출처 비GET 403) → 라우트(`peerOf().loopback` 재확인) → DB(원자적 INSERT).

## 4. 운영 폴더와 데이터 이전 (R3 전환 순서, 업무 시간 밖, 수동)

사용자와 함께 한다. 이 순서는 자동화하지 않는다.

1. 개발 폴더에서 `npm run lint`·`npm test`가 통과한 커밋에 R3 태그를 단다.
2. 운영 폴더 준비: `C:\xdm\prod`에 clone → R3 태그 checkout → `npm ci` → `npm run build`. 운영 폴더 `.env.local`에는 허용 목록 5개 키만 둔다. 롤백용으로 개발 폴더 `.env.local`의 `LOCAL_ERP_USER_EMAIL`·`LOCAL_ERP_USER_NAME` 두 줄을 저장소 밖에 따로 보관한다.
3. 개발 폴더의 dev 서버와 브리지를 `taskkill /T`로 정지한다(workerd 포함).
4. 데이터 이전(한 번만): 개발 폴더 `.wrangler\state\v3` 전체를 저장소 밖 날짜 폴더(R3 직전 스냅샷)와 `C:\xdm\prod\.wrangler\state\v3`에 복사한다. `node scripts/verify-state-snapshot.mjs <사본> --compare <다른 사본>`으로 원본·두 사본의 integrity·행 수·R2 수를 비교한다. 하나라도 다르면 멈춘다(SC-13).
5. 방화벽 3000 규칙을 끈 채 운영 폴더에서 `Start-XDNodeManagement.ps1`을 실행한다. R4 전까지는 대화형 세션에 묶여 있으므로 로그오프하지 않는다(화면 잠금만). R4 뒤에는 §9의 작업으로만 기동한다.
6. 서버 PC의 `http://localhost:3000`에서 첫 관리자를 만든다(§3). 기존 HR 직원 조회, R2 녹음 1건 다운로드, HR 전사 1건(`.dev.vars` 확인)으로 이전을 확인한다.
7. 3000 규칙의 RemoteAddress를 점검 PC IP로 바꿔 켜고, 점검 PC에서 운영 데이터를 바꾸지 않는 스모크(§5)를 한다. SC-4는 점검 인스턴스(§5.2)에서 한다.
8. 규칙을 `LocalSubnet`으로 넓힌다. LAN이 열리고 D16 기간이 끝난다.
9. 계정을 발급한다(§7).
10. 이전이 확인되면 개발 폴더의 원본 `.wrangler\state`를 저장소 밖 보관 폴더로 옮긴다. 이후 개발 폴더는 빈 DB나 백업 사본으로 시작한다.

**롤백**: 운영 preview·브리지 정지 → 3000 규칙 끄기 → 운영 폴더를 R2 태그로 checkout → 2단계에서 보관한 `LOCAL_ERP_USER_*` 두 줄을 운영 폴더 `.env.local`에 다시 넣기 → R2 태그의 시작 스크립트로 dev를 `127.0.0.1`에 기동(D16 상태). 인증 테이블은 추가만 했으므로 남겨도 된다. 데이터가 손상됐을 때만 4단계 스냅샷을 복구한다.

## 5. 스모크 체크리스트

### 5.1 운영(7단계, 점검 PC와 서버 PC) — 운영 데이터를 바꾸지 않는다

점검 PC(`<서버IP>`는 서버 PC LAN IP):

- [ ] 부트스트랩 403: `curl -s -o NUL -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "x-xdm-peer: 127.0.0.1" -H "Origin: http://<서버IP>:3000" -d "{}" http://<서버IP>:3000/api/auth/bootstrap` → 403
- [ ] explorer 404(Host 위조 포함): `curl -s -o NUL -w "%{http_code}" -H "Host: localhost" http://<서버IP>:3000/cdn-cgi/explorer/api/d1/database` → 404
- [ ] `/__debug` → 404
- [ ] SC-9: `/.wrangler/…`, `/app/page.tsx`, `/xdnode-erp-v1.tar.gz` → 404 또는 403. `/.dev.vars`, `/server/.dev.vars`, `/dist/server/.dev.vars`, `/.env.local`, `/wrangler.json` → 404. (상태 코드만 본다. 본문을 받지 않는다: `-o NUL`)
- [ ] `Upgrade: websocket` 요청은 응답 없이 끊긴다: `curl -s -o NUL -w "%{http_code}" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://<서버IP>:3000/` → `000`
- [ ] 로그인, HR 직원 조회, 어시스턴트 질문 1건, 이력서 분석 1건(SC-5). 브리지 Origin·Host 검사가 LAN에서도 유지되는지 확인한다
- [ ] URL을 조작해도 숨긴 탭에 들어가지 못한다(권한 없는 계정)

서버 PC:

- [ ] `netstat -ano | findstr ":9229 :9230"`에 LISTENING이 없다
- [ ] `netsh interface portproxy show all` 출력이 비어 있다
- [ ] 견적 툴(8765)이 요청 헤더(쿠키)를 로그에 남기지 않는다(R-2)

### 5.2 SC-4 점검 인스턴스 (운영 DB에서는 하지 않는다)

1. `C:\xdm\staging`에 같은 R3 태그를 두고, 4단계 스냅샷 사본(또는 빈 DB)을 `.wrangler\state\v3`에 둔다.
2. `Start-XDNodeManagement.ps1 -Port 3001`. 서버 PC `http://localhost:3001`에서 점검용 첫 관리자를 만든다.
   SC-4의 성과 이의제기(13.3~13.5)는 **본인**만 낼 수 있고 본인 판정은 인사기록에 연결된 계정만 하므로, SC-4를 돌리는 계정은 인사기록에 연결해 둔다(연결되지 않은 계정이면 그 단계는 SKIP, 종료 코드 3). 빈 DB라면 첫 `--phase main`이 만든 합성 직원(`sc4-…-a`)에 연결한 관리자 계정을 계정 관리에서 만들고(첫 로그인 때 비밀번호 변경), 그 계정으로 SC-4를 한 번 더 돈다.
3. 3001 규칙(Private, RemoteAddress=점검 PC IP)을 켜고 점검 PC에서 실행한다. 로그인은 `scripts/xdm-login.mjs`가 한다:
   ```
   set XDM_EMAIL=<점검용 관리자 이메일>
   set XDM_PASSWORD=<비밀번호>
   node scripts/sc4-hr-regression.mjs --base http://<서버IP>:3001 --phase main --state sc4-state.json
   (서버 정지) node scripts/sc4-hr-regression.mjs --offline-prep C:\xdm\staging\.wrangler\state --state sc4-state.json
   (서버 시작) node scripts/sc4-hr-regression.mjs --base http://<서버IP>:3001 --phase due --state sc4-state.json
   ```
   이미 받은 쿠키가 있으면 `--cookie xdm_session=…`(또는 `SC4_COOKIE`)로 로그인을 건너뛴다. 스크립트는 쓰기 요청에 `Origin: <base>`를 붙인다.
4. 끝나면 3001 규칙과 점검 인스턴스(데이터 사본 포함)를 지운다.

## 6. portproxy·리버스 프록시 금지

- 서버 PC에 리버스 프록시나 포트 포워딩(`netsh interface portproxy` 등)을 두지 않는다. 두면 LAN 요청이 루프백(`127.0.0.1`)에서 온 것으로 보여, 부트스트랩 제한과 D21 로그인 잠금 예외가 LAN에 열린다.
- 시작 스크립트는 portproxy 규칙이 있으면 기동하지 않는다. 스모크 때도 확인한다(§5.1).

## 7. 계정 운영

- 계정은 관리자가 계정 관리 탭에서 만든다. 임시 비밀번호는 한 번만 보이고, 첫 로그인 때 바꿔야 한다.
- **스크립트 계정**(`import-leave-ledger.mjs`, `restore-known-data.mjs`, SC-4): 계정을 만든 뒤 **브라우저로 한 번 로그인해 UI에서 비밀번호를 바꿔 둔다.** 비밀번호 변경이 필요한 계정이면 `xdm-login.mjs`가 거부한다.
  - 실행할 때만 `XDM_EMAIL`·`XDM_PASSWORD`를 환경변수로 준다. 파일에 저장하지 않는다.
  - `node scripts/xdm-login.mjs --base http://127.0.0.1:3000`은 쿠키 한 줄을 출력한다. 30일 세션이므로 파일·채팅에 남기지 말고, 끝나면 로그아웃하거나 계정 관리의 세션 강제 종료로 폐기한다.
- 자리를 여러 사람이 함께 쓰면 반드시 로그아웃한다(세션 30일, R-8). 퇴사·분실 때는 계정 비활성화나 세션 강제 종료를 쓴다.

### 7.1 잠금과 복구

- LAN에서 5번 틀리면 5분 잠긴다(429 `LOCKED`). 서버 PC(`http://localhost:3000`)에서 하는 로그인은 잠금을 건너뛴다(D21). 실패는 감사에 `lockExempt:true`로 남는다. 서버 PC는 자리를 비울 때 화면을 잠근다.
- 복구 수단
  1. 서버 PC에서 로그인(D21). 성공하면 LAN 잠금도 풀린다.
  2. 다른 관리자가 계정 관리에서 `UNLOCK`.
  3. **`scripts/reset-admin-password.mjs`**(앱을 멈춘 상태에서만):
     ```
     node scripts/reset-admin-password.mjs --email <이메일> --state C:\xdm\prod\.wrangler\state
     ```
     대상 폴더를 쓰는 서버(pid 파일 또는 127.0.0.1:3000, 개발 폴더면 3100)가 떠 있으면 거부한다. 잠금 해제, 임시 비밀번호 1회 표시, `must_change_password=1`, 세션 전부 폐기, 감사 `ACCOUNT_PASSWORD_RESET_OFFLINE`을 한다.

## 8. 알려진 한계 (수용)

- **평문 HTTP(D10, R-1)**: 같은 망에서 비밀번호와 세션 쿠키를 도청할 수 있다. Private 프로필·LocalSubnet만 허용하고, 게스트망에 연결하지 않고, 의심되면 세션을 강제 종료한다.
- **보안 컨텍스트가 아님(§5.6)**: LAN PC는 `http://<IP>`로 접속하므로 `getUserMedia`(면접 녹음)는 서버 PC에서만 된다. 복사·임의 id는 대체 경로로 동작한다. 필요하면 PC별 브라우저 정책 `OverrideSecurityRestrictionsOnInsecureOrigin`을 쓴다.
- **부수효과 GET(R-3)**: `GET /api/hr/employee-records`의 도래일 반영(`applyDue*`)과 `GET /api/compensation`의 `applyDueRetirements`는 GET에서 실행된다. http LAN에서는 교차 사이트 GET을 구분할 수 없지만, 두 동작은 멱등이고 공격자는 응답을 읽을 수 없다.
- **계정 존재 노출(R-7)**: 없는 이메일은 항상 401이고 잠기지 않는다. 그래서 LAN에서 5회 뒤 429가 나오면 그 계정이 있다는 뜻이다. 사내 이메일은 이미 알려져 있어 수용한다.
- **쿠키는 포트를 구분하지 않는다(R-2)**: 같은 호스트의 견적 툴(8765)이 `xdm_session`을 받는다. CSRF는 Origin 검사로 막고, 견적 툴이 헤더를 기록하지 않는지 확인한다.
- **접속 주소는 IP로 안내한다**: DNS rebinding 방어가 Vite의 호스트 검사에 달려 있어 `allowedHosts`에 PC 이름을 넣지 않는다(부록 C #8). `http://<PC이름>:3000`은 403이다.
- **의존성 업그레이드(R-15)**: vite·@cloudflare/vite-plugin·vinext를 올린 뒤에는 `npm test`(local-peer-plugin, lan-exposure-guards)와 §5.1 스모크를 다시 한다.
- **백업은 정지 후 복사다(R4)**: 매일 03:00에 서버가 1~2분 멈춘다. 온라인 백업(`VACUUM INTO`)은 쓰지 않는다.

## 9. 작업 스케줄러와 기동 경로 (R4, D19)

- 작업 두 개(`scripts/Register-XDNodeManagementTasks.ps1`, **관리자 PowerShell**, 사용자와 함께 한 번):
  - `XDnodeManagement-Autostart`: 시스템 시작 시(1분 지연), 서버 사용자, **로그온 여부와 관계없이 실행(암호 저장)**, 실패하면 5분 간격 3회 재시도, 실행 시간 제한 없음, 겹쳐 실행하지 않음. 동작 = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\xdm\prod\scripts\Start-XDNodeManagement.ps1 -Headless`. 스크립트는 헬스체크 뒤 끝나고 서버 프로세스는 남는다.
  - `XDnodeManagement-Backup`: 매일 03:00, 같은 사용자. 놓친 실행을 나중에 몰아서 돌리지 않는다(업무 시간 정지 방지). 2시간 제한.
  - `XDNODE 견적서 서버` 작업은 건드리지 않는다.
  - 다시 실행하면 두 작업을 덮어쓴다. `-WhatIf`는 정의만 출력한다. 암호는 `Get-Credential`로 받아 작업 스케줄러에만 넘긴다(S4U는 브리지의 Claude CLI 자격 증명을 읽지 못하므로 쓰지 않는다).
  - 암호는 **Windows 로그인 비밀번호**다(PIN·Windows Hello 불가, 빈 암호 불가). 계정은 서버 사용자(`DESKTOP-HVUV0RL\user`)이고 `CodexSandbox*` 계정이 아니다. 계정 선택 창이 헷갈리면 `$cred = New-Object PSCredential("DESKTOP-HVUV0RL\user", (Read-Host -AsSecureString))` 뒤 `& ...\Register-XDNodeManagementTasks.ps1 -Credential $cred`.
  - **Windows 비밀번호를 바꾸면 이 스크립트를 다시 실행한다.** 저장된 옛 암호로는 두 작업이 로그온 실패로 돌지 않는다(자동 기동·03:00 백업 모두).
- **기동 경로는 하나다**: 재부팅·백업 재기동·Deploy·수동 재기동은 모두 `Start-ScheduledTask XDnodeManagement-Autostart`로 한다. 대화형 세션에서 스크립트를 직접 띄우지 않는다(로그오프하면 서버가 같이 멈추고, 세션 종류가 달라 브리지 자격 증명 동작도 달라진다). 바탕화면 바로가기(Start 스크립트, `-Headless` 없음)는 작업이 있으면 알아서 작업을 실행한다.
- **감독자(R4.2)**: 작업이 '로그온 여부와 관계없이' 띄운 프로세스는 다른 로그온 세션(대화형 창, Deploy, 03:00 백업)에서 `taskkill`하면 '액세스가 거부되었습니다'로 끌 수 없다(2026-09-29 첫 Deploy가 이것으로 exit 3). 그래서 `Start -Headless`는 끝나지 않고 감독자로 남고(작업 상태 '실행 중'이 정상), `Stop`은 `C:\xdm\run\stop-<포트>.request`를 써서 감독자가 같은 세션에서 끄게 한다. 감독자가 없거나(`xdm-supervisor-<포트>.pid` 없음) 응답하지 않으면 예전처럼 pid 파일·포트로 끈다. 그래도 액세스 거부면 관리자 PowerShell에서 Stop을 실행하거나 재부팅한다.
- **총무 알림(GA1)**: `XDnodeManagement-Alerts`(매일 09:00)가 `scripts\Run-GaAlerts.ps1`을 부르고, `Start -Headless`도 ready 직후 한 번 부른다. 같은 날 두 번째부터는 서버가 건너뛴다(`xdm-yyyyMMdd.log`의 `ga-alerts:` 줄). 작업은 `Register-XDNodeManagementTasks.ps1`을 다시 실행하면 생긴다(Windows 비밀번호 입력). 알림 채널 '총무 알림'의 멤버는 실행 때마다 총무 탭 보기 이상 계정으로 맞춘다. 총무 첨부는 R2 `ga/` 접두사로 백업에 포함된다.
- 수동 재기동: `Stop-XDNodeManagement.ps1` → `Start-ScheduledTask XDnodeManagement-Autostart` → `C:\xdm\logs\xdm-yyyyMMdd.log`에 `ready: ... -> 401`.
- 상태 확인: `Get-ScheduledTaskInfo XDnodeManagement-Autostart`(LastTaskResult 0), `Get-ScheduledTaskInfo XDnodeManagement-Backup`.
- 적용 때 확인: 관리자 권한 없이 `Start-ScheduledTask XDnodeManagement-Autostart`가 되는지(백업 작업·Deploy·바로가기가 이 호출을 쓴다). 안 되면 작업의 보안 설정에서 서버 사용자에게 실행 권한을 준다.
- **대체안(D19)**: 재부팅 리허설(§13 9단계, SC-12)에서 로그온 없이 브리지가 자격 증명 오류로 실패하면 `Register-XDNodeManagementTasks.ps1 -Mode Logon`으로 다시 등록한다. 자동 기동은 '로그온 시' 트리거, 두 작업 모두 '사용자가 로그온할 때만 실행'이 된다. Windows 자동 로그온은 사용자와 함께 따로 켜고(예: Sysinternals Autologon), 서버 PC 화면 잠금 등 물리 보안 보완책을 정한다. 같은 리허설을 다시 한다.
- 전원(사용자와 함께, 관리자): `powercfg /change standby-timeout-ac 0`, `powercfg /change hibernate-timeout-ac 0`, Windows Update 사용 시간 08:00~20:00.

## 10. 백업 (`scripts/Backup-XDNodeManagement.ps1`, R4)

```
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\xdm\prod\scripts\Backup-XDNodeManagement.ps1 [-MirrorRoot E:\xdm-backup]
```

순서(Design §11.5.8. 기록을 서버 정지 중에 하려고 검증·기록을 재기동보다 앞에 둔다):

1. `Stop-XDNodeManagement.ps1`로 정지하고, state의 sqlite 파일 잠금이 풀릴 때까지 기다린다(최대 60초).
2. `C:\xdm\prod\.wrangler\state\v3` 아래 모든 `*.sqlite`·`-wal`·`-shm`(d1과 r2 메타데이터)을 `C:\xdm\backup\yyyy-MM-dd\v3\`로 복사한다. 같은 날 다시 돌면 `yyyy-MM-ddTHHmm`. 경로는 120자 이하.
3. R2 본문 blob을 `C:\xdm\backup\r2-blobs\`로 `robocopy /E`(증분, 지우지 않음).
4. `verify-state-snapshot.mjs <날짜폴더>\v3 --out backup-report.json --blob-store r2-blobs`: 사본 read-only 검사(integrity_check, 테이블별 행 수, R2 객체 수, R2 객체 본문이 blob 저장소에 모두 있는지). 보고서에는 개수와 무결성만 있다. 그 뒤 사본에 `attrib +R`.
5. `verify-state-snapshot.mjs --record-run`: 멈춘 운영 D1의 `ops_backup_runs`에 한 행(성공·실패 모두). pid 파일의 프로세스가 살아 있거나 3000이 열려 있으면 거부한다.
6. `Start-ScheduledTask XDnodeManagement-Autostart` → 헬스체크 401(백업이 실패해도 재기동은 한다).
7. 성공한 날만 날짜 폴더를 14개로 줄인다. blob 저장소는 지우지 않는다.
8. `-MirrorRoot`가 있으면 날짜 폴더와 blob 저장소를 2차 매체로 복사한다(매체는 물리적으로 보관).

- 성공 = 복사 완료 + integrity ok + 보고서 기록 + R2 본문 누락 0. `.env.local`은 넣지 않는다.
- 종료 코드: 0 성공, 1 백업 실패(기록됨), 2 재기동 실패, 3 거부(개발 폴더, 운영 폴더 안의 백업 경로, 다른 백업 실행 중).
- 개발 폴더(문서 폴더 아래 작업 사본)는 대상으로 받지 않는다. 리허설은 `%TEMP%` 같은 곳의 가짜 운영 폴더로 `-ProdRoot … -BackupRoot … -RunDir … -LogRoot … -Port <빈 포트> -Restart None`.
- **관리자 화면 경고**: 계정 관리 탭이 `GET /api/admin/backups`를 읽는다. 36시간 넘게 성공이 없으면 "마지막 백업 성공: yyyy-MM-dd HH:mm. 36시간 넘게 성공한 백업이 없습니다.", 마지막 실행이 실패면 그 사유를 띄운다. 정지 단계에서 실패하면(서버가 떠 있어 기록 불가) 행이 남지 않으므로 36시간 뒤 stale 경고로 드러난다. 그때는 `C:\xdm\logs\xdm-yyyyMMdd.log`의 `backup:` 줄을 본다.
- `C:\xdm\*` ACL은 서버 사용자로 제한한다. 백업에는 급여·비밀번호 해시·세션 해시가 들어 있다.

## 11. 복구 (SC-7)

1. `Stop-XDNodeManagement.ps1`.
2. 현재 state를 저장소 밖으로 옮겨 둔다: `robocopy C:\xdm\prod\.wrangler\state C:\xdm\snapshots\pre-restore-yyyyMMdd-HHmm /E`.
3. 복구할 날짜 폴더의 `v3`를 복사한다: `robocopy C:\xdm\backup\<날짜>\v3 C:\xdm\prod\.wrangler\state\v3 /E`, 이어서 blob: `robocopy C:\xdm\backup\r2-blobs C:\xdm\prod\.wrangler\state\v3\r2 /E`.
4. 복사본의 읽기 전용 속성을 푼다: `attrib -R C:\xdm\prod\.wrangler\state\v3\* /S`.
5. `Start-ScheduledTask XDnodeManagement-Autostart` → 로그인, HR 직원 조회, 녹음 1건 다운로드.
6. 리허설은 운영이 아니라 새 폴더(점검 인스턴스 `C:\xdm\staging`, 포트 3001)에 3~4단계를 해서 확인한다. 복구본을 멈춘 상태에서 `verify-state-snapshot.mjs <복구본 v3>`의 integrity·행 수·R2 객체 수가 그날 `backup-report.json`과 같아야 한다. 끝나면 staging과 3001 규칙을 지운다. R5 뒤에 채팅 기록·첨부로 한 번 더 한다.
   - 2026-10-01 실행(채팅 포함): `git clone --no-checkout <개발 폴더> C:\xdm\staging` → 운영과 같은 태그 checkout → `npm ci`(`.env.local`은 복사하지 않는다) → 3~4단계 → 개발 폴더의 `verify-state-snapshot.mjs`로 비교(차이 0) → `Start-XDNodeManagement.ps1 -Port 3001 -Headless`(브리지는 운영 것을 같이 쓴다) → `/api/me`가 `UNAUTHENTICATED`(빈 DB면 `BOOTSTRAP_REQUIRED`)인지 확인 → 서버 PC InPrivate 창에서 `http://127.0.0.1:3001` 확인(쿠키는 포트를 구분하지 않으므로 InPrivate) → `stop-3001.request`로 정지 → staging 삭제. 다음에는 총무 첨부도 확인한다.

## 12. 배포 (`scripts/Deploy-XDNodeManagement.ps1`, R4)

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\xdm\prod\scripts\Deploy-XDNodeManagement.ps1 -Tag <태그>
```

- 업무 시간 밖에 한다. lint·test는 개발 폴더에서 태그를 달기 전에 한다(운영 폴더에서 `npm test`를 돌리지 않는다: build가 dist를 지운다).
- 순서: 태그 확인(`git fetch --tags`, 작업 트리 깨끗함) → Stop → 정지 후 스냅샷 `C:\xdm\snapshots\deploy-<태그>-yyyyMMdd-HHmm\`과 검증 → `git checkout --detach <태그>` → (lock이 바뀌었으면) `npm ci` → `npm run build` → `write-dev-vars.mjs`와 `dist\.build-rev` → `Start-ScheduledTask` → 헬스체크 401.
- 실패하면 직전 커밋으로 다시 빌드해 같은 경로로 올린다(종료 코드 1). 그것도 실패하면 2: §11 복구나 수동 기동.
- 중단 시간(Stop부터 헬스체크까지)을 `xdm-yyyyMMdd.log`와 `C:\xdm\logs\deploy-history.log`에 남긴다.
- 대상은 `C:\xdm\prod`·`C:\xdm\staging`뿐이다. 개발 폴더나 그 밖의 경로는 아무것도 하기 전에 거부한다(종료 코드 3). 자동 기동 작업이 없어도 거부한다.

## 13. R4 적용 순서 (운영, 업무 시간 밖, 사용자와 함께)

**UAC** 표시는 관리자 권한 PowerShell이 필요한 단계다.

1. 개발 폴더에서 `npm run lint`·`npm test`가 통과한 커밋에 R4 태그를 단다.
2. 운영 폴더에 R4 코드를 올린다. 이때는 작업이 없어 Deploy가 거부하므로 수동으로 한다: 서버 PC 대화형 세션에서 운영 preview·브리지 정지(R3 방식 `taskkill /T`, 또는 R4 태그의 `Stop-XDNodeManagement.ps1`) → 정지 후 스냅샷 `C:\xdm\snapshots\r4-pre-yyyyMMdd-HHmm\`과 `verify-state-snapshot.mjs` → `git -C C:\xdm\prod fetch --tags` → `git -C C:\xdm\prod checkout --detach <R4 태그>` → (lock이 바뀌었으면) `npm ci` → `npm run build` → `node scripts\write-dev-vars.mjs`.
3. `C:\xdm\run`, `C:\xdm\logs`, `C:\xdm\backup`을 만들고 ACL을 서버 사용자로 제한한다(**UAC**, `icacls`).
4. **UAC**: `Register-XDNodeManagementTasks.ps1`(기본 `-Mode Startup`, 서버 사용자 암호 입력).
5. `Start-ScheduledTask XDnodeManagement-Autostart` → 로그에 `ready`, 다른 PC에서 로그인·HR 조회, 어시스턴트·이력서 분석 1건씩. 계정 관리 탭에 백업 경고(아직 성공 없음)가 보이는 것이 정상이다.
6. 백업 1회: `Start-ScheduledTask XDnodeManagement-Backup` → `C:\xdm\backup\<오늘>\backup-report.json`, 계정 관리 탭 경고가 사라짐(`GET /api/admin/backups` `stale:false`). 중단 시간을 로그로 확인한다.
7. 복구 리허설(§11 6단계, SC-7).
8. **UAC**: 전원 설정(§9).
9. 재부팅 리허설(SC-12): 재부팅 후 **로그온하지 않은 채로** 다른 PC에서 로그인 화면, `xdm-yyyyMMdd.log`의 `ready`, 어시스턴트·이력서 분석 응답. 실패하면 대체안(§9, **UAC** 재등록 + 자동 로그온).
10. 첫 03:00 백업 뒤와 첫 Deploy 뒤에도 어시스턴트·이력서 분석을 확인한다(SC-12). 첫 Deploy에서 중단 시간을 한 번 재서 기록한다.

**롤백(R4)**: `Disable-ScheduledTask XDnodeManagement-Autostart`, `Disable-ScheduledTask XDnodeManagement-Backup`(필요하면 **UAC**), 그 뒤 R3 방식(대화형 세션에서 Start 스크립트. 작업이 비활성이면 스크립트가 작업에 넘기지 않고 직접 띄운다)으로 수동 기동. 데이터 영향은 없다(`ops_backup_runs`는 추가만 한 표).
