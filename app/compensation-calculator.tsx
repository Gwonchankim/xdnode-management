"use client";

import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import readXlsxFile from "read-excel-file/browser";
import writeXlsxFile, { type SheetData } from "write-excel-file/browser";
import IncentiveCalculator from "./incentive/incentive-calculator";
import WonInput from "./won-input";
import { useClientReady } from "./hr-ui";
import { ErpDialogProvider, useErpDialog } from "./erp-dialog";
import {
  calculateCompensation,
  compensationMonthKey,
  type CompensationEmployee as Employee,
  type CompensationMonthlyPay as MonthlyPay,
  type CompensationRounding as Rounding,
} from "./compensation-calculation";

type CalculatorMode = "incentive" | "wage";
type WageSortKey = "employee" | "department" | "joinDate";
type WageSortState = { key: WageSortKey; direction: "asc" | "desc" };
type ImportedCell = string | number | boolean | Date | null;
type CompensationSettings = {
  rounding: Rounding;
  columns: { research: boolean; extra: boolean; welfare: boolean; severance: boolean; deduction: boolean; annualLeave: boolean; personalExpense: boolean };
  standards: { meal: number; car: number; child: number };
};

const STORAGE_KEY = "xdnode-compensation-preferences-v2";
const DAY = 86_400_000;
const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
  employee: 86, department: 92, title: 78, joinDate: 108, leaveDate: 108, days: 62, probation: 70,
  annualSalary: 98, basic: 110, meal: 92, car: 96, child: 88, incentive: 96, bonus: 92,
  extra: 92, research: 92, annualLeave: 104, personalExpense: 118, personalExpenseNote: 150, severance: 98, total: 116,
  welfare: 96, deduction: 104, deductionNote: 150, note: 132, action: 44,
};
const COLUMN_VISIBILITY_OPTIONS = [
  ["department", "부서"], ["title", "직책"], ["joinDate", "입사일"], ["leaveDate", "퇴사일"],
  ["days", "근무일"], ["probation", "수습"], ["annualSalary", "연봉"], ["basic", "기본급"],
  ["meal", "식대"], ["car", "자가운전"], ["child", "육아"], ["incentive", "인센티브"],
  ["bonus", "상여금"], ["extra", "추가수당"], ["research", "연구수당"], ["severance", "퇴직금"],
  ["annualLeave", "연차수당"], ["personalExpense", "개인비용지급"], ["personalExpenseNote", "개인비용 사유"],
  ["welfare", "복지기금"], ["deduction", "공제"], ["deductionNote", "공제 사유"], ["note", "비고"],
] as const;
const money = (value: number) => `${Math.round(value).toLocaleString("ko-KR")}원`;
const monthKey = compensationMonthKey;
const draftSignature = (employees: Employee[], settings: CompensationSettings) => JSON.stringify({ employees, settings });
const numberValue = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, "").toLowerCase();
const dateString = (value: unknown) => {
  if (value instanceof Date) return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())).toISOString().slice(0, 10);
  if (typeof value === "number" && value > 20_000 && value < 80_000) return new Date(Date.UTC(1899, 11, 30) + value * DAY).toISOString().slice(0, 10);
  const matched = String(value ?? "").match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
  return matched ? `${matched[1]}-${matched[2].padStart(2, "0")}-${matched[3].padStart(2, "0")}` : "";
};

function blankEmployee(year: number, month: number): Employee {
  return { id: crypto.randomUUID(), name: "", department: "", title: "", birthDate: "", joinDate: `${year}-${String(month).padStart(2, "0")}-01`, leaveDate: "", probationMonths: 0, annualSalary: 0, basePay: 0, manualBasic: false, meal: 200_000, car: 0, child: 0, monthly: {} };
}

const calculatePay = calculateCompensation;

function findHeader(rows: ImportedCell[][]) {
  return rows.findIndex((row) => {
    const headers = row.map(normalize);
    return headers.includes("연봉") && (headers.includes("성명") || headers.includes("이름"));
  });
}

function findColumn(headers: ImportedCell[], aliases: string[]) {
  const normalized = headers.map(normalize);
  return normalized.findIndex((header) => aliases.some((alias) => normalize(alias) === header));
}

function parseRoster(rows: ImportedCell[][], year: number, month: number) {
  const headerIndex = findHeader(rows);
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex];
  const col = {
    name: findColumn(headers, ["성명", "이름"]), department: findColumn(headers, ["부서"]), title: findColumn(headers, ["직책", "직위"]),
    birthDate: findColumn(headers, ["생년월일", "생일"]), joinDate: findColumn(headers, ["입사일", "입사"]), leaveDate: findColumn(headers, ["퇴사일", "퇴사"]),
    probation: findColumn(headers, ["수습 90%적용", "수습90%", "수습"]), salary: findColumn(headers, ["연봉"]), basic: findColumn(headers, ["기본급"]),
    meal: findColumn(headers, ["식대"]), car: findColumn(headers, ["자가운전보조금", "자차운전보조금", "자가운전", "자차"]), child: findColumn(headers, ["육아수당", "육아"]),
    incentive: findColumn(headers, ["인센티브", "인센"]), bonus: findColumn(headers, ["상여금", "상여"]), extra: findColumn(headers, ["추가수당"]), research: findColumn(headers, ["연구수당"]), severance: findColumn(headers, ["퇴직금"]), welfare: findColumn(headers, ["복지기금"]), note: findColumn(headers, ["비고"]),
  };
  const get = (row: ImportedCell[], key: keyof typeof col) => col[key] >= 0 ? row[col[key]] : null;
  const result: Employee[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const name = String(get(row, "name") ?? "").trim();
    if (!name || /합계|소계|일용직|프리랜서/.test(name)) break;
    const annualSalary = numberValue(get(row, "salary"));
    const basic = numberValue(get(row, "basic"));
    const probationValue = get(row, "probation");
    const monthly: Record<string, MonthlyPay> = {};
    const current = { incentive: numberValue(get(row, "incentive")), bonus: numberValue(get(row, "bonus")), extra: numberValue(get(row, "extra")), research: numberValue(get(row, "research")), severance: numberValue(get(row, "severance")), welfare: numberValue(get(row, "welfare")), note: String(get(row, "note") ?? "") };
    if (Object.values(current).some(Boolean)) monthly[monthKey(year, month)] = current;
    result.push({ id: crypto.randomUUID(), name, department: String(get(row, "department") ?? "").trim(), title: String(get(row, "title") ?? "").trim(), birthDate: dateString(get(row, "birthDate")), joinDate: dateString(get(row, "joinDate")), leaveDate: dateString(get(row, "leaveDate")), probationMonths: probationValue === true || /90|true/i.test(String(probationValue ?? "")) ? 3 : 0, annualSalary, basePay: basic, manualBasic: annualSalary <= 0 && basic > 0, meal: numberValue(get(row, "meal")) || (annualSalary ? 200_000 : 0), car: numberValue(get(row, "car")), child: numberValue(get(row, "child")), monthly });
  }
  return result;
}

function WageCalculator() {
  const ready = useClientReady();
  return ready ? <WageCalculatorClient /> : <p role="status">임금 계산을 불러오는 중입니다.</p>;
}

function WageCalculatorClient() {
  const [preferences] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Partial<CompensationSettings> & { columnWidths?: Record<string, number>; hiddenColumns?: string[] };
    }
    catch { return {}; }
  });
  const dialog = useErpDialog();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [rounding, setRounding] = useState<Rounding>(preferences.rounding ?? "round");
  const [employees, setEmployees] = useState<Employee[]>([]);
  // 공제는 없는 달이 더 많아 기본은 꺼 둔다. 필요할 때 "수당·표시 항목"에서 켜면 두 열이 생긴다.
  const [columns, setColumns] = useState({ research: true, extra: true, welfare: false, severance: true, deduction: false, annualLeave: false, personalExpense: false, ...preferences.columns });
  const [standards, setStandards] = useState({ meal: 200_000, car: 200_000, child: 200_000, ...preferences.standards });
  const [message, setMessage] = useState("직원 명부를 불러오거나 첫 직원을 추가해 주세요.");
  // HR 인사기록에서 표에 없는 인원만 골라 붙이는 선택창. 기존 행은 건드리지 않는다 —
  // 「HR 기본값 불러오기」(LOAD_HR)는 명단을 통째로 다시 만들어 손본 값이 사라지므로, 중도 입사자 한 명을 더할 때는 이쪽을 쓴다.
  const [hrPicker, setHrPicker] = useState<{ candidates: Employee[]; selected: string[] } | null>(null);
  const [hrPickerLoading, setHrPickerLoading] = useState(false);
  // 식대 금액을 눌러 수기 입력으로 바꾼 직원. 새로 뜬 입력칸에 커서를 자동으로 두기 위한 표시다 —
  // 저장된 수기값으로 화면이 처음 그려질 때는 포커스를 가로채지 않는다.
  const [mealEditingId, setMealEditingId] = useState<string | null>(null);
  const hydrated = true;
  const [run, setRun] = useState<{ status: "DRAFT" | "CONFIRMED"; version: number; employeeCount: number; grossPay: number; confirmedAt: number | null; updatedAt?: number | null; employees: Employee[]; settings?: CompensationSettings } | null>(null);
  const [actionSaving, setSaving] = useState(false);
  const [loadedPeriod, setLoadedPeriod] = useState<string | null>(null);
  const saving = actionSaving || loadedPeriod !== monthKey(year, month);
  const [autoSaving, setAutoSaving] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [exporting, setExporting] = useState<"month" | "year" | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({ ...DEFAULT_COLUMN_WIDTHS, ...preferences.columnWidths });
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(Array.isArray(preferences.hiddenColumns) ? preferences.hiddenColumns.filter(value => typeof value === "string") : []);
  const [sort, setSort] = useState<WageSortState | null>(null);
  const lastSavedEmployeesRef = useRef("");
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rosterRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify({ columns, standards, rounding, columnWidths, hiddenColumns })); }, [columns, standards, rounding, columnWidths, hiddenColumns, hydrated]);

  const key = monthKey(year, month);
  const currentSettings = useEffectEvent(() => ({ rounding, columns, standards }));
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/hr/compensation?period=${key}`).then(async (response) => {
      const payload = await response.json() as { run?: typeof run; error?: string };
      if (!response.ok) throw new Error(payload.error || "임금안을 불러오지 못했습니다.");
      if (cancelled) return;
      setRun(payload.run ?? null);
      const restoredEmployees = payload.run?.employees ?? [];
      const restoredSettings = payload.run?.settings;
      setEmployees(restoredEmployees);
      if (restoredSettings) {
        setRounding(restoredSettings.rounding);
        setColumns((current) => ({ ...current, ...restoredSettings.columns }));
        setStandards(restoredSettings.standards);
      }
      // HR 퇴직 정산에서 공제를 밀어 넣었는데 공제 열이 꺼져 있으면 값이 있는지도 모른 채 확정하게 된다.
      // 불러온 임금안에 공제가 들어 있으면 열을 자동으로 켜고 숨김 목록에서도 빼 준다.
      const hasDeduction = restoredEmployees.some((employee) => {
        const monthly = employee.monthly?.[key];
        return Number(monthly?.deduction ?? 0) > 0 || String(monthly?.deductionNote ?? "").trim() !== "";
      });
      if (hasDeduction) {
        setColumns((current) => (current.deduction ? current : { ...current, deduction: true }));
        setHiddenColumns((current) => current.filter((value) => value !== "deduction" && value !== "deductionNote"));
      }
      // 연차수당도 같다. 퇴직 정산에서 밀어 넣은 값이 꺼진 열 뒤에 숨어 있으면 안 된다.
      const hasAnnualLeave = restoredEmployees.some((employee) => Number(employee.monthly?.[key]?.annualLeave ?? 0) !== 0);
      const hasReceiptRetirementPay = restoredEmployees.some((employee) => Boolean(employee.monthly?.[key]?.retirementPaySource));
      if (hasReceiptRetirementPay) {
        setColumns((current) => current.severance ? current : { ...current, severance: true });
        setHiddenColumns((current) => current.filter((value) => value !== "severance"));
      }
      if (hasAnnualLeave) {
        setColumns((current) => (current.annualLeave ? current : { ...current, annualLeave: true }));
        setHiddenColumns((current) => current.filter((value) => value !== "annualLeave"));
      }
      // 개인비용지급도 마찬가지다. 값이 있는데 열이 꺼져 있으면 그 금액이 지급총액에만 잡히고
      // 어디서 왔는지 보이지 않는다.
      const hasPersonalExpense = restoredEmployees.some((employee) => {
        const monthly = employee.monthly?.[key];
        return Number(monthly?.personalExpense ?? 0) !== 0 || String(monthly?.personalExpenseNote ?? "").trim() !== "";
      });
      if (hasPersonalExpense) {
        setColumns((current) => (current.personalExpense ? current : { ...current, personalExpense: true }));
        setHiddenColumns((current) => current.filter((value) => value !== "personalExpense" && value !== "personalExpenseNote"));
      }
      lastSavedEmployeesRef.current = payload.run ? draftSignature(restoredEmployees, restoredSettings ?? currentSettings()) : "";
      setDraftDirty(false);
      setMessage(payload.run ? `${key} 임금안을 불러왔습니다.` : "급여 작성을 누르면 선택한 월의 HR 인사기록을 불러옵니다.");
    }).catch((error: Error) => { if (!cancelled) { setRun(null); setEmployees([]); setMessage(error.message); } }).finally(() => { if (!cancelled) setLoadedPeriod(key); });
    return () => { cancelled = true; };
  }, [key]);
  const rows = useMemo(() => employees.map((employee) => calculatePay(employee, year, month, rounding, columns)), [employees, year, month, rounding, columns]);
  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const value = (row: (typeof rows)[number]) => sort.key === "employee" ? row.employee.name : sort.key === "department" ? row.employee.department : row.employee.joinDate;
    return rows.map((row, index) => ({ row, index })).sort((left, right) => {
      const leftValue = value(left.row).trim();
      const rightValue = value(right.row).trim();
      if (!leftValue && !rightValue) return left.index - right.index;
      if (!leftValue) return 1;
      if (!rightValue) return -1;
      const compared = leftValue.localeCompare(rightValue, "ko-KR", { numeric: true, sensitivity: "base" });
      return compared === 0 ? left.index - right.index : sort.direction === "asc" ? compared : -compared;
    }).map(({ row }) => row);
  }, [rows, sort]);
  const totals = useMemo(() => rows.reduce((sum, row) => ({ people: sum.people + (row.days ? 1 : 0), basic: sum.basic + row.basic, allowances: sum.allowances + row.meal + row.car + row.child, variable: sum.variable + row.incentive + row.bonus + row.extra + row.research + row.severance, total: sum.total + row.total }), { people: 0, basic: 0, allowances: 0, variable: 0, total: 0 }), [rows]);
  const alerts = useMemo(() => ({ noJoin: rows.filter((row) => row.probationWithoutJoin), probationOver: rows.filter((row) => row.probationOver), partial: rows.filter((row) => row.days > 0 && row.days < row.daysInMonth), mixed: rows.filter((row) => row.mixedProbation), zero: rows.filter((row) => row.days === 0) }), [rows]);
  const departments = useMemo(() => Array.from(new Set(employees.map((employee) => employee.department).filter(Boolean))).sort(), [employees]);
  const titles = useMemo(() => Array.from(new Set(employees.map((employee) => employee.title).filter(Boolean))).sort(), [employees]);
  const hiddenColumnSet = useMemo(() => new Set(hiddenColumns), [hiddenColumns]);
  const isColumnVisible = (column: string) => !hiddenColumnSet.has(column);
  const tableColumns = useMemo(() => [
    { key: "employee", label: "직원" }, { key: "department", label: "부서" }, { key: "title", label: "직책" },
    { key: "joinDate", label: "입사일" }, { key: "leaveDate", label: "퇴사일" }, { key: "days", label: "근무일" },
    { key: "probation", label: "수습" }, { key: "annualSalary", label: "연봉" }, { key: "basic", label: "기본급" },
    { key: "meal", label: "식대" }, { key: "car", label: "자가운전" }, { key: "child", label: "육아" },
    { key: "incentive", label: "인센티브" }, { key: "bonus", label: "상여금" },
    ...(columns.extra ? [{ key: "extra", label: "추가수당" }] : []),
    ...(columns.research ? [{ key: "research", label: "연구수당" }] : []),
    ...(columns.annualLeave ? [{ key: "annualLeave", label: "연차수당" }] : []),
    ...(columns.personalExpense ? [{ key: "personalExpense", label: "개인비용지급" }, { key: "personalExpenseNote", label: "개인비용 사유" }] : []),
    ...(columns.severance ? [{ key: "severance", label: "퇴직금" }] : []),
    ...(columns.deduction ? [{ key: "deduction", label: "공제" }, { key: "deductionNote", label: "공제 사유" }] : []),
    { key: "total", label: "지급총액" }, ...(columns.welfare ? [{ key: "welfare", label: "복지기금" }] : []),
    { key: "note", label: "비고" }, { key: "action", label: "" },
  ].filter((column) => !hiddenColumnSet.has(column.key)), [columns, hiddenColumnSet]);
  // 직원·부서·직책은 가로 스크롤에도 왼쪽에 붙어 있게 한다. 열 너비를 드래그로 바꿀 수 있어
  // CSS 에 고정값을 둘 수 없고, 숨긴 열은 건너뛰어야 해서 여기서 누적 위치를 계산한다.
  const stickyLeft = useMemo(() => {
    const offsets: Record<string, number> = {};
    let accumulated = 0;
    for (const key of ["employee", "department", "title"]) {
      if (hiddenColumnSet.has(key)) continue;
      offsets[key] = accumulated;
      accumulated += columnWidths[key] ?? DEFAULT_COLUMN_WIDTHS[key];
    }
    return offsets;
  }, [columnWidths, hiddenColumnSet]);
  const lastStickyKey = useMemo(() => {
    const keys = Object.keys(stickyLeft);
    return keys.length ? keys[keys.length - 1] : "";
  }, [stickyLeft]);
  const stickyProps = (key: string) => (key in stickyLeft
    ? { className: `sticky-col${key === lastStickyKey ? " sticky-col-last" : ""}`, style: { left: stickyLeft[key] } }
    : {});

  const tableWidth = useMemo(() => tableColumns.reduce((sum, column) => sum + (columnWidths[column.key] ?? DEFAULT_COLUMN_WIDTHS[column.key]), 0), [tableColumns, columnWidths]);

  function beginColumnResize(event: ReactPointerEvent<HTMLButtonElement>, key: string) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = columnWidths[key] ?? DEFAULT_COLUMN_WIDTHS[key];
    const handleMove = (moveEvent: PointerEvent) => setColumnWidths((current) => ({ ...current, [key]: Math.max(54, Math.min(320, startWidth + moveEvent.clientX - startX)) }));
    const handleUp = () => { window.removeEventListener("pointermove", handleMove); window.removeEventListener("pointerup", handleUp); };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }
  function toggleSort(key: WageSortKey) {
    setSort((current) => current?.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" });
  }

  useEffect(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    if (!run || run.status !== "DRAFT" || saving || autoSaving) return;
    const settings = { rounding, columns, standards };
    const signature = draftSignature(employees, settings);
    if (signature === lastSavedEmployeesRef.current) { setDraftDirty(false); return; }
    setDraftDirty(true);
    const employeeSnapshot = employees;
    const version = run.version;
    autoSaveTimerRef.current = setTimeout(async () => {
      setAutoSaving(true);
      try {
        const calculated = employeeSnapshot.map((employee) => calculatePay(employee, year, month, rounding, columns));
        const response = await fetch("/api/hr/compensation", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "SAVE", period: key, version, employees: employeeSnapshot, settings,
            rows: calculated.map((row) => ({
              employeeId: row.employee.id, basic: row.basic, meal: row.meal, car: row.car, child: row.child,
              incentive: row.incentive, bonus: row.bonus, extra: row.extra, research: row.research,
              severance: row.severance, annualLeave: row.annualLeave, personalExpense: row.personalExpense,
              personalExpenseNote: String(row.employee.monthly[key]?.personalExpenseNote ?? ""),
              welfare: row.welfare, deduction: row.deduction,
              deductionNote: String(row.employee.monthly[key]?.deductionNote ?? ""), total: row.total,
            })),
          }),
        });
        const payload = await response.json() as { run?: typeof run; error?: string };
        if (!response.ok || !payload.run) throw new Error(payload.error || "임금안 자동 저장에 실패했습니다.");
        setRun(payload.run);
        if (signature === draftSignature(employees, settings)) {
          lastSavedEmployeesRef.current = signature;
          setDraftDirty(false);
        }
        setMessage("변경된 임금안이 서버에 자동 저장되었습니다.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "임금안 자동 저장에 실패했습니다.");
      } finally { setAutoSaving(false); }
    }, 900);
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [employees, run, saving, autoSaving, year, month, rounding, columns, standards, key]);

  const createDraft = useEffectEvent(() => { void compensationAction("CREATE"); });
  useEffect(() => {
    if (!hydrated || run || saving || autoSaving || !employees.length || employees.some((employee) => !employee.name.trim())) return;
    const timer = window.setTimeout(() => { createDraft(); }, 500);
    return () => window.clearTimeout(timer);
  }, [employees, hydrated, run, saving, autoSaving, key]);

  function updateEmployee(id: string, patch: Partial<Employee>) { setEmployees((current) => current.map((employee) => employee.id === id ? { ...employee, ...patch } : employee)); }
  function updateMonthly(id: string, field: keyof MonthlyPay, value: string | number) {
    setEmployees((current) => current.map((employee) => employee.id === id ? { ...employee, monthly: { ...employee.monthly, [key]: { ...employee.monthly[key], [field]: value } } } : employee));
  }
  // 그 달의 월별 입력값 하나를 지운다 — 수기 식대를 자동 계산으로 되돌릴 때 쓴다(0을 넣는 것과 다르다).
  function clearMonthly(id: string, field: keyof MonthlyPay) {
    setEmployees((current) => current.map((employee) => {
      if (employee.id !== id) return employee;
      const rest = { ...employee.monthly[key] }; delete rest[field];
      return { ...employee, monthly: { ...employee.monthly, [key]: rest } };
    }));
  }
  function setAllowance(id: string, field: "meal" | "car" | "child", enabled: boolean) {
    updateEmployee(id, { [field]: enabled ? standards[field] : 0 } as Partial<Employee>);
  }
  function addEmployee() { setEmployees((current) => [...current, blankEmployee(year, month)]); setMessage("직원을 추가했습니다. 이름과 연봉을 입력해 주세요."); }
  function alreadyListed(candidate: Employee, current: Employee[]) {
    // 사번이 같으면 같은 사람. 손으로 적어 사번이 임의값인 행은 이름·입사일이 같을 때 같은 사람으로 본다.
    return current.some((employee) => employee.id === candidate.id
      || (employee.name.trim() === candidate.name.trim() && employee.joinDate === candidate.joinDate));
  }
  async function openHrPicker() {
    if (run?.status === "CONFIRMED") { setMessage("확정된 임금안은 수정하기를 먼저 눌러 주세요."); return; }
    setHrPickerLoading(true);
    try {
      const response = await fetch(`/api/hr/compensation?period=${key}&include=hr`, { cache: "no-store" });
      const payload = await response.json() as { hrEmployees?: Employee[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "HR 인사기록을 불러오지 못했습니다.");
      const candidates = (payload.hrEmployees ?? []).filter((candidate) => !alreadyListed(candidate, employees))
        .sort((a, b) => b.joinDate.localeCompare(a.joinDate));
      if (!candidates.length) { setMessage(`${key} 급여 대상 중 표에 없는 인원이 없습니다.`); return; }
      setHrPicker({ candidates, selected: candidates.map((candidate) => candidate.id) });
    } catch (error) { setMessage(error instanceof Error ? error.message : "HR 인사기록을 불러오지 못했습니다."); }
    finally { setHrPickerLoading(false); }
  }
  function addFromHr() {
    if (!hrPicker) return;
    const picked = hrPicker.candidates.filter((candidate) => hrPicker.selected.includes(candidate.id));
    // 기존 행은 그대로 두고 뒤에만 붙인다. 이 달의 월별 입력값은 비워 두어 사용자가 채운다.
    setEmployees((current) => [...current, ...picked.filter((candidate) => !alreadyListed(candidate, current)).map((candidate) => ({ ...candidate, monthly: {} }))]);
    setHrPicker(null);
    setMessage(`HR 인사기록에서 ${picked.length}명을 표 아래에 추가했습니다. 기존 인원의 값은 그대로입니다.`);
  }
  function loadExample() {
    setEmployees([
      { ...blankEmployee(year, month), id: crypto.randomUUID(), name: "김민성", department: "영업팀", title: "팀장", birthDate: "1988-04-12", joinDate: "2024-03-11", annualSalary: 60_000_000, meal: 200_000, car: 200_000, child: 200_000 },
      { ...blankEmployee(year, month), id: crypto.randomUUID(), name: "이서윤", department: "경영지원팀", title: "대리", birthDate: "1994-07-03", joinDate: `${year}-${String(month).padStart(2, "0")}-15`, annualSalary: 39_000_000, meal: 200_000, car: 0, child: 0 },
      { ...blankEmployee(year, month), id: crypto.randomUUID(), name: "정윤수", department: "기술팀", title: "사원", birthDate: "1998-01-21", joinDate: `${year}-${String(Math.max(1, month - 1)).padStart(2, "0")}-06`, probationMonths: 3, annualSalary: 30_000_000, meal: 200_000, car: 0, child: 0 },
    ]);
    setMessage("예시 명부 3명을 불러왔습니다.");
  }
  async function importRoster(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const sheets = await readXlsxFile(file);
      let parsed: Employee[] = [];
      let selectedSheet = "";
      for (const sheet of sheets) {
        parsed = parseRoster(sheet.data as ImportedCell[][], year, month);
        if (parsed.length) { selectedSheet = sheet.sheet; break; }
      }
      if (!parsed.length) throw new Error("연봉·성명 열이 있는 급여 표를 찾지 못했습니다.");
      setEmployees(parsed); setMessage(`${selectedSheet}에서 직원 ${parsed.length}명을 불러왔습니다.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "명부를 읽지 못했습니다."); }
    event.target.value = "";
  }
  function downloadRoster() {
    const blob = new Blob([JSON.stringify({ version: 1, savedAt: new Date().toISOString(), employees, columns, standards }, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `XD_NODE_임금명부_${key}.json`; anchor.click(); URL.revokeObjectURL(url);
    setMessage("명부와 월별 입력값을 저장했습니다.");
  }
  function loadRoster(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { try { const data = JSON.parse(String(reader.result)); if (!Array.isArray(data.employees)) throw new Error("명부 형식이 아닙니다."); setEmployees(data.employees); if (data.columns) setColumns((current) => ({ ...current, ...data.columns })); if (data.standards) setStandards(data.standards); setMessage(`명부 ${data.employees.length}명을 불러왔습니다.`); } catch (error) { setMessage(error instanceof Error ? error.message : "명부 파일을 읽지 못했습니다."); } };
    reader.readAsText(file); event.target.value = "";
  }
  function importIncentive() {
    try {
      const savedResult = JSON.parse(localStorage.getItem("xdnode-incentive-payroll-v1") || "null") as { summaries?: Array<{ personId?: string; payroll: number }> } | null;
      if (Array.isArray(savedResult?.summaries)) {
        const byPersonId = new Map(savedResult.summaries.filter((item) => item.personId).map((item) => [item.personId as string, numberValue(item.payroll)]));
        const unresolvedCount = savedResult.summaries.filter((item) => !item.personId).length;
        let matched = 0;
        setEmployees((current) => current.map((employee) => {
          const payroll = byPersonId.get(employee.id);
          if (payroll === undefined) return employee;
          matched++;
          return { ...employee, monthly: { ...employee.monthly, [key]: { ...employee.monthly[key], incentive: Math.round(payroll) } } };
        }));
        setMessage(matched
          ? `확정된 인센티브 결과를 ${matched}명의 ${key} 급여에 반영했습니다.${unresolvedCount ? ` (담당자 미확인 ${unresolvedCount}명은 인센티브 계산기에서 먼저 직원을 지정해 주세요.)` : ""}`
          : "직원 ID가 일치하는 인센티브 결과를 찾지 못했습니다. 인센티브 계산기에서 담당자를 직원으로 지정했는지 확인해 주세요.");
        return;
      }
      const deals = JSON.parse(localStorage.getItem("xdnode-incentive-deals-v1") || "[]") as Array<{ personId?: string; quantity: number; unitCost: number; unitSale: number; expense: number; excluded: boolean }>;
      const adjustments = JSON.parse(localStorage.getItem("xdnode-incentive-adjustments-v1") || "[]") as Array<{ personId?: string; kind: string; amount: number }>;
      const byPersonId = new Map<string, number>();
      for (const deal of deals) { if (!deal.personId) continue; const sales = deal.quantity * deal.unitSale; const margin = sales - deal.quantity * deal.unitCost - deal.expense; const incentive = deal.excluded ? 0 : Math.max((margin - sales * 0.05) * 0.05, 0); byPersonId.set(deal.personId, (byPersonId.get(deal.personId) ?? 0) + incentive); }
      for (const adjustment of adjustments) { if (!adjustment.personId) continue; const sign = adjustment.kind === "추가지급" ? 1 : adjustment.kind === "차감" || adjustment.kind === "복지기금 전환" ? -1 : 0; byPersonId.set(adjustment.personId, Math.max(0, (byPersonId.get(adjustment.personId) ?? 0) + adjustment.amount * sign)); }
      let matched = 0;
      setEmployees((current) => current.map((employee) => { const payroll = byPersonId.get(employee.id); if (payroll === undefined) return employee; matched++; return { ...employee, monthly: { ...employee.monthly, [key]: { ...employee.monthly[key], incentive: Math.round(payroll) } } }; }));
      setMessage(matched ? `인센티브 계산 결과를 ${matched}명의 ${key} 급여에 반영했습니다.` : "직원 ID가 일치하는 인센티브 결과를 찾지 못했습니다. 인센티브 계산기에서 담당자를 직원으로 지정했는지 확인해 주세요.");
    } catch { setMessage("저장된 인센티브 계산 결과를 읽지 못했습니다."); }
  }
  function copyPreviousMonth() {
    const previousDate = new Date(year, month - 2, 1);
    const previousKey = monthKey(previousDate.getFullYear(), previousDate.getMonth() + 1);
    let copied = 0;
    setEmployees((current) => current.map((employee) => {
      const previous = employee.monthly[previousKey];
      if (!previous) return employee;
      copied++;
      return { ...employee, monthly: { ...employee.monthly, [key]: { ...previous, ...employee.monthly[key] } } };
    }));
    setMessage(copied ? `${previousKey}의 월별 수당·메모를 ${copied}명에게 이어받았습니다.` : `${previousKey}에 저장된 월별 값이 없습니다.`);
  }
  const apiRows = () => rows.map((row) => ({
    employeeId: row.employee.id, basic: row.basic, meal: row.meal, car: row.car, child: row.child,
    incentive: row.incentive, bonus: row.bonus, extra: row.extra, research: row.research,
    severance: row.severance, annualLeave: row.annualLeave, personalExpense: row.personalExpense,
    personalExpenseNote: String(row.employee.monthly[key]?.personalExpenseNote ?? ""),
    welfare: row.welfare, deduction: row.deduction,
    deductionNote: String(row.employee.monthly[key]?.deductionNote ?? ""), total: row.total,
  }));
  async function compensationAction(action: "CREATE" | "LOAD_HR" | "SAVE" | "CONFIRM" | "REOPEN") {
    setSaving(true);
    try {
      const requestAction = async (targetAction: "CREATE" | "LOAD_HR" | "SAVE" | "CONFIRM" | "REOPEN", version?: number) => {
        const response = await fetch("/api/hr/compensation", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: targetAction, period: key, version, employees, rows: apiRows(), settings: { rounding, columns, standards } }),
        });
        const payload = await response.json() as { run?: typeof run; error?: string; reused?: boolean };
        if (!response.ok || !payload.run) throw new Error(payload.error || "임금안을 처리하지 못했습니다.");
        return { ...payload, run: payload.run };
      };
      const runOnce = () => requestAction(action === "CONFIRM" && !run ? "CREATE" : action, run?.version);
      // 급여월이 검토·승인·마감 상태면 서버가 409 로 막는다. 잠금 해제는 HR 급여관리(승인 권한·사유 기록)에서만 하고
      // 여기서는 그 안내만 보여 준다 — 예전에는 prompt 하나로 잠금을 풀어 통제를 우회했다.
      let payload = await runOnce();
      if (action === "CONFIRM" && !run) payload = await requestAction("CONFIRM", payload.run?.version);
      setRun(payload.run);
      setEmployees(payload.run.employees ?? employees);
      lastSavedEmployeesRef.current = draftSignature(payload.run.employees ?? employees, payload.run.settings ?? { rounding, columns, standards });
      setDraftDirty(false);
      setMessage(action === "CREATE" ? `임금 대상 ${payload.run.employeeCount}명의 초안을 서버에 저장했습니다.` : action === "LOAD_HR" ? `${key} 급여 대상 ${payload.run.employeeCount}명을 HR 인사기록에서 불러왔습니다.` : action === "SAVE" ? "임금안 초안을 서버에 저장했습니다." : action === "CONFIRM" ? "임금안을 확정해 HR 급여관리에 덮어썼습니다." : "임금안을 다시 수정할 수 있습니다.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "임금안을 처리하지 못했습니다."); }
    finally { setSaving(false); }
  }
  async function loadPayrollFromHr() {
    if (run?.status === "CONFIRMED") {
      setMessage("확정된 급여는 하단의 수정하기를 먼저 눌러 주세요.");
      return;
    }
    if (run && !(await dialog.confirm(`${key} 작성 중인 초안을 HR 인사기록 기준으로 다시 작성할까요?\n현재 입력한 월별 수당과 메모는 초기화됩니다.`, { title: "HR 기준으로 다시 작성", confirmLabel: "다시 작성" }))) return;
    void compensationAction("LOAD_HR");
  }
  // 엑셀은 화면 표와 같은 열을 담아야 한다. 헤더 배열과 값 배열을 따로 두면 열을 하나 추가할 때
  // 한쪽만 고쳐져 어긋난다(실제로 개인비용지급이 그렇게 빠졌다). 그래서 열마다 이름과 값을
  // 한 묶음으로 적고, 화면과 같은 조건 두 가지로 한 번에 걸러 낸다.
  //   1) 수당·표시 항목 체크(columns) — 꺼진 항목은 계산에서도 빠진다
  //   2) 표시할 열 선택(hiddenColumns) — 화면에서 숨긴 열은 엑셀에서도 뺀다
  type WageRow = ReturnType<typeof calculatePay>;
  function sheetData(targetYear: number, targetMonth: number, sourceEmployees = employees, sourceRounding = rounding, sourceColumns = columns, includeAllColumns = false): SheetData {
    const targetKey = monthKey(targetYear, targetMonth);
    const calculated = sourceEmployees.map((employee) => calculatePay(employee, targetYear, targetMonth, sourceRounding, sourceColumns));
    type SheetColumn = { key: string; label: string; money?: boolean; value: (row: WageRow, monthly: MonthlyPay) => string | number };
    const sheetColumns: SheetColumn[] = [
      { key: "name", label: "성명", value: (row) => row.employee.name },
      { key: "department", label: "부서", value: (row) => row.employee.department },
      { key: "title", label: "직책", value: (row) => row.employee.title },
      { key: "birthDate", label: "생년월일", value: (row) => row.employee.birthDate },
      { key: "joinDate", label: "입사일", value: (row) => row.employee.joinDate },
      { key: "leaveDate", label: "퇴사일", value: (row) => row.employee.leaveDate },
      { key: "days", label: "근무일", value: (row) => row.days },
      { key: "probation", label: "첫 계약·수습(월)", value: (row) => row.employee.probationRate !== undefined ? `${row.employee.probationMonths} (${Math.round(row.employee.probationRate * 100)}%)` : row.employee.probationMonths },
      { key: "annualSalary", label: "연봉", money: true, value: (row) => row.employee.annualSalary },
      { key: "basic", label: "기본급", money: true, value: (row) => row.basic },
      { key: "meal", label: "식대", money: true, value: (row) => row.meal },
      { key: "car", label: "자가운전보조금", money: true, value: (row) => row.car },
      { key: "child", label: "육아수당", money: true, value: (row) => row.child },
      { key: "incentive", label: "인센티브", money: true, value: (row) => row.incentive },
      { key: "bonus", label: "상여금", money: true, value: (row) => row.bonus },
      ...(sourceColumns.extra ? [{ key: "extra", label: "추가수당", money: true, value: (row: WageRow) => row.extra }] : []),
      ...(sourceColumns.research ? [{ key: "research", label: "연구수당", money: true, value: (row: WageRow) => row.research }] : []),
      ...(sourceColumns.annualLeave ? [{ key: "annualLeave", label: "연차수당", money: true, value: (row: WageRow) => row.annualLeave }] : []),
      ...(sourceColumns.personalExpense ? [
        { key: "personalExpense", label: "개인비용지급", money: true, value: (row: WageRow) => row.personalExpense },
        { key: "personalExpenseNote", label: "개인비용 사유", value: (_row: WageRow, monthly: MonthlyPay) => monthly.personalExpenseNote ?? "" },
      ] : []),
      ...(sourceColumns.severance ? [{ key: "severance", label: "퇴직금", money: true, value: (row: WageRow) => row.severance }] : []),
      ...(sourceColumns.deduction ? [
        { key: "deduction", label: "공제", money: true, value: (row: WageRow) => row.deduction },
        { key: "deductionNote", label: "공제 사유", value: (_row: WageRow, monthly: MonthlyPay) => monthly.deductionNote ?? "" },
      ] : []),
      { key: "total", label: "지급총액", money: true, value: (row) => row.total },
      ...(sourceColumns.welfare ? [
        { key: "welfare", label: "복지기금", money: true, value: (row: WageRow) => row.welfare },
        { key: "welfareNote", label: "복지기금 내역", value: (_row: WageRow, monthly: MonthlyPay) => monthly.welfareNote ?? "" },
      ] : []),
      { key: "note", label: "비고", value: (_row, monthly) => monthly.note ?? "" },
    ];
    // 복지기금 내역은 화면에 없는 엑셀 전용 칸이라, 복지기금 열을 숨겼을 때만 같이 뺀다.
    const visible = sheetColumns.filter((column) => includeAllColumns || !hiddenColumnSet.has(column.key === "welfareNote" ? "welfare" : column.key));
    return [
      [{ value: targetKey, fontWeight: "bold" }],
      visible.map((column) => ({ value: column.label, fontWeight: "bold", backgroundColor: "#F4F4F5" })),
      ...calculated.map((row) => {
        const monthly = row.employee.monthly[targetKey] ?? {};
        return visible.map((column) => {
          const value = column.value(row, monthly);
          return { value, format: column.money && typeof value === "number" ? "₩#,##0" : undefined };
        });
      }),
    ];
  }

  async function exportCurrent() {
    if (!employees.length) { setMessage("내보낼 명부가 없습니다."); return; }
    setExporting("month");
    try {
      await writeXlsxFile(sheetData(year, month), { sheet: key, stickyRowsCount: 2, showGridLines: true }).toFile(`XD_NODE_급여_${key}.xlsx`);
      setMessage(`${key} 급여 계산표를 저장했습니다.`);
    } catch { setMessage("현재 월 엑셀 파일을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."); }
    finally { setExporting(null); }
  }
  async function exportYear() {
    setExporting("year");
    try {
      const monthlyRuns = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
        const period = monthKey(year, index + 1);
        const response = await fetch(`/api/hr/compensation?period=${period}`);
        const payload = await response.json() as { run?: typeof run; error?: string };
        if (!response.ok) throw new Error(payload.error || `${period} 임금안을 불러오지 못했습니다.`);
        return { period, month: index + 1, run: payload.run };
      }));
      const sheets = monthlyRuns.flatMap((item) => item.run ? [{
        sheet: item.period,
        data: sheetData(year, item.month, item.run.employees, item.run.settings?.rounding ?? "round",
          item.run.settings?.columns ?? { research: true, extra: true, welfare: false, severance: true, deduction: false, annualLeave: false, personalExpense: false }, true),
        stickyRowsCount: 2, showGridLines: true,
      }] : []);
      if (!sheets.length) { setMessage(`${year}년에 저장된 임금안이 없습니다.`); return; }
      await writeXlsxFile(sheets).toFile(`XD_NODE_급여_${year}년_전체.xlsx`);
      setMessage(`${year}년 저장된 임금안 ${sheets.length}개월을 각 월의 명부·계산 기준으로 내려받았습니다. 미작성 월은 제외했습니다.`);
    } catch { setMessage("연간 엑셀 파일을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."); }
    finally { setExporting(null); }
  }

  const locked = run?.status === "CONFIRMED";
  if (loadedPeriod !== key) return <div className="compensation-page"><p role="status">{key} 임금안을 불러오는 중입니다.</p></div>;
  return <div className="compensation-page">
    <section data-korean-heading className="compensation-hero"><h1>임금과 인센티브를 한 흐름으로 계산합니다.</h1><p>매출 원장의 인센티브 결과를 직원별 월 급여에 이어 붙이고, 입·퇴사와 수습기간까지 반영합니다.</p></section>
    <div className={`wage-calculator${locked ? " locked" : ""}`}>
    <section className="compensation-toolbar panel">
      <div data-korean-heading><h2>대상 월과 계산 기준</h2><span>연봉에 비과세 수당이 포함된 회사 급여 기준으로 계산합니다.</span></div>
      <div className="wage-period-controls"><label>연도<input type="number" disabled={actionSaving || autoSaving || draftDirty} value={year} onChange={(event) => setYear(Number(event.target.value) || now.getFullYear())} /></label><label>월<select disabled={actionSaving || autoSaving || draftDirty} value={month} onChange={(event) => setMonth(Number(event.target.value))}>{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}월</option>)}</select></label><label>단수 처리<select disabled={locked} value={rounding} onChange={(event) => setRounding(event.target.value as Rounding)}><option value="round">반올림</option><option value="up">올림</option><option value="down">내림</option></select></label><div className="compensation-run-actions"><button className="confirm" disabled={saving || autoSaving || locked} type="button" onClick={loadPayrollFromHr}>{saving ? "불러오는 중…" : "급여 작성"}</button></div></div>
    </section>
    <section className="compensation-kpis">{[["지급 인원", `${totals.people}명`, `${rows.length}명 중`], ["기본급 합계", money(totals.basic), "365일법·첫 계약 지급률 반영"], ["비과세 수당", money(totals.allowances), "식대·자가운전·육아"], ["인센·상여 등", money(totals.variable), "월별 입력 항목"], ["지급총액", money(totals.total), `${key} 계산`]].map(([label, value, hint], index) => <article key={label} className={index === 4 ? "emphasis" : ""}><span>{label}</span><strong>{value}</strong><small>{hint}</small></article>)}</section>
    {run && <section className={`compensation-run-status ${locked ? "confirmed" : "draft"}`}><div><strong>{locked ? "확정된 임금안" : "작성 중인 임금안"}</strong><span>{locked ? "HR 급여관리에 반영됨 · 수정하기 후 재확정하면 기존 월 기록을 덮어씁니다." : autoSaving ? "변경내용을 서버에 자동 저장하고 있습니다." : draftDirty ? "변경내용을 잠시 후 서버에 자동 저장합니다." : "서버 저장 완료 · 새로고침하거나 다시 접속해도 이 초안이 유지됩니다."}</span></div></section>}
    <div className="compensation-editable">
    <fieldset className="compensation-editing-fields" disabled={locked || saving}>
    <section className="wage-setup-grid">
      <article className="panel wage-setup-card"><header><div data-korean-heading><h2>직원 명부</h2></div><span>{employees.length}명</span></header><div className="wage-actions"><button type="button" onClick={() => fileRef.current?.click()}>인건비 엑셀 불러오기</button><input ref={fileRef} hidden type="file" accept=".xlsx" onChange={importRoster} /><button type="button" onClick={addEmployee}>＋ 직원 추가</button><button type="button" onClick={openHrPicker} disabled={hrPickerLoading}>{hrPickerLoading ? "HR 확인 중…" : "HR에서 인원 추가"}</button><button type="button" onClick={copyPreviousMonth}>전월 값 이어받기</button><button type="button" onClick={loadExample}>예시 명부</button><button type="button" onClick={downloadRoster}>명부 저장</button><button type="button" onClick={() => rosterRef.current?.click()}>명부 불러오기</button><input ref={rosterRef} hidden type="file" accept=".json" onChange={loadRoster} /></div><p className="wage-message">{message}</p></article>
      {hrPicker && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHrPicker(null); }}>
        <section className="quick-modal hr-picker" role="dialog" aria-modal="true" aria-labelledby="hr-picker-title">
          <div className="modal-heading"><div data-korean-heading><h2 id="hr-picker-title">HR에서 인원 추가</h2></div><button type="button" aria-label="닫기" onClick={() => setHrPicker(null)}>×</button></div>
          <p className="wage-message">{key} 급여 대상 중 표에 없는 {hrPicker.candidates.length}명입니다. 추가할 인원만 체크하세요. 기존 행은 바뀌지 않습니다.</p>
          <ul className="hr-picker-list">{hrPicker.candidates.map((candidate) => <li key={candidate.id}><label>
            <input type="checkbox" checked={hrPicker.selected.includes(candidate.id)} onChange={(event) => setHrPicker((current) => current && ({ ...current, selected: event.target.checked ? [...current.selected, candidate.id] : current.selected.filter((id) => id !== candidate.id) }))} />
            <strong>{candidate.name}</strong><span>{candidate.department} · {candidate.title || "직책 미정"}</span><span>입사 {candidate.joinDate}</span><span>{candidate.annualSalary.toLocaleString("ko-KR")}원</span>
          </label></li>)}</ul>
          <div className="modal-actions"><button type="button" onClick={() => setHrPicker(null)}>취소</button><button type="button" className="primary-button" disabled={!hrPicker.selected.length} onClick={addFromHr}>선택 인원 추가 ({hrPicker.selected.length}명)</button></div>
        </section>
      </div>}
      <article className="panel wage-setup-card"><header><div data-korean-heading><h2>수당·표시 항목</h2></div></header><div className="allowance-standards">{(["meal", "car", "child"] as const).map((field) => <label key={field}>{field === "meal" ? "식대" : field === "car" ? "자가운전" : "육아"}<WonInput value={standards[field]} ariaLabel={`${field === "meal" ? "식대" : field === "car" ? "자가운전" : "육아"} 기준액`} onValueChange={(value) => { setStandards((current) => ({ ...current, [field]: value })); setEmployees((current) => current.map((employee) => employee[field] === standards[field] ? { ...employee, [field]: value } : employee)); }} /></label>)}</div><div className="column-toggles">{(["research", "extra", "annualLeave", "personalExpense", "welfare", "severance", "deduction"] as const).map((field) => <label key={field}><input type="checkbox" checked={columns[field]} onChange={(event) => setColumns((current) => ({ ...current, [field]: event.target.checked }))} />{field === "research" ? "연구수당" : field === "extra" ? "추가수당" : field === "annualLeave" ? "연차수당" : field === "personalExpense" ? "개인비용지급" : field === "welfare" ? "복지기금" : field === "severance" ? "퇴직금" : "공제"}</label>)}</div><details className="column-visibility"><summary>표시할 열 선택</summary><div>{COLUMN_VISIBILITY_OPTIONS.filter(([field]) => (["deduction", "deductionNote"] as string[]).includes(field) ? columns.deduction : (["personalExpense", "personalExpenseNote"] as string[]).includes(field) ? columns.personalExpense : !(["extra", "research", "severance", "welfare", "annualLeave"] as string[]).includes(field) || columns[field as keyof typeof columns]).map(([field, label]) => <label key={field}><input type="checkbox" checked={!hiddenColumnSet.has(field)} onChange={(event) => setHiddenColumns((current) => event.target.checked ? current.filter((value) => value !== field) : Array.from(new Set([...current, field])))} />{label}</label>)}</div></details><button type="button" className="incentive-pull" onClick={importIncentive}>저장된 인센티브 결과 가져오기</button></article>
    </section>
    {(alerts.noJoin.length > 0 || alerts.probationOver.length > 0 || alerts.partial.length > 0 || alerts.mixed.length > 0 || alerts.zero.length > 0) && <section className="wage-alerts">{alerts.noJoin.length > 0 && <div className="critical"><b>입사일 없는 수습 대상 {alerts.noJoin.length}명</b><span>{alerts.noJoin.map((row) => row.employee.name || "이름 미입력").join(" · ")} — 수습 90%가 적용되지 않습니다.</span></div>}{alerts.probationOver.length > 0 && <div><b>수습 종료 {alerts.probationOver.length}명</b><span>현재 월은 100% 계산됩니다. 과거 계산 보존을 위해 수습 개월 값은 유지하세요.</span></div>}{alerts.mixed.length > 0 && <div><b>수습 종료가 걸친 달 {alerts.mixed.length}명</b><span>수습 90% 구간과 정상 100% 구간을 나눠 일할계산했습니다.</span></div>}{alerts.partial.length > 0 && <div className="ok"><b>일할계산 {alerts.partial.length}명</b><span>{alerts.partial.map((row) => `${row.employee.name || "이름 미입력"} ${row.days}일`).join(" · ")}</span></div>}{alerts.zero.length > 0 && <div><b>근무일 0일 {alerts.zero.length}명</b><span>해당 월 재직기간이 없어 전 항목을 0원 처리했습니다.</span></div>}</section>}
    </fieldset>
    <section className="panel wage-table-panel"><header><div data-korean-heading><h2>{year}년 {month}월 임금 계산 결과</h2></div><div className="wage-table-hint"><span>열 제목 오른쪽 경계를 드래그해 너비를 조정할 수 있습니다.</span>
      {/* 화면을 열면 마지막으로 저장된 임금안이 그대로 뜬다. 그게 언제 것인지 여기서 밝힌다. */}
      <em className="wage-saved-at">{run?.updatedAt
        ? `마지막 저장 ${new Date(run.updatedAt).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })}`
        : "아직 저장된 임금안이 없습니다."}</em></div></header><fieldset className="wage-table-editable" disabled={locked || saving}><div className="wage-table-scroll"><table style={{ width: tableWidth }}><colgroup>{tableColumns.map((column) => <col key={column.key} style={{ width: columnWidths[column.key] ?? DEFAULT_COLUMN_WIDTHS[column.key] }} />)}</colgroup><thead><tr>{tableColumns.map((column) => { const sortable = (["employee", "department", "joinDate"] as string[]).includes(column.key); const activeSort = sort?.key === column.key ? sort : null; return <th key={column.key} {...stickyProps(column.key)} aria-sort={activeSort ? activeSort.direction === "asc" ? "ascending" : "descending" : sortable ? "none" : undefined}><div className="wage-column-heading"><span>{column.label}</span>{sortable && <button type="button" className={`column-sort${activeSort ? " active" : ""}`} onClick={() => toggleSort(column.key as WageSortKey)} aria-label={`${column.label} ${activeSort?.direction === "asc" ? "내림차순" : "오름차순"} 정렬`}>{activeSort?.direction === "asc" ? "↑" : activeSort?.direction === "desc" ? "↓" : "↕"}</button>}</div><button type="button" className="column-resizer" aria-label={`${column.label || "작업"} 열 너비 조절`} onPointerDown={(event) => beginColumnResize(event, column.key)} /></th>; })}</tr></thead><tbody>{sortedRows.map((row) => { const employee = row.employee; const monthly = employee.monthly[key] ?? {}; return <tr key={employee.id} className={row.days ? "" : "inactive"}><td {...stickyProps("employee")}><input aria-label="성명" value={employee.name} onChange={(event) => updateEmployee(employee.id, { name: event.target.value })} placeholder="성명" /></td>{isColumnVisible("department") && <td {...stickyProps("department")}><input list="wage-departments" aria-label="부서" value={employee.department} onChange={(event) => updateEmployee(employee.id, { department: event.target.value })} placeholder="부서" /></td>}{isColumnVisible("title") && <td {...stickyProps("title")}><input list="wage-titles" aria-label="직책" value={employee.title} onChange={(event) => updateEmployee(employee.id, { title: event.target.value })} placeholder="직책" /></td>}{isColumnVisible("joinDate") && <td><input type="date" aria-label="입사일" value={employee.joinDate} onChange={(event) => updateEmployee(employee.id, { joinDate: event.target.value })} /></td>}{isColumnVisible("leaveDate") && <td><input type="date" aria-label="퇴사일" value={employee.leaveDate} onChange={(event) => updateEmployee(employee.id, { leaveDate: event.target.value })} /></td>}{isColumnVisible("days") && <td className="calculated">{row.days}일</td>}{isColumnVisible("probation") && <td><select aria-label="수습 기간" value={employee.probationMonths} onChange={(event) => updateEmployee(employee.id, { probationMonths: Number(event.target.value) })}>{[0, 1, 2, 3, 6, 12].map((value) => <option key={value} value={value}>{value ? `${value}개월` : "—"}</option>)}</select>{employee.probationRate !== undefined && <small className="probation-rate" title="인사기록카드의 첫 계약 지급률">{Math.round(employee.probationRate * 100)}%</small>}</td>}{isColumnVisible("annualSalary") && <td><WonInput className="money-input" ariaLabel="연봉" value={employee.annualSalary} onValueChange={(value) => updateEmployee(employee.id, { annualSalary: value })} /></td>}{isColumnVisible("basic") && <td><div className="basic-cell">{employee.manualBasic ? <WonInput className="money-input" ariaLabel="기본급 직접 입력" value={Number(monthly.basic ?? employee.basePay ?? 0)} onValueChange={(value) => updateMonthly(employee.id, "basic", value)} /> : <b>{money(row.basic)}</b>}<label title="기본급 직접 입력"><input type="checkbox" checked={employee.manualBasic} onChange={(event) => { updateEmployee(employee.id, { manualBasic: event.target.checked }); if (event.target.checked && monthly.basic === undefined) updateMonthly(employee.id, "basic", employee.basePay || row.basic); }} />직접</label></div></td>}{(["meal", "car", "child"] as const).map((field) => isColumnVisible(field) && <td key={field}><div className={`allowance-cell${field === "meal" && monthly.meal !== undefined ? " manual" : ""}`}>{/* 식대는 기본 자동(일할) 계산이고, 금액을 누르면 그 달만 직접 입력한다. 「자동」을 누르면 되돌아간다. */}{field === "meal" ? (monthly.meal !== undefined ? <><WonInput className="money-input" ariaLabel="식대 직접 입력" focusOnEdit={mealEditingId === employee.id} value={Number(monthly.meal)} onValueChange={(value) => updateMonthly(employee.id, "meal", value)} /><button type="button" className="allowance-auto" title="자동 계산으로 되돌리기" onClick={() => clearMonthly(employee.id, "meal")}>자동</button></> : <button type="button" className="allowance-value" title="누르면 이 달 식대를 직접 입력합니다" onClick={() => { setMealEditingId(employee.id); updateMonthly(employee.id, "meal", row.meal); }}>{money(row.meal)}</button>) : <b>{money(row[field])}</b>}<input type="checkbox" aria-label={`${field} 지급`} checked={employee[field] > 0} onChange={(event) => { if (field === "meal") clearMonthly(employee.id, "meal"); setAllowance(employee.id, field, event.target.checked); }} /></div></td>)}{(["incentive", "bonus"] as const).map((field) => isColumnVisible(field) && <td key={field}><WonInput className="money-input" ariaLabel={field === "incentive" ? "인센티브" : "상여금"} value={Number(monthly[field] ?? 0)} onValueChange={(value) => updateMonthly(employee.id, field, value)} /></td>)}{columns.extra && isColumnVisible("extra") && <td><WonInput className="money-input" ariaLabel="추가수당" value={Number(monthly.extra ?? 0)} onValueChange={(value) => updateMonthly(employee.id, "extra", value)} /></td>}{columns.research && isColumnVisible("research") && <td><WonInput className="money-input" ariaLabel="연구수당" value={Number(monthly.research ?? 0)} onValueChange={(value) => updateMonthly(employee.id, "research", value)} /></td>}{columns.annualLeave && isColumnVisible("annualLeave") && <td><WonInput className="money-input" ariaLabel="연차수당" value={Number(monthly.annualLeave ?? 0)} onValueChange={(value) => updateMonthly(employee.id, "annualLeave", value)} /></td>}{columns.personalExpense && isColumnVisible("personalExpense") && <td><WonInput className="money-input" ariaLabel="개인비용지급" value={Number(monthly.personalExpense ?? 0)} onValueChange={(value) => updateMonthly(employee.id, "personalExpense", value)} /></td>}{columns.personalExpense && isColumnVisible("personalExpenseNote") && <td><input aria-label="개인비용 사유" value={monthly.personalExpenseNote ?? ""} onChange={(event) => updateMonthly(employee.id, "personalExpenseNote", event.target.value)} /></td>}{columns.severance && isColumnVisible("severance") && <td><WonInput className="money-input" ariaLabel="퇴직금" value={Number(monthly.severance ?? 0)} onValueChange={(value) => updateMonthly(employee.id, "severance", value)} /></td>}{columns.deduction && isColumnVisible("deduction") && <td><WonInput className="money-input" ariaLabel="공제" value={Number(monthly.deduction ?? 0)} onValueChange={(value) => updateMonthly(employee.id, "deduction", value)} /></td>}{columns.deduction && isColumnVisible("deductionNote") && <td><input aria-label="공제 사유" value={monthly.deductionNote ?? ""} onChange={(event) => updateMonthly(employee.id, "deductionNote", event.target.value)} placeholder="공제 사유" /></td>}<td className="total-cell">{money(row.total)}</td>{columns.welfare && isColumnVisible("welfare") && <td><WonInput className="money-input" ariaLabel="복지기금" value={Number(monthly.welfare ?? 0)} onValueChange={(value) => updateMonthly(employee.id, "welfare", value)} /></td>}{isColumnVisible("note") && <td><input aria-label="비고" value={monthly.note ?? ""} onChange={(event) => updateMonthly(employee.id, "note", event.target.value)} placeholder="비고" /></td>}<td><button type="button" className="remove-row" aria-label={`${employee.name || "직원"} 삭제`} onClick={() => { if (confirm(`${employee.name || "이 직원"}을 명부에서 삭제할까요?`)) setEmployees((current) => current.filter((item) => item.id !== employee.id)); }}>×</button></td></tr>; })}{!rows.length && <tr><td colSpan={tableColumns.length} className="wage-empty">{run ? "해당 월 임금 대상자가 없습니다." : `${month}월 임금 작성하기를 눌러 HR 인사기록을 불러오세요.`}</td></tr>}</tbody></table><datalist id="wage-departments">{departments.map((value) => <option key={value} value={value} />)}</datalist><datalist id="wage-titles">{titles.map((value) => <option key={value} value={value} />)}</datalist></div></fieldset><footer><button disabled={Boolean(exporting)} type="button" onClick={() => void exportCurrent()}>{exporting === "month" ? "파일 만드는 중…" : "현재 월 엑셀 내려받기"}</button><button disabled={Boolean(exporting)} type="button" onClick={() => void exportYear()}>{exporting === "year" ? "파일 만드는 중…" : "1~12월 일괄 내려받기"}</button>{locked ? <button disabled={saving} className="payroll-footer-action edit" type="button" onClick={() => void compensationAction("REOPEN")}>수정하기</button> : <button disabled={saving || autoSaving || !employees.length} className="payroll-footer-action confirm" type="button" onClick={() => void compensationAction("CONFIRM")}>{saving ? "처리 중…" : "급여 확정"}</button>}<span>초안은 서버에 저장되고 확정 시 HR 급여관리로 반영됩니다.</span></footer></section>
    </div>
  </div>
  </div>;
}

const COMPENSATION_NAV_ITEMS: Array<{ id: CalculatorMode; label: string; hint: string; icon: string }> = [
  { id: "wage", label: "임금 계산", hint: "기본급·수당·일할계산", icon: "임" },
  { id: "incentive", label: "인센티브 계산", hint: "매출·마진·급여 반영액", icon: "인" },
];

function CompensationCalculatorBody({ onAssistantModuleChange }: { onAssistantModuleChange?: (module: "compensation" | "incentive") => void }) {
  const [mode, setMode] = useState<CalculatorMode>("wage");
  useEffect(() => { onAssistantModuleChange?.(mode === "incentive" ? "incentive" : "compensation"); }, [mode, onAssistantModuleChange]);
  return <div className="compensation-module-shell">
    <aside className="compensation-sidebar">
      <div className="compensation-sidebar-brand"><span>₩</span><div><strong>임금 계산</strong></div></div>
      <nav className="compensation-sidebar-nav" aria-label="임금·인센티브 메뉴">
        <p>급여 관리</p>
        {COMPENSATION_NAV_ITEMS.map((item) => <button type="button" key={item.id} className={`compensation-sidebar-item${mode === item.id ? " active" : ""}`} onClick={() => setMode(item.id)}>
          <span className="compensation-sidebar-icon">{item.icon}</span>
          <span><strong>{item.label}</strong><small>{item.hint}</small></span>
        </button>)}
      </nav>
    </aside>
    <main className="compensation-main">
      {mode === "wage" ? <WageCalculator /> : <div className="compensation-incentive-embed"><IncentiveCalculator embedded /></div>}
    </main>
  </div>;
}

/** 모듈 루트. 브라우저 confirm 대신 쓰는 앱 내부 대화상자(app/erp-dialog.tsx)를 이 모듈 전체에 공급한다. */
export default function CompensationCalculator(props: Parameters<typeof CompensationCalculatorBody>[0]) {
  return <ErpDialogProvider><CompensationCalculatorBody {...props} /></ErpDialogProvider>;
}
