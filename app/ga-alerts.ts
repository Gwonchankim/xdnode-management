// 총무 알림·감가상각 계산(general-affairs Design §3, GD-5·GD-6·GD-12). 순수 함수만 둔다(import 없음).
// 서버(현황·배지·알림 실행)와 화면이 함께 쓴다. 날짜는 'YYYY-MM-DD'(한국 시간 달력 날짜) 문자열이다.

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type AlertBucket = "OVERDUE" | "TODAY" | "D7" | "D30" | "LOW_STOCK";
export type AlertKind = "CONTRACT_END" | "DOC_EXPIRY" | "DOC_NOTICE" | "CHECKOUT_DUE" | "LOW_STOCK";
export type AlertItem = {
  key: string; kind: AlertKind; ownerType: "ASSET" | "DOCUMENT" | "CHECKOUT"; ownerId: string;
  title: string; detail: string; dueOn: string | null; daysLeft: number | null; bucket: AlertBucket;
};

/** 더 급한 순서. newlyEntered 가 '더 급해졌을 때만' 알리는 기준이다. */
const URGENCY: Record<AlertBucket, number> = { LOW_STOCK: 0, D30: 1, D7: 2, TODAY: 3, OVERDUE: 4 };

export function kstToday(now: number) {
  return new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dayNumber(date: string) {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/** to - from (일). */
export function daysBetween(from: string, to: string) {
  return dayNumber(to) - dayNumber(from);
}

export function addDays(date: string, days: number) {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** 월 더하기. 말일을 보정한다(1/31 + 1개월 → 2/28·2/29). */
export function addMonths(date: string, months: number) {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** 기준일까지 남은 날로 구간을 정한다. <0 경과, 0 당일, 1~7 D-7, 8~30 D-30, 그 밖은 null. */
export function bucketOf(dueOn: string, today: string): AlertBucket | null {
  const left = daysBetween(today, dueOn);
  if (left < 0) return "OVERDUE";
  if (left === 0) return "TODAY";
  if (left <= 7) return "D7";
  if (left <= 30) return "D30";
  return null;
}

export type AlertAssetRow = {
  id: string; kind: string; name: string; status: string; ends_on: string | null; alert_off: number;
  quantity: number; min_quantity: number; unit: string; counterparty: string; deleted_at: number | null;
};
export type AlertDocumentRow = {
  id: string; kind: string; title: string; expires_on: string | null; issued_on: string | null; validity_months: number;
  ends_on: string | null; auto_renew: number; notice_days: number; counterparty: string; alert_off: number; deleted_at: number | null;
};
export type AlertCheckoutRow = {
  id: string; target_name: string; borrower_name: string; due_on: string | null; returned_on: string | null; cancelled_at: number | null;
};

/** 회사 서류의 만료일: expires_on, 없으면 발급일 + 유효기간(개월). */
export function documentExpiry(row: Pick<AlertDocumentRow, "expires_on" | "issued_on" | "validity_months">) {
  if (isDate(row.expires_on)) return row.expires_on;
  if (isDate(row.issued_on) && row.validity_months > 0) return addMonths(row.issued_on, row.validity_months);
  return null;
}

export function collectAlerts(input: { assets: AlertAssetRow[]; documents: AlertDocumentRow[]; checkouts: AlertCheckoutRow[]; today: string }): AlertItem[] {
  const { today } = input;
  const out: AlertItem[] = [];
  const push = (item: Omit<AlertItem, "bucket" | "daysLeft">, bucket: AlertBucket | null) => {
    if (!bucket) return;
    out.push({ ...item, bucket, daysLeft: item.dueOn ? daysBetween(today, item.dueOn) : null });
  };
  for (const asset of input.assets) {
    if (asset.deleted_at !== null || asset.status === "DISPOSED") continue;
    if (asset.kind === "CONTRACT" && asset.status === "ACTIVE" && asset.alert_off !== 1 && isDate(asset.ends_on)) {
      push({ key: `asset:${asset.id}:end`, kind: "CONTRACT_END", ownerType: "ASSET", ownerId: asset.id, title: asset.name,
        detail: asset.counterparty ? `${asset.counterparty} · 만료` : "만료", dueOn: asset.ends_on }, bucketOf(asset.ends_on, today));
    }
    if (asset.kind === "SUPPLY" && asset.min_quantity > 0 && asset.quantity < asset.min_quantity && asset.alert_off !== 1) {
      push({ key: `asset:${asset.id}:stock`, kind: "LOW_STOCK", ownerType: "ASSET", ownerId: asset.id, title: asset.name,
        detail: `재고 ${asset.quantity}${asset.unit} / 최소 ${asset.min_quantity}${asset.unit}`, dueOn: null }, "LOW_STOCK");
    }
  }
  for (const document of input.documents) {
    if (document.deleted_at !== null || document.alert_off === 1) continue;
    if (document.kind === "B2B_CONTRACT") {
      const ends = isDate(document.ends_on) ? document.ends_on : null;
      if (ends && document.notice_days > 0) {
        const notice = addDays(ends, -document.notice_days);
        push({ key: `doc:${document.id}:notice`, kind: "DOC_NOTICE", ownerType: "DOCUMENT", ownerId: document.id, title: document.title,
          detail: `${document.counterparty ? `${document.counterparty} · ` : ""}해지 통보 기한`, dueOn: notice }, bucketOf(notice, today));
      }
      // 자동 연장 계약은 종료일을 알리지 않는다(해지 통보 기한만, GA-D2).
      if (ends && document.auto_renew !== 1) {
        push({ key: `doc:${document.id}:expiry`, kind: "DOC_EXPIRY", ownerType: "DOCUMENT", ownerId: document.id, title: document.title,
          detail: `${document.counterparty ? `${document.counterparty} · ` : ""}계약 종료`, dueOn: ends }, bucketOf(ends, today));
      }
      continue;
    }
    const expiry = documentExpiry(document);
    if (expiry) {
      push({ key: `doc:${document.id}:expiry`, kind: "DOC_EXPIRY", ownerType: "DOCUMENT", ownerId: document.id, title: document.title,
        detail: "만료", dueOn: expiry }, bucketOf(expiry, today));
    }
  }
  for (const checkout of input.checkouts) {
    if (checkout.returned_on || checkout.cancelled_at !== null || !isDate(checkout.due_on)) continue;
    push({ key: `checkout:${checkout.id}:due`, kind: "CHECKOUT_DUE", ownerType: "CHECKOUT", ownerId: checkout.id, title: checkout.target_name,
      detail: `${checkout.borrower_name} · 반납 예정`, dueOn: checkout.due_on }, bucketOf(checkout.due_on, today));
  }
  return out.sort((a, b) => URGENCY[b.bucket] - URGENCY[a.bucket] || (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || a.title.localeCompare(b.title, "ko"));
}

/** 탭 배지 수: 경과 + 당일 + D-7. 재고 부족은 넣지 않는다. */
export function badgeCount(items: AlertItem[]) {
  return items.filter((item) => item.bucket === "OVERDUE" || item.bucket === "TODAY" || item.bucket === "D7").length;
}

/**
 * 메신저에 새로 실을 항목: 처음 보거나, 지난번보다 더 급한 구간에 들어왔거나, 기준일이 바뀐(갱신·연장) 항목.
 * marks 는 item_key → { bucket, dueOn } 이다.
 */
export function newlyEntered(items: AlertItem[], marks: Map<string, { bucket: string; dueOn: string | null }>) {
  return items.filter((item) => {
    const mark = marks.get(item.key);
    if (!mark) return true;
    if ((mark.dueOn ?? null) !== (item.dueOn ?? null)) return true;
    return URGENCY[item.bucket] > (URGENCY[mark.bucket as AlertBucket] ?? -1);
  });
}

const BUCKET_LABEL: Record<AlertBucket, string> = { OVERDUE: "⛔ 경과", TODAY: "❗ 당일", D7: "⚠️ D-7", D30: "🗓 D-30", LOW_STOCK: "📦 재고" };
const KIND_LABEL: Record<AlertKind, string> = { CONTRACT_END: "계약", DOC_EXPIRY: "서류", DOC_NOTICE: "서류", CHECKOUT_DUE: "반출", LOW_STOCK: "비품" };
export const ALERT_MESSAGE_MAX = 4000;

function shortDate(date: string) {
  return date.slice(5);
}

export function alertLine(item: AlertItem) {
  const when = item.dueOn === null ? "" : item.daysLeft === null ? "" : item.daysLeft < 0 ? ` (${-item.daysLeft}일 지남)` : item.daysLeft === 0 ? " (오늘)" : ` (${item.daysLeft}일 남음)`;
  const due = item.dueOn ? ` ${shortDate(item.dueOn)}` : "";
  return `${BUCKET_LABEL[item.bucket]}  ${KIND_LABEL[item.kind]} · ${item.title} — ${item.detail}${due}${when}`;
}

/** 메신저 본문. 4000자를 넘으면 뒤를 '외 N건'으로 줄인다. */
export function alertMessage(items: AlertItem[], today: string) {
  const header = `[총무 알림] ${today} (새로 들어온 ${items.length}건)`;
  const footer = "총무 탭 > 현황에서 전체를 확인하세요.";
  const lines: string[] = [];
  let length = header.length + footer.length + 2;
  for (let index = 0; index < items.length; index += 1) {
    const line = alertLine(items[index]);
    const rest = items.length - index;
    if (length + line.length + 1 + 12 > ALERT_MESSAGE_MAX) { lines.push(`… 외 ${rest}건`); break; }
    lines.push(line);
    length += line.length + 1;
  }
  return [header, ...lines, footer].join("\n");
}

// ── 감가상각(정액법 월할, 보관 태그 erp-final-20260923 의 app/fixed-asset-calculation.mjs 이식) ──
export function monthsBetween(from: string, to: string) {
  const [fromYear, fromMonth] = from.split("-").map(Number);
  const [toYear, toMonth] = to.split("-").map(Number);
  return (toYear - fromYear) * 12 + toMonth - fromMonth;
}

export type DepreciationInput = {
  acquisitionCost: number; residualValue: number; usefulLifeMonths: number;
  inServiceMonth: string; openingAccumulated?: number; openingAsOfMonth?: string | null; disposedMonth?: string | null;
};
export type DepreciationRow = { period: string; depreciation: number; accumulated: number; bookValue: number };

/** 입력이 상각 가능한지. 아니면 null(화면은 '상각 정보 없음'). */
export function depreciationValid(input: DepreciationInput) {
  const { acquisitionCost, residualValue, usefulLifeMonths } = input;
  return [acquisitionCost, residualValue, usefulLifeMonths, input.openingAccumulated ?? 0].every(Number.isSafeInteger)
    && acquisitionCost > 0 && residualValue >= 0 && residualValue < acquisitionCost && usefulLifeMonths >= 1
    && /^\d{4}-\d{2}$/.test(input.inServiceMonth) && (input.openingAccumulated ?? 0) >= 0;
}

/**
 * 월별 상각표(취득 월부터 내용연수 동안, 원 단위). 나머지 원은 처음 달부터 1원씩 나눈다.
 * 기초 상각누계(openingAccumulated, openingAsOfMonth 까지 반영된 금액)가 있으면 그 다음 달부터 이어서 계산한다.
 * 처분 월 뒤로는 상각하지 않는다.
 */
export function depreciationSchedule(input: DepreciationInput): DepreciationRow[] {
  if (!depreciationValid(input)) return [];
  const depreciable = input.acquisitionCost - input.residualValue;
  const base = Math.floor(depreciable / input.usefulLifeMonths);
  const remainder = depreciable % input.usefulLifeMonths;
  const openingIndex = input.openingAsOfMonth ? monthsBetween(input.inServiceMonth, input.openingAsOfMonth) : -1;
  const disposedIndex = input.disposedMonth ? monthsBetween(input.inServiceMonth, input.disposedMonth) : Number.POSITIVE_INFINITY;
  const rows: DepreciationRow[] = [];
  let accumulated = 0;
  for (let index = 0; index < input.usefulLifeMonths; index += 1) {
    if (index > disposedIndex) break;
    const [year, month] = input.inServiceMonth.split("-").map(Number);
    const period = new Date(Date.UTC(year, month - 1 + index, 1)).toISOString().slice(0, 7);
    // 기초 상각누계가 있으면 기초 월 전은 표에 싣지 않고, 기초 월 한 줄에 기초 누계를 담는다.
    if (index < openingIndex) continue;
    let amount = index === openingIndex ? (input.openingAccumulated ?? 0)
      : index === input.usefulLifeMonths - 1 ? depreciable - accumulated : base + (index < remainder ? 1 : 0);
    amount = Math.max(0, Math.min(amount, depreciable - accumulated));
    accumulated += amount;
    rows.push({ period, depreciation: amount, accumulated, bookValue: input.acquisitionCost - accumulated });
  }
  return rows;
}

/** 기준 월(포함)까지의 누계와 장부가액. 취득 전이면 누계 0. */
export function depreciationAsOf(input: DepreciationInput, month: string) {
  const schedule = depreciationSchedule(input);
  if (!schedule.length) return null;
  const upTo = schedule.filter((row) => row.period <= month);
  const last = upTo[upTo.length - 1];
  // 기초 상각누계가 있으면 첫 줄은 기초 누계 줄이므로, 월 상각액은 그다음 줄에서 읽는다.
  const regular = input.openingAsOfMonth && schedule[0]?.period === input.openingAsOfMonth ? schedule[1] : schedule[0];
  const monthly = regular?.depreciation ?? 0;
  return { monthly, accumulated: last?.accumulated ?? 0, bookValue: last?.bookValue ?? input.acquisitionCost, schedule };
}
