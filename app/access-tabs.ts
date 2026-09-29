// 탭 레지스트리(Design §4.3.1, D12·D13·D20·D23). 순수 모듈이고 import 가 없다. 클라이언트와 서버가 함께 쓴다.
// 탭을 추가할 때는 TAB_REGISTRY 에 항목 1개를 더한다. TabKey·ErpModule·MODULE_TAB 은 여기서 자동으로 파생된다(§10.7).

export type TabLevel = "none" | "view" | "edit";
export type ErpAction = "read" | "write" | "approve" | "delete" | "admin";

export const TAB_REGISTRY = [
  { key: "hr", label: "인사관리", glyph: "◎", adminOnly: false, modules: ["hr", "recruitment"], apiPrefixes: ["/api/hr/", "/api/documents"], shellClass: "hr-module-shell" },
  { key: "compensation", label: "임금 계산", glyph: "◫", adminOnly: false, modules: ["compensation"], apiPrefixes: ["/api/compensation"], shellClass: "compensation-erp-shell" },
  { key: "chat", label: "메신저", glyph: "◌", adminOnly: false, modules: ["chat"], apiPrefixes: ["/api/chat/"], shellClass: "chat-module-shell" },
  { key: "audit", label: "감사 로그", glyph: "▤", adminOnly: true, modules: ["audit"], apiPrefixes: ["/api/audit-log"], shellClass: "admin-module-shell" },
  { key: "admin", label: "계정 관리", glyph: "◈", adminOnly: true, modules: ["admin"], apiPrefixes: ["/api/admin/"], shellClass: "admin-module-shell" },
] as const;

export type TabDefinition = (typeof TAB_REGISTRY)[number];
export type TabKey = TabDefinition["key"];
export type ErpModule = TabDefinition["modules"][number];
export type GrantableTabKey = Extract<TabDefinition, { adminOnly: false }>["key"];
export type ResolvedTabs = Record<TabKey, TabLevel>;
/** auth_accounts.tabs_json 저장 형태. 없는 키 = none. 모르는 키는 읽을 때 버리고 UPDATE_TABS 는 보존한다(§3.1). */
export type StoredTabGrants = Partial<Record<GrantableTabKey, "view" | "edit">> & Record<string, unknown>;
/** canAccess·isHrManager 가 보는 최소 형태. ErpPrincipal 이 이 형태를 만족한다. */
export type TabAccess = { isAdmin: boolean; tabs: ResolvedTabs };

/** 레지스트리에서 모듈 → 탭 표를 만든다. 탭 키가 겹치거나 한 모듈이 두 탭에 걸리면 throw 한다(access-policy 테스트가 확인한다). */
export function deriveModuleTab<K extends string>(registry: ReadonlyArray<{ key: K; modules: readonly string[] }>): ReadonlyMap<string, K> {
  const map = new Map<string, K>();
  const keys = new Set<string>();
  for (const tab of registry) {
    if (keys.has(tab.key)) throw new Error(`탭 키가 중복되었습니다: ${tab.key}`);
    keys.add(tab.key);
    for (const moduleName of tab.modules) {
      const owner = map.get(moduleName);
      if (owner) throw new Error(`모듈 ${moduleName} 이(가) 두 탭(${owner}, ${tab.key})에 걸려 있습니다.`);
      map.set(moduleName, tab.key);
    }
  }
  return map;
}

/** 모듈 → 탭. Map 이라 "__proto__"·"constructor" 같은 프로토타입 키가 탭으로 풀리지 않는다. 한 모듈이 두 탭에 걸리면 모듈 초기화 때 throw 한다. */
export const MODULE_TAB: ReadonlyMap<string, TabKey> = deriveModuleTab<TabKey>(TAB_REGISTRY);

/** 어시스턴트 ?module= 값 → 인가 모듈(D23). 조회 전에 Object.hasOwn 으로 거른다. */
export const ASSISTANT_MODULES = { hr: "hr", compensation: "compensation", incentive: "compensation" } as const satisfies Record<string, ErpModule>;
export type AssistantModule = keyof typeof ASSISTANT_MODULES;

export function isAssistantModule(value: unknown): value is AssistantModule {
  return typeof value === "string" && Object.hasOwn(ASSISTANT_MODULES, value);
}

/** 계정 관리 화면이 부여할 수 있는 탭(adminOnly 가 아닌 것, 레지스트리 순서). */
export const GRANTABLE_TABS: ReadonlyArray<{ key: GrantableTabKey; label: string }> = TAB_REGISTRY
  .filter((tab): tab is Extract<TabDefinition, { adminOnly: false }> => !tab.adminOnly)
  .map((tab) => ({ key: tab.key, label: tab.label }));
const GRANTABLE_KEYS: ReadonlySet<string> = new Set(GRANTABLE_TABS.map((tab) => tab.key));

export function isGrantableTabKey(key: string): key is GrantableTabKey {
  return GRANTABLE_KEYS.has(key);
}

export function tabOfModule(module: string): TabKey | null {
  return MODULE_TAB.get(module) ?? null;
}

const LEVEL_RANK: Readonly<Record<TabLevel, number>> = { none: 0, view: 1, edit: 2 };
const REQUIRED_LEVEL: ReadonlyMap<string, "view" | "edit" | "admin"> = new Map([
  ["read", "view"], ["write", "edit"], ["approve", "edit"], ["delete", "edit"], ["admin", "admin"],
] as const);

/** read→view, write·approve·delete→edit(D13: 상태 변경도 편집), admin→admin. 모르는 action 은 null. */
export function requiredLevel(action: ErpAction): "view" | "edit" | "admin";
export function requiredLevel(action: string): "view" | "edit" | "admin" | null;
export function requiredLevel(action: string) {
  return REQUIRED_LEVEL.get(action) ?? null;
}

export function parseStoredTabs(tabsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tabsJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * 요청마다 tabs_json 과 is_admin 으로 계산한다(캐시 없음, Plan M4). 관리자는 모든 탭이 edit 다.
 * 비관리자는 부여 가능 탭만 읽는다. audit·admin 이 저장돼 있어도 버리고(D23), 모르는 키·값도 버린다.
 */
export function resolveTabs(tabsJson: string, isAdmin: boolean): ResolvedTabs {
  const stored = parseStoredTabs(tabsJson);
  const resolved = {} as ResolvedTabs;
  for (const tab of TAB_REGISTRY) {
    if (isAdmin) { resolved[tab.key] = "edit"; continue; }
    const value = !tab.adminOnly && Object.hasOwn(stored, tab.key) ? stored[tab.key] : undefined;
    resolved[tab.key] = value === "view" || value === "edit" ? value : "none";
  }
  return resolved;
}

export type AccessDecision = { allowed: boolean; tab: TabKey | null; required: "view" | "edit" | "admin" | null; granted: TabLevel };

/**
 * 판정 순서(§4.3.1): 1) 모르는 모듈은 거부(isAdmin 보다 먼저) 2) admin action 은 isAdmin 3) adminOnly 탭은 isAdmin
 * 4) 관리자는 허용 5) 부여 수준 ≥ 필요 수준. 모르는 action 도 거부한다(fail closed).
 */
export function accessDecision(principal: TabAccess, module: string, action: string): AccessDecision {
  const tab = tabOfModule(module);
  const required = requiredLevel(action);
  const granted: TabLevel = tab ? principal.tabs[tab] ?? "none" : "none";
  const definition = tab ? TAB_REGISTRY.find((item) => item.key === tab) : undefined;
  let allowed: boolean;
  if (!tab || !definition || !required) allowed = false;
  else if (required === "admin" || definition.adminOnly) allowed = principal.isAdmin === true;
  else if (principal.isAdmin === true) allowed = true;
  else allowed = LEVEL_RANK[granted] >= LEVEL_RANK[required];
  return { allowed, tab, required, granted };
}

export function canAccess(principal: TabAccess, module: string, action: ErpAction): boolean {
  return accessDecision(principal, module, action).allowed;
}

export function hasTabLevel(principal: TabAccess, tab: TabKey, level: "view" | "edit"): boolean {
  if (principal.isAdmin === true) return true;
  const definition = TAB_REGISTRY.find((item) => item.key === tab);
  if (!definition || definition.adminOnly) return false;
  return LEVEL_RANK[principal.tabs[tab] ?? "none"] >= LEVEL_RANK[level];
}

/** 기존 privileged()·hr:approve·recruitment:* 를 대신한다(Plan M4): 관리자이거나 HR 탭 편집. */
export function isHrManager(principal: TabAccess): boolean {
  return principal.isAdmin === true || principal.tabs.hr === "edit";
}

/** 레지스트리 순서로, none 이 아닌 탭. 관리자는 resolveTabs 가 모두 edit 로 풀었으므로 전부다. */
export function permittedTabs(tabs: ResolvedTabs): TabDefinition[] {
  return TAB_REGISTRY.filter((tab) => (tabs[tab.key] ?? "none") !== "none");
}

export function firstPermittedTab(tabs: ResolvedTabs): TabKey | null {
  return permittedTabs(tabs)[0]?.key ?? null;
}
