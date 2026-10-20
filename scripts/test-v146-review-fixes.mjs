// v1.4.6 评审修复回归（R01/R02/R04/R05/R06/R07/R08/R09/R15/R16）
// 运行：npm test 或 node scripts/test-v146-review-fixes.mjs（需先 tsc）
//
// 这些用例对应 2026-10-17 审查报告里**已复现**的反例；断言的是行为，不是实现细节：
//   R01 固定券不得继承官方套餐换选减价（券价只含券面有依据的补差）
//   R02 同食品不同渠道/券 code 只占一个推荐名额，购买途径并列
//   R04 同轮同名不同 code 的选项聚合不得吞掉身份与热量
//   R05 官方两轨无解但券轨可行时返回券方案（不得误报无解）
//   R06 用户层条目若被用户删减/缩窄，种子更新不得把它「恢复」回去（用户数据优先）；
//       仅当条目与种子同源且无用户改动时，才按种子归正
//   R07 灰焰构成证据可复用（缺当前官方菜单仍可解析）+ 早餐券无证据时保持未核验
//   R08 券面星期/餐段规则进入「当前可核销」判定
//   R09 缺城市的旧价格记录不得跨城进入断网快照
//   R15 官方 SKU 空轮次不得被静默删除（宁可不入池，不可少给食品）
//   R16 推荐标记与比价决策同源（不再出现「决策说官方、页面标券」）
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v146-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

// R06 前置：先写入用户层副本（rcp-fandazi-4 的 B 区只剩 6 项，用户删掉了「无糖中可乐」），再加载配方库
const NARROWED_COPY = {
  id: 'rcp-fandazi-4',
  name: '【双人食】小食4件自由拼',
  matchNames: ['【双人食】小食4件自由拼', '【饭搭子一起吃】小食4件自由拼'],
  resolve: 'explicit', channel: 'meituan', channelLabel: '美团团购（到店）',
  items: [
    { mode: 'choice', keyword: 'A区肉食/中薯4选2可重复', qty: 2, spec: 'A区4选1', choiceRange: ['麦辣鸡翅', '酥脆带骨里脊', '麦乐鸡', '中薯条'] },
    { mode: 'choice', keyword: 'B区饮品/甜品7选2可重复', qty: 2, spec: 'B区7选1', choiceRange: ['中可乐', '中雪碧', '锡兰红茶', '圆筒冰淇淋', '香芋派', '菠萝派'] },
  ],
  conditions: { orderType: 'instore', noStack: true, noPoints: true },
  priceCents: 2780, originalPriceCents: 0,
  buyPath: 'x', redeemPath: 'y',
  evidence: '截图 Image 50 官方备注实证：A区4选2可重复（辣翅/里脊/麦乐鸡/中薯） + B区7选2可重复（中可/无糖中可/中雪碧/红茶/圆筒/香芋派/菠萝派）',
  verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'user',
};
writeFileSync(join(TEST_HOME, 'voucher-recipes.json'), JSON.stringify({
  version: 1, updatedAt: '2026-10-14T00:00:00.000Z',
  recipes: [NARROWED_COPY],
}, null, 1), 'utf-8');

const { solveGroupWithKernel, voucherSlots, unifyCandidates, augmentComboPlans } = await import('../dist/groupKernel.js');
const { optimize } = await import('../dist/optimizer.js');
const { loadRecipes, recipeToVoucher, PRESET_RECIPES, _resetRecipeCache } = await import('../dist/voucherRecipes.js');
const { verifyByRecipe, verifyDealContents } = await import('../dist/dealDetail.js');
const { redeemWindowStatus } = await import('../dist/redeemWindow.js');
const { upsertDeals, dealsSnapshot } = await import('../dist/catalog.js');
const { renderGroupText } = await import('../dist/present.js');
const { readFileSync } = await import('node:fs');

let failures = 0;
const check = (cond, label) => { if (cond) console.log(`  ✓ ${label}`); else { console.error(`  ✗ ${label}`); failures++; } };

const item = (code, name, priceCents, kcal = 300) => ({
  code, name, priceCents, originalPriceCents: priceCents, category: '主食', tags: [],
  kcal, protein: 10, fat: 10, carbohydrate: 30, sodium: 400,
  isCombo: false, fastCarb: 0, isVeggie: false, isStaple: true, nutritionMatched: true,
});
const emptyMenu = () => ({ items: [], unmatched: 0, comboCount: 0, comboUnmatched: 0, table: new Map() });

// ---------- R01 ----------
console.log('【R01】券价不继承官方换选减价');
{
  const menu = { ...emptyMenu(), items: [item('H1', '麦香鸡', 2000, 400), item('P1', '香芋派', 1000, 250)] };
  const sku = {
    code: 'SKU1', name: '随心配 1+1', priceCents: 1390,
    rounds: [
      { id: 'r1', name: '红区', choices: [{ code: 'H1', name: '麦香鸡', diffCents: -100 }] },
      { id: 'r2', name: '白区', choices: [{ code: 'P1', name: '香芋派', diffCents: 0 }] },
    ],
  };
  const voucher = {
    id: 'union-v1', channel: 'meituan', channelLabel: '美团团购（到店）', kind: 'combo',
    name: '随心配 1+1 套餐券', priceCents: 1390, originalPriceCents: 1490,
    items: [{ mode: 'choice', keyword: 'staple', qty: 1 }, { mode: 'choice', keyword: 'white', qty: 1 }],
    constraints: { orderType: 'instore' }, buyPath: '', redeemPath: '',
    verifiedAt: '2026-10-17', source: 'preset', evidence: '',
    binding: { comboCode: 'SKU1' },
  };
  const slots = voucherSlots(voucher, menu, [sku]);
  const chicken = slots?.[0]?.options?.[0];
  check(!!slots && chicken?.diffCents === 0, `券槽位不加官方差价（diffCents=${chicken?.diffCents}，期望 0）`);
  check(chicken?.officialDiffCents === -100, `官方差价作为证据保留（officialDiffCents=${chicken?.officialDiffCents}）`);

  const plan = {
    id: 'kv-v1', channel: 'meituan-cps', name: voucher.name, basePriceCents: 1390,
    maxQty: 1, maxQtySource: 'voucher-limit', isExternalCoupon: true, strictCover: true, slots,
  };
  const member = { alias: '我', demands: [{ id: 'd1', keyword: '麦香鸡', qty: 1 }] };
  const tight = await optimize({ plans: [plan], members: [member], mode: 'cheapest', totalBudgetCents: 1300 });
  check(tight.totals.priceCents === 0 && !tight.assignments.some((a) => a.qty > 0),
    `1300 分预算不可选 1390 分券（实付=${tight.totals.priceCents}，购买项=${tight.assignments.filter((a) => a.qty > 0).length}）`);
  const ok = await optimize({ plans: [plan], members: [member], mode: 'cheapest', totalBudgetCents: 1400 });
  check(ok.status !== 'infeasible' && ok.totals.priceCents === 1390, `券总价 = 购券价 1390（实际 ${ok.totals.priceCents}）`);
}

// ---------- R04 ----------
console.log('【R04】同轮同名不同 code 的选项聚合保留身份与热量');
{
  const plan = {
    id: 'mcd-C9', channel: 'mcd-mcp', name: '双槽同名套餐', basePriceCents: 1000, maxQty: 1,
    slots: [
      { roundName: '小食', options: [{ name: '小食', kcal: 300, priceCents: 0, diffCents: 0, staple: false, veggie: false, code: 'S1', protein: 1, fat: 1, carbohydrate: 1, sodium: 1 }] },
      { roundName: '小食', options: [{ name: '小食', kcal: 500, priceCents: 0, diffCents: 100, staple: false, veggie: false, code: 'L1', protein: 2, fat: 2, carbohydrate: 2, sodium: 2 }] },
    ],
  };
  const r = await optimize({ plans: [plan], members: [{ alias: '我', demands: [{ id: 'd1', keyword: '小食', qty: 1 }] }], mode: 'cheapest', totalBudgetCents: 5000 });
  const scs = r.assignments[0]?.slotChoices ?? [];
  check(scs.length === 2, `两个同名不同 code 的选项不被合并（slotChoices=${scs.length}）`);
  check(r.totals.kcal === 800, `热量合计 300+500=800（实际 ${r.totals.kcal}）`);
  check(r.totals.priceCents === 1100, `条目金额 1000+100=1100（实际 ${r.totals.priceCents}）`);
}

// ---------- R15 ----------
console.log('【R15】官方 SKU 空轮次不缩水入池');
{
  const skus = [{
    code: 'SKU3', name: '三件套', priceCents: 2000,
    rounds: [
      { id: 'a', name: '主食', choices: [{ code: 'a1', name: '测试堡', diffCents: 0 }] },
      { id: 'b', name: '小食', choices: [{ code: 'b1', name: '测试薯', diffCents: 0 }] },
      { id: 'c', name: '饮料', choices: [{ code: 'c1', name: '', diffCents: 0 }] },
    ],
  }];
  const out = augmentComboPlans([], skus, emptyMenu());
  check(!out.plans.some((p) => p.id === 'mcd-SKU3'), '第三轮无可用选项 → 整套不入池（不缩成两件餐）');
  check(out.skipped.length === 1 && /饮料/.test(out.skipped[0].reason), `记录跳过原因（${out.skipped[0]?.reason ?? '无'}）`);
}

// ---------- R02 ----------
console.log('【R02】同食品不同券只占一个名额，购买途径并列');
{
  const mk = (code, paid, priceSource) => ({
    track: 'voucher', store: { storeCode: 'S', storeName: 'S' },
    members: [], orderNotes: [], warnings: [], disclaimer: '',
    coverage: { total: 1, met: 1 }, solveState: 'proven-optimal', kernel: 'milp-v6',
    gapTotal: 0, alternatives: [],
    basket: [{ kind: 'voucher', code, name: '随心配 1+1', qty: 1, refPriceCents: paid, perUnitConfig: ['麦香鸡＋香芋派'], channelLabel: '美团团购（到店）' }],
    totals: { originalCents: 2000, paidCents: paid, discountCents: 0, priceSource, priceNote: '' },
    trackNote: '',
  });
  const a = mk('kv-union-1', 1390, 'mixed');
  const b = mk('kv-kb-1', 1390, 'mixed');
  const c = mk('kv-union-2', 1290, 'mixed');
  const unified = unifyCandidates([a, b, c]);
  check(unified.length === 1, `同内容三张券只保留一个方案（unified=${unified.length}）`);
  check(unified[0].totals.paidCents === 1290, `保留更低实付的购买途径（${unified[0].totals.paidCents}）`);
  check((unified[0].purchaseOptions ?? []).length === 2, `购买途径并列（${(unified[0].purchaseOptions ?? []).length} 条）`);
}

// ---------- R05 ----------
console.log('【R05】官方两轨无解但券轨可行');
{
  const menu = { ...emptyMenu(), items: [item('B1', '测试堡', 1000, 500)] };
  const client = {
    async call(tool) {
      if (tool === 'query-meals') return { data: { categories: [{ name: '汉堡小食', meals: [{ code: 'B1', tags: [] }] }], meals: { B1: { name: '测试堡', currentPrice: '10.0' } } } };
      if (tool === 'list-nutrition-foods') return { data: {}, rawText: '  测试堡,null,2092,500,20,20,50,600,0' };
      if (tool === 'calculate-price') return { data: { price: 3000, discount: 0 } };
      throw new Error('mock 未实现：' + tool);
    },
  };
  const voucher = {
    id: 'user-3', channel: 'owned', channelLabel: '本人自持', kind: 'combo',
    name: '三堡券', priceCents: 1290, originalPriceCents: 3000,
    items: [{ mode: 'fixed', keyword: '测试堡', qty: 3 }],
    constraints: { orderType: 'instore' }, buyPath: '', redeemPath: '',
    verifiedAt: '2026-10-17', source: 'user', evidence: '',
  };
  let err = null;
  let k = null;
  try {
    k = await solveGroupWithKernel(client, { storeCode: 'S146', storeName: '测试门店', members: [{ alias: '甲', wishes: ['恰好 3 份 测试堡'], taboos: [] }], userVouchers: [voucher] });
  } catch (e) { err = e; }
  check(!err, `官方两轨无解时不抛错（${err ? err.message : 'ok'}）`);
  check(!!k && k.solution.track === 'voucher', `主方案如实标注券渠道（track=${k?.solution?.track}）`);
  check(!!k && k.solution.totals.paidCents === 1290, `券方案实付 1290（${k?.solution?.totals?.paidCents}）`);
}

// ---------- R16 ----------
console.log('【R16】推荐标记与决策同源');
{
  const base = {
    store: { storeCode: 'S', storeName: 'S' }, members: [], orderNotes: [], warnings: [], disclaimer: '',
    coverage: { total: 1, met: 1 }, solveState: 'proven-optimal', kernel: 'milp-v6', gapTotal: 0, alternatives: [],
    basket: [], trackNote: '',
  };
  const voucherSol = { ...base, track: 'voucher', totals: { originalCents: 0, paidCents: 950, discountCents: 0, priceSource: 'mixed', priceNote: '' } };
  const officialSol = { ...base, track: 'bundle', totals: { originalCents: 0, paidCents: 1000, discountCents: 0, priceSource: 'calculate-price', priceNote: '' } };
  const out = {
    solution: officialSol, bundle: officialSol, voucherTrack: voucherSol,
    decision: { winner: 'tie-official', label: '官方渠道（基本持平）', reason: '差价在判平阈值内', deltaCents: 50, thresholdCents: 100 },
    unified: [voucherSol, officialSol], recommendedIndex: 1,
    channelDiagnostics: undefined,
  };
  const text = renderGroupText(out);
  const recLine = text.split('\n').find((l) => l.includes('← 推荐')) ?? '';
  check(/方案 2\//.test(recLine), `推荐标记落在决策选中的方案上（${recLine.slice(0, 40)}）`);
  check(!/方案 1\/.*← 推荐/.test(text), '最便宜的券方案不再被误标为推荐');
}

// ---------- R08 ----------
console.log('【R08】券面星期/餐段规则');
{
  // 用本地时间构造，避免 CI（UTC）把 +08:00 的绝对时刻换算成 00:00 后误判餐段。
  const sat0800 = new Date(2026, 9, 17, 8, 0, 0);
  const sat2000 = new Date(2026, 9, 17, 20, 0, 0);
  check(redeemWindowStatus({ name: '芝香脆鸡扒堡早餐两件套【仅周二可核销】' }, sat0800).ok === false, '周六不可核销「仅周二」券');
  check(redeemWindowStatus({ name: '火腿扒堡早餐两件套【仅周一&周五可核销】' }, sat0800).ok === false, '周六不可核销「周一&周五」券');
  check(redeemWindowStatus({ name: '高达芝士蛋堡早餐两件套【仅周三可核销】' }, sat0800).ok === false, '周六不可核销「仅周三」券');
  check(redeemWindowStatus({ name: '早餐两件套' }, sat2000).ok === false, '晚间不可核销早餐券');
  check(redeemWindowStatus({ name: '早餐两件套' }, sat0800).ok === true, '早餐时段可核销早餐券');
  check(redeemWindowStatus({ name: '随心配 1+1 套餐券' }, sat2000).ok === true, '无时段证据的券不被误杀');
}

// ---------- R09 ----------
console.log('【R09】缺城市记录不跨城进入快照');
{
  upsertDeals([
    { sign: 'NOCITY_1', name: '圆筒四重奏', priceCents: 1500, poiName: '麦当劳', admitted: true, saleStatus: true },
    { sign: 'SH_1', name: '上海限定券', priceCents: 1800, poiName: '麦当劳', city: '上海', admitted: true, saleStatus: true },
  ]);
  const sh = dealsSnapshot(undefined, '上海').map((d) => d.sign);
  const hf = dealsSnapshot(undefined, '合肥').map((d) => d.sign);
  check(sh.includes('SH_1'), '同城记录保留');
  check(!sh.includes('NOCITY_1'), '缺城市记录不进入上海自动候选');
  check(!hf.includes('NOCITY_1') && !hf.includes('SH_1'), '缺城市与异地记录都不进入合肥自动候选');
}

// ---------- R06 ----------
console.log('【R06】用户缩窄的任选范围不被种子恢复（v1.4.7 口径：用户修订优先）');
{
  const rec = loadRecipes().find((r) => r.id === 'rcp-fandazi-4');
  const range = rec?.items?.find((i) => /B区/.test(i.keyword))?.choiceRange ?? [];
  check(range.length === 6, `B 区保持用户缩窄后的 6 项（实际 ${range.length}：${range.join('/')}）`);
  check(!range.includes('无糖中可乐'), '用户删掉的「无糖中可乐」不被种子迁移恢复');

  // 对照：同源副本仅条目顺序不同（无新增/删减/缩窄）→ 仍按种子归正，迁移路径没有被关死
  const preset = PRESET_RECIPES.find((r) => r.id === 'rcp-fandazi-4');
  const sameContent = { ...NARROWED_COPY, items: [...(preset?.items ?? [])].reverse() };
  writeFileSync(join(TEST_HOME, 'voucher-recipes.json'), JSON.stringify({
    version: 1, updatedAt: '2026-10-14T00:00:00.000Z', recipes: [sameContent],
  }, null, 1), 'utf-8');
  _resetRecipeCache();
  const after = loadRecipes().find((r) => r.id === 'rcp-fandazi-4');
  check(JSON.stringify(after?.items) === JSON.stringify(preset?.items), '同源副本仅顺序不同 → 按种子顺序归正（迁移仍生效）');
}

// ---------- R07 ----------
console.log('【R07】灰焰构成可复用 + 早餐券身份对账口径');
{
  // ① 灰焰：已有构成证据必须真正落地——**缺当前官方菜单**时仍能解析，且营养按估算合计
  const rec = loadRecipes().find((r) => r.id === 'rcp-huiyan-yuantong-2');
  check(!!rec, '灰焰配方在库（rcp-huiyan-yuantong-2）');
  const noMenu = emptyMenu();
  const vrec = await verifyByRecipe(null, 'X', rec?.name ?? '', noMenu, rec);
  const contents = vrec.contents ?? [];
  check(vrec.status === 'pattern-verified' && contents.length === 1 && contents[0].qty === 2,
    `无官方菜单仍解析为 2 件（status=${vrec.status}，items=${contents.length}）`);
  check(contents[0]?.fulfillCode === '521951', `构成绑定官方 code 521951（实际 ${contents[0]?.fulfillCode}）`);
  const hv = recipeToVoucher(rec, 750);
  const hvSlots = voucherSlots(hv, noMenu, []);
  const hvKcal = (hvSlots ?? []).reduce((s, sl) => s + (sl.options[0]?.kcal ?? 0), 0);
  check((hvSlots ?? []).length === 2 && hvKcal === 220, `普通目标营养合计参考 220 kcal（实际 ${hvKcal}）`);
  check((hvSlots ?? []).every((sl) => sl.options[0]?.estimated === true), '估算值保留 estimated 标记（不参与热量硬约束）');

  // ② 早餐六个身份：没有证据就保持未核验（对账口径 = 券名+skuViewId，不靠券名猜「两件套」构成）
  const breakfastNames = [
    '高达芝士蛋堡早餐两件套【仅周三可核销】',
    '芝香脆鸡扒堡早餐两件套【仅周二可核销】',
    '火腿扒堡早餐两件套【仅周一&周五可核销】',
    '大脆鸡扒堡早餐两件套【仅周四可核销】',
  ];
  for (const name of breakfastNames) {
    const r = await verifyDealContents(null, 'X', { name }, noMenu, '合肥');
    check(r.status === 'unverified' && r.reasonCode === 'detail-unavailable',
      `${name} 保持未核验（${r.reasonCode}）`);
    check(!(r.contents ?? []).length, `${name} 未凭空补构成`);
  }
  // 对照：同样缺菜单，但券面构成有配方证据的券必须能核验（证明拦截的是证据缺口，不是品类）
  const covered = await verifyDealContents(null, 'X', { name: '灰焰圆筒第二份半价' }, noMenu, '合肥');
  check(covered.status !== 'unverified', `同为空菜单，灰焰券仍核验通过（${covered.status}）`);
}

// ---------- R03（静态契约守卫） ----------
console.log('【R03】单份券展示契约');
{
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf-8');
  check(html.includes('it.units.length > 0'), '前端只要存在逐份配置就展示（units.length > 0）');
  check(!html.includes('it.units.length > 1'), '不再以 units.length > 1 作为展示条件');
}

console.log('');
if (failures > 0) { console.error(`v1.4.6 评审修复回归：${failures} 项失败`); process.exit(1); }
console.log('v1.4.6 评审修复回归：全部通过');
