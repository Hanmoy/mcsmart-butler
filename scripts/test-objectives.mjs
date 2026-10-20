// 内核目标与约束验证（v1.2 可靠性修正轮，对应评审复现场景）
// 1) 负向营养目标方向：200mg 钠 vs 1200mg 钠（同热量、均在预算内），选「钠更少」必须选前者；
//    旧实现因「负系数×最小化」双重取反 + 锁定约束恒真而选错并把 1200 记为最优。
// 2) 正向目标：蛋白质更多 → 选高蛋白。
// 3) 双目标顺序：[sodium, price] 与 [price, sodium] 给出不同 winner（顺序真实生效）。
// 4) 热量贴合：同价 386 kcal vs 515 kcal，目标 600 → 必须选更贴近目标的 515（旧实现 150 容差带内同价翻盘）。
// 5) 券 strictCover：单人无心愿条目时券方案可被选中（旧实现要求逐项声明承接导致永远选不中）。
// 6) Top-K 去重：仅玩具不同的解不占名额；食物内容不同才算新方案。
// 运行：node node_modules/typescript/bin/tsc && node scripts/test-objectives.mjs
import { optimizeTopK } from '../dist/optimizer.js';

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? `（${detail}）` : ''}`); failures++; }
};

const slot = (name, kcal, priceCents, m = {}) => ({
  roundName: '主食',
  options: [{
    name, kcal, kcalKnown: true, priceCents, diffCents: 0,
    staple: m.staple ?? true, veggie: false, fastCarb: 0, drink: false,
    ...(m.nonFood ? { nonFood: true } : {}),
    protein: m.protein ?? 0, fat: m.fat ?? 0, carbohydrate: m.carbohydrate ?? 0, sodium: m.sodium ?? 0,
  }],
});

// ---------- 1) 负向目标方向（用户复现场景） ----------
console.log('【1】负向目标（钠更少）：200mg@¥20 vs 1200mg@¥10，热量相同');
{
  const plans = [
    { id: 'p-low', channel: 'mcd-mcp', name: '低钠餐', basePriceCents: 2000, maxQty: 1, slots: [slot('低钠堡', 500, 2000, { sodium: 200, protein: 20 })] },
    { id: 'p-high', channel: 'mcd-mcp', name: '高钠餐', basePriceCents: 1000, maxQty: 1, slots: [slot('高钠堡', 500, 1000, { sodium: 1200, protein: 20 })] },
  ];
  const rs = await optimizeTopK({
    plans, members: [{ alias: '我', kcalCap: 800 }], mode: 'fit', kcalBudget: 600,
    totalBudgetCents: 2500, priorities: ['sodium'],
  }, 1);
  check(rs.length > 0, '可行解存在');
  const r = rs[0];
  const sodiumOf = (res) => res.assignments.flatMap((a) => a.slotChoices).reduce((s, sc) => s + sc.sodium * (sc.count ?? 1), 0);
  check(sodiumOf(r) === 200, `钠更少 → 必须选中 200mg 方案（实际 ${sodiumOf(r)}mg）`);
  check(r.totals.priceCents === 2000, `并非因便宜选了高钠方案（实付 ¥${r.totals.priceCents / 100}）`);
  check(r.notes.some((n) => n.includes('钠更少') && n.includes('200')), `推荐理由记录真实最优值：${r.notes.find((n) => n.includes('钠更少'))}`);
}

// ---------- 2) 正向目标（蛋白质更多） ----------
console.log('【2】正向目标（蛋白质更多）');
{
  const plans = [
    { id: 'p-a', channel: 'mcd-mcp', name: '高蛋白餐', basePriceCents: 2000, maxQty: 1, slots: [slot('高蛋白堡', 500, 2000, { sodium: 800, protein: 34 })] },
    { id: 'p-b', channel: 'mcd-mcp', name: '低蛋白餐', basePriceCents: 1000, maxQty: 1, slots: [slot('低蛋白堡', 500, 1000, { sodium: 800, protein: 15 })] },
  ];
  const rs = await optimizeTopK({
    plans, members: [{ alias: '我', kcalCap: 800 }], mode: 'fit', kcalBudget: 600,
    totalBudgetCents: 2500, priorities: ['protein'],
  }, 1);
  const protein = rs[0].assignments.flatMap((a) => a.slotChoices).reduce((s, sc) => s + sc.protein * (sc.count ?? 1), 0);
  check(protein === 34, `蛋白质更多 → 选中 34g 方案（实际 ${protein}g）`);
}

// ---------- 3) 双目标顺序真实生效 ----------
console.log('【3】双目标顺序：[sodium, price] vs [price, sodium]');
{
  const plans = [
    { id: 'x', channel: 'mcd-mcp', name: '低钠贵', basePriceCents: 2400, maxQty: 1, slots: [slot('低钠堡', 500, 2400, { sodium: 300, protein: 20 })] },
    { id: 'y', channel: 'mcd-mcp', name: '高钠便宜', basePriceCents: 1000, maxQty: 1, slots: [slot('高钠堡', 500, 1000, { sodium: 1100, protein: 20 })] },
  ];
  const naFirst = await optimizeTopK({
    plans, members: [{ alias: '我', kcalCap: 800 }], mode: 'fit', kcalBudget: 600,
    totalBudgetCents: 2500, priorities: ['sodium', 'price'],
  }, 1);
  const priceFirst = await optimizeTopK({
    plans, members: [{ alias: '我', kcalCap: 800 }], mode: 'fit', kcalBudget: 600,
    totalBudgetCents: 2500, priorities: ['price', 'sodium'],
  }, 1);
  const planId = (r) => r.assignments.map((a) => a.planId).join(',');
  check(planId(naFirst[0]) === 'x', `先钠后价 → 低钠贵（${planId(naFirst[0])}）`);
  check(planId(priceFirst[0]) === 'y', `先价后钠 → 高钠便宜（${planId(priceFirst[0])}）`);
}

// ---------- 4) 热量贴合：同价更贴近目标者胜（评审截图复现） ----------
console.log('【4】热量贴合：目标 600，同价 386 vs 515 → 必须选 515');
{
  const plans = [
    { id: 'k-near', channel: 'mcd-mcp', name: '贴近餐', basePriceCents: 2000, maxQty: 1, slots: [slot('贴近堡', 515, 2000, { sodium: 700, protein: 20 })] },
    { id: 'k-far', channel: 'mcd-mcp', name: '偏离餐', basePriceCents: 2000, maxQty: 1, slots: [slot('偏离堡', 386, 2000, { sodium: 700, protein: 20 })] },
  ];
  const rs = await optimizeTopK({
    plans, members: [{ alias: '我', kcalCap: 700 }], mode: 'fit', kcalBudget: 600,
    totalBudgetCents: 2500,
  }, 2);
  check(rs.length > 0, '可行解存在');
  const chosen = rs[0].assignments.flatMap((a) => a.slotChoices).map((sc) => sc.kcal).join('+');
  check(chosen === '515', `热量贴合 → 选中 515 kcal（实际 ${chosen}）`);
  check(rs[0].notes.some((n) => n.includes('热量贴合')), `推荐理由：${rs[0].notes.find((n) => n.includes('热量贴合'))}`);
}

// ---------- 5) 券方案：单人无心愿条目也可选中（strictCover 修正） ----------
console.log('【5】券 strictCover：单人无具体心愿 → 券可参与求解');
{
  const official = { id: 'mcd-x', channel: 'mcd-mcp', name: '官方套餐', basePriceCents: 4000, maxQty: 1, slots: [slot('套餐堡', 500, 4000, { sodium: 800, protein: 25 })] };
  const coupon = {
    id: 'kv-c1', channel: 'meituan-cps', name: '美团双人餐券', basePriceCents: 2500, maxQty: 1,
    isExternalCoupon: true, strictCover: true,
    slots: [
      { roundName: '堡', defaultName: '券堡A', options: [{ name: '券堡A', kcal: 480, kcalKnown: true, priceCents: 0, diffCents: 0, staple: true, veggie: false, fastCarb: 0, drink: false, protein: 22, fat: 20, carbohydrate: 40, sodium: 900 }] },
      { roundName: '小食', defaultName: '券小食', options: [{ name: '券小食', kcal: 220, kcalKnown: true, priceCents: 0, diffCents: 0, staple: false, veggie: false, fastCarb: 0, drink: false, protein: 3, fat: 11, carbohydrate: 24, sodium: 350 }] },
    ],
  };
  const rs = await optimizeTopK({
    plans: [official, coupon],
    members: [{ alias: '我', kcalCap: 900, metrics: [{ metric: 'staple', op: '>=', value: 1 }] }], // 单人默认主食约束（与 service 一致；否则"什么都不买"是合法最优）
    mode: 'cheapest',
    totalBudgetCents: 3000, strictSurplus: true,
  }, 1);
  const bought = rs[0].assignments.map((a) => a.planId).join(',');
  check(bought === 'kv-c1', `券更省 → 单人无心愿也必须可选中券方案（实际 ${bought}）`);
  const mine = rs[0].memberAllocations[0];
  const gotKcal = mine.kcal;
  check(gotKcal === 700, `券内食品全数分配给本人（${gotKcal} kcal）`);
  check(mine.demands.length === 0 && mine.items.length === 2, '无心愿条目时不虚增覆盖率，食品如实归本人');
}

// ---------- 6) Top-K：玩具差异不占名额，食物差异才算新方案 ----------
console.log('【6】Top-K 去重：玩具变化不算新方案');
{
  const happyMeal = {
    id: 'mcd-happy', channel: 'mcd-mcp', name: '开心乐园餐', basePriceCents: 2500, maxQty: 3,
    slots: [
      { roundName: '主食', defaultName: '小堡', options: [{ name: '小堡', kcal: 250, kcalKnown: true, priceCents: 0, diffCents: 0, staple: true, veggie: false, fastCarb: 0, drink: false, protein: 12, fat: 9, carbohydrate: 25, sodium: 480 }] },
      { roundName: '饮品', defaultName: '牛奶', options: [
        { name: '牛奶', kcal: 120, kcalKnown: true, priceCents: 0, diffCents: 0, staple: false, veggie: false, fastCarb: 0, drink: true, protein: 7, fat: 5, carbohydrate: 12, sodium: 100 },
        { name: '果汁', kcal: 110, kcalKnown: true, priceCents: 0, diffCents: 0, staple: false, veggie: false, fastCarb: 0, drink: true, protein: 0, fat: 0, carbohydrate: 27, sodium: 10 },
      ] },
      { roundName: '玩具', defaultName: '玩具A', options: [
        { name: '玩具A', kcal: 0, kcalKnown: true, priceCents: 0, diffCents: 0, staple: false, veggie: false, fastCarb: 0, drink: false, nonFood: true, protein: 0, fat: 0, carbohydrate: 0, sodium: 0 },
        { name: '玩具B', kcal: 0, kcalKnown: true, priceCents: 0, diffCents: 0, staple: false, veggie: false, fastCarb: 0, drink: false, nonFood: true, protein: 0, fat: 0, carbohydrate: 0, sodium: 0 },
      ] },
    ],
  };
  const rs = await optimizeTopK({
    plans: [happyMeal],
    members: [{ alias: '我', kcalCap: 900, metrics: [{ metric: 'staple', op: '>=', value: 1 }] }],
    mode: 'cheapest',
    totalBudgetCents: 8000,
  }, 4, { maxIterations: 8 });
  // v1.3：食物内容签名含数量——数量扩展（1 份 → 2 份）是合法的不同购物篮（评审拍板恢复该能力）；
  // 仅玩具不同的解仍不算新方案（玩具被 foodSignature 剔除，也不占求解轮次）。
  const foods = rs.map((r) => r.assignments.flatMap((a) => a.slotChoices).filter((sc) => !sc.nonFood).map((sc) => `${sc.roundName}:${sc.chosenName}×${sc.count ?? 1}`).sort().join('+'));
  const uniqFoods = new Set(foods);
  check(uniqFoods.size === foods.length, `返回的方案食物内容互不相同（${foods.join(' | ')}）`);
  const toySets = rs.map((r) => JSON.stringify(r.assignments.flatMap((a) => a.slotChoices).filter((sc) => sc.nonFood).map((sc) => sc.chosenName)));
  check(toySets.every((t) => t.includes('玩具')), '玩具仍作为购买选项展示');
}

console.log(failures === 0 ? '\n内核目标与约束验证全部通过 ✓' : `\n${failures} 项未通过 ✗`);
process.exit(failures > 0 ? 1 : 0);
