"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type WorkbenchItem = {
  key: string;
  itemType: "TASK" | "MANAGEMENT_ACTION" | "MANAGEMENT_DECISION";
  itemId: string;
  reportId: string;
  module: string;
  category: string;
  title: string;
  description: string;
  dueDate: string;
  status: string;
  priority: string;
  destination: string;
  sourceType: string;
  canStart: boolean;
  canComplete: boolean;
  pinned: boolean;
  snoozedUntil: string;
  note: string;
  bucket: "OVERDUE" | "TODAY" | "UPCOMING" | "SNOOZED";
};

type WorkbenchData = {
  principal: { employeeId: string; name: string };
  today: string;
  summary: { total: number; today: number; overdue: number; important: number; decisions: number; snoozed: number };
  items: WorkbenchItem[];
};

const bucketCopy = {
  OVERDUE: ["기한 경과", "지금 우선 확인할 업무"],
  TODAY: ["오늘", "오늘 처리하거나 진행할 업무"],
  UPCOMING: ["예정", "다가오는 기한의 업무"],
  SNOOZED: ["미룬 업무", "설정한 날짜에 다시 표시될 업무"],
} as const;
const statusCopy: Record<string, string> = { OPEN: "대기", IN_PROGRESS: "진행 중", WAITING: "회신 대기", PENDING: "결정 대기" };
const sourceCopy: Record<WorkbenchItem["itemType"], string> = {
  TASK: "업무 원장",
  MANAGEMENT_ACTION: "경영 후속조치",
  MANAGEMENT_DECISION: "경영 의사결정",
};
const moduleCopy: Record<string, string> = { finance: "재무회계", hr: "HR", recruitment: "채용", sales: "영업", operations: "운영" };

function tomorrow(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

async function requestWorkbench() {
  const response = await fetch("/api/workbench");
  const payload = await response.json() as WorkbenchData & { error?: string };
  if (!response.ok) throw new Error(payload.error || "오늘의 업무를 불러오지 못했습니다.");
  return payload;
}

export default function OperationsWorkbench({ onClose, onNavigate }: { onClose: () => void; onNavigate: (destination: string) => void }) {
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [moduleFilter, setModuleFilter] = useState("ALL");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await requestWorkbench());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "오늘의 업무를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    requestWorkbench()
      .then((payload) => { if (!cancelled) setData(payload); })
      .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "오늘의 업무를 불러오지 못했습니다."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  async function personal(item: WorkbenchItem, action: "PIN" | "SNOOZE" | "NOTE", value: boolean | string) {
    setBusyKey(item.key); setError(""); setNotice("");
    const field = action === "PIN" ? "pinned" : action === "SNOOZE" ? "snoozedUntil" : "note";
    try {
      const response = await fetch("/api/workbench", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, itemType: item.itemType, itemId: item.itemId, [field]: value }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "개인 업무 설정을 저장하지 못했습니다.");
      setNotice(action === "PIN" ? "중요 업무 표시를 저장했습니다." : action === "SNOOZE" ? "다시 볼 날짜를 저장했습니다." : "개인 메모를 저장했습니다.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "개인 업무 설정을 저장하지 못했습니다.");
    } finally { setBusyKey(""); }
  }

  async function changeStatus(item: WorkbenchItem, status: "IN_PROGRESS" | "DONE") {
    setBusyKey(item.key); setError(""); setNotice("");
    try {
      const isTask = item.itemType === "TASK";
      const response = await fetch(isTask ? "/api/operations" : "/api/finance/management-report", {
        method: isTask ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isTask
          ? { id: item.itemId, status, reason: `오늘 업무에서 ${status === "DONE" ? "완료" : "처리 시작"}` }
          : { action: "UPDATE_ACTION", reportId: item.reportId, actionId: item.itemId, status }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "원천 업무 상태를 변경하지 못했습니다.");
      setNotice(status === "DONE" ? "원천 업무를 완료 처리했습니다." : "원천 업무의 처리를 시작했습니다.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "원천 업무 상태를 변경하지 못했습니다.");
    } finally { setBusyKey(""); }
  }

  function snooze(item: WorkbenchItem) {
    if (item.snoozedUntil) { void personal(item, "SNOOZE", ""); return; }
    const selected = window.prompt("다시 표시할 날짜를 입력하세요. (YYYY-MM-DD)", tomorrow(data?.today ?? new Date().toISOString().slice(0, 10)));
    if (selected !== null) void personal(item, "SNOOZE", selected.trim());
  }

  function editNote(item: WorkbenchItem) {
    const note = window.prompt("이 업무에만 보이는 개인 메모를 입력하세요.", item.note);
    if (note !== null) void personal(item, "NOTE", note);
  }

  const modules = useMemo(() => Array.from(new Set((data?.items ?? []).map((item) => item.module))), [data]);
  const visible = useMemo(() => (data?.items ?? []).filter((item) => moduleFilter === "ALL" || item.module === moduleFilter), [data, moduleFilter]);

  return (
    <div className="workbench-layer" role="dialog" aria-modal="true" aria-labelledby="workbench-title">
      <button type="button" className="workbench-backdrop" aria-label="오늘 업무 닫기" onClick={onClose} />
      <section className="workbench-panel">
        <header className="workbench-header">
          <div data-korean-heading><h2 id="workbench-title">오늘의 업무</h2><span>내게 배정된 실행 항목과 경영 안건을 한곳에서 확인합니다.</span></div>
          <button type="button" className="workbench-close" aria-label="닫기" onClick={onClose}>×</button>
        </header>

        {data && <div className="workbench-summary" aria-label="오늘 업무 요약">
          {[
            ["오늘", data.summary.today], ["기한 경과", data.summary.overdue], ["중요", data.summary.important],
            ["결정 대기", data.summary.decisions], ["미룬 업무", data.summary.snoozed],
          ].map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{value}<small>건</small></strong></div>)}
        </div>}

        <div className="workbench-toolbar">
          <div className="workbench-filters" aria-label="모듈 필터">
            <button type="button" className={moduleFilter === "ALL" ? "active" : ""} onClick={() => setModuleFilter("ALL")}>전체</button>
            {modules.map((module) => <button type="button" className={moduleFilter === module ? "active" : ""} key={module} onClick={() => setModuleFilter(module)}>{moduleCopy[module] ?? module}</button>)}
          </div>
          <button type="button" className="workbench-refresh" disabled={loading} onClick={() => void load()}>새로고침</button>
        </div>

        <div className="workbench-feedback" aria-live="polite">
          {error && <span className="error">{error}</span>}{notice && !error && <span>{notice}</span>}
        </div>

        <div className="workbench-content">
          {loading && !data && <div className="workbench-empty">오늘 업무를 정리하고 있습니다.</div>}
          {!loading && data && visible.length === 0 && <div className="workbench-empty">이 조건에 해당하는 미완료 업무가 없습니다.</div>}
          {(["OVERDUE", "TODAY", "UPCOMING", "SNOOZED"] as const).map((bucket) => {
            const rows = visible.filter((item) => item.bucket === bucket);
            if (!rows.length) return null;
            return <section className={`workbench-bucket bucket-${bucket.toLowerCase()}`} key={bucket}>
              <div className="workbench-bucket-title"><div><h3>{bucketCopy[bucket][0]}</h3><p>{bucketCopy[bucket][1]}</p></div><strong>{rows.length}</strong></div>
              <div className="workbench-items">
                {rows.map((item) => <article className={`workbench-item ${item.pinned ? "pinned" : ""}`} key={item.key}>
                  <div className="workbench-item-main">
                    <div className="workbench-item-meta">
                      <em>{moduleCopy[item.module] ?? item.module}</em><span>{sourceCopy[item.itemType]}</span><span>{item.category}</span>
                      {item.priority === "HIGH" || item.priority === "CRITICAL" ? <b>{item.priority === "CRITICAL" ? "긴급" : "중요"}</b> : null}
                    </div>
                    <h4>{item.pinned && <i aria-label="고정됨">●</i>}{item.title}</h4>
                    <p>{item.description}</p>
                    {item.note && <blockquote><strong>내 메모</strong>{item.note}</blockquote>}
                  </div>
                  <div className="workbench-item-state">
                    <span>{statusCopy[item.status] ?? item.status}</span>
                    <time>{item.snoozedUntil ? `${item.snoozedUntil} 다시 표시` : item.dueDate ? `${item.dueDate}까지` : "기한 없음"}</time>
                  </div>
                  <div className="workbench-item-actions">
                    <button type="button" disabled={busyKey === item.key} onClick={() => void personal(item, "PIN", !item.pinned)}>{item.pinned ? "고정 해제" : "중요 고정"}</button>
                    <button type="button" disabled={busyKey === item.key} onClick={() => snooze(item)}>{item.snoozedUntil ? "미루기 해제" : "내일 이후"}</button>
                    <button type="button" disabled={busyKey === item.key} onClick={() => editNote(item)}>메모</button>
                    {item.canStart && <button type="button" className="strong" disabled={busyKey === item.key} onClick={() => void changeStatus(item, "IN_PROGRESS")}>처리 시작</button>}
                    {item.canComplete && <button type="button" className="strong" disabled={busyKey === item.key} onClick={() => void changeStatus(item, "DONE")}>완료</button>}
                    {item.destination && <button type="button" className="navigate" onClick={() => onNavigate(item.destination)}>{item.itemType === "MANAGEMENT_DECISION" ? "결정하기 →" : "관련 화면 →"}</button>}
                  </div>
                </article>)}
              </div>
            </section>;
          })}
        </div>
      </section>
    </div>
  );
}
