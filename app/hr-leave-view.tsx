"use client";

import { useCallback, useEffect, useState } from "react";
import { LEAVE_KINDS, type LeaveGrant, type LeaveKind, type PromotionNotice } from "./hr-leave-accrual";
import { useErpDialog } from "./erp-dialog";
import { copyText } from "./client-runtime";

/** 연차관리 화면. 계산은 서버(/api/hr/leave → app/hr-leave-accrual.ts)가 하고 여기서는 그리기와 입력만 한다.
 *  기획: docs/hr-leave-management-plan.md 4.3절. 스타일: public/hr-workspace.css 의 .leave-* 규칙. */

type Promotion = PromotionNotice & { text: string };
type LedgerSummary = {
  employeeId: string; name: string; department: string; email: string; status: string; joinDate: string; exitDate: string;
  granted: number; used: number; expired: number; balance: number; overdraft: number; nonDeductedUnits: number;
  grantedByKind: Record<LeaveGrant["kind"], number>;
  promotions: Promotion[]; grantCount: number; usageCount: number;
};
type UsageRow = { id: string; date: string; endDate: string; kind: LeaveKind; leaveType: string; units: number; deducts: boolean; note?: string; source: string; recordedBy: string; label: string };
type LedgerDetail = Omit<LedgerSummary, "grantCount" | "usageCount"> & { grants: LeaveGrant[]; usages: UsageRow[] };

const KIND_ORDER: LeaveKind[] = ["ANNUAL", "HALF", "QUARTER", "BIRTHDAY_HALF", "OFFICIAL", "SICK", "FAMILY", "OTHER"];
const days = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0+$/, "")}일`;
const todayInKorea = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
/* 팝업 제목줄 접힘 기준. hr-workspace.tsx 의 nextCondensed 와 같다. */
const nextCondensed = (current: boolean, scrollTop: number) => (current ? scrollTop > 8 : scrollTop > 56);

async function fetchLedger(employeeId: string) {
  const response = await fetch(`/api/hr/leave?employeeId=${encodeURIComponent(employeeId)}`);
  const payload = await response.json() as { ledger?: LedgerDetail; error?: string };
  if (!response.ok || !payload.ledger) throw new Error(payload.error || "연차 원장을 불러오지 못했습니다.");
  return payload.ledger;
}

function BalancePill({ value }: { value: number }) {
  return <span className={`leave-balance ${value < 0 ? "negative" : value === 0 ? "zero" : ""}`}>{days(value)}</span>;
}

/** 범례·내역·달력이 같은 기호를 사용한다. 다른 차트의 i 요소 스타일을 상속하지 않는다. */
function LeaveSymbol({ kind }: { kind: LeaveKind }) {
  return <span className={`leave-swatch ${kind.toLowerCase()}`} aria-hidden="true">{LEAVE_KINDS[kind].symbol}</span>;
}

/** 직원 한 명의 원장 본문 — 요약, 기록 추가, 사용 내역, 발생 원장, 연간 격자. 팝업과 인사기록카드 탭이 같이 쓴다. */
export function LeaveLedgerBody({ ledger, onChange, onNotify }: { ledger: LedgerDetail; onChange: (next: LedgerDetail) => void; onNotify: (message: string) => void }) {
  const dialog = useErpDialog();
  const today = todayInKorea();
  const [draft, setDraft] = useState({ date: today, leaveType: "ANNUAL" as LeaveKind, units: "1", note: "" });
  const [year, setYear] = useState(today.slice(0, 4));
  const [busy, setBusy] = useState(false);

  async function send(body: Record<string, unknown>, success: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/hr/leave", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { ledger?: LedgerDetail; error?: string };
      if (!response.ok || !payload.ledger) throw new Error(payload.error || "저장하지 못했습니다.");
      onChange(payload.ledger); onNotify(success);
    } catch (error) { onNotify(error instanceof Error ? error.message : "저장하지 못했습니다."); }
    finally { setBusy(false); }
  }
  async function remove(usage: UsageRow) {
    if (!(await dialog.confirm(`${usage.date} ${usage.label} ${days(usage.units)} 기록을 지웁니다. 계속할까요?`, { title: "휴가 기록 삭제", confirmLabel: "삭제", danger: true }))) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/hr/leave?id=${encodeURIComponent(usage.id)}`, { method: "DELETE" });
      const payload = await response.json() as { ledger?: LedgerDetail; error?: string };
      if (!response.ok || !payload.ledger) throw new Error(payload.error || "지우지 못했습니다.");
      onChange(payload.ledger); onNotify("기록을 지웠습니다.");
    } catch (error) { onNotify(error instanceof Error ? error.message : "지우지 못했습니다."); }
    finally { setBusy(false); }
  }

  const usagesByDate = new Map<string, UsageRow[]>();
  for (const usage of ledger.usages) usagesByDate.set(usage.date, [...(usagesByDate.get(usage.date) ?? []), usage]);
  const years = [...new Set([today.slice(0, 4), ...ledger.usages.map((usage) => usage.date.slice(0, 4))])].sort().reverse();

  return <div className="leave-body">
    <div className="leave-summary">
      <div><span>입사일</span><strong>{ledger.joinDate || "-"}</strong></div>
      <div><span>발생</span><strong>{days(ledger.granted)}</strong></div>
      <div><span>사용</span><strong>{days(ledger.used)}</strong></div>
      <div><span>소멸</span><strong>{days(ledger.expired)}</strong></div>
      <div><span>잔여</span><BalancePill value={ledger.balance} /></div>
      <div><span>미차감 기록</span><strong>{days(ledger.nonDeductedUnits)}</strong></div>
    </div>
    {ledger.overdraft > 0 && <p className="contract-warning">발생한 일수보다 {days(ledger.overdraft)} 더 썼습니다. 다음 발생분에서 차감되거나 무급 처리해야 합니다.</p>}
    {ledger.promotions.length > 0 && <div className="leave-promotions">{ledger.promotions.map((item) => (
      <div key={item.grantKey}><span className={`renewal-state ${item.stage === "SECOND" ? "overdue" : "due"}`}>{item.stage === "SECOND" ? "2차 촉진" : "1차 촉진"}</span><strong>{item.label} 잔여 {days(item.remaining)}</strong><small>{item.expiresAt} 소멸 (D-{item.daysLeft})</small>
        <button type="button" onClick={() => { void copyText(item.text).then(() => onNotify("안내문을 복사했습니다. 하이웍스 메일에 붙여 넣으세요."), () => onNotify("복사하지 못했습니다. 안내문을 직접 선택해 복사해 주세요.")); }}>안내문 복사</button></div>
    ))}</div>}

    <form className="leave-form" onSubmit={(event) => { event.preventDefault(); void send({ resource: "record", employeeId: ledger.employeeId, date: draft.date, leaveType: draft.leaveType, units: Number(draft.units), note: draft.note }, "휴가 기록을 저장했습니다."); }}>
      <label><span>날짜</span><input required type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label>
      <label><span>종류</span><select value={draft.leaveType} onChange={(event) => { const kind = event.target.value as LeaveKind; setDraft({ ...draft, leaveType: kind, units: String(LEAVE_KINDS[kind].units) }); }}>
        {KIND_ORDER.map((kind) => <option key={kind} value={kind}>{LEAVE_KINDS[kind].symbol} {LEAVE_KINDS[kind].label}{LEAVE_KINDS[kind].deducts ? "" : " (미차감)"}</option>)}
      </select></label>
      <label><span>일수</span><input type="number" min="0.25" step="0.25" value={draft.units} onChange={(event) => setDraft({ ...draft, units: event.target.value })} /></label>
      <label className="leave-form-note"><span>메모</span><input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="사유·비고" /></label>
      <button type="submit" className="primary-button" disabled={busy}>기록 추가</button>
    </form>

    <div className="leave-columns">
      <section>
        <h3 className="dash-subtitle">사용 내역 <em>{ledger.usages.length}건</em></h3>
        {ledger.usages.length ? <div className="data-table-wrap leave-scroll"><table className="data-table dashboard-mini-table"><thead><tr><th>날짜</th><th>종류</th><th>일수</th><th>차감</th><th>메모</th><th></th></tr></thead>
          <tbody>{[...ledger.usages].sort((a, b) => b.date.localeCompare(a.date)).map((usage) => <tr key={usage.id}>
            <td>{usage.date}</td><td><span className="leave-kind-label"><LeaveSymbol kind={usage.kind} />{usage.label}</span></td><td>{days(usage.units)}</td><td>{usage.deducts ? "차감" : <span className="leave-muted">미차감</span>}</td>
            <td className="leave-note">{usage.note || (usage.source === "SHEET_IMPORT" ? <span className="leave-muted">시트 이관</span> : "")}</td>
            <td><button type="button" className="leave-link danger" disabled={busy} onClick={() => void remove(usage)}>삭제</button></td>
          </tr>)}</tbody></table></div> : <p className="dash-empty">기록이 없습니다.</p>}
      </section>
      <section>
        <h3 className="dash-subtitle">발생 원장 <em>{ledger.grants.filter((grant) => grant.status === "GRANTED").length}건</em></h3>
        <div className="data-table-wrap leave-scroll"><table className="data-table dashboard-mini-table"><thead><tr><th>구분</th><th>발생일</th><th>부여</th><th>사용</th><th>잔여</th><th>소멸일</th><th>상태</th><th></th></tr></thead>
          <tbody>{ledger.grants.map((grant) => <tr key={grant.key} className={grant.status !== "GRANTED" ? "leave-dim" : ""}>
            <td>{grant.label}</td><td>{grant.grantDate}</td><td>{days(grant.units)}</td><td>{days(grant.used)}</td><td>{days(grant.remaining)}</td><td>{grant.expiresAt}</td>
            <td><span className={`renewal-state ${grant.status === "EXCLUDED" ? "overdue" : grant.status === "NOT_DUE" ? "soon" : grant.expired ? "due" : "soon"}`}>{grant.status === "EXCLUDED" ? "제외" : grant.status === "NOT_DUE" ? "예정" : grant.expired ? "소멸" : "발생"}</span></td>
            <td>{grant.kind === "MONTHLY" && grant.status !== "NOT_DUE" && <button type="button" className="leave-link" disabled={busy} title={grant.note || (grant.status === "EXCLUDED" ? "제외를 풀어 자동 부여로 되돌립니다" : "결근 등으로 이 달 월차를 주지 않습니다")}
              onClick={async () => { if (grant.status === "EXCLUDED") void send({ resource: "adjustment", employeeId: ledger.employeeId, grantKey: grant.key }, "제외를 해제했습니다."); else { const note = (await dialog.prompt(`${grant.label}을 제외하는 사유를 입력하세요.`, { title: "월차 제외", defaultValue: "결근", placeholder: "제외 사유" })) ?? ""; if (note.trim()) void send({ resource: "adjustment", employeeId: ledger.employeeId, grantKey: grant.key, status: "EXCLUDED", note: note.trim() }, "월차를 제외 처리했습니다."); } }}>{grant.status === "EXCLUDED" ? "제외 해제" : "제외"}</button>}</td>
          </tr>)}</tbody></table></div>
      </section>
    </div>

    <section className="leave-year">
      <div className="leave-year-head"><h3 className="dash-subtitle">연간 사용 격자</h3><div className="dash-chips">{years.map((item) => <button type="button" key={item} className={year === item ? "active" : ""} onClick={() => setYear(item)}>{item}년</button>)}</div>
        <ul className="leave-legend" aria-label="휴가 종류별 색상과 기호">{KIND_ORDER.map((kind) => <li key={kind}><LeaveSymbol kind={kind} /><span>{LEAVE_KINDS[kind].label}</span></li>)}</ul></div>
      <div className="leave-grid-wrap"><table className="leave-grid"><thead><tr><th></th>{Array.from({ length: 31 }, (_, index) => <th key={index}>{index + 1}</th>)}</tr></thead>
        <tbody>{Array.from({ length: 12 }, (_, month) => <tr key={month}><th>{month + 1}월</th>{Array.from({ length: 31 }, (_, day) => {
          const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day + 1).padStart(2, "0")}`;
          const valid = new Date(`${date}T00:00:00Z`).getUTCMonth() === month;
          const hits = usagesByDate.get(date) ?? [];
          const colors = [...new Set(hits.map((hit) => `var(--leave-${hit.kind.toLowerCase()})`))];
          // 같은 날 여러 종류를 사용했다면 각 색을 같은 높이의 띠로 표시한다.
          const background = !valid || colors.length === 0 ? undefined : colors.length === 1 ? colors[0]
            : `linear-gradient(to bottom, ${colors.map((color, index) => `${color} ${index * 100 / colors.length}% ${(index + 1) * 100 / colors.length}%`).join(", ")})`;
          const weekday = valid ? new Date(`${date}T00:00:00Z`).getUTCDay() : -1;
          const description = hits.length ? `${date} ${hits.map((hit) => `${hit.label} ${days(hit.units)}`).join(", ")}` : valid ? date : "";
          return <td key={day} style={{ background }} className={`${!valid ? "void" : weekday === 0 || weekday === 6 ? "weekend" : ""}${date === today ? " today" : ""}`} title={description} aria-label={description || undefined}>
            {hits.length > 0 && <span className="leave-day-records">{hits.map((hit) => <LeaveSymbol key={hit.id} kind={hit.kind} />)}</span>}
          </td>;
        })}</tr>)}</tbody></table></div>
    </section>
  </div>;
}

/** 인사기록카드 팝업 안의 「연차」 카드. */
export function LeaveLedgerPanel({ employeeId, onNotify }: { employeeId: string; onNotify: (message: string) => void }) {
  const [ledger, setLedger] = useState<LedgerDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetchLedger(employeeId).then((next) => { if (!cancelled) setLedger(next); }).catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [employeeId]);
  return <section className="panel detail-card leave-panel">
    <div className="detail-card-heading"><div data-korean-heading><h2>월차·연차</h2></div>{ledger && <span>잔여 {days(ledger.balance)}</span>}</div>
    {error ? <p className="dash-empty">{error}</p> : ledger ? <LeaveLedgerBody ledger={ledger} onChange={setLedger} onNotify={onNotify} /> : <p className="dash-empty">불러오는 중입니다.</p>}
  </section>;
}

/** 연차관리 메뉴 — 재직자 잔여 현황, 촉진 안내 큐, 직원 카드 팝업. */
export default function LeaveManagementView({ onNotify }: { onNotify: (message: string) => void }) {
  const [ledgers, setLedgers] = useState<LedgerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRetired, setShowRetired] = useState(false);
  const [selected, setSelected] = useState<LedgerDetail | null>(null);
  const [condensed, setCondensed] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/hr/leave");
      const payload = await response.json() as { ledgers?: LedgerSummary[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "연차 현황을 불러오지 못했습니다.");
      setLedgers(payload.ledgers ?? []);
    } catch (error) { onNotify(error instanceof Error ? error.message : "연차 현황을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }, [onNotify]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const active = ledgers.filter((item) => item.status.trim() !== "퇴직" && !item.exitDate);
  const visible = (showRetired ? ledgers : active).filter((item) => !query || item.name.includes(query) || item.department.includes(query));
  const teamMembers = new Map<string, LedgerSummary[]>();
  for (const item of visible) {
    const team = item.department.trim() || "소속 미지정";
    teamMembers.set(team, [...(teamMembers.get(team) ?? []), item]);
  }
  const teams = [...teamMembers].sort(([a], [b]) => a.localeCompare(b, "ko"));
  const promotions = active.flatMap((item) => item.promotions.map((notice) => ({ ...notice, employee: item })));
  const negatives = active.filter((item) => item.balance < 0);
  const metrics = [
    { label: "재직자 잔여 합계", value: days(active.reduce((sum, item) => sum + item.balance, 0)), note: `${active.length}명 · 소멸 규칙 적용`, tone: "navy" },
    { label: "촉진 안내 대상", value: `${promotions.length}건`, note: `1차 ${promotions.filter((item) => item.stage === "FIRST").length} · 2차 ${promotions.filter((item) => item.stage === "SECOND").length}`, tone: "orange" },
    { label: "초과 사용", value: `${negatives.length}명`, note: negatives.length ? negatives.map((item) => item.name).slice(0, 3).join(", ") : "없음", tone: "red" },
    { label: "누적 소멸", value: days(active.reduce((sum, item) => sum + item.expired, 0)), note: "입사 이후 쓰지 못하고 소멸한 일수", tone: "blue" },
  ];

  async function open(employeeId: string) {
    try { setCondensed(false); setSelected(await fetchLedger(employeeId)); }
    catch (error) { onNotify(error instanceof Error ? error.message : "연차 원장을 불러오지 못했습니다."); }
  }
  function close() { setSelected(null); void load(); }

  return <div className="page-wrap module-page leave-page">
    <section className="module-hero"><div data-korean-heading><h1>연차관리</h1><p>입사일 기준으로 월차(1~11개월차)와 연차(주년마다, 법정 가산)를 자동 부여하고 1년이 지나면 소멸합니다. 생일 반차·공가는 기록만 하고 차감하지 않습니다.</p></div><span className="payroll-import-badge">HR 대리 입력</span></section>
    <section className="metric-grid module-metrics">{metrics.map((metric) => <div className="compact-metric" key={metric.label}><span className={`metric-accent ${metric.tone}`}></span><p>{metric.label}</p><h2>{metric.value}</h2><small>{metric.note}</small></div>)}</section>

    {promotions.length > 0 && <section className="panel dash-panel leave-queue">
      <div className="section-heading"><div data-korean-heading><h2>촉진 안내 대상 <em>{promotions.length}건</em></h2></div><span className="dash-hint">소멸 6개월 전 1차(사용 시기 지정 요청), 2개월 전 2차(회사 지정 통보). 안내문을 복사해 하이웍스 메일로 보냅니다.</span></div>
      <table className="data-table dashboard-mini-table"><thead><tr><th>직원</th><th>발생분</th><th>잔여</th><th>소멸일</th><th>단계</th><th></th></tr></thead>
        <tbody>{promotions.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)).map((item) => <tr key={`${item.employee.employeeId}-${item.grantKey}`}>
          <td><button type="button" className="name-link" onClick={() => void open(item.employee.employeeId)}>{item.employee.name}</button></td><td>{item.label}</td><td>{days(item.remaining)}</td><td>{item.expiresAt} <em className="renewal-dday">D-{item.daysLeft}</em></td>
          <td><span className={`renewal-state ${item.stage === "SECOND" ? "overdue" : "due"}`}>{item.stage === "SECOND" ? "2차" : "1차"}</span></td>
          <td><button type="button" className="leave-link" onClick={() => { void copyText(item.text).then(() => onNotify(`${item.employee.name}님 안내문을 복사했습니다.`), () => onNotify("복사하지 못했습니다. 안내문을 직접 선택해 복사해 주세요.")); }}>안내문 복사</button></td>
        </tr>)}</tbody></table>
    </section>}

    <section className="panel table-panel">
      <div className="table-toolbar"><div><h2>잔여 현황</h2><span>{teams.length}개 팀 · {visible.length}명 · 이름을 누르면 원장과 기록 입력이 열립니다.</span></div>
        <div className="leave-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름·소속 검색" /><label><input type="checkbox" checked={showRetired} onChange={(event) => setShowRetired(event.target.checked)} /> 퇴직자 포함</label></div></div>
      <p className="leave-table-note">발생은 입사 이후 누계입니다. 사용·소멸된 발생분을 포함하며, 예정·제외분은 포함하지 않습니다.</p>
      <div className="data-table-wrap"><table className="data-table leave-table"><thead><tr><th scope="col">직원</th><th scope="col">입사일</th><th scope="col" className="leave-number">월차 발생</th><th scope="col" className="leave-number">연차 발생</th><th scope="col" className="leave-number">발생 합계</th><th scope="col" className="leave-number">사용</th><th scope="col" className="leave-number">소멸</th><th scope="col" className="leave-number leave-balance-cell">잔여</th><th scope="col">촉진</th><th scope="col">상태</th></tr></thead>
        {loading ? <tbody><tr><td colSpan={10} className="table-message">연차 현황을 불러오는 중입니다.</td></tr></tbody>
          : teams.length === 0 ? <tbody><tr><td colSpan={10} className="table-message">조건에 맞는 직원이 없습니다.</td></tr></tbody>
          : teams.map(([team, members]) => <tbody key={team} aria-label={`${team} 잔여 현황`}>
            <tr className="leave-team-row"><th scope="rowgroup" colSpan={10}><div><strong>{team}</strong><span>{members.length}명</span></div></th></tr>
            {members.map((item) => <tr key={item.employeeId}>
              <td><button type="button" className="leave-ledger-link" onClick={() => void open(item.employeeId)}>{item.name}<span>원장 보기 →</span></button></td><td>{item.joinDate}</td>
              <td className="leave-number">{days(item.grantedByKind.MONTHLY)}</td><td className="leave-number">{days(item.grantedByKind.ANNUAL)}</td><td className="leave-number"><strong>{days(item.granted)}</strong></td>
              <td className="leave-number">{days(item.used)}</td><td className="leave-number">{days(item.expired)}</td><td className="leave-number leave-balance-cell"><BalancePill value={item.balance} /></td>
              <td>{item.promotions.length ? <span className={`renewal-state ${item.promotions.some((notice) => notice.stage === "SECOND") ? "overdue" : "due"}`}>{item.promotions.length}건</span> : "-"}</td>
              <td>{item.exitDate ? <span className="leave-muted">퇴직 {item.exitDate}</span> : item.status}</td>
            </tr>)}
          </tbody>)}
      </table></div>
    </section>

    {selected && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      {/* 팝업 스크롤로 제목줄을 접어야 해서 section 에 스크롤 핸들러를 단다. 다른 팝업과 같은 방식이다. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <section className={`employee-modal leave-card-modal${condensed ? " condensed" : ""}`} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()} onScroll={(event) => { const top = event.currentTarget.scrollTop; setCondensed((current) => nextCondensed(current, top)); }}>
        <div className="modal-header"><div data-korean-heading><h2>{selected.name} 월차·연차 원장</h2></div><button type="button" aria-label="닫기" onClick={close}>×</button></div>
        <LeaveLedgerBody ledger={selected} onChange={setSelected} onNotify={onNotify} />
      </section>
    </div>}
  </div>;
}
