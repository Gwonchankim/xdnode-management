// 상단 내비(Design §5.1·§5.3·§5.4 ShellTopNav, 부록 B #19). 레지스트리 기반 탭 버튼과 계정 칩.
// CSS 와 서버 모듈을 import 하지 않는다. tests/shell-tabs.test.mjs 가 react-dom/server 로 그대로 렌더한다.
// 권한 없는 탭은 버튼도 만들지 않는다(DOM 0건). 허용 탭이 하나도 없으면 탭 내비 자체가 없고 로그아웃만 남는다.

import { permittedTabs, type ResolvedTabs, type TabKey } from "./access-tabs";

/** 저장된 탭이 지금 허용 목록에 있으면 그것, 아니면 첫 허용 탭. 모두 none 이면 null. */
export function resolveActiveTab(tabs: ResolvedTabs, saved: string | null | undefined): TabKey | null {
  const allowed = permittedTabs(tabs);
  const match = allowed.find((tab) => tab.key === saved);
  return (match ?? allowed[0])?.key ?? null;
}

export type ShellTopNavProps = {
  tabs: ResolvedTabs;
  active: TabKey | null;
  onSelect: (tab: TabKey) => void;
  userName: string;
  userEmail?: string;
  onChangePassword: () => void;
  onLogout: () => void;
  /** 탭별 숫자 배지(메신저 안 읽은 수). 0 이면 그리지 않는다. */
  badges?: Partial<Record<TabKey, number>>;
};

export default function ShellTopNav({ tabs, active, onSelect, userName, userEmail, onChangePassword, onLogout, badges }: ShellTopNavProps) {
  const allowed = permittedTabs(tabs);
  const empty = allowed.length === 0;
  return (
    <header className="erp-top-nav">
      <div className="erp-top-brand">
        {/* eslint-disable-next-line @next/next/no-img-element -- 정적 심볼. /_vinext/image 최적화가 필요 없다. */}
        <img className="brand-mark brand-logo" src="/brand/xdnode-symbol.png" alt="XDNODE" width={48} height={48} />
        <div>
          <strong>XDnode management</strong>
        </div>
      </div>

      {!empty && (
        <nav className="erp-module-tabs" aria-label="업무 탭">
          {allowed.map((tab) => (
            <button
              type="button"
              className={active === tab.key ? "erp-module-tab active" : "erp-module-tab"}
              key={tab.key}
              data-tab={tab.key}
              aria-current={active === tab.key ? "page" : undefined}
              onClick={() => onSelect(tab.key)}
            >
              <span className="module-glyph" aria-hidden="true">{tab.glyph}</span>
              <span>
                <strong>{tab.label}</strong>
              </span>
              {(badges?.[tab.key] ?? 0) > 0 && (
                <span className="erp-tab-badge" aria-label={`안 읽은 글 ${badges?.[tab.key]}개`}>{Math.min(badges?.[tab.key] ?? 0, 99)}{(badges?.[tab.key] ?? 0) > 99 ? "+" : ""}</span>
              )}
            </button>
          ))}
        </nav>
      )}

      <div className="erp-nav-spacer" />

      {/* 계정 칩: 로그아웃은 항상 보인다(R-8, 여러 사람이 한 자리를 쓰는 30일 세션). */}
      <div className="erp-account-chip" aria-label="계정">
        <span className="erp-account-name" title={userEmail}>{userName}</span>
        {!empty && <button type="button" className="erp-account-action" onClick={onChangePassword}>비밀번호 변경</button>}
        <button type="button" className="erp-account-action logout" onClick={onLogout}>로그아웃</button>
      </div>
    </header>
  );
}
