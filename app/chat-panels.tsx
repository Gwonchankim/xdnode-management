"use client";

// messenger-enhancement 패널(Design §5.3·§5.4). M2: 활동함(ME-FR-05)·알림 설정(ME-FR-02·06).
// M4: 고정(ME-FR-10)·파일(ME-FR-12)은 채널 단위라 오른쪽 패널, 저장됨(ME-FR-11)은 대화를 가로지르므로 가운데 영역, 검색 필터(ME-FR-13).
// 본문·이름은 React 텍스트 노드로만 그린다. 항목을 누르면 onOpen → ChatWorkspace.openTarget(ME-FR-01).

import { useState } from "react";
import { fileSize, when } from "./chat-message";
import { beep, primeAudio, setSoundEnabled, setSystemNotify, soundEnabled, systemNotifyEnabled, systemNotifySupported } from "./chat-notify";
import type { ChatActivityItem, ChatBookmarkItem, ChatFileItem, ChatPerson, ChatPinItem } from "./chat-client";

const ACTIVITY_GLYPH: Record<ChatActivityItem["kind"], string> = { mention: "@", channel_mention: "@", thread_reply: "💬" };
const ACTIVITY_LABEL: Record<ChatActivityItem["kind"], string> = { mention: "나를 멘션", channel_mention: "@channel", thread_reply: "스레드 답글" };

export function ActivityPanel({ items, placeOf, onOpen, onClose }: {
  items: ChatActivityItem[] | "loading";
  placeOf: (item: ChatActivityItem) => string;
  onOpen: (item: ChatActivityItem) => void;
  onClose: () => void;
}) {
  return (
    <div className="chat-results">
      <header className="chat-header">
        <div><strong>활동</strong><span>나를 멘션한 글과 참여한 스레드의 답글 · 최근 30일</span></div>
        <button type="button" onClick={onClose}>닫기</button>
      </header>
      <div className="chat-list">
        {items === "loading" && <p className="chat-muted" role="status">불러오는 중…</p>}
        {items !== "loading" && items.length === 0 && <p className="chat-muted">새 활동이 없습니다.</p>}
        {items !== "loading" && items.map((item) => (
          <button type="button" key={`${item.kind}-${item.message.id}`} className={item.unread ? "chat-result chat-activity unread" : "chat-result chat-activity"}
            onClick={() => onOpen(item)}>
            <small>
              <span className="chat-activity-glyph" aria-hidden="true">{ACTIVITY_GLYPH[item.kind]}</span>
              {ACTIVITY_LABEL[item.kind]} · {placeOf(item)}
              {item.unread && <span className="chat-activity-dot" aria-label="안 읽음" />}
            </small>
            <strong>{item.message.author.name}</strong>
            <time>{when(item.message.createdAt)}</time>
            <p>{item.message.body || (item.message.attachments.length ? "📎 파일" : "")}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 사이드바 아래 알림 설정. 값은 계정 범위 로컬 저장소에 둔다(셸 알림이 알림마다 다시 읽는다). */
export function ChatNotifySettings({ onNotice }: { onNotice: (message: string) => void }) {
  const [sound, setSound] = useState(() => soundEnabled());
  const [system, setSystem] = useState(() => systemNotifyEnabled());
  const supported = systemNotifySupported();
  return (
    <section className="chat-settings" aria-label="알림 설정">
      <header><span>알림</span></header>
      <div className="chat-settings-row">
        <label className="chat-inline">
          <input type="checkbox" checked={sound} onChange={(event) => { setSoundEnabled(event.target.checked); setSound(event.target.checked); }} />
          <span>알림음</span>
        </label>
        <button type="button" className="chat-link-button" onClick={async () => {
          primeAudio();
          if (!(await beep())) onNotice("이 브라우저에서 소리를 낼 수 없습니다. 탭의 소리 설정이나 장치 음량을 확인해 주세요.");
        }}>소리 시험</button>
      </div>
      {supported ? (
        <label className="chat-inline">
          <input type="checkbox" checked={system} onChange={async (event) => {
            const on = await setSystemNotify(event.target.checked);
            setSystem(on);
            if (event.target.checked && !on) onNotice("브라우저에서 알림 권한을 허용해야 합니다.");
          }} />
          <span>시스템 알림(창이 숨겨져 있을 때)</span>
        </label>
      ) : (
        <p className="chat-muted">이 PC에서는 앱 안 알림만 사용할 수 있습니다.</p>
      )}
    </section>
  );
}

// ── M4 정보 정리 ─────────────────────────────────────────────────────────────

/** ME-FR-10 오른쪽 고정 패널. 항목을 누르면 그 메시지로 이동한다. */
export function PinsPanel({ pins, canUnpin, onOpen, onUnpin, onClose }: {
  pins: ChatPinItem[] | "loading"; canUnpin: boolean;
  onOpen: (item: ChatPinItem) => void; onUnpin: (item: ChatPinItem) => void; onClose: () => void;
}) {
  return (
    <aside className="chat-thread chat-side-panel" aria-label="고정된 메시지">
      <header><strong>📌 고정된 메시지</strong><button type="button" aria-label="고정 패널 닫기" onClick={onClose}>×</button></header>
      <div className="chat-thread-list">
        {pins === "loading" && <p className="chat-muted" role="status">불러오는 중…</p>}
        {pins !== "loading" && pins.length === 0 && <p className="chat-muted">고정된 메시지가 없습니다.</p>}
        {pins !== "loading" && pins.map((item) => (
          <div key={item.message.id} className="chat-side-item">
            <button type="button" className="chat-side-open" onClick={() => onOpen(item)}>
              <span className="chat-side-meta"><strong>{item.message.author.name}</strong><time>{when(item.message.createdAt)}</time></span>
              <span className="chat-side-body">{item.message.body || (item.message.attachments.length ? "📎 파일" : "")}</span>
              <small>고정: {item.pinnedBy.name} · {when(item.pinnedAt)}</small>
            </button>
            {canUnpin && <button type="button" className="chat-link-button danger" onClick={() => onUnpin(item)}>고정 해제</button>}
          </div>
        ))}
      </div>
    </aside>
  );
}

/** ME-FR-12 오른쪽 파일 패널: 이미지는 썸네일 격자, 나머지는 목록. */
export function FilesPanel({ files, hasMore, loading, onMore, onOpen, onClose }: {
  files: ChatFileItem[]; hasMore: boolean; loading: boolean;
  onMore: () => void; onOpen: (item: ChatFileItem) => void; onClose: () => void;
}) {
  const images = files.filter((item) => item.attachment.isImage);
  const others = files.filter((item) => !item.attachment.isImage);
  return (
    <aside className="chat-thread chat-side-panel" aria-label="파일">
      <header><strong>📎 파일</strong><button type="button" aria-label="파일 패널 닫기" onClick={onClose}>×</button></header>
      <div className="chat-thread-list">
        {loading && !files.length && <p className="chat-muted" role="status">불러오는 중…</p>}
        {!loading && !files.length && <p className="chat-muted">올라온 파일이 없습니다.</p>}
        {images.length > 0 && (
          <div className="chat-file-grid">
            {images.map((item) => (
              <button type="button" key={item.attachment.id} className="chat-file-thumb" title={`${item.attachment.fileName} · ${item.uploaderName}`} onClick={() => onOpen(item)}>
                {/* eslint-disable-next-line @next/next/no-img-element -- 인증 쿠키가 필요한 첨부. 이미지 최적화 경로를 타지 않는다. */}
                <img src={item.attachment.url} alt={item.attachment.fileName} loading="lazy" />
              </button>
            ))}
          </div>
        )}
        {others.map((item) => (
          <div key={item.attachment.id} className="chat-side-item">
            <a className="chat-attachment-file" href={item.attachment.url} rel="noopener noreferrer" download={item.attachment.fileName}>
              <span aria-hidden="true">▤</span>
              <span className="chat-attachment-name">{item.attachment.fileName}</span>
              <small>{fileSize(item.attachment.size)}</small>
            </a>
            <small className="chat-side-caption">{item.uploaderName} · {when(item.createdAt)}</small>
            <button type="button" className="chat-link-button" onClick={() => onOpen(item)}>메시지 보기</button>
          </div>
        ))}
        {hasMore && <button type="button" className="chat-older" onClick={onMore} disabled={loading}>더 보기</button>}
      </div>
    </aside>
  );
}

/** ME-FR-11 즐겨찾기(가운데 영역, 화면 문구는 '즐겨찾기'). */
export function SavedPanel({ items, placeOf, onOpen, onRemove, onClose }: {
  items: ChatBookmarkItem[] | "loading"; placeOf: (item: ChatBookmarkItem) => string;
  onOpen: (item: ChatBookmarkItem) => void; onRemove: (item: ChatBookmarkItem) => void; onClose: () => void;
}) {
  return (
    <div className="chat-results">
      <header className="chat-header">
        <div><strong>즐겨찾기</strong><span>나만 보입니다</span></div>
        <button type="button" onClick={onClose}>닫기</button>
      </header>
      <div className="chat-list">
        {items === "loading" && <p className="chat-muted" role="status">불러오는 중…</p>}
        {items !== "loading" && items.length === 0 && <p className="chat-muted">즐겨찾기한 메시지가 없습니다. 메시지 아래 ☆ 즐겨찾기를 눌러 보세요.</p>}
        {items !== "loading" && items.map((item) => (
          <div key={item.message.id} className="chat-saved-row">
            <button type="button" className="chat-result" onClick={() => onOpen(item)}>
              <small>{placeOf(item)}</small>
              <strong>{item.message.author.name}</strong>
              <time>{when(item.message.createdAt)}</time>
              <p>{item.message.body || (item.message.attachments.length ? "📎 파일" : "")}</p>
            </button>
            <button type="button" className="chat-saved-remove" aria-label="즐겨찾기 해제" onClick={() => onRemove(item)}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export type ChatSearchFilters = { in: string; authorId: string; from: string; to: string; hasFile: boolean };
export const EMPTY_SEARCH_FILTERS: ChatSearchFilters = { in: "", authorId: "", from: "", to: "", hasFile: false };
export function searchFilterCount(filters: ChatSearchFilters) {
  return [filters.in, filters.authorId, filters.from, filters.to].filter(Boolean).length + (filters.hasFile ? 1 : 0);
}
/** 검색 요청 쿼리. 필터가 있으면 검색어 없이도 보낸다(서버가 다시 판정한다). */
export function searchQuery(q: string, filters: ChatSearchFilters) {
  const query = new URLSearchParams({ q });
  if (filters.in) query.set("in", filters.in);
  if (filters.authorId) query.set("authorId", filters.authorId);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.hasFile) query.set("hasFile", "1");
  return query.toString();
}

/** ME-FR-13 검색 필터(검색창 아래 펼침). */
export function SearchFilters({ filters, channels, people, onChange }: {
  filters: ChatSearchFilters; channels: Array<{ id: string; label: string }>; people: ChatPerson[];
  onChange: (next: ChatSearchFilters) => void;
}) {
  const set = (patch: Partial<ChatSearchFilters>) => onChange({ ...filters, ...patch });
  return (
    <fieldset className="chat-search-filters">
      <legend className="chat-sr-only">검색 필터</legend>
      <label><span>대화</span>
        <select value={filters.in} onChange={(event) => set({ in: event.target.value })}>
          <option value="">전체</option>
          {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.label}</option>)}
        </select>
      </label>
      <label><span>보낸 사람</span>
        <select value={filters.authorId} onChange={(event) => set({ authorId: event.target.value })}>
          <option value="">전체</option>
          {people.map((person) => <option key={person.accountId} value={person.accountId}>{person.name}</option>)}
        </select>
      </label>
      <div className="chat-search-dates">
        <label><span>시작일</span><input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => set({ from: event.target.value })} /></label>
        <label><span>종료일</span><input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => set({ to: event.target.value })} /></label>
      </div>
      <label className="chat-inline"><input type="checkbox" checked={filters.hasFile} onChange={(event) => set({ hasFile: event.target.checked })} /><span>첨부 있는 것만</span></label>
      <button type="button" className="chat-link-button" onClick={() => onChange(EMPTY_SEARCH_FILTERS)}>필터 초기화</button>
    </fieldset>
  );
}
