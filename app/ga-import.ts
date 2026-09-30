// 총무 엑셀 양식·검증(general-affairs Design §6, GA-D1). 순수 모듈이다(import 는 날짜 계산뿐).
// 브라우저는 양식을 만들고 머리글로 열을 찾는다. 서버는 같은 규칙으로 다시 검증한다(클라이언트 결과를 믿지 않는다).
import { isDate } from "./ga-alerts";

export type GaSheet = "EQUIPMENT" | "SUPPLY" | "CONTRACT" | "FIXED" | "DOCUMENT" | "B2B_CONTRACT" | "CHECKOUT";
type ColumnType = "text" | "date" | "money" | "int" | "yn" | "enum" | "employee";
export type Column = { header: string; field: string; required?: boolean; type: ColumnType; max?: number; options?: Record<string, string>; example?: string };
export type SheetDefinition = { sheet: GaSheet; title: string; columns: Column[] };

export const GA_IMPORT_MAX_ROWS = 500;

export const EQUIPMENT_STATUS: Record<string, string> = { 재고: "IN_STOCK", 지급: "ASSIGNED", 수리: "REPAIR" };
export const CONTRACT_CATEGORIES = ["라이선스", "도메인", "호스팅", "리스", "보험", "유지보수", "기타"];
export const BILLING_CYCLES: Record<string, string> = { 월: "MONTHLY", 분기: "QUARTERLY", 연: "YEARLY", "1회": "ONCE" };
export const DOCUMENT_KINDS: Record<string, string> = {
  사업자등록증: "BUSINESS_REG", 등기부등본: "CORP_REGISTRY", 인감증명서: "SEAL_CERT", 사용인감계: "SEAL_USAGE",
  인증서: "CERTIFICATE", 인허가증: "PERMIT", 기타: "OTHER",
};
export const CONTRACT_TYPES: Record<string, string> = { 물품공급: "SUPPLY", 파트너: "PARTNER", 용역: "SERVICE", 비밀유지: "NDA", 기타: "OTHER" };

const T = (header: string, field: string, extra: Partial<Column> = {}): Column => ({ header, field, type: "text", max: 200, ...extra });

export const GA_SHEETS: Record<GaSheet, SheetDefinition> = {
  EQUIPMENT: { sheet: "EQUIPMENT", title: "지급장비", columns: [
    T("자산번호", "assetNo", { max: 40, example: "" }), T("이름", "name", { required: true, example: "노트북 (LG gram 16)" }), T("분류", "category", { example: "노트북" }),
    T("모델", "model", { example: "16Z90S" }), T("시리얼", "serialNo", { example: "SN-0001" }),
    { header: "상태", field: "status", type: "enum", options: EQUIPMENT_STATUS, example: "지급" },
    { header: "사용자", field: "holderEmployeeId", type: "employee", example: "홍길동" }, T("위치", "location", { example: "본사 2층" }),
    { header: "취득일", field: "acquiredOn", type: "date", example: "2026-03-02" }, { header: "취득가", field: "acquisitionCost", type: "money", example: "1,890,000" },
    T("공급처", "vendor"), { header: "내용연수(개월)", field: "usefulLifeMonths", type: "int", example: "" }, T("메모", "memo", { max: 1000 }),
  ] },
  SUPPLY: { sheet: "SUPPLY", title: "비품소모품", columns: [
    T("자산번호", "assetNo", { max: 40 }), T("이름", "name", { required: true, example: "A4 용지" }), T("분류", "category", { example: "사무용품" }),
    T("위치", "location", { example: "탕비실 수납장" }), { header: "수량", field: "quantity", type: "int", required: true, example: "12" },
    T("단위", "unit", { max: 20, example: "박스" }), { header: "최소수량", field: "minQuantity", type: "int", example: "3" },
    { header: "취득일", field: "acquiredOn", type: "date" }, { header: "단가", field: "acquisitionCost", type: "money", example: "25,000" },
    T("공급처", "vendor"), T("메모", "memo", { max: 1000 }),
  ] },
  CONTRACT: { sheet: "CONTRACT", title: "계약구독", columns: [
    T("자산번호", "assetNo", { max: 40 }), T("이름", "name", { required: true, example: "회사 도메인 xdnode.co.kr" }),
    T("분류", "category", { example: "도메인" }), T("계약처", "counterparty", { required: true, example: "가비아" }), T("계약번호", "contractNo", { max: 80 }),
    { header: "시작일", field: "startsOn", type: "date" }, { header: "만료일", field: "endsOn", type: "date", required: true, example: "2027-01-15" },
    { header: "자동갱신", field: "autoRenew", type: "yn", example: "N" }, { header: "갱신비용", field: "renewalCost", type: "money", example: "22,000" },
    { header: "결제주기", field: "billingCycle", type: "enum", options: BILLING_CYCLES, example: "연" },
    { header: "담당자", field: "managerEmployeeId", type: "employee" }, T("메모", "memo", { max: 1000 }),
  ] },
  FIXED: { sheet: "FIXED", title: "고정자산", columns: [
    T("자산번호", "assetNo", { max: 40 }), T("이름", "name", { required: true, example: "회의실 영상회의 장비" }), T("분류", "category", { example: "비품" }),
    { header: "취득일", field: "acquiredOn", type: "date", required: true, example: "2026-01-10" },
    { header: "취득가", field: "acquisitionCost", type: "money", required: true, example: "3,600,000" },
    { header: "내용연수(개월)", field: "usefulLifeMonths", type: "int", required: true, example: "60" },
    { header: "잔존가치", field: "residualValue", type: "money", example: "0" }, { header: "기초상각누계", field: "openingAccumulated", type: "money", example: "" },
    { header: "기초기준일", field: "openingAsOf", type: "date", example: "" }, T("위치", "location"),
    { header: "사용자", field: "holderEmployeeId", type: "employee" }, T("메모", "memo", { max: 1000 }),
  ] },
  DOCUMENT: { sheet: "DOCUMENT", title: "회사서류", columns: [
    { header: "종류", field: "kind", type: "enum", required: true, options: DOCUMENT_KINDS, example: "사업자등록증" },
    T("서류명", "title", { required: true, example: "사업자등록증 원본" }), T("발급기관", "issuer", { example: "세무서" }),
    { header: "발급일", field: "issuedOn", type: "date" }, { header: "만료일", field: "expiresOn", type: "date" },
    { header: "유효기간(개월)", field: "validityMonths", type: "int", example: "" }, T("보관위치", "storageLocation", { required: true, example: "금고 1단" }),
    { header: "관리책임자", field: "managerEmployeeId", type: "employee" }, T("메모", "memo", { max: 1000 }),
  ] },
  B2B_CONTRACT: { sheet: "B2B_CONTRACT", title: "기업간계약서", columns: [
    T("계약명", "title", { required: true, example: "물품공급 기본계약" }),
    { header: "계약종류", field: "contractType", type: "enum", required: true, options: CONTRACT_TYPES, example: "물품공급" },
    T("상대방", "counterparty", { required: true, example: "○○상사" }), { header: "계약일", field: "signedOn", type: "date" },
    { header: "시작일", field: "startsOn", type: "date" }, { header: "종료일", field: "endsOn", type: "date", example: "2027-06-30" },
    { header: "계약금액", field: "contractAmount", type: "money" }, { header: "자동연장", field: "autoRenew", type: "yn", example: "Y" },
    { header: "해지통보기한(일)", field: "noticeDays", type: "int", example: "30" }, T("보관위치", "storageLocation", { example: "계약서 바인더 A" }),
    { header: "관리책임자", field: "managerEmployeeId", type: "employee" }, T("메모", "memo", { max: 1000 }),
  ] },
  CHECKOUT: { sheet: "CHECKOUT", title: "반출대장", columns: [
    T("대상", "targetName", { required: true, example: "법인인감" }), { header: "반출자", field: "borrowerEmployeeId", type: "employee", required: true, example: "홍길동" },
    { header: "반출일", field: "outOn", type: "date", required: true, example: "2026-09-01" }, T("용도", "purpose", { required: true, example: "은행 대출 서류" }),
    T("제출처", "submitTo"), { header: "반납예정일", field: "dueOn", type: "date" }, { header: "반납일", field: "returnedOn", type: "date" },
    T("받은사람", "receivedBy", { max: 60 }), T("메모", "returnMemo", { max: 1000 }),
  ] },
};

export const GA_SHEET_ORDER: GaSheet[] = ["EQUIPMENT", "SUPPLY", "CONTRACT", "FIXED", "DOCUMENT", "B2B_CONTRACT", "CHECKOUT"];

export type PersonRef = { employeeId: string; name: string };
export type RawCell = string | number | boolean | null | undefined;

/** 엑셀 날짜(1900 날짜 체계 일련번호), '2026.10.01', '2026/10/1', '2026-10-01' → 'YYYY-MM-DD'. */
export function parseDateCell(value: RawCell): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 59 && value < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000).toISOString().slice(0, 10);
  }
  const text = String(value).trim().replace(/\s+/g, "");
  const match = /^(\d{4})[.\-/년](\d{1,2})[.\-/월](\d{1,2})일?\.?$/.exec(text) ?? /^(\d{4})-(\d{2})-(\d{2})T/.exec(text);
  if (!match) return undefined;
  const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return isDate(date) ? date : undefined;
}

/** '1,890,000', '1890000원', 1890000 → 정수(원). 음수·소수는 undefined(오류). */
export function parseMoneyCell(value: RawCell): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const text = String(value).trim().replace(/[,\s원₩]/g, "");
  if (!/^\d{1,15}$/.test(text)) return undefined;
  return Number(text);
}

export function parseIntCell(value: RawCell): number | null | undefined {
  const parsed = parseMoneyCell(value);
  return parsed === undefined ? undefined : parsed;
}

export function parseYnCell(value: RawCell): boolean | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toUpperCase();
  if (["Y", "YES", "예", "O", "TRUE", "1"].includes(text)) return true;
  if (["N", "NO", "아니오", "X", "FALSE", "0"].includes(text)) return false;
  return undefined;
}

/** 직원: 사번(정확히) 또는 이름(재직자 중 한 명). 동명이인은 오류로 사번을 요구한다. */
export function resolveEmployee(value: RawCell, people: PersonRef[]): { employeeId: string | null; error?: string } {
  if (value === null || value === undefined || String(value).trim() === "") return { employeeId: null };
  const text = String(value).trim();
  const byId = people.find((person) => person.employeeId === text);
  if (byId) return { employeeId: byId.employeeId };
  const byName = people.filter((person) => person.name === text);
  if (byName.length === 1) return { employeeId: byName[0].employeeId };
  if (byName.length > 1) return { employeeId: null, error: `'${text}' 동명이인이 있습니다. 사번으로 적어 주세요.` };
  return { employeeId: null, error: `'${text}' 직원을 찾을 수 없습니다.` };
}

export type NormalizedRow = { row: number; values: Record<string, unknown>; errors: string[] };

/** 한 행(머리글 → 값)을 검증해 API 필드로 바꾼다. row 는 엑셀 행 번호(머리글 1행, 예시 2행 다음부터). */
export function normalizeRow(sheet: GaSheet, raw: Record<string, RawCell>, row: number, people: PersonRef[]): NormalizedRow {
  const definition = GA_SHEETS[sheet];
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const column of definition.columns) {
    const cell = raw[column.header];
    const empty = cell === null || cell === undefined || String(cell).trim() === "";
    if (empty) {
      if (column.required) errors.push(`${column.header}: 필수입니다.`);
      continue;
    }
    switch (column.type) {
      case "text": {
        const text = String(cell).trim();
        if (text.length > (column.max ?? 200)) errors.push(`${column.header}: ${column.max ?? 200}자까지입니다.`);
        else values[column.field] = text;
        break;
      }
      case "date": {
        const date = parseDateCell(cell);
        if (date === undefined) errors.push(`${column.header}: 날짜 형식(2026-10-01)이 아닙니다.`);
        else values[column.field] = date;
        break;
      }
      case "money":
      case "int": {
        const number = parseMoneyCell(cell);
        if (number === undefined) errors.push(`${column.header}: 0 이상의 정수가 아닙니다.`);
        else values[column.field] = number;
        break;
      }
      case "yn": {
        const flag = parseYnCell(cell);
        if (flag === undefined) errors.push(`${column.header}: Y 또는 N 으로 적어 주세요.`);
        else values[column.field] = flag;
        break;
      }
      case "enum": {
        const text = String(cell).trim();
        const mapped = column.options?.[text];
        if (!mapped) errors.push(`${column.header}: ${Object.keys(column.options ?? {}).join("/")} 가운데 하나입니다.`);
        else values[column.field] = mapped;
        break;
      }
      case "employee": {
        const found = resolveEmployee(cell, people);
        if (found.error) errors.push(`${column.header}: ${found.error}`);
        else values[column.field] = found.employeeId;
        break;
      }
    }
  }
  if (sheet === "EQUIPMENT" && values.status === "ASSIGNED" && !values.holderEmployeeId) errors.push("상태가 '지급'이면 사용자가 필요합니다.");
  if (sheet === "FIXED" && typeof values.residualValue === "number" && typeof values.acquisitionCost === "number" && values.residualValue >= values.acquisitionCost) {
    errors.push("잔존가치는 취득가보다 작아야 합니다.");
  }
  if (sheet === "CHECKOUT" && values.returnedOn && values.outOn && String(values.returnedOn) < String(values.outOn)) errors.push("반납일이 반출일보다 앞섭니다.");
  if (sheet === "B2B_CONTRACT" && values.startsOn && values.endsOn && String(values.endsOn) < String(values.startsOn)) errors.push("종료일이 시작일보다 앞섭니다.");
  return { row, values, errors };
}

/** 머리글 행에서 알려진 열의 위치를 찾는다(순서 무관, 앞뒤 공백·'*' 무시). 필수 열이 없으면 missing 에 담는다. */
export function mapHeaders(sheet: GaSheet, headerRow: RawCell[]) {
  const clean = (value: RawCell) => String(value ?? "").replace(/\*/g, "").trim();
  const index = new Map<string, number>();
  headerRow.forEach((cell, position) => { if (clean(cell)) index.set(clean(cell), position); });
  const columns = GA_SHEETS[sheet].columns;
  const missing = columns.filter((column) => column.required && !index.has(column.header)).map((column) => column.header);
  return { index, missing };
}

/** 표(머리글 1행 + 데이터)를 머리글 → 값 객체 배열로 바꾼다. 예시 행(둘째 줄, 모든 값이 양식 예시와 같음)은 건너뛴다. */
export function rowsFromTable(sheet: GaSheet, table: RawCell[][]) {
  const [headerRow = [], ...body] = table;
  const { index, missing } = mapHeaders(sheet, headerRow);
  const columns = GA_SHEETS[sheet].columns;
  const rows: Array<{ row: number; raw: Record<string, RawCell> }> = [];
  body.forEach((cells, offset) => {
    const raw: Record<string, RawCell> = {};
    for (const column of columns) {
      const position = index.get(column.header);
      if (position !== undefined) raw[column.header] = cells[position] ?? null;
    }
    const filled = Object.values(raw).some((value) => value !== null && value !== undefined && String(value).trim() !== "");
    const isExample = columns.every((column) => (column.example ?? "") === String(raw[column.header] ?? "").trim());
    if (filled && !isExample) rows.push({ row: offset + 2, raw });
  });
  return { rows, missing };
}
