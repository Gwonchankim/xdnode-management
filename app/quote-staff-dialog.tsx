"use client";

// 담당자 블록 프로필 관리(quote-tool Design §10.2 '머리 요약·편집 › 담당자 블록', QT-Q3, 옛 index.html openStaff·saveStaff).
// 견적서 H15~H17(담당자·연락처·메일)에 찍히는 공유 목록이다. 편집 권한만 연다(Alt+P). 저장하면 모든 사용자에게 반영된다.
// '내 기본값'은 프로필에 내 계정을 연결해 새 견적의 담당자 기본값으로 쓰게 한다(§10.4). 값은 React 텍스트 노드로만 그린다.
import { useEffect, useRef, useState } from "react";
import { quoteRequest, type StaffProfile } from "./quote-client";

type Row = { key: string; id: string | null; name: string; tel: string; email: string; accountId: string | null };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ROWS = 50;
let rowSeq = 0;
const toRow = (profile: StaffProfile): Row => ({ key: `r${(rowSeq += 1)}`, id: profile.id, name: profile.name, tel: profile.tel, email: profile.email, accountId: profile.accountId });
const blankRow = (): Row => ({ key: `r${(rowSeq += 1)}`, id: null, name: "", tel: "", email: "", accountId: null });

export type StaffSaved = { items: StaffProfile[]; before: StaffProfile[] };

export default function QuoteStaffDialog({ profiles, accountId, onClose, onSaved }: {
  profiles: StaffProfile[]; accountId: string; onClose: () => void; onSaved: (result: StaffSaved) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => (profiles.length ? profiles.map(toRow) : [blankRow()]));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const firstInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => { firstInput.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const update = (key: string, patch: Partial<Row>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  function makeMine(key: string) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, accountId } : row.accountId === accountId ? { ...row, accountId: null } : row)));
  }
  function remove(key: string) {
    if (rows.length <= 1) { setError("담당자를 최소 한 명은 남겨야 합니다."); return; }
    setRows((current) => current.filter((row) => row.key !== key));
    setError("");
  }

  async function save() {
    setError("");
    const items = rows.map((row) => ({ ...row, name: row.name.trim(), tel: row.tel.trim(), email: row.email.trim() })).filter((row) => row.name);
    if (!items.length) { setError("이름이 비어 있습니다. 최소 한 명은 필요합니다."); return; }
    const names = items.map((row) => row.name);
    const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
    if (duplicates.length) { setError(`이름이 중복됩니다 · ${duplicates.join(", ")}`); return; }
    const badMail = items.find((row) => row.email && !EMAIL.test(row.email));
    if (badMail) { setError(`이메일 형식이 올바르지 않습니다 · ${badMail.name}`); return; }
    setBusy(true);
    const result = await quoteRequest<StaffSaved>("/api/quote/staff", "POST", {
      action: "SAVE", items: items.map(({ id, name, tel, email, accountId: linked }) => ({ id, name, tel, email, accountId: linked })),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 409 ? "다른 사용자가 먼저 바꿨습니다. 창을 닫고 다시 열어 주세요." : result.body.error ?? "저장하지 못했습니다.");
      return;
    }
    onSaved({ items: result.body.items, before: result.body.before });
  }

  return (
    <div className="quote-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="quote-modal" role="dialog" aria-modal="true" aria-labelledby="quote-staff-title">
        <header>
          <strong id="quote-staff-title">담당자 관리</strong>
          <button type="button" className="quote-icon-button" aria-label="닫기" onClick={onClose}>×</button>
        </header>
        <div className="quote-modal-body">
          <p className="quote-muted">견적서의 담당자·연락처·이메일로 들어갑니다. 저장하면 모든 사용자에게 반영됩니다. 「내 기본값」은 새 견적을 열 때 먼저 고릅니다.</p>
          <table className="quote-staff-table">
            <thead><tr><th>이름 · 직함</th><th>연락처</th><th>이메일</th><th>내 기본값</th><th aria-label="삭제" /></tr></thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.key} className={row.accountId === accountId ? "mine" : undefined}>
                  <td><input ref={index === 0 ? firstInput : undefined} value={row.name} maxLength={40} placeholder="홍길동 팀장" aria-label="이름 · 직함" onChange={(event) => update(row.key, { name: event.target.value })} /></td>
                  <td><input value={row.tel} maxLength={40} placeholder="010-0000-0000" aria-label="연락처" onChange={(event) => update(row.key, { tel: event.target.value })} /></td>
                  <td><input value={row.email} maxLength={120} placeholder="name@xdnode.co.kr" aria-label="이메일" onChange={(event) => update(row.key, { email: event.target.value })} /></td>
                  <td className="center"><input type="radio" name="quote-staff-mine" checked={row.accountId === accountId} aria-label={`${row.name || "이 담당자"}를 내 기본값으로`} onChange={() => makeMine(row.key)} /></td>
                  <td><button type="button" className="quote-icon-button" aria-label="삭제" onClick={() => remove(row.key)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="quote-small" disabled={rows.length >= MAX_ROWS} onClick={() => setRows((current) => [...current, blankRow()])}>+ 담당자 추가</button>
          {error && <p className="quote-error" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" onClick={onClose}>취소</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? "저장 중…" : "저장"}</button>
        </footer>
      </div>
    </div>
  );
}
