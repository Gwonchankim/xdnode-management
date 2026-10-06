#!/usr/bin/env node
// 실제 견적 템플릿 사본 → 회귀 테스트용 템플릿(quote-tool Design §11.4, 체크포인트 Q3).
//
//   node scripts/make-quote-test-template.mjs <실제 템플릿 사본.xlsx> tests/fixtures/quote/template-redacted.xlsx
//
// - xl/media/*.png(로고·직인)를 1×1 투명 PNG 로 바꾼다. 그림 앵커(drawing XML)는 그대로 둔다.
// - 시트 rels 의 mailto: 대상(B10 고객 메일, H17 담당자 메일)을 mailto:customer@example.com · mailto:staff@example.com 으로 바꾼다.
// - docProps/core.xml 의 작성자(dc:creator·cp:lastModifiedBy)를 지운다.
// - 1~20행에서 생성 때 항상 덮어쓰는 셀(B7~B10, H15~H17)의 **값**만 자리표시자로 바꾼다(기본 담당자 실명·휴대폰이 저장소에 들어가지 않게).
//   스타일(s)·행 속성·병합·21행 이하·styles.xml·theme 은 바이트 그대로다. 계산값·병합·높이 비교는 실제 템플릿과 같은 결과다.
// 출력은 항목 순서·압축 수준·mtime 을 고정해 같은 입력이면 같은 바이트다. 화면에는 바꾼 항목 수만 찍는다.
import { readFileSync, writeFileSync } from "node:fs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error("usage: node scripts/make-quote-test-template.mjs <template.xlsx> <out.xlsx>");
  process.exit(2);
}

// 1×1 투명 PNG(67바이트).
const BLANK_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const PLACEHOLDER_CELLS = { H15: "담당자 팀장", H16: "010-1234-5678", H17: "staff@example.com" };
const EMPTY_CELLS = ["B7", "B8", "B9", "B10"];
const LINK_TARGETS = { B10: "mailto:customer@example.com", H17: "mailto:staff@example.com" };

const escapeXml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const files = unzipSync(new Uint8Array(readFileSync(source)));
const counts = { media: 0, links: 0, cells: 0, author: 0 };

/** <c r="REF" …>…</c> 또는 <c r="REF" …/> 를 찾아 s 를 유지한 새 셀로 바꾼다. */
function replaceCell(xml, ref, value) {
  const pattern = new RegExp(`<c\\b(?=[^>]*\\sr="${ref}")[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
  const match = pattern.exec(xml);
  if (!match) return xml;
  const style = /\ss="(\d+)"/.exec(match[0])?.[1];
  const head = `<c r="${ref}"${style !== undefined ? ` s="${style}"` : ""}`;
  const cell = value === null ? `${head}/>` : `${head} t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
  counts.cells += 1;
  return xml.slice(0, match.index) + cell + xml.slice(match.index + match[0].length);
}

for (const name of Object.keys(files)) {
  if (/^xl\/media\/[^/]+\.png$/i.test(name)) {
    files[name] = new Uint8Array(BLANK_PNG);
    counts.media += 1;
  } else if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
    let xml = strFromU8(files[name]);
    for (const ref of EMPTY_CELLS) xml = replaceCell(xml, ref, null);
    for (const [ref, value] of Object.entries(PLACEHOLDER_CELLS)) xml = replaceCell(xml, ref, value);
    // 하이퍼링크 ref → r:id (rels 를 바꿀 때 쓴다)
    const linkIds = {};
    for (const tag of xml.match(/<hyperlink\b[^>]*>/g) ?? []) {
      const ref = /\sref="([^"]+)"/.exec(tag)?.[1];
      const id = /\sr:id="([^"]+)"/.exec(tag)?.[1];
      if (ref && id) linkIds[id] = ref;
    }
    files[name] = strToU8(xml);
    const relsName = name.replace(/^xl\/worksheets\//, "xl/worksheets/_rels/") + ".rels";
    if (files[relsName]) {
      const rels = strFromU8(files[relsName]).replace(/<Relationship\b[^>]*>/g, (tag) => {
        const target = /\sTarget="([^"]*)"/.exec(tag)?.[1] ?? "";
        if (!/^mailto:/i.test(target)) return tag;
        const id = /\sId="([^"]+)"/.exec(tag)?.[1] ?? "";
        counts.links += 1;
        return tag.replace(/\sTarget="[^"]*"/, ` Target="${LINK_TARGETS[linkIds[id]] ?? LINK_TARGETS.B10}"`);
      });
      files[relsName] = strToU8(rels);
    }
  } else if (name === "docProps/core.xml") {
    const core = strFromU8(files[name])
      .replace(/(<dc:creator\b[^>]*>)[\s\S]*?(<\/dc:creator>)/, (_, open, close) => { counts.author += 1; return `${open}${close}`; })
      .replace(/(<cp:lastModifiedBy\b[^>]*>)[\s\S]*?(<\/cp:lastModifiedBy>)/, (_, open, close) => { counts.author += 1; return `${open}${close}`; });
    files[name] = strToU8(core);
  }
}

const mtime = new Date(2026, 9, 2, 0, 0, 0);
const zippable = {};
for (const [name, data] of Object.entries(files)) zippable[name] = [data, { level: /\.png$/i.test(name) ? 0 : 6, mtime }];
writeFileSync(target, zipSync(zippable));
console.log(JSON.stringify({ out: target, ...counts }));
