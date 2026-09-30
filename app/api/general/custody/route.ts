import { env } from "cloudflare:workers";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { ensureGaSchema } from "../../../ga-schema";
import { kstToday } from "../../../ga-alerts";
import {
  GA_CUSTODY_KINDS, checkoutDto, checkoutLedger, date, employee, fieldResponse, gaConflict, gaId, gaNotFound, gaPeople, gaValidation, isUnique,
  oneOf, readBody, text,
} from "../../../ga-server";

// general-affairs Design §4 인감·서류 반출 대장(GA-D4: 결재 없이 기록만). GET(general:read), POST(general:write).
// 같은 대상의 열린 반출은 부분 UNIQUE 인덱스가 하나로 막는다(동시 기록도 409, GD-4). 감사에는 id·대상 종류만 남긴다(용도·제출처 없음).
const db = (env as unknown as { DB: D1Database }).DB;
const ALREADY_OUT = "이미 반출 중입니다. 먼저 반납 처리해 주세요.";

type ItemRow = { id: string; kind: string; name: string; storage_location: string; manager_employee_id: string | null; memo: string; updated_at: number };

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "read");
  if (authorization.response) return authorization.response;
  await ensureGaSchema(db);
  const params = new URL(request.url).searchParams;
  const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
  const [items, ledger] = await Promise.all([
    db.prepare(`SELECT * FROM ga_custody_items WHERE deleted_at IS NULL ORDER BY kind, name`).all<ItemRow>(),
    params.get("open") === "1"
      ? checkoutLedger(db, "c.returned_on IS NULL AND c.cancelled_at IS NULL")
      : checkoutLedger(db),
  ]);
  const openByTarget = new Map(ledger.filter((row) => !row.returned_on && row.cancelled_at === null).map((row) => [`${row.target_type}:${row.target_id}`, row]));
  const today = kstToday(Date.now());
  return Response.json({
    items: items.results.map((item) => {
      const open = openByTarget.get(`ITEM:${item.id}`);
      return {
        id: item.id, kind: item.kind, name: item.name, storageLocation: item.storage_location, managerEmployeeId: item.manager_employee_id,
        managerName: item.manager_employee_id ? people.get(item.manager_employee_id)?.name ?? "" : "", memo: item.memo, updatedAt: item.updated_at,
        openCheckout: open ? checkoutDto(open) : null,
      };
    }),
    checkouts: ledger.map((row) => ({ ...checkoutDto(row), overdue: !row.returned_on && Boolean(row.due_on) && String(row.due_on) < today })),
  });
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  await ensureGaSchema(db);
  const payload = await readBody(request);
  if (!payload) return gaValidation("요청 내용을 읽을 수 없습니다.");
  const now = Date.now();
  const action = payload.action;
  try {
    if (action === "CREATE_ITEM" || action === "UPDATE_ITEM") {
      const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
      const kind = oneOf(payload, "kind", "종류", GA_CUSTODY_KINDS, { required: true });
      const name = text(payload, "name", "이름", { required: true, max: 80 });
      const storage = text(payload, "storageLocation", "보관위치", { max: 120 });
      const manager = employee(payload, "managerEmployeeId", "관리책임자", people);
      const memo = text(payload, "memo", "메모", { max: 1000 });
      if (action === "CREATE_ITEM") {
        const id = gaId("gai");
        await db.prepare(`INSERT INTO ga_custody_items (id, kind, name, storage_location, manager_employee_id, memo, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, kind, name, storage, manager, memo, principal.userId, now, now).run();
        await writeErpAudit(db, { principal, module: "general", action: "GA_CUSTODY_ITEM_CREATED", entityType: "GA_CUSTODY_ITEM", entityId: id, after: { kind } });
        return Response.json({ id }, { status: 201 });
      }
      const result = await db.prepare(`UPDATE ga_custody_items SET kind = ?, name = ?, storage_location = ?, manager_employee_id = ?, memo = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL`).bind(kind, name, storage, manager, memo, now, String(payload.id ?? "")).run();
      if (!result.meta.changes) return gaNotFound("보관품");
      await writeErpAudit(db, { principal, module: "general", action: "GA_CUSTODY_ITEM_UPDATED", entityType: "GA_CUSTODY_ITEM", entityId: String(payload.id), after: { kind } });
      return Response.json({ ok: true });
    }
    if (action === "DELETE_ITEM") {
      const id = String(payload.id ?? "");
      const open = await db.prepare(`SELECT 1 FROM ga_checkouts WHERE target_type = 'ITEM' AND target_id = ? AND returned_on IS NULL AND cancelled_at IS NULL`).bind(id).first();
      if (open) return gaConflict("반출 중인 보관품은 지울 수 없습니다.");
      const result = await db.prepare(`UPDATE ga_custody_items SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).bind(now, now, id).run();
      if (!result.meta.changes) return gaNotFound("보관품");
      await writeErpAudit(db, { principal, module: "general", action: "GA_CUSTODY_ITEM_DELETED", entityType: "GA_CUSTODY_ITEM", entityId: id });
      return Response.json({ ok: true });
    }
    if (action === "CHECKOUT") return await checkout(principal, payload, now);
    if (action === "RETURN" || action === "UPDATE_DUE" || action === "CANCEL") return await changeCheckout(principal, action, payload, now);
    return gaValidation("알 수 없는 요청입니다.", "action");
  } catch (error) {
    const response = fieldResponse(error);
    if (response) return response;
    throw error;
  }
}

async function targetExists(targetType: string, targetId: string) {
  const table = targetType === "ITEM" ? "ga_custody_items" : "ga_documents";
  return Boolean(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`).bind(targetId).first());
}

async function checkout(principal: { userId: string; email: string; employeeId: string }, payload: Record<string, unknown>, now: number) {
  const targetType = oneOf(payload, "targetType", "대상 종류", ["ITEM", "DOCUMENT"], { required: true });
  const targetId = text(payload, "targetId", "대상", { required: true, max: 80 });
  if (!(await targetExists(targetType, targetId))) return gaNotFound("반출 대상");
  const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
  const borrower = employee(payload, "borrowerEmployeeId", "반출자", people, { required: true })!;
  const purpose = text(payload, "purpose", "용도", { required: true, max: 200 });
  const submitTo = text(payload, "submitTo", "제출처", { max: 120 });
  const outOn = date(payload, "outOn", "반출일") ?? kstToday(now);
  const dueOn = date(payload, "dueOn", "반납예정일");
  if (dueOn && dueOn < outOn) return gaValidation("반납예정일이 반출일보다 앞섭니다.", "dueOn");
  const id = gaId("gac");
  try {
    await db.prepare(`INSERT INTO ga_checkouts (id, target_type, target_id, borrower_employee_id, purpose, submit_to, out_on, due_on, recorded_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, targetType, targetId, borrower, purpose, submitTo, outOn, dueOn, principal.userId, now, now).run();
  } catch (error) {
    if (isUnique(error)) return gaConflict(ALREADY_OUT);
    throw error;
  }
  await writeErpAudit(db, { principal, module: "general", action: "GA_CHECKOUT_RECORDED", entityType: "GA_CHECKOUT", entityId: id, after: { targetType, targetId, outOn, dueOn } });
  return Response.json({ id }, { status: 201 });
}

async function changeCheckout(principal: { userId: string; email: string; employeeId: string }, action: string, payload: Record<string, unknown>, now: number) {
  const id = String(payload.id ?? "");
  const row = await db.prepare(`SELECT * FROM ga_checkouts WHERE id = ? AND cancelled_at IS NULL`).bind(id).first<{ id: string; out_on: string; returned_on: string | null }>();
  if (!row) return gaNotFound("반출 기록");
  if (row.returned_on && action !== "CANCEL") return gaConflict("이미 반납된 기록입니다.");
  let statement: D1PreparedStatement;
  let after: Record<string, unknown>;
  if (action === "RETURN") {
    const returnedOn = date(payload, "returnedOn", "반납일") ?? kstToday(now);
    if (returnedOn < row.out_on) return gaValidation("반납일이 반출일보다 앞섭니다.", "returnedOn");
    statement = db.prepare(`UPDATE ga_checkouts SET returned_on = ?, received_by = ?, return_memo = ?, updated_at = ? WHERE id = ? AND returned_on IS NULL AND cancelled_at IS NULL`)
      .bind(returnedOn, text(payload, "receivedBy", "받은사람", { max: 60 }), text(payload, "memo", "메모", { max: 1000 }), now, id);
    after = { returnedOn };
  } else if (action === "UPDATE_DUE") {
    const dueOn = date(payload, "dueOn", "반납예정일");
    if (dueOn && dueOn < row.out_on) return gaValidation("반납예정일이 반출일보다 앞섭니다.", "dueOn");
    statement = db.prepare(`UPDATE ga_checkouts SET due_on = ?, updated_at = ? WHERE id = ? AND returned_on IS NULL AND cancelled_at IS NULL`).bind(dueOn, now, id);
    after = { dueOn };
  } else {
    statement = db.prepare(`UPDATE ga_checkouts SET cancelled_at = ?, updated_at = ? WHERE id = ? AND cancelled_at IS NULL`).bind(now, now, id);
    after = { cancelled: true };
  }
  const result = await statement.run();
  if (!result.meta.changes) return gaConflict();
  await writeErpAudit(db, { principal, module: "general", action: `GA_CHECKOUT_${action}`, entityType: "GA_CHECKOUT", entityId: id, after });
  return Response.json({ ok: true });
}
