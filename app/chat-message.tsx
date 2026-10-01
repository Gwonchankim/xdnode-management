"use client";

// 메신저 메시지 한 건(R5 MessageItem 을 chat-workspace.tsx 에서 옮겼다, messenger-enhancement Design §5.3·§11.1).
// 본문·파일 이름·표시 이름은 React 텍스트 노드로만 그린다(R5 §7.8). 링크는 http:·https: 만 만든다.
// M3: 반응 바·반응 고르기(ME-FR-07), 읽음 숫자(ME-FR-08, 숫자만·ME-MD3), 접속 점(ME-FR-09).
// M4: 고정 표시·고정/해제(ME-FR-10, 소유자·관리자만), 저장(ME-FR-11, 나만 보인다).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { highlightMentions } from "./chat-mentions";
import { CHAT_MESSAGE_MAX_LENGTH, CHAT_REACTIONS, presenceLabel, type ChatAttachmentDto, type ChatMessageDto, type ChatPerson } from "./chat-client";

const timeFormat = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
export function when(ms: number) {
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dateTimeFormat.format(date);
}
export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** http:·https: 링크만 a 로 바꾼다. 나머지는 텍스트 노드. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
  return <>{parts.map((part, index) => {
    if (index % 2 === 1) {
      try {
        const url = new URL(part);
        if (url.protocol === "http:" || url.protocol === "https:") {
          return <a key={index} href={url.href} target="_blank" rel="noopener noreferrer">{part}</a>;
        }
      } catch { /* 링크가 아니면 텍스트로 둔다 */ }
    }
    return <span key={index}>{part}</span>;
  })}</>;
}

function MessageBody({ body, people }: { body: string; people: ChatPerson[] }) {
  const pieces = useMemo(() => highlightMentions(body, people), [body, people]);
  return <>{pieces.map((piece, index) => piece.mention
    ? <mark key={index} className="chat-mention">{piece.text}</mark>
    : <Linkified key={index} text={piece.text} />)}</>;
}

function Attachments({ attachments }: { attachments: ChatAttachmentDto[] }) {
  if (!attachments.length) return null;
  return (
    <div className="chat-attachments">
      {attachments.map((attachment) => attachment.isImage
        ? (
          <a key={attachment.id} className="chat-attachment-image" href={attachment.url} target="_blank" rel="noopener noreferrer" title={attachment.fileName}>
            {/* eslint-disable-next-line @next/next/no-img-element -- 인증 쿠키가 필요한 첨부. 이미지 최적화 경로를 타지 않는다. */}
            <img src={attachment.url} alt={attachment.fileName} loading="lazy" />
          </a>
        )
        : (
          <a key={attachment.id} className="chat-attachment-file" href={attachment.url} rel="noopener noreferrer" download={attachment.fileName}>
            <span aria-hidden="true">▤</span>
            <span className="chat-attachment-name">{attachment.fileName}</span>
            <small>{fileSize(attachment.size)}</small>
          </a>
        ))}
    </div>
  );
}

/** ME-FR-09 접속 점. 온라인은 초록 점, 아니면 빈 점과 짧은 표기("5분"). title 에 긴 표기. */
export function PresenceDot({ lastSeen, self = false, withText = true }: { lastSeen: number | undefined; self?: boolean; withText?: boolean }) {
  const label = self ? { online: true, short: "", long: "온라인" } : presenceLabel(lastSeen);
  if (!label.online && !label.long) return null;
  return (
    <span className={label.online ? "chat-presence online" : "chat-presence"} title={label.long} aria-label={label.long}>
      <span className="chat-presence-dot" aria-hidden="true" />
      {withText && label.short && <small aria-hidden="true">{label.short}</small>}
    </span>
  );
}

/** ME-FR-07 반응 바: 반응마다 칩(누른 사람은 title), 내가 누른 칩은 강조. 쓸 수 있으면 ☺+ 로 8개 가운데 고른다. */
function ReactionBar({ message, accountId, people, canReact, onReact }: {
  message: ChatMessageDto; accountId: string; people: ChatPerson[]; canReact: boolean; onReact: (emoji: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const nameOf = (id: string) => people.find((person) => person.accountId === id)?.name ?? "알 수 없는 사용자";
  useEffect(() => {
    if (!picking) return;
    pickerRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: MouseEvent) => { if (!pickerRef.current?.contains(event.target as Node)) setPicking(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [picking]);
  if (!message.reactions.length && !canReact) return null;

  function onPickerKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { setPicking(false); return; }
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = [...(pickerRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
    next?.focus();
    event.preventDefault();
  }

  return (
    <div className="chat-reactions">
      {message.reactions.map((reaction) => {
        const mineToo = reaction.accountIds.includes(accountId);
        const names = reaction.accountIds.map(nameOf).join(", ");
        return (
          <button type="button" key={reaction.emoji} className={mineToo ? "chat-reaction mine" : "chat-reaction"} aria-pressed={mineToo}
            title={names} aria-label={`${reaction.emoji} ${reaction.accountIds.length}명: ${names}`} disabled={!canReact} onClick={() => onReact(reaction.emoji)}>
            <span aria-hidden="true">{reaction.emoji}</span><small>{reaction.accountIds.length}</small>
          </button>
        );
      })}
      {canReact && (
        <span className="chat-reaction-add">
          <button type="button" className="chat-reaction ghost" aria-label="반응 추가" aria-expanded={picking} onClick={() => setPicking((open) => !open)}>☺+</button>
          {picking && (
            <div className="chat-reaction-picker" ref={pickerRef} role="toolbar" aria-label="반응 고르기" onKeyDown={onPickerKey}>
              {CHAT_REACTIONS.map((emoji) => (
                <button type="button" key={emoji} aria-label={`${emoji} 반응`} onClick={() => { setPicking(false); onReact(emoji); }}>{emoji}</button>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  );
}

export function MessageItem({
  message, people, mine, canWrite, archived, focused = false, accountId = "", canReact = false, unreadCount = null, onReact,
  canPin = false, onPin, bookmarked = false, onBookmark, onReply, onEdit, onDelete,
}: {
  message: ChatMessageDto; people: ChatPerson[]; mine: boolean; canWrite: boolean; archived: boolean;
  /** ME-FR-01 이동 대상이면 잠시 강조한다. */
  focused?: boolean;
  /** ME-FR-07 반응: 보는 사람(내가 눌렀는지)과 누를 수 있는지(chat=edit·멤버·보관 아님). */
  accountId?: string; canReact?: boolean; onReact?: (emoji: string) => void;
  /** ME-FR-08 안 읽은 사람 수. null 이거나 0 이면 그리지 않는다. */
  unreadCount?: number | null;
  /** ME-FR-10 고정/해제를 보여 줄지(소유자·관리자, 최상위 글). 표시(📌)는 누구에게나 보인다. */
  canPin?: boolean; onPin?: (pin: boolean) => void;
  /** ME-FR-11 내 저장 여부. */
  bookmarked?: boolean; onBookmark?: (save: boolean) => void;
  onReply?: () => void; onEdit: (body: string) => Promise<boolean>; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editable = mine && canWrite && !archived && !message.deleted;
  return (
    <article className={["chat-message", mine ? "mine" : "theirs", message.deleted ? "deleted" : "", focused ? "focus" : ""].filter(Boolean).join(" ")} data-message-id={message.id}>
      <header>
        {!mine && <strong>{message.author.name}</strong>}
        <time dateTime={new Date(message.createdAt).toISOString()}>{when(message.createdAt)}</time>
        {message.pinnedAt !== null && !message.deleted && <span className="chat-pinned-mark" title="고정된 메시지">📌 고정됨</span>}
        {message.editedAt && !message.deleted && <em>(수정됨)</em>}
      </header>
      <div className={editing ? "chat-bubble editing" : "chat-bubble"}>
      {message.deleted
        ? <p className="chat-message-body muted">삭제된 메시지입니다.</p>
        : editing
          ? (
            <div className="chat-edit">
              <textarea value={draft} maxLength={CHAT_MESSAGE_MAX_LENGTH} rows={3} onChange={(event) => setDraft(event.target.value)} aria-label="메시지 수정" />
              <div>
                <button type="button" className="primary-button" disabled={!draft.trim() && !message.attachments.length}
                  onClick={async () => { if (await onEdit(draft)) setEditing(false); }}>저장</button>
                <button type="button" onClick={() => setEditing(false)}>취소</button>
              </div>
            </div>
          )
          : message.body ? <p className="chat-message-body"><MessageBody body={message.body} people={people} /></p> : null}
      {!message.deleted && <Attachments attachments={message.attachments} />}
      </div>
      {/* ME-FR-08 Design §5.1: 말풍선 바로 아래 바깥쪽(내 글은 오른쪽, 남의 글은 왼쪽 — article 의 정렬을 따른다). */}
      {unreadCount ? <span className="chat-read-count" title={`안 읽은 사람 ${unreadCount}명`} aria-label={`안 읽은 사람 ${unreadCount}명`}>{unreadCount}</span> : null}
      {!message.deleted && onReact && (
        <ReactionBar message={message} accountId={accountId} people={people} canReact={canReact && !archived} onReact={onReact} />
      )}
      <footer>
        {onReply && message.threadRootId === null && !message.deleted && (
          <button type="button" className="chat-link-button" onClick={onReply}>{message.replyCount > 0 ? `답글 ${message.replyCount}개` : "답글"}</button>
        )}
        {onReply && message.threadRootId === null && message.deleted && message.replyCount > 0 && (
          <button type="button" className="chat-link-button" onClick={onReply}>답글 {message.replyCount}개</button>
        )}
        {onBookmark && !message.deleted && (
          <button type="button" className={bookmarked ? "chat-link-button saved" : "chat-link-button"} aria-pressed={bookmarked} onClick={() => onBookmark(!bookmarked)}>
            {bookmarked ? "★ 저장됨" : "☆ 저장"}
          </button>
        )}
        {canPin && onPin && !message.deleted && message.threadRootId === null && (
          <button type="button" className="chat-link-button" onClick={() => onPin(message.pinnedAt === null)}>{message.pinnedAt === null ? "고정" : "고정 해제"}</button>
        )}
        {editable && !editing && <>
          <button type="button" className="chat-link-button" onClick={() => { setDraft(message.body ?? ""); setEditing(true); }}>수정</button>
          <button type="button" className="chat-link-button danger" onClick={onDelete}>삭제</button>
        </>}
      </footer>
    </article>
  );
}
