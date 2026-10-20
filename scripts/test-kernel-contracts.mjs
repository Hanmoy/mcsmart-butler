// v5 内核契约验收（docs/GROUP_KERNEL_MILP_DESIGN.md v1.1 §六 A 组）
// 固化用户 2026-10-12 评审反例：七项问题在内核层的回归门禁。
// 运行：npm test（含 tsc build）或 npm run build && node scripts/test-kernel-contracts.mjs
import { optimize, optimizeTopK, buildPlansFromMenuItems } from '../dist/optimizer.js';

let failures = 0;
const check = (cond, label) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures++; }
};

const single = (id, name, priceCents, kcal, extra = {}) => ({
  id, channel: 'mcd-mcp', name, basePriceCents: priceCents, maxQty: 2,
  slots: [{ roundName: '测试', defaultName: name, options: [{ name, kcal, kcalKnown: extra.kcalKnown ?? true, priceCents, diffCents: 0, staple: extra.staple ?? false, veggie: false, code: extra.code ?? id, ...(extra.fastCarb ? { fastCarb: extra.fastCarb, drink: !!extra.drink } : {}) }] }],
  ...extra.plan,
});
const demand = (id, keyword, qty = 1, extra = {}) => ({ id, keyword, qty, ...extra });

// ---------- A1 双声明计数（可乐 + 零度可乐） ----------
console.log('【A1】需求单位声明唯一：一份零度可乐不能同时满足「可乐」与「零度可乐」');
{
  const plans = [
    single('coke', '可乐', 900, 200, { code: 'C-COKE' }),
    single('zero', '零度可乐', 1000, 0, { code: 'C-ZERO' }),
  ];
  const r = await optimize({
    plans,
    members: [{ alias: '甲', demands: [demand('d-coke', '可乐'), demand('d-zero', '零度可乐')] }],
    mode: 'cheapest',
  });
  const totalQty = r.assignments.reduce((s, a) => s + a.qty, 0);
  check(r.coverage.met === 2, `两条需求全部满足（coverage ${r.coverage.met}/${r.coverage.total}）`);
  check(totalQty >= 2, `购买总份数 ≥2（实际 ${totalQty}）——一份食物未被判为同时满足两条需求`);
  const zero = r.assignments.find((a) => a.planId === 'zero');
  const coke = r.assignments.find((a) => a.planId === 'coke');
  check(!!(zero || coke), '解存在');
  if (zero && !coke) {
    const m = r.memberAllocations[0];
    const zeroGot = m.items.filter((i) => i.itemName === '零度可乐').reduce((s, i) => s + 1, 0);
    check(m.demands.every((d) => d.satisfied), '仅购零度时两需求仍须由两份分别承接');
    check(zeroGot >= 2 || totalQty >= 2, `零度可乐到手 ${zeroGot} 份`);
  }
}

// ---------- A1b exact（恰好）语义 ----------
console.log('【A1b】exact 需求：恰好一份 = 恰好承接一份，不能一拆二');
{
  const plans = [single('zero', '零度可乐', 900, 0, { code: 'C-ZERO' })];
  const r = await optimize({
    plans,
    members: [{ alias: '乙', demands: [demand('d1', '零度可乐', 1, { exact: true })] }],
    mode: 'cheapest',
  });
  check(r.coverage.met === 1 && r.assignments[0]?.qty === 1, '恰好一份 → 购买 1 份');
  const r2 = await optimize({
    plans,
    members: [{ alias: '丙', demands: [demand('d1', '零度可乐', 2, { exact: true })] }],
    mode: 'cheapest',
  });
  check(r2.assignments[0]?.qty === 2 && r2.coverage.met === 1, '恰好两份 → 购买 2 份（maxQty 内）');
}

// ---------- A2 无候选需求不静默 + 嵌套池覆盖 ----------
console.log('【A2】无候选心愿：unmetDemands 显式记录（不静默跳过）；轨 1/轨 2 覆盖差异可见');
{
  const singles = [single('coke', '可乐', 900, 200, { code: 'C-COKE' })];
  const combo = {
    id: 'mcd-BIG', channel: 'mcd-mcp', name: '巨无霸四件套', basePriceCents: 4200, maxQty: 2,
    slots: [
      { roundName: '主食', roundId: 'r1', defaultName: '巨无霸', options: [{ name: '巨无霸', kcal: 513, kcalKnown: true, priceCents: 2650, diffCents: 0, staple: true, code: 'C-BIG' }] },
      { roundName: '小食', roundId: 'r2', defaultName: '薯条', options: [{ name: '薯条', kcal: 289, kcalKnown: true, priceCents: 1300, diffCents: 0, staple: false, code: 'C-FRIES' }] },
    ],
  };
  // 套餐名心愿 = 套餐意图需求（内核将解析命中的套餐映射为 comboPlanId，评审 #2 后半句）
  const comboDemand = demand('d1', '巨无霸四件套', 1, { comboPlanId: 'mcd-BIG' });
  const t1 = await optimize({ plans: singles, members: [{ alias: '甲', demands: [comboDemand, demand('d2', '可乐')] }], mode: 'cheapest' });
  check(t1.status === 'proven-optimal' && t1.coverage.met === 1 && t1.coverage.total === 2,
    `单品池：coverage ${t1.coverage.met}/${t1.coverage.total}（套餐心愿无候选）`);
  check(t1.unmetDemands.some((u) => u.keyword === '巨无霸四件套' && u.reason === 'no-candidate'),
    'unmetDemands 显式记录套餐心愿 no-candidate');
  const t2 = await optimize({ plans: [...singles, combo], members: [{ alias: '甲', demands: [demand('d1', '巨无霸四件套', 1, { comboPlanId: 'mcd-BIG' }), demand('d2', '可乐')] }], mode: 'cheapest' });
  check(t2.coverage.met === 2, `加套餐池后覆盖 2/2（嵌套池覆盖单调）`);
  check(t2.assignments.some((a) => a.planId === 'mcd-BIG'), '套餐被购买');
  const bigAlloc = t2.memberAllocations[0].items.map((i) => i.itemName).sort().join(',');
  check(bigAlloc.includes('巨无霸') && bigAlloc.includes('薯条'), `套餐意图按各槽位默认项承接（实际 ${bigAlloc}）`);
}

// ---------- A3 零热量回归 + 控卡禁配营养未知 ----------
console.log('【A3】kcal=0 已知单品入池（无糖可乐）；控卡成员对 kcalUnknown 选项不可分配');
{
  const plans = [
    single('zero', '无糖可乐', 800, 0, { code: 'C-ZERO', drink: true, fastCarb: 0 }),
    single('mystery', '神秘特饮', 500, 0, { code: 'C-XXX', kcalKnown: false, drink: true, fastCarb: 30 }),
    single('burger', '牛肉堡', 2000, 400, { code: 'C-BURGER', staple: true }),
  ];
  const r = await optimize({
    plans,
    members: [{ alias: '控卡', kcalCap: 450, demands: [demand('d1', '牛肉堡'), demand('d2', '无糖可乐')] }],
    mode: 'cheapest',
  });
  check(r.coverage.met === 2, `控卡 450：牛肉堡+无糖可乐可满足（coverage ${r.coverage.met}/${r.coverage.total}）`);
  check(r.memberAllocations[0].items.some((i) => i.itemName === '无糖可乐'), '真零热量品项进入分配');
  const r2 = await optimize({
    plans,
    members: [{ alias: '控卡', kcalCap: 450, demands: [demand('d1', '牛肉堡'), demand('d3', '神秘特饮')] }],
    mode: 'cheapest',
  });
  check(r2.unmetDemands.some((u) => u.keyword === '神秘特饮' && u.reason === 'kcal-unknown'),
    '营养未知品项对控卡成员记 kcal-unknown（非静默、非 0 kcal 混入）');
  check(!r2.memberAllocations[0].items.some((i) => i.itemName === '神秘特饮'), '控卡成员未获得营养未知品项');
}

// ---------- A4 外部券整单限购 + maxQty 生效 ----------
console.log('【A4】Σ外部券 ≤1（两种券不可同购）；maxQty=1 不可买多份');
{
  const coupon = (id, price, items) => ({
    id, channel: 'meituan-cps', name: id, basePriceCents: price, maxQty: 1,
    maxQtySource: 'voucher-limit', isExternalCoupon: true, strictCover: true,
    slots: items.map(([name, code], i) => ({ roundName: '券内' + i, defaultName: name, options: [{ name, kcal: 0, kcalKnown: true, priceCents: 0, diffCents: 0, staple: false, code }] })),
  });
  const plans = [
    coupon('CUP-A', 2000, [['堡A', 'BA'], ['饮A', 'DA']]),
    coupon('CUP-B', 2500, [['堡B', 'BB'], ['饮B', 'DB']]),
    single('s-BA', '堡A', 2600, 500, { code: 'BA', staple: true }),
    single('s-DA', '饮A', 1100, 200, { code: 'DA', drink: true, fastCarb: 30 }),
    single('s-BB', '堡B', 2700, 500, { code: 'BB', staple: true }),
    single('s-DB', '饮B', 1100, 200, { code: 'DB', drink: true, fastCarb: 30 }),
  ];
  const r = await optimize({
    plans,
    members: [
      { alias: '甲', demands: [demand('d1', '堡A'), demand('d2', '饮A')] },
      { alias: '乙', demands: [demand('d3', '堡B'), demand('d4', '饮B')] },
    ],
    mode: 'cheapest',
  });
  const couponBuys = r.assignments.filter((a) => ['CUP-A', 'CUP-B'].includes(a.planId)).reduce((s, a) => s + a.qty, 0);
  check(couponBuys <= 1, `外部券整单购买 ≤1（实际 ${couponBuys}，旧内核两种券可同购）`);
  check(r.coverage.met === 4, `四人份心愿仍全满足（coverage ${r.coverage.met}/${r.coverage.total}）`);
  // maxQty=1：两人各要一份 → 只买 1 份，缺口如实呈现（软需求缺口变量；旧内核买 3 份仍报最优）
  const limited = { ...single('only', '限定堡', 1000, 400, { code: 'ONLY', staple: true }), maxQty: 1 };
  const r2 = await optimize({
    plans: [limited],
    members: [
      { alias: '甲', demands: [demand('d1', '限定堡')] },
      { alias: '乙', demands: [demand('d2', '限定堡')] },
    ],
    mode: 'cheapest',
  });
  check(r2.status !== 'infeasible' && r2.assignments[0]?.qty === 1, `maxQty=1：购买 1 份（实际 ${r2.assignments[0]?.qty ?? 0}）`);
  check(r2.coverage.total === 2 && r2.coverage.met === 1, `覆盖率以原始需求为分母（${r2.coverage.met}/${r2.coverage.total}）`);
  check(r2.gapTotal === 1, `缺口变量记录 1 份未满足（实际 ${r2.gapTotal}）`);
  check(r2.unmetDemands.some((u) => u.reason === 'unsatisfied'), '未满足需求显式输出');
  const r3 = await optimize({
    plans: [{ ...limited, maxQty: 2 }],
    members: [
      { alias: '甲', demands: [demand('d1', '限定堡')] },
      { alias: '乙', demands: [demand('d2', '限定堡')] },
    ],
    mode: 'cheapest',
  });
  check(r3.status === 'proven-optimal' && r3.assignments[0]?.qty === 2, 'maxQty=2 时两人各得一份');
  check(r3.assignments[0]?.maxQtySource === 'program-cap' || limited.maxQtySource === undefined, 'maxQtySource 透出');
}

// ---------- A5 同套餐两份不同配置（per-unit 配置贯通） ----------
console.log('【A5】同套餐两份不同搭配：units[] 逐份还原，聚合 slotChoices 计数正确');
{
  const combo = {
    id: 'mcd-P', channel: 'mcd-mcp', name: '双拼套餐', basePriceCents: 3000, maxQty: 2, maxQtySource: 'program-cap',
    slots: [
      { roundName: '主食', roundId: 'r1', defaultName: '堡A', options: [
        { name: '堡A', kcal: 500, kcalKnown: true, priceCents: 2000, diffCents: 0, staple: true, code: 'PA' },
        { name: '堡B', kcal: 550, kcalKnown: true, priceCents: 2100, diffCents: 300, staple: true, code: 'PB' },
      ] },
      { roundName: '饮料', roundId: 'r2', defaultName: '可乐', options: [
        { name: '可乐', kcal: 200, kcalKnown: true, priceCents: 900, diffCents: 0, staple: false, code: 'PC' },
        { name: '雪碧', kcal: 200, kcalKnown: true, priceCents: 900, diffCents: 0, staple: false, code: 'PS' },
      ] },
    ],
  };
  const r = await optimize({
    plans: [combo],
    members: [
      { alias: '甲', demands: [demand('d1', '堡A'), demand('d2', '可乐')] },
      { alias: '乙', demands: [demand('d3', '堡B'), demand('d4', '雪碧')] },
    ],
    mode: 'cheapest',
  });
  const pa = r.assignments.find((a) => a.planId === 'mcd-P');
  check(!!pa && pa.qty === 2, `套餐购买 2 份（实际 ${pa?.qty ?? 0}）`);
  const cfgA = pa?.units.map((u) => u.slotChoices.find((sc) => sc.roundId === 'r1')?.chosenName).join(',');
  check(pa?.units.length === 2 && new Set(pa.units.map((u) => u.slotChoices.find((sc) => sc.roundId === 'r1')?.chosenName)).size === 2,
    `两份主食配置不同（${cfgA}）——旧内核无法还原`);
  const cntB = pa?.slotChoices.find((sc) => sc.chosenName === '堡B')?.count ?? 0;
  const cntA = pa?.slotChoices.find((sc) => sc.chosenName === '堡A')?.count ?? 0;
  check(cntA === 1 && cntB === 1, `聚合计数 堡A×${cntA} 堡B×${cntB}`);
  check(pa?.units.every((u) => u.slotChoices.every((sc) => !!sc.roundId)), 'units 内 roundId/optionCode 贯通');
  check(r.memberAllocations[0].items.some((i) => i.itemName === '堡A') && r.memberAllocations[1].items.some((i) => i.itemName === '堡B'),
    '个人分配清单：甲得堡A、乙得堡B（共享套餐不重复列整包）');
}

// ---------- A6 券严格承接入模（v1.2 语义：券品项全数分配给成员；心愿覆盖由声明层如实计量） ----------
console.log('【A6】strictCover：券品项全数分配给成员；无心愿承接的食品归成员（不虚增覆盖）；有承接 → 合法购买');
{
  const voucher = (id, price, items) => ({
    id, channel: 'meituan-cps', name: id, basePriceCents: price, maxQty: 1,
    maxQtySource: 'voucher-limit', isExternalCoupon: true, strictCover: true,
    slots: items.map(([name, code], i) => ({ roundName: '券内' + i, defaultName: name, options: [{ name, kcal: 0, kcalKnown: true, priceCents: 0, diffCents: 0, staple: false, code }] })),
  });
  const plans = [
    voucher('V1', 1990, [['堡X', 'BX'], ['饮Y', 'DY']]),
    single('s-BX', '堡X', 2500, 500, { code: 'BX', staple: true }),
    single('s-DY', '饮Y', 1000, 200, { code: 'DY', drink: true, fastCarb: 30 }),
  ];
  // 场景 1（v1.2 语义）：只有一人要堡X，饮Y 无人要 → 券仍可购买（¥19.9 < 散点 ¥25），
  // 饮Y 作为额外食品分配给甲（宜多不宜少），覆盖率不虚增（仍以原始需求为分母）
  const r1 = await optimize({ plans, members: [{ alias: '甲', demands: [demand('d1', '堡X')] }], mode: 'cheapest' });
  check(r1.assignments.some((a) => a.planId === 'V1'), '饮Y 无心愿承接 → 券仍可购买（更省；旧语义会把券整体排除）');
  check(r1.totals.priceCents === 1990, `券价 ¥19.9 优于散点 ¥25（实际 ¥${(r1.totals.priceCents / 100).toFixed(1)}）`);
  check(r1.coverage.met === 1 && r1.coverage.total === 1, '覆盖率不虚增（1/1，饮Y 不计入心愿满足）');
  check(r1.memberAllocations[0].items.some((i) => i.itemName === '饮Y'), '饮Y 作为额外食品分配给甲（宜多，遵守上限）');
  check(r1.leftovers.length === 0, '券品项无剩余（strictCover = 全数分配）');
  // 场景 2：两人分别要堡X/饮Y → 券合法且最优
  const r2 = await optimize({
    plans,
    members: [{ alias: '甲', demands: [demand('d1', '堡X')] }, { alias: '乙', demands: [demand('d2', '饮Y')] }],
    mode: 'cheapest',
  });
  check(r2.assignments.some((a) => a.planId === 'V1' && a.qty === 1), '两人分别承接两券品项 → 券购买（¥19.9 < 散点 ¥35）');
  check(r2.totals.priceCents === 1990, `整单 ¥19.9（实际 ¥${(r2.totals.priceCents / 100).toFixed(1)}）`);
  check(r2.memberAllocations[0].items.some((i) => i.itemName === '堡X') && r2.memberAllocations[1].items.some((i) => i.itemName === '饮Y'),
    '券品项严格分配给承接成员');
}

// ---------- A7 leftovers 显式输出 + 宜多分配 ----------
console.log('【A7】剩余品项显式输出（无法分配时）；无人认领食品优先分配给成员（宜多）');
{
  const combo = {
    id: 'mcd-Q', channel: 'mcd-mcp', name: '套餐Q', basePriceCents: 3000, maxQty: 1, maxQtySource: 'program-cap',
    slots: [
      { roundName: '主食', roundId: 'r1', defaultName: '堡A', options: [{ name: '堡A', kcal: 500, kcalKnown: true, priceCents: 2000, diffCents: 0, staple: true, code: 'QA' }] },
      { roundName: '饮料', roundId: 'r2', defaultName: '可乐', options: [{ name: '可乐', kcal: 200, kcalKnown: true, priceCents: 900, diffCents: 0, staple: false, code: 'QC' }] },
    ],
  };
  // 场景 1：成员禁忌可乐 → 饮料无法分配 → 进剩余
  const r = await optimize({
    plans: [combo],
    members: [{ alias: '甲', demands: [demand('d1', '堡A')], taboo: ['可乐'] }],
    mode: 'cheapest',
  });
  check(r.status === 'proven-optimal', '套餐Q 购买（堡A 心愿只能由套餐承接）');
  check(r.leftovers.length === 1 && r.leftovers[0].itemName === '可乐' && r.leftovers[0].qty === 1,
    `leftovers 输出可乐×1（实际 ${JSON.stringify(r.leftovers.map((l) => `${l.itemName}×${l.qty}`))}）`);
  check(r.totals.leftoverCents === 900, `剩余参考价 ¥9.0（实际 ¥${(r.totals.leftoverCents / 100).toFixed(1)}）`);
  check(r.memberAllocations[0].items.every((i) => i.itemName !== '可乐'), '禁忌成员不接收剩余（不强行指派）');
  // 场景 2：无禁忌 → 饮料作为额外食物分配给成员（宜多不宜少，最小剩余阶段）
  const r2 = await optimize({
    plans: [combo],
    members: [{ alias: '乙', demands: [demand('d1', '堡A')] }],
    mode: 'cheapest',
  });
  check(r2.leftovers.length === 0, '无禁忌时剩余为 0（宜多分配）');
  check(r2.memberAllocations[0].items.some((i) => i.itemName === '可乐'), '额外饮料分配给成员（超出需求部分如实计入其所得）');
}

// ---------- A8 建池：kcal=0 单品不再被过滤（评审 #3 建池层回归） ----------
console.log('【A8】buildPlansFromMenuItems 不再过滤 kcal=0 单品');
{
  const mk = (code, name, kcal, matched) => ({
    code, name, priceCents: 800, originalPriceCents: 800, category: '饮品', tags: [],
    kcal, protein: 0, fat: 0, carbohydrate: 0, sodium: 0, isCombo: false,
    fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: matched,
  });
  const { singlePlans } = buildPlansFromMenuItems([
    mk('W1', '无糖可乐', 0, true),      // 真零热量（营养已联结）
    mk('W2', '神秘特饮', 0, false),     // 营养未知
    mk('W3', '可乐', 200, true),
  ], { includeSingle: true });
  check(singlePlans.length === 3, `3 个单品全部入池（实际 ${singlePlans.length}，旧内核过滤 kcal=0 只剩 1）`);
  const zero = singlePlans.find((p) => p.id === 'mcd-s-W1');
  check(zero?.slots[0].options[0].kcalKnown === true, '无糖可乐 kcalKnown=true（真零热量）');
  check(singlePlans.find((p) => p.id === 'mcd-s-W2')?.slots[0].options[0].kcalKnown === false, '营养未知 kcalKnown=false');
}

// ---------- A9 用户复现：¥25/600kcal，15元汉堡在池，禁止饮料冒充正餐 ----------
console.log('【A9】用户复现：25 元预算 + 主食硬约束 → 汉堡入选，饮料不能冒充正餐');
{
  const plans = [
    single('burger', '汉堡', 1500, 500, { code: 'B1', staple: true }),
    single('drink', '快乐水', 1300, 200, { code: 'D1', drink: true, fastCarb: 30 }),
  ];
  const member = { alias: '我', kcalCap: 600, hardPriceCapCents: 2500, stapleMin: 1 };
  for (const mode of ['cheapest', 'fit']) {
    const r = await optimize({
      plans, members: [member], mode,
      kcalBudget: 600, totalBudgetCents: 2500, strictSurplus: true,
      ...(mode === 'fit' ? {} : {}),
    });
    const names = r.assignments.flatMap((a) => a.units.flatMap((u) => u.slotChoices.map((sc) => sc.chosenName)));
    check(names.includes('汉堡'), `〔${mode}〕方案包含主食汉堡（实际 ${names.join('+') || '空'}）`);
    check(r.memberAllocations[0].staple >= 1, `〔${mode}〕成员所得含 ≥1 份主食（旧内核为 0）`);
    check(r.totals.priceCents <= 2500, `〔${mode}〕整单 ≤ ¥25（实际 ¥${(r.totals.priceCents / 100).toFixed(1)}）`);
  }
}

// ---------- A10 度量硬约束传入模型 ----------
console.log('【A10】蛋白质 ≥ 15g 约束真实生效');
{
  const plans = [
    single('snack', '小食拼盘', 800, 300, { code: 'S1' }),
    single('burger', '牛肉堡', 2000, 500, { code: 'B2', staple: true }),
  ];
  // 手工补 protein：通过 slots options 的 protein 字段
  plans[0].slots[0].options[0].protein = 2;
  plans[1].slots[0].options[0].protein = 25;
  const r = await optimize({
    plans,
    members: [{ alias: '我', metrics: [{ metric: 'protein', op: '>=', value: 15 }], hardPriceCapCents: 2500 }],
    mode: 'cheapest',
  });
  const names = r.assignments.flatMap((a) => a.units.flatMap((u) => u.slotChoices.map((sc) => sc.chosenName)));
  check(names.includes('牛肉堡') && !names.includes('小食拼盘'), `蛋白约束下选牛肉堡（实际 ${names.join('+') || '空'}）`);
}

// ---------- A11 软需求缺口：覆盖率以原始需求为分母，可满足部分保留 ----------
console.log('【A11】控卡冲突：汉堡缺口如实呈现，可乐仍被满足（不整批放弃）');
{
  const plans = [
    single('burger', '汉堡', 1500, 500, { code: 'B1', staple: true }),
    single('coke', '可乐', 900, 200, { code: 'C1' }),
  ];
  const r = await optimize({
    plans,
    members: [{ alias: '控卡', kcalCap: 300, demands: [demand('d1', '汉堡'), demand('d2', '可乐')] }],
    mode: 'cheapest',
  });
  check(r.coverage.total === 2, `分母=原始需求 2（实际 ${r.coverage.total}）`);
  check(r.coverage.met === 1, `可满足的可乐被保留（met ${r.coverage.met}）`);
  check(r.gapTotal === 1, `汉堡缺口 1（实际 ${r.gapTotal}）`);
  check(r.memberAllocations[0].items.some((i) => i.itemName === '可乐'), '可乐实际分配给成员');
  check(r.unmetDemands.some((u) => u.keyword === '汉堡' && u.reason === 'unsatisfied'), '汉堡缺口显式输出');
}

// ---------- A12 Top-K 真实不同完整方案 ----------
console.log('【A12】Top-K：多个真实不同的完整购物篮');
{
  const plans = [
    single('burger', '汉堡', 1500, 500, { code: 'B1', staple: true }),
    single('chicken', '鸡腿堡', 1600, 480, { code: 'B2', staple: true }),
    single('drink', '可乐', 500, 200, { code: 'D1', drink: true, fastCarb: 30 }),
  ];
  const rs = await optimizeTopK({
    plans,
    members: [{ alias: '我', stapleMin: 1, hardPriceCapCents: 3000 }],
    mode: 'cheapest', strictSurplus: true,
  }, 3);
  check(rs.length >= 2, `返回 ≥2 个方案（实际 ${rs.length}）`);
  const sigs = rs.map((r) => r.assignments.map((a) => `${a.planId}×${a.qty}`).sort().join('|'));
  check(new Set(sigs).size === sigs.length, '方案两两不同（非换编号重复）');
  check(rs[0].totals.priceCents <= rs[rs.length - 1].totals.priceCents, '按价格升序排列');
  check(rs.every((r) => r.memberAllocations[0].staple >= 1), '所有方案满足主食硬约束');
}

console.log(failures === 0 ? '\n内核契约验收全部通过 ✓' : `\n${failures} 项未通过 ✗`);
process.exit(failures === 0 ? 0 : 1);