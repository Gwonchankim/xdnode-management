// 견적 xlsx 템플릿(quote-tool Design §5.1·§5.9). 순수 모듈(fflate 만 쓴다).
// QT1 은 템플릿 업로드·R2 해시 확인에 필요한 unzipTemplate·inspectTemplate 만 둔다. 조립(buildQuoteXlsx)·보기용 변형(stripMarginSheet)은 QT2 에서 더한다.
import { strFromU8, unzipSync } from "fflate";

export const QUOTE_SHEET = "견적";
export const QUOTE_MARGIN_SHEET = "견적 (마진계산용)";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** 1~20행에서 생성 때 값만 바꾸는 셀(§5.2). 두 시트 모두에 있어야 한다. */
export const PATCH_CELLS = ["B7", "B8", "B9", "B10", "B13", "A14", "A15", "A16", "A17", "A18", "H14", "H15", "H16", "H17"] as const;
/** 21행 이하 서식의 프로토타입 행(§5.3). A~I 셀에 s 가 있어야 한다. */
export const PROTO_ROWS = [21, 22, 23, 24, 25, 30, 31, 32] as const;
const PROTO_COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
const REQUIRED_PARTS = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml"];

export type TemplateCheck = { ok: true; sheets: { quote: string; margin: string } } | { ok: false; reason: string };

/** zip 이 아니거나 풀 수 없으면 null. */
export function unzipTemplate(bytes: Uint8Array): Record<string, Uint8Array> | null {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
  try {
    return unzipSync(bytes);
  } catch {
    return null;
  }
}

function attr(tag: string, name: string) {
  const match = new RegExp(`\\s${name.replace(":", "\\:")}="([^"]*)"`).exec(tag);
  return match ? match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'") : null;
}

function partPath(target: string) {
  const clean = target.replace(/^\/+/, "");
  return clean.startsWith("xl/") ? clean : `xl/${clean}`;
}

const cellPattern = (ref: string) => new RegExp(`<c\\b(?=[^>]*\\sr="${ref}")[^>]*>`);

/** 업로드·로드 때 템플릿 구조를 확인한다(§5.1 inspectTemplate). 하나라도 어긋나면 이유와 함께 ok:false. */
export function inspectTemplate(files: Record<string, Uint8Array>): TemplateCheck {
  for (const part of REQUIRED_PARTS) if (!files[part]) return { ok: false, reason: `missing ${part}` };
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const rels = strFromU8(files["xl/_rels/workbook.xml.rels"]);
  const targets = new Map<string, string>();
  for (const tag of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (id && target) targets.set(id, partPath(target));
  }
  const sheets = new Map<string, string>();
  for (const tag of workbook.match(/<sheet\b[^>]*>/g) ?? []) {
    const name = attr(tag, "name");
    const id = attr(tag, "r:id");
    if (name && id && targets.has(id)) sheets.set(name, targets.get(id) as string);
  }
  const quote = sheets.get(QUOTE_SHEET);
  const margin = sheets.get(QUOTE_MARGIN_SHEET);
  if (!quote || !margin || sheets.size !== 2) return { ok: false, reason: "sheet names" };
  for (const path of [quote, margin]) {
    if (!files[path]) return { ok: false, reason: `missing ${path}` };
    const xml = strFromU8(files[path]);
    for (const ref of PATCH_CELLS) if (!cellPattern(ref).test(xml)) return { ok: false, reason: `missing cell ${ref}` };
    for (const row of PROTO_ROWS) {
      for (const col of PROTO_COLS) {
        const tag = cellPattern(`${col}${row}`).exec(xml)?.[0];
        if (!tag || !/\ss="\d+"/.test(tag)) return { ok: false, reason: `missing style ${col}${row}` };
      }
    }
  }
  return { ok: true, sheets: { quote, margin } };
}

/** SHA-256 hex(Web Crypto, Worker·Node 공용). */
export async function sha256Hex(bytes: Uint8Array | string) {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
