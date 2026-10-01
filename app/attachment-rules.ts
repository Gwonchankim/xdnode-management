// 첨부 파일 공용 규칙(메신저 Design §7.8, 총무 general-affairs GD-10). 순수 모듈이다.
// 형식은 서버가 확장자로 정하고 클라이언트 Content-Type 은 무시한다. 표 밖(svg·html·인증서 pfx·p12 등)은 415 다.
// 다운로드는 nosniff·sandbox CSP 이고, 이미지 4종만 inline 이다.

export const ATTACHMENT_MAX_BYTES = 26_214_400;

/** 확장자 → { contentType, inline }. 서버가 정한다. 클라이언트 Content-Type 은 무시한다. 표 밖은 415 다. */
export const ATTACHMENT_TYPES: ReadonlyMap<string, { contentType: string; inline: boolean }> = new Map([
  ["png", { contentType: "image/png", inline: true }],
  ["jpg", { contentType: "image/jpeg", inline: true }],
  ["jpeg", { contentType: "image/jpeg", inline: true }],
  ["gif", { contentType: "image/gif", inline: true }],
  ["webp", { contentType: "image/webp", inline: true }],
  ["pdf", { contentType: "application/pdf", inline: false }],
  ["docx", { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", inline: false }],
  ["xlsx", { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", inline: false }],
  ["pptx", { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", inline: false }],
  ["hwp", { contentType: "application/x-hwp", inline: false }],
  ["hwpx", { contentType: "application/hwp+zip", inline: false }],
  ["txt", { contentType: "text/plain; charset=utf-8", inline: false }],
  ["csv", { contentType: "text/csv; charset=utf-8", inline: false }],
  ["zip", { contentType: "application/zip", inline: false }],
]);

/** 파일 이름 정리: 제어문자·경로 구분자를 빼고 200자에서 자른다. */
export function cleanFileName(value: string) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 200);
}

/** 마지막 확장자(소문자)의 형식. 확장자가 없거나 표 밖이면 null. */
export function attachmentTypeOf(fileName: string) {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return ATTACHMENT_TYPES.get(fileName.slice(dot + 1).toLowerCase()) ?? null;
}

/** RFC 5987 filename*. */
export function contentDisposition(fileName: string, inline: boolean) {
  if (inline) return "inline";
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}

export const CHAT_ATTACHMENT_TYPES = ATTACHMENT_TYPES;

/** 다운로드 응답 헤더. 이미지 4종만 inline, 나머지는 attachment; filename*= 이다. */
export function attachmentDownloadHeaders(fileName: string, contentType: string): Record<string, string> {
  const inline = attachmentTypeOf(fileName)?.inline === true && contentType.startsWith("image/");
  return {
    "Content-Type": contentType,
    "Content-Disposition": contentDisposition(fileName, inline),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  };
}

export type UploadCheck =
  | { ok: true; declared: number; fileName: string; contentType: string }
  | { ok: false; status: 400 | 411 | 413 | 415; code: string; error: string };

/**
 * 본문을 읽기 전 판정(§4.2.8 3~4단계): Content-Length(411·413) → 이름 정리 → 확장자(415) → 빈 파일(400).
 * 읽은 뒤에는 checkUploadedLength 로 실제 길이를 다시 본다.
 */
export function checkUploadRequest(contentLength: string | null, rawName: string): UploadCheck {
  if (!contentLength || !/^\d{1,12}$/.test(contentLength.trim())) return { ok: false, status: 411, code: "LENGTH_REQUIRED", error: "파일 크기를 확인할 수 없습니다." };
  const declared = Number(contentLength.trim());
  if (declared > ATTACHMENT_MAX_BYTES) return { ok: false, status: 413, code: "PAYLOAD_TOO_LARGE", error: "파일은 25MB까지 올릴 수 있습니다." };
  let decoded = rawName;
  try { decoded = decodeURIComponent(rawName); } catch { /* 이미 디코드된 이름 */ }
  const fileName = cleanFileName(decoded);
  const type = fileName ? attachmentTypeOf(fileName) : null;
  if (!type) return { ok: false, status: 415, code: "UNSUPPORTED_MEDIA_TYPE", error: "올릴 수 없는 파일 형식입니다." };
  if (declared === 0) return { ok: false, status: 400, code: "VALIDATION", error: "빈 파일은 올릴 수 없습니다." };
  return { ok: true, declared, fileName, contentType: type.contentType };
}

export function uploadedLengthOk(bytes: ArrayBuffer, declared: number) {
  return bytes.byteLength === declared && bytes.byteLength <= ATTACHMENT_MAX_BYTES;
}
