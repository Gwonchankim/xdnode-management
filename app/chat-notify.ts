"use client";

// messenger-enhancement M2 셸 알림(Design §2.2 알림, §5.3, ME-FR-02·03·04·06, DD9·DD11·DD12).
// 셸(page.tsx)이 useChatNotifier 를 한 번 띄운다. 다른 탭에 있어도 셸의 poll 은 살아 있으므로 여기서 소리·토스트·파비콘을 낸다.
// 판정(shouldNotify)은 순수 함수로 두고 node --test 로 표를 검증한다. 소리는 WebAudio 로 합성한다(음원 파일 없음).
// HTTP LAN 에서는 Notification 이 없다(secure context 전용, ME-MD2). 시스템 알림은 localhost 에서만 opt-in 이다.

import { useCallback, useEffect, useRef, useState } from "react";
import { readScoped, writeScoped } from "./client-runtime";
import type { ChatNotifyLevel, ChatPoll, ChatPollEvent, UnreadSummary } from "./chat-client";

export const CHAT_SOUND_KEY = "xdnode-chat-sound";
export const CHAT_SYSTEM_NOTIFY_KEY = "xdnode-chat-system-notify";
export const CHAT_TOAST_MS = 6000;
export const CHAT_TOAST_MAX = 3;
const FAVICON_SOURCE = "/brand/xdnode-favicon-32.png";

type ChannelMeta = Pick<UnreadSummary["channels"][number], "kind" | "name" | "notifyLevel">;
export type ChatToast = {
  key: string; channelId: string; messageId: number;
  author: string; place: string; preview: string; expiresAt: number;
};

/**
 * ME-FR-02·04 알림 대상인가. 표(Design §3.4):
 * - 새 글(message.created)만. 내 글·삭제된 글·지금 보고 있는 대화는 뺀다.
 * - 음소거: 나를 직접 멘션한 글만. 멘션만: 직접 멘션 또는 @channel. 전체: 최상위 글 전부 + 나를 멘션한 답글.
 * - 메타가 없는 대화(멤버가 아닌 공개 채널 미리보기)는 직접 멘션만.
 */
export function shouldNotify(event: ChatPollEvent, context: { me: string; channel: ChannelMeta | undefined; viewingChannelId: string | null }) {
  const message = event.message;
  if (event.kind !== "message.created" || !message || message.deleted) return false;
  if (message.author.accountId === context.me) return false;
  if (context.viewingChannelId !== null && event.channelId === context.viewingChannelId) return false;
  const direct = message.mentions.includes(context.me);
  const level: ChatNotifyLevel | null = context.channel?.notifyLevel ?? null;
  if (level === null || level === "mute") return direct;
  if (level === "mentions") return direct || message.mentionChannel;
  return message.threadRootId === null || direct;
}

export function toastFor(event: ChatPollEvent, channel: ChannelMeta | undefined, now: number): ChatToast | null {
  const message = event.message;
  if (!message) return null;
  const place = !channel ? "채널" : channel.kind === "dm" ? "1:1 대화" : channel.kind === "group_dm" ? "그룹 대화" : `# ${channel.name}`;
  const text = (message.body ?? "").replace(/\s+/g, " ").trim();
  const preview = text ? text.slice(0, 80) : message.attachments.length ? "📎 파일" : "";
  return {
    key: `${message.id}`, channelId: event.channelId, messageId: message.id,
    author: message.author.name, place: message.threadRootId === null ? place : `${place} · 스레드`, preview, expiresAt: now + CHAT_TOAST_MS,
  };
}

// ── 설정(계정 범위 로컬 저장소) ──────────────────────────────────────────────
export function soundEnabled() { return readScoped(CHAT_SOUND_KEY, []) !== "off"; }
export function setSoundEnabled(on: boolean) { writeScoped(CHAT_SOUND_KEY, on ? "on" : "off"); }
export function systemNotifySupported() {
  return typeof window !== "undefined" && window.isSecureContext && "Notification" in window;
}
export function systemNotifyEnabled() {
  return systemNotifySupported() && Notification.permission === "granted" && readScoped(CHAT_SYSTEM_NOTIFY_KEY, []) === "on";
}
export async function setSystemNotify(on: boolean) {
  if (!on) { writeScoped(CHAT_SYSTEM_NOTIFY_KEY, "off"); return false; }
  if (!systemNotifySupported()) return false;
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  writeScoped(CHAT_SYSTEM_NOTIFY_KEY, permission === "granted" ? "on" : "off");
  return permission === "granted";
}

// ── 소리(ME-DD11) ────────────────────────────────────────────────────────────
let audio: AudioContext | null = null;
/** 브라우저 autoplay 정책 때문에 첫 사용자 제스처 때 만든다. */
function primeAudio() {
  try {
    if (!audio) audio = new AudioContext();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    audio = null;
  }
}

/** 짧은 2음(880Hz → 660Hz, 약 180ms). 준비되지 않았으면 조용히 넘어간다. */
export function beep() {
  if (!audio || audio.state !== "running") return;
  const start = audio.currentTime;
  [880, 660].forEach((frequency, index) => {
    const oscillator = audio!.createOscillator();
    const gain = audio!.createGain();
    const at = start + index * 0.09;
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.08, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.085);
    oscillator.connect(gain).connect(audio!.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.09);
  });
}

// ── 파비콘 배지(ME-FR-03, DD12) ──────────────────────────────────────────────
let faviconImage: Promise<HTMLImageElement | null> | null = null;
function loadFavicon() {
  faviconImage ??= new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = FAVICON_SOURCE;
  });
  return faviconImage;
}

export function badgeText(count: number) { return count > 99 ? "99+" : String(count); }

/** 0 이면 원래 아이콘으로 되돌린다. 아이콘 link 가 여러 개(32·64)면 모두 바꾼다. */
export async function setFaviconBadge(count: number) {
  const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
  for (const link of links) link.dataset.xdmOriginal ??= link.href;
  if (count <= 0) {
    for (const link of links) link.href = link.dataset.xdmOriginal ?? link.href;
    return;
  }
  const image = await loadFavicon();
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  if (!context) return;
  if (image) context.drawImage(image, 0, 0, 32, 32);
  const text = badgeText(count);
  context.fillStyle = "#dc2626";
  context.beginPath();
  context.arc(22, 10, 10, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#fff";
  context.font = `bold ${text.length > 2 ? 9 : 13}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 22, 11);
  const href = canvas.toDataURL("image/png");
  for (const link of links) link.href = href;
}

// ── 셸 훅 ─────────────────────────────────────────────────────────────────
/**
 * poll 이벤트마다 shouldNotify 로 거른 뒤, 한 번에 소리 1회·토스트(최대 3)·시스템 알림(창이 숨겨졌을 때)을 낸다.
 * 보고 있는 대화는 채팅 탭이 활성이고 문서가 보일 때만 뺀다. 파비콘은 unread.total(음소거 반영)을 따른다.
 */
export function useChatNotifier({ poll, enabled, accountId, chatActive, onOpen }: {
  poll: ChatPoll; enabled: boolean; accountId: string; chatActive: boolean;
  onOpen: (channelId: string, messageId: number) => void;
}) {
  const [toasts, setToasts] = useState<ChatToast[]>([]);
  const chatActiveRef = useRef(chatActive);
  const onOpenRef = useRef(onOpen);
  const metaRef = useRef(new Map<string, ChannelMeta>());
  useEffect(() => { chatActiveRef.current = chatActive; onOpenRef.current = onOpen; });

  const unread = poll.unread;
  useEffect(() => {
    if (unread) metaRef.current = new Map(unread.channels.map((channel) => [channel.channelId, channel]));
  }, [unread]);

  useEffect(() => {
    if (!enabled) return;
    const prime = () => primeAudio();
    window.addEventListener("pointerdown", prime);
    window.addEventListener("keydown", prime);
    return () => {
      window.removeEventListener("pointerdown", prime);
      window.removeEventListener("keydown", prime);
    };
  }, [enabled]);

  useEffect(() => poll.subscribe((events, meta) => {
    if (!enabled) return;
    if (meta.unread) metaRef.current = new Map(meta.unread.channels.map((channel) => [channel.channelId, channel]));
    const visible = document.visibilityState === "visible";
    const viewingChannelId = chatActiveRef.current && visible ? poll.viewing() : null;
    const now = Date.now();
    const seen = new Set<number>();
    const fresh: ChatToast[] = [];
    for (const event of events) {
      const channel = metaRef.current.get(event.channelId);
      if (!shouldNotify(event, { me: accountId, channel, viewingChannelId })) continue;
      const toast = toastFor(event, channel, now);
      if (!toast || seen.has(toast.messageId)) continue;
      seen.add(toast.messageId);
      fresh.push(toast);
    }
    if (!fresh.length) return;
    if (soundEnabled()) beep();
    setToasts((current) => [...current.filter((item) => !seen.has(item.messageId)), ...fresh].slice(-CHAT_TOAST_MAX));
    if (!visible && systemNotifyEnabled()) {
      for (const toast of fresh.slice(-CHAT_TOAST_MAX)) {
        try {
          const notification = new Notification(`${toast.author} · ${toast.place}`, { body: toast.preview, tag: `xdm-chat-${toast.messageId}` });
          notification.onclick = () => { window.focus(); onOpenRef.current(toast.channelId, toast.messageId); notification.close(); };
        } catch { /* 권한이 막 바뀐 경우 등은 앱 안 토스트로 충분하다 */ }
      }
    }
  }), [poll, enabled, accountId]);

  // 만료된 토스트를 걷는다.
  useEffect(() => {
    if (!toasts.length) return;
    const next = Math.min(...toasts.map((toast) => toast.expiresAt));
    const timer = window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.expiresAt > Date.now())), Math.max(0, next - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  const total = unread?.total ?? 0;
  useEffect(() => {
    if (!enabled) return;
    void setFaviconBadge(total);
  }, [enabled, total]);
  useEffect(() => () => { void setFaviconBadge(0); }, []);

  const dismiss = useCallback((key: string) => setToasts((current) => current.filter((toast) => toast.key !== key)), []);
  return { toasts, dismiss };
}
