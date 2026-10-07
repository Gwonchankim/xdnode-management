// 견적 AI 브리지 테스트용 가짜 claude 실행기(quote-tool Design §11.6, tests/quote-bridge.test.mjs).
// 브리지가 scripts/lib/claude-cli.mjs 를 거쳐 실제 claude 와 같은 인자로 띄운다(XD_NODE_CLAUDE_BIN 에 이 파일 경로).
// 받은 인자·작업 폴더·작업 폴더 안 파일 목록·표준입력을 FAKE_CLAUDE_LOG_DIR/run-<pid>.json 에 남기고, 정해진 결과 봉투를 낸다.
// 동작은 표준입력 글에 든 표지로 고른다: "mode:ok"(기본), "mode:bad-schema"(스키마 밖 키), "mode:fence"(코드펜스로 감쌈),
// "mode:sleep-<ms>"(기다린 뒤 ok), "mode:exit-<n>"(종료 코드 n), "mode:not-json"(JSON 이 아닌 글).
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  if (process.env.FAKE_CLAUDE_LOG_DIR) {
    writeFileSync(join(process.env.FAKE_CLAUDE_LOG_DIR, `run-${process.pid}.json`), JSON.stringify({
      pid: process.pid, cwd: process.cwd(), cwdFiles: readdirSync(process.cwd()), args, stdin,
      env: { CLAUDECODE: process.env.CLAUDECODE ?? null, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null },
    }));
  }
  const mode = /mode:([a-z]+(?:-[a-z0-9]+)?)/.exec(stdin)?.[1] ?? "ok";
  const stream = args.includes("stream-json");
  let result = JSON.stringify({ answer: "ok", images: (stdin.match(/"type":"image"/g) ?? []).length });
  if (mode === "bad-schema") result = JSON.stringify({ answer: 1, memo: "C:\\secret\\.env" });
  if (mode === "fence") result = "결과입니다.\n```json\n{\"answer\":\"fenced\",\"images\":0}\n```";
  if (mode === "not-json") result = "죄송합니다. 읽을 수 없습니다.";
  const envelope = { type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0.001, duration_ms: 7, usage: { input_tokens: 1, output_tokens: 1 } };
  const finish = () => {
    if (stream) process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify(envelope)}\n`);
    else process.stdout.write(JSON.stringify(envelope));
    process.exit(0);
  };
  let match;
  if ((match = /^exit-(\d+)$/.exec(mode))) { process.stderr.write("fake failure"); process.exit(Number(match[1])); }
  else if ((match = /^sleep-(\d+)$/.exec(mode))) setTimeout(finish, Number(match[1]));
  else finish();
});
