"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

/** 브라우저 기본 alert / confirm / prompt 를 대신하는 앱 내부 대화상자.
 *
 *  왜 필요한가 (docs/hr-compensation-audit-2026-09-21.md UI 항목):
 *  - 브라우저 기본 창은 ERP 팝업 디자인과 어긋나고, 앱 내 브라우저 등 일부 환경에서는 prompt 가 아예 뜨지 않아
 *    사유 입력이 필요한 흐름(급여 재개, 채용요청 취소, 월차 제외)이 조용히 실패한다.
 *
 *  사용법:
 *  - 화면 트리 위쪽에 <ErpDialogProvider> 를 한 번 둔다 (HR 은 섀도 루트 포털 안, 임금계산은 모듈 루트).
 *  - 컴포넌트에서 `const dialog = useErpDialog();` 후 `if (!(await dialog.confirm("..."))) return;` 처럼 쓴다.
 *  - Provider 밖에서 호출되면 window.* 로 되돌아가므로 동작은 항상 보장된다.
 *
 *  스타일: public/hr-workspace.css (HR 섀도 트리) 와 app/globals.css (임금계산) 의 .erp-dialog-* 규칙.
 *  팝업 공식(28px 곡률, 헤더·본문·액션 3단, 배경 흐림)을 그대로 따른다. */

export type ErpDialogOptions = {
  /** 제목. 없으면 종류별 기본값(알림 / 확인 / 입력). */
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 삭제·되돌릴 수 없는 작업이면 확인 버튼을 주황색으로. */
  danger?: boolean;
};

export type ErpPromptOptions = ErpDialogOptions & {
  defaultValue?: string;
  placeholder?: string;
  /** 이 길이보다 짧으면 확인 버튼이 눌리지 않는다 (공백 제외). */
  minLength?: number;
  multiline?: boolean;
};

export type ErpDialogApi = {
  alert(message: string, options?: ErpDialogOptions): Promise<void>;
  confirm(message: string, options?: ErpDialogOptions): Promise<boolean>;
  /** 취소하면 null, 확인하면 입력값(앞뒤 공백 제거). */
  prompt(message: string, options?: ErpPromptOptions): Promise<string | null>;
};

type Pending =
  | { kind: "alert"; message: string; options: ErpDialogOptions; resolve: (value: void) => void }
  | { kind: "confirm"; message: string; options: ErpDialogOptions; resolve: (value: boolean) => void }
  | { kind: "prompt"; message: string; options: ErpPromptOptions; resolve: (value: string | null) => void };

const browserFallback: ErpDialogApi = {
  alert: async (message) => { window.alert(message); },
  confirm: async (message) => window.confirm(message),
  prompt: async (message, options) => {
    const value = window.prompt(message, options?.defaultValue ?? "");
    return value === null ? null : value.trim();
  },
};

const ErpDialogContext = createContext<ErpDialogApi>(browserFallback);

export function useErpDialog(): ErpDialogApi {
  return useContext(ErpDialogContext);
}

const DEFAULT_TITLES: Record<Pending["kind"], string> = { alert: "알림", confirm: "확인", prompt: "입력" };

export function ErpDialogProvider({ children }: { children: ReactNode }) {
  // 연달아 요청되면 순서대로 하나씩 띄운다. 먼저 뜬 창이 닫혀야 다음 창이 뜬다.
  const [queue, setQueue] = useState<Pending[]>([]);
  const enqueue = useCallback((item: Pending) => setQueue((current) => [...current, item]), []);
  const api = useMemo<ErpDialogApi>(() => ({
    alert: (message, options = {}) => new Promise<void>((resolve) => enqueue({ kind: "alert", message, options, resolve })),
    confirm: (message, options = {}) => new Promise<boolean>((resolve) => enqueue({ kind: "confirm", message, options, resolve })),
    prompt: (message, options = {}) => new Promise<string | null>((resolve) => enqueue({ kind: "prompt", message, options, resolve })),
  }), [enqueue]);
  const current = queue[0];
  const settle = useCallback((value: boolean | string | null | void) => {
    setQueue((items) => {
      const [head, ...rest] = items;
      if (head) (head.resolve as (value: unknown) => void)(value);
      return rest;
    });
  }, []);
  return <ErpDialogContext.Provider value={api}>
    {children}
    {current && <ErpDialogCard key={queue.length} pending={current} onSettle={settle} />}
  </ErpDialogContext.Provider>;
}

function ErpDialogCard({ pending, onSettle }: { pending: Pending; onSettle: (value: boolean | string | null | void) => void }) {
  const titleId = useId();
  // 열리면 입력칸(prompt) 또는 확인 버튼에 초점을 준다. 자동 초점 속성 대신 효과로 처리해 접근성 규칙(jsx-a11y/no-autofocus)을 지킨다.
  const focusRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>(null);
  useEffect(() => { focusRef.current?.focus(); }, []);
  const promptOptions = pending.kind === "prompt" ? pending.options : null;
  const [text, setText] = useState(promptOptions?.defaultValue ?? "");
  const minLength = promptOptions?.minLength ?? 0;
  const tooShort = pending.kind === "prompt" && text.trim().length < Math.max(minLength, 1);

  function cancel() {
    if (pending.kind === "alert") onSettle(undefined);
    else if (pending.kind === "confirm") onSettle(false);
    else onSettle(null);
  }
  function confirm() {
    if (pending.kind === "alert") onSettle(undefined);
    else if (pending.kind === "confirm") onSettle(true);
    else if (!tooShort) onSettle(text.trim());
  }

  // Esc 로 취소. 섀도 DOM 안에서도 키보드 이벤트는 document 까지 올라온다.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const title = pending.options.title ?? DEFAULT_TITLES[pending.kind];
  const danger = Boolean(pending.options.danger);
  return <div className="modal-backdrop erp-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
    <section className={`erp-dialog${danger ? " danger" : ""}`} role={pending.kind === "alert" ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby={titleId}>
      <header data-korean-heading className="erp-dialog-head"><h2 id={titleId}>{title}</h2></header>
      <div className="erp-dialog-body">
        <p>{pending.message}</p>
        {pending.kind === "prompt" && (promptOptions?.multiline
          ? <textarea ref={focusRef as RefObject<HTMLTextAreaElement>} rows={3} value={text} placeholder={promptOptions.placeholder} onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); confirm(); } }} />
          : <input ref={focusRef as RefObject<HTMLInputElement>} type="text" value={text} placeholder={promptOptions?.placeholder} onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); confirm(); } }} />)}
        {pending.kind === "prompt" && minLength > 1 && <span className="erp-dialog-hint">{minLength}자 이상 입력해 주세요{promptOptions?.multiline ? " · Ctrl+Enter 로 확인" : ""}</span>}
      </div>
      <div className="erp-dialog-actions">
        {pending.kind !== "alert" && <button type="button" onClick={cancel}>{pending.options.cancelLabel ?? "취소"}</button>}
        <button type="button" className="erp-dialog-primary" ref={pending.kind === "prompt" ? undefined : focusRef as RefObject<HTMLButtonElement>} disabled={tooShort} onClick={confirm}>{pending.options.confirmLabel ?? "확인"}</button>
      </div>
    </section>
  </div>;
}
