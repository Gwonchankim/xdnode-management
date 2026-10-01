// 퇴직금·연차수당 산정. 순수 계산만 담당하고 DB나 화면은 건드리지 않는다 —
// app/api/hr/operations/route.ts 가 퇴직 정산에서 호출하고, 같은 함수를 테스트가 직접 검증한다.
//
// 근로자퇴직급여보장법 기준:
//   퇴직금 = 1일 평균임금 × 30 × (계속근로일수 / 365)
//   1일 평균임금 = 퇴직 직전 3개월 임금총액 / 그 기간의 총일수
//   1일 평균임금이 1일 통상임금보다 적으면 통상임금을 쓴다 (법정 최저 보장)
//   계속근로기간 1년 미만이면 지급 의무가 없다
//
// 날짜의 뜻(2026-10-01 정리): 퇴직 요청에 저장하는 날짜(retirement_date)는 「마지막 근무일」이다.
// 퇴직일(퇴직금 지급 사유 발생일, 4대보험 상실일)은 그 다음 날이다. 10/30 까지 근무하면 퇴직일은 10/31.
//   계속근로기간 = 입사일 ~ 마지막 근무일(양끝 포함)
//   평균임금 산정기간 = 퇴직일 이전 3개월 = (퇴직일 − 3개월) ~ 마지막 근무일. 10/31 퇴직이면 7/31~10/30(92일).
//
// 이 함수의 결과는 확정 지급액이 아니라 "추정액"이다. 법정 산식과 다음 두 가지가 어긋나 있고,
// 둘 다 이 앱에 자료가 없어서 지금은 좁힐 수 없다. 결과를 급여·임금안에 자동 반영하지 말 것.
// (산정 기간은 날짜 단위로 맞췄다: 기간에 걸친 달은 그 달 급여를 근무일수로 나눠 걸친 날짜만큼 넣는다.
//  급여가 그 달 안에서 고르게 쌓인다고 보는 근사라, 월중 지급된 인센티브의 귀속일까지는 가리지 못한다.)
//   2) 제외기간: 근로기준법 시행령 제2조는 수습·사용자 귀책 휴업·출산전후휴가·육아휴직·업무상
//      요양·쟁의행위·병역 기간과 그 임금을 분자·분모에서 모두 뺀다. hr_leave_requests 의 종류가
//      ANNUAL/HALF_AM/HALF_PM/SICK/FAMILY/OTHER 뿐이라 이 기간들을 식별할 수 없다.
//   3) 임금총액 범위: 상여금과 연차수당은 연간액의 3/12만 산입해야 하는데, gross_pay 는 그 달에
//      실제 지급된 금액이라 지급 시점에 따라 평균임금이 출렁인다.

export type SeveranceWage = { yearMonth: string; grossPay: number };

export type SeveranceInput = {
  joinDate: string;        // YYYY-MM-DD
  retirementDate: string;  // YYYY-MM-DD (마지막 근무일. 퇴직일은 그 다음 날이다)
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
  /** 평균임금 산정기간(퇴직일 이전 3개월). 날짜가 잘못됐으면 null. */
  averagePeriod: { start: string; end: string; days: number } | null;
  /** 산정기간에 걸친 달마다 넣은 몫. 급여 자료가 없는 달은 included=false 로 남긴다. */
  parts: AverageWagePart[];
};

export type AverageWagePart = {
  yearMonth: string;
  /** 산정기간 안에 든 날짜 수. */
  overlapDays: number;
  /** 그 달에 실제로 재직한 날짜 수(마지막 달은 마지막 근무일까지). 그 달 급여가 이 날수의 대가다. */
  workedDays: number;
  grossPay: number;
  /** 평균임금 분자에 넣은 금액 = 그 달 급여 × overlapDays ÷ workedDays. */
  amount: number;
  included: boolean;
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

const isoOf = (date: Date) => date.toISOString().slice(0, 10);
const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY) + 1;

/** 퇴직일 = 마지막 근무일의 다음 날(퇴직금 지급 사유 발생일, 4대보험 상실일). 날짜가 잘못됐으면 "". */
export function retirementDayAfter(lastWorkDate: string) {
  const date = parseDate(lastWorkDate);
  return date ? isoOf(new Date(date.getTime() + DAY)) : "";
}

/**
 * 평균임금 산정기간 = 퇴직일 이전 3개월(근로기준법 제2조 제1항 제6호). 퇴직일은 마지막 근무일 다음 날이다.
 *   마지막 근무일 10/30 → 퇴직일 10/31 → 7/31~10/30 (92일): 7월 1일 · 8월 · 9월 · 10월 30일
 *   마지막 근무일 8/31  → 퇴직일 9/1   → 6/1~8/31  (92일): 6월 · 7월 · 8월
 * 시작일은 퇴직일과 같은 날짜의 3개월 전이다. 그 달에 같은 날이 없으면 그 달 말일로 둔다(5/31 퇴직 → 2/28).
 *
 * 기간에 걸친 달마다 overlapDays(기간 안 날짜 수)와 workedDays(그 달에 재직한 날짜 수)를 준다.
 * 그 달 급여는 workedDays 의 대가이므로 평균임금에는 급여 × overlapDays ÷ workedDays 만큼 넣는다.
 */
export function averageWagePeriod(lastWorkDate: string, joinDate = "") {
  const end = parseDate(lastWorkDate);
  if (!end) return null;
  const retirement = new Date(end.getTime() + DAY);
  const startYear = retirement.getUTCFullYear();
  const startMonth = retirement.getUTCMonth() - 3;
  const lastDayOfStartMonth = new Date(Date.UTC(startYear, startMonth + 1, 0)).getUTCDate();
  let start = new Date(Date.UTC(startYear, startMonth, Math.min(retirement.getUTCDate(), lastDayOfStartMonth)));
  const join = parseDate(joinDate);
  if (join && join > start) start = join;
  if (start > end) return null;
  const months: Array<{ yearMonth: string; overlapDays: number; workedDays: number }> = [];
  for (let cursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)); cursor >= new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1))) {
    const monthStart = cursor;
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const lastDay = end < monthEnd ? end : monthEnd;
    const overlapFrom = start > monthStart ? start : monthStart;
    const workedFrom = join && join > monthStart ? join : monthStart;
    months.push({
      yearMonth: isoOf(monthStart).slice(0, 7),
      overlapDays: daysBetween(overlapFrom, lastDay),
      workedDays: daysBetween(workedFrom, lastDay),
    });
  }
  return { start: isoOf(start), end: isoOf(end), days: daysBetween(start, end), months };
}

/**
 * 평균임금 산정기간에 걸친 급여월(최근 순). 마지막 근무일 10/30 이면 2026-10, 09, 08, 07 네 달이다 —
 * 7월은 7/31 하루만 들어간다. 말일까지 근무하면(8/31) 세 달(08, 07, 06)이다.
 *
 * 예전에는 말일이 아니면 퇴직월을 통째로 빼고 앞의 세 달을 봤다. 그래서 10/30 까지 근무한 사람의
 * 평균임금이 7·8·9월로 잡혔다(2026-10-01 바로잡음).
 */
export function averageWageMonths(retirementDate: string, joinDate = "") {
  return averageWagePeriod(retirementDate, joinDate)?.months.map((month) => month.yearMonth) ?? [];
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
    averagePeriod: null, parts: [],
  };
  if (!join || !leave) return { ...empty, reason: "입사일과 퇴사일을 모두 확인해 주세요." };
  if (leave < join) return { ...empty, reason: "퇴사일이 입사일보다 빠릅니다." };

  // 마지막 근무일까지 재직한 것으로 보아 양끝을 포함한다.
  const tenureDays = Math.round((leave.getTime() - join.getTime()) / DAY) + 1;
  if (tenureDays < 365) {
    return { ...empty, tenureDays, reason: "계속근로기간이 1년 미만이라 법정 퇴직금 지급 대상이 아닙니다." };
  }

  // 산정기간에 걸친 달마다 그 달 급여를 근무일수로 나눠 기간 안 날짜만큼 넣는다.
  // 10/30 까지 근무하면 7/31~10/30: 7월은 1/31, 8·9월은 전부, 10월(10/1~10/30 근무분)은 전부.
  const period = averageWagePeriod(input.retirementDate, input.joinDate);
  const parts: AverageWagePart[] = (period?.months ?? []).map((month) => {
    const wage = input.recentWages.find((item) => item.yearMonth === month.yearMonth);
    const grossPay = wage ? Math.max(0, wage.grossPay) : 0;
    return {
      ...month, grossPay, included: Boolean(wage),
      amount: wage && month.workedDays > 0 ? grossPay * month.overlapDays / month.workedDays : 0,
    };
  });
  const found = parts.filter((part) => part.included);
  const averageWageTotal = found.reduce((sum, part) => sum + part.amount, 0);
  // 자료가 있는 달만 분모에 넣는다. 없는 달까지 일수로 세면 평균임금이 실제보다 낮아진다.
  const averageWageDays = found.reduce((sum, part) => sum + part.overlapDays, 0);
  const averageDailyWage = averageWageDays > 0 ? averageWageTotal / averageWageDays : 0;

  const appliedDailyWage = Math.max(averageDailyWage, ordinaryDailyWage);
  const basis: SeveranceResult["basis"] = appliedDailyWage <= 0 ? "NONE"
    : averageDailyWage >= ordinaryDailyWage ? "AVERAGE" : "ORDINARY";
  // 퇴직금 = 1일 임금 × 30 × 계속근로일수/365. 두 기준을 각각 내고 큰 쪽을 적용한다.
  const severanceFrom = (dailyWage: number) => Math.round(dailyWage * 30 * (tenureDays / 365));
  const averageSeverance = severanceFrom(averageDailyWage);
  const ordinarySeverance = severanceFrom(ordinaryDailyWage);
  const severance = severanceFrom(appliedDailyWage);

  const missingMonths = parts.filter((part) => !part.included).map((part) => part.yearMonth);
  const missing = missingMonths.length;
  // 산정에 실제로 쓴 달 중 아직 확정되지 않은 것만 남긴다. 쓰지도 않은 달을 경고할 필요는 없다.
  const usedMonths = new Set(found.map((part) => part.yearMonth));
  const provisionalMonths = (input.unconfirmedMonths ?? []).filter((month) => usedMonths.has(month));
  const limitations = [
    "급여 자료가 월 단위라 산정기간에 걸친 달은 그 달 급여를 근무일수로 나눠 걸친 날짜만큼 넣었습니다.",
    "수습·휴업·출산전후휴가·육아휴직·업무상 요양 등 제외기간을 반영하지 못했습니다.",
    "상여금·연차수당의 3/12 산입 규칙을 반영하지 못했습니다.",
    ...(provisionalMonths.length
      ? [`${provisionalMonths.join(", ")} 급여가 아직 확정되지 않았습니다. 인센티브가 정해지면 금액이 바뀝니다.`]
      : []),
  ];
  return {
    eligible: severance > 0, tenureDays, averageWageTotal, averageWageDays, averageDailyWage,
    ordinaryDailyWage, appliedDailyWage, basis, months: found.map((part) => part.yearMonth), severance, limitations,
    averageSeverance, ordinarySeverance, provisionalMonths, workingTimeRule,
    averagePeriod: period ? { start: period.start, end: period.end, days: period.days } : null, parts,
    reason: appliedDailyWage <= 0 ? "직전 3개월 급여 자료와 통상임금이 모두 없어 평균임금을 산정할 수 없습니다."
      : missing > 0 ? `산정기간 중 ${missingMonths.join(", ")} 급여 자료가 없어 나머지 ${averageWageDays}일로 산정했습니다. 금액을 확인해 주세요.`
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
