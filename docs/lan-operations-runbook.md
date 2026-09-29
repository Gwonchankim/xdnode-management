# XDnode management LAN 운영 runbook (R3)

> 근거: Plan `docs/01-plan/features/xdnode-management.plan.md` §2.1 R3(M5a, 운영 전환 순서), D10·D15·D16·D18·D19·D21.
> Design `docs/02-design/features/xdnode-management.design.md` §7(보안), §8.4(수동 시나리오), §11.5(운영 설계), 부록 C #7·#8·#25.
> R4에서 무인 기동(`-Headless`)·Stop·백업·Deploy·작업 스케줄러를 이 문서에 더한다.
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
| 시작 | `powershell -ExecutionPolicy Bypass -File scripts\Start-XDNodeManagement.ps1` (점검 인스턴스는 `-Port 3001`) |

### 1.1 시작 스크립트가 하는 일 (`scripts/Start-XDNodeManagement.ps1`)

1. `netsh interface portproxy show all`에 규칙이 하나라도 있으면 기동하지 않는다(§6).
2. `$env:X_LOCAL_EXPLORER="false"`, `$env:XD_NODE_PROJECT_PATH=<이 폴더>`를 설정한다.
3. `dist\.build-rev`가 `git rev-parse HEAD`와 다르면 `npm run build`(로그: `.vinext\preview\build.log`). `-Rebuild`는 항상 빌드한다.
4. `node scripts\write-dev-vars.mjs`: `.env.local`에서 허용 목록 5개(`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_TRANSCRIPTION_MODEL`, `CLAUDE_BRIDGE_URL`, `CLAUDE_ASSISTANT_BRIDGE_URL`)만 `dist\server\.dev.vars`에 쓴다. 키 이름만 출력한다. `vinext build`는 dist를 매번 지우므로 기동할 때마다 다시 쓴다.
5. preview(3000은 `npm run serve:lan`, 그 밖의 포트는 같은 옵션의 `vite preview`)를 띄우고 포트가 열릴 때까지 기다린다.
6. 브리지 3120·3130을 띄운다(이미 떠 있으면 건너뛴다).

로그: `<폴더>\.vinext\preview\preview.log(.err)`, `claude-resume-bridge.log`, `claude-assistant.log`.

### 1.2 정지 (R4 전까지 수동)

- preview를 띄운 `cmd.exe`/`node.exe`를 `taskkill /T /F /PID <pid>`로 끈다. `/T`가 없으면 `workerd.exe`가 남아 D1 파일을 잡고 있다.
- 브리지도 같은 방식으로 끈다. 정지 뒤 3000·3120·3130이 LISTEN 상태가 아닌지 `netstat -ano | findstr LISTENING`으로 확인한다.

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
5. 방화벽 3000 규칙을 끈 채 운영 폴더에서 `Start-XDNodeManagement.ps1`을 실행한다. R4 전까지는 대화형 세션에 묶여 있으므로 로그오프하지 않는다(화면 잠금만).
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
