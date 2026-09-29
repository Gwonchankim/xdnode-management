import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 사내망 노출을 막는 R0 조치가 조용히 되돌아가지 않도록 소스를 지킨다
// (docs/01-plan/features/xdnode-management.plan.md §2.1 R0, D16·D17).
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("dev server stays on this PC, with the Miniflare explorer off and state files unserved", async () => {
  const [launcher, viteConfig] = await Promise.all([read("scripts/Start-XDNodeManagement.ps1"), read("vite.config.ts")]);
  // D16: dev 서버는 서버 PC 에서만 접속된다. R3 부터 시작 스크립트는 dev 가 아니라 preview 를 띄운다(아래 R3 테스트).
  assert.doesNotMatch(launcher, /npm\.cmd run dev\b/);
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

// ── R3(r3-runtime): preview 운영 전환(Design §7.6, §11.5.3~§11.5.5, §8.6 lan-exposure-guards R3 행, 부록 C #7·#8·#25) ──────────
const root = fileURLToPath(new URL("..", import.meta.url));

test("R3: npm scripts run dev on 127.0.0.1:3100 and serve the build with vite preview, never vinext start", async () => {
  const { scripts } = JSON.parse(await read("package.json"));
  assert.equal(scripts.dev, "vinext dev --hostname 127.0.0.1 --port 3100 --strictPort");
  assert.equal(scripts["serve:lan"], "vite preview --host 0.0.0.0 --port 3000 --strictPort");
  assert.equal(scripts.start, "vite preview --host 127.0.0.1 --port 3000 --strictPort");
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(command, /vinext start|wrangler dev/, `${name}: 지원하지 않는 런타임`);
    if (/vinext dev/.test(command)) assert.match(command, /--hostname 127\.0\.0\.1/, `${name}: dev 는 127.0.0.1 전용(D16)`);
  }
});

test("R3: the launcher builds, writes .dev.vars, forces the explorer off and starts preview, refusing to run behind a portproxy", async () => {
  const launcher = await read("scripts/Start-XDNodeManagement.ps1");
  const order = [
    "netsh.exe interface portproxy show all", '$env:X_LOCAL_EXPLORER = "false"', "npm.cmd run build", "scripts\\write-dev-vars.mjs",
    "npm.cmd run serve:lan", "npm.cmd run resume:bridge", "npm.cmd run assistant:claude",
  ];
  let last = -1;
  for (const marker of order) {
    const index = launcher.indexOf(marker);
    assert.ok(index > last, `시작 스크립트 순서: ${marker}`);
    last = index;
  }
  assert.match(launcher, /dist\\\.build-rev/);
  assert.match(launcher, /git -C \$ProjectPath rev-parse HEAD/);
  // 부록 C #7: portproxy 가 있으면 LAN 요청이 루프백으로 보여 D21 예외와 부트스트랩 제한이 뚫린다.
  assert.match(launcher, /if \(\$portProxy\.Count -gt 0\) \{\s*Stop-WithMessage/);
  assert.match(launcher, /\$env:XD_NODE_PROJECT_PATH = \$ProjectPath/);
  assert.match(launcher, /vite\.js preview --host 0\.0\.0\.0 --port \$Port --strictPort/);
  const code = launcher.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /vinext start|wrangler dev|npm\.cmd run start|npm\.cmd run dev/);
});

test("R3: vite.config puts the local-peer plugin first with enforce pre, turns the inspector off and keeps allowedHosts default", async () => {
  const [viteConfig, pluginSource] = await Promise.all([read("vite.config.ts"), read("build/local-peer-vite-plugin.ts")]);
  assert.match(viteConfig, /import \{ localPeerPlugin \} from "\.\/build\/local-peer-vite-plugin";/);
  assert.match(viteConfig, /plugins: \[\s*localPeerPlugin\(\),\s*vinext\(\),\s*sites\(\),\s*cloudflare\(\{/);
  assert.match(viteConfig, /inspectorPort: false,/);
  // 부록 C #25: vinext dev 는 --strictPort 를 읽지 않으므로 설정으로 건다.
  assert.match(viteConfig, /strictPort: true,/);
  // 부록 C #8: DNS rebinding 을 막는 층은 Vite hostValidation 뿐이다. PC 이름을 허용 목록에 넣지 않는다.
  assert.doesNotMatch(viteConfig, /allowedHosts\s*:/);
  assert.doesNotMatch(viteConfig, /LOCAL_ERP_USER|CLOUDFLARE_AI_MODEL/);
  assert.match(pluginSource, /name: "xdm-local-peer",\s*enforce: "pre",/);
  assert.match(pluginSource, /configureServer\(server\) \{\s*server\.middlewares\.use\(peerMiddleware\);/);
  assert.match(pluginSource, /configurePreviewServer\(server\) \{\s*server\.middlewares\.use\(peerMiddleware\);/);
  assert.match(pluginSource, /import \{ LOOPBACK_ADDRESSES, PEER_HEADER \} from "\.\.\/app\/auth-session";/);
});

test("R3: .dev.vars carries only the five allow-listed keys, the same list vite.config passes to dev", async () => {
  const devVars = await import("../scripts/write-dev-vars.mjs");
  const expected = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_TRANSCRIPTION_MODEL", "CLAUDE_BRIDGE_URL", "CLAUDE_ASSISTANT_BRIDGE_URL"];
  assert.deepEqual([...devVars.DEV_VARS_ALLOWLIST], expected);
  const viteConfig = await read("vite.config.ts");
  const listed = viteConfig.match(/const localRuntimeVars = Object\.fromEntries\(\s*\[([\s\S]*?)\]\s*\.map/)?.[1] ?? "";
  assert.deepEqual([...listed.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]), expected);
  const selected = devVars.selectDevVars([
    "CLOUDFLARE_ACCOUNT_ID=acct", "CLOUDFLARE_API_TOKEN='tok en'", "LOCAL_ERP_USER_EMAIL=someone@example.invalid", "GOOGLE_OAUTH_CLIENT_SECRET=x",
    "CLAUDE_BRIDGE_URL=", "# CLAUDE_ASSISTANT_BRIDGE_URL=commented", "XDM_PASSWORD=never",
  ].join("\n"));
  assert.deepEqual(selected, { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok en" });
  assert.equal(devVars.serializeDevVars({ A: "plain", B: "it's", C: "a'b`c" }), "A='plain'\nB=`it's`\nC=\"a'b`c\"\n");
  assert.throws(() => devVars.quoteDevVar("'`\""));
  // 값은 출력하지 않는다: 콘솔에는 키 이름과 개수만 찍는다.
  const source = await read("scripts/write-dev-vars.mjs");
  assert.doesNotMatch(source, /console\.(log|error)\([^)]*vars\[/);
  assert.match(source, /키 \$\{keys\.length\}개/);
});

test("R3: the built client contains no .dev.vars or .env files", async (t) => {
  const client = path.join(root, "dist", "client");
  if (!existsSync(client)) { t.skip("dist/client 가 없습니다(npm test 는 먼저 빌드한다)"); return; }
  const leaked = (await readdir(client, { recursive: true })).map(String).filter((name) => /(^|[\\/])\.(dev\.vars|env)([.\\/]|$)/.test(name));
  assert.deepEqual(leaked, []);
  // @cloudflare/vite-plugin 은 .assetsignore 에 wrangler.json·.dev.vars 를 넣는다.
  const assetsIgnore = await readFile(path.join(client, ".assetsignore"), "utf8");
  assert.match(assetsIgnore, /^\.dev\.vars$/m);
  assert.match(assetsIgnore, /^wrangler\.json$/m);
});

test("R3: operations scripts log in through xdm-login and the demo packager is gone", async () => {
  assert.ok(!existsSync(path.join(root, "scripts/Package-XDNodeDemo.ps1")), "Package-XDNodeDemo.ps1 은 R3 에서 폐기한다(실데이터 복사, LOCAL_ERP_USER 의존)");
  const login = await import("../scripts/xdm-login.mjs");
  const post = login.xdmHeaders("http://127.0.0.1:3001", "POST", "xdm_session=abc");
  assert.equal(post.get("origin"), "http://127.0.0.1:3001");
  assert.equal(post.get("cookie"), "xdm_session=abc");
  for (const method of ["GET", "HEAD", undefined]) assert.equal(login.xdmHeaders("http://127.0.0.1:3001", method, "").get("origin"), null);
  assert.equal(login.sessionCookieFrom(["other=1; Path=/", "xdm_session=tok; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000"]), "xdm_session=tok");
  assert.equal(login.sessionCookieFrom(["xdm_session=; Max-Age=0"]), "");
  assert.throws(() => login.normalizeBase("http://127.0.0.1:3000/api"));
  for (const file of ["scripts/import-leave-ledger.mjs", "scripts/restore-known-data.mjs", "scripts/sc4-hr-regression.mjs"]) {
    const source = await read(file);
    assert.match(source, /from "\.\/xdm-login\.mjs"/, file);
    assert.doesNotMatch(source, /LOCAL_ERP_USER|autoApproved/, file);
  }
  const xdmLogin = await read("scripts/xdm-login.mjs");
  assert.match(xdmLogin, /process\.env\.XDM_EMAIL/);
  assert.match(xdmLogin, /process\.env\.XDM_PASSWORD/);
  assert.doesNotMatch(xdmLogin, /writeFile/);
});
