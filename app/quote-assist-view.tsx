"use client";

// 견적 AI 추출 패널(quote-tool Design §10.2 '왼쪽 카드: 메일', QT-FR-13, 옛 index.html tab-mail·doExtract·showAi).
// 고객 메일 본문·담당자 지시문·스크린샷(Ctrl+V 붙여넣기·끌어 놓기·파일 고르기, 4장)을 /api/quote/extract 에 보낸다(편집 권한만, QD-16).
// 스크린샷은 브라우저에서 긴 변 1600px JPEG 로 줄인다(app/ga-extract-client.ts 의 변환 재사용). 원본 파일은 보내지 않는다.
// 결과는 저장하지 않는다. 화면의 견적을 바꿀 뿐이고, 사람이 '생성'을 눌러야 기록된다. 결과 메모(요약·확인 질문·필드별 신뢰도)는 텍스트 노드로만 그린다.
// 구성 추천·비교 변형·상담 서랍은 QT4 에서 이 파일에 더한다.
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { imagesToExtractInput } from "./ga-extract-client";
import { quoteRequest, type ExtractResult, type ExtractionNotes } from "./quote-client";

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
