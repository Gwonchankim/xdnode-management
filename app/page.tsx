"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import HRWorkspace from "./hr-workspace";
import FinanceOperationsCenter from "./finance-operations-center";
import PurchasingWorkspace from "./purchasing-workspace";
import CashReconciliationWorkspace from "./cash-reconciliation-workspace";
import TieOutBoardWorkspace from "./tie-out-board-workspace";
import CashForecastWorkspace from "./cash-forecast-workspace";
import FinanceCloseWorkspace from "./finance-close-workspace";
import BudgetActualWorkspace from "./budget-actual-workspace";
import ManagementReportWorkspace from "./management-report-workspace";
import FinanceMasterWorkspace from "./finance-master-workspace";
import ReceivablesWorkspace from "./receivables-workspace";
import InventoryWorkspace from "./inventory-workspace";
import TaxReconciliationWorkspace from "./tax-reconciliation-workspace";
import FixedAssetsWorkspace from "./fixed-assets-workspace";
import ProjectCostingWorkspace from "./project-costing-workspace";
import ExpenseControlWorkspace from "./expense-control-workspace";
import DebtManagementWorkspace from "./debt-management-workspace";
import DailyTreasuryWorkspace from "./daily-treasury-workspace";
import FinanceRiskPolicyWorkspace from "./finance-risk-policy-workspace";
import FinanceAlertActionCenter from "./finance-alert-action-center";
import GeneralLedgerWorkspace from "./general-ledger-workspace";
import SalesWorkspace from "./sales-workspace";
import OperationsWorkbench from "./operations-workbench";
import DataGovernanceCenter from "./data-governance-center";
import CompensationCalculator from "./compensation-calculator";
import LocalCodexAssistant from "./local-codex-assistant";
import { financeCurrentData } from "./finance-current-data";
import { financeCurrentInsights } from "./finance-current-insights";
import { financeHistoricalData } from "./finance-historical-data";
import { buildAmountSeries, buildBalanceSeries, type FinancePeriod } from "./finance-time-series";
import { buildAccountRiskModel, buildSalesForecast, DEFAULT_FINANCE_RISK_POLICY, type FinanceRiskPolicy } from "./finance-decision-model";

type ModuleKey = "finance" | "sales" | "hr" | "compensation";

type ERPAlert = {
  id: string;
  category: string;
  title: string;
  description: string;
  time: string;
  destination?: { module: ModuleKey; hrView?: string; financeView?: FinanceWorkspaceView };
};

type OperationTask = {
  id: string;
  module: string;
  category: string;
  title: string;
  description: string;
  ownerEmployeeId: string;
  dueDate: string;
  status: "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE";
  priority: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  destination: string;
  sourceType?: string;
  sourceId?: string;
};

type TreasuryOverviewSnapshot = {
  balances: {
    closingBankAssets: number;
    movement: number;
  };
  actualCash: {
    inflow: number;
    outflow: number;
    net: number;
  };
  next7Days: {
    explicitForecast: { inflow: number; outflow: number; net: number };
    receivables: { dueAmount: number; dueCount: number; overdueAmount: number; missingDueCount: number };
    payables: { dueAmount: number; dueCount: number; missingDueCount: number };
    debt: { dueAmount: number; dueCount: number };
  };
  warnings: Array<{ code: string; message: string; destination: string }>;
};

type TreasuryOverviewReport = {
  version: number;
  status: "DRAFT" | "REVIEWED" | "FINAL";
  sourceAsOf: string;
  analysisText: string;
  analysisSource: "AI" | "RULE_BASED_FALLBACK";
  aiStatus: string;
};

type TreasuryOverviewResponse = {
  preview: TreasuryOverviewSnapshot;
  selected: TreasuryOverviewReport | null;
};
const noTreasuryWarnings: TreasuryOverviewSnapshot["warnings"] = [];

const modules: Array<{
  key: ModuleKey;
  label: string;
  glyph: string;
}> = [
  { key: "finance", label: "재무회계", glyph: "₩" },
  { key: "sales", label: "영업", glyph: "↗" },
  { key: "hr", label: "인사관리", glyph: "◎" },
  { key: "compensation", label: "임금 계산", glyph: "◫" },
];

const erpAlerts = [
  { id: "hr-profile", category: "HR", title: "필수 인사정보 확인 필요", description: "연락처·생년월일 등 필수항목이 비어 있는 직원 기록을 확인해 주세요.", time: "오늘", destination: { module: "hr", hrView: "employees" } },
  { id: "onboarding", category: "입·퇴사", title: "8월 신규 입사자 온보딩", description: "계정 발급, 자산 지급, 법정교육 체크리스트를 확인해 주세요.", time: "D-2", destination: { module: "hr", hrView: "employees" } },
  { id: "organization", category: "조직관리", title: "조직장 지정 상태 확인", description: "조직관리에서 조직장이 지정되지 않은 조직이 있는지 확인해 주세요.", time: "이번 주", destination: { module: "hr", hrView: "organization" } },
  { id: "finance-close", category: "재무", title: "2026년 분개장 점검", description: `분개장 차변과 대변 사이의 ${financeCurrentData.journalSummary.differenceKrw.toLocaleString("ko-KR")}원 차이를 확인해 주세요.`, time: "확인 필요", destination: { module: "finance", financeView: "quality" } },
  { id: "sync-complete", category: "재무 데이터", title: "2024~2026년 재무 데이터 연결 완료", description: `2024·2025년 자료는 대사가 완료되었습니다. 2026년 분개장 차대변 ${financeCurrentData.journalSummary.differenceKrw.toLocaleString("ko-KR")}원과 2025년 중복 후보 32행은 원문 확인이 필요합니다.`, time: `${Number(financeCurrentData.asOf.slice(5, 7))}월 ${Number(financeCurrentData.asOf.slice(8, 10))}일`, destination: { module: "finance", financeView: "quality" } },
  { id: "permission-applied", category: "권한", title: "사용자 권한 설정 적용", description: "김권찬 관리자 권한이 정상적으로 적용되었습니다.", time: "오늘" },
] satisfies ERPAlert[];

const financeChecks = [
  { label: "2024년 합계잔액시산표·재무상태표 대사", owner: "차대변·자산총계 일치", done: true },
  { label: "2025년 원장·시산표·자금현황 대사", owner: "27개 계정 전액 일치", done: true },
  { label: "2025년 분개장 15,510개 라인 반영", owner: "2025.01.02–12.31", done: true },
  { label: "은행 데이터 소스 11개 수집", owner: "Clobe · 정상", done: true },
  { label: `2026년 분개장 ${financeCurrentData.journalSummary.lineCount.toLocaleString("ko-KR")}개 라인 반영`, owner: `2026.01.01–${financeCurrentData.asOf.slice(5)}`, done: true },
  { label: `분개장 차대변 ${financeCurrentData.journalSummary.differenceKrw.toLocaleString("ko-KR")}원 차이 확인`, owner: "재무 담당자", done: financeCurrentData.journalSummary.differenceKrw === 0 },
  { label: "2025년 중복 후보 32행 원문 확인", owner: "자동 삭제하지 않음", done: false },
];

type FinanceMetric = "cash" | "sales";
type FinanceWorkspaceView = "overview" | "risk-actions" | "daily-report" | "control" | "report" | "purchasing" | "inventory" | "tax" | "fixed-assets" | "project-costing" | "expense-control" | "debt" | "reconciliation" | "reconciliation-board" | "forecast" | "budget" | "close" | "master" | "commercial" | "receivables" | "ledger" | "statements" | "liquidity" | "quality" | "policy";

type FinanceAssistantSourceView = {
  id: string; label: string; period: string; basis: string;
  status: "CONFIRMED" | "REVIEW"; destination: FinanceWorkspaceView;
};

type FinanceAssistantMeta = {
  provider: "AI" | "RULE_BASED_FALLBACK";
  evidenceStatus: "VERIFIED" | "REVIEW_REQUIRED";
  evidenceLabel: string;
  basisAsOf: string;
  sources: FinanceAssistantSourceView[];
  limitations: string[];
};

type FinanceAssistantHistoryView = FinanceAssistantMeta & {
  id: string; question: string; answer: string; evidenceHash: string; answerHash: string; promptVersion: string;
  createdByEmployeeId: string; createdByName: string; createdAt: number;
};
type HistoricalMetric = "cashBalance" | "revenue" | "netIncome";
const financeWorkspaceViews = new Set<FinanceWorkspaceView>([
  "overview", "risk-actions", "daily-report", "control", "report", "purchasing", "inventory", "tax", "fixed-assets",
  "project-costing", "expense-control", "debt", "reconciliation", "reconciliation-board", "forecast", "budget", "close", "master",
  "commercial", "receivables", "ledger", "statements", "liquidity", "quality", "policy",
]);
const treasuryStatusLabels: Record<TreasuryOverviewReport["status"], string> = {
  DRAFT: "작성 중",
  REVIEWED: "검토 완료",
  FINAL: "최종 확정",
};

function financeDestinationView(destination: string): FinanceWorkspaceView {
  const [module, candidate] = destination.split(":");
  return module === "finance" && financeWorkspaceViews.has(candidate as FinanceWorkspaceView)
    ? candidate as FinanceWorkspaceView
    : "control";
}
const financePeriodLabels: Record<FinancePeriod, string> = {
  day: "일",
  week: "주",
  month: "월",
  quarter: "분기",
};

const deals = [
  { company: "네오클라우드", rep: "김민준", stage: "계약검토", amount: "₩420M", due: "8/14", health: "good" },
  { company: "브릿지AI", rep: "박서연", stage: "견적", amount: "₩285M", due: "8/16", health: "good" },
  { company: "데이터포지", rep: "이도윤", stage: "원가확인", amount: "₩196M", due: "8/12", health: "warn" },
  { company: "오로라랩스", rep: "최유진", stage: "수금대기", amount: "₩148M", due: "8/09", health: "late" },
];

const incentiveRows = [
  { rep: "김민준", sales: "₩486M", margin: "11.8%", incentive: "₩1,652,400", status: "검토완료" },
  { rep: "박서연", sales: "₩392M", margin: "9.4%", incentive: "₩862,400", status: "대표확인" },
  { rep: "이도윤", sales: "₩344M", margin: "7.1%", incentive: "₩361,200", status: "원가확인" },
  { rep: "최유진", sales: "₩281M", margin: "4.8%", incentive: "₩0", status: "기준미달" },
];

const peopleRows = [
  { name: "김민준", role: "영업팀 · 책임", state: "재직", start: "2024.03.11", leave: "7.5일", flag: "" },
  { name: "박서연", role: "경영지원 · 매니저", state: "재직", start: "2025.01.06", leave: "4일", flag: "" },
  { name: "이도윤", role: "구매팀 · 매니저", state: "재직", start: "2025.07.31", leave: "-1일", flag: "minus" },
  { name: "최유진", role: "회계 · 주니어", state: "재직", start: "2025.11.03", leave: "1일", flag: "" },
  { name: "정하늘", role: "기술팀 · 엔지니어", state: "온보딩", start: "2026.08.17", leave: "-", flag: "new" },
];

const moduleCopy: Record<ModuleKey, { title: string; desc: string; action: string; search: string }> = {
  finance: {
    title: "2024년부터 오늘까지, 하나의 재무 흐름으로",
    desc: "이카운트 과거 원장과 Clobe 최신 데이터를 연결해 손익·자금·채권채무·장부 품질을 함께 확인합니다.",
    action: "자금일보 작성",
    search: "계좌, 거래처, 전표 검색",
  },
  sales: {
    title: "매출에서 인센티브까지 연결",
    desc: "영업 건의 원가 검증, 수금, 마진과 지급 예정 인센티브를 한 흐름으로 관리합니다.",
    action: "영업 건 등록",
    search: "거래처, 담당자, 영업 건 검색",
  },
  hr: {
    title: "사람의 변화를 놓치지 않게",
    desc: "입퇴사, 근태·연차, 급여와 법정 일정을 직원 단위로 이어서 관리합니다.",
    action: "구성원 등록",
    search: "이름, 조직, 인사기록 검색",
  },
  compensation: {
    title: "임금과 인센티브를 하나의 계산 흐름으로",
    desc: "매출 원장의 인센티브 결과와 직원별 임금·수당을 같은 기준으로 계산합니다.",
    action: "직원 추가",
    search: "직원, 부서, 지급 항목 검색",
  },
};

function formatWon(value: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCompactWon(value: number) {
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (absolute >= 100_000_000) return `${sign}₩${(absolute / 100_000_000).toFixed(2)}억`;
  if (absolute >= 10_000) return `${sign}₩${(absolute / 10_000).toFixed(0)}만`;
  return formatWon(value);
}

function ERPTopNavigation({ active, onChange, onOpenAlert, openRequestKey = 0 }: { active: ModuleKey; onChange: (module: ModuleKey) => void; onOpenAlert: (alert: ERPAlert) => void; openRequestKey?: number }) {
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [dataGovernanceOpen, setDataGovernanceOpen] = useState(false);
  const [dataGovernanceView, setDataGovernanceView] = useState<"trust" | "integration" | "audit" | "impact">("trust");
  const [operationTasks, setOperationTasks] = useState<OperationTask[]>([]);
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [operationsError, setOperationsError] = useState("");
  const [dismissedAlertIds, setDismissedAlertIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = window.localStorage.getItem("xdnode-dismissed-alerts");
      return saved ? JSON.parse(saved) as string[] : [];
    } catch {
      return [];
    }
  });
  const visibleAlerts = erpAlerts.filter((alert) => !dismissedAlertIds.includes(alert.id));
  const activeTasks = operationTasks.filter((task) => task.status !== "DONE");
  const notificationCount = activeTasks.length + visibleAlerts.length;

  useEffect(() => {
    if (openRequestKey > 0) setAlertsOpen(true);
  }, [openRequestKey]);

  useEffect(() => {
    if (!alertsOpen) return;
    let cancelled = false;
    setOperationsLoading(true);
    setOperationsError("");
    fetch("/api/operations")
      .then(async (response) => {
        const data = await response.json() as { tasks?: OperationTask[]; error?: string };
        if (!response.ok) throw new Error(data.error || "통합 업무를 불러오지 못했습니다.");
        if (!cancelled) setOperationTasks(data.tasks ?? []);
      })
      .catch((error: unknown) => {
        if (!cancelled) setOperationsError(error instanceof Error ? error.message : "통합 업무를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setOperationsLoading(false);
      });
    return () => { cancelled = true; };
  }, [alertsOpen]);

  function dismissAlert(alertId: string) {
    setDismissedAlertIds((current) => {
      const next = current.includes(alertId) ? current : [...current, alertId];
      window.localStorage.setItem("xdnode-dismissed-alerts", JSON.stringify(next));
      return next;
    });
  }

  function openAlert(alert: ERPAlert) {
    if (!alert.destination) return;
    onOpenAlert(alert);
    setAlertsOpen(false);
  }

  function taskDestination(task: OperationTask): ERPAlert["destination"] {
    const [module, view] = task.destination.split(":");
    if (module === "finance") return { module: "finance", financeView: view as FinanceWorkspaceView };
    if (module === "hr") return { module: "hr", hrView: view || "dashboard" };
    if (module === "sales") return { module: "sales" };
    return undefined;
  }

  function openWorkbenchDestination(destination: string) {
    if (destination === "settings:data-governance") {
      setDataGovernanceView("trust");
      setDataGovernanceOpen(true);
      setWorkbenchOpen(false);
      return;
    }
    if (destination === "settings:data-integration") {
      setDataGovernanceView("integration");
      setDataGovernanceOpen(true);
      setWorkbenchOpen(false);
      return;
    }
    if (destination === "data-control:master-impact") {
      setDataGovernanceView("impact");
      setDataGovernanceOpen(true);
      setWorkbenchOpen(false);
      return;
    }
    const [module, view] = destination.split(":");
    const target = module === "finance"
      ? { module: "finance" as const, financeView: financeDestinationView(destination) }
      : module === "hr" || module === "recruitment"
        ? { module: "hr" as const, hrView: view || (module === "recruitment" ? "recruitment" : "dashboard") }
        : module === "sales" ? { module: "sales" as const } : undefined;
    if (target) onOpenAlert({ id: `workbench-${destination}`, category: "오늘 업무", title: "관련 업무", description: "", time: "", destination: target });
    setWorkbenchOpen(false);
  }

  async function updateTask(task: OperationTask, status: OperationTask["status"]) {
    setOperationsError("");
    const response = await fetch("/api/operations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: task.id, status, reason: status === "DONE" ? "알림 센터에서 완료 처리" : "알림 센터에서 처리 시작" }),
    });
    const data = await response.json() as { task?: OperationTask; error?: string };
    if (!response.ok || !data.task) {
      setOperationsError(data.error || "업무 상태를 변경하지 못했습니다.");
      return;
    }
    setOperationTasks((current) => current.map((item) => item.id === task.id ? data.task! : item));
  }

  function openTask(task: OperationTask) {
    if (task.destination === "data-control:master-impact") {
      setDataGovernanceView("impact");
      setDataGovernanceOpen(true);
      setAlertsOpen(false);
      return;
    }
    if (task.destination === "settings:data-governance") {
      setDataGovernanceView("trust");
      setDataGovernanceOpen(true);
      void updateTask(task, "IN_PROGRESS");
      setAlertsOpen(false);
      return;
    }
    if (task.destination === "settings:data-integration") {
      setDataGovernanceView("integration");
      setDataGovernanceOpen(true);
      void updateTask(task, "IN_PROGRESS");
      setAlertsOpen(false);
      return;
    }
    const destination = task.module === "finance" && task.sourceType === "SYSTEM_RULE"
      ? { module: "finance" as const, financeView: "risk-actions" as const }
      : taskDestination(task);
    if (destination) onOpenAlert({
      id: task.id,
      category: task.category,
      title: task.title,
      description: task.description,
      time: task.dueDate || "기한 없음",
      destination,
    });
    void updateTask(task, "IN_PROGRESS");
    setAlertsOpen(false);
  }

  return (
    <>
      <header className="erp-top-nav">
        <div className="erp-top-brand">
          <span className="brand-mark">XD</span>
          <div>
            <strong>XD NODE</strong>

          </div>
        </div>

        <nav className="erp-module-tabs" aria-label="ERP 모듈">
          {modules.map((module) => (
            <button
              type="button"
              className={active === module.key ? "erp-module-tab active" : "erp-module-tab"}
              key={module.key}
              aria-current={active === module.key ? "page" : undefined}
              onClick={() => onChange(module.key)}
            >
              <span className="module-glyph">{module.glyph}</span>
              <span>
                <strong>{module.label}</strong>

              </span>
            </button>
          ))}
        </nav>

        <div className="erp-nav-spacer" />
        <div className="erp-sync-state">
          <span className="status-dot" />
          <div><strong>Clobe · 2026 데이터</strong><small>{Number(financeCurrentData.asOf.slice(5, 7))}월 {Number(financeCurrentData.asOf.slice(8, 10))}일 수집</small></div>
        </div>
        <button type="button" className="erp-workbench-button" aria-expanded={workbenchOpen} onClick={() => setWorkbenchOpen(true)}>
          <span aria-hidden="true">✓</span><strong>오늘 업무</strong>
        </button>
        <button type="button" className="erp-data-governance-button" aria-expanded={dataGovernanceOpen} onClick={() => { setDataGovernanceView("trust"); setDataGovernanceOpen(true); }}>
          <span aria-hidden="true">◇</span><strong>데이터 통제</strong>
        </button>
        <button
          type="button"
          className="erp-alarm-button"
          aria-label={`확인할 알람과 업무 ${notificationCount}건`}
          aria-expanded={alertsOpen}
          onClick={() => setAlertsOpen(true)}
        >
          <span className="erp-alarm-glyph" aria-hidden="true">♢</span>
          <span>알람</span>
          <em>{notificationCount}</em>
        </button>
      </header>

      {alertsOpen && (
        <>
          <button type="button" className="erp-alarm-backdrop" aria-label="알람 닫기" onClick={() => setAlertsOpen(false)} />
          <aside className="erp-alarm-panel" role="dialog" aria-modal="true" aria-label="확인할 알람">
            <div className="erp-alarm-panel-header">
              <div data-korean-heading><h2>통합 업무함</h2></div>
              <button type="button" aria-label="닫기" onClick={() => setAlertsOpen(false)}>×</button>
            </div>
            <div className="erp-alarm-summary"><strong>처리할 업무 {activeTasks.length}건 · 일반 알림 {visibleAlerts.length}건</strong><span>실제 데이터에서 생성된 업무는 처리상태와 감사기록이 서버에 저장됩니다.</span><button type="button" onClick={() => { setAlertsOpen(false); setWorkbenchOpen(true); }}>오늘 업무 전체 보기 →</button></div>
            <div className="erp-alarm-list">
              {operationsLoading && <div className="erp-alarm-empty"><span>…</span><strong>통합 업무를 불러오는 중입니다.</strong></div>}
              {operationsError && <div className="erp-alarm-empty"><span>!</span><strong>{operationsError}</strong><p>기존 일반 알림은 계속 확인할 수 있습니다.</p></div>}
              {activeTasks.map((task) => (
                <article key={task.id} className={`erp-alarm-item operation-task priority-${task.priority.toLowerCase()}`}>
                  <span className="erp-alarm-unread" aria-hidden="true" />
                  <div>
                    <p><em>{task.category} · {task.priority}</em><time>{task.dueDate || "기한 없음"}</time></p>
                    <h3>{task.title}</h3><span>{task.description}</span>
                    <div className="operation-task-actions">
                      {task.destination && <button type="button" className="erp-alarm-action" onClick={() => openTask(task)}>{task.module === "finance" && task.sourceType === "SYSTEM_RULE" ? "조치 등록 →" : "관련 업무 열기 →"}</button>}
                      {task.sourceType !== "APPROVAL" && task.sourceType !== "MASTER_IMPACT_CASE" && task.id !== "data-governance-attention" && task.id !== "integration-center-attention" && !(task.module === "finance" && task.sourceType === "SYSTEM_RULE") && <button type="button" className="erp-alarm-dismiss" onClick={() => void updateTask(task, "DONE")}>완료 처리</button>}
                    </div>
                  </div>
                </article>
              ))}
              {visibleAlerts.map((alert) => (
                <article key={alert.id} className="erp-alarm-item">
                  <span className="erp-alarm-unread" aria-hidden="true" />
                  <div>
                    <p><em>{alert.category}</em><time>{alert.time}</time></p>
                    <h3>{alert.title}</h3><span>{alert.description}</span>
                    {alert.destination
                      ? <button type="button" className="erp-alarm-action" onClick={() => openAlert(alert)}>관련 화면에서 확인 →</button>
                      : <button type="button" className="erp-alarm-dismiss" onClick={() => dismissAlert(alert.id)}>확인 후 끄기</button>}
                  </div>
                </article>
              ))}
              {!operationsLoading && activeTasks.length === 0 && visibleAlerts.length === 0 && <div className="erp-alarm-empty"><span>✓</span><strong>모든 업무와 알람을 확인했습니다.</strong><p>새로운 확인 사항이 생기면 이곳에 표시됩니다.</p></div>}
            </div>
          </aside>
        </>
      )}
      {workbenchOpen && <OperationsWorkbench onClose={() => setWorkbenchOpen(false)} onNavigate={openWorkbenchDestination} />}
      {dataGovernanceOpen && <DataGovernanceCenter initialView={dataGovernanceView} onClose={() => setDataGovernanceOpen(false)} />}
    </>
  );
}

const MODULE_STORAGE_KEY = "xdnode-active-module";
const validModuleKeys: ModuleKey[] = ["finance", "sales", "hr", "compensation"];

export default function Home() {
  const [active, setActive] = useState<ModuleKey>("finance");
  const [hrNavigation, setHrNavigation] = useState({ view: "dashboard", requestKey: 0 });
  const [search, setSearch] = useState("");
  const [alertRequestKey, setAlertRequestKey] = useState(0);
  const [periodMenuOpen, setPeriodMenuOpen] = useState(false);
  const [financePeriod, setFinancePeriod] = useState<{ year: "2024" | "2025" | "2026"; label: string; requestKey: number }>({ year: "2026", label: "2026년 8월", requestKey: 0 });
  const [financeWorkspaceRequest, setFinanceWorkspaceRequest] = useState<{ view: FinanceWorkspaceView; requestKey: number }>({ view: "overview", requestKey: 0 });
  const [salesCreateRequestKey, setSalesCreateRequestKey] = useState(0);
  const [compensationAssistantModule, setCompensationAssistantModule] = useState<"compensation" | "incentive">("compensation");
  const [toast, setToast] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(MODULE_STORAGE_KEY);
    if (validModuleKeys.includes(saved as ModuleKey)) {
      setActive(saved as ModuleKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.localStorage.setItem(MODULE_STORAGE_KEY, active);
  }, [active]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key === "Escape" && document.activeElement === searchInputRef.current) {
        setSearch("");
        searchInputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const copy = moduleCopy[active];

  function openAlert(alert: ERPAlert) {
    if (!alert.destination) return;
    if (alert.destination.hrView) {
      setHrNavigation((current) => ({ view: alert.destination?.hrView ?? current.view, requestKey: current.requestKey + 1 }));
    }
    if (alert.destination.financeView) {
      setFinanceWorkspaceRequest((current) => ({ view: alert.destination?.financeView ?? current.view, requestKey: current.requestKey + 1 }));
    }
    setActive(alert.destination.module);
    setSearch("");
  }

  function exportFinanceSnapshot() {
    const rows = [
      ["구분", "값", "기준일"],
      ["매출 공급가액", financeCurrentData.sourceSummary.salesSupplyValue, financeCurrentData.asOf],
      ["매입 공급가액", financeCurrentData.sourceSummary.purchaseSupplyValue, financeCurrentData.asOf],
      ["매출 세금계산서", financeCurrentData.sourceSummary.salesInvoices, financeCurrentData.asOf],
      ["매입 세금계산서", financeCurrentData.sourceSummary.purchaseInvoices, financeCurrentData.asOf],
      ...financeCurrentData.accounts.map((account) => [`계좌 · ${account.name} (${account.last4})`, account.krwBalance, financeCurrentData.asOf]),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `XD_NODE_재무현황_${financeCurrentData.asOf}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setToast("현재 재무현황을 CSV 파일로 내보냈습니다.");
    window.setTimeout(() => setToast(""), 3200);
  }

  function selectFinancePeriod(year: "2024" | "2025" | "2026", label: string) {
    setFinancePeriod((current) => ({ year, label, requestKey: current.requestKey + 1 }));
    setPeriodMenuOpen(false);
    setActive("finance");
  }

  function requestFinanceWorkspace(view: FinanceWorkspaceView) {
    setActive("finance");
    setFinanceWorkspaceRequest((current) => ({ view, requestKey: current.requestKey + 1 }));
  }

  if (active === "hr") {
    return (
      <div className="hr-module-shell">
        <ERPTopNavigation active={active} onChange={(module) => { setActive(module); setSearch(""); }} onOpenAlert={openAlert} openRequestKey={alertRequestKey} />
        <HRWorkspace requestedView={hrNavigation.view} navigationRequestKey={hrNavigation.requestKey} />
        <LocalCodexAssistant module="hr" />
      </div>
    );
  }

  if (active === "compensation") {
    return (
      <div className="compensation-erp-shell">
        <ERPTopNavigation active={active} onChange={(module) => { setActive(module); setSearch(""); }} onOpenAlert={openAlert} openRequestKey={alertRequestKey} />
        <CompensationCalculator onAssistantModuleChange={setCompensationAssistantModule} />
        <LocalCodexAssistant module={compensationAssistantModule} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <ERPTopNavigation active={active} onChange={(module) => { setActive(module); setSearch(""); }} onOpenAlert={openAlert} openRequestKey={alertRequestKey} />

      <main className={`main ${active === "finance" ? "finance-main" : active === "sales" ? "sales-main" : ""}`}>
        {active !== "finance" && active !== "sales" && <header className="topbar">
          <div className="mobile-brand">XD NODE</div>
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={copy.search}
              aria-label={copy.search}
            />
            {search && <button type="button" className="search-clear" aria-label="검색어 지우기" onClick={() => { setSearch(""); searchInputRef.current?.focus(); }}>×</button>}
            <kbd>⌘ K</kbd>
          </label>
          <div className="top-actions">
            <div className="period-picker">
              <button type="button" className="period-button" aria-expanded={periodMenuOpen} onClick={() => setPeriodMenuOpen((open) => !open)}>{active === "finance" ? financePeriod.label : "2026년 8월"} <span>⌄</span></button>
              {periodMenuOpen && <div className="period-menu" role="menu" aria-label="재무 조회 기간">
                <button type="button" className={financePeriod.year === "2026" ? "active" : ""} onClick={() => selectFinancePeriod("2026", "2026년 8월")}><strong>2026년 8월</strong><small>Clobe 최신 스냅샷</small></button>
                <button type="button" className={financePeriod.year === "2025" ? "active" : ""} onClick={() => selectFinancePeriod("2025", "2025년 결산")}><strong>2025년 결산</strong><small>이카운트 확정 자료</small></button>
                <button type="button" className={financePeriod.year === "2024" ? "active" : ""} onClick={() => selectFinancePeriod("2024", "2024년 결산")}><strong>2024년 결산</strong><small>이카운트 확정 자료</small></button>
              </div>}
            </div>
            <button type="button" className="icon-button" aria-label="알람 센터 열기" onClick={() => setAlertRequestKey((key) => key + 1)}>♢<span className="notification-ping" /></button>
          </div>
        </header>}

        <section className={`module-hero ${active}`}>
          <div data-korean-heading>

            <h1>{copy.title}</h1>
            <p>{copy.desc}</p>
          </div>
          <div className="hero-actions">
            <button type="button" className="secondary-button" onClick={active === "finance" ? exportFinanceSnapshot : () => { setToast("이 화면의 내보내기 기능은 준비 중입니다."); window.setTimeout(() => setToast(""), 3200); }}>내보내기</button>
            <button className="primary-button" onClick={() => active === "finance" ? requestFinanceWorkspace("daily-report") : setSalesCreateRequestKey((key) => key + 1)}><span>＋</span>{copy.action}</button>
          </div>
        </section>

        {active === "finance" && <FinanceDashboard search={search} requestedWorkspace={financeWorkspaceRequest.view} workspaceRequestKey={financeWorkspaceRequest.requestKey} requestedYear={financePeriod.year} yearRequestKey={financePeriod.requestKey} onOpenAlerts={() => setAlertRequestKey((key) => key + 1)} />}
        {active === "sales" && <SalesWorkspace search={search} createRequestKey={salesCreateRequestKey} />}
        {active === "hr" && <HrDashboard search={search} />}
      </main>


      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </div>
  );
}

function FinanceBars({ data, currentLabel }: { data: Array<{ label: string; value: number }>; currentLabel?: string }) {
  const max = Math.max(1, ...data.map((item) => Math.abs(item.value)));
  return (
    <div className="finance-bar-stage">
      <div className="finance-grid-lines"><i /><i /><i /></div>
      <div className="finance-bars">
        {data.map((item, index) => (
          <div className="finance-bar-item" key={`${item.label}-${index}`}>
            <span
              className={`bar ${item.value < 0 ? "negative" : ""} ${currentLabel === item.label || (!currentLabel && index === data.length - 1) ? "current" : ""}`}
              title={`${item.label} · ${formatWon(item.value)}`}
              style={{ height: `${item.value === 0 ? 2 : Math.max(8, (Math.abs(item.value) / max) * 100)}%` }}
            />
            <small>{item.label}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function aggregateCommercialRows(
  rows: ReadonlyArray<{ date: string; partner: string; amount: number; count: number }>,
  startDate: string,
  endDate: string,
  search: string,
) {
  const grouped = new Map<string, { partner: string; amount: number; count: number }>();
  for (const row of rows) {
    if (row.date < startDate || row.date > endDate) continue;
    if (search && !row.partner.toLowerCase().includes(search.toLowerCase())) continue;
    const current = grouped.get(row.partner) ?? { partner: row.partner, amount: 0, count: 0 };
    current.amount += row.amount;
    current.count += row.count;
    grouped.set(row.partner, current);
  }
  return [...grouped.values()].filter((row) => row.amount !== 0).sort((a, b) => b.amount - a.amount);
}

function accountBankName(code: string) {
  return ({ "004": "KB국민", "011": "NH농협", "020": "우리", "088": "신한" } as Record<string, string>)[code] ?? "은행";
}

async function financeResponseJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "재무 운영 데이터를 불러오지 못했습니다.");
  return payload;
}

function FinanceDashboard({ search, requestedWorkspace, workspaceRequestKey, requestedYear, yearRequestKey, onOpenAlerts }: {
  search: string;
  requestedWorkspace: FinanceWorkspaceView;
  workspaceRequestKey: number;
  requestedYear: "2024" | "2025" | "2026";
  yearRequestKey: number;
  onOpenAlerts: () => void;
}) {
  const [workspace, setWorkspace] = useState<FinanceWorkspaceView>("overview");
  const [overviewYear, setOverviewYear] = useState<"2024" | "2025" | "2026">("2026");
  const [statementYear, setStatementYear] = useState<"2024" | "2025">("2025");
  const [period, setPeriod] = useState<FinancePeriod>("week");
  const [metric, setMetric] = useState<FinanceMetric>("cash");
  const [historicalMetric, setHistoricalMetric] = useState<HistoricalMetric>("revenue");
  const [exposureType, setExposureType] = useState<"receivables" | "payables">("receivables");
  const [liquidityMetric, setLiquidityMetric] = useState<"cash" | "ar" | "ap">("cash");
  const [commercialStartDate, setCommercialStartDate] = useState("2026-01-01");
  const [commercialEndDate, setCommercialEndDate] = useState(financeCurrentData.asOf);
  const [assistantQuestion, setAssistantQuestion] = useState("");
  const [assistantAnswer, setAssistantAnswer] = useState("2024~2026년 재무 데이터 범위와 출처를 구분해 답변합니다. 궁금한 항목을 선택하거나 질문을 입력해 주세요.");
  const [assistantStatus, setAssistantStatus] = useState<"idle" | "loading" | "error">("idle");
  const [assistantMeta, setAssistantMeta] = useState<FinanceAssistantMeta>({
    provider: "RULE_BASED_FALLBACK", evidenceStatus: "REVIEW_REQUIRED", evidenceLabel: "질문 전",
    basisAsOf: financeCurrentData.asOf, limitations: ["질문을 입력하면 답변에 사용한 원장과 마감 상태를 함께 표시합니다."],
    sources: [
      { id: "ecount-2024", label: "2024 승인 결산", period: "2024.01.01~12.31", basis: "재무상태표·합계잔액시산표", status: "CONFIRMED", destination: "statements" },
      { id: "ecount-2025", label: "2025 승인 결산", period: "2025.01.01~12.31", basis: "계정별원장·분개장·자금현황표", status: "CONFIRMED", destination: "statements" },
      { id: "posted-ledger-2026", label: "2026 운영 원장", period: `기준일 ${financeCurrentData.asOf}`, basis: "질문 시 POSTED 전표를 재계산", status: "REVIEW", destination: "ledger" },
    ],
  });
  const [assistantHistory, setAssistantHistory] = useState<FinanceAssistantHistoryView[]>([]);
  const [assistantHistoryError, setAssistantHistoryError] = useState("");
  const [assistantActiveEntry, setAssistantActiveEntry] = useState<FinanceAssistantHistoryView | null>(null);
  const [assistantPromotion, setAssistantPromotion] = useState<FinanceAssistantHistoryView | null>(null);
  const [financeOverviewRefreshKey, setFinanceOverviewRefreshKey] = useState(0);
  const [riskPolicy, setRiskPolicy] = useState<FinanceRiskPolicy>(DEFAULT_FINANCE_RISK_POLICY);
  const [financeOverview, setFinanceOverview] = useState<{
    loading: boolean;
    operationsError: string;
    treasuryError: string;
    tasks: OperationTask[];
    treasury: TreasuryOverviewResponse | null;
  }>({ loading: true, operationsError: "", treasuryError: "", tasks: [], treasury: null });

  useEffect(() => {
    if (workspaceRequestKey > 0) {
      setWorkspace(requestedWorkspace);
    }
  }, [requestedWorkspace, workspaceRequestKey]);

  useEffect(() => {
    if (yearRequestKey > 0) {
      setOverviewYear(requestedYear);
      setWorkspace("overview");
    }
  }, [requestedYear, yearRequestKey]);

  useEffect(() => {
    if (workspace !== "overview" || overviewYear !== "2026") return;
    let cancelled = false;
    void Promise.allSettled([
      fetch("/api/operations").then((response) => financeResponseJson<{ tasks: OperationTask[] }>(response)),
      fetch(`/api/finance/daily-treasury?date=${encodeURIComponent(financeCurrentData.asOf)}`)
        .then((response) => financeResponseJson<TreasuryOverviewResponse>(response)),
    ]).then(([operationsResult, treasuryResult]) => {
      if (cancelled) return;
      setFinanceOverview((current) => ({
        loading: false,
        operationsError: operationsResult.status === "rejected"
          ? operationsResult.reason instanceof Error ? operationsResult.reason.message : "재무 업무를 불러오지 못했습니다."
          : "",
        treasuryError: treasuryResult.status === "rejected"
          ? treasuryResult.reason instanceof Error ? treasuryResult.reason.message : "자금일보를 불러오지 못했습니다."
          : "",
        tasks: operationsResult.status === "fulfilled" ? operationsResult.value.tasks : current.tasks,
        treasury: treasuryResult.status === "fulfilled" ? treasuryResult.value : current.treasury,
      }));
    });
    return () => { cancelled = true; };
  }, [financeOverviewRefreshKey, overviewYear, workspace]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/finance/risk-policy", { cache: "no-store" })
      .then((response) => financeResponseJson<{ policy: FinanceRiskPolicy }>(response))
      .then((result) => { if (!cancelled) setRiskPolicy(result.policy); })
      .catch(() => { /* 초기 정책으로 화면을 유지하고 정책 화면에서 오류를 상세 표시합니다. */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/finance/assistant", { cache: "no-store" })
      .then((response) => financeResponseJson<{ history: FinanceAssistantHistoryView[] }>(response))
      .then((result) => { if (!cancelled) setAssistantHistory(result.history); })
      .catch((error) => { if (!cancelled) setAssistantHistoryError(error instanceof Error ? error.message : "답변 이력을 불러오지 못했습니다."); });
    return () => { cancelled = true; };
  }, []);

  const selectedHistorical = statementYear === "2024" ? financeHistoricalData.years["2024"] : financeHistoricalData.years["2025"];
  const trialBalanceSource = statementYear === "2024" ? financeHistoricalData.trialBalance2024 : financeHistoricalData.trialBalance2025;
  const trialBalance = trialBalanceSource.filter((row) => `${row.code} ${row.name}`.toLowerCase().includes(search.toLowerCase()));
  const historicalOverview = overviewYear === "2024" ? financeHistoricalData.years["2024"] : financeHistoricalData.years["2025"];
  const exposureRows = exposureType === "receivables" ? financeHistoricalData.receivables : financeHistoricalData.payables;
  const exposureExceptions = exposureType === "receivables" ? financeHistoricalData.receivableExceptions : financeHistoricalData.payableExceptions;
  const grossProfit = selectedHistorical.revenue - selectedHistorical.cogs;
  const grossMargin = selectedHistorical.revenue ? (grossProfit / selectedHistorical.revenue) * 100 : 0;
  const commercialPeriodValid = commercialStartDate <= commercialEndDate;
  const commercialSalesRows = useMemo(
    () => commercialPeriodValid ? aggregateCommercialRows(financeCurrentData.salesDaily2026, commercialStartDate, commercialEndDate, search) : [],
    [commercialEndDate, commercialPeriodValid, commercialStartDate, search],
  );
  const commercialPurchaseRows = useMemo(
    () => commercialPeriodValid ? aggregateCommercialRows(financeCurrentData.purchaseDaily2026, commercialStartDate, commercialEndDate, search) : [],
    [commercialEndDate, commercialPeriodValid, commercialStartDate, search],
  );
  const selectedSalesTotal = commercialSalesRows.reduce((sum, row) => sum + row.amount, 0);
  const selectedPurchaseTotal = commercialPurchaseRows.reduce((sum, row) => sum + row.amount, 0);
  const selectedSalesCount = commercialSalesRows.reduce((sum, row) => sum + row.count, 0);
  const selectedPurchaseCount = commercialPurchaseRows.reduce((sum, row) => sum + row.count, 0);
  const currentSalesYtd = financeCurrentData.sourceSummary.salesSupplyValue;
  const salesForecast = buildSalesForecast(financeCurrentData.salesDaily2026, financeCurrentInsights.taxInvoicesAsOf);
  const baseSalesForecast = salesForecast.scenarios.find((scenario) => scenario.key === "base")!;
  const priorYearSales = financeHistoricalData.years["2025"].revenue;
  const monthlySalesChart = financeCurrentData.salesMonthly2026.map((row) => ({
    label: `${Number(row.month.slice(5))}월`,
    value: row.amount,
  }));
  const bankAssets = financeCurrentData.accountSummary.checkingBalanceSum + financeCurrentData.accountSummary.fxBalanceSumKrw;
  const bankLoans = financeCurrentData.accountSummary.loanBalanceSum;
  const liquidityCoverage = bankLoans ? bankAssets / bankLoans : 0;
  const accountRiskModel = buildAccountRiskModel(financeCurrentData.accountSummary, financeCurrentData.accounts, financeCurrentData.balanceTrend, riskPolicy);
  const accountRiskLevel = accountRiskModel.level;
  const bankActivity = financeCurrentInsights.bankActivity31Days;
  const activeFinanceTasks = financeOverview.tasks.filter((task) => task.module === "finance" && task.status !== "DONE");
  const displayedFinanceTasks = activeFinanceTasks.slice(0, 4);
  const treasurySnapshot = financeOverview.treasury?.preview ?? null;
  const treasuryReport = financeOverview.treasury?.selected ?? null;
  const treasuryWarnings = treasurySnapshot?.warnings ?? noTreasuryWarnings;
  const priorityTask = activeFinanceTasks.find((task) => task.priority === "CRITICAL")
    ?? activeFinanceTasks.find((task) => task.priority === "HIGH")
    ?? activeFinanceTasks[0]
    ?? null;
  const dailyBriefItems = useMemo(() => {
    const savedAnalysis = treasuryReport?.analysisText.split(/\r?\n+/).map((item) => item.trim()).filter(Boolean).slice(0, 6) ?? [];
    if (savedAnalysis.length) return savedAnalysis;
    if (treasurySnapshot) {
      const next7Incoming = treasurySnapshot.next7Days.explicitForecast.inflow + treasurySnapshot.next7Days.receivables.dueAmount;
      const next7Outgoing = treasurySnapshot.next7Days.explicitForecast.outflow + treasurySnapshot.next7Days.payables.dueAmount + treasurySnapshot.next7Days.debt.dueAmount;
      return [
        `은행성 자산은 ${formatWon(treasurySnapshot.balances.closingBankAssets)}이며 직전 관측일 대비 ${treasurySnapshot.balances.movement >= 0 ? "증가" : "감소"} ${formatWon(Math.abs(treasurySnapshot.balances.movement))}입니다.`,
        `${bankActivity.startDate}~${bankActivity.endDate} 은행 입금 ${formatWon(bankActivity.inflowKrw)}, 출금 ${formatWon(bankActivity.outflowKrw)}, 순유입 ${formatWon(bankActivity.netInflowKrw)}입니다.`,
        `향후 7일 연결 원천의 예정 유입은 ${formatWon(next7Incoming)}, 예정 유출은 ${formatWon(next7Outgoing)}입니다.`,
        treasuryWarnings.length ? `통제 경고: ${treasuryWarnings.map((warning) => warning.message).join(" · ")}` : "연결된 원천에서 추가 통제 경고가 없습니다.",
      ];
    }
    if (financeOverview.treasuryError) return ["자금일보 원장을 불러오지 못했습니다. 과거 분석 문장을 최신 결과처럼 표시하지 않습니다."];
    return ["최신 자금일보와 동결 스냅샷을 불러오는 중입니다."];
  }, [bankActivity, financeOverview.treasuryError, treasuryReport, treasurySnapshot, treasuryWarnings]);
  const dailyBriefRisk = activeFinanceTasks.some((task) => task.priority === "CRITICAL")
    ? "긴급"
    : activeFinanceTasks.some((task) => task.priority === "HIGH") || treasuryWarnings.length > 0 || accountRiskLevel !== "안정"
      ? "주의"
      : "안정";
  const dailyBriefMeta = financeOverview.treasuryError
    ? treasuryReport ? `새로고침 실패 · 이전 v${treasuryReport.version}` : "연결 오류"
    : financeOverview.loading
      ? treasuryReport ? `새로고침 중 · v${treasuryReport.version}` : "불러오는 중"
      : treasuryReport
        ? `v${treasuryReport.version} · ${treasuryStatusLabels[treasuryReport.status]} · ${treasuryReport.analysisSource === "AI" ? "AI" : `규칙 기반(${treasuryReport.aiStatus})`}`
        : "작성 필요";
  const dailyBriefDetail = financeOverview.treasuryError
    ? treasuryReport
      ? "최신 조회에 실패해 직전에 불러온 저장본을 표시합니다."
      : "자금일보 상태를 확인할 수 없어 수치를 임의로 보완하지 않았습니다."
    : financeOverview.loading
      ? "최신 저장 버전과 동결 스냅샷을 확인하고 있습니다."
      : treasuryReport
        ? `${treasuryReport.sourceAsOf} 원천으로 저장된 ${treasuryStatusLabels[treasuryReport.status]} 보고서입니다.`
        : "최신 원천 스냅샷은 확인되었지만 저장된 자금일보가 없습니다.";
  const dailyBriefPriority = priorityTask?.title ?? treasuryWarnings[0]?.message ?? "오늘 확인할 긴급 재무 업무가 없습니다.";

  const historicalChartData = overviewYear === "2025"
    ? financeHistoricalData.monthly2025.map((item) => ({
        label: `${item.month}월`,
        value: historicalMetric === "cashBalance" ? item.cashBalance : item[historicalMetric],
      }))
    : ["2024", "2025"].map((year) => {
        const value = year === "2024" ? financeHistoricalData.years["2024"] : financeHistoricalData.years["2025"];
        return { label: year, value: historicalMetric === "cashBalance" ? value.cash : value[historicalMetric] };
      });
  const currentChartSeries = useMemo(() => metric === "cash"
    ? buildBalanceSeries(financeCurrentData.balanceTrend, period)
    : buildAmountSeries(financeCurrentData.salesDaily2026, period, financeCurrentInsights.taxInvoicesAsOf), [metric, period]);
  const currentChartData = currentChartSeries.points;
  const overviewChart = overviewYear === "2026" ? currentChartData : historicalChartData;
  const chartLast = overviewChart.at(-1)?.value ?? 0;
  const chartFirst = overviewChart[0]?.value ?? 0;
  const chartChange = chartFirst !== 0 ? ((chartLast - chartFirst) / Math.abs(chartFirst)) * 100 : 0;
  const liquidityChart = financeHistoricalData.monthly2025.map((item) => ({
    label: `${item.month}월`,
    value: liquidityMetric === "cash" ? item.cashBalance : liquidityMetric === "ar" ? item.arBalance : item.apBalance,
  }));

  function selectWorkspace(next: FinanceWorkspaceView) {
    setWorkspace(next);
  }

  async function askFinanceAssistant(question: string) {
    const cleanQuestion = question.trim();
    if (!cleanQuestion || assistantStatus === "loading") return;
    setAssistantQuestion(cleanQuestion);
    setAssistantStatus("loading");
    setAssistantActiveEntry(null);
    setAssistantAnswer("승인된 재무 데이터와 출처를 확인하고 있습니다…");
    try {
      const response = await fetch("/api/finance/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: cleanQuestion }),
      });
      const data = await response.json() as Partial<FinanceAssistantMeta> & {
        answer?: string; error?: string; quotaExceeded?: boolean; historyEntry?: FinanceAssistantHistoryView;
      };
      if (!response.ok || !data.answer) {
        throw new Error(data.quotaExceeded ? "오늘의 AI 무료 사용 한도를 초과했습니다. 내일 다시 이용해 주세요." : data.error || "답변을 만들지 못했습니다.");
      }
      setAssistantAnswer(data.answer);
      if (data.provider && data.evidenceStatus && data.evidenceLabel && data.basisAsOf && data.sources && data.limitations) {
        setAssistantMeta({ provider: data.provider, evidenceStatus: data.evidenceStatus, evidenceLabel: data.evidenceLabel,
          basisAsOf: data.basisAsOf, sources: data.sources, limitations: data.limitations });
      }
      if (data.historyEntry) {
        setAssistantHistory((current) => [data.historyEntry!, ...current.filter((item) => item.id !== data.historyEntry!.id)].slice(0, 20));
        setAssistantActiveEntry(data.historyEntry);
        setAssistantHistoryError("");
      }
      setAssistantStatus("idle");
    } catch (error) {
      setAssistantStatus("error");
      setAssistantAnswer(error instanceof Error ? error.message : "재무 어시스턴트에 연결할 수 없습니다.");
    }
  }

  function submitAssistant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void askFinanceAssistant(assistantQuestion);
  }

  function restoreFinanceAssistantAnswer(entry: FinanceAssistantHistoryView) {
    setAssistantQuestion(entry.question); setAssistantAnswer(entry.answer); setAssistantStatus("idle");
    setAssistantActiveEntry(entry);
    setAssistantMeta({ provider: entry.provider, evidenceStatus: entry.evidenceStatus, evidenceLabel: entry.evidenceLabel,
      basisAsOf: entry.basisAsOf, sources: entry.sources, limitations: entry.limitations });
  }

  async function openFinanceAssistantSource(id: string) {
    setAssistantHistoryError("");
    try {
      const result = await financeResponseJson<{ entry: FinanceAssistantHistoryView }>(
        await fetch(`/api/finance/assistant?id=${encodeURIComponent(id)}`, { cache: "no-store" }),
      );
      restoreFinanceAssistantAnswer(result.entry);
      setAssistantHistory((current) => [result.entry, ...current.filter((item) => item.id !== result.entry.id)].slice(0, 20));
    } catch (error) {
      setAssistantHistoryError(error instanceof Error ? error.message : "연결된 답변 이력을 불러오지 못했습니다.");
    }
    setWorkspace("overview");
  }

  const historicalMetrics = overviewYear === "2026" ? null : [
    { label: "기말 자산", value: historicalOverview.assets, hint: "합계잔액시산표 기말잔액", trend: "neutral" as const },
    { label: "매출", value: historicalOverview.revenue, hint: overviewYear === "2025" ? "전년 대비 +95.8%" : "상품매출 기준", trend: overviewYear === "2025" ? "up" as const : "neutral" as const },
    { label: "당기순이익", value: historicalOverview.netIncome, hint: overviewYear === "2025" ? "전년 대비 -68.2%" : "결산후 기준", trend: overviewYear === "2025" ? "down" as const : "neutral" as const },
    { label: "기말 보통예금", value: historicalOverview.cash, hint: overviewYear === "2025" ? "전년 대비 +65.8%" : "자금현황표 대사 완료", trend: overviewYear === "2025" ? "up" as const : "neutral" as const },
  ];
  const normalizedSearch = search.trim().toLowerCase();
  const financeSearchResults = useMemo(() => {
    if (!normalizedSearch) return [];
    const rows: Array<{ key: string; title: string; detail: string; view: FinanceWorkspaceView }> = [];
    financeCurrentData.accounts.forEach((account) => rows.push({ key: `account-${account.id}`, title: account.name, detail: `${accountBankName(account.bankCode)} · 끝자리 ${account.last4} · ${formatWon(account.krwBalance)}`, view: "liquidity" }));
    financeHistoricalData.trialBalance2025.forEach((account) => rows.push({ key: `ledger-${account.code}`, title: account.name, detail: `계정 ${account.code} · 2025년 기말 ${formatWon(account.endingDebit - account.endingCredit)}`, view: "statements" }));
    financeHistoricalData.receivables.forEach((partner) => rows.push({ key: `receivable-${partner.index}`, title: partner.name, detail: `외상매출금 · 잔액 ${formatWon(partner.ending)}`, view: "receivables" }));
    financeHistoricalData.payables.forEach((partner) => rows.push({ key: `payable-${partner.index}`, title: partner.name, detail: `매입채무 · 잔액 ${formatWon(partner.ending)}`, view: "liquidity" }));
    const commercialPartners = new Map<string, { sales: number; purchases: number }>();
    financeCurrentData.salesDaily2026.forEach((item) => { const value = commercialPartners.get(item.partner) ?? { sales: 0, purchases: 0 }; value.sales += item.amount; commercialPartners.set(item.partner, value); });
    financeCurrentData.purchaseDaily2026.forEach((item) => { const value = commercialPartners.get(item.partner) ?? { sales: 0, purchases: 0 }; value.purchases += item.amount; commercialPartners.set(item.partner, value); });
    commercialPartners.forEach((value, partner) => rows.push({ key: `commercial-${partner}`, title: partner, detail: `매출 ${formatWon(value.sales)} · 매입 ${formatWon(value.purchases)}`, view: "commercial" }));
    return rows.filter((row) => `${row.title} ${row.detail}`.toLowerCase().includes(normalizedSearch)).slice(0, 12);
  }, [normalizedSearch]);

  const financeNavigation: Array<{ title: string; items: Array<[FinanceWorkspaceView, string, string]> }> = [
    { title: "재무 홈", items: [["overview", "통합 대시보드", "통"], ["risk-actions", "재무 경보 조치", "경"], ["daily-report", "일일 자금일보", "일"], ["control", "재무 운영센터", "운"], ["report", "월간 경영보고", "보"]] },
    { title: "거래 관리", items: [["purchasing", "구매·매입채무", "구"], ["expense-control", "법인카드·지출증빙", "증"], ["inventory", "재고·상품원가", "재"], ["commercial", "매입·매출 분석", "매"], ["receivables", "외상·미수 관리", "미"]] },
    { title: "재무 분석", items: [["project-costing", "프로젝트·원가센터", "프"], ["debt", "차입금·상환·약정", "차"], ["reconciliation", "자금 대사", "대"], ["reconciliation-board", "대사 현황판", "황"], ["forecast", "13주 자금예측", "예"], ["budget", "예산·실적", "실"], ["ledger", "총계정원장·시산표", "장"], ["statements", "손익·재무상태", "손"], ["liquidity", "자금·채권채무", "자"]] },
    { title: "데이터 관리", items: [["fixed-assets", "고정자산·감가상각", "고"], ["tax", "부가세 검토", "세"], ["master", "통합 재무 마스터", "기"], ["close", "월마감 통제", "마"], ["quality", "원장·데이터 점검", "원"], ["policy", "회사 재무정책", "설"]] },
  ];

  return (
    <div className="finance-workspace-layout">
      <aside className="finance-side-navigation" aria-label="재무회계 메뉴">
        <div className="finance-side-brand">
          <span>₩</span>
          <div><strong>재무회계</strong></div>
        </div>
        <nav>
          {financeNavigation.map((group) => (
            <div className="finance-side-group" key={group.title}>
              <p>{group.title}</p>
              {group.items.map(([key, label, icon]) => (
                <button type="button" aria-current={workspace === key ? "page" : undefined} className={workspace === key ? "active" : ""} key={key} onClick={() => selectWorkspace(key)}>
                  <span>{icon}</span><strong>{label}</strong>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="finance-side-footer">
          <button type="button" className="finance-side-alert" onClick={onOpenAlerts}><span>♢</span><strong>알림 센터</strong></button>
          <div><span>마지막 동기화</span><strong>{financeCurrentData.asOf.replaceAll("-", ".")}</strong><small>Clobe · 이카운트 자료 기준</small></div>
        </div>
      </aside>

      <div className="dashboard-stack finance-dashboard">

      {normalizedSearch && (
        <section className="panel finance-search-results" aria-live="polite">
          <div className="finance-search-heading"><div data-korean-heading><h2>‘{search.trim()}’ 검색 결과</h2></div><span>{financeSearchResults.length}건 표시</span></div>
          {financeSearchResults.length ? <div className="finance-search-list">{financeSearchResults.map((result) => (
            <button type="button" key={result.key} onClick={() => selectWorkspace(result.view)}><span>⌕</span><p><strong>{result.title}</strong><small>{result.detail}</small></p><em>관련 화면 →</em></button>
          ))}</div> : <div className="finance-empty">일치하는 계좌·거래처·계정과목이 없습니다.</div>}
        </section>
      )}

      {workspace === "overview" && (
        <>
          <div className="finance-scope-note finance-scope-expanded">

            <div className="finance-year-switch" aria-label="재무 기준연도">
              {(["2024", "2025", "2026"] as const).map((year) => <button type="button" key={year} className={overviewYear === year ? "active" : ""} onClick={() => setOverviewYear(year)}>{year}</button>)}
            </div>
            <strong>{overviewYear === "2026" ? `2026.01.01–${financeCurrentData.asOf.slice(5).replace("-", ".")}` : `${overviewYear}.01.01–12.31`}</strong>
            <p>{overviewYear === "2026" ? "Clobe 최신 스냅샷 · 매일 07:30 확인" : "이카운트 결산후 자료 · 원장/시산표 대사 완료"}</p>
          </div>

          <section className="kpi-grid">
            {overviewYear === "2026" ? (
              <>
                <Metric label="은행성 자산" value={formatCompactWon(bankAssets)} delta={`${financeCurrentData.asOf.slice(5).replace("-", "월 ")}일 현재`} trend="neutral" hint="원화·외화 원화환산 합계" />
                <Metric label="최근 31일 순유입" value={formatCompactWon(bankActivity.netInflowKrw)} delta={`입금 ${formatCompactWon(bankActivity.inflowKrw)} · 출금 ${formatCompactWon(bankActivity.outflowKrw)}`} trend={bankActivity.netInflowKrw >= 0 ? "up" : "down"} hint={bankActivity.scopeNote} />
                <Metric label="외화 자산 비중" value={`${(accountRiskModel.metrics.fxConcentration * 100).toFixed(1)}%`} delta="환율 변동 집중도" trend="down" hint={`외화예금 ${formatCompactWon(financeCurrentData.accountSummary.fxBalanceSumKrw)}`} />
                <Metric label="대출 대비 유동성" value={`${(liquidityCoverage * 100).toFixed(1)}%`} delta={`대출 잔액 ${formatCompactWon(bankLoans)}`} trend="down" hint="은행성 자산 ÷ 대출 잔액" />
              </>
            ) : historicalMetrics?.map((item) => <Metric key={item.label} label={item.label} value={formatCompactWon(item.value)} delta={item.hint} trend={item.trend} hint={`${overviewYear}년 결산 자료`} />)}
          </section>

          <section className="finance-alert-section" aria-label="재무 알림">
            <div className="finance-section-heading">
              <div data-korean-heading><h2>지금 확인할 재무 알림</h2></div>
              <div className="finance-alert-heading-actions">
                <button type="button" disabled={financeOverview.loading} onClick={() => {
                  setFinanceOverview((current) => ({ ...current, loading: true, operationsError: "", treasuryError: "" }));
                  setFinanceOverviewRefreshKey((current) => current + 1);
                }}>{financeOverview.loading ? "확인 중" : "새로고침"}</button>
                <span>확인 필요 {activeFinanceTasks.length}건</span>
              </div>
            </div>
            <div className="finance-alert-grid">
              {displayedFinanceTasks.map((task) => (
                <article className={`finance-alert-card ${task.priority === "CRITICAL" ? "critical" : task.priority === "HIGH" ? "warning" : "info"}`} key={task.id}>
                  <span>{task.category} · {task.priority}</span><strong>{task.title}</strong><p>{task.description}</p>
                  <button type="button" onClick={() => setWorkspace(task.sourceType === "SYSTEM_RULE" ? "risk-actions" : financeDestinationView(task.destination))}>{task.sourceType === "SYSTEM_RULE" ? "조치 등록 →" : "관련 업무 열기 →"}</button>
                </article>
              ))}
              {financeOverview.loading && displayedFinanceTasks.length === 0 && (
                <article className="finance-alert-card info finance-alert-state"><span>연결 중</span><strong>실제 재무 업무를 확인하고 있습니다.</strong><p>완료 여부와 우선순위를 서버 업무원장에서 불러옵니다.</p></article>
              )}
              {!financeOverview.loading && financeOverview.operationsError && (
                <article className="finance-alert-card critical finance-alert-state"><span>{displayedFinanceTasks.length ? "새로고침 실패" : "연결 오류"}</span><strong>재무 업무를 불러오지 못했습니다.</strong><p>{financeOverview.operationsError} {displayedFinanceTasks.length ? "직전에 불러온 업무를 유지합니다." : "고정된 과거 알림을 대신 표시하지 않습니다."}</p></article>
              )}
              {!financeOverview.loading && !financeOverview.operationsError && displayedFinanceTasks.length === 0 && (
                <article className="finance-alert-card info finance-alert-state"><span>처리 완료</span><strong>현재 미완료 재무 업무가 없습니다.</strong><p>새로운 규칙 기반 업무가 생성되면 이 영역에 우선순위대로 표시됩니다.</p></article>
              )}
            </div>
          </section>

          <section className="content-grid finance-insight-grid">
            <article className="panel finance-chart-panel">
              <div className="finance-chart-head">
                <div data-korean-heading><h2>{overviewYear === "2026" ? (metric === "cash" ? "자금 잔액 변화" : "세금계산서 매출 공급가액") : (historicalMetric === "cashBalance" ? "보통예금 추이" : historicalMetric === "revenue" ? "회계상 매출 추이" : "당기순이익 추이")}</h2></div>
                <div className="finance-chart-controls">
                  {overviewYear === "2026" ? (
                    <>
                      <div className="segment-control"><button className={metric === "cash" ? "active" : ""} onClick={() => setMetric("cash")}>자금</button><button className={metric === "sales" ? "active" : ""} onClick={() => setMetric("sales")}>세금계산서 매출</button></div>
                      <div className="segment-control period">{(Object.keys(financePeriodLabels) as FinancePeriod[]).map((key) => <button key={key} className={period === key ? "active" : ""} onClick={() => setPeriod(key)}>{financePeriodLabels[key]}</button>)}</div>
                    </>
                  ) : (
                    <div className="segment-control"><button className={historicalMetric === "cashBalance" ? "active" : ""} onClick={() => setHistoricalMetric("cashBalance")}>자금</button><button className={historicalMetric === "revenue" ? "active" : ""} onClick={() => setHistoricalMetric("revenue")}>매출</button><button className={historicalMetric === "netIncome" ? "active" : ""} onClick={() => setHistoricalMetric("netIncome")}>순이익</button></div>
                  )}
                </div>
              </div>
              <div className="finance-chart-summary"><div><strong>{formatCompactWon(chartLast)}</strong><span>{overviewYear === "2026" ? currentChartSeries.summaryLabel : "선택 기간 값"}</span></div><em className={chartChange >= 0 ? "positive" : "negative"}>{chartFirst ? `${chartChange >= 0 ? "+" : ""}${chartChange.toFixed(1)}%` : "비교 기준 없음"}</em></div>
              <FinanceBars data={overviewChart} />
              <div className="chart-coverage-note"><span>i</span>{overviewYear === "2026" ? currentChartSeries.coverageNote : overviewYear === "2025" ? "월별 수치는 계정별원장의 결산 및 이월 전표를 포함해 재구성했습니다." : "2024년은 연말 기준 자료만 제공되어 2024·2025 연간 값을 비교합니다."}</div>
            </article>

            <article className="panel ai-daily-brief">
              <div className="ai-brief-head"><span>AI</span><div data-korean-heading><h2>오늘의 자금일보</h2></div><em>원천 {financeCurrentData.asOf}</em></div>
              <div className="ai-brief-hero"><small>{dailyBriefMeta}</small><strong>{dailyBriefRisk}</strong><p>{dailyBriefDetail}</p></div>
              <ol className="ai-brief-list">{dailyBriefItems.map((item, index) => <li key={`${index}-${item}`}><span>{index + 1}</span><p>{item}</p></li>)}</ol>
              <div className="ai-priority"><div><span>오늘의 우선순위</span><strong>{dailyBriefPriority}</strong></div><button type="button" onClick={() => setWorkspace(priorityTask ? financeDestinationView(priorityTask.destination) : treasuryWarnings[0] ? financeDestinationView(`finance:${treasuryWarnings[0].destination}`) : "daily-report")}>관련 화면 →</button></div>
            </article>
          </section>

          <section className="content-grid finance-assistant-grid">
            <article className="panel finance-assistant-panel">
              <div className="assistant-heading"><div className="assistant-mark">AI</div><div data-korean-heading><h2>재무 데이터 어시스턴트</h2><span>2024·2025 이카운트 결산자료와 2026 Clobe 스냅샷을 구분해 분석합니다.</span></div></div>
              <div className="assistant-trust-line"><strong className={assistantMeta.evidenceStatus === "VERIFIED" ? "verified" : "review"}>{assistantMeta.evidenceLabel}</strong><span>기준일 {assistantMeta.basisAsOf}</span><em>{assistantMeta.provider === "AI" ? "AI 설명" : "기본 원장 분석"}</em></div>
              <div className={assistantStatus === "error" ? "assistant-answer error" : "assistant-answer"}>{assistantAnswer}</div>
              <div className="assistant-limitations">{assistantMeta.limitations.slice(0, 3).map((item) => <p key={item}><span>i</span>{item}</p>)}</div>
              {assistantActiveEntry && <div className="assistant-decision-bridge"><p><strong>답변을 실행 가능한 안건으로 연결</strong><span>자동 실행하지 않고 경영보고의 검토·승인·후속조치 절차를 거칩니다.</span></p><button type="button" onClick={() => { setAssistantPromotion(assistantActiveEntry); setWorkspace("report"); }}>경영 안건으로 제안 →</button></div>}
              <div className="assistant-suggestions">{["2026년 전기 손익 요약", "마감 원장 변경 여부", "2024년 대비 2025년 변화", "오늘 자금 상태 요약"].map((question) => <button type="button" key={question} onClick={() => void askFinanceAssistant(question)}>{question}</button>)}</div>
              <form className="assistant-form" onSubmit={submitAssistant}><input value={assistantQuestion} onChange={(event) => setAssistantQuestion(event.target.value)} maxLength={300} placeholder="예: 2025년 순이익이 전년보다 감소한 이유는?" aria-label="재무 데이터 질문" /><button type="submit" disabled={assistantStatus === "loading"}>{assistantStatus === "loading" ? "분석 중" : "질문하기"}</button></form>
            </article>

            <article className="panel finance-source-panel">
              <PanelHeader  title="이번 답변의 근거" action={`${assistantMeta.sources.length}개 원천`} />
              <div className="finance-source-list">
                {assistantMeta.sources.map((source) => <button type="button" key={source.id} onClick={() => setWorkspace(source.destination)}>
                  <span className="source-year">{source.id.includes("2024") ? "24" : source.id.includes("2025") ? "25" : source.id.includes("close") ? "마" : "26"}</span>
                  <p><strong>{source.label}</strong><small>{source.period}<br />{source.basis}</small></p>
                  <em className={source.status === "CONFIRMED" ? "status-pass" : "status-watch"}>{source.status === "CONFIRMED" ? "확인" : "검토"}</em>
                </button>)}
              </div>
              <div className="assistant-history-heading"><strong>답변 감사이력</strong><span>수정·삭제 없이 추가 기록</span></div>
              <div className="assistant-history-list">
                {assistantHistoryError && <p className="assistant-history-error">{assistantHistoryError}</p>}
                {!assistantHistoryError && assistantHistory.length === 0 && <p className="assistant-history-empty">저장된 답변이 없습니다.</p>}
                {assistantHistory.slice(0, 6).map((entry) => <button type="button" key={entry.id} onClick={() => restoreFinanceAssistantAnswer(entry)}>
                  <span>{entry.evidenceStatus === "VERIFIED" ? "확" : "검"}</span>
                  <p><strong>{entry.question}</strong><small>{entry.createdByName} · {new Date(entry.createdAt).toLocaleString("ko-KR")}<br />근거 {entry.evidenceHash.slice(0, 10)}…</small></p>
                  <em>{entry.provider === "AI" ? "AI" : "기본"}</em>
                </button>)}
              </div>
            </article>
          </section>
        </>
      )}

      {workspace === "control" && <FinanceOperationsCenter onOpenBudget={() => setWorkspace("budget")} />}

      {workspace === "daily-report" && <DailyTreasuryWorkspace onNavigate={(view) => selectWorkspace(view as FinanceWorkspaceView)} />}

      {workspace === "report" && <ManagementReportWorkspace assistantSource={assistantPromotion} onAssistantSourceConsumed={() => setAssistantPromotion(null)} onOpenAssistantSource={(id) => void openFinanceAssistantSource(id)} onNavigate={(view) => {
        if (!view.startsWith("hr:")) selectWorkspace(view as FinanceWorkspaceView);
      }} />}

      {workspace === "purchasing" && <PurchasingWorkspace />}

      {workspace === "inventory" && <InventoryWorkspace />}

      {workspace === "tax" && <TaxReconciliationWorkspace />}

      {workspace === "fixed-assets" && <FixedAssetsWorkspace />}

      {workspace === "project-costing" && <ProjectCostingWorkspace />}

      {workspace === "expense-control" && <ExpenseControlWorkspace />}

      {workspace === "debt" && <DebtManagementWorkspace onOpenOperations={() => setWorkspace("control")} />}

      {workspace === "reconciliation" && <CashReconciliationWorkspace />}

      {workspace === "reconciliation-board" && <TieOutBoardWorkspace onNavigate={(view) => selectWorkspace(view as FinanceWorkspaceView)} />}

      {workspace === "forecast" && <CashForecastWorkspace />}

      {workspace === "budget" && <BudgetActualWorkspace />}

      {workspace === "close" && <FinanceCloseWorkspace />}

      {workspace === "master" && <FinanceMasterWorkspace />}

      {workspace === "policy" && <FinanceRiskPolicyWorkspace onPolicyChange={setRiskPolicy} />}

      {workspace === "commercial" && (
        <>
          <div className="finance-subpage-heading">
            <div data-korean-heading><h2>매입·매출 분석</h2><span>세금계산서 공급가액 기준으로 수정·취소분을 순액 반영합니다.</span></div>
            <span className="finance-data-badge">Clobe · {financeCurrentData.asOf} 기준</span>
          </div>
          <section className="panel commercial-period-panel">
            <div>
              <span>분석 기간</span>
              <strong>{commercialPeriodValid ? `${commercialStartDate} → ${commercialEndDate}` : "시작일과 종료일을 확인해 주세요."}</strong>
            </div>
            <div className="commercial-date-controls">
              <label>시작일<input type="date" min="2026-01-01" max={financeCurrentData.asOf} value={commercialStartDate} onChange={(event) => setCommercialStartDate(event.target.value)} /></label>
              <label>종료일<input type="date" min="2026-01-01" max={financeCurrentData.asOf} value={commercialEndDate} onChange={(event) => setCommercialEndDate(event.target.value)} /></label>
              <div className="commercial-presets" aria-label="기간 빠른 선택">
                <button type="button" onClick={() => { setCommercialStartDate("2026-01-01"); setCommercialEndDate(financeCurrentData.asOf); }}>올해 누적</button>
                <button type="button" onClick={() => { setCommercialStartDate("2026-08-01"); setCommercialEndDate(financeCurrentData.asOf); }}>이번 달</button>
                <button type="button" onClick={() => { setCommercialStartDate("2026-07-15"); setCommercialEndDate(financeCurrentData.asOf); }}>최근 30일</button>
              </div>
            </div>
          </section>
          <section className="kpi-grid">
            <Metric label="선택기간 매출" value={formatCompactWon(selectedSalesTotal)} delta={`${selectedSalesCount.toLocaleString("ko-KR")}건`} trend="up" hint="공급가액 · 취소분 순액" />
            <Metric label="선택기간 매입" value={formatCompactWon(selectedPurchaseTotal)} delta={`${selectedPurchaseCount.toLocaleString("ko-KR")}건`} trend="down" hint="공급가액 · 취소분 순액" />
            <Metric label="매출 - 매입" value={formatCompactWon(selectedSalesTotal - selectedPurchaseTotal)} delta={selectedSalesTotal >= selectedPurchaseTotal ? "매출 우위" : "매입 우위"} trend={selectedSalesTotal >= selectedPurchaseTotal ? "up" : "down"} hint="재고·비용을 반영한 이익이 아님" />
            <Metric label="조회 거래처" value={`${new Set([...commercialSalesRows.map((row) => row.partner), ...commercialPurchaseRows.map((row) => row.partner)]).size}곳`} delta="검색어 필터 연동" trend="neutral" hint="매출·매입 거래처 합산" />
          </section>
          <section className="content-grid commercial-ranking-grid">
            <article className="panel commercial-ranking-panel">
              <PanelHeader  title="매출 거래처 순위" action={`${commercialSalesRows.length}곳`} />
              <div className="commercial-ranking-list">
                {commercialSalesRows.slice(0, 15).map((row, index) => <div key={row.partner}>
                  <span>{index + 1}</span>
                  <p><strong>{row.partner}</strong><small>{row.count.toLocaleString("ko-KR")}건</small><i><b style={{ width: `${Math.max(3, (row.amount / Math.max(commercialSalesRows[0]?.amount ?? 1, 1)) * 100)}%` }} /></i></p>
                  <em>{formatCompactWon(row.amount)}</em>
                </div>)}
                {commercialSalesRows.length === 0 && <div className="finance-empty">선택한 기간에 매출 자료가 없습니다.</div>}
              </div>
            </article>
            <article className="panel commercial-ranking-panel purchase">
              <PanelHeader  title="매입 거래처 순위" action={`${commercialPurchaseRows.length}곳`} />
              <div className="commercial-ranking-list">
                {commercialPurchaseRows.slice(0, 15).map((row, index) => <div key={row.partner}>
                  <span>{index + 1}</span>
                  <p><strong>{row.partner}</strong><small>{row.count.toLocaleString("ko-KR")}건</small><i><b style={{ width: `${Math.max(3, (row.amount / Math.max(commercialPurchaseRows[0]?.amount ?? 1, 1)) * 100)}%` }} /></i></p>
                  <em>{formatCompactWon(row.amount)}</em>
                </div>)}
                {commercialPurchaseRows.length === 0 && <div className="finance-empty">선택한 기간에 매입 자료가 없습니다.</div>}
              </div>
            </article>
          </section>
          <section className="content-grid commercial-forecast-grid">
            <article className="panel finance-chart-panel">
              <div className="finance-chart-head"><div data-korean-heading><h2>2026년 월간 매출 추이</h2></div><span className="finance-data-badge">8월 13일까지</span></div>
              <div className="finance-chart-summary"><div><strong>{formatCompactWon(currentSalesYtd)}</strong><span>현재까지 누적 매출액</span></div><em className="positive">2025 연간 대비 {((currentSalesYtd / priorYearSales - 1) * 100).toFixed(1)}%</em></div>
              <FinanceBars data={monthlySalesChart} currentLabel="8월" />
              <div className="chart-coverage-note"><span>i</span>8월은 13일까지의 부분 실적이며 공급가액 기준입니다.</div>
            </article>
            <article data-korean-heading className="panel annual-forecast-panel">

              <h2>연말 매출 전망 · 기준</h2>
              <strong>{formatCompactWon(baseSalesForecast.projectedTotal)}</strong>
              <div className="forecast-meter"><i style={{ width: `${Math.min(100, (currentSalesYtd / baseSalesForecast.projectedTotal) * 100)}%` }} /></div>
              <div className="forecast-scenarios">
                {salesForecast.scenarios.map((scenario) => (
                  <div className={scenario.key === "base" ? "base" : ""} key={scenario.key}>
                    <span>{scenario.label}</span><strong>{formatCompactWon(scenario.projectedTotal)}</strong><small>{scenario.basis}</small>
                  </div>
                ))}
              </div>
              <dl><div><dt>누적 실적</dt><dd>{formatCompactWon(currentSalesYtd)}</dd></div><div><dt>경과·잔여일</dt><dd>{salesForecast.elapsedDays}일 · {salesForecast.remainingDays}일</dd></div><div><dt>2025 연간 매출</dt><dd>{formatCompactWon(priorYearSales)}</dd></div></dl>
              <small>{salesForecast.limitations.join(" ")}</small>
            </article>
          </section>
        </>
      )}

      {workspace === "receivables" && <ReceivablesWorkspace />}

      {workspace === "ledger" && <GeneralLedgerWorkspace />}

      {workspace === "statements" && (
        <>
          <div className="finance-subpage-heading"><div data-korean-heading><h2>손익·재무상태</h2><span>결산후 합계잔액시산표 기준입니다.</span></div><div className="segment-control"><button className={statementYear === "2024" ? "active" : ""} onClick={() => setStatementYear("2024")}>2024</button><button className={statementYear === "2025" ? "active" : ""} onClick={() => setStatementYear("2025")}>2025</button></div></div>
          <section className="kpi-grid">
            <Metric label="자산총계" value={formatCompactWon(selectedHistorical.assets)} delta="차대변 균형 확인" trend="neutral" hint={`${statementYear}년 기말`} />
            <Metric label="매출" value={formatCompactWon(selectedHistorical.revenue)} delta={statementYear === "2025" ? "전년 대비 +95.8%" : "상품매출"} trend={statementYear === "2025" ? "up" : "neutral"} hint="회계상 매출" />
            <Metric label="매출총이익" value={formatCompactWon(grossProfit)} delta={`매출총이익률 ${grossMargin.toFixed(1)}%`} trend={grossProfit >= 0 ? "up" : "down"} hint="매출 - 매출원가" />
            <Metric label="당기순이익" value={formatCompactWon(selectedHistorical.netIncome)} delta={statementYear === "2025" ? "전년 대비 -68.2%" : "결산후"} trend={statementYear === "2025" ? "down" : "neutral"} hint="법인세비용 계정 없음 · 세전·세후 여부 미확인" />
          </section>

          {statementYear === "2025" && (
            <section className="panel finance-monthly-panel">
              <PanelHeader  title="2025년 월별 손익·자금 흐름" action="12개월" />
              <div className="finance-wide-table monthly-performance-table">
                <div className="finance-table-row header"><span>월</span><span>매출</span><span>매출원가</span><span>당기순이익</span><span>현금 유입</span><span>현금 유출</span><span>기말 보통예금</span></div>
                {financeHistoricalData.monthly2025.map((row) => <div className="finance-table-row" key={row.month}><strong>{row.month}월</strong><span>{formatCompactWon(row.revenue)}</span><span>{formatCompactWon(row.cogs)}</span><span className={row.netIncome < 0 ? "negative-number" : ""}>{formatCompactWon(row.netIncome)}</span><span>{formatCompactWon(row.cashIn)}</span><span>{formatCompactWon(row.cashOut)}</span><b>{formatCompactWon(row.cashBalance)}</b></div>)}
              </div>
            </section>
          )}

          <section className="panel finance-trial-balance-panel">
            <PanelHeader  title={`${statementYear}년 합계잔액시산표`} action={`${trialBalance.length}개 계정`} />
            <div className="finance-wide-table trial-balance-table">
              <div className="finance-table-row header"><span>계정코드</span><span>계정명</span><span>차변금액</span><span>대변금액</span><span>기말 차변</span><span>기말 대변</span></div>
              {trialBalance.map((row) => <div className="finance-table-row" key={`${row.code}-${row.name}`}><span>{row.code || "-"}</span><strong>{row.name}</strong><span>{formatWon(row.debit)}</span><span>{formatWon(row.credit)}</span><b>{row.endingDebit ? formatWon(row.endingDebit) : "-"}</b><b>{row.endingCredit ? formatWon(row.endingCredit) : "-"}</b></div>)}
              {trialBalance.length === 0 && <div className="finance-empty">검색 조건과 일치하는 계정이 없습니다.</div>}
            </div>
          </section>
        </>
      )}

      {workspace === "liquidity" && (
        <>
          <div className="finance-subpage-heading"><div data-korean-heading><h2>자금·채권채무</h2><span>2025년 자금현황표와 2026년 은행 스냅샷을 함께 봅니다.</span></div><span className="finance-data-badge">2025 결산 · 2026 최신</span></div>
          <section className="kpi-grid">
            <Metric label="2025 기말 보통예금" value={formatCompactWon(financeHistoricalData.years["2025"].cash)} delta="전년 대비 +65.8%" trend="up" hint="자금현황표 일치" />
            <Metric label="2025 외상매출금" value={formatCompactWon(financeHistoricalData.years["2025"].ar)} delta="전년 대비 -22.3%" trend="up" hint="회수대상 잔액" />
            <Metric label="2025 외상매입금" value={formatCompactWon(financeHistoricalData.years["2025"].ap)} delta="전년 대비 +14.8%" trend="down" hint="지급대상 잔액" />
            <Metric label="2026 은행성 자산" value={formatCompactWon(bankAssets)} delta={`대출 대비 ${(liquidityCoverage * 100).toFixed(1)}%`} trend="down" hint={`${Number(financeCurrentData.asOf.slice(5, 7))}월 ${Number(financeCurrentData.asOf.slice(8, 10))}일 Clobe`} />
          </section>
          <section className="content-grid finance-liquidity-grid">
            <article className="panel finance-chart-panel">
              <div className="finance-chart-head"><div data-korean-heading><h2>{liquidityMetric === "cash" ? "보통예금" : liquidityMetric === "ar" ? "외상매출금" : "외상매입금"} 월말 잔액</h2></div><div className="segment-control"><button className={liquidityMetric === "cash" ? "active" : ""} onClick={() => setLiquidityMetric("cash")}>자금</button><button className={liquidityMetric === "ar" ? "active" : ""} onClick={() => setLiquidityMetric("ar")}>채권</button><button className={liquidityMetric === "ap" ? "active" : ""} onClick={() => setLiquidityMetric("ap")}>채무</button></div></div>
              <div className="finance-chart-summary"><div><strong>{formatCompactWon(liquidityChart.at(-1)?.value ?? 0)}</strong><span>2025년 기말 잔액</span></div></div>
              <FinanceBars data={liquidityChart} />
              <div className="chart-coverage-note"><span>i</span>월말 잔액은 계정별원장의 기초잔액과 월별 차대변을 누적해 산출했습니다.</div>
            </article>
            <article className="panel exposure-panel">
              <div className="finance-chart-head"><div data-korean-heading><h2>거래처별 잔액 집중도</h2></div><div className="segment-control"><button className={exposureType === "receivables" ? "active" : ""} onClick={() => setExposureType("receivables")}>받을 돈</button><button className={exposureType === "payables" ? "active" : ""} onClick={() => setExposureType("payables")}>줄 돈</button></div></div>
              <div className="exposure-list">{exposureRows.map((row, index) => <div key={row.name}><span>{index + 1}</span><p><strong>{row.name}</strong><small>기초 {formatCompactWon(row.opening)}</small></p><b>{formatCompactWon(row.ending)}</b></div>)}</div>
            </article>
          </section>
          <section className="panel finance-exception-panel">
            <PanelHeader  title={`${exposureType === "receivables" ? "채권" : "채무"} 음수잔액 확인`} action={`${exposureExceptions.length}건`} />
            <div className="finance-wide-table exception-table">
              <div className="finance-table-row header"><span>거래처</span><span>기초잔액</span><span>증가</span><span>감소</span><span>기말잔액</span><span>조치</span></div>
              {exposureExceptions.map((row) => <div className="finance-table-row" key={row.name}><strong>{row.name}</strong><span>{formatWon(row.opening)}</span><span>{formatWon(row.increase)}</span><span>{formatWon(row.decrease)}</span><b className="negative-number">{formatWon(row.ending)}</b><em>선수·선급/오분류 확인</em></div>)}
            </div>
          </section>
          <section className="content-grid account-risk-grid">
            <article data-korean-heading className={`panel account-risk-hero ${accountRiskLevel === "높음" ? "high" : accountRiskLevel === "주의" ? "watch" : "stable"}`}>

              <div className="account-risk-score"><strong>{accountRiskModel.score}</strong><span>/ 100</span></div>
              <h2>계좌금액 위험도 · {accountRiskLevel}</h2>
              <p>은행성 자산·대출·외화 집중도와 실제 잔액 관측치를 조합한 설명 가능한 운영 신호입니다.</p>
              <div className="risk-factor-list">
                <div><span>대출 대비 은행성 자산</span><b>{accountRiskModel.metrics.debtCoverage === null ? "대출 없음" : `${(accountRiskModel.metrics.debtCoverage * 100).toFixed(1)}%`}</b></div>
                <div><span>외화자산 집중도</span><b>{(accountRiskModel.metrics.fxConcentration * 100).toFixed(1)}%</b></div>
                <div><span>원화 입출금계좌 잔액</span><b>{formatCompactWon(financeCurrentData.accountSummary.checkingBalanceSum)}</b></div>
                <div><span>최근 고점 대비 감소</span><b>{(accountRiskModel.metrics.drawdownFromPeak * 100).toFixed(1)}%</b></div>
              </div>
              <small>{accountRiskModel.policyStatus} · {accountRiskModel.limitations[0]} {accountRiskModel.limitations[1]}</small>
            </article>
            <article className="panel account-risk-detail">
              <PanelHeader  title="위험 신호와 배점" action={`${financeCurrentData.asOf} 기준`} />
              <div className="account-risk-signals">
                {accountRiskModel.drivers.map((driver, index) => (
                  <div className={driver.status} key={driver.key}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <p><strong>{driver.label}<b>+{driver.points}/{driver.maxPoints}</b></strong><small>{driver.evidence}</small><em>{driver.rule}</em></p>
                  </div>
                ))}
              </div>
            </article>
          </section>
          <section className="panel account-register-panel">
            <PanelHeader  title="계좌별 위험 신호" action={`${financeCurrentData.accounts.length}개 계좌`} />
            <div className="account-register-list">
              {financeCurrentData.accounts.map((account) => {
                const isConcentratedFx = account.type === "FX" && account.krwBalance > bankAssets * .5;
                const isLowChecking = account.type === "CHECKING" && account.krwBalance < 100_000;
                const signal = account.type === "LOAN" ? "대출잔액" : isConcentratedFx ? "환율 집중" : isLowChecking ? "잔액 점검" : account.type === "FX" ? "외화계좌" : "정상";
                const signalClass = account.type === "LOAN" || isConcentratedFx ? "high" : isLowChecking ? "watch" : "stable";
                return <div key={account.id}>
                  <span className="account-bank-mark">{accountBankName(account.bankCode).slice(0, 2)}</span>
                  <p><strong>{accountBankName(account.bankCode)} ····{account.last4}</strong><small>{account.name} · {account.currency}</small></p>
                  <b>{account.currency === "USD" ? `$${account.balance.toLocaleString("en-US")}` : formatWon(account.krwBalance)}</b>
                  <em className={signalClass}>{signal}</em>
                </div>;
              })}
            </div>
          </section>
        </>
      )}

      {workspace === "risk-actions" && (
        <FinanceAlertActionCenter onNavigate={(destination) => {
          const next = financeDestinationView(destination);
          setWorkspace(next === "risk-actions" ? "overview" : next);
        }} />
      )}

      {workspace === "quality" && (
        <>
          <div className="finance-subpage-heading"><div data-korean-heading><h2>원장·데이터 점검</h2><span>가져오기 자료의 출처·대사·예외 항목을 한곳에서 확인합니다.</span></div><span className="finance-data-badge warning">확인 필요 2건</span></div>
          <section className="finance-quality-cards">
            <article><span>2024</span><strong>결산 기준선</strong><p>재무상태표와 시산표 자산총계가 일치합니다.</p><em className="status-pass">PASS</em></article>
            <article><span>2025</span><strong>상세 이관</strong><p>원장 28개 구간과 시산표 27개 계정을 대사했습니다.</p><em className="status-pass">PASS</em></article>
            <article><span>2025</span><strong>분개장 품질</strong><p>15,510행 중 중복 후보 32행과 금액 0원 14행이 있습니다.</p><em className="status-watch">REVIEW</em></article>
            <article><span>2026</span><strong>Clobe 최신 자료</strong><p>분개장 차대변 {financeCurrentData.journalSummary.differenceKrw.toLocaleString("ko-KR")}원 차이가 남아 있습니다.</p><em className="status-watch">REVIEW</em></article>
          </section>
          <section className="content-grid finance-quality-grid">
            <article className="panel close-panel finance-check-panel">
              <PanelHeader  title="반영 상태" action="5 / 7 완료" />
              <div className="progress-ring"><span>71<small>%</small></span></div>
              <div className="task-list">{financeChecks.map((task) => <div className="task-row" key={task.label}><span className={task.done ? "check done" : "check"}>{task.done ? "✓" : ""}</span><div><strong>{task.label}</strong><small>{task.owner}</small></div></div>)}</div>
            </article>
            <article className="panel finance-import-panel">
              <PanelHeader  title="원천자료 등록부" action="8개 파일" />
              <div className="source-registry">
                {[
                  ["2024", "재무상태표 · 합계잔액시산표", "결산후"],
                  ["2024", "계정별원장 · 자금현황표", "12/31 기준"],
                  ["2025", "분개장 · 계정별원장", "15,510행"],
                  ["2025", "합계잔액시산표 · 자금현황표", "대사완료"],
                  ["2026", "Clobe MCP", "매일 07:30"],
                ].map(([year, source, scope]) => <div key={`${year}-${source}`}><span>{year}</span><p><strong>{source}</strong><small>{scope}</small></p><em>등록됨</em></div>)}
              </div>
            </article>
          </section>
          <section className="panel account-mapping-panel">
            <PanelHeader  title="이카운트 → 현재 계정명 매핑" action="8개 규칙" />
            <div className="finance-wide-table mapping-table">
              <div className="finance-table-row header"><span>이카운트 계정명</span><span>현재 계정명</span><span>현재 코드</span><span>상태</span></div>
              {[
                ["판매수수료(판)", "판매수수료", "83900"], ["지급수수료(판)", "지급수수료", "83100"], ["운반비(판)", "운반비", "82400"], ["복리후생비(판)", "복리후생비", "81100"],
                ["세금과공과금(판)", "세금과공과금", "81700"], ["광고선전비(판)", "광고선전비", "83300"], ["접대비-카드(판)", "접대비(기업업무추진비)", "81300"], ["지급임차료(판)", "지급임차료", "81900"],
              ].map((row) => <div className="finance-table-row" key={row[0]}><strong>{row[0]}</strong><span>{row[1]}</span><span>{row[2]}</span><em className="status-pass">매핑완료</em></div>)}
            </div>
          </section>
        </>
      )}

        {workspace !== "overview" && <button type="button" className="finance-back-overview" onClick={() => selectWorkspace("overview")}>← 통합 대시보드로 돌아가기</button>}
      </div>
    </div>
  );
}

function SalesDashboard(props: {
  search: string;
  salePrice: number;
  costPrice: number;
  leadType: "outbound" | "inbound" | "ram";
  incentive: { margin: number; rate: number; eligible: boolean; payout: number };
  onSalePrice: (value: number) => void;
  onCostPrice: (value: number) => void;
  onLeadType: (value: "outbound" | "inbound" | "ram") => void;
}) {
  const filteredDeals = deals.filter((deal) => `${deal.company} ${deal.rep}`.toLowerCase().includes(props.search.toLowerCase()));
  return (
    <div className="dashboard-stack">
      <section className="kpi-grid">
        <Metric label="7월 확정 매출" value="₩2.18B" delta="목표 대비 104%" trend="up" hint="계산서 마감" />
        <Metric label="영업 파이프라인" value="₩3.42B" delta="전월 대비 +12%" trend="up" hint="진행 38건" />
        <Metric label="평균 마진율" value="9.8%" delta="기준 +4.8%p" trend="up" hint="인센티브 대상" />
        <Metric label="미수 위험" value="₩186M" delta="연체 3건" trend="down" hint="영업 확인 필요" />
      </section>

      <section className="content-grid sales-top-grid">
        <article className="panel incentive-lab">
          <PanelHeader  title="인센티브 미리 계산" action="규정 보기" />
          <div className="calc-layout">
            <div className="calc-form">
              <label>매출가<input type="number" value={props.salePrice} onChange={(event) => props.onSalePrice(Number(event.target.value))} /></label>
              <label>인정 원가<input type="number" value={props.costPrice} onChange={(event) => props.onCostPrice(Number(event.target.value))} /></label>
              <label>영업 유형<select value={props.leadType} onChange={(event) => props.onLeadType(event.target.value as "outbound" | "inbound" | "ram")}><option value="outbound">아웃바운드 / 직접영업</option><option value="inbound">웹·전화 인바운드</option><option value="ram">단독 RAM 판매</option></select></label>
            </div>
            <div className={props.incentive.eligible ? "calc-result eligible" : "calc-result"}>
              <span>{props.incentive.eligible ? "지급 예상" : "지급 제외"}</span>
              <strong>{formatWon(props.incentive.payout)}</strong>
              <div><small>마진</small><b>{formatWon(props.incentive.margin)}</b></div>
              <div><small>마진율</small><b>{(props.incentive.rate * 100).toFixed(1)}%</b></div>
              <p>마진율 5% 초과분의 5% 지급</p>
            </div>
          </div>
        </article>

        <article className="panel rules-panel">
          <PanelHeader  title="현재 적용 규칙" action="편집" />
          <div className="rule-item"><span>01</span><div><strong>마진율 5% 초과</strong><small>5% 이하는 지급 대상에서 제외</small></div></div>
          <div className="rule-item"><span>02</span><div><strong>인바운드 제외</strong><small>웹·전화 문의 유입 건</small></div></div>
          <div className="rule-item"><span>03</span><div><strong>단독 RAM 제외</strong><small>서버 건은 RAM 원가 분리 조정</small></div></div>
          <div className="rule-item"><span>04</span><div><strong>특별지급 대표 승인</strong><small>악성재고·고난도 영업 건</small></div></div>
        </article>
      </section>

      <section className="panel pipeline-panel">
        <PanelHeader  title="진행 중 영업 건" action="파이프라인 전체" />
        <div className="table-head deal-row"><span>거래처</span><span>담당자</span><span>단계</span><span>예상 매출</span><span>예정일</span><span /></div>
        {filteredDeals.map((deal) => (
          <div className="deal-row" key={deal.company}>
            <strong>{deal.company}</strong><span>{deal.rep}</span><span className={`stage ${deal.health}`}>{deal.stage}</span><b>{deal.amount}</b><span>{deal.due}</span><button aria-label={`${deal.company} 상세`}>→</button>
          </div>
        ))}
      </section>

      <section className="panel incentive-table">
        <PanelHeader  title="7월 영업 인센티브 검토" action="급여로 보내기" />
        <div className="table-head incentive-row"><span>영업 담당</span><span>확정 매출</span><span>마진율</span><span>지급 예정액</span><span>상태</span></div>
        {incentiveRows.map((row) => (
          <div className="incentive-row" key={row.rep}><strong>{row.rep}</strong><span>{row.sales}</span><span>{row.margin}</span><b>{row.incentive}</b><em className={`status ${row.status}`}>{row.status}</em></div>
        ))}
      </section>
    </div>
  );
}

// Kept for reference while historical mockup styles are migrated; the live sales workspace is rendered above.
void SalesDashboard;

function HrDashboard({ search }: { search: string }) {
  const rows = peopleRows.filter((person) => `${person.name} ${person.role}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="dashboard-stack">
      <section className="kpi-grid">
        <Metric label="전체 구성원" value="24명" delta="이번 달 +3" trend="up" hint="온보딩 1명" />
        <Metric label="오늘 출근" value="21명" delta="재택 2 · 휴가 1" trend="neutral" hint="출근율 87.5%" />
        <Metric label="연차 주의" value="3명" delta="마이너스 1명" trend="down" hint="1년 미만 포함" />
        <Metric label="급여 마감" value="D-6" delta="인센티브 검토 중" trend="neutral" hint="9월 5일 지급" />
      </section>

      <section className="content-grid hr-top-grid">
        <article className="panel attendance-panel">
          <PanelHeader  title="오늘의 근무 현황" action="근태 전체" />
          <div className="attendance-visual">
            <div className="donut"><span><b>21</b><small>출근</small></span></div>
            <div className="legend-list"><p><i className="mint" />정상 출근 <b>18</b></p><p><i className="blue" />재택근무 <b>2</b></p><p><i className="amber" />휴가 <b>1</b></p><p><i className="gray" />외근·출장 <b>3</b></p></div>
          </div>
        </article>

        <article className="panel approval-panel">
          <PanelHeader  title="결재 대기" action="모두 보기" />
          <div className="finance-empty">실제 결재 문서는 상단 전자결재 센터에서 권한과 결재선에 따라 표시됩니다.</div>
        </article>

        <article className="panel compliance-panel">
          <PanelHeader  title="인사 일정" action="캘린더" />
          <div className="compliance-item urgent"><span>12</span><div><strong>4대보험 취득 신고</strong><small>신규 입사자 1명</small></div></div>
          <div className="compliance-item"><span>17</span><div><strong>정하늘 입사</strong><small>계정·장비 준비 80%</small></div></div>
          <div className="compliance-item"><span>28</span><div><strong>법정의무교육 마감</strong><small>미수료 4명</small></div></div>
        </article>
      </section>

      <section className="panel people-panel">
        <PanelHeader  title="구성원" action="조직도 보기" />
        <div className="table-head person-row"><span>구성원</span><span>소속·직무</span><span>상태</span><span>입사일</span><span>연차 잔여</span><span /></div>
        {rows.map((person) => (
          <div className="person-row" key={person.name}>
            <span className="person-name"><i>{person.name.slice(-2)}</i><strong>{person.name}</strong></span><span>{person.role}</span><em className={person.flag === "new" ? "status onboarding" : "status active"}>{person.state}</em><span>{person.start}</span><b className={person.flag === "minus" ? "leave-minus" : ""}>{person.leave}</b><button aria-label={`${person.name} 상세`}>→</button>
          </div>
        ))}
      </section>
    </div>
  );
}

function Metric({ label, value, delta, trend, hint }: { label: string; value: string; delta: string; trend: "up" | "down" | "neutral"; hint: string }) {
  return <article className="metric-card"><div><span>{label}</span><small>{hint}</small></div><strong>{value}</strong><p className={trend}>{trend === "up" ? "↗" : trend === "down" ? "↘" : "•"} {delta}</p></article>;
}

function PanelHeader({ title, action }: { title: string; action: string }) {
  return <header className="panel-header"><div data-korean-heading><h2>{title}</h2></div><button>{action} <span>→</span></button></header>;
}
