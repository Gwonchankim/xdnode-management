# xdnode-management Planning Document

> **Summary**: XD NODE ERP를 경영지원실 5~6명용 종합 툴 "XDnode management"로 재편한다. 지금 열려 있는 노출을 먼저 닫는다. 그다음 재무·영업·결재를 걷어내고, 계정별 탭 권한과 사내 메신저(Slack형)를 붙인다. 배포는 릴리스 R0~R6로 나눈다.
>
> **Project**: XDnode management (현 `site-creator-vinext-starter`)
> **Version**: 0.2.0
> **Author**: gc.kim (Claude Code 협업)
> **Date**: 2026-09-23
> **Status**: Draft
> **PRD**: [docs/00-pm/xdnode-management.prd.md](../../00-pm/xdnode-management.prd.md) — 결정 D1~D11은 PRD §6.1·§6.2
> **Review**: v0.1을 코드와 대조한 검토 33건과 검토 질문 답변 D16~D19(2026-09-23)를 반영했다

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 지금 앱은 접속자 전원을 한 사람(`LOCAL_ERP_USER_EMAIL`, 최고 권한)으로 처리한다. 그래서 누가 무엇을 했는지 구분되지 않는다. 검토해 보니 노출은 앞으로의 위험이 아니라 이미 열려 있었다. dev 서버가 `0.0.0.0:3000`에 떠 있어서 LAN의 누구나 Miniflare explorer로 D1에 SQL을 실행할 수 있었다. `.wrangler` sqlite·소스·tar.gz를 받을 수 있었고, 급여·연락처가 든 클라이언트 번들도 받을 수 있었다. AI 어시스턴트 브리지는 저장소 파일(`.env.local`의 토큰과 Google 개인키, 직원 명부)을 읽을 수 있었다. LAN 바인딩은 2026-09-23에 `127.0.0.1`로 닫았다(D16). 그 밖에 쓰지 않는 재무·영업·결재 기능이 화면과 코드의 절반 이상을 차지하고, 팀 대화는 도구 밖에 흩어져 있다. |
| **Solution** | R0에서 남은 노출(explorer, 정적 서빙, 방화벽, 브리지 파일 읽기, 읽힌 비밀값)을 Design을 기다리지 않고 닫는다. R1에서는 먼저 보관 태그와 정지 후 스냅샷을 남긴다. 그다음 HR의 숨은 결합(결재 7흐름, 결재 테이블 직접 SQL, 급여 재무 연결 등)을 끊고, 직원 PII를 서버 전용으로 옮긴 뒤 재무·영업·결재를 삭제한다. R3에서는 세 가지를 한 번에 배포한다. 관리자가 발급하는 계정과 30일 세션, 탭별 숨김/보기/편집 권한과 같은 규칙의 서버 검사, `vite preview` 운영 전환이다. LAN은 첫 관리자를 만든 뒤에야 연다. 운영은 별도 폴더에서 돌린다(D18). R4에서 백업·자동 기동을 자동화하고, R5에서 2~3초 폴링 방식의 Slack형 메신저 MVP를 붙인다. |
| **Function/UX Effect** | 로그인하면 허용된 탭만 보인다. 숨긴 탭은 DOM에 없고 그 탭의 API도 403이다. 직원 개인정보와 급여는 권한 검사를 거친 API로만 내려온다(브라우저 JS 번들에 실데이터 없음). AI 어시스턴트는 권한 검사를 거친 JSON 맥락으로만 답한다. HR·임금계산 업무 화면에서 바로 채널·DM으로 대화하고 파일을 넘긴다. 제품 이름은 전부 "XDnode management"로 바뀐다. |
| **Core Value** | 경영지원실 5~6명이 한 도구, 한 계정 체계, 사무실 PC 한 대로 안전하게 일하고 소통한다. 급여는 권한 있는 사람만 본다. 모든 변경은 실제 사용자 이름으로 감사 기록에 남는다. 서버 PC가 재부팅돼도 서버가 스스로 올라오고, 검증된 백업으로 복구할 수 있다. |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 접속자 전원이 같은 신원(최고 권한)이라 책임 추적이 안 된다. 급여·인사 데이터 노출이 실제로 열려 있었다(LAN explorer·파일 서빙, 번들 PII, 어시스턴트 파일 읽기). 불필요한 재무·영업·결재 기능. 팀 대화 분산 |
| **WHO** | 경영지원실 5~6명. 계정·권한 관리는 관리자 1명(gc.kim)이 직접 한다. R3 운영 전환 전까지는 서버 PC에서만 쓴다(D16) |
| **RISK** | ① 지금 닫는 중인 노출: dev `0.0.0.0` 바인딩(2026-09-23 `127.0.0.1`로 닫음, D16), 기본으로 켜진 Miniflare explorer(D1 임의 SQL), dev의 저장소 파일 서빙(`.wrangler` sqlite·소스·tar.gz), 클라이언트 번들의 급여·PII, 어시스턴트 브리지의 저장소 파일 읽기와 그 경로로 읽힌 비밀값. R0·R1에서 닫고, 키는 폐기한다 ② 제거 작업이 HR을 깨뜨림(결재 7흐름의 부수효과, 결재 테이블 직접 SQL 5곳, 급여 재무 연결 3곳 등) ③ 탭만 숨기고 API·번들·어시스턴트로 데이터가 샘 ④ 첫 관리자 헤더 위조, 로그인 잠금 경쟁 ⑤ 서버 PC 한 대가 단일 장애점 |
| **SUCCESS** | 권한 없는 탭 DOM 미존재 + 해당 API 403 / `dist/client` 실데이터 0건 / 다른 PC에서 explorer·저장소 파일 404·403 / 어시스턴트가 파일 내용을 내놓지 않음 / 첫 관리자 위조·교차 출처 POST 차단 / 감사 actor = 실제 로그인 사용자 / 채팅 3초 이내 전달 / 백업 복구·재부팅 리허설 성공 / `npm run lint`·`npm test` 통과 / HR 회귀 없음 |
| **SCOPE** | R0 즉시 보안(바인딩 완료) → R1=M1 제거 + PII 분리 → R2=M2 리네임 → **R3=M3+M4+M5a 한 번에**(계정·탭 권한·preview 전환·운영 폴더 이전, 이때 LAN 개방) → R4=M5b 백업·자동 기동 → R5=M6 메신저 → R6=M7 폴더 리네임. 릴리스마다 태그, 정지 후 스냅샷, 롤백 절차를 둔다 |

---

## 1. Overview

### 1.1 Purpose

XDnode management를 경영지원실 전용 종합 툴로 만든다. 이번 사이클에서 할 일은 여섯 가지다.
1. 지금 열려 있는 노출을 닫는다.
2. 재무·영업·결재 기능을 걷어낸다.
3. 사람별 계정과 탭 권한을 세운다.
4. 서버 PC 운영을 별도 폴더, 자동 백업, 자동 기동으로 굳힌다.
5. 사내 메신저를 붙인다.
6. 제품 이름을 바꾼다.

견적서 자동화 툴은 이번 범위가 아니다. 툴이 안정화되면 탭 하나로 쉽게 붙일 수 있는 구조만 만들어 둔다.

### 1.2 Background

- 운영 형태: 지금은 사무실 PC 한 대에서 `vinext dev`와 로컬 D1/R2 시뮬레이션을 돌린다. 2026-09-23부터 `127.0.0.1`에만 바인딩해 서버 PC에서만 쓴다(D16). R3부터는 별도 운영 폴더에서 `vinext build` + `vite preview`로 돌리고(D18), 같은 사무실 PC들이 LAN으로 접속한다. 사외 접속은 없다(D10).
- 신원 체계: 지금은 Sign-in-with-ChatGPT 헤더를 쓰고, 헤더가 없으면 `LOCAL_ERP_USER_EMAIL` 한 명으로 대체한다(`app/chatgpt-auth.ts`). 권한은 역할 6종과 정적 `rolePermissions` 맵이다(`app/erp-platform.ts:24`). 이메일이 인사기록에 없으면 403으로 거부한다(`app/erp-platform.ts:217`).
- 검토 결과: v0.1을 코드와 대조한 검토에서 33건이 나왔다. 핵심은 다섯 가지다.
  1. 노출은 이미 열려 있었다. dev가 `0.0.0.0`에 떠 있었고 방화벽은 모든 프로필에서 인바운드를 허용했다. explorer는 기본으로 켜져 있었다. 저장소 파일이 서빙됐고, 클라이언트 번들에 급여 PII가 들어 있었고, 어시스턴트 브리지는 파일을 읽을 수 있었다.
  2. `vinext start`는 D1·R2 바인딩이 없어서 운영에 쓸 수 없다.
  3. M3·M4·M5는 따로 배포할 수 없다.
  4. 첫 관리자를 '서버 PC 자신'에서만 만들게 하는 판정은 Worker 안에서 할 수 없다.
  5. HR에 숨은 결재·재무·영업 결합은 v0.1이 적은 3건보다 훨씬 많다.
- 사용자 결정: PRD §6.1·§6.2의 D1~D11, Plan 체크포인트의 D12~D15, 검토 질문 답변 D16~D19가 모두 구속력을 가진다.

| ID | 결정 (2026-09-23) |
|----|-------------------|
| D12 | **권한은 상위 탭 단위로만** 부여한다: HR, 임금 계산, 메신저, 감사 로그, 계정 관리. HR 안의 하위 메뉴 15개(급여관리 포함)는 따로 나누지 않는다. **HR 탭을 받은 계정은 급여관리도 본다.** |
| D13 | 탭마다 **숨김 / 보기 / 편집** 3단계로 부여한다. 편집에는 상태 변경(급여월 승인·마감, 퇴직 처리 등 기존 결재 대상)이 포함된다. |
| D14 | 계정과 인사기록의 연결은 **선택**이다. 인사기록 직원과 연결할 수도 있고, 이름을 직접 입력해 연결 없이 만들 수도 있다. "인사기록에 없으면 403" 규칙은 없앤다. |
| D15 | 세션은 **30일** 유지한다. 비밀번호는 8자 이상, 5회 연속 실패 시 5분 잠금, 관리자가 발급하거나 초기화한 비밀번호는 첫 로그인 때 변경하도록 한다. |
| D16 | (검토 U1 답변) **R3 운영 전환 전까지는 서버 PC에서만 쓴다.** 2026-09-23에 조치를 마쳤다. `scripts/Start-XDNodeERP.ps1`은 이제 dev 서버를 `0.0.0.0` 대신 `127.0.0.1`에 바인딩하고, 실행 중이던 dev 서버도 `127.0.0.1`로 재기동했다. LAN 접속은 R3 운영 전환 순서 안에서, 첫 관리자가 생긴 뒤에만 연다. |
| D17 | (검토 U2 답변) **AI 어시스턴트 브리지는 파일 읽기 기능을 잃는다.** 빈 임시 폴더를 cwd로 실행하고 `Read`·`Grep`·`Glob`을 차단한다. 응답 스키마는 시작할 때 메모리에 올린다. 업무 맥락은 `/api/assistant`가 권한 검사를 마친 뒤 넘기는 JSON으로만 받는다. `scripts/claude-resume-bridge.mjs`와 같은 방식이다. |
| D18 | (검토 U3 답변) **운영은 별도 폴더에서 돌린다**(예: `C:\xdm\prod`). 검증된 태그를 checkout해 빌드하고 그 폴더에서 서빙한다. 개발과 테스트는 지금 폴더에서 한다. 현재 `.wrangler/state`의 데이터를 운영 폴더로 한 번 옮기는 절차를 이 Plan에 둔다(§2.1 R3 운영 전환). |
| D19 | (검토 U4 답변) **재부팅 뒤에는 작업 스케줄러의 '시스템 시작 시' 트리거로 서버를 올린다.** 서버 사용자 계정으로 실행하고 '사용자의 로그온 여부에 관계없이 실행'을 켠다(암호는 작업 스케줄러에 저장). 로그온하지 않은 세션에서 Claude CLI 브리지의 자격 증명이 동작하지 않으면, Windows 자동 로그온 + '로그온 시' 트리거로 바꾼다. 확인 절차는 §2.1 R4에 둔다. |
| D20 | (Design 체크포인트) **설계안은 C(균형)로 한다.** 탭 정의 파일 하나(`app/access-tabs.ts`)를 화면과 서버가 함께 쓰고, `authorizeErpRequest` 시그니처는 유지한 채 내부만 바꾼다. 심사 보완안을 함께 반영한다: 임금 계산 API를 `/api/compensation`으로 분리, HR 상태 전환을 한 파일로 모음, 알 수 없는 모듈은 무조건 거부, 채팅 감사 기록에 본문을 남기지 않음 등 |
| D21 | (Design 체크포인트) **서버 PC(Node가 확인한 루프백 접속)에서 하는 로그인은 잠금 검사를 건너뛴다.** 실패 횟수는 기록한다. D15의 잠금 규칙에 대한 유일한 예외다. 사내망 사용자가 관리자를 계속 잠가 두는 문제(DoS)에 대응한다 |
| D22 | (Design 체크포인트) **`app/incentive-governance.tsx`는 영업 코드와 함께 삭제한다.** D1의 이 파일 유지 문구를 대체한다. 인센티브 계산기(`app/incentive/`)와 임금 계산 탭의 인센티브 모드는 D1대로 유지한다 |
| D23 | (Design 체크포인트) **감사 로그·계정 관리 탭은 관리자 전용이다.** 계정별 숨김·보기·편집은 HR·임금 계산·메신저 3개 탭에만 준다. **어시스턴트 브리지의 접속 허용 주소는 넓히지 않는다.** 다른 PC에서 어시스턴트가 동작한다는 D10의 목표는 앱 서버가 브리지를 대신 부르는 방식으로 달성한다 |
| D24 | (2026-09-28 추가 요청) **총무 탭(자산·회사 서류 관리)은 메신저(R5) 다음 별도 PDCA 사이클로 한다.** 이번 사이클(R1~R6)의 범위는 바꾸지 않는다. 다음 사이클의 범위는 두 가지다. ① 자산: 직원 지급 장비(지급·반납 이력, 퇴직 체크리스트 '자산 반납'과 연결), 사무실 비품·소모품(위치·수량), 계약·구독 자산(라이선스·도메인·리스·보험, 만료일), 회계상 고정자산(취득가·감가상각) ② 회사 서류: 사업자등록증·등기부등본·인감증명서·인증서·허가증의 원본 보관과 만료 알림, 법인인감·서류 반출 대장. 직원 증명서 발급은 요청하지 않았다. 재무 모듈의 고정자산 코드(`app/fixed-assets-workspace.tsx`, `app/api/finance/fixed-assets`, 테이블 3개, 데이터 0건)는 R1에서 예정대로 지운다. 보관 태그 `erp-final-20260923`에서 다시 가져와 총무 탭의 자체 장부로 고쳐 쓴다. 테이블은 D4대로 남는다. 감가상각은 재무 계정과목·전표와 연결하지 않는 총무 장부로 둔다(D2와 충돌하지 않게) |
| D25 | (2026-09-28) **앱 색을 회사 로고 색에 맞춘다.** 기준색: 연두 `#76AD2E`(심볼·XD), 진녹 `#3B4D24`(NODE). 버튼·강조·탭 선택 표시·포커스 색을 이 두 색 계열로 바꾸고, 대비는 WCAG AA(본문 4.5:1)를 지킨다. `r3-shell`에서 로그인·첫 관리자·비밀번호 변경·계정 관리 화면을 만들 때 `:root` 토큰을 함께 바꾼다. 로고 자산은 `public/brand/`(커밋 `625dcdb`) |

**PRD·결정·검토안과 달라지는 부분.** 충돌하면 D1~D19를 따르고 아래에 기록한다.

| 항목 | 충돌 내용 | v0.2 처리 |
|------|-----------|-----------|
| D1 `incentive-governance.tsx` 유지 | 검토는 삭제를 권했다. 이 파일은 어디서도 import하지 않는 고아이고, 호출 대상(`/api/sales/incentives`, 문서 module=sales)이 D2로 사라져 단독으로 동작할 수 없다 | **D1을 따라 삭제하지 않는다.** 마운트하지 않은 채 파일만 남긴다(R1 뒤로는 호출이 404). 삭제 여부는 Design 체크포인트에서 사용자에게 확인한다. D1이 실제로 지키려는 `app/incentive/` 계산기와 임금 계산 탭의 인센티브 모드는 유지한다 |
| D1 인센티브 계산기 vs PRD Workstream R 'ALLOWED_MODULES sales 제거' | `sales`는 인센티브 계산기의 어시스턴트 모드다(`app/compensation-calculator.tsx:621-623`). 지우면 인센티브 AI가 400으로 깨진다 | D1을 유지한다. `sales`를 지우지 않고 `incentive`로 이름만 바꾼다. Workstream R 표의 문구는 이 처리로 대체한다 |
| D2-a "HR 라우트 5개" | 라우트는 5개가 맞지만 결재 흐름은 7개다. operations 한 파일에 인사발령·퇴직·휴가 신청 세 흐름이 있다 | 7개 흐름을 모두 즉시 반영으로 바꾼다(R1) |
| D3 "`app/` 밖 보관", D4 "스냅샷" | 저장소 안에 두면 브리지 Read, dev 정적 서빙, 데모 패키저로 샌다. 서버가 켜진 채 복사하면 스냅샷이 불완전할 수 있다 | 더 엄격하게 적용한다. 재무 실데이터는 작업 트리 밖(archive 태그·브랜치 + 저장소 밖 접근 제한 폴더)에 둔다. 스냅샷은 정지 후 저장소 밖에 뜨고 무결성을 검사한다 |
| D10 "브리지 origin 허용 목록에 서버 LAN 주소 포함" | 브라우저는 같은 출처의 `/api/assistant`만 부르고, Worker가 브리지를 부를 때는 Origin이 붙지 않는다. 허용 목록을 넓히면 브라우저가 권한 검사 없이 브리지를 부를 길이 생긴다. 이는 D17("맥락은 권한 검사를 마친 JSON으로만")과 어긋난다 | D10의 목표(다른 PC에서 어시스턴트 동작)는 유지한다. 허용 목록 확대는 나중 결정인 D17('업무 맥락은 `/api/assistant`가 권한 검사를 마친 JSON으로만')과 충돌하므로 D17을 따른다. 허용 목록은 넓히지 않고, 브리지는 Origin이 붙은 요청을 거부한다. 이 수단 변경은 Design 체크포인트에서 사용자에게 확인한다. PRD T-08의 '(origin 허용 후)'는 삭제한다 |
| D15 "5회 실패 시 5분 잠금" | 검토는 서버 PC(루프백)에서 하는 로그인에 잠금 예외를 두자고 권했다. 관리자가 1명이라 LAN에서 계속 틀리면 관리자가 잠기기(DoS) 때문이다 | **D15를 따라 예외를 두지 않는다.** 다만 관리자가 1명이면 '계정 관리의 잠금 해제'를 쓸 수 없다(잠긴 관리자는 로그인하지 못한다). 잠금은 5분 뒤 풀리지만 LAN 사용자는 5분마다 다시 잠글 수 있고, 즉시 복구는 앱을 멈추고 `reset-admin-password.mjs`를 돌리는 것뿐이다. 원자적 잠금은 잠금을 강제할 뿐 이 DoS를 줄이지 않는다. Design 체크포인트에서 '서버 PC(루프백) 로그인 예외'와 '두 번째 관리자 계정 발급(D7 범위 확인)' 중 하나를 사용자에게 확인한다 |
| PRD T-01 (`LOCAL_ERP_USER_EMAIL`로 첫 관리자 부트스트랩) | preview는 env를 받지 못하고, 이 대체 경로는 R3에서 제거된다 | '계정 0개 + Node가 확인한 루프백 접속'으로 부트스트랩하는 방식으로 고친다 |
| 검토안 SC-4 "다른 PC에서 LAN IP로" | D16에 따라 R3 전까지 LAN은 닫혀 있다. 또 SC-4에는 급여 LOCKED·재오픈, 퇴직 COMPLETED, 성과 최종 확정, 인력계획 SUPERSEDED처럼 되돌릴 수 없는 전이가 들어 있다 | R1에서는 서버 PC에서 실행한다. 최종 판정은 R3 운영 전환 때 점검용 인스턴스(운영과 같은 태그, 운영 데이터 사본과 새 DB)에서 점검용 PC로 한다. 운영 DB에서는 실행하지 않는다 |
| D12·D13 "감사 로그·계정 관리도 계정별 3단계 부여" vs PRD D2-c "감사 탭은 관리자만" | D12는 권한을 주는 상위 탭으로 감사 로그·계정 관리를 들고, D13은 탭마다 숨김·보기·편집을 준다. 그러나 D2-c는 감사 탭을 관리자 전용으로, D7은 계정 관리를 관리자 1명의 일로 정했다. 두 탭을 계정별로 주면 D2-c·D7과 어긋난다 | `audit`·`admin`은 관리자 여부로만 열리고 계정별 부여 대상에서 뺀다. 계정별 숨김·보기·편집은 `hr`·`compensation`·`chat` 3개 탭에 준다. FR-08, SC-2, §4.2 매트릭스도 이 기준으로 적는다. Design 체크포인트에서 사용자에게 확인한다 |
| 검토안 릴리스 계획 "운영 폴더 분리는 R4" | D18: 운영은 별도 폴더에서 돈다. R3부터 preview가 운영이 되는데 같은 폴더에서 돌리면, `npm test`가 build를 먼저 실행하며 dist를 지워 운영이 깨진다 | 운영 폴더 생성과 데이터 이전을 R3 운영 전환 첫 단계로 앞당긴다. R4에는 자동화만 남긴다 |
| 검토안 운영 전환 "다른 PC 스모크 → 방화벽을 연다" 순서 | 방화벽이 닫혀 있으면 다른 PC는 스모크 점검을 할 수 없다 | 규칙을 점검용 PC 1대의 IP로만 먼저 켜서 스모크 점검을 하고, 그다음 LocalSubnet으로 넓힌다 |

### 1.3 Related Documents

- PRD: `docs/00-pm/xdnode-management.prd.md`
- 기존 계획 문서: `docs/erp-platform-plan.md`, `docs/erp-audit-trail-plan.md`, `docs/hr-*-plan.md`
- 프로젝트 가이드: `CLAUDE.md`
- 참조 구현: `scripts/claude-resume-bridge.mjs`(저장소 밖 cwd(`%TEMP%`, `:79`)와 `Read`·`Grep`·`Glob` 차단(`:22-25`)이 D17의 기준이다. 어시스턴트 브리지는 D17대로 시작할 때 새로 만든 빈 임시 폴더를 cwd로 쓴다), `scripts/Start-XDNodeERP.ps1`(D16 적용됨)
- Design 비교 자료(A/B/C 3안, 3개 관점 심사)는 Design 문서 부록으로 옮긴다

---

## 2. Scope

### 2.1 In Scope

모듈은 M1 제거 → M2 리네임 → M3 계정·세션 → M4 탭 권한 → M5 LAN 운영(M5a 런타임 전환, M5b 운영 자동화) → M6 메신저 → M7 폴더 리네임이다. 배포는 아래 릴리스 R0~R6 단위로 한다.

**공통 원칙** (모든 릴리스)
- 배포 전에 git 태그를 단다.
- 서버와 브리지를 완전히 정지한 뒤(`taskkill /T`로 workerd까지 종료) 상태 스냅샷을 떠서 **저장소 밖**에 보관한다.
- 스키마 변경은 추가만 한다. DROP은 하지 않는다(D4).
- 롤백은 직전 태그로 되돌리고, 필요할 때만 직전 스냅샷을 복구한다.
- 단계마다 `npm run lint && npm test`가 통과해야 한다.
- R3부터는 운영 폴더에서만 배포하고(D18), 업무 시간 밖에 한다.

#### R0. 즉시 보안 조치 (Design을 기다리지 않는다)

앱 기능 코드는 바꾸지 않는다. 어시스턴트의 파일 읽기만 없어진다(D17).

- [x] **바인딩(D16, 2026-09-23 완료)**: `scripts/Start-XDNodeERP.ps1:53`이 dev 서버를 `--hostname 127.0.0.1`로 띄운다. 실행 중이던 dev 서버도 `127.0.0.1`로 재기동했다. LAN 접속은 R3 운영 전환에서 첫 관리자가 생긴 뒤에만 연다
- [x] explorer 끄기(2026-09-23 완료): `vite.config.ts`의 `defineConfig` 콜백 첫 줄에 `process.env.X_LOCAL_EXPLORER = "false"`를 넣었다(`??=`가 아닌 일반 대입). 시작 스크립트에서도 같은 환경변수를 설정한다. 근거: `node_modules/@cloudflare/vite-plugin/dist/index.mjs:30508-30511`의 기본값이 true다. 확인: `Host: localhost`로 `/cdn-cgi/explorer/api/d1/database` → 404
- [x] `server.fs.deny` 확장(2026-09-23 완료). 기본값(`.env`, `.env.*`, `*.{crt,pem}`, `**/.git/**`)을 다시 적고, `**/*.tar.gz`와 **프로젝트 루트 기준** `<root>/.wrangler/**`, `<root>/dist/**`, `<root>/deliverables/**`, `<root>/.vinext/**`를 추가했다. 처음 넣은 `**/dist/**`는 `node_modules/vinext/dist`까지 막아 dev 서버가 자기 모듈을 읽지 못했다. 그래서 폴더 패턴은 루트에 묶었다(`vite.config.ts`의 `PROJECT_ROOT`). 확인: `*.tar.gz`·`.vinext` 로그·`.wrangler` 파일 → 403, 폴더 URL → 404. D16으로 dev는 LAN에 열리지 않으므로 이 항목은 심층 방어다. 근본 해결은 R3의 preview 전환이다
- [x] 방화벽 정리(2026-09-23 완료, 관리자 권한 스크립트). 백업 `firewall-backup-20260923-150504.wfw`(세션 스크래치패드). NIC '이더넷'을 Public에서 Private로 바꾼 **뒤** 규칙 18개를 지웠다. 견적 툴은 `XDNODE Quote 8765`(Private) 규칙으로 계속 열려 있게 하려고 이 순서를 택했다. 남은 규칙은 `XDNODE Quote 8765`(켜짐)와 새 `XDnode management 3000 (LAN)`(Private, LocalSubnet, **꺼짐**) 두 개다. 원래 계획은 아래와 같다
  - 지우기 전에 현재 규칙을 내보내 둔다(롤백용)
  - 다음 규칙을 이름으로 지운다: `vinext dev 3000`(Profile Any), `node.exe`·`Node.js JavaScript Runtime` 프로그램 규칙(Public, 전 포트, 예전 demo 폴더의 node.exe 포함), `Codex` 규칙(Public). 견적 툴의 `XDNODE Quote 8765`(Private)는 남긴다(2026-09-23 `Get-NetFirewallRule`로 확인)
  - 새 규칙 `TCP 3000 인바운드, Profile=Private, RemoteAddress=LocalSubnet`은 비활성 상태로 만든다. 이 앱의 인바운드 규칙은 이것 하나다. **R3 운영 전환 전까지는 꺼 둔다**(D16)
  - NIC 네트워크 프로필은 Private로 바꾼다
- [x] 어시스턴트 브리지 격리(D17, 2026-09-23 완료). v0.1에서 M5에 있던 브리지 항목을 R0로 앞당겼다. 확인: `/api/assistant` 실제 호출 200(10초), 답변이 'CONTEXT에 데이터가 없어 접근할 수 없다'고 밝힘
  - `scripts/claude-assistant-bridge.mjs`는 빈 임시 폴더를 cwd로 실행한다. 지금은 저장소 루트다(`:18`, `:123`)
  - `--tools ""`로 내장 도구를 모두 끄고, 호환을 위해 `--disallowed-tools`에 `Read`·`Grep`·`Glob`·`PowerShell`도 넣는다(기존 목록 뒤에 덧붙인다). 어시스턴트는 JSON 맥락만 쓰므로 도구가 필요 없다. 지금 차단 목록(`:31`)은 Bash, Write, Edit, NotebookEdit, WebFetch, WebSearch, Task, TodoWrite뿐인데, 설치된 CLI(2.1.280)에는 이 목록에 없는 `PowerShell` 도구가 있다. 빈 cwd는 절대 경로 읽기를 막지 못하고, 차단 목록 방식은 CLI가 새 도구를 더할 때마다 구멍이 생긴다
  - `claude-resume-bridge.mjs`도 같은 방식(`--tools ""` + 차단 목록에 `PowerShell` 추가)으로 맞춘다
  - '파일을 읽어 근거를 대야 하므로 남긴다'는 주석(`:8-9`, `:30`)은 지운다
  - 응답 스키마와 `buildPrompt`는 시작할 때 메모리에 올린다. `buildPrompt`는 `codex-assistant-bridge.mjs`의 원본에서 읽어 온다(`:45-55`). 요청을 처리하는 동안에는 저장소 파일을 열지 않는다
  - `buildPrompt`에서 '프로젝트 파일'을 검토하라는 지시(`codex-assistant-bridge.mjs:34,36`)는 JSON 맥락만 쓰도록 고친다
  - 업무 맥락은 `/api/assistant`가 권한 검사를 마친 뒤 넘기는 JSON으로만 받는다
  - 영향: 어시스턴트가 소스나 문서를 근거로 인용하던 답변은 사라진다
- [x] (2026-09-23 완료. `localhost:<port>`도 허용한다. 확인: 3120·3130 정상 200, Origin 403, 다른 Host 403) 브리지 3개 모두 `Origin` 헤더가 붙은 요청을 거부하고, `Host`가 `127.0.0.1:<port>`인지 확인한다. 정상 호출은 서버 대 서버라서 Origin이 없다. 지금 이력서 브리지(3120)에는 이 검사가 없다. 브리지 `ALLOWED_ORIGINS`는 넓히지 않는다(§1.2 D10 항목)
- [x] (2026-09-23 완료, 3110 프로세스도 종료) 쓰지 않는 Codex 브리지(3110)는 시작 스크립트에서 뺀다. 파일은 남긴다. 어시스턴트 브리지가 이 파일에서 `buildPrompt`를 읽어 오기 때문이다
- [x] (2026-09-23 완료) 같은 커밋에서 `tests/local-codex-assistant.test.mjs:96-97`의 `$AssistantPort = 3110`·`assistant:bridge` 기동 단언을 '시작 스크립트가 3110을 띄우지 않는다'는 단언으로 바꾼다. 그대로 두면 `npm test`가 실패한다. `:59`의 `DISABLED_TOOLS` 단언은 `Read`·`Grep`·`Glob`·`PowerShell`을 목록 뒤에 덧붙이면 그대로 통과한다
- [x] (2026-09-23 완료: `tests/lan-exposure-guards.test.mjs`, `package.json` test 목록 등록. dev 바인딩·explorer·fs.deny·`GOOGLE_*` 미전달도 함께 지킨다) 소스 가드 테스트: 어시스턴트 브리지 spawn에 저장소 경로 cwd가 없고, spawn 인자에 `--tools`와 빈 문자열이 있으며, `Read`·`Grep`·`Glob`·`PowerShell`이 차단 목록에 있다. 이력서 브리지도 같은 단언을 둔다
- [ ] **사용자 작업: 비밀값 폐기·교체**
  - Google Cloud에서 서비스 계정 개인키를 폐기한다. 이 키는 어시스턴트 브리지로 읽을 수 있었고, 분석 세션 로그에도 출력됐다. 제거 대상인 영업 시트 연동용 키다
  - 영업 시트용 OAuth refresh token을 철회한다
  - `.env.local`과 `vite.config.ts` `localRuntimeVars`에서 `GOOGLE_*`와 영업 전용 변수(`GOOGLE_SALES_SHEET_ID`)를 지운다. 영업 시트 동기화는 이때 멈춘다(`googleSheetsConfigured`가 거짓이 되어 오류 없이 멈춘다). 코드는 R1에서 지운다. **`vite.config.ts` 쪽은 2026-09-23 완료**, `.env.local` 줄 삭제와 Google 콘솔 작업은 남았다
  - `CLOUDFLARE_API_TOKEN` 교체를 검토한다. 어시스턴트가 읽을 수 있었다. 교체한다면 Workers AI 전용 권한의 새 토큰으로 한다
- [ ] 확인(D16 기준)
  - 다른 PC에서 `http://<서버IP>:3000` 접속이 거부된다
  - 서버 PC에서 `curl.exe -H "Host: localhost" http://127.0.0.1:3000/cdn-cgi/explorer/api/d1/database`, `/.wrangler/state/v3/d1/`, `/xdnode-erp-v119.tar.gz`를 호출하면 모두 404 또는 403이다
  - LAN 쪽 같은 점검과 `/app/*.ts` 점검은 R3 운영 전환 스모크(SC-9)에서 한다. dev는 클라이언트 모듈을 소스 경로로 서빙하기 때문이다
- 한계: R3 전까지 서버 PC 사용자는 `LOCAL_ERP_USER_EMAIL` 신원(최고 권한)을 쓴다. 다른 PC는 이 앱을 쓰지 않는다(D16)
- 롤백: `vite.config.ts`와 시작 스크립트 커밋을 되돌리고, 내보내 둔 방화벽 규칙을 복원한다. 단 D16의 `127.0.0.1` 바인딩과 D17의 브리지 격리는 되돌리지 않는다. 브리지가 오동작하면 브리지를 멈춘다

#### R1 = M1. 제거: 재무·영업·결재와 재무용 공용 기능 + HR PII 서버 전용 분리 (D1~D4, D2-개정/a/b/c)

- 게이트: M1에서 바꾸는 즉시 반영 동작은 기존 게이트를 그대로 쓴다(`hr:approve`, `hr:write`, `privileged()`). 권한 의미는 바뀌지 않는다. 운영은 R0 상태(서버 PC 전용 dev, D16)로 계속 돈다
- 삭제 목록의 기준은 Design 부록의 파일 목록이다. 연구 자료의 제거 목록은 120개(라우트 44 + 비라우트 76, `incentive-governance.tsx` 포함)다. 안별 삭제 추정(128~132개)은 여기에 `chatgpt-auth.ts`, `hr/authorized-users` 라우트, 재무 테스트 등을 더한 수이고, 세 안 모두 D1과 달리 `app/incentive/` 페이지까지 넣었다(이 Plan은 D1대로 유지한다). 정확한 수는 Design 부록에서 확정한다
  - 라우트 44개: finance 24, sales 11, 공용 9(`app/api/` 최상위: approvals, approval-settings, data-intake, data-governance, data-integration, master-impact, master-impact-cases, operations, workbench. 이 operations는 유지하는 `hr/operations`와 다른 라우트다)
  - 비라우트: 재무 컴포넌트·라이브러리, `app/sales-*` 19개와 `google-sheets.ts`, 결재·데이터·마스터 영향·워크벤치 파일
  - `app/incentive-governance.tsx`는 D1에 따라 삭제 목록에서 뺀다(§1.2)
- 기능 손실 명시: data-intake를 지우면 HR 직원·급여 엑셀 일괄 가져오기(단계 검증)가 사라진다. 조사 시점의 가져오기 기록은 0건이다. 임금 계산기 자체의 xlsx 업로드는 남는다. 이 손실은 D2(data-intake 삭제)에 따른 것이다

**M1-0. 보관과 사전 조사** (PRD D4 '스냅샷'의 구체화)
- [ ] ① 현재 작업 트리 변경을 커밋한다. 비소스 산출물(tar.gz, council-*, deliverables/, tmp*)은 커밋하지 않는다
- [ ] ② 그 커밋에 태그 `erp-final-20260923`을 달고 `archive/erp-finance-sales-20260923` 브랜치를 만든다
- [ ] ③ 앱과 브리지를 `taskkill /T`로 완전히 정지한다(workerd 포함). 그다음 `.wrangler/state/v3` 전체(D1 .sqlite·-wal·-shm, R2 blobs)를 **저장소 밖** 날짜 폴더에 복사한다
- [ ] ④ 사본을 `node:sqlite`로 열어 `PRAGMA integrity_check`를 돌리고 테이블별 행 수를 기록한다
- [ ] 사전 조회를 기록한다. M1-0에서 한 번 하고, R1 배포 직전에 다시 한다
  - 레거시 대기 행: HR 테이블을 직접 조회한다. `erp_approval_requests`만 보면 안 된다. 대상은 SUBMITTED(인사발령·퇴직·인력계획·채용요청), PENDING(휴가), FINALIZATION_SUBMITTED(성과)다
  - `sales_incentive_payroll_links` 건수: 조사 시점(2026-09-23)에는 0건이었다. 1건 이상이면 그 월의 CONFIRM 재확정을 409로 막고, 처리 방법을 사용자와 정한 뒤 진행한다
  - `payroll:%` 재무 행이 모두 미지급·미전기인지 확인한다. 조사 시점에는 20건 모두 UNPOSTED였다

**M1-1. 결합 끊기** (파일 삭제 전)
- [ ] 결재 의존(D2-a): HR 결재 흐름 **7개**를 '편집 권한자 즉시 반영'으로 바꾼다. 엔진이 하던 부수효과는 각 라우트의 같은 `db.batch` 안으로 옮긴다. 동시성은 `WHERE status IN (<원래 from>, <레거시 대기 상태>)`와 `meta.changes` 검사로 지킨다
  1. 인사발령(operations:277): APPROVED로 INSERT하고 `applyDuePersonnelActions`를 재사용한다
  2. 퇴직(operations:358): IN_PROGRESS로 INSERT하고, 같은 batch에서 정산 DRAFT와 직원 상태 '퇴직 예정'·retirement_json을 반영한다
  3. 휴가 신청(operations:400): APPROVED로 INSERT한다(결정자=행위자)
  4. 급여월 승인(payroll:411-431): 결재 분기를 지우고 일반 전이를 탄다
  5. 성과 최종 확정(performance:249-268): 주기와 CALIBRATED 참여자를 한 batch에서 FINALIZED로 만든다
  6. 인력계획 승인(workforce-plans:225-248): 이전 APPROVED 계획의 SUPERSEDED 전환과 대상의 APPROVED 전환을 한 batch로 처리한다
  7. 채용요청 모집 시작(recruitment-requisitions:179-199,257-285): 인원 검사를 유지하고 OPEN으로 전이한다. `willAutoApproveForSelf`는 지운다. 지금 관리자 1인 환경에서 실제로 보이는 동작(생성 즉시 OPEN)을 유지한다
  - 문장 생성기는 `app/hr-transitions.ts`에 모은다
- [ ] 레거시 대기 상태 처리
  - 즉시 반영 동작은 레거시 상태도 from-state로 받는다
  - HR 화면에서 PENDING 휴가와 SUBMITTED 퇴직·인사발령에 '승인/반려' 버튼을 둔다. 휴가는 기존 `decide()`를 재사용한다
  - '상단 전자결재에서 처리' 문구(`hr-workspace.tsx:2415`)와 퇴직 읽기 전용 배너를 없앤다
  - 테스트: 레거시 상태 행을 넣은 뒤 전이가 성공한다
- [ ] 결재 테이블 직접 SQL 5곳을 지운다: `hr/leave:222-224`, `hr/operations:546-548`, `hr/operations:554`, `hr/payroll:413-416`, `hr/recruitment-requisitions:321-340`. M1-2에서 테이블 생성을 멈추는 커밋과 **같거나 그보다 앞선 커밋**에서 한다
- [ ] 급여 마감·재오픈의 재무 연결 3곳을 제거한다(D2-b)
  - ensureSchema에서 `finance_expense_requests` CREATE·ALTER를 지운다(`:103-128`)
  - LOCKED 분기는 `hr_payroll_runs` UPDATE, changes 검사, PAYROLL_RUN_LOCKED 감사만 남긴다(`:432-465`)
  - 재오픈 분기는 사유 검사와 `UPDATE … SET status='DRAFT' … WHERE status IN ('APPROVED','LOCKED')`만 남긴다. 재무 조회·차단·취소와 재무 감사는 지운다(`:466-503`)
  - `hr-workspace.tsx`의 financeExpenseId 안내를 지운다
- [ ] 임금 계산의 영업 결합: `app/api/hr/compensation/route.ts:311-339`의 `sales_incentive_payroll_links` 조회와 합산을 지운다. 인센티브는 임금 계산 화면의 입력값만 쓴다
- [ ] `app/api/documents/route.ts`
  - 재무·영업 import와 분기를 지운다(`:4-6`, `:17`)
  - 권한 검사를 `formData()`보다 앞으로 옮긴다(지금은 `:75`에서 formData를 읽고 `:84`에서 인가한다)
  - module 값이 탭 대응표에 없는 행(레거시 finance·sales)은 관리자라도 404로 거부한다(fail closed)
- [ ] 마스터 영향 의존 제거: 서버 쪽 `app/api/hr/organizations/route.ts:4,93-95,113`, UI 쪽 `app/hr-workspace.tsx:13,1991`의 요청 본문, 관련 CSS
- [ ] 어시스턴트: 모듈 `sales`는 제거하지 않고 **`incentive`로 이름을 바꾼다**(D1 유지)
  - 지우는 것: `/api/sales` 조회(`local-codex-assistant.tsx:279-288`)
  - 이름만 바꾸는 것: `compensation-calculator.tsx:621-623`, `page.tsx`, `/api/assistant`의 모듈 목록, 두 브리지의 `ALLOWED_MODULES`
  - `tests/local-codex-assistant.test.mjs`는 같은 커밋에서 고친다
- [ ] `ERPTopNavigation`에서 ApprovalCenter 마운트와 approval 작업 처리를 지운다(`app/page.tsx:26,437`). 이 내비를 쓰는 HR 셸도 회귀 대상에 넣는다
- [ ] `hr-workspace.tsx` 설정에서 '전자결재 규칙' 섹션과 `ApprovalSettings`를 지운다(`:4588-4747`). "결재 대기"·결재 ID를 보여 주는 UI와, 뷰 3개의 결재 상태 라벨도 지운다
- [ ] 기존 버그 수정: 성과 이의제기 '수용' 버튼(`performance-management-view.tsx:62-66`)이 'ACCEPTED' 대신 'RESOLVED'를 보내도록 고친다. 서버는 'RESOLVED'와 'REJECTED'만 받는다(`performance/route.ts:413`). 동작 테스트를 추가한다

**M1-2. 플랫폼 정리**
- [ ] `ensureErpPlatformSchema`에서 `erp_approval_*`, `erp_tasks`, `erp_sync_runs` 생성을 멈춘다. 각 라우트의 `ensureSchema`에서도 재무·영업·결재 테이블 생성만 멈춘다. 기존 테이블은 DROP하지 않는다(D4)
- [ ] `app/erp-platform.ts`에서 재무 전용 헬퍼(`blockedFinancePeriods`, `isFinancePeriodLocked`)와 `FINANCE_ADMIN`·`SALES_ADMIN`을 제거한다
- [ ] 검증: 결재·재무 테이블이 없는 새 DB 하니스에서 휴가 삭제·결정, 급여 승인, 채용요청 삭제가 500 없이 성공한다

**M1-3. 셸 정리와 PII 분리**
- [ ] `app/page.tsx`에서 재무·영업 모듈과 죽은 코드를 정리한다. `audit-log-workspace.tsx`를 다시 마운트한다. 유일한 import처인 data-governance-center가 삭제 대상이기 때문이다. R3 전에는 기존 역할 게이트를 쓰고, R3부터 관리자 전용 감사 탭이 된다(D2-c). `/api/audit-log`의 모듈 라벨은 과거 finance·sales 행을 읽을 수 있게 남긴다
- [ ] `app/hr-company-data.ts`를 둘로 나눈다
  - 조직·직급·직책 카탈로그: 클라이언트에서 써도 되는 모듈
  - 직원 명부·보상 시드: `import "server-only"`를 선언한 서버 전용 모듈. 서버 사용처는 `app/api/hr/analytics/route.ts:4`, `authorized-users/route.ts:2`다
  - 이 파일은 실제 회사 데이터라 분리할 때 값이 바뀌지 않았는지 대조한다
- [ ] `hr-workspace.tsx`의 `initialEmployees`는 `[]`로 시작해 `/api/hr/employee-records`로 채운다. 로딩 상태를 넣는다
- [ ] `incentive-calculator.tsx`는 정적 명부 대체값을 없애고, `response.ok`가 아니면 오류를 표시한다
- [ ] 하니스에 `server-only` 스텁을 추가한다

**M1-4. 일괄 삭제와 정리**
- [ ] 삭제 목록의 파일을 일괄 삭제한다. 삭제 전에 삭제 대상 경로를 import·fetch하는 남는 파일이 0개인지 grep으로 확인한다
- [ ] 재무 실데이터(`app/finance-*-data.ts`와 파생 모듈)는 작업 트리 어디에도 두지 않는다. 보관은 두 곳뿐이다
  - archive 태그·브랜치
  - 저장소 밖 접근 제한 폴더. 파일 해시를 기록한다
- [ ] `.env.local`과 `localRuntimeVars`에서 재무 전용 `CLOUDFLARE_AI_MODEL`(재무 어시스턴트·일일 자금 라우트만 사용)을 재무 라우트와 함께 지운다(`GOOGLE_*`는 R0에서 지웠다)
- [ ] 테스트 정리
  - 삭제: `finance-*.test.mjs` 5개(`package.json` 목록에서도 뺀다)
  - `erp-platform.test.mjs`: HR·감사·브리지 가드만 남긴다. 라우트를 이름으로 열거하는 부분은 '변경 라우트는 모두 인가 헬퍼와 `writeErpAudit`를 호출한다'는 가드 하나로 바꾼다. `:1769`가 단언하는 문서 문구는 문서와 같은 커밋에서 바꾼다
  - `workflow-ledgers.test.mjs`: HR 원장만 남긴다. 삭제된 파일을 읽는 케이스는 지운다
  - **회귀 고정점으로 유지**하고 기대값만 즉시 반영 기준으로 고친다: `hr-api-integration:176-185`, `:347-362`, `:400-425`
  - 추가: 7개 흐름별 즉시 반영 테스트, 레거시 from-state 테스트, 'APPROVED·LOCKED 전이 뒤 `erp_approval_*`·`finance_expense_requests` 행 0건' 테스트
  - 추가: `tests/removal-guards.test.mjs`. 삭제된 경로 import 0건, `FINANCE_ADMIN`·`SALES_ADMIN` 0건, `tests/*.test.mjs` 전부가 test 목록에 있는지 확인한다
  - `hr-api-integration`, `rendered-html`, `incentive-calculation` 테스트를 조정한다. RECRUITER 분기와 `hr-dashboard-model` 테스트는 M4에서 정리한다
- [ ] 문서 정리
  - `finance-*-plan.md`, `sales-*-plan.md`, master-impact·데이터 거버넌스·워크벤치 계획 문서는 `docs/archive/`로 옮긴다
  - HR 계획 문서 5개(workforce-planning, recruitment-requisition, leave-management, performance-management, retirement-compensation)는 보관하지 않는다. 결재 흐름 서술을 '즉시 반영' 기준으로 고친다
  - `erp-platform-plan.md`의 재무·영업·결재 절은 '대체됨'으로 표시한다
- [ ] CSS는 규칙 단위로 정리한다. `:root` 토큰은 유지한다

**M1-5. 검증**
- [ ] SC-4 회귀 시나리오를 서버 PC에서 실행한다. 기존 D1 사본(별도 폴더)과 새 DB 양쪽에서 확인한다. 다른 PC 실행은 R3 운영 전환 때 점검용 인스턴스에서 한다(D16)
- [ ] `bundle-exposure.test.mjs`와 `removal-guards.test.mjs`가 통과한다

- 롤백: 정지 → archive 태그 checkout → 필요하면 M1-0 스냅샷을 복구한다. R1 이후 즉시 반영으로 바뀐 HR 상태는 스냅샷 복구로만 되돌아간다. 그래서 스냅샷 복구는 그 사이의 데이터 변경을 잃는 선택이다

#### R2 = M2. 리네임: 표시명과 패키지명 (D11 앞부분)

- [ ] `app/layout.tsx` 제목과 메타 정보를 바꾼다
- [ ] "XD NODE" 문자열이 들어간 약 13개 파일(`app/page.tsx:403,613` 포함)을 바꾼다
- [ ] 시작 스크립트의 표시 문구와 파일명을 바꾼다(예: `Start-XDNodeERP.ps1` → `Start-XDNodeManagement.ps1`). 바탕화면 바로가기도 함께 갱신한다. 이 앱의 작업 스케줄러 작업은 아직 없고 R4에서 새 이름으로 만든다. 기존 `XDNODE 견적서 서버` 작업은 견적 툴(8765)이므로 건드리지 않는다(2026-09-23 `Get-ScheduledTask`로 확인). `Package-XDNodeDemo.ps1`은 R3에서 폐기하므로 이름을 바꾸지 않는다
- [ ] 스크립트 파일명을 바꿀 때 참조 테스트(`erp-platform.test.mjs:985·2543·2554`, `local-codex-assistant.test.mjs:42`)를 같은 커밋에서 고친다
- [ ] `package.json`의 `name`을 `xdnode-management`로 바꾸고 `package-lock.json`을 재생성한다. `engines.node`를 `>=22.15.0`으로 올린다(하니스가 `module.registerHooks`를 쓴다)
- [ ] **변경 금지**: `database_id`(00000000-0000-4000-8000-000000000000)와 `bucket_name`(`site-creator-r2`). 로컬 D1 파일명과 R2 경로가 이 값에서 나오므로, 바꾸면 앱이 빈 DB·빈 버킷으로 조용히 기동된다. 두 값이 그대로인지 확인하는 소스 가드 테스트를 둔다. `XD_NODE_*` 환경변수 이름도 유지한다
- [ ] `README.md`와 `CLAUDE.md`를 갱신한다
- 롤백: 커밋을 되돌린다. 데이터 영향은 없다

#### R3 = M3 + M4 + M5a (한 번에 배포)

- M3·M4·M5a는 같은 브랜치에서 개발해 R3로 한 번에 배포한다. 중간 커밋은 운영 PC에 반영하지 않는다. 따로 내보내면 네 가지가 깨진다
  - preview만 먼저 내면 vars가 `{}`여서 대체 신원이 사라지고, M3가 없으니 전원 401이다
  - dev 위에 M3를 올리면 비밀번호 해시와 세션이 든 sqlite가 dev 정적 서빙에 걸린다
  - M4 없이 M3를 내면 인사기록과 연결되지 않은 계정은 모든 API에서 403이다
  - 탭 권한만 있고 PII 분리(R1)가 없으면 권한을 우회할 수 있다

**M3. 계정·세션** (D7, D14, D15)
- [ ] 계정 테이블: 이메일, 이름, 비밀번호 해시, 인사기록 직원 ID(선택), 관리자 여부, 활성 여부, 첫 로그인 변경 필요 여부, 실패 횟수·잠금 시각
- [ ] 비밀번호 해시는 PBKDF2-SHA256, **반복 100,000회**(workerd 상한), 16바이트 salt로 한다. workerd는 이 상한을 넘기면 실패하지만 Node 하니스에는 상한이 없어서, 테스트는 통과하고 운영에서만 깨질 수 있다
  - 저장 형식: `pbkdf2_sha256$<iter>$<salt>$<hash>`
  - 비교는 상수 시간으로 한다
  - 없는 이메일에도 가짜 해시를 계산해 같은 오류를 돌려준다
  - 반복 횟수가 100,000 이하인지 단언하는 테스트를 둔다
- [ ] 잠금은 원자적으로 처리한다(D15). 검증 전에 `UPDATE … SET failed_attempts=failed_attempts+1, locked_until=CASE WHEN failed_attempts+1>=5 THEN :now+300000 ELSE locked_until END WHERE id=:id AND (locked_until IS NULL OR locked_until<=:now)`로 시도 한 번을 예약하고, `changes=1`일 때만 검증한다. 성공하면 카운터를 0으로 되돌린다
  - 테스트: 오답 20건을 동시에 보내도 검증은 5회 이하이고, 잠금 중에는 정답도 거부한다
  - 서버 PC(루프백) 로그인에도 잠금을 적용한다. 검토가 권고한 루프백 예외는 D15와 충돌해 넣지 않는다(§1.2)
- [ ] 관리자 복구
  - 계정 관리에 '잠금 해제'를 둔다
  - 앱을 멈춘 상태에서 실행하는 `scripts/reset-admin-password.mjs`를 둔다. 잠금을 풀고 임시 비밀번호를 발급하며, 첫 로그인 변경을 요구한다(D15). 운영 문서에 적는다
  - 마지막 활성 관리자는 비활성화하거나 강등할 수 없다
- [ ] 세션
  - 쿠키 `xdm_session`: `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`. **Secure는 붙이지 않는다**. http LAN에서는 브라우저가 Secure 쿠키를 버린다
  - 로그인할 때마다 새 세션 토큰을 발급한다. 쿠키에는 256비트 토큰을, DB에는 SHA-256 해시만 둔다. 유효기간은 30일이다
  - 비밀번호를 바꾸면 다른 세션을 모두 폐기한다. 계정을 비활성화하거나 비밀번호를 초기화하면 해당 계정의 세션을 즉시 폐기한다
- [ ] `mustChangePassword`는 서버가 강제한다. 이 값이 참이면 `/api/me`, 비밀번호 변경, 로그아웃 말고는 모든 API가 403이다
- [ ] CSRF와 보안 헤더
  - 권한 가드와 인증 라우트(로그인, 첫 관리자 만들기, 로그아웃)에서, GET이 아닌 요청은 `Origin`의 host:port가 `Host`와 같아야 통과한다. Origin이 없으면 `Sec-Fetch-Site: same-origin`을 요구하고, 둘 다 없으면 거부한다. vinext의 Origin 검사는 dev에서만 동작한다. 이 검사로 포트만 다른 같은 호스트의 견적 툴(8765) 페이지도 차단된다
  - 부수효과가 있는 GET(예: employee-records GET의 `applyDue*`)은 같은 검사를 적용하거나 POST로 옮긴다
  - `worker/index.ts`에서 모든 응답에 `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`을 붙인다
- [ ] 로그인 게이트는 클라이언트에 둔다. SSR은 중립 셸만 렌더하고, SPA가 `/api/me`를 호출해 401이면 로그인 화면을 보여 준다. 레이아웃과 페이지에서는 D1을 읽지 않는다(`rendered-html.test.mjs`가 DB 없이 worker를 import하기 때문). 로그인·로그아웃·비밀번호 변경 화면을 만든다
- [ ] 첫 관리자 생성은 계정이 0개이고 **Node 쪽에서 확인한 소켓 주소가 루프백일 때만** 허용한다. vite-plugin은 클라이언트의 rawHeaders를 그대로 복사하고, Miniflare는 이미 있는 `CF-Connecting-IP`를 덮어쓰지 않으며, Host도 클라이언트가 정한다. 그래서 Worker 안에서는 판정할 수 없다
  - 로컬 플러그인은 M5a에 둔다
  - 계정 생성은 `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM auth_accounts)`로 하고 `changes === 1`을 확인해 원자적으로 처리한다
  - 테스트: LAN 주소에서 `Host: localhost`, `x-xdm-peer: 127.0.0.1`, `CF-Connecting-IP: 127.0.0.1`을 위조하면 403이다. 동시에 두 번 요청하면 하나만 성공한다
- [ ] `app/chatgpt-auth.ts`의 헤더 신원과 `LOCAL_ERP_USER_EMAIL` 대체 경로를 제거하고 세션 신원으로 교체한다. 기존 호출부 인터페이스(`ErpPrincipal`)를 유지할지는 Design 안 선택에 따른다(A·C는 유지, B는 교체)
- [ ] 권한 가드는 세션으로 신원을 정하고, 인사기록 연결이 없어도 통과한다(D14)
- [ ] 관리자 전용 **계정 관리** 탭: 계정 생성(인사기록에서 고르거나 직접 입력), 탭별 권한 지정, 비밀번호 초기화, 잠금 해제, 비활성화·재활성화. "HR 탭에는 급여관리가 포함됩니다"라고 안내한다
- [ ] 감사: actor는 실제 로그인 계정이다. 로그인 성공·실패·잠금, 첫 관리자 생성, 계정·탭 권한 변경, 비밀번호 초기화, 세션 폐기, 403 거부를 기록한다. 비밀번호·토큰은 기록하지 않고, Node가 확인한 접속 주소를 남긴다

**M4. 탭 권한** (D12, D13)
- [ ] 상위 탭은 `hr`(HR), `compensation`(임금 계산·인센티브), `chat`(메신저), `audit`(감사 로그), `admin`(계정 관리)이다. `audit`과 `admin`은 관리자 계정에만 존재한다(D2-c·D7, §1.2 D12·D13 행. Design 체크포인트에서 확인)
- [ ] 계정별 권한 데이터는 `hr`·`compensation`·`chat`에 대한 `{ 탭: "none" | "view" | "edit" }` 형태다. 관리자는 모든 탭이 편집이다
- [ ] `/api/me`가 `{ user, isAdmin, tabs, mustChangePassword }`를 반환한다. `app/page.tsx`는 `tabs`로 탭 목록과 기본 탭을 정하고, 허용되지 않은 탭 컴포넌트는 렌더하지 않는다. 저장된 탭(localStorage)이 권한 밖이면 첫 허용 탭으로 옮긴다
- [ ] 서버 가드는 탭 권한을 기존 `module:action` 검사에 대응시킨다. 대응표는 Design에서 확정한다
  - `hr:approve`, `recruitment:*`, `privileged()`는 모두 `hr` 탭 편집으로 매핑한다. `isHrManager = isAdmin || hr=edit` 함수 하나로 통일한다
  - 대응표에 없는 모듈 값은 관리자라도 거부한다(fail closed)
  - 탭 권한과 활성 여부는 요청마다 DB에서 읽는다. 세션에 캐시하지 않는다
- [ ] 임금 계산 전용 명부 조회를 만든다. 지금 `incentive-calculator.tsx:332`는 `hr:read`로 보호되는 `/api/hr/employee-records`에서 전화·주소·생년월일이 든 전체 레코드를 받는다
  - 응답은 `{employeeId, name, department, status}`뿐이다
  - `/api/hr/compensation`, 전용 명부, `/api/assistant`의 incentive·compensation 모드는 `compensation` 탭으로 인가한다
  - include=hr 응답에서 birthDate처럼 계산에 필요 없는 필드를 뺀다
  - `/incentive` 단독 페이지는 유지하되(D1), 세션과 compensation 보기 권한이 없으면 열리지 않게 한다
- [ ] 교차 조합 'compensation=edit, hr=none'과 'hr=edit, compensation=none'을 명부, compensation, employee-records, assistant에 대해 매트릭스로 고정한다
- [ ] 연결 없는 계정의 `employeeId`에는 계정 ID에 `acct_` 접두사를 붙여 쓴다. `PUT /api/hr/employee-records`는 `acct_`로 시작하는 id를 400으로 거부한다
- [ ] 기존 역할 6종(`ErpRole`, `rolePermissions`)은 탭 권한으로 대체한다. 기존 `erp_user_access`와 `hr_authorized_users` 행은 새 계정 체계로 옮기지 않는다. 계정은 관리자가 새로 만든다. RECRUITER 분기와 `hr-dashboard-model` 테스트를 정리한다
- [ ] 새 모듈을 붙이기 쉬운 구조로 만든다. 탭 목록·라벨·대응 API 모듈을 한 파일에 정의해서, 견적 탭을 추가할 때 그 파일과 새 라우트만 건드리면 되게 한다(FR-16)

**M5a. 운영 런타임 전환** (D10, D16, D18)
- [ ] 운영 기동은 `vinext build` → `npx vite preview --host 0.0.0.0 --port 3000 --strictPort`로 한다(`npm run serve:lan` 추가). `X_LOCAL_EXPLORER=false`를 강제한다
- [ ] 시작 스크립트를 preview용으로 바꾼다(R3). 순서는 build → `.dev.vars` 작성 → preview(0.0.0.0:3000, explorer off) → 브리지 3120·3130 기동이다. 무인 운영 기능은 R4에서 더한다
  - `vinext start`는 쓰지 않는다. plain Node에서 `fetch(request, undefined, ctx)`를 호출해 D1·R2 바인딩이 없고, 서버 청크 68개가 import하는 `cloudflare:workers`를 Node가 해석하지 못해 모든 API가 500이다
  - `wrangler dev`도 운영 런타임으로 쓰지 않는다. 루프백 판정 플러그인이 실리지 않기 때문이다
- [ ] 개발 서버(`vinext dev`)는 앞으로 `--hostname 127.0.0.1`로만 띄운다(D16). LAN 운영에서도, 비상 대체 경로에서도 `vinext dev 0.0.0.0`은 금지한다
- [ ] 시작 스크립트가 빌드할 때마다 `.env.local`에서 허용 목록 키만 골라 `dist/server/.dev.vars`를 쓴다. preview는 빌드 산출물의 `vars:{}`를 쓰고, `vinext build`는 매번 dist를 지우기 때문이다. 허용 목록은 `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_TRANSCRIPTION_MODEL`, `CLAUDE_BRIDGE_URL`, `CLAUDE_ASSISTANT_BRIDGE_URL`이다. 기동 뒤 HR 전사 1건으로 확인한다
- [ ] 루프백 판정 플러그인: `vite.config.ts`에서 `cloudflare()`보다 앞에 로컬 플러그인을 둔다
  - `configureServer`와 `configurePreviewServer` 양쪽에서 클라이언트가 보낸 `x-xdm-peer`를 `req.headers`와 `req.rawHeaders` 모두에서 지우고, `req.socket.remoteAddress`로 다시 설정한다
  - 비루프백에서 들어온 `/cdn-cgi/*`는 404로 돌려보낸다(explorer가 다시 켜질 때의 이중 방어)
  - Vite HMR이 아닌 `upgrade` 요청은 끊는다
- [ ] 방화벽 최종화: 서버 PC에 고정 LAN IP를 준다. R0에서 만들어 둔 3000 규칙을 운영 전환 순서대로 켠다. 브리지 포트 3120·3130은 localhost 전용을 유지한다. 절차는 운영 문서에 적는다
- [ ] 어시스턴트: `/api/assistant`가 서버에서 브리지를 대신 부르므로 다른 PC에서도 동작한다. 브리지 허용 목록은 넓히지 않는다. R0의 브리지 Origin·Host 검사가 LAN에서도 유지되는지 운영 전환 스모크에서 확인한다
- [ ] http LAN 호환(NFR Compatibility): 클라이언트의 `crypto.randomUUID` 호출부 전부(`compensation-calculator.tsx:61,100,371-373`, `incentive-calculator.tsx:56,171,505`, `local-codex-assistant.tsx:413,539,554`)는 `getRandomValues` 기반 `randomId()`로, clipboard(`hr-workspace.tsx:3346`, `hr-leave-view.tsx:88,214`, `local-codex-assistant.tsx:443`)는 대체 경로가 있는 `copyText()`로 바꾼다. 면접 녹음(`getUserMedia`, `hr-workspace.tsx:2144,2156,2213`)은 서버 PC에서만 지원한다고 안내한다
- [ ] 하니스 개편(§4.2)을 R3와 같은 PR에 넣는다
- [ ] 스크립트 정리
  - `Package-XDNodeDemo.ps1`은 폐기한다. `.wrangler/state`(실제 HR 데이터, R3 뒤에는 인증 테이블까지)를 복사하고 `LOCAL_ERP_USER_EMAIL`에 의존한다
  - `restore-known-data.mjs`는 보관한다
  - `import-leave-ledger.mjs`는 `XDM_EMAIL`·`XDM_PASSWORD`로 로그인해 받은 쿠키로 호출하도록 바꾼다
- [x] 스파이크(2026-09-23 완료, 결과는 §9 1번). preview에서 D1·R2 바인딩과 `.wrangler/state/v3` 경로를 실측했다. `C:\xdm\spike`(현재 빌드 + state 사본 + `node_modules` junction)에서 `vite preview --host 127.0.0.1 --port 3001`로 띄웠고, 끝난 뒤 폴더를 지웠다

**R3 운영 전환 순서** (업무 시간 밖, 수동)
1. 개발 폴더에서 lint·test가 통과한 커밋에 R3 태그를 단다.
2. 운영 폴더를 준비한다(D18). 저장소를 `C:\xdm\prod`에 clone하고 R3 태그를 checkout한 뒤 `npm ci`와 `vinext build`를 실행한다. 운영 폴더의 `.env.local`에는 허용 목록 키만 둔다. 그 전에 롤백용으로 개발 폴더 `.env.local`의 `LOCAL_ERP_USER_EMAIL`·`LOCAL_ERP_USER_NAME` 두 줄을 저장소 밖에 따로 보관한다.
3. 개발 폴더의 dev 서버와 브리지를 `taskkill /T`로 정지한다(workerd 포함).
4. **데이터 이전(D18, 한 번만)**
   - 개발 폴더 `.wrangler/state/v3` 전체(D1 `.sqlite`·`-wal`·`-shm`, R2 메타데이터·blobs)를 저장소 밖 날짜 폴더(R3 직전 스냅샷)와 운영 폴더 `.wrangler/state/v3`에 복사한다.
   - 원본과 두 사본 모두에서 `PRAGMA integrity_check`, 테이블별 행 수, R2 객체 수를 기록하고 서로 비교한다. 하나라도 다르면 멈춘다.
5. 방화벽 3000 규칙을 끈 채 운영 폴더에서 preview(0.0.0.0:3000, explorer off, `.dev.vars`)와 브리지 3120·3130을 기동한다. 브리지의 `XD_NODE_PROJECT_PATH`는 운영 폴더를 가리킨다. R4 전까지는 이 서버가 대화형 세션에 묶여 있다. 서버 PC에서 로그오프하지 않는다(화면 잠금만 한다).
6. 서버 PC 브라우저의 `http://localhost:3000`에서 첫 관리자를 만든다. 그다음 기존 HR 직원 조회, R2 녹음 1건 다운로드, HR 전사 1건으로 이전 결과를 확인한다.
7. R0에서 만든 3000 규칙의 RemoteAddress를 점검용 PC 1대의 IP로 바꾼 뒤 켠다(그대로 켜면 곧바로 LocalSubnet 전체에 열린다). 그 PC에서 운영 데이터를 바꾸지 않는 스모크 점검을 한다.
   - 부트스트랩 경로가 닫혀 있다(403)
   - explorer가 404다(Host 위조 포함)
   - `/.wrangler/…`, `/app/*.ts`, `/*.tar.gz`가 404 또는 403이다(SC-9)
   - 로그인, HR 직원 조회, AI 어시스턴트 질문 1건, 이력서 분석 1건이 동작한다
   - SC-4는 급여 마감·퇴직 처리처럼 운영 데이터를 되돌릴 수 없게 바꾸므로 운영 DB에서 실행하지 않는다. 점검용 인스턴스를 따로 만든다. 저장소 밖 `C:\xdm\staging`에 같은 R3 태그와 4단계 스냅샷 사본(또는 새 DB)을 두고, 운영과 같은 방식(explorer off, `.dev.vars`)으로 preview를 3001번에 띄운다. 서버 PC의 `http://localhost:3001`에서 점검용 인스턴스의 첫 관리자를 먼저 만든다. 3001 규칙(Private, RemoteAddress=점검용 PC IP)을 켜고 그 PC에서 SC-4를 실행한다. 끝나면 3001 규칙과 점검용 인스턴스(데이터 사본 포함)를 지운다
8. 규칙의 RemoteAddress를 LocalSubnet으로 넓힌다. 이 시점에 LAN이 열리고 D16 기간이 끝난다.
9. 계정을 발급한다.
10. 이전이 확인되면 개발 폴더의 원본 `.wrangler/state`는 저장소 밖 보관 폴더로 옮긴다. 이후 개발 폴더는 빈 DB나 백업 사본으로 시작하고, 운영 데이터 원본으로 쓰지 않는다.

- 롤백: 운영 폴더의 preview와 브리지를 정지한다 → 방화벽 3000 규칙을 끈다 → 운영 폴더를 R2 태그로 checkout한다 → 운영 폴더 `.env.local`에 2단계에서 보관한 `LOCAL_ERP_USER_EMAIL`·`LOCAL_ERP_USER_NAME`을 다시 넣는다(R2의 dev는 이 대체 신원이 없으면 로그인을 요구해 모든 API가 401이 된다. R3를 다시 올릴 때 다시 지운다) → R2 태그의 시작 스크립트(`Start-XDNodeManagement.ps1`)로 dev를 `127.0.0.1`에 기동한다(서버 PC 전용, D16 상태로 복귀). 인증 테이블은 추가만 했으므로 남겨도 무해하다. 데이터가 손상됐을 때만 4의 스냅샷을 복구하고, 그 뒤의 변경은 잃는다

#### R4 = M5b. 운영 자동화 (D10, D18, D19, NFR)

R3의 안전성과는 무관하다. 다만 R3 뒤 수동 운영 기간은 짧게 잡는다. 모든 경로는 운영 폴더 기준이다.

- [ ] R3(M5a)에서 preview용으로 바꾼 시작 스크립트에 무인 운영 기능을 더한다
  - `-Headless`(Read-Host 없음, 브라우저 열지 않음)
  - pid 파일 기록
  - 헬스체크: `/api/me`가 401이면 정상
  - 로그를 날짜별 파일로 쓰고 14일 뒤 삭제한다
  - 짝이 되는 `Stop-XDNodeManagement.ps1`을 만든다(pid 기준 `taskkill /T`, workerd 포함)
- [ ] 매일 백업: 03:00에 작업 스케줄러로 다음을 실행한다
  - ① Stop 스크립트로 정지
  - ② `d1`과 `r2` 메타데이터의 `*.sqlite`·`-wal`·`-shm`을 `<백업루트>\yyyy-MM-dd\`로 복사
  - ③ R2 blobs는 `robocopy /E`로 증분 미러
  - ④ 서버 재기동
  - ⑤ 사본의 `PRAGMA integrity_check` 결과와 주요 테이블 행 수를 `backup-report.json`에 기록
  - ⑥ 날짜 폴더는 14개만 보관
  - ⑦ 외장 드라이브나 NAS로 2차 복사
- [ ] 백업 폴더는 **저장소 밖**, 경로 120자 이하에 둔다. ACL은 서버 사용자로 제한한다. `.env.local`은 넣지 않는다. 백업에는 급여와 비밀번호 해시가 들어간다
- [ ] 백업이 실패하면 관리자 화면에 마지막 성공 시각과 경고를 표시한다
- [x] 복구 절차(정지 → 교체 → 기동)를 문서화하고, 새 폴더에 한 번 복구해 본다(SC-7, 2026-10-01 리허설 완료). 온라인 백업(`VACUUM INTO`)은 이번 사이클에서 쓰지 않는다
- [ ] 자동 기동(D19)
  - 작업 스케줄러에 작업을 등록한다. 트리거는 '시스템 시작 시', 계정은 서버 사용자, '사용자의 로그온 여부에 관계없이 실행'(암호 저장), 동작은 운영 폴더의 `Start-XDNodeManagement.ps1 -Headless`다
  - 실패하면 5분 간격으로 3회 재시도한다
  - 서버를 올리는 경로는 하나로 통일한다. 03:00 백업의 ④ 재기동, `Deploy-XDNodeManagement.ps1`의 Start, 수동 재기동은 모두 `Start-ScheduledTask`로 자동 기동 작업을 실행한다. 스크립트를 직접 실행하지 않는다. 대화형 세션에서 직접 띄우면 로그오프할 때 서버가 같이 멈추고, 세션 종류가 달라 브리지 자격 증명 동작도 달라질 수 있다
  - 대체안으로 바꾸면 자동 기동 작업과 백업 작업 모두 '사용자가 로그온할 때만 실행'으로 다시 등록한다
  - **확인(재부팅 리허설, SC-12)**: 재부팅한 뒤 아무도 로그온하지 않은 상태를 유지한다. 다른 PC에서 로그인 화면이 보이는지, 헬스체크 로그에 `/api/me` 401이 남는지 확인한다. AI 어시스턴트 질문 1건과 이력서 분석 1건이 답해야 한다. 이렇게 해서 두 Claude CLI 브리지(3130·3120)가 로그온 없는 세션에서도 자격 증명을 읽는지 본다
  - 브리지가 자격 증명 오류로 실패하면 대체안으로 바꾼다. Windows 자동 로그온을 켜고 트리거를 '로그온 시'로 바꾼 뒤 같은 리허설을 다시 한다. 대체안을 쓰면 서버 PC 화면이 로그온된 채로 남는 물리 보안 부담이 생긴다. 그래서 전환할 때 사용자와 보완책을 정한다
- [ ] 전원: `powercfg`로 절전과 최대 절전을 끈다. Windows Update 사용 시간을 08:00~20:00으로 둔다
- [ ] 배포 절차 `Deploy-XDNodeManagement.ps1`(운영 폴더, 업무 시간 밖)
  - 순서: 태그 확인 → Stop → 정지 후 스냅샷 → 태그 checkout → build → `.dev.vars` → Start → 헬스체크
  - 실패하면 직전 태그로 재빌드한다
  - 중단 시간을 한 번 재서 기록한다
- 롤백: 스케줄 작업을 비활성화하고 수동 기동으로 돌아간다

#### R5 = M6. 메신저 MVP (D5, D6)

- [ ] 공개·비공개 채널: 생성, 참여·나가기, 멤버 관리. 비공개 채널은 멤버에게만 보인다
- [ ] 1:1·그룹 DM
- [ ] 스레드(1단계 답글)
- [ ] 파일 첨부: R2에 저장, 25MB 제한, 채널·DM 멤버만 다운로드. 이미지는 미리보기
  - 첨부는 raw body `PUT`으로 받는다. 권한·멤버 검사를 먼저 하고, `Content-Length ≤ 26,214,400`을 확인한 다음에 본문을 읽는다. 실제 바이트 수가 선언값과 다르면 거부한다
  - 다운로드 응답에는 `nosniff`, `Cache-Control: private, no-store`, `Content-Disposition: attachment`, `CSP: sandbox`를 붙인다. PNG·JPEG·GIF·WebP만 inline 미리보기를 허용하고, SVG·HTML은 금지한다
- [ ] 비공개 채널과 DM은 목록·메시지·스레드·전송·검색·폴링·첨부의 모든 경로에서 멤버인지 검사한다. 비멤버에게는 404를 돌려준다
- [ ] `@이름`·`@channel` 멘션, 채널별 안 읽은 수와 읽음 위치, 멘션 강조, 브라우저 탭 제목에 안 읽은 수 표시
- [ ] 본인 메시지 수정·삭제. 삭제는 soft-delete로 "삭제된 메시지"를 표시하고 감사 기록을 남긴다. 수정·삭제 감사에는 본문을 넣지 않는다(메시지 id, 채널 id, 길이만)
- [ ] 단순 검색: 접근 가능한 채널·DM 안에서 본문 LIKE 검색. `%`·`_`는 이스케이프한다
- [ ] 실시간: 채팅 탭이 보이는 동안은 2초 주기로 폴링해 `since` 커서 이후 증분만 받는다(D6의 2~3초 범위 안. 3초 주기면 왕복·렌더 시간 때문에 SC-6의 3초 기준을 넘을 수 있다). 브라우저 탭이 숨겨지면 폴링 주기를 늘린다
- [ ] 메신저 탭 권한: 보기는 읽기만, 편집은 쓰기·파일 첨부·채널 생성. 채널 삭제는 관리자만
- [ ] 채팅 DDL은 별도 모듈에 둔다. 그래야 R5만 따로 되돌리거나 보류할 수 있다
- 롤백: 직전 태그로 돌아간다. 채팅 테이블은 남아 있어도 쓰이지 않는다

#### R6 = M7. 폴더·저장소 리네임 (D11 마무리, 맨 마지막, 수동)

- [x] 앱과 브리지를 정지하고 이 PC의 작업 세션을 모두 닫은 뒤 진행한다. 개발 폴더 `XDNODE`와 원격 저장소 이름을 바꾼다
  - 2026-10-01 사용자가 저장소 밖 `C:\xdm\Rename-DevFolder.ps1`로 개발 폴더를 `xdnode-management`로 바꿨다(`-Rollback` 지원). 2026-10-02 확인: `git worktree list`에서 Codex `c7ec`·Orca `메신저-기능` 워크트리가 정상 연결, 운영 폴더 `origin`이 새 경로, 운영 `/api/me` 401(정상 기동)
  - GitHub 원격 저장소(`Gwonchankim/xdnode-erp`) 이름은 바꾸지 않았다. 바꿀지는 사용자가 GitHub에서 정한다
- [x] D18로 운영 경로(작업 스케줄러, 운영 바로가기, 운영 폴더 기준 `XD_NODE_PROJECT_PATH`)는 개발 폴더 이름과 무관해졌다. 새 경로로 옮길 참조는 개발 폴더를 가리키는 것만 남는다: 개발용 바로가기, 개발 폴더의 `XD_NODE_PROJECT_PATH`, Claude Code 프로젝트 메모리, 운영 폴더의 git remote(개발 폴더나 원격 저장소를 가리키는 경우)
- [x] 이 단계는 사용자와 함께 진행하는 체크리스트로 남기고, 자동화하지 않는다
- 롤백: 폴더 이름을 원래대로 되돌리고, 바로가기와 remote 경로를 원복한다

### 2.2 Out of Scope

- 총무 탭(자산·회사 서류·인감 반출 대장)은 메신저 다음 별도 사이클(D24). 이번에는 탭 레지스트리에 새 탭을 쉽게 더할 수 있게만 둔다
- 견적서 자동화 툴 연결(D8). 탭 슬롯 구조만 R3(M4)에서 확보한다
- 사외 원격 접속, VPN, SSO, 2단계 인증
- HTTPS(D10). 그 결과로 생기는 제약은 NFR Compatibility·Security로 처리한다
- 자가 가입, 비밀번호 찾기 이메일. 비밀번호 초기화는 관리자가 한다
- HR 하위 메뉴 단위 권한(D12)
- 메신저 Later 항목: 이모지 반응, 브라우저 푸시 알림, 접속 상태 표시
- 메신저 Out 항목: 핀·북마크, 커스텀 이모지, 앱 연동, 통화, 워크플로
- 재무·영업·결재 D1 테이블 DROP(D4)
- 기존 역할 데이터(`erp_user_access`)의 자동 이관
- 운영 런타임으로서의 `vinext start`, `wrangler dev`, LAN 바인딩 `vinext dev`
- 온라인 백업(`VACUUM INTO`)
- data-intake의 HR 직원·급여 엑셀 일괄 가져오기(D2로 삭제. 임금 계산기 xlsx 업로드는 유지)
- 어시스턴트가 저장소 소스·문서를 근거로 인용하는 답변(D17)

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Release | Priority | Verification | Status |
|----|-------------|---------|----------|--------------|--------|
| FR-01 | 재무·영업·결재·재무용 공용 기능의 라우트·컴포넌트·라이브러리·역할·테스트를 제거한다. `/api/finance/*`, `/api/sales/*`, `/api/approvals`를 호출하면 404. 예외: D1 보류 파일 `incentive-governance.tsx` | R1 | High | `removal-guards.test.mjs`, `rendered-html.test.mjs`(404) | Pending |
| FR-02 | HR 결재 흐름 7개(인사발령, 퇴직, 휴가 신청, 급여월 승인, 성과 최종 확정, 인력계획 승인, 채용요청 모집 시작)를 편집 권한자가 즉시 반영한다. 엔진이 하던 부수효과도 같은 요청 안에서 처리하고 감사를 남긴다. 레거시 대기 상태도 전이할 수 있다. 보기 권한은 403 | R1 | High | `hr-api-integration.test.mjs`의 흐름별·레거시 from-state 케이스 | Pending |
| FR-03 | 급여 마감·재오픈이 재무 테이블을 읽거나 쓰지 않는다. 조직 수정이 마스터 영향 평가 없이 동작한다. HR 라우트가 `erp_approval_*`·`erp_tasks`를 참조하지 않는다. 결재·재무 테이블이 없는 새 DB에서도 HR 전 동작이 500 없이 동작한다 | R1 | High | 새 DB 하니스 케이스, 'APPROVED·LOCKED 뒤 결재·재무 행 0건' 테스트 | Pending |
| FR-04 | 임금 계산·인센티브 계산기가 영업 데이터(`sales_incentive_payroll_links` 포함) 없이 동작한다. 인센티브 AI 어시스턴트는 `incentive` 모듈로 동작한다 | R1 | High | `incentive-calculation.test.mjs`, `local-codex-assistant.test.mjs` | Pending |
| FR-05 | 모든 사용자 화면·브라우저 제목·패키지명이 "XDnode management" 기준이다. `database_id`·`bucket_name`은 바뀌지 않는다 | R2 | Medium | `rendered-html.test.mjs`(제목), 소스 가드 테스트, grep | Pending |
| FR-06 | 이메일·비밀번호 로그인, 로그아웃, 30일 세션, 첫 로그인 비밀번호 변경(서버 강제), 5회 실패 시 5분 잠금(원자적). PBKDF2-SHA256 100,000회 | R3 | High | `auth-session.test.mjs`, R3 스모크의 preview 로그인 | Pending |
| FR-07 | 계정 0개일 때만, Node가 확인한 루프백 접속에서만 첫 관리자를 만든다. 헤더 위조로는 만들 수 없다 | R3 | High | `auth-session.test.mjs`(위조·동시 요청) | Pending |
| FR-08 | 관리자 계정 관리: 생성(인사기록 연결 선택), 탭별(`hr`·`compensation`·`chat`) 숨김·보기·편집 지정(`audit`·`admin`은 관리자 전용, §1.2), 비밀번호 초기화, 잠금 해제, 비활성화. 비활성화·초기화하면 기존 세션을 즉시 폐기한다. 마지막 활성 관리자는 비활성화·강등할 수 없다 | R3 | High | `auth-session.test.mjs` | Pending |
| FR-09 | `/api/me`의 탭 권한대로만 탭을 렌더한다. 권한 없는 탭은 DOM에 없다. 저장된 탭이 권한 밖이면 첫 허용 탭으로 이동한다 | R3 | High | `shell-tabs.test.mjs`, 수동 URL 조작 확인 | Pending |
| FR-10 | 모든 API가 세션 사용자의 탭 권한으로 보기(read)·편집(write)을 검사한다. 탭 숨김과 서버 검사가 같은 정의에서 나온다. 권한·활성 여부는 요청마다 DB에서 읽는다. 대응표 밖 모듈은 거부한다. 임금 계산은 전용 최소 명부를 쓴다 | R3 | High | `tab-permissions.test.mjs`(교차 조합 포함) | Pending |
| FR-11 | 감사 로그 actor는 실제 로그인 계정이다. 로그인 성공·실패·잠금, 첫 관리자 생성, 계정·탭 권한 변경, 비밀번호 초기화, 세션 폐기, 403 거부를 기록한다. 비밀번호·토큰은 기록하지 않고, Node가 확인한 접속 주소를 남긴다. 감사 탭은 관리자만 본다 | R3 | High | `auth-session.test.mjs`·`tab-permissions.test.mjs`의 감사 단언 | Pending |
| FR-12 | 공개·비공개 채널, 1:1·그룹 DM, 1단계 스레드. 비공개·DM은 모든 경로에서 멤버를 검사한다 | R5 | High | 채팅 동작 테스트(파일명은 Design) | Pending |
| FR-13 | 파일 첨부(25MB, 멤버만 다운로드, 이미지 미리보기). 크기 검사를 본문 읽기 전에 하고, 다운로드는 attachment·nosniff로 응답한다 | R5 | High | 채팅 동작 테스트 | Pending |
| FR-14 | 멘션, 안 읽은 수·읽음 위치, 탭 제목 안 읽은 수 | R5 | High | 채팅 동작 테스트, SC-6 | Pending |
| FR-15 | 본인 메시지 수정·soft-delete(감사에 본문 없음), 접근 범위 안 단순 검색 | R5 | Medium | 채팅 동작 테스트 | Pending |
| FR-16 | 새 탭(견적 등)을 한 정의 파일과 새 라우트만으로 추가할 수 있다 | R3 | Medium | `tab-permissions.test.mjs`의 정의 파일 소스 가드 | Pending |
| FR-17 | 운영 기동은 `vinext build` + `vite preview`(0.0.0.0:3000, explorer 비활성)이고, 별도 운영 폴더에서 한다(D18). LAN 다른 PC 접속, 매일 자동 백업과 검증된 복구 절차, 재부팅 뒤 자동 기동(D19) | R3·R4 | High | SC-5, SC-7, SC-12, SC-13 | Pending |
| FR-18 | 폴더·저장소 리네임 체크리스트를 실행한다 | R6 | Low | M7 체크리스트 | Done (2026-10-01, 원격 저장소 이름은 유지) |
| FR-19 | 현재 노출을 차단한다: dev는 `127.0.0.1`만(D16, 완료), explorer 강제 off, fs.deny 확장, 방화벽 규칙 정리, 브리지 Origin·Host 검사 | R0 | High | R0 확인 항목, SC-9 | Pending |
| FR-20 | 직원 개인정보·급여는 권한 검사를 거친 API로만 내려온다. `dist/client`에 실데이터 0건 | R1·R3 | High | `bundle-exposure.test.mjs`, `tab-permissions.test.mjs` | Pending |
| FR-21 | 어시스턴트 브리지는 저장소 파일을 읽지 않는다(D17). 업무 맥락은 `/api/assistant`가 권한 검사 뒤 넘긴 JSON뿐이다 | R0 | High | 브리지 소스 가드 테스트, SC-11 | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| Security | 권한 없는 탭 API 호출은 403. 비밀번호는 PBKDF2-SHA256 100,000회 해시(평문·가역 저장 없음). 세션 쿠키는 HttpOnly·SameSite=Lax(Secure 없음), DB에는 토큰 해시만 | 권한 매트릭스 테스트(계정 × 탭 × 보기/편집), 반복 횟수 단언 테스트 |
| Security | 교차 출처 POST·PUT·DELETE는 403(인증 라우트 포함). 모든 응답에 nosniff·`X-Frame-Options: DENY`·`Referrer-Policy: same-origin` | 교차 출처 요청 동작 테스트 |
| Security | Miniflare explorer는 항상 꺼져 있다. 비루프백 `/cdn-cgi/*`는 404다. 저장소 파일·`.wrangler` 상태는 서빙되지 않는다 | SC-9 curl 점검 |
| Security | 평문 HTTP라서 같은 망에서 비밀번호·세션을 도청할 수 있다. 3000번 포트는 Private·LocalSubnet만 허용하고, 게스트망이나 공용 Wi-Fi에는 연결하지 않는다. 접속 주소는 IP로 안내한다. 이 한계를 운영 문서에 명시한다 | 문서 검토, 방화벽 규칙 확인 |
| Compatibility | http LAN에서 남는 기능이 오류 없이 동작한다. `crypto.randomUUID`는 `getRandomValues` 기반 `randomId()`로, clipboard는 대체 경로가 있는 `copyText()`로 바꾼다. 면접 녹음은 서버 PC에서만 지원한다(필요하면 PC별 브라우저 정책 `OverrideSecurityRestrictionsOnInsecureOrigin`) | 다른 PC 수동 시험 |
| Performance | 채팅 메시지가 다른 PC 화면에 3초 이내 표시된다(6명 동시 접속, 채팅 탭이 보이는 상태) | SC-6 측정 |
| Performance | 폴링 응답 p95 ≤ 200ms(6명 동시, 100회 측정). 숨겨진 탭은 폴링 주기를 늘린다 | 개발자 도구 네트워크 측정 |
| Reliability | 서버 재시작 뒤 세션·채팅·읽음 위치가 보존된다. 백업 성공 = 복사 완료 + integrity_check ok + 보고서 기록. 일 1회 백업 성공, 복구 리허설 1회 성공 | 재시작·복구 수동 시험, `backup-report.json` |
| Reliability | 재부팅 뒤 로그온 없이 서버와 브리지가 자동 기동된다(D19) | 재부팅 리허설(SC-12) |
| Maintainability | `npm run lint` 0 오류, `npm test` 통과, 삭제된 기능을 가리키는 import·문자열 없음(D1 보류 파일 `incentive-governance.tsx`는 사용자 확인 전까지 문자열 검사 예외) | CI 명령, `removal-guards.test.mjs`, grep |
| Localization | 새 사용자 문구는 전부 한국어 | 리뷰 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] SC-1: FR마다 §3.1 표의 Verification 열에 검증 수단(테스트 파일명 또는 수동 체크리스트 항목)을 두고, 전부 통과한다
- [ ] SC-2: 권한 매트릭스 시험 통과. 일반 계정의 3개 탭(`hr`·`compensation`·`chat`) × 숨김/보기/편집과, `audit`·`admin`의 관리자/일반 2가지에서 DOM 노출과 API 결과(200/403)가 기대와 일치한다. `chat` 열은 R5에서 추가 판정한다
  - API 절반은 `tab-permissions.test.mjs`로 검증한다
  - DOM 절반은 react-dom/server로 셸을 렌더하는 `shell-tabs.test.mjs`와 `bundle-exposure.test.mjs`로 검증한다
  - URL 조작은 수동으로 확인한다
- [ ] SC-3: 두 계정이 동시에 로그인해 각자 수정하면 감사 로그 actor가 둘로 구분된다
- [ ] SC-4: HR 회귀 시나리오를 **다른 PC에서 LAN IP로** 통과한다. 기존 D1 사본과 새 DB 양쪽에서 확인한다. D16에 따라 R1에서는 서버 PC에서 실행한다. 최종 판정은 R3 운영 전환 때 점검용 인스턴스(운영과 같은 태그, 운영 데이터 사본과 새 DB)에서 다른 PC로 한다. 운영 DB에서는 실행하지 않는다
  - 급여 REVIEW→APPROVED→LOCKED, 사유를 적은 재오픈. 재무 테이블 행 변화 없음
  - 퇴직 등록→IN_PROGRESS(정산 초안·'퇴직 예정')→EFFECTIVE→COMPLETED
  - 인사발령: 오늘 날짜는 즉시 반영, 미래 날짜는 도래일에 반영
  - 휴가: 구 양식 신청(즉시 APPROVED), 연차관리 신청·삭제, 레거시 PENDING 승인
  - 채용요청 생성→OPEN→삭제. 인력계획 승인과 이전 계획 SUPERSEDED
  - 성과 최종 확정, 이의제기 수용·기각
  - 조직 수정, 직원·지원자 문서 업로드·다운로드
  - 임금 계산 CONFIRM·REOPEN, 인센티브 계산(임금 계산 전용 계정 포함)
- [ ] SC-5: 다른 PC에서 LAN 주소로 로그인, AI 어시스턴트, 이력서 분석이 동작한다(R3). 채팅은 R5
- [ ] SC-6: 두 PC 모두 채팅 탭을 보이는 상태로 둔다. 서버 기록 시각과 수신 화면 표시 시각의 차이가 10회 모두 3초 이하다
- [x] SC-7: 백업을 새 폴더에 복구한다. 복구본의 `integrity_check=ok`이고, 행 수와 R2 객체 수가 백업 보고서와 일치하며, 로그인·HR 직원 조회·채팅 기록 조회가 성공한다 — 2026-10-01 `2026-10-01` 백업을 `C:\xdm\staging`(3001, 코드 `hr1.1-release-20261001`)에 복구: integrity ok, 테이블 185·행 10,206 차이 0, R2 객체 154·본문 누락 0. 사용자가 로그인·HR 직원·메신저 기록과 첨부·HR 첨부 열람을 확인했다. 총무는 백업 시점 0건이라 다음 리허설에서 본다. 끝난 뒤 staging을 지웠다(3001 규칙은 만들지 않았다)
- [ ] SC-8: 보관 태그 `erp-final-20260923`과 `archive/erp-finance-sales-20260923` 브랜치가 있다. 저장소 밖 D1 스냅샷과 그 integrity_check·행 수 기록이 있다. 재무·영업·결재 테이블은 DB에 그대로 있다
- [ ] SC-9: 다른 PC에서 `/.wrangler/…`, `/app/*.ts`, `/*.tar.gz`, `/cdn-cgi/explorer/…`(Host 위조 포함)가 모두 404 또는 403이다. `dist/client`에 실데이터 0건
- [ ] SC-10: 첫 관리자 헤더 위조 차단, 교차 출처 POST 403, 동시 오답 20건에서 검증 5회 이하. 모두 동작 테스트로 확인한다
- [ ] SC-11: 어시스턴트에게 `.env.local`, `app/hr-company-data.ts`, `.wrangler` sqlite, 서버 로그, 소스 파일 1개의 내용을 각각 요청한다. 5건 모두 응답에 해당 파일의 고유 문자열(토큰 앞 8자, 명부의 연봉 리터럴 등)이 0건이다
- [ ] SC-12: 재부팅한 뒤 아무도 로그온하지 않은 상태에서, 다른 PC가 로그인 화면을 보고 AI 어시스턴트와 이력서 분석이 답한다(D19). 첫 03:00 백업 뒤와 첫 Deploy 뒤에도 AI 어시스턴트와 이력서 분석이 답한다. 대체안으로 바꿨다면 자동 로그온 상태에서 같은 결과가 나온다
- [ ] SC-13: 운영 폴더로 옮긴 데이터의 `integrity_check=ok`이고, 테이블별 행 수와 R2 객체 수가 원본과 같다. 기존 HR 직원 조회와 R2 녹음 다운로드가 성공한다(D18)

### 4.2 Quality Criteria

- [ ] `npm run lint` 0 오류
- [ ] `npm run build` 성공, `npm test` 통과. 새 테스트 파일은 `package.json` test 목록에 등록한다
- [ ] 계정·세션·탭 권한은 `tests/helpers/hr-api-harness.mjs` 방식(실제 라우트 + 메모리 SQLite)의 동작 테스트로 검증한다. 소스 문자열 검사만으로 끝내지 않는다
- [ ] 하니스 개편(R3와 같은 PR). 지금 하니스는 `setIdentity`로 `oai-authenticated-user-*` 헤더를 주입하는데(`:87,90-93`), M3가 이 경로를 없앤다
  - ① `resetDatabase`가 기본 관리자 계정과 세션 행을 넣고, `cookie: xdm_session=<token>`을 설정한다
  - ② `setIdentity(roles)`는 탭 권한으로 바꿔 주는 호환 shim으로 남긴다. 새 테스트는 `setAccess(tabs,{isAdmin})`를 쓴다
  - ③ `callApi`는 요청별 헤더·Origin을 싣고 `{status, body, headers, setCookies}`를 돌려준다
  - ④ 세션은 `headers().get('cookie')`로 읽는다
  - ⑤ D1 bind에는 boolean 대신 1/0을 쓴다
  - ⑥ 잠금 5분과 세션 30일은 모의 시계로 검증한다
- [ ] 기본 관리자 해시는 프로세스당 한 번만 계산한다. 실제 해시 경로는 `auth-session.test.mjs`에서 검증하고, R3 스모크에서 preview(workerd) 로그인 1회로 확인한다
- [ ] `hr-local-permissions.test.mjs`는 `tab-permissions.test.mjs`로 대체한다: 탭 3개(`hr`·`compensation`·`chat`) × 숨김·보기·편집 + `audit`·`admin` × 관리자/일반 × 유지 라우트·메서드
- [ ] 빌드 후 `tests/bundle-exposure.test.mjs`가 `dist/client/**/*.js` 전체에서 직원 실데이터 표지를 찾아 0건인지 확인한다. 표지는 `annualSalary:` 뒤의 숫자 리터럴, 명부의 전화·개인 이메일 패턴, `finance-current-data` 식별자다. 청크 이름에 의존하지 않는다. `dist/server`에서는 재무 실데이터 표지만 0건이면 된다(서버 번들의 HR 시드는 정상)

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| 지금 열려 있던 LAN 노출: dev `0.0.0.0` + 전 프로필 방화벽 허용, explorer로 D1 임의 SQL, 저장소 파일(.wrangler sqlite, 소스, tar.gz) 서빙 | High | 발생 중이었음. LAN은 D16으로 2026-09-23 차단 | R0: explorer 강제 off, fs.deny, 방화벽 정리(3000 규칙은 R3까지 꺼 둠). R3: preview 전환, 비루프백 `/cdn-cgi` 404, 운영 전환 순서, SC-9 |
| 어시스턴트 브리지로 파일 읽기를 우회(급여 시드, `.env.local` 비밀값, 로그, 보관 데이터) | High | 발생 중 | R0에서 D17 격리, 소스 가드 테스트, SC-11. 읽힌 Google 키 폐기, `CLOUDFLARE_API_TOKEN` 교체 검토 |
| 클라이언트 번들에 직원 PII·급여 포함(로그인 전 방문자와 HR 숨김 계정도 받음) | High | 발생 중 | R1(M1-3) 서버 전용 분리, `bundle-exposure.test.mjs`. R3 전까지 LAN 닫힘(D16) |
| 제거 작업이 HR을 깨뜨림. 확인된 결합: 결재 흐름 7, 직접 SQL 5, 급여 재무 3, compensation 영업 합산, documents import, 어시스턴트 incentive 모드, 공용 내비 ApprovalCenter, ApprovalSettings, 마스터 영향 | High | High | M1-0~M1-5 순서, 단계마다 lint·test, 엔진 부수효과를 같은 batch로 이전, 새 DB 하니스, SC-4 회귀. 보관 태그로 즉시 되돌림 |
| 레거시 대기 행이 빠져나갈 길이 없음(SUBMITTED 퇴직이 같은 직원의 새 퇴직을 409로 막는 등) | Medium | Medium | HR 테이블 직접 조회로 건수 기록, 즉시 반영이 레거시 from-state를 받음, 승인/반려 버튼, 테스트 |
| 과거에 적용된 영업 인센티브가 CONFIRM 재확정 때 조용히 사라짐 | Medium | Low(조사 시점 0건) | M1-0에서 건수 확인. 1건 이상이면 그 월 CONFIRM을 409로 막고 사용자와 결정 |
| 탭은 숨겼는데 API가 열림. 임금 계산 API가 `hr` 경로 아래 있고, 계산기가 HR 명부 API를 씀 | High | Medium | 탭 → API 대응을 한 정의에서 생성, 라우트별 명시, 임금 계산 전용 명부, 교차 조합 매트릭스(SC-2), 대응표 밖 모듈 거부 |
| M3·M4·M5를 따로 배포하면 전원 401, 인증 테이블 노출, 미연결 계정 403, 권한 우회 | High | High | R3로 한 번에 배포, 같은 브랜치, 중간 커밋은 운영 미반영 |
| preview의 env 누락·explorer 노출 | High | High | 빌드 뒤 `dist/server/.dev.vars` 작성, explorer 강제 off, 다른 PC에서 curl 점검 |
| 첫 관리자 생성 경로 악용(Host·`CF-Connecting-IP` 위조) | High | Medium | Node 플러그인 루프백 판정, 원자적 INSERT, 운영 전환 순서(방화벽을 닫고 생성), 위조 테스트 |
| 로그인 잠금 경쟁, LAN에서 관리자 잠금 DoS | High | Medium | 원자적 시도 예약과 동시 오답 테스트는 경쟁만 막는다. 관리자가 1명이면 계정 관리의 잠금 해제를 쓸 수 없고, LAN 사용자는 5분마다 다시 잠글 수 있다. 즉시 복구는 앱을 멈추고 `reset-admin-password.mjs`를 돌리는 것뿐이다. 접속 주소 감사로 시도자를 찾는다. 루프백 예외는 D15와 충돌해 보류했고, Design 체크포인트에서 '루프백 예외'와 '두 번째 관리자 계정' 중 하나를 사용자에게 확인한다(§1.2) |
| PBKDF2 반복 수가 workerd 상한(100,000)을 넘어 운영에서만 로그인 실패 | High | Medium | 100,000회 고정, 단언 테스트, R3 스모크에서 preview 로그인 1회 |
| vite-plugin 업그레이드로 explorer가 다시 켜짐 | High | Low | `X_LOCAL_EXPLORER=false` + 플러그인의 비루프백 `/cdn-cgi` 404로 이중화 |
| 개발 작업이 운영을 깨뜨림(`npm test`가 dist를 지우고, dev가 같은 `.wrangler/state`를 엶) | High | High(같은 폴더일 때) | D18 운영 폴더 분리를 R3 운영 전환 첫 단계에서 |
| 운영 폴더 데이터 이전 중 누락·손상 | High | Low | 정지 후 복사, 원본·사본의 integrity_check·행 수·R2 객체 수 비교, 저장소 밖 스냅샷, 원본은 확인 뒤에만 옮김(SC-13) |
| 재부팅 뒤 서버 미기동, 또는 로그온 없는 세션에서 Claude CLI 브리지 자격 증명 실패 | Medium | Medium | D19 '시스템 시작 시' 작업, 3회 재시도, 재부팅 리허설(SC-12). 실패하면 자동 로그온 + '로그온 시'로 전환하고 물리 보안 보완책을 사용자와 정함 |
| 평문 HTTP라 같은 망에서 비밀번호·세션 도청 | Medium | Medium | 3000번은 Private·LocalSubnet만, 게스트망·공용 Wi-Fi 금지, 운영 문서 명시(D10에 따른 수용) |
| HR 탭을 받은 사람은 급여도 봄(D12 결과) | Medium | High(설계상 확정) | 계정 관리 화면에 "HR 탭에는 급여관리가 포함됩니다" 안내. 향후 필요하면 하위 메뉴 권한을 별도 사이클로 |
| 보기 권한 계정도 HR 화면에서 편집 버튼을 보고 403을 받음(HR UI에 읽기 전용 모드 없음) | Low | High | 서버 403이 최종 방어. 버튼 숨김 범위는 Design에서 정함 |
| 30일 세션 + 공용 자리: 자리를 비운 사이 다른 사람이 사용(D15 결과) | Medium | Medium | 로그아웃 버튼 상시 노출, 관리자가 계정 세션 강제 종료 가능. 한계는 운영 문서에 명시 |
| 서버 PC 장애·디스크 손상으로 데이터 소실 | High | Low~Medium | 매일 정지·복사·integrity 백업, 저장소 밖·2차 사본, 복구 리허설(SC-7) |
| R1 롤백 때 스냅샷을 복구하면 그 뒤의 HR 변경을 잃음 | Medium | Low | 코드 롤백을 먼저 하고, 스냅샷 복구는 데이터가 손상됐을 때만 |
| 어시스턴트가 소스·문서를 근거로 인용하던 답변이 사라짐(D17 결과) | Low | High(확정) | 필요한 업무 맥락은 `/api/assistant`가 권한 검사 뒤 JSON으로 넘김 |
| 폴더 리네임 중 경로가 끊겨 서버·세션·메모리가 깨짐 | Medium | Low | M7을 맨 마지막 수동 체크리스트로, 앱 정지·세션 종료 뒤. D18로 운영 경로는 개발 폴더 이름과 무관 |
| `erp-platform.test.mjs`(재무 289·영업 141·결재 124회 언급)·`workflow-ledgers.test.mjs` 재작성 부담, 회귀 테스트까지 지워질 위험 | Medium | High | 회귀 고정점 3곳 유지(기대값만 수정), 삭제 기능 단언만 제거, `removal-guards.test.mjs` 추가, 새 권한 체계용 테스트 추가 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|----------|------|--------------------|
| `scripts/Start-XDNodeERP.ps1` | Config | R0: `127.0.0.1` 바인딩(완료, D16), `X_LOCAL_EXPLORER`, 3110 기동 제외(`local-codex-assistant.test.mjs:96-97` 동시 수정). R2: 이름 변경. R3: preview용 재작성(build, `.dev.vars`, 브리지 기동). R4: `-Headless`, pid, 헬스체크, 로그 회전, Stop·Deploy 스크립트 신규 |
| `vite.config.ts` | Config | R0: explorer off, fs.deny 확장, `GOOGLE_*` 제거. R1: `CLOUDFLARE_AI_MODEL` 제거. R3: 루프백 판정 플러그인. `database_id`·`bucket_name`은 변경 금지 |
| `scripts/claude-assistant-bridge.mjs` | Script | R0: 빈 임시 폴더 cwd, `--tools ""`로 내장 도구 전부 끄기 + `Read`·`Grep`·`Glob`·`PowerShell` 차단, 시작 때 스키마·`buildPrompt` 적재, Origin·Host 검사(D17). R1: `ALLOWED_MODULES`의 sales → incentive |
| `scripts/codex-assistant-bridge.mjs` | Script | R0: 기동 제외, 파일 유지(`buildPrompt` 원본). 프롬프트의 파일 검토 지시 수정. R1: `ALLOWED_MODULES` 이름 변경 |
| `scripts/claude-resume-bridge.mjs` | Script | R0: Origin·Host 검사 추가, `--tools ""`와 차단 목록 `PowerShell` 추가 |
| `worker/index.ts` | Config | R3: nosniff, `X-Frame-Options`, `Referrer-Policy` |
| `app/chatgpt-auth.ts` | Auth | R3: 헤더·환경변수 신원 제거 → 세션 신원 |
| `authorizeErpRequest`, `ErpRole`, `rolePermissions` (`app/erp-platform.ts`) | Auth/API | R1: 재무 헬퍼·재무/영업 역할 제거, 결재·업무 테이블 생성 중단. R3: 역할 → 계정별 탭 권한, 인사기록 연결 필수 해제, CSRF, 대응표 밖 모듈 거부. 구조는 Design 안에 따름 |
| `writeErpAudit` | API | 유지. actor는 세션 계정. 보안 이벤트 기록 추가 |
| `app/approval-engine.ts`, `/api/approvals`, `/api/approval-settings`, `approval-center.tsx` | API/UI | 삭제 |
| HR 결재 흐름 7개(operations 3, payroll, performance, workforce-plans, recruitment-requisitions) | API | 즉시 반영, 부수효과 이전(`app/hr-transitions.ts` 신규) |
| 결재 테이블 직접 SQL 5곳(leave, operations 2곳, payroll, recruitment-requisitions) | API/DB | 삭제 |
| `app/api/hr/payroll` | API/DB | 재무 연결 3곳(ensureSchema, LOCKED, 재오픈) 제거 |
| `app/api/hr/compensation` | API/DB | 영업 합산 제거. R3에서 `compensation` 탭으로 인가 |
| `app/api/documents` | API | 재무·영업 import 제거, 인가를 formData 앞으로, 레거시 module 404 |
| `app/api/assistant` | API | 모듈 sales → incentive. R3에서 compensation 탭 인가 |
| `app/hr-company-data.ts` | Data | 카탈로그(클라이언트용)와 명부·보상 시드(`server-only`)로 분리. 실데이터 정확성 대조 |
| `app/hr-workspace.tsx` | UI | 명부를 API로 로딩, ApprovalSettings·결재 대기 UI·financeExpenseId 안내·마스터 영향 제거, 레거시 승인/반려 버튼 |
| `app/incentive/incentive-calculator.tsx` | UI | 정적 명부 대체값 제거. R3에서 임금 계산 전용 명부 사용 |
| `app/page.tsx` | UI | R1: 재무·영업 셸·ApprovalCenter 제거, audit-log 재마운트. R3: 클라이언트 로그인 게이트, 탭 정의 기반 렌더, 계정 관리·감사 탭. R5: 메신저 탭 |
| `app/audit-log-workspace.tsx` | UI | 관리자 전용 감사 탭으로 재마운트(D2-c) |
| `app/performance-management-view.tsx` | UI | 이의제기 수용 값 ACCEPTED → RESOLVED |
| `app/local-codex-assistant.tsx`, `app/compensation-calculator.tsx` | UI | `/api/sales` 조회 제거, 모드 이름 incentive, `randomId()`·`copyText()` |
| 삭제 대상(연구 자료의 제거 목록 120개, 안별 추정 128~132개, Design 부록에서 확정) | API/UI | 라우트 44개(finance 24, sales 11, 공용 9), 재무 컴포넌트·라이브러리, `app/sales-*` 19개, `google-sheets.ts`, 결재·데이터·마스터 영향·워크벤치. `incentive-governance.tsx`는 D1 보류 |
| 수정 대상(연구 자료 기준, Design 부록에서 확정) | API/UI | documents, assistant, audit-log, hr/leave, hr/compensation, hr/authorized-users(allowedRoles), 뷰 3개의 결재 상태 라벨, `hr-company-data`의 클라이언트 import 2곳, 스크립트 2개와 패키저 |
| `app/finance-*-data.ts` 등 | Data | 작업 트리 밖(archive 태그·브랜치 + 저장소 밖 접근 제한 폴더, 해시 기록) |
| 계정·세션·채팅 테이블 | DB | 신규. 채팅 DDL은 별도 모듈 |
| `tests/helpers/hr-api-harness.mjs` | Test | 세션 쿠키 기반으로 개편, `server-only` 스텁 |
| `package.json` | Config | 이름, `engines.node >=22.15.0`, `serve:lan`, test 목록 |
| `scripts/Package-XDNodeDemo.ps1`, `restore-known-data.mjs`, `import-leave-ledger.mjs` | Script | 폐기 / 보관 / 로그인 방식으로 변경(R3) |
| 운영 폴더 `C:\xdm\prod` | Ops | 신규(D18). 태그 checkout, 빌드, 운영 state |
| 작업 스케줄러 작업 | Ops | 시스템 시작 시 자동 기동(D19), 03:00 백업 |
| `.env.local` | Config | `GOOGLE_*`·영업·재무 전용 변수 제거, `CLOUDFLARE_API_TOKEN` 교체 검토 |

### 6.2 Current Consumers

| Resource | Operation | Code Path | Impact |
|----------|-----------|-----------|--------|
| `createApprovalRequest` | CREATE | `app/api/hr/operations/route.ts:277`(인사발령), `:358`(퇴직), `:400`(휴가 신청) | Breaking → 즉시 반영 |
| `createApprovalRequest` | CREATE | `app/api/hr/payroll/route.ts:418`(급여월 승인, 분기 411-431) | Breaking → 일반 전이 |
| `createApprovalRequest` | CREATE | `performance:258`, `workforce-plans:236`, `recruitment-requisitions:191,264`(`willAutoApproveForSelf`) | Breaking → 즉시 반영 |
| `buildApprovalOutcomeStatements` | UPDATE | `app/approval-engine.ts:279-325,467-496,507-529`(휴가 279, 인사발령 부서·직위·EFFECTIVE 283-304, 급여월 305-308, 인력계획 SUPERSEDED 309-325, 퇴직 정산 초안·직원 상태 467-496, 채용요청 507-513, 성과 참여자 FINALIZED 514-529) | 부수효과를 각 HR 라우트의 같은 batch로 이전 |
| `erp_approval_*`, `erp_tasks` 직접 SQL | READ/WRITE | `hr/leave:222-224`, `hr/operations:546-548,554`, `hr/payroll:413-416`, `hr/recruitment-requisitions:321-340` | Breaking(새 DB에서 500) → 삭제 |
| `finance_expense_requests`, `finance_project_allocations` | CREATE/READ/WRITE | `app/api/hr/payroll/route.ts:103,124-128`(ensureSchema), `:432-465`(LOCKED), `:466-503`(재오픈) | Breaking → 3곳 제거 |
| `sales_incentive_payroll_links` | READ | `app/api/hr/compensation/route.ts:311-339`(CONFIRM 합산) | Breaking → 제거. 건수 1건 이상이면 409 |
| 레거시 대기 상태 | READ | `operations:304-306`(SUBMITTED 퇴직이 새 요청을 409로 막음), `workforce-plans:156,254`, `hr-workspace.tsx:2415` | from-state로 수용, 승인/반려 버튼 |
| `master-impact` | READ | `app/api/hr/organizations/route.ts:4,93-95,113`, `app/hr-workspace.tsx:13,1991` | Breaking → 제거 |
| 재무·영업 모듈 import | READ | `app/api/documents/route.ts:4-6,17`, `:52,170,200`(`row.module as ErpModule`), `:75` formData / `:84` 인가 | Breaking → import 제거, 인가 선행, 레거시 행 404 |
| `ApprovalCenter`, `ApprovalSettings` | READ | `app/page.tsx:26,437`(ERPTopNavigation), `app/hr-workspace.tsx:4588-4747` | 제거. HR 셸 회귀 대상 |
| `audit-log-workspace.tsx` | READ | 유일한 import처 data-governance-center(삭제 대상) | 관리자 감사 탭으로 재마운트 |
| 어시스턴트 `sales` 모듈 | READ | `app/compensation-calculator.tsx:621-623`, `app/api/assistant/route.ts:14,20,30`, `scripts/claude-assistant-bridge.mjs:24` 등 두 브리지의 `ALLOWED_MODULES` | 이름 변경 → `incentive` |
| `/api/sales` | READ | `app/local-codex-assistant.tsx:279-288` | Breaking → 제거 |
| `/api/sales/incentives` | READ/WRITE | `app/incentive-governance.tsx:34,44`(고아 파일) | D1 보류: 파일은 남기고 호출은 404. 삭제는 Design 체크포인트에서 확인 |
| `IncentiveCalculator`·임금 계산 | READ | `incentive-calculator.tsx:332` → `/api/hr/employee-records`(hr:read, PII 포함) | **Breaking** → 임금 계산 전용 명부(`{employeeId, name, department, status}`)와 `compensation` 탭 인가로 바꾼다(§2.1 M4) |
| `app/hr-company-data.ts` | READ | 클라이언트 `app/hr-workspace.tsx:5`, `app/incentive/incentive-calculator.tsx:7` / 서버 `app/api/hr/analytics/route.ts:4`, `authorized-users/route.ts:2` | Breaking(클라이언트) → 서버 전용 분리 |
| `getChatGPTUser` | READ | `app/erp-platform.ts:199` | 세션 신원으로 교체 |
| `authorizeErpRequest` | READ | 남는 모든 API 라우트 | 내부 교체. 시그니처 유지 여부는 Design 안에 따름. 모듈 인자는 탭 대응표에 맞춰 재검토 |
| `privileged()`, `hr:approve`, `recruitment:*` | READ | `app/api/hr/performance/route.ts:39`, `analytics:19`, `training:23` 등 | `hr` 탭 편집으로 매핑 |
| `oai-authenticated-user-*` 주입 | READ | `tests/helpers/hr-api-harness.mjs:87,90-93` | Breaking → 세션 쿠키 하니스 |
| 역할 기반 테스트 | READ | `tests/hr-local-permissions.test.mjs`, `tests/erp-platform.test.mjs` | `tab-permissions.test.mjs`로 대체, 재작성 |
| 재무·영업 테스트 | READ | `tests/finance-*.test.mjs` 5개, `tests/workflow-ledgers.test.mjs` | 삭제·재작성 |
| 회귀 고정 테스트 | READ | `tests/hr-api-integration.test.mjs:176-185,347-362,400-425` | 유지. 기대값만 즉시 반영 기준으로 |
| 문서 문구 단언 | READ | `tests/erp-platform.test.mjs:1769` | 문서와 같은 커밋에서 변경 |
| 스크립트 이름 단언 | READ | `tests/erp-platform.test.mjs:985,2543,2554`, `tests/local-codex-assistant.test.mjs:42` | 리네임과 같은 커밋에서 변경 |
| 화면 문자열 테스트 | READ | `tests/rendered-html.test.mjs:5-14,16-50` | '/' 테스트를 재작성한다. 제목 'XDnode management', 비로그인 HTML에 모듈 탭·HR 데이터·재무/영업 문자열 없음. 같은 빌드로 `/api/finance/*`와 `/api/sales/*`가 404인지 확인한다(FR-01) |
| `.wrangler/state` 복사, `LOCAL_ERP_USER_EMAIL` | READ | `scripts/Package-XDNodeDemo.ps1:63-69,75-86`, `restore-known-data.mjs`, `import-leave-ledger.mjs` | 폐기 / 보관 / 로그인 방식(R3) |
| 저장소 cwd·`Read` 도구 | READ | `scripts/claude-assistant-bridge.mjs:18,30-31,123` | R0 격리(D17) |
| `database_id`, `bucket_name` | READ | `vite.config.ts:6-7,46,54` | 변경 금지. 소스 가드 |
| 개발·운영 공용 상태 | READ/WRITE | `npm test`(build가 dist 삭제), `npm run dev`(같은 `.wrangler/state`) | D18 운영 폴더 분리 |

### 6.3 Verification

- [ ] 삭제 전, 삭제 대상 경로를 import·fetch하는 남는 파일이 0개인지 grep으로 확인한다(D1 보류 파일 제외)
- [ ] 권한 변경 뒤 HR·임금 계산의 모든 쓰기 동작이 편집 계정으로 성공하고, 보기 계정으로는 403이다
- [ ] 기존 D1 데이터(HR·급여·채용)가 새 버전에서 그대로 읽힌다. 기존 D1 사본과 운영 폴더 이전본 모두에서 확인한다
- [ ] 결재·재무 테이블이 없는 새 DB 하니스에서 HR 전 동작이 500 없이 동작한다
- [ ] 권한 매트릭스 테스트에 '레거시 finance 문서 다운로드 → 관리자·일반 모두 404'를 넣는다

---

## 7. Architecture Considerations

### 7.1 Project Level Selection

| Level | Characteristics | Recommended For | Selected |
|-------|-----------------|-----------------|:--------:|
| **Starter** | 단순 구조 | 정적 사이트 | ☐ |
| **Dynamic** | 기능별 모듈, 백엔드 | 백엔드가 있는 웹 앱 | ☑ |
| **Enterprise** | 엄격한 계층 분리 | 대규모 트래픽 시스템 | ☐ |

기존 코드베이스 구조를 따른다. `app/`에 워크스페이스 컴포넌트를 두고, `app/api/<module>/<feature>/route.ts` 라우트는 `ensureSchema` → 권한 가드 → raw D1 → `writeErpAudit` 순서로 쓴다. BaaS는 도입하지 않는다.

### 7.2 Key Architectural Decisions

| Decision | Options | Selected | Rationale |
|----------|---------|----------|-----------|
| Framework | 기존 vinext 유지 | vinext + Cloudflare Worker(로컬) | 이미 운영 중이고 교체 이득이 없다. 운영 런타임은 `vite preview`(workerd)다. `vinext start`는 쓸 수 없다 |
| 운영 런타임 | `vinext dev` / `vinext start` / `vite preview` | `vinext build` + `vite preview`(0.0.0.0:3000, explorer off) | `vinext start`는 D1·R2 바인딩이 없고 `cloudflare:workers`를 해석하지 못한다. preview는 **실행 폴더 기준** `.wrangler/state/v3`에서 상태를 읽고, DB 파일 이름도 dev와 같다(2026-09-23 스파이크 실측, §9 1번). 운영 폴더의 상태는 개발 폴더와 분리한다(D18). dev는 `127.0.0.1` 개발 전용 |
| 운영 위치 | 같은 폴더 / 별도 폴더 | 별도 운영 폴더(D18) | `npm test`가 dist를 지우고, dev가 같은 state를 연다 |
| 자동 기동 | 시스템 시작 시 / 자동 로그온 + 로그온 시 / 수동 | 시스템 시작 시, 로그온 여부와 관계없이 실행(D19). 대체안은 자동 로그온 | 업데이트 재부팅 뒤 누군가 로그온할 때까지 서버가 멈추지 않게 한다 |
| Backend | BaaS / Custom | 기존 Worker 라우트 + 로컬 D1·R2 | 데이터를 사내에 두고, 사외 접속은 없다 |
| Auth | 외부 IdP / 자체 | 자체 이메일·비밀번호 + D1 세션. HttpOnly·SameSite=Lax(Secure 없음), DB에는 토큰 해시, Origin 검사 | 5~6명, 사내망 전용, 관리자 직접 발급, http LAN |
| Password hash | bcrypt / scrypt / PBKDF2 | PBKDF2-SHA256(WebCrypto), 100,000회 | Worker 런타임에 기본 제공되고 추가 패키지가 필요 없다. 100,000회는 workerd 상한이다 |
| 첫 관리자 판정 | Host·`CF-Connecting-IP` / Node 소켓 주소 | Node 플러그인이 찍는 `x-xdm-peer` | Worker 안의 헤더는 모두 클라이언트가 정할 수 있다 |
| 권한 모델 | 역할 / 사용자별 | 계정별 탭 × 숨김·보기·편집 | D7·D12·D13 |
| AI 어시스턴트 맥락 | 저장소 파일 읽기 / JSON 맥락 전용 | JSON 맥락 전용(D17) | 파일 읽기가 탭 권한을 무력화한다 |
| 실시간 | 폴링 / SSE / WebSocket | 2~3초 폴링, 이후 SSE | D6. 6명 규모에 충분하고 재시작에 강하다 |
| 채팅 저장소 | 별도 DB / 같은 D1 | 같은 D1, 파일은 R2(연구 자료 권고: `HR_AUDIO` 버킷의 `chat/` 접두사, Design에서 확정) | 백업 단위가 하나다 |
| 백업 | 실행 중 복사 / 정지 후 복사 / `VACUUM INTO` | 정지 후 복사 + integrity_check | 실행 중에는 WAL과 workerd 파일 잠금 때문에 일관성이 보장되지 않는다 |
| State Management | 기존 useState | 기존 방식 유지 | SPA 셸 관례 |
| Testing | node --test | 기존 `node --test` + 세션 기반 메모리 SQLite 하니스, react-dom/server 셸 렌더, 번들 검사 | 기존 관례. 브라우저 자동화 도구는 없다 |

### 7.3 Architecture Approach

세부 구조(파일 배치, 테이블 스키마, 탭 → API 대응표, 폴링 API 모양)는 Design 단계에서 정한다. Design 비교 자료는 세 안을 냈다.

| 안 | 요지 | 신규 파일(약) |
|----|------|:-------------:|
| A. 최소 변경 | `app/erp-platform.ts`를 제자리에서 확장한다. `authorizeErpRequest` 호출부를 그대로 두고, 게이트는 `page.tsx` 안에 둔다. 채팅은 라우트 1개다 | 16 |
| B. 계층 분리 | `app/auth`·`app/access`·`app/chat` 계층을 새로 둔다. 가드를 `authorize(db, tab, level)`로 교체하고, `page.tsx`를 분할하며, 임금 계산 API를 `/api/compensation`으로 옮긴다 | 78 |
| C. 균형 | 탭 정의(`app/access-tabs.ts`)와 인증 모듈(`auth-password.ts`, `auth-session.ts`)을 둔다. `authorizeErpRequest`는 시그니처를 유지하고 내부를 다시 짠다. 채팅은 라우트 4개, `page.tsx`는 제자리 수정이다 | 29 |

- 심사 3개 관점: 보안·정확성은 A 5, B 8, C 7이다. 유지보수·확장은 A 4, B 6.5, C 8이다. 전달·운영은 A 8, B 4.5, C 7이다. 합계는 **C 22, B 19, A 17**이다.
- Design 비교는 **C안을 권고**한다. 선택은 Design 체크포인트에서 사용자가 한다. 파일 수는 연구 자료 기준의 근사치이고, Design 부록에서 확정한다.
- 세 안 모두 운영 런타임 `vite preview`와 Node 쪽 루프백 판정을 전제로 한다. 이 Plan도 같다. 심사에서 모든 안에 공통으로 나온 보완(어시스턴트 격리, 잠금 경쟁)은 이 Plan에 반영했다. 나머지 보완 항목은 Design에서 정리한다.

---

## 8. Convention Prerequisites

### 8.1 Existing Project Conventions

- [x] `CLAUDE.md`에 아키텍처·라우트 패턴·테스트 관례 있음
- [ ] `docs/01-plan/conventions.md` 없음. 이번 사이클에서는 만들지 않고 `CLAUDE.md` 관례를 따른다
- [x] ESLint(`eslint.config.mjs`), TypeScript(`tsconfig.json`)

### 8.2 Conventions to Follow

| Category | Rule |
|----------|------|
| 사용자 문구 | 한국어 |
| API 라우트 | `ensureSchema` → 권한 가드 → raw D1 → 변경 시 `writeErpAudit`. 비GET은 Origin 검사. 본문은 권한 검사 뒤에 읽는다 |
| 테스트 | 새 파일은 `package.json` test 목록에 등록 |
| 실데이터 파일 | `app/hr-company-data.ts` 등 실제 회사 데이터는 정확성 민감. 직원 명부·보상 시드는 `server-only` |
| 운영 런타임 | 운영은 운영 폴더의 `vite preview`로만 한다. `vinext dev`는 `127.0.0.1` 개발 전용이다. `vinext start`·`wrangler dev`는 쓰지 않는다 |
| 비밀값 | `.env.local`은 백업·패키지·어시스턴트 맥락에 넣지 않는다. preview에는 허용 목록 키만 `.dev.vars`로 넘긴다 |
| 브리지 | `127.0.0.1` 바인딩, Origin이 붙은 요청 거부, 저장소 파일 읽기 없음(D17) |
| 변경 금지 값 | `database_id`, `bucket_name`, `XD_NODE_*` 환경변수 이름 |

### 8.3 Environment Variables

| Variable | Purpose | Change |
|----------|---------|--------|
| `LOCAL_ERP_USER_EMAIL`, `LOCAL_ERP_USER_NAME` | 단일 신원 대체 | R3에서 **제거**. 그 전까지는 서버 PC 전용 신원(D16) |
| `GOOGLE_OAUTH_*`, `GOOGLE_SALES_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_*` | 영업 시트 연동 | **제거**. R0에 사용자가 Google 콘솔에서 서비스 계정 키를 폐기하고 refresh token을 철회한 뒤, `.env.local`과 `localRuntimeVars`에서 지운다. `localRuntimeVars`가 넘기는 것은 `GOOGLE_OAUTH_*`·`GOOGLE_SALES_SHEET_ID`뿐이고, 서비스 계정 키는 `.env.local`에 있다 |
| `CLOUDFLARE_AI_MODEL` | 재무 AI 전용(`/api/finance/assistant`, `/api/finance/daily-treasury`) | R1에서 `.env.local`과 `localRuntimeVars`에서 **제거** |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_TRANSCRIPTION_MODEL` | HR 면접 전사 | 유지. 토큰 교체를 검토한다(사용자 작업, Workers AI 전용 권한). preview에서는 `dist/server/.dev.vars`로 전달한다 |
| `X_LOCAL_EXPLORER` | Miniflare explorer | 항상 "false"(R0부터) |
| `CLAUDE_ASSISTANT_BRIDGE_URL`, `CLAUDE_BRIDGE_URL` | 브리지 주소 | 유지. `.dev.vars` 허용 목록에 포함 |
| `XD_NODE_PROJECT_PATH` | 브리지가 시작할 때 스키마·`buildPrompt`를 읽는 경로 | 유지(이름 변경 금지). 운영에서는 운영 폴더를 가리킨다. cwd로는 쓰지 않는다(D17). M7에서는 개발 폴더 쪽 값만 새 경로로 |
| `XDM_EMAIL`, `XDM_PASSWORD` | `import-leave-ledger.mjs` 로그인 | 신규(R3). 스크립트를 실행할 때만 설정 |

### 8.4 Pipeline Integration

9단계 개발 파이프라인은 쓰지 않는다. 이 기능은 PDCA 사이클(PRD → Plan → Design → 릴리스 R0~R6)로 진행한다.

---

## 9. Next Steps

0. [ ] **R0 즉시 보안 조치**(Design을 기다리지 않는다). 바인딩은 완료했다(D16). 남은 것은 explorer off, fs.deny, 방화벽 정리, 브리지 격리(D17)와 Origin·Host 검사, 사용자 작업(Google 서비스 계정 키 폐기, refresh token 철회, `GOOGLE_*` 삭제, `CLOUDFLARE_API_TOKEN` 교체 검토)이다
1. [x] 스파이크(2026-09-23 완료): preview에서 D1·R2 바인딩과 상태 경로를 실측했다. `127.0.0.1:3001`로, state 사본을 둔 별도 폴더(`C:\xdm\spike`, 끝난 뒤 삭제)에서 했다(D16·D18 예행연습). 결과는 다음과 같다
   - **동작함.** `dist/server/.dev.vars`를 읽는다(로그 'Using secrets defined in dist\server\.dev.vars'). 그래서 R3의 '빌드마다 `.dev.vars` 쓰기'가 유효하다. HR 인사기록 30건이 조회됐다. R2 문서(PDF 2,024,244바이트)는 dev와 같은 바이트로 내려왔다
   - **상태 경로는 실행 폴더 기준이다.** 같은 DB 파일 이름(`faaf2b…`)을 스파이크 폴더 쪽 사본에서 열고 거기에 기록했다. 따라서 D18 데이터 이전은 '서버 정지 → `.wrangler/state`를 운영 폴더로 복사'로 충분하다. 실제 DB는 `faaf2b…sqlite`(13.4MB)다. `c9177…sqlite`(4KB)는 빈 잔재지만 miniflare가 함께 연다. 백업은 폴더 전체를 복사한다
   - **정적 서빙은 `dist/client`만 한다.** `/app/page.tsx`, `/package.json`, `/vite.config.ts`, `/.wrangler/deploy/config.json`, `/dist/server/.dev.vars`는 모두 404였다. explorer API도 `Host: localhost`로 404였다
   - **새로 발견한 점.** `/__debug`는 200을 돌려주고 Cloudflare devtools로 넘긴다(`ws=localhost:9230`, workerd 인스펙터). 인스펙터는 지금 `127.0.0.1:9229`(dev)·`9230`(preview)에만 열려 있다. R3에서 `--host 0.0.0.0`으로 띄울 때 인스펙터가 계속 루프백에만 있는지 확인한다. 루프백 판정 플러그인은 비루프백의 `/__debug`를 `/cdn-cgi/*`처럼 404로 막는다. 가능하면 cloudflare 플러그인 설정으로 인스펙터를 끈다. 이 항목은 Design에 넣는다
   - **클라이언트 번들 PII는 그대로다**(`annualSalary`가 든 청크 2개). R1의 PII 서버 전용 분리가 필요하다는 점이 다시 확인됐다
2. [ ] `/pdca design xdnode-management`: 3개 안 비교(C안 권고), 테이블 스키마, 탭 → API 대응표, 삭제·수정 파일 부록(수량 확정), 릴리스별 세션 계획
3. [ ] Design 체크포인트: 안을 선택하고, §1.2 충돌 항목(`incentive-governance.tsx` 삭제 여부, 루프백 잠금 예외 또는 두 번째 관리자 계정, D10 허용 목록 수단 변경, `audit`·`admin` 관리자 전용 처리)을 사용자에게 확인한다
4. [ ] PRD 문구 정정: T-01(루프백 0계정 부트스트랩), T-08의 '(origin 허용 후)' 삭제, Workstream R 표의 'ALLOWED_MODULES sales 제거' → incentive 이름 변경. D1의 `incentive-governance.tsx` 표기는 체크포인트 결과에 따른다
5. [ ] 구현은 R1부터 릴리스 순서대로 한다. `/pdca do xdnode-management --scope r1` 형태로 나눠 진행한다. M3·M4·M5a는 같은 브랜치에서 개발해 R3로 한 번에 배포한다. 중간 커밋은 운영 PC에 반영하지 않는다

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-09-23 | 초안(PRD D1~D11 + Plan 체크포인트 D12~D15 반영) | gc.kim / Claude Code |
| 0.2 | 2026-09-23 | 코드 대조 검토 33건 반영(`incentive-governance.tsx` 삭제 권고는 D1에 따라 충돌 기록만, 루프백 잠금 예외는 D15에 따라 보류). 범위를 릴리스 R0~R6로 재편: R0 즉시 보안, R3=M3+M4+M5a 단일 배포, 릴리스별 롤백. 검토 질문 답변 D16~D19 추가(R0 바인딩 완료 표시, 브리지 파일 읽기 제거, 운영 폴더 분리·데이터 이전 절차, 자동 기동과 확인 절차). 운영 런타임을 `vite preview`로 정정. 비밀값 폐기 사용자 작업, FR-19~FR-21, SC-9~SC-13, PRD·결정 충돌 표 추가. 7.3에 Design 비교 권고(C안, 22·19·17) 기록. 2차 검증 반영: SC-4는 운영 DB가 아닌 점검용 인스턴스에서 실행, R3 롤백의 대체 신원 복원, 서버 기동 경로를 자동 기동 작업 하나로 통일, 브리지 `--tools ""`, 방화벽 삭제 대상 규칙 이름 명시, `audit`·`admin` 관리자 전용 처리를 충돌 표에 기록, 코드 줄 번호 정정, 8.4 추가, 용어 한국어 통일 | gc.kim / Claude Code |
