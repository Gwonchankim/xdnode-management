"use client";

// 계정 관리 탭(Design §4.2.6, §5.4 AdminAccountsWorkspace, D7·D12·D13·D14·D23). 관리자 전용이고, 서버가 admin:read·admin:write 로
// 다시 검사한다. 임시 비밀번호는 응답에 한 번만 오므로 대화상자에 한 번만 보여 주고 어디에도 저장하지 않는다.
// 오류는 status·code 로 분기하고, LAST_ADMIN·DUPLICATE 문구는 서버 문구를 그대로 보여 준 뒤 목록을 다시 읽어 폼을 되돌린다.
// R4: /api/admin/backups 의 stale·실패를 상단 경고로 보여 준다.

import { FormEvent, useCallback, useEffect, useId, useState, type ReactNode } from "react";
import type { GrantableTabKey, TabLevel } from "./access-tabs";
import { copyText } from "./client-runtime";
import { useErpDialog } from "./erp-dialog";
import { NETWORK_ERROR_MESSAGE, requestJson } from "./session-client";

type AccountDto = {
  id: string; email: string; displayName: string; employeeId: string | null; isAdmin: boolean; active: boolean;
  mustChangePassword: boolean; lockedUntil: number | null; failedAttempts: number; tabs: Record<GrantableTabKey, TabLevel>;
  lastLoginAt: number | null; createdAt: number; activeSessions: number;
};
type EmployeeOption = { employeeId: string; name: string; department: string; status: string; linkedAccountId: string | null };
type GrantableTab = { key: GrantableTabKey; label: string };
type AccountsPayload = { accounts: AccountDto[]; employees: EmployeeOption[]; grantableTabs: GrantableTab[] };
/** GET /api/admin/backups(R4, Design §4.2.6). */
type BackupStatus = { lastSuccessAt: number | null; lastRun: { id: string; status: string; finishedAt: number; error: string } | null; stale: boolean };

const LEVEL_LABELS: Array<[TabLevel, string]> = [["none", "숨김"], ["view", "보기"], ["edit", "편집"]];

function formatDateTime(value: number | null) {
  if (!value) return "없음";
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function accountStatus(account: AccountDto, now: number) {
  if (!account.active) return { label: "비활성", tone: "inactive" };
  if (account.lockedUntil && account.lockedUntil > now) {
    return { label: `잠김 ${Math.max(1, Math.ceil((account.lockedUntil - now) / 60_000))}분`, tone: "locked" };
  }
  return { label: account.mustChangePassword ? "활성 · 비밀번호 변경 대기" : "활성", tone: "active" };
}

function TabLevelControl({ label, value, disabled, onChange }: { label: string; value: TabLevel; disabled?: boolean; onChange: (level: TabLevel) => void }) {
  return (
    <div className="segment-control admin-accounts-level" role="group" aria-label={`${label} 권한`}>
      {LEVEL_LABELS.map(([level, text]) => (
        <button type="button" key={level} className={value === level ? "active" : ""} aria-pressed={value === level}
          disabled={disabled} onClick={() => { if (value !== level) onChange(level); }}>{text}</button>
      ))}
    </div>
  );
}

function Modal({ title, onClose, children, busy }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return (
    <div className="modal-backdrop erp-dialog-backdrop" role="presentation">
      <section className="erp-dialog admin-accounts-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="erp-dialog-head"><h2 id={titleId}>{title}</h2></header>
        {children}
      </section>
    </div>
  );
}

type CreateForm = { source: "employee" | "manual"; employeeId: string; displayName: string; email: string; isAdmin: boolean; tabs: Record<string, TabLevel> };

function CreateAccountDialog({ employees, grantableTabs, onClose, onCreated }: {
  employees: EmployeeOption[]; grantableTabs: GrantableTab[]; onClose: () => void;
  onCreated: (account: AccountDto, temporaryPassword: string) => void;
}) {
  const [form, setForm] = useState<CreateForm>(() => ({
    source: "employee", employeeId: "", displayName: "", email: "", isAdmin: false,
    tabs: Object.fromEntries(grantableTabs.map((tab) => [tab.key, "none"])),
  }));
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState<{ field?: string; message?: string }>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(""); setFieldError({});
    const email = form.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setFieldError({ field: "email", message: "이메일 형식을 확인해 주세요." }); return; }
    if (form.source === "employee" && !form.employeeId) { setFieldError({ field: "employeeId", message: "연결할 직원을 골라 주세요." }); return; }
    if (form.source === "manual" && (form.displayName.trim().length < 1 || form.displayName.trim().length > 60)) {
      setFieldError({ field: "displayName", message: "이름은 1자 이상 60자 이하로 입력해 주세요." }); return;
    }
    setBusy(true);
    const result = await requestJson<{ account?: AccountDto; temporaryPassword?: string }>("/api/admin/accounts", "POST", {
      action: "CREATE", email, isAdmin: form.isAdmin,
      ...(form.source === "employee" ? { employeeId: form.employeeId } : { displayName: form.displayName.trim() }),
      ...(form.isAdmin ? {} : { tabs: form.tabs }),
    });
    setBusy(false);
    if (result.status === 201 && result.body.account && result.body.temporaryPassword) {
      onCreated(result.body.account, result.body.temporaryPassword);
      return;
    }
    if ((result.status === 400 || result.status === 409) && result.body.field) {
      setFieldError({ field: result.body.field, message: result.body.error }); return;
    }
    setError(result.body.error || NETWORK_ERROR_MESSAGE);
  }

  const fieldMessage = (field: string) => fieldError.field === field ? <small className="auth-field-error">{fieldError.message}</small> : null;

  return (
    <Modal title="계정 만들기" onClose={onClose} busy={busy}>
      <form onSubmit={submit} noValidate>
        <div className="erp-dialog-body admin-accounts-form">
          <fieldset className="admin-accounts-source">
            <legend>이름</legend>
            <label><input type="radio" name="source" checked={form.source === "employee"} onChange={() => setForm({ ...form, source: "employee" })} /> 인사기록에서 고르기</label>
            <label><input type="radio" name="source" checked={form.source === "manual"} onChange={() => setForm({ ...form, source: "manual", employeeId: "" })} /> 이름 직접 입력</label>
          </fieldset>
          {form.source === "employee" ? (
            <label>
              <span>직원</span>
              <select value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.target.value })}>
                <option value="">직원을 고르세요</option>
                {employees.map((employee) => (
                  <option key={employee.employeeId} value={employee.employeeId} disabled={Boolean(employee.linkedAccountId)}>
                    {employee.name} · {employee.department || "부서 없음"} · {employee.status}{employee.linkedAccountId ? " (이미 연결됨)" : ""}
                  </option>
                ))}
              </select>
              {fieldMessage("employeeId")}
            </label>
          ) : (
            <label>
              <span>표시 이름</span>
              <input value={form.displayName} maxLength={60} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
              {fieldMessage("displayName")}
            </label>
          )}
          <label>
            <span>이메일</span>
            <input type="email" value={form.email} maxLength={200} autoComplete="off" onChange={(event) => setForm({ ...form, email: event.target.value })} />
            {fieldMessage("email")}
          </label>
          <label className="admin-accounts-check">
            <input type="checkbox" checked={form.isAdmin} onChange={(event) => setForm({ ...form, isAdmin: event.target.checked })} />
            <span>관리자(모든 탭 편집, 감사 로그·계정 관리 포함)</span>
          </label>
          {!form.isAdmin && (
            <div className="admin-accounts-initial-tabs">
              <span>초기 탭 권한</span>
              {grantableTabs.map((tab) => (
                <div key={tab.key} className="admin-accounts-initial-tab">
                  <strong>{tab.label}</strong>
                  <TabLevelControl label={tab.label} value={form.tabs[tab.key] ?? "none"} onChange={(level) => setForm({ ...form, tabs: { ...form.tabs, [tab.key]: level } })} />
                </div>
              ))}
              {fieldMessage("tabs")}
            </div>
          )}
          <p className="erp-dialog-hint">임시 비밀번호가 발급되고, 첫 로그인 때 비밀번호를 바꾸게 됩니다.</p>
          {error && <p className="auth-error" role="alert">{error}</p>}
        </div>
        <footer className="erp-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>취소</button>
          <button type="submit" className="erp-dialog-primary" disabled={busy}>{busy ? "만드는 중…" : "계정 만들기"}</button>
        </footer>
      </form>
    </Modal>
  );
}

function TemporaryPasswordDialog({ account, password, onClose }: { account: AccountDto; password: string; onClose: () => void }) {
  const [copyState, setCopyState] = useState("");
  return (
    <Modal title="임시 비밀번호" onClose={onClose}>
      <div className="erp-dialog-body">
        <p>{account.displayName}({account.email}) 계정의 임시 비밀번호입니다. 본인에게 직접 전달해 주세요. 첫 로그인 때 새 비밀번호로 바꾸게 됩니다.</p>
        <code className="admin-accounts-temp-password" aria-label="임시 비밀번호">{password}</code>
        <p className="admin-accounts-warning" role="note">이 창을 닫으면 다시 볼 수 없습니다.</p>
        {copyState && <p className="erp-dialog-hint" role="status">{copyState}</p>}
      </div>
      <footer className="erp-dialog-actions">
        <button type="button" onClick={() => { void copyText(password).then(() => setCopyState("복사했습니다."), () => setCopyState("복사하지 못했습니다. 값을 직접 선택해 복사해 주세요.")); }}>복사</button>
        <button type="button" className="erp-dialog-primary" onClick={onClose}>닫기</button>
      </footer>
    </Modal>
  );
}

function LinkEmployeeDialog({ account, employees, onClose, onSaved }: {
  account: AccountDto; employees: EmployeeOption[]; onClose: () => void; onSaved: (message: string) => void;
}) {
  const [employeeId, setEmployeeId] = useState(account.employeeId ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setError("");
    const result = await requestJson("/api/admin/accounts", "POST", { action: "UPDATE_PROFILE", id: account.id, employeeId: employeeId || null });
    setBusy(false);
    if (result.ok) { onSaved(employeeId ? "직원 연결을 바꿨습니다." : "직원 연결을 해제했습니다."); return; }
    setError(result.body.error || NETWORK_ERROR_MESSAGE);
  }

  return (
    <Modal title="직원 연결 변경" onClose={onClose} busy={busy}>
      <div className="erp-dialog-body">
        <p>{account.displayName} 계정을 인사기록의 직원과 연결합니다. 연결하지 않아도 계정은 쓸 수 있습니다.</p>
        <label>
          <span>연결할 직원</span>
          <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
            <option value="">연결 없음</option>
            {employees.map((employee) => (
              <option key={employee.employeeId} value={employee.employeeId}
                disabled={Boolean(employee.linkedAccountId) && employee.linkedAccountId !== account.id}>
                {employee.name} · {employee.department || "부서 없음"} · {employee.status}
                {employee.linkedAccountId && employee.linkedAccountId !== account.id ? " (이미 연결됨)" : ""}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="auth-error" role="alert">{error}</p>}
      </div>
      <footer className="erp-dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>취소</button>
        <button type="button" className="erp-dialog-primary" onClick={() => void save()} disabled={busy}>{busy ? "저장 중…" : "저장"}</button>
      </footer>
    </Modal>
  );
}

export default function AdminAccountsWorkspace({ currentAccountId }: { currentAccountId: string }) {
  const dialog = useErpDialog();
  const [data, setData] = useState<AccountsPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busyId, setBusyId] = useState("");
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState<AccountDto | null>(null);
  const [issued, setIssued] = useState<{ account: AccountDto; password: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [backup, setBackup] = useState<BackupStatus | null>(null);

  const load = useCallback(async () => {
    const result = await requestJson<AccountsPayload>("/api/admin/accounts");
    if (result.ok && Array.isArray(result.body.accounts)) {
      setData({ accounts: result.body.accounts, employees: result.body.employees ?? [], grantableTabs: result.body.grantableTabs ?? [] });
      setLoadError("");
      setNow(Date.now());
    } else {
      setLoadError(result.body.error || NETWORK_ERROR_MESSAGE);
    }
  }, []);

  // 백업 경고(R4, §5.4). 조회에 실패하면 경고를 띄우지 않는다(계정 관리 자체와 무관).
  const loadBackup = useCallback(async () => {
    const result = await requestJson<BackupStatus>("/api/admin/backups");
    if (result.ok && typeof result.body.stale === "boolean") setBackup(result.body);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 첫 조회. load 가 끝난 뒤에만 상태를 바꾼다.
    void load();
    void loadBackup();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [load, loadBackup]);

  const employeeName = (employeeId: string | null) => {
    if (!employeeId) return "연결 없음";
    return data?.employees.find((employee) => employee.employeeId === employeeId)?.name ?? employeeId;
  };

  /** 행 작업 공통: 요청 → 성공이면 목록 다시 읽기, 실패면 서버 문구 표시 후 목록 다시 읽기(폼 되돌림). */
  async function run(account: AccountDto, body: Record<string, unknown>, success: string) {
    setBusyId(account.id); setMessage(null);
    const result = await requestJson<{ account?: AccountDto; temporaryPassword?: string }>("/api/admin/accounts", "POST", { ...body, id: account.id });
    setBusyId("");
    if (result.ok) {
      if (result.body.temporaryPassword && result.body.account) setIssued({ account: result.body.account, password: result.body.temporaryPassword });
      setMessage({ tone: "ok", text: success });
    } else {
      setMessage({ tone: "error", text: result.body.error || NETWORK_ERROR_MESSAGE });
    }
    await load();
    return result.ok;
  }

  async function changeTab(account: AccountDto, tab: GrantableTab, level: TabLevel) {
    // 낙관적으로 바꾸고, 실패하면 load() 가 서버 값으로 되돌린다.
    setData((current) => current && ({ ...current, accounts: current.accounts.map((item) => item.id === account.id ? { ...item, tabs: { ...item.tabs, [tab.key]: level } } : item) }));
    await run(account, { action: "UPDATE_TABS", tabs: { [tab.key]: level } }, `${account.displayName}의 ${tab.label} 권한을 바꿨습니다. 다음 요청부터 적용됩니다.`);
  }

  async function resetPassword(account: AccountDto) {
    if (!await dialog.confirm(`${account.displayName}의 비밀번호를 초기화할까요? 새 임시 비밀번호가 발급되고, 그 계정의 로그인은 모두 끊깁니다.`, { title: "비밀번호 초기화", confirmLabel: "초기화", danger: true })) return;
    await run(account, { action: "RESET_PASSWORD" }, "임시 비밀번호를 발급했습니다.");
  }

  async function toggleActive(account: AccountDto) {
    if (account.active) {
      if (!await dialog.confirm(`${account.displayName} 계정을 비활성화할까요? 그 계정의 로그인은 모두 끊깁니다.`, { title: "비활성화", confirmLabel: "비활성화", danger: true })) return;
      await run(account, { action: "DEACTIVATE" }, "계정을 비활성화했습니다.");
    } else {
      await run(account, { action: "REACTIVATE" }, "계정을 다시 활성화했습니다.");
    }
  }

  async function revokeSessions(account: AccountDto) {
    const self = account.id === currentAccountId;
    if (!await dialog.confirm(self ? "내 계정의 로그인을 모두 끊을까요? 이 브라우저도 로그아웃됩니다." : `${account.displayName}의 로그인을 모두 끊을까요?`, { title: "세션 모두 끊기", confirmLabel: "모두 끊기", danger: true })) return;
    await run(account, { action: "REVOKE_SESSIONS" }, "로그인을 모두 끊었습니다.");
  }

  async function rename(account: AccountDto) {
    const name = await dialog.prompt("새 표시 이름을 입력해 주세요(1~60자).", { title: "표시 이름 변경", defaultValue: account.displayName, minLength: 1 });
    if (name === null || name === account.displayName) return;
    await run(account, { action: "UPDATE_PROFILE", displayName: name }, "표시 이름을 바꿨습니다.");
  }

  async function toggleAdmin(account: AccountDto) {
    const next = !account.isAdmin;
    if (!await dialog.confirm(next ? `${account.displayName}을(를) 관리자로 지정할까요? 모든 탭을 편집하고 감사 로그·계정 관리를 볼 수 있게 됩니다.` : `${account.displayName}의 관리자 지정을 해제할까요? 부여된 탭 권한만 남습니다.`, { title: next ? "관리자 지정" : "관리자 해제", confirmLabel: next ? "지정" : "해제", danger: !next })) return;
    await run(account, { action: "UPDATE_PROFILE", isAdmin: next }, next ? "관리자로 지정했습니다." : "관리자 지정을 해제했습니다.");
  }

  const grantableTabs = data?.grantableTabs ?? [];
  return (
    <div className="admin-accounts">
      <header className="admin-accounts-head">
        <div data-korean-heading>
          <h1>계정 관리</h1>
          <p>계정마다 탭 권한(숨김·보기·편집)을 줍니다. 권한과 비활성화는 다음 요청부터 바로 적용됩니다.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setCreating(true)} disabled={!data}>계정 만들기</button>
      </header>
      <p className="admin-accounts-pinned" role="note">HR 탭에는 급여관리가 포함됩니다.</p>
      {backup?.stale && (
        <p className="admin-accounts-message error admin-accounts-backup" role="alert">
          마지막 백업 성공: {formatDateTime(backup.lastSuccessAt)}. 36시간 넘게 성공한 백업이 없습니다.
        </p>
      )}
      {backup?.lastRun?.status === "FAILED" && (
        <p className="admin-accounts-message error admin-accounts-backup" role="alert">
          마지막 백업 실패({formatDateTime(backup.lastRun.finishedAt)}): {backup.lastRun.error || "사유가 기록되지 않았습니다."}
        </p>
      )}
      {message && <p className={`admin-accounts-message ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}
      {loadError && <p className="admin-accounts-message error" role="alert">{loadError}</p>}
      {!data && !loadError && <p className="admin-accounts-empty" role="status">계정 목록을 불러오는 중입니다.</p>}
      {data && (
        <div className="panel admin-accounts-table-wrap">
          <table className="admin-accounts-table">
            <thead>
              <tr>
                <th scope="col">이름</th>
                <th scope="col">이메일</th>
                <th scope="col">연결 직원</th>
                <th scope="col">관리자</th>
                <th scope="col">상태</th>
                {grantableTabs.map((tab) => <th scope="col" key={tab.key}>{tab.label}</th>)}
                <th scope="col">마지막 로그인</th>
                <th scope="col">활성 세션</th>
                <th scope="col">작업</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((account) => {
                const status = accountStatus(account, now);
                const self = account.id === currentAccountId;
                const busy = busyId === account.id;
                const locked = Boolean(account.lockedUntil && account.lockedUntil > now) || account.failedAttempts > 0;
                return (
                  <tr key={account.id} className={account.active ? "" : "inactive"} aria-busy={busy || undefined}>
                    <th scope="row">{account.displayName}{self && <small> (나)</small>}</th>
                    <td>{account.email}</td>
                    <td>{employeeName(account.employeeId)}</td>
                    <td>{account.isAdmin ? "관리자" : "일반"}</td>
                    <td><span className={`admin-accounts-status ${status.tone}`}>{status.label}</span></td>
                    {account.isAdmin
                      ? <td colSpan={grantableTabs.length}><span className="admin-accounts-all-tabs" aria-disabled="true">모든 탭 편집</span></td>
                      : grantableTabs.map((tab) => (
                        <td key={tab.key}>
                          <TabLevelControl label={`${account.displayName} ${tab.label}`} value={account.tabs[tab.key] ?? "none"} disabled={busy}
                            onChange={(level) => void changeTab(account, tab, level)} />
                        </td>
                      ))}
                    <td>{formatDateTime(account.lastLoginAt)}</td>
                    <td>{account.activeSessions}</td>
                    <td>
                      <details className="admin-accounts-actions">
                        <summary>작업</summary>
                        <div>
                          <button type="button" disabled={busy || self} title={self ? "본인 비밀번호는 비밀번호 변경에서 바꿔 주세요." : undefined} onClick={() => void resetPassword(account)}>비밀번호 초기화</button>
                          <button type="button" disabled={busy || !locked} onClick={() => void run(account, { action: "UNLOCK" }, "잠금을 해제했습니다.")}>잠금 해제</button>
                          <button type="button" disabled={busy || (self && account.active)} onClick={() => void toggleActive(account)}>{account.active ? "비활성화" : "재활성화"}</button>
                          <button type="button" disabled={busy} onClick={() => void revokeSessions(account)}>세션 모두 끊기</button>
                          <button type="button" disabled={busy} onClick={() => setLinking(account)}>{account.employeeId ? "연결 변경·해제" : "직원 연결"}</button>
                          <button type="button" disabled={busy} onClick={() => void rename(account)}>표시 이름 변경</button>
                          <button type="button" disabled={busy} onClick={() => void toggleAdmin(account)}>{account.isAdmin ? "관리자 해제" : "관리자 지정"}</button>
                        </div>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && data && (
        <CreateAccountDialog employees={data.employees} grantableTabs={grantableTabs} onClose={() => setCreating(false)}
          onCreated={(account, password) => { setCreating(false); setIssued({ account, password }); setMessage({ tone: "ok", text: "계정을 만들었습니다." }); void load(); }} />
      )}
      {linking && data && (
        <LinkEmployeeDialog account={linking} employees={data.employees} onClose={() => setLinking(null)}
          onSaved={(text) => { setLinking(null); setMessage({ tone: "ok", text }); void load(); }} />
      )}
      {issued && <TemporaryPasswordDialog account={issued.account} password={issued.password} onClose={() => setIssued(null)} />}
    </div>
  );
}
