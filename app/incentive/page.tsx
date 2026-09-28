import IncentiveCalculator from "./incentive-calculator";
import { RequireTab } from "../auth-screens";

// R3(Design §5.2, D1): 셸과 같은 useSession() 게이트. SSR·첫 렌더는 AuthLoadingShell 뿐이라 계산기 DOM 이 없다.
// compensation 탭이 none 이면 계산기를 렌더하지 않는다. 서버 쪽은 계산기가 부르는 /api/compensation/roster 가 403 으로 막는다.
export default function IncentivePage() {
  return (
    <RequireTab tab="compensation">
      <IncentiveCalculator />
    </RequireTab>
  );
}
