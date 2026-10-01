import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import { ensureGaSchema } from "../../../ga-schema";
import { badgeCount, collectAlerts, kstToday } from "../../../ga-alerts";
import { alertInputs, assetDepreciation, checkoutDto, gaPeople } from "../../../ga-server";

// general-affairs Design §4 현황(GD-6: 알림은 매번 계산한다). ?summary=1 이면 탭 배지 수만.
const db = (env as unknown as { DB: D1Database }).DB;

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "read");
  if (authorization.response) return authorization.response;
  await ensureGaSchema(db);
  const now = Date.now();
  const today = kstToday(now);
  const inputs = await alertInputs(db);
  const alerts = collectAlerts({ ...inputs, today });
  const badge = badgeCount(alerts);
  if (new URL(request.url).searchParams.get("summary") === "1") return Response.json({ badge });

  const people = new Map((await gaPeople(db)).map((person) => [person.employeeId, person]));
  const live = inputs.assets.filter((asset) => asset.status !== "DISPOSED");
  const summary = ["EQUIPMENT", "SUPPLY", "CONTRACT", "FIXED"].map((kind) => {
    const rows = live.filter((asset) => asset.kind === kind);
    const bookValue = rows.reduce((sum, asset) => {
      const depreciation = assetDepreciation(asset, now);
      return sum + (depreciation ? depreciation.bookValue : kind === "SUPPLY" ? asset.acquisition_cost * asset.quantity : asset.acquisition_cost);
    }, 0);
    return { kind, count: rows.length, bookValue };
  });
  const holders = new Map<string, number>();
  for (const asset of live) if (asset.kind === "EQUIPMENT" && asset.holder_employee_id) holders.set(asset.holder_employee_id, (holders.get(asset.holder_employee_id) ?? 0) + 1);
  const open = inputs.checkouts.map((row) => ({ ...checkoutDto(row), overdue: Boolean(row.due_on) && String(row.due_on) < today }));
  return Response.json({
    today, badge, alerts, summary,
    openCheckouts: open, overdueCheckouts: open.filter((row) => row.overdue).length,
    holders: [...holders].map(([employeeId, count]) => ({ employeeId, name: people.get(employeeId)?.name ?? employeeId, department: people.get(employeeId)?.department ?? "", count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko")),
    lowStock: alerts.filter((item) => item.bucket === "LOW_STOCK"),
  });
}
