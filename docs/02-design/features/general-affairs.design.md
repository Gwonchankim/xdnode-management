# general-affairs Design Document

> **Summary**: 총무 탭(`general`)의 테이블 9개, 라우트 8개, 알림 실행 방식, 메신저 연결, 엑셀 양식, 화면 구성, 테스트를 정한다.
>
> **Plan**: [general-affairs.plan.md](../../01-plan/features/general-affairs.plan.md) v0.2 (GA-D1~D5)
> **Version**: 0.1.0 · **Date**: 2026-09-30 · **Status**: Draft
> **규약**: [xdnode-management.design.md](xdnode-management.design.md) §4.3.1 레지스트리, §6 오류 형식, §7.8 첨부 보안, §8.5 하니스, §10.4 라우트 규칙, §10.7 탭 추가

---

## Decision Record (Design)

| ID | 결정 | 이유 |
|----|------|------|
| GD-1 | 모듈·탭 키는 `general`, 라벨은 '총무', 경로는 `/api/general/*`, DB 접두사는 `ga_`다 | 레지스트리 규칙. 모듈 이름은 짧은 영문 한 단어 |
| GD-2 | 자산 4종은 테이블 하나(`ga_assets`)에 `kind`와 유형별 선택 컬럼을 둔다 | 목록·검색·가져오기·현황을 한 경로로 처리. 행 수가 적다 |
| GD-3 | 회사 서류와 기업 간 계약서는 `ga_documents` 하나에 둔다. 계약 필드는 `kind='B2B_CONTRACT'`일 때만 쓴다 | 원본 위치·스캔본·만료라는 같은 목적 |
| GD-4 | 반출 대상은 두 가지다. ① 보관품(`ga_custody_items`: 법인인감·사용인감·기타 물품) ② 회사 서류(`ga_documents`). 동시 반출은 부분 UNIQUE 인덱스로 막는다 | 경쟁 조건 없이 409 |
| GD-5 | 감가상각표는 저장하지 않고 요청 때 계산한다(보관 태그 계산기 이식) | 전표 연결이 없으니 확정(posting) 개념이 없다 |
| GD-6 | 알림 계산은 순수 함수(`app/ga-alerts.ts`)다. 탭 배지·현황은 실시간으로 계산한다. 메신저 글만 하루 한 번 '실행'한다 | 계산과 부수효과 분리 |
| GD-7 | 알림 실행 경로는 `POST /api/general/alerts`다. 호출자는 둘이다. ① 서버 PC 루프백의 시스템 호출(세션 없음, `x-xdm-peer` 루프백 + 요청 헤더 `X-XDM-Task: ga-alerts`) ② 총무 편집 권한자의 수동 실행. 작업 스케줄러가 부르는 곳은 두 군데다: Start 스크립트 `ready` 직후(재부팅·배포·백업 재기동 모두 포함), 그리고 매일 09:00 작업 `XDnodeManagement-Alerts` | Worker에 cron이 없다. 03:00 백업 재기동만으로는 백업이 실패한 날 빠진다. 09:00은 출근 뒤 확인 시각. 실행은 KST 날짜별로 멱등이다 |
| GD-8 | 시스템 글 작성자는 `auth_accounts`에 행이 없는 예약 id `system:ga`, 표시 이름은 'XDnode 알림'이다. 로그인·세션·사람 목록·멘션 후보에 나타나지 않는다 | 로그인 경로가 생기지 않는다(R-GA4) |
| GD-9 | 알림 채널은 고정 id `ch_ga_alerts`, 비공개, 이름 '총무 알림'이다. 실행 때마다 멤버를 '총무 보기 이상 활성 계정'으로 맞춘다(추가·제거 모두) | GA-D3 |
| GD-10 | 첨부는 메신저 첨부 규칙(확장자 표·크기·헤더)을 공용 모듈 `app/attachment-rules.ts`로 옮겨 함께 쓴다. R2 키는 `ga/<ownerType>/<ownerId>/<attachmentId>`다 | 같은 보안 규칙을 두 번 쓰지 않는다 |
| GD-11 | 퇴직 정산의 미반납 자산 조회는 HR 라우트(`GET /api/hr/operations?retirementAssets=<employeeId>`, `hr` 모듈, `isHrManager`)가 `ga_assets`를 읽기 전용으로 조회한다. 반납 처리는 총무 탭에서 한다 | 총무 권한이 없는 HR 담당자도 회수 목록을 보게 한다(Plan G) |
| GD-12 | 날짜 필드는 `YYYY-MM-DD` TEXT(KST 달력 날짜), 시각 필드는 epoch ms INTEGER다. 오늘(KST)은 `kstToday(now)`로 구한다 | 만료·D-day는 날짜 단위 |

---

## 1. 탭 등록

`app/access-tabs.ts`의 `TAB_REGISTRY`에서 chat 다음, audit 앞에 넣는다:
```ts
{ key: "general", label: "총무", glyph: "▣", adminOnly: false, modules: ["general"], apiPrefixes: ["/api/general/"], shellClass: "general-module-shell" },
```
- `app/globals.css:27`의 셸 선택자 목록에 `.general-module-shell`을 더한다.
- `TAB_PANELS.general = (ctx) => <GeneralWorkspace canEdit={ctx.tabs.general === "edit"} accountId=… />`
- 탭 배지는 `badges.general`이고 값은 '경과 + 당일 + D-7' 건수다. 셸이 총무 보기 이상일 때 `GET /api/general/overview?summary=1`을 10분마다, 그리고 focus 때 부른다.
- 기존 테스트의 탭 목록 기대값(access-policy·auth-session·tab-permissions·shell-tabs)에 `general`을 더한다.

---

## 2. Data Model (`ensureSchema`는 라우트 공용 `app/ga-schema.ts`의 `gaSchemaStatements(db)`)

모든 라우트가 `ensureGaSchema(db)`를 부른다. 모듈 memo 게이트이고, 실패하면 초기화한다. 추가만 하고 DROP은 하지 않는다. FK는 없다.

```sql
CREATE TABLE IF NOT EXISTS ga_assets (
  id TEXT PRIMARY KEY NOT NULL,                 -- 'gaa_<uuid>'
  asset_no TEXT NOT NULL,                       -- 'GA-EQ-2026-0001'(자동), 수정 가능
  kind TEXT NOT NULL CHECK (kind IN ('EQUIPMENT','SUPPLY','CONTRACT','FIXED')),
  name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('IN_STOCK','ASSIGNED','REPAIR','ACTIVE','ENDED','DISPOSED')),
  location TEXT NOT NULL DEFAULT '',
  holder_employee_id TEXT,                      -- 지급 장비의 현재 사용자, 고정자산의 사용자(선택)
  acquired_on TEXT, acquisition_cost INTEGER NOT NULL DEFAULT 0, vendor TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '', serial_no TEXT NOT NULL DEFAULT '',            -- EQUIPMENT
  quantity INTEGER NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT '', min_quantity INTEGER NOT NULL DEFAULT 0,  -- SUPPLY
  counterparty TEXT NOT NULL DEFAULT '', contract_no TEXT NOT NULL DEFAULT '',   -- CONTRACT
  starts_on TEXT, ends_on TEXT, auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0,1)),
  renewal_cost INTEGER NOT NULL DEFAULT 0, billing_cycle TEXT NOT NULL DEFAULT '' CHECK (billing_cycle IN ('','MONTHLY','QUARTERLY','YEARLY','ONCE')),
  manager_employee_id TEXT,                     -- CONTRACT 담당자
  useful_life_months INTEGER NOT NULL DEFAULT 0, residual_value INTEGER NOT NULL DEFAULT 0,        -- FIXED(또는 고가 장비의 선택 입력)
  opening_accumulated INTEGER NOT NULL DEFAULT 0, opening_as_of TEXT,
  disposed_on TEXT, disposal_amount INTEGER NOT NULL DEFAULT 0,
  alert_off INTEGER NOT NULL DEFAULT 0 CHECK (alert_off IN (0,1)),
  memo TEXT NOT NULL DEFAULT '', import_batch_id TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_assets_no ON ga_assets(asset_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ga_assets_kind ON ga_assets(kind, status);
CREATE INDEX IF NOT EXISTS idx_ga_assets_holder ON ga_assets(holder_employee_id) WHERE holder_employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ga_asset_events (
  id TEXT PRIMARY KEY NOT NULL, asset_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ACQUIRED','ASSIGNED','RETURNED','MOVED','STOCK_IN','STOCK_OUT','REPAIR','REPAIRED','RENEWED','DISPOSED','IMPORTED')),
  event_on TEXT NOT NULL, employee_id TEXT, quantity_delta INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ga_asset_events_asset ON ga_asset_events(asset_id, created_at);

CREATE TABLE IF NOT EXISTS ga_documents (
  id TEXT PRIMARY KEY NOT NULL,                 -- 'gad_<uuid>'
  kind TEXT NOT NULL CHECK (kind IN ('BUSINESS_REG','CORP_REGISTRY','SEAL_CERT','SEAL_USAGE','CERTIFICATE','PERMIT','B2B_CONTRACT','OTHER')),
  title TEXT NOT NULL, issuer TEXT NOT NULL DEFAULT '', issued_on TEXT, expires_on TEXT,
  validity_months INTEGER NOT NULL DEFAULT 0,   -- 제출용 서류: 발급일 + N개월(0 = 해당 없음)
  storage_location TEXT NOT NULL DEFAULT '', manager_employee_id TEXT,
  contract_type TEXT NOT NULL DEFAULT '' CHECK (contract_type IN ('','SUPPLY','PARTNER','SERVICE','NDA','OTHER')),   -- B2B_CONTRACT
  counterparty TEXT NOT NULL DEFAULT '', signed_on TEXT, starts_on TEXT, ends_on TEXT,
  contract_amount INTEGER NOT NULL DEFAULT 0, auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0,1)),
  notice_days INTEGER NOT NULL DEFAULT 0,       -- 해지 통보 기한: 종료일 N일 전
  alert_off INTEGER NOT NULL DEFAULT 0 CHECK (alert_off IN (0,1)),
  memo TEXT NOT NULL DEFAULT '', import_batch_id TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ga_documents_kind ON ga_documents(kind) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ga_custody_items (     -- 반출 대상 보관품(법인인감·사용인감·기타)
  id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('CORP_SEAL','USAGE_SEAL','OTHER')),
  name TEXT NOT NULL, storage_location TEXT NOT NULL DEFAULT '', manager_employee_id TEXT, memo TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS ga_checkouts (
  id TEXT PRIMARY KEY NOT NULL,                 -- 'gac_<uuid>'
  target_type TEXT NOT NULL CHECK (target_type IN ('ITEM','DOCUMENT')), target_id TEXT NOT NULL,
  borrower_employee_id TEXT NOT NULL, purpose TEXT NOT NULL, submit_to TEXT NOT NULL DEFAULT '',
  out_on TEXT NOT NULL, due_on TEXT, returned_on TEXT, received_by TEXT NOT NULL DEFAULT '', return_memo TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cancelled_at INTEGER,
  import_batch_id TEXT
);
-- 같은 대상은 반납 전 한 건만(동시 기록 경쟁도 이 인덱스가 409로 막는다)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_checkouts_open ON ga_checkouts(target_type, target_id) WHERE returned_on IS NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ga_checkouts_out ON ga_checkouts(out_on);

CREATE TABLE IF NOT EXISTS ga_attachments (
  id TEXT PRIMARY KEY NOT NULL, owner_type TEXT NOT NULL CHECK (owner_type IN ('ASSET','DOCUMENT')), owner_id TEXT NOT NULL,
  file_name TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, storage_key TEXT NOT NULL UNIQUE,
  uploaded_by TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ga_attachments_owner ON ga_attachments(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS ga_import_batches (
  id TEXT PRIMARY KEY NOT NULL, sheet TEXT NOT NULL, row_count INTEGER NOT NULL, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, reverted_at INTEGER
);

CREATE TABLE IF NOT EXISTS ga_alert_runs (          -- KST 날짜별 1행. 메신저 글 멱등
  run_date TEXT PRIMARY KEY NOT NULL, trigger TEXT NOT NULL, item_count INTEGER NOT NULL, message_id INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ga_alert_marks (         -- 항목별 마지막으로 알린 구간. 새 구간에 들어올 때만 글에 싣는다
  item_key TEXT PRIMARY KEY NOT NULL,              -- 'asset:<id>:end' | 'doc:<id>:expiry' | 'doc:<id>:notice' | 'checkout:<id>:due' | 'asset:<id>:stock'
  bucket TEXT NOT NULL, due_on TEXT, run_date TEXT NOT NULL
);
```

**상태 전이 (`ga_assets.status`)**

| kind | 가능한 상태 | 전이 |
|------|------------|------|
| EQUIPMENT | IN_STOCK · ASSIGNED · REPAIR · DISPOSED | IN_STOCK↔ASSIGNED(ASSIGN/RETURN), IN_STOCK·ASSIGNED→REPAIR→IN_STOCK(REPAIRED), *→DISPOSED |
| SUPPLY | ACTIVE · DISPOSED | 수량만 바뀐다(STOCK_IN/OUT, 음수가 되면 400) |
| CONTRACT | ACTIVE · ENDED · DISPOSED | RENEW(종료일 연장·RENEWED 이벤트), END |
| FIXED | ACTIVE · DISPOSED | DISPOSE(처분일·처분가) |

전이는 `UPDATE … WHERE id=? AND status IN (<from>)`로 한다. `meta.changes = 0`이면 409 `CONFLICT`다(HR 즉시 반영과 같은 방식).

**자산번호**
- 형식은 `GA-<EQ|SU|CT|FA>-<취득연도 또는 올해>-<4자리 일련>`이다. 일련은 같은 접두사의 최대값 + 1이다.
- 사용자가 직접 넣은 번호가 겹치면 409 `DUPLICATE`다.

---

## 3. 알림 계산 (`app/ga-alerts.ts`, 순수)

```ts
export type AlertBucket = "OVERDUE" | "TODAY" | "D7" | "D30" | "LOW_STOCK";
export type AlertItem = { key: string; kind: "CONTRACT_END" | "DOC_EXPIRY" | "DOC_NOTICE" | "CHECKOUT_DUE" | "LOW_STOCK";
  ownerType: "ASSET" | "DOCUMENT" | "CHECKOUT"; ownerId: string; title: string; dueOn: string | null; daysLeft: number | null; bucket: AlertBucket };
export function kstToday(now: number): string;                          // 'YYYY-MM-DD'
export function bucketOf(dueOn: string, today: string): AlertBucket | null; // <0 OVERDUE, 0 TODAY, 1..7 D7, 8..30 D30, 그 밖 null
export function collectAlerts(input: { assets; documents; checkouts; today }): AlertItem[];
export function newlyEntered(items: AlertItem[], marks: Map<string, string>): AlertItem[]; // 마지막 구간보다 급해졌을 때만(D30→D7→TODAY→OVERDUE)
export function alertMessage(items: AlertItem[], today: string): string; // 메신저 본문(4000자 이하, 넘으면 "외 N건")
```

| 대상 | 기준일 | 제외 |
|------|--------|------|
| CONTRACT 자산 | `ends_on` | `alert_off=1`, `status≠ACTIVE`. 자동 갱신이면 기본 `alert_off=1`로 만든다(끌 수 있음) |
| 회사 서류(일반) | `expires_on`, 없으면 `issued_on + validity_months` | `alert_off=1`, 삭제됨 |
| 기업 간 계약서 | `ends_on`(자동 연장이 아니면), `ends_on - notice_days`(notice_days>0) | 같음 |
| 반출 | `due_on` | 반납·취소됨 |
| 비품 | `quantity < min_quantity`(min_quantity>0) → LOW_STOCK | DISPOSED |

- 날짜 계산은 달력 날짜 차이이고 KST 기준이다. 월 더하기는 말일을 보정한다(1/31 + 1개월 → 2/28 또는 2/29).
- 배지 수는 OVERDUE + TODAY + D7이다. LOW_STOCK은 현황에만 보이고 배지에는 넣지 않는다.

---

## 4. API (`/api/general/*`)

공통 규칙은 이렇다.
- `authorizeErpRequest(db, "general", read|write)`로 먼저 인가하고, 그다음 본문을 읽는다.
- 오류는 `erpError` 형식이다(`VALIDATION`·`NOT_FOUND`·`CONFLICT`·`DUPLICATE`).
- 감사 module은 `general`이다. after에는 id, 건수, 금액, 상태만 넣는다. 파일 이름, 계약번호, 인증서 번호는 넣지 않는다.
- 직원 참조(`*_employee_id`)는 `hr_employee_records`에 있어야 한다. 없으면 400이다.

| Method | Path | 권한 | 내용 |
|---|---|---|---|
| GET | `/api/general/overview` | read | 현황: `{ alerts: AlertItem[], badge, openCheckouts, overdueCheckouts, assetSummary:{kind,count,bookValue}[], holders:{employeeId,name,count}[], lowStock }`. `?summary=1`이면 `{ badge }`만 |
| GET | `/api/general/people` | read | 직원 선택용 `{employeeId, name, department, status}[]`(재직·휴직만, 급여·연락처 없음) |
| GET | `/api/general/assets` | read | `?kind=&status=&q=` 목록. `?id=`이면 상세(이벤트, 첨부, 고정자산이면 `depreciation:{monthly, accumulated, bookValue, schedule[]}`) |
| POST | `/api/general/assets` | write | `action`: `CREATE`, `UPDATE`, `ASSIGN{employeeId,on}`, `RETURN{on,location}`, `MOVE{location}`, `STOCK_IN{quantity}`, `STOCK_OUT{quantity,employeeId?}`, `REPAIR`, `REPAIRED`, `RENEW{endsOn,cost}`, `END`, `DISPOSE{on,amount,reason}`, `DELETE`(soft) |
| GET / POST | `/api/general/documents` | read / write | 목록·상세 / `CREATE`, `UPDATE`, `DELETE`(반출 중이면 409) |
| GET / POST | `/api/general/custody` | read / write | 보관품 목록과 반출 대장(`?open=1`, `?targetId=`) / `CREATE_ITEM`, `UPDATE_ITEM`, `DELETE_ITEM`, `CHECKOUT{targetType,targetId,borrowerEmployeeId,purpose,submitTo,outOn,dueOn}`(열린 반출이 있으면 409 `CONFLICT` "이미 반출 중입니다."), `RETURN{id,returnedOn,receivedBy,memo}`, `UPDATE_DUE`, `CANCEL` |
| PUT / GET / DELETE | `/api/general/attachments` | write / read / write | `?ownerType=&ownerId=&name=` raw 업로드(411·413·415, 25MB) / `?id=` 다운로드(nosniff, sandbox, 이미지만 inline) / `?id=` 삭제(R2 삭제 + soft) |
| POST | `/api/general/import` | write | `{action:"PREVIEW"\|"COMMIT", sheet, rows, mode:"skip"\|"overwrite", overwriteRows?:number[]}` → PREVIEW `{rows:[{row, status:"ok"\|"error"\|"duplicate", errors[], normalized}]}` / COMMIT `{batchId, created, updated, skipped}`. `{action:"REVERT", batchId}`는 그 배치가 만든 행만 soft-delete한다(덮어쓴 행은 되돌리지 않는다고 화면에 안내) |
| POST | `/api/general/alerts` | 시스템 또는 write | GD-7. `{ trigger }` → `{ runDate, posted:boolean, itemCount }`. 같은 KST 날짜에 이미 실행했으면 `posted:false`(200)다 |

**`POST /api/general/alerts` 인가 (GD-7)**
1. `X-XDM-Task: ga-alerts` 헤더가 있고, `peerOf(headers).loopback === true`이고, 세션 쿠키가 없으면 시스템 호출이다. 교차 출처 검사는 똑같이 한다(스크립트가 `Origin: http://127.0.0.1:3000`을 보낸다). 감사 actor는 `SYSTEM`이다.
2. 그 밖에는 `authorizeErpRequest(db, "general", "write")`다.
3. 실행 순서
   - `ga_alert_runs`에 오늘 행을 `INSERT OR IGNORE`한다. 바뀐 행이 0이면 끝이다(멱등, 동시 호출 안전).
   - `collectAlerts` → `newlyEntered`
   - 채널 보장·멤버 동기화(§5) → 새 항목이 있으면 메시지 1개 → `ga_alert_marks` upsert를 한 batch로 실행한다
   - 감사 `GA_ALERTS_RUN{runDate,itemCount,posted}`

---

## 5. 메신저 연결 (GD-8·GD-9)

- `ensureAlertChannel(db, now)`
  - `INSERT OR IGNORE chat_channels(id='ch_ga_alerts', kind='private', name='총무 알림', topic='만료·반납 예정 자동 알림', created_by='system:ga')`
  - 이름이 겹치면(사람이 먼저 '총무 알림'을 만든 경우) 이름을 '총무 알림(자동)'으로 넣는다.
- 멤버 동기화
  - 대상은 `auth_accounts WHERE active=1` 가운데 `resolveTabs(tabs_json,is_admin).general !== 'none'`인 계정이다.
  - 빠진 사람은 `joinStatements`로 넣고, 권한을 잃은 멤버는 `left_at` + `member.left`로 뺀다.
- 메시지는 `chat_messages(author_account_id='system:ga', client_key='system:ga:<runDate>', body=alertMessage(...))`에 넣고 `message.created` 이벤트를 남긴다. `client_key` UNIQUE가 두 번째 방어선이다.
- 채팅 쪽 변경
  - `toMessageDto`: 작성자 id가 `system:`으로 시작하면 이름을 'XDnode 알림'으로 둔다.
  - `chatPeople`는 `auth_accounts`만 읽으므로 변경이 없다.
  - 화면: 시스템 글은 가운데 정렬이고, 알림 스타일 말풍선(회색 테두리 + 종 아이콘)이며, 수정·삭제 버튼이 없다(내 글이 아님).
  - `REMOVE_MEMBER`·`RENAME`: owner가 없는 채널이라 관리자만 한다(기존 규칙). 멤버 동기화가 다음 실행 때 권한 기준으로 다시 맞춘다.
- 본문 예(4000자 제한)
  ```
  [총무 알림] 2026-10-01 (새로 들어온 3건)
  ⛔ 경과  반출 · 법인인감 — 김하나, 반납 예정 09-28 (3일 지남)
  ⚠️ D-7   계약 · 도메인 xdnode.co.kr — 만료 10-05 (4일 남음)
  🗓 D-30  서류 · 물품공급 계약(○○상사) 해지 통보 기한 — 10-25 (24일 남음)
  총무 탭 > 현황에서 전체를 확인하세요.
  ```

**작업 스케줄러**
- `Register-XDNodeManagementTasks.ps1`에 `XDnodeManagement-Alerts`(매일 09:00, 같은 사용자, `scripts/Run-GaAlerts.ps1`)를 더한다. 등록할 때 비밀번호를 다시 입력해야 하므로 운영 반영 때 사용자와 함께 한다.
- `Start-XDNodeManagement.ps1 -Headless`는 `ready` 뒤 같은 스크립트를 한 번 부른다(실패는 경고만).
- `Run-GaAlerts.ps1`은 `Invoke-WebRequest -Method POST http://127.0.0.1:3000/api/general/alerts`에 헤더 `X-XDM-Task`, `Origin`, 본문 `{"trigger":"task"}`를 보낸다. 결과는 `xdm-yyyyMMdd.log`에 남긴다.

---

## 6. 엑셀 양식 (GA-D1, 시트별 열 · `*` 필수)

양식 파일은 `XD NODE_총무_가져오기양식.xlsx`이고 시트는 7개다. 첫 행은 머리글이고 둘째 행은 예시(회색, 가져오기에서 무시)다. 날짜는 `2026-10-01`, `2026.10.01`, 엑셀 날짜를 모두 받는다. 금액은 쉼표와 '원'을 허용한다. 직원은 이름 또는 사번으로 찾고, 이름이 둘 이상이면 오류로 사번을 요구한다.

| 시트 | 열 |
|---|---|
| 지급장비 | 자산번호, 이름*, 분류, 모델, 시리얼, 상태(재고/지급/수리), 사용자, 위치, 취득일, 취득가, 공급처, 내용연수(개월), 메모 |
| 비품소모품 | 자산번호, 이름*, 분류, 위치, 수량*, 단위, 최소수량, 취득일, 단가, 공급처, 메모 |
| 계약구독 | 자산번호, 이름*, 분류(라이선스/도메인/호스팅/리스/보험/유지보수/기타), 계약처*, 계약번호, 시작일, 만료일*, 자동갱신(Y/N), 갱신비용, 결제주기(월/분기/연/1회), 담당자, 메모 |
| 고정자산 | 자산번호, 이름*, 분류, 취득일*, 취득가*, 내용연수(개월)*, 잔존가치, 기초상각누계, 기초기준일, 위치, 사용자, 메모 |
| 회사서류 | 종류*(사업자등록증/등기부등본/인감증명서/사용인감계/인증서/인허가증/기타), 서류명*, 발급기관, 발급일, 만료일, 유효기간(개월), 보관위치*, 관리책임자, 메모 |
| 기업간계약서 | 계약명*, 계약종류*(물품공급/파트너/용역/비밀유지/기타), 상대방*, 계약일, 시작일, 종료일, 계약금액, 자동연장(Y/N), 해지통보기한(일), 보관위치, 관리책임자, 메모 |
| 반출대장 | 대상*(보관품 이름 또는 서류명), 반출자*, 반출일*, 용도*, 제출처, 반납예정일, 반납일, 받은사람, 메모 |

- 파싱은 브라우저에서 `read-excel-file`로 한다. 머리글 이름으로 열을 찾으므로 열 순서가 바뀌어도 된다. 모르는 열은 무시한다.
- 서버 PREVIEW가 같은 검증을 다시 한다(클라이언트 결과를 믿지 않음). 한 번에 1,000행까지다.
- 반출대장 가져오기에서 반납일이 없는 행은 열린 반출이 된다. 같은 대상의 열린 반출이 둘이면 뒤 행이 오류다.
- 내보내기는 같은 열 구성을 쓴다(`write-excel-file`). 그래서 내보낸 파일을 고쳐 다시 가져올 수 있다(자산번호로 덮어쓰기).

---

## 7. 화면 (`app/general-workspace.tsx`, `app/general-workspace.css`)

| 영역 | 내용 |
|---|---|
| 상단 탭 | 현황 · 자산 · 회사 서류 · 인감·반출 · 가져오기/내보내기 (선택 탭은 계정 범위 키 `xdnode-general-view`로 기억) |
| 현황 | 알림 카드(경과·당일·D-7·D-30 수), 알림 목록(클릭하면 해당 항목 열기), 반출 중 목록(반납 예정일 지난 건 빨강), 유형별 수량·장부가액, 직원별 지급 장비, 재고 부족 |
| 자산 | 유형 필터 칩(전체·지급장비·비품·계약·고정자산), 검색, 표. 행 클릭 → 오른쪽 상세 패널(필드, 이력 타임라인, 첨부, 고정자산 상각표, 작업 버튼: 지급·반납·이동·입고·출고·수리·갱신·처분) |
| 회사 서류 | 종류 필터(기업 간 계약서 포함), 만료 D-day 배지, 상세 패널(스캔본 첨부, 반출 이력, '반출 기록' 버튼) |
| 인감·반출 | 보관품 카드(현재 상태: 보관 중 / 반출 중 — 누가·언제·예정일), 반출 기록 폼, 대장 표(기간·대상·반출자 필터), 반납 처리 |
| 가져오기/내보내기 | 양식 내려받기, 시트 선택 → 파일 선택 → 미리보기 표(오류 행 빨강·중복 행 노랑·덮어쓰기 체크) → 반영, 최근 가져오기 목록과 '되돌리기', 장부 내보내기 |
| 권한 | 보기 권한은 모든 작업 버튼을 비활성화하고 배너 "보기 권한만 있습니다."를 띄운다(HR과 같은 방식). 서버 403이 최종 방어 |

- 금액은 `formatWon`으로 쓴다. 고정자산 화면에는 "관리용 장부가액입니다. 세무 신고 금액과 다를 수 있습니다."를 표시한다(R-GA5).
- 시스템 글 스타일은 `app/chat-workspace.css`에 `.chat-message.system`으로 둔다.

**HR 연결 (GD-11)**
- `hr-workspace.tsx`의 퇴직 정산 체크 '회사 자산 반납' 옆에 `GET /api/hr/operations?retirementAssets=<employeeId>` 결과를 보여 준다.
  - 표시 내용: `{assetNo, name, kind, assignedOn}[]`, 또는 표가 없거나 0건이면 "지급 중인 자산 없음"
- 버튼 '총무 탭에서 반납 처리'는 총무 편집 권한이 있을 때만 보인다(`me.tabs.general === 'edit'`). 누르면 셸 탭을 `general`로 바꾸고 자산 상세를 연다(URL 해시 `#ga-asset=<id>`).

---

## 8. 첨부 공용화 (GD-10)

- 메신저 첨부 규칙을 `app/attachment-rules.ts`로 옮긴다. 대상은 `CHAT_ATTACHMENT_TYPES`, `attachmentTypeOf`, `cleanFileName`, `contentDisposition`, 25MB 상수다.
- `app/chat-server.ts`는 이 모듈을 다시 내보낸다(기존 import 유지). 동작은 바뀌지 않고 chat-api 테스트로 확인한다.
- 총무 첨부도 같은 확장자 표를 쓴다. 인증서 파일(pfx·p12·der·key)은 표에 없으므로 415다(R-GA2).

---

## 9. 테스트 (`tests/ga-api.test.mjs`, 하니스)

| # | 시나리오 | 기대 |
|---|---|---|
| 1 | general=none 계정이 모든 `/api/general/*`에 접근 / view가 쓰기 | 403 / 403(ACCESS_DENIED 감사) |
| 2 | 장비 CREATE → ASSIGN → 같은 장비 ASSIGN 다시 → RETURN | 201 → 200 → 409 → 200, 이벤트 3개, holder null |
| 3 | 비품 STOCK_OUT으로 음수 / 동시 두 요청 | 400 / 합계 일치 |
| 4 | 자산번호 자동 발급 순서, 직접 입력 중복 | `GA-EQ-2026-0001`, `…0002` / 409 |
| 5 | 고정자산 상각: 1,200,000원·36개월·잔존 0, 2026-01 취득, 2026-09 기준 | 월 33,333원(나머지 12원은 처음 12개월에 1원씩), 누계·장부가 일치, 처분 뒤 0 |
| 6 | 반출 CHECKOUT 두 번(같은 인감) / 서로 다른 대상 / 반납 뒤 다시 반출 | 409 / 200 / 200 |
| 7 | 서류 DELETE(반출 중) | 409 |
| 8 | 알림 구간: 오늘 기준 -1·0·7·8·30·31일, 월말 보정, 기업 간 계약 해지 통보, 자동 갱신 기본 끄기 | OVERDUE·TODAY·D7·D30·D30·없음 |
| 9 | 알림 실행: 시스템 호출(루프백+헤더) / 비루프백+헤더 / 같은 날 두 번 | 200 posted / 401 / 두 번째 posted:false, 메시지 1개 |
| 10 | 알림 채널 멤버: 권한자만, 권한을 뺀 계정은 다음 실행에서 left, 비권한자의 채널 목록·poll에 안 보임 | chat 규칙 그대로 |
| 11 | 시스템 글 DTO 작성자 'XDnode 알림', `auth_accounts`에 `system:ga` 없음, 로그인 불가 | |
| 12 | 첨부: pdf 업로드·다운로드 헤더, pfx 415, 26MB 413, 보기 권한자는 다운로드만 가능 | |
| 13 | 가져오기 PREVIEW 오류 행(필수 누락·날짜·직원 동명이인), COMMIT 건수, skip/overwrite, REVERT가 만든 행만 삭제 | |
| 14 | HR `retirementAssets`: HR 편집이면 목록, HR 보기면 403, ga 표 없음(새 DB) 이면 [] | |
| 15 | 감사 JSON에 파일 이름·계약번호·서류명 문자열이 없다 | |
| 16 | 소스 가드: 레지스트리 항목, `TAB_PANELS.general`, raw HTML 0건, `formatWon` 사용 | |

- 기존 테스트 기대값을 갱신한다(탭 목록, `grantableTabs`). `package.json` 테스트 목록에 `ga-api`를 더한다.
- 개발 서버 실제 점검은 R5 때와 같이 테스트 계정으로 한다. 대상은 등록 → 지급 → 반납, 첨부 헤더, 알림 멱등, 메신저 글 수신이다.

---

## 10. Implementation Order (GA1, 한 번에 배포)

| 순서 | 단위 | 내용 |
|---|---|---|
| 1 | ga-core | 레지스트리·셸 패널 틀, `ga-schema.ts`, `attachment-rules.ts` 이전, `ga-alerts.ts`·상각 계산(순수)과 단위 테스트 |
| 2 | ga-api | assets·documents·custody·people·overview·attachments 라우트, ga-api #1~#7·#12·#15 |
| 3 | ga-alerts | alerts 라우트, 채널·멤버 동기화, 시스템 글 DTO, `Run-GaAlerts.ps1`, Start·Register 스크립트, #8~#11 |
| 4 | ga-import | 양식·파서·PREVIEW/COMMIT/REVERT·내보내기, #13 |
| 5 | ga-ui | `general-workspace.tsx`·css, 탭 배지, HR 퇴직 정산 연결(#14), 시스템 글 스타일 |
| 6 | 검증·반영 | 전체 테스트, 개발 서버 점검, 태그, Deploy, 작업 스케줄러에 Alerts 작업 등록(사용자 비밀번호 입력), GA-SC-1~5 |

---

## Version History

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-09-30 | 초안(Plan v0.2 기준). GD-1~GD-12 |
