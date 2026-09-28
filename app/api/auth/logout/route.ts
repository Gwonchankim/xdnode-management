import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { platformSchemaReady, writeErpAudit } from "../../../erp-platform";
import { clearedSessionCookie, peerOf, resolveSession, toPrincipal } from "../../../auth-session";
import { crossSiteViolation, CROSS_ORIGIN_ERROR } from "../../../request-guard";

// Design §4.2.3. 쿠키가 없거나 무효여도 200이고, 그때는 감사를 남기지 않는다.
const db = (env as unknown as { DB: D1Database }).DB;

export async function POST() {
  await platformSchemaReady(db);
  const requestHeaders = await headers();
  if (crossSiteViolation(requestHeaders)) return Response.json(CROSS_ORIGIN_ERROR, { status: 403 });
  const session = await resolveSession(db, requestHeaders.get("cookie"));
  if (session) {
    const now = Date.now();
    await db.prepare(`UPDATE auth_sessions SET revoked_at = ?, revoked_reason = 'LOGOUT' WHERE id = ? AND revoked_at IS NULL`)
      .bind(now, session.sessionId).run();
    await writeErpAudit(db, { principal: toPrincipal(session.account), module: "auth", action: "LOGOUT",
      entityType: "AUTH_SESSION", entityId: session.account.id, after: { peer: peerOf(requestHeaders).address } });
  }
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie(), "Cache-Control": "no-store" } });
}
