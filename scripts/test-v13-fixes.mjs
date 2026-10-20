// v1.3 修复轮 · 针对性回归（模拟域，确定性）：8 项修复逐项验证
// 运行：node scripts/test-v13-fixes.mjs（在 npm test 之后、真实联网验收之前）
import { optimize, optimizeTopK, buildPlansFromMenuItems } from '../dist/optimizer.js';
import { unifyCandidates } from '../dist/groupKernel.js';
import { parseCouponItems } from '../dist/unionClient.js';
import { parseDealPattern, meituanCityId, verifyDealContents } from '../dist/dealDetail.js';
import { upsertDeals, dealsSnapshot } from '../dist/catalog.js';

let failures = 0;
const check = (cond, label, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}${detail !== undefined ? `（实际 ${JSON.stringify(detail)}）` : ''}`); failures++; }
};

// ---- 测试工具 ----
const single = (id, name, priceYuan, kcal, extra = {}) => ({
  id, channel: 'mcd-mcp', name, basePriceCents: Math.round(priceYuan * 100), maxQty: extra.maxQty ?? 3,
  slots: [{ roundName: extra.round ?? '主项', defaultName: name, options: [{
    name, kcal, kcalKnown: extra.kcalKnown !== false, priceCents: Math.round(priceYuan * 100), diffCents: 0,
    staple: !!extra.staple, veggie: !!extra.veggie, code: extra.code, fastCarb: extra.fastCarb ?? 0, drink: !!extra.drink,
    ...(extra.nonFood ? { nonFood: true } : {}), protein: extra.protein ?? 0, fat: extra.fat ?? 0, carbohydrate: extra.carbohydrate ?? 0, sodium: extra.sodium ?? 0,
  }] }],
});
// 两槽套餐（主食槽 + 饮料槽）
const combo2 = (id, name, priceYuan, stapleName, drinkName) => ({
  id, channel: 'mcd-mcp', name, basePriceCents: Math.round(priceYuan * 100), maxQty: 3,
  slots: [
    { roundName: '主食', defaultName: stapleName, options: [{ name: stapleName, kcal: 500, kcalKnown: true, priceCents: 1500, diffCents: 0, staple: true, code: stapleName + '-C' }] },
    { roundName: '饮料', defaultName: drinkName, options: [{ name: drinkName, kcal: 200, kcalKnown: true, priceCents: 800, diffCents: 0, drink: true, code: drinkName + '-C' }] },
  ],
});

console.log('【V1】券含两份汉堡一杯饮料：qty 完整保留（旧实现建模后只剩一份）');
{
  // 券方案：fixed 引用 qty=2 汉堡 + qty=1 可乐（经 voucherSlots 展开为 3 槽）
  const burgerOpt = single('x', '麦辣堡', 20, 550, { staple: true, code: 'MB1' }).slots[0].options[0];
  const drinkOpt = single('x', '可乐', 8, 200, { drink: true, code: 'DK1' }).slots[0].options[0];
  const voucherPlan = {
    id: 'kv-test-2burger', channel: 'meituan-cps', name: '双堡套餐券', basePriceCents: 3000, maxQty: 1,
    strictCover: true, isExternalCoupon: true,
    slots: [
      { roundName: '汉堡', defaultName: '麦辣堡', options: [burgerOpt] },
      { roundName: '汉堡', defaultName: '麦辣堡', options: [burgerOpt] },
      { roundName: '饮料', defaultName: '可乐', options: [drinkOpt] },
    ],
  };
  const r = await optimize({
    plans: [voucherPlan],
    members: [{ alias: '我', demands: [{ id: 'w1', keyword: '麦辣堡', code: 'MB1', qty: 1 }] }],
    mode: 'cheapest',
  });
  const asg = r.assignments[0];
  const burgerCount = asg?.slotChoices.filter((sc) => sc.chosenName === '麦辣堡').reduce((s, sc) => s + sc.count, 0) ?? 0;
  const drinkCount = asg?.slotChoices.filter((sc) => sc.chosenName === '可乐').reduce((s, sc) => s + sc.count, 0) ?? 0;
  check(burgerCount === 2, `汉堡 2 份保留（实际 ${burgerCount}）`);
  check(drinkCount === 1, `可乐 1 份保留（实际 ${drinkCount}）`);
  check(asg?.qty === 1, `券整包 ×1（实际 ${asg?.qty}）`);
  check(r.memberAllocations[0].items.filter((i) => i.itemName === '麦辣堡').reduce((s, i) => s + i.qty, 0) === 2, '两份汉堡全数分配给成员（strictCover）');
}

console.log('【V2】无候选需求：软需求计完整缺口；硬需求判不可行');
{
  // 软需求：心愿「麦香鱼」但候选池无该品项 → gap=1，空购物篮不再伪装缺口 0
  const r1 = await optimize({
    plans: [single('d1', '可乐', 5, 200, { drink: true, code: 'D1' })],
    members: [{ alias: '甲', demands: [{ id: 'w1', keyword: '麦香鱼', code: 'FISH1', qty: 1 }] }],
    mode: 'cheapest',
  });
  check(r1.status !== 'infeasible', '软需求无候选不致命（可行解仍在）', r1.status);
  check(r1.gapTotal === 1, `软需求无候选 → 完整缺口 1（实际 ${r1.gapTotal}）`);
  check(r1.unmetDemands.some((u) => u.keyword === '麦香鱼' && u.reason === 'no-candidate'), 'unmetDemands 显式记录');
  // 硬需求：必须麦香鱼 → 不可行
  const r2 = await optimize({
    plans: [single('d1', '可乐', 5, 200, { drink: true, code: 'D1' })],
    members: [{ alias: '甲', demands: [{ id: 'w1', keyword: '麦香鱼', code: 'FISH1', qty: 1, must: true }] }],
    mode: 'cheapest',
  });
  check(r2.status === 'infeasible', `硬需求无候选 → 不可行（实际 ${r2.status}）`);
  // 对照：无候选的空篮不再排在完整方案前（gap 字典序把有候选方案排前）
  const fish = single('f1', '麦香鱼', 12, 380, { staple: true, code: 'FISH1' });
  const r3 = await optimize({
    plans: [single('d1', '可乐', 5, 200, { drink: true, code: 'D1' }), fish],
    members: [{ alias: '甲', demands: [{ id: 'w1', keyword: '麦香鱼', code: 'FISH1', qty: 1 }] }],
    mode: 'cheapest',
  });
  check(r3.gapTotal === 0 && r3.assignments.some((a) => a.planId === 'f1'), '有候选时需求被满足（缺口 0）');
}

console.log('【V3】恰好一份两槽套餐：按完整套餐份数判断（旧实现把两槽相加输出 2 份且判不满足）');
{
  const plan = combo2('cb1', '双拼套餐', 22, '麦辣堡', '可乐');
  const r = await optimize({
    plans: [plan],
    members: [{ alias: '我', demands: [{ id: 'w1', keyword: '双拼套餐', comboPlanId: 'cb1', qty: 1, exact: true }] }],
    mode: 'cheapest',
  });
  const d = r.memberAllocations[0].demands[0];
  check(d.satisfied === true, `恰好 1 份套餐已满足（实际 satisfied=${d.satisfied}）`);
  check(d.claimed === 1, `按完整份数计 1（实际 claimed=${d.claimed}，旧实现为 2）`);
  const r2 = await optimize({
    plans: [plan],
    members: [{ alias: '我', demands: [{ id: 'w1', keyword: '双拼套餐', comboPlanId: 'cb1', qty: 2, exact: true }] }],
    mode: 'cheapest',
  });
  const d2 = r2.memberAllocations[0].demands[0];
  check(d2.claimed === 2, `两份套餐 claimed=2（实际 ${d2.claimed}）`);
  check(d2.satisfied === true, `两份已满足（实际 ${d2.satisfied}）`);
}

console.log('【V4】热量目标与硬上限分离：600 目标下 610 不被硬上限排除');
{
  // 同价两选项：580 与 610，目标 600 → 610 更近（偏差 10 < 20）
  const mk = (name, kcal) => single('s-' + name, name, 20, kcal, { staple: true, code: name });
  const r = await optimize({
    plans: [mk('甲餐', 580), mk('乙餐', 610)],
    members: [{ alias: '我' }],
    mode: 'fit', kcalBudget: 600,
  });
  const chosen = r.assignments[0]?.planId;
  check(chosen === 's-乙餐', `目标 600 → 选更近的 610（实际 ${chosen}，旧实现硬上限会把 610 排除）`);
  check(r.totals.kcal === 610, `整桌热量 610（实际 ${r.totals.kcal}）`);
  // 用户显式设置硬上限 kcal<=550 + 必须就餐 → 610 被排除、580 也不可行 → 不可行（上限语义真实生效）
  const r2 = await optimize({
    plans: [mk('甲餐', 580), mk('乙餐', 610)],
    members: [{ alias: '我', kcalCap: 550, demands: [{ id: 'w1', keyword: '甲餐', code: '甲餐', qty: 1, must: true }] }],
    mode: 'fit', kcalBudget: 600,
  });
  check(r2.status === 'infeasible', `显式硬上限 550 时两选项均超 → 不可行（实际 ${r2.status}）`);
  // 对照：无硬上限（仅主食约束）→ 610 可行且被选中（目标≠上限）
  const r3 = await optimize({
    plans: [mk('甲餐', 580), mk('乙餐', 610)],
    members: [{ alias: '我', stapleMin: 1 }],
    mode: 'fit', kcalBudget: 600,
  });
  check(r3.status !== 'infeasible' && r3.assignments[0]?.planId === 's-乙餐', `无硬上限时 610 可行且更贴近目标（实际 ${r3.assignments[0]?.planId}）`);
}

console.log('【V5】声明必须以实际分配为支撑：营养受限成员不能空手满足需求');
{
  // 品项营养未收录（kcalKnown=false），成员带 ≤ 型营养约束 → 不得分配该品项，
  // 需求声明变量即使存在也必须为 0 → 需求不满足（旧实现声明变量绕过分配约束 → 假满足）
  const unknownItem = single('u1', '神秘新品', 10, 0, { kcalKnown: false, code: 'UNK1' });
  const r = await optimize({
    plans: [unknownItem],
    members: [{ alias: '我', metrics: [{ metric: 'sodium', op: '<=', value: 500 }], demands: [{ id: 'w1', keyword: '神秘新品', code: 'UNK1', qty: 1 }] }],
    mode: 'cheapest',
  });
  const d = r.memberAllocations[0].demands[0];
  check(r.memberAllocations[0].items.length === 0, `无实际分配（实际 ${r.memberAllocations[0].items.length} 项）`);
  check(d.satisfied === false && d.claimed === 0, `需求不满足且声明=0（实际 claimed=${d.claimed}, satisfied=${d.satisfied}）`);
  check(r.unmetDemands.some((u) => u.keyword === '神秘新品'), '缺口如实输出');
}

console.log('【V6】Top-K：数量扩展保留（1×A 后 2×A 可达）；玩具变体不占搜索轮次');
{
  // 场景 A：1×A(¥15) → 2×A(¥30) 与 1×B(¥25) 都是合法次优——旧实现 sel 割会把 2×A 连带排除
  const burger = single('a1', '汉堡A', 15, 500, { staple: true, code: 'A1' });
  const chicken = single('b1', '鸡腿堡B', 25, 480, { staple: true, code: 'B1' });
  const rs = await optimizeTopK({
    plans: [burger, chicken],
    members: [{ alias: '我', stapleMin: 1 }],
    mode: 'cheapest', strictSurplus: true,
  }, 3);
  const sigs = rs.map((r) => r.assignments.map((a) => `${a.planId}×${a.qty}`).sort().join('|'));
  check(sigs.includes('a1×1'), `首解 1 份汉堡（实际 ${sigs.join(', ')}）`);
  check(sigs.includes('b1×1'), `换品解可达（实际 ${sigs.join(', ')}）`);
  check(sigs.includes('a1×2'), `数量扩展解可达（实际 ${sigs.join(', ')}）——旧实现被 sel 割排除`);
  check(new Set(sigs).size === sigs.length, `无重复签名（${sigs.join(', ')}）`);
  check(rs.map((r) => r.totals.priceCents).every((p, i, arr) => i === 0 || p >= arr[i - 1]), '按价格升序');

  // 场景 B：玩具变体不占名额/轮次——同套餐换玩具不构成新购物篮
  const toyPlan = {
    id: 'a2', channel: 'mcd-mcp', name: '汉堡A玩具装', basePriceCents: 1700, maxQty: 2,
    slots: [
      { roundName: '主项', defaultName: '汉堡A', options: [{ name: '汉堡A', kcal: 500, kcalKnown: true, priceCents: 1700, diffCents: 0, staple: true, code: 'A1' }] },
      { roundName: '玩具', defaultName: '玩具α', options: [
        { name: '玩具α', kcal: 0, kcalKnown: true, priceCents: 0, diffCents: 0, staple: false, veggie: false, code: 'T1', nonFood: true },
        { name: '玩具β', kcal: 0, kcalKnown: true, priceCents: 0, diffCents: 0, staple: false, veggie: false, code: 'T2', nonFood: true },
      ] },
    ],
  };
  const rs2 = await optimizeTopK({
    plans: [burger, toyPlan, chicken],
    members: [{ alias: '我', stapleMin: 1 }],
    mode: 'cheapest', strictSurplus: true,
  }, 3);
  const sigs2 = rs2.map((r) => r.assignments.map((a) => `${a.planId}×${a.qty}`).sort().join('|'));
  check(new Set(sigs2).size === sigs2.length, `玩具变体去重后无重复（${sigs2.join(', ')}）`);
  check(sigs2.filter((s) => s.startsWith('a2×')).length <= 1, `玩具套餐只占一个名额（实际 ${sigs2.filter((s) => s.startsWith('a2×')).length}）`);
  check(rs2.length === 3, `搜索预算未被玩具变体耗尽（返回 ${rs2.length}/3）`);
}

console.log('【V7】跨轨合并：同购物篮保留有效核价（旧实现保留先到的模型价）');
{
  const mkSol = (track, priceSource, paidCents) => ({
    store: { storeCode: 'X', storeName: 'X' }, track, trackNote: '', members: [], orderNotes: [],
    totals: { originalCents: paidCents, paidCents, discountCents: 0, priceSource, priceNote: '' },
    deliveryFeeCents: 0, warnings: [], disclaimer: '', coverage: { total: 1, met: 1 },
    solveState: 'proven-optimal', kernel: 'milp-v6', gapTotal: 0, alternatives: [],
    basket: [{ kind: 'combo', code: 'C1', name: '套餐', qty: 1, refPriceCents: paidCents, perUnitConfig: ['主＋饮'], channelLabel: '官方 App' }],
  });
  const modelFirst = mkSol('bundle', 'menu-price', 2000);
  const quotedLater = mkSol('voucher', 'calculate-price', 1500);
  const merged = unifyCandidates([modelFirst, quotedLater]);
  check(merged.length === 1, `同篮去重为 1（实际 ${merged.length}）`);
  check(merged[0].totals.priceSource === 'calculate-price' && merged[0].totals.paidCents === 1500, `保留核价 ¥15（实际 ${merged[0].totals.priceSource} ¥${merged[0].totals.paidCents / 100}）`);
}

console.log('【V8】核验记录随团单持久化（保存不再按券名白名单重判）');
{
  upsertDeals([{
    sign: 'V13-VERIFY-1', name: '麦香鸡三件套', priceCents: 1990, poiName: '测试', admitted: true,
    contents: [{ mode: 'combo-ref', keyword: 'MCC-1', qty: 1, comboName: '麦香鸡三件套' }],
    verify: { status: 'menu-verified', comboCode: 'MCC-1', source: 'official-menu', verifiedAt: '2026-10-14' },
  }]);
  const d = dealsSnapshot(14).find((x) => x.sign === 'V13-VERIFY-1');
  check(!!d, '团单落盘');
  check(d?.verify?.status === 'menu-verified' && d?.contents?.[0]?.mode === 'combo-ref', 'verify 记录与 combo-ref 构成完整读回', d?.verify);
  check(d?.admitted === true, '准入状态随核验记录保存');
}

console.log('【V9】productViewSign 与 skuViewId 分开保留；headUrl 提取');
{
  const resp = { data: [{
    couponPackDetail: {
      name: '随心配1+1套餐', skuViewId: 'AAAA1111BBBB', productViewSign: 'AAAA1111BBBB_TAILTAIL',
      sellPrice: '13.9', headUrl: 'https://img.meituan.net/x.jpg@350_0_900_900a|267h',
    },
    brandInfo: { brandName: '麦当劳' },
  }] };
  const [d] = parseCouponItems(resp, 10);
  check(d.productViewSign === 'AAAA1111BBBB_TAILTAIL', `productViewSign 取 couponPackDetail.productViewSign（实际 ${d.productViewSign}）`);
  check(d.skuViewId === 'AAAA1111BBBB', `skuViewId 独立保留（实际 ${d.skuViewId}）——旧实现把 skuViewId 填进 productViewSign 字段`);
  check(d.headUrl === 'https://img.meituan.net/x.jpg', `headUrl 提取并去尺寸后缀（实际 ${d.headUrl}）`);
}

console.log('【V10】券名模式与城市字典');
{
  const pat = parseDealPattern('随心配1+1套餐');
  check(!!pat && pat.length === 2 && pat[0].mode === 'choice', '随心配 1+1 模式解析');
  check(parseDealPattern('【任选2件】鸡肉小食两件套') === null, '「任选 N 件」不做模式化猜测（范围不明确）');
  const cityId = meituanCityId('上海');
  check(typeof cityId === 'string' && cityId.length >= 10, `上海 → cityId（实际 ${cityId}）`);
  check(meituanCityId('上海市') === cityId, '「上海市」同 ID');
  check(meituanCityId('不存在市') === undefined, '未知城市 → undefined（不猜测）');
}

console.log('【V11】S2 官方同名核验：combo-ref 保留任选范围（不把默认项当券内容）');
{
  const client = {
    async call(tool, args) {
      if (tool !== 'query-meal-detail') throw new Error('unexpected ' + tool);
      check(args.code === 'CMB-9', `query-meal-detail 用官方套餐 code（实际 ${args.code}）`);
      return { data: { rounds: [
        { id: 1, name: '主食', choices: [{ name: '麦辣堡', isDefault: 1, code: 'S1' }, { name: '板烧堡', code: 'S2', diffPrice: '+3' }] },
        { id: 2, name: '饮料', choices: [{ name: '可乐', isDefault: 1, code: 'D1' }, { name: '零度可乐', code: 'D2' }] },
      ] } };
    },
  };
  const menu = { items: [{ code: 'CMB-9', name: '麦香鸡三件套', isCombo: true, priceCents: 2290, kcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0, category: '', tags: [], fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: true, deconstruction: [
    { roundName: '主食', roundId: '1', category: 'staple', defaultName: '麦辣堡', options: [{ name: '麦辣堡', diffCents: 0, code: 'S1' }, { name: '板烧堡', diffCents: 300, code: 'S2' }] },
    { roundName: '饮料', roundId: '2', category: 'drink', defaultName: '可乐', options: [{ name: '可乐', diffCents: 0, code: 'D1' }, { name: '零度可乐', diffCents: 0, code: 'D2' }] },
  ] }], unmatched: 0, comboCount: 1, comboUnmatched: 0, table: new Map() };
  const rec = await verifyDealContents(client, 'STORE-1', { name: '麦香鸡三件套', headUrl: 'https://img/x.jpg' }, menu);
  check(rec.status === 'menu-verified', `S2 核验通过（实际 ${rec.status}）`);
  check(rec.contents?.[0]?.mode === 'combo-ref' && rec.contents?.[0]?.keyword === 'CMB-9', '构成=官方套餐整包引用（含任选范围）');
  check(rec.headUrl === 'https://img/x.jpg', '券面主图入记录');
  // 未命中同名 → 细分原因
  const rec2 = await verifyDealContents({ async call() { throw new Error('x'); } }, 'STORE-1', { name: '完全查无此券' }, menu);
  check(rec2.status === 'unverified' && rec2.reasonCode === 'detail-unavailable', `未核验原因=详情未取得（实际 ${rec2.reasonCode}）`);
}

console.log(failures === 0 ? '\nv1.3 针对性回归全部通过 ✓' : `\n${failures} 项未通过 ✗`);
process.exit(failures === 0 ? 0 : 1);
