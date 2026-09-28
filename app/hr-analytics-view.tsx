"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Point = { label?: string; period?: string; value: number };
type Snapshot = {
  generatedAt: number; period: { from: string; to: string }; formulas: { turnoverRate: string; averageHiringDays: string };
  headcount: { atStart: number; atEnd: number; hires: number; exits: number; turnoverRate: number; trend: { period: string; value: number }[]; organization: { label: string; value: number }[] };
  recruitment: { total: number; accepted: number; conversionRate: number; averageHiringDays: number | null; sources: Point[]; funnel: Point[] };
  payroll: null | { available: boolean; grossPay: number; deductions: number; netPay: number; months: { period: string; employees: number; grossPay: number; deductions: number; netPay: number }[]; departments: Point[] };
  performance: null | { finalized: number; averageScore: number | null; ratings: Point[] };
  training: { total: number; completed: number; submitted: number; incomplete: number; completionRate: number; courses: { id: string; title: string; type: string; dueDate: string; total: number; completed: number; submitted: number; completionRate: number }[] };
  quality: Point[]; sensitiveIncluded: boolean;
};
type Report = { id: string; title: string; periodStart: string; periodEnd: string; version: number; generatedBy: string; createdAt: number };
type Data = { canSensitive: boolean; snapshot: Snapshot; reports: Report[]; error?: string };

const won = (value: number) => value >= 100000000 ? `${(value / 100000000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}억원` : `${Math.round(value / 10000).toLocaleString("ko-KR")}만원`;
const number = (value: number) => value.toLocaleString("ko-KR");
const today = new Date().toISOString().slice(0, 10);
const yearStart = `${today.slice(0, 4)}-01-01`;

async function fetchAnalytics(from: string, to: string, reportId = "") {
  const params = new URLSearchParams({ from, to }); if (reportId) params.set("reportId", reportId);
  const response = await fetch(`/api/hr/analytics?${params}`); const payload = await response.json() as Data;
  if (!response.ok) throw new Error(payload.error || "HR 통계 자료를 불러오지 못했습니다."); return payload;
}

function BarList({ items, formatter = number }: { items: Point[]; formatter?: (value: number) => string }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return <div className="analytics-bars">{items.length ? items.map((item) => <div key={item.label ?? item.period}><div><strong>{item.label ?? item.period}</strong><span>{formatter(item.value)}</span></div><i><b style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }}></b></i></div>) : <p className="analytics-empty-row">해당 기간에 집계할 자료가 없습니다.</p>}</div>;
}

export default function HrAnalyticsView({ onNotify }: { onNotify: (message: string) => void }) {
  const [range, setRange] = useState({ from: yearStart, to: today }); const [data, setData] = useState<Data | null>(null); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [savedView, setSavedView] = useState("");
  const load = useCallback(async (from = range.from, to = range.to, reportId = "") => { setLoading(true); try { const next = await fetchAnalytics(from, to, reportId); setData(next); setSavedView(reportId); if (reportId) setRange({ from: next.snapshot.period.from, to: next.snapshot.period.to }); } catch (error) { onNotify(error instanceof Error ? error.message : "HR 통계 자료를 불러오지 못했습니다."); } finally { setLoading(false); } }, [onNotify, range.from, range.to]);
  useEffect(() => { let cancelled = false; fetchAnalytics(yearStart, today).then((next) => { if (!cancelled) setData(next); }).catch((error: Error) => { if (!cancelled) onNotify(error.message); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [onNotify]);
  const snapshot = data?.snapshot; const qualityIssues = useMemo(() => snapshot?.quality.reduce((sum, item) => sum + item.value, 0) ?? 0, [snapshot]);
  async function generateReport() { setSaving(true); const response = await fetch("/api/hr/analytics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "GENERATE_REPORT", ...range }) }); const payload = await response.json() as { error?: string; version?: number }; setSaving(false); if (!response.ok) { onNotify(payload.error || "리포트를 생성하지 못했습니다."); return; } onNotify(`HR 통합 리포트 v${payload.version}을 생성했습니다.`); await load(); }
  const csvHref = snapshot ? `/api/hr/analytics?${new URLSearchParams({ from: snapshot.period.from, to: snapshot.period.to, ...(savedView ? { reportId: savedView } : {}), format: "csv" })}` : "#";
  return <div className="page-wrap module-page analytics-page"><section className="module-hero"><div data-korean-heading><h1>통계·리포트</h1><p>인원·채용·인건비·성과·교육 원장을 기간별 의사결정 지표로 연결합니다.</p></div><div className="analytics-hero-actions"><a className="outline-button" href={csvHref} aria-disabled={!snapshot}>CSV 내보내기</a>{data?.canSensitive && <button type="button" className="primary-button" disabled={saving || loading} onClick={() => void generateReport()}>{saving ? "생성 중…" : "현재 수치 리포트 생성"}</button>}</div></section>
    <section className="panel analytics-filter"><label>시작일<input type="date" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} /></label><label>종료일<input type="date" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} /></label><button type="button" disabled={loading || !range.from || !range.to || range.from > range.to} onClick={() => void load(range.from, range.to)}>기간 적용</button><span>{savedView ? "저장 리포트 스냅샷 조회 중" : "업무 원장 최신 집계"}</span></section>
    {loading && !snapshot ? <section className="panel analytics-empty">통계 원장을 집계하는 중입니다.</section> : snapshot && <><section className="metric-grid module-metrics">{[
      ["기간 말 재직자", `${number(snapshot.headcount.atEnd)}명`, `입사 ${snapshot.headcount.hires} · 퇴직 ${snapshot.headcount.exits}`],
      ["기간 이직률", `${snapshot.headcount.turnoverRate}%`, "기간 시작·종료 평균 인원 기준"],
      ["채용 전환율", `${snapshot.recruitment.conversionRate}%`, `지원 ${snapshot.recruitment.total} · 입사 확정 ${snapshot.recruitment.accepted}`],
      ["교육 이수율", `${snapshot.training.completionRate}%`, `검토 대기 ${snapshot.training.submitted} · 미이수 ${snapshot.training.incomplete}`],
    ].map(([label, value, note], index) => <div className="compact-metric" key={label}><span className={`metric-accent ${["navy", "orange", "blue", "green"][index]}`}></span><p>{label}</p><h2>{value}</h2><small>{note}</small></div>)}</section>
      <section className="analytics-grid"><article className="panel analytics-card wide"><header><div data-korean-heading><h2>월말 재직자 추이</h2></div><span>{snapshot.period.from}~{snapshot.period.to}</span></header><div className="analytics-columns">{snapshot.headcount.trend.map((item) => { const max = Math.max(1, ...snapshot.headcount.trend.map((point) => point.value)); return <div key={item.period}><span>{item.value}명</span><i style={{ height: `${Math.max(8, (item.value / max) * 100)}%` }}></i><small>{item.period.slice(2)}</small></div>; })}</div><p className="analytics-formula">기간 말 인원은 입사일 이전과 퇴직일 이후를 제외해 계산합니다.</p></article>
        <article className="panel analytics-card"><header><div data-korean-heading><h2>조직별 재직자</h2></div><span>{snapshot.headcount.atEnd}명</span></header><BarList items={snapshot.headcount.organization} /></article>
        <article className="panel analytics-card"><header><div data-korean-heading><h2>지원경로</h2></div><span>{snapshot.recruitment.total}명</span></header><BarList items={snapshot.recruitment.sources} /></article>
        <article className="panel analytics-card"><header><div data-korean-heading><h2>채용 퍼널</h2></div><span>평균 {snapshot.recruitment.averageHiringDays === null ? "자료 없음" : `${snapshot.recruitment.averageHiringDays}일`}</span></header><BarList items={snapshot.recruitment.funnel} /></article>
        <article className="panel analytics-card"><header><div data-korean-heading><h2>교육 과정 이수</h2></div><span>{snapshot.training.completed}/{snapshot.training.total}명</span></header><div className="analytics-course-list">{snapshot.training.courses.length ? snapshot.training.courses.map((course) => <div key={course.id}><div><strong>{course.title}</strong><small>{course.dueDate} · 검토 대기 {course.submitted}명</small></div><span>{course.completionRate}%</span></div>) : <p className="analytics-empty-row">해당 기간 마감 교육이 없습니다.</p>}</div></article>
        {snapshot.payroll && <article className="panel analytics-card wide"><header><div data-korean-heading><h2>월별 인건비</h2></div><span>{snapshot.payroll.available ? `지급총액 ${won(snapshot.payroll.grossPay)}` : "원장 없음"}</span></header>{snapshot.payroll.available ? <><BarList items={snapshot.payroll.months.map((item) => ({ period: item.period, value: item.grossPay }))} formatter={won} /><div className="analytics-money-summary"><span>공제총액 <b>{won(snapshot.payroll.deductions)}</b></span><span>실 지급액 <b>{won(snapshot.payroll.netPay)}</b></span></div></> : <p className="analytics-empty-row">조회 기간에 등록된 급여 원장이 없습니다.</p>}</article>}
        {snapshot.performance && <article className="panel analytics-card"><header><div data-korean-heading><h2>확정 평가 분포</h2></div><span>평균 {snapshot.performance.averageScore ?? "-"}점</span></header><BarList items={snapshot.performance.ratings} /></article>}
        <article className={`panel analytics-card ${qualityIssues ? "quality-warning" : ""}`}><header><div data-korean-heading><h2>데이터 품질</h2></div><span>{qualityIssues}건</span></header><div className="analytics-quality">{snapshot.quality.map((item) => <div key={item.label}><span>{item.label}</span><strong>{item.value}건</strong></div>)}</div></article>
      </section>
      {!data?.canSensitive && <p className="analytics-access-note">급여·성과평가 집계는 HR 관리자 권한에서만 표시됩니다. 현재 화면과 CSV에는 개인 식별정보가 포함되지 않습니다.</p>}
      <section className="panel analytics-reports"><header><div data-korean-heading><h2>저장 리포트</h2></div><span>생성 당시 집계값 보존</span></header>{data?.canSensitive ? <div>{data.reports.length ? data.reports.map((report) => <button type="button" className={savedView === report.id ? "active" : ""} key={report.id} onClick={() => void load(report.periodStart, report.periodEnd, report.id)}><div><strong>{report.title}</strong><small>v{report.version} · {new Date(report.createdAt).toLocaleString("ko-KR")} · 생성자 {report.generatedBy}</small></div><span>스냅샷 보기 →</span></button>) : <p className="analytics-empty-row">아직 생성된 리포트가 없습니다.</p>}</div> : <p className="analytics-empty-row">저장 리포트는 HR 관리자만 조회할 수 있습니다.</p>}</section>
      <p className="analytics-control-note">모든 지표는 집계값이며 개인 이름·사번·이메일·연락처·생년월일을 화면과 CSV에 포함하지 않습니다.</p></>}
  </div>;
}
