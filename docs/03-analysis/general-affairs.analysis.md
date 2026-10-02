# general-affairs Gap Analysis (Check)

> **Feature**: general-affairs(총무 탭, GA1) · **Date**: 2026-10-02 · **Commit analysed**: `b08d517`(총무 코드는 `91137a3` = `ga1.5-release-20261001` 이후 바뀌지 않았다) · **Act**: 없음(이 문서는 코드를 고치지 않았다)
> **Plan**: [general-affairs.plan.md](../01-plan/features/general-affairs.plan.md)(v0.4, GA-D1~D9) · **Design**: [general-affairs.design.md](../02-design/features/general-affairs.design.md)(v0.1 + §11 구현 결과 + §12 AI 자동 채우기, GD-1~GD-12)

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 자산·서류·인감의 현황, 책임자, 만료일이 흩어져 있어 분실·만료를 놓친다. 퇴직 때 회수할 자산을 알 수 없다. |
| **WHO** | 경영지원실 총무 담당(편집), 실장·대표(보기), 관리자. 일반 직원은 쓰지 않는다. |
| **RISK** | 인감·인증서 스캔본 유출, 시끄러운 알림, 엑셀 가져오기 오염, Worker 에 cron 이 없음(알림 트리거) |
| **SUCCESS** | 엑셀로 장부를 채운다. D-30 항목이 배지와 메신저에 같은 날 나온다. 반출 중인 인감이 현황에 보인다. 퇴직 정산에 미반납 자산이 뜬다. 권한 없는 계정은 탭·API 모두 막힌다. |
| **SCOPE** | 한 릴리스(GA1). 새 탭 1, 라우트 8(+ 뒤에 2), 테이블 9(+ 뒤에 3). 기존 HR·메신저 스키마는 추가만 |

## 1. Match Rate

| 축 | 결과 | 비고 |
|---|---|---|
| 정적 분석 종합 | **95%** | 메신저와 같은 공식(Structural×0.2 + Functional×0.4 + Contract×0.4). 아래 세부 |
| ├ Structural(파일·테이블·라우트) | 100% | Design 의 테이블 9개·라우트 8개·파일 목록(§11)이 모두 있다. 뒤에 더한 것: `extract`·`snacks` 라우트, `ga_snack_*` 3개 |
| ├ Functional(Plan 범위 체크박스 32개) | 95% | 30개 충족, 1개 부분(서류 유효기간 기본 3개월), 1개 미구현(입사 체크리스트 링크, 선택) |
| └ Contract(Design §4~§8 세부 31개) | 94% | 29개 일치. 다른 점 2개: 가져오기 상한 500행(설계 1,000행), 금액 표기는 `formatWon` 대신 같은 모양의 `won()` |
| GA-FR-01~11 | 11/11 구현 | 검증 열의 테스트가 모두 있다 |
| Design §9 테스트 시나리오 | 16/16 | `tests/ga-api.test.mjs` 16개(#1~#16 + 스크립트·UI·GA-D6·D7·D10) |
| 하니스 테스트(2026-10-02 재실행) | 232/232 | ga-api, access-policy, auth-session, tab-permissions, shell-tabs, erp-platform, chat-api, chat-enhancement. 빌드가 필요한 테스트와 전체 `npm test` 는 다른 작업과 겹쳐 돌리지 않았다(병합 `c09eb32` 때 528/528) |
| Lint | 0 | 총무 파일만 돌렸다. 저장소 전체 `npm run lint` 는 다른 세션의 `tmp/radar-test-*` 폴더 권한 오류(EPERM)로 시작하지 못했다 |
| 실제 개발 서버 점검 | 18항목(2026-09-30) | 개발 DB 에 직원이 없어 지급·반출·HR 연결은 하니스로 대신했다(Design §11) |
| 운영 확인(읽기 전용) | 알림 작업 동작 | 아래 §3·§4 |

Plan 체크박스 전체(범위 32 + 완료 기준 4)로 보면 31/36(86%)이다. 남은 5개 중 3개는 운영·사용자 확인이라 코드로는 닫을 수 없다.

## 2. Gaps and Findings

코드는 고치지 않았다. 심각도는 운영 영향 기준이다.

| 심각도 | 항목 | 근거 | 권고 |
|---|---|---|---|
| Important | 기초 상각누계가 있는 자산은 상세 화면의 '월 상각액'이 기초 누계 금액으로 나온다. 예: 1,200,000원·36개월, 기초 누계 400,000원(2024-12) → "월 400,000원"(실제 월 33,333원) | `depreciationAsOf` 의 `monthly = schedule[0].depreciation`. 기초 누계가 있으면 첫 줄이 기초 월이고 금액이 기초 누계다(`app/ga-alerts.ts:230`). 2026-10-02 계산으로 확인. 누계·장부가액·상각표는 맞다 | 첫 줄이 기초 월이면 다음 줄 금액을 쓴다. ga-api #5 에 기초 누계 사례를 더한다. 지금 운영에 자산이 0건이라 영향받은 데이터는 없다. **2026-10-02 수정**: 첫 줄이 기초 월이면 다음 줄 금액을 쓰고, ga-api #5 에 기초 누계 사례를 더했다 |
| Minor | Plan C "발급일 기준 N개월 유효, 기본값 3개월" 중 기본값이 없다 | 서류 폼 `validityMonths` 는 빈 칸(0)으로 시작한다. 등기부등본·인감증명서를 골라도 3이 들어가지 않는다 | 종류가 CORP_REGISTRY·SEAL_CERT 이고 만료일이 비었을 때 3을 미리 채운다 |
| Minor | 장부 내보내기 파일 이름의 날짜가 UTC 다. 00:00~09:00(KST)에 받으면 전날 날짜가 붙는다 | `general-workspace.tsx:791` `new Date().toISOString()` | `general-snacks-view.tsx` 의 `kstToday()` 처럼 +9시간 |
| Minor | 알림 실행 기록의 trigger 가 항상 `task` 다. Start 스크립트가 `-Trigger startup` 을 보내도 라우트가 본문을 읽지 않는다 | `app/api/general/alerts/route.ts` | 09:00 작업과 재기동 따라잡기를 구분하려면 본문 `trigger` 를 허용 목록(`task`·`startup`)으로 받는다 |
| Minor | 누군가 '총무 알림' 채널을 보관(archive)하면 글은 안 올라가는데 `ga_alert_marks` 는 계속 갱신된다. 그동안 들어온 항목은 나중에 보관을 풀어도 다시 알리지 않는다 | `runGaAlerts`: `post = fresh.length > 0 && archived === null`, marks upsert 는 무조건 | 보관 중이면 marks 를 쓰지 않거나, 보관을 막는다 |
| Minor | `GET /api/general/people` 은 퇴직자도 돌려준다(Design: 재직·휴직만). 화면은 퇴직자를 빼고 쓰는데, 그 목록으로 이름을 찾는 장부 내보내기는 퇴직자의 사용자·담당자 칸에 사번을 그대로 쓴다 | `gaPeople`, `exportLedger` | 내보내기의 이름표는 전체 명부로 만든다. 라우트는 이력 표시에 퇴직자 이름이 필요하므로 지금처럼 두고 Design 을 고친다 |
| Minor | 가져오기 한 번 상한이 500행이다(Design §6 은 1,000행) | `GA_IMPORT_MAX_ROWS = 500` | 규모(수백~수천 행)에는 충분하다. Design 을 500으로 맞춘다 |
| 관찰 | 2026-10-02 09:00:04 `XDnodeManagement-Alerts` 가 실패했다(서버 연결 불가, 작업 결과 1). 08:59:58 에 PC 가 재기동되어 서버가 뜨는 중이었다. 09:00:20 Start 스크립트의 따라잡기 실행이 성공했다 | `C:\xdm\logs\xdm-20261002.log` `ga-alerts:` 줄, `Get-ScheduledTask` | GD-7 의 이중 트리거가 의도대로 동작한 사례다. 작업 스케줄러에는 실패(1)로 남으므로 점검 때 오해하지 않게 runbook 에 적어 둔다 |

## 3. Success Criteria

| SC | 상태 | 근거 |
|---|---|---|
| GA-SC-1 기존 엑셀 일부를 가져와 장부가 채워진다 | ⏳ 미확인 | 기능은 ga-api #13. 운영 `ga_import_batches` 0건(2026-10-02 백업 보고서) |
| GA-SC-2 D-30 항목이 배지와 메신저 '총무' 채널에 같은 날 나온다 | ⚠️ 부분 | 매일 1회 실행 확인(10-01·10-02, `members=2`). 운영에 D-30 안의 항목이 없어 글은 아직 0건(`ga_alert_marks` 0) |
| GA-SC-3 반출 중인 인감이 현황 첫 화면에 보인다 | ⏳ 미확인 | 기능은 ga-api #6. 운영 보관품·반출 0건 |
| GA-SC-4 퇴직 정산 화면에 미반납 장비가 뜬다 | ⏳ 미확인 | 기능은 ga-api #14. 운영 자산 0건 |
| GA-SC-5 총무 권한 없는 계정은 탭이 없고 API 가 403 | ✅(테스트) / ⏳(사용자) | ga-api #1, tab-permissions. 운영 비로그인 요청은 401(overview·snacks·alerts POST) |
| 복원 리허설에 R2 `ga/` 포함 | ⏳ | 2026-10-01 리허설 때 총무 0건. 지금은 서류 8건·첨부 8개가 있어 다음 리허설에서 확인할 수 있다 |

## 4. Scope Changes After Design (GA-D6 ~ GA-D10)

| ID | 내용 | 기록 위치 | 구현 |
|---|---|---|---|
| (GA1.2) | 서류·자산 등록 창에서 바로 첨부, 실패한 파일만 알림 | 커밋 `c30705e` | ✅ |
| (GA1.3) | 등록 창 배치 통일(2열, 40px) | 커밋 `ee0cc24` | ✅ |
| GA-D6 | 회사 서류의 원본 보관 위치를 화면·엑셀에서 뺀다. 열은 남기고 수정 때 기존 값 유지 | Plan 결정표, Design §12 | ✅ ga-api GA-D6 |
| GA-D7~D9 | Claude AI 자동 채우기(PDF 글 20쪽 + 앞 3쪽 그림, 이미지). 다리 `3120 /extract`(도구 끔, 디스크 쓰기 없음). 정해진 칸만 채우고 연두색 'AI' 표시 | Plan 결정표, Design §12 | ✅ ga-api GA-D7 |
| GA-D10 | 간식 구입 화면: 주문 캡처를 붙여 넣으면 AI 가 날짜·구입처·제품 줄을 읽는다. 제품별·월별 집계, 영수증은 R2 `ga/SNACK/`. 테이블 `ga_snack_purchases`·`ga_snack_items`·`ga_snack_receipts` | **커밋 `91137a3` 과 코드 주석에만 있다.** Plan 결정표·Design 에는 없다 | ✅ ga-api GA-D10 |
| (운영) | Start 스크립트의 알림 따라잡기를 09:00 이후로 제한. 03:00 백업 재기동이 그날 실행을 먼저 써 버리던 문제(2026-10-01 03:00:38 실행) | 커밋 `91137a3` | ✅ |

GA-D10 은 Plan 의 범위 밖에서 사용자 요청으로 더한 기능이다. 결정표에 올리는 일은 Plan 작성자가 한다(이번 상태 동기화는 결정·범위 문구를 바꾸지 않았다).

## 5. Known Follow-ups

- §2 의 Important 1건(월 상각액 표시)은 2026-10-02 고쳤다(운영 반영은 다음 배포).
- 운영 사용자 점검 GA-SC-1·3·4 는 실제 데이터(자산 엑셀, 법인인감 보관품, 지급 장비)가 들어간 뒤에 한다.
- 다음 복원 리허설에서 `ga/DOCUMENT/…` 첨부 열람을 확인한다.
- Design 문서에 GA-D10, 가져오기 500행, people 라우트의 퇴직자 포함을 반영한다(이번 작업 범위 밖).
