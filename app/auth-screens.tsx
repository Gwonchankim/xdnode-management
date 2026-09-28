"use client";

// 인증 화면 4종과 탭 게이트(Design §5.1·§5.2·§5.4, D25). 텍스트는 React 텍스트 노드로만 그린다(innerHTML 없음).
// 오류 분기는 status·code 로만 한다(§6.3). 문구는 서버가 준 error 를 그대로 보여 주거나, code 별 고정 문구를 쓴다.

import { FormEvent, useEffect, useState, type InputHTMLAttributes, type ReactNode } from "react";
import Link from "next/link";
import type { TabKey } from "./access-tabs";
import { secureContextAvailable } from "./client-runtime";
import { NETWORK_ERROR_MESSAGE, requestJson, useSession, type SessionApi } from "./session-client";

const PASSWORD_RULE = "8자 이상 200자 이하, 현재 비밀번호와 달라야 합니다.";
const LOCAL_ONLY_MESSAGE = "첫 관리자 계정은 서버 PC의 http://localhost:3000 에서만 만들 수 있습니다.";
const PASSWORD_CHANGED_MESSAGE = "비밀번호를 바꿨습니다. 다른 기기의 로그인은 모두 끊겼습니다.";
const INSECURE_NOTICE = "이 주소는 암호화되지 않은 사내 전용 연결입니다. 사무실 네트워크에서만 로그인해 주세요.";

/** "n분 n초 뒤 다시 시도할 수 있습니다". 0 이하이면 빈 문자열. */
export function lockCountdownText(seconds: number) {
  if (seconds <= 0) return "";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes > 0 ? `${minutes}분 ` : ""}${rest}초 뒤 다시 시도할 수 있습니다`;
}

/** 429 LOCKED 의 retryAfterSeconds 를 1초씩 줄이는 카운트다운. */
function useCountdown() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => setSeconds((value) => Math.max(value - 1, 0)), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);
  return [seconds, setSeconds] as const;
}

function BrandHeader({ withLogo }: { withLogo: boolean }) {
  return (
    <div className="auth-brand">
      {withLogo && (
        // eslint-disable-next-line @next/next/no-img-element -- 정적 로고. /_vinext/image 최적화가 필요 없다.
        <img className="auth-logo" src="/brand/xdnode-logo.png" alt="XDNODE" width={1200} height={277} />
      )}
      <strong>XDnode management</strong>
    </div>
  );
}

function AuthFrame({ gate, children, withLogo = true }: { gate: string; children: ReactNode; withLogo?: boolean }) {
  return (
    <main className="auth-screen" data-auth-gate={gate}>
      <BrandHeader withLogo={withLogo} />
      {children}
    </main>
  );
}

/** SSR 과 첫 렌더에 그리는 껍데기. 브랜드만 있고 탭·HR 데이터는 없다. D1 을 읽지 않는다. */
export function AuthLoadingShell({ connectionError, onRetry }: { connectionError?: string; onRetry?: () => void }) {
  return (
    <AuthFrame gate="loading">
      <div className="auth-loading" role="status" aria-live="polite">
        {connectionError ? (
          <>
            <p role="alert">{connectionError}</p>
            {onRetry && <button type="button" className="primary-button" onClick={onRetry}>다시 시도</button>}
          </>
        ) : <span className="auth-loading-dot" aria-label="확인 중" />}
      </div>
    </AuthFrame>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <small className="auth-field-error" id={id}>{message}</small> : null;
}

export function LoginScreen({ notice, onLoggedIn }: { notice?: string; onLoggedIn: () => void | Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lockSeconds, setLockSeconds] = useCountdown();
  const [insecure, setInsecure] = useState(false);
  useEffect(() => {
    // 보안 컨텍스트 여부는 브라우저에서만 안다. 서버 렌더와 맞추려고 마운트 뒤에 읽는다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInsecure(!secureContextAvailable());
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || lockSeconds > 0) return;
    const trimmed = email.trim();
    setEmail(trimmed);
    setError("");
    setBusy(true);
    const result = await requestJson<{ mustChangePassword?: boolean }>("/api/auth/login", "POST", { email: trimmed, password });
    setBusy(false);
    if (result.ok) { setPassword(""); await onLoggedIn(); return; }
    if (result.status === 429 && result.body.code === "LOCKED") {
      setLockSeconds(Math.max(Number(result.body.retryAfterSeconds) || 0, 1));
      setError(result.body.error || "로그인에 5번 실패해 5분 동안 잠겼습니다. 잠시 후 다시 시도해 주세요.");
      return;
    }
    if (result.status === 401 && result.body.code === "INVALID_CREDENTIALS") { setError("이메일 또는 비밀번호가 올바르지 않습니다."); return; }
    setError(result.body.error || NETWORK_ERROR_MESSAGE);
  }

  const locked = lockSeconds > 0;
  return (
    <AuthFrame gate="login">
      <section className="panel auth-card" aria-labelledby="auth-login-title">
        <h1 id="auth-login-title">로그인</h1>
        {notice && <p className="auth-notice" role="status">{notice}</p>}
        <form onSubmit={submit} noValidate>
          <label>
            <span>이메일</span>
            <input type="email" name="email" autoComplete="username" required value={email}
              onChange={(event) => setEmail(event.target.value)} onBlur={() => setEmail((value) => value.trim())} />
          </label>
          <label>
            <span>비밀번호</span>
            <input type="password" name="password" autoComplete="current-password" required value={password}
              onChange={(event) => setPassword(event.target.value)} />
          </label>
          <p className="auth-error" role="alert">{error}{locked ? ` ${lockCountdownText(lockSeconds)}` : ""}</p>
          <button type="submit" className="primary-button" disabled={busy || locked || !email.trim() || !password}>
            {busy ? "확인 중…" : "로그인"}
          </button>
        </form>
        <p className="auth-hint">비밀번호를 잊었으면 관리자에게 초기화를 요청해 주세요.</p>
        {insecure && <p className="auth-hint">{INSECURE_NOTICE}</p>}
      </section>
    </AuthFrame>
  );
}

type BootstrapField = "email" | "displayName" | "password" | "confirm" | "employeeId";

export function BootstrapScreen({ allowedHere, onCreated, onClosed, onRecheck }: {
  allowedHere: boolean;
  onCreated: () => void | Promise<void>;
  onClosed: () => void;
  onRecheck?: () => void;
}) {
  const [form, setForm] = useState({ email: "", displayName: "", password: "", confirm: "", employeeId: "" });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<BootstrapField, string>>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!allowedHere) {
    return (
      <AuthFrame gate="bootstrap">
        <section className="panel auth-card" aria-labelledby="auth-bootstrap-title">
          <h1 id="auth-bootstrap-title">첫 관리자 만들기</h1>
          <p className="auth-notice" role="status">{LOCAL_ONLY_MESSAGE}</p>
          {onRecheck && <button type="button" className="secondary-button" onClick={onRecheck}>다시 확인</button>}
        </section>
      </AuthFrame>
    );
  }

  function set<K extends BootstrapField>(key: K, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
  }

  function validate() {
    const errors: Partial<Record<BootstrapField, string>> = {};
    const email = form.email.trim();
    const name = form.displayName.trim();
    const employeeId = form.employeeId.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) errors.email = "이메일 형식을 확인해 주세요.";
    if (name.length > 60 || (!name && !employeeId)) errors.displayName = "이름은 1자 이상 60자 이하로 입력해 주세요.";
    if (form.password.length < 8 || form.password.length > 200) errors.password = "비밀번호는 8자 이상 200자 이하로 입력해 주세요.";
    if (form.password !== form.confirm) errors.confirm = "비밀번호 확인이 일치하지 않습니다.";
    if (employeeId.startsWith("acct_")) errors.employeeId = "인사기록 직원 ID를 입력해 주세요. acct_ 로 시작하는 값은 쓸 수 없습니다.";
    return errors;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const errors = validate();
    setFieldErrors(errors);
    setError("");
    if (Object.keys(errors).length) return;
    setBusy(true);
    const employeeId = form.employeeId.trim();
    const result = await requestJson("/api/auth/bootstrap", "POST", {
      email: form.email.trim(), displayName: form.displayName.trim(), password: form.password, ...(employeeId ? { employeeId } : {}),
    });
    setBusy(false);
    if (result.status === 201) { setForm((current) => ({ ...current, password: "", confirm: "" })); await onCreated(); return; }
    if (result.status === 409 && result.body.code === "BOOTSTRAP_CLOSED") { onClosed(); return; }
    if (result.status === 400 && result.body.code === "VALIDATION") {
      const field = result.body.field as BootstrapField | undefined;
      if (field && ["email", "displayName", "password", "employeeId"].includes(field)) {
        setFieldErrors({ [field]: result.body.error });
        return;
      }
    }
    if (result.status === 403 && result.body.code === "BOOTSTRAP_LOCAL_ONLY") { setError(LOCAL_ONLY_MESSAGE); return; }
    setError(result.body.error || NETWORK_ERROR_MESSAGE);
  }

  const input = (key: BootstrapField, label: string, props: InputHTMLAttributes<HTMLInputElement>) => (
    <label>
      <span>{label}</span>
      <input name={key} value={form[key]} onChange={(event) => set(key, event.target.value)}
        aria-invalid={fieldErrors[key] ? true : undefined} aria-describedby={fieldErrors[key] ? `bootstrap-${key}-error` : undefined} {...props} />
      <FieldError id={`bootstrap-${key}-error`} message={fieldErrors[key]} />
    </label>
  );

  return (
    <AuthFrame gate="bootstrap">
      <section className="panel auth-card" aria-labelledby="auth-bootstrap-title">
        <h1 id="auth-bootstrap-title">첫 관리자 만들기</h1>
        <p className="auth-hint">계정이 아직 없습니다. 이 서버 PC에서 관리자 계정 하나를 만들면 이 화면은 닫힙니다.</p>
        <form onSubmit={submit} noValidate>
          {input("email", "이메일", { type: "email", autoComplete: "username", required: true, maxLength: 200 })}
          {input("displayName", "표시 이름", { type: "text", autoComplete: "name", maxLength: 60 })}
          {input("password", "비밀번호", { type: "password", autoComplete: "new-password", required: true, maxLength: 200 })}
          {input("confirm", "비밀번호 확인", { type: "password", autoComplete: "new-password", required: true, maxLength: 200 })}
          {input("employeeId", "인사기록 직원 ID (선택)", { type: "text", autoComplete: "off", placeholder: "예: hong.gildong", maxLength: 80 })}
          <p className="auth-hint">비밀번호는 8자 이상 200자 이하입니다. 직원 ID를 넣고 표시 이름을 비우면 인사기록의 이름을 씁니다.</p>
          <p className="auth-error" role="alert">{error}</p>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? "만드는 중…" : "첫 관리자 만들기"}</button>
        </form>
      </section>
    </AuthFrame>
  );
}

type PasswordField = "currentPassword" | "newPassword" | "confirm";

export function PasswordChangeScreen({ mode, onDone, onCancel, onLogout, onUnauthenticated }: {
  mode: "forced" | "voluntary";
  onDone: (message: string) => void | Promise<void>;
  onCancel?: () => void;
  onLogout: () => void;
  onUnauthenticated: () => void;
}) {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<PasswordField, string>>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lockSeconds, setLockSeconds] = useCountdown();

  function set(key: PasswordField, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || lockSeconds > 0) return;
    const errors: Partial<Record<PasswordField, string>> = {};
    if (!form.currentPassword) errors.currentPassword = "현재 비밀번호를 입력해 주세요.";
    if (form.newPassword.length < 8 || form.newPassword.length > 200) errors.newPassword = "비밀번호는 8자 이상 200자 이하로 입력해 주세요.";
    else if (form.newPassword === form.currentPassword) errors.newPassword = "새 비밀번호는 현재 비밀번호와 달라야 합니다.";
    if (form.newPassword !== form.confirm) errors.confirm = "새 비밀번호 확인이 일치하지 않습니다.";
    setFieldErrors(errors);
    setError("");
    if (Object.keys(errors).length) return;
    setBusy(true);
    const result = await requestJson("/api/auth/password", "PUT", { currentPassword: form.currentPassword, newPassword: form.newPassword });
    setBusy(false);
    if (result.ok) { setForm({ currentPassword: "", newPassword: "", confirm: "" }); await onDone(PASSWORD_CHANGED_MESSAGE); return; }
    // 401 INVALID_CREDENTIALS 는 폼 오류다. 세션은 유지된다. 로그인 화면으로 보내는 것은 UNAUTHENTICATED 뿐이다.
    if (result.status === 401 && result.body.code === "INVALID_CREDENTIALS") { setFieldErrors({ currentPassword: "현재 비밀번호가 올바르지 않습니다." }); return; }
    if (result.status === 401 && result.body.code === "UNAUTHENTICATED") { onUnauthenticated(); return; }
    if (result.status === 429 && result.body.code === "LOCKED") {
      setLockSeconds(Math.max(Number(result.body.retryAfterSeconds) || 0, 1));
      setError(result.body.error || "로그인에 5번 실패해 5분 동안 잠겼습니다. 잠시 후 다시 시도해 주세요.");
      return;
    }
    if (result.status === 400 && result.body.code === "VALIDATION") {
      const field = result.body.field as PasswordField | undefined;
      if (field === "currentPassword" || field === "newPassword") { setFieldErrors({ [field]: result.body.error }); return; }
    }
    setError(result.body.error || NETWORK_ERROR_MESSAGE);
  }

  const input = (key: PasswordField, label: string, autoComplete: string) => (
    <label>
      <span>{label}</span>
      <input type="password" name={key} autoComplete={autoComplete} required maxLength={200} value={form[key]}
        onChange={(event) => set(key, event.target.value)}
        aria-invalid={fieldErrors[key] ? true : undefined} aria-describedby={fieldErrors[key] ? `password-${key}-error` : undefined} />
      <FieldError id={`password-${key}-error`} message={fieldErrors[key]} />
    </label>
  );

  const locked = lockSeconds > 0;
  return (
    <AuthFrame gate="password" withLogo={false}>
      <section className="panel auth-card" aria-labelledby="auth-password-title">
        <h1 id="auth-password-title">비밀번호 변경</h1>
        {mode === "forced" && <p className="auth-notice" role="status">처음 로그인했거나 관리자가 비밀번호를 초기화했습니다. 계속하려면 새 비밀번호를 정해 주세요.</p>}
        <form onSubmit={submit} noValidate>
          {input("currentPassword", "현재 비밀번호", "current-password")}
          {input("newPassword", "새 비밀번호", "new-password")}
          {input("confirm", "새 비밀번호 확인", "new-password")}
          <p className="auth-hint">{PASSWORD_RULE}</p>
          <p className="auth-error" role="alert">{error}{locked ? ` ${lockCountdownText(lockSeconds)}` : ""}</p>
          <div className="auth-actions">
            {mode === "voluntary" && onCancel && <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>취소</button>}
            <button type="submit" className="primary-button" disabled={busy || locked}>{busy ? "바꾸는 중…" : "비밀번호 바꾸기"}</button>
          </div>
        </form>
        {mode === "forced" && <button type="button" className="auth-link-button" onClick={onLogout}>로그아웃</button>}
      </section>
    </AuthFrame>
  );
}

/** 셸 수준 알림(FORBIDDEN, 비밀번호 변경 완료 등). */
export function SessionNotice({ message }: { message: string }) {
  return message ? <div className="toast session-toast" role="status" aria-live="polite"><span aria-hidden="true">●</span>{message}</div> : null;
}

/**
 * ready 가 아닌 상태의 화면을 고른다. page.tsx 와 RequireTab 이 함께 쓴다.
 * ready 이면 null 을 돌려주고, 호출부가 탭 화면을 그린다.
 */
export function SessionGate({ session }: { session: SessionApi }) {
  const { state, refresh, logout, closePasswordChange, showNotice } = session;
  switch (state.status) {
    case "loading":
      return <AuthLoadingShell connectionError={state.connectionError} onRetry={() => { void refresh(); }} />;
    case "bootstrap":
      return <BootstrapScreen allowedHere={state.bootstrapAllowedHere} onCreated={refresh} onRecheck={() => void refresh()}
        onClosed={() => { void refresh(); }} />;
    case "login":
      return <LoginScreen notice={state.notice} onLoggedIn={refresh} />;
    case "password":
      return <PasswordChangeScreen mode={state.mode}
        onDone={async (message) => { showNotice(message); await refresh(); closePasswordChange(); }}
        onCancel={closePasswordChange} onLogout={() => void logout()} onUnauthenticated={() => void refresh()} />;
    default:
      return null;
  }
}

/**
 * 탭 게이트(/incentive). 같은 useSession() 을 쓰고, 탭이 none 이면 자식(계산기)을 렌더하지 않는다.
 * 서버 쪽은 계산기가 부르는 /api/compensation/roster 가 403 으로 막는다.
 */
export function RequireTab({ tab, children }: { tab: TabKey; children: ReactNode }) {
  const session = useSession();
  if (session.state.status !== "ready") {
    return <><SessionGate session={session} /><SessionNotice message={session.notice} /></>;
  }
  if ((session.state.me.tabs[tab] ?? "none") === "none") {
    return (
      <main className="auth-screen" data-auth-gate="forbidden">
        <BrandHeader withLogo />
        <section className="panel auth-card">
          <h1>접근 권한 없음</h1>
          <p className="auth-notice" role="status">이 화면을 볼 권한이 없습니다.</p>
          <Link className="secondary-button auth-home-link" href="/">처음 화면으로</Link>
        </section>
      </main>
    );
  }
  return <>{children}<SessionNotice message={session.notice} /></>;
}
