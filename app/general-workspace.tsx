"use client";

// 총무 탭(general-affairs Design §7). 현황 · 자산 · 회사 서류 · 인감·반출 · 가져오기/내보내기.
// 값은 React 텍스트 노드로만 그린다. 보기 권한이면 작업 버튼을 막고 배너를 띄운다(서버 403 이 최종 방어).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import readXlsxFile from "read-excel-file/browser";
import writeXlsxFile from "write-excel-file/browser";
import { useErpDialog } from "./erp-dialog";
import { readScoped, writeScoped } from "./client-runtime";
import { depreciationSchedule } from "./ga-alerts";
import { GA_SHEETS, GA_SHEET_ORDER, rowsFromTable, BILLING_CYCLES, CONTRACT_TYPES, DOCUMENT_KINDS, EQUIPMENT_STATUS, type GaSheet, type RawCell } from "./ga-import";
import {
  ASSET_KIND_LABEL, ASSET_STATUS_LABEL, BILLING_LABEL, BUCKET_LABEL, CONTRACT_TYPE_LABEL, CUSTODY_KIND_LABEL, DOCUMENT_KIND_LABEL, EVENT_LABEL,
  GA_ASSET_HASH, gaRequest, notifyGeneralChanged, won,
} from "./general-client";

type Person = { employeeId: string; name: string; department: string; status: string };
type Asset = Record<string, unknown> & {
  id: string; assetNo: string; kind: string; name: string; category: string; status: string; location: string; holderEmployeeId: string | null; holderName: string;
  acquiredOn: string | null; acquisitionCost: number; quantity: number; unit: string; minQuantity: number; counterparty: string; endsOn: string | null;
  autoRenew: boolean; usefulLifeMonths: number; residualValue: number; openingAccumulated: number; openingAsOf: string | null; disposedOn: string | null;
  bookValue: number; monthlyDepreciation: number | null; accumulatedDepreciation: number | null; alertOff: boolean; updatedAt: number;
};
type Document = Record<string, unknown> & {
  id: string; kind: string; title: string; issuer: string; issuedOn: string | null; expiresOn: string | null; expiry: string | null; storageLocation: string;
  managerName: string; contractType: string; counterparty: string; endsOn: string | null; noticeDays: number; autoRenew: boolean; contractAmount: number;
  alertOff: boolean; checkedOut?: boolean; updatedAt: number;
};
type Checkout = { id: string; targetType: string; targetId: string; targetName: string; borrowerName: string; purpose: string; submitTo: string;
  outOn: string; dueOn: string | null; returnedOn: string | null; receivedBy: string; overdue?: boolean };
type AlertItem = { key: string; kind: string; ownerType: string; ownerId: string; title: string; detail: string; dueOn: string | null; daysLeft: number | null; bucket: string };
type Attachment = { id: string; fileName: string; size: number; isImage: boolean; url: string };

type View = "overview" | "assets" | "documents" | "custody" | "io";
const VIEWS: Array<{ key: View; label: string }> = [
  { key: "overview", label: "현황" }, { key: "assets", label: "자산" }, { key: "documents", label: "회사 서류" },
  { key: "custody", label: "인감·반출" }, { key: "io", label: "가져오기·내보내기" },
];
const VIEW_KEY = "xdnode-general-view";
const VIEW_ONLY = "보기 권한만 있습니다. 저장·지급·반출은 거부됩니다.";

// ── 공용 폼 ─────────────────────────────────────────────────────────────
type FieldSpec = {
  name: string; label: string; type: "text" | "date" | "money" | "number" | "select" | "employee" | "checkbox" | "textarea";
  options?: Record<string, string>; required?: boolean; hint?: string; show?: (values: Record<string, unknown>) => boolean;
};

function FormModal({ title, fields, initial, people, submitLabel = "저장", onSubmit, onClose }: {
  title: string; fields: FieldSpec[]; initial: Record<string, unknown>; people: Person[]; submitLabel?: string;
  onSubmit: (values: Record<string, unknown>) => Promise<string | null>; onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (name: string, value: unknown) => setValues((current) => ({ ...current, [name]: value }));
  async function submit() {
    setBusy(true); setError("");
    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.show && !field.show(values)) continue;
      const value = values[field.name];
      if (field.type === "money" || field.type === "number") {
        const text = String(value ?? "").replace(/[,\s원]/g, "");
        payload[field.name] = text === "" ? undefined : Number(text);
      } else if (field.type === "checkbox") payload[field.name] = Boolean(value);
      else payload[field.name] = value === "" ? undefined : value;
    }
    const message = await onSubmit(payload);
    setBusy(false);
    if (message) setError(message); else onClose();
  }
  return (
    <div className="ga-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ga-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><strong>{title}</strong><button type="button" aria-label="닫기" onClick={onClose}>×</button></header>
        <div className="ga-form">
          {fields.filter((field) => !field.show || field.show(values)).map((field) => (
            <label key={field.name} className={field.type === "checkbox" ? "ga-check" : field.type === "textarea" ? "ga-wide" : ""}>
              {field.type !== "checkbox" && <span>{field.label}{field.required ? " *" : ""}</span>}
              {field.type === "select" ? (
                <select value={String(values[field.name] ?? "")} onChange={(event) => set(field.name, event.target.value)}>
                  <option value="">선택</option>
                  {Object.entries(field.options ?? {}).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              ) : field.type === "employee" ? (
                <select value={String(values[field.name] ?? "")} onChange={(event) => set(field.name, event.target.value)}>
                  <option value="">없음</option>
                  {people.map((person) => <option key={person.employeeId} value={person.employeeId}>{person.name} · {person.department}{person.status.trim() === "퇴직" ? " (퇴직)" : ""}</option>)}
                </select>
              ) : field.type === "checkbox" ? (
                <><input type="checkbox" checked={Boolean(values[field.name])} onChange={(event) => set(field.name, event.target.checked)} /><span>{field.label}</span></>
              ) : field.type === "textarea" ? (
                <textarea rows={3} value={String(values[field.name] ?? "")} onChange={(event) => set(field.name, event.target.value)} />
              ) : (
                <input type={field.type === "date" ? "date" : "text"} inputMode={field.type === "money" || field.type === "number" ? "numeric" : undefined}
                  value={field.type === "money" && typeof values[field.name] === "number" ? (values[field.name] as number).toLocaleString("ko-KR") : String(values[field.name] ?? "")}
                  onChange={(event) => set(field.name, event.target.value)} />
              )}
              {field.hint && <small>{field.hint}</small>}
            </label>
          ))}
        </div>
        {error && <p className="ga-error" role="alert">{error}</p>}
        <footer>
          <button type="button" onClick={onClose}>취소</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>{busy ? "저장 중" : submitLabel}</button>
        </footer>
      </div>
    </div>
  );
}

const ASSET_FIELDS: Record<string, FieldSpec[]> = {
  EQUIPMENT: [
    { name: "name", label: "이름", type: "text", required: true }, { name: "category", label: "분류", type: "text", hint: "예: 노트북, 모니터, 출입증" },
    { name: "model", label: "모델", type: "text" }, { name: "serialNo", label: "시리얼", type: "text" }, { name: "location", label: "위치", type: "text" },
    { name: "acquiredOn", label: "취득일", type: "date" }, { name: "acquisitionCost", label: "취득가", type: "money" }, { name: "vendor", label: "공급처", type: "text" },
    { name: "usefulLifeMonths", label: "내용연수(개월)", type: "number", hint: "고가 장비를 고정자산처럼 상각하려면 입력" },
    { name: "residualValue", label: "잔존가치", type: "money", show: (v) => Number(v.usefulLifeMonths) > 0 },
    { name: "memo", label: "메모", type: "textarea" },
  ],
  SUPPLY: [
    { name: "name", label: "이름", type: "text", required: true }, { name: "category", label: "분류", type: "text" }, { name: "location", label: "위치", type: "text" },
    { name: "unit", label: "단위", type: "text", hint: "예: 박스, 개" }, { name: "minQuantity", label: "최소 수량", type: "number", hint: "이보다 적으면 재고 부족으로 표시" },
    { name: "acquisitionCost", label: "단가", type: "money" }, { name: "vendor", label: "공급처", type: "text" }, { name: "memo", label: "메모", type: "textarea" },
  ],
  CONTRACT: [
    { name: "name", label: "이름", type: "text", required: true }, { name: "category", label: "분류", type: "text", hint: "라이선스·도메인·호스팅·리스·보험·유지보수" },
    { name: "counterparty", label: "계약처", type: "text", required: true }, { name: "contractNo", label: "계약번호", type: "text" },
    { name: "startsOn", label: "시작일", type: "date" }, { name: "endsOn", label: "만료일", type: "date", required: true },
    { name: "autoRenew", label: "자동 갱신", type: "checkbox" }, { name: "renewalCost", label: "갱신 비용", type: "money" },
    { name: "billingCycle", label: "결제 주기", type: "select", options: BILLING_LABEL }, { name: "managerEmployeeId", label: "담당자", type: "employee" },
    { name: "alertOff", label: "만료 알림 끄기", type: "checkbox" }, { name: "memo", label: "메모", type: "textarea" },
  ],
  FIXED: [
    { name: "name", label: "이름", type: "text", required: true }, { name: "category", label: "분류", type: "text" }, { name: "location", label: "위치", type: "text" },
    { name: "holderEmployeeId", label: "사용자", type: "employee" }, { name: "acquiredOn", label: "취득일", type: "date", required: true },
    { name: "acquisitionCost", label: "취득가", type: "money", required: true }, { name: "usefulLifeMonths", label: "내용연수(개월)", type: "number", required: true },
    { name: "residualValue", label: "잔존가치", type: "money" }, { name: "openingAccumulated", label: "기초 상각누계", type: "money", hint: "이미 상각한 금액이 있으면" },
    { name: "openingAsOf", label: "기초 기준일", type: "date", show: (v) => Number(String(v.openingAccumulated ?? "").replace(/\D/g, "")) > 0 },
    { name: "vendor", label: "공급처", type: "text" }, { name: "memo", label: "메모", type: "textarea" },
  ],
};

const DOCUMENT_FIELDS: FieldSpec[] = [
  { name: "kind", label: "종류", type: "select", required: true, options: DOCUMENT_KIND_LABEL },
  { name: "title", label: "서류명·계약명", type: "text", required: true },
  { name: "issuer", label: "발급기관", type: "text", show: (v) => v.kind !== "B2B_CONTRACT" },
  { name: "issuedOn", label: "발급일", type: "date", show: (v) => v.kind !== "B2B_CONTRACT" },
  { name: "expiresOn", label: "만료일", type: "date", show: (v) => v.kind !== "B2B_CONTRACT" },
  { name: "validityMonths", label: "유효기간(개월)", type: "number", hint: "제출용 서류: 발급일 + N개월(만료일이 없을 때)", show: (v) => v.kind !== "B2B_CONTRACT" },
  { name: "contractType", label: "계약 종류", type: "select", required: true, options: CONTRACT_TYPE_LABEL, show: (v) => v.kind === "B2B_CONTRACT" },
  { name: "counterparty", label: "상대방", type: "text", required: true, show: (v) => v.kind === "B2B_CONTRACT" },
  { name: "signedOn", label: "계약일", type: "date", show: (v) => v.kind === "B2B_CONTRACT" },
  { name: "startsOn", label: "시작일", type: "date", show: (v) => v.kind === "B2B_CONTRACT" },
  { name: "endsOn", label: "종료일", type: "date", show: (v) => v.kind === "B2B_CONTRACT" },
  { name: "contractAmount", label: "계약 금액", type: "money", show: (v) => v.kind === "B2B_CONTRACT" },
  { name: "autoRenew", label: "자동 연장", type: "checkbox", show: (v) => v.kind === "B2B_CONTRACT" },
  { name: "noticeDays", label: "해지 통보 기한(종료일 N일 전)", type: "number", show: (v) => v.kind === "B2B_CONTRACT" },
  { name: "storageLocation", label: "원본 보관 위치", type: "text", required: true, hint: "예: 금고 1단, 계약서 바인더 A" },
  { name: "managerEmployeeId", label: "관리 책임자", type: "employee" },
  { name: "alertOff", label: "만료 알림 끄기", type: "checkbox" }, { name: "memo", label: "메모", type: "textarea" },
];

function Banner({ canEdit }: { canEdit: boolean }) {
  return canEdit ? null : <p className="ga-banner" role="status">{VIEW_ONLY}</p>;
}

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="ga-section"><header><h3>{title}</h3>{actions}</header>{children}</section>;
}

function dday(item: { daysLeft: number | null }) {
  if (item.daysLeft === null) return "";
  if (item.daysLeft < 0) return `${-item.daysLeft}일 지남`;
  if (item.daysLeft === 0) return "오늘";
  return `D-${item.daysLeft}`;
}

function Attachments({ ownerType, ownerId, items, canEdit, onChanged, notify }: {
  ownerType: "ASSET" | "DOCUMENT"; ownerId: string; items: Attachment[]; canEdit: boolean; onChanged: () => void; notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    for (const file of [...files]) {
      if (file.size > 26_214_400) { notify(`${file.name}: 25MB까지 올릴 수 있습니다.`); continue; }
      try {
        const response = await fetch(`/api/general/attachments?ownerType=${ownerType}&ownerId=${encodeURIComponent(ownerId)}&name=${encodeURIComponent(file.name)}`, {
          method: "PUT", credentials: "same-origin", body: file, headers: { "Content-Type": "application/octet-stream" },
        });
        if (!response.ok) notify((await response.json().catch(() => ({ error: "" }))).error || `${file.name}: 올리지 못했습니다.`);
      } catch { notify("서버에 연결하지 못했습니다."); }
    }
    setBusy(false);
    onChanged();
  }
  return (
    <div className="ga-attachments">
      {items.length === 0 && <p className="ga-muted">첨부 없음</p>}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <a href={item.url} target={item.isImage ? "_blank" : undefined} rel="noopener noreferrer" download={item.isImage ? undefined : item.fileName}>{item.fileName}</a>
            <small>{Math.max(1, Math.round(item.size / 1024)).toLocaleString("ko-KR")}KB</small>
            {canEdit && <button type="button" className="ga-link danger" onClick={async () => {
              const result = await gaRequest(`/api/general/attachments?id=${encodeURIComponent(item.id)}`, "DELETE");
              if (!result.ok) notify(result.body.error ?? "지우지 못했습니다.");
              onChanged();
            }}>삭제</button>}
          </li>
        ))}
      </ul>
      {canEdit && <label className="ga-upload"><input type="file" multiple hidden onChange={(event) => { void upload(event.target.files); event.target.value = ""; }} />{busy ? "올리는 중…" : "+ 파일 첨부(PDF·이미지·문서, 25MB)"}</label>}
    </div>
  );
}

// ── 현황 ─────────────────────────────────────────────────────────────────
function OverviewView({ canEdit, open, notify }: { canEdit: boolean; open: (ownerType: string, ownerId: string) => void; notify: (message: string) => void }) {
  type Overview = { today: string; badge: number; alerts: AlertItem[]; summary: Array<{ kind: string; count: number; bookValue: number }>;
    openCheckouts: Checkout[]; overdueCheckouts: number; holders: Array<{ employeeId: string; name: string; department: string; count: number }>; lowStock: AlertItem[] };
  const [data, setData] = useState<Overview | null>(null);
  const load = useCallback(async () => {
    const result = await gaRequest<Overview>("/api/general/overview");
    if (result.ok) setData(result.body); else notify(result.body.error ?? "현황을 불러오지 못했습니다.");
  }, [notify]);
  useEffect(() => { void (async () => { await load(); })(); }, [load]);
  if (!data) return <p className="ga-muted">불러오는 중…</p>;
  const count = (bucket: string) => data.alerts.filter((item) => item.bucket === bucket).length;
  return (
    <div className="ga-overview">
      <div className="ga-cards">
        {(["OVERDUE", "TODAY", "D7", "D30"] as const).map((bucket) => (
          <article key={bucket} className={`ga-card ${bucket.toLowerCase()}`}><span>{BUCKET_LABEL[bucket]}</span><strong>{count(bucket)}</strong></article>
        ))}
        <article className="ga-card out"><span>반출 중</span><strong>{data.openCheckouts.length}</strong>{data.overdueCheckouts > 0 && <small>{data.overdueCheckouts}건 기한 지남</small>}</article>
      </div>
      <Section title="만료·기한 알림" actions={canEdit ? <button type="button" onClick={async () => {
        const result = await gaRequest<{ posted: boolean; alreadyRan: boolean; itemCount: number }>("/api/general/alerts", "POST", { trigger: "manual" });
        notify(!result.ok ? result.body.error ?? "보내지 못했습니다." : result.body.alreadyRan ? "오늘 알림은 이미 보냈습니다." : result.body.posted ? `메신저 '총무 알림'에 ${result.body.itemCount}건을 보냈습니다.` : "새로 알릴 항목이 없습니다.");
      }}>오늘 알림 보내기</button> : undefined}>
        {data.alerts.filter((item) => item.bucket !== "LOW_STOCK").length === 0 ? <p className="ga-muted">30일 안에 만료·기한인 항목이 없습니다.</p> : (
          <ul className="ga-alerts">
            {data.alerts.filter((item) => item.bucket !== "LOW_STOCK").map((item) => (
              <li key={item.key} className={item.bucket.toLowerCase()}>
                <button type="button" onClick={() => open(item.ownerType, item.ownerId)}>
                  <em>{BUCKET_LABEL[item.bucket]}</em><strong>{item.title}</strong><span>{item.detail}</span><time>{item.dueOn} · {dday(item)}</time>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <div className="ga-grid">
        <Section title="반출 중">
          {data.openCheckouts.length === 0 ? <p className="ga-muted">반출 중인 인감·서류가 없습니다.</p> : (
            <table className="ga-table"><thead><tr><th>대상</th><th>반출자</th><th>반출일</th><th>반납 예정</th></tr></thead><tbody>
              {data.openCheckouts.map((row) => <tr key={row.id} className={row.overdue ? "overdue" : ""}><td>{row.targetName}</td><td>{row.borrowerName}</td><td>{row.outOn}</td><td>{row.dueOn ?? "-"}</td></tr>)}
            </tbody></table>
          )}
        </Section>
        <Section title="자산 현황">
          <table className="ga-table"><thead><tr><th>유형</th><th>수</th><th>장부가액·금액</th></tr></thead><tbody>
            {data.summary.map((row) => <tr key={row.kind}><td>{ASSET_KIND_LABEL[row.kind]}</td><td>{row.count.toLocaleString("ko-KR")}</td><td>{won(row.bookValue)}</td></tr>)}
          </tbody></table>
          <small className="ga-muted">고정자산 장부가액은 관리용입니다. 세무 신고 금액과 다를 수 있습니다.</small>
        </Section>
        <Section title="직원별 지급 장비">
          {data.holders.length === 0 ? <p className="ga-muted">지급 중인 장비가 없습니다.</p> : (
            <ul className="ga-list">{data.holders.map((row) => <li key={row.employeeId}><span>{row.name} <small>{row.department}</small></span><strong>{row.count}개</strong></li>)}</ul>
          )}
        </Section>
        <Section title="재고 부족">
          {data.lowStock.length === 0 ? <p className="ga-muted">최소 수량보다 적은 비품이 없습니다.</p> : (
            <ul className="ga-list">{data.lowStock.map((item) => <li key={item.key}><button type="button" className="ga-link" onClick={() => open("ASSET", item.ownerId)}>{item.title}</button><span>{item.detail}</span></li>)}</ul>
          )}
        </Section>
      </div>
    </div>
  );
}

// ── 자산 ─────────────────────────────────────────────────────────────────
type AssetDetail = { asset: Asset; events: Array<{ id: string; kind: string; on: string; employeeName: string; quantityDelta: number; location: string; amount: number; reason: string }>; attachments: Attachment[] };

function AssetsView({ canEdit, people, focusId, notify }: { canEdit: boolean; people: Person[]; focusId: string | null; notify: (message: string) => void }) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(focusId);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [form, setForm] = useState<null | { title: string; fields: FieldSpec[]; initial: Record<string, unknown>; submit: (values: Record<string, unknown>) => Promise<string | null> }>(null);
  const dialog = useErpDialog();
  const load = useCallback(async () => {
    const result = await gaRequest<{ assets: Asset[] }>("/api/general/assets");
    if (result.ok) setAssets(result.body.assets); else notify(result.body.error ?? "자산을 불러오지 못했습니다.");
  }, [notify]);
  const loadDetail = useCallback(async (id: string) => {
    const result = await gaRequest<AssetDetail>(`/api/general/assets?id=${encodeURIComponent(id)}`);
    if (result.ok) setDetail(result.body); else { setDetail(null); notify(result.body.error ?? "자산을 불러오지 못했습니다."); }
  }, [notify]);
  useEffect(() => { void (async () => { await load(); })(); }, [load]);
  useEffect(() => { if (selected) void (async () => { await loadDetail(selected); })(); }, [selected, loadDetail]);

  const shown = (assets ?? []).filter((asset) => (!kind || asset.kind === kind)
    && (!query.trim() || [asset.assetNo, asset.name, asset.category, asset.holderName, asset.location, asset.counterparty].some((value) => String(value ?? "").toLowerCase().includes(query.trim().toLowerCase()))));

  async function post(body: Record<string, unknown>) {
    const result = await gaRequest<{ asset?: Asset }>("/api/general/assets", "POST", body);
    if (!result.ok) return result.body.error ?? "저장하지 못했습니다.";
    await load();
    if (result.body.asset) { setSelected(result.body.asset.id); await loadDetail(result.body.asset.id); }
    notifyGeneralChanged();
    return null;
  }

  function openCreate(assetKind: string) {
    setForm({ title: `${ASSET_KIND_LABEL[assetKind]} 등록`, initial: { autoRenew: false },
      fields: [
        ...(assetKind === "EQUIPMENT" ? [{ name: "holderEmployeeId", label: "지급할 사용자(선택)", type: "employee" as const }] : []),
        ...(assetKind === "SUPPLY" ? [{ name: "quantity", label: "현재 수량", type: "number" as const, required: true }] : []),
        ...ASSET_FIELDS[assetKind],
        { name: "assetNo", label: "자산번호(비우면 자동)", type: "text" },
      ],
      submit: (values) => post({ action: "CREATE", kind: assetKind, ...values }) });
  }

  function action(label: string, act: string, fields: FieldSpec[], initial: Record<string, unknown> = {}) {
    if (!detail) return;
    setForm({ title: `${detail.asset.name} · ${label}`, fields, initial, submit: (values) => post({ action: act, id: detail.asset.id, ...values }) });
  }

  const a = detail?.asset;
  return (
    <div className="ga-split">
      <div className="ga-main">
        <div className="ga-toolbar">
          <div className="ga-chips">
            {["", "EQUIPMENT", "SUPPLY", "CONTRACT", "FIXED"].map((value) => (
              <button type="button" key={value || "all"} className={kind === value ? "active" : ""} onClick={() => setKind(value)}>{value ? ASSET_KIND_LABEL[value] : "전체"}</button>
            ))}
          </div>
          <input type="search" placeholder="자산번호·이름·사용자·위치 검색" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="자산 검색" />
          {canEdit && <select value="" aria-label="자산 등록" onChange={(event) => { if (event.target.value) openCreate(event.target.value); }}>
            <option value="">+ 자산 등록</option>{Object.entries(ASSET_KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>}
        </div>
        {!assets ? <p className="ga-muted">불러오는 중…</p> : shown.length === 0 ? <p className="ga-muted">자산이 없습니다.</p> : (
          <table className="ga-table selectable">
            <thead><tr><th>자산번호</th><th>이름</th><th>유형</th><th>상태</th><th>사용자·수량·만료</th><th>위치</th><th className="num">장부가액·금액</th></tr></thead>
            <tbody>
              {shown.map((asset) => (
                <tr key={asset.id} className={[asset.id === selected ? "selected" : "", asset.status === "DISPOSED" ? "muted" : ""].join(" ")} onClick={() => setSelected(asset.id)}>
                  <td className="mono">{asset.assetNo}</td><td>{asset.name}</td><td>{ASSET_KIND_LABEL[asset.kind]}</td>
                  <td><span className={`ga-status ${asset.status.toLowerCase()}`}>{ASSET_STATUS_LABEL[asset.status]}</span></td>
                  <td>{asset.kind === "SUPPLY" ? `${asset.quantity.toLocaleString("ko-KR")}${asset.unit}${asset.minQuantity > 0 && asset.quantity < asset.minQuantity ? " (부족)" : ""}`
                    : asset.kind === "CONTRACT" ? `${asset.endsOn ?? "-"}${asset.autoRenew ? " (자동)" : ""}` : asset.holderName || "-"}</td>
                  <td>{asset.location || "-"}</td><td className="num">{won(asset.bookValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {a && detail && (
        <aside className="ga-detail" aria-label="자산 상세">
          <header><div><small className="mono">{a.assetNo}</small><strong>{a.name}</strong><span>{ASSET_KIND_LABEL[a.kind]} · {ASSET_STATUS_LABEL[a.status]}</span></div>
            <button type="button" aria-label="닫기" onClick={() => { setSelected(null); setDetail(null); }}>×</button></header>
          <dl className="ga-fields">
            {a.holderName && <><dt>사용자</dt><dd>{a.holderName}</dd></>}
            {a.location && <><dt>위치</dt><dd>{a.location}</dd></>}
            {a.kind === "SUPPLY" && <><dt>수량</dt><dd>{a.quantity.toLocaleString("ko-KR")}{a.unit} (최소 {a.minQuantity})</dd></>}
            {a.kind === "CONTRACT" && <><dt>계약처</dt><dd>{a.counterparty}</dd><dt>만료일</dt><dd>{a.endsOn}{a.autoRenew ? " · 자동 갱신" : ""}{a.alertOff ? " · 알림 끔" : ""}</dd></>}
            {a.acquiredOn && <><dt>취득</dt><dd>{a.acquiredOn} · {won(a.acquisitionCost)}</dd></>}
            {a.monthlyDepreciation !== null && <><dt>상각</dt><dd>월 {won(a.monthlyDepreciation)} · 누계 {won(a.accumulatedDepreciation ?? 0)} · 장부가 {won(a.bookValue)}</dd></>}
            {String(a.memo ?? "") && <><dt>메모</dt><dd className="pre">{String(a.memo)}</dd></>}
          </dl>
          {canEdit && a.status !== "DISPOSED" && (
            <div className="ga-actions">
              <button type="button" onClick={() => setForm({ title: `${a.name} 수정`, fields: [...ASSET_FIELDS[a.kind], { name: "assetNo", label: "자산번호", type: "text", required: true }],
                initial: { ...a, openingAsOf: a.openingAsOf ?? "" }, submit: (values) => post({ action: "UPDATE", id: a.id, updatedAt: a.updatedAt, ...values }) })}>수정</button>
              {a.kind === "EQUIPMENT" && a.status === "IN_STOCK" && <button type="button" onClick={() => action("지급", "ASSIGN", [{ name: "employeeId", label: "사용자", type: "employee", required: true }, { name: "on", label: "지급일", type: "date" }, { name: "location", label: "위치", type: "text" }])}>지급</button>}
              {a.kind === "EQUIPMENT" && a.status === "ASSIGNED" && <button type="button" onClick={() => action("반납", "RETURN", [{ name: "on", label: "반납일", type: "date" }, { name: "location", label: "보관 위치", type: "text" }, { name: "reason", label: "메모", type: "text" }])}>반납</button>}
              {a.kind === "EQUIPMENT" && (a.status === "IN_STOCK" || a.status === "ASSIGNED") && <button type="button" onClick={() => action("수리 보냄", "REPAIR", [{ name: "reason", label: "증상·수리처", type: "text" }])}>수리</button>}
              {a.kind === "EQUIPMENT" && a.status === "REPAIR" && <button type="button" onClick={() => action("수리 완료", "REPAIRED", [{ name: "amount", label: "수리비", type: "money" }, { name: "reason", label: "메모", type: "text" }])}>수리 완료</button>}
              {a.kind === "SUPPLY" && <>
                <button type="button" onClick={() => action("입고", "STOCK_IN", [{ name: "quantity", label: "수량", type: "number", required: true }, { name: "reason", label: "메모", type: "text" }])}>입고</button>
                <button type="button" onClick={() => action("출고", "STOCK_OUT", [{ name: "quantity", label: "수량", type: "number", required: true }, { name: "employeeId", label: "받는 사람", type: "employee" }, { name: "reason", label: "메모", type: "text" }])}>출고</button>
              </>}
              {a.kind === "CONTRACT" && <button type="button" onClick={() => action("갱신", "RENEW", [{ name: "endsOn", label: "새 만료일", type: "date", required: true }, { name: "renewalCost", label: "갱신 비용", type: "money" }])}>갱신</button>}
              {a.kind === "CONTRACT" && a.status === "ACTIVE" && <button type="button" onClick={() => action("종료", "END", [{ name: "reason", label: "사유", type: "text" }])}>종료</button>}
              {a.kind !== "CONTRACT" && <button type="button" onClick={() => action("이동", "MOVE", [{ name: "location", label: "새 위치", type: "text", required: true }])}>이동</button>}
              <button type="button" className="danger" onClick={() => action("처분·폐기", "DISPOSE", [{ name: "on", label: "처분일", type: "date" }, { name: "amount", label: "처분가", type: "money" }, { name: "reason", label: "사유", type: "text", required: true }])}>처분</button>
              <button type="button" className="danger" onClick={async () => {
                if (!(await dialog.confirm("이 자산을 장부에서 지울까요? 잘못 등록한 경우에만 쓰세요. 쓰던 자산은 '처분'으로 남기세요.", { title: "자산 삭제", confirmLabel: "삭제" }))) return;
                const message = await post({ action: "DELETE", id: a.id });
                if (message) notify(message); else { setSelected(null); setDetail(null); }
              }}>삭제</button>
            </div>
          )}
          {a.monthlyDepreciation !== null && (
            <details className="ga-schedule"><summary>감가상각표(정액법 월할, 관리용)</summary>
              <table className="ga-table"><thead><tr><th>월</th><th className="num">상각액</th><th className="num">누계</th><th className="num">장부가</th></tr></thead><tbody>
                {depreciationSchedule({ acquisitionCost: a.acquisitionCost, residualValue: a.residualValue, usefulLifeMonths: a.usefulLifeMonths,
                  inServiceMonth: (a.acquiredOn ?? "").slice(0, 7), openingAccumulated: a.openingAccumulated, openingAsOfMonth: a.openingAsOf?.slice(0, 7) ?? null,
                  disposedMonth: a.disposedOn?.slice(0, 7) ?? null }).map((row) => (
                  <tr key={row.period}><td>{row.period}</td><td className="num">{won(row.depreciation)}</td><td className="num">{won(row.accumulated)}</td><td className="num">{won(row.bookValue)}</td></tr>
                ))}
              </tbody></table>
            </details>
          )}
          <h4>첨부</h4>
          <Attachments ownerType="ASSET" ownerId={a.id} items={detail.attachments} canEdit={canEdit} notify={notify} onChanged={() => void loadDetail(a.id)} />
          <h4>이력</h4>
          <ol className="ga-timeline">
            {detail.events.map((event) => (
              <li key={event.id}><time>{event.on}</time><strong>{EVENT_LABEL[event.kind] ?? event.kind}</strong>
                <span>{[event.employeeName, event.location, event.quantityDelta ? `${event.quantityDelta > 0 ? "+" : ""}${event.quantityDelta}` : "", event.amount ? won(event.amount) : "", event.reason].filter(Boolean).join(" · ")}</span></li>
            ))}
          </ol>
        </aside>
      )}
      {form && <FormModal title={form.title} fields={form.fields} initial={form.initial} people={people} onSubmit={form.submit} onClose={() => setForm(null)} />}
    </div>
  );
}

// ── 회사 서류 ─────────────────────────────────────────────────────────────
function DocumentsView({ canEdit, people, focusId, notify }: { canEdit: boolean; people: Person[]; focusId: string | null; notify: (message: string) => void }) {
  const [documents, setDocuments] = useState<Document[] | null>(null);
  const [kind, setKind] = useState("");
  const [selected, setSelected] = useState<string | null>(focusId);
  const [detail, setDetail] = useState<{ document: Document; attachments: Attachment[]; checkouts: Checkout[] } | null>(null);
  const [form, setForm] = useState<null | { title: string; fields: FieldSpec[]; initial: Record<string, unknown>; submit: (values: Record<string, unknown>) => Promise<string | null> }>(null);
  const dialog = useErpDialog();
  const load = useCallback(async () => {
    const result = await gaRequest<{ documents: Document[] }>("/api/general/documents");
    if (result.ok) setDocuments(result.body.documents); else notify(result.body.error ?? "서류를 불러오지 못했습니다.");
  }, [notify]);
  const loadDetail = useCallback(async (id: string) => {
    const result = await gaRequest<{ document: Document; attachments: Attachment[]; checkouts: Checkout[] }>(`/api/general/documents?id=${encodeURIComponent(id)}`);
    if (result.ok) setDetail(result.body); else { setDetail(null); notify(result.body.error ?? "서류를 불러오지 못했습니다."); }
  }, [notify]);
  useEffect(() => { void (async () => { await load(); })(); }, [load]);
  useEffect(() => { if (selected) void (async () => { await loadDetail(selected); })(); }, [selected, loadDetail]);
  async function post(body: Record<string, unknown>) {
    const result = await gaRequest<{ document?: Document }>("/api/general/documents", "POST", body);
    if (!result.ok) return result.body.error ?? "저장하지 못했습니다.";
    await load();
    if (result.body.document) { setSelected(result.body.document.id); await loadDetail(result.body.document.id); }
    notifyGeneralChanged();
    return null;
  }
  const shown = (documents ?? []).filter((document) => !kind || document.kind === kind);
  const d = detail?.document;
  const due = (document: Document) => document.kind === "B2B_CONTRACT" ? document.endsOn : document.expiry;
  return (
    <div className="ga-split">
      <div className="ga-main">
        <div className="ga-toolbar">
          <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="서류 종류"><option value="">전체 종류</option>
            {Object.entries(DOCUMENT_KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          {canEdit && <button type="button" className="primary-button" onClick={() => setForm({ title: "서류 등록", fields: DOCUMENT_FIELDS, initial: { kind: kind || "BUSINESS_REG" },
            submit: (values) => post({ action: "CREATE", ...values }) })}>+ 서류 등록</button>}
        </div>
        {!documents ? <p className="ga-muted">불러오는 중…</p> : shown.length === 0 ? <p className="ga-muted">서류가 없습니다.</p> : (
          <table className="ga-table selectable">
            <thead><tr><th>종류</th><th>서류명·계약명</th><th>상대방·발급기관</th><th>만료·종료</th><th>보관 위치</th><th>상태</th></tr></thead>
            <tbody>{shown.map((document) => (
              <tr key={document.id} className={document.id === selected ? "selected" : ""} onClick={() => setSelected(document.id)}>
                <td>{DOCUMENT_KIND_LABEL[document.kind]}{document.kind === "B2B_CONTRACT" && document.contractType ? ` · ${CONTRACT_TYPE_LABEL[document.contractType]}` : ""}</td>
                <td>{document.title}</td><td>{document.counterparty || document.issuer || "-"}</td>
                <td>{due(document) ?? "-"}{document.kind === "B2B_CONTRACT" && document.noticeDays > 0 ? ` (통보 ${document.noticeDays}일 전)` : ""}</td>
                <td>{document.storageLocation || "-"}</td><td>{document.checkedOut ? <span className="ga-status out">반출 중</span> : "보관"}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {d && detail && (
        <aside className="ga-detail" aria-label="서류 상세">
          <header><div><small>{DOCUMENT_KIND_LABEL[d.kind]}</small><strong>{d.title}</strong><span>{d.storageLocation || "보관 위치 미기록"}</span></div>
            <button type="button" aria-label="닫기" onClick={() => { setSelected(null); setDetail(null); }}>×</button></header>
          <dl className="ga-fields">
            {d.kind === "B2B_CONTRACT" ? <>
              <dt>상대방</dt><dd>{d.counterparty}</dd><dt>계약 종류</dt><dd>{CONTRACT_TYPE_LABEL[d.contractType] ?? "-"}</dd>
              <dt>기간</dt><dd>{String(d.startsOn ?? "-")} ~ {d.endsOn ?? "-"}{d.autoRenew ? " · 자동 연장" : ""}</dd>
              {d.noticeDays > 0 && <><dt>해지 통보</dt><dd>종료 {d.noticeDays}일 전</dd></>}
              {d.contractAmount > 0 && <><dt>금액</dt><dd>{won(d.contractAmount)}</dd></>}
            </> : <>
              <dt>발급</dt><dd>{d.issuer || "-"} · {d.issuedOn ?? "-"}</dd><dt>만료</dt><dd>{d.expiry ?? "없음"}</dd>
            </>}
            {d.managerName && <><dt>책임자</dt><dd>{d.managerName}</dd></>}
            {d.alertOff && <><dt>알림</dt><dd>끔</dd></>}
          </dl>
          {canEdit && <div className="ga-actions">
            <button type="button" onClick={() => setForm({ title: `${d.title} 수정`, fields: DOCUMENT_FIELDS, initial: { ...d }, submit: (values) => post({ action: "UPDATE", id: d.id, updatedAt: d.updatedAt, ...values }) })}>수정</button>
            <button type="button" className="danger" onClick={async () => {
              if (!(await dialog.confirm("이 서류를 대장에서 지울까요? 첨부한 스캔본도 함께 지워집니다.", { title: "서류 삭제", confirmLabel: "삭제" }))) return;
              const message = await post({ action: "DELETE", id: d.id });
              if (message) notify(message); else { setSelected(null); setDetail(null); }
            }}>삭제</button>
          </div>}
          <h4>스캔본·첨부</h4>
          <Attachments ownerType="DOCUMENT" ownerId={d.id} items={detail.attachments} canEdit={canEdit} notify={notify} onChanged={() => void loadDetail(d.id)} />
          <h4>반출 이력</h4>
          {detail.checkouts.length === 0 ? <p className="ga-muted">반출 기록이 없습니다. 반출은 「인감·반출」 화면에서 기록합니다.</p> : (
            <ol className="ga-timeline">{detail.checkouts.map((row) => <li key={row.id}><time>{row.outOn}</time><strong>{row.borrowerName}</strong><span>{row.purpose}{row.returnedOn ? ` · 반납 ${row.returnedOn}` : " · 반출 중"}</span></li>)}</ol>
          )}
        </aside>
      )}
      {form && <FormModal title={form.title} fields={form.fields} initial={form.initial} people={people} onSubmit={form.submit} onClose={() => setForm(null)} />}
    </div>
  );
}

// ── 인감·반출 ─────────────────────────────────────────────────────────────
type CustodyItem = { id: string; kind: string; name: string; storageLocation: string; managerName: string; openCheckout: Checkout | null };

function CustodyView({ canEdit, people, notify }: { canEdit: boolean; people: Person[]; notify: (message: string) => void }) {
  const [data, setData] = useState<{ items: CustodyItem[]; checkouts: Checkout[] } | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [form, setForm] = useState<null | { title: string; fields: FieldSpec[]; initial: Record<string, unknown>; submit: (values: Record<string, unknown>) => Promise<string | null> }>(null);
  const load = useCallback(async () => {
    const [custody, docs] = await Promise.all([gaRequest<{ items: CustodyItem[]; checkouts: Checkout[] }>("/api/general/custody"), gaRequest<{ documents: Document[] }>("/api/general/documents")]);
    if (custody.ok) setData(custody.body); else notify(custody.body.error ?? "반출 대장을 불러오지 못했습니다.");
    if (docs.ok) setDocuments(docs.body.documents);
  }, [notify]);
  useEffect(() => { void (async () => { await load(); })(); }, [load]);
  async function post(body: Record<string, unknown>) {
    const result = await gaRequest("/api/general/custody", "POST", body);
    if (!result.ok) return result.body.error ?? "저장하지 못했습니다.";
    await load();
    notifyGeneralChanged();
    return null;
  }
  const targets = useMemo(() => ({
    ...Object.fromEntries((data?.items ?? []).map((item) => [`ITEM:${item.id}`, `${CUSTODY_KIND_LABEL[item.kind]} · ${item.name}`])),
    ...Object.fromEntries(documents.filter((document) => !document.checkedOut).map((document) => [`DOCUMENT:${document.id}`, `서류 · ${document.title}`])),
  }), [data, documents]);
  function checkout(target?: string) {
    setForm({ title: "반출 기록", initial: { target: target ?? "" }, fields: [
      { name: "target", label: "대상", type: "select", required: true, options: targets },
      { name: "borrowerEmployeeId", label: "반출자", type: "employee", required: true }, { name: "purpose", label: "용도", type: "text", required: true },
      { name: "submitTo", label: "제출처", type: "text" }, { name: "outOn", label: "반출일(비우면 오늘)", type: "date" }, { name: "dueOn", label: "반납 예정일", type: "date" },
    ], submit: (values) => {
      const [targetType, targetId] = String(values.target ?? "").split(":");
      return post({ action: "CHECKOUT", targetType, targetId, borrowerEmployeeId: values.borrowerEmployeeId, purpose: values.purpose, submitTo: values.submitTo, outOn: values.outOn, dueOn: values.dueOn });
    } });
  }
  if (!data) return <p className="ga-muted">불러오는 중…</p>;
  const ledger = showAll ? data.checkouts : data.checkouts.slice(0, 30);
  return (
    <div className="ga-custody">
      <Section title="보관품" actions={canEdit ? <button type="button" onClick={() => setForm({ title: "보관품 등록", initial: { kind: "CORP_SEAL" }, fields: [
        { name: "kind", label: "종류", type: "select", required: true, options: CUSTODY_KIND_LABEL }, { name: "name", label: "이름", type: "text", required: true },
        { name: "storageLocation", label: "보관 위치", type: "text" }, { name: "managerEmployeeId", label: "관리 책임자", type: "employee" }, { name: "memo", label: "메모", type: "textarea" },
      ], submit: (values) => post({ action: "CREATE_ITEM", ...values }) })}>+ 보관품 등록</button> : undefined}>
        {data.items.length === 0 ? <p className="ga-muted">등록한 인감·보관품이 없습니다. 법인인감부터 등록해 보세요.</p> : (
          <div className="ga-seals">
            {data.items.map((item) => (
              <article key={item.id} className={item.openCheckout ? "out" : ""}>
                <small>{CUSTODY_KIND_LABEL[item.kind]}</small><strong>{item.name}</strong>
                {item.openCheckout
                  ? <p>반출 중 · {item.openCheckout.borrowerName} · {item.openCheckout.outOn}{item.openCheckout.dueOn ? ` → ${item.openCheckout.dueOn}` : ""}</p>
                  : <p>보관 중{item.storageLocation ? ` · ${item.storageLocation}` : ""}</p>}
                {canEdit && (item.openCheckout
                  ? <button type="button" onClick={() => setForm({ title: `${item.name} 반납`, initial: {}, fields: [{ name: "returnedOn", label: "반납일(비우면 오늘)", type: "date" }, { name: "receivedBy", label: "받은 사람", type: "text" }, { name: "memo", label: "메모", type: "text" }],
                    submit: (values) => post({ action: "RETURN", id: item.openCheckout!.id, ...values }) })}>반납 처리</button>
                  : <button type="button" onClick={() => checkout(`ITEM:${item.id}`)}>반출 기록</button>)}
              </article>
            ))}
          </div>
        )}
      </Section>
      <Section title="반출 대장" actions={canEdit ? <button type="button" className="primary-button" onClick={() => checkout()}>+ 반출 기록</button> : undefined}>
        {data.checkouts.length === 0 ? <p className="ga-muted">반출 기록이 없습니다.</p> : (
          <>
            <table className="ga-table">
              <thead><tr><th>대상</th><th>반출자</th><th>용도·제출처</th><th>반출일</th><th>반납 예정</th><th>반납</th><th /></tr></thead>
              <tbody>{ledger.map((row) => (
                <tr key={row.id} className={row.overdue ? "overdue" : ""}>
                  <td>{row.targetName}</td><td>{row.borrowerName}</td><td>{row.purpose}{row.submitTo ? ` · ${row.submitTo}` : ""}</td><td>{row.outOn}</td><td>{row.dueOn ?? "-"}</td>
                  <td>{row.returnedOn ? `${row.returnedOn}${row.receivedBy ? ` (${row.receivedBy})` : ""}` : <span className="ga-status out">반출 중</span>}</td>
                  <td>{canEdit && !row.returnedOn && <button type="button" className="ga-link" onClick={() => setForm({ title: `${row.targetName} 반납`, initial: {}, fields: [
                    { name: "returnedOn", label: "반납일(비우면 오늘)", type: "date" }, { name: "receivedBy", label: "받은 사람", type: "text" }, { name: "memo", label: "메모", type: "text" }],
                    submit: (values) => post({ action: "RETURN", id: row.id, ...values }) })}>반납</button>}</td>
                </tr>
              ))}</tbody>
            </table>
            {data.checkouts.length > 30 && <button type="button" className="ga-link" onClick={() => setShowAll(!showAll)}>{showAll ? "최근 30건만" : `전체 ${data.checkouts.length}건 보기`}</button>}
          </>
        )}
      </Section>
      {form && <FormModal title={form.title} fields={form.fields} initial={form.initial} people={people} onSubmit={form.submit} onClose={() => setForm(null)} />}
    </div>
  );
}

// ── 가져오기·내보내기 ──────────────────────────────────────────────────────
type PreviewRow = { row: number; status: "ok" | "error" | "duplicate"; errors: string[]; values: Record<string, unknown> };

const REVERSE: Record<string, Record<string, string>> = {
  status: Object.fromEntries(Object.entries(EQUIPMENT_STATUS).map(([label, value]) => [value, label])),
  billingCycle: Object.fromEntries(Object.entries(BILLING_CYCLES).map(([label, value]) => [value, label])),
  kind: Object.fromEntries(Object.entries(DOCUMENT_KINDS).map(([label, value]) => [value, label])),
  contractType: Object.fromEntries(Object.entries(CONTRACT_TYPES).map(([label, value]) => [value, label])),
};

function IoView({ canEdit, people, notify }: { canEdit: boolean; people: Person[]; notify: (message: string) => void }) {
  const [sheet, setSheet] = useState<GaSheet>("EQUIPMENT");
  const [rows, setRows] = useState<Array<{ row: number; raw: Record<string, RawCell> }>>([]);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [overwrite, setOverwrite] = useState<number[]>([]);
  const [batches, setBatches] = useState<Array<{ id: string; sheet: string; rowCount: number; createdAt: number; reverted: boolean; createdByName: string }>>([]);
  const [busy, setBusy] = useState("");
  const dialog = useErpDialog();
  const loadBatches = useCallback(async () => {
    const result = await gaRequest<{ batches: typeof batches }>("/api/general/import");
    if (result.ok) setBatches(result.body.batches);
  }, []);
  useEffect(() => { void (async () => { await loadBatches(); })(); }, [loadBatches]);

  async function downloadTemplate() {
    const data = GA_SHEET_ORDER.map((key) => ({
      sheet: GA_SHEETS[key].title,
      data: [
        GA_SHEETS[key].columns.map((column) => ({ value: `${column.header}${column.required ? "*" : ""}`, fontWeight: "bold" as const, backgroundColor: "#EEF5E4" })),
        GA_SHEETS[key].columns.map((column) => ({ value: column.example ?? "", color: "#8A8A8A" })),
      ],
      stickyRowsCount: 1,
    }));
    await writeXlsxFile(data).toFile("XD NODE_총무_가져오기양식.xlsx");
  }

  async function readFile(file: File) {
    setPreview(null); setOverwrite([]);
    try {
      const sheets = await readXlsxFile(file);
      const wanted = GA_SHEETS[sheet].title;
      const found = sheets.find((item) => item.sheet === wanted) ?? sheets[0];
      const table = (found?.data ?? []).map((cells) => cells.map((cell) => cell instanceof Date ? cell.toISOString().slice(0, 10) : cell as RawCell));
      const parsed = rowsFromTable(sheet, table);
      if (parsed.missing.length) { notify(`필수 열이 없습니다: ${parsed.missing.join(", ")}`); setRows([]); return; }
      setRows(parsed.rows);
      if (!parsed.rows.length) { notify("가져올 행이 없습니다(둘째 줄 예시 행은 건너뜁니다)."); return; }
      const result = await gaRequest<{ rows: PreviewRow[] }>("/api/general/import", "POST", { action: "PREVIEW", sheet, rows: parsed.rows });
      if (result.ok) setPreview(result.body.rows); else notify(result.body.error ?? "미리보기를 하지 못했습니다.");
    } catch { notify("엑셀 파일을 읽지 못했습니다. .xlsx 파일인지 확인해 주세요."); }
  }

  async function commit() {
    if (!preview) return;
    setBusy("commit");
    const result = await gaRequest<{ created: number; updated: number; skipped: number }>("/api/general/import", "POST", {
      action: "COMMIT", sheet, rows, mode: overwrite.length ? "overwrite" : "skip", overwriteRows: overwrite,
    });
    setBusy("");
    if (!result.ok) { notify(result.body.error ?? "가져오지 못했습니다."); return; }
    notify(`가져왔습니다: 새로 ${result.body.created}건, 덮어씀 ${result.body.updated}건, 건너뜀 ${result.body.skipped}건`);
    setPreview(null); setRows([]); setOverwrite([]);
    notifyGeneralChanged();
    await loadBatches();
  }

  async function exportLedger() {
    setBusy("export");
    try {
      const [assets, documents, custody] = await Promise.all([
        gaRequest<{ assets: Asset[] }>("/api/general/assets"), gaRequest<{ documents: Document[] }>("/api/general/documents"),
        gaRequest<{ checkouts: Checkout[] }>("/api/general/custody"),
      ]);
      const names = new Map(people.map((person) => [person.employeeId, person.name]));
      const cell = (column: { field: string; type: string }, record: Record<string, unknown>) => {
        const value = record[column.field];
        if (column.type === "employee") return typeof value === "string" ? names.get(value) ?? value : "";
        if (column.type === "yn") return value === true ? "Y" : value === false ? "N" : "";
        if (column.type === "enum") return typeof value === "string" ? REVERSE[column.field]?.[value] ?? "" : "";
        if (typeof value === "number") return value;
        return value === null || value === undefined ? "" : String(value);
      };
      const sheetRows = (key: GaSheet, records: Array<Record<string, unknown>>) => ({
        sheet: GA_SHEETS[key].title,
        data: [GA_SHEETS[key].columns.map((column) => ({ value: column.header, fontWeight: "bold" as const, backgroundColor: "#EEF5E4" })),
          ...records.map((record) => GA_SHEETS[key].columns.map((column) => ({ value: cell(column, record) as string | number })))],
        stickyRowsCount: 1,
      });
      const allAssets = (assets.body.assets ?? []).filter((asset) => asset.status !== "DISPOSED");
      const docs = documents.body.documents ?? [];
      const checkoutRows = (custody.body.checkouts ?? []).map((row) => ({ targetName: row.targetName, borrowerEmployeeId: row.borrowerName, outOn: row.outOn, purpose: row.purpose,
        submitTo: row.submitTo, dueOn: row.dueOn, returnedOn: row.returnedOn, receivedBy: row.receivedBy }));
      await writeXlsxFile([
        ...(["EQUIPMENT", "SUPPLY", "CONTRACT", "FIXED"] as const).map((key) => sheetRows(key, allAssets.filter((asset) => asset.kind === key))),
        sheetRows("DOCUMENT", docs.filter((document) => document.kind !== "B2B_CONTRACT")),
        sheetRows("B2B_CONTRACT", docs.filter((document) => document.kind === "B2B_CONTRACT")),
        sheetRows("CHECKOUT", checkoutRows),
      ]).toFile(`XD NODE_총무_장부_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.xlsx`);
    } catch { notify("장부를 내보내지 못했습니다."); }
    setBusy("");
  }

  const errors = preview?.filter((row) => row.status === "error").length ?? 0;
  return (
    <div className="ga-io">
      <Section title="내보내기">
        <p className="ga-muted">현재 장부를 양식과 같은 열로 내려받습니다. 고쳐서 다시 가져오면 자산번호로 덮어쓸 수 있습니다.</p>
        <div className="ga-actions"><button type="button" onClick={() => void downloadTemplate()}>가져오기 양식 내려받기</button>
          <button type="button" className="primary-button" disabled={busy === "export"} onClick={() => void exportLedger()}>{busy === "export" ? "만드는 중" : "현재 장부 내보내기"}</button></div>
      </Section>
      {canEdit && (
        <Section title="가져오기">
          <div className="ga-toolbar">
            <select value={sheet} onChange={(event) => { setSheet(event.target.value as GaSheet); setPreview(null); setRows([]); }} aria-label="시트">
              {GA_SHEET_ORDER.map((key) => <option key={key} value={key}>{GA_SHEETS[key].title}</option>)}
            </select>
            <label className="ga-upload"><input type="file" accept=".xlsx" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void readFile(file); }} />엑셀 파일 선택(.xlsx)</label>
            <small className="ga-muted">열 이름으로 찾으므로 순서는 달라도 됩니다. 한 번에 500행까지.</small>
          </div>
          {preview && (
            <>
              <p className={errors ? "ga-error" : "ga-muted"}>{preview.length}행 · 정상 {preview.filter((row) => row.status === "ok").length} · 중복 {preview.filter((row) => row.status === "duplicate").length} · 오류 {errors}{errors ? " — 오류 행을 엑셀에서 고친 뒤 다시 선택해 주세요." : ""}</p>
              <table className="ga-table">
                <thead><tr><th>행</th><th>상태</th><th>내용</th><th>오류·처리</th></tr></thead>
                <tbody>{preview.map((row) => (
                  <tr key={row.row} className={row.status}>
                    <td>{row.row}</td><td>{row.status === "ok" ? "정상" : row.status === "duplicate" ? "중복" : "오류"}</td>
                    <td>{String(row.values.name ?? row.values.title ?? row.values.targetName ?? "")}{row.values.assetNo ? ` (${String(row.values.assetNo)})` : ""}</td>
                    <td>{row.status === "error" ? row.errors.join(" / ") : row.status === "duplicate" ? (
                      <label className="ga-check"><input type="checkbox" checked={overwrite.includes(row.row)} onChange={(event) => setOverwrite(event.target.checked ? [...overwrite, row.row] : overwrite.filter((value) => value !== row.row))} />같은 자산번호 덮어쓰기(체크 안 하면 건너뜀)</label>
                    ) : ""}</td>
                  </tr>
                ))}</tbody>
              </table>
              <div className="ga-actions"><button type="button" className="primary-button" disabled={Boolean(errors) || busy === "commit"} onClick={() => void commit()}>{busy === "commit" ? "가져오는 중" : "반영"}</button></div>
            </>
          )}
          {batches.length > 0 && (
            <>
              <h4>최근 가져오기</h4>
              <ul className="ga-list">{batches.map((batch) => (
                <li key={batch.id}><span>{GA_SHEETS[batch.sheet as GaSheet]?.title ?? batch.sheet} · {batch.rowCount}건 · {new Date(batch.createdAt).toLocaleString("ko-KR")} · {batch.createdByName}</span>
                  {batch.reverted ? <small>되돌림</small> : <button type="button" className="ga-link danger" onClick={async () => {
                    if (!(await dialog.confirm("이 가져오기로 새로 만든 행을 모두 지울까요? 덮어쓴 행은 되돌리지 않습니다.", { title: "가져오기 되돌리기", confirmLabel: "되돌리기" }))) return;
                    const result = await gaRequest("/api/general/import", "POST", { action: "REVERT", batchId: batch.id });
                    notify(result.ok ? "되돌렸습니다." : result.body.error ?? "되돌리지 못했습니다.");
                    notifyGeneralChanged();
                    await loadBatches();
                  }}>되돌리기</button>}</li>
              ))}</ul>
            </>
          )}
        </Section>
      )}
    </div>
  );
}

// ── 탭 ───────────────────────────────────────────────────────────────────
export default function GeneralWorkspace({ canEdit }: { canEdit: boolean }) {
  const [view, setView] = useState<View>(() => {
    const saved = readScoped(VIEW_KEY, []);
    return VIEWS.some((item) => item.key === saved) ? saved as View : "overview";
  });
  const [focus, setFocus] = useState<{ assetId: string | null; documentId: string | null; key: number }>({ assetId: null, documentId: null, key: 0 });
  const [people, setPeople] = useState<Person[]>([]);
  const [notice, setNotice] = useState("");
  const notify = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? "" : current), 4500);
  }, []);
  const select = useCallback((next: View) => { setView(next); writeScoped(VIEW_KEY, next); }, []);
  const open = useCallback((ownerType: string, ownerId: string) => {
    if (ownerType === "ASSET") { setFocus((current) => ({ assetId: ownerId, documentId: null, key: current.key + 1 })); select("assets"); }
    else if (ownerType === "DOCUMENT") { setFocus((current) => ({ assetId: null, documentId: ownerId, key: current.key + 1 })); select("documents"); }
    else select("custody");
  }, [select]);
  useEffect(() => {
    void (async () => {
      const result = await gaRequest<{ people: Person[] }>("/api/general/people");
      if (result.ok) setPeople(result.body.people.filter((person) => person.status.trim() !== "퇴직"));
    })();
    // HR 퇴직 정산의 '총무 탭에서 반납 처리'(#ga-asset=<id>).
    const readHash = () => {
      if (window.location.hash.startsWith(GA_ASSET_HASH)) {
        open("ASSET", decodeURIComponent(window.location.hash.slice(GA_ASSET_HASH.length)));
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, [open]);
  return (
    <main className="ga-page">
      <header className="ga-head">
        <div><h2>총무</h2><p>자산 · 회사 서류 · 인감 반출 · 만료 관리</p></div>
        <nav className="ga-tabs" aria-label="총무 화면">
          {VIEWS.map((item) => <button type="button" key={item.key} className={view === item.key ? "active" : ""} aria-current={view === item.key ? "page" : undefined} onClick={() => select(item.key)}>{item.label}</button>)}
        </nav>
      </header>
      <Banner canEdit={canEdit} />
      {view === "overview" && <OverviewView canEdit={canEdit} open={open} notify={notify} />}
      {view === "assets" && <AssetsView key={`a${focus.key}`} canEdit={canEdit} people={people} focusId={focus.assetId} notify={notify} />}
      {view === "documents" && <DocumentsView key={`d${focus.key}`} canEdit={canEdit} people={people} focusId={focus.documentId} notify={notify} />}
      {view === "custody" && <CustodyView canEdit={canEdit} people={people} notify={notify} />}
      {view === "io" && <IoView canEdit={canEdit} people={people} notify={notify} />}
      {notice && <div className="ga-notice" role="status">{notice}</div>}
    </main>
  );
}
