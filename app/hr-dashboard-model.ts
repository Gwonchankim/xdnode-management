/** HR 통합 대시보드의 계산부. 화면(hr-workspace.tsx 의 Dashboard)은 여기서 만든 모델을 그리기만 한다.
 *  화면 상태를 그대로 받되 필요한 필드만 구조적으로 요구해서, 큰 타입 정의를 끌어오지 않고도 테스트할 수 있다.
 *  날짜는 입사일이 "2026.09.07", 그 밖은 "2026-09-07" 로 저장돼 있어 모두 "-" 로 맞춰 비교한다. */

export type DashboardEmployee = {
  id: string; name: string; department: string; position: string; type: string; joinDate: string; status: string;
  email: string; phone: string; address: string; birth: string;
  history?: { date: string; type: string; detail: string }[];
  retirement?: { date: string; reason?: string; status?: string; requestId?: string };
  firstTermPayPercent?: number; regularContractDate?: string;
  firstTermReview?: { decision?: string } | null;
};
export type DashboardApplicant = {
  id: string; name: string; role: string; stage: string; requisitionId?: string;
  interview?: { date: string; time?: string; type?: string };
  offer?: { status: string; startDate: string; department?: string; proposedTitle?: string; annualSalary?: number; employeeId?: string };
};
export type DashboardOrganization = { id: string; name: string };
export type DashboardRequisition = { id: string; title: string; role: string; organizationId: string; requestedHeadcount: number; status: string };
export type DashboardLifecycleTask = { id: string; employee_id: string; lifecycle_type?: string; task_group?: string; title: string; due_date: string; status: string };
export type DashboardLeaveLedger = { employeeId: string; name: string; department: string; balance: number; promotions: { stage: "FIRST" | "SECOND"; label: string; remaining: number; expiresAt: string; daysLeft: number }[] };
export type DashboardPayrollRun = { period: string; status: string; employee_count?: number; gross_pay?: number; net_pay?: number; approved_by?: string; reviewed_by?: string };

export type DashboardInput = {
  today: string;
  employees: DashboardEmployee[];
  organizations: DashboardOrganization[];
  applicants: DashboardApplicant[];
  requisitions: DashboardRequisition[];
  lifecycleTasks: DashboardLifecycleTask[];
  payrollRuns: DashboardPayrollRun[];
  /** 연차관리 요약(재직자만). 없으면 연차 항목을 대기함에 올리지 않는다. */
  leaveLedgers?: DashboardLeaveLedger[];
  isCurrent: (employee: DashboardEmployee) => boolean;
  isRejectedStage: (stage: string) => boolean;
  /** 채용 깔때기 순서. 화면의 단계 상수를 그대로 넘긴다. */
  funnelStages: string[];
  /** 첫 계약(3개월 기간제) 만료일과 전환 계약 시작일. 계약서 모듈의 계산을 그대로 넘겨 기준을 하나로 둔다. */
  firstTerm: (joinDate: string) => { endDate: string; nextStart: string };
};

export type InboxPriority = "critical" | "warning" | "info";
export type InboxItem = {
  id: string; priority: InboxPriority; kind: string; title: string; detail: string; due: string;
  target: { view: string; employeeId?: string; applicantId?: string; anchor?: string };
};
export type TimelineEvent = {
  id: string; date: string; kind: "면접" | "입사" | "퇴사" | "회신 대기" | "계약 만료"; tone: string; who: string; detail: string;
  target: { view: string; employeeId?: string; applicantId?: string };
};
export type Renewal = { employee: DashboardEmployee; endDate: string; nextStart: string; state: { label: string; tone: "overdue" | "due" | "soon" } };
export type FlowMonth = { month: string; label: string; joins: number; exits: number; headcount: number };

export type DashboardMetric = { key: string; icon: string; tone: string; label: string; value: number; note: string; delta?: string };

export type DashboardModel = ReturnType<typeof buildDashboardModel>;

export const dashDate = (value: string | undefined | null) => (value ?? "").replaceAll(".", "-").slice(0, 10);

export function dayGapFrom(today: string, value: string | undefined | null) {
  const target = dashDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return null;
  return Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export function dDayFrom(today: string, value: string | undefined | null) {
  const gap = dayGapFrom(today, value);
  return gap === null ? "" : gap === 0 ? "오늘" : gap > 0 ? `D-${gap}` : `D+${-gap}`;
}

/** 근속을 사람이 읽는 단위로. 일수만 보여 주면 오래된 직원은 "1,200일"이 된다. */
export function tenureLabel(today: string, joinDate: string) {
  const days = dayGapFrom(today, joinDate);
  if (days === null || days > 0) return "-";
  const elapsed = -days;
  if (elapsed < 31) return `${elapsed}일`;
  const start = new Date(`${dashDate(joinDate)}T00:00:00Z`);
  const end = new Date(`${today}T00:00:00Z`);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  if (months < 12) return `${Math.max(1, months)}개월`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years}년 ${rest}개월` : `${years}년`;
}

export function monthLabel(month: string) {
  return `${Number(month.slice(5, 7))}월`;
}

export function koreanWon(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

/** 재직 여부와 별개로 "언제 나갔는지". 퇴직 요청 날짜가 있으면 그것, 없으면 인사이력의 퇴직 항목이다. */
export function exitDateOf(employee: DashboardEmployee) {
  const status = employee.retirement?.status ?? "";
  if (employee.retirement?.date && (["EFFECTIVE", "COMPLETED"].includes(status) || employee.status.trim() === "퇴직")) return dashDate(employee.retirement.date);
  if (employee.status.trim() !== "퇴직") return "";
  const entry = [...(employee.history ?? [])].reverse().find((item) => item.type.includes("퇴직"));
  return entry ? dashDate(entry.date) : "";
}

export function monthRange(today: string, count: number) {
  const months: string[] = [];
  const base = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  for (let index = count - 1; index >= 0; index -= 1) {
    const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - index, 1));
    months.push(date.toISOString().slice(0, 7));
  }
  return months;
}

function monthEnd(month: string) {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}

const PRIORITY_RANK: Record<InboxPriority, number> = { critical: 0, warning: 1, info: 2 };

export function buildDashboardModel(input: DashboardInput) {
  const { today } = input;
  const dayGap = (value: string | undefined | null) => dayGapFrom(today, value);
  const dDay = (value: string | undefined | null) => dDayFrom(today, value);
  const currentEmployees = input.employees.filter(input.isCurrent);
  const employeeById = new Map(input.employees.map((employee) => [employee.id, employee]));
  // 입사 예정자는 아직 인사기록카드에 없어 사번(예: ys.moon)만 남는다. 오퍼에 적힌 사번으로 지원자 이름을 찾는다.
  const nameOf = (employeeId: string) => employeeById.get(employeeId)?.name
    ?? input.applicants.find((applicant) => applicant.offer?.employeeId === employeeId)?.name ?? employeeId;
  const thisMonth = today.slice(0, 7);

  // ── 예정 사건들 ────────────────────────────────────────────────────────────
  const leavingSoon = input.employees
    .filter((employee) => employee.retirement?.date && dashDate(employee.retirement.date) >= today && employee.status.trim() !== "퇴직")
    .sort((a, b) => dashDate(a.retirement!.date).localeCompare(dashDate(b.retirement!.date)));
  const interviewsSoon = input.applicants
    .filter((applicant) => applicant.interview?.date && dashDate(applicant.interview.date) >= today && !input.isRejectedStage(applicant.stage))
    .sort((a, b) => `${dashDate(a.interview!.date)} ${a.interview!.time || "99:99"}`.localeCompare(`${dashDate(b.interview!.date)} ${b.interview!.time || "99:99"}`));
  const joiningSoon = input.applicants
    .filter((applicant) => applicant.offer?.startDate && dashDate(applicant.offer.startDate) >= today && ["ACCEPTED", "ONBOARDED"].includes(applicant.offer.status))
    .sort((a, b) => dashDate(a.offer!.startDate).localeCompare(dashDate(b.offer!.startDate)));
  const offerPending = input.applicants
    .filter((applicant) => applicant.offer?.startDate && dashDate(applicant.offer.startDate) >= today && applicant.offer.status === "APPROVED")
    .sort((a, b) => dashDate(a.offer!.startDate).localeCompare(dashDate(b.offer!.startDate)));

  // ── 첫 계약(3개월 수습) 만료 → 정규직 전환 ──────────────────────────────────
  // 모든 입사자가 3개월 첫 계약을 거치므로 ERP 로 입사 처리한 사람만이 아니라 재직자 전원이 대상이다.
  // 전환 기록(정규직 계약일)이 없는 사람 가운데 만료 30일 전부터 만료 60일 뒤까지를 표에 올리고, 그보다 오래된
  // 사람은 기록 누락으로 따로 센다 — 이미 정규직인 옛 재직자가 표를 채우면 정작 봐야 할 사람이 묻힌다.
  const RENEWAL_GRACE_DAYS = 60;
  const renewalState = (endDate: string): Renewal["state"] => {
    const gap = dayGap(endDate) ?? 0;
    return gap < 0 ? { label: "만료 경과 · 미처리", tone: "overdue" } : gap <= 7 ? { label: "통지 기한 (7일 이내)", tone: "due" } : { label: "평가·통지 준비", tone: "soon" };
  };
  const renewalCandidates = currentEmployees
    .filter((employee) => !employee.regularContractDate && employee.firstTermReview?.decision !== "END" && dayGap(employee.joinDate) !== null)
    .map((employee) => ({ employee, ...input.firstTerm(dashDate(employee.joinDate)) }))
    .filter((item) => item.endDate);
  const renewals: Renewal[] = renewalCandidates
    .filter((item) => { const gap = dayGap(item.endDate) ?? 99; return gap <= 30 && gap >= -RENEWAL_GRACE_DAYS; })
    .sort((a, b) => a.endDate.localeCompare(b.endDate))
    .map((item) => ({ ...item, state: renewalState(item.endDate) }));
  const missingRegularRecords = renewalCandidates
    .filter((item) => (dayGap(item.endDate) ?? 99) < -RENEWAL_GRACE_DAYS)
    .sort((a, b) => dashDate(b.employee.joinDate).localeCompare(dashDate(a.employee.joinDate)))
    .map((item) => ({ employee: item.employee, endDate: item.endDate }));

  // ── 처리 대기함 ──────────────────────────────────────────────────────────────
  const inbox: InboxItem[] = [];
  for (const renewal of renewals) {
    inbox.push({
      id: `renewal:${renewal.employee.id}`, kind: "정규직 전환",
      priority: renewal.state.tone === "overdue" ? "critical" : renewal.state.tone === "due" ? "warning" : "info",
      title: `${renewal.employee.name}님 첫 계약 만료 ${dDay(renewal.endDate)}`,
      detail: `${renewal.employee.department} · 만료 ${renewal.endDate} · ${renewal.state.label}`,
      due: renewal.endDate, target: { view: "dashboard", anchor: "renewal" },
    });
  }
  // 입사 절차 과제 — 사람별로 묶어 미완료 건수와 가장 이른 마감을 본다. 퇴직 절차는 일반 체크리스트라 대시보드에 올리지 않는다.
  const openTasks = input.lifecycleTasks.filter((task) => task.status === "OPEN" && (task.lifecycle_type ?? "ONBOARDING") !== "RETIREMENT");
  const tasksByEmployee = new Map<string, DashboardLifecycleTask[]>();
  for (const task of openTasks) tasksByEmployee.set(task.employee_id, [...(tasksByEmployee.get(task.employee_id) ?? []), task]);
  for (const [employeeId, tasks] of tasksByEmployee) {
    const type = tasks[0].lifecycle_type ?? "ONBOARDING";
    const earliest = [...tasks].map((task) => dashDate(task.due_date)).filter(Boolean).sort()[0] ?? "";
    const gap = earliest ? dayGap(earliest) : null;
    const name = nameOf(employeeId);
    inbox.push({
      id: `tasks:${type}:${employeeId}`, kind: type === "RETIREMENT" ? "퇴직 절차" : "입사 절차",
      priority: gap !== null && gap < 0 ? "critical" : gap !== null && gap <= 7 ? "warning" : "info",
      title: `${name}님 ${type === "RETIREMENT" ? "퇴직" : "입사"} 절차 미완료 ${tasks.length}건`,
      detail: earliest ? `마감 ${earliest} (${dDay(earliest)}) · ${tasks.slice(0, 2).map((task) => task.title).join(", ")}${tasks.length > 2 ? " 외" : ""}` : tasks.slice(0, 3).map((task) => task.title).join(", "),
      due: earliest || "9999-12-31", target: { view: "onboarding", employeeId },
    });
  }
  for (const applicant of offerPending) {
    const gap = dayGap(applicant.offer!.startDate) ?? 99;
    inbox.push({
      id: `offer:${applicant.id}`, kind: "오퍼 회신 대기", priority: gap <= 14 ? "warning" : "info",
      title: `${applicant.name}님 처우 제안 회신 대기`,
      detail: `입사 예정 ${dashDate(applicant.offer!.startDate)} (${dDay(applicant.offer!.startDate)}) · ${applicant.offer!.department || "소속 미정"} · ${applicant.offer!.proposedTitle || applicant.role}`,
      due: dashDate(applicant.offer!.startDate), target: { view: "recruitment", applicantId: applicant.id },
    });
  }
  // 급여 — 지난달까지의 급여월이 아직 초안이면 승인·마감이 밀린 것이다.
  const payrollRuns = [...input.payrollRuns].sort((a, b) => b.period.localeCompare(a.period));
  const stalePayroll = payrollRuns.filter((run) => run.period < thisMonth && ["DRAFT", "REVIEW"].includes(run.status));
  for (const run of stalePayroll.slice(0, 3)) {
    inbox.push({
      id: `payroll:${run.period}`, kind: "급여 마감", priority: "warning",
      title: `${run.period} 급여 ${run.status === "REVIEW" ? "승인" : "검토·승인"} 대기`,
      detail: `대상 ${run.employee_count ?? 0}명 · 실지급 ${koreanWon(run.net_pay ?? 0)} · 상태 ${run.status}`,
      due: monthEnd(run.period), target: { view: "payroll" },
    });
  }
  const incompleteProfiles = currentEmployees.filter((employee) => [employee.email, employee.phone, employee.birth, employee.address].some((value) => !value || value === "미입력"));
  for (const employee of incompleteProfiles) {
    const missing = [["이메일", employee.email], ["연락처", employee.phone], ["생년월일", employee.birth], ["주소", employee.address]]
      .filter(([, value]) => !value || value === "미입력").map(([label]) => label);
    inbox.push({
      id: `profile:${employee.id}`, kind: "인사정보 미입력", priority: "info",
      title: `${employee.name}님 인사정보 확인`, detail: `${employee.department} · ${missing.join("·")} 미입력`,
      due: "9999-12-31", target: { view: "employees", employeeId: employee.id },
    });
  }
  for (const applicant of interviewsSoon.filter((item) => dashDate(item.interview!.date) === today)) {
    inbox.push({
      id: `interview:${applicant.id}`, kind: "오늘 면접", priority: "info",
      title: `${applicant.name}님 면접 ${applicant.interview!.time || "시간 미정"}`, detail: `${applicant.role} · ${applicant.interview!.type || "유형 미정"}`,
      due: today, target: { view: "recruitment", applicantId: applicant.id },
    });
  }
  // 연차 — 2차 촉진(소멸 2개월 전)과 초과 사용은 주의, 1차 촉진은 참고. 목록은 재직자만 온다.
  for (const ledger of input.leaveLedgers ?? []) {
    for (const notice of ledger.promotions) {
      inbox.push({
        id: `leave-promotion:${ledger.employeeId}:${notice.expiresAt}`, kind: notice.stage === "SECOND" ? "연차 촉진 2차" : "연차 촉진 1차", priority: notice.stage === "SECOND" ? "warning" : "info",
        title: `${ledger.name}님 ${notice.label} 잔여 ${notice.remaining}일 소멸 D-${notice.daysLeft}`,
        detail: `${ledger.department} · 소멸일 ${notice.expiresAt} · ${notice.stage === "SECOND" ? "회사 지정 사용일 통보" : "사용 시기 지정 요청"} 안내문 발송`,
        due: notice.expiresAt, target: { view: "leave" },
      });
    }
    if (ledger.balance < 0) {
      inbox.push({
        id: `leave-overdraft:${ledger.employeeId}`, kind: "연차 초과 사용", priority: "warning",
        title: `${ledger.name}님 연차 ${-ledger.balance}일 초과 사용`, detail: `${ledger.department} · 다음 발생분에서 차감되거나 무급 처리 필요`,
        due: today, target: { view: "leave" },
      });
    }
  }
  inbox.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.due.localeCompare(b.due) || a.title.localeCompare(b.title));

  // ── 통합 타임라인 ──────────────────────────────────────────────────────────
  const timeline: TimelineEvent[] = [
    ...interviewsSoon.map((applicant): TimelineEvent => ({
      id: `interview:${applicant.id}`, date: dashDate(applicant.interview!.date), kind: "면접", tone: "interview", who: applicant.name,
      detail: `${applicant.role} · ${applicant.interview!.time || "시간 미정"} · ${applicant.interview!.type || "유형 미정"}`,
      target: { view: "recruitment", applicantId: applicant.id },
    })),
    ...joiningSoon.map((applicant): TimelineEvent => ({
      id: `join:${applicant.id}`, date: dashDate(applicant.offer!.startDate), kind: "입사", tone: "join", who: applicant.name,
      detail: `${applicant.offer!.department || "소속 미정"} · ${applicant.offer!.proposedTitle || applicant.role}`,
      target: { view: "onboarding" },
    })),
    ...offerPending.map((applicant): TimelineEvent => ({
      id: `offer:${applicant.id}`, date: dashDate(applicant.offer!.startDate), kind: "회신 대기", tone: "offer", who: applicant.name,
      detail: `${applicant.offer!.department || "소속 미정"} · ${applicant.offer!.proposedTitle || applicant.role} · 연봉 ${koreanWon(applicant.offer!.annualSalary ?? 0)}`,
      target: { view: "recruitment", applicantId: applicant.id },
    })),
    ...leavingSoon.map((employee): TimelineEvent => ({
      id: `leave:${employee.id}`, date: dashDate(employee.retirement!.date), kind: "퇴사", tone: "leave", who: employee.name,
      detail: `${employee.department} · ${employee.position} · ${employee.retirement!.reason || "사유 미입력"}`,
      target: { view: "employees", employeeId: employee.id },
    })),
    ...renewals.map((renewal): TimelineEvent => ({
      id: `renewal:${renewal.employee.id}`, date: renewal.endDate, kind: "계약 만료", tone: "renewal", who: renewal.employee.name,
      detail: `${renewal.employee.department} · 첫 계약 만료 · ${renewal.state.label}`,
      target: { view: "dashboard" },
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.who.localeCompare(b.who));

  // ── 채용 파이프라인 ──────────────────────────────────────────────────────────
  const funnel = input.funnelStages.map((stage) => ({ stage, count: input.applicants.filter((applicant) => applicant.stage === stage).length }));
  const organizationName = new Map(input.organizations.map((organization) => [organization.id, organization.name]));
  const requisitions = input.requisitions
    .filter((requisition) => ["OPEN", "APPROVED", "FILLED", "IN_PROGRESS"].includes(requisition.status))
    .map((requisition) => {
      const linked = input.applicants.filter((applicant) => applicant.requisitionId === requisition.id);
      const filled = linked.filter((applicant) => applicant.offer && ["ACCEPTED", "ONBOARDED"].includes(applicant.offer.status)).length;
      const active = linked.filter((applicant) => !input.isRejectedStage(applicant.stage) && !(applicant.offer && ["ACCEPTED", "ONBOARDED", "DECLINED"].includes(applicant.offer.status))).length;
      return { id: requisition.id, title: requisition.title, role: requisition.role, organization: organizationName.get(requisition.organizationId) ?? requisition.organizationId,
        requested: requisition.requestedHeadcount, filled, active, status: requisition.status };
    })
    .sort((a, b) => (a.status === "FILLED" ? 1 : 0) - (b.status === "FILLED" ? 1 : 0) || b.requested - a.requested);

  // ── 인원 구성 ────────────────────────────────────────────────────────────────
  const headcount = input.organizations.map((organization) => {
    const members = currentEmployees.filter((employee) => employee.department === organization.name);
    return { organization: organization.name, count: members.length, leaving: members.filter((employee) => leavingSoon.includes(employee)).length };
  }).sort((a, b) => b.count - a.count || a.organization.localeCompare(b.organization));
  const unassigned = currentEmployees.filter((employee) => !input.organizations.some((organization) => organization.name === employee.department)).length;
  const employmentTypes = Object.entries(currentEmployees.reduce<Record<string, number>>((counts, employee) => ({ ...counts, [employee.type || "미지정"]: (counts[employee.type || "미지정"] ?? 0) + 1 }), {}))
    .map(([type, count]) => ({ type, count, share: currentEmployees.length ? count / currentEmployees.length : 0 }))
    .sort((a, b) => b.count - a.count);

  // ── 12개월 입·퇴사 흐름 ─────────────────────────────────────────────────────
  const exits = input.employees.map((employee) => ({ employee, exitDate: exitDateOf(employee) }));
  const flow: FlowMonth[] = monthRange(today, 12).map((month) => {
    const end = monthEnd(month);
    const joins = input.employees.filter((employee) => dashDate(employee.joinDate).slice(0, 7) === month).length;
    const exited = exits.filter((item) => item.exitDate.slice(0, 7) === month).length;
    const headcountAtEnd = exits.filter(({ employee, exitDate }) => {
      const joined = dashDate(employee.joinDate);
      return joined && joined <= end && (!exitDate || exitDate > end);
    }).length;
    return { month, label: monthLabel(month), joins, exits: exited, headcount: headcountAtEnd };
  });
  const hiresThisMonth = flow[flow.length - 1]?.joins ?? 0;
  const exitsThisMonth = flow[flow.length - 1]?.exits ?? 0;
  const previousHeadcount = flow[flow.length - 2]?.headcount ?? null;

  // ── 급여 상태 ────────────────────────────────────────────────────────────────
  const latestPayroll = payrollRuns[0] ?? null;
  const payroll = {
    latest: latestPayroll,
    currentMonthPrepared: payrollRuns.some((run) => run.period === thisMonth),
    staleCount: stalePayroll.length,
    steps: ["DRAFT", "REVIEW", "APPROVED", "LOCKED"] as const,
  };

  const recentHires = [...currentEmployees]
    .filter((employee) => dashDate(employee.joinDate) && dashDate(employee.joinDate) <= today)
    .sort((a, b) => dashDate(b.joinDate).localeCompare(dashDate(a.joinDate)))
    .slice(0, 5)
    .map((employee) => ({ employee, tenure: tenureLabel(today, employee.joinDate) }));

  const employeeCount = currentEmployees.length;
  const metrics: DashboardMetric[] = [
    { key: "employees", icon: "인", tone: "navy", label: "재직자", value: employeeCount,
      delta: previousHeadcount === null ? undefined : `${employeeCount - previousHeadcount >= 0 ? "+" : ""}${employeeCount - previousHeadcount} 전월 대비`,
      note: `이번 달 입사 ${hiresThisMonth}명 · 퇴사 ${exitsThisMonth}명${incompleteProfiles.length ? ` · 정보 확인 필요 ${incompleteProfiles.length}명` : ""}` },
    { key: "employees", icon: "퇴", tone: "red", label: "퇴사 예정", value: leavingSoon.length,
      note: leavingSoon.length ? `가장 이른 마지막 근무일 ${dashDate(leavingSoon[0].retirement!.date)} (${dDay(leavingSoon[0].retirement!.date)})` : "예정된 퇴사가 없습니다" },
    { key: "recruitment", icon: "면", tone: "blue", label: "면접 예정", value: interviewsSoon.length,
      note: interviewsSoon.length ? `다음 면접 ${dashDate(interviewsSoon[0].interview!.date)} ${interviewsSoon[0].interview!.time || ""} (${dDay(interviewsSoon[0].interview!.date)})` : "잡힌 면접이 없습니다" },
    { key: "onboarding", icon: "입", tone: "green", label: "입사 예정", value: joiningSoon.length,
      note: joiningSoon.length
        ? `가장 이른 입사일 ${dashDate(joiningSoon[0].offer!.startDate)} (${dDay(joiningSoon[0].offer!.startDate)})${offerPending.length ? ` · 오퍼 회신 대기 ${offerPending.length}명` : ""}`
        : offerPending.length ? `확정 대기 · 오퍼 회신 대기 ${offerPending.length}명` : "예정된 입사가 없습니다" },
    { key: "renewal", icon: "전", tone: "purple", label: "정규직 전환 예정", value: renewals.length,
      note: renewals.length ? `가장 이른 만료일 ${renewals[0].endDate} (${dDay(renewals[0].endDate)}) · ${renewals[0].state.label}` : "30일 안에 만료되는 첫 계약이 없습니다" },
  ];

  // R3(D12): 권한이 탭 단위라 '채용담당자 전용' 계정이 없다. 모두 처리 대기함부터 본다.
  const sectionOrder = ["inbox", "renewal", "timeline", "pipeline", "people", "payroll"];

  return {
    today, employeeCount, metrics, inbox, timeline, renewals, missingRegularRecords, funnel, requisitions, headcount, unassigned, employmentTypes, flow, payroll,
    recentHires, incompleteProfiles, leavingSoon, interviewsSoon, joiningSoon, offerPending, sectionOrder, dayGap, dDay,
  };
}
