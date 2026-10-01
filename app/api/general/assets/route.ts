import { env } from "cloudflare:workers";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { ensureGaSchema } from "../../../ga-schema";
import { kstToday } from "../../../ga-alerts";
import {
  GA_ASSET_KINDS, FieldError, amount, assetDepreciation, assetDto, assetFields, date, employee, eventStatement, fieldResponse, flag, gaConflict,
  gaDuplicate, gaNotFound, gaPeople, gaValidation, isUnique, prepareAssetCreate, readBody, text, type GaAssetKind, type GaAssetRow,
} from "../../../ga-server";

// general-affairs Design §2·§4. GET(general:read) 목록·상세, POST(general:write) 생성·수정·작업.
// 상태 전이는 WHERE status IN (<from>) 조건부 UPDATE 로 하고, 바뀐 행이 0이면 409 CONFLICT 다.
// 감사에는 id·자산번호·상태·수량·금액만 남긴다(시리얼·계약번호·메모 없음).
const db = (env as unknown as { DB: D1Database }).DB;

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "read");
  if (authorization.response) return authorization.response;
  await ensureGaSchema(db);
  const params = new URL(request.url).searchParams;
  const now = Date.now();
  const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
  const id = params.get("id");
  if (id) {
    const row = await db.prepare(`SELECT * FROM ga_assets WHERE id = ? AND deleted_at IS NULL`).bind(id).first<GaAssetRow>();
    if (!row) return gaNotFound("자산");
    const [events, attachments] = await Promise.all([
      db.prepare(`SELECT * FROM ga_asset_events WHERE asset_id = ? ORDER BY created_at DESC LIMIT 200`).bind(id)
        .all<{ id: string; kind: string; event_on: string; employee_id: string | null; quantity_delta: number; location: string; amount: number; reason: string; recorded_by: string; created_at: number }>(),
      db.prepare(`SELECT id, file_name, content_type, size, created_at FROM ga_attachments WHERE owner_type = 'ASSET' AND owner_id = ? AND deleted_at IS NULL ORDER BY created_at`).bind(id)
        .all<{ id: string; file_name: string; content_type: string; size: number; created_at: number }>(),
    ]);
    return Response.json({
      asset: assetDto(row, people, now),
      depreciation: assetDepreciation(row, now),
      events: events.results.map((event) => ({
        id: event.id, kind: event.kind, on: event.event_on, employeeId: event.employee_id,
        employeeName: event.employee_id ? people.get(event.employee_id)?.name ?? "" : "", quantityDelta: event.quantity_delta,
        location: event.location, amount: event.amount, reason: event.reason, createdAt: event.created_at,
      })),
      attachments: attachments.results.map((file) => ({ id: file.id, fileName: file.file_name, contentType: file.content_type, size: file.size,
        isImage: file.content_type.startsWith("image/"), url: `/api/general/attachments?id=${encodeURIComponent(file.id)}` })),
    });
  }
  const kind = params.get("kind");
  const where = ["deleted_at IS NULL"];
  const binds: unknown[] = [];
  if (kind && (GA_ASSET_KINDS as readonly string[]).includes(kind)) { where.push("kind = ?"); binds.push(kind); }
  const holder = params.get("holder");
  if (holder) { where.push("holder_employee_id = ? AND status IN ('ASSIGNED','REPAIR')"); binds.push(holder); }
  const rows = await db.prepare(`SELECT * FROM ga_assets WHERE ${where.join(" AND ")} ORDER BY kind, asset_no`).bind(...binds).all<GaAssetRow>();
  return Response.json({ assets: rows.results.map((row) => assetDto(row, people, now)) });
}

type Principal = { userId: string; email: string; employeeId: string };

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  await ensureGaSchema(db);
  const payload = await readBody(request);
  if (!payload) return gaValidation("요청 내용을 읽을 수 없습니다.");
  const action = typeof payload.action === "string" ? payload.action : "";
  try {
    if (action === "CREATE") return await createAsset(principal, payload);
    if (action === "UPDATE") return await updateAsset(principal, payload);
    return await assetAction(principal, action, payload);
  } catch (error) {
    const response = fieldResponse(error);
    if (response) return response;
    throw error;
  }
}

async function loadAsset(id: unknown) {
  if (typeof id !== "string" || !id.startsWith("gaa_")) return null;
  return db.prepare(`SELECT * FROM ga_assets WHERE id = ? AND deleted_at IS NULL`).bind(id).first<GaAssetRow>();
}

async function respond(id: string, status = 200) {
  const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
  const row = await db.prepare(`SELECT * FROM ga_assets WHERE id = ?`).bind(id).first<GaAssetRow>();
  return Response.json({ asset: row ? assetDto(row, people, Date.now()) : null }, { status });
}

async function createAsset(principal: Principal, payload: Record<string, unknown>) {
  const kind = payload.kind as GaAssetKind;
  if (!GA_ASSET_KINDS.includes(kind)) return gaValidation("자산 유형을 골라 주세요.", "kind");
  const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
  const prepared = await prepareAssetCreate(db, payload, kind, people, { by: principal.userId, now: Date.now() });
  try {
    await db.batch(prepared.statements);
  } catch (error) {
    if (isUnique(error)) return gaDuplicate("같은 자산번호가 이미 있습니다.");
    throw error;
  }
  await writeErpAudit(db, { principal, module: "general", action: "GA_ASSET_CREATED", entityType: "GA_ASSET", entityId: prepared.id,
    after: { assetNo: prepared.assetNo, kind, status: prepared.status, quantity: prepared.quantity, acquisitionCost: prepared.acquisitionCost } });
  return respond(prepared.id, 201);
}

async function updateAsset(principal: Principal, payload: Record<string, unknown>) {
  const asset = await loadAsset(payload.id);
  if (!asset) return gaNotFound("자산");
  const kind = asset.kind as GaAssetKind;
  const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
  const fields = assetFields(payload, kind, people);
  const holder = kind === "FIXED" ? employee(payload, "holderEmployeeId", "사용자", people) : asset.holder_employee_id;
  const alertOff = flag(payload, "alertOff", asset.alert_off === 1);
  const requestedNo = payload.assetNo === undefined ? asset.asset_no : text(payload, "assetNo", "자산번호", { max: 40, required: true });
  const now = Date.now();
  try {
    const result = await db.prepare(`UPDATE ga_assets SET asset_no = ?, name = ?, category = ?, location = ?, holder_employee_id = ?, acquired_on = ?,
      acquisition_cost = ?, vendor = ?, model = ?, serial_no = ?, unit = ?, min_quantity = ?, counterparty = ?, contract_no = ?, starts_on = ?, ends_on = ?,
      auto_renew = ?, renewal_cost = ?, billing_cycle = ?, manager_employee_id = ?, useful_life_months = ?, residual_value = ?, opening_accumulated = ?,
      opening_as_of = ?, alert_off = ?, memo = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND updated_at = ?`)
      .bind(requestedNo, fields.name, fields.category, fields.location, holder, fields.acquired_on, fields.acquisition_cost, fields.vendor, fields.model,
        fields.serial_no, fields.unit, fields.min_quantity, fields.counterparty, fields.contract_no, fields.starts_on, fields.ends_on, fields.auto_renew,
        fields.renewal_cost, fields.billing_cycle, fields.manager_employee_id, fields.useful_life_months, fields.residual_value, fields.opening_accumulated,
        fields.opening_as_of, alertOff, fields.memo, now, asset.id, typeof payload.updatedAt === "number" ? payload.updatedAt : asset.updated_at).run();
    if (!result.meta.changes) return gaConflict();
  } catch (error) {
    if (isUnique(error)) return gaDuplicate("같은 자산번호가 이미 있습니다.");
    throw error;
  }
  await writeErpAudit(db, { principal, module: "general", action: "GA_ASSET_UPDATED", entityType: "GA_ASSET", entityId: asset.id,
    before: { assetNo: asset.asset_no, acquisitionCost: asset.acquisition_cost }, after: { assetNo: requestedNo, acquisitionCost: fields.acquisition_cost } });
  return respond(asset.id);
}

/** 작업(action)별 허용 유형과 이전 상태 → 다음 상태. */
const TRANSITIONS: Record<string, { kinds: GaAssetKind[]; from: string[]; to?: string; event: string }> = {
  ASSIGN: { kinds: ["EQUIPMENT"], from: ["IN_STOCK"], to: "ASSIGNED", event: "ASSIGNED" },
  RETURN: { kinds: ["EQUIPMENT"], from: ["ASSIGNED"], to: "IN_STOCK", event: "RETURNED" },
  MOVE: { kinds: ["EQUIPMENT", "SUPPLY", "FIXED"], from: ["IN_STOCK", "ASSIGNED", "REPAIR", "ACTIVE"], event: "MOVED" },
  STOCK_IN: { kinds: ["SUPPLY"], from: ["ACTIVE"], event: "STOCK_IN" },
  STOCK_OUT: { kinds: ["SUPPLY"], from: ["ACTIVE"], event: "STOCK_OUT" },
  REPAIR: { kinds: ["EQUIPMENT"], from: ["IN_STOCK", "ASSIGNED"], to: "REPAIR", event: "REPAIR" },
  REPAIRED: { kinds: ["EQUIPMENT"], from: ["REPAIR"], event: "REPAIRED" },
  RENEW: { kinds: ["CONTRACT"], from: ["ACTIVE", "ENDED"], to: "ACTIVE", event: "RENEWED" },
  END: { kinds: ["CONTRACT"], from: ["ACTIVE"], to: "ENDED", event: "ENDED" },
  DISPOSE: { kinds: ["EQUIPMENT", "SUPPLY", "CONTRACT", "FIXED"], from: ["IN_STOCK", "ASSIGNED", "REPAIR", "ACTIVE", "ENDED"], to: "DISPOSED", event: "DISPOSED" },
};

async function assetAction(principal: Principal, action: string, payload: Record<string, unknown>) {
  if (action === "DELETE") {
    const asset = await loadAsset(payload.id);
    if (!asset) return gaNotFound("자산");
    const now = Date.now();
    await db.batch([
      db.prepare(`UPDATE ga_assets SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).bind(now, now, asset.id),
      db.prepare(`UPDATE ga_attachments SET deleted_at = ? WHERE owner_type = 'ASSET' AND owner_id = ? AND deleted_at IS NULL`).bind(now, asset.id),
    ]);
    await writeErpAudit(db, { principal, module: "general", action: "GA_ASSET_DELETED", entityType: "GA_ASSET", entityId: asset.id, before: { assetNo: asset.asset_no, status: asset.status } });
    return Response.json({ ok: true });
  }
  const rule = TRANSITIONS[action];
  if (!rule) return gaValidation("알 수 없는 요청입니다.", "action");
  const asset = await loadAsset(payload.id);
  if (!asset) return gaNotFound("자산");
  const kind = asset.kind as GaAssetKind;
  if (!rule.kinds.includes(kind)) return gaValidation("이 자산 유형에는 할 수 없는 작업입니다.", "action");
  if (!rule.from.includes(asset.status)) return gaConflict("지금 상태에서는 할 수 없는 작업입니다. 새로고침해 주세요.");
  const now = Date.now();
  const on = date(payload, "on", "날짜") ?? kstToday(now);
  const reason = text(payload, "reason", "사유", { max: 500, required: action === "DISPOSE" });
  const fromList = rule.from.map(() => "?").join(",");
  let update: D1PreparedStatement;
  let event = { employeeId: null as string | null, quantityDelta: 0, location: "", amount: 0 };
  switch (action) {
    case "ASSIGN": {
      const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
      const holder = employee(payload, "employeeId", "사용자", people, { required: true });
      const location = text(payload, "location", "위치", { max: 120 }) || asset.location;
      update = db.prepare(`UPDATE ga_assets SET status = 'ASSIGNED', holder_employee_id = ?, location = ?, updated_at = ? WHERE id = ? AND status IN (${fromList})`)
        .bind(holder, location, now, asset.id, ...rule.from);
      event = { ...event, employeeId: holder, location };
      break;
    }
    case "RETURN": {
      const location = text(payload, "location", "위치", { max: 120 }) || asset.location;
      update = db.prepare(`UPDATE ga_assets SET status = 'IN_STOCK', holder_employee_id = NULL, location = ?, updated_at = ? WHERE id = ? AND status IN (${fromList})`)
        .bind(location, now, asset.id, ...rule.from);
      event = { ...event, employeeId: asset.holder_employee_id, location };
      break;
    }
    case "MOVE": {
      const location = text(payload, "location", "위치", { max: 120, required: true });
      update = db.prepare(`UPDATE ga_assets SET location = ?, updated_at = ? WHERE id = ? AND status IN (${fromList})`).bind(location, now, asset.id, ...rule.from);
      event = { ...event, location };
      break;
    }
    case "STOCK_IN":
    case "STOCK_OUT": {
      const quantity = amount(payload, "quantity", "수량", { required: true });
      if (quantity < 1) throw new FieldError("quantity", "수량은 1 이상입니다.");
      const delta = action === "STOCK_IN" ? quantity : -quantity;
      if (action === "STOCK_OUT" && asset.quantity < quantity) return gaValidation(`재고가 부족합니다(현재 ${asset.quantity}${asset.unit}).`, "quantity");
      // 출고는 재고가 남아 있을 때만(동시 출고로 음수가 되지 않게 조건에 넣는다).
      update = db.prepare(`UPDATE ga_assets SET quantity = quantity + ?, updated_at = ? WHERE id = ? AND status IN (${fromList}) AND quantity + ? >= 0`)
        .bind(delta, now, asset.id, ...rule.from, delta);
      const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
      event = { ...event, quantityDelta: delta, employeeId: action === "STOCK_OUT" ? employee(payload, "employeeId", "받는 사람", people) : null };
      break;
    }
    case "REPAIR":
      update = db.prepare(`UPDATE ga_assets SET status = 'REPAIR', updated_at = ? WHERE id = ? AND status IN (${fromList})`).bind(now, asset.id, ...rule.from);
      break;
    case "REPAIRED":
      update = db.prepare(`UPDATE ga_assets SET status = CASE WHEN holder_employee_id IS NULL THEN 'IN_STOCK' ELSE 'ASSIGNED' END, updated_at = ?
        WHERE id = ? AND status IN (${fromList})`).bind(now, asset.id, ...rule.from);
      event = { ...event, amount: amount(payload, "amount", "수리비") };
      break;
    case "RENEW": {
      const endsOn = date(payload, "endsOn", "새 만료일", { required: true })!;
      if (asset.ends_on && endsOn <= asset.ends_on) throw new FieldError("endsOn", "새 만료일은 지금 만료일보다 뒤여야 합니다.");
      const cost = payload.renewalCost === undefined ? asset.renewal_cost : amount(payload, "renewalCost", "갱신비용");
      update = db.prepare(`UPDATE ga_assets SET status = 'ACTIVE', ends_on = ?, renewal_cost = ?, updated_at = ? WHERE id = ? AND status IN (${fromList})`)
        .bind(endsOn, cost, now, asset.id, ...rule.from);
      event = { ...event, amount: cost };
      break;
    }
    case "END":
      update = db.prepare(`UPDATE ga_assets SET status = 'ENDED', updated_at = ? WHERE id = ? AND status IN (${fromList})`).bind(now, asset.id, ...rule.from);
      break;
    default: {
      const disposalAmount = amount(payload, "amount", "처분가");
      update = db.prepare(`UPDATE ga_assets SET status = 'DISPOSED', holder_employee_id = NULL, disposed_on = ?, disposal_amount = ?, updated_at = ?
        WHERE id = ? AND status IN (${fromList})`).bind(on, disposalAmount, now, asset.id, ...rule.from);
      event = { ...event, amount: disposalAmount, employeeId: asset.holder_employee_id };
    }
  }
  const results = await db.batch([update, eventStatement(db, { assetId: asset.id, kind: rule.event, on, ...event, reason, by: principal.userId, now }, { onlyIfChanged: true })]);
  if (!results[0]?.meta?.changes) {
    return gaConflict(action === "STOCK_OUT" ? "재고가 부족합니다. 새로고침해 주세요." : undefined);
  }
  await writeErpAudit(db, { principal, module: "general", action: `GA_ASSET_${action}`, entityType: "GA_ASSET", entityId: asset.id,
    before: { status: asset.status, quantity: asset.quantity }, after: { status: rule.to ?? asset.status, quantityDelta: event.quantityDelta, amount: event.amount } });
  return respond(asset.id);
}
