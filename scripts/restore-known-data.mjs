// 실서버(배포본)가 내려가기 전에 확인해 둔 값만 로컬로 되돌린다.
//
// 배포가 취소되면서 D1 을 직접 읽을 방법이 사라졌고, 앱 API 로도 더는 반출할 수 없다.
// 여기 담긴 것은 작업 중 실제로 조회해 응답으로 확인한 값뿐이다. 추측으로 채운 값은 없다.
//
// 실행:  XDM_EMAIL=… XDM_PASSWORD=… node scripts/restore-known-data.mjs            (기본 http://127.0.0.1:3000)
//        node scripts/restore-known-data.mjs --dry-run  (무엇을 넣을지만 출력. 조회는 하므로 로그인은 필요하다)
//        node scripts/restore-known-data.mjs --cookie xdm_session=…   (이미 받은 세션 쿠키)
//        BASE_URL=http://127.0.0.1:3001 node scripts/restore-known-data.mjs
//
// DB 에 직접 쓰지 않고 앱 API 만 호출한다. 감사기록과 상태 전이 규칙이 그대로 적용되고,
// 이미 있는 항목은 건너뛰므로 두 번 돌려도 중복이 생기지 않는다.
// R3 부터 API 는 세션이 필요하다. scripts/xdm-login.mjs 로 로그인하고, 쓰기 요청에는 Origin 을 붙인다.
// 계정에는 인사관리 편집 권한이 있어야 한다.
import { connectXdm } from "./xdm-login.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const DRY = process.argv.includes("--dry-run");
const cookieIndex = process.argv.indexOf("--cookie");
const COOKIE = cookieIndex >= 0 ? process.argv[cookieIndex + 1] ?? "" : "";
let client;

// 실서버 /api/hr/recruitment-requisitions 응답에서 확인한 값.
const REQUISITIONS = [
  {
    organizationId: "org-online", role: "온라인MD", requestedHeadcount: 1,
    targetStartDate: "2026-09-01", reason: "기존 인원 퇴사에 따른 인원 채용",
    note: "실서버에서 모집 중이던 건",
  },
  {
    organizationId: "org-purchase", role: "물류팀", requestedHeadcount: 1,
    targetStartDate: "2026-09-01", reason: "",
    note: "실서버에서 반려된 건 — 등록만 하고 결재는 태우지 않음",
  },
];

const log = (...args) => console.log(...args);

async function api(path, init) {
  const response = await client.fetch(path, init);
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 200) }; }
  return { ok: response.ok, status: response.status, payload };
}

async function restoreRequisitions() {
  log("\n[채용요청]");
  const before = await api("/api/hr/recruitment-requisitions");
  if (!before.ok) throw new Error(`채용요청 조회 실패 (${before.status})`);
  const existing = new Set((before.payload.requisitions ?? []).map((row) => `${row.organizationId}:${row.role}`));

  for (const item of REQUISITIONS) {
    if (existing.has(`${item.organizationId}:${item.role}`)) { log(`  건너뜀 ${item.role} — 이미 있음`); continue; }
    if (DRY) { log(`  넣을 것 ${item.role} · ${item.requestedHeadcount}명 · ${item.targetStartDate} (${item.note})`); continue; }
    const { note, ...draft } = item;
    const created = await api("/api/hr/recruitment-requisitions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "CREATE_DRAFT", ...draft }),
    });
    // D2-개정: 결재 없이 곧바로 모집을 시작한다. 모집 시작이 거부되면(opened:false) 작성 중으로 남는다.
    log(created.ok ? `  넣음   ${item.role} · ${created.payload.opened ? "모집 중" : `작성 중${created.payload.openError ? ` — ${created.payload.openError}` : ""}`} (${note})`
      : `  실패   ${item.role} — ${created.payload.error ?? created.status}`);
  }
}

async function main() {
  log(`대상 서버: ${BASE}${DRY ? "  (미리보기 — 아무것도 쓰지 않음)" : ""}`);
  client = await connectXdm(BASE, { cookie: COOKIE });
  const health = await api("/api/hr/recruitment-requisitions");
  if (health.status === 401) throw new Error("401 — 세션이 없거나 만료됐습니다. XDM_EMAIL·XDM_PASSWORD 로 다시 로그인하세요.");
  if (health.status === 403) throw new Error(`403 ${health.payload.code ?? ""} — 이 계정에 인사관리 권한이 없거나 비밀번호 변경이 필요합니다.`);
  if (!health.ok) throw new Error(`서버 응답 이상 (${health.status}). 로컬 서버가 실행 중인지 확인하세요.`);

  // 퇴직요청 4건과 생애주기 업무 40건은 로컬 DB 에 그대로 남아 있어 손대지 않는다.
  const ops = await api("/api/hr/operations");
  log(`
[확인] 퇴직요청 ${(ops.payload.retirementRequests ?? []).length}건 · 생애주기 업무 ${(ops.payload.lifecycleTasks ?? []).length}건 — 이미 있어 건드리지 않습니다.`);
  await restoreRequisitions();

  log("\n[이 스크립트로 되살아나지 않는 것]");
  log("  · 임금안 2026-08 (28명) — 임금계산에서 HR 자료를 다시 불러와 만들어야 합니다.");
  log("  · 퇴직 정산 금액 — 퇴직자 팝업에서 추정액을 확인하고 직접 입력하세요.");
  log("  · 지원자 5명 — 상세를 확인해 둔 값이 없어 제외했습니다.");
  log("  · 결재 이력 7건, 퇴직 정산 금액 1건.");
}

main().catch((error) => { console.error("\n중단:", error.message); process.exitCode = 1; });
