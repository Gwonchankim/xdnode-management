"use client";

// 총무 탭 클라이언트 공용(general-affairs Design §1·§7). 탭 배지 훅, 표시 이름표, 요청 헬퍼.
// 서버 모듈은 값으로 import 하지 않는다(ga-alerts·ga-import 는 순수 모듈이라 함께 쓴다).
import { createContext, useEffect, useState } from "react";

export const GENERAL_BADGE_INTERVAL_MS = 10 * 60 * 1000;
/** 다른 화면(HR 퇴직 정산)이 총무 탭의 특정 자산을 열 때 쓰는 해시와 이벤트. */
export const GA_ASSET_HASH = "#ga-asset=";
export const OPEN_TAB_EVENT = "xdm:open-tab";
/** HR 화면(그림자 루트, portal)이 총무 편집 권한을 알 수 있게 셸이 넣어 준다. */
export const GeneralAccessContext = createContext<{ canEdit: boolean }>({ canEdit: false });

/** 총무 탭의 자산 상세를 연다(탭 전환은 셸이 권한을 확인한 뒤에 한다). */
export function openGeneralAsset(assetId: string) {
  window.location.hash = `${GA_ASSET_HASH}${encodeURIComponent(assetId)}`;
  window.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, { detail: { tab: "general" } }));
}

export const ASSET_KIND_LABEL: Record<string, string> = { EQUIPMENT: "지급 장비", SUPPLY: "비품·소모품", CONTRACT: "계약·구독", FIXED: "고정자산" };
export const ASSET_STATUS_LABEL: Record<string, string> = { IN_STOCK: "재고", ASSIGNED: "지급", REPAIR: "수리", ACTIVE: "사용", ENDED: "종료", DISPOSED: "처분" };
export const DOCUMENT_KIND_LABEL: Record<string, string> = {
  BUSINESS_REG: "사업자등록증", CORP_REGISTRY: "등기부등본", SEAL_CERT: "인감증명서", SEAL_USAGE: "사용인감계", CERTIFICATE: "인증서",
  PERMIT: "인허가증", B2B_CONTRACT: "기업 간 계약서", OTHER: "기타",
};
export const CONTRACT_TYPE_LABEL: Record<string, string> = { SUPPLY: "물품공급", PARTNER: "파트너", SERVICE: "용역", NDA: "비밀유지", OTHER: "기타" };
export const BILLING_LABEL: Record<string, string> = { MONTHLY: "월", QUARTERLY: "분기", YEARLY: "연", ONCE: "1회" };
export const CUSTODY_KIND_LABEL: Record<string, string> = { CORP_SEAL: "법인인감", USAGE_SEAL: "사용인감", OTHER: "기타 보관품" };
export const BUCKET_LABEL: Record<string, string> = { OVERDUE: "경과", TODAY: "당일", D7: "D-7", D30: "D-30", LOW_STOCK: "재고 부족" };
export const EVENT_LABEL: Record<string, string> = {
  ACQUIRED: "취득", IMPORTED: "가져오기", ASSIGNED: "지급", RETURNED: "반납", MOVED: "이동", STOCK_IN: "입고", STOCK_OUT: "출고",
  REPAIR: "수리 보냄", REPAIRED: "수리 완료", RENEWED: "갱신", ENDED: "종료", DISPOSED: "처분",
};

export const won = (value: number) => `${Math.round(value).toLocaleString("ko-KR")}원`;

export type GaResult<T> = { ok: boolean; status: number; body: T & { error?: string; code?: string; field?: string } };

export async function gaRequest<T = Record<string, unknown>>(url: string, method = "GET", body?: unknown): Promise<GaResult<T>> {
  try {
    const response = await fetch(url, {
      method, cache: "no-store", credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({})) as GaResult<T>["body"];
    return { ok: response.ok, status: response.status, body: parsed ?? ({} as GaResult<T>["body"]) };
  } catch {
    return { ok: false, status: 0, body: { error: "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." } as GaResult<T>["body"] };
  }
}

/** 탭 배지(경과+당일+D-7). 총무 보기 이상일 때 10분마다, 창에 돌아올 때 다시 읽는다. */
export function useGeneralBadge(enabled: boolean) {
  const [badge, setBadge] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      const result = await gaRequest<{ badge: number }>("/api/general/overview?summary=1");
      if (alive && result.ok && typeof result.body.badge === "number") setBadge(result.body.badge);
    };
    void load();
    const timer = window.setInterval(() => void load(), GENERAL_BADGE_INTERVAL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    window.addEventListener("xdm:general-changed", onFocus);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", onFocus); window.removeEventListener("xdm:general-changed", onFocus); };
  }, [enabled]);
  return enabled ? badge : 0;
}

/** 총무 데이터가 바뀌었음을 셸 배지에 알린다. */
export function notifyGeneralChanged() {
  window.dispatchEvent(new Event("xdm:general-changed"));
}
