import "server-only";

// 견적 쓰기 문 빌더(quote-tool Design §3.3·§3.4, QD-3·QD-5·QD-6·QD-7·QD-8). 순수 문 생성만 하고 실행은 라우트가 db.batch 로 한다.
// 발행 행의 모든 변경은 요청마다 새 op_token 을 쓰고, 뒤따르는 문(단가 로그 삭제·삽입, 변경 행 조회)은 WHERE op_token = ? 로 건다.
// RETURNING 을 쓰지 않는다(확정 보호로 upsert 가 아무것도 바꾸지 않았는지 batch 안에서 판정하고, 하니스 batch 와도 맞춘다).
import type { PriceLogRow } from "./quote-dedup";

export const QUOTE_STATUSES = ["draft", "confirmed", "discarded"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const isQuoteStatus = (value: unknown): value is QuoteStatus => typeof value === "string" && (QUOTE_STATUSES as readonly string[]).includes(value);
/** 한 번에 바꿀 수 있는 발행 행 수(옛 main.py:218). */
export const STATUS_MAX_IDS = 500;

export type IssuedUpsertInput = {
  now: number; issueDate: string; filename: string; customer: string; contact: string; modelHint: string | null;
  subtotal: number; total: number; nLines: number; quoteJson: string; staffName: string | null;
  authorAccountId: string; authorName: string; dedupKey: string; suffix: string | null; op: string; priceRows: PriceLogRow[];
};

/**
 * GENERATE 의 기록 batch(§3.3 ⑤). ① upsert(확정 행은 초안이 덮지 못한다: WHERE 가 거르면 아무것도 바뀌지 않고 op_token 도 그대로다)
 * ② 재적재 전 정리 ③ 단가 로그 행마다 INSERT … SELECT(상태는 upsert 뒤 발행 행의 실제 상태를 복사, QD-6).
 * 내용이 바뀐 재생성은 file_rev 를 1 올리고 pdf_key 를 비운다(QD-7). 옛 파일은 지우지 않는다.
 * 확정 보호는 status NULL(이전한 옛 행 = confirmed, §2.3)도 확정으로 본다(옛 `IS NOT 'confirmed'` 는 NULL 행을 초안이 덮었다).
 */
export function issuedUpsertStatements(db: D1Database, input: IssuedUpsertInput): D1PreparedStatement[] {
  const upsert = db.prepare(`INSERT INTO quote_issued (created_at, updated_at, issue_date, filename, customer, contact, model_hint, subtotal, total, n_lines,
  quote_json, staff_name, author_account_id, author_name, status, dedup_key, suffix, op_token, file_rev, app_modified_at)
VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'draft', ?14, ?15, ?16, 1, ?1)
ON CONFLICT(dedup_key) WHERE dedup_key IS NOT NULL DO UPDATE SET
  updated_at = excluded.updated_at, filename = excluded.filename, quote_json = excluded.quote_json,
  subtotal = excluded.subtotal, total = excluded.total, n_lines = excluded.n_lines, contact = excluded.contact,
  status = CASE WHEN excluded.status = 'confirmed' THEN 'confirmed' ELSE quote_issued.status END,
  op_token = excluded.op_token, file_rev = quote_issued.file_rev + 1, pdf_key = NULL,
  app_modified_at = excluded.app_modified_at
WHERE COALESCE(quote_issued.status, 'confirmed') <> 'confirmed' OR excluded.status = 'confirmed'`).bind(
    input.now, input.issueDate, input.filename, input.customer, input.contact, input.modelHint, input.subtotal, input.total, input.nLines,
    input.quoteJson, input.staffName, input.authorAccountId, input.authorName, input.dedupKey, input.suffix, input.op,
  );
  const cleanup = db.prepare(`DELETE FROM quote_price_log WHERE issued_id IN (SELECT id FROM quote_issued WHERE op_token = ?1)`).bind(input.op);
  const inserts = input.priceRows.map((row) => db.prepare(`INSERT INTO quote_price_log (issued_id, issue_date, customer, kind, category, name, name_key, qty, unit_price, status)
  SELECT id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, status FROM quote_issued WHERE op_token = ?1`).bind(
    input.op, input.issueDate, input.customer, row.kind, row.category, row.name, row.name_key, row.qty, row.unit_price,
  ));
  return [upsert, cleanup, ...inserts];
}

/** GENERATE 뒤 행 조회(§3.3 ⑥). op_token 이 우리 것이 아니면 확정 보호로 아무것도 바뀌지 않은 것이다(QD-8). */
export const ISSUED_BY_DEDUP_SQL = `SELECT id, created_at, file_rev, COALESCE(status, 'confirmed') AS status, op_token, xlsx_key, pdf_key, filename
  FROM quote_issued WHERE dedup_key = ?1`;

/**
 * 상태 전이(§3.4). 단가 로그를 먼저 바꾼다(발행 행이 바뀌면 조건이 거짓이 된다). ids 는 JSON 배열 하나로 bind 한다(D1 bind 100개 상한 회피).
 * 이미 그 상태인 행은 바꾸지 않는다(changed 에 세지 않는다). 뒤이어 changedIdsStatement 로 바뀐 id 를 읽는다.
 */
export function statusStatements(db: D1Database, ids: number[], status: QuoteStatus, now: number, op: string): D1PreparedStatement[] {
  const list = JSON.stringify(ids);
  return [
    db.prepare(`UPDATE quote_price_log SET status = ?1
  WHERE issued_id IN (SELECT id FROM quote_issued WHERE id IN (SELECT value FROM json_each(?2)) AND COALESCE(status, 'confirmed') <> ?1)`).bind(status, list),
    db.prepare(`UPDATE quote_issued SET status = ?1, updated_at = ?3, op_token = ?4, app_modified_at = ?3
  WHERE id IN (SELECT value FROM json_each(?2)) AND COALESCE(status, 'confirmed') <> ?1`).bind(status, list, now, op),
  ];
}

export const changedIdsStatement = (db: D1Database, op: string) => db.prepare(`SELECT id FROM quote_issued WHERE op_token = ?1 ORDER BY id`).bind(op);

/** R2 키(QT-Q1): 기관명·파일명이 없다. */
export const issuedFileKey = (issuedId: number, rev: number, kind: "xlsx" | "pdf") => `quote/issued/${issuedId}/${rev}.${kind}`;
