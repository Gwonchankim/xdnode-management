import { fileURLToPath } from "node:url";
import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { localPeerPlugin } from "./build/local-peer-vite-plugin";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

// dev 서버가 파일로 내주면 안 되는 경로. 앞의 네 개는 Vite 기본값이라 목록을 덮어써도 빠지지 않게 다시 적는다.
// .wrangler 에는 실제 D1(sqlite)·R2 파일이, 나머지에는 빌드 산출물·스냅샷·로그가 있다.
// 폴더 패턴은 프로젝트 루트에 묶는다. "**/dist/**" 처럼 두면 node_modules/*/dist 까지 막혀 dev 서버가 자기 모듈을 못 읽는다.
const PROJECT_ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const DEV_FS_DENY = [
  ".env", ".env.*", "*.{crt,pem}", "**/.git/**",
  `${PROJECT_ROOT}/.wrangler/**`, `${PROJECT_ROOT}/dist/**`, `${PROJECT_ROOT}/deliverables/**`, `${PROJECT_ROOT}/.vinext/**`,
  "**/*.tar.gz",
];

export default defineConfig(async ({ command, mode }) => {
  // Miniflare 로컬 explorer(/cdn-cgi/explorer)는 기본으로 켜져 있고, D1 에 임의 SQL 을 실행하는 API 를 연다.
  // 이 앱은 쓰지 않으므로 끈다. 상위 셸에서 "true" 가 넘어와도 다시 켜지지 않도록 ??= 가 아니라 대입한다.
  process.env.X_LOCAL_EXPLORER = "false";
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const fileEnv = command === "serve" ? loadEnv(mode, process.cwd(), "") : {};
  // Worker 로 넘기는 값은 이 허용 목록 5개뿐이다(Design §10.3). preview 는 같은 목록을 scripts/write-dev-vars.mjs 가
  // dist/server/.dev.vars 에 쓴다. 두 목록이 같은지는 tests/lan-exposure-guards.test.mjs 가 확인한다.
  // build 에서는 fileEnv 가 비어 있어 dist/server/wrangler.json 의 vars 에 비밀값이 들어가지 않는다.
  const localRuntimeVars = Object.fromEntries(
    ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_TRANSCRIPTION_MODEL",
      // 이력서 분석은 Claude CLI 다리 하나만 쓴다(scripts/claude-resume-bridge.mjs).
      // 값이 없으면 http://127.0.0.1:3120 을 쓴다.
      "CLAUDE_BRIDGE_URL",
      // HR·임금계산·인센티브 AI 어시스턴트 다리(scripts/claude-assistant-bridge.mjs). 값이 없으면 http://127.0.0.1:3130 을 쓴다.
      "CLAUDE_ASSISTANT_BRIDGE_URL"]
      .map((key) => [key, fileEnv[key]] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    vars: localRuntimeVars,
    d1_databases: d1
      ? [
          {
            binding: d1,
            database_name: "site-creator-d1",
            database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
          },
        ]
      : [],
    r2_buckets: r2
      ? [
          {
            binding: r2,
            bucket_name: "site-creator-r2",
          },
        ]
      : [],
  };

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    // allowedHosts 는 기본값([] = IP·localhost 만)을 둔다. DNS rebinding 을 막는 층이 Vite hostValidation 뿐이라
    // PC 이름을 더하지 않는다(Design §7.3, 부록 C #8). 접속 주소는 IP 로 안내한다.
    server: {
      fs: { deny: DEV_FS_DENY },
      // vinext dev 는 --strictPort 를 읽지 않는다. 3100 이 차 있으면 다른 포트로 옮겨 가지 않고 실패하게 여기서 건다(부록 C #25).
      strictPort: true,
      ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
    },
    preview: { strictPort: true },
    // local-peer 플러그인은 배열 첫 항목이고 enforce:"pre" 다(Design §7.6). 정렬 기준이 바뀌어도 디스패처보다 앞에 선다.
    plugins: [
      localPeerPlugin(),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
        // 인스펙터(dev 9229·preview 9230)를 열지 않는다. /__debug 도 next() 로 넘어간다.
        inspectorPort: false,
      }),
    ],
  };
});
