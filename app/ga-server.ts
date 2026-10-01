// 총무 서버 공용(general-affairs Design §2·§4). /api/general/* 라우트와 HR 퇴직 자산 조회가 쓴다.
// 입력 검증은 여기 한곳에서 한다. 가져오기(ga-import.ts)는 엑셀 값을 이 API 필드로 바꿔 같은 검증을 탄다.
import { erpError } from "./erp-platform";
import { readOptionalHrRows } from "./hr-optional-tables";
import { depreciationAsOf, isDate, kstToday, type AlertAssetRow, type AlertCheckoutRow, type AlertDocumentRow } from "./ga-alerts";

export type GaAssetKind = "EQUIPMENT" | "SUPPLY" | "CONTRACT" | "FIXED";
export const GA_ASSET_KINDS: readonly GaAssetKind[] = ["EQUIPMENT", "SUPPLY", "CONTRACT", "FIXED"];
export const GA_DOCUMENT_KINDS = ["BUSINESS_REG", "CORP_REGISTRY", "SEAL_CERT", "SEAL_USAGE", "CERTIFICATE", "PERMIT", "B2B_CONTRACT", "OTHER"] as const;
export const GA_CONTRACT_TYPES = ["SUPPLY", "PARTNER", "SERVICE", "NDA", "OTHER"] as const;
export const GA_CUSTODY_KINDS = ["CORP_SEAL", "USAGE_SEAL", "OTHER"] as const;
const ASSET_PREFIX: Record<GaAssetKind, string> = { EQUIPMENT: "EQ", SUPPLY: "SU", CONTRACT: "CT", FIXED: "FA" };
const BILLING = new Set(["", "MONTHLY", "QUARTERLY", "YEARLY", "ONCE"]);

export const gaValidation = (error: string, field?: string) => erpError(400, "VALIDATION", error, field ? { field } : {});
export const gaNotFound = (what = "항목") => erpError(404, "NOT_FOUND", `${what}을(를) 찾을 수 없습니다.`);
export const gaConflict = (error = "다른 사용자가 먼저 상태를 바꿨습니다. 새로고침해 주세요.") => erpError(409, "CONFLICT", error);
export const gaDuplicate = (error: string) => erpError(409, "DUPLICATE", error);

export function gaId(prefix: string) { return `${prefix}_${crypto.randomUUID()}`; }

export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function isUnique(error: unknown) {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

// ── 직원 ─────────────────────────────────────────────────────────────────
export type GaPerson = { employeeId: string; name: string; department: string; status: string };

/** 인사기록 최소 명부(이름·부서·상태). 표가 없으면(새 DB) 빈 목록. 급여·연락처는 읽지 않는다. */
export async function gaPeople(db: D1Database): Promise<GaPerson[]> {
  const rows = await readOptionalHrRows<{ employee_id: string; name: string; department: string; status: string }>(db, ["hr_employee_records"],
    "SELECT employee_id, name, department, status FROM hr_employee_records");
  return rows.results
    .map((row) => ({ employeeId: row.employee_id, name: row.name ?? "", department: row.department ?? "", status: row.status ?? "" }))
    .sort((a, b) => Number(a.status.trim() === "퇴직") - Number(b.status.trim() === "퇴직") || a.name.localeCompare(b.name, "ko"));
}

// ── 필드 검증 ────────────────────────────────────────────────────────────
export class FieldError extends Error {
  constructor(public field: string, message: string) { super(message); }
}

export function text(input: Record<string, unknown>, field: string, label: string, { max = 200, required = false } = {}) {
  const value = input[field];
  if (value === undefined || value === null || value === "") {
    if (required) throw new FieldError(field, `${label}을(를) 입력해 주세요.`);
    return "";
  }
  if (typeof value !== "string") throw new FieldError(field, `${label} 값을 확인해 주세요.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new FieldError(field, `${label}을(를) 입력해 주세요.`);
  if (trimmed.length > max) throw new FieldError(field, `${label}은(는) ${max}자까지입니다.`);
  return trimmed;
}

export function date(input: Record<string, unknown>, field: string, label: string, { required = false } = {}) {
  const value = input[field];
  if (value === undefined || value === null || value === "") {
    if (required) throw new FieldError(field, `${label}을(를) 입력해 주세요.`);
    return null;
  }
  if (!isDate(value)) throw new FieldError(field, `${label}은(는) 2026-10-01 형식의 날짜입니다.`);
  return value;
}

export function amount(input: Record<string, unknown>, field: string, label: string, { required = false } = {}) {
  const value = input[field];
  if (value === undefined || value === null || value === "") {
    if (required) throw new FieldError(field, `${label}을(를) 입력해 주세요.`);
    return 0;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new FieldError(field, `${label}은(는) 0 이상의 정수입니다.`);
  return value;
}

export function flag(input: Record<string, unknown>, field: string, fallback = false) {
  const value = input[field];
  if (value === undefined || value === null) return fallback ? 1 : 0;
  if (typeof value !== "boolean") throw new FieldError(field, "예/아니오 값을 확인해 주세요.");
  return value ? 1 : 0;
}

export function oneOf<T extends string>(input: Record<string, unknown>, field: string, label: string, allowed: readonly T[], { required = false } = {}): T | "" {
  const value = input[field];
  if (value === undefined || value === null || value === "") {
    if (required) throw new FieldError(field, `${label}을(를) 골라 주세요.`);
    return "";
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new FieldError(field, `${label} 값을 확인해 주세요.`);
  return value as T;
}

/** 직원 id: 인사기록에 있어야 한다. 없으면(null/"") null. */
export function employee(input: Record<string, unknown>, field: string, label: string, people: Map<string, GaPerson>, { required = false } = {}) {
  const value = input[field];
  if (value === undefined || value === null || value === "") {
    if (required) throw new FieldError(field, `${label}을(를) 골라 주세요.`);
    return null;
  }
  if (typeof value !== "string" || !people.has(value)) throw new FieldError(field, `${label}을(를) 인사기록에서 찾을 수 없습니다.`);
  return value;
}

export function fieldResponse(error: unknown) {
  if (error instanceof FieldError) return gaValidation(error.message, error.field);
  return null;
}

// ── 자산 ─────────────────────────────────────────────────────────────────
export type GaAssetRow = AlertAssetRow & {
  asset_no: string; category: string; location: string; holder_employee_id: string | null; acquired_on: string | null;
  acquisition_cost: number; vendor: string; model: string; serial_no: string; contract_no: string; starts_on: string | null;
  auto_renew: number; renewal_cost: number; billing_cycle: string; manager_employee_id: string | null;
  useful_life_months: number; residual_value: number; opening_accumulated: number; opening_as_of: string | null;
  disposed_on: string | null; disposal_amount: number; memo: string; import_batch_id: string | null;
  created_by: string; created_at: number; updated_at: number;
};

/** 자산 편집 필드(종류·상태·사용자·수량은 작업(action)으로만 바꾼다. 생성·가져오기에서는 초기값을 받는다). */
export function assetFields(input: Record<string, unknown>, kind: GaAssetKind, people: Map<string, GaPerson>) {
  const fields = {
    name: text(input, "name", "이름", { required: true }),
    category: text(input, "category", "분류", { max: 60 }),
    location: text(input, "location", "위치", { max: 120 }),
    acquired_on: date(input, "acquiredOn", "취득일", { required: kind === "FIXED" }),
    acquisition_cost: amount(input, "acquisitionCost", kind === "SUPPLY" ? "단가" : "취득가", { required: kind === "FIXED" }),
    vendor: text(input, "vendor", "공급처", { max: 120 }),
    model: kind === "EQUIPMENT" ? text(input, "model", "모델", { max: 120 }) : "",
    serial_no: kind === "EQUIPMENT" ? text(input, "serialNo", "시리얼", { max: 120 }) : "",
    unit: kind === "SUPPLY" ? text(input, "unit", "단위", { max: 20 }) : "",
    min_quantity: kind === "SUPPLY" ? amount(input, "minQuantity", "최소수량") : 0,
    counterparty: kind === "CONTRACT" ? text(input, "counterparty", "계약처", { max: 120, required: true }) : "",
    contract_no: kind === "CONTRACT" ? text(input, "contractNo", "계약번호", { max: 80 }) : "",
    starts_on: kind === "CONTRACT" ? date(input, "startsOn", "시작일") : null,
    ends_on: kind === "CONTRACT" ? date(input, "endsOn", "만료일", { required: true }) : null,
    auto_renew: kind === "CONTRACT" ? flag(input, "autoRenew") : 0,
    renewal_cost: kind === "CONTRACT" ? amount(input, "renewalCost", "갱신비용") : 0,
    billing_cycle: kind === "CONTRACT" ? oneOf(input, "billingCycle", "결제주기", ["MONTHLY", "QUARTERLY", "YEARLY", "ONCE"]) : "",
    manager_employee_id: kind === "CONTRACT" ? employee(input, "managerEmployeeId", "담당자", people) : null,
    useful_life_months: kind === "FIXED" || kind === "EQUIPMENT" ? amount(input, "usefulLifeMonths", "내용연수", { required: kind === "FIXED" }) : 0,
    residual_value: kind === "FIXED" || kind === "EQUIPMENT" ? amount(input, "residualValue", "잔존가치") : 0,
    opening_accumulated: kind === "FIXED" || kind === "EQUIPMENT" ? amount(input, "openingAccumulated", "기초상각누계") : 0,
    opening_as_of: kind === "FIXED" || kind === "EQUIPMENT" ? date(input, "openingAsOf", "기초기준일") : null,
    memo: text(input, "memo", "메모", { max: 1000 }),
  };
  if (!BILLING.has(fields.billing_cycle)) throw new FieldError("billingCycle", "결제주기 값을 확인해 주세요.");
  if (fields.useful_life_months > 600) throw new FieldError("usefulLifeMonths", "내용연수는 600개월까지입니다.");
  if (fields.useful_life_months > 0 && fields.residual_value >= fields.acquisition_cost) throw new FieldError("residualValue", "잔존가치는 취득가보다 작아야 합니다.");
  if (fields.opening_accumulated > 0 && !fields.opening_as_of) throw new FieldError("openingAsOf", "기초상각누계의 기준일을 입력해 주세요.");
  if (fields.starts_on && fields.ends_on && fields.ends_on < fields.starts_on) throw new FieldError("endsOn", "만료일이 시작일보다 앞섭니다.");
  return fields;
}

/** 'GA-EQ-2026-0001'. 같은 접두사의 최대 일련 + 1(지워진 번호도 건너뛴다). */
export async function nextAssetNo(db: D1Database, kind: GaAssetKind, year: string, reserved: Set<string> = new Set()) {
  const prefix = `GA-${ASSET_PREFIX[kind]}-${year}-`;
  const row = await db.prepare(`SELECT MAX(CAST(substr(asset_no, ?) AS INTEGER)) AS n FROM ga_assets WHERE asset_no LIKE ? ESCAPE '\\'`)
    .bind(prefix.length + 1, `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`).first<{ n: number | null }>();
  let next = Number(row?.n ?? 0) + 1;
  while (reserved.has(`${prefix}${String(next).padStart(4, "0")}`)) next += 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

/** 자산 이력 한 줄. onlyIfChanged 면 바로 앞 문장(같은 batch)이 행을 바꿨을 때만 넣는다(SQLite changes()). */
export function eventStatement(db: D1Database, input: {
  assetId: string; kind: string; on: string; employeeId?: string | null; quantityDelta?: number; location?: string; amount?: number; reason?: string; by: string; now: number;
}, { onlyIfChanged = false } = {}) {
  return db.prepare(`INSERT INTO ga_asset_events (id, asset_id, kind, event_on, employee_id, quantity_delta, location, amount, reason, recorded_by, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${onlyIfChanged ? " WHERE changes() > 0" : ""}`).bind(gaId("gae"), input.assetId, input.kind, input.on, input.employeeId ?? null,
    input.quantityDelta ?? 0, input.location ?? "", input.amount ?? 0, (input.reason ?? "").slice(0, 500), input.by, input.now);
}

/**
 * 자산 생성 검증과 문장(화면 생성·엑셀 가져오기 공용). FieldError 를 던진다.
 * reservedNos 는 같은 가져오기 안에서 이미 쓴 자동 번호다(아직 DB 에 없음).
 */
export async function prepareAssetCreate(db: D1Database, payload: Record<string, unknown>, kind: GaAssetKind, people: Map<string, GaPerson>,
  options: { by: string; now: number; importBatchId?: string | null; reservedNos?: Set<string> }) {
  const fields = assetFields(payload, kind, people);
  const holder = kind === "EQUIPMENT" || kind === "FIXED" ? employee(payload, "holderEmployeeId", "사용자", people) : null;
  const quantity = kind === "SUPPLY" ? amount(payload, "quantity", "수량", { required: true }) : 0;
  const requestedStatus = typeof payload.status === "string" ? payload.status : "";
  let status = kind === "EQUIPMENT" ? (holder ? "ASSIGNED" : "IN_STOCK") : "ACTIVE";
  if (kind === "EQUIPMENT" && requestedStatus === "REPAIR") status = "REPAIR";
  if (kind === "EQUIPMENT" && requestedStatus === "IN_STOCK" && holder) throw new FieldError("status", "재고 상태에는 사용자를 넣지 않습니다.");
  if (kind === "EQUIPMENT" && requestedStatus === "ASSIGNED" && !holder) throw new FieldError("holderEmployeeId", "지급 상태면 사용자를 골라 주세요.");
  // 자동 갱신 계약은 기본으로 만료 알림을 끈다(켜려면 alertOff:false 를 보낸다).
  const alertOff = flag(payload, "alertOff", kind === "CONTRACT" && fields.auto_renew === 1);
  const today = kstToday(options.now);
  const requestedNo = text(payload, "assetNo", "자산번호", { max: 40 });
  if (requestedNo && !/^[A-Za-z0-9가-힣._-]+$/.test(requestedNo)) throw new FieldError("assetNo", "자산번호에는 글자·숫자·-·_·. 만 쓸 수 있습니다.");
  const assetNo = requestedNo || await nextAssetNo(db, kind, (fields.acquired_on ?? today).slice(0, 4), options.reservedNos);
  options.reservedNos?.add(assetNo);
  const id = gaId("gaa");
  const importBatchId = options.importBatchId ?? null;
  const statements = [
    db.prepare(`INSERT INTO ga_assets (id, asset_no, kind, name, category, status, location, holder_employee_id, acquired_on, acquisition_cost, vendor,
      model, serial_no, quantity, unit, min_quantity, counterparty, contract_no, starts_on, ends_on, auto_renew, renewal_cost, billing_cycle,
      manager_employee_id, useful_life_months, residual_value, opening_accumulated, opening_as_of, alert_off, memo, import_batch_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, assetNo, kind, fields.name, fields.category, status, fields.location, holder, fields.acquired_on, fields.acquisition_cost, fields.vendor,
        fields.model, fields.serial_no, quantity, fields.unit, fields.min_quantity, fields.counterparty, fields.contract_no, fields.starts_on, fields.ends_on,
        fields.auto_renew, fields.renewal_cost, fields.billing_cycle, fields.manager_employee_id, fields.useful_life_months, fields.residual_value,
        fields.opening_accumulated, fields.opening_as_of, alertOff, fields.memo, importBatchId, options.by, options.now, options.now),
    eventStatement(db, { assetId: id, kind: importBatchId ? "IMPORTED" : "ACQUIRED", on: fields.acquired_on ?? today, quantityDelta: quantity,
      amount: fields.acquisition_cost, location: fields.location, by: options.by, now: options.now }),
    ...(holder && kind === "EQUIPMENT" ? [eventStatement(db, { assetId: id, kind: "ASSIGNED", on: today, employeeId: holder, by: options.by, now: options.now })] : []),
  ];
  return { id, assetNo, status, quantity, acquisitionCost: fields.acquisition_cost, statements };
}

/** 고정자산(또는 내용연수를 넣은 장비)의 오늘 기준 상각. 없으면 null. */
export function assetDepreciation(asset: Pick<GaAssetRow, "useful_life_months" | "acquisition_cost" | "residual_value" | "acquired_on" | "opening_accumulated" | "opening_as_of" | "disposed_on">, now: number) {
  if (!asset.useful_life_months || !asset.acquired_on) return null;
  return depreciationAsOf({
    acquisitionCost: asset.acquisition_cost, residualValue: asset.residual_value, usefulLifeMonths: asset.useful_life_months,
    inServiceMonth: asset.acquired_on.slice(0, 7), openingAccumulated: asset.opening_accumulated,
    openingAsOfMonth: asset.opening_as_of ? asset.opening_as_of.slice(0, 7) : null, disposedMonth: asset.disposed_on ? asset.disposed_on.slice(0, 7) : null,
  }, kstToday(now).slice(0, 7));
}

export function assetDto(row: GaAssetRow, people: Map<string, GaPerson>, now: number) {
  const depreciation = assetDepreciation(row, now);
  return {
    id: row.id, assetNo: row.asset_no, kind: row.kind, name: row.name, category: row.category, status: row.status, location: row.location,
    holderEmployeeId: row.holder_employee_id, holderName: row.holder_employee_id ? people.get(row.holder_employee_id)?.name ?? "" : "",
    acquiredOn: row.acquired_on, acquisitionCost: row.acquisition_cost, vendor: row.vendor, model: row.model, serialNo: row.serial_no,
    quantity: row.quantity, unit: row.unit, minQuantity: row.min_quantity, counterparty: row.counterparty, contractNo: row.contract_no,
    startsOn: row.starts_on, endsOn: row.ends_on, autoRenew: row.auto_renew === 1, renewalCost: row.renewal_cost, billingCycle: row.billing_cycle,
    managerEmployeeId: row.manager_employee_id, managerName: row.manager_employee_id ? people.get(row.manager_employee_id)?.name ?? "" : "",
    usefulLifeMonths: row.useful_life_months, residualValue: row.residual_value, openingAccumulated: row.opening_accumulated, openingAsOf: row.opening_as_of,
    disposedOn: row.disposed_on, disposalAmount: row.disposal_amount, alertOff: row.alert_off === 1, memo: row.memo,
    bookValue: depreciation ? depreciation.bookValue : row.kind === "SUPPLY" ? row.acquisition_cost * row.quantity : row.acquisition_cost,
    monthlyDepreciation: depreciation?.monthly ?? null, accumulatedDepreciation: depreciation?.accumulated ?? null,
    updatedAt: row.updated_at,
  };
}

// ── 서류 ─────────────────────────────────────────────────────────────────
export type GaDocumentRow = AlertDocumentRow & {
  issuer: string; storage_location: string; manager_employee_id: string | null; contract_type: string; signed_on: string | null;
  starts_on: string | null; contract_amount: number; memo: string; import_batch_id: string | null; created_at: number; updated_at: number;
};

export function documentFields(input: Record<string, unknown>, people: Map<string, GaPerson>) {
  const kind = oneOf(input, "kind", "종류", GA_DOCUMENT_KINDS, { required: true });
  const contract = kind === "B2B_CONTRACT";
  const fields = {
    kind,
    title: text(input, "title", contract ? "계약명" : "서류명", { required: true, max: 120 }),
    issuer: contract ? "" : text(input, "issuer", "발급기관", { max: 120 }),
    issued_on: contract ? null : date(input, "issuedOn", "발급일"),
    expires_on: contract ? null : date(input, "expiresOn", "만료일"),
    validity_months: contract ? 0 : amount(input, "validityMonths", "유효기간"),
    // GA-D6: 입력하지 않는다(값이 오면 받아 두지만 필수가 아니다). 수정 때 빠지면 라우트가 기존 값을 유지한다.
    storage_location: text(input, "storageLocation", "보관위치", { max: 120 }),
    manager_employee_id: employee(input, "managerEmployeeId", "관리책임자", people),
    contract_type: contract ? oneOf(input, "contractType", "계약종류", GA_CONTRACT_TYPES, { required: true }) : "",
    counterparty: contract ? text(input, "counterparty", "상대방", { max: 120, required: true }) : "",
    signed_on: contract ? date(input, "signedOn", "계약일") : null,
    starts_on: contract ? date(input, "startsOn", "시작일") : null,
    ends_on: contract ? date(input, "endsOn", "종료일") : null,
    contract_amount: contract ? amount(input, "contractAmount", "계약금액") : 0,
    auto_renew: contract ? flag(input, "autoRenew") : 0,
    notice_days: contract ? amount(input, "noticeDays", "해지통보기한") : 0,
    alert_off: flag(input, "alertOff"),
    memo: text(input, "memo", "메모", { max: 1000 }),
  };
  if (fields.validity_months > 120) throw new FieldError("validityMonths", "유효기간은 120개월까지입니다.");
  if (fields.notice_days > 365) throw new FieldError("noticeDays", "해지통보기한은 365일까지입니다.");
  if (fields.starts_on && fields.ends_on && fields.ends_on < fields.starts_on) throw new FieldError("endsOn", "종료일이 시작일보다 앞섭니다.");
  if (fields.notice_days > 0 && !fields.ends_on) throw new FieldError("endsOn", "해지통보기한을 쓰려면 종료일이 필요합니다.");
  return fields;
}

export function documentDto(row: GaDocumentRow, people: Map<string, GaPerson>) {
  return {
    id: row.id, kind: row.kind, title: row.title, issuer: row.issuer, issuedOn: row.issued_on, expiresOn: row.expires_on,
    validityMonths: row.validity_months, storageLocation: row.storage_location, managerEmployeeId: row.manager_employee_id,
    managerName: row.manager_employee_id ? people.get(row.manager_employee_id)?.name ?? "" : "",
    contractType: row.contract_type, counterparty: row.counterparty, signedOn: row.signed_on, startsOn: row.starts_on, endsOn: row.ends_on,
    contractAmount: row.contract_amount, autoRenew: row.auto_renew === 1, noticeDays: row.notice_days, alertOff: row.alert_off === 1,
    memo: row.memo, updatedAt: row.updated_at,
  };
}

// ── 현황·알림 입력 ────────────────────────────────────────────────────────
export async function alertInputs(db: D1Database) {
  const [assets, documents, checkouts] = await Promise.all([
    db.prepare(`SELECT * FROM ga_assets WHERE deleted_at IS NULL`).all<GaAssetRow>(),
    db.prepare(`SELECT * FROM ga_documents WHERE deleted_at IS NULL`).all<GaDocumentRow>(),
    openCheckouts(db),
  ]);
  return { assets: assets.results, documents: documents.results, checkouts };
}

export type GaCheckoutView = AlertCheckoutRow & {
  target_type: string; target_id: string; borrower_employee_id: string; purpose: string; submit_to: string; out_on: string;
  received_by: string; return_memo: string; recorded_by: string; created_at: number;
};

const CHECKOUT_SELECT = `SELECT c.*,
  COALESCE(CASE c.target_type WHEN 'ITEM' THEN i.name ELSE d.title END, '') AS target_name
  FROM ga_checkouts c
  LEFT JOIN ga_custody_items i ON c.target_type = 'ITEM' AND i.id = c.target_id
  LEFT JOIN ga_documents d ON c.target_type = 'DOCUMENT' AND d.id = c.target_id`;

async function withBorrowers(db: D1Database, rows: Array<Omit<GaCheckoutView, "borrower_name">>) {
  const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
  return rows.map((row) => ({ ...row, borrower_name: people.get(row.borrower_employee_id)?.name ?? row.borrower_employee_id }));
}

export async function openCheckouts(db: D1Database): Promise<GaCheckoutView[]> {
  const rows = await db.prepare(`${CHECKOUT_SELECT} WHERE c.returned_on IS NULL AND c.cancelled_at IS NULL ORDER BY c.out_on DESC`).all<Omit<GaCheckoutView, "borrower_name">>();
  return withBorrowers(db, rows.results);
}

export async function checkoutLedger(db: D1Database, where = "c.cancelled_at IS NULL", binds: unknown[] = [], limit = 500): Promise<GaCheckoutView[]> {
  const rows = await db.prepare(`${CHECKOUT_SELECT} WHERE ${where} ORDER BY c.out_on DESC, c.created_at DESC LIMIT ?`).bind(...binds, limit).all<Omit<GaCheckoutView, "borrower_name">>();
  return withBorrowers(db, rows.results);
}

export function checkoutDto(row: GaCheckoutView) {
  return {
    id: row.id, targetType: row.target_type, targetId: row.target_id, targetName: row.target_name, borrowerEmployeeId: row.borrower_employee_id,
    borrowerName: row.borrower_name, purpose: row.purpose, submitTo: row.submit_to, outOn: row.out_on, dueOn: row.due_on,
    returnedOn: row.returned_on, receivedBy: row.received_by, returnMemo: row.return_memo, cancelled: row.cancelled_at !== null,
  };
}
