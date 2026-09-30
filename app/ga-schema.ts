// 총무 탭 스키마(general-affairs Design §2). 모든 /api/general/* 라우트와 HR 퇴직 자산 조회가 ensureGaSchema 를 부른다.
// 추가만 하고 DROP 은 하지 않는다(D4). FK 는 두지 않는다. 옛 finance_* 고정자산 테이블은 읽지도 쓰지도 않는다(D24).

const GA_DDL = [
  `CREATE TABLE IF NOT EXISTS ga_assets (
  id TEXT PRIMARY KEY NOT NULL,
  asset_no TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('EQUIPMENT','SUPPLY','CONTRACT','FIXED')),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('IN_STOCK','ASSIGNED','REPAIR','ACTIVE','ENDED','DISPOSED')),
  location TEXT NOT NULL DEFAULT '',
  holder_employee_id TEXT,
  acquired_on TEXT,
  acquisition_cost INTEGER NOT NULL DEFAULT 0,
  vendor TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  serial_no TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT '',
  min_quantity INTEGER NOT NULL DEFAULT 0,
  counterparty TEXT NOT NULL DEFAULT '',
  contract_no TEXT NOT NULL DEFAULT '',
  starts_on TEXT,
  ends_on TEXT,
  auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0,1)),
  renewal_cost INTEGER NOT NULL DEFAULT 0,
  billing_cycle TEXT NOT NULL DEFAULT '' CHECK (billing_cycle IN ('','MONTHLY','QUARTERLY','YEARLY','ONCE')),
  manager_employee_id TEXT,
  useful_life_months INTEGER NOT NULL DEFAULT 0,
  residual_value INTEGER NOT NULL DEFAULT 0,
  opening_accumulated INTEGER NOT NULL DEFAULT 0,
  opening_as_of TEXT,
  disposed_on TEXT,
  disposal_amount INTEGER NOT NULL DEFAULT 0,
  alert_off INTEGER NOT NULL DEFAULT 0 CHECK (alert_off IN (0,1)),
  memo TEXT NOT NULL DEFAULT '',
  import_batch_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_assets_no ON ga_assets(asset_no) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_ga_assets_kind ON ga_assets(kind, status)`,
  `CREATE INDEX IF NOT EXISTS idx_ga_assets_holder ON ga_assets(holder_employee_id) WHERE holder_employee_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ga_asset_events (
  id TEXT PRIMARY KEY NOT NULL,
  asset_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ACQUIRED','ASSIGNED','RETURNED','MOVED','STOCK_IN','STOCK_OUT','REPAIR','REPAIRED','RENEWED','ENDED','DISPOSED','IMPORTED')),
  event_on TEXT NOT NULL,
  employee_id TEXT,
  quantity_delta INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_ga_asset_events_asset ON ga_asset_events(asset_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS ga_documents (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('BUSINESS_REG','CORP_REGISTRY','SEAL_CERT','SEAL_USAGE','CERTIFICATE','PERMIT','B2B_CONTRACT','OTHER')),
  title TEXT NOT NULL,
  issuer TEXT NOT NULL DEFAULT '',
  issued_on TEXT,
  expires_on TEXT,
  validity_months INTEGER NOT NULL DEFAULT 0,
  storage_location TEXT NOT NULL DEFAULT '',
  manager_employee_id TEXT,
  contract_type TEXT NOT NULL DEFAULT '' CHECK (contract_type IN ('','SUPPLY','PARTNER','SERVICE','NDA','OTHER')),
  counterparty TEXT NOT NULL DEFAULT '',
  signed_on TEXT,
  starts_on TEXT,
  ends_on TEXT,
  contract_amount INTEGER NOT NULL DEFAULT 0,
  auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0,1)),
  notice_days INTEGER NOT NULL DEFAULT 0,
  alert_off INTEGER NOT NULL DEFAULT 0 CHECK (alert_off IN (0,1)),
  memo TEXT NOT NULL DEFAULT '',
  import_batch_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
)`,
  `CREATE INDEX IF NOT EXISTS idx_ga_documents_kind ON ga_documents(kind) WHERE deleted_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS ga_custody_items (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CORP_SEAL','USAGE_SEAL','OTHER')),
  name TEXT NOT NULL,
  storage_location TEXT NOT NULL DEFAULT '',
  manager_employee_id TEXT,
  memo TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS ga_checkouts (
  id TEXT PRIMARY KEY NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('ITEM','DOCUMENT')),
  target_id TEXT NOT NULL,
  borrower_employee_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  submit_to TEXT NOT NULL DEFAULT '',
  out_on TEXT NOT NULL,
  due_on TEXT,
  returned_on TEXT,
  received_by TEXT NOT NULL DEFAULT '',
  return_memo TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  import_batch_id TEXT
)`,
  // 같은 대상은 반납 전 한 건만. 동시 기록 경쟁도 이 인덱스가 막는다(GD-4).
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_checkouts_open ON ga_checkouts(target_type, target_id) WHERE returned_on IS NULL AND cancelled_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_ga_checkouts_out ON ga_checkouts(out_on)`,
  `CREATE TABLE IF NOT EXISTS ga_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('ASSET','DOCUMENT')),
  owner_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
)`,
  `CREATE INDEX IF NOT EXISTS idx_ga_attachments_owner ON ga_attachments(owner_type, owner_id)`,
  `CREATE TABLE IF NOT EXISTS ga_import_batches (
  id TEXT PRIMARY KEY NOT NULL,
  sheet TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reverted_at INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS ga_alert_runs (
  run_date TEXT PRIMARY KEY NOT NULL,
  trigger TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  message_id INTEGER,
  created_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS ga_alert_marks (
  item_key TEXT PRIMARY KEY NOT NULL,
  bucket TEXT NOT NULL,
  due_on TEXT,
  run_date TEXT NOT NULL
)`,
];

export function gaSchemaStatements(db: D1Database) {
  return GA_DDL.map((sql) => db.prepare(sql));
}

let gate: Promise<void> | null = null;
/** 프로세스당 한 번. 실패하면 비워 다음 요청에서 다시 시도한다. */
export function ensureGaSchema(db: D1Database) {
  if (!gate) {
    gate = db.batch(gaSchemaStatements(db)).then(() => undefined).catch((error) => {
      gate = null;
      throw error;
    });
  }
  return gate;
}

/** 하니스 전용: 새 메모리 DB 마다 게이트를 비운다. */
export function resetGaSchemaGate() {
  gate = null;
}

/** 새 DB(총무 표 없음)에서 읽기 전용 조회(HR 퇴직 자산)가 표를 만들지 않고 빈 결과를 돌려주게 한다. */
export async function gaTablesExist(db: D1Database) {
  const row = await db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'ga_assets'`).first<{ ok: number }>();
  return Boolean(row);
}
