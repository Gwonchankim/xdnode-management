import { env } from "cloudflare:workers";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { ensureHrTranscriptionSchema, type HrTranscriptionEntityType } from "../../../hr-transcriptions";

type Bindings = {
  DB: D1Database; HR_AUDIO: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string; CLOUDFLARE_TRANSCRIPTION_MODEL?: string;
};
type SourceAudio = { audio_key: string; audio_content_type: string };
type Envelope = { success?: boolean; errors?: Array<{ code?: number; message?: string }>; result?: unknown };
type JobRow = {
  id: string; entity_type: HrTranscriptionEntityType; entity_id: string; status: string; model: string; language: string;
  transcript: string; vtt: string; word_count: number; error_code: string; error_message: string; attempt: number;
  requested_by: string; requested_at: number; completed_at: number | null; reviewed_text: string; review_note: string;
  reviewed_by: string; reviewed_at: number | null; created_at: number; updated_at: number;
};

const bindings = env as unknown as Bindings;
const modelDefault = "@cf/openai/whisper-large-v3-turbo";
// 감사 module 에만 쓴다. 인가는 두 대상 모두 같은 hr 탭이라 리터럴 hr 로 먼저 한다(Design §4.3.2, 부록 B #27).
const entityModules: Record<HrTranscriptionEntityType, "hr" | "recruitment"> = { EMPLOYEE_INTERVIEW: "hr", APPLICANT_INTERVIEW: "recruitment" };

function isEntityType(value: string): value is HrTranscriptionEntityType { return value === "EMPLOYEE_INTERVIEW" || value === "APPLICANT_INTERVIEW"; }
function toJob(row: JobRow | null) { return row ? {
  id: row.id, entityType: row.entity_type, entityId: row.entity_id, status: row.status, model: row.model, language: row.language,
  transcript: row.transcript, vtt: row.vtt, wordCount: row.word_count, errorCode: row.error_code, errorMessage: row.error_message,
  attempt: row.attempt, requestedBy: row.requested_by, requestedAt: row.requested_at, completedAt: row.completed_at,
  reviewedText: row.reviewed_text, reviewNote: row.review_note, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at,
  createdAt: row.created_at, updatedAt: row.updated_at,
} : null; }
function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer); let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function providerError(data: Envelope | null) { return data?.errors?.map((item) => item.message).filter(Boolean).join(" ") || ""; }
function isQuota(response: Response, data: Envelope | null) { return response.status === 429 || /quota|limit|neuron|exceeded/i.test(providerError(data)); }
async function responseJson(response: Response) { try { return await response.json() as Envelope; } catch { return null; } }
function normalizeResult(value: unknown) {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const info = result.transcription_info && typeof result.transcription_info === "object" ? result.transcription_info as Record<string, unknown> : result;
  const transcript = typeof info.text === "string" ? info.text.trim() : typeof result.text === "string" ? result.text.trim() : "";
  const wordCount = Number(info.word_count ?? result.word_count ?? (transcript ? transcript.split(/\s+/).length : 0));
  const vtt = typeof result.vtt === "string" ? result.vtt : typeof info.vtt === "string" ? info.vtt : "";
  return { transcript: transcript.slice(0, 100_000), wordCount: Number.isFinite(wordCount) ? Math.max(0, Math.round(wordCount)) : 0, vtt: vtt.slice(0, 200_000) };
}
async function sourceAudio(entityType: HrTranscriptionEntityType, entityId: string) {
  if (entityType === "EMPLOYEE_INTERVIEW") return bindings.DB.prepare("SELECT audio_key, audio_content_type FROM employee_interview_records WHERE id = ?").bind(entityId).first<SourceAudio>();
  return bindings.DB.prepare("SELECT audio_key, audio_content_type FROM applicant_interview_recordings WHERE id = ?").bind(entityId).first<SourceAudio>();
}
async function latestJob(entityType: HrTranscriptionEntityType, entityId: string) {
  return bindings.DB.prepare("SELECT * FROM hr_audio_transcriptions WHERE entity_type = ? AND entity_id = ? ORDER BY attempt DESC LIMIT 1")
    .bind(entityType, entityId).first<JobRow>();
}
async function failJob(id: string, status: "FAILED" | "QUOTA_EXCEEDED", code: string, message: string) {
  await bindings.DB.prepare("UPDATE hr_audio_transcriptions SET status = ?, error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'PROCESSING'")
    .bind(status, code, message.slice(0, 500), Date.now(), Date.now(), id).run();
}

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(bindings.DB, "hr", "read"); if (authorization.response) return authorization.response;
  await ensureHrTranscriptionSchema(bindings.DB);
  const url = new URL(request.url); const entityType = String(url.searchParams.get("entityType") ?? ""); const entityId = String(url.searchParams.get("entityId") ?? "").trim();
  if (!isEntityType(entityType) || !entityId) return Response.json({ error: "전사 대상 유형과 식별자가 필요합니다." }, { status: 400 });
  return Response.json({ job: toJob(await latestJob(entityType, entityId)) });
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(bindings.DB, "hr", "write"); if (authorization.response) return authorization.response;
  await ensureHrTranscriptionSchema(bindings.DB);
  let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: "요청 내용을 읽을 수 없습니다." }, { status: 400 }); }
  if (!body || typeof body !== "object") return Response.json({ error: "요청 내용을 읽을 수 없습니다." }, { status: 400 });
  const action = String(body.action ?? ""); const entityType = String(body.entityType ?? ""); const entityId = String(body.entityId ?? "").trim();
  if (!isEntityType(entityType)) return Response.json({ error: "지원하지 않는 전사 대상입니다." }, { status: 400 });

  if (action === "REVIEW") {
    const transcriptionId = String(body.transcriptionId ?? ""); const reviewedText = String(body.reviewedText ?? "").trim().slice(0, 100_000);
    const reviewNote = String(body.reviewNote ?? "").trim().slice(0, 1000);
    if (!transcriptionId || reviewedText.length < 2) return Response.json({ error: "검토할 전사문을 2자 이상 입력해 주세요." }, { status: 400 });
    const result = await bindings.DB.prepare(`UPDATE hr_audio_transcriptions SET reviewed_text = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ? AND entity_type = ? AND entity_id = ? AND status = 'COMPLETED' AND reviewed_at IS NULL`)
      .bind(reviewedText, reviewNote, authorization.principal.employeeId, Date.now(), Date.now(), transcriptionId, entityType, entityId).run();
    if ((result.meta.changes ?? 0) !== 1) return Response.json({ error: "완료된 미검토 전사본만 한 번 확정할 수 있습니다. 다시 전사하면 새 시도가 보존됩니다." }, { status: 409 });
    await writeErpAudit(bindings.DB, { principal: authorization.principal, module: entityModules[entityType], action: "HR_AUDIO_TRANSCRIPTION_REVIEWED",
      entityType: "hrAudioTranscription", entityId: transcriptionId, after: { sourceEntityType: entityType, sourceEntityId: entityId, reviewNote, characterCount: reviewedText.length } });
    return Response.json({ job: toJob(await latestJob(entityType, entityId)) });
  }

  if (action !== "TRANSCRIBE" || body.consentConfirmed !== true) return Response.json({ error: "AI 전사를 위해 녹음 당사자 동의와 외부 AI 전송 확인이 필요합니다." }, { status: 400 });
  const accountId = bindings.CLOUDFLARE_ACCOUNT_ID?.trim(); const apiToken = bindings.CLOUDFLARE_API_TOKEN?.trim();
  const model = bindings.CLOUDFLARE_TRANSCRIPTION_MODEL?.trim() || modelDefault;
  if (!accountId || !apiToken) return Response.json({ error: "Workers AI 전사 환경설정이 완료되지 않았습니다." }, { status: 503 });
  const source = await sourceAudio(entityType, entityId); if (!source?.audio_key) return Response.json({ error: "전사할 저장 녹음을 찾을 수 없습니다." }, { status: 404 });
  const previous = await latestJob(entityType, entityId); const now = Date.now();
  if (previous?.status === "PROCESSING" && now - previous.updated_at < 10 * 60 * 1000) return Response.json({ error: "이미 전사가 진행 중입니다." }, { status: 409 });
  if (previous?.status === "COMPLETED" && body.force !== true) return Response.json({ error: "완료된 전사가 있습니다. 재전사는 명시적으로 다시 시도해 주세요." }, { status: 409 });
  if (previous?.status === "PROCESSING") await failJob(previous.id, "FAILED", "STALE_PROCESSING", "이전 전사 요청이 제한 시간 내 완료되지 않았습니다.");

  const id = crypto.randomUUID(); const attempt = Number(previous?.attempt ?? 0) + 1;
  await bindings.DB.prepare(`INSERT INTO hr_audio_transcriptions
    (id, entity_type, entity_id, audio_key_snapshot, audio_content_type, status, model, language, transcript, vtt, word_count,
      error_code, error_message, attempt, consent_confirmed_by, consent_confirmed_at, requested_by, requested_at, completed_at,
      reviewed_text, review_note, reviewed_by, reviewed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'PROCESSING', ?, 'ko', '', '', 0, '', '', ?, ?, ?, ?, ?, NULL, '', '', '', NULL, ?, ?)`)
    .bind(id, entityType, entityId, source.audio_key, source.audio_content_type || "audio/webm", model, attempt,
      authorization.principal.employeeId, now, authorization.principal.employeeId, now, now, now).run();

  const audio = await bindings.HR_AUDIO.get(source.audio_key);
  if (!audio) { await failJob(id, "FAILED", "AUDIO_NOT_FOUND", "R2에서 녹음 원본을 찾을 수 없습니다."); return Response.json({ error: "녹음 원본을 찾을 수 없습니다." }, { status: 404 }); }
  if (audio.size > 10 * 1024 * 1024) { await failJob(id, "FAILED", "AUDIO_TOO_LARGE", "서버 전사는 10MB 이하 녹음만 지원합니다."); return Response.json({ error: "서버 AI 전사는 10MB 이하 녹음만 지원합니다. 녹음을 나누어 저장해 주세요." }, { status: 413 }); }

  let providerResponse: Response;
  try {
    providerResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`, {
      method: "POST", headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ audio: arrayBufferToBase64(await audio.arrayBuffer()), task: "transcribe", language: "ko", vad_filter: true,
        condition_on_previous_text: true, initial_prompt: "한국어 기업 면담 및 채용 면접 녹음입니다. 인명과 회사 고유명사는 들리는 사실만 전사하세요." }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError" ? "AI 전사 시간이 초과되었습니다." : "Workers AI 전사 서비스에 연결할 수 없습니다.";
    await failJob(id, "FAILED", error instanceof Error ? error.name : "PROVIDER_UNAVAILABLE", message); return Response.json({ error: message }, { status: 502 });
  }
  const data = await responseJson(providerResponse);
  if (isQuota(providerResponse, data)) { await failJob(id, "QUOTA_EXCEEDED", "QUOTA_EXCEEDED", "오늘의 Workers AI 무료 사용 한도를 초과했습니다."); return Response.json({ error: "오늘의 Workers AI 무료 사용 한도를 초과했습니다.", quotaExceeded: true }, { status: 429 }); }
  if (!providerResponse.ok || data?.success === false || !data) {
    await failJob(id, "FAILED", `HTTP_${providerResponse.status}`, providerError(data) || "Workers AI 전사 요청에 실패했습니다.");
    return Response.json({ error: "Workers AI 전사 요청에 실패했습니다." }, { status: 502 });
  }
  const normalized = normalizeResult(data.result);
  if (!normalized.transcript) { await failJob(id, "FAILED", "EMPTY_TRANSCRIPT", "음성에서 전사 가능한 발화를 찾지 못했습니다."); return Response.json({ error: "음성에서 전사 가능한 발화를 찾지 못했습니다." }, { status: 422 }); }
  await bindings.DB.prepare(`UPDATE hr_audio_transcriptions SET status = 'COMPLETED', transcript = ?, vtt = ?, word_count = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'PROCESSING'`)
    .bind(normalized.transcript, normalized.vtt, normalized.wordCount, Date.now(), Date.now(), id).run();
  await writeErpAudit(bindings.DB, { principal: authorization.principal, module: entityModules[entityType], action: "HR_AUDIO_TRANSCRIBED",
    entityType: "hrAudioTranscription", entityId: id, after: { sourceEntityType: entityType, sourceEntityId: entityId, model, attempt, wordCount: normalized.wordCount } });
  return Response.json({ job: toJob(await latestJob(entityType, entityId)) }, { status: 201 });
}
