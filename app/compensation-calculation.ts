export type CompensationRounding = "round" | "up" | "down";

export type CompensationMonthlyPay = {
  basic?: number;
  // 그 달만 직접 적은 식대. 없으면 기준액을 근무일로 일할 계산한다. 중도 입사·휴직 달의 실비 정산처럼
  // 자동 계산과 다른 금액을 줘야 할 때 쓴다.
  meal?: number;
  // 그 달만 직접 적은 기본급·자가운전·육아. 식대처럼 있으면 계산하지 않고 이 값을 그대로 쓴다. 지급이 끝난 달을
  // 급여 시스템의 급여대장과 맞출 때 쓴다(2026-10-01, 8월 급여대장). basic 은 수기 기본급의 월 기준액(일할 대상)이라
  // 기본급은 이름을 따로 둔다.
  basicOverride?: number;
  car?: number;
  child?: number;
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
/** 수습(첫 계약) 종료일. 입사일 + 개월수 − 1일이고, 끝나는 달에 입사일과 같은 날이 없으면 그 달 말일이다
 *  (민법 제160조 제3항, 2026-09-28 확정). 1/31 입사 → 4/30, 11/30 입사 → 2/28. 근로계약서의 fixedTermEndDate 와 같은 규칙이다. */
export const probationEnd = (join: Date | null, months: number) => {
  if (!join || !months) return null;
  const year = join.getUTCFullYear();
  const targetMonth = join.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  if (join.getUTCDate() > lastDay) return new Date(Date.UTC(year, targetMonth, lastDay));
  return new Date(Date.UTC(year, targetMonth, join.getUTCDate()) - DAY);
};

/** 첫 계약은 3개월이다(hr-employment-contract.ts 의 FIXED_TERM_MONTHS). 엔진이 계약서 모듈을 끌어오지 않도록 여기 둔다. */
const FIRST_TERM_MONTHS = 3;

export function calculateCompensation(employee: CompensationEmployee, year: number, month: number, rounding: CompensationRounding, columns: CompensationColumns): CompensationRow {
  const totalDays = daysInCompensationMonth(year, month);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month - 1, totalDays));
  const join = parseDate(employee.joinDate);
  const leave = parseDate(employee.leaveDate);
  const start = join && join > monthStart ? join : monthStart;
  const end = leave && leave < monthEnd ? leave : monthEnd;
  const days = start > end ? 0 : Math.round((end.getTime() - start.getTime()) / DAY) + 1;
  // 수습 칸을 「—」(0개월)로 두면 인사기록의 종료일이 남아 있어도 수습을 적용하지 않는다. 칸이 곧 적용 여부다.
  const endOfProbation = employee.probationMonths > 0
    ? (employee.probationEndDate ? parseDate(employee.probationEndDate) : probationEnd(join, employee.probationMonths))
    : null;
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
    if (days === totalDays && segments.length === 1) {
      // 회사 규칙: 기본급 = ceil(연봉×지급률/12) − 식대 − 육아 − 자가운전. 근로계약서(hr-employment-contract.ts)와 같은 식이라
      // 단수 처리 설정과 무관하게 항상 올림한다. 설정값은 일할 구간에만 쓴다.
      basic = Math.max(0, Math.ceil(employee.annualSalary * segments[0].rate / 12) - allowanceMonthly);
    } else if (days === totalDays) {
      // 한 달을 다 근무했는데 수습이 달 중간에 끝난 달(방법 1, 2026-09-28 확정).
      // 정상 월 기본급에서 (정상 월급 − 수습 월급) × 수습 일수 ÷ 그 달 일수를 뺀다. 수습 일수가 0이면 정상 월급,
      // 한 달 전부면 수습 월급과 같다. 예전처럼 365일법을 쓰면 31일 달은 정상 월보다 많이, 2월은 크게 적게 나왔다.
      const fullMonthly = Math.ceil(employee.annualSalary / 12);
      const reducedMonthly = Math.ceil(employee.annualSalary * segments[0].rate / 12);
      basic = Math.max(0, roundPay(fullMonthly - allowanceMonthly - (fullMonthly - reducedMonthly) * segments[0].days / totalDays, rounding));
    } else {
      // 입사·퇴사로 일부만 근무한 달은 회사가 확정한 365일법이다. 수습이 걸치면 구간마다 따로 센다.
      basic = segments.reduce((sum, segment) => sum + Math.max(0, roundPay((employee.annualSalary * segment.rate - allowanceMonthly * 12) / 365 * segment.days, rounding)), 0);
    }
  }
  if (monthly.basicOverride !== undefined) basic = monthly.basicOverride;
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
  const car = monthly.car !== undefined ? monthly.car : allowance(employee.car);
  const child = monthly.child !== undefined ? monthly.child : allowance(employee.child);
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

/** 이 달 임금표의 수습 표시를 인사기록카드와 맞춰 본다. 임금 계산 화면의 경고 칸이 쓴다.
 *  회사 기준: 경력직 100%, 신입은 첫 3개월 동안 인사기록카드의 첫 계약 지급률(보통 90%). */
export type ProbationReviewItem = {
  id: string;
  name: string;
  /** 수습(첫 계약) 종료일. YYYY-MM-DD. */
  endDate: string;
  /** 임금표에 적용된 지급률. 수습이 꺼져 있으면 null. */
  rowRate: number | null;
  /** 인사기록카드의 지급률. 100%(경력직)이면 null. */
  hrRate: number | null;
  /** 「인사기록대로 맞추기」·「수습 해제」를 누르면 이 행에 덮어쓸 값. 고칠 것이 없으면 없다. */
  fix?: Pick<CompensationEmployee, "probationMonths" | "probationRate" | "probationEndDate">;
};

export type ProbationReview = {
  /** 인사기록은 첫 계약 지급률(100% 미만)인데 이 달 임금표에 수습이 꺼져 있다. */
  missing: ProbationReviewItem[];
  /** 임금표의 수습 지급률이 인사기록과 다르다. 인사기록은 100%인데 수습이 켜진 경우도 여기다. */
  mismatch: ProbationReviewItem[];
  /** 첫 3개월 안인데 인사기록·임금표 모두 100%. 경력직이 맞는지 확인할 목록이다. */
  confirmFull: ProbationReviewItem[];
  /** 종료일이 이 달보다 앞인데 수습 칸이 남아 있다. 금액은 이미 100%로 계산된다. */
  ended: ProbationReviewItem[];
  /** 이 달 중간에 수습이 끝나 두 구간으로 나눠 계산했다. */
  boundary: ProbationReviewItem[];
};

/** 임금표 행에 해당하는 인사기록 행. 사번이 같으면 그 사람이고, 엑셀로 들여와 사번이 없는 행은
 *  이름이 한 사람에게만 맞을 때 그 사람으로 본다. 동명이인이면 찾지 않는다. */
function hrMatcher(hrEmployees: CompensationEmployee[]) {
  const byId = new Map(hrEmployees.map((employee) => [employee.id, employee]));
  const byName = new Map<string, CompensationEmployee | null>();
  for (const employee of hrEmployees) {
    const name = employee.name.trim();
    byName.set(name, byName.has(name) ? null : employee);
  }
  return (employee: CompensationEmployee) => byId.get(employee.id) ?? byName.get(employee.name.trim()) ?? null;
}

const isoOf = (date: Date | null) => date ? date.toISOString().slice(0, 10) : "";
const PROBATION_OFF = { probationMonths: 0, probationRate: undefined, probationEndDate: undefined };

export function reviewProbation(rows: CompensationRow[], hrEmployees: CompensationEmployee[] | null, year: number, month: number): ProbationReview {
  const review: ProbationReview = { missing: [], mismatch: [], confirmFull: [], ended: [], boundary: [] };
  const monthStart = `${compensationMonthKey(year, month)}-01`;
  const monthEnd = `${compensationMonthKey(year, month)}-${String(daysInCompensationMonth(year, month)).padStart(2, "0")}`;
  const hrOf = hrMatcher(hrEmployees ?? []);
  for (const row of rows) {
    if (!row.days) continue;
    const { employee } = row;
    const checked = employee.probationMonths > 0;
    const rowRate = checked ? employee.probationRate ?? 0.9 : null;
    const item = (hrRate: number | null, endDate: string, fix?: ProbationReviewItem["fix"]): ProbationReviewItem => ({
      id: employee.id, name: employee.name || "이름 미입력", endDate, rowRate, hrRate, ...(fix ? { fix } : {}),
    });
    if (row.probationOver) review.ended.push(item(null, isoOf(row.probationEnd), PROBATION_OFF));
    if (row.mixedProbation) review.boundary.push(item(null, isoOf(row.probationEnd)));
    if (!hrEmployees) continue;
    const hr = hrOf(employee);
    if (!hr) continue;
    const hrRate = hr.probationMonths > 0 && hr.probationRate !== undefined ? hr.probationRate : null;
    const hrEnd = hr.probationEndDate || isoOf(probationEnd(parseDate(hr.joinDate), FIRST_TERM_MONTHS));
    const inFirstTerm = Boolean(hrEnd) && hr.joinDate <= monthEnd && hrEnd >= monthStart;
    const hrFix = hrRate === null ? PROBATION_OFF
      : { probationMonths: hr.probationMonths, probationRate: hr.probationRate, probationEndDate: hr.probationEndDate };
    if (hrRate !== null && inFirstTerm && !checked) review.missing.push(item(hrRate, hrEnd, hrFix));
    else if (row.probationApplied && (hrRate === null || Math.abs((rowRate ?? 0) - hrRate) > 0.0001)) {
      review.mismatch.push(item(hrRate, hrRate === null ? isoOf(row.probationEnd) : hrEnd, hrFix));
    } else if (hrRate === null && inFirstTerm && !checked) review.confirmFull.push(item(null, hrEnd));
  }
  return review;
}

/** 임금표의 입·퇴사일이 인사기록카드와 다른 행. 인사기록이 기준이다(2026-09-28 확인: 8월 임금안의 입사일이 전원 하루씩 빨랐다).
 *  근무일과 일할 계산이 이 날짜로 정해지므로, 다르면 확정 전에 알리고 「인사기록대로 맞추기」로 고친다. */
export type HrDateMismatch = {
  id: string;
  name: string;
  rowJoinDate: string;
  hrJoinDate: string;
  rowLeaveDate: string;
  hrLeaveDate: string;
  fix: Pick<CompensationEmployee, "joinDate" | "leaveDate">;
};

export function reviewHrDates(rows: CompensationRow[], hrEmployees: CompensationEmployee[] | null): HrDateMismatch[] {
  if (!hrEmployees) return [];
  const hrOf = hrMatcher(hrEmployees);
  const mismatches: HrDateMismatch[] = [];
  for (const { employee } of rows) {
    const hr = hrOf(employee);
    if (!hr) continue;
    const rowJoinDate = employee.joinDate || "";
    const rowLeaveDate = employee.leaveDate || "";
    const hrJoinDate = hr.joinDate || "";
    const hrLeaveDate = hr.leaveDate || "";
    if (rowJoinDate === hrJoinDate && rowLeaveDate === hrLeaveDate) continue;
    mismatches.push({
      id: employee.id, name: employee.name || "이름 미입력", rowJoinDate, hrJoinDate, rowLeaveDate, hrLeaveDate,
      fix: { joinDate: hrJoinDate, leaveDate: hrLeaveDate },
    });
  }
  return mismatches;
}
