// 빌드할 때마다 preview 용 dist/server/.dev.vars 를 쓴다(Design §11.5.5, §10.3, Plan M5a).
//
//   node scripts/write-dev-vars.mjs [--env <파일>] [--out <파일>]
//
// vite preview 는 빌드 산출물의 vars:{} 와 dist/server/.dev.vars 만 읽고, vinext build 는 매번 dist 를 지운다.
// .env.local 에서 허용 목록 5개만 골라 쓴다. 값은 출력하지 않고 키 이름만 출력한다.
// 이 파일에는 토큰이 평문으로 있다. dist/client 에는 들어가지 않고(.assetsignore), HTTP 로 새지 않는지는 R3 스모크(SC-9)가 본다.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export const DEV_VARS_ALLOWLIST = Object.freeze([
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_TRANSCRIPTION_MODEL",
  "CLAUDE_BRIDGE_URL",
  "CLAUDE_ASSISTANT_BRIDGE_URL",
]);

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** dotenv 본문에서 허용 목록 키만 고른다. 빈 값은 뺀다. */
export function selectDevVars(envText) {
  const parsed = parseEnv(String(envText ?? ""));
  const selected = {};
  for (const key of DEV_VARS_ALLOWLIST) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim() !== "") selected[key] = value;
  }
  return selected;
}

/** wrangler 가 되읽을 때 값이 바뀌지 않게 따옴표를 고른다(@cloudflare/vite-plugin quoteForDotenv 와 같은 규칙). */
export function quoteDevVar(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return `\`${value}\``;
  if (!value.includes("\"") && !/[\\\n\r]/.test(value)) return `"${value}"`;
  throw new Error(".dev.vars 에 쓸 수 없는 값입니다(따옴표 세 종류를 모두 포함).");
}

export function serializeDevVars(vars) {
  return Object.entries(vars).map(([key, value]) => `${key}=${quoteDevVar(value)}\n`).join("");
}

function main(argv) {
  const option = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  const envFile = resolve(option("--env") ?? resolve(PROJECT_ROOT, ".env.local"));
  const outFile = resolve(option("--out") ?? resolve(PROJECT_ROOT, "dist", "server", ".dev.vars"));
  if (!existsSync(dirname(outFile))) {
    console.error(`빌드 산출물이 없습니다: ${dirname(outFile)} — 먼저 npm run build 를 실행하세요.`);
    return 2;
  }
  const vars = existsSync(envFile) ? selectDevVars(readFileSync(envFile, "utf8")) : {};
  writeFileSync(outFile, serializeDevVars(vars), { encoding: "utf8", mode: 0o600 });
  const keys = Object.keys(vars);
  console.log(`.dev.vars 작성: ${outFile} · 키 ${keys.length}개${keys.length ? ` (${keys.join(", ")})` : ""}${existsSync(envFile) ? "" : " · .env.local 없음"}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
