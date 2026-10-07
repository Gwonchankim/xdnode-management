import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import { ensureQuoteSchema } from "../../../quote-schema";
import { matchCustomer, matchProduct, specFor } from "../../../quote-pricing";
import { loadQuoteCatalog, priceHistory, quoteValidation } from "../../../quote-server";

// quote-tool Design §3.2 GET /api/quote/catalog (quote:read, 감사 없음). 옛 /api/products·/api/spec·/api/vocab·/api/price_history 대응.
//   ?view=products&q=&category=        제품 후보 8건(matchProduct, 세트·부품 구분 없음)
//   ?view=spec&name=                   서버 바디 모델명 → 멀티라인 사양 문구 {spec}
//   ?view=vocab                        어휘(group_labels·categories·remarks·payment·delivery)
//   ?view=priceHistory&name=&kind=     {issued: 발행 로그 이력 20건, catalog: 후보 3건}. kind = set | item | (없음 = 전부)
//   ?view=customers&org=&contact=      고객 후보 8건(PII — 서버가 고른 칸만: org, contact, tel, email, last_date, n, score)
const db = (env as unknown as { DB: D1Database }).DB;
const TEXT_MAX = 200;

function textParam(params: URLSearchParams, name: string): string | null | undefined {
  const value = params.get(name);
  if (value === null) return undefined;
  return Array.from(value).length > TEXT_MAX ? null : value;
}

export async function GET(request: Request) {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "read");
  if (authorization.response) return authorization.response;
  const params = new URL(request.url).searchParams;
  const view = params.get("view") ?? "";
  const texts: Record<string, string> = {};
  for (const name of ["q", "category", "name", "kind", "org", "contact"]) {
    const value = textParam(params, name);
    if (value === null) return quoteValidation(`${name} 은 ${TEXT_MAX}자까지입니다.`, name);
    if (value !== undefined) texts[name] = value;
  }

  if (view === "vocab") return Response.json((await loadQuoteCatalog(db)).vocab);
  if (view === "products") {
    const catalog = await loadQuoteCatalog(db);
    return Response.json({ rows: matchProduct(catalog, texts.q ?? "", texts.category || null, 8) });
  }
  if (view === "spec") return Response.json({ spec: specFor(await loadQuoteCatalog(db), texts.name ?? "") });
  if (view === "priceHistory") {
    const kind = texts.kind ?? "";
    if (kind !== "" && kind !== "set" && kind !== "item") return quoteValidation("kind 는 set·item 중 하나입니다.", "kind");
    const name = texts.name ?? "";
    const catalog = await loadQuoteCatalog(db);
    return Response.json({ issued: await priceHistory(db, name, kind === "" ? null : kind, 20), catalog: matchProduct(catalog, name, null, 3) });
  }
  if (view === "customers") {
    const catalog = await loadQuoteCatalog(db);
    return Response.json({ rows: matchCustomer(catalog, texts.org ?? "", texts.contact || null) });
  }
  return quoteValidation("알 수 없는 보기입니다.", "view");
}
