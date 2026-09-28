const money = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
};

export function normalizeCompensationSettings(value: unknown) {
  const settings = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rounding = ["round", "up", "down"].includes(String(settings.rounding)) ? String(settings.rounding) : "round";
  const columns = settings.columns && typeof settings.columns === "object" ? settings.columns as Record<string, unknown> : {};
  const standards = settings.standards && typeof settings.standards === "object" ? settings.standards as Record<string, unknown> : {};
  // 선택 열은 여기 목록에 있는 것만 저장된다. 새 열을 추가하고 이 목록에 넣지 않으면 토글이
  // 저장되지 않고, 다시 열었을 때 기본값(꺼짐)으로 돌아간다. 연차수당·개인비용지급은 열이 꺼지면
  // 금액이 지급총액에서 빠지므로 그대로 두면 지급액이 조용히 줄어든다.
  const columnDefaults: Record<string, boolean> = {
    research: true, extra: true, welfare: false, severance: true,
    deduction: false, annualLeave: false, personalExpense: false,
  };
  const standardDefaults: Record<string, number> = { meal: 200_000, car: 200_000, child: 200_000 };
  return {
    rounding,
    columns: Object.fromEntries(Object.keys(columnDefaults).map((field) => [field,
      typeof columns[field] === "boolean" ? columns[field] : columnDefaults[field]])),
    standards: Object.fromEntries(["meal", "car", "child"].map((field) => [field,
      standards[field] === undefined ? standardDefaults[field] : money(standards[field]) ?? standardDefaults[field]])),
  };
}
