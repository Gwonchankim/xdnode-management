import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { erpError, platformSchemaReady } from "../../erp-platform";
import { accountsExist, peerOf, resolveSession, sessionUserDto, toPrincipal } from "../../auth-session";
import { crossSiteViolation, CROSS_ORIGIN_ERROR } from "../../request-guard";

// Design §4.2.1. 비로그인은 401(UNAUTHENTICATED), 계정이 0개면 401(BOOTSTRAP_REQUIRED). mustChangePassword 여도 200이다.
const db = (env as unknown as { DB: D1Database }).DB;
const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  await platformSchemaReady(db);
  const requestHeaders = await headers();
  if (crossSiteViolation(requestHeaders)) return Response.json(CROSS_ORIGIN_ERROR, { status: 403, headers: noStore });
  const session = await resolveSession(db, requestHeaders.get("cookie"));
  if (!session) {
    if (!await accountsExist(db)) {
      return erpError(401, "BOOTSTRAP_REQUIRED", "첫 관리자 계정을 먼저 만들어 주세요.",
        { bootstrapAllowedHere: peerOf(requestHeaders).loopback }, { headers: noStore });
    }
    return erpError(401, "UNAUTHENTICATED", "로그인이 필요합니다.", {}, { headers: noStore });
  }
  const principal = toPrincipal(session.account);
  return Response.json({
    user: sessionUserDto(principal),
    isAdmin: principal.isAdmin,
    tabs: principal.tabs,
    mustChangePassword: session.account.must_change_password === 1,
  }, { headers: noStore });
}
