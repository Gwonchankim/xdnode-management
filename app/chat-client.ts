"use client";

// 메신저 클라이언트(R5, Design §4.2.8 클라이언트·§6.3). 셸(page.tsx)이 useChatPoll 을 한 번 띄워 탭 배지·문서 제목을 맡고,
// 채팅 화면은 subscribe 로 같은 이벤트를 받는다. 서버 모듈은 값으로 import 하지 않는다(타입만).
// 401·403 은 session-client 의 fetch 관찰자가 상태기계에 알린다. 여기서는 403 이면 폴링을 멈추기만 한다.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatChannelDto, ChatEventKind, ChatMessageDto, ChatReadsSnapshot, UnreadSummary } from "./chat-server";

export type {
  ChatActivityItem, ChatAttachmentDto, ChatBookmarkItem, ChatChannelDto, ChatFileItem, ChatMessageDto, ChatNotifyLevel, ChatPinItem, ChatReadsSnapshot, UnreadSummary,
} from "./chat-server";

export const CHAT_POLL_VISIBLE_MS = 2000;
export const CHAT_POLL_IDLE_MS = 15000;
export const CHAT_POLL_BACKOFF_MS = [5000, 10000, 30000] as const;
export const CHAT_MESSAGE_MAX_LENGTH = 4000;
export const CHAT_ATTACHMENT_MAX_BYTES = 26_214_400;
export const CHAT_ATTACHMENTS_PER_MESSAGE = 10;
export const CHAT_SEARCH_MIN = 2;
export const CHAT_SEARCH_MAX = 80;
export const CHAT_GROUP_DM_MAX_OTHERS = 7;
export const CHAT_ALLOWED_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "docx", "xlsx", "pptx", "hwp", "hwpx", "txt", "csv", "zip"] as const;
export const APP_TITLE = "XDnode management";
/** 고정 8개 반응(ME-MD4). chat-server.ts 의 CHAT_REACTIONS 와 같아야 한다(ME-DD16, 테스트로 맞춘다). */
export const CHAT_REACTIONS = ["👍", "✅", "👀", "🙏", "😂", "🎉", "❤️", "😮"] as const;
/** ME-FR-09 온라인 판정: 마지막 poll 이 45초 이내(다른 탭 poll 15초 × 3). */
export const CHAT_PRESENCE_ONLINE_MS = 45_000;
/** 접속 시각이 이만큼 이상 바뀔 때만 화면을 다시 그린다(2초 poll 마다 다시 그리지 않게). */
const PRESENCE_REDRAW_MS = 15_000;

export type ChatPollEvent = { seq: number; kind: ChatEventKind; channelId: string; message?: ChatMessageDto; subjectAccountId?: string };
export type ChatPollResponse = {
  cursor: number; hasMore: boolean; resync?: true; events: ChatPollEvent[]; unread: UnreadSummary | null;
  reads?: ChatReadsSnapshot | null; presence?: Record<string, number>;
};

/**
 * ME-FR-08 읽음 숫자: 현재 멤버 가운데 작성자를 빼고, 글이 올라온 뒤에 들어온 사람(ME-DD8)도 빼고, 아직 이 글까지 읽지 않은 사람 수.
 * 답글·삭제된 글·스냅샷이 다른 채널이면 null(표시하지 않는다, ME-MD10).
 */
export function unreadCountFor(message: ChatMessageDto, reads: ChatReadsSnapshot | null) {
  if (!reads || reads.channelId !== message.channelId || message.threadRootId !== null || message.deleted) return null;
  return reads.members.filter((member) => member.accountId !== message.author.accountId
    && member.joinedAt <= message.createdAt && member.lastReadMessageId < message.id).length;
}

const presenceTime = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" });
const presenceDate = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" });
/** ME-FR-09 접속 표시. short 는 목록용("5분"), long 은 머리·title 용("5분 전 활동"). 기록이 없으면 빈 문자열. */
export function presenceLabel(lastSeen: number | undefined, now = Date.now()) {
  if (lastSeen === undefined) return { online: false, short: "", long: "" };
  const age = Math.max(0, now - lastSeen);
  if (age <= CHAT_PRESENCE_ONLINE_MS) return { online: true, short: "", long: "온라인" };
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) {
    const value = Math.max(1, minutes);
    return { online: false, short: `${value}분`, long: `${value}분 전 활동` };
  }
  const seen = new Date(lastSeen);
  if (seen.toDateString() === new Date(now).toDateString()) {
    return { online: false, short: `${Math.floor(minutes / 60)}시간`, long: `오늘 ${presenceTime.format(seen)} 활동` };
  }
  return { online: false, short: presenceDate.format(seen), long: `${presenceDate.format(seen)} 활동` };
}

function sameReads(a: ChatReadsSnapshot | null, b: ChatReadsSnapshot | null) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function presenceChanged(before: Record<string, number>, after: Record<string, number>) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (before[key] === undefined || after[key] === undefined) return true;
    if (Math.abs(after[key] - before[key]) >= PRESENCE_REDRAW_MS) return true;
  }
  return false;
}
export type ChatPerson = { accountId: string; name: string };
export type ChatChannelsResponse = {
  channels: ChatChannelDto[];
  joinable: Array<{ id: string; name: string; topic: string; memberCount: number }>;
  people: ChatPerson[];
  me: { canWrite: boolean; isAdmin: boolean };
};
export type ChatResult<T> = { ok: boolean; status: number; body: T & { error?: string; code?: string; field?: string } };

export async function chatRequest<T = Record<string, unknown>>(url: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<ChatResult<T>> {
  try {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      cache: "no-store",
      credentials: "same-origin",
      signal: init.signal,
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const body = await response.json().catch(() => ({})) as ChatResult<T>["body"];
    return { ok: response.ok, status: response.status, body: body ?? ({} as ChatResult<T>["body"]) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, status: 0, body: { error: "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." } as ChatResult<T>["body"] };
  }
}

/** 파일 바이트 그대로 올린다(raw PUT). 크기·형식은 서버가 다시 판정한다. */
export async function uploadChatAttachment(channelId: string, file: File) {
  try {
    const response = await fetch(`/api/chat/attachments?channelId=${encodeURIComponent(channelId)}&name=${encodeURIComponent(file.name)}`, {
      method: "PUT", credentials: "same-origin", cache: "no-store", body: file,
      headers: { "Content-Type": "application/octet-stream" },
    });
    const body = await response.json().catch(() => ({})) as { attachment?: import("./chat-server").ChatAttachmentDto; error?: string; code?: string };
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." } as { error: string } };
  }
}

export function chatTitle(unread: number) {
  return unread > 0 ? `(${unread}) ${APP_TITLE}` : APP_TITLE;
}

export function fileExtensionAllowed(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return (CHAT_ALLOWED_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
}

const PASTE_EXTENSIONS: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** 클립보드 이미지는 이름이 'image.png' 뿐이라 '캡처-yyyyMMdd-HHmmss.png' 로 바꾼다. 형식을 모르면 원래 이름(→ 형식 안내)을 둔다. */
export function pastedImageFile(file: File, index = 0, now = new Date()) {
  const extension = PASTE_EXTENSIONS[file.type];
  if (!extension) return file;
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return new File([file], `캡처-${stamp}${index ? `-${index + 1}` : ""}.${extension}`, { type: file.type });
}

/** unread 는 이 응답의 요약(없으면 null)이다. 셸 알림이 같은 응답의 채널 메타로 판정한다(ME-DD10). */
type Listener = (events: ChatPollEvent[], meta: { resync: boolean; unread: UnreadSummary | null }) => void;
/** 셸(토스트)이 채팅 화면에 넘기는 이동 요청(ME-FR-01). seq 로 같은 요청을 두 번 처리하지 않는다. */
export type ChatOpenRequest = { channelId: string; messageId: number; seq: number };

export type ChatPoll = {
  unread: UnreadSummary | null;
  /** 이벤트 구독. 해제 함수를 돌려준다. */
  subscribe: (listener: Listener) => () => void;
  /** 곧바로 한 번 더 폴링한다(본인 전송 직후, summary=1). */
  pollNow: () => void;
  /** 보고 있는 공개 채널(멤버가 아니어도 증분을 받는다). */
  setWatch: (channelId: string | null) => void;
  /** 읽음 위치 PUT 결과처럼 서버가 준 최신 요약으로 바꾼다. */
  setUnread: (unread: UnreadSummary) => void;
  /** 채팅 화면이 지금 열어 둔 대화. 셸 알림은 이 대화의 새 글에 소리·토스트를 내지 않는다(ME-FR-02). */
  setViewing: (channelId: string | null) => void;
  viewing: () => string | null;
  /** 토스트 클릭 → 메신저 탭의 그 메시지로(ME-FR-01). 채팅 화면이 consumeOpen 으로 받는다. */
  openRequest: ChatOpenRequest | null;
  requestOpen: (channelId: string, messageId: number) => void;
  consumeOpen: (seq: number) => void;
  /** ME-FR-08 보고 있는 대화(setViewing) 멤버의 읽음 위치. 멤버가 아니면 null. */
  reads: ChatReadsSnapshot | null;
  /** ME-FR-09 accountId → 마지막 poll 시각. */
  presence: Record<string, number>;
};

/**
 * 폴링(§4.2.8): 채팅 탭이 활성이고 문서가 보이면 2초, 아니면 15초. 오류·5xx 는 5·10·30초 백오프. 요청은 한 번에 하나.
 * 첫 호출·focus·visibilitychange·pollNow 는 곧바로, summary=1 로 부른다. 403 이면 멈춘다(권한이 바뀌면 셸이 다시 마운트한다).
 */
export function useChatPoll({ enabled, chatActive }: { enabled: boolean; chatActive: boolean }): ChatPoll {
  const [unread, setUnreadState] = useState<UnreadSummary | null>(null);
  const [openRequest, setOpenRequest] = useState<ChatOpenRequest | null>(null);
  const openSeq = useRef(0);
  const viewingRef = useRef<string | null>(null);
  const [reads, setReads] = useState<ChatReadsSnapshot | null>(null);
  const [presence, setPresence] = useState<Record<string, number>>({});
  const listeners = useRef(new Set<Listener>());
  const cursor = useRef(0);
  const watch = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const failures = useRef(0);
  const stopped = useRef(false);
  const wantSummary = useRef(true);
  const activeRef = useRef(chatActive);
  const runRef = useRef<() => void>(() => undefined);
  useEffect(() => { activeRef.current = chatActive; }, [chatActive]);

  const schedule = useCallback((delay: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => runRef.current(), delay);
  }, []);

  const interval = () => {
    if (failures.current > 0) return CHAT_POLL_BACKOFF_MS[Math.min(failures.current, CHAT_POLL_BACKOFF_MS.length) - 1];
    return activeRef.current && document.visibilityState === "visible" ? CHAT_POLL_VISIBLE_MS : CHAT_POLL_IDLE_MS;
  };

  const run = async () => {
    if (!enabled || stopped.current || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    const summary = wantSummary.current;
    wantSummary.current = false;
    let again = false;
    try {
      const query = new URLSearchParams({ since: String(cursor.current), summary: summary ? "1" : "0" });
      if (watch.current) query.set("watch", watch.current);
      if (viewingRef.current) query.set("active", viewingRef.current);
      const result = await chatRequest<ChatPollResponse>(`/api/chat/poll?${query}`, { signal: abort.signal });
      if (result.status === 403 || result.status === 401) { stopped.current = true; return; }
      if (!result.ok) { failures.current += 1; return; }
      failures.current = 0;
      const body = result.body;
      const first = cursor.current === 0;
      cursor.current = Number(body.cursor) || 0;
      if (body.unread) setUnreadState(body.unread);
      const nextReads = body.reads ?? null;
      setReads((current) => sameReads(current, nextReads) ? current : nextReads);
      if (body.presence) {
        const nextPresence = body.presence;
        setPresence((current) => presenceChanged(current, nextPresence) ? nextPresence : current);
      }
      if (!first && (body.resync || body.events.length)) {
        for (const listener of listeners.current) listener(body.events, { resync: body.resync === true, unread: body.unread ?? null });
      }
      again = body.hasMore;
    } catch {
      // 중단(AbortError): 언마운트 또는 즉시 폴링으로 교체
    } finally {
      if (controller.current === abort) controller.current = null;
      if (!stopped.current && enabled) schedule(again ? 0 : interval());
    }
  };
  // 타이머가 부르는 함수는 매 렌더의 enabled 를 본다. 렌더 중에 ref 를 쓰지 않도록 효과에서 바꾼다.
  useEffect(() => { runRef.current = () => void run(); });

  const pollNow = useCallback(() => {
    wantSummary.current = true;
    if (controller.current) return;
    schedule(0);
  }, [schedule]);

  useEffect(() => {
    if (!enabled) return;
    stopped.current = false;
    wantSummary.current = true;
    schedule(0);
    const wake = () => { if (document.visibilityState === "visible") pollNow(); };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
      if (timer.current !== null) window.clearTimeout(timer.current);
      controller.current?.abort();
      controller.current = null;
    };
  }, [enabled, pollNow, schedule]);

  // 채팅 탭으로 오가면 주기가 바뀌므로 곧바로 한 번 부른다.
  useEffect(() => { if (enabled) pollNow(); }, [chatActive, enabled, pollNow]);

  // 문서 제목: (N) XDnode management. 채팅 권한이 없으면 제목을 건드리지 않는다.
  const total = unread?.total ?? 0;
  useEffect(() => {
    if (!enabled) return;
    document.title = chatTitle(total);
    return () => { document.title = APP_TITLE; };
  }, [enabled, total]);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);
  const setWatch = useCallback((channelId: string | null) => { watch.current = channelId; }, []);
  const setUnread = useCallback((next: UnreadSummary) => setUnreadState(next), []);
  // 대화를 바꾸면 곧바로 한 번 불러 그 대화의 읽음 위치를 받는다.
  const setViewing = useCallback((channelId: string | null) => {
    if (viewingRef.current === channelId) return;
    viewingRef.current = channelId;
    if (channelId) pollNow();
  }, [pollNow]);
  const viewing = useCallback(() => viewingRef.current, []);
  const requestOpen = useCallback((channelId: string, messageId: number) => {
    openSeq.current += 1;
    setOpenRequest({ channelId, messageId, seq: openSeq.current });
  }, []);
  const consumeOpen = useCallback((seq: number) => setOpenRequest((current) => current?.seq === seq ? null : current), []);

  return { unread, subscribe, pollNow, setWatch, setUnread, setViewing, viewing, openRequest, requestOpen, consumeOpen, reads, presence };
}
