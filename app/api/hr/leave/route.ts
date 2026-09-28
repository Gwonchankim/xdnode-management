import { env } from "cloudflare:workers";
import { ensureHrEmployeeRecordsSchema } from "../../../hr-employee-schema";
import { ensureEmployeeRosterSeeded } from "../../../hr-employee-roster";
import { readOptionalHrRows } from "../../../hr-optional-tables";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import {
  LEAVE_KINDS, computeLeaveLedger, leaveKindFromLabel, normalizeDate, promotionNoticeText,
  type GrantAdjustment, type LeaveKind, type LeaveUsage,
} from "../../../hr-leave-accrual";

type HrBindings = { DB: D1Database };
const db = (env as unknown as HrBindings).DB;

/** 월차·연차 관리. 발생은 저장하지 않고 app/hr-leave-accrual.ts 가 입사일에서 매번 계산한다(회사 결정: 자동 부여).
 *  저장하는 것은 두 가지 — 사용 기록(hr_leave_requests, HR 대리 입력이라 바로 APPROVED)과
 *  사람이 손댄 발생분 조정(hr_leave_grant_adjustments: 결근 등으로 「제외」하거나 일수를 고친 것). */

/** hr_leave_requests.leave_type ↔ 엔진 종류. 예전 신청 화면의 오전·오후 반차는 둘 다 반차다. */
const LEAVE_TYPE_TO_KIND: Record<string, LeaveKind> = {
  ANNUAL: "ANNUAL", HALF: "HALF", HALF_AM: "HALF", HALF_PM: "HALF", QUARTER: "QUARTER",
  BIRTHDAY_HALF: "BIRTHDAY_HALF", OFFICIAL: "OFFICIAL", SICK: "SICK", FAMILY: "FAMILY", OTHER: "OTHER",
};
const RECORDABLE_TYPES = Object.keys(LEAVE_TYPE_TO_KIND);

type EmployeeRow = { employee_id: string; name: string; department: string; join_date: string; status: string; email: string; position: string };
/** 대표이사는 연차 관리 대상이 아니다(회사 결정). 목록·대시보드에서 빼되 사번으로 직접 조회하면 보여 준다. */
const LEAVE_EXEMPT_POSITIONS = ["대표", "대표이사"];
type RequestRow = { id: string; employee_id: string; leave_type: string; start_date: string; end_date: string; units: number; reason: string; status: string; deducts: number; source: string; recorded_by: string };
type AdjustmentRow = { id: string; employee_id: string; grant_key: string; status: string; units: number | null; note: string; updated_by: string; updated_at: number };

async function ensureSchema() {
  await ensureHrEmployeeRecordsSchema(db);
  await ensureEmployeeRosterSeeded(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_leave_requests (
      id TEXT PRIMARY KEY NOT NULL, employee_id TEXT NOT NULL, leave_type TEXT NOT NULL, start_date TEXT NOT NULL,
      end_date TEXT NOT NULL, units INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'PENDING',
      approver_employee_id TEXT NOT NULL DEFAULT '', decided_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_leave_grant_adjustments (
      id TEXT PRIMARY KEY NOT NULL, employee_id TEXT NOT NULL, grant_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT '',
      units REAL, note TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      UNIQUE (employee_id, grant_key)
    )`),
  ]);
  const columns = await db.prepare("PRAGMA table_info(hr_leave_requests)").all<{ name: string }>();
  const names = new Set(columns.results.map((column) => column.name));
  // 차감 여부(생일 반차·공가는 0), 출처(ERP / SHEET_IMPORT), 대리 입력자. 예전 신청 화면이 만든 행은 기본값을 받는다.
  if (!names.has("deducts")) await db.prepare("ALTER TABLE hr_leave_requests ADD COLUMN deducts INTEGER NOT NULL DEFAULT 1").run();
  if (!names.has("source")) await db.prepare("ALTER TABLE hr_leave_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'ERP'").run();
  if (!names.has("recorded_by")) await db.prepare("ALTER TABLE hr_leave_requests ADD COLUMN recorded_by TEXT NOT NULL DEFAULT ''").run();
}

function todayInKorea() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function loadEmployees(employeeId?: string) {
  const sql = `SELECT employee_id, name, department, join_date, status, email, position FROM hr_employee_records${employeeId ? " WHERE employee_id = ?" : ""} ORDER BY join_date, employee_id`;
  const result = employeeId ? await db.prepare(sql).bind(employeeId).all<EmployeeRow>() : await db.prepare(sql).all<EmployeeRow>();
  const rows = { results: employeeId ? result.results : result.results.filter((row) => !LEAVE_EXEMPT_POSITIONS.includes(row.position.trim())) };
  // 퇴직일은 퇴직 요청에서. 효력이 생긴 요청만 발생을 끊는다.
  const exits = await readOptionalHrRows<{ employee_id: string; retirement_date: string }>(db, ["hr_retirement_requests"], "SELECT employee_id, retirement_date FROM hr_retirement_requests WHERE status IN ('EFFECTIVE', 'COMPLETED')");
  const exitByEmployee = new Map(exits.results.map((row) => [row.employee_id, row.retirement_date]));
  return rows.results.map((row) => ({ ...row, exit_date: exitByEmployee.get(row.employee_id) ?? "" }));
}

function toUsage(row: RequestRow): LeaveUsage {
  const kind = LEAVE_TYPE_TO_KIND[row.leave_type] ?? "OTHER";
  return { id: row.id, date: row.start_date, kind, units: row.units / 100, deducts: Boolean(row.deducts), note: row.reason };
}

async function buildLedgers(employeeId?: string) {
  const today = todayInKorea();
  const employees = await loadEmployees(employeeId);
  const requests = await db.prepare("SELECT * FROM hr_leave_requests WHERE status = 'APPROVED' ORDER BY start_date").all<RequestRow>();
  const adjustments = await db.prepare("SELECT * FROM hr_leave_grant_adjustments").all<AdjustmentRow>();
  const requestsByEmployee = new Map<string, RequestRow[]>();
  for (const row of requests.results) requestsByEmployee.set(row.employee_id, [...(requestsByEmployee.get(row.employee_id) ?? []), row]);
  const adjustmentsByEmployee = new Map<string, GrantAdjustment[]>();
  for (const row of adjustments.results) {
    const item: GrantAdjustment = { grantKey: row.grant_key, note: row.note, ...(row.status === "EXCLUDED" ? { status: "EXCLUDED" as const } : {}), ...(row.units === null ? {} : { units: row.units }) };
    adjustmentsByEmployee.set(row.employee_id, [...(adjustmentsByEmployee.get(row.employee_id) ?? []), item]);
  }
  return { today, ledgers: employees.map((employee) => {
    const rows = requestsByEmployee.get(employee.employee_id) ?? [];
    const ledger = computeLeaveLedger({ employeeId: employee.employee_id, joinDate: employee.join_date, exitDate: employee.exit_date, today, usages: rows.map(toUsage), adjustments: adjustmentsByEmployee.get(employee.employee_id) ?? [] });
    return {
      employeeId: employee.employee_id, name: employee.name, department: employee.department, email: employee.email, status: employee.status,
      joinDate: ledger.joinDate, exitDate: ledger.exitDate,
      granted: ledger.granted, grantedByKind: ledger.grantedByKind, used: ledger.used, expired: ledger.expired, balance: ledger.balance, overdraft: ledger.overdraft, nonDeductedUnits: ledger.nonDeductedUnits,
      promotions: ledger.promotions.map((notice) => ({ ...notice, text: promotionNoticeText(employee.name, notice) })),
      grants: ledger.grants,
      usages: rows.map((row) => ({ ...toUsage(row), leaveType: row.leave_type, endDate: row.end_date, source: row.source, recordedBy: row.recorded_by, label: LEAVE_KINDS[LEAVE_TYPE_TO_KIND[row.leave_type] ?? "OTHER"].label })),
    };
  }) };
}

export async function GET(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "read");
  if (authorization.response) return authorization.response;
  const employeeId = new URL(request.url).searchParams.get("employeeId")?.trim() || undefined;
  const { today, ledgers } = await buildLedgers(employeeId);
  if (employeeId) {
    if (!ledgers.length) return Response.json({ error: "직원을 찾을 수 없습니다." }, { status: 404 });
    return Response.json({ today, kinds: LEAVE_KINDS, ledger: ledgers[0] });
  }
  // 목록에는 발생·사용 상세를 싣지 않는다. 사람이 29명이라도 발생분이 수백 건이라 표 화면에는 요약이면 충분하다.
  return Response.json({ today, kinds: LEAVE_KINDS, ledgers: ledgers.map(({ grants, usages, ...summary }) => ({ ...summary, grantCount: grants.length, usageCount: usages.length })) });
}

type RecordInput = { employeeId: string; leaveType: string; startDate: string; endDate: string; units: number; note: string; source: string };

function parseRecord(body: Record<string, unknown>): RecordInput | string {
  const employeeId = String(body.employeeId ?? "").trim();
  const leaveType = String(body.leaveType ?? "").trim();
  const startDate = normalizeDate(body.startDate ?? body.date);
  const endDate = body.endDate === undefined || body.endDate === null || body.endDate === "" ? startDate : normalizeDate(body.endDate);
  const kind = LEAVE_TYPE_TO_KIND[leaveType];
  if (!employeeId || !kind || !RECORDABLE_TYPES.includes(leaveType)) return "직원과 휴가 종류를 확인해 주세요.";
  if (!startDate || !endDate || endDate < startDate) return "날짜를 확인해 주세요.";
  const units = body.units === undefined || body.units === null || body.units === "" ? LEAVE_KINDS[kind].units : Number(body.units);
  if (!Number.isFinite(units) || units <= 0 || Math.round(units * 4) !== units * 4) return "일수는 0.25 단위의 양수여야 합니다.";
  return { employeeId, leaveType, startDate, endDate, units, note: String(body.note ?? body.reason ?? "").trim(), source: String(body.source ?? "ERP") };
}

function insertRecord(record: RecordInput, id: string, recordedBy: string, now: number) {
  const kind = LEAVE_TYPE_TO_KIND[record.leaveType];
  return db.prepare(`INSERT INTO hr_leave_requests
    (id, employee_id, leave_type, start_date, end_date, units, reason, status, approver_employee_id, decided_at, created_at, updated_at, deducts, source, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, record.employeeId, record.leaveType, record.startDate, record.endDate, Math.round(record.units * 100), record.note, recordedBy, now, now, now, LEAVE_KINDS[kind].deducts ? 1 : 0, record.source, recordedBy);
}

export async function POST(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  const body = await request.json() as Record<string, unknown>;
  const resource = String(body.resource ?? "record");
  const now = Date.now();
  const actor = authorization.principal.employeeId;

  if (resource === "record") {
    const record = parseRecord(body);
    if (typeof record === "string") return Response.json({ error: record }, { status: 400 });
    const known = await db.prepare("SELECT employee_id FROM hr_employee_records WHERE employee_id = ?").bind(record.employeeId).first<{ employee_id: string }>();
    if (!known) return Response.json({ error: "인사기록카드에 없는 직원입니다." }, { status: 404 });
    const id = crypto.randomUUID();
    await insertRecord({ ...record, source: "ERP" }, id, actor, now).run();
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "LEAVE_RECORDED", entityType: "leaveRequest", entityId: id, before: null, after: { ...record, id } });
    return Response.json({ id, ledger: (await buildLedgers(record.employeeId)).ledgers[0] }, { status: 201 });
  }

  if (resource === "adjustment") {
    const employeeId = String(body.employeeId ?? "").trim();
    const grantKey = String(body.grantKey ?? "").trim();
    const status = body.status === "EXCLUDED" ? "EXCLUDED" : "";
    const units = body.units === undefined || body.units === null || body.units === "" ? null : Number(body.units);
    if (!employeeId || !/^(MONTHLY-\d{1,2}|ANNUAL-\d{1,2})$/.test(grantKey)) return Response.json({ error: "직원과 발생 항목을 확인해 주세요." }, { status: 400 });
    if (!await db.prepare("SELECT employee_id FROM hr_employee_records WHERE employee_id = ?").bind(employeeId).first()) {
      return Response.json({ error: "인사기록카드에 없는 직원입니다." }, { status: 404 });
    }
    if (units !== null && (!Number.isFinite(units) || units < 0 || Math.round(units * 4) !== units * 4)) return Response.json({ error: "일수는 0.25 단위여야 합니다." }, { status: 400 });
    const note = String(body.note ?? "").trim();
    const before = await db.prepare("SELECT * FROM hr_leave_grant_adjustments WHERE employee_id = ? AND grant_key = ?").bind(employeeId, grantKey).first<AdjustmentRow>();
    if (!status && units === null) {
      // 조정을 지우면 자동 계산으로 돌아간다.
      await db.prepare("DELETE FROM hr_leave_grant_adjustments WHERE employee_id = ? AND grant_key = ?").bind(employeeId, grantKey).run();
    } else {
      await db.prepare(`INSERT INTO hr_leave_grant_adjustments (id, employee_id, grant_key, status, units, note, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(employee_id, grant_key) DO UPDATE SET status = excluded.status, units = excluded.units, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .bind(before?.id ?? crypto.randomUUID(), employeeId, grantKey, status, units, note, actor, now).run();
    }
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "LEAVE_GRANT_ADJUSTED", entityType: "leaveGrantAdjustment", entityId: `${employeeId}:${grantKey}`, before, after: status || units !== null ? { employeeId, grantKey, status, units, note } : null });
    return Response.json({ ledger: (await buildLedgers(employeeId)).ledgers[0] });
  }

  if (resource === "import") {
    // 시트 이관. 같은 직원의 예전 이관분을 지우고 다시 넣으므로 여러 번 돌려도 중복되지 않는다.
    const rows = Array.isArray(body.records) ? body.records as Record<string, unknown>[] : [];
    const adjustments = Array.isArray(body.adjustments) ? body.adjustments as Record<string, unknown>[] : [];
    const parsed: RecordInput[] = [];
    for (const [index, row] of rows.entries()) {
      const label = String(row.label ?? "");
      const leaveType = String(row.leaveType ?? (label ? leaveKindFromLabel(label) ?? "" : ""));
      const record = parseRecord({ ...row, leaveType });
      if (typeof record === "string") return Response.json({ error: `${index + 1}번째 기록: ${record}` }, { status: 400 });
      parsed.push({ ...record, source: "SHEET_IMPORT" });
    }
    const employeeIds = [...new Set([...parsed.map((record) => record.employeeId), ...adjustments.map((item) => String(item.employeeId ?? ""))])].filter(Boolean);
    for (const employeeId of employeeIds) {
      if (!await db.prepare("SELECT employee_id FROM hr_employee_records WHERE employee_id = ?").bind(employeeId).first()) {
        return Response.json({ error: "인사기록카드에 없는 직원의 기록은 이관할 수 없습니다." }, { status: 404 });
      }
    }
    const statements = employeeIds.map((employeeId) => db.prepare("DELETE FROM hr_leave_requests WHERE employee_id = ? AND source = 'SHEET_IMPORT'").bind(employeeId));
    statements.push(...parsed.map((record) => insertRecord(record, crypto.randomUUID(), actor, now)));
    for (const item of adjustments) {
      const employeeId = String(item.employeeId ?? "").trim(); const grantKey = String(item.grantKey ?? "").trim();
      if (!employeeId || !/^(MONTHLY-\d{1,2}|ANNUAL-\d{1,2})$/.test(grantKey)) return Response.json({ error: `조정 항목을 확인해 주세요: ${employeeId} ${grantKey}` }, { status: 400 });
      statements.push(db.prepare(`INSERT INTO hr_leave_grant_adjustments (id, employee_id, grant_key, status, units, note, updated_by, updated_at)
        VALUES (?, ?, ?, 'EXCLUDED', NULL, ?, ?, ?) ON CONFLICT(employee_id, grant_key) DO UPDATE SET status = 'EXCLUDED', note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .bind(crypto.randomUUID(), employeeId, grantKey, String(item.note ?? "시트 이관: 제외"), actor, now));
    }
    if (statements.length) await db.batch(statements);
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "LEAVE_SHEET_IMPORTED", entityType: "leaveLedger", entityId: "sheet-import", before: null, after: { employees: employeeIds.length, records: parsed.length, adjustments: adjustments.length } });
    return Response.json({ imported: parsed.length, adjustments: adjustments.length, employees: employeeIds.length, ledgers: (await buildLedgers()).ledgers.filter((ledger) => employeeIds.includes(ledger.employeeId)).map(({ grants, usages, ...summary }) => ({ ...summary, grantCount: grants.length, usageCount: usages.length })) });
  }

  return Response.json({ error: "알 수 없는 요청입니다." }, { status: 400 });
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  const before = await db.prepare("SELECT * FROM hr_leave_requests WHERE id = ?").bind(id).first<RequestRow>();
  if (!before) return Response.json({ error: "기록을 찾을 수 없습니다." }, { status: 404 });
  // 결재를 거친 신청은 결재 기록이 근거라 여기서 지우지 않는다.
  const workflow = await db.prepare("SELECT id FROM erp_approval_requests WHERE target_entity_type = 'HR_LEAVE' AND target_entity_id = ? LIMIT 1").bind(id).first<{ id: string }>();
  if (workflow) return Response.json({ error: "전자결재를 거친 휴가 신청은 결재에서 취소해 주세요." }, { status: 409 });
  await db.prepare("DELETE FROM hr_leave_requests WHERE id = ?").bind(id).run();
  await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "LEAVE_RECORD_DELETED", entityType: "leaveRequest", entityId: id, before, after: null });
  return Response.json({ ledger: (await buildLedgers(before.employee_id)).ledgers[0] });
}
