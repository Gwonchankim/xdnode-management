import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import { ensureQuoteSchema } from "../../../quote-schema";
import { attachmentDownloadHeaders } from "../../../attachment-rules";
import { canSeeMargin, quoteNotFound, quoteValidation } from "../../../quote-server";
import { XLSX_MIME, stripMarginSheet } from "../../../quote-xlsx";

// quote-tool Design §3.2·§8 GET /api/quote/files?issuedId=&kind=xlsx|pdf (quote:read, 감사 없음).
// R2 키는 id·rev 만 쓰고, 표시 파일명은 quote_issued.filename(PDF 는 확장자만 .pdf)이다. 헤더는 attachmentDownloadHeaders
// (attachment filename*=, nosniff, private no-store, sandbox CSP). 보기 권한의 xlsx 는 저장본에서 마진계산용 시트를 떼어 준다(QT-Q12, QD-12).
const bindings = env as unknown as { DB: D1Database; HR_AUDIO: R2Bucket };
const db = bindings.DB;

export async function GET(request: Request) {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "read");
  if (authorization.response) return authorization.response;
  const params = new URL(request.url).searchParams;
  const raw = params.get("issuedId") ?? "";
  const kind = params.get("kind") ?? "xlsx";
  if (!/^\d{1,12}$/.test(raw)) return quoteValidation("견적 번호를 확인해 주세요.", "issuedId");
  if (kind !== "xlsx" && kind !== "pdf") return quoteValidation("파일 종류는 xlsx·pdf 중 하나입니다.", "kind");
  const row = await db.prepare(`SELECT filename, xlsx_key, pdf_key FROM quote_issued WHERE id = ?1`).bind(Number(raw))
    .first<{ filename: string; xlsx_key: string | null; pdf_key: string | null }>();
  if (!row) return quoteNotFound();
  const key = kind === "xlsx" ? row.xlsx_key : row.pdf_key;
  const object = key ? await bindings.HR_AUDIO.get(key) : null;
  if (!object) return quoteNotFound("파일이 아직 없습니다.");
  if (kind === "pdf") {
    return new Response(object.body, { headers: attachmentDownloadHeaders(row.filename.replace(/\.xlsx$/i, "") + ".pdf", "application/pdf") });
  }
  if (canSeeMargin(authorization.principal)) return new Response(object.body, { headers: attachmentDownloadHeaders(row.filename, XLSX_MIME) });
  const stripped = stripMarginSheet(new Uint8Array(await object.arrayBuffer()));
  return new Response(stripped, { headers: attachmentDownloadHeaders(row.filename, XLSX_MIME) });
}
