// 퇴직금·연차수당 산정. 순수 계산만 담당하고 DB나 화면은 건드리지 않는다 —
// app/api/hr/operations/route.ts 가 퇴직 정산에서 호출하고, 같은 함수를 테스트가 직접 검증한다.
//
// 근로자퇴직급여보장법 기준:
//   퇴직금 = 1일 평균임금 × 30 × (계속근로일수 / 365)
//   1일 평균임금 = 퇴직 직전 3개월 임금총액 / 그 기간의 총일수
//   1일 평균임금이 1일 통상임금보다 적으면 통상임금을 쓴다 (법정 최저 보장)
//   계속근로기간 1년 미만이면 지급 의무가 없다
//
// 이 함수의 결과는 확정 지급액이 아니라 "추정액"이다. 법정 산식과 다음 세 가지가 어긋나 있고,
// 셋 다 이 앱에 자료가 없어서 지금은 좁힐 수 없다. 결과를 급여·임금안에 자동 반영하지 말 것.
//   1) 산정 기간: 법은 퇴직 사유 발생일 이전 3개월을 보지만, 여기서는 급여 자료가 월 단위라
//      직전 3개 급여월로 근사한다. 9/15 퇴사라면 법정 구간은 6/15~9/14 이다.
//   2) 제외기간: 근로기준법 시행령 제2조는 수습·사용자 귀책 휴업·출산전후휴가·육아휴직·업무상
//      요양·쟁의행위·병역 기간과 그 임금을 분자·분모에서 모두 뺀다. hr_leave_requests 의 종류가
//      ANNUAL/HALF_AM/HALF_PM/SICK/FAMILY/OTHER 뿐이라 이 기간들을 식별할 수 없다.
//   3) 임금총액 범위: 상여금과 연차수당은 연간액의 3/12만 산입해야 하는데, gross_pay 는 그 달에
//      실제 지급된 금액이라 지급 시점에 따라 평균임금이 출렁인다.

export type SeveranceWage = { yearMonth: string; grossPay: number };

export type SeveranceInput = {
  joinDate: string;        // YYYY-MM-DD
  retirementDate: string;  // YYYY-MM-DD (마지막 근무일)
  recentWages: SeveranceWage[];
  monthlyOrdinaryWage: number; // 월 통상임금 (연봉/12 등 고정 지급분)
  /** 급여가 아직 확정되지 않은 급여월 키. 인센티브가 안 정해진 달이 여기 들어온다. */
  unconfirmedMonths?: string[];
};

export type SeveranceResult = {
  eligible: boolean;
  reason: string;
  tenureDays: number;
  averageWageTotal: number;
  averageWageDays: number;
  averageDailyWage: number;
  ordinaryDailyWage: number;
  appliedDailyWage: number;
  basis: "AVERAGE" | "ORDINARY" | "NONE";
  months: string[];
  severance: number;
  /** 평균임금만으로 계산한 값. 통상임금 쪽과 나란히 보여 어느 쪽이 적용됐는지 드러내려고 함께 돌려준다. */
  averageSeverance: number;
  /** 통상임금(법정 하한)만으로 계산한 값. */
  ordinarySeverance: number;
  workingTimeRule: WorkingTimeRule;
  /** 이 추정치가 법정 산식과 어긋나는 지점. 화면이 그대로 사람에게 보여 준다. */
  limitations: string[];
  /** 산정에 쓴 급여월 중 아직 확정되지 않은 달. 비어 있지 않으면 금액이 바뀔 수 있다. */
  provisionalMonths: string[];
};

const DAY = 86_400_000;

// 저장된 날짜의 구분자가 한 가지가 아니다. hr_retirement_requests.retirement_date 는 "2026-08-13",
// hr_employee_records.join_date 는 "2024.11.14" 처럼 점을 쓴다. 앱의 다른 곳도 읽는 쪽에서 맞춰준다
// (app/api/compensation/route.ts 의 replaceAll(".", "-")). 여기서도 양쪽을 모두 받는다.
export const normalizeDate = (value: string) => (value ?? "").trim().replaceAll(".", "-").replaceAll("/", "-");

const parseDate = (value: string) => {
  const normalized = normalizeDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const date = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const daysInYearMonth = (yearMonth: string) => {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth ?? "");
  if (!match) return 0;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
};

// 1일 통상임금 = (월 통상임금 ÷ 1개월 통상임금 산정 기준시간) × 1일 소정근로시간.
// 주 40시간·주휴 8시간이면 (40 + 8) × 365 ÷ 7 ÷ 12 ≒ 209시간이 표준이고 1일은 8시간이다.
// 월급을 일할계산할 때 쓰는 `× 12 ÷ 365`(compensation-calculation.ts)와는 다른 값이 나온다.
// 그쪽은 "한 달치 급여를 며칠로 쪼개나"이고, 이쪽은 "시급 기준 하루 몫이 얼마인가"라서 목적이 다르다.
export const MONTHLY_ORDINARY_HOURS = 209;
export const DAILY_WORK_HOURS = 8;

export const ordinaryDailyWageOf = (
  monthlyOrdinaryWage: number,
  monthlyHours: number = MONTHLY_ORDINARY_HOURS,
  dailyHours: number = DAILY_WORK_HOURS,
) => monthlyOrdinaryWage > 0 && monthlyHours > 0 ? (monthlyOrdinaryWage / monthlyHours) * dailyHours : 0;

export type WorkingTimeRule = {
  effectiveFrom: string; // YYYY-MM-DD, 이 날짜부터 적용
  monthlyHours: number;  // 월 통상임금 산정 기준시간
  dailyHours: number;    // 1일 소정근로시간
  label: string;
};

/**
 * 회사 소정근로시간 규정 이력. 통상임금은 규정이 바뀌면 같이 바뀌므로, 퇴사·정산 시점에 맞는
 * 규정을 골라 써야 한다. 새 규정이 생기면 여기에 한 줄 추가하고 effectiveFrom 만 채우면 된다.
 *
 * 주 35시간제(2026-08-01 시행): 월~목 09:00-17:30 휴게 1.5h, 금 09:00-17:00 휴게 1h → 매일 7시간.
 * 월 기준시간 = (주 소정 35h + 주휴 7h) × 365 ÷ 7 ÷ 12 = 182.5. 올림하지 않은 값을 그대로 쓴다.
 * 근로시간만 줄고 월 급여는 그대로라, 시급은 오르지만 1일 통상임금은 거의 변하지 않는다.
 */
export const WORKING_TIME_RULES: WorkingTimeRule[] = [
  { effectiveFrom: "0000-01-01", monthlyHours: 209, dailyHours: 8, label: "주 40시간" },
  { effectiveFrom: "2026-08-01", monthlyHours: 182.5, dailyHours: 7, label: "주 35시간" },
];

/** 주어진 날짜에 적용되는 소정근로시간 규정. 날짜가 없거나 잘못됐으면 가장 최근 규정을 쓴다. */
export function workingTimeRuleFor(date: string): WorkingTimeRule {
  const sorted = [...WORKING_TIME_RULES].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const normalized = normalizeDate(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return sorted[sorted.length - 1];
  const applicable = sorted.filter((rule) => rule.effectiveFrom <= normalized);
  return applicable.length ? applicable[applicable.length - 1] : sorted[0];
}

/** 해당 시점 규정에 따른 1일 통상임금. */
export function dailyOrdinaryWageOn(monthlyOrdinaryWage: number, date: string) {
  const rule = workingTimeRuleFor(date);
  return { rule, dailyWage: ordinaryDailyWageOf(monthlyOrdinaryWage, rule.monthlyHours, rule.dailyHours) };
}

/** 퇴직일 직전 N개월치 급여월 키를 최근 순으로 만든다. 퇴직월 자체는 일할이라 제외한다. */
export function precedingMonths(retirementDate: string, count = 3) {
  const date = parseDate(retirementDate);
  if (!date) return [];
  const months: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - index, 1));
    months.push(`${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

/** 그 달의 마지막 날인가. 말일 퇴사는 그 달을 만근한 것이라 일할계산이 아니다. */
export function isMonthEnd(date: string) {
  const parsed = parseDate(date);
  if (!parsed) return false;
  const lastDay = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).getUTCDate();
  return parsed.getUTCDate() === lastDay;
}

/**
 * 평균임금 산정에 쓸 급여월. 법정 기준은 "퇴직일 이전 3개월"이라 8/31 퇴사면 6/1~8/30 이고
 * 퇴직월(8월)이 들어간다. 급여 자료가 월 단위라 월로 근사하되, 퇴직월을 넣을지는 퇴사일로 가른다.
 *
 *   말일 퇴사(8/31) → 그 달을 만근했으므로 퇴직월 포함: 2026-08, 2026-07, 2026-06
 *   중도 퇴사(7/10) → 일할이라 한 달치가 아니므로 제외: 2026-06, 2026-05, 2026-04
 *
 * 예전에는 퇴사일과 무관하게 늘 퇴직월을 뺐다. 그래서 말일 퇴사자는 마지막 달 인센티브가
 * 확정되어도 퇴직금에 반영될 자리가 아예 없었다.
 */
export function averageWageMonths(retirementDate: string, count = 3) {
  const date = parseDate(retirementDate);
  if (!date) return [];
  const offset = isMonthEnd(retirementDate) ? 0 : 1;
  const months: string[] = [];
  for (let index = offset; index < offset + count; index += 1) {
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - index, 1));
    months.push(`${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

export function calculateSeverance(input: SeveranceInput): SeveranceResult {
  const join = parseDate(input.joinDate);
  const leave = parseDate(input.retirementDate);
  // 통상임금 하한은 퇴직 시점의 소정근로시간 규정을 따른다.
  const { rule: workingTimeRule, dailyWage: ordinaryDailyWage } = dailyOrdinaryWageOn(input.monthlyOrdinaryWage, input.retirementDate);
  const empty: SeveranceResult = {
    eligible: false, reason: "", tenureDays: 0, averageWageTotal: 0, averageWageDays: 0,
    averageDailyWage: 0, ordinaryDailyWage, appliedDailyWage: 0, basis: "NONE", months: [], severance: 0,
    averageSeverance: 0, ordinarySeverance: 0, limitations: [], provisionalMonths: [], workingTimeRule,
  };
  if (!join || !leave) return { ...empty, reason: "입사일과 퇴사일을 모두 확인해 주세요." };
  if (leave < join) return { ...empty, reason: "퇴사일이 입사일보다 빠릅니다." };

  // 마지막 근무일까지 재직한 것으로 보아 양끝을 포함한다.
  const tenureDays = Math.round((leave.getTime() - join.getTime()) / DAY) + 1;
  if (tenureDays < 365) {
    return { ...empty, tenureDays, reason: "계속근로기간이 1년 미만이라 법정 퇴직금 지급 대상이 아닙니다." };
  }

  const months = averageWageMonths(input.retirementDate);
  const wages = months.map((month) => input.recentWages.find((wage) => wage.yearMonth === month));
  const found = wages.filter((wage): wage is SeveranceWage => Boolean(wage));
  const averageWageTotal = found.reduce((sum, wage) => sum + Math.max(0, wage.grossPay), 0);
  // 자료가 있는 달만 분모에 넣는다. 없는 달까지 일수로 세면 평균임금이 실제보다 낮아진다.
  const averageWageDays = found.reduce((sum, wage) => sum + daysInYearMonth(wage.yearMonth), 0);
  const averageDailyWage = averageWageDays > 0 ? averageWageTotal / averageWageDays : 0;

  const appliedDailyWage = Math.max(averageDailyWage, ordinaryDailyWage);
  const basis: SeveranceResult["basis"] = appliedDailyWage <= 0 ? "NONE"
    : averageDailyWage >= ordinaryDailyWage ? "AVERAGE" : "ORDINARY";
  // 퇴직금 = 1일 임금 × 30 × 계속근로일수/365. 두 기준을 각각 내고 큰 쪽을 적용한다.
  const severanceFrom = (dailyWage: number) => Math.round(dailyWage * 30 * (tenureDays / 365));
  const averageSeverance = severanceFrom(averageDailyWage);
  const ordinarySeverance = severanceFrom(ordinaryDailyWage);
  const severance = severanceFrom(appliedDailyWage);

  const missing = months.length - found.length;
  // 산정에 실제로 쓴 달 중 아직 확정되지 않은 것만 남긴다. 쓰지도 않은 달을 경고할 필요는 없다.
  const usedMonths = new Set(found.map((wage) => wage.yearMonth));
  const provisionalMonths = (input.unconfirmedMonths ?? []).filter((month) => usedMonths.has(month));
  const limitations = [
    "법정 기준은 퇴직일 이전 3개월이지만 급여 자료가 월 단위라 3개 급여월로 근사했습니다.",
    "수습·휴업·출산전후휴가·육아휴직·업무상 요양 등 제외기간을 반영하지 못했습니다.",
    "상여금·연차수당의 3/12 산입 규칙을 반영하지 못했습니다.",
    ...(provisionalMonths.length
      ? [`${provisionalMonths.join(", ")} 급여가 아직 확정되지 않았습니다. 인센티브가 정해지면 금액이 바뀝니다.`]
      : []),
  ];
  return {
    eligible: severance > 0, tenureDays, averageWageTotal, averageWageDays, averageDailyWage,
    ordinaryDailyWage, appliedDailyWage, basis, months: found.map((wage) => wage.yearMonth), severance, limitations,
    averageSeverance, ordinarySeverance, provisionalMonths, workingTimeRule,
    reason: appliedDailyWage <= 0 ? "직전 3개월 급여 자료와 통상임금이 모두 없어 평균임금을 산정할 수 없습니다."
      : missing > 0 ? `직전 3개월 중 ${missing}개월치 급여 자료가 없어 남은 ${found.length}개월로 산정했습니다. 금액을 확인해 주세요.`
      : "",
  };
}

/**
 * 연차수당 = 1일 통상임금 × 미사용 연차 일수.
 * 잔여일수가 음수면(선사용·마이너스 연차) 그대로 음수 금액이 나와 정산에서 공제된다.
 * 일수를 그대로 받는 이유는 잔여일수를 계산할 수 없기 때문이다. 사용 이력은 hr_leave_requests 에
 * 있지만 연간 부여(발생) 일수를 보관하는 곳이 없어 "발생 - 사용"이 성립하지 않는다. 계산 근거가
 * 되는 일수를 비고 메모가 아니라 값으로 남겨두려는 목적도 있다.
 */
export function calculateLeaveAllowance(leaveDays: number, monthlyOrdinaryWage: number, referenceDate = "") {
  const { rule, dailyWage } = dailyOrdinaryWageOn(monthlyOrdinaryWage, referenceDate);
  const days = Number.isFinite(leaveDays) ? leaveDays : 0;
  return { days, dailyWage, rule, amount: Math.round(dailyWage * days) };
}
