import { ensureHrEmployeeRecordsSchema } from "../../hr-employee-schema";
import { env } from "cloudflare:workers";
import { readSheet } from "read-excel-file/web-worker";
import { authorizeErpRequest, writeErpAudit } from "../../erp-platform";
import { createApprovalRequest } from "../../approval-engine";
import { ensureDataIntegrationSchema } from "../../data-integration";
import { ensureDataIntakeSchema } from "../../data-intake";

type Bindings = { DB: D1Database; HR_AUDIO: R2Bucket };
const bindings = env as unknown as Bindings; const db = bindings.DB;
type Cell = string | number | boolean | Date | null;
type ImportRow = Record<string, Cell>;
type SourceRow = { id: string; name: string; category: string; system_type: string; enabled: number };

const allowedTypes = new Set(["text/csv", "text/plain", "application/json", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
const supportedApplySources = new Set(["hiworks-employees", "payroll-excel-2025-2026"]);
const employeeAliases: Record<string, string[]> = {
  employeeId: ["사번", "id", "employeeid", "아이디"], name: ["이름", "성명", "name"], birth: ["생년월일", "birth"], email: ["이메일", "email", "메일"],
  phone: ["연락처", "휴대전화", "휴대폰", "phone"], address: ["주소", "address"], department: ["부서", "조직", "소속조직", "department"], manager: ["조직장", "직속리더", "manager"],
  employmentType: ["고용형태", "근로형태", "type", "employmenttype"], joinDate: ["입사일", "joindate"], position: ["직위", "직급", "position"], jobTitle: ["직책", "jobtitle"], status: ["상태", "재직상태", "status"],
};
const payrollAliases: Record<string, string[]> = {
  id: ["id", "급여id"], yearMonth: ["급여월", "년월", "yearmonth"], employeeName: ["이름", "성명", "employee", "employeename"], annualSalary: ["연봉", "annualsalary"],
  basePay: ["기본급", "basepay"], mealAllowance: ["식대", "mealallowance"], childcareAllowance: ["육아수당", "childcareallowance"], vehicleAllowance: ["차량수당", "vehicleallowance"],
  incentive: ["인센티브", "incentive"], bonus: ["상여", "상여금", "bonus"], annualLeavePay: ["연차수당", "annualleavepay"], retirementPay: ["퇴직금", "retirementpay"],
  deductions: ["공제", "공제합계", "deductions"], grossPay: ["지급총액", "총지급액", "grosspay"], netPay: ["실지급액", "차인지급액", "netpay"], cardAllowance: ["카드수당", "cardallowance"],
  cardUsage: ["카드사용액", "cardusage"], personalPurchase: ["개인구매", "personalpurchase"], nonTaxable: ["비과세", "nontaxable"], welfareFund: ["복지기금", "welfarefund"],
  notes: ["비고", "메모", "notes"], sourceSheet: ["원본시트", "시트", "sourcesheet"], sourceRow: ["원본행", "행", "sourcerow"],
};
const cleanHeader = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[\s_./-]/g, "");
const stringValue = (value: Cell | undefined) => value == null ? "" : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();
const numberValue = (value: Cell | undefined) => { const parsed = Number(String(value ?? "0").replace(/[^0-9.-]/g, "")); return Number.isFinite(parsed) ? Math.round(parsed) : 0; };

function csvRows(text: string) {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) { const char = text[index]; const next = text[index + 1]; if (quoted && char === '"' && next === '"') { cell += '"'; index += 1; } else if (char === '"') quoted = !quoted; else if (!quoted && char === ",") { row.push(cell); cell = ""; } else if (!quoted && (char === "\n" || char === "\r")) { if (char === "\r" && next === "\n") index += 1; row.push(cell); if (row.some((item) => item.trim())) rows.push(row); row = []; cell = ""; } else cell += char; }
  row.push(cell); if (row.some((item) => item.trim())) rows.push(row); return rows;
}
async function parseFile(file: File) {
  let matrix: Cell[][]; let parserType = "CSV";
  if (file.name.toLowerCase().endsWith(".xlsx") || file.type.includes("spreadsheetml")) { matrix = await readSheet(file) as Cell[][]; parserType = "XLSX"; }
  else { const text = await file.text(); if (file.name.toLowerCase().endsWith(".json") || file.type === "application/json") { const parsed = JSON.parse(text) as unknown; const items = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed && Array.isArray((parsed as { rows?: unknown }).rows) ? (parsed as { rows: unknown[] }).rows : null; if (!items) throw new Error("JSON은 객체 배열 또는 rows 배열이어야 합니다."); const headers = Array.from(new Set(items.flatMap((item) => typeof item === "object" && item ? Object.keys(item) : []))); matrix = [headers, ...items.map((item) => headers.map((header) => typeof item === "object" && item ? (item as Record<string, Cell>)[header] ?? null : null))]; parserType = "JSON"; } else matrix = csvRows(text); }
  if (matrix.length < 2) throw new Error("머리글과 데이터 행이 있는 파일을 선택해 주세요.");
  const headers = matrix[0].map((item, index) => String(item ?? `열${index + 1}`).trim() || `열${index + 1}`);
  const rows = matrix.slice(1).filter((row) => row.some((cell) => stringValue(cell) !== "")).slice(0, 500).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null])) as ImportRow);
  if (!rows.length) throw new Error("가져올 데이터 행이 없습니다."); return { headers, rows, parserType, truncated: matrix.length - 1 > 500 };
}
function match(raw: ImportRow, aliases: string[]) { const entries = Object.entries(raw); const wanted = new Set(aliases.map(cleanHeader)); return entries.find(([header]) => wanted.has(cleanHeader(header)))?.[1]; }
function normalize(sourceId: string, raw: ImportRow, rowNumber: number) {
  if (sourceId === "hiworks-employees") {
    const value = Object.fromEntries(Object.entries(employeeAliases).map(([key, aliases]) => [key, stringValue(match(raw, aliases))]));
    const issues: string[] = []; if (!value.name) issues.push("이름 누락"); if (!value.email || !/^\S+@\S+\.\S+$/.test(value.email)) issues.push("이메일 누락 또는 형식 오류");
    return { normalized: value, identityKey: value.employeeId || value.email.toLowerCase(), issues, entityType: "HR_EMPLOYEE", entityId: value.employeeId || value.email.toLowerCase() };
  }
  if (sourceId === "payroll-excel-2025-2026") {
    const value: Record<string, string | number> = {}; for (const [key, aliases] of Object.entries(payrollAliases)) value[key] = ["id", "yearMonth", "employeeName", "notes", "sourceSheet"].includes(key) ? stringValue(match(raw, aliases)) : numberValue(match(raw, aliases));
    if (!value.sourceSheet) value.sourceSheet = "업로드"; if (!value.sourceRow) value.sourceRow = rowNumber; const issues: string[] = [];
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(value.yearMonth))) issues.push("급여월은 YYYY-MM 형식이어야 함"); if (!value.employeeName) issues.push("이름 누락");
    const identityKey = String(value.id || `${value.yearMonth}:${value.employeeName}:${value.sourceSheet}:${value.sourceRow}`); value.id = identityKey;
    return { normalized: value, identityKey, issues, entityType: "HR_PAYROLL", entityId: identityKey };
  }
  const normalized = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, stringValue(value)]));
  return { normalized, identityKey: "", issues: ["업무 원장 반영 매핑이 아직 확정되지 않은 원천"], entityType: "STAGING_ONLY", entityId: "" };
}
async function digest(bytes: ArrayBuffer) { const hash = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(hash)).map((item) => item.toString(16).padStart(2, "0")).join(""); }
async function addEvent(batchId: string, action: string, from: string, to: string, actor: string, note: string, snapshot: unknown = {}) { await db.prepare(`INSERT INTO erp_data_import_events (id,batch_id,action,from_status,to_status,actor_employee_id,note,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), batchId, action, from, to, actor, note, JSON.stringify(snapshot), Date.now()).run(); }
async function refreshActionCounts(batchId: string) { const rows = await db.prepare(`SELECT proposed_action, COUNT(*) AS count FROM erp_data_import_rows WHERE batch_id=? GROUP BY proposed_action`).bind(batchId).all<{ proposed_action: string; count: number }>(); const counts = Object.fromEntries(rows.results.map((row) => [row.proposed_action, Number(row.count)])); await db.prepare("UPDATE erp_data_import_batches SET create_rows=?,update_rows=?,skip_rows=?,version=version+1,updated_at=? WHERE id=?").bind(counts.CREATE ?? 0, counts.UPDATE ?? 0, counts.SKIP ?? 0, Date.now(), batchId).run(); }

async function batchView(batchId = "") {
  const batchStatement = db.prepare(`SELECT batch.*, source.name AS source_name, source.category AS source_category,
    source.connection_mode, source.system_type FROM erp_data_import_batches batch JOIN erp_integration_sources source ON source.id=batch.source_id
    ${batchId ? "WHERE batch.id=?" : ""} ORDER BY batch.created_at DESC LIMIT 40`);
  const batches = batchId
    ? await batchStatement.bind(batchId).all<Record<string, unknown>>()
    : await batchStatement.all<Record<string, unknown>>();
  const selected = batchId || String(batches.results[0]?.id ?? "");
  const [rows, events] = selected ? await Promise.all([
    db.prepare("SELECT * FROM erp_data_import_rows WHERE batch_id=? ORDER BY row_number LIMIT 100").bind(selected).all(),
    db.prepare("SELECT * FROM erp_data_import_events WHERE batch_id=? ORDER BY created_at DESC").bind(selected).all(),
  ]) : [{ results: [] }, { results: [] }];
  return { batches: batches.results.map((batch) => ({ ...batch, apply_supported: supportedApplySources.has(String(batch.source_id)) })), selectedBatchId: selected, rows: rows.results, events: events.results,
    controls: { maximumRows: 500, maximumBytes: 10 * 1024 * 1024, originalRetained: true, approvalRequired: true, automaticApply: false } };
}

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "settings", "admin"); if (authorization.response) return authorization.response;
  await ensureDataIntegrationSchema(db); await ensureDataIntakeSchema(db); const url = new URL(request.url);
  const downloadId = url.searchParams.get("downloadId"); if (downloadId) { const batch = await db.prepare("SELECT storage_key,file_name,content_type FROM erp_data_import_batches WHERE id=?").bind(downloadId).first<{ storage_key: string; file_name: string; content_type: string }>(); if (!batch) return new Response("원본을 찾을 수 없습니다.", { status: 404 }); const object = await bindings.HR_AUDIO.get(batch.storage_key); if (!object) return new Response("보관된 원본을 찾을 수 없습니다.", { status: 404 }); return new Response(object.body, { headers: { "Content-Type": batch.content_type, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(batch.file_name)}`, "Cache-Control": "private, no-store" } }); }
  const template = url.searchParams.get("template"); if (template) { const source = template === "employees" ? employeeAliases : payrollAliases; const csv = `\uFEFF${Object.keys(source).join(",")}\r\n`; return new Response(csv, { headers: { "Content-Type": "text/csv;charset=utf-8", "Content-Disposition": `attachment; filename="${template}-import-template.csv"` } }); }
  return Response.json({ principal: authorization.principal, ...(await batchView(url.searchParams.get("batchId") ?? "")) });
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "settings", "admin"); if (authorization.response) return authorization.response;
  await ensureDataIntegrationSchema(db); await ensureDataIntakeSchema(db); const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData(); const sourceId = String(form.get("sourceId") ?? ""); const file = form.get("file");
    const source = await db.prepare("SELECT id,name,category,system_type,enabled FROM erp_integration_sources WHERE id=?").bind(sourceId).first<SourceRow>();
    if (!source || !source.enabled || !(file instanceof File && file.size)) return Response.json({ error: "활성 원천과 파일을 선택해 주세요." }, { status: 400 });
    if (file.size > 10 * 1024 * 1024) return Response.json({ error: "수집 파일은 10MB 이하만 처리할 수 있습니다." }, { status: 413 });
    const type = file.type || (file.name.endsWith(".csv") ? "text/csv" : file.name.endsWith(".json") ? "application/json" : "application/octet-stream");
    if (!allowedTypes.has(type) && !file.name.toLowerCase().endsWith(".xlsx")) return Response.json({ error: "CSV, JSON, XLSX 파일만 수집할 수 있습니다." }, { status: 415 });
    const bytes = await file.arrayBuffer(); const checksum = await digest(bytes); const duplicate = await db.prepare("SELECT id,status FROM erp_data_import_batches WHERE source_id=? AND file_sha256=?").bind(sourceId, checksum).first<{ id: string; status: string }>();
    if (duplicate) return Response.json({ error: `동일 원본이 이미 등록되어 있습니다. (${duplicate.status})`, existingBatchId: duplicate.id }, { status: 409 });
    let parsed; try { parsed = await parseFile(file); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "파일을 해석하지 못했습니다." }, { status: 400 }); }
    const batchId = crypto.randomUUID(); const now = Date.now(); const storageKey = `erp-imports/${sourceId}/${batchId}/${encodeURIComponent(file.name.slice(0, 180))}`;
    await bindings.HR_AUDIO.put(storageKey, bytes, { httpMetadata: { contentType: type }, customMetadata: { sha256: checksum, sourceId } });
    try {
      const known = sourceId === "hiworks-employees" ? await db.prepare("SELECT employee_id,email FROM hr_employee_records").all<{ employee_id: string; email: string }>().catch(() => ({ results: [] })) : { results: [] as Array<{ employee_id: string; email: string }> };
      const payrollIds = sourceId === "payroll-excel-2025-2026" ? await db.prepare("SELECT id FROM hr_payroll_records").all<{ id: string }>().catch(() => ({ results: [] })) : { results: [] as Array<{ id: string }> };
      const employeeByEmail = new Map(known.results.map((row) => [row.email.toLowerCase(), row.employee_id])); const existingPayroll = new Set(payrollIds.results.map((row) => row.id)); const seen = new Set<string>();
      const staged = await Promise.all(parsed.rows.map(async (raw, index) => { const rowNumber = index + 2; const item = normalize(sourceId, raw, rowNumber); const issues = [...item.issues]; const duplicateIdentity = Boolean(item.identityKey && seen.has(item.identityKey)); if (duplicateIdentity) issues.push("파일 내부 식별키 중복"); if (item.identityKey) seen.add(item.identityKey);
        const existingId = sourceId === "hiworks-employees" ? employeeByEmail.get(String(item.normalized.email ?? "").toLowerCase()) : sourceId === "payroll-excel-2025-2026" && existingPayroll.has(item.identityKey) ? item.identityKey : "";
        const action = issues.length ? "SKIP" : existingId ? "UPDATE" : supportedApplySources.has(sourceId) ? "CREATE" : "SKIP"; const rowChecksum = await digest(new TextEncoder().encode(JSON.stringify(raw)).buffer);
        return { rowNumber, raw, ...item, issues, duplicateIdentity, existingId, action, rowChecksum }; }));
      const stats = { total: staged.length, valid: staged.filter((row) => !row.issues.length).length, invalid: staged.filter((row) => row.issues.length).length, duplicate: staged.filter((row) => row.duplicateIdentity).length, create: staged.filter((row) => row.action === "CREATE").length, update: staged.filter((row) => row.action === "UPDATE").length, skip: staged.filter((row) => row.action === "SKIP").length };
      const status = stats.invalid || parsed.truncated ? "NEEDS_REVIEW" : "VALIDATED";
      const statements = [db.prepare(`INSERT INTO erp_data_import_batches (id,source_id,status,file_name,content_type,storage_key,file_sha256,byte_size,parser_type,header_json,mapping_json,total_rows,valid_rows,invalid_rows,duplicate_rows,create_rows,update_rows,skip_rows,requested_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(batchId, sourceId, status, file.name.slice(0, 240), type, storageKey, checksum, file.size, parsed.parserType, JSON.stringify(parsed.headers), JSON.stringify(sourceId === "hiworks-employees" ? employeeAliases : sourceId === "payroll-excel-2025-2026" ? payrollAliases : {}), stats.total, stats.valid, stats.invalid, stats.duplicate, stats.create, stats.update, stats.skip, authorization.principal.employeeId, now, now),
        ...staged.map((row) => db.prepare(`INSERT INTO erp_data_import_rows (id,batch_id,row_number,raw_json,normalized_json,identity_key,row_checksum,validation_status,issues_json,proposed_action,target_entity_type,target_entity_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), batchId, row.rowNumber, JSON.stringify(row.raw), JSON.stringify(row.normalized), row.identityKey, row.rowChecksum, row.issues.length ? "INVALID" : "VALID", JSON.stringify(row.issues), row.action, row.entityType, row.existingId || row.entityId, now)),
        db.prepare(`INSERT INTO erp_data_import_events (id,batch_id,action,from_status,to_status,actor_employee_id,note,snapshot_json,created_at) VALUES (?,?, 'UPLOADED','',?,?,?, ?,?)`).bind(crypto.randomUUID(), batchId, status, authorization.principal.employeeId, "원본을 R2에 보존하고 행 단위 검증을 완료했습니다.", JSON.stringify({ ...stats, parserType: parsed.parserType, truncated: parsed.truncated }), now)];
      await db.batch(statements); await writeErpAudit(db, { principal: authorization.principal, module: "settings", action: "DATA_IMPORT_STAGED", entityType: "DATA_IMPORT_BATCH", entityId: batchId, after: { sourceId, checksum, status, ...stats } });
      return Response.json({ batchId, ...(await batchView(batchId)) }, { status: 201 });
    } catch (error) { await bindings.HR_AUDIO.delete(storageKey).catch(() => undefined); throw error; }
  }
  const body = await request.json() as Record<string, unknown>; const action = String(body.action ?? ""); const batchId = String(body.batchId ?? "");
  const batch = await db.prepare("SELECT * FROM erp_data_import_batches WHERE id=?").bind(batchId).first<Record<string, unknown>>(); if (!batch) return Response.json({ error: "수집 배치를 찾을 수 없습니다." }, { status: 404 });
  if (action === "SET_ROW_ACTION") { if (!["VALIDATED", "NEEDS_REVIEW"].includes(String(batch.status))) return Response.json({ error: "검토 단계의 행만 변경할 수 있습니다." }, { status: 409 }); const rowId = String(body.rowId ?? ""); const proposed = String(body.proposedAction ?? "SKIP"); if (!["CREATE", "UPDATE", "SKIP"].includes(proposed)) return Response.json({ error: "행 처리방식을 확인해 주세요." }, { status: 400 }); const row = await db.prepare("SELECT validation_status FROM erp_data_import_rows WHERE id=? AND batch_id=?").bind(rowId, batchId).first<{ validation_status: string }>(); if (!row || (row.validation_status !== "VALID" && proposed !== "SKIP")) return Response.json({ error: "검증 실패 행은 제외만 가능합니다." }, { status: 409 }); await db.prepare("UPDATE erp_data_import_rows SET proposed_action=? WHERE id=?").bind(proposed, rowId).run(); await refreshActionCounts(batchId); await addEvent(batchId, "ROW_ACTION_CHANGED", String(batch.status), String(batch.status), authorization.principal.employeeId, `행 처리방식을 ${proposed}(으)로 변경`); }
  else if (action === "SUBMIT") { if (!["VALIDATED", "NEEDS_REVIEW"].includes(String(batch.status))) return Response.json({ error: "검증된 배치만 결재를 제출할 수 있습니다." }, { status: 409 }); const activeInvalid = await db.prepare("SELECT COUNT(*) AS count FROM erp_data_import_rows WHERE batch_id=? AND validation_status<>'VALID' AND proposed_action<>'SKIP'").bind(batchId).first<{ count: number }>(); if (Number(activeInvalid?.count ?? 0)) return Response.json({ error: "검증 실패 행을 제외한 뒤 제출해 주세요." }, { status: 409 }); const moduleName = String((await db.prepare("SELECT category FROM erp_integration_sources WHERE id=?").bind(String(batch.source_id)).first<{ category: string }>())?.category) === "HR" ? "hr" : "finance"; const approval = await createApprovalRequest(db, authorization.principal, { module: moduleName, requestType: "DATA_IMPORT", title: `${String(batch.file_name)} 데이터 반영 승인`, description: `원천 ${String(batch.source_id)} · 전체 ${batch.total_rows}행 · 생성 ${batch.create_rows} · 수정 ${batch.update_rows} · 제외 ${batch.skip_rows}`, targetEntityType: "DATA_IMPORT_BATCH", targetEntityId: batchId, priority: Number(batch.invalid_rows) ? "HIGH" : "NORMAL", metadata: { sourceId: batch.source_id, fileSha256: batch.file_sha256, totalRows: batch.total_rows } }); const now = Date.now(); await db.prepare("UPDATE erp_data_import_batches SET status='SUBMITTED',approval_request_id=?,submitted_at=?,version=version+1,updated_at=? WHERE id=?").bind(approval.id, now, now, batchId).run(); await addEvent(batchId, "SUBMITTED", String(batch.status), "SUBMITTED", authorization.principal.employeeId, "데이터 반영 결재 제출", { approvalRequestId: approval.id }); }
  else if (action === "APPLY") { if (String(batch.status) !== "APPROVED") return Response.json({ error: "최종 승인된 배치만 반영할 수 있습니다." }, { status: 409 }); if (!supportedApplySources.has(String(batch.source_id))) return Response.json({ error: "이 원천은 업무 원장 반영 매핑 확정 전입니다. 승인된 원본과 검증 결과는 보존됩니다." }, { status: 409 }); await applyBatch(batch, authorization.principal.employeeId); }
  else return Response.json({ error: "지원하지 않는 수집 작업입니다." }, { status: 400 });
  await writeErpAudit(db, { principal: authorization.principal, module: "settings", action: `DATA_IMPORT_${action}`, entityType: "DATA_IMPORT_BATCH", entityId: batchId, before: { status: batch.status }, after: { action } }); return Response.json(await batchView(batchId));
}

async function applyBatch(batch: Record<string, unknown>, actor: string) {
  const rows = await db.prepare("SELECT * FROM erp_data_import_rows WHERE batch_id=? AND validation_status='VALID' AND proposed_action IN ('CREATE','UPDATE') ORDER BY row_number").bind(String(batch.id)).all<Record<string, unknown>>(); const now = Date.now(); const dataStatements: D1PreparedStatement[] = []; const rowIds: string[] = [];
  if (String(batch.source_id) === "hiworks-employees") {
    await ensureHrEmployeeRecordsSchema(db);
    for (const row of rows.results) { const value = JSON.parse(String(row.normalized_json)) as Record<string, string>; const employeeId = String(row.target_entity_id || value.employeeId || `import-${String(row.row_checksum).slice(0, 12)}`); dataStatements.push(db.prepare(`INSERT INTO hr_employee_records (employee_id,name,birth,email,phone,address,department,manager,employment_type,join_date,position,job_title,status,history_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'[]',?) ON CONFLICT(employee_id) DO UPDATE SET name=excluded.name,birth=COALESCE(NULLIF(excluded.birth,''),birth),email=excluded.email,phone=COALESCE(NULLIF(excluded.phone,''),phone),address=COALESCE(NULLIF(excluded.address,''),address),department=COALESCE(NULLIF(excluded.department,''),department),manager=excluded.manager,employment_type=COALESCE(NULLIF(excluded.employment_type,''),employment_type),join_date=COALESCE(NULLIF(excluded.join_date,''),join_date),position=COALESCE(NULLIF(excluded.position,''),position),job_title=COALESCE(NULLIF(excluded.job_title,''),job_title),status=COALESCE(NULLIF(excluded.status,''),status),updated_at=excluded.updated_at`).bind(employeeId, value.name, value.birth, value.email, value.phone, value.address, value.department, value.manager, value.employmentType, value.joinDate, value.position, value.jobTitle, value.status || "재직", now)); rowIds.push(String(row.id)); }
  } else {
    dataStatements.push(db.prepare(`CREATE TABLE IF NOT EXISTS hr_payroll_records (id TEXT PRIMARY KEY,year_month TEXT NOT NULL,employee_id TEXT,employee_name TEXT NOT NULL,department TEXT,annual_salary INTEGER NOT NULL,base_pay INTEGER NOT NULL,meal_allowance INTEGER NOT NULL,childcare_allowance INTEGER NOT NULL,vehicle_allowance INTEGER NOT NULL,incentive INTEGER NOT NULL,bonus INTEGER NOT NULL,annual_leave_pay INTEGER NOT NULL,retirement_pay INTEGER NOT NULL,deductions INTEGER NOT NULL,gross_pay INTEGER NOT NULL,net_pay INTEGER NOT NULL,card_allowance INTEGER NOT NULL,card_usage INTEGER NOT NULL,personal_purchase INTEGER NOT NULL,non_taxable INTEGER NOT NULL,welfare_fund INTEGER NOT NULL,notes TEXT NOT NULL DEFAULT '',source_sheet TEXT NOT NULL,source_row INTEGER NOT NULL,imported_at INTEGER NOT NULL)`));
    dataStatements.push(db.prepare(`CREATE TABLE IF NOT EXISTS hr_payroll_runs (period TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT', employee_count INTEGER NOT NULL DEFAULT 0, gross_pay INTEGER NOT NULL DEFAULT 0, deductions INTEGER NOT NULL DEFAULT 0, net_pay INTEGER NOT NULL DEFAULT 0, prepared_by TEXT NOT NULL DEFAULT '', reviewed_by TEXT NOT NULL DEFAULT '', approved_by TEXT NOT NULL DEFAULT '', locked_at INTEGER, reopened_reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`));
    // Skip (not overwrite) rows whose payroll month has already left DRAFT (REVIEW/APPROVED/LOCKED) — a re-collected
    // spreadsheet must not silently corrupt figures already reviewed/approved/reported to the tax accountant.
    for (const row of rows.results) { const v = JSON.parse(String(row.normalized_json)) as Record<string, string | number>; dataStatements.push(db.prepare(`INSERT INTO hr_payroll_records (id,year_month,employee_name,annual_salary,base_pay,meal_allowance,childcare_allowance,vehicle_allowance,incentive,bonus,annual_leave_pay,retirement_pay,deductions,gross_pay,net_pay,card_allowance,card_usage,personal_purchase,non_taxable,welfare_fund,notes,source_sheet,source_row,imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET annual_salary=excluded.annual_salary,base_pay=excluded.base_pay,meal_allowance=excluded.meal_allowance,childcare_allowance=excluded.childcare_allowance,vehicle_allowance=excluded.vehicle_allowance,incentive=excluded.incentive,bonus=excluded.bonus,annual_leave_pay=excluded.annual_leave_pay,retirement_pay=excluded.retirement_pay,deductions=excluded.deductions,gross_pay=excluded.gross_pay,net_pay=excluded.net_pay,card_allowance=excluded.card_allowance,card_usage=excluded.card_usage,personal_purchase=excluded.personal_purchase,non_taxable=excluded.non_taxable,welfare_fund=excluded.welfare_fund,notes=excluded.notes,source_sheet=excluded.source_sheet,source_row=excluded.source_row,imported_at=excluded.imported_at WHERE NOT EXISTS (SELECT 1 FROM hr_payroll_runs WHERE period = excluded.year_month AND status NOT IN ('DRAFT'))`).bind(v.id, v.yearMonth, v.employeeName, v.annualSalary, v.basePay, v.mealAllowance, v.childcareAllowance, v.vehicleAllowance, v.incentive, v.bonus, v.annualLeavePay, v.retirementPay, v.deductions, v.grossPay, v.netPay, v.cardAllowance, v.cardUsage, v.personalPurchase, v.nonTaxable, v.welfareFund, v.notes, v.sourceSheet, v.sourceRow, now)); rowIds.push(String(row.id)); }
  }
  const dataResults = dataStatements.length ? await db.batch(dataStatements) : [];
  const leadingCount = dataStatements.length - rowIds.length;
  // Only mark rows that actually wrote as applied — a row whose INSERT was silently skipped by the
  // locked-payroll-month guard above must not be recorded as reflected in the ledger.
  const appliedRowIds = rowIds.filter((_, index) => (dataResults[leadingCount + index]?.meta.changes ?? 0) >= 1);
  const skippedLockedRows = rowIds.length - appliedRowIds.length;
  const bookkeeping: D1PreparedStatement[] = [];
  if (appliedRowIds.length) bookkeeping.push(db.prepare(`UPDATE erp_data_import_rows SET applied_at=? WHERE id IN (${appliedRowIds.map(() => "?").join(",")})`).bind(now, ...appliedRowIds));
  const applyNote = skippedLockedRows ? `승인된 유효 행을 원자적으로 업무 원장에 반영 (잠긴 급여월 ${skippedLockedRows}건 제외)` : "승인된 유효 행을 원자적으로 업무 원장에 반영";
  bookkeeping.push(db.prepare("UPDATE erp_data_import_batches SET status='APPLIED',applied_at=?,applied_by=?,version=version+1,updated_at=? WHERE id=? AND status='APPROVED'").bind(now, actor, now, String(batch.id)), db.prepare(`INSERT INTO erp_data_import_events (id,batch_id,action,from_status,to_status,actor_employee_id,note,snapshot_json,created_at) VALUES (?,?,'APPLIED','APPROVED','APPLIED',?,?,?,?)`).bind(crypto.randomUUID(), String(batch.id), actor, applyNote, JSON.stringify({ appliedRows: appliedRowIds.length, skippedLockedRows }), now), db.prepare(`INSERT INTO erp_sync_runs (id,source,scope,snapshot_date,status,record_count,metrics_json,error_message,started_at,completed_at,created_at,source_id,run_type,trigger_type,idempotency_key,source_checksum,received_count,inserted_count,updated_count,requested_by,report_json) VALUES (?,?,?,?, 'SUCCEEDED',?,'{}','',?,?,?,?,?,'IMPORT','APPROVED_IMPORT',?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), "FILE", String(batch.source_id), new Date(now).toISOString().slice(0, 10), appliedRowIds.length, now, now, now, String(batch.source_id), `${String(batch.id)}:${String(batch.file_sha256)}`, String(batch.file_sha256), Number(batch.total_rows), Number(batch.create_rows), Number(batch.update_rows), actor, JSON.stringify({ batchId: batch.id, approvalRequestId: batch.approval_request_id })));
  await db.batch(bookkeeping); await addEvent(String(batch.id), "APPLY_CONFIRMED", "APPROVED", "APPLIED", actor, skippedLockedRows ? `반영 완료 (잠긴 급여월 ${skippedLockedRows}건 제외) 후 실행 원장 연결` : "반영 완료 후 실행 원장 연결", { appliedRows: appliedRowIds.length, skippedLockedRows });
}
