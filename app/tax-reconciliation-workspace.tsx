"use client";

import { ChangeEvent, useEffect, useState } from "react";

type TaxData = {
  asOf: string; currentPeriod: string; period: string; taxCodeCount: number; evidenceCount: number; locked: boolean;
  source: { salesSupply: number; purchaseSupply: number; salesDocuments: number; purchaseDocuments: number };
  record: null | { declared_sales_supply: number; declared_purchase_supply: number; output_tax: number;
    deductible_input_tax: number; nondeductible_input_tax: number; adjustment_tax: number; payable_tax: number;
    figures_confirmed: number; note: string; status: string; prepared_by: string; reviewed_by: string; reviewed_at: number | null };
  salesVariance: number; purchaseVariance: number;
  checks: Array<{ key: string; label: string; pass: boolean; detail: string }>;
  documents: Array<{ id: string; version: number; fileName: string; uploadedBy: string; createdAt: number; downloadUrl: string }>;
};

const won = (value: number) => `${value < 0 ? "-" : ""}₩${Math.abs(value).toLocaleString("ko-KR")}`;
const emptyDraft = { declaredSalesSupply: "0", declaredPurchaseSupply: "0", outputTax: "0", deductibleInputTax: "0",
  nondeductibleInputTax: "0", adjustmentTax: "0", figuresConfirmed: false, note: "" };

export default function TaxReconciliationWorkspace() {
  const [period, setPeriod] = useState("");
  const [data, setData] = useState<TaxData | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");

  function apply(result: TaxData) {
    setData(result); setPeriod(result.period);
    const row = result.record;
    setDraft(row ? { declaredSalesSupply: String(row.declared_sales_supply), declaredPurchaseSupply: String(row.declared_purchase_supply),
      outputTax: String(row.output_tax), deductibleInputTax: String(row.deductible_input_tax),
      nondeductibleInputTax: String(row.nondeductible_input_tax), adjustmentTax: String(row.adjustment_tax),
      figuresConfirmed: row.figures_confirmed === 1, note: row.note } : emptyDraft);
  }

  async function load(selected = period) {
    setLoading(true); setMessage("");
    try {
      const response = await fetch(`/api/finance/tax${selected ? `?period=${encodeURIComponent(selected)}` : ""}`, { cache: "no-store" });
      const result = await response.json() as TaxData & { error?: string };
      if (!response.ok) throw new Error(result.error || "부가세 검토 원장을 불러오지 못했습니다.");
      apply(result);
    } catch (error) { setMessage(error instanceof Error ? error.message : "부가세 검토 원장을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    fetch("/api/finance/tax", { cache: "no-store" })
      .then(async (response) => ({ response, result: await response.json() as TaxData & { error?: string } }))
      .then(({ response, result }) => {
        if (!active) return;
        if (!response.ok) setMessage(result.error || "부가세 검토 원장을 불러오지 못했습니다.");
        else apply(result);
        setLoading(false);
      })
      .catch(() => { if (active) { setMessage("부가세 검토 원장을 불러오지 못했습니다."); setLoading(false); } });
    return () => { active = false; };
  }, []);

  async function mutate(payload: Record<string, unknown>, success: string) {
    setWorking(true); setMessage("");
    try {
      const response = await fetch("/api/finance/tax", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, ...payload }) });
      const result = await response.json() as { error?: string; reasons?: string[] };
      if (!response.ok) throw new Error([result.error, ...(result.reasons ?? [])].filter(Boolean).join(" · ") || "처리하지 못했습니다.");
      setMessage(success); await load(period);
    } catch (error) { setMessage(error instanceof Error ? error.message : "처리하지 못했습니다."); }
    finally { setWorking(false); }
  }

  async function save() {
    await mutate({ action: "SAVE", ...draft, declaredSalesSupply: Number(draft.declaredSalesSupply),
      declaredPurchaseSupply: Number(draft.declaredPurchaseSupply), outputTax: Number(draft.outputTax),
      deductibleInputTax: Number(draft.deductibleInputTax), nondeductibleInputTax: Number(draft.nondeductibleInputTax),
      adjustmentTax: Number(draft.adjustmentTax) }, "부가세 검토값을 저장했습니다.");
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    setWorking(true); setMessage("");
    const form = new FormData(); form.append("module", "finance"); form.append("entityType", "financeTaxPeriod");
    form.append("entityId", period); form.append("category", "TAX_EVIDENCE"); form.append("file", file);
    try {
      const response = await fetch("/api/documents", { method: "POST", body: form });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "증빙을 저장하지 못했습니다.");
      setMessage("부가세 검토 증빙을 버전 이력과 함께 저장했습니다."); await load(period);
    } catch (error) { setMessage(error instanceof Error ? error.message : "증빙을 저장하지 못했습니다."); }
    finally { setWorking(false); }
  }

  const readonly = data?.locked || data?.record?.status === "REVIEWED";
  const previewPayable = Number(draft.outputTax || 0) - Number(draft.deductibleInputTax || 0) + Number(draft.adjustmentTax || 0);
  if (loading && !data) return <section className="panel tax-loading">세금계산서 원천과 검토 원장을 대사하고 있습니다…</section>;

  return <div className="tax-workspace">
    <section className="tax-hero">
      <div data-korean-heading><h1>부가세 검토센터</h1><span>Clobe 공급가액과 홈택스·이카운트 확인값, 증빙, 월마감 상태를 한 원장으로 연결합니다.</span></div>
      <label>검토월<input type="month" min="2026-01" max={data?.currentPeriod} value={period} onChange={(event) => void load(event.target.value)} /></label>
    </section>

    <div className="tax-disclaimer"><strong>내부 검토용</strong><span>공식 신고서가 아니며 과세유형·세율·공제 여부를 자동 추정하지 않습니다.</span><em>Clobe {data?.asOf} 기준</em></div>
    {message && <div className="tax-message" role="status">{message}</div>}

    <section className="tax-metrics">
      <article><small>매출 공급가액</small><strong>{won(data?.source.salesSupply ?? 0)}</strong><span>세금계산서 {data?.source.salesDocuments ?? 0}건</span></article>
      <article><small>매입 공급가액</small><strong>{won(data?.source.purchaseSupply ?? 0)}</strong><span>세금계산서 {data?.source.purchaseDocuments ?? 0}건</span></article>
      <article className={(data?.salesVariance ?? 0) || (data?.purchaseVariance ?? 0) ? "warning" : ""}><small>공급가액 차이</small><strong>{won((data?.salesVariance ?? 0) + (data?.purchaseVariance ?? 0))}</strong><span>매출 {won(data?.salesVariance ?? 0)} · 매입 {won(data?.purchaseVariance ?? 0)}</span></article>
      <article><small>예상 납부·환급</small><strong>{won(data?.record?.payable_tax ?? previewPayable)}</strong><span>입력 세액 기준 · 양수 납부</span></article>
    </section>

    <section className="tax-grid">
      <article className="panel tax-form-panel">
        <header><div data-korean-heading><h2>신고 확인값</h2></div><span className={`tax-status ${(data?.record?.status ?? "DRAFT").toLowerCase()}`}>{data?.record?.status === "REVIEWED" ? "검토 완료" : "작성 중"}</span></header>
        <div className="tax-form-grid">
          <label>신고 매출 공급가액<input disabled={readonly} type="number" min="0" value={draft.declaredSalesSupply} onChange={(event) => setDraft({ ...draft, declaredSalesSupply: event.target.value })} /></label>
          <label>신고 매입 공급가액<input disabled={readonly} type="number" min="0" value={draft.declaredPurchaseSupply} onChange={(event) => setDraft({ ...draft, declaredPurchaseSupply: event.target.value })} /></label>
          <label>매출세액<input disabled={readonly} type="number" min="0" value={draft.outputTax} onChange={(event) => setDraft({ ...draft, outputTax: event.target.value })} /></label>
          <label>공제 매입세액<input disabled={readonly} type="number" min="0" value={draft.deductibleInputTax} onChange={(event) => setDraft({ ...draft, deductibleInputTax: event.target.value })} /></label>
          <label>불공제 매입세액<input disabled={readonly} type="number" min="0" value={draft.nondeductibleInputTax} onChange={(event) => setDraft({ ...draft, nondeductibleInputTax: event.target.value })} /></label>
          <label>가감 조정세액<input disabled={readonly} type="number" value={draft.adjustmentTax} onChange={(event) => setDraft({ ...draft, adjustmentTax: event.target.value })} /></label>
        </div>
        <label className="tax-confirm"><input disabled={readonly} type="checkbox" checked={draft.figuresConfirmed} onChange={(event) => setDraft({ ...draft, figuresConfirmed: event.target.checked })} /><span>위 값은 홈택스 또는 이카운트 원본에서 확인했습니다.</span></label>
        <label className="tax-note">검토 메모<textarea disabled={readonly} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="공급가액 차이, 불공제 사유, 조정 내역을 기록하세요." /></label>
        <div className="tax-actions">
          {!readonly && <button type="button" disabled={working} onClick={() => void save()}>검토값 저장</button>}
          {data?.record && data.record.status !== "REVIEWED" && !data.locked && <button type="button" className="primary" disabled={working} onClick={() => void mutate({ action: "REVIEW" }, "부가세 검토를 완료하고 월마감 통제에 반영했습니다.")}>검토 완료</button>}
          {data?.record?.status === "REVIEWED" && !data.locked && <button type="button" onClick={() => { const reason = window.prompt("재개방 사유를 5자 이상 입력해 주세요.", "신고 확인값 수정"); if (reason) void mutate({ action: "REOPEN", reason }, "부가세 검토 원장을 재개방했습니다."); }}>재개방</button>}
        </div>
      </article>

      <article className="panel tax-check-panel">
        <header><div data-korean-heading><h2>검토 통제</h2></div><span>{data?.checks.filter((item) => item.pass).length ?? 0}/{data?.checks.length ?? 0}</span></header>
        <div>{data?.checks.map((check, index) => <div className={check.pass ? "pass" : "review"} key={check.key}><span>{check.pass ? "✓" : "!"}</span><p><strong>{String(index + 1).padStart(2, "0")} · {check.label}</strong><small>{check.detail}</small></p><em>{check.pass ? "확인" : "필요"}</em></div>)}</div>
        {!data?.taxCodeCount && <aside>세금코드는 ‘통합 재무 마스터’에서 실제 코드와 세율을 결재 등록한 후 사용합니다.</aside>}
      </article>
    </section>

    <section className="panel tax-evidence">
      <header><div data-korean-heading><h2>검토 증빙</h2><span>신고서·세금계산서 합계표·검토표를 월별로 버전 보관합니다.</span></div><label className={working || data?.locked ? "disabled" : ""}>+ 파일 첨부<input disabled={working || data?.locked} type="file" accept=".pdf,.xlsx,.csv,.png,.jpg,.jpeg" onChange={(event) => void upload(event)} /></label></header>
      <div>{data?.documents.map((document) => <a href={document.downloadUrl} key={document.id}><span>{document.fileName.split(".").pop()?.toUpperCase()}</span><p><strong>{document.fileName}</strong><small>v{document.version} · {document.uploadedBy || "담당자"} · {new Date(document.createdAt).toLocaleString("ko-KR")}</small></p><em>다운로드</em></a>)}{!data?.documents.length && <p className="tax-empty">검토 완료 전에 원본 근거 파일을 1건 이상 첨부해 주세요.</p>}</div>
    </section>
  </div>;
}
