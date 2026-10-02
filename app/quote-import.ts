// 견적 데이터 이전(quote-tool Design §2.2·§9.2, QT-FR-03). 순수 모듈: 표별 행 검증·정규화와 INSERT 문(문자열 SQL + bind 값 배열)만 만든다.
// 실행·감사는 app/api/quote/import/route.ts 가 한다. 문 하나의 bind 값은 100개 이하(D1 상한)이고 행당 문 1개다.
// 멱등 규칙(§9.2 표): 코퍼스는 id, 카탈로그는 (version, ord), 발행·단가 로그는 legacy_id, 담당자는 활성 행의 name, 스냅샷은 (name, version, part).
// 이전한 원본 값(legacy_id, 옛 dedup_key, name_key)은 다시 계산하지 않는다.

export const IMPORT_MAX_ROWS = 500;
export const SNAPSHOT_PART_BYTES = 1_000_000;
export const VERSION_RE = /^[0-9a-f]{64}$/;

export const IMPORT_TABLES = [
  "corpus_files", "corpus_sheets", "corpus_items", "corpus_margin_items",
  "catalog_products", "catalog_legacy", "spec_library", "customers", "bom_library", "vocab",
  "issued", "price_log", "staff", "source_snapshots",
] as const;
export type ImportTable = (typeof IMPORT_TABLES)[number];
/** version(원천 sha256)을 받는 표. 값은 그 version 이 속하는 원천 이름(ACTIVATE 의 versions 키). */
export const VERSIONED_TABLES: Readonly<Partial<Record<ImportTable, "catalog_v2" | "catalog" | "bom_library">>> = {
  catalog_products: "catalog_v2", catalog_legacy: "catalog", spec_library: "catalog", customers: "catalog", vocab: "catalog", bom_library: "bom_library",
};
export const SOURCE_KEYS = ["catalog_v2", "catalog", "bom_library"] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];

export function isImportTable(value: unknown): value is ImportTable {
  return typeof value === "string" && (IMPORT_TABLES as readonly string[]).includes(value);
}

export type PlannedStatement = { sql: string; binds: unknown[]; legacyId?: number; dedupKey?: string | null };
export type PlanResult = { ok: true; statements: PlannedStatement[] } | { ok: false; index: number; error: string };
export type PlanContext = { runId: string; now: number; version: string | null; newId: () => string };

class RowError extends Error {}
type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => Boolean(value) && typeof value === "object" && !Array.isArray(value);

type ColType = "int" | "real" | "text" | "bool" | "json";
type Col = { name: string; type: ColType; from?: string; required?: boolean; max?: number };
const col = (name: string, type: ColType, options: Omit<Col, "name" | "type"> = {}): Col => ({ name, type, ...options });

function value(row: Obj, column: Col): unknown {
  const key = column.from ?? column.name;
  const raw = row[key];
  if (raw === undefined || raw === null) {
    if (column.required) throw new RowError(`${key} 값이 없습니다.`);
    return null;
  }
  switch (column.type) {
    case "int":
      if (typeof raw !== "number" || !Number.isSafeInteger(raw)) throw new RowError(`${key} 는 정수여야 합니다.`);
      return raw;
    case "real":
      if (typeof raw !== "number" || !Number.isFinite(raw)) throw new RowError(`${key} 는 숫자여야 합니다.`);
      return raw;
    case "bool":
      if (raw === true || raw === 1) return 1;
      if (raw === false || raw === 0) return 0;
      throw new RowError(`${key} 는 0/1 이어야 합니다.`);
    case "json": {
      const text = JSON.stringify(raw);
      if (text.length > (column.max ?? 200_000)) throw new RowError(`${key} 가 너무 큽니다.`);
      return text;
    }
    default: {
      const text = typeof raw === "string" ? raw : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null;
      if (text === null) throw new RowError(`${key} 는 문자열이어야 합니다.`);
      if (text.length > (column.max ?? 20_000)) throw new RowError(`${key} 가 너무 깁니다.`);
      return text;
    }
  }
}

// ── 표 정의 ──────────────────────────────────────────────────────────────
const CORPUS: Record<"corpus_files" | "corpus_sheets" | "corpus_items" | "corpus_margin_items", { table: string; cols: Col[] }> = {
  corpus_files: { table: "quote_corpus_files", cols: [
    col("id", "int", { required: true }), col("file", "text", { required: true, max: 500 }),
    col("quote_date", "text", { max: 40 }), col("customer_from_name", "text", { max: 500 }), col("model_hint", "text", { max: 500 }),
    col("contact_from_name", "text", { max: 500 }), col("suffix", "text", { max: 500 }), col("mtime", "text", { max: 60 }),
    col("quote_json", "text", { max: 1_000_000 }), col("reverse_error", "text", { max: 120 }),
  ] },
  corpus_sheets: { table: "quote_corpus_sheets", cols: [
    col("id", "int", { required: true }), col("quote_id", "int", { required: true }), col("sheet_name", "text", { max: 200 }),
    col("is_margin", "bool", { required: true }),
    ...["customer", "contact", "tel", "email", "valid_weeks", "delivery", "payment", "place", "project", "staff", "staff_tel", "staff_email"].map((name) => col(name, "text", { max: 2000 })),
    col("has_set_col", "int"), col("header_row", "int"), col("subtotal", "real"), col("vat", "real"), col("total", "real"),
    col("remark", "text", { max: 20_000 }), col("n_items", "int"),
  ] },
  corpus_items: { table: "quote_corpus_items", cols: [
    col("id", "int", { required: true }), col("sheet_id", "int", { required: true }), col("row", "int"), col("no", "text", { max: 40 }),
    col("is_group", "bool"), col("category", "text", { max: 2000 }), col("spec", "text", { max: 20_000 }), col("spec_first_line", "text", { max: 2000 }),
    col("qty", "real"), col("sets", "real"), col("unit_price", "real"), col("amount", "real"),
  ] },
  corpus_margin_items: { table: "quote_corpus_margin_items", cols: [
    col("id", "int", { required: true }), col("sheet_id", "int", { required: true }), col("row", "int"),
    col("category", "text", { max: 2000 }), col("spec_first_line", "text", { max: 2000 }),
    col("qty", "real"), col("buy_unit", "real"), col("margin_rate", "real"), col("sell_unit", "real"),
  ] },
};

const CATALOG: Record<"catalog_products" | "catalog_legacy" | "spec_library" | "customers" | "bom_library", { table: string; cols: Col[] }> = {
  catalog_products: { table: "quote_catalog_products", cols: [
    col("canonical", "text", { required: true, max: 500 }), col("category", "text", { max: 200 }), col("kind", "text", { required: true, max: 20 }),
    col("keys_json", "json", { from: "keys" }), col("spellings_json", "json", { from: "spellings" }),
    col("n", "int"), col("min", "real"), col("max", "real"), col("last_price", "real"), col("last_date", "text", { max: 40 }), col("first_date", "text", { max: 40 }),
    col("note", "text", { max: 4000 }), col("caution", "text", { max: 4000 }), col("outliers_json", "json", { from: "outliers_excluded" }), col("history_json", "json", { from: "history" }),
  ] },
  catalog_legacy: { table: "quote_catalog_legacy", cols: [
    col("name", "text", { required: true, max: 2000 }), col("key", "text", { max: 2000 }), col("category", "text", { max: 200 }), col("n", "int"),
    col("last_date", "text", { max: 40 }), col("group_ratio", "real"), col("last_price", "real"), col("last_price_date", "text", { max: 40 }),
    col("price_history_json", "json", { from: "price_history" }),
  ] },
  spec_library: { table: "quote_spec_library", cols: [
    col("name", "text", { required: true, max: 2000 }), col("spec", "text", { required: true, max: 20_000 }), col("date", "text", { max: 40 }), col("category", "text", { max: 200 }),
  ] },
  customers: { table: "quote_customers", cols: [
    col("org", "text", { required: true, max: 500 }), col("contact", "text", { max: 500 }), col("tel", "text", { max: 200 }), col("email", "text", { max: 500 }),
    col("last_date", "text", { max: 40 }), col("n", "int"),
  ] },
  bom_library: { table: "quote_bom_library", cols: [
    col("sheet_id", "int"), col("file", "text", { max: 500 }), col("date", "text", { max: 40 }), col("customer", "text", { max: 500 }), col("sheet_name", "text", { max: 200 }),
    col("total", "real"), col("subtotal", "real"), col("system_label", "text", { max: 500 }), col("system_name", "text", { max: 2000 }),
    col("gpu_name", "text", { required: true, max: 2000 }), col("gpu_key", "text", { max: 2000 }), col("gpu_qty", "int", { required: true }),
    col("base_key", "text", { required: true, max: 2000 }), col("remark", "text", { max: 20_000 }), col("parts_json", "json", { from: "parts", required: true }),
    col("n_slots", "int", { required: true }), col("base_max_gpu", "int", { required: true }),
  ] },
};
/** NOT NULL DEFAULT 열만 원천 값이 null 일 때 기본값을 넣는다(다른 표의 같은 이름 열은 null 그대로). */
const NOT_NULL_DEFAULTS: Readonly<Record<string, Record<string, unknown>>> = {
  catalog_products: { keys_json: "[]", spellings_json: "[]", history_json: "[]", n: 0 },
  catalog_legacy: { price_history_json: "[]", n: 0, group_ratio: 0 },
};
const PRODUCT_KINDS = new Set(["part", "system", "license", "service", "junk"]);
const STATUSES = new Set(["draft", "confirmed", "discarded"]);
const PRICE_KINDS = new Set(["set", "item", "single"]);
const VOCAB_KEYS = ["group_labels", "categories", "remarks", "payment", "delivery"] as const;

const placeholders = (count: number, start = 1) => Array.from({ length: count }, (_, index) => `?${index + start}`).join(", ");

/** 옛 툴의 'YYYY-MM-DDTHH:MM:SS'(서버 지역 시각 = KST) → epoch ms(QD-18). 읽을 수 없으면 null. */
export function kstLocalToEpoch(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", sec = "0"] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)) - 9 * 3_600_000;
  return Number.isFinite(ms) ? ms : null;
}

function utf8Length(text: string) {
  return new TextEncoder().encode(text).length;
}

function planRow(table: ImportTable, row: Obj, ctx: PlanContext, ord: number): PlannedStatement {
  if (table in CORPUS) {
    const spec = CORPUS[table as keyof typeof CORPUS];
    const values = spec.cols.map((column) => value(row, column));
    if (table === "corpus_files" && typeof values[8] === "string") {
      try {
        if (!isObj(JSON.parse(values[8] as string))) throw new Error("not object");
      } catch {
        throw new RowError("quote_json 이 JSON 객체가 아닙니다.");
      }
    }
    const names = [...spec.cols.map((column) => column.name), "imported_at", "import_run_id"];
    return { sql: `INSERT INTO ${spec.table} (${names.join(", ")}) VALUES (${placeholders(names.length)}) ON CONFLICT(id) DO NOTHING`,
      binds: [...values, ctx.now, ctx.runId] };
  }
  if (table in CATALOG) {
    const spec = CATALOG[table as keyof typeof CATALOG];
    if (!ctx.version) throw new RowError("version 이 필요합니다.");
    const rowOrd = row.ord;
    if (typeof rowOrd !== "number" || !Number.isSafeInteger(rowOrd) || rowOrd < 0) throw new RowError("ord 는 0 이상의 정수입니다.");
    const defaults = NOT_NULL_DEFAULTS[table] ?? {};
    const values = spec.cols.map((column) => value(row, column) ?? defaults[column.name] ?? null);
    if (table === "catalog_products" && !PRODUCT_KINDS.has(String(values[2]))) throw new RowError("kind 값을 확인해 주세요.");
    const names = ["version", "ord", ...spec.cols.map((column) => column.name)];
    return { sql: `INSERT INTO ${spec.table} (${names.join(", ")}) VALUES (${placeholders(names.length)}) ON CONFLICT(version, ord) DO NOTHING`,
      binds: [ctx.version, rowOrd, ...values] };
  }
  switch (table) {
    case "vocab": {
      if (!ctx.version) throw new RowError("version 이 필요합니다.");
      const vocab: Record<string, string[]> = {};
      for (const key of VOCAB_KEYS) {
        const list = row[key];
        if (!Array.isArray(list) || list.length > 500 || !list.every((entry) => typeof entry === "string" && entry.length <= 500)) throw new RowError(`어휘 ${key} 를 확인해 주세요.`);
        vocab[key] = list as string[];
      }
      return { sql: "INSERT INTO quote_meta (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO NOTHING",
        binds: [`vocab:${ctx.version}`, JSON.stringify(vocab), ctx.now] };
    }
    case "issued": {
      const legacyId = value(row, col("id", "int", { required: true })) as number;
      const status = row.status === undefined || row.status === null ? null : String(row.status);
      if (status !== null && !STATUSES.has(status)) throw new RowError("status 값을 확인해 주세요.");
      const created = kstLocalToEpoch(row.created_at) ?? kstLocalToEpoch(row.issue_date) ?? ctx.now;
      const updated = kstLocalToEpoch(row.updated_at) ?? created;
      const quoteJson = value(row, col("quote_json", "text", { required: true, max: 1_000_000 })) as string;
      const issueDate = (value(row, col("issue_date", "text", { max: 40 })) as string | null) ?? new Date(created + 9 * 3_600_000).toISOString().slice(0, 10);
      const author = value(row, col("author", "text", { max: 200 })) as string | null;
      const dedupKey = value(row, col("dedup_key", "text", { max: 500 })) as string | null;
      const binds = [
        legacyId, created, updated, issueDate,
        value(row, col("filename", "text", { max: 500 })) ?? "",
        value(row, col("xlsx_path", "text", { max: 2000 })), value(row, col("pdf_path", "text", { max: 2000 })),
        value(row, col("customer", "text", { max: 500 })) ?? "", value(row, col("contact", "text", { max: 500 })) ?? "",
        value(row, col("model_hint", "text", { max: 500 })),
        value(row, col("subtotal", "real")) ?? 0, value(row, col("total", "real")) ?? 0, value(row, col("n_lines", "int")) ?? 0,
        quoteJson, author, author ?? "", value(row, col("author_host", "text", { max: 200 })),
        status, dedupKey, value(row, col("suffix", "text", { max: 200 })), ctx.now, ctx.runId,
      ];
      // ?19 = dedup_key. 앱 행과 dedup_key 가 겹치면 넣지 않는다(skipped). 앱에서 바꾼 행(app_modified_at)은 갱신하지 않는다.
      const sql = `INSERT INTO quote_issued (legacy_id, created_at, updated_at, issue_date, filename, legacy_xlsx_path, legacy_pdf_path, customer, contact, model_hint,
  subtotal, total, n_lines, quote_json, staff_name, author_name, legacy_author_host, status, dedup_key, suffix, imported_at, import_run_id)
SELECT ${placeholders(22)}
WHERE ?19 IS NULL OR NOT EXISTS (SELECT 1 FROM quote_issued x WHERE x.dedup_key = ?19 AND (x.legacy_id IS NULL OR x.legacy_id <> ?1))
ON CONFLICT(legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  status = excluded.status, updated_at = excluded.updated_at, quote_json = excluded.quote_json, filename = excluded.filename
WHERE quote_issued.app_modified_at IS NULL AND (quote_issued.status IS NOT excluded.status OR quote_issued.updated_at IS NOT excluded.updated_at
  OR quote_issued.quote_json IS NOT excluded.quote_json OR quote_issued.filename IS NOT excluded.filename)`;
      return { sql, binds, legacyId, dedupKey };
    }
    case "price_log": {
      const legacyId = value(row, col("id", "int", { required: true })) as number;
      const kind = String(value(row, col("kind", "text", { required: true, max: 20 })));
      if (!PRICE_KINDS.has(kind)) throw new RowError("kind 값을 확인해 주세요.");
      const status = row.status === undefined || row.status === null ? null : String(row.status);
      if (status !== null && !STATUSES.has(status)) throw new RowError("status 값을 확인해 주세요.");
      const binds = [
        legacyId, value(row, col("issued_id", "int", { required: true })),
        value(row, col("issue_date", "text", { max: 40 })), value(row, col("customer", "text", { max: 500 })), kind,
        value(row, col("category", "text", { max: 2000 })), value(row, col("name", "text", { max: 2000 })), value(row, col("name_key", "text", { max: 2000 })),
        value(row, col("qty", "real")), value(row, col("unit_price", "real")), status, ctx.now, ctx.runId,
      ];
      // issued_id 는 옛 id 다. 이전한 발행 행(legacy_id)으로 다시 잇는다. 부모가 없으면 넣지 않는다(skipped).
      const sql = `INSERT INTO quote_price_log (legacy_id, issued_id, issue_date, customer, kind, category, name, name_key, qty, unit_price, status, imported_at, import_run_id)
SELECT ?1, p.id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13 FROM quote_issued p WHERE p.legacy_id = ?2
ON CONFLICT(legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET status = excluded.status
WHERE quote_price_log.status IS NOT excluded.status
  AND (SELECT app_modified_at FROM quote_issued WHERE id = quote_price_log.issued_id) IS NULL`;
      return { sql, binds, legacyId };
    }
    case "staff": {
      const name = String(value(row, col("name", "text", { required: true, max: 40 }))).trim();
      if (!name) throw new RowError("name 값이 없습니다.");
      const tel = (value(row, col("tel", "text", { max: 40 })) as string | null) ?? "";
      const email = (value(row, col("email", "text", { max: 120 })) as string | null) ?? "";
      return { sql: `INSERT INTO quote_staff_profiles (id, name, tel, email, account_id, sort, active, legacy, created_by, created_at, updated_at)
SELECT ?1, ?2, ?3, ?4, NULL, ?5, 1, 1, 'import', ?6, ?6
WHERE NOT EXISTS (SELECT 1 FROM quote_staff_profiles WHERE name = ?2 AND active = 1)`,
      binds: [`qsp_${ctx.newId()}`, name, tel, email, ord, ctx.now] };
    }
    case "source_snapshots": {
      const name = String(value(row, col("name", "text", { required: true, max: 120 })));
      if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/.test(name)) throw new RowError("name 값을 확인해 주세요.");
      const version = String(value(row, col("version", "text", { required: true, max: 64 })));
      if (!VERSION_RE.test(version)) throw new RowError("version 은 sha256 입니다.");
      const part = value(row, col("part", "int", { required: true })) as number;
      const partCount = value(row, col("part_count", "int", { required: true })) as number;
      if (partCount < 1 || partCount > 100 || part < 0 || part >= partCount) throw new RowError("part 값을 확인해 주세요.");
      const body = row.body;
      if (typeof body !== "string" || utf8Length(body) > SNAPSHOT_PART_BYTES) throw new RowError("body 는 1,000,000바이트 이하의 문자열입니다.");
      return { sql: `INSERT INTO quote_source_snapshots (name, version, part, part_count, body, imported_at, import_run_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT(name, version, part) DO NOTHING`, binds: [name, version, part, partCount, body, ctx.now, ctx.runId] };
    }
    default:
      throw new RowError("알 수 없는 표입니다.");
  }
}

/** 한 묶음(≤500행)의 문을 만든다. 한 행이라도 틀리면 그 위치와 이유로 거부한다(전부 또는 없음). */
export function planImportRows(table: ImportTable, rows: unknown[], ctx: PlanContext): PlanResult {
  if (rows.length > IMPORT_MAX_ROWS) return { ok: false, index: -1, error: `한 번에 ${IMPORT_MAX_ROWS}행까지입니다.` };
  if (VERSIONED_TABLES[table] && (!ctx.version || !VERSION_RE.test(ctx.version))) return { ok: false, index: -1, error: "version(원천 sha256)이 필요합니다." };
  const statements: PlannedStatement[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!isObj(row)) return { ok: false, index, error: "행을 읽을 수 없습니다." };
    try {
      const sort = typeof row.sort === "number" && Number.isSafeInteger(row.sort) ? row.sort : index;
      statements.push(planRow(table, row, ctx, sort));
    } catch (error) {
      if (error instanceof RowError) return { ok: false, index, error: error.message };
      throw error;
    }
  }
  return { ok: true, statements };
}

// ── 대조(FINISH)·바꿔 끼우기(ACTIVATE) ─────────────────────────────────────
/** 표 키 → 행 수 SQL. version 이 필요한 것은 ?1 에 현재 version 을 넣는다. */
export const COUNT_SQL: Readonly<Record<string, { sql: string; source?: SourceKey }>> = {
  corpus_files: { sql: "SELECT COUNT(*) AS n FROM quote_corpus_files" },
  corpus_sheets: { sql: "SELECT COUNT(*) AS n FROM quote_corpus_sheets" },
  corpus_items: { sql: "SELECT COUNT(*) AS n FROM quote_corpus_items" },
  corpus_margin_items: { sql: "SELECT COUNT(*) AS n FROM quote_corpus_margin_items" },
  issued: { sql: "SELECT COUNT(*) AS n FROM quote_issued WHERE legacy_id IS NOT NULL" },
  price_log: { sql: "SELECT COUNT(*) AS n FROM quote_price_log WHERE legacy_id IS NOT NULL" },
  catalog_products: { sql: "SELECT COUNT(*) AS n FROM quote_catalog_products WHERE version = ?1", source: "catalog_v2" },
  catalog_legacy: { sql: "SELECT COUNT(*) AS n FROM quote_catalog_legacy WHERE version = ?1", source: "catalog" },
  spec_library: { sql: "SELECT COUNT(*) AS n FROM quote_spec_library WHERE version = ?1", source: "catalog" },
  customers: { sql: "SELECT COUNT(*) AS n FROM quote_customers WHERE version = ?1", source: "catalog" },
  customer_orgs: { sql: "SELECT COUNT(DISTINCT org) AS n FROM quote_customers WHERE version = ?1", source: "catalog" },
  bom_library: { sql: "SELECT COUNT(*) AS n FROM quote_bom_library WHERE version = ?1", source: "bom_library" },
  staff: { sql: "SELECT COUNT(*) AS n FROM quote_staff_profiles WHERE legacy = 1" },
};

/** ACTIVATE 때 원천별로 행 수를 맞춰 볼 표 키. */
export const SOURCE_COUNT_KEYS: Readonly<Record<SourceKey, readonly string[]>> = {
  catalog_v2: ["catalog_products"],
  catalog: ["catalog_legacy", "spec_library", "customers", "customer_orgs"],
  bom_library: ["bom_library"],
};

export type ImportSource = {
  files: Record<string, string>;
  counts: Record<string, number>;
  snapshots: Record<string, string>;
  lastLegacyIssuedId: number | null;
};

/** BEGIN 의 source(manifest 요약) 검증. 값은 이름·sha256·수뿐이다. */
export function parseImportSource(raw: unknown): ImportSource | null {
  if (!isObj(raw)) return null;
  const files = isObj(raw.files) ? raw.files : {};
  const counts = isObj(raw.counts) ? raw.counts : {};
  const snapshots = isObj(raw.snapshots) ? raw.snapshots : {};
  const nameOk = (name: string) => name.length <= 200 && /^[\w./-]+$/.test(name);
  if (Object.keys(files).length > 100 || Object.keys(snapshots).length > 50) return null;
  for (const [name, sha] of [...Object.entries(files), ...Object.entries(snapshots)]) if (!nameOk(name) || typeof sha !== "string" || !VERSION_RE.test(sha)) return null;
  for (const [key, count] of Object.entries(counts)) if (!(key in COUNT_SQL) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
  const last = raw.lastLegacyIssuedId;
  if (last !== undefined && last !== null && (typeof last !== "number" || !Number.isSafeInteger(last))) return null;
  return { files: files as Record<string, string>, counts: counts as Record<string, number>, snapshots: snapshots as Record<string, string>, lastLegacyIssuedId: (last as number | null) ?? null };
}
