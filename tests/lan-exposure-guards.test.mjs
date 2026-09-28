import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 사내망 노출을 막는 R0 조치가 조용히 되돌아가지 않도록 소스를 지킨다
// (docs/01-plan/features/xdnode-management.plan.md §2.1 R0, D16·D17).
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("dev server stays on this PC, with the Miniflare explorer off and state files unserved", async () => {
  const [launcher, viteConfig] = await Promise.all([read("scripts/Start-XDNodeERP.ps1"), read("vite.config.ts")]);
  // D16: R3 운영 전환 전까지 dev 서버는 서버 PC 에서만 접속된다.
  assert.match(launcher, /npm\.cmd run dev -- --port \$Port --hostname 127\.0\.0\.1/);
  assert.doesNotMatch(launcher, /--hostname 0\.0\.0\.0/);
  assert.match(launcher, /\$env:X_LOCAL_EXPLORER = "false"/);
  // explorer 는 D1 에 임의 SQL 을 실행하는 API 를 연다. ??= 로 두면 상위 셸의 "true" 가 이긴다.
  assert.match(viteConfig, /process\.env\.X_LOCAL_EXPLORER = "false";/);
  assert.doesNotMatch(viteConfig, /X_LOCAL_EXPLORER \?\?=/);
  assert.match(viteConfig, /fs: \{ deny: DEV_FS_DENY \}/);
  const denyList = viteConfig.match(/const DEV_FS_DENY = \[([\s\S]*?)\];/)?.[1] ?? "";
  // Vite 기본 거부 목록을 덮어쓰므로 기본값도 함께 있어야 한다.
  for (const pattern of [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/*.tar.gz"]) {
    assert.ok(denyList.includes(`"${pattern}"`), `DEV_FS_DENY 에 ${pattern} 이 없습니다`);
  }
  // 폴더 패턴은 프로젝트 루트에 묶는다. "**/dist/**" 는 node_modules/*/dist 까지 막아 dev 서버가 뜨지 못한다.
  for (const folder of [".wrangler", "dist", "deliverables", ".vinext"]) {
    assert.ok(denyList.includes(`\`\${PROJECT_ROOT}/${folder}/**\``), `DEV_FS_DENY 에 루트 ${folder} 가 없습니다`);
  }
  assert.doesNotMatch(denyList, /"\*\*\/(dist|\.wrangler|\.vinext|deliverables)\/\*\*"/);
  // 영업 시트 자격증명은 더 Worker 로 넘기지 않는다.
  assert.doesNotMatch(viteConfig, /GOOGLE_/);
});

test("assistant bridges run Claude with no tools, outside the repository, for server-to-server calls only", async () => {
  const [assistant, resume, codex] = await Promise.all([
    read("scripts/claude-assistant-bridge.mjs"), read("scripts/claude-resume-bridge.mjs"), read("scripts/codex-assistant-bridge.mjs"),
  ]);
  for (const [name, source] of [["claude-assistant-bridge", assistant], ["claude-resume-bridge", resume]]) {
    // D17: 내장 도구를 모두 끄고, CLI 가 --tools 를 무시해도 파일 읽기·실행 도구는 차단 목록에 걸린다.
    assert.match(source, /"--tools", "",/, `${name}: --tools "" 가 없습니다`);
    const disabled = source.match(/const DISABLED_TOOLS = \[([\s\S]*?)\];/)?.[1] ?? "";
    for (const tool of ["Read", "Grep", "Glob", "PowerShell", "Bash", "Write", "Edit"]) {
      assert.ok(disabled.includes(`"${tool}"`), `${name}: DISABLED_TOOLS 에 ${tool} 이 없습니다`);
    }
    // 저장소 루트에서 돌면 .env.local·직원 명부를 읽을 수 있다.
    assert.doesNotMatch(source, /cwd: PROJECT_PATH/, `${name}: 저장소를 작업 폴더로 씁니다`);
  }
  assert.match(assistant, /cwd: RUN_DIRECTORY/);
  assert.match(assistant, /mkdtemp\(join\(tmpdir\(\), "xdnode-assistant-"\)\)/);
  // 요청을 처리하는 동안에는 저장소 파일을 열지 않는다. 스키마와 buildPrompt 는 시작할 때 한 번만 읽는다.
  assert.doesNotMatch(assistant, /loadSchema\(\)/);
  assert.doesNotMatch(assistant, /await Promise\.all\(\[loadBuildPrompt\(\), /);
  assert.doesNotMatch(codex, /프로젝트 파일은 읽기 전용으로만 검토하세요/);

  for (const [name, source] of [["claude-assistant-bridge", assistant], ["claude-resume-bridge", resume], ["codex-assistant-bridge", codex]]) {
    // 브라우저가 직접 부르면 /api/* 의 권한 검사를 건너뛴다. Origin 이 붙은 요청과 이 PC 가 아닌 Host 는 거부한다.
    assert.match(source, /const ALLOWED_HOSTS = new Set\(\[`127\.0\.0\.1:\$\{PORT\}`, `localhost:\$\{PORT\}`\]\);/, `${name}: Host 허용 목록이 없습니다`);
    assert.match(source, /request\.headers\.origin !== undefined \|\| !ALLOWED_HOSTS\.has\(String\(request\.headers\.host \?\? ""\)\)/, `${name}: Origin·Host 검사가 없습니다`);
    assert.doesNotMatch(source, /Access-Control-Allow-Origin/, `${name}: CORS 를 열어 둡니다`);
    assert.match(source, /const HOST = "127\.0\.0\.1"/);
  }
});
