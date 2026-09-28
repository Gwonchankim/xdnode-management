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
