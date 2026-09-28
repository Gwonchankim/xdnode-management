import { env } from "cloudflare:workers";
import { ensureHrEmployeeRecordsSchema } from "../../../hr-employee-schema";
import { companyEmployees, companyOrganizations } from "../../../hr-company-data";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { validateRecruitmentInterview } from "../../../assistant-recruitment";

type HrBindings = { DB: D1Database; HR_AUDIO: R2Bucket };
const bindings = env as unknown as HrBindings;
const db = bindings.DB;
const employeeIds = new Set(companyEmployees.map((employee) => employee.id));

type ApplicantRow = {
  id: string; name: string; role: string; applied: string; owner_id: string; stage: string;
  experience: string; email: string; phone: string; source: string; summary: string; career_summary: string;
  birth: string | null; address: string | null;
  resume_file_name: string; resume_text: string; checklist_json: string; screening_memos_json: string;
  interview_json: string | null; interview_memos_json: string; requisition_id: string; updated_at: number;
};
type OfferRow = {
  id: string; applicant_id: string; proposed_title: string; department: string; employment_type: string;
  start_date: string; annual_salary: number; probation_months: number; first_term_pay_percent: number | null; notes: string; status: string;
  requested_by: string; approved_by: string; approved_at: number | null; employee_id: string;
  position: string; job_title: string; response_note: string; responded_by: string; responded_at: number | null;
  cancellation_reason: string; cancelled_by: string; cancelled_at: number | null;
  onboarded_by: string; onboarded_at: number | null;
  created_at: number; updated_at: number;
};

async function ensureSchema() {
  await ensureHrEmployeeRecordsSchema(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_recruiters (
      employee_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_applicants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, applied TEXT NOT NULL,
      owner_id TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL, experience TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      resume_file_name TEXT NOT NULL DEFAULT '', resume_text TEXT NOT NULL DEFAULT '',
      checklist_json TEXT NOT NULL DEFAULT '[]', screening_memos_json TEXT NOT NULL DEFAULT '[]',
      interview_json TEXT, interview_memos_json TEXT NOT NULL DEFAULT '[]',
      requisition_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_offer_requests (
      id TEXT PRIMARY KEY NOT NULL, applicant_id TEXT NOT NULL, proposed_title TEXT NOT NULL,
      department TEXT NOT NULL, employment_type TEXT NOT NULL, start_date TEXT NOT NULL,
      annual_salary INTEGER NOT NULL, probation_months INTEGER NOT NULL DEFAULT 3, first_term_pay_percent INTEGER NOT NULL DEFAULT 100, notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'SUBMITTED', requested_by TEXT NOT NULL, approved_by TEXT NOT NULL DEFAULT '',
      approved_at INTEGER, employee_id TEXT NOT NULL DEFAULT '', response_note TEXT NOT NULL DEFAULT '',
      position TEXT NOT NULL DEFAULT '', job_title TEXT NOT NULL DEFAULT '',
      responded_by TEXT NOT NULL DEFAULT '', responded_at INTEGER,
      cancellation_reason TEXT NOT NULL DEFAULT '', cancelled_by TEXT NOT NULL DEFAULT '', cancelled_at INTEGER,
      onboarded_by TEXT NOT NULL DEFAULT '', onboarded_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_organization_records (
      organization_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_lifecycle_tasks (
      id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, lifecycle_type TEXT NOT NULL, task_group TEXT NOT NULL,
      title TEXT NOT NULL, owner_employee_id TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'OPEN', completed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_applicants_name ON hr_applicants (name)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_applicants_email ON hr_applicants (email)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_applicants_phone ON hr_applicants (phone)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_offer_applicant_created ON hr_offer_requests(applicant_id, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_offer_status_start ON hr_offer_requests(status, start_date)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_offer_onboarding_status_start ON hr_offer_requests(status, start_date) WHERE status IN ('ACCEPTED', 'ONBOARDED')"),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_recruitment_requisitions (
      id TEXT PRIMARY KEY NOT NULL, workforce_plan_id TEXT NOT NULL, workforce_plan_line_id TEXT NOT NULL,
      organization_id TEXT NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL,
      requested_headcount INTEGER NOT NULL DEFAULT 1, owner_employee_id TEXT NOT NULL,
      target_start_date TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
      requested_by TEXT NOT NULL, approved_by TEXT NOT NULL DEFAULT '', approved_at INTEGER,
      closed_by TEXT NOT NULL DEFAULT '', closed_at INTEGER, close_reason TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS applicant_interview_recordings (
      id TEXT PRIMARY KEY, applicant_id TEXT NOT NULL, recorded_at TEXT NOT NULL,
      audio_key TEXT NOT NULL, audio_content_type TEXT NOT NULL, audio_file_name TEXT NOT NULL,
      consent_confirmed_by TEXT NOT NULL DEFAULT '', consent_confirmed_at INTEGER,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_applicant_interview_recordings_applicant_created
      ON applicant_interview_recordings(applicant_id, created_at)`),
    db.prepare("INSERT OR IGNORE INTO hr_recruiters (employee_id, created_at) VALUES ('gc.kim', 0)"),
  ]);
  const offerColumns = await db.prepare("PRAGMA table_info(hr_offer_requests)").all<{ name: string }>();
  const existing = new Set(offerColumns.results.map((column) => column.name));
  for (const [name, definition] of [
    ["employee_id", "TEXT NOT NULL DEFAULT ''"],
    ["position", "TEXT NOT NULL DEFAULT ''"],
    ["job_title", "TEXT NOT NULL DEFAULT ''"],
    ["response_note", "TEXT NOT NULL DEFAULT ''"],
    ["responded_by", "TEXT NOT NULL DEFAULT ''"],
    ["cancellation_reason", "TEXT NOT NULL DEFAULT ''"],
    ["cancelled_by", "TEXT NOT NULL DEFAULT ''"],
    ["cancelled_at", "INTEGER"],
    ["onboarded_by", "TEXT NOT NULL DEFAULT ''"],
    ["onboarded_at", "INTEGER"],
    ["first_term_pay_percent", "INTEGER NOT NULL DEFAULT 100"],
  ].filter(([name]) => !existing.has(name))) {
    await db.prepare(`ALTER TABLE hr_offer_requests ADD COLUMN ${name} ${definition}`).run();
  }
  const applicantColumns = await db.prepare("PRAGMA table_info(hr_applicants)").all<{ name: string }>();
  if (!applicantColumns.results.some((column) => column.name === "requisition_id")) {
    await db.prepare("ALTER TABLE hr_applicants ADD COLUMN requisition_id TEXT NOT NULL DEFAULT ''").run();
  }
  // 경력(근무 이력)과 이력서 요약을 나눠 적는다. summary 는 기존 이력서 요약 그대로 두고,
  // 근무처와 거기서 한 일은 career_summary 에 따로 담는다.
  if (!applicantColumns.results.some((column) => column.name === "career_summary")) {
    await db.prepare("ALTER TABLE hr_applicants ADD COLUMN career_summary TEXT NOT NULL DEFAULT ''").run();
  }
  // 생년월일·주소는 입사 전환 때 인사기록카드와 근로계약서 서명란으로 넘어간다. 예전에는 지원 단계에 칸이 없어 늘 빈칸으로 시작했다.
  for (const column of ["birth", "address"]) {
    if (!applicantColumns.results.some((item) => item.name === column)) await db.prepare(`ALTER TABLE hr_applicants ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`).run();
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_applicants_requisition ON hr_applicants(requisition_id)").run();
}

/** 회사의 급여 구성 기준. 재직자 26명 전원이 이 산식으로 되어 있다 —
 *  월 지급액은 연봉을 12로 나눠 올림한 값이고, 그중 식대 20만 원을 뺀 나머지가 기본급이다.
 *  입사자도 같은 기준으로 채워 두어야 임금계산에서 0원짜리 대상자로 잡히지 않는다.
 *  월 지급액이 식대에 못 미치는 예외적인 금액이면 전액을 기본급으로 둔다. */
const STANDARD_MEAL_ALLOWANCE = 200_000;

/** 첫 계약(3개월 기간제) 동안 기준 연봉의 몇 %를 줄지. 사람마다 다르며 처우 제안 때 정한다.
 *  비워 보내면 fallback(직전 값)을 쓰고, 값이 있는데 1~100 정수가 아니면 null 로 거절한다. */
function payPercentOf(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const percent = Number(value);
  return Number.isInteger(percent) && percent >= 1 && percent <= 100 ? percent : null;
}

function onboardingPayBreakdown(annualSalary: number) {
  const annual = Number.isFinite(annualSalary) && annualSalary > 0 ? Math.round(annualSalary) : 0;
  const monthly = Math.ceil(annual / 12);
  const meal = monthly > STANDARD_MEAL_ALLOWANCE ? STANDARD_MEAL_ALLOWANCE : 0;
  return { annual, basePay: monthly - meal, meal };
}

/** 지원 때 받은 이력서를 입사자의 인사문서로 넘긴다.
 *  원본 파일이 남아 있으면 그것을 복사하고, 없으면(이전에 등록돼 텍스트만 있는 경우)
 *  추출해 둔 원문을 txt 로 만들어 남긴다 — 최소한 무엇을 보고 뽑았는지는 남게 한다.
 *  실패해도 입사 전환 자체는 되돌리지 않는다. 문서는 나중에 다시 올릴 수 있다. */
async function copyResumeToEmployee(applicant: ApplicantRow, employeeId: string, uploadedBy: string) {
  const source = await db.prepare(`SELECT id, file_name, content_type, storage_key FROM erp_documents
    WHERE module = 'hr' AND entity_type = 'applicant' AND entity_id = ? AND category = 'RESUME' AND deleted_at IS NULL
    ORDER BY version DESC LIMIT 1`)
    .bind(applicant.id).first<{ id: string; file_name: string; content_type: string; storage_key: string }>();

  let body: ArrayBuffer;
  let fileName: string;
  let contentType: string;
  if (source) {
    const object = await bindings.HR_AUDIO.get(source.storage_key);
    if (!object) return null;
    body = await object.arrayBuffer();
    fileName = source.file_name;
    contentType = source.content_type;
  } else {
    const text = (applicant.resume_text ?? "").trim();
    if (!text) return null;
    body = new TextEncoder().encode(text).buffer as ArrayBuffer;
    fileName = `${applicant.name}_이력서(추출본).txt`;
    contentType = "text/plain";
  }

  const latest = await db.prepare(`SELECT MAX(version) AS version FROM erp_documents
    WHERE module = 'hr' AND entity_type = 'employee' AND entity_id = ? AND category = 'RESUME'`)
    .bind(employeeId).first<{ version: number | null }>();
  const version = (latest?.version ?? 0) + 1;
  const documentId = crypto.randomUUID();
  const extension = fileName.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  // 원본과 같은 키를 재사용하지 않는다. 한쪽을 지웠을 때 다른 쪽이 빈 껍데기가 되기 때문이다.
  const storageKey = `erp-documents/hr/employee/${encodeURIComponent(employeeId)}/${documentId}.${extension}`;
  await bindings.HR_AUDIO.put(storageKey, body, { httpMetadata: { contentType } });
  try {
    await db.prepare(`INSERT INTO erp_documents
      (id, module, entity_type, entity_id, category, version, file_name, content_type, storage_key, uploaded_by, created_at, deleted_at)
      VALUES (?, 'hr', 'employee', ?, 'RESUME', ?, ?, ?, ?, ?, ?, NULL)`)
      .bind(documentId, employeeId, version, fileName.slice(0, 240), contentType, storageKey, uploadedBy, Date.now()).run();
  } catch (error) {
    await bindings.HR_AUDIO.delete(storageKey);
    throw error;
  }
  return { documentId, fileName, version, fromOriginal: Boolean(source) };
}

function safeJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function toApplicant(row: ApplicantRow) {
  const owner = companyEmployees.find((employee) => employee.id === row.owner_id)?.name ?? "미지정";
  return {
    id: row.id, name: row.name, role: row.role, applied: row.applied, ownerId: row.owner_id, owner,
    stage: row.stage, experience: row.experience, email: row.email, phone: row.phone, source: row.source,
    summary: row.summary, careerSummary: row.career_summary ?? "", birth: row.birth ?? "", address: row.address ?? "", resumeFileName: row.resume_file_name, resumeText: row.resume_text,
    checklist: safeJson<string[]>(row.checklist_json, []),
    screeningMemos: safeJson<unknown[]>(row.screening_memos_json, []),
    interview: row.interview_json ? safeJson<unknown>(row.interview_json, undefined) : undefined,
    interviewMemos: safeJson<unknown[]>(row.interview_memos_json, []),
    requisitionId: row.requisition_id,
  };
}

function toOffer(row: OfferRow) {
  return {
    id: row.id, applicantId: row.applicant_id, proposedTitle: row.proposed_title, department: row.department,
    employmentType: row.employment_type, startDate: row.start_date, annualSalary: row.annual_salary,
    probationMonths: row.probation_months, firstTermPayPercent: row.first_term_pay_percent ?? 100, notes: row.notes, status: row.status,
    requestedBy: row.requested_by, approvedBy: row.approved_by, approvedAt: row.approved_at,
    employeeId: row.employee_id, position: row.position, jobTitle: row.job_title,
    responseNote: row.response_note, respondedBy: row.responded_by, respondedAt: row.responded_at,
    cancellationReason: row.cancellation_reason, cancelledBy: row.cancelled_by, cancelledAt: row.cancelled_at,
    onboardedBy: row.onboarded_by, onboardedAt: row.onboarded_at,
  };
}

const offerStage = (status: string) => ({ SUBMITTED: "채용 제안 확인 중", APPROVED: "채용 제안 준비", REJECTED: "채용 제안 종료", ACCEPTED: "입사 예정", ONBOARDED: "입사 완료", DECLINED: "채용 제안 거절", CANCELLED: "입사 취소" })[status];

export async function GET() {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "recruitment", "read");
  if (authorization.response) return authorization.response;
  const [applicantResult, recruiterResult, offerResult, requisitionResult] = await Promise.all([
    db.prepare(`SELECT id, name, role, applied, owner_id, stage, experience, email, phone, source, summary, career_summary, birth, address,
      resume_file_name, resume_text, checklist_json, screening_memos_json, interview_json, interview_memos_json, requisition_id, updated_at
      FROM hr_applicants ORDER BY applied DESC, updated_at DESC`).all<ApplicantRow>(),
    db.prepare("SELECT employee_id FROM hr_recruiters ORDER BY created_at ASC").all<{ employee_id: string }>(),
    db.prepare("SELECT * FROM hr_offer_requests ORDER BY created_at DESC").all<OfferRow>(),
    // 종료된 공고도 함께 내려준다. 지원자에는 연결이 그대로 남아 있어서, 진행 중인 것만
    // 내려주면 종료 후 화면에서만 "예외·미연결"로 보인다. 새로 고를 수 있는 공고를 거르는 일은
    // 선택 상자 쪽에서 status 로 한다(app/hr-workspace.tsx).
    db.prepare(`SELECT id, title, role, organization_id, requested_headcount, status
      FROM hr_recruitment_requisitions ORDER BY created_at DESC`)
      .all<{ id: string; title: string; role: string; organization_id: string; requested_headcount: number; status: string }>(),
  ]);
  const latestOffer = new Map<string, ReturnType<typeof toOffer>>();
  offerResult.results.forEach((row) => { if (!latestOffer.has(row.applicant_id)) latestOffer.set(row.applicant_id, toOffer(row)); });
  return Response.json({
    applicants: applicantResult.results.map((row) => {
      const offer = latestOffer.get(row.id);
      // 오퍼 상태로 단계를 다시 만들되, 저장된 단계가 더 구체적이면 그대로 둔다.
      // 타사 합격은 오퍼 상태가 DECLINED 라서, 덮어쓰면 "채용 제안 거절"로 되돌아간다.
      const derived = offerStage(offer?.status ?? "");
      const keepStored = row.stage === "타사 합격";
      return { ...toApplicant(row), ...(derived && !keepStored ? { stage: derived } : {}), offer };
    }),
    recruiterIds: recruiterResult.results.map((row: { employee_id: string }) => row.employee_id),
    offers: offerResult.results.map(toOffer),
    requisitions: requisitionResult.results.map((row) => ({ id: row.id, title: row.title, role: row.role, organizationId: row.organization_id, requestedHeadcount: row.requested_headcount, status: row.status })),
  });
}

export async function PUT(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "recruitment", "write");
  if (authorization.response) return authorization.response;
  const body = await request.json() as Record<string, unknown>;
  const stringValue = (key: string) => typeof body[key] === "string" ? String(body[key]) : "";
  const id = stringValue("id").trim();
  const resource = stringValue("resource").trim();
  if (resource === "offerResponse") {
    const action = stringValue("action").trim().toUpperCase();
    if (!id || !["ACCEPT", "DECLINE"].includes(action)) return Response.json({ error: "채용 제안과 응답 결과를 확인해 주세요." }, { status: 400 });
    const offer = await db.prepare("SELECT * FROM hr_offer_requests WHERE id = ?").bind(id).first<OfferRow>();
    if (!offer) return Response.json({ error: "채용 제안을 찾을 수 없습니다." }, { status: 404 });
    if (offer.status !== "APPROVED") return Response.json({ error: "승인 완료된 채용 제안만 수락 또는 거절 처리할 수 있습니다." }, { status: 409 });
    const applicant = await db.prepare("SELECT * FROM hr_applicants WHERE id = ?").bind(offer.applicant_id).first<ApplicantRow>();
    if (!applicant) return Response.json({ error: "지원자 정보를 찾을 수 없습니다." }, { status: 404 });
    const now = Date.now();
    const responseNote = stringValue("responseNote").trim();
    if (action === "DECLINE") {
      // 타사 합격은 우리가 떨어뜨린 것이 아니라 지원자가 다른 회사로 간 경우다. 채용단계 열에서
      // "탈락"과 구분해 보여야 해서 단계 이름을 달리 저장한다. 제안 자체는 똑같이 DECLINED 다.
      const declinedStage = stringValue("declineKind").trim() === "OTHER_OFFER" ? "타사 합격" : "채용 제안 거절";
      await db.batch([
        db.prepare(`UPDATE hr_offer_requests SET status = 'DECLINED', response_note = ?, responded_by = ?, responded_at = ?, updated_at = ?
          WHERE id = ? AND status = 'APPROVED'`).bind(responseNote, authorization.principal.employeeId, now, now, id),
        db.prepare(`UPDATE hr_applicants SET stage = ?, updated_at = ? WHERE id = ?
          AND EXISTS (SELECT 1 FROM hr_offer_requests WHERE id = ? AND status = 'DECLINED' AND updated_at = ?)`)
          .bind(declinedStage, now, offer.applicant_id, id, now),
      ]);
      const after = await db.prepare("SELECT * FROM hr_offer_requests WHERE id = ?").bind(id).first<OfferRow>();
      await writeErpAudit(db, { principal: authorization.principal, module: "recruitment", action: "OFFER_DECLINED", entityType: "recruitmentOffer", entityId: id, before: toOffer(offer), after: after ? toOffer(after) : null, reason: responseNote });
      // 화면이 단계를 다시 추측하지 않도록 여기서 정한 값을 그대로 돌려준다.
      return Response.json({ offer: after ? toOffer(after) : null, stage: declinedStage });
    }

    const hrAuthorization = await authorizeErpRequest(db, "hr", "write");
    if (hrAuthorization.response) return hrAuthorization.response;
    if (applicant.requisition_id) {
      const requisition = await db.prepare("SELECT requested_headcount, status FROM hr_recruitment_requisitions WHERE id = ?")
        .bind(applicant.requisition_id).first<{ requested_headcount: number; status: string }>();
      const filled = await db.prepare(`SELECT COUNT(DISTINCT a.id) AS count FROM hr_applicants a
        JOIN hr_offer_requests o ON o.applicant_id = a.id
        WHERE a.requisition_id = ? AND o.status IN ('ACCEPTED', 'ONBOARDED')`).bind(applicant.requisition_id).first<{ count: number }>();
      if (!requisition || requisition.status !== "OPEN" || (filled?.count ?? 0) >= requisition.requested_headcount) {
        return Response.json({ error: "연결된 TO의 잔여 인원이 없어 입사 전환할 수 없습니다. 정원과 채용요청을 다시 확인해 주세요." }, { status: 409 });
      }
    }
    const employeeId = stringValue("employeeId").trim();
    const position = stringValue("position").trim();
    const jobTitle = stringValue("jobTitle").trim() || offer.proposed_title;
    if (!employeeId || !position || !jobTitle) return Response.json({ error: "입사 전환을 위한 사번·직위·직책을 입력해 주세요." }, { status: 400 });
    if (employeeIds.has(employeeId)) return Response.json({ error: "이미 회사 기준자료에 등록된 사번입니다." }, { status: 409 });
    const duplicate = await db.prepare("SELECT employee_id FROM hr_employee_records WHERE employee_id = ?")
      .bind(employeeId).first<{ employee_id: string }>();
    if (duplicate) return Response.json({ error: "이미 등록된 사번입니다." }, { status: 409 });
    const taskTemplates = [
      ["CONTRACT", "근로계약서 작성·서명"], ["ACCOUNT", "이메일·업무 계정 발급"],
      ["EQUIPMENT", "장비·출입권한 준비"], ["ORIENTATION", "오리엔테이션·부서 인수인계"],
    ];
    // 수락 팝업에서 최종 처우를 고칠 수 있다. 오지 않은 항목은 제안 당시 값을 그대로 쓴다.
    // 제안 저장(POST offer)은 진행 중인 제안이 있으면 409 라, 확정 값은 여기서 함께 받는다.
    const finalStartDate = /^\d{4}-\d{2}-\d{2}$/.test(stringValue("startDate").trim()) ? stringValue("startDate").trim() : offer.start_date;
    const finalSalaryInput = Number(body.annualSalary);
    const finalSalary = Number.isFinite(finalSalaryInput) && finalSalaryInput > 0 ? Math.round(finalSalaryInput) : offer.annual_salary;
    const finalProbationInput = Number(body.probationMonths);
    const finalProbation = Number.isInteger(finalProbationInput) && finalProbationInput >= 0 && finalProbationInput <= 12
      ? finalProbationInput : offer.probation_months;
    const finalPayPercent = payPercentOf(body.firstTermPayPercent, offer.first_term_pay_percent ?? 100);
    if (finalPayPercent === null) return Response.json({ error: "첫 계약 지급률은 1~100 사이의 정수로 입력해 주세요." }, { status: 400 });
    const finalDepartment = stringValue("department").trim() || offer.department;
    const finalProposedTitle = stringValue("proposedTitle").trim() || offer.proposed_title;
    const finalEmploymentType = stringValue("employmentType").trim() || offer.employment_type;

    const statements = [
      db.prepare(`UPDATE hr_offer_requests SET status = 'ACCEPTED', employee_id = ?, position = ?, job_title = ?,
        start_date = ?, annual_salary = ?, probation_months = ?, first_term_pay_percent = ?, department = ?, proposed_title = ?, employment_type = ?,
        response_note = ?, responded_by = ?, responded_at = ?, updated_at = ?
        WHERE id = ? AND status = 'APPROVED' AND (
          NOT EXISTS (SELECT 1 FROM hr_applicants a WHERE a.id = hr_offer_requests.applicant_id AND TRIM(a.requisition_id) <> '')
          OR EXISTS (SELECT 1 FROM hr_applicants a JOIN hr_recruitment_requisitions r ON r.id = a.requisition_id
            WHERE a.id = hr_offer_requests.applicant_id AND r.status = 'OPEN'
              AND r.requested_headcount > (SELECT COUNT(DISTINCT accepted.id) FROM hr_applicants accepted
                JOIN hr_offer_requests accepted_offer ON accepted_offer.applicant_id = accepted.id
                WHERE accepted.requisition_id = r.id AND accepted_offer.status IN ('ACCEPTED', 'ONBOARDED')))
        )`).bind(employeeId, position, jobTitle, finalStartDate, finalSalary, finalProbation, finalPayPercent,
          finalDepartment, finalProposedTitle, finalEmploymentType,
          responseNote, authorization.principal.employeeId, now, now, id),
      db.prepare(`UPDATE hr_applicants SET stage = '입사 예정', updated_at = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM hr_offer_requests WHERE id = ? AND status = 'ACCEPTED' AND updated_at = ?)`)
        .bind(now, offer.applicant_id, id, now),
      ...taskTemplates.map(([group, title]) => db.prepare(`INSERT INTO hr_lifecycle_tasks
        (id, employee_id, lifecycle_type, task_group, title, owner_employee_id, due_date, status, completed_at, created_at, updated_at)
        SELECT ?, ?, 'ONBOARDING', ?, ?, ?, ?, 'OPEN', NULL, ?, ?
        WHERE EXISTS (SELECT 1 FROM hr_offer_requests WHERE id = ? AND status = 'ACCEPTED' AND updated_at = ?)`)
        // 입사 준비 업무의 기한은 수락 팝업에서 확정한 입사일을 따른다.
        .bind(`${id}:ONBOARDING:${group}`, employeeId, group, title, authorization.principal.employeeId, finalStartDate, now, now, id, now)),
    ];
    if (applicant.requisition_id) {
      statements.push(db.prepare(`UPDATE hr_recruitment_requisitions SET status = 'FILLED', closed_by = ?, closed_at = ?,
        close_reason = '요청 인원 입사 확정', updated_at = ? WHERE id = ? AND status = 'OPEN'
          AND requested_headcount <= (SELECT COUNT(DISTINCT a.id) FROM hr_applicants a
            JOIN hr_offer_requests o ON o.applicant_id = a.id
            WHERE a.requisition_id = ? AND o.status IN ('ACCEPTED', 'ONBOARDED'))`)
        .bind(authorization.principal.employeeId, now, now, applicant.requisition_id, applicant.requisition_id));
    }
    const result = await db.batch(statements);
    if ((result[0].meta.changes ?? 0) < 1) return Response.json({ error: "채용 제안 상태가 변경되어 입사 전환하지 못했습니다." }, { status: 409 });
    const after = await db.prepare("SELECT * FROM hr_offer_requests WHERE id = ?").bind(id).first<OfferRow>();
    await writeErpAudit(db, { principal: hrAuthorization.principal, module: "hr", action: "ONBOARDING_CREATED", entityType: "onboardingCandidate", entityId: id, before: toOffer(offer), after: { offer: after ? toOffer(after) : null, employeeId, tasks: taskTemplates.map((item) => item[1]) }, reason: responseNote });
    // 지원 때 본 이력서를 입사자 인사문서로 옮긴다. 실패해도 입사 전환은 그대로 둔다.
    let resumeDocument: Awaited<ReturnType<typeof copyResumeToEmployee>> = null;
    try {
      resumeDocument = await copyResumeToEmployee(applicant, employeeId, hrAuthorization.principal.employeeId);
    } catch { resumeDocument = null; }
    if (resumeDocument) {
      await writeErpAudit(db, {
        principal: hrAuthorization.principal, module: "hr", action: "DOCUMENT_UPLOADED",
        entityType: "employee", entityId: employeeId,
        after: { ...resumeDocument, category: "RESUME", copiedFromApplicant: applicant.id },
      });
    }
    return Response.json({ offer: after ? toOffer(after) : null, employeeId }, { status: 201 });
  }

  if (["onboardingUpdate", "onboardingComplete", "onboardingCancel"].includes(resource)) {
    const hrAuthorization = await authorizeErpRequest(db, "hr", "write");
    if (hrAuthorization.response) return hrAuthorization.response;
    if (!id) return Response.json({ error: "입사 예정자 정보를 확인해 주세요." }, { status: 400 });
    const offer = await db.prepare("SELECT * FROM hr_offer_requests WHERE id = ?").bind(id).first<OfferRow>();
    if (!offer) return Response.json({ error: "입사 예정 정보를 찾을 수 없습니다." }, { status: 404 });
    const applicant = await db.prepare("SELECT * FROM hr_applicants WHERE id = ?").bind(offer.applicant_id).first<ApplicantRow>();
    if (!applicant) return Response.json({ error: "지원자 정보를 찾을 수 없습니다." }, { status: 404 });
    if (offer.status !== "ACCEPTED") return Response.json({ error: offer.status === "ONBOARDED" ? "이미 입사 완료된 인원입니다." : "현재 입사 관리 중인 인원만 처리할 수 있습니다." }, { status: 409 });
    const now = Date.now();

    if (resource === "onboardingUpdate") {
      const employeeId = stringValue("employeeId").trim();
      const startDate = stringValue("startDate").trim();
      const department = stringValue("department").trim();
      const proposedTitle = stringValue("proposedTitle").trim();
      const position = stringValue("position").trim();
      const jobTitle = stringValue("jobTitle").trim();
      const employmentType = stringValue("employmentType").trim();
      const annualSalary = Number(body.annualSalary);
      const probationMonths = Number(body.probationMonths);
      const firstTermPayPercent = payPercentOf(body.firstTermPayPercent, offer.first_term_pay_percent ?? 100);
      if (firstTermPayPercent === null) return Response.json({ error: "첫 계약 지급률은 1~100 사이의 정수로 입력해 주세요." }, { status: 400 });
      const responseNote = stringValue("responseNote").trim();
      if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !department || !proposedTitle || !position || !jobTitle || !employmentType
        || !Number.isFinite(annualSalary) || annualSalary <= 0 || !Number.isInteger(probationMonths) || probationMonths < 0 || probationMonths > 12) {
        return Response.json({ error: "사번·입사예정일·소속·직무·직위·직책·고용형태·처우를 확인해 주세요." }, { status: 400 });
      }
      if (employeeId !== offer.employee_id) {
        if (employeeIds.has(employeeId)) return Response.json({ error: "이미 회사 기준자료에 등록된 사번입니다." }, { status: 409 });
        const duplicate = await db.prepare("SELECT employee_id FROM hr_employee_records WHERE employee_id = ?").bind(employeeId).first<{ employee_id: string }>();
        if (duplicate) return Response.json({ error: "이미 등록된 사번입니다." }, { status: 409 });
      }
      const result = await db.batch([
        db.prepare(`UPDATE hr_offer_requests SET employee_id = ?, start_date = ?, department = ?, proposed_title = ?,
          position = ?, job_title = ?, employment_type = ?, annual_salary = ?, probation_months = ?, first_term_pay_percent = ?, response_note = ?, updated_at = ?
          WHERE id = ? AND status = 'ACCEPTED'`)
          .bind(employeeId, startDate, department, proposedTitle, position, jobTitle, employmentType, Math.round(annualSalary), probationMonths, firstTermPayPercent, responseNote, now, id),
        db.prepare("UPDATE hr_lifecycle_tasks SET employee_id = ?, due_date = ?, updated_at = ? WHERE id LIKE ? AND lifecycle_type = 'ONBOARDING'")
          .bind(employeeId, startDate, now, `${id}:ONBOARDING:%`),
      ]);
      if ((result[0].meta.changes ?? 0) < 1) return Response.json({ error: "입사 예정 정보가 변경되어 저장하지 못했습니다." }, { status: 409 });
      const after = await db.prepare("SELECT * FROM hr_offer_requests WHERE id = ?").bind(id).first<OfferRow>();
      await writeErpAudit(db, { principal: hrAuthorization.principal, module: "hr", action: "ONBOARDING_UPDATED", entityType: "onboardingCandidate", entityId: id, before: toOffer(offer), after: after ? toOffer(after) : null, reason: responseNote });
      return Response.json({ offer: after ? toOffer(after) : null });
    }

    if (resource === "onboardingCancel") {
      const cancellationReason = stringValue("cancellationReason").trim();
      if (!cancellationReason) return Response.json({ error: "입사 취소 사유를 입력해 주세요." }, { status: 400 });
      const note = { id: `ONBOARDING-CANCEL-${now}`, text: `입사 취소: ${cancellationReason}`, author: hrAuthorization.principal.employeeId, createdAt: new Date(now).toISOString() };
      const notes = [note, ...safeJson<unknown[]>(applicant.screening_memos_json, [])];
      const result = await db.batch([
        db.prepare(`UPDATE hr_offer_requests SET status = 'CANCELLED', cancellation_reason = ?, cancelled_by = ?, cancelled_at = ?, updated_at = ?
          WHERE id = ? AND status = 'ACCEPTED'`).bind(cancellationReason, hrAuthorization.principal.employeeId, now, now, id),
        db.prepare(`UPDATE hr_applicants SET stage = '입사 취소', screening_memos_json = ?, updated_at = ? WHERE id = ?
          AND EXISTS (SELECT 1 FROM hr_offer_requests WHERE id = ? AND status = 'CANCELLED' AND updated_at = ?)`)
          .bind(JSON.stringify(notes), now, offer.applicant_id, id, now),
        db.prepare("DELETE FROM hr_lifecycle_tasks WHERE id LIKE ? AND lifecycle_type = 'ONBOARDING'").bind(`${id}:ONBOARDING:%`),
      ]);
      if ((result[0].meta.changes ?? 0) < 1) return Response.json({ error: "입사 예정 상태가 변경되어 취소하지 못했습니다." }, { status: 409 });
      const after = await db.prepare("SELECT * FROM hr_offer_requests WHERE id = ?").bind(id).first<OfferRow>();
      await writeErpAudit(db, { principal: hrAuthorization.principal, module: "hr", action: "ONBOARDING_CANCELLED", entityType: "onboardingCandidate", entityId: id, before: toOffer(offer), after: after ? toOffer(after) : null, reason: cancellationReason });
      return Response.json({ offer: after ? toOffer(after) : null, applicantNote: note });
    }

    if (employeeIds.has(offer.employee_id)) return Response.json({ error: "이미 회사 기준자료에 등록된 사번입니다." }, { status: 409 });
    const duplicate = await db.prepare("SELECT employee_id FROM hr_employee_records WHERE employee_id = ?")
      .bind(offer.employee_id).first<{ employee_id: string }>();
    if (duplicate) return Response.json({ error: "이미 인사기록카드에 등록된 사번입니다." }, { status: 409 });
    const history = [{ date: offer.start_date.replaceAll("-", "."), type: "입사", detail: `${offer.department} · ${offer.job_title || offer.proposed_title} · 입사 완료` }];
    const pay = onboardingPayBreakdown(offer.annual_salary);
    const result = await db.batch([
      db.prepare(`UPDATE hr_offer_requests SET status = 'ONBOARDED', onboarded_by = ?, onboarded_at = ?, updated_at = ?
        WHERE id = ? AND status = 'ACCEPTED'`).bind(hrAuthorization.principal.employeeId, now, now, id),
      // 확정한 연봉을 여기서 함께 넣는다. 예전에는 처우 컬럼이 빠져 있어 전부 0 으로 들어갔고,
      // 임금계산이 이 표를 그대로 읽는 탓에 갓 입사한 사람이 0원짜리 대상자로 잡혔다.
      db.prepare(`INSERT INTO hr_employee_records
        (employee_id, name, birth, email, phone, address, department, manager, employment_type, join_date,
          position, job_title, status, history_json, retirement_json,
          annual_salary, base_pay, meal_allowance, childcare_allowance, vehicle_allowance, first_term_pay_percent, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, '재직', ?, NULL, ?, ?, ?, 0, 0, ?, ?
        WHERE EXISTS (SELECT 1 FROM hr_offer_requests WHERE id = ? AND status = 'ONBOARDED' AND updated_at = ?)`)
        .bind(offer.employee_id, applicant.name, (applicant.birth ?? "").replaceAll("-", "."), applicant.email, applicant.phone, applicant.address ?? "", offer.department, offer.employment_type,
          offer.start_date.replaceAll("-", "."), offer.position, offer.job_title || offer.proposed_title, JSON.stringify(history),
          pay.annual, pay.basePay, pay.meal, offer.first_term_pay_percent ?? 100, now, id, now),
      db.prepare(`UPDATE hr_applicants SET stage = '입사 완료', updated_at = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM hr_offer_requests WHERE id = ? AND status = 'ONBOARDED' AND updated_at = ?)`)
        .bind(now, offer.applicant_id, id, now),
      db.prepare(`UPDATE hr_lifecycle_tasks SET status = 'DONE', completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE id LIKE ? AND lifecycle_type = 'ONBOARDING'`).bind(now, now, `${id}:ONBOARDING:%`),
    ]);
    if ((result[0].meta.changes ?? 0) < 1 || (result[1].meta.changes ?? 0) < 1) return Response.json({ error: "입사 예정 상태가 변경되어 완료하지 못했습니다." }, { status: 409 });
    const after = await db.prepare("SELECT * FROM hr_offer_requests WHERE id = ?").bind(id).first<OfferRow>();
    await writeErpAudit(db, { principal: hrAuthorization.principal, module: "hr", action: "ONBOARDING_COMPLETED", entityType: "employeeRecord", entityId: offer.employee_id, before: toOffer(offer), after: { offer: after ? toOffer(after) : null, employeeId: offer.employee_id } });
    return Response.json({ offer: after ? toOffer(after) : null, employeeId: offer.employee_id }, { status: 201 });
  }
  const name = stringValue("name").trim();
  const email = stringValue("email").trim();
  if (!id || !name || !email) return Response.json({ error: "지원자 ID, 이름, 이메일이 필요합니다." }, { status: 400 });
  const createOnly = body.createOnly === true;
  if (createOnly) {
    if (!stringValue("role").trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !stringValue("resumeText").trim()) return Response.json({ error: "지원 직무·이메일·이력서 내용을 확인해 주세요." }, { status: 400 });
    try { if (body.recruitmentHelper === true || body.interview) body.interview = validateRecruitmentInterview(body.interview, body.recruitmentHelper === true); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "면접 일정을 확인해 주세요." }, { status: 400 }); }
  }
  const interview = body.interview && typeof body.interview === "object" ? JSON.stringify(body.interview) : null;
  const requisitionId = stringValue("requisitionId").trim();
  if (requisitionId) {
    const requisition = await db.prepare("SELECT id, status FROM hr_recruitment_requisitions WHERE id = ?").bind(requisitionId).first<{ id: string; status: string }>();
    if (!requisition) return Response.json({ error: "채용요청·TO를 찾을 수 없습니다." }, { status: 409 });
    // 모집이 끝난 공고에 "새로" 연결하는 것만 막는다. 이미 그 공고에 붙어 있던 지원자는
    // 공고가 종료·충원되어도 계속 고칠 수 있어야 한다 — 면접 결과나 질문지를 나중에 적기 때문이다.
    if (requisition.status !== "OPEN") {
      const linked = await db.prepare("SELECT requisition_id FROM hr_applicants WHERE id = ?").bind(id).first<{ requisition_id: string }>();
      if (linked?.requisition_id !== requisitionId) {
        return Response.json({ error: "모집 중인 채용요청·TO만 지원자에게 연결할 수 있습니다." }, { status: 409 });
      }
    }
  }
  const updatedAt = Date.now();
  const before = await db.prepare("SELECT * FROM hr_applicants WHERE id = ?").bind(id).first<ApplicantRow>();
  const latestOffer = await db.prepare("SELECT status FROM hr_offer_requests WHERE applicant_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(id).first<{ status: string }>();
  // 오퍼가 수락·입사 완료면 그 상태가 단계를 지배한다. 그 밖(제안 준비·거절 등)은 화면이 보낸 단계를 그대로 둔다 —
  // 예전에는 메모 저장만 해도 「타사 합격」이 「채용 제안 거절」로 되돌아갔다.
  const forcedByOffer = ["ACCEPTED", "ONBOARDED"].includes(latestOffer?.status ?? "");
  const stage = (forcedByOffer ? offerStage(latestOffer?.status ?? "") : "") || stringValue("stage") || offerStage(latestOffer?.status ?? "") || "";
  const savedApplicant = await db.prepare(`INSERT INTO hr_applicants
    (id, name, role, applied, owner_id, stage, experience, email, phone, source, summary, career_summary, birth, address, resume_file_name,
      resume_text, checklist_json, screening_memos_json, interview_json, interview_memos_json, requisition_id, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ? = 0 OR NOT EXISTS (
      SELECT 1 FROM hr_applicants WHERE id = ? OR lower(trim(email)) = lower(trim(?))
      OR (length(?) >= 8 AND replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '+', '') = ?)
    )
    ON CONFLICT(id) ${createOnly ? "DO NOTHING" : `DO UPDATE SET name=excluded.name, role=excluded.role, applied=excluded.applied,
      owner_id=excluded.owner_id, stage=excluded.stage, experience=excluded.experience, email=excluded.email,
      phone=excluded.phone, source=excluded.source, summary=excluded.summary, career_summary=excluded.career_summary, birth=excluded.birth, address=excluded.address,
      resume_file_name=excluded.resume_file_name,
      resume_text=excluded.resume_text, checklist_json=excluded.checklist_json,
      screening_memos_json=excluded.screening_memos_json, interview_json=excluded.interview_json,
      interview_memos_json=excluded.interview_memos_json, requisition_id=excluded.requisition_id, updated_at=excluded.updated_at`}`)
    .bind(id, name, stringValue("role"), stringValue("applied"), stringValue("ownerId"), stage,
      stringValue("experience"), email, stringValue("phone"), stringValue("source"), stringValue("summary"),
      stringValue("careerSummary"), stringValue("birth"), stringValue("address"), stringValue("resumeFileName"), stringValue("resumeText"), JSON.stringify(body.checklist ?? []),
      JSON.stringify(body.screeningMemos ?? []), interview, JSON.stringify(body.interviewMemos ?? []), requisitionId, updatedAt,
      createOnly ? 1 : 0, id, email, stringValue("phone").replace(/[^0-9]/g, ""), stringValue("phone").replace(/[^0-9]/g, "")).run();
  if (createOnly && !savedApplicant.meta.changes) return Response.json({ error: "같은 이메일·연락처 또는 등록 ID의 지원자가 이미 있습니다. 지원자 관리에서 기존 기록을 확인해 주세요." }, { status: 409 });
  const after = await db.prepare("SELECT * FROM hr_applicants WHERE id = ?").bind(id).first<ApplicantRow>();
  await writeErpAudit(db, {
    principal: authorization.principal,
    module: "recruitment",
    action: before ? "APPLICANT_UPDATED" : "APPLICANT_CREATED",
    entityType: "applicant",
    entityId: id,
    before: before ? toApplicant(before) : null,
    after: after ? toApplicant(after) : null,
  });
  return Response.json({ ok: true });
}

export async function POST(request: Request) {
  await ensureSchema();
  const body = await request.json() as Record<string, unknown>;
  const resource = String(body.resource ?? "recruiter");
  if (resource === "offer") {
    const authorization = await authorizeErpRequest(db, "recruitment", "write");
    if (authorization.response) return authorization.response;
    const applicantId = String(body.applicantId ?? "").trim();
    const proposedTitle = String(body.proposedTitle ?? "").trim();
    const department = String(body.department ?? "").trim();
    const employmentType = String(body.employmentType ?? "").trim();
    const startDate = String(body.startDate ?? "").trim();
    const annualSalary = Number(body.annualSalary);
    const probationMonths = Number(body.probationMonths ?? 3);
    const firstTermPayPercent = payPercentOf(body.firstTermPayPercent, 100);
    if (firstTermPayPercent === null) return Response.json({ error: "첫 계약 지급률은 1~100 사이의 정수로 입력해 주세요." }, { status: 400 });
    const applicant = await db.prepare("SELECT * FROM hr_applicants WHERE id = ?").bind(applicantId).first<ApplicantRow>();
    if (!applicant || !proposedTitle || !department || !employmentType || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)
      || !Number.isFinite(annualSalary) || annualSalary <= 0 || !Number.isInteger(probationMonths) || probationMonths < 0 || probationMonths > 12) {
      return Response.json({ error: "지원자·직무·소속·고용형태·입사예정일·연봉·수습기간을 확인해 주세요." }, { status: 400 });
    }
    const active = await db.prepare(`SELECT id FROM hr_offer_requests WHERE applicant_id = ?
      AND status IN ('SUBMITTED', 'APPROVED', 'ACCEPTED') ORDER BY created_at DESC LIMIT 1`).bind(applicantId).first<{ id: string }>();
    if (active) return Response.json({ error: "진행 중인 채용 제안 또는 입사 예정 기록이 이미 있습니다." }, { status: 409 });
    if (applicant.requisition_id) {
      const requisition = await db.prepare(`SELECT id, organization_id, requested_headcount, status
        FROM hr_recruitment_requisitions WHERE id = ?`).bind(applicant.requisition_id)
        .first<{ id: string; organization_id: string; requested_headcount: number; status: string }>();
      if (!requisition || requisition.status !== "OPEN") return Response.json({ error: "연결된 채용요청·TO가 모집 중 상태가 아닙니다." }, { status: 409 });
      const filled = await db.prepare(`SELECT COUNT(DISTINCT a.id) AS count FROM hr_applicants a
        JOIN hr_offer_requests o ON o.applicant_id = a.id
        WHERE a.requisition_id = ? AND o.status IN ('ACCEPTED', 'ONBOARDED')`).bind(requisition.id).first<{ count: number }>();
      if ((filled?.count ?? 0) >= requisition.requested_headcount) return Response.json({ error: "연결된 TO의 요청 인원이 이미 모두 충원되었습니다." }, { status: 409 });
      const savedOrganization = await db.prepare("SELECT name FROM hr_organization_records WHERE organization_id = ?")
        .bind(requisition.organization_id).first<{ name: string }>();
      const expectedDepartment = savedOrganization?.name ?? companyOrganizations.find((item) => item.id === requisition.organization_id)?.name ?? "";
      if (expectedDepartment && department !== expectedDepartment) return Response.json({ error: `채용 제안 소속은 연결된 TO의 조직(${expectedDepartment})과 같아야 합니다.` }, { status: 409 });
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.prepare(`INSERT INTO hr_offer_requests
      (id, applicant_id, proposed_title, department, employment_type, start_date, annual_salary,
        probation_months, first_term_pay_percent, notes, status, requested_by, approved_by, approved_at, responded_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, NULL, ?, ?)`)
      .bind(id, applicantId, proposedTitle, department, employmentType, startDate, Math.round(annualSalary), probationMonths, firstTermPayPercent,
        String(body.notes ?? "").trim(), authorization.principal.employeeId, authorization.principal.employeeId, now, now, now).run();
    const row = await db.prepare("SELECT * FROM hr_offer_requests WHERE id = ?").bind(id).first<OfferRow>();
    await writeErpAudit(db, { principal: authorization.principal, module: "recruitment", action: "OFFER_CREATED", entityType: "recruitmentOffer", entityId: id, after: row ? toOffer(row) : body });
    return Response.json({ offer: row ? toOffer(row) : null }, { status: 201 });
  }

  const authorization = await authorizeErpRequest(db, "recruitment", "approve");
  if (authorization.response) return authorization.response;
  const employeeId = String(body.employeeId ?? "").trim();
  if (!employeeIds.has(employeeId)) return Response.json({ error: "회사에 등록된 재직자만 지정할 수 있습니다." }, { status: 400 });
  await db.prepare("INSERT OR IGNORE INTO hr_recruiters (employee_id, created_at) VALUES (?, ?)").bind(employeeId, Date.now()).run();
  await writeErpAudit(db, {
    principal: authorization.principal,
    module: "recruitment",
    action: "RECRUITER_ASSIGNED",
    entityType: "recruiter",
    entityId: employeeId,
    after: { employeeId },
  });
  return Response.json({ employeeId }, { status: 201 });
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "recruitment", "delete");
  if (authorization.response) return authorization.response;
  const body = await request.json() as { employeeId?: string; applicantId?: string };
  const applicantId = body.applicantId?.trim() ?? "";
  if (applicantId) {
    const applicant = await db.prepare("SELECT * FROM hr_applicants WHERE id = ?").bind(applicantId).first<ApplicantRow>();
    if (!applicant) return Response.json({ error: "삭제할 지원자를 찾을 수 없습니다." }, { status: 404 });
    const acceptedOffer = await db.prepare("SELECT employee_id FROM hr_offer_requests WHERE applicant_id = ? AND status IN ('ACCEPTED', 'ONBOARDED') LIMIT 1")
      .bind(applicantId).first<{ employee_id: string }>();
    if (acceptedOffer) return Response.json({ error: `입사 전환된 지원자는 삭제할 수 없습니다. 인사기록카드(${acceptedOffer.employee_id})에서 생애주기를 관리해 주세요.` }, { status: 409 });

    const recordingResult = await db.prepare("SELECT audio_key FROM applicant_interview_recordings WHERE applicant_id = ?")
      .bind(applicantId)
      .all<{ audio_key: string }>();
    const audioKeys = recordingResult.results.map((row) => row.audio_key).filter(Boolean);
    if (audioKeys.length) await bindings.HR_AUDIO.delete(audioKeys);
    await db.batch([
      db.prepare("DELETE FROM applicant_interview_recordings WHERE applicant_id = ?").bind(applicantId),
      db.prepare("DELETE FROM hr_offer_requests WHERE applicant_id = ?").bind(applicantId),
      db.prepare("DELETE FROM hr_applicants WHERE id = ?").bind(applicantId),
    ]);
    await writeErpAudit(db, {
      principal: authorization.principal,
      module: "recruitment",
      action: "APPLICANT_DELETED",
      entityType: "applicant",
      entityId: applicantId,
      before: toApplicant(applicant),
    });
    return Response.json({ applicantId });
  }

  const employeeId = body.employeeId?.trim() ?? "";
  if (!employeeId) return Response.json({ error: "삭제할 대상이 필요합니다." }, { status: 400 });
  await db.prepare("DELETE FROM hr_recruiters WHERE employee_id = ?").bind(employeeId).run();
  await writeErpAudit(db, {
    principal: authorization.principal,
    module: "recruitment",
    action: "RECRUITER_REMOVED",
    entityType: "recruiter",
    entityId: employeeId,
    before: { employeeId },
  });
  return Response.json({ employeeId });
}
