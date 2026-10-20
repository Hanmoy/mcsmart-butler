// v1.4.11 业务事实与约束回归（W01/W02/W03/W04/W09）
// 全部使用构造夹具，不联网、不读真实凭据；价格与营养均为测试输入，不声称现实在售。
//   W01 单人整篮 vs 本人摄入：允许剩余时分别给出购买营养、本人摄入、逐项剩余
//   W02 官方组件营养不丢失：明细缺失时只用已知食品，不把套餐名当营养来源
//   W03 套餐择一建模：候选计划各自承接，禁止跨套餐拼槽
//   W04 目标用餐时间贯通：预约周二 12:00 时只准入周二可核销的券
//   W09 心愿覆盖按条目计量：未匹配/禁忌/份数缺口都如实计入
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcsmart-v1411-service-'));
process.env.MCSMART_HOME = home;
process.env.MCSMART_DISABLE_BUNDLED_UNION = '1';
for (const key of Object.keys(process.env)) {
  if (/TOKEN|SECRET|APPKEY|UNION_SID/i.test(key)) delete process.env[key];
}
globalThis.fetch = () => { throw Error('offline fixture'); };

const { serviceSolveSingle } = await import('../dist/service.js');
const { solveGroupWithKernel, recallChannelPlans } = await import('../dist/groupKernel.js');
const { buildPlansFromMenuItems, optimize } = await import('../dist/optimizer.js');
const { runWithOrderContext } = await import('../dist/orderContext.js');
const { loadMenuItems } = await import('../dist/menu.js');
const { redeemWindowStatus } = await import('../dist/redeemWindow.js');
const { CONFIG } = await import('../dist/config.js');
CONFIG.topK = 1;

let checks = 0;
const check = (value, note) => { assert.ok(value, note); checks++; };
const eq = (actual, expected, note) => {
  assert.deepEqual(actual, expected, `${note}（实得 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
  checks++;
};

// ---------- 夹具：两份 400 kcal / 100 mg 钠的单品 + 一个两轮套餐 ----------
const ROWS = [['证据食品甲堡', 400, 10, 20, 30, 100], ['证据食品乙', 400, 10, 20, 30, 100]];
const A = { name: '证据食品甲堡', currentPrice: '15' };
const B = { name: '证据食品乙', currentPrice: '15' };
const C = { name: '证据夹具二件套餐', currentPrice: '20' };
function clientOf(includeSingles = true) {
  return {
    async call(tool, params) {
      if (tool === 'query-meals') {
        return { data: {
          categories: [
            { name: '单品', meals: includeSingles ? [{ code: 'QA' }, { code: 'QB' }] : [] },
            { name: '精选套餐', meals: [{ code: 'QC', tags: ['套餐'] }] },
          ],
          meals: includeSingles ? { QA: A, QB: B, QC: C } : { QC: C },
        } };
      }
      if (tool === 'list-nutrition-foods') {
        return { data: {}, rawText: ROWS.map(([n, k, p, f, c, s]) => `  ${n},null,${k * 4},${k},${p},${f},${c},${s},0`).join('\n') };
      }
      if (tool === 'query-meal-detail' && params.code === 'QC') {
        return { data: { rounds: [
          { id: 1, name: '食品甲轮', choices: [{ code: 'QA', name: A.name, isDefault: 1, diffPrice: '+0' }] },
          { id: 2, name: '食品乙轮', choices: [{ code: 'QB', name: B.name, isDefault: 1, diffPrice: '+0' }] },
        ] } };
      }
      if (tool === 'calculate-price') {
        const unit = { QA: 1500, QB: 1500, QC: 2000 };
        return { data: { price: (params.items ?? []).reduce((s, i) => s + (unit[i.productCode] ?? 0) * i.quantity, 0), discount: 0 } };
      }
      throw Error('fixture does not implement ' + tool);
    },
  };
}

// ---------- W01：单人整篮可剩余，购买营养 / 本人摄入 / 剩余三分 ----------
{
  const out = await serviceSolveSingle(clientOf(), {
    storeCode: 'W01', city: '上海', kcal: 800, yuan: 30,
    constraints: [{ metric: 'kcal', op: '<=', value: 500 }],
  });
  check(out.feasible, 'W01 单件即可满足 500 kcal 上限');
  const sol = out.solutions[0];
  eq(sol.metrics.kcal, 800, 'W01 整篮热量是买到的 800 kcal');
  eq(sol.memberKcal, 400, 'W01 本人摄入是分配到的 400 kcal');
  eq(sol.intake.purchasedKcal, 800, 'W01 intake.purchasedKcal');
  eq(sol.intake.memberKcal, 400, 'W01 intake.memberKcal');
  eq(sol.intake.leftoverKcal, 400, 'W01 intake.leftoverKcal');
  eq(sol.intake.complete, false, 'W01 有剩余时 complete=false');
  check(Array.isArray(sol.intake.leftovers) && sol.intake.leftovers.length === 1, 'W01 逐项剩余单列一项');
  eq(sol.intake.leftovers[0].kcal, 400, 'W01 剩余项热量');
  eq(sol.intake.leftovers[0].qty, 1, 'W01 剩余项份数');
  eq(sol.intake.macros.sodium, 100, 'W01 本人摄入钠是 100mg，不是整篮 200mg');
  eq(sol.intake.macros.protein, 10, 'W01 本人摄入蛋白按分配累加');
  eq(sol.metrics.sodium, 200, 'W01 整篮钠仍是 200mg（支付口径）');
  check(sol.intake.leftovers[0].itemName === A.name || sol.intake.leftovers[0].itemName === B.name, 'W01 剩余项指向具体食品');
  check((sol.reasonNotes ?? []).some(n => /剩余|未吃完|整篮/.test(String(n))), 'W01 文案说明允许剩余，不只删超限提示');
}

// ---------- W01 补充：非热量硬限制同样按本人摄入判定 ----------
{
  const out = await serviceSolveSingle(clientOf(), {
    storeCode: 'W01-NA', city: '上海', kcal: 800, yuan: 30,
    constraints: [{ metric: 'sodium', op: '<=', value: 150 }],
  });
  check(out.feasible, 'W01 钠上限 150mg 有解（本人摄入 100mg）');
  eq(out.solutions[0].memberKcal, 400, 'W01 钠约束方案本人摄入 400 kcal');
  eq(out.solutions[0].intake.macros.sodium, 100, 'W01 钠约束方案本人钠 100mg');
  eq(out.solutions[0].metrics.sodium, 200, 'W01 钠约束方案整篮钠 200mg');
}

// ---------- W02：套餐明细缺失时官方组件营养不得丢失 ----------
{
  const loose = await serviceSolveSingle(clientOf(false), { storeCode: 'W02', city: '上海', kcal: 800, yuan: 30 });
  check(loose.feasible, 'W02 无营养表宽松口径仍有解');
  eq(loose.solutions[0].metrics.kcal, 800, 'W02 已知热量来自组件食品 800 kcal');

  const strict = await serviceSolveSingle(clientOf(false), {
    storeCode: 'W02-STRICT', city: '上海', kcal: 800, yuan: 30,
    constraints: [{ metric: 'kcal', op: '<=', value: 900 }],
  });
  check(strict.feasible, 'W02 严格 900 上限必须可解（组件营养未丢）');
  eq(strict.solutions[0].metrics.kcal, 800, 'W02 严格口径仍是 800 kcal');
  check(!strict.reason, 'W02 严格口径不应报不可行原因');
}

// ---------- W03：套餐候选是择一，不按全局槽序拼接 ----------
{
  const p3 = { code: 'P3', name: '巨无霸三件套', price: 2000, slots: [
    { round: '堡', name: '巨无霸', code: 'B1' },
    { round: '小食', name: '中薯条', code: 'F1' },
    { round: '饮料', name: '可乐', code: 'D1' },
  ] };
  const p4 = { code: 'P4', name: '巨无霸四件套', price: 3000, slots: [...p3.slots, { round: '甜品', name: '香芋派', code: 'S1' }] };
  const menuItems = [p3, p4].map(p => ({
    code: p.code, name: p.name, priceCents: p.price, isCombo: true, category: '套餐',
    deconstruction: p.slots.map((s, i) => ({
      roundId: `${p.code}-${i}`, roundName: s.round, defaultName: s.name,
      options: [{ code: s.code, name: s.name, diffCents: 0 }],
    })),
  }));
  const table = new Map([
    ['巨无霸', { productName: '巨无霸', energyKcal: 500, protein: 25, fat: 20, carbohydrate: 40, sodium: 900 }],
    ['中薯条', { productName: '中薯条', energyKcal: 300, protein: 4, fat: 12, carbohydrate: 38, sodium: 160 }],
    ['可乐', { productName: '可乐', energyKcal: 150, protein: 0, fat: 0, carbohydrate: 38, sodium: 10 }],
    ['香芋派', { productName: '香芋派', energyKcal: 250, protein: 3, fat: 12, carbohydrate: 30, sodium: 120 }],
  ]);
  const built = buildPlansFromMenuItems(menuItems, { includeSingle: false, table });
  const generic = await optimize({
    plans: built.comboPlans,
    members: [{ alias: '甲', demands: [{ id: 'd1', keyword: '巨无霸套餐', qty: 1, comboPlanId: 'mcd-P3', comboPlanIds: ['mcd-P3', 'mcd-P4'] }] }],
    mode: 'fit', kcalBudget: 1000, totalBudgetCents: 10000,
  });
  check(/^(ok|partial|proven-optimal)$/.test(generic.status), `W03 泛称心愿应可承接（实得 ${generic.status}）`);
  eq(generic.totals.priceCents, 2000, 'W03 三件套 ¥20 优于四件套 ¥30，只买一个套餐');
  eq(generic.assignments.length, 1, 'W03 只成交一个购买单元');
  eq(generic.assignments[0].planName, '巨无霸三件套', 'W03 成交的是三件套');

  // 跨套餐拼槽：A=鸡肉堡+可乐，B=牛肉堡+纯水；甲忌牛肉且不要含糖饮料
  const cross = buildPlansFromMenuItems([
    { code: 'CA', name: 'A套餐', priceCents: 1500, isCombo: true, category: '套餐', deconstruction: [
      { roundId: 'CA1', roundName: '堡', defaultName: '鸡肉堡', options: [{ code: 'CH', name: '鸡肉堡', diffCents: 0 }] },
      { roundId: 'CA2', roundName: '饮料', defaultName: '可乐', options: [{ code: 'CO', name: '可乐', diffCents: 0 }] },
    ] },
    { code: 'CB', name: 'B套餐', priceCents: 1500, isCombo: true, category: '套餐', deconstruction: [
      { roundId: 'CB1', roundName: '堡', defaultName: '牛肉堡', options: [{ code: 'BE', name: '牛肉堡', diffCents: 0 }] },
      { roundId: 'CB2', roundName: '饮料', defaultName: '纯水', options: [{ code: 'WA', name: '纯水', diffCents: 0 }] },
    ] },
  ], { includeSingle: false });
  const crossRes = await optimize({
    plans: cross.comboPlans,
    members: [{ alias: '甲', noSugaryDrink: true, taboo: ['牛肉'], demands: [{ id: 'x1', keyword: '套餐', qty: 1, comboPlanId: 'mcd-CA', comboPlanIds: ['mcd-CA', 'mcd-CB'] }] }],
    mode: 'cheapest', totalBudgetCents: 10000,
  });
  eq(crossRes.coverage.met, 0, 'W03 A 的堡 + B 的水不得拼成一个套餐覆盖');
  eq(crossRes.coverage.total, 1, 'W03 缺口账仍记得这条心愿');
  check(!crossRes.memberAllocations[0]?.demands?.some(d => d.satisfied), 'W03 跨套餐拼槽不计为已满足');
}

// ---------- W04：目标用餐时间贯通券核销准入 ----------
{
  const menuWindow = await loadMenuItems(clientOf(), 'W04', { includeUnmatched: true });
  const OriginalDate = Date;
  const frozen = +new OriginalDate('2026-10-19T12:00:00+08:00'); // 周一 12:00
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [frozen])); }
    static now() { return frozen; }
  };
  try {
    const voucher = { id: 'TUESDAY', name: '【仅周二可核销】证据食品甲堡券', channel: 'owned', channelLabel: '自持',
      kind: 'combo', priceCents: 100, originalPriceCents: 1500,
      items: [{ mode: 'fixed', keyword: A.name, qty: 1 }],
      constraints: { orderType: 'instore', perUserLimit: 1 },
      buyPath: 'fixture', redeemPath: 'fixture', verifiedAt: '2026-10-19', source: 'user', evidence: 'synthetic fixture' };
    const monday = { ...voucher, id: 'MONDAY', name: '【仅周一可核销】证据食品甲堡券' };
    const target = new OriginalDate('2026-10-20T12:00:00+08:00');
    check(!redeemWindowStatus(voucher, new OriginalDate(frozen), 'now').ok, 'W04 现在（周一）不可核销周二券');
    check(redeemWindowStatus(voucher, target, 'target').ok, 'W04 目标时间（周二）可核销周二券');
    check(!redeemWindowStatus(monday, target, 'target').ok, 'W04 目标时间不可核销周一券');

    const future = await runWithOrderContext({ reservationDate: '2026-10-20 12:00', period: 'regular' }, () =>
      recallChannelPlans(clientOf(), { storeCode: 'W04', city: '上海' }, menuWindow, [voucher, monday]));
    const names = future.voucherPlans.map(p => p.name);
    check(names.includes(voucher.name), 'W04 预约周二时周二券仍可购买');
    check(!names.includes(monday.name), 'W04 预约周二时周一券被排除');
    const excluded = future.diagnostics.excluded.find(x => x.name === monday.name);
    check(!!excluded, 'W04 被排除的券要有诊断记录');
    check(/目标时间|周二/.test(String(excluded?.reason ?? '')), 'W04 排除原因写目标时间，不写"今天"');
  } finally {
    globalThis.Date = OriginalDate;
  }
}

// ---------- W09：心愿覆盖按条目计量 ----------
{
  const base = (storeCode, members) => solveGroupWithKernel(clientOf(), { storeCode, city: '上海', members });
  const miss = await base('W09-MISS', [{ alias: '甲', wishes: ['证据食品甲堡'], taboos: [] }, { alias: '乙', wishes: ['火星石头饼'], taboos: [] }]);
  eq([miss.solution.coverage.met, miss.solution.coverage.total], [1, 2], 'W09 未匹配心愿计半（1/2）');
  check(miss.solution.gapTotal > 0, 'W09 未匹配心愿产生缺口');
  const missB = miss.solution.members.find(m => m.alias === '乙');
  eq(missB.items.length, 0, 'W09 乙没有凭空拿到食品');
  check(missB.unresolvedWishes.some(w => /火星石头饼/.test(String(w))), 'W09 未匹配心愿保留在未满足清单');

  const qty = await base('W09-QTY', [{ alias: '甲', wishes: ['五份证据食品甲堡'], taboos: [] }, { alias: '乙', wishes: ['证据食品乙'], taboos: [] }]);
  eq([qty.solution.coverage.met, qty.solution.coverage.total], [1, 2], 'W09 份数缺口计半（1/2）');
  const qtyA = qty.solution.members.find(m => m.alias === '甲');
  check(qtyA.items.every(i => i.qty < 5), 'W09 份数未满不得按已满足计');

  const taboo = await base('W09-TABOO', [{ alias: '甲', wishes: ['证据食品甲堡'], taboos: ['证据食品甲堡'] }, { alias: '乙', wishes: ['证据食品乙'], taboos: [] }]);
  eq([taboo.solution.coverage.met, taboo.solution.coverage.total], [1, 2], 'W09 禁忌冲突计半（1/2）');
  const tabooA = taboo.solution.members.find(m => m.alias === '甲');
  check(tabooA.items.every(i => !/证据食品甲堡/.test(i.name)), 'W09 禁忌食品不得出现在甲名下');

  // 结构化缺口：份数缺口单列、禁忌/未匹配保留原因
  const unmetOf = (sol, alias) => (sol.unmet ?? []).filter(u => u.alias === alias);
  const missUnmet = unmetOf(miss.solution, '乙');
  check(missUnmet.some(u => /火星石头饼/.test(u.keyword)), 'W09 unmet 保留未匹配心愿');
  check(missUnmet.every(u => u.reason === 'no-candidate'), `W09 未匹配心愿原因 no-candidate（实得 ${JSON.stringify(missUnmet)}）`);
  const qtyUnmet = unmetOf(qty.solution, '甲');
  check(qtyUnmet.some(u => /证据食品甲堡/.test(u.keyword) && u.reason === 'unsatisfied'), 'W09 unmet 份数缺口单列一条');
  const gotQty = qtyA.items.filter(i => /证据食品甲堡/.test(i.name)).reduce((s, i) => s + i.qty, 0);
  eq(qtyUnmet.find(u => /证据食品甲堡/.test(u.keyword))?.missingQty, 5 - gotQty, `W09 缺 ${5}-${gotQty} 份要写明份数`);
  const tabooUnmet = unmetOf(taboo.solution, '甲');
  eq(tabooUnmet.map(u => u.reason), ['taboo'], 'W09 禁忌冲突记录为 taboo 原因');
  eq(tabooUnmet[0]?.keyword, '证据食品甲堡', 'W09 禁忌冲突保留原心愿词');
  check(taboo.solution.warnings.some(w => /禁忌冲突/.test(w)), 'W09 禁忌冲突要有用户可读警告');
}

console.log(`v1.4.11 业务事实与约束：${checks}项断言通过（构造夹具；W01/W02/W03/W04/W09）`);
rmSync(home, { recursive: true, force: true });
