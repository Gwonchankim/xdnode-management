"use client";

// 클라이언트 세션 상태기계(Design §5.2, §6.3). page.tsx(SPA 셸)와 /incentive(RequireTab)가 함께 쓴다.
//   loading → bootstrap | login | password | ready
// 분기는 status 와 code 로만 한다(문구로 분기하지 않는다). 서버가 최종 방어이고, 여기서 무엇을 숨기든 보안 통제가 아니다.
// 서버 모듈(erp-platform·auth-*)은 import 하지 않는다. 탭 해석 결과는 /api/me 가 준 값을 그대로 쓴다.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ResolvedTabs } from "./access-tabs";
import { clearScopedDataKeys, setStorageScope } from "./client-runtime";

export const ME_REFRESH_INTERVAL_MS = 60_000;
export const NETWORK_ERROR_MESSAGE = "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.";
export const FORBIDDEN_MESSAGE = "이 작업을 수행할 권한이 없습니다.";

export type SessionUser = { accountId: string; email: string; name: string; employeeId: string; linkedEmployee: boolean };
export type SessionMe = { user: SessionUser; isAdmin: boolean; tabs: ResolvedTabs; mustChangePassword: boolean };

export type SessionState =
  | { status: "loading"; connectionError?: string }
  | { status: "bootstrap"; bootstrapAllowedHere: boolean }
  | { status: "login"; notice?: string }
  | { status: "password"; me: SessionMe; mode: "forced" | "voluntary" }
  | { status: "ready"; me: SessionMe };

export type ApiResult<T = Record<string, unknown>> = { ok: boolean; status: number; body: T & { error?: string; code?: string; field?: string; retryAfterSeconds?: number } };

/** 인증 화면·계정 관리가 쓰는 JSON 요청. 네트워크 오류는 status 0 으로 돌려준다(throw 하지 않는다). */
export async function requestJson<T = Record<string, unknown>>(url: string, method = "GET", body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({})) as ApiResult<T>["body"];
    return { ok: response.ok, status: response.status, body: parsed ?? ({} as ApiResult<T>["body"]) };
  } catch {
    return { ok: false, status: 0, body: { error: NETWORK_ERROR_MESSAGE } as ApiResult<T>["body"] };
  }
}

function apiPath(input: RequestInfo | URL): string | null {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

type ApiSignal = "UNAUTHENTICATED" | "PASSWORD_CHANGE_REQUIRED" | "FORBIDDEN";

/**
 * 탭 화면들은 fetch 를 직접 부른다. 그 응답 중 401 UNAUTHENTICATED, 403 PASSWORD_CHANGE_REQUIRED·FORBIDDEN 을
 * 보고 상태기계에 알린다(§6.3). /api/me 와 /api/auth/* 는 상태기계가 직접 처리하므로 보지 않는다.
 * 응답 본문은 clone 으로 읽어 원래 호출부의 읽기를 방해하지 않는다.
 */
function observeApiResponses(onSignal: (signal: ApiSignal) => void) {
  const original = window.fetch;
  const wrapped: typeof window.fetch = async (input, init) => {
    const response = await original(input, init);
    if (response.status === 401 || response.status === 403) {
      const path = apiPath(input);
      if (path && path.startsWith("/api/") && path !== "/api/me" && !path.startsWith("/api/auth/")) {
        response.clone().json().then((body: { code?: unknown }) => {
          if (response.status === 401 && body?.code === "UNAUTHENTICATED") onSignal("UNAUTHENTICATED");
          else if (response.status === 403 && body?.code === "PASSWORD_CHANGE_REQUIRED") onSignal("PASSWORD_CHANGE_REQUIRED");
          else if (response.status === 403 && body?.code === "FORBIDDEN") onSignal("FORBIDDEN");
        }).catch(() => undefined);
      }
    }
    return response;
  };
  window.fetch = wrapped;
  return () => { if (window.fetch === wrapped) window.fetch = original; };
}

export type SessionApi = {
  state: SessionState;
  /** GET /api/me 를 다시 부른다. */
  refresh: () => Promise<void>;
  /** POST /api/auth/logout. 급여성 데이터 키를 지우고 로그인 화면으로 간다. */
  logout: () => Promise<void>;
  openPasswordChange: () => void;
  closePasswordChange: () => void;
  /** 셸이 띄울 짧은 알림(FORBIDDEN, 비밀번호 변경 완료 등). */
  notice: string;
  showNotice: (message: string) => void;
};

export function useSession(): SessionApi {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const [notice, setNotice] = useState("");
  const stateRef = useRef(state);
  const inFlight = useRef<Promise<void> | null>(null);
  const noticeTimer = useRef<number | null>(null);

  const update = useCallback((next: SessionState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 3200);
  }, []);

  const toLogin = useCallback((message?: string) => {
    const previous = stateRef.current.status;
    // 세션이 끊기면(401) 급여성 데이터 키를 지운다(§5.5). 처음부터 로그인 전이던 경우에도 남은 레거시 키를 지운다.
    if (previous === "ready" || previous === "password") clearScopedDataKeys();
    setStorageScope(null);
    update({ status: "login", notice: message });
  }, [update]);

  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      const result = await requestJson<SessionMe & { bootstrapAllowedHere?: boolean }>("/api/me");
      const current = stateRef.current;
      if (result.status === 200 && result.body.user && result.body.tabs) {
        const me: SessionMe = {
          user: result.body.user, isAdmin: result.body.isAdmin === true, tabs: result.body.tabs, mustChangePassword: result.body.mustChangePassword === true,
        };
        // ready 로 가기 전에 저장소 범위를 먼저 정한다. 탭 화면이 마운트되며 곧바로 scopedKey 를 읽는다.
        setStorageScope(me.user.accountId);
        if (me.mustChangePassword) update({ status: "password", me, mode: "forced" });
        else if (current.status === "password" && current.mode === "voluntary") update({ status: "password", me, mode: "voluntary" });
        else update({ status: "ready", me });
        return;
      }
      if (result.status === 401 && result.body.code === "BOOTSTRAP_REQUIRED") {
        setStorageScope(null);
        update({ status: "bootstrap", bootstrapAllowedHere: result.body.bootstrapAllowedHere === true });
        return;
      }
      if (result.status === 401) { toLogin(); return; }
      // 네트워크 오류·5xx·403 CROSS_ORIGIN: 이미 들어와 있으면 화면을 유지하고, 처음 확인 중이면 재시도 안내를 띄운다.
      if (current.status === "loading") update({ status: "loading", connectionError: result.body.error || NETWORK_ERROR_MESSAGE });
    })().finally(() => { inFlight.current = null; });
    inFlight.current = run;
    return run;
  }, [toLogin, update]);

  const logout = useCallback(async () => {
    await requestJson("/api/auth/logout", "POST", {});
    clearScopedDataKeys();
    setStorageScope(null);
    update({ status: "login" });
  }, [update]);

  const openPasswordChange = useCallback(() => {
    const current = stateRef.current;
    if (current.status === "ready") update({ status: "password", me: current.me, mode: "voluntary" });
  }, [update]);

  const closePasswordChange = useCallback(() => {
    const current = stateRef.current;
    if (current.status === "password" && current.mode === "voluntary") update({ status: "ready", me: current.me });
  }, [update]);

  // 첫 확인 + 60초마다 + focus·visibilitychange 때 다시 부른다(§4.2.1).
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, ME_REFRESH_INTERVAL_MS);
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  // 탭 화면의 API 응답으로 오는 401·403 분기(§6.3).
  useEffect(() => observeApiResponses((signal) => {
    const current = stateRef.current;
    if (signal === "UNAUTHENTICATED") { if (current.status === "ready" || current.status === "password") toLogin("로그인이 끊겼습니다. 다시 로그인해 주세요."); return; }
    if (signal === "PASSWORD_CHANGE_REQUIRED") {
      if (current.status === "ready" || current.status === "password") update({ status: "password", me: current.me, mode: "forced" });
      return;
    }
    // FORBIDDEN: 화면은 유지하고 알린 뒤 권한을 다시 읽는다. 권한이 줄었으면 셸이 첫 허용 탭으로 옮긴다.
    showNotice(FORBIDDEN_MESSAGE);
    void refresh();
  }), [refresh, showNotice, toLogin, update]);

  useEffect(() => () => { if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current); }, []);

  return { state, refresh, logout, openPasswordChange, closePasswordChange, notice, showNotice };
}
