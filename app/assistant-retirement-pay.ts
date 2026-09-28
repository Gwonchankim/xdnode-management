import { calculateCompensation, type CompensationColumns, type CompensationEmployee, type CompensationRounding } from "./compensation-calculation";
import { normalizeCompensationSettings } from "./compensation-settings";

type RetirementPayRun = { status: string; employees: CompensationEmployee[]; settings?: unknown };
export function retirementPayDraft(run: RetirementPayRun, input: { period: string; employeeId: string; employeeName: string; amount: number; sourceFileName: string }) {
  if (run.status !== "DRAFT") throw new Error("확정된 임금안입니다. 임금계산에서 수정하기를 먼저 눌러 주세요.");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw new Error("반영할 급여월을 확인해 주세요.");
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) throw new Error("퇴직금은 0원 이상의 정수여야 합니다.");
  if (!input.sourceFileName?.trim()) throw new Error("퇴직금 금액의 첨부 파일명을 확인해 주세요.");
  const matches = run.employees.filter((employee) => employee.id === input.employeeId);
  if (matches.length !== 1 || matches[0].name.trim() !== input.employeeName.trim()) throw new Error("해당 월 임금안의 직원과 영수증 대상이 일치하지 않습니다. 직원과 급여월을 확인해 주세요.");
  const settings = normalizeCompensationSettings(run.settings);
  if (!settings.columns.severance && run.employees.some((employee) => employee.id !== input.employeeId && Number(employee.monthly?.[input.period]?.severance) > 0)) {
    throw new Error("다른 직원의 퇴직금이 숨겨져 있습니다. 임금계산에서 퇴직금 항목을 켜고 금액을 확인한 뒤 반영해 주세요.");
  }
  settings.columns.severance = true;
  const employees = run.employees.map((employee) => employee.id === input.employeeId ? {
    ...employee, monthly: { ...employee.monthly, [input.period]: {
      ...employee.monthly?.[input.period], severance: input.amount,
      retirementPaySource: input.sourceFileName.trim().slice(0, 240),
    } },
  } : employee);
  const [year, month] = input.period.split("-").map(Number);
  const rows = employees.map((employee) => {
    const row = calculateCompensation(employee, year, month, settings.rounding as CompensationRounding, settings.columns as CompensationColumns);
    return { ...row, employeeId: employee.id, deductionNote: employee.monthly?.[input.period]?.deductionNote ?? "", personalExpenseNote: employee.monthly?.[input.period]?.personalExpenseNote ?? "" };
  });
  return { employees, rows, settings };
}
