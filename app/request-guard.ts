// 교차 출처 판정(Design §7.3). 순수 모듈이고 import가 없다. worker/index.ts 와 서버 가드가 함께 쓴다.
//
// - crossOriginWriteViolation(method, headers): worker 층. /api/* 의 GET·HEAD가 아닌 요청 전부를 핸들러·본문보다 먼저 본다.
//   Origin이 있으면 "null"이 아니고 host가 Host와 같아야 통과한다. Origin이 없으면 Sec-Fetch-Site: same-origin일 때만 통과한다.
//   둘 다 없으면 위반이다(curl·스크립트는 Origin을 붙여야 한다).
// - crossSiteViolation(headers): 가드·인증 라우트 층. 메서드와 무관하다. Origin이 null이거나 host가 다르면 위반,
//   Sec-Fetch-Site가 cross-site·same-site이고 Sec-Fetch-Mode가 navigate가 아니어도 위반이다. 두 헤더가 모두 없으면 통과한다.

type HeaderReader = { get(name: string): string | null };

export const CROSS_ORIGIN_ERROR = { error: "다른 사이트에서 보낸 요청은 처리하지 않습니다.", code: "CROSS_ORIGIN" } as const;

function originMismatch(origin: string, host: string | null) {
  if (origin === "null" || !host) return true;
  try {
    return new URL(origin).host.toLowerCase() !== host.trim().toLowerCase();
  } catch {
    return true;
  }
}

export function crossOriginWriteViolation(method: string, headers: HeaderReader) {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return false;
  const origin = headers.get("origin");
  if (origin !== null) return originMismatch(origin, headers.get("host"));
  return headers.get("sec-fetch-site") !== "same-origin";
}

export function crossSiteViolation(headers: HeaderReader) {
  const origin = headers.get("origin");
  if (origin !== null && originMismatch(origin, headers.get("host"))) return true;
  const site = headers.get("sec-fetch-site");
  if ((site === "cross-site" || site === "same-site") && headers.get("sec-fetch-mode") !== "navigate") return true;
  return false;
}
