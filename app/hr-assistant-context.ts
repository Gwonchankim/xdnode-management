export type HrAssistantTopic = "people" | "leave" | "recruitment" | "payroll";

export const hrAssistantTopics: Record<HrAssistantTopic, { label: string; questions: string[] }> = {
  payroll: { label: "급여 증빙", questions: ["첨부한 원천징수영수증의 퇴직금 금액만 선택한 월의 임금계산에 반영할 변경안을 만들어줘.", "퇴직 예정자의 급여 기준과 정산 시 확인할 항목을 정리해줘."] },
  people: { label: "인사·조직", questions: ["현재 재직 인원과 조직별 인원 현황을 정리해줘.", "다가오는 입사·퇴사 일정과 준비할 업무를 확인해줘.", "인사기록에서 누락되었거나 확인이 필요한 항목을 알려줘."] },
  leave: { label: "연차·휴가", questions: ["직원별 연차 잔여 현황과 초과 사용자를 정리해줘.", "소멸이 가까운 연차와 사용 촉진 안내 대상을 확인해줘.", "팀별 연차 발생·사용·소멸·잔여 현황을 비교해줘."] },
  recruitment: { label: "채용·면접", questions: ["면접 예정자를 확인해줘.", "첨부한 이력서와 지원 포지션을 바탕으로 맞춤 면접 질문 리스트를 만들어줘.", "첨부한 이력서를 분석해 지원자 등록 변경안을 만들어줘.", "면접 결과를 탈락으로 기록할 변경안을 만들어줘.", "면접 합격자의 처우 오퍼 변경안을 만들어줘."] },
};

export type AssistantExchange = { question: string; answer: string; includedServerData: boolean };

// No previous ERP-derived answer is sent after the user switches data access off.
export function recentAssistantConversation(history: AssistantExchange[], includeServerData: boolean) {
  return history.filter((entry) => includeServerData || !entry.includedServerData).slice(-4)
    .map(({ question, answer }) => ({ question: question.slice(0, 2000), answer: answer.slice(0, 4000) }));
}

type LeaveSummary = {
  employeeId: string; name: string; department: string; status: string;
  granted: number; used: number; expired: number; balance: number; overdraft: number;
  promotions?: Array<{ label: string; remaining: number; expiresAt: string; daysLeft: number; stage: string }>;
};

type OperationsRow = Record<string, unknown>;
const OPERATIONS_ROW_LIMIT = 200;
const RECENT_LEAVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const rowsOf = (value: unknown): OperationsRow[] => Array.isArray(value) ? value.filter((row): row is OperationsRow => Boolean(row) && typeof row === "object") : [];
const pick = (row: OperationsRow, keys: string[]) => Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));

// /api/hr/operations 응답을 어시스턴트 맥락 크기로 줄인다. 원본을 그대로 보내면 가져온 연차 사용 기록(수백 건)만으로
// 브리지 한도(192KB)를 넘어 모든 HR 질문이 "첨부한 자료가 너무 큽니다"로 실패했다.
// 휴가 신청: 연차 잔여는 compactLeaveContext 가 따로 보낸다. 여기서는 최근 30일 이후 일정과 결정 대기 건만, 사유·출처 없이 보낸다.
// 입·퇴사 체크리스트: 끝나지 않은 항목만 보내고 완료 건은 개수만 남긴다.
export function compactOperationsContext(payload: Record<string, unknown>, today: string) {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - RECENT_LEAVE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const leaves = rowsOf(payload.leaveRequests);
  const relevantLeaves = leaves.filter((row) => row.status !== "APPROVED" || String(row.end_date ?? row.start_date ?? "") >= since)
    .sort((a, b) => String(a.start_date ?? "").localeCompare(String(b.start_date ?? "")));
  const tasks = rowsOf(payload.lifecycleTasks);
  const openTasks = tasks.filter((row) => row.status !== "DONE");
  const rest = Object.entries(payload).filter(([key]) => key !== "leaveRequests" && key !== "lifecycleTasks");
  const bounded = Object.fromEntries(rest.map(([key, value]) => [key, Array.isArray(value) ? value.slice(0, OPERATIONS_ROW_LIMIT) : value]));
  return {
    ...bounded,
    leaveRequests: {
      scope: `최근 ${RECENT_LEAVE_DAYS}일(${since}) 이후 일정과 결정 대기 건. 그 이전 사용 기록과 사유는 포함하지 않음(잔여는 leave 참고).`,
      totalCount: leaves.length, includedCount: Math.min(relevantLeaves.length, OPERATIONS_ROW_LIMIT),
      items: relevantLeaves.slice(0, OPERATIONS_ROW_LIMIT).map((row) => pick(row, ["employee_id", "leave_type", "start_date", "end_date", "units", "status", "deducts"])),
    },
    lifecycleTasks: {
      scope: "끝나지 않은 입·퇴사 체크리스트 항목",
      totalCount: tasks.length, doneCount: tasks.length - openTasks.length,
      items: openTasks.slice(0, OPERATIONS_ROW_LIMIT).map((row) => pick(row, ["employee_id", "lifecycle_type", "task_group", "title", "owner_employee_id", "due_date", "status"])),
    },
  };
}

export function compactLeaveContext(payload: { today?: string; ledgers?: LeaveSummary[] }) {
  const rows = Array.isArray(payload.ledgers) ? payload.ledgers : [];
  return {
    source: "연차관리 원장 요약", asOf: payload.today ?? "", employeeCount: rows.length, truncated: rows.length > 200,
    detailScope: "발생·사용·소멸·잔여 및 촉진 안내 요약. 개별 사용 날짜와 사유는 포함하지 않음.",
    employees: rows.slice(0, 200).map((row) => ({
      employeeId: row.employeeId, name: row.name, department: row.department, status: row.status,
      granted: row.granted, used: row.used, expired: row.expired, balance: row.balance, overdraft: row.overdraft,
      promotions: (row.promotions ?? []).map(({ label, remaining, expiresAt, daysLeft, stage }) => ({ label, remaining, expiresAt, daysLeft, stage })),
    })),
  };
}
