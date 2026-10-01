import { env } from "cloudflare:workers";
import { authorizeErpRequest, erpError, writeErpAudit } from "../../../erp-platform";
import { EXTRACT_MAX_IMAGE_BASE64, EXTRACT_MAX_IMAGES, EXTRACT_MAX_TEXT, EXTRACT_TARGETS, extractPrompts, normalizeExtracted, type ExtractTarget } from "../../../ga-extract";
import { gaValidation, readBody } from "../../../ga-server";

// general-affairs GA-D7~D9: 서류·영수증 이미지(브라우저가 PDF 를 그림으로 바꾼 것 포함)와 PDF 글을 받아
// 서버 PC 의 Claude 다리(3120 /extract, 도구 모두 끔)에 넘기고, 화면에 채울 필드만 돌려준다. 저장은 하지 않는다.
// 감사에는 대상·이미지 수·채운 칸 수만 남긴다(서류 내용·파일 이름 없음).
const bindings = env as unknown as { DB: D1Database; CLAUDE_BRIDGE_URL?: string };
const db = bindings.DB;
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const payload = await readBody(request);
  if (!payload) return gaValidation("요청 내용을 읽을 수 없습니다.");
  const target = payload.target as ExtractTarget;
  if (!EXTRACT_TARGETS.includes(target)) return gaValidation("인식 대상을 확인해 주세요.", "target");
  const images = Array.isArray(payload.images) ? payload.images : [];
  if (images.length > EXTRACT_MAX_IMAGES) return gaValidation(`이미지는 ${EXTRACT_MAX_IMAGES}장까지 읽습니다.`, "images");
  for (const image of images) {
    const { mediaType, data } = (image ?? {}) as { mediaType?: unknown; data?: unknown };
    if (typeof mediaType !== "string" || !MEDIA_TYPES.has(mediaType) || typeof data !== "string" || !data || data.length > EXTRACT_MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      return gaValidation("이미지를 읽을 수 없습니다. PDF·이미지 파일인지 확인해 주세요.", "images");
    }
  }
  const pdfText = typeof payload.text === "string" ? payload.text.slice(0, EXTRACT_MAX_TEXT) : "";
  if (!images.length && !pdfText.trim()) return gaValidation("읽을 내용이 없습니다. 서류 파일을 골라 주세요.", "images");
  const fileName = typeof payload.fileName === "string" ? payload.fileName : "";
  const { system, prompt, schema } = extractPrompts(target, fileName, pdfText);
  const bridgeUrl = (bindings.CLAUDE_BRIDGE_URL?.trim() || "http://127.0.0.1:3120").replace(/\/+$/, "");
  let content: unknown;
  try {
    const response = await fetch(`${bridgeUrl}/extract`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, prompt, schema, images }), signal: AbortSignal.timeout(300_000),
    });
    const body = await response.json().catch(() => ({})) as { content?: unknown; error?: { message?: string } };
    if (response.status === 429) return erpError(429, "BUSY", "AI가 다른 분석을 하고 있습니다. 잠시 후 다시 눌러 주세요.");
    if (!response.ok) return erpError(502, "AI_UNAVAILABLE", body.error?.message ? `AI가 서류를 읽지 못했습니다: ${body.error.message}` : "AI가 서류를 읽지 못했습니다.");
    content = body.content;
  } catch {
    return erpError(502, "AI_UNAVAILABLE", "AI 다리(서버 PC 의 Claude)에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
  const fields = normalizeExtracted(target, content);
  await writeErpAudit(db, { principal, module: "general", action: "GA_AI_EXTRACTED", entityType: "GA_AI", entityId: target,
    after: { target, images: images.length, textChars: pdfText.length, filled: Object.keys(fields).length } });
  return Response.json({ fields });
}
