import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import { ensureQuoteSchema } from "../../../quote-schema";
import { parseStoredQuote, withoutMargin } from "../../../quote-model";
import { canSeeMargin, countDrafts, pendingDrafts, quoteNotFound, quoteValidation, recentIssued, searchHistory } from "../../../quote-server";

// quote-tool Design §3.2 GET /api/quote/history. 검색·최근·미확정·불러오기(읽기 전용, 감사 없음).
// 불러오기는 issuedId·corpusId 만 받는다. 파일 경로 인자(옛 ?file=)는 받지 않는다(S3 소멸).
// 보기 권한 응답에서는 Quote JSON 의 margin 을 지운다(QT-Q12). 코퍼스 마진 행은 어떤 응답에도 싣지 않는다.
const db = (env as unknown as { DB: D1Database }).DB;

function intParam(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number | null {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d{1,9}$/.test(raw)) return null;
  const value = Number(raw);
  return value < min || value > max ? null : value;
}

export async function GET(request: Request) {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "read");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const params = new URL(request.url).searchParams;

  const issuedRaw = params.get("issuedId");
  const corpusRaw = params.get("corpusId");
  if (issuedRaw !== null || corpusRaw !== null) {
    const raw = issuedRaw ?? corpusRaw ?? "";
    if (!/^\d{1,12}$/.test(raw)) return quoteValidation("견적 번호를 확인해 주세요.", issuedRaw !== null ? "issuedId" : "corpusId");
    const id = Number(raw);
    const margin = canSeeMargin(principal);
    if (issuedRaw !== null) {
      const row = await db.prepare(`SELECT id, issue_date, quote_json, COALESCE(status, 'confirmed') AS status, file_rev, xlsx_key, pdf_key
        FROM quote_issued WHERE id = ?1`).bind(id).first<{ id: number; issue_date: string; quote_json: string; status: string; file_rev: number; xlsx_key: string | null; pdf_key: string | null }>();
      const quote = row ? parseStoredQuote(row.quote_json) : null;
      if (!row || !quote) return quoteNotFound();
      // 옛 FR-12: 불러온 견적의 작성일은 비운다(새 견적의 작성일은 생성하는 날). 원본 작성일은 source_date 로 준다.
      const loaded = { ...quote, issue_date: null };
      return Response.json({
        quote: margin ? loaded : withoutMargin(loaded),
        source_date: row.issue_date,
        source: { kind: "issued", id: row.id, status: row.status, rev: row.file_rev, files: { xlsx: Boolean(row.xlsx_key), pdf: Boolean(row.pdf_key) } },
        // 단가 제안·고객 매칭은 QT3(compute SUGGEST)에서 채운다.
        suggestions: {},
        customer_matches: [],
      });
    }
    const row = await db.prepare(`SELECT id, quote_date, quote_json FROM quote_corpus_files WHERE id = ?1`).bind(id)
      .first<{ id: number; quote_date: string | null; quote_json: string | null }>();
    if (!row) return quoteNotFound();
    const quote = parseStoredQuote(row.quote_json);
    if (!quote) return quoteNotFound("이 과거 파일은 불러올 수 없습니다.");
    const loaded = { ...quote, issue_date: null };
    return Response.json({
      quote: margin ? loaded : withoutMargin(loaded),
      source_date: quote.issue_date ?? row.quote_date,
      source: { kind: "file", id: row.id },
      suggestions: {},
      customer_matches: [],
    });
  }

  const view = params.get("view") ?? "recent";
  if (view === "search") {
    const q = (params.get("q") ?? "").trim();
    if (Array.from(q).length > 100) return quoteValidation("검색어는 100자까지입니다.", "q");
    const limit = intParam(params, "limit", 30, 1, 100);
    const offset = intParam(params, "offset", 0, 0, 1_000_000);
    if (limit === null) return quoteValidation("limit 은 1~100 입니다.", "limit");
    if (offset === null) return quoteValidation("offset 을 확인해 주세요.", "offset");
    const result = await searchHistory(db, q, limit, offset);
    return Response.json({ rows: result.rows, total: result.total, limit, offset });
  }
  if (view === "recent") {
    const limit = intParam(params, "limit", 15, 1, 50);
    if (limit === null) return quoteValidation("limit 은 1~50 입니다.", "limit");
    return Response.json({ rows: await recentIssued(db, limit) });
  }
  if (view === "pending") {
    const limit = intParam(params, "limit", 200, 1, 500);
    if (limit === null) return quoteValidation("limit 은 1~500 입니다.", "limit");
    const [rows, count] = await Promise.all([pendingDrafts(db, limit), countDrafts(db)]);
    return Response.json({ rows, count });
  }
  return quoteValidation("알 수 없는 보기입니다.", "view");
}
