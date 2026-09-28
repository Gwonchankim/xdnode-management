"use client";

import { type HTMLAttributes, useEffect, useId, useRef, useSyncExternalStore } from "react";

const subscribeClient = () => () => {};
export function useClientReady() {
  return useSyncExternalStore(subscribeClient, () => true, () => false);
}

const koreanToday = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const subscribeDate = (notify: () => void) => {
  const timer = window.setInterval(notify, 60_000);
  window.addEventListener("focus", notify);
  return () => { window.clearInterval(timer); window.removeEventListener("focus", notify); };
};
export function useKoreanToday() {
  return useSyncExternalStore(subscribeDate, koreanToday, () => "");
}

export function InterviewAudio({ src, transcript, label }: { src: string; transcript: string; label: string }) {
  const transcriptId = useId();
  return <div className="interview-audio">
    {/* Audio-only recordings use the adjacent readable transcript as their text alternative.
        Do not invent synchronized caption timestamps for manually entered interview notes. */}
    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
    <audio controls src={src} aria-label={label} aria-describedby={transcriptId} />
    <details id={transcriptId}><summary>녹음 전사문</summary><p>{transcript || "전사문이 아직 없습니다. 직접 입력하거나 서버 AI 전사 후 원문을 검토해 주세요."}</p></details>
  </div>;
}

// Keep the existing backdrop layout while giving every HR popup the same keyboard behavior.
export function HrModalBackdrop({ children, onMouseDown, ...props }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const modal = ref.current;
    if (!modal) return;
    const root = modal.getRootNode() as Document | ShadowRoot;
    const previous = root.activeElement as HTMLElement | null;
    const title = modal.querySelector("h2, h1");
    if (!modal.hasAttribute("aria-label") && title?.textContent) modal.setAttribute("aria-label", title.textContent);
    modal.querySelectorAll<HTMLButtonElement>("button").forEach(button => {
      if (button.textContent?.trim() === "×" && !button.hasAttribute("aria-label")) button.setAttribute("aria-label", "닫기");
    });
    const first = modal.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled)');
    (first ?? modal).focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  // A dialog container handles Escape/Tab for its children; it is not a button.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
  return <div {...props} ref={ref} role="dialog" aria-modal="true" tabIndex={-1}
    onMouseDown={event => { if (event.target === event.currentTarget) onMouseDown?.(event); }}
    onKeyDown={event => {
      if (event.key === "Escape") {
        event.stopPropagation();
        // Use the same close button as the pointer path, including unsaved-change checks.
        const close = ref.current?.querySelector<HTMLButtonElement>('.modal-header button, button[aria-label="닫기"]')
          ?? ref.current?.querySelector<HTMLButtonElement>('button[type="button"]');
        close?.click();
      }
      if (event.key !== "Tab") return;
      event.stopPropagation();
      const modal = event.currentTarget;
      const focusable = Array.from(modal.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled, [type="hidden"]') && element.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      const active = (modal.getRootNode() as Document | ShadowRoot).activeElement;
      if (!first) { event.preventDefault(); modal.focus(); }
      else if (event.shiftKey && (active === first || active === modal)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (active === last || active === modal)) { event.preventDefault(); first.focus(); }
    }}>{children}</div>;
}
