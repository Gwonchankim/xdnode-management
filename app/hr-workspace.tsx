"use client";

import { Fragment, useEffect, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { companyJobTitles, companyOrganizations, companyRanks } from "./hr-company-catalogs";
import WorkforcePlanningView from "./workforce-planning-view";
import RecruitmentRequisitionView from "./recruitment-requisition-view";
import { ErpDialogProvider, useErpDialog, type ErpDialogApi } from "./erp-dialog";
import PerformanceManagementView from "./performance-management-view";
import TrainingManagementView from "./training-management-view";
import HrAnalyticsView from "./hr-analytics-view";
import AudioTranscriptionControl from "./audio-transcription-control";
import WonInput from "./won-input";
import { HrModalBackdrop, InterviewAudio, useKoreanToday } from "./hr-ui";
import { buildEmploymentContract, contractFileName, contractKindLabels, contractPay, contractTokens, defaultContractOptions, downloadBlob, FIXED_TERM_MONTHS, firstTermNextStart, fixedTermEndDate, type ContractKind, type ContractOptions } from "./hr-employment-contract";
import { buildDashboardModel, koreanWon, type DashboardLeaveLedger, type DashboardLifecycleTask, type DashboardPayrollRun, type InboxPriority } from "./hr-dashboard-model";
import { CompositionBar, FillMeter, HorizontalBars, MonthlyFlowChart, PayrollStepper } from "./hr-dashboard-charts";
import LeaveManagementView, { LeaveLedgerPanel } from "./hr-leave-view";
import { buildDefaultInterviewQuestions } from "./hr-interview-question-templates";
import { copyText, secureContextAvailable } from "./client-runtime";

// access.canEdit 는 화면 안내용이다(보기 권한 배너). 버튼은 숨기지 않고, 저장·승인·삭제는 서버가 403 으로 막는다(Design §5.4 HR 탭, §6.3).
export default function HRWorkspace({ requestedView = "dashboard", navigationRequestKey = 0, access = { canEdit: true } }: { requestedView?: string; navigationRequestKey?: number; access?: { canEdit: boolean } }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<ShadowRoot | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    setRoot(hostRef.current.shadowRoot ?? hostRef.current.attachShadow({ mode: "open" }));
  }, []);

  return (
    <div className="peopleflow-host" ref={hostRef}>
      {root ? createPortal(
        <>
          {/* Shadow DOM needs its own stylesheet; a document-level CSS import cannot style it. */}
          {/* eslint-disable-next-line @next/next/no-css-tags */}
          <link rel="stylesheet" href="/hr-workspace.css" />
          <ErpDialogProvider>
            <XdnodeHrApp requestedView={requestedView} navigationRequestKey={navigationRequestKey} canEdit={access.canEdit} />
          </ErpDialogProvider>
        </>,
        root,
      ) : (
        // The shadow root only exists once the first effect has run, and the stylesheet it pulls in
        // loads after that again. Without this the module renders nothing for that whole stretch,
        // which reads as a hang rather than as loading.
        <div className="peopleflow-loading" role="status">
          <span className="peopleflow-loading-mark" aria-hidden="true">HR</span>
          <strong>HR 워크스페이스를 불러오는 중입니다</strong>
          <small>인사기록·조직·급여 데이터를 준비하고 있습니다.</small>
        </div>
      )}
    </div>
  );
}
type NavItem = {
  id: string;
  label: string;
  icon: string;
  badge?: string;
};

type PayrollSummary = {
  yearMonth: string;
  employeeCount: number;
  grossPay: number;
  deductions: number;
  netPay: number;
  status: "DRAFT" | "REVIEW" | "APPROVED" | "LOCKED";
  /** 그 달 임금안의 상태. 목록에 있는데 DRAFT 면 확정 뒤 다시 연 "수정 중"이다. */
  compensationStatus?: string;
  preparedBy: string;
  reviewedBy: string;
  approvedBy: string;
  lockedAt: number | null;
};

type PayrollRecord = {
  id: string;
  yearMonth: string;
  employeeId: string | null;
  employeeName: string;
  department: string | null;
  annualSalary: number;
  basePay: number;
  mealAllowance: number;
  childcareAllowance: number;
  vehicleAllowance: number;
  incentive: number;
  bonus: number;
  annualLeavePay: number;
  personalExpense?: number;
  retirementPay: number;
  deductions: number;
  grossPay: number;
  netPay: number;
  cardAllowance: number;
  cardUsage: number;
  personalPurchase: number;
  nonTaxable: number;
  welfareFund: number;
  notes: string;
  /** 급여대장의 항목별 공제. 공제 열 제목을 누르면 이 내역이 펼쳐진다. */
  deductionDetail?: Record<string, number>;
  sourceSheet: string;
  sourceRow: number;
};

const navGroups: { title: string; items: NavItem[]; collapsed?: boolean }[] = [
  {
    title: "업무 홈",
    items: [
      { id: "dashboard", label: "통합 대시보드", icon: "홈" },
    ],
  },
  {
    title: "인사 운영",
    items: [
      { id: "employees", label: "인사기록카드", icon: "인" },
      { id: "organization", label: "조직관리", icon: "조" },
      { id: "payroll", label: "급여관리", icon: "급" },
      { id: "documents", label: "인사문서", icon: "문" },
      { id: "onboarding", label: "입·퇴사 관리", icon: "입" },
      { id: "leave", label: "연차관리", icon: "연" },
    ],
  },
  {
    title: "채용",
    items: [
      { id: "requisitions", label: "채용요청·TO", icon: "요" },
      { id: "recruitment", label: "지원자 관리", icon: "채" },
      { id: "recruiters", label: "채용담당자 관리", icon: "담" },
    ],
  },
  {
    title: "성장과 분석",
    items: [
      { id: "reports", label: "통계·리포트", icon: "통" },
    ],
  },
  {
    // 화면과 API 는 있으나 아직 데이터가 없는 모듈들. 핵심 메뉴와 같은 비중으로 놓여 있으면 어디가 실제로 쓰이는 곳인지
    // 알기 어려워 접어 둔다. 채울 때가 되면 여기서 빼서 원래 그룹으로 돌려놓으면 된다.
    title: "준비 중",
    collapsed: true,
    items: [
      { id: "schedule", label: "일정·업무", icon: "일" },
      { id: "workforce", label: "인력계획·정원", icon: "계" },
      { id: "performance", label: "성과·목표", icon: "목" },
      { id: "training", label: "교육·법정교육", icon: "교" },
    ],
  },
];

type RetirementRecord = {
  requestId?: string;
  date: string;
  reason: string;
  completedTaskIds: string[];
  status?: string;
};

/** 첫 계약(3개월 기간제) 근무평가. 계약서 제2조의 기준 세 가지로 평가하고, 전환·종료 결정과 통지일을 함께 남긴다. */
type FirstTermCriterion = "job" | "attitude" | "teamwork";
type FirstTermReview = {
  ratings: Record<FirstTermCriterion, string>;
  comment: string;
  /** 근로자에게 결과를 서면 통지한 날. 계약서대로 만료 7일 전이어야 한다. */
  notifiedOn: string;
  decision: "CONVERT" | "END";
  decidedOn: string;
};
const FIRST_TERM_CRITERIA: { key: FirstTermCriterion; label: string }[] = [{ key: "job", label: "직무수행 능력" }, { key: "attitude", label: "근무태도" }, { key: "teamwork", label: "협업" }];
const FIRST_TERM_GRADES = ["우수", "보통", "미흡"];
const reviewSummary = (review: FirstTermReview) => FIRST_TERM_CRITERIA.map((item) => `${item.label} ${review.ratings[item.key]}`).join(" · ");

type Employee = {
  id: string;
  name: string;
  department: string;
  position: string;
  jobTitle?: string;
  type: string;
  joinDate: string;
  status: string;
  email: string;
  phone: string;
  address: string;
  birth: string;
  history: { date: string; type: string; detail: string }[];
  retirement?: RetirementRecord;
  annualSalary: number;
  basePay: number;
  mealAllowance: number;
  childcareAllowance: number;
  vehicleAllowance: number;
  /** 첫 계약(3개월 기간제) 동안 기준 연봉의 몇 %를 주는지. 처우 제안 때 정해 입사 전환으로 넘어온다. 없으면 100. */
  firstTermPayPercent?: number;
  /** 3개월 첫 계약이 끝나 기간의 정함이 없는 계약을 맺은 날(YYYY-MM-DD). 비어 있으면 아직 전환 전이다. */
  regularContractDate?: string;
  /** 첫 계약 근무평가와 결정. 대시보드의 전환 패널에서 기록한다. */
  firstTermReview?: FirstTermReview | null;
};

function isCurrentEmployee(employee: Employee, now = Date.now()) {
  if (employee.status.trim() === "퇴직") return false;
  const retirementStatus = employee.retirement?.status ?? "";
  if (["EFFECTIVE", "COMPLETED"].includes(retirementStatus)) return false;
  if (!["IN_PROGRESS", "READY"].includes(retirementStatus) || !employee.retirement?.date) return true;
  const koreaDate = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return employee.retirement.date.replaceAll(".", "-") > koreaDate;
}

type EmployeeInterviewRecord = {
  id: string;
  employeeId: string;
  interviewAt: string;
  transcript: string;
  memo: string;
  audioFileName: string | null;
  audioUrl: string | null;
  consentConfirmed: boolean;
  createdAt: number;
};

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type Applicant = {
  id: string;
  name: string;
  role: string;
  applied: string;
  owner: string;
  stage: string;
  experience: string;
  email: string;
  phone: string;
  /** 입사 전환 때 인사기록카드로 넘어간다. 예전 지원자에게는 없다. */
  birth?: string;
  address?: string;
  source: string;
  summary: string;
  /** 이력서를 AI 로 분석해 뽑은 근무 이력. summary(이력서 요약)와는 따로 적는다. */
  careerSummary: string;
  ownerId: string;
  resumeFileName: string;
  resumeText: string;
  checklist: string[];
  screeningMemos: RecruitmentNote[];
  interview?: InterviewSchedule;
  interviewMemos: RecruitmentNote[];
  requisitionId: string;
  offer?: RecruitmentOffer;
};

type RecruitmentRequisitionOption = {
  id: string;
  title: string;
  role: string;
  organizationId: string;
  requestedHeadcount: number;
  status: string;
};

type RecruitmentOffer = {
  id: string;
  applicantId: string;
  proposedTitle: string;
  department: string;
  employmentType: string;
  startDate: string;
  annualSalary: number;
  probationMonths: number;
  firstTermPayPercent: number;
  notes: string;
  status: string;
  requestedBy: string;
  approvedBy: string;
  approvedAt: number | null;
  employeeId: string;
  position: string;
  jobTitle: string;
  responseNote: string;
  respondedBy: string;
  respondedAt: number | null;
  cancellationReason: string;
  cancelledBy: string;
  cancelledAt: number | null;
  onboardedBy: string;
  onboardedAt: number | null;
};

type RecruitmentOfferDraft = Pick<RecruitmentOffer, "proposedTitle" | "department" | "employmentType" | "startDate" | "annualSalary" | "probationMonths" | "firstTermPayPercent" | "notes">;

type ResumeAnalysis = {
  name: string;
  email: string;
  phone: string;
  birth: string;
  address: string;
  role: string;
  experience: string;
  summary: string;
  /** 근무처와 거기서 한 일. 회사 하나당 항목 하나로 받아 화면에서 줄글로 조립한다. */
  careerHistory: { company: string; affiliation: string; period: string; summary: string }[];
  warnings: string[];
};

type RecruitmentNote = {
  id: string;
  text: string;
  author: string;
  createdAt: string;
};

type InterviewSchedule = {
  date: string;
  time: string;
  type: string;
  interviewers: string;
  location: string;
  note: string;
  /** 면접 질문지. interview_json 에 통째로 실려 저장되므로 API·스키마 변경이 없다. */
  questions?: string;
  /** 지원자가 지원한 자리 대신 역으로 제안한 포지션. 서류·면접 어느 단계에서도 나온다. */
  counterProposal?: string;
};

// 서류 심사 결과는 별도 컬럼이 아니라 stage 에서 읽는다. 지원 등록 직후의 "서류 검토"는 아직 아무도
// 합불을 누르지 않은 상태이고, "서류 탈락"만 명시적 탈락이다. 그 밖의 단계는 모두 서류를 통과한 뒤의
// 진행 상태이므로(면접 탈락·입사 취소 포함) 서류 기준으로는 합격으로 본다.
const SCREENING_PENDING_STAGE = "서류 검토";
const SCREENING_PASSED_STAGE = "서류 합격";
const SCREENING_REJECTED_STAGE = "서류 탈락";

function screeningResultOf(applicant: Applicant): "PENDING" | "PASSED" | "REJECTED" {
  if (applicant.stage === SCREENING_REJECTED_STAGE) return "REJECTED";
  if (applicant.stage === SCREENING_PENDING_STAGE) return "PENDING";
  return "PASSED";
}

const screeningLabels: Record<"PENDING" | "PASSED" | "REJECTED", string> = {
  PENDING: "서류 평가중", PASSED: "서류 합격", REJECTED: "서류 탈락",
};

function interviewScheduleLabel(applicant: Applicant) {
  const schedule = applicant.interview;
  if (!schedule || ![schedule.date, schedule.time, schedule.interviewers, schedule.location].some(Boolean)) return "";
  return [schedule.date || "일자 미정", schedule.time || "시간 미정", schedule.type || "유형 미정"].join(" · ");
}

const INTERVIEW_REJECTED_STAGE = "면접 탈락";
const INTERVIEW_NO_SHOW_STAGE = "면접 불참 탈락";
// 면접에서 합격을 누른 상태. 처우를 아직 제안하지 않았어도 여기서부터 처우 제안 단계가 열린다.
const INTERVIEW_PASSED_STAGE = "면접 합격";
// 처우 입력 이후의 단계들. 여기까지 온 사람은 면접을 본 것이다.
const OFFER_PREPARED_STAGE = "채용 제안 준비";
// 지원자가 다른 회사에 합격해 채용이 끝난 상태. 우리가 떨어뜨린 것이 아니라 "탈락"과 구분해 둔다.
const OTHER_OFFER_STAGE = "타사 합격";
const OFFER_STAGES = [INTERVIEW_PASSED_STAGE, OFFER_PREPARED_STAGE, "입사 예정", "채용 제안 거절", OTHER_OFFER_STAGE];
// 서류 탈락까지 포함한 탈락 상태들. 탈락자 표와 채용단계 표기가 이 목록을 쓴다.
const REJECTED_STAGES = [SCREENING_REJECTED_STAGE, INTERVIEW_REJECTED_STAGE, INTERVIEW_NO_SHOW_STAGE];

/** 더 손댈 일이 없는 단계들. 지원 현황에서는 빼고 페이지 맨 아래 "채용 종료" 표로 모은다.
 *  탈락뿐 아니라 제안 거절·타사 합격·입사 확정도 여기 들어간다 — 진행 중인 사람만 위에 남긴다. */
const CLOSED_STAGES = [
  ...REJECTED_STAGES,
  "채용 제안 거절", "채용 제안 종료", OTHER_OFFER_STAGE, "입사 예정", "입사 완료",
];

/** 채용 종료 표의 "종료 구분" 칸. 왜 끝났는지를 한 단어로 적는다. */
function closedReasonOf(applicant: Applicant) {
  if (applicant.stage === OTHER_OFFER_STAGE) return { label: "타사 합격", tone: "other" };
  if (REJECTED_STAGES.includes(applicant.stage)) return { label: applicant.stage, tone: "reject" };
  if (applicant.stage === "입사 예정" || applicant.stage === "입사 완료") return { label: "오퍼 수락", tone: "join" };
  return { label: "제안 거절", tone: "decline" };
}

/** 면접 결과 표의 진행 상태 색. 같은 사람이 아래 "채용 종료" 표에도 나오므로
 *  그쪽 종료 구분과 같은 색을 쓴다 — 한 사람이 표마다 다른 색이면 헷갈린다.
 *  아직 답을 기다리는 "채용 제안 준비"만 손댈 일이 남았다는 뜻으로 따로 둔다. */
type RecruitStage = "PENDING" | "INTERVIEW_PENDING" | "INTERVIEW_SCHEDULED" | "REJECTED" | "INTERVIEW" | "OTHER_OFFER";

/** 채용단계 열. 탈락한 사람은 사유와 무관하게 "탈락" 하나로 묶는다 — 어디서 떨어졌는지는
 *  현재 단계 열과 탈락자 표의 "탈락 단계"에 남는다. 처우 단계까지 간 사람은 "면접"이다.
 *  타사 합격은 우리 판단이 아니라 지원자 사정으로 끝난 것이라 따로 적는다. */
function recruitStageOf(applicant: Applicant): RecruitStage {
  if (applicant.stage === OTHER_OFFER_STAGE) return "OTHER_OFFER";
  if (REJECTED_STAGES.includes(applicant.stage)) return "REJECTED";
  if (applicant.stage === SCREENING_PENDING_STAGE) return "PENDING";
  if (OFFER_STAGES.includes(applicant.stage)) return "INTERVIEW";
  // 서류 합격 뒤로는 면접일이 잡혔는지로 갈린다. 날짜가 비어 있으면 아직 일정을 맞추는 중이다.
  return applicant.interview?.date?.trim() ? "INTERVIEW_SCHEDULED" : "INTERVIEW_PENDING";
}

const recruitStageLabels: Record<RecruitStage, string> = {
  PENDING: "서류 평가중", INTERVIEW_PENDING: "면접일 미정", INTERVIEW_SCHEDULED: "면접 예정",
  REJECTED: "탈락", INTERVIEW: "면접", OTHER_OFFER: OTHER_OFFER_STAGE,
};

/** 현재 단계 열. 면접 단계에서 내린 탈락은 불참이든 아니든 "면접 탈락"으로 적고,
 *  진행 중이면서 면접 일정이 잡혔으면 그 일정을 보여준다.
 *  불참인지 아닌지는 채용단계 열에서 서류 합격 / 면접으로 갈린다. */
function currentStageOf(applicant: Applicant) {
  if (applicant.stage === INTERVIEW_REJECTED_STAGE || applicant.stage === INTERVIEW_NO_SHOW_STAGE) return INTERVIEW_REJECTED_STAGE;
  // 처우까지 제안했으면 면접 절차는 끝난 것이라 "면접 종료"로 적는다. 합격만 누르고 아직
  // 처우를 제안하지 않았으면 "면접 합격" 그대로 둔다 — 그 둘은 해야 할 일이 다르다.
  // 입사 예정·제안 거절·타사 합격은 그 뒤의 별개 상태라 단계 이름을 그대로 보여준다.
  if (applicant.stage === OFFER_PREPARED_STAGE) return "면접 종료";
  // 면접 이후 단계(면접 합격·입사 예정·제안 거절·타사 합격)는 단계 이름을 그대로 보여준다.
  // 이 갈래가 없으면 절차가 끝난 사람에게도 지난 면접 일정이 계속 현재 단계로 뜬다.
  if (OFFER_STAGES.includes(applicant.stage)) return applicant.stage;
  const schedule = interviewScheduleLabel(applicant);
  if (screeningResultOf(applicant) === "PASSED" && schedule) return schedule;
  return applicant.stage;
}

/** 면접 일시 정렬용 키. 일자나 시간이 비어 있으면 뒤로 보낸다. */
/** 경력란 조립. 요청받은 모양은 두 줄이다.
 *    · 회사명(소속 및 직급): 재직기간
 *        ·  업무내용 요약
 *  비어 있는 조각은 괄호나 콜론째로 빼서 빈 껍데기가 남지 않게 한다. */
function formatCareerHistory(entries: ResumeAnalysis["careerHistory"]) {
  return entries
    .filter((item) => item.company || item.summary)
    .flatMap((item) => {
      const head = [
        item.company.trim(),
        item.affiliation.trim() ? `(${item.affiliation.trim()})` : "",
        item.period.trim() ? `: ${item.period.trim()}` : "",
      ].join("");
      return item.summary.trim() ? [`· ${head}`, `    ·  ${item.summary.trim()}`] : [`· ${head}`];
    })
    .join("\n");
}

/** 어시스턴트가 돌려주는 면접 질문 한 건. 분류·질문·확인 포인트로 나뉘어 온다. */
type InterviewQuestionItem = { category: string; question: string; checkpoint: string };

const interviewQuestionLabels: Record<string, string> = {
  RESUME_CHECK: "이력서 근거 확인",
  ROLE_SKILL: "지원 직무 역량",
  COUNTER_ROLE_SKILL: "역제안 직무 역량",
  COUNTER_FIT: "역제안 타당성",
  BUSINESS_SCENARIO: "XD NODE 사업 시나리오",
  COLLABORATION: "협업·문제해결",
};
const interviewQuestionOrder = ["RESUME_CHECK", "ROLE_SKILL", "COUNTER_ROLE_SKILL", "COUNTER_FIT", "BUSINESS_SCENARIO", "COLLABORATION"];

/** 질문지를 사람이 그대로 읽을 수 있는 글로 편다. 분류별로 묶고 확인 포인트를 아래 붙인다. */
/** 역제안 질문이 시작되는 자리를 눈에 띄게 갈라 준다. 지원 포지션 질문과 섞이면
 *  면접관이 어느 자리에 대한 질문인지 헷갈린다. */
const COUNTER_QUESTION_CATEGORIES = ["COUNTER_ROLE_SKILL", "COUNTER_FIT"];
const COUNTER_QUESTION_SEPARATOR = "--------------- 역제안 포지션용 질문 ---------------";
/** 기본 질문지 아래에 AI 심화 질문을 덧붙일 때 넣는 구분선. */
const DEEP_QUESTION_SEPARATOR = "--------------- 심화 면접 질문 ---------------";

function formatInterviewQuestions(items: InterviewQuestionItem[]) {
  let counterStarted = false;
  return interviewQuestionOrder
    .map((key) => [key, items.filter((item) => item.category === key)] as const)
    .filter(([, group]) => group.length > 0)
    .map(([key, group]) => {
      const block = [`[${interviewQuestionLabels[key] ?? key}]`,
        ...group.map((item, index) => `${index + 1}. ${item.question}\n   → 확인 포인트: ${item.checkpoint}`)].join("\n");
      // 첫 역제안 묶음 앞에만 구분선을 넣는다. 묶음 사이는 빈 줄로 이어지므로 위아래가 한 줄씩 뜬다.
      if (!counterStarted && COUNTER_QUESTION_CATEGORIES.includes(key)) {
        counterStarted = true;
        return `${COUNTER_QUESTION_SEPARATOR}\n\n${block}`;
      }
      return block;
    })
    .join("\n\n");
}

/** 질문을 만들 때 어시스턴트에 넘기는 회사 사업 정보. 화면(local-codex-assistant)과 같은 내용이다. */
const companyInterviewProfile = {
  company: "XD NODE",
  business: [
    "AI 사업을 중심으로 한 B2B 영업과 고객 관리",
    "AI·GPU 서버와 고성능 IT 인프라의 제안·조달·납품·기술지원",
    "온라인 채널 및 마케팅 운영",
  ],
  operatingModel: "구매·AI사업 영업·온라인 마케팅·기술지원·경영/영업지원 조직이 견적, 원가·마진, 납기, 고객지원 흐름을 함께 운영합니다.",
  // 역제안 포지션이 우리 조직에 있는 직무인지 판단하는 근거다. 여기 없으면 질문을 지어내지 않는다.
  roleFocus: {
    영업: ["고객 요구사항 파악", "솔루션 제안", "마진·수익성", "계약·납기·수금 관리"],
    구매: ["벤더·조달", "원가·납기", "호환성 확인", "재고·리스크 관리"],
    마케팅: ["온라인 채널", "캠페인 성과", "콘텐츠", "리드 전환"],
    기술지원: ["AI·GPU 인프라 이해", "구성·호환성", "구축·장애 대응", "고객 커뮤니케이션"],
    영업지원: ["견적·주문 문서", "납기·수금 지원", "데이터 정확성", "부서 협업"],
    경영지원: ["인사·총무 운영", "정확한 기록", "내부통제", "기밀 정보 취급"],
  },
  interviewGuardrails: "출신, 나이, 가족, 혼인·임신, 종교, 건강, 장애, 정치성향 등 직무와 무관한 민감한 개인정보를 묻지 마세요.",
};

const COMPANY_NAME = "(주) 엑스디노드";

/** "2026-09-04" -> "2026년 09월 04일". 비어 있으면 채워야 할 자리를 그대로 남긴다. */
function koreanDate(value: string) {
  const [year, month, day] = (value || "").split("-");
  return year && month && day ? `${year}년 ${month}월 ${day}일` : "[미정]";
}

/** 안내문 종류. 서버(app/api/hr/message-templates)에 저장된 문구가 있으면 그것을 쓰고,
 *  없으면 아래 기본 문구를 쓴다. */
type MessageTemplateId = "OFFER" | "ONBOARDING" | "REJECTION" | "INTERVIEW";

/** 사람마다 달라지는 값은 {{토큰}} 자리로 남긴다. 완성된 문장을 저장하면 이름·연봉이
 *  굳어 다른 지원자에게 그대로 나가기 때문이다. */
const OFFER_TEMPLATE_TOKENS = ["회사명", "지원자명", "담당자명", "포지션", "연봉", "입사예정일", "직급직책", "첫계약안내", "회신기한"];
const ONBOARDING_TEMPLATE_TOKENS = ["회사명", "입사자명", "입사일", "출근시간", "출근장소", "선택서류"];
const REJECTION_TEMPLATE_TOKENS = ["회사명", "지원자명", "담당자명", "포지션", "면접안내", "재지원안내"];
const INTERVIEW_TEMPLATE_TOKENS = ["회사명", "지원자명", "면접일시", "면접장소"];

const DEFAULT_OFFER_TEMPLATE = `제목: {{회사명}} 최종 합격 및 입사 오퍼 안내

안녕하세요, {{지원자명}}님.
{{회사명}} 채용 담당자 {{담당자명}}입니다.
이번 {{포지션}} 채용 과정에 최종 합격하신 것을 진심으로 축하드립니다.
채용 과정에서 보여주신 역량과 경험을 높이 평가했으며, 앞으로 함께하게 되기를 기대하고 있습니다.
입사 오퍼 내용은 다음과 같습니다.

* 연봉: 세전 {{연봉}}원
* 입사 예정일: {{입사예정일}}
* 직급·직책: {{직급직책}}
{{첫계약안내}}

내용을 확인하신 후, 오퍼를 승낙하실 경우 {{회신기한}}까지 본 메시지로 승낙 의사를 회신해 주시기 바랍니다.
예시: “입사 오퍼를 확인했으며, 해당 조건으로 입사를 승낙합니다.”
다시 한번 최종 합격을 축하드리며, 문의 사항이 있으시면 언제든 편하게 연락해 주세요.
감사합니다.

{{회사명}}`;

const DEFAULT_ONBOARDING_TEMPLATE = `제목: 입사 일정 및 준비사항 안내

안녕하세요, {{입사자명}}님.
{{회사명}} 인사팀입니다.
입사 오퍼를 승낙해 주셔서 감사합니다.
{{회사명}}의 새로운 구성원으로 함께하게 된 것을 진심으로 환영합니다.
입사 일정과 준비사항을 아래와 같이 안내드립니다.

* 입사일: {{입사일}}
* 출근 시간: {{출근시간}}
* 출근 장소: {{출근장소}}

입사 준비물

* 주민등록등본
* 급여계좌 통장 사본
* 이력서에 기재한 주요 경력의 경력증명서
※ 발급이 어려운 경우 국민연금 가입증명서 또는 건강보험 자격득실확인서로 대체 가능
{{선택서류}}

준비가 어려운 서류가 있거나 입사 일정과 관련하여 문의 사항이 있으시면 미리 말씀해 주세요.
입사 당일 반갑게 뵙겠습니다. 다시 한번 입사를 진심으로 환영합니다.
감사합니다.

{{회사명}}`;

/** 면접에서 떨어뜨린 사람에게 보내는 안내문. 사유는 적지 않는다 — 탈락 사유를 글로 남기면
 *  분쟁의 근거가 되고, 채용은 우열이 아니라 직무 적합도로 갈린 결정이기 때문이다.
 *  면접에 오지 않은 사람에게도 같은 문구를 쓰되 면접 진행 문장만 빠진다. */
const DEFAULT_REJECTION_TEMPLATE = `제목: {{회사명}} {{포지션}} 채용 전형 결과 안내

안녕하세요, {{지원자명}}님.
{{회사명}} 채용 담당자 {{담당자명}}입니다.

먼저 저희 {{회사명}}의 {{포지션}} 채용에 관심을 갖고 소중한 시간을 내어 지원해 주셔서 진심으로 감사드립니다.
{{면접안내}}
아쉽게도 이번 채용에서는 함께하지 못하게 되었음을 안내드립니다.
이번 결정은 지원자님의 역량이 부족해서가 아니라, 현재 저희가 필요로 하는 직무와의 적합도를 기준으로 내린 것임을 말씀드립니다.

{{재지원안내}}
지원자님의 앞날에 좋은 결과가 함께하기를 진심으로 응원하겠습니다.
감사합니다.

{{회사명}}`;

/** 서류 합격 뒤 면접일·시작 시간을 넣으면 곧바로 만들어지는 안내문. 인사팀 명의라 담당자명은 쓰지 않는다. */
const DEFAULT_INTERVIEW_TEMPLATE = `안녕하세요. {{지원자명}}님
{{회사명}} 인사팀입니다.
자사에 대한 지원에 감사드리며
면접 전형 진행을 위한 면접 일정을 다음과 같이 안내드립니다.
- 면접 일시: {{면접일시}}
- 면접 장소: {{면접장소}}
건물 5층에 도착하시면 연락 부탁드립니다.
일정 변경이 필요하시거나 문의사항이 있으시면 편하게 연락해 주세요.
면접 당일 뵙겠습니다. 감사합니다.`;

const MESSAGE_TEMPLATE_IDS: MessageTemplateId[] = ["OFFER", "ONBOARDING", "REJECTION", "INTERVIEW"];

const DEFAULT_MESSAGE_TEMPLATES: Record<MessageTemplateId, string> = {
  OFFER: DEFAULT_OFFER_TEMPLATE,
  ONBOARDING: DEFAULT_ONBOARDING_TEMPLATE,
  REJECTION: DEFAULT_REJECTION_TEMPLATE,
  INTERVIEW: DEFAULT_INTERVIEW_TEMPLATE,
};

/** 토큰을 값으로 바꾼다. 토큰만 있던 줄이 빈 값이 되면 그 줄째로 지운다 —
 *  수습 안내를 끄거나 선택 서류를 하나도 안 고르면 빈 줄만 남기 때문이다. */
function renderTemplate(body: string, tokens: Record<string, string>) {
  const tokenPattern = /\{\{\s*([^}]+?)\s*\}\}/g;
  return body.split("\n")
    .map((line) => {
      const isTokenOnly = tokenPattern.test(line) && line.replace(tokenPattern, "").trim() === "";
      tokenPattern.lastIndex = 0;
      const filled = line.replace(tokenPattern, (match, key: string) => tokens[key.trim()] ?? match);
      return { filled, drop: isTokenOnly && filled.trim() === "" };
    })
    .filter((row) => !row.drop)
    .map((row) => row.filled)
    .join("\n");
}

const firstTermNotice = (percent: string) =>
  `* 첫 계약: 입사일부터 ${FIXED_TERM_MONTHS}개월간 기간제 근로계약이며, 해당 기간에는 기준 연봉의 ${percent || "[XX]"}%가 지급됩니다. 근무평가 후 기간의 정함이 없는 계약으로의 전환 여부를 결정합니다.`;

/** YYYY-MM-DD 문자열에 일수를 더한다. 시간대에 흔들리지 않게 UTC 로 계산한다. */
function shiftIsoDate(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}
const todayIsoDate = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; };

/** 회신 기한은 입사예정일보다 늦을 수 없다. 기본값(오늘+7일)이 입사일을 넘기면 입사 전날로 당기고,
 *  그 날이 이미 지났으면 오늘(입사일이 오늘이면 입사일)로 둔다. 사용자가 고른 값도 같은 규칙으로 맞춘다. */
function clampOfferReplyDue(replyDue: string, startDate: string, today = todayIsoDate()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return replyDue;
  const latest = shiftIsoDate(startDate, -1);
  const chosen = replyDue && replyDue < latest ? replyDue : latest;
  return chosen < today ? (today < startDate ? today : startDate) : chosen;
}

/** 합격 안내 메시지의 값들. 회신 기한과 첫 계약 안내 포함 여부만 화면에서 고르고 나머지는 제안 내용에서 온다. */
function offerMessageTokens(applicant: Applicant, offer: RecruitmentOffer, options: {
  replyDue: string;
  firstTerm: { percent: string } | null;
}): Record<string, string> {
  const position = [offer.department, offer.proposedTitle].filter(Boolean).join(" ") || applicant.role;
  return {
    회사명: COMPANY_NAME,
    지원자명: applicant.name,
    담당자명: applicant.owner || "[담당자명]",
    포지션: position,
    연봉: offer.annualSalary.toLocaleString("ko-KR"),
    입사예정일: koreanDate(offer.startDate),
    직급직책: offer.proposedTitle || "[직급 또는 직책]",
    // 회사는 첫 3개월을 기간제 계약으로 맺으므로 "수습"이라 적지 않는다.
    // 예전에 저장한 기본 문구의 {{수습안내}} 자리도 같은 문장을 받아, 문구를 다시 저장하지 않아도 어긋나지 않는다.
    첫계약안내: options.firstTerm ? firstTermNotice(options.firstTerm.percent) : "",
    수습안내: options.firstTerm ? firstTermNotice(options.firstTerm.percent) : "",
    회신기한: koreanDate(options.replyDue),
  };
}

/** 입사 안내문의 선택 서류. 체크한 것만 문구에 들어간다 — 사람마다 요구 서류가 달라서다. */
const ONBOARDING_OPTIONAL_DOCS = [
  { id: "certificate", label: "채용 직무와 관련하여 이력서에 기재한 자격증 사본(선택)" },
  { id: "diploma", label: "최종학력 졸업증명서(선택)" },
];

const ONBOARDING_START_TIME = "오전 09시 00분";
const ONBOARDING_PLACE = "서울특별시 성동구 성수일로 89, 5층 501, 505호";
const INTERVIEW_PLACE = "서울특별시 성동구 성수일로 89, 메타모르포 501·505호";

/** 입사 안내문의 값들. 입사일은 확정된 처우에서 오고 선택 서류만 화면에서 고른다. */
function onboardingMessageTokens(applicant: Applicant, offer: RecruitmentOffer, optionalDocIds: string[]): Record<string, string> {
  return {
    회사명: COMPANY_NAME,
    입사자명: applicant.name,
    입사일: koreanDate(offer.startDate),
    출근시간: ONBOARDING_START_TIME,
    출근장소: ONBOARDING_PLACE,
    선택서류: ONBOARDING_OPTIONAL_DOCS
      .filter((doc) => optionalDocIds.includes(doc.id))
      .map((doc) => `* ${doc.label}`)
      .join("\n"),
  };
}

/** 불합격 안내문의 값들. 면접일과 두 선택 문장만 화면에서 고르고 나머지는 지원자 기록에서 온다. */
function rejectionMessageTokens(applicant: Applicant, options: {
  interviewDate: string;
  mentionInterview: boolean;
  mentionReapply: boolean;
}): Record<string, string> {
  const dated = options.interviewDate.trim() ? `${koreanDate(options.interviewDate)}에 진행된 면접 내용을 바탕으로 ` : "면접 내용을 바탕으로 ";
  return {
    회사명: COMPANY_NAME,
    지원자명: applicant.name,
    담당자명: applicant.owner || "[담당자명]",
    포지션: applicant.role,
    면접안내: options.mentionInterview ? `${dated}지원해 주신 포지션과의 적합도를 신중히 검토하였습니다.` : "",
    재지원안내: options.mentionReapply ? "추후 새로운 포지션이 열릴 때 다시 지원해 주시면 반갑게 검토하겠습니다." : "",
  };
}

/** 면접 안내문의 값들. 면접일·시작 시간은 팝업에 입력 중인 값을 그대로 써서 저장 전에도 문구가 보인다. */
function interviewMessageTokens(applicant: Applicant, schedule: InterviewSchedule): Record<string, string> {
  const [year, month, day] = (schedule.date || "").split("-").map(Number);
  const [hour, minute] = (schedule.time || "").split(":").map(Number);
  const weekday = year && month && day ? `(${"일월화수목금토"[new Date(year, month - 1, day).getDay()]}요일)` : "";
  const dateText = year && month && day ? `${year}년 ${month}월 ${day}일${weekday}` : "[면접일 미정]";
  const timeText = Number.isFinite(hour) && Number.isFinite(minute) ? `${hour}시 ${String(minute).padStart(2, "0")}분` : "[시간 미정]";
  return { 회사명: COMPANY_NAME, 지원자명: applicant.name, 면접일시: `${dateText} ${timeText}`, 면접장소: INTERVIEW_PLACE };
}

function interviewSortKey(applicant: Applicant) {
  const schedule = applicant.interview;
  return `${schedule?.date || "9999-99-99"} ${schedule?.time || "99:99"}`;
}

/** 면접 전형 진행 표는 세 갈래를 한 표에 담는다. 손댈 일이 남은 순서대로 위에 온다.
 *  AWAITING  면접 시각이 지났는데 합격·탈락을 아직 안 적은 사람 — 오늘 처리할 일이다.
 *  SCHEDULED 면접이 아직 남은 사람.
 *  PASSED    면접 합격을 누른 사람 — 지원 현황에서 빼고 여기에 결과로 남긴다. */
type InterviewTrack = "AWAITING" | "SCHEDULED" | "PASSED";

const interviewTrackLabels: Record<InterviewTrack, string> = {
  AWAITING: "결과 입력 대기", SCHEDULED: "면접 예정", PASSED: "면접 합격",
};

const interviewTrackOrder: Record<InterviewTrack, number> = { AWAITING: 0, SCHEDULED: 1, PASSED: 2 };

/** 역제안 칸을 얼마나 눈에 띄게 둘지 정한다. 칸을 잠그지는 않는다 —
 *  기록된 역제안 두 건이 모두 면접 전날에 들어왔고, 면접일이 아직 없는 지원자도 있기 때문이다.
 *  today  면접 당일
 *  soon   면접 시각 30분 전부터. 면접이 10~20분 일찍 시작되는 일이 잦아 미리 켜 둔다.
 *  past   면접이 지났고 역제안도 비어 있음 — 물러나 있게 한다.
 */
function counterProposalTone(schedule: InterviewSchedule, now: Date) {
  const date = (schedule.date || "").trim();
  if (!date) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (date > today) return "";
  if (date < today) return schedule.counterProposal?.trim() ? "" : "past";
  const [hour, minute] = (schedule.time || "").split(":").map(Number);
  if (Number.isFinite(hour) && Number.isFinite(minute)) {
    const start = new Date(now);
    start.setHours(hour, minute, 0, 0);
    if (now.getTime() >= start.getTime() - 30 * 60 * 1000) return "soon";
  }
  return "today";
}

function interviewTrackOf(applicant: Applicant, now: string): InterviewTrack {
  if (applicant.stage === INTERVIEW_PASSED_STAGE || applicant.stage === OFFER_PREPARED_STAGE) return "PASSED";
  const schedule = applicant.interview;
  // 시각을 안 적었으면 그날이 다 가야 지난 것으로 본다.
  const when = `${schedule?.date || "9999-99-99"} ${schedule?.time || "23:59"}`;
  return when < now ? "AWAITING" : "SCHEDULED";
}


type PersonnelActionType = "인사이동(전보)" | "승진" | "강등";

type Organization = {
  id: string;
  name: string;
  leaderEmployeeId: string | null;
  description: string;
};

type PersistedOrganizationLeader = {
  organizationId: string;
  leaderEmployeeId: string | null;
};

type PersistedOrganizationRecord = {
  organizationId: string;
  name: string;
  description: string;
};

type PersistedEmployeeRecord = {
  employeeId: string;
  name: string;
  birth: string;
  email: string;
  phone: string;
  address: string;
  department: string;
  type: string;
  joinDate: string;
  position: string;
  jobTitle: string;
  status: string;
  history: Employee["history"];
  retirement?: RetirementRecord;
  annualSalary: number;
  basePay: number;
  mealAllowance: number;
  childcareAllowance: number;
  vehicleAllowance: number;
  /** 첫 계약(3개월 기간제) 동안 기준 연봉의 몇 %를 주는지. 처우 제안 때 정해 입사 전환으로 넘어온다. 없으면 100. */
  firstTermPayPercent?: number;
  /** 3개월 첫 계약이 끝나 기간의 정함이 없는 계약을 맺은 날(YYYY-MM-DD). 비어 있으면 아직 전환 전이다. */
  regularContractDate?: string;
  /** 첫 계약 근무평가와 결정. 대시보드의 전환 패널에서 기록한다. */
  firstTermReview?: FirstTermReview | null;
};

type PersistedRetirementRequest = {
  id: string;
  employee_id: string;
  retirement_date: string;
  reason: string;
  status: string;
  checklist_json: string;
};

/** /api/hr/operations 가 내려주는 인사발령 행. 화면은 결재 시절에 SUBMITTED 로 남은 것만 쓴다. */
type LegacyPersonnelAction = {
  id: string;
  employee_id: string;
  action_type: string;
  effective_date: string;
  after_json: string;
  reason: string;
  status: string;
};

const retirementChecklist = {
  hr: [
    { id: "hr-approval", label: "퇴직 승인 및 퇴직 인사발령 등록" },
    { id: "hr-settlement", label: "급여·퇴직금·미사용 연차 정산" },
    { id: "hr-insurance", label: "4대보험 상실 신고와 퇴직 관련 행정 처리" },
    { id: "hr-access", label: "시스템 계정·출입 권한 회수 요청" },
    { id: "hr-documents", label: "퇴직 서류와 경력증명서 발급" },
  ],
  employee: [
    { id: "employee-form", label: "퇴직원 및 필수 서류 제출" },
    { id: "employee-handover", label: "업무 인수인계서 작성과 후임자 확인" },
    { id: "employee-assets", label: "노트북·출입증 등 회사 자산 반납" },
    { id: "employee-expense", label: "법인카드·미결 비용 최종 정산" },
    { id: "employee-security", label: "보안 및 비밀유지 의무 확인" },
  ],
};

const initialOrganizations: Organization[] = [
  ...companyOrganizations,
];

const initialRanks = [...companyRanks];
const initialJobTitles = [...companyJobTitles];

// 직원 명부는 클라이언트 번들에 넣지 않는다(R1 M1-3, Design §7.9). /api/hr/employee-records가 명부를 시드·병합해 준다.
const initialEmployees: Employee[] = [];

const initialApplicants: Applicant[] = [];

// 직원 목록을 받아 초기값을 정하는 화면. 첫 명부 응답 전에는 로딩 표시로 대신한다.
const EMPLOYEE_LIST_VIEWS = new Set(["dashboard", "schedule", "documents", "employees", "organization", "recruiters", "settings"]);


function StatusPill({ value }: { value: string }) {
  const kind = value.includes("완료") || value.includes("반영") || value.includes("재직") || value === "마감" ? "success" : value.includes("초과") || value.includes("휴직") ? "danger" : "pending";
  return <span className={`status-pill ${kind}`}>{value}</span>;
}

function XdnodeHrApp({ requestedView, navigationRequestKey, canEdit }: { requestedView: string; navigationRequestKey: number; canEdit: boolean }) {
  const dialog = useErpDialog();
  const [active, setActive] = useState(requestedView);
  // 사이드바의 「준비 중」 그룹 펼침 여부.
  const [deferredOpen, setDeferredOpen] = useState(false);
  const [employeeModalOpen, setEmployeeModalOpen] = useState(false);
  const [applicantModalOpen, setApplicantModalOpen] = useState(false);
  const [toast, setToast] = useState("");
  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  }, []);

  const [previousNavigation, setPreviousNavigation] = useState({ requestedView, navigationRequestKey });
  if (previousNavigation.requestedView !== requestedView || previousNavigation.navigationRequestKey !== navigationRequestKey) {
    setPreviousNavigation({ requestedView, navigationRequestKey });
    setActive(requestedView);
  }
  const [query, setQuery] = useState("");
  const [employees, setEmployees] = useState(initialEmployees);
  // 첫 /api/hr/employee-records 응답 전까지 true. 직원 목록으로 초기값을 정하는 화면은 이 동안 로딩 표시를 낸다.
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [organizations, setOrganizations] = useState(initialOrganizations);
  const [ranks, setRanks] = useState(initialRanks);
  const [jobTitles, setJobTitles] = useState(initialJobTitles);
  const [applicants, setApplicants] = useState(initialApplicants);
  const [recruiterIds, setRecruiterIds] = useState<string[]>(["gc.kim"]);
  const [requisitions, setRequisitions] = useState<RecruitmentRequisitionOption[]>([]);
  // 대시보드의 처리 대기함·급여 상태·역할별 배치에 쓰는 운영 자료. 첫 로드의 /api/hr/operations 응답에서 같이 받는다.
  const [lifecycleTasks, setLifecycleTasks] = useState<DashboardLifecycleTask[]>([]);
  const [payrollRuns, setPayrollRuns] = useState<DashboardPayrollRun[]>([]);
  // 전자결재 시절에 SUBMITTED 로 남은 인사발령. 결재가 없어져 여기서 바로 승인·반려한다(Design §12.2 레거시 결정).
  const [legacyPersonnelActions, setLegacyPersonnelActions] = useState<LegacyPersonnelAction[]>([]);
  // 연차관리 요약(촉진 대상·초과 사용). 대시보드 대기함에만 쓴다.
  const [leaveLedgers, setLeaveLedgers] = useState<DashboardLeaveLedger[]>([]);
  useEffect(() => {
    // 대시보드에 들어올 때만 읽는다. 다른 화면에서는 쓰지 않으므로 화면을 옮길 때마다 부르지 않는다.
    if (active !== "dashboard") return;
    let cancelled = false;
    fetch("/api/hr/leave").then((response) => response.ok ? response.json() as Promise<{ ledgers?: (DashboardLeaveLedger & { status: string; exitDate: string })[] }> : null)
      .then((payload) => { if (!cancelled && payload?.ledgers) setLeaveLedgers(payload.ledgers.filter((item) => item.status.trim() !== "퇴직" && !item.exitDate)); })
      .catch(() => { /* 연차 요약을 못 읽어도 대시보드는 뜬다. */ });
    return () => { cancelled = true; };
  }, [active]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [selectedPayrollMonth, setSelectedPayrollMonth] = useState<string | null>(null);
  const [selectedApplicantId, setSelectedApplicantId] = useState<string | null>(null);
  const [personnelAction, setPersonnelAction] = useState<string | null>(null);
  const [retirementOpen, setRetirementOpen] = useState(false);
  // 계약 만료 종료에서 퇴직 팝업을 열 때 퇴직일·사유를 미리 채운다.
  const [retirementPrefill, setRetirementPrefill] = useState<{ date: string; reason: string } | null>(null);
  const [resumeStatus, setResumeStatus] = useState<"idle" | "analyzing" | "done" | "error">("idle");
  const [resumeMessage, setResumeMessage] = useState("");
  // 분석에 쓴 원본 파일. 지원자 행이 만들어진 뒤에야 문서로 올릴 수 있어 여기 들고 있는다.
  const [resumeOriginal, setResumeOriginal] = useState<File | null>(null);
  const [applicantDraft, setApplicantDraft] = useState({ name: "", role: "", email: "", phone: "", birth: "", address: "", experience: "", source: "직접 등록", summary: "", careerSummary: "", resumeFileName: "", resumeText: "", requisitionId: "" });

  useEffect(() => {
    let cancelled = false;
    const loadLeaders = fetch("/api/hr/organization-leaders").then(async (response) => {
      const data = await response.json() as { leaders?: PersistedOrganizationLeader[]; error?: string };
      if (!response.ok) throw new Error(data.error || "조직장 정보를 불러오지 못했습니다.");
      return data.leaders ?? [];
    }).catch(() => null);
    const loadEmployeeRecords = fetch("/api/hr/employee-records").then(async (response) => {
      const data = await response.json() as { records?: PersistedEmployeeRecord[]; error?: string };
      if (!response.ok) throw new Error(data.error || "직원 정보를 불러오지 못했습니다.");
      return data.records ?? [];
    }).catch(() => null);
    const loadOrganizations = fetch("/api/hr/organizations").then(async (response) => {
      const data = await response.json() as { organizations?: PersistedOrganizationRecord[]; error?: string };
      if (!response.ok) throw new Error(data.error || "조직 정보를 불러오지 못했습니다.");
      return data.organizations ?? [];
    }).catch(() => null);
    const loadRetirements = fetch("/api/hr/operations").then(async (response) => {
      const data = await response.json() as { retirementRequests?: PersistedRetirementRequest[]; personnelActions?: LegacyPersonnelAction[]; lifecycleTasks?: DashboardLifecycleTask[]; payrollRuns?: DashboardPayrollRun[]; error?: string };
      if (!response.ok) throw new Error(data.error || "퇴직 절차를 불러오지 못했습니다.");
      return data;
    }).catch(() => null);

    // 직무 목록은 서버(hr_job_titles)가 기준이다. 못 불러오면 회사 기준자료로 시작한다.
    const loadJobTitles = fetch("/api/hr/catalogs").then(async (response) => {
      const data = await response.json() as { JOB_TITLE?: string[]; RANK?: string[]; error?: string };
      if (!response.ok) throw new Error(data.error || "직무·직위 목록을 불러오지 못했습니다.");
      return data;
    }).catch(() => null);

    Promise.all([loadLeaders, loadEmployeeRecords, loadOrganizations, loadRetirements, loadJobTitles]).then(([leaders, employeeRecords, organizationRecords, operations, jobTitleList]) => {
      if (cancelled) return;
      setEmployeesLoading(false);
      const retirementRequests = operations ? operations.retirementRequests ?? [] : null;
      if (operations) { setLifecycleTasks(operations.lifecycleTasks ?? []); setPayrollRuns(operations.payrollRuns ?? []); setLegacyPersonnelActions((operations.personnelActions ?? []).filter((action) => action.status === "SUBMITTED")); }
      if (jobTitleList?.JOB_TITLE?.length) setJobTitles(jobTitleList.JOB_TITLE);
      if (jobTitleList?.RANK?.length) setRanks(jobTitleList.RANK);
      const leaderByOrganization = new Map((leaders ?? []).map((leader) => [leader.organizationId, leader.leaderEmployeeId]));
      const recordByOrganization = new Map((organizationRecords ?? []).map((record) => [record.organizationId, record]));
      const renamedDepartmentByOriginalName = new Map(initialOrganizations.map((organization) => [organization.name, recordByOrganization.get(organization.id)?.name ?? organization.name]));
      // 조직관리에서 신설한 조직은 기준자료에 없고 서버 표에만 있다. 기준 조직 뒤에 붙인다.
      const extraOrganizations: Organization[] = (organizationRecords ?? []).filter((record) => !initialOrganizations.some((organization) => organization.id === record.organizationId))
        .map((record) => ({ id: record.organizationId, name: record.name, description: record.description, leaderEmployeeId: leaderByOrganization.get(record.organizationId) ?? null }));
      setOrganizations((items) => [...items.map((organization) => {
        const saved = recordByOrganization.get(organization.id);
        return {
          ...organization,
          ...(saved ? { name: saved.name, description: saved.description } : {}),
          leaderEmployeeId: leaderByOrganization.has(organization.id) ? leaderByOrganization.get(organization.id) ?? null : organization.leaderEmployeeId,
        };
      }), ...extraOrganizations.filter((extra) => !items.some((item) => item.id === extra.id))]);
      const persistedLeaderIds = new Set((leaders ?? []).map((leader) => leader.leaderEmployeeId).filter((id): id is string => Boolean(id)));
      const recordByEmployee = new Map((employeeRecords ?? []).map((record) => [record.employeeId, record]));
      const activeRetirementByEmployee = new Map((retirementRequests ?? []).filter((request) => ["SUBMITTED", "IN_PROGRESS", "READY", "EFFECTIVE", "COMPLETED"].includes(request.status)).map((request) => [request.employee_id, request]));
      const withActiveRetirement = (employee: Employee): Employee => {
        const request = activeRetirementByEmployee.get(employee.id);
        if (!request) return employee;
        let completedTaskIds: string[] = [];
        try { completedTaskIds = JSON.parse(request.checklist_json) as string[]; } catch { completedTaskIds = []; }
        return { ...employee, retirement: { requestId: request.id, date: request.retirement_date, reason: request.reason, completedTaskIds, status: request.status } };
      };
      setEmployees((items) => {
        const mergedExisting = items.map((employee) => {
        const record = recordByEmployee.get(employee.id);
        const merged = record ? { ...employee, ...record, id: employee.id } : employee;
        const renamedDepartment = renamedDepartmentByOriginalName.get(merged.department) ?? merged.department;
        const withOrganization = { ...merged, department: renamedDepartment };
          return withActiveRetirement(persistedLeaderIds.has(employee.id) ? { ...withOrganization, jobTitle: "조직장" } : withOrganization);
        });
        const existingIds = new Set(items.map((employee) => employee.id));
        const newlyRegistered = (employeeRecords ?? []).filter((record) => !existingIds.has(record.employeeId)).map((record) => ({
          id: record.employeeId,
          name: record.name,
          department: record.department,
          position: record.position,
          jobTitle: record.jobTitle,
          type: record.type,
          joinDate: record.joinDate,
          status: record.status,
          email: record.email,
          phone: record.phone,
          address: record.address,
          birth: record.birth,
          history: record.history,
          annualSalary: record.annualSalary,
          basePay: record.basePay,
          mealAllowance: record.mealAllowance,
          childcareAllowance: record.childcareAllowance,
          vehicleAllowance: record.vehicleAllowance,
          firstTermPayPercent: record.firstTermPayPercent,
          regularContractDate: record.regularContractDate,
          firstTermReview: record.firstTermReview ?? null,
          ...(record.retirement ? { retirement: record.retirement } : {}),
        } satisfies Employee)).map((employee) => {
          // 명부가 서버에서만 오므로 기존 직원도 이 경로로 들어온다. 조직 이름 변경과 조직장 표시를 같이 반영한다.
          const withOrganization = { ...employee, department: renamedDepartmentByOriginalName.get(employee.department) ?? employee.department };
          return withActiveRetirement(persistedLeaderIds.has(employee.id) ? { ...withOrganization, jobTitle: "조직장" } : withOrganization);
        });
        return [...mergedExisting, ...newlyRegistered];
      });
      if (!leaders || !employeeRecords || !organizationRecords || !retirementRequests) showToast("일부 저장 정보를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.");
    });
    return () => { cancelled = true; };
  }, [showToast]);

  useEffect(() => {
    let cancelled = false;
    const reloadRecruitment = () => { void fetch("/api/hr/recruitment", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { applicants?: Applicant[]; recruiterIds?: string[]; requisitions?: RecruitmentRequisitionOption[]; error?: string };
        if (!response.ok) throw new Error(data.error || "채용 정보를 불러오지 못했습니다.");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        const loadedApplicants = data.applicants ?? [];
        setApplicants(loadedApplicants);
        setRecruiterIds(data.recruiterIds?.length ? data.recruiterIds : ["gc.kim"]);
        setRequisitions(data.requisitions ?? []);
      })
      .catch((error: Error) => { if (!cancelled) showToast(error.message); }); };
    reloadRecruitment();
    window.addEventListener("hr-recruitment-updated", reloadRecruitment);
    return () => { cancelled = true; window.removeEventListener("hr-recruitment-updated", reloadRecruitment); };
  }, [showToast]);

  // 채용요청 목록은 앱을 켤 때 한 번만 읽어서, 채용요청을 새로 만들어도 지원자 등록 화면의
  // 선택지에 나타나지 않았다. 채용 관련 화면에 들어올 때마다 다시 읽는다.
  useEffect(() => {
    if (!["recruitment", "requisitions"].includes(active)) return;
    let cancelled = false;
    fetch("/api/hr/recruitment")
      .then((response) => response.ok ? response.json() as Promise<{ requisitions?: RecruitmentRequisitionOption[] }> : null)
      .then((payload) => { if (!cancelled && payload?.requisitions) setRequisitions(payload.requisitions); })
      .catch(() => { /* 목록 갱신 실패는 화면을 막지 않는다. 기존 목록을 그대로 쓴다. */ });
    return () => { cancelled = true; };
  }, [active]);

  // 목록에서 아래쪽 항목을 고르면 상세 화면이 그 스크롤 위치 그대로 열려 늘 아래에서 시작했다.
  // 화면이 바뀔 때 맨 위로 올린다.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.scrollTo({ top: 0, behavior: "auto" });
  }, [active, selectedEmployeeId, selectedApplicantId, selectedPayrollMonth]);

  const selectedEmployee = employees.find((employee) => employee.id === selectedEmployeeId) ?? null;
  const selectedApplicant = applicants.find((applicant) => applicant.id === selectedApplicantId) ?? null;
  const recruiters = employees.filter((employee) => recruiterIds.includes(employee.id) && isCurrentEmployee(employee));


  function navigate(id: string) {
    setActive(id);
    setQuery("");
    setSelectedEmployeeId(null);
    setSelectedPayrollMonth(null);
    setSelectedApplicantId(null);
  }

  async function saveEmployee(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const department = String(data.get("department"));
    const newEmployee: Employee = {
      id: String(data.get("employeeId")), name: String(data.get("name")), email: String(data.get("email")), phone: String(data.get("phone")),
      department, type: String(data.get("type")), joinDate: String(data.get("joinDate")).replaceAll("-", "."), position: String(data.get("position")),
      jobTitle: String(data.get("jobTitle")), status: "재직", address: "미입력", birth: "미입력", history: [{ date: String(data.get("joinDate")).replaceAll("-", "."), type: "입사", detail: `${department} ${String(data.get("position"))} 입사` }],
      annualSalary: 0, basePay: 0, mealAllowance: 0, childcareAllowance: 0, vehicleAllowance: 0,
    };
    if (employees.some((employee) => employee.id === newEmployee.id)) {
      showToast("이미 사용 중인 직원 ID입니다.");
      return;
    }
    try {
      const response = await fetch("/api/hr/employee-records", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: newEmployee.id, ...newEmployee }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "신규 직원을 저장하지 못했습니다.");
      setEmployees((value) => [...value, newEmployee]);
      setEmployeeModalOpen(false);
      showToast("신규 직원을 인사기록카드에 영구 등록했습니다.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "신규 직원을 저장하지 못했습니다.");
    }
  }

  // 3개월 첫 계약이 끝나 기간의 정함이 없는 계약을 맺은 날을 기록한다. 대시보드의 「정규직 전환 예정」은
  // 이 값이 비어 있는 사람만 보여 주므로, 기록하는 순간 목록에서 빠지고 인사이력에 한 줄 남는다.
  async function markRegularContract(employee: Employee, date: string, review: FirstTermReview) {
    await updateEmployee(employee.id, {
      regularContractDate: date,
      firstTermReview: review,
      history: [...employee.history, { date: date.replaceAll("-", "."), type: "정규직 전환", detail: `3개월 기간제 계약 종료 후 기간의 정함이 없는 근로계약 체결 · ${reviewSummary(review)}` }],
    });
  }

  // 첫 계약을 전환 없이 끝내기로 했을 때. 평가와 결정을 남기고 곧바로 퇴직 절차 팝업을 연다 —
  // 퇴직일은 계약 만료일, 사유는 미리 채운다. 결정이 기록되는 순간 대시보드 목록에서 빠진다.
  async function endFirstTermContract(employee: Employee, endDate: string, review: FirstTermReview) {
    const saved = await updateEmployee(employee.id, {
      firstTermReview: review,
      history: [...employee.history, { date: review.decidedOn.replaceAll("-", "."), type: "계약 만료", detail: `3개월 기간제 계약 만료(정규직 미전환) 결정 · ${reviewSummary(review)}` }],
    });
    if (!saved) return;
    setSelectedEmployeeId(employee.id);
    setRetirementPrefill({ date: endDate, reason: "3개월 기간제 근로계약 만료(정규직 미전환)" });
    setRetirementOpen(true);
  }

  async function updateEmployee(id: string, patch: Partial<Employee>) {
    const previous = employees.find((employee) => employee.id === id);
    if (!previous) return false;
    const next = { ...previous, ...patch };
    setEmployees((value) => value.map((employee) => employee.id === id ? next : employee));
    try {
      const response = await fetch("/api/hr/employee-records", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: id,
          name: next.name,
          birth: next.birth,
          email: next.email,
          phone: next.phone,
          address: next.address,
          department: next.department,
          type: next.type,
          joinDate: next.joinDate,
          position: next.position,
          jobTitle: next.jobTitle ?? "팀원",
          status: next.status,
          history: next.history,
          retirement: next.retirement ?? null,
          annualSalary: next.annualSalary,
          basePay: next.basePay,
          mealAllowance: next.mealAllowance,
          childcareAllowance: next.childcareAllowance,
          vehicleAllowance: next.vehicleAllowance,
          firstTermPayPercent: next.firstTermPayPercent ?? 100,
          regularContractDate: next.regularContractDate ?? "",
          firstTermReview: next.firstTermReview ?? null,
        }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "직원 정보를 저장하지 못했습니다.");
      showToast("인사기록의 변경내용을 영구 저장했습니다.");
      return true;
    } catch {
      setEmployees((value) => value.map((employee) => employee.id === id ? previous : employee));
      showToast("저장에 실패해 이전 정보로 되돌렸습니다.");
      return false;
    }
  }

  async function persistApplicantRecord(applicant: Applicant) {
    const response = await fetch("/api/hr/recruitment", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(applicant),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new Error(data.error || "채용 정보를 저장하지 못했습니다.");
  }

  async function savePersonnelAction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedEmployee || !personnelAction) return;
    const data = new FormData(event.currentTarget);
    const actionType = String(data.get("actionType")) as PersonnelActionType;
    const department = String(data.get("targetDepartment"));
    const position = String(data.get("targetPosition"));
    const note = String(data.get("note")).trim();
    const currentRank = ranks.indexOf(selectedEmployee.position);
    const targetRank = ranks.indexOf(position);

    if (actionType === "인사이동(전보)" && department === selectedEmployee.department) {
      showToast("인사이동은 현재 소속과 다른 부서를 선택해야 합니다.");
      return;
    }
    if (actionType === "승진" && currentRank >= 0 && targetRank <= currentRank) {
      showToast("승진은 현재보다 높은 직위을 선택해야 합니다.");
      return;
    }
    if (actionType === "강등" && currentRank >= 0 && (targetRank < 0 || targetRank >= currentRank)) {
      showToast("강등은 현재보다 낮은 직위을 선택해야 합니다.");
      return;
    }
    if (actionType === "강등" && !note) {
      showToast("강등 발령에는 정당한 사유를 반드시 입력해야 합니다.");
      return;
    }

    const detail = note || (actionType === "인사이동(전보)"
      ? `${selectedEmployee.department}에서 ${department}(으)로 인사이동`
      : `${selectedEmployee.position}에서 ${position}(으)로 ${actionType}`);
    try {
      const response = await fetch("/api/hr/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "personnelAction",
          employeeId: selectedEmployee.id,
          actionType,
          effectiveDate: String(data.get("effectiveDate")),
          fromDepartment: selectedEmployee.department,
          toDepartment: actionType === "인사이동(전보)" ? department : selectedEmployee.department,
          fromPosition: selectedEmployee.position,
          toPosition: actionType === "승진" || actionType === "강등" ? position : selectedEmployee.position,
          reason: detail,
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "인사 발령을 저장하지 못했습니다.");
      setPersonnelAction(null);
      showToast("인사발령을 반영했습니다.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "인사 발령을 저장하지 못했습니다.");
    }
  }

  async function updateOrganizationLeader(organizationId: string, leaderEmployeeId: string) {
    const previousLeaderId = organizations.find((organization) => organization.id === organizationId)?.leaderEmployeeId;
    const nextLeaderId = leaderEmployeeId || null;
    setOrganizations((value) => value.map((organization) => organization.id === organizationId ? { ...organization, leaderEmployeeId: nextLeaderId } : organization));
    setEmployees((value) => value.map((employee) => employee.id === leaderEmployeeId
      ? { ...employee, jobTitle: "조직장" }
      : employee.id === previousLeaderId && employee.jobTitle === "조직장" ? { ...employee, jobTitle: "팀원" } : employee));
    try {
      const response = await fetch("/api/hr/organization-leaders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, leaderEmployeeId: nextLeaderId }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "조직장 정보를 저장하지 못했습니다.");
      showToast("조직장을 저장했습니다. 이후 기능 업데이트에도 유지됩니다.");
    } catch {
      setOrganizations((value) => value.map((organization) => organization.id === organizationId ? { ...organization, leaderEmployeeId: previousLeaderId ?? null } : organization));
      setEmployees((value) => value.map((employee) => employee.id === previousLeaderId
        ? { ...employee, jobTitle: "조직장" }
        : employee.id === leaderEmployeeId && employee.jobTitle === "조직장" ? { ...employee, jobTitle: "팀원" } : employee));
      showToast("조직장 저장에 실패해 이전 값으로 되돌렸습니다.");
    }
  }

  async function addOrganization(name: string, description: string) {
    const trimmed = name.trim();
    if (!trimmed || organizations.some((organization) => organization.name === trimmed)) {
      showToast("새 조직명을 확인해 주세요.");
      return;
    }
    // 서버에 먼저 저장하고 응답의 조직을 목록에 붙인다. 예전에는 화면 상태만 바꿔 새로고침하면 사라졌다.
    try {
      const response = await fetch("/api/hr/organizations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: trimmed, description: description.trim() }) });
      const payload = await response.json() as { organization?: { organizationId: string; name: string; description: string }; error?: string };
      if (!response.ok || !payload.organization) throw new Error(payload.error || "조직을 저장하지 못했습니다.");
      const created = payload.organization;
      setOrganizations((value) => [...value, { id: created.organizationId, name: created.name, leaderEmployeeId: null, description: created.description }]);
      showToast(`${trimmed} 조직을 추가했습니다.`);
    } catch (error) { showToast(error instanceof Error ? error.message : "조직을 저장하지 못했습니다."); }
  }

  async function updateOrganization(organizationId: string, name: string, description: string) {
    const trimmedName = name.trim();
    const current = organizations.find((organization) => organization.id === organizationId);
    if (!current || !trimmedName || organizations.some((organization) => organization.id !== organizationId && organization.name === trimmedName)) {
      showToast("조직명은 비어 있거나 다른 조직과 같을 수 없습니다.");
      return false;
    }
    const savedDescription = description.trim() || "조직 설명 미입력";
    setOrganizations((items) => items.map((organization) => organization.id === organizationId ? { ...organization, name: trimmedName, description: savedDescription } : organization));
    if (current.name !== trimmedName) {
      setEmployees((items) => items.map((employee) => employee.department === current.name ? { ...employee, department: trimmedName } : employee));
    }
    try {
      const response = await fetch("/api/hr/organizations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, previousName: current.name, name: trimmedName, description: savedDescription }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "조직 정보를 저장하지 못했습니다.");
      showToast(`${trimmedName} 조직 정보를 영구 저장했습니다.`);
      return true;
    } catch (error) {
      setOrganizations((items) => items.map((organization) => organization.id === organizationId ? current : organization));
      if (current.name !== trimmedName) {
        setEmployees((items) => items.map((employee) => employee.department === trimmedName ? { ...employee, department: current.name } : employee));
      }
      showToast(error instanceof Error ? error.message : "저장에 실패해 이전 정보로 되돌렸습니다.");
      return false;
    }
  }

  function addRank(value: string) {
    const trimmed = value.trim();
    if (!trimmed || ranks.includes(trimmed)) return showToast("새 직위명을 확인해 주세요.");
    void changeCatalog("RANK", "POST", trimmed);
  }

  function removeRank(value: string) {
    if (employees.some((employee) => employee.position === value)) return showToast("사용 중인 직위는 삭제할 수 없습니다.");
    void changeCatalog("RANK", "DELETE", value);
  }

  // 직무·직위 목록은 서버(hr_catalog_items)에 저장한다. 예전에는 화면 상태에만 담겨 새로고침하면 사라졌다.
  // 서버가 돌려준 전체 목록으로 갈아 끼워, 다른 곳에서 바뀐 항목도 같이 따라온다.
  async function changeCatalog(kind: "JOB_TITLE" | "RANK", method: "POST" | "DELETE", value: string) {
    const label = kind === "JOB_TITLE" ? "직무" : "직위";
    try {
      const response = await fetch(method === "POST" ? "/api/hr/catalogs" : `/api/hr/catalogs?kind=${kind}&value=${encodeURIComponent(value)}`,
        method === "POST" ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, value }) } : { method });
      const payload = await response.json() as { values?: string[]; error?: string };
      if (!response.ok || !payload.values) throw new Error(payload.error || `${label}를 저장하지 못했습니다.`);
      (kind === "JOB_TITLE" ? setJobTitles : setRanks)(payload.values);
      showToast(method === "POST" ? `${value} ${label}를 추가했습니다. 인사기록카드·처우 확정에서 바로 고를 수 있습니다.` : `${value} ${label}를 삭제했습니다.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : `${label}를 저장하지 못했습니다.`);
    }
  }

  function addJobTitle(value: string) {
    const trimmed = value.trim();
    if (!trimmed || jobTitles.includes(trimmed)) return showToast("새 직무명을 확인해 주세요.");
    void changeCatalog("JOB_TITLE", "POST", trimmed);
  }

  function removeJobTitle(value: string) {
    if (["조직장", "미지정"].includes(value) || employees.some((employee) => employee.jobTitle === value)) return showToast("사용 중이거나 필수인 직무는 삭제할 수 없습니다.");
    void changeCatalog("JOB_TITLE", "DELETE", value);
  }

  // 결재 시절에 SUBMITTED 로 남은 인사발령·퇴직 요청을 승인·반려한다. 결재는 없어졌지만 그 행은 이 길로만 빠져나온다.
  async function decideLegacy(resource: "personnelActionDecision" | "retirementDecision", id: string, decision: "APPROVED" | "REJECTED") {
    const response = await fetch("/api/hr/operations", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource, id, decision, reason: decision === "APPROVED" ? "기존 결재 요청 승인" : "기존 결재 요청 반려" }),
    });
    const payload = await response.json().catch(() => ({})) as { item?: Record<string, unknown>; error?: string };
    if (!response.ok) throw new Error(payload.error || "처리하지 못했습니다.");
    return payload.item ?? {};
  }

  async function decideLegacyPersonnelAction(action: LegacyPersonnelAction, decision: "APPROVED" | "REJECTED") {
    try {
      const item = await decideLegacy("personnelActionDecision", action.id, decision);
      setLegacyPersonnelActions((items) => items.filter((entry) => entry.id !== action.id));
      if (decision === "APPROVED" && item.status === "EFFECTIVE") {
        let after: { department?: string; position?: string } = {};
        try { after = JSON.parse(action.after_json) as typeof after; } catch { after = {}; }
        setEmployees((items) => items.map((employee) => employee.id === action.employee_id
          ? { ...employee, department: after.department || employee.department, position: after.position || employee.position }
          : employee));
      }
      showToast(decision === "APPROVED" ? "인사발령을 반영했습니다." : "인사발령 요청을 반려했습니다.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "인사발령을 처리하지 못했습니다.");
    }
  }

  async function decideLegacyRetirement(decision: "APPROVED" | "REJECTED") {
    const employee = selectedEmployee;
    const requestId = employee?.retirement?.requestId;
    if (!employee || !requestId) return;
    try {
      const item = await decideLegacy("retirementDecision", requestId, decision);
      const status = String(item.status ?? (decision === "APPROVED" ? "IN_PROGRESS" : "REJECTED"));
      setEmployees((items) => items.map((entry) => {
        if (entry.id !== employee.id || !entry.retirement) return entry;
        if (decision === "REJECTED") { const rest = { ...entry }; delete rest.retirement; return rest; }
        return { ...entry, status: ["EFFECTIVE", "COMPLETED"].includes(status) ? "퇴직" : "퇴직 예정", retirement: { ...entry.retirement, status } };
      }));
      setRetirementOpen(false);
      showToast(decision === "APPROVED" ? "퇴직을 승인했습니다. 퇴직 절차 체크리스트를 이어서 관리할 수 있습니다." : "퇴직 요청을 반려했습니다.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "퇴직 요청을 처리하지 못했습니다.");
    }
  }

  async function saveRetirement(record: RetirementRecord) {
    if (!selectedEmployee) return;
    const employee = selectedEmployee;
    const totalTasks = retirementChecklist.hr.length + retirementChecklist.employee.length;
    const completed = record.completedTaskIds.length;
    try {
      if (record.requestId && ["IN_PROGRESS", "READY"].includes(record.status ?? "")) {
        const response = await fetch("/api/hr/operations", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resource: "retirementChecklist", id: record.requestId, completedTaskIds: record.completedTaskIds }),
        });
        const payload = await response.json() as { item?: { status?: string }; error?: string };
        if (!response.ok) throw new Error(payload.error || "퇴직 체크리스트를 저장하지 못했습니다.");
        const status = payload.item?.status ?? "IN_PROGRESS";
        setEmployees((items) => items.map((item) => item.id === employee.id ? { ...item, status: ["EFFECTIVE", "COMPLETED"].includes(status) ? "퇴직" : "퇴직 예정", retirement: { ...record, status } } : item));
        setRetirementOpen(false);
        showToast(status === "COMPLETED" ? "퇴직 절차를 완료하고 인사 상태를 반영했습니다." : `퇴직 체크리스트를 저장했습니다. 미완료 업무 ${totalTasks - completed}건`);
        return;
      }
      const tasks = [
        ...retirementChecklist.hr.map((task) => ({ id: task.id, title: task.label, ownerType: "HR", completed: record.completedTaskIds.includes(task.id) })),
        ...retirementChecklist.employee.map((task) => ({ id: task.id, title: task.label, ownerType: "EMPLOYEE", completed: record.completedTaskIds.includes(task.id) })),
      ];
      const response = await fetch("/api/hr/operations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "retirement", employeeId: employee.id, eventDate: record.date, reason: record.reason, tasks }),
      });
      const payload = await response.json() as { item?: { id?: string; status?: string }; error?: string };
      if (!response.ok) throw new Error(payload.error || "퇴직 절차를 저장하지 못했습니다.");
      const status = payload.item?.status ?? "IN_PROGRESS";
      setEmployees((items) => items.map((item) => item.id === employee.id ? { ...item, status: ["EFFECTIVE", "COMPLETED"].includes(status) ? "퇴직" : "퇴직 예정", retirement: { ...record, requestId: payload.item?.id, status } } : item));
      setRetirementOpen(false);
      showToast(["EFFECTIVE", "COMPLETED"].includes(status) ? "퇴직을 승인하고 퇴직 상태를 반영했습니다." : "퇴직을 승인했습니다. 퇴직일이 되면 재직·조직 명부에서 자동 제외됩니다.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "퇴직 절차를 저장하지 못했습니다.");
    }
  }

  async function parseResume(file: File | undefined) {
    if (!file) return;
    const resumeFile = file;
    setResumeOriginal(resumeFile);
    setResumeStatus("analyzing");
    setResumeMessage("이력서에서 텍스트를 읽고 있습니다.");
    const extension = resumeFile.name.split(".").pop()?.toLowerCase();
    if (!extension || !["pdf", "docx", "txt"].includes(extension)) {
      setResumeStatus("error");
      setResumeMessage("PDF, DOCX, TXT 이력서만 분석할 수 있습니다.");
      return;
    }

    // 원본 파일은 서버로 올리지 않는다. PDF·DOCX 도 pdfjs-dist / mammoth 로 이 브라우저에서
    // 텍스트만 뽑아 보낸다. Cloudflare 의 ai/tomarkdown 을 걷어낸 자리이고, 그래서 이력서가
    // 이 컴퓨터 밖으로 나가는 경로 자체가 없다.
    async function extractResumeText(): Promise<string> {
      let text = "";
      if (extension === "pdf") {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        // 워커는 public/ 에 둔 사본에서 받는다. node_modules 경로로 부르면 개발 서버가 그 파일을
        // 변환하면서 /@vite/client 를 끼워 넣는데, 그 모듈이 최상위에서 window 를 건드리기 때문에
        // window 가 없는 워커 안에서 "window is not defined" 로 터진다. ?url · ?worker 모두 마찬가지다.
        // public/ 은 변환 없이 그대로 나가므로 이 경로만 안전하다.
        // pdfjs-dist 를 올릴 때 public/pdfjs/pdf.worker.min.mjs 도 같이 복사해야 한다.
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
        const document = await pdfjs.getDocument({ data: new Uint8Array(await resumeFile.arrayBuffer()) }).promise;
        const pages: string[] = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          const page = await document.getPage(pageNumber);
          const content = await page.getTextContent();
          pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
        }
        text = pages.join("\n");
      } else if (extension === "docx") {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ arrayBuffer: await resumeFile.arrayBuffer() });
        text = result.value;
      } else if (extension === "txt") {
        text = await resumeFile.text();
      }

      const normalizedText = text.split("\u0000").join(" ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (normalizedText.length < 20) throw new Error("이력서에서 읽을 수 있는 텍스트가 없습니다. 이미지형 PDF라면 직접 입력해 주세요.");
      return normalizedText;
    }

    // AI 가 실패해도 지원자 등록을 막지 않는다. 이미 뽑아 둔 텍스트에서 정규식으로 기본값만 채운다.
    function applyBasicTextFallback(reason: string, normalizedText: string) {
      const lines = normalizedText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const email = normalizedText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
      const phone = normalizedText.match(/01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}/)?.[0]?.replace(/[.\s]/g, "-").replace(/-{2,}/g, "-") ?? "";
      const labeledName = normalizedText.match(/(?:이름|성명)\s*[:：]?\s*([가-힣]{2,5})/)?.[1];
      const lineName = lines.find((line) => /^[가-힣]{2,5}$/.test(line) && !["이력서", "자기소개서", "경력기술서"].includes(line));
      const role = normalizedText.match(/(?:지원\s*직무|지원\s*분야|희망\s*직무)\s*[:：]?\s*([^\n|]{2,40})/)?.[1]?.trim() ?? "";
      const experience = normalizedText.match(/(?:총\s*경력|경력)\s*[:：]?\s*(\d+\s*년(?:\s*\d+\s*개월)?)/)?.[1]?.replace(/\s+/g, " ") ?? "";
      const summaryLines = lines.filter((line) => line !== email && !line.includes(phone)).slice(0, 12);
      const summary = summaryLines.join(" · ").slice(0, 700);
      const fallback = {
        name: labeledName ?? lineName ?? "",
        role,
        email,
        phone,
        experience,
        summary,
      };
      const storedText = normalizedText.slice(0, 30000);
      const detectedCount = [fallback.name, fallback.role, fallback.email, fallback.phone, fallback.experience].filter(Boolean).length;
      setApplicantDraft((current) => ({
        ...current,
        name: fallback.name || current.name,
        role: fallback.role || current.role,
        email: fallback.email || current.email,
        phone: fallback.phone || current.phone,
        experience: fallback.experience || current.experience,
        summary: fallback.summary,
        resumeFileName: resumeFile.name,
        resumeText: storedText,
      }));
      setResumeStatus("done");
      setResumeMessage(`${reason} 기본 항목 ${detectedCount}개를 찾았습니다.`);
    }

    let resumeText: string;
    try {
      resumeText = await extractResumeText();
    } catch (extractionError) {
      setResumeStatus("error");
      setResumeMessage(extractionError instanceof Error ? extractionError.message : "이력서 내용을 읽지 못했습니다.");
      return;
    }

    setResumeMessage("Claude가 이력서를 분석하고 있습니다. 1~3분 걸릴 수 있습니다.");
    const controller = new AbortController();
    // 로컬 Ollama 추론은 CPU 에서 실측 70~140초가 걸린다. 서버쪽 AbortSignal.timeout(300_000)
    // 보다 짧으면 정상 응답이 도착하기 전에 클라이언트가 먼저 끊어 버린다.
    const timeoutId = window.setTimeout(() => controller.abort(), 300_000);
    let response: Response;
    try {
      try {
        response = await fetch("/api/hr/resume-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: resumeFile.name, resumeText }),
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeoutId);
      }
    } catch (requestError) {
      const reason = requestError instanceof Error && requestError.name !== "AbortError"
        ? requestError.message
        : "AI 분석 시간이 초과되었습니다.";
      applyBasicTextFallback(`${reason} 기본 텍스트 추출로 전환했습니다.`, resumeText);
      return;
    }

    let data: { analysis?: ResumeAnalysis; error?: string; resumeText?: string; provider?: string; localAvailable?: boolean };
    try {
      data = await response.json() as { analysis?: ResumeAnalysis; error?: string; resumeText?: string; provider?: string; localAvailable?: boolean };
    } catch {
      data = { error: "AI 분석 응답을 읽지 못했습니다." };
    }

    if (!response.ok || !data.analysis) {
      applyBasicTextFallback(`${data.error || "AI 분석에 실패했습니다."} 기본 텍스트 추출로 전환했습니다.`, resumeText);
      return;
    }

    const analysis = data.analysis;
    const detectedCount = [analysis.name, analysis.role, analysis.email, analysis.phone, analysis.experience].filter(Boolean).length;
    setApplicantDraft((current) => ({
      ...current,
      name: analysis.name || current.name,
      role: analysis.role || current.role,
      email: analysis.email || current.email,
      phone: analysis.phone || current.phone,
      birth: analysis.birth || current.birth,
      address: analysis.address || current.address,
      experience: analysis.experience || current.experience,
      summary: analysis.summary || current.summary,
      // 근무 이력도 여기서 바로 채운다. 등록 뒤 다시 분석을 돌릴 필요가 없다.
      careerSummary: formatCareerHistory(analysis.careerHistory ?? []) || current.careerSummary,
      resumeFileName: resumeFile.name,
      resumeText: data.resumeText || resumeText,
    }));
    setResumeStatus("done");
    const providerNote = "Claude";
    setResumeMessage(`${providerNote} 분석을 완료했습니다. 기본 항목 ${detectedCount}개를 찾았습니다.${analysis.warnings.length ? ` 확인 필요 ${analysis.warnings.length}건이 있습니다.` : " 찾지 못한 값은 임의로 채우지 않았습니다."}`);
  }

  // 결과가 미덥지 않을 때 사람이 눌러 한 번 더 돌린다. 파일을 다시 고를 필요 없이
  // 이미 뽑아 둔 이력서 텍스트를 그대로 보낸다.
  async function reanalyzeResume() {
    const resumeText = applicantDraft.resumeText;
    if (!resumeText) {
      showToast("다시 분석할 이력서 내용이 없습니다. 파일을 먼저 선택해 주세요.");
      return;
    }
    setResumeStatus("analyzing");
    setResumeMessage("이력서를 다시 분석하고 있습니다. 1~3분 걸릴 수 있습니다.");

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 300_000);
    let response: Response;
    try {
      try {
        response = await fetch("/api/hr/resume-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: applicantDraft.resumeFileName, resumeText }),
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeoutId);
      }
    } catch (requestError) {
      setResumeStatus("error");
      setResumeMessage(requestError instanceof Error && requestError.name !== "AbortError"
        ? `${requestError.message} 화면의 값은 그대로 두었습니다.`
        : "이력서 분석 시간이 초과되었습니다. 화면의 값은 그대로 두었습니다.");
      return;
    }

    let data: { analysis?: ResumeAnalysis; error?: string; resumeText?: string; provider?: string };
    try {
      data = await response.json() as { analysis?: ResumeAnalysis; error?: string; resumeText?: string; provider?: string };
    } catch {
      data = { error: "이력서 분석 응답을 읽지 못했습니다." };
    }
    if (!response.ok || !data.analysis) {
      setResumeStatus("error");
      setResumeMessage(`${data.error || "이력서 분석에 실패했습니다."} 화면의 값은 그대로 두었습니다.`);
      return;
    }

    const analysis = data.analysis;
    const detectedCount = [analysis.name, analysis.role, analysis.email, analysis.phone, analysis.experience].filter(Boolean).length;
    setApplicantDraft((current) => ({
      ...current,
      name: analysis.name || current.name,
      role: analysis.role || current.role,
      email: analysis.email || current.email,
      phone: analysis.phone || current.phone,
      birth: analysis.birth || current.birth,
      address: analysis.address || current.address,
      experience: analysis.experience || current.experience,
      summary: analysis.summary || current.summary,
      careerSummary: formatCareerHistory(analysis.careerHistory ?? []) || current.careerSummary,
    }));
    setResumeStatus("done");
    setResumeMessage(`재분석을 완료했습니다. 기본 항목 ${detectedCount}개를 찾았습니다.${analysis.warnings.length ? ` 확인 필요 ${analysis.warnings.length}건이 있습니다.` : ""}`);
  }

  async function saveApplicant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ownerId = recruiterIds[0] ?? "";
    const owner = employees.find((employee) => employee.id === ownerId)?.name ?? "미지정";
    const applicant: Applicant = { id: `AP-${Date.now()}`, ...applicantDraft, applied: new Date().toISOString().slice(0, 10).replaceAll("-", "."), ownerId, owner, stage: "서류 검토", checklist: [], screeningMemos: [], interviewMemos: [] };
    try {
      await persistApplicantRecord(applicant);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "지원자를 저장하지 못했습니다.");
      return;
    }
    // 원본 이력서를 지원자에게 붙여 둔다. 입사가 확정되면 이 파일이 인사문서로 넘어간다.
    // 문서 저장이 실패해도 지원자 등록 자체는 되돌리지 않는다 — 다시 올리면 되는 일이다.
    if (resumeOriginal) {
      try {
        const form = new FormData();
        form.append("module", "hr");
        form.append("entityType", "applicant");
        form.append("entityId", applicant.id);
        form.append("category", "RESUME");
        form.append("file", resumeOriginal, resumeOriginal.name);
        const response = await fetch("/api/documents", { method: "POST", body: form });
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { error?: string } | null;
          showToast(`이력서 원본을 보관하지 못했습니다. ${payload?.error ?? ""}`.trim());
        }
      } catch {
        showToast("이력서 원본을 보관하지 못했습니다. 지원자 등록은 완료되었습니다.");
      }
    }
    setApplicants((value) => [applicant, ...value]);
    setApplicantModalOpen(false);
    setResumeStatus("idle");
    setResumeOriginal(null);
    setApplicantDraft({ name: "", role: "", email: "", phone: "", birth: "", address: "", experience: "", source: "직접 등록", summary: "", careerSummary: "", resumeFileName: "", resumeText: "", requisitionId: "" });
    setResumeMessage("");
    showToast("지원자가 지원 현황에 등록되었습니다.");
  }

  function assignRecruiter(applicantId: string, ownerId: string) {
    const owner = employees.find((employee) => employee.id === ownerId)?.name ?? "미지정";
    const current = applicants.find((applicant) => applicant.id === applicantId);
    if (!current) return;
    const updated = { ...current, ownerId, owner };
    setApplicants((items) => items.map((applicant) => applicant.id === applicantId ? updated : applicant));
    persistApplicantRecord(updated).catch((error: Error) => showToast(error.message));
    showToast(`${owner} 님을 채용담당자로 지정했습니다.`);
  }

  async function addRecruiter(employeeId: string) {
    if (!employeeId || recruiterIds.includes(employeeId)) return;
    const response = await fetch("/api/hr/recruitment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employeeId }) });
    if (!response.ok) return showToast("채용담당자를 저장하지 못했습니다.");
    setRecruiterIds((items) => [...items, employeeId]);
    showToast("채용담당자를 추가했습니다.");
  }

  async function removeRecruiter(employeeId: string) {
    if (applicants.some((applicant) => applicant.ownerId === employeeId)) {
      showToast("담당 중인 지원자가 있어 먼저 담당자를 변경해야 합니다.");
      return;
    }
    const response = await fetch("/api/hr/recruitment", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employeeId }) });
    if (!response.ok) return showToast("채용담당자 해제를 저장하지 못했습니다.");
    setRecruiterIds((items) => items.filter((id) => id !== employeeId));
    showToast("채용담당자에서 제외했습니다.");
  }

  function addInterviewMemo(applicantId: string, text: string) {
    const applicant = applicants.find((item) => item.id === applicantId);
    if (!applicant || !text.trim()) return;
    const note: RecruitmentNote = { id: `IN-${Date.now()}`, text: text.trim(), author: applicant.owner || "담당자 미지정", createdAt: new Date().toISOString() };
    const updated = { ...applicant, interviewMemos: [note, ...(applicant.interviewMemos ?? [])] };
    setApplicants((items) => items.map((item) => item.id === applicantId ? updated : item));
    persistApplicantRecord(updated).catch((error: Error) => showToast(error.message));
    showToast("면접 메모를 저장했습니다.");
  }

  // 실패하면 사유를 돌려준다(성공은 null). 팝업이 이 값을 보고 열린 채 오류를 보여 준다 — 예전에는 응답을 기다리지 않고
  // 팝업을 닫아, 저장이 거부돼도 잠깐 뜨는 토스트만 남고 입력값이 사라졌다.
  async function submitRecruitmentOffer(applicantId: string, draft: RecruitmentOfferDraft): Promise<string | null> {
    try {
      const response = await fetch("/api/hr/recruitment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "offer", applicantId, ...draft }),
      });
      const payload = await response.json() as { offer?: RecruitmentOffer; error?: string };
      if (!response.ok || !payload.offer) throw new Error(payload.error || "채용 제안을 저장하지 못했습니다.");
      setApplicants((items) => items.map((item) => item.id === applicantId ? { ...item, offer: payload.offer, stage: "채용 제안 준비" } : item));
      showToast("채용 제안을 저장했습니다. 지원자 수락 시 입사 관리로 바로 전환할 수 있습니다.");
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "채용 제안을 저장하지 못했습니다.";
    }
  }

  async function respondRecruitmentOffer(applicantId: string, offerId: string, action: "ACCEPT" | "DECLINE", input: { employeeId?: string; position?: string; jobTitle?: string; responseNote: string; startDate?: string; annualSalary?: number; probationMonths?: number; firstTermPayPercent?: number; department?: string; proposedTitle?: string; employmentType?: string; declineKind?: "OFFER" | "OTHER_OFFER" }) {
    try {
      const response = await fetch("/api/hr/recruitment", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "offerResponse", id: offerId, action, ...input }),
      });
      const payload = await response.json() as { offer?: RecruitmentOffer; stage?: string; error?: string };
      if (!response.ok || !payload.offer) throw new Error(payload.error || "채용 제안 회신을 반영하지 못했습니다.");
      setApplicants((items) => items.map((item) => item.id === applicantId
        // 서버가 정한 단계를 그대로 쓴다. 타사 합격이면 "채용 제안 거절"이 아니라 "타사 합격"이다.
        ? { ...item, offer: payload.offer, stage: payload.stage
          ?? (action === "ACCEPT" ? "입사 예정" : input.declineKind === "OTHER_OFFER" ? OTHER_OFFER_STAGE : "채용 제안 거절") } : item));
      showToast(action === "ACCEPT" ? "입사 예정자로 전환했습니다. 입·퇴사 관리에서 입사일과 처우를 확인할 수 있습니다." : "채용 제안 거절 회신을 기록했습니다.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "채용 제안 회신을 반영하지 못했습니다.");
    }
  }

  // 서류 합불은 이제 지원자 팝업에서만 누른다. 잘못 눌렀을 때 되돌릴 수 있도록 RESET 도 받는다.
  function decideScreening(applicantId: string, decision: "PASS" | "REJECT" | "RESET") {
    const current = applicants.find((applicant) => applicant.id === applicantId);
    if (!current) return;
    const stage = decision === "PASS" ? SCREENING_PASSED_STAGE
      : decision === "REJECT" ? SCREENING_REJECTED_STAGE : SCREENING_PENDING_STAGE;
    const updated = { ...current, stage };
    setApplicants((items) => items.map((applicant) => applicant.id === applicantId ? updated : applicant));
    persistApplicantRecord(updated).catch((error: Error) => showToast(error.message));
    showToast(decision === "PASS" ? "서류 합격으로 처리했습니다. 면접 일정을 입력할 수 있습니다."
      : decision === "REJECT" ? "서류 탈락으로 처리했습니다."
      : "서류 심사 결과를 평가중으로 되돌렸습니다.");
  }

  // 면접 일정을 팝업에서 바로 저장한다. 일정이 잡히면 지원 현황의 현재 단계 열에 그대로 드러난다.

  // 서류 탈락과 별개의 단계다. 면접까지 본 뒤의 결과라 이력에서 구분되어야 한다.
  // attended 가 거짓이면 면접에 오지 않아 탈락한 것이다. 채용단계는 서류 합격에서 멈춘다.
  //
  // 단계와 메모를 반드시 한 번에 저장한다. 예전에는 단계를 저장한 뒤 addInterviewMemo 를 이어서
  // 불렀는데, 그 함수가 이 렌더 시점의 applicants 를 다시 읽는 탓에 바뀐 stage 가 빠진 레코드를
  // 뒤이어 덮어써서 탈락 처리가 통째로 사라졌다.
  function rejectAfterInterview(applicantId: string, note: string, attended: boolean) {
    const current = applicants.find((applicant) => applicant.id === applicantId);
    if (!current) return;
    const trimmed = note.trim();
    const memos = current.interviewMemos ?? [];
    const updated = {
      ...current,
      stage: attended ? INTERVIEW_REJECTED_STAGE : INTERVIEW_NO_SHOW_STAGE,
      interviewMemos: trimmed
        ? [{ id: `IN-${Date.now()}`, text: trimmed, author: current.owner || "담당자 미지정", createdAt: new Date().toISOString() }, ...memos]
        : memos,
    };
    setApplicants((items) => items.map((applicant) => applicant.id === applicantId ? updated : applicant));
    persistApplicantRecord(updated).catch((error: Error) => showToast(error.message));
    showToast(attended ? "면접 후 탈락으로 기록했습니다." : "면접 불참 탈락으로 기록했습니다.");
  }

  async function deleteApplicant(applicantId: string) {
    const applicant = applicants.find((item) => item.id === applicantId);
    if (!applicant) return;
    const confirmed = await dialog.confirm(`${applicant.name} 지원자의 기본정보, 이력서, 메모, 면접 일정과 녹음 파일을 모두 삭제합니다.\n삭제한 정보는 복구할 수 없습니다. 계속할까요?`, { title: "지원자 삭제", confirmLabel: "삭제", danger: true });
    if (!confirmed) return;
    try {
      const response = await fetch("/api/hr/recruitment", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicantId }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "지원자 정보를 삭제하지 못했습니다.");
      setApplicants((items) => items.filter((item) => item.id !== applicantId));
      if (selectedApplicantId === applicantId) setSelectedApplicantId(null);
      showToast(`${applicant.name} 지원자의 모든 정보를 삭제했습니다.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "지원자 정보를 삭제하지 못했습니다.");
    }
  }

  function updateApplicantDetail(updated: Applicant) {
    setApplicants((items) => items.map((applicant) => applicant.id === updated.id ? updated : applicant));
    persistApplicantRecord(updated)
      .then(() => showToast("지원자 정보와 특이사항을 저장했습니다."))
      .catch((error: Error) => showToast(error.message));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">HR</div><div><strong>인사관리</strong></div></div>
        <nav className="main-nav" aria-label="주요 메뉴">
          {navGroups.map((group) => {
            // 접힌 그룹은 토글로만 펼친다. 다른 화면의 링크(정원 관리 → 등)로 그 안의 메뉴에 들어오면 그 동안은 펼쳐 둔다.
            const collapsible = Boolean(group.collapsed);
            const open = !collapsible || deferredOpen || group.items.some((item) => item.id === active);
            return <div className="nav-group" key={group.title}><p>{group.title}</p>
              {collapsible && <button type="button" className={`nav-item nav-collapsed-toggle${open ? " open" : ""}`} aria-expanded={open} onClick={() => setDeferredOpen((value) => !value)}><span className="nav-icon">{open ? "−" : "+"}</span><span>{group.title} {group.items.length}</span></button>}
              {open && group.items.map((item) => (
                <button type="button" key={item.id} className={`nav-item ${active === item.id ? "active" : ""}`} onClick={() => navigate(item.id)}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.badge && <em>{item.badge}</em>}</button>
              ))}
            </div>;
          })}
        </nav>
        <div className="sidebar-footer">
          <button type="button" className={`settings-button ${active === "settings" ? "active" : ""}`} onClick={() => navigate("settings")}><span className="nav-icon">설</span>환경설정</button>
        </div>
      </aside>

      <main className="main-content">
        {!canEdit && <p className="hr-view-only-banner" role="status">보기 권한만 있습니다. 저장·승인·삭제는 거부됩니다.</p>}
        {employeesLoading && EMPLOYEE_LIST_VIEWS.has(active) && <section className="panel hr-employees-loading" role="status" aria-live="polite"><strong>직원 정보를 불러오는 중입니다.</strong><span>잠시만 기다려 주세요.</span></section>}
        {!employeesLoading && active === "dashboard" && <Dashboard employees={employees} organizations={organizations} applicants={applicants} requisitions={requisitions} lifecycleTasks={lifecycleTasks} payrollRuns={payrollRuns} leaveLedgers={leaveLedgers} onNavigate={navigate} onOpenEmployee={(id) => { navigate("employees"); setSelectedEmployeeId(id); }} onOpenApplicant={(id) => { navigate("recruitment"); setSelectedApplicantId(id); }} onMarkRegular={markRegularContract} onEndContract={endFirstTermContract} />}
        {!employeesLoading && active === "schedule" && <TimeAndLeaveView employees={employees} onNotify={showToast} />}
        {!employeesLoading && active === "documents" && <EmployeeDocumentView employees={employees} onNotify={showToast} />}
        {!employeesLoading && active === "employees" && <EmployeeDirectory employees={employees} organizations={organizations} query={query} onSelect={setSelectedEmployeeId} onAdd={() => setEmployeeModalOpen(true)} />}
        {!employeesLoading && active === "organization" && <OrganizationManagement onSelectEmployee={setSelectedEmployeeId} organizations={organizations} employees={employees} ranks={ranks} jobTitles={jobTitles} onLeaderChange={updateOrganizationLeader} onAddOrganization={addOrganization} onUpdateOrganization={updateOrganization} onAddRank={addRank} onRemoveRank={removeRank} onAddJobTitle={addJobTitle} onRemoveJobTitle={removeJobTitle} />}
        {active === "payroll" && (selectedPayrollMonth ? <PayrollMonthDetail month={selectedPayrollMonth} onBack={() => setSelectedPayrollMonth(null)} /> : <PayrollOverview onSelectMonth={setSelectedPayrollMonth} />)}
        {active === "requisitions" && <RecruitmentRequisitionView onNotify={showToast} />}
        {active === "recruitment" && <RecruitmentView applicants={applicants} recruiters={recruiters} requisitions={requisitions} query={query} onAdd={() => setApplicantModalOpen(true)} onSelect={setSelectedApplicantId} onOwnerChange={assignRecruiter} onDelete={deleteApplicant} onRequisitionChange={(applicant, requisitionId) => updateApplicantDetail({ ...applicant, requisitionId })} />}
        {!employeesLoading && active === "recruiters" && <RecruiterManagement employees={employees} recruiterIds={recruiterIds} onAdd={addRecruiter} onRemove={removeRecruiter} />}
        {active === "onboarding" && <LifecycleManagementView jobTitles={jobTitles} ranks={ranks} onSelectApplicant={setSelectedApplicantId} applicantPopupOpen={Boolean(selectedApplicantId)} />}
        {active === "leave" && <LeaveManagementView onNotify={showToast} />}
        {active === "workforce" && <WorkforcePlanningView onNotify={showToast} />}
        {active === "performance" && <PerformanceManagementView onNotify={showToast} />}
        {active === "training" && <TrainingManagementView onNotify={showToast} />}
        {active === "reports" && <HrAnalyticsView onNotify={showToast} />}
        {!employeesLoading && active === "settings" && <SettingsView />}
        {selectedEmployee && legacyPersonnelActions.some((action) => action.employee_id === selectedEmployee.id) && <article className="panel"><div className="table-toolbar"><div><h2>처리 대기 인사발령</h2><span>전자결재 시절에 제출돼 남아 있는 발령입니다. 승인하면 시행일에 인사기록에 반영됩니다.</span></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>구분</th><th>시행일</th><th>사유</th><th>처리</th></tr></thead><tbody>{legacyPersonnelActions.filter((action) => action.employee_id === selectedEmployee.id).map((action) => <tr key={action.id}><td>{action.action_type}</td><td>{action.effective_date}</td><td>{action.reason || "-"}</td><td><div className="row-actions"><button type="button" onClick={() => void decideLegacyPersonnelAction(action, "APPROVED")}>승인</button><button type="button" className="reject-action" onClick={() => void decideLegacyPersonnelAction(action, "REJECTED")}>반려</button></div></td></tr>)}</tbody></table></div></article>}
        {selectedEmployee && <EmployeeDetail key={selectedEmployee.id} employee={selectedEmployee} employees={employees} organizations={organizations} ranks={ranks} jobTitles={jobTitles} onBack={() => setSelectedEmployeeId(null)} onUpdate={updateEmployee} onPersonnelAction={() => setPersonnelAction("인사 발령")} onRetirement={() => setRetirementOpen(true)} onNotify={showToast} />}
      </main>

      {employeeModalOpen && <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={() => setEmployeeModalOpen(false)}><form className="employee-modal" onSubmit={saveEmployee} ><div className="modal-header"><div data-korean-heading><h2>직원 등록</h2></div><button type="button" onClick={() => setEmployeeModalOpen(false)}>×</button></div><div className="form-grid"><label><span>이름 *</span><input required name="name" placeholder="홍길동" /></label><label><span>사번 *</span><input required name="employeeId" placeholder="사번 또는 계정 ID" /></label><label><span>이메일 *</span><input required name="email" type="email" placeholder="name@company.com" /></label><label><span>연락처</span><input name="phone" placeholder="010-0000-0000" /></label><label><span>소속 조직 *</span><select required name="department" defaultValue=""><option value="" disabled>조직 선택</option>{organizations.map((organization) => <option key={organization.id}>{organization.name}</option>)}</select></label><label><span>고용형태 *</span><select required name="type"><option>일반직4.5</option><option>일반직</option><option>계약직</option><option>인턴</option></select></label><label><span>입사일 *</span><input required name="joinDate" type="date" /></label><label><span>직위</span><select name="position">{ranks.map((rank) => <option key={rank}>{rank}</option>)}</select></label><label><span>직무</span><select name="jobTitle">{jobTitles.filter((title) => title !== "조직장").map((title) => <option key={title}>{title}</option>)}</select></label></div><label className="form-note"><span>메모</span><textarea placeholder="입사 준비에 필요한 참고사항을 입력하세요."></textarea></label><div className="modal-actions"><button type="button" onClick={() => setEmployeeModalOpen(false)}>취소</button><button type="submit" className="primary-button">직원 등록</button></div></form></HrModalBackdrop>}

      {applicantModalOpen && <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={() => setApplicantModalOpen(false)}><form className="employee-modal applicant-modal" onSubmit={saveApplicant} >
        <div className="modal-header"><div data-korean-heading><h2>지원자 등록</h2></div><button type="button" onClick={() => setApplicantModalOpen(false)}>×</button></div>
        <div className={`resume-drop ${resumeStatus}`}><label><input type="file" accept=".pdf,.docx,.txt" onChange={(event) => parseResume(event.target.files?.[0])} /><span className="resume-icon">AI</span><div><strong>{resumeStatus === "analyzing" ? "원본 이력서를 AI가 분석하고 있어요" : resumeStatus === "done" ? "이력서 분석 완료" : resumeStatus === "error" ? "이력서 분석 실패" : "원본 이력서를 AI가 바로 분석합니다"}</strong><small>{resumeMessage || "PDF, DOCX, TXT · 파일은 이 브라우저에서 텍스트만 뽑아 보냅니다."}</small></div><em>{resumeStatus === "analyzing" ? "분석 중…" : resumeStatus === "done" || resumeStatus === "error" ? "다시 선택" : "파일 선택"}</em></label>{resumeStatus !== "analyzing" && applicantDraft.resumeText
          ? <div className="resume-rerun"><div><strong>결과가 정확하지 않나요?</strong><small>같은 이력서를 Claude가 한 번 더 분석합니다. 파일을 다시 고를 필요는 없고 1~3분 걸립니다.</small></div><button type="button" onClick={reanalyzeResume}>다시 분석</button></div>
          : null}</div>
        {/* 상세 팝업과 같은 3열 2행. 채용담당자와 지원 경로는 여기서 적지 않기로 해 뺐다 —
            지원 경로는 draft 의 기본값("직접 등록")으로 그대로 저장된다. */}
        <div className="form-grid applicant-fields-grid">
          <label><span>이름 *</span><input required value={applicantDraft.name} onChange={(event) => setApplicantDraft({ ...applicantDraft, name: event.target.value })} /></label>
          <label><span>지원 직무 *</span><input required value={applicantDraft.role} onChange={(event) => setApplicantDraft({ ...applicantDraft, role: event.target.value })} /></label>
          <label><span>이메일 *</span><input required type="email" value={applicantDraft.email} onChange={(event) => setApplicantDraft({ ...applicantDraft, email: event.target.value })} /></label>
          <label><span>연락처</span><input value={applicantDraft.phone} onChange={(event) => setApplicantDraft({ ...applicantDraft, phone: event.target.value })} /></label>
          {/* 입사 전환 때 인사기록카드·근로계약서 서명란으로 그대로 넘어간다. 여기서 비우면 그쪽도 빈칸이다. */}
          <label><span>생년월일</span><input type="date" value={applicantDraft.birth} onChange={(event) => setApplicantDraft({ ...applicantDraft, birth: event.target.value })} /></label>
          <label className="wide"><span>주소</span><input value={applicantDraft.address} onChange={(event) => setApplicantDraft({ ...applicantDraft, address: event.target.value })} placeholder="근로계약서 서명란에 들어갑니다" /></label>
          <label><span>경력</span><input value={applicantDraft.experience} onChange={(event) => setApplicantDraft({ ...applicantDraft, experience: event.target.value })} /></label>
          <label><span>채용요청·TO</span><select value={applicantDraft.requisitionId} onChange={(event) => setApplicantDraft({ ...applicantDraft, requisitionId: event.target.value })}><option value="">예외·직접 등록</option>{requisitions.filter((item) => item.status === "OPEN").map((item) => <option key={item.id} value={item.id}>{item.title} · {item.role}</option>)}</select></label>
        </div>
        {/* 경력과 이력서 요약은 이력서를 올리면 Claude 분석 결과로 함께 채워진다. */}
        <label className="form-note"><span>경력</span><textarea value={applicantDraft.careerSummary} onChange={(event) => setApplicantDraft({ ...applicantDraft, careerSummary: event.target.value })} placeholder="이력서를 올리면 근무처와 수행 업무가 자동으로 채워집니다." /></label>
        <label className="form-note"><span>이력서 요약</span><textarea value={applicantDraft.summary} onChange={(event) => setApplicantDraft({ ...applicantDraft, summary: event.target.value })} placeholder="주요 경력과 역량을 입력하세요." /></label>
        <div className="modal-actions"><button type="button" onClick={() => setApplicantModalOpen(false)}>취소</button><button type="submit" className="primary-button">지원자 등록</button></div>
      </form></HrModalBackdrop>}

      {selectedApplicant && <ApplicantDetail applicant={selectedApplicant} recruiters={recruiters} requisitions={requisitions} organizations={organizations} jobTitles={jobTitles} ranks={ranks} onClose={() => setSelectedApplicantId(null)} onSave={updateApplicantDetail} onDecideScreening={decideScreening} onSaveMemo={addInterviewMemo} onSubmitOffer={submitRecruitmentOffer} onRejectInterview={rejectAfterInterview} onRespondOffer={respondRecruitmentOffer} />}
      {personnelAction && selectedEmployee && <PersonnelActionModal employee={selectedEmployee} ranks={ranks} organizations={organizations} onClose={() => setPersonnelAction(null)} onSubmit={savePersonnelAction} />}
      {retirementOpen && selectedEmployee && <RetirementModal employee={selectedEmployee} initial={retirementPrefill} onClose={() => { setRetirementOpen(false); setRetirementPrefill(null); }} onSubmit={saveRetirement} onLegacyDecision={(decision) => void decideLegacyRetirement(decision)} />}
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </div>
  );
}

function EmployeeDirectory({ employees, organizations, query, onSelect, onAdd }: { employees: Employee[]; organizations: Organization[]; query: string; onSelect: (id: string) => void; onAdd: () => void }) {
  const departments = organizations.map((organization) => organization.name);
  const [expanded, setExpanded] = useState<string[]>(departments);
  const [exporting, setExporting] = useState(false);
  const currentEmployees = employees.filter(isCurrentEmployee);
  const visibleEmployees = query ? currentEmployees.filter((employee) => Object.values(employee).some((value) => typeof value === "string" && value.toLowerCase().includes(query.toLowerCase()))) : currentEmployees;
  const thisMonthPrefix = useKoreanToday().slice(0, 7).replace("-", ".");
  const hiresThisMonth = currentEmployees.filter((employee) => employee.joinDate.startsWith(thisMonthPrefix)).length;
  const incompleteProfiles = currentEmployees.filter((employee) => [employee.email, employee.phone, employee.birth, employee.address].some((value) => !value || value === "미입력")).length;
  const toggle = (department: string) => setExpanded((value) => value.includes(department) ? value.filter((item) => item !== department) : [...value, department]);

  async function downloadEmployeeWorkbook() {
    setExporting(true);
    try {
      const { default: writeXlsxFile } = await import("write-excel-file/browser");
      const header = ["이름", "사번/ID", "생년월일", "이메일", "연락처", "주소", "소속 조직", "조직장", "직위", "직무", "고용형태", "입사일", "재직상태"];
      const sortedEmployees = departments.flatMap((department) => {
        const organization = organizations.find((item) => item.name === department);
        return currentEmployees
          .filter((employee) => employee.department === department)
          .sort((first, second) => {
            const leaderOrder = Number(second.id === organization?.leaderEmployeeId) - Number(first.id === organization?.leaderEmployeeId);
            return leaderOrder || first.joinDate.localeCompare(second.joinDate) || first.name.localeCompare(second.name, "ko");
          });
      });
      const rows = sortedEmployees.map((employee) => {
        const organization = organizations.find((item) => item.name === employee.department);
        const isLeader = employee.id === organization?.leaderEmployeeId;
        const leader = employees.find((item) => item.id === organization?.leaderEmployeeId);
        return [employee.name, employee.id, employee.birth, employee.email, employee.phone, employee.address, employee.department, isLeader ? "" : leader?.name ?? "미지정", employee.position, isLeader ? "조직장" : employee.jobTitle, employee.type, employee.joinDate, employee.status];
      });
      const writer = writeXlsxFile([
        header.map((value) => ({ value, fontWeight: "bold" as const, backgroundColor: "#18181B", color: "#FFFFFF" })),
        ...rows,
      ], {
        sheet: "인사기록",
        columns: [18, 18, 14, 28, 18, 36, 18, 16, 12, 18, 14, 14, 12].map((width) => ({ width })),
        showGridLines: true,
      }, { fontFamily: "맑은 고딕", fontSize: 10 });
      await writer.toFile(`XDNODE_인사기록_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } finally {
      setExporting(false);
    }
  }

  return <div className="page-wrap module-page">
    <section className="module-hero"><div data-korean-heading><h1>인사기록카드</h1><p>전체 구성원을 부서별로 확인하고 개인 인사기록을 관리합니다.</p></div><div className="employee-directory-actions"><button type="button" className="outline-button" disabled={exporting} onClick={downloadEmployeeWorkbook}>{exporting ? "엑셀 생성 중…" : "엑셀로 다운 받기"}</button><button type="button" className="primary-button" onClick={onAdd}>+ 직원 등록</button></div></section>
    <section className="metric-grid module-metrics">
      {[{ label: "전체 재직자", value: `${currentEmployees.length}명`, note: "하이웍스 원본 기준" }, { label: "조직", value: `${organizations.length}개`, note: "소속 미지정 포함", tone: "blue" }, { label: "이번 달 입사", value: `${hiresThisMonth}명`, note: `${thisMonthPrefix} 입사`, tone: "green" }, { label: "정보 확인 필요", value: `${incompleteProfiles}명`, note: "필수항목 미입력", tone: "red" }].map((metric) => <div className="compact-metric" key={metric.label}><span className={`metric-accent ${metric.tone ?? "navy"}`}></span><p>{metric.label}</p><h2>{metric.value}</h2><small>{metric.note}</small></div>)}
    </section>
    <div className="directory-toolbar"><div><h2>전체 현황</h2><span>총 {currentEmployees.length}명 · 부서별 접기/펼치기</span></div><div><button type="button" onClick={() => setExpanded(departments)}>모두 펼치기</button><button type="button" onClick={() => setExpanded([])}>모두 접기</button></div></div>
    <div className="department-list">
      {departments.map((department) => {
        const organization = organizations.find((item) => item.name === department);
        const people = visibleEmployees
          .filter((employee) => employee.department === department)
          .sort((first, second) => {
            const leaderOrder = Number(second.id === organization?.leaderEmployeeId) - Number(first.id === organization?.leaderEmployeeId);
            return leaderOrder || first.joinDate.localeCompare(second.joinDate) || first.name.localeCompare(second.name, "ko");
          });
        const leader = currentEmployees.find((employee) => employee.id === organization?.leaderEmployeeId);
        if (query && people.length === 0) return null;
        return <section className="panel department-panel" key={department}>
          <button type="button" className="department-heading" onClick={() => toggle(department)} aria-expanded={expanded.includes(department)}><span className={`chevron ${expanded.includes(department) ? "open" : ""}`}>›</span><div><strong>{department}</strong><small>재직 {people.length}명 · 실제 등록 인원</small></div><span className="dept-progress"><i style={{ width: "100%" }}></i></span><em>{expanded.includes(department) ? "접기" : "펼치기"}</em></button>
          {expanded.includes(department) && <div className="data-table-wrap"><table className="data-table employee-table"><thead><tr><th>직원</th><th>사번/ID</th><th className="employee-birth-column">생년월일</th><th className="employee-phone-column">연락처</th><th>직위</th><th>직무</th><th>고용형태</th><th>입사일</th><th>조직장</th><th>상태</th></tr></thead><tbody>{people.map((employee) => {
            const isLeader = employee.id === organization?.leaderEmployeeId;
            return <tr key={employee.id} className={isLeader ? "organization-leader-row" : ""}><td><button type="button" className="name-link" onClick={() => onSelect(employee.id)}><span>{employee.name.slice(0, 1)}</span>{employee.name}{isLeader && <em className="organization-leader-badge">조직장</em>}</button></td><td>{employee.id}</td><td className="employee-birth-column">{employee.birth || "미입력"}</td><td className="employee-phone-column">{employee.phone || "미입력"}</td><td>{employee.position}</td><td>{isLeader ? "조직장" : employee.jobTitle ?? "팀원"}</td><td>{employee.type}</td><td>{employee.joinDate}</td><td>{isLeader ? "" : leader?.name ?? "미지정"}</td><td><StatusPill value={employee.status} /></td></tr>;
          })}</tbody></table></div>}
        </section>;
      })}
    </div>
  </div>;
}

function OrganizationManagement({ onSelectEmployee, organizations, employees, ranks, jobTitles, onLeaderChange, onAddOrganization, onUpdateOrganization, onAddRank, onRemoveRank, onAddJobTitle, onRemoveJobTitle }: { onSelectEmployee: (id: string) => void; organizations: Organization[]; employees: Employee[]; ranks: string[]; jobTitles: string[]; onLeaderChange: (organizationId: string, employeeId: string) => void; onAddOrganization: (name: string, description: string) => void; onUpdateOrganization: (organizationId: string, name: string, description: string) => Promise<boolean>; onAddRank: (value: string) => void; onRemoveRank: (value: string) => void; onAddJobTitle: (value: string) => void; onRemoveJobTitle: (value: string) => void }) {
  const [newOrganization, setNewOrganization] = useState({ name: "", description: "" });
  const [newRank, setNewRank] = useState("");
  const [newJobTitle, setNewJobTitle] = useState("");
  return <div className="page-wrap module-page organization-page">
    <section className="module-hero"><div data-korean-heading><h1>조직관리</h1><p>조직 구성과 조직장, 직위 및 직무 기준을 한 곳에서 관리합니다.</p></div></section>
    <section className="metric-grid module-metrics">{[
      { label: "운영 조직", value: `${organizations.length}개`, note: "인사기록과 연동" },
      { label: "조직장 지정", value: `${organizations.filter((organization) => organization.leaderEmployeeId).length}명`, note: `미지정 ${organizations.filter((organization) => !organization.leaderEmployeeId).length}개`, tone: "blue" },
      { label: "직위 체계", value: `${ranks.length}단계`, note: "승진·강등 기준", tone: "green" },
      { label: "직무", value: `${jobTitles.length}개`, note: "인사기록카드·처우 제안 공통", tone: "orange" },
    ].map((metric) => <div className="compact-metric" key={metric.label}><span className={`metric-accent ${metric.tone ?? "navy"}`}></span><p>{metric.label}</p><h2>{metric.value}</h2><small>{metric.note}</small></div>)}</section>
    <div className="organization-layout">
      <section className="panel organization-list-panel">
        <div className="table-toolbar"><div><h2>회사 조직 구성</h2><span>조직장을 지정하면 인사기록카드에 즉시 반영됩니다.</span></div></div>
        <div className="organization-list">{organizations.map((organization) => {
          const members = employees.filter((employee) => isCurrentEmployee(employee) && employee.department === organization.name);
          return <OrganizationCard onSelectEmployee={onSelectEmployee} key={organization.id} organization={organization} members={members} onLeaderChange={onLeaderChange} onUpdate={onUpdateOrganization} />;
        })}</div>
        <form className="organization-add-form" onSubmit={(event) => { event.preventDefault(); onAddOrganization(newOrganization.name, newOrganization.description); setNewOrganization({ name: "", description: "" }); }}><div><label><span>새 조직명</span><input required value={newOrganization.name} onChange={(event) => setNewOrganization({ ...newOrganization, name: event.target.value })} placeholder="예: 사업전략팀" /></label><label><span>조직 설명</span><input value={newOrganization.description} onChange={(event) => setNewOrganization({ ...newOrganization, description: event.target.value })} placeholder="조직의 주요 역할" /></label></div><button type="submit" className="primary-button">+ 조직 추가</button></form>
      </section>
      <aside className="organization-catalogs">
        <CatalogManager title="직위 관리" description="인사기록카드·처우 확정·입사 정보 수정에서 고르는 직위입니다. 추가·삭제는 서버에 저장됩니다." items={ranks} value={newRank} onValue={setNewRank} onAdd={() => { onAddRank(newRank); setNewRank(""); }} onRemove={onRemoveRank} placeholder="새 직위" />
        <CatalogManager title="직무 관리" description="인사기록카드·처우 제안·입사 정보 수정에서 고르는 직무 목록입니다. 추가·삭제는 서버에 저장됩니다." items={jobTitles} value={newJobTitle} onValue={setNewJobTitle} onAdd={() => { onAddJobTitle(newJobTitle); setNewJobTitle(""); }} onRemove={onRemoveJobTitle} placeholder="새 직무" />
      </aside>
    </div>
  </div>;
}

function OrganizationCard({ onSelectEmployee, organization, members, onLeaderChange, onUpdate }: { onSelectEmployee: (id: string) => void; organization: Organization; members: Employee[]; onLeaderChange: (organizationId: string, employeeId: string) => void; onUpdate: (organizationId: string, name: string, description: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: organization.name, description: organization.description });
  const [saving, setSaving] = useState(false);
  const sortedMembers = [...members].sort((first, second) => Number(second.id === organization.leaderEmployeeId) - Number(first.id === organization.leaderEmployeeId));
  const memberColumns = members.length <= 1 ? 1 : members.length <= 4 ? 2 : 3;

  function cancelEdit() {
    setDraft({ name: organization.name, description: organization.description });
    setEditing(false);
  }

  async function saveEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      if (await onUpdate(organization.id, draft.name, draft.description)) setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return <article className={`organization-card ${editing ? "editing" : ""}`}>
    {editing ? <form className="organization-edit-form" onSubmit={saveEdit}><div className="organization-edit-heading"><strong>조직 정보 수정</strong><span>조직명 변경 시 소속 인사기록에도 함께 반영됩니다.</span></div><label><span>조직명</span><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span>조직 설명</span><textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label><div className="organization-edit-actions"><button type="button" onClick={cancelEdit}>취소</button><button type="submit" disabled={saving}>{saving ? "저장 중…" : "저장"}</button></div></form> : <><div className="organization-card-heading"><span>{organization.name.slice(0, 1)}</span><div><h3>{organization.name}</h3><p>{organization.description}</p></div><em>{members.length}명</em><button type="button" className="organization-edit-button" onClick={() => setEditing(true)}>조직 수정</button></div><label><span>조직장</span><select value={organization.leaderEmployeeId ?? ""} onChange={(event) => onLeaderChange(organization.id, event.target.value)}><option value="">미지정</option>{members.map((employee) => <option value={employee.id} key={employee.id}>{employee.name} · {employee.position}</option>)}</select></label><div className="organization-members"><div className="organization-members-heading"><strong>소속 조직원</strong><span>{members.length}명</span></div>{members.length > 0 ? <div className={`organization-member-list columns-${memberColumns}`}>{sortedMembers.map((employee) => <button type="button" onClick={() => onSelectEmployee(employee.id)} aria-haspopup="dialog" className={`organization-member ${employee.id === organization.leaderEmployeeId ? "leader" : ""}`} key={employee.id}><span>{employee.name.slice(0, 1)}</span><div><strong>{employee.name}</strong><small>{employee.position} · {employee.id === organization.leaderEmployeeId ? "조직장" : employee.jobTitle ?? "팀원"}</small></div></button>)}</div> : <p className="organization-empty-members">소속 조직원이 없습니다.</p>}</div></>}
  </article>;
}

function CatalogManager({ title, description, items, value, onValue, onAdd, onRemove, placeholder }: { title: string; description: string; items: string[]; value: string; onValue: (value: string) => void; onAdd: () => void; onRemove: (value: string) => void; placeholder: string }) {
  return <section className="panel catalog-panel"><div><h2>{title}</h2><p>{description}</p></div><div className="catalog-list">{items.map((item, index) => <div key={item}><span>{index + 1}</span><strong>{item}</strong><button type="button" onClick={() => onRemove(item)} aria-label={`${item} 삭제`}>×</button></div>)}</div><form onSubmit={(event) => { event.preventDefault(); onAdd(); }}><input value={value} onChange={(event) => onValue(event.target.value)} placeholder={placeholder} /><button type="submit">추가</button></form></section>;
}

function EmployeeDetail({ employee, employees, organizations, ranks, jobTitles, onBack, onUpdate, onPersonnelAction, onRetirement, onNotify }: { employee: Employee; employees: Employee[]; organizations: Organization[]; ranks: string[]; jobTitles: string[]; onBack: () => void; onUpdate: (id: string, patch: Partial<Employee>) => void; onPersonnelAction: () => void; onRetirement: () => void; onNotify: (message: string) => void }) {
  const [selectedDepartment, setSelectedDepartment] = useState(employee.department);
  const [selectedJobTitle, setSelectedJobTitle] = useState(employee.jobTitle ?? "팀원");
  // 내려가면 제목줄을 절반 높이로 접는다. 지원자·급여·퇴직 팝업과 같은 방식이다.
  const [condensed, setCondensed] = useState(false);
  // 근로계약서. 인사기록카드에 없는 값(계약기간·수습 비율·담당업무·작성일)만 이 팝업에서 고르고,
  // 나머지는 저장된 기록에서 채운다. 파일은 브라우저에서 만들어 서버로는 아무것도 보내지 않는다.
  const [contractOpen, setContractOpen] = useState(false);
  const [contractOptions, setContractOptions] = useState<ContractOptions>(() => defaultContractOptions(employee));
  const [contractBusy, setContractBusy] = useState(false);
  const [contractNotice, setContractNotice] = useState("");
  async function downloadContract(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setContractBusy(true);
    setContractNotice("");
    try {
      downloadBlob(await buildEmploymentContract(employee, contractOptions), contractFileName(employee, contractOptions));
      setContractOpen(false);
    } catch (error) {
      setContractNotice(error instanceof Error ? error.message : "근로계약서를 만들지 못했습니다.");
    } finally {
      setContractBusy(false);
    }
  }
  const selectedOrganization = organizations.find((organization) => organization.name === selectedDepartment);
  const isOrganizationLeader = selectedOrganization?.leaderEmployeeId === employee.id;
  const leader = employees.find((person) => person.id === selectedOrganization?.leaderEmployeeId);
  const organizationLeaderName = isOrganizationLeader ? "" : leader?.name ?? "";
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const birth = String(data.get("birth"));
    onUpdate(employee.id, { name: String(data.get("name")).trim(), birth: birth ? birth.replaceAll("-", ".") : "미입력", email: String(data.get("email")), phone: String(data.get("phone")), address: String(data.get("address")), department: selectedDepartment, type: String(data.get("type")), position: String(data.get("position")), jobTitle: isOrganizationLeader ? "조직장" : selectedJobTitle, annualSalary: Number(data.get("annualSalary")) || 0, basePay: Number(data.get("basePay")) || 0, mealAllowance: Number(data.get("mealAllowance")) || 0, childcareAllowance: Number(data.get("childcareAllowance")) || 0, vehicleAllowance: Number(data.get("vehicleAllowance")) || 0, firstTermPayPercent: Math.min(100, Math.max(1, Math.round(Number(data.get("firstTermPayPercent")) || 100))) });
  }
  // 목록을 대체하던 전체 페이지에서 겹쳐 뜨는 팝업으로 바꿨다. 배경을 눌러도 닫히고,
  // 곡률과 왼쪽 스크롤바는 지원자 팝업과 같은 규칙을 공유한다(public/hr-workspace.css).
  return <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onBack(); }}>
    <div
      className={`employee-detail-modal detail-page${condensed ? " condensed" : ""}`}

      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setCondensed((current) => nextCondensed(current, top));
      }}
    >
    {/* 제목줄이 접히면 이름이 적힌 검은 배너가 위로 밀려 올라가 누구의 기록인지 보이지 않는다.
        그래서 접힌 동안에는 제목 옆에 이름을 붙여 둔다. */}
    <div className="modal-header"><div data-korean-heading><h2>인사기록 확인 및 수정{condensed ? ` - ${employee.name}` : ""}</h2></div><button type="button" onClick={onBack} aria-label="닫기">×</button></div>
    <section className="profile-hero panel"><div className="profile-avatar">{employee.name.slice(0, 1)}</div><div className="profile-copy"><p>{employee.id}</p><h1>{employee.name}</h1><div><span>{employee.department}</span><b>·</b><span>{employee.position}</span><b>·</b><StatusPill value={employee.status} /></div></div><div className="profile-actions personnel-actions-stack"><button type="button" className="promote" onClick={onPersonnelAction}>인사 발령</button><button type="button" className="retirement-action" onClick={onRetirement}>퇴직</button></div></section>
    <div className="detail-grid">
      <form className="panel detail-card" onSubmit={submit}><div className="detail-card-heading"><div data-korean-heading><h2>기본정보·급여 기준</h2></div><div className="detail-card-actions"><button type="button" className="outline-button" onClick={() => { setContractOptions(defaultContractOptions(employee)); setContractNotice(""); setContractOpen(true); }}>근로계약서 다운로드</button><button type="submit" className="primary-button">변경사항 저장</button></div></div><div className="detail-form"><label><span>이름</span><input required name="name" defaultValue={employee.name} /></label><label><span>생년월일</span><input name="birth" type="date" defaultValue={employee.birth === "미입력" ? "" : employee.birth.replaceAll(".", "-")} /></label><label><span>이메일</span><input name="email" defaultValue={employee.email} /></label><label><span>연락처</span><input name="phone" defaultValue={employee.phone} /></label><label className="wide"><span>주소</span><input name="address" defaultValue={employee.address} /></label><label><span>고용형태</span><select name="type" defaultValue={employee.type}><option>일반직4.5</option><option>일반직</option><option>계약직</option><option>인턴</option></select></label><label><span>소속 조직</span><select value={selectedDepartment} onChange={(event) => setSelectedDepartment(event.target.value)}>{organizations.map((organization) => <option key={organization.id}>{organization.name}</option>)}</select></label><label><span>조직장</span><input value={organizationLeaderName} disabled placeholder={isOrganizationLeader ? "본인이 조직장인 경우 공란" : "조직장 미지정"} /></label><label><span>직위</span><select name="position" defaultValue={employee.position}>{ranks.map((rank) => <option key={rank}>{rank}</option>)}</select></label><label><span>직무</span><select name="jobTitle" value={isOrganizationLeader ? "조직장" : selectedJobTitle} disabled={isOrganizationLeader} onChange={(event) => setSelectedJobTitle(event.target.value)}>{jobTitles.map((title) => <option key={title}>{title}</option>)}</select></label><label><span>입사일</span><input value={employee.joinDate} disabled /></label><label htmlFor={`employee-${employee.id}-annualSalary`}><span>연봉 · 1원 단위</span><WonInput id={`employee-${employee.id}-annualSalary`} name="annualSalary" ariaLabel="연봉" defaultValue={employee.annualSalary ?? 0} /></label><label htmlFor={`employee-${employee.id}-basePay`}><span>기본급 · 1원 단위</span><WonInput id={`employee-${employee.id}-basePay`} name="basePay" ariaLabel="기본급" defaultValue={employee.basePay ?? 0} /></label><label htmlFor={`employee-${employee.id}-mealAllowance`}><span>식대 · 1원 단위</span><WonInput id={`employee-${employee.id}-mealAllowance`} name="mealAllowance" ariaLabel="식대" defaultValue={employee.mealAllowance ?? 0} /></label><label htmlFor={`employee-${employee.id}-childcareAllowance`}><span>육아수당 · 1원 단위</span><WonInput id={`employee-${employee.id}-childcareAllowance`} name="childcareAllowance" ariaLabel="육아수당" defaultValue={employee.childcareAllowance ?? 0} /></label><label htmlFor={`employee-${employee.id}-vehicleAllowance`}><span>자가운전수당 · 1원 단위</span><WonInput id={`employee-${employee.id}-vehicleAllowance`} name="vehicleAllowance" ariaLabel="자가운전수당" defaultValue={employee.vehicleAllowance ?? 0} /></label><label><span>첫 계약 지급률(%)</span><input name="firstTermPayPercent" type="number" min="1" max="100" step="1" defaultValue={employee.firstTermPayPercent ?? 100} /></label></div></form>
      <aside className="panel detail-card history-card"><div className="detail-card-heading"><div data-korean-heading><h2>인사이력</h2></div><span>{employee.history.length}건</span></div><div className="history-list">{employee.history.map((item, index) => <div className="history-item" key={`${item.date}-${index}`}><span></span><div><strong>{item.type}</strong><p>{item.detail}</p><small>{item.date}</small></div></div>)}</div></aside>
    </div>
    <EmployeeInterviewLog key={employee.id} employee={employee} />
    <LeaveLedgerPanel employeeId={employee.id} onNotify={onNotify} />
    {/* 근로계약서 작성. 미리보기는 실제 파일에 들어가는 값과 같은 표(contractTokens)를 쓴다 —
        보여 준 값과 내려받은 값이 다르면 안 된다. 이 팝업은 인사기록 팝업 위에 겹쳐 뜨므로
        mousedown 전파를 끊어 바깥 팝업이 함께 닫히지 않게 한다. */}
    {contractOpen && (() => {
      const preview = contractTokens(employee, contractOptions);
      // 첫 계약은 사람마다 지급률이 다르다. 최저임금에 못 미치면 계약 자체가 위법이라 내려받기를 막는다.
      const pay = contractPay(employee, contractOptions);
      const missing = ([["생년월일", employee.birth], ["주소", employee.address], ["연락처", employee.phone]] as const)
        .filter(([, value]) => !value || value === "미입력").map(([label]) => label);
      return <HrModalBackdrop className="modal-backdrop" role="presentation" >
        <form className="employee-modal contract-modal" onSubmit={(event) => void downloadContract(event)} >
          <div className="modal-header"><div data-korean-heading><h2>{employee.name} 근로계약서 작성</h2></div><button type="button" aria-label="닫기" onClick={() => setContractOpen(false)}>×</button></div>
          <p className="optional-form-notice">저장된 인사기록의 기본정보·급여 기준으로 회사 양식(26년 근로계약서)을 채웁니다. 방금 고친 값이 있으면 먼저 「변경사항 저장」을 누르세요.</p>
          <div className="form-grid">
            {/* 계약 종류를 바꾸면 시작일 기본값(입사일 / 첫 계약 다음 날)만 다시 잡고, 손으로 적은 담당업무·작성일은 남긴다. */}
            <label className="wide"><span>계약 종류 *</span><select value={contractOptions.kind} onChange={(event) => setContractOptions({ ...defaultContractOptions(employee, event.target.value as ContractKind), duty: contractOptions.duty, contractDate: contractOptions.contractDate })}>{(Object.keys(contractKindLabels) as ContractKind[]).map((kind) => <option key={kind} value={kind}>{contractKindLabels[kind]}</option>)}</select></label>
            <label><span>계약 시작일 *</span><input required type="date" value={contractOptions.startDate} onChange={(event) => setContractOptions({ ...contractOptions, startDate: event.target.value })} /></label>
            {contractOptions.kind === "FIXED_TERM"
              ? <label><span>계약 종료일 (자동, 3개월)</span><input readOnly value={fixedTermEndDate(contractOptions.startDate) || "시작일을 먼저 고르세요"} /></label>
              : <label><span>최초 입사일 (기산일)</span><input readOnly value={employee.joinDate} /></label>}
            <label><span>계약서 작성일 *</span><input required type="date" value={contractOptions.contractDate} onChange={(event) => setContractOptions({ ...contractOptions, contractDate: event.target.value })} /></label>
            {contractOptions.kind === "FIXED_TERM" && <label><span>첫 계약 지급률(%) · 인사기록카드 기준</span><input readOnly value={contractOptions.firstTermPayPercent} title="인사기록카드의 「첫 계약 지급률」에서 고친 뒤 저장하세요." /></label>}
            <label className={contractOptions.kind === "FIXED_TERM" ? "" : "wide"}><span>담당업무 *</span><input required value={contractOptions.duty} onChange={(event) => setContractOptions({ ...contractOptions, duty: event.target.value })} placeholder="예: 구매·물류 관리" /></label>
          </div>
          <small className="contract-hint">{contractOptions.kind === "FIXED_TERM"
            ? "첫 계약은 회사 기준에 따라 3개월 기간제입니다. 종료일은 시작일부터 3개월로 자동 계산되고, 제7조에는 기준 연봉과 이 기간의 지급률이 함께 적힙니다. 지급률은 인사기록카드에 저장된 값을 쓰며, 낮추면 식대·수당은 그대로 두고 기본급으로 맞춥니다."
            : "근무평가를 거쳐 맺는 기간의 정함이 없는 계약입니다. 연차·퇴직급여 기산일은 최초 입사일로 적힙니다."}</small>
          <div className="contract-preview">
            <div><span>계약기간</span><strong>{`${preview.시작년}.${preview.시작월}.${preview.시작일}`} ~ {contractOptions.kind === "FIXED_TERM" ? `${preview.종료년}.${preview.종료월}.${preview.종료일}` : "기간의 정함 없음"}</strong></div>
            <div><span>소속 / 직위</span><strong>{preview.소속직위}</strong></div>
            <div><span>{contractOptions.kind === "FIXED_TERM" ? "기준 연봉" : "연봉"}</span><strong>{preview.연봉}원</strong></div>
            {contractOptions.kind === "FIXED_TERM" && <div><span>계약기간 지급률</span><strong>{preview.지급비율.trim() ? `${preview.지급비율}% · 월 ${preview.월합계}원` : "미입력"}</strong></div>}
            <div><span>월 기본급</span><strong>{preview.기본급}원</strong></div>
            <div><span>시급(÷182.5H)</span><strong>{preview.시급}원</strong></div>
            <div><span>식대</span><strong>{preview.식대}원</strong></div>
            <div><span>자가운전보조금</span><strong>{preview.자가운전}원</strong></div>
            <div><span>육아수당</span><strong>{preview.육아수당}원</strong></div>
            <div><span>월 임금 합계</span><strong>{preview.월합계}원</strong></div>
          </div>
          {pay.problem && <p className="contract-warning">{pay.problem}</p>}
          {missing.length > 0 && <p className="contract-warning">{missing.join("·")}이(가) 인사기록에 없어 계약서에도 빈칸으로 남습니다.</p>}
          {contractNotice && <p className="contract-warning">{contractNotice}</p>}
          <div className="modal-actions"><button type="button" onClick={() => setContractOpen(false)}>취소</button><button type="submit" className="primary-button" disabled={contractBusy || Boolean(pay.problem)}>{contractBusy ? "만드는 중…" : "근로계약서 다운로드"}</button></div>
        </form>
      </HrModalBackdrop>;
    })()}
    </div>
  </HrModalBackdrop>;
}

type PermissionsPolicyLike = {
  allowsFeature?: (feature: string) => boolean;
};

function microphoneErrorMessage(error: unknown) {
  const errorName = typeof error === "object" && error && "name" in error
    ? String((error as { name?: unknown }).name ?? "")
    : "";
  const policy = (document as Document & {
    permissionsPolicy?: PermissionsPolicyLike;
    featurePolicy?: PermissionsPolicyLike;
  }).permissionsPolicy ?? (document as Document & { featurePolicy?: PermissionsPolicyLike }).featurePolicy;
  const policyBlocked = policy?.allowsFeature?.("microphone") === false;

  if (policyBlocked || errorName === "SecurityError") {
    return "현재 페이지의 보안 정책이 마이크 사용을 차단했습니다. 이 ERP 주소를 Chrome의 새 탭에서 직접 연 뒤 다시 시도해 주세요.";
  }
  if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
    return "Chrome의 마이크 권한이 차단되었습니다. 주소창 왼쪽의 사이트 설정에서 마이크를 허용한 뒤 페이지를 새로고침해 주세요.";
  }
  if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
    return "사용 가능한 마이크를 찾지 못했습니다. Windows 입력 장치가 연결되어 있고 기본 마이크로 선택되어 있는지 확인해 주세요.";
  }
  if (errorName === "NotReadableError" || errorName === "TrackStartError") {
    return "마이크 장치를 시작하지 못했습니다. Teams·Zoom·녹음기처럼 마이크를 사용 중인 앱을 닫고 Windows의 마이크 접근 허용을 확인해 주세요.";
  }
  if (errorName === "OverconstrainedError" || errorName === "ConstraintNotSatisfiedError") {
    return "현재 마이크 설정을 사용할 수 없습니다. Windows에서 다른 입력 장치를 기본 마이크로 선택한 뒤 다시 시도해 주세요.";
  }
  if (errorName === "AbortError") {
    return "마이크 시작이 중단되었습니다. 잠시 후 다시 시도하거나 Chrome을 새로고침해 주세요.";
  }
  if (errorName === "InvalidStateError") {
    return "현재 페이지가 활성 상태가 아닙니다. 이 탭을 선택한 상태에서 녹음을 다시 시작해 주세요.";
  }
  return `마이크를 시작하지 못했습니다${errorName ? ` (${errorName})` : ""}. Windows와 Chrome의 마이크 설정을 확인해 주세요.`;
}

async function requestMicrophoneStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    const name = typeof error === "object" && error && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
    if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw error;
  }
}

function createAudioRecorder(stream: MediaStream) {
  const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
    .find((type) => MediaRecorder.isTypeSupported(type));
  if (!preferredType) return new MediaRecorder(stream);
  try {
    return new MediaRecorder(stream, { mimeType: preferredType });
  } catch {
    return new MediaRecorder(stream);
  }
}

function EmployeeInterviewLog({ employee }: { employee: Employee }) {
  const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [records, setRecords] = useState<EmployeeInterviewRecord[]>([]);
  const [interviewAt, setInterviewAt] = useState(nowLocal);
  const [transcript, setTranscript] = useState("");
  const [memo, setMemo] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recognizedTextRef = useRef("");
  // http LAN(비보안 컨텍스트)에서는 getUserMedia 가 없다(Design §5.6). 이 화면은 섀도 루트 포털 안이라 마운트 뒤에만 그려진다.
  const [insecureContext] = useState(() => !secureContextAvailable());

  useEffect(() => {
    let active = true;
    fetch(`/api/hr/interviews?employeeId=${encodeURIComponent(employee.id)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("면담 기록을 불러오지 못했습니다.");
        return response.json() as Promise<{ records: EmployeeInterviewRecord[] }>;
      })
      .then((data) => { if (active) setRecords(data.records); })
      .catch((error: Error) => { if (active) setMessage(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [employee.id]);

  useEffect(() => () => {
    if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, [audioPreviewUrl]);

  async function startRecording() {
    setMessage("");
    if (!consentConfirmed) { setMessage("녹음 당사자의 동의를 확인한 뒤 녹음을 시작해 주세요."); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMessage("이 브라우저에서는 음성 녹음을 지원하지 않습니다. 전사문과 메모를 직접 입력해 주세요.");
      return;
    }
    try {
      const stream = await requestMicrophoneStream();
      streamRef.current = stream;
      chunksRef.current = [];
      recognizedTextRef.current = transcript.trim();
      const recorder = createAudioRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
        setAudioBlob(blob);
        setAudioPreviewUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((track) => track.stop());
      };

      const speechWindow = window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
      const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
      if (Recognition) {
        const recognition = new Recognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "ko-KR";
        recognition.onresult = (event) => {
          let interim = "";
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index];
            const text = result[0].transcript.trim();
            if (result.isFinal) recognizedTextRef.current = `${recognizedTextRef.current} ${text}`.trim();
            else interim = `${interim} ${text}`.trim();
          }
          setTranscript(`${recognizedTextRef.current} ${interim}`.trim());
        };
        recognition.onerror = () => setMessage("자동 전사가 중단되었습니다. 녹음은 계속되며 전사문을 직접 보완할 수 있습니다.");
        speechRef.current = recognition;
        recognition.start();
      } else {
        setMessage("이 브라우저는 자동 전사를 지원하지 않아 녹음만 진행합니다. 전사문은 직접 입력할 수 있습니다.");
      }

      recorder.start(500);
      setRecording(true);
    } catch (error) {
      console.error("[microphone] employee interview recording failed", error);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setMessage(microphoneErrorMessage(error));
    }
  }

  function stopRecording() {
    speechRef.current?.stop();
    speechRef.current = null;
    if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  async function saveRecord(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!transcript.trim() && !memo.trim() && !audioBlob) {
      setMessage("전사기록, 메모 또는 녹음 중 하나를 입력해 주세요.");
      return;
    }
    setSaving(true);
    setMessage("");
    const form = new FormData();
    form.append("employeeId", employee.id);
    form.append("interviewAt", interviewAt);
    form.append("transcript", transcript);
    form.append("memo", memo);
    form.append("consentConfirmed", String(consentConfirmed));
    if (audioBlob) {
      const extension = audioBlob.type.includes("mp4") ? "m4a" : "webm";
      form.append("audio", new File([audioBlob], `interview-${employee.id}-${Date.now()}.${extension}`, { type: audioBlob.type }));
    }
    try {
      const response = await fetch("/api/hr/interviews", { method: "POST", body: form });
      const data = await response.json() as { record?: EmployeeInterviewRecord; error?: string };
      if (!response.ok || !data.record) throw new Error(data.error || "면담 기록을 저장하지 못했습니다.");
      setRecords((items) => [data.record as EmployeeInterviewRecord, ...items]);
      setInterviewAt(nowLocal());
      setTranscript("");
      setMemo("");
      setAudioBlob(null);
      setConsentConfirmed(false);
      if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
      setAudioPreviewUrl(null);
      setMessage("면담 기록을 저장했습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "면담 기록을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="panel interview-log-card">
    <div className="detail-card-heading"><div data-korean-heading><h2>면담 기록</h2></div><span>{records.length}건</span></div>
    <form className="interview-log-form" onSubmit={saveRecord}>
      <label className="recording-consent"><input type="checkbox" checked={consentConfirmed} disabled={recording} onChange={(event) => setConsentConfirmed(event.target.checked)} /><span>면담 당사자에게 녹음 목적과 보관 사실을 안내하고 동의를 확인했습니다.</span></label>
      <div className="interview-log-top"><label><span>면담일시</span><input required type="datetime-local" value={interviewAt} onChange={(event) => setInterviewAt(event.target.value)} /></label><div className="recording-controls"><span>음성녹음</span><button type="button" className={recording ? "recording" : ""} onClick={recording ? stopRecording : startRecording}>{recording ? "■ 녹음 종료" : "● 녹음 시작"}</button>{insecureContext && <small className="recording-secure-note">면접 녹음은 서버 PC에서만 지원합니다.</small>}{audioPreviewUrl && <InterviewAudio src={audioPreviewUrl} transcript={transcript} label="녹음 미리듣기" />}</div></div>
      <div className="interview-text-grid"><label><span>실시간 전사 초안</span><textarea value={transcript} onChange={(event) => { setTranscript(event.target.value); recognizedTextRef.current = event.target.value; }} placeholder="지원되는 브라우저에서는 녹음 중 초안이 표시됩니다. 저장 후 서버 AI 전사와 사용자 검토본을 별도로 만들 수 있습니다." /></label><label><span>사용자 메모</span><textarea value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="면담 요약, 후속 조치, 확인할 내용을 기록하세요." /></label></div>
      {message && <p className="interview-log-message">{message}</p>}
      <div className="interview-log-actions"><small>녹음 파일과 기록은 이 직원의 인사기록에 안전하게 저장됩니다.</small><button type="submit" className="primary-button" disabled={saving || recording}>{saving ? "저장 중…" : "면담 기록 저장"}</button></div>
    </form>
    <div className="interview-record-list">{loading ? <p className="interview-empty">면담 기록을 불러오는 중입니다.</p> : records.length ? records.map((record) => <article key={record.id}><div><strong>{new Date(record.interviewAt).toLocaleString("ko-KR")}</strong><small>{record.audioFileName ? `음성녹음 포함 · 동의 ${record.consentConfirmed ? "확인" : "기록 없음"}` : "텍스트 기록"}</small></div>{record.audioUrl && <InterviewAudio src={record.audioUrl} transcript={record.transcript} label="면담 녹음" />}<section><span>저장 전사·사용자 기록</span><p>{record.transcript || "전사기록 없음"}</p></section><section><span>사용자 메모</span><p>{record.memo || "메모 없음"}</p></section>{record.audioUrl && <AudioTranscriptionControl entityType="EMPLOYEE_INTERVIEW" entityId={record.id} />}</article>) : <p className="interview-empty">아직 등록된 면담 기록이 없습니다.</p>}</div>
  </section>;
}

type LeaveRequestRow = {
  id: string; employee_id: string; leave_type: string; start_date: string; end_date: string;
  units: number; reason: string; status: string; approver_employee_id: string; decided_at: number | null;
};

type AttendanceRecordRow = {
  id: string; employee_id: string; work_date: string; work_type: string; check_in: string; check_out: string;
  minutes_worked: number; status: string; source_type: string; memo: string; approved_by: string;
};

const leaveTypeLabels: Record<string, string> = { ANNUAL: "연차", HALF_AM: "오전 반차", HALF_PM: "오후 반차", SICK: "병가", FAMILY: "가족돌봄", OTHER: "기타" };
const attendanceTypeLabels: Record<string, string> = { OFFICE: "사무실", REMOTE: "재택", FIELD: "외근", TRIP: "출장", OFF: "비근무" };
const approvalLabels: Record<string, string> = { PENDING: "승인 대기", APPROVED: "승인", REJECTED: "반려", CANCELLED: "취소", RECORDED: "확인 대기" };

function TimeAndLeaveView({ employees, onNotify }: { employees: Employee[]; onNotify: (message: string) => void }) {
  const activeEmployees = employees.filter((employee) => !["퇴직", "퇴직 예정"].includes(employee.status));
  const today = new Date().toISOString().slice(0, 10);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequestRow[]>([]);
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [leaveDraft, setLeaveDraft] = useState({ employeeId: activeEmployees[0]?.id ?? "", leaveType: "ANNUAL", startDate: today, endDate: today, units: "1", reason: "" });
  const [attendanceDraft, setAttendanceDraft] = useState({ employeeId: activeEmployees[0]?.id ?? "", workDate: today, workType: "OFFICE", checkIn: "09:00", checkOut: "18:00", memo: "" });

  async function load() {
    try {
      const response = await fetch("/api/hr/operations");
      const payload = await response.json() as { leaveRequests?: LeaveRequestRow[]; attendanceRecords?: AttendanceRecordRow[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "근태·휴가 자료를 불러오지 못했습니다.");
      setLeaveRequests(payload.leaveRequests ?? []);
      setAttendanceRecords(payload.attendanceRecords ?? []);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "근태·휴가 자료를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  const employeeName = (id: string) => employees.find((employee) => employee.id === id)?.name ?? id;
  const pendingLeaves = leaveRequests.filter((item) => item.status === "PENDING");
  const approvedUnits = leaveRequests.filter((item) => item.status === "APPROVED" && item.start_date.startsWith(today.slice(0, 4))).reduce((sum, item) => sum + item.units, 0);
  const todayAttendance = attendanceRecords.filter((item) => item.work_date === today && item.status !== "REJECTED");
  const pendingAttendance = attendanceRecords.filter((item) => item.status === "RECORDED");

  async function createLeave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const units = Math.round(Number(leaveDraft.units) * 100);
    const response = await fetch("/api/hr/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: "leaveRequest", ...leaveDraft, units }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { onNotify(payload.error || "휴가 신청을 저장하지 못했습니다."); return; }
    onNotify("휴가 신청을 승인된 상태로 저장했습니다.");
    setLeaveDraft((current) => ({ ...current, reason: "" }));
    await load();
  }

  async function createAttendance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/hr/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: "attendance", ...attendanceDraft }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { onNotify(payload.error || "근태 기록을 저장하지 못했습니다."); return; }
    onNotify("근태 기록을 저장했습니다.");
    setAttendanceDraft((current) => ({ ...current, memo: "" }));
    await load();
  }

  async function decide(resource: "leaveRequest" | "attendance", id: string, status: string) {
    const response = await fetch("/api/hr/operations", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource, id, status }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { onNotify(payload.error || "상태를 변경하지 못했습니다."); return; }
    onNotify(status === "APPROVED" ? "승인 처리했습니다." : "반려 처리했습니다.");
    await load();
  }

  return <div className="page-wrap module-page time-leave-page">
    <section className="module-hero"><div data-korean-heading><h1>일정·근태·휴가</h1><p>수기 근태와 휴가 신청·승인을 실제 저장합니다. 출입기록 자동연동 전까지 자료 출처는 수기 입력으로 표시됩니다.</p></div><span className="manual-source-badge">MANUAL · 자동연동 미설정</span></section>
    <section className="metric-grid module-metrics">{[
      ["오늘 근태", `${todayAttendance.length}명`, `재직자 ${activeEmployees.length}명 중 기록`],
      ["휴가 승인 대기", `${pendingLeaves.length}건`, "기존 신청 중 미처리"],
      ["올해 승인 휴가", `${(approvedUnits / 100).toFixed(1)}일`, "승인된 신청 합계"],
      ["근태 확인 대기", `${pendingAttendance.length}건`, "수기 입력 검토 필요"],
    ].map(([label, value, note], index) => <div className="compact-metric" key={label}><span className={`metric-accent ${["navy", "orange", "blue", "red"][index]}`}></span><p>{label}</p><h2>{value}</h2><small>{note}</small></div>)}</section>

    <section className="time-leave-entry-grid">
      <form className="panel operations-entry-card" onSubmit={createLeave}><div className="detail-card-heading"><div data-korean-heading><h2>휴가 신청</h2></div><span>저장 즉시 승인</span></div><div className="operations-form-grid"><label><span>대상 직원</span><select required value={leaveDraft.employeeId} onChange={(event) => setLeaveDraft({ ...leaveDraft, employeeId: event.target.value })}>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department}</option>)}</select></label><label><span>휴가 종류</span><select value={leaveDraft.leaveType} onChange={(event) => { const value = event.target.value; setLeaveDraft({ ...leaveDraft, leaveType: value, units: value.startsWith("HALF") ? ".5" : leaveDraft.units }); }}>{Object.entries(leaveTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>시작일</span><input required type="date" value={leaveDraft.startDate} onChange={(event) => setLeaveDraft({ ...leaveDraft, startDate: event.target.value })} /></label><label><span>종료일</span><input required type="date" value={leaveDraft.endDate} onChange={(event) => setLeaveDraft({ ...leaveDraft, endDate: event.target.value })} /></label><label><span>사용일수</span><input required type="number" min=".5" step=".5" value={leaveDraft.units} onChange={(event) => setLeaveDraft({ ...leaveDraft, units: event.target.value })} /></label><label className="wide"><span>사유</span><input value={leaveDraft.reason} onChange={(event) => setLeaveDraft({ ...leaveDraft, reason: event.target.value })} /></label></div><button type="submit" className="primary-button">휴가 신청 저장</button></form>
      <form className="panel operations-entry-card" onSubmit={createAttendance}><div className="detail-card-heading"><div data-korean-heading><h2>근태 기록</h2></div><span>수기 입력</span></div><div className="operations-form-grid"><label><span>대상 직원</span><select required value={attendanceDraft.employeeId} onChange={(event) => setAttendanceDraft({ ...attendanceDraft, employeeId: event.target.value })}>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department}</option>)}</select></label><label><span>근무일</span><input required type="date" value={attendanceDraft.workDate} onChange={(event) => setAttendanceDraft({ ...attendanceDraft, workDate: event.target.value })} /></label><label><span>근무 형태</span><select value={attendanceDraft.workType} onChange={(event) => setAttendanceDraft({ ...attendanceDraft, workType: event.target.value })}>{Object.entries(attendanceTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>출근</span><input type="time" value={attendanceDraft.checkIn} onChange={(event) => setAttendanceDraft({ ...attendanceDraft, checkIn: event.target.value })} /></label><label><span>퇴근</span><input type="time" value={attendanceDraft.checkOut} onChange={(event) => setAttendanceDraft({ ...attendanceDraft, checkOut: event.target.value })} /></label><label className="wide"><span>메모</span><input value={attendanceDraft.memo} onChange={(event) => setAttendanceDraft({ ...attendanceDraft, memo: event.target.value })} /></label></div><button type="submit" className="primary-button">근태 기록 저장</button></form>
    </section>

    <section className="time-leave-tables">
      <article className="panel"><div className="table-toolbar"><div><h2>휴가 신청 현황</h2><span>{leaveRequests.length}건 · 0.5일은 50단위로 안전하게 저장됩니다.</span></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>직원</th><th>종류</th><th>기간</th><th>일수</th><th>사유</th><th>상태</th><th>처리</th></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="table-message">불러오는 중입니다.</td></tr> : leaveRequests.length ? leaveRequests.map((item) => <tr key={item.id}><td>{employeeName(item.employee_id)}</td><td>{leaveTypeLabels[item.leave_type] ?? item.leave_type}</td><td>{item.start_date}~{item.end_date}</td><td>{(item.units / 100).toFixed(1)}일</td><td>{item.reason || "-"}</td><td><StatusPill value={approvalLabels[item.status] ?? item.status} /></td><td>{item.status === "PENDING" ? <div className="row-actions"><button type="button" onClick={() => void decide("leaveRequest", item.id, "APPROVED")}>승인</button><button type="button" className="reject-action" onClick={() => void decide("leaveRequest", item.id, "REJECTED")}>반려</button></div> : "처리 완료"}</td></tr>) : <tr><td colSpan={7} className="empty-cell">등록된 휴가 신청이 없습니다.</td></tr>}</tbody></table></div></article>
      <article className="panel"><div className="table-toolbar"><div><h2>근태 기록 현황</h2><span>{attendanceRecords.length}건 · 출입시스템 연동 전 수기 기록</span></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>직원</th><th>근무일</th><th>형태</th><th>출퇴근</th><th>근무시간</th><th>출처</th><th>상태</th><th>처리</th></tr></thead><tbody>{loading ? <tr><td colSpan={8} className="table-message">불러오는 중입니다.</td></tr> : attendanceRecords.length ? attendanceRecords.map((item) => <tr key={item.id}><td>{employeeName(item.employee_id)}</td><td>{item.work_date}</td><td>{attendanceTypeLabels[item.work_type] ?? item.work_type}</td><td>{item.check_in || "-"}~{item.check_out || "-"}</td><td>{Math.floor(item.minutes_worked / 60)}시간 {item.minutes_worked % 60}분</td><td><span className="manual-source-badge compact">{item.source_type}</span></td><td><StatusPill value={approvalLabels[item.status] ?? item.status} /></td><td>{item.status === "RECORDED" ? <div className="row-actions"><button type="button" onClick={() => void decide("attendance", item.id, "APPROVED")}>확인</button><button type="button" className="reject-action" onClick={() => void decide("attendance", item.id, "REJECTED")}>반려</button></div> : "처리 완료"}</td></tr>) : <tr><td colSpan={8} className="empty-cell">등록된 근태 기록이 없습니다.</td></tr>}</tbody></table></div></article>
    </section>
  </div>;
}

type EmployeeDocument = {
  id: string; module: string; entityType: string; entityId: string; category: string; version: number;
  fileName: string; contentType: string; uploadedBy: string; createdAt: number; downloadUrl: string;
};

// 파일 선택창의 accept 와 같은 목록. 드래그로 넣은 파일도 같은 기준으로 거른다.
const DOCUMENT_FILE_TYPES = [".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg", ".txt", ".csv"];
// 서버(app/api/documents/route.ts)와 같은 상한이다.
const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

const documentCategoryLabels: Record<string, string> = {
  RESUME: "이력서",
  ONBOARDING_SUBMISSION: "입사 제출 서류",
  EMPLOYMENT_CONTRACT: "근로계약서", PERSONNEL_ORDER: "인사발령서", CERTIFICATE: "증명서",
  EVALUATION: "평가서", RETIREMENT: "퇴직서류", CONSENT: "동의서", OTHER: "기타",
};

// 같은 서류를 다시 올려 갱신하는 성격의 분류만 버전을 매긴다. 나머지는 서로 다른 서류가
// 한 분류에 모이므로 v1, v2 라는 번호가 의미를 갖지 않아 "-" 로 둔다.
const VERSIONED_CATEGORIES = new Set(["EMPLOYMENT_CONTRACT", "PERSONNEL_ORDER", "CERTIFICATE"]);

function EmployeeDocumentView({ employees, onNotify }: { employees: Employee[]; onNotify: (message: string) => void }) {
  const dialog = useErpDialog();
  // 재직자와 퇴사자를 나눠 본다. 퇴사자 문서는 보존·발급이 주된 일이라 한 목록에 섞여 있으면 재직자를 찾기 어렵다.
  const [scope, setScope] = useState<"active" | "retired">(() => employees.some(isCurrentEmployee) ? "active" : "retired");
  const [employeeId, setEmployeeId] = useState(() => (employees.find(isCurrentEmployee) ?? employees[0])?.id ?? "");
  const [documents, setDocuments] = useState<EmployeeDocument[]>([]);
  const scopedEmployees = employees.filter((employee) => (scope === "active") === isCurrentEmployee(employee));
  const activeCount = employees.filter(isCurrentEmployee).length;
  function switchScope(next: "active" | "retired") {
    if (next === scope) return;
    setScope(next);
    setEmployeeId(employees.find((employee) => (next === "active") === isCurrentEmployee(employee))?.id ?? "");
  }
  const [category, setCategory] = useState("EMPLOYMENT_CONTRACT");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recategorizing, setRecategorizing] = useState("");
  // 실패 사유를 카드 안에 직접 남긴다. 토스트만으로는 화면을 내려다보고 있으면 놓친다.
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const selectedEmployee = employees.find((employee) => employee.id === employeeId);

  async function load(targetId = employeeId) {
    if (!targetId) { setDocuments([]); setLoading(false); return; }
    setLoading(true);
    try {
      const response = await fetch(`/api/documents?module=hr&entityType=employee&entityId=${encodeURIComponent(targetId)}`);
      const payload = await response.json() as { documents?: EmployeeDocument[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "인사문서를 불러오지 못했습니다.");
      setDocuments(payload.documents ?? []);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "인사문서를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(employeeId); }, [employeeId]);

  // 파일 선택창과 드래그가 같은 검사를 거치게 한다. 서버도 같은 상한을 다시 확인한다.
  function chooseFile(candidate: File | undefined) {
    if (!candidate) return;
    const extension = `.${candidate.name.split(".").pop()?.toLowerCase() ?? ""}`;
    if (!DOCUMENT_FILE_TYPES.includes(extension)) {
      const message = `${DOCUMENT_FILE_TYPES.join(" ")} 형식만 등록할 수 있습니다.`;
      setNotice(message); onNotify(message);
      return;
    }
    if (candidate.size > DOCUMENT_MAX_BYTES) {
      const message = `${candidate.name} 은 ${(candidate.size / 1024 / 1024).toFixed(1)}MB 입니다. 25MB 이하만 등록할 수 있습니다.`;
      setNotice(message); onNotify(message);
      return;
    }
    setNotice("");
    setFile(candidate);
  }

  function dropFiles(event: React.DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length > 1) onNotify("한 번에 한 개만 등록할 수 있어 첫 번째 파일만 사용합니다.");
    chooseFile(dropped[0]);
  }

  // 예전에는 fetch 를 감싸지 않아 네트워크 오류나 JSON 파싱 실패가 그대로 던져졌고,
  // 그러면 버튼을 눌러도 화면에 아무 반응이 남지 않았다. 사유를 반드시 표시한다.
  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!employeeId) { const message = "직원을 먼저 선택해 주세요."; setNotice(message); onNotify(message); return; }
    if (!file) { const message = "등록할 파일을 선택하거나 카드 위로 끌어다 놓아 주세요."; setNotice(message); onNotify(message); return; }
    setSaving(true);
    setNotice("");
    try {
      const form = new FormData();
      form.append("module", "hr"); form.append("entityType", "employee"); form.append("entityId", employeeId);
      form.append("category", category); form.append("file", file, file.name);
      const response = await fetch("/api/documents", { method: "POST", body: form });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        const message = payload.error || `문서를 저장하지 못했습니다 (${response.status}).`;
        setNotice(message); onNotify(message);
        return;
      }
      setFile(null);
      onNotify("인사문서 원본과 새 버전을 저장했습니다.");
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "문서를 저장하지 못했습니다.";
      setNotice(message); onNotify(message);
    } finally {
      setSaving(false);
    }
  }

  // 이미 등록된 문서의 분류를 바꾼다. 서버가 옮겨간 분류 기준으로 버전을 다시 매긴다.
  async function recategorize(target: EmployeeDocument, nextCategory: string) {
    if (!nextCategory || nextCategory === target.category) return;
    setRecategorizing(target.id);
    setNotice("");
    try {
      const response = await fetch("/api/documents", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: target.id, category: nextCategory }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        const message = payload.error || `분류를 바꾸지 못했습니다 (${response.status}).`;
        setNotice(message); onNotify(message);
        return;
      }
      onNotify(`${target.fileName} 분류를 ${documentCategoryLabels[nextCategory] ?? nextCategory}(으)로 옮겼습니다.`);
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "분류를 바꾸지 못했습니다.";
      setNotice(message); onNotify(message);
    } finally {
      setRecategorizing("");
    }
  }

  async function remove(document: EmployeeDocument) {
    if (!(await dialog.confirm(`${document.fileName} 문서를 목록에서 삭제할까요? 원본은 복구를 위해 보존됩니다.`, { title: "문서 삭제", confirmLabel: "삭제", danger: true }))) return;
    const response = await fetch("/api/documents", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: document.id }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { onNotify(payload.error || "문서를 삭제하지 못했습니다."); return; }
    onNotify("문서를 소프트 삭제했습니다.");
    await load();
  }

  const latestByCategory = new Map<string, number>();
  documents.forEach((document) => latestByCategory.set(document.category, Math.max(latestByCategory.get(document.category) ?? 0, document.version)));

  // 분류별로 박스를 나눈다. 목록에 없는 예전 분류가 데이터에 남아 있어도 사라지지 않도록 뒤에 붙인다.
  const categoryOrder = [
    ...Object.keys(documentCategoryLabels),
    ...[...new Set(documents.map((item) => item.category))].filter((value) => !(value in documentCategoryLabels)),
  ];
  const groupedDocuments = categoryOrder
    .map((key) => [key, documents.filter((item) => item.category === key)] as const)
    .filter(([, group]) => group.length > 0);

  return <div className="page-wrap module-page employee-documents-page">
    <section className="module-hero"><div data-korean-heading><h1>인사문서</h1><p>직원별 계약서·발령서·증명서 원본을 버전별로 보관하고 다운로드·삭제 이력을 기록합니다.</p></div><span className="secure-document-badge">PRIVATE · 접근기록 저장</span></section>
    <section className="document-layout">
      <aside className="panel document-employee-list"><div className="detail-card-heading"><div data-korean-heading><h2>직원 선택</h2></div><span>{scopedEmployees.length}명</span></div><div className="document-scope"><button type="button" className={scope === "active" ? "active" : ""} onClick={() => switchScope("active")}>재직자 {activeCount}</button><button type="button" className={scope === "retired" ? "active" : ""} onClick={() => switchScope("retired")}>퇴사자 {employees.length - activeCount}</button></div><div>{scopedEmployees.length ? scopedEmployees.map((employee) => <button type="button" key={employee.id} className={employee.id === employeeId ? "active" : ""} onClick={() => setEmployeeId(employee.id)}><span>{employee.name.slice(0, 1)}</span><p><strong>{employee.name}</strong><small>{scope === "retired" ? `퇴직 ${employee.retirement?.date ?? "일자 미입력"} · ${employee.department}` : `${employee.department} · ${employee.position}`}</small></p></button>) : <p className="document-group-empty">{scope === "retired" ? "퇴사자가 없습니다." : "재직자가 없습니다."}</p>}</div></aside>
      <div className="document-content">
        {scope === "retired" && <p className="document-scope-note">퇴사자 문서입니다. 경력증명서 발급과 분쟁 대비를 위해 보존하며, 필요한 문서는 계속 등록할 수 있습니다.</p>}
        <form
        className={`panel document-upload-card${dragging ? " dragging" : ""}`}
        onSubmit={upload}
        onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={dropFiles}
      ><div className="detail-card-heading"><div data-korean-heading><h2>{selectedEmployee?.name ?? "직원"} 문서 등록</h2></div><span>최대 25MB</span></div><div className="document-upload-fields"><label><span>문서 분류</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{Object.entries(documentCategoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="file-field"><span>원본 파일</span><input type="file" accept={DOCUMENT_FILE_TYPES.join(",")} onChange={(event) => chooseFile(event.target.files?.[0])} /><strong>{file?.name ?? "파일을 선택하거나 이 카드 위로 끌어다 놓으세요."}</strong></label><button type="submit" className="primary-button" disabled={saving}>{saving ? "등록 중…" : "문서 등록"}</button></div>{notice && <p className="document-upload-notice">{notice}</p>}</form>
        {loading ? <section className="panel document-table-card"><div className="table-toolbar"><div><h2>보관 문서</h2><span>불러오는 중</span></div></div><p className="document-group-empty">문서를 불러오는 중입니다.</p></section> : groupedDocuments.length ? groupedDocuments.map(([groupCategory, groupDocuments]) => { const versioned = VERSIONED_CATEGORIES.has(groupCategory); return <section className="panel document-table-card" key={groupCategory}><div className="table-toolbar"><div><h2>{documentCategoryLabels[groupCategory] ?? groupCategory}</h2><span>{groupDocuments.length}건{versioned ? " · 같은 분류를 다시 올리면 버전이 증가합니다." : " · 버전을 매기지 않는 분류입니다."}</span></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>파일명</th><th>분류 변경</th><th>버전</th><th>등록자</th><th>등록일시</th><th>상태</th><th>작업</th></tr></thead><tbody>{groupDocuments.map((document) => <tr key={document.id}><td><a className="document-download-link" href={document.downloadUrl}>{document.fileName}</a></td><td><select className="document-category-select" value={document.category} disabled={recategorizing === document.id} onChange={(event) => void recategorize(document, event.target.value)}>{Object.entries(documentCategoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}{!(document.category in documentCategoryLabels) && <option value={document.category}>{document.category}</option>}</select></td><td>{versioned ? `v${document.version}` : "-"}</td><td>{document.uploadedBy}</td><td>{new Date(document.createdAt).toLocaleString("ko-KR")}</td><td>{versioned ? <StatusPill value={document.version === latestByCategory.get(document.category) ? "최신" : "이전 버전"} /> : "-"}</td><td><div className="row-actions"><a href={document.downloadUrl}>다운로드</a><button type="button" className="reject-action" onClick={() => void remove(document)}>삭제</button></div></td></tr>)}</tbody></table></div></section>; }) : <section className="panel document-table-card"><div className="table-toolbar"><div><h2>보관 문서</h2><span>0건</span></div></div><p className="document-group-empty">등록된 인사문서가 없습니다.</p></section>}
      </div>
    </section>
  </div>;
}

const formatWon = (value: number) => `₩${Math.round(value).toLocaleString("ko-KR")}`;

function payrollMonthLabel(yearMonth: string) {
  const [year, month] = yearMonth.split("-");
  return `${year}년 ${Number(month)}월`;
}

const payrollStatusLabels: Record<PayrollSummary["status"], string> = {
  DRAFT: "작성 중", REVIEW: "검토 중", APPROVED: "승인 완료", LOCKED: "마감 잠금",
};

// 상태 셀렉트에 쓰는 "다음에 할 일" 표현. 위 라벨은 현재 상태를 가리키는 말이라 다르다.
const payrollStatusOptionLabels: Record<PayrollSummary["status"], string> = {
  DRAFT: "작성 중", REVIEW: "검토 요청", APPROVED: "승인", LOCKED: "마감 잠금",
};

// app/api/hr/payroll/route.ts 의 allowedTransitions 와 같은 표를 둔다. 서버가 막을 선택지를
// 열어 두면 눌러도 409 만 돌아와 아무 일도 안 일어난 것처럼 보인다. 작성 중에서 곧바로 마감
// 잠금까지 갈 수 있고, 검토 요청·승인은 필요할 때만 거친다.
const payrollStatusTransitions: Record<PayrollSummary["status"], PayrollSummary["status"][]> = {
  DRAFT: ["DRAFT", "REVIEW", "LOCKED"],
  REVIEW: ["DRAFT", "REVIEW", "APPROVED", "LOCKED"],
  APPROVED: ["DRAFT", "APPROVED", "LOCKED"],
  LOCKED: ["DRAFT", "LOCKED"],
};

/** 급여월 상태 변경 한 곳. 상세 화면의 버튼과 목록의 상태 칸이 같은 규칙(재개방 사유)을 쓴다. 결재 없이 곧바로 반영된다. */
async function requestPayrollStatusChange(dialog: ErpDialogApi, month: string, currentStatus: PayrollSummary["status"], status: PayrollSummary["status"]) {
  let reopenedReason = "";
  if (status === "DRAFT" && ["APPROVED", "LOCKED"].includes(currentStatus)) {
    reopenedReason = (await dialog.prompt("승인·마감된 급여월을 다시 여는 사유를 입력해 주세요.", { title: "급여 재개 사유", placeholder: "예: 공제 항목 정정", multiline: true })) ?? "";
    if (!reopenedReason) return { applied: false, notice: "", error: "급여월 재개방 사유가 필요합니다." };
  }
  const response = await fetch("/api/hr/payroll", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period: month, status, reopenedReason }) });
  const payload = await response.json() as { error?: string };
  if (!response.ok) return { applied: false, notice: "", error: payload.error || "급여 처리 상태를 변경하지 못했습니다." };
  const notice = status === "DRAFT" && reopenedReason ? "급여월을 다시 열었습니다." : "";
  return { applied: true, notice, error: "" };
}

/** 급여월 현황의 상태 칸. 누르면 셀렉트로 바뀌어 검토 요청·마감 잠금을 그 자리에서 고른다.
 *  행을 누르면 상세로 들어가므로 여기서는 클릭·키 입력이 행으로 번지지 않게 막는다. */
function PayrollStatusCell({ summary, busy, onChange }: { summary: PayrollSummary; busy: boolean; onChange: (status: PayrollSummary["status"]) => void }) {
  const [editing, setEditing] = useState(false);
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  if (editing) {
    // eslint-disable-next-line jsx-a11y/no-autofocus -- 칸을 눌러 여는 편집용 select 라 바로 초점을 받아야 한다
    return <select className="applicant-to-select payroll-status-select" autoFocus value={summary.status} aria-label={`${payrollMonthLabel(summary.yearMonth)} 처리 상태 변경`}
      onClick={stop} onMouseDown={stop} onKeyDown={(event) => { stop(event); if (event.key === "Escape") setEditing(false); }} onBlur={() => setEditing(false)}
      onChange={(event) => { const next = event.target.value as PayrollSummary["status"]; setEditing(false); if (next !== summary.status) onChange(next); }}>
      {payrollStatusTransitions[summary.status].map((status) => <option key={status} value={status}>{status === summary.status ? `${payrollStatusLabels[status]} (현재)` : payrollStatusOptionLabels[status]}</option>)}
    </select>;
  }
  return <button type="button" className="payroll-status-button" disabled={busy} title="눌러서 처리 상태 변경" onClick={(event) => { event.stopPropagation(); setEditing(true); }} onKeyDown={stop}>
    <StatusPill value={busy ? "처리 중" : payrollStatusLabels[summary.status]} />
  </button>;
}

function PayrollOverview({ onSelectMonth }: { onSelectMonth: (month: string) => void }) {
  const dialog = useErpDialog();
  const [summaries, setSummaries] = useState<PayrollSummary[]>([]);
  // 상태 칸에서 바로 바꿀 때의 진행 중 급여월과 결과 안내.
  const [busyMonth, setBusyMonth] = useState("");
  const [notice, setNotice] = useState("");
  const [statusError, setStatusError] = useState("");
  async function changeStatus(summary: PayrollSummary, status: PayrollSummary["status"]) {
    setNotice(""); setStatusError(""); setBusyMonth(summary.yearMonth);
    const result = await requestPayrollStatusChange(dialog, summary.yearMonth, summary.status, status);
    setBusyMonth("");
    if (result.error) { setStatusError(`${payrollMonthLabel(summary.yearMonth)}: ${result.error}`); return; }
    if (result.applied) setSummaries((items) => items.map((item) => item.yearMonth === summary.yearMonth ? { ...item, status } : item));
    setNotice(result.notice || `${payrollMonthLabel(summary.yearMonth)} 급여월을 「${payrollStatusLabels[status]}」으로 바꿨습니다.`);
  }
  const [period, setPeriod] = useState<"all" | "2026" | "2025">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/hr/payroll");
        const payload = await response.json() as { summaries?: PayrollSummary[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "급여 기록을 불러오지 못했습니다.");
        if (!cancelled) setSummaries(payload.summaries ?? []);
      } catch (fetchError) {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : "급여 기록을 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const latest = summaries[0];
  const rows = period === "all" ? summaries : summaries.filter((summary) => summary.yearMonth.startsWith(`${period}-`));
  const metrics = [
    { label: "최근 급여월", value: latest ? payrollMonthLabel(latest.yearMonth) : "-", note: "인건비 정리 원본 기준" },
    { label: "급여 대상", value: latest ? `${latest.employeeCount}명` : "-", note: "정규 월별 기록", tone: "blue" },
    { label: "지급총액", value: latest ? formatWon(latest.grossPay) : "-", note: "기본급·수당·인센티브 포함", tone: "orange" },
    { label: "실 지급액", value: latest ? formatWon(latest.netPay) : "-", note: "지급총액 - 원본 공제", tone: "red" },
  ];

  return <div className="page-wrap module-page payroll-page"><section className="module-hero"><div data-korean-heading><h1>급여관리</h1><p>2025~2026년 인건비 자료를 월별로 확인합니다. 세금·4대보험 전체 공제 자료가 아니므로 지급액은 원본 기록 기준입니다.</p></div><span className="payroll-import-badge">20개월 자료 반영</span></section><section className="metric-grid module-metrics">{metrics.map((metric) => <div className="compact-metric" key={metric.label}><span className={`metric-accent ${metric.tone ?? "navy"}`}></span><p>{metric.label}</p><h2>{metric.value}</h2><small>{metric.note}</small></div>)}</section><section className="panel table-panel"><div className="table-toolbar"><div><h2>급여월 현황</h2><span>{period === "all" ? `전체 ${rows.length}개월` : `${period}년 ${rows.length}개월`} · 급여월을 클릭하면 개인별 항목과 원본 메모를 확인할 수 있습니다.</span></div><div className="payroll-year-filter" role="group" aria-label="급여 조회 기간"><button type="button" className={period === "all" ? "active" : ""} onClick={() => setPeriod("all")}>전체 기간</button><button type="button" className={period === "2026" ? "active" : ""} onClick={() => setPeriod("2026")}>2026년</button><button type="button" className={period === "2025" ? "active" : ""} onClick={() => setPeriod("2025")}>2025년</button></div></div>{(notice || statusError) && <p className={`payroll-status-notice${statusError ? " error" : ""}`}>{statusError || notice}</p>}<div className="data-table-wrap"><table className="data-table payroll-table"><thead><tr>{["급여월", "대상 인원", "지급총액", "공제총액", "실 지급액", "상태"].map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={6} className="table-message">급여 기록을 불러오는 중입니다.</td></tr> : error ? <tr><td colSpan={6} className="table-message error">{error}</td></tr> : rows.map((summary) => <tr key={summary.yearMonth} onClick={() => onSelectMonth(summary.yearMonth)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && onSelectMonth(summary.yearMonth)}><td><button type="button" className="month-link">{payrollMonthLabel(summary.yearMonth)}<span>상세 보기 →</span></button></td><td>{summary.employeeCount}명</td><td>{formatWon(summary.grossPay)}</td><td>{formatWon(summary.deductions)}</td><td>{formatWon(summary.netPay)}</td><td className="payroll-status-cell"><PayrollStatusCell summary={summary} busy={busyMonth === summary.yearMonth} onChange={(status) => changeStatus(summary, status)} />{summary.compensationStatus === "DRAFT" && <StatusPill value="수정 중" />}</td></tr>)}</tbody></table></div></section></div>;
}

async function fetchPayrollMonth(month: string) {
  const response = await fetch(`/api/hr/payroll?month=${encodeURIComponent(month)}`);
  const payload = await response.json() as { summary?: PayrollSummary | null; records?: PayrollRecord[]; error?: string };
  if (!response.ok) throw new Error(payload.error || "월별 급여 기록을 불러오지 못했습니다.");
  return { summary: payload.summary ?? null, records: payload.records ?? [] };
}

function PayrollMonthDetail({ month, onBack }: { month: string; onBack: () => void }) {
  const dialog = useErpDialog();
  const [records, setRecords] = useState<PayrollRecord[]>([]);
  const [summary, setSummary] = useState<PayrollSummary | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<PayrollRecord | null>(null);
  // 공제 열 제목을 누르면 각 행 아래에 국민연금·건강보험 같은 항목별 내역이 펼쳐진다.
  const [deductionOpen, setDeductionOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const PAYROLL_DEDUCTION_LOCK_MESSAGE = "승인 또는 마감된 급여월은 공제값을 수정할 수 없습니다. 먼저 작성 중으로 되돌려 주세요.";

  // 팝업에서 고친 지급 항목·항목별 공제·메모를 한 번에 저장한다. 승인·마감된 달이면 서버가 막으므로
  // 잠금을 풀지 물어보고 한 번만 다시 시도한다 (예전 공제값 저장에서 쓰던 흐름 그대로).
  async function submitPayrollRecord(input: PayrollRecordInput) {
    const response = await fetch("/api/hr/payroll", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: input.id, pay: input.pay, deductionDetail: input.deductionDetail, notes: input.notes }),
    });
    const payload = await response.json() as { record?: PayrollRecord; error?: string };
    if (!response.ok || !payload.record) throw new Error(payload.error || "급여 내역을 저장하지 못했습니다.");
    const refreshed = await fetchPayrollMonth(month);
    setSummary(refreshed.summary); setRecords(refreshed.records);
    setSelectedRecord(refreshed.records.find((item) => item.id === input.id) ?? payload.record);
    setNotice("급여 내역을 저장했습니다.");
  }

  async function savePayrollRecord(input: PayrollRecordInput) {
    setError(""); setNotice("");
    try {
      await submitPayrollRecord(input);
      return "";
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "급여 내역을 저장하지 못했습니다.";
      if (message === PAYROLL_DEDUCTION_LOCK_MESSAGE && await dialog.confirm(`${message}
지금 급여월 잠금을 해제하고 계속할까요?`, { title: "급여 잠금 해제", confirmLabel: "잠금 해제" })) {
        const unlocked = await updatePayrollStatus("DRAFT");
        if (!unlocked) return message;
        try { await submitPayrollRecord(input); return ""; }
        catch (retryError) { return retryError instanceof Error ? retryError.message : "급여 내역을 저장하지 못했습니다."; }
      }
      return message;
    }
  }

  async function updatePayrollStatus(status: PayrollSummary["status"]) {
    setError(""); setNotice("");
    const result = await requestPayrollStatusChange(dialog, month, summary?.status ?? "DRAFT", status);
    if (result.error) { setError(result.error); return false; }
    if (result.applied) setSummary((current) => current ? { ...current, status } : current);
    if (result.notice) setNotice(result.notice);
    return result.applied;
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await fetchPayrollMonth(month);
        if (!cancelled) {
          setSummary(payload.summary);
          setRecords(payload.records);
        }
      } catch (fetchError) {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : "월별 급여 기록을 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [month]);

  // 공제 전 총계는 급여대장의 "지급합계"와 같은 값이다. 공제 열 제목은 눌러서 항목별 내역을 편다.
  const payrollColumns = ["직원", "부서", "기본급", "식대", "육아수당", "차량보조", "인센티브", "상여", "연차수당", "퇴직금", "공제 전 총계", "공제", "실 지급액", "상태"];

  return <div className="page-wrap detail-page payroll-page">
    <button type="button" className="back-button" onClick={onBack}>← 급여월 현황</button>
    <section className="module-hero"><div data-korean-heading><h1>{payrollMonthLabel(month)} 급여 상세</h1><p>직원별 기본급과 모든 수당 항목을 한 표에서 확인합니다. 직원명을 클릭하면 추가 항목과 원본 메모를 볼 수 있습니다.</p></div><div className="payroll-workflow"><span className="payroll-import-badge">{summary ? payrollStatusLabels[summary.status] : "불러오는 중"}</span><select aria-label="급여 처리 상태" value={summary?.status ?? "DRAFT"} onChange={(event) => void updatePayrollStatus(event.target.value as PayrollSummary["status"])} disabled={!summary}>{(["DRAFT", "REVIEW", "APPROVED", "LOCKED"] as const).map((value) => {
              const allowed = payrollStatusTransitions[summary?.status ?? "DRAFT"].includes(value);
              return <option key={value} value={value} disabled={!allowed}>{payrollStatusOptionLabels[value]}{allowed ? "" : " · 지금은 선택 불가"}</option>;
            })}</select></div></section>
    {notice && <div className="finance-control-message" role="status">{notice}</div>}
    {error && <div className="payroll-status-error" role="alert">{error}</div>}
    <section className="payroll-summary"><div><span>급여 대상</span><strong>{summary ? `${summary.employeeCount}명` : "-"}</strong><small>월별 정규 급여 행</small></div><div><span>지급총액</span><strong>{summary ? formatWon(summary.grossPay) : "-"}</strong><small>기본급·수당·인센티브 포함</small></div><div><span>공제총액</span><strong>{summary ? formatWon(summary.deductions) : "-"}</strong><small>원본 공제 열 합계</small></div><div><span>실 지급액</span><strong>{summary ? formatWon(summary.netPay) : "-"}</strong><small>실제 세후 송금액과 다를 수 있음</small></div></section>
    <section className="panel table-panel"><div className="table-toolbar"><div><h2>개인별 급여 내역</h2><span>전체 {records.length}명 · 가로로 이동하면 모든 수당 항목을 확인할 수 있습니다.</span></div><span className="payroll-source-note">인건비 정리 원본 기준</span></div><div className="data-table-wrap payroll-detail-scroll"><table className="data-table payroll-detail-table"><thead><tr>{payrollColumns.map((column) => <th key={column}>{column === "공제" ? <button type="button" className="payroll-deduction-toggle" aria-expanded={deductionOpen} onClick={() => setDeductionOpen((value) => !value)}>공제 <span aria-hidden="true">{deductionOpen ? "▾" : "▸"}</span></button> : column}</th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={payrollColumns.length} className="table-message">급여 기록을 불러오는 중입니다.</td></tr> : error ? <tr><td colSpan={payrollColumns.length} className="table-message error">{error}</td></tr> : records.map((record) => <tr key={record.id}><td><button type="button" className="payroll-person-link" onClick={() => setSelectedRecord(record)}>{record.employeeName}</button></td><td>{record.department ?? "퇴직·미등록"}</td><td>{formatWon(record.basePay)}</td><td>{formatWon(record.mealAllowance)}</td><td>{formatWon(record.childcareAllowance)}</td><td>{formatWon(record.vehicleAllowance)}</td><td>{formatWon(record.incentive)}</td><td>{formatWon(record.bonus)}</td><td>{formatWon(record.annualLeavePay)}</td><td>{formatWon(record.retirementPay)}</td><td className="payroll-gross-cell">{formatWon(record.grossPay)}</td><td>{formatWon(record.deductions)}{deductionOpen && <ul className="payroll-deduction-breakdown">{Object.entries(record.deductionDetail ?? {}).length ? Object.entries(record.deductionDetail ?? {}).map(([label, value]) => <li key={label}><span>{label}</span><em>{formatWon(Number(value))}</em></li>) : <li className="empty"><span>항목 내역 없음</span></li>}</ul>}</td><td>{formatWon(record.netPay)}</td><td><StatusPill value="자료 반영" /></td></tr>)}</tbody></table></div></section>
    {selectedRecord && <PayrollRecordModal record={selectedRecord}
      locked={Boolean(summary && !["DRAFT", "REVIEW"].includes(summary.status))}
      lockLabel={summary ? payrollStatusLabels[summary.status] : ""}
      onClose={() => setSelectedRecord(null)} onSave={savePayrollRecord} />}
  </div>;
}


type PayrollRecordInput = {
  id: string;
  pay: Record<string, number>;
  deductionDetail: Record<string, number>;
  notes: string;
};

// 급여대장에서 흔히 쓰는 공제 항목. 목록에 없는 항목도 이름을 직접 적어 넣을 수 있다.
const DEDUCTION_PRESETS = [
  "국민연금", "건강보험", "장기요양보험료", "고용보험", "산재보험",
  "소득세", "지방소득세", "연말정산소득세", "연말정산지방소득세", "연말정산농특세",
  "학자금상환액", "건강보험료정산", "장기요양보험정산", "실비정산", "기타공제",
];

// 지급 항목. 앞의 8개가 지급총액을 이루고, 나머지는 참고용 기록이다.
const PAYROLL_PAY_FIELDS: Array<[key: string, label: string, inGross: boolean]> = [
  ["basePay", "기본급", true], ["mealAllowance", "식대", true],
  ["childcareAllowance", "육아수당", true], ["vehicleAllowance", "차량보조", true],
  ["incentive", "인센티브", true], ["bonus", "상여", true],
  ["annualLeavePay", "연차수당", true], ["personalExpense", "개인비용지급", true], ["retirementPay", "퇴직금", true],
  ["nonTaxable", "비과세", false], ["welfareFund", "복지기금", false],
  ["cardUsage", "카드 사용액", false], ["personalPurchase", "개인매입", false],
  ["annualSalary", "연봉 기준", false],
];

function PayrollRecordModal({ record, locked, lockLabel, onClose, onSave }: {
  record: PayrollRecord;
  locked: boolean;
  lockLabel: string;
  onClose: () => void;
  onSave: (input: PayrollRecordInput) => Promise<string>;
}) {
  const [pay, setPay] = useState<Record<string, string>>(() =>
    Object.fromEntries(PAYROLL_PAY_FIELDS.map(([key]) => [key, String((record as unknown as Record<string, number>)[key] ?? 0)])));
  const [items, setItems] = useState<Array<{ label: string; amount: string }>>(() => {
    const detail = Object.entries(record.deductionDetail ?? {});
    if (detail.length) return detail.map(([label, amount]) => ({ label, amount: String(amount) }));
    // 항목 내역이 없던 기록은 총액 한 줄로 열어 둔다. 사람이 항목을 나눠 적으면 그때부터 내역이 생긴다.
    return record.deductions ? [{ label: "기타공제", amount: String(record.deductions) }] : [];
  });
  const [notes, setNotes] = useState(record.notes);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  // 내려가면 제목줄을 절반 높이로 접는다. 지원자·퇴직 팝업과 같은 방식이다.
  const [condensed, setCondensed] = useState(false);

  const grossPay = PAYROLL_PAY_FIELDS.filter(([, , inGross]) => inGross)
    .reduce((sum, [key]) => sum + (Number(pay[key]) || 0), 0);
  const deductions = items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

  function updateItem(index: number, patch: Partial<{ label: string; amount: string }>) {
    setItems((current) => current.map((item, position) => position === index ? { ...item, ...patch } : item));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const named = items.filter((item) => item.label.trim());
    if (named.length !== items.length) { setMessage("공제 항목 이름을 모두 입력해 주세요."); return; }
    const detail: Record<string, number> = {};
    for (const item of named) {
      const amount = Math.round(Number(item.amount) || 0);
      if (!amount) continue;
      detail[item.label.trim()] = (detail[item.label.trim()] ?? 0) + amount;
    }
    setSaving(true); setMessage("");
    const failure = await onSave({
      id: record.id, notes,
      pay: Object.fromEntries(PAYROLL_PAY_FIELDS.map(([key]) => [key, Math.round(Number(pay[key]) || 0)])),
      deductionDetail: detail,
    });
    setSaving(false);
    setMessage(failure || "저장했습니다.");
  }

  return <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form
      className={`payroll-record-modal${condensed ? " condensed" : ""}`}
      onSubmit={submit}

      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setCondensed((current) => nextCondensed(current, top));
      }}
    >
      <div className="modal-header">
        <div data-korean-heading><h2>{record.employeeName} · {payrollMonthLabel(record.yearMonth)}</h2></div>
        <div className="modal-header-actions">
          <button type="submit" className="header-save-button" disabled={saving}>{saving ? "저장 중…" : "변경사항 저장"}</button>
          <button type="button" className="modal-close" onClick={onClose} aria-label="닫기">×</button>
        </div>
      </div>
      <div className="payroll-record-summary">
        <div><span>지급총액</span><strong>{formatWon(grossPay)}</strong></div>
        <div><span>공제 합계</span><strong>{formatWon(deductions)}</strong></div>
        <div><span>실 지급액</span><strong>{formatWon(grossPay - deductions)}</strong></div>
      </div>
      {locked && <p className="optional-form-notice">{lockLabel} 상태입니다. 저장할 때 잠금을 해제할지 먼저 물어봅니다.</p>}

      <div className="payroll-edit-section">
        <div className="detail-card-heading"><div data-korean-heading><h3>지급 항목</h3></div><span>앞의 8개가 지급총액</span></div>
        <div className="payroll-edit-grid">{PAYROLL_PAY_FIELDS.map(([key, label, inGross]) => <label key={key} className={inGross ? "" : "reference"}>
          <span>{label}{inGross ? "" : " · 참고"}</span>
          <input type="number" step="1" value={pay[key]} onChange={(event) => setPay({ ...pay, [key]: event.target.value })} />
        </label>)}</div>
      </div>

      <div className="payroll-edit-section">
        <div className="detail-card-heading"><div data-korean-heading><h3>공제 내역</h3></div><span>{formatWon(deductions)}</span></div>
        <div className="payroll-deduction-rows">{items.map((item, index) => <div key={index} className="payroll-deduction-row">
          <input list="payroll-deduction-presets" value={item.label} placeholder="항목명 (예: 국민연금)"
            onChange={(event) => updateItem(index, { label: event.target.value })} aria-label={`공제 항목 ${index + 1} 이름`} />
          <input type="number" step="1" value={item.amount}
            onChange={(event) => updateItem(index, { amount: event.target.value })} aria-label={`공제 항목 ${index + 1} 금액`} />
          <button type="button" className="reject-action" onClick={() => setItems((current) => current.filter((_, position) => position !== index))}>삭제</button>
        </div>)}{items.length ? null : <p className="interview-empty">등록된 공제 항목이 없습니다.</p>}</div>
        <datalist id="payroll-deduction-presets">{DEDUCTION_PRESETS.map((name) => <option key={name} value={name} />)}</datalist>
        <button type="button" className="outline-button" onClick={() => setItems((current) => [...current, { label: "", amount: "0" }])}>공제 항목 추가</button>
        <small>환급이면 음수로 적습니다(예: 연말정산소득세 -21,900). 실 지급액은 지급총액 − 공제 합계로 다시 계산됩니다.</small>
      </div>

      <div className="payroll-edit-section">
        <div className="detail-card-heading"><div data-korean-heading><h3>메모</h3></div><span>{record.sourceSheet} · {record.sourceRow}행</span></div>
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="퇴사일, 정산 사유 등 참고할 내용을 적습니다." />
      </div>

      {message && <p className="retirement-settlement-message">{message}</p>}
    </form>
  </HrModalBackdrop>;
}

function normalizedMatch(value: string) {
  return value.replace(/[\s.-]/g, "").toLowerCase();
}

function previousApplicationsFor(applicant: Applicant, applicants: Applicant[]) {
  return applicants.filter((item) => {
    if (item.id === applicant.id || normalizedMatch(item.name) !== normalizedMatch(applicant.name)) return false;
    const sameEmail = Boolean(applicant.email && item.email && normalizedMatch(item.email) === normalizedMatch(applicant.email));
    const samePhone = Boolean(applicant.phone && item.phone && normalizedMatch(item.phone) === normalizedMatch(applicant.phone));
    return sameEmail || samePhone;
  });
}

/** 공고가 진행 중인지 판단한다. 여기 없는 상태(CLOSED·FILLED·CANCELLED 등)는 모두 종료로 본다.
 *  SUBMITTED 는 전자결재 시절에 제출돼 남은 요청이다. 새로 생기지는 않지만 '모집 시작'으로 열 수 있어 진행 중으로 둔다. */
const OPEN_REQUISITION_STATUSES = ["OPEN", "DRAFT", "SUBMITTED"];

/** 채용요청·TO 칸. 공고를 종료해도 지원자의 연결은 그대로 남으므로 제목을 계속 보여 준다.
 *  다만 진행 중인 공고와 같아 보이면 아직 뽑는 자리로 오해하므로 다르게 표시한다.
 *  연결 자체가 없는 "예외·미연결"과도 구분한다. */
/** 채용요청·TO 칸. 눌러서 그 자리에서 바꾼다 — 팝업을 열지 않아도 연결을 고칠 수 있다. 고를 수 있는 것은 모집 중인 공고뿐이고,
 *  이미 연결된 종료 공고는 그대로 두는 선택지로만 남긴다(서버도 새 연결은 막는다). onChange 가 없으면(입사 예정자·채용 종료 표) 읽기 전용이다. */
function RequisitionCell({ requisition, applicant, requisitions, onChange }: { requisition?: RecruitmentRequisitionOption; applicant?: Applicant; requisitions?: RecruitmentRequisitionOption[]; onChange?: (applicant: Applicant, requisitionId: string) => void }) {
  const [editing, setEditing] = useState(false);
  const editable = Boolean(onChange && applicant && requisitions);
  if (editing && editable) {
    const current = applicant!.requisitionId || "";
    const choices = requisitions!.filter((item) => OPEN_REQUISITION_STATUSES.includes(item.status) || item.id === current);
    // eslint-disable-next-line jsx-a11y/no-autofocus -- 칸을 눌러 여는 편집용 select 라 바로 초점을 받아야 한다
    return <select className="applicant-to-select" autoFocus value={current} aria-label="채용요청·TO 변경" onBlur={() => setEditing(false)} onChange={(event) => { const next = event.target.value; setEditing(false); if (next !== current) onChange!(applicant!, next); }}>
      <option value="">예외·미연결</option>{choices.map((item) => <option key={item.id} value={item.id}>{item.title}{OPEN_REQUISITION_STATUSES.includes(item.status) ? "" : " (종료된 공고)"}</option>)}
    </select>;
  }
  const open = requisition ? OPEN_REQUISITION_STATUSES.includes(requisition.status) : false;
  const className = !requisition ? "applicant-to-exception" : open ? "applicant-to-link" : "applicant-to-closed";
  const title = !requisition ? "채용요청·TO 미연결" : open ? requisition.title : `${requisition.title} (종료된 공고)`;
  return <button type="button" className={className} title={editable ? `${title} · 눌러서 변경` : title} disabled={!editable} onClick={() => setEditing(true)}>{requisition ? requisition.title : "예외·미연결"}</button>;
}

function RecruitmentView({ applicants, recruiters, requisitions, query, onAdd, onSelect, onOwnerChange, onDelete, onRequisitionChange }: { applicants: Applicant[]; recruiters: Employee[]; requisitions: RecruitmentRequisitionOption[]; query: string; onAdd: () => void; onSelect: (id: string) => void; onOwnerChange: (applicantId: string, ownerId: string) => void; onDelete: (id: string) => void; onRequisitionChange: (applicant: Applicant, requisitionId: string) => void }) {
  const visible = query ? applicants.filter((applicant) => JSON.stringify(applicant).toLowerCase().includes(query.toLowerCase())) : applicants;
  // 면접 전형 진행 중 = 서류 합격 상태이면서 면접 일정이 잡힌 사람. 탈락자와 처우 단계로
  // 넘어간 사람은 stage 가 달라 자연히 빠진다.
  const now = (() => {
    const stamp = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
  })();
  const interviewRows = visible
    .filter((applicant) => ([SCREENING_PASSED_STAGE, "면접"].includes(applicant.stage) && interviewScheduleLabel(applicant))
      || applicant.stage === INTERVIEW_PASSED_STAGE || applicant.stage === OFFER_PREPARED_STAGE)
    .slice()
    .map((applicant) => ({ applicant, track: interviewTrackOf(applicant, now) }))
    .sort((a, b) => (interviewTrackOrder[a.track] - interviewTrackOrder[b.track])
      || interviewSortKey(a.applicant).localeCompare(interviewSortKey(b.applicant)));
  // 면접 결과 입력: 면접 시각이 지났는데 합격·탈락을 아직 안 적은 사람. 오늘 처리할 일이라 전용 표에 따로 둔다.
  const awaiting = interviewRows.filter((row) => row.track === "AWAITING").map((row) => row.applicant);
  // 면접 전형 진행 표에는 면접이 남았거나 합격한 사람만 남긴다 — 한 사람이 한 표에만 보이게.
  const interviewing = interviewRows.filter((row) => row.track !== "AWAITING");
  const interviewCounts = {
    SCHEDULED: interviewing.filter((row) => row.track === "SCHEDULED").length,
    PASSED: interviewing.filter((row) => row.track === "PASSED").length,
  };
  // 입사 예정자. 처우 제안을 수락해 확정된 사람만 입사예정일 순으로 — 제안만 해 둔 사람은 여기 오지 않는다.
  const joining = visible
    .filter((applicant) => OFFER_STAGES.includes(applicant.stage) && ["ACCEPTED", "ONBOARDED"].includes(applicant.offer?.status ?? ""))
    .slice()
    .sort((a, b) => (a.offer?.startDate || "9999-99-99").localeCompare(b.offer?.startDate || "9999-99-99"));
  // 절차가 끝난 사람은 위 지원 현황에서 빼고 맨 아래 "채용 종료" 표에만 둔다.
  // 진행 중인 사람만 위에 남아야 오늘 손댈 대상이 바로 보인다.
  const closed = visible
    .filter((applicant) => CLOSED_STAGES.includes(applicant.stage))
    .slice()
    .sort((a, b) => b.applied.localeCompare(a.applied));
  // 면접에 합격한 뒤로는 지원 현황에서 뺀다. 합격자는 면접 전형 진행 표에,
  // 처우까지 제안한 사람도 면접 전형 진행 표(합격 트랙)나 입사 예정자 표에 남아 한 사람이 한 표에만 보이게 한다.
  const active = visible.filter((applicant) => !CLOSED_STAGES.includes(applicant.stage)
    && !OFFER_STAGES.includes(applicant.stage));
  return <div className="page-wrap module-page recruitment-page">
    <section className="module-hero"><div data-korean-heading><h1>지원자 관리</h1><p>지원자별 담당자와 서류 합격·면접 회신 과정을 한 흐름으로 관리합니다.</p></div><button type="button" className="primary-button" onClick={onAdd}>+ 지원자 등록</button></section>
    <section className="metric-grid module-metrics">{[
      { label: "등록 지원자", value: `${applicants.length}명`, note: "실제 등록 기준" },
      { label: "서류 검토", value: `${applicants.filter((item) => item.stage === "서류 검토").length}명`, note: "담당자 확인 필요", tone: "blue" },
      // 예전 지표는 코드 어디에서도 저장되지 않는 단계명("서류 합격 안내 완료" 등)을 세어 늘 0명이었다. 실제 단계로 센다.
      { label: "서류 합격 · 면접 대기", value: `${applicants.filter((item) => item.stage === SCREENING_PASSED_STAGE && !item.interview?.date).length}명`, note: "면접 일정 입력 필요", tone: "orange" },
      { label: "면접 일정 확정", value: `${applicants.filter((item) => [SCREENING_PASSED_STAGE, "면접"].includes(item.stage) && Boolean(item.interview?.date)).length}명`, note: "면접 안내 발송 대상", tone: "green" },
    ].map((metric) => <div className="compact-metric" key={metric.label}><span className={`metric-accent ${metric.tone ?? "navy"}`}></span><p>{metric.label}</p><h2>{metric.value}</h2><small>{metric.note}</small></div>)}</section>
    <section className="panel table-panel">
      <div className="table-toolbar"><div><h2>지원 현황</h2><span>진행 중 {active.length}명 · 종료 {closed.length}명은 아래 채용 종료 표에서 봅니다</span></div></div>
      <div className="data-table-wrap"><table className="data-table applicant-table"><thead><tr><th>지원자</th><th className="applicant-phone-cell">연락처</th><th className="applicant-to-column">채용요청·TO</th><th>지원 직무</th><th>지원일</th><th>지원경로</th><th>경력</th><th className="applicant-owner-column">담당자</th><th className="applicant-stage-column">현재 단계</th><th>채용단계</th><th className="applicant-delete-column">삭제</th></tr></thead><tbody>{active.length ? active.map((applicant) => {
        const previous = previousApplicationsFor(applicant, applicants);
        const requisition = requisitions.find((item) => item.id === applicant.requisitionId);
        return <tr key={applicant.id}><td><button type="button" className="name-link" onClick={() => onSelect(applicant.id)}><span>{applicant.name.slice(0, 1)}</span>{applicant.name}</button>{previous.length > 0 && <em className="repeat-applicant-badge">재지원 {previous.length}건</em>}</td><td className="applicant-phone-cell">{applicant.phone || "미입력"}</td><td className="applicant-to-column"><RequisitionCell requisition={requisition} applicant={applicant} requisitions={requisitions} onChange={onRequisitionChange} /></td><td>{applicant.role}</td><td>{applicant.applied}</td><td>{applicant.source}</td><td>{applicant.experience || "미입력"}</td><td className="applicant-owner-column"><select className="recruiter-cell-select" value={applicant.ownerId} onChange={(event) => onOwnerChange(applicant.id, event.target.value)}><option value="">미지정</option>{recruiters.map((recruiter) => <option value={recruiter.id} key={recruiter.id}>{recruiter.name}</option>)}</select></td><td className="applicant-stage-column"><span className="applicant-current-stage">{currentStageOf(applicant)}</span></td><td><span className={`screening-stage ${recruitStageOf(applicant).toLowerCase()}`}>{recruitStageLabels[recruitStageOf(applicant)]}</span></td><td className="applicant-delete-column"><button type="button" className="delete-applicant-button" onClick={() => onDelete(applicant.id)} aria-label={`${applicant.name} 지원자 모든 정보 삭제`} title="지원자 모든 정보 삭제"><span aria-hidden="true">🗑</span></button></td></tr>;
      }) : <tr><td colSpan={11} className="empty-cell">{closed.length ? "진행 중인 지원자가 없습니다. 종료된 인원은 아래 채용 종료 표에 있습니다." : "등록된 지원자가 없습니다."}</td></tr>}</tbody></table></div>
    </section>

    <section className="panel table-panel interview-schedule-panel">
      <div className="table-toolbar"><div><h2>면접 전형 진행</h2><span>면접 예정 {interviewCounts.SCHEDULED}명 · 면접 합격 {interviewCounts.PASSED}명 · 결과 입력은 아래 표에서</span></div></div>
      <div className="data-table-wrap"><table className="data-table interview-track-table">
        <thead><tr><th className="interview-track-column">전형 상태</th><th>면접 일시</th><th>지원자</th><th>연락처</th><th className="applicant-to-column">채용요청·TO</th><th>지원 직무</th><th>면접 유형</th><th>면접관</th><th>장소·링크</th><th className="applicant-owner-column">담당자</th></tr></thead>
        <tbody>{interviewing.length ? interviewing.map(({ applicant, track }) => {
          const requisition = requisitions.find((item) => item.id === applicant.requisitionId);
          const tone = track.toLowerCase();
          return <tr key={applicant.id} className={`interview-track-row ${tone}`}>
            <td className="interview-track-column"><span className={`interview-track ${tone}`}>{track === "PASSED" ? applicant.stage : interviewTrackLabels[track]}</span></td>
            <td><span className="interview-when"><strong>{applicant.interview?.date || "일자 미정"}</strong>{applicant.interview?.time && <em>{applicant.interview.time}</em>}</span></td>
            <td><button type="button" className="name-link" onClick={() => onSelect(applicant.id)}><span>{applicant.name.slice(0, 1)}</span>{applicant.name}</button></td>
            <td className="applicant-phone-cell">{applicant.phone || "미입력"}</td>
            <td className="applicant-to-column"><RequisitionCell requisition={requisition} applicant={applicant} requisitions={requisitions} onChange={onRequisitionChange} /></td>
            <td>{applicant.role}</td>
            <td>{applicant.interview?.type || "미정"}</td>
            <td>{applicant.interview?.interviewers || "미정"}</td>
            <td>{applicant.interview?.location || "미정"}</td>
            <td className="applicant-owner-column">{applicant.owner || "미지정"}</td>
          </tr>;
        }) : <tr><td colSpan={10} className="empty-cell">면접이 예정되어 있거나 면접에 합격한 지원자가 없습니다.</td></tr>}</tbody>
      </table></div>
    </section>

    {/* 면접 시각이 지났는데 결과가 없는 사람. 여기서 바로 열어 합격·탈락을 적는다. 결과를 적으면 표에서 빠진다. */}
    <section className="panel table-panel interview-result-panel">
      <div className="table-toolbar"><div><h2>면접 결과 입력</h2><span>면접 시각이 지나 합격·탈락을 적어야 하는 지원자 {awaiting.length}명</span></div></div>
      <div className="data-table-wrap"><table className="data-table">
        <thead><tr><th>면접 일시</th><th>지원자</th><th className="applicant-phone-cell">연락처</th><th className="applicant-to-column">채용요청·TO</th><th>지원 직무</th><th>면접 유형</th><th>면접관</th><th className="applicant-owner-column">담당자</th><th className="applicant-status-column">결과</th></tr></thead>
        <tbody>{awaiting.length ? awaiting.map((applicant) => {
          const requisition = requisitions.find((item) => item.id === applicant.requisitionId);
          return <tr key={applicant.id} className="interview-track-row awaiting">
            <td><span className="interview-when"><strong>{applicant.interview?.date || "일자 미정"}</strong>{applicant.interview?.time && <em>{applicant.interview.time}</em>}</span></td>
            <td><button type="button" className="name-link" onClick={() => onSelect(applicant.id)}><span>{applicant.name.slice(0, 1)}</span>{applicant.name}</button></td>
            <td className="applicant-phone-cell">{applicant.phone || "미입력"}</td>
            <td className="applicant-to-column"><RequisitionCell requisition={requisition} applicant={applicant} requisitions={requisitions} onChange={onRequisitionChange} /></td>
            <td>{applicant.role}</td>
            <td>{applicant.interview?.type || "미정"}</td>
            <td>{applicant.interview?.interviewers || "미정"}</td>
            <td className="applicant-owner-column">{applicant.owner || "미지정"}</td>
            <td className="applicant-status-column"><button type="button" className="interview-result-button" onClick={() => onSelect(applicant.id)}>결과 입력 →</button></td>
          </tr>;
        }) : <tr><td colSpan={9} className="empty-cell">결과를 입력할 면접이 없습니다. 면접 시각이 지나면 여기에 나타납니다.</td></tr>}</tbody>
      </table></div>
    </section>

    {/* 처우를 수락해 입사가 확정된 사람만 따로 본다. 제안을 거절했거나 타사에 간 사람은 아래 채용 종료 표에 남는다. */}
    <section className="panel table-panel joining-applicant-panel">
      <div className="table-toolbar"><div><h2>입사 예정자</h2><span>처우 제안 수락 · 입사예정일 순 {joining.length}명</span></div></div>
      <div className="data-table-wrap"><table className="data-table">
        <thead><tr><th>입사예정일</th><th>지원자</th><th className="applicant-phone-cell">연락처</th><th className="applicant-to-column">채용요청·TO</th><th>제안 직무</th><th>소속</th><th>고용형태</th><th>연봉</th><th className="applicant-owner-column">담당자</th></tr></thead>
        <tbody>{joining.length ? joining.map((applicant) => {
          const requisition = requisitions.find((item) => item.id === applicant.requisitionId);
          const offer = applicant.offer;
          return <tr key={applicant.id}>
            <td><strong>{offer?.startDate || "미정"}</strong></td>
            <td><button type="button" className="name-link" onClick={() => onSelect(applicant.id)}><span>{applicant.name.slice(0, 1)}</span>{applicant.name}</button></td>
            <td className="applicant-phone-cell">{applicant.phone || "미입력"}</td>
            <td className="applicant-to-column"><RequisitionCell requisition={requisition} /></td>
            <td>{offer?.proposedTitle || applicant.role}</td>
            <td>{offer?.department || "미정"}</td>
            <td>{offer?.employmentType || "미정"}</td>
            <td>{offer ? `${offer.annualSalary.toLocaleString("ko-KR")}원` : "미정"}</td>
            <td className="applicant-owner-column">{applicant.owner || "미지정"}</td>
          </tr>;
        }) : <tr><td colSpan={9} className="empty-cell">처우 제안을 수락한 지원자가 없습니다.</td></tr>}</tbody>
      </table></div>
    </section>

    {/* 절차가 끝난 사람은 여기 한 곳에 모은다. 위 지원 현황에는 진행 중인 사람만 남는다. */}
    <section className="panel table-panel closed-applicant-panel">
      <div className="table-toolbar"><div><h2>채용 종료</h2><span>탈락·제안 거절·타사 합격·오퍼 수락 {closed.length}명</span></div>
        <span className="closed-summary">{[
          { label: "탈락", count: closed.filter((item) => REJECTED_STAGES.includes(item.stage)).length },
          { label: "제안 거절", count: closed.filter((item) => closedReasonOf(item).label === "제안 거절").length },
          { label: "타사 합격", count: closed.filter((item) => item.stage === OTHER_OFFER_STAGE).length },
          { label: "오퍼 수락", count: closed.filter((item) => closedReasonOf(item).label === "오퍼 수락").length },
        ].filter((item) => item.count).map((item) => `${item.label} ${item.count}`).join(" · ") || "종료된 지원자 없음"}</span></div>
      <div className="data-table-wrap"><table className="data-table">
        <thead><tr><th>지원자</th><th className="applicant-to-column">채용요청·TO</th><th>지원 직무</th><th className="applicant-status-column">종료 구분</th><th>마지막 단계</th><th>채용단계</th><th>지원일</th><th className="applicant-owner-column">담당자</th><th className="applicant-delete-column">삭제</th></tr></thead>
        <tbody>{closed.length ? closed.map((applicant) => {
          const requisition = requisitions.find((item) => item.id === applicant.requisitionId);
          const reason = closedReasonOf(applicant);
          return <tr key={applicant.id}>
            <td><button type="button" className="name-link" onClick={() => onSelect(applicant.id)}><span>{applicant.name.slice(0, 1)}</span>{applicant.name}</button></td>
            <td className="applicant-to-column"><RequisitionCell requisition={requisition} /></td>
            <td>{applicant.role}</td>
            <td className="applicant-status-column"><span className={`closed-reason ${reason.tone}`}>{reason.label}</span></td>
            <td>{applicant.stage}</td>
            <td><span className={`screening-stage ${recruitStageOf(applicant).toLowerCase()}`}>{recruitStageLabels[recruitStageOf(applicant)]}</span></td>
            <td>{applicant.applied}</td>
            <td className="applicant-owner-column">{applicant.owner || "미지정"}</td>
            <td className="applicant-delete-column"><button type="button" className="delete-applicant-button" onClick={() => onDelete(applicant.id)} aria-label={`${applicant.name} 지원자 모든 정보 삭제`} title="지원자 모든 정보 삭제"><span aria-hidden="true">🗑</span></button></td>
          </tr>;
        }) : <tr><td colSpan={9} className="empty-cell">종료된 지원자가 없습니다.</td></tr>}</tbody>
      </table></div>
    </section>
  </div>;
}

function RecruiterManagement({ employees, recruiterIds, onAdd, onRemove }: { employees: Employee[]; recruiterIds: string[]; onAdd: (employeeId: string) => void; onRemove: (employeeId: string) => void }) {
  const [candidateId, setCandidateId] = useState("");
  const recruiters = employees.filter((employee) => recruiterIds.includes(employee.id));
  const candidates = employees.filter((employee) => isCurrentEmployee(employee) && !recruiterIds.includes(employee.id));
  return <div className="page-wrap module-page recruiter-page">
    <section className="module-hero"><div data-korean-heading><h1>채용담당자 관리</h1><p>회사에 등록된 재직자 중 지원자와 면접 과정을 담당할 인원을 지정합니다.</p></div></section>
    <section className="panel recruiter-manager">
      <form onSubmit={(event) => { event.preventDefault(); onAdd(candidateId); setCandidateId(""); }}><label><span>채용담당자 추가</span><select value={candidateId} onChange={(event) => setCandidateId(event.target.value)}><option value="">재직자 선택</option>{candidates.map((employee) => <option value={employee.id} key={employee.id}>{employee.name} · {employee.department}</option>)}</select></label><button type="submit" className="primary-button" disabled={!candidateId}>담당자 추가</button></form>
      <div className="recruiter-list">{recruiters.map((recruiter) => <article key={recruiter.id}><span>{recruiter.name.slice(0, 1)}</span><div><strong>{recruiter.name}</strong><small>{recruiter.department} · {recruiter.position}</small></div><em>채용담당자</em><button type="button" onClick={() => onRemove(recruiter.id)}>담당 해제</button></article>)}</div>
    </section>
  </div>;
}

function ApplicantDetail({ applicant, recruiters, requisitions, organizations, jobTitles, ranks, onClose, onSave, onDecideScreening, onSaveMemo, onSubmitOffer, onRejectInterview, onRespondOffer }: {
  applicant: Applicant;
  recruiters: Employee[];
  requisitions: RecruitmentRequisitionOption[];
  organizations: Organization[];
  onClose: () => void;
  onSave: (applicant: Applicant) => void;
  onDecideScreening: (applicantId: string, decision: "PASS" | "REJECT" | "RESET") => void;
  onSaveMemo: (applicantId: string, text: string) => void;
  onSubmitOffer: (applicantId: string, draft: RecruitmentOfferDraft) => Promise<string | null>;
  onRejectInterview: (applicantId: string, note: string, attended: boolean) => void;
  jobTitles: string[];
  ranks: string[];
  onRespondOffer: (applicantId: string, offerId: string, action: "ACCEPT" | "DECLINE", input: { employeeId?: string; position?: string; jobTitle?: string; responseNote: string; startDate?: string; annualSalary?: number; probationMonths?: number; firstTermPayPercent?: number; department?: string; proposedTitle?: string; employmentType?: string; declineKind?: "OFFER" | "OTHER_OFFER" }) => void;
}) {
  const dialog = useErpDialog();
  const [draft, setDraft] = useState({
    name: applicant.name,
    role: applicant.role,
    email: applicant.email,
    phone: applicant.phone,
    birth: applicant.birth ?? "",
    address: applicant.address ?? "",
    experience: applicant.experience,
    source: applicant.source,
    summary: applicant.summary,
    careerSummary: applicant.careerSummary ?? "",
    ownerId: applicant.ownerId,
    requisitionId: applicant.requisitionId,
  });
  const [note, setNote] = useState("");
  // 면접 일정이 확정되면(면접일이 들어오면) 지원 포지션의 기본 질문지를 채운다(app/hr-interview-question-templates.ts).
  // 일정은 잡혔는데 질문지가 빈 지원자는 결과를 적기 전 단계일 때 팝업을 열면서 채워 둔다. 저장해야 반영된다.
  const defaultQuestionsFor = (role: string, requisitionId: string) => {
    const requisition = requisitions.find((item) => item.id === requisitionId);
    return buildDefaultInterviewQuestions({ role, requisitionRole: requisition?.role, requisitionTitle: requisition?.title });
  };
  const [openedWithDefaultQuestions] = useState(() => Boolean(applicant.interview?.date) && !applicant.interview?.questions?.trim()
    && [SCREENING_PASSED_STAGE, "면접"].includes(applicant.stage));
  const [schedule, setSchedule] = useState<InterviewSchedule>(() => {
    const base = applicant.interview ?? { date: "", time: "", type: "1차 대면", interviewers: "", location: "", note: "" };
    return openedWithDefaultQuestions ? { ...base, questions: defaultQuestionsFor(applicant.role, applicant.requisitionId).text } : base;
  });
  const [interviewResult, setInterviewResult] = useState("");
  const [passModalOpen, setPassModalOpen] = useState(false);
  // 처우 제안 단계의 두 갈래. 수락은 최종 처우까지 고쳐 확정하고, 거절은 사유만 남긴다.
  const [acceptModalOpen, setAcceptModalOpen] = useState(false);
  const [declineModalOpen, setDeclineModalOpen] = useState(false);
  // 처우 확정·거절 팝업도 내려가면 제목줄을 절반 높이로 접는다. 한 번에 하나만 열리므로 상태 하나를 같이 쓰고, 열릴 때 되돌린다.
  const [responseCondensed, setResponseCondensed] = useState(false);

  const [declineReason, setDeclineReason] = useState("");
  // 거절 구분. 타사 합격은 우리가 떨어뜨린 것이 아니라 지원자 사정이라 채용단계를 따로 적는다.
  const [declineKind, setDeclineKind] = useState<"OFFER" | "OTHER_OFFER">("OFFER");
  const [finalOffer, setFinalOffer] = useState({ startDate: "", annualSalary: "", department: "", proposedTitle: "", employmentType: "일반직4.5", probationMonths: "3", firstTermPayPercent: "100" });
  // 처우를 저장하면 합격 안내 메시지를 곧바로 만들어 둔다. 회신 기한 기본값은 일주일 뒤다.
  const [offerReplyDue, setOfferReplyDue] = useState(() => {
    const due = new Date();
    due.setDate(due.getDate() + 7);
    return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  });
  // 수습 안내는 선택이다. 제안에 수습이 잡혀 있으면 기본으로 켜 두고, 필요 없으면 끈다.
  // 첫 계약 안내는 기본으로 넣는다. 지급률은 처우 제안에서 정한 값을 그대로 쓴다.
  const [offerFirstTermOn, setOfferFirstTermOn] = useState(true);
  // 손으로 고친 문구가 있으면 그것을 쓰고, 없으면 값이 바뀔 때마다 자동으로 다시 만든다.
  const [offerMessageOverride, setOfferMessageOverride] = useState<string | null>(null);
  const [offerMessageNotice, setOfferMessageNotice] = useState("");
  // 입사 안내문은 승낙 뒤에만 쓴다. 선택 서류는 기본으로 꺼 두고 필요할 때만 넣는다.
  const [onboardDocIds, setOnboardDocIds] = useState<string[]>([]);
  const [onboardMessageOverride, setOnboardMessageOverride] = useState<string | null>(null);
  // 불합격 안내문. 두 값이 null 이면 화면의 현재 상태를 따라간다 — 팝업을 연 뒤에 탈락 처리와
  // 면접일 입력이 일어나므로, 마운트 시점 값으로 굳히면 방금 적은 면접일이 안내문에 안 실린다.
  const [rejectionInterviewOn, setRejectionInterviewOn] = useState<boolean | null>(null);
  const [rejectionInterviewDate, setRejectionInterviewDate] = useState<string | null>(null);
  const [rejectionReapplyOn, setRejectionReapplyOn] = useState(true);
  const [rejectionMessageOverride, setRejectionMessageOverride] = useState<string | null>(null);
  // 면접 안내문. 면접일·시작 시간을 고치면 손으로 고친 문구를 버리고 다시 만든다.
  const [interviewMessageOverride, setInterviewMessageOverride] = useState<string | null>(null);
  // 서버에 저장해 둔 기본 문구. 없으면 내장 기본 문구를 쓴다.
  const [savedTemplates, setSavedTemplates] = useState<Partial<Record<MessageTemplateId, string>>>({});
  // 템플릿 편집 중에는 완성본 대신 {{토큰}} 이 그대로 보이는 원본을 고친다.
  const [templateEditing, setTemplateEditing] = useState<MessageTemplateId | null>(null);
  const [templateDraft, setTemplateDraft] = useState("");
  const [templateSaving, setTemplateSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/hr/message-templates");
        if (!response.ok) return;
        const payload = await response.json() as { templates?: { templateId: string; body: string }[] };
        if (cancelled) return;
        const next: Partial<Record<MessageTemplateId, string>> = {};
        for (const row of payload.templates ?? []) {
          const id = MESSAGE_TEMPLATE_IDS.find((item) => item === row.templateId);
          if (id) next[id] = row.body;
        }
        setSavedTemplates(next);
      } catch { /* 저장된 문구를 못 불러와도 내장 기본 문구로 계속 쓴다. */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const templateBodyOf = (id: MessageTemplateId) => savedTemplates[id] ?? DEFAULT_MESSAGE_TEMPLATES[id];

  async function saveTemplate(id: MessageTemplateId, body: string) {
    setTemplateSaving(true);
    try {
      const response = await fetch("/api/hr/message-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: id, body }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) { setOfferMessageNotice(payload.error || "기본 문구를 저장하지 못했습니다."); return; }
      setSavedTemplates((current) => ({ ...current, [id]: body }));
      setTemplateEditing(null);
      setOfferMessageOverride(null);
      setOnboardMessageOverride(null);
      setRejectionMessageOverride(null);
      setInterviewMessageOverride(null);
      setOfferMessageNotice("기본 문구로 저장했습니다. 앞으로 모든 지원자에게 이 문구가 쓰입니다.");
    } catch {
      setOfferMessageNotice("기본 문구를 저장하지 못했습니다.");
    } finally {
      setTemplateSaving(false);
    }
  }

  async function resetTemplate(id: MessageTemplateId) {
    setTemplateSaving(true);
    try {
      const response = await fetch(`/api/hr/message-templates?templateId=${id}`, { method: "DELETE" });
      if (!response.ok) { setOfferMessageNotice("처음 문구로 되돌리지 못했습니다."); return; }
      setSavedTemplates((current) => { const next = { ...current }; delete next[id]; return next; });
      setTemplateDraft(DEFAULT_MESSAGE_TEMPLATES[id]);
      setOfferMessageOverride(null);
      setOnboardMessageOverride(null);
      setRejectionMessageOverride(null);
      setInterviewMessageOverride(null);
      setOfferMessageNotice("처음 문구로 되돌렸습니다.");
    } catch {
      setOfferMessageNotice("처음 문구로 되돌리지 못했습니다.");
    } finally {
      setTemplateSaving(false);
    }
  }

  /** 합격·입사·불합격 세 안내문이 모두 같은 얼개를 쓴다. 한 곳에 모아 두어야 문구를 고치는 방식을
   *  바꿀 때 세 군데가 어긋나지 않는다. 안내문마다 다른 것은 아래 config 뿐이다.
   *  평소에는 값이 채워진 완성본을 고치고, 「기본 문구 편집」을 켜면 {{토큰}} 이 그대로 있는
   *  원본을 고쳐 서버에 저장한다 — 저장한 문구는 이후 모든 지원자에게 쓰인다. */
  function messageComposer(config: {
    templateId: MessageTemplateId;
    title: string;
    hint: string;
    tokens: Record<string, string>;
    tokenNames: string[];
    override: string | null;
    setOverride: (value: string | null) => void;
    rows: number;
    controls?: React.ReactNode;
  }) {
    const editing = templateEditing === config.templateId;
    const message = config.override ?? renderTemplate(templateBodyOf(config.templateId), config.tokens);
    const saved = Boolean(savedTemplates[config.templateId]);
    return <div className="offer-message-block">
      <div className="offer-message-heading">
        <strong>{config.title}</strong>
        <span>{editing ? "고친 문구를 저장하면 이후 모든 지원자에게 쓰입니다" : config.hint}</span>
        {saved && !editing && <em className="offer-message-saved-mark">기본 문구 수정됨</em>}
      </div>

      {!editing && config.controls}

      {editing
        ? <>
          <small className="offer-message-editable">사람마다 달라지는 값은 아래 자리로 남겨 두세요. 지우면 그 값이 안내문에 들어가지 않습니다.</small>
          <div className="offer-message-tokens">{config.tokenNames.map((name) => <code key={name}>{`{{${name}}}`}</code>)}</div>
          <textarea className="offer-message-text" rows={config.rows + 2} value={templateDraft} onChange={(event) => setTemplateDraft(event.target.value)} />
          <div className="offer-message-actions">
            <button type="button" className="primary-button" disabled={templateSaving || !templateDraft.trim()}
              onClick={() => void saveTemplate(config.templateId, templateDraft)}>{templateSaving ? "저장 중" : "기본 문구로 저장"}</button>
            <button type="button" disabled={templateSaving} onClick={() => void resetTemplate(config.templateId)}>처음 문구로 되돌리기</button>
            <button type="button" disabled={templateSaving} onClick={() => { setTemplateEditing(null); setOfferMessageNotice(""); }}>편집 취소</button>
            {offerMessageNotice && <em className="offer-message-notice">{offerMessageNotice}</em>}
          </div>
        </>
        : <>
          <small className="offer-message-editable">이 지원자에게 보낼 내용만 고치려면 아래에서 바로 고치세요. 모든 지원자에게 적용하려면 「기본 문구 편집」을 누르세요.</small>
          <textarea className="offer-message-text" rows={config.rows} value={message} onChange={(event) => { config.setOverride(event.target.value); setOfferMessageNotice(""); }} />
          <div className="offer-message-actions">
            <button type="button" className="primary-button" onClick={async () => {
              try {
                await copyText(message);
                setOfferMessageNotice("메시지를 복사했습니다.");
              } catch {
                setOfferMessageNotice("복사하지 못했습니다. 위 내용을 직접 선택해 복사해 주세요.");
              }
            }}>메시지 복사</button>
            <button type="button" onClick={() => { config.setOverride(null); setOfferMessageNotice("자동 문구로 되돌렸습니다."); }}>자동 문구로 되돌리기</button>
            <button type="button" onClick={() => { setTemplateDraft(templateBodyOf(config.templateId)); setTemplateEditing(config.templateId); setOfferMessageNotice(""); }}>기본 문구 편집</button>
            {offerMessageNotice && <em className="offer-message-notice">{offerMessageNotice}</em>}
          </div>
        </>}
    </div>;
  }

  // 팝업을 내리면 제목줄을 절반 높이로 접는다.
  const [condensed, setCondensed] = useState(false);
  // 지원 정보는 팝업 안이 좁아 따로 뺐다. 「지원 정보 상세」로 열어 고친다.
  const [fieldsModalOpen, setFieldsModalOpen] = useState(false);
  // 역제안 칸 강조 상태. 잠그지 않고 눈에 띄게만 한다.
  const counterTone = counterProposalTone(schedule, new Date());
  const counterBadge = counterTone === "soon" ? "면접 임박" : counterTone === "today" ? "오늘 면접" : "";

  // 질문지는 세 단계로 쌓인다.
  //  1) 면접일이 들어오면 지원 포지션의 기본 질문지를 바로 채운다(AI 없이, 위 defaultQuestionsFor).
  //  2) 「심화 질문 생성」: 이력서·지금까지의 질문지·면접 중 메모를 보고 겹치지 않는 후속 질문을 덧붙인다.
  //  3) 「역제안 질문 생성」: 역제안 포지션을 적은 뒤, 그 포지션 질문만 덧붙인다.
  // 2)·3)은 HR 어시스턴트 다리(scripts/claude-assistant-bridge.mjs)가 만든다. 어시스턴트 화면과 같은 규칙·같은 회사 사업 정보를 쓴다.
  const [questionStatus, setQuestionStatus] = useState<"idle" | "DEEP_DIVE" | "COUNTER">("idle");
  const [questionMessage, setQuestionMessage] = useState(openedWithDefaultQuestions
    ? "면접 일정이 확정되어 지원 포지션 기본 질문지를 채워 두었습니다. 「변경사항 저장」을 눌러야 반영됩니다." : "");

  function changeInterviewDate(date: string) {
    const sheet = date && !schedule.questions?.trim() ? defaultQuestionsFor(draft.role || applicant.role, draft.requisitionId) : null;
    setSchedule({ ...schedule, date, ...(sheet ? { questions: sheet.text } : {}) });
    if (sheet) setQuestionMessage(`면접 일정이 확정되어 「${sheet.familyLabel}」 기본 질문지를 채웠습니다. 「변경사항 저장」을 눌러야 반영됩니다.`);
    setInterviewMessageOverride(null);
  }

  async function generateInterviewQuestions(mode: "DEEP_DIVE" | "COUNTER") {
    if (!applicant.resumeText) { setQuestionMessage("등록된 이력서 원문이 없어 질문을 만들 수 없습니다."); return; }
    const counterPosition = schedule.counterProposal?.trim() ?? "";
    if (mode === "COUNTER" && !counterPosition) { setQuestionMessage("역제안 포지션을 먼저 입력해 주세요."); return; }
    // 면접 중에 적고 있는 결과와 최근 면접 메모를 넘겨, 그 답변을 더 파고드는 질문이 나오게 한다.
    const interviewNotes = [interviewResult.trim(), ...(applicant.interviewMemos ?? []).slice(0, 3).map((memo) => memo.text)]
      .filter(Boolean).join("\n---\n").slice(0, 3000);
    setQuestionStatus(mode);
    setQuestionMessage(mode === "COUNTER"
      ? `역제안 포지션(${counterPosition}) 질문을 만들고 있습니다. 30초~1분 걸립니다.`
      : "이력서와 지금까지의 질문지·면접 메모를 보고 심화 질문을 만들고 있습니다. 30초~1분 걸립니다.");
    try {
      // 서버의 /api/assistant 가 데스크탑 안의 Claude CLI 다리를 대신 부른다. 브라우저가 로컬 다리를 직접 부르면
      // 태블릿 등 다른 기기에서는 그 기기 자신을 가리켜 항상 실패했다(어시스턴트 패널과 같은 경로).
      // 업무 영역은 쿼리로 보낸다. 서버는 본문을 읽기 전에 이 값으로 인가한다(D23).
      const response = await fetch("/api/assistant?module=hr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          module: "hr",
          question: mode === "COUNTER"
            ? "지원자가 역제안한 포지션에 대한 면접 질문만 만들어 주세요."
            : "기본 질문지 다음 단계로, 이력서와 지금까지의 면접 상황을 보고 지원 포지션 심화 면접 질문을 만들어 주세요.",
          context: {
            module: "HR",
            fileAnalysis: { fileName: applicant.resumeFileName, extractedText: applicant.resumeText },
            interviewBrief: {
              questionMode: mode,
              targetPosition: draft.role || applicant.role,
              // 역제안 질문은 역제안 포지션을 적었을 때만 만든다. 심화 질문에는 넘기지 않는다.
              ...(mode === "COUNTER" && schedule.counterProposal?.trim() ? { counterProposalPosition: schedule.counterProposal.trim() } : {}),
              ...(mode === "DEEP_DIVE" ? { existingQuestions: (schedule.questions ?? "").slice(0, 6000), interviewNotes } : {}),
              companyBusinessProfile: companyInterviewProfile,
            },
            applicants: [{ id: applicant.id, name: applicant.name, role: applicant.role, stage: applicant.stage }],
          },
        }),
      });
      const payload = await response.json() as { interviewQuestions?: InterviewQuestionItem[]; error?: string };
      if (!response.ok || !payload.interviewQuestions?.length) {
        setQuestionMessage(payload.error ?? "질문을 만들지 못했습니다. HR 어시스턴트가 켜져 있는지 확인해 주세요.");
        return;
      }
      // 이미 적어 둔 질문지는 지우지 않고 아래에 잇는다. 앞서 물어본 질문이 사라지면 안 된다.
      // 모드에 맞지 않는 분류가 섞여 오면 걸러 내고, 어느 단계의 질문인지 구분선으로 가른다.
      const items = (payload.interviewQuestions ?? []).filter((item) => mode === "COUNTER"
        ? [...COUNTER_QUESTION_CATEGORIES, "BUSINESS_SCENARIO"].includes(item.category)
        : !COUNTER_QUESTION_CATEGORIES.includes(item.category));
      if (!items.length) { setQuestionMessage("이번 요청에 맞는 질문이 오지 않았습니다. 다시 시도해 주세요."); return; }
      const formatted = formatInterviewQuestions(items);
      const generated = mode === "COUNTER"
        ? (formatted.startsWith(COUNTER_QUESTION_SEPARATOR) ? formatted : `${COUNTER_QUESTION_SEPARATOR}\n\n${formatted}`)
        : `${DEEP_QUESTION_SEPARATOR}\n\n${formatted}`;
      setSchedule((current) => ({
        ...current,
        questions: current.questions?.trim() ? `${current.questions.trim()}\n\n${generated}` : generated,
      }));
      setQuestionMessage(`${mode === "COUNTER" ? "역제안" : "심화"} 질문 ${items.length}개를 질문지 아래에 이어 붙였습니다. 「변경사항 저장」을 눌러야 반영됩니다.`);
    } catch {
      setQuestionMessage("HR 어시스턴트에 연결할 수 없습니다. ERP 서버가 도는 데스크탑에서 ERP 바로가기로 앱을 다시 실행해 주세요.");
    } finally {
      setQuestionStatus("idle");
    }
  }

  // 경력 칸은 이력서를 AI 로 분석해 채운다. 서버는 근무 이력(careerHistory)을 이미 뽑아 준다.
  const [careerStatus, setCareerStatus] = useState<"idle" | "running">("idle");
  const [careerMessage, setCareerMessage] = useState("");

  async function analyzeCareer() {
    if (!applicant.resumeText) { setCareerMessage("등록된 이력서 원문이 없어 분석할 수 없습니다."); return; }
    setCareerStatus("running");
    setCareerMessage("이력서를 분석하고 있습니다. 1~3분 걸릴 수 있습니다.");
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 300_000);
    try {
      const response = await fetch("/api/hr/resume-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: applicant.resumeFileName, resumeText: applicant.resumeText, provider: "local" }),
        signal: controller.signal,
      });
      const payload = await response.json() as { analysis?: ResumeAnalysis; error?: string };
      if (!response.ok || !payload.analysis) {
        setCareerMessage(`${payload.error || "이력서 분석에 실패했습니다."} 화면의 값은 그대로 두었습니다.`);
        return;
      }
      const history = (payload.analysis.careerHistory ?? []).filter((item) => item.company || item.summary);
      if (!history.length) {
        setCareerMessage("이력서에서 근무 이력을 찾지 못했습니다. 화면의 값은 그대로 두었습니다.");
        return;
      }
      setDraft((current) => ({ ...current, careerSummary: formatCareerHistory(history) }));
      setCareerMessage(`근무 이력 ${history.length}건을 찾아 채웠습니다. 「변경사항 저장」을 눌러야 반영됩니다.`);
    } catch (error) {
      setCareerMessage(error instanceof Error && error.name !== "AbortError"
        ? `${error.message} 화면의 값은 그대로 두었습니다.`
        : "분석 시간이 초과되었습니다. 화면의 값은 그대로 두었습니다.");
    } finally {
      window.clearTimeout(timeoutId);
      setCareerStatus("idle");
    }
  }
  const [responseDraft, setResponseDraft] = useState({ employeeId: "", position: "", jobTitle: "", responseNote: "" });
  // 채용요청·TO에 연결된 지원자는 그 요청의 조직으로만 처우 제안을 낼 수 있다(서버가 다른 조직을 거부한다).
  // 예전에는 조직 목록 첫 항목이 기본값이라, 그대로 저장하면 조직 불일치로 거부됐다.
  const linkedRequisition = requisitions.find((item) => item.id === applicant.requisitionId) ?? null;
  const linkedDepartment = organizations.find((item) => item.id === linkedRequisition?.organizationId)?.name ?? "";
  const [offerError, setOfferError] = useState("");
  const [offerDraft, setOfferDraft] = useState({
    proposedTitle: applicant.role, department: applicant.offer?.department || linkedDepartment || organizations[0]?.name || "", employmentType: "일반직4.5",
    startDate: applicant.offer?.startDate ?? "", annualSalary: applicant.offer ? String(applicant.offer.annualSalary) : "",
    probationMonths: applicant.offer ? String(applicant.offer.probationMonths) : "3", firstTermPayPercent: applicant.offer ? String(applicant.offer.firstTermPayPercent ?? 100) : "100", notes: applicant.offer?.notes ?? "",
  });
  const ownerName = recruiters.find((recruiter) => recruiter.id === draft.ownerId)?.name ?? "담당자 미지정";
  const screening = screeningResultOf(applicant);
  const activeOffer = applicant.offer && !["REJECTED", "DECLINED", "CANCELLED"].includes(applicant.offer.status) ? applicant.offer : null;

  async function submitOffer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOfferError("");
    const failure = await onSubmitOffer(applicant.id, {
      proposedTitle: offerDraft.proposedTitle.trim(), department: offerDraft.department,
      employmentType: offerDraft.employmentType, startDate: offerDraft.startDate,
      annualSalary: Number(offerDraft.annualSalary), probationMonths: Number(offerDraft.probationMonths),
      firstTermPayPercent: Number(offerDraft.firstTermPayPercent) || 100,
      notes: offerDraft.notes.trim(),
    });
    // 서버가 거부하면(조직 불일치·TO 마감 등) 입력값을 지키고 팝업 안에 사유를 남긴다. 예전에는 응답을 기다리지 않고 닫았다.
    if (failure) { setOfferError(failure); return; }
    // 합격 판단 근거를 처우와 함께 남긴다. 금액만 남고 이유가 사라지면 결정을 설명할 수 없다.
    if (interviewResult.trim()) onSaveMemo(applicant.id, `면접 결과(합격): ${interviewResult.trim()}`);
    setInterviewResult("");
    setPassModalOpen(false);
  }

  // 면접 합격. 단계와 메모를 한 번에 저장한다 — 따로 부르면 나중 호출이 앞선 단계 변경을 덮어쓴다.
  // 처우는 아직 제안하지 않은 상태이고, 아래 처우 제안 단계 박스가 이때부터 열린다.
  async function passInterview() {
    if (!(await dialog.confirm(`${applicant.name} 지원자를 면접 합격으로 기록합니다. 계속할까요?`, { title: "면접 합격", confirmLabel: "합격 기록" }))) return;
    const text = interviewResult.trim() ? `면접 결과(합격): ${interviewResult.trim()}` : "면접 결과(합격)";
    onSave({
      ...applicant,
      stage: INTERVIEW_PASSED_STAGE,
      interviewMemos: [{ id: `IN-${Date.now()}`, text, author: ownerName, createdAt: new Date().toISOString() }, ...(applicant.interviewMemos ?? [])],
    });
    setInterviewResult("");
  }

  async function rejectInterview(attended: boolean) {
    const label = attended ? "면접 후 탈락" : "면접 불참 탈락";
    if (!(await dialog.confirm(`${applicant.name} 지원자를 ${label}으로 기록합니다. 계속할까요?`, { title: "면접 탈락", confirmLabel: "탈락 기록", danger: true }))) return;
    const prefix = attended ? "면접 결과(탈락)" : "면접 불참(탈락)";
    onRejectInterview(applicant.id, interviewResult.trim() ? `${prefix}: ${interviewResult.trim()}` : prefix, attended);
    setInterviewResult("");
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveChanges();
  }

  // 팝업 상단·하단의 「변경사항 저장」과 지원 정보 상세의 「변경사항 저장」이 같은 저장을 탄다.
  // 필수값이 비어 저장하지 못하면 false 를 돌려 상세 창을 닫지 않는다.
  function saveChanges() {
    // 이름·직무·이메일 입력칸이 「지원 정보 상세」 팝업으로 빠져 form 밖에 있다.
    // 브라우저의 required 검사가 닿지 않으므로 여기서 직접 막고, 고칠 자리를 열어 준다.
    if (!draft.name.trim() || !draft.role.trim() || !draft.email.trim()) {
      setFieldsModalOpen(true);
      void dialog.alert("지원 정보 상세에서 이름·지원 직무·이메일을 입력해 주세요.", { title: "입력 필요" });
      return false;
    }
    const newNote: RecruitmentNote | null = note.trim() ? {
      id: `AN-${Date.now()}`,
      text: note.trim(),
      author: ownerName,
      createdAt: new Date().toISOString(),
    } : null;
    // 면접 일정도 이 저장에 같이 실린다. 예전에는 "면접 일정 저장" 버튼으로만 반영돼서, 일정을
    // 고치고 위아래의 저장 버튼을 누르면 고친 내용이 조용히 사라졌다.
    // 아직 아무것도 적지 않은 지원자에게 빈 일정을 새로 만들어 붙이지는 않는다.
    const scheduleFilled = [schedule.date, schedule.time, schedule.interviewers, schedule.location, schedule.note, schedule.questions, schedule.counterProposal].some(Boolean);
    onSave({
      ...applicant,
      ...draft,
      name: draft.name.trim(),
      role: draft.role.trim(),
      email: draft.email.trim(),
      phone: draft.phone.trim(),
      owner: ownerName,
      interview: scheduleFilled || applicant.interview ? schedule : applicant.interview,
      screeningMemos: newNote ? [newNote, ...(applicant.screeningMemos ?? [])] : applicant.screeningMemos ?? [],
    });
    setNote("");
    return true;
  }

  return <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <form
      className={`applicant-detail-modal applicant-edit-modal${condensed ? " condensed" : ""}`}
      onSubmit={submit}

      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setCondensed((current) => nextCondensed(current, top));
      }}
    >
      <div className="modal-header"><div data-korean-heading><h2>지원자 정보 확인 및 수정</h2></div><div className="modal-header-actions"><button type="submit" className="header-save-button">변경사항 저장</button><button type="button" onClick={onClose} aria-label="닫기">×</button></div></div>
      {/* 이름 아래 연락처는 자주 보는 값이라 상세를 열지 않아도 여기서 바로 보이게 둔다.
          나머지 지원 정보는 「지원 정보 상세」 팝업에서 고친다. */}
      <div className="applicant-profile">
        <div className="applicant-profile-name">
          <div className="applicant-profile-title">
            <h2>{draft.name || "지원자"}</h2>
            <button type="button" className="applicant-fields-open" onClick={() => setFieldsModalOpen(true)}>지원 정보 상세</button>
          </div>
          <p>{draft.role || "지원 직무 미입력"} · {draft.experience || "경력 미입력"}</p>
          <div className="applicant-profile-contact">
            <span>연락처 <em>{draft.phone || "미입력"}</em></span>
            <span>이메일 <em>{draft.email || "미입력"}</em></span>
          </div>
        </div>
        <StatusPill value={applicant.stage} />
      </div>
      {/* 서류 합불과 그때 남기는 메모는 늘 같이 보게 되므로 한 칸으로 합쳤다.
          아래 면접·처우 칸과 같은 카드 여백(좌우 24px)을 써서 팝업 안에서 줄이 맞는다. */}
      <section className="applicant-screening-block">
        <div className="detail-card-heading">
          <div><h3>서류 심사 및 특이사항 기록</h3></div>
          <span className="applicant-note-count">{(applicant.screeningMemos ?? []).length}건</span>
        </div>
        <p className="applicant-screening-hint">{screening === "PENDING" ? "아직 서류 합불을 처리하지 않았습니다."
          : screening === "PASSED" ? "서류 합격으로 처리되어 있습니다. 아래에서 면접을 진행하세요."
          : "서류 탈락으로 처리되어 있습니다."}</p>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="지원자 확인사항, 연락 내용, 추후 확인할 내용을 기록하세요." />
        {(applicant.screeningMemos ?? []).length > 0 && <div className="applicant-note-history">{(applicant.screeningMemos ?? []).map((item) => <article key={item.id}><p>{item.text}</p><span>{item.author} · {new Date(item.createdAt).toLocaleString("ko-KR")}</span></article>)}</div>}
        {/* 평가중일 때만 합불 두 버튼을 보여 주고, 한 번 정하면 그 자리에 결과만 남긴다.
            잘못 눌렀을 때를 위해 「평가중으로 되돌리기」는 결과 옆에 계속 둔다. */}
        <div className="applicant-screening-actions">
          {screening === "PENDING" ? <>
            <button type="button" className="interview-action" onClick={() => onDecideScreening(applicant.id, "PASS")}>서류 합격</button>
            <button type="button" className="reject-action" onClick={() => onDecideScreening(applicant.id, "REJECT")}>서류 탈락</button>
          </> : <>
            <span className={`screening-stage ${screening.toLowerCase()}`}>{screeningLabels[screening]}</span>
            <button type="button" onClick={() => onDecideScreening(applicant.id, "RESET")}>평가중으로 되돌리기</button>
          </>}
        </div>
      </section>

      {screening === "PASSED" && <section className="applicant-interview-block">
        <div className="detail-card-heading"><div><h3>면접 일정과 결과</h3></div>
          {activeOffer && <StatusPill value={activeOffer.status === "ACCEPTED" ? "입사 예정" : activeOffer.status === "ONBOARDED" ? "입사 완료" : "처우 저장됨"} />}</div>
        <div className="form-grid">
          <label><span>면접일</span><input type="date" value={schedule.date} onChange={(event) => changeInterviewDate(event.target.value)} /></label>
          <label><span>시작 시간</span><input type="time" value={schedule.time} onChange={(event) => { setSchedule({ ...schedule, time: event.target.value }); setInterviewMessageOverride(null); }} /></label>
        </div>

        {/* 면접일·시작 시간이 다 들어오면 그 자리에서 안내문을 만든다. 저장 전 입력값을 그대로 쓰므로 적으면서
            바로 보이고, 합격·탈락을 정한 뒤에는 보낼 일이 없어 감춘다. */}
        {!OFFER_STAGES.includes(applicant.stage) && !REJECTED_STAGES.includes(applicant.stage) && messageComposer({
          templateId: "INTERVIEW",
          title: "면접 안내 메시지",
          hint: schedule.date && schedule.time ? "입력한 면접일·시작 시간으로 자동 작성됩니다" : "면접일과 시작 시간을 입력하면 일시가 채워집니다 — 지금은 자리표시로 보입니다",
          tokens: interviewMessageTokens(applicant, schedule),
          tokenNames: INTERVIEW_TEMPLATE_TOKENS,
          override: interviewMessageOverride,
          setOverride: setInterviewMessageOverride,
          rows: 12,
        })}

        {/* 왼쪽은 면접 전에 준비하는 질문지, 오른쪽은 면접 뒤에 적는 결과. 순서대로 쓰게 나란히 둔다. */}
        <div className="applicant-interview-split">
          <div className="applicant-interview-pane">
            <label className="form-note"><span>면접 질문지</span>
              <textarea value={schedule.questions ?? ""} onChange={(event) => setSchedule({ ...schedule, questions: event.target.value })}
                placeholder="면접일을 입력하면 지원 포지션의 기본 질문지가 채워집니다. 면접 상황에 따라 아래 버튼으로 심화·역제안 질문을 덧붙입니다." />
            </label>
            <div className="applicant-interview-pane-actions">
              <label className={`applicant-counter-proposal${counterTone ? ` ${counterTone}` : ""}`}><span>역제안 포지션{counterBadge && <em className="applicant-counter-badge">{counterBadge}</em>}</span><input value={schedule.counterProposal ?? ""} onChange={(event) => setSchedule({ ...schedule, counterProposal: event.target.value })} placeholder="지원자가 지원한 자리 대신 다른 포지션을 제안했다면 적으세요. 비워 두면 지원 직무만 기준으로 질문을 만듭니다." /></label>
              <div className="applicant-question-buttons">
                <button type="button" className="outline-button" disabled={questionStatus !== "idle" || !applicant.resumeText}
                  title={applicant.resumeText ? "이력서와 지금까지의 질문지·면접 메모를 보고 겹치지 않는 후속 질문을 덧붙입니다" : "등록된 이력서 원문이 없어 만들 수 없습니다"}
                  onClick={() => void generateInterviewQuestions("DEEP_DIVE")}>{questionStatus === "DEEP_DIVE" ? "심화 질문 생성 중" : "심화 질문 생성"}</button>
                <button type="button" className="outline-button" disabled={questionStatus !== "idle" || !applicant.resumeText || !schedule.counterProposal?.trim()}
                  title={!schedule.counterProposal?.trim() ? "역제안 포지션을 입력하면 켜집니다" : applicant.resumeText ? "역제안 포지션에 대한 질문만 덧붙입니다" : "등록된 이력서 원문이 없어 만들 수 없습니다"}
                  onClick={() => void generateInterviewQuestions("COUNTER")}>{questionStatus === "COUNTER" ? "역제안 질문 생성 중" : "역제안 질문 생성"}</button>
              </div>
            </div>
            {questionMessage && <p className="applicant-screening-hint">{questionMessage}</p>}
          </div>
          <div className="applicant-interview-pane">
            <label className="form-note"><span>면접 결과</span>
              <textarea value={interviewResult} onChange={(event) => setInterviewResult(event.target.value)}
                placeholder="면접에서 확인한 역량, 평가 의견, 합격·탈락 판단 근거를 기록하세요." />
            </label>
            <p className="applicant-screening-hint">입력한 내용은 면접 메모에 함께 저장됩니다. 합격을 누르면 아래에 처우 제안 단계가 열립니다.</p>
          </div>
        </div>
        <div className="applicant-screening-actions">
          <button type="button" className="reject-action" onClick={() => rejectInterview(false)}>면접 불참 탈락</button>
          <button type="button" className="reject-action" onClick={() => rejectInterview(true)}>면접 후 탈락</button>
          <button type="button" className="primary-button" disabled={OFFER_STAGES.includes(applicant.stage)} onClick={passInterview}>면접 합격</button>
        </div>

        {/* 합격에 처우 오퍼 안내문이 딸려 나오듯, 탈락에도 안내문이 딸려 나온다. 탈락 통보는 미루면
            안 하게 되는 일이라, 눌러 기록한 자리에서 바로 보낼 글이 만들어져 있어야 한다.
            면접에 오지 않은 사람에게는 면접을 진행했다는 문장이 나가면 안 되므로 그 줄만 꺼 둔다. */}
        {[INTERVIEW_REJECTED_STAGE, INTERVIEW_NO_SHOW_STAGE].includes(applicant.stage) && (() => {
          const mentionInterview = rejectionInterviewOn ?? applicant.stage === INTERVIEW_REJECTED_STAGE;
          const interviewDate = rejectionInterviewDate ?? schedule.date;
          return messageComposer({
            templateId: "REJECTION",
            title: "불합격 안내 메시지",
            hint: "면접 결과로 자동 작성됩니다",
            tokens: rejectionMessageTokens(applicant, { interviewDate, mentionInterview, mentionReapply: rejectionReapplyOn }),
            tokenNames: REJECTION_TEMPLATE_TOKENS,
            override: rejectionMessageOverride,
            setOverride: setRejectionMessageOverride,
            rows: 16,
            controls: <div className="offer-message-controls">
              <label><span>면접일</span><input type="date" disabled={!mentionInterview} value={interviewDate} onChange={(event) => { setRejectionInterviewDate(event.target.value); setRejectionMessageOverride(null); }} /></label>
              <label className="offer-message-toggle">
                <input type="checkbox" checked={mentionInterview} onChange={(event) => { setRejectionInterviewOn(event.target.checked); setRejectionMessageOverride(null); }} />
                <span>면접 진행 문구 포함</span>
              </label>
              <label className="offer-message-toggle">
                <input type="checkbox" checked={rejectionReapplyOn} onChange={(event) => { setRejectionReapplyOn(event.target.checked); setRejectionMessageOverride(null); }} />
                <span>재지원 안내 포함</span>
              </label>
            </div>,
          });
        })()}
        {(applicant.interviewMemos ?? []).length > 0 && <div className="applicant-note-history">{(applicant.interviewMemos ?? []).map((item) => <article key={item.id}><p>{item.text}</p><span>{item.author} · {new Date(item.createdAt).toLocaleString("ko-KR")}</span></article>)}</div>}

      </section>}

      {/* 면접 합격 뒤의 단계. 처우를 제안하고, 지원자 회신에 따라 수락·거절로 갈린다.
          제안이 없으면 수락·거절을 누를 수 없다 — 제안하지 않은 처우를 수락할 수는 없다. */}
      {OFFER_STAGES.includes(applicant.stage) && <section className="applicant-offer-block">
        <div className="detail-card-heading"><div><h3>처우 제안 단계</h3></div>
          {applicant.offer && <StatusPill value={applicant.offer.status === "ACCEPTED" ? "입사 예정"
            : applicant.offer.status === "DECLINED" ? "제안 거절" : applicant.offer.status === "ONBOARDED" ? "입사 완료" : "제안 완료"} />}</div>

        {activeOffer ? <>
          <div className="applicant-offer-summary">
            <div><span>제안 직무</span><strong>{activeOffer.proposedTitle}</strong></div>
            <div><span>소속</span><strong>{activeOffer.department}</strong></div>
            <div><span>입사예정일</span><strong>{activeOffer.startDate}</strong></div>
            <div><span>연봉</span><strong>{activeOffer.annualSalary.toLocaleString("ko-KR")}원</strong></div>
            <div><span>첫 계약 지급률</span><strong>{activeOffer.firstTermPayPercent ?? 100}%</strong></div>
            <p>제안한 처우입니다. 지원자 회신에 따라 아래에서 수락 또는 거절을 기록하세요.</p>
          </div>
          {/* 승낙 전에는 합격 안내문, 승낙 뒤에는 입사 안내문을 보여 준다. 단계마다 보낼 글이 다르다.
              평소에는 값이 채워진 완성본을 보여 주고, 「기본 문구 편집」을 켜면 {{토큰}} 이 그대로 있는
              원본을 고쳐 서버에 저장한다 — 저장한 문구는 이후 모든 지원자에게 쓰인다. */}
          {(() => {
            const accepted = ["ACCEPTED", "ONBOARDED"].includes(activeOffer.status);
            return accepted
              ? messageComposer({
                templateId: "ONBOARDING",
                title: "입사 안내 메시지",
                hint: "승낙한 처우의 입사일로 자동 작성됩니다",
                tokens: onboardingMessageTokens(applicant, activeOffer, onboardDocIds),
                tokenNames: ONBOARDING_TEMPLATE_TOKENS,
                override: onboardMessageOverride,
                setOverride: setOnboardMessageOverride,
                rows: 22,
                controls: <div className="offer-message-docs">
                  <span>선택 제출 서류</span>
                  {ONBOARDING_OPTIONAL_DOCS.map((doc) => <label key={doc.id} className="offer-message-toggle">
                    <input type="checkbox" checked={onboardDocIds.includes(doc.id)} onChange={(event) => {
                      setOnboardDocIds(event.target.checked
                        ? [...onboardDocIds, doc.id]
                        : onboardDocIds.filter((id) => id !== doc.id));
                      setOnboardMessageOverride(null);
                    }} />
                    <span>{doc.label}</span>
                  </label>)}
                </div>,
              })
              : messageComposer({
                templateId: "OFFER",
                title: "합격 안내 메시지",
                hint: "처우 제안 값으로 자동 작성됩니다",
                tokens: offerMessageTokens(applicant, activeOffer, { replyDue: clampOfferReplyDue(offerReplyDue, activeOffer.startDate), firstTerm: offerFirstTermOn ? { percent: String(activeOffer.firstTermPayPercent ?? 100) } : null }),
                tokenNames: OFFER_TEMPLATE_TOKENS,
                override: offerMessageOverride,
                setOverride: setOfferMessageOverride,
                rows: 18,
                controls: <div className="offer-message-controls">
                  <label><span>회신 기한{clampOfferReplyDue(offerReplyDue, activeOffer.startDate) !== offerReplyDue && <em className="offer-reply-adjusted"> · 입사예정일에 맞춰 {koreanDate(clampOfferReplyDue(offerReplyDue, activeOffer.startDate))}로 조정됨</em>}</span><input type="date" value={offerReplyDue} max={/^\d{4}-\d{2}-\d{2}$/.test(activeOffer.startDate) ? shiftIsoDate(activeOffer.startDate, -1) : undefined} onChange={(event) => { setOfferReplyDue(event.target.value); setOfferMessageOverride(null); }} /></label>
                  <label className="offer-message-toggle">
                    <input type="checkbox" checked={offerFirstTermOn} onChange={(event) => { setOfferFirstTermOn(event.target.checked); setOfferMessageOverride(null); }} />
                    <span>첫 계약 안내 포함</span>
                  </label>
                  <label><span>첫 계약 지급률 · 처우 제안 값</span><input readOnly value={`${activeOffer.firstTermPayPercent ?? 100}% · ${FIXED_TERM_MONTHS}개월 기간제`} title="처우 제안에서 정한 값입니다. 바꾸려면 처우를 다시 확정하세요." /></label>
                </div>,
              });
          })()}
        </> : <p className="applicant-screening-hint">아직 처우를 제안하지 않았습니다. 「처우 제안」을 눌러 입사예정일과 연봉을 입력하세요.</p>}

        {/* 제안 전에는 "처우 제안" 하나, 제안을 저장하면 그 자리가 "제안 수락"으로 바뀌고
            옆에 "제안 거절"이 함께 나타난다. 두 버튼은 모양이 같고 색만 다르다. */}
        <div className="applicant-offer-steps">
          {!activeOffer
            ? <button type="button" className="primary-button" onClick={() => { setOfferError(""); setPassModalOpen(true); }}>처우 제안</button>
            : <div className="applicant-offer-response-actions">
            <button type="button" className="offer-decision accept" disabled={activeOffer.status !== "APPROVED"}
              onClick={() => {
                // 기본값은 앞서 제안한 처우. 협의로 달라졌으면 이 팝업에서 고쳐 확정한다.
                if (activeOffer) setFinalOffer({
                  startDate: activeOffer.startDate, annualSalary: String(activeOffer.annualSalary),
                  department: activeOffer.department, proposedTitle: activeOffer.proposedTitle,
                  employmentType: activeOffer.employmentType, probationMonths: String(activeOffer.probationMonths),
                  firstTermPayPercent: String(activeOffer.firstTermPayPercent ?? 100),
                });
                setResponseCondensed(false); setAcceptModalOpen(true);
              }}>제안 수락</button>
            <button type="button" className="offer-decision decline" disabled={activeOffer.status !== "APPROVED"}
              onClick={() => { setDeclineReason(""); setResponseCondensed(false); setDeclineModalOpen(true); }}>제안 거절</button>
          </div>}
        </div>
      </section>}

      <div className="applicant-edit-footer"><div><span>지원일 {applicant.applied}</span><span>지원자 ID {applicant.id}</span></div><div><button type="button" onClick={onClose}>닫기</button><button type="submit" className="primary-button">변경사항 저장</button></div></div>
    </form>
    {/* 지원 정보 상세. 팝업 안에 다 펼쳐 두면 면접·처우가 한참 아래로 밀려서 따로 뺐다.
        입력칸은 모두 draft 상태를 그대로 쓰므로, 여기서 고쳐도 바깥의 「변경사항 저장」으로 함께 저장된다. */}
    {fieldsModalOpen && <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setFieldsModalOpen(false); }}>
      <section className="employee-modal applicant-fields-modal" role="dialog" aria-modal="true" aria-label={`${applicant.name} 지원 정보 상세`} >
        <div className="modal-header"><div><h2>지원 정보 상세</h2></div><button type="button" aria-label="닫기" onClick={() => setFieldsModalOpen(false)}>×</button></div>
            <section className="applicant-edit-fields">
              {/* 3열 2행. 채용담당자와 지원 경로는 여기서 적지 않기로 해 뺐다 —
                  값 자체는 draft 에 그대로 남아 저장 시 다시 쓰인다. */}
              <div className="form-grid applicant-fields-grid">
                <label><span>이름 *</span><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label><span>지원 직무 *</span><input required value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} /></label>
                <label><span>이메일 *</span><input required type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>
                <label><span>연락처</span><input value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} /></label>
                <label><span>생년월일</span><input type="date" value={draft.birth} onChange={(event) => setDraft({ ...draft, birth: event.target.value })} /></label>
                <label className="wide"><span>주소</span><input value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="근로계약서 서명란에 들어갑니다" /></label>
                <label><span>경력</span><input value={draft.experience} onChange={(event) => setDraft({ ...draft, experience: event.target.value })} /></label>
                <label><span>채용요청·TO</span><select value={draft.requisitionId} onChange={(event) => setDraft({ ...draft, requisitionId: event.target.value })}><option value="">예외·미연결</option>{requisitions.filter((item) => item.status === "OPEN" || item.id === applicant.requisitionId).map((item) => <option key={item.id} value={item.id}>{item.title} · {item.role}</option>)}</select></label>
              </div>
              {/* 경력과 이력서 요약을 갈라 적는다. 경력은 이력서를 AI 로 분석해 근무처와
                  거기서 한 일을 뽑아 채우고, 이력서 요약은 지금까지 쓰던 전체 요약 그대로다. */}
              <label className="form-note">
                <span className="applicant-career-label">경력 상세
                  <button type="button" className="applicant-career-analyze" disabled={careerStatus === "running" || !applicant.resumeText}
                    onClick={() => void analyzeCareer()}>{careerStatus === "running" ? "분석 중" : "AI로 이력서 분석"}</button>
                </span>
                <textarea className="applicant-career-text" value={draft.careerSummary} placeholder="근무한 회사와 기간, 그곳에서 맡은 업무를 적습니다. 「AI로 이력서 분석」을 누르면 이력서에서 뽑아 채웁니다."
                  onChange={(event) => setDraft({ ...draft, careerSummary: event.target.value })} />
              </label>
              {careerMessage && <p className="applicant-career-message">{careerMessage}</p>}
              <label className="form-note"><span>이력서 요약</span><textarea value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label>
            </section>
        <div className="modal-actions">
          <span className="applicant-fields-hint">저장하면 지원자 정보가 반영되고 이 창이 닫힙니다. 저장하지 않고 닫으려면 × 를 누르세요.</span><button type="button" className="primary-button" onClick={() => { if (saveChanges()) setFieldsModalOpen(false); }}>변경사항 저장</button>
        </div>
      </section>
    </HrModalBackdrop>}
    {acceptModalOpen && activeOffer && <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAcceptModalOpen(false); }}>
      <form className={`employee-modal offer-response-modal${responseCondensed ? " condensed" : ""}`} onScroll={(event) => { const top = event.currentTarget.scrollTop; setResponseCondensed((current) => nextCondensed(current, top)); }}  onSubmit={(event) => {
        event.preventDefault();
        onRespondOffer(applicant.id, activeOffer.id, "ACCEPT", {
          employeeId: responseDraft.employeeId.trim(), position: responseDraft.position.trim(),
          jobTitle: responseDraft.jobTitle.trim(), responseNote: responseDraft.responseNote,
          startDate: finalOffer.startDate, annualSalary: Number(finalOffer.annualSalary),
          probationMonths: Number(finalOffer.probationMonths), firstTermPayPercent: Number(finalOffer.firstTermPayPercent) || 100, department: finalOffer.department.trim(),
          proposedTitle: finalOffer.proposedTitle.trim(), employmentType: finalOffer.employmentType,
        });
        setAcceptModalOpen(false);
      }}>
        <div className="modal-header"><div data-korean-heading><h2>{applicant.name} 최종 처우 확정</h2></div><button type="button" aria-label="닫기" onClick={() => setAcceptModalOpen(false)}>×</button></div>
        <p className="optional-form-notice">기본값은 앞서 제안한 처우입니다. 협의로 달라졌다면 고친 뒤 확정하세요. 확정하면 입사 예정자로 바뀝니다.</p>
        <div className="form-grid">
          <label><span>입사예정일 *</span><input required type="date" value={finalOffer.startDate} onChange={(event) => setFinalOffer({ ...finalOffer, startDate: event.target.value })} /></label>
          <label htmlFor={`offer-${applicant.id}-salary`}><span>연봉 *</span><WonInput id={`offer-${applicant.id}-salary`} ariaLabel="최종 연봉" value={Number(finalOffer.annualSalary) || 0} onValueChange={(value) => setFinalOffer({ ...finalOffer, annualSalary: String(value) })} /></label>
          <label><span>소속 *</span><select value={finalOffer.department} onChange={(event) => setFinalOffer({ ...finalOffer, department: event.target.value })}>{organizations.map((organization) => <option key={organization.id}>{organization.name}</option>)}</select></label>
          <label><span>제안 직무 *</span><input required value={finalOffer.proposedTitle} onChange={(event) => setFinalOffer({ ...finalOffer, proposedTitle: event.target.value })} /></label>
          <label><span>고용형태</span><select value={finalOffer.employmentType} onChange={(event) => setFinalOffer({ ...finalOffer, employmentType: event.target.value })}><option>일반직4.5</option><option>일반직</option><option>계약직</option><option>인턴</option></select></label>
          <label><span>수습(개월)</span><input type="number" min="0" max="12" value={finalOffer.probationMonths} onChange={(event) => setFinalOffer({ ...finalOffer, probationMonths: event.target.value })} /></label>
          <label><span>첫 계약 지급률(%) *</span><input required type="number" min="1" max="100" step="1" value={finalOffer.firstTermPayPercent} onChange={(event) => setFinalOffer({ ...finalOffer, firstTermPayPercent: event.target.value })} /></label>
          <label><span>신규 사번 *</span><input required value={responseDraft.employeeId} onChange={(event) => setResponseDraft({ ...responseDraft, employeeId: event.target.value })} placeholder="예: gd.hong" /></label>
          <label><span>입사 직위 *</span><select required value={responseDraft.position} onChange={(event) => setResponseDraft({ ...responseDraft, position: event.target.value })}><option value="">직위 선택</option>{ranks.map((rank) => <option key={rank}>{rank}</option>)}</select></label>
          <label><span>직무 *</span><select required value={responseDraft.jobTitle} onChange={(event) => setResponseDraft({ ...responseDraft, jobTitle: event.target.value })}><option value="">직무 선택</option>{jobTitles.filter((title) => title !== "조직장").map((title) => <option key={title}>{title}</option>)}</select></label>
          <label className="wide"><span>회신 메모</span><textarea value={responseDraft.responseNote} onChange={(event) => setResponseDraft({ ...responseDraft, responseNote: event.target.value })} placeholder="수락일, 협의사항을 기록하세요." /></label>
        </div>
        <div className="modal-actions"><button type="button" onClick={() => setAcceptModalOpen(false)}>취소</button><button type="submit" className="primary-button">확정</button></div>
      </form>
    </HrModalBackdrop>}

    {declineModalOpen && activeOffer && <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeclineModalOpen(false); }}>
      <form className={`employee-modal offer-response-modal${responseCondensed ? " condensed" : ""}`} onScroll={(event) => { const top = event.currentTarget.scrollTop; setResponseCondensed((current) => nextCondensed(current, top)); }}  onSubmit={(event) => {
        event.preventDefault();
        onRespondOffer(applicant.id, activeOffer.id, "DECLINE", { responseNote: declineReason.trim(), declineKind });
        setDeclineModalOpen(false);
      }}>
        <div className="modal-header"><div data-korean-heading><h2>{applicant.name} 제안 거절 기록</h2></div><button type="button" aria-label="닫기" onClick={() => setDeclineModalOpen(false)}>×</button></div>
        <p className="optional-form-notice">{declineKind === "OTHER_OFFER"
          ? "확정하면 채용단계가 「타사 합격」으로 바뀝니다. 우리가 떨어뜨린 것이 아니라 지원자가 다른 회사로 간 경우입니다."
          : "확정하면 제안 거절자로 바뀝니다. 사유는 채용 이력으로 남습니다."}</p>
        <div className="form-grid">
          <label className="wide"><span>거절 구분 *</span><select value={declineKind} onChange={(event) => setDeclineKind(event.target.value as "OFFER" | "OTHER_OFFER")}>
            <option value="OFFER">제안 거절 (처우 조건·개인 사정 등)</option>
            <option value="OTHER_OFFER">타사 합격 (다른 회사 입사 확정)</option>
          </select></label>
          <label className="wide"><span>거절 사유 *</span><textarea required value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} placeholder="처우 조건, 타사 입사 확정 등 지원자가 밝힌 사유를 기록하세요." /></label>
        </div>
        <div className="modal-actions"><button type="button" onClick={() => setDeclineModalOpen(false)}>취소</button><button type="submit" className="danger-confirm">확정</button></div>
      </form>
    </HrModalBackdrop>}

    {passModalOpen && <HrModalBackdrop className="modal-backdrop" role="presentation" >
      <form className="employee-modal interview-pass-modal" onSubmit={submitOffer}>
        <div className="modal-header"><div data-korean-heading><h2>{applicant.name} 처우 제안 입력</h2></div><button type="button" aria-label="닫기" onClick={() => setPassModalOpen(false)}>×</button></div>
        <div className="form-grid">
          <label><span>제안 직무 *</span><input required value={offerDraft.proposedTitle} onChange={(event) => setOfferDraft({ ...offerDraft, proposedTitle: event.target.value })} /></label>
          {linkedDepartment ? <label><span>소속 조직 *</span><select value={linkedDepartment} disabled aria-describedby="offer-department-note"><option>{linkedDepartment}</option></select></label> : <label><span>소속 조직 *</span><select required value={offerDraft.department} onChange={(event) => setOfferDraft({ ...offerDraft, department: event.target.value })}>{organizations.map((organization) => <option key={organization.id}>{organization.name}</option>)}</select></label>}
          <label><span>고용형태 *</span><select value={offerDraft.employmentType} onChange={(event) => setOfferDraft({ ...offerDraft, employmentType: event.target.value })}><option>일반직4.5</option><option>일반직</option><option>계약직</option><option>인턴</option></select></label>
          <label><span>입사예정일 *</span><input required type="date" value={offerDraft.startDate} onChange={(event) => setOfferDraft({ ...offerDraft, startDate: event.target.value })} /></label>
          <label><span>연봉 *</span><input required type="number" min="1" value={offerDraft.annualSalary} onChange={(event) => setOfferDraft({ ...offerDraft, annualSalary: event.target.value })} /></label>
          <label><span>수습기간(개월) *</span><input required type="number" min="0" max="12" value={offerDraft.probationMonths} onChange={(event) => setOfferDraft({ ...offerDraft, probationMonths: event.target.value })} /></label>
          {/* 첫 계약(3개월 기간제) 동안 기준 연봉의 몇 %를 줄지. 사람마다 달라 여기서 정하고, 입사 전환 때 인사기록카드로 넘어간다. */}
          <label><span>첫 계약 지급률(%) *</span><input required type="number" min="1" max="100" step="1" value={offerDraft.firstTermPayPercent} onChange={(event) => setOfferDraft({ ...offerDraft, firstTermPayPercent: event.target.value })} /></label>
          <label className="wide"><span>처우 협의 메모</span><textarea value={offerDraft.notes} onChange={(event) => setOfferDraft({ ...offerDraft, notes: event.target.value })} placeholder="처우 협의 조건과 지원자에게 안내할 사항을 기록하세요." /></label>
        </div>
        {interviewResult.trim() && <p className="applicant-screening-hint">면접 결과도 함께 저장됩니다: {interviewResult.trim()}</p>}
        {linkedDepartment && linkedRequisition && <p id="offer-department-note" className="applicant-screening-hint">소속 조직은 연결된 채용요청 「{linkedRequisition.title}」의 조직({linkedDepartment})으로 고정됩니다.</p>}
        {offerError && <p className="applicant-screening-hint offer-error" role="alert">{offerError}</p>}
        <div className="modal-actions">
          <button type="button" onClick={() => setPassModalOpen(false)}>취소</button>
          <button type="submit" className="primary-button">처우 제안 저장</button>
        </div>
      </form>
    </HrModalBackdrop>}
  </HrModalBackdrop>;
}

function PersonnelActionModal({ employee, ranks, organizations, onClose, onSubmit }: { employee: Employee; ranks: string[]; organizations: Organization[]; onClose: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const [actionType, setActionType] = useState<PersonnelActionType>("인사이동(전보)");
  const departments = organizations.map((organization) => organization.name);
  const currentRank = ranks.indexOf(employee.position);
  const availableRanks = actionType === "승진"
    ? ranks.filter((_, index) => currentRank < 0 || index > currentRank)
    : ranks.filter((_, index) => currentRank < 0 || index < currentRank);
  const actionHelp = actionType === "인사이동(전보)"
    ? "현재 소속과 다른 부서로 이동합니다."
    : actionType === "승진"
      ? "현재보다 높은 직위으로 변경합니다."
      : "현재보다 낮은 직위으로 변경하며 정당한 사유가 반드시 필요합니다.";

  return <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={onClose}><form className="employee-modal personnel-modal" onSubmit={onSubmit} ><div className="modal-header"><div data-korean-heading><h2>인사 발령 등록</h2></div><button type="button" onClick={onClose}>×</button></div><div className="candidate-banner"><span>{employee.name.slice(0, 1)}</span><div><strong>{employee.name}</strong><small>{employee.department} · {employee.position}</small></div><em>{employee.id}</em></div><div className="form-grid"><label><span>시행일 *</span><input required name="effectiveDate" type="date" defaultValue="2026-09-01" /></label><label><span>발령 구분 *</span><select required name="actionType" value={actionType} onChange={(event) => setActionType(event.target.value as PersonnelActionType)}><option>인사이동(전보)</option><option>승진</option><option>강등</option></select></label><div className="action-type-help wide"><strong>{actionType}</strong><span>{actionHelp}</span></div>{actionType === "인사이동(전보)" ? <label className="wide"><span>이동할 부서 *</span><select required name="targetDepartment" defaultValue=""><option value="" disabled>부서 선택</option>{departments.filter((department) => department !== employee.department).map((department) => <option key={department}>{department}</option>)}</select><input type="hidden" name="targetPosition" value={employee.position} /></label> : <label className="wide"><span>변경 직위 *</span><select required name="targetPosition" defaultValue=""><option value="" disabled>직위 선택</option>{availableRanks.map((rank) => <option key={rank}>{rank}</option>)}</select><input type="hidden" name="targetDepartment" value={employee.department} /></label>}</div><label className={`form-note ${actionType === "강등" ? "personnel-note-required" : ""}`}><span>{actionType === "강등" ? "강등 사유 *" : "발령 사유 및 내용"}</span><textarea required={actionType === "강등"} name="note" placeholder={actionType === "강등" ? "강등의 정당한 사유와 근거를 구체적으로 입력하세요." : "발령 배경이나 전달사항을 입력하세요."}></textarea>{actionType === "강등" && <small>강등은 정당한 사유와 객관적인 근거가 확인되어야 등록할 수 있습니다.</small>}</label><div className="modal-actions"><button type="button" onClick={onClose}>취소</button><button type="submit" className="primary-button">인사 발령 등록</button></div></form></HrModalBackdrop>;
}

type OnboardingTask = { id: string; employee_id: string; task_group: string; title: string; due_date: string; status: string };
type LifecycleRetirementRequest = { id: string; employee_id: string; retirement_date: string; reason: string; status: string; checklist_json: string; completed_tasks: number; total_tasks: number };
type LifecycleOnboardingCandidate = RecruitmentOffer & { name: string; email: string; phone: string };
/* 팝업 제목줄은 내려가면 92px -> 46px 로 접힌다. 그런데 접히는 순간 위쪽 내용이 46px 줄어들어
   브라우저의 스크롤 앵커링이 그만큼 scrollTop 을 되돌린다. 기준선이 하나면 그 되돌림이 다시
   기준을 넘어 펼침 -> 접힘을 반복하며 깜빡였다. 접을 때와 펼 때의 기준을 46px 보다 넓게
   벌려(56px / 8px) 되먹임이 기준을 다시 넘지 못하게 한다. CSS 의 overflow-anchor: none 과 한 쌍이다. */
function nextCondensed(current: boolean, scrollTop: number) {
  return current ? scrollTop > 8 : scrollTop > 56;
}

const safeJsonArray = (value: string) => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } };

function LifecycleManagementView({ jobTitles, ranks, onSelectApplicant, applicantPopupOpen = false }: {
  jobTitles: string[]; ranks: string[];
  /** 이름을 누르면 지원자 관리와 같은 「지원·면접 기록」 팝업을 연다. 팝업은 앱 최상위(XdnodeHrApp)가 띄운다. */
  onSelectApplicant?: (applicantId: string) => void;
  applicantPopupOpen?: boolean;
}) {
  const [tasks, setTasks] = useState<OnboardingTask[]>([]);
  const [retirementTasks, setRetirementTasks] = useState<OnboardingTask[]>([]);
  const [retirements, setRetirements] = useState<LifecycleRetirementRequest[]>([]);
  const [onboardingCandidates, setOnboardingCandidates] = useState<LifecycleOnboardingCandidate[]>([]);
  const [editingOnboarding, setEditingOnboarding] = useState<LifecycleOnboardingCandidate | null>(null);
  const [people, setPeople] = useState<Record<string, { name: string; department: string; joinDate: string; status: string }>>({});
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  // 퇴직 절차는 체크리스트 10개에 정산까지 붙어 목록 안에서 펼치면 다른 사람 카드가 멀리 밀려났다.
  // 한 번에 한 명만 모달로 띄운다.
  const [openRetirementId, setOpenRetirementId] = useState("");
  async function load() {
    setLoading(true);
    try {
      const [operationsResponse, employeeResponse, recruitmentResponse] = await Promise.all([fetch("/api/hr/operations"), fetch("/api/hr/employee-records"), fetch("/api/hr/recruitment")]);
      const operations = await operationsResponse.json() as { lifecycleTasks?: OnboardingTask[]; retirementRequests?: LifecycleRetirementRequest[]; error?: string };
      const employeesPayload = await employeeResponse.json() as { records?: Array<{ employeeId: string; name: string; department: string; joinDate: string; status: string }>; error?: string };
      const recruitmentPayload = await recruitmentResponse.json() as { applicants?: Applicant[]; offers?: RecruitmentOffer[]; error?: string };
      if (!operationsResponse.ok) throw new Error(operations.error || "온보딩 업무를 불러오지 못했습니다.");
      if (!employeeResponse.ok) throw new Error(employeesPayload.error || "입사예정자 정보를 불러오지 못했습니다.");
      if (!recruitmentResponse.ok) throw new Error(recruitmentPayload.error || "입사예정자 제안 정보를 불러오지 못했습니다.");
      setTasks((operations.lifecycleTasks ?? []).filter((task) => String((task as OnboardingTask & { lifecycle_type?: string }).lifecycle_type ?? "ONBOARDING") === "ONBOARDING"));
      setRetirementTasks((operations.lifecycleTasks ?? []).filter((task) => String((task as OnboardingTask & { lifecycle_type?: string }).lifecycle_type ?? "") === "RETIREMENT"));
      setRetirements((operations.retirementRequests ?? []).filter((request) => ["IN_PROGRESS", "READY", "EFFECTIVE", "COMPLETED"].includes(request.status)).sort((a, b) => b.retirement_date.localeCompare(a.retirement_date)));
      setPeople(Object.fromEntries((employeesPayload.records ?? []).map((employee) => [employee.employeeId, employee])));
      const applicantsById = new Map((recruitmentPayload.applicants ?? []).map((applicant) => [applicant.id, applicant]));
      setOnboardingCandidates((recruitmentPayload.offers ?? []).filter((offer) => ["ACCEPTED", "ONBOARDED"].includes(offer.status)).map((offer) => {
        const applicant = applicantsById.get(offer.applicantId);
        return { ...offer, name: applicant?.name ?? offer.applicantId, email: applicant?.email ?? "", phone: applicant?.phone ?? "" };
      }).sort((a, b) => a.status === b.status ? a.startDate.localeCompare(b.startDate) : a.status === "ACCEPTED" ? -1 : 1));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "온보딩 현황을 불러오지 못했습니다.");
    } finally { setLoading(false); }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);
  // 팝업에서 입사일·처우·메모를 고쳤을 수 있으니, 팝업이 닫히면 이 화면의 표를 다시 읽는다.
  const applicantPopupWasOpen = useRef(false);
  useEffect(() => {
    if (applicantPopupWasOpen.current && !applicantPopupOpen) void load();
    applicantPopupWasOpen.current = applicantPopupOpen;
  }, [applicantPopupOpen]);
  async function toggleRetirement(request: LifecycleRetirementRequest, logicalId: string) {
    const completed = safeJsonArray(request.checklist_json);
    const next = completed.includes(logicalId) ? completed.filter((id) => id !== logicalId) : [...completed, logicalId];
    const response = await fetch("/api/hr/operations", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: "retirementChecklist", id: request.id, completedTaskIds: next }),
    });
    const payload = await response.json() as { error?: string; notice?: string };
    if (!response.ok) return setMessage(payload.error || "퇴직 체크리스트를 변경하지 못했습니다.");
    setMessage(payload.notice || "퇴직 후속 절차를 저장했습니다. 퇴직일이 지난 인원은 절차 완료 여부와 관계없이 퇴직자로 유지됩니다.");
    await load();
  }
  async function updateOnboarding(resource: "onboardingUpdate" | "onboardingComplete" | "onboardingCancel", id: string, input: Record<string, unknown> = {}) {
    const response = await fetch("/api/hr/recruitment", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource, id, ...input }),
    });
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      setMessage(payload.error || "입사 예정자 정보를 변경하지 못했습니다.");
      return false;
    }
    setMessage(resource === "onboardingComplete" ? "입사 완료 처리했습니다. 인사기록카드에 재직자로 반영되었습니다." : resource === "onboardingCancel" ? "입사를 취소하고 취소 사유를 지원자 특이사항에 기록했습니다." : "입사 예정일과 처우 정보를 수정했습니다.");
    setEditingOnboarding(null);
    // 앱 최상위의 지원자 목록도 다시 읽게 한다. 안 그러면 방금 입사 완료한 사람의 팝업이 옛 단계를 보여준다.
    window.dispatchEvent(new Event("hr-recruitment-updated"));
    await load();
    return true;
  }
  const pendingOnboardingCount = onboardingCandidates.filter((candidate) => candidate.status === "ACCEPTED").length;
  const openRetirement = retirements.find((item) => item.id === openRetirementId) ?? null;
  return (
    <div className="page-wrap module-page lifecycle-page">
      <section className="module-hero">
        <div data-korean-heading>

          <h1>입·퇴사 관리</h1>
          <p>입사 전 준비와 퇴직 효력 발생 이후의 정산·회수 절차를 한곳에서 관리합니다.</p>
        </div>
      </section>
      {message && <div className="finance-control-message" role="status">{message}</div>}
      <section className="metric-grid module-metrics">
        <div className="compact-metric"><p>입사예정자</p><h2>{pendingOnboardingCount}명</h2><small>제안 수락·입사 대기 기준</small></div>
        <div className="compact-metric"><p>퇴직자·예정자</p><h2>{retirements.length}명</h2><small>승인 완료 요청 기준</small></div>
        <div className="compact-metric"><p>퇴직 효력 발생</p><h2>{retirements.filter((item) => ["EFFECTIVE", "COMPLETED"].includes(item.status)).length}명</h2><small>조직·재직 명부에서 제외</small></div>
        <div className="compact-metric"><p>후속절차 미완료</p><h2>{retirements.filter((item) => item.status !== "COMPLETED").length}명</h2><small>정산·회수 계속 관리</small></div>
      </section>
      <div className="lifecycle-board">
        <section className="lifecycle-column" aria-labelledby="onboarding-heading">
          <div className="lifecycle-section-heading">
            <div data-korean-heading><h2 id="onboarding-heading">입사 관리</h2></div>
            <strong>예정 {onboardingCandidates.filter((candidate) => candidate.status !== "ONBOARDED").length}명 · 완료 {onboardingCandidates.filter((candidate) => candidate.status === "ONBOARDED").length}명</strong>
          </div>
          {/* 입사 예정과 입사 완료를 다른 표에 둔다. 한 표에 섞여 있으면 오늘 챙길 사람이 누구인지 세어 봐야 안다.
              연락처는 입사 전 안내 연락이 잦아 표에서 바로 보이게 한다. */}
          {(() => {
            const pending = onboardingCandidates.filter((candidate) => candidate.status !== "ONBOARDED");
            const completed = onboardingCandidates.filter((candidate) => candidate.status === "ONBOARDED");
            const cells = (candidate: LifecycleOnboardingCandidate) => <>
              <td>{onSelectApplicant
                ? <button type="button" className="name-link lifecycle-applicant-link" title="지원·면접 기록 보기" onClick={() => onSelectApplicant(candidate.applicantId)}>{candidate.name}</button>
                : <strong>{candidate.name}</strong>}<small>{candidate.employeeId}</small></td>
              <td className="lifecycle-phone-cell">{candidate.phone || "미입력"}</td>
              <td>{candidate.startDate}</td>
              <td><strong>{candidate.department}</strong><small>{candidate.proposedTitle} · {candidate.jobTitle}</small></td>
            </>;
            return <>
              <h3 className="lifecycle-table-title">입사 예정 <em>{pending.length}명</em></h3>
              <div className="panel lifecycle-onboarding-table-wrap">
                <table className="lifecycle-onboarding-table">
                  <thead><tr><th>입사 예정자</th><th>연락처</th><th>입사예정일</th><th>파트·직무</th><th>진행 상태</th><th>관리</th></tr></thead>
                  <tbody>
                    {loading && <tr><td colSpan={6} className="empty-cell">입사 예정자 정보를 확인하고 있습니다…</td></tr>}
                    {!loading && pending.map((candidate) => {
                      const candidateTasks = tasks.filter((task) => task.employee_id === candidate.employeeId);
                      const done = candidateTasks.filter((task) => task.status === "DONE").length;
                      return <tr key={candidate.id}>
                        {cells(candidate)}
                        <td><span className="onboarding-progress">준비 업무 {done}/{candidateTasks.length}</span></td>
                        <td><div className="onboarding-row-actions"><button type="button" className="onboarding-complete-button" onClick={() => void updateOnboarding("onboardingComplete", candidate.id)}>입사 완료</button><button type="button" className="onboarding-edit-button" onClick={() => setEditingOnboarding(candidate)}>입사 정보 수정</button></div></td>
                      </tr>;
                    })}
                    {!loading && !pending.length && <tr><td colSpan={6} className="empty-cell">입사를 앞둔 사람이 없습니다.</td></tr>}
                  </tbody>
                </table>
              </div>
              <h3 className="lifecycle-table-title">입사 완료 <em>{completed.length}명</em></h3>
              <div className="panel lifecycle-onboarding-table-wrap">
                <table className="lifecycle-onboarding-table">
                  <thead><tr><th>입사자</th><th>연락처</th><th>입사일</th><th>파트·직무</th><th>완료 처리</th></tr></thead>
                  <tbody>
                    {!loading && completed.map((candidate) => <tr key={candidate.id} className="onboarding-completed-row">
                      {cells(candidate)}
                      <td><StatusPill value="입사 완료" /><small className="lifecycle-completed-at">{candidate.onboardedAt ? new Date(candidate.onboardedAt).toLocaleDateString("ko-KR") : ""}</small></td>
                    </tr>)}
                    {!loading && !completed.length && <tr><td colSpan={5} className="empty-cell">입사 완료 처리된 사람이 없습니다.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>;
          })()}
        </section>
        <section className="lifecycle-column" aria-labelledby="offboarding-heading">
          <div className="lifecycle-section-heading">
            <div data-korean-heading><h2 id="offboarding-heading">퇴직자 관리</h2></div>
            <strong>{retirements.length}명</strong>
          </div>
          <div className="lifecycle-card-list">
            {retirements.map((request) => {
              const person = people[request.employee_id];
              const items = retirementTasks.filter((task) => task.id.startsWith(`${request.id}:`));
              const completed = safeJsonArray(request.checklist_json);
              const effective = ["EFFECTIVE", "COMPLETED"].includes(request.status);
              return (
                <article className={`panel lifecycle-person retirement-lifecycle-person${effective ? " effective" : ""}`} key={request.id}>
                  <button className="lifecycle-card-toggle" type="button" onClick={() => setOpenRetirementId(request.id)}>
                    <div className="lifecycle-person-summary">
                      <p>{request.status === "COMPLETED" ? "OFFBOARDING COMPLETE" : effective ? "RETIRED · FOLLOW-UP OPEN" : "RETIREMENT SCHEDULED"}</p>
                      <h2>{person?.name ?? request.employee_id}</h2>
                      <span>{person?.department ?? "소속 미지정"} · 퇴직일 {request.retirement_date} · {request.reason}</span>
                    </div>
                    <div className="lifecycle-card-state">
                      <StatusPill value={request.status === "COMPLETED" ? "퇴직 절차 완료" : effective ? "퇴직 · 후속절차 진행" : "퇴직 예정"} />
                      <small>{completed.length}/{items.length} 완료</small>
                      <span aria-hidden="true">›</span>
                    </div>
                  </button>
                </article>
              );
            })}
            {!loading && !retirements.length && <div className="panel finance-empty">승인 완료된 퇴직 요청이 없습니다.</div>}
          </div>
        </section>
      </div>
      {editingOnboarding && <OnboardingEditModal candidate={editingOnboarding} jobTitles={jobTitles} ranks={ranks} onClose={() => setEditingOnboarding(null)} onSave={(draft) => updateOnboarding("onboardingUpdate", editingOnboarding.id, draft)} onCancel={(cancellationReason) => updateOnboarding("onboardingCancel", editingOnboarding.id, { cancellationReason })} />}
      {openRetirement && <RetirementProcessModal
        request={openRetirement}
        person={people[openRetirement.employee_id]}
        tasks={retirementTasks.filter((task) => task.id.startsWith(`${openRetirement.id}:`))}
        onToggle={(logicalId) => void toggleRetirement(openRetirement, logicalId)}
        onClose={() => setOpenRetirementId("")}
      />}
    </div>
  );
}

function RetirementProcessModal({ request, person, tasks, onToggle, onClose }: {
  request: LifecycleRetirementRequest;
  person?: { name: string; department: string; joinDate: string; status: string };
  tasks: OnboardingTask[];
  onToggle: (logicalId: string) => void;
  onClose: () => void;
}) {
  const completed = safeJsonArray(request.checklist_json);
  const effective = ["EFFECTIVE", "COMPLETED"].includes(request.status);
  const locked = request.status === "COMPLETED";
  // 내려가면 제목줄을 절반 높이로 접는다. 지원자·급여 팝업과 같은 방식이다.
  const [condensed, setCondensed] = useState(false);
  return <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section
      className={`employee-modal retirement-process-modal${condensed ? " condensed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`${person?.name ?? request.employee_id} 퇴직 절차`}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setCondensed((current) => nextCondensed(current, top));
      }}
    >
      <div className="modal-header">
        <div data-korean-heading><h2>{person?.name ?? request.employee_id} 퇴직 절차</h2></div>
        <button type="button" aria-label="닫기" onClick={onClose}>×</button>
      </div>
      <div className="retirement-modal-summary">
        <div><span>소속</span><strong>{person?.department ?? "소속 미지정"}</strong></div>
        <div><span>퇴직일</span><strong>{request.retirement_date}</strong></div>
        <div><span>사유</span><strong>{request.reason || "미입력"}</strong></div>
        <div><span>진행</span><strong>{completed.length}/{tasks.length} 완료</strong></div>
      </div>
      <div className="retirement-modal-body">
        <div className="retirement-modal-checklist">
          {tasks.map((task) => {
            const logicalId = task.id.slice(request.id.length + 1);
            const checked = completed.includes(logicalId);
            return <label className={checked ? "checked" : ""} key={task.id}>
              <input disabled={locked} type="checkbox" checked={checked} onChange={() => onToggle(logicalId)} />
              <span>✓</span><p><strong>{task.title}</strong><small>{task.task_group} · 기준일 {task.due_date}</small></p>
            </label>;
          })}
          {!tasks.length && <p className="retirement-modal-empty">등록된 퇴직 절차 항목이 없습니다.</p>}
        </div>
        {locked
          ? <p className="retirement-modal-empty">퇴직 절차가 완료되어 정산 내용을 수정할 수 없습니다.</p>
          : <RetirementSettlementPanel requestId={request.id} />}
      </div>
      <div className="modal-actions">
        <StatusPill value={request.status === "COMPLETED" ? "퇴직 절차 완료" : effective ? "퇴직 · 후속절차 진행" : "퇴직 예정"} />
        <button type="button" onClick={onClose}>닫기</button>
      </div>
    </section>
  </HrModalBackdrop>;
}

function OnboardingEditModal({ candidate, jobTitles, ranks, onClose, onSave, onCancel }: {
  candidate: LifecycleOnboardingCandidate;
  jobTitles: string[];
  ranks: string[];
  onClose: () => void;
  onSave: (draft: Record<string, unknown>) => Promise<boolean>;
  onCancel: (reason: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState({
    employeeId: candidate.employeeId, startDate: candidate.startDate, department: candidate.department,
    proposedTitle: candidate.proposedTitle, position: candidate.position, jobTitle: candidate.jobTitle,
    employmentType: candidate.employmentType, annualSalary: String(candidate.annualSalary),
    probationMonths: String(candidate.probationMonths), firstTermPayPercent: String(candidate.firstTermPayPercent ?? 100), responseNote: candidate.responseNote,
  });
  const [cancellationReason, setCancellationReason] = useState("");
  // 내려가면 제목줄을 절반 높이로 접는다. 지원자·퇴직 팝업과 같은 방식이다.
  const [condensed, setCondensed] = useState(false);
  const [saving, setSaving] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    await onSave({ ...draft, annualSalary: Number(draft.annualSalary), probationMonths: Number(draft.probationMonths), firstTermPayPercent: Number(draft.firstTermPayPercent) || 100 });
    setSaving(false);
  }
  async function cancelOnboarding() {
    setSaving(true);
    await onCancel(cancellationReason.trim());
    setSaving(false);
  }
  return <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={onClose}><form className={`employee-modal onboarding-edit-modal${condensed ? " condensed" : ""}`} onSubmit={submit} onScroll={(event) => { const top = event.currentTarget.scrollTop; setCondensed((current) => nextCondensed(current, top)); }} ><div className="modal-header"><div data-korean-heading><h2>{candidate.name} 입사 정보 수정</h2></div><button type="button" onClick={onClose}>×</button></div><div className="candidate-banner"><span>{candidate.name.slice(0, 1)}</span><div><strong>{candidate.name}</strong><small>{candidate.email || "이메일 미등록"} · {candidate.phone || "연락처 미등록"}</small></div><em>{candidate.employeeId}</em></div><div className="onboarding-edit-grid"><label><span>신규 사번 *</span><input required value={draft.employeeId} onChange={(event) => setDraft({ ...draft, employeeId: event.target.value })} /></label><label><span>입사예정일 *</span><input required type="date" value={draft.startDate} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} /></label><label><span>소속 파트 *</span><select required value={draft.department} onChange={(event) => setDraft({ ...draft, department: event.target.value })}>{Array.from(new Set([draft.department, ...companyOrganizations.map((item) => item.name)])).map((name) => <option key={name}>{name}</option>)}</select></label><label><span>제안 직무 *</span><input required value={draft.proposedTitle} onChange={(event) => setDraft({ ...draft, proposedTitle: event.target.value })} /></label><label><span>직위 *</span><select required value={draft.position} onChange={(event) => setDraft({ ...draft, position: event.target.value })}><option value="">직위 선택</option>{ranks.map((rank) => <option key={rank}>{rank}</option>)}</select></label><label><span>직무 *</span><select required value={draft.jobTitle} onChange={(event) => setDraft({ ...draft, jobTitle: event.target.value })}><option value="">직무 선택</option>{jobTitles.filter((title) => title !== "조직장").map((title) => <option key={title}>{title}</option>)}</select></label><label><span>고용형태 *</span><select value={draft.employmentType} onChange={(event) => setDraft({ ...draft, employmentType: event.target.value })}><option>일반직4.5</option><option>일반직</option><option>계약직</option><option>인턴</option></select></label><label><span>연봉 *</span><input required type="number" min="1" value={draft.annualSalary} onChange={(event) => setDraft({ ...draft, annualSalary: event.target.value })} /></label><label><span>수습기간(개월) *</span><input required type="number" min="0" max="12" value={draft.probationMonths} onChange={(event) => setDraft({ ...draft, probationMonths: event.target.value })} /></label><label><span>첫 계약 지급률(%) *</span><input required type="number" min="1" max="100" step="1" value={draft.firstTermPayPercent} onChange={(event) => setDraft({ ...draft, firstTermPayPercent: event.target.value })} /></label><label className="wide"><span>처우·회신 메모</span><textarea value={draft.responseNote} onChange={(event) => setDraft({ ...draft, responseNote: event.target.value })} placeholder="처우 협의 내용과 입사 준비 참고사항을 기록하세요." /></label></div><section className="onboarding-cancel-section"><div><strong>입사가 이루어지지 않는 경우</strong><span>취소 사유는 지원자 관리의 특이사항 기록에 영구 보관됩니다.</span></div><textarea value={cancellationReason} onChange={(event) => setCancellationReason(event.target.value)} placeholder="입사 취소 사유를 입력하세요." /><button type="button" disabled={saving || !cancellationReason.trim()} onClick={() => void cancelOnboarding()}>입사 취소</button></section><div className="modal-actions"><button type="button" onClick={onClose}>닫기</button><button type="submit" className="primary-button" disabled={saving}>{saving ? "저장 중…" : "입사 정보 저장"}</button></div></form></HrModalBackdrop>;
}

type SeveranceEstimate = {
  requestId: string; period: string; severance: number; tenureDays: number; appliedDailyWage: number;
  averageDailyWage: number; ordinaryDailyWage: number; basis: string; months: string[];
  usedLeaveUnits: number; unusedLeaveDays: number; payrollMonthReady: boolean; reason: string; eligible: boolean;
  limitations: string[];
  averageSeverance: number;
  ordinarySeverance: number;
  recordedSeverance: number;
  recordedLeavePay: number;
  leaveDailyWage: number;
  workingTimeRule: { label: string; monthlyHours: number; dailyHours: number };
  /** 산정에 쓴 급여월 중 아직 확정되지 않은 달. 인센티브가 안 정해진 달이 여기 들어온다. */
  provisionalMonths: string[];
  averageWageTotal: number;
  averageWageDays: number;
};

function RetirementSettlementPanel({ requestId }: { requestId: string }) {
  const dialog = useErpDialog();
  const [draft, setDraft] = useState({ finalSalary: "0", retirementPay: "0", leaveDays: "0", leavePay: "0", deductions: "0", payrollConfirmed: false, insuranceConfirmed: false, accessRevoked: false, assetsReturned: false, handoverConfirmed: false });
  const [estimate, setEstimate] = useState<SeveranceEstimate | null>(null);
  const [status, setStatus] = useState("DRAFT");
  const [message, setMessage] = useState("");
  // 아직 확정되지 않은 급여월에 인센티브가 이만큼 잡힐 것 같다는 가정. 저장하지 않고 화면에서만 쓴다.
  const [assumedIncentive, setAssumedIncentive] = useState("0");
  useEffect(() => {
    fetch("/api/hr/operations?severance=1").then(async (response) => {
      const payload = await response.json() as { retirementSettlements?: Array<Record<string, unknown>>; severanceEstimates?: SeveranceEstimate[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "퇴직 정산을 불러오지 못했습니다.");
      const computed = (payload.severanceEstimates ?? []).find((row) => row.requestId === requestId) ?? null;
      setEstimate(computed);
      const item = (payload.retirementSettlements ?? []).find((row) => row.request_id === requestId);
      // 잔여 연차는 연차관리 잔여로 미리 채운다. 이미 사람이 적어 둔 값(0이 아닌)이 있으면 그대로 둔다.
      const suggestedDays = computed ? computed.unusedLeaveDays : 0;
      const suggestedPay = computed ? Math.round(computed.leaveDailyWage * suggestedDays) : 0;
      if (!item) { if (computed) setDraft((current) => ({ ...current, leaveDays: String(suggestedDays), leavePay: String(suggestedPay) })); return; }
      setDraft({
        finalSalary: String(item.final_salary ?? 0),
        // 추정액을 자동으로 넣지 않는다. 산식이 제외기간을 반영하지 못하므로 사람이 보고 넣어야 한다.
        retirementPay: String(item.retirement_pay ?? 0),
        leaveDays: Number(item.leave_days ?? 0) || Number(item.unused_leave_pay ?? 0) ? String(item.leave_days ?? 0) : String(suggestedDays),
        leavePay: Number(item.leave_days ?? 0) || Number(item.unused_leave_pay ?? 0) ? String(item.unused_leave_pay ?? 0) : String(suggestedPay),
        deductions: String(item.deductions ?? 0),
        payrollConfirmed: Boolean(item.payroll_confirmed), insuranceConfirmed: Boolean(item.insurance_confirmed),
        accessRevoked: Boolean(item.access_revoked), assetsReturned: Boolean(item.assets_returned),
        handoverConfirmed: Boolean(item.handover_confirmed),
      });
      setStatus(String(item.status ?? "DRAFT"));
    }).catch((error: Error) => setMessage(error.message));
  }, [requestId]);
  async function save() {
    const response = await fetch("/api/hr/operations", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: "retirementSettlement", id: requestId, ...draft, finalSalary: Number(draft.finalSalary), retirementPay: Number(draft.retirementPay), leaveDays: Number(draft.leaveDays), unusedLeavePay: Number(draft.leavePay), deductions: Number(draft.deductions) }) });
    const payload = await response.json() as { item?: Record<string, unknown>; error?: string };
    if (!response.ok) return setMessage(payload.error || "퇴직 정산을 저장하지 못했습니다.");
    const nextStatus = String(payload.item?.status ?? "DRAFT");
    setStatus(nextStatus);
    setMessage(nextStatus === "READY" ? "정산과 필수 통제가 완료되어 퇴직 완료 처리가 가능합니다." : "정산 초안을 저장했습니다. 필수 확인 항목을 모두 완료해 주세요.");
  }
  // 산정한 퇴직금과 공제를 퇴사월 임금안에 넣는다. 작성 중인 임금안이 있으면 묻지 않고 덮어쓰고,
  // 임금안이 아직 없으면 만들라고 알린다.
  //
  // 잔여 연차가 음수면 그만큼 되돌려 받아야 하므로 1일 통상임금을 곱해 공제액을 만든다.
  // 사유는 임금계산 결과의 "공제 사유" 칸에 그대로 남는다.
  // overrideSeverance 가 오면 그 금액을 퇴직금으로 반영한다. 예상 인센티브로 계산한 값을
  // 퇴직금 칸을 거치지 않고 바로 넣을 때 쓴다. 오지 않으면 지금까지처럼 퇴직금 칸 → 추정액 순.
  async function applyToPayroll(estimate: SeveranceEstimate, overrideSeverance?: number) {
    const manualSeverance = Math.max(0, Math.round(Number(draft.retirementPay) || 0));
    const enteredLeaveDays = Number(draft.leaveDays) || 0;
    const negativeLeaveDays = enteredLeaveDays < 0 ? Math.abs(enteredLeaveDays) : 0;
    // 연차수당 칸의 값을 그대로 쓴다. 음수면 되돌려 받을 돈이라 공제로, 양수면 임금안의
    // 연차수당 칸으로 간다. 칸을 손으로 고쳤으면 고친 값이 반영된다.
    const settledLeavePay = Math.round(Number(draft.leavePay) || 0);
    const leaveDeduction = settledLeavePay < 0 ? Math.abs(settledLeavePay) : 0;
    const annualLeave = settledLeavePay > 0 ? settledLeavePay : 0;
    const manualDeduction = Math.max(0, Number(draft.deductions) || 0);
    const deduction = leaveDeduction + manualDeduction;
    const deductionNote = [
      leaveDeduction ? (negativeLeaveDays ? `마이너스 연월차 공제 ${negativeLeaveDays}일` : "마이너스 연월차 공제") : "",
      manualDeduction ? "퇴직 정산 공제" : "",
    ].filter(Boolean).join(" · ");

    const response = await fetch("/api/hr/operations", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      // 퇴직금 칸에 적어 둔 값이 우선이다. 사람이 세무 검토를 거쳐 확정한 금액이기 때문이다.
      // 예전에는 무조건 추정액을 보내서, 칸에 직접 넣은 금액이 조용히 추정액으로 바뀌었다.
      // 칸이 비어 있으면(0) 그때만 추정액을 쓰고, 퇴직금 대상이 아니면 0 으로 둔다.
      body: JSON.stringify({ resource: "severanceToPayroll", id: requestId,
        amount: overrideSeverance ?? (manualSeverance || (estimate.eligible ? estimate.severance : 0)),
        annualLeave, deduction, deductionNote }),
    });
    const payload = await response.json() as { error?: string; period?: string; previous?: number; amount?: number; payrollMonthMissing?: boolean; leaveDate?: string | null; leaveDateChanged?: boolean };
    if (!response.ok) {
      if (payload.payrollMonthMissing) {
        await dialog.alert("이번달 급여 계산을 시작해 주세요", { title: "임금안 없음" });
        return setMessage("퇴사월 임금안이 아직 없습니다. 임금계산에서 해당 월을 먼저 작성해 주세요.");
      }
      return setMessage(payload.error || "임금안에 반영하지 못했습니다.");
    }
    const applied = `${payload.period} 임금안 퇴직금을 ${(payload.amount ?? 0).toLocaleString("ko-KR")}원`
      + `${overrideSeverance !== undefined ? `(예상 인센티브 ${assumed.toLocaleString("ko-KR")}원 기준)`
        : manualSeverance ? "(퇴직금 칸에 입력한 값)" : "(추정액)"}으로 반영했습니다`
      + `${payload.previous ? ` (이전 ${payload.previous.toLocaleString("ko-KR")}원)` : ""}.`
      + `${annualLeave ? ` 연차수당 ${annualLeave.toLocaleString("ko-KR")}원도 함께 기록했습니다.` : ""}`
      + `${deduction ? ` 공제 ${deduction.toLocaleString("ko-KR")}원(${deductionNote})도 함께 기록했습니다.` : ""}`
      + `${payload.leaveDate ? ` 퇴사일 ${payload.leaveDate}${payload.leaveDateChanged ? "" : "(이미 같은 값)"}도 적었습니다.` : ""}`
      + " 임금계산에서 내용을 확인하고 확정해 주세요.";
    setMessage(applied);
    // 반영은 눌러도 화면이 크게 바뀌지 않아 됐는지 알기 어렵다. 결과를 팝업으로 한 번 더 알린다.
    await dialog.alert(`임금안에 반영되었습니다.

${applied}`, { title: "임금안 반영" });
  }

  // 잔여 연차 일수에 1일 통상임금을 곱해 연차수당 칸을 채운다. 일수가 음수면 금액도 음수가 되고,
  // 그 금액이 임금안에서 공제로 넘어간다.
  function leavePayFor(days: number) {
    return Math.round((estimate?.leaveDailyWage ?? 0) * days);
  }

  // 잔여 연차를 고치면 연차수당 칸이 곧바로 따라 움직인다. 칸은 그대로 손으로도 고칠 수 있다.
  function changeLeaveDays(value: string) {
    const days = Number(value);
    setDraft((current) => ({ ...current, leaveDays: value, leavePay: Number.isFinite(days) ? String(leavePayFor(days)) : current.leavePay }));
  }

  // 급여자료에 손으로 적어 둔 금액이나 이미 채워 둔 값을 계산 추정치로 지우기 전에 확인을 받는다.
  // 퇴직금 대상이 아니면(계속근로 1년 미만 등) 연차수당만 계산한다.
  async function applyEstimate(estimate: SeveranceEstimate) {
    const existing = Number(draft.retirementPay) || 0;
    const nextLeavePay = String(leavePayFor(Number(draft.leaveDays) || 0));
    if (!estimate.eligible) return setDraft((current) => ({ ...current, leavePay: nextLeavePay }));
    if ((estimate.recordedSeverance > 0 || existing > 0) && !(await dialog.confirm("기 입력된 값이 있습니다. 덮어 쓰겠습니까?", { title: "덮어쓰기 확인", confirmLabel: "덮어쓰기" }))) return;
    setDraft((current) => ({ ...current, retirementPay: String(estimate.severance), leavePay: nextLeavePay }));
  }

  const leaveDays = Number(draft.leaveDays) || 0;
  // 칸에 적힌 값이 정산의 근거다. 계산 결과를 그대로 두든 손으로 고치든 이 값이 임금안까지 간다.
  const leavePay = Math.round(Number(draft.leavePay) || 0);
  // 퇴직금 대상이 아니어도(계속근로 1년 미만 등) 마이너스 연차나 정산 공제가 있으면
  // 임금안에 넣을 것이 있다. 예전에는 버튼이 estimate.eligible 안에만 있어 이런 사람은
  // 공제를 반영할 방법이 아예 없었다.
  const hasSettlementDeduction = leaveDays < 0 || leavePay !== 0 || (Number(draft.deductions) || 0) > 0;

  // 확정 전 급여월이 있으면 "인센티브가 이만큼 나올 것 같다"를 넣어 퇴직금이 어떻게 바뀌는지 본다.
  // 서버에 저장하지 않는다 — 확정되면 실제 값으로 다시 계산되므로 여기서는 가늠만 한다.
  const assumed = Math.max(0, Math.round(Number(assumedIncentive) || 0));
  const simulated = (() => {
    if (!estimate || !estimate.averageWageDays || !assumed) return null;
    const averageDailyWage = (estimate.averageWageTotal + assumed) / estimate.averageWageDays;
    const applied = Math.max(averageDailyWage, estimate.ordinaryDailyWage);
    return {
      averageDailyWage, applied,
      basis: averageDailyWage >= estimate.ordinaryDailyWage ? "평균임금" : "통상임금",
      severance: Math.round(applied * 30 * (estimate.tenureDays / 365)),
    };
  })();
  const amount = Number(draft.finalSalary) + Number(draft.retirementPay) + leavePay - Number(draft.deductions);
  const checks: Array<[keyof typeof draft, string]> = [["payrollConfirmed", "최종 급여 확인"], ["insuranceConfirmed", "4대보험 상실 신고 확인"], ["accessRevoked", "업무 계정·접근권한 회수"], ["assetsReturned", "회사 자산 반납"], ["handoverConfirmed", "업무 인수인계 완료"]];
  return <section className="retirement-settlement"><div className="detail-card-heading"><div data-korean-heading><h3>퇴직 정산·회수 통제</h3></div><StatusPill value={status === "READY" ? "완료 가능" : status === "COMPLETED" ? "퇴직 완료" : "정산 중"} /></div>
    <div className="retirement-settlement-amounts">
      <label>최종 급여<input type="number" min="0" value={draft.finalSalary} onChange={(event) => setDraft({ ...draft, finalSalary: event.target.value })} /></label>
      <label>퇴직금<input type="number" min="0" value={draft.retirementPay} onChange={(event) => setDraft({ ...draft, retirementPay: event.target.value })} /></label>
      <label>잔여 연차(일)<input type="number" step="0.25" min="-366" max="366" value={draft.leaveDays} onChange={(event) => changeLeaveDays(event.target.value)} />{estimate && <button type="button" className="leave-link" onClick={() => changeLeaveDays(String(estimate.unusedLeaveDays))}>연차관리 잔여 {estimate.unusedLeaveDays}일 적용</button>}</label>
      <label>연차수당<input type="number" step="1" value={draft.leavePay} onChange={(event) => setDraft({ ...draft, leavePay: event.target.value })} /></label>
      <label>공제액<input type="number" min="0" value={draft.deductions} onChange={(event) => setDraft({ ...draft, deductions: event.target.value })} /></label>
      {/* 공제액 오른편 빈 칸. 입력을 다 채운 자리에서 바로 누를 수 있게 여기에 둔다. */}
      {estimate && (estimate.eligible || hasSettlementDeduction) && <div className="settlement-apply-cell">
        <button type="button" className="outline-button" onClick={() => void applyToPayroll(estimate)}>임금안에 반영</button>
      </div>}
    </div>
    {estimate && <div className="settlement-estimate">
      <p><strong>퇴직금 추정액 {estimate.eligible ? `${estimate.severance.toLocaleString("ko-KR")}원` : "산정 불가"} · 검토 필요</strong></p>
      <p className="settlement-basis">{estimate.eligible ? `재직 ${estimate.tenureDays}일` : estimate.reason}</p>
      <p className="settlement-basis">평균임금 산정기간 {estimate.months.length ? estimate.months.join(", ") : "자료 없음"}</p>
      {estimate.provisionalMonths.length > 0 && <div className="settlement-provisional" role="status">
        <strong>{estimate.provisionalMonths.join(", ")} 급여가 아직 확정되지 않았습니다.</strong>
        <p>이 달의 인센티브가 정해지면 평균임금이 올라가 퇴직금도 바뀝니다. 임금계산에서 해당 월을 확정하면 이 안내가 사라지고 확정 금액으로 다시 계산됩니다.</p>
        <label>
          <span>예상 인센티브</span>
          <input type="number" min="0" step="1" value={assumedIncentive}
            onChange={(event) => setAssumedIncentive(event.target.value)} aria-label="예상 인센티브" />
        </label>
        {simulated
          ? <>
            <p className="settlement-simulated">인센티브 {assumed.toLocaleString("ko-KR")}원을 더하면 1일 {simulated.basis} {Math.round(simulated.applied).toLocaleString("ko-KR")}원 · 퇴직금 <strong>{simulated.severance.toLocaleString("ko-KR")}원</strong> (지금 {estimate.severance.toLocaleString("ko-KR")}원 대비 {(simulated.severance - estimate.severance).toLocaleString("ko-KR")}원)</p>
            {/* 위의 "임금안에 반영"은 퇴직금 칸이나 추정액을 넣지만, 이 버튼은 방금 계산한 금액을 넣는다. */}
            <button type="button" className="outline-button" onClick={() => void applyToPayroll(estimate, simulated.severance)}>이 금액을 임금안에 반영</button>
          </>
          : <p className="settlement-simulated muted">금액을 넣으면 퇴직금이 얼마가 되는지 미리 보여 줍니다. 저장되지는 않습니다.</p>}
      </div>}
      {estimate.eligible && <table className="settlement-compare"><tbody>
        <tr className={estimate.basis === "AVERAGE" ? "applied" : ""}>
          <th>평균임금 기준</th>
          <td>1일 {Math.round(estimate.averageDailyWage).toLocaleString("ko-KR")}원{estimate.months.length ? ` (${estimate.months.join(", ")})` : ""}</td>
          <td><strong>{estimate.averageSeverance.toLocaleString("ko-KR")}원</strong></td>
          <td>{estimate.basis === "AVERAGE" ? "적용" : ""}</td>
        </tr>
        <tr className={estimate.basis === "ORDINARY" ? "applied" : ""}>
          <th>통상임금 기준</th>
          <td>1일 {Math.round(estimate.ordinaryDailyWage).toLocaleString("ko-KR")}원 ({estimate.workingTimeRule.label})</td>
          <td><strong>{estimate.ordinarySeverance.toLocaleString("ko-KR")}원</strong></td>
          <td>{estimate.basis === "ORDINARY" ? "적용" : ""}</td>
        </tr>
        {estimate.recordedSeverance > 0 && <tr className="recorded">
          <th>기입력된 퇴직금 금액</th>
          <td>{estimate.period} 급여자료에 직접 입력한 값</td>
          <td><strong>{estimate.recordedSeverance.toLocaleString("ko-KR")}원</strong></td>
          <td></td>
        </tr>}
      </tbody></table>}
      {estimate.eligible && <p className="settlement-basis">두 기준 중 큰 쪽을 적용합니다. 통상임금 기준은 근로자퇴직급여보장법상 하한입니다.</p>}
      <p className="settlement-basis settlement-caution">이 금액은 참고용 추정치입니다. 임금안·급여에 자동 반영되지 않으며, 확정 금액은 세무법인 검토를 거쳐 임금계산에서 직접 입력해 주세요.
        {estimate.limitations.map((item) => ` ${item}`).join("")}</p>
      {(estimate.eligible || hasSettlementDeduction) && <div className="settlement-estimate-actions">
        <button type="button" className="outline-button" onClick={() => applyEstimate(estimate)}>{estimate.eligible ? "계산 (퇴직금·연차수당)" : "연차수당 계산"}</button>
      </div>}
      <p className="settlement-basis">{estimate.payrollMonthReady
        ? `${estimate.period} 임금안이 준비되어 있습니다. 임금계산에서 퇴직금 칸에 확정 금액을 입력하세요.`
        : "급여 월이 비어 있습니다. 해당 급여월은 만들어 주세요"}</p>
    </div>}
    <p className="settlement-basis">연차수당 {leavePay.toLocaleString("ko-KR")}원{leaveDays < 0 ? " (선사용 연차 공제)" : ""}{estimate?.leaveDailyWage ? ` · 1일 통상임금 ${Math.round(estimate.leaveDailyWage).toLocaleString("ko-KR")}원 (${estimate.workingTimeRule.label} · 월 통상임금 ÷ ${estimate.workingTimeRule.monthlyHours}시간 × ${estimate.workingTimeRule.dailyHours}시간)` : ""}{estimate?.usedLeaveUnits ? ` · 승인된 연차 사용 ${estimate.usedLeaveUnits}일` : ""}</p>
    <strong className="settlement-net">예상 최종 정산액 {Math.round(amount).toLocaleString("ko-KR")}원</strong>
    <div className="retirement-control-list">{checks.map(([key, label]) => <label key={key} className={draft[key] ? "checked" : ""}><input type="checkbox" checked={Boolean(draft[key])} onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })} /><span>✓</span><strong>{label}</strong></label>)}</div>
    {message && <p className="retirement-settlement-message">{message}</p>}
    <button type="button" className="outline-button" disabled={status === "COMPLETED"} onClick={() => void save()}>정산·통제 저장</button>
  </section>;
}

function RetirementChecklistGroup({ title, tasks, completedTaskIds, pendingApproval, toggleTask }: { title: string; tasks: { id: string; label: string }[]; completedTaskIds: string[]; pendingApproval: boolean; toggleTask: (id: string) => void }) {
  return (
    <section className="retirement-checklist-group">
      <div className="checklist-group-heading"><div data-korean-heading><h3>{title}</h3></div><span>{tasks.filter((task) => completedTaskIds.includes(task.id)).length}/{tasks.length}</span></div>
      <div className="retirement-task-list">{tasks.map((task) => <label key={task.id} className={completedTaskIds.includes(task.id) ? "checked" : ""}><input disabled={pendingApproval} type="checkbox" checked={completedTaskIds.includes(task.id)} onChange={() => toggleTask(task.id)} /><span className="task-check">✓</span><strong>{task.label}</strong></label>)}</div>
    </section>
  );
}

function RetirementModal({ employee, initial, onClose, onSubmit, onLegacyDecision }: { employee: Employee; initial?: { date: string; reason: string } | null; onClose: () => void; onSubmit: (record: RetirementRecord) => void; onLegacyDecision: (decision: "APPROVED" | "REJECTED") => void }) {
  const [date, setDate] = useState(employee.retirement?.date ?? initial?.date ?? "2026-09-30");
  const [reason, setReason] = useState(employee.retirement?.reason ?? initial?.reason ?? "");
  const [completedTaskIds, setCompletedTaskIds] = useState<string[]>(employee.retirement?.completedTaskIds ?? []);
  const [confirmation, setConfirmation] = useState<RetirementRecord | null>(null);
  // 내려가면 제목줄을 절반 높이로 접는다. 지원자 팝업과 같은 방식이다.
  const [condensed, setCondensed] = useState(false);
  const totalTasks = retirementChecklist.hr.length + retirementChecklist.employee.length;
  const progress = Math.round((completedTaskIds.length / totalTasks) * 100);
  const checklistMode = Boolean(employee.retirement?.requestId && ["IN_PROGRESS", "READY", "EFFECTIVE"].includes(employee.retirement?.status ?? ""));
  // 전자결재 시절에 SUBMITTED 로 남은 요청. 결재가 없어져 이 창에서 바로 승인·반려한다.
  const pendingApproval = Boolean(employee.retirement?.requestId && employee.retirement?.status === "SUBMITTED");

  function toggleTask(id: string) {
    setCompletedTaskIds((value) => value.includes(id) ? value.filter((taskId) => taskId !== id) : [...value, id]);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const record = { requestId: employee.retirement?.requestId, status: employee.retirement?.status, date, reason: reason.trim(), completedTaskIds };
    if (pendingApproval) return;
    if (checklistMode) onSubmit(record);
    else setConfirmation(record);
  }



  return <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={onClose}><form
    className={`employee-modal retirement-modal${condensed ? " condensed" : ""}`}
    onSubmit={submit}

    onScroll={(event) => {
      const top = event.currentTarget.scrollTop;
      setCondensed((current) => nextCondensed(current, top));
    }}
  ><div className="modal-header"><div data-korean-heading><h2>퇴직 절차 관리</h2></div><button type="button" onClick={onClose}>×</button></div><div className="candidate-banner"><span>{employee.name.slice(0, 1)}</span><div><strong>{employee.name}</strong><small>{employee.department} · {employee.position}</small></div><em>{employee.id}</em></div>{pendingApproval && <p className="optional-form-notice">전자결재 시절에 제출돼 처리되지 않은 퇴직 요청입니다. 승인하면 퇴직 절차가 시작되고, 반려하면 요청을 닫습니다.</p>}{checklistMode && <p className="optional-form-notice">{employee.retirement?.status === "EFFECTIVE" ? "퇴직일이 지나 퇴직 상태가 반영되었습니다. 남은 정산·회수 업무는 입·퇴사 관리에서 계속 완료할 수 있습니다." : "퇴직 승인이 완료되었습니다. 퇴직일이 도래하면 재직·조직 명부에서 자동 제외되며, 체크리스트는 별도로 계속 관리됩니다."}</p>}<div className="retirement-modal-body"><div className="retirement-modal-main"><div className="retirement-fields"><label><span>퇴직일 *</span><input required disabled={checklistMode || pendingApproval} type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label><span>퇴직사유 *</span><textarea required disabled={checklistMode || pendingApproval} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="퇴직 사유와 참고사항을 입력하세요."></textarea></label></div><div className="retirement-progress"><div><span>퇴직 절차 체크리스트</span><strong>{completedTaskIds.length}/{totalTasks} 완료</strong></div><div className="retirement-progress-track"><i style={{ width: `${progress}%` }}></i></div><small>{progress === 100 ? "모든 퇴직 절차를 완료했습니다." : `미완료 업무 ${totalTasks - completedTaskIds.length}건이 남아 있습니다.`}</small></div><div className="retirement-checklist-grid"><RetirementChecklistGroup completedTaskIds={completedTaskIds} pendingApproval={pendingApproval} toggleTask={toggleTask} title="인사담당자 수행 업무" tasks={retirementChecklist.hr} /><RetirementChecklistGroup completedTaskIds={completedTaskIds} pendingApproval={pendingApproval} toggleTask={toggleTask} title="퇴직자 수행 업무" tasks={retirementChecklist.employee} /></div></div>{checklistMode && employee.retirement?.requestId && <aside className="retirement-modal-side"><RetirementSettlementPanel requestId={employee.retirement.requestId} /></aside>}</div><div className="modal-actions"><button type="button" onClick={onClose}>취소</button>{pendingApproval ? <><button type="button" className="reject-action" onClick={() => onLegacyDecision("REJECTED")}>반려</button><button type="button" className="primary-button" onClick={() => onLegacyDecision("APPROVED")}>승인</button></> : <button type="submit" className="primary-button">{checklistMode ? "체크리스트 저장" : "퇴직 승인"}</button>}</div></form>{confirmation && <HrModalBackdrop className="retirement-confirmation-backdrop" role="presentation" onMouseDown={() => setConfirmation(null)}><section data-korean-heading className="retirement-confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="retirement-confirmation-title" ><h2 id="retirement-confirmation-title">{employee.name} 퇴직 처리 확인</h2><span>작성한 내용을 확인 후 퇴직 버튼을 클릭해 주세요.</span><dl><div><dt>퇴직일</dt><dd>{confirmation.date}</dd></div><div><dt>퇴직사유</dt><dd>{confirmation.reason}</dd></div><div><dt>체크리스트</dt><dd>{confirmation.completedTaskIds.length}/{totalTasks} 완료</dd></div></dl><div><button type="button" onClick={() => setConfirmation(null)}>돌아가기</button><button type="button" className="danger-confirm" onClick={() => onSubmit(confirmation)}>퇴직</button></div></section></HrModalBackdrop>}</HrModalBackdrop>;
}

// R3(Design §12.8): '사용자·권한' 절과 /api/hr/authorized-users 는 삭제했다. 계정·탭 권한은 관리자 전용 계정 관리 탭(/api/admin/accounts)이 맡는다.
function SettingsView() {
  const [section, setSection] = useState("company");

  const sectionTitle = section === "company"
    ? "회사·조직 정보"
    : section === "hr"
      ? "인사 기준정보"
      : section === "notifications"
        ? "알림 설정"
        : "데이터·백업";

  return <div className="page-wrap settings-page">
    <section className="module-hero">
      <div data-korean-heading><h1>환경설정</h1><p>회사 정보, 인사 기준과 알림을 설정합니다. 계정과 탭 권한은 관리자의 계정 관리 탭에서 정합니다.</p></div>
      {/* 회사·기준정보·알림·데이터 섹션은 아직 저장 경로가 없다. 예전에는 「변경사항 저장」이 성공 토스트만 띄웠다. */}
      <span className="payroll-import-badge">표시 전용 · 저장 기능 준비 중</span>
    </section>
    <div className="settings-layout">
      <aside className="panel settings-nav">
        {[["company", "회사·조직 정보"], ["hr", "인사 기준정보"], ["notifications", "알림 설정"], ["data", "데이터·백업"]].map(([id, label]) => <button type="button" className={section === id ? "active" : ""} key={id} onClick={() => setSection(id)}>{label}<span>›</span></button>)}
      </aside>
      <section className="panel settings-content">
        <div className="detail-card-heading"><div data-korean-heading><h2>{sectionTitle}</h2></div></div>
        {section === "company" && <div className="settings-form"><label><span>회사명</span><input defaultValue="XD NODE" /></label><label><span>대표자</span><input defaultValue="이정민" /></label><label><span>사업자등록번호</span><input defaultValue="123-45-67890" /></label><label><span>기본 근무지</span><input defaultValue="서울 본사" /></label><label className="wide"><span>회사 주소</span><input defaultValue="서울특별시 성동구 아차산로 00" /></label></div>}
        {section === "hr" && <div className="setting-list"><SettingToggle title="사번 자동 발급" description="입사연도와 순번으로 사번을 자동 생성합니다." checked /><SettingToggle title="수습기간 종료 알림" description="종료 14일 전에 담당자와 부서장에게 알립니다." checked /><SettingToggle title="급여 마감 후 수정 제한" description="마감된 급여는 급여관리자만 다시 열 수 있습니다." checked /></div>}
        {section === "notifications" && <div className="setting-list"><SettingToggle title="시스템 알림" description="업무 마감과 승인 요청을 알림센터에서 받습니다." checked /><SettingToggle title="이메일 알림" description="중요 HR 일정을 이메일로도 받습니다." checked /><SettingToggle title="미처리 업무 재알림" description="기한이 지난 업무를 매일 오전 다시 알립니다." checked={false} /></div>}
        {section === "data" && <div className="data-settings"><div><strong>자동 백업</strong><span>미설정 · 로컬 D1 파일을 수동으로 보관합니다</span><button type="button" disabled title="준비 중">지금 백업</button></div><div><strong>개인정보 보유기간</strong><span>퇴사 후 3년(방침) · 자동 삭제는 미구현</span><button type="button" disabled title="준비 중">정책 관리</button></div><div><strong>엑셀 데이터 가져오기</strong><span>재무 「데이터 통제」의 가져오기를 사용하세요</span><button type="button" disabled title="준비 중">가져오기</button></div></div>}
      </section>
    </div>
  </div>;
}

function SettingToggle({ title, description, checked }: { title: string; description: string; checked: boolean }) {
  const [enabled, setEnabled] = useState(checked);
  return <button type="button" className="setting-toggle" onClick={() => setEnabled((value) => !value)}><div><strong>{title}</strong><span>{description}</span></div><i className={enabled ? "on" : ""}><em></em></i></button>;
}

function Dashboard({ employees, organizations, applicants, requisitions, lifecycleTasks, payrollRuns, leaveLedgers, onNavigate, onOpenEmployee, onOpenApplicant, onMarkRegular, onEndContract }: {
  employees: Employee[]; organizations: Organization[]; applicants: Applicant[]; requisitions: RecruitmentRequisitionOption[];
  lifecycleTasks: DashboardLifecycleTask[]; payrollRuns: DashboardPayrollRun[]; leaveLedgers: DashboardLeaveLedger[];
  onNavigate: (id: string) => void; onOpenEmployee: (id: string) => void; onOpenApplicant: (id: string) => void;
  onMarkRegular: (employee: Employee, date: string, review: FirstTermReview) => void; onEndContract: (employee: Employee, endDate: string, review: FirstTermReview) => void;
}) {
  // 오늘(한국시간)을 기준으로 앞뒤를 가른다. 이 화면의 "예정"은 모두 이 날짜가 기준이다.
  const today = useKoreanToday();
  // 계산은 전부 hr-dashboard-model 에 있다. 이 컴포넌트는 그 결과를 배치하고 클릭을 연결할 뿐이다.
  const model = buildDashboardModel({
    today, employees, organizations, applicants, requisitions, lifecycleTasks, payrollRuns, leaveLedgers,
    isCurrent: (employee) => isCurrentEmployee(employee as Employee),
    isRejectedStage: (stage) => REJECTED_STAGES.includes(stage),
    funnelStages: [SCREENING_PENDING_STAGE, SCREENING_PASSED_STAGE, "면접", INTERVIEW_PASSED_STAGE, OFFER_PREPARED_STAGE, "입사 예정", "입사 완료"],
    firstTerm: (joinDate) => ({ endDate: fixedTermEndDate(joinDate), nextStart: firstTermNextStart(joinDate) }),
  });
  const { dDay, dayGap } = model;

  // 통합 타임라인 필터 — 종류와 기간. 박스를 종류별로 나누면 비어 있는 박스가 자리를 차지했다.
  const TIMELINE_KINDS = ["면접", "입사", "퇴사", "회신 대기", "계약 만료"] as const;
  const [timelineKind, setTimelineKind] = useState<"전체" | (typeof TIMELINE_KINDS)[number]>("전체");
  const [timelineRange, setTimelineRange] = useState<"week" | "month" | "all">("month");
  const inRange = (date: string) => {
    const gap = dayGap(date) ?? 999;
    return timelineRange === "week" ? gap < 7 : timelineRange === "month" ? date.slice(0, 7) === today.slice(0, 7) || gap < 7 : true;
  };
  const timelineItems = model.timeline.filter((item) => (timelineKind === "전체" || item.kind === timelineKind) && inRange(item.date));

  // 첫 계약 근무평가 팝업. 전환·종료 어느 쪽이든 평가를 먼저 적게 해서 결정의 근거가 남게 한다.
  const [reviewTarget, setReviewTarget] = useState<{ employee: Employee; endDate: string; nextStart: string } | null>(null);
  const [review, setReview] = useState({ ratings: { job: "보통", attitude: "보통", teamwork: "보통" } as Record<FirstTermCriterion, string>, comment: "", notifiedOn: "" });
  // 브라우저 alert/confirm 대신 팝업 안에서 확인 단계를 밟는다. 다른 팝업과 같은 방식이다.
  const [reviewConfirm, setReviewConfirm] = useState<"CONVERT" | "END" | null>(null);
  const [reviewError, setReviewError] = useState("");
  const openReview = (employee: Employee, endDate: string, nextStart: string) => {
    setReview({ ratings: { job: "보통", attitude: "보통", teamwork: "보통" }, comment: "", notifiedOn: today });
    setReviewConfirm(null); setReviewError("");
    setReviewTarget({ employee, endDate, nextStart });
  };

  const scrollToAnchor = (event: React.MouseEvent<HTMLElement>, anchor: string) => {
    event.currentTarget.closest(".dashboard-page")?.querySelector(`[data-dash-anchor="${anchor}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const openTarget = (event: React.MouseEvent<HTMLElement>, target: { view: string; employeeId?: string; applicantId?: string; anchor?: string }) => {
    if (target.anchor) { scrollToAnchor(event, target.anchor); return; }
    if (target.applicantId) { onOpenApplicant(target.applicantId); return; }
    if (target.employeeId && target.view === "employees") { onOpenEmployee(target.employeeId); return; }
    onNavigate(target.view);
  };
  const priorityLabel: Record<InboxPriority, string> = { critical: "긴급", warning: "주의", info: "참고" };
  const criticalCount = model.inbox.filter((item) => item.priority === "critical").length;

  const sections: Record<string, React.ReactNode> = {
    inbox: (
      <section className="panel dash-panel dash-inbox span-12" key="inbox" data-dash-anchor="inbox">
        <div className="section-heading"><div data-korean-heading><h2>처리 대기 <em>{model.inbox.length}건</em>{criticalCount > 0 && <span className="dash-critical-badge">긴급 {criticalCount}</span>}</h2></div><span className="dash-hint">계약 만료·퇴직/입사 절차·오퍼 회신·급여 마감·인사정보 미입력을 우선순위순으로 모았습니다</span></div>
        {model.inbox.length ? <ul className="dash-inbox-list">{model.inbox.map((item) => (
          <li key={item.id} className={item.priority}>
            <button type="button" onClick={(event) => openTarget(event, item.target)}>
              <span className={`dash-priority ${item.priority}`}>{priorityLabel[item.priority]}</span>
              <span className="dash-kind">{item.kind}</span>
              <span className="dash-inbox-body"><strong>{item.title}</strong><small>{item.detail}</small></span>
              <span className="dash-open">열기 →</span>
            </button>
          </li>
        ))}</ul> : <p className="dash-empty">처리할 일이 없습니다.</p>}
      </section>
    ),
    renewal: (
      <section className={`panel dash-panel renewal-panel span-12${model.renewals.length || model.missingRegularRecords.length ? "" : " compact"}`} key="renewal" data-dash-anchor="renewal">
        <div className="section-heading"><div data-korean-heading><h2>정규직 전환 예정 <em>{model.renewals.length}건</em></h2></div><span className="renewal-hint">첫 계약(3개월 기간제) 만료 30일 전부터 표시 · 만료 7일 전까지 서면 통지</span></div>
        {model.renewals.length ? <table className="data-table dashboard-mini-table renewal-table"><thead><tr><th>직원</th><th>소속·직위</th><th>입사일</th><th>계약 만료일</th><th>첫 계약 지급률</th><th>상태</th><th>조치</th></tr></thead>
          <tbody>{model.renewals.map(({ employee, endDate, nextStart, state }) => <tr key={employee.id}>
            <td><strong>{employee.name}</strong></td><td>{employee.department} · {employee.position}</td><td>{employee.joinDate}</td>
            <td><strong>{endDate}</strong><em className="renewal-dday">{dDay(endDate)}</em></td><td>{employee.firstTermPayPercent ?? 100}%</td>
            <td><span className={`renewal-state ${state.tone}`}>{state.label}</span></td>
            <td><div className="renewal-actions"><button type="button" onClick={() => onOpenEmployee(employee.id)}>전환 계약서</button><button type="button" className="primary-button" onClick={() => openReview(employee as Employee, endDate, nextStart)}>평가·결정</button></div></td>
          </tr>)}</tbody></table> : <p className="dash-empty">30일 안에 첫 계약이 끝나는 사람이 없습니다.</p>}
        {model.missingRegularRecords.length > 0 && <p className="dash-footnote">전환 기록이 없는 재직자 {model.missingRegularRecords.length}명 ({model.missingRegularRecords.slice(0, 4).map((item) => item.employee.name).join(", ")}{model.missingRegularRecords.length > 4 ? " 외" : ""}) — 첫 계약 만료가 60일 넘게 지났습니다. 인사기록카드에서 정규직 계약일을 입력하면 이 안내가 사라집니다.</p>}
      </section>
    ),
    timeline: (
      <section className="panel dash-panel dash-timeline span-7" key="timeline" data-dash-anchor="timeline">
        <div className="section-heading"><div data-korean-heading><h2>일정 <em>{timelineItems.length}건</em></h2></div>
          <div className="dash-chips" role="group" aria-label="기간">{([["week", "이번 주"], ["month", "이번 달"], ["all", "전체 예정"]] as const).map(([value, label]) => <button type="button" key={value} className={timelineRange === value ? "active" : ""} onClick={() => setTimelineRange(value)}>{label}</button>)}</div></div>
        <div className="dash-chips kinds" role="group" aria-label="종류">
          {(["전체", ...TIMELINE_KINDS] as const).map((kind) => { const count = kind === "전체" ? model.timeline.filter((item) => inRange(item.date)).length : model.timeline.filter((item) => item.kind === kind && inRange(item.date)).length; return <button type="button" key={kind} className={timelineKind === kind ? "active" : ""} onClick={() => setTimelineKind(kind)}>{kind}<em>{count}</em></button>; })}
        </div>
        {timelineItems.length ? <ul className="people-timeline dash-timeline-list">{timelineItems.map((item) => (
          <li key={item.id}><button type="button" onClick={(event) => openTarget(event, item.target)}>
            <span className="timeline-date"><strong>{item.date.slice(5).replace("-", ".")}</strong><em>{dDay(item.date)}</em></span>
            <span className={`timeline-kind ${item.tone}`}>{item.kind}</span>
            <span className="timeline-who"><strong>{item.who}</strong><small>{item.detail}</small></span>
          </button></li>
        ))}</ul> : <p className="dash-empty">{timelineRange === "week" ? "이번 주에 잡힌 일정이 없습니다." : timelineRange === "month" ? "이번 달에 잡힌 일정이 없습니다." : "예정된 일정이 없습니다."}</p>}
      </section>
    ),
    pipeline: (
      <section className="panel dash-panel dash-pipeline span-5" key="pipeline" data-dash-anchor="pipeline">
        <div className="section-heading"><div data-korean-heading><h2>채용 파이프라인</h2></div><button type="button" onClick={() => onNavigate("requisitions")}>채용요청·TO →</button></div>
        <h3 className="dash-subtitle">단계별 지원자</h3>
        <HorizontalBars rows={model.funnel.map((item) => ({ label: item.stage, value: item.count }))} />
        <h3 className="dash-subtitle">채용요청 충원 현황</h3>
        {model.requisitions.length ? <ul className="dash-requisitions">{model.requisitions.map((item) => (
          <li key={item.id} className={item.status === "FILLED" ? "filled" : ""}><div><strong>{item.title}</strong><small>{item.organization} · {item.role} · 진행 중 {item.active}명{item.status === "FILLED" ? " · 충원 완료" : ""}</small></div><FillMeter filled={item.filled} requested={item.requested} active={item.active} /></li>
        ))}</ul> : <p className="dash-empty">진행 중인 채용요청이 없습니다.</p>}
      </section>
    ),
    people: (
      <Fragment key="people">
        <section className="panel dash-panel span-7" data-dash-anchor="flow">
          <div className="section-heading"><div data-korean-heading><h2>최근 12개월 입사·퇴사</h2></div><button type="button" onClick={() => onNavigate("reports")}>통계·리포트 →</button></div>
          <MonthlyFlowChart months={model.flow} />
        </section>
        <section className="panel dash-panel span-5" data-dash-anchor="headcount">
          <div className="section-heading"><div data-korean-heading><h2>조직별 인원</h2></div><button type="button" onClick={() => onNavigate("organization")}>조직관리 →</button></div>
          <HorizontalBars rows={model.headcount.map((row) => ({ label: row.organization, value: row.count, note: row.leaving ? `퇴사 예정 ${row.leaving}` : undefined }))} />
          {model.unassigned > 0 && <p className="dash-footnote">소속 미지정 {model.unassigned}명은 조직관리에서 배정해 주세요.</p>}
        </section>
        <section className="panel dash-panel span-4" data-dash-anchor="composition">
          <div className="section-heading"><div data-korean-heading><h2>고용형태 구성</h2></div></div>
          <CompositionBar segments={model.employmentTypes.map((item) => ({ label: item.type, count: item.count, share: item.share }))} total={model.employeeCount} />
        </section>
        <section className="panel dash-panel span-4" data-dash-anchor="recent">
          <div className="section-heading"><div data-korean-heading><h2>최근 입사자</h2></div><button type="button" onClick={() => onNavigate("employees")}>전체 보기 →</button></div>
          {model.recentHires.length ? <table className="data-table dashboard-mini-table"><thead><tr><th>직원</th><th>소속·직위</th><th>입사일</th><th>근속</th></tr></thead>
            <tbody>{model.recentHires.map(({ employee, tenure }) => <tr key={employee.id}>
              <td><button type="button" className="name-link" onClick={() => onOpenEmployee(employee.id)}>{employee.name}</button></td><td>{employee.department} · {employee.position}</td><td>{employee.joinDate}</td><td>{tenure}</td>
            </tr>)}</tbody></table> : <p className="dash-empty">등록된 입사 기록이 없습니다.</p>}
        </section>
      </Fragment>
    ),
    payroll: (
      <section className="panel dash-panel dash-payroll span-4" key="payroll" data-dash-anchor="payroll">
        <div className="section-heading"><div data-korean-heading><h2>급여 진행 상태</h2></div><button type="button" onClick={() => onNavigate("payroll")}>급여관리 →</button></div>
        {model.payroll.latest ? <>
          <div className="dash-payroll-head"><strong>{model.payroll.latest.period}</strong><span>대상 {model.payroll.latest.employee_count ?? 0}명 · 실지급 {koreanWon(model.payroll.latest.net_pay ?? 0)}</span></div>
          <PayrollStepper status={model.payroll.latest.status} steps={model.payroll.steps} />
          <p className="dash-footnote">{model.payroll.staleCount ? `지난 달까지 승인·마감이 끝나지 않은 급여월 ${model.payroll.staleCount}건` : "지난 달까지의 급여는 모두 마감됐습니다"}{model.payroll.currentMonthPrepared ? "" : ` · 이번 달(${today.slice(0, 7)}) 급여는 아직 만들지 않았습니다`}</p>
        </> : <p className="dash-empty">등록된 급여월이 없습니다.</p>}
      </section>
    ),
  };

  return (
    <div className="page-wrap dashboard-page">
      <section className="welcome-row dash-welcome">
        <div data-korean-heading>

          <h1>인사 현황 한눈에 보기</h1>
          <p className="dash-basis">기준일 {today} · 재직자 {model.employeeCount}명 · 처리 대기 {model.inbox.length}건{criticalCount ? ` (긴급 ${criticalCount}건)` : ""}</p>
        </div>
        <div className="welcome-actions">
          <button type="button" className="outline-button" onClick={() => onNavigate("recruitment")}>지원자 관리</button>
          <button type="button" className="primary-button" onClick={() => onNavigate("employees")}>인사기록카드</button>
        </div>
      </section>

      <section className="metric-grid">{model.metrics.map((metric) => (
        <button type="button" className="metric-card" key={metric.label} onClick={(event) => {
          // 전환 예정은 이 화면 안의 표라 화면을 옮기지 않고 그 표로 내려간다.
          if (metric.key === "renewal") scrollToAnchor(event, "renewal");
          else onNavigate(metric.key);
        }}>
          <div className="metric-top"><span className={`metric-icon ${metric.tone}`}>{metric.icon}</span>{metric.delta && <em className="metric-delta">{metric.delta}</em>}</div>
          <p>{metric.label}</p><h2>{metric.value}<small>명</small></h2>
          <small>{metric.note}</small>
        </button>
      ))}</section>

      <div className="dash-grid">{model.sectionOrder.map((key) => sections[key])}</div>

      {reviewTarget && (() => {
        const { employee, endDate, nextStart } = reviewTarget;
        // 계약서 제2조: 만료 7일 전까지 서면 통지. 통지일이 그 뒤면 경고만 하고 막지는 않는다 — 이미 지난 날짜를 기록해야 할 수도 있다.
        const notifyLate = Boolean(review.notifiedOn) && (dayGap(endDate) ?? 0) - (dayGap(review.notifiedOn) ?? 0) < 7;
        const decisionLabel = (decision: "CONVERT" | "END") => decision === "CONVERT" ? "정규직 전환" : "계약 만료 종료";
        const request = (decision: "CONVERT" | "END") => {
          if (!review.notifiedOn) { setReviewError("통지일을 입력해 주세요."); return; }
          setReviewError("");
          setReviewConfirm(decision);
        };
        const apply = () => {
          if (!reviewConfirm) return;
          const record: FirstTermReview = { ...review, decision: reviewConfirm, decidedOn: today };
          if (reviewConfirm === "CONVERT") onMarkRegular(employee, nextStart, record); else onEndContract(employee, endDate, record);
          setReviewTarget(null);
        };
        return <HrModalBackdrop className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReviewTarget(null); }}>
          <form className="employee-modal first-term-review-modal"  onSubmit={(event) => event.preventDefault()}>
            <div className="modal-header"><div data-korean-heading><h2>{employee.name} 첫 계약 근무평가</h2></div><button type="button" aria-label="닫기" onClick={() => setReviewTarget(null)}>×</button></div>
            <p className="optional-form-notice">계약서 제2조의 기준으로 평가하고 결정을 기록합니다. 결정과 평가는 인사이력에 남고, 「계약 만료 종료」를 고르면 퇴직 절차 팝업이 이어서 열립니다.</p>
            <div className="contract-preview"><div><span>입사일</span><strong>{employee.joinDate}</strong></div><div><span>계약 만료일</span><strong>{endDate} <em className="renewal-dday">{dDay(endDate)}</em></strong></div><div><span>첫 계약 지급률</span><strong>{employee.firstTermPayPercent ?? 100}%</strong></div><div><span>전환 계약 시작일</span><strong>{nextStart}</strong></div></div>
            <div className="form-grid">
              {FIRST_TERM_CRITERIA.map((item) => <label key={item.key}><span>{item.label}</span><select value={review.ratings[item.key]} onChange={(event) => setReview({ ...review, ratings: { ...review.ratings, [item.key]: event.target.value } })}>{FIRST_TERM_GRADES.map((grade) => <option key={grade}>{grade}</option>)}</select></label>)}
              <label><span>결과 통지일 *</span><input required type="date" value={review.notifiedOn} onChange={(event) => { setReview({ ...review, notifiedOn: event.target.value }); setReviewError(""); }} /></label>
              <label className="wide"><span>종합 의견</span><textarea value={review.comment} onChange={(event) => setReview({ ...review, comment: event.target.value })} placeholder="평가 근거와 전환·종료 판단 이유를 적으세요. 전환하지 않는 경우 특히 구체적으로 남깁니다." /></label>
            </div>
            {notifyLate && <p className="contract-warning">통지일이 계약 만료 7일 전을 지났습니다. 계약서 제2조의 통지 기한을 확인하세요.</p>}
            {reviewError && <p className="contract-warning">{reviewError}</p>}
            {reviewConfirm
              ? <div className="modal-actions dash-confirm-strip"><span>{employee.name}님을 「{decisionLabel(reviewConfirm)}」으로 기록합니다. 평가 내용은 인사이력에 남습니다.</span><button type="button" onClick={() => setReviewConfirm(null)}>돌아가기</button><button type="button" className={reviewConfirm === "END" ? "danger-confirm" : "primary-button"} onClick={apply}>{decisionLabel(reviewConfirm)} 확정</button></div>
              : <div className="modal-actions"><button type="button" onClick={() => setReviewTarget(null)}>취소</button><button type="button" className="danger-confirm" onClick={() => request("END")}>계약 만료 종료</button><button type="button" className="primary-button" onClick={() => request("CONVERT")}>정규직 전환</button></div>}
          </form>
        </HrModalBackdrop>;
      })()}
    </div>
  );
}

