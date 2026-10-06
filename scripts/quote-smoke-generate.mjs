// 견적 생성 운영 스모크(quote-tool Design §1.2·§6.4·§11.8, QT-SC-01 ⑤·QT-SC-08).
//
//   node scripts/quote-smoke-generate.mjs --base http://127.0.0.1:3000 [--only N] [--no-pdf] [--discard] [--out <저장소 밖 폴더>] [--cookie "xdm_session=…"]
//
// tests/fixtures/quote/regression/*.quote.json(익명화한 회귀 5건)을 오늘 날짜·접미 '스모크'로 POST /api/quote/issued GENERATE 한다(관리자 또는 견적 편집 권한).
// 로그인은 scripts/xdm-login.mjs 의 connectXdm(XDM_EMAIL·XDM_PASSWORD 또는 --cookie)이고, 비GET 에는 Origin 이 자동으로 붙는다.
//   --only N    N번째 건만(1~5). 첫날 세션 시험(§6.4-2)은 --only 1
//   --no-pdf    PDF 를 만들지 않는다(도우미 없이 xlsx·기록만 확인)
//   --discard   끝나면 만든 견적을 폐기한다(SET_STATUS discarded, 행은 남는다)
//   --out DIR   받은 xlsx·pdf 를 저장소 밖 폴더에 저장한다(Excel 로 열어 '복구'가 없는지, PDF 1쪽인지 눈으로 확인)
// 화면에는 사례 이름·번호·소요 ms·PDF 쪽수·오류 코드만 찍는다. 하나라도 실패하면 종료 코드 1.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { connectXdm } from "./xdm-login.mjs";

const REPO = resolve(import.meta.dirname, "..");
const FIXTURES = join(REPO, "tests", "fixtures", "quote", "regression");
const CASES = ["server_group_span", "parts_priced_items", "mixed_gpu_nas", "no_set_col_dgx", "server_with_notes"];

function parseArgs(argv) {
  const options = { base: "http://127.0.0.1:3000", only: 0, pdf: true, discard: false, out: "", cookie: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 다음에 값이 필요합니다.`);
      index += 1;
      return value;
    };
    if (arg === "--base") options.base = next();
    else if (arg === "--only") options.only = Number(next());
    else if (arg === "--no-pdf") options.pdf = false;
    else if (arg === "--discard") options.discard = true;
    else if (arg === "--out") options.out = resolve(next());
    else if (arg === "--cookie") options.cookie = next();
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if (options.only && !(Number.isInteger(options.only) && options.only >= 1 && options.only <= CASES.length)) throw new Error(`--only 는 1~${CASES.length} 입니다.`);
  if (options.out && !relative(REPO, options.out).startsWith("..")) throw new Error("--out 은 저장소 밖 폴더여야 합니다.");
  return options;
}

const countPages = (bytes) => (Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;

async function postJson(client, path, body) {
  const raw = JSON.stringify(body);
  const response = await client.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) }, body: raw });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const available = new Set(readdirSync(FIXTURES).filter((name) => name.endsWith(".quote.json")).map((name) => name.replace(/\.quote\.json$/, "")));
  const cases = (options.only ? [CASES[options.only - 1]] : CASES).filter((name) => available.has(name));
  const client = await connectXdm(options.base, options.cookie ? { cookie: options.cookie } : {});
  if (options.out) mkdirSync(options.out, { recursive: true });
  const created = [];
  let failures = 0;
  for (const name of cases) {
    const quote = { ...JSON.parse(readFileSync(join(FIXTURES, `${name}.quote.json`), "utf8")), issue_date: null };
    const started = Date.now();
    const result = await postJson(client, "/api/quote/issued", { action: "GENERATE", quote, suffix: "스모크", pdf: options.pdf });
    const ms = Date.now() - started;
    const line = { case: name, status: result.status, ms, issuedId: result.body.issuedId ?? null, rev: result.body.rev ?? null,
      xlsx: result.body.files?.xlsx ?? false, pdf: result.body.files?.pdf ?? false, pdfError: result.body.pdfError?.code ?? null, code: result.body.code ?? null };
    if (result.status !== 200) failures += 1;
    if (result.body.issuedId) created.push(result.body.issuedId);
    if (result.status === 200 && options.pdf && !line.pdf) failures += 1;
    if (result.status === 200 && (line.pdf || options.out)) {
      for (const kind of line.pdf ? ["xlsx", "pdf"] : ["xlsx"]) {
        const response = await client.fetch(`/api/quote/files?issuedId=${line.issuedId}&kind=${kind}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (kind === "pdf") {
          line.pages = countPages(bytes);
          if (line.pages !== 1) failures += 1;
        }
        if (options.out && response.ok) writeFileSync(join(options.out, `${name}.${kind}`), bytes);
      }
    }
    console.log(JSON.stringify(line));
  }
  if (options.discard && created.length) {
    const discarded = await postJson(client, "/api/quote/issued", { action: "SET_STATUS", ids: created, status: "discarded" });
    console.log(JSON.stringify({ discard: discarded.status, changed: discarded.body.changed ?? null }));
    if (discarded.status !== 200) failures += 1;
  }
  console.log(JSON.stringify({ cases: cases.length, created: created.length, failures }));
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(`quote-smoke-generate: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
