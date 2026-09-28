import { env } from "cloudflare:workers";
import { authorizeErpRequest, safeJson } from "../../erp-platform";
import { hrTablesExist } from "../../hr-optional-tables";

type Bindings = { DB: D1Database };
const db = (env as unknown as Bindings).DB;

type AuditRow = {
  id: string;
  actor_email: string;
  actor_employee_id: string;
  actor_name: string | null;
  module: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
  reason: string;
  created_at: number;
};

// Design §6.1 아래 목록. 뒤의 네 값(operations·finance·sales·settings)은 R1·R3 이전에 쌓인 과거 행 조회용이다.
const allowedModules = new Set(["ALL", "hr", "recruitment", "compensation", "chat", "audit", "admin", "auth", "operations", "finance", "sales", "settings"]);
const secretKey = /password|passcode|secret|token|api.?key|authorization|cookie|private.?key|access.?key/i;

function dateStart(value: string) {
  return new Date(`${value}T00:00:00+09:00`).getTime();
}

function dateEnd(value: string) {
  return dateStart(value) + 86_400_000;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 7) return "[깊이 제한]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 150).map(([key, item]) => [
    key,
    secretKey.test(key) ? "[보안 값 가림]" : redact(item, depth + 1),
  ]));
}

function flatten(value: unknown, prefix = "", result = new Map<string, string>(), depth = 0) {
  if (depth > 5 || result.size >= 200) return result;
  if (Array.isArray(value)) {
    value.slice(0, 50).forEach((item, index) => flatten(item, `${prefix}[${index}]`, result, depth + 1));
  } else if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key, result, depth + 1));
  } else if (prefix) result.set(prefix, JSON.stringify(value));
  return result;
}

function changedFields(before: unknown, after: unknown) {
  const left = flatten(before); const right = flatten(after);
  return Array.from(new Set([...left.keys(), ...right.keys()]))
    .filter((key) => left.get(key) !== right.get(key))
    .slice(0, 24);
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function GET(request: Request) {
  // 감사 탭은 관리자 전용이다(D23). audit 탭이 adminOnly 라 read 여도 isAdmin 으로만 판정한다.
  const authorization = await authorizeErpRequest(db, "audit", "read");
  if (authorization.response) return authorization.response;

  const url = new URL(request.url);
  const moduleName = (url.searchParams.get("module") || "ALL").trim();
  const action = (url.searchParams.get("action") || "").trim().slice(0, 80);
  const query = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const dateFrom = (url.searchParams.get("dateFrom") || "").trim();
  const dateTo = (url.searchParams.get("dateTo") || "").trim();
  const cursorAt = Number(url.searchParams.get("cursorAt") || 0);
  const cursorId = (url.searchParams.get("cursorId") || "").trim();
  if (!allowedModules.has(moduleName)) return Response.json({ error: "조회할 업무 영역을 확인해 주세요." }, { status: 400 });
  if ((dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) || (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) || (dateFrom && dateTo && dateFrom > dateTo)) {
    return Response.json({ error: "조회 기간을 확인해 주세요." }, { status: 400 });
  }
  if ((cursorAt && !cursorId) || (!cursorAt && cursorId)) return Response.json({ error: "페이지 위치가 올바르지 않습니다." }, { status: 400 });

  const where: string[] = ["1=1"];
  const binds: Array<string | number> = [];
  if (moduleName !== "ALL") { where.push("a.module = ?"); binds.push(moduleName); }
  if (action) { where.push("a.action = ?"); binds.push(action); }
  if (dateFrom) { where.push("a.created_at >= ?"); binds.push(dateStart(dateFrom)); }
  if (dateTo) { where.push("a.created_at < ?"); binds.push(dateEnd(dateTo)); }
  if (query) {
    const like = `%${escapeLike(query)}%`;
    where.push(`(a.action LIKE ? ESCAPE '\\' OR a.entity_type LIKE ? ESCAPE '\\' OR a.entity_id LIKE ? ESCAPE '\\' OR a.reason LIKE ? ESCAPE '\\' OR a.actor_email LIKE ? ESCAPE '\\' OR a.actor_employee_id LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\' OR ac.display_name LIKE ? ESCAPE '\\')`);
    binds.push(like, like, like, like, like, like, like, like);
  }
  const baseWhere = where.join(" AND ");
  const pageWhere = cursorAt ? `${baseWhere} AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))` : baseWhere;
  const pageBinds = cursorAt ? [...binds, cursorAt, cursorAt, cursorId] : binds;

  // 이름: 인사기록 이름이 있으면 그것, 없으면(미연결 계정) 계정 표시 이름(§3.2).
  // 인사기록 표는 HR 화면을 한 번도 열지 않은 새 DB 에는 아직 없다. 그때는 빈 대역으로 붙여 계정 이름만 쓴다.
  const employeeSource = await hrTablesExist(db, "hr_employee_records")
    ? "hr_employee_records"
    : "(SELECT NULL AS employee_id, NULL AS name WHERE 0)";
  const joins = `FROM erp_audit_logs a LEFT JOIN ${employeeSource} e ON e.employee_id = a.actor_employee_id
      LEFT JOIN auth_accounts ac ON ac.id = a.actor_user_id`;
  const [rows, count, actors, actions] = await Promise.all([
    db.prepare(`SELECT a.id, a.actor_email, a.actor_employee_id, COALESCE(e.name, ac.display_name) AS actor_name,
      a.module, a.action, a.entity_type, a.entity_id, a.before_json, a.after_json, a.reason, a.created_at
      ${joins}
      WHERE ${pageWhere} ORDER BY a.created_at DESC, a.id DESC LIMIT 31`).bind(...pageBinds).all<AuditRow>(),
    db.prepare(`SELECT COUNT(*) AS total, MAX(a.created_at) AS latest_at ${joins} WHERE ${baseWhere}`).bind(...binds).first<{ total: number; latest_at: number | null }>(),
    db.prepare(`SELECT COUNT(DISTINCT a.actor_employee_id) AS total ${joins} WHERE ${baseWhere}`).bind(...binds).first<{ total: number }>(),
    db.prepare(`SELECT a.action, COUNT(*) AS count ${joins} WHERE ${baseWhere}
      GROUP BY a.action ORDER BY count DESC, a.action LIMIT 40`).bind(...binds).all<{ action: string; count: number }>(),
  ]);
  const hasMore = rows.results.length > 30;
  const visible = rows.results.slice(0, 30);
  const last = visible.at(-1);

  return Response.json({
    principal: { employeeId: authorization.principal.employeeId, name: authorization.principal.employeeName },
    summary: { total: Number(count?.total ?? 0), actors: Number(actors?.total ?? 0), latestAt: count?.latest_at ?? null },
    actionOptions: actions.results.map((item) => ({ action: item.action, count: Number(item.count) })),
    items: visible.map((row) => {
      const before = redact(safeJson<unknown>(row.before_json, null));
      const after = redact(safeJson<unknown>(row.after_json, null));
      return {
        id: row.id, actorEmail: row.actor_email, actorEmployeeId: row.actor_employee_id,
        actorName: row.actor_name || row.actor_employee_id, module: row.module, action: row.action,
        entityType: row.entity_type, entityId: row.entity_id, before, after,
        changedFields: changedFields(before, after), reason: row.reason, createdAt: row.created_at,
      };
    }),
    nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
    controls: { readOnly: true, secretValuesRedacted: true, automaticMutation: false },
  }, { headers: { "Cache-Control": "private, no-store" } });
}
