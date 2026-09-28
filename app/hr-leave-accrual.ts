/** 월차·연차 발생·사용·소멸 계산부. 화면과 API 는 이 모듈이 낸 원장을 그리기만 한다.
 *  회사 결정(docs/hr-leave-management-plan.md 6절): 법정 가산 적용, 1년 소멸 + 촉진 안내, 생일 반차·공가는 차감하지 않음,
 *  월차는 발생일이 지나면 자동 부여(예외는 사람이 「제외」), 기록은 HR 이 대리 입력한다.
 *  날짜는 모두 "YYYY-MM-DD" 로 다루고, 입사일처럼 점 구분("2024.01.15")으로 들어오는 값은 normalizeDate 로 맞춘다. */

export type LeavePolicy = {
  /** 1주년 부여일수(근로기준법 제60조 ①). */
  annualDays: number;
  /** 3년차부터 2년마다 1일 가산(제60조 ④). */
  seniorityIncrement: boolean;
  maxAnnualDays: number;
  /** 발생 후 몇 개월 안에 써야 하는지. 월차(1년 미만분)는 입사 1주년까지다(제60조 ⑦). */
  expiryMonths: number;
  /** 1차 촉진 안내 시점(소멸 6개월 전)과 2차(2개월 전), 일 단위. */
  promotionFirstDays: number;
  promotionSecondDays: number;
};

export const DEFAULT_LEAVE_POLICY: LeavePolicy = {
  annualDays: 15, seniorityIncrement: true, maxAnnualDays: 25, expiryMonths: 12, promotionFirstDays: 183, promotionSecondDays: 61,
};

export type LeaveKind = "ANNUAL" | "HALF" | "QUARTER" | "BIRTHDAY_HALF" | "OFFICIAL" | "SICK" | "FAMILY" | "OTHER";

/** 종류별 기본 일수와 차감 여부. 생일 반차·공가·병가·가족돌봄은 기록만 하고 잔여에서 빼지 않는다. */
export const LEAVE_KINDS: Record<LeaveKind, { label: string; units: number; deducts: boolean; symbol: string }> = {
  ANNUAL: { label: "연차", units: 1, deducts: true, symbol: "●" },
  HALF: { label: "반차", units: 0.5, deducts: true, symbol: "○" },
  QUARTER: { label: "반반차", units: 0.25, deducts: true, symbol: "⊙" },
  BIRTHDAY_HALF: { label: "생일 반차", units: 0.5, deducts: false, symbol: "♣" },
  OFFICIAL: { label: "공가·대체·경조", units: 1, deducts: false, symbol: "♧" },
  SICK: { label: "병가", units: 1, deducts: false, symbol: "△" },
  FAMILY: { label: "가족돌봄", units: 1, deducts: false, symbol: "▽" },
  OTHER: { label: "기타", units: 1, deducts: false, symbol: "◇" },
};

/** 시트의 내용 문자열 → 종류. 매핑이 안 되면 null 을 돌려주고 이관 스크립트가 멈춘다. */
export function leaveKindFromLabel(label: string): LeaveKind | null {
  const text = label.replace(/\s+/g, "");
  if (!text) return null;
  if (/^(생일반차|생일)$/.test(text)) return "BIRTHDAY_HALF";
  if (/^(오전|오후)?반반차$/.test(text)) return "QUARTER";
  if (/^(오전|오후)?반차$/.test(text)) return "HALF";
  if (/^연차$/.test(text)) return "ANNUAL";
  if (/공가|대체|경조|예비군|민방위|훈련|결혼|조사|출산/.test(text)) return "OFFICIAL";
  if (/병가/.test(text)) return "SICK";
  if (/가족|돌봄/.test(text)) return "FAMILY";
  if (/기타|무급|휴직/.test(text)) return "OTHER";
  return null;
}

/** "2026. 01.15", "24.05.23", "2026-02-02", 엑셀 시리얼(45000) 을 모두 YYYY-MM-DD 로. 못 읽으면 "". */
export function normalizeDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value) && value > 20000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000).toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{2}|\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})\.?$/);
  if (!match) return "";
  const year = match[1].length === 2 ? 2000 + Number(match[1]) : Number(match[1]);
  const month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return "";
  return date.toISOString().slice(0, 10);
}

/** 달 더하기. 말일 입사자는 짧은 달에서 그 달 말일로 맞춘다(1/31 + 1개월 = 2/28). */
export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** "2026.07.13~16" / "2026.03.03~09" / "26.07.13~07.16" 같은 기간 표기를 평일(월~금) 날짜 목록으로 편다.
 *  기간이 아니면 한 날짜만 담아 돌려주고, 못 읽으면 빈 배열이다. */
export function expandDateRange(value: unknown): string[] {
  const text = String(value ?? "").trim();
  const range = text.match(/^(.+?)\s*[~∼-]\s*(\d{1,2}(?:\s*[./]\s*\d{1,2})?)\.?$/);
  if (!range || !/[./]/.test(range[1])) { const single = normalizeDate(value); return single ? [single] : []; }
  const start = normalizeDate(range[1]);
  if (!start) return [];
  const tail = range[2].replace(/\s+/g, "");
  const end = normalizeDate(tail.includes(".") || tail.includes("/") ? `${start.slice(0, 4)}.${tail}` : `${start.slice(0, 7).replace("-", ".")}.${tail}`);
  if (!end || end < start) return [];
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(day);
  }
  return days;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** 입사 k주년에 부여할 연차. k=1,2 → 15, k=3,4 → 16, … 최대 25. */
export function annualDaysForAnniversary(k: number, policy = DEFAULT_LEAVE_POLICY): number {
  const increment = policy.seniorityIncrement ? Math.floor(Math.max(0, k - 1) / 2) : 0;
  return Math.min(policy.maxAnnualDays, policy.annualDays + increment);
}

export type GrantKind = "MONTHLY" | "ANNUAL";
export type GrantAdjustment = { grantKey: string; status?: "EXCLUDED"; units?: number; note?: string };
export type LeaveGrant = {
  key: string; kind: GrantKind; sequence: number; label: string;
  periodStart: string; periodEnd: string; grantDate: string; expiresAt: string;
  units: number; status: "GRANTED" | "NOT_DUE" | "EXCLUDED"; note: string;
  used: number; remaining: number; expired: boolean;
};
export type LeaveUsage = { id: string; date: string; kind: LeaveKind; units: number; deducts: boolean; note?: string };
export type LeaveLedgerInput = {
  employeeId: string; joinDate: string; exitDate?: string; today: string;
  usages: LeaveUsage[]; adjustments?: GrantAdjustment[]; policy?: LeavePolicy;
};

/** 입사일·퇴직일·기준일에서 발생 목록을 만든다. 사용량은 아직 배분하지 않는다. */
export function buildLeaveGrants(input: Pick<LeaveLedgerInput, "joinDate" | "exitDate" | "today" | "adjustments" | "policy">): LeaveGrant[] {
  const policy = input.policy ?? DEFAULT_LEAVE_POLICY;
  const joinDate = normalizeDate(input.joinDate);
  if (!joinDate) return [];
  const exitDate = normalizeDate(input.exitDate ?? "");
  const cutoff = exitDate && exitDate < input.today ? exitDate : input.today;
  const adjustmentByKey = new Map((input.adjustments ?? []).map((item) => [item.grantKey, item]));
  const grants: LeaveGrant[] = [];
  const firstAnniversary = addMonths(joinDate, 12);
  // 월차 — 1~11개월차. 발생일은 입사일 + n개월, 소멸은 입사 1주년.
  for (let n = 1; n <= 11; n += 1) {
    const grantDate = addMonths(joinDate, n);
    if (exitDate && grantDate > exitDate) break;
    const key = `MONTHLY-${n}`;
    const adjustment = adjustmentByKey.get(key);
    const status = adjustment?.status === "EXCLUDED" ? "EXCLUDED" : grantDate <= cutoff ? "GRANTED" : "NOT_DUE";
    grants.push({
      key, kind: "MONTHLY", sequence: n, label: `${n}개월차 월차`,
      periodStart: addMonths(joinDate, n - 1), periodEnd: addDays(grantDate, -1), grantDate, expiresAt: firstAnniversary,
      units: status === "EXCLUDED" ? 0 : adjustment?.units ?? 1, status, note: adjustment?.note ?? "",
      used: 0, remaining: 0, expired: false,
    });
  }
  // 연차 — k주년마다. 기준일(또는 퇴직일)까지 도래한 것만 GRANTED, 다음 1건은 NOT_DUE 로 보여 준다.
  for (let k = 1; k <= 60; k += 1) {
    const grantDate = addMonths(joinDate, 12 * k);
    if (exitDate && grantDate > exitDate) break;
    const key = `ANNUAL-${k}`;
    const adjustment = adjustmentByKey.get(key);
    const status = adjustment?.status === "EXCLUDED" ? "EXCLUDED" : grantDate <= cutoff ? "GRANTED" : "NOT_DUE";
    grants.push({
      key, kind: "ANNUAL", sequence: k, label: `${k}주년 연차`,
      periodStart: addMonths(joinDate, 12 * (k - 1)), periodEnd: addDays(grantDate, -1), grantDate, expiresAt: addMonths(grantDate, policy.expiryMonths),
      units: status === "EXCLUDED" ? 0 : adjustment?.units ?? annualDaysForAnniversary(k, policy), status, note: adjustment?.note ?? "",
      used: 0, remaining: 0, expired: false,
    });
    if (status === "NOT_DUE") break;
  }
  return grants;
}

export type PromotionNotice = { grantKey: string; label: string; expiresAt: string; remaining: number; stage: "FIRST" | "SECOND"; daysLeft: number };
export type LeaveLedger = {
  employeeId: string; joinDate: string; exitDate: string; today: string;
  grants: LeaveGrant[];
  /** 부여 합계(제외분 빼고), 차감 사용 합계, 소멸 합계, 쓸 수 있는 잔여. */
  granted: number; used: number; expired: number; balance: number;
  /** 이미 발생한 월차·연차의 종류별 누계. 예정·제외분은 포함하지 않는다. */
  grantedByKind: Record<LeaveGrant["kind"], number>;
  /** 어느 발생분에도 붙지 못한 사용(초과 사용). 잔여를 음수로 만든다. */
  overdraft: number;
  promotions: PromotionNotice[];
  /** 차감하지 않는 기록(생일 반차·공가 등)의 일수 합. */
  nonDeductedUnits: number;
};

/** 사용을 발생분에 배분해 잔여·소멸·촉진 대상을 낸다. 사용은 그 날짜에 이미 발생했고 아직 소멸하지 않은
 *  발생분 가운데 소멸이 가장 이른 것부터 쓴다(FIFO). 붙일 곳이 없으면 초과 사용으로 남긴다. */
export function computeLeaveLedger(input: LeaveLedgerInput): LeaveLedger {
  const policy = input.policy ?? DEFAULT_LEAVE_POLICY;
  const grants = buildLeaveGrants(input);
  const today = input.today;
  const pool = grants.filter((grant) => grant.status === "GRANTED").map((grant) => ({ grant, left: grant.units }));
  let overdraft = 0;
  const deducting = input.usages.filter((usage) => usage.deducts).map((usage) => ({ ...usage, date: normalizeDate(usage.date) || usage.date }))
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const usage of deducting) {
    let needed = usage.units;
    // 회사 관행상 그 해 발생분을 앞당겨 쓸 수 있다(시트도 발생 합계 − 사용 합계만 본다). 그래서 발생일이 사용일보다
    // 늦어도 기준일까지 발생한 것이면 붙이고, 소멸이 지난 발생분에는 붙이지 않는다.
    const candidates = pool.filter((item) => item.left > 0 && usage.date < item.grant.expiresAt)
      .sort((a, b) => a.grant.expiresAt.localeCompare(b.grant.expiresAt) || a.grant.grantDate.localeCompare(b.grant.grantDate));
    for (const item of candidates) {
      if (needed <= 0) break;
      const take = Math.min(item.left, needed);
      item.left -= take; item.grant.used += take; needed -= take;
    }
    if (needed > 0) overdraft += needed;
  }
  let granted = 0, used = 0, expired = 0, balance = 0;
  const grantedByKind = { MONTHLY: 0, ANNUAL: 0 };
  for (const item of pool) {
    const grant = item.grant;
    grant.remaining = item.left;
    grant.expired = grant.expiresAt <= today;
    granted += grant.units; used += grant.used;
    grantedByKind[grant.kind] += grant.units;
    if (grant.expired) expired += grant.remaining; else balance += grant.remaining;
  }
  balance -= overdraft;
  // 촉진 대상 — 소멸일이 같은 발생분(월차 5~8개월차 등)은 안내문 하나로 묶는다. 사람은 발생 건이 아니라 소멸일 기준으로 받는다.
  const promotionGroups = new Map<string, { grants: LeaveGrant[]; remaining: number }>();
  for (const item of pool) {
    if (item.grant.expired || item.left <= 0) continue;
    const group = promotionGroups.get(item.grant.expiresAt) ?? { grants: [], remaining: 0 };
    group.grants.push(item.grant); group.remaining += item.left;
    promotionGroups.set(item.grant.expiresAt, group);
  }
  const promotions: PromotionNotice[] = [...promotionGroups.entries()]
    .map(([expiresAt, group]) => ({ expiresAt, group, daysLeft: daysBetween(today, expiresAt) }))
    .filter(({ daysLeft }) => daysLeft <= policy.promotionFirstDays)
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
    .map(({ expiresAt, group, daysLeft }) => {
      const monthly = group.grants.filter((grant) => grant.kind === "MONTHLY");
      const annual = group.grants.filter((grant) => grant.kind === "ANNUAL");
      const parts = [
        monthly.length ? (monthly.length === 1 ? monthly[0].label : `${monthly[0].sequence}~${monthly[monthly.length - 1].sequence}개월차 월차`) : "",
        ...annual.map((grant) => grant.label),
      ].filter(Boolean);
      return {
        grantKey: group.grants.map((grant) => grant.key).join("+"), label: parts.join(" · "), expiresAt, remaining: group.remaining,
        stage: daysLeft <= policy.promotionSecondDays ? "SECOND" as const : "FIRST" as const, daysLeft,
      };
    });
  const nonDeductedUnits = input.usages.filter((usage) => !usage.deducts).reduce((sum, usage) => sum + usage.units, 0);
  return {
    employeeId: input.employeeId, joinDate: normalizeDate(input.joinDate), exitDate: normalizeDate(input.exitDate ?? ""), today,
    grants, granted, grantedByKind, used: used + overdraft, expired, balance, overdraft, promotions, nonDeductedUnits,
  };
}

/** 촉진 안내문(하이웍스 메일 본문). 1차는 사용 시기 지정을 요청하고, 2차는 회사가 지정한 사용일을 통보한다. */
export function promotionNoticeText(employeeName: string, notice: PromotionNotice, companyName = "(주)엑스디노드"): string {
  const days = `${notice.remaining}일`;
  if (notice.stage === "FIRST") {
    return [`${employeeName}님, ${companyName} 인사팀입니다.`,
      `${notice.label}(발생분) 중 미사용 연차 ${days}이 ${notice.expiresAt}에 소멸됩니다.`,
      `근로기준법 제61조에 따라 미사용 연차의 사용 시기를 이 안내를 받은 날부터 10일 이내에 인사팀에 알려 주시기 바랍니다.`,
      `기한 내에 회신이 없으면 회사가 사용 시기를 지정해 통보하며, 지정된 날짜에 사용하지 않은 연차는 보상 없이 소멸됩니다.`].join("\n");
  }
  return [`${employeeName}님, ${companyName} 인사팀입니다.`,
    `${notice.label}(발생분) 미사용 연차 ${days}에 대해 사용 시기 회신이 없어 회사가 사용일을 지정합니다.`,
    `소멸일 ${notice.expiresAt} 이전의 지정일에 연차를 사용해 주시기 바라며, 지정된 날짜에 사용하지 않은 연차는 보상 없이 소멸됩니다.`].join("\n");
}
