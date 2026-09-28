"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import readXlsxFile from "read-excel-file/browser";
import writeXlsxFile from "write-excel-file/browser";
import styles from "./incentive.module.css";
import { randomId, readScoped, writeScoped } from "../client-runtime";

type DealKind = "일반" | "인바운드" | "단독 RAM" | "케이블" | "온라인";
type AdjustmentKind = "추가지급" | "차감" | "복지기금 전환";
type CableMode = "deduct" | "fold" | "none";
type IncentiveRounding = "none" | "round" | "floor";
type IncentiveConfig = { hurdleRate: number; payoutRate: number; cableMode: CableMode; rounding: IncentiveRounding; fixCancelSign: boolean };

type Deal = {
  id: string;
  person: string;
  personId: string;
  date: string;
  salesInvoiceDate: string;
  client: string;
  item: string;
  quantity: number;
  unitCost: number;
  unitSale: number;
  expense: number;
  kind: DealKind;
  excluded: boolean;
};

type Adjustment = {
  id: string;
  person: string;
  personId: string;
  kind: AdjustmentKind;
  amount: number;
  note: string;
};

type EmployeeOption = { id: string; name: string; department: string; status: string };

type ImportedCell = string | number | boolean | Date | null;

const DEAL_STORAGE = "xdnode-incentive-deals-v1";
const ADJUSTMENT_STORAGE = "xdnode-incentive-adjustments-v1";
const CONFIG_STORAGE = "xdnode-incentive-config-v1";
const PAYROLL_RESULT_STORAGE = "xdnode-incentive-payroll-v1";
const EXCLUDED_PEOPLE_STORAGE = "xdnode-incentive-excluded-people-v1";
const CABLE_EXCLUSION_MIGRATION = "xdnode-incentive-cable-exclusion-v2";
const KINDS: DealKind[] = ["일반", "인바운드", "단독 RAM", "케이블", "온라인"];
const EXCLUDED_KINDS = new Set<DealKind>(["인바운드", "단독 RAM", "온라인"]);
const DEFAULT_CONFIG: IncentiveConfig = { hurdleRate: 5, payoutRate: 5, cableMode: "deduct", rounding: "none", fixCancelSign: true };

const emptyDeal = (): Deal => ({
  id: randomId(),
  person: "",
  personId: "",
  date: new Date().toISOString().slice(0, 10),
  salesInvoiceDate: "",
  client: "",
  item: "",
  quantity: 1,
  unitCost: 0,
  unitSale: 0,
  expense: 0,
  kind: "일반",
  excluded: false,
});

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Number(value.replace(/[₩원,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeHeader(value: unknown) {
  return String(value ?? "").replace(/[\s_()]/g, "").toLowerCase();
}

function excelDate(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && value > 30000 && value < 70000) {
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
  }
  return String(value ?? "").slice(0, 10);
}

function findColumn(headers: unknown[], candidates: string[]) {
  const normalized = headers.map(normalizeHeader);
  return normalized.findIndex((header) => candidates.some((candidate) => header === normalizeHeader(candidate)));
}

function inferKind(value: unknown, person: unknown, item: unknown): DealKind {
  const text = `${value ?? ""} ${person ?? ""} ${item ?? ""}`.toLowerCase();
  if (text.includes("인바운드")) return "인바운드";
  if (text.includes("온라인") || text.includes("스마트스토어")) return "온라인";
  if (text.includes("케이블") || text.includes("cable")) return "케이블";
  if (text.includes("단독 ram") || text.includes("단독램")) return "단독 RAM";
  return "일반";
}

// 담당자 목록은 /api/compensation/roster 에서만 받는다(R3, Design §4.2.7). 필드는 employeeId·name·department·status
// 4개뿐이라 임금 계산 전용 계정도 인사기록(전화·주소·급여)을 받지 않는다. 정적 명부는 번들에 넣지 않는다(§7.9).
function mergeEmployeeOptions(records: Array<{ employeeId: string; name: string; department: string; status: string }>) {
  const merged = new Map<string, EmployeeOption>();
  for (const record of records) {
    if (!record.employeeId) continue;
    merged.set(record.employeeId, { id: record.employeeId, name: record.name, department: record.department, status: record.status });
  }
  return [...merged.values()].sort((a, b) =>
    Number(a.status === "퇴직") - Number(b.status === "퇴직") || a.name.localeCompare(b.name, "ko"));
}

function resolvePersonId(name: string, employees: EmployeeOption[]) {
  const matches = employees.filter((employee) => employee.name === name);
  return matches.length === 1 ? matches[0].id : "";
}

// Grouping key for deals/adjustments: the resolved employee ID when known, otherwise a
// per-raw-name bucket. Using the ID (not the name) here is what keeps two employees who
// share a name from having their sales silently merged into one payroll figure.
function personKey(entity: { person: string; personId: string }) {
  return entity.personId || `unresolved:${entity.person}`;
}
function personLabel(entity: { person: string; personId: string }, employees: EmployeeOption[]) {
  if (!entity.personId) return `${entity.person} (확인필요)`;
  return employees.find((employee) => employee.id === entity.personId)?.name ?? entity.person;
}

function parseRows(rows: ImportedCell[][], employees: EmployeeOption[]) {
  const headerIndex = rows.findIndex((row) => row.some((cell) => ["담당자", "발주일", "매출처", "품목"].includes(String(cell ?? "").trim())));
  if (headerIndex < 0) throw new Error("헤더 행을 찾지 못했습니다. 담당자·품목·수량·원가·매출 열을 확인해 주세요.");
  const headers = rows[headerIndex];
  const col = {
    person: findColumn(headers, ["담당자", "이름", "성명"]),
    date: findColumn(headers, ["발주일", "거래일", "일자"]),
    salesInvoiceDate: findColumn(headers, ["매출계산서일", "계산서일", "세금계산서일"]),
    client: findColumn(headers, ["매출처", "거래처", "고객사"]),
    item: findColumn(headers, ["품목", "상품명", "제품명"]),
    quantity: findColumn(headers, ["수량", "qty"]),
    unitCost: findColumn(headers, ["원가", "매입가", "매입단가"]),
    purchaseTotal: findColumn(headers, ["매입합", "매입합계", "원가합계"]),
    unitSale: findColumn(headers, ["매출", "판매가", "매출단가"]),
    salesTotal: findColumn(headers, ["매출합", "매출합계", "판매합계"]),
    expense: findColumn(headers, ["비용", "경비", "부대비용"]),
    kind: findColumn(headers, ["구분", "유형", "인센구분", "대상구분"]),
  };
  if (col.person < 0 || col.item < 0 || col.quantity < 0) throw new Error("필수 열(담당자·품목·수량)이 부족합니다.");

  return rows.slice(headerIndex + 1).flatMap((row) => {
    const person = String(row[col.person] ?? "").trim();
    const item = String(row[col.item] ?? "").trim();
    const parsedQuantity = asNumber(row[col.quantity]);
    const quantity = parsedQuantity || 1;
    if (!person || !item) return [];
    const purchaseTotal = col.purchaseTotal >= 0 ? asNumber(row[col.purchaseTotal]) : 0;
    const salesTotal = col.salesTotal >= 0 ? asNumber(row[col.salesTotal]) : 0;
    const unitCost = col.unitCost >= 0 ? asNumber(row[col.unitCost]) : purchaseTotal / quantity;
    const unitSale = col.unitSale >= 0 ? asNumber(row[col.unitSale]) : salesTotal / quantity;
    const kind = inferKind(col.kind >= 0 ? row[col.kind] : "", person, item);
    return [{
      id: randomId(),
      person,
      personId: resolvePersonId(person, employees),
      date: col.date >= 0 ? excelDate(row[col.date]) : "",
      salesInvoiceDate: col.salesInvoiceDate >= 0 ? excelDate(row[col.salesInvoiceDate]) : "",
      client: col.client >= 0 ? String(row[col.client] ?? "") : "",
      item,
      quantity,
      unitCost,
      unitSale,
      expense: col.expense >= 0 ? asNumber(row[col.expense]) : 0,
      kind,
      excluded: EXCLUDED_KINDS.has(kind),
    } satisfies Deal];
  });
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(value); value = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(value); if (row.some(Boolean)) rows.push(row); row = []; value = "";
    } else value += char;
  }
  row.push(value); if (row.some(Boolean)) rows.push(row);
  return rows;
}

function calculate(deal: Deal, config: IncentiveConfig, foldedCableCost = 0) {
  const sales = deal.quantity * deal.unitSale;
  const purchase = deal.quantity * deal.unitCost;
  const margin = sales - purchase - deal.expense - foldedCableCost;
  const threshold = sales * config.hurdleRate / 100;
  const cancelBlocked = config.fixCancelSign && sales <= 0;
  const incentive = deal.excluded || cancelBlocked ? 0 : Math.max((margin - threshold) * config.payoutRate / 100, 0);
  return { sales, purchase, margin, threshold, incentive, cancelBlocked };
}

function foldedCableCosts(deals: Deal[], config: IncentiveConfig) {
  const foldedCosts = new Map<string, number>();
  if (config.cableMode !== "fold") return foldedCosts;
  const groups = new Map<string, Deal[]>();
  for (const deal of deals) {
    const key = `${deal.date}|${deal.client}`;
    groups.set(key, [...(groups.get(key) ?? []), deal]);
  }
  for (const group of groups.values()) {
    const cableCost = group.filter((deal) => deal.kind === "케이블" && deal.excluded)
      .reduce((sum, deal) => sum + Math.max(deal.quantity * deal.unitCost, 0), 0);
    const host = group.filter((deal) => deal.kind !== "케이블" && !deal.excluded && deal.quantity * deal.unitSale > 0)
      .sort((a, b) => b.quantity * b.unitSale - a.quantity * a.unitSale)[0];
    if (host && cableCost) foldedCosts.set(host.id, cableCost);
  }
  return foldedCosts;
}

function migrateCableExclusions(deals: Deal[]) {
  const groupedExclusions = new Set(deals
    .filter((deal) => deal.kind !== "케이블" && deal.excluded)
    .map((deal) => `${deal.date}|${deal.client}`));
  return deals.map((deal) => deal.kind === "케이블" && deal.excluded && !groupedExclusions.has(`${deal.date}|${deal.client}`)
    ? { ...deal, excluded: false }
    : deal);
}

// Categorical palette validated for CVD-safe adjacent contrast (fixed slot order —
// see the dataviz skill's reference palette). Colors are assigned by a stable hash of
// the label, not by sort position, so a person/product keeps its color even as
// exclusions or reloads shuffle the ranking.
const CATEGORICAL_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];

function colorForLabel(label: string, colors: string[]) {
  let hash = 0;
  for (let index = 0; index < label.length; index++) hash = (hash * 31 + label.charCodeAt(index)) >>> 0;
  return colors[hash % colors.length];
}

function chartBreakdown(entries: Array<[string, number]>, otherLabel = "기타") {
  const grouped = new Map<string, number>();
  for (const [rawLabel, rawValue] of entries) {
    const value = Math.max(rawValue, 0);
    if (value <= 0) continue;
    const label = rawLabel.trim() || "미입력";
    grouped.set(label, (grouped.get(label) ?? 0) + value);
  }
  const ordered = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
  const visible = ordered.slice(0, 5);
  const other = ordered.slice(5).reduce((sum, [, value]) => sum + value, 0);
  if (other > 0) visible.push([otherLabel, other]);
  const total = visible.reduce((sum, [, value]) => sum + value, 0);
  const segments = visible.map(([label, value]) => ({ label, value, color: colorForLabel(label, CATEGORICAL_COLORS) }));
  return { total, segments };
}

function salesBreakdown(deals: Deal[], label: (deal: Deal) => string, otherLabel: string) {
  return chartBreakdown(deals.map((deal) => [label(deal), deal.quantity * deal.unitSale]), otherLabel);
}

function kindSalesBreakdown(deals: Deal[]) {
  return chartBreakdown(deals.map((deal) => [deal.kind === "일반" || deal.kind === "인바운드" ? deal.kind : "기타 구분", deal.quantity * deal.unitSale]), "기타 구분");
}

function incentiveBreakdown(deals: Deal[], config: IncentiveConfig) {
  const foldedCosts = foldedCableCosts(deals, config);
  return chartBreakdown(deals.map((deal) => [
    deal.item.trim() || "제품 미입력",
    roundIncentive(calculate(deal, config, foldedCosts.get(deal.id) ?? 0).incentive, config.rounding),
  ]), "기타 제품");
}

type ChartBreakdown = ReturnType<typeof chartBreakdown>;

// Ranked horizontal bars replace donut charts for part-to-whole reading: legible at a
// glance, every value visible directly (not gated behind hover), ≤6 segments (5 + "기타").
function RankedBars({ breakdown, label, emptyLabel }: { breakdown: ChartBreakdown; label: string; emptyLabel: string }) {
  return <div className={styles.rankedBars}>
    <div className={styles.rankedBarsHead}><span>{label}</span><strong>{won(breakdown.total)}</strong></div>
    {breakdown.segments.map((segment) => <div className={styles.rankedBarRow} key={segment.label}>
      <span className={styles.rankedBarLabel} title={segment.label}>{segment.label}</span>
      <div className={styles.rankedBarTrack}><div className={styles.rankedBarFill} style={{ width: `${breakdown.total ? Math.max(segment.value / breakdown.total * 100, 1.5) : 0}%`, backgroundColor: segment.color }} /></div>
      <div className={styles.rankedBarMeta}><span className={styles.rankedBarValue}>{won(segment.value)}</span><span className={styles.rankedBarPct}>{breakdown.total ? `${(segment.value / breakdown.total * 100).toFixed(1)}%` : "0%"}</span></div>
    </div>)}
    {!breakdown.segments.length && <p className={styles.rankedBarsEmpty}>{emptyLabel}</p>}
  </div>;
}

function roundIncentive(value: number, rounding: IncentiveRounding) {
  if (rounding === "round") return Math.round(value);
  if (rounding === "floor") return Math.floor(value);
  return value;
}

function won(value: number) {
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(Math.round(value))}원`;
}

export default function IncentiveCalculator({ embedded = false }: { embedded?: boolean } = {}) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [config, setConfig] = useState<IncentiveConfig>(DEFAULT_CONFIG);
  const [draft, setDraft] = useState<Deal>(() => emptyDeal());
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState("거래를 직접 입력하거나 엑셀 파일을 불러오세요.");
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState("");
  const [adjustmentDraft, setAdjustmentDraft] = useState({ targetKey: "", kind: "추가지급" as AdjustmentKind, amount: 0, note: "" });
  const [dashboardPerson, setDashboardPerson] = useState("");
  const [dealFilterPerson, setDealFilterPerson] = useState("");
  const [excludedPeople, setExcludedPeople] = useState<string[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeesError, setEmployeesError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/compensation/roster", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { employees?: Array<{ employeeId: string; name: string; department: string; status: string }>; error?: string };
        if (!response.ok) throw new Error(data.error || "직원 목록을 불러오지 못했습니다.");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setEmployees(mergeEmployeeOptions(data.employees ?? []));
        setEmployeesError("");
      })
      .catch((error: unknown) => {
        if (!cancelled) setEmployeesError(`${error instanceof Error ? error.message : "직원 목록을 불러오지 못했습니다."} 담당자를 지정하려면 새로고침하거나 임금 계산 탭 권한을 확인해 주세요.`);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        // 계정 범위 키로 읽는다. 범위 키가 없으면 레거시 키를 1회 옮기고 지운다(Design §5.5).
        const savedDeals = readScoped(DEAL_STORAGE);
        const savedAdjustments = readScoped(ADJUSTMENT_STORAGE);
        const savedConfig = readScoped(CONFIG_STORAGE);
        const savedExcludedPeople = readScoped(EXCLUDED_PEOPLE_STORAGE);
        if (savedDeals) {
          const parsedDeals = JSON.parse(savedDeals) as Deal[];
          const cableMigrationDone = readScoped(CABLE_EXCLUSION_MIGRATION) === "done";
          setDeals(cableMigrationDone ? parsedDeals : migrateCableExclusions(parsedDeals));
          if (!cableMigrationDone) writeScoped(CABLE_EXCLUSION_MIGRATION, "done");
        }
        if (savedAdjustments) setAdjustments(JSON.parse(savedAdjustments));
        if (savedConfig) setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(savedConfig) });
        if (savedExcludedPeople) setExcludedPeople(JSON.parse(savedExcludedPeople));
      } catch { setMessage("저장된 이력을 읽지 못했습니다. 새 계산으로 시작합니다."); }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeScoped(DEAL_STORAGE, JSON.stringify(deals));
    writeScoped(ADJUSTMENT_STORAGE, JSON.stringify(adjustments));
    writeScoped(CONFIG_STORAGE, JSON.stringify(config));
    writeScoped(EXCLUDED_PEOPLE_STORAGE, JSON.stringify(excludedPeople));
  }, [deals, adjustments, config, excludedPeople, hydrated]);

  const allPeople = useMemo(() => {
    const map = new Map<string, { key: string; label: string; personId: string }>();
    for (const deal of deals) { const key = personKey(deal); if (!map.has(key)) map.set(key, { key, label: personLabel(deal, employees), personId: deal.personId }); }
    for (const item of adjustments) { const key = personKey(item); if (!map.has(key)) map.set(key, { key, label: personLabel(item, employees), personId: item.personId }); }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, "ko"));
  }, [deals, adjustments, employees]);
  const excludedPeopleSet = useMemo(() => new Set(excludedPeople), [excludedPeople]);
  const activeDeals = useMemo(() => deals.filter((deal) => !excludedPeopleSet.has(personKey(deal))), [deals, excludedPeopleSet]);
  const activeAdjustments = useMemo(() => adjustments.filter((item) => !excludedPeopleSet.has(personKey(item))), [adjustments, excludedPeopleSet]);
  const people = useMemo(() => allPeople.filter((group) => !excludedPeopleSet.has(group.key)), [allPeople, excludedPeopleSet]);
  const unresolvedPeople = useMemo(() => allPeople.filter((group) => !group.personId), [allPeople]);

  useEffect(() => {
    setExcludedPeople((current) => current.filter((key) => allPeople.some((group) => group.key === key)));
  }, [allPeople]);

  useEffect(() => {
    if (!people.length) { setDashboardPerson(""); setDealFilterPerson(""); return; }
    if (!dashboardPerson || !people.some((group) => group.key === dashboardPerson)) setDashboardPerson(people[0].key);
    if (dealFilterPerson && !people.some((group) => group.key === dealFilterPerson)) setDealFilterPerson("");
  }, [people, dashboardPerson, dealFilterPerson]);

  function resolvePerson(rawName: string, employeeId: string) {
    setDeals((current) => current.map((deal) => deal.person === rawName && !deal.personId ? { ...deal, personId: employeeId } : deal));
    setAdjustments((current) => current.map((item) => item.person === rawName && !item.personId ? { ...item, personId: employeeId } : item));
  }

  const summaries = useMemo(() => people.map((group) => {
    const person = group.label;
    const ownDeals = activeDeals.filter((deal) => personKey(deal) === group.key);
    const ownAdjustments = activeAdjustments.filter((item) => personKey(item) === group.key);
    const foldedCosts = foldedCableCosts(ownDeals, config);
    const base = ownDeals.reduce((acc, deal) => {
      const result = calculate(deal, config, foldedCosts.get(deal.id) ?? 0);
      const rowIncentive = roundIncentive(result.incentive, config.rounding);
      acc.sales += result.sales; acc.margin += result.margin; acc.incentive += rowIncentive;
      if (deal.excluded) acc.excluded += result.sales;
      if (!deal.excluded) acc.eligibleSales += result.sales;
      if (deal.kind === "인바운드") acc.inboundSales += result.sales;
      if (deal.kind === "단독 RAM") acc.ramSales += result.sales;
      if (deal.kind === "케이블") acc.cableSales += result.sales;
      return acc;
    }, { sales: 0, margin: 0, incentive: 0, excluded: 0, eligibleSales: 0, inboundSales: 0, ramSales: 0, cableSales: 0 });
    const cableDeduction = config.cableMode === "deduct"
      ? ownDeals.filter((deal) => deal.kind === "케이블" && deal.excluded).reduce((sum, deal) => sum + roundIncentive(Math.max(deal.quantity * deal.unitCost, 0) * config.payoutRate / 100, config.rounding), 0)
      : 0;
    const extra = ownAdjustments.filter((item) => item.kind === "추가지급").reduce((sum, item) => sum + item.amount, 0);
    const deduction = ownAdjustments.filter((item) => item.kind === "차감").reduce((sum, item) => sum + item.amount, 0);
    const welfare = ownAdjustments.filter((item) => item.kind === "복지기금 전환").reduce((sum, item) => sum + item.amount, 0);
    const approved = Math.max(base.incentive - cableDeduction + extra - deduction, 0);
    return { person, personId: group.personId, resolved: Boolean(group.personId), ...base, cableDeduction, extra, deduction, welfare: Math.min(welfare, approved), approved, payroll: Math.max(approved - welfare, 0), count: ownDeals.length };
  }), [people, activeDeals, activeAdjustments, config]);

  useEffect(() => {
    if (!hydrated) return;
    writeScoped(PAYROLL_RESULT_STORAGE, JSON.stringify({ savedAt: new Date().toISOString(), config, summaries }));
  }, [config, hydrated, summaries]);

  const totals = useMemo(() => summaries.reduce((acc, item) => {
    acc.sales += item.sales; acc.margin += item.margin; acc.approved += item.approved; acc.payroll += item.payroll; acc.welfare += item.welfare;
    return acc;
  }, { sales: 0, margin: 0, approved: 0, payroll: 0, welfare: 0 }), [summaries]);

  const dashboardPersonDeals = useMemo(() => activeDeals.filter((deal) => personKey(deal) === dashboardPerson), [activeDeals, dashboardPerson]);
  const dashboardPersonLabel = useMemo(() => people.find((group) => group.key === dashboardPerson)?.label ?? "", [people, dashboardPerson]);
  const overallSalesByPerson = useMemo(() => salesBreakdown(deals, (deal) => deal.person ? personLabel(deal, employees) : "담당자 미입력", "기타 담당자"), [deals, employees]);
  const overallSalesByProduct = useMemo(() => salesBreakdown(deals, (deal) => deal.item || "제품 미입력", "기타 제품"), [deals]);
  const overallSalesByKind = useMemo(() => kindSalesBreakdown(deals), [deals]);
  const overallIncentiveByPerson = useMemo(() => chartBreakdown(summaries.map((item) => [item.person, item.incentive]), "기타 담당자"), [summaries]);
  const personalSalesByProduct = useMemo(() => salesBreakdown(dashboardPersonDeals, (deal) => deal.item || "제품 미입력", "기타 제품"), [dashboardPersonDeals]);
  const personalSalesByKind = useMemo(() => kindSalesBreakdown(dashboardPersonDeals), [dashboardPersonDeals]);
  const personalIncentiveByProduct = useMemo(() => incentiveBreakdown(dashboardPersonDeals, config), [dashboardPersonDeals, config]);
  const dealFoldedCosts = useMemo(() => foldedCableCosts(activeDeals, config), [activeDeals, config]);
  const filteredDeals = useMemo(() => dealFilterPerson ? activeDeals.filter((deal) => personKey(deal) === dealFilterPerson) : activeDeals, [activeDeals, dealFilterPerson]);
  const selectedCableDeals = useMemo(() => dealFilterPerson
    ? activeDeals.filter((deal) => personKey(deal) === dealFilterPerson && deal.kind === "케이블" && !deal.excluded)
    : [], [activeDeals, dealFilterPerson]);

  function toggleExcludedPerson(person: string) {
    setExcludedPeople((current) => current.includes(person) ? current.filter((item) => item !== person) : [...current, person]);
  }

  function addDeal() {
    if (!draft.personId || !draft.item.trim()) { setMessage("담당자와 품목을 입력해 주세요."); return; }
    setDeals((current) => [...current, { ...draft, item: draft.item.trim() }]);
    setDraft({ ...emptyDeal(), person: draft.person, personId: draft.personId, date: draft.date });
    setMessage("거래 1건을 추가했습니다.");
  }

  async function importSheet(selectedSheet: string, selectedFile = file) {
    if (!selectedFile) return;
    try {
      const workbookSheets = await readXlsxFile(selectedFile);
      const rows = workbookSheets.find((item) => item.sheet === selectedSheet)?.data as ImportedCell[][] | undefined;
      if (!rows) throw new Error("선택한 시트를 찾지 못했습니다.");
      const parsed = parseRows(rows, employees);
      if (!parsed.length) throw new Error("가져올 거래가 없습니다.");
      setDeals(parsed);
      setAdjustments([]);
      setSheet(selectedSheet);
      setMessage(`${selectedSheet}에서 거래 ${parsed.length.toLocaleString("ko-KR")}건을 불러왔습니다.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "엑셀을 읽지 못했습니다."); }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    if (selected.name.toLowerCase().endsWith(".csv")) {
      try {
        const parsed = parseRows(parseCsv(await selected.text()), employees);
        setDeals(parsed); setAdjustments([]); setSheets([]); setSheet("");
        setMessage(`CSV에서 거래 ${parsed.length.toLocaleString("ko-KR")}건을 불러왔습니다.`);
      } catch (error) { setMessage(error instanceof Error ? error.message : "CSV를 읽지 못했습니다."); }
      return;
    }
    try {
      const workbookSheets = await readXlsxFile(selected);
      const names = workbookSheets.map((item) => item.sheet);
      if (!names.length) throw new Error("시트를 찾지 못했습니다.");
      setSheets(names);
      const rows = workbookSheets[0].data as ImportedCell[][];
      const parsed = parseRows(rows, employees);
      if (!parsed.length) throw new Error("가져올 거래가 없습니다.");
      setDeals(parsed); setAdjustments([]); setSheet(names[0]);
      setMessage(`${names[0]}에서 거래 ${parsed.length.toLocaleString("ko-KR")}건을 불러왔습니다.`);
    } catch { setMessage("지원되는 .xlsx 또는 .csv 파일인지 확인해 주세요."); }
  }

  function addAdjustment() {
    const target = people.find((group) => group.key === adjustmentDraft.targetKey);
    if (!target || adjustmentDraft.amount <= 0) { setMessage("조정 대상과 금액을 입력해 주세요."); return; }
    const person = target.personId ? target.label : target.key.slice("unresolved:".length);
    setAdjustments((current) => [...current, { id: randomId(), person, personId: target.personId, kind: adjustmentDraft.kind, amount: adjustmentDraft.amount, note: adjustmentDraft.note }]);
    setAdjustmentDraft((current) => ({ ...current, amount: 0, note: "" }));
    setMessage("지급 조정을 반영했습니다.");
  }

  function loadExample() {
    const idFor = (name: string) => resolvePersonId(name, employees);
    // 예시 담당자는 불러온 직원 목록에서 고른다. 실명을 코드(브라우저 번들)에 두지 않기 위해서다(Design §7.9).
    const examplePerson = (index: number) => employees[index]?.name || `예시 직원${"ABC"[index] ?? index + 1}`;
    setDeals([
      { ...emptyDeal(), person: examplePerson(0), personId: idFor(examplePerson(0)), client: "리안시스템", item: "PRO 5000", quantity: 2, unitCost: 8190000, unitSale: 8950000, expense: 12455 },
      { ...emptyDeal(), person: examplePerson(0), personId: idFor(examplePerson(0)), client: "온라인몰", item: "서버 케이블", quantity: 4, unitCost: 110000, unitSale: 150000, expense: 2990, kind: "케이블", excluded: true },
      { ...emptyDeal(), person: examplePerson(1), personId: idFor(examplePerson(1)), client: "대학교 산학협력단", item: "DGX Spark", quantity: 2, unitCost: 6607091, unitSale: 7700000, expense: 0 },
    ]);
    setAdjustments([]);
    setMessage("예시 거래를 불러왔습니다. 자유롭게 수정하거나 삭제해 보세요.");
  }

  async function exportResults() {
    const header = ["담당자", "거래건수", "총매출", "총마진", "기본 인센", "케이블 차감", "추가지급", "차감", "승인 인센", "급여 인센", "복지기금"];
    const rows = summaries.map((item) => [item.person, item.count, item.sales, item.margin, item.incentive, -item.cableDeduction, item.extra, item.deduction, item.approved, item.payroll, item.welfare]);
    const data = [header, ...rows].map((row, rowIndex) => row.map((value, columnIndex) => ({
      value,
      type: typeof value === "number" ? Number : String,
      fontWeight: rowIndex === 0 ? "bold" as const : undefined,
      backgroundColor: rowIndex === 0 ? "#E8EEF0" : undefined,
      format: rowIndex > 0 && columnIndex >= 2 ? "₩#,##0" : undefined,
    })));
    try {
      await writeXlsxFile(data, {
        sheet: "개인별 인센티브",
        stickyRowsCount: 1,
        showGridLines: true,
      }).toFile(`개인별_인센티브_${new Date().toISOString().slice(0, 10)}.xlsx`);
      setMessage("개인별 인센티브 결과를 엑셀로 저장했습니다.");
    } catch (error) {
      console.error("개인별 인센티브 엑셀 저장 실패", error);
      setMessage("엑셀 파일을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
  }

  function excludeCableDealsForPerson() {
    const dealFilterLabel = people.find((group) => group.key === dealFilterPerson)?.label ?? dealFilterPerson;
    if (!dealFilterPerson) {
      setMessage("케이블 미반영을 적용할 담당자를 먼저 선택해 주세요.");
      return;
    }
    if (!selectedCableDeals.length) {
      setMessage(`${dealFilterLabel} 담당자에게 반영 중인 케이블 거래가 없습니다.`);
      return;
    }
    if (!confirm(`${dealFilterLabel} 담당자의 케이블 거래 ${selectedCableDeals.length.toLocaleString("ko-KR")}건을 인센티브 계산에서 미반영할까요?`)) return;
    const targetIds = new Set(selectedCableDeals.map((deal) => deal.id));
    setDeals((items) => items.map((item) => targetIds.has(item.id) ? { ...item, excluded: true } : item));
    setMessage(`${dealFilterLabel} 담당자의 케이블 거래 ${selectedCableDeals.length.toLocaleString("ko-KR")}건을 미반영 처리했습니다.`);
  }

  function clearAll() {
    if (!confirm("현재 거래와 조정 내역을 모두 지울까요?")) return;
    setDeals([]); setAdjustments([]); setExcludedPeople([]); setFile(null); setSheets([]); setSheet("");
    if (fileInput.current) fileInput.current.value = "";
    setMessage("새 계산으로 초기화했습니다.");
  }

  return (
    <main className={`${styles.page} ${embedded ? styles.embedded : ""}`}>
      {!embedded && <header className={styles.topbar}>
        {/* eslint-disable-next-line @next/next/no-img-element -- 정적 로고 */}
        <Link href="/" className={styles.brand}><img className={styles.brandLogo} src="/brand/xdnode-symbol.png" alt="XDNODE" width={40} height={40} /><div><strong>인센티브 계산기</strong></div></Link>
        <div className={styles.saved}><i /> 이 브라우저에 자동 저장</div>
      </header>}

      <div className={styles.container}>
        {employeesError && <div className={styles.notice} role="alert">{employeesError}</div>}
        <section className={styles.hero}>
          <div data-korean-heading><h1>매출을 넣으면<br />지급액까지 한 번에.</h1><span>거래별 초과마진을 계산하고, 제외 매출과 지급 조정을 반영해 개인별 급여 입력액을 만듭니다.</span></div>
          <div className={styles.formula}><small>현재 적용 산식</small><strong>MAX((마진 − 매출×{config.hurdleRate}%) × {config.payoutRate}%, 0)</strong><p>인바운드 · 단독 RAM · 온라인은 기본 제외 · 케이블은 거래별 판단</p></div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHead}><div data-korean-heading><h2>산식·예외 처리 기준</h2></div><span>원본 계산기 기본값 5% · 5%</span></div>
          <div className={styles.dealForm}>
            <label>허들 마진율 %<input type="number" min="0" step="0.1" value={config.hurdleRate} onChange={(event) => setConfig((current) => ({ ...current, hurdleRate: asNumber(event.target.value) }))} /></label>
            <label>인센 지급률 %<input type="number" min="0" step="0.1" value={config.payoutRate} onChange={(event) => setConfig((current) => ({ ...current, payoutRate: asNumber(event.target.value) }))} /></label>
            <label className={styles.wide}>케이블·액세서리 처리<select value={config.cableMode} onChange={(event) => setConfig((current) => ({ ...current, cableMode: event.target.value as CableMode }))}><option value="deduct">별도 차감 — 원가×지급률</option><option value="fold">같은 거래 본품 원가에 합산</option><option value="none">미적용</option></select></label>
            <label>단수 처리<select value={config.rounding} onChange={(event) => setConfig((current) => ({ ...current, rounding: event.target.value as IncentiveRounding }))}><option value="none">없음</option><option value="round">반올림</option><option value="floor">버림</option></select></label>
            <label className={styles.ruleCheck}><input type="checkbox" checked={config.fixCancelSign} onChange={(event) => setConfig((current) => ({ ...current, fixCancelSign: event.target.checked }))} />취소·반품 부호 보정</label>
          </div>
          <div className={styles.notice}>각 거래의 인센티브를 먼저 계산하고 단수 처리한 뒤 개인별로 합산합니다. 케이블은 제품명만으로 제외하지 않으며 거래별 ‘인센 반영’ 설정을 따릅니다. 이후 케이블 차감과 지급 조정을 별도로 반영합니다.</div>
        </section>

        <section className={styles.kpis}>
          <article><span>총 매출</span><strong>{won(totals.sales)}</strong><small>{activeDeals.length.toLocaleString("ko-KR")}건의 거래</small></article>
          <article><span>총 마진</span><strong>{won(totals.margin)}</strong><small>비용 차감 후</small></article>
          <article className={styles.darkCard}><span>승인 인센티브</span><strong>{won(totals.approved)}</strong><small>추가·차감 반영</small></article>
          <article><span>급여 인센 열</span><strong>{won(totals.payroll)}</strong><small>복지기금 {won(totals.welfare)} 별도</small></article>
        </section>

        <section className={styles.workGrid}>
          <article className={styles.panel}>
            <div className={styles.panelHead}><div data-korean-heading><h2>거래 불러오기</h2></div><button type="button" onClick={loadExample}>예시 불러오기</button></div>
            <button className={styles.dropzone} type="button" onClick={() => fileInput.current?.click()}>
              <span>↑</span><div><strong>엑셀 또는 CSV 선택</strong><small>현재 인센정리 형식의 담당자·품목·수량·원가·매출 열을 자동 인식합니다.</small></div>
              <input ref={fileInput} type="file" accept=".xlsx,.csv" onChange={onFile} />
            </button>
            {sheets.length > 1 && <label className={styles.sheetSelect}>계산할 시트<select value={sheet} onChange={(event) => importSheet(event.target.value)}>{sheets.map((name) => <option key={name}>{name}</option>)}</select></label>}
            <div className={styles.notice}>{message}</div>
            <div className={styles.peopleExclusion}>
              <div><strong>인센티브 완전 제외 인원</strong><small>선택된 인원은 계산·요약·그래프·거래 내역과 엑셀 결과에서 모두 제외됩니다.</small></div>
              <div className={styles.peopleChoices}>{allPeople.map((group) => <label key={group.key} className={excludedPeopleSet.has(group.key) ? styles.personExcluded : undefined}><input type="checkbox" checked={excludedPeopleSet.has(group.key)} onChange={() => toggleExcludedPerson(group.key)} /><span>{group.label}</span></label>)}{!allPeople.length && <p>거래를 불러오면 담당자를 선택할 수 있습니다.</p>}</div>
              {!!excludedPeople.length && <button type="button" onClick={() => setExcludedPeople([])}>제외 설정 모두 해제</button>}
            </div>
          </article>

          <article className={styles.panel}>
            <div className={styles.panelHead}><div data-korean-heading><h2>거래 직접 입력</h2></div></div>
            <div className={styles.dealForm}>
              <label>담당자<select value={draft.personId} onChange={(e) => { const id = e.target.value; const found = employees.find((employee) => employee.id === id); setDraft({ ...draft, personId: id, person: found?.name ?? "" }); }}><option value="">선택</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department}{employee.status !== "재직" ? ` · ${employee.status}` : ""}</option>)}</select></label>
              <label>발주일<input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} /></label>
              <label>매출계산서일<input type="date" value={draft.salesInvoiceDate} onChange={(e) => setDraft({ ...draft, salesInvoiceDate: e.target.value })} /></label>
              <label>거래처<input value={draft.client} onChange={(e) => setDraft({ ...draft, client: e.target.value })} placeholder="매출처" /></label>
              <label className={styles.wide}>품목<input value={draft.item} onChange={(e) => setDraft({ ...draft, item: e.target.value })} placeholder="제품명" /></label>
              <label>수량<input type="number" min="1" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: asNumber(e.target.value) })} /></label>
              <label>개당 원가<input type="number" min="0" value={draft.unitCost} onChange={(e) => setDraft({ ...draft, unitCost: asNumber(e.target.value) })} /></label>
              <label>개당 매출<input type="number" min="0" value={draft.unitSale} onChange={(e) => setDraft({ ...draft, unitSale: asNumber(e.target.value) })} /></label>
              <label>비용<input type="number" min="0" value={draft.expense} onChange={(e) => setDraft({ ...draft, expense: asNumber(e.target.value) })} /></label>
              <label>구분<select value={draft.kind} onChange={(e) => { const kind = e.target.value as DealKind; setDraft({ ...draft, kind, excluded: EXCLUDED_KINDS.has(kind) }); }}>{KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
              <button type="button" className={styles.addButton} onClick={addDeal}>거래 추가</button>
            </div>
          </article>
        </section>

        {unresolvedPeople.length > 0 && <section className={styles.panel}>
          <div className={styles.panelHead}><div data-korean-heading><h2>담당자 확인 필요 · {unresolvedPeople.length}명</h2></div></div>
          <div className={styles.notice}>엑셀로 가져온 이름이 인사기록과 정확히 1명으로 매칭되지 않았습니다(동명이인 또는 명부에 없음). 실제 직원을 지정하기 전까지 이 매출·조정 건은 급여 인센티브 반영 대상에서 제외됩니다.</div>
          <div className={styles.peopleChoices}>{unresolvedPeople.map((group) => {
            const rawName = group.key.slice("unresolved:".length);
            const candidates = employees.filter((employee) => employee.name === rawName);
            return <label key={group.key}>
              <span>{rawName}{candidates.length > 1 ? ` · 동명이인 ${candidates.length}명` : candidates.length === 0 ? " · 명부에 없음" : ""}</span>
              <select value="" onChange={(event) => { if (event.target.value) resolvePerson(rawName, event.target.value); }}>
                <option value="">직원 지정</option>
                {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department}{employee.status !== "재직" ? ` · ${employee.status}` : ""}</option>)}
              </select>
            </label>;
          })}</div>
        </section>}

        <section className={`${styles.panel} ${styles.resultPanel}`}>
          <div className={styles.panelHead}><div data-korean-heading><h2>개인별 예상 인센티브</h2><span className={styles.calculationHint}>월 인센티브 액은 거래별 확정액 합계입니다.</span></div><button type="button" onClick={exportResults} disabled={!summaries.length}>개인별 결과 엑셀 저장</button></div>
          <div className={styles.summaryTableWrap}><table className={styles.summaryTable}><thead><tr><th>인물</th><th>월 총 매출</th><th>월 총 마진</th><th>월 인바운드 매출</th><th>단독램 매출</th><th>케이블 매출</th><th>인센 인정 매출</th><th>월 인센티브 액</th></tr></thead>
          <tbody>{summaries.map((item) => <tr key={item.person}><td><strong>{item.person}</strong><small>{item.count}건</small></td><td>{won(item.sales)}</td><td>{won(item.margin)}</td><td>{won(item.inboundSales)}</td><td>{won(item.ramSales)}</td><td>{won(item.cableSales)}</td><td>{won(item.eligibleSales)}</td><td><strong>{won(item.incentive)}</strong><small>거래별 확정액 합계</small></td></tr>)}{!summaries.length && <tr><td colSpan={8} className={styles.empty}>거래를 불러오면 개인별 예상 인센티브가 표시됩니다.</td></tr>}</tbody></table></div>
        </section>

        <section className={`${styles.panel} ${styles.companyDashboard}`}>
          <div className={styles.panelHead}><div data-korean-heading><h2>전체 인센티브 대시보드</h2><span className={styles.dashboardHint}>전체 매출 비중은 완전 제외 인원 설정과 무관하게 모든 원본 거래를 포함합니다.</span></div></div>
          <div className={styles.companyDashboardGrid}>
            <article className={styles.dashboardTile}>
              <div data-korean-heading className={styles.tileHeading}><h3>인원별 전체 매출 비중</h3></div>
              <RankedBars breakdown={overallSalesByPerson} label="전체 매출" emptyLabel="매출 거래가 없습니다." />
            </article>
            <article className={styles.dashboardTile}>
              <div data-korean-heading className={styles.tileHeading}><h3>제품 · 거래 구분별 매출</h3></div>
              <div className={styles.rankedBarsGrid}><RankedBars breakdown={overallSalesByProduct} label="제품별" emptyLabel="제품 매출이 없습니다." /><RankedBars breakdown={overallSalesByKind} label="거래 구분별" emptyLabel="구분별 매출이 없습니다." /></div>
            </article>
            <article className={styles.dashboardTile}>
              <div data-korean-heading className={styles.tileHeading}><h3>인원별 전체 인센티브 비중</h3></div>
              <RankedBars breakdown={overallIncentiveByPerson} label="전체 인센티브" emptyLabel="발생한 인센티브가 없습니다." />
            </article>
          </div>
        </section>

        <section className={`${styles.panel} ${styles.personalDashboard}`}>
          <div className={styles.panelHead}><div data-korean-heading><h2>개인 인센티브 대시보드</h2></div><label className={styles.dashboardSelect}>인원<select value={dashboardPerson} onChange={(event) => setDashboardPerson(event.target.value)}><option value="">선택</option>{people.map((group) => <option key={group.key} value={group.key}>{group.label}</option>)}</select></label></div>
          <div className={styles.personalDashboardGrid}>
            <article className={styles.dashboardTile}>
              <div data-korean-heading className={styles.tileHeading}><h3>{dashboardPersonLabel || "선택 인원"} 매출 구성</h3></div>
              <div className={styles.rankedBarsGrid}><RankedBars breakdown={personalSalesByProduct} label="제품별" emptyLabel="제품 매출이 없습니다." /><RankedBars breakdown={personalSalesByKind} label="거래 구분별" emptyLabel="구분별 매출이 없습니다." /></div>
            </article>
            <article className={styles.dashboardTile}>
              <div data-korean-heading className={styles.tileHeading}><h3>{dashboardPersonLabel || "선택 인원"} 제품별 인센티브 비중</h3></div>
              <RankedBars breakdown={personalIncentiveByProduct} label="개인 인센티브" emptyLabel="발생한 인센티브가 없습니다." />
            </article>
          </div>
        </section>

        <section className={`${styles.panel} ${styles.dealReviewPanel}`}>
          <div className={styles.panelHead}><div data-korean-heading><h2>거래별 계산 내역</h2></div></div>
          <div className={styles.dealTools}>
            <div className={styles.dealFilter}><label>담당자<select value={dealFilterPerson} onChange={(event) => setDealFilterPerson(event.target.value)}><option value="">전체 담당자</option>{people.map((group) => <option key={group.key} value={group.key}>{group.label}</option>)}</select></label></div>
            <button type="button" className={styles.cableBulkButton} onClick={excludeCableDealsForPerson} disabled={!dealFilterPerson || !selectedCableDeals.length}>케이블 미반영 일괄 적용{selectedCableDeals.length ? ` · ${selectedCableDeals.length.toLocaleString("ko-KR")}건` : ""}</button>
            <span className={styles.dealCount}>{filteredDeals.length.toLocaleString("ko-KR")} / {activeDeals.length.toLocaleString("ko-KR")}건</span>
          </div>
          <div className={styles.tableWrap}><table className={styles.dealTable}><thead><tr><th>담당자</th><th>거래처</th><th>구분</th><th>제품</th><th>수량</th><th>원가</th><th>매출합</th><th>마진</th><th>마진율</th><th>마진 계산식</th><th>발주일</th><th>매출계산서일</th></tr></thead>
          <tbody>{filteredDeals.map((deal) => { const result = calculate(deal, config, dealFoldedCosts.get(deal.id) ?? 0); const rowIncentive = roundIncentive(result.incentive, config.rounding); const marginRate = result.sales ? result.margin / result.sales * 100 : 0; return <tr key={deal.id} className={[deal.kind === "케이블" ? styles.cableRow : "", deal.excluded ? styles.excludedRow : ""].filter(Boolean).join(" ") || undefined}>
            <td><strong>{deal.person}</strong>{!deal.personId && <em> · 확인필요</em>}<button className={styles.delete} onClick={() => setDeals((items) => items.filter((item) => item.id !== deal.id))}>삭제</button></td>
            <td>{deal.client || "-"}</td>
            <td><select value={deal.kind} onChange={(e) => { const kind = e.target.value as DealKind; setDeals((items) => items.map((item) => item.id === deal.id ? { ...item, kind, excluded: EXCLUDED_KINDS.has(kind) } : item)); }}>{KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select><label className={styles.rowInclude}><input type="checkbox" checked={!deal.excluded} onChange={() => setDeals((items) => items.map((item) => item.id === deal.id ? { ...item, excluded: !item.excluded } : item))} />인센 반영</label></td>
            <td>{deal.item}</td><td>{deal.quantity.toLocaleString("ko-KR")}</td><td>{won(deal.unitCost)}</td><td>{won(result.sales)}</td><td>{won(result.margin)}</td><td>{marginRate.toFixed(1)}%</td>
            <td className={styles.formulaCell}><strong>{won(rowIncentive)}</strong><small>({won(result.margin)} − {won(result.threshold)}) × {config.payoutRate}%</small>{result.cancelBlocked && <small>취소 부호 보정</small>}</td>
            <td>{deal.date || "-"}</td><td>{deal.salesInvoiceDate || deal.date || "-"}</td>
          </tr>; })}{!filteredDeals.length && <tr><td colSpan={12} className={styles.empty}>{activeDeals.length ? "선택한 담당자의 거래가 없습니다." : deals.length ? "모든 담당자가 인센티브 완전 제외로 설정되었습니다." : "아직 거래가 없습니다. 엑셀을 불러오거나 첫 거래를 입력해 주세요."}</td></tr>}</tbody></table></div>
        </section>

        <section className={`${styles.panel} ${styles.adjustmentPanel}`}>
            <div className={styles.panelHead}><div data-korean-heading><h2>지급 조정</h2></div></div>
            <div className={styles.adjustForm}>
              <label>대상<select value={adjustmentDraft.targetKey} onChange={(e) => setAdjustmentDraft({ ...adjustmentDraft, targetKey: e.target.value })}><option value="">선택</option>{people.map((group) => <option key={group.key} value={group.key}>{group.label}</option>)}</select></label>
              <label>조정<select value={adjustmentDraft.kind} onChange={(e) => setAdjustmentDraft({ ...adjustmentDraft, kind: e.target.value as AdjustmentKind })}><option>추가지급</option><option>차감</option><option>복지기금 전환</option></select></label>
              <label>금액<input type="number" min="0" value={adjustmentDraft.amount} onChange={(e) => setAdjustmentDraft({ ...adjustmentDraft, amount: asNumber(e.target.value) })} /></label>
              <label>메모<input value={adjustmentDraft.note} onChange={(e) => setAdjustmentDraft({ ...adjustmentDraft, note: e.target.value })} placeholder="예: 특별 인센티브" /></label>
              <button type="button" className={styles.addButton} onClick={addAdjustment}>조정 반영</button>
            </div>
            <div className={styles.adjustList}>{adjustments.map((item) => <div key={item.id}><span>{item.kind}</span><strong>{item.person} · {won(item.amount)}</strong><small>{item.note || "메모 없음"}</small><button onClick={() => setAdjustments((items) => items.filter((entry) => entry.id !== item.id))}>×</button></div>)}{!adjustments.length && <p>추가지급, 차감, 복지기금 전환 내역이 없습니다.</p>}</div>
        </section>

        <footer className={styles.footer}><p>모든 자료는 현재 브라우저에만 저장됩니다.</p><button type="button" onClick={clearAll}>전체 초기화</button></footer>
      </div>
    </main>
  );
}
