"use client";

// 메신저 클라이언트(R5, Design §4.2.8 클라이언트·§6.3). 셸(page.tsx)이 useChatPoll 을 한 번 띄워 탭 배지·문서 제목을 맡고,
// 채팅 화면은 subscribe 로 같은 이벤트를 받는다. 서버 모듈은 값으로 import 하지 않는다(타입만).
// 401·403 은 session-client 의 fetch 관찰자가 상태기계에 알린다. 여기서는 403 이면 폴링을 멈추기만 한다.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatChannelDto, ChatEventKind, ChatMessageDto, UnreadSummary } from "./chat-server";

export type { ChatAttachmentDto, ChatChannelDto, ChatMessageDto, UnreadSummary } from "./chat-server";

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

export type ChatPollEvent = { seq: number; kind: ChatEventKind; channelId: string; message?: ChatMessageDto; subjectAccountId?: string };
export type ChatPollResponse = { cursor: number; hasMore: boolean; resync?: true; events: ChatPollEvent[]; unread: UnreadSummary | null };
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

type Listener = (events: ChatPollEvent[], meta: { resync: boolean }) => void;

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
};

/**
 * 폴링(§4.2.8): 채팅 탭이 활성이고 문서가 보이면 2초, 아니면 15초. 오류·5xx 는 5·10·30초 백오프. 요청은 한 번에 하나.
 * 첫 호출·focus·visibilitychange·pollNow 는 곧바로, summary=1 로 부른다. 403 이면 멈춘다(권한이 바뀌면 셸이 다시 마운트한다).
 */
export function useChatPoll({ enabled, chatActive }: { enabled: boolean; chatActive: boolean }): ChatPoll {
  const [unread, setUnreadState] = useState<UnreadSummary | null>(null);
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
      const result = await chatRequest<ChatPollResponse>(`/api/chat/poll?${query}`, { signal: abort.signal });
      if (result.status === 403 || result.status === 401) { stopped.current = true; return; }
      if (!result.ok) { failures.current += 1; return; }
      failures.current = 0;
      const body = result.body;
      const first = cursor.current === 0;
      cursor.current = Number(body.cursor) || 0;
      if (body.unread) setUnreadState(body.unread);
      if (!first && (body.resync || body.events.length)) {
        for (const listener of listeners.current) listener(body.events, { resync: body.resync === true });
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

  return { unread, subscribe, pollNow, setWatch, setUnread };
}
