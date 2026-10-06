// 견적 xlsx(quote-tool Design §5, QD-10·QD-11·QD-12). 순수 모듈(fflate 와 순수 견적 모듈만 쓴다).
// 템플릿 zip 을 풀어 시트 XML 을 문자열로 패치한다(옛 quote_gen/generator.py 와 같은 결과, 셀맵 스펙 §9-5).
//   1~20행: 정해진 셀(B7~B10, B13, A14~A18, H14~H17)의 값 부분만 바꾸고 나머지 바이트는 그대로 둔다.
//   21행 이하: 템플릿 행을 버리고 옛 _write_body 와 같은 순서로 새로 쓴다(서식은 템플릿 21~32행의 s 값).
//   모든 수식 셀에 계산값(<v>)을 함께 쓰고 fullCalcOnLoad="1" 을 유지한다(보호된 보기에서도 금액이 보인다).
// 하이퍼링크 B10·H17 은 그 견적의 고객·담당자 메일로 바꾸거나 지우고, 문서 작성자는 'XDnode management' 로 바꾼다(QD-11).
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { evaluateAll } from "./quote-formula";
import { isGroup, itemsPriced, toExcelSerial, type Quote } from "./quote-model";
import {
  attr, cellRef, colToNum, escapeXml, findAllElements, findCell, findElement, openTag, rowNumber, setAttr, splitSheet, type SheetParts,
} from "./quote-xml";

export const QUOTE_SHEET = "견적";
export const QUOTE_MARGIN_SHEET = "견적 (마진계산용)";
export const MARGIN_SUFFIX = " (마진계산용)";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** 1~20행에서 생성 때 값만 바꾸는 셀(§5.2). 두 시트 모두에 있어야 한다. */
export const PATCH_CELLS = ["B7", "B8", "B9", "B10", "B13", "A14", "A15", "A16", "A17", "A18", "H14", "H15", "H16", "H17"] as const;
/** 21행 이하 서식의 프로토타입 행(§5.3). A~I 셀에 s 가 있어야 한다. */
export const PROTO_ROWS = [21, 22, 23, 24, 25, 30, 31, 32] as const;
const PROTO_COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
const REQUIRED_PARTS = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml"];
export const DOC_AUTHOR = "XDnode management";
/** 옛 코드 상수(공백 2칸 그대로). */
export const ACCOUNT_LINE = "계좌번호 : 국민은행 062037-04-007843  예금주 : ㈜엑스디노드";

// 옛 generator.py 상수
const H_HEADER = 37.5;
const H_GROUP = 29.25;
const H_DETAIL = 29.25;
const H_REMARK = 27.75;
const LINE_PT = 13.3;
const NUMFMT_WON_ACC = 169;
const NUMFMT_WON_PLAIN = 168;
const NUMFMT_NUM_ACC = 165;
const NUMFMT_FIXED2 = 2;

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

function partPath(target: string, base = "xl/") {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  const parts = `${base}${target}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

const relsPathOf = (part: string) => {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
};
const dirOf = (part: string) => part.slice(0, part.lastIndexOf("/") + 1);

type Relationship = { id: string; type: string; target: string; tag: string };
function readRels(xml: string): Relationship[] {
  return (xml.match(/<Relationship\b[^>]*>/g) ?? []).map((tag) => ({
    id: attr(tag, "Id") ?? "", type: attr(tag, "Type") ?? "", target: attr(tag, "Target") ?? "", tag,
  }));
}

type WorkbookSheet = { name: string; rid: string; path: string; tag: string };
function workbookSheets(files: Record<string, Uint8Array>): WorkbookSheet[] {
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const rels = new Map(readRels(strFromU8(files["xl/_rels/workbook.xml.rels"])).map((rel) => [rel.id, partPath(rel.target)]));
  return (workbook.match(/<sheet\b[^>]*>/g) ?? []).map((tag) => {
    const rid = attr(tag, "r:id") ?? "";
    return { name: attr(tag, "name") ?? "", rid, path: rels.get(rid) ?? "", tag };
  });
}

const cellPattern = (ref: string) => new RegExp(`<c\\b(?=[^>]*\\sr="${ref}")[^>]*>`);

/** 업로드·로드 때 템플릿 구조를 확인한다(§5.1 inspectTemplate). 하나라도 어긋나면 이유와 함께 ok:false. */
export function inspectTemplate(files: Record<string, Uint8Array>): TemplateCheck {
  for (const part of REQUIRED_PARTS) if (!files[part]) return { ok: false, reason: `missing ${part}` };
  const sheets = new Map(workbookSheets(files).filter((sheet) => sheet.name && sheet.path).map((sheet) => [sheet.name, sheet.path]));
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

// ── 템플릿 모델 ──────────────────────────────────────────────────────────
export type ProtoKey = "header" | "group" | "detailFirst" | "detailCont" | "detail" | "remark1" | "remark2" | "remark3";
export type ProtoMap = Record<ProtoKey, number[]>;
const PROTO_OF: Record<ProtoKey, number> = { header: 21, group: 22, detailFirst: 23, detailCont: 24, detail: 25, remark1: 30, remark2: 31, remark3: 32 };
export type TemplateSheet = { path: string; relsPath: string; xml: string; parts: SheetParts };
export type TemplateModel = {
  sha256: string; files: Record<string, Uint8Array>; order: string[];
  sheets: { quote: TemplateSheet; margin: TemplateSheet }; protos: ProtoMap; workbookXml: string; stylesXml: string;
};

function sheetOf(files: Record<string, Uint8Array>, path: string): TemplateSheet {
  const xml = strFromU8(files[path]);
  return { path, relsPath: relsPathOf(path), xml, parts: splitSheet(xml) };
}

/** 템플릿 바이트 → 모델(inspectTemplate 포함, sha256 계산). 구조가 어긋나면 throw(호출부가 TEMPLATE_INVALID 로 바꾼다). */
export async function loadTemplate(bytes: Uint8Array, knownSha256?: string): Promise<TemplateModel> {
  const files = unzipTemplate(bytes);
  if (!files) throw new Error("template is not a zip");
  const check = inspectTemplate(files);
  if (!check.ok) throw new Error(`template: ${check.reason}`);
  const quote = sheetOf(files, check.sheets.quote);
  const margin = sheetOf(files, check.sheets.margin);
  const protos = {} as ProtoMap;
  for (const [key, row] of Object.entries(PROTO_OF) as Array<[ProtoKey, number]>) {
    const rowXml = quote.parts.rows.find((candidate) => rowNumber(candidate) === row) ?? "";
    protos[key] = PROTO_COLS.map((col) => Number(attr(openTag(findCell(rowXml, `${col}${row}`)?.text ?? ""), "s") ?? 0));
  }
  return {
    sha256: knownSha256 ?? await sha256Hex(bytes), files, order: Object.keys(files), sheets: { quote, margin }, protos,
    workbookXml: strFromU8(files["xl/workbook.xml"]), stylesXml: strFromU8(files["xl/styles.xml"]),
  };
}

// ── 스타일 파생(§5.4) ────────────────────────────────────────────────────
export type StyleOp = { op: "numFmt"; id: number } | { op: "bottomDouble" } | { op: "font9wrap" } | { op: "alignLeftWrap" } | { op: "remarkWrap" } | { op: "boldFont10" };
const FONT_9 = '<font><name val="맑은 고딕"/><sz val="9"/></font>';
const FONT_BOLD_10 = '<font><name val="맑은 고딕"/><b val="1"/><sz val="10"/></font>';
const ALIGN_LEFT_WRAP = '<alignment horizontal="left" vertical="center" wrapText="1"/>';
const ALIGN_REMARK = '<alignment vertical="center" wrapText="1"/>';

function sectionItems(xml: string, section: string, item: string) {
  const found = findElement(xml, section);
  if (!found) return [];
  const inner = found.text.replace(/^<[^>]*>/, "").replace(new RegExp(`</${section}>$`), "");
  return found.text.endsWith("/>") ? [] : findAllElements(inner, item);
}

function replaceSection(xml: string, section: string, item: string, items: string[]) {
  const found = findElement(xml, section);
  if (!found) throw new Error(`styles.xml has no <${section}>`);
  const tag = setAttr(openTag(found.text).replace(/\/>$/, ">"), "count", String(items.length));
  return xml.slice(0, found.start) + `${tag}${items.join("")}</${section}>` + xml.slice(found.end);
}

function withAlignment(xf: string, alignment: string) {
  const tag = setAttr(openTag(xf), "applyAlignment", "1");
  if (xf.endsWith("/>")) return `${tag.replace(/\s*\/>$/, ">")}${alignment}</xf>`;
  const body = xf.slice(openTag(xf).length);
  if (/<alignment\b/.test(body)) return tag + body.replace(/<alignment\b[^>]*?(?:\/>|>[\s\S]*?<\/alignment>)/, alignment);
  return tag + alignment + body;
}

class StyleBook {
  private fonts: string[];
  private borders: string[];
  private xfs: string[];
  private readonly memo = new Map<string, number>();
  private readonly fontIds = new Map<string, number>();
  private readonly initialXfs: number;
  constructor(private readonly xml: string) {
    this.fonts = sectionItems(xml, "fonts", "font");
    this.borders = sectionItems(xml, "borders", "border");
    this.xfs = sectionItems(xml, "cellXfs", "xf");
    this.initialXfs = this.xfs.length;
  }
  get xfCount() { return this.xfs.length; }
  get changed() { return this.xfs.length !== this.initialXfs; }

  private font(xml: string) {
    let id = this.fontIds.get(xml);
    if (id === undefined) {
      id = this.fonts.length;
      this.fonts.push(xml);
      this.fontIds.set(xml, id);
    }
    return id;
  }

  derive(base: number, ...ops: StyleOp[]): number {
    let current = base;
    for (const op of ops) current = this.deriveOne(current, op);
    return current;
  }

  private deriveOne(base: number, op: StyleOp): number {
    const key = `${base}|${op.op}${op.op === "numFmt" ? op.id : ""}`;
    const cached = this.memo.get(key);
    if (cached !== undefined) return cached;
    const xf = this.xfs[base] ?? this.xfs[0];
    let next: string;
    switch (op.op) {
      case "numFmt": {
        if (attr(openTag(xf), "numFmtId") === String(op.id)) {
          this.memo.set(key, base);
          return base;
        }
        next = xf.replace(openTag(xf), setAttr(setAttr(openTag(xf), "numFmtId", String(op.id)), "applyNumberFormat", "1"));
        break;
      }
      case "bottomDouble": {
        const border = this.borders[Number(attr(openTag(xf), "borderId") ?? 0)] ?? "<border/>";
        let cloned: string;
        if (border.endsWith("/>")) cloned = '<border><left/><right/><top/><bottom style="double"/><diagonal/></border>';
        else if (/<bottom\b/.test(border)) cloned = border.replace(/<bottom\b[^>]*?(?:\/>|>[\s\S]*?<\/bottom>)/, '<bottom style="double"/>');
        else if (/<diagonal\b/.test(border)) cloned = border.replace(/<diagonal\b/, '<bottom style="double"/><diagonal');
        else cloned = border.replace(/<\/border>$/, '<bottom style="double"/></border>');
        const borderId = this.borders.length;
        this.borders.push(cloned);
        next = xf.replace(openTag(xf), setAttr(setAttr(openTag(xf), "borderId", String(borderId)), "applyBorder", "1"));
        break;
      }
      case "font9wrap":
      case "boldFont10": {
        const fontId = this.font(op.op === "font9wrap" ? FONT_9 : FONT_BOLD_10);
        next = xf.replace(openTag(xf), setAttr(setAttr(openTag(xf), "fontId", String(fontId)), "applyFont", "1"));
        if (op.op === "font9wrap") next = withAlignment(next, ALIGN_LEFT_WRAP);
        break;
      }
      case "alignLeftWrap": next = withAlignment(xf, ALIGN_LEFT_WRAP); break;
      case "remarkWrap": next = withAlignment(xf, ALIGN_REMARK); break;
      default: throw new Error("unknown style op");
    }
    const id = this.xfs.length;
    this.xfs.push(next);
    this.memo.set(key, id);
    return id;
  }

  toXml() {
    if (!this.changed) return this.xml;
    let xml = replaceSection(this.xml, "fonts", "font", this.fonts);
    xml = replaceSection(xml, "borders", "border", this.borders);
    return replaceSection(xml, "cellXfs", "xf", this.xfs);
  }
}

// ── 시트 조립 ────────────────────────────────────────────────────────────
type Cell = { s: number; value?: string | number; formula?: string };
type BuiltRow = { ht?: number; cells: Map<number, Cell> };

class SheetBuilder {
  readonly rows = new Map<number, BuiltRow>();
  readonly merges: string[] = [];
  constructor(readonly styles: StyleBook) {}
  private row(r: number) {
    let row = this.rows.get(r);
    if (!row) {
      row = { cells: new Map() };
      this.rows.set(r, row);
    }
    return row;
  }
  cell(col: string, r: number) {
    const row = this.row(r);
    const c = colToNum(col);
    let cell = row.cells.get(c);
    if (!cell) {
      cell = { s: 0 };
      row.cells.set(c, cell);
    }
    return cell;
  }
  height(r: number, ht: number) { this.row(r).ht = ht; }
  proto(r: number, styles: number[]) {
    PROTO_COLS.forEach((col, index) => { this.cell(col, r).s = styles[index]; });
  }
  /** 옛 openpyxl `ws[c] = v`: None·"" 은 값 없음. 문자열이 아니면 숫자. */
  set(col: string, r: number, value: string | number | null | undefined) {
    const cell = this.cell(col, r);
    delete cell.formula;
    if (value === null || value === undefined || value === "") delete cell.value;
    else cell.value = value;
  }
  formula(col: string, r: number, formula: string) {
    const cell = this.cell(col, r);
    delete cell.value;
    cell.formula = formula;
  }
  derive(col: string, r: number, ...ops: StyleOp[]) {
    const cell = this.cell(col, r);
    cell.s = this.styles.derive(cell.s, ...ops);
  }
  merge(range: string) { this.merges.push(range); }
}

const nLines = (text: string | null | undefined) => (text ? text.split("\n").length : 1);
/** 옛 _spec_text: 비면 값 없음. 줄바꿈이 없고 공백으로 시작하지 않으면 앞에 공백 1칸. */
const specText = (value: string | null | undefined) => (!value ? null : !value.includes("\n") && !value.startsWith(" ") ? ` ${value}` : value);

export type BodyRows = { header: 21; lines: number[]; items: Record<string, number>; remark: number; vat: number; total: number };

/** 옛 _write_body(21행부터 품목표·비고·합계). */
function writeBody(sb: SheetBuilder, quote: Quote, protos: ProtoMap): BodyRows {
  const showSet = quote.lines.some(isGroup);
  let r = 21;
  sb.proto(r, protos.header);
  sb.height(r, H_HEADER);
  (["A", "B", "C", "F", "G", "H", "I"] as const).forEach((col, index) => {
    sb.set(col, r, ["NO.", "품목명", "제품사양", "수량", showSet ? "세트" : null, "단가", "금액"][index]);
  });
  sb.merge(`C${r}:E${r}`);
  if (!showSet) sb.merge(`F${r}:G${r}`);
  r += 1;

  const lineRows: number[] = [];
  const itemRows: Record<string, number> = {};
  let lastBodyRow = r;
  quote.lines.forEach((line, li) => {
    sb.proto(r, protos.group);
    sb.height(r, H_GROUP);
    sb.set("A", r, String.fromCharCode(65 + li));
    sb.set("B", r, line.label);
    sb.set("C", r, specText(line.name));
    sb.merge(`C${r}:E${r}`);
    if (!showSet) sb.merge(`F${r}:G${r}`);
    sb.derive("H", r, { op: "numFmt", id: NUMFMT_WON_ACC });
    sb.derive("I", r, { op: "numFmt", id: NUMFMT_WON_ACC });
    const group = isGroup(line);
    if (group) sb.set("G", r, line.sets ?? 1);
    else {
      sb.set("F", r, line.qty ?? 1);
      sb.set("H", r, line.unit_price);
      sb.formula("I", r, `H${r}*F${r}`);
    }
    lineRows.push(r);
    const groupRow = r;
    r += 1;

    const detailRows: number[] = [];
    line.items.forEach((item, ii) => {
      const span = item.extra_categories.length;
      sb.proto(r, ii === 0 ? protos.detailFirst : protos.detail);
      sb.set("A", r, ii + 1);
      sb.set("B", r, item.category);
      sb.set("C", r, specText(item.spec));
      sb.set("F", r, item.qty);
      const nl = nLines(item.spec);
      if (nl > 1) sb.derive("C", r, { op: "font9wrap" });
      const total = Math.max(H_DETAIL * (span + 1), nl * LINE_PT + 10);
      for (let k = 1; k <= span; k += 1) {
        sb.proto(r + k, protos.detailCont);
        sb.set("A", r + k, ii + 1 + k);
        sb.set("B", r + k, item.extra_categories[k - 1]);
        sb.height(r + k, total / (span + 1));
      }
      sb.height(r, total / (span + 1));
      sb.merge(`C${r}:E${r + span}`);
      if (span) {
        sb.merge(`F${r}:F${r + span}`);
        sb.merge(`G${r}:G${r + span}`);
      } else if (!showSet) sb.merge(`F${r}:G${r}`);
      if (item.unit_price !== null) {
        sb.set("H", r, item.unit_price);
        sb.derive("H", r, { op: "numFmt", id: NUMFMT_WON_ACC });
        sb.formula("I", r, `H${r}*F${r}`);
        sb.derive("I", r, { op: "numFmt", id: NUMFMT_WON_ACC });
      }
      itemRows[`${li}.${ii}`] = r;
      detailRows.push(r);
      r += 1 + span;
    });
    // 상세 번호 다시 매기기: 옛 코드는 B 가 None 이 아닌 행을 세는데 category·extra 는 항상 문자열이라 전부 센다.
    let number = 1;
    for (let rr = groupRow + 1; rr < r; rr += 1) {
      sb.set("A", rr, number);
      number += 1;
    }
    for (const note of line.notes) {
      sb.proto(r, protos.detail);
      sb.set("C", r, note);
      sb.derive("C", r, { op: "alignLeftWrap" });
      sb.height(r, Math.max(H_DETAIL, nLines(note) * LINE_PT + 10));
      sb.merge(`C${r}:E${r}`);
      if (!showSet) sb.merge(`F${r}:G${r}`);
      r += 1;
    }
    if (group) {
      if (line.unit_price === null && itemsPriced(line) && detailRows.length) {
        sb.formula("H", groupRow, `SUM(I${detailRows[0]}:I${detailRows[detailRows.length - 1]})`);
      } else sb.set("H", groupRow, line.unit_price);
      sb.formula("I", groupRow, `H${groupRow}*G${groupRow}`);
    }
    lastBodyRow = r - 1;
  });

  for (const col of PROTO_COLS) sb.derive(col, lastBodyRow, { op: "bottomDouble" });

  const [r1, r2, r3] = [r, r + 1, r + 2];
  sb.proto(r1, protos.remark1);
  sb.proto(r2, protos.remark2);
  sb.proto(r3, protos.remark3);
  for (const rr of [r1, r2, r3]) {
    sb.height(rr, H_REMARK);
    sb.merge(`F${rr}:G${rr}`);
    sb.merge(`H${rr}:I${rr}`);
  }
  sb.set("A", r1, "* Remark");
  const remarkText = quote.remarks.join("\n");
  sb.set("A", r2, remarkText);
  if (nLines(remarkText) > 1) {
    sb.merge(`A${r2}:E${r2}`);
    sb.derive("A", r2, { op: "remarkWrap" });
    sb.height(r2, Math.max(H_REMARK, nLines(remarkText) * 12.5 + 6));
  }
  sb.set("A", r3, ACCOUNT_LINE);
  sb.set("F", r1, "소       액");
  sb.set("F", r2, "세       액");
  sb.set("F", r3, "총       액");
  sb.formula("H", r1, lineRows.length === 1 ? `I${lineRows[0]}` : `SUM(${lineRows.map((row) => `I${row}`).join(",")})`);
  sb.formula("H", r2, `H${r1}*0.1`);
  sb.formula("H", r3, `H${r1}+H${r2}`);
  for (const rr of [r1, r2, r3]) sb.derive("H", rr, { op: "numFmt", id: NUMFMT_WON_PLAIN });
  return { header: 21, lines: lineRows, items: itemRows, remark: r1, vat: r2, total: r3 };
}

/** 옛 _write_margin_cols(마진계산용 시트의 L~P 열). 대상은 그룹 상세 행뿐이다. */
function writeMarginCols(sb: SheetBuilder, quote: Quote, rows: BodyRows) {
  const margin = quote.margin;
  const headerRow = rows.lines[0] ?? 21;
  (["L", "M", "N", "O", "P"] as const).forEach((col, index) => {
    sb.set(col, headerRow, ["매입단가", "매입수량단가", "마진", "마진 단가", "마진 수량 합"][index]);
    sb.derive(col, headerRow, { op: "boldFont10" });
  });
  const items = Object.entries(rows.items).sort((a, b) => a[1] - b[1]);
  if (!items.length) return;
  const first = items[0][1];
  const last = items[items.length - 1][1];
  sb.set("N", first, margin ? margin.rate : null);
  sb.derive("N", first, { op: "numFmt", id: NUMFMT_FIXED2 });
  for (const [key, r] of items) {
    if (margin && Object.hasOwn(margin.buy_units, key)) sb.set("L", r, margin.buy_units[key]);
    sb.formula("M", r, `F${r}*L${r}`);
    sb.formula("O", r, `$N$${first}*L${r}`);
    sb.formula("P", r, `O${r}*F${r}+M${r}`);
    for (const col of ["L", "M", "O", "P"]) sb.derive(col, r, { op: "numFmt", id: NUMFMT_NUM_ACC });
  }
  const R = rows.remark;
  for (const col of ["L", "M", "O", "P"]) {
    sb.formula(col, R, `SUM(${col}${first}:${col}${last})`);
    sb.derive(col, R, { op: "numFmt", id: NUMFMT_NUM_ACC });
  }
  sb.set("K", R + 1, "총매입");
  sb.formula("L", R + 1, `M${R}`);
  sb.set("K", R + 2, "총마진");
  sb.formula("L", R + 2, `P${R}-M${R}`);
  for (const rr of [R + 1, R + 2]) sb.derive("L", rr, { op: "numFmt", id: NUMFMT_NUM_ACC });
}

const numberText = (value: number) => String(value);

function cellXml(ref: string, cell: Cell, computed: number | undefined) {
  const style = cell.s ? ` s="${cell.s}"` : "";
  if (cell.formula !== undefined) {
    const value = computed !== undefined && Number.isFinite(computed) ? `<v>${numberText(computed)}</v>` : "";
    return `<c r="${ref}"${style}><f>${escapeXml(cell.formula)}</f>${value}</c>`;
  }
  if (typeof cell.value === "number") return `<c r="${ref}"${style}><v>${numberText(cell.value)}</v></c>`;
  if (typeof cell.value === "string") return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.value)}</t></is></c>`;
  return `<c r="${ref}"${style}/>`;
}

/** 1~20행의 패치 셀: 기존 셀의 s 를 유지하고 값 부분만 바꾼다. */
function patchHeaderRows(rows: string[], values: Record<string, { value?: string | number | null; formula?: string; computed?: number }>) {
  return rows.map((rowXml) => {
    let out = rowXml;
    for (const [ref, spec] of Object.entries(values)) {
      const found = findCell(out, ref);
      if (!found) continue;
      const style = Number(attr(openTag(found.text), "s") ?? 0);
      const cell: Cell = { s: style };
      if (spec.formula !== undefined) cell.formula = spec.formula;
      else if (spec.value !== null && spec.value !== undefined && spec.value !== "") cell.value = spec.value;
      out = out.slice(0, found.start) + cellXml(ref, cell, spec.computed) + out.slice(found.end);
    }
    return out;
  });
}

const MARGIN_COLS_AFTER_J = [
  [11, 11, 3.1], [12, 12, 12], [13, 13, 13], [14, 14, 8], [15, 15, 11.5], [16, 16, 13], [17, 17, 11.5], [18, 18, 11.875], [19, 16384, 9],
] as const;

function marginCols(head: string) {
  const found = findElement(head, "cols");
  if (!found) return head;
  const kept = findAllElements(found.text, "col").filter((col) => Number(attr(col, "max")) <= 10);
  const style = attr(kept[kept.length - 1] ?? "", "style");
  const extra = MARGIN_COLS_AFTER_J.map(([min, max, width]) => `<col width="${width}" customWidth="1"${style !== null ? ` style="${style}"` : ""} min="${min}" max="${max}"/>`);
  return head.slice(0, found.start) + `<cols>${kept.join("")}${extra.join("")}</cols>` + head.slice(found.end);
}

function patchHead(head: string, dimension: string, margin: boolean) {
  let out = head.replace(/<dimension\b[^>]*\/>/, `<dimension ref="${dimension}"/>`);
  if (/<pageSetUpPr\b[^>]*\/>/.test(out)) out = out.replace(/<pageSetUpPr\b[^>]*\/>/, (tag) => setAttr(tag, "fitToPage", "1"));
  else if (/<\/sheetPr>/.test(out)) out = out.replace("</sheetPr>", '<pageSetUpPr fitToPage="1"/></sheetPr>');
  return margin ? marginCols(out) : out;
}

type LinkPlan = { removeIds: Set<string>; targets: Map<string, string> };

/** tail: 병합(시작 행 < 21 인 템플릿 병합 + 새 병합), 하이퍼링크(B10·H17), pageSetup fitToWidth/Height. */
function patchTail(tail: string, merges: string[], links: Record<string, string | null>): { tail: string; plan: LinkPlan } {
  let out = tail;
  const mergeElement = findElement(out, "mergeCells");
  const kept = mergeElement ? findAllElements(mergeElement.text, "mergeCell").filter((tag) => {
    const ref = attr(tag, "ref") ?? "";
    return Number(/\d+/.exec(ref)?.[0] ?? 0) < 21;
  }) : [];
  const all = [...kept, ...merges.map((range) => `<mergeCell ref="${range}"/>`)];
  const mergeXml = all.length ? `<mergeCells count="${all.length}">${all.join("")}</mergeCells>` : "";
  if (mergeElement) out = out.slice(0, mergeElement.start) + mergeXml + out.slice(mergeElement.end);
  else if (mergeXml) out = out.replace("</sheetData>", `</sheetData>${mergeXml}`);

  const plan: LinkPlan = { removeIds: new Set(), targets: new Map() };
  const hyperlinks = findElement(out, "hyperlinks");
  if (hyperlinks) {
    const items = findAllElements(hyperlinks.text, "hyperlink").filter((tag) => {
      const ref = attr(tag, "ref") ?? "";
      const id = attr(tag, "r:id");
      if (!(ref in links) || !id) return true;
      const email = links[ref];
      if (email) {
        plan.targets.set(id, `mailto:${encodeURI(email)}`);
        return true;
      }
      plan.removeIds.add(id);
      return false;
    });
    const xml = items.length ? `${openTag(hyperlinks.text)}${items.join("")}</hyperlinks>` : "";
    out = out.slice(0, hyperlinks.start) + xml + out.slice(hyperlinks.end);
  }
  out = out.replace(/<pageSetup\b[^>]*\/>/, (tag) => setAttr(setAttr(tag, "fitToWidth", "1"), "fitToHeight", "1"));
  return { tail: out, plan };
}

function patchSheetRels(xml: string, plan: LinkPlan) {
  return xml.replace(/<Relationship\b[^>]*>/g, (tag) => {
    const id = attr(tag, "Id") ?? "";
    if (plan.removeIds.has(id)) return "";
    const target = plan.targets.get(id);
    return target ? setAttr(tag, "Target", target) : tag;
  });
}

type BuiltSheet = { xml: string; rels: string | null; rows: BodyRows };

function buildSheet(template: TemplateModel, sheet: TemplateSheet, quote: Quote, issueDate: string, styles: StyleBook, margin: boolean): BuiltSheet {
  const sb = new SheetBuilder(styles);
  const rows = writeBody(sb, quote, template.protos);
  if (margin) writeMarginCols(sb, quote, rows);

  // 계산값(QD-10): 수식 셀을 의존 순서로 계산한다. B13 = H{r3} 도 같이.
  const formulas = new Map<string, string>();
  const values = new Map<string, number | string>();
  for (const [r, row] of sb.rows) {
    for (const [c, cell] of row.cells) {
      const ref = cellRef(c, r);
      if (cell.formula !== undefined) formulas.set(ref, cell.formula);
      else if (cell.value !== undefined) values.set(ref, cell.value);
    }
  }
  formulas.set("B13", `H${rows.total}`);
  const computed = evaluateAll(formulas, values);

  const { customer, terms, staff } = quote;
  const header = patchHeaderRows(sheet.parts.rows.filter((row) => rowNumber(row) < 21), {
    B7: { value: customer.org }, B8: { value: customer.contact }, B9: { value: customer.tel }, B10: { value: customer.email },
    A14: { value: `견적유효기간 : 견적 후 ${terms.valid_weeks}주 이내${terms.stamp_omitted ? " (직인생략)" : ""}` },
    A15: { value: `납품기일 : ${terms.delivery}` }, A16: { value: `결제조건 : ${terms.payment}` }, A17: { value: `납품장소 : ${terms.place}` },
    A18: { value: terms.project ? `프로젝트명 및 입찰 건명 : ${terms.project}` : null },
    H14: { value: toExcelSerial(issueDate) }, H15: { value: staff.name }, H16: { value: staff.tel }, H17: { value: staff.email },
    B13: { formula: `H${rows.total}`, computed: computed.get("B13") },
  });
  const body = [...sb.rows.entries()].sort((a, b) => a[0] - b[0]).map(([r, row]) => {
    const cells = [...row.cells.entries()].sort((a, b) => a[0] - b[0]).map(([c, cell]) => cellXml(cellRef(c, r), cell, computed.get(cellRef(c, r))));
    const ht = row.ht !== undefined ? ` ht="${numberText(row.ht)}" customHeight="1"` : "";
    return `<row r="${r}"${ht}>${cells.join("")}</row>`;
  });
  const dimension = margin ? `A1:P${rows.total}` : `A1:I${rows.total}`;
  const head = patchHead(sheet.parts.head, dimension, margin);
  const { tail, plan } = patchTail(sheet.parts.tail, sb.merges, { B10: customer.email, H17: staff.email || null });
  const relsSource = template.files[sheet.relsPath];
  return { xml: head + header.join("") + body.join("") + tail, rels: relsSource ? patchSheetRels(strFromU8(relsSource), plan) : null, rows };
}

const quoteSheetRef = (name: string) => `'${name.replace(/'/g, "''")}'`;

function patchWorkbook(xml: string, sheets: WorkbookSheet[], names: Map<string, string>, lastRows: Map<string, number>) {
  let out = xml;
  sheets.forEach((sheet, index) => {
    const name = names.get(sheet.path);
    if (name === undefined) return;
    out = out.replace(sheet.tag, setAttr(sheet.tag, "name", name));
    const area = `${quoteSheetRef(name)}!$A$1:$I$${lastRows.get(sheet.path)}`;
    const definedPattern = new RegExp(`<definedName\\b(?=[^>]*\\sname="_xlnm\\.Print_Area")(?=[^>]*\\slocalSheetId="${index}")[^>]*>[\\s\\S]*?</definedName>`);
    const replacement = `<definedName name="_xlnm.Print_Area" localSheetId="${index}">${escapeXml(area)}</definedName>`;
    if (definedPattern.test(out)) out = out.replace(definedPattern, replacement);
    else if (/<\/definedNames>/.test(out)) out = out.replace("</definedNames>", `${replacement}</definedNames>`);
    else out = out.replace("</sheets>", `</sheets><definedNames>${replacement}</definedNames>`);
  });
  if (/<calcPr\b[^>]*\/>/.test(out)) out = out.replace(/<calcPr\b[^>]*\/>/, (tag) => setAttr(tag, "fullCalcOnLoad", "1"));
  else out = out.replace("</workbook>", '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>');
  return out;
}

function patchCore(xml: string, now: number) {
  const modified = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  return xml
    .replace(/(<dc:creator\b[^>]*>)[\s\S]*?(<\/dc:creator>)/, `$1${escapeXml(DOC_AUTHOR)}$2`)
    .replace(/(<cp:lastModifiedBy\b[^>]*>)[\s\S]*?(<\/cp:lastModifiedBy>)/, `$1${escapeXml(DOC_AUTHOR)}$2`)
    .replace(/(<dcterms:modified\b[^>]*>)[\s\S]*?(<\/dcterms:modified>)/, `$1${modified}$2`);
}

/** zip: 항목 순서 그대로, PNG 는 level 0, 나머지 level 6, mtime 고정(같은 입력·시각이면 같은 바이트, QX-09). */
function zipFiles(order: string[], files: Record<string, Uint8Array>, mtime: Date) {
  const zippable: Zippable = {};
  for (const name of order) {
    if (files[name]) zippable[name] = [files[name], { level: /\.png$/i.test(name) ? 0 : 6, mtime }];
  }
  return zipSync(zippable);
}

/** 템플릿에 calcChain 이 있으면 파일·rel·Override 를 지운다(§5.1). */
function dropCalcChain(files: Record<string, Uint8Array>) {
  if (!files["xl/calcChain.xml"]) return;
  delete files["xl/calcChain.xml"];
  files["xl/_rels/workbook.xml.rels"] = strToU8(strFromU8(files["xl/_rels/workbook.xml.rels"]).replace(/<Relationship\b[^>]*calcChain[^>]*>/g, ""));
  files["[Content_Types].xml"] = strToU8(strFromU8(files["[Content_Types].xml"]).replace(/<Override\b[^>]*calcChain\.xml[^>]*>/g, ""));
}

export type BuildResult = { bytes: Uint8Array; sheetName: string; rows: BodyRows };

/** Quote → xlsx(견적 시트 + 마진계산용 시트). withMargin=false 면 마진 시트를 뗀 결과(stripMarginSheet)다. */
export function buildQuoteXlsx(input: { template: TemplateModel; quote: Quote; issueDate: string; withMargin: boolean; now: number }): BuildResult {
  const { template, quote, issueDate, now } = input;
  const files: Record<string, Uint8Array> = { ...template.files };
  const styles = new StyleBook(template.stylesXml);
  const quoteSheet = buildSheet(template, template.sheets.quote, quote, issueDate, styles, false);
  const marginSheet = buildSheet(template, template.sheets.margin, quote, issueDate, styles, true);
  files[template.sheets.quote.path] = strToU8(quoteSheet.xml);
  files[template.sheets.margin.path] = strToU8(marginSheet.xml);
  if (quoteSheet.rels !== null) files[template.sheets.quote.relsPath] = strToU8(quoteSheet.rels);
  if (marginSheet.rels !== null) files[template.sheets.margin.relsPath] = strToU8(marginSheet.rels);
  files["xl/styles.xml"] = strToU8(styles.toXml());
  const sheetName = quote.sheet_name;
  const names = new Map([[template.sheets.quote.path, sheetName], [template.sheets.margin.path, `${sheetName}${MARGIN_SUFFIX}`]]);
  const lastRows = new Map([[template.sheets.quote.path, quoteSheet.rows.total], [template.sheets.margin.path, marginSheet.rows.total]]);
  files["xl/workbook.xml"] = strToU8(patchWorkbook(template.workbookXml, workbookSheets(template.files), names, lastRows));
  if (files["docProps/core.xml"]) files["docProps/core.xml"] = strToU8(patchCore(strFromU8(files["docProps/core.xml"]), now));
  dropCalcChain(files);
  const bytes = zipFiles(template.order, files, new Date(now));
  return { bytes: input.withMargin ? bytes : stripMarginSheet(bytes), sheetName, rows: quoteSheet.rows };
}

// ── 보기 권한용 변형(§5.8, QT-Q12) ──────────────────────────────────────
/** 첫 로컬 파일 머리의 DOS 시각 → Date(같은 입력이면 같은 출력). */
function zipMtime(bytes: Uint8Array) {
  if (bytes.length < 14) return new Date(2026, 0, 1);
  const time = bytes[10] | (bytes[11] << 8);
  const date = bytes[12] | (bytes[13] << 8);
  const year = ((date >> 9) & 0x7f) + 1980;
  if (year < 1980 || year > 2099) return new Date(2026, 0, 1);
  return new Date(year, ((date >> 5) & 0xf) - 1, date & 0x1f, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

/** 저장본에서 '… (마진계산용)' 시트와 그 시트만 쓰던 그림·이미지를 떼어 낸 xlsx. 마진 시트가 없으면 그대로 돌려준다. */
export function stripMarginSheet(bytes: Uint8Array): Uint8Array {
  const files = unzipSync(bytes);
  const order = Object.keys(files);
  const sheets = workbookSheets(files);
  const index = sheets.findIndex((sheet) => sheet.name.endsWith(MARGIN_SUFFIX));
  if (index < 0) return bytes;
  const target = sheets[index];
  const remove = new Set<string>([target.path]);

  // 그 시트의 rels → drawing → drawing rels → media. 남는 시트·그림이 쓰는 파트는 지우지 않는다.
  const referencedBy = (relsName: string, base: string) => (files[relsName] ? readRels(strFromU8(files[relsName])).filter((rel) => !/External/.test(rel.tag)).map((rel) => partPath(rel.target, base)) : []);
  const sheetRels = relsPathOf(target.path);
  const drawings = referencedBy(sheetRels, dirOf(target.path)).filter((part) => /\/drawings\//.test(part));
  remove.add(sheetRels);
  const keepParts = new Set<string>();
  for (const sheet of sheets) {
    if (sheet === target) continue;
    for (const part of referencedBy(relsPathOf(sheet.path), dirOf(sheet.path))) {
      keepParts.add(part);
      for (const media of referencedBy(relsPathOf(part), dirOf(part))) keepParts.add(media);
    }
  }
  for (const drawing of drawings) {
    if (keepParts.has(drawing)) continue;
    remove.add(drawing);
    remove.add(relsPathOf(drawing));
    for (const media of referencedBy(relsPathOf(drawing), dirOf(drawing))) if (!keepParts.has(media)) remove.add(media);
  }

  let workbook = strFromU8(files["xl/workbook.xml"]).replace(target.tag, "");
  workbook = workbook.replace(/<definedName\b[^>]*>[\s\S]*?<\/definedName>/g, (element) => {
    const local = attr(openTag(element), "localSheetId");
    if (local === null) return element;
    const id = Number(local);
    if (id === index) return "";
    return id > index ? element.replace(openTag(element), setAttr(openTag(element), "localSheetId", String(id - 1))) : element;
  }).replace(/<definedNames>\s*<\/definedNames>/, "");
  const remaining = sheets.length - 1;
  workbook = workbook.replace(/<workbookView\b[^>]*\/?>/, (tag) => {
    let out = tag;
    if (Number(attr(tag, "activeTab") ?? 0) >= remaining) out = setAttr(out, "activeTab", "0");
    if (Number(attr(tag, "firstSheet") ?? 0) >= remaining) out = setAttr(out, "firstSheet", "0");
    return out;
  });
  files["xl/workbook.xml"] = strToU8(workbook);
  files["xl/_rels/workbook.xml.rels"] = strToU8(strFromU8(files["xl/_rels/workbook.xml.rels"]).replace(/<Relationship\b[^>]*>/g, (tag) => (attr(tag, "Id") === target.rid ? "" : tag)));
  files["[Content_Types].xml"] = strToU8(strFromU8(files["[Content_Types].xml"]).replace(/<Override\b[^>]*>/g, (tag) => (remove.has((attr(tag, "PartName") ?? "").replace(/^\//, "")) ? "" : tag)));
  for (const part of remove) delete files[part];
  return zipFiles(order.filter((name) => !remove.has(name)), files, zipMtime(bytes));
}
