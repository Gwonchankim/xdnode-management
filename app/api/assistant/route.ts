import { env } from "cloudflare:workers";
import { authorizeErpRequest, erpError, writeErpAudit } from "../../erp-platform";
import { ASSISTANT_MODULES, isAssistantModule } from "../../access-tabs";

type AssistantBindings = {
  DB: D1Database;
  // HR·임금계산·인센티브 AI 어시스턴트는 데스크탑에서 도는 Claude CLI 다리(scripts/claude-assistant-bridge.mjs)를 쓴다.
  // 예전에는 브라우저가 http://127.0.0.1:3130 을 직접 불렀는데, 태블릿 등 다른 기기에서는 127.0.0.1 이
  // 그 기기 자신을 가리켜 항상 실패했다. 이제 브라우저는 이 라우트만 부르고, 다리 호출은 ERP 서버가
  // 데스크탑 안에서 대신 한다 — 이력서 분석(app/api/hr/resume-analysis/route.ts)과 같은 구조다.
  // 다리는 계속 127.0.0.1 에만 묶여 있어 다른 기기에 열리지 않는다.
  CLAUDE_ASSISTANT_BRIDGE_URL?: string;
};

// 화면의 업무 영역(?module=)을 인가 모듈로 잇는다(D23, Design §4.2.7). 표는 app/access-tabs.ts 의 ASSISTANT_MODULES 다.
// hr → hr 탭 보기, compensation·incentive → 임금 계산 탭 보기. 제안의 적용 버튼은 대상 API 가 편집 권한을 다시 검사한다.
// 동적 모듈을 허용하는 라우트는 이곳 하나뿐이다(§10.4). Object.hasOwn 을 통과한 값만 조회해 __proto__ 같은 키를 막는다.

// 다리(scripts/claude-assistant-bridge.mjs)와 같은 한도. 다리에 닿기 전에 여기서 먼저 거른다.
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_QUESTION_LENGTH = 2000;
// 다리의 RUN_TIMEOUT_MS(300초)보다 조금 길게 잡아, 다리가 낸 시간 초과 안내가 그대로 화면에 닿게 한다.
const BRIDGE_TIMEOUT_MS = 320_000;

export async function POST(request: Request) {
  const bindings = env as unknown as AssistantBindings;

  // 1) 쿼리의 업무 영역 → 2) 리터럴 표로 인가 → 3) 그다음에 본문을 읽는다(부록 B #27). 본문의 module 은 보지 않는다.
  const assistantModule = new URL(request.url).searchParams.get("module");
  if (!isAssistantModule(assistantModule)) return erpError(400, "VALIDATION", "허용되지 않은 업무 영역입니다.");
  const permissionModule = ASSISTANT_MODULES[assistantModule];
  const authorization = await authorizeErpRequest(bindings.DB, permissionModule, "read");
  if (authorization.response) return authorization.response;

  const raw = await request.text();
  if (raw.length > MAX_REQUEST_BYTES) return Response.json({ error: "요청이 너무 큽니다." }, { status: 413 });
  let payload: { question?: unknown; context?: unknown };
  try {
    payload = JSON.parse(raw) as { question?: unknown; context?: unknown };
  } catch {
    return Response.json({ error: "요청 본문을 읽지 못했습니다." }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") return Response.json({ error: "요청 본문을 읽지 못했습니다." }, { status: 400 });

  const question = typeof payload.question === "string" ? payload.question.trim() : "";
  if (!question) return Response.json({ error: "질문을 입력해 주세요." }, { status: 400 });
  if (question.length > MAX_QUESTION_LENGTH) return Response.json({ error: "질문이 너무 깁니다." }, { status: 413 });
  const context = payload.context && typeof payload.context === "object" ? payload.context : {};

  const bridgeUrl = (bindings.CLAUDE_ASSISTANT_BRIDGE_URL?.trim() || "http://127.0.0.1:3130").replace(/\/+$/, "");
  let bridgeResponse: Response;
  try {
    bridgeResponse = await fetch(`${bridgeUrl}/assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: assistantModule, question, context }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
  } catch {
    // 다리가 안 떠 있거나(데스크탑이 꺼짐, ERP 바로가기 없이 실행) 시간이 초과된 경우.
    return Response.json(
      { error: "AI 어시스턴트 다리에 연결하지 못했습니다. ERP 서버가 도는 데스크탑에서 ERP 바로가기로 앱을 다시 실행해 주세요." },
      { status: 502 },
    );
  }

  const body = await bridgeResponse.json().catch(() => null) as
    | { error?: unknown; answer?: unknown; proposedActions?: unknown[]; interviewQuestions?: unknown[] }
    | null;
  if (!bridgeResponse.ok || !body) {
    // 다리의 상태 코드(400·413·429·502)와 한국어 안내를 그대로 넘긴다. 화면이 원인을 볼 수 있어야 한다.
    const message = body && typeof body.error === "string" ? body.error : `AI 어시스턴트 응답에 실패했습니다 (${bridgeResponse.status}).`;
    const status = bridgeResponse.ok ? 502 : bridgeResponse.status;
    return Response.json({ error: message }, { status });
  }

  await writeErpAudit(bindings.DB, {
    principal: authorization.principal,
    module: permissionModule,
    action: "ASSISTANT_ASKED",
    entityType: "assistantRequest",
    entityId: crypto.randomUUID(),
    // 질문 본문과 첨부 자료는 남기지 않는다. 무엇을 얼마나 물었는지만 기록한다.
    after: {
      assistantModule,
      questionLength: question.length,
      proposedActions: Array.isArray(body.proposedActions) ? body.proposedActions.length : 0,
      interviewQuestions: Array.isArray(body.interviewQuestions) ? body.interviewQuestions.length : 0,
    },
  });
  return Response.json(body);
}
