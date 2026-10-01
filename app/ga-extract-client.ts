"use client";

// 총무 AI 자동 채우기의 브라우저 쪽(general-affairs GA-D7). 파일을 AI 가 읽을 수 있는 모양으로 바꾼다.
// - 이미지(png·jpg·gif·webp): 긴 변 1600px 이하 JPEG 로 줄인다.
// - PDF: 글 레이어를 모두 뽑고(최대 20쪽), 앞 3쪽을 그림으로 그린다(스캔 PDF 는 글이 없어 그림으로만 읽힌다).
// 원본 파일 자체는 이 요청으로 보내지 않는다(첨부는 따로 저장된다). 그 밖의 형식은 AI 로 읽지 않는다.
import type { ExtractTarget } from "./ga-extract";

export type ExtractInput = { images: Array<{ mediaType: "image/jpeg"; data: string }>; text: string; fileName: string };
const MAX_SIDE = 1600;
const PDF_IMAGE_PAGES = 3;
const PDF_TEXT_PAGES = 20;

export function extractable(file: File) {
  return /\.(pdf|png|jpe?g|gif|webp)$/i.test(file.name);
}

function canvasJpeg(canvas: HTMLCanvasElement) {
  return canvas.toDataURL("image/jpeg", 0.85).replace(/^data:image\/jpeg;base64,/, "");
}

async function imageInput(file: File) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("이미지를 그리지 못했습니다.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvasJpeg(canvas);
}

async function pdfInput(file: File) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // 워커는 public/ 사본에서 받는다(hr-workspace 의 이력서 읽기와 같은 이유: 개발 서버 변환을 피한다).
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const texts: string[] = [];
  const images: string[] = [];
  for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, PDF_TEXT_PAGES); pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    texts.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    if (pageNumber <= PDF_IMAGE_PAGES) {
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, MAX_SIDE / Math.max(base.width, base.height)) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      images.push(canvasJpeg(canvas));
    }
  }
  return { text: texts.join("\n").trim(), images };
}

export async function fileToExtractInput(file: File): Promise<ExtractInput> {
  if (/\.pdf$/i.test(file.name)) {
    const { text, images } = await pdfInput(file);
    return { text, images: images.map((data) => ({ mediaType: "image/jpeg", data })), fileName: file.name };
  }
  return { text: "", images: [{ mediaType: "image/jpeg", data: await imageInput(file) }], fileName: file.name };
}

/** 서버(/api/general/extract)에 읽혀 화면 필드를 받는다. 실패하면 사용자에게 보일 문구를 던진다. */
/** 이미지 여러 장(간식 주문내역 캡처 등)을 한 번에 읽힌다. 4장까지. */
export async function imagesToExtractInput(files: File[]): Promise<ExtractInput> {
  const images = [];
  for (const file of files.slice(0, 4)) images.push({ mediaType: "image/jpeg" as const, data: await imageInput(file) });
  return { text: "", images, fileName: files.map((file) => file.name).join(", ") };
}

export async function extractFields(target: ExtractTarget, file: File | File[]): Promise<Record<string, unknown>> {
  let input: ExtractInput;
  try { input = Array.isArray(file) ? await imagesToExtractInput(file) : await fileToExtractInput(file); }
  catch { throw new Error("파일을 읽지 못했습니다. 손상되지 않은 PDF·이미지인지 확인해 주세요."); }
  let response: Response;
  try {
    response = await fetch("/api/general/extract", {
      method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, ...input }),
    });
  } catch { throw new Error("서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요."); }
  const body = await response.json().catch(() => ({})) as { fields?: Record<string, unknown>; error?: string };
  if (!response.ok || !body.fields) throw new Error(body.error ?? "AI가 서류를 읽지 못했습니다.");
  return body.fields;
}
