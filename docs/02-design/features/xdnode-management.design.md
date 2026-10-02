# xdnode-management Design Document

> **Summary**: XD NODE ERP를 "XDnode management"로 재편하는 설계. 재무·영업·결재를 걷어내고 HR 결재 7흐름을 즉시 반영으로 바꾼다(R1). 계정·30일 세션·탭별 숨김/보기/편집 권한·`vite preview` 운영 전환을 한 번에 배포한다(R3). 백업·자동 기동(R4)과 폴링 메신저(R5)를 붙인다. 설계안은 C(균형, D20)다.
>
> **Project**: XDnode management (현 `site-creator-vinext-starter`)
> **Version**: 0.1
> **Author**: gc.kim (Claude Code 협업)
> **Date**: 2026-09-23
> **Status**: Draft
> **Planning Doc**: [xdnode-management.plan.md](../../01-plan/features/xdnode-management.plan.md) (v0.2, D1~D23, R0~R6, FR-01~FR-21, SC-1~SC-13)
> **PRD**: [xdnode-management.prd.md](../../00-pm/xdnode-management.prd.md) (결정 D1~D11은 §6.1·§6.2)

### Pipeline References

| Phase | Document | Status |
|-------|----------|--------|
| Phase 1 | Schema Definition | N/A. 스키마는 이 문서 §3에 둔다 |
| Phase 2 | Coding Conventions (`docs/01-plan/conventions.md`) | N/A. 기준은 `CLAUDE.md`, 이 문서 §10(Plan §8.1) |
| Phase 3 | Mockup | N/A. 화면 요소는 §5.4 체크리스트로 대신한다 |
| Phase 4 | API Spec | N/A. API는 이 문서 §4에 둔다 |

> 9단계 파이프라인은 쓰지 않는다. PDCA(PRD → Plan → Design → 릴리스 R0~R6)로 진행한다(Plan §8.4).
>
> Design Anchor 절은 두지 않는다. Pencil MCP를 쓰지 않고, 시각 체계는 기존 `app/globals.css` 토큰을 그대로 쓴다(§5.7).

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

## Decision Record

충돌하면 D20~D23 > Plan v0.2(D1~D19, FR·SC) > 이 문서 > Option C 원안 > 심사 보완안 순서로 따른다. 릴리스 번호는 Plan의 R0~R6만 쓴다.

| ID | 결정 (한 줄) | 출처 |
|----|--------------|------|
| D1 | 임금 계산과 인센티브 계산기(`app/incentive/`)는 유지하고 영업 연결만 끊는다. `incentive-governance.tsx` 유지 문구는 D22가 대체한다 | PRD §6.1 |
| D2 | 재무 지향 공용 기능(데이터 인테이크·거버넌스·연동, 마스터 영향, 운영 워크벤치)을 제거한다. 감사 기록·권한 검사는 유지한다 | PRD §6.1 |
| D2-개정 | 결재 기능 전체(`approval-engine.ts`, `/api/approvals`, `/api/approval-settings`, `approval-center.tsx`, `erp_approval_*` 생성)를 제거한다 | PRD §6.1 |
| D2-a | HR의 결재 의존을 '편집 권한자 즉시 반영'으로 바꾼다(실제 7흐름, §12.2) | PRD §6.1, Plan §1.2 |
| D2-b | 급여 마감·재오픈의 재무 연결(`finance_expense_requests` 등)을 끊는다 | PRD §6.1 |
| D2-c | 감사 로그 조회 화면은 관리자 전용 탭으로 유지한다 | PRD §6.1 |
| D3 | 태그 + 아카이브 브랜치를 만든 뒤 완전 삭제한다. 재무 실데이터는 작업 트리 밖에 둔다 | PRD §6.1, Plan §1.2 |
| D4 | 기존 D1 테이블은 DROP하지 않고 생성만 멈춘다. 작업 전 스냅샷을 뜬다 | PRD §6.1 |
| D5 | 메신저 MVP 범위: 공개·비공개 채널, DM, 1단계 스레드, 첨부 25MB, 멘션, 안 읽은 수, 검색, 본인 수정·삭제 | PRD §6.2 |
| D6 | 실시간은 2~3초 폴링으로 시작하고, 메시지는 같은 D1에 둔다 | PRD §6.2 |
| D7 | 관리자 1명이 계정을 직접 만들고 계정마다 탭 권한을 준다(자가 가입 없음) | PRD §6.2 |
| D8 | 견적서 자동화 툴은 이번 범위 밖이다. 탭 추가 구조만 만든다 | PRD §6.2 |
| D9 | `sales-pricing.ts` 견적 로직은 승계하지 않는다 | PRD §6.2 |
| D10 | 사무실 LAN 전용. HTTPS·VPN·외부 접속은 범위 밖. 다른 PC에서도 어시스턴트가 동작해야 한다(수단은 D23) | PRD §6.2 |
| D11 | 표시명·패키지·스크립트·폴더·저장소를 모두 리네임한다. 폴더·저장소는 맨 마지막 | PRD §6.2 |
| D12 | 권한은 상위 탭 단위로만 준다. HR 탭을 받으면 급여관리도 본다 | Plan §1.2 |
| D13 | 탭마다 숨김/보기/편집. 편집에 상태 변경이 포함된다 | Plan §1.2 |
| D14 | 계정과 인사기록의 연결은 선택이다. '인사기록에 없으면 403'을 없앤다 | Plan §1.2 |
| D15 | 세션 30일, 비밀번호 8자 이상, 5회 실패 시 5분 잠금, 발급·초기화 비밀번호는 첫 로그인 때 변경 | Plan §1.2 |
| D16 | R3 운영 전환 전까지 서버 PC 전용(dev `127.0.0.1`, 2026-09-23 완료) | Plan §1.2 |
| D17 | 어시스턴트 브리지는 파일을 읽지 않는다. 맥락은 `/api/assistant`가 넘기는 JSON뿐이다 | Plan §1.2 |
| D18 | 운영은 별도 폴더(`C:\xdm\prod`)에서 태그를 빌드해 돌린다. 데이터는 한 번 옮긴다 | Plan §1.2 |
| D19 | 재부팅 뒤 작업 스케줄러 '시스템 시작 시' 트리거로 기동한다. 대체안은 자동 로그온 + '로그온 시' | Plan §1.2 |
| D20 | 설계안 C(균형). 레지스트리 1개를 화면과 서버가 함께 쓰고 `authorizeErpRequest` 시그니처를 유지한다. 심사 필수 보완·이식 항목을 반영한다(§2.0) | Design 체크포인트 |
| D21 | 서버 PC(Node가 확인한 루프백)에서 하는 로그인은 잠금 검사를 건너뛰되 실패는 기록한다. D15의 유일한 예외 | Design 체크포인트 |
| D22 | `app/incentive-governance.tsx`는 영업 코드와 함께 삭제한다. 계산기와 임금 계산 탭의 인센티브 모드는 유지한다 | Design 체크포인트 |
| D23 | 감사 로그·계정 관리 탭은 관리자 전용이다. 계정별 부여는 hr·compensation·chat만. 브리지 허용 주소는 넓히지 않는다 | Design 체크포인트 |

D21·D22·D23으로 Plan §1.2 충돌 표의 세 행(D1 `incentive-governance.tsx` 보류, D15 루프백 예외 보류, D12·D13 audit·admin 처리)과 D10 수단 변경 확인은 닫힌다. Plan의 FR-01 예외 문구('D1 보류 파일')와 NFR Maintainability의 문자열 검사 예외도 없어진다.

---

## 1. Overview

### 1.1 Design Goals

1. **노출 경계를 세 층에서 닫는다.**
   - Node(`build/local-peer-vite-plugin.ts`): 믿을 수 있는 peer 주소는 여기서만 정한다. 비루프백 요청의 `/cdn-cgi/*`·`/__debug*`·`upgrade`·부트스트랩은 Worker에 닿기 전에 끊는다.
   - Worker(`worker/index.ts`): 교차 출처 비GET 요청을 막고 전역 보안 헤더를 붙인다.
   - 라우트 가드(`authorizeErpRequest`): 세션과 탭 권한을 검사한다.
   - 대응: FR-07, FR-10, FR-19, SC-9, SC-10.
2. **화면과 서버가 같은 정의를 쓴다.**
   - `TAB_REGISTRY` 하나에서 `TabKey`·`ErpModule`·`MODULE_TAB`을 파생한다.
   - 화면은 `TAB_PANELS` 전수 맵으로 그린다.
   - `authorizeErpRequest(db, module, action)`는 시그니처를 그대로 두고 내부만 바꾼다. 유지 라우트 22개의 호출부 56개(`authorized-users` 3개를 뺀 수, 2026-09-23 grep)가 한 번에 보호된다.
   - 대응: FR-09, FR-10, FR-16, SC-2.
3. **실데이터는 권한 검사를 거친 API로만 내려간다.**
   - `dist/client`의 실데이터 표지는 0건이다.
   - roster는 4필드만 준다. `include=hr`에서는 `birthDate`를 뺀다.
   - 어시스턴트는 권한 검사를 거친 JSON 맥락만 본다.
   - 대응: FR-20, FR-21, SC-9, SC-11.
4. **감사 기록의 행위자는 실제 계정이다.**
   - 보안 이벤트와 Node가 확인한 접속 주소를 남긴다.
   - 비밀번호·토큰·쿠키·채팅 본문은 남기지 않는다.
   - 대응: FR-11, SC-3.
5. **결재를 걷어내도 HR이 회귀하지 않는다.**
   - 결재 7흐름은 `app/hr-transitions.ts`의 문장 생성기로 즉시 반영한다.
   - 레거시 대기 상태도 from-state로 받는다.
   - 대응: FR-02, FR-03, SC-4.
6. **서버 PC 한 대로도 믿을 수 있게 운영한다.**
   - 운영 폴더에서 `vite preview`로 돌린다.
   - 백업은 정지 후 read-only 사본으로 무결성을 검사한다.
   - 자동 기동은 '시스템 시작 시' 트리거로 한다.
   - 대응: FR-17, SC-7, SC-12, SC-13.
7. **채팅 폴링은 가볍게 유지한다.**
   - 2초 주기로 폴링한다.
   - hot path는 게이트 0쿼리, 세션 1쿼리, 이벤트 1쿼리다.
   - 비멤버에게는 404를 준다.
   - 대응: FR-12~15, SC-6, NFR p95 ≤ 200ms.
8. **릴리스마다 되돌릴 수 있다.**
   - 스키마는 추가만 한다(D4).
   - R3는 한 번에 배포한다.
   - R5 채팅은 레지스트리 항목·패널·라우트·DDL을 한 묶음으로 넣고 뺀다.
   - 비목표: HTTPS, 2단계 인증, HR 하위 메뉴 권한, 온라인 백업, SSE(D6·D10·D12).

### 1.2 Design Principles

- **Fail closed.** 판단할 근거가 없으면 거부한다.
  - 모르는 모듈과 action은 false다. isAdmin 판정보다 먼저 거른다.
  - peer 헤더가 없거나 값이 여러 개면 비루프백으로 본다.
  - 세션이 없거나 만료·폐기·비활성이면 401이다.
  - 탭 대응표에 없는 문서 module은 관리자에게도 404다.
  - `tabs_json`의 모르는 키와 adminOnly 키는 버린다.
- **신뢰의 근거는 Node가 본 소켓 주소 하나다.**
  - `Host`·`Origin`·`CF-Connecting-IP`로는 서버 PC 여부를 판정하지 않는다.
  - Worker가 믿는 헤더는 `x-xdm-peer` 하나다. 플러그인이 클라이언트 값을 지우고 다시 쓰기 때문이다.
- **한 정의에서 파생만 한다.** 탭·모듈·API 접두사·셸 클래스는 `TAB_REGISTRY`에만 정의하고, 나머지는 여기서 파생해 쓴다.
- **시그니처는 유지하고 내부만 바꾼다.** CLAUDE.md의 라우트 골격(`ensureSchema` → `authorizeErpRequest` → raw D1 → `writeErpAudit`)을 지킨다.
- **인가 먼저, 본문은 그 뒤.** 인가 전에는 본문을 버퍼링하거나 파싱하지 않는다(부록 B #27, 대상 8곳은 §4.3).
- **최종 방어는 서버다.**
  - 권한 없는 탭은 렌더하지 않는다.
  - 보기 계정에게는 편집 버튼이 보여도 서버가 403으로 막는다.
  - 화면에서 무엇을 숨기든 그것을 보안 통제로 치지 않는다.
- **게이트 스키마에서 추가만 한다.** 인증·채팅·운영 DDL은 `ensureErpPlatformSchema`에만 둔다. DROP은 하지 않는다.
- **최소 공개.** DTO·감사·로그에는 목적에 필요한 필드만 싣는다.
  - roster는 4필드다.
  - 채팅 감사는 id·길이·개수만 남긴다.
  - 임시 비밀번호는 `temporaryPasswordIssued:true`만 남긴다.
- **평탄한 배치와 하니스 제약을 지킨다.** 파일은 `app/<도메인>-*.ts`로 둔다. 서버 코드는 확장자 없는 상대 경로로 `.ts`만 import한다(§10.2).
- **운영 기동 경로는 하나다.** 모든 재기동은 `Start-ScheduledTask XDnodeManagement-Autostart`로 한다.
- **문구는 한국어로 쓰고, 분기는 code로 한다.** 오류는 `{ error: "<한국어>", code: "<UPPER_SNAKE>" }` 형태이고, 클라이언트는 status와 code로만 분기한다.

---

## 2. Architecture Options

### 2.0 Architecture Comparison

수치는 설계 연구 자료(`result.options`, `result.judges`)에서 가져왔다. 'C 확정' 열은 §11.1 파일 목록과 부록 A 기준이다.

| 기준 | A: 최소 변경 | B: 계층 분리 | C: 균형(원안) | **C 확정(이 문서)** |
|---|:-:|:-:|:-:|:-:|
| 접근 | `erp-platform.ts`를 제자리에서 확장하고 파생 호환 역할을 둔다 | `app/auth`·`app/access`·`app/chat` 계층을 두고 `authorize(db, tab, level)`로 교체한다 | 레지스트리 1개, 인증 모듈 3개, 시그니처 유지 | C 원안에 심사 보완을 반영(아래 표) |
| 신규 파일 | 16 | 78 | 29 | **50**(R1 6, R3 27, R4 5, R5 12) |
| 수정 파일 | 54 | 69 | 60 | 약 60(부록 A.5) |
| 삭제 파일(약) | 132 | 132 | 128 | **129**(R1 120 + finance 테스트 5 + R3 4). 문서 47개는 `docs/archive/`로 옮긴다 |
| 가드 호출부 변경 | 리터럴 3개 | 22개 파일의 호출부 56개 전부 | 모듈 인자 5곳 | 리터럴 모듈 교체 5개 파일(compensation·assistant·audit-log·documents·transcriptions), 중첩 인가 제거 4곳, 인가 선행 8곳. 나머지 호출부는 그대로 둔다 |
| 채팅 라우트 | 1(약 900줄) | 약 20개 파일 | 4 | 5(`poll` 분리) |
| `page.tsx` | 제자리 수정, 인증 화면 내장 | 셸 분할(약 10줄) | 제자리 수정 | `TAB_PANELS` 전수 맵 + `app/shell-top-nav.tsx` |
| 복잡도 / 유지보수성 / 공수 | Medium / Low / Medium | High / High / High | Medium / High / Medium | Medium / High / Medium |
| 위험 | Medium. 모든 책임이 한 모듈에 몰려, 매핑 실수 하나가 전 라우트로 번진다 | Medium-High. 호출부 56개 교체와 경로 이동을 한 번에 배포한다 | Medium. HR 즉시 반영을 옮기는 실행 위험 | Medium. 실행 위험은 원안과 같고, 보안 결함 5건은 보완했다 |
| 심사 1: 보안·정확성 | 5 | **8** | 7 | — |
| 심사 2: 유지보수·확장 | 4 | 6.5 | **8** | — |
| 심사 3: 전달·운영 | **8** | 4.5 | 7 | — |
| **합계** | 17 | 19 | **22** | — |
| 이 안을 권고한 심사 | 전달·운영 | 보안·정확성 | 유지보수·확장 | — |

**Selected: C** (Design 체크포인트 2026-09-23, D20)

- 세 관점 합계가 가장 높다(22).
- CLAUDE.md의 라우트 골격과 `authorizeErpRequest` 시그니처를 지킨다. B는 호출부 56개 교체와 `/api/compensation` 이동을 R3 한 번에 배포해야 해서 정확성 위험이 가장 크다.
- A는 역할을 흉내 내고 `erp-platform.ts` 한 파일에 모든 것을 모은다. C는 레지스트리 하나를 화면과 서버가 함께 쓴다.
- 심사 1에서 B와의 차이(8 대 7)는 C 원안의 결함 5건 때문이다. 아래 이식 항목 #5·#9·#16·#19·#23·#32로 메운다.
- 심사 3에서 A와의 차이(8 대 7)는 `setIdentity` shim의 기대값 불일치와 기존 테스트 수정량 때문이다. #21·#25로 메운다.

> 아래 상세 설계는 C 확정안을 따른다. Option C 원안과 달라진 점 28건은 부록 B에 모았다. 본문의 '부록 B #N'은 그 표의 행 번호다.

**C에 반영한 필수 보완과 이식 항목**

| # | 항목 | 출처 | 반영 위치 |
|---|------|------|-----------|
| 1 | `TAB_REGISTRY[].modules`에서 `TabKey`·`ErpModule`·`MODULE_TAB`(`Map`)을 파생한다. 모르는 모듈은 isAdmin보다 먼저 거부한다 | 심사2 필수 1·2, 심사3 필수 1, A 이식 | §4.3.1, 부록 B #17 |
| 2 | `isHrManager(principal)` 하나를 레지스트리에 둔다 | 심사2 필수 5 | 부록 B #18 |
| 3 | `TAB_PANELS: Record<TabKey, …>`를 쓰고 상단 내비는 `app/shell-top-nav.tsx`로 뺀다 | 심사2 필수 4 | §5.3, 부록 B #19 |
| 4 | 소스 가드: 리터럴 모듈의 탭이 경로의 `apiPrefixes` 탭과 같아야 한다. 동적 모듈은 assistant 하나만 허용한다 | 심사2 필수 3, B 이식 | §4.3 |
| 5 | `/api/compensation`으로 옮기고 `GET /api/compensation/roster`(4필드)를 새로 둔다 | 심사2 이식(B), 심사1 필수 9 | §4.2.7, 부록 B #5 |
| 6 | `include=hr`의 `birthDate`를 `""`로 내린다(`app/api/hr/compensation/route.ts:129`) | 심사1 필수 9 | 부록 B #6 |
| 7 | 문장 생성기는 `app/hr-transitions.ts`에 두고, `db.batch`와 `meta.changes` 검사는 라우트에 남긴다 | 심사2 이식(B) | §12.2, 부록 B #21 |
| 8 | 레거시 from-state를 받고 `personnelActionDecision`·`retirementDecision` PUT을 둔다. 사전 조회는 HR 테이블을 직접 한다 | 심사1 필수 7, C 결함 3 | §4.1, §12.1 |
| 9 | 영업 인센티브·재무 재오픈의 409는 정적 목록으로 판정한다. 목록은 실제로 있는 컬럼(`payroll_period`·`applied_amount`)으로 사전 조회해 채운다 | 심사1 필수 6, C 결함 1, 심사3 필수 2 | §12.3, 부록 B #22 |
| 10 | 로그인 시도는 검증 전에 원자적으로 예약한다 | 심사1 필수 2 | 부록 B #8, §7.4 |
| 11 | 관리자 잠금 DoS 대책: 루프백 예외(D21), UNLOCK, `reset-admin-password.mjs` | 심사1 필수 4 | D21, §7.4 |
| 12 | `PUT /api/hr/employee-records`와 `PUT /api/hr/recruitment`(입사 전환·오퍼 수정)에서 `acct_` id를 400으로 거부한다 | 심사1 필수 5 | §4.3 |
| 13 | `upgrade` 리스너를 전부 감싼다. 부트스트랩은 `Upgrade`를 거부하고 JSON만 받는다 | 심사1 필수 3 | 부록 B #10, §7.6 |
| 14 | 플러그인에 `enforce:"pre"`를 주고 배열 첫 항목에 둔다. R3 스모크에서 위조 peer 헤더를 시험한다 | 심사3 필수 9 | 부록 B #10, §11.5.9 |
| 15 | 비루프백 `/cdn-cgi/*`·`/__debug*`는 404, `cloudflare({ inspectorPort:false })` | 심사1 이식(C), 스파이크 | 부록 B #10 |
| 16 | 인가를 본문 읽기보다 먼저 한다(8곳) | 심사1 C 결함 4, B 장점 | 부록 B #27, §4.3 |
| 17 | CSRF: worker가 비GET을 먼저 막고, 가드와 인증 라우트는 메서드와 무관한 규칙을 적용한다 | 심사1(A·C 평가), B `assertSameOrigin` | 부록 B #11, §7.3 |
| 18 | 전역 `nosniff`·`X-Frame-Options`·`Referrer-Policy` | 심사3 이식(B·C), 심사1 A 결함 3 | §7.7 |
| 19 | 채팅 감사에 본문을 남기지 않는다. 원안의 200자 미리보기도 없앤다 | 심사1 필수 8 | 부록 B #14 |
| 20 | poll 라우트를 분리하고 `accessStamp`를 없앤다. `/api/me`는 60초마다, 그리고 focus·visibility 변화 때 다시 불러온다 | 심사2 필수 8·9 | 부록 B #12, #16 |
| 21 | 채팅 DDL은 `app/chat-schema.ts`로 분리하고 게이트 스키마가 모아서 실행한다 | 심사3 필수 3 | 부록 B #13 |
| 22 | 읽음 위치는 이벤트 로그에 쓰지 않는다(poll 전파 제한) | 심사3 필수 4 | §3.3 |
| 23 | `watch`는 공개·비보관 채널만 받는다 | 심사1 C 결함 2 | §4.2.8, §2.2 |
| 24 | `randomId()`·`copyText()`·`scopedKey`를 쓴다. `"use client"` 파일의 `crypto.randomUUID(`는 0건이어야 한다 | 심사3 필수 5, 심사1 이식 | §5.5·§5.6, §8.6 |
| 25 | 하니스에 `setAccess(tabs)`를 두고 관리자 해시는 1회만 계산한다. `setIdentity` shim은 제거 계획을 세운다 | 심사2 필수 7, 심사3 필수 6, A 이식 | 부록 B #20, §8.5 |
| 26 | removal-guards 계층 단언: `@/`·디렉터리 index·`.tsx`·`cookies()`·`'use server'` 0건 | 심사2 이식(B) | §8.6 |
| 27 | `access-policy` 순수 테스트, 빌드 뒤 번들 검사 | 심사2·3 이식(B) | §8.6 |
| 28 | 정지 후 read-only 백업, 무결성 검사, blob 단일 저장소(`robocopy /E`) | 심사3 필수 7 | 부록 B #24, §11.5 |
| 29 | Stop 스크립트, pid, `dist/.build-rev`, 전원 설정, 무인 기동 | 심사3 필수 8, 이식(B) | §11.5 |
| 30 | 스크립트 계정은 첫 로그인 때 비밀번호를 한 번 바꾼다 | 심사3 필수 11 | runbook |
| 31 | R3 롤백 경로: 태그, 정지 후 스냅샷, 대체 신원 복원 | 심사3 필수 10 | Plan R3 롤백, §12.9 |
| 32 | 재무 실데이터는 작업 트리 밖에 둔다 | 심사1 C 결함 5, 이식 | 부록 B #3 |
| 33 | CLAUDE.md에 탭 추가 방법·게이트 DDL·하니스 규칙을 적는다 | 심사2 필수 6 | §10.7, §11.2 |
| 34 | 브리지: `--tools ""`, 빈 임시 cwd, Origin·Host 검사 | 심사1 필수 1, 심사3 이식 | R0 완료 |
| 35 | 성과 이의제기 값을 `RESOLVED`로 | 심사3 이식(C) | §12.3 |
| 36 | 채팅 탭이 보일 때 poll 주기 2초 | 심사3 이식(B) | 부록 B #16 |

**반영하지 않은 항목**
- `/api/directory`(B): 부록 B #25.
- poll `accessStamp`(심사3이 A에서 이식하자고 한 것): #20으로 대체했다.
- `/incentive` 삭제(C 원안): D1·D22, 부록 B #1.
- `archive/finance-data/`: 부록 B #3.
- `restore-known-data.mjs` 삭제: 부록 B #4.
- 백업 02:00, 로그온 트리거, `/MIR`: 부록 B #24.
- 비멤버에게 403: 404로 바꿨다(부록 B #15).
- 로그아웃할 때 localStorage 키 전부 삭제(A 이식): 계정 범위 키로 대체하되, 급여성 데이터 키 4개만은 로그아웃·401 때 지운다(§5.5).
- `server.allowedHosts`·`preview.allowedHosts`에 PC 이름 추가(C 원안 §8): DNS rebinding 방어를 약하게 하므로 쓰지 않는다(§7.3).

### 2.1 Component Diagram

한글 폭 때문에 오른쪽 테두리는 두지 않고, 들여쓰기로 계층을 표시한다.

```
사무실 LAN (NIC 프로필 Private)
│  방화벽 인바운드는 'XDnode management 3000 (LAN)' 하나(TCP 3000, RemoteAddress=LocalSubnet; R3 7→8단계로 개방)
│
├─ 다른 PC 브라우저   http://192.168.x.x:3000   (비보안 컨텍스트: Sec-Fetch-* 없음, randomUUID·clipboard·getUserMedia 불가)
├─ 서버 PC 브라우저   http://localhost:3000     (보안 컨텍스트. 부트스트랩·D21 루프백 로그인은 여기서만)
│        │ 평문 HTTP/1.1, 쿠키 xdm_session (HttpOnly; SameSite=Lax; Secure 없음)
▼        ▼
서버 PC ─ 운영 폴더 C:\xdm\prod ───────────────────────────────────────────────────────────
│
├─ Node: vite preview 0.0.0.0:3000 (npm run serve:lan, 작업 스케줄러 XDnodeManagement-Autostart)
│   ① Vite hostValidation: allowedHosts 기본값 = IP·localhost만 (vite node.js:33785, dev는 :26317)
│   ② xdm-local-peer 플러그인 (enforce:"pre", plugins[0])            ← 신뢰 경계 B1
│      · 클라이언트의 x-xdm-peer를 req.headers·req.rawHeaders에서 모두 지우고 socket 주소 1개를 기록
│      · 비루프백: /cdn-cgi/*, /__debug* → 404 / /api/auth/bootstrap → 403 BOOTSTRAP_LOCAL_ONLY
│      · 'upgrade' 리스너 감싸기: preview는 전부 socket.destroy()
│   ③ @cloudflare/vite-plugin 디스패처 (index.mjs:53310-53312, createHeaders(rawHeaders) :1550)
│        │ miniflare.dispatchFetch
│        │ X_LOCAL_EXPLORER=false, inspectorPort:false → 9229·9230 LISTEN 없음
▼        ▼
├─ workerd
│   ├─ asset router ─ dist/client (JS·CSS·이미지·docx 서식. Worker보다 먼저 응답 → 실데이터 0건이어야 함)
│   └─ Worker worker/index.ts                                         ← 신뢰 경계 B2·B3
│       · /api/* 비GET: crossOriginWriteViolation → 403 CROSS_ORIGIN (핸들러·본문 전)
│       · 모든 응답: nosniff · X-Frame-Options DENY · Referrer-Policy same-origin (+ 기존 microphone 정책)
│       · /api/*: Cache-Control 없으면 no-store
│       └─ vinext app router
│           ├─ SSR /, /incentive → AuthLoadingShell만 (D1 미접근)
│           ├─ /api/me, /api/auth/{login,logout,password,bootstrap} → platformSchemaReady + crossSiteViolation
│           └─ /api/{hr/*, documents, compensation, assistant, audit-log, admin/*, chat/*}
│               authorizeErpRequest(db, "<리터럴 모듈>", action)       ← 신뢰 경계 B4
│                 ├─ auth-session.resolveSession (세션 1쿼리) ─ access-tabs.canAccess
│                 └─ writeErpAudit (actor = accountId)
│
├─ D1  DB        → .wrangler/state/v3/d1/miniflare-D1DatabaseObject/faaf2b….sqlite (+ -wal, -shm)
├─ R2  HR_AUDIO  → .wrangler/state/v3/r2/ (메타 sqlite + blobs; erp-documents/, hr-interviews/, applicant-interviews/, chat/[R5])
│
├─ 127.0.0.1:3130 claude-assistant-bridge ─▶ Claude CLI (--tools "", 빈 임시 cwd)   ← B5·B6
├─ 127.0.0.1:3120 claude-resume-bridge    ─▶ Claude CLI (--tools "", %TEMP%)
│     (둘 다 Origin 헤더가 있으면 403, Host는 127.0.0.1|localhost:<port>만. Worker의 서버 대 서버 fetch만 통과)
├─ outbound api.cloudflare.com   ← /api/hr/transcriptions (Workers AI, .dev.vars 허용 키)
│
├─ 정지 중에만: Backup-XDNodeManagement.ps1 → 사본 → verify-state-snapshot.mjs(readOnly) → C:\xdm\backup\yyyy-MM-dd
├─ 정지 중에만: reset-admin-password.mjs (대상 --state를 쓰는 서버가 떠 있으면 거부: pid 파일 + 127.0.0.1:3000/3100)
└─ 같은 호스트의 별개 서비스: 견적 툴 :8765 (건드리지 않음; 쿠키는 포트를 구분하지 않음 → §7.2)

개발 폴더(C:\Users\…\XDNODE): vinext dev --hostname 127.0.0.1 전용(D16. r3-runtime부터 포트 3100). R3 10단계 뒤에는 운영 데이터 원본이 아니다.
점검 인스턴스: C:\xdm\staging, preview :3001 (R3 전환 중에만, 끝나면 규칙과 폴더를 삭제)
```

### 2.2 Data Flow

**(1) 로그인 (LAN PC, 비루프백)**

```
LoginScreen ─ POST /api/auth/login {email,password}   (브라우저가 Origin: http://192.168.0.50:3000 자동 첨부)
 → Vite hostValidation (Host가 IP·localhost가 아니면 403)
 → local-peer: x-xdm-peer = 192.168.0.23 (정규화한 소켓 주소 1개)
 → worker: /api/* 비GET → crossOriginWriteViolation(method, headers): Origin host == Host 아니면 403 CROSS_ORIGIN
 → auth/login route
    1 platformSchemaReady(db) (warm: 0쿼리)
    2 h = headers(); crossSiteViolation(h) → 403 CROSS_ORIGIN
    3 본문(JSON, 작은 상한) → email = trim + lower-case
    4 SELECT … FROM auth_accounts WHERE email = ?
       · 없음 또는 active=0 → verifyPassword(getDummyHash()) → 401 INVALID_CREDENTIALS, 감사 LOGIN_FAILED(actor 'anonymous')
    5 peerOf(h).loopback=false → reserveLoginAttempt: 원자적 예약 UPDATE(§7.4), 잠금 조건은 WHERE
       · changes 0 → 검증 없이 429 LOCKED + Retry-After, 감사 LOGIN_BLOCKED
       · changes 1 → verifyPassword(저장 해시)
      peerOf(h).loopback=true(D21) → 같은 SET을 WHERE id만으로 실행 → 항상 verify
    6 실패 → 401 INVALID_CREDENTIALS, 감사 LOGIN_FAILED{peer, lockExempt?}, 이번 예약으로 5에 도달하면 ACCOUNT_LOCKED
    7 성공 → UPDATE failed_attempts=0, locked_until=NULL, last_login_at
            createSession: token = base64url(getRandomValues 32B), 저장은 hex(SHA-256(token)), peer, user_agent(200자)
            → 200 {mustChangePassword, user} + Set-Cookie: xdm_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000
            → 감사 LOGIN_SUCCEEDED{peer}
 → 클라이언트 useSession(): GET /api/me → mustChangePassword면 PasswordChangeScreen(PUT /api/auth/password) → ready
```

**(2) 일반 API 요청의 인가 (예: hr=view 계정의 `PUT /api/hr/payroll`)**

```
fetch PUT /api/hr/payroll (same-origin, 쿠키, Origin 자동)
 → local-peer stamp → worker CSRF 통과
 → payroll PUT: authorizeErpRequest(db, "hr", "write")    ← 본문(:385)보다 먼저 (R3)
    1 platformSchemaReady(db)            memo된 Promise. 실패하면 null로 되돌려 다음 요청에서 재시도
    2 h = await headers()
    3 crossSiteViolation(h)              → 403 CROSS_ORIGIN
    4 resolveSession(db, h.get("cookie")) 1쿼리: sessions JOIN accounts, revoked_at IS NULL, expires_at > now, active=1
                                         없음·만료·폐기·비활성 → 401 UNAUTHENTICATED. last_seen_at은 1시간에 한 번만 갱신
    5 must_change_password=1             → 403 PASSWORD_CHANGE_REQUIRED
    6 toPrincipal: tabs = resolveTabs(tabs_json, is_admin), employeeId = 연결 id | acct_…
    7 canAccess(p, "hr", "write"): tabOfModule("hr") = "hr" → requiredLevel = edit → view(1) < edit(2)
                                         → 감사 ACCESS_DENIED{module,action,tab,required,granted} → 403 FORBIDDEN
    8 { principal }
 → (edit 계정) 본문 → hr-transitions 생성기 → db.batch → meta.changes 0이면 409 CONFLICT
 → writeErpAudit(module "hr", actor_user_id = accountId)
 → worker: 전역 헤더 + no-store
```

**(3) 채팅 poll (R5)**

```
useChatPoll (Home 수준, tabs.chat ≠ none)
  주기: 채팅 탭 활성 + visible이면 2000ms, 그 밖에는 15000ms. 요청은 동시에 1개(AbortController)
  즉시 재요청: visibilitychange·focus·본인 전송 직후. 오류·5xx는 5s → 10s → 30s 백오프
GET /api/chat/poll?since=<seq>&summary=0|1&watch=<publicChannelId>
 → local-peer → worker (GET: CSRF 검사 대상 아님. 전역 헤더)
 → authorizeErpRequest(db, "chat", "read"): 게이트 0쿼리 + 세션 1쿼리 (DDL 없음, 감사 없음. ACCESS_DENIED만 예외)
 → watch 검증: chat_channels.kind='public' AND archived_at IS NULL일 때만 조건에 넣고, 아니면 무시
   (비공개 채널 id를 넣어 비멤버가 이벤트를 받는 경로 차단)
 → 이벤트 1쿼리: seq > since AND (내 멤버 채널(left_at IS NULL) OR channel_id = watch OR subject_account_id = me)
                ORDER BY seq LIMIT 201 (CHAT_POLL_EVENT_LIMIT 200 + 1, hasMore 판정)
   · since=0 → 커서만 돌려준다(기록을 쏟아내지 않음)
   · message.* 이벤트의 message DTO는 멤버 조건을 통과한 행만. 삭제된 메시지는 body:null
 → unread: 이벤트가 있거나 summary=1일 때만 unreadSummary
 → 200 {cursor, hasMore, events[], unread|null} (no-store)
 → 클라이언트: hasMore면 즉시 재요청, 401이면 로그인, 403 PASSWORD_CHANGE_REQUIRED면 비밀번호 화면
   document.title = "(N) XDnode management" (N=0이면 "XDnode management")
 참고: PUT /api/chat/read-state는 chat_events에 쓰지 않는다. 다른 사람의 읽음 표시는 내 증분에 오지 않는다
```

**(4) 어시스턴트 요청**

```
LocalCodexAssistant (hr·compensation 탭에만 마운트, module = hr | compensation | incentive)
 1 맥락 수집(브라우저가 각자 인가된 API로):
     hr → /api/hr/employee-records 등 HR API
     compensation·incentive → /api/compensation/roster(4필드) + /api/compensation?period=&include=hr (birthDate "")
 2 POST /api/assistant?module=<m>  {question, context}
 → worker CSRF
 → assistant route
    · m이 ASSISTANT_MODULES의 자기 키(Object.hasOwn)가 아니면 400 (프로토타입 키 차단)
    · authorizeErpRequest(db, ASSISTANT_MODULES[m], "read")   ← 본문(:36)보다 먼저. 403이면 본문을 읽지 않는다
    · request.text() ≤ 256KB(413), question ≤ 2000자
    · fetch http://127.0.0.1:3130/assistant (workerd outbound, Origin 없음, Host 127.0.0.1:3130)
 → bridge (scripts/claude-assistant-bridge.mjs)
    · Origin이 있거나 Host가 허용 목록 밖이면 403 (:150)
    · ALLOWED_MODULES 검사(R1: hr, compensation, incentive)
    · claude -p --tools "" --disallowed-tools … (cwd = 시작 때 만든 빈 임시 폴더, :62·:127)
      프롬프트 = 시작 때 메모리에 올린 buildPrompt + 요청의 context JSON. 요청 처리 중에는 저장소 파일을 열지 않는다
    · 응답 스키마 검증 → JSON
 → route: writeErpAudit ASSISTANT_ASKED{assistantModule, questionLength, 개수} (질문 본문·맥락 없음, :82-95)
 → 브라우저: proposedActions의 적용 버튼은 대상 탭이 edit일 때만 보인다. 적용은 일반 API(인가·감사)로 한다
```

### 2.3 Dependencies

| Component | Depends On | Purpose / 규칙 |
|-----------|-----------|----------------|
| `build/local-peer-vite-plugin.ts` | Vite Plugin API(`configureServer`, `configurePreviewServer`), `IncomingMessage.socket.remoteAddress`, `httpServer`의 `'upgrade'` | peer 기록과 경로 차단. 앱 코드를 import하지 않는다. `eslint.config.mjs:15`가 `build/**`를 lint에서 빼므로, 검증 수단은 `tests/local-peer-plugin.test.mjs`뿐이다 |
| `vite.config.ts` | `localPeerPlugin()`, `vinext()`, `sites()`, `cloudflare({ viteEnvironment, config, inspectorPort:false })` | 플러그인 순서를 고정한다(`:80-87`). `database_id`(`:7-8,58`)와 `bucket_name`(`:66`)은 바꾸지 않는다 |
| `worker/index.ts` | `vinext/server/app-router-entry`, `app/request-guard.ts`(`crossOriginWriteViolation`) | 핸들러보다 먼저 CSRF를 검사하고 헤더를 조립한다. `/_vinext/image` 분기(`:32-41`)도 같은 마무리 함수를 거친다(§7.7) |
| `app/erp-platform.ts` | `access-tabs`, `auth-session`, `request-guard`, `next/headers`(`headers()`만), `chat-schema`(R5), `opsSchemaStatements`(R4, 같은 파일) | 게이트 스키마, `authorizeErpRequest`, `writeErpAudit`. R3에서 `hr-company-data`·`chatgpt-auth` import(`:1-2`)를 지운다 |
| `app/auth-session.ts` | `access-tabs`(resolveTabs), WebCrypto(SHA-256, getRandomValues) | 세션, 예약, peer, principal. 순환을 막기 위해 **`erp-platform`을 import하지 않는다** |
| `app/auth-password.ts` | WebCrypto PBKDF2(workerd 상한 100,000) | 순수 해시·검증. 다른 앱 모듈에 의존하지 않는다 |
| `app/access-tabs.ts`, `app/request-guard.ts` | 없음(순수) | 클라이언트·서버·worker·테스트가 함께 쓴다 |
| `app/api/me`, `app/api/auth/*` | `erp-platform`(`platformSchemaReady`, `writeErpAudit`), `auth-session`, `auth-password`, `request-guard` | `authorizeErpRequest`는 부르지 않는다 |
| HR 라우트 18개(R3 기준, authorized-users 삭제·compensation 이동 후), `documents` | `erp-platform`, `hr-transitions`(R1), `access-tabs`(`isHrManager`), 서버 전용 `hr-company-data` | 라우트 로컬 `ensureSchema`에는 HR 테이블만 둔다 |
| `app/api/compensation/*` | `erp-platform`, `hr_employee_records`, `hr_payroll_*` | roster는 4필드. CONFIRM은 급여 테이블에 쓴다(의도된 동작) |
| `app/api/assistant`, `hr/resume-analysis` | env `CLAUDE_ASSISTANT_BRIDGE_URL`/`CLAUDE_BRIDGE_URL`(기본 127.0.0.1:3130/3120) | 서버 대 서버 fetch. 브리지 허용 목록은 넓히지 않는다(D23) |
| `app/api/hr/transcriptions` | Workers AI REST(`CLOUDFLARE_ACCOUNT_ID`·`CLOUDFLARE_API_TOKEN`·`CLOUDFLARE_TRANSCRIPTION_MODEL`) | 외부로 나가는 유일한 호출 |
| `app/api/chat/*`(R5) | `erp-platform`, `chat-server`, `chat-mentions`, R2 `HR_AUDIO`의 `chat/` 접두사 | 멤버 검사는 라우트에서 한다. 버킷을 따로 나누지 않는다 |
| `app/page.tsx`, `app/incentive/page.tsx` | `session-client`, `access-tabs`, `shell-top-nav`, `auth-screens`, `client-runtime`, 각 workspace | 클라이언트 전용. `hr-company-data`·`erp-platform`·`auth-*`·`chat-server`·`chat-schema`를 import하지 않는다 |
| `scripts/claude-assistant-bridge.mjs` | Claude CLI(서버 사용자 자격 증명, 2.1.280), `XD_NODE_PROJECT_PATH`(스키마와 `codex-assistant-bridge.mjs`의 `buildPrompt` 원본을 시작할 때 1회 읽음) | 운영에서는 운영 폴더를 가리킨다 |
| `scripts/verify-state-snapshot.mjs`, `reset-admin-password.mjs` | `node:sqlite`(Node ≥ 22.15), `scripts/lib/d1-state.mjs`. reset은 `node:crypto` `webcrypto`로 `auth-password`와 같은 형식을 쓴다 | 서버 정지 중에만 쓴다. verify는 `readOnly:true`이고, `--record-run` 말고는 운영 파일을 열지 않는다 |
| `scripts/xdm-login.mjs` | `/api/auth/login`, `XDM_EMAIL`·`XDM_PASSWORD` | 비GET 요청에 `Origin: <base>`를 붙인다 |
| `tests/helpers/hr-api-harness.mjs` | `node:module` `registerHooks`, `node:sqlite`, `typescript` transpile | 스텁: `cloudflare:workers`, `next/headers`(`headers()`만, `:57`), `next/navigation`, `server-only`(R1, `:47` 목록에 추가) |
| 운영 스크립트(R4) | 작업 스케줄러, `taskkill /T /F`, `robocopy /E`, `attrib +R`, `powercfg` | 기동 경로는 `Start-ScheduledTask` 하나 |

- 확인한 설치 버전: vite 8.0.13, @cloudflare/vite-plugin 1.37.1, vinext 1.0.0-beta.2, miniflare 4.20260515.0, workerd 1.20260515.1, wrangler 4.92.0, Node 24.19.0. `package.json` engines는 지금 `>=22.13.0`이고 R2에서 `>=22.15.0`으로 올린다.
- 이 문서의 `node_modules` 줄 번호는 이 버전 기준이다. 버전을 올리면 `local-peer-plugin` 테스트와 §7.6 R3 스모크를 다시 돌린다.

---

## 3. Data Model

공통 규칙
- 새 테이블과 인덱스는 모두 `CREATE TABLE/INDEX IF NOT EXISTS`로 만든다. 추가만 하고 DROP·RENAME·컬럼 삭제는 하지 않는다(D4).
- 불리언은 INTEGER 0/1로 bind한다(하니스 규칙). 시각은 epoch ms INTEGER다.
- 서버 id는 `acct_`·`ch_`·`att_` 같은 접두사에 `crypto.randomUUID()`를 붙여 만든다. 서버(workerd)는 보안 컨텍스트 제약이 없다. 클라이언트는 `randomId()`를 쓴다.
- FOREIGN KEY는 선언하지 않는다.
  - 기존 스키마와 같은 관례다.
  - 계정·채널·메시지는 행을 지우지 않고 상태만 바꾼다(비활성화, 보관, soft-delete).
  - 참조 무결성은 같은 `db.batch` 안의 조건부 문장(`INSERT … SELECT … WHERE EXISTS/NOT EXISTS`)과 라우트 검사로 지킨다.
- DDL 위치
  - 인증: `authSchemaStatements(db)`(`app/auth-session.ts`, R3)
  - 운영: `opsSchemaStatements(db)`(R4, `app/erp-platform.ts` 안. 새 파일을 두지 않는다)
  - 채팅: `chatSchemaStatements(db)`(`app/chat-schema.ts`, R5)
  - 세 함수는 `ensureErpPlatformSchema(db)`가 `auditStatements(db)`와 함께 한 batch로 실행한다: `db.batch([...auditStatements(db), ...authSchemaStatements(db) /*R3*/, ...opsSchemaStatements(db) /*R4*/, ...chatSchemaStatements(db) /*R5*/])`. 조건 없이, 멱등으로 실행한다.
  - 라우트의 `ensureSchema`에는 두지 않는다.
- 게이트 `platformSchemaReady(db)`
  - 모듈 수준에서 memo한 Promise다. 실패하면 null로 되돌려 다음 요청에서 다시 시도한다.
  - `authorizeErpRequest`, `writeErpAudit`, `/api/me`, `/api/auth/*`가 부른다.
  - 하니스는 `resetPlatformSchemaGate()`를 부른 뒤 `ensureErpPlatformSchema(db)`를 직접 부른다(§8.5). 메모만 두고 초기화 함수가 없으면 두 번째 `resetDatabase` 뒤 모든 테스트가 'no such table'로 깨진다(연구 자료 gap 3).
  - 채팅 poll의 hot path에는 DDL이 없다.

### 3.1 Entity Definition

DB 행 타입은 raw D1 결과를 그대로 받는 snake_case다(기존 `DocumentRow` 관례). API DTO는 camelCase다. 탭 레지스트리와 거기서 파생하는 타입(`TabKey`, `ErpModule`, `GrantableTabKey`, `ResolvedTabs`)의 정의는 §4.3.1에 있다.

```typescript
// ── app/access-tabs.ts (순수, import 없음) — 레지스트리 본문은 §4.3.1 ──────
export type TabLevel = "none" | "view" | "edit";
/** auth_accounts.tabs_json 저장 형태. 없는 키 = none. 모르는 키는 읽을 때 버리고, UPDATE_TABS는 보존한다(§3.3 auth_accounts 주석). */
export type StoredTabGrants = Partial<Record<GrantableTabKey, "view" | "edit">> & Record<string, unknown>;

// ── app/auth-session.ts ───────────────────────────────────────────────
export interface AuthAccountRow {
  id: string;                          // 'acct_<uuid>'
  email: string;                       // trim + lower-case, UNIQUE
  display_name: string;                // 연결 계정은 관리자가 인사기록 이름을 넣는다
  password_hash: string;               // 'pbkdf2_sha256$100000$<salt b64url>$<hash b64url>'
  employee_id: string | null;          // hr_employee_records.employee_id. NULL = 미연결(D14). 'acct_' 접두 금지
  is_admin: 0 | 1;
  active: 0 | 1;
  must_change_password: 0 | 1;
  failed_attempts: number;
  locked_until: number | null;
  tabs_json: string;                   // StoredTabGrants JSON
  password_changed_at: number | null;
  last_login_at: number | null;
  created_by: string;                  // 'bootstrap' | 'script:reset-admin-password' | 관리자 account id
  created_at: number;
  updated_at: number;
}
export type SessionRevokeReason = "LOGOUT" | "PASSWORD_CHANGED" | "PASSWORD_RESET" | "DEACTIVATED" | "ADMIN_REVOKE";
export interface AuthSessionRow {
  id: string;                          // hex(SHA-256(token)). 토큰 원문은 저장하지 않는다
  account_id: string;
  created_at: number;
  expires_at: number;                  // created_at + SESSION_TTL_MS(2_592_000_000), 고정
  last_seen_at: number;                // SESSION_TOUCH_INTERVAL_MS(1시간)에 한 번만 갱신
  revoked_at: number | null;
  revoked_reason: SessionRevokeReason | "";
  peer: string;                        // Node가 확인한 주소(x-xdm-peer)
  user_agent: string;                  // 200자에서 자름
}
export type PeerInfo = { address: string; loopback: boolean };        // peerOf(headers). 헤더 없음·',' 포함이면 {"",false}
export type ResolvedSession = { sessionId: string; account: AuthAccountRow };

// ── app/erp-platform.ts (R3) ──────────────────────────────────────────
export type ErpPrincipal = {
  userId: string;          // = accountId
  accountId: string;
  email: string;
  displayName: string;
  employeeId: string;      // 연결된 HR id, 없으면 accountId('acct_…')
  employeeName: string;    // = displayName
  linkedEmployee: boolean;
  isAdmin: boolean;
  tabs: ResolvedTabs;
};                         // roles는 없앤다. 이 저장소에는 타입 검사 단계가 없으므로(빌드·하니스 모두 transpile만) 남은 사용처는 명시적으로 고친다:
                           // analytics:19, performance:39, training:23(isHrManager), operations:247(access),
                           // hr-workspace.tsx:944,959,1816과 hr-dashboard-model.ts:356(roles 입력 삭제).
                           // removal-guards(R3)가 app/에서 `principal.roles`·`.roles.includes(` 0건을 단언한다
export type AuditActor = Pick<ErpPrincipal, "userId" | "email" | "employeeId">; // writeErpAudit의 principal. 인증 전 이벤트는 'anonymous'
// writeErpAudit의 module 인자 타입: ErpModule | "auth"

// ── 운영 (R4) ─────────────────────────────────────────────────────────
export interface OpsBackupRunRow {
  id: string;                          // 'yyyy-MM-dd' | 'yyyy-MM-ddTHHmm'
  started_at: number; finished_at: number;
  status: "OK" | "FAILED";
  backup_dir: string; integrity: string; // PRAGMA integrity_check 결과('ok' 또는 첫 오류 줄)
  r2_object_count: number;
  row_counts_json: string;             // {"<table>": count}
  error: string;
}

// ── 채팅 (R5, app/chat-schema.ts · app/chat-server.ts) ──────────────────
export type ChatChannelKind = "public" | "private" | "dm" | "group_dm";
export interface ChatChannelRow {
  id: string; kind: ChatChannelKind; name: string; topic: string;
  dm_key: string | null;               // 정렬한 account id를 ','로 이음(DM·그룹 DM만)
  created_by: string; created_at: number; updated_at: number; archived_at: number | null;
}
export interface ChatMemberRow {
  channel_id: string; account_id: string; role: "owner" | "member";
  joined_at: number; left_at: number | null;
  last_read_message_id: number; last_read_at: number | null;
}
export interface ChatMessageRow {
  id: number;                          // AUTOINCREMENT, 읽음 위치 기준
  client_key: string;                  // '<accountId>:<clientKey>' UNIQUE, 재전송 중복 제거
  channel_id: string; thread_root_id: number | null; author_account_id: string;
  body: string;                        // soft-delete 뒤에도 DB에 남는다. DTO·검색에서는 뺀다
  mention_channel: 0 | 1; reply_count: number; last_reply_at: number | null;
  created_at: number; edited_at: number | null; deleted_at: number | null; deleted_by: string | null;
}
export type ChatEventKind = "message.created" | "message.edited" | "message.deleted"
  | "channel.updated" | "channel.archived" | "member.joined" | "member.left";
export interface ChatEventRow {
  seq: number;                         // poll 커서
  channel_id: string; kind: ChatEventKind;
  message_id: number | null; subject_account_id: string | null; created_at: number;
}
export interface ChatMentionRow { message_id: number; account_id: string; channel_id: string; created_at: number }
export interface ChatAttachmentRow {
  id: string;                          // 'att_<uuid>'
  channel_id: string; message_id: number | null; // NULL = 전송 전 업로드
  uploader_account_id: string; file_name: string;
  content_type: string;                // 서버가 확장자로 정한다
  size: number; storage_key: string;   // 'chat/<channelId>/<attachmentId>' (HR_AUDIO)
  created_at: number; deleted_at: number | null;
}
```

```typescript
// ── API DTO ───────────────────────────────────────────────────────────
export interface SessionUserDto { accountId: string; email: string; name: string; employeeId: string; linkedEmployee: boolean }
export interface MeResponse { user: SessionUserDto; isAdmin: boolean; tabs: ResolvedTabs; mustChangePassword: boolean }

export interface AdminAccountDto {
  id: string; email: string; displayName: string; employeeId: string | null;
  isAdmin: boolean; active: boolean; mustChangePassword: boolean;
  lockedUntil: number | null;          // 지금보다 뒤일 때만 값, 아니면 null
  failedAttempts: number;
  tabs: Record<GrantableTabKey, TabLevel>; // 저장된 부여값(resolveTabs(tabs_json,false)). 관리자는 화면에서 '모든 탭 편집'으로 표시
  lastLoginAt: number | null; createdAt: number;
  activeSessions: number;              // revoked_at IS NULL AND expires_at > now
}

export interface CompensationRosterEntry { employeeId: string; name: string; department: string; status: string } // 4필드만

export interface ChatAttachmentDto { id: string; fileName: string; size: number; contentType: string; isImage: boolean; url: string } // url = /api/chat/attachments?id=
export interface ChatMessageDto {
  id: number; channelId: string; threadRootId: number | null;
  author: { accountId: string; name: string };
  body: string | null;                 // 삭제되면 null
  mentions: string[];                  // 멘션된 accountId
  mentionChannel: boolean;
  attachments: ChatAttachmentDto[];    // 삭제되면 []
  replyCount: number; lastReplyAt: number | null;
  createdAt: number; editedAt: number | null; deleted: boolean;
}
export interface ChatChannelDto {
  id: string; kind: ChatChannelKind; name: string; topic: string; memberCount: number;
  dmMemberIds?: string[];              // dm·group_dm만. 이름 표시용
  unread: number; mentions: number;
  lastMessage: { id: number; authorName: string; preview: string | null; createdAt: number } | null; // preview ≤ 80자, 삭제면 null
  myRole: "owner" | "member"; archived: boolean;
}
export interface UnreadSummary { total: number; mentions: number; channels: Array<{ channelId: string; unread: number; mentions: number; lastMessageId: number }> }
export interface ChatPollEvent { seq: number; kind: ChatEventKind; channelId: string; message?: ChatMessageDto; subjectAccountId?: string }
export interface ChatPollResponse { cursor: number; hasMore: boolean; resync?: true; events: ChatPollEvent[]; unread: UnreadSummary | null }
```

### 3.2 Entity Relationships

```
hr_employee_records (기존, PK employee_id)
      │ 0..1
      │   (auth_accounts.employee_id, 부분 UNIQUE. 연결 안 하면 principal.employeeId = 'acct_…')
      │ 0..1
auth_accounts ──1:N── auth_sessions            (활성 = revoked_at IS NULL AND expires_at > now AND account.active = 1)
      │
      ├──1:N── erp_audit_logs (기존)         actor_user_id = account id | 'anonymous' | 'SYSTEM'  (FK 없음)
      │
      ├──N:M── chat_channels   via chat_members (PK channel_id+account_id, 읽음 위치 포함, left_at = 탈퇴)
      │             │
      │             ├──1:N── chat_messages ──1:N── chat_messages   (thread_root_id, 1단계만)
      │             │             ├──1:N── chat_mentions ──N:1── auth_accounts
      │             │             └──0..1:N── chat_attachments ──1:1── R2 object (HR_AUDIO, storage_key)
      │             └──1:N── chat_events  (seq = poll 커서, subject_account_id = member.* 대상)
      │
      └── (연결 없음) ops_backup_runs   백업 스크립트가 서버 정지 중에 직접 쓴다
```

- 계정과 인사기록은 선택적 1:1이다(D14).
  - `idx_auth_accounts_employee`가 직원 한 명에 계정 1개를 보장한다.
  - `hr_employee_records.employee_id`에는 `acct_` 접두가 들어갈 수 없다. 사용자가 고른 id로 이 행을 만드는 모든 경로가 400으로 막는다: `PUT /api/hr/employee-records`, `PUT /api/hr/recruitment`의 입사 전환(`:303`, INSERT `:457`)과 오퍼 수정(`:392`). 그래서 미연결 계정의 `acct_…` id가 HR 행과 겹치지 않는다. 나머지 INSERT 경로(`hr-employee-roster.ts:28`, `hr/operations:327`)는 정적 명부 id만 쓴다.
  - self/manager 판정도 연결된 id로만 한다(`principal.linkedEmployee === true`일 때만, §10.4-8).
- 세션은 계정당 N개다.
  - 로그인할 때마다 새로 만들고, 다른 세션은 유지한다.
  - 폐기는 `revoked_at`·`revoked_reason`으로 표시하고, 행은 지우지 않는다.
- 감사 행의 actor와 계정은 FK 없는 논리 관계다. 감사 뷰어는 `LEFT JOIN auth_accounts ac ON ac.id = a.actor_user_id`로 이름을 붙이고 `COALESCE(e.name, ac.display_name)`로 고른다.
- 채팅
  - `chat_members`는 멤버십과 읽음 위치를 함께 담는다. 탈퇴(`left_at`)해도 행은 남는다. 다시 참여하면 `left_at = NULL`로 되돌린다.
  - 메시지 id는 전역 AUTOINCREMENT다. 채널 안에서도 단조 증가하므로 `last_read_message_id` 비교에 쓸 수 있다.
  - 첨부는 먼저 `message_id = NULL`로 올리고, 전송 batch가 메시지에 묶는다(§4.2.8). 전송 전 첨부는 올린 사람만 보고 지울 수 있다.
  - `chat_events`는 추가 전용 로그다. 읽음 위치 변경(read-state)은 기록하지 않는다(§3.3 주석).

### 3.3 Database Schema

`ensureErpPlatformSchema(db)`의 batch 순서는 `auditStatements` → `authSchemaStatements` → `opsSchemaStatements` → `chatSchemaStatements`다. 모든 문장은 멱등이다.

#### 권한 부여(grants) 저장: `auth_accounts.tabs_json` (별도 테이블 없음)
- 형태: `{"hr":"view"|"edit","compensation":"view"|"edit","chat":"view"|"edit"}`. 키가 없으면 `none`이다. 부여할 수 있는 키는 레지스트리에서 `adminOnly:false`인 탭뿐이다.
- 읽을 때 `resolveTabs`는 모르는 키와 adminOnly 키를 버린다. 관리자는 모든 탭이 `edit`이고, 비관리자는 `audit`·`admin`이 항상 `none`이다.
- `UPDATE_TABS`는 기존 JSON의 모르는 키를 보존한 채 병합한다(R5를 되돌렸다가 다시 올릴 때 chat 부여를 잃지 않게).
- 탭 목록 CHECK 제약은 두지 않는다. 새 탭을 추가할 때 스키마를 바꾸지 않기 위해서다(FR-16).

```sql
-- ═════ R3 · authSchemaStatements(db) · app/auth-session.ts ═════
CREATE TABLE IF NOT EXISTS auth_accounts (
  id TEXT PRIMARY KEY NOT NULL,                 -- 'acct_<uuid>'
  email TEXT NOT NULL UNIQUE,                   -- trim + lower-case. 조회는 항상 정규화한 값으로 WHERE email = ?
  display_name TEXT NOT NULL,                   -- 연결 시 관리자가 인사기록 이름을 넣는다(1~60자)
  password_hash TEXT NOT NULL,                  -- 'pbkdf2_sha256$100000$<salt>$<hash>'. iter는 1..100000 밖이면 검증 false
  employee_id TEXT,                             -- hr_employee_records.employee_id, NULL = 미연결(D14). 'acct_' 접두는 금지(앱 검사)
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),  -- 발급·초기화 계정은 1, 부트스트랩은 0
  failed_attempts INTEGER NOT NULL DEFAULT 0,   -- 검증 전 원자적 예약으로 올린다(§4.2.2)
  locked_until INTEGER,                         -- 잠금 해제 시각. NULL 또는 과거 = 잠기지 않음
  tabs_json TEXT NOT NULL DEFAULT '{}',         -- {"hr":"view"|"edit","compensation":…,"chat":…}. 없는 키 = none.
                                                -- 탭 목록 CHECK는 두지 않는다(FR-16: 탭을 더해도 스키마 불변).
                                                -- UPDATE_TABS는 모르는 키를 보존한다(R5를 되돌렸다 다시 올려도 chat 부여 유지)
  password_changed_at INTEGER,
  last_login_at INTEGER,
  created_by TEXT NOT NULL,                     -- 'bootstrap' | 'script:reset-admin-password' | 관리자 account id
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_accounts_employee ON auth_accounts(employee_id) WHERE employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY NOT NULL,                 -- hex(SHA-256(token)). 토큰 원문(32바이트 base64url, 43자)은 쿠키에만 있다
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,                  -- created_at + 2_592_000_000(30일 고정, 슬라이딩 없음)
  last_seen_at INTEGER NOT NULL,                -- 1시간에 한 번만 갱신(UPDATE … WHERE last_seen_at < :now - 3600000)
  revoked_at INTEGER,
  revoked_reason TEXT NOT NULL DEFAULT '',      -- LOGOUT|PASSWORD_CHANGED|PASSWORD_RESET|DEACTIVATED|ADMIN_REVOKE
  peer TEXT NOT NULL DEFAULT '',                -- Node가 확인한 주소
  user_agent TEXT NOT NULL DEFAULT ''           -- 200자에서 자름
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_account ON auth_sessions(account_id, revoked_at);   -- 계정별 폐기·활성 세션 수
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);              -- 만료 행 정리(후속)

-- 요청마다 1회 실행하는 세션 확인. HR 테이블은 읽지 않고 캐시도 두지 않는다(Plan M4)
-- SELECT s.id AS session_id, s.last_seen_at, a.* FROM auth_sessions s JOIN auth_accounts a ON a.id = s.account_id
--  WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND a.active = 1

-- ═════ R4 · opsSchemaStatements(db) · app/erp-platform.ts ═════
--  scripts/verify-state-snapshot.mjs(--record-run)에도 같은 DDL 문자열을 두고, 서버가 정지된 동안 운영 D1 파일에 직접 한 행을 쓴다.
--  성공과 실패를 모두 기록한다. 두 문자열이 같은지는 lan-exposure-guards(R4)가 단언한다
CREATE TABLE IF NOT EXISTS ops_backup_runs (
  id TEXT PRIMARY KEY NOT NULL,                 -- 'yyyy-MM-dd'(같은 날 재실행이면 'yyyy-MM-ddTHHmm')
  started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OK','FAILED')),   -- OK = 복사 완료 + integrity ok + 보고서 기록
  backup_dir TEXT NOT NULL,                     -- C:\xdm\backup\yyyy-MM-dd\ (120자 이하)
  integrity TEXT NOT NULL DEFAULT '',           -- 사본의 PRAGMA integrity_check 결과
  r2_object_count INTEGER NOT NULL DEFAULT 0,
  row_counts_json TEXT NOT NULL DEFAULT '{}',   -- 테이블별 행 수
  error TEXT NOT NULL DEFAULT ''                -- 실패 사유(비밀값·경로 밖 정보 없음)
);
CREATE INDEX IF NOT EXISTS idx_ops_backup_runs_finished ON ops_backup_runs(finished_at);        -- 마지막 성공·마지막 실행 조회

-- ═════ R5 · chatSchemaStatements(db) · app/chat-schema.ts ═════
CREATE TABLE IF NOT EXISTS chat_channels (
  id TEXT PRIMARY KEY NOT NULL,                 -- 'ch_<uuid>', 시드 'ch_general'
  kind TEXT NOT NULL CHECK (kind IN ('public','private','dm','group_dm')),
  name TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL DEFAULT '',   -- DM·그룹 DM은 name ''(화면이 dmMemberIds로 이름을 만든다)
  dm_key TEXT,                                  -- 정렬한 account id를 ','로 이음(DM·그룹 DM만). 같은 참여자 조합은 채널 1개
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  archived_at INTEGER                           -- 보관 = 읽기 전용(관리자만)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channels_dm_key ON chat_channels(dm_key) WHERE dm_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channels_name ON chat_channels(name) WHERE kind IN ('public','private') AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS chat_members (                -- 읽음 위치도 여기에 둔다(별도 테이블 없음)
  channel_id TEXT NOT NULL, account_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),   -- 채널 생성자 = owner. DM은 모두 member
  joined_at INTEGER NOT NULL, left_at INTEGER,  -- left_at IS NULL = 현재 멤버
  last_read_message_id INTEGER NOT NULL DEFAULT 0, last_read_at INTEGER,     -- MAX()로만 전진
  PRIMARY KEY (channel_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_account ON chat_members(account_id, left_at);         -- 내 채널 목록, poll 멤버 필터

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,         -- 읽음 위치 기준
  client_key TEXT NOT NULL UNIQUE,              -- '<accountId>:<clientKey>'. 클라이언트 randomId()가 없으면 서버가 만든다. 재전송 중복 제거
  channel_id TEXT NOT NULL,
  thread_root_id INTEGER,                       -- NULL = 최상위. 답글의 답글은 라우트가 400으로 막는다
  author_account_id TEXT NOT NULL,
  body TEXT NOT NULL,                           -- ≤ 4000자(CHAT_MESSAGE_MAX_LENGTH). soft-delete 뒤에도 남기지만 DTO는 null
  mention_channel INTEGER NOT NULL DEFAULT 0 CHECK (mention_channel IN (0,1)),   -- @channel·@채널
  reply_count INTEGER NOT NULL DEFAULT 0, last_reply_at INTEGER,                  -- 최상위 메시지만 갱신
  created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER, deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, thread_root_id, id);  -- 기록·안 읽은 수
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_root_id, id);               -- 스레드

CREATE TABLE IF NOT EXISTS chat_events (                 -- 이벤트 로그. seq가 poll 커서다. 추가만 한다
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message.created','message.edited','message.deleted','channel.updated','channel.archived','member.joined','member.left')),
  message_id INTEGER, subject_account_id TEXT,  -- member.* 이벤트의 대상 계정. 제거된 사람도 subject 규칙으로 자기 탈퇴를 받는다
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_events_channel_seq ON chat_events(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_chat_events_subject ON chat_events(subject_account_id, seq) WHERE subject_account_id IS NOT NULL;
-- 읽음 위치 PUT은 chat_events에 쓰지 않는다. 남의 읽음 표시가 내 poll 증분으로 오지 않게 하기 위해서다

CREATE TABLE IF NOT EXISTS chat_mentions (
  message_id INTEGER NOT NULL, account_id TEXT NOT NULL, channel_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, account_id)          -- 수정(PATCH) 때 해당 message_id 행을 지우고 다시 넣는다
);
CREATE INDEX IF NOT EXISTS idx_chat_mentions_account ON chat_mentions(account_id, message_id);

CREATE TABLE IF NOT EXISTS chat_attachments (
  id TEXT PRIMARY KEY NOT NULL,                 -- 'att_<uuid>'
  channel_id TEXT NOT NULL,
  message_id INTEGER,                           -- NULL = 전송 전. 전송 batch가 uploader·channel·NULL 조건으로 묶는다
  uploader_account_id TEXT NOT NULL,
  file_name TEXT NOT NULL,                      -- 경로 구분자를 뺀 원래 이름(≤ 200자). 감사에는 남기지 않는다
  content_type TEXT NOT NULL,                   -- 서버가 확장자로 정한다(클라이언트 Content-Type 무시)
  size INTEGER NOT NULL,                        -- 실제 바이트 수(≤ 26_214_400)
  storage_key TEXT NOT NULL UNIQUE,             -- 'chat/<channelId>/<attachmentId>' (HR_AUDIO 버킷, 백업 단위 1개)
  created_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_uploader ON chat_attachments(uploader_account_id, message_id);

-- 시드: 공개 채널 '일반'. 멤버는 없고 각자 JOIN하거나 첫 전송 때 자동 참여한다
INSERT OR IGNORE INTO chat_channels (id, kind, name, topic, dm_key, created_by, created_at, updated_at, archived_at)
VALUES ('ch_general', 'public', '일반', '', NULL, 'system', :now, :now, NULL);
```

- 메시지 삭제는 soft-delete다. body는 DB에 남기지만 DTO에서는 `body:null`로 내리고, 검색에서도 뺀다.

### 3.4 기존 테이블: 유지, 생성 중단, DROP 없음(D4)

**유지하고 스키마를 바꾸지 않는 테이블**
- `erp_audit_logs`(`app/erp-platform.ts:51-70`, 인덱스 3개)
  - 컬럼은 그대로다. 들어가는 값만 바뀐다.
  - `actor_user_id`: account id. 인증 전 이벤트는 `'anonymous'`, 기존 SYSTEM 작성자는 `'SYSTEM'`이다(`app/hr-retirements.ts:84`, `app/hr-onboarding.ts:34`, `app/hr-personnel-actions.ts:37`).
  - `actor_employee_id`: 연결된 id가 있으면 그 값, 없으면 `acct_…`, 익명이면 `'anonymous'`다.
  - `module`: `hr|recruitment|compensation|chat|audit|admin|auth`. 과거 값 `operations|finance|sales|settings`는 조회에만 쓴다.
- `erp_documents`(`app/api/documents/route.ts:27-33`)는 그대로다. module이 `hr`·`recruitment`가 아닌 기존 행은 남지만, R1부터는 관리자에게도 404다.
- `hr_*` 전부, `employee_interview_records`, `applicant_interview_recordings`는 그대로다.
  - HR 테이블에는 결재 id 컬럼이 없다. 그래서 즉시 반영으로 전환(R1)해도 데이터 마이그레이션이 필요 없다.
  - 레거시 대기 상태 행(SUBMITTED, PENDING, FINALIZATION_SUBMITTED)은 from-state로 받는다.
- 삭제 대상 코드도 만들던 공용 테이블 3개는 유지 라우트가 계속 만든다. 삭제 대상 가운데 `app/api/finance/operations/route.ts`와 `app/api/data-intake/route.ts`에도 이 세 테이블의 CREATE가 있다.
  - `hr_payroll_records`: `app/api/hr/payroll`(`:67`), `app/api/hr/compensation`(`:48`)
  - `hr_payroll_runs`: 이 둘(`payroll:97`, `compensation:56`) + `app/api/hr/operations`(`:21`)
  - `erp_documents`: `app/api/documents`

**생성을 멈추는 테이블.** 테이블 수는 코드 스캔 기준이다. 라우트·라이브러리별 정확한 목록은 부록 A.6에 둔다.

| 릴리스 | 어디서 멈추나 | 대상 |
|---|---|---|
| R1 | `ensureErpPlatformSchema` | `erp_tasks`, `erp_approval_requests`, `erp_approval_policies`, `erp_approval_policy_steps`, `erp_approval_delegations`, `erp_approval_steps`, `erp_approval_events`, `erp_sync_runs`와 그 인덱스(`:71-166`), `erp_approval_steps`의 PRAGMA/ALTER(`:175-178`) |
| R1 | `app/api/hr/payroll` ensureSchema | `finance_expense_requests`의 CREATE(`:103-114`)와 ALTER(`:124-128`) |
| R1 | 삭제되는 라우트 44개와 라이브러리의 DDL | finance_* 64개(`inventory_*` 3개 별도), sales_* 35개(`sales_incentive_payroll_links` 포함), erp_* 20개(data-governance·data-intake·data-integration·master-impact·workbench: `erp_audit_exports`, `erp_data_import_*`, `erp_integration_*`, `erp_logical_snapshots`, `erp_master_impact_*`, `erp_recovery_rehearsals`, `erp_retention_policies`, `erp_sync_run_events`, `erp_workbench_preferences` 등) |
| R3 | `ensureErpPlatformSchema` | `hr_authorized_users`(`:39-42`), `erp_user_access`(`:43-50`), gc.kim 시드(`:168-173`). 기존 행은 새 계정 체계로 옮기지 않는다(Plan M4) |

- DROP은 하지 않는다. 생성을 멈춘 테이블과 행은 D1 파일과 백업에 그대로 남는다(SC-8).
- 남는 코드에서 이 테이블을 읽거나 쓰는 곳은 R1에서 모두 없앤다. 그래서 새 DB(테이블 없음)와 기존 DB(테이블 있음) 모두에서 동작이 같다(FR-03).
  - 직접 SQL 5곳: `hr/leave:222-224`, `hr/operations:546-548,554`, `hr/payroll:413-416`, `hr/recruitment-requisitions:321-340`
  - 급여 재무 연결 3곳
  - `compensation`의 `sales_incentive_payroll_links` 합산(`:311-339`)
- `drizzle/*.sql`은 과거 기록으로 남긴다. `removal-guards`는 "앱 코드에 CREATE 0건"과 "drizzle SQL은 존재"를 함께 단언한다.
- 과거 데이터에 기대던 판정 두 개는 테이블을 읽지 않는 정적 목록으로 옮긴다(§12.3). 둘 다 M1-0과 R1 직전 재조회 결과로 채우고, 기본값은 `[]`다.
  - `LEGACY_SALES_INCENTIVE_PERIODS`(`app/api/compensation/route.ts`): `SELECT payroll_period, COUNT(*), SUM(applied_amount) FROM sales_incentive_payroll_links GROUP BY payroll_period`의 결과다. 이 테이블에는 status 컬럼이 없다(`app/api/sales/incentives/route.ts:46-48`).
  - `LEGACY_FINANCE_LOCKED_PAYROLL_PERIODS`(`app/api/hr/payroll/route.ts`): `payroll:%` 재무 행 가운데 지급·전기된 월이다.

---

## 4. API Specification

### 4.1 Endpoint List

수준 표기
- `view`: 읽기
- `edit`: 쓰기. 상태 변경도 포함한다(D13).
- `admin`: `isAdmin`
- 세션: 로그인만 요구하고 탭은 검사하지 않는다.

모든 비GET `/api/*` 요청은 worker가 교차 출처부터 검사한다(§6.1 `CROSS_ORIGIN`).

| Method | Path | 탭 | 수준 | 목적 | 릴리스 |
|---|---|---|---|---|---|
| **인증** ||||||
| GET | /api/me | — | 세션(비로그인 401) | 신원·탭·비밀번호 변경 필요 여부 | R3 |
| POST | /api/auth/login | — | 없음(same-origin) | 로그인. 잠금은 D15+D21 | R3 |
| POST | /api/auth/logout | — | 세션(없어도 200) | 현재 세션 폐기, 쿠키 삭제 | R3 |
| PUT | /api/auth/password | — | 세션(mustChange 중에도 허용) | 비밀번호 변경. 다른 세션 폐기 | R3 |
| POST | /api/auth/bootstrap | — | 계정 0개 + 루프백 peer | 첫 관리자 + 세션 | R3 |
| **관리** ||||||
| GET·POST | /api/admin/accounts | admin | admin | 계정 목록·관리 8 action | R3 |
| GET | /api/admin/backups | admin | admin | 마지막 백업 상태, `stale` | R4 |
| GET | /api/audit-log | audit | admin | 감사 조회(`auth_accounts` 조인) | 유지 |
| **HR** (`/api/hr/*`, `/api/documents`) ||||||
| GET / POST | /api/hr/analytics | hr | view / edit | 분석, 리포트 스냅샷. 민감 지표는 `isHrManager` | 유지 |
| GET / POST | /api/hr/applicant-interview-recordings | hr | view / edit | 지원자 면접 녹음(R2) | 유지 |
| GET / POST·DELETE | /api/hr/catalogs | hr | view / edit | 조직·직급·직책 카탈로그 | 유지 |
| GET / PUT | /api/hr/employee-records | hr | view / edit | 인사기록(PII). PUT은 `acct_*` id 400 | 유지 |
| GET / POST | /api/hr/interviews | hr | view / edit | 직원 면담 | 유지 |
| GET / POST·DELETE | /api/hr/leave | hr | view / edit | 연차 원장. DELETE의 결재 SQL은 R1에서 삭제 | 유지 |
| GET / PUT·DELETE | /api/hr/message-templates | hr | view / edit | 메시지 템플릿 | 유지 |
| GET | /api/hr/operations | hr | view | 인사발령·퇴직·휴가·근태·입사 과제. `access:{hr,isAdmin}`, `accountNames` | 유지(+R3) |
| POST | /api/hr/operations | hr | edit | `resource ∈ personnelAction(즉시 APPROVED), retirement(즉시 IN_PROGRESS), leaveRequest(즉시 APPROVED), attendance` | 유지(+R1) |
| PUT | /api/hr/operations | hr | edit | `resource ∈ leaveRequest(결정, 레거시 PENDING), attendance, lifecycleTask, retirementSettlement, retirementChecklist, severanceToPayroll`, 신규 `personnelActionDecision`·`retirementDecision`(레거시 SUBMITTED, `{id,decision:'APPROVED'\|'REJECTED',reason}`) | 유지(+R1) |
| GET / PUT | /api/hr/organization-leaders | hr | view / edit | 조직장 | 유지 |
| GET / POST·PUT | /api/hr/organizations | hr | view / edit | 조직(마스터 영향 제거) | 유지 |
| GET / POST / PUT | /api/hr/payroll | hr | view / edit / edit | 급여관리(D12). PUT으로 REVIEW→APPROVED→LOCKED, 재오픈 | 유지 |
| GET / POST | /api/hr/performance | hr | view / edit | 성과. `SUBMIT_FINALIZATION` 즉시 FINALIZED | 유지 |
| GET / PUT / POST / DELETE | /api/hr/recruitment | hr | view / edit ×3 | 채용·오퍼·입사 전환·담당자 지정. PUT의 입사 전환·오퍼 수정은 `acct_*` id 400 | 유지 |
| GET / POST | /api/hr/recruitment-requisitions | hr | view / edit | 채용요청. `CREATE_DRAFT`(인원 검사를 통과하면 OPEN), `SUBMIT`→OPEN, `CLOSE`, `CANCEL`, `DELETE` | 유지 |
| POST | /api/hr/resume-analysis | hr | edit | 이력서 분석(브리지 3120) | 유지 |
| GET / POST | /api/hr/training | hr | view / edit | 교육 | 유지 |
| GET / POST | /api/hr/transcriptions | hr | view / edit | 녹음 전사(Workers AI) | 유지 |
| GET / POST | /api/hr/workforce-plans | hr | view / edit | 인력계획. `SUBMIT_PLAN` 즉시 APPROVED, 이전 계획은 SUPERSEDED | 유지 |
| GET / POST·PATCH·DELETE | /api/documents | hr | view / edit | `?downloadId=` 다운로드, `?module&entityType&entityId` 목록 / 업로드(25MB)·분류 변경·soft-delete. module은 hr·recruitment만. 레거시 행은 관리자도 404 | 유지 |
| **임금 계산** ||||||
| GET / POST | /api/compensation | compensation | view / edit | 임금 계산 run(← `/api/hr/compensation`). CONFIRM은 `hr_payroll_records`·`hr_payroll_runs`에 쓴다(의도). 정적 목록에 있는 달의 재확정은 409 | R3 이동 |
| GET | /api/compensation/roster | compensation | view | 최소 명부 4필드. 부수효과 없음 | R3 |
| POST | /api/assistant?module=hr\|compensation\|incentive | hr / compensation | view | 서버가 브리지 3130을 대신 부른다(D10·D17·D23). 인가 뒤 본문(≤256KB)을 읽는다 | 유지 |
| **메신저** ||||||
| GET | /api/chat/channels | chat | view | 내 채널·참여 가능 채널·사람 목록 | R5 |
| POST | /api/chat/channels | chat | view / edit | view: `JOIN`·`LEAVE`(public만). edit: `CREATE_CHANNEL`, `OPEN_DM`, `ADD_MEMBERS`, `REMOVE_MEMBER`, `RENAME` | R5 |
| DELETE | /api/chat/channels?id= | chat | admin | 채널 보관(`archived_at`). 보관 뒤에는 읽기 전용 | R5 |
| GET | /api/chat/messages | chat | view | 기록·스레드·검색 | R5 |
| POST / PATCH / DELETE | /api/chat/messages | chat | edit(+작성자) | 전송 / 수정 / soft-delete | R5 |
| GET | /api/chat/poll | chat | view | since 커서 증분 | R5 |
| PUT / GET / DELETE | /api/chat/attachments | chat | edit+멤버 / view+멤버 / edit+업로더(미전송분만) | raw 업로드 / 다운로드 / 전송 전 취소 | R5 |
| PUT | /api/chat/read-state | chat | view | 읽음 위치(감사 제외) | R5 |

- 없어져서 404가 되는 경로
  - R1: `/api/finance/*`, `/api/sales/*`, `/api/approvals`, `/api/approval-settings`, `/api/data-intake`, `/api/data-governance`, `/api/data-integration`, `/api/master-impact`, `/api/master-impact-cases`, `/api/operations`, `/api/workbench`
  - R3: `/api/hr/authorized-users`, `/api/hr/compensation`
- 페이지는 `/`(SPA 셸)와 `/incentive`(`RequireTab tab="compensation"`, D1)만 남는다. SSR은 둘 다 `AuthLoadingShell`만 그린다.
- 새 라우트는 모두 정적 세그먼트이고, 대상은 `?id=` 쿼리로 받는다. 하니스 `callApi`가 params를 넘기지 않기 때문이다(`tests/helpers/hr-api-harness.mjs:98-105`).

### 4.2 Detailed Specification

#### 4.2.0 공통

- 요청
  - 새 라우트의 쓰기 요청은 `Content-Type: application/json` 본문을 쓴다. 예외는 첨부 PUT(raw body)이다.
  - JSON을 파싱하지 못하면 400 `VALIDATION` "요청 내용을 읽을 수 없습니다."다.
- 교차 출처 검사
  - worker가 `/api/*` 비GET 요청의 Origin/`Sec-Fetch-Site`를 핸들러와 본문 읽기보다 먼저 검사한다. 위치는 `worker/index.ts`의 `/_vinext/image` 분기(`:32`)와 핸들러 호출(`:43`) 앞이다(§7.7).
  - 가드와 인증 라우트는 메서드와 무관한 `crossSiteViolation(h)`로 한 번 더 검사한다(§7.3).
- 처리 순서
  - `authorizeErpRequest`를 쓰는 라우트는 **리터럴 모듈로 먼저 인가하고, 그다음 본문을 읽는다**.
  - `authorizeErpRequest`의 순서는 §4.3.1에 있다.
  - `me`·`auth/*`는 `platformSchemaReady`와 `crossSiteViolation`을 직접 부른다.
- 응답
  - JSON이다. 시각은 epoch ms 숫자다.
  - `/api/*`에 `Cache-Control`이 없으면 worker가 `no-store`를 넣는다.
  - 모든 응답에 `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`이 붙는다.
  - 오류는 §6 형식이다.
- 감사
  - 인증·관리 이벤트의 `after`에는 항상 `peer`(Node가 찍은 주소)를 넣는다.
  - 비밀번호, 토큰, 쿠키, `temporaryPassword`는 넣지 않는다. `temporaryPasswordIssued: true`만 남긴다.
  - 감사 action 이름 전체 목록은 §12.2(HR)와 §7(인증)에서 쓰는 이름을 §4.2.9에 모았다.

#### 4.2.1 `GET /api/me`

처리
1. `platformSchemaReady`
2. `crossSiteViolation`(403)
3. `resolveSession(db, h.get("cookie"))`. 쿠키 값이 `^[A-Za-z0-9_-]{43}$`가 아니면 세션 없음으로 본다.
4. 세션이 없으면 `SELECT EXISTS(SELECT 1 FROM auth_accounts)`를 본다. 0이면 `BOOTSTRAP_REQUIRED`, 아니면 `UNAUTHENTICATED`다.
5. `last_seen_at`은 1시간에 1회만 갱신한다.

```json
200 { "user": { "accountId": "acct_…", "email": "…", "name": "…", "employeeId": "gc.kim|acct_…", "linkedEmployee": true },
      "isAdmin": false, "tabs": { "hr": "edit", "compensation": "view", "audit": "none", "admin": "none" },
      "mustChangePassword": false }
401 { "error": "로그인이 필요합니다.", "code": "UNAUTHENTICATED" }
401 { "error": "첫 관리자 계정을 먼저 만들어 주세요.", "code": "BOOTSTRAP_REQUIRED", "bootstrapAllowedHere": true }
```
- `mustChangePassword`가 참이어도 200이다. 비활성·만료·폐기 세션은 401 `UNAUTHENTICATED`다.
- `bootstrapAllowedHere`는 `peerOf(h).loopback`이다. 헤더는 `Cache-Control: no-store`다.
- 클라이언트(`useSession`)는 `ME_REFRESH_INTERVAL_MS = 60_000`마다, 그리고 focus·visibilitychange 때 다시 부른다.
- R4 헬스체크는 이 경로의 401을 정상으로 본다.

#### 4.2.2 `POST /api/auth/login`

요청: `{ "email": "a@b", "password": "…" }`
- email은 trim + lower-case로 정규화한다.
- password는 문자열 1~200자다. 벗어나면 400 `VALIDATION`이다.

처리
1. 게이트, `crossSiteViolation`, JSON 파싱
2. `SELECT … FROM auth_accounts WHERE email = ?`
3. 계정이 없거나 `active = 0`이면
   - `verifyPassword(password, getDummyHash())`로 걸리는 시간을 맞추고 401 `INVALID_CREDENTIALS`를 돌려준다.
   - 카운터는 건드리지 않는다.
   - 감사 `LOGIN_FAILED{email, reason:"UNKNOWN_OR_INACTIVE", peer}`를 남긴다(actor `anonymous`, `actor_email`은 시도한 이메일 소문자 200자).
4. 시도 예약(D15·D21). 판정 기준은 `peer = peerOf(h)`다.
   - LAN이면 아래 UPDATE를 먼저 실행한다. `RETURNING`이 행을 돌려주는 경우가 `changes === 1`과 같다.
     - 행이 없으면 검증하지 않고 429 `LOCKED`를 돌려준다. `locked_until`을 다시 읽어 `Retry-After`와 `retryAfterSeconds`를 채운다.
     - 감사 `LOGIN_BLOCKED{peer}`를 남긴다.
   ```sql
   UPDATE auth_accounts SET
     failed_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= :now THEN 1 ELSE failed_attempts + 1 END,
     locked_until = CASE
       WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= :now THEN 1 ELSE failed_attempts + 1 END) >= 5 THEN :now + 300000
       WHEN locked_until IS NOT NULL AND locked_until <= :now THEN NULL
       ELSE locked_until END,
     updated_at = :now
   WHERE id = :id AND (locked_until IS NULL OR locked_until <= :now)
   RETURNING failed_attempts, locked_until
   ```
   - 루프백(D21)이면 같은 SET을 `WHERE id = :id`로만 실행한다. 실패 횟수는 세지만 잠금 검사는 하지 않고 항상 검증한다. 판정 근거는 Node가 찍은 `x-xdm-peer`뿐이다.
5. `verifyPassword(password, row.password_hash)`가 실패하면
   - 401 `INVALID_CREDENTIALS`를 돌려준다.
   - 감사 `LOGIN_FAILED{email, reason:"WRONG_PASSWORD", failedAttempts, peer, lockExempt?}`를 남긴다. `lockExempt`는 루프백일 때만 `true`다.
   - 예약 결과에서 `failed_attempts`가 정확히 5가 되어 `locked_until = :now + 300000`이 걸렸으면 이번 시도가 잠금을 건 것이다. 이때는 `ACCOUNT_LOCKED{peer, lockedUntil}`도 남긴다(한 번만).
6. 성공하면 한 batch로 실행한다.
   - `UPDATE auth_accounts SET failed_attempts=0, locked_until=NULL, last_login_at=:now, updated_at=:now WHERE id=:id`. 서버 PC에서 로그인에 성공하면 LAN에서 걸린 잠금도 이 문장으로 풀린다.
   - `INSERT INTO auth_sessions (id, account_id, created_at, expires_at, last_seen_at, revoked_at, revoked_reason, peer, user_agent) VALUES (:hash, :id, :now, :now + 2592000000, :now, NULL, '', :peer, :ua200)`
   - 감사 `LOGIN_SUCCEEDED{peer}`(actor = 그 계정)

```json
200 { "mustChangePassword": false, "user": { "accountId": "acct_…", "email": "…", "name": "…", "employeeId": "…", "linkedEmployee": true } }
Set-Cookie: xdm_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000
```
- 쿠키는 Response에 직접 싣는다. `cookies()`는 쓰지 않는다. http LAN이므로 `Secure`와 `__Host-`는 붙이지 않는다.
- 오류: 400 `VALIDATION`, 401 `INVALID_CREDENTIALS`, 403 `CROSS_ORIGIN`, 429 `LOCKED`(+`Retry-After`)
- 테스트 고정점
  - LAN peer에서 오답 20건을 `Promise.all`로 보내면 검증은 5회 이하다.
  - 잠금 중에는 정답도 429다.
  - 루프백 peer는 잠금 중에도 정답이면 200이고, `failed_attempts`는 오른다.

#### 4.2.3 `POST /api/auth/logout`

- 세션 쿠키가 유효하면 `UPDATE auth_sessions SET revoked_at=:now, revoked_reason='LOGOUT' WHERE id=? AND revoked_at IS NULL`을 실행하고, 감사 `LOGOUT{peer}`를 남긴다.
- 쿠키가 없거나 무효여도 200이다. 감사는 남기지 않는다.
- 응답: `200 { "ok": true }` + `Set-Cookie: xdm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
- 오류는 403 `CROSS_ORIGIN`뿐이다.

#### 4.2.4 `PUT /api/auth/password`

요청: `{ "currentPassword": "…", "newPassword": "…" }`

처리
1. 게이트, `crossSiteViolation`, `resolveSession`. 세션이 없으면 401 `UNAUTHENTICATED`다. `must_change_password` 상태여도 허용한다.
2. 입력 검증. 실패하면 400 `VALIDATION`이다.
   - `newPassword`는 8~200자다. 문구: "비밀번호는 8자 이상 200자 이하로 입력해 주세요."
   - `newPassword`는 `currentPassword`와 달라야 한다. 문구: "새 비밀번호는 현재 비밀번호와 달라야 합니다."
3. 현재 비밀번호 검증은 peer와 관계없이 LAN 예약 UPDATE(잠금 `WHERE` 포함, 4.2.2의 4단계 비루프백 분기)를 쓴다. D21 면제는 로그인에만 적용한다. 세션을 훔쳐도 서버 PC에서조차 현재 비밀번호를 무차별 대입할 수 없다.
   - 잠겼으면 429 `LOCKED`다(루프백 peer 포함). 서버 PC에서는 D21 로그인에 성공하면 잠금이 풀리므로 복구 경로는 남는다.
   - 오답이면 401 `INVALID_CREDENTIALS` "현재 비밀번호가 올바르지 않습니다."다. 세션은 유지된다.
   - 클라이언트는 401을 받아도 code가 `UNAUTHENTICATED`일 때만 로그인 화면으로 보낸다.
4. 성공하면 한 batch로 실행한다.
   - `UPDATE auth_accounts SET password_hash=?, must_change_password=0, password_changed_at=:now, failed_attempts=0, locked_until=NULL, updated_at=:now WHERE id=?`
   - `UPDATE auth_sessions SET revoked_at=:now, revoked_reason='PASSWORD_CHANGED' WHERE account_id=? AND id<>:current AND revoked_at IS NULL`
   - 감사 `PASSWORD_CHANGED{peer, revokedSessions}`
5. 응답: `200 { "ok": true, "mustChangePassword": false }`

#### 4.2.5 `POST /api/auth/bootstrap`

요청: `{ "email", "displayName", "password", "employeeId"? }`

처리
0. 로컬 peer 플러그인은 비루프백 요청을 Worker에 닿기 전에 403 `BOOTSTRAP_LOCAL_ONLY`로 막는다. 라우트도 `peerOf(h).loopback`을 다시 본다(하니스는 `setPeer`로 검증한다).
1. 형식 검사
   - `Upgrade` 헤더가 있으면 400 `VALIDATION`이다.
   - `Content-Type`이 JSON이 아니면 415 `UNSUPPORTED_MEDIA_TYPE`이다.
   - 그다음 `crossSiteViolation`(403)을 검사한다.
2. 싼 검사를 먼저 한다. `SELECT EXISTS(SELECT 1 FROM auth_accounts)`가 1이면 409 `BOOTSTRAP_CLOSED`다.
3. 입력 검증. 실패하면 400 `VALIDATION`이다.
   - email 형식
   - `displayName`은 1~60자다. 비어 있고 `employeeId`가 있으면 HR 이름을 쓴다.
   - 비밀번호 정책(8~200자)
   - `employeeId`를 주면 `hr_employee_records`에 있어야 하고("인사기록을 찾을 수 없습니다."), `acct_`로 시작하면 안 된다.
4. 해시를 계산하고 한 batch로 실행한다.
   ```sql
   INSERT INTO auth_accounts (id, email, display_name, password_hash, employee_id, is_admin, active, must_change_password,
     failed_attempts, locked_until, tabs_json, password_changed_at, last_login_at, created_by, created_at, updated_at)
   SELECT :id, :email, :name, :hash, :employeeId, 1, 1, 0, 0, NULL, '{}', :now, :now, 'bootstrap', :now, :now
   WHERE NOT EXISTS (SELECT 1 FROM auth_accounts);
   INSERT INTO auth_sessions (id, account_id, created_at, expires_at, last_seen_at, revoked_at, revoked_reason, peer, user_agent)
   SELECT :sessionHash, id, :now, :now + 2592000000, :now, NULL, '', :peer, :ua FROM auth_accounts WHERE id = :id;
   ```
5. `changes[0] !== 1`이면 409 `BOOTSTRAP_CLOSED`다. 세션은 계정 행이 실제로 들어갔을 때만 생기므로, 동시에 요청해도 201은 하나뿐이다.
6. 감사 `BOOTSTRAP_ADMIN_CREATED{peer, employeeId}`(module `auth`)
7. 응답: `201 { "user": {…}, "mustChangePassword": false }` + Set-Cookie

- 관리자는 `tabs_json '{}'`이지만 `resolveTabs`가 모든 탭을 `edit`로 푼다. 계정이 하나라도 생기면 이 경로는 영구히 닫힌다.
- 오류: 400, 403 `BOOTSTRAP_LOCAL_ONLY`·`CROSS_ORIGIN`, 409 `BOOTSTRAP_CLOSED`, 415
- 위조 테스트: LAN 주소에서 `Host: localhost`, `x-xdm-peer: 127.0.0.1`, `CF-Connecting-IP: 127.0.0.1`을 보내면 403이다.

#### 4.2.6 `/api/admin/accounts` (admin, `admin:read`/`admin:write`)

**GET** 응답
```json
200 { "accounts": [AdminAccountDto…],
      "employees": [{ "employeeId": "…", "name": "…", "department": "…", "status": "재직", "linkedAccountId": "acct_…|null" }],
      "grantableTabs": [{ "key": "hr", "label": "인사관리" }, { "key": "compensation", "label": "임금 계산" }] }
```
- `employees`는 `readOptionalHrRows`(`app/hr-optional-tables.ts:8`)로 읽는다. 테이블이 없으면 `[]`다. 퇴직자는 뒤로 보내고 이름은 ko 순으로 정렬한다.
- `grantableTabs`는 레지스트리의 `adminOnly:false` 항목이다. R5에서 chat이 더해진다.

**POST** `{ "action": …, … }`
- 응답은 모두 `200 { "account": AdminAccountDto }`다. CREATE만 201이다.
- `temporaryPassword`는 CREATE와 RESET_PASSWORD 응답에만 **한 번** 싣는다.

| action | 요청 | 처리 | 오류 | 감사 |
|---|---|---|---|---|
| `CREATE` | `{email, displayName?, employeeId?, isAdmin?, tabs?}` | `generateTemporaryPassword()`(12자) 해시, `must_change_password=1`, `created_by = 관리자 id`. `employeeId`만 주면 이름은 HR 이름 | 400 형식·인사기록 없음·`acct_` 접두·부여 불가 탭 / 409 `DUPLICATE`(이메일 존재, 이미 연결된 직원) | `ACCOUNT_CREATED{email, employeeId, isAdmin, tabs, temporaryPasswordIssued:true, peer}` |
| `UPDATE_PROFILE` | `{id, displayName?, employeeId?: string\|null, isAdmin?}` | 연결·해제·표시명·관리자 여부. 강등은 원자적 가드(아래) | 400 / 404 `NOT_FOUND` / 409 `DUPLICATE`·`LAST_ADMIN` | `ACCOUNT_PROFILE_UPDATED{before, after, peer}` |
| `UPDATE_TABS` | `{id, tabs: {hr?, compensation?, chat?}}` 값은 `none\|view\|edit` | 부여 가능 키만 병합한다. `none`은 키 삭제. 저장된 모르는 키는 보존. 다음 요청부터 적용(요청마다 DB 조회) | 400 부여 불가 키·값 / 404 | `ACCOUNT_TABS_UPDATED{before, after, peer}` |
| `RESET_PASSWORD` | `{id}` | 새 임시 비밀번호, `must_change_password=1`, 카운터·잠금 초기화, 그 계정 세션 전부 폐기(`PASSWORD_RESET`). 본인에게는 쓸 수 없다("본인 비밀번호는 비밀번호 변경에서 바꿔 주세요.") | 400 / 404 | `ACCOUNT_PASSWORD_RESET{temporaryPasswordIssued:true, revokedSessions, peer}` |
| `UNLOCK` | `{id}` | `failed_attempts=0, locked_until=NULL` | 404 | `ACCOUNT_UNLOCKED{peer}` |
| `DEACTIVATE` | `{id}` | `active=0`, 세션 전부 폐기(`DEACTIVATED`). 본인은 불가 | 400 / 404 / 409 `LAST_ADMIN` | `ACCOUNT_DEACTIVATED{revokedSessions, peer}` |
| `REACTIVATE` | `{id}` | `active=1`, 카운터·잠금 초기화. 폐기된 세션은 되살리지 않는다 | 404 | `ACCOUNT_REACTIVATED{peer}` |
| `REVOKE_SESSIONS` | `{id}` | 그 계정 세션 전부 폐기(`ADMIN_REVOKE`). 본인이면 현재 세션도 폐기된다 | 404 | `SESSIONS_REVOKED{revokedSessions, peer}` |

- 마지막 활성 관리자 보호는 `DEACTIVATE`와 `UPDATE_PROFILE{isAdmin:false}`에 원자적으로 적용한다.
  ```sql
  UPDATE auth_accounts SET active = 0, updated_at = :now          -- (강등이면 is_admin = 0)
  WHERE id = :id AND (is_admin = 0 OR (SELECT COUNT(*) FROM auth_accounts WHERE is_admin = 1 AND active = 1 AND id <> :id) >= 1)
  ```
  - 대상은 있는데 `changes = 0`이면 409 `LAST_ADMIN`이다.
  - 세션 폐기 UPDATE는 같은 batch에서 `WHERE account_id = :id AND EXISTS (SELECT 1 FROM auth_accounts WHERE id = :id AND active = 0)` 조건으로 건다.
- 연결 변경에서 `employee_id` 부분 UNIQUE 위반이 나면 409 `DUPLICATE`로 바꿔 돌려준다. `display_name`은 관리자가 바꾸지 않으면 그대로 둔다.
- 모든 action은 module `admin`으로 감사한다. 감사 뷰어의 키 가림(`app/api/audit-log/route.ts:23` `secretKey`)은 2차 방어다.
- 오프라인 초기화 `scripts/reset-admin-password.mjs`(§11.5.6)는 같은 효과를 앱 정지 중에 내고 SYSTEM 감사 `ACCOUNT_PASSWORD_RESET_OFFLINE`을 남긴다.

**`GET /api/admin/backups`** (R4, `admin:read`)
- 응답: `200 { "lastSuccessAt": number|null, "lastRun": { "id", "status", "finishedAt", "error" } | null, "stale": boolean }`
- `stale`은 마지막 `status='OK'` 행의 `finished_at`이 36시간보다 오래됐거나 성공 행이 없을 때 참이다. 계정 관리 화면이 경고 배너로 쓴다(§5.4).

#### 4.2.7 `/api/compensation` (R3 이동, ← `app/api/hr/compensation/route.ts`)

**GET** `?period=YYYY-MM[&include=hr]`
- 인가: `compensation,read`
- `applyDueRetirements(db)`는 유지한다. 멱등인 도래일 반영이다. http LAN에서는 교차 사이트 GET을 구분하지 못하는데, 이 한계는 runbook에 적는다(§7.3).
- 응답: `200 { "run": RunDto | null, "hrEmployees"?: HrPayrollSnapshot[] }`. 형태는 현행 `runJson`(`:76-85`)과 같다.
- `include=hr`의 스냅샷(`hrPayrollSnapshots`, `:95`)은 `birthDate`를 `""`로 내린다(`:129`).
  - LOAD_HR(`:213`)도 같은 함수를 쓴다.
  - 그래서 새로 불러온 행의 엑셀 '생년월일' 열(`app/compensation-calculator.tsx:498`)은 빈 칸이 된다.
- 오류: 400 급여월 형식(기존 `{error}`), 401/403

**POST** `{ action, period, version?, employees?, rows?, settings?, … }`
- `compensation,write`로 먼저 인가하고, 그다음 본문을 읽는다.
- action은 `CREATE`, `LOAD_HR`, `SAVE`, `CONFIRM`, `APPLY_RETIREMENT_PAY`, `REOPEN`이다(현행 `:199-373`). 이름은 바꾸지 않는다.
- `version` 낙관적 동시성과 기존 409 문구(`:253-254` 등)는 유지한다.
- CONFIRM은 `hr_payroll_records`·`hr_payroll_runs`에 쓴다(의도된 동작). R1부터는 `sales_incentive_payroll_links` 합산(`:311-339`)이 없다.
- `period ∈ LEGACY_SALES_INCENTIVE_PERIODS`인 CONFIRM은 409 `LEGACY_PERIOD_LOCKED` "영업 인센티브가 반영된 과거 급여월은 다시 확정할 수 없습니다."다.
  - 막는 대상은 `hr_payroll_records`를 다시 만드는 CONFIRM뿐이다.
  - SAVE, APPLY_RETIREMENT_PAY, REOPEN은 막지 않는다.
- 감사 module은 `compensation`이다. action 이름은 현행(`COMPENSATION_${action}`, `COMPENSATION_DRAFT_CREATED`, `COMPENSATION_HR_DRAFT_LOADED`) 그대로 둔다.
- 응답: `200/201 { "run": RunDto }`
- 오류: 400·404·409(기존 `{error}`), 409 `LEGACY_PERIOD_LOCKED`(code 포함)

**GET `/api/compensation/roster`**
- 인가: `compensation,read`. 부수효과가 없다(DDL·시드·`applyDue*` 없음).
- 조회: `readOptionalHrRows(db, ["hr_employee_records"], "SELECT employee_id, name, department, status FROM hr_employee_records")`. 테이블이 없으면 `[]`다.
- 정렬: `status = '퇴직'`은 뒤로 보내고, 그 안에서는 `name.localeCompare(…, "ko")` 순이다.
- 응답: `200 { "employees": [{ "employeeId": "gc.kim", "name": "…", "department": "…", "status": "재직" }] }`. **필드는 이 4개뿐이다.** 전화, 주소, 생년월일, 이메일, 급여는 없다.
- 사용처
  - `app/incentive/incentive-calculator.tsx:332`(지금은 `/api/hr/employee-records`를 부른다)
  - 어시스턴트의 compensation·incentive 모드. HR 모드(`app/local-codex-assistant.tsx:292`)만 employee-records를 쓴다.
- 오류: 401, 403 `FORBIDDEN`

**`/api/assistant?module=`**(D23)
- 순서
  1. 쿼리 `module`을 `Object.hasOwn(ASSISTANT_MODULES, m)`로 확인한다. 아니면 400 `VALIDATION`이다.
  2. `authorizeErpRequest(db, ASSISTANT_MODULES[m], "read")`
  3. `request.text()`를 읽는다. 256KB(`:24`)를 넘으면 413이다.
- 본문의 `module`은 읽지 않는다. 쿼리 값만 브리지로 넘긴다.
- 감사 `ASSISTANT_ASKED`의 module은 `ASSISTANT_MODULES[m]`이다. 본문은 남기지 않고 길이·개수만 남긴다(현행 `:82-95`).

#### 4.2.8 채팅 (R5)

상수(`app/chat-server.ts`, `app/chat-client.ts`)

| 상수 | 값 | 뜻 |
|---|---|---|
| `CHAT_POLL_VISIBLE_MS` | 2000 | 채팅 탭 활성이고 document가 보일 때 |
| `CHAT_POLL_IDLE_MS` | 15000 | 다른 탭이거나 숨김 |
| 백오프 | `[5000, 10000, 30000]` | 오류·5xx |
| `CHAT_POLL_EVENT_LIMIT` | 200 | poll 1회 이벤트 수 |
| `CHAT_MESSAGE_MAX_LENGTH` | 4000 | 본문 |
| `CHAT_PAGE_SIZE` | 50 | 기록·스레드 페이지 |
| `CHAT_SEARCH_MIN` / `MAX` / `LIMIT` | 2 / 80 / 50 | 검색 |
| `CHAT_GROUP_DM_MAX_MEMBERS` | 8 | 본인 포함 |
| `CHAT_ATTACHMENT_MAX_BYTES` | 26_214_400 | 25MB |
| `CHAT_ATTACHMENTS_PER_MESSAGE` | 10 | 메시지당 첨부 |
| `CHAT_R2_PREFIX` | `"chat/"` | `HR_AUDIO` 버킷 |

공통
- 채널 접근은 `loadChannelAccess(db, principal, channelId)` → `{ channel, member | null }`로 판정한다.
  - `private`·`dm`·`group_dm`이고 현재 멤버(`left_at IS NULL`)가 아니면 **404 `NOT_FOUND` "대화를 찾을 수 없습니다."**다. 없는 채널도 같은 404다. 목록, 메시지, 스레드, 전송, 검색, poll, 첨부의 모든 경로에 적용한다.
  - `public`은 chat 보기 이상이면 누구나 읽는다(첨부 다운로드는 멤버만, 아래 GET `/api/chat/attachments`).
  - 관리 action(`RENAME`, `REMOVE_MEMBER`, 보관 `DELETE`)도 `loadChannelAccess`를 먼저 거친다. 비공개·DM 비멤버는 관리자라도 404다. 관리자 권한은 멤버인 채널에서 owner 권한을 대신할 때만 쓴다.
  - 보관된 채널(`archived_at`)은 읽기만 된다. 쓰기는 409 `CHANNEL_ARCHIVED`다.
- `people`에는 chat 보기 이상인 활성 계정의 `{accountId, name}`만 담는다. email과 employeeId는 넣지 않는다.
- 감사
  - 전송과 읽음은 감사하지 않는다.
  - 그 밖의 감사 행에는 본문, 미리보기, 채널 이름, 파일 이름을 남기지 않는다. id, 길이, 개수만 남긴다.

**GET `/api/chat/channels`** (`chat,read`)
```json
200 { "channels": [ChatChannelDto…],
      "joinable": [{ "id": "ch_general", "name": "일반", "topic": "", "memberCount": 3 }],
      "people": [{ "accountId": "acct_…", "name": "…" }],
      "me": { "canWrite": true, "isAdmin": false } }
```
- `channels`: 내가 현재 멤버인 채널이다. 보관된 채널도 포함하고 `archived`로 표시한다.
- `joinable`: 내가 멤버가 아니고 보관되지 않은 public 채널이다.
- 비공개 채널과 DM은 멤버에게만 보인다.
- `me.canWrite`는 `hasTabLevel(p, "chat", "edit")`다.

**POST `/api/chat/channels`**
- 인가 순서
  1. `chat,read`로 인가한다.
  2. 본문을 읽는다.
  3. `JOIN`·`LEAVE`가 아니면 `authorizeErpRequest(db, "chat", "write")`를 한 번 더 부른다.
- action마다 필요한 수준이 달라서 이 라우트만 중첩 인가를 유지한다. 부족하면 403이고 `ACCESS_DENIED` 감사가 남는다.

| action | 요청 | 처리 | 응답 | 오류 | 감사 |
|---|---|---|---|---|---|
| `JOIN`(view) | `{channelId}` | public, 보관 아님. `chat_members` upsert(`left_at=NULL`) + 이벤트 `member.joined`(subject=나) | 200 `{channel}` | 404, 409 `CHANNEL_ARCHIVED`, 400(public 아님) | 없음 |
| `LEAVE`(view) | `{channelId}` | public만. `left_at=:now` + `member.left`(subject=나) | 200 `{ok:true}` | 400·404 | 없음 |
| `CREATE_CHANNEL` | `{name 1~40, kind:'public'\|'private', topic? ≤200, memberIds?}` | 생성자 owner, `memberIds`(활성·chat 보기 이상만) member. 멤버마다 `member.joined` | 201 `{channel}` | 400, 409 `DUPLICATE`(이름) | `CHANNEL_CREATED{channelId, kind, memberCount}` |
| `OPEN_DM` | `{accountIds}` | 참여자 = `unique(accountIds ∪ 나)`. 2명이면 `dm`, 3~8명이면 `group_dm`(`CHAT_GROUP_DM_MAX_MEMBERS=8`). `dm_key`가 이미 있으면 그 채널을 돌려준다(UNIQUE 위반 → 재조회) | 201 `{channel, created:true}` / 200 `{channel, created:false}` | 400(1명·9명 이상·비활성·chat 권한 없음) | 새로 만들 때만 `DM_OPENED{channelId, memberCount}` |
| `ADD_MEMBERS` | `{channelId, accountIds}` | public·private만, 요청자가 멤버. 대상은 활성이고 chat 보기 이상인 계정만(아니면 400). 재참여면 `left_at=NULL`. 대상마다 `member.joined` | 200 `{channel}` | 400(DM류·부적격 대상), 404, 409 `CHANNEL_ARCHIVED` | `CHANNEL_MEMBERS_CHANGED{channelId, added, removed:0}` |
| `REMOVE_MEMBER` | `{channelId, accountId}` | owner 또는 관리자. `left_at=:now` + `member.left`(subject=대상). owner 본인 제거는 불가 | 200 `{channel}` | 400, 403 `FORBIDDEN`(owner 아님), 404 | `CHANNEL_MEMBERS_CHANGED{channelId, added:0, removed:1}` |
| `RENAME` | `{channelId, name?, topic?}` | owner 또는 관리자, public·private만. `channel.updated` | 200 `{channel}` | 400, 403, 404, 409 `DUPLICATE`·`CHANNEL_ARCHIVED` | `CHANNEL_RENAMED{channelId}` |

**DELETE `/api/chat/channels?id=`** (`chat,admin`)
- `archived_at=:now`로 두고 이벤트 `channel.archived`를 남긴다.
- 응답 200 `{ok:true}`. 감사 `CHANNEL_ARCHIVED{channelId}`
- 보관 뒤에는 이름 UNIQUE에서 빠진다(부분 인덱스).

**GET `/api/chat/messages`** (`chat,read`)

`channelId`·`threadRootId`·`q` 가운데 정확히 하나를 받는다. 아니면 400이다.
- 기록 `?channelId=&before=<id>&limit=`
  - 최상위(`thread_root_id IS NULL`)만 읽는다. `id < before`, `limit ≤ CHAT_PAGE_SIZE(50)`, `ORDER BY id DESC`로 읽은 뒤 오름차순으로 돌려준다.
  - 응답: `200 { messages: ChatMessageDto[], hasMore }`
- 스레드 `?threadRootId=&after=<id>`
  - 루트가 있는 채널의 접근 검사를 거친다.
  - 루트와 `id > after`인 답글을 오름차순으로 50개까지 돌려준다.
  - 응답: `200 { root, replies, hasMore }`. 루트가 답글이면 400이다.
- 검색 `?q=`
  - 길이는 2~80자(`CHAT_SEARCH_MIN/MAX`)다. 벗어나면 400이다.
  - 조건은 `body LIKE ? ESCAPE '\'`이고 바인드 값은 `%${escapeLike(q)}%`다. `escapeLike`는 `\`·`%`·`_`를 이스케이프하며 `app/api/audit-log/route.ts:60-62`와 같다.
  - 범위: 내가 현재 멤버인 채널 전부 + public 채널 전부. 삭제된 메시지는 빼고 `ORDER BY id DESC LIMIT 50`(`CHAT_SEARCH_LIMIT`)이다.
  - 응답: `200 { results: [{ message: ChatMessageDto, channel: { id, kind, name } }] }`

**POST `/api/chat/messages`** (`chat,write`)
- 요청: `{ channelId, body, threadRootId?, attachmentIds?, clientKey? }`
- 사전 검사
  - `body.trim()`은 1~4000자다. 첨부가 1개 이상이면 빈 본문도 허용한다.
  - `attachmentIds`는 10개 이하(`CHAT_ATTACHMENTS_PER_MESSAGE`)이고, 모두 `uploader=나`, `channel_id=channelId`, `message_id IS NULL`, `deleted_at IS NULL`이어야 한다. 아니면 400 "첨부 파일을 확인해 주세요."다.
  - `threadRootId`의 루트는 같은 채널의 최상위 메시지이고 삭제되지 않아야 한다. 답글의 답글은 400 "답글에는 다시 답글을 달 수 없습니다."다.
  - 비공개·DM 비멤버는 404, 보관 채널은 409다. public이면 자동 참여한다.
- 멘션
  - `extractMentions(body, people)`(`app/chat-mentions.ts`)로 `@이름`을 찾는다. `@channel`·`@채널`은 `mention_channel=1`이다.
  - 기록 대상은 private·DM이면 현재 멤버, public이면 chat 보기 이상인 활성 계정이다.
- 한 batch로 실행한다(`:ck = '<accountId>:<clientKey | randomUUID>'`).
  1. public이고 아직 멤버가 아니면 `INSERT INTO chat_events … SELECT … 'member.joined' … WHERE NOT EXISTS(현재 멤버)` 뒤에 멤버를 upsert한다.
  2. `INSERT INTO chat_messages (client_key, …) VALUES (:ck, …)`
  3. 답글이면 `UPDATE chat_messages SET reply_count = reply_count + 1, last_reply_at = :now WHERE id = :root AND thread_root_id IS NULL AND deleted_at IS NULL`
  4. 멘션 대상마다 `INSERT INTO chat_mentions SELECT id, :acct, :ch, :now FROM chat_messages WHERE client_key = :ck`
  5. `UPDATE chat_attachments SET message_id = (SELECT id FROM chat_messages WHERE client_key = :ck) WHERE id IN (…) AND uploader_account_id = :me AND channel_id = :ch AND message_id IS NULL`
  6. `INSERT INTO chat_events (channel_id, kind, message_id, created_at) SELECT :ch, 'message.created', id, :now FROM chat_messages WHERE client_key = :ck`
  7. 최상위 메시지일 때만 `UPDATE chat_members SET last_read_message_id = MAX(last_read_message_id, (SELECT id … :ck)), last_read_at = :now WHERE channel_id = :ch AND account_id = :me`
- 응답: `201 { message: ChatMessageDto }`
  - `client_key` UNIQUE를 위반하면 batch 전체가 롤백된다. 이때 기존 행을 읽어 `200 { message, duplicate: true }`를 돌려준다(재전송 중복 제거).
  - 본인이 두 탭에서 같은 첨부를 동시에 두 메시지에 붙이면 뒤 메시지에서 첨부가 빠질 수 있다. 수용한다.

**PATCH `/api/chat/messages`** (`chat,write` + 작성자)
- 요청: `{ id, body }`
- 삭제된 메시지와 보관 채널은 409, 작성자가 아니면 403 `FORBIDDEN`, 비멤버는 404다.
- batch
  1. `UPDATE chat_messages SET body = ?, edited_at = :now WHERE id = ? AND author_account_id = :me AND deleted_at IS NULL`
  2. 멘션을 지우고 다시 넣는다.
  3. `message.edited` 이벤트를 남긴다.
- 응답 `200 { message }`. 감사 `CHAT_MESSAGE_EDITED{messageId, channelId, beforeLength, afterLength}`

**DELETE `/api/chat/messages?id=`** (`chat,write` + 작성자)
- soft-delete다. `deleted_at`·`deleted_by`를 채우고, 그 메시지의 첨부에도 `deleted_at`을 채운다. R2 객체는 남긴다(백업 단위 유지).
- 이벤트 `message.deleted`를 남긴다. DTO는 `body: null`, `attachments: []`, `deleted: true`이고, 화면에는 "삭제된 메시지입니다."가 나온다.
- 응답 `200 { message }`. 감사 `CHAT_MESSAGE_DELETED{messageId, channelId, length, attachmentCount}`

**GET `/api/chat/poll?since=<seq>&summary=0|1&watch=<publicChannelId?>`** (`chat,read`)
- hot path는 게이트(0쿼리), 세션(1), 이벤트(1)다. DDL·감사·쓰기는 없다(`last_seen_at` 시간당 1회만 예외).
- `since`는 0 이상의 정수다. 아니면 400이다.
- `since=0`이면 커서만 잡고 기록은 쏟아내지 않는다: `{ cursor: head, hasMore: false, events: [], unread }`
- 이벤트 조회는 멤버십 전용 증분 규칙을 따른다. `head`를 같은 문장에서 읽어 일관된 스냅샷을 쓴다.
  ```sql
  WITH head AS (SELECT COALESCE(MAX(seq), 0) AS head FROM chat_events)
  SELECT head.head, e.seq, e.kind, e.channel_id, e.message_id, e.subject_account_id
  FROM head LEFT JOIN chat_events e ON e.seq > :since AND (
         e.channel_id IN (SELECT channel_id FROM chat_members WHERE account_id = :me AND left_at IS NULL)
      OR (e.channel_id = :watch AND EXISTS (SELECT 1 FROM chat_channels c WHERE c.id = :watch AND c.kind = 'public' AND c.archived_at IS NULL))
      OR e.subject_account_id = :me)
  ORDER BY e.seq LIMIT 201            -- CHAT_POLL_EVENT_LIMIT(200) + 1
  ```
  - 대상은 현재 멤버인 채널, `watch`(보관되지 않은 public일 때만), 나를 대상으로 한 `member.*`(추가·제거 통지)다. 비공개 채널의 비멤버에게는 어떤 이벤트도 가지 않는다.
  - 읽음 위치 변경은 이벤트가 아니다. 그래서 남이 읽어도 내 증분이나 unread 재계산이 생기지 않는다.
- 커서
  - 201행이면 `hasMore: true`, `cursor = 200번째 seq`다. 클라이언트는 곧바로 다시 폴링한다.
  - 그렇지 않으면 `cursor = head`다. 보이지 않는 이벤트를 다시 훑지 않는다. D1은 작성자가 하나이고 batch가 원자적이라, `head`보다 작은 seq가 나중에 커밋되지 않는다.
  - `since > head`면(백업 복구 뒤 등) `{ cursor: head, resync: true, events: [], unread }`를 돌려준다. 클라이언트는 채널 목록과 현재 대화를 다시 읽는다.
- 쿼리는 이벤트가 있을 때만 더한다. 메시지 DTO 1쿼리(`message.*`의 `message_id` IN, 작성자 이름·첨부·멘션 JSON 서브쿼리)와 unread 1쿼리다. `summary=1`이면 이벤트가 없어도 unread를 계산하고, 아니면 `unread: null`이다.
- 응답
  ```json
  200 { "cursor": 1234, "hasMore": false,
        "events": [{ "seq": 1234, "kind": "message.created", "channelId": "ch_…", "message": { "id": 88, "channelId": "ch_…", "threadRootId": null, "author": { "accountId": "acct_…", "name": "…" }, "body": "…", "mentions": ["acct_…"], "mentionChannel": false, "attachments": [], "replyCount": 0, "lastReplyAt": null, "createdAt": 0, "editedAt": null, "deleted": false } },
                   { "seq": 1235, "kind": "member.left", "channelId": "ch_…", "subjectAccountId": "acct_…" }],
        "unread": { "total": 3, "mentions": 1, "channels": [{ "channelId": "ch_…", "unread": 3, "mentions": 1, "lastMessageId": 88 }] } }
  ```
- unread 계산(내가 현재 멤버인 채널, 보관 제외)
  - `unread`: `id > last_read_message_id`, 삭제되지 않음, 작성자가 내가 아님, 그리고 최상위이거나 나를 멘션한 답글
  - `mentions`: 위 조건 + (`mention_channel = 1`이거나 `chat_mentions`에 내가 있음)
  - `lastMessageId`: 채널에서 삭제되지 않은 최상위 메시지의 최대 id
- 클라이언트(`useChatPoll`)
  - 주기는 위 상수표를 따른다. 요청은 한 번에 1개만 보낸다(`AbortController`).
  - 첫 호출, focus·visibilitychange, 본인 전송 직후에는 즉시 폴링하고 `summary=1`을 보낸다.
  - `channel.*`·`member.*` 이벤트를 받으면 `/api/chat/channels`를 다시 읽는다.
  - 401 `UNAUTHENTICATED`면 로그인 화면, 403 `PASSWORD_CHANGE_REQUIRED`면 비밀번호 화면으로 간다. 403 `FORBIDDEN`이면 폴링을 멈추고 `/api/me`를 다시 읽는다.
  - `document.title`은 `(N) XDnode management`이고, N이 0이면 `XDnode management`다.

**PUT `/api/chat/attachments?channelId=&name=<encodeURIComponent>`** (`chat,write` + 멤버)

본문은 파일 바이트 그대로다. raw body라 vinext의 multipart server-action 경로를 타지 않는다(연구 자료 gap 2). 그래서 한국어 413이 모든 모드에서 같게 나온다.
1. 인가(`chat,write`, 교차 출처 검사 포함)
2. 멤버 검사
   - private·DM 비멤버는 404다.
   - public 비멤버는 403 `FORBIDDEN` "채널에 참여한 뒤 올려 주세요."다.
   - 보관 채널은 409다.
3. 크기 사전 검사. **본문을 읽기 전에** 판정한다.
   - `Content-Length`가 없거나 숫자가 아니면 411 `LENGTH_REQUIRED`다.
   - `CHAT_ATTACHMENT_MAX_BYTES(26_214_400)`를 넘으면 413 `PAYLOAD_TOO_LARGE`다.
4. 이름·형식 검사
   - `name`을 한 번 디코드하고 제어문자와 경로 구분자(`/`, `\`)를 뺀다(≤200자).
   - 확장자를 소문자로 판정한다. 허용표 밖이면 415 `UNSUPPORTED_MEDIA_TYPE`이다.
     - 미리보기(inline): `png, jpg, jpeg, gif, webp`
     - 첨부(attachment): `pdf, docx, xlsx, pptx, hwp, hwpx, txt, csv, zip`
   - SVG·HTML·확장자 없음·이중 확장자에서 마지막이 목록 밖인 경우는 모두 415다. `content_type`은 서버 표에서 정하고 클라이언트 `Content-Type`은 무시한다.
5. `await request.arrayBuffer()`로 읽고 실제 길이를 다시 검사한다. 선언값과 다르거나 상한을 넘으면 413이다.
6. `HR_AUDIO.put("chat/<channelId>/<attId>", bytes, { httpMetadata: { contentType } })`. 키는 서버가 만들고 사용자 입력은 들어가지 않는다.
7. INSERT한다. 실패하면 R2 객체를 지우고 오류를 다시 던진다.
8. 감사 `CHAT_ATTACHMENT_UPLOADED{attachmentId, channelId, size, contentType}`

응답은 `201 { attachment: ChatAttachmentDto }`다. 413 경로에서는 R2가 바뀌지 않는다(테스트로 단언).

**GET `/api/chat/attachments?id=`** (`chat,read`)
- 접근
  - 현재 멤버(`left_at IS NULL`)만 받는다(Plan R5, FR-13 '멤버만 다운로드'). 공개 채널 비멤버는 403 `FORBIDDEN` "채널에 참여한 뒤 받을 수 있습니다.", 비공개·DM 비멤버는 404다.
  - 전송 전 첨부는 올린 사람만 받는다.
  - 첨부나 메시지가 삭제됐으면 404다.
- 응답 헤더
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: private, no-store`
  - `Content-Security-Policy: sandbox; default-src 'none'`
  - `Content-Type: <content_type>`
  - `Content-Disposition`: 이미지 4종(png·jpeg·gif·webp)은 `inline`, 나머지는 `attachment; filename*=UTF-8''<encoded>`
- 감사하지 않는다.

**DELETE `/api/chat/attachments?id=`** (`chat,write` + 업로더)
- `message_id IS NULL`인 미전송분만 지운다(R2 삭제 + `deleted_at`). 이미 전송된 첨부는 400이다.
- 응답 200 `{ok:true}`. 감사 `CHAT_ATTACHMENT_DELETED{attachmentId, channelId}`

**PUT `/api/chat/read-state`** (`chat,read`)
- 요청: `{ channelId, lastReadMessageId }`. 멤버만 할 수 있다(비멤버는 404).
- 값은 그 채널의 최대 메시지 id로 자른다.
- `UPDATE chat_members SET last_read_message_id = MAX(last_read_message_id, :v), last_read_at = :now WHERE channel_id = ? AND account_id = :me AND left_at IS NULL`
- 이벤트와 감사를 남기지 않는다. `writeErpAudit` 가드의 유일한 예외 파일이다.
- 응답: `200 { unread: UnreadSummary }`

#### 4.2.9 감사 action 이름

- HR(module `hr`·`recruitment`): `PERSONNEL_ACTION_APPROVED`·`PERSONNEL_ACTION_REJECTED`, `RETIREMENT_APPROVED`·`RETIREMENT_REJECTED`, `LEAVE_REQUEST_APPROVED`(기존 `LEAVE_REQUEST_${status}` 유지), `PAYROLL_RUN_STATUS_UPDATED`·`PAYROLL_RUN_LOCKED`·`PAYROLL_RUN_REOPENED`(module `finance` 감사 2건은 삭제), `PERFORMANCE_CYCLE_FINALIZED`, `WORKFORCE_PLAN_APPROVED`, `REQUISITION_OPENED`
- auth(module `auth`): `LOGIN_SUCCEEDED`, `LOGIN_FAILED`, `LOGIN_BLOCKED`, `ACCOUNT_LOCKED`, `LOGOUT`, `PASSWORD_CHANGED`, `BOOTSTRAP_ADMIN_CREATED`
- admin(module `admin`): `ACCOUNT_CREATED`, `ACCOUNT_PROFILE_UPDATED`, `ACCOUNT_TABS_UPDATED`, `ACCOUNT_PASSWORD_RESET`, `ACCOUNT_UNLOCKED`, `ACCOUNT_DEACTIVATED`, `ACCOUNT_REACTIVATED`, `SESSIONS_REVOKED`, 스크립트용 `ACCOUNT_PASSWORD_RESET_OFFLINE`(actor SYSTEM)
- `ACCESS_DENIED`: module은 요청한 모듈이고, 모르는 모듈이면 `auth`다. `after{module,action,tab,required,granted}`. 모든 action에서 남긴다.
- chat(module `chat`, 본문·채널 이름·파일 이름 없음): `CHANNEL_CREATED{channelId,kind,memberCount}`, `DM_OPENED{channelId,memberCount}`, `CHANNEL_MEMBERS_CHANGED{channelId,added,removed}`, `CHANNEL_RENAMED{channelId}`, `CHANNEL_ARCHIVED{channelId}`, `CHAT_MESSAGE_EDITED{messageId,channelId,beforeLength,afterLength}`, `CHAT_MESSAGE_DELETED{messageId,channelId,length,attachmentCount}`, `CHAT_ATTACHMENT_UPLOADED{attachmentId,channelId,size,contentType}`, `CHAT_ATTACHMENT_DELETED{attachmentId,channelId}`. 전송과 읽음은 감사하지 않는다.
- compensation: 현행 `COMPENSATION_${action}`, `COMPENSATION_DRAFT_CREATED`, `COMPENSATION_HR_DRAFT_LOADED`를 유지하고 module만 `compensation`으로 바꾼다.
- assistant: `ASSISTANT_ASKED`(module = `ASSISTANT_MODULES[m]`).
- auth·admin 이벤트의 `after`에는 항상 `peer`를 넣는다. 비밀번호, 토큰, 쿠키, `temporaryPassword`는 넣지 않는다(`temporaryPasswordIssued:true`만).

### 4.3 탭 → API 권한 대응표 (유지 라우트 22개 전부 + 신규)

#### 4.3.1 탭 레지스트리 `app/access-tabs.ts` (R3)

순수 모듈이고 import가 없다. 클라이언트와 서버가 함께 쓴다.

```ts
export type TabLevel = "none" | "view" | "edit";
export type ErpAction = "read" | "write" | "approve" | "delete" | "admin";
export const TAB_REGISTRY = [
  { key: "hr", label: "인사관리", glyph: "◎", adminOnly: false, modules: ["hr", "recruitment"], apiPrefixes: ["/api/hr/", "/api/documents"], shellClass: "hr-module-shell" },
  { key: "compensation", label: "임금 계산", glyph: "◫", adminOnly: false, modules: ["compensation"], apiPrefixes: ["/api/compensation"], shellClass: "compensation-erp-shell" },
  // R5: { key: "chat", label: "메신저", glyph: "◌", adminOnly: false, modules: ["chat"], apiPrefixes: ["/api/chat/"], shellClass: "chat-module-shell" },
  { key: "audit", label: "감사 로그", glyph: "▤", adminOnly: true, modules: ["audit"], apiPrefixes: ["/api/audit-log"], shellClass: "admin-module-shell" },
  { key: "admin", label: "계정 관리", glyph: "◈", adminOnly: true, modules: ["admin"], apiPrefixes: ["/api/admin/"], shellClass: "admin-module-shell" },
] as const;
export type TabDefinition = (typeof TAB_REGISTRY)[number];
export type TabKey = TabDefinition["key"];                            // R3: hr|compensation|audit|admin, R5: +chat
export type ErpModule = TabDefinition["modules"][number];            // R3: hr|recruitment|compensation|audit|admin, R5: +chat
export type GrantableTabKey = Extract<TabDefinition, { adminOnly: false }>["key"]; // R3: hr|compensation, R5: +chat
export type ResolvedTabs = Record<TabKey, TabLevel>;                  // 요청마다 resolveTabs(tabs_json, is_admin)로 계산
export const MODULE_TAB: ReadonlyMap<string, TabKey>;               // modules에서 파생. 한 모듈이 두 탭에 걸리면 모듈 초기화 때 throw
export const ASSISTANT_MODULES = { hr: "hr", compensation: "compensation", incentive: "compensation" } as const; // satisfies Record<string, ErpModule>
export function tabOfModule(module: string): TabKey | null;           // Map.get만 쓴다(프로토타입 키 차단)
export function requiredLevel(action: ErpAction): "view" | "edit" | "admin"; // read→view, write|approve|delete→edit, admin→admin
export function resolveTabs(tabsJson: string, isAdmin: boolean): ResolvedTabs;
export function canAccess(p: { isAdmin: boolean; tabs: ResolvedTabs }, module: string, action: ErpAction): boolean;
export function hasTabLevel(p, tab: TabKey, level: "view" | "edit"): boolean;
export function isHrManager(p): boolean;                              // p.isAdmin || p.tabs.hr === "edit"
export function permittedTabs(tabs: ResolvedTabs): TabDefinition[];    // 레지스트리 순서
export function firstPermittedTab(tabs: ResolvedTabs): TabKey | null;
```

`canAccess(p, module, action)`의 판정 순서
1. `tabOfModule(module)`이 null이면 false다. **isAdmin 판정보다 먼저** 한다. `MODULE_TAB`은 `Map`이고, `Map.get`만 써서 프로토타입 키를 막는다.
2. action이 `admin`이면 `isAdmin`으로 판정한다.
3. 탭이 adminOnly이면 `isAdmin`으로 판정한다.
4. isAdmin이면 true다.
5. 부여 수준의 순위(none 0 < view 1 < edit 2)가 `requiredLevel(action)` 이상인지 본다.

- 모르는 action은 false다.
- 거부하면 `ACCESS_DENIED{module, action, tab, required, granted}`를 남긴다. 모르는 모듈이면 module은 `auth`로 기록한다.
- `isHrManager(p) = p.isAdmin || p.tabs.hr === "edit"`가 기존 `privileged()`와 `hr:approve`·`recruitment:*`를 대체한다.
- 새 탭(예: 견적)은 레지스트리 1항목, `TAB_PANELS` 1항목, 새 라우트만으로 추가한다(FR-16, §10.7).

`authorizeErpRequest(db, module, action)`의 순서(R3, `app/erp-platform.ts`, 시그니처 유지)
1. `platformSchemaReady(db)`
2. `h = await headers()`
3. `crossSiteViolation(h)` → 403 `CROSS_ORIGIN`
4. `resolveSession(db, h.get("cookie"))`. 없으면 401 `UNAUTHENTICATED`. 비활성·만료·폐기도 401이다.
5. `must_change_password`면 403 `PASSWORD_CHANGE_REQUIRED`
6. `toPrincipal`
7. `!canAccess`면 `ACCESS_DENIED`를 감사에 남기고(모든 action) 403 `FORBIDDEN`
8. `{ principal }`

#### 4.3.2 라우트별 대응

| 라우트 | 메서드 | 현재 호출 (file:line, module:action) | R3 이후 호출 | 탭:수준 |
|---|---|---|---|---|
| hr/analytics | GET / POST | `hr:read` :172 / `hr:write` :189, `privileged` :19 | 같음, `privileged` → `isHrManager` | hr:view / hr:edit |
| hr/applicant-interview-recordings | GET / POST | `recruitment:read` :50 / `recruitment:write` :82 | 같음 | hr:view / hr:edit |
| hr/catalogs | GET / POST / DELETE | `hr:read` :63 / `hr:write` :72 / `hr:write` :103 | 같음 | hr:view / hr:edit / hr:edit |
| hr/employee-records | GET / PUT | `hr:read` :80 / `hr:write` :119 | 같음. PUT은 `employeeId`가 `acct_`로 시작하면 400 | hr:view / hr:edit |
| hr/interviews | GET / POST | `hr:read` :61 / `hr:write` :91 | 같음 | hr:view / hr:edit |
| hr/leave | GET / POST / DELETE | `hr:read` :101 / `hr:write` :138 / `hr:write` :217 | 같음(DELETE의 결재 SQL :222-224는 R1 삭제) | hr:view / hr:edit / hr:edit |
| hr/message-templates | GET / PUT / DELETE | `hr:read` :36 / `hr:write` :45 / `hr:write` :89 | 같음 | hr:view / hr:edit / hr:edit |
| hr/operations | GET / POST / PUT | `hr:read` :198 / `hr:write` :252 / 본문 :446 뒤 `hr:write\|approve` :451 | GET·POST 같음. PUT은 본문 앞에서 `hr:write`. GET 응답 `principal:{roles}`(:247) → `access:{hr, isAdmin}` + `accountNames: Record<acct_id, displayName>`(`unlinkedAccountNames(db)`, 비활성 포함, email 없음). severanceToPayroll(:455)은 `hr_compensation_*`에 쓴다(의도) | hr:view / hr:edit / hr:edit |
| hr/organization-leaders | GET / PUT | `hr:read` :36 / `hr:write` :51 | 같음 | hr:view / hr:edit |
| hr/organizations | GET / POST / PUT | `hr:read` :36 / `hr:write` :47 / `hr:write` :67 | 같음 | hr:view / hr:edit / hr:edit |
| hr/payroll | GET / POST / PUT | `hr:read` :242 / `hr:write` :305 / 본문 :385 뒤 `hr:write\|approve` :392, 중첩 `hr:approve` :467 | PUT은 본문 앞에서 `hr:write`, :467 제거. 재오픈은 `LEGACY_FINANCE_LOCKED_PAYROLL_PERIODS`면 409 `LEGACY_PERIOD_LOCKED` | hr:view / hr:edit / hr:edit |
| hr/performance | GET / POST | `hr:read` :181 / `hr:write` :195, `privileged` :39 | 같음, `isHrManager`. self/manager는 연결된 employeeId로만 판정 | hr:view / hr:edit |
| hr/recruitment | GET / PUT / POST / DELETE | `recruitment:read` :224 / `recruitment:write` :258 + 중첩 `hr:write` :291,:381 / 본문 :544 뒤 `recruitment:write` :547(offer)·`recruitment:approve` :593(담당자 지정) / `recruitment:delete` :611 | POST는 본문 앞에서 `recruitment:write` 1회. 중첩 :291, :381, :593 제거. PUT(입사 전환 :303, 오퍼 수정 :392)도 `employeeId`가 `acct_`로 시작하면 400 | hr:view / hr:edit ×3 |
| hr/recruitment-requisitions | GET / POST | `recruitment:read` :168 / `recruitment:write` :215 | 같음 | hr:view / hr:edit |
| hr/resume-analysis | POST | `recruitment:write` :197 | 같음 | hr:edit |
| hr/training | GET / POST | `hr:read` :101 / `hr:write` :108, `privileged` :23 | 같음, `isHrManager` | hr:view / hr:edit |
| hr/transcriptions | GET / POST | 동적 `entityModules[type]:read` :63 / 본문 :69 뒤 `entityModules[type]:write` :72 (map :20) | **리터럴** `hr:read` / `hr:write`를 첫 줄에서, 그다음 쿼리·본문. 감사 module은 `entityModules`(hr·recruitment) 유지 | hr:view / hr:edit |
| hr/workforce-plans | GET / POST | `hr:read` :136 / `hr:write` :144 | 같음 | hr:view / hr:edit |
| documents | GET / POST / PATCH / DELETE | 동적: 행 `row.module:read` :52(다운로드), 쿼리 `module:read` :65(목록) / formData :75 뒤 `module:write` :84 / JSON :160 뒤 행 `row.module:write` :170 / JSON :196 뒤 행 `row.module:delete` :200 | **리터럴** `hr:read`(GET) / `hr:write`(POST·PATCH) / `hr:delete`(DELETE)를 첫 줄에서, 그다음 행 조회·폼 읽기 | hr:view / hr:edit ×3 |
| compensation (← hr/compensation) | GET / POST | `hr:read` :175 / `hr:write` :189 | `compensation:read` / `compensation:write`, 감사 module `compensation` | compensation:view / compensation:edit |
| assistant | POST | 동적: 본문 :36 뒤 `MODULE_PERMISSION[module]:read` :47 (type :14, map :17-21) | `?module=` → `ASSISTANT_MODULES[m]:read` → 본문 | hr→hr:view, compensation·incentive→compensation:view |
| audit-log | GET | `settings:admin` :65 (R1까지) | `audit:read`. 필터 허용 목록(:22) 교체(§6.1 아래) | audit:admin |
| hr/authorized-users | GET / POST / DELETE | `settings:admin` :35 / :52 / :91 | **R3 삭제**(`/api/admin/accounts`가 대체) | — |
| compensation/roster (신규) | GET | — | `compensation:read` | compensation:view |
| admin/accounts (신규) | GET / POST | — | `admin:read` / `admin:write` | admin:admin |
| admin/backups (신규, R4) | GET | — | `admin:read` | admin:admin |
| chat/channels (신규, R5) | GET / POST / DELETE | — | `chat:read`(GET, JOIN·LEAVE) → 나머지 action은 본문 뒤 `chat:write` 추가 / `chat:admin` | chat:view / chat:view·edit / admin |
| chat/messages | GET / POST·PATCH·DELETE | — | `chat:read` / `chat:write` + 작성자 | chat:view / chat:edit |
| chat/poll | GET | — | `chat:read` | chat:view |
| chat/attachments | PUT / GET / DELETE | — | `chat:write` + 멤버 / `chat:read` + 멤버 / `chat:write` + 업로더 | chat:edit / chat:view / chat:edit |
| chat/read-state | PUT | — | `chat:read` | chat:view |
| me, auth/* | — | — | `authorizeErpRequest`를 부르지 않는다. 각 라우트가 `platformSchemaReady`·`crossSiteViolation`을 직접 부른다 | — |

**R3에서 인가를 본문 읽기보다 앞으로 옮기는 곳(8곳, 부록 B #27)**: assistant POST(`:36`→`:47`), documents POST(`:75`→`:84`)·PATCH(`:160`→`:170`)·DELETE(`:196`→`:200`), payroll PUT(`:385`→`:392`), operations PUT(`:446`→`:451`), transcriptions POST(`:69`→`:72`), recruitment POST(`:544`→`:547`, `:593`).

**동적 매핑의 fail-closed 규칙**
- documents
  - R1
    - import `:4-6`과 finance·sales 분기(`:86-127`, `:202-260`)를 지운다.
    - `allowedModules`(`:17`)를 `DOCUMENT_MODULES: ReadonlySet<"hr"|"recruitment">`와 타입 가드로 바꾸고, `as ErpModule` 캐스트를 없앤다.
    - POST는 `formData()`(`:75`) 전에 `recruitment:write`로 인가하고, 폼을 읽은 뒤 module이 `hr`이면 `hr:write`를 더 본다(Plan M1-1, 부록 C #20).
  - R3: 인가를 먼저 하고, 그다음 행을 조회한다.
    - 행의 module이 `DOCUMENT_MODULES` 밖(레거시 finance·sales)이면 **관리자라도 404**다. 인가 뒤에 판정하므로, 행이 있다는 사실은 hr 보기 이상인 사용자에게만 드러난다.
    - 목록 조회의 `?module=`가 허용 밖이면 400이다.
    - 감사 module은 행의 module(hr·recruitment)이다.
- transcriptions
  - 인가 모듈은 리터럴 `hr`이다. `entityModules`는 감사 module에만 쓴다.
  - 모르는 `entityType`은 인가 뒤에 400이다.
- assistant
  - `ASSISTANT_MODULES = { hr:"hr", compensation:"compensation", incentive:"compensation" }`(`satisfies Record<string, ErpModule>`)
  - `Object.hasOwn`을 통과한 뒤에만 조회한다. 목록 밖(`sales`, `__proto__` 등)은 400이다.
  - 인가 수준은 view다. 어시스턴트 제안의 적용 버튼은 대상 API가 edit를 다시 검사한다.
- operations PUT, payroll PUT, recruitment POST
  - 리소스별 `write/approve` 분기를 없앤다. D13에 따라 상태 변경도 edit다.
  - 본문을 읽기 전에 인가한다.

**소스 가드(`tab-permissions.test.mjs`)**
- `me`·`auth/*`를 뺀 모든 `app/api/**/route.ts`는 `authorizeErpRequest(`를 **문자열 리터럴 모듈**로 부른다. 그 모듈의 탭은 경로의 `apiPrefixes`가 가리키는 탭과 같아야 한다.
- 동적 모듈은 `app/api/assistant/route.ts` 하나만 허용한다. `ASSISTANT_MODULES`를 레지스트리와 대조한다.
- POST/PUT/PATCH/DELETE를 내보내는 파일은 모두 `writeErpAudit`를 포함한다. 예외는 `app/api/chat/read-state/route.ts`뿐이다.
- `TAB_REGISTRY`의 key는 중복되지 않고, `audit`·`admin`은 adminOnly다.

**교차 매트릭스(SC-2)**

| 계정 | compensation, roster | employee-records | assistant `module=compensation` / `module=hr` | audit-log, admin/accounts |
|---|---|---|---|---|
| compensation=edit, hr=none | 200 | 403 | 통과 / 403 | 403 |
| hr=edit, compensation=none | 403 | 200 | 403 / 통과 | 403 |
| 비관리자, tabs_json에 `audit`·`admin`=edit | 부여대로 | 부여대로 | 부여대로 | **403**(resolveTabs가 버림) |
| 관리자 | 200 | 200 | 통과 | 200 |

- 레거시 finance 문서 다운로드는 관리자와 일반 계정 모두 404다.
- chat 열(R5)
  - view 계정은 GET·poll·read-state·JOIN·LEAVE만 된다. 전송·업로드·채널 생성은 403이다.
  - 비공개 채널 비멤버는 모든 채팅 경로에서 404다.

---

## 5. UI/UX Design

전제
- 시각 체계는 지금 것을 그대로 쓴다. 라이트 전용 zinc 팔레트에 주황 강조(#ff5a00) 하나, 검은 primary 버튼, 24px 라운드 흰 패널이다. `:root` 토큰 17개는 `app/globals.css:281-307`에 있고 HR shadow tree도 이 토큰을 상속하므로 반드시 남긴다. 다크 모드는 지금 어디에도 없고 이번 범위도 아니다.
- HR 모듈은 shadow root 안에서 `public/hr-workspace.css`로 그려진다. 그래서 문서 수준의 새 화면(로그인, 계정 관리, 감사, 채팅)은 HR 클래스(`.data-table`, `.settings-layout` 등)를 쓰지 못한다. `globals.css`의 공용 클래스(`.panel`, `.primary-button`, `.segment-control`(`:678-681`), `.erp-dialog`, `.toast`, `.modal-backdrop`)와 새 CSS만 쓴다.
- 새 사용자 문구는 모두 한국어다. 문구로 분기하지 않고 status·code로 분기한다(§6.3).
- 권한 없는 탭의 컴포넌트는 렌더하지 않는다. 보기 계정에게 편집 버튼을 숨기지 않고, 서버 403이 최종 방어다(Plan §5 리스크 '보기 권한 계정도 편집 버튼을 봄'의 결정).

### 5.1 Screen Layout

**셸(ready 상태)**

```
┌ ShellTopNav (app/shell-top-nav.tsx · .erp-top-nav · position:fixed · 높이 var(--erp-nav-height)=88px, ≤760px 66px(globals.css:354)) ─────┐
│ ◆ XDnode management │ ◎ 인사관리 │ ◫ 임금 계산 │ ◌ 메신저 (3) │ ▤ 감사 로그 │ ◈ 계정 관리 │ ··· spacer ··· │ [김OO ▾] │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  · 탭 버튼 = permittedTabs(tabs) 순서. 권한 없는 탭은 버튼도 패널도 없다
  · (3) = 채팅 안 읽음 배지(R5, .erp-alarm-button em 스타일 재사용, globals.css:470)
  · [김OO ▾] = 계정 칩: 이름 · 비밀번호 변경 · 로그아웃 (모바일은 fixed popover, 내비가 overflow:hidden이라서, globals.css:174)
<div className={def.shellClass}>        ← hr-module-shell | compensation-erp-shell | chat-module-shell | admin-module-shell
  {TAB_PANELS[active](ctx)}             ← padding-top: var(--erp-nav-height) (globals.css:35 규칙에 새 셸 클래스 2개를 더한다)
  <LocalCodexAssistant/>                ← hr·compensation 탭에만
</div>
```

**인증 화면(loading·bootstrap·login·password)**

```
┌──────────────────────────────── 화면 전체(#f4f4f5) ────────────────────────────────┐
│                          ◆ XDnode management (브랜드만)                              │
│                 ┌──────────────── .panel .auth-card (최대 420px) ───────────────┐    │
│                 │ 제목(로그인 / 첫 관리자 만들기 / 비밀번호 변경)                │    │
│                 │ 입력란들                                                      │    │
│                 │ 오류 줄(role="alert")                                         │    │
│                 │ [ primary 버튼 ]                                              │    │
│                 │ 보조 안내(평문 HTTP 안내, 잠금 남은 시간 등)                  │    │
│                 └───────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**메신저(R5, 3단)**

```
┌ 채널 목록(260px) ───────┬ 대화(가변) ─────────────────────────────┬ 스레드(360px, 열렸을 때) ┐
│ [검색 2~80자]           │ # 일반 · 주제 · 멤버 3 · [보관](관리자) │ 원글                     │
│ 채널                    │ ─ 이전 기록 더 보기(50개씩) ─            │ 답글 목록                │
│  # 일반          3 @1   │ 작성자 · 시각 · (수정됨)                 │ 답글 작성란              │
│  🔒 급여-TF       1     │ 본문(멘션 강조) · 첨부(이미지 미리보기)  │                          │
│ 다이렉트 메시지         │ 답글 2개 ›                               │                          │
│  김OO, 이OO             │ "삭제된 메시지입니다."                   │                          │
│ 참여 가능한 채널        │ ┌ 작성란(≤4000, 첨부 ≤10) [전송] ┐      │                          │
│ [+ 채널] [+ DM](편집)   │ └────────────────────────────────┘      │                          │
└─────────────────────────┴──────────────────────────────────────────┴──────────────────────────┘
```

### 5.2 User Flow

`useSession()`(`app/session-client.ts`)의 상태기계 `loading → bootstrap | login | password | ready`:

```
SSR·첫 렌더: AuthLoadingShell (data-auth-gate="loading", 브랜드만, 탭 DOM 없음, D1 미접근)
  └→ GET /api/me
       ├ 401 BOOTSTRAP_REQUIRED, bootstrapAllowedHere=true  → bootstrap: BootstrapScreen → POST /api/auth/bootstrap(201) → /api/me → ready
       ├ 401 BOOTSTRAP_REQUIRED, bootstrapAllowedHere=false → bootstrap(안내 전용): "서버 PC의 http://localhost:3000 에서 만들어 주세요"
       ├ 401 UNAUTHENTICATED                                → login: LoginScreen → POST /api/auth/login
       │                                                         ├ 200 mustChangePassword=true → password(강제)
       │                                                         ├ 200                         → /api/me → ready
       │                                                         ├ 401 INVALID_CREDENTIALS     → 폼 오류
       │                                                         └ 429 LOCKED                  → 남은 시간 카운트다운
       ├ 200 mustChangePassword=true                        → password(강제): PUT /api/auth/password → /api/me → ready
       └ 200                                                → ready
ready 진입:
  setStorageScope(accountId) → saved = localStorage[scopedKey("xdnode-active-tab")]
  active = resolveActiveTab(permittedTabs(tabs), saved)  (권한 밖이면 firstPermittedTab)
  firstPermittedTab이 null이면(모든 탭 none) "허용된 탭이 없습니다. 관리자에게 문의해 주세요." + 로그아웃
ready 중:
  window focus · visibilitychange · 60초마다(ME_REFRESH_INTERVAL_MS) → GET /api/me
    · 탭 권한이 줄면 resolveActiveTab 재적용(현재 탭이 사라지면 첫 허용 탭으로)
    · 401 → login, 200 mustChangePassword → password(강제)
  아무 API에서 401 UNAUTHENTICATED → login, 403 PASSWORD_CHANGE_REQUIRED → password(강제), 403 FORBIDDEN → 토스트 + /api/me
  계정 칩 → 비밀번호 변경(자발 모드, 취소 가능) / 로그아웃: POST /api/auth/logout → login
```

- `/incentive`는 같은 `useSession()`을 쓰는 `RequireTab tab="compensation"`으로 감싼다. `tabs.compensation === "none"`이면 계산기를 렌더하지 않고 "이 화면을 볼 권한이 없습니다."와 `/` 링크만 보여 준다. 서버 쪽은 계산기가 부르는 `/api/compensation/roster`가 403으로 막는다.
- 로그아웃하거나 세션이 401로 바뀌면 급여성 데이터 키(인센티브 딜·조정·지급 결과·제외 인원)는 현재 계정 범위 키까지 지운다. 화면 설정 키만 남기고, 다음 계정은 다른 범위 키를 쓴다(§5.5).

### 5.3 Component List

| Component | Location | Responsibility | 릴리스 |
|-----------|----------|----------------|--------|
| `Home` | `app/page.tsx` | `useSession()` 상태기계, `TAB_PANELS: Record<TabKey, (ctx) => ReactNode>` 전수 맵, `resolveActiveTab` 적용, 탭 저장, `useChatPoll`(R5) 실행 | R1 정리, R3 재작성 |
| `TAB_PANELS` | `app/page.tsx` | hr → `HRWorkspace`(hrNavigation 핸드셰이크 `:504`·`:544-554` 유지, `access` prop), compensation → `CompensationCalculator`, audit → `.admin-page` 안의 `AuditLogWorkspace`, admin → `ErpDialogProvider` 안의 `AdminAccountsWorkspace`, R5 chat → `ChatWorkspace`. `Record<TabKey,…>`라 빠지면 컴파일 오류 | R3 |
| `ShellTopNav`, `resolveActiveTab(tabs, saved)` | `app/shell-top-nav.tsx` | 레지스트리 기반 탭 버튼, 계정 칩, R5 안 읽음 배지. CSS와 서버 모듈을 import하지 않는다(shell-tabs 테스트가 그대로 렌더) | R3 |
| `LoginScreen`, `BootstrapScreen`, `PasswordChangeScreen`, `AuthLoadingShell`, `RequireTab` | `app/auth-screens.tsx` | 인증 화면 4종과 탭 게이트 | R3 |
| `useSession()` | `app/session-client.ts` | `/api/me` 상태기계, 재조회 타이머, `logout()` | R3 |
| `randomId`, `copyText`, `setStorageScope`, `scopedKey`, `clearScopedDataKeys` | `app/client-runtime.ts` | 비보안 컨텍스트 대체 함수와 계정 범위 저장소(로그아웃·401 때 데이터 키 삭제, §5.5) | R3 |
| `AdminAccountsWorkspace` | `app/admin-accounts-workspace.tsx` | 계정 관리 탭(§5.4) | R3(R4 백업 경고) |
| `AuditLogWorkspace` | `app/audit-log-workspace.tsx` | 감사 조회. R1에 `.admin-page` 컨테이너로 다시 마운트(유일한 import처 `data-governance-center.tsx` 삭제), `moduleLabel`(`:18`) 교체 | R1·R3 |
| `HRWorkspace` | `app/hr-workspace.tsx` | `access={{canEdit}}` 배너, 레거시 승인/반려, 설정 절 정리 | R1·R3 |
| `CompensationCalculator` | `app/compensation-calculator.tsx` | 모드 `wage`·`incentive`. 어시스턴트 모드 `'sales'` → `'incentive'`(`:621-623`) | R1·R3 |
| `IncentiveCalculator` | `app/incentive/incentive-calculator.tsx` | 정적 명부 제거(R1), roster 사용(R3) | R1·R3 |
| `LocalCodexAssistant` | `app/local-codex-assistant.tsx` | `?module=` 호출, 모드별 맥락 경로, 적용 버튼은 대상 탭 edit일 때만 | R1·R3 |
| `ChatWorkspace` | `app/chat-workspace.tsx`, `app/chat-workspace.css` | 3단 메신저. CSS는 `app/layout.tsx`에서 전역 import(`compensation-calculator.css`와 같은 방식, `:4`) | R5 |
| `useChatPoll()` | `app/chat-client.ts` | poll 주기·백오프·즉시 폴링, 배지·`document.title` | R5 |
| `highlightMentions` | `app/chat-mentions.ts` | `{text, mention}` 조각 배열(HTML 문자열 아님) | R5 |

### 5.4 Page UI Checklist

#### AuthLoadingShell (SSR `/`, `/incentive`)
- [ ] 루트 요소 `data-auth-gate="loading"`
- [ ] 브랜드 "XDnode management"만. 탭 라벨·HR 데이터·재무/영업 문자열 0건
- [ ] 레이아웃·페이지에서 D1을 읽지 않는다(`rendered-html`이 DB 없이 worker를 부른다)

#### LoginScreen
- [ ] 입력: 이메일(`type="email"`, `autocomplete="username"`, 자동 trim)
- [ ] 입력: 비밀번호(`type="password"`, `autocomplete="current-password"`)
- [ ] 버튼: "로그인"(요청 중 비활성)
- [ ] 오류 줄: `INVALID_CREDENTIALS` "이메일 또는 비밀번호가 올바르지 않습니다."
- [ ] 잠금: `LOCKED`면 `retryAfterSeconds` 카운트다운("n분 n초 뒤 다시 시도할 수 있습니다"), 그동안 버튼 비활성
- [ ] 안내: "비밀번호를 잊었으면 관리자에게 초기화를 요청해 주세요."(자가 재설정 없음)

#### BootstrapScreen
- [ ] `bootstrapAllowedHere=false`: 입력 없이 `BOOTSTRAP_LOCAL_ONLY` 문구만
- [ ] 입력: 이메일, 표시 이름(1~60자), 비밀번호, 비밀번호 확인, 인사기록 직원 ID(선택, 예: `gc.kim`). 이 시점에는 로그인 전이라 직원 목록을 불러오지 않는다
- [ ] 검증: 비밀번호 8~200자, 확인 일치, 직원 ID가 `acct_`로 시작하면 안 됨
- [ ] 버튼: "첫 관리자 만들기"
- [ ] 오류: `BOOTSTRAP_CLOSED`면 로그인 화면으로, 400이면 입력란 옆 문구

#### PasswordChangeScreen
- [ ] 모드: 강제(`mustChangePassword`, 취소 없음, 로그아웃 링크만) / 자발(계정 칩에서, "취소" 있음)
- [ ] 입력: 현재 비밀번호, 새 비밀번호, 새 비밀번호 확인
- [ ] 규칙 문구: "8자 이상 200자 이하, 현재 비밀번호와 달라야 합니다."
- [ ] 오류: `INVALID_CREDENTIALS` "현재 비밀번호가 올바르지 않습니다."(세션 유지), `LOCKED` 카운트다운
- [ ] 성공: "비밀번호를 바꿨습니다. 다른 기기의 로그인은 모두 끊겼습니다." 토스트

#### ShellTopNav
- [ ] 브랜드: "XDnode management"(현 `app/page.tsx:403` "XD NODE")
- [ ] 내비 `aria-label="업무 탭"`(현 `:408` "ERP 모듈")
- [ ] 탭 버튼: `permittedTabs(tabs)` 순서, glyph + label, 활성 탭 `aria-current="page"`
- [ ] 배지(R5): 메신저 탭에 안 읽음 수, 멘션이 있으면 강조색
- [ ] 계정 칩: 표시 이름, "비밀번호 변경", "로그아웃"(항상 보임, R-8)
- [ ] 제거: Clobe 동기화 배지, 오늘 업무, 데이터 통제, ApprovalCenter, 알림 서랍(`app/page.tsx:427-494`)

#### 빈 셸 (허용 탭 없음, `firstPermittedTab === null`)
- [ ] 문구 "허용된 탭이 없습니다. 관리자에게 문의해 주세요."
- [ ] 계정 칩의 로그아웃만 표시(탭 버튼 없음)
- [ ] 탭 DOM 0건(`shell-tabs`에서 모든 탭 none 입력으로 확인)

#### HR 탭 (`HRWorkspace`)
- [ ] 배너(hr=view): "보기 권한만 있습니다. 저장·승인·삭제는 거부됩니다." 버튼은 숨기지 않는다
- [ ] 레거시 대기 행(R1): PENDING 휴가, SUBMITTED 퇴직·인사발령에 "승인"/"반려" 버튼. 휴가는 기존 `decide()` 재사용, 퇴직·인사발령은 `PUT /api/hr/operations` `retirementDecision`·`personnelActionDecision`
- [ ] 문구 제거(R1): '상단 전자결재에서 처리'(`hr-workspace.tsx:2415` 부근), 퇴직 읽기 전용 배너, "승인 결재 요청"·autoApproved·approvalSubmitted·financeExpenseId 안내(`:2612-2644`), 뷰 3개의 결재 상태 라벨(`workforce-planning-view.tsx`, `recruitment-requisition-view.tsx`, `performance-management-view.tsx`)
- [ ] 토스트(R1): 인사발령 "인사발령을 반영했습니다.", 채용요청 "모집을 시작했습니다"
- [ ] 설정(SettingsView): R1에 '전자결재 규칙'만 지운다: `ApprovalSettings` 컴포넌트(`:4644-4747`), 호출 `:4637`, 탭 항목 `:4608`의 `["approvals", …]`, 라벨 `:4597`. R3에 '사용자·권한'(라벨 `:4595`, `:4608`의 permissions 항목, 본문 `:4615-4636`, `/api/hr/authorized-users`)을 지운다. 회사·HR·알림·데이터 절(`:4601-4614` 등)은 표시 전용으로 남긴다
- [ ] 이의제기 '수용' 버튼은 `RESOLVED`를 보낸다(R1, `performance-management-view.tsx:62-66`)
- [ ] 복사 버튼은 `copyText()`(R3, `hr-workspace.tsx:3346`, `hr-leave-view.tsx:88,214`)
- [ ] 면접 녹음: `window.isSecureContext`가 거짓이면 녹음 버튼 옆에 "면접 녹음은 서버 PC에서만 지원합니다." (`getUserMedia`, `hr-workspace.tsx:2144,2156,2213`)
- [ ] 어시스턴트는 `module=hr`, 맥락은 HR API(`/api/assistant?module=hr`, `:3398`)
- [ ] 명부는 `initialEmployees = []`(`:860`)로 시작해 `/api/hr/employee-records`로 채우고, 그동안 로딩 상태를 보인다(R1)

#### 임금 계산 탭 (`CompensationCalculator`)
- [ ] 모드 전환: 임금 계산 / 인센티브. 어시스턴트 모드는 `compensation` / `incentive`
- [ ] 데이터 경로(R3): `/api/compensation?period=&include=hr`, 인센티브 명부는 `/api/compensation/roster`
- [ ] 불러온 행의 '생년월일' 열은 빈 칸일 수 있다(§4.2.7)
- [ ] `LEGACY_PERIOD_LOCKED` 409는 문구 그대로 표시
- [ ] compensation=view: 저장·확정은 403 `FORBIDDEN` 토스트(배너는 두지 않는다)

#### `/incentive`
- [ ] `RequireTab tab="compensation"`. none이면 권한 안내와 `/` 링크만
- [ ] 계산기는 roster 응답이 `response.ok`가 아니면 오류를 표시한다(R1)
- [ ] 제목 "개인 인센티브 계산기 · XDnode management"(R2, 현 `app/incentive/layout.tsx:11`)

#### 감사 로그 탭 (관리자)
- [ ] 컨테이너 `.admin-page`(새 클래스, `.audit-log-*` 규칙 `globals.css:2308-2310`은 유지)
- [ ] module 필터: 전체, HR, 채용, 임금 계산, 메신저, 감사, 계정 관리, 인증, 그리고 과거 행용 운영·재무회계·영업·설정
- [ ] 행위자 이름: `COALESCE(인사기록 이름, 계정 표시 이름)`
- [ ] `after`의 비밀 키 가림은 서버(`audit-log/route.ts:23`)가 한다

#### 계정 관리 탭 (`AdminAccountsWorkspace`, 관리자)
- [ ] 안내 상단 고정: "HR 탭에는 급여관리가 포함됩니다."
- [ ] 표: 이름, 이메일, 연결 직원(없으면 "연결 없음"), 관리자 여부, 상태(활성/비활성/잠김 n분), 탭별 권한, 마지막 로그인, 활성 세션 수
- [ ] 탭 권한: `grantableTabs`마다 `.segment-control` 숨김/보기/편집(R3 hr·compensation, R5 chat). 관리자 행은 "모든 탭 편집"으로 표시하고 비활성
- [ ] 버튼 "계정 만들기" → 대화상자: 인사기록에서 고르기(`employees`, 이미 연결된 직원은 비활성) 또는 이름 직접 입력, 이메일, 관리자 여부, 초기 탭 권한
- [ ] 행 작업: 비밀번호 초기화, 잠금 해제, 비활성화/재활성화, 세션 모두 끊기, 연결 변경·해제, 표시 이름 변경, 관리자 지정/해제
- [ ] 임시 비밀번호 대화상자: 12자 값 1회 표시, "복사"(`copyText`), "이 창을 닫으면 다시 볼 수 없습니다."
- [ ] 오류: `LAST_ADMIN`, `DUPLICATE` 문구 그대로, 폼 되돌림
- [ ] 백업 경고(R4): `/api/admin/backups`의 `stale`이면 "마지막 백업 성공: yyyy-MM-dd HH:mm. 36시간 넘게 성공한 백업이 없습니다." 배너, 실패면 `lastRun.error`

#### 메신저 탭 (`ChatWorkspace`, R5)
- [ ] 채널 목록: 내 채널(안 읽음 수·멘션 수 배지, 보관 채널은 흐리게), DM·그룹 DM(참여자 이름으로 표시), 참여 가능한 공개 채널("참여")
- [ ] 버튼(chat=edit): "+ 채널"(이름 1~40, 공개/비공개, 주제 ≤200, 멤버), "+ DM"(1~7명 선택)
- [ ] 대화 머리: 이름, 주제, 멤버 수, owner·관리자에게 이름 변경·멤버 관리, 관리자에게 "보관"
- [ ] 대화 머리: 공개 채널 멤버에게 "나가기"(`POST /api/chat/channels` `LEAVE`)
- [ ] 채널을 열고 최신 메시지가 보이면 `PUT /api/chat/read-state`로 읽음 위치를 전진한다(FR-14)
- [ ] 기록: 최신 50개, 위로 스크롤하면 이전 50개
- [ ] 메시지: 작성자, 시각, 본문(멘션 강조, React 텍스트 노드만), "(수정됨)", 첨부(이미지 4종 미리보기, 나머지 파일 링크), "답글 n개", 본인 메시지에 수정·삭제
- [ ] 삭제된 메시지: "삭제된 메시지입니다."
- [ ] 작성란: 4000자 카운터, 첨부 ≤10개, 선택 시 `file.size > 26,214,400`이면 바로 거부, Enter 전송·Shift+Enter 줄바꿈, 전송마다 `clientKey = randomId()`
- [ ] chat=view: 작성란 비활성 + "보기 권한만 있습니다." (JOIN·LEAVE·읽음은 가능)
- [ ] 보관 채널: 작성란 비활성 + "보관된 대화에는 새 글을 쓰거나 바꿀 수 없습니다."
- [ ] 스레드 패널: 원글, 답글, 답글 작성란(답글의 답글 버튼 없음)
- [ ] 검색: 2~80자, 결과는 채널 이름과 함께
- [ ] 탭 제목: `(N) XDnode management`, N=0이면 `XDnode management`
- [ ] 링크 자동 생성은 `http:`·`https:`만, `rel="noopener noreferrer"`

### 5.5 브라우저 저장소 (`scopedKey(k) = k + "::" + accountId`)

- 대상 키
  - `xdnode-active-tab`(구 `xdnode-active-module`, `app/page.tsx:499`)
  - `xdnode-incentive-deals-v1`, `xdnode-incentive-adjustments-v1`, `xdnode-incentive-config-v1`, `xdnode-incentive-payroll-v1`, `xdnode-incentive-excluded-people-v1`, `xdnode-incentive-cable-exclusion-v2`(`app/incentive/incentive-calculator.tsx:44-49`)
  - `xdnode-compensation-preferences-v2`(`app/compensation-calculator.tsx:28`)와 같은 파일이 읽는 인센티브 키(`:405,421-422`)
  - `app/local-codex-assistant.tsx:207`의 키
  - 삭제: `xdnode-dismissed-alerts`(`app/page.tsx:250,287`, 알림 기능과 함께)
- 범위 키가 없으면 레거시 키를 1회 읽은 뒤 레거시 키를 지운다.
- 모든 접근은 try/catch로 감싼다.
- 목적은 공용 PC에서 계정끼리 작업 데이터가 섞이지 않게 하는 것이다. 범위 키만으로는 같은 Windows 프로필 사용자가 개발자 도구로 읽는 것을 막지 못한다(§7.11 R-11).
- 그래서 로그아웃·세션 401 전환 때 데이터 키(`xdnode-incentive-deals-v1`, `xdnode-incentive-adjustments-v1`, `xdnode-incentive-payroll-v1`, `xdnode-incentive-excluded-people-v1`)는 현재 계정 범위 키와 남은 레거시 키까지 지운다. 이 키들에는 사람별 딜 단가·매출·조정 금액과 인센티브 지급액이 들어 있다(`app/incentive/incentive-calculator.tsx:366-369,427`, `app/compensation-calculator.tsx:405,421-422`). 화면 설정 키(`xdnode-active-tab`, `xdnode-compensation-preferences-v2`, `xdnode-incentive-config-v1`, 마이그레이션 표지 `xdnode-incentive-cable-exclusion-v2`)만 남긴다. 삭제는 `app/client-runtime.ts`의 `clearScopedDataKeys()` 하나로 하고, `useSession().logout()`과 401 처리 경로가 부른다. 로그아웃하면 저장하지 않은 인센티브 입력이 사라진다는 점을 로그아웃 확인 문구에 적는다.

### 5.6 http LAN(비보안 컨텍스트) 대응

LAN PC는 `http://192.168.x.x:3000`으로 접속하므로 `crypto.randomUUID`, `navigator.clipboard`, `getUserMedia`를 쓸 수 없다.

| 대체 | 바꾸는 호출부 |
|------|---------------|
| `randomId()`(`getRandomValues` 기반) | `app/compensation-calculator.tsx:61,100,371-373`, `app/incentive/incentive-calculator.tsx:56,171,505`, `app/local-codex-assistant.tsx:413,539,554` |
| `copyText()`(clipboard가 안 되면 textarea + `execCommand("copy")`) | `app/hr-workspace.tsx:3346`, `app/hr-leave-view.tsx:88,214`, `app/local-codex-assistant.tsx:443` |
| 안내만 | 면접 녹음 `getUserMedia`(`app/hr-workspace.tsx:2144,2156,2213`): 서버 PC 전용. 필요하면 PC별 브라우저 정책 `OverrideSecurityRestrictionsOnInsecureOrigin` |

`removal-guards`(R3)가 `"use client"` 파일의 `crypto.randomUUID(` 0건을 단언한다.

### 5.7 스타일 배치

- `app/globals.css`는 규칙 단위로 정리한다(R1). 남기는 것: `:root` 토큰(`:281-307`), 탑 내비·탭·브랜드, `.segment-control`(`:678-681`), `.panel`·버튼·입력·토스트·모달, `.audit-log-*`(`:2308-2310`), `.erp-dialog`, local-codex, 로딩 마크. 약 82%(약 2,250줄)가 제거 대상이다(부록 A.5).
- 새 규칙: `.auth-screen`·`.auth-card`, `.admin-page`, `.admin-accounts-*`, `.chat-module-shell`·`.admin-module-shell`의 `padding-top: var(--erp-nav-height)`(`:35`의 선택자 목록에 추가). 채팅은 `app/chat-workspace.css`(R5).
- `public/hr-workspace.css`의 죽은 규칙(`:494-503`, `:510` approval-settings, `:929-954` master-impact)을 지운다(R1).
- `public/og.png`에는 'XD NODE ERP · FINANCE · SALES · HR'가 이미지로 박혀 있다. R2에서 새 이미지로 바꾼다.

---

## 6. Error Handling

### 6.1 Error Code Definition

- 새 라우트, 가드, worker, 로컬 peer 플러그인은 항상 `code`를 붙인다.
- 기존 HR 라우트의 `{ error }`는 그대로 둔다.
- 클라이언트는 **status와 code로 분기하고, 문구로는 분기하지 않는다.**

| code | status | 문구 | 어디서 | 클라이언트 처리 |
|---|---|---|---|---|
| `VALIDATION` | 400 | 라우트별(예: "요청 내용을 읽을 수 없습니다.", "답글에는 다시 답글을 달 수 없습니다.") | 새 라우트 전부 | 입력란 옆에 문구 표시 |
| `UNAUTHENTICATED` | 401 | 로그인이 필요합니다. | 가드, `/api/me`, `/api/auth/password` | 로그인 화면(`useSession` → `login`) |
| `BOOTSTRAP_REQUIRED` | 401 | 첫 관리자 계정을 먼저 만들어 주세요. (`bootstrapAllowedHere`) | `/api/me` | `bootstrap` 화면. 루프백이 아니면 "서버 PC의 http://localhost:3000 에서 만들어 주세요" 안내만 |
| `INVALID_CREDENTIALS` | 401 | 이메일 또는 비밀번호가 올바르지 않습니다. / (비밀번호 변경) 현재 비밀번호가 올바르지 않습니다. | login, password | 폼에 표시. 세션을 유지하고 로그인 화면으로 보내지 않는다 |
| `PASSWORD_CHANGE_REQUIRED` | 403 | 비밀번호를 먼저 변경해 주세요. | 가드(`/api/me`·password·logout 제외 전부) | `password` 화면(강제 모드) |
| `FORBIDDEN` | 403 | 이 작업을 수행할 권한이 없습니다. | 가드(`canAccess` 거부), 채팅 owner·작성자 검사 | 토스트. `/api/me`를 다시 불러 탭 목록 갱신 |
| `CROSS_ORIGIN` | 403 | 다른 사이트에서 보낸 요청은 처리하지 않습니다. | worker(비GET `/api/*`, 핸들러 전), 가드, 인증 라우트 | 표시만(정상 사용에서는 생기지 않음) |
| `BOOTSTRAP_LOCAL_ONLY` | 403 | 첫 관리자 계정은 서버 PC의 http://localhost:3000 에서만 만들 수 있습니다. | 로컬 peer 플러그인(비루프백), bootstrap 라우트 | 안내 문구 |
| `NOT_FOUND` | 404 | (채팅) 대화를 찾을 수 없습니다. / (관리) 계정을 찾을 수 없습니다. | 채팅 비멤버·없는 대상, admin 대상 없음 | 목록으로 돌아가고 채널 목록 새로고침 |
| `BOOTSTRAP_CLOSED` | 409 | 이미 계정이 있어 첫 관리자 만들기가 닫혔습니다. | bootstrap | 로그인 화면 |
| `LAST_ADMIN` | 409 | 마지막 관리자는 비활성화하거나 권한을 낮출 수 없습니다. | admin/accounts | 폼 되돌림 |
| `CONFLICT` | 409 | 다른 사용자가 먼저 상태를 바꿨습니다. 새로고침해 주세요. | HR 즉시 반영(`meta.changes = 0`), 새 라우트의 조건부 UPDATE | 데이터 다시 읽기 |
| `DUPLICATE` | 409 | 이미 등록된 이메일입니다. / 이미 다른 계정에 연결된 직원입니다. / 같은 이름의 채널이 이미 있습니다. | admin CREATE·UPDATE_PROFILE, 채널 CREATE·RENAME | 입력란 표시 |
| `CHANNEL_ARCHIVED` | 409 | 보관된 대화에는 새 글을 쓰거나 바꿀 수 없습니다. | 채팅 쓰기 경로 | 작성란 비활성화 |
| `LEGACY_PERIOD_LOCKED` | 409 | 영업 인센티브가 반영된 과거 급여월은 다시 확정할 수 없습니다. / 재무에서 지급·전기된 과거 급여월은 다시 열 수 없습니다. | compensation CONFIRM, payroll 재오픈 | 표시만 |
| `LENGTH_REQUIRED` | 411 | 파일 크기를 확인할 수 없습니다. | 채팅 첨부 PUT | 다시 올리기 |
| `PAYLOAD_TOO_LARGE` | 413 | 파일은 25MB까지 올릴 수 있습니다. | 채팅 첨부 PUT(본문 읽기 전, 읽은 뒤 재확인) | 클라이언트도 `file.size`로 미리 막는다 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 올릴 수 없는 파일 형식입니다. | 채팅 첨부 PUT, bootstrap(비JSON) | 허용 형식 안내 |
| `LOCKED` | 429 | 로그인에 5번 실패해 5분 동안 잠겼습니다. 잠시 후 다시 시도해 주세요. (`Retry-After` 헤더, `retryAfterSeconds`) | login(LAN peer만, D21)·password(모든 peer) | 남은 시간 표시, 버튼 비활성화 |

- **423은 쓰지 않는다.**
  - 잠금은 429 `LOCKED` + `Retry-After`다.
  - 잠기는 것은 리소스가 아니라 로그인 시도 빈도다. 429에는 `Retry-After`가 표준으로 붙지만, 423(WebDAV Locked)에는 재시도 시각 규약이 없다.
  - R4 헬스체크와 하니스도 429를 기준으로 한다.
- 기존 라우트가 그대로 내는 status. code가 없으면 클라이언트는 status와 `error` 문구를 그대로 보여 준다.
  - HR 라우트의 400·404·409·413·415는 `{ error }`만 싣는다(예: documents 25MB 413과 형식 415, `:128-130`).
  - documents 다운로드 404는 평문 "문서를 찾을 수 없습니다."다(`:51`).
  - assistant: 413 "요청이 너무 큽니다."(`:37`), 브리지 상태 코드 전달(400·413·429·502, `:75-79`), 502 "AI 어시스턴트 다리에 연결하지 못했습니다…"(`:66-69`)
- 404
  - 없어진 경로(R1·R3 목록)는 프레임워크 404다. JSON이 아니며 `rendered-html`은 status만 단언한다.
  - 비루프백의 `/cdn-cgi/*`·`/__debug*`는 플러그인이 **본문 없는 404**로 끊는다.
- 500: 예상하지 못한 예외는 잡지 않는다. 프레임워크 500이 나가고, 응답에 스택은 싣지 않는다. 채팅 poll은 5xx에 백오프 `[5000, 10000, 30000]`을 적용한다.
- 존재 노출 한계(수용)
  - 없는 이메일과 비활성 계정은 항상 401 `INVALID_CREDENTIALS`이고 잠기지 않는다. 그래서 LAN에서 5회 뒤 429가 나오면 그 계정이 있다는 뜻이 된다(§7.11 R-7).
  - 6명 사내망 규모라 이 한계를 수용하고 runbook에 적는다.
  - 비공개 채널·DM은 비멤버에게 403이 아닌 404로 답해 존재를 숨긴다.

**감사 뷰어 module 필터 허용 목록**(`app/api/audit-log/route.ts:22` 교체): `ALL, hr, recruitment, compensation, chat, audit, admin, auth, operations, finance, sales, settings`. 뒤의 네 값은 과거 행 조회용이다. 이름은 `LEFT JOIN auth_accounts ac ON ac.id=a.actor_user_id`로 붙이고 `COALESCE(e.name, ac.display_name)`로 고른다.

### 6.2 Error Response Format

```json
{ "error": "<한국어 문장>", "code": "<UPPER_SNAKE>", "...details": "선택" }
```
- `error`는 항상 있다. 사용자에게 그대로 보여 줄 수 있는 한국어 문장이다. 내부 식별자, SQL, 경로, 스택은 넣지 않는다.
- `code`는 새 라우트·가드·worker·플러그인에서 항상 붙는다. 값은 §6.1 표에 있는 것만 쓴다.
- details에는 code별로 정해진 키만 쓴다.

| code | details |
|---|---|
| `BOOTSTRAP_REQUIRED` | `bootstrapAllowedHere: boolean` |
| `LOCKED` | `retryAfterSeconds: number` (+ 헤더 `Retry-After`) |
| `VALIDATION` | `field?: string`(폼 입력란 이름) |
| `LEGACY_PERIOD_LOCKED` | `period: "YYYY-MM"` |

- 헤더
  - 오류 응답에도 worker의 `Cache-Control: no-store`와 보안 헤더 3종이 붙는다.
  - 401·403에는 `WWW-Authenticate`를 붙이지 않는다. 브라우저 기본 인증 창이 뜨지 않게 하기 위해서다.
- 예

```json
403 { "error": "비밀번호를 먼저 변경해 주세요.", "code": "PASSWORD_CHANGE_REQUIRED" }
429 { "error": "로그인에 5번 실패해 5분 동안 잠겼습니다. 잠시 후 다시 시도해 주세요.", "code": "LOCKED", "retryAfterSeconds": 212 }
404 { "error": "대화를 찾을 수 없습니다.", "code": "NOT_FOUND" }
409 { "error": "영업 인센티브가 반영된 과거 급여월은 다시 확정할 수 없습니다.", "code": "LEGACY_PERIOD_LOCKED", "period": "2026-05" }
```

### 6.3 클라이언트 분기 규칙 (`app/session-client.ts`, `app/chat-client.ts`)

- 로그인 화면으로 보내는 경우는 401이면서 `code === "UNAUTHENTICATED"`일 때뿐이다. 401 `INVALID_CREDENTIALS`는 폼 오류로 처리한다.
- 403 `PASSWORD_CHANGE_REQUIRED`는 어느 탭에서 받든 강제 비밀번호 화면으로 보낸다.
- 403 `FORBIDDEN`
  - 화면은 유지하고 토스트를 띄운 뒤 `/api/me`를 다시 부른다.
  - 권한이 줄었으면 `resolveActiveTab`이 첫 허용 탭으로 옮긴다.
- HR 보기 권한 계정에게도 편집 버튼은 숨기지 않는다. 배너 "보기 권한만 있습니다. 저장·승인·삭제는 거부됩니다."를 띄우고, 서버의 403을 최종 방어로 둔다.
- 409 `CONFLICT`와 기존 409는 대상 데이터를 다시 읽는다.
- 429 `LOCKED`는 `retryAfterSeconds`로 카운트다운을 보여 준다.
- 네트워크 오류·5xx
  - 채팅은 백오프한다.
  - 그 밖에는 "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요."를 띄운다.

---

## 7. Security Considerations

### 7.1 위협 모델과 신뢰 경계

- **자산**
  - HR PII와 급여(인사기록, 급여 run, 녹음·문서)
  - 비밀번호 해시와 세션
  - 채팅 본문과 첨부
  - 감사 로그
  - `.env.local`의 비밀값(Cloudflare 토큰)
  - 운영 D1·R2 파일과 백업
- **공격자**
  - 인증하지 않은 LAN 사용자
  - 권한이 낮은 LAN 계정(탭 우회 시도)
  - 같은 망의 도청자
  - 같은 호스트의 다른 포트 페이지(견적 툴 :8765)
  - 사용자 브라우저를 경유하는 외부 웹페이지(CSRF, DNS rebinding, clickjacking)
  - 서버 PC에 물리적으로 접근하는 사람
  - 어시스턴트 맥락에 섞인 프롬프트 주입
- **범위 밖**
  - 서버 PC에서 로컬 코드를 실행할 수 있는 공격자. 관리자 계정 탈취와 같은 수준이다.
  - 사외 접속(D10). 방화벽이 LocalSubnet 밖을 막는다.

| 경계 | 무엇을 믿는가 | 통제 |
|------|---------------|------|
| B1 TCP → Node | `req.socket.remoteAddress`만 | local-peer 플러그인(§7.6), Vite hostValidation |
| B2 Node → workerd | 플러그인이 지우고 다시 쓴 `x-xdm-peer` 하나 | `peerOf()`는 헤더가 없거나 값이 여러 개면 비루프백으로 본다 |
| B3 Worker → 라우트 | Origin/Host 비교로 교차 출처 비GET을 차단한다 | `crossOriginWriteViolation`, 전역 헤더(§7.3·§7.7) |
| B4 라우트 가드 | DB의 세션 행과 `tabs_json` | `authorizeErpRequest`, `canAccess`(fail closed) |
| B5 workerd → 브리지 | 루프백에서 Origin 없이 오는 서버 대 서버 호출 | 브리지의 Origin·Host 검사(R0) |
| B6 브리지 → Claude CLI | 받은 JSON 맥락만 | `--tools ""`, 빈 임시 cwd(R0) |

### 7.2 세션 쿠키 (평문 HTTP LAN)

상수(`app/auth-session.ts`)

| 상수 | 값 |
|---|---|
| `SESSION_COOKIE` | `"xdm_session"` |
| `SESSION_TOKEN_BYTES` | 32(`getRandomValues` → base64url, 43자) |
| `SESSION_TTL_MS` | 2_592_000_000(30일, 고정) |
| `SESSION_TOUCH_INTERVAL_MS` | 3_600_000 |
| `ACCOUNT_ID_PREFIX` | `"acct_"` |
| `PEER_HEADER` | `"x-xdm-peer"` |
| `LOOPBACK_ADDRESSES` | `["127.0.0.1", "::1"]` |

**발급**
- 로그인과 부트스트랩에서만 서버가 발급한다. 쿠키는 `xdm_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`이다. 삭제할 때는 `xdm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`이다.
- Set-Cookie는 Response에 직접 싣는다. `cookies()`는 쓰지 않는다.
- `token`은 `getRandomValues` 32바이트를 base64url로 만든 43자다.
- DB의 `auth_sessions.id`에는 `hex(SHA-256(token))`만 둔다.
  - 조회를 해시로 하므로 인덱스 조회 시간 차로 토큰이 새지 않는다.
  - D1 파일이나 백업이 새도 쓸 수 있는 토큰은 나오지 않는다.

**속성을 이렇게 둔 이유**
- `HttpOnly`: JS가 쿠키를 읽지 못한다. XSS가 생겨도 토큰을 빼 가지 못한다.
- `SameSite=Lax`: 교차 사이트의 하위 리소스 요청과 POST에는 쿠키가 실리지 않는다. 그러나 IP 호스트는 포트가 달라도 same-site로 판정되므로 :8765 페이지의 요청에는 실린다. 그래서 CSRF를 §7.3에서 따로 막는다.
- `Secure`와 `__Host-`는 쓰지 않는다. http에서는 브라우저가 Secure 쿠키를 버리고, `__Host-`는 Secure를 요구한다.
- `Domain`이 없는 host-only 쿠키다. `localhost`, `127.0.0.1`, LAN IP는 서로 다른 쿠키 저장소를 쓴다.

**수명**
- `expires_at = created_at + 30일`로 고정한다. 사용할 때마다 늘리지 않는다.
- `last_seen_at`은 1시간에 한 번만 쓴다.
- 로그인할 때마다 새 세션을 만들고, 다른 세션은 유지한다.
- 서버가 발급하지 않은 토큰은 DB 행이 없어 401이다. 그래서 세션 고정 공격은 성립하지 않는다.

**폐기**(`revoked_reason`)
- `LOGOUT`: 현재 세션을 폐기하고 쿠키를 `Max-Age=0`으로 지운다.
- `PASSWORD_CHANGED`: 다른 세션을 모두 폐기한다.
- `PASSWORD_RESET`·`DEACTIVATED`·`ADMIN_REVOKE`: 그 계정의 세션을 모두 폐기한다.
- 권한과 활성 여부는 요청마다 DB에서 읽고 캐시하지 않는다. 그래서 폐기와 권한 변경은 다음 요청부터 바로 적용된다.

**평문 전송 대책**(D10에 따라 수용)
- 3000번 포트는 Private 프로필·LocalSubnet에만 연다. 게스트망과 공용 Wi-Fi에는 연결하지 않는다.
- 계정 관리 화면에 활성 세션 수와 `REVOKE_SESSIONS`를 둔다.
- 세션에 `peer`와 `user_agent`를 남겨 탈취를 추적할 수 있게 한다.
- 로그아웃 버튼은 항상 보이게 둔다.

**검증**
- `auth-session`: 30일 만료(모의 시계), 폐기 사유별 401, 비밀번호 변경 뒤 다른 세션 401.
- worker 조립부 `new Headers(response.headers)`(`worker/index.ts:44`)를 거친 뒤에도 Set-Cookie 여러 개가 남는지 확인한다.
- R3 스모크: workerd에서 로그인 1회.

### 7.3 CSRF와 교차 출처

**SameSite=Lax만으로 부족한 이유**
- IP 호스트에서는 :8765 견적 툴이 same-site로 판정된다.
- vinext의 Origin 검사는 dev에서만 돈다(`vinext/dist/server/app-rsc-handler.js:126-129`, `NODE_ENV !== "production"`).
- 빌드에는 `'use server'` 모듈이 없어 server-action 처리기가 생성되지 않는다(`vinext/dist/index.js:799-805`). 그 안에 있던 CSRF 검사와 본문 상한도 함께 없다.
- 로그인과 부트스트랩은 쿠키 없이 들어오는 요청이라 SameSite가 지켜 주지 못한다.

그래서 검사를 두 층에 둔다(`app/request-guard.ts`, 순수 모듈).

| 층 | 함수 | 적용 | 규칙 | 이유 |
|----|------|------|------|------|
| Worker | `crossOriginWriteViolation(method, headers)` | `/api/*`의 GET·HEAD가 아닌 요청 전부(로그인·부트스트랩·로그아웃·비밀번호 포함). 핸들러와 본문 읽기보다 먼저 | Origin이 있으면 `"null"`이 아니고 `new URL(Origin).host === Host`여야 통과한다. Origin이 없으면 `Sec-Fetch-Site === "same-origin"`일 때만 통과한다. 둘 다 없으면 403 `CROSS_ORIGIN` | 메서드를 아는 곳이 여기뿐이다. DB 없이 거부하므로 `rendered-html`이 DB 없는 worker로 검증할 수 있다 |
| 가드·인증 라우트 | `crossSiteViolation(headers)` | `authorizeErpRequest` 3단계, `/api/me`, `/api/auth/*` | 메서드와 무관하다. Origin이 있는데 `null`이거나 host가 다르면 위반이다. `Sec-Fetch-Site ∈ {cross-site, same-site}`이고 `Sec-Fetch-Mode ≠ navigate`여도 위반이다 | `authorizeErpRequest`는 시그니처상 메서드를 모른다. 하니스는 라우트를 직접 부르므로, SC-10 동작 테스트가 검증하는 층은 이것이다 |

**요청별 판정**
- 앱 자신의 `fetch` PUT/POST: same-origin 요청은 tainting이 basic이라 Origin이 referrer 정책에 따라 직렬화된다. 앱의 `Referrer-Policy: same-origin`은 same-origin 요청의 Origin을 그대로 둔다. Host와 같으므로 통과한다.
- 외부 사이트의 form POST나 `no-cors` fetch: Origin이 다른 host이거나, 상대 페이지가 no-referrer면 `null`이다. 둘 다 403이다.
- :8765 페이지: Origin은 `http://<ip>:8765`, Host는 `<ip>:3000`이다. host:port가 달라 403이다.
- curl이나 스크립트: Origin이 없으면 403이다. `xdm-login.mjs`는 `Origin: <base>`를 붙인다.
- DNS rebinding
  - 공격 도메인을 서버 IP로 바꾸면 Origin과 Host가 둘 다 공격 도메인이 되어 위 규칙을 통과한다.
  - 이것은 Vite hostValidation이 막는다(preview `vite/dist/node/chunks/node.js:33785`, dev `:26317`). `allowedHosts` 기본값 `[]`는 IP와 `localhost`·`*.localhost`만 허용한다(`:16073-16086`).
  - 이 middleware는 플러그인 훅보다 먼저 등록되므로(`:33791`) 부트스트랩까지 보호한다.
  - 그래서 `server.allowedHosts`·`preview.allowedHosts`에 PC 이름을 **추가하지 않는다**. 접속 주소는 IP로 안내한다(Plan NFR).
- 교차 출처 preflight(OPTIONS): Vite cors middleware(기본 origin 허용 목록은 localhost 정규식, credentials 없음)가 먼저 답할 수 있다. 그래도 뒤따르는 실제 요청은 Worker 층에서 403이다.
- Fetch Metadata: http LAN은 비보안 컨텍스트라 `Sec-Fetch-*`가 오지 않는다. 서버 PC의 `http://localhost`에서는 온다. 그래서 localhost에서는 :8765 페이지의 GET도 `same-site`로 판정돼 막힌다.
- **Clickjacking**: `X-Frame-Options: DENY`로 막는다. 앱에는 iframe·embed·`window.open` 사용이 없으므로(2026-09-23 grep 0건) 이 헤더 때문에 깨지는 기능이 없다.

**한계와 처리**
- 부수효과가 있는 GET이 두 곳 있다. `employee-records` GET의 `applyDue*`(`app/api/hr/employee-records/route.ts:83-85`)와 compensation GET의 `applyDueRetirements`다.
- 이 GET들도 위 규칙을 적용받는다. 하지만 http LAN에서는 GET에 Origin과 Sec-Fetch가 오지 않는다. 그래서 LAN IP로 접속한 브라우저를 노린 교차 사이트 GET은 구분할 수 없다.
- 두 동작은 멱등인 도래일 반영이고, 공격자는 응답을 읽을 수 없다(CORS 없음, `nosniff`). 그래서 GET에 그대로 두고, 이 한계를 runbook에 적는다. Plan M3의 'POST로 옮긴다' 선택지는 쓰지 않는다.

**검증**
- `auth-session`·`tab-permissions`: `Origin: http://evil.invalid`, `Origin: null`, `Sec-Fetch-Site: cross-site`를 붙인 인증 라우트·가드 경로가 모두 403 `CROSS_ORIGIN`이다.
- `rendered-html`: 교차 출처 `POST /api/auth/login`, 그리고 `Origin`·`Sec-Fetch-Site`가 모두 없는 `POST /api/auth/login`·`PUT /api/hr/payroll`이 worker에서 403이다(§8.3 #8). 가드 층은 두 헤더가 모두 없으면 통과시키므로 이 경로는 worker 층 테스트로만 잡힌다.
- `access-policy`: `crossOriginWriteViolation` 판정표에 '헤더 없음 → 위반' 행을 둔다.

### 7.4 로그인 잠금 (D15 + D21)

상수: `LOGIN_MAX_FAILURES = 5`, `LOGIN_LOCK_MS = 300_000`.

**LAN(비루프백) 예약: 검증 전에 시도를 먼저 예약한다**

```sql
UPDATE auth_accounts SET
  failed_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= :now THEN 1 ELSE failed_attempts + 1 END,
  locked_until = CASE
    WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= :now THEN 1 ELSE failed_attempts + 1 END) >= 5 THEN :now + 300000
    WHEN locked_until IS NOT NULL AND locked_until <= :now THEN NULL
    ELSE locked_until END,
  updated_at = :now
WHERE id = :id AND (locked_until IS NULL OR locked_until <= :now)
RETURNING failed_attempts, locked_until
```

- **원자성**
  - 잠금 조건이 UPDATE의 WHERE 안에 있다. D1은 문장 하나를 원자적으로 실행하고, 로컬 D1은 단일 Durable Object라 문장이 직렬화된다.
  - 그래서 오답 20건을 동시에 보내도 `changes === 1`이 되는 예약은 5건뿐이다. 5번째 예약이 `locked_until`을 건다.
  - 나머지는 검증 없이 429 `LOCKED`(`Retry-After`, `retryAfterSeconds`)를 받고, 감사에 `LOGIN_BLOCKED`가 남는다. 잠금 중에는 정답도 429다.
  - `RETURNING`으로 새 값을 함께 읽는다. 행이 없으면 `changes === 0`과 같다. `failed_attempts`가 정확히 5가 된 요청이 검증에 실패하면 `ACCOUNT_LOCKED`를 남긴다(중복 방지).
- **만료와 성공**
  - 잠금이 만료된 뒤 첫 예약이 카운터를 1로 되돌리고 잠금을 푼다.
  - 로그인에 성공하면 `failed_attempts=0, locked_until=NULL, last_login_at=:now`로 둔다.
- **없는 이메일과 비활성 계정**
  - `getDummyHash()`로 같은 비용의 검증을 하고 같은 401을 준다.
  - `actor_email`에는 시도한 이메일(소문자, 200자)을 남기고, actor는 `'anonymous'`로 둔다.
- **비밀번호 변경**: `PUT /api/auth/password`의 현재 비밀번호 검증도 같은 예약을 쓴다. 이때는 peer와 관계없이 항상 잠금 `WHERE`가 붙은 예약이다(D21 면제 없음). 세션을 훔쳐도 현재 비밀번호를 무차별 대입할 수 없다.

**서버 PC(루프백) 예외: D21, D15의 유일한 예외**
- 적용 범위는 `POST /api/auth/login` 하나다. `PUT /api/auth/password`의 현재 비밀번호 검증에는 적용하지 않는다.
- `peerOf(h).loopback`이면 같은 SET을 `WHERE id = :id`로만 실행한다. 실패 횟수는 세지만 잠금은 검사하지 않고, 항상 검증한다.
- 서버 PC에서 로그인에 성공하면 LAN에서 걸린 잠금도 풀린다.
- 서버 PC에서의 실패도 LAN 잠금을 걸거나 연장한다.
- 이 예외는 모든 계정에 적용된다. 목적은 관리자가 1명일 때 LAN 사용자가 5분마다 다시 잠그는 DoS를 서버 PC에서 풀 수 있게 하는 것이다.

**루프백 판정을 위조할 수 없는 이유**
1. 판정 근거는 Node가 찍은 `x-xdm-peer` 하나다. 값은 정규화한 `req.socket.remoteAddress`다(`::ffff:127.0.0.1` → `127.0.0.1`). `LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"]`이다.
2. 클라이언트가 보낸 `x-xdm-peer`는 대소문자와 관계없이 `req.headers`와 `req.rawHeaders` 양쪽에서 지운다. Worker의 Request는 `rawHeaders`로 만들어지기 때문이다(`@cloudflare/vite-plugin/dist/index.mjs:1550-1557` `createHeaders`).
3. 플러그인 middleware는 디스패처보다 먼저 돈다.
   - preview의 디스패처는 `configurePreviewServer` 훅 본문에서 등록된다(`index.mjs:53310-53312`).
   - dev의 디스패처는 post-middleware다(`:53054`).
   - `enforce:"pre"`와 배열 첫 항목을 함께 써서, 정렬 기준이 바뀌어도 앞에 서게 한다.
4. `upgrade` 요청은 middleware를 거치지 않는다. cloudflare의 `handleWebSocket`은 `rawHeaders`를 그대로 `dispatchFetch`한다(`:52892-52908`). 그래서 리스너 전체를 감싸고, 비루프백 upgrade는 소켓을 끊는다(§7.6).
5. `peerOf()`는 헤더가 없거나 `,`가 들어 있으면(여러 값이 합쳐진 경우) 비루프백으로 본다.
6. `Host`·`Origin`·`CF-Connecting-IP`는 판정에 쓰지 않는다. Miniflare는 이미 있는 `CF-Connecting-IP`를 덮어쓰지 않는다.
7. 플러그인이 실리지 않는 런타임(`wrangler dev`, `vinext start`)은 지원하지 않는다. `vinext start`는 D1·R2가 없어 어차피 모든 API가 500이다(`vinext/dist/server/prod-server.js:675`).
8. **운영 규칙(추가)**: 서버 PC에 리버스 프록시나 포트 포워딩(`netsh interface portproxy` 등)을 두지 않는다. 두면 LAN 요청이 루프백으로 보인다. R3 스모크에서 `netsh interface portproxy show all`이 비어 있는지 확인한다.

- 루프백으로 인정되는 것은 서버 PC에서 `http://localhost:3000`이나 `127.0.0.1`로 연 브라우저뿐이다. 서버 PC에서도 LAN IP로 열면 비루프백이다.
- 복구 수단은 세 가지다.
  - D21 루프백 로그인.
  - 계정 관리의 `UNLOCK`.
  - 앱을 멈춘 상태에서 돌리는 `scripts/reset-admin-password.mjs`(§11.5.6). 잠금 해제, 임시 비밀번호 발급, `must_change_password=1`, 세션 전부 폐기를 하고 SYSTEM 감사 `ACCOUNT_PASSWORD_RESET_OFFLINE`을 남긴다.

**검증**(`auth-session`, SC-10)
- LAN peer에서 오답 20건을 `Promise.all`로 보내면 검증 호출은 5회 이하다.
- 잠금 중에는 정답도 429다.
- 루프백 peer는 잠금 중에도 정답이면 200이고, 실패 횟수는 올라간다.
- 모의 시계로 5분 뒤 잠금이 풀린다.
- 감사: `LOGIN_FAILED{peer, lockExempt:true}`, `ACCOUNT_LOCKED`, `LOGIN_BLOCKED`.
- PBKDF2 반복 수가 100,000 이하인지 단언한다(`access-policy`).

**비밀번호 규칙**(`app/auth-password.ts`)

| 상수 | 값 | 비고 |
|---|---|---|
| `PBKDF2_ITERATIONS` | 100_000 | workerd 상한. 넘으면 workerd에서 'Pbkdf2 failed'가 나지만 Node 하니스는 통과하므로 단언 테스트를 둔다 |
| `PBKDF2_HASH` / `PBKDF2_SALT_BYTES` / `PBKDF2_KEY_BYTES` | `"SHA-256"` / 16 / 32 | 형식 `pbkdf2_sha256$100000$<salt b64url>$<hash b64url>` |
| `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` | 8 / 200 | 새 비밀번호는 현재 비밀번호와 달라야 한다 |
| `TEMP_PASSWORD_LENGTH` | 12 | 알파벳 `ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789`, 거부 표본추출 |

- 검증할 때 저장된 iter가 1..100000 밖이면 false다. 비교는 손으로 쓴 XOR 루프로 상수 시간에 한다(Node에 `subtle.timingSafeEqual`이 없다).
- `getDummyHash()`는 처음 쓸 때 1회 계산한다.
- `reset-admin-password.mjs`는 같은 형식을 Node `crypto.webcrypto`로 다시 구현한다. `access-policy` 테스트가 두 파일의 iter 상수가 같은지 단언한다.

### 7.5 첫 관리자 부트스트랩

**전제**: R3 운영 전환 5~6단계에서 방화벽 3000 규칙을 끈 채, 서버 PC 브라우저의 `http://localhost:3000`에서 만든다. 점검 인스턴스는 `http://localhost:3001`에서 따로 만든다.

1. SPA가 `GET /api/me`를 부른다. 계정이 0개면 401 `BOOTSTRAP_REQUIRED`와 `bootstrapAllowedHere = peerOf(h).loopback`이 온다.
   - 참이면 `BootstrapScreen`을 보여 준다.
   - 거짓이면 `BOOTSTRAP_LOCAL_ONLY` 안내만 보여 준다.
2. `POST /api/auth/bootstrap {email, displayName, password, employeeId?}`는 다음 층을 차례로 거친다(요청·응답 상세는 §4.2.5).
   - Node 층: 비루프백이면 플러그인이 403 JSON `BOOTSTRAP_LOCAL_ONLY`로 끝낸다. Worker에 닿지 않는다.
   - Worker 층: 교차 출처 비GET이면 403이다.
   - 라우트 층
     - `platformSchemaReady`와 `crossSiteViolation`을 거친다.
     - `peerOf(h).loopback`이 아니면 403이다. 경로 차단이 우회돼도 여기서 막힌다.
     - `Upgrade` 헤더가 있으면 거부하고, `Content-Type: application/json`만 받는다.
     - 비밀번호 정책(8~200자)을 검사한다.
     - `employeeId`는 `hr_employee_records`에 있어야 하고 `acct_`로 시작하면 안 된다.
   - DB 층: 한 batch로 원자적으로 처리한다(`INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM auth_accounts)` + 같은 batch의 세션 INSERT). `changes[0] !== 1`이면 409 `BOOTSTRAP_CLOSED`다. 세션은 계정 행이 실제로 들어갔을 때만 생긴다. 두 요청이 동시에 와도 201은 하나뿐이다.
   - 성공하면 201과 Set-Cookie를 돌려주고, 감사에 `BOOTSTRAP_ADMIN_CREATED{peer}`를 남긴다.
3. 계정이 하나라도 생기면 이 경로는 영구히 닫힌다. 관리자는 `tabs_json '{}'`이지만 `resolveTabs`가 모든 탭을 `edit`로 푼다. 이후 계정은 계정 관리 탭에서만 만든다.

**검증**(`auth-session`, SC-10, FR-07)
- LAN peer(`192.0.2.10`)가 `Host: localhost`, `x-xdm-peer: 127.0.0.1`, `CF-Connecting-IP: 127.0.0.1`을 위조해도 403이다.
- 동시 요청 2건 중 1건만 201이다.
- 계정이 있으면 409다.
- R3 스모크: 점검 PC에서 위조 헤더를 붙인 부트스트랩 POST가 403이다.

### 7.6 local-peer 플러그인 (`build/local-peer-vite-plugin.ts`)

**등록**
- `localPeerPlugin(): Plugin`(`name: "xdm-local-peer"`, `enforce: "pre"`)을 `vite.config.ts` plugins 배열의 첫 항목에 둔다: `[localPeerPlugin(), vinext(), sites(), cloudflare({ …, inspectorPort:false })]`(`:80-87`).
- `configureServer`·`configurePreviewServer` 훅 **본문**에서 middleware 1개를 등록한다. 훅이 반환하는 post 함수에서 등록하면 디스패처보다 늦다.
- 테스트용 순수 export: `normalizePeerAddress`, `isLoopbackAddress`, `stampPeer`, `gatePeerRequest`, `allowUpgrade`.

**헤더 제거와 기록**: `req.headers`는 `rawHeaders`에서 늦게 계산되므로 둘 다 바꾼다.

```ts
export function stampPeer(req: IncomingMessage): string {
  const address = normalizePeerAddress(req.socket.remoteAddress ?? "");      // 없으면 "" → 비루프백
  for (const name of Object.keys(req.headers)) if (name.toLowerCase() === PEER_HEADER) delete req.headers[name];
  const raw = req.rawHeaders, kept: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() !== PEER_HEADER) kept.push(raw[i], raw[i + 1]);
  kept.push(PEER_HEADER, address);
  raw.splice(0, raw.length, ...kept);            // 같은 배열 객체를 바꾼다. createHeaders가 req.rawHeaders를 다시 읽는다
  req.headers[PEER_HEADER] = address;
  return address;
}
```

**경로 차단**: 비루프백만 대상이다. 404는 본문 없이, 403은 JSON으로 끝낸다.
- pathname은 디스패처와 같은 방식(`new URL(req.url ?? "/", "http://x").pathname`)으로 구한다.
- 비교 전에 퍼센트 디코딩 1회, 소문자화, 연속 `/` 축약을 한다. absolute-form 요청 대상(`GET http://h/cdn-cgi/explorer HTTP/1.1`)이나 `%63dn-cgi` 같은 변형으로 우회하지 못하게 하려는 것이다.
- `/cdn-cgi/`로 시작하면 404다. 막는 대상은 다음과 같다.
  - explorer(`X_LOCAL_EXPLORER` 기본값 true, `index.mjs:30508-30511`)
  - `unsafeTriggerHandlers: true`(`index.mjs:52728,52837`)로 열린 `/cdn-cgi/handler/*` 트리거
  - `/cdn-cgi/mf/*`(`miniflare/dist/src/index.js:57043-57057`)
- `/__debug`로 시작하면 404다. `debugPlugin`(`index.mjs:48837-48870`)이 devtools HTML을 내주는 경로다.
- `/api/auth/bootstrap`이면 403 `BOOTSTRAP_LOCAL_ONLY`다.
- 루프백 요청은 그대로 통과한다. explorer는 꺼져 있어 404이고, `/__debug`는 인스펙터가 없어 `next()`로 넘어가 앱의 404가 된다.

**`upgrade` 처리**(이 앱은 WebSocket을 쓰지 않는다)

```ts
httpServer.once("listening", () => {
  const original = httpServer.listeners("upgrade");       // Vite HMR, cloudflare handleWebSocket(:53000 dev, :53309 preview)
  httpServer.removeAllListeners("upgrade");
  httpServer.on("upgrade", (req, socket, head) => {
    if (!allowUpgrade(req, mode)) { socket.destroy(); return; }   // dev + sec-websocket-protocol^="vite" + 루프백만 허용
    stampPeer(req);
    for (const listener of original) listener.call(httpServer, req, socket, head);
  });
});
```

- `prependListener`만으로는 부족하다. 뒤에 남는 cloudflare 리스너가 Vite가 아닌 upgrade를 `dispatchFetch`하는 것을 막지 못하기 때문이다(`:52900-52905`).
- preview에서는 upgrade를 전부 끊는다.
- 기동 뒤 `httpServer.listeners("upgrade").length === 1`인지 단언한다. 나중에 등록된 리스너가 감싸기를 우회하지 않았는지 확인하기 위해서다.

**인스펙터**
- `cloudflare({ …, inspectorPort: false })`(`index.d.mts:88`)를 둔다.
- miniflare에 `inspectorPort`가 undefined로 넘어가 인스펙터가 열리지 않는다(`index.mjs:52726,52835`).
- `getResolvedInspectorPort()`는 null을 돌려주고(`:34387`), `/__debug` middleware는 `next()`로 넘긴다.
- 결과적으로 dev의 9229와 preview의 9230이 열리지 않는다. dev에서 인스펙터를 쓰지 못하는 것은 감수한다.

**지원 런타임**: `vinext dev`(127.0.0.1)와 `vite preview`뿐이다. `wrangler dev`와 `vinext start`는 플러그인이 실리지 않으므로 지원하지 않는다.

**검증**
- `local-peer-plugin`
  - 위조 헤더가 `headers`와 `rawHeaders`에 대소문자를 섞어 여러 개 있어도 결과는 1개다.
  - `::ffff:` 정규화.
  - absolute-form과 인코딩 변형 경로가 404다.
  - upgrade 판정표: dev·preview × vite·기타 × 루프백·LAN.
- `lan-exposure-guards`: 플러그인이 배열 첫 항목이고 `enforce:"pre"`이며 `inspectorPort:false`인지 확인한다.
- R3 스모크(§11.5.9)
  - 점검 PC에서 위조 헤더로 보낸 부트스트랩이 403이다.
  - `/__debug`와 `/cdn-cgi/explorer/api/d1/database`(Host 위조 포함)가 404다.
  - `Upgrade: websocket` 요청은 연결이 끊긴다.
  - 9229·9230이 LISTEN 상태가 아니다.

### 7.7 전역 보안 헤더 (`worker/index.ts`)

**구조**
- 지금은 `/_vinext/image` 분기(`:32-41`)가 헤더 조립부(`:43-51`)보다 먼저 반환한다.
- 두 분기의 결과를 한 마무리 함수 `finalize(request, response)`로 보낸다.
- 비GET CSRF 검사(§7.3)는 두 분기보다 앞에 둔다.

**모든 응답에 붙이는 헤더**
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: same-origin`: 채팅 메시지 링크 등으로 `?id=`·`?downloadId=`가 외부로 새지 않게 한다.
- 기존 `Permissions-Policy: microphone=(self)`와 `Feature-Policy`(`:45-46`)는 유지한다.

**`/api/*` 응답**
- `Cache-Control`이 없을 때만 `no-store`를 넣는다.
- 라우트가 정한 `Content-Security-Policy`·`Content-Disposition`·`Cache-Control`은 덮어쓰지 않는다.

**적용 범위의 한계**
- `dist/client`의 정적 자산은 asset router가 Worker보다 먼저 응답하므로 이 헤더를 받지 않는다. vinext가 만드는 `dist/client/_headers`도 `/_next/static/*`의 Cache-Control만 정한다.
- 정적 자산은 JS·CSS·이미지·docx 서식이고 HTML 문서가 아니다. `/`와 `/incentive`의 HTML은 Worker가 SSR하므로 `X-Frame-Options`를 받는다.

**CSP**
- SPA 문서 CSP는 이번 범위에 넣지 않는다.
- 대신 React 텍스트 렌더링만 쓰고 `dangerouslySetInnerHTML`·`innerHTML`을 금지한다(현재 0건, `removal-guards` R5 단언).
- 파일 응답에는 라우트가 `sandbox` CSP를 붙인다(§7.8).

**검증**(`rendered-html`): `/`, `/api/finance/x`(404), 교차 출처 POST(403) 응답에 세 헤더가 모두 있고, `/api/*`는 `no-store`다.

### 7.8 채팅 첨부와 XSS (R5)

**업로드**(`PUT /api/chat/attachments?channelId=&name=`, raw body): 순서는 §4.2.8의 1~8단계(인가 → 멤버 → `Content-Length` 411·413 → 확장자 415 → `arrayBuffer()` 재검사 → R2 put → INSERT(실패 시 R2 삭제) → 감사)다.

**형식 판정**
- `content_type`은 **서버가 확장자로 정한다**. 클라이언트가 보낸 `Content-Type`은 무시한다.
- 미리보기(inline): `png, jpg, jpeg, gif, webp`
- 첨부(attachment): `pdf, docx, xlsx, pptx, hwp, hwpx, txt, csv, zip`
- 다음은 모두 415다: `svg`, `html`, `htm`, `xhtml`, `js`, `mjs`, 확장자 없음, 이중 확장자에서 마지막 확장자가 목록 밖인 경우.
- `name`은 한 번 디코딩한 뒤 제어문자와 경로 구분자(`/`, `\`)를 빼고 200자에서 자른다.
- R2 키는 서버가 `chat/<channelId>/<attachmentId>`로 만든다. 사용자 입력은 키에 들어가지 않는다.

**다운로드**(`GET ?id=`)
- 현재 멤버만 받는다. 공개 채널 비멤버는 403 `FORBIDDEN`, 비공개·DM 비멤버는 404다.
- 응답 헤더: `nosniff`, `Cache-Control: private, no-store`, `Content-Security-Policy: sandbox; default-src 'none'`, `Content-Disposition`(이미지 4종만 `inline`, 나머지는 `attachment; filename*=UTF-8''<RFC 5987 인코딩>`).
- 이미지로 위장한 HTML이 있어도 실행되지 않는다. 서버가 정한 `image/*`와 `nosniff` 때문에 HTML로 해석되지 않고, 직접 열어도 `sandbox` 때문에 스크립트가 돌지 않는다.

**렌더링**
- 메시지 본문, 채널 이름, 파일 이름, 표시 이름은 React 텍스트 노드로만 그린다.
- `highlightMentions`는 HTML 문자열이 아니라 `{text, mention}` 조각 배열을 돌려준다.
- 링크를 자동으로 만든다면 `http:`·`https:` 스킴만 허용하고 `rel="noopener noreferrer"`를 붙인다.

**기존 문서 다운로드**: `app/api/documents/route.ts:58`은 이미 `attachment`와 `private, no-store`를 쓴다. 여기에 전역 `nosniff`가 더해진다.

**검증**
- `chat-api`: 확장자별 disposition·CSP, SVG 415, 크기 411·413, 실제 길이 불일치 거부, 비멤버 404.
- 소스 가드: `dangerouslySetInnerHTML`·`innerHTML` 0건(`removal-guards`, R5).

### 7.9 PII와 실데이터

**정적 번들**
- asset router가 Worker보다 먼저 응답하므로 로그인 게이트가 정적 번들을 보호하지 못한다. 그래서 `dist/client`의 실데이터는 **0건**이어야 한다.
- 현재 빌드에서 확인한 내용
  - `incentive-calculator-*.js`에 명부의 `annualSalary`·`basePay` 숫자 리터럴이 각각 28개 있다.
  - `page-*.js`에 기본값 `annualSalary:0`·`basePay:0`, 열 너비 표(`app/compensation-calculator.tsx:32` `annualSalary: 98`)와 예시 명부(`:371-373`, `annualSalary:6e7`)가 있다.
- R1 조치
  - 클라이언트 import 2곳(`app/hr-workspace.tsx:5`, `app/incentive/incentive-calculator.tsx:7`)을 `app/hr-company-catalogs.ts`로 바꾼다.
  - `app/hr-company-data.ts`에 `import "server-only"`를 넣는다. 그러면 클라이언트나 ssr 환경에서 import할 때 빌드 오류가 난다(`@vitejs/plugin-rsc/dist/plugin-BhzHKRFo.js:421-460` `rsc:validate-imports`. `server-only`는 가상 모듈이라 패키지를 설치하지 않는다).
- `bundle-exposure` 표지
  - 서버 시드에서 뽑은 **실제 값**과 대조한다: 명부의 전화, 개인 이메일, `annualSalary`·`basePay` 리터럴 값(0이 아닌 값), `companyEmployees`·`financeCurrentData` 식별자.
  - `/annualSalary:\s*\d/` 같은 일반 정규식은 위의 기본값·열 너비·예시 행 때문에 R1 뒤에도 오탐이 난다(부록 C 1).
  - 전화는 `/01\d-\d{3,4}-\d{4}/` 정규식도 함께 쓴다.
  - `dist/server`는 재무 표지만 0건이면 된다(서버 번들의 HR 시드는 정상).

**API 투영**
- `/api/compensation/roster`는 `employeeId, name, department, status`만 준다.
- `include=hr`의 `birthDate`는 `""`로 내린다(`app/api/hr/compensation/route.ts:129`).
- `employee-records`(전화·주소·생년월일·급여)는 hr 보기 이상만 받는다.
- 채팅 `people`에는 `{accountId, name}`만 넣고, email과 employeeId는 넣지 않는다.
- `/api/admin/*`는 관리자만, `/api/me`는 본인 정보만 준다.
- 이 경계는 교차 매트릭스(SC-2)로 고정한다.

**어시스턴트**: 맥락은 사용자가 자기 권한으로 이미 받은 JSON뿐이다. 모델에게는 도구가 없어서 그 밖의 데이터에 닿지 않는다(§7.10).

**감사와 로그**
- 비밀번호·토큰·쿠키·`temporaryPassword`는 남기지 않는다. `temporaryPasswordIssued:true`만 남긴다.
- 채팅은 본문·채널 이름·파일 이름을 남기지 않고 id·길이·개수만 남긴다.
- 어시스턴트는 질문 본문을 남기지 않는다(현행 `app/api/assistant/route.ts:82-95` 유지).
- 감사 뷰어의 키 가림(`app/api/audit-log/route.ts:23` `secretKey`)은 두 번째 방어선이다.
- 서버 로그(`C:\xdm\logs`)에는 요청 본문과 Cookie 헤더를 남기지 않는다.

**브라우저 저장소**: §5.5.

**저장 매체**
- 백업·스냅샷·로그에는 급여, 비밀번호 해시, 세션 해시, 채팅이 모두 들어간다.
- `C:\xdm\*`의 ACL은 서버 사용자로 제한한다. `.env.local`은 넣지 않는다.
- 사본은 `attrib +R`로 읽기 전용으로 둔다. `backup-report.json`에는 개수와 무결성 결과만 적는다.
- 2차 사본 매체(`-MirrorRoot`)는 물리적으로 보관한다.

**재무 실데이터**
- 작업 트리에서 지운다.
- 보관은 두 곳뿐이다: archive 태그·브랜치, 그리고 `C:\xdm\archive\finance-data-20260923\`(SHA-256 기록).
- R3 10단계가 끝나면 개발 폴더는 운영 데이터 원본이 아니다.

### 7.10 AI 브리지 (R0 완료, R3 보완)

**R0 상태**(인용만 한다)
- `scripts/claude-assistant-bridge.mjs`
  - `HOST = "127.0.0.1"`(`:18`)
  - Origin이 있거나 Host가 `127.0.0.1|localhost:<port>`가 아니면 403(`:28`, `:150`)
  - 시작할 때 만든 빈 임시 폴더를 cwd로 쓴다(`:62`, `:127`)
  - `--tools ""`, `--disallowed-tools`에 `Read`·`Grep`·`Glob`·`PowerShell`까지 넣었다(`:36`, `:121-122`)
  - `XD_NODE_PROJECT_PATH`(`:21`)는 시작할 때 스키마와 `buildPrompt`를 읽는 데만 쓴다
- `scripts/claude-resume-bridge.mjs`도 같은 방식이다(`:9`, `:23`, `:29`, `:75-76`, `:84` `%TEMP%`, `:107`).
- 3110 Codex 브리지는 기동하지 않는다(`scripts/Start-XDNodeERP.ps1:73`). 파일은 `buildPrompt` 원본이라 남긴다.
- 검증: `tests/lan-exposure-guards.test.mjs`.

**R1·R3 보완**
- R1: 두 브리지의 `ALLOWED_MODULES`에서 `sales`를 `incentive`로 바꾼다(`claude-assistant-bridge.mjs:29`, `codex-assistant-bridge.mjs:28,40,55,113,127`).
- R3: `/api/assistant`는 `?module=`을 파싱하고 자기 키인지 검사한 뒤 리터럴 매핑으로 인가한다. 본문은 그다음에 읽는다. 지금은 `:36`에서 본문을 읽은 뒤 `:47`에서 인가한다.
- R3: 적용 버튼은 대상 탭이 편집일 때만 보인다.

**허용 목록을 넓히지 않는 이유**(D23)
- 정상 경로는 Worker가 보내는 서버 대 서버 fetch(`app/api/assistant/route.ts:55-63`)이고, Origin이 없다.
- 브라우저가 브리지를 직접 부를 경로를 만들지 않는다.
  - LAN PC에서 `127.0.0.1:3130`은 그 PC 자신을 가리킨다.
  - 서버 PC 브라우저가 부르면 Origin이 붙어 403이다.
  - DNS rebinding은 Host 검사에서 막힌다.

**프롬프트 주입**
- 도구가 꺼져 있어 파일 읽기, 명령 실행, 네트워크 접근이 없다.
- 최악의 경우는 잘못된 답이나 잘못된 `proposedActions`다.
- 적용은 사용자 자신의 세션으로 인가·감사를 거친 API를 부르는 것이다. 그래서 권한이 넓어지지 않는다.

**이력서 분석**
- 원본 파일은 올리지 않는다. 브라우저가 pdfjs·mammoth로 텍스트만 뽑아 보낸다(`app/hr-workspace.tsx:1411-1424`).
- 라우트는 `recruitment,write`(hr 편집)로 인가한다.

**자격 증명**: 브리지는 서버 사용자의 Claude CLI 로그인을 쓴다. 로그온 없는 세션에서도 동작하는지는 SC-12로 확인한다.

**SC-11 수동 점검**: 어시스턴트에게 `.env.local`, `app/hr-company-data.ts`, `.wrangler` sqlite, 서버 로그, 소스 파일 1개의 내용을 각각 요청한다. 응답에 해당 파일의 고유 문자열이 0건이어야 한다.

### 7.11 잔여 위험

| # | 위험 | 영향 | 처리 | 확인 |
|---|------|------|------|------|
| R-1 | 평문 HTTP라 같은 망에서 비밀번호와 세션 쿠키를 도청할 수 있다 | High | 수용(D10). Private·LocalSubnet만 허용, 게스트망 금지, 세션 강제 종료, runbook에 명시 | 방화벽 규칙 점검 |
| R-2 | 쿠키는 포트를 구분하지 않는다. 같은 호스트의 :8765 서비스가 요청마다 `xdm_session`을 받고, 쿠키를 심을 수도 있다(login CSRF 형태) | Medium | 견적 툴은 사내 신뢰 경계 안에 있다고 본다. R3 전환 때 견적 툴이 요청 헤더를 로그에 남기지 않는지 확인한다. CSRF와 XFO는 §7.3·§7.7로 막는다 | R3 체크리스트 |
| R-3 | http LAN에서는 교차 사이트 GET을 구분할 수 없다. 부수효과 GET(`applyDue*`)이 대상이다 | Low | 멱등이고 응답을 읽을 수 없다. runbook에 명시 | — |
| R-4 | 플러그인이 없는 런타임(`wrangler dev`, `vinext start`)이나 서버 PC의 프록시·portproxy에서는 peer를 위조할 수 있거나 LAN이 루프백으로 보인다 | High | 지원하지 않는 런타임으로 명시한다. 운영 기동은 작업 스케줄러 하나로 한다. portproxy를 금지하고 R3 스모크로 확인한다 | §7.4·§7.6 스모크 |
| R-5 | D21: 서버 PC 앞에 앉은 사람은 잠금 없이 계속 비밀번호를 시도할 수 있다 | Medium | 수용(D21). 서버 PC 화면 잠금, 실패 감사(`lockExempt:true`), 비밀번호 8자 이상 | 감사 조회 |
| R-6 | 없는 이메일로 로그인하면 예약할 행이 없어 속도 제한이 없다. PBKDF2 100,000회를 반복시키는 CPU DoS가 가능하다 | Low | 수용(6명 LAN). 문제가 되면 peer별 메모리 제한기를 추가한다(Later) | — |
| R-7 | 잠금 429는 존재하는 계정에만 나오므로 계정 존재 여부가 드러난다 | Low | 수용. 사내 이메일은 이미 알려져 있다 | — |
| R-8 | 30일 세션인데 자리를 여러 사람이 함께 쓴다 | Medium | 로그아웃 버튼 상시 노출, 관리자 `REVOKE_SESSIONS`, runbook | — |
| R-9 | HR 탭을 받은 계정은 급여도 본다(D12). 보기 계정에도 편집 버튼이 보인다 | Medium | 계정 화면 안내 "HR 탭에는 급여관리가 포함됩니다", 보기 권한 배너, 서버 403 | SC-2 |
| R-10 | DM·비공개 채널의 기밀성은 앱 경계까지만이다. 관리자는 서버 PC에서 D1 파일과 백업을 직접 열 수 있다 | Medium | 감사에 본문이 없다. 앱에서는 관리자도 비멤버면 404다. 파일 접근은 ACL로 제한한다 | `chat-api` |
| R-11 | 공용 Windows 프로필에서 다른 사람이 localStorage(인센티브·급여 선호 설정)를 읽을 수 있다 | Low | 계정 범위 키를 쓰고, 데이터 키(딜·조정·지급 결과·제외 인원)는 로그아웃·401 때 삭제한다(§5.5). PC별 Windows 사용자 분리를 권고한다 | — |
| R-12 | 백업과 2차 매체에 해시와 PII가 모두 들어 있다 | High | ACL, `attrib +R`, `.env.local` 제외, 매체 물리 보관 | SC-7 |
| R-13 | `.env.local`의 `CLOUDFLARE_API_TOKEN`이 과거 브리지 경로로 노출됐을 수 있다 | Medium | R0 사용자 작업: Workers AI 전용 권한 토큰으로 교체를 검토한다 | 사용자 체크리스트 |
| R-14 | 정적 자산에는 보안 헤더가 없고 SPA 문서에는 CSP가 없다 | Low | 정적 자산에는 HTML이 없다. `innerHTML` 0건 가드를 둔다. 문서 CSP는 Later | `bundle-exposure`, 소스 가드 |
| R-15 | 의존성 업그레이드로 explorer 기본값, middleware 순서, upgrade 처리가 바뀔 수 있다 | High | `X_LOCAL_EXPLORER=false`와 비루프백 `/cdn-cgi` 404로 이중화한다. `local-peer-plugin`·`lan-exposure-guards` 테스트를 두고, 업그레이드 뒤 §7.6 스모크를 다시 한다 | 테스트 |
| R-16 | 과거 LOAD_HR로 저장된 `hr_compensation_lines.snapshot_json`에는 생년월일이 남아 있고, GET run(`runJson`, `:76-85`)으로 compensation 보기 계정에게 내려간다 | Medium | `:129`만 고친다. 저장된 값의 처리는 Do 전에 사용자 확인(부록 C 열린 질문 1) | — |

---

## 8. Test Plan

> 테스트 코드는 Do 단계에서 구현과 함께 쓴다. 모듈마다 코드와 테스트가 한 묶음이고, 각 scope는 `npm run lint && npm test`가 통과해야 끝난다(§11.4).
>
> 이 저장소에는 브라우저 자동화 도구가 없다(Playwright·puppeteer·jsdom·happy-dom·testing-library 0건). 있는 것은 `node --test`, `node:sqlite`, `react-dom/server`(19.2.6), `typescript`(5.9.3)다. 그래서 템플릿의 L1~L3을 아래처럼 바꿔 쓴다. 새 devDependency는 들이지 않는다.

### 8.1 Test Scope

| 층 | 대상 | 도구 | 단계 |
|----|------|------|------|
| L1 API 동작 | 실제 라우트 + 메모리 SQLite(D1 대역) + R2 스텁. status·code·본문·Set-Cookie·감사 행 | `tests/helpers/hr-api-harness.mjs` + `node --test` | Do |
| L1 순수 함수 | 레지스트리, 비밀번호, request-guard, peer 플러그인 판정, 멘션 추출 | `node --test`(직접 import) | Do |
| L2 셸 DOM | `ShellTopNav`·`resolveActiveTab`을 `/api/me` 모양 입력으로 렌더해 탭 DOM 유무 확인 | `react-dom/server` + `tests/helpers/tsx-loader.mjs` | Do |
| L2 빌드 산출물 | 빌드된 worker(DB 없음)로 `/`·`/incentive` SSR, 404 경로, 교차 출처 POST, 헤더. `dist/client` 번들 표지 | `tests/rendered-html.test.mjs`, `tests/bundle-exposure.test.mjs`(`npm run build` 뒤) | Do |
| 소스 가드 | 문자열·정규식으로 구조 규칙 단언(기존 관례) | `removal-guards`, `tab-permissions`의 가드 절, `lan-exposure-guards`, `erp-platform` | Do |
| L3 수동 시나리오 | 다른 PC LAN, 재부팅, 백업 복구, 지연 측정 | 수동 체크리스트(runbook) | R1 검증·R3 전환·R4·R5 |

### 8.2 L1: API Test Scenarios

`setAccess(tabs, opts)`로 계정을 바꾼다. 기본 peer는 비루프백 `192.0.2.10`이다.

| # | 대상 | 시나리오 | 기대 | 파일 |
|---|------|----------|------|------|
| 1 | POST /api/auth/bootstrap | 계정 0개 + `setPeer("127.0.0.1")` | 201, Set-Cookie 1개, `BOOTSTRAP_ADMIN_CREATED` | auth-session |
| 2 | 〃 | LAN peer가 `Host: localhost`·`x-xdm-peer: 127.0.0.1`·`CF-Connecting-IP: 127.0.0.1` 위조 | 403 | auth-session |
| 3 | 〃 | 동시 2건 | 201 1건, 409 `BOOTSTRAP_CLOSED` 1건, 계정 1개 | auth-session |
| 4 | 〃 | 계정이 있을 때 / `Upgrade` 헤더 / 비JSON | 409 / 400 / 415 | auth-session |
| 5 | POST /api/auth/login | 정답 | 200, 쿠키 속성이 정확히 `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`(Secure 없음), `LOGIN_SUCCEEDED{peer}` | auth-session |
| 6 | 〃 | LAN peer 오답 20건 `Promise.all` | 검증 호출 ≤ 5, 나머지 429 `LOCKED` + `Retry-After`, `ACCOUNT_LOCKED` 1행, `LOGIN_BLOCKED` 행 | auth-session |
| 7 | 〃 | 잠금 중 정답(LAN) / 잠금 중 정답(루프백) | 429 / 200, `failed_attempts` 증가, 루프백 실패는 `lockExempt:true` | auth-session |
| 8 | 〃 | `setClock`으로 5분 경과 | 잠금 해제, 첫 실패가 카운터 1 | auth-session |
| 9 | 〃 | 없는 이메일·비활성 계정 | 401 `INVALID_CREDENTIALS`, actor `anonymous`, 카운터 불변 | auth-session |
| 10 | 〃 | `Origin: http://evil.invalid` / `Origin: null` / `Sec-Fetch-Site: cross-site` | 403 `CROSS_ORIGIN`(가드 층) | auth-session |
| 11 | PUT /api/auth/password | `mustChangePassword` 계정의 탭 API 호출 | 403 `PASSWORD_CHANGE_REQUIRED`, `/api/me`는 200 | auth-session |
| 12 | 〃 | 7자 / 현재와 같음 / 현재 오답 / 잠긴 계정이 루프백 peer에서 정답 | 400 / 400 / 401 `INVALID_CREDENTIALS`(세션 유지) / 429 `LOCKED`(D21은 로그인만) | auth-session |
| 13 | 〃 | 성공 | 다른 세션 401, 현재 세션 200, `must_change_password=0` | auth-session |
| 14 | 세션 수명 | 30일 경과(모의 시계), LOGOUT, DEACTIVATE, RESET_PASSWORD, REVOKE_SESSIONS | 옛 쿠키 401 `UNAUTHENTICATED` | auth-session |
| 15 | 해시 | 저장 해시 | `pbkdf2_sha256$100000$`로 시작, DB·감사에 평문 비밀번호·토큰 0건 | auth-session |
| 16 | 감사 actor | 두 계정이 각각 수정 | `actor_user_id` 2종(SC-3) | auth-session |
| 17 | 게이트 | `resetDatabase` 두 번 뒤 `/api/me` | 200(게이트가 테이블 누락을 남기지 않음) | auth-session |
| 18 | POST /api/admin/accounts | CREATE → 로그인 → 강제 변경 | `temporaryPassword` 12자 1회, 감사에 `temporaryPasswordIssued:true`만 | auth-session |
| 19 | 〃 | 마지막 활성 관리자 DEACTIVATE·강등 | 409 `LAST_ADMIN` | auth-session |
| 20 | 〃 | UPDATE_TABS에 `audit`·`admin`·모르는 키 / 저장된 모르는 키 | 400 / 보존 | tab-permissions |
| 21 | 탭 매트릭스 | 유지 라우트·메서드 전부 × 그 탭 none·view·edit(다른 탭은 edit) | 필요 수준 미만 403 `FORBIDDEN` + `ACCESS_DENIED`, 이상이면 401·403 아님 | tab-permissions |
| 22 | 교차 매트릭스 | §4.3.2 표 4행 | 표대로 | tab-permissions |
| 23 | 관리자 전용 | 비관리자 `tabs_json`에 audit·admin=edit | `/api/audit-log`·`/api/admin/accounts` 403 | tab-permissions |
| 24 | 레거시 문서 | finance 행 다운로드(관리자·일반) | 404 | tab-permissions |
| 25 | /api/me | 탭 해석 결과 | `{user,isAdmin,tabs,mustChangePassword}`, 비관리자 audit·admin none | tab-permissions |
| 26 | PUT /api/hr/employee-records, PUT /api/hr/recruitment(입사 전환·오퍼 수정) | `employeeId: "acct_x"` | 400, `hr_employee_records` 행 0건 | tab-permissions |
| 27 | 본문 전 인가 | §4.3.2의 8곳에 깨진 본문: 7곳(documents POST·PATCH·DELETE, payroll PUT, operations PUT, transcriptions POST, recruitment POST)은 hr=view 계정, assistant는 대상 탭 none 계정(`module=hr`는 hr=none, `module=compensation`은 compensation=none). assistant는 view로 통과하는 경로라 view 계정으로는 검증되지 않는다 | 400이 아니라 403(본문을 읽기 전에 거부) | tab-permissions |
| 28 | /api/compensation/roster | compensation=view | 200, 키가 정확히 4개, 퇴직자 뒤 | tab-permissions |
| 29 | /api/compensation GET include=hr | 스냅샷 | `birthDate === ""` | tab-permissions |
| 30 | /api/assistant | `module=__proto__` / `sales` / 없음 | 400(인가 전) | tab-permissions |
| 31 | HR 즉시 반영 7흐름 | §12.2 표의 흐름별 성공 | 표의 최종 상태, 감사 action | hr-api-integration |
| 32 | 〃 | 흐름별 레거시 from-state 행을 sqlite로 넣은 뒤 전이 | 성공 | hr-api-integration |
| 33 | 〃 | 같은 전이 동시 2건 | 하나 200, 하나 409 `CONFLICT` | hr-api-integration |
| 34 | 〃 | 급여 APPROVED·LOCKED·재오픈 뒤 | `erp_approval_*`·`finance_expense_requests` 테이블·행 0건(`sqlite_master`) | hr-api-integration |
| 35 | 〃 | hr=view로 7흐름 | 403 | hr-api-integration |
| 36 | 정적 목록 | `LEGACY_SALES_INCENTIVE_PERIODS`에 테스트 월을 주입한 CONFIRM / 재오픈 목록 | 409 `LEGACY_PERIOD_LOCKED` | hr-api-integration |
| 37 | 새 DB | 결재·재무 테이블 없는 DB에서 휴가 삭제·결정, 급여 승인, 채용요청 삭제 | 500 없음(FR-03) | hr-api-integration |
| 38 | 성과 이의제기 | 수용 | 서버가 `RESOLVED`를 받고 200 | hr-api-integration |
| 39 | chat/channels | 비공개 채널 목록·id 조회(비멤버) | 목록에 없음, 404 | chat-api |
| 40 | 〃 | OPEN_DM 같은 조합 두 번(1:1, 그룹) | 같은 채널, 두 번째 200 `created:false` | chat-api |
| 41 | chat/messages | 답글의 답글 / 4001자 / 비멤버 전송 / 보관 채널 전송 | 400 / 400 / 404 / 409 `CHANNEL_ARCHIVED` | chat-api |
| 42 | 〃 | 같은 `clientKey` 재전송 | 200 `duplicate:true`, 행 1개 | chat-api |
| 43 | 〃 | `@이름`·`@channel` | mentions 수, unread 멘션 계산 | chat-api |
| 44 | 〃 | 다른 계정의 수정·삭제 / 본인 삭제 | 403 / `body:null`, `CHAT_MESSAGE_DELETED{…length…}`, 감사 JSON에 본문 문자열 0건 | chat-api |
| 45 | 〃 | 검색 `%`·`_` 포함, 접근 불가 채널의 일치 | 이스케이프, 결과 없음 | chat-api |
| 46 | chat/poll | `since=0` / 새 이벤트 / 201건 / `since > head` | 커서만 / 증분 / `hasMore` / `resync:true` | chat-api |
| 47 | 〃 | 비공개 채널 id를 `watch`로 | 그 채널 이벤트 0건 | chat-api |
| 48 | 〃 | 다른 사람이 read-state PUT | 내 poll 증분 0건 | chat-api |
| 49 | chat 권한 | chat=view: JOIN·LEAVE·read-state 200, 전송·업로드·채널 생성 403. 채널 DELETE 비관리자 403. `ADD_MEMBERS`에 비활성·chat=none 계정 400(멤버 행 0건). 관리자가 멤버 아닌 비공개 채널에 RENAME·REMOVE_MEMBER·DELETE 404 | 표대로 | chat-api |
| 50 | chat/attachments | png·pdf 업로드 후 멤버 GET | 같은 바이트, `nosniff`, png `inline`, pdf `attachment; filename*=`, CSP `sandbox` | chat-api |
| 51 | 〃 | `Content-Length` 없음 / 26,214,401 / svg / 선언 길이 불일치 | 411 / 413(R2 `objects` 불변) / 415 / 413 | chat-api |
| 52 | 〃 | 다른 사람 첨부 id를 메시지에 묶기 / 비공개·DM 비멤버 다운로드 / 공개 채널 비멤버 다운로드 | 400 / 404 / 403 | chat-api |

### 8.3 L2: 셸·빌드 산출물 시나리오

| # | 대상 | 행동 | 기대 | 파일 |
|---|------|------|------|------|
| 1 | `ShellTopNav` | `tabs={hr:"view",compensation:"none",audit:"none",admin:"none"}`로 렌더 | 탭 버튼 "인사관리" 1개. "임금 계산"·"감사 로그"·"계정 관리" 문자열 0건 | shell-tabs |
| 2 | 〃 | 관리자 | 탭 4개(R5 5개), 레지스트리 순서 | shell-tabs |
| 3 | `resolveActiveTab` | 저장된 탭이 권한 밖 / 없음 / 모두 none | 첫 허용 탭 / 첫 허용 탭 / null | shell-tabs |
| 4 | `TAB_PANELS` | 소스 | `Record<TabKey,` 선언 존재, `TAB_REGISTRY`의 모든 key가 `TAB_PANELS`의 키로 존재(타입 검사 단계가 없으므로 테스트로 확인) | shell-tabs |
| 5 | `/` SSR | 빌드된 worker fetch | 제목 "XDnode management", `data-auth-gate="loading"`, 탭 라벨·재무/영업 문자열 0건 | rendered-html |
| 6 | `/incentive` SSR | 〃 | `data-auth-gate="loading"`만, 계산기 DOM 0건 | rendered-html |
| 7 | 제거 경로 | `/api/finance/budget`, `/api/sales`, `/api/approvals` | 404(FR-01) | rendered-html |
| 8 | CSRF | `Origin: http://evil.invalid`의 `POST /api/auth/login`, 그리고 `Origin`·`Sec-Fetch-Site`가 모두 없는 `POST /api/auth/login`과 `PUT /api/hr/payroll` | 모두 403 `CROSS_ORIGIN`(DB 없이 worker에서) | rendered-html |
| 9 | 헤더 | `/`, 404, 403 응답 | nosniff·XFO DENY·Referrer-Policy 3종, `/api/*`는 `no-store` | rendered-html |
| 10 | Set-Cookie | worker 조립부 통과 | 여러 Set-Cookie 보존 | rendered-html |
| 11 | 번들 | `dist/client/**/*.js` 전체 | §7.9 표지 0건. `dist/server`는 재무 표지 0건 | bundle-exposure |

### 8.4 L3: 수동 시나리오 (runbook 체크리스트)

| # | 시나리오 | 언제·어디서 | 성공 기준 |
|---|----------|-------------|-----------|
| SC-4 | HR 회귀: 급여 REVIEW→APPROVED→LOCKED·재오픈, 퇴직 등록→IN_PROGRESS→EFFECTIVE→COMPLETED, 인사발령 오늘·미래, 휴가 구 양식·연차 신청·삭제·레거시 PENDING 승인, 채용요청 생성→OPEN→삭제, 인력계획 승인·SUPERSEDED, 성과 확정·이의제기 수용·기각, 조직 수정, 문서 업로드·다운로드, 임금 계산 CONFIRM·REOPEN, 인센티브 계산(임금 계산 전용 계정 포함) | R1: 서버 PC, 기존 D1 사본과 새 DB. 최종: R3 전환 점검 인스턴스(3001, 운영 사본과 새 DB)에서 점검 PC | 전 항목 성공, 재무 테이블 행 변화 없음. 운영 DB에서는 하지 않는다 |
| SC-5 | 다른 PC에서 로그인, 어시스턴트 1건, 이력서 분석 1건 | R3 7단계 | 성공 |
| SC-6 | 두 PC가 채팅 탭을 보이는 상태로 10회 전송 | R5 | 서버 기록 시각과 수신 표시 시각 차 10회 모두 ≤ 3초. poll p95 ≤ 200ms(6명, 100회) |
| SC-7 | 백업을 새 폴더에 복구 | R4(로그인·HR 조회), R5 뒤 1회 재실행(채팅 기록·첨부 R2 객체 포함, `r5-ui`) | `integrity_check=ok`, 행 수·R2 객체 수가 보고서와 일치, 로그인·HR 조회 성공. R5 재실행에서 채팅 기록 조회와 첨부 다운로드 성공 |
| SC-8 | 보관 확인: `git tag -l erp-final-20260923`, `git branch --list archive/erp-finance-sales-20260923`, `C:\xdm\snapshots\r1-pre-*`의 verify 보고서(integrity ok·행 수), 운영 DB `sqlite_master`에 `finance_*`·`sales_*`·`erp_approval_*` 존재 | `r1-verify`, R3 4단계 | 전부 확인 |
| SC-9 | 다른 PC에서 `/.wrangler/…`, `/app/*.ts`, `/*.tar.gz`, `/cdn-cgi/explorer/…`(Host 위조), `/__debug`, `/.dev.vars`, `/server/.dev.vars`, `/dist/server/.dev.vars`, `/.env.local`, `/wrangler.json` | R3 7단계 | 404 또는 403(`.dev.vars`·`.env.local`·`wrangler.json`은 404) |
| SC-11 | 어시스턴트에게 파일 5종 요청 | R3 뒤 | 고유 문자열 0건 |
| SC-12 | 재부팅 뒤 로그온 없이 | R4 | 다른 PC에 로그인 화면, 헬스체크 401, 어시스턴트·이력서 분석 응답. 첫 03:00 백업·첫 Deploy 뒤에도 |
| SC-13 | 운영 폴더 데이터 이전 | R3 4·6단계 | 원본·사본 integrity·행 수·R2 수 일치, HR 조회·R2 녹음 다운로드 성공 |
| 스모크 | 위조 peer 부트스트랩 403, `/__debug` 404, 9229·9230 LISTEN 없음, `netsh interface portproxy show all` 비어 있음, `Upgrade: websocket` 끊김, URL 조작으로 숨긴 탭 접근 불가 | R3 7단계 | 전부 기대대로 |

### 8.5 하니스와 시드 (`tests/helpers/hr-api-harness.mjs`)

- 스텁: `cloudflare:workers`, `next/headers`(`headers()`만), `next/navigation`, `server-only`(R1에 추가, `:47`의 목록).
- `resetDatabase()`의 순서
  1. `resetPlatformSchemaGate()`
  2. `new DatabaseSync(':memory:')`
  3. (migrate)
  4. `ensureErpPlatformSchema(db)`(`:86`)
  5. `acct_test_admin`을 시드한다: gc.kim 시드의 email과 이름, `employee_id='gc.kim'`(기존 owner 고정값의 self/manager 권한 유지), is_admin 1, must_change 0, `tabs_json '{}'`, `TEST_ADMIN_PASSWORD` 해시는 **프로세스당 1회만** 계산한다.
  6. 세션 행을 넣는다: `id = sha256(TEST_SESSION_TOKEN)`, 만료 30일 뒤.
- 기본 `runtime.headers`: `cookie: xdm_session=<TEST_SESSION_TOKEN>`, `host: audit.invalid`, `origin: http://audit.invalid`, `x-xdm-peer: 192.0.2.10`(비루프백, fail closed).
- 새 API
  - `setAccess(tabs|null, {isAdmin=false, employeeId, mustChangePassword=false})`: null이면 쿠키를 지운다.
  - `createAccount({...}) → {id}`
  - `login(email,password)`: 실제 라우트를 부르고 `getSetCookie()`로 쿠키를 받는다.
  - `setPeer(address|null)`
  - `setClock(ms|null)`: `Date.now`를 바꾼다(잠금 5분, 세션 30일).
- `callApi(path, method, body, query, { headers, raw })`는 `{ status, body, headers, setCookies, response }`를 돌려준다. JSON일 때만 파싱하고, raw ArrayBuffer 본문을 받는다. 호출별 헤더는 Request와 `runtime.headers` 양쪽에 싣는다.
- R2 스텁: `put`이 ReadableStream을 버퍼링하고 바이트를 복사해 저장하며, `head()`를 더한다.
- `setIdentity(roles)` shim(r3-auth ~ r3-tabs)
  - null → 쿠키 제거, `SUPER_ADMIN` → isAdmin, `HR_ADMIN` → `{hr:edit,compensation:edit}`, `RECRUITER` → `{hr:edit}`, `VIEWER` → `{hr:view,compensation:view}`.
  - r3-tabs 끝에서 호출부 7곳(`tests/hr-api-integration.test.mjs:23,38,76,118,120,332,341`)을 `setAccess`로 옮기고 shim을 지운다. 그 뒤 `removal-guards`가 `setIdentity(` 0건을 단언한다.
- 규칙
  - `cookies()`와 `'use server'`는 쓰지 않는다.
  - 서버 코드는 확장자 없는 상대 경로로 `.ts`만 import한다. `@/`, 디렉터리 index, `.tsx`는 import하지 않는다.
  - bind에는 1/0을 쓴다.
  - 새 테스트는 `setAccess`만 쓴다.
  - `shell-tabs`는 `tests/helpers/tsx-loader.mjs`(`.ts/.tsx` → ReactJSX 변환, `*.css` 빈 모듈, `server-only` 스텁)로 `ShellTopNav`와 `resolveActiveTab`을 렌더한다.

**시드 데이터 최소 요건**

| Entity | 최소 | 필수 필드 |
|--------|:---:|-----------|
| `auth_accounts` | 1(관리자) + 테스트별 `createAccount` | email, password_hash, is_admin, tabs_json |
| `auth_sessions` | 1 | id=sha256(token), expires_at |
| `hr_employee_records` | 기존 시드(gc.kim 포함) | employee_id, name, department, status |
| 레거시 대기 행 | 흐름별 1(테스트가 sqlite로 직접 INSERT) | status = SUBMITTED / PENDING / FINALIZATION_SUBMITTED |
| `erp_documents` finance 행 | 1(레거시 404 검증) | module='finance' |
| 채팅 | `ch_general`(시드) + 비공개 채널 1 + 계정 3 | kind, 멤버십 |

### 8.6 테스트 파일과 가드 (릴리스별)

**FR → 검증 추적**(SC-1은 이 표의 모든 행이 통과했는지로 판정한다)

| FR | 릴리스 | 검증 수단 |
|----|--------|-----------|
| FR-01 | R1 | `removal-guards`(R1), `rendered-html` §8.3 #7(404) |
| FR-02 | R1 | `hr-api-integration` §8.2 #31~#38(흐름별·레거시 from-state), SC-4 |
| FR-03 | R1 | `hr-api-integration` 새 DB 케이스(§8.2 #37), 'APPROVED·LOCKED 뒤 결재·재무 행 0건', `removal-guards`, SC-4 |
| FR-04 | R1 | `incentive-calculation`, `local-codex-assistant` |
| FR-05 | R2 | `rendered-html` §8.3 #5(제목), `removal-guards` R2(`database_id`·`bucket_name`·package name) |
| FR-06 | R3 | `auth-session`, SC-5(preview 로그인) |
| FR-07 | R3 | `auth-session`(위조·동시 요청), `local-peer-plugin`, R3 스모크(위조 peer 부트스트랩 403) |
| FR-08 | R3 | `auth-session` |
| FR-09 | R3 | `shell-tabs` §8.3 #1~#4, R3 스모크(URL 조작) |
| FR-10 | R3 | `tab-permissions` §8.2 #20~#30, §4.3.2 교차 매트릭스(SC-2) |
| FR-11 | R3 | `auth-session`·`tab-permissions`의 감사 단언, §8.2 #16(SC-3) |
| FR-12 | R5 | `chat-api` |
| FR-13 | R5 | `chat-api`(첨부 #50~#52) |
| FR-14 | R5 | `chat-api`, SC-6 |
| FR-15 | R5 | `chat-api` |
| FR-16 | R3 | `tab-permissions` 소스 가드, `access-policy`(레지스트리 무결성) |
| FR-17 | R3·R4 | SC-5, SC-7, SC-12, SC-13 |
| FR-18 | R6 | R6 체크리스트(§11.5.10) |
| FR-19 | R0 | `lan-exposure-guards`, R0 확인 2건(§11.4 r0 행), SC-9 |
| FR-20 | R1·R3 | `bundle-exposure`, `tab-permissions` |
| FR-21 | R0 | `lan-exposure-guards`(브리지 spawn·`--tools ""`·cwd 가드), SC-11 |

| 파일 | 릴리스 | 검증 대상 |
|------|--------|-----------|
| `tests/removal-guards.test.mjs` | R1(R2·R3·R5에서 단언 추가) | R1: 삭제 경로 import·fetch 0건, `FINANCE_ADMIN`·`SALES_ADMIN` 0건, 문서 라우트는 hr·recruitment만, payroll에 `finance_expense_requests` 0건, compensation에 `sales_incentive_payroll_links` 0건, `erp_approval_*`·`erp_tasks`·`erp_sync_runs` CREATE 0건(drizzle SQL은 존재), `tests/*.test.mjs`와 test 목록 양방향 일치. R2: `database_id`·`bucket_name` 불변, package name `xdnode-management`. R3: `LOCAL_ERP_USER_EMAIL`·`oai-authenticated` 0건, `'use server'` 0건, `cookies()` import 0건, 서버 코드의 `@/`·디렉터리 index·`.tsx` import 0건, `"use client"` 파일의 `crypto.randomUUID(` 0건, `setIdentity(` 0건(r3-tabs 끝), `app/`에서 `principal.roles`·`.roles.includes(` 0건, `app/`에서 `erp_user_access`·`hr_authorized_users` 0건. R5: `dangerouslySetInnerHTML`·`.innerHTML` 0건 |
| `tests/bundle-exposure.test.mjs` | R1 | FR-20, SC-9의 번들 절반(§7.9 표지) |
| `tests/hr-api-integration.test.mjs` | R1 수정, R3 이전 | FR-02·FR-03, §8.2 #31~#38. 회귀 고정점 `:176-185`, `:347-362`, `:400-425`는 유지하고 기대값만 고친다. R3에 `callApi('compensation', …)`(`:85,128`) |
| `tests/incentive-calculation.test.mjs`, `tests/local-codex-assistant.test.mjs` | R1 | FR-04, `incentive` 모듈 |
| `tests/rendered-html.test.mjs` | R1~R3 | §8.3 #5~#10(FR-01·FR-05) |
| `tests/auth-session.test.mjs` | R3 | FR-06·07·08·11, SC-10(§8.2 #1~#19) |
| `tests/tab-permissions.test.mjs` | R3 | FR-10·11·16, SC-2의 API 절반(§8.2 #20~#30), §4.3.2 소스 가드 |
| `tests/access-policy.test.mjs` | R3 | 레지스트리 무결성(key 중복 없음, 모듈이 두 탭에 걸리면 throw, audit·admin adminOnly), `canAccess`·`resolveTabs`·`requiredLevel` 순수 표, `PBKDF2_ITERATIONS ≤ 100000`과 `reset-admin-password.mjs`의 같은 상수, `crossOriginWriteViolation`·`crossSiteViolation` 판정표(`crossOriginWriteViolation`은 비GET에 `Origin`·`Sec-Fetch-Site`가 모두 없으면 위반, `crossSiteViolation`은 둘 다 없으면 위반 아님) |
| `tests/local-peer-plugin.test.mjs` | R3 | §7.6 검증 |
| `tests/shell-tabs.test.mjs` | R3 | FR-09, SC-2의 DOM 절반(§8.3 #1~#4) |
| `tests/lan-exposure-guards.test.mjs` | R0(완료), R3·R4 보강 | R3: preview 시작 스크립트, `write-dev-vars` 허용 목록 5개, 플러그인 순서·`enforce:"pre"`·`inspectorPort:false`, 빌드 뒤 `dist/client` 아래 `.dev.vars`·`.env*` 파일 0개(`@cloudflare/vite-plugin`은 `.assetsignore`에 `wrangler.json`·`.dev.vars`만 넣는다, `dist/index.mjs:53214`). R4: Stop·Backup 스크립트, `ops_backup_runs` DDL 문자열 일치 |
| `tests/chat-api.test.mjs` | R5 | FR-12~FR-15(§8.2 #39~#52) |

`package.json` test 목록
- R1: `finance-alert-reporting`, `finance-assistant-evidence`, `finance-data`, `finance-decision-model`, `finance-time-series` 5개를 빼고 `removal-guards`·`bundle-exposure`를 더한다.
- R3: `hr-local-permissions`를 빼고 `auth-session`, `tab-permissions`, `access-policy`, `local-peer-plugin`, `shell-tabs`를 더한다.
- R5: `chat-api`를 더한다.

### 8.7 기존 테스트 정리

| 파일 | 처리 |
|------|------|
| `tests/erp-platform.test.mjs`(111개) | 39개를 남긴다: 그대로 23, 줄 수정 12, 재작성 4(`:22` 라우트 목록 → '변경 라우트는 인가 헬퍼와 `writeErpAudit`를 호출' 가드, `:1165`, `:1590`, `:2209`). 72개(재무·영업·결재·마스터 영향·데이터·운영)는 지운다. `:1769`의 문서 문구 단언은 문서와 같은 커밋에서, `:985,2554`의 스크립트 이름은 R2에서, `:54,851,2571,2652`의 compensation 경로는 R3에서 고친다 |
| `tests/workflow-ledgers.test.mjs`(51개) | HR 원장 8개(`:328`, `:796`, `:814`, `:838`, `:869`, `:917`, `:1215`, `:1288`)만 남긴다. 삭제 파일을 읽는 `:731`, `:1072`는 반드시 지운다 |
| `tests/hr-local-permissions.test.mjs` | R3에서 삭제(`tab-permissions`가 대체) |
| `tests/hr-dashboard-model.test.mjs` | R3에서 `roles` 입력(`:21`, `:131-135` RECRUITER)을 지운다(`app/hr-dashboard-model.ts:356`) |
| `tests/compensation-calculation.test.mjs` | R3에서 경로 `:122,154`를 `/api/compensation`으로 |
| `tests/local-codex-assistant.test.mjs` | R1 `:38-66` `sales` → `incentive`, R2 `:42` 스크립트 이름 |
| `tests/hr-api-integration.test.mjs` | R1에 approval-settings·sales/incentives 케이스(`:328-345`) 정리, R3에 authorized-users 케이스(`:9`, `:31`) 정리(라우트가 R3에 삭제되므로) |
| `tests/finance-*.test.mjs` 5개 | R1 삭제 |

---

## 9. Clean Architecture

> 기준은 `CLAUDE.md`다. 이 저장소는 `app/` 아래 평탄한 파일 배치를 쓰므로 계층을 폴더로 나누지 않는다. 계층은 파일의 역할과 import 방향으로 지킨다.

### 9.1 Layer Structure

| Layer | Responsibility | Location |
|-------|---------------|----------|
| **Presentation** | 셸, 화면, 탭 패널, 클라이언트 상태 훅 | `app/page.tsx`, `app/shell-top-nav.tsx`, `app/auth-screens.tsx`, `app/*-workspace.tsx`, `app/*-view.tsx`, `app/incentive/*`, `app/session-client.ts`, `app/chat-client.ts`, `app/client-runtime.ts` |
| **Application** | 라우트 핸들러: 인가 → 본문 → 도메인 호출 → `db.batch` → 감사 | `app/api/**/route.ts` |
| **Domain** | 순수 규칙과 타입: 탭 레지스트리·권한 판정, 교차 출처 판정, HR 전이 문장 생성, 멘션 추출, 비밀번호 해시, 급여·퇴직금 계산 | `app/access-tabs.ts`, `app/request-guard.ts`, `app/hr-transitions.ts`, `app/chat-mentions.ts`, `app/auth-password.ts`, `app/compensation-calculation.ts`, `app/hr-severance-calculation.ts` 등 기존 순수 모듈 |
| **Infrastructure** | D1·R2·헤더·런타임 접점: 게이트 스키마, 세션 저장소, 감사 쓰기, 채팅 저장소, Worker 진입점, Node 플러그인, 운영 스크립트 | `app/erp-platform.ts`, `app/auth-session.ts`, `app/chat-server.ts`, `app/chat-schema.ts`, `app/hr-company-data.ts`(server-only 시드), `worker/index.ts`, `build/local-peer-vite-plugin.ts`, `scripts/*` |

### 9.2 Dependency Rules

```
Presentation ──→ Domain(순수, 클라이언트 허용분만) ──→ (없음)
     │
     └─ fetch ─→ Application(라우트) ──→ Infrastructure(erp-platform, auth-session, chat-server, chat-schema)
                        │                        │
                        └────────→ Domain ←──────┘

worker/index.ts ──→ request-guard(순수)          build/local-peer-vite-plugin.ts ──→ (앱 코드 없음)

규칙
· Domain 모듈은 앱의 다른 모듈을 import하지 않는다(access-tabs·request-guard는 import 0개).
  hr-transitions는 D1PreparedStatement 타입만 쓰고 cloudflare:*를 import하지 않는다.
· auth-session은 erp-platform을 import하지 않는다(erp-platform → auth-session 한 방향, 순환 방지).
· Presentation은 Infrastructure를 import하지 않는다. 데이터는 인가된 API로만 받는다(§7.9).
· db.batch와 meta.changes 검사는 Application(라우트)에 둔다. Domain은 문장만 만든다.
```

### 9.3 File Import Rules

| From | Can Import | Cannot Import |
|------|-----------|---------------|
| Presentation(`"use client"`) | `access-tabs`, `client-runtime`, `session-client`, `hr-company-catalogs`, `chat-mentions`, `chat-client`, 다른 Presentation 모듈, React | `hr-company-data`(`server-only`), `erp-platform`, `auth-session`, `auth-password`, `chat-server`, `chat-schema`, `request-guard`는 필요 없음 |
| Application(`app/api/**/route.ts`) | Infrastructure, Domain, `cloudflare:workers`, `next/headers`(`headers()`만) — 확장자 없는 상대 경로의 `.ts`만 | `@/…`, 디렉터리 index, `.tsx`, `cookies()`, `'use server'` |
| Domain | 없음(순수). `auth-password`는 WebCrypto만 | 모든 앱 모듈, `cloudflare:*` |
| Infrastructure | Domain, `cloudflare:workers`, `next/headers` | Presentation, Application |
| `worker/index.ts` | `request-guard`, `vinext/server/app-router-entry` | 그 밖의 앱 모듈 |
| `build/local-peer-vite-plugin.ts` | Vite·Node 타입 | 앱 코드 전부 |
| `scripts/*.mjs` | `node:*`, `scripts/lib/*`. `import-leave-ledger.mjs`는 기존처럼 `app/hr-leave-accrual.ts` | 서버 라우트 모듈 |

### 9.4 This Feature's Layer Assignment

| Component | Layer | Location |
|-----------|-------|----------|
| 탭 레지스트리, `canAccess`, `isHrManager` | Domain | `app/access-tabs.ts` |
| 교차 출처 판정 | Domain | `app/request-guard.ts` |
| PBKDF2 해시·검증·임시 비밀번호 | Domain | `app/auth-password.ts` |
| HR 전이 문장 생성기 | Domain | `app/hr-transitions.ts` |
| 멘션 추출·강조 조각 | Domain | `app/chat-mentions.ts` |
| 조직·직급·직책 카탈로그 | Domain(데이터, 클라이언트 허용) | `app/hr-company-catalogs.ts` |
| 세션 저장소, 예약, peer, principal | Infrastructure | `app/auth-session.ts` |
| 게이트 스키마, 인가 가드, 감사, `opsSchemaStatements` | Infrastructure | `app/erp-platform.ts` |
| 채팅 DDL·시드 | Infrastructure | `app/chat-schema.ts` |
| 채팅 접근 판정·이벤트·DTO | Infrastructure | `app/chat-server.ts` |
| 직원 명부·보상 시드 | Infrastructure(`server-only`) | `app/hr-company-data.ts` |
| peer 기록·경로 차단 | Infrastructure(Node) | `build/local-peer-vite-plugin.ts` |
| 보안 헤더·CSRF 선차단 | Infrastructure(Worker) | `worker/index.ts` |
| me·auth·admin·compensation·chat 라우트 | Application | `app/api/**/route.ts` |
| 세션 상태기계, poll 훅, 대체 함수 | Presentation | `app/session-client.ts`, `app/chat-client.ts`, `app/client-runtime.ts` |
| 셸·화면 | Presentation | `app/page.tsx`, `app/shell-top-nav.tsx`, `app/auth-screens.tsx`, `app/admin-accounts-workspace.tsx`, `app/chat-workspace.tsx` |

---

## 10. Coding Convention Reference

> 기준 문서는 `CLAUDE.md`다(R2·R3에서 갱신). `docs/01-plan/conventions.md`는 이번 사이클에서 만들지 않는다(Plan §8.1).

### 10.1 Naming Conventions

| 대상 | 규칙 | 예 |
|------|------|-----|
| 모듈 파일 | `app/<도메인>-<역할>.ts(x)`. kebab-case로 평탄하게 둔다. 도메인 폴더와 `index.ts`는 만들지 않는다 | `app/auth-session.ts`, `app/hr-transitions.ts`, `app/chat-workspace.tsx` |
| 라우트 | `app/api/<모듈>/<기능>/route.ts`. 정적 세그먼트만 쓰고 대상은 `?id=`로 받는다(하니스 `callApi`는 params를 넘기지 않는다) | `app/api/chat/attachments/route.ts` |
| 컴포넌트 | PascalCase default export. 파일 이름은 kebab-case | `HRWorkspace` ← `hr-workspace.tsx`, `AdminAccountsWorkspace` |
| 함수 | camelCase 동사형 | `resolveSession`, `reserveLoginAttempt`, `crossSiteViolation` |
| 상수 | UPPER_SNAKE. 단위 접미사 `_MS`·`_BYTES`·`_LENGTH` | `SESSION_TTL_MS`, `CHAT_ATTACHMENT_MAX_BYTES`, `PBKDF2_ITERATIONS` |
| 타입 | PascalCase | `ErpPrincipal`, `ResolvedTabs`, `TabDefinition` |
| 테이블·컬럼 | snake_case와 도메인 접두. 불리언은 INTEGER 0/1, 시각은 epoch ms INTEGER | `auth_accounts.must_change_password`, `chat_events.seq`, `ops_backup_runs` |
| 식별자 값 | 접두 + uuid | `acct_…`, `ch_…`, `att_…`, 시드 `ch_general` |
| 감사 action | UPPER_SNAKE. 결과를 과거형으로 | `LOGIN_FAILED`, `ACCOUNT_TABS_UPDATED`, `CHAT_MESSAGE_DELETED` |
| 오류 code | UPPER_SNAKE(§6.1 표) | `PASSWORD_CHANGE_REQUIRED`, `LEGACY_PERIOD_LOCKED` |
| localStorage 키 | `xdnode-<이름>-v<n>`. 반드시 `scopedKey()`를 거친다 | `xdnode-active-tab::acct_…` |
| 테스트 | `tests/<주제>.test.mjs`. `package.json` test 목록에 등록한다 | `tests/auth-session.test.mjs` |
| 운영 스크립트 | `scripts/<Verb>-XDNodeManagement.ps1`. Node 보조 도구는 `scripts/<kebab>.mjs` | `Stop-XDNodeManagement.ps1`, `verify-state-snapshot.mjs` |
| CSS | kebab-case. 탭 셸은 `*-module-shell`(레지스트리 `shellClass`) | `chat-module-shell`, `admin-module-shell` |

### 10.2 Import 규칙

```typescript
// 서버 코드(app/api/**, app/erp-platform.ts, app/auth-*.ts, app/chat-server.ts 등)
import { env } from "cloudflare:workers";                              // 1. 런타임
import { headers } from "next/headers";                                // headers()만. cookies()는 쓰지 않는다
import { authorizeErpRequest, writeErpAudit } from "../../erp-platform"; // 2. 확장자 없는 상대 경로의 .ts
import { isHrManager } from "../../access-tabs";
import type { ErpPrincipal } from "../../erp-platform";                 // 3. 타입

// 클라이언트 코드("use client")
import { useEffect, useState } from "react";                           // 1. 외부
import { randomId, scopedKey } from "./client-runtime";                // 2. 상대 경로
import { TAB_REGISTRY, type TabKey } from "./access-tabs";
import "./chat-workspace.css";                                         // 3. 스타일(전역 CSS는 app/layout.tsx에서)
```

- **서버 코드에서 금지하는 것**(`removal-guards`가 단언한다)
  - `@/…`: `tsconfig.json:16-18`에는 선언돼 있지만 하니스 resolver(`tests/helpers/hr-api-harness.mjs:47-52`)가 해석하지 못한다.
  - 디렉터리 index와 `.tsx` 파일.
  - `cookies()`와 `'use server'`. `'use server'`를 쓰면 빌드의 server-action 경로가 되살아난다.
- **클라이언트가 import하면 안 되는 모듈**: `hr-company-data`(`server-only`), `erp-platform`, `auth-session`, `auth-password`, `chat-server`, `chat-schema`.
- **클라이언트가 import해도 되는 모듈**: `access-tabs`, `client-runtime`, `session-client`, `hr-company-catalogs`, `chat-mentions`, `chat-client`.
- **의존 방향**
  - `access-tabs`와 `request-guard`는 아무것도 import하지 않는다.
  - `auth-session`은 `erp-platform`을 import하지 않는다.
  - `worker/index.ts`가 새로 import하는 것은 `request-guard`뿐이다.

### 10.3 Environment Variables

- 이 앱에는 `NEXT_PUBLIC_*`가 없다. 클라이언트는 env를 받지 않는다.
- 값은 출력하거나 기록하거나 문서에 옮기지 않는다. 이름만 다룬다.

| 이름 | 범위 | 규칙 |
|------|------|------|
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_TRANSCRIPTION_MODEL`, `CLAUDE_BRIDGE_URL`, `CLAUDE_ASSISTANT_BRIDGE_URL` | Worker(preview는 `dist/server/.dev.vars`) | `.dev.vars` 허용 목록은 이 5개뿐이다. `scripts/write-dev-vars.mjs`가 빌드마다 쓰고, 키 이름만 출력한다 |
| `X_LOCAL_EXPLORER` | Node | 항상 `"false"`. `vite.config.ts:28`에서 대입하고(`??=` 금지) 시작 스크립트에서도 설정한다 |
| `XD_NODE_PROJECT_PATH` | 브리지 | 이름을 바꾸지 않는다. 운영에서는 `C:\xdm\prod`를 가리킨다. cwd로는 쓰지 않는다 |
| `XDM_EMAIL`, `XDM_PASSWORD` | 스크립트 실행 때만 | `xdm-login.mjs`가 쓴다. 파일에 저장하지 않는다 |
| `LOCAL_ERP_USER_EMAIL`·`LOCAL_ERP_USER_NAME`(R3, `vite.config.ts:40`), `CLOUDFLARE_AI_MODEL`(R1, `:39`), `GOOGLE_*`(R0) | — | 제거한다. `removal-guards`가 `LOCAL_ERP_USER_EMAIL` 0건을 단언한다 |

### 10.4 라우트 작성 규칙 (CLAUDE.md 골격의 R3 개정)

1. 첫 동작은 `authorizeErpRequest(db, "<문자열 리터럴 모듈>", action)`이다.
   - 그 모듈의 탭은 경로의 `apiPrefixes` 탭과 같아야 한다.
   - 동적 모듈은 `app/api/assistant/route.ts` 하나만 허용한다. 여기서는 `ASSISTANT_MODULES`에 `Object.hasOwn` 검사를 한다.
2. 본문(`json()`·`text()`·`formData()`·`arrayBuffer()`)은 인가 뒤에 읽는다.
3. 스키마 위치
   - 라우트 로컬 `ensureSchema`에는 해당 도메인 테이블(HR 등)만 둔다.
   - 인증·채팅·운영 DDL은 `ensureErpPlatformSchema`(→ `platformSchemaReady`)에만 둔다.
   - 추가만 하고 DROP은 하지 않는다.
4. 쿼리는 raw D1(`prepare`/`bind`/`first`/`all`/`run`/`batch`)로 쓴다.
   - 불리언은 1/0으로 bind한다.
   - 상태 전이는 `WHERE status IN (<from>, <레거시>)`로 걸고 `meta.changes`를 검사한다. 0이면 409 `CONFLICT`다.
   - HR 전이는 `app/hr-transitions.ts`의 생성기로 만든다.
5. 모든 변경 요청은 `writeErpAudit`를 남긴다. 예외는 `chat/read-state` 하나다.
   - 비밀값, 채팅 본문·이름·파일 이름, 질문 본문은 넣지 않는다.
   - auth·admin 이벤트의 `after`에는 항상 `peer`를 넣는다.
6. 오류는 `{ error: "<한국어 문장>", code: "<UPPER_SNAKE>" }` 형태다. 새 라우트와 가드는 반드시 `code`를 붙인다. 기존 HR 라우트의 `{ error }`는 그대로 둔다.
7. Set-Cookie는 Response에 직접 싣는다.
8. 관리자·책임자 분기는 `isHrManager(principal)`로만 한다. self·manager 판정은 `principal.linkedEmployee === true`일 때만, 연결된 `employeeId`로 한다. `acct_…`는 인사기록 id가 아니다.
9. 응답에는 목적에 필요한 필드만 싣는다(§7.9). 새 조회 API를 만들면 탭 대응표(§4.3.2)와 교차 매트릭스에 행을 추가한다.

### 10.5 클라이언트 규칙

- http LAN PC는 보안 컨텍스트가 아니므로 대체 함수를 쓴다(§5.6).
  - `crypto.randomUUID()` 대신 `randomId()`를 쓴다. `"use client"` 파일의 `crypto.randomUUID(`는 가드로 0건을 유지한다.
  - `navigator.clipboard` 대신 `copyText()`를 쓴다.
- localStorage는 `scopedKey()`를 거치고 try/catch로 감싼다. 범위 키가 없으면 레거시 키를 1회 읽은 뒤 지운다.
- HTML 문자열을 주입하지 않는다(`dangerouslySetInnerHTML`·`innerHTML` 금지). 텍스트는 React 노드로만 그린다.
- 응답은 status와 code로 분기한다(§6.3).
  - 401 `UNAUTHENTICATED`: 로그인 화면으로 간다.
  - 403 `PASSWORD_CHANGE_REQUIRED`: 비밀번호 화면으로 간다.
  - 403 `FORBIDDEN`: 토스트를 띄운다. 버튼은 숨기지 않고, HR은 보기 권한 배너를 둔다.
- 권한 없는 탭은 렌더하지 않는다. `TAB_PANELS`는 `Record<TabKey, …>`로 선언해서 패널이 빠지면 컴파일이 실패하게 한다.
- 새 사용자 문구는 모두 한국어로 쓴다. 코드 식별자, 오류 code, 감사 action은 영어로 쓴다. 주석은 기존처럼 한국어로 쓴다.

### 10.6 하니스와 테스트 규칙

- 하니스 구성과 시드는 §8.5다.
- 계정·세션·권한은 실제 라우트로 동작을 검증한다(`callApi` → `{status, body, headers, setCookies}`). 소스 문자열 검사만으로 끝내지 않는다.
- 새 테스트 파일은 `package.json` test 목록에 등록한다. `removal-guards`가 목록과 `tests/*.test.mjs`가 양방향으로 일치하는지 확인한다.
- `build/**`는 lint 대상이 아니다(`eslint.config.mjs:15`). 그래서 `build/local-peer-vite-plugin.ts`는 순수 함수 export와 `local-peer-plugin` 테스트로 지킨다.
- 문서와 주석에 적는 `node_modules` 줄 번호는 §2.3의 설치 버전 기준이다.

### 10.7 탭 추가 방법 (FR-16, CLAUDE.md에 그대로 옮긴다)

1. `app/access-tabs.ts`의 `TAB_REGISTRY`에 항목 1개를 추가한다.
   - 필드: `key`, `label`, `glyph`, `adminOnly`, `modules`, `apiPrefixes`, `shellClass`.
   - `TabKey`·`ErpModule`·`MODULE_TAB`은 자동으로 파생된다.
   - 한 모듈을 두 탭에 넣으면 초기화 때 throw한다.
2. `app/page.tsx`의 `TAB_PANELS`에 항목 1개를 추가한다. 이 저장소에는 타입 검사 단계가 없으므로(빌드는 transpile만) 빠뜨려도 빌드는 통과한다. `shell-tabs`가 레지스트리의 모든 key가 `TAB_PANELS`에 있는지 소스로 단언해 잡는다.
3. `app/api/<새 모듈>/…/route.ts`를 만들고 `authorizeErpRequest(db, "<새 모듈>", …)`를 부른다.
   - 스키마는 라우트 로컬 `ensureSchema`에 둔다.
   - 공용 인증·채팅 DDL은 건드리지 않는다.

- 권한 데이터 마이그레이션은 필요 없다. `tabs_json`에 키가 없으면 `none`이다.
- 계정 관리 화면의 부여 목록은 레지스트리에서 파생된 `grantableTabs`라서 자동으로 늘어난다.
- 새 탭은 기존 테스트가 자동으로 검사한다.
  - `tab-permissions`의 소스 가드: 리터럴 모듈과 접두사가 같은 탭인지 확인한다.
  - `access-policy`: 레지스트리 무결성을 확인한다.

### 10.8 This Feature's Conventions

| Item | Convention Applied |
|------|-------------------|
| Component naming | PascalCase default export, kebab-case 파일(`auth-screens.tsx`의 `LoginScreen`·`BootstrapScreen`·`PasswordChangeScreen`·`AuthLoadingShell`·`RequireTab`) |
| File organization | `app/` 아래 평탄 배치(`auth-*`, `access-tabs`, `chat-*`, `hr-*`). 라우트는 정적 세그먼트. Node 전용 빌드 도구는 `build/`, 운영 도구는 `scripts/` |
| State management | 기존 `useState`를 유지한다. 인증은 `useSession()` 상태기계(`loading → bootstrap \| login \| password \| ready`), 채팅은 Home 수준의 `useChatPoll()` 하나다 |
| Error handling | `{error(한국어), code}`와 status로 분기한다. 가드 오류(401·403·409·429)는 §6.1 표를 따른다. 거부는 감사(`ACCESS_DENIED`, `LOGIN_BLOCKED`)로 남긴다 |
| Security defaults | fail closed, 인가를 본문보다 먼저, 서버가 최종 방어, 실데이터는 API로만, 감사에 비밀값·본문 없음 |

---

## 11. Implementation Guide

### 11.1 File Structure

```
app/
├── access-tabs.ts                 R3  탭 레지스트리(§4.3.1)
├── auth-password.ts               R3  PBKDF2, 임시 비밀번호, 상수 시간 비교
├── auth-session.ts                R3  authSchemaStatements, 세션, 예약, peerOf, toPrincipal
├── request-guard.ts               R3  crossOriginWriteViolation, crossSiteViolation
├── session-client.ts              R3  useSession()
├── client-runtime.ts              R3  randomId, copyText, setStorageScope, scopedKey
├── auth-screens.tsx               R3  Login/Bootstrap/PasswordChange/AuthLoadingShell/RequireTab
├── shell-top-nav.tsx              R3  ShellTopNav, resolveActiveTab
├── admin-accounts-workspace.tsx   R3
├── hr-transitions.ts              R1  HR 전이 문장 생성기(§12.2)
├── hr-company-catalogs.ts         R1  조직·직급·직책(클라이언트 허용)
├── hr-company-data.ts             R1 수정: import "server-only"
├── erp-platform.ts                R1·R3 수정, R4 opsSchemaStatements
├── chat-schema.ts                 R5
├── chat-server.ts                 R5
├── chat-mentions.ts               R5
├── chat-client.ts                 R5
├── chat-workspace.tsx / .css      R5
├── page.tsx                       R1 정리, R3 TAB_PANELS
├── incentive/                     유지(D1): page.tsx, layout.tsx, incentive-calculator.tsx, incentive.module.css
└── api/
    ├── me/route.ts                               R3
    ├── auth/{login,logout,password,bootstrap}/route.ts   R3
    ├── admin/accounts/route.ts                   R3
    ├── admin/backups/route.ts                    R4
    ├── compensation/route.ts                     R3 (git mv ← api/hr/compensation)
    ├── compensation/roster/route.ts              R3
    ├── chat/{channels,messages,poll,attachments,read-state}/route.ts   R5
    ├── hr/* (authorized-users·compensation 제외 18개), documents, assistant, audit-log   유지
build/local-peer-vite-plugin.ts    R3
worker/index.ts                    R3 수정
scripts/
├── lib/d1-state.mjs               R1
├── verify-state-snapshot.mjs      R1(R4 --record-run)
├── write-dev-vars.mjs             R3
├── reset-admin-password.mjs       R3
├── xdm-login.mjs                  R3
├── Start-XDNodeManagement.ps1     R2 이름 변경, R3 preview 재작성, R4 -Headless
├── Stop-/Backup-/Deploy-/Register-XDNodeManagement(Tasks).ps1   R4
tests/
├── helpers/hr-api-harness.mjs     R1·R3 수정
├── helpers/tsx-loader.mjs         R3
├── removal-guards, bundle-exposure                         R1
├── auth-session, tab-permissions, access-policy, local-peer-plugin, shell-tabs   R3
└── chat-api                                                R5
docs/
├── lan-operations-runbook.md      R3(R4 보강)
└── archive/                       R1(계획 문서 47개)
```

**신규 파일 50개**

| 경로 | 릴리스 | 목적 |
|------|--------|------|
| `app/hr-transitions.ts` | R1 | 결재 7흐름과 레거시 결정의 문장 생성기. `D1PreparedStatement[]`를 돌려주는 순수 함수이고 `cloudflare:*`를 import하지 않는다. 함수 이름은 §12.2 |
| `app/hr-company-catalogs.ts` | R1 | `companyOrganizations`·`companyRanks`·`companyJobTitles`·`CompanyOrganizationSeed`(현 `app/hr-company-data.ts:23,131-142`). 클라이언트 import를 허용한다. `hr-company-data.ts`가 이 심볼들을 재수출하므로 서버 사용처 13곳(§12.5)의 import는 바뀌지 않는다 |
| `scripts/lib/d1-state.mjs` | R1 | `findAppDatabase(stateDir)`: `d1/miniflare-D1DatabaseObject/*.sqlite` 중 `erp_audit_logs`가 있는 파일을 고른다. 빈 잔재(`c9177…`)는 건너뛴다 |
| `scripts/verify-state-snapshot.mjs` | R1 | `node:sqlite`를 `readOnly:true`로 열어 d1·r2 메타 sqlite의 `PRAGMA integrity_check`, 테이블별 행 수, R2 blob 수를 JSON 보고서로 쓴다. `--compare <dir>`는 두 사본을 비교하고, `--record-run <liveStateDir>`(R4)는 백업 결과를 기록한다. 기록 모드 말고는 원본(live) 파일을 열지 않는다. M1-0, R3 데이터 이전, R4 백업, SC-7·SC-13에 쓴다 |
| `tests/removal-guards.test.mjs` | R1(R2·R3·R5에서 단언 추가) | §8.6 |
| `tests/bundle-exposure.test.mjs` | R1 | 빌드 후 `dist/client/**/*.js` 전체에서 실데이터 표지 0건(§7.9). `dist/server`는 재무 표지만 0건 |
| `app/access-tabs.ts` | R3 | 탭 레지스트리(§4.3.1). 순수 모듈이고 import가 없다 |
| `app/auth-password.ts` | R3 | `hashPassword`, `verifyPassword`, `validatePassword`, `generateTemporaryPassword`, `getDummyHash()`(처음 쓸 때 1회 계산), 상수 시간 비교(§7.4) |
| `app/auth-session.ts` | R3 | `authSchemaStatements(db)`, `readSessionToken`, `hashToken`, `createSession`, `resolveSession`, `revokeAccountSessions`, `sessionCookie`, `clearedSessionCookie`, `reserveLoginAttempt`(§7.4), `peerOf(headers)`, `toPrincipal`, `unlinkedAccountNames(db)`. `erp-platform`을 import하지 않는다 |
| `app/request-guard.ts` | R3 | 순수 모듈. `crossOriginWriteViolation(method, headers)`(worker용), `crossSiteViolation(headers)`(가드·인증 라우트용)(§7.3) |
| `app/session-client.ts` | R3 | 클라이언트 `useSession()`. 상태기계(§5.2), focus·visibilitychange와 60초마다 다시 조회, `logout()`. page.tsx와 `/incentive`가 함께 쓴다 |
| `app/client-runtime.ts` | R3 | `randomId()`(`getRandomValues`), `copyText()`(clipboard가 안 되면 textarea+`execCommand`), `setStorageScope(accountId)`, `scopedKey(key)`, `clearScopedDataKeys()`(로그아웃·401 때 급여성 데이터 키 4개 삭제, §5.5) |
| `app/auth-screens.tsx` | R3 | `LoginScreen`, `BootstrapScreen`, `PasswordChangeScreen`(강제·자발), `AuthLoadingShell`(`data-auth-gate="loading"`), `RequireTab` |
| `app/shell-top-nav.tsx` | R3 | `ShellTopNav`와 순수 함수 `resolveActiveTab(tabs, saved)`. CSS와 서버 모듈은 import하지 않는다 |
| `app/admin-accounts-workspace.tsx` | R3 | 계정 관리 탭(§5.4) |
| `app/api/me/route.ts` | R3 | §4.2.1 |
| `app/api/auth/login/route.ts`, `logout`, `password`, `bootstrap` (4개) | R3 | §4.2.2~§4.2.5 |
| `app/api/admin/accounts/route.ts` | R3 | §4.2.6 |
| `app/api/compensation/roster/route.ts` | R3 | §4.2.7 |
| `build/local-peer-vite-plugin.ts` | R3 | §7.6 |
| `scripts/write-dev-vars.mjs` | R3 | `.env.local`에서 허용 키 5개(§10.3)만 골라 `dist/server/.dev.vars`에 쓴다. 값은 출력하지 않는다 |
| `scripts/reset-admin-password.mjs` | R3 | §11.5.6 |
| `scripts/xdm-login.mjs` | R3 | `XDM_EMAIL`·`XDM_PASSWORD`로 로그인해 쿠키를 돌려준다. 비GET 요청에는 `Origin: <base>`를 붙인다. `import-leave-ledger.mjs`와 `restore-known-data.mjs`가 쓴다 |
| `tests/helpers/tsx-loader.mjs` | R3 | `.ts/.tsx`를 ReactJSX로 변환하고, `*.css`는 빈 모듈, `server-only`는 스텁으로 둔다 |
| `tests/auth-session.test.mjs`, `tab-permissions`, `access-policy`, `local-peer-plugin`, `shell-tabs` (5개) | R3 | §8.6 |
| `docs/lan-operations-runbook.md` | R3(R4 보강) | 방화벽, 부트스트랩(서버 PC의 `http://localhost:3000`에서만), 운영 폴더, 데이터 이전, 스크립트 계정(첫 로그인 때 UI에서 비밀번호 1회 변경), 보안 컨텍스트 한계, 평문 HTTP 한계, 부수효과 GET 한계, 계정 존재 노출 한계, reset-admin-password, portproxy 금지, 미지원 런타임(`wrangler dev`, `vinext start`) |
| `scripts/Stop-XDNodeManagement.ps1`, `Backup-`, `Deploy-`, `Register-XDNodeManagementTasks.ps1` (4개) | R4 | §11.5.8 |
| `app/api/admin/backups/route.ts` | R4 | §4.2.6 |
| `app/chat-schema.ts` | R5 | `chatSchemaStatements(db)`와 `ch_general` 시드 |
| `app/chat-server.ts` | R5 | `loadChannelAccess`, `appendEvent`, `unreadSummary`, `toMessageDto`, `attachmentKey`, 확장자·MIME 허용표, `escapeLike` |
| `app/chat-mentions.ts` | R5 | 순수 함수 `extractMentions(body, people)`, `highlightMentions` |
| `app/chat-client.ts` | R5 | `useChatPoll()`, fetch 헬퍼 |
| `app/chat-workspace.tsx`, `app/chat-workspace.css` | R5 | CSS는 `app/layout.tsx`에서 전역으로 import한다(`compensation-calculator.css`와 같은 방식) |
| `app/api/chat/{channels,messages,poll,attachments,read-state}/route.ts` (5개) | R5 | §4.2.8 |
| `tests/chat-api.test.mjs` | R5 | FR-12~FR-15 |

수: R1 6, R3 27(모듈 9, 라우트 7, 플러그인 1, 스크립트 3, 테스트 도우미 1, 테스트 5, runbook 1), R4 5, R5 12. `app/api/compensation/route.ts`는 이동이라 신규에 넣지 않는다.

**이동과 이름 변경**
- R1: `docs/finance-*-plan.md`(28), `docs/sales-*-plan.md`(11), master-impact 4, 데이터 거버넌스·인테이크·연동 3, 워크벤치 1, 합계 47개를 `docs/archive/`로 옮긴다(부록 A.4, 2026-09-23 `ls` 47건 확인). HR 계획 문서 5개(workforce-planning, recruitment-requisition, leave-management, performance-management, retirement-compensation)는 옮기지 않고 '즉시 반영' 기준으로 고친다.
- R2: `scripts/Start-XDNodeERP.ps1` → `scripts/Start-XDNodeManagement.ps1`. 같은 커밋에서 `tests/erp-platform.test.mjs:985,2554`, `tests/lan-exposure-guards.test.mjs:10`, `tests/local-codex-assistant.test.mjs:42`를 고친다. `package.json`의 name을 `xdnode-management`로 바꾸고 lockfile을 재생성한다.
- R3: `app/api/hr/compensation/route.ts` → `app/api/compensation/route.ts`(`git mv`, 상대 import `../../../` → `../../`). 참조를 같은 커밋에서 고친다: `app/compensation-calculator.tsx:157,290,351,455,558`, `app/local-codex-assistant.tsx:340,341,459,462,500,503`, `tests/hr-api-integration.test.mjs:85,128`(`callApi('compensation', …)`), `tests/erp-platform.test.mjs:54,851,2571,2652`, `tests/compensation-calculation.test.mjs:122,154`, 주석 `app/hr-severance-calculation.ts:58`.

### 11.2 주요 수정 요지

- `app/erp-platform.ts`
  - R1: `erp_tasks`·`erp_approval_*`·`erp_sync_runs` DDL(`:71-166`), PRAGMA/ALTER(`:175-178`), 재무 헬퍼(`:304-325`), `FINANCE_ADMIN`·`SALES_ADMIN`(`:4,26,29`)을 지운다.
  - R3: import(`:1-2`), `ErpRole`·`rolePermissions`·`parseRoles`·`hasPermission`(`:4,24-31,181-193`), `hr_authorized_users`·`erp_user_access` DDL과 gc.kim 시드(`:39-50,168-173`), 인사기록 403(`:216-218`), `authorizeErpRequest`의 `erp_user_access`·`hr_authorized_users` 조회와 자동 발급(`:220-235`)을 지운다. 스키마 게이트(§3)와 세션 신원으로 교체한다. `authorizeErpRequest(db, module, action)`의 시그니처는 유지한다.
  - R4: `opsSchemaStatements(db)`를 더한다.
- `worker/index.ts`(R3): 비GET 교차 출처 차단을 `/_vinext/image` 분기(`:32`) 앞에, 보안 헤더와 `/api/*`의 기본 `no-store`를 두 분기가 함께 거치는 `finalize()`에 넣는다(`:43-51`의 응답 조립부를 옮긴다).
- `vite.config.ts`
  - R1: `localRuntimeVars`의 `CLOUDFLARE_AI_MODEL`(`:39`)을 지운다.
  - R3: `LOCAL_ERP_USER_*`(`:40`)을 지우고, `plugins`를 `[localPeerPlugin(), vinext(), sites(), cloudflare({ …, inspectorPort:false })]`(`:80-87`)로 바꾼다.
  - `database_id`(`:7-8,58`)와 `bucket_name`(`:66`)은 바꾸지 않는다. `allowedHosts`는 추가하지 않는다(§7.3).
- `app/page.tsx`
  - R1: 재무·영업과 ApprovalCenter(`:26,437`)를 지운다. 임시로 `ModuleKey = 'hr'|'compensation'|'audit'`를 두고 감사 탭을 다시 마운트한다(게이트는 `settings:admin`). `validModuleKeys`(`:500`)와 `compensationAssistantModule`의 `'sales'`(`:511`)도 정리한다.
  - R3: `useSession` 상태기계, `TAB_PANELS`, `ShellTopNav`로 바꾼다.
- `app/hr-workspace.tsx`: R1에 `initialEmployees = []`(`:860`), 카탈로그 import(`:5`) 교체, 마스터 영향(`:13`)·결재 UI 제거, 레거시 승인/반려 버튼을 넣는다. R3에 `access={{canEdit}}` 배너, `/api/assistant?module=hr`(`:3398`), `copyText`(`:3346`), 설정의 '사용자·권한' 절 삭제를 넣는다. 버튼 숨김은 하지 않는다.
- `app/incentive/incentive-calculator.tsx`: R1에 `hr-company-data` import(`:7`)와 `COMPANY_EMPLOYEE_OPTIONS`(`:109-121`)를 지우고 `response.ok` 검사를 넣는다. R3에 `:332`를 `/api/compensation/roster`로 바꾸고, `randomId`(`:56,171,505`)와 `scopedKey`를 쓴다.
- `app/incentive/page.tsx`(R3): `RequireTab tab="compensation"`으로 감싼다.
- `app/local-codex-assistant.tsx`
  - R1: `/api/sales` 조회(`:278-291`)를 지우고 모드 이름을 `incentive`로 바꾼다(`:10,63`).
  - R3: `?module=` 쿼리로 부르고(`:59`), compensation·incentive 모드는 `roster`와 `/api/compensation?include=hr`를 쓴다. HR 모드만 `employee-records`(`:292`)를 쓴다. 적용 버튼(`:459-503`)은 대상 탭이 편집이 아니면 숨긴다. `randomId`(`:413,539,554`)와 `copyText`(`:443`)로 바꾼다.
- `app/compensation-calculator.tsx`: R1에 `'sales'`를 `'incentive'`로 바꾼다(`:621-623`). R3에 `randomId`(`:61,100,371-373`), `scopedKey`(`:28` `STORAGE_KEY`, `:405,421-422`의 인센티브 키)를 쓴다.
- `app/hr-leave-view.tsx`(R3): `copyText`(`:88,214`).
- `app/hr-dashboard-model.ts:356`: R3에 `recruiterOnly`와 `roles` 입력을 지운다.
- `app/api/assistant/route.ts`: R1에 `sales` → `incentive`(`:14,17-21,29-31`, R1에는 `hr` 모듈로 인가). R3에 `?module=`과 인가 선행.
- `app/api/audit-log/route.ts`, `app/audit-log-workspace.tsx`: R1에 재마운트, R3에 `audit:read`, 필터 목록(`:22`)·`moduleLabel`(`:18`)·`auth_accounts` 조인.
- `app/api/hr/operations/route.ts`(R3): GET 응답 `principal:{roles}`(`:247`) → `access:{hr,isAdmin}` + `accountNames`.
- `app/layout.tsx`: R2에 제목·설명(`:13-28`), R5에 `chat-workspace.css` import.
- `scripts/import-leave-ledger.mjs`·`restore-known-data.mjs`(R3): `xdm-login.mjs`로 로그인한다. `restore-known-data.mjs:62`의 `LOCAL_ERP_USER_EMAIL` 안내 문구와 `autoApproved` 의존(`:54`)을 고친다.
- `CLAUDE.md`: R2에 표시명과 구조를 고친다. R3에 다음을 더한다.
  - '탭 추가 방법'(§10.7): 레지스트리 1항목, `TAB_PANELS` 1항목, `authorizeErpRequest(db,'<module>',…)`를 부르는 라우트
  - 인증·채팅 DDL은 게이트 스키마에만 둔다
  - 하니스 규칙(§8.5)
  - 운영 런타임은 `vite preview`, `vinext start`·`wrangler dev`는 쓰지 않는다

### 11.3 Implementation Order

1. [ ] **R1**(M1): `r1-preflight` → `r1-decouple` → `r1-platform` → `r1-shell-pii` → `r1-delete` → `r1-verify`. 파일 삭제 전에 결합을 끊는다(§12).
2. [ ] **R2**(M2): 리네임과 `database_id`·`bucket_name` 가드.
3. [ ] **R3**(M3+M4+M5a): `r3-auth` → `r3-tabs` → `r3-shell` → `r3-runtime`을 한 브랜치에서 개발하고, **`r3-cutover`에서만** 운영에 반영한다. 중간 커밋은 운영 PC에 올리지 않는다(Plan R3의 네 가지 깨짐).
4. [ ] **R4**(M5b): `r4-scripts` → `r4-backup` → `r4-autostart` → `r4-deploy`.
5. [ ] **R5**(M6): `r5-core` → `r5-poll` → `r5-attachments` → `r5-ui`. 레지스트리 chat 항목·패널·라우트·DDL을 한 묶음으로 넣는다(되돌리기 단위).
6. [x] **R6**(M7): 수동 체크리스트(FR-18, §11.5.10).

공통 원칙(모든 릴리스): 배포 전 git 태그, 서버·브리지를 `taskkill /T`로 완전히 정지한 뒤 저장소 밖 스냅샷, 스키마는 추가만(D4), 단계마다 `npm run lint && npm test`, R3부터는 운영 폴더에서 업무 시간 밖에 배포.

### 11.4 Session Guide

> `/pdca do xdnode-management --scope <key>`로 한 scope씩 진행한다. 부모 키 `r1`~`r6`은 하위 scope를 아래 순서대로 실행한다.

#### Module Map

| Module | Scope Key | Description | Estimated Turns |
|--------|-----------|-------------|:---------------:|
| R0 | `r0` | 코드 완료. 남은 것: 사용자 작업(Google 서비스 계정 키 폐기, refresh token 철회, `.env.local`의 `GOOGLE_*` 줄 삭제, `CLOUDFLARE_API_TOKEN` 교체 검토)과 Plan R0 '확인(D16 기준)' 2건(다른 PC에서 `http://<서버IP>:3000` 접속 거부, 서버 PC에서 `curl.exe -H "Host: localhost"`로 `/cdn-cgi/explorer/api/d1/database`·`/.wrangler/state/v3/d1/`·`/xdnode-erp-v119.tar.gz` 3건이 404/403). `r1-preflight` 전에 결과를 기록한다. 코드 scope가 아니다 | — |
| M1-0 | `r1-preflight` | WIP 커밋, `erp-final-20260923` 태그와 `archive/erp-finance-sales-20260923` 브랜치, `taskkill /T` 정지 후 스냅샷, `scripts/lib/d1-state.mjs`·`verify-state-snapshot.mjs`, HR 테이블 직접 조회(레거시 대기 행), `sales_incentive_payroll_links`(`payroll_period`·`applied_amount`), `payroll:%` 재무 행. 결과로 §12.3의 정적 목록을 정한다 | 15-20 |
| M1-1 | `r1-decouple` | `app/hr-transitions.ts`, 7흐름 즉시 반영, 레거시 결정 PUT과 승인/반려 버튼, 직접 SQL 5곳, payroll 재무 연결 3곳, compensation 영업 합산 제거, documents import·분기 제거(POST 인가 선행 포함, §12.3), organizations 마스터 영향, assistant `incentive`(R1에서는 `hr` 모듈로 인가), ApprovalCenter·ApprovalSettings·결재 라벨, 성과 이의제기 `RESOLVED`, authorized-users(`:9` allowedRoles)·roleLabels(`hr-workspace.tsx:4512`)의 재무/영업 역할, 테스트 기대값 | 50-60 |
| M1-2 | `r1-platform` | 결재·업무·동기화 DDL 중단, 재무 헬퍼와 역할 제거. 새 DB 하니스로 확인 | 15-20 |
| M1-3 | `r1-shell-pii` | page.tsx 정리와 감사 탭 재마운트, `hr-company-catalogs.ts` 분리(`hr-company-data.ts`에 `import "server-only"`, 값 대조), `initialEmployees=[]`, 인센티브 계산기의 정적 명부 제거, 하니스 `server-only` 스텁 | 30-40 |
| M1-4 | `r1-delete` | 120개 일괄 삭제(`incentive-governance.tsx` 포함, D22), 재무 실데이터를 작업 트리 밖으로, finance 테스트 5개 삭제, removal-guards·bundle-exposure, erp-platform·workflow-ledgers 테스트 정리, 문서 archive, HR 문서 수정, PRD 문구 정정(T-01, T-08, Workstream R, D1의 incentive-governance), CSS 정리 | 40-50 |
| M1-5 | `r1-verify` | R1 직전 사전 조회 재실행, SC-4를 서버 PC에서(기존 D1 사본과 새 DB) | 10-15 |
| M2 | `r2` | 표시명, `package.json` name·engines, 시작 스크립트 이름과 참조 테스트, 바탕화면 바로가기를 `Start-XDNodeManagement.ps1`로 갱신(`XDNODE 견적서 서버` 작업은 건드리지 않음), README·CLAUDE.md, `database_id`·`bucket_name` 가드 | 15-20 |
| M3 | `r3-auth` | `auth-password`·`auth-session`·`request-guard`, erp-platform 재작성(게이트, 세션 신원, `ErpPrincipal`), chatgpt-auth 삭제, me·auth·admin/accounts 라우트, worker 헤더와 CSRF, reset-admin-password, 하니스 세션화와 `setIdentity` shim, auth-session 테스트 | 50-60 |
| M4 | `r3-tabs` | access-tabs, 모듈 인자 수정과 인가 선행(8곳), `/api/compensation` 이동과 roster, `isHrManager`, `acct_` 가드, operations `access`·`accountNames`, audit-log, authorized-users와 hr-local-permissions 삭제, tab-permissions·access-policy, `setIdentity` 호출부 이전과 shim 삭제, hr-dashboard-model 정리 | 40-50 |
| M4 UI | `r3-shell` | session-client, auth-screens, shell-top-nav, `TAB_PANELS`, admin-accounts-workspace, `/incentive` `RequireTab`, client-runtime(`randomId`·`copyText`·`scopedKey`), 계산기·어시스턴트의 모드별 데이터 경로, tsx-loader와 shell-tabs, rendered-html 재작성 | 40-50 |
| M5a | `r3-runtime` | local-peer 플러그인과 테스트, vite.config(플러그인, `inspectorPort:false`, env 정리), npm scripts, write-dev-vars, 시작 스크립트를 preview로 재작성, xdm-login과 import-leave-ledger·restore-known-data, Package-XDNodeDemo 삭제, runbook, lan-exposure-guards 확장, CLAUDE.md '탭 추가 방법' | 30-40 |
| 전환 | `r3-cutover` | 수동: §11.5.9 운영 전환 1~10단계와 추가 스모크, 점검용 인스턴스에서 SC-4, SC-5·SC-9·SC-13 | 사용자와 함께 |
| M5b | `r4-scripts` | `-Headless`, pid, 헬스체크, 로그 회전, Stop 스크립트 | 15-20 |
| M5b | `r4-backup` | Backup 스크립트, `ops_backup_runs`, `/api/admin/backups`와 관리자 화면 경고, 복구 리허설(SC-7의 로그인·HR 조회 부분. 채팅 부분은 `r5-ui`에서 재실행) | 20-30 |
| M5b | `r4-autostart` | Register 스크립트, 전원 설정(`powercfg`, 사용 시간 08:00~20:00), 재부팅 리허설(SC-12), 필요하면 대체안으로 전환 | 사용자와 함께 |
| M5b | `r4-deploy` | Deploy 스크립트와 중단 시간 측정 | 15-20 |
| M6 | `r5-core` | `app/chat-schema.ts`(게이트에 합류), 레지스트리 chat 항목과 `TAB_PANELS.chat`, chat-server·chat-mentions, channels·messages·read-state 라우트, chat-api 테스트(1차) | 50-60 |
| M6 | `r5-poll` | `/api/chat/poll`, `chat-client.ts`의 `useChatPoll`, 배지와 title, SC-6 측정 | 25-30 |
| M6 | `r5-attachments` | `/api/chat/attachments`, R2 `chat/` 접두사, 첨부 테스트 | 20-30 |
| M6 | `r5-ui` | chat-workspace.tsx·.css, 스레드·검색·멘션 강조, SC-2의 chat 열, SC-7 채팅 부분 복구 리허설(채팅 기록·첨부 R2 객체) | 40-50 |
| M7 | `r6` | 수동 체크리스트(폴더·저장소 리네임, FR-18, §11.5.10) | 사용자와 함께 |

#### Recommended Session Plan

| Session | Phase | Scope | Turns |
|---------|-------|-------|:-----:|
| 1 | Plan + Design | 전체(완료) | — |
| 2 | Do | `r1-preflight` + `r1-platform` | 30-40 |
| 3 | Do | `r1-decouple` | 50-60 |
| 4 | Do | `r1-shell-pii` + `r1-delete` + `r1-verify` | 80-100 |
| 5 | Do | `r2` | 15-20 |
| 6 | Do | `r3-auth` | 50-60 |
| 7 | Do | `r3-tabs` | 40-50 |
| 8 | Do | `r3-shell` + `r3-runtime` | 70-90 |
| 9 | 운영 | `r3-cutover`(사용자와 함께) | — |
| 10 | Do | `r4-*` | 50-70 |
| 11 | Do | `r5-core` + `r5-poll` | 75-90 |
| 12 | Do | `r5-attachments` + `r5-ui` | 60-80 |
| 13 | Check + Report | 전체 | 30-40 |

`r1-platform`은 직접 SQL 5곳 삭제(`r1-decouple`)와 같거나 그보다 뒤 커밋이어야 한다. 세션 2에서 먼저 하면 DDL 중단 커밋만 세션 3 끝으로 미룬다.

### 11.5 운영 설계 (R3·R4)

#### 11.5.1 경로
- 운영 `C:\xdm\prod`(D18), 점검용 `C:\xdm\staging`(포트 3001)
- 백업 `C:\xdm\backup\yyyy-MM-dd\`(경로 120자 이하), blob 단일 저장소 `C:\xdm\backup\r2-blobs\`
- 스냅샷 `C:\xdm\snapshots\<label>-yyyyMMdd-HHmm\`
- 재무 보관 `C:\xdm\archive\finance-data-20260923\`
- 로그 `C:\xdm\logs\xdm-yyyyMMdd.log`(14일)
- pid `C:\xdm\run\xdm-management.pid`
- `C:\xdm\*` 전체의 ACL은 서버 사용자로 제한한다.
- 상태 파일: `.wrangler/state/v3`는 실행 폴더 기준이다(스파이크). 실제 DB는 `d1/miniflare-D1DatabaseObject/faaf2b….sqlite`(13.4MB)이고 `c9177…sqlite`(4KB)는 빈 잔재다. 백업은 폴더 전체를 복사한다.

#### 11.5.2 포트
3000(운영 preview 0.0.0.0), 3001(점검용), 3100(개발 dev, 127.0.0.1, `--strictPort`), 3120(이력서 브리지), 3130(어시스턴트 브리지, 둘 다 127.0.0.1), 8765(견적 툴, 건드리지 않음), 9229·9230(`inspectorPort:false`라 열리지 않음). 3110 Codex 브리지는 기동하지 않는다.

#### 11.5.3 npm scripts
- `"dev": "vinext dev --hostname 127.0.0.1 --port 3100 --strictPort"`(r3-runtime부터. 전환 뒤에도 개발 폴더에서 dev를 쓰므로 운영 3000·점검 3001과 겹치지 않게 한다. R1~R2에는 시작 스크립트가 `-- --port 3000`을 넘겨 지금처럼 3000에서 돈다)
- `"serve:lan": "vite preview --host 0.0.0.0 --port 3000 --strictPort"`
- `"start": "vite preview --host 127.0.0.1 --port 3000 --strictPort"`(서버 PC 점검용. 현재 `vinext start`는 D1·R2가 없어 쓸 수 없다)
- `engines.node >=22.15.0`(R2, 현재 `>=22.13.0`. 하니스가 `module.registerHooks`를 쓴다)

#### 11.5.4 시작 스크립트 `Start-XDNodeManagement.ps1`
- R3 순서
  1. `dist/.build-rev`(`git rev-parse HEAD`)가 다르면 build
  2. `node scripts/write-dev-vars.mjs`
  3. `$env:X_LOCAL_EXPLORER="false"`
  4. `npm run serve:lan`
  5. 브리지 3120·3130 기동. `XD_NODE_PROJECT_PATH`는 운영 폴더를 가리킨다.
- R4 보강: `-Headless`(Read-Host와 브라우저 없음), pid 파일, 헬스체크(`GET http://127.0.0.1:3000/api/me` → 401이면 정상), 날짜별 로그(14일).
- `Stop-XDNodeManagement.ps1`은 pid 기준 `taskkill /T /F`로 workerd까지 끈다.

#### 11.5.5 `.dev.vars`
- preview는 빌드 산출물의 `vars:{}`를 쓰고 `vinext build`는 매번 dist를 지운다. 그래서 빌드할 때마다 `write-dev-vars.mjs`가 허용 목록 5개만 `dist/server/.dev.vars`에 쓴다(스파이크: preview가 이 파일을 읽음).
- 기동 뒤 HR 전사 1건으로 확인한다.
- 이 파일에는 토큰이 평문으로 있다. HTTP로 새지 않는지 R3 7단계 스모크(SC-9)에서 `/.dev.vars`·`/server/.dev.vars`·`/dist/server/.dev.vars`·`/.env.local`·`/wrangler.json` 404로 확인하고, `lan-exposure-guards`(R3)가 `dist/client` 아래 `.dev.vars`·`.env*` 0개를 단언한다.

#### 11.5.6 `scripts/reset-admin-password.mjs`
- 앱이 정지된 상태에서만 실행한다. 대상 `--state` 폴더를 쓰는 서버가 떠 있으면 거부한다: 운영 pid 파일(`C:\xdm\run\xdm-management.pid`)의 프로세스가 살아 있거나 127.0.0.1:3000에 연결되면 거부하고, `--state`가 개발 폴더면 127.0.0.1:3100도 확인한다.
- `--email`, `--state` 인자를 받는다. DB 파일은 `scripts/lib/d1-state.mjs`로 찾는다.
- 잠금을 풀고, 임시 비밀번호를 발급해 콘솔에 1회 보여 주고, `must_change_password=1`로 두고, 세션을 모두 폐기하고, SYSTEM 감사 행 `ACCOUNT_PASSWORD_RESET_OFFLINE`을 남긴다.
- 해시 형식은 `auth-password.ts`와 같다(`crypto.webcrypto`, 같은 iter 상수를 `access-policy`가 단언).

#### 11.5.7 방화벽
- `XDnode management 3000 (LAN)`은 R0에 만들어 꺼 둔 규칙이다(Private, LocalSubnet). R3 7단계에서 RemoteAddress를 점검 PC IP로 바꿔 켜고, 8단계에서 LocalSubnet으로 넓힌다.
- `XDnode management 3001 (staging)`은 점검이 끝나면 지운다.
- 브리지 포트 3120·3130은 localhost 전용을 유지한다. 서버 PC에 고정 LAN IP를 준다.

#### 11.5.8 작업 스케줄러·백업·복구·배포 (R4)
- 작업(`Register-XDNodeManagementTasks.ps1`)
  - `XDnodeManagement-Autostart`: 시스템 시작 시, 서버 사용자, 로그온 여부와 관계없이 실행(암호 저장), 5분 간격 3회 재시도, `Start-XDNodeManagement.ps1 -Headless`
  - `XDnodeManagement-Backup`: 매일 03:00
  - 모든 재기동(백업·Deploy·수동)은 `Start-ScheduledTask XDnodeManagement-Autostart`로만 한다.
  - 대체안은 자동 로그온과 '로그온 시' 트리거다(D19). 바꾸면 두 작업 모두 '사용자가 로그온할 때만 실행'으로 다시 등록한다.
  - `XDNODE 견적서 서버` 작업은 건드리지 않는다.
- 전원: `powercfg`로 절전·최대 절전을 끄고, Windows Update 사용 시간을 08:00~20:00으로 둔다.
- 백업 순서(`Backup-XDNodeManagement.ps1`)
  1. Stop
  2. d1과 r2 메타데이터의 `*.sqlite`·`-wal`·`-shm`을 날짜 폴더로 복사
  3. R2 blob을 `robocopy /E`로 단일 저장소에 복사(삭제하지 않음)
  4. `verify-state-snapshot.mjs`로 사본을 read-only로 검사하고 `backup-report.json`을 쓴 뒤, 사본 파일에 `attrib +R`
  5. `--record-run`으로 `ops_backup_runs`에 기록(성공·실패 모두)
  6. 재기동
  7. 14개만 남기고 정리
  8. `-MirrorRoot`로 2차 복사
  - `.env.local`은 넣지 않는다.
  - Plan의 순서(재기동 → 검증)와 달리, 기록을 정지 중에 하기 위해 검증을 재기동보다 앞에 둔다.
  - 백업 성공 = 복사 완료 + `integrity_check` ok + 보고서 기록.
- 복구(SC-7): 정지 → d1·r2 메타 교체 + blob 복사 → 기동 → 로그인·HR 조회를 확인한다(R4). R5 뒤에 한 번 더 실행해 채팅 기록 조회와 첨부 다운로드(R2 `chat/` 객체)를 확인한다(`r5-ui`). 채팅 poll은 `since > head`면 `resync`로 다시 맞춘다(§4.2.8). 온라인 백업(`VACUUM INTO`)은 쓰지 않는다.
- Deploy 순서(`Deploy-XDNodeManagement.ps1`, 운영 폴더, 업무 시간 밖)
  1. 태그 확인
  2. Stop
  3. 스냅샷과 검증
  4. checkout
  5. (lock이 바뀌었으면) `npm ci`
  6. `npm run build`(`npm test`는 운영 폴더에서 돌리지 않는다)
  7. write-dev-vars와 build-rev
  8. `Start-ScheduledTask`
  9. 헬스체크
  - 실패하면 직전 태그로 다시 빌드한다. 중단 시간을 한 번 재서 기록한다.

#### 11.5.9 R3 운영 전환 순서 (업무 시간 밖, 수동)
1. 개발 폴더에서 lint·test가 통과한 커밋에 R3 태그를 단다.
2. 운영 폴더를 준비한다. `C:\xdm\prod`에 clone, R3 태그 checkout, `npm ci`, build. 운영 폴더 `.env.local`에는 허용 목록 키만 둔다. 롤백용으로 개발 폴더 `.env.local`의 `LOCAL_ERP_USER_EMAIL`·`LOCAL_ERP_USER_NAME` 두 줄을 저장소 밖에 따로 보관한다.
3. 개발 폴더의 dev 서버와 브리지를 `taskkill /T`로 정지한다.
4. 데이터 이전(한 번만): `.wrangler/state/v3` 전체를 저장소 밖 날짜 폴더(R3 직전 스냅샷)와 운영 폴더에 복사하고, `verify-state-snapshot.mjs --compare`로 원본·두 사본의 integrity·행 수·R2 수를 비교한다. 하나라도 다르면 멈춘다.
5. 방화벽 3000 규칙을 끈 채 운영 폴더에서 preview와 브리지를 기동한다. R4 전까지는 대화형 세션에 묶여 있으므로 로그오프하지 않는다(화면 잠금만).
6. 서버 PC의 `http://localhost:3000`에서 첫 관리자를 만든다. 기존 HR 직원 조회, R2 녹음 1건 다운로드, HR 전사 1건으로 이전을 확인한다(SC-13).
7. 3000 규칙의 RemoteAddress를 점검 PC IP로 바꾼 뒤 켠다. 점검 PC에서 운영 데이터를 바꾸지 않는 스모크를 한다.
   - 부트스트랩 경로 403(`x-xdm-peer: 127.0.0.1`을 위조한 POST 포함)
   - explorer 404(Host 위조 포함), `/__debug` 404
   - `/.wrangler/…`, `/app/*.ts`, `/*.tar.gz` 404 또는 403(SC-9)
   - `/.dev.vars`, `/server/.dev.vars`, `/dist/server/.dev.vars`, `/.env.local`, `/wrangler.json` 404(SC-9. `dist/server/.dev.vars`에 Cloudflare 토큰이 평문으로 있다)
   - 서버 PC에서 9229·9230이 LISTEN 상태가 아님, `netsh interface portproxy show all`이 비어 있음
   - `Upgrade: websocket` 요청은 끊김
   - 로그인, HR 직원 조회, 어시스턴트 1건, 이력서 분석 1건(SC-5)
   - 견적 툴(8765)이 요청 헤더를 로그에 남기지 않는지 확인(R-2)
   - SC-4는 점검 인스턴스에서 한다: `C:\xdm\staging`에 같은 태그와 4단계 사본(또는 새 DB)을 두고 3001에 preview, `http://localhost:3001`에서 점검용 첫 관리자, 3001 규칙(점검 PC IP)을 켜고 실행, 끝나면 규칙과 인스턴스(사본 포함)를 지운다.
8. 규칙을 LocalSubnet으로 넓힌다. LAN이 열리고 D16 기간이 끝난다.
9. 계정을 발급한다. 스크립트 계정은 첫 로그인 때 UI에서 비밀번호를 1회 바꾼다.
10. 이전이 확인되면 개발 폴더의 원본 `.wrangler/state`를 저장소 밖 보관 폴더로 옮긴다. 이후 개발 폴더는 빈 DB나 백업 사본으로 시작한다.

**실행 결과 (2026-09-29, R3 운영 전환 완료)**
- 태그 `r3-release-20260929`(`bf98693`). 수습 임금 규칙 `3c5d8db`를 병합했다.
- 운영 폴더 `C:\xdm\prod`: clone, 태그 checkout, `npm ci`, build를 했다. `.env.local`에는 허용 목록 키 2개만 두었다.
- 데이터 이전
  - 스냅샷 `C:\xdm\snapshots\r3-pre-20260929-0957\`: integrity ok, 테이블 167, R2 153.
  - 운영 사본: 원본과 행 수가 같고(`--compare` same), `.sqlite` 파일 해시도 같다.
- preview `0.0.0.0:3000`, 브리지 3120·3130. 인스펙터 LISTEN 없음, portproxy 없음.
- 첫 관리자는 사용자가 서버 PC `localhost:3000`에서 만들었다. 기존 HR 데이터가 보이는 것을 확인했다.
  - 좁은 화면에서 탭 줄이 잘려 '계정 관리' 탭이 가려지는 레이아웃 문제가 있다. `.erp-module-tabs { min-width:0 }`가 넘친 부분을 자른다. 후속으로 고친다.
- 방화벽
  - Windows 가 서버 기동 때 'Query User' `node.exe` 허용 규칙 2개(전 포트·전 상대, 개인 프로필)를 자동으로 만들었다. 이런 규칙에는 조건을 붙일 수 없어 지웠다.
  - 대신 `XDnode management 3000 (LAN)` 규칙에 프로그램 조건 `node.exe`를 붙였다. 프로그램 규칙이 있으면 Windows 가 다시 묻지 않는다.
  - 규칙을 점검 PC 192.168.0.98 에만 연 뒤, 스모크(A·B·C 전 항목 기대대로)를 확인하고 `LocalSubnet`으로 넓혔다. D16 기간이 끝났다.
- 개발 폴더 정리
  - 원본 state는 `C:\xdm\archive\dev-state-pre-r3-20260929`로 옮겼다. 개발 폴더에는 이제 운영 데이터가 없다.
  - 개발 브랜치를 R3로 fast-forward 했다.
  - 바탕화면 바로가기는 운영 폴더 스크립트를 가리킨다.
  - 작업 폴더 `C:\xdm\dev-r3`는 지웠다.
- 남은 일(R4 전): 자동 백업이 없고, 서버가 대화형 세션에 묶여 있다(로그오프 금지, 화면 잠금만). R4를 가장 먼저 한다.

**R4 운영 적용 결과 (2026-09-29)**
- 첫 적용(`r4-release-20260929`)
  - Deploy 는 자동 기동 작업이 있어야 돌므로, 첫 적용만 수동으로 했다. 순서는 Stop → 스냅샷 `C:\xdm\snapshots\pre-r4-20260929-113816` → checkout → Start 이다.
  - 스냅샷은 integrity ok 이고, R2 153개 중 누락은 0개다. 중단 시간은 약 1분이다.
- 작업 등록
  - 사용자가 관리자 PowerShell 에서 `-Mode Startup` 으로 등록했다. 암호는 Windows 로그인 비밀번호다. PIN 은 받지 않아서 비밀번호를 먼저 정했다.
  - 전원은 AC 절전을 0 으로 두었다.
- 첫 백업(11:50): OK. 중단 시간은 약 20초다.
- r4.1: HR 어시스턴트가 모든 질문에 "첨부한 자료가 너무 큽니다"로 실패했다.
  - 원인: `/api/hr/operations` 원본을 그대로 맥락에 실었다. 연차 원장에서 가져온 휴가 신청 407건만 약 185KB 였고, 브리지 한도는 192KB 다.
  - `compactOperationsContext` 로 줄였다. 184.5KB 가 27.2KB 가 됐다.
- r4.2: 작업 스케줄러가 띄운 프로세스를 다른 로그온 세션에서 끌 수 없었다.
  - r4.1 Deploy 가 Stop 에서 액세스 거부로 exit 3 이 됐다. 복구 경로로 기존 서버를 유지했다.
  - 같은 이유로 03:00 백업도 실패할 상황이었다.
  - `Start -Headless` 감독자와 정지 요청 파일로 고쳤다(`docs/lan-operations-runbook.md` 감독자 절).
  - 감독자가 없던 옛 서버는 사용자가 관리자 PowerShell 에서 Stop 으로 한 번 껐다. 이후 Start-ScheduledTask 로 r4.2 를 빌드·기동했다. 중단 시간은 약 45초다.
  - 백업 작업으로 검증했다(13:53). 감독자가 1초 만에 preview 와 브리지를 끄고, 백업 OK, 재기동까지 중단 시간은 약 21초다.
- SC-12 재부팅 리허설: 통과.
  - 14:08:12 에 부팅하고 로그온하지 않았다. 14:09:47 에 ready 가 됐다(1분 지연 포함).
  - 점검 PC 에서 로그인했고 어시스턴트 답변을 확인했다. 로그온하지 않은 세션에서도 브리지가 Claude CLI 자격 증명을 읽는다. 그래서 D19 대체안(`-Mode Logon`)은 쓰지 않는다.
  - 재부팅 뒤 방화벽에 새 Query User 규칙은 없다.
- 남은 일
  - SC-7 복원 리허설(점검 인스턴스, 운영 무관).
  - 비대화형 창에서 Deploy 가 감독자 경로로 정지되는지를 다음 배포 때 확인한다.

**R5 구현 결과 (2026-09-29, 개발 폴더, 운영 미적용)**
- r5-core·r5-poll·r5-attachments·r5-ui 를 한 묶음으로 넣었다. 되돌리기 단위는 레지스트리 chat 항목, 패널, 라우트 5개, `chatSchemaStatements` 이다.
- 설계와 다른 점
  - `GET /api/chat/channels?members=<channelId>` 를 더했다. 멤버 관리 화면이 공개·비공개 채널의 현재 멤버 id 를 읽는 데 쓴다. 접근 규칙은 다른 경로와 같다(비공개·DM 비멤버 404).
  - `ChatChannelDto.dmMemberIds` 는 DM·그룹 DM 에만 둔다(설계대로).
- 테스트
  - `tests/chat-api.test.mjs` 는 #39~#52 와 members 조회, 소스 가드(raw HTML 0건, 한글 조합 중 Enter, 링크 스킴, 제목)를 다룬다. 17건이다.
  - R3 기준(chat 없음)으로 고정했던 레지스트리·탭 기대값을 R5 로 바꿨다. 이 파일들은 access-policy, auth-session, tab-permissions, shell-tabs, lan-exposure-guards 다.
  - `read-state` 는 감사 가드의 유일한 예외로 두었다(erp-platform, tab-permissions).
- 실제 런타임 점검(개발 서버 3100, 빈 개발 DB, 테스트 계정 2개): 로그인, 목록, 전송, 상대 poll 수신(78ms), 멘션 수, png 업로드·다운로드 헤더, 26MB 413, svg 415, 교차 출처 403, 읽음 위치를 확인했다. 15항목 모두 통과했다.
- 브라우저 화면 점검은 하지 못했다. Chrome 확장이 연결되지 않았다. 운영 적용 뒤 사용자와 SC-2(chat 열)·SC-6(3초)·SC-7 채팅 부분을 확인한다.

#### 11.5.10 R6 폴더·저장소 리네임 (수동, FR-18, M7)
사용자와 함께 하는 체크리스트이고 자동화하지 않는다(Plan R6).
1. [x] 개발 폴더의 앱(dev)과 브리지를 `taskkill /T`로 정지하고, 이 PC의 작업 세션(Claude Code·편집기·터미널)을 모두 닫는다. 운영 폴더(`C:\xdm\prod`)의 서비스는 D18에 따라 개발 폴더와 무관하므로 멈추지 않는다.
2. [x] 개발 폴더 `XDNODE`와 원격 저장소 이름을 바꾼다. (폴더 2026-10-01, 원격 2026-10-02)
3. [x] 개발 폴더를 가리키는 참조만 새 경로로 고친다: 개발용 바로가기, 개발 폴더의 `XD_NODE_PROJECT_PATH`, Claude Code 프로젝트 메모리, 운영 폴더의 git remote(개발 폴더나 원격 저장소를 가리키는 경우). 작업 스케줄러, 운영 바로가기, 운영 폴더 기준 `XD_NODE_PROJECT_PATH`는 바꾸지 않는다.
4. [ ] 새 경로에서 `npm run lint && npm test`, 운영 폴더에서 `git fetch`가 되는지 확인한다.
- 롤백: 폴더 이름을 원래대로 되돌리고, 바로가기와 remote 경로를 원복한다(§12.9).

---

## 12. 제거·전환 설계 (R1 = M1, R2·R3의 제거 포함)

원칙
- 파일을 지우기 전에 결합을 먼저 끊는다. 남는 코드가 삭제 대상을 가리키는 간선은 `page.tsx` 밖에 10개뿐이다(HR 라우트 5개의 `createApprovalRequest`, `hr/organizations`의 master-impact, `hr-workspace.tsx`의 `MasterImpactDialog`, documents의 재무·영업 헬퍼 3개). `page.tsx`에는 29개가 더 있고 재작성한다.
- 삭제 파일에 있는 포맷터·타입·유틸을 남는 코드가 쓰는 곳은 없다. 옮겨야 하는 것은 동작뿐이다: `approval-engine.ts` `buildApprovalOutcomeStatements`의 HR 분기.
- 게이트: R1의 즉시 반영은 기존 게이트(`hr:approve`, `hr:write`, `privileged()`)를 그대로 쓴다. 권한 의미는 R3에서 바뀐다. 운영은 R0 상태(서버 PC 전용 dev, D16)로 계속 돈다.
- 단계마다 `npm run lint && npm test`를 통과하고 커밋을 따로 둔다.

### 12.1 사전 보관과 조사 (`r1-preflight`, M1-0)

1. 현재 작업 트리 변경을 커밋한다. 비소스 산출물(tar.gz, council-*, deliverables/, tmp*)은 커밋하지 않는다.
2. 그 커밋에 태그 `erp-final-20260923`을 달고 `archive/erp-finance-sales-20260923` 브랜치를 만든다.
3. 앱과 브리지를 `taskkill /T`로 정지하고(workerd 포함) `.wrangler/state/v3` 전체를 `C:\xdm\snapshots\r1-pre-yyyyMMdd-HHmm\`에 복사한다.
4. `scripts/lib/d1-state.mjs`·`scripts/verify-state-snapshot.mjs`를 만들고 사본에서 `PRAGMA integrity_check`와 테이블별 행 수를 기록한다(SC-8).
5. 사전 조회(사본에서, 읽기 전용). R1 배포 직전에 다시 한다(`r1-verify`).
   - 레거시 대기 행: HR 테이블을 직접 조회한다(`erp_approval_requests`만 보면 안 된다).
     - `hr_personnel_actions`·`hr_retirement_requests`·`hr_workforce_plans`·`hr_recruitment_requisitions`의 `status='SUBMITTED'`
     - `hr_leave_requests`의 `status='PENDING'`
     - `hr_performance_cycles`의 `status='FINALIZATION_SUBMITTED'`
   - `SELECT payroll_period, COUNT(*), SUM(applied_amount) FROM sales_incentive_payroll_links GROUP BY payroll_period`. status 컬럼은 없다. 조사 시점(2026-09-23) 0건.
   - `payroll:%` 재무 행이 모두 미지급·미전기인지. 조사 시점 20건 모두 UNPOSTED.
6. 결과로 정적 목록을 정한다(§12.3). 조사 시점 기준 둘 다 `[]`다. 1건 이상이면 그 월을 목록에 넣고 처리 방법을 사용자와 정한 뒤 진행한다.

**실행 결과 (2026-09-28, `r1-preflight` 완료)**
- 커밋 `02f6ba5`, 태그 `erp-final-20260923`, 브랜치 `archive/erp-finance-sales-20260923`
- 스냅샷 `C:\xdm\snapshots\r1-pre-20260928-1109\`(188.6MB, 서버 정지 후 복사). `verify-report.json`: integrity 모두 ok, 테이블 167개, R2 본문 151개(183,769,314바이트), 앱 DB `faaf2b…sqlite`
- 레거시 대기 행: 6개 조건 모두 0건
- `sales_incentive_payroll_links`: 0건 → `LEGACY_SALES_INCENTIVE_PERIODS = []`
- `payroll:%` 재무 행: 20건, 모두 `status=APPROVED`·`journal_status=UNPOSTED`·`paid_at` 없음 → `LEGACY_FINANCE_LOCKED_PAYROLL_PERIODS = []`
- `erp_approval_requests`: 20건 모두 `APPROVED`(대기 없음)

### 12.2 HR 즉시 반영 (`r1-decouple`, `app/hr-transitions.ts`)

**공통 규칙**
- 전이마다 `WHERE status IN (<원래 from>, <레거시 대기 상태>)`를 건다. 라우트가 `meta.changes`를 검사해 0이면 409 `CONFLICT` "다른 사용자가 먼저 상태를 바꿨습니다. 새로고침해 주세요."로 막는다.
- actor 컬럼에는 `principal.employeeId`를 넣는다.
- 각 라우트는 `approval-engine` import를 지운다.
- HR 테이블에는 결재 id 컬럼이 없어 스키마 마이그레이션이 필요 없다.
- UI가 보내는 action·resource 이름은 바꾸지 않는다: `SUBMIT_FINALIZATION`, `SUBMIT_PLAN`, `SUBMIT`, `CREATE_DRAFT`.
- 생성기는 `D1PreparedStatement[]`를 돌려주는 순수 함수다. `db.batch`와 `meta.changes` 검사는 라우트에 남긴다.

```ts
export const LEGACY_PENDING = {
  personnelAction: "SUBMITTED", retirement: "SUBMITTED", leaveRequest: "PENDING",
  workforcePlan: "SUBMITTED", requisition: "SUBMITTED", performanceCycle: "FINALIZATION_SUBMITTED",
} as const;
```

| # | 흐름 | 현재 위치 | 생성기 | 반영 내용 | 감사 action | 응답 |
|---|------|-----------|--------|-----------|-------------|------|
| 1 | 인사발령 | `hr/operations:259-291`(`createApprovalRequest` `:277`) | `insertApprovedPersonnelAction` | `hr_personnel_actions`를 `APPROVED`, `approved_by`/`approved_at` = principal·now로 INSERT. 라우트가 이어서 `applyDuePersonnelActions(db, now)`(`app/hr-personnel-actions.ts:13`)를 부른다. 이 함수가 유일한 활성화 경로이고 멱등 감사 `PERSONNEL_ACTION_EFFECTIVE`를 쓴다. `:284-287` 롤백과 202 `approvalSubmitted`는 지운다 | `PERSONNEL_ACTION_APPROVED` | 201 |
| 2 | 퇴직 | `hr/operations:293-374`(`:358`) | `startRetirementStatements` | 기존 batch(`:353`)에서 요청을 `IN_PROGRESS`+`approved_by`/`approved_at`로 INSERT, `INSERT OR IGNORE hr_retirement_settlements`(DRAFT, 0), `UPDATE hr_employee_records SET status='퇴직 예정', retirement_json=json_object(… 'IN_PROGRESS')`. 이력은 '퇴직 예정' 1건('· 결재 승인' 삭제). `:363-369` try/catch 롤백 삭제, `:370` `applyDueRetirements` 유지 | `RETIREMENT_APPROVED` | 201 |
| 3 | 휴가 신청(구 양식) | `hr/operations:380-413`(`:400`) | `insertApprovedLeaveRequest` | `APPROVED`, `approver_employee_id` = principal, `decided_at` = now로 INSERT. PUT 결정(`:549-559`)은 유지 | `LEAVE_REQUEST_APPROVED` | 201 |
| 4 | 급여월 승인 | `hr/payroll:411-431`(`:418`) | `payrollRunTransition` | 결재 분기와 import(`:5`)를 지운다. APPROVED는 일반 guarded UPDATE(`:507-514`, `prepared_by`/`reviewed_by`/`approved_by` 기록, changes 검사 `:516`)로 간다. LOCKED(`:432-465`)는 `hr_payroll_runs` UPDATE·changes 검사·감사만 남긴다. 재오픈(`:466-503`)은 사유 검사와 `UPDATE … SET status='DRAFT', approved_by='', locked_at=NULL, reopened_reason=? WHERE status IN ('APPROVED','LOCKED')`만 남긴다 | `PAYROLL_RUN_STATUS_UPDATED`·`PAYROLL_RUN_LOCKED`·`PAYROLL_RUN_REOPENED`(module `finance` 감사 `:463`, `:501` 삭제) | 200 |
| 5 | 성과 최종 확정 | `hr/performance:249-268`(`:258`) | `finalizePerformanceCycleStatements` | 사전 검사(`:253-255`) 뒤 한 batch: `UPDATE hr_performance_cycles SET status='FINALIZED', finalized_by=?, finalized_at=?, updated_at=? WHERE id=? AND status IN ('CALIBRATION','FINALIZATION_SUBMITTED')` + `UPDATE hr_performance_participants SET status='FINALIZED', … WHERE cycle_id=? AND status='CALIBRATED' AND EXISTS (SELECT 1 FROM hr_performance_cycles WHERE id=? AND status='FINALIZED' AND finalized_at=?)`. `changes[0] === 1` 요구 | `PERFORMANCE_CYCLE_FINALIZED` | 200 |
| 6 | 인력계획 승인 | `hr/workforce-plans:225-248`(`:236`) | `approveWorkforcePlanStatements` | 사전 검사(`:226-231`) 뒤 batch: 같은 기간의 다른 APPROVED를 SUPERSEDED로(대상이 `DRAFT`·`SUBMITTED`일 때만, EXISTS 가드) + `UPDATE target SET status='APPROVED', submitted_at=?, approved_by=?, approved_at=? WHERE id=? AND status IN ('DRAFT','SUBMITTED')`. `changes[1] === 1` 요구. `:156`, `:254`의 SUBMITTED 가드는 레거시 행용으로 유지 | `WORKFORCE_PLAN_APPROVED` | 200 |
| 7 | 채용요청 모집 시작 | `hr/recruitment-requisitions:179-199`, `:257-285`(`:191,264`) | `openRequisitionStatement` | 인원 검사(`:181-187`) 유지. `CREATE_DRAFT`는 검사를 통과하면 곧바로 OPEN(현 관리자 1인 환경의 관찰 동작 유지), 아니면 DRAFT로 남고 '모집 시작'을 쓸 수 있다. `SUBMIT`은 `UPDATE SET status='OPEN', approved_by=?, approved_at=? WHERE id=? AND status IN ('DRAFT','SUBMITTED')`. `requisitionApprovalInput`(`:203-212`), `willAutoApproveForSelf`, DELETE의 결재 취소 블록(`:321-340`) 삭제. 필터 `:137`, `:150`과 `hr-workspace.tsx:2958` 갱신 | `REQUISITION_OPENED` | 200/201 |

**레거시 결정 (신규)**
- `decidePersonnelActionStatements`, `decideRetirementStatements`: `PUT /api/hr/operations`의 `resource: "personnelActionDecision" | "retirementDecision"`, 본문 `{id, decision:'APPROVED'|'REJECTED', reason}`.
  - APPROVED: 인사발령은 `WHERE status='SUBMITTED'`로 APPROVED 후 `applyDuePersonnelActions`, 퇴직은 흐름 2와 같은 세 문장을 `WHERE status='SUBMITTED'`로.
  - REJECTED: `status='REJECTED'`, 사유 기록.
  - 감사 `PERSONNEL_ACTION_APPROVED`·`_REJECTED`, `RETIREMENT_APPROVED`·`_REJECTED`.
- 레거시 PENDING 휴가는 기존 PUT 결정(`resource: leaveRequest`)과 `decide()`(`hr-workspace.tsx:2392`)를 쓴다.
- 이유: SUBMITTED 퇴직이 같은 직원의 새 퇴직을 409로 막는 경로(`operations:304-306`)가 있어, 빠져나갈 길이 없으면 행이 영구히 갇힌다.

**UI 문구**
- 인사발령 토스트 "인사발령을 반영했습니다."(`hr-workspace.tsx:1233-1238`).
- 퇴직 SUBMITTED '결재 대기' 표시(`:1362-1366`, `:4482`, `:4491`)는 레거시 승인/반려 버튼으로.
- 급여 "승인 결재 요청" → "승인", autoApproved·approvalSubmitted·financeExpenseId 안내 삭제(`:2612-2644`).
- `workforce-planning-view.tsx:20,64,66,143`: '결재 중'·'결재 제출'·'결재센터에서…' → "승인·확정" 문구.
- `recruitment-requisition-view.tsx:26,75-79,101,107-111,124,133,153`: autoApproved·cancelledApproval 문구 정리.
- `performance-management-view.tsx`: `:12` 상태 라벨 삭제, `:71` 버튼 "최종 확정", `:62-66` 수용 값 `RESOLVED`(서버는 `performance/route.ts:413`에서 `RESOLVED`·`REJECTED`만 받는다).
- 테스트 문구 `erp-platform.test.mjs:1801`은 "모집을 시작했습니다"로.

### 12.3 그 밖의 결합 끊기 (`r1-decouple`)

- **결재 테이블 직접 SQL 5곳 삭제**: `hr/leave:222-224`(DELETE의 `erp_approval_requests` SELECT), `hr/operations:546-548`(SELECT), `hr/operations:554`(batch 안의 `erp_tasks` UPDATE), `hr/payroll:413-416`, `hr/recruitment-requisitions:321-340`. 새 DB에서 'no such table' 500이 나던 곳이다. `r1-platform`의 DDL 중단 커밋과 같거나 그보다 앞선 커밋에서 한다.
- **급여 재무 연결 3곳(D2-b)**: ensureSchema의 `finance_expense_requests` CREATE(`:103-114`)·ALTER(`:124-128`), LOCKED 분기(`:432-465`), 재오픈 분기(`:466-503`, `finance_project_allocations` 조회 `:476-481` 포함). `hr-workspace.tsx`의 financeExpenseId 안내 삭제.
- **정적 기간 목록**(테이블을 읽지 않는다)
  - `LEGACY_SALES_INCENTIVE_PERIODS: readonly string[]` — `app/api/compensation/route.ts`(R1에는 `app/api/hr/compensation/route.ts`). CONFIRM 409 `LEGACY_PERIOD_LOCKED`.
  - `LEGACY_FINANCE_LOCKED_PAYROLL_PERIODS: readonly string[]` — `app/api/hr/payroll/route.ts`. 재오픈 409 `LEGACY_PERIOD_LOCKED`.
  - 기본 `[]`. §12.1 조회와 R1 직전 재조회로 채운다.
- **임금 계산의 영업 합산 삭제**: `app/api/hr/compensation/route.ts:311-339`(`sales_incentive_payroll_links` 조회·합산, 주석 `:315`). 인센티브는 화면 입력값만 쓴다.
- **documents**: 재무·영업 import(`:4-6`)와 분기(`:86-127`, `:202-260`) 삭제, `allowedModules`(`:17`)를 `DOCUMENT_MODULES`(hr·recruitment)로. 레거시 module 행은 관리자도 404. POST는 `formData()`(`:75`)를 읽기 전에 인가한다(Plan M1-1, R1): R1에는 역할 모델이 남아 있고 module을 폼에서만 알 수 있으므로, 먼저 `recruitment:write`(hr·recruitment 업로드 모두의 필요조건. `hr:write`를 가진 SUPER_ADMIN·HR_ADMIN은 `recruitment:write`도 가지고, RECRUITER는 `recruitment:write`만 가진다, `erp-platform.ts:24-31`)로 인가하고, 폼을 읽은 뒤 module이 `hr`이면 `hr:write`로 한 번 더 인가한다. R3에서는 리터럴 `hr:write` 1회로 바꾸고, GET·PATCH·DELETE도 행 조회 전에 리터럴 모듈로 인가한다(§4.3.2, 부록 C #20).
- **마스터 영향**: `app/api/hr/organizations/route.ts:4,76,93-95,113`(`impactAssessmentId`), `app/hr-workspace.tsx:13,1286,1302,1975-1991`(`MasterImpactDialog`), `public/hr-workspace.css:929-954`.
- **어시스턴트 `sales` → `incentive`(D1)**: `/api/sales` 조회(`local-codex-assistant.tsx:278-291`) 삭제, `salesIncentiveContext`(`:212-241`)는 이름만 바꿔 유지. `local-codex-assistant.tsx:10,63,67`, `compensation-calculator.tsx:621-623`, `page.tsx:511`, `app/api/assistant/route.ts:6,14,17-21,29-31`(R1에는 `incentive`도 `hr` 모듈로 인가), 두 브리지의 `ALLOWED_MODULES`(`claude-assistant-bridge.mjs:29`, `codex-assistant-bridge.mjs:28,40,55,113,127`), `tests/local-codex-assistant.test.mjs:38-66`.
- **결재 UI**: `ERPTopNavigation`의 ApprovalCenter 마운트(`page.tsx:26,437`), `hr-workspace.tsx` 설정의 '전자결재 규칙': `ApprovalSettings` 컴포넌트(`:4644-4747`, `/api/approval-settings` 호출 `:4672,4689,4701,4709`), 호출 `:4637`, 탭 항목 `:4608`의 `["approvals", …]`, 라벨 `:4597`('사용자·권한' `:4595`, `:4608` permissions 항목, `:4615-4636`은 R3, §12.8), 결재 ID·"결재 대기" 표시, `public/hr-workspace.css:494-503,510`.
- **역할 라벨**: `hr/authorized-users/route.ts:9`의 `allowedRoles`와 `hr-workspace.tsx:4512` `roleLabels`에서 `FINANCE_ADMIN`·`SALES_ADMIN` 삭제(라우트 자체는 R3에 삭제).
- **기존 버그**: 성과 이의제기 '수용' 값(§12.2 UI 문구).

### 12.4 플랫폼 정리 (`r1-platform`, M1-2)

- `ensureErpPlatformSchema`에서 `erp_tasks`(`:71-92`), `erp_approval_*` 6개와 인덱스(`:93-149`), `erp_sync_runs`(`:150-166`), `erp_approval_steps`의 PRAGMA/ALTER(`:175-178`) 생성을 멈춘다. DROP은 하지 않는다(D4).
- 재무 헬퍼 `blockedFinancePeriods`·`isFinancePeriodLocked`(`:304-325`, 재무 라우트 6개와 테스트만 사용)와 `FINANCE_ADMIN`·`SALES_ADMIN`(`:4,26,29-30`)을 지운다. `ErpModule`의 `operations|finance|sales`(`:5`)도 지운다. `settings`는 R3까지 audit-log·authorized-users가 쓰므로 남긴다.
- `safeJson`은 남긴다(audit-log, hr/analytics, hr/authorized-users, hr/compensation, hr/payroll, hr/recruitment, hr-workspace가 사용).
- 검증: 결재·재무 테이블이 없는 새 DB 하니스에서 휴가 삭제·결정, 급여 승인, 채용요청 삭제가 500 없이 성공한다(§8.2 #37).

**실행 결과 (2026-09-28)**: DDL 중단(결재 6개·`erp_tasks`·`erp_sync_runs`와 인덱스, `erp_approval_steps` PRAGMA/ALTER)과 `FINANCE_ADMIN`·`SALES_ADMIN` 삭제(VIEWER의 `finance:read`·`sales:read`도 삭제)는 완료했다. **순서 조정**: 재무 헬퍼 `blockedFinancePeriods`·`isFinancePeriodLocked`와 `ErpModule`의 `operations|finance|sales` 삭제는 `r1-delete`로 옮긴다. 이 둘을 쓰는 재무·영업 라우트가 아직 남아 있어, 먼저 지우면 빌드가 깨진다. 라우트와 같은 커밋에서 지운다. 결재 엔진 테스트 2건(`erp-platform.test.mjs`)과 `hr-local-permissions`의 approval-settings 단언은 삭제했다. 새 DB가 결재·업무·동기화 테이블을 만들지 않는다는 테스트를 추가했다. `npm test` 428/428.

### 12.5 셸 정리와 PII 분리 (`r1-shell-pii`, M1-3)

- `app/page.tsx`(1,561줄)
  - 지우는 것: import `:5-28`, `:31-35`, 재무·영업·알림 타입과 상수(`:37-236` 안), `ERPTopNavigation`의 워크벤치·거버넌스·결재·알림 로직(`:239-396`, `:427-494`), 검색·재무 상태(`:505-513`, `:527-540`, `:556-585`), `.app-shell` 분기(`:607-660`), `:663-1561` 전부(FinanceDashboard, SalesDashboard, 도달 불가 HrDashboard, Metric·PanelHeader).
  - 남기는 것: 브랜드·탭 마크업(`:399-424`), hr·compensation 분기(`:587-605`) 패턴, hrNavigation 핸드셰이크(`:504`, `:544-554`에서 `financeView` 제거).
  - 임시 `ModuleKey = 'hr'|'compensation'|'audit'`, 감사 탭을 `.admin-page`로 재마운트(유일한 import처 `data-governance-center.tsx`가 삭제 대상, `settings:admin` 게이트). `/api/audit-log`의 과거 module 라벨은 남긴다.
- `app/hr-company-data.ts` 분리
  - `app/hr-company-catalogs.ts`: 조직·직급·직책 카탈로그와 `CompanyOrganizationSeed`(`:23,131-142`). 클라이언트 허용.
  - `app/hr-company-data.ts`: 직원 명부·보상 시드, `import "server-only"`. 카탈로그는 `export { companyOrganizations, companyRanks, companyJobTitles, type CompanyOrganizationSeed } from "./hr-company-catalogs";`로 재수출해 서버 import를 그대로 둔다(라우트 import는 고치지 않는다).
  - 서버 사용처(유지 파일): `app/api/hr/{analytics:4, catalogs:4, operations:7, organizations:2, payroll:3, performance:3, recruitment:3, recruitment-requisitions:4, training:3, workforce-plans:5, authorized-users:2}`, `app/erp-platform.ts:1`(R3 삭제), `app/hr-employee-roster.ts:1`, `tests/helpers/hr-api-harness.mjs:70`. 재수출 덕분에 이 파일들은 R1에서 바뀌지 않는다. 클라이언트(`hr-workspace.tsx:5`)만 카탈로그를 `./hr-company-catalogs`에서 직접 import한다.
  - 실제 회사 데이터이므로 분리 전후 값을 대조한다(카탈로그 JSON 직렬화 비교).
- `hr-workspace.tsx`: import(`:5`)를 카탈로그로, `initialEmployees = []`(`:860`)로 시작해 `/api/hr/employee-records`로 채우고 로딩 상태를 둔다. API가 이미 명부를 시드·병합한다(`employee-records/route.ts:42-45`, `hr-workspace.tsx:986-1019`).
- `incentive-calculator.tsx`: import(`:7`)와 `COMPANY_EMPLOYEE_OPTIONS`(`:109-121`)를 지우고, `response.ok`가 아니면 오류를 표시한다.
- 하니스 `server-only` 스텁(`:47`).

**실행 결과 (2026-09-28)**
- 셸: `ModuleKey = 'hr'|'compensation'|'audit'`, 감사 로그 탭 재마운트. 재무·영업·워크벤치·알림 코드 삭제(page.tsx −1,600줄 안팎).
- 분리 대조: HEAD의 `hr-company-data.ts`와 분리 후 모듈의 export 4개(`companyEmployees` 27, `companyOrganizations` 6, `companyRanks` 7, `companyJobTitles` 8)가 JSON 직렬화 기준으로 모두 같다.
- 추가 발견과 조치: 브라우저 번들에 들어가는 **예시 데이터에도 실명**이 있었다.
  - 임금 계산 '예시 명부' 3명(`compensation-calculator.tsx`)은 모두 실제 직원 이름이었고, 그중 1명은 연봉도 같았다. 이름을 '예시 직원A/B/C'로 바꿨다.
  - 인센티브 '예시 거래'(`incentive-calculator.tsx` `loadExample`)의 담당자 이름 2개는 코드에 적는 대신 불러온 직원 목록에서 고른다(`examplePerson`).
- 번들 검사(`npm run build` 뒤 `dist/client`): 실제 직원 이름 0, 전화번호 0, 개인 이메일 0, 시드 키 0. `annualSalary:<숫자>` 리터럴은 가상 예시 3건뿐이다.
- `hr-company-data`를 import하는 클라이언트 파일 8개는 모두 r1-delete 대상이고 앱에서 import되지 않는다.
- `npm test` 429/429. lint 신규 오류 없음(`set-state-in-effect`는 대상 파일 합계 14건에서 2건으로 줄었다).

### 12.6 일괄 삭제와 정리 (`r1-delete`, M1-4)

- 삭제 전에 삭제 대상 경로를 import·fetch하는 남는 파일이 0개인지 grep으로 확인한다(`app/`, `worker/`, `scripts/`, `build/`). 남는 파일에서 삭제 라우트를 부르는 곳은 `hr-workspace.tsx:4672,4689,4701,4709`(approval-settings), `local-codex-assistant.tsx:279`(`/api/sales`), `page.tsx:269,342,773,774,795,804,928,972`(operations·finance)뿐이고 모두 앞 단계에서 지운다. 동적 `/api/${…}` 조립은 없다.
- 부록 A.1·A.2의 120개를 한 커밋에서 지운다(`incentive-governance.tsx` 포함, D22).
- 재무 실데이터 4개(`finance-current-data.ts`, `finance-historical-data.ts`, `finance-decision-model.ts`, `finance-time-series.ts`)는 이 120개에 들어 있어 작업 트리에서 사라진다. 보관은 archive 태그·브랜치와 `C:\xdm\archive\finance-data-20260923\`(SHA-256 기록) 두 곳뿐이다.
- `.env.local`과 `localRuntimeVars`에서 `CLOUDFLARE_AI_MODEL`(`vite.config.ts:39`)을 지운다.
- 테스트: finance 5개 삭제, `removal-guards`·`bundle-exposure` 추가, `erp-platform`·`workflow-ledgers` 정리(§8.7), `package.json` 목록 갱신.
- 문서: 부록 A.4의 47개를 `docs/archive/`로. HR 계획 문서 5개를 '즉시 반영' 기준으로 고친다. `erp-platform-plan.md`의 재무·영업·결재 절(5, 7, 12, 13)은 '대체됨'으로 표시한다. `erp-platform.test.mjs:1769`의 문서 문구 단언은 같은 커밋에서 고친다.
- PRD 문구 정정: T-01(루프백 0계정 부트스트랩), T-08의 '(origin 허용 후)' 삭제, Workstream R 'ALLOWED_MODULES sales 제거' → incentive 이름 변경, D1의 `incentive-governance.tsx` 표기(D22).
- CSS: `globals.css`는 규칙 단위로 약 2,250줄(약 82%)을 지운다. 알림 센터 묶음 약 136줄(`:445-573` 등)도 지운다. `:root` 토큰(`:281-307`)과 §5.7의 유지 규칙은 남긴다. `scripts/css-dedupe.mjs`를 쓸 수 있다.
- 기능 손실 명시: data-intake 삭제로 HR 직원·급여 엑셀 일괄 가져오기가 사라진다(조사 시점 기록 0건). 임금 계산기의 xlsx 업로드는 남는다.

### 12.7 검증 (`r1-verify`, M1-5)

- R1 직전 사전 조회를 다시 한다(§12.1 5). 결과가 바뀌면 정적 목록을 갱신한다.
- SC-4를 서버 PC에서 기존 D1 사본(별도 폴더)과 새 DB 양쪽으로 실행한다(§8.4).
- `bundle-exposure`와 `removal-guards`가 통과한다.

**실행 결과 (2026-09-28, `r1-verify` 완료)**
- 사전 조회 재실행(스냅샷 `C:\xdm\snapshots\r1-verify-20260928-1436\`, integrity ok): 레거시 대기 행 0, `sales_incentive_payroll_links` 0, `payroll:%` 재무 행 20건 전부 미전기 → 두 정적 목록은 `[]` 그대로. 재무·영업·결재 테이블 104개가 DB에 남아 있다(SC-8).
- SC-4: 점검 인스턴스(`f203ede` worktree, `127.0.0.1:3100`, 저장소 밖)에서 `scripts/sc4-hr-regression.mjs`로 실행했다. 3단계(main → 서버 정지 중 offline-prep → due)다.
  - 기존 D1 사본: 48 + 4 + 13 전부 PASS.
  - 새 DB: 처음에 1.2 '조직명 수정'이 500이었다. `hr_payroll_records`가 아직 없는 DB에서 조직 PUT이 그 표를 UPDATE했기 때문이고, R1 이전부터 있던 결함이다. 급여·임금 계산 표가 있을 때만 갱신하도록 고쳤다(`organizations/route.ts`, `hrTablesExist`, 회귀 테스트 추가). 그 뒤 48 + 4 + 13 전부 PASS.
  - 사본 실행 전후 비교(`verify-state-snapshot --compare`): 재무·영업·결재 테이블 행 변화 0. 바뀐 표는 HR 19개뿐이다.
  - 'SC-4 임금 계산 전용 계정'은 계정이 없는 R1에서는 해당 없음이다. R3 전환 점검에서 한다.
- 점검 인스턴스와 그 안의 데이터 사본은 지웠다.
- `npm test` 298/298.

### 12.8 R2·R3의 제거와 교체

- R2(리네임)
  - "XD NODE ERP" 14곳, "XD NODE" 16곳(삭제 파일 4곳 제외), "XDNODE" 7곳을 바꾼다. 회사명 용도(`hr-interview-question-templates.ts:26,215`, 테스트 `hr-interview-question-templates.test.mjs:48`이 고정)와 `xdnode.co.kr` 도메인, `system@xdnode.local` 감사 actor, `XD_NODE_*` 환경변수 이름은 바꾸지 않는다.
  - `app/layout.tsx:13-28` 제목·설명, `app/page.tsx:403,613`, `app/incentive/layout.tsx:11`, `public/og.png`.
  - `package.json` name `xdnode-management`, lockfile 재생성, engines `>=22.15.0`, 시작 스크립트 이름과 참조 테스트, README·CLAUDE.md.
  - 바탕화면 바로가기를 `Start-XDNodeManagement.ps1`로 갱신한다(Plan R2). `XDNODE 견적서 서버` 작업(견적 툴 8765)은 건드리지 않는다.
  - `database_id`·`bucket_name` 불변 가드(`removal-guards`). 바꾸면 앱이 빈 DB·빈 버킷으로 조용히 뜬다.
  - **실행 결과 (2026-09-28, R2 완료)**
    - 제품명 표기를 바꿨다: 브라우저 제목·설명(재무·영업 문구 삭제), 헤더, `/incentive` 제목, HR 집계 리포트 제목, 어시스턴트 소개 문구, 시작 스크립트 메시지.
    - 회사명 용도는 "XD NODE"로 남겼다: 면접 템플릿, `XD NODE 사업 시나리오` 라벨, 회사 프로필, 설정의 회사명, `XDNODE_인사기록` 파일명.
    - `package.json`·lockfile의 name은 `xdnode-management`, engines는 `>=22.15.0`로 바꿨다. lockfile은 재생성하지 않고 루트 name·engines만 고쳤다(의존성 변화 없음).
    - `Start-XDNodeERP.ps1`는 `Start-XDNodeManagement.ps1`로 바꿨다(`git mv`). 참조 테스트 4곳과 `Package-XDNodeDemo.ps1`도 고쳤다.
    - 바탕화면 바로가기는 `XDnode management.lnk`로 바꾸고 대상을 새 스크립트로 갱신했다.
    - README·CLAUDE.md를 고쳤고, `removal-guards`에 식별자 불변 가드를 추가했다.
    - `public/og.png` 교체는 열린 질문 3으로 남긴다. 이미지 제작자가 정해지지 않았고, 사내 LAN 전용이라 링크 미리보기 영향이 작다.
    - `npm test` 299/299.
- R3
  - 삭제: `app/chatgpt-auth.ts`, `app/api/hr/authorized-users/route.ts`와 `hr-workspace.tsx` 설정의 '사용자·권한' 절(라벨 `:4595`, `:4608`의 permissions 항목, 본문 `:4615-4636`), `tests/hr-local-permissions.test.mjs`, `scripts/Package-XDNodeDemo.ps1`(`.wrangler/state`를 복사하고 `LOCAL_ERP_USER_EMAIL`에 의존).
  - 생성 중단: `hr_authorized_users`(`erp-platform.ts:39-42`), `erp_user_access`(`:43-50`), gc.kim 시드(`:168-173`). `authorizeErpRequest` 본문의 런타임 SQL(`erp_user_access` SELECT `:220-222`, `hr_authorized_users` 레거시 조회 `:225-226`, `INSERT OR IGNORE INTO erp_user_access` 자동 발급 `:229-233`)도 함께 없어진다. 기존 행은 옮기지 않는다. `removal-guards`(R3)가 `app/`에서 두 테이블 이름 0건을 단언한다.
  - 교체: 역할 6종(`ErpRole`, `rolePermissions`) → 계정별 탭 권한. RECRUITER 분기와 `hr-dashboard-model` 정리.
  - 이동: `/api/hr/compensation` → `/api/compensation`(§11.1).
- **삭제 금지**: `app/incentive/*` 4개 파일, `public/incentive-og.png`, `scripts/codex-assistant-bridge.mjs`(`buildPrompt` 원본, 기동하지 않음), `scripts/restore-known-data.mjs`(R3에 로그인 방식으로 수정), `drizzle/*.sql`, D1의 재무·영업·결재 테이블(D4), `app/payroll-seed-data.ts`(삭제 대상 data-integration도 import하지만 hr/payroll이 쓴다).

### 12.9 롤백

| 릴리스 | 절차 | 데이터 |
|--------|------|--------|
| R1 | 정지 → archive 태그 checkout → 필요하면 M1-0 스냅샷 복구 | 즉시 반영으로 바뀐 HR 상태는 스냅샷 복구로만 되돌아간다. 복구하면 그 사이 변경을 잃으므로 코드 롤백을 먼저 하고 스냅샷은 데이터가 손상됐을 때만 |
| R2 | 커밋 되돌림 | 영향 없음 |
| R3 | 운영 폴더의 preview·브리지 정지 → 3000 규칙 끄기 → 운영 폴더를 R2 태그로 checkout → 보관한 `LOCAL_ERP_USER_EMAIL`·`LOCAL_ERP_USER_NAME`을 운영 폴더 `.env.local`에 복원(R2의 dev는 이 신원이 없으면 전원 401) → R2 태그의 `Start-XDNodeManagement.ps1`로 dev를 `127.0.0.1`에 기동(D16 상태) | 인증 테이블은 추가만 했으므로 남겨도 무해하다. 손상 때만 R3 4단계 스냅샷 복구 |
| R4 | 스케줄 작업 비활성화, 수동 기동 | 영향 없음 |
| R5 | 직전 태그로 | 채팅 테이블은 남아도 쓰이지 않는다. `tabs_json`의 chat 부여는 보존된다(§3.3) |
| R6 | 폴더 이름·바로가기·remote 원복 | 영향 없음 |

---

## Appendix A. 파일 목록 (확정)

### A.1 R1 삭제: 라우트 44개

- `app/api/finance/*` 24개: alert-actions, assistant, budget, close, daily-treasury, debt, expense-control, fixed-assets, forecast, general-ledger, import-mappings, inventory, management-report, master-data, opening-balance, operations, posting-control, project-costing, purchasing, receivables, reconciliation, risk-policy, tax, tie-out
- `app/api/sales/*` 11개: route.ts, accounts, contracts, crm, incentives, planning, pricing, service, sheet-sync, sheet-sync/analytics, sheet-sync/insights
- 공용 9개(`app/api/` 최상위): approvals, approval-settings, data-intake, data-governance, data-integration, master-impact, master-impact-cases, operations, workbench. 이 operations는 유지하는 `hr/operations`와 다른 라우트다.

### A.2 R1 삭제: 비라우트 76개

- **재무 43**: finance-alert-action-center.tsx, finance-alert-actions-server.ts, finance-alert-reporting-model.ts, finance-alert-reporting.ts, finance-assistant-evidence.ts, finance-assistant-history.ts, finance-bank-transactions.ts, finance-close-workspace.tsx, **finance-current-data.ts**, finance-current-insights.ts, **finance-decision-model.ts**, finance-general-ledger.ts, **finance-historical-data.ts**, finance-import-mapping-workspace.tsx, finance-import-mapping.ts, finance-ledger-integrity.ts, finance-ledger-snapshot.ts, finance-master-workspace.tsx, finance-opening-balance.ts, finance-operations-center.tsx, finance-posting-workspace.tsx, finance-posting.ts, finance-risk-policy-server.ts, finance-risk-policy-workspace.tsx, finance-tie-out.ts, **finance-time-series.ts**, budget-actual-workspace.tsx, cash-forecast-workspace.tsx, cash-reconciliation-workspace.tsx, daily-treasury-workspace.tsx, debt-management-workspace.tsx, expense-control-workspace.tsx, fixed-assets-workspace.tsx, general-ledger-workspace.tsx, inventory-workspace.tsx, management-report-workspace.tsx, project-costing-workspace.tsx, purchasing-workspace.tsx, receivables-workspace.tsx, tax-reconciliation-workspace.tsx, tie-out-board-workspace.tsx, opening-balance-control.tsx, fixed-asset-calculation.mjs (굵게 = 실데이터·파생, 작업 트리 밖 보관)
- **영업 20**: sales-account-360-view.tsx, sales-contract-management.tsx, sales-contracts.ts, sales-planning-view.tsx, sales-pricing-governance.tsx, sales-pricing.ts, sales-service-management.tsx, sales-service.ts, sales-sheet-analytics-view.tsx, sales-sheet-analytics.ts, sales-sheet-data-hub.tsx, sales-sheet-insights-view.tsx, sales-sheet-insights.ts, sales-sheet-lead-conversion.ts, sales-sheet-sync-kit.ts, sales-sheet-sync-view.tsx, sales-sheet-sync.ts, sales-sheet-tabs.ts, sales-workspace.tsx, google-sheets.ts
- **결재 2**: approval-engine.ts, approval-center.tsx
- **데이터 6**: data-intake.ts, data-intake-workspace.tsx, data-governance.ts, data-governance-center.tsx, data-integration.ts, data-integration-workspace.tsx
- **마스터 영향 3**: master-impact.ts, master-impact-dialog.tsx, master-impact-case-workspace.tsx
- **워크벤치 1**: operations-workbench.tsx
- **인센티브 거버넌스 1**: incentive-governance.tsx (import처 0, D22)

### A.3 그 밖의 삭제

- R1 테스트 5개: `tests/finance-alert-reporting.test.mjs`, `finance-assistant-evidence`, `finance-data`, `finance-decision-model`, `finance-time-series`
- R3 4개: `app/chatgpt-auth.ts`, `app/api/hr/authorized-users/route.ts`, `tests/hr-local-permissions.test.mjs`, `scripts/Package-XDNodeDemo.ps1`
- 합계 129개(120 + 5 + 4).

### A.4 R1 이동: `docs/` → `docs/archive/` 47개

- finance-*-plan.md 28: alert-action, alert-reporting-integration, assistant-evidence, assistant-history, assistant-to-decision, comparison-drift, daily-treasury-report, expense-control, fixed-assets, forecast-risk-model, general-ledger, import-mapping, inventory, live-overview, management-decision-register, management-report, management-statement-integration, master-data, opening-balance, operational-statements, payables, posting-control, project-costing, receivables, remediation, risk-policy, tax-reconciliation, time-series
- sales-*-plan.md 11: account-governance, analytics-erp-benchmark, contract-lifecycle, crm-governance, document-line-governance, pricing-governance, service-control, sheet-analytics, sheet-integration, sheet-ux, target-forecast
- master-data-impact-plan, master-impact-report-approval-plan, master-impact-resolution-queue-plan, master-impact-sla-reporting-plan (4)
- controlled-data-intake-plan, data-governance-control-plan, data-integration-reconciliation-plan (3)
- personal-operations-workbench-plan (1)
- 남기고 고치는 것: `erp-platform-plan.md`(절 5·7·12·13 '대체됨'), `erp-audit-trail-plan.md`(유지), `hr-*-plan.md`(5개 '즉시 반영' 기준으로 수정)

### A.5 수정 대상 (약 60개)

| 묶음 | 파일 | 릴리스 |
|------|------|--------|
| 라우트 12(R1) | documents, assistant, audit-log, hr/operations, hr/payroll, hr/performance, hr/recruitment-requisitions, hr/workforce-plans, hr/organizations, hr/leave, hr/compensation, hr/authorized-users | R1 |
| 라우트(R3 추가) | hr/analytics, hr/training, hr/employee-records, hr/recruitment, hr/transcriptions(+ R1 목록의 documents·assistant·audit-log·operations·payroll·performance·compensation 재수정) | R3 |
| 비라우트(R1) | page.tsx, hr-workspace.tsx, erp-platform.ts, local-codex-assistant.tsx, compensation-calculator.tsx, audit-log-workspace.tsx, workforce-planning-view.tsx, recruitment-requisition-view.tsx, performance-management-view.tsx, layout.tsx, globals.css, hr-company-data.ts, incentive/incentive-calculator.tsx | R1·R2 |
| 비라우트(R3 추가) | incentive/page.tsx, hr-leave-view.tsx, hr-dashboard-model.ts, hr-severance-calculation.ts(주석), worker/index.ts, vite.config.ts | R3 |
| public | hr-workspace.css, og.png | R1·R2 |
| scripts | claude-assistant-bridge.mjs, codex-assistant-bridge.mjs(R1), Start-XDNodeERP.ps1(R2 이름 변경·R3 재작성), import-leave-ledger.mjs, restore-known-data.mjs(R3) | R1~R3 |
| tests | hr-api-integration, erp-platform, workflow-ledgers, rendered-html, incentive-calculation, local-codex-assistant, hr-dashboard-model, compensation-calculation, lan-exposure-guards, helpers/hr-api-harness | R1~R4 |
| 설정·문서 | package.json, package-lock.json, README.md, CLAUDE.md, docs 5개 HR plan, erp-platform-plan.md, PRD | R1~R3 |

정확한 줄 단위 수정 위치는 §11.2, §12.2~§12.8에 있다.

### A.6 생성을 멈추는 D1 테이블 (DROP 없음)

- finance/budget: finance_budget_plans, finance_budget_plan_lines, finance_budget_variance_actions
- finance/close: finance_close_tasks, finance_close_runs(+ posting·tie-out 헬퍼)
- finance/daily-treasury: finance_daily_treasury_reports
- finance/debt: finance_debt_facilities, finance_debt_schedule_items, finance_debt_covenant_reviews
- finance/expense-control: finance_corporate_cards, finance_card_transactions, finance_expense_controls
- finance/fixed-assets: finance_fixed_assets, finance_asset_depreciation_schedules, finance_asset_events
- finance/forecast: finance_cash_forecast_settings, finance_cash_forecast_snapshots
- finance/inventory: inventory_products, inventory_warehouses, inventory_movements
- finance/management-report: finance_management_reports, finance_management_report_actions, finance_management_decisions(+ finance_assistant_answers)
- finance/master-data: finance_master_accounts, finance_master_partners, finance_master_partner_aliases, finance_master_bank_accounts, finance_master_tax_codes, finance_master_change_requests
- finance/operations: finance_reconciliations, finance_cash_forecast_items, finance_close_tasks, finance_close_runs, finance_budgets, finance_expense_requests, finance_payment_ledger, finance_journal_entries(`erp_documents`는 /api/documents가 계속 만든다)
- finance/project-costing: finance_cost_centers, finance_project_monthly_budgets, finance_project_allocations
- finance/purchasing: finance_purchase_vendors, finance_purchase_orders, finance_purchase_order_lines, finance_purchase_receipts, finance_purchase_receipt_lines, finance_purchase_invoices, finance_payable_plans, finance_expense_requests
- finance/receivables: finance_receivable_management, finance_receivable_cases, finance_receivable_notes
- finance/reconciliation: finance_bank_transactions, finance_cash_matches
- finance/tax: finance_tax_periods
- finance-alert-actions-server.ts: finance_alert_cases, finance_alert_case_events
- finance-assistant-history.ts: finance_assistant_answers
- finance-risk-policy-server.ts: finance_cash_forecast_settings
- finance-posting.ts: finance_posting_batches, finance_posting_vouchers, finance_posting_lines, finance_posting_events
- finance-opening-balance.ts: finance_opening_balance_sets, finance_opening_balance_lines, finance_opening_balance_events
- finance-import-mapping.ts: finance_import_mapping_sets, finance_import_mapping_rules, finance_import_validations, finance_import_canonical_rows, finance_import_mapping_events
- finance-tie-out.ts: finance_tie_out_checks
- sales(route.ts): sales_accounts, sales_opportunities, sales_incentive_rules, sales_documents, sales_catalog_items, sales_document_lines, sales_payment_allocations, sales_account_contacts, sales_account_identity_keys, sales_opportunity_activities, sales_opportunity_stage_history
- sales/accounts: sales_account_identity_keys, sales_account_owner_history, sales_account_merges
- sales/crm: sales_account_contacts, sales_opportunity_activities, sales_opportunity_stage_history
- sales/incentives: sales_incentive_rules, sales_incentive_results, sales_incentive_validations, sales_incentive_notes, sales_incentive_payroll_links
- sales/planning: sales_target_plans, sales_target_lines, sales_forecast_snapshots
- sales-contracts.ts: sales_contract_governance_settings, sales_contracts, sales_contract_obligations, sales_contract_change_requests
- sales-pricing.ts: sales_price_lists, sales_price_list_items, sales_pricing_policies, sales_document_pricing_reviews
- sales-service.ts: sales_service_policies, sales_service_cases, sales_service_case_events, sales_service_return_lines
- sales/sheet-sync: sales_sheet_sync_runs, sales_sheet_revenue_records, sales_sheet_lead_conversions, 동적 테이블 sales_sheet_lead_protections, sales_sheet_inbound_leads, sales_sheet_deliveries, sales_sheet_service_logs, sales_sheet_price_catalog
- erp-platform.ts(유지 파일): erp_approval_requests, erp_approval_policies, erp_approval_policy_steps, erp_approval_delegations, erp_approval_steps, erp_approval_events, erp_tasks(`:71`), erp_sync_runs(`:150`)
- data-governance.ts: erp_data_control_runs, erp_data_control_checks, erp_logical_snapshots, erp_recovery_rehearsals, erp_audit_exports, erp_retention_policies
- data-integration.ts: erp_integration_sources, erp_integration_exceptions, erp_sync_run_events
- data-intake.ts: erp_data_import_batches, erp_data_import_rows, erp_data_import_events(이 라우트가 만들던 hr_payroll_records·hr_payroll_runs는 HR 라우트가 계속 만든다)
- master-impact.ts: erp_master_impact_assessments, erp_master_impact_cases, erp_master_impact_case_events, erp_master_impact_sla_policies, erp_master_impact_weekly_reports, erp_master_impact_weekly_report_reviews, erp_master_impact_weekly_report_events
- workbench: erp_workbench_preferences
- hr/payroll(유지 라우트): finance_expense_requests(`:103-114`, ALTER `:124-128`)
- R3: hr_authorized_users, erp_user_access

### A.7 남는 `app/` 파일 (제거와 무관, 48개)

- api/hr: analytics, applicant-interview-recordings, catalogs, employee-records, interviews, message-templates, organization-leaders, recruitment, resume-analysis, training, transcriptions
- 그 밖: asset-imports.d.ts, assistant-recruitment.ts, assistant-retirement-pay.ts, audio-transcription-control.tsx, chatgpt-auth.ts(R3 삭제), compensation-calculation.ts, compensation-calculator.css, compensation-settings.ts, erp-dialog.tsx, hr-analytics-view.tsx, hr-assistant-context.ts, hr-company-data.ts, hr-compensation-schema.ts, hr-dashboard-charts.tsx, hr-dashboard-model.ts, hr-employee-roster.ts, hr-employee-schema.ts, hr-employment-contract.ts, hr-interview-question-templates.ts, hr-leave-accrual.ts, hr-leave-view.tsx, hr-onboarding.ts, hr-optional-tables.ts, hr-ordinary-wage.ts, hr-personnel-actions.ts, hr-retirements.ts, hr-severance-calculation.ts, hr-transcriptions.ts, hr-ui.tsx, incentive/incentive-calculator.tsx, incentive/incentive.module.css, incentive/layout.tsx, incentive/page.tsx, payroll-seed-data.ts, performance-management-view.tsx, training-management-view.tsx, won-input.tsx
- 이 가운데 R1·R3에 수정되는 파일은 A.5에 따로 적었다. `public/`의 file.svg·globe.svg·window.svg는 어디서도 참조하지 않는 템플릿 잔재지만 제거 기능의 자산이 아니므로 이번 범위에서 건드리지 않는다.

---

## Appendix B. Option C 원안 대비 변경 (Design 공유 계약 v0.1 §0)

Option C 원안을 인용할 때는 이 표로 교정한다. 본문의 '부록 B #N'은 이 표의 행이다.

| # | 원안 | 확정 | 근거 |
|---|------|------|------|
| 1 | `app/incentive/page.tsx`·`layout.tsx`·`public/incentive-og.png` 삭제 | 유지한다. `/incentive`는 클라이언트 `RequireTab tab="compensation"`(세션 + compensation 보기 이상)으로 막는다 | D1·D22, Plan M4 |
| 2 | 제거 목록에 `incentive-governance.tsx`(원안도 삭제) | R1(r1-delete)에서 영업 코드와 함께 삭제한다. Plan §1.2의 'D1 보류' 행과 NFR 문자열 검사 예외는 없어진다 | D22 |
| 3 | 재무 실데이터 4개를 `archive/finance-data/`로 이동 | 작업 트리에서 지운다. 보관은 archive 태그·브랜치와 `C:\xdm\archive\finance-data-20260923\`(SHA-256 기록) 두 곳뿐이다 | Plan M1-4, 심사1 |
| 4 | `scripts/restore-known-data.mjs` 삭제 | 유지한다. R3에서 `scripts/xdm-login.mjs`로 로그인하도록 바꾸고, `:62`의 `LOCAL_ERP_USER_EMAIL` 안내 문구를 고친다 | Plan M5a('보관') |
| 5 | `GET /api/hr/compensation?view=roster`(급여를 포함한 13필드) | API를 `/api/compensation`으로 옮기고 `GET /api/compensation/roster`를 새로 둔다. 필드는 **`employeeId, name, department, status` 4개만**이다 | D20, Plan M4 |
| 6 | include=hr에 PII가 없다고 봄 | `hrPayrollSnapshots`의 `birthDate`(`app/api/hr/compensation/route.ts:129`)를 `""`로 내린다 | 심사1, Plan M4 |
| 7 | `/api/me`가 항상 200을 내고 `state`로 구분 | 비로그인과 부트스트랩 필요 상태는 **401**이고 `code`로 구분한다. R4 헬스체크의 '401이면 정상'과 맞춘다 | Plan M4·R4 |
| 8 | 잠금: 조회 → 검증 → UPDATE | 검증하기 전에 시도를 원자적으로 예약한다(§7.4). D21 루프백 예외를 둔다 | Plan M3, D21 |
| 9 | `x-xdm-peer: loopback\|lan` | 값은 Node가 확인한 **주소**(`127.0.0.1`, `192.168.0.50` 등)다. 감사에 주소를 남기기 위해서다 | FR-11, Plan M3 테스트 |
| 10 | 플러그인 순서를 배열 위치로만 보장 | `enforce:"pre"`와 배열 첫 항목을 둘 다 쓴다. `upgrade` 리스너는 전부 감싼다. 비루프백의 `/cdn-cgi/*`·`/__debug*`는 404다. `cloudflare({ inspectorPort:false })`를 둔다 | D20, 스파이크 |
| 11 | CSRF를 가드 안(`headers()`)에서만 검사 | 메서드를 아는 `worker/index.ts`가 `/api/*` 비GET을 먼저 막는다. 가드와 인증 라우트는 메서드와 무관한 규칙을 한 번 더 적용한다(§7.3). `authorizeErpRequest`는 시그니처를 유지하므로 메서드를 모른다 | Plan M3, D20 |
| 12 | 채팅 라우트 4개(poll은 messages GET) | 라우트 5개로 두고 `/api/chat/poll`을 따로 뺀다 | D20 |
| 13 | 채팅 DDL을 `chat-server.ts`에 둠 | `app/chat-schema.ts`의 `chatSchemaStatements`에 두고 `ensureErpPlatformSchema`가 모아서 만든다 | D20 |
| 14 | 삭제 감사에 `bodyPreview`(200자) | 본문, 미리보기, 채널 이름, 파일 이름을 남기지 않는다. id, 길이, 개수만 남긴다 | D20 |
| 15 | 비멤버는 403 | 비공개 채널·DM의 비멤버에게는 **404**를 돌려준다 | Plan R5 |
| 16 | poll 2.5초, `accessStamp` 동봉 | 2초(채팅 탭이 보일 때)와 15초로 나누고 `accessStamp`는 없앤다. 권한 갱신은 `/api/me`를 focus·visibility 변화 때와 60초마다 다시 불러서 한다 | Plan R5, 심사2 |
| 17 | `TAB_KEYS`·`ErpModule` 유니온·`MODULE_TAB` 리터럴을 각각 작성 | 모두 `TAB_REGISTRY[].modules`에서 파생한다. `MODULE_TAB`은 `Map`이다(프로토타입 키 차단). 없는 모듈은 isAdmin 판정보다 먼저 거부한다 | D20 |
| 18 | 라우트 3곳에 `privileged` 람다 | `isHrManager(principal)` 하나를 `app/access-tabs.ts`에 둔다 | D20 |
| 19 | page.tsx의 탭 분기를 손으로 작성 | `TAB_PANELS: Record<TabKey, …>` 전수 맵을 쓴다. 상단 내비와 계정 칩은 `app/shell-top-nav.tsx`로 옮긴다 | D20 |
| 20 | `setIdentity` shim을 기한 없이 유지 | r3-auth에서 도입하고, r3-tabs 끝에서 호출부 7곳(`tests/hr-api-integration.test.mjs:23,38,76,118,120,332,341`)을 옮긴 뒤 삭제한다 | D20 |
| 21 | 즉시 반영 로직을 각 라우트에 직접 작성 | 문장 생성기는 `app/hr-transitions.ts`에 모으고, `db.batch`와 `meta.changes` 검사는 라우트에 남긴다 | D20 |
| 22 | 영업 인센티브·재오픈 409를 테이블 조회로 판정 | 테이블을 읽지 않는 정적 목록 `LEGACY_SALES_INCENTIVE_PERIODS`, `LEGACY_FINANCE_LOCKED_PAYROLL_PERIODS`를 쓴다. M1-0과 R1 직전 재조회 결과로 채운다(조사 시점 0건, 20건 모두 UNPOSTED이므로 빈 배열). 조회에 쓰는 컬럼은 `payroll_period`·`applied_amount`다(status 컬럼 없음) | FR-03·FR-04, Plan M1-0, 심사1·3 |
| 23 | `start`를 preview 0.0.0.0로 바꿈 | `serve:lan`을 새로 두고, `start`는 `vite preview --host 127.0.0.1 …`(서버 PC 점검용)로 바꾼다 | Plan M5a |
| 24 | 백업 02:00, 로그온 트리거, blob `/MIR` | 백업은 03:00, 자동 기동은 '시스템 시작 시'(D19)로 한다. blob은 단일 저장소에 `robocopy /E`로 복사한다(삭제하지 않음) | Plan R4, D19 |
| 25 | (B 이식) `/api/directory` | 만들지 않는다. 미연결 계정 이름은 `accountNames`(`GET /api/hr/operations`)와 감사 뷰어의 `auth_accounts` 조인으로 표시한다 | 탭에 대응하지 않는 라우트를 늘리지 않음 |
| 26 | R3에 채팅 레지스트리 항목 | 레지스트리 항목, 패널, 라우트, DDL을 모두 R5에서 함께 추가한다(R5만 되돌릴 수 있게). R3 계정 관리 화면은 hr·compensation만 부여한다 | SC-2('chat 열은 R5'), Plan R5 |
| 27 | 본문을 읽은 뒤 인가(assistant `:36`→`:47`, documents `:75`→`:84`, payroll PUT `:385`→`:392`, operations PUT `:446`→`:451`, transcriptions POST `:69`→`:72`, recruitment POST `:544`→`:547,:593`) | R3에서 **리터럴 모듈로 먼저 인가하고 그다음 본문을 읽는다**. documents PATCH(`:160`→`:170`)·DELETE(`:196`→`:200`)도 같은 문제라 대상에 넣어 8곳이다 | Plan §8.2 |
| 28 | 하니스가 SUPER_ADMIN 헤더를 주입 | 관리자 세션 쿠키를 주입하고, 기본 peer는 비루프백 `192.0.2.10`으로 둔다 | fail closed |

---

## Appendix C. 설계 조정 기록과 열린 질문

**계약 v0.1과 다르게 하거나 계약에 더한 점**(코드로 확인)

1. `bundle-exposure` 표지: 계약의 `/annualSalary:\s*\d/`·`/basePay:\s*\d/`는 R1 뒤에도 오탐이 난다. 남는 코드에 `annualSalary: 0` 기본값(`app/compensation-calculator.tsx:61`), 열 너비 표 `annualSalary: 98`(`:32`), 예시 명부 `annualSalary:6e7`(`:371-373`)이 있기 때문이다. 서버 시드에서 뽑은 실제 값과 대조하도록 바꿨다(§7.9).
2. worker CSRF·헤더 위치: `/_vinext/image` 분기(`worker/index.ts:32-41`)가 조립부(`:43-51`)보다 먼저 반환하므로, CSRF는 두 분기 앞에, 헤더는 공통 `finalize()`에 둔다(§7.7).
3. 플러그인 경로 판정: pathname 정규화(absolute-form, 퍼센트 인코딩, 대소문자, 연속 `/`)와 '기동 뒤 upgrade 리스너 1개' 단언을 더했다(§7.6).
4. poll `watch`: 서버가 `kind='public'`이고 보관되지 않은 채널일 때만 받는다(§4.2.8 SQL에 `archived_at IS NULL` 포함).
5. `ASSISTANT_MODULES` 조회 전 `Object.hasOwn`으로 프로토타입 키를 막는다.
6. `opsSchemaStatements`(R4)는 새 파일 없이 `app/erp-platform.ts`에 둔다. 백업 스크립트가 정지 중에 같은 DDL을 직접 실행하므로 두 문자열이 같은지 `lan-exposure-guards`(R4)로 단언한다.
7. D21 운영 전제: 서버 PC에 리버스 프록시·portproxy를 두지 않는다. R3 스모크에서 `netsh interface portproxy show all`로 확인한다.
8. `allowedHosts` 기본값 유지: DNS rebinding을 막는 층은 Vite hostValidation뿐이라, Option C 원안의 PC 이름 허용을 채택하지 않았다.
9. 잠금 예약 UPDATE에 `RETURNING failed_attempts, locked_until`을 붙였다. 반환 행이 없으면 `changes === 0`과 같으므로 계약 조건과 충돌하지 않는다. `ACCOUNT_LOCKED`를 한 번만 남기기 위해서다.
10. XSS 소스 가드(`dangerouslySetInnerHTML`·`innerHTML` 0건)를 `removal-guards` R5 단언에 더했다.
11. `build/**`는 lint 대상이 아니다(`eslint.config.mjs:15`). 플러그인은 테스트로만 지킨다.
12. 본문 읽기 줄 번호: transcriptions POST는 `:68`이 아니라 `:69`다(`:68`은 `ensureHrTranscriptionSchema`). documents PATCH·DELETE도 본문을 먼저 읽으므로 인가 선행 대상이 6곳에서 8곳이 됐다.
13. 오류 code 두 개를 더했다: `DUPLICATE`(409), `CHANNEL_ARCHIVED`(409). `CONFLICT`의 고정 문구와 뜻이 다르기 때문이다.
14. 채팅 응답 필드를 더했다: poll `resync:true`(백업 복구 뒤 `since > head`), `ChatChannelDto.dmMemberIds`·`myRole`·`archived`.
15. `/api/compensation` POST action에 코드에 있는 `APPLY_RETIREMENT_PAY`(`:264-280`)를 넣었다. `LEGACY_SALES_INCENTIVE_PERIODS` 409는 CONFIRM에만 건다.
16. 채널 POST는 `chat:read`로 먼저 인가해 본문을 읽고, 쓰기 action에만 `chat:write`로 한 번 더 인가한다(이 라우트만 중첩 인가 유지).
17. `copyText()` 대상에 Plan에 있던 `app/hr-leave-view.tsx:88,214`를 더했다(계약 §1.4 목록에 빠짐).
18. `tests/hr-api-integration.test.mjs`의 authorized-users 케이스(`:9`, `:31`) 정리는 라우트가 삭제되는 R3로 옮겼다.
19. 부수효과 GET(`applyDue*`)은 Plan M3의 'POST로 옮기기' 대신 GET에 두고 한계를 runbook에 적는다(계약 §5.6과 같음).
20. documents POST 인가 선행은 Plan M1-1대로 R1에서 한다(계약 `r1-decouple`의 '인가 선행은 R3'을 고침). R1의 선행 인가는 `recruitment:write`이고, 폼을 읽은 뒤 `hr` module이면 `hr:write`를 더 본다. 리터럴 `hr:write`로 먼저 인가하면 RECRUITER(`recruitment:write`만 보유, `erp-platform.ts:27`)의 채용 문서 업로드가 R1~R2 동안 막히기 때문이다. GET·PATCH·DELETE의 인가 선행은 R3(§4.3.2 8곳)에 그대로 둔다.
21. 채팅 첨부 다운로드는 현재 멤버만 받는다(Plan R5·FR-13). 계약 §3의 '공개 채널이면 누구나'를 버렸다. 공개 채널 비멤버는 403 `FORBIDDEN`, 비공개·DM 비멤버는 404다(§4.2.8).
22. chat=view 계정도 공개 채널 `JOIN`·`LEAVE`와 `read-state` PUT을 할 수 있다. 메시지·첨부·채널을 만들지 않고, 본인의 멤버십과 읽음 위치만 바꾼다. Plan R5 '보기는 읽기만'을 이렇게 해석했다(읽음 위치는 FR-14에 필요, JOIN은 공개 채널 알림을 받기 위한 본인 범위 설정). 사용자가 JOIN·LEAVE를 편집으로 올리길 원하면 view 계정은 공개 채널을 비멤버로 읽게 바꾼다(열린 질문 4).
23. D21 루프백 면제는 `POST /api/auth/login`에만 적용한다. `PUT /api/auth/password`의 현재 비밀번호 검증은 peer와 관계없이 잠금 `WHERE`가 붙은 예약을 쓴다(§4.2.4, §7.4). 초안은 4.2.2 4~5단계를 그대로 참조해 면제가 비밀번호 변경까지 번져 있었다.
24. 로그아웃·세션 401 때 급여성 localStorage 데이터 키 4개(`xdnode-incentive-deals-v1`·`-adjustments-v1`·`-payroll-v1`·`-excluded-people-v1`)를 지운다(`clearScopedDataKeys()`, §5.5). 범위 키만으로는 같은 Windows 프로필 사용자의 개발자 도구 열람을 막지 못하기 때문이다(R-11). 화면 설정 키는 남긴다.
25. `dev` 스크립트에 `--port 3100 --strictPort`를 붙였다(계약 §5.12는 포트 없음). 전환 뒤 개발 dev가 운영 3000이나 점검 3001을 차지하거나, `http://localhost:3000`이 빈 DB의 dev 인스턴스로 가는 일을 막는다. `reset-admin-password.mjs`의 거부 조건도 '대상 `--state`를 쓰는 서버'로 정했다(§11.5.6).
26. `hr-company-data.ts`는 카탈로그 심볼을 `hr-company-catalogs.ts`에서 재수출한다. 서버 사용처 13곳(§12.5)의 import를 R1에서 바꾸지 않기 위해서다. 클라이언트만 카탈로그 파일을 직접 import한다.
27. `acct_` 접두 차단을 `PUT /api/hr/recruitment`의 입사 전환(`:303`)·오퍼 수정(`:392`)에도 둔다. 이 두 경로가 사용자 입력 id로 `hr_employee_records`를 만든다(`:457`). self·manager 판정은 `principal.linkedEmployee === true`일 때만 한다(§3.2, §10.4-8).

**열린 질문 (Do 전에 사용자 확인)**

1. 과거 LOAD_HR로 저장된 `hr_compensation_lines.snapshot_json`의 생년월일: GET run으로 compensation 보기 계정에게 내려간다. 출력 단계에서 지우면 엑셀로 올린 생년월일까지 사라진다. 이 문서는 `:129`만 고친다. 저장된 값을 일괄로 비울지, 그대로 둘지 정해야 한다(§7.11 R-16).
2. 정적 기간 목록의 최종 값: `r1-preflight`와 `r1-verify`의 조회 결과로 정한다. 1건 이상 나오면 처리 방법을 사용자와 정한다.
3. `public/og.png` 교체 이미지(R2): 새 이미지를 누가 만들지.
4. chat=view의 공개 채널 `JOIN`·`LEAVE`: 부록 C #22의 해석(보기로 허용)을 유지할지, 편집으로 올릴지.

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-09-23 | 초안. Design 체크포인트 D20~D23(설계안 C, 루프백 잠금 예외, `incentive-governance.tsx` 삭제, audit·admin 관리자 전용) 반영. 공유 계약 v0.1(파일·테이블·엔드포인트·상수)을 본문으로 통합, Option C 원안 대비 변경 28건(부록 B), 계약 대비 조정 19건과 열린 질문 3건(부록 C) | gc.kim / Claude Code |
| 0.1 검증 반영 | 2026-09-28 | 검증 지적 27건 반영(부록 C #20~#27, 열린 질문 4). Plan 정합: documents POST 인가 선행을 R1로(RECRUITER를 막지 않도록 `recruitment:write` 선행), 채팅 첨부는 멤버만, D21 면제는 로그인만, R0 확인 2건·R2 바로가기·R6 체크리스트(§11.5.10) 배정, SC-7 채팅 부분을 R5 뒤 재실행, SC-8 행과 FR→검증 추적표(§8.6) 추가. 보안: recruitment 입사 전환·오퍼 수정의 `acct_` 차단, 로그아웃 때 급여성 localStorage 키 삭제, 관리 action도 비멤버 404, `ADD_MEMBERS` 대상 필터, `.dev.vars`·`.env.local` 노출 점검, 헤더 없는 비GET CSRF 테스트, dev 포트 3100 분리. 코드 사실 교정: `hr-company-data` 카탈로그 재수출과 서버 사용처 13곳, 타입 검사 단계 없음(roles·`TAB_PANELS`는 테스트로 단언), `server-only` 근거 파일, 브리지 줄 번호, `hr_payroll_*` 생성 라우트, `erp_user_access` 런타임 SQL `:220-235`, `ApprovalSettings` R1 범위 `:4644-4747`, 본문 전 인가 테스트 #27, 호출부 56개, poll `LIMIT 201`, HR 라우트 18개 | gc.kim / Claude Code |
