"use client";

import { FormEvent, useEffect, useState } from "react";
import { DEFAULT_FINANCE_RISK_POLICY, type FinanceRiskPolicy, type RiskDriver } from "./finance-decision-model";

type PolicyResponse = {
  policy: FinanceRiskPolicy;
  preview: { score: number; level: "안정" | "주의" | "높음"; drivers: readonly RiskDriver[]; policyStatus: string };
  error?: string;
};

type PolicyForm = {
  minimumOperatingCash: string;
  minimumDebtCoverageBps: string;
  maximumFxConcentrationBps: string;
  warningDrawdownBps: string;
  criticalDrawdownBps: string;
  lowBalanceThreshold: string;
  changeReason: string;
};

const won = (value: number) => `₩${Math.round(value).toLocaleString("ko-KR")}`;

function toForm(policy: FinanceRiskPolicy): PolicyForm {
  return {
    minimumOperatingCash: String(policy.minimumOperatingCash),
    minimumDebtCoverageBps: String(policy.minimumDebtCoverageBps / 100),
    maximumFxConcentrationBps: String(policy.maximumFxConcentrationBps / 100),
    warningDrawdownBps: String(policy.warningDrawdownBps / 100),
    criticalDrawdownBps: String(policy.criticalDrawdownBps / 100),
    lowBalanceThreshold: String(policy.lowBalanceThreshold),
    changeReason: "",
  };
}

export default function FinanceRiskPolicyWorkspace({ onPolicyChange }: { onPolicyChange: (policy: FinanceRiskPolicy) => void }) {
  const [policy, setPolicy] = useState<FinanceRiskPolicy>(DEFAULT_FINANCE_RISK_POLICY);
  const [preview, setPreview] = useState<PolicyResponse["preview"] | null>(null);
  const [form, setForm] = useState<PolicyForm>(() => toForm(DEFAULT_FINANCE_RISK_POLICY));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/finance/risk-policy", { cache: "no-store" })
      .then(async (response) => ({ response, result: await response.json() as PolicyResponse }))
      .then(({ response, result }) => {
        if (!active) return;
        if (!response.ok) setMessage(result.error || "재무정책을 불러오지 못했습니다.");
        else {
          setPolicy(result.policy); setPreview(result.preview); setForm(toForm(result.policy)); onPolicyChange(result.policy);
        }
        setLoading(false);
      })
      .catch(() => { if (active) { setMessage("재무정책을 불러오지 못했습니다."); setLoading(false); } });
    return () => { active = false; };
  }, [onPolicyChange]);

  function field<K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/finance/risk-policy", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          minimumOperatingCash: Number(form.minimumOperatingCash),
          minimumDebtCoverageBps: Math.round(Number(form.minimumDebtCoverageBps) * 100),
          maximumFxConcentrationBps: Math.round(Number(form.maximumFxConcentrationBps) * 100),
          warningDrawdownBps: Math.round(Number(form.warningDrawdownBps) * 100),
          criticalDrawdownBps: Math.round(Number(form.criticalDrawdownBps) * 100),
          lowBalanceThreshold: Number(form.lowBalanceThreshold),
          changeReason: form.changeReason,
        }),
      });
      const result = await response.json() as PolicyResponse;
      if (!response.ok) setMessage(result.error || "재무정책을 저장하지 못했습니다.");
      else {
        setPolicy(result.policy); setPreview(result.preview); setForm(toForm(result.policy));
        onPolicyChange(result.policy); setMessage(`재무정책 v${result.policy.version}을 저장하고 위험도를 다시 계산했습니다.`);
      }
    } catch {
      setMessage("재무정책 저장 요청을 완료하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className="panel finance-policy-loading">회사 재무정책과 현재 위험 신호를 불러오는 중입니다…</section>;

  return <div className="finance-policy-workspace">
    <section className="finance-policy-hero">
      <div data-korean-heading><h1>회사 재무정책</h1><span>경영진이 승인한 기준으로 자금예측·계좌 위험도·통합 알림을 일관되게 통제합니다.</span></div>
      <div className={`finance-policy-score ${preview?.level === "높음" ? "high" : preview?.level === "주의" ? "watch" : "stable"}`}><small>현재 조기경보</small><strong>{preview?.score ?? 0}<em>/100</em></strong><span>{preview?.level ?? "확인 필요"}</span></div>
    </section>

    {message && <div className="finance-policy-message" role="status">{message}</div>}

    <section className="finance-policy-grid">
      <form className="panel finance-policy-form" onSubmit={save}>
        <header><div data-korean-heading><h2>경보 기준 설정</h2></div><span>{policy.configured ? `적용 중 · v${policy.version}` : "초기 기준 · 미확정"}</span></header>
        <div className="finance-policy-fields">
          <label><span>최소 운영자금</span><input type="number" min="0" step="10000" value={form.minimumOperatingCash} onChange={(event) => field("minimumOperatingCash", event.target.value)} /><small>원화 입출금계좌 잔액과 비교하며 13주 자금예측에도 동일하게 적용됩니다.</small></label>
          <label><span>최소 대출 커버리지</span><div><input type="number" min="100" max="300" step="1" value={form.minimumDebtCoverageBps} onChange={(event) => field("minimumDebtCoverageBps", event.target.value)} /><b>%</b></div><small>은행성 자산 ÷ 대출잔액의 주의 기준입니다.</small></label>
          <label><span>최대 외화자산 집중도</span><div><input type="number" min="0" max="100" step="1" value={form.maximumFxConcentrationBps} onChange={(event) => field("maximumFxConcentrationBps", event.target.value)} /><b>%</b></div><small>은행성 자산 중 외화 원화환산액 비중입니다.</small></label>
          <label><span>고점 대비 감소 · 주의</span><div><input type="number" min="5" max="80" step="1" value={form.warningDrawdownBps} onChange={(event) => field("warningDrawdownBps", event.target.value)} /><b>%</b></div><small>관측기간 고점보다 이 비율 이상 낮을 때 경고합니다.</small></label>
          <label><span>고점 대비 감소 · 위험</span><div><input type="number" min="6" max="100" step="1" value={form.criticalDrawdownBps} onChange={(event) => field("criticalDrawdownBps", event.target.value)} /><b>%</b></div><small>주의 기준보다 반드시 커야 합니다.</small></label>
          <label><span>소액 운영계좌 기준</span><input type="number" min="0" max="100000000" step="10000" value={form.lowBalanceThreshold} onChange={(event) => field("lowBalanceThreshold", event.target.value)} /><small>이 금액 미만의 원화 입출금계좌 수를 확인합니다.</small></label>
        </div>
        <label className="finance-policy-reason"><span>정책 변경 사유</span><textarea rows={3} value={form.changeReason} onChange={(event) => field("changeReason", event.target.value)} placeholder="예: 2026년 하반기 운영자금 방침 반영" required /></label>
        <div className="finance-policy-form-footer"><p>시스템 관리자만 저장할 수 있으며 변경 전후 값과 사유가 감사기록에 남습니다.</p><button type="submit" disabled={saving}>{saving ? "저장 중…" : "정책 저장·재평가"}</button></div>
      </form>

      <article className="panel finance-policy-preview">
        <header><div data-korean-heading><h2>현재 데이터 적용 결과</h2></div><span>{policy.updatedAt ? new Date(policy.updatedAt).toLocaleDateString("ko-KR") : "미저장"}</span></header>
        <div className="finance-policy-driver-list">
          {(preview?.drivers ?? []).map((driver) => <div className={driver.status} key={driver.key}><span>{driver.label}</span><strong>+{driver.points}<small>/{driver.maxPoints}</small></strong><p>{driver.evidence}</p><em>{driver.rule}</em></div>)}
        </div>
        <div className="finance-policy-linkage"><strong>정책 연동 범위</strong><span>계좌 위험도</span><span>13주 최소운영자금</span><span>통합 업무함 경보</span><span>재무 AI 근거</span></div>
        <small>현재 최소 운영자금 {won(policy.minimumOperatingCash)} · 정책값을 바꾸어도 저장 전에는 운영 경보에 반영되지 않습니다.</small>
      </article>
    </section>
  </div>;
}
