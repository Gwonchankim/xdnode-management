import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import { readOptionalHrRows } from "../../../hr-optional-tables";

// Design §4.2.7, D20, 부록 B #5. 임금 계산·인센티브 화면이 쓰는 최소 명부다.
// 필드는 employeeId·name·department·status 4개뿐이다. 전화·주소·생년월일·이메일·급여는 싣지 않는다.
// 부수효과가 없다: DDL·시드·applyDue* 를 부르지 않는다. 인사기록 표가 아직 없으면(빈 DB) 빈 목록이다.
const db = (env as unknown as { DB: D1Database }).DB;

type RosterRow = { employee_id: string; name: string; department: string; status: string };

export async function GET() {
  const authorization = await authorizeErpRequest(db, "compensation", "read");
  if (authorization.response) return authorization.response;
  const rows = await readOptionalHrRows<RosterRow>(db, ["hr_employee_records"],
    "SELECT employee_id, name, department, status FROM hr_employee_records");
  const retired = (status: string) => (status ?? "").trim() === "퇴직" ? 1 : 0;
  const employees = rows.results
    .map((row) => ({ employeeId: row.employee_id, name: row.name ?? "", department: row.department ?? "", status: row.status ?? "" }))
    .sort((left, right) => retired(left.status) - retired(right.status) || left.name.localeCompare(right.name, "ko"));
  return Response.json({ employees }, { headers: { "Cache-Control": "private, no-store" } });
}
