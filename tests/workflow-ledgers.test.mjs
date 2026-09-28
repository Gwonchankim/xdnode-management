import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    const source = await readFile(new URL(name, migrationDirectory), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  return db;
}

test("new workflow ledgers migrate cleanly and enforce one payment per request", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO finance_expense_requests
    (id, request_kind, title, amount, requested_date, requester_employee_id, created_at, updated_at)
    VALUES (?, 'EXPENSE', ?, ?, ?, ?, ?, ?)`)
    .run("expense-1", "테스트 지출", 10000, "2026-08-14", "gc.kim", now, now);
  const expense = db.prepare("SELECT source_type, source_id FROM finance_expense_requests WHERE id = ?").get("expense-1");
  assert.equal(expense.source_type, "MANUAL");
  assert.equal(expense.source_id, "");
  const insertPayment = db.prepare(`INSERT INTO finance_payment_ledger
    (id, request_id, payment_date, amount, payment_method, paid_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'BANK_TRANSFER', 'gc.kim', ?, ?)`);
  insertPayment.run("payment-1", "expense-1", "2026-08-14", 10000, now, now);
  assert.throws(() => insertPayment.run("payment-2", "expense-1", "2026-08-14", 10000, now, now), /UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM finance_payment_ledger WHERE request_id = ?").get("expense-1").count, 1);
  const insertJournal = db.prepare(`INSERT INTO finance_journal_entries
    (id, payment_request_id, voucher_date, description, debit_account_name, credit_account_name,
      amount, prepared_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertJournal.run("journal-1", "expense-1", "2026-08-14", "테스트 지출", "소모품비", "보통예금", 10000, "gc.kim", now, now);
  assert.throws(() => insertJournal.run("journal-2", "expense-1", "2026-08-14", "중복", "소모품비", "보통예금", 10000, "gc.kim", now, now), /UNIQUE constraint failed/);
});

test("master impact assessments preserve frozen evidence and one-time consumption state", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  db.prepare(`INSERT INTO erp_master_impact_assessments
    (id,entity_type,entity_id,proposed_action,entity_version,entity_label,risk_level,blocking_count,warning_count,
      impacted_record_count,impact_json,checksum,requested_by,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("impact-1","FINANCE_ACCOUNT","account-1","DEACTIVATE","100","10100 · 현금","MEDIUM",0,2,3,"[]","checksum-1","gc.kim",now,now+900000);
  const consumed = db.prepare(`UPDATE erp_master_impact_assessments SET used_at=?,used_by=?,target_type=?,target_id=?
    WHERE id=? AND used_at IS NULL AND expires_at>=?`).run(now,"gc.kim","FINANCE_MASTER_CHANGE","change-1","impact-1",now);
  assert.equal(consumed.changes, 1);
  const reused = db.prepare(`UPDATE erp_master_impact_assessments SET used_at=? WHERE id=? AND used_at IS NULL`).run(now+1,"impact-1");
  assert.equal(reused.changes, 0);
  const row = db.prepare("SELECT checksum,used_by,target_type,target_id FROM erp_master_impact_assessments WHERE id='impact-1'").get();
  assert.deepEqual({...row},{checksum:"checksum-1",used_by:"gc.kim",target_type:"FINANCE_MASTER_CHANGE",target_id:"change-1"});
  const queryPlan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM erp_master_impact_assessments WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC").all("FINANCE_ACCOUNT","account-1");
  assert.match(queryPlan.map((item) => item.detail).join(" "), /idx_erp_master_impact_entity_created/); db.close();
});

test("master impact resolution cases prevent duplicate active work and preserve append-only evidence", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertAssessment = db.prepare(`INSERT INTO erp_master_impact_assessments
    (id,entity_type,entity_id,proposed_action,entity_version,entity_label,risk_level,blocking_count,warning_count,
      impacted_record_count,impact_json,checksum,requested_by,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertAssessment.run("assessment-case-1","FINANCE_ACCOUNT","account-1","DEACTIVATE","100","10100 · 현금","HIGH",1,0,2,"[]","checksum-case-1","gc.kim",now,now+900000);
  insertAssessment.run("assessment-case-2","FINANCE_ACCOUNT","account-1","DEACTIVATE","100","10100 · 현금","HIGH",1,0,1,"[]","checksum-case-2","gc.kim",now+1,now+900001);
  const insertCase = db.prepare(`INSERT INTO erp_master_impact_cases
    (id,assessment_id,entity_type,entity_id,action,impact_code,impact_label,impact_detail,severity,initial_count,current_count,
      initial_amount,current_amount,status,owner_employee_id,due_date,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertCase.run("case-1","assessment-case-1","FINANCE_ACCOUNT","account-1","DEACTIVATE","UNPOSTED_JOURNAL","미전기 분개","미전기 2건","BLOCKER",2,2,10000,10000,"OPEN","gc.kim","2026-08-18","gc.kim",now,now);
  assert.throws(() => insertCase.run("case-duplicate","assessment-case-2","FINANCE_ACCOUNT","account-1","DEACTIVATE","UNPOSTED_JOURNAL","미전기 분개","미전기 1건","BLOCKER",1,1,5000,5000,"OPEN","gc.kim","2026-08-18","gc.kim",now,now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO erp_master_impact_case_events
    (id,case_id,action,actor_employee_id,from_status,to_status,note,snapshot_json,created_at)
    VALUES ('case-event-1','case-1','CASE_CREATED','gc.kim','','OPEN','차단 업무 생성','{"count":2}',?)`).run(now);
  db.prepare("UPDATE erp_master_impact_cases SET status='CLOSED',current_count=0,resolution_note='연결 전표 정리 후 재검증 완료',evidence_ref='VOUCHER-1',last_rechecked_at=?,closed_by='gc.kim',closed_at=? WHERE id='case-1'").run(now+1,now+1);
  insertCase.run("case-2","assessment-case-2","FINANCE_ACCOUNT","account-1","DEACTIVATE","UNPOSTED_JOURNAL","미전기 분개","재발 1건","BLOCKER",1,1,5000,5000,"OPEN","gc.kim","2026-08-19","gc.kim",now+2,now+2);
  db.prepare(`INSERT INTO erp_master_impact_case_events
    (id,case_id,action,actor_employee_id,from_status,to_status,note,snapshot_json,created_at)
    VALUES ('case-event-2','case-1','CLOSE','gc.kim','VERIFIED','CLOSED','증빙 확인','{"evidenceRef":"VOUCHER-1"}',?)`).run(now+1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM erp_master_impact_case_events WHERE case_id='case-1'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM erp_master_impact_cases WHERE entity_id='account-1'").get().count, 2);
  const queryPlan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM erp_master_impact_cases WHERE status=? AND due_date<?").all("OPEN","2026-08-20");
  assert.match(queryPlan.map((item) => item.detail).join(" "), /idx_erp_master_impact_case_status_due/); db.close();
});

test("master impact SLA policy versions and weekly snapshots remain durable and non-duplicating", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const policy = db.prepare("SELECT default_due_days,manager_escalation_days,executive_escalation_days,version FROM erp_master_impact_sla_policies WHERE id='default'").get();
  assert.deepEqual({ ...policy }, { default_due_days: 3, manager_escalation_days: 1, executive_escalation_days: 3, version: 1 });
  const updated = db.prepare("UPDATE erp_master_impact_sla_policies SET default_due_days=5,version=version+1,updated_by='gc.kim',updated_at=? WHERE id='default' AND version=1").run(now);
  const stale = db.prepare("UPDATE erp_master_impact_sla_policies SET default_due_days=7,version=version+1 WHERE id='default' AND version=1").run();
  assert.equal(updated.changes, 1); assert.equal(stale.changes, 0);

  db.prepare(`INSERT INTO erp_master_impact_assessments
    (id,entity_type,entity_id,proposed_action,entity_version,entity_label,risk_level,blocking_count,warning_count,impacted_record_count,impact_json,checksum,requested_by,created_at,expires_at)
    VALUES ('sla-assessment','FINANCE_ACCOUNT','account-sla','DEACTIVATE','1','10100 · 현금','HIGH',1,0,1,'[]','sla-hash','gc.kim',?,?)`).run(now, now + 900000);
  db.prepare(`INSERT INTO erp_master_impact_cases
    (id,assessment_id,entity_type,entity_id,action,impact_code,impact_label,impact_detail,severity,initial_count,current_count,status,owner_employee_id,due_date,created_by,created_at,updated_at)
    VALUES ('sla-case','sla-assessment','FINANCE_ACCOUNT','account-sla','DEACTIVATE','OPEN_ITEM','미결 원장','미결 1건','BLOCKER',1,1,'OPEN','gc.kim','2026-08-10','gc.kim',?,?)`).run(now, now);
  const escalated = db.prepare("UPDATE erp_master_impact_cases SET escalation_level=1,escalated_at=? WHERE id='sla-case' AND escalation_level<1").run(now);
  const duplicateEscalation = db.prepare("UPDATE erp_master_impact_cases SET escalation_level=1,escalated_at=? WHERE id='sla-case' AND escalation_level<1").run(now + 1);
  assert.equal(escalated.changes, 1); assert.equal(duplicateEscalation.changes, 0);

  const insertReport = db.prepare(`INSERT INTO erp_master_impact_weekly_reports
    (id,week_start,week_end,version,active_count,overdue_count,manager_escalated_count,executive_escalated_count,snapshot_json,checksum,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertReport.run('weekly-1','2026-08-10','2026-08-16',1,1,1,1,0,'{"active":1}','weekly-hash-1','gc.kim',now);
  insertReport.run('weekly-2','2026-08-10','2026-08-16',2,1,1,1,0,'{"active":1}','weekly-hash-2','gc.kim',now + 1);
  assert.throws(() => insertReport.run('weekly-duplicate','2026-08-10','2026-08-16',2,1,1,1,0,'{}','duplicate','gc.kim',now + 2), /UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM erp_master_impact_weekly_reports WHERE week_start='2026-08-10'").get().count, 2);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM erp_master_impact_weekly_reports ORDER BY created_at DESC").all();
  assert.match(plan.map((item) => item.detail).join(" "), /idx_erp_master_impact_weekly_report_created/); db.close();
});

test("finance risk policy extends the single cash-policy record with safe defaults", async () => {
  const db = await migratedDatabase();
  const columns = db.prepare("PRAGMA table_info(finance_cash_forecast_settings)").all().map((column) => column.name);
  for (const name of ["risk_policy_configured", "risk_policy_version", "minimum_debt_coverage_bps",
    "maximum_fx_concentration_bps", "warning_drawdown_bps", "critical_drawdown_bps", "low_balance_threshold"]) {
    assert.ok(columns.includes(name), `${name} column should exist`);
  }
  const now = Date.now();
  db.prepare(`INSERT INTO finance_cash_forecast_settings
    (id, minimum_cash_balance, include_fx, default_scenario, collection_probability, updated_by, created_at, updated_at)
    VALUES ('default', 0, 0, 'BASE', 85, '', ?, ?)`).run(now, now);
  const policy = db.prepare(`SELECT risk_policy_configured, risk_policy_version, minimum_debt_coverage_bps,
    maximum_fx_concentration_bps, warning_drawdown_bps, critical_drawdown_bps, low_balance_threshold
    FROM finance_cash_forecast_settings WHERE id = 'default'`).get();
  assert.deepEqual({ ...policy }, {
    risk_policy_configured: 0, risk_policy_version: 1, minimum_debt_coverage_bps: 12500,
    maximum_fx_concentration_bps: 5000, warning_drawdown_bps: 2000,
    critical_drawdown_bps: 3500, low_balance_threshold: 100000,
  });
});

test("daily treasury reports keep immutable-style versions unique per report date", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO finance_daily_treasury_reports
    (id, report_date, version, status, source_as_of, snapshot_json, analysis_text, analysis_source,
      ai_status, generated_by, created_at, updated_at)
    VALUES (?, '2026-08-14', ?, ?, '2026-08-14', ?, ?, ?, ?, 'gc.kim', ?, ?)`);
  insert.run("daily-1", 1, "FINAL", '{"balances":{"closingBankAssets":1632535863}}', "규칙 기반 분석", "RULE_BASED_FALLBACK", "QUOTA", now, now);
  assert.throws(() => insert.run("daily-duplicate", 1, "DRAFT", "{}", "분석", "AI", "SUCCESS", now, now), /UNIQUE constraint failed/);
  insert.run("daily-2", 2, "DRAFT", '{"balances":{"closingBankAssets":1632535863}}', "AI 분석", "AI", "SUCCESS", now, now);
  const rows = db.prepare("SELECT version, status, analysis_source FROM finance_daily_treasury_reports WHERE report_date = ? ORDER BY version").all("2026-08-14");
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { version: 1, status: "FINAL", analysis_source: "RULE_BASED_FALLBACK" },
    { version: 2, status: "DRAFT", analysis_source: "AI" },
  ]);
});

test("fixed asset ledgers keep source registration and monthly depreciation unique", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertAsset = db.prepare(`INSERT INTO finance_fixed_assets
    (id, asset_code, name, category, acquisition_date, in_service_date, acquisition_cost, useful_life_months,
      asset_account_code, accumulated_account_code, expense_account_code, source_type, source_id, source_reference,
      created_by, created_at, updated_at)
    VALUES (?, ?, '테스트 장비', 'EQUIPMENT', '2026-01-01', '2026-01-01', 1200000, 12,
      '1500', '1590', '8200', 'PURCHASE_ORDER_LINE', ?, 'PO-001', 'gc.kim', ?, ?)`);
  insertAsset.run("asset-1", "FA-001", "line-1", now, now);
  assert.throws(() => insertAsset.run("asset-2", "FA-002", "line-1", now, now), /UNIQUE constraint failed/);
  assert.throws(() => insertAsset.run("asset-3", "FA-001", "line-3", now, now), /UNIQUE constraint failed/);
  const insertSchedule = db.prepare(`INSERT INTO finance_asset_depreciation_schedules
    (id, asset_id, period, depreciation_amount, closing_accumulated, closing_book_value, created_by, created_at, updated_at)
    VALUES (?, 'asset-1', '2026-01', 100000, 100000, 1100000, 'gc.kim', ?, ?)`);
  insertSchedule.run("dep-1", now, now);
  assert.throws(() => insertSchedule.run("dep-2", now, now), /UNIQUE constraint failed/);
});

test("payroll close can identify its single downstream finance request", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO finance_expense_requests
    (id, request_kind, title, amount, requested_date, account_name, source_type, source_id,
      status, requester_employee_id, evidence_required, created_at, updated_at)
    VALUES (?, 'PAYMENT', ?, ?, ?, ?, 'PAYROLL_RUN', ?, 'APPROVED', ?, 0, ?, ?)`)
    .run("payroll:2026-08", "2026-08 급여 지급", 12345678, "2026-08-14", "급여(계정 확인 필요)", "2026-08", "gc.kim", now, now);
  assert.throws(() => db.prepare(`INSERT INTO finance_expense_requests
    (id, request_kind, title, amount, requested_date, source_type, source_id, requester_employee_id, created_at, updated_at)
    VALUES (?, 'PAYMENT', ?, ?, ?, 'PAYROLL_RUN', ?, ?, ?, ?)`)
    .run("payroll:2026-08", "중복 급여", 1, "2026-08-14", "2026-08", "gc.kim", now, now), /UNIQUE constraint failed/);
  const linked = db.prepare("SELECT source_type, source_id, status, evidence_required FROM finance_expense_requests WHERE id = ?").get("payroll:2026-08");
  assert.equal(linked.source_type, "PAYROLL_RUN");
  assert.equal(linked.source_id, "2026-08");
  assert.equal(linked.status, "APPROVED");
  assert.equal(linked.evidence_required, 0);
});

test("sales payment allocations preserve partial collections and one invoice target per payment", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO sales_accounts
    (id, name, owner_employee_id, created_at, updated_at) VALUES ('account-1', '테스트 고객사', 'gc.kim', ?, ?)`)
    .run(now, now);
  db.prepare(`INSERT INTO sales_opportunities
    (id, account_id, title, owner_employee_id, created_at, updated_at) VALUES ('opportunity-1', 'account-1', '테스트 매출', 'gc.kim', ?, ?)`)
    .run(now, now);
  const insertDocument = db.prepare(`INSERT INTO sales_documents
    (id, opportunity_id, document_type, document_number, amount, status, issued_date, created_at, updated_at)
    VALUES (?, 'opportunity-1', ?, ?, ?, ?, '2026-08-14', ?, ?)`);
  insertDocument.run("invoice-1", "INVOICE", "INV-001", 100000, "ACCEPTED", now, now);
  insertDocument.run("payment-1", "PAYMENT", "PAY-001", 40000, "ACCEPTED", now, now);
  insertDocument.run("payment-2", "PAYMENT", "PAY-002", 25000, "DRAFT", now, now);
  const insertAllocation = db.prepare(`INSERT INTO sales_payment_allocations
    (id, payment_document_id, invoice_document_id, amount, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'gc.kim', ?, ?)`);
  insertAllocation.run("allocation-1", "payment-1", "invoice-1", 40000, now, now);
  insertAllocation.run("allocation-2", "payment-2", "invoice-1", 25000, now, now);
  assert.throws(() => insertAllocation.run("allocation-3", "payment-2", "invoice-other", 25000, now, now), /UNIQUE constraint failed/);
  const totals = db.prepare(`SELECT
    SUM(allocation.amount) AS reserved,
    SUM(CASE WHEN payment.status IN ('ACCEPTED','COMPLETED') THEN allocation.amount ELSE 0 END) AS collected
    FROM sales_payment_allocations allocation JOIN sales_documents payment ON payment.id = allocation.payment_document_id
    WHERE allocation.invoice_document_id = ? AND payment.status <> 'CANCELLED'`).get("invoice-1");
  assert.equal(totals.reserved, 65000);
  assert.equal(totals.collected, 40000);
  const receivable = db.prepare(`SELECT invoice.id,
    COALESCE(SUM(CASE WHEN payment.status IN ('ACCEPTED','COMPLETED') THEN allocation.amount ELSE 0 END), 0) AS collected_amount,
    COALESCE(SUM(CASE WHEN payment.status NOT IN ('CANCELLED','ACCEPTED','COMPLETED') THEN allocation.amount ELSE 0 END), 0) AS reserved_amount
    FROM sales_documents invoice
    JOIN sales_opportunities opportunity ON opportunity.id = invoice.opportunity_id
    JOIN sales_accounts account ON account.id = opportunity.account_id
    LEFT JOIN sales_payment_allocations allocation ON allocation.invoice_document_id = invoice.id
    LEFT JOIN sales_documents payment ON payment.id = allocation.payment_document_id
    LEFT JOIN finance_receivable_cases receivable_case ON receivable_case.invoice_id = invoice.id
    WHERE invoice.document_type = 'INVOICE' AND invoice.status IN ('ACCEPTED','COMPLETED') AND invoice.id = ?
    GROUP BY invoice.id`).get("invoice-1");
  assert.equal(receivable.collected_amount, 40000);
  assert.equal(receivable.reserved_amount, 25000);
  assert.equal(100000 - receivable.collected_amount, 60000);
});

test("purchase ledgers preserve ordered quantities, accepted receipts and invoice uniqueness", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO finance_purchase_vendors
    (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run("vendor-1", "테스트 공급사", "gc.kim", now, now);
  db.prepare(`INSERT INTO finance_purchase_orders
    (id, order_number, vendor_id, title, subtotal, tax_amount, total_amount, status,
      requester_employee_id, approved_by, approved_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?, ?)`)
    .run("order-1", "PO-001", "vendor-1", "원재료 발주", 100000, 10000, 110000, "gc.kim", "gc.kim", now, now, now);
  db.prepare(`INSERT INTO finance_purchase_order_lines
    (id, order_id, line_number, item_name, quantity_milli, unit_price, line_amount, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`)
    .run("order-line-1", "order-1", "원재료 A", 10000, 10000, 100000, now, now);
  db.prepare(`INSERT INTO finance_purchase_receipts
    (id, order_id, receipt_number, receipt_date, received_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("receipt-1", "order-1", "GR-001", "2026-08-14", "gc.kim", now, now);
  db.prepare(`INSERT INTO finance_purchase_receipt_lines
    (id, receipt_id, order_line_id, received_quantity_milli, accepted_quantity_milli, rejected_quantity_milli, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("receipt-line-1", "receipt-1", "order-line-1", 10000, 8000, 2000, now, now);
  const accepted = db.prepare(`SELECT ROUND(SUM(receipt_line.accepted_quantity_milli * order_line.unit_price / 1000.0)) AS amount
    FROM finance_purchase_receipt_lines receipt_line JOIN finance_purchase_order_lines order_line ON order_line.id = receipt_line.order_line_id
    WHERE receipt_line.receipt_id = ?`).get("receipt-1");
  assert.equal(accepted.amount, 80000);
  const insertInvoice = db.prepare(`INSERT INTO finance_purchase_invoices
    (id, order_id, vendor_id, invoice_number, invoice_date, supply_amount, tax_amount, total_amount,
      matched_receipt_amount, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertInvoice.run("invoice-1", "order-1", "vendor-1", "INV-001", "2026-08-14", 80000, 8000, 88000, 80000, "MATCHED", "gc.kim", now, now);
  assert.throws(() => insertInvoice.run("invoice-2", "order-1", "vendor-1", "INV-001", "2026-08-14", 1, 0, 1, 1, "MATCHED", "gc.kim", now, now), /UNIQUE constraint failed/);
  insertInvoice.run("invoice-other-vendor", "order-2", "vendor-2", "INV-001", "2026-08-14", 1, 0, 1, 1, "MATCHED", "gc.kim", now, now);
  db.prepare(`INSERT INTO finance_payable_plans
    (invoice_id, plan_status, planned_payment_date, priority, owner_employee_id, updated_by, created_at, updated_at)
    VALUES ('invoice-1', 'SCHEDULED', '2026-08-20', 'HIGH', 'gc.kim', 'gc.kim', ?, ?)`).run(now, now);
  assert.throws(() => db.prepare(`INSERT INTO finance_payable_plans
    (invoice_id, plan_status, updated_by, created_at, updated_at) VALUES ('invoice-1', 'HOLD', 'gc.kim', ?, ?)`).run(now, now), /UNIQUE constraint failed/);
  const payable = db.prepare("SELECT * FROM finance_payable_plans WHERE invoice_id = 'invoice-1'").get();
  assert.equal(payable.planned_payment_date, "2026-08-20");
  assert.equal(payable.priority, "HIGH");
});

test("inventory movements keep source lines unique and preserve moving-average stock value", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO inventory_products
    (id, sku, name, category, unit, minimum_stock_milli, status, created_by, created_at, updated_at)
    VALUES ('product-1', 'GPU-001', '테스트 GPU', 'GPU', 'EA', 2000, 'ACTIVE', 'gc.kim', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO inventory_warehouses
    (id, code, name, location, status, created_by, created_at, updated_at)
    VALUES ('warehouse-1', 'MAIN', '주창고', '서울', 'ACTIVE', 'gc.kim', ?, ?)`).run(now, now);
  const insertMovement = db.prepare(`INSERT INTO inventory_movements
    (id, movement_date, movement_type, direction, product_id, warehouse_id, quantity_milli, unit_cost, amount,
      source_type, source_id, source_line_key, reference_number, reason, posted_by, created_at)
    VALUES (?, '2026-08-14', ?, ?, 'product-1', 'warehouse-1', ?, ?, ?, ?, ?, ?, ?, ?, 'gc.kim', ?)`);
  insertMovement.run("movement-in-1", "PURCHASE_RECEIPT_IN", "IN", 10000, 100000, 1000000, "PURCHASE_RECEIPT", "receipt-1", "receipt-line-1", "GR-001", "", now);
  assert.throws(() => insertMovement.run("movement-in-duplicate", "PURCHASE_RECEIPT_IN", "IN", 1000, 100000, 100000, "PURCHASE_RECEIPT", "receipt-1", "receipt-line-1", "GR-001", "", now), /UNIQUE constraint failed/);
  insertMovement.run("movement-out-1", "DELIVERY_OUT", "OUT", 4000, 100000, 400000, "SALES_DELIVERY", "delivery-1", "product-1:warehouse-1", "DN-001", "", now);
  const stock = db.prepare(`SELECT
    SUM(CASE WHEN direction = 'IN' THEN quantity_milli ELSE -quantity_milli END) AS quantity_milli,
    SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END) AS stock_amount
    FROM inventory_movements WHERE product_id = 'product-1' AND warehouse_id = 'warehouse-1'`).get();
  assert.equal(stock.quantity_milli, 6000);
  assert.equal(stock.stock_amount, 600000);
});

test("cash reconciliation ledgers preserve source rows, partial allocations and reversible match groups", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  const insertTransaction = db.prepare(`INSERT INTO finance_bank_transactions
    (id, source_snapshot_date, account_id, currency, transaction_at, transaction_date,
      direction, amount, imported_at, updated_at) VALUES (?, '2026-08-14', ?, 'KRW', ?, ?, ?, ?, ?, ?)`);
  insertTransaction.run("bank-in-1", "162643", "2026-08-13T10:00:00", "2026-08-13", "IN", 100000, now, now);
  insertTransaction.run("bank-out-1", "162645", "2026-08-13T10:00:00", "2026-08-13", "OUT", 100000, now, now);
  const insertMatch = db.prepare(`INSERT INTO finance_cash_matches
    (id, match_group_id, bank_transaction_id, source_type, source_id, matched_amount,
      confirmed_by, confirmed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'gc.kim', ?, ?, ?)`);
  insertMatch.run("match-1", "group-1", "bank-out-1", "PAYMENT_LEDGER", "payment-1", 40000, now, now, now);
  insertMatch.run("match-2", "group-2", "bank-out-1", "PAYMENT_LEDGER", "payment-2", 60000, now, now, now);
  const allocated = db.prepare(`SELECT SUM(matched_amount) AS amount FROM finance_cash_matches
    WHERE bank_transaction_id = ? AND status = 'CONFIRMED'`).get("bank-out-1");
  assert.equal(allocated.amount, 100000);
  assert.throws(() => insertMatch.run("match-3", "group-3", "bank-out-1", "PAYMENT_LEDGER", "payment-2", 1, now, now, now), /UNIQUE constraint failed/);
  db.prepare(`UPDATE finance_cash_matches SET status = 'REVERSED', reversed_by = 'gc.kim',
    reversed_at = ?, reversal_reason = '잘못 연결', updated_at = ? WHERE match_group_id = ?`)
    .run(now, now, "group-2");
  const remainingAllocation = db.prepare(`SELECT SUM(matched_amount) AS amount FROM finance_cash_matches
    WHERE bank_transaction_id = ? AND status = 'CONFIRMED'`).get("bank-out-1");
  assert.equal(remainingAllocation.amount, 40000);
});

test("retirement and recruitment offer ledgers preserve workflow state", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO hr_retirement_requests
    (id, employee_id, retirement_date, reason, checklist_json, total_tasks, completed_tasks, requested_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("retirement-1", "gc.kim", "2026-09-30", "본인 의사", "[]", 10, 0, "gc.kim", now, now);
  db.prepare(`INSERT INTO hr_offer_requests
    (id, applicant_id, proposed_title, department, employment_type, start_date, annual_salary,
      probation_months, requested_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("offer-1", "applicant-1", "연구개발", "기술팀", "일반직", "2026-09-01", 42000000, 3, "gc.kim", now, now);
  db.prepare(`INSERT INTO hr_retirement_settlements
    (request_id, created_at, updated_at) VALUES (?, ?, ?)`)
    .run("retirement-1", now, now);
  const retirement = db.prepare("SELECT status, total_tasks, completed_tasks FROM hr_retirement_requests WHERE id = ?").get("retirement-1");
  const offer = db.prepare("SELECT status, annual_salary, probation_months, employee_id, response_note, responded_by FROM hr_offer_requests WHERE id = ?").get("offer-1");
  const settlement = db.prepare("SELECT status, net_settlement, access_revoked FROM hr_retirement_settlements WHERE request_id = ?").get("retirement-1");
  assert.equal(retirement.status, "SUBMITTED");
  assert.equal(retirement.total_tasks, 10);
  assert.equal(retirement.completed_tasks, 0);
  assert.equal(offer.status, "SUBMITTED");
  assert.equal(offer.annual_salary, 42000000);
  assert.equal(offer.probation_months, 3);
  assert.equal(offer.employee_id, "");
  assert.equal(settlement.status, "DRAFT");
  assert.equal(settlement.net_settlement, 0);
  assert.equal(settlement.access_revoked, 0);
});

test("cash forecast settings persist and daily scenario snapshots remain unique", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO finance_cash_forecast_settings
    (id, minimum_cash_balance, include_fx, default_scenario, collection_probability, updated_by, created_at, updated_at)
    VALUES ('default', ?, 1, 'CONSERVATIVE', 70, 'gc.kim', ?, ?)`)
    .run(300000000, now, now);
  db.prepare(`INSERT INTO finance_cash_forecast_snapshots
    (id, as_of, scenario, opening_cash, projected_ending_cash, lowest_cash, minimum_cash_balance,
      low_week_count, missing_date_count, buckets_json, source_counts_json, created_at, updated_at)
    VALUES (?, '2026-08-14', 'CONSERVATIVE', ?, ?, ?, ?, 2, 3, '[]', '{}', ?, ?)`)
    .run("2026-08-14:CONSERVATIVE", 500000000, 250000000, 200000000, 300000000, now, now);
  assert.throws(() => db.prepare(`INSERT INTO finance_cash_forecast_snapshots
    (id, as_of, scenario, opening_cash, projected_ending_cash, lowest_cash, minimum_cash_balance,
      low_week_count, missing_date_count, buckets_json, source_counts_json, created_at, updated_at)
    VALUES (?, '2026-08-14', 'CONSERVATIVE', 1, 1, 1, 1, 0, 0, '[]', '{}', ?, ?)`)
    .run("duplicate", now, now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO finance_cash_forecast_snapshots
    (id, as_of, scenario, opening_cash, projected_ending_cash, lowest_cash, minimum_cash_balance,
      low_week_count, missing_date_count, buckets_json, source_counts_json, created_at, updated_at)
    VALUES (?, '2026-08-14', 'CONSERVATIVE', ?, ?, ?, ?, 1, 1, '[]', '{}', ?, ?)
    ON CONFLICT(as_of, scenario) DO UPDATE SET projected_ending_cash = excluded.projected_ending_cash,
      lowest_cash = excluded.lowest_cash, low_week_count = excluded.low_week_count,
      missing_date_count = excluded.missing_date_count, updated_at = excluded.updated_at`)
    .run("replacement", 500000000, 275000000, 225000000, 300000000, now, now + 1);
  const settings = db.prepare("SELECT * FROM finance_cash_forecast_settings WHERE id = 'default'").get();
  const snapshot = db.prepare("SELECT * FROM finance_cash_forecast_snapshots WHERE as_of = '2026-08-14' AND scenario = 'CONSERVATIVE'").get();
  assert.equal(settings.minimum_cash_balance, 300000000);
  assert.equal(settings.include_fx, 1);
  assert.equal(settings.collection_probability, 70);
  assert.equal(snapshot.projected_ending_cash, 275000000);
  assert.equal(snapshot.low_week_count, 1);
  assert.equal(snapshot.missing_date_count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM finance_cash_forecast_snapshots").get().count, 1);
  db.exec("PRAGMA optimize");
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM finance_cash_forecast_snapshots
    WHERE as_of = ? AND scenario = ?`).all("2026-08-14", "CONSERVATIVE");
  assert.ok(plan.some((row) => String(row.detail).includes("idx_finance_cash_forecast_snapshot_asof_scenario")));
});

test("month-end close runs preserve a frozen snapshot and versioned reopen history", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  const snapshot = JSON.stringify({
    period: "2026-08",
    controls: [{ key: "BANK_RECONCILIATION", status: "PASS", count: 0 }],
    evidenceCount: 2,
  });
  const insert = db.prepare(`INSERT INTO finance_close_runs
    (period, period_end, status, control_pass_count, control_fail_count,
      manual_completed_count, manual_total_count, evidence_count, snapshot_json,
      submitted_by, submitted_at, created_at, updated_at)
    VALUES (?, ?, 'SUBMITTED', 5, 0, 3, 3, 2, ?, 'gc.kim', ?, ?, ?)`);
  insert.run("2026-08", "2026-08-31", snapshot, now, now, now);
  assert.throws(() => insert.run("2026-08", "2026-08-31", snapshot, now, now, now), /UNIQUE constraint failed/);

  db.prepare(`UPDATE finance_close_runs SET status = 'CLOSED', closed_by = ?, closed_at = ?, updated_at = ?
    WHERE period = ? AND status = 'SUBMITTED'`).run("gc.kim", now + 1, now + 1, "2026-08");
  const closed = db.prepare("SELECT * FROM finance_close_runs WHERE period = ?").get("2026-08");
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.snapshot_json, snapshot);
  assert.equal(closed.version, 1);

  db.prepare(`UPDATE finance_close_runs SET status = 'OPEN', reopened_by = ?, reopened_at = ?,
    reopened_reason = ?, version = version + 1, updated_at = ? WHERE period = ? AND status = 'CLOSED'`)
    .run("gc.kim", now + 2, "결산 수정분 반영", now + 2, "2026-08");
  const reopened = db.prepare("SELECT * FROM finance_close_runs WHERE period = ?").get("2026-08");
  assert.equal(reopened.status, "OPEN");
  assert.equal(reopened.version, 2);
  assert.equal(reopened.reopened_reason, "결산 수정분 반영");
  assert.equal(reopened.snapshot_json, snapshot);

  db.exec("PRAGMA optimize");
  const indexes = db.prepare("PRAGMA index_list(finance_close_runs)").all();
  assert.ok(indexes.some((row) => row.name === "idx_finance_close_run_status_period"));
});

test("budget plans preserve approved versions, source mappings and one variance action per line", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  const insertPlan = db.prepare(`INSERT INTO finance_budget_plans
    (id, fiscal_year, name, status, version, owner_employee_id, approved_by, approved_at, created_at, updated_at)
    VALUES (?, 2026, ?, ?, ?, 'gc.kim', ?, ?, ?, ?)`);
  insertPlan.run("budget-v1", "2026 경영예산", "APPROVED", 1, "gc.kim", now, now, now);
  assert.throws(() => insertPlan.run("budget-v1-duplicate", "중복", "DRAFT", 1, "", null, now, now), /UNIQUE constraint failed/);

  const insertLine = db.prepare(`INSERT INTO finance_budget_plan_lines
    (id, plan_id, month, department, account_code, account_name, direction, actual_source,
      amount, threshold_pct, notes, created_at, updated_at)
    VALUES (?, 'budget-v1', ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`);
  insertLine.run("budget-line-sales", 8, "전사", "", "매출", "REVENUE", "SALES_INVOICE", 6000000000, 10, now, now);
  insertLine.run("budget-line-expense", 8, "전사", "", "매입", "EXPENSE", "PURCHASE_INVOICE", 4500000000, 10, now, now);
  assert.throws(() => insertLine.run("budget-line-sales-duplicate", 8, "전사", "", "매출", "REVENUE", "SALES_INVOICE", 1, 10, now, now), /UNIQUE constraint failed/);

  const insertAction = db.prepare(`INSERT INTO finance_budget_variance_actions
    (id, plan_id, line_id, period, status, cause, action_plan, owner_employee_id, due_date,
      created_by, created_at, updated_at) VALUES (?, 'budget-v1', 'budget-line-sales', '2026-08',
      'ACTIONED', ?, ?, 'gc.kim', '2026-08-31', 'gc.kim', ?, ?)`);
  insertAction.run("variance-action-1", "납품 이연", "납품 및 세금계산서 발행 일정 확정", now, now);
  assert.throws(() => insertAction.run("variance-action-2", "중복", "중복", now, now), /UNIQUE constraint failed/);

  insertPlan.run("budget-v2", "2026 경영예산", "DRAFT", 2, "", null, now + 1, now + 1);
  db.prepare(`INSERT INTO finance_budget_plan_lines
    (id, plan_id, month, department, account_code, account_name, direction, actual_source,
      amount, threshold_pct, notes, created_at, updated_at)
    SELECT 'budget-v2-' || id, 'budget-v2', month, department, account_code, account_name,
      direction, actual_source, amount, threshold_pct, notes, ?, ? FROM finance_budget_plan_lines WHERE plan_id = 'budget-v1'`)
    .run(now + 1, now + 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM finance_budget_plan_lines WHERE plan_id = 'budget-v2'").get().count, 2);
  assert.equal(db.prepare("SELECT status FROM finance_budget_plans WHERE id = 'budget-v1'").get().status, "APPROVED");

  db.exec("PRAGMA optimize");
  const planIndexes = db.prepare("PRAGMA index_list(finance_budget_plans)").all();
  const actionIndexes = db.prepare("PRAGMA index_list(finance_budget_variance_actions)").all();
  assert.ok(planIndexes.some((row) => row.name === "idx_finance_budget_plan_year_version"));
  assert.ok(actionIndexes.some((row) => row.name === "idx_finance_budget_variance_line_unique"));
});

test("management reports freeze approved snapshots, preserve versions and track accountable actions", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  const frozen = JSON.stringify({ period: "2026-07", asOf: "2026-08-14", sections: { commerce: { sales: 7843458347 } }, quality: { warningCount: 2 } });
  const insertReport = db.prepare(`INSERT INTO finance_management_reports
    (id, period, version, status, as_of, snapshot_json, auto_analysis_json, highlights, risks, decisions,
      quality_acknowledged, revision_reason, created_by, submitted_at, approved_by, approved_at, created_at, updated_at)
    VALUES (?, '2026-07', ?, ?, '2026-08-14', ?, '{}', '성과', '위험', '의사결정', 1, ?, 'gc.kim', ?, ?, ?, ?, ?)`);
  insertReport.run("report-v1", 1, "APPROVED", frozen, "", now, "gc.kim", now, now, now);
  assert.throws(() => insertReport.run("report-v1-duplicate", 1, "DRAFT", frozen, "", null, "", null, now, now), /UNIQUE constraint failed/);

  db.prepare(`INSERT INTO finance_management_report_actions
    (id, report_id, source_section, title, owner_employee_id, due_date, status, memo, created_by, created_at, updated_at)
    VALUES ('action-v1', 'report-v1', 'CASH', '유동성 계획 확인', 'gc.kim', '2026-08-20', 'OPEN', '', 'gc.kim', ?, ?)`)
    .run(now, now);
  insertReport.run("report-v2", 2, "SUBMITTED", frozen, "원천 정정", now + 1, "", null, now + 1, now + 1);
  db.prepare("UPDATE finance_management_reports SET status = 'SUPERSEDED', updated_at = ? WHERE id = 'report-v1' AND status = 'APPROVED'").run(now + 2);
  db.prepare("UPDATE finance_management_reports SET status = 'APPROVED', approved_by = 'gc.kim', approved_at = ?, updated_at = ? WHERE id = 'report-v2' AND status = 'SUBMITTED'").run(now + 2, now + 2);
  db.prepare("UPDATE finance_management_report_actions SET status = 'DONE', completed_at = ?, updated_at = ? WHERE id = 'action-v1'").run(now + 3, now + 3);

  const v1 = db.prepare("SELECT status, snapshot_json FROM finance_management_reports WHERE id = 'report-v1'").get();
  const v2 = db.prepare("SELECT status, snapshot_json, revision_reason FROM finance_management_reports WHERE id = 'report-v2'").get();
  const action = db.prepare("SELECT status, completed_at FROM finance_management_report_actions WHERE id = 'action-v1'").get();
  assert.equal(v1.status, "SUPERSEDED");
  assert.equal(v1.snapshot_json, frozen);
  assert.equal(v2.status, "APPROVED");
  assert.equal(v2.snapshot_json, frozen);
  assert.equal(v2.revision_reason, "원천 정정");
  assert.equal(action.status, "DONE");
  assert.equal(action.completed_at, now + 3);
  const reportIndexes = db.prepare("PRAGMA index_list(finance_management_reports)").all();
  const actionIndexes = db.prepare("PRAGMA index_list(finance_management_report_actions)").all();
  assert.ok(reportIndexes.some((row) => row.name === "idx_finance_management_report_period_version"));
  assert.ok(actionIndexes.some((row) => row.name === "idx_finance_management_report_action_status_due"));
});

test("management decisions preserve outcomes and create at most one linked follow-up action", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO finance_management_reports
    (id, period, version, status, as_of, snapshot_json, auto_analysis_json, highlights, risks, decisions,
      quality_acknowledged, revision_reason, created_by, submitted_at, approved_by, approved_at, created_at, updated_at)
    VALUES ('decision-report', '2026-08', 1, 'APPROVED', '2026-08-14', '{}', '{}', '성과', '위험', '결정',
      1, '', 'gc.kim', ?, 'gc.kim', ?, ?, ?)`)
    .run(now, now, now, now);
  db.prepare(`INSERT INTO finance_management_decisions
    (id, report_id, source_section, decision_type, title, proposal, financial_impact, owner_employee_id,
      decision_due_date, requires_action, status, resolution_note, resolved_by, resolved_at, action_id,
      created_by, created_at, updated_at)
    VALUES ('decision-1', 'decision-report', 'CASH', 'CASH', '운영자금 기준 승인', '최소 운영자금 기준을 승인합니다.',
      500000000, 'gc.kim', '2026-08-31', 1, 'PENDING', '', '', NULL, '', 'gc.kim', ?, ?)`)
    .run(now, now);
  db.prepare(`UPDATE finance_management_decisions SET status = 'APPROVED', resolution_note = '제안한 기준으로 승인',
    resolved_by = 'gc.kim', resolved_at = ?, action_id = 'decision-action', updated_at = ?
    WHERE id = 'decision-1' AND status = 'PENDING'`).run(now + 1, now + 1);
  db.prepare(`INSERT INTO finance_management_report_actions
    (id, report_id, source_section, title, owner_employee_id, due_date, status, memo, created_by,
      completed_at, decision_id, created_at, updated_at)
    VALUES ('decision-action', 'decision-report', 'CASH', '결정 실행 · 운영자금 기준 승인', 'gc.kim',
      '2026-08-31', 'OPEN', '제안한 기준으로 승인', 'gc.kim', NULL, 'decision-1', ?, ?)`)
    .run(now + 1, now + 1);
  assert.throws(() => db.prepare(`INSERT INTO finance_management_report_actions
    (id, report_id, source_section, title, owner_employee_id, due_date, status, memo, created_by,
      completed_at, decision_id, created_at, updated_at)
    VALUES ('duplicate-action', 'decision-report', 'CASH', '중복', 'gc.kim', '2026-08-31', 'OPEN', '',
      'gc.kim', NULL, 'decision-1', ?, ?)`).run(now + 2, now + 2), /UNIQUE constraint failed/);
  const decision = db.prepare("SELECT status, resolution_note, action_id FROM finance_management_decisions WHERE id = 'decision-1'").get();
  assert.deepEqual({ ...decision }, { status: "APPROVED", resolution_note: "제안한 기준으로 승인", action_id: "decision-action" });
  const decisionIndexes = db.prepare("PRAGMA index_list(finance_management_decisions)").all();
  assert.ok(decisionIndexes.some((row) => row.name === "idx_finance_management_decision_report_status"));
});

test("finance master data enforces unique codes, aliases and approval-tracked changes", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  const insertAccount = db.prepare(`INSERT INTO finance_master_accounts
    (id, code, name, category, normal_balance, status, source, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'ASSET', 'DEBIT', 'ACTIVE', 'ECOUNT_2025', 'gc.kim', ?, ?)`);
  insertAccount.run("account-1039", "1039", "보통예금", now, now);
  assert.throws(() => insertAccount.run("account-duplicate", "1039", "중복", now, now), /UNIQUE constraint failed/);

  db.prepare(`INSERT INTO finance_master_partners
    (id, canonical_name, normalized_key, partner_type, status, source, created_by, created_at, updated_at)
    VALUES ('partner-1', '주식회사 테스트', '주식회사테스트', 'BOTH', 'ACTIVE', 'ERP_LEGACY', 'gc.kim', ?, ?)`)
    .run(now, now);
  const insertAlias = db.prepare(`INSERT INTO finance_master_partner_aliases
    (id, mapping_key, source_system, source_entity_id, source_name, partner_id, created_at, updated_at)
    VALUES (?, 'SALES:account-1', 'SALES', 'account-1', '주식회사 테스트', 'partner-1', ?, ?)`);
  insertAlias.run("alias-1", now, now);
  assert.throws(() => insertAlias.run("alias-2", now, now), /UNIQUE constraint failed/);

  db.prepare(`INSERT INTO finance_master_change_requests
    (id, target_type, target_id, change_type, before_json, after_json, reason, status, created_by, created_at, updated_at)
    VALUES ('change-1', 'ACCOUNT', 'account-1039', 'DEACTIVATE', '{}', '{"status":"INACTIVE"}',
      '미사용 계정 비활성화', 'SUBMITTED', 'gc.kim', ?, ?)`)
    .run(now, now);
  const change = db.prepare("SELECT status, reason FROM finance_master_change_requests WHERE id = 'change-1'").get();
  assert.equal(change.status, "SUBMITTED");
  assert.equal(change.reason, "미사용 계정 비활성화");
  assert.ok(db.prepare("PRAGMA index_list(finance_master_accounts)").all().some((row) => row.name === "idx_finance_master_account_code"));
});

test("receivable collection cases stay unique per invoice while contact notes remain append-only", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  const insertCase = db.prepare(`INSERT INTO finance_receivable_cases
    (invoice_id, collection_status, owner_employee_id, promised_date, promised_amount,
      next_action, next_action_date, updated_by, created_at, updated_at)
    VALUES (?, 'PROMISED', 'gc.kim', '2026-08-20', 5000000, '입금증 확인', '2026-08-21', 'gc.kim', ?, ?)`);
  insertCase.run("invoice-1", now, now);
  assert.throws(() => insertCase.run("invoice-1", now, now), /UNIQUE constraint failed/);
  db.prepare(`UPDATE finance_receivable_cases SET collection_status = 'IN_PROGRESS',
    next_action = '담당자 재통화', updated_at = ? WHERE invoice_id = 'invoice-1'`).run(now + 1);
  const insertNote = db.prepare(`INSERT INTO finance_receivable_notes
    (id, invoice_id, note_type, content, created_by, created_at) VALUES (?, 'invoice-1', ?, ?, 'gc.kim', ?)`);
  insertNote.run("note-1", "CALL", "입금 예정일 확인", now);
  insertNote.run("note-2", "EMAIL", "입금증 요청", now + 1);
  const collectionCase = db.prepare("SELECT * FROM finance_receivable_cases WHERE invoice_id = 'invoice-1'").get();
  assert.equal(collectionCase.collection_status, "IN_PROGRESS");
  assert.equal(collectionCase.next_action, "담당자 재통화");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM finance_receivable_notes WHERE invoice_id = 'invoice-1'").get().count, 2);
  assert.ok(db.prepare("PRAGMA index_list(finance_receivable_cases)").all().some((row) => row.name === "idx_finance_receivable_case_status_promise"));
});

test("project cost centers preserve unique opportunity links, monthly budgets and bounded source splits", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertCenter = db.prepare(`INSERT INTO finance_cost_centers
    (id, code, name, center_type, owner_employee_id, opportunity_id, client_name, start_date, end_date,
      status, note, created_by, created_at, updated_at) VALUES (?, ?, ?, 'PROJECT', 'gc.kim', ?, '고객사',
      '2026-08-01', '', 'ACTIVE', '', 'gc.kim', ?, ?)`);
  insertCenter.run("center-1", "PRJ-001", "프로젝트 1", "opportunity-1", now, now);
  assert.throws(() => insertCenter.run("center-code", "PRJ-001", "중복 코드", "opportunity-2", now, now), /UNIQUE constraint failed/);
  assert.throws(() => insertCenter.run("center-opportunity", "PRJ-002", "중복 영업기회", "opportunity-1", now, now), /UNIQUE constraint failed/);

  const insertBudget = db.prepare(`INSERT INTO finance_project_monthly_budgets
    (id, cost_center_id, period, revenue_budget, cost_budget, note, approved_by, created_at, updated_at)
    VALUES (?, 'center-1', '2026-08', 10000000, 7000000, '승인 계획', 'gc.kim', ?, ?)`);
  insertBudget.run("budget-1", now, now);
  assert.throws(() => insertBudget.run("budget-2", now, now), /UNIQUE constraint failed/);

  db.prepare(`INSERT INTO finance_cost_centers
    (id, code, name, center_type, owner_employee_id, opportunity_id, client_name, start_date, end_date,
      status, note, created_by, created_at, updated_at) VALUES ('center-2', 'OVERHEAD', '공통비', 'OVERHEAD',
      'gc.kim', '', '', '2026-01-01', '', 'ACTIVE', '', 'gc.kim', ?, ?)`).run(now, now);
  const insertAllocation = db.prepare(`INSERT INTO finance_project_allocations
    (id, cost_center_id, source_type, source_id, period, direction, source_amount, amount,
      allocation_basis, note, created_by, created_at, updated_at)
    VALUES (?, ?, 'EXPENSE_REQUEST', 'expense-1', '2026-08', 'COST', 1000000, ?, 'MANUAL_AMOUNT', ?, 'gc.kim', ?, ?)`);
  insertAllocation.run("allocation-1", "center-1", 600000, "계약 과업 직접비", now, now);
  insertAllocation.run("allocation-2", "center-2", 400000, "전사 공통 운영비", now, now);
  assert.throws(() => insertAllocation.run("allocation-duplicate", "center-1", 1, "중복", now, now), /UNIQUE constraint failed/);
  const allocated = db.prepare("SELECT SUM(amount) AS amount FROM finance_project_allocations WHERE source_type = 'EXPENSE_REQUEST' AND source_id = 'expense-1'").get();
  assert.equal(allocated.amount, 1000000);
  assert.ok(db.prepare("PRAGMA index_list(finance_cost_centers)").all().some((row) => row.name === "idx_finance_cost_center_opportunity"));
});

test("corporate-card and evidence ledgers prevent duplicate source references and expense reuse", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertCard = db.prepare(`INSERT INTO finance_corporate_cards
    (id, issuer, nickname, last4, holder_employee_id, monthly_limit, status, created_by, created_at, updated_at)
    VALUES (?, '테스트카드', ?, '1234', 'gc.kim', 5000000, 'ACTIVE', 'gc.kim', ?, ?)`);
  insertCard.run("card-1", "업무카드", now, now);
  assert.throws(() => insertCard.run("card-2", "중복카드", now, now), /UNIQUE constraint failed/);

  const insertTransaction = db.prepare(`INSERT INTO finance_card_transactions
    (id, card_id, external_reference, transaction_date, merchant, amount, currency, direction, status,
      expense_request_id, exclusion_reason, source_file_name, created_by, created_at, updated_at)
    VALUES (?, 'card-1', ?, '2026-08-14', '테스트가맹점', 10000, 'KRW', 'CHARGE', ?, ?, '', '직접 등록', 'gc.kim', ?, ?)`);
  insertTransaction.run("card-tx-1", "approval-001", "MATCHED", "expense-1", now, now);
  assert.throws(() => insertTransaction.run("card-tx-duplicate-ref", "approval-001", "UNMATCHED", "", now, now), /UNIQUE constraint failed/);
  assert.throws(() => insertTransaction.run("card-tx-duplicate-expense", "approval-002", "MATCHED", "expense-1", now, now), /UNIQUE constraint failed/);

  const insertControl = db.prepare(`INSERT INTO finance_expense_controls
    (expense_request_id, business_purpose, evidence_status, evidence_document_id, card_transaction_id,
      tax_treatment, review_note, reviewed_by, reviewed_at, created_at, updated_at)
    VALUES (?, '업무용 소모품 구매', 'VERIFIED', 'document-1', ?, 'DEDUCTIBLE', '증빙 확인', 'gc.kim', ?, ?, ?)`);
  insertControl.run("expense-1", "card-tx-1", now, now, now);
  assert.throws(() => insertControl.run("expense-2", "card-tx-1", now, now, now), /UNIQUE constraint failed/);
  const control = db.prepare("SELECT * FROM finance_expense_controls WHERE expense_request_id = 'expense-1'").get();
  assert.equal(control.evidence_status, "VERIFIED"); assert.equal(control.tax_treatment, "DEDUCTIBLE");
  assert.ok(db.prepare("PRAGMA index_list(finance_card_transactions)").all().some((row) => row.name === "idx_finance_card_transaction_reference"));
});

test("debt ledgers keep Clobe sources, schedules, payment links and covenant reviews unique", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertFacility = db.prepare(`INSERT INTO finance_debt_facilities
    (id, facility_code, source_account_id, lender_name, facility_name, currency, original_principal,
      agreement_date, maturity_date, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, '테스트은행', '운전자금 대출', 'KRW', 900000000, '2026-01-01', '2027-01-01',
      'ACTIVE', 'gc.kim', ?, ?)`);
  insertFacility.run("facility-1", "LOAN-001", 162651, now, now);
  assert.throws(() => insertFacility.run("facility-code", "LOAN-001", 162650, now, now), /UNIQUE constraint failed/);
  assert.throws(() => insertFacility.run("facility-source", "LOAN-002", 162651, now, now), /UNIQUE constraint failed/);

  const insertSchedule = db.prepare(`INSERT INTO finance_debt_schedule_items
    (id, facility_id, due_date, item_type, amount, status, payment_request_id, note, created_by, created_at, updated_at)
    VALUES (?, 'facility-1', '2026-09-30', 'PRINCIPAL', 100000000, 'PLANNED', ?, '', 'gc.kim', ?, ?)`);
  insertSchedule.run("schedule-1", "expense-debt-1", now, now);
  assert.throws(() => insertSchedule.run("schedule-duplicate-date", "expense-debt-2", now, now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO finance_debt_schedule_items
    (id, facility_id, due_date, item_type, amount, status, payment_request_id, note, created_by, created_at, updated_at)
    VALUES ('schedule-2', 'facility-1', '2026-10-31', 'PRINCIPAL', 100000000, 'PLANNED', '', '', 'gc.kim', ?, ?)`).run(now, now);
  assert.throws(() => db.prepare(`UPDATE finance_debt_schedule_items SET payment_request_id = 'expense-debt-1' WHERE id = 'schedule-2'`).run(), /UNIQUE constraint failed/);

  const insertReview = db.prepare(`INSERT INTO finance_debt_covenant_reviews
    (id, facility_id, review_date, covenant_name, comparator, threshold_value_scaled, actual_value_scaled, unit,
      result, evidence_document_id, note, reviewed_by, created_at, updated_at)
    VALUES (?, 'facility-1', '2026-09-30', '부채비율', 'LTE', 2000000, 1500000, '%', 'PASS',
      'document-1', '검토 완료', 'gc.kim', ?, ?)`);
  insertReview.run("review-1", now, now);
  assert.throws(() => insertReview.run("review-duplicate", now, now), /UNIQUE constraint failed/);
});

test("incentive governance keeps rule versions, triple checks, source results and payroll links unique", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertRule = db.prepare(`INSERT INTO sales_incentive_rules
    (id, name, version, effective_from, effective_to, rules_json, status, approved_by, approved_at, created_at, updated_at)
    VALUES (?, '영업 인센티브', 1, '2026-01-01', '', '{}', 'DRAFT', '', NULL, ?, ?)`);
  insertRule.run("rule-1", now, now);
  assert.throws(() => insertRule.run("rule-duplicate", now, now), /UNIQUE constraint failed/);
  const insertValidation = db.prepare(`INSERT INTO sales_incentive_validations
    (id, rule_id, validation_type, result, evidence_document_id, note, reviewed_by, created_at, updated_at)
    VALUES (?, 'rule-1', 'POLICY', 'PASS', 'document-1', '규정 원문 대조 완료', 'gc.kim', ?, ?)`);
  insertValidation.run("validation-1", now, now);
  assert.throws(() => insertValidation.run("validation-duplicate", now, now), /UNIQUE constraint failed/);
  const insertResult = db.prepare(`INSERT INTO sales_incentive_results
    (id, period, employee_id, opportunity_id, rule_id, rule_version, recognized_revenue, recognized_cost,
      payout_amount, calculation_json, status, payroll_ref, created_at, updated_at)
    VALUES (?, '2026-08', 'gc.kim', 'opportunity-1', 'rule-1', 1, 100000000, 90000000, 250000, '{}', 'APPROVED', '', ?, ?)`);
  insertResult.run("result-1", now, now);
  assert.throws(() => insertResult.run("result-duplicate", now, now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO sales_incentive_results
    (id, period, employee_id, opportunity_id, rule_id, rule_version, recognized_revenue, recognized_cost,
      payout_amount, calculation_json, status, payroll_ref, created_at, updated_at)
    VALUES ('result-prior-review', '2026-07', 'gc.kim', 'opportunity-1', 'rule-1', 1, 80000000, 70000000,
      200000, '{}', 'FINANCE_REVIEWED', '', ?, ?)`).run(now, now);
  const prior = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status IN ('APPROVED','PAYROLL_APPLIED') THEN payout_amount ELSE 0 END), 0) AS committed,
    COALESCE(SUM(CASE WHEN status IN ('DRAFT','SALES_CONFIRMED','FINANCE_REVIEWED','SUBMITTED') THEN 1 ELSE 0 END), 0) AS unresolved
    FROM sales_incentive_results WHERE opportunity_id = 'opportunity-1' AND rule_id = 'rule-1' AND period < '2026-09'`).get();
  assert.equal(prior.committed, 250000);
  assert.equal(prior.unresolved, 1);
  assert.equal(Math.max(0, 400000 - prior.committed), 150000);
  assert.equal(Math.min(0, 100000 - prior.committed), -150000);
  db.prepare("UPDATE sales_incentive_results SET status = 'VOID' WHERE id = 'result-prior-review'").run();
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM sales_incentive_results
    WHERE opportunity_id = 'opportunity-1' AND period < '2026-09'
      AND status IN ('DRAFT','SALES_CONFIRMED','FINANCE_REVIEWED','SUBMITTED')`).get().count, 0);
  const insertLink = db.prepare(`INSERT INTO sales_incentive_payroll_links
    (id, result_id, payroll_period, payroll_record_id, applied_amount, applied_by, applied_at)
    VALUES (?, 'result-1', '2026-08', 'payroll-1', 250000, 'gc.kim', ?)`);
  insertLink.run("link-1", now);
  assert.throws(() => insertLink.run("link-duplicate", now), /UNIQUE constraint failed/);
});

test("incentive cumulative settlement and month-close queries compile against the production schema", async () => {
  const db = await migratedDatabase();
  const incentiveRoute = await readFile(new URL("../app/api/sales/incentives/route.ts", import.meta.url), "utf8");
  const sourceQuery = incentiveRoute.match(/const sources = await db\.prepare\(`([\s\S]*?)`\)\s*\.bind\(/)?.[1];
  const reviewQuery = incentiveRoute.match(/const currentSource = await db\.prepare\(`([\s\S]*?)`\)\.bind\(/)?.[1];
  assert.ok(sourceQuery); assert.ok(reviewQuery);
  assert.doesNotThrow(() => db.prepare(sourceQuery).all(
    "2026-08-01", "2026-09-01", "2026-01-01", "2026-09-01", "2026-01", "2026-08", "2026-01", "2026-08",
    "2026-08", "2026-01", "2026-08", "rule-1", "2026-08", "rule-1", "2026-08",
  ));
  assert.doesNotThrow(() => db.prepare(reviewQuery).get("2026-09-01", "2026-08", "2026-08", "2026-08", "rule-1", "opportunity-1"));

  const closeRoute = await readFile(new URL("../app/api/finance/close/route.ts", import.meta.url), "utf8");
  const closeQuery = closeRoute.match(/db\.prepare\(`(WITH eligible_sources AS \([\s\S]*?clawback_count)`\)/)?.[1];
  assert.ok(closeQuery);
  assert.doesNotThrow(() => db.prepare(closeQuery).get(
    "2026-09-01", "2026-08-01", "2026-08-01", "2026-08-01", "2026-09-01",
    "2026-08", "2026-08", "2026-08", "2026-08", "2026-08",
  ));
});

test("financial alert cases stay unique per task source and preserve append-only events", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  const insertCase = db.prepare(`INSERT INTO finance_alert_cases
    (id, task_id, task_source_id, source_destination, title_snapshot, description_snapshot,
      priority_snapshot, owner_employee_id, due_date, status, created_at, updated_at)
    VALUES (?, 'finance-risk-alert', 'snapshot-2026-08-14', 'finance:liquidity', '유동성 경보',
      '정책 기준 확인 필요', 'HIGH', 'gc.kim', '2026-08-15', 'OPEN', ?, ?)`);
  insertCase.run("alert-case-1", now, now);
  assert.throws(() => insertCase.run("alert-case-duplicate", now, now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO finance_alert_case_events
    (id, case_id, action, actor_employee_id, comment, snapshot_json, created_at)
    VALUES (?, 'alert-case-1', ?, 'gc.kim', ?, ?, ?)`)
    .run("alert-event-1", "ACTION_SAVED", "담당자 지정", '{"from":"OPEN","to":"IN_PROGRESS"}', now);
  db.prepare(`INSERT INTO finance_alert_case_events
    (id, case_id, action, actor_employee_id, comment, snapshot_json, created_at)
    VALUES (?, 'alert-case-1', ?, 'gc.kim', ?, ?, ?)`)
    .run("alert-event-2", "REVIEW_REQUESTED", "근거 첨부 완료", '{"from":"IN_PROGRESS","to":"REVIEW"}', now + 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM finance_alert_case_events WHERE case_id = 'alert-case-1'").get().count, 2);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM finance_alert_cases WHERE status = 'OPEN' ORDER BY due_date").all();
  assert.ok(plan.some((row) => String(row.detail).includes("idx_finance_alert_case_status_due")));
});

test("workbench preferences stay unique per employee and source item", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO erp_workbench_preferences
    (id, employee_id, item_type, item_id, pinned, snoozed_until, note, created_at, updated_at)
    VALUES (?, ?, 'TASK', 'task-1', ?, ?, ?, ?, ?)`);
  insert.run("gc.kim:TASK:task-1", "gc.kim", 1, "2026-08-16", "내 업무", now, now);
  assert.throws(() => insert.run("duplicate", "gc.kim", 0, "", "중복", now, now), /UNIQUE constraint failed/);
  insert.run("other:TASK:task-1", "other", 0, "", "다른 사용자", now, now);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM erp_workbench_preferences WHERE item_id = 'task-1'").get().count, 2);
  db.prepare(`INSERT INTO erp_workbench_preferences
    (id, employee_id, item_type, item_id, pinned, snoozed_until, note, created_at, updated_at)
    VALUES ('ignored', 'gc.kim', 'TASK', 'task-1', 0, '', '갱신', ?, ?)
    ON CONFLICT(employee_id, item_type, item_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`)
    .run(now, now + 1);
  const owner = db.prepare("SELECT pinned, snoozed_until, note FROM erp_workbench_preferences WHERE employee_id = 'gc.kim'").get();
  assert.deepEqual({ ...owner }, { pinned: 1, snoozed_until: "2026-08-16", note: "갱신" });
  const indexes = db.prepare("PRAGMA index_list(erp_workbench_preferences)").all();
  assert.ok(indexes.some((row) => row.name === "idx_erp_workbench_preference_item" && row.unique === 1));
});

test("workforce plans preserve period versions and one organization line per plan", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  const insertPlan = db.prepare(`INSERT INTO hr_workforce_plans
    (id, period, version, title, assumptions, status, revision_reason, created_by, submitted_at,
      approved_by, approved_at, created_at, updated_at)
    VALUES (?, '2026-H2', 1, '하반기 계획', '매출 목표와 생산성 기준', 'DRAFT', '', 'gc.kim', NULL, '', NULL, ?, ?)`);
  insertPlan.run("workforce-1", now, now);
  assert.throws(() => insertPlan.run("workforce-duplicate", now, now), /UNIQUE constraint failed/);
  const insertLine = db.prepare(`INSERT INTO hr_workforce_plan_lines
    (id, plan_id, organization_id, approved_headcount, planned_exits, note, created_at, updated_at)
    VALUES (?, 'workforce-1', 'org-ai-business', 12, 1, '사업계획 기준', ?, ?)`);
  insertLine.run("workforce-line-1", now, now);
  assert.throws(() => insertLine.run("workforce-line-duplicate", now, now), /UNIQUE constraint failed/);
  db.prepare("UPDATE hr_workforce_plans SET status = 'SUBMITTED', submitted_at = ? WHERE id = 'workforce-1'").run(now);
  assert.equal(db.prepare("SELECT status FROM hr_workforce_plans WHERE id = 'workforce-1'").get().status, "SUBMITTED");
});

test("recruitment requisitions preserve approved-plan lineage and applicant linkage", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO hr_recruitment_requisitions
    (id, workforce_plan_id, workforce_plan_line_id, organization_id, title, role, requested_headcount,
      owner_employee_id, target_start_date, reason, status, requested_by, approved_by, approved_at,
      closed_by, closed_at, close_reason, created_at, updated_at)
    VALUES ('req-1', 'plan-1', 'line-1', 'org-ai-business', 'AI 연구원 충원', '연구개발', 2,
      'gc.kim', '2026-10-01', '승인 정원 부족 충원', 'OPEN', 'gc.kim', 'ceo', ?, '', NULL, '', ?, ?)`)
    .run(now, now, now);
  db.prepare(`INSERT INTO hr_applicants
    (id, name, role, applied, owner_id, stage, experience, email, phone, source, summary,
      resume_file_name, resume_text, checklist_json, screening_memos_json, interview_json,
      interview_memos_json, requisition_id, updated_at)
    VALUES ('applicant-linked', '홍길동', '연구개발', '2026.08.14', 'gc.kim', '서류 검토', '',
      'hong@example.com', '', '직접 등록', '', '', '', '[]', '[]', NULL, '[]', 'req-1', ?)`)
    .run(now);
  const linked = db.prepare(`SELECT r.status, r.requested_headcount, a.requisition_id
    FROM hr_recruitment_requisitions r JOIN hr_applicants a ON a.requisition_id = r.id WHERE r.id = 'req-1'`).get();
  assert.deepEqual({ ...linked }, { status: "OPEN", requested_headcount: 2, requisition_id: "req-1" });
  const indexes = db.prepare("PRAGMA index_list(hr_applicants)").all();
  assert.ok(indexes.some((row) => row.name === "idx_hr_applicants_requisition"));
});

test("performance ledgers preserve cycle participants and one review per stage", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertCycle = db.prepare(`INSERT INTO hr_performance_cycles
    (id, name, period, description, status, goal_due_date, self_due_date, manager_due_date,
      calibration_due_date, created_by, opened_at, finalized_by, finalized_at, created_at, updated_at)
    VALUES (?, '하반기 평가', '2026-H2', '', 'GOAL_SETTING', '2026-09-15', '2026-12-10',
      '2026-12-20', '2026-12-27', 'gc.kim', ?, '', NULL, ?, ?)`);
  insertCycle.run("cycle-1", now, now, now);
  assert.throws(() => insertCycle.run("cycle-duplicate", now, now, now), /UNIQUE constraint failed/);
  const insertParticipant = db.prepare(`INSERT INTO hr_performance_participants
    (id, cycle_id, employee_id, organization_id, manager_employee_id, status, final_score,
      final_rating, calibration_note, finalized_by, finalized_at, created_at, updated_at)
    VALUES (?, 'cycle-1', 'employee-1', 'org-1', 'manager-1', 'GOALS_SUBMITTED', NULL, '', '', '', NULL, ?, ?)`);
  insertParticipant.run("participant-1", now, now);
  assert.throws(() => insertParticipant.run("participant-duplicate", now, now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO hr_performance_goals
    (id, participant_id, title, description, weight, metric_type, target_value, actual_value, unit,
      evidence, employee_comment, manager_comment, status, created_by, created_at, updated_at)
    VALUES ('goal-1', 'participant-1', '매출 목표', '목표 설명', 100, 'NUMBER', 100, NULL, '건', '', '', '', 'LOCKED', 'employee-1', ?, ?)`).run(now, now);
  const insertReview = db.prepare(`INSERT INTO hr_performance_reviews
    (id, participant_id, reviewer_type, reviewer_employee_id, score, rating, strengths, improvements,
      comment, status, submitted_at, created_at, updated_at)
    VALUES (?, 'participant-1', 'SELF', 'employee-1', 80, 'B', '강점 기록', '개선 기록', '종합 의견', 'SUBMITTED', ?, ?, ?)`);
  insertReview.run("review-self", now, now, now);
  assert.throws(() => insertReview.run("review-self-duplicate", now, now, now), /UNIQUE constraint failed/);
  const participantIndexes = db.prepare("PRAGMA index_list(hr_performance_participants)").all();
  const reviewIndexes = db.prepare("PRAGMA index_list(hr_performance_reviews)").all();
  assert.ok(participantIndexes.some((row) => row.name === "idx_hr_performance_participant_cycle_employee" && row.unique === 1));
  assert.ok(reviewIndexes.some((row) => row.name === "idx_hr_performance_review_participant_type" && row.unique === 1));
});

test("training ledgers preserve one employee assignment per course", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO hr_training_courses
    (id, title, course_type, year, description, provider, delivery_mode, start_date, due_date,
      duration_minutes, audience_type, organization_id, status, created_by, created_at, updated_at)
    VALUES (?, ?, 'MANDATORY', 2026, '', '교육기관', 'ONLINE', '2026-08-14', '2026-08-31', 60, 'ALL', '', 'OPEN', 'admin', ?, ?)`)
    .run("course-1", "개인정보보호 교육", now, now);
  const insert = db.prepare(`INSERT INTO hr_training_assignments
    (id, course_id, employee_id, employee_name, department, status, progress, completed_minutes, created_at, updated_at)
    VALUES (?, 'course-1', 'employee-1', '홍길동', '경영지원팀', 'ASSIGNED', 0, 0, ?, ?)`);
  insert.run("assignment-1", now, now);
  assert.throws(() => insert.run("assignment-2", now, now), /UNIQUE constraint failed/);
  db.close();
});

test("master impact report reviews and executive approvals remain unique and append-only", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  db.prepare(`INSERT INTO erp_master_impact_weekly_reports
    (id,week_start,week_end,version,active_count,overdue_count,manager_escalated_count,executive_escalated_count,
      snapshot_json,checksum,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("report-review-1","2026-08-10","2026-08-16",1,2,1,1,0,'{"managers":[]}',"checksum-review-1","gc.kim",now);
  const insertReview = db.prepare(`INSERT INTO erp_master_impact_weekly_report_reviews
    (id,report_id,manager_name,manager_employee_id,outcome,note,reviewed_by,reviewed_at,
      follow_up_owner_employee_id,follow_up_due_date,follow_up_task_id,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertReview.run("review-1","report-review-1","김조직","manager-1","PENDING","","",null,"","","",1,now,now);
  assert.throws(() => insertReview.run("review-duplicate","report-review-1","김조직","manager-1","PENDING","","",null,"","","",1,now,now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO erp_master_impact_weekly_report_events
    (id,report_id,action,actor_employee_id,note,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run("report-event-1","report-review-1","MANAGER_ACKNOWLEDGED","gc.kim","확인 기록","{}",now);
  db.prepare(`INSERT INTO erp_master_impact_weekly_report_events
    (id,report_id,action,actor_employee_id,note,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run("report-event-2","report-review-1","SUBMITTED","gc.kim","전자결재 제출","{}",now+1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM erp_master_impact_weekly_report_events WHERE report_id=?").get("report-review-1").count,2);
  assert.throws(() => db.prepare("UPDATE erp_master_impact_weekly_reports SET checksum=? WHERE id=?").run("tampered", "report-review-1"), /immutable/);
  assert.throws(() => db.prepare("UPDATE erp_master_impact_weekly_reports SET snapshot_json=? WHERE id=?").run("{}", "report-review-1"), /immutable/);
  const insertApproval = db.prepare(`INSERT INTO erp_approval_requests
    (id,module,request_type,title,requester_employee_id,target_entity_type,target_entity_id,submitted_at,created_at,updated_at)
    VALUES (?,'settings','MASTER_IMPACT_REPORT','주간보고','gc.kim','MASTER_IMPACT_WEEKLY_REPORT','report-review-1',?,?,?)`);
  insertApproval.run("approval-report-1",now,now,now);
  assert.throws(() => insertApproval.run("approval-report-duplicate",now+1,now+1,now+1), /UNIQUE constraint failed/);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM erp_master_impact_weekly_report_reviews WHERE report_id=? AND outcome=?").all("report-review-1","PENDING");
  assert.ok(plan.some((row) => String(row.detail).includes("idx_erp_master_impact_weekly_review_outcome")));
  db.close();
});

test("HR analytics reports preserve immutable period versions", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insert = db.prepare(`INSERT INTO hr_analytics_reports
    (id, report_type, title, period_start, period_end, version, snapshot_json, generated_by, created_at)
    VALUES (?, 'HR_OVERVIEW', '2026년 HR 리포트', '2026-01-01', '2026-08-14', 1, '{}', 'gc.kim', ?)`);
  insert.run("report-1", now);
  assert.throws(() => insert.run("report-duplicate", now), /UNIQUE constraint failed/);
  const indexes = db.prepare("PRAGMA index_list(hr_analytics_reports)").all();
  assert.ok(indexes.some((row) => row.name === "idx_hr_analytics_report_period_version" && row.unique === 1));
  db.close();
});

test("sales CRM keeps contacts unique and activities and stage changes append-only", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertContact = db.prepare(`INSERT INTO sales_account_contacts
    (id, account_id, contact_key, name, title, email, phone, is_primary, status, created_by, created_at, updated_at)
    VALUES (?, 'account-1', 'email:customer@example.com', '홍길동', '과장', 'customer@example.com', '', 1, 'ACTIVE', 'gc.kim', ?, ?)`);
  insertContact.run("contact-1", now, now);
  assert.throws(() => insertContact.run("contact-duplicate", now, now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO sales_opportunity_activities
    (id, opportunity_id, contact_id, activity_type, occurred_at, summary, next_action, next_action_date, created_by, created_at)
    VALUES ('activity-1', 'opportunity-1', 'contact-1', 'MEETING', '2026-08-14T10:00', '요구사항 확인 회의', '제안서 발송', '2026-08-17', 'gc.kim', ?)`)
    .run(now);
  db.prepare(`INSERT INTO sales_opportunity_stage_history
    (id, opportunity_id, from_stage, to_stage, reason, changed_by, changed_at)
    VALUES ('history-1', 'opportunity-1', 'LEAD', 'DISCOVERY', '고객 요구사항 확인 완료', 'gc.kim', ?)`)
    .run(now);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sales_opportunity_activities WHERE opportunity_id = 'opportunity-1'").get().count, 1);
  const indexes = db.prepare("PRAGMA index_list(sales_account_contacts)").all();
  assert.ok(indexes.some((row) => row.name === "idx_sales_contact_account_key" && row.unique === 1));
  db.close();
});

test("sales catalog and document lines preserve codes, line numbers and source lineage", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertCatalog = db.prepare(`INSERT INTO sales_catalog_items
    (id, code, name, item_type, unit, default_unit_price, status, created_by, created_at, updated_at)
    VALUES (?, 'SVC-AI-001', 'AI 분석 서비스', 'SERVICE', 'MONTH', 1000000, 'ACTIVE', 'gc.kim', ?, ?)`);
  insertCatalog.run("catalog-1", now, now);
  assert.throws(() => insertCatalog.run("catalog-duplicate", now, now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO sales_documents
    (id, opportunity_id, document_type, document_number, version, amount, status, issued_date, due_date, source_document_id, created_at, updated_at)
    VALUES ('order-1', 'opportunity-1', 'ORDER', 'ORD-001', 1, 10000000, 'ACCEPTED', '2026-08-14', '2026-08-31', '', ?, ?)`)
    .run(now, now);
  const insertLine = db.prepare(`INSERT INTO sales_document_lines
    (id, document_id, line_number, catalog_item_id, description, quantity, unit, unit_price, amount, source_line_id, created_at)
    VALUES (?, 'order-1', 1, 'catalog-1', 'AI 분석 서비스', 10, 'MONTH', 1000000, 10000000, '', ?)`);
  insertLine.run("order-line-1", now);
  assert.throws(() => insertLine.run("order-line-duplicate", now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO sales_documents
    (id, opportunity_id, document_type, document_number, version, amount, status, issued_date, due_date, source_document_id, created_at, updated_at)
    VALUES ('delivery-1', 'opportunity-1', 'DELIVERY', 'DEL-001', 1, 8000000, 'DRAFT', '2026-08-15', '', 'order-1', ?, ?)`)
    .run(now, now);
  db.prepare(`INSERT INTO sales_document_lines
    (id, document_id, line_number, catalog_item_id, description, quantity, unit, unit_price, amount, source_line_id, created_at)
    VALUES ('delivery-line-1', 'delivery-1', 1, 'catalog-1', 'AI 분석 서비스', 8, 'MONTH', 1000000, 8000000, 'order-line-1', ?)`)
    .run(now);
  const remaining = db.prepare(`SELECT source.quantity - COALESCE(SUM(child.quantity), 0) AS quantity
    FROM sales_document_lines source LEFT JOIN sales_document_lines child ON child.source_line_id = source.id
    LEFT JOIN sales_documents document ON document.id = child.document_id AND document.status <> 'CANCELLED'
    WHERE source.id = 'order-line-1' GROUP BY source.id`).get().quantity;
  assert.equal(remaining, 2);
  const overAllocation = db.prepare(`INSERT INTO sales_documents
    (id, opportunity_id, document_type, document_number, version, amount, status, issued_date, due_date, source_document_id, created_at, updated_at)
    SELECT 'delivery-over', 'opportunity-1', 'DELIVERY', 'DEL-OVER', 1, 3000000, 'DRAFT', '2026-08-16', '', 'order-1', ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM json_each(?) request JOIN sales_document_lines source_line
      ON source_line.id = json_extract(request.value, '$.sourceLineId')
      WHERE CAST(json_extract(request.value, '$.quantity') AS REAL) > source_line.quantity - COALESCE((
        SELECT SUM(child_line.quantity) FROM sales_document_lines child_line JOIN sales_documents child ON child.id = child_line.document_id
        WHERE child_line.source_line_id = source_line.id AND child.document_type = 'DELIVERY' AND child.status <> 'CANCELLED'), 0))`)
    .run(now, now, JSON.stringify([{ sourceLineId: "order-line-1", quantity: 3 }]));
  assert.equal(overAllocation.changes, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sales_documents WHERE id = 'delivery-over'").get().count, 0);
  const lineIndexes = db.prepare("PRAGMA index_list(sales_document_lines)").all();
  assert.ok(lineIndexes.some((row) => row.name === "idx_sales_document_line_number" && row.unique === 1));
  const sourcePlan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM sales_document_lines WHERE source_line_id = 'order-line-1'").all();
  assert.ok(sourcePlan.some((row) => String(row.detail).includes("idx_sales_document_line_source")));
  db.close();
});

test("sales target plans keep one approved version and immutable forecast versions", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertPlan = db.prepare(`INSERT INTO sales_target_plans
    (id, year, version, name, status, created_by, approved_by, approved_at, created_at, updated_at)
    VALUES (?, 2027, ?, ?, ?, 'gc.kim', '', NULL, ?, ?)`);
  insertPlan.run("plan-1", 1, "2027 영업계획 v1", "APPROVED", now, now);
  assert.throws(() => insertPlan.run("plan-1-duplicate", 1, "중복 버전", "DRAFT", now, now), /UNIQUE constraint failed/);
  assert.throws(() => insertPlan.run("plan-2-approved", 2, "동시 승인", "APPROVED", now, now), /UNIQUE constraint failed/);
  insertPlan.run("plan-2", 2, "2027 영업계획 v2", "DRAFT", now, now);
  const insertLine = db.prepare(`INSERT INTO sales_target_lines
    (id, plan_id, scope_type, scope_key, scope_name, period, target_revenue, target_gross_profit, target_orders, created_at, updated_at)
    VALUES (?, 'plan-2', 'COMPANY', 'company', '회사 전체', '2027-01', 100000000, 30000000, 3, ?, ?)`);
  insertLine.run("target-line-1", now, now);
  assert.throws(() => insertLine.run("target-line-duplicate", now, now), /UNIQUE constraint failed/);
  const insertSnapshot = db.prepare(`INSERT INTO sales_forecast_snapshots
    (id, plan_id, as_of_date, version, formula_version, snapshot_json, created_by, created_at)
    VALUES (?, 'plan-1', '2027-01-31', 1, 'SALES_FORECAST_V1', '{}', 'gc.kim', ?)`);
  insertSnapshot.run("snapshot-1", now);
  assert.throws(() => insertSnapshot.run("snapshot-duplicate", now), /UNIQUE constraint failed/);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM sales_target_lines WHERE plan_id = 'plan-2' AND period = '2027-01'").all();
  assert.ok(plan.some((row) => String(row.detail).includes("idx_sales_target_line_plan_period")));
  db.close();
});

test("sales account governance enforces identity, one primary contact and ownership history", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertAccount = db.prepare(`INSERT INTO sales_accounts
    (id, name, business_number, industry, owner_employee_id, status, memo, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, '', 'owner-1', 'ACTIVE', '', ?, ?, NULL)`);
  insertAccount.run("account-governance-1", "엑스디 고객", "123-45-67890", now, now);
  insertAccount.run("account-governance-2", "병합 대상", "", now, now);
  const insertIdentity = db.prepare(`INSERT INTO sales_account_identity_keys
    (identity_key, account_id, is_primary, origin_account_id, created_at) VALUES (?, ?, 1, ?, ?)`);
  insertIdentity.run("business:1234567890", "account-governance-1", "account-governance-1", now);
  assert.throws(() => insertIdentity.run("business:1234567890", "account-governance-2", "account-governance-2", now), /UNIQUE constraint failed/);
  assert.throws(() => insertIdentity.run("name:다른키", "account-governance-1", "account-governance-1", now), /UNIQUE constraint failed/);

  const insertContact = db.prepare(`INSERT INTO sales_account_contacts
    (id, account_id, contact_key, name, title, email, phone, is_primary, status, created_by, created_at, updated_at)
    VALUES (?, 'account-governance-1', ?, ?, '', ?, '', 1, 'ACTIVE', 'gc.kim', ?, ?)`);
  insertContact.run("governance-contact-1", "email:first@example.com", "첫 담당자", "first@example.com", now, now);
  assert.throws(() => insertContact.run("governance-contact-2", "email:second@example.com", "둘째 담당자", "second@example.com", now, now), /UNIQUE constraint failed/);
  db.prepare("UPDATE sales_account_contacts SET is_primary = 0 WHERE id = 'governance-contact-1'").run();
  insertContact.run("governance-contact-2", "email:second@example.com", "둘째 담당자", "second@example.com", now, now);

  db.prepare(`INSERT INTO sales_account_owner_history
    (id, account_id, from_owner_employee_id, to_owner_employee_id, reason, changed_by, changed_at)
    VALUES ('owner-history-1', 'account-governance-1', 'owner-1', 'owner-2', '고객군 담당 조직 변경에 따른 이관', 'gc.kim', ?)`)
    .run(now);
  assert.equal(db.prepare("SELECT reason FROM sales_account_owner_history WHERE account_id = 'account-governance-1'").get().reason, "고객군 담당 조직 변경에 따른 이관");
  db.prepare(`INSERT INTO sales_opportunities
    (id, account_id, title, owner_employee_id, stage, lead_type, expected_revenue, expected_cost, probability,
      expected_close_date, next_action, next_action_date, status, created_at, updated_at, deleted_at)
    VALUES ('governance-opportunity', 'account-governance-1', '고객 360 검증', 'owner-1', 'CONTRACT', 'OUTBOUND',
      10000, 5000, 80, '2026-09-01', '계약 확인', '2026-08-20', 'OPEN', ?, ?, NULL)`).run(now, now);
  db.prepare(`INSERT INTO sales_documents
    (id, opportunity_id, document_type, document_number, version, amount, status, issued_date, due_date, source_document_id, created_at, updated_at)
    VALUES ('governance-invoice', 'governance-opportunity', 'INVOICE', 'INV-360', 1, 10000, 'ACCEPTED', '2026-08-15', '2026-08-31', '', ?, ?),
      ('governance-payment', 'governance-opportunity', 'PAYMENT', 'PAY-360', 1, 4000, 'COMPLETED', '2026-08-16', '', '', ?, ?)`).run(now, now, now, now);
  db.prepare(`INSERT INTO sales_payment_allocations
    (id, payment_document_id, invoice_document_id, amount, created_by, created_at, updated_at)
    VALUES ('governance-allocation', 'governance-payment', 'governance-invoice', 4000, 'gc.kim', ?, ?)`).run(now, now);
  const outstanding = db.prepare(`SELECT COALESCE(SUM(MAX(0, invoice.amount - COALESCE((
    SELECT SUM(allocation.amount) FROM sales_payment_allocations allocation
    JOIN sales_documents payment ON payment.id = allocation.payment_document_id
    WHERE allocation.invoice_document_id = invoice.id AND payment.status IN ('ACCEPTED','COMPLETED')), 0))), 0) AS amount
    FROM sales_documents invoice JOIN sales_opportunities opportunity ON opportunity.id = invoice.opportunity_id
    WHERE opportunity.account_id = 'account-governance-1' AND invoice.document_type = 'INVOICE'
      AND invoice.status IN ('ACCEPTED','COMPLETED')`).get().amount;
  assert.equal(outstanding, 6000);
  const identityPlan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM sales_account_identity_keys WHERE account_id = 'account-governance-1'").all();
  assert.ok(identityPlan.some((row) => String(row.detail).includes("idx_sales_account_identity_account")));
  db.close();
});

test("customer 360 implementation includes guarded merge, reassignment and operating alerts", async () => {
  const api = await readFile(new URL("../app/api/sales/accounts/route.ts", import.meta.url), "utf8");
  const ui = await readFile(new URL("../app/sales-account-360-view.tsx", import.meta.url), "utf8");
  const operations = await readFile(new URL("../app/api/operations/route.ts", import.meta.url), "utf8");
  assert.match(api, /REASSIGN_OWNER/);
  assert.match(api, /MERGE_ACCOUNT/);
  assert.match(api, /진행 중 영업기회 또는 미수금이 있는 거래처는 비활성화할 수 없습니다/);
  assert.match(api, /status NOT IN \('퇴직','입사 예정'\)/);
  assert.match(ui, /<h2>\{data\.account\.name\}<\/h2>/);
  assert.match(ui, /재무 거래처 마스터는 자동 병합하지 않습니다/);
  assert.match(operations, /sales-account-governance-risk/);
  assert.match(operations, /30일 이상 미접촉 진행 건/);
});

test("sales pricing ledgers keep one active master version and one review snapshot per document", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertList = db.prepare(`INSERT INTO sales_price_lists
    (id, name, version, currency, effective_from, effective_to, status, created_by, approved_by, approved_at, created_at, updated_at)
    VALUES (?, '국내 표준 가격표', ?, 'KRW', '2026-01-01', '', ?, 'gc.kim', '', NULL, ?, ?)`);
  insertList.run("price-list-1", 1, "ACTIVE", now, now);
  assert.throws(() => insertList.run("price-list-2-active", 2, "ACTIVE", now, now), /UNIQUE constraint failed/);
  insertList.run("price-list-2", 2, "DRAFT", now, now);
  assert.throws(() => insertList.run("price-list-2-duplicate", 2, "DRAFT", now, now), /UNIQUE constraint failed/);

  db.prepare(`INSERT INTO sales_catalog_items
    (id, code, name, item_type, unit, default_unit_price, status, created_by, created_at, updated_at)
    VALUES ('pricing-catalog-1', 'SVC-PRICE', '가격검증 서비스', 'SERVICE', 'EA', 100000, 'ACTIVE', 'gc.kim', ?, ?)`).run(now, now);
  const insertItem = db.prepare(`INSERT INTO sales_price_list_items
    (id, price_list_id, catalog_item_id, list_unit_price, standard_unit_cost, min_unit_price, created_at, updated_at)
    VALUES (?, 'price-list-1', 'pricing-catalog-1', 100000, 60000, 80000, ?, ?)`);
  insertItem.run("price-item-1", now, now);
  assert.throws(() => insertItem.run("price-item-duplicate", now, now), /UNIQUE constraint failed/);

  const insertPolicy = db.prepare(`INSERT INTO sales_pricing_policies
    (id, name, version, max_discount_bps, min_gross_margin_bps, status, created_by, approved_by, approved_at, created_at, updated_at)
    VALUES (?, '국내 가격정책', ?, 1000, 2000, ?, 'gc.kim', '', NULL, ?, ?)`);
  insertPolicy.run("pricing-policy-1", 1, "ACTIVE", now, now);
  assert.throws(() => insertPolicy.run("pricing-policy-2-active", 2, "ACTIVE", now, now), /UNIQUE constraint failed/);

  const insertReview = db.prepare(`INSERT INTO sales_document_pricing_reviews
    (document_id, document_type, price_list_id, policy_id, price_list_version, policy_version, list_amount, quoted_amount,
      standard_cost_amount, minimum_amount, discount_bps, gross_margin_bps, outcome, reasons_json, evaluated_by,
      approval_request_id, reviewed_by, reviewed_at, snapshot_json, created_at, updated_at)
    VALUES ('pricing-document-1', 'QUOTE', 'price-list-1', 'pricing-policy-1', 1, 1, 100000, 90000,
      60000, 80000, 1000, 3333, ?, '[]', 'gc.kim', '', '', NULL, '{}', ?, ?)`);
  insertReview.run("PASS", now, now);
  assert.throws(() => insertReview.run("EXCEPTION_REQUIRED", now, now), /UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT outcome FROM sales_document_pricing_reviews WHERE document_id = 'pricing-document-1'").get().outcome, "PASS");
  db.close();
});

test("sales contracts keep one order link, unique numbers and append-only change evidence", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  db.prepare(`INSERT INTO sales_contracts
    (id, order_document_id, contract_number, title, version, amount_snapshot, currency, start_date, end_date,
      auto_renewal, renewal_notice_days, payment_terms, acceptance_criteria, delivery_terms, owner_employee_id,
      signed_document_id, status, created_by, approved_by, approved_at, created_at, updated_at)
    VALUES ('contract-1', 'order-contract-1', 'CTR-2026-001', '계약 검증', 1, 1000000, 'KRW', '2026-08-15', '2027-08-14',
      1, 30, '월말 현금 지급', '검수서 서명 완료', '지정 장소 납품', 'gc.kim', 'document-1', 'ACTIVE', 'gc.kim', 'gc.kim', ?, ?, ?)`).run(now, now, now);
  const duplicateOrder = db.prepare(`INSERT INTO sales_contracts
    (id, order_document_id, contract_number, title, version, amount_snapshot, currency, start_date, end_date,
      auto_renewal, renewal_notice_days, payment_terms, acceptance_criteria, delivery_terms, owner_employee_id,
      signed_document_id, status, created_by, approved_by, approved_at, created_at, updated_at)
    VALUES (?, ?, ?, '중복', 1, 1, 'KRW', '2026-08-15', '2027-08-14', 0, 30, '지급 조건', '검수 조건', '납품 조건',
      'gc.kim', '', 'DRAFT', 'gc.kim', '', NULL, ?, ?)`);
  assert.throws(() => duplicateOrder.run("contract-order-duplicate", "order-contract-1", "CTR-2026-002", now, now), /UNIQUE constraint failed/);
  assert.throws(() => duplicateOrder.run("contract-number-duplicate", "order-contract-2", "CTR-2026-001", now, now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO sales_contract_obligations
    (id, contract_id, obligation_type, title, owner_employee_id, due_date, evidence_required, status,
      completion_note, completed_by, completed_at, created_at, updated_at)
    VALUES ('obligation-1', 'contract-1', 'DELIVERY', '1차 납품 완료', 'gc.kim', '2026-09-30', 1, 'OPEN', '', '', NULL, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO sales_contract_change_requests
    (id, contract_id, change_type, reason, before_json, after_json, effective_date, status, created_by,
      approval_request_id, approved_by, approved_at, created_at, updated_at)
    VALUES ('contract-change-1', 'contract-1', 'PERIOD', '고객 요청으로 계약기간 연장', '{"endDate":"2027-08-14"}',
      '{"endDate":"2027-12-31"}', '2027-08-01', 'SCHEDULED', 'gc.kim', 'approval-1', 'gc.kim', ?, ?, ?)`).run(now, now, now);
  const settings = db.prepare("SELECT enforcement_started_at FROM sales_contract_governance_settings WHERE id = 'default'").get();
  assert.ok(Number(settings.enforcement_started_at) > 0);
  const duePlan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM sales_contract_obligations WHERE contract_id = 'contract-1' AND status = 'OPEN' ORDER BY due_date").all();
  assert.ok(duePlan.some((row) => String(row.detail).includes("idx_sales_contract_obligation_contract_due")));
  assert.equal(db.prepare("SELECT json_extract(after_json, '$.endDate') AS end_date FROM sales_contract_change_requests WHERE id = 'contract-change-1'").get().end_date, "2027-12-31");
  db.close();
});

test("sales service ledgers keep one active SLA per priority and unique return receipt lineage", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  db.prepare(`INSERT INTO sales_documents
    (id, opportunity_id, document_type, document_number, version, amount, status, issued_date, due_date, created_at, updated_at)
    VALUES ('delivery-1', 'opportunity-1', 'DELIVERY', 'DEL-20260815-001', 1, 10000, 'ACCEPTED', '2026-08-15', '2026-08-15', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO sales_document_lines
    (id, document_id, line_number, catalog_item_id, description, quantity, unit, unit_price, amount, source_line_id, created_at)
    VALUES ('delivery-line-1', 'delivery-1', 1, '', '납품 품목 A', 2, 'EA', 3000, 6000, '', ?),
      ('delivery-line-2', 'delivery-1', 2, '', '납품 품목 B', 1, 'EA', 4000, 4000, '', ?)`).run(now, now);
  const insertPolicy = db.prepare(`INSERT INTO sales_service_policies
    (id, name, version, priority, first_response_hours, resolution_hours, effective_from, effective_to, status,
      created_by, approved_by, approved_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 4, 24, '2026-08-15', '', ?, 'gc.kim', '', NULL, ?, ?)`);
  insertPolicy.run("service-policy-1", "표준 SLA", 1, "NORMAL", "ACTIVE", now, now);
  assert.throws(() => insertPolicy.run("service-policy-2", "개정 SLA", 2, "NORMAL", "ACTIVE", now, now), /UNIQUE constraint failed/);
  insertPolicy.run("service-policy-high", "긴급 SLA", 1, "HIGH", "ACTIVE", now, now);

  const insertCase = db.prepare(`INSERT INTO sales_service_cases
    (id, case_number, account_id, opportunity_id, delivery_document_id, contract_id, contact_id, category, priority,
      subject, description, policy_id, opened_at, first_response_due_at, resolution_due_at, first_responded_at,
      status, owner_employee_id, resolution_type, resolution_note, refund_amount, approval_request_id, finance_request_id,
      resolved_by, resolved_at, closed_by, closed_at, created_by, created_at, updated_at)
    VALUES (?, ?, 'account-1', 'opportunity-1', 'delivery-1', '', '', 'RETURN', 'NORMAL', '반품 요청',
      '고객 반품 요청 검증', 'service-policy-1', ?, ?, ?, ?, 'RESOLUTION_APPROVED', 'gc.kim', 'RETURN',
      '승인 반품 처리', 0, 'approval-1', '', '', NULL, '', NULL, 'gc.kim', ?, ?)`);
  insertCase.run("service-case-1", "CS-20260815-000001", now, now + 3600000, now + 86400000, now + 1000, now, now);
  assert.throws(() => insertCase.run("service-case-2", "CS-20260815-000001", now, now + 3600000, now + 86400000, now + 1000, now, now), /UNIQUE constraint failed/);
  insertCase.run("service-case-2", "CS-20260815-000002", now, now + 3600000, now + 86400000, now + 1000, now, now);

  const insertLine = db.prepare(`INSERT INTO sales_service_return_lines
    (id, case_id, delivery_line_id, quantity_milli, disposition, inventory_movement_id, received_by, received_at, created_at, updated_at)
    VALUES (?, 'service-case-1', 'delivery-line-1', 1000, 'RESTOCK', ?, '', NULL, ?, ?)`);
  insertLine.run("service-return-1", "", now, now);
  assert.throws(() => insertLine.run("service-return-duplicate-line", "", now, now), /UNIQUE constraint failed/);
  const overLimitReturn = db.prepare(`INSERT INTO sales_service_return_lines
    (id, case_id, delivery_line_id, quantity_milli, disposition, inventory_movement_id, received_by, received_at, created_at, updated_at)
    SELECT 'service-return-over-limit', service.id, source_line.id, 1001, 'QUARANTINE', '', '', NULL, ?, ?
    FROM sales_service_cases service JOIN sales_document_lines source_line ON source_line.document_id = service.delivery_document_id
    WHERE service.id = 'service-case-2' AND source_line.id = 'delivery-line-1'
      AND 1001 <= ROUND(source_line.quantity * 1000) - COALESCE((SELECT SUM(existing.quantity_milli)
        FROM sales_service_return_lines existing JOIN sales_service_cases existing_case ON existing_case.id = existing.case_id
        WHERE existing.delivery_line_id = source_line.id AND existing_case.status <> 'CANCELLED'), 0)`).run(now, now);
  assert.equal(overLimitReturn.changes, 0);
  db.prepare("UPDATE sales_service_return_lines SET inventory_movement_id = 'movement-return-1' WHERE id = 'service-return-1'").run();
  db.prepare(`INSERT INTO sales_service_return_lines
    (id, case_id, delivery_line_id, quantity_milli, disposition, inventory_movement_id, received_by, received_at, created_at, updated_at)
    VALUES ('service-return-2', 'service-case-1', 'delivery-line-2', 1000, 'RESTOCK', '', '', NULL, ?, ?)`).run(now, now);
  assert.throws(() => db.prepare("UPDATE sales_service_return_lines SET inventory_movement_id = 'movement-return-1' WHERE id = 'service-return-2'").run(), /UNIQUE constraint failed/);
  db.prepare("UPDATE sales_service_cases SET refund_amount = 7000 WHERE id = 'service-case-1'").run();
  const overLimitRefund = db.prepare(`UPDATE sales_service_cases SET refund_amount = 4000
    WHERE id = 'service-case-2' AND 4000 <= (SELECT delivery.amount - COALESCE((SELECT SUM(other.refund_amount)
      FROM sales_service_cases other WHERE other.delivery_document_id = sales_service_cases.delivery_document_id
        AND other.id <> sales_service_cases.id AND other.status IN ('RESOLUTION_SUBMITTED','RESOLUTION_APPROVED','RESOLVED','CLOSED')), 0)
      FROM sales_documents delivery WHERE delivery.id = sales_service_cases.delivery_document_id)`).run();
  assert.equal(overLimitRefund.changes, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sales_service_case_events WHERE case_id = 'service-case-1'").get().count, 0);
  db.close();
});

test("HR audio transcription ledger preserves attempts and locks each human review", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insert = db.prepare(`INSERT INTO hr_audio_transcriptions
    (id, entity_type, entity_id, audio_key_snapshot, audio_content_type, status, model, language,
      transcript, vtt, word_count, error_code, error_message, attempt, consent_confirmed_by, consent_confirmed_at,
      requested_by, requested_at, completed_at, reviewed_text, review_note, reviewed_by, reviewed_at, created_at, updated_at)
    VALUES (?, 'EMPLOYEE_INTERVIEW', 'employee-interview-1', 'hr-interviews/employee-1/audio.webm', 'audio/webm', ?,
      '@cf/openai/whisper-large-v3-turbo', 'ko', ?, '', 4, '', '', ?, 'gc.kim', ?, 'gc.kim', ?, ?, '', '', '', NULL, ?, ?)`);
  insert.run("transcription-1", "FAILED", "", 1, now, now, now, now, now);
  assert.throws(() => insert.run("transcription-duplicate", "FAILED", "", 1, now, now, now, now, now), /UNIQUE constraint failed/);
  insert.run("transcription-2", "COMPLETED", "테스트 면담 전사", 2, now, now, now, now, now);
  const firstReview = db.prepare(`UPDATE hr_audio_transcriptions SET reviewed_text = '검토된 면담 전사', review_note = '고유명사 확인',
    reviewed_by = 'gc.kim', reviewed_at = ?, updated_at = ? WHERE id = 'transcription-2' AND status = 'COMPLETED' AND reviewed_at IS NULL`).run(now, now);
  const secondReview = db.prepare(`UPDATE hr_audio_transcriptions SET reviewed_text = '다시 덮어쓰기', reviewed_by = 'gc.kim', reviewed_at = ?, updated_at = ?
    WHERE id = 'transcription-2' AND status = 'COMPLETED' AND reviewed_at IS NULL`).run(now + 1, now + 1);
  assert.equal(firstReview.changes, 1);
  assert.equal(secondReview.changes, 0);
  assert.equal(db.prepare("SELECT attempt, transcript, reviewed_text FROM hr_audio_transcriptions WHERE id = 'transcription-2'").get().reviewed_text, "검토된 면담 전사");
  db.close();
});

test("data governance ledgers preserve immutable checks, snapshot evidence and reviewed retention policies", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  db.prepare(`INSERT INTO erp_data_control_runs
    (id, status, requested_by, check_count, failed_count, warning_count, summary_json, started_at, completed_at, created_at)
    VALUES ('control-run-1', 'ATTENTION', 'gc.kim', 2, 0, 1, '{"passed":1}', ?, ?, ?)`).run(now, now, now);
  const insertCheck = db.prepare(`INSERT INTO erp_data_control_checks
    (id, run_id, check_code, category, status, title, detail, evidence_json, created_at)
    VALUES (?, 'control-run-1', 'SCHEMA_CORE', '데이터베이스', 'PASS', '핵심 업무 테이블', '정상', '{}', ?)`);
  insertCheck.run("check-1", now);
  assert.throws(() => insertCheck.run("check-duplicate", now), /UNIQUE constraint failed/);

  db.prepare(`INSERT INTO erp_logical_snapshots
    (id, scope, status, object_key, file_name, content_type, sha256, byte_size, table_count, row_count,
      manifest_json, requested_by, created_at, verified_at, verified_by, verification_status, verification_detail, failure_message)
    VALUES ('snapshot-1', 'D1_APPLICATION_DATA', 'READY', 'erp-governance/snapshots/1.json', 'snapshot.json',
      'application/json', 'abc123', 2048, 4, 10, '{"format":"XD_NODE_D1_LOGICAL_SNAPSHOT_V1"}',
      'gc.kim', ?, ?, 'gc.kim', 'PASS', '해시와 구조 확인', '')`).run(now, now);
  db.prepare(`INSERT INTO erp_recovery_rehearsals
    (id, snapshot_id, status, check_count, failure_count, detail_json, performed_by, performed_at)
    VALUES ('rehearsal-1', 'snapshot-1', 'PASS', 4, 0, '{"productionWrites":0}', 'gc.kim', ?)`).run(now);
  assert.equal(db.prepare("SELECT verification_status FROM erp_logical_snapshots WHERE id = 'snapshot-1'").get().verification_status, "PASS");
  assert.equal(JSON.parse(db.prepare("SELECT detail_json FROM erp_recovery_rehearsals WHERE id = 'rehearsal-1'").get().detail_json).productionWrites, 0);

  const insertPolicy = db.prepare(`INSERT INTO erp_retention_policies
    (id, data_type, label, retention_days, disposition, active, updated_by, updated_at)
    VALUES (?, 'AUDIT_LOG', '감사기록', 2555, 'REVIEW_REQUIRED', 0, '', ?)`);
  insertPolicy.run("policy-1", now);
  assert.throws(() => insertPolicy.run("policy-duplicate", now), /UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT active, disposition FROM erp_retention_policies WHERE id = 'policy-1'").get().active, 0);
  db.close();
});

test("data integration ledgers preserve idempotency, retry lineage and reviewed exceptions", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  db.prepare(`INSERT INTO erp_integration_sources (id,source_code,name,category,system_type,connection_mode,scope,created_at,updated_at)
    VALUES ('source-1','SOURCE_1','테스트 원천','FINANCE','FILE','FILE_SNAPSHOT','테스트',?,?)`).run(now, now);
  const insertRun = db.prepare(`INSERT INTO erp_sync_runs (id,source,scope,snapshot_date,status,record_count,metrics_json,error_message,started_at,completed_at,created_at,source_id,run_type,idempotency_key,retry_of_run_id,requested_by)
    VALUES (?,'FILE','테스트','2026-08-14','SUCCEEDED',1,'{}','',?,?,?, 'source-1','RECONCILIATION',?,?, 'gc.kim')`);
  insertRun.run('run-1', now, now, now, '2026-08-14:hash', '');
  assert.throws(() => insertRun.run('run-duplicate', now, now, now, '2026-08-14:hash', ''), /UNIQUE constraint failed/);
  insertRun.run('run-retry', now, now, now, '2026-08-14:hash:retry:run-1', 'run-1');
  db.prepare(`INSERT INTO erp_integration_exceptions (id,run_id,source_id,exception_key,exception_type,severity,title,status,resolution_note,created_at,updated_at)
    VALUES ('exception-1','run-1','source-1','count','MISSING','HIGH','건수 불일치','ACCEPTED_RISK','승인된 기간 차이',?,?)`).run(now, now);
  assert.throws(() => db.prepare(`INSERT INTO erp_integration_exceptions (id,run_id,source_id,exception_key,exception_type,severity,title,created_at,updated_at)
    VALUES ('exception-2','run-1','source-1','count','MISSING','HIGH','중복',?,?)`).run(now, now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO erp_sync_run_events (id,run_id,action,actor_employee_id,note,created_at) VALUES ('event-1','run-1','ACCEPT_RISK','gc.kim','승인된 기간 차이',?)`).run(now);
  assert.equal(db.prepare("SELECT retry_of_run_id FROM erp_sync_runs WHERE id='run-retry'").get().retry_of_run_id, 'run-1');
  assert.equal(db.prepare("SELECT status FROM erp_integration_exceptions WHERE id='exception-1'").get().status, 'ACCEPTED_RISK');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM erp_sync_run_events WHERE run_id='run-1'").get().count, 1);
  db.close();
});

test("HR compensation runs preserve one monthly draft and employee snapshots", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  db.prepare(`INSERT INTO hr_compensation_runs
    (period,status,version,employee_count,gross_pay,created_by,created_at,updated_at)
    VALUES ('2026-09','DRAFT',1,1,3100000,'gc.kim',?,?)`).run(now, now);
  assert.throws(() => db.prepare(`INSERT INTO hr_compensation_runs
    (period,status,version,employee_count,gross_pay,created_by,created_at,updated_at)
    VALUES ('2026-09','DRAFT',1,0,0,'gc.kim',?,?)`).run(now, now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO hr_compensation_lines(period,employee_id,snapshot_json,gross_pay,updated_at)
    VALUES ('2026-09','employee-1','{"name":"김직원","basePay":3100000}',3100000,?)`).run(now);
  assert.throws(() => db.prepare(`INSERT INTO hr_compensation_lines(period,employee_id,snapshot_json,gross_pay,updated_at)
    VALUES ('2026-09','employee-1','{}',0,?)`).run(now), /UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT gross_pay FROM hr_compensation_lines WHERE period='2026-09' AND employee_id='employee-1'").get().gross_pay, 3100000);
  db.close();
});

test("data intake ledgers reject duplicate originals and preserve row and event lineage", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  db.prepare(`INSERT INTO erp_data_import_batches (id,source_id,status,file_name,content_type,storage_key,file_sha256,parser_type,requested_by,created_at,updated_at)
    VALUES ('batch-1','hiworks-employees','VALIDATED','employees.csv','text/csv','erp-imports/1.csv','hash-1','CSV','gc.kim',?,?)`).run(now, now);
  assert.throws(() => db.prepare(`INSERT INTO erp_data_import_batches (id,source_id,status,file_name,content_type,storage_key,file_sha256,parser_type,requested_by,created_at,updated_at)
    VALUES ('batch-2','hiworks-employees','VALIDATED','copy.csv','text/csv','erp-imports/2.csv','hash-1','CSV','gc.kim',?,?)`).run(now, now), /UNIQUE constraint failed/);
  const insertRow = db.prepare(`INSERT INTO erp_data_import_rows (id,batch_id,row_number,raw_json,normalized_json,identity_key,row_checksum,validation_status,proposed_action,created_at)
    VALUES (?,'batch-1',2,'{}','{}','employee@example.com','row-hash','VALID','CREATE',?)`);
  insertRow.run('row-1', now); assert.throws(() => insertRow.run('row-2', now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO erp_data_import_events (id,batch_id,action,from_status,to_status,actor_employee_id,note,created_at)
    VALUES ('event-1','batch-1','SUBMITTED','VALIDATED','SUBMITTED','gc.kim','결재 제출',?)`).run(now);
  db.prepare(`INSERT INTO erp_data_import_events (id,batch_id,action,from_status,to_status,actor_employee_id,note,created_at)
    VALUES ('event-2','batch-1','APPROVED','SUBMITTED','APPROVED','gc.kim','전자결재 승인',?)`).run(now + 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM erp_data_import_events WHERE batch_id='batch-1'").get().count, 2);
  assert.equal(db.prepare("SELECT proposed_action FROM erp_data_import_rows WHERE id='row-1'").get().proposed_action, 'CREATE');
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM erp_data_import_rows WHERE batch_id=? AND validation_status=? AND proposed_action=?").all('batch-1', 'VALID', 'CREATE');
  assert.match(plan.map((row) => row.detail).join(' '), /idx_erp_data_import_row_validation/);
  db.close();
});

test("finance import mapping ledgers preserve one active version and validation lineage", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertSet = db.prepare(`INSERT INTO finance_import_mapping_sets (id,source_id,name,data_type,version,status,field_mapping_json,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insertSet.run('mapping-1','ecount-finance-2025','2025 분개장','JOURNAL',1,'ACTIVE','{}','gc.kim',now,now);
  assert.throws(() => insertSet.run('mapping-2','ecount-finance-2025','중복 활성','JOURNAL',2,'ACTIVE','{}','gc.kim',now,now), /UNIQUE constraint failed/);
  insertSet.run('mapping-2','ecount-finance-2025','차기 초안','JOURNAL',2,'DRAFT','{}','gc.kim',now,now);
  const insertRule = db.prepare(`INSERT INTO finance_import_mapping_rules (id,mapping_set_id,dimension_type,source_key,source_label,target_id,target_code,target_label,created_by,created_at,updated_at)
    VALUES (?,'mapping-2','ACCOUNT','10300','보통예금','account-10300','10300','보통예금','gc.kim',?,?)`);
  insertRule.run('rule-1',now,now); assert.throws(() => insertRule.run('rule-2',now,now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO finance_import_validations (id,batch_id,mapping_set_id,data_type,status,row_count,valid_count,invalid_count,total_debit,total_credit,difference_amount,created_by,created_at)
    VALUES ('validation-1','batch-finance','mapping-1','JOURNAL','PASSED',2,2,0,10000,10000,0,'gc.kim',?)`).run(now);
  const insertCanonical = db.prepare(`INSERT INTO finance_import_canonical_rows (id,validation_id,batch_id,row_number,record_type,record_key,canonical_json,validation_status,source_checksum,created_at)
    VALUES (?,'validation-1','batch-finance',2,'JOURNAL','V-1:1','{}','VALID','row-hash',?)`);
  insertCanonical.run('canonical-1',now); assert.throws(() => insertCanonical.run('canonical-2',now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO finance_import_mapping_events (id,mapping_set_id,action,from_status,to_status,actor_employee_id,note,created_at)
    VALUES ('mapping-event-1','mapping-1','BATCH_VALIDATED','ACTIVE','ACTIVE','gc.kim','차대변 일치',?)`).run(now);
  assert.equal(db.prepare("SELECT difference_amount FROM finance_import_validations WHERE id='validation-1'").get().difference_amount, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM finance_import_mapping_events WHERE mapping_set_id='mapping-1'").get().count, 1);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM finance_import_validations WHERE batch_id=? ORDER BY created_at DESC").all('batch-finance');
  assert.match(plan.map((row) => row.detail).join(' '), /idx_finance_import_validation_batch_created/);
  db.close();
});

test("finance posting ledgers prevent source reposting and duplicate reversals", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertBatch = db.prepare(`INSERT INTO finance_posting_batches (id,validation_id,batch_number,source_type,reversal_of_batch_id,status,period_from,period_to,voucher_count,line_count,total_debit,total_credit,difference_amount,prepared_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertBatch.run('posting-1','validation-1','IMP-DRAFT-1','IMPORT','','DRAFT','2026-08','2026-08',1,2,10000,10000,0,'gc.kim',now,now);
  assert.throws(() => insertBatch.run('posting-duplicate','validation-1','IMP-DRAFT-2','IMPORT','','DRAFT','2026-08','2026-08',1,2,10000,10000,0,'gc.kim',now,now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO finance_posting_vouchers (id,batch_id,source_voucher_key,voucher_date,period,status,line_count,total_debit,total_credit,created_at,updated_at)
    VALUES ('voucher-1','posting-1','ECOUNT-1','2026-08-15','2026-08','DRAFT',2,10000,10000,?,?)`).run(now,now);
  const insertLine = db.prepare(`INSERT INTO finance_posting_lines (id,voucher_id,line_number,account_id,account_code,account_name,tax_review_status,tax_review_note,debit_amount,credit_amount,source_canonical_row_id,source_checksum,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertLine.run('line-1','voucher-1',1,'account-1','10100','현금','REVIEWED','해당 없음',10000,0,'canonical-1','hash-1',now,now);
  insertLine.run('line-2','voucher-1',2,'account-2','40100','매출','REVIEWED','해당 없음',0,10000,'canonical-2','hash-2',now,now);
  assert.throws(() => insertLine.run('line-repost','voucher-1',3,'account-2','40100','매출','REVIEWED','해당 없음',0,10000,'canonical-2','hash-2',now,now), /UNIQUE constraint failed/);
  insertBatch.run('reversal-1','','REV-DRAFT-1','REVERSAL','posting-1','DRAFT','2026-08','2026-08',1,2,10000,10000,0,'gc.kim',now,now);
  assert.throws(() => insertBatch.run('reversal-2','','REV-DRAFT-2','REVERSAL','posting-1','DRAFT','2026-08','2026-08',1,2,10000,10000,0,'gc.kim',now,now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO finance_posting_events (id,batch_id,action,from_status,to_status,actor_employee_id,note,created_at)
    VALUES ('posting-event-1','posting-1','POSTED','APPROVED','POSTED','gc.kim','전기 완료',?)`).run(now);
  assert.equal(db.prepare("SELECT SUM(debit_amount) AS debit,SUM(credit_amount) AS credit FROM finance_posting_lines WHERE voucher_id='voucher-1'").get().debit, 10000);
  assert.equal(db.prepare("SELECT SUM(debit_amount) AS debit,SUM(credit_amount) AS credit FROM finance_posting_lines WHERE voucher_id='voucher-1'").get().credit, 10000);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM finance_posting_lines WHERE tax_review_status=? AND tax_code_id=?").all('PENDING','');
  assert.match(plan.map((row) => row.detail).join(' '), /idx_finance_posting_tax_review/);
  db.close();
});

test("opening balance ledgers preserve one official baseline and unique account lines",async()=>{const db=await migratedDatabase();const now=Date.now();const insert=db.prepare(`INSERT INTO finance_opening_balance_sets(id,fiscal_year,version,status,source_label,source_as_of,source_checksum,line_count,total_debit,total_credit,difference_amount,prepared_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);insert.run("open-1",2026,1,"APPROVED","2025 TB","2025-12-31","hash-1",2,100,100,0,"gc.kim",now,now);assert.throws(()=>insert.run("open-2",2026,2,"APPROVED","2025 TB revised","2025-12-31","hash-2",2,100,100,0,"gc.kim",now,now),/UNIQUE constraint failed/);const line=db.prepare(`INSERT INTO finance_opening_balance_lines(id,set_id,line_number,account_code,account_name,account_category,normal_balance,debit_amount,credit_amount,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);line.run("ol-1","open-1",1,"101","현금","ASSET","DEBIT",100,0,now);assert.throws(()=>line.run("ol-2","open-1",2,"101","현금","ASSET","DEBIT",100,0,now),/UNIQUE constraint failed/);db.close();});

test("finance assistant audit history appends frozen evidence in newest-first order",async()=>{
  const db=await migratedDatabase();const insert=db.prepare(`INSERT INTO finance_assistant_answers
    (id,question,answer,provider,evidence_status,basis_as_of,evidence_json,evidence_hash,answer_hash,prompt_version,
      created_by_employee_id,created_by_user_id,created_by_name,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run("answer-1","자금 상태","첫 답변","AI","VERIFIED","2026-08-13","{\"v\":1}","evidence-1","answer-hash-1","finance-evidence-v2","gc.kim","user-1","김권찬",100);
  insert.run("answer-2","자금 상태","재질문 답변","RULE_BASED_FALLBACK","REVIEW_REQUIRED","2026-08-13","{\"v\":2}","evidence-2","answer-hash-2","finance-evidence-v2","gc.kim","user-1","김권찬",200);
  const rows=db.prepare("SELECT id,evidence_hash FROM finance_assistant_answers ORDER BY created_at DESC").all();
  assert.deepEqual(rows.map((row)=>({...row})),[{id:"answer-2",evidence_hash:"evidence-2"},{id:"answer-1",evidence_hash:"evidence-1"}]);
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT * FROM finance_assistant_answers WHERE created_by_employee_id=? ORDER BY created_at DESC").all("gc.kim");
  assert.match(plan.map((row)=>row.detail).join(" "),/idx_finance_assistant_actor_created/);db.close();
});

test("finance assistant decision lineage is immutable per report and preserves source hashes",async()=>{
  const db=await migratedDatabase();const now=Date.now();const insert=db.prepare(`INSERT INTO finance_management_decisions
    (id,report_id,source_section,decision_type,title,proposal,owner_employee_id,decision_due_date,requires_action,status,
      source_assistant_answer_id,source_answer_hash,source_evidence_hash,source_basis_as_of,source_evidence_status,
      created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?,?,?,?,?,?)`);
  insert.run("decision-1","report-1","GENERAL","CASH","자금 검토","답변을 검토해 자금계획을 결정합니다.","gc.kim","2026-08-31",1,
    "answer-1","answer-hash-1","evidence-hash-1","2026-08-13","VERIFIED","gc.kim",now,now);
  assert.throws(()=>insert.run("decision-2","report-1","GENERAL","CASH","중복","같은 답변을 다시 연결합니다.","gc.kim","2026-08-31",1,
    "answer-1","answer-hash-1","evidence-hash-1","2026-08-13","VERIFIED","gc.kim",now,now),/UNIQUE constraint failed/);
  insert.run("decision-3","report-2","QUALITY","RISK","다른 보고서","검토가 필요한 답변을 별도 보고서에 연결합니다.","gc.kim","2026-09-30",1,
    "answer-1","answer-hash-1","evidence-hash-1","2026-08-13","REVIEW_REQUIRED","gc.kim",now,now);
  const row=db.prepare("SELECT source_answer_hash,source_evidence_hash,source_basis_as_of FROM finance_management_decisions WHERE id='decision-1'").get();
  assert.deepEqual({...row},{source_answer_hash:"answer-hash-1",source_evidence_hash:"evidence-hash-1",source_basis_as_of:"2026-08-13"});db.close();
});
