// 离线回归：combo-ref 的官方换选差价不能变成券渠道的加价或减价。
// 运行：先编译源码，再 node scripts/test-core-voucher-pricing.mjs。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import test from 'node:test';

const scratchRoot = tmpdir();
const testHome = mkdtempSync(join(scratchRoot, 'mcsmart-core-voucher-pricing-'));
process.env.MCSMART_HOME = testHome;
process.on('exit', () => {
  const child = relative(scratchRoot, testHome);
  if (child && !child.startsWith('..') && !isAbsolute(child)) {
    rmSync(testHome, { recursive: true, force: true });
  }
});

const { resolveVoucherFoods } = await import('../dist/voucherFoods.js');
const { voucherSlots } = await import('../dist/groupKernel.js');
const { optimize } = await import('../dist/optimizer.js');

const item = (code, name, extra = {}) => ({
  code, name, priceCents: 1500, originalPriceCents: 1500,
  category: '汉堡小食', tags: [], isCombo: false,
  kcal: 300, protein: 10, fat: 10, carbohydrate: 30, sodium: 400,
  fastCarb: 0, isStaple: /堡/.test(name), isVeggie: false, nutritionMatched: true,
  ...extra,
});

function fixture(officialDiff, choice = {}) {
  const comboRef = { mode: 'combo-ref', keyword: 'C', qty: 1 };
  const drinkChoice = { mode: 'choice', keyword: '饮料任选', qty: 1, choiceRange: ['可乐'], ...choice };
  const menu = {
    items: [
      item('G', '巨无霸'), item('B', '板烧鸡腿堡'), item('P', '香芋派'),
      item('D', '可乐', { category: '饮品' }), item('S', '雪碧', { category: '饮品' }),
      item('C', '官方套餐夹具', {
        isCombo: true,
        deconstruction: [
          { roundName: '主食轮', roundId: 'r1', category: 'staple', defaultName: '巨无霸', options: [
            { code: 'G', name: '巨无霸', diffCents: 0 },
            { code: 'B', name: '板烧鸡腿堡', diffCents: officialDiff },
          ] },
          { roundName: '小食轮', roundId: 'r2', category: 'side', defaultName: '香芋派', options: [
            { code: 'P', name: '香芋派', diffCents: 0 },
          ] },
        ],
      }),
    ],
    unmatched: 0, comboCount: 1, comboUnmatched: 0, table: new Map(),
  };
  const base = {
    id: 'core-pricing', name: '离线券价夹具', source: 'user', kind: 'combo',
    channel: 'owned', channelLabel: '自持券', priceCents: 1000,
    constraints: { orderType: 'instore', perUserLimit: 1 },
  };
  return {
    menu,
    pure: { ...base, items: [comboRef] },
    mixed: { ...base, items: [comboRef, drinkChoice] },
  };
}

const burger = (slots) => slots?.[0]?.options.find((o) => o.name === '板烧鸡腿堡');
const surchargeUnknown = (diag) => !!diag.surchargeUnknown || !!diag.groups?.some((g) => g.surchargeUnknown);

for (const diff of [-100, 200, 0]) {
  test(`官方差价 ${diff} 分：直接解析、混合券与纯 combo-ref 保持隔离及证据一致`, () => {
    const { menu, pure, mixed } = fixture(diff);
    const pureDiag = { reasons: [] }, mixedDiag = { reasons: [] };
    const pureSlots = voucherSlots(pure, menu, [], pureDiag);
    const mixedSlots = voucherSlots(mixed, menu, [], mixedDiag);
    const resolved = resolveVoucherFoods(mixed, { menu });
    assert.equal(resolved.ok, true);
    assert.equal(mixedSlots.length, 3, '保留套餐两槽与券面饮料，不丢内容');
    assert.equal(burger(pureSlots).diffCents, 0, '纯 combo-ref 的现有规则');
    assert.equal(burger(mixedSlots).diffCents, 0, '混合券不能继承官方差价');
    assert.equal(burger(resolved.slots).diffCents, 0, '直接食品解析也隔离官方差价');
    for (const slots of [pureSlots, mixedSlots, resolved.slots]) {
      assert.equal(burger(slots).officialDiffCents ?? 0, diff, '保留官方差价证据');
    }
    assert.equal(surchargeUnknown(pureDiag), diff !== 0);
    assert.equal(surchargeUnknown(mixedDiag), surchargeUnknown(pureDiag), '核销补差未知诊断一致');
    assert.equal(resolved.groups[0].surchargeUnknown ?? false, diff !== 0);
  });

  test(`官方差价 ${diff} 分：实际求解仍按券价 1000 分购买`, async () => {
    const { menu, mixed } = fixture(diff);
    const result = await solveVoucher(mixed, menu);
    assert.equal(result.status, 'proven-optimal');
    assert.equal(result.totals.priceCents, 1000);
    assert.equal(result.assignments[0].qty, 1);
    const chosen = result.assignments[0].slotChoices.find((o) => o.chosenName === '板烧鸡腿堡');
    assert.equal(chosen.officialDiffCents ?? 0, diff, '求解输出仍能追溯官方差价');
  });
}

function solveVoucher(voucher, menu, overrides = {}) {
  return optimize({
    plans: [{
      id: 'kv-core-pricing', channel: 'user', name: voucher.name,
      basePriceCents: voucher.priceCents, maxQty: 1, maxQtySource: 'voucher-limit',
      isExternalCoupon: true, strictCover: true, slots: voucherSlots(voucher, menu),
    }],
    members: [{ alias: '甲', demands: [
      { id: 'burger', keyword: '板烧鸡腿堡', qty: 1, must: true },
      { id: 'drink', keyword: '可乐', qty: 1, must: true },
    ] }],
    mode: 'cheapest', ...overrides,
  });
}

test('950 分硬预算不能借官方减价购买 1000 分混合券', async () => {
  const { menu, mixed } = fixture(-100);
  const result = await solveVoucher(mixed, menu, { totalBudgetCents: 950 });
  assert.equal(result.status, 'infeasible');
  assert.equal(result.assignments.length, 0);
});

test('券面明确的任选补差仍计价，不受官方差价隔离影响', async () => {
  const { menu, mixed } = fixture(-100, {
    choiceRange: ['可乐', '雪碧'], optionDiffs: { 可乐: 0, 雪碧: 200 },
  });
  const slots = voucherSlots(mixed, menu);
  assert.equal(slots[2].options.find((o) => o.name === '雪碧').diffCents, 200);
  const result = await solveVoucher(mixed, menu, { members: [{ alias: '甲', demands: [
    { id: 'burger', keyword: '板烧鸡腿堡', qty: 1, must: true },
    { id: 'drink', keyword: '雪碧', qty: 1, must: true },
  ] }] });
  assert.equal(result.status, 'proven-optimal');
  assert.equal(result.totals.priceCents, 1200, '1000 分券价 + 有依据的 200 分补差');
});
