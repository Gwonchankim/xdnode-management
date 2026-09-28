export type RecruitmentInterview = {
  date: string; time: string; type: string; interviewers: string; location: string; note: string; questions: string;
};

export const emptyRecruitmentInterview: RecruitmentInterview = {
  date: "", time: "", type: "1차 대면", interviewers: "", location: "", note: "", questions: "",
};

export const recruitmentHelperRequest = "입력한 이력서를 분석하여 지원자 등록 변경안 1개와 지원 포지션에 맞춘 면접 질문을 함께 만들어줘. 이름·연락처·경력·직무 관련 강점과 확인할 사항을 정리하고, 제공하지 않은 정보는 추정하지 마. 면접 일정은 사용자가 입력한 값만 사용해줘.";

export function validateRecruitmentInterview(value: unknown, requireQuestions = false): RecruitmentInterview {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result = Object.fromEntries(Object.entries(emptyRecruitmentInterview).map(([key, fallback]) => [key, typeof input[key] === "string" ? input[key].trim() : fallback])) as RecruitmentInterview;
  if (Boolean(result.date) !== Boolean(result.time)) throw new Error("면접일과 시작 시간을 함께 입력해 주세요. 일정이 미정이면 둘 다 비워 두세요.");
  if (result.date && (!/^\d{4}-\d{2}-\d{2}$/.test(result.date) || !Number.isFinite(Date.parse(result.date)) || new Date(result.date).toISOString().slice(0, 10) !== result.date)) throw new Error("올바른 면접일을 입력해 주세요.");
  if (result.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(result.time)) throw new Error("올바른 면접 시작 시간을 입력해 주세요.");
  if (requireQuestions && !result.questions) throw new Error("면접 질문지가 비어 있습니다. 질문을 생성하거나 입력해 주세요.");
  if (result.questions.length > 20000) throw new Error("면접 질문지는 20,000자 이내로 입력해 주세요.");
  return result;
}

export function formatRecruitmentQuestions(items: Array<{ category: string; question: string; checkpoint: string }>) {
  const labels: Record<string, string> = { RESUME_CHECK: "이력서 근거 확인", ROLE_SKILL: "지원 직무 역량", COUNTER_ROLE_SKILL: "역제안 직무 역량", COUNTER_FIT: "역제안 타당성", BUSINESS_SCENARIO: "XD NODE 사업 시나리오", COLLABORATION: "협업·문제해결" };
  return items.filter(item => item && typeof item.question === "string" && item.question.trim()).map((item, index) => `${index + 1}. [${labels[item.category] ?? "직무 확인"}] ${item.question.trim()}${item.checkpoint ? `\n   확인 포인트: ${item.checkpoint}` : ""}`).join("\n\n");
}
