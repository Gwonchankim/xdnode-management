import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import { ensureQuoteSchema } from "../../../quote-schema";
import {
  DEFAULT_QUOTE_BRIDGE_URL, DEFAULT_QUOTE_PDF_HELPER_URL, countDrafts, helperAvailable, loadTemplateFromR2, readQuoteMeta,
} from "../../../quote-server";

// quote-tool Design §3.2 GET /api/quote/overview. ?summary=1 이면 탭 배지 수(미확정 견적)만.
// 전체: 도우미 사용 가능 여부(주소는 라우트 기본값, 하니스만 env 로 바꾼다 — QD-17), 템플릿 준비, 카탈로그 현재 버전·행 수, 마지막 이전.
const bindings = env as unknown as { DB: D1Database; HR_AUDIO?: R2Bucket; CLAUDE_QUOTE_BRIDGE_URL?: string; QUOTE_PDF_HELPER_URL?: string };
const db = bindings.DB;

export async function GET(request: Request) {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "read");
  if (authorization.response) return authorization.response;
  const pending = await countDrafts(db);
  if (new URL(request.url).searchParams.get("summary") === "1") return Response.json({ pending });

  const meta = await readQuoteMeta(db, ["version:catalog_v2", "version:catalog", "version:bom_library"]);
  const versions = {
    catalog_v2: meta.get("version:catalog_v2") ?? null,
    catalog: meta.get("version:catalog") ?? null,
    bom_library: meta.get("version:bom_library") ?? null,
  };
  const count = async (sql: string, version: string | null) => {
    if (!version) return 0;
    const row = await db.prepare(sql).bind(version).first<{ n: number }>();
    return Number(row?.n ?? 0);
  };
  const [ai, pdf, template, products, legacyProducts, bom, customers, lastImport] = await Promise.all([
    helperAvailable(bindings.CLAUDE_QUOTE_BRIDGE_URL || DEFAULT_QUOTE_BRIDGE_URL),
    helperAvailable(bindings.QUOTE_PDF_HELPER_URL || DEFAULT_QUOTE_PDF_HELPER_URL),
    loadTemplateFromR2(db, bindings.HR_AUDIO),
    count(`SELECT COUNT(*) AS n FROM quote_catalog_products WHERE version = ?1 AND kind <> 'junk'`, versions.catalog_v2),
    count(`SELECT COUNT(*) AS n FROM quote_catalog_legacy WHERE version = ?1`, versions.catalog),
    count(`SELECT COUNT(*) AS n FROM quote_bom_library WHERE version = ?1`, versions.bom_library),
    count(`SELECT COUNT(DISTINCT org) AS n FROM quote_customers WHERE version = ?1`, versions.catalog),
    db.prepare(`SELECT finished_at, status FROM quote_import_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`)
      .first<{ finished_at: number; status: string }>(),
  ]);
  return Response.json({
    pending,
    helpers: { ai, pdf },
    template: template.ok ? { ready: true } : { ready: false, code: template.code },
    catalog: { versions, products, legacyProducts, bom, customers },
    lastImport: lastImport ? { finishedAt: lastImport.finished_at, status: lastImport.status } : null,
  });
}
