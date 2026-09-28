"use client";

import { useEffect, useMemo, useState } from "react";
import DataIntegrationWorkspace from "./data-integration-workspace";
import AuditLogWorkspace from "./audit-log-workspace";
import MasterImpactCaseWorkspace from "./master-impact-case-workspace";

type Check = { code: string; category: string; status: "PASS" | "WARN" | "FAIL"; title: string; detail: string };
type Snapshot = { id: string; status: string; fileName: string; sha256: string; byteSize: number; tableCount: number; rowCount: number; requestedBy: string; createdAt: number; verifiedAt: number | null; verificationStatus: string; verificationDetail: string; failureMessage: string; downloadUrl: string };
type Rehearsal = { id: string; snapshotId: string; status: string; checkCount: number; failureCount: number; performedBy: string; performedAt: number };
type AuditExport = { id: string; dateFrom: string; dateTo: string; module: string; status: string; fileName: string; sha256: string; byteSize: number; rowCount: number; createdAt: number; failureMessage: string; downloadUrl: string };
type Policy = { id: string; dataType: string; label: string; retentionDays: number; disposition: string; active: boolean; updatedBy: string; updatedAt: number };
type GovernanceData = {
  principal: { employeeId: string; name: string };
  latestRun: { id: string; status: "HEALTHY" | "ATTENTION" | "CRITICAL"; checkCount: number; failedCount: number; warningCount: number; startedAt: number; completedAt: number; checks: Check[] } | null;
  snapshots: Snapshot[]; rehearsals: Rehearsal[]; auditExports: AuditExport[]; policies: Policy[];
  controls: { automaticRestore: boolean; automaticDeletion: boolean; snapshotScope: string; fileStorageCheckedSeparately: boolean };
};

const now = new Date();
const defaultTo = now.toISOString().slice(0, 10);
const monthAgo = new Date(now); monthAgo.setUTCDate(monthAgo.getUTCDate() - 30);
const defaultFrom = monthAgo.toISOString().slice(0, 10);
const statusLabel: Record<string, string> = { HEALTHY: "정상", ATTENTION: "확인 필요", CRITICAL: "위험", PASS: "통과", WARN: "주의", FAIL: "실패", READY: "생성 완료", CREATING: "생성 중", FAILED: "실패", PENDING: "미검증" };
const moduleLabel: Record<string, string> = { ALL: "전체", operations: "운영", finance: "재무", hr: "HR", recruitment: "채용", sales: "영업", settings: "설정" };

function formatDate(value: number | null) {
  return value ? new Date(value).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" }) : "기록 없음";
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

async function requestData() {
  const response = await fetch("/api/data-governance", { cache: "no-store" });
  const payload = await response.json() as GovernanceData & { error?: string };
  if (!response.ok) throw new Error(payload.error || "데이터 통제 현황을 불러오지 못했습니다.");
  return payload;
}

export default function DataGovernanceCenter({ onClose, initialView = "trust" }: { onClose: () => void; initialView?: "trust" | "integration" | "audit" | "impact" }) {
  const [view, setView] = useState(initialView);
  const [data, setData] = useState<GovernanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dateFrom, setDateFrom] = useState(defaultFrom);
  const [dateTo, setDateTo] = useState(defaultTo);
  const [auditModule, setAuditModule] = useState("ALL");
  const [policyDrafts, setPolicyDrafts] = useState<Record<string, { retentionDays: number; active: boolean }>>({});

  useEffect(() => {
    let cancelled = false;
    requestData().then((payload) => {
      if (cancelled) return;
      setData(payload);
      setPolicyDrafts(Object.fromEntries(payload.policies.map((policy) => [policy.id, { retentionDays: policy.retentionDays, active: policy.active }])));
    }).catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "데이터 통제 현황을 불러오지 못했습니다."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", closeOnEscape);
    return () => { cancelled = true; window.removeEventListener("keydown", closeOnEscape); };
  }, [onClose]);

  async function mutate(action: string, extra: Record<string, unknown> = {}, success = "처리가 완료되었습니다.") {
    setBusy(action + String(extra.snapshotId ?? extra.id ?? "")); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data-governance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
      const payload = await response.json() as GovernanceData & { error?: string };
      if (!response.ok) throw new Error(payload.error || "데이터 통제 작업을 완료하지 못했습니다.");
      setData(payload); setNotice(success);
      setPolicyDrafts(Object.fromEntries(payload.policies.map((policy) => [policy.id, { retentionDays: policy.retentionDays, active: policy.active }])));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "데이터 통제 작업을 완료하지 못했습니다."); }
    finally { setBusy(""); }
  }

  const summary = useMemo(() => {
    const run = data?.latestRun;
    return {
      status: run?.status ?? "ATTENTION",
      passed: run ? run.checkCount - run.failedCount - run.warningCount : 0,
      verifiedSnapshots: data?.snapshots.filter((snapshot) => snapshot.verificationStatus === "PASS").length ?? 0,
      failedFiles: run?.checks.find((check) => check.code === "OBJECT_STORAGE")?.status === "FAIL" ? 1 : 0,
    };
  }, [data]);

  return <>
    <button className="data-governance-backdrop" type="button" aria-label="데이터 통제 센터 닫기" onClick={onClose} />
    <aside className="data-governance-center" role="dialog" aria-modal="true" aria-label="데이터 신뢰성 통제 센터">
      <header className="data-governance-header">
        <div data-korean-heading><h2>데이터 통제 센터</h2><span>신뢰성·복구, 원천 연동·대사, 기준정보 영향과 감사·변경이력을 관리자 권한으로 관리합니다.</span></div>
        <button type="button" aria-label="닫기" onClick={onClose}>×</button>
      </header>
      <nav className="data-governance-tabs" aria-label="데이터 통제 영역"><button type="button" className={view === "trust" ? "active" : ""} onClick={() => setView("trust")}>신뢰성·복구</button><button type="button" className={view === "integration" ? "active" : ""} onClick={() => setView("integration")}>연동·대사</button><button type="button" className={view === "impact" ? "active" : ""} onClick={() => setView("impact")}>기준정보 영향</button><button type="button" className={view === "audit" ? "active" : ""} onClick={() => setView("audit")}>감사·변경이력</button></nav>
      {view === "integration" ? <DataIntegrationWorkspace /> : view === "impact" ? <MasterImpactCaseWorkspace /> : view === "audit" ? <AuditLogWorkspace /> : <>
      {loading && <div className="data-governance-loading">데이터 통제 현황을 불러오는 중입니다.</div>}
      {error && <div className="data-governance-message error" role="alert">{error}</div>}
      {notice && <div className="data-governance-message" role="status">{notice}</div>}
      {data && <div className="data-governance-body">
        <section className="data-governance-summary">
          <article className={summary.status.toLowerCase()}><span>종합 상태</span><strong>{statusLabel[summary.status]}</strong><small>{data.latestRun ? formatDate(data.latestRun.completedAt) : "첫 점검 필요"}</small></article>
          <article><span>통과 항목</span><strong>{summary.passed}<em>/{data.latestRun?.checkCount ?? 0}</em></strong><small>실패 {data.latestRun?.failedCount ?? 0} · 주의 {data.latestRun?.warningCount ?? 0}</small></article>
          <article><span>검증 스냅샷</span><strong>{summary.verifiedSnapshots}<em>개</em></strong><small>최근 생성 {data.snapshots.length ? formatDate(data.snapshots[0].createdAt) : "없음"}</small></article>
          <article><span>원본 누락</span><strong>{summary.failedFiles}<em>건</em></strong><small>문서·면담녹음 표본 점검</small></article>
        </section>

        <section className="data-governance-section">
          <header><div data-korean-heading><h3>운영 무결성 점검</h3></div><button disabled={Boolean(busy)} type="button" onClick={() => void mutate("RUN_CHECKS", {}, "운영 데이터 점검 결과를 저장했습니다.")}>{busy === "RUN_CHECKS" ? "점검 중…" : "지금 점검"}</button></header>
          <div className="data-governance-checks">
            {data.latestRun?.checks.map((check) => <article key={check.code} className={check.status.toLowerCase()}><em>{statusLabel[check.status]}</em><div><strong>{check.title}</strong><small>{check.category}</small><p>{check.detail}</p></div></article>)}
            {!data.latestRun && <div className="data-governance-empty">첫 점검을 실행하면 권한·감사·연동·재무·파일·복구 상태가 표시됩니다.</div>}
          </div>
        </section>

        <section className="data-governance-section">
          <header><div data-korean-heading><h3>D1 논리 스냅샷</h3><span>실데이터 자동복구 없이 생성·해시검증·복구 모의훈련을 순서대로 수행합니다.</span></div><button disabled={Boolean(busy)} type="button" onClick={() => void mutate("CREATE_SNAPSHOT", {}, "D1 논리 스냅샷을 생성했습니다. 이어서 검증해 주세요.")}>{busy === "CREATE_SNAPSHOT" ? "생성 중…" : "새 스냅샷 생성"}</button></header>
          <div className="data-governance-ledger">
            {data.snapshots.map((snapshot) => <article key={snapshot.id}>
              <div><strong>{snapshot.fileName || `스냅샷 ${snapshot.id.slice(0, 8)}`}</strong><small>{formatDate(snapshot.createdAt)} · {snapshot.tableCount}개 테이블 · {snapshot.rowCount.toLocaleString("ko-KR")}행 · {formatBytes(snapshot.byteSize)}</small><code>SHA-256 {snapshot.sha256 ? snapshot.sha256.slice(0, 16) + "…" : "생성되지 않음"}</code></div>
              <em className={(snapshot.verificationStatus === "PASS" ? "pass" : snapshot.status === "FAILED" ? "fail" : "warn")}>{snapshot.status === "FAILED" ? "생성 실패" : `검증 ${statusLabel[snapshot.verificationStatus] ?? snapshot.verificationStatus}`}</em>
              <div className="data-governance-actions">
                {snapshot.status === "READY" && <button disabled={Boolean(busy)} type="button" onClick={() => void mutate("VERIFY_SNAPSHOT", { snapshotId: snapshot.id }, "스냅샷의 해시와 구조를 검증했습니다.")}>검증</button>}
                {snapshot.status === "READY" && <button disabled={Boolean(busy)} type="button" onClick={() => void mutate("REHEARSE_RECOVERY", { snapshotId: snapshot.id }, "운영 DB를 변경하지 않고 복구 모의훈련을 완료했습니다.")}>복구 모의훈련</button>}
                {snapshot.downloadUrl && <a href={snapshot.downloadUrl}>다운로드</a>}
              </div>
              {(snapshot.verificationDetail || snapshot.failureMessage) && <p>{snapshot.verificationDetail || snapshot.failureMessage}</p>}
            </article>)}
            {!data.snapshots.length && <div className="data-governance-empty">생성된 스냅샷이 없습니다.</div>}
          </div>
          <div className="data-governance-safety"><strong>안전장치</strong><span>자동 복구 없음</span><span>자동 삭제 없음</span><span>R2 파일은 별도 존재 여부 점검</span></div>
        </section>

        <section className="data-governance-section">
          <header><div data-korean-heading><h3>복구 모의훈련 이력</h3></div></header>
          <div className="data-governance-compact-ledger">
            {data.rehearsals.map((rehearsal) => <div key={rehearsal.id}><em className={rehearsal.status.toLowerCase()}>{statusLabel[rehearsal.status] ?? rehearsal.status}</em><p><strong>스냅샷 {rehearsal.snapshotId.slice(0, 8)}</strong><small>{formatDate(rehearsal.performedAt)} · 운영 데이터 쓰기 0건 · 실패 {rehearsal.failureCount}건</small></p></div>)}
            {!data.rehearsals.length && <div className="data-governance-empty">스냅샷 검증 후 복구 모의훈련을 실행해 주세요.</div>}
          </div>
        </section>

        <section className="data-governance-section">
          <header><div data-korean-heading><h3>감사기록 내보내기</h3><span>원문 변경 전후 값은 제외하고 누가·언제·무엇을 했는지 CSV로 생성합니다.</span></div></header>
          <form className="data-governance-export" onSubmit={(event) => { event.preventDefault(); void mutate("CREATE_AUDIT_EXPORT", { dateFrom, dateTo, module: auditModule }, "감사기록 CSV를 생성했습니다."); }}>
            <label>시작일<input type="date" required value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
            <label>종료일<input type="date" required value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
            <label>모듈<select value={auditModule} onChange={(event) => setAuditModule(event.target.value)}>{Object.entries(moduleLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <button type="submit" disabled={Boolean(busy)}>CSV 생성</button>
          </form>
          <div className="data-governance-compact-ledger">
            {data.auditExports.map((item) => <div key={item.id}><em className={item.status === "READY" ? "pass" : "fail"}>{statusLabel[item.status] ?? item.status}</em><p><strong>{item.dateFrom}–{item.dateTo} · {moduleLabel[item.module] ?? item.module}</strong><small>{item.rowCount.toLocaleString("ko-KR")}건 · {formatBytes(item.byteSize)} · {item.sha256 ? `SHA ${item.sha256.slice(0, 12)}…` : item.failureMessage}</small></p>{item.downloadUrl && <a href={item.downloadUrl}>다운로드</a>}</div>)}
            {!data.auditExports.length && <div className="data-governance-empty">생성된 감사기록 파일이 없습니다.</div>}
          </div>
        </section>

        <section className="data-governance-section">
          <header><div data-korean-heading><h3>보존정책</h3><span>기간을 확정해도 자동 삭제하지 않으며, 만료 자료는 별도 검토 대상으로만 분류됩니다.</span></div></header>
          <div className="data-governance-policies">
            {data.policies.map((policy) => {
              const draft = policyDrafts[policy.id] ?? { retentionDays: policy.retentionDays, active: policy.active };
              return <article key={policy.id}><div><strong>{policy.label}</strong><small>{policy.dataType} · 검토 후 처리</small></div><label>보존일<input type="number" min="30" max="7300" value={draft.retentionDays} onChange={(event) => setPolicyDrafts((current) => ({ ...current, [policy.id]: { ...draft, retentionDays: Number(event.target.value) } }))} /></label><label className="data-governance-toggle"><input type="checkbox" checked={draft.active} onChange={(event) => setPolicyDrafts((current) => ({ ...current, [policy.id]: { ...draft, active: event.target.checked } }))} /><span>정책 확정</span></label><button disabled={Boolean(busy)} type="button" onClick={() => void mutate("UPDATE_POLICY", { id: policy.id, ...draft }, `${policy.label} 보존정책을 저장했습니다.`)}>저장</button></article>;
            })}
          </div>
        </section>
      </div>}</>}
    </aside>
  </>;
}
