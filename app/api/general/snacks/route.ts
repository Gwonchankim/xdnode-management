import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { authorizeErpRequest, erpError, writeErpAudit } from "../../../erp-platform";
import { ensureGaSchema } from "../../../ga-schema";
import { attachmentDownloadHeaders, checkUploadRequest, uploadedLengthOk } from "../../../attachment-rules";
import { isDate } from "../../../ga-alerts";
import { SNACK_MAX_ITEMS } from "../../../ga-extract";
import { gaConflict, gaId, gaNotFound, gaValidation, readBody } from "../../../ga-server";

// 간식 구입(general-affairs GA-D10). GET(general:read) 목록·영수증 다운로드, POST(general:write) 기록·수정·삭제, PUT(general:write) 영수증(캡처) 올리기.
// 구입 1건 = 머리(구입일·구입처·배송비·할인·결제 총액) + 제품 줄(이름·수량·단가·금액). 제품 합계는 서버가 줄에서 다시 계산한다.
// 감사에는 id·줄 수·금액만 남긴다(제품명·구입처 없음).
const bindings = env as unknown as { DB: D1Database; HR_AUDIO: R2Bucket };
const db = bindings.DB;
const MAX_MONEY = 100_000_000;

type PurchaseRow = { id: string; purchased_on: string; vendor: string; items_total: number; shipping_fee: number; discount: number; total_amount: number; memo: string; updated_at: number };
type ItemRow = { purchase_id: string; position: number; name: string; quantity: number; unit_price: number; amount: number };
type ReceiptRow = { id: string; purchase_id: string; file_name: string; content_type: string; size: number; storage_key: string };

function money(value: unknown, label: string, field: string) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY) throw new SnackError(`${label}은(는) 0 이상의 정수(원)입니다.`, field);
  return value;
}
class SnackError extends Error { constructor(message: string, public field: string) { super(message); } }

function readPurchase(payload: Record<string, unknown>) {
  const purchasedOn = payload.purchasedOn;
  if (!isDate(purchasedOn)) throw new SnackError("구입일을 2026-10-01 형식으로 입력해 주세요.", "purchasedOn");
  const vendor = typeof payload.vendor === "string" ? payload.vendor.trim().slice(0, 80) : "";
  const memo = typeof payload.memo === "string" ? payload.memo.trim().slice(0, 1000) : "";
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (!rawItems.length) throw new SnackError("제품을 한 줄 이상 입력해 주세요.", "items");
  if (rawItems.length > SNACK_MAX_ITEMS) throw new SnackError(`제품은 ${SNACK_MAX_ITEMS}줄까지입니다.`, "items");
  const items = rawItems.map((raw, index) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 120) : "";
    if (!name) throw new SnackError(`${index + 1}번째 줄의 제품명을 입력해 주세요.`, "items");
    const quantity = row.quantity;
    if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100_000) throw new SnackError(`${index + 1}번째 줄(${name})의 수량을 확인해 주세요.`, "items");
    const unitPrice = money(row.unitPrice, `${index + 1}번째 줄 단가`, "items");
    const amount = row.amount === undefined || row.amount === null ? unitPrice * quantity : money(row.amount, `${index + 1}번째 줄 금액`, "items");
    return { name, quantity, unitPrice, amount };
  });
  const itemsTotal = items.reduce((sum, item) => sum + item.amount, 0);
  const shippingFee = money(payload.shippingFee, "배송비", "shippingFee");
  const discount = money(payload.discount, "할인", "discount");
  const total = payload.totalAmount === undefined || payload.totalAmount === null || payload.totalAmount === ""
    ? Math.max(0, itemsTotal + shippingFee - discount) : money(payload.totalAmount, "결제 총액", "totalAmount");
  return { purchasedOn, vendor, memo, items, itemsTotal, shippingFee, discount, total };
}

/** 제품 줄 INSERT. onlyIfStamped 를 주면 머리 행의 updated_at 이 그 값일 때만 넣는다(같은 batch 의 수정이 반영됐을 때만). */
function itemStatements(purchaseId: string, items: Array<{ name: string; quantity: number; unitPrice: number; amount: number }>, onlyIfStamped?: number) {
  return items.map((item, position) => db.prepare(`INSERT INTO ga_snack_items (id, purchase_id, position, name, quantity, unit_price, amount)
    SELECT ?, ?, ?, ?, ?, ?, ?${onlyIfStamped === undefined ? "" : " WHERE EXISTS (SELECT 1 FROM ga_snack_purchases WHERE id = ? AND updated_at = ?)"}`)
    .bind(gaId("gasi"), purchaseId, position, item.name, item.quantity, item.unitPrice, item.amount, ...(onlyIfStamped === undefined ? [] : [purchaseId, onlyIfStamped])));
}

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "read");
  if (authorization.response) return authorization.response;
  await ensureGaSchema(db);
  const params = new URL(request.url).searchParams;
  const receiptId = params.get("receiptId");
  if (receiptId) {
    const receipt = await db.prepare(`SELECT r.* FROM ga_snack_receipts r JOIN ga_snack_purchases p ON p.id = r.purchase_id
      WHERE r.id = ? AND r.deleted_at IS NULL AND p.deleted_at IS NULL`).bind(receiptId.slice(0, 80)).first<ReceiptRow>();
    if (!receipt) return gaNotFound("영수증");
    const object = await bindings.HR_AUDIO.get(receipt.storage_key);
    if (!object) return gaNotFound("영수증");
    return new Response(object.body, { headers: attachmentDownloadHeaders(receipt.file_name, receipt.content_type) });
  }
  const from = params.get("from");
  const to = params.get("to");
  const where = ["deleted_at IS NULL"];
  const binds: unknown[] = [];
  if (isDate(from)) { where.push("purchased_on >= ?"); binds.push(from); }
  if (isDate(to)) { where.push("purchased_on <= ?"); binds.push(to); }
  const purchases = (await db.prepare(`SELECT * FROM ga_snack_purchases WHERE ${where.join(" AND ")} ORDER BY purchased_on DESC, created_at DESC LIMIT 500`)
    .bind(...binds).all<PurchaseRow>()).results;
  const ids = purchases.map((row) => row.id);
  const items = new Map<string, ItemRow[]>();
  const receipts = new Map<string, ReceiptRow[]>();
  for (let index = 0; index < ids.length; index += 90) {
    const group = ids.slice(index, index + 90);
    const marks = group.map(() => "?").join(",");
    for (const row of (await db.prepare(`SELECT * FROM ga_snack_items WHERE purchase_id IN (${marks}) ORDER BY position`).bind(...group).all<ItemRow>()).results) {
      items.set(row.purchase_id, [...(items.get(row.purchase_id) ?? []), row]);
    }
    for (const row of (await db.prepare(`SELECT * FROM ga_snack_receipts WHERE purchase_id IN (${marks}) AND deleted_at IS NULL ORDER BY created_at`).bind(...group).all<ReceiptRow>()).results) {
      receipts.set(row.purchase_id, [...(receipts.get(row.purchase_id) ?? []), row]);
    }
  }
  return Response.json({
    purchases: purchases.map((row) => ({
      id: row.id, purchasedOn: row.purchased_on, vendor: row.vendor, itemsTotal: row.items_total, shippingFee: row.shipping_fee, discount: row.discount,
      totalAmount: row.total_amount, memo: row.memo, updatedAt: row.updated_at,
      items: (items.get(row.id) ?? []).map((item) => ({ name: item.name, quantity: item.quantity, unitPrice: item.unit_price, amount: item.amount })),
      receipts: (receipts.get(row.id) ?? []).map((receipt) => ({ id: receipt.id, fileName: receipt.file_name, size: receipt.size, isImage: receipt.content_type.startsWith("image/"),
        url: `/api/general/snacks?receiptId=${encodeURIComponent(receipt.id)}` })),
    })),
  });
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  await ensureGaSchema(db);
  const payload = await readBody(request);
  if (!payload) return gaValidation("요청 내용을 읽을 수 없습니다.");
  const now = Date.now();
  try {
    if (payload.action === "CREATE") {
      const purchase = readPurchase(payload);
      const id = gaId("gasp");
      await db.batch([
        db.prepare(`INSERT INTO ga_snack_purchases (id, purchased_on, vendor, items_total, shipping_fee, discount, total_amount, memo, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, purchase.purchasedOn, purchase.vendor, purchase.itemsTotal, purchase.shippingFee, purchase.discount,
          purchase.total, purchase.memo, principal.userId, now, now),
        ...itemStatements(id, purchase.items),
      ]);
      await writeErpAudit(db, { principal, module: "general", action: "GA_SNACK_PURCHASE_CREATED", entityType: "GA_SNACK_PURCHASE", entityId: id,
        after: { purchasedOn: purchase.purchasedOn, items: purchase.items.length, totalAmount: purchase.total } });
      return Response.json({ id }, { status: 201 });
    }
    const current = typeof payload.id === "string"
      ? await db.prepare(`SELECT * FROM ga_snack_purchases WHERE id = ? AND deleted_at IS NULL`).bind(payload.id).first<PurchaseRow>() : null;
    if (!current) return gaNotFound("구입 기록");
    if (payload.action === "UPDATE") {
      const purchase = readPurchase(payload);
      const results = await db.batch([
        db.prepare(`UPDATE ga_snack_purchases SET purchased_on = ?, vendor = ?, items_total = ?, shipping_fee = ?, discount = ?, total_amount = ?, memo = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL AND updated_at = ?`).bind(purchase.purchasedOn, purchase.vendor, purchase.itemsTotal, purchase.shippingFee, purchase.discount,
          purchase.total, purchase.memo, now, current.id, typeof payload.updatedAt === "number" ? payload.updatedAt : current.updated_at),
        // 머리 행 수정이 반영됐을 때만(updated_at 이 이번 시각) 줄을 갈아 끼운다. 한 batch 라 중간에 실패하면 전부 되돌아간다.
        db.prepare(`DELETE FROM ga_snack_items WHERE purchase_id = ? AND EXISTS (SELECT 1 FROM ga_snack_purchases WHERE id = ? AND updated_at = ?)`).bind(current.id, current.id, now),
        ...itemStatements(current.id, purchase.items, now),
      ]);
      if (!results[0]?.meta?.changes) return gaConflict();
      await writeErpAudit(db, { principal, module: "general", action: "GA_SNACK_PURCHASE_UPDATED", entityType: "GA_SNACK_PURCHASE", entityId: current.id,
        before: { totalAmount: current.total_amount }, after: { items: purchase.items.length, totalAmount: purchase.total } });
      return Response.json({ id: current.id });
    }
    if (payload.action === "DELETE") {
      await db.batch([
        db.prepare(`UPDATE ga_snack_purchases SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).bind(now, now, current.id),
        db.prepare(`UPDATE ga_snack_receipts SET deleted_at = ? WHERE purchase_id = ? AND deleted_at IS NULL`).bind(now, current.id),
      ]);
      await writeErpAudit(db, { principal, module: "general", action: "GA_SNACK_PURCHASE_DELETED", entityType: "GA_SNACK_PURCHASE", entityId: current.id,
        before: { purchasedOn: current.purchased_on, totalAmount: current.total_amount } });
      return Response.json({ ok: true });
    }
    return gaValidation("알 수 없는 요청입니다.", "action");
  } catch (error) {
    if (error instanceof SnackError) return gaValidation(error.message, error.field);
    throw error;
  }
}

/** 영수증(주문내역 캡처) 올리기. 첨부 공용 규칙(크기 411·413, 형식 415)을 그대로 쓴다. */
export async function PUT(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  await ensureGaSchema(db);
  const params = new URL(request.url).searchParams;
  const purchaseId = params.get("purchaseId") ?? "";
  const purchase = await db.prepare(`SELECT id FROM ga_snack_purchases WHERE id = ? AND deleted_at IS NULL`).bind(purchaseId.slice(0, 80)).first<{ id: string }>();
  if (!purchase) return gaNotFound("구입 기록");
  const check = checkUploadRequest(request.headers.get("content-length") ?? (await headers()).get("content-length"), params.get("name") ?? "");
  if (!check.ok) return erpError(check.status, check.code, check.error);
  const bytes = await request.arrayBuffer();
  if (!uploadedLengthOk(bytes, check.declared)) return erpError(413, "PAYLOAD_TOO_LARGE", "파일은 25MB까지 올릴 수 있습니다.");
  const id = gaId("gasr");
  const key = `ga/SNACK/${purchase.id}/${id}`;
  await bindings.HR_AUDIO.put(key, bytes, { httpMetadata: { contentType: check.contentType } });
  try {
    await db.prepare(`INSERT INTO ga_snack_receipts (id, purchase_id, file_name, content_type, size, storage_key, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, purchase.id, check.fileName, check.contentType, bytes.byteLength, key, principal.userId, Date.now()).run();
  } catch (error) {
    await bindings.HR_AUDIO.delete(key);
    throw error;
  }
  await writeErpAudit(db, { principal, module: "general", action: "GA_SNACK_RECEIPT_UPLOADED", entityType: "GA_SNACK_RECEIPT", entityId: id,
    after: { purchaseId: purchase.id, size: bytes.byteLength, contentType: check.contentType } });
  return Response.json({ id }, { status: 201 });
}
