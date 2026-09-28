# HR·임금계산 전수 점검 보고서 (2026-09-21)

점검 방법: (1) 브라우저에서 HR 15개 메뉴·환경설정 6개 섹션·임금계산 화면을 전부 열어 렌더링·콘솔·네트워크·팝업을 확인, (2) HR 라우트 20개와 화면 5,000줄, 임금계산 화면·엔진·라우트를 코드로 정독(에이전트 2개 병렬), (3) 「높음」 항목은 전부 코드 위치를 다시 열어 재검증. 빌드·테스트(248건)는 통과 상태에서 점검했다.

점검 중 발견한 당일 회귀 1건(대시보드 연차 요약을 화면 전환마다 재조회)은 즉시 고쳤다(`hr-workspace.tsx` 대시보드에서만 조회).

## 1. 즉시 조치 (높음)

### 급여·임금계산

| # | 위치 | 결함 | 조치 |
|---|---|---|---|
| H1 | `app/api/hr/compensation/route.ts:320` | 임금안 확정 배치의 `DELETE FROM hr_payroll_records … ` 와 재삽입에 버전 가드가 없다. 동시 편집으로 409가 나도 급여기록은 이미 옛 초안으로 교체된다(같은 파일 CREATE 경로는 EXISTS 가드가 있음). | 모든 문에 `EXISTS(… status='DRAFT' AND version=?)` 가드 또는 2단계 처리 |
| H2 | `app/api/hr/compensation/route.ts:120-129` + `app/hr-retirements.ts:69` | 임금 대상 추출이 `retirement_json.$.date` 에만 의존하는데 퇴직 처리는 `$.status` 만 쓴다. 퇴직일이 요청 표에만 있는 사람은 퇴사월 임금안에서 빠지고, 퇴직 예정자는 만근으로 계산된다. | `hr_retirement_requests` 를 조인해 퇴직일 사용 |
| H3 | `app/api/hr/operations/route.ts:489` | 퇴직 정산 → 임금안 반영이 `version`·합계·`status='DRAFT'` 를 확인하지 않는다. 열려 있는 임금계산 화면의 자동 저장이 정산값을 조용히 덮어쓴다. | version 증가·합계 재계산·DRAFT 조건, 0행이면 409 |
| H4 | `app/api/hr/compensation/route.ts:63-70` vs `:338-343` | 확정 INSERT 가 이 라우트의 CREATE TABLE 에 없는 `personal_expense`, `deduction_detail_json` 을 쓴다(ALTER 는 payroll 라우트에만). 급여관리를 한 번도 열지 않은 DB 에서 확정 실패. | 스키마 정의를 공용 모듈로 통합 |
| H5 | `app/compensation-calculator.tsx:444-477` + `app/api/hr/payroll/route.ts:460` | 급여월 잠금 해제를 임금계산 화면이 `window.prompt` 로 우회하고 에러 문자열 비교로 분기한다. REVIEW→DRAFT 는 사유·approve 권한 없이 열린다. | 잠금 해제는 급여관리에서만, 서버 에러 코드화, REVIEW 되돌리기도 사유 필수 |
| H6 | `app/api/hr/compensation/route.ts:26-29`, `app/won-input.tsx:19` | 음수 금액이 구조적으로 막혀 공제가 지급을 넘는 달(선사용 연차 공제 등)은 자동 저장이 400 으로 실패하고 입력이 사라진다. | `total` 과 연차수당만 음수 허용 |
| H7 | `app/compensation-calculation.ts:121` vs `app/hr-employment-contract.ts:183` | 기본급 산식이 계약서(항상 올림)와 급여(설정값, 기본 반올림)로 갈려 1원 차이가 난다. | `ceil(연봉×지급률/12)` 로 고정 |
| H8 | `app/api/hr/compensation/route.ts:146-148` | 첫 계약 지급률 100% 직원은 `manualBasic:true` 로 내려와 저장된 `base_pay` 를 그대로 쓴다. 연봉 인상 후 base_pay 미갱신이면 규칙이 깨진 채 확정된다. | `annual_salary>0` 이면 항상 연봉 산식 |
| H9 | `app/compensation-calculation.ts:112,134` | 수기 식대가 기본급 차감에 반영되지 않아 월 총지급이 연봉/12 를 초과한다(테스트가 이 동작을 고정함). | 의도라면 화면 경고, 아니면 수기 식대 반영 |

### 입·퇴사·채용·조직

| # | 위치 | 결함 | 조치 |
|---|---|---|---|
| H10 | `app/api/hr/operations/route.ts:623-642` | 퇴직 체크리스트 저장이 만드는 상태에 `COMPLETED` 가 없어 완료 분기는 도달 불가이고 `completed_at` 이 매번 NULL 로 덮인다. | 죽은 분기 제거, `COALESCE(completed_at, …)` |
| H11 | `app/api/hr/operations/route.ts:320-325` | 퇴직 요청이 생성 즉시 `IN_PROGRESS`·`approved_by=요청자` 로 자기결재된다(인사발령·휴가는 결재선 사용). | `RETIREMENT` 결재선 사용 |
| H12 | `app/api/hr/recruitment/route.ts:517` | 지원자 저장이 화면의 `stage` 를 최신 오퍼 상태로 덮어쓴다. 「타사 합격」이 메모 저장만 해도 「채용 제안 거절」로 되돌아간다. | ACCEPTED/ONBOARDED 만 강제, 응답에 확정 stage 실어 화면 동기화 |
| H13 | `app/hr-workspace.tsx:1251-1259`, `app/api/hr/organizations/route.ts` | 조직 추가가 화면 상태만 바꾸고 서버 POST 가 없다. 새로고침하면 사라진다. | 조직 생성 API 추가 또는 버튼 비활성 |
| H14 | `app/hr-workspace.tsx:1809, 4641-4675` | 환경설정 회사·기준정보·알림·데이터·백업 섹션은 저장 로직이 없는데 「변경사항 저장」이 성공 토스트를 띄운다. 「마지막 자동 백업 오늘 03:00」은 고정 문구다. | 표시 전용 표기 또는 실제 저장 API |
| H15 | `app/api/hr/operations/route.ts:376-380` | 일정·근태 화면의 휴가 신청 INSERT 에 `deducts` 가 없어 병가·가족돌봄도 승인되면 연차에서 차감된다. | 종류별 `deducts` 바인딩, 또는 휴가 등록 경로를 연차관리로 통일 |

## 2. 중간

- `app/hr-workspace.tsx:2996-2998` 지원자 관리 지표 「서류 합격 안내」「면접 일정 회신」이 존재하지 않는 단계명을 세어 항상 0명 (브라우저에서 확인).
- `app/hr-workspace.tsx:1854` 「이번 달 입사」가 `"2026.08"` 하드코딩.
- `app/hr-workspace.tsx:3001` 지원 현황의 「공고 전체」「단계 필터」 버튼에 onClick 없음.
- `app/hr-workspace.tsx:1624` 지원자 등록 후 초안 초기화에 `birth`·`address` 누락.
- `app/api/hr/recruitment/route.ts:589-591` 처우 제안이 생성 즉시 APPROVED 라 SUBMITTED 분기·라벨이 죽어 있음.
- `app/api/hr/recruitment/route.ts:622-635` 입사 완료(ONBOARDED)된 지원자도 삭제 가능, 삭제 시 이력서 문서·R2 객체 잔존.
- `app/api/hr/operations/route.ts:104-113` 이 라우트의 `hr_employee_records` CREATE 에 급여 컬럼이 없어 신규 DB 에서 정산이 500. 같은 표 정의가 4곳에 중복.
- `app/api/hr/operations/route.ts:111-113` 통상임금에 자가운전보조금 포함, 첫 계약 지급률 미반영.
- `app/api/hr/operations/route.ts:432` 정산 확정·임금안 반영이 `write` 권한(휴가·근태 승인은 `approve`).
- `app/api/hr/operations/route.ts:344-347` `JSON.parse(history_json)` try/catch 없음.
- `app/hr-workspace.tsx:4303` 정산 패널이 열릴 때마다 진행 중 퇴직 전원의 추정을 계산(`?severance=1`).
- `app/api/hr/leave/route.ts:140-146` 기록 등록 시 직원 존재 확인 없음.
- `app/api/hr/payroll/route.ts:324` 공제 총액 빈 문자열이 0 으로 저장. `:377-387` 인증 전 스키마 변경, `:498-505` 최종 UPDATE 에 상태 조건 없음.
- `app/api/hr/employee-records/route.ts:161-209` PUT 이 전체 치환이라 누락 필드가 0/""로 초기화, 낙관적 잠금 없음.
- `app/api/hr/organizations/route.ts` PUT 조직명 변경이 급여기록·임금안 스냅샷의 부서명을 갱신하지 않음. `app/api/hr/analytics/route.ts:98` 조직 분포가 정적 이름이라 개명한 조직이 통계에서 사라짐.
- `app/hr-workspace.tsx:4661-4664` 권한 목록에서 인사기록카드에 없는 계정 행이 숨겨져 비활성화 불가.
- 라우트 5곳(operations·recruitment·payroll·compensation·leave)이 `authorizeErpRequest` 전에 `ensureSchema()` 실행.
- `app/hr-employee-roster.ts:30-34` `IN ()` 빈 배열 가드 없음.
- 임금계산: 월 변경 시 편집 중 명부가 빈 배열로 덮임(`compensation-calculator.tsx:161-163`); 일할 계산이 단수 설정을 무시하고 항상 내림(`compensation-calculation.ts:117,124`); 365 고정(윤년); 열 체크 해제 시 금액이 조용히 합계에서 빠짐(`:127-132`); 스냅샷 드리프트 감지 수단 없음; KPI 카드 합계가 지급총액과 불일치(`:215`); 연간 엑셀이 현재 월 명부로 12개월 생성(`:565-575`); CREATE/LOAD_HR 시 `gross_pay` 0 저장(route `:226-229`); 이름 빈 행이 있으면 자동 저장 중단 안내 없음(`:313-317`); 경고 문구가 「수습 90%」 고정(`:605`); 금액 입력 ARIA 무효(`won-input.tsx:44-56`).
- 브라우저 기본 대화상자(`window.prompt/confirm/alert`)가 hr-workspace 10곳, compensation 2곳, requisition 2곳, leave-view 2곳에 남아 있다. 이번 점검의 브라우저 환경에서 `prompt()` 가 지원되지 않아 채용요청 「조기 마감」이 사유 입력 단계에서 예외로 멈췄다(서버는 409 로 안전하게 거부).

## 3. 낮음

- `hr-leave-view.tsx:176` 「올해 소멸」 라벨이 실제로는 누적 소멸. `:203-208` 잔여 현황 표에 빈 상태 행 없음.
- `hr-workspace.tsx:2392, 2369` 휴가 신청 「처리」 칸과 `decide("leaveRequest")` 가 죽은 경로. 일정·근태 화면의 휴가 목록이 연차관리와 중복(이관 기록 405건이 그대로 보임).
- `hr-workspace.tsx:2955` 지원자 검색이 이력서 원문까지 매칭.
- `hr-workspace.tsx:1629-1764` 지원자 상태 변경이 낙관적 갱신 후 실패 롤백 없음(`updateEmployee` 는 롤백 있음).
- `hr-employment-contract.ts:186-189` 전환 계약에서 기본급 0 일 때 지급률 문구 오류. 생성한 계약서가 인사문서함에 등록되지 않음.
- `hr-workspace.tsx:4328` 연차수당 칸을 비우면 0 저장. `interviews/route.ts:95-110` 면담 기록 삭제 API 없음.
- `recruitment-requisitions/route.ts:291-309` CLOSE/CANCEL 이 `meta.changes` 미확인. `payroll/route.ts:253-257` 급여월 없는 기록은 조작 불가.
- 임금계산: 엑셀 임포트가 지급률을 90%로 뭉갬(`:98`); 「전월 값 이어받기」가 대부분 무효과(`:424-435`); 연도 입력 중간값이 API 로 나감(`:584`); CSS 죽은 블록(`compensation-calculator.css:30`); 테스트 공백 9건(음수 total, 윤년, 지급률 종료 경계, manualBasic+지급률, HR 인원 추가 중복, 식대 토글, version 409, 잠금 우회, 전환일 처리).
- 린트: HR·임금계산 소스에 a11y 오류 27건(비대화형 요소 이벤트 13, label 연결 6, 자동 포커스 3, 미디어 자막 4, 정적 요소 1), React 렌더 중 setState 12건, 미사용 변수 4건.

## 4. 점검했고 이상 없던 부분

- 인가·감사: HR/채용/급여/임금계산 모든 변경 핸들러가 `authorizeErpRequest` + `writeErpAudit` 를 거친다. 급여 마감·재개방은 `approve`.
- SQL 인젝션 없음(모두 바인딩, 동적 부분은 플레이스홀더 개수와 내부 상수뿐).
- 임금안 저장·확정·재개방의 낙관적 잠금(version) 2중 검사, 확정 → 급여기록 교체의 월 격리, 급여월 목록 생성 통제, 상태 전이표의 서버·화면 일치.
- 퇴직금 엔진(근속 양끝 포함, 반올림 1회, 평균/통상 큰 쪽, 35시간 시행일 분기)과 테스트 일치. 평균임금 산정에서 퇴직금·퇴직 연차수당 제외 처리 정확.
- 입사 전환(수락·완료·취소) 배치 원자성, 채용요청 정원 재검사.
- 연차 엔진(가산·소멸·FIFO·초과·촉진 그룹핑)과 날짜 정규화, 이관 결과 29명 사용일수 일치.
- 문서 업로드 검증·상태 표시, 면접 녹음 동의·실패 롤백.
- 브라우저: 15개 메뉴 전부 렌더링, 콘솔 오류는 위 prompt 건 외 없음, API 응답 전부 200(내가 유발한 409 제외), 인사기록카드·급여 월 상세·급여 기록 팝업·지원자 상세·연차 원장·퇴직 정산 팝업 정상 개폐.

## 5. 권장 수정 순서

1. 돈이 틀어지는 것부터: H1·H3(확정/정산 덮어쓰기), H2(퇴사월 누락), H6(음수 저장 실패), H7·H8·H9(기본급 산식), 통상임금 구성.
2. 통제 우회·자기결재: H5, H11, 정산 권한(`approve`), REVIEW 되돌리기 사유.
3. 데이터 정합: H12(지원자 단계 덮어쓰기), H15(병가 차감), 조직명 변경 파생 갱신, 스키마 정의 통합(H4·중간 항목).
4. 거짓 성공·죽은 화면: H13·H14, 지원자 지표·버튼, 하드코딩 월, 브라우저 대화상자 제거.
5. 테스트 보강(임금계산 9건)과 린트 정리.

## 6. 조치 현황 (2026-09-21, 권장 순서대로 진행)

| 단계 | 처리 | 남은 것 |
|---|---|---|
| 1 금액 | H1 확정 배치 버전 가드(라인 저장·삭제·급여기록 교체 모두 `EXISTS` 가드) · H2 퇴직일을 인사기록 JSON + 퇴직 요청 표에서 합쳐 판단 · H3 정산 반영 시 DRAFT 조건과 버전 증가 · H4 확정 열 보강 · H6 실지급만 음수 허용 · H7 만근 기본급 올림(계약서와 일치, 9월 임금안 합계 +9원) · H8 연봉 있으면 항상 연봉 산식 | H9(수기 식대의 기본급 반영)는 앞선 결정("기본급은 건드리지 않음")대로 유지. 통상임금 구성(자가운전 포함·지급률 미반영)은 회사 규칙 결정 필요 |
| 2 통제 | 임금계산 화면의 급여월 잠금 우회(prompt) 제거 · REVIEW→DRAFT 사유 필수 · 급여월 최종 전이에 현재 상태 조건 · 퇴직 요청이 결재선(HR_RETIREMENT)을 타며 요청자=승인자면 자동 승인 · 정산 확정·임금안 반영은 approve 권한 | — |
| 3 정합 | 지원자 단계는 수락·입사 완료일 때만 오퍼가 지배 · 일정·근태 휴가 신청에 차감 여부 기록 · 이력 JSON 안전 파싱 · 인사기록 PUT 이 보내지 않은 급여값 유지 · 공제 총액 공란 400 · 조직명 변경이 급여기록·임금안 스냅샷까지 전파 · 통계 조직명 라이브 · 운영 라우트에 급여 컬럼 보강 · 연차 기록 시 직원 존재 확인 | 스키마 정의를 한 모듈로 통합하는 작업은 미착수(보강 코드로 위험만 제거) |
| 4 화면 | 조직 추가 API(POST) 와 서버 저장 · 환경설정 표시 전용 표기와 고정 문구 제거 · 지원자 지표를 실제 단계로 · 「이번 달 입사」 실제 월 · 동작 없는 필터 버튼 제거 · 브라우저 기본 대화상자 16곳을 앱 내부 대화상자(`app/erp-dialog.tsx`)로 교체 (§9) | 재무·영업 화면과 HR 「준비 중」 3개 화면의 `window.prompt` 는 범위 밖 |
| 5 테스트·린트 | 엔진 테스트 5건(올림 기본급, 지급률 종료 경계, 윤년, 수기 기본급+지급률, 전환일 우선) · 라우트 회귀 단정(대화상자 교체, 공용 직원 스키마) 추가. 전체 268건 통과 · 미사용 변수·죽은 코드 4건 제거 | a11y·react-hooks 린트 35건(§9 표) |

## 7. 중단 작업 인계 후 확인 (2026-09-21)

- 직원 스키마는 인계 당시 2개 라우트에만 연결되어 있었다. 나머지 6개 HR 라우트와 직원 가져오기 경로를 공통 헬퍼로 연결하고 중복 CREATE/ALTER 정의를 제거했다. 가져오기에서 반영할 행이 없을 때 빈 DB 배치를 실행하지 않도록 했다.
- 동시에 여러 라우트가 열려 같은 열을 추가할 경우, 열의 존재를 재확인한다. 실제로 추가되지 않은 열의 오류는 그대로 전달한다.
- 메모리 SQLite 테스트 4건으로 신규 생성·반복 실행, 기존 직원값 보존, 동시 열 추가, 실제 오류 전달을 검증했다. 기존 소스 회귀 검사는 공통 스키마 위치에 맞췄다.
- 검증: `npm test` 빌드 성공 및 전체 **255건 통과**, 이번 변경 대상 스키마·API 및 공통 대화상자 린트 통과, `git diff --check` 통과. 이번 인계 후에는 브라우저 시각 검증을 다시 수행하지 않았다.
- 전체 린트는 `tmp/radar-test-qc8aej8r` 접근 권한 오류로 중단된다. 소스 경로만 검사하면 79개 오류·9개 경고가 남는다. `tsc --noEmit`도 Cloudflare 타입 선언 누락을 비롯한 오류로 통과하지 못했다. 전체 정적 검사를 완료로 취급하지 않는다.
- 통상임금은 인계받은 운영 API 코드에 자가운전수당 포함 및 첫 계약 기간 지급률 적용이 이미 작성되어 있다. 기존 보고서의 ‘회사 규칙 결정 필요’와 충돌하므로 사용자에게 합의 내용을 질문했으며, 이 계산은 이번 인계 작업에서 변경하지 않았다.

## 8. 통상임금 구성 확인 (2026-09-21)

- 사용자 확정: 통상임금에 기본급과 자가운전수당·육아수당·식대를 포함한다. 연봉에 이미 포함된 수당은 연봉/12에 다시 더하지 않는다. 현재 운영 API의 포함 방식과 일치한다.
- 사용자 확정: **경력직은 100%, 신입은 첫 3개월 동안 90%**를 지급한다. 첫 계약 종료 다음 날부터 100%로 계산한다. 전환 계약이 먼저 효력을 갖는 경우 기존 계약·급여 로직과 동일하게 전환일부터 100%를 적용한다.
- 통상임금도 해당 기간의 지급률을 적용한다. `app/hr-ordinary-wage.ts`로 산식을 분리하고 운영 API의 정산 미리보기·저장이 동일한 함수를 사용하도록 연결했다. 날짜 구분자를 정규화해 전환일 경계가 올바르게 적용되도록 했다.
- 직원별 지급률은 인사기록카드의 저장값을 사용한다. 경력 자유기술 문구로 기존 직원을 자동 분류하거나 저장값을 일괄 수정하지 않는다.
- 테스트 6건을 추가해 경력직·신입의 계약서/급여/통상임금 일치, 계약 종료일·전환일 경계, 수당 중복 제외, 중간 반올림 방지를 확인했다.
- 검증 결과: `npm test` 빌드 및 전체 **261건 통과**. 이번 변경 파일의 린트 및 `git diff --check` 통과. 본 절의 확정 기준은 6절의 통상임금 결정 대기 상태를 대체한다.

## 9. 이어서 진행한 조치 (2026-09-21, 대화상자·스키마·테스트·린트)

- **통상임금 지급률**: 사용자 확정(§8)대로 첫 계약 기간의 퇴직은 통상임금에도 지급률을 적용한다. 빌드·전체 테스트 통과로 확인했다.
- **브라우저 대화상자 교체**: `app/erp-dialog.tsx` 를 새로 두고 `alert / confirm / prompt` 를 Promise 기반 API 로 제공한다. HR 은 섀도 루트 포털 안에서, 임금계산은 모듈 루트에서 `<ErpDialogProvider>` 로 감싼다. 교체한 16곳: `hr-workspace.tsx` 10곳(지원자·문서 삭제, 급여 재개 사유, 잠금 해제, 면접 합격·탈락, 필수 입력 안내, 임금안 반영 안내 2곳, 정산 덮어쓰기), `compensation-calculator.tsx` 1곳, `recruitment-requisition-view.tsx` 2곳(삭제 확인, 사유 5자 이상), `hr-leave-view.tsx` 2곳(휴가 기록 삭제, 월차 제외 사유). 스타일은 `public/hr-workspace.css`(28px) 와 `app/globals.css`(26px) 의 `.erp-dialog-*` 규칙으로 팝업 공식을 따른다. 브라우저에서 확인: 임금계산 confirm, HR 문서 삭제(danger) confirm, 월차 제외 prompt(기본값 「결근」, 입력칸 초점) 모두 표시되고 Esc 로 취소되며 데이터 변경 없음.
- **직원 스키마 단일화**: `app/hr-employee-schema.ts` 의 `ensureHrEmployeeRecordsSchema(db)` 를 HR 라우트 8곳이 `ensureSchema()` 첫머리에서 부른다. 라우트 안의 `CREATE TABLE hr_employee_records` 와 `PRAGMA/ALTER` 보강은 모두 제거했다. 회귀 단정으로 재발을 막는다.
- **테스트 공백**: 윤년(2028-02, 29일 만근·365일 일할), 수기 기본급은 지급률 무시, 전환일이 첫 계약 종료보다 앞설 때의 구간 분할을 엔진 테스트로 추가. 음수 실지급·버전 409·HR 인원 추가 중복 방지는 기존 단정(§6 1단계, `wage calculator can append new hires…`)이 이미 덮는다.
- **린트 정리**: 미사용 상태 `resumeProvider`, 죽은 컴포넌트 `ApplicantInterviewRecorder`(c3738bc 이후 어디에도 붙지 않음)와 그 타입, 죽은 `toggle` 헬퍼 제거. 관련 테스트의 단정은 API 동의 가드로 대체했다. 편집용 select 의 `autoFocus` 2곳은 의도된 것으로 표시했다.
- **남은 린트 35건** (`app/hr-workspace.tsx`, `app/compensation-calculator.tsx`): 클릭 가능한 행·카드에 역할 없음 14건, 짝 없는 `<label>` 6건, `useEffect` 안 동기 setState 6건, 렌더 중 `Date.now()` 등 4건, 렌더 중 컴포넌트 생성 2건, 오디오 자막 트랙 2건, `autoFocus` 1건. 동작 결함이 아니라 접근성·React 규칙 경고라 기능 변경 없이 한 번에 손보기보다 화면을 고칠 때 함께 정리한다.
- **검증**: `npm run build` 성공, `node --test` 전체 **268건 통과**, 새 파일 린트 통과.
