export type CompensationRounding = "round" | "up" | "down";

export type CompensationMonthlyPay = {
  basic?: number;
  // 그 달만 직접 적은 식대. 없으면 기준액을 근무일로 일할 계산한다. 중도 입사·휴직 달의 실비 정산처럼
  // 자동 계산과 다른 금액을 줘야 할 때 쓴다.
  meal?: number;
  incentive?: number;
  bonus?: number;
  extra?: number;
  research?: number;
  severance?: number;
  retirementPaySource?: string;
  // 미사용 연차를 정산해 주는 달에만 쓴다. 지급 항목이라 지급총액에 더해진다.
  annualLeave?: number;
  // 업무에 개인 비용을 쓴 사람에게 되돌려 주는 금액. 실비라 일할계산하지 않고 적은 금액 그대로
  // 지급총액에 더한다. 사유는 필요할 때만 적는다.
  personalExpense?: number;
  personalExpenseNote?: string;
  welfare?: number;
  welfareNote?: string;
  // 급여에서 빼는 금액과 그 사유. 지급총액에서 차감하지 않고 별도로 기록해
  // 급여관리의 공제총액·실 지급액으로 넘긴다.
  deduction?: number;
  deductionNote?: string;
  note?: string;
};

export type CompensationEmployee = {
  id: string;
  name: string;
  department: string;
  title: string;
  birthDate: string;
  joinDate: string;
  leaveDate: string;
  probationMonths: number;
  /** 수습·첫 계약 기간의 지급 비율(0~1). 없으면 예전 그대로 0.9 다. 회사는 첫 3개월 기간제 동안 사람마다 다른 비율을 준다. */
  probationRate?: number;
  /** 수습·첫 계약이 끝나는 날(YYYY-MM-DD). 있으면 입사일+개월수 대신 이 날짜를 쓴다 — 조기 전환한 사람 때문이다. */
  probationEndDate?: string;
  annualSalary: number;
  basePay: number;
  manualBasic: boolean;
  meal: number;
  car: number;
  child: number;
  monthly: Record<string, CompensationMonthlyPay>;
};

export type CompensationColumns = { research: boolean; extra: boolean; welfare: boolean; severance: boolean; deduction: boolean; annualLeave: boolean; personalExpense: boolean };

export type CompensationRow = {
  employee: CompensationEmployee;
  days: number;
  daysInMonth: number;
  basic: number;
  meal: number;
  car: number;
  child: number;
  incentive: number;
  bonus: number;
  extra: number;
  research: number;
  severance: number;
  annualLeave: number;
  personalExpense: number;
  welfare: number;
  deduction: number;
  total: number;
  mixedProbation: boolean;
  probationApplied: boolean;
  probationEnd: Date | null;
  probationWithoutJoin: boolean;
  probationOver: boolean;
};

const DAY = 86_400_000;

export const compensationMonthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;
export const daysInCompensationMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const parseDate = (value: string) => value ? new Date(`${value}T00:00:00Z`) : null;
const roundPay = (value: number, rounding: CompensationRounding) => rounding === "up" ? Math.ceil(value) : rounding === "down" ? Math.floor(value) : Math.round(value);
const overlapDays = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  return start > end ? 0 : Math.round((end.getTime() - start.getTime()) / DAY) + 1;
};
const probationEnd = (join: Date | null, months: number) => {
  if (!join || !months) return null;
  const year = join.getUTCFullYear();
  const targetMonth = join.getUTCMonth() + months;
  const day = Math.min(join.getUTCDate(), new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate());
  return new Date(Date.UTC(year, targetMonth, day) - DAY);
};

export function calculateCompensation(employee: CompensationEmployee, year: number, month: number, rounding: CompensationRounding, columns: CompensationColumns): CompensationRow {
  const totalDays = daysInCompensationMonth(year, month);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month - 1, totalDays));
  const join = parseDate(employee.joinDate);
  const leave = parseDate(employee.leaveDate);
  const start = join && join > monthStart ? join : monthStart;
  const end = leave && leave < monthEnd ? leave : monthEnd;
  const days = start > end ? 0 : Math.round((end.getTime() - start.getTime()) / DAY) + 1;
  const endOfProbation = employee.probationEndDate ? parseDate(employee.probationEndDate) : probationEnd(join, employee.probationMonths);
  const probationDays = days && join && endOfProbation ? overlapDays(start, end, join, endOfProbation) : 0;
  const segments = days ? [
    ...(probationDays ? [{ days: probationDays, rate: employee.probationRate ?? 0.9 }] : []),
    ...(days - probationDays ? [{ days: days - probationDays, rate: 1 }] : []),
  ] : [];
  const allowanceMonthly = employee.meal + employee.car + employee.child;
  const monthly = employee.monthly[compensationMonthKey(year, month)] ?? {};
  let basic = 0;
  if (employee.manualBasic) {
    const monthlyBasic = monthly.basic ?? employee.basePay;
    basic = !days ? 0 : days === totalDays ? monthlyBasic : Math.floor(monthlyBasic * 12 / 365 * days);
  }
  else if (days && employee.annualSalary > 0) {
    basic = days === totalDays && segments.length === 1
      // 회사 규칙: 기본급 = ceil(연봉×지급률/12) − 식대 − 육아 − 자가운전. 근로계약서(hr-employment-contract.ts)와 같은 식이라
      // 단수 처리 설정과 무관하게 항상 올림한다. 설정값은 일할 구간에만 쓴다.
      ? Math.max(0, Math.ceil(employee.annualSalary * segments[0].rate / 12) - allowanceMonthly)
      : segments.reduce((sum, segment) => sum + Math.max(0, roundPay((employee.annualSalary * segment.rate - allowanceMonthly * 12) / 365 * segment.days, rounding)), 0);
  }
  const allowance = (value: number) => !value || !days ? 0 : days === totalDays ? value : Math.floor(value * 12 / 365 * days);
  const incentive = monthly.incentive ?? 0;
  const bonus = monthly.bonus ?? 0;
  const extra = columns.extra ? monthly.extra ?? 0 : 0;
  const research = columns.research ? monthly.research ?? 0 : 0;
  const severance = columns.severance ? monthly.severance ?? 0 : 0;
  const annualLeave = columns.annualLeave ? monthly.annualLeave ?? 0 : 0;
  // 실비 정산이라 근무일수로 나누지 않는다. 15일 일해도 쓴 금액은 그대로 돌려준다.
  const personalExpense = columns.personalExpense ? monthly.personalExpense ?? 0 : 0;
  // 식대는 기본이 일할 계산이지만, 그 달에 직접 적은 값이 있으면 그 값을 그대로 쓴다.
  const meal = monthly.meal !== undefined ? monthly.meal : allowance(employee.meal);
  const car = allowance(employee.car);
  const child = allowance(employee.child);
  return {
    employee, days, daysInMonth: totalDays, basic, meal, car, child, incentive, bonus, extra, research, severance, annualLeave,
    personalExpense,
    welfare: monthly.welfare ?? 0,
    deduction: monthly.deduction ?? 0,
    // 지급총액은 공제를 뺀 실지급액이다. 공제 전 금액이 필요하면 total + deduction 으로 되돌린다.
    total: basic + meal + car + child + incentive + bonus + extra + research + severance + annualLeave + personalExpense - (monthly.deduction ?? 0),
    mixedProbation: segments.length > 1,
    probationApplied: probationDays > 0,
    probationEnd: endOfProbation,
    probationWithoutJoin: employee.probationMonths > 0 && !join,
    probationOver: Boolean(endOfProbation && employee.probationMonths > 0 && days > 0 && probationDays === 0),
  };
}
