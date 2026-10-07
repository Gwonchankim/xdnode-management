import { env } from "cloudflare:workers";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { ensureQuoteSchema } from "../../../quote-schema";
import { QUOTE_LIMITS, cleanText, codePoints } from "../../../quote-model";
import { pyStrip } from "../../../quote-pyfmt";
import { quoteConflict, quoteValidation, readJsonCapped } from "../../../quote-server";

// quote-tool Design §3.2 /api/quote/staff — 견적서에 찍히는 담당자 블록 프로필(QT-Q3, QT-FR-12). 옛 /api/staff·quote_gen/staff.py 대응.
//   GET            활성 프로필(sort 순) {items:[{id, name, tel, email, accountId, sort}]} (quote:read)
//   POST SAVE      목록 전체를 저장한다(quote:write). 이름만 필수, 앞뒤 공백 정리, 같은 이름은 뒤엣것을 버린다(옛 normalize).
//                  0명이면 400. 저장 전 목록을 함께 돌려준다(공유 목록이라 되돌릴 수 있게). 목록에서 빠진 프로필은 행을 남기고 active = 0.
// 감사 after 에는 건수만 넣는다(이름·전화·메일 없음, QT-FR-17).
const db = (env as unknown as { DB: D1Database }).DB;
const BODY_CAP = 64 * 1024;
const MAX_ITEMS = 50;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type StaffRow = { id: string; name: string; tel: string; email: string; account_id: string | null; sort: number };
type StaffItem = { id: string | null; name: string; tel: string; email: string; accountId: string | null };

const dto = (row: StaffRow) => ({ id: row.id, name: row.name, tel: row.tel, email: row.email, accountId: row.account_id, sort: Number(row.sort) });

async function activeProfiles() {
  const rows = await db.prepare(`SELECT id, name, tel, email, account_id, sort FROM quote_staff_profiles WHERE active = 1 ORDER BY sort, created_at, id`).all<StaffRow>();
  return rows.results;
}

function text(value: unknown, field: string, label: string, max: number): string | Response {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return quoteValidation(`${label} 값을 확인해 주세요.`, field);
  const cleaned = pyStrip(cleanText(value).replace(/\n/g, " "));
  if (codePoints(cleaned) > max) return quoteValidation(`${label}은(는) ${max}자까지입니다.`, field);
  return cleaned;
}

/** 옛 staff.normalize: 이름 필수, 공백 정리, 같은 이름은 앞 것을 남긴다. 형식이 틀린 칸은 400. */
function readItems(raw: unknown): StaffItem[] | Response {
  if (!Array.isArray(raw)) return quoteValidation("담당자 목록을 확인해 주세요.", "items");
  if (raw.length > MAX_ITEMS) return quoteValidation(`담당자는 ${MAX_ITEMS}명까지입니다.`, "items");
  const out: StaffItem[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const field = `items[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return quoteValidation("담당자 항목을 읽을 수 없습니다.", field);
    const item = entry as Record<string, unknown>;
    const name = text(item.name, `${field}.name`, "담당자 이름", QUOTE_LIMITS.staffName);
    if (name instanceof Response) return name;
    const tel = text(item.tel, `${field}.tel`, "담당자 전화", QUOTE_LIMITS.staffTel);
    if (tel instanceof Response) return tel;
    const email = text(item.email, `${field}.email`, "담당자 메일", QUOTE_LIMITS.staffEmail);
    if (email instanceof Response) return email;
    if (email && !EMAIL.test(email)) return quoteValidation("담당자 메일 형식을 확인해 주세요.", `${field}.email`);
    let id: string | null = null;
    if (item.id !== undefined && item.id !== null && item.id !== "") {
      if (typeof item.id !== "string" || !/^qsp_[0-9a-zA-Z-]{1,64}$/.test(item.id)) return quoteValidation("담당자 번호를 확인해 주세요.", `${field}.id`);
      if (ids.has(item.id)) return quoteValidation("같은 담당자가 두 번 들어 있습니다.", `${field}.id`);
      ids.add(item.id);
      id = item.id;
    }
    let accountId: string | null = null;
    if (item.accountId !== undefined && item.accountId !== null && item.accountId !== "") {
      if (typeof item.accountId !== "string" || item.accountId.length > 80) return quoteValidation("연결 계정을 확인해 주세요.", `${field}.accountId`);
      accountId = item.accountId;
    }
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ id, name, tel, email, accountId });
  }
  return out;
}

export async function GET() {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "read");
  if (authorization.response) return authorization.response;
  return Response.json({ items: (await activeProfiles()).map(dto) });
}

export async function POST(request: Request) {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const read = await readJsonCapped(request, BODY_CAP);
  if (read.response) return read.response;
  if (read.body.action !== "SAVE") return quoteValidation("알 수 없는 요청입니다.", "action");
  const items = readItems(read.body.items);
  if (items instanceof Response) return items;
  if (!items.length) return quoteValidation("담당자를 최소 한 명은 남겨야 합니다.", "items");

  const accountIds = [...new Set(items.map((item) => item.accountId).filter((id): id is string => Boolean(id)))];
  if (accountIds.length) {
    const known = await db.prepare(`SELECT id FROM auth_accounts WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(accountIds)).all<{ id: string }>();
    const found = new Set(known.results.map((row) => row.id));
    const missing = items.findIndex((item) => item.accountId && !found.has(item.accountId));
    if (missing >= 0) return quoteValidation("연결 계정을 찾을 수 없습니다.", `items[${missing}].accountId`);
  }

  const before = await activeProfiles();
  const beforeById = new Map(before.map((row) => [row.id, row]));
  if (items.some((item) => item.id !== null && !beforeById.has(item.id))) return quoteConflict();
  const keptIds = new Set(items.map((item) => item.id).filter((id): id is string => id !== null));
  const removed = before.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
  const now = Date.now();
  let added = 0;
  let changed = 0;
  // 이름을 서로 바꾸는 저장도 되게, 지금 활성인 행을 먼저 모두 내리고(활성 이름 유일 인덱스) 남길 행을 새 값으로 다시 올린다.
  // 그사이 다른 사람이 같은 이름을 새로 넣었으면 유일 인덱스가 막아 batch 전체가 되돌아간다(409).
  const statements: D1PreparedStatement[] = [];
  if (before.length) {
    statements.push(db.prepare(`UPDATE quote_staff_profiles SET active = 0 WHERE active = 1 AND id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(before.map((row) => row.id))));
  }
  items.forEach((item, sort) => {
    if (item.id !== null) {
      const old = beforeById.get(item.id) as StaffRow;
      const different = old.name !== item.name || old.tel !== item.tel || old.email !== item.email || (old.account_id ?? null) !== item.accountId || Number(old.sort) !== sort;
      if (different) changed += 1;
      statements.push(db.prepare(`UPDATE quote_staff_profiles SET name = ?1, tel = ?2, email = ?3, account_id = ?4, sort = ?5, active = 1,
        updated_at = CASE WHEN ?6 = 1 THEN ?7 ELSE updated_at END WHERE id = ?8`).bind(item.name, item.tel, item.email, item.accountId, sort, different ? 1 : 0, now, item.id));
    } else {
      added += 1;
      statements.push(db.prepare(`INSERT INTO quote_staff_profiles (id, name, tel, email, account_id, sort, active, legacy, created_by, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?7, ?8, ?8)`).bind(`qsp_${crypto.randomUUID()}`, item.name, item.tel, item.email, item.accountId, sort, principal.accountId, now));
    }
  });
  if (removed.length) {
    statements.push(db.prepare(`UPDATE quote_staff_profiles SET updated_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))`).bind(now, JSON.stringify(removed)));
  }
  try {
    await db.batch(statements);
  } catch (error) {
    if (/UNIQUE|constraint/i.test(String((error as Error)?.message ?? error))) return quoteConflict();
    throw error;
  }
  const after = await activeProfiles();
  await writeErpAudit(db, {
    principal, module: "quote", action: "QUOTE_STAFF_SAVED", entityType: "QUOTE_STAFF", entityId: "staff",
    before: { count: before.length }, after: { before: before.length, after: after.length, added, removed: removed.length, changed },
  });
  return Response.json({ items: after.map(dto), before: before.map(dto) });
}
