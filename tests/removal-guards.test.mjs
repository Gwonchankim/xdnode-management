import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// R1 제거 가드(xdnode-management Design §8.6, §12.6, 부록 A.1·A.2·A.3).
// 재무·영업·결재·데이터·마스터 영향·워크벤치를 지운 뒤 다시 살아나거나, 남은 코드가 그 경로를 부르지 않게 고정한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

const financeRoutes = [
  "alert-actions", "assistant", "budget", "close", "daily-treasury", "debt", "expense-control", "fixed-assets",
  "forecast", "general-ledger", "import-mappings", "inventory", "management-report", "master-data", "opening-balance",
  "operations", "posting-control", "project-costing", "purchasing", "receivables", "reconciliation", "risk-policy", "tax", "tie-out",
].map((name) => `app/api/finance/${name}/route.ts`);
const salesRoutes = [
  "", "accounts/", "contracts/", "crm/", "incentives/", "planning/", "pricing/", "service/",
  "sheet-sync/", "sheet-sync/analytics/", "sheet-sync/insights/",
].map((name) => `app/api/sales/${name}route.ts`);
const sharedRoutes = [
  "approvals", "approval-settings", "data-intake", "data-governance", "data-integration",
  "master-impact", "master-impact-cases", "operations", "workbench",
].map((name) => `app/api/${name}/route.ts`);

const deletedModules = [
  // 재무 43
  "finance-alert-action-center.tsx", "finance-alert-actions-server.ts", "finance-alert-reporting-model.ts", "finance-alert-reporting.ts",
  "finance-assistant-evidence.ts", "finance-assistant-history.ts", "finance-bank-transactions.ts", "finance-close-workspace.tsx",
  "finance-current-data.ts", "finance-current-insights.ts", "finance-decision-model.ts", "finance-general-ledger.ts",
  "finance-historical-data.ts", "finance-import-mapping-workspace.tsx", "finance-import-mapping.ts", "finance-ledger-integrity.ts",
  "finance-ledger-snapshot.ts", "finance-master-workspace.tsx", "finance-opening-balance.ts", "finance-operations-center.tsx",
  "finance-posting-workspace.tsx", "finance-posting.ts", "finance-risk-policy-server.ts", "finance-risk-policy-workspace.tsx",
  "finance-tie-out.ts", "finance-time-series.ts", "budget-actual-workspace.tsx", "cash-forecast-workspace.tsx",
  "cash-reconciliation-workspace.tsx", "daily-treasury-workspace.tsx", "debt-management-workspace.tsx", "expense-control-workspace.tsx",
  "fixed-assets-workspace.tsx", "general-ledger-workspace.tsx", "inventory-workspace.tsx", "management-report-workspace.tsx",
  "project-costing-workspace.tsx", "purchasing-workspace.tsx", "receivables-workspace.tsx", "tax-reconciliation-workspace.tsx",
  "tie-out-board-workspace.tsx", "opening-balance-control.tsx", "fixed-asset-calculation.mjs",
  // 영업 20
  "sales-account-360-view.tsx", "sales-contract-management.tsx", "sales-contracts.ts", "sales-planning-view.tsx",
  "sales-pricing-governance.tsx", "sales-pricing.ts", "sales-service-management.tsx", "sales-service.ts",
  "sales-sheet-analytics-view.tsx", "sales-sheet-analytics.ts", "sales-sheet-data-hub.tsx", "sales-sheet-insights-view.tsx",
  "sales-sheet-insights.ts", "sales-sheet-lead-conversion.ts", "sales-sheet-sync-kit.ts", "sales-sheet-sync-view.tsx",
  "sales-sheet-sync.ts", "sales-sheet-tabs.ts", "sales-workspace.tsx", "google-sheets.ts",
  // 결재 2, 데이터 6, 마스터 영향 3, 워크벤치 1, 인센티브 거버넌스 1(D22)
  "approval-engine.ts", "approval-center.tsx",
  "data-intake.ts", "data-intake-workspace.tsx", "data-governance.ts", "data-governance-center.tsx", "data-integration.ts", "data-integration-workspace.tsx",
  "master-impact.ts", "master-impact-dialog.tsx", "master-impact-case-workspace.tsx",
  "operations-workbench.tsx",
  "incentive-governance.tsx",
].map((name) => `app/${name}`);

const deletedTests = ["finance-alert-reporting", "finance-assistant-evidence", "finance-data", "finance-decision-model", "finance-time-series"]
  .map((name) => `tests/${name}.test.mjs`);

const deletedPaths = [...financeRoutes, ...salesRoutes, ...sharedRoutes, ...deletedModules];

// 남는 소스: 앱·Worker·스크립트·빌드 플러그인·설정.
const sourceRoots = ["app", "worker", "scripts", "build"];
const sourceExtensions = /\.(?:[cm]?[jt]sx?|css)$/;

async function listSources() {
  const files = [];
  for (const dir of sourceRoots) {
    if (!existsSync(path.join(root, dir))) continue;
    const entries = await readdir(path.join(root, dir), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !sourceExtensions.test(entry.name)) continue;
      const parent = entry.parentPath ?? entry.path;
      files.push(path.relative(root, path.join(parent, entry.name)).replaceAll("\\", "/"));
    }
  }
  files.push("vite.config.ts");
  return files.sort();
}

// 주석 속 설명(예: "예전에는 app/approval-engine.ts 가 …")은 호출이 아니므로 뺀다.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => (/^\s*\/\//.test(line) ? "" : line.replace(/(^|[\s;,{}()])\/\/(?!\/).*$/, "$1")))
    .join("\n");
}

const withoutExtension = (file) => file.replace(/\.(?:[cm]?[jt]sx?)$/, "");
const deletedStems = new Set(deletedPaths.map(withoutExtension));

test("R1: the 120 deleted files and 5 finance tests stay absent", () => {
  assert.equal(financeRoutes.length + salesRoutes.length + sharedRoutes.length, 44);
  assert.equal(deletedModules.length, 76);
  const present = [...deletedPaths, ...deletedTests].filter((file) => existsSync(path.join(root, file)));
  assert.deepEqual(present, []);
  for (const dir of ["app/api/finance", "app/api/sales"]) assert.equal(existsSync(path.join(root, dir)), false, `${dir} should be gone`);
});

test("R1: no kept source imports a deleted module", async () => {
  const offenders = [];
  for (const file of await listSources()) {
    const source = stripComments(await read(file));
    const specifiers = [
      ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/\bimport\s+["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (deletedStems.has(withoutExtension(resolved)) || deletedStems.has(`${resolved}/route`)) offenders.push(`${file} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("R1: no kept source fetches a removed API path", async () => {
  // /api/hr/operations 는 남는 HR 라우트다. /api/ 바로 뒤의 첫 세그먼트만 본다.
  const removed = /\/api\/(?:finance|sales|approvals|approval-settings|data-[a-z-]+|master-impact[a-z-]*|operations|workbench)(?=[/"'`?#\s]|$)/m;
  const offenders = [];
  for (const file of await listSources()) {
    const source = stripComments(await read(file));
    if (removed.test(source)) offenders.push(`${file}: ${source.match(removed)[0]}`);
  }
  assert.deepEqual(offenders, []);
});

test("R1: finance and sales roles, modules and period helpers are gone from the platform", async () => {
  const platform = await read("app/erp-platform.ts");
  assert.match(platform, /export type ErpModule = "hr" \| "recruitment" \| "settings";/);
  assert.doesNotMatch(platform, /blockedFinancePeriods|isFinancePeriodLocked|finance_close_runs/);
  assert.doesNotMatch(platform, /"(?:operations|finance|sales):(?:read|write|approve|delete|admin)"/);
  const offenders = [];
  for (const file of await listSources()) {
    if (/\b(?:FINANCE_ADMIN|SALES_ADMIN)\b/.test(stripComments(await read(file)))) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("R1: documents accept only hr·recruitment, and HR payroll/compensation no longer touch finance or sales tables", async () => {
  const [documents, payroll, compensation] = await Promise.all([
    read("app/api/documents/route.ts"), read("app/api/hr/payroll/route.ts"), read("app/api/hr/compensation/route.ts"),
  ]);
  assert.match(documents, /DOCUMENT_MODULES[^=]*= new Set<DocumentModule>\(\["hr", "recruitment"\]\)/);
  assert.doesNotMatch(stripComments(payroll), /finance_expense_requests|finance_project_allocations/);
  assert.doesNotMatch(stripComments(compensation), /sales_incentive_payroll_links/);
});

test("R1: kept code no longer creates approval, task or sync tables; the drizzle history keeps them (D4)", async () => {
  const offenders = [];
  for (const file of await listSources()) {
    if (/CREATE TABLE(?: IF NOT EXISTS)?\s+[`"]?(?:erp_approval_\w+|erp_tasks|erp_sync_runs)\b/i.test(await read(file))) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
  const migrations = (await readdir(path.join(root, "drizzle"))).filter((name) => name.endsWith(".sql"));
  const history = (await Promise.all(migrations.map((name) => read(`drizzle/${name}`)))).join("\n");
  assert.match(history, /CREATE TABLE `erp_approval_requests`/);
});

test("R1: the local runtime no longer forwards the unused Cloudflare AI model variable", async () => {
  assert.doesNotMatch(await read("vite.config.ts"), /CLOUDFLARE_AI_MODEL/);
});

test("every tests/*.test.mjs file is in the npm test list and every listed test file exists", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const listed = [...pkg.scripts.test.matchAll(/tests\/[\w.-]+\.test\.mjs/g)].map((match) => match[0]);
  assert.equal(new Set(listed).size, listed.length, "duplicate entries in the test list");
  const onDisk = (await readdir(path.join(root, "tests"))).filter((name) => name.endsWith(".test.mjs")).map((name) => `tests/${name}`);
  assert.deepEqual([...listed].sort(), [...onDisk].sort());
});
