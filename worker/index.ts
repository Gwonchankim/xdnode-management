/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { crossOriginWriteViolation, CROSS_ORIGIN_ERROR } from "../app/request-guard";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const isApiPath = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");

/**
 * Design §7.7: 두 분기(/_vinext/image, 앱 핸들러)와 CSRF 거부 응답이 모두 이 마무리를 거친다.
 * 라우트가 정한 Cache-Control·Content-Security-Policy·Content-Disposition 은 덮어쓰지 않는다.
 * new Headers(response.headers) 는 Set-Cookie 여러 개를 그대로 복사한다.
 */
function finalize(pathname: string, response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Permissions-Policy", "microphone=(self)");
  headers.set("Feature-Policy", "microphone 'self'");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "same-origin");
  if (isApiPath(pathname) && !headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Design §7.3: /api/* 의 GET·HEAD가 아닌 요청은 핸들러와 본문 읽기보다 먼저 교차 출처를 검사한다(DB 없이 거부).
    if (isApiPath(url.pathname) && crossOriginWriteViolation(request.method, request.headers)) {
      return finalize(url.pathname, Response.json(CROSS_ORIGIN_ERROR, { status: 403 }));
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return finalize(url.pathname, await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths));
    }

    return finalize(url.pathname, await handler.fetch(request, env, ctx));
  },
};

export default worker;
