"use client";

// messenger-enhancement ME-FR-02 셸 토스트(Design §5.4 셸). 모든 탭 위에 뜬다. 본문은 React 텍스트 노드로만 그린다.

import type { ChatToast } from "./chat-notify";

export default function ChatToasts({ toasts, onOpen, onDismiss }: {
  toasts: ChatToast[]; onOpen: (toast: ChatToast) => void; onDismiss: (key: string) => void;
}) {
  if (!toasts.length) return null;
  return (
    <div className="chat-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.key} className="chat-toast">
          <button type="button" className="chat-toast-open" onClick={() => onOpen(toast)}>
            <span className="chat-toast-head"><strong>{toast.author}</strong><small>{toast.place}</small></span>
            {toast.preview && <span className="chat-toast-body">{toast.preview}</span>}
          </button>
          <button type="button" className="chat-toast-close" aria-label="알림 닫기" onClick={() => onDismiss(toast.key)}>×</button>
        </div>
      ))}
    </div>
  );
}
