"use client";

// 총무 → 간식 구입(general-affairs GA-D10). 월 2회 직원 간식 구입을 기록하고 제품별·월별로 정리한다.
// 구입 기록 창에서 주문내역 캡처를 Ctrl+V 로 붙여 넣으면 AI(서버 PC 의 Claude, 도구 모두 끔)가 읽어 제품 표를 채운다.
// 사람이 표를 확인·수정한 뒤 저장한다. 캡처는 영수증으로 함께 보관한다.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useErpDialog } from "./erp-dialog";
import { extractFields } from "./ga-extract-client";
import { gaRequest, won } from "./general-client";

type SnackItem = { name: string; quantity: number; unitPrice: number; amount: number };
type Purchase = {
  id: string; purchasedOn: string; vendor: string; itemsTotal: number; shippingFee: number; discount: number; totalAmount: number; memo: string; updatedAt: number;
  items: SnackItem[]; receipts: Array<{ id: string; fileName: string; isImage: boolean; url: string }>;
};
type Period = "year" | "half" | "all";
const PERIODS: Array<{ key: Period; label: string }> = [{ key: "year", label: "올해" }, { key: "half", label: "최근 6개월" }, { key: "all", label: "전체" }];
const MAX_IMAGES = 4;

const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
function periodRange(period: Period) {
  const today = kstToday();
  if (period === "year") return { from: `${today.slice(0, 4)}-01-01`, to: today };
  if (period === "half") {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() - 6);
    return { from: date.toISOString().slice(0, 10), to: today };
  }
  return { from: "", to: "" };
}

/** 같은 제품은 이름(공백·대소문자 무시)으로 묶는다. */
const productKey = (name: string) => name.replace(/\s+/g, " ").trim().toLowerCase();

export function summarizeSnacks(purchases: Purchase[]) {
  const months = new Map<string, { month: string; count: number; total: number }>();
  const products = new Map<string, { name: string; quantity: number; amount: number; purchases: number; lastOn: string; lastUnitPrice: number }>();
  for (const purchase of [...purchases].sort((a, b) => a.purchasedOn.localeCompare(b.purchasedOn))) {
    const month = purchase.purchasedOn.slice(0, 7);
    const entry = months.get(month) ?? { month, count: 0, total: 0 };
    entry.count += 1;
    entry.total += purchase.totalAmount;
    months.set(month, entry);
    const seen = new Set<string>();
    for (const item of purchase.items) {
      const key = productKey(item.name);
      const product = products.get(key) ?? { name: item.name, quantity: 0, amount: 0, purchases: 0, lastOn: "", lastUnitPrice: 0 };
      product.quantity += item.quantity;
      product.amount += item.amount;
      if (!seen.has(key)) { product.purchases += 1; seen.add(key); }
      product.lastOn = purchase.purchasedOn;
      product.lastUnitPrice = item.unitPrice;
      product.name = item.name;
      products.set(key, product);
    }
  }
  return {
    months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)),
    products: [...products.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "ko")),
  };
}

type Row = { name: string; quantity: string; unitPrice: string; amount: string };
const toRow = (item: SnackItem): Row => ({ name: item.name, quantity: String(item.quantity), unitPrice: String(item.unitPrice), amount: String(item.amount) });
const num = (value: string) => { const parsed = Number(String(value).replace(/[,\s원]/g, "")); return Number.isFinite(parsed) ? Math.round(parsed) : 0; };

function SnackModal({ purchase, onClose, onSaved }: { purchase: Purchase | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [purchasedOn, setPurchasedOn] = useState(purchase?.purchasedOn ?? kstToday());
  const [vendor, setVendor] = useState(purchase?.vendor ?? "");
  const [shippingFee, setShippingFee] = useState(String(purchase?.shippingFee ?? 0));
  const [discount, setDiscount] = useState(String(purchase?.discount ?? 0));
  const [totalAmount, setTotalAmount] = useState(purchase ? String(purchase.totalAmount) : "");
  const [memo, setMemo] = useState(purchase?.memo ?? "");
  const [rows, setRows] = useState<Row[]>(purchase?.items.map(toRow) ?? []);
  const [images, setImages] = useState<Array<{ file: File; url: string }>>([]);
  const [ai, setAi] = useState<{ busy: boolean; message: string }>({ busy: false, message: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const imagesRef = useRef(images);
  useEffect(() => { imagesRef.current = images; });
  useEffect(() => () => { for (const image of imagesRef.current) URL.revokeObjectURL(image.url); }, []);

  const readWithAi = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setAi({ busy: true, message: `AI가 캡처 ${files.length}장을 읽고 있습니다(10~40초)…` });
    setError("");
    try {
      const fields = await extractFields("SNACK", files);
      const items = Array.isArray(fields.items) ? fields.items as SnackItem[] : [];
      if (typeof fields.purchasedOn === "string") setPurchasedOn(fields.purchasedOn);
      if (typeof fields.vendor === "string") setVendor(fields.vendor);
      if (typeof fields.shippingFee === "number") setShippingFee(String(fields.shippingFee));
      if (typeof fields.discount === "number") setDiscount(String(fields.discount));
      if (typeof fields.total === "number") setTotalAmount(String(fields.total));
      if (items.length) setRows(items.map(toRow));
      setAi({ busy: false, message: items.length ? `AI가 제품 ${items.length}줄을 채웠습니다. 수량·단가를 확인한 뒤 저장해 주세요.` : "AI가 제품 목록을 찾지 못했습니다. 직접 입력하거나 다른 캡처를 붙여 넣어 주세요." });
    } catch (caught) {
      setAi({ busy: false, message: "" });
      setError(caught instanceof Error ? caught.message : "AI가 캡처를 읽지 못했습니다.");
    }
  }, []);

  const addImages = useCallback((files: File[]) => {
    const pictures = files.filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
    if (!pictures.length) return;
    const room = MAX_IMAGES - imagesRef.current.length;
    if (room <= 0) { setError(`캡처는 ${MAX_IMAGES}장까지 붙일 수 있습니다.`); return; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const added = pictures.slice(0, room).map((file, index) => {
      const named = new File([file], `간식-주문내역-${stamp}${index ? `-${index + 1}` : ""}.${file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1]}`, { type: file.type });
      return { file: named, url: URL.createObjectURL(named) };
    });
    const next = [...imagesRef.current, ...added];
    setImages(next);
    // 붙여 넣자마자 지금까지 붙인 캡처 전부를 한 주문으로 읽힌다.
    void readWithAi(next.map((image) => image.file));
  }, [readWithAi]);

  // 창이 열려 있는 동안 어디서 Ctrl+V 를 해도 캡처를 받는다(글을 붙여 넣는 경우는 그대로 둔다).
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
      if (!files.length || event.clipboardData?.getData("text/plain").trim()) return;
      event.preventDefault();
      addImages(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addImages]);

  const itemsTotal = rows.reduce((sum, row) => sum + num(row.amount), 0);
  const computed = Math.max(0, itemsTotal + num(shippingFee) - num(discount));
  const paid = totalAmount.trim() === "" ? computed : num(totalAmount);
  const gap = paid - computed;
  const setRow = (index: number, patch: Partial<Row>) => setRows((current) => current.map((row, position) => {
    if (position !== index) return row;
    const next = { ...row, ...patch };
    // 수량·단가를 바꾸면 금액을 다시 계산한다(금액을 직접 고친 경우는 그 값을 둔다).
    if (("quantity" in patch || "unitPrice" in patch) && !("amount" in patch)) next.amount = String(num(next.quantity) * num(next.unitPrice));
    return next;
  }));

  async function save() {
    setSaving(true); setError("");
    const body = {
      action: purchase ? "UPDATE" : "CREATE", ...(purchase ? { id: purchase.id, updatedAt: purchase.updatedAt } : {}),
      purchasedOn, vendor, memo, shippingFee: num(shippingFee), discount: num(discount), totalAmount: paid,
      items: rows.filter((row) => row.name.trim()).map((row) => ({ name: row.name.trim(), quantity: num(row.quantity), unitPrice: num(row.unitPrice), amount: num(row.amount) })),
    };
    const result = await gaRequest<{ id: string }>("/api/general/snacks", "POST", body);
    if (!result.ok || !result.body.id) { setSaving(false); setError(result.body.error ?? "저장하지 못했습니다."); return; }
    const failed: string[] = [];
    for (const image of images) {
      try {
        const response = await fetch(`/api/general/snacks?purchaseId=${encodeURIComponent(result.body.id)}&name=${encodeURIComponent(image.file.name)}`, {
          method: "PUT", credentials: "same-origin", body: image.file, headers: { "Content-Type": "application/octet-stream" },
        });
        if (!response.ok) failed.push(image.file.name);
      } catch { failed.push(image.file.name); }
    }
    setSaving(false);
    onSaved(failed.length ? `저장했지만 캡처 ${failed.length}장을 올리지 못했습니다.` : purchase ? "구입 기록을 고쳤습니다." : "구입 기록을 저장했습니다.");
  }

  return (
    <div className="ga-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ga-modal ga-snack-modal" role="dialog" aria-modal="true" aria-label="간식 구입 기록">
        <header><strong>{purchase ? "간식 구입 기록 수정" : "간식 구입 기록"}</strong><button type="button" aria-label="닫기" onClick={onClose}>×</button></header>
        <div className="ga-snack-body">
          <section className="ga-paste-zone">
            <div>
              <strong>주문내역 캡처를 여기서 Ctrl+V 로 붙여 넣으세요</strong>
              <p>쇼핑몰 주문 상세·장바구니·결제 화면 캡처를 붙이면 AI가 바로 읽어 아래 표를 채웁니다. 화면이 길면 여러 장(최대 {MAX_IMAGES}장)을 이어 붙이세요.</p>
            </div>
            <div className="ga-paste-actions">
              <label className="ga-file-button"><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden
                onChange={(event) => { addImages([...(event.target.files ?? [])]); event.target.value = ""; }} /><span>＋ 캡처 파일 선택</span></label>
              {images.length > 0 && <button type="button" className="ga-ai-button" disabled={ai.busy} onClick={() => void readWithAi(images.map((image) => image.file))}>{ai.busy ? "AI가 읽는 중…" : "✦ AI로 다시 읽기"}</button>}
            </div>
            {images.length > 0 && <ul className="ga-thumbs">{images.map((image, index) => (
              <li key={image.url}>
                {/* eslint-disable-next-line @next/next/no-img-element -- 붙여 넣은 캡처 미리보기(blob URL) */}
                <img src={image.url} alt={`캡처 ${index + 1}`} />
                <button type="button" aria-label={`캡처 ${index + 1} 빼기`} onClick={() => setImages((current) => { URL.revokeObjectURL(image.url); return current.filter((item) => item.url !== image.url); })}>×</button>
              </li>
            ))}</ul>}
            {purchase && purchase.receipts.length > 0 && <p className="ga-muted">저장된 캡처: {purchase.receipts.map((receipt, index) => <a key={receipt.id} href={receipt.url} target="_blank" rel="noopener noreferrer">{index ? ", " : ""}{receipt.fileName}</a>)}</p>}
            {ai.message && <p className="ga-ai-note" role="status">{ai.message}</p>}
          </section>

          <div className="ga-form ga-snack-head">
            <div className="ga-field"><label className="ga-field-label" htmlFor="snack-date">구입일<em aria-hidden="true">*</em></label>
              <input id="snack-date" type="date" value={purchasedOn} onChange={(event) => setPurchasedOn(event.target.value)} /></div>
            <div className="ga-field"><label className="ga-field-label" htmlFor="snack-vendor">구입처</label>
              <input id="snack-vendor" type="text" placeholder="예: 쿠팡, 마켓컬리" value={vendor} onChange={(event) => setVendor(event.target.value)} /></div>
          </div>

          <table className="ga-table ga-snack-items">
            <thead><tr><th>제품</th><th className="num">수량</th><th className="num">단가</th><th className="num">금액</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="ga-muted">캡처를 붙여 넣거나 「+ 줄 추가」로 직접 입력하세요.</td></tr>}
              {rows.map((row, index) => (
                <tr key={index}>
                  <td><input type="text" aria-label={`${index + 1}번 제품명`} value={row.name} onChange={(event) => setRow(index, { name: event.target.value })} /></td>
                  <td className="num"><input type="text" inputMode="numeric" aria-label={`${index + 1}번 수량`} value={row.quantity} onChange={(event) => setRow(index, { quantity: event.target.value })} /></td>
                  <td className="num"><input type="text" inputMode="numeric" aria-label={`${index + 1}번 단가`} value={row.unitPrice} onChange={(event) => setRow(index, { unitPrice: event.target.value })} /></td>
                  <td className="num"><input type="text" inputMode="numeric" aria-label={`${index + 1}번 금액`} value={row.amount} onChange={(event) => setRow(index, { amount: event.target.value })} /></td>
                  <td><button type="button" className="ga-link danger" onClick={() => setRows((current) => current.filter((_, position) => position !== index))}>빼기</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="ga-link" onClick={() => setRows((current) => [...current, { name: "", quantity: "1", unitPrice: "0", amount: "0" }])}>+ 줄 추가</button>

          <div className="ga-snack-totals">
            <dl>
              <dt>제품 합계</dt><dd>{won(itemsTotal)}</dd>
              <dt><label htmlFor="snack-ship">배송비</label></dt><dd><input id="snack-ship" type="text" inputMode="numeric" value={shippingFee} onChange={(event) => setShippingFee(event.target.value)} /></dd>
              <dt><label htmlFor="snack-discount">할인</label></dt><dd><input id="snack-discount" type="text" inputMode="numeric" value={discount} onChange={(event) => setDiscount(event.target.value)} /></dd>
              <dt><label htmlFor="snack-total">결제 총액</label></dt><dd><input id="snack-total" type="text" inputMode="numeric" placeholder={String(computed)} value={totalAmount} onChange={(event) => setTotalAmount(event.target.value)} /></dd>
            </dl>
            {gap !== 0 && <p className="ga-error" role="status">제품 합계 + 배송비 − 할인({won(computed)})과 결제 총액이 {won(Math.abs(gap))} {gap > 0 ? "더 많습니다" : "적습니다"}. 빠진 줄이나 할인이 없는지 확인해 주세요.</p>}
          </div>
          <div className="ga-field wide"><label className="ga-field-label" htmlFor="snack-memo">메모</label>
            <textarea id="snack-memo" rows={2} placeholder="예: 10월 1차 간식" value={memo} onChange={(event) => setMemo(event.target.value)} /></div>
        </div>
        {error && <p className="ga-error" role="alert">{error}</p>}
        <footer>
          <button type="button" onClick={onClose}>취소</button>
          <button type="button" className="primary-button" disabled={saving || ai.busy || !rows.some((row) => row.name.trim())} onClick={() => void save()}>{saving ? "저장 중" : "저장"}</button>
        </footer>
      </div>
    </div>
  );
}

export default function GeneralSnacksView({ canEdit, notify }: { canEdit: boolean; notify: (message: string) => void }) {
  const [period, setPeriod] = useState<Period>("year");
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [modal, setModal] = useState<{ purchase: Purchase | null } | null>(null);
  const dialog = useErpDialog();
  const load = useCallback(async () => {
    const { from, to } = periodRange(period);
    const query = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
    const result = await gaRequest<{ purchases: Purchase[] }>(`/api/general/snacks?${query}`);
    if (result.ok) setPurchases(result.body.purchases); else notify(result.body.error ?? "간식 구입 기록을 불러오지 못했습니다.");
  }, [period, notify]);
  useEffect(() => { void (async () => { await load(); })(); }, [load]);
  const summary = useMemo(() => summarizeSnacks(purchases ?? []), [purchases]);
  const thisMonth = kstToday().slice(0, 7);
  const monthRow = summary.months.find((row) => row.month === thisMonth);
  const periodTotal = (purchases ?? []).reduce((sum, row) => sum + row.totalAmount, 0);

  return (
    <div className="ga-snacks">
      <div className="ga-toolbar">
        <div className="ga-chips">{PERIODS.map((item) => <button type="button" key={item.key} className={period === item.key ? "active" : ""} onClick={() => setPeriod(item.key)}>{item.label}</button>)}</div>
        {canEdit && <button type="button" className="primary-button" onClick={() => setModal({ purchase: null })}>+ 구입 기록(캡처 붙여넣기)</button>}
      </div>
      <div className="ga-cards">
        <article className="ga-card"><span>이번 달 총액</span><strong>{won(monthRow?.total ?? 0)}</strong></article>
        <article className="ga-card"><span>이번 달 구입</span><strong>{monthRow?.count ?? 0}회</strong></article>
        <article className="ga-card"><span>기간 총액</span><strong>{won(periodTotal)}</strong></article>
        <article className="ga-card"><span>1회 평균</span><strong>{won(purchases?.length ? Math.round(periodTotal / purchases.length) : 0)}</strong></article>
        <article className="ga-card"><span>제품 종류</span><strong>{summary.products.length}</strong></article>
      </div>

      <section className="ga-section">
        <header><h3>구입 내역</h3></header>
        {!purchases ? <p className="ga-muted">불러오는 중…</p> : purchases.length === 0 ? <p className="ga-muted">기록이 없습니다. 「+ 구입 기록」에서 주문내역 캡처를 붙여 넣어 보세요.</p> : (
          <table className="ga-table selectable">
            <thead><tr><th>구입일</th><th>구입처</th><th className="num">제품 수</th><th className="num">제품 합계</th><th className="num">배송비·할인</th><th className="num">결제 총액</th><th>캡처</th></tr></thead>
            <tbody>
              {purchases.map((purchase) => [
                <tr key={purchase.id} className={expanded === purchase.id ? "selected" : ""} onClick={() => setExpanded(expanded === purchase.id ? null : purchase.id)}>
                  <td>{purchase.purchasedOn}</td><td>{purchase.vendor || "-"}</td><td className="num">{purchase.items.length}</td><td className="num">{won(purchase.itemsTotal)}</td>
                  <td className="num">{purchase.shippingFee || purchase.discount ? `+${won(purchase.shippingFee)} / −${won(purchase.discount)}` : "-"}</td>
                  <td className="num"><strong>{won(purchase.totalAmount)}</strong></td><td>{purchase.receipts.length ? `${purchase.receipts.length}장` : "-"}</td>
                </tr>,
                expanded === purchase.id && (
                  <tr key={`${purchase.id}-items`} className="ga-snack-detail"><td colSpan={7}>
                    <table className="ga-table">
                      <thead><tr><th>제품</th><th className="num">수량</th><th className="num">단가</th><th className="num">금액</th></tr></thead>
                      <tbody>{purchase.items.map((item, index) => <tr key={index}><td>{item.name}</td><td className="num">{item.quantity.toLocaleString("ko-KR")}</td><td className="num">{won(item.unitPrice)}</td><td className="num">{won(item.amount)}</td></tr>)}</tbody>
                    </table>
                    <div className="ga-actions">
                      {purchase.receipts.map((receipt, index) => <a key={receipt.id} className="ga-link" href={receipt.url} target="_blank" rel="noopener noreferrer">캡처 {index + 1}</a>)}
                      {purchase.memo && <span className="ga-muted">{purchase.memo}</span>}
                      {canEdit && <button type="button" onClick={() => setModal({ purchase })}>수정</button>}
                      {canEdit && <button type="button" className="danger" onClick={async () => {
                        if (!(await dialog.confirm(`${purchase.purchasedOn} 간식 구입 기록을 지울까요?`, { title: "구입 기록 삭제", confirmLabel: "삭제" }))) return;
                        const result = await gaRequest("/api/general/snacks", "POST", { action: "DELETE", id: purchase.id });
                        notify(result.ok ? "구입 기록을 지웠습니다." : result.body.error ?? "지우지 못했습니다.");
                        setExpanded(null);
                        await load();
                      }}>삭제</button>}
                    </div>
                  </td></tr>
                ),
              ])}
            </tbody>
          </table>
        )}
      </section>

      <div className="ga-grid">
        <Section title="제품별 합계">
          {summary.products.length === 0 ? <p className="ga-muted">기록이 없습니다.</p> : (
            <table className="ga-table">
              <thead><tr><th>제품</th><th className="num">총 수량</th><th className="num">총 금액</th><th className="num">평균 단가</th><th className="num">최근 단가</th><th className="num">구입 횟수</th><th>최근 구입</th></tr></thead>
              <tbody>{summary.products.map((product) => (
                <tr key={productKey(product.name)}><td>{product.name}</td><td className="num">{product.quantity.toLocaleString("ko-KR")}</td><td className="num">{won(product.amount)}</td>
                  <td className="num">{won(product.quantity ? Math.round(product.amount / product.quantity) : 0)}</td><td className="num">{won(product.lastUnitPrice)}</td>
                  <td className="num">{product.purchases}회</td><td>{product.lastOn}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Section>
        <Section title="월별 합계">
          {summary.months.length === 0 ? <p className="ga-muted">기록이 없습니다.</p> : (
            <table className="ga-table">
              <thead><tr><th>월</th><th className="num">구입 횟수</th><th className="num">총액</th></tr></thead>
              <tbody>{summary.months.map((row) => <tr key={row.month}><td>{row.month}</td><td className="num">{row.count}회</td><td className="num">{won(row.total)}</td></tr>)}</tbody>
            </table>
          )}
        </Section>
      </div>
      {modal && <SnackModal purchase={modal.purchase} onClose={() => setModal(null)} onSaved={(message) => { setModal(null); notify(message); void load(); }} />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="ga-section"><header><h3>{title}</h3></header>{children}</section>;
}
