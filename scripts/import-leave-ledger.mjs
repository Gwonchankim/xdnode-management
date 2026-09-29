// 엑셀 연차관리대장 → ERP 연차관리 이관 (1회용).
//   node scripts/import-leave-ledger.mjs "<xlsx 경로>"            미리보기만
//   node scripts/import-leave-ledger.mjs "<xlsx 경로>" --apply    ERP 에 저장 (앱이 http://127.0.0.1:3000 에 떠 있어야 함)
//   --map 이름=사번   시트 이름과 인사기록카드 이름이 다를 때 (여러 번 가능)
//   --base http://…   다른 주소의 앱
//   --cookie <값>     이미 받은 세션 쿠키(xdm_session=…). 없으면 XDM_EMAIL·XDM_PASSWORD 환경변수로 로그인한다(scripts/xdm-login.mjs).
// 미리보기도 인사기록을 읽으므로 로그인이 필요하다. 계정에는 인사관리 편집 권한(--apply)이 있어야 한다.
// 시트 구조는 docs/hr-leave-management-plan.md 2·5절. 발생분은 저장하지 않고 엔진이 다시 계산하므로
// 옮기는 것은 사용 기록(직원 탭 AI/AL 열)과 「제외」 표시(월차 만근 F열)뿐이다.
import readAllSheets from "read-excel-file/node";
import { computeLeaveLedger, expandDateRange, leaveKindFromLabel, normalizeDate } from "../app/hr-leave-accrual.ts";
import { connectXdm } from "./xdm-login.mjs";

const args = process.argv.slice(2);
const xlsxPath = args.find((arg) => !arg.startsWith("--") && !args[args.indexOf(arg) - 1]?.startsWith("--"));
if (!xlsxPath) { console.error("사용법: node scripts/import-leave-ledger.mjs <xlsx> [--apply] [--map 이름=사번] [--base http://127.0.0.1:3000] [--cookie xdm_session=…]"); process.exit(2); }
const apply = args.includes("--apply");
// 인사기록카드에 없는 사람(ERP 도입 전 퇴사자)은 이 옵션이 있을 때만 건너뛰고 저장한다.
const skipUnmatched = args.includes("--skip-unmatched");
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : "http://127.0.0.1:3000";
const cookieIndex = args.indexOf("--cookie");
const manualMap = new Map(args.flatMap((arg, index) => arg === "--map" ? [args[index + 1].split("=")] : []));
const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

const column = (letter) => letter.split("").reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const number = (value) => (typeof value === "number" ? value : Number(text(value)) || 0);

// v9: 기본 내보내기가 모든 시트를 [{ sheet, data }] 로 돌려준다.
const workbook = await readAllSheets(xlsxPath);
const sheetNames = workbook.map((item) => item.sheet);
const readXlsxFile = async (_path, { sheet }) => workbook.find((item) => item.sheet === sheet)?.data ?? [];
const need = (name) => { if (!sheetNames.includes(name)) { console.error(`시트 「${name}」이 없습니다.`); process.exit(2); } };
need("자동화 관리"); need("월차 만근");

// 1) 자동화 관리 — 사람 목록과 시트가 계산한 요약(대조용)
const manage = await readXlsxFile(xlsxPath, { sheet: "자동화 관리" });
// 표 아래에 사용 안내 문장이 이어지므로 입사일이 읽히는 행만 사람이다.
const people = manage.slice(7).filter((row) => text(row[0]) && normalizeDate(row[2])).map((row) => ({
  name: text(row[0]), tab: text(row[1]) || text(row[0]), joinDate: normalizeDate(row[2]), endDate: normalizeDate(row[3]),
  sheetUsed: number(row[6]), sheetGranted: number(row[9]), sheetBalance: number(row[10]),
}));

// 2) 인사기록카드에서 사번 찾기 — R3 부터 API 는 세션이 필요하다
const client = await connectXdm(base, { cookie: cookieIndex >= 0 ? args[cookieIndex + 1] : "" })
  .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); });
const employeeResponse = await client.fetch("/api/hr/employee-records");
if (!employeeResponse.ok) { console.error(`인사기록을 읽지 못했습니다 (${employeeResponse.status}). 앱이 떠 있는지 확인하세요.`); process.exit(2); }
const { records } = await employeeResponse.json();
const idByName = new Map(records.map((record) => [record.name.replace(/\s+/g, ""), record.employeeId]));
const unmatched = [];
for (const person of people) {
  person.employeeId = manualMap.get(person.name) ?? idByName.get(person.name.replace(/\s+/g, "")) ?? "";
  if (!person.employeeId) unmatched.push(person.name);
}

// 3) 직원 탭의 사용 기록 — AI열 날짜 + AL열 내용. 현재 대장과 하단 과거 대장이 같은 열을 쓴다.
const usageRecords = []; const unmappedLabels = []; const badDates = [];
for (const person of people) {
  if (!person.employeeId || !sheetNames.includes(person.tab)) continue;
  const rows = await readXlsxFile(xlsxPath, { sheet: person.tab });
  for (const [index, row] of rows.entries()) {
    const rawDate = row[column("AI")]; const label = text(row[column("AL")]);
    if (rawDate === null || rawDate === undefined || text(rawDate) === "" || ["날짜", "사용내역"].includes(text(rawDate))) continue;
    // AI2·AI62 같은 요약 칸(총 사용일수)은 숫자다. 날짜 시리얼(20000 이상)만 날짜로 본다.
    if (typeof rawDate === "number" && rawDate < 20000) continue;
    const dates = expandDateRange(rawDate);
    if (!dates.length) { badDates.push(`${person.name} ${person.tab}!AI${index + 1}=${text(rawDate)}`); continue; }
    if (!label) continue;
    const kind = leaveKindFromLabel(label);
    if (!kind) { unmappedLabels.push(`${person.name} ${person.tab}!AL${index + 1}=${label}`); continue; }
    for (const date of dates) usageRecords.push({ employeeId: person.employeeId, name: person.name, date, label, leaveType: kind });
  }
}

// 4) 월차 만근의 「제외」 → 조정
const attendance = await readXlsxFile(xlsxPath, { sheet: "월차 만근" });
const adjustments = attendance.slice(4).filter((row) => text(row[0]) && text(row[5]) === "제외").map((row) => {
  const person = people.find((item) => item.name === text(row[0]));
  return person?.employeeId ? { employeeId: person.employeeId, name: person.name, grantKey: `MONTHLY-${number(row[1])}`, note: "시트 이관: 제외" } : null;
}).filter(Boolean);

// 5) 미리보기 — 시트 요약과 엔진 결과를 나란히
const UNITS = { ANNUAL: 1, HALF: 0.5, QUARTER: 0.25, BIRTHDAY_HALF: 0.5, OFFICIAL: 1, SICK: 1, FAMILY: 1, OTHER: 1 };
const DEDUCTS = new Set(["ANNUAL", "HALF", "QUARTER"]);
const preview = people.map((person) => {
  const mine = usageRecords.filter((record) => record.employeeId === person.employeeId);
  const usages = mine.map((record, index) => ({ id: String(index), date: record.date, kind: record.leaveType, units: UNITS[record.leaveType], deducts: DEDUCTS.has(record.leaveType) }));
  const ledger = person.employeeId && person.joinDate ? computeLeaveLedger({
    employeeId: person.employeeId, joinDate: person.joinDate, exitDate: person.endDate, today, usages,
    adjustments: adjustments.filter((item) => item.employeeId === person.employeeId).map((item) => ({ grantKey: item.grantKey, status: "EXCLUDED" })),
  }) : null;
  const deducted = usages.filter((usage) => usage.deducts).reduce((sum, usage) => sum + usage.units, 0);
  return {
    이름: person.name, 사번: person.employeeId || "(미매칭)", 입사일: person.joinDate, 기록: mine.length,
    "시트 사용": person.sheetUsed, "ERP 사용": deducted, "시트 발생": person.sheetGranted, "ERP 발생": ledger?.granted ?? "",
    "시트 잔여": person.sheetBalance, "ERP 잔여": ledger?.balance ?? "", 소멸: ledger?.expired ?? "", 초과: ledger?.overdraft ?? "",
  };
});
console.table(preview);
console.log(`기록 ${usageRecords.length}건, 제외 조정 ${adjustments.length}건, 대상 ${people.length}명 (기준일 ${today})`);
console.log("※ ERP 발생·잔여는 회사 결정(법정 가산, 1년 소멸)을 적용한 값이라 시트와 다를 수 있습니다. 「시트 사용 = ERP 사용」이면 기록 이관은 완전합니다.");
if (unmatched.length) console.log(`사번 미매칭 ${unmatched.length}명 (--map 이름=사번 으로 지정하거나, ERP 도입 전 퇴사자면 --skip-unmatched): ${unmatched.join(", ")}`);
if (badDates.length) console.log(`읽지 못한 날짜 ${badDates.length}건:\n  ${badDates.join("\n  ")}`);
if (unmappedLabels.length) console.log(`종류를 모르는 내용 ${unmappedLabels.length}건:\n  ${unmappedLabels.join("\n  ")}`);

if (!apply) { console.log("\n--apply 를 붙이면 ERP 에 저장합니다."); process.exit(0); }
if ((unmatched.length && !skipUnmatched) || badDates.length || unmappedLabels.length) { console.error("\n미매칭·오류가 남아 있어 저장하지 않았습니다. 위 항목을 정리한 뒤 다시 실행하세요."); process.exit(1); }
const response = await client.fetch("/api/hr/leave", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ resource: "import", records: usageRecords.map(({ employeeId, date, leaveType, label }) => ({ employeeId, date, leaveType, note: label })), adjustments: adjustments.map(({ employeeId, grantKey, note }) => ({ employeeId, grantKey, note })) }),
});
const payload = await response.json();
if (!response.ok) { console.error(`저장 실패 (${response.status}): ${payload.error ?? ""}`); process.exit(1); }
console.log(`저장 완료 — 기록 ${payload.imported}건, 조정 ${payload.adjustments}건, 직원 ${payload.employees}명`);
console.table(payload.ledgers.map((ledger) => ({ 이름: ledger.name, 발생: ledger.granted, 사용: ledger.used, 소멸: ledger.expired, 잔여: ledger.balance, 촉진: ledger.promotions.length })));
