import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual UI's pure functions without React, browser storage or production data.
const source = readFileSync(new URL('../app/incentive/incentive-calculator.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('incentive.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['calculate', 'foldedCableCosts', 'roundIncentive', 'personKey'];
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(functions.length, names.length);
const context = vm.createContext({});
vm.runInContext(ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);
const config = { hurdleRate: 10, payoutRate: 20, fixCancelSign: true, cableMode: 'fold' };
const deal = { id: 'a', date: '2026-09-01', client: 'Test', kind: '장비', quantity: 2, unitSale: 1000, unitCost: 500, expense: 100, excluded: false };

test('incentive applies expenses, margin hurdle and payout rate', () => {
  const result = context.calculate(deal, config);
  assert.equal(result.sales, 2000);
  assert.equal(result.margin, 900);
  assert.equal(result.threshold, 200);
  assert.equal(result.incentive, 140);
});

test('excluded, loss and cancellation rows do not create a payout', () => {
  assert.equal(context.calculate({ ...deal, excluded: true }, config).incentive, 0);
  assert.equal(context.calculate({ ...deal, unitCost: 2000 }, config).incentive, 0);
  const cancelled = context.calculate({ ...deal, quantity: -2, unitCost: 2000 }, config);
  assert.equal(cancelled.cancelBlocked, true);
  assert.equal(cancelled.incentive, 0);
});

test('excluded cable cost folds once into largest eligible sale in the same date and client', () => {
  const costs = context.foldedCableCosts([
    deal, { ...deal, id: 'larger', quantity: 4 },
    { ...deal, id: 'cable', kind: '케이블', quantity: 1, unitCost: 300, excluded: true },
    { ...deal, id: 'different-day', kind: '케이블', date: '2026-09-02', excluded: true },
  ], config);
  assert.equal(costs.size, 1);
  assert.equal(costs.get('larger'), 300);
  assert.equal(context.calculate(deal, config, 300).incentive, 80);
  assert.equal(context.foldedCableCosts([deal], { ...config, cableMode: 'exclude' }).size, 0);
});

test('rounding and employee identity remain distinct for same-name employees', () => {
  assert.equal(context.roundIncentive(10.6, 'round'), 11);
  assert.equal(context.roundIncentive(10.6, 'floor'), 10);
  assert.equal(context.roundIncentive(10.6, 'none'), 10.6);
  assert.notEqual(context.personKey({ person: 'Same', personId: '1' }), context.personKey({ person: 'Same', personId: '2' }));
  assert.equal(context.personKey({ person: 'Same', personId: '' }), 'unresolved:Same');
});
