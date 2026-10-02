# general-affairs Completion Report

> **Status**: Complete(코드·운영 반영) · 운영 사용자 점검 남음
>
> **Project**: XDnode management (`xdnode-management`)
> **Version**: 기획 `9ad50bf`·`1cd9f12` → GA1 `84820d9`(`ga1-release-20260930`) → … → `91137a3`(`ga1.5-release-20261001`) → 병합 `c09eb32`(`msg1-release-20261001`, 현재 운영본)
> **Author**: gc.kim (Claude Code 협업)
> **Completion Date**: 2026-10-01(기능), 2026-10-02(Check·상태 동기화)
> **PDCA Cycle**: #1 (Act 없음. 운영 반영 뒤 사용자 요청으로 범위 추가 4회)

---

## Executive Summary

### 1.1 Project Overview

| Item | Content |
|------|---------|
| Feature | general-affairs: 총무 탭(자산 4종·회사 서류·인감 반출·만료 알림·엑셀·HR 연결), 뒤에 AI 자동 채우기와 간식 구입 |
| Start Date | 2026-09-30 (기획 v0.1) |
| End Date | 2026-10-01 (`ga1.5`), Check 2026-10-02 |
| Duration | 2일. Plan(v0.1~0.3) → Design(GD-1~12) → Do(GA1 한 번에) → 운영 반영 6회 → Check(95%) |

### 1.2 Results Summary

```
┌─────────────────────────────────────────────┐
│  Match Rate: 95% (정적, Design 대비)           │
├─────────────────────────────────────────────┤
│  ✅ FR:            11 / 11                    │
│  ✅ Plan 범위:     30 / 32 (부분 1, 선택 1)    │
│  ⏳ 완료 기준:      1 / 4  (운영 확인 3개 남음) │
│  ❌ Cancelled:     0                          │
└─────────────────────────────────────────────┘
```

### 1.3 Value Delivered

| Perspective | Content |
|-------------|---------|
| **Problem** | 자산과 서류가 엑셀 일부, 담당자 기억, 캐비닛에 흩어져 있었다. 노트북 사용자, 도메인·보험 만료일, 법인인감의 현재 위치를 한곳에서 볼 수 없었다. 퇴직 체크리스트의 '자산 반납'은 체크박스뿐이었다. |
| **Solution** | 탭 레지스트리에 `general` 한 항목을 더했다(FR-16 규칙 그대로). 테이블 12개(`ga_*`), 라우트 10개를 만들었다. 알림은 순수 함수로 계산한다. 메신저 글만 하루 한 번 서버 PC 작업 스케줄러가 세션 없이 루프백으로 실행한다. 작성자는 계정이 아닌 `system:ga` 다. 첨부 규칙은 메신저와 공용 모듈(`app/attachment-rules.ts`)로 합쳤다. |
| **Function/UX Effect** | 현황 화면 하나에서 만료 임박, 반출 중, 유형별 장부가, 직원별 지급 장비, 재고 부족을 본다. 서류를 등록할 때 PDF·사진을 고르고 「AI로 채우기」를 누르면 종류·발급일·상대방·기간·금액이 채워진다(합성 서류 6~7초). 퇴직 정산 화면에 그 직원의 미반납 장비가 뜨고 총무 탭으로 이어진다. |
| **Core Value** | 자산·법적 서류·인감의 현황, 책임자, 기한을 한 도구에서 추적한다. 모든 변경은 사람 이름으로 감사 로그에 남고, 감사 행에는 서류명·계약번호·파일 이름을 남기지 않는다. |

---

## 1.4 Success Criteria Final Status

| # | Criteria | Status | Evidence |
|---|---------|:------:|----------|
| GA-SC-1 | 기존 엑셀 일부를 가져와 장부가 채워진다 | ⏳ Pending | 기능은 ga-api #13(미리보기·전부 또는 없음·건너뛰기/덮어쓰기·되돌리기). 운영 가져오기 0건 |
| GA-SC-2 | D-30 안의 항목이 배지와 메신저 '총무' 채널에 같은 날 나온다 | ⚠️ Partial | 알림 실행은 매일 1회 확인(2026-10-01·10-02, 멤버 2명 동기화). 운영에 D-30 안의 항목이 없어 글은 아직 없다 |
| GA-SC-3 | 반출 중인 인감이 현황 첫 화면에 보인다 | ⏳ Pending | ga-api #6. 운영 보관품 0건 |
| GA-SC-4 | 퇴직 정산 화면에 미반납 장비가 뜬다 | ⏳ Pending | ga-api #14. 운영 자산 0건 |
| GA-SC-5 | 총무 권한 없는 계정은 탭이 없고 API 가 403 | ✅ Met(테스트) | ga-api #1, tab-permissions·access-policy. 운영 비로그인 요청 401 |

**Success Rate**: 테스트로 확인할 수 있는 기준은 모두 충족했다. 운영 사용자 점검은 실제 자산·보관품 데이터가 들어간 뒤 한다(2026-10-02 기준 운영 데이터는 서류 8건·첨부 8개).

## 1.5 Decision Record Summary

| Source | Decision | Followed? | Outcome |
|--------|----------|:---------:|---------|
| [Plan] GA-D1 | 엑셀 열은 양식별로 우리가 정한다 | ✅ | 7시트 양식, 머리글 이름으로 열을 찾는다. 내보내기도 같은 열이라 고쳐서 다시 가져올 수 있다 |
| [Plan] GA-D2 | 기업 간 계약서, 자동 연장은 해지 통보 기한만 알림 | ✅ | ga-api #8 |
| [Plan] GA-D3 | 알림 채널은 총무 보기 이상 활성 계정만 | ✅ | 실행 때마다 추가·제거. 운영 `members=2` |
| [Plan] GA-D4 | 반출은 결재 없이 기록만 | ✅ | 부분 UNIQUE 인덱스로 동시 반출 409 |
| [Plan] GA-D5 | 한 릴리스(GA1) | ✅ | `84820d9` 한 커밋(41파일, +3,594) |
| [Plan] GA-D6 | 서류 원본 보관 위치 입력 삭제, 열과 기존 값 유지 | ✅ | `4dcce1c` |
| [Plan] GA-D7~D9 | Claude AI 자동 채우기, 덮어쓰기 + 'AI' 표시, 모든 서류·자산 4종 | ✅ | `5c99864`. 다리 `/extract` 는 도구를 끄고 디스크에 쓰지 않는다 |
| [커밋] GA-D10 | 간식 구입 화면(캡처 AI 읽기) | ✅ | `91137a3`. **Plan 결정표에는 없다**(분석 §4) |
| [Design] GD-5 | 감가상각표는 저장하지 않고 계산 | ✅ | 정액법 월할. 기초 누계가 있을 때 '월 상각액' 표시 오류는 2026-10-02 수정(§4.1) |
| [Design] GD-7 | 알림은 09:00 작업 + Start 후 한 번, KST 날짜별 멱등 | ✅ | 2026-10-02 09:00 작업이 재기동과 겹쳐 실패했지만 09:00:20 따라잡기가 실행했다 |
| [Design] GD-8 | 작성자 `system:ga`, 계정 아님 | ✅ | `auth_accounts` 에 행이 없다(ga-api #11). 메신저 개선 병합 뒤에도 반응·읽음과 함께 동작 |
| [Design] GD-10 | 첨부 규칙 공용 모듈 | ✅ | `chat-server.ts` 는 다시 내보내기만 한다. 인증서 파일 415 |
| [Design] GD-11 | 퇴직 미반납 조회는 HR 라우트가 읽기 전용으로 | ✅ | 새 DB(표 없음)에서는 표를 만들지 않고 [] |

---

## 2. Related Documents

| Phase | Document | Status |
|-------|----------|--------|
| Plan | [general-affairs.plan.md](../01-plan/features/general-affairs.plan.md) | ✅ v0.4(상태 동기화 31/36) |
| Design | [general-affairs.design.md](../02-design/features/general-affairs.design.md) | ✅ v0.1 + §11·§12(GA-D10 미반영) |
| Check | [general-affairs.analysis.md](../03-analysis/general-affairs.analysis.md) | ✅ 95% |
| Act | 이 문서 | ✅ |

---

## 3. Completed Items

### 3.1 Functional Requirements

| ID | Requirement | Status | Notes |
|----|-------------|--------|-------|
| GA-FR-01 | 총무 탭·API 권한(none·view·edit) | ✅ | 레지스트리 1항목, 기존 권한 테스트가 자동으로 포함 |
| GA-FR-02 | 자산 대장 CRUD, 유형 4종, 자산번호 UNIQUE, 상태 전이 | ✅ | 조건부 UPDATE, 0행이면 409 |
| GA-FR-03 | 자산 이력과 현재 사용자·수량 일치 | ✅ | 이력은 앞 UPDATE 가 행을 바꿨을 때만(`changes() > 0`) |
| GA-FR-04 | 정액법 월할 감가상각, 처분 뒤 정지 | ✅ | 월 상각액 표시 오류 1건, 2026-10-02 수정(§4.1) |
| GA-FR-05 | 회사 서류 대장, 스캔본 첨부 보안 | ✅ | nosniff·sandbox CSP·이미지만 inline |
| GA-FR-06 | 반출 대장, 동시 반출 409 | ✅ | |
| GA-FR-07 | 만료 구간·항목별 끄기·탭 배지 | ✅ | 배지 10분마다·창 복귀 때 |
| GA-FR-08 | 메신저 하루 한 번, 멱등 | ✅ | `ga_alert_runs` 가 batch 첫 문장 |
| GA-FR-09 | 엑셀 양식·가져오기·내보내기 | ✅ | 한 번에 500행 |
| GA-FR-10 | 퇴직 정산 미반납 자산 | ✅ | `#ga-asset=<id>` 와 `xdm:open-tab` 이벤트로 총무 탭 상세를 연다 |
| GA-FR-11 | 감사 module `general`, 민감 값 제외 | ✅ | ga-api #15 |
| (범위 추가) | 등록 창 첨부, AI 자동 채우기, 간식 구입 | ✅ | GA-D6~D10, 분석 §4 |

### 3.2 Non-Functional Requirements

| Item | Target | Achieved | Status |
|------|--------|----------|--------|
| 첨부 접근 | 총무 보기 이상, 확장자 표 | 보기 권한자는 다운로드만, pfx 415, 26MB 413 | ✅ |
| 날짜 | KST 달력 날짜 | `kstToday`, 날짜 경계 테스트. 내보내기 파일 이름만 UTC(§4.1) | ⚠️ |
| 데이터 | 추가만, soft-delete, DROP 없음 | `ga_attachments` CHECK 를 바꾸지 않으려고 영수증 표를 따로 뒀다(D4) | ✅ |
| 감사 | 파일 이름·서류명·계약번호 없음 | AI 인식도 대상·이미지 수·채운 칸 수만 | ✅ |
| 로그인 경로 | 시스템 작성자는 계정 아님 | `system:ga`, 원격 호출은 401 | ✅ |
| AI 다리 | 도구 끔, 디스크 쓰기 없음, 한 번에 하나 | `--tools ""`, stream-json 표준입력, 16MB·이미지 4장 | ✅ |

### 3.3 Deliverables

| Deliverable | Location | Status |
|-------------|----------|--------|
| 라우트 10 | `app/api/general/{assets,documents,custody,people,overview,attachments,import,alerts,extract,snacks}/route.ts` | ✅ |
| 서버 | `app/ga-schema.ts`(테이블 12), `ga-server.ts`, `ga-alerts.ts`, `ga-alert-run.ts`, `ga-import.ts`, `ga-extract.ts`, `attachment-rules.ts` | ✅ |
| 클라이언트 | `app/general-workspace.tsx/.css`, `general-snacks-view.tsx`, `general-client.ts`, `ga-extract-client.ts` | ✅ |
| HR·메신저 연결 | `app/api/hr/operations/route.ts`(retirementAssets), `hr-workspace.tsx`, `chat-server.ts`(시스템 작성자 DTO), `chat-workspace.css` | ✅ |
| 운영 스크립트 | `scripts/Run-GaAlerts.ps1`, `Start-XDNodeManagement.ps1`(09:00 이후 따라잡기), `Register-XDNodeManagementTasks.ps1`(Alerts 작업), `claude-resume-bridge.mjs`(`/extract`) | ✅ |
| 테스트 | `tests/ga-api.test.mjs` 16개, 기존 탭 목록 기대값 갱신 | ✅ |
| 커밋 | `84820d9`, `c30705e`, `ee0cc24`, `4dcce1c`, `5c99864`, `91137a3` (변경 71파일, +5,032/−210) | ✅ |

---

## 4. Incomplete Items

### 4.1 Carried Over

| Item | Reason | Priority | Estimated Effort |
|------|--------|----------|------------------|
| 기초 상각누계가 있는 자산의 '월 상각액' 표시 | `monthly` 가 상각표 첫 줄(= 기초 누계)을 쓴다. 누계·장부가는 맞다 | 수정됨(2026-10-02) | — |
| 운영 사용자 점검 GA-SC-1~4 | 운영에 자산·보관품·반출·가져오기 데이터가 아직 없다 | High | 데이터 입력 뒤 1회 |
| 복원 리허설의 `ga/` 첨부 | 2026-10-01 리허설 때 총무 0건. 지금은 첨부 8개 | Medium | 다음 리허설 |
| 서류 유효기간 기본 3개월 | 필드는 있으나 기본값이 들어가지 않는다 | Low | 0.5시간 |
| 내보내기 파일 이름 KST | 00~09시에 전날 날짜 | Low | 10분 |
| 알림 trigger 기록(task·startup 구분), 보관된 알림 채널 처리 | 분석 §2 | Low | 1시간 |
| Plan·Design 에 GA-D10 반영 | 커밋에만 기록 | Low | 문서 |
| 입사 체크리스트 → 장비 지급 링크 | Plan 의 선택 항목, Design 에 없음 | — | 요청 시 |

### 4.2 Accepted Limitations

| Item | Reason |
|------|--------|
| 첨부 다운로드는 감사하지 않는다 | R-GA2: 접근은 총무 보기 권한으로 막는다 |
| 감가상각은 관리용 정액법 월할만 | R-GA5: 화면에 "세무 신고 금액과 다를 수 있습니다" |
| 비품의 위치별 수량은 위치마다 행을 따로 둔다 | GD-2: 한 테이블·한 수량 컬럼 |
| 가져오기 되돌리기는 새로 만든 행만 | 덮어쓴 행은 되돌리지 않는다고 화면에 안내 |
| 09:00 작업이 재기동과 겹치면 작업 스케줄러에 실패(1)로 남는다 | 그날 알림은 Start 의 따라잡기가 보낸다(2026-10-02 실제 사례) |

---

## 5. Quality Metrics

### 5.1 Final Analysis Results

| Metric | Target | Final |
|--------|--------|-------|
| Design Match Rate (정적) | 90% | 95% |
| Tests (`npm test`, build 포함) | 전부 통과 | 528/528(병합 `c09eb32`). 2026-10-02 하니스 8파일 232/232 재확인 |
| ga-api | 전부 통과 | 16/16 |
| 실제 개발 서버 점검 | 주요 흐름 | 18항목(지급·반출·HR 은 하니스로 대신) |
| Lint | 0 | 총무 파일 0 |
| Security | 무권한 노출 0 | 0(테스트), 운영 비로그인 401 |

### 5.2 Resolved Issues

| Issue | Found in | Resolution |
|-------|----------|------------|
| 03:00 백업 재기동이 그날 알림 실행을 먼저 써 버린다(10-01 03:00:38, 0건으로 실행) | 운영 로그 | Start 스크립트는 09:00 이후에만 따라잡기(`91137a3`) |
| 경쟁에서 진 자산 작업도 이력이 남을 수 있다 | Do | `INSERT … SELECT … WHERE changes() > 0`, workerd D1 에서 확인 |
| 서류 등록 뒤 스캔본을 따로 올려야 했다 | 운영(사용자) | 등록 창에서 바로 첨부(`c30705e`) |
| 등록 창 칸 높이·체크박스 정렬이 들쭉날쭉 | 운영(사용자) | 2열 그리드, 40px 컨트롤(`ee0cc24`) |
| AI 가 상대방을 비웠다 | 실험 | 프롬프트에 우리 회사 이름을 알렸다 |
| 메신저 개선과의 병합 충돌(시스템 작성자 클래스, 셸 배지, 하니스 게이트, 테스트 목록) | 병합 `c09eb32` | 4곳 해결, 총무 알림 글의 반응·읽음 교차 테스트 추가 |

---

## 6. Lessons Learned & Retrospective

### 6.1 What Went Well (Keep)

- 탭 추가 규칙(FR-16)대로 레지스트리 한 줄과 패널 한 줄만 더했다. 권한·감사 가드 테스트가 새 탭을 자동으로 덮었다.
- 알림을 계산(순수 함수)과 실행(하루 한 번)으로 나눴다. 배지와 현황은 실시간이고, 메신저 글은 멱등이다. 운영 첫 주에 재기동이 09:00 작업과 겹쳤는데도 그날 실행은 한 번만 일어났다.
- 시스템 작성자를 계정이 아닌 예약 id 로 둬서 로그인 경로가 생기지 않았다. 나중에 메신저에 반응·읽음이 들어와도 그대로 동작했다.
- AI 자동 채우기를 기존 이력서 다리에 경로 하나로 붙였다. 도구 끔·한 번에 하나·Host 허용 목록을 다시 만들 필요가 없었다.

### 6.2 What Needs Improvement (Problem)

- 운영 반영 뒤 하루 사이 범위가 네 번 늘었다(첨부, 배치, AI, 간식). GA-D10 은 결정표에 오르지 않았고 Design 도 따라가지 못했다.
- 개발 DB 에 직원이 없어 지급·반출·HR 연결을 실제 런타임에서 보지 못했다.
- 상각 계산은 테스트가 있었지만 기초 누계 사례가 없어 '월 상각액' 표시 오류를 놓쳤다.

### 6.3 What to Try Next (Try)

- 운영 반영 뒤 사용자 요청으로 기능을 더하면 같은 커밋에서 Plan 결정표에 한 줄을 쓴다.
- 개발 DB 에 합성 직원 몇 명을 넣는 시드 스크립트를 두고, 지급·반출·HR 흐름을 개발 서버에서 확인한다.
- 계산 함수 테스트에는 선택 입력(기초 누계·처분)을 켠 사례를 하나씩 넣는다.

---

## 7. Process Improvement Suggestions

| Phase | Current | Improvement Suggestion |
|-------|---------|------------------------|
| Plan | 범위 추가가 커밋 메시지에만 남았다(GA-D10) | 범위 추가 커밋에 Plan 결정표 갱신을 함께 넣는다 |
| Check | 운영 확인을 데이터가 없어서 미뤘다 | 운영 SC 마다 "누가 어떤 데이터로" 확인할지 Plan 에 적는다 |
| Do | 개발 DB 에 직원이 없다 | 합성 인사 시드(실명·연락처 없음)를 둔다 |

---

## 8. Next Steps

### 8.1 Immediate

- [x] 운영 반영: `ga1`(09-30 16:01) → `ga1.1`(16:16) → `ga1.2`(16:25) → `ga1.3`(16:56) → `ga1.4`(10-01 09:21) → `ga1.5`(13:13). 이후 `hr1`·`hr1.1`·`msg1-release-20261001`(17:16)에 포함되어 현재 운영 중.
- [x] 작업 스케줄러 `XDnodeManagement-Alerts`(매일 09:00) 등록. 다음 실행 2026-10-03 09:00.
- [x] 알림 채널 멤버 동기화: 총무 보기 이상 활성 계정 2개(관리자 포함). 관리자가 아닌 담당자에게 따로 권한을 줬는지는 확인하지 않았다.
- [x] Check·Plan 상태 동기화(2026-10-02, 이 문서와 분석 문서).
- [x] '월 상각액' 표시 수정 + 테스트(2026-10-02, 운영 반영은 다음 배포).
- [ ] 실제 데이터 입력 뒤 GA-SC-1~4 사용자 점검.
- [ ] 다음 복원 리허설에서 `ga/` 첨부 열람 확인.

### 8.2 Deployment Record

| Item | Value |
|------|-------|
| 태그 | `ga1-release-20260930`(`84820d9`), `ga1.1`(`1483cc7`, 계정 메뉴 잘림 수정), `ga1.2`(`c30705e`), `ga1.3`(`ee0cc24`), `ga1.4-release-20261001`(`5c99864`), `ga1.5-release-20261001`(`91137a3`) |
| 현재 운영본 | `msg1-release-20261001`(`c09eb32`) = 메신저 개선 + 총무 1.5 + HR·급여 수정 |
| 알림 실행 기록 | 2026-09-30 첫 실행, 10-01 03:00:38(0건, 이후 09:00 제한으로 수정), 10-02 09:00:20(Start 따라잡기, 0건, 멤버 2) |
| 운영 데이터(2026-10-02 03:00 백업 보고서) | `ga_documents` 8, `ga_attachments` 8, `ga_alert_runs` 2, 그 밖의 `ga_*` 0 |
| 롤백 | `Deploy-XDNodeManagement.ps1 -Tag r5.2-release-20260930`(총무 이전). 테이블은 추가만 했으므로 옛 코드는 무시한다. 작업 스케줄러의 Alerts 작업은 옛 코드에 경로가 없어 실패 로그만 남긴다 |

### 8.3 Next PDCA Cycle

| Item | Priority | Expected Start |
|------|----------|----------------|
| 총무 작은 수정 묶음(유효기간 기본값, 파일 이름 KST, 알림 trigger·보관 채널) | High | 자산 등록 전 |
| 바코드·QR 자산 라벨 | Low | 요청 시(Plan 범위 밖 후속 후보) |
| 입사 체크리스트 → 장비 지급 링크 | Low | 요청 시 |

---

## 9. Changelog

### general-affairs (2026-09-30 ~ 2026-10-01)

**Added:**
- 총무 탭: 현황, 자산 4종(지급 장비·비품·계약·고정자산), 회사 서류·기업 간 계약서, 인감·서류 반출 대장
- 만료 알림(경과·당일·D-7·D-30·재고 부족), 탭 배지, 메신저 '총무 알림' 채널 하루 한 번 요약
- 엑셀 7시트 양식·가져오기(미리보기·덮어쓰기·되돌리기)·내보내기
- 퇴직 정산의 미반납 자산 목록과 총무 탭 바로가기
- 등록 창 첨부, Claude AI 자동 채우기(서류·자산), 간식 구입(캡처 AI 읽기, 제품별·월별 집계)

**Changed:**
- 메신저 첨부 규칙을 `app/attachment-rules.ts` 로 옮겨 총무와 함께 쓴다
- 회사 서류에서 원본 보관 위치 입력을 뺐다(GA-D6)
- Start 스크립트의 알림 따라잡기는 09:00 이후에만

**Fixed:**
- 03:00 백업 재기동이 그날 알림 실행을 먼저 쓰던 문제

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-10-02 | Completion report created(Check 95%, Plan 상태 동기화 31/36) | gc.kim + Claude |
