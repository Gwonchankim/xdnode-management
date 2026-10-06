import { env } from "cloudflare:workers";
import { authorizeErpRequest, erpError, writeErpAudit, type ErpPrincipal } from "../../../erp-platform";
import { ensureQuoteSchema } from "../../../quote-schema";
import { normalizeQuote, kstToday, cleanText, serializeQuote, subtotal, parseStoredQuote } from "../../../quote-model";
import { quoteFilename } from "../../../quote-filename";
import { dedupKey, priceLogRows } from "../../../quote-dedup";
import { buildQuoteXlsx, XLSX_MIME } from "../../../quote-xlsx";
import { pyLen, pyRoundInt, pyStrip } from "../../../quote-pyfmt";
import {
  DEFAULT_QUOTE_PDF_HELPER_URL, PDF_ERRORS, bytesToBase64, countDrafts, loadTemplateModel, quoteNotFound, quoteValidation, readJsonCapped, requestPdf,
  type PdfErrorCode,
} from "../../../quote-server";
import {
  ISSUED_BY_DEDUP_SQL, STATUS_MAX_IDS, changedIdsStatement, isQuoteStatus, issuedFileKey, issuedUpsertStatements, statusStatements,
} from "../../../quote-store";

// quote-tool Design §3.2~§3.4 POST /api/quote/issued (quote:write).
//   GENERATE        검증 → xlsx 조립(메모리) → D1 batch(발행 행 upsert + 단가 로그) → R2 xlsx → xlsx_key → PDF(QD-4·QD-5)
//   REGENERATE_PDF  저장된 xlsx 로 PDF 만 다시 만든다
//   CONFIRM         마지막 생성 id + 현재 화면 견적. dedup_key 가 같으면 확정, 다르면 409 STALE(QD-9)
//   SET_STATUS      draft·confirmed·discarded 전이(≤500건), 단가 로그도 같은 batch 에서(QT-FR-09)
// 감사 after 에는 id·건수·합계·상태만 넣는다. 고객명·연락처·단가·파일명은 넣지 않는다(QT-FR-17).
const bindings = env as unknown as { DB: D1Database; HR_AUDIO: R2Bucket; QUOTE_PDF_HELPER_URL?: string };
const db = bindings.DB;
const BODY_CAP = 1_048_576;
const SUFFIX_MAX = 40;

const pdfHelperUrl = () => bindings.QUOTE_PDF_HELPER_URL || DEFAULT_QUOTE_PDF_HELPER_URL;

type IssuedRow = { id: number; created_at: number; file_rev: number; status: string; op_token: string | null; xlsx_key: string | null; pdf_key: string | null; filename: string };

/** 접미: 문자열, 파일명 금지문자 제거, 40자(코드 포인트). 비면 null. */
function readSuffix(value: unknown): { suffix: string | null } | { error: Response } {
  if (value === undefined || value === null) return { suffix: null };
  if (typeof value !== "string") return { error: quoteValidation("파일 접미를 확인해 주세요.", "suffix") };
  const cleaned = pyStrip(cleanText(value).replace(/[\\/:*?"<>|\n]/g, ""));
  if (pyLen(cleaned) > SUFFIX_MAX) return { error: quoteValidation(`파일 접미는 ${SUFFIX_MAX}자까지입니다.`, "suffix") };
  return { suffix: cleaned || null };
}

function readId(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** PDF 를 만들어 R2 에 두고 pdf_key 를 건다(file_rev 가 그대로일 때만). 감사 QUOTE_PDF_CREATED / QUOTE_PDF_FAILED. */
async function makePdf(principal: ErpPrincipal, issuedId: number, rev: number, xlsx: Uint8Array, sheetName: string): Promise<{ ok: true } | { ok: false; code: PdfErrorCode }> {
  const result = await requestPdf(pdfHelperUrl(), xlsx, sheetName);
  if (!result.ok) {
    await writeErpAudit(db, { principal, module: "quote", action: "QUOTE_PDF_FAILED", entityType: "QUOTE_ISSUED", entityId: String(issuedId), after: { issuedId, rev, code: result.code } });
    return { ok: false, code: result.code };
  }
  const key = issuedFileKey(issuedId, rev, "pdf");
  try {
    await bindings.HR_AUDIO.put(key, result.bytes, { httpMetadata: { contentType: "application/pdf" } });
  } catch {
    await writeErpAudit(db, { principal, module: "quote", action: "QUOTE_PDF_FAILED", entityType: "QUOTE_ISSUED", entityId: String(issuedId), after: { issuedId, rev, code: "PDF_FAILED" } });
    return { ok: false, code: "PDF_FAILED" };
  }
  await db.prepare(`UPDATE quote_issued SET pdf_key = ?1 WHERE id = ?2 AND file_rev = ?3`).bind(key, issuedId, rev).run();
  await writeErpAudit(db, { principal, module: "quote", action: "QUOTE_PDF_CREATED", entityType: "QUOTE_ISSUED", entityId: String(issuedId), after: { issuedId, rev, ms: result.ms, pages: result.pages } });
  return { ok: true };
}

const pdfErrorBody = (code: PdfErrorCode) => ({ code, message: PDF_ERRORS[code].message });

async function generate(principal: ErpPrincipal, body: Record<string, unknown>) {
  const normalized = normalizeQuote(body.quote);
  if (!normalized.ok) return quoteValidation(normalized.error, normalized.field);
  const suffixRead = readSuffix(body.suffix);
  if ("error" in suffixRead) return suffixRead.error;
  const { suffix } = suffixRead;
  const now = Date.now();
  const issueDate = normalized.quote.issue_date ?? kstToday(now);
  const quote = { ...normalized.quote, issue_date: issueDate };
  const filename = quoteFilename(quote, suffix);
  const staffName = quote.staff.name || null;
  const key = await dedupKey(quote, issueDate, staffName, suffix, body.quote);

  const template = await loadTemplateModel(db, bindings.HR_AUDIO);
  if (!template.ok) return erpError(503, template.code, "견적서 양식이 없거나 손상되었습니다. 관리자에게 알려 주세요.");
  let xlsx: Uint8Array;
  try {
    xlsx = buildQuoteXlsx({ template: template.model, quote, issueDate, withMargin: true, now }).bytes;
  } catch {
    return erpError(500, "XLSX_FAILED", "엑셀 파일을 만들지 못했습니다.");
  }

  const sub = subtotal(quote);
  const total = pyRoundInt(sub * 1.1);
  const op = crypto.randomUUID();
  let row: IssuedRow | null = null;
  try {
    await db.batch(issuedUpsertStatements(db, {
      now, issueDate, filename, customer: quote.customer.org, contact: quote.customer.contact, modelHint: quote.model_hint,
      subtotal: sub, total, nLines: quote.lines.length, quoteJson: serializeQuote(quote), staffName,
      authorAccountId: principal.accountId, authorName: principal.displayName || principal.employeeName || principal.email,
      dedupKey: key, suffix, op, priceRows: priceLogRows(quote),
    }));
    row = await db.prepare(ISSUED_BY_DEDUP_SQL).bind(key).first<IssuedRow>();
  } catch {
    row = null;
  }
  if (!row) return erpError(500, "RECORD_FAILED", "견적 기록에 실패했습니다. 파일은 아래에서 내려받을 수 있습니다.", { xlsxBase64: bytesToBase64(xlsx), filename });

  const issuedId = Number(row.id);
  const rev = Number(row.file_rev);
  if (row.op_token !== op) {
    // 확정 보호(QD-8): 같은 내용의 확정 행이 있다. D1·R2 를 건드리지 않고 기존 파일을 돌려준다.
    await writeErpAudit(db, {
      principal, module: "quote", action: "QUOTE_GENERATED", entityType: "QUOTE_ISSUED", entityId: String(issuedId),
      after: { issuedId, rev, lines: quote.lines.length, subtotal: sub, total, status: row.status, created: false, unchanged: true },
    });
    return Response.json({
      issuedId, rev, status: row.status, created: false, unchanged: true, filename: row.filename, subtotal: sub, total,
      files: { xlsx: Boolean(row.xlsx_key), pdf: Boolean(row.pdf_key) }, pending: await countDrafts(db),
    });
  }
  const created = rev === 1 && Number(row.created_at) === now;
  const xlsxKey = issuedFileKey(issuedId, rev, "xlsx");
  try {
    await bindings.HR_AUDIO.put(xlsxKey, xlsx, { httpMetadata: { contentType: XLSX_MIME } });
  } catch {
    return erpError(502, "STORAGE_FAILED", "기록은 됐지만 파일 저장에 실패했습니다. 다시 생성해 주세요.", { issuedId, xlsxBase64: bytesToBase64(xlsx), filename });
  }
  await db.prepare(`UPDATE quote_issued SET xlsx_key = ?1 WHERE id = ?2 AND op_token = ?3`).bind(xlsxKey, issuedId, op).run();
  await writeErpAudit(db, {
    principal, module: "quote", action: "QUOTE_GENERATED", entityType: "QUOTE_ISSUED", entityId: String(issuedId),
    after: { issuedId, rev, lines: quote.lines.length, subtotal: sub, total, status: row.status, created, unchanged: false },
  });

  let pdf = false;
  let pdfError: { code: PdfErrorCode; message: string } | undefined;
  if (body.pdf !== false) {
    const made = await makePdf(principal, issuedId, rev, xlsx, quote.sheet_name);
    if (made.ok) pdf = true;
    else pdfError = pdfErrorBody(made.code);
  }
  return Response.json({
    issuedId, rev, status: row.status, created, unchanged: false, filename, subtotal: sub, total,
    files: { xlsx: true, pdf }, ...(pdfError ? { pdfError } : {}), pending: await countDrafts(db),
  });
}

async function regeneratePdf(principal: ErpPrincipal, body: Record<string, unknown>) {
  const issuedId = readId(body.issuedId);
  if (issuedId === null) return quoteValidation("견적 번호를 확인해 주세요.", "issuedId");
  const row = await db.prepare(`SELECT id, file_rev, xlsx_key, quote_json FROM quote_issued WHERE id = ?1`).bind(issuedId)
    .first<{ id: number; file_rev: number; xlsx_key: string | null; quote_json: string }>();
  if (!row) return quoteNotFound();
  const object = row.xlsx_key ? await bindings.HR_AUDIO.get(row.xlsx_key) : null;
  if (!object) return quoteNotFound("파일이 아직 없습니다.");
  const quote = parseStoredQuote(row.quote_json);
  const rev = Number(row.file_rev);
  const made = await makePdf(principal, issuedId, rev, new Uint8Array(await object.arrayBuffer()), quote?.sheet_name ?? "견적");
  if (!made.ok) return erpError(PDF_ERRORS[made.code].status, made.code, PDF_ERRORS[made.code].message, { issuedId });
  return Response.json({ issuedId, rev, files: { xlsx: true, pdf: true } });
}

async function confirm(principal: ErpPrincipal, body: Record<string, unknown>) {
  const issuedId = readId(body.issuedId);
  if (issuedId === null) return quoteValidation("견적 번호를 확인해 주세요.", "issuedId");
  const row = await db.prepare(`SELECT id, issue_date, dedup_key FROM quote_issued WHERE id = ?1`).bind(issuedId)
    .first<{ id: number; issue_date: string; dedup_key: string | null }>();
  if (!row) return quoteNotFound();
  const normalized = normalizeQuote(body.quote);
  if (!normalized.ok) return quoteValidation(normalized.error, normalized.field);
  const suffixRead = readSuffix(body.suffix);
  if ("error" in suffixRead) return suffixRead.error;
  const key = await dedupKey(normalized.quote, row.issue_date, normalized.quote.staff.name || null, suffixRead.suffix, body.quote);
  if (key !== row.dedup_key) return erpError(409, "STALE", "생성한 뒤 내용이 바뀌었습니다. 다시 생성한 뒤 발송 확정을 눌러 주세요.");
  const now = Date.now();
  const op = crypto.randomUUID();
  const [priceResult] = await db.batch(statusStatements(db, [issuedId], "confirmed", now, op));
  const changedIds = (await changedIdsStatement(db, op).all<{ id: number }>()).results.map((entry) => Number(entry.id));
  const priceRows = Number(priceResult?.meta?.changes ?? 0);
  await writeErpAudit(db, {
    principal, module: "quote", action: "QUOTE_STATUS_CHANGED", entityType: "QUOTE_ISSUED", entityId: String(issuedId),
    after: { ids: [issuedId], status: "confirmed", changed: changedIds.length, priceRows, via: "CONFIRM" },
  });
  return Response.json({ issuedId, changed: changedIds.length, status: "confirmed", pending: await countDrafts(db) });
}

async function setStatus(principal: ErpPrincipal, body: Record<string, unknown>) {
  if (!isQuoteStatus(body.status)) return quoteValidation("상태는 draft·confirmed·discarded 중 하나입니다.", "status");
  const status = body.status;
  if (!Array.isArray(body.ids) || !body.ids.every((id) => readId(id) !== null)) return quoteValidation("견적 번호 목록을 확인해 주세요.", "ids");
  if (body.ids.length > STATUS_MAX_IDS) return quoteValidation(`한 번에 ${STATUS_MAX_IDS}건까지만 바꿀 수 있습니다.`, "ids");
  const ids = [...new Set(body.ids as number[])];
  if (!ids.length) return Response.json({ changed: 0, ids: [], status, price_rows: 0, pending: await countDrafts(db) });
  const now = Date.now();
  const op = crypto.randomUUID();
  const [priceResult] = await db.batch(statusStatements(db, ids, status, now, op));
  const changedIds = (await changedIdsStatement(db, op).all<{ id: number }>()).results.map((entry) => Number(entry.id));
  const priceRows = Number(priceResult?.meta?.changes ?? 0);
  if (changedIds.length) {
    await writeErpAudit(db, {
      principal, module: "quote", action: "QUOTE_STATUS_CHANGED", entityType: "QUOTE_ISSUED", entityId: changedIds.slice(0, 20).join(",").slice(0, 120),
      after: { ids: changedIds, status, changed: changedIds.length, priceRows },
    });
  }
  return Response.json({ changed: changedIds.length, ids: changedIds, status, price_rows: priceRows, pending: await countDrafts(db) });
}

export async function POST(request: Request) {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const read = await readJsonCapped(request, BODY_CAP);
  if (read.response) return read.response;
  const body = read.body;
  switch (body.action) {
    case "GENERATE": return generate(principal, body);
    case "REGENERATE_PDF": return regeneratePdf(principal, body);
    case "CONFIRM": return confirm(principal, body);
    case "SET_STATUS": return setStatus(principal, body);
    default: return quoteValidation("알 수 없는 요청입니다.", "action");
  }
}
