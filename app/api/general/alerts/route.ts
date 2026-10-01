import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { authorizeErpRequest, erpError, platformSchemaReady, writeErpAudit, type AuditActor } from "../../../erp-platform";
import { crossSiteViolation, CROSS_ORIGIN_ERROR } from "../../../request-guard";
import { peerOf, readSessionToken } from "../../../auth-session";
import { ensureGaSchema } from "../../../ga-schema";
import { runGaAlerts } from "../../../ga-alert-run";

// general-affairs Design §4 GD-7. 하루 한 번 메신저 알림을 실행한다(KST 날짜별 멱등).
// 호출자 ① 서버 PC 의 작업 스케줄러(scripts/Run-GaAlerts.ps1): 세션 없이 루프백(x-xdm-peer, local-peer 플러그인이 소켓 주소로 찍음) +
// X-XDM-Task: ga-alerts. ② 총무 편집 권한자의 수동 실행(general:write). 그 밖에는 401/403 이다.
const db = (env as unknown as { DB: D1Database }).DB;
const SYSTEM_ACTOR: AuditActor = { userId: "SYSTEM", email: "", employeeId: "SYSTEM" };

export async function POST() {
  const requestHeaders = await headers();
  const systemCall = requestHeaders.get("x-xdm-task") === "ga-alerts" && !readSessionToken(requestHeaders.get("cookie"));
  let actor: AuditActor;
  let trigger: string;
  if (systemCall) {
    await platformSchemaReady(db);
    if (crossSiteViolation(requestHeaders)) return Response.json(CROSS_ORIGIN_ERROR, { status: 403 });
    if (!peerOf(requestHeaders).loopback) return erpError(401, "UNAUTHENTICATED", "로그인이 필요합니다.");
    actor = SYSTEM_ACTOR;
    trigger = "task";
  } else {
    const authorization = await authorizeErpRequest(db, "general", "write");
    if (authorization.response) return authorization.response;
    actor = authorization.principal;
    trigger = "manual";
  }
  await ensureGaSchema(db);
  const result = await runGaAlerts(db, { trigger });
  if (!result.alreadyRan) {
    await writeErpAudit(db, { principal: actor, module: "general", action: "GA_ALERTS_RUN", entityType: "GA_ALERT_RUN", entityId: result.runDate,
      after: { runDate: result.runDate, itemCount: result.itemCount, posted: result.posted, members: result.members, trigger } });
  }
  return Response.json(result);
}
