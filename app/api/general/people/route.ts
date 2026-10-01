import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import { gaPeople } from "../../../ga-server";

// general-affairs Design §4. 직원 선택용 최소 명부(사번·이름·부서·상태). 급여·연락처·생년월일은 싣지 않는다. 부수효과 없음.
const db = (env as unknown as { DB: D1Database }).DB;

export async function GET() {
  const authorization = await authorizeErpRequest(db, "general", "read");
  if (authorization.response) return authorization.response;
  return Response.json({ people: await gaPeople(db) }, { headers: { "Cache-Control": "private, no-store" } });
}
