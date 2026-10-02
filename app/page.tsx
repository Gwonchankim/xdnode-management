"use client";

import { useEffect, useState, type ReactNode } from "react";
import HRWorkspace from "./hr-workspace";
import CompensationCalculator from "./compensation-calculator";
import AuditLogWorkspace from "./audit-log-workspace";
import AdminAccountsWorkspace from "./admin-accounts-workspace";
import ChatWorkspace from "./chat-workspace";
import GeneralWorkspace from "./general-workspace";
import QuoteWorkspace from "./quote-workspace";
import LocalCodexAssistant from "./local-codex-assistant";
import { ErpDialogProvider, useErpDialog } from "./erp-dialog";
import { TAB_REGISTRY, type ResolvedTabs, type TabKey } from "./access-tabs";
import ShellTopNav, { resolveActiveTab } from "./shell-top-nav";
import { SessionGate, SessionNotice } from "./auth-screens";
import { readScoped, writeScoped } from "./client-runtime";
import { useSession, type SessionMe } from "./session-client";
import { useChatPoll, type ChatPoll } from "./chat-client";
import { useChatNotifier } from "./chat-notify";
import ChatToasts from "./chat-toasts";
import { GeneralAccessContext, OPEN_TAB_EVENT, useGeneralBadge } from "./general-client";
import { useQuoteBadge } from "./quote-client";

// R3(r3-shell, Design §5.1~§5.3): 셸은 useSession() 상태기계와 탭 레지스트리(app/access-tabs.ts)로 그린다.
// SSR 과 첫 렌더는 AuthLoadingShell(data-auth-gate="loading")뿐이고 탭 DOM 이 없다. 권한 없는 탭은 버튼도 패널도 없다.
// 화면에서 숨기는 것은 보안 통제가 아니다. 모든 API 는 서버가 탭 권한으로 다시 검사한다.

const ACTIVE_TAB_KEY = "xdnode-active-tab";
// 옛 셸이 쓰던 키. 범위 키가 없을 때 1회 읽고 지운다(§5.5).
const LEGACY_ACTIVE_TAB_KEYS = [ACTIVE_TAB_KEY, "xdnode-active-module"];

type PanelContext = {
  me: SessionMe;
  tabs: ResolvedTabs;
  hrNavigation: { view: string; requestKey: number };
  compensationAssistantModule: "compensation" | "incentive";
  setCompensationAssistantModule: (module: "compensation" | "incentive") => void;
  chatPoll: ChatPoll;
};

// 탭마다 패널 하나. Record<TabKey, …> 라서 레지스트리에 탭을 더하고 여기를 빠뜨리면 타입 오류가 되고,
// 이 저장소에는 타입 검사 단계가 없으므로 tests/shell-tabs.test.mjs 가 소스로 한 번 더 확인한다(§10.7).
const TAB_PANELS: Record<TabKey, (ctx: PanelContext) => ReactNode> = {
  hr: (ctx) => (
    <>
      <GeneralAccessContext.Provider value={{ canEdit: ctx.tabs.general === "edit" }}>
        <HRWorkspace requestedView={ctx.hrNavigation.view} navigationRequestKey={ctx.hrNavigation.requestKey} access={{ canEdit: ctx.tabs.hr === "edit" }} />
      </GeneralAccessContext.Provider>
      <LocalCodexAssistant module="hr" tabs={ctx.tabs} />
    </>
  ),
  compensation: (ctx) => (
    <>
      <CompensationCalculator onAssistantModuleChange={ctx.setCompensationAssistantModule} />
      <LocalCodexAssistant module={ctx.compensationAssistantModule} tabs={ctx.tabs} />
    </>
  ),
  chat: (ctx) => <ChatWorkspace accountId={ctx.me.user.accountId} poll={ctx.chatPoll} />,
  general: (ctx) => <GeneralWorkspace canEdit={ctx.tabs.general === "edit"} />,
  quote: (ctx) => (
    <QuoteWorkspace canEdit={ctx.tabs.quote === "edit"} isAdmin={ctx.me.isAdmin} accountId={ctx.me.user.accountId} userName={ctx.me.user.name} />
  ),
  audit: () => (
    <main className="admin-page">
      <AuditLogWorkspace />
    </main>
  ),
  admin: (ctx) => (
    <main className="admin-page">
      <AdminAccountsWorkspace currentAccountId={ctx.me.user.accountId} />
    </main>
  ),
};

function ReadyShell({ me, onChangePassword, onLogout }: { me: SessionMe; onChangePassword: () => void; onLogout: () => void }) {
  // 저장된 탭은 계정 범위 키로 읽는다. 범위는 useSession 이 ready 로 가기 전에 정했다.
  const [selected, setSelected] = useState<string | null>(() => readScoped(ACTIVE_TAB_KEY, LEGACY_ACTIVE_TAB_KEYS));
  const [hrNavigation] = useState({ view: "dashboard", requestKey: 0 });
  const [compensationAssistantModule, setCompensationAssistantModule] = useState<"compensation" | "incentive">("compensation");
  // 권한이 줄어 현재 탭이 사라지면(60초 재조회·FORBIDDEN 뒤) 첫 허용 탭으로 옮긴다.
  const active = resolveActiveTab(me.tabs, selected);
  // 메신저 폴링은 셸에서 한 번만 돈다. 다른 탭에 있어도 15초마다 안 읽은 수를 받아 탭 배지·문서 제목을 갱신한다(§4.2.8).
  const chatPoll = useChatPoll({ enabled: me.tabs.chat !== "none", chatActive: active === "chat" });
  // 총무 탭 배지(경과+당일+D-7, general-affairs Design §1). 10분마다·창에 돌아올 때·총무 데이터가 바뀔 때 다시 읽는다.
  const generalBadge = useGeneralBadge(me.tabs.general !== "none");
  // 견적 탭 배지(미확정 견적 수, quote-tool Design §10.1). 10분마다·창에 돌아올 때·견적이 바뀔 때 다시 읽는다.
  const quoteBadge = useQuoteBadge(me.tabs.quote !== "none");
  // 다른 화면이 탭을 바꿔 달라고 할 때(HR 퇴직 정산 → 총무 자산). 허용된 탭만 연다.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      if (tab && TAB_REGISTRY.some((item) => item.key === tab) && me.tabs[tab as TabKey] !== "none") select(tab as TabKey);
    };
    window.addEventListener(OPEN_TAB_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TAB_EVENT, onOpen);
  });

  function select(tab: TabKey) {
    setSelected(tab);
    writeScoped(ACTIVE_TAB_KEY, tab);
  }

  // messenger-enhancement ME-FR-02·03: 어느 탭에 있어도 셸이 새 메시지 알림(소리·토스트·파비콘)을 낸다(ME-DD9).
  // 토스트를 누르면 메신저 탭으로 옮기고, 채팅 화면이 openRequest 를 받아 그 메시지로 이동한다(ME-FR-01).
  function openChatMessage(channelId: string, messageId: number) {
    select("chat");
    chatPoll.requestOpen(channelId, messageId);
  }
  const notifier = useChatNotifier({
    poll: chatPoll, enabled: me.tabs.chat !== "none", accountId: me.user.accountId, chatActive: active === "chat", onOpen: openChatMessage,
  });
  const toasts = (
    <ChatToasts toasts={notifier.toasts} onDismiss={notifier.dismiss}
      onOpen={(toast) => { notifier.dismiss(toast.key); openChatMessage(toast.channelId, toast.messageId); }} />
  );

  const navigation = (
    <ShellTopNav tabs={me.tabs} active={active} onSelect={select} userName={me.user.name} userEmail={me.user.email}
      onChangePassword={onChangePassword} onLogout={onLogout} badges={{ chat: chatPoll.unread?.total ?? 0, general: generalBadge, quote: quoteBadge }} />
  );

  if (!active) {
    return (
      <div className="admin-module-shell">
        {navigation}
        <main className="shell-empty" data-shell="empty">
          <p role="status">허용된 탭이 없습니다. 관리자에게 문의해 주세요.</p>
        </main>
      </div>
    );
  }

  const definition = TAB_REGISTRY.find((tab) => tab.key === active) ?? TAB_REGISTRY[0];
  return (
    <div className={definition.shellClass}>
      {navigation}
      {TAB_PANELS[active]({ me, tabs: me.tabs, hrNavigation, compensationAssistantModule, setCompensationAssistantModule, chatPoll })}
      {toasts}
    </div>
  );
}

function Shell() {
  const session = useSession();
  const dialog = useErpDialog();

  async function logout() {
    const confirmed = await dialog.confirm("로그아웃하면 이 브라우저에 저장하지 않은 인센티브 입력(거래·조정·지급 결과·제외 인원)이 지워집니다. 로그아웃할까요?", {
      title: "로그아웃", confirmLabel: "로그아웃",
    });
    if (confirmed) await session.logout();
  }

  if (session.state.status !== "ready") {
    return <><SessionGate session={session} /><SessionNotice message={session.notice} /></>;
  }
  const me = session.state.me;
  return (
    <>
      {/* 계정이 바뀌면 탭 선택·화면 상태를 새로 시작한다. */}
      <ReadyShell key={me.user.accountId} me={me} onChangePassword={session.openPasswordChange} onLogout={() => void logout()} />
      <SessionNotice message={session.notice} />
    </>
  );
}

export default function Home() {
  return (
    <ErpDialogProvider>
      <Shell />
    </ErpDialogProvider>
  );
}
