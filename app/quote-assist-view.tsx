"use client";

// 견적 AI 추출 패널(quote-tool Design §10.2 '왼쪽 카드: 메일', QT-FR-13, 옛 index.html tab-mail·doExtract·showAi).
// 고객 메일 본문·담당자 지시문·스크린샷(Ctrl+V 붙여넣기·끌어 놓기·파일 고르기, 4장)을 /api/quote/extract 에 보낸다(편집 권한만, QD-16).
// 스크린샷은 브라우저에서 긴 변 1600px JPEG 로 줄인다(app/ga-extract-client.ts 의 변환 재사용). 원본 파일은 보내지 않는다.
// 결과는 저장하지 않는다. 화면의 견적을 바꿀 뿐이고, 사람이 '생성'을 눌러야 기록된다. 결과 메모(요약·확인 질문·필드별 신뢰도)는 텍스트 노드로만 그린다.
// 구성 추천·비교 변형 패널(QuoteRecommendPanel)과 상담 서랍(QuoteChatDrawer)은 QT4 에서 아래에 더했다. 모두 편집 권한 화면에서만 그린다(§10.3).
import { Fragment, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { imagesToExtractInput } from "./ga-extract-client";
import { parseChatMarkdown, type ChatInline } from "./quote-chat-format";
import { quoteRequest, type ChatReply, type ExtractResult, type ExtractionNotes, type RecommendResult, type VariantsResult } from "./quote-client";
import type { Quote, QuoteLine } from "./quote-model";

const MAX_IMAGES = 4;
const MAX_TEXT = 60_000;
const MAX_INSTRUCTION = 2_000;
const CONFIDENCE_LABEL = { high: "높음", medium: "보통", low: "낮음" } as const;

type Shot = { id: number; data: string };
let shotSeq = 0;

export default function QuoteAssistView({ aiAvailable, onExtracted }: {
  aiAvailable: boolean | null;
  /** 추출 결과를 화면 견적에 반영한다. 사용자가 덮어쓰기를 거절하면 false. */
  onExtracted: (result: ExtractResult) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [instruction, setInstruction] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<ExtractionNotes | null>(null);
  const [converting, setConverting] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  async function addFiles(files: File[]) {
    const images = files.filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
    if (!images.length) return;
    const room = MAX_IMAGES - shots.length;
    if (room <= 0) { setError(`스크린샷은 ${MAX_IMAGES}장까지 넣을 수 있습니다.`); return; }
    setConverting(true);
    setError("");
    try {
      const converted = await imagesToExtractInput(images.slice(0, room));
      setShots((current) => [...current, ...converted.images.map((image) => ({ id: (shotSeq += 1), data: image.data }))].slice(0, MAX_IMAGES));
      if (images.length > room) setError(`스크린샷은 ${MAX_IMAGES}장까지 넣을 수 있습니다. 나머지는 넣지 않았습니다.`);
    } catch {
      setError("이미지를 읽지 못했습니다. 다른 스크린샷으로 다시 시도해 주세요.");
    } finally {
      setConverting(false);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLElement>) {
    const files = [...event.clipboardData.items].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  }
  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    void addFiles([...event.dataTransfer.files]);
  }

  async function extract() {
    if (busy) return;
    if (!text.trim() && !shots.length) { setError("메일 본문이나 스크린샷을 넣어 주세요."); return; }
    setBusy(true);
    setElapsed(0);
    setError("");
    const result = await quoteRequest<ExtractResult>("/api/quote/extract", "POST", {
      text, instruction, images: shots.map((shot) => ({ mediaType: "image/jpeg", data: shot.data })),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 429 ? "AI가 다른 요청을 처리하고 있습니다. 잠시 후 다시 눌러 주세요."
        : result.status === 403 ? "AI 추출은 견적 편집 권한이 있어야 쓸 수 있습니다."
          : result.body.error ?? "AI가 견적 내용을 읽지 못했습니다.");
      return;
    }
    if (await onExtracted(result.body)) setNotes(result.body.extraction);
  }

  function clear() {
    setText("");
    setInstruction("");
    setShots([]);
    setError("");
    setNotes(null);
  }

  return (
    <div className="quote-assist" onPaste={onPaste}>
      <label className="quote-label" htmlFor="quote-mail">메일 본문</label>
      <textarea id="quote-mail" rows={8} value={text} maxLength={MAX_TEXT} placeholder={"고객 메일을 붙여 넣으세요.\n예) RTX PRO 6000 Max-Q 2/3/4장 구성 견적 부탁드립니다."}
        onChange={(event) => setText(event.target.value)} />
      <span className="quote-label">스크린샷 <small>(최대 {MAX_IMAGES}장)</small></span>
      {/* 붙여넣기 칸: 눌러서 초점을 둔 뒤 Ctrl+V(붙여넣기는 이 패널 전체가 받는다), 또는 파일을 끌어 놓는다. */}
      <button type="button" className={shots.length ? "quote-paste has" : "quote-paste"} disabled={shots.length >= MAX_IMAGES}
        aria-label="스크린샷 붙여넣기 칸. 누른 뒤 Ctrl+V 로 붙여 넣거나 파일을 끌어 놓으세요."
        onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        {shots.length >= MAX_IMAGES ? `${MAX_IMAGES}장을 모두 넣었습니다` : converting ? "이미지를 줄이는 중…" : "이 칸을 누르고 Ctrl+V · 파일 끌어 놓기"}
      </button>
      {shots.length > 0 && (
        <ul className="quote-shots" aria-label="넣은 스크린샷">
          {shots.map((shot, index) => (
            <li key={shot.id}>
              {/* 브라우저에서 줄인 JPEG(data URL)를 미리 보여 준다. 서버에는 같은 바이트만 간다. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`data:image/jpeg;base64,${shot.data}`} alt={`스크린샷 ${index + 1}`} />
              <button type="button" className="quote-icon-button" aria-label={`스크린샷 ${index + 1} 빼기`} onClick={() => setShots((current) => current.filter((item) => item.id !== shot.id))}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <div className="quote-assist-row">
        <button type="button" className="quote-small" disabled={shots.length >= MAX_IMAGES} onClick={() => fileInput.current?.click()}>파일 고르기</button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden
          onChange={(event) => { void addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
      </div>
      <label className="quote-label" htmlFor="quote-instruction">담당자 지시문 <small>(선택)</small></label>
      <textarea id="quote-instruction" rows={2} value={instruction} maxLength={MAX_INSTRUCTION} placeholder="예: 지난 견적 기준 GPU만 4장으로"
        onChange={(event) => setInstruction(event.target.value)} />
      <div className="quote-assist-row">
        <button type="button" className="primary" disabled={busy || converting} onClick={() => void extract()}>{busy ? "추출 중…" : "AI 추출"}</button>
        <button type="button" className="ghost" disabled={busy} onClick={clear}>비우기</button>
        {aiAvailable === false && <small className="quote-warn-text">AI 다리가 꺼져 있을 수 있습니다.</small>}
      </div>
      {busy && (
        <div className="quote-progress" role="status">
          <div className="bar"><i /></div>
          <span>AI가 읽고 있습니다… {elapsed}초 · 보통 10~20초 걸립니다</span>
        </div>
      )}
      {error && <p className="quote-error" role="alert">{error}</p>}
      {notes && (
        <section className="quote-ai-memo" aria-label="AI 메모">
          {notes.summary && <strong>{notes.summary}</strong>}
          {notes.field_notes.length > 0 && (
            <ul className="quote-field-notes">
              {notes.field_notes.map((note, index) => (
                <li key={index} className={note.confidence}>
                  <span className={`quote-conf ${note.confidence}`}>신뢰도 {CONFIDENCE_LABEL[note.confidence]}</span>
                  <span>{note.field} — {note.source}{note.comment ? ` · ${note.comment}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
          {notes.questions.length > 0 && (
            <div>
              <span className="quote-label">고객 확인 필요</span>
              <ul className="quote-questions">{notes.questions.map((question, index) => <li key={index}>{question}</li>)}</ul>
            </div>
          )}
          <p className="quote-muted">AI 결과는 저장되지 않았습니다. 품목과 단가를 확인한 뒤 생성하세요.</p>
        </section>
      )}
    </div>
  );
}

// ── 구성 추천·비교 변형(QT4, Design §10.2 '구성 추천', 옛 recbox·runRecommend·applyRec·runVariants) ──────────────────────
// 편집 권한 화면에서만 그린다(서버도 RECOMMEND·VARIANTS 를 quote:write 로 막는다). 근거 문구·부품은 텍스트 노드로만 그린다.
// '이 구성 적용'은 그 구성을 세트 줄 하나로, '2/3/4장 비교'는 GPU 장수만 다른 줄 여러 개를 지금 견적 끝에 더한다(단가는 비워 둔다 → 단가 제안이 채운다).

/** 지금 견적의 첫 GPU 상세(카테고리가 GPU·VGA)의 사양 첫 줄. 옛 toggleRec 의 자동 채움. */
export function firstGpuSpec(quote: Pick<Quote, "lines">) {
  for (const line of quote.lines) {
    for (const item of line.items) {
      const category = item.category.trim().toUpperCase();
      if ((category === "GPU" || category === "VGA") && item.spec.trim()) return item.spec.split("\n")[0].trim();
    }
  }
  return "";
}

const intOr = (text: string, fallback: number, max: number) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= max ? value : fallback;
};

export function QuoteRecommendPanel({ draft, room, onAddLines, onClose }: {
  draft: Pick<Quote, "lines">;
  /** 더 넣을 수 있는 줄 수(26줄 상한). */
  room: number;
  onAddLines: (lines: QuoteLine[], message: string) => void;
  onClose: () => void;
}) {
  const [gpu, setGpu] = useState(() => firstGpuSpec(draft));
  const [qty, setQty] = useState("4");
  const [capacity, setCapacity] = useState("4");
  const [busy, setBusy] = useState<"recommend" | "variants" | null>(null);
  const [error, setError] = useState("");
  const [recs, setRecs] = useState<RecommendResult["recommendations"] | null>(null);
  const gpuInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => { gpuInput.current?.focus(); }, []);

  const failMessage = (status: number, body: { error?: string }) => (status === 403 ? "구성 추천은 견적 편집 권한이 있어야 쓸 수 있습니다." : body.error ?? "구성 추천을 불러오지 못했습니다.");

  async function runRecommend() {
    if (busy) return;
    if (!gpu.trim()) { setError("GPU 모델을 입력하세요."); gpuInput.current?.focus(); return; }
    setBusy("recommend");
    setError("");
    const result = await quoteRequest<RecommendResult>("/api/quote/compute", "POST", {
      action: "RECOMMEND", gpu: gpu.trim(), qty: intOr(qty, 1, 64), capacity: intOr(capacity, 1, 64), limit: 4,
    });
    setBusy(null);
    if (!result.ok) { setRecs(null); setError(failMessage(result.status, result.body)); return; }
    setRecs(result.body.recommendations);
    if (!result.body.libraryReady) setError("과거 구성 라이브러리가 아직 이전되지 않았습니다. 관리자에게 알려 주세요.");
  }

  async function runVariants() {
    if (busy) return;
    if (!gpu.trim()) { setError("GPU 모델을 입력하세요."); gpuInput.current?.focus(); return; }
    const cap = intOr(capacity, 4, 64);
    const counts = [2, 3, 4].filter((count) => count <= cap);
    setBusy("variants");
    setError("");
    const result = await quoteRequest<VariantsResult>("/api/quote/compute", "POST", {
      action: "VARIANTS", gpu: gpu.trim(), counts: counts.length ? counts : [Math.min(cap, 16)], capacity: cap,
    });
    setBusy(null);
    if (!result.ok) { setError(failMessage(result.status, result.body)); return; }
    if (!result.body.variants.length) { setError("비교 구성을 만들 수 없습니다. 비슷한 과거 구성이 없습니다."); return; }
    const lines = result.body.variants.map((variant) => ({ ...variant.line, name: `${variant.line.name} (GPU ${variant.gpu_qty}장)` }));
    onAddLines(lines, `GPU ${result.body.variants.map((variant) => variant.gpu_qty).join("/")}장 비교 구성 ${lines.length}줄을 더했습니다.`);
  }

  return (
    <section className="quote-rec" aria-label="구성 추천">
      <header>
        <strong>구성 추천</strong>
        <small className="quote-muted">기술팀이 실제로 견적·납품한 구성을 제안합니다. 호환성이 이미 검증된 조합입니다.</small>
        <button type="button" className="quote-icon-button" aria-label="구성 추천 닫기" onClick={onClose}>×</button>
      </header>
      <form className="quote-rec-form" onSubmit={(event) => { event.preventDefault(); void runRecommend(); }}>
        <label className="quote-field wide"><span>GPU 모델</span>
          <input ref={gpuInput} value={gpu} maxLength={200} placeholder="RTX PRO 6000 Max-Q 96GB" onChange={(event) => setGpu(event.target.value)} />
        </label>
        <label className="quote-field"><span>장수</span>
          <input type="number" min={1} max={64} value={qty} onChange={(event) => setQty(event.target.value)} />
        </label>
        <label className="quote-field"><span>증설 목표</span>
          <input type="number" min={1} max={64} value={capacity} onChange={(event) => setCapacity(event.target.value)} />
        </label>
        <div className="quote-rec-actions">
          <button type="submit" className="quote-small primary" disabled={busy !== null}>{busy === "recommend" ? "찾는 중…" : "과거 구성 찾기"}</button>
          <button type="button" className="quote-small" disabled={busy !== null || room <= 0} title="GPU 장수만 다른 같은 베이스 구성을 각각 견적 줄로 더합니다" onClick={() => void runVariants()}>
            {busy === "variants" ? "만드는 중…" : "2/3/4장 비교"}
          </button>
        </div>
      </form>
      {room <= 0 && <p className="quote-muted">품목 줄이 가득 찼습니다(26줄). 줄을 지운 뒤 적용할 수 있습니다.</p>}
      {error && <p className="quote-error" role="alert">{error}</p>}
      {recs && !recs.length && !error && <p className="quote-muted">비슷한 과거 구성을 찾지 못했습니다.</p>}
      {recs && recs.length > 0 && (
        <ul className="quote-rec-list">
          {recs.map((rec, index) => (
            <li key={`${rec.date ?? ""}-${index}`} className="quote-rec-card">
              <div className="quote-rec-top">
                <span className="quote-chip confirmed">{rec.base_max_gpu}장까지 검증</span>
                <strong>{rec.system_name || rec.parts[0]?.name || "구성"}</strong>
                <small className="quote-muted">{rec.date ?? ""}{rec.customer ? ` · ${rec.customer}` : ""}</small>
                <button type="button" className="quote-small primary" disabled={room <= 0} onClick={() => onAddLines([rec.line], "구성 1줄을 더했습니다. 단가를 확인하세요.")}>이 구성 적용</button>
              </div>
              <p className="quote-rec-evidence">{rec.evidence}</p>
              <dl className="quote-rec-parts">
                {rec.parts.map((part, partIndex) => (
                  <div key={`${part.slot}-${partIndex}`}><dt>{part.category}</dt><dd>{part.name} ×{part.qty ?? 1}</dd></div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── 상담 서랍(QT4, Design §10.2 '상담', 옛 FAB·chat·sendChat·md) ─────────────────────────────────────────────
// 오른쪽 아래 단추(또는 Alt+C)로 연다. 지금 화면의 견적을 서버에 보내면 서버가 문맥을 만들어 AI 에게 묻는다(웹 검색 없음, QT-D3).
// 대화는 이 화면 메모리에만 있다(무상태, 서버에 저장하지 않는다). 답은 작은 마크다운을 React 노드로만 그린다:
// HTML 문자열을 주입하지 않고, 링크는 http(s) 주소만 새 창 + rel="noopener noreferrer" 로 연다(app/quote-chat-format.ts, 옛 S8 소멸).

type ChatEntry = { role: "user" | "assistant"; content: string; meta?: string; error?: boolean };
const CHAT_MAX_QUESTION = 2_000;
const CHAT_SAMPLES = [
  "이 구성에 RTX PRO 5500 써도 되나요?", "이 구성에 맞는 파워서플라이를 추천해 주세요", "전체 소비전력이 얼마나 되나요?",
  "메모리를 늘리려면 몇 개까지 가능한가요?", "이 견적에서 빠진 부품이 있나요?",
];
// 탭을 옮겨도 대화가 남게 모듈에 둔다(다른 계정이면 쓰지 않는다). 새로고침하면 사라진다.
let chatMemory: { accountId: string; entries: ChatEntry[] } | null = null;

function InlineNodes({ parts }: { parts: ChatInline[] }) {
  return (
    <>
      {parts.map((part, index) => {
        if (part.kind === "strong") return <strong key={index}>{part.text}</strong>;
        if (part.kind === "code") return <code key={index}>{part.text}</code>;
        if (part.kind === "link") return <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>;
        return <Fragment key={index}>{part.text}</Fragment>;
      })}
    </>
  );
}

/** 상담 답 마크다운 → React 노드(HTML 주입 없음). */
export function ChatMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseChatMarkdown(text), [text]);
  return (
    <div className="quote-md">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading": return <p key={index} className="quote-md-heading"><strong><InlineNodes parts={block.inline} /></strong></p>;
          case "list": return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><InlineNodes parts={item} /></li>)}</ul>;
          case "code": return <pre key={index}><code>{block.text}</code></pre>;
          case "table": return (
            <div key={index} className="quote-md-table">
              <table>
                <thead><tr>{block.head.map((cell, cellIndex) => <th key={cellIndex}><InlineNodes parts={cell} /></th>)}</tr></thead>
                <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><InlineNodes parts={cell} /></td>)}</tr>)}</tbody>
              </table>
            </div>
          );
          default: return <p key={index}>{block.lines.map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}<InlineNodes parts={line} /></Fragment>)}</p>;
        }
      })}
    </div>
  );
}

export function QuoteChatDrawer({ open, onToggle, draft, accountId }: {
  open: boolean;
  onToggle: () => void;
  draft: Quote;
  accountId: string;
}) {
  const [entries, setEntries] = useState<ChatEntry[]>(() => (chatMemory?.accountId === accountId ? chatMemory.entries : []));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const elapsedRef = useRef(0);
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; });
  useEffect(() => { chatMemory = { accountId, entries }; }, [accountId, entries]);
  useEffect(() => { if (open) window.setTimeout(() => inputRef.current?.focus(), 0); }, [open]);
  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }); }, [entries, busy, open]);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    elapsedRef.current = 0;
    const timer = window.setInterval(() => {
      elapsedRef.current = Math.round((Date.now() - started) / 1000);
      setElapsed(elapsedRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  // 서랍 안에 초점이 있을 때 Esc 로 닫는다.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drawerRef.current?.contains(document.activeElement)) onToggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onToggle]);

  const lines = draft.lines.length;
  const parts = draft.lines.reduce((sum, line) => sum + line.items.length, 0);
  const context = lines ? `${draft.customer.org.trim() || "기관 미입력"} · ${lines}개 줄 · 부품 ${parts}종` : "품목 없음";
  const asked = entries.filter((entry) => entry.role === "user").length;

  async function send(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    if (Array.from(text).length > CHAT_MAX_QUESTION) return;
    const history = [...entries, { role: "user" as const, content: text }];
    setEntries(history);
    setInput("");
    setBusy(true);
    setElapsed(0);
    const quote = { ...draftRef.current, margin: null };
    const result = await quoteRequest<ChatReply>("/api/quote/chat", "POST", {
      quote,
      // 오류 안내는 대화로 보내지 않는다.
      messages: history.filter((entry) => !entry.error).map(({ role, content }) => ({ role, content })),
    });
    const seconds = Math.max(1, elapsedRef.current);
    setBusy(false);
    if (result.ok && typeof result.body.reply === "string") {
      setEntries((current) => [...current, { role: "assistant", content: result.body.reply, meta: `${seconds}초` }]);
    } else {
      const message = result.status === 429 ? "AI가 다른 요청을 처리하고 있습니다. 잠시 후 다시 물어 주세요."
        : result.status === 403 ? "상담은 견적 편집 권한이 있어야 쓸 수 있습니다."
          : result.body.error ?? "응답을 받지 못했습니다.";
      setEntries((current) => [...current, { role: "assistant", content: message, error: true }]);
    }
  }

  function clear() {
    if (busy) return;
    setEntries([]);
    inputRef.current?.focus();
  }

  return (
    <>
      <button type="button" className={open ? "quote-fab open" : "quote-fab"} onClick={onToggle}
        title={open ? "상담 창 닫기 (Alt+C)" : asked ? `견적 상담 · 이전 대화 ${asked}건 (Alt+C)` : "견적 상담 (Alt+C)"}
        aria-label={open ? "견적 상담 닫기" : "견적 상담 열기"} aria-expanded={open} aria-controls="quote-chat-drawer">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.9-.9L3 20.5l1.6-4.8A8.4 8.4 0 0 1 3.6 11 8.4 8.4 0 0 1 12 2.6a8.4 8.4 0 0 1 9 8.9z" />
        </svg>
        {!open && asked > 0 && <span className="quote-fab-badge">{asked > 9 ? "9+" : asked}</span>}
      </button>
      <section id="quote-chat-drawer" ref={drawerRef} className="quote-chat" hidden={!open} aria-label="견적 상담">
        <header>
          <strong>견적 상담</strong>
          <small>{context}</small>
          <span className="spacer" />
          <button type="button" className="quote-small ghost" disabled={busy || !entries.length} title="지금까지의 대화를 지우고 새로 시작합니다" onClick={clear}>비우기</button>
          <button type="button" className="quote-icon-button" aria-label="닫기" onClick={onToggle}>×</button>
        </header>
        <div className="quote-chat-body" ref={bodyRef} aria-live="polite">
          {!entries.length ? (
            <div className="quote-chat-hint">
              <p>지금 화면의 견적과 우리 카탈로그·과거 구성을 읽고 답합니다. 호환성 확인, 부품 추천, 전력 계산에 쓰세요.</p>
              <p className="quote-muted">웹 검색은 하지 않습니다. 대화는 저장되지 않고 이 화면에만 남습니다.</p>
              <div className="quote-chat-chips">
                {CHAT_SAMPLES.map((sample) => <button key={sample} type="button" disabled={busy} onClick={() => void send(sample)}>{sample}</button>)}
              </div>
            </div>
          ) : entries.map((entry, index) => (entry.role === "user"
            ? <div key={index} className="quote-chat-msg user">{entry.content}</div>
            : (
              <div key={index} className={entry.error ? "quote-chat-msg assistant error" : "quote-chat-msg assistant"}>
                {entry.error ? <p role="alert">{entry.content}</p> : <ChatMarkdown text={entry.content} />}
                {entry.meta && <small>{entry.meta}</small>}
              </div>
            )))}
          {busy && <div className="quote-chat-thinking" role="status"><i aria-hidden="true" /> 생각 중… {elapsed}초</div>}
        </div>
        <form className="quote-chat-foot" onSubmit={(event) => { event.preventDefault(); void send(input); }}>
          <textarea ref={inputRef} rows={2} value={input} maxLength={CHAT_MAX_QUESTION} aria-label="질문"
            placeholder="예) 이 구성에 PRO 5500 써도 되나요?  (Enter 전송, Shift+Enter 줄바꿈)"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // 한글 조합 중 Enter 는 글자 확정이다(보내지 않는다).
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input); }
            }} />
          <button type="submit" className="primary" disabled={busy || !input.trim()}>전송</button>
        </form>
      </section>
    </>
  );
}
