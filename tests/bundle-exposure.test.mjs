import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// R1 번들 노출 가드(xdnode-management Design §7.9, §8.3 #11, FR-20, SC-9).
// 정적 자산은 Worker보다 먼저 응답하므로 로그인 게이트가 dist/client를 보호하지 못한다. 그래서 브라우저 번들에는
// 서버 시드의 실제 직원 이름·전화·개인 이메일·급여 값과 재무 실데이터 표지가 0건이어야 한다.
// 실데이터를 다루므로 이 테스트는 어떤 경우에도 값을 출력하지 않는다. 실패 메시지에는 종류·건수·파일 이름만 적는다.
// `npm test`는 먼저 `npm run build`를 돌리므로 dist/를 읽을 수 있다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = path.join(root, "dist", "client");
const serverDir = path.join(root, "dist", "server");

// app/hr-company-data.ts는 `import "server-only"`인 TS 모듈이다. 가상 모듈을 비우고 TS를 변환해 읽는다.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "bundle-exposure:server-only", shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(url) && existsSync(new URL(`${url.href}.ts`))) return nextResolve(`${url.href}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "bundle-exposure:server-only") return { format: "module", source: "export {};", shortCircuit: true };
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText };
    }
    return nextLoad(url, context);
  },
});

const { companyEmployees } = await import(pathToFileURL(path.join(root, "app", "hr-company-data.ts")).href);

const textAsset = /\.(?:[cm]?js|css|html?|json|map|txt|svg|webmanifest)$/i;

async function readTextAssets(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && textAsset.test(entry.name))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
  return Promise.all(files.map(async (file) => ({ name: path.relative(dir, file).replaceAll("\\", "/"), text: await readFile(file, "utf8") })));
}

// 번들러는 45000000을 45e6처럼 짧게 쓴다. 두 표기를 모두 본다.
function numberForms(value) {
  const plain = String(value);
  const zeros = plain.match(/0+$/)?.[0].length ?? 0;
  return zeros >= 3 ? [plain, `${plain.slice(0, -zeros)}e${zeros}`] : [plain];
}
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 표지 이름 → 값 목록. 값은 절대 출력하지 않는다. */
function seedMarkers() {
  const strings = (key) => [...new Set(companyEmployees.map((employee) => String(employee[key] ?? "").trim()).filter((value) => value.length >= 2))];
  const salaryPatterns = [];
  for (const key of ["annualSalary", "basePay"]) {
    for (const value of new Set(companyEmployees.map((employee) => Number(employee[key]) || 0).filter((value) => value > 0))) {
      const forms = numberForms(value).map(escapeRegExp).join("|");
      salaryPatterns.push(new RegExp(`\\b${key}["']?\\s*:\\s*(?:${forms})(?![\\d.e])`));
    }
  }
  // 전화 칸에 번호 대신 짧은 안내 문구가 든 행이 있다. 숫자가 7개 이상인 값만 전화로 본다.
  const phones = strings("phone").filter((phone) => phone.replace(/\D/g, "").length >= 7);
  return {
    names: strings("name"),
    phones: [...phones, ...phones.map((phone) => phone.replace(/\D/g, "")).filter((digits) => digits.length >= 10)],
    emails: strings("email").filter((email) => email.includes("@")).map((email) => email.toLowerCase()),
    salaryPatterns,
  };
}

// 입력칸 예시(010-0000-0000, 010-1234-5678 같은 자리표시자)만 허용한다.
const phonePattern = /01\d-\d{3,4}-\d{4}/g;
const isPlaceholderPhone = (value) => /^01\d-(?:0{3,4}|1234)-(?:0000|5678)$/.test(value);

// 재무 실데이터(finance-current-data 등, 작업 트리 밖으로 보관)의 식별자와 최상위 키. 번들러가 이름을 바꿔도 키 문자열은 남는다.
const financeMarkers = [
  "financeCurrentData", "financeHistoricalData", "finance-current-data", "finance-historical-data",
  "salesDaily2026", "salesMonthly2026", "purchaseDaily2026", "purchaseMonthly2026", "journalSummary",
];

function countFiles(assets, predicate) {
  const hits = assets.filter(({ text }) => predicate(text)).map(({ name }) => name);
  return { count: hits.length, files: hits.slice(0, 5).join(", ") };
}

test("the client bundle exists (npm test builds first)", () => {
  assert.ok(existsSync(clientDir), "dist/client가 없습니다. npm run build 뒤에 실행하세요.");
});

test("the server seed yields enough markers for the check to mean something", () => {
  const markers = seedMarkers();
  assert.ok(companyEmployees.length >= 20, "직원 시드를 읽지 못했습니다");
  assert.ok(markers.names.length >= 20, "이름 표지가 너무 적습니다");
  assert.ok(markers.phones.length >= 10, "전화 표지가 너무 적습니다");
  assert.ok(markers.emails.length >= 10, "이메일 표지가 너무 적습니다");
  assert.ok(markers.salaryPatterns.length >= 10, "급여 표지가 너무 적습니다");
});

test("dist/client carries no real employee names, phones, personal emails or salary values from the server seed", async () => {
  const assets = await readTextAssets(clientDir);
  assert.ok(assets.some(({ name }) => name.endsWith(".js")), "dist/client에 JS 번들이 없습니다");
  const markers = seedMarkers();

  const names = countFiles(assets, (text) => markers.names.some((name) => text.includes(name)));
  assert.equal(names.count, 0, `실제 직원 이름이 든 파일 ${names.count}개: ${names.files}`);

  const phones = countFiles(assets, (text) => markers.phones.some((phone) => text.includes(phone)));
  assert.equal(phones.count, 0, `실제 전화번호가 든 파일 ${phones.count}개: ${phones.files}`);

  const genericPhones = countFiles(assets, (text) => [...text.matchAll(phonePattern)].some(([value]) => !isPlaceholderPhone(value)));
  assert.equal(genericPhones.count, 0, `자리표시자가 아닌 휴대전화 형식이 든 파일 ${genericPhones.count}개: ${genericPhones.files}`);

  const emails = countFiles(assets, (text) => {
    const lower = text.toLowerCase();
    return markers.emails.some((email) => lower.includes(email));
  });
  assert.equal(emails.count, 0, `시드 이메일이 든 파일 ${emails.count}개: ${emails.files}`);

  const salaries = countFiles(assets, (text) => markers.salaryPatterns.some((pattern) => pattern.test(text)));
  assert.equal(salaries.count, 0, `시드 급여 값(annualSalary·basePay)이 든 파일 ${salaries.count}개: ${salaries.files}`);

  const seedKey = countFiles(assets, (text) => text.includes("companyEmployees"));
  assert.equal(seedKey.count, 0, `직원 시드 식별자가 든 파일 ${seedKey.count}개: ${seedKey.files}`);
});

test("dist/client and dist/server carry no finance-current-data markers", async () => {
  for (const dir of [clientDir, serverDir]) {
    if (dir === serverDir && !existsSync(serverDir)) continue;
    const assets = await readTextAssets(dir);
    for (const marker of financeMarkers) {
      const hits = countFiles(assets, (text) => text.includes(marker));
      assert.equal(hits.count, 0, `${path.basename(path.dirname(dir))}/${path.basename(dir)}: 재무 표지 ${marker}가 든 파일 ${hits.count}개: ${hits.files}`);
    }
  }
});

// quote-tool Design §11.7·QT-SC-10(QT1부터): 견적 서버 데이터(고객 연락처·과거 견적·담당자)는 D1 에만 있다.
// dist/client 에 견적 표 이름과 서버 모듈 표지 상수가 0건이어야 한다. 실데이터 표본은 저장소에 넣을 수 없으므로(P-8)
// 저장소 밖 표지 파일(QUOTE_PII_MARKERS, 기본 C:\xdm\secure\quote-markers.json)이 있을 때만 그 기관명·휴대폰도 본다. 값은 출력하지 않는다.
const quoteStructuralMarkers = ["quote_customers", "quote_issued", "quote_corpus_", "quote_price_log", "quote_staff_profiles", "xdm-quote-server-only"];
// QT3b: AI 추출 프롬프트(app/quote-extract.ts)·브리지 경로·단가 제안 구현(app/quote-pricing.ts)·추출 감사 이름도 서버에만 있다. 화면은 타입만 가져온다.
quoteStructuralMarkers.push("견적 작성 보조자", "/quote-extract", "suggestion keys drifted", "QUOTE_AI_EXTRACTED", "enrichExtracted");

test("dist/client carries no quote server table names or the quote-server marker", async () => {
  const assets = await readTextAssets(clientDir);
  for (const marker of quoteStructuralMarkers) {
    const hits = countFiles(assets, (text) => text.includes(marker));
    assert.equal(hits.count, 0, `견적 서버 표지 ${marker}가 든 파일 ${hits.count}개: ${hits.files}`);
  }
});

test("dist/client carries no quote PII markers from the off-repo marker file (skipped when the file is absent)", async (t) => {
  const file = process.env.QUOTE_PII_MARKERS || "C:\\xdm\\secure\\quote-markers.json";
  if (!existsSync(file)) { t.skip("견적 표지 파일이 없어 건너뜁니다(scripts/import-quote-data.mjs --markers-out 으로 만든다)."); return; }
  let markers;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    markers = [...(Array.isArray(parsed.orgs) ? parsed.orgs : []), ...(Array.isArray(parsed.phones) ? parsed.phones : [])]
      .filter((value) => typeof value === "string" && value.trim().length >= 2).map((value) => value.trim());
  } catch {
    assert.fail("견적 표지 파일을 읽지 못했습니다(내용은 출력하지 않습니다).");
  }
  assert.ok(markers.length > 0, "견적 표지 파일에 표지가 없습니다");
  const assets = await readTextAssets(clientDir);
  const hits = countFiles(assets, (text) => markers.some((marker) => text.includes(marker)));
  assert.equal(hits.count, 0, `견적 PII 표지가 든 파일 ${hits.count}개: ${hits.files}`);
});
