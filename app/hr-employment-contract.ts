// 근로계약서 완성본. 인사기록카드의 「기본정보·급여 기준」 값을 회사 양식에 채워 docx 로 내려준다.
//
// 회사는 첫 입사자와 반드시 3개월 기간제 계약을 맺고, 근무평가 뒤에 기간의 정함이 없는 계약을 다시 맺는다.
// 그래서 양식이 두 벌이다(public/hr/). 둘 다 회사의 26년 근로계약서에서 빈칸(밑줄 공백)만 {{토큰}} 으로
// 바꾸고 제2조만 계약 종류에 맞게 고쳐 둔 것이라 나머지 문구·서식은 원본 그대로다.
// 여기서는 word/document.xml 의 토큰 문자열만 바꾸고 나머지 파일은 손대지 않는다. 토큰이 하나라도 남으면
// 양식과 코드가 어긋난 것이라 파일을 만들지 않고 오류로 알린다 — 빈칸이 남은 계약서가 조용히 나가는 것보다 낫다.

/** 인사기록카드에서 가져오는 값. hr-workspace 의 Employee 와 모양이 같아 그대로 넘긴다. */
export type ContractEmployee = {
  name: string;
  birth?: string;
  address?: string;
  phone?: string;
  department: string;
  position: string;
  jobTitle?: string;
  joinDate: string;
  annualSalary?: number;
  basePay?: number;
  mealAllowance?: number;
  childcareAllowance?: number;
  vehicleAllowance?: number;
  /** 첫 계약 동안 기준 연봉의 몇 %를 주는지. 인사기록카드에 저장된 값이다. */
  firstTermPayPercent?: number;
  /** 3개월 첫 계약이 끝나 기간의 정함이 없는 계약을 맺은 날(YYYY-MM-DD). 비어 있으면 아직 전환 전이다. */
  regularContractDate?: string;
};

/** FIXED_TERM 첫 계약(3개월 기간제) · REGULAR 근무평가 뒤 맺는 기간의 정함이 없는 계약. */
export type ContractKind = "FIXED_TERM" | "REGULAR";

/** 인사기록카드에 없어서 내려받기 전에 고르는 값들. 날짜는 모두 YYYY-MM-DD 다. */
export type ContractOptions = {
  kind: ContractKind;
  /** 계약 시작일. 첫 계약은 입사일, 전환 계약은 첫 계약이 끝난 다음 날이 기본이다. */
  startDate: string;
  /** 첫 계약기간 중 지급하는 비율(%). 인사기록카드 값을 그대로 가져온다 — 고치려면 카드에서 고친다. 전환 계약에서는 쓰지 않는다. */
  firstTermPayPercent: string;
  /** 제3조 담당업무. 기본은 인사기록카드의 직무. */
  duty: string;
  /** 계약서 말미의 작성일. 기본은 오늘. */
  contractDate: string;
};

export const CONTRACT_TEMPLATE_URLS: Record<ContractKind, string> = {
  FIXED_TERM: "/hr/employment-contract-fixed-term.docx",
  REGULAR: "/hr/employment-contract-regular.docx",
};

export const contractKindLabels: Record<ContractKind, string> = {
  FIXED_TERM: "첫 계약 (3개월 기간제)",
  REGULAR: "전환 계약 (기간의 정함 없음)",
};

/** 첫 계약의 기간. 회사 기준이라 화면에서 고르지 않는다. */
export const FIXED_TERM_MONTHS = 3;

/** 양식 제4조 ⑤의 월 임금 환산 기준시간. (주 35시간 + 주휴 7시간) × 365 ÷ 7 ÷ 12. */
export const MONTHLY_WAGE_HOURS = 182.5;

/** 최저시급. 해마다 고시되므로 연초에 갱신한다. 3개월 기간제에는 수습 감액이 없어 이 선 아래로는 계약할 수 없다. */
export const MINIMUM_HOURLY_WAGE = 10_320;
export const MINIMUM_WAGE_YEAR = 2026;

/** 빈 값은 밑줄 칸이 보이도록 공백으로 남긴다. */
const BLANK = "    ";

const DIGIT_WORDS = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
const SMALL_UNITS = ["", "십", "백", "천"];
const BIG_UNITS = ["", "만", "억", "조"];

function fourDigitWords(value: number) {
  let words = "";
  for (let place = 3; place >= 0; place -= 1) {
    const digit = Math.floor(value / 10 ** place) % 10;
    if (!digit) continue;
    // 십·백·천 앞의 1 은 읽지 않는다(삼천삼백만). 일의 자리 1 만 "일"로 적는다.
    words += (digit === 1 && place > 0 ? "" : DIGIT_WORDS[digit]) + SMALL_UNITS[place];
  }
  return words;
}

/** 금액을 한글로 적는다. 33,000,000 → 삼천삼백만. 계약서의 "임금은 연 ___ (₩ ___)원" 앞자리에 쓴다. */
export function koreanNumber(value: number) {
  let rest = Math.floor(Math.abs(value));
  if (rest === 0) return "영";
  const parts: string[] = [];
  let unit = 0;
  while (rest > 0) {
    const group = rest % 10000;
    if (group) parts.unshift((group === 1 && unit > 0 ? "일" : fourDigitWords(group)) + BIG_UNITS[unit]);
    rest = Math.floor(rest / 10000);
    unit += 1;
  }
  return parts.join("");
}

function won(value: number | undefined) {
  return Math.max(0, Math.round(value ?? 0)).toLocaleString("ko-KR");
}

function isoDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseIso(value: string) {
  const [year, month, day] = (value || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 달 수를 더한다. 말일에서 넘치면 그 달 말일로 맞춘다(11-30 + 3개월 → 02-28). */
export function addMonths(value: string, months: number) {
  const date = parseIso(value);
  if (!date) return "";
  const targetMonth = date.getMonth() + months;
  const lastDay = new Date(date.getFullYear(), targetMonth + 1, 0).getDate();
  return isoDate(new Date(date.getFullYear(), targetMonth, Math.min(date.getDate(), lastDay)));
}

/** 첫 계약의 종료일. 시작일부터 꼭 3개월 — 9월 7일 시작이면 12월 6일까지다.
 *  끝나는 달에 시작일과 같은 날이 없으면 그 달 말일에 끝난다(민법 제160조 제3항, 2026-09-28 확정).
 *  1월 31일 시작이면 4월 30일, 11월 30일 시작이면 2월 28일까지다. 임금 계산 엔진의 probationEnd 와 같은 규칙이다. */
export function fixedTermEndDate(startDate: string) {
  const start = parseIso(startDate);
  if (!start) return "";
  const lastDayOfEndMonth = new Date(start.getFullYear(), start.getMonth() + FIXED_TERM_MONTHS + 1, 0);
  if (start.getDate() > lastDayOfEndMonth.getDate()) return isoDate(lastDayOfEndMonth);
  return isoDate(new Date(start.getFullYear(), start.getMonth() + FIXED_TERM_MONTHS, start.getDate() - 1));
}

/** 첫 계약이 끝난 다음 날. 전환(기간의 정함이 없는) 계약이 시작되는 날이다. */
export function firstTermNextStart(startDate: string) {
  const end = parseIso(fixedTermEndDate(startDate));
  if (!end) return "";
  end.setDate(end.getDate() + 1);
  return isoDate(end);
}

function datePart(value: string, index: 0 | 1 | 2) {
  const part = (value || "").split("-")[index] ?? "";
  if (!/^\d+$/.test(part)) return BLANK;
  // 연도는 그대로, 월·일은 앞의 0 을 뗀다(9월 7일).
  return index === 0 ? part : String(Number(part));
}

function textOr(value: string | undefined) {
  const trimmed = (value ?? "").trim();
  return trimmed && trimmed !== "미입력" ? trimmed : BLANK;
}

/** 입사한 지 3개월이 안 됐으면 첫 계약, 지났으면 전환 계약을 기본으로 고른다. 화면에서 바꿀 수 있다. */
export function defaultContractKind(employee: ContractEmployee, today = new Date()): ContractKind {
  if (employee.regularContractDate) return "REGULAR";
  const joined = (employee.joinDate || "").replaceAll(".", "-");
  const firstTermEnd = fixedTermEndDate(joined);
  return firstTermEnd && firstTermEnd >= isoDate(today) ? "FIXED_TERM" : "REGULAR";
}

export function defaultContractOptions(employee: ContractEmployee, kind?: ContractKind, today = new Date()): ContractOptions {
  const joined = (employee.joinDate || "").replaceAll(".", "-");
  const resolvedKind = kind ?? defaultContractKind(employee, today);
  return {
    kind: resolvedKind,
    // 전환 계약은 첫 계약(3개월)이 끝난 다음 날부터다.
    startDate: resolvedKind === "FIXED_TERM" ? joined : firstTermNextStart(joined),
    firstTermPayPercent: String(employee.firstTermPayPercent ?? 100),
    duty: employee.jobTitle && employee.jobTitle !== "조직장" ? employee.jobTitle : "",
    contractDate: isoDate(today),
  };
}

export function parsePayPercent(value: string) {
  const percent = Number((value ?? "").trim());
  return Number.isInteger(percent) && percent >= 1 && percent <= 100 ? percent : null;
}

/** 계약서에 적을 월 급여 구성. 첫 계약은 기준 연봉에 지급률을 곱한 금액을 월로 나누고, 식대·수당은 그대로 둔 채
 *  기본급으로 맞춘다 — "계약 연봉의 80% 지급"은 월 지급액 전체가 80% 라는 뜻이기 때문이다.
 *  100% 이거나 전환 계약이면 인사기록카드의 값을 손대지 않고 그대로 쓴다. */
export function contractPay(employee: ContractEmployee, options: ContractOptions) {
  const recorded = Math.max(0, Math.round(employee.basePay ?? 0));
  const meal = Math.max(0, Math.round(employee.mealAllowance ?? 0));
  const vehicle = Math.max(0, Math.round(employee.vehicleAllowance ?? 0));
  const childcare = Math.max(0, Math.round(employee.childcareAllowance ?? 0));
  const annual = Math.max(0, Math.round(employee.annualSalary ?? 0));
  const percent = options.kind === "FIXED_TERM" ? parsePayPercent(options.firstTermPayPercent) : 100;
  const reduced = percent !== null && percent < 100 && annual > 0;
  const basePay = reduced ? Math.ceil(annual * percent / 100 / 12) - meal - vehicle - childcare : recorded;
  // 시급은 양식대로 월 기본급 ÷ 182.5 시간, 원 단위 반올림.
  const hourly = basePay > 0 ? Math.round(basePay / MONTHLY_WAGE_HOURS) : 0;
  // 최저임금 비교는 2024년부터 식대가 전액 산입되므로 기본급 + 식대 기준이다. 실비 성격의 자가운전·육아수당은 넣지 않는다.
  const minimumWageHourly = basePay > 0 ? Math.round((basePay + meal) / MONTHLY_WAGE_HOURS) : 0;
  const problem = percent === null && options.kind === "FIXED_TERM" ? "지급률은 1~100 사이의 정수로 적어 주세요."
    : basePay <= 0 && annual > 0 ? "지급률을 적용하면 기본급이 0원 이하가 됩니다. 지급률을 올려 주세요."
    : minimumWageHourly > 0 && minimumWageHourly < MINIMUM_HOURLY_WAGE
      ? `환산 시급 ${minimumWageHourly.toLocaleString("ko-KR")}원이 ${MINIMUM_WAGE_YEAR}년 최저시급 ${MINIMUM_HOURLY_WAGE.toLocaleString("ko-KR")}원에 못 미칩니다. 3개월 기간제에는 수습 감액을 쓸 수 없어 이대로는 계약할 수 없습니다.`
      : "";
  return { annual, percent: percent ?? 0, basePay: Math.max(0, basePay), meal, vehicle, childcare, hourly, total: Math.max(0, basePay) + meal + vehicle + childcare, minimumWageHourly, problem };
}

/** 양식의 토큰마다 들어갈 값. 화면의 미리보기와 실제 파일이 같은 표를 쓰게 여기 한 곳에서만 만든다.
 *  두 양식의 토큰을 모두 담는다 — 양식에 없는 토큰은 그냥 쓰이지 않는다. */
export function contractTokens(employee: ContractEmployee, options: ContractOptions): Record<string, string> {
  const pay = contractPay(employee, options);
  const { annual, basePay, meal, vehicle, childcare, hourly } = pay;
  const endDate = options.kind === "FIXED_TERM" ? fixedTermEndDate(options.startDate) : "";
  const firstJoined = (employee.joinDate || "").replaceAll(".", "-");
  return {
    성명: textOr(employee.name),
    시작년: datePart(options.startDate, 0),
    시작월: datePart(options.startDate, 1),
    시작일: datePart(options.startDate, 2),
    종료년: datePart(endDate, 0),
    종료월: datePart(endDate, 1),
    종료일: datePart(endDate, 2),
    최초입사년: datePart(firstJoined, 0),
    최초입사월: datePart(firstJoined, 1),
    최초입사일: datePart(firstJoined, 2),
    소속직위: `${employee.department} / ${employee.position}`,
    담당업무: textOr(options.duty),
    연봉한글: annual > 0 ? koreanNumber(annual) : BLANK,
    연봉: annual > 0 ? won(annual) : BLANK,
    지급비율: pay.percent > 0 ? String(pay.percent) : BLANK,
    기본급: won(basePay),
    시급: hourly > 0 ? won(hourly) : BLANK,
    식대: won(meal),
    자가운전: won(vehicle),
    육아수당: won(childcare),
    월합계: won(pay.total),
    계약년: datePart(options.contractDate, 0),
    계약월: datePart(options.contractDate, 1),
    계약일: datePart(options.contractDate, 2),
    생년월일: textOr(employee.birth),
    주소: textOr(employee.address),
    연락처: textOr(employee.phone),
  };
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** document.xml 의 {{토큰}} 을 값으로 바꾼다. 남는 토큰이 있으면 양식과 어긋난 것이라 멈춘다. */
export function fillContractXml(xml: string, tokens: Record<string, string>) {
  let filled = xml;
  for (const [key, value] of Object.entries(tokens)) {
    filled = filled.split(`{{${key}}}`).join(escapeXml(value));
  }
  const leftover = Array.from(new Set(filled.match(/\{\{[^}]+\}\}/g) ?? []));
  if (leftover.length) throw new Error(`근로계약서 양식에 채우지 못한 자리가 있습니다: ${leftover.join(", ")}`);
  return filled;
}

export function contractFileName(employee: ContractEmployee, options: ContractOptions) {
  const name = (employee.name || "직원").replace(/[\\/:*?"<>|]/g, "");
  const kind = options.kind === "FIXED_TERM" ? "기간제" : "정규직";
  return `근로계약서(${kind})_${name}_${options.startDate || "미정"}.docx`;
}

/** 양식을 받아 토큰을 채운 docx 를 만든다. 브라우저에서 돌며 서버로는 아무것도 보내지 않는다. */
export async function buildEmploymentContract(employee: ContractEmployee, options: ContractOptions) {
  const problem = contractPay(employee, options).problem;
  if (problem) throw new Error(problem);
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import("fflate");
  const response = await fetch(CONTRACT_TEMPLATE_URLS[options.kind], { cache: "no-store" });
  if (!response.ok) throw new Error("근로계약서 양식을 불러오지 못했습니다.");
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const document = files["word/document.xml"];
  if (!document) throw new Error("근로계약서 양식이 올바른 docx 파일이 아닙니다.");
  files["word/document.xml"] = strToU8(fillContractXml(strFromU8(document), contractTokens(employee, options)));
  const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, [data, { level: 6 }] as const])));
  return new Blob([new Uint8Array(zipped)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
