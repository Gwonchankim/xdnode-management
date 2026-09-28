import { fixedTermEndDate } from "./hr-employment-contract.ts";
import { normalizeDate } from "./hr-severance-calculation.ts";

type OrdinaryWageEmployee = {
  joinDate: string;
  annualSalary: number;
  basePay: number;
  mealAllowance: number;
  childcareAllowance: number;
  vehicleAllowance: number;
  firstTermPayPercent?: number | null;
  regularContractDate?: string | null;
};

/** 회사 기준: 경력직 100%, 신입 첫 3개월 90%. 인사기록에 저장한 지급률을 사용한다.
 * 식대·육아·자가운전수당을 포함하되, 연봉에 포함된 수당을 중복 합산하지 않는다.
 * 중간 반올림 없이 정산 엔진에 넘긴다. */
export function monthlyOrdinaryWageOn(employee: OrdinaryWageEmployee | null, date: string): number {
  if (!employee) return 0;
  const asOf = normalizeDate(date);
  const joined = normalizeDate(employee.joinDate);
  const firstTermEnd = fixedTermEndDate(joined);
  const convertedOn = normalizeDate(employee.regularContractDate ?? "");
  const converted = Boolean(convertedOn) && convertedOn <= asOf;
  const percent = employee.firstTermPayPercent ?? 100;
  const reduced = Boolean(firstTermEnd) && joined <= asOf && asOf <= firstTermEnd
    && !converted && percent > 0 && percent < 100;
  const monthly = employee.annualSalary > 0 ? employee.annualSalary / 12
    : employee.basePay + employee.mealAllowance + employee.childcareAllowance + employee.vehicleAllowance;
  return monthly * (reduced ? percent / 100 : 1);
}
