import { env } from "cloudflare:workers";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { ensureGaSchema } from "../../../ga-schema";
import { GA_IMPORT_MAX_ROWS, GA_SHEETS, normalizeRow, type GaSheet, type RawCell } from "../../../ga-import";
import {
  FieldError, assetFields, documentFields, gaId, gaPeople, gaValidation, prepareAssetCreate, readBody, type GaAssetKind, type GaPerson,
} from "../../../ga-server";

// general-affairs Design §6(GA-D1). 브라우저가 엑셀을 읽어 머리글 → 값으로 보내면 서버가 같은 규칙으로 다시 검증한다.
// PREVIEW: 행별 ok/error/duplicate. COMMIT: 오류가 하나라도 있으면 거부하고, 한 batch 로 전부 넣는다(전부 또는 없음).
// REVERT: 그 가져오기가 새로 만든 행만 지운다(soft-delete). 감사에는 건수만 남긴다.
const db = (env as unknown as { DB: D1Database }).DB;
const ASSET_SHEETS: ReadonlySet<GaSheet> = new Set(["EQUIPMENT", "SUPPLY", "CONTRACT", "FIXED"]);

type InputRow = { row: number; raw: Record<string, RawCell> };
type Preview = { row: number; status: "ok" | "error" | "duplicate"; errors: string[]; values: Record<string, unknown>; existingId?: string };

function readRows(value: unknown): InputRow[] | null {
  if (!Array.isArray(value) || value.length > GA_IMPORT_MAX_ROWS) return null;
  const rows: InputRow[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { row, raw } = item as { row?: unknown; raw?: unknown };
    if (typeof row !== "number" || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    rows.push({ row, raw: raw as Record<string, RawCell> });
  }
  return rows;
}

async function checkoutTargets() {
  const [items, documents] = await Promise.all([
    db.prepare(`SELECT id, name FROM ga_custody_items WHERE deleted_at IS NULL`).all<{ id: string; name: string }>(),
    db.prepare(`SELECT id, title FROM ga_documents WHERE deleted_at IS NULL`).all<{ id: string; title: string }>(),
  ]);
  const byName = new Map<string, Array<{ type: "ITEM" | "DOCUMENT"; id: string }>>();
  for (const item of items.results) byName.set(item.name, [...(byName.get(item.name) ?? []), { type: "ITEM", id: item.id }]);
  for (const document of documents.results) byName.set(document.title, [...(byName.get(document.title) ?? []), { type: "DOCUMENT", id: document.id }]);
  return byName;
}

async function preview(sheet: GaSheet, rows: InputRow[], people: GaPerson[]): Promise<Preview[]> {
  const peopleMap = new Map(people.map((person) => [person.employeeId, person]));
  const existing = new Map((await db.prepare(`SELECT id, asset_no FROM ga_assets WHERE deleted_at IS NULL`).all<{ id: string; asset_no: string }>())
    .results.map((row) => [row.asset_no, row.id]));
  const targets = sheet === "CHECKOUT" ? await checkoutTargets() : null;
  const openTargets = sheet === "CHECKOUT"
    ? new Set((await db.prepare(`SELECT target_type || ':' || target_id AS k FROM ga_checkouts WHERE returned_on IS NULL AND cancelled_at IS NULL`).all<{ k: string }>()).results.map((row) => row.k))
    : new Set<string>();
  const seenNos = new Set<string>();
  const out: Preview[] = [];
  for (const input of rows) {
    const normalized = normalizeRow(sheet, input.raw, input.row, people);
    const errors = [...normalized.errors];
    const values = normalized.values;
    let status: Preview["status"] = "ok";
    let existingId: string | undefined;
    if (!errors.length) {
      try {
        // 화면 저장과 같은 필드 검증을 한 번 더 탄다(필수·범위·날짜 순서).
        if (ASSET_SHEETS.has(sheet)) {
          assetFields(values, sheet as GaAssetKind, peopleMap);
        } else if (sheet === "DOCUMENT" || sheet === "B2B_CONTRACT") {
          documentFields({ ...values, kind: sheet === "B2B_CONTRACT" ? "B2B_CONTRACT" : values.kind }, peopleMap);
        }
      } catch (error) {
        if (error instanceof FieldError) errors.push(error.message); else throw error;
      }
    }
    if (ASSET_SHEETS.has(sheet) && typeof values.assetNo === "string" && values.assetNo) {
      if (seenNos.has(values.assetNo)) errors.push(`자산번호 ${values.assetNo} 가 파일 안에서 겹칩니다.`);
      seenNos.add(values.assetNo);
      existingId = existing.get(values.assetNo);
    }
    if (sheet === "CHECKOUT" && !errors.length) {
      const found = targets?.get(String(values.targetName)) ?? [];
      if (found.length !== 1) errors.push(found.length ? `대상 '${values.targetName}' 이(가) 둘 이상입니다. 이름을 고쳐 주세요.` : `대상 '${values.targetName}' 을(를) 보관품·서류에서 찾을 수 없습니다.`);
      else {
        values.targetType = found[0].type;
        values.targetId = found[0].id;
        const key = `${found[0].type}:${found[0].id}`;
        if (!values.returnedOn) {
          if (openTargets.has(key)) errors.push("이 대상은 이미 반출 중입니다(반납일이 없는 행).");
          openTargets.add(key);
        }
      }
    }
    if (errors.length) status = "error";
    else if (existingId) status = "duplicate";
    out.push({ row: input.row, status, errors, values, ...(existingId ? { existingId } : {}) });
  }
  return out;
}

/** 최근 가져오기 20건(되돌리기 버튼용). */
export async function GET() {
  const authorization = await authorizeErpRequest(db, "general", "read");
  if (authorization.response) return authorization.response;
  await ensureGaSchema(db);
  const rows = await db.prepare(`SELECT b.id, b.sheet, b.row_count, b.created_at, b.reverted_at, COALESCE(a.display_name, '') AS created_by_name
    FROM ga_import_batches b LEFT JOIN auth_accounts a ON a.id = b.created_by ORDER BY b.created_at DESC LIMIT 20`)
    .all<{ id: string; sheet: string; row_count: number; created_at: number; reverted_at: number | null; created_by_name: string }>();
  return Response.json({ batches: rows.results.map((row) => ({ id: row.id, sheet: row.sheet, rowCount: row.row_count, createdAt: row.created_at,
    reverted: row.reverted_at !== null, createdByName: row.created_by_name })) });
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  await ensureGaSchema(db);
  const payload = await readBody(request);
  if (!payload) return gaValidation("요청 내용을 읽을 수 없습니다.");
  const action = payload.action;

  if (action === "REVERT") {
    const batchId = typeof payload.batchId === "string" ? payload.batchId : "";
    const batch = await db.prepare(`SELECT * FROM ga_import_batches WHERE id = ? AND reverted_at IS NULL`).bind(batchId).first<{ id: string; sheet: string; row_count: number }>();
    if (!batch) return gaValidation("되돌릴 가져오기를 찾을 수 없습니다.", "batchId");
    const now = Date.now();
    await db.batch([
      db.prepare(`UPDATE ga_assets SET deleted_at = ?, updated_at = ? WHERE import_batch_id = ? AND deleted_at IS NULL`).bind(now, now, batch.id),
      db.prepare(`UPDATE ga_documents SET deleted_at = ?, updated_at = ? WHERE import_batch_id = ? AND deleted_at IS NULL`).bind(now, now, batch.id),
      db.prepare(`UPDATE ga_checkouts SET cancelled_at = ?, updated_at = ? WHERE import_batch_id = ? AND cancelled_at IS NULL`).bind(now, now, batch.id),
      db.prepare(`UPDATE ga_import_batches SET reverted_at = ? WHERE id = ?`).bind(now, batch.id),
    ]);
    await writeErpAudit(db, { principal, module: "general", action: "GA_IMPORT_REVERTED", entityType: "GA_IMPORT", entityId: batch.id, after: { sheet: batch.sheet, rows: batch.row_count } });
    return Response.json({ ok: true });
  }

  const sheet = payload.sheet as GaSheet;
  if (!Object.hasOwn(GA_SHEETS, sheet)) return gaValidation("양식 시트를 확인해 주세요.", "sheet");
  const rows = readRows(payload.rows);
  if (!rows) return gaValidation(`행 목록을 읽을 수 없습니다(한 번에 ${GA_IMPORT_MAX_ROWS}행까지).`, "rows");
  const people = await gaPeople(db);
  const checked = await preview(sheet, rows, people);
  if (action === "PREVIEW") return Response.json({ rows: checked.map(({ values, ...rest }) => ({ ...rest, values })) });
  if (action !== "COMMIT") return gaValidation("알 수 없는 요청입니다.", "action");

  if (checked.some((row) => row.status === "error")) return gaValidation("오류가 있는 행을 고친 뒤 다시 가져와 주세요.", "rows");
  const mode = payload.mode === "overwrite" ? "overwrite" : "skip";
  const overwriteRows = new Set(Array.isArray(payload.overwriteRows) ? payload.overwriteRows.filter((value): value is number => typeof value === "number") : []);
  const peopleMap = new Map(people.map((person) => [person.employeeId, person]));
  const now = Date.now();
  const batchId = gaId("gab");
  const statements: D1PreparedStatement[] = [];
  const reserved = new Set<string>();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  try {
    for (const row of checked) {
      if (row.status === "duplicate") {
        if (mode !== "overwrite" || !overwriteRows.has(row.row) || !row.existingId) { skipped += 1; continue; }
        statements.push(...overwriteAsset(row.existingId, sheet as GaAssetKind, row.values, peopleMap, now));
        updated += 1;
        continue;
      }
      if (ASSET_SHEETS.has(sheet)) {
        const prepared = await prepareAssetCreate(db, row.values, sheet as GaAssetKind, peopleMap, { by: principal.userId, now, importBatchId: batchId, reservedNos: reserved });
        statements.push(...prepared.statements);
      } else if (sheet === "DOCUMENT" || sheet === "B2B_CONTRACT") {
        const fields = documentFields({ ...row.values, kind: sheet === "B2B_CONTRACT" ? "B2B_CONTRACT" : row.values.kind }, peopleMap);
        statements.push(db.prepare(`INSERT INTO ga_documents (id, kind, title, issuer, issued_on, expires_on, validity_months, storage_location, manager_employee_id,
          contract_type, counterparty, signed_on, starts_on, ends_on, contract_amount, auto_renew, notice_days, alert_off, memo, import_batch_id, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(gaId("gad"), fields.kind, fields.title, fields.issuer, fields.issued_on,
          fields.expires_on, fields.validity_months, fields.storage_location, fields.manager_employee_id, fields.contract_type, fields.counterparty, fields.signed_on,
          fields.starts_on, fields.ends_on, fields.contract_amount, fields.auto_renew, fields.notice_days, fields.alert_off, fields.memo, batchId, principal.userId, now, now));
      } else {
        const v = row.values;
        statements.push(db.prepare(`INSERT INTO ga_checkouts (id, target_type, target_id, borrower_employee_id, purpose, submit_to, out_on, due_on, returned_on,
          received_by, return_memo, recorded_by, created_at, updated_at, import_batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(gaId("gac"), v.targetType, v.targetId, v.borrowerEmployeeId, v.purpose, v.submitTo ?? "", v.outOn, v.dueOn ?? null, v.returnedOn ?? null,
            v.receivedBy ?? "", v.returnMemo ?? "", principal.userId, now, now, batchId));
      }
      created += 1;
    }
  } catch (error) {
    if (error instanceof FieldError) return gaValidation(error.message, error.field);
    throw error;
  }
  if (!statements.length) return Response.json({ batchId: null, created, updated, skipped });
  statements.push(db.prepare(`INSERT INTO ga_import_batches (id, sheet, row_count, created_by, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(batchId, sheet, created, principal.userId, now));
  try {
    await db.batch(statements);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return gaValidation("가져오는 동안 다른 사람이 같은 자산번호나 반출을 기록했습니다. 미리보기를 다시 해 주세요.", "rows");
    }
    throw error;
  }
  await writeErpAudit(db, { principal, module: "general", action: "GA_IMPORT_COMMITTED", entityType: "GA_IMPORT", entityId: batchId, after: { sheet, created, updated, skipped } });
  return Response.json({ batchId, created, updated, skipped });
}

/** 덮어쓰기: 같은 자산번호 행의 편집 필드만 바꾼다(상태·사용자·수량은 작업으로만 바꾸므로 그대로 둔다). */
function overwriteAsset(id: string, kind: GaAssetKind, values: Record<string, unknown>, people: Map<string, GaPerson>, now: number) {
  const fields = assetFields(values, kind, people);
  return [db.prepare(`UPDATE ga_assets SET name = ?, category = ?, location = ?, acquired_on = ?, acquisition_cost = ?, vendor = ?, model = ?, serial_no = ?,
    unit = ?, min_quantity = ?, counterparty = ?, contract_no = ?, starts_on = ?, ends_on = ?, auto_renew = ?, renewal_cost = ?, billing_cycle = ?,
    manager_employee_id = ?, useful_life_months = ?, residual_value = ?, opening_accumulated = ?, opening_as_of = ?, memo = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL`).bind(fields.name, fields.category, fields.location, fields.acquired_on, fields.acquisition_cost, fields.vendor, fields.model,
    fields.serial_no, fields.unit, fields.min_quantity, fields.counterparty, fields.contract_no, fields.starts_on, fields.ends_on, fields.auto_renew,
    fields.renewal_cost, fields.billing_cycle, fields.manager_employee_id, fields.useful_life_months, fields.residual_value, fields.opening_accumulated,
    fields.opening_as_of, fields.memo, now, id)];
}

