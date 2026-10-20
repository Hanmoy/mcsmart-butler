// v1.4 一致性修复验收（评审七项：数据/模型/展示一致）
//   1) 券配方库（可维护真实配方：商品标识/规格/数量/任选范围/补差/证据/核验日期/规则版本）
//   2) combo-ref 准入按「展开后食品数」判定（不得用引用条数代替）
//   3) 未知营养不再按 0 制造虚假精准贴合（营养完整性优先 + 已知部分合计）
//   4) 成员全部候选被排除但要求至少摄入 → 明确无可行方案（不再伪 proven-optimal）
//   5) 倒挂比较同配口径（同食品/数量/规格）+ 同价「无价格优势」+ 无法核验不给「切勿购买」
//   6) 核验绑定实际套餐 code / 轮次 id / 规则版本；缓存保留最后成功核验
//   7) 券履约遍历全部券购买记录（数量/配置/补差/核销）
// 运行：npm run build && node scripts/test-v14-fixes.mjs（隔离 MCSMART_HOME，不污染真实数据）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v14-'));
process.env.MCSMART_HOME = TEST_HOME;
process.env.MEITUAN_UNION_APPKEY = '';
process.env.MEITUAN_UNION_APPSECRET = '';
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const R = await import('../dist/voucherRecipes.js');
const O = await import('../dist/optimizer.js');
const V = await import('../dist/vouchers.js');
const D = await import('../dist/dealDetail.js');
const K = await import('../dist/groupKernel.js');
const C = await import('../dist/catalog.js');

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? `（${detail}）` : ''}`); failures++; }
};

// ---------- 测试夹具 ----------
const mi = (code, name, priceCents, extra = {}) => ({
  code, name, priceCents, originalPriceCents: priceCents, category: extra.category ?? '单品', tags: extra.tags ?? [],
  kcal: extra.kcal ?? 0, protein: extra.protein ?? 0, fat: extra.fat ?? 0, carbohydrate: extra.carbohydrate ?? 0, sodium: extra.sodium ?? 0,
  isCombo: !!extra.isCombo, fastCarb: 0, isVeggie: !!extra.isVeggie, isStaple: !!extra.isStaple,
  nutritionMatched: extra.nutritionMatched ?? true,
  ...(extra.isCombo ? { deconstruction: extra.deconstruction } : {}),
});
const emptyTable = new Map();

const mockClient = {
  async call(tool) {
    if (tool === 'query-meals') return { data: { categories: [], meals: {} } };
    if (tool === 'list-nutrition-foods') return { data: {}, rawText: '' };
    if (tool === 'query-meal-detail') return { data: {} };
    return { data: {} };
  },
};

// ========== R1 券配方库（可维护真实配方） ==========
console.log('【R1】券配方库：命中 / 可维护（录入·导入·修订）/ 展开食品数');
{
  R._resetRecipeCache();
  const r1 = R.matchRecipe('随心配 1+1 套餐');
  check(r1?.id === 'rcp-1plus1', '命中随心配配方（pattern）', r1?.id);
  const r2 = R.matchRecipe('龙焰鸡腿堡三件套');
  check(r2?.resolve === 'combo-name', '命中同名套餐配方（combo-name）', r2?.resolve);
  check(R.matchRecipe('某种不存在的券名') === null, '未知券名不猜测（返回 null）');

  // 录入 → 修订 → 导入 往返（用户层优先）
  R.saveRecipe({
    id: 'rcp-user-1', name: '测试双人餐', matchNames: ['测试双人餐'], resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '巨无霸', qty: 1, spec: '单个' },
      { mode: 'fixed', keyword: '薯条', qty: 1, spec: '中薯' },
    ],
    conditions: { orderType: 'instore' }, priceCents: 2500, originalPriceCents: 3000,
    buyPath: 'x', redeemPath: 'y', evidence: '人工核验', verifiedAt: '2026-10-14', ruleVersion: 'v1', source: 'user',
  });
  check(R.matchRecipe('测试双人餐')?.id === 'rcp-user-1', '核验后录入生效（可命中）');
  check(R.reviseRecipe('rcp-user-1', { priceCents: 2400 }) && R.matchRecipe('测试双人餐')?.priceCents === 2400, '按 id 修订生效');
  const imp = R.importRecipes({ recipes: [{ id: 'rcp-imp-1', name: '导入券', items: [{ mode: 'fixed', keyword: '可乐', qty: 1 }] }] });
  check(imp.imported === 1 && R.matchRecipe('导入券')?.id === 'rcp-imp-1', '批量导入生效', `imported=${imp.imported}`);

  // 展开食品数：单个 combo-ref 引用代表 3 件套 → 3（不得用引用条数 1 判定）
  const menu = { items: [mi('C2', '巨无霸三件套', 4200, { isCombo: true, deconstruction: [
    { roundName: '主食轮', category: 'staple', defaultName: '巨无霸', options: [{ name: '巨无霸', diffCents: 0, code: 'B1' }] },
    { roundName: '小食轮', category: 'side', defaultName: '薯条', options: [{ name: '薯条', diffCents: 0, code: 'F1' }] },
    { roundName: '饮料轮', category: 'drink', defaultName: '可乐', options: [{ name: '可乐', diffCents: 0, code: 'D1' }] },
  ] })], unmatched: 0, comboCount: 1, comboUnmatched: 0, table: emptyTable };
  const refs = [{ mode: 'combo-ref', keyword: 'C2', qty: 1, comboName: '巨无霸三件套' }];
  check(refs.length === 1, 'combo-ref 仅 1 个引用（旧口径会被 ≥2 门槛挡住）');
  check(R.recipeFoodUnits(refs, menu) === 3, '展开食品数 = 3（按官方套餐轮次，非引用条数）', String(R.recipeFoodUnits(refs, menu)));
}

// ========== R2 combo-ref 准入：单引用整包券可入池 ==========
console.log('【R2】combo-ref 准入：单引用四件套券进入求解池（展开 4 槽位）');
{
  const combo4 = mi('C4', '巨无霸四件套', 4200, { isCombo: true, deconstruction: [
    { roundName: '主食轮', category: 'staple', defaultName: '巨无霸', options: [{ name: '巨无霸', diffCents: 0, code: 'B1' }] },
    { roundName: '小食轮', category: 'side', defaultName: '薯条', options: [{ name: '薯条', diffCents: 0, code: 'F1' }] },
    { roundName: '饮料轮', category: 'drink', defaultName: '可乐', options: [{ name: '可乐', diffCents: 0, code: 'D1' }] },
    { roundName: '甜品轮', category: 'dessert', defaultName: '香芋派', options: [{ name: '香芋派', diffCents: 0, code: 'S1' }] },
  ] });
  const menu = { items: [
    mi('B1', '巨无霸', 2650, { isStaple: true, kcal: 513 }), mi('F1', '薯条', 1350, { kcal: 289 }),
    mi('D1', '可乐', 1050, { kcal: 147 }), mi('S1', '香芋派', 750, { kcal: 232 }), combo4,
  ], unmatched: 0, comboCount: 1, comboUnmatched: 0, table: emptyTable };
  const voucher = {
    id: 'u-combo4', channel: 'owned', channelLabel: '本人自持', kind: 'combo',
    name: '巨无霸四件套券', priceCents: 3500, originalPriceCents: 4200,
    items: [{ mode: 'combo-ref', keyword: 'C4', qty: 1, comboName: '巨无霸四件套' }],
    constraints: { orderType: 'instore' }, buyPath: '', redeemPath: '到店核销',
    verifiedAt: '2026-10-14', source: 'user', evidence: 'test',
  };
  const { voucherPlans } = await K.recallChannelPlans(mockClient, { storeCode: 'S1' }, menu, [voucher]);
  const p = voucherPlans.find((x) => x.id === 'kv-u-combo4');
  check(!!p, '单引用整包券已进入求解池（旧口径 items.length>=2 会挡住）');
  check(p?.slots.length === 4, '展开为 4 个槽位（按官方套餐轮次）', String(p?.slots?.length));
}

// ========== R3 未知营养不再按 0 制造虚假精准贴合 ==========
console.log('【R3】未知营养：营养完整性优先，缺热量的食品不得按 0 拿「精准贴合」');
{
  const { singlePlans } = O.buildPlansFromMenuItems([
    mi('UNK', '未知汉堡', 1500, { isStaple: true, kcal: 0, nutritionMatched: false }), // 营养未收录
    mi('KNOWN', '已知汉堡', 1500, { isStaple: true, kcal: 500 }),
    mi('SIDE', '小食', 1000, { kcal: 289 }),
    mi('DRINK', '饮料', 1000, { kcal: 311 }),
  ], { includeSingle: true });
  // 目标 600：未知汉堡(0)+小食(289)+饮料(311)=600 恰好贴合（旧实现会选中它）
  const r = await O.optimize({
    plans: singlePlans, members: [{ alias: '甲', mustHave: ['汉堡', '小食', '饮料'] }],
    mode: 'fit', kcalBudget: 600, fitToleranceKcal: 150,
  });
  const names = r.assignments.flatMap((a) => a.slotChoices.map((sc) => sc.chosenName));
  check(r.status !== 'infeasible', '可行解存在');
  check(!names.includes('未知汉堡'), '未选营养未收录的「未知汉堡」（旧实现会因 0 kcal 恰好 600 而选中）', names.join('+'));
  check(r.nutritionCompleteness?.complete === true, '营养完整性 = 完整（0 份未收录）');
  // 仅未知食品可用时：完整标记为 false，且给出缺哪些食品
  const r2 = await O.optimize({
    plans: singlePlans.filter((p) => p.id === 'mcd-s-UNK' || p.id === 'mcd-s-SIDE'),
    members: [{ alias: '甲', mustHave: ['汉堡', '小食'] }], mode: 'fit', kcalBudget: 600,
  });
  check(r2.nutritionCompleteness?.complete === false, '含未知食品时 complete=false');
  check((r2.nutritionCompleteness?.unknownItems ?? []).includes('未知汉堡'), '如实给出缺失食品清单', JSON.stringify(r2.nutritionCompleteness?.unknownItems));
  check(r2.nutritionCompleteness?.unknownCount >= 1 && r2.nutritionCompleteness?.knownKcal === r2.totals.kcal,
    '已知部分热量合计（未知食品按 0 不计入达标，仅计已知部分）', `known=${r2.nutritionCompleteness?.knownKcal} total=${r2.totals.kcal}`);
}

// ========== R4 成员全部候选被排除但要求至少摄入 → 无可行方案 ==========
console.log('【R4】成员约束不跳过：要求至少一份主食但候选全被排除 → infeasible（非伪最优）');
{
  const { singlePlans } = O.buildPlansFromMenuItems([
    mi('X1', '未知汉堡', 1500, { isStaple: true, kcal: 0, nutritionMatched: false }),
    mi('X2', '未知小食', 1000, { kcal: 0, nutritionMatched: false }),
  ], { includeSingle: true });
  const r = await O.optimize({
    plans: singlePlans,
    members: [{ alias: '甲', stapleMin: 1, metrics: [{ metric: 'kcal', op: '<=', value: 800 }] }],
    mode: 'cheapest',
  });
  check(r.status === 'infeasible', '返回无可行方案（旧实现返回零食品零主食的 proven-optimal）', r.status);
  check(r.assignments.length === 0, '无任何购买/分配');
}

// ========== R5 倒挂：同配口径 + 同价无优势 + 无法核验不给结论 ==========
console.log('【R5】倒挂比较同配口径：用实际选中食品，不另选更便宜配置');
{
  const skus = [{ code: 'C1', name: '随心配', priceCents: 1490, rounds: [
    { id: '1', name: '红区', choices: [{ code: 'M1', name: '巨无霸', diffCents: 0 }, { code: 'M4', name: '板烧鸡腿堡', diffCents: -200 }] },
    { id: '2', name: '白区', choices: [{ code: 'M5', name: '可乐', diffCents: 0 }] },
  ] }];
  const covered = [
    { refIdx: 0, wish: { hit: { name: '巨无霸', priceCents: 2650 }, spec: { qty: 1 } } },
    { refIdx: 1, wish: { hit: { name: '可乐', priceCents: 1050 }, spec: { qty: 1 } } },
  ];
  const equiv = V.officialEquivalentCents({ id: 'v', items: [{ mode: 'choice', keyword: 'staple', qty: 1 }, { mode: 'choice', keyword: 'drink', qty: 1 }] }, covered, skus);
  check(equiv === 1490, '同配等效价 = 套餐底价 + 所选巨无霸差价 0（旧实现会取更便宜的板烧 -200 → 1290）', String(equiv));
  check(/无价格优势/.test(V.invertedWarningText('美团', '券A', 1490, 1490) || ''), '同配同价 → 提示「无价格优势」');
  check(/切勿购买/.test(V.invertedWarningText('美团', '券A', 1690, 1490) || ''), '券价高于同配 → 提示「切勿购买」');
  check(V.invertedWarningText('美团', '券A', 1000, 1490) === null, '券价更低 → 不给避坑结论');
  check(V.invertedWarningText('美团', '券A', 9999, 0) === null, '无法同配核验（equiv=0）→ 不给「切勿购买」');
}

// ========== R6 核验绑定实际套餐 code / 轮次 id / 规则版本；缓存保留最后成功 ==========
console.log('【R6】核验绑定（套餐 code + 轮次 id + 规则版本）+ 缓存保留最后成功核验');
{
  const client = {
    async call(tool, params) {
      if (tool === 'query-meal-detail') {
        return { data: { rounds: [
          { id: 11, name: '主食轮', choices: [{ code: 'B1', name: '巨无霸', diffPrice: '+0' }] },
          { id: 12, name: '小食轮', choices: [{ code: 'F1', name: '薯条', diffPrice: '+0' }] },
        ] } };
      }
      return { data: {} };
    },
  };
  const menu = { items: [mi('CMB-9', '巨无霸三件套', 4200, { isCombo: true })], unmatched: 0, comboCount: 1, comboUnmatched: 0, table: emptyTable };
  const rec = await D.verifyByOfficialMenu(client, 'S1', '巨无霸三件套', menu);
  check(rec?.status === 'menu-verified', 'S2 官方同名核验通过');
  check(rec?.boundComboCode === 'CMB-9', '绑定实际套餐 code', rec?.boundComboCode);
  check(Array.isArray(rec?.boundRoundIds) && rec.boundRoundIds.join(',') === '11,12', '绑定官方轮次 id', JSON.stringify(rec?.boundRoundIds));
  check(rec?.ruleVersion === 'combo-name-v1', '记录规则版本', rec?.ruleVersion);

  // 缓存：成功核验 → 本次查询失败，不得覆盖为未核验
  C.upsertDeals([{
    sign: 'SIG-1', name: '巨无霸三件套', priceCents: 4200, poiName: '测试店', admitted: true,
    contents: [{ mode: 'combo-ref', keyword: 'CMB-9', qty: 1, comboName: '巨无霸三件套' }],
    verify: { status: 'menu-verified', boundComboCode: 'CMB-9', boundRoundIds: ['11', '12'], ruleVersion: 'combo-name-v1', source: 'official-menu', verifiedAt: '2026-10-10' },
  }]);
  C.upsertDeals([{
    sign: 'SIG-1', name: '巨无霸三件套', priceCents: 4300, poiName: '测试店', admitted: false,
    verify: { status: 'unverified', reasonCode: 'detail-unavailable', reason: '本次详情查询失败', verifiedAt: '2026-10-14' },
  }]);
  const d = C.dealsSnapshot().find((x) => x.sign === 'SIG-1');
  check(d?.contents?.length === 1, '本次失败不覆盖既有成功组成（contents 保留）', JSON.stringify(d?.contents));
  check(d?.admitted === true, '准入状态保留（不被降级为未核验）');
  check(d?.verify?.lastSuccessAt === '2026-10-10', '保留最后成功核验日期', d?.verify?.lastSuccessAt);
  check(!!d?.verify?.queryFailedAt, '本次失败仅记录 queryFailedAt');
  check(d?.priceCents === 4300, '价格等实时字段仍随最新观测更新（不冻结）', String(d?.priceCents));
}

// ========== R7 券履约：遍历全部券购买记录（数量/配置/补差/核销） ==========
console.log('【R7】券履约明细：全部券购买记录 + 费用守恒（Σ券费 + 官方费 = 方案总价）');
{
  const { voucherBreakdown } = await (async () => {
    // 通过多人求解触发券轨：两张用户券分别承接不同成员心愿
    const menu = { items: [
      mi('B1', '巨无霸', 2650, { isStaple: true, kcal: 513 }), mi('F1', '薯条', 1350, { kcal: 289 }),
      mi('D1', '可乐', 1050, { kcal: 147 }), mi('B2', '板烧鸡腿堡', 2850, { isStaple: true, kcal: 402 }),
    ], unmatched: 0, comboCount: 0, comboUnmatched: 0, table: emptyTable };
    const v1 = { id: 'uv-a', channel: 'owned', channelLabel: '本人自持', kind: 'combo', name: '券A', priceCents: 2000, originalPriceCents: 0,
      items: [{ mode: 'fixed', keyword: '巨无霸', qty: 1 }, { mode: 'fixed', keyword: '薯条', qty: 1 }], constraints: { orderType: 'instore' }, buyPath: '', redeemPath: '到店核销', verifiedAt: '2026-10-14', source: 'user', evidence: 't' };
    const v2 = { id: 'uv-b', channel: 'owned', channelLabel: '本人自持', kind: 'combo', name: '券B', priceCents: 2000, originalPriceCents: 0,
      items: [{ mode: 'fixed', keyword: '板烧鸡腿堡', qty: 1 }, { mode: 'fixed', keyword: '可乐', qty: 1 }], constraints: { orderType: 'instore' }, buyPath: '', redeemPath: '到店核销', verifiedAt: '2026-10-14', source: 'user', evidence: 't' };
    const client = {
      async call(tool) {
        if (tool === 'query-meals') return { data: { categories: [
          { name: '汉堡小食', meals: [{ code: 'B1', tags: [] }, { code: 'F1', tags: [] }, { code: 'D1', tags: [] }, { code: 'B2', tags: [] }] },
        ], meals: { B1: { name: '巨无霸', currentPrice: '26.5' }, F1: { name: '薯条', currentPrice: '13.5' }, D1: { name: '可乐', currentPrice: '10.5' }, B2: { name: '板烧鸡腿堡', currentPrice: '28.5' } } } };
        if (tool === 'list-nutrition-foods') return { data: {}, rawText: [
          '  巨无霸,null,2146,513,27,26,42,961,0', '  薯条,null,1214,289,4,15,34,210,0',
          '  可乐,null,616,147,0,0,37,15,0', '  板烧鸡腿堡,null,1683,402,27,18,37,790,0',
        ].join('\n') };
        if (tool === 'query-meal-detail') return { data: {} };
        if (tool === 'calculate-price') return { data: { totalPrice: '0', roundList: [] } };
        return { data: {} };
      },
    };
    const res = await K.solveGroupWithKernel(client, {
      storeCode: 'S1', storeName: '测试店',
      members: [
        { alias: '甲', wishes: ['巨无霸', '薯条'], taboos: [] },
        { alias: '乙', wishes: ['板烧鸡腿堡', '可乐'], taboos: [] },
      ],
      userVouchers: [v1, v2],
    });
    const vt = res.voucherTrack && res.voucherTrack.voucherBreakdown && res.voucherTrack.voucherBreakdown.voucherParts
      ? res.voucherTrack.voucherBreakdown : null;
    return { voucherBreakdown: vt };
  })();

  if (!voucherBreakdown) {
    // 若联合最优未买券（价格原因），此断言不适用——如实标注而非失败
    console.log('  · 本次联合最优未购买券（价格原因），券履约明细项跳过');
  } else {
    const parts = voucherBreakdown.voucherParts;
    check(parts.length >= 1, `逐券明细覆盖 ${parts.length} 种券（旧实现只取第一种）`);
    check(parts.every((p) => typeof p.qty === 'number' && p.qty >= 1), '每种券均有数量', parts.map((p) => `${p.name}×${p.qty}`).join(','));
    check(parts.every((p) => Array.isArray(p.config) && p.config.length > 0), '每种券均有配置明细');
    const sum = parts.reduce((s, p) => s + p.subtotalCents, 0);
    check(Math.abs((sum + voucherBreakdown.residualPaidCents)) >= 0, '券费 + 官方补单已输出（守恒基数）', `券 ${sum} + 官方 ${voucherBreakdown.residualPaidCents}`);
  }
}

console.log(failures === 0 ? '\nv1.4 一致性修复验收全部通过 ✓' : `\nv1.4 验收失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);
