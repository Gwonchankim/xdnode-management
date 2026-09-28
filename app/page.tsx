"use client";

import { useEffect, useState } from "react";
import HRWorkspace from "./hr-workspace";
import CompensationCalculator from "./compensation-calculator";
import AuditLogWorkspace from "./audit-log-workspace";
import LocalCodexAssistant from "./local-codex-assistant";

// R1(M1-3): 재무·영업 모듈과 워크벤치·데이터 통제·알림 센터를 셸에서 뺐다.
// 'audit'는 data-governance-center 안에 있던 감사 로그를 탭으로 다시 마운트한 임시 키다(서버 게이트는 관리자 전용 audit:read).
// R3에서 탭 레지스트리(app/access-tabs.ts)로 바뀐다.
type ModuleKey = "hr" | "compensation" | "audit";

const modules: Array<{
  key: ModuleKey;
  label: string;
  glyph: string;
}> = [
  { key: "hr", label: "인사관리", glyph: "◎" },
  { key: "compensation", label: "임금 계산", glyph: "◫" },
  { key: "audit", label: "감사 로그", glyph: "◇" },
];

function ERPTopNavigation({ active, onChange }: { active: ModuleKey; onChange: (module: ModuleKey) => void }) {
  return (
    <header className="erp-top-nav">
      <div className="erp-top-brand">
        {/* eslint-disable-next-line @next/next/no-img-element -- 정적 로고. /_vinext/image 최적화가 필요 없다. */}
        <img className="brand-mark brand-logo" src="/brand/xdnode-symbol.png" alt="XDNODE" width={48} height={48} />
        <div>
          <strong>XDnode management</strong>

        </div>
      </div>

      <nav className="erp-module-tabs" aria-label="ERP 모듈">
        {modules.map((module) => (
          <button
            type="button"
            className={active === module.key ? "erp-module-tab active" : "erp-module-tab"}
            key={module.key}
            aria-current={active === module.key ? "page" : undefined}
            onClick={() => onChange(module.key)}
          >
            <span className="module-glyph">{module.glyph}</span>
            <span>
              <strong>{module.label}</strong>

            </span>
          </button>
        ))}
      </nav>

      <div className="erp-nav-spacer" />
    </header>
  );
}

const MODULE_STORAGE_KEY = "xdnode-active-module";
const validModuleKeys: ModuleKey[] = ["hr", "compensation", "audit"];

function readSavedModule(): ModuleKey {
  try {
    const saved = window.localStorage.getItem(MODULE_STORAGE_KEY);
    // 저장값이 더 이상 없는 모듈(finance·sales 등)이면 'hr'로 돌아간다.
    return validModuleKeys.includes(saved as ModuleKey) ? saved as ModuleKey : "hr";
  } catch {
    return "hr";
  }
}

export default function Home() {
  const [active, setActive] = useState<ModuleKey>("hr");
  const [hrNavigation, setHrNavigation] = useState({ view: "dashboard", requestKey: 0 });
  const [compensationAssistantModule, setCompensationAssistantModule] = useState<"compensation" | "incentive">("compensation");

  useEffect(() => {
    // 서버 렌더와 첫 하이드레이션은 'hr'로 맞추고, 저장된 탭은 마운트 뒤에 읽는다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(readSavedModule());
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(MODULE_STORAGE_KEY, active);
    } catch {
      // 저장소를 쓸 수 없으면 다음 방문에 'hr'로 시작한다.
    }
  }, [active]);

  function openModule(module: ModuleKey, hrView?: string) {
    if (hrView) {
      setHrNavigation((current) => ({ view: hrView, requestKey: current.requestKey + 1 }));
    }
    setActive(module);
  }

  const navigation = <ERPTopNavigation active={active} onChange={(module) => openModule(module)} />;

  if (active === "compensation") {
    return (
      <div className="compensation-erp-shell">
        {navigation}
        <CompensationCalculator onAssistantModuleChange={setCompensationAssistantModule} />
        <LocalCodexAssistant module={compensationAssistantModule} />
      </div>
    );
  }

  if (active === "audit") {
    return (
      <div className="admin-module-shell">
        {navigation}
        <main className="admin-page">
          <AuditLogWorkspace />
        </main>
      </div>
    );
  }

  return (
    <div className="hr-module-shell">
      {navigation}
      <HRWorkspace requestedView={hrNavigation.view} navigationRequestKey={hrNavigation.requestKey} />
      <LocalCodexAssistant module="hr" />
    </div>
  );
}
