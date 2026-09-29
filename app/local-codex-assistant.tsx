"use client";

import { ChangeEvent, FormEvent, useMemo, useState } from "react";
import readXlsxFile from "read-excel-file/browser";
import { calculateCompensation, type CompensationColumns, type CompensationEmployee, type CompensationRounding } from "./compensation-calculation";
import { compactLeaveContext, compactOperationsContext, hrAssistantTopics, recentAssistantConversation, type AssistantExchange, type HrAssistantTopic } from "./hr-assistant-context";
import { emptyRecruitmentInterview, formatRecruitmentQuestions, recruitmentHelperRequest, validateRecruitmentInterview } from "./assistant-recruitment";
import { HrModalBackdrop } from "./hr-ui";
import type { ResolvedTabs, TabKey } from "./access-tabs";
import { copyText, randomId, readScopedJson } from "./client-runtime";

type AssistantModule = "hr" | "compensation" | "incentive";
type MoneyField = "annualSalary" | "basePay" | "mealAllowance" | "childcareAllowance" | "vehicleAllowance";

type EmployeeRecord = {
  employeeId: string; name: string; birth: string; email: string; phone: string; address: string;
  department: string; manager: string; type: string; joinDate: string; position: string; jobTitle: string;
  status: string; history: unknown[]; retirement: unknown; annualSalary: number; basePay: number;
  mealAllowance: number; childcareAllowance: number; vehicleAllowance: number; updatedAt: number;
};

type AssistantAction = {
  id: string; type: "UPDATE_HR_COMPENSATION_DEFAULTS" | "CREATE_COMPENSATION_DRAFT" | "CREATE_RECRUITMENT_APPLICANT" | "RECORD_INTERVIEW_REJECTION" | "CREATE_RECRUITMENT_OFFER" | "APPLY_RETIREMENT_PAY";
  title: string; summary: string; employeeId: string; period: string; values: Partial<Record<MoneyField, number | null>>;
  retirementPay?: { employeeName: string; amount: number; sourceFileName: string; evidence: string } | null;
  applicant: { name: string | null; role: string | null; experience: string | null; email: string | null; phone: string | null; source: string | null; summary: string | null; ownerId: string | null; requisitionId: string | null; resumeFileName: string | null } | null;
  interviewResult: { applicantId: string | null; outcome: "REJECT" | "NO_SHOW" | null; memo: string | null } | null;
  offer: { applicantId: string | null; proposedTitle: string | null; department: string | null; employmentType: string | null; startDate: string | null; annualSalary: number | null; probationMonths: number | null; notes: string | null } | null;
};

type AssistantResponse = {
  answer: string;
  cautions?: string[];
  nextSteps?: string[];
  interviewQuestions?: InterviewQuestion[];
  proposedActions?: AssistantAction[];
};

/** 면접 질문. 예전에는 nextSteps 한 줄에 1,000자가 넘게 뭉쳐 들어가 읽을 수 없었다.
 *  분류·질문·확인 포인트로 나눠 받아 화면에서 묶어 보여 준다. */
type InterviewQuestion = { category: string; question: string; checkpoint: string };

const interviewCategoryLabels: Record<string, string> = {
  RESUME_CHECK: "이력서 근거 확인",
  ROLE_SKILL: "지원 직무 역량",
  COUNTER_ROLE_SKILL: "역제안 직무 역량",
  COUNTER_FIT: "역제안 타당성",
  BUSINESS_SCENARIO: "XD NODE 사업 시나리오",
  COLLABORATION: "협업·문제해결",
};
const interviewCategoryOrder = ["RESUME_CHECK", "ROLE_SKILL", "COUNTER_ROLE_SKILL", "COUNTER_FIT", "BUSINESS_SCENARIO", "COLLABORATION"];

type FileAnalysis = { fileName: string; rowCount: number; columns: string[]; preview: Array<Record<string, string>>; extractedText?: string };
type RecruitmentApplicant = { id: string; name: string; role: string; applied: string; ownerId: string; owner: string; stage: string; experience: string; email: string; phone: string; source: string; summary: string; resumeFileName: string; resumeText: string; checklist: unknown[]; screeningMemos: unknown[]; interview?: unknown; interviewMemos: unknown[]; requisitionId: string; offer?: { id: string; status: string; proposedTitle?: string; department?: string; employmentType?: string; startDate?: string; annualSalary?: number; probationMonths?: number; notes?: string } };
type CompensationRun = { period: string; status: string; version: number; employeeCount: number; grossPay: number; updatedAt?: number; employees: CompensationEmployee[]; settings?: { rounding?: CompensationRounding; columns?: Partial<CompensationColumns> } };
type IncentiveDeal = { id: string; person: string; personId: string; date: string; salesInvoiceDate: string; client: string; item: string; quantity: number; unitCost: number; unitSale: number; expense: number; kind: string; excluded: boolean };

// 어시스턴트 질문은 ERP 서버의 /api/assistant 로 보낸다. 서버가 데스크탑 안의 Claude CLI 다리
// (scripts/claude-assistant-bridge.mjs)를 대신 부른다. 예전처럼 브라우저가 로컬 다리를 직접 부르면
// 태블릿 등 다른 기기에서는 그 기기 자신을 가리켜 항상 실패했다.
const assistantEndpoint = "/api/assistant";
const moneyFields: MoneyField[] = ["annualSalary", "basePay", "mealAllowance", "childcareAllowance", "vehicleAllowance"];
const moneyLabels: Record<MoneyField, string> = { annualSalary: "연봉", basePay: "기본급", mealAllowance: "식대", childcareAllowance: "육아수당", vehicleAllowance: "자가운전수당" };

const workspaceLabel: Record<AssistantModule, string> = { hr: "HR", compensation: "임금 계산", incentive: "인센티브" };
const suggestedQuestions: Record<AssistantModule, string[]> = {
  hr: ["면접 예정자를 확인해줘.", "첨부한 이력서와 지원 포지션을 바탕으로 맞춤 면접 질문 리스트를 만들어줘.", "첨부한 이력서를 분석해 지원자 등록 변경안을 만들어줘.", "면접 결과를 탈락으로 기록할 변경안을 만들어줘.", "면접 합격자의 처우 오퍼 변경안을 만들어줘."],
  compensation: ["급여 확정 전에 누락 수당과 퇴직자 반영 여부를 점검해줘.", "전월 대비 지급액이 크게 바뀐 인원을 확인해줘.", "HR 기본값으로 이번 달 임금 초안을 만들어줘."],
  incentive: ["현재 인센티브 거래에서 확인이 필요한 항목을 보여줘.", "담당자별 매출·마진·인센티브 차이를 분석해줘.", "인센티브 미반영 및 마진율 기준 미달 거래를 정리해줘."],
};

const companyInterviewContext = {
  company: "XD NODE",
  business: [
    "AI 사업을 중심으로 한 B2B 영업과 고객 관리",
    "AI·GPU 서버와 고성능 IT 인프라의 제안·조달·납품·기술지원",
    "온라인 채널 및 마케팅 운영",
  ],
  operatingModel: "구매·AI사업 영업·온라인 마케팅·기술지원·경영/영업지원 조직이 견적, 원가·마진, 납기, 고객지원 흐름을 함께 운영합니다.",
  roleFocus: {
    영업: ["고객 요구사항 파악", "솔루션 제안", "마진·수익성", "계약·납기·수금 관리"],
    구매: ["벤더·조달", "원가·납기", "호환성 확인", "재고·리스크 관리"],
    마케팅: ["온라인 채널", "캠페인 성과", "콘텐츠", "리드 전환"],
    기술지원: ["AI·GPU 인프라 이해", "구성·호환성", "구축·장애 대응", "고객 커뮤니케이션"],
    영업지원: ["견적·주문 문서", "납기·수금 지원", "데이터 정확성", "부서 협업"],
    경영지원: ["인사·총무 운영", "정확한 기록", "내부통제", "기밀 정보 취급"],
  },
  interviewGuardrails: "출신, 나이, 가족, 혼인·임신, 종교, 건강, 장애, 정치성향 등 직무와 무관한 민감한 개인정보를 질문하거나 평가 근거로 삼지 않습니다.",
};

function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function parseCsvLine(line: string) {
  const cells: string[] = []; let value = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { cells.push(value.trim()); value = ""; }
    else value += character;
  }
  cells.push(value.trim());
  return cells;
}

function rowsToAnalysis(fileName: string, rows: unknown[][]): FileAnalysis {
  const headers = (rows[0] ?? []).map((value, index) => String(value ?? "").trim() || `열 ${index + 1}`);
  const data = rows.slice(1).filter((row) => row.some((value) => String(value ?? "").trim())).map((row) => Object.fromEntries(headers.map((header, index) => [header, String(row[index] ?? "").trim()])));
  return { fileName, rowCount: data.length, columns: headers, preview: data.slice(0, 30) };
}

function textToAnalysis(fileName: string, text: string): FileAnalysis {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("파일에서 읽을 수 있는 텍스트를 찾지 못했습니다. 이미지형 PDF라면 텍스트가 포함된 원본을 사용해 주세요.");
  return { fileName, rowCount: lines.length, columns: ["추출 텍스트"], preview: lines.slice(0, 30).map((line) => ({ "추출 텍스트": line })), extractedText: text.slice(0, 24_000) };
}

async function analyzeFile(file: File): Promise<FileAnalysis> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) return rowsToAnalysis(file.name, (await readXlsxFile(file))[0]?.data ?? []);
  if (name.endsWith(".pdf")) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
    const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    }
    return textToAnalysis(file.name, pages.join("\n"));
  }
  if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return textToAnalysis(file.name, result.value);
  }
  const raw = await file.text();
  if (name.endsWith(".txt")) return textToAnalysis(file.name, raw);
  if (name.endsWith(".json")) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("JSON 파일은 행 배열 형식이어야 합니다.");
    const columns = Array.from(new Set(parsed.flatMap((row) => row && typeof row === "object" ? Object.keys(row as Record<string, unknown>) : [])));
    const rows = parsed.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>;
    return { fileName: file.name, rowCount: rows.length, columns, preview: rows.slice(0, 30).map((row) => Object.fromEntries(columns.map((column) => [column, String(row[column] ?? "")]))), };
  }
  const rows = raw.split(/\r?\n/).filter((line) => line.trim()).map(parseCsvLine);
  if (rows.length < 2) throw new Error("CSV 또는 텍스트 파일에서 제목 행과 데이터 행을 찾지 못했습니다.");
  return rowsToAnalysis(file.name, rows);
}

function toNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function safeAction(value: unknown): value is AssistantAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Partial<AssistantAction>;
  return typeof action.id === "string" && ["UPDATE_HR_COMPENSATION_DEFAULTS", "CREATE_COMPENSATION_DRAFT", "CREATE_RECRUITMENT_APPLICANT", "RECORD_INTERVIEW_REJECTION", "CREATE_RECRUITMENT_OFFER", "APPLY_RETIREMENT_PAY"].includes(String(action.type)) && typeof action.title === "string" && typeof action.summary === "string" && typeof action.employeeId === "string" && typeof action.period === "string" && !!action.values && typeof action.values === "object";
}

function compactEmployee(record: EmployeeRecord) {
  return {
    employeeId: record.employeeId, name: record.name, department: record.department, position: record.position,
    employmentType: record.type, manager: record.manager, email: record.email, phone: record.phone,
    jobTitle: record.jobTitle, status: record.status, joinDate: record.joinDate,
    retirement: record.retirement, annualSalary: record.annualSalary, basePay: record.basePay,
    mealAllowance: record.mealAllowance, childcareAllowance: record.childcareAllowance, vehicleAllowance: record.vehicleAllowance,
  };
}

function previousPeriod(period: string) {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function compactCompensationRun(run: CompensationRun | null, period: string) {
  if (!run) return { period, status: "NOT_CREATED" };
  const [year, month] = period.split("-").map(Number);
  const columns: CompensationColumns = {
    research: run.settings?.columns?.research ?? true, extra: run.settings?.columns?.extra ?? true,
    welfare: run.settings?.columns?.welfare ?? false, severance: run.settings?.columns?.severance ?? true,
    deduction: run.settings?.columns?.deduction ?? false, annualLeave: run.settings?.columns?.annualLeave ?? false,
    personalExpense: run.settings?.columns?.personalExpense ?? false,
  };
  return {
    period, status: run.status, version: run.version, employeeCount: run.employeeCount, grossPay: run.grossPay, updatedAt: run.updatedAt,
    rows: run.employees.slice(0, 200).map((employee) => {
      const row = calculateCompensation(employee, year, month, run.settings?.rounding ?? "round", columns);
      return {
        employeeId: employee.id, name: employee.name, department: employee.department, joinDate: employee.joinDate, leaveDate: employee.leaveDate,
        days: row.days, annualSalary: employee.annualSalary, basic: row.basic, meal: row.meal, car: row.car, child: row.child,
        incentive: row.incentive, bonus: row.bonus, extra: row.extra, research: row.research, severance: row.severance,
        annualLeave: row.annualLeave, personalExpense: row.personalExpense, deduction: row.deduction, total: row.total,
        warnings: [row.days === 0 ? "해당 월 지급 대상 아님" : "", row.probationWithoutJoin ? "수습 기간은 있으나 입사일 미입력" : "", row.mixedProbation ? "수습 종료월 일할 계산" : ""].filter(Boolean),
      };
    }),
  };
}

// 인센티브 계산기 자료는 계정 범위 키(scopedKey)에 있다(Design §5.5).
function localJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  return readScopedJson<T>(key, fallback);
}

type RosterEmployee = { employeeId: string; name: string; department: string; status: string };

/** 변경안의 적용 버튼은 대상 탭이 편집일 때만 보인다(Design §5.3, §7.10). 적용은 대상 API가 edit 를 다시 검사한다. */
const ACTION_TARGET_TAB: Record<AssistantAction["type"], TabKey> = {
  UPDATE_HR_COMPENSATION_DEFAULTS: "hr",
  CREATE_COMPENSATION_DRAFT: "compensation",
  CREATE_RECRUITMENT_APPLICANT: "hr",
  RECORD_INTERVIEW_REJECTION: "hr",
  CREATE_RECRUITMENT_OFFER: "hr",
  APPLY_RETIREMENT_PAY: "compensation",
};

function incentiveCalculatorContext() {
  const deals = localJson<IncentiveDeal[]>("xdnode-incentive-deals-v1", []);
  const config = localJson<{ hurdleRate?: number; payoutRate?: number; cableMode?: string; rounding?: string }>("xdnode-incentive-config-v1", {});
  const excludedPeople = new Set(localJson<string[]>("xdnode-incentive-excluded-people-v1", []));
  const hurdleRate = Number(config.hurdleRate ?? 5);
  const payoutRate = Number(config.payoutRate ?? 5);
  const rows = deals.slice(0, 250).map((deal) => {
    const sales = Number(deal.quantity ?? 0) * Number(deal.unitSale ?? 0);
    const margin = sales - Number(deal.quantity ?? 0) * Number(deal.unitCost ?? 0) - Number(deal.expense ?? 0);
    const threshold = sales * hurdleRate / 100;
    const excludedByPerson = excludedPeople.has(deal.personId || `unresolved:${deal.person}`);
    return { id: deal.id, person: deal.person, personId: deal.personId, client: deal.client, item: deal.item, kind: deal.kind, date: deal.date,
      sales, margin, marginRate: sales ? Number((margin / sales * 100).toFixed(2)) : 0, threshold,
      incentive: deal.excluded || excludedByPerson || sales <= 0 ? 0 : Math.max((margin - threshold) * payoutRate / 100, 0),
      excluded: deal.excluded || excludedByPerson, needsReview: !deal.personId || (sales > 0 && margin / sales < hurdleRate) };
  });
  const summary = new Map<string, { person: string; sales: number; margin: number; incentive: number; count: number; needsReview: number }>();
  for (const row of rows) {
    const key = row.personId || `unresolved:${row.person}`;
    const current = summary.get(key) ?? { person: row.person, sales: 0, margin: 0, incentive: 0, count: 0, needsReview: 0 };
    current.sales += row.sales; current.margin += row.margin; current.incentive += row.incentive; current.count += 1; current.needsReview += Number(row.needsReview);
    summary.set(key, current);
  }
  return {
    source: "현재 브라우저에 저장된 인센티브 계산 거래", config: { hurdleRate, payoutRate, cableMode: config.cableMode ?? "deduct", rounding: config.rounding ?? "none" },
    dealCount: deals.length, truncated: deals.length > rows.length, excludedPersonCount: excludedPeople.size,
    summary: [...summary.values()].sort((a, b) => b.incentive - a.incentive),
    reviewRows: rows.filter((row) => row.needsReview || row.kind === "케이블" || row.excluded).slice(0, 100),
  };
}

export default function LocalCodexAssistant({ module, tabs }: { module: AssistantModule; tabs?: ResolvedTabs }) {
  const canApply = (action: AssistantAction) => tabs?.[ACTION_TARGET_TAB[action.type]] === "edit";
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [response, setResponse] = useState<AssistantResponse | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [applying, setApplying] = useState("");
  const [includeOptionalData, setIncludeOptionalData] = useState(false);
  const includeServerData = module === "hr" || includeOptionalData;
  const [fileAnalysis, setFileAnalysis] = useState<FileAnalysis | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [responseAttachment, setResponseAttachment] = useState<FileAnalysis | null>(null);
  const [fileStatus, setFileStatus] = useState("");
  const [resumeInput, setResumeInput] = useState("");
  const [interviewDraft, setInterviewDraft] = useState({ ...emptyRecruitmentInterview });
  const [recruitmentReview, setRecruitmentReview] = useState(false);
  const [reviewPosition, setReviewPosition] = useState("");
  const [targetPosition, setTargetPosition] = useState("");
  const [period, setPeriod] = useState(currentPeriod);
  const [employees, setEmployees] = useState<EmployeeRecord[]>([]);
  const [recruitmentApplicants, setRecruitmentApplicants] = useState<RecruitmentApplicant[]>([]);
  const [recruiterIds, setRecruiterIds] = useState<string[]>([]);
  const [appliedActionIds, setAppliedActionIds] = useState<string[]>([]);
  const [hrTopic, setHrTopic] = useState<HrAssistantTopic>("people");
  const [conversation, setConversation] = useState<AssistantExchange[]>([]);
  const [responseSources, setResponseSources] = useState<string[]>([]);
  const [answeredQuestion, setAnsweredQuestion] = useState("");
  const [responseIncludedData, setResponseIncludedData] = useState(false);
  const title = `${workspaceLabel[module]} AI 어시스턴트`;
  const suggestions = useMemo(() => module === "hr" ? hrAssistantTopics[hrTopic].questions : suggestedQuestions[module], [module, hrTopic]);

  function close() { if (!applying) setOpen(false); }

  async function loadContext() {
    // 모드별 맥락 경로(Design §2.2 (4), §4.2.7). HR 모드만 인사기록(/api/hr/employee-records)을 읽는다.
    // 임금 계산·인센티브 모드는 4필드 명부(/api/compensation/roster)와 임금 API(include=hr, 생년월일 없음)만 읽는다.
    if (module !== "hr") {
      const prior = previousPeriod(period);
      const [rosterResponse, payrollResponse, priorPayrollResponse] = await Promise.all([
        fetch("/api/compensation/roster", { cache: "no-store" }),
        fetch(`/api/compensation?period=${encodeURIComponent(period)}&include=hr`, { cache: "no-store" }),
        module === "compensation" ? fetch(`/api/compensation?period=${encodeURIComponent(prior)}`, { cache: "no-store" }) : Promise.resolve(null),
      ]);
      const rosterPayload = await rosterResponse.json().catch(() => ({})) as { employees?: RosterEmployee[]; error?: string };
      if (!rosterResponse.ok) throw new Error(rosterPayload.error || "직원 명부를 불러오지 못했습니다.");
      const roster = Array.isArray(rosterPayload.employees) ? rosterPayload.employees : [];
      const payrollPayload = await payrollResponse.json().catch(() => ({})) as { run?: CompensationRun; hrEmployees?: unknown[]; error?: string };
      if (!payrollResponse.ok && payrollResponse.status !== 404) throw new Error(payrollPayload.error || "임금 계산 초안을 불러오지 못했습니다.");
      const base = {
        roster: roster.slice(0, 200), employeeCount: roster.length,
        hrPayrollSnapshots: Array.isArray(payrollPayload.hrEmployees) ? payrollPayload.hrEmployees.slice(0, 200) : [],
      };
      if (module === "incentive") return { ...base, incentiveCalculator: incentiveCalculatorContext() };
      const priorPayrollPayload = (priorPayrollResponse ? await priorPayrollResponse.json().catch(() => ({})) : {}) as { run?: CompensationRun; error?: string };
      if (priorPayrollResponse && !priorPayrollResponse.ok && priorPayrollResponse.status !== 404) throw new Error(priorPayrollPayload.error || "전월 임금안을 불러오지 못했습니다.");
      return {
        ...base,
        payrollRun: compactCompensationRun(payrollPayload.run ?? null, period),
        priorPayrollRun: compactCompensationRun(priorPayrollPayload.run ?? null, prior),
      };
    }
    const employeeResponse = await fetch("/api/hr/employee-records", { cache: "no-store" });
    const employeePayload = await employeeResponse.json().catch(() => ({})) as { records?: EmployeeRecord[]; error?: string };
    if (!employeeResponse.ok) throw new Error(employeePayload.error || "HR 인사기록을 불러오지 못했습니다.");
    const records = Array.isArray(employeePayload.records) ? employeePayload.records : [];
    setEmployees(records);
    const base = { employeeRecords: records.slice(0, 200).map(compactEmployee), employeeCount: records.length };
    const [operationsResponse, recruitmentResponse, leaveResponse] = await Promise.all([
      fetch("/api/hr/operations", { cache: "no-store" }),
      fetch("/api/hr/recruitment", { cache: "no-store" }),
      fetch("/api/hr/leave", { cache: "no-store" }),
    ]);
    const operationsPayload = await operationsResponse.json().catch(() => ({})) as Record<string, unknown>;
    const recruitmentPayload = await recruitmentResponse.json().catch(() => ({})) as { applicants?: RecruitmentApplicant[]; recruiterIds?: string[]; requisitions?: Array<{ id: string; title: string; role: string; organizationId: string; requestedHeadcount: number; status: string }>; error?: string };
    if (!recruitmentResponse.ok) throw new Error(recruitmentPayload.error || "채용 지원자 데이터를 불러오지 못했습니다.");
    const applicants = Array.isArray(recruitmentPayload.applicants) ? recruitmentPayload.applicants : [];
    const leavePayload = await leaveResponse.json().catch(() => ({}));
    const leave = leaveResponse.ok ? compactLeaveContext(leavePayload) : { unavailable: true, reason: "연차 원장을 조회하지 못했습니다. 연차 수치를 추정하지 마세요." };
    const sources = [
      `인사기록 ${records.length}명`,
      operationsResponse.ok ? "입·퇴사 운영 기록" : "입·퇴사 기록 조회 실패",
      `채용 지원자 ${applicants.length}명`,
      leaveResponse.ok ? `연차 원장 · ${leavePayload.today ?? "기준일 미확인"}` : "연차 원장 조회 실패",
    ];
    const currentRecruiterIds = Array.isArray(recruitmentPayload.recruiterIds) ? recruitmentPayload.recruiterIds : [];
    setRecruitmentApplicants(applicants);
    setRecruiterIds(currentRecruiterIds);
    const asOf = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return {
      ...base,
      sources,
      leave,
      asOf,
      operations: operationsResponse.ok ? compactOperationsContext(operationsPayload, asOf) : { unavailable: true },
      recruitment: {
        applicantCount: applicants.length,
        recruiters: currentRecruiterIds.map((id) => ({ id, name: records.find((employee) => employee.employeeId === id)?.name ?? "미지정" })),
        requisitions: (recruitmentPayload.requisitions ?? []).filter((item) => item.status === "OPEN"),
        applicants: applicants.slice(0, 200).map((applicant) => ({
          id: applicant.id, name: applicant.name, role: applicant.role, stage: applicant.stage,
          experience: applicant.experience, email: applicant.email, phone: applicant.phone, source: applicant.source,
          summary: applicant.summary, ownerId: applicant.ownerId, owner: applicant.owner, requisitionId: applicant.requisitionId,
          interview: applicant.interview, interviewMemos: applicant.interviewMemos.slice(0, 5), offer: applicant.offer,
        })),
      },
    };
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setResumeInput("");
    setFileBusy(true);
    setFileStatus("파일을 이 브라우저에서 분석 중…");
    try {
      const analysis = await analyzeFile(file);
      setFileAnalysis(analysis);
      setFileStatus(`${analysis.fileName} · ${analysis.rowCount.toLocaleString("ko-KR")}행 · ${analysis.columns.length}개 열을 읽었습니다.`);
    } catch (caught) {
      setFileAnalysis(null);
      setFileStatus(caught instanceof Error ? caught.message : "파일을 읽지 못했습니다.");
    } finally { setFileBusy(false); }
  }

  async function submit(event?: FormEvent<HTMLFormElement>, recruitmentHelper = false) {
    event?.preventDefault();
    const request = recruitmentHelper ? recruitmentHelperRequest : question.trim();
    if (!request || submitting || fileBusy || applying) return;
    let attachment = fileAnalysis;
    if (module === "hr" && hrTopic === "recruitment" && resumeInput.trim()) {
      attachment = textToAnalysis("직접 입력한 이력서.txt", resumeInput);
      setFileAnalysis(attachment);
    }
    if (recruitmentHelper && (!targetPosition.trim() || !attachment?.extractedText?.trim())) {
      setError("지원 포지션과 이력서 파일 또는 이력서 내용을 입력해 주세요."); return;
    }
    const priorConversation = module === "hr" && response && answeredQuestion
      ? [...conversation, { question: answeredQuestion, answer: response.answer, includedServerData: responseIncludedData }].slice(-8)
      : conversation;
    setSubmitting(true); setError(""); setNotice("");
    try {
      const liveData = includeServerData ? await loadContext() : { dataAccess: "not-requested" };
      const context = {
        module: workspaceLabel[module], period: module === "compensation" || module === "hr" ? period : undefined,
        dataAccess: includeServerData ? "user-authorized-current-erp-data" : "not-requested",
        conversation: module === "hr" ? recentAssistantConversation(priorConversation, includeServerData) : undefined,
        fileAnalysis: includeServerData ? attachment ?? undefined : undefined,
        interviewBrief: module === "hr" ? {
          targetPosition: targetPosition.trim() || null,
          recruitmentHelper,
          companyBusinessProfile: companyInterviewContext,
        } : undefined,
        ...liveData,
      };
      // 업무 영역은 쿼리로 보낸다. 서버는 본문을 읽기 전에 이 값으로 인가한다(D23). 본문의 module 은 다리에 넘기지 않는다.
      const result = await fetch(`${assistantEndpoint}?module=${encodeURIComponent(module)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module, question: request, context }),
      });
      const payload = await result.json().catch(() => ({})) as AssistantResponse & { error?: string };
      if (!result.ok) throw new Error(payload.error || "AI 어시스턴트에 연결하지 못했습니다.");
      if (!payload.answer) throw new Error("AI 응답 형식이 올바르지 않습니다. 다시 시도해 주세요.");
      if (recruitmentHelper) {
        const creates = (payload.proposedActions ?? []).filter(action => safeAction(action) && action.type === "CREATE_RECRUITMENT_APPLICANT");
        if (creates.length > 1) throw new Error("지원자 등록안이 여러 개 반환되었습니다. 한 명의 이력서로 다시 요청해 주세요.");
        payload.proposedActions = creates.map(action => ({ ...action, applicant: action.applicant ? { ...action.applicant, role: targetPosition.trim() } : null }));
      }
      payload.proposedActions = (payload.proposedActions ?? []).map(action => action.type === "CREATE_RECRUITMENT_APPLICANT" ? { ...action, id: `AP-${randomId()}` } : action);
      if (module === "hr") setConversation(priorConversation);
      setAnsweredQuestion(request);
      setResponseIncludedData(includeServerData);
      setResponseAttachment(includeServerData ? attachment : null);
      setRecruitmentReview(recruitmentHelper);
      setReviewPosition(targetPosition.trim());
      if (recruitmentHelper) {
        setInterviewDraft(current => ({ ...current, questions: formatRecruitmentQuestions(payload.interviewQuestions ?? []) }));
      }
      setAppliedActionIds([]);
      if (module === "hr" && "sources" in liveData) setResponseSources(liveData.sources);
      if (!includeServerData) setResponseSources(["질문과 일반 업무 안내 · ERP 데이터 미포함"]);
      setResponse({ ...payload, proposedActions: (payload.proposedActions ?? []).filter(safeAction) });
      setQuestion("");
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "알 수 없는 연결 오류입니다.";
      setError(detail);
    } finally { setSubmitting(false); }
  }

  /** 면접관에게 그대로 넘길 수 있게 분류·질문·확인 포인트를 한 벌로 복사한다. */
  async function copyQuestions(items: InterviewQuestion[]) {
    const text = interviewCategoryOrder
      .map((key) => [key, items.filter((item) => item.category === key)] as const)
      .filter(([, group]) => group.length > 0)
      .map(([key, group]) => [`[${interviewCategoryLabels[key] ?? key}]`,
        ...group.map((item, index) => `${index + 1}. ${item.question}\n   → 확인 포인트: ${item.checkpoint}`)].join("\n"))
      .join("\n\n");
    try {
      await copyText(text);
      setNotice("면접 질문을 복사했습니다.");
    } catch {
      setError("복사하지 못했습니다. 질문을 직접 선택해 복사해 주세요.");
    }
  }

  async function applyAction(action: AssistantAction) {
    if (submitting || applying || appliedActionIds.includes(action.id)) return;
    if (action.type === "APPLY_RETIREMENT_PAY") {
      setApplying(action.id); setError(""); setNotice("");
      try {
        const detail = action.retirementPay;
        if (module !== "hr" || !detail || !Number.isSafeInteger(detail.amount) || detail.amount < 0 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(action.period)) throw new Error("직원·반영 월·퇴직금 금액을 다시 확인해 주세요.");
        if (!fileAnalysis || fileAnalysis !== responseAttachment || fileAnalysis.fileName !== detail.sourceFileName || !detail.evidence?.trim()) throw new Error("분석한 영수증과 추출 근거를 확인해 주세요. 파일을 바꿨다면 다시 분석해 주세요.");
        if (!employees.some((employee) => employee.employeeId === action.employeeId && employee.name.trim() === detail.employeeName.trim())) throw new Error("인사기록과 영수증의 직원명이 일치하지 않습니다.");
        const before = await fetch(`/api/compensation?period=${encodeURIComponent(action.period)}`, { cache: "no-store" });
        const current = await before.json() as { run?: CompensationRun; error?: string };
        if (!before.ok || !current.run) throw new Error(current.error || `${action.period} 임금안이 없습니다. 임금계산에서 해당 월 급여 작성을 먼저 해 주세요.`);
        const update = await fetch("/api/compensation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          action: "APPLY_RETIREMENT_PAY", period: action.period, version: current.run.version, employeeId: action.employeeId,
          employeeName: detail.employeeName, amount: detail.amount, sourceFileName: detail.sourceFileName,
        }) });
        const saved = await update.json() as { error?: string };
        if (!update.ok) throw new Error(saved.error || "퇴직금을 반영하지 못했습니다.");
        setAppliedActionIds((ids) => [...ids, action.id]);
        setNotice(`${detail.employeeName}님의 ${action.period} 퇴직금을 ${detail.amount.toLocaleString("ko-KR")}원으로 반영했습니다. 임금계산에서 확인할 수 있습니다.`);
      } catch (caught) { setError(caught instanceof Error ? caught.message : "퇴직금 반영에 실패했습니다."); }
      finally { setApplying(""); }
      return;
    }
    const confirmation = action.type === "UPDATE_HR_COMPENSATION_DEFAULTS"
      ? `${action.title}\n\n이 변경안의 금액을 인사기록카드에 반영할까요? 기존 값이 덮어써집니다.`
      : action.type === "CREATE_COMPENSATION_DRAFT"
        ? `${action.title}\n\n${action.period} 임금 초안을 HR 기본값으로 다시 작성할까요? 기존 미확정 초안이 덮어써질 수 있습니다.`
        : action.type === "CREATE_RECRUITMENT_APPLICANT"
          ? `${action.title}\n\n이력서에서 추출한 정보와 이력서 텍스트를 새 지원자로 등록할까요?`
          : action.type === "RECORD_INTERVIEW_REJECTION"
            ? `${action.title}\n\n면접 결과를 탈락으로 기록할까요? 이 변경은 지원자 단계와 면접 메모에 반영됩니다.`
            : `${action.title}\n\n처우 오퍼를 생성할까요? 지원자 수락·사번 발급·입사 전환은 이 작업에 포함되지 않습니다.`;
    if (action.type !== "CREATE_RECRUITMENT_APPLICANT" && !window.confirm(confirmation)) return;
    setApplying(action.id); setError(""); setNotice("");
    try {
      if (action.type === "UPDATE_HR_COMPENSATION_DEFAULTS") {
        let target = employees.find((employee) => employee.employeeId === action.employeeId);
        if (!target && module !== "hr") {
          // 임금 계산 모드는 맥락에 인사기록을 싣지 않는다. 적용 버튼은 HR 편집 권한자에게만 보이므로 그때 읽는다.
          const recordsResponse = await fetch("/api/hr/employee-records", { cache: "no-store" });
          const recordsPayload = await recordsResponse.json().catch(() => ({})) as { records?: EmployeeRecord[]; error?: string };
          if (!recordsResponse.ok) throw new Error(recordsPayload.error || "HR 인사기록을 불러오지 못했습니다.");
          const records = Array.isArray(recordsPayload.records) ? recordsPayload.records : [];
          setEmployees(records);
          target = records.find((employee) => employee.employeeId === action.employeeId);
        }
        if (!target) throw new Error("적용할 직원을 현재 인사기록카드에서 찾지 못했습니다. 최신 자료로 다시 요청해 주세요.");
        const values = Object.fromEntries(moneyFields.flatMap((field) => {
          const amount = action.values[field];
          return amount === undefined || amount === null ? [] : [[field, toNumber(amount)]];
        }));
        if (!Object.values(values).length || Object.values(values).some((value) => value === null)) throw new Error("변경안에 유효하지 않은 금액이 있어 적용하지 않았습니다.");
        const update = await fetch("/api/hr/employee-records", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...target, ...values }) });
        const payload = await update.json().catch(() => ({})) as { record?: EmployeeRecord; error?: string };
        if (!update.ok) throw new Error(payload.error || "인사기록카드를 저장하지 못했습니다.");
        if (payload.record) setEmployees((current) => current.map((employee) => employee.employeeId === payload.record?.employeeId ? payload.record : employee));
      } else if (action.type === "CREATE_COMPENSATION_DRAFT") {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(action.period)) throw new Error("임금 초안 월 형식이 올바르지 않습니다.");
        const before = await fetch(`/api/compensation?period=${encodeURIComponent(action.period)}`, { cache: "no-store" });
        const beforePayload = await before.json().catch(() => ({})) as { run?: { version?: number }; error?: string };
        if (!before.ok && before.status !== 404) throw new Error(beforePayload.error || "기존 임금안을 확인하지 못했습니다.");
        const update = await fetch("/api/compensation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "LOAD_HR", period: action.period, version: beforePayload.run?.version }) });
        const payload = await update.json().catch(() => ({})) as { error?: string };
        if (!update.ok) throw new Error(payload.error || "임금 초안을 작성하지 못했습니다.");
      } else if (action.type === "CREATE_RECRUITMENT_APPLICANT") {
        const applicant = action.applicant;
        if (!applicant?.name?.trim() || !applicant.role?.trim() || !applicant.email?.trim()) throw new Error("지원자 등록에는 이름·지원 직무·이메일이 필요합니다.");
        if (!fileAnalysis?.extractedText?.trim()) throw new Error("이력서의 추출 텍스트가 없습니다. PDF, DOCX 또는 TXT 이력서를 다시 첨부해 주세요.");
        if (module !== "hr" || fileAnalysis !== responseAttachment || (resumeInput.trim() && resumeInput.slice(0, 24000) !== responseAttachment?.extractedText)) throw new Error("이력서가 변경되었습니다. 다시 분석한 뒤 등록해 주세요.");
        if (recruitmentReview && targetPosition.trim() !== reviewPosition) throw new Error("지원 포지션이 변경되었습니다. 면접 질문을 다시 생성해 주세요.");
        const interview = recruitmentReview ? validateRecruitmentInterview(interviewDraft, true) : undefined;
        const normalizedEmail = applicant.email.trim().toLocaleLowerCase();
        const normalizedPhone = applicant.phone?.replace(/[^0-9]/g, "") ?? "";
        const duplicate = recruitmentApplicants.find((item) => item.email.toLocaleLowerCase() === normalizedEmail
          || (normalizedPhone.length >= 8 && item.phone.replace(/[^0-9]/g, "") === normalizedPhone));
        if (duplicate) throw new Error(`${duplicate.name} 지원자가 같은 이메일 또는 연락처로 이미 등록되어 있습니다.`);
        const ownerId = applicant.ownerId?.trim() || recruiterIds[0] || "";
        const owner = employees.find((employee) => employee.employeeId === ownerId)?.name ?? "미지정";
        const newApplicant: RecruitmentApplicant = {
          id: action.id.startsWith("AP-") ? action.id : `AP-${action.id}`, name: applicant.name.trim(), role: applicant.role.trim(),
          applied: new Date().toISOString().slice(0, 10).replaceAll("-", "."), ownerId, owner, stage: interview?.date ? "면접" : "서류 검토", interview,
          experience: applicant.experience?.trim() ?? "", email: applicant.email.trim(), phone: applicant.phone?.trim() ?? "",
          source: applicant.source?.trim() || "이력서 내용 추출", summary: applicant.summary?.trim() ?? "",
          resumeFileName: fileAnalysis.fileName, resumeText: fileAnalysis.extractedText.slice(0, 30_000),
          checklist: [], screeningMemos: [], interviewMemos: [], requisitionId: applicant.requisitionId?.trim() ?? "",
        };
        const update = await fetch("/api/hr/recruitment", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...newApplicant, createOnly: true, recruitmentHelper: recruitmentReview }) });
        const payload = await update.json().catch(() => ({})) as { error?: string };
        if (!update.ok) throw new Error(payload.error || "지원자를 등록하지 못했습니다.");
        setRecruitmentApplicants((current) => [newApplicant, ...current]);
        window.dispatchEvent(new Event("hr-recruitment-updated"));
      } else if (action.type === "RECORD_INTERVIEW_REJECTION") {
        const result = action.interviewResult;
        if (!result?.applicantId || !result.outcome) throw new Error("면접 결과 대상과 결과값을 확인하지 못했습니다.");
        const target = recruitmentApplicants.find((item) => item.id === result.applicantId);
        if (!target) throw new Error("현재 지원자 목록에서 면접 결과를 반영할 대상을 찾지 못했습니다. 최신 자료로 다시 요청해 주세요.");
        const note = `${result.outcome === "NO_SHOW" ? "면접 불참(탈락)" : "면접 결과(탈락)"}${result.memo?.trim() ? `: ${result.memo.trim()}` : ""}`;
        const updated: RecruitmentApplicant = { ...target, stage: result.outcome === "NO_SHOW" ? "면접 불참 탈락" : "면접 후 탈락", interviewMemos: [{ id: `IN-${randomId()}`, text: note, author: target.owner || "담당자 미지정", createdAt: new Date().toISOString() }, ...(target.interviewMemos ?? [])] };
        const update = await fetch("/api/hr/recruitment", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updated) });
        const payload = await update.json().catch(() => ({})) as { error?: string };
        if (!update.ok) throw new Error(payload.error || "면접 탈락 결과를 저장하지 못했습니다.");
        setRecruitmentApplicants((current) => current.map((item) => item.id === updated.id ? updated : item));
      } else {
        const offer = action.offer;
        if (!offer?.applicantId || !offer.proposedTitle?.trim() || !offer.department?.trim() || !offer.employmentType?.trim()
          || !/^\d{4}-\d{2}-\d{2}$/.test(offer.startDate ?? "") || !Number.isFinite(offer.annualSalary) || Number(offer.annualSalary) <= 0
          || !Number.isInteger(offer.probationMonths) || Number(offer.probationMonths) < 0 || Number(offer.probationMonths) > 12) throw new Error("처우 오퍼의 대상·직무·소속·고용형태·입사예정일·연봉·수습기간을 확인해 주세요.");
        const target = recruitmentApplicants.find((item) => item.id === offer.applicantId);
        if (!target) throw new Error("현재 지원자 목록에서 처우 오퍼 대상을 찾지 못했습니다. 최신 자료로 다시 요청해 주세요.");
        const create = await fetch("/api/hr/recruitment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: "offer", applicantId: offer.applicantId, proposedTitle: offer.proposedTitle.trim(), department: offer.department.trim(), employmentType: offer.employmentType.trim(), startDate: offer.startDate, annualSalary: Math.round(Number(offer.annualSalary)), probationMonths: Number(offer.probationMonths), notes: offer.notes?.trim() ?? "" }) });
        const payload = await create.json().catch(() => ({})) as { offer?: { id: string; status: string }; error?: string };
        if (!create.ok || !payload.offer) throw new Error(payload.error || "처우 오퍼를 저장하지 못했습니다.");
        const interviewMemo = { id: `IN-${randomId()}`, text: `면접 결과(합격) · 처우 오퍼 생성: ${offer.proposedTitle.trim()} / 연봉 ${Number(offer.annualSalary).toLocaleString("ko-KR")}원${offer.notes?.trim() ? ` · ${offer.notes.trim()}` : ""}`, author: target.owner || "담당자 미지정", createdAt: new Date().toISOString() };
        const updated: RecruitmentApplicant = { ...target, stage: "면접 합격", interviewMemos: [interviewMemo, ...(target.interviewMemos ?? [])], offer: payload.offer };
        const memoUpdate = await fetch("/api/hr/recruitment", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updated) });
        const memoPayload = await memoUpdate.json().catch(() => ({})) as { error?: string };
        if (!memoUpdate.ok) throw new Error(`처우 오퍼는 생성됐지만 면접 결과 메모를 저장하지 못했습니다: ${memoPayload.error || "알 수 없는 오류"}`);
        setRecruitmentApplicants((current) => current.map((item) => item.id === updated.id ? updated : item));
      }
      setAppliedActionIds((current) => [...current, action.id]);
      setNotice(action.type === "CREATE_RECRUITMENT_APPLICANT" && recruitmentReview ? "지원자와 면접 질문지를 등록했습니다. 입력한 일정도 함께 저장했습니다. 지원자 관리에서 해당 지원자의 면접 일정·면접 질문지를 확인해 주세요." : "변경안이 기존 ERP API를 통해 반영되었습니다. 해당 탭을 새로고침해 결과를 확인해 주세요.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "변경안을 반영하지 못했습니다."); }
    finally { setApplying(""); }
  }

  return <>
    <button type="button" className="local-codex-assistant-trigger" onClick={() => setOpen(true)} aria-label={`${title} 열기`} title={title}><span aria-hidden="true">✦</span><small>AI</small></button>
    {open && <HrModalBackdrop className="local-codex-assistant-backdrop" onMouseDown={close}>
      <section className={`local-codex-assistant-dialog${module === "hr" ? " hr-assistant-dialog" : ""}`} aria-labelledby="local-codex-assistant-title">
        <header><div data-korean-heading><h2 id="local-codex-assistant-title">{title}</h2><span>직원 정보 확인 · 첨부 자료 분석 · 변경안 반영</span></div><button type="button" className="local-codex-assistant-close" onClick={close} aria-label="대화창 닫기">×</button></header>
        <div className="local-codex-assistant-body">
          <p className="local-codex-assistant-notice">{module === "hr" ? "저장된 직원·입퇴사·채용·연차 정보를 조회해 답변합니다. 첨부 파일도 함께 분석하며, 금액과 기록 변경은 아래 변경안을 확인하고 반영할 수 있습니다." : "이 컴퓨터의 Claude가 실행합니다. ERP 데이터와 첨부 파일을 분석하려면 아래 동의를 선택하세요. 변경안은 확인 후 직접 적용할 때 반영됩니다."}</p>
          {module !== "hr" && <label className="local-codex-data-consent"><input type="checkbox" checked={includeServerData} onChange={(event) => setIncludeOptionalData(event.target.checked)} disabled={submitting} /><span>현재 HR·임금 계산 데이터와 첨부 파일의 추출 텍스트를 AI 분석에 포함하는 데 동의합니다.</span></label>}
          {module === "hr" && <div className="hr-assistant-topics" aria-label="HR 도움 주제">{(Object.keys(hrAssistantTopics) as HrAssistantTopic[]).map((key) => <button type="button" key={key} aria-pressed={hrTopic === key} onClick={() => setHrTopic(key)}>{hrAssistantTopics[key].label}</button>)}</div>}
          {module === "hr" && (conversation.length > 0 || response) && <div className="hr-assistant-history"><div><strong>이전 대화</strong><button type="button" disabled={submitting || Boolean(applying)} onClick={() => { setConversation([]); setResponse(null); setAnsweredQuestion(""); setQuestion(""); setResponseSources([]); setError(""); setNotice(""); setAppliedActionIds([]); }}>새 대화</button></div>{conversation.map((entry, index) => <details key={index}><summary>{entry.question}</summary><p>{entry.answer}</p></details>)}</div>}
          <div className="local-codex-file">
            <label className={`local-codex-file-picker${fileAnalysis ? " selected" : ""}${submitting ? " disabled" : ""}`}>
              <input type="file" accept=".xlsx,.csv,.json,.txt,.pdf,.docx" onChange={handleFile} disabled={submitting || fileBusy} />
              <span className="local-codex-file-icon" aria-hidden="true">⌁</span>
              <span className="local-codex-file-copy"><b>{fileAnalysis ? fileAnalysis.fileName : "분석할 파일 첨부"}</b><small>{fileAnalysis ? `${fileAnalysis.rowCount.toLocaleString("ko-KR")}행 · ${fileAnalysis.columns.length}개 열` : "XLSX · CSV · JSON · TXT · PDF · DOCX"}</small></span>
              <span className="local-codex-file-action">{fileAnalysis ? "분석 완료" : "파일 선택"}</span>
            </label>
            {fileStatus && <small className="local-codex-file-status" role="status">{fileStatus}</small>}
            {fileAnalysis && <button type="button" onClick={() => { setFileAnalysis(null); setFileStatus(""); }} disabled={submitting}>파일 제외</button>}
          </div>
          {module === "hr" && hrTopic === "recruitment" && <label className="local-codex-target-position"><span>지원 포지션</span><input value={targetPosition} maxLength={120} onChange={(event) => setTargetPosition(event.target.value)} placeholder="예: AI 인프라 기술영업 / 기술지원 / 온라인 마케팅" disabled={submitting} /><small>이력서와 함께 입력하면 XD NODE 사업·직무 흐름을 반영한 질문 리스트를 만듭니다.</small></label>}
          {module === "hr" && hrTopic === "recruitment" && <div className="hr-recruitment-helper">
            <strong>채용 보조</strong><p>이력서 분석 → 지원자 정보 확인 → 일정·질문지 함께 저장</p>
            <label><span>이력서 내용 직접 입력</span><textarea value={resumeInput} maxLength={24000} disabled={submitting || Boolean(applying)} placeholder="파일 대신 이력서 내용을 붙여 넣어도 됩니다. 이름, 이메일, 경력 내용을 포함해 주세요." onChange={event => { setResumeInput(event.target.value); setFileAnalysis(null); setFileStatus(""); }} /></label>
            <div className="hr-recruitment-fields">
              <label><span>면접일</span><input type="date" value={interviewDraft.date} disabled={Boolean(applying)} onChange={event => setInterviewDraft({ ...interviewDraft, date: event.target.value })} /></label>
              <label><span>시작 시간 (한국 시간)</span><input type="time" value={interviewDraft.time} disabled={Boolean(applying)} onChange={event => setInterviewDraft({ ...interviewDraft, time: event.target.value })} /></label>
              <label><span>면접 방식</span><select value={interviewDraft.type} disabled={Boolean(applying)} onChange={event => setInterviewDraft({ ...interviewDraft, type: event.target.value })}><option>1차 대면</option><option>2차 대면</option><option>화상 면접</option><option>전화 면접</option></select></label>
              <label><span>면접관</span><input value={interviewDraft.interviewers} maxLength={200} disabled={Boolean(applying)} onChange={event => setInterviewDraft({ ...interviewDraft, interviewers: event.target.value })} placeholder="예: 채용 담당자, 팀장" /></label>
              <label className="wide"><span>장소 또는 접속 링크</span><input value={interviewDraft.location} maxLength={1000} disabled={Boolean(applying)} onChange={event => setInterviewDraft({ ...interviewDraft, location: event.target.value })} /></label>
            </div>
            <small>일정 미정이면 날짜와 시간을 비워 두세요. 일정을 입력하면 면접 단계로 등록합니다.</small>
            <button type="button" onClick={() => void submit(undefined, true)} disabled={submitting || fileBusy || Boolean(applying)}>{submitting ? "이력서 분석·질문 생성 중…" : "이력서 분석 · 등록안과 질문 생성"}</button>
          </div>}
          {(module === "compensation" || module === "hr" && hrTopic === "payroll") && <label className="local-codex-period"><span>임금 초안 대상 월</span><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} disabled={submitting} /></label>}
          <div className="local-codex-assistant-suggestions" aria-label="추천 질문">{suggestions.map((item) => <button type="button" key={item} onClick={() => setQuestion(item)} disabled={submitting}>{item}</button>)}</div>
          <form onSubmit={submit}><label htmlFor="local-codex-question">무엇을 도와드릴까요?</label><textarea id="local-codex-question" value={question} maxLength={2000} onChange={(event) => setQuestion(event.target.value)} placeholder={module === "hr" ? hrAssistantTopics[hrTopic].questions[0] : "예: 올린 파일을 인사기록카드의 급여 기본값과 대조하고, 반영할 변경안을 만들어줘."} disabled={submitting} /><div className="local-codex-assistant-form-footer"><span>{question.length.toLocaleString("ko-KR")} / 2,000</span><button type="submit" disabled={!question.trim() || submitting || fileBusy}>{submitting ? "Claude가 검토 중…" : "요청하기"}</button></div></form>
          {error && <p className="local-codex-assistant-error" role="alert">{error}</p>}{notice && <p className="local-codex-assistant-success">{notice}</p>}
          {submitting && <p role="status" className="hr-assistant-progress">직원 정보와 첨부 자료를 검토하고 있습니다. 창을 닫아도 요청은 계속됩니다.</p>}
          {response && <article className="local-codex-assistant-answer" aria-live="polite">
            {module === "hr" && <><strong className="hr-assistant-question">{answeredQuestion}</strong><div className="hr-assistant-sources" aria-label="이번 답변에 제공한 자료">{responseSources.map((source) => <span key={source}>{source}</span>)}{responseIncludedData && responseAttachment && <span>첨부: {responseAttachment.fileName}</span>}</div></>}
            <p className="local-codex-assistant-answer-label">AI 답변</p><p>{response.answer}</p>
            {response.cautions && response.cautions.length > 0 && <div><strong>유의사항</strong><ul>{response.cautions.map((item) => <li key={item}>{item}</li>)}</ul></div>}
            {response.nextSteps && response.nextSteps.length > 0 && <div><strong>다음 단계</strong><ul>{response.nextSteps.map((item) => <li key={item}>{item}</li>)}</ul></div>}
            {response.interviewQuestions && response.interviewQuestions.length > 0 && <div className="local-codex-questions">
              <div className="local-codex-questions-head">
                <strong>맞춤 면접 질문</strong>
                <span>{response.interviewQuestions.length}개</span>
                <button type="button" onClick={() => void copyQuestions(response.interviewQuestions ?? [])}>질문 복사</button>
              </div>
              {interviewCategoryOrder
                .map((key) => [key, (response.interviewQuestions ?? []).filter((item) => item.category === key)] as const)
                .filter(([, items]) => items.length > 0)
                .map(([key, items]) => <section key={key} className="local-codex-question-group">
                  <h4>{interviewCategoryLabels[key] ?? key} <em>{items.length}</em></h4>
                  <ol>{items.map((item, index) => <li key={`${key}-${index}`}>
                    <p>{item.question}</p>
                    <small>확인 포인트 · {item.checkpoint}</small>
                  </li>)}</ol>
                </section>)}
            </div>}
            {response.proposedActions && response.proposedActions.length > 0 && <div className="local-codex-actions"><strong>반영 전 변경안</strong>
              {response.proposedActions.map((action) => <article key={action.id}><div><b>{action.title}</b><p>{action.summary}</p>
                {action.type === "UPDATE_HR_COMPENSATION_DEFAULTS" && <ul>{moneyFields.filter((field) => action.values[field] !== undefined && action.values[field] !== null).map((field) => <li key={field}>{moneyLabels[field]}: {Number(action.values[field]).toLocaleString("ko-KR")}원</li>)}</ul>}
                {action.type === "CREATE_COMPENSATION_DRAFT" && <small>{action.period} 임금 초안 작성</small>}
                {action.type === "APPLY_RETIREMENT_PAY" && action.retirementPay && <div className="hr-retirement-pay-review"><dl><div><dt>직원</dt><dd>{action.retirementPay.employeeName}</dd></div><div><dt>반영 월</dt><dd>{action.period}</dd></div><div><dt>퇴직금</dt><dd>{Number(action.retirementPay.amount).toLocaleString("ko-KR")}원</dd></div></dl><small>첨부: {action.retirementPay.sourceFileName}</small><blockquote>{action.retirementPay.evidence}</blockquote><small>선택한 월의 퇴직금 항목을 위 금액으로 갱신합니다.</small></div>}
                {action.type === "CREATE_RECRUITMENT_APPLICANT" && action.applicant && <div className="hr-recruitment-review">
                  <strong>{action.applicant.role} · 지원자 등록</strong>
                  <div className="hr-recruitment-fields">{(["name", "email", "phone", "experience", "summary"] as const).map(field => <label key={field} className={field === "summary" ? "wide" : ""}><span>{{ name: "지원자 이름", email: "이메일", phone: "연락처", experience: "경력", summary: "지원자 요약" }[field]}</span><input value={action.applicant?.[field] ?? ""} maxLength={field === "summary" ? 4000 : 200} disabled={Boolean(applying) || appliedActionIds.includes(action.id)} onChange={event => setResponse(current => current ? { ...current, proposedActions: current.proposedActions?.map(item => item.id === action.id && item.applicant ? { ...item, applicant: { ...item.applicant, [field]: event.target.value } } : item) } : current)} /></label>)}</div>
                  <small>이력서: {responseAttachment?.fileName}</small>
                  {recruitmentReview && <><p>면접 일정: {interviewDraft.date ? `${interviewDraft.date} ${interviewDraft.time} · ${interviewDraft.type}` : "미정 · 서류 검토로 등록"}<br />{interviewDraft.interviewers} {interviewDraft.location}</p><label><span>저장할 면접 질문지</span><textarea value={interviewDraft.questions} maxLength={20000} disabled={Boolean(applying) || appliedActionIds.includes(action.id)} onChange={event => setInterviewDraft({ ...interviewDraft, questions: event.target.value })} /></label><small>지원자 상세의 ‘면접 질문지’란에 자동으로 입력됩니다.</small></>}
                </div>}
                {action.type === "RECORD_INTERVIEW_REJECTION" && action.interviewResult && <small>{recruitmentApplicants.find((item) => item.id === action.interviewResult?.applicantId)?.name ?? "지원자"} · {action.interviewResult.outcome === "NO_SHOW" ? "면접 불참 탈락" : "면접 후 탈락"}</small>}
                {action.type === "CREATE_RECRUITMENT_OFFER" && action.offer && <small>{recruitmentApplicants.find((item) => item.id === action.offer?.applicantId)?.name ?? "지원자"} · {action.offer.proposedTitle} · 연봉 {Number(action.offer.annualSalary ?? 0).toLocaleString("ko-KR")}원<br />{action.offer.department} · {action.offer.startDate}</small>}
              </div>{canApply(action)
                ? <button type="button" onClick={() => void applyAction(action)} disabled={submitting || Boolean(applying) || appliedActionIds.includes(action.id)}>{appliedActionIds.includes(action.id) ? "반영 완료" : applying === action.id ? "반영 중…" : action.type === "CREATE_RECRUITMENT_APPLICANT" && recruitmentReview ? "지원자 · 일정 · 질문지 저장" : "내용 확인 후 반영"}</button>
                : <small className="local-codex-action-readonly">편집 권한이 있는 사용자만 반영할 수 있습니다.</small>}</article>)}
            </div>}
          </article>}
        </div>
      </section>
    </HrModalBackdrop>}
  </>;
}
