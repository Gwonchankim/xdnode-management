"use client";

// 메신저 탭(R5, Design §5.4 메신저 탭 체크리스트, FR-12~FR-15). 채널·DM 목록, 대화, 스레드, 검색, 첨부.
// 본문·채널 이름·파일 이름·표시 이름은 React 텍스트 노드로만 그린다(§7.8). 링크는 http:·https: 만 만든다.
// 실시간 갱신은 셸의 useChatPoll 이벤트를 구독한다. 권한 판정은 서버가 다시 한다(여기서 숨기는 것은 편의일 뿐이다).

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { applyMention, mentionQueryAt, mentionSuggestions } from "./chat-mentions";
import { MessageItem, PresenceDot, fileSize, when } from "./chat-message";
import {
  ActivityPanel, ChatNotifySettings, EMPTY_SEARCH_FILTERS, FilesPanel, PinsPanel, SavedPanel, SearchFilters, searchFilterCount, searchQuery,
  type ChatSearchFilters,
} from "./chat-panels";
import { useErpDialog } from "./erp-dialog";
import { randomId, readScoped, writeScoped } from "./client-runtime";
import {
  CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENTS_PER_MESSAGE, CHAT_GROUP_DM_MAX_OTHERS, CHAT_MESSAGE_MAX_LENGTH, CHAT_SEARCH_MAX, CHAT_SEARCH_MIN,
  chatRequest, fileExtensionAllowed, pastedImageFile, presenceLabel, unreadCountFor, uploadChatAttachment,
  type ChatActivityItem, type ChatAttachmentDto, type ChatBookmarkItem, type ChatChannelDto, type ChatFileItem, type ChatPinItem, type ChatChannelsResponse, type ChatMessageDto, type ChatNotifyLevel, type ChatPerson,
  type ChatPoll, type ChatPollEvent, type UnreadSummary,
} from "./chat-client";

type Props = { accountId: string; poll: ChatPoll };
/** hasNewer: 이동(around)으로 옛 구간을 보는 중이라 최신 글과 이어져 있지 않다(ME-DD15). 이때는 poll 의 새 글을 붙이지 않는다. */
type History = { messages: ChatMessageDto[]; hasMore: boolean; hasNewer: boolean; loading: boolean };
type HistoryResponse = { messages: ChatMessageDto[]; hasMore?: boolean; hasNewer?: boolean; focusId?: number; focusReplyId?: number };
/** ME-FR-10·12 오른쪽 패널(스레드 자리를 함께 쓴다). */
type Side = null | { kind: "pins"; pins: ChatPinItem[] | "loading" } | { kind: "files"; files: ChatFileItem[]; nextBefore: string | null; loading: boolean };
/** 이동 대상. replyId 가 있으면 스레드 패널의 그 답글이다. */
type Focus = { id: number; replyId?: number };
type Thread = { root: ChatMessageDto; replies: ChatMessageDto[] };
type SearchResult = { message: ChatMessageDto; channel: { id: string; kind: string; name: string } | null };
type Modal = null | { kind: "channel" } | { kind: "dm" } | { kind: "members" };

const VIEW_ONLY = "보기 권한만 있습니다.";
/** 마지막으로 연 대화(계정 범위 키, 화면 설정이라 로그아웃해도 남긴다). 새로고침·탭 이동 뒤 같은 대화로 돌아온다. */
export const ACTIVE_CHANNEL_KEY = "xdnode-chat-active-channel";
const ARCHIVED = "보관된 대화에는 새 글을 쓰거나 바꿀 수 없습니다.";
const EMPTY_HISTORY: History = { messages: [], hasMore: false, hasNewer: false, loading: false };
const FOCUS_MS = 2500;
const NOTIFY_LABELS: Record<ChatNotifyLevel, string> = { all: "모든 새 글", mentions: "멘션만", mute: "음소거" };

type Pending = { key: string; name: string; size: number; attachment?: ChatAttachmentDto; error?: string };


function Composer({ channelId, threadRootId, disabledReason, placeholder, mentionPeople, mentionChannel, presence = {}, onSent, onError }: {
  channelId: string; threadRootId?: number; disabledReason: string | null; placeholder: string;
  /** @ 자동완성 후보(서버가 멘션으로 인정하는 사람, 채널 멤버 먼저). */
  mentionPeople: ChatPerson[]; mentionChannel: boolean;
  /** ME-FR-09 후보 옆 접속 점. */
  presence?: Record<string, number>;
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
                {person.accountId === "@channel" ? <small>이 대화의 모두에게 알림</small> : <PresenceDot lastSeen={presence[person.accountId]} />}
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
  // useChatPoll 이 돌려주는 객체는 셸이 다시 그려질 때마다 새로 만들어진다(unread·reads·presence 가 바뀔 때).
  // 효과·콜백의 의존성에는 poll 객체가 아니라 useCallback 으로 고정된 함수만 쓴다. 그렇지 않으면 읽음 PUT → setUnread →
  // 셸 재렌더 → loadHistory 재생성 → 기록 재요청 → 읽음 PUT … 이 되풀이되고, 이동(around)한 구간도 풀린다.
  const { setUnread: setPollUnread, setWatch, setViewing, consumeOpen, subscribe: subscribePoll, pollNow } = poll;
  const [data, setData] = useState<ChatChannelsResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const [thread, setThread] = useState<Thread | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  /** ME-FR-05 활동함(가운데 영역, 검색 결과와 같은 자리). */
  const [activity, setActivity] = useState<ChatActivityItem[] | "loading" | null>(null);
  /** ME-FR-11 저장됨(가운데 영역)과 내가 저장한 메시지 id(☆/★ 표시). */
  const [savedItems, setSavedItems] = useState<ChatBookmarkItem[] | "loading" | null>(null);
  const [bookmarkIds, setBookmarkIds] = useState<ReadonlySet<number>>(() => new Set());
  const [side, setSide] = useState<Side>(null);
  const [filters, setFilters] = useState<ChatSearchFilters>(EMPTY_SEARCH_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
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
  /** openTarget 이 남기고 loadHistory 가 한 번 쓰고 비운다. */
  const targetRef = useRef<{ channelId: string; messageId: number } | null>(null);
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

  /** ME-DD13 스레드를 열었거나 열린 스레드에 답글이 오면 스레드 읽음 위치를 올린다(참여자가 된다). */
  const markThreadRead = useCallback(async (rootId: number, replies: ChatMessageDto[]) => {
    const last = replies.reduce((max, reply) => Math.max(max, reply.id), 0);
    if (document.visibilityState !== "visible") return;
    const result = await chatRequest<{ unread: UnreadSummary }>("/api/chat/me", { method: "PUT", body: { action: "THREAD_READ", threadRootId: rootId, lastReadReplyId: last } });
    if (result.ok && result.body.unread) setPollUnread(result.body.unread);
  }, [setPollUnread]);

  const markRead = useCallback(async (channelId: string, messages: ChatMessageDto[]) => {
    const last = messages.reduce((max, message) => Math.max(max, message.id), 0);
    if (!last || document.visibilityState !== "visible") return;
    const result = await chatRequest<{ unread: UnreadSummary }>("/api/chat/read-state", { method: "PUT", body: { channelId, lastReadMessageId: last } });
    if (result.ok && result.body.unread) setPollUnread(result.body.unread);
  }, [setPollUnread]);

  const openThreadOf = useCallback(async (root: ChatMessageDto) => {
    const result = await chatRequest<{ root: ChatMessageDto; replies: ChatMessageDto[] }>(`/api/chat/messages?threadRootId=${root.id}`);
    if (!result.ok) { flash(result.body.error ?? "스레드를 불러오지 못했습니다."); return false; }
    setSide(null);
    setThread({ root: result.body.root, replies: result.body.replies });
    void markThreadRead(root.id, result.body.replies);
    return true;
  }, [flash, markThreadRead]);

  /** 최신 구간을 읽는다. targetRef 가 이 채널을 가리키면 대신 그 메시지 주변(around)을 읽고 강조한다(ME-FR-01). */
  const loadHistory = useCallback(async (channelId: string, member: boolean) => {
    let target = targetRef.current?.channelId === channelId ? targetRef.current : null;
    // 다른 채널을 읽는 중에 남긴 이동 요청은 지우지 않는다(그 채널을 열 때 쓴다).
    if (target) targetRef.current = null;
    const base = `/api/chat/messages?channelId=${encodeURIComponent(channelId)}`;
    let result = await chatRequest<HistoryResponse>(target ? `${base}&around=${target.messageId}` : base);
    if (activeRef.current !== channelId) return;
    if (!result.ok && target) {
      // 대상이 지워졌거나 볼 수 없으면 알리고 최신 구간을 연다.
      flash(result.status === 404 ? "메시지를 찾을 수 없습니다." : result.body.error ?? "메시지를 불러오지 못했습니다.");
      target = null;
      result = await chatRequest<HistoryResponse>(base);
      if (activeRef.current !== channelId) return;
    }
    if (!result.ok) { setHistory(EMPTY_HISTORY); flash(result.body.error ?? "대화를 불러오지 못했습니다."); return; }
    const messages = result.body.messages;
    stickToBottom.current = !target;
    setHistory({ messages, hasMore: Boolean(result.body.hasMore), hasNewer: Boolean(result.body.hasNewer), loading: false });
    if (member) void markRead(channelId, messages);
    const focusId = result.body.focusId;
    if (!target || !focusId) return;
    const replyId = result.body.focusReplyId;
    setFocus({ id: focusId, ...(replyId ? { replyId } : {}) });
    window.requestAnimationFrame(() => listRef.current?.querySelector(`[data-message-id="${focusId}"]`)?.scrollIntoView({ block: "center" }));
    const root = messages.find((message) => message.id === focusId);
    if (replyId && root && await openThreadOf(root)) {
      window.requestAnimationFrame(() => document.querySelector(`.chat-thread [data-message-id="${replyId}"]`)?.scrollIntoView({ block: "center" }));
    }
  }, [flash, markRead, openThreadOf]);

  /** 대화를 바꾼다. 스레드·검색 결과를 닫고 기록을 비운다(새 기록은 아래 효과가 읽는다). */
  const selectChannel = useCallback((id: string | null) => {
    setThread(null);
    setFocus(null);
    setResults(null);
    setActivity(null);
    setSavedItems(null);
    setSide(null);
    // 이미 열린 대화를 다시 고르면 기록을 비우지 않는다. activeId 가 그대로라 기록을 읽는 효과가 다시 돌지 않아
    // '불러오는 중'에 멈추기 때문이다(QA 2026-10-01: 새로고침 뒤 빈 대화, 사이드바에서 열린 대화를 다시 누를 때).
    if (id !== activeRef.current) setHistory(id ? { ...EMPTY_HISTORY, loading: true } : EMPTY_HISTORY);
    setActiveId(id);
    if (id) writeScoped(ACTIVE_CHANNEL_KEY, id);
  }, []);

  /** ME-FR-01 메시지로 이동. 검색과 다음 모듈의 활동함·고정·저장됨·파일·토스트가 쓴다. */
  const openTarget = useCallback((channelId: string, messageId: number) => {
    targetRef.current = { channelId, messageId };
    setResults(null);
    setActivity(null);
    setSavedItems(null);
    if (activeRef.current !== channelId) { selectChannel(channelId); return; }
    setThread(null);
    void loadHistory(channelId, joinedRef.current);
  }, [selectChannel, loadHistory]);

  useEffect(() => {
    if (!focus) return;
    const timer = window.setTimeout(() => setFocus(null), FOCUS_MS);
    return () => window.clearTimeout(timer);
  }, [focus]);

  // ME-FR-02: 셸 알림은 지금 열어 둔 대화의 새 글에 소리·토스트를 내지 않는다.
  useEffect(() => { setViewing(activity || results || savedItems ? null : activeId); }, [setViewing, activeId, activity, results, savedItems]);
  useEffect(() => () => setViewing(null), [setViewing]);

  // 셸 토스트에서 온 이동 요청. 목록을 읽은 뒤에 처리한다(처음 마운트 때는 저장해 둔 대화보다 우선한다).
  const loaded = data !== null;
  const openRequest = poll.openRequest;
  useEffect(() => {
    if (!loaded || !openRequest) return;
    let current = true;
    void (async () => {
      await Promise.resolve();
      if (!current) return;
      consumeOpen(openRequest.seq);
      openTarget(openRequest.channelId, openRequest.messageId);
    })();
    return () => { current = false; };
  }, [loaded, openRequest, consumeOpen, openTarget]);

  // ME-FR-10 고정 패널: 열 때와 고정 수가 바뀔 때(channel.updated → 목록 다시 읽기) 다시 읽는다.
  const sideKind = side?.kind ?? null;
  const pinCount = data?.channels.find((channel) => channel.id === activeId)?.pinCount ?? 0;
  useEffect(() => {
    if (sideKind !== "pins" || !activeId) return;
    let alive = true;
    void (async () => {
      const result = await chatRequest<{ pins: ChatPinItem[] }>(`/api/chat/pins?channelId=${encodeURIComponent(activeId)}`);
      if (!alive) return;
      if (!result.ok) { setSide(null); flash(result.body.error ?? "고정 목록을 불러오지 못했습니다."); return; }
      setSide((current) => current?.kind === "pins" ? { kind: "pins", pins: result.body.pins } : current);
    })();
    return () => { alive = false; };
  }, [sideKind, activeId, pinCount, flash]);

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
      // ☆/★ 표시용 저장 id. 첫 대화를 여는 것을 막지 않게 고른 뒤에 읽는다.
      const marks = await chatRequest<{ bookmarks: ChatBookmarkItem[] }>("/api/chat/me?view=bookmarks");
      if (marks.ok && Array.isArray(marks.body.bookmarks)) setBookmarkIds(new Set(marks.body.bookmarks.map((item) => item.message.id)));
    })();
  }, [loadChannels, selectChannel]);

  const activeMember = Boolean(joined);
  useEffect(() => {
    setWatch(activeId && !activeMember ? activeId : null);
    // 참여 여부가 바뀌어도(참여 직후) 기록을 다시 읽는다.
    if (!activeId) return;
    let current = true;
    void (async () => {
      await Promise.resolve();
      if (current) await loadHistory(activeId, activeMember);
    })();
    return () => { current = false; };
  }, [activeId, activeMember, loadHistory, setWatch]);

  useEffect(() => () => setWatch(null), [setWatch]);

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
        if (mode === "replace" || current.hasNewer) return current;
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
  useEffect(() => subscribePoll((events: ChatPollEvent[], meta) => {
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
      const openRoot = threadRef.current?.root.id;
      if (event.kind === "message.created" && openRoot !== undefined && event.message.threadRootId === openRoot) {
        void markThreadRead(openRoot, [...(threadRef.current?.replies ?? []), event.message]);
      }
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
    if (newTopLevel && activeRef.current && joinedRef.current && !historyRef.current.hasNewer) {
      const channelId = activeRef.current;
      const messages = [...historyRef.current.messages, ...events.flatMap((event) => event.message && event.message.threadRootId === null ? [event.message] : [])];
      void markRead(channelId, messages);
    }
  }), [subscribePoll, applyMessage, loadChannels, loadHistory, markRead, markThreadRead, flash, selectChannel]);

  async function loadOlder() {
    if (!activeId || history.loading || !history.hasMore || !history.messages.length) return;
    const list = listRef.current;
    const previousHeight = list?.scrollHeight ?? 0;
    setHistory((current) => ({ ...current, loading: true }));
    const result = await chatRequest<{ messages: ChatMessageDto[]; hasMore: boolean }>(
      `/api/chat/messages?channelId=${encodeURIComponent(activeId)}&before=${history.messages[0].id}`);
    if (!result.ok) { setHistory((current) => ({ ...current, loading: false })); return; }
    stickToBottom.current = false;
    setHistory((current) => ({ ...current, messages: [...result.body.messages, ...current.messages], hasMore: result.body.hasMore, loading: false }));
    window.requestAnimationFrame(() => { if (list) list.scrollTop = list.scrollHeight - previousHeight; });
  }

  /** 이동 뒤 아래로 이어 읽는다. 최신까지 오면 hasNewer 가 풀리고 다시 바닥을 따라간다. */
  async function loadNewer() {
    if (!activeId || history.loading || !history.hasNewer || !history.messages.length) return;
    setHistory((current) => ({ ...current, loading: true }));
    const last = history.messages[history.messages.length - 1].id;
    const result = await chatRequest<{ messages: ChatMessageDto[]; hasNewer: boolean }>(
      `/api/chat/messages?channelId=${encodeURIComponent(activeId)}&after=${last}`);
    if (!result.ok) { setHistory((current) => ({ ...current, loading: false })); return; }
    setHistory((current) => ({
      ...current, messages: [...current.messages, ...result.body.messages.filter((item) => item.id > last)], hasNewer: result.body.hasNewer, loading: false,
    }));
    if (joined) void markRead(activeId, result.body.messages);
  }

  function jumpToLatest() {
    if (!activeId) return;
    setFocus(null);
    void loadHistory(activeId, activeMember);
  }

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    stickToBottom.current = nearBottom && !history.hasNewer;
    if (list.scrollTop < 40) void loadOlder();
    if (nearBottom && history.hasNewer) void loadNewer();
  }

  async function openThread(root: ChatMessageDto) {
    await openThreadOf(root);
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

  /** ME-FR-07 반응 토글. 낙관적으로 바꾸지 않고 서버 DTO 로 교체한다(LAN 이라 지연이 작다). */
  async function reactTo(message: ChatMessageDto, emoji: string) {
    const result = await chatRequest<{ message: ChatMessageDto }>("/api/chat/reactions", { method: "POST", body: { messageId: message.id, emoji } });
    if (!result.ok || !result.body.message) { flash(result.body.error ?? "반응을 남기지 못했습니다."); return; }
    applyMessage(result.body.message, "replace");
  }

  async function setNotifyLevel(level: ChatNotifyLevel) {
    if (!joined) return;
    const result = await chatRequest<{ unread: UnreadSummary }>("/api/chat/me", { method: "PUT", body: { action: "SET_NOTIFY", channelId: joined.id, level } });
    if (!result.ok) { flash(result.body.error ?? "알림 설정을 바꾸지 못했습니다."); return; }
    if (result.body.unread) setPollUnread(result.body.unread);
    await loadChannels();
  }

  async function openActivity() {
    setResults(null);
    setSavedItems(null);
    setThread(null);
    setActivity("loading");
    const result = await chatRequest<{ items: ChatActivityItem[] }>("/api/chat/me?view=activity");
    if (!result.ok) { setActivity(null); flash(result.body.error ?? "활동을 불러오지 못했습니다."); return; }
    setActivity(result.body.items);
  }

  const activityPlace = (item: { channel: ChatActivityItem["channel"] }) => {
    const known = data?.channels.find((channel) => channel.id === item.channel.id);
    if (known) return known.kind === "public" || known.kind === "private" ? `# ${known.name}` : channelLabel(known);
    return item.channel.kind === "public" || item.channel.kind === "private" ? `# ${item.channel.name}` : "1:1·그룹 대화";
  };

  /** ME-FR-11 저장·저장 해제. 저장됨 화면이 열려 있으면 거기서도 뺀다. */
  async function toggleBookmark(message: ChatMessageDto, save: boolean) {
    const result = await chatRequest<{ bookmarked: boolean }>("/api/chat/me", { method: "PUT", body: { action: save ? "BOOKMARK" : "UNBOOKMARK", messageId: message.id } });
    if (!result.ok) { flash(result.body.error ?? "즐겨찾기를 바꾸지 못했습니다."); return; }
    setBookmarkIds((current) => {
      const next = new Set(current);
      if (result.body.bookmarked) next.add(message.id); else next.delete(message.id);
      return next;
    });
    if (!result.body.bookmarked) setSavedItems((current) => Array.isArray(current) ? current.filter((item) => item.message.id !== message.id) : current);
  }

  async function openSaved() {
    setResults(null);
    setActivity(null);
    setThread(null);
    setSavedItems("loading");
    const result = await chatRequest<{ bookmarks: ChatBookmarkItem[] }>("/api/chat/me?view=bookmarks");
    if (!result.ok) { setSavedItems(null); flash(result.body.error ?? "즐겨찾기를 불러오지 못했습니다."); return; }
    setSavedItems(result.body.bookmarks);
    setBookmarkIds(new Set(result.body.bookmarks.map((item) => item.message.id)));
  }

  /** ME-FR-10 고정·해제(소유자·관리자). 목록의 pinCount 는 channel.updated 로도 갱신된다. */
  async function pinMessage(message: ChatMessageDto, pin: boolean) {
    const result = await chatRequest<{ message: ChatMessageDto }>("/api/chat/pins", { method: "POST", body: { action: pin ? "PIN" : "UNPIN", messageId: message.id } });
    if (!result.ok || !result.body.message) { flash(result.body.error ?? "고정하지 못했습니다."); return; }
    applyMessage(result.body.message, "replace");
    await loadChannels();
  }

  function openPins() {
    setThread(null);
    setSide({ kind: "pins", pins: "loading" });
  }

  /** ME-FR-12 파일 패널. more 면 다음 쪽을 붙인다. */
  async function openFiles(more = false) {
    if (!activeId) return;
    const before = more && side?.kind === "files" ? side.nextBefore : null;
    if (!more) setThread(null);
    setSide((current) => more && current?.kind === "files" ? { ...current, loading: true } : { kind: "files", files: [], nextBefore: null, loading: true });
    const query = new URLSearchParams({ channelId: activeId });
    if (before) query.set("before", before);
    const result = await chatRequest<{ files: ChatFileItem[]; nextBefore: string | null }>(`/api/chat/attachments?${query}`);
    if (!result.ok) { setSide(null); flash(result.body.error ?? "파일 목록을 불러오지 못했습니다."); return; }
    setSide((current) => current?.kind === "files"
      ? { kind: "files", files: more ? [...current.files, ...result.body.files] : result.body.files, nextBefore: result.body.nextBefore, loading: false }
      : current);
  }

  async function runSearch() {
    const q = search.trim();
    const filtered = searchFilterCount(filters) > 0;
    if ((!q && !filtered) || (q && (q.length < CHAT_SEARCH_MIN || q.length > CHAT_SEARCH_MAX))) {
      flash(`검색어는 ${CHAT_SEARCH_MIN}~${CHAT_SEARCH_MAX}자로 입력하거나 필터를 골라 주세요.`);
      return;
    }
    const result = await chatRequest<{ results: SearchResult[] }>(`/api/chat/messages?${searchQuery(q, filters)}`);
    if (!result.ok) { flash(result.body.error ?? "검색하지 못했습니다."); return; }
    setActivity(null);
    setSavedItems(null);
    setResults(result.body.results);
  }

  function onSent(message: ChatMessageDto) {
    // 옛 구간을 보다가 새 최상위 글을 보내면 최신 구간으로 돌아간다.
    if (historyRef.current.hasNewer && message.threadRootId === null && activeRef.current) void loadHistory(activeRef.current, true);
    else { stickToBottom.current = true; applyMessage(message, "upsert"); }
    pollNow();
    void offerInvite(message);
  }

  /**
   * 공개 채널에서 멤버가 아닌 사람을 @멘션하면 그 사람은 알림·배지·활동함을 받지 못한다(멤버 채널만 본다).
   * 보낸 직후 "채널에 없어 알림을 받지 못합니다. 초대할까요?"를 묻고, 초대하면 ADD_MEMBERS 로 참여시킨다(Check 단계 결정).
   */
  async function offerInvite(message: ChatMessageDto) {
    const channelId = message.channelId;
    const isPublic = joined?.id === channelId ? joined.kind === "public" : preview?.id === channelId;
    if (!isPublic || !canWrite || !message.mentions.length) return;
    const members = new Set(channelMembers?.channelId === channelId ? channelMembers.ids : []);
    const missing = [...new Set(message.mentions)].filter((id) => id !== accountId && !members.has(id));
    if (!missing.length) return;
    const names = missing.map(nameOf).join(", ");
    const ok = await dialog.confirm(`${names} 님은 이 채널에 없어 알림을 받지 못합니다. 채널에 초대할까요?`, { title: "채널 초대", confirmLabel: "초대" });
    if (!ok) return;
    const result = await channelAction({ action: "ADD_MEMBERS", channelId, accountIds: missing }, "초대하지 못했습니다.");
    if (!result.ok) { flash(result.error); return; }
    setChannelMembers((current) => current?.channelId === channelId ? { channelId, ids: [...current.ids, ...missing] } : current);
    flash(`${names} 님을 초대했습니다.`);
  }

  const activityCount = (poll.unread?.mentions ?? 0) + (poll.unread?.threads ?? 0);
  const canReact = canWrite && Boolean(joined) && !archived;
  const isRoom = joined?.kind === "public" || joined?.kind === "private";
  const searchChannels = [
    ...(data?.channels ?? []).filter((channel) => !channel.archived).map((channel) => ({
      id: channel.id, label: channel.kind === "public" || channel.kind === "private" ? `# ${channel.name}` : channelLabel(channel),
    })),
    ...(data?.joinable ?? []).map((channel) => ({ id: channel.id, label: `# ${channel.name}` })),
  ];
  const filterCount = searchFilterCount(filters);
  const reads = joined ? poll.reads : null;
  /** 1:1 이면 상대, 그룹이면 나를 뺀 멤버(ME-FR-09). */
  const othersOf = (channel: ChatChannelDto) => (channel.dmMemberIds ?? []).filter((id) => id !== accountId);
  const onlineCount = (ids: string[]) => ids.filter((id) => presenceLabel(poll.presence[id]).online).length;
  const dmPresence = joined?.kind === "dm" && othersOf(joined).length === 1 ? presenceLabel(poll.presence[othersOf(joined)[0]]).long : "";
  const unreadOf = (channelId: string) => poll.unread?.channels.find((row) => row.channelId === channelId) ?? null;
  const rooms = data?.channels.filter((channel) => channel.kind === "public" || channel.kind === "private") ?? [];
  const dms = data?.channels.filter((channel) => channel.kind === "dm" || channel.kind === "group_dm") ?? [];
  const managing = joined && (joined.kind === "public" || joined.kind === "private") && (joined.myRole === "owner" || isAdmin) && !archived;
  /** ME-FR-10 고정/해제: 채널 소유자 또는 관리자이고 쓰기 권한이 있을 때(ME-MD5). 서버가 다시 판정한다. */
  const pinAllowed = Boolean(managing) && canWrite;
  const disabledReason = !canWrite ? VIEW_ONLY : archived ? ARCHIVED : null;

  const channelButton = (channel: ChatChannelDto) => {
    const counts = unreadOf(channel.id);
    const label = channelLabel(channel);
    return (
      <li key={channel.id}>
        <button type="button" className={["chat-channel", channel.id === activeId ? "active" : "", channel.archived ? "archived" : "",
          counts?.unread && channel.notifyLevel === "all" ? "unread" : "", channel.notifyLevel === "mute" ? "muted" : ""].filter(Boolean).join(" ")}
          onClick={() => selectChannel(channel.id)}>
          <span className="chat-channel-glyph" aria-hidden="true">{channel.kind === "private" ? "🔒" : channel.kind === "public" ? "#" : "●"}</span>
          <span className="chat-channel-name">{label}</span>
          {channel.kind === "dm" && othersOf(channel).length === 1 && <PresenceDot lastSeen={poll.presence[othersOf(channel)[0]]} />}
          {channel.kind === "group_dm" && onlineCount(othersOf(channel)) > 0 && (
            <span className="chat-presence online" title={`${onlineCount(othersOf(channel))}명 온라인`}>
              <span className="chat-presence-dot" aria-hidden="true" /><small>{onlineCount(othersOf(channel))}</small>
            </span>
          )}
          {channel.notifyLevel === "mute" && <span className="chat-channel-bell" aria-label="음소거">🔕</span>}
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
          <div className="chat-search-row">
            <input type="search" value={search} maxLength={CHAT_SEARCH_MAX} placeholder="메시지·파일 검색" aria-label="메시지 검색"
              onChange={(event) => { setSearch(event.target.value); if (!event.target.value && !filterCount) setResults(null); }} />
            <button type="button" className={filterCount ? "chat-filter-toggle on" : "chat-filter-toggle"} aria-expanded={showFilters}
              aria-label={`검색 필터${filterCount ? ` ${filterCount}개 적용` : ""}`} onClick={() => setShowFilters((open) => !open)}>
              ▾{filterCount ? ` ${filterCount}` : ""}
            </button>
          </div>
          {showFilters && <>
            <SearchFilters filters={filters} channels={searchChannels} people={people} onChange={setFilters} />
            <button type="submit" className="chat-search-submit">검색</button>
          </>}
        </form>
        <ul className="chat-shortcuts">
          <li>
            <button type="button" className={activity ? "chat-channel active" : "chat-channel"} onClick={() => void openActivity()}>
              <span className="chat-channel-glyph" aria-hidden="true">◎</span>
              <span className="chat-channel-name">활동</span>
              {activityCount > 0 && <span className="chat-badge mention" aria-label={`새 활동 ${activityCount}개`}>{activityCount}</span>}
            </button>
          </li>
          <li>
            <button type="button" className={savedItems ? "chat-channel active" : "chat-channel"} onClick={() => void openSaved()}>
              <span className="chat-channel-glyph" aria-hidden="true">☆</span>
              <span className="chat-channel-name">즐겨찾기</span>
            </button>
          </li>
        </ul>
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
        <ChatNotifySettings onNotice={flash} />
      </aside>

      <section className="chat-main" aria-label="대화">
        {activity ? (
          <ActivityPanel items={activity} placeOf={activityPlace} onClose={() => setActivity(null)}
            onOpen={(item) => openTarget(item.channel.id, item.message.id)} />
        ) : savedItems ? (
          <SavedPanel items={savedItems} placeOf={activityPlace} onClose={() => setSavedItems(null)}
            onOpen={(item) => openTarget(item.channel.id, item.message.id)} onRemove={(item) => void toggleBookmark(item.message, false)} />
        ) : results ? (
          <div className="chat-results">
            <header className="chat-header">
              <div><strong>검색 결과</strong><span>{results.length}건 · 최근 50건까지</span></div>
              <button type="button" onClick={() => setResults(null)}>닫기</button>
            </header>
            <div className="chat-list">
              {results.length === 0 && <p className="chat-muted">일치하는 메시지가 없습니다.</p>}
              {results.map((result) => (
                <button type="button" key={result.message.id} className="chat-result" onClick={() => { if (result.channel) openTarget(result.channel.id, result.message.id); else setResults(null); }}>
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
                <strong>
                  {joined ? (joined.kind === "public" ? "# " : joined.kind === "private" ? "🔒 " : "") + channelLabel(joined) : preview ? `# ${preview.name}` : ""}
                  {joined?.kind === "dm" && othersOf(joined).length === 1 && <PresenceDot lastSeen={poll.presence[othersOf(joined)[0]]} withText={false} />}
                </strong>
                <span>
                  {(joined?.topic || preview?.topic) && <>{joined?.topic || preview?.topic} · </>}
                  {dmPresence ? <>{dmPresence} · </> : null}멤버 {joined?.memberCount ?? preview?.memberCount ?? 0}명{archived ? " · 보관됨" : ""}
                </span>
              </div>
              <div className="chat-header-actions">
                {joined && !archived && (
                  <label className="chat-notify-select">
                    <span aria-hidden="true">{joined.notifyLevel === "mute" ? "🔕" : "🔔"}</span>
                    <select value={joined.notifyLevel} aria-label="이 대화의 알림" onChange={(event) => void setNotifyLevel(event.target.value as ChatNotifyLevel)}>
                      {(Object.keys(NOTIFY_LABELS) as ChatNotifyLevel[]).map((level) => <option key={level} value={level}>{NOTIFY_LABELS[level]}</option>)}
                    </select>
                  </label>
                )}
                {preview && <button type="button" className="primary-button" onClick={() => void join(preview.id)}>참여</button>}
                {managing && <button type="button" onClick={() => void rename()}>이름 변경</button>}
                {joined && (joined.kind === "public" || joined.kind === "private") && !archived && canWrite && (
                  <button type="button" onClick={() => openModal({ kind: "members" })}>멤버 관리</button>
                )}
                {isRoom && (
                  <button type="button" className={sideKind === "pins" ? "active" : ""} aria-pressed={sideKind === "pins"} aria-label={`고정된 메시지 ${joined?.pinCount ?? 0}개`}
                    onClick={() => sideKind === "pins" ? setSide(null) : openPins()}>📌{joined?.pinCount ? ` ${joined.pinCount}` : ""}</button>
                )}
                {joined && (
                  <button type="button" className={sideKind === "files" ? "active" : ""} aria-pressed={sideKind === "files"}
                    onClick={() => sideKind === "files" ? setSide(null) : void openFiles()}>📎 파일</button>
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
                    archived={archived} focused={focus?.id === message.id && !focus.replyId} accountId={accountId} canReact={canReact}
                    unreadCount={unreadCountFor(message, reads)} onReact={(emoji) => void reactTo(message, emoji)}
                    canPin={pinAllowed} onPin={(pin) => void pinMessage(message, pin)}
                    bookmarked={bookmarkIds.has(message.id)} onBookmark={(save) => void toggleBookmark(message, save)}
                    onReply={() => void openThread(message)} onEdit={(body) => editMessage(message, body)} onDelete={() => void deleteMessage(message)} />
                ))}
                {history.hasNewer && (
                  <button type="button" className="chat-latest" onClick={jumpToLatest} disabled={history.loading}>최신 메시지로 ↓</button>
                )}
              </div>
              {side?.kind === "pins" && (
                <PinsPanel pins={side.pins} canUnpin={pinAllowed} onClose={() => setSide(null)}
                  onOpen={(item) => openTarget(item.message.channelId, item.message.id)} onUnpin={(item) => void pinMessage(item.message, false)} />
              )}
              {side?.kind === "files" && activeId && (
                <FilesPanel files={side.files} hasMore={side.nextBefore !== null} loading={side.loading} onClose={() => setSide(null)}
                  onMore={() => void openFiles(true)} onOpen={(item) => openTarget(activeId, item.messageId)} />
              )}
              {thread && (
                <aside className="chat-thread" aria-label="스레드">
                  <header><strong>스레드</strong><button type="button" aria-label="스레드 닫기" onClick={() => setThread(null)}>×</button></header>
                  <div className="chat-thread-list">
                    <MessageItem message={thread.root} people={people} mine={thread.root.author.accountId === accountId} canWrite={canWrite} archived={archived}
                      accountId={accountId} canReact={canReact} onReact={(emoji) => void reactTo(thread.root, emoji)}
                      bookmarked={bookmarkIds.has(thread.root.id)} onBookmark={(save) => void toggleBookmark(thread.root, save)}
                      onEdit={(body) => editMessage(thread.root, body)} onDelete={() => void deleteMessage(thread.root)} />
                    <p className="chat-thread-count">답글 {thread.replies.length}개</p>
                    {thread.replies.map((reply) => (
                      <MessageItem key={reply.id} message={reply} people={people} mine={reply.author.accountId === accountId} canWrite={canWrite} archived={archived}
                        focused={focus?.replyId === reply.id} accountId={accountId} canReact={canReact} onReact={(emoji) => void reactTo(reply, emoji)}
                        bookmarked={bookmarkIds.has(reply.id)} onBookmark={(save) => void toggleBookmark(reply, save)}
                        onEdit={(body) => editMessage(reply, body)} onDelete={() => void deleteMessage(reply)} />
                    ))}
                  </div>
                  <Composer channelId={activeId} threadRootId={thread.root.id} placeholder="답글 쓰기" onError={flash} mentionPeople={mentionPeople} mentionChannel={mentionChannel}
                    presence={poll.presence}
                    disabledReason={disabledReason ?? (thread.root.deleted ? "삭제된 메시지에는 답글을 달 수 없습니다." : null)} onSent={onSent} />
                </aside>
              )}
            </div>
            <Composer channelId={activeId} mentionPeople={mentionPeople} mentionChannel={mentionChannel} presence={poll.presence} placeholder={preview ? "보내면 이 채널에 참여합니다" : "메시지 쓰기 (@이름으로 멘션)"} onError={flash}
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
            {modal.kind === "members" && joined && <MembersPanel channel={joined} accountId={accountId} people={people} nameOf={nameOf} presence={poll.presence}
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
function MembersPanel({ channel, accountId, people, nameOf, presence, canRemove, onRemove, selected, onSelect }: {
  channel: ChatChannelDto; accountId: string; people: ChatPerson[]; nameOf: (id: string) => string; presence: Record<string, number>; canRemove: boolean;
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
            <span>{nameOf(id)}{id === accountId ? " (나)" : ""} <PresenceDot lastSeen={presence[id]} self={id === accountId} /></span>
            {canRemove && id !== accountId && <button type="button" className="chat-link-button danger" onClick={() => onRemove(id)}>내보내기</button>}
          </li>
        ))}
      </ul>
    )}
    <span className="chat-modal-label">추가할 사람</span>
    <PeoplePicker people={people} exclude={current.size ? current : new Set([accountId])} selected={selected} onChange={onSelect} />
  </>;
}
