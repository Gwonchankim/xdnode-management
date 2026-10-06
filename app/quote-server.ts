import "server-only";

// 견적 서버 공용(quote-tool Design §1.2·§3.1, QD-3). 읽기 전용 조회·오류 헬퍼·본문 상한만 둔다. 쓰기 문 빌더는 quote-store.ts(QT2)·quote-import.ts 가 맡는다.
// 고객 연락처·과거 견적은 서버에서만 다룬다. 이 파일을 클라이언트에서 import 하면 빌드가 실패한다(server-only).
import { erpError, type ErpPrincipal } from "./erp-platform";
import { XLSX_MIME, inspectTemplate, loadTemplate, sha256Hex, unzipTemplate, type TemplateModel } from "./quote-xlsx";

/** dist/client 에 이 문자열이 있으면 서버 모듈이 번들에 새어 나간 것이다(tests/bundle-exposure). */
export const QUOTE_SERVER_MARKER = "xdm-quote-server-only";

// ── 오류(erpError 형식, §3.1-3) ─────────────────────────────────────────
export const quoteValidation = (error: string, field?: string) => erpError(400, "VALIDATION", error, field ? { field } : {});
export const quoteNotFound = (error = "견적을 찾을 수 없습니다.") => erpError(404, "NOT_FOUND", error);
export const quoteConflict = (error = "다른 사용자가 먼저 바꿨습니다. 새로고침해 주세요.", extra: Record<string, unknown> = {}) => erpError(409, "CONFLICT", error, extra);
export const lengthRequired = () => erpError(411, "LENGTH_REQUIRED", "요청 크기를 확인할 수 없습니다.");
export const payloadTooLarge = (limitLabel: string) => erpError(413, "PAYLOAD_TOO_LARGE", `요청은 ${limitLabel}까지 보낼 수 있습니다.`);
export const unsupportedMedia = (error = "올릴 수 없는 파일 형식입니다.") => erpError(415, "UNSUPPORTED_MEDIA_TYPE", error);

const sizeLabel = (bytes: number) => (bytes >= 1_048_576 ? `${Math.round(bytes / 1_048_576)}MB` : `${Math.round(bytes / 1024)}KB`);

function declaredLength(request: Request) {
  const text = request.headers.get("content-length");
  if (!text || !/^\d{1,12}$/.test(text.trim())) return null;
  return Number(text.trim());
}

/**
 * JSON 본문 읽기(§3.1-2). Content-Length 가 없으면 411, cap 초과면 413(본문을 읽기 전). 읽은 뒤 UTF-8 바이트 길이를 다시 본다.
 * JSON 이 아니거나 객체가 아니면 400 VALIDATION.
 */
export async function readJsonCapped(request: Request, cap: number): Promise<{ body: Record<string, unknown>; response?: never } | { body?: never; response: Response }> {
  const declared = declaredLength(request);
  if (declared === null) return { response: lengthRequired() };
  if (declared > cap) return { response: payloadTooLarge(sizeLabel(cap)) };
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > cap) return { response: payloadTooLarge(sizeLabel(cap)) };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { body: parsed as Record<string, unknown> };
  } catch {
    // 아래에서 400
  }
  return { response: quoteValidation("요청 내용을 읽을 수 없습니다.") };
}

/** 원시 본문(템플릿 PUT). 411·413 은 readJsonCapped 와 같다. */
export async function readBytesCapped(request: Request, cap: number): Promise<{ bytes: Uint8Array; response?: never } | { bytes?: never; response: Response }> {
  const declared = declaredLength(request);
  if (declared === null) return { response: lengthRequired() };
  if (declared > cap) return { response: payloadTooLarge(sizeLabel(cap)) };
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > cap) return { response: payloadTooLarge(sizeLabel(cap)) };
  return { bytes };
}

/** 보기 권한(비관리자, quote=view)은 Quote JSON 의 margin 을 받지 않는다(QT-Q12). */
export function canSeeMargin(principal: Pick<ErpPrincipal, "isAdmin" | "tabs">) {
  return principal.isAdmin === true || principal.tabs.quote === "edit";
}

// ── 검색·목록(QT-FR-10, §13.2 P-9) ───────────────────────────────────────
/** LIKE 의 %·_·\ 를 글자로 취급한다(ESCAPE '\'). */
export function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export type HistoryRow = {
  source: "issued" | "file"; id: number; file: string; quote_date: string | null; customer: string | null; contact: string | null;
  model_hint: string | null; total: number | null; n_items: number | null; sheet_name: string | null; status: string | null;
};

// 옛 store.search_history 와 같은 랭킹(1 고객명·모델힌트, 2 담당자·파일명·작성자, 3 사양)·통합 날짜 정렬.
// 옛 SQL 의 GROUP BY qq.id 는 집계 없는 열을 임의 시트에서 골랐다(비결정적). 여기서는 같은 파일의 시트 중 순위가 가장 높은(같으면 id 가 작은)
// 시트 하나를 ROW_NUMBER() 로 고른다(P-9). 사양 일치는 문자열로 붙인 IN (…) 대신 서브쿼리다.
const HITS_SQL = `
WITH spec_hits AS (
  SELECT DISTINCT sheet_id FROM quote_corpus_items WHERE ?1 <> '' AND spec_first_line LIKE ?2 ESCAPE '\\'
),
issued_hits AS (
  SELECT 'issued' AS source, i.id AS id, i.filename AS file, i.issue_date AS quote_date, i.customer AS customer, i.contact AS contact,
    i.model_hint AS model_hint, i.total AS total, i.n_lines AS n_items, NULL AS sheet_name, COALESCE(i.status, 'confirmed') AS status,
    CASE WHEN i.customer LIKE ?2 ESCAPE '\\' OR i.model_hint LIKE ?2 ESCAPE '\\' THEN 1
         WHEN i.contact LIKE ?2 ESCAPE '\\' OR i.filename LIKE ?2 ESCAPE '\\' OR i.staff_name LIKE ?2 ESCAPE '\\' OR i.author_name LIKE ?2 ESCAPE '\\' THEN 2
         ELSE 3 END AS rk
  FROM quote_issued i
  WHERE ?1 = '' OR i.customer LIKE ?2 ESCAPE '\\' OR i.contact LIKE ?2 ESCAPE '\\' OR i.filename LIKE ?2 ESCAPE '\\'
     OR i.model_hint LIKE ?2 ESCAPE '\\' OR i.staff_name LIKE ?2 ESCAPE '\\' OR i.author_name LIKE ?2 ESCAPE '\\'
),
file_ranked AS (
  SELECT 'file' AS source, f.id AS id, f.file AS file, f.quote_date AS quote_date, s.customer AS customer, s.contact AS contact,
    f.model_hint AS model_hint, s.total AS total, s.n_items AS n_items, s.sheet_name AS sheet_name, NULL AS status,
    CASE WHEN s.customer LIKE ?2 ESCAPE '\\' OR f.model_hint LIKE ?2 ESCAPE '\\' THEN 1
         WHEN s.contact LIKE ?2 ESCAPE '\\' OR f.file LIKE ?2 ESCAPE '\\' THEN 2
         ELSE 3 END AS rk,
    s.id AS sheet_id
  FROM quote_corpus_files f JOIN quote_corpus_sheets s ON s.quote_id = f.id
  WHERE s.is_margin = 0 AND (?1 = '' OR s.customer LIKE ?2 ESCAPE '\\' OR s.contact LIKE ?2 ESCAPE '\\' OR f.file LIKE ?2 ESCAPE '\\'
     OR f.model_hint LIKE ?2 ESCAPE '\\' OR s.id IN (SELECT sheet_id FROM spec_hits))
),
file_hits AS (
  SELECT source, id, file, quote_date, customer, contact, model_hint, total, n_items, sheet_name, status, rk FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY rk, sheet_id) AS rn FROM file_ranked
  ) WHERE rn = 1
),
hits AS (
  SELECT source, id, file, quote_date, customer, contact, model_hint, total, n_items, sheet_name, status, rk FROM issued_hits
  UNION ALL
  SELECT source, id, file, quote_date, customer, contact, model_hint, total, n_items, sheet_name, status, rk FROM file_hits
)`;

export async function searchHistory(db: D1Database, q: string, limit: number, offset: number) {
  const pattern = likePattern(q);
  const [rows, count] = await Promise.all([
    db.prepare(`${HITS_SQL}
SELECT source, id, file, quote_date, customer, contact, model_hint, total, n_items, sheet_name, status FROM hits
ORDER BY rk, quote_date DESC, id DESC LIMIT ?3 OFFSET ?4`).bind(q, pattern, limit, offset).all<HistoryRow>(),
    db.prepare(`${HITS_SQL}
SELECT COUNT(*) AS n FROM hits`).bind(q, pattern).first<{ n: number }>(),
  ]);
  return { rows: rows.results, total: Number(count?.n ?? 0) };
}

export type RecentRow = {
  id: number; created_at: number; issue_date: string; filename: string; customer: string; contact: string; model_hint: string | null;
  total: number; n_lines: number; status: string; author_name: string; xlsx_key: string | null; pdf_key: string | null;
};

const RECENT_COLUMNS = `id, created_at, issue_date, filename, customer, contact, model_hint, total, n_lines,
  COALESCE(status, 'confirmed') AS status, author_name, xlsx_key, pdf_key`;

function recentDto(row: RecentRow) {
  const { xlsx_key: xlsxKey, pdf_key: pdfKey, ...rest } = row;
  return { source: "issued" as const, ...rest, files: { xlsx: Boolean(xlsxKey), pdf: Boolean(pdfKey) } };
}

/** 최근 작성 견적(id 내림차순). */
export async function recentIssued(db: D1Database, limit: number) {
  const rows = await db.prepare(`SELECT ${RECENT_COLUMNS} FROM quote_issued ORDER BY id DESC LIMIT ?1`).bind(limit).all<RecentRow>();
  return rows.results.map(recentDto);
}

/** 미확정(draft) 견적, 오래된 것부터(옛 pending_drafts: 밀린 것을 치우는 화면). */
export async function pendingDrafts(db: D1Database, limit: number) {
  const rows = await db.prepare(`SELECT ${RECENT_COLUMNS} FROM quote_issued WHERE COALESCE(status, 'confirmed') = 'draft'
    ORDER BY issue_date ASC, id ASC LIMIT ?1`).bind(limit).all<RecentRow>();
  return rows.results.map(recentDto);
}

export async function countDrafts(db: D1Database) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM quote_issued WHERE COALESCE(status, 'confirmed') = 'draft'`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

// ── 설정(quote_meta) ─────────────────────────────────────────────────────
export async function readQuoteMeta(db: D1Database, keys: readonly string[]) {
  if (!keys.length) return new Map<string, string>();
  const rows = await db.prepare(`SELECT key, value FROM quote_meta WHERE key IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(keys)).all<{ key: string; value: string }>();
  return new Map(rows.results.map((row) => [row.key, row.value]));
}

// ── 템플릿(R2, QT-Q2, §8) ───────────────────────────────────────────────
export const TEMPLATE_PREFIX = "quote/template/";
export const TEMPLATE_MAX_BYTES = 5 * 1_048_576;
export type TemplateLoad = { ok: true; bytes: Uint8Array; sha256: string; key: string } | { ok: false; code: "TEMPLATE_MISSING" | "TEMPLATE_INVALID" };

/** quote_meta 의 template:key 로 R2 를 읽고 sha256·구조를 확인한다. 없으면 TEMPLATE_MISSING, 해시·구조가 다르면 TEMPLATE_INVALID. */
export async function loadTemplateFromR2(db: D1Database, bucket: R2Bucket | undefined): Promise<TemplateLoad> {
  const meta = await readQuoteMeta(db, ["template:key", "template:sha256"]);
  const key = meta.get("template:key");
  const expected = meta.get("template:sha256");
  if (!key || !expected || !bucket) return { ok: false, code: "TEMPLATE_MISSING" };
  const object = await bucket.get(key);
  if (!object) return { ok: false, code: "TEMPLATE_MISSING" };
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(bytes) !== expected) return { ok: false, code: "TEMPLATE_INVALID" };
  const files = unzipTemplate(bytes);
  if (!files || !inspectTemplate(files).ok) return { ok: false, code: "TEMPLATE_INVALID" };
  return { ok: true, bytes, sha256: expected, key };
}

// ── 로컬 도우미 상태(§1.1, QD-17). 브라우저는 도우미를 직접 부르지 않는다. 사용 가능/불가만 알려 준다. ──
export const DEFAULT_QUOTE_BRIDGE_URL = "http://127.0.0.1:3140";
export const DEFAULT_QUOTE_PDF_HELPER_URL = "http://127.0.0.1:3150";

export async function helperAvailable(baseUrl: string, timeoutMs = 800) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

// ── 템플릿 모델 캐시(§3.3-3): 같은 sha 면 다시 풀지 않는다. R2 본문 해시는 생성마다 loadTemplateFromR2 가 확인한다. ──
let templateCache: { sha256: string; model: TemplateModel } | null = null;
export type TemplateModelLoad = { ok: true; model: TemplateModel } | { ok: false; code: "TEMPLATE_MISSING" | "TEMPLATE_INVALID" };

export async function loadTemplateModel(db: D1Database, bucket: R2Bucket | undefined): Promise<TemplateModelLoad> {
  const loaded = await loadTemplateFromR2(db, bucket);
  if (!loaded.ok) return loaded;
  if (templateCache?.sha256 === loaded.sha256) return { ok: true, model: templateCache.model };
  try {
    const model = await loadTemplate(loaded.bytes, loaded.sha256);
    templateCache = { sha256: loaded.sha256, model };
    return { ok: true, model };
  } catch {
    return { ok: false, code: "TEMPLATE_INVALID" };
  }
}

/** 하니스 전용: 테스트마다 템플릿 캐시를 비운다. */
export function resetQuoteTemplateCache() {
  templateCache = null;
}

// ── PDF 도우미(§6.1, QT-FR-07). 실패해도 xlsx·기록은 남는다. 도우미 주소는 라우트 기본값(QD-17). ──
export type PdfErrorCode = "PDF_BUSY" | "PDF_TIMEOUT" | "PDF_UNAVAILABLE" | "PDF_FAILED";
export const PDF_ERRORS: Record<PdfErrorCode, { status: number; message: string }> = {
  PDF_BUSY: { status: 429, message: "PDF 도우미가 바쁩니다. 잠시 후 다시 만들어 주세요." },
  PDF_TIMEOUT: { status: 504, message: "PDF를 만드는 시간이 초과되었습니다." },
  PDF_UNAVAILABLE: { status: 502, message: "PDF 도우미에 연결하지 못했습니다." },
  PDF_FAILED: { status: 502, message: "PDF를 만들지 못했습니다." },
};
export const PDF_TIMEOUT_MS = 90_000;
export type PdfResult = { ok: true; bytes: Uint8Array; pages: number | null; ms: number } | { ok: false; code: PdfErrorCode; ms: number };

/** POST <helper>/pdf (본문 = xlsx, X-Quote-Sheet = 시트명). 429 → BUSY, 504·시간 초과 → TIMEOUT, 연결 실패 → UNAVAILABLE, 그 밖 → FAILED. */
export async function requestPdf(baseUrl: string, xlsx: Uint8Array, sheetName: string, timeoutMs = PDF_TIMEOUT_MS): Promise<PdfResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/pdf`, {
      method: "POST",
      headers: { "Content-Type": XLSX_MIME, "X-Quote-Sheet": encodeURIComponent(sheetName) },
      body: xlsx,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return { ok: false, code: name === "TimeoutError" || name === "AbortError" ? "PDF_TIMEOUT" : "PDF_UNAVAILABLE", ms: elapsed() };
  }
  if (response.status === 429) return { ok: false, code: "PDF_BUSY", ms: elapsed() };
  if (response.status === 504) return { ok: false, code: "PDF_TIMEOUT", ms: elapsed() };
  if (!response.ok) return { ok: false, code: "PDF_FAILED", ms: elapsed() };
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") return { ok: false, code: "PDF_FAILED", ms: elapsed() };
    const pages = Number(response.headers.get("x-pdf-pages"));
    return { ok: true, bytes, pages: Number.isFinite(pages) && pages > 0 ? pages : null, ms: elapsed() };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return { ok: false, code: name === "TimeoutError" || name === "AbortError" ? "PDF_TIMEOUT" : "PDF_FAILED", ms: elapsed() };
  }
}

/** 기록·저장 실패 때 응답에 싣는 xlsx(base64, Worker 에는 Buffer 가 없다). */
export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
