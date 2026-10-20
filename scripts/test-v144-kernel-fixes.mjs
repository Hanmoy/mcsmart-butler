// v1.4.4 内核回归（R07 / R08 / R09 / R10）——有区分力的行为反例
// 运行：npm test 或 node scripts/test-v144-kernel-fixes.mjs（需先 tsc）
//
// 覆盖评审 2026-10-16 报告中的：
//   R07 规格硬上限：显式规格心愿按规格营养入模；无规格心愿不受规格门禁影响
//   R08 分账尾差：组件参考价全为零时不得把整单甩给末位成员；成员换序结果一致
//   R09 轨道回退：单点轨无解但套餐轨可行时不得误报「官方两轨均无可行方案」
//   R10 券内数量：券配方 combo-ref 的 qty 必须展开为完整槽位
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v144-kernel-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const { solveGroupWithKernel } = await import('../dist/groupKernel.js');
const { recipeFoodUnits } = await import('../dist/voucherRecipes.js');
const { optimizeTopK } = await import('../dist/optimizer.js');

let failures = 0;
const check = (cond, label) => { if (cond) console.log(`  ✓ ${label}`); else { console.error(`  ✗ ${label}`); failures++; } };

// 各用例使用独立门店码：菜单快照按门店持久化，复用同一门店会把前一块的菜单带给后一块
const STORE = (code) => ({ storeCode: code, storeName: '测试门店-' + code });
const row = (n, kj, kcal, p, f, c, na) => `  ${n},null,${kj},${kcal},${p},${f},${c},${na},0`;

function mkClient(menu, rounds, priceOf, extraRows = []) {
  return {
    async call(tool, params) {
      if (tool === 'query-meals') return { data: { categories: [
        { name: '汉堡小食', meals: Object.keys(menu).filter((c) => !rounds[c]).map((code) => ({ code, tags: [] })) },
        { name: '精选套餐', meals: Object.keys(rounds).map((code) => ({ code, tags: ['套餐'] })) },
      ], meals: menu } };
      if (tool === 'list-nutrition-foods') return { data: {}, rawText: extraRows.join('\n') };
      if (tool === 'query-meal-detail') {
        const r = rounds[params.code];
        if (!r) throw new Error('mock 无该套餐详情：' + params.code);
        return { data: { rounds: r } };
      }
      if (tool === 'calculate-price') {
        const sum = (params.items ?? []).reduce((s, i) => s + (priceOf[i.productCode] ?? 0) * (i.quantity ?? 1), 0);
        return { data: { price: sum > 0 ? sum : 0, discount: 0, productOriginalPrice: sum } };
      }
      throw new Error('mock 未实现的工具：' + tool);
    },
  };
}

// ---------- R07 规格硬上限 ----------
console.log('【R07】显式规格心愿按规格营养入模；无规格心愿不受规格门禁影响');
{
  const menu = { M3: { name: '薯条', currentPrice: '13.5' }, M5: { name: '可乐', currentPrice: '10.5' } };
  const priceOf = { M3: 1350, M5: 1050 };
  const client = mkClient(menu, {}, priceOf, [row('薯条', 1214, 289, 4, 15, 34, 210), row('大薯条', 1586, 379, 5, 19, 45, 280), row('可乐', 616, 147, 0, 0, 37, 15)]);
  const k1 = await solveGroupWithKernel(client, { ...STORE('S7'), members: [{ alias: '甲', wishes: ['大薯条'], taboos: [] }] });
  const s1 = k1.bundle ?? k1.solution;
  check(s1.members[0].kcal === 379, `显式规格心愿按规格营养入模（kcal=${s1.members[0].kcal}，期望 379）`);

  const k2 = await solveGroupWithKernel(client, { ...STORE('S7'), members: [{ alias: '乙', wishes: ['薯条'], taboos: [] }] });
  const s2 = k2.bundle ?? k2.solution;
  check(s2.members[0].kcal === 289, `无规格心愿用默认营养（kcal=${s2.members[0].kcal}，期望 289）`);

  const k3 = await solveGroupWithKernel(client, { ...STORE('S7'), members: [{ alias: '丙', wishes: ['大薯条'], taboos: [], kcalCap: 300 }] });
  const s3 = k3.bundle ?? k3.solution;
  check(s3.members[0].kcal <= 300 && !s3.members[0].items.some((i) => /薯条/.test(i.name)),
    `规格热量参与硬上限（379>300 不得分配；实际 kcal=${s3.members[0].kcal}）`);
}

// ---------- R08 分账尾差 ----------
console.log('【R08】组件参考价全为零时按显式依据分摊，成员换序结果一致');
{
  const menu = { C9: { name: '超值双人套餐', currentPrice: '20.0' } };
  const rounds = { C9: [
    { id: 91, name: '主食轮', choices: [{ code: 'X1', name: '神秘堡', isDefault: 1, diffPrice: '+0' }] },
    { id: 92, name: '饮料轮', choices: [{ code: 'X2', name: '神秘饮', isDefault: 1, diffPrice: '+0' }] },
  ] };
  const client = mkClient(menu, rounds, { C9: 2000 });
  const members = [{ alias: '甲', wishes: ['超值双人套餐'], taboos: [] }, { alias: '乙', wishes: ['超值双人套餐'], taboos: [] }];
  const k = await solveGroupWithKernel(client, { ...STORE('S8'), members });
  const sol = k.bundle ?? k.solution;
  const paid = sol.totals.paidCents;
  const shares = sol.members.map((m) => m.shareCents);
  check(paid === 4000, `整单 ¥40（实际 ¥${(paid / 100).toFixed(1)}）`);
  check(shares.reduce((s, x) => s + x, 0) === paid, `守恒 Σshare=paid（${shares.reduce((s, x) => s + x, 0)}=${paid}）`);
  check(shares.every((s) => Math.abs(s - 2000) <= 1), `各 ¥20（实际 ${shares.map((s) => '¥' + (s / 100).toFixed(1)).join(' / ')}）`);

  const k2 = await solveGroupWithKernel(client, { ...STORE('S8'), members: [members[1], members[0]] });
  const sol2 = k2.bundle ?? k2.solution;
  check(sol2.members.map((m) => m.shareCents).every((s) => Math.abs(s - 2000) <= 1),
    `换序后仍各 ¥20（实际 ${sol2.members.map((m) => '¥' + (m.shareCents / 100).toFixed(1)).join(' / ')}）`);
}

// ---------- R09 轨道回退 ----------
console.log('【R09】单点轨无解、套餐轨可行 → 以套餐轨为主方案（不得误报两轨皆无解）');
{
  const menu = { M1: { name: '巨无霸', currentPrice: '26.5' }, C2: { name: '巨无霸四件套', currentPrice: '42.0' } };
  const rounds = { C2: [
    { id: 11, name: '主食轮', choices: [{ code: 'M1', name: '巨无霸', isDefault: 1, diffPrice: '+0' }] },
    { id: 12, name: '小食轮', choices: [{ code: 'M3', name: '薯条', isDefault: 1, diffPrice: '+0' }] },
  ] };
  const client = mkClient(menu, rounds, { M1: 2650, C2: 4200 }, [row('巨无霸', 2146, 513, 27, 26, 42, 961), row('薯条', 1214, 289, 4, 15, 34, 210)]);
  let k = null, err = null;
  try { k = await solveGroupWithKernel(client, { ...STORE('S9'), members: [{ alias: '甲', wishes: ['恰好三份巨无霸'], taboos: [] }] }); }
  catch (e) { err = e; }
  check(err == null, `单点轨无解时不得误报两轨皆无解（${err ? '抛错：' + err.message : '正常返回'}）`);
  if (k) {
    const sol = k.solution;
    const burgers = sol.members[0].items.filter((i) => /巨无霸/.test(i.name)).reduce((s, i) => s + i.qty, 0);
    check(burgers === 3, `恰好三份巨无霸（实际 ${burgers}）`);
    check(sol.track === 'bundle', `主方案如实标注为套餐轨（实际 ${sol.track}）`);
    check(sol.members.reduce((s, m) => s + m.shareCents, 0) === sol.totals.paidCents, '分账守恒');
  }
}

// ---------- R10 券内数量展开 ----------
console.log('【R10】券配方 combo-ref 的 qty 展开为完整槽位（qty=1/2/3）');
{
  const fakeMenu = { items: [{ code: 'C2', name: '巨无霸四件套', isCombo: true, deconstruction: [1, 2, 3].map((i) => ({ roundName: 'r' + i, options: [] })) }], unmatched: 0, comboCount: 1, comboUnmatched: 0, table: new Map() };
  for (const q of [1, 2, 3]) {
    const n = recipeFoodUnits([{ mode: 'combo-ref', keyword: 'C2', qty: q, comboName: '巨无霸四件套' }], fakeMenu);
    check(n === 3 * q, `recipeFoodUnits(qty=${q}) = ${3 * q}（实际 ${n}）`);
  }

  const menu = { M1: { name: '巨无霸', currentPrice: '26.5' }, M3: { name: '薯条', currentPrice: '13.5' }, M5: { name: '可乐', currentPrice: '10.5' }, C2: { name: '巨无霸四件套', currentPrice: '42.0' } };
  const rounds = { C2: [
    { id: 11, name: '主食轮', choices: [{ code: 'M1', name: '巨无霸', isDefault: 1, diffPrice: '+0' }] },
    { id: 12, name: '小食轮', choices: [{ code: 'M3', name: '薯条', isDefault: 1, diffPrice: '+0' }] },
    { id: 13, name: '饮料轮', choices: [{ code: 'M5', name: '可乐', isDefault: 1, diffPrice: '+0' }] },
  ] };
  const client = mkClient(menu, rounds, { M1: 2650, M3: 1350, M5: 1050, C2: 4200 },
    [row('巨无霸', 2146, 513, 27, 26, 42, 961), row('薯条', 1214, 289, 4, 15, 34, 210), row('可乐', 616, 147, 0, 0, 37, 15)]);
  for (const q of [1, 2, 3]) {
    const voucher = {
      id: `uv-combo-q${q}`, channel: 'meituan', channelLabel: '美团团购（到店）', kind: 'combo',
      name: `整包券q${q}`, priceCents: q * 3000, originalPriceCents: 0,
      items: [{ mode: 'combo-ref', keyword: 'C2', qty: q, comboName: '巨无霸四件套' }],
      constraints: { orderType: 'instore' }, buyPath: 'x', redeemPath: 'y',
      verifiedAt: '2026-01-01', source: 'user', evidence: 'test', binding: { comboCode: 'C2' },
    };
    const members = [];
    for (let i = 0; i < q; i++) members.push({ alias: 'M' + (i + 1), wishes: ['巨无霸', '薯条', '可乐'], taboos: [] });
    const k = await solveGroupWithKernel(client, { ...STORE('S1' + q), members, userVouchers: [voucher] });
    const vt = k.voucherTrack;
    const b = vt?.basket?.find((x) => x.kind === 'voucher');
    const cfgCount = (b?.perUnitConfig ?? []).join('＋').split('＋').filter(Boolean).length;
    check(!!b && cfgCount === 3 * q, `qty=${q}：券入池且槽位配置 ${3 * q} 件（实际 ${cfgCount}）`);
    check((vt?.coverage?.met ?? 0) === 3 * q && (vt?.coverage?.total ?? 0) === 3 * q,
      `qty=${q}：券覆盖 ${3 * q}/${3 * q} 心愿（实际 ${vt?.coverage?.met}/${vt?.coverage?.total}）`);
  }
}

// ---------- R04 单人严格营养证据 ----------
console.log('【R04】单人硬约束按字段证据判断；估算值与未知字段不得按 0 达标');
{
  const oneOptionPlan = (option) => ({
    id: 'nutrition-test', channel: 'mcd-mcp', name: '测试营养餐', basePriceCents: 1000, maxQty: 1, strictCover: true,
    slots: [{ roundName: '主食', defaultName: option.name, options: [option] }],
  });
  const baseOption = { name: '测试营养餐', kcal: 300, kcalKnown: true, priceCents: 1000, diffCents: 0,
    staple: true, veggie: false, protein: 10, fat: 10, carbohydrate: 30, sodium: 100 };
  const mustHave = ['测试营养餐'];
  const knownOtherFields = await optimizeTopK({
    plans: [oneOptionPlan({ ...baseOption, unknownNutrition: ['protein'] })],
    members: [{ alias: '甲', mustHave, metrics: [{ metric: 'sodium', op: '<=', value: 150 }] }],
    mode: 'cheapest', strictSurplus: true,
  }, 1);
  check(knownOtherFields.length === 1, '仅缺蛋白质不屏蔽已知钠字段的硬约束判断');

  const unknownSodium = await optimizeTopK({
    plans: [oneOptionPlan({ ...baseOption, sodium: 0, unknownNutrition: ['sodium'] })],
    members: [{ alias: '乙', mustHave, metrics: [{ metric: 'sodium', op: '<=', value: 50 }] }],
    mode: 'cheapest', strictSurplus: true,
  }, 1);
  check(unknownSodium.length === 0, '未知钠的占位 0 不得通过钠上限');

  const estimated = await optimizeTopK({
    plans: [oneOptionPlan({ ...baseOption, sodium: 0, estimated: true })],
    members: [{ alias: '丙', mustHave, metrics: [{ metric: 'sodium', op: '<=', value: 50 }] }],
    mode: 'cheapest', strictSurplus: true,
  }, 1);
  check(estimated.length === 0, '估算钠不作为严格营养硬约束的达标证据');

  const surfaced = await optimizeTopK({
    plans: [oneOptionPlan({ ...baseOption, unknownNutrition: ['protein'], estimated: true, nutritionSource: '测试审核营养源' })],
    members: [{ alias: '丁', mustHave }], mode: 'cheapest', strictSurplus: true,
  }, 1);
  const surfacedItem = surfaced[0]?.memberAllocations[0]?.items[0];
  check(!!surfacedItem?.estimated && surfacedItem.unknownNutrition?.includes('protein') && surfacedItem.nutritionSource === '测试审核营养源',
    '成员分配输出透传估算标记、字段缺失与营养来源');

  const nutritionSupplements = await import('../dist/nutritionSupplements.js');
  nutritionSupplements.saveNutritionSupplement({
    id: 'v144-group-estimate-partial', name: '测试专属营养品XYZ', kcal: 200, protein: 3, valueKind: 'estimate',
    source: 'v1.4.4 自动回归来源', sourceType: 'user', evidence: '测试用部分字段估算数据', verifiedAt: '2025-01-01', verifiedBy: 'user',
  });
  nutritionSupplements._resetSupplementCache();
  const groupClient = mkClient({ M4: { name: '测试专属营养品XYZ', currentPrice: '5.0' } }, {}, { M4: 500 });
  const grouped = await solveGroupWithKernel(groupClient, { ...STORE('S144N'), members: [{ alias: '营养状态', wishes: ['测试专属营养品XYZ'], taboos: [] }] });
  const groupSolution = grouped.unified?.[0] ?? grouped.solution;
  const groupMemberItem = groupSolution.members[0]?.items.find((item) => item.name === '测试专属营养品XYZ');
  const groupBasketItem = groupSolution.basket.find((item) => /测试专属营养品XYZ/.test(item.name + item.perUnitConfig.join('')));
  check(!!groupMemberItem?.nutritionEstimated && groupMemberItem.nutritionUnknownFields?.includes('sodium') && !!groupMemberItem.nutritionSource,
    '多人成员品项透传估算值、缺失字段与营养来源');
  check(!!groupBasketItem?.nutritionEstimated && groupBasketItem.nutritionUnknownFields?.includes('sodium') && !!groupBasketItem.nutritionSources?.length,
    '整单购买清单透传估算值、缺失字段与营养来源');
}

console.log(failures === 0 ? '\nv1.4.4 内核回归全部通过 ✓' : `\n${failures} 项未通过 ✗`);
process.exitCode = failures === 0 ? 0 : 1;
