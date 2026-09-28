"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Validation = { id: string; validation_type: string; result: string; note: string; reviewed_by: string; created_at: number };
type RuleDocument = { id: string; category: string; version: number; file_name: string; downloadUrl: string };
type Rule = { id: string; name: string; version: number; effectiveFrom: string; effectiveTo: string; status: string;
  formula: { thresholdMarginBps?: number; payoutRateBps?: number; eligibleLeadTypes?: string[]; recognitionBasis?: string; costBasis?: string };
  validations: Validation[]; documents: RuleDocument[] };
type Result = { id: string; period: string; employeeName: string; accountName: string; opportunityTitle: string; ruleVersion: number;
  recognizedRevenue: number; recognizedCost: number; payoutAmount: number; status: string; payrollRef: string;
  calculation: { periodCollected?: number; cumulativeRevenue?: number; acceptedInvoiceTotal?: number; sourceExpectedCost?: number;
    fallbackCost?: number; costRatio?: number; cumulativeCost?: number; cumulativeMargin?: number; cumulativeThreshold?: number;
    cumulativeEntitlement?: number; priorPayout?: number; settlementDifference?: number; clawbackCandidate?: number;
    costQuality?: string; costCenterId?: string; costCenterStatus?: string; costAllocationCount?: number };
  notes: Array<{ id: string; note_type: string; note: string; created_by: string; created_at: number }> };
type IncentiveData = { rules: Rule[]; results: Result[] };

const won = (value: number) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
const validationLabels: Record<string, string> = { POLICY: "1차 · 규정 원문", EXAMPLE: "2차 · 예시 계산", HISTORICAL: "3차 · 과거 지급" };
const statusLabels: Record<string, string> = { DRAFT: "초안", SUBMITTED: "결재 중", ACTIVE: "활성", RETIRED: "종료",
  SALES_CONFIRMED: "영업 확인", FINANCE_REVIEWED: "재무 검토", APPROVED: "대표 승인", PAYROLL_APPLIED: "급여 반영", VOID: "무효" };

export default function IncentiveGovernance() {
  const [data, setData] = useState<IncentiveData>({ rules: [], results: [] });
  const [selectedRuleId, setSelectedRuleId] = useState(""); const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [message, setMessage] = useState(""); const [working, setWorking] = useState(false);
  const [ruleDraft, setRuleDraft] = useState({ name: "", effectiveFrom: "", effectiveTo: "", thresholdMarginPercent: "5", payoutRatePercent: "5", eligibleLeadTypes: ["OUTBOUND"], exceptionsNote: "" });
  const [validation, setValidation] = useState({ validationType: "POLICY", result: "PASS", evidenceDocumentId: "", note: "" });
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const selectedRule = data.rules.find((rule) => rule.id === selectedRuleId) ?? data.rules[0];

  async function load(nextPeriod = period) {
    const response = await fetch(`/api/sales/incentives?period=${encodeURIComponent(nextPeriod)}`);
    const result = await response.json() as IncentiveData & { error?: string };
    if (!response.ok) { setMessage(result.error || "인센티브 원장을 불러오지 못했습니다."); return; }
    setData(result); if (!selectedRuleId && result.rules[0]) setSelectedRuleId(result.rules[0].id);
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  async function mutate(payload: Record<string, unknown>, success: string) {
    setWorking(true); setMessage("");
    try { const response = await fetch("/api/sales/incentives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "처리하지 못했습니다.");
      setMessage(success); await load(); return result; }
    catch (error) { setMessage(error instanceof Error ? error.message : "인센티브 처리 오류"); return null; }
    finally { setWorking(false); }
  }

  async function createRule(event: FormEvent) {
    event.preventDefault(); const result = await mutate({ action: "CREATE_RULE", ...ruleDraft }, "규정 초안 버전을 생성했습니다.") as { id?: string } | null;
    if (result?.id) setSelectedRuleId(result.id);
  }

  async function upload(file: File) {
    if (!selectedRule) return; setWorking(true); const form = new FormData(); form.set("module", "sales");
    form.set("entityType", "salesIncentiveRule"); form.set("entityId", selectedRule.id); form.set("category", "인센티브 규정"); form.set("file", file);
    try { const response = await fetch("/api/documents", { method: "POST", body: form }); const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "근거문서를 저장하지 못했습니다."); setMessage("규정 근거문서를 버전 원장에 저장했습니다."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "문서 저장 오류"); } finally { setWorking(false); }
  }

  async function validate(event: FormEvent) {
    event.preventDefault(); if (!selectedRule) return;
    await mutate({ action: "VALIDATE_RULE", ruleId: selectedRule.id, ...validation }, `${validationLabels[validation.validationType]} 검증을 기록했습니다.`);
    setValidation((current) => ({ ...current, note: "" }));
  }

  async function addNote(result: Result) {
    const note = (noteDraft[result.id] || "").trim(); if (!note) return;
    await mutate({ action: "ADD_NOTE", resultId: result.id, noteType: "REVIEW", note }, "정산 검토 기록을 남겼습니다.");
    setNoteDraft((current) => ({ ...current, [result.id]: "" }));
  }

  async function voidResult(result: Result) {
    const reason = window.prompt("정산을 무효 처리하는 사유를 10자 이상 입력해 주세요.");
    if (!reason) return;
    await mutate({ action: "VOID_RESULT", resultId: result.id, reason }, "정산 결과를 사유와 함께 무효 처리했습니다.");
  }

  const validationState = useMemo(() => Object.fromEntries((selectedRule?.validations ?? []).map((item) => [item.validation_type, item.result])), [selectedRule]);
  const totalPayout = data.results.filter((item) => item.status !== "VOID").reduce((sum, item) => sum + item.payoutAmount, 0);
  const fallbackCount = data.results.filter((item) => item.status !== "VOID" && item.calculation.costQuality !== "ACTUAL_PROJECT_COST").length;
  const clawbackCount = data.results.filter((item) => Number(item.calculation.clawbackCandidate ?? 0) < 0).length;
  return <section className="incentive-control-room">
    <header className="incentive-control-head"><div data-korean-heading><h2>인센티브 규정·정산·급여 연결</h2><span>실제 수금과 승인된 규정만 지급 근거로 사용합니다.</span></div><strong>자동 확정 없음 · 3회 교차검증</strong></header>
    {message && <div className="incentive-control-message" role="status">{message}</div>}
    <div className="incentive-control-metrics"><article><small>규정 버전</small><strong>{data.rules.length}개</strong><span>활성 {data.rules.filter((rule) => rule.status === "ACTIVE").length}</span></article>
      <article><small>{period} 정산</small><strong>{data.results.length}건</strong><span>누적 수금·누적 원가</span></article><article><small>당월 지급 후보</small><strong>{won(totalPayout)}</strong><span>이전 확정액 차감 후</span></article>
      <article><small>원가·환수 확인</small><strong>{fallbackCount + clawbackCount}건</strong><span>예상원가 {fallbackCount} · 환수 {clawbackCount}</span></article></div>

    <div className="incentive-control-grid">
      <article className="panel incentive-rule-editor"><header><div data-korean-heading><h3>규정 버전 등록</h3></div><span>가정식이 아닌 승인 규정</span></header>
        <form onSubmit={createRule}><label>규정명<input required value={ruleDraft.name} onChange={(event) => setRuleDraft({ ...ruleDraft, name: event.target.value })} /></label>
          <label>적용 시작일<input required type="date" value={ruleDraft.effectiveFrom} onChange={(event) => setRuleDraft({ ...ruleDraft, effectiveFrom: event.target.value })} /></label>
          <label>적용 종료일<input type="date" value={ruleDraft.effectiveTo} onChange={(event) => setRuleDraft({ ...ruleDraft, effectiveTo: event.target.value })} /></label>
          <label>기준 마진율 %<input required type="number" min="0" max="100" step="0.01" value={ruleDraft.thresholdMarginPercent} onChange={(event) => setRuleDraft({ ...ruleDraft, thresholdMarginPercent: event.target.value })} /></label>
          <label>초과마진 지급률 %<input required type="number" min="0" max="100" step="0.01" value={ruleDraft.payoutRatePercent} onChange={(event) => setRuleDraft({ ...ruleDraft, payoutRatePercent: event.target.value })} /></label>
          <fieldset><legend>적용 영업유형</legend>{[["OUTBOUND", "아웃바운드"], ["INBOUND", "인바운드"], ["RAM", "RAM 단독"]].map(([value, label]) => <label key={value}><input type="checkbox" checked={ruleDraft.eligibleLeadTypes.includes(value)} onChange={(event) => setRuleDraft({ ...ruleDraft, eligibleLeadTypes: event.target.checked ? [...ruleDraft.eligibleLeadTypes, value] : ruleDraft.eligibleLeadTypes.filter((item) => item !== value) })} />{label}</label>)}</fieldset>
          <label className="wide">예외·환수 조건<textarea value={ruleDraft.exceptionsNote} onChange={(event) => setRuleDraft({ ...ruleDraft, exceptionsNote: event.target.value })} placeholder="반품·할인·미수·대손·퇴사 시 처리 기준" /></label>
          <button type="submit" disabled={working}>+ 규정 초안 생성</button></form>
      </article>

      <article className="panel incentive-validation"><header><div data-korean-heading><h3>세 차례 교차검증</h3></div><span>{selectedRule ? `${selectedRule.name} v${selectedRule.version}` : "규정 선택 필요"}</span></header>
        <select className="rule-selector" value={selectedRule?.id ?? ""} onChange={(event) => setSelectedRuleId(event.target.value)}><option value="">규정 선택</option>{data.rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name} v{rule.version} · {statusLabels[rule.status] ?? rule.status}</option>)}</select>
        {selectedRule ? <><div className="validation-checks">{Object.entries(validationLabels).map(([key, label]) => <div className={validationState[key] === "PASS" ? "pass" : validationState[key] === "FAIL" ? "fail" : "pending"} key={key}><strong>{label}</strong><span>{validationState[key] === "PASS" ? "확인 완료" : validationState[key] === "FAIL" ? "재검토 필요" : "미검증"}</span></div>)}</div>
          <div className="rule-source-note"><span>수익 인식</span><strong>누적 확정 수금액</strong><span>원가 인식</span><strong>프로젝트·원가센터 누적 배부액</strong><span>정산 산식</span><strong>누적 권리 − 이전 승인액</strong></div>
          {selectedRule.status === "DRAFT" && <><label className="evidence-upload">규정·예시·과거지급 근거 첨부<input type="file" accept=".pdf,.docx,.xlsx,.csv,.png,.jpg,.jpeg,.txt" disabled={working} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = ""; }} /></label>
            <form onSubmit={validate}><label>검증 단계<select value={validation.validationType} onChange={(event) => setValidation({ ...validation, validationType: event.target.value })}>{Object.entries(validationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label>판정<select value={validation.result} onChange={(event) => setValidation({ ...validation, result: event.target.value })}><option value="PASS">PASS</option><option value="FAIL">FAIL</option></select></label>
              <label>근거문서<select required value={validation.evidenceDocumentId} onChange={(event) => setValidation({ ...validation, evidenceDocumentId: event.target.value })}><option value="">선택</option>{selectedRule.documents.map((document) => <option key={document.id} value={document.id}>{document.file_name} v{document.version}</option>)}</select></label>
              <label className="wide">검토 의견<input required minLength={10} value={validation.note} onChange={(event) => setValidation({ ...validation, note: event.target.value })} placeholder="비교한 조항·예시·과거지급 결과를 10자 이상 기록" /></label><button disabled={working}>검증 기록</button></form>
            <button className="submit-rule" disabled={working || Object.keys(validationLabels).some((key) => validationState[key] !== "PASS")} onClick={() => void mutate({ action: "SUBMIT_RULE", ruleId: selectedRule.id }, "세 차례 검증을 고정하고 규정 승인을 요청했습니다.")}>영업·대표 결재 제출</button></>}
          {selectedRule.documents.length > 0 && <div className="rule-documents">{selectedRule.documents.map((document) => <a key={document.id} href={document.downloadUrl}>{document.file_name} · v{document.version}</a>)}</div>}</> : <p className="finance-empty">규정 초안을 먼저 생성해 주세요.</p>}
      </article>
    </div>

    <article className="panel incentive-settlement"><header><div data-korean-heading><h3>월별 인센티브 정산</h3></div><div><input type="month" value={period} onChange={(event) => { setPeriod(event.target.value); void load(event.target.value); }} /><button disabled={working} onClick={() => void mutate({ action: "CALCULATE_PERIOD", period }, "승인 규정과 확정 수금으로 정산 초안을 갱신했습니다.")}>정산 초안 계산</button></div></header>
      <div className="incentive-result-row head"><span>직원·영업 건</span><span>당월·누적 수금</span><span>누적 인정 원가</span><span>당월 지급액</span><span>누적 정산 근거</span><span>상태·작업</span></div>
      {data.results.map((result) => <div className={`incentive-result-card ${result.calculation.costQuality === "ACTUAL_PROJECT_COST" ? "cost-actual" : "cost-fallback"}`} key={result.id}><div className="incentive-result-row"><p><strong>{result.employeeName}</strong><small>{result.accountName} · {result.opportunityTitle}</small></p><b>{won(result.calculation.periodCollected ?? 0)}<small>누적 {won(result.calculation.cumulativeRevenue ?? result.recognizedRevenue)}</small></b><span>{won(result.recognizedCost)}<small>{result.calculation.costQuality === "ACTUAL_PROJECT_COST" ? `프로젝트 배부 ${result.calculation.costAllocationCount ?? 0}건` : "예상원가 대체 · 승인 불가"}</small></span><strong>{won(result.payoutAmount)}{Number(result.calculation.clawbackCandidate ?? 0) < 0 && <small>환수 검토 {won(Math.abs(Number(result.calculation.clawbackCandidate)))}</small>}</strong><span>권리 {won(result.calculation.cumulativeEntitlement ?? 0)}<small>이전 승인 {won(result.calculation.priorPayout ?? 0)} · 기준 {won(result.calculation.cumulativeThreshold ?? 0)}</small></span><div><em>{statusLabels[result.status] ?? result.status}</em>{result.status === "DRAFT" && <button onClick={() => void mutate({ action: "SALES_CONFIRM", resultId: result.id }, "영업 확인을 기록했습니다.")}>영업 확인</button>}{result.status === "SALES_CONFIRMED" && (result.calculation.costQuality === "ACTUAL_PROJECT_COST" && Number(result.calculation.clawbackCandidate ?? 0) >= 0 ? <button onClick={() => void mutate({ action: "FINANCE_REVIEW", resultId: result.id }, "재무 검토를 기록했습니다.")}>재무 검토</button> : <small>원가·환수 기준 확인 필요</small>)}{result.status === "FINANCE_REVIEWED" && <button onClick={() => void mutate({ action: "SUBMIT_PAYOUT", resultId: result.id }, "대표 지급 승인을 요청했습니다.")}>대표 승인 요청</button>}{result.status === "APPROVED" && <button onClick={() => void mutate({ action: "APPLY_PAYROLL", resultId: result.id }, "동일 월 급여행에 인센티브를 1회 반영했습니다.")}>급여 반영</button>}{["DRAFT", "SALES_CONFIRMED", "FINANCE_REVIEWED"].includes(result.status) && <button className="ghost" onClick={() => void voidResult(result)}>무효 처리</button>}</div></div>
        <div className="incentive-result-note"><input value={noteDraft[result.id] || ""} onChange={(event) => setNoteDraft({ ...noteDraft, [result.id]: event.target.value })} placeholder="검토·이의·특이사항 기록" /><button onClick={() => void addNote(result)}>기록</button><span>{result.notes[0] ? `${result.notes[0].created_by} · ${result.notes[0].note}` : "기록 없음"}</span></div></div>)}
      {!data.results.length && <div className="finance-empty">활성 규정과 해당 월의 확정 수금이 있어야 정산 초안을 만들 수 있습니다.</div>}
    </article>
  </section>;
}
