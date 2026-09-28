"use client";

import { useEffect, useState } from "react";

type ImpactEntry = { code: string; severity: "BLOCKER" | "WARNING" | "INFO"; label: string; count: number; amount?: number; detail: string };
type Assessment = {
  assessmentId: string; entityLabel: string; action: string; riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  blockingCount: number; warningCount: number; impactedRecordCount: number; entries: ImpactEntry[];
  checksum: string; createdAt: number; expiresAt: number;
};

const riskLabels = { LOW: "낮음", MEDIUM: "주의", HIGH: "높음", CRITICAL: "변경 차단" };
const severityLabels = { BLOCKER: "차단", WARNING: "주의", INFO: "참고" };
const actionLabels: Record<string, string> = { UPDATE: "수정", DEACTIVATE: "비활성화", ACTIVATE: "재활성화", MERGE: "병합" };
const won = (value: number) => `₩${value.toLocaleString("ko-KR")}`;

export default function MasterImpactDialog({ entityType, entityId, action, onClose, onProceed }: {
  entityType: string; entityId: string; action: string; onClose: () => void; onProceed: (assessmentId: string) => Promise<boolean | void> | boolean | void;
}) {
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [message, setMessage] = useState("연결 원장을 계산하고 있습니다…");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/master-impact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entityType, entityId, action }) })
      .then(async (response) => {
        const payload = await response.json() as { assessment?: Assessment; error?: string };
        if (!response.ok || !payload.assessment) throw new Error(payload.error || "영향도를 계산하지 못했습니다.");
        return payload.assessment;
      })
      .then((value) => { if (!cancelled) { setAssessment(value); setMessage(""); } })
      .catch((error: Error) => { if (!cancelled) setMessage(error.message); });
    return () => { cancelled = true; };
  }, [action, entityId, entityType]);

  async function proceed() {
    if (!assessment || assessment.blockingCount > 0) return;
    setWorking(true);
    try { if (await onProceed(assessment.assessmentId) !== false) onClose(); }
    finally { setWorking(false); }
  }

  return <div className="master-impact-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) onClose(); }}>
    <section className="master-impact-dialog" role="dialog" aria-modal="true" aria-labelledby="master-impact-title">
      <header><div data-korean-heading><h2 id="master-impact-title">변경 영향도 확인</h2><span>{actionLabels[action] ?? action} 전에 실제 연결 원장을 점검합니다.</span></div><button type="button" onClick={onClose} disabled={working} aria-label="닫기">×</button></header>
      {message && <div className="master-impact-loading" role="status">{message}</div>}
      {assessment && <>
        <div className={`master-impact-summary ${assessment.riskLevel.toLowerCase()}`}><div><small>대상</small><strong>{assessment.entityLabel}</strong></div><div><small>위험도</small><strong>{riskLabels[assessment.riskLevel]}</strong></div><div><small>연결 레코드</small><strong>{assessment.impactedRecordCount.toLocaleString("ko-KR")}건</strong></div><div><small>차단 / 주의</small><strong>{assessment.blockingCount} / {assessment.warningCount}건</strong></div></div>
        <div className="master-impact-list">
          {assessment.entries.map((entry) => <article className={entry.severity.toLowerCase()} key={entry.code}><span>{severityLabels[entry.severity]}</span><div><h3>{entry.label}</h3><p>{entry.detail}</p></div><strong>{entry.count.toLocaleString("ko-KR")}건{Number(entry.amount) > 0 && <small>{won(Number(entry.amount))}</small>}</strong></article>)}
          {!assessment.entries.length && <div className="master-impact-empty"><strong>연결된 운영 원장이 없습니다.</strong><span>현재 상태에서는 안전하게 변경을 진행할 수 있습니다.</span></div>}
        </div>
        <footer><div><span>확인 #{assessment.checksum.slice(0, 10)}</span><small>{assessment.blockingCount > 0 ? "차단 항목은 데이터 통제의 기준정보 영향 큐에 자동 등록됩니다." : `${new Date(assessment.expiresAt).toLocaleTimeString("ko-KR")}까지 유효 · 변경 직전 서버에서 다시 검증`}</small></div><button type="button" onClick={onClose} disabled={working}>취소</button><button className="primary" type="button" onClick={() => void proceed()} disabled={working || assessment.blockingCount > 0}>{assessment.blockingCount > 0 ? "차단 항목 해결 필요" : working ? "확인 중…" : "영향 확인 · 변경 계속"}</button></footer>
      </>}
    </section>
  </div>;
}
