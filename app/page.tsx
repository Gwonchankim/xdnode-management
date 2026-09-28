"use client";

import { useState, type ReactNode } from "react";
import HRWorkspace from "./hr-workspace";
import CompensationCalculator from "./compensation-calculator";
import AuditLogWorkspace from "./audit-log-workspace";
import AdminAccountsWorkspace from "./admin-accounts-workspace";
import LocalCodexAssistant from "./local-codex-assistant";
import { ErpDialogProvider, useErpDialog } from "./erp-dialog";
import { TAB_REGISTRY, type ResolvedTabs, type TabKey } from "./access-tabs";
import ShellTopNav, { resolveActiveTab } from "./shell-top-nav";
import { SessionGate, SessionNotice } from "./auth-screens";
import { readScoped, writeScoped } from "./client-runtime";
import { useSession, type SessionMe } from "./session-client";

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
};

// 탭마다 패널 하나. Record<TabKey, …> 라서 레지스트리에 탭을 더하고 여기를 빠뜨리면 타입 오류가 되고,
// 이 저장소에는 타입 검사 단계가 없으므로 tests/shell-tabs.test.mjs 가 소스로 한 번 더 확인한다(§10.7).
const TAB_PANELS: Record<TabKey, (ctx: PanelContext) => ReactNode> = {
  hr: (ctx) => (
    <>
      <HRWorkspace requestedView={ctx.hrNavigation.view} navigationRequestKey={ctx.hrNavigation.requestKey} access={{ canEdit: ctx.tabs.hr === "edit" }} />
      <LocalCodexAssistant module="hr" tabs={ctx.tabs} />
    </>
  ),
  compensation: (ctx) => (
    <>
      <CompensationCalculator onAssistantModuleChange={ctx.setCompensationAssistantModule} />
      <LocalCodexAssistant module={ctx.compensationAssistantModule} tabs={ctx.tabs} />
    </>
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

  function select(tab: TabKey) {
    setSelected(tab);
    writeScoped(ACTIVE_TAB_KEY, tab);
  }

  const navigation = (
    <ShellTopNav tabs={me.tabs} active={active} onSelect={select} userName={me.user.name} userEmail={me.user.email}
      onChangePassword={onChangePassword} onLogout={onLogout} />
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
      {TAB_PANELS[active]({ me, tabs: me.tabs, hrNavigation, compensationAssistantModule, setCompensationAssistantModule })}
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
