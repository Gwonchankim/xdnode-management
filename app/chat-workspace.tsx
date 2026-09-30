"use client";

// 메신저 탭(R5, Design §5.4 메신저 탭 체크리스트, FR-12~FR-15). 채널·DM 목록, 대화, 스레드, 검색, 첨부.
// 본문·채널 이름·파일 이름·표시 이름은 React 텍스트 노드로만 그린다(§7.8). 링크는 http:·https: 만 만든다.
// 실시간 갱신은 셸의 useChatPoll 이벤트를 구독한다. 권한 판정은 서버가 다시 한다(여기서 숨기는 것은 편의일 뿐이다).

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { applyMention, highlightMentions, mentionQueryAt, mentionSuggestions } from "./chat-mentions";
import { useErpDialog } from "./erp-dialog";
import { randomId, readScoped, writeScoped } from "./client-runtime";
import {
  CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENTS_PER_MESSAGE, CHAT_GROUP_DM_MAX_OTHERS, CHAT_MESSAGE_MAX_LENGTH, CHAT_SEARCH_MAX, CHAT_SEARCH_MIN,
  chatRequest, fileExtensionAllowed, pastedImageFile, uploadChatAttachment,
  type ChatAttachmentDto, type ChatChannelDto, type ChatChannelsResponse, type ChatMessageDto, type ChatPerson, type ChatPoll, type ChatPollEvent,
  type UnreadSummary,
} from "./chat-client";

type Props = { accountId: string; poll: ChatPoll };
type History = { messages: ChatMessageDto[]; hasMore: boolean; loading: boolean };
type Thread = { root: ChatMessageDto; replies: ChatMessageDto[] };
type SearchResult = { message: ChatMessageDto; channel: { id: string; kind: string; name: string } | null };
type Modal = null | { kind: "channel" } | { kind: "dm" } | { kind: "members" };

const VIEW_ONLY = "보기 권한만 있습니다.";
/** 마지막으로 연 대화(계정 범위 키, 화면 설정이라 로그아웃해도 남긴다). 새로고침·탭 이동 뒤 같은 대화로 돌아온다. */
export const ACTIVE_CHANNEL_KEY = "xdnode-chat-active-channel";
const ARCHIVED = "보관된 대화에는 새 글을 쓰거나 바꿀 수 없습니다.";
const EMPTY_HISTORY: History = { messages: [], hasMore: false, loading: false };

const timeFormat = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
function when(ms: number) {
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dateTimeFormat.format(date);
}
function fileSize(bytes: number) {
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

function MessageItem({ message, people, mine, canWrite, archived, onReply, onEdit, onDelete }: {
  message: ChatMessageDto; people: ChatPerson[]; mine: boolean; canWrite: boolean; archived: boolean;
  onReply?: () => void; onEdit: (body: string) => Promise<boolean>; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editable = mine && canWrite && !archived && !message.deleted;
  return (
    <article className={["chat-message", mine ? "mine" : "theirs", message.deleted ? "deleted" : ""].filter(Boolean).join(" ")} data-message-id={message.id}>
      <header>
        {!mine && <strong>{message.author.name}</strong>}
        <time dateTime={new Date(message.createdAt).toISOString()}>{when(message.createdAt)}</time>
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
      <footer>
        {onReply && message.threadRootId === null && !message.deleted && (
          <button type="button" className="chat-link-button" onClick={onReply}>{message.replyCount > 0 ? `답글 ${message.replyCount}개` : "답글"}</button>
        )}
        {onReply && message.threadRootId === null && message.deleted && message.replyCount > 0 && (
          <button type="button" className="chat-link-button" onClick={onReply}>답글 {message.replyCount}개</button>
        )}
        {editable && !editing && <>
          <button type="button" className="chat-link-button" onClick={() => { setDraft(message.body ?? ""); setEditing(true); }}>수정</button>
          <button type="button" className="chat-link-button danger" onClick={onDelete}>삭제</button>
        </>}
      </footer>
    </article>
  );
}

type Pending = { key: string; name: string; size: number; attachment?: ChatAttachmentDto; error?: string };


function Composer({ channelId, threadRootId, disabledReason, placeholder, mentionPeople, mentionChannel, onSent, onError }: {
  channelId: string; threadRootId?: number; disabledReason: string | null; placeholder: string;
  /** @ 자동완성 후보(서버가 멘션으로 인정하는 사람, 채널 멤버 먼저). */
  mentionPeople: ChatPerson[]; mentionChannel: boolean;
  onSent: (message: ChatMessageDto) => void; onError: (message: string) => void;
}) {
  const [body, setBody] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  // @ 자동완성: 커서 앞 '@질의'와 고른 줄. Esc 로 닫은 '@'는 커서가 떠날 때까지 다시 열지 않는다.
  const [mention, setMention] = useState<{ start: number; caret: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const suggestions = mention ? mentionSuggestions(mentionPeople, mention.query, { includeChannel: mentionChannel }) : [];
  const menuOpen = suggestions.length > 0;
  const selectedIndex = Math.min(mentionIndex, Math.max(suggestions.length - 1, 0));

  function trackMention(element: HTMLTextAreaElement) {
    const caret = element.selectionStart ?? element.value.length;
    const found = element.selectionStart === element.selectionEnd ? mentionQueryAt(element.value, caret) : null;
    if (!found) { setMention(null); setDismissedAt(null); return; }
    if (found.start === dismissedAt) { setMention(null); return; }
    if (!mention || mention.start !== found.start || mention.query !== found.query) setMentionIndex(0);
    setMention({ ...found, caret });
  }

  function chooseMention(person: ChatPerson) {
    if (!mention) return;
    const next = applyMention(body, mention.start, mention.caret, person.name);
    setBody(next.text);
    setMention(null);
    window.requestAnimationFrame(() => {
      const element = textRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  }
  const [pending, setPending] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = pending.some((item) => !item.attachment && !item.error);
  const ready = pending.filter((item) => item.attachment);

  // 채널이 바뀌면 작성 중이던 내용을 비운다. 올려 둔 미전송 첨부는 서버에서 지운다.
  useEffect(() => () => {
    setBody("");
    setPending((items) => {
      for (const item of items) if (item.attachment) void chatRequest(`/api/chat/attachments?id=${encodeURIComponent(item.attachment.id)}`, { method: "DELETE" });
      return [];
    });
  }, [channelId, threadRootId]);

  async function addFiles(files: File[]) {
    if (pending.length + files.length > CHAT_ATTACHMENTS_PER_MESSAGE) { onError(`첨부는 한 번에 ${CHAT_ATTACHMENTS_PER_MESSAGE}개까지입니다.`); return; }
    for (const file of files) {
      if (file.size > CHAT_ATTACHMENT_MAX_BYTES) { onError(`${file.name}: 파일은 25MB까지 올릴 수 있습니다.`); continue; }
      if (!fileExtensionAllowed(file.name)) { onError(`${file.name}: 올릴 수 없는 파일 형식입니다.`); continue; }
      const key = randomId();
      setPending((items) => [...items, { key, name: file.name, size: file.size }]);
      const result = await uploadChatAttachment(channelId, file);
      setPending((items) => items.map((item) => item.key !== key ? item
        : result.ok && result.body.attachment ? { ...item, attachment: result.body.attachment } : { ...item, error: result.body.error ?? "올리지 못했습니다." }));
    }
  }

  // 캡처 이미지 붙여넣기(Ctrl+V). 클립보드에 글이 함께 있으면(Word·웹 문서 복사) 글 붙여넣기를 그대로 둔다.
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!images.length || event.clipboardData.getData("text/plain").trim()) return;
    event.preventDefault();
    void addFiles(images.map((file, index) => pastedImageFile(file, index)));
  }

  async function remove(item: Pending) {
    setPending((items) => items.filter((candidate) => candidate.key !== item.key));
    if (item.attachment) await chatRequest(`/api/chat/attachments?id=${encodeURIComponent(item.attachment.id)}`, { method: "DELETE" });
  }

  async function send() {
    if (sending || uploading || disabledReason) return;
    if (!body.trim() && ready.length === 0) return;
    setSending(true);
    const result = await chatRequest<{ message: ChatMessageDto }>("/api/chat/messages", {
      method: "POST",
      body: { channelId, body, threadRootId, attachmentIds: ready.map((item) => item.attachment!.id), clientKey: randomId() },
    });
    setSending(false);
    if (!result.ok || !result.body.message) { onError(result.body.error ?? "보내지 못했습니다."); return; }
    setBody("");
    setPending([]);
    onSent(result.body.message);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 명단이 열려 있으면 ↑↓·Enter·Tab·Esc 는 명단 조작이다. 한글 조합 중 키는 글자 확정이므로 건드리지 않는다.
    if (menuOpen && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((selectedIndex + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        chooseMention(suggestions[selectedIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedAt(mention?.start ?? null);
        setMention(null);
        return;
      }
    }
    // 한글 조합 중 Enter 는 글자 확정이다. 전송하지 않는다.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  if (disabledReason) return <div className="chat-composer disabled" role="status">{disabledReason}</div>;
  return (
    <div className="chat-composer">
      {pending.length > 0 && (
        <ul className="chat-pending">
          {pending.map((item) => (
            <li key={item.key} className={item.error ? "error" : item.attachment ? "" : "uploading"}>
              <span className="chat-attachment-name">{item.name}</span>
              <small>{item.error ?? (item.attachment ? fileSize(item.size) : "올리는 중…")}</small>
              <button type="button" aria-label={`${item.name} 빼기`} onClick={() => void remove(item)}>×</button>
            </li>
          ))}
        </ul>
      )}
      {menuOpen && (
        <ul className="chat-mention-menu" role="listbox" aria-label="멘션할 사람">
          {suggestions.map((person, index) => (
            <li key={person.accountId} role="option" aria-selected={index === selectedIndex}>
              <button type="button" className={index === selectedIndex ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setMentionIndex(index)} onClick={() => chooseMention(person)}>
                <span className="chat-mention-avatar" aria-hidden="true">{person.accountId === "@channel" ? "@" : person.name.slice(0, 1)}</span>
                <strong>{person.accountId === "@channel" ? "@채널" : person.name}</strong>
                {person.accountId === "@channel" && <small>이 대화의 모두에게 알림</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea ref={textRef} value={body} maxLength={CHAT_MESSAGE_MAX_LENGTH} rows={2} placeholder={placeholder} aria-label="메시지"
        aria-autocomplete="list"
        onChange={(event) => { setBody(event.target.value); trackMention(event.target); }}
        onSelect={(event) => trackMention(event.currentTarget)} onBlur={() => setMention(null)}
        onKeyDown={onKeyDown} onPaste={onPaste} />
      <div className="chat-composer-actions">
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; void addFiles(files); }} />
        <button type="button" onClick={() => fileInput.current?.click()} disabled={pending.length >= CHAT_ATTACHMENTS_PER_MESSAGE}>첨부</button>
        <span className="chat-counter">{body.length.toLocaleString("ko-KR")} / {CHAT_MESSAGE_MAX_LENGTH.toLocaleString("ko-KR")}</span>
        <small>Enter 전송 · Shift+Enter 줄바꿈 · 캡처 이미지는 Ctrl+V</small>
        <button type="button" className="primary-button" disabled={sending || uploading || (!body.trim() && ready.length === 0)} onClick={() => void send()}>
          {sending ? "보내는 중" : "보내기"}
        </button>
      </div>
    </div>
  );
}

function PeoplePicker({ people, exclude, selected, onChange, max }: { people: ChatPerson[]; exclude: Set<string>; selected: string[]; onChange: (ids: string[]) => void; max?: number }) {
  const choices = people.filter((person) => !exclude.has(person.accountId));
  if (!choices.length) return <p className="chat-muted">고를 수 있는 사람이 없습니다.</p>;
  return (
    <ul className="chat-people-picker">
      {choices.map((person) => {
        const checked = selected.includes(person.accountId);
        return (
          <li key={person.accountId}>
            <label>
              <input type="checkbox" checked={checked} disabled={!checked && max !== undefined && selected.length >= max}
                onChange={() => onChange(checked ? selected.filter((id) => id !== person.accountId) : [...selected, person.accountId])} />
              <span>{person.name}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function ModalFrame({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="chat-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="chat-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><strong>{title}</strong><button type="button" aria-label="닫기" onClick={onClose}>×</button></header>
        {children}
      </div>
    </div>
  );
}

export default function ChatWorkspace({ accountId, poll }: Props) {
  const dialog = useErpDialog();
  const [data, setData] = useState<ChatChannelsResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const [thread, setThread] = useState<Thread | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const [formName, setFormName] = useState("");
  const [formTopic, setFormTopic] = useState("");
  const [formPrivate, setFormPrivate] = useState(false);
  const [formPeople, setFormPeople] = useState<string[]>([]);
  const [formError, setFormError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const activeRef = useRef<string | null>(null);
  const historyRef = useRef<History>(EMPTY_HISTORY);
  const threadRef = useRef<Thread | null>(null);
  const joinedRef = useRef(false);
  useEffect(() => { activeRef.current = activeId; historyRef.current = history; threadRef.current = thread; });

  const people = useMemo(() => data?.people ?? [], [data]);
  const [channelMembers, setChannelMembers] = useState<{ channelId: string; ids: string[] } | null>(null);
  const nameOf = useCallback((id: string) => people.find((person) => person.accountId === id)?.name ?? "알 수 없는 사용자", [people]);
  const canWrite = data?.me.canWrite ?? false;
  const isAdmin = data?.me.isAdmin ?? false;

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? "" : current), 4000);
  }, []);

  const loadChannels = useCallback(async () => {
    const result = await chatRequest<ChatChannelsResponse>("/api/chat/channels");
    if (!result.ok) { setLoadError(result.body.error ?? "대화 목록을 불러오지 못했습니다."); return null; }
    setLoadError("");
    setData(result.body);
    return result.body;
  }, []);

  const channelLabel = useCallback((channel: Pick<ChatChannelDto, "kind" | "name" | "dmMemberIds">) => {
    if (channel.kind === "dm" || channel.kind === "group_dm") {
      const others = (channel.dmMemberIds ?? []).filter((id) => id !== accountId).map(nameOf);
      return others.length ? others.join(", ") : "나";
    }
    return channel.name;
  }, [accountId, nameOf]);

  const joined = data?.channels.find((channel) => channel.id === activeId) ?? null;
  const preview = !joined ? data?.joinable.find((channel) => channel.id === activeId) ?? null : null;
  const archived = joined?.archived ?? false;
  useEffect(() => { joinedRef.current = Boolean(joined); });

  const markRead = useCallback(async (channelId: string, messages: ChatMessageDto[]) => {
    const last = messages.reduce((max, message) => Math.max(max, message.id), 0);
    if (!last || document.visibilityState !== "visible") return;
    const result = await chatRequest<{ unread: UnreadSummary }>("/api/chat/read-state", { method: "PUT", body: { channelId, lastReadMessageId: last } });
    if (result.ok && result.body.unread) poll.setUnread(result.body.unread);
  }, [poll]);

  const loadHistory = useCallback(async (channelId: string, member: boolean) => {
    const result = await chatRequest<{ messages: ChatMessageDto[]; hasMore: boolean }>(`/api/chat/messages?channelId=${encodeURIComponent(channelId)}`);
    if (activeRef.current !== channelId) return;
    if (!result.ok) { setHistory(EMPTY_HISTORY); flash(result.body.error ?? "대화를 불러오지 못했습니다."); return; }
    stickToBottom.current = true;
    setHistory({ messages: result.body.messages, hasMore: result.body.hasMore, loading: false });
    if (member) void markRead(channelId, result.body.messages);
  }, [flash, markRead]);

  /** 대화를 바꾼다. 스레드·검색 결과를 닫고 기록을 비운다(새 기록은 아래 효과가 읽는다). */
  const selectChannel = useCallback((id: string | null) => {
    setThread(null);
    setResults(null);
    setHistory(id ? { ...EMPTY_HISTORY, loading: true } : EMPTY_HISTORY);
    setActiveId(id);
    if (id) writeScoped(ACTIVE_CHANNEL_KEY, id);
  }, []);

  // 처음: 목록을 읽고, 참여한 첫 대화(없으면 '일반' 미리보기)를 연다.
  useEffect(() => {
    void (async () => {
      const loaded = await loadChannels();
      if (!loaded) return;
      // 저장해 둔 대화가 아직 보이면(내 채널·DM 이거나 참여 가능한 공개 채널) 그것을, 아니면 참여한 첫 대화를 연다.
      const saved = readScoped(ACTIVE_CHANNEL_KEY, []);
      const visible = saved && (loaded.channels.some((channel) => channel.id === saved) || loaded.joinable.some((channel) => channel.id === saved));
      const first = loaded.channels.find((channel) => !channel.archived) ?? loaded.channels[0] ?? null;
      selectChannel(visible ? saved : first?.id ?? loaded.joinable[0]?.id ?? null);
    })();
  }, [loadChannels, selectChannel]);

  const activeMember = Boolean(joined);
  useEffect(() => {
    poll.setWatch(activeId && !activeMember ? activeId : null);
    // 참여 여부가 바뀌어도(참여 직후) 기록을 다시 읽는다.
    if (!activeId) return;
    let current = true;
    void (async () => {
      await Promise.resolve();
      if (current) await loadHistory(activeId, activeMember);
    })();
    return () => { current = false; };
  }, [activeId, activeMember, loadHistory, poll]);

  useEffect(() => () => poll.setWatch(null), [poll]);

  // @ 자동완성용 채널 멤버. 멤버 수가 바뀌면(참여·추가·내보내기) 다시 읽는다. DM 은 목록의 dmMemberIds 를 쓴다.
  const memberCount = joined?.memberCount ?? preview?.memberCount ?? 0;
  const isDirect = joined?.kind === "dm" || joined?.kind === "group_dm";
  useEffect(() => {
    if (!activeId || isDirect) return;
    let alive = true;
    void (async () => {
      const result = await chatRequest<{ members: string[] }>(`/api/chat/channels?members=${encodeURIComponent(activeId)}`);
      if (alive && result.ok && Array.isArray(result.body.members)) setChannelMembers({ channelId: activeId, ids: result.body.members });
    })();
    return () => { alive = false; };
  }, [activeId, isDirect, memberCount]);

  /** 서버가 멘션으로 인정하는 사람(비공개·DM 은 멤버, 공개는 메신저 권한자 전원). 멤버 먼저, 나는 뺀다. */
  const mentionPeople = useMemo(() => {
    const others = people.filter((person) => person.accountId !== accountId);
    if (isDirect) return others.filter((person) => joined?.dmMemberIds?.includes(person.accountId));
    const members = new Set(channelMembers?.channelId === activeId ? channelMembers.ids : []);
    const inChannel = others.filter((person) => members.has(person.accountId));
    if (joined?.kind === "private") return inChannel;
    return [...inChannel, ...others.filter((person) => !members.has(person.accountId))];
  }, [people, accountId, isDirect, joined, channelMembers, activeId]);
  const mentionChannel = joined?.kind !== "dm";

  // 새 글이 오면 바닥에 붙어 있을 때만 따라 내려간다.
  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [history.messages]);

  const applyMessage = useCallback((message: ChatMessageDto, mode: "upsert" | "replace") => {
    if (message.channelId !== activeRef.current) return;
    if (message.threadRootId === null) {
      setHistory((current) => {
        const index = current.messages.findIndex((item) => item.id === message.id);
        if (index >= 0) return { ...current, messages: current.messages.map((item) => item.id === message.id ? message : item) };
        if (mode === "replace") return current;
        return { ...current, messages: [...current.messages, message].sort((a, b) => a.id - b.id) };
      });
      setThread((current) => current && current.root.id === message.id ? { ...current, root: message } : current);
      return;
    }
    setThread((current) => {
      if (!current || current.root.id !== message.threadRootId) return current;
      const index = current.replies.findIndex((item) => item.id === message.id);
      if (index >= 0) return { ...current, replies: current.replies.map((item) => item.id === message.id ? message : item) };
      if (mode === "replace") return current;
      return { ...current, replies: [...current.replies, message] };
    });
    if (mode === "upsert") {
      const bump = (item: ChatMessageDto) => item.id === message.threadRootId ? { ...item, replyCount: item.replyCount + 1, lastReplyAt: message.createdAt } : item;
      setHistory((current) => ({ ...current, messages: current.messages.map(bump) }));
      setThread((current) => current && current.root.id === message.threadRootId ? { ...current, root: bump(current.root) } : current);
    }
  }, []);

  // 폴링 이벤트.
  useEffect(() => poll.subscribe((events: ChatPollEvent[], meta) => {
    let reloadChannels = meta.resync;
    let newTopLevel = false;
    for (const event of events) {
      if (event.kind.startsWith("channel.") || event.kind.startsWith("member.")) { reloadChannels = true; continue; }
      if (!event.message) continue;
      // 이미 가진 메시지면(본인 전송) 바꾸기만 한다. 새 답글이면 원글의 답글 수를 올린다.
      const exists = event.message.threadRootId === null
        ? historyRef.current.messages.some((item) => item.id === event.message!.id)
        : threadRef.current?.replies.some((item) => item.id === event.message!.id) ?? false;
      applyMessage(event.message, event.kind === "message.created" && !exists ? "upsert" : "replace");
      if (event.kind === "message.created" && event.channelId === activeRef.current && event.message.threadRootId === null) newTopLevel = true;
    }
    if (reloadChannels) {
      void loadChannels().then((loaded) => {
        if (!loaded || !activeRef.current) return;
        const stillVisible = loaded.channels.some((channel) => channel.id === activeRef.current) || loaded.joinable.some((channel) => channel.id === activeRef.current);
        if (!stillVisible) { selectChannel(loaded.channels[0]?.id ?? loaded.joinable[0]?.id ?? null); flash("대화를 더는 볼 수 없습니다."); }
        else if (meta.resync) void loadHistory(activeRef.current, loaded.channels.some((channel) => channel.id === activeRef.current));
      });
    }
    if (newTopLevel && activeRef.current && joinedRef.current) {
      const channelId = activeRef.current;
      const messages = [...historyRef.current.messages, ...events.flatMap((event) => event.message && event.message.threadRootId === null ? [event.message] : [])];
      void markRead(channelId, messages);
    }
  }), [poll, applyMessage, loadChannels, loadHistory, markRead, flash, selectChannel]);

  async function loadOlder() {
    if (!activeId || history.loading || !history.hasMore || !history.messages.length) return;
    const list = listRef.current;
    const previousHeight = list?.scrollHeight ?? 0;
    setHistory((current) => ({ ...current, loading: true }));
    const result = await chatRequest<{ messages: ChatMessageDto[]; hasMore: boolean }>(
      `/api/chat/messages?channelId=${encodeURIComponent(activeId)}&before=${history.messages[0].id}`);
    if (!result.ok) { setHistory((current) => ({ ...current, loading: false })); return; }
    stickToBottom.current = false;
    setHistory((current) => ({ messages: [...result.body.messages, ...current.messages], hasMore: result.body.hasMore, loading: false }));
    window.requestAnimationFrame(() => { if (list) list.scrollTop = list.scrollHeight - previousHeight; });
  }

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    if (list.scrollTop < 40) void loadOlder();
  }

  async function openThread(root: ChatMessageDto) {
    const result = await chatRequest<{ root: ChatMessageDto; replies: ChatMessageDto[] }>(`/api/chat/messages?threadRootId=${root.id}`);
    if (!result.ok) { flash(result.body.error ?? "스레드를 불러오지 못했습니다."); return; }
    setThread({ root: result.body.root, replies: result.body.replies });
  }

  async function editMessage(message: ChatMessageDto, body: string) {
    const result = await chatRequest<{ message: ChatMessageDto }>("/api/chat/messages", { method: "PATCH", body: { id: message.id, body } });
    if (!result.ok || !result.body.message) { flash(result.body.error ?? "고치지 못했습니다."); return false; }
    applyMessage(result.body.message, "replace");
    return true;
  }

  async function deleteMessage(message: ChatMessageDto) {
    if (!(await dialog.confirm("이 메시지를 삭제할까요? 첨부 파일도 함께 사라집니다.", { title: "메시지 삭제", confirmLabel: "삭제" }))) return;
    const result = await chatRequest<{ message: ChatMessageDto }>(`/api/chat/messages?id=${message.id}`, { method: "DELETE" });
    if (!result.ok || !result.body.message) { flash(result.body.error ?? "삭제하지 못했습니다."); return; }
    applyMessage(result.body.message, "replace");
  }

  async function channelAction(body: Record<string, unknown>, failure: string) {
    const result = await chatRequest<{ channel?: ChatChannelDto; created?: boolean }>("/api/chat/channels", { method: "POST", body });
    if (!result.ok) { return { ok: false as const, error: result.body.error ?? failure }; }
    await loadChannels();
    return { ok: true as const, channel: result.body.channel };
  }

  async function join(channelId: string) {
    const result = await channelAction({ action: "JOIN", channelId }, "참여하지 못했습니다.");
    if (!result.ok) flash(result.error);
  }

  async function leave() {
    if (!joined || joined.kind !== "public") return;
    if (!(await dialog.confirm(`'${joined.name}' 채널에서 나갈까요? 언제든 다시 참여할 수 있습니다.`, { title: "채널 나가기", confirmLabel: "나가기" }))) return;
    const result = await channelAction({ action: "LEAVE", channelId: joined.id }, "나가지 못했습니다.");
    if (!result.ok) flash(result.error);
  }

  async function rename() {
    if (!joined) return;
    const name = await dialog.prompt("새 채널 이름(1~40자)", { title: "채널 이름 변경", defaultValue: joined.name, confirmLabel: "저장" });
    if (name === null) return;
    const topic = await dialog.prompt("주제(200자까지, 비워도 됩니다)", { title: "채널 주제", defaultValue: joined.topic, confirmLabel: "저장" });
    const result = await channelAction({ action: "RENAME", channelId: joined.id, name, ...(topic === null ? {} : { topic }) }, "바꾸지 못했습니다.");
    if (!result.ok) flash(result.error);
  }

  async function archive() {
    if (!joined) return;
    if (!(await dialog.confirm("이 대화를 보관할까요? 보관한 대화는 읽기만 할 수 있습니다.", { title: "대화 보관", confirmLabel: "보관" }))) return;
    const result = await chatRequest(`/api/chat/channels?id=${encodeURIComponent(joined.id)}`, { method: "DELETE" });
    if (!result.ok) flash(result.body.error ?? "보관하지 못했습니다.");
    await loadChannels();
  }

  async function removeMember(memberId: string) {
    if (!joined) return;
    if (!(await dialog.confirm(`${nameOf(memberId)} 님을 채널에서 내보낼까요?`, { title: "멤버 내보내기", confirmLabel: "내보내기" }))) return;
    const result = await channelAction({ action: "REMOVE_MEMBER", channelId: joined.id, accountId: memberId }, "내보내지 못했습니다.");
    if (!result.ok) setFormError(result.error);
  }

  function openModal(next: Modal) {
    setFormName(""); setFormTopic(""); setFormPrivate(false); setFormPeople([]); setFormError("");
    setModal(next);
  }

  async function submitModal() {
    if (!modal) return;
    setFormError("");
    if (modal.kind === "channel") {
      const result = await channelAction({ action: "CREATE_CHANNEL", name: formName, kind: formPrivate ? "private" : "public", topic: formTopic, memberIds: formPeople }, "채널을 만들지 못했습니다.");
      if (!result.ok) { setFormError(result.error); return; }
      setModal(null);
      if (result.channel) selectChannel(result.channel.id);
    } else if (modal.kind === "dm") {
      const result = await channelAction({ action: "OPEN_DM", accountIds: formPeople }, "대화를 열지 못했습니다.");
      if (!result.ok) { setFormError(result.error); return; }
      setModal(null);
      if (result.channel) selectChannel(result.channel.id);
    } else if (joined) {
      const result = await channelAction({ action: "ADD_MEMBERS", channelId: joined.id, accountIds: formPeople }, "멤버를 추가하지 못했습니다.");
      if (!result.ok) { setFormError(result.error); return; }
      setModal(null);
    }
  }

  async function runSearch() {
    const q = search.trim();
    if (q.length < CHAT_SEARCH_MIN || q.length > CHAT_SEARCH_MAX) { flash(`검색어는 ${CHAT_SEARCH_MIN}~${CHAT_SEARCH_MAX}자로 입력해 주세요.`); return; }
    const result = await chatRequest<{ results: SearchResult[] }>(`/api/chat/messages?q=${encodeURIComponent(q)}`);
    if (!result.ok) { flash(result.body.error ?? "검색하지 못했습니다."); return; }
    setResults(result.body.results);
  }

  function onSent(message: ChatMessageDto) {
    stickToBottom.current = true;
    applyMessage(message, "upsert");
    poll.pollNow();
  }

  const unreadOf = (channelId: string) => poll.unread?.channels.find((row) => row.channelId === channelId) ?? null;
  const rooms = data?.channels.filter((channel) => channel.kind === "public" || channel.kind === "private") ?? [];
  const dms = data?.channels.filter((channel) => channel.kind === "dm" || channel.kind === "group_dm") ?? [];
  const managing = joined && (joined.kind === "public" || joined.kind === "private") && (joined.myRole === "owner" || isAdmin) && !archived;
  const disabledReason = !canWrite ? VIEW_ONLY : archived ? ARCHIVED : null;

  const channelButton = (channel: ChatChannelDto) => {
    const counts = unreadOf(channel.id);
    const label = channelLabel(channel);
    return (
      <li key={channel.id}>
        <button type="button" className={["chat-channel", channel.id === activeId ? "active" : "", channel.archived ? "archived" : "", counts?.unread ? "unread" : ""].filter(Boolean).join(" ")}
          onClick={() => selectChannel(channel.id)}>
          <span className="chat-channel-glyph" aria-hidden="true">{channel.kind === "private" ? "🔒" : channel.kind === "public" ? "#" : "●"}</span>
          <span className="chat-channel-name">{label}</span>
          {counts && counts.mentions > 0 && <span className="chat-badge mention" aria-label={`멘션 ${counts.mentions}개`}>@{counts.mentions}</span>}
          {counts && counts.unread > 0 && <span className="chat-badge" aria-label={`안 읽은 글 ${counts.unread}개`}>{counts.unread}</span>}
        </button>
      </li>
    );
  };

  if (!data) {
    return <main className="chat-page"><div className="chat-loading" role="status">{loadError || "대화 목록을 불러오는 중…"}</div></main>;
  }

  return (
    <main className="chat-page">
      <aside className="chat-sidebar" aria-label="대화 목록">
        <form className="chat-search" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
          <input type="search" value={search} maxLength={CHAT_SEARCH_MAX} placeholder="메시지 검색" aria-label="메시지 검색"
            onChange={(event) => { setSearch(event.target.value); if (!event.target.value) setResults(null); }} />
        </form>
        <section>
          <header><span>채널</span>{canWrite && <button type="button" onClick={() => openModal({ kind: "channel" })}>+ 채널</button>}</header>
          <ul>{rooms.map(channelButton)}</ul>
          {data.joinable.length > 0 && (
            <ul className="chat-joinable">
              {data.joinable.map((channel) => (
                <li key={channel.id}>
                  <button type="button" className={channel.id === activeId ? "chat-channel active" : "chat-channel"} onClick={() => selectChannel(channel.id)}>
                    <span className="chat-channel-glyph" aria-hidden="true">#</span>
                    <span className="chat-channel-name">{channel.name}</span>
                    <small>참여 전</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <header><span>대화</span>{canWrite && <button type="button" onClick={() => openModal({ kind: "dm" })}>+ DM</button>}</header>
          {dms.length ? <ul>{dms.map(channelButton)}</ul> : <p className="chat-muted">1:1·그룹 대화가 없습니다.</p>}
        </section>
      </aside>

      <section className="chat-main" aria-label="대화">
        {results ? (
          <div className="chat-results">
            <header className="chat-header">
              <div><strong>검색 결과</strong><span>{results.length}건 · 최근 50건까지</span></div>
              <button type="button" onClick={() => setResults(null)}>닫기</button>
            </header>
            <div className="chat-list">
              {results.length === 0 && <p className="chat-muted">일치하는 메시지가 없습니다.</p>}
              {results.map((result) => (
                <button type="button" key={result.message.id} className="chat-result" onClick={() => { if (result.channel) selectChannel(result.channel.id); else setResults(null); }}>
                  <small>{result.channel ? (result.channel.kind === "public" || result.channel.kind === "private" ? `# ${result.channel.name}` : "1:1·그룹 대화") : ""}</small>
                  <strong>{result.message.author.name}</strong>
                  <time>{when(result.message.createdAt)}</time>
                  <p>{result.message.body}</p>
                </button>
              ))}
            </div>
          </div>
        ) : !activeId ? (
          <div className="chat-empty"><p>왼쪽에서 대화를 고르거나 새 채널을 만드세요.</p></div>
        ) : (
          <>
            <header className="chat-header">
              <div>
                <strong>{joined ? (joined.kind === "public" ? "# " : joined.kind === "private" ? "🔒 " : "") + channelLabel(joined) : preview ? `# ${preview.name}` : ""}</strong>
                <span>
                  {(joined?.topic || preview?.topic) && <>{joined?.topic || preview?.topic} · </>}
                  멤버 {joined?.memberCount ?? preview?.memberCount ?? 0}명{archived ? " · 보관됨" : ""}
                </span>
              </div>
              <div className="chat-header-actions">
                {preview && <button type="button" className="primary-button" onClick={() => void join(preview.id)}>참여</button>}
                {managing && <button type="button" onClick={() => void rename()}>이름 변경</button>}
                {joined && (joined.kind === "public" || joined.kind === "private") && !archived && canWrite && (
                  <button type="button" onClick={() => openModal({ kind: "members" })}>멤버 관리</button>
                )}
                {joined?.kind === "public" && <button type="button" onClick={() => void leave()}>나가기</button>}
                {isAdmin && joined && !archived && <button type="button" className="danger" onClick={() => void archive()}>보관</button>}
              </div>
            </header>
            <div className="chat-body">
              <div className="chat-list" ref={listRef} onScroll={onScroll}>
                {history.hasMore && <button type="button" className="chat-older" onClick={() => void loadOlder()} disabled={history.loading}>이전 메시지</button>}
                {!history.loading && history.messages.length === 0 && <p className="chat-muted">아직 메시지가 없습니다. 첫 글을 남겨 보세요.</p>}
                {history.messages.map((message) => (
                  <MessageItem key={message.id} message={message} people={people} mine={message.author.accountId === accountId} canWrite={canWrite}
                    archived={archived} onReply={() => void openThread(message)} onEdit={(body) => editMessage(message, body)} onDelete={() => void deleteMessage(message)} />
                ))}
              </div>
              {thread && (
                <aside className="chat-thread" aria-label="스레드">
                  <header><strong>스레드</strong><button type="button" aria-label="스레드 닫기" onClick={() => setThread(null)}>×</button></header>
                  <div className="chat-thread-list">
                    <MessageItem message={thread.root} people={people} mine={thread.root.author.accountId === accountId} canWrite={canWrite} archived={archived}
                      onEdit={(body) => editMessage(thread.root, body)} onDelete={() => void deleteMessage(thread.root)} />
                    <p className="chat-thread-count">답글 {thread.replies.length}개</p>
                    {thread.replies.map((reply) => (
                      <MessageItem key={reply.id} message={reply} people={people} mine={reply.author.accountId === accountId} canWrite={canWrite} archived={archived}
                        onEdit={(body) => editMessage(reply, body)} onDelete={() => void deleteMessage(reply)} />
                    ))}
                  </div>
                  <Composer channelId={activeId} threadRootId={thread.root.id} placeholder="답글 쓰기" onError={flash} mentionPeople={mentionPeople} mentionChannel={mentionChannel}
                    disabledReason={disabledReason ?? (thread.root.deleted ? "삭제된 메시지에는 답글을 달 수 없습니다." : null)} onSent={onSent} />
                </aside>
              )}
            </div>
            <Composer channelId={activeId} mentionPeople={mentionPeople} mentionChannel={mentionChannel} placeholder={preview ? "보내면 이 채널에 참여합니다" : "메시지 쓰기 (@이름으로 멘션)"} onError={flash}
              disabledReason={disabledReason} onSent={(message) => { onSent(message); if (preview) void loadChannels(); }} />
          </>
        )}
        {notice && <div className="chat-notice" role="status">{notice}</div>}
      </section>

      {modal && (
        <ModalFrame title={modal.kind === "channel" ? "새 채널" : modal.kind === "dm" ? "새 대화" : "멤버 관리"} onClose={() => setModal(null)}>
          <div className="chat-modal-body">
            {modal.kind === "channel" && <>
              <label><span>이름 (1~40자)</span><input value={formName} maxLength={40} onChange={(event) => setFormName(event.target.value)} /></label>
              <label><span>주제 (선택, 200자까지)</span><input value={formTopic} maxLength={200} onChange={(event) => setFormTopic(event.target.value)} /></label>
              <label className="chat-inline"><input type="checkbox" checked={formPrivate} onChange={(event) => setFormPrivate(event.target.checked)} /><span>비공개 (초대한 사람만 봅니다)</span></label>
              <span className="chat-modal-label">멤버 (선택)</span>
              <PeoplePicker people={people} exclude={new Set([accountId])} selected={formPeople} onChange={setFormPeople} />
            </>}
            {modal.kind === "dm" && <>
              <span className="chat-modal-label">대화할 사람 (1~{CHAT_GROUP_DM_MAX_OTHERS}명)</span>
              <PeoplePicker people={people} exclude={new Set([accountId])} selected={formPeople} onChange={setFormPeople} max={CHAT_GROUP_DM_MAX_OTHERS} />
            </>}
            {modal.kind === "members" && joined && <MembersPanel channel={joined} accountId={accountId} people={people} nameOf={nameOf}
              canRemove={Boolean(managing)} onRemove={(id) => void removeMember(id)} selected={formPeople} onSelect={setFormPeople} />}
            {formError && <p className="chat-form-error" role="alert">{formError}</p>}
          </div>
          <footer>
            <button type="button" onClick={() => setModal(null)}>취소</button>
            <button type="button" className="primary-button" onClick={() => void submitModal()}
              disabled={modal.kind === "channel" ? !formName.trim() : formPeople.length === 0}>
              {modal.kind === "channel" ? "만들기" : modal.kind === "dm" ? "대화 열기" : "추가"}
            </button>
          </footer>
        </ModalFrame>
      )}
    </main>
  );
}

/** 멤버 관리: 현재 멤버(owner·관리자는 내보내기)와 추가할 사람. 멤버 목록은 모달을 열 때 서버에서 읽는다. */
function MembersPanel({ channel, accountId, people, nameOf, canRemove, onRemove, selected, onSelect }: {
  channel: ChatChannelDto; accountId: string; people: ChatPerson[]; nameOf: (id: string) => string; canRemove: boolean;
  onRemove: (id: string) => void; selected: string[]; onSelect: (ids: string[]) => void;
}) {
  const [members, setMembers] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    void chatRequest<{ members: string[] }>(`/api/chat/channels?members=${encodeURIComponent(channel.id)}`).then((result) => {
      if (alive) setMembers(result.ok && Array.isArray(result.body.members) ? result.body.members : []);
    });
    return () => { alive = false; };
  }, [channel.id, channel.memberCount]);
  const current = new Set(members ?? []);
  return <>
    <span className="chat-modal-label">현재 멤버 {members ? `${members.length}명` : ""}</span>
    {members === null ? <p className="chat-muted">불러오는 중…</p> : (
      <ul className="chat-member-list">
        {members.map((id) => (
          <li key={id}>
            <span>{nameOf(id)}{id === accountId ? " (나)" : ""}</span>
            {canRemove && id !== accountId && <button type="button" className="chat-link-button danger" onClick={() => onRemove(id)}>내보내기</button>}
          </li>
        ))}
      </ul>
    )}
    <span className="chat-modal-label">추가할 사람</span>
    <PeoplePicker people={people} exclude={current.size ? current : new Set([accountId])} selected={selected} onChange={onSelect} />
  </>;
}
