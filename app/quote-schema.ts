import "server-only";

// 견적 탭 스키마(quote-tool Design §2.1, QT-D1). 모든 /api/quote/* 라우트가 ensureQuoteSchema(db) 를 먼저 부른다.
// 15개 표를 QT1 에서 모두 만든다(QT2 이후 릴리스는 코드만 더한다). 추가만 하고 DROP 하지 않는다(D4). FK 는 없다. 불린은 0/1.
// 플랫폼·HR·총무·채팅 DDL 은 건드리지 않는다.

export const QUOTE_TABLES = [
  "quote_corpus_files", "quote_corpus_sheets", "quote_corpus_items", "quote_corpus_margin_items",
  "quote_issued", "quote_price_log",
  "quote_catalog_products", "quote_catalog_legacy", "quote_spec_library", "quote_customers", "quote_bom_library",
  "quote_staff_profiles", "quote_meta", "quote_source_snapshots", "quote_import_runs",
] as const;

export const QUOTE_DDL: readonly string[] = [
  // ── 과거 견적 코퍼스(이전 전용, id = 옛 corpus.sqlite id, QD-14) ──
  `CREATE TABLE IF NOT EXISTS quote_corpus_files (
  id INTEGER PRIMARY KEY,
  file TEXT NOT NULL,
  quote_date TEXT, customer_from_name TEXT, model_hint TEXT, contact_from_name TEXT, suffix TEXT, mtime TEXT,
  quote_json TEXT,
  reverse_error TEXT,
  imported_at INTEGER NOT NULL, import_run_id TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_quote_corpus_files_date ON quote_corpus_files(quote_date)`,
  `CREATE TABLE IF NOT EXISTS quote_corpus_sheets (
  id INTEGER PRIMARY KEY, quote_id INTEGER NOT NULL, sheet_name TEXT,
  is_margin INTEGER NOT NULL DEFAULT 0 CHECK (is_margin IN (0,1)),
  customer TEXT, contact TEXT, tel TEXT, email TEXT,
  valid_weeks TEXT, delivery TEXT, payment TEXT, place TEXT, project TEXT,
  staff TEXT, staff_tel TEXT, staff_email TEXT,
  has_set_col INTEGER, header_row INTEGER, subtotal REAL, vat REAL, total REAL, remark TEXT, n_items INTEGER,
  imported_at INTEGER NOT NULL, import_run_id TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_quote_corpus_sheets_quote ON quote_corpus_sheets(quote_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quote_corpus_sheets_customer ON quote_corpus_sheets(customer)`,
  `CREATE TABLE IF NOT EXISTS quote_corpus_items (
  id INTEGER PRIMARY KEY, sheet_id INTEGER NOT NULL, row INTEGER, no TEXT,
  is_group INTEGER CHECK (is_group IS NULL OR is_group IN (0,1)),
  category TEXT, spec TEXT, spec_first_line TEXT, qty REAL, sets REAL, unit_price REAL, amount REAL,
  imported_at INTEGER NOT NULL, import_run_id TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_quote_corpus_items_spec ON quote_corpus_items(spec_first_line)`,
  `CREATE INDEX IF NOT EXISTS idx_quote_corpus_items_sheet ON quote_corpus_items(sheet_id)`,
  `CREATE TABLE IF NOT EXISTS quote_corpus_margin_items (
  id INTEGER PRIMARY KEY, sheet_id INTEGER NOT NULL, row INTEGER, category TEXT, spec_first_line TEXT,
  qty REAL, buy_unit REAL, margin_rate REAL, sell_unit REAL,
  imported_at INTEGER NOT NULL, import_run_id TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_quote_corpus_margin_sheet ON quote_corpus_margin_items(sheet_id)`,

  // ── 발행 견적과 단가 로그(앱과 이전이 함께 쓴다) ──
  `CREATE TABLE IF NOT EXISTS quote_issued (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legacy_id INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  issue_date TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_rev INTEGER NOT NULL DEFAULT 0,
  xlsx_key TEXT, pdf_key TEXT,
  legacy_xlsx_path TEXT, legacy_pdf_path TEXT,
  customer TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '', model_hint TEXT,
  subtotal REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, n_lines INTEGER NOT NULL DEFAULT 0,
  quote_json TEXT NOT NULL,
  staff_name TEXT,
  author_account_id TEXT,
  author_name TEXT NOT NULL DEFAULT '',
  legacy_author_host TEXT,
  status TEXT CHECK (status IS NULL OR status IN ('draft','confirmed','discarded')),
  dedup_key TEXT, suffix TEXT,
  op_token TEXT,
  app_modified_at INTEGER,
  imported_at INTEGER, import_run_id TEXT
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_quote_issued_dedup ON quote_issued(dedup_key) WHERE dedup_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_quote_issued_legacy ON quote_issued(legacy_id) WHERE legacy_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_quote_issued_customer ON quote_issued(customer)`,
  `CREATE INDEX IF NOT EXISTS idx_quote_issued_pending ON quote_issued(status, issue_date, id)`,
  `CREATE INDEX IF NOT EXISTS idx_quote_issued_op ON quote_issued(op_token) WHERE op_token IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS quote_price_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legacy_id INTEGER,
  issued_id INTEGER NOT NULL,
  issue_date TEXT, customer TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('set','item','single')),
  category TEXT, name TEXT, name_key TEXT, qty REAL, unit_price REAL,
  status TEXT CHECK (status IS NULL OR status IN ('draft','confirmed','discarded')),
  imported_at INTEGER, import_run_id TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_quote_price_log_key ON quote_price_log(name_key, issue_date)`,
  `CREATE INDEX IF NOT EXISTS idx_quote_price_log_issued ON quote_price_log(issued_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_quote_price_log_legacy ON quote_price_log(legacy_id) WHERE legacy_id IS NOT NULL`,

  // ── 카탈로그(원천 sha256 = version, QD-13). ord = 원천 파일의 순서 ──
  `CREATE TABLE IF NOT EXISTS quote_catalog_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, ord INTEGER NOT NULL,
  canonical TEXT NOT NULL, category TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('part','system','license','service','junk')),
  keys_json TEXT NOT NULL DEFAULT '[]', spellings_json TEXT NOT NULL DEFAULT '[]',
  n INTEGER NOT NULL DEFAULT 0, min REAL, max REAL, last_price REAL, last_date TEXT, first_date TEXT,
  note TEXT, caution TEXT, outliers_json TEXT, history_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (version, ord)
)`,
  `CREATE TABLE IF NOT EXISTS quote_catalog_legacy (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, ord INTEGER NOT NULL,
  name TEXT NOT NULL, key TEXT, category TEXT, n INTEGER NOT NULL DEFAULT 0, last_date TEXT,
  group_ratio REAL NOT NULL DEFAULT 0, last_price REAL, last_price_date TEXT, price_history_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (version, ord)
)`,
  `CREATE TABLE IF NOT EXISTS quote_spec_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, ord INTEGER NOT NULL,
  name TEXT NOT NULL, spec TEXT NOT NULL, date TEXT, category TEXT,
  UNIQUE (version, ord)
)`,
  `CREATE TABLE IF NOT EXISTS quote_customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, ord INTEGER NOT NULL,
  org TEXT NOT NULL, contact TEXT, tel TEXT, email TEXT, last_date TEXT, n INTEGER,
  UNIQUE (version, ord)
)`,
  `CREATE TABLE IF NOT EXISTS quote_bom_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, ord INTEGER NOT NULL,
  sheet_id INTEGER, file TEXT, date TEXT, customer TEXT, sheet_name TEXT, total REAL, subtotal REAL,
  system_label TEXT, system_name TEXT, gpu_name TEXT NOT NULL, gpu_key TEXT, gpu_qty INTEGER NOT NULL,
  base_key TEXT NOT NULL, remark TEXT, parts_json TEXT NOT NULL, n_slots INTEGER NOT NULL, base_max_gpu INTEGER NOT NULL,
  UNIQUE (version, ord)
)`,

  // ── 담당자 블록(QT-Q3) ──
  `CREATE TABLE IF NOT EXISTS quote_staff_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  tel TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  account_id TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0,1)),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_quote_staff_name ON quote_staff_profiles(name) WHERE active = 1`,

  // ── 설정·원문·이전 기록 ──
  `CREATE TABLE IF NOT EXISTS quote_meta (
  key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS quote_source_snapshots (
  name TEXT NOT NULL, version TEXT NOT NULL,
  part INTEGER NOT NULL, part_count INTEGER NOT NULL, body TEXT NOT NULL,
  imported_at INTEGER NOT NULL, import_run_id TEXT NOT NULL,
  PRIMARY KEY (name, version, part)
)`,
  `CREATE TABLE IF NOT EXISTS quote_import_runs (
  id TEXT PRIMARY KEY NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  actor_account_id TEXT NOT NULL,
  source_json TEXT NOT NULL,
  result_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','OK','MISMATCH','FAILED'))
)`,
];

export function quoteSchemaStatements(db: D1Database) {
  return QUOTE_DDL.map((sql) => db.prepare(sql));
}

let gate: Promise<void> | null = null;
/** 프로세스당 한 번(ensureGaSchema 와 같은 memo 게이트). 실패하면 비워 다음 요청에서 다시 시도한다. */
export function ensureQuoteSchema(db: D1Database) {
  if (!gate) {
    gate = db.batch(quoteSchemaStatements(db)).then(() => undefined).catch((error) => {
      gate = null;
      throw error;
    });
  }
  return gate;
}

/** 하니스 전용: 새 메모리 DB 마다 게이트를 비운다. */
export function resetQuoteSchemaGate() {
  gate = null;
}
