// 브라우저 런타임 도우미(Design §5.5·§5.6·§10.5, 부록 B 이식 #24). 서버 모듈을 import 하지 않는다.
//
// 사무실 LAN PC는 http://192.168.x.x:3000 으로 접속하므로 보안 컨텍스트가 아니다. 그래서
// crypto.randomUUID()·navigator.clipboard 가 없다. 그 대신 여기 함수를 쓴다("use client" 파일의
// crypto.randomUUID( 는 removal-guards 가 0건으로 고정한다).
//
// localStorage 는 계정 범위 키(scopedKey(k) = k + "::" + accountId)로만 쓴다. 공용 PC에서 계정끼리
// 작업 데이터가 섞이지 않게 하려는 것이고, 로그아웃·세션 401 때 급여성 데이터 키는 clearScopedDataKeys()로 지운다.

/** getRandomValues 기반 UUID v4 형식 문자열. 비보안 컨텍스트에서도 동작한다. */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 보안 컨텍스트(https·localhost)인지. 서버 렌더에서는 false 다. */
export function secureContextAvailable(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true;
}

/**
 * 클립보드 복사. 보안 컨텍스트면 navigator.clipboard 를 먼저 쓰고, 안 되면 숨긴 textarea 와
 * document.execCommand("copy") 로 복사한다. 둘 다 실패하면 reject 한다(호출부가 "직접 복사" 안내를 띄운다).
 */
export async function copyText(text: string): Promise<void> {
  if (secureContextAvailable() && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 권한 거부 등. 아래 대체 경로로 간다.
    }
  }
  if (typeof document === "undefined") throw new Error("복사할 수 없는 환경입니다.");
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  area.select();
  area.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    area.remove();
    if (previous && selection) { selection.removeAllRanges(); selection.addRange(previous); }
  }
  if (!copied) throw new Error("복사하지 못했습니다.");
}

// ── 계정 범위 저장소 ────────────────────────────────────────────────────────────

let storageScope: string | null = null;

/** ready 상태에 들어갈 때 useSession 이 accountId 로 부른다. 로그아웃하면 null. */
export function setStorageScope(accountId: string | null) {
  storageScope = accountId && accountId.length <= 80 ? accountId : null;
}

export function currentStorageScope() {
  return storageScope;
}

/** k + "::" + accountId. 범위가 없으면(로그인 전) "::anonymous" 로 둔다. 레거시(범위 없는) 키와 겹치지 않는다. */
export function scopedKey(key: string): string {
  return `${key}::${storageScope ?? "anonymous"}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 범위 키 값을 읽는다. 범위 키가 없고 레거시 키(범위 없는 옛 키)가 있으면 그 값을 1회 옮기고 레거시 키를 지운다.
 * legacyKeys 에는 옛 이름(예: xdnode-active-module)을 더 줄 수 있다. 모든 접근은 try/catch 로 감싼다.
 */
export function readScoped(key: string, legacyKeys: readonly string[] = [key]): string | null {
  const store = storage();
  if (!store) return null;
  try {
    const value = store.getItem(scopedKey(key));
    if (value !== null) return value;
    for (const legacy of legacyKeys) {
      const legacyValue = store.getItem(legacy);
      if (legacyValue === null) continue;
      store.setItem(scopedKey(key), legacyValue);
      store.removeItem(legacy);
      return legacyValue;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeScoped(key: string, value: string) {
  try {
    storage()?.setItem(scopedKey(key), value);
  } catch {
    // 저장소가 가득 찼거나 막혀 있으면 이번 방문에서만 유지한다.
  }
}

export function removeScoped(key: string) {
  try {
    storage()?.removeItem(scopedKey(key));
  } catch {
    // 무시
  }
}

/** 읽기 전용 JSON 조회(어시스턴트 맥락 등). 레거시 키 이전도 readScoped 가 한다. */
export function readScopedJson<T>(key: string, fallback: T): T {
  const raw = readScoped(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * 급여성 데이터 키(사람별 딜 단가·매출·조정 금액·인센티브 지급 결과·제외 인원, §5.5). 로그아웃·세션 401 때 지운다.
 * 화면 설정 키(xdnode-active-tab, xdnode-compensation-preferences-v2, xdnode-incentive-config-v1,
 * xdnode-incentive-cable-exclusion-v2)는 남긴다.
 */
export const SCOPED_DATA_KEYS = [
  "xdnode-incentive-deals-v1",
  "xdnode-incentive-adjustments-v1",
  "xdnode-incentive-payroll-v1",
  "xdnode-incentive-excluded-people-v1",
] as const;

/** 현재 계정 범위 키와 남아 있는 레거시 키를 모두 지운다. useSession().logout() 과 401 처리 경로가 부른다. */
export function clearScopedDataKeys() {
  const store = storage();
  if (!store) return;
  for (const key of SCOPED_DATA_KEYS) {
    try {
      store.removeItem(scopedKey(key));
      store.removeItem(key);
    } catch {
      // 무시
    }
  }
}
