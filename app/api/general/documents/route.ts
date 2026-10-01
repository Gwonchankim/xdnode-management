import { env } from "cloudflare:workers";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { ensureGaSchema } from "../../../ga-schema";
import { documentExpiry } from "../../../ga-alerts";
import {
  GA_DOCUMENT_KINDS, checkoutDto, checkoutLedger, documentDto, documentFields, fieldResponse, gaConflict, gaId, gaNotFound, gaPeople, gaValidation,
  readBody, type GaDocumentRow,
} from "../../../ga-server";

// general-affairs Design §4 회사 서류·기업 간 계약서(GA-D2). GET(general:read), POST(general:write).
// 감사에는 id·종류만 남긴다(서류명·상대방·계약 금액 없음).
const db = (env as unknown as { DB: D1Database }).DB;

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "read");
  if (authorization.response) return authorization.response;
  await ensureGaSchema(db);
  const params = new URL(request.url).searchParams;
  const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
  const id = params.get("id");
  if (id) {
    const row = await db.prepare(`SELECT * FROM ga_documents WHERE id = ? AND deleted_at IS NULL`).bind(id).first<GaDocumentRow>();
    if (!row) return gaNotFound("서류");
    const [attachments, checkouts] = await Promise.all([
      db.prepare(`SELECT id, file_name, content_type, size FROM ga_attachments WHERE owner_type = 'DOCUMENT' AND owner_id = ? AND deleted_at IS NULL ORDER BY created_at`)
        .bind(id).all<{ id: string; file_name: string; content_type: string; size: number }>(),
      checkoutLedger(db, "c.target_type = 'DOCUMENT' AND c.target_id = ? AND c.cancelled_at IS NULL", [id], 100),
    ]);
    return Response.json({
      document: { ...documentDto(row, people), expiry: documentExpiry(row) },
      attachments: attachments.results.map((file) => ({ id: file.id, fileName: file.file_name, contentType: file.content_type, size: file.size,
        isImage: file.content_type.startsWith("image/"), url: `/api/general/attachments?id=${encodeURIComponent(file.id)}` })),
      checkouts: checkouts.map(checkoutDto),
    });
  }
  const kind = params.get("kind");
  const filter = kind && (GA_DOCUMENT_KINDS as readonly string[]).includes(kind) ? "AND kind = ?" : "";
  const rows = await db.prepare(`SELECT * FROM ga_documents WHERE deleted_at IS NULL ${filter} ORDER BY kind, title`).bind(...(filter ? [kind] : [])).all<GaDocumentRow>();
  const open = new Set((await db.prepare(`SELECT target_id FROM ga_checkouts WHERE target_type = 'DOCUMENT' AND returned_on IS NULL AND cancelled_at IS NULL`)
    .all<{ target_id: string }>()).results.map((row) => row.target_id));
  return Response.json({ documents: rows.results.map((row) => ({ ...documentDto(row, people), expiry: documentExpiry(row), checkedOut: open.has(row.id) })) });
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  await ensureGaSchema(db);
  const payload = await readBody(request);
  if (!payload) return gaValidation("요청 내용을 읽을 수 없습니다.");
  const action = payload.action;
  const now = Date.now();
  try {
    if (action === "CREATE") {
      const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
      const fields = documentFields(payload, people);
      const id = gaId("gad");
      const importBatchId = typeof payload.importBatchId === "string" ? payload.importBatchId : null;
      await db.prepare(`INSERT INTO ga_documents (id, kind, title, issuer, issued_on, expires_on, validity_months, storage_location, manager_employee_id,
        contract_type, counterparty, signed_on, starts_on, ends_on, contract_amount, auto_renew, notice_days, alert_off, memo, import_batch_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, fields.kind, fields.title, fields.issuer, fields.issued_on, fields.expires_on, fields.validity_months, fields.storage_location,
          fields.manager_employee_id, fields.contract_type, fields.counterparty, fields.signed_on, fields.starts_on, fields.ends_on, fields.contract_amount,
          fields.auto_renew, fields.notice_days, fields.alert_off, fields.memo, importBatchId, principal.userId, now, now).run();
      await writeErpAudit(db, { principal, module: "general", action: "GA_DOCUMENT_CREATED", entityType: "GA_DOCUMENT", entityId: id, after: { kind: fields.kind } });
      return Response.json({ document: await dto(id) }, { status: 201 });
    }
    const current = typeof payload.id === "string"
      ? await db.prepare(`SELECT * FROM ga_documents WHERE id = ? AND deleted_at IS NULL`).bind(payload.id).first<GaDocumentRow>() : null;
    if (action === "UPDATE") {
      if (!current) return gaNotFound("서류");
      const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
      const fields = documentFields({ ...payload, kind: payload.kind ?? current.kind }, people);
      // GA-D6: 화면이 보관 위치를 보내지 않으므로, 빠지면 예전에 적어 둔 값을 그대로 둔다.
      if (payload.storageLocation === undefined) fields.storage_location = current.storage_location;
      const result = await db.prepare(`UPDATE ga_documents SET kind = ?, title = ?, issuer = ?, issued_on = ?, expires_on = ?, validity_months = ?,
        storage_location = ?, manager_employee_id = ?, contract_type = ?, counterparty = ?, signed_on = ?, starts_on = ?, ends_on = ?, contract_amount = ?,
        auto_renew = ?, notice_days = ?, alert_off = ?, memo = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND updated_at = ?`)
        .bind(fields.kind, fields.title, fields.issuer, fields.issued_on, fields.expires_on, fields.validity_months, fields.storage_location,
          fields.manager_employee_id, fields.contract_type, fields.counterparty, fields.signed_on, fields.starts_on, fields.ends_on, fields.contract_amount,
          fields.auto_renew, fields.notice_days, fields.alert_off, fields.memo, now, current.id,
          typeof payload.updatedAt === "number" ? payload.updatedAt : current.updated_at).run();
      if (!result.meta.changes) return gaConflict();
      await writeErpAudit(db, { principal, module: "general", action: "GA_DOCUMENT_UPDATED", entityType: "GA_DOCUMENT", entityId: current.id,
        before: { kind: current.kind }, after: { kind: fields.kind } });
      return Response.json({ document: await dto(current.id) });
    }
    if (action === "DELETE") {
      if (!current) return gaNotFound("서류");
      const open = await db.prepare(`SELECT 1 FROM ga_checkouts WHERE target_type = 'DOCUMENT' AND target_id = ? AND returned_on IS NULL AND cancelled_at IS NULL`)
        .bind(current.id).first();
      if (open) return gaConflict("반출 중인 서류는 지울 수 없습니다. 먼저 반납 처리해 주세요.");
      await db.batch([
        db.prepare(`UPDATE ga_documents SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).bind(now, now, current.id),
        db.prepare(`UPDATE ga_attachments SET deleted_at = ? WHERE owner_type = 'DOCUMENT' AND owner_id = ? AND deleted_at IS NULL`).bind(now, current.id),
      ]);
      await writeErpAudit(db, { principal, module: "general", action: "GA_DOCUMENT_DELETED", entityType: "GA_DOCUMENT", entityId: current.id, before: { kind: current.kind } });
      return Response.json({ ok: true });
    }
    return gaValidation("알 수 없는 요청입니다.", "action");
  } catch (error) {
    const response = fieldResponse(error);
    if (response) return response;
    throw error;
  }
}

async function dto(id: string) {
  const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
  const row = await db.prepare(`SELECT * FROM ga_documents WHERE id = ?`).bind(id).first<GaDocumentRow>();
  return row ? { ...documentDto(row, people), expiry: documentExpiry(row) } : null;
}
