// v1.4.2 内核修复验收（仅覆盖 src/optimizer.ts 的 4 个问题）
//   R01 度量名归一化（carb→carbohydrate）+ LP 系数防御（未知度量显式报错，不把 undefined 当系数）
//   R03 食品规格/主食身份/饮料含糖 统一解析（槽位规格优先、菜单身份保留、组件含糖三态保守）
//   R05 Top-K 完整购物篮割（不再强制每个已购计划都变化，A+B 之后能得到 A+C）
//   P2  营养不完整时不得使用「达成/偏差 0」语言
// 运行（隔离 MCSMART_HOME，不污染真实数据）：
//   npx tsc --outDir .build-a
//   MCSMART_BUILD=../.build-a node scripts/test-v142-optimizer.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v142-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const BASE = process.env.MCSMART_BUILD ?? '../dist';
const O = await import(`${BASE}/optimizer.js`);

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS ${label}${detail ? `（${detail}）` : ''}`);
  else { console.error(`  FAIL ${label}${detail ? `（${detail}）` : ''}`); failures++; }
};
const checkThrows = async (fn, label, needle = '') => {
  try { await fn(); check(false, label, '未抛错'); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(needle === '' || msg.includes(needle), label, msg.slice(0, 90));
  }
};

// ---------- 通用夹具 ----------
const slot = (roundName, name, kcal, priceCents, m = {}) => ({
  roundName,
  options: [{
    name, kcal, kcalKnown: true, priceCents, diffCents: 0,
    staple: m.staple ?? false, veggie: m.veggie ?? false,
    fastCarb: m.fastCarb ?? 0, drink: m.drink ?? false,
    protein: m.protein ?? 0, fat: m.fat ?? 0, carbohydrate: m.carbohydrate ?? 0, sodium: m.sodium ?? 0,
  }],
});
const plan1 = (id, roundName, name, kcal, priceCents, m = {}) => ({
  id, channel: 'mcd-mcp', name: id, basePriceCents: priceCents, maxQty: 1,
  slots: [slot(roundName, name, kcal, priceCents, m)],
});
// 递归检查结果对象中不存在非有限数（undefined/NaN/Infinity）
const badNumbers = (obj, path = '$', out = []) => {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'number') { if (!Number.isFinite(obj)) out.push(`${path}=${obj}`); return out; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => badNumbers(v, `${path}[${i}]`, out)); return out; }
  if (typeof obj === 'object') { for (const k of Object.keys(obj)) badNumbers(obj[k], `${path}.${k}`, out); return out; }
  return out;
};

// ========== R01 度量名归一化 + LP 系数防御 ==========
console.log('【R01】未知度量不得静默当 LP 系数：carb 归一、未知值显式报错');
{
  const plans = [
    plan1('p-a', '主食', 'A堡', 500, 2000, { staple: true, carbohydrate: 60 }),
    plan1('p-b', '主食', 'B堡', 500, 1000, { staple: true, carbohydrate: 20 }),
  ];
  const base = { plans, members: [{ alias: '我', kcalCap: 800 }], mode: 'fit', kcalBudget: 600, totalBudgetCents: 2500 };
  // 修复前：priorities:['carb'] → metricValueOf 返回 undefined → LP 系数 NaN → HiGHS error -1
  const rs = await O.optimizeTopK({ ...base, priorities: ['carb'] }, 1);
  check(rs.length > 0 && rs[0].status !== 'infeasible', 'priorities:["carb"] 正常求解（旧实现 HiGHS error -1）');
  const r = rs[0];
  check(r.assignments.map((a) => a.planId).join(',') === 'p-b', 'carb 按 carbohydrate 生效：选中低碳水方案', r.assignments.map((a) => a.planId).join(','));
  check(r.notes.some((n) => n.includes('碳水更少')), '目标文案为「碳水更少」');
  const bad = badNumbers(r);
  check(bad.length === 0, '结果 JSON 无非有限数（undefined/NaN/Infinity）', bad.slice(0, 3).join('; '));
  check(Number.isFinite(r.totals.priceCents) && r.memberAllocations.every((m) => Number.isFinite(m.kcal)), '价格/热量合计均为有限数');
  // carbs 别名同样接受
  const rs2 = await O.optimizeTopK({ ...base, priorities: ['carbs'] }, 1);
  check(rs2.length > 0, 'priorities:["carbs"] 亦被接受（别名）');
  // 成员度量约束里的 carb 也归一
  const rc = await O.optimize({ plans, members: [{ alias: '我', metrics: [{ metric: 'carb', op: '<=', value: 30 }] }], mode: 'cheapest' });
  check(rc.status !== 'infeasible', 'metrics:[{metric:"carb"}] 归一后参与约束求解');
  // 未知值必须显式报错（列出合法值）
  await checkThrows(() => O.optimize({ plans, members: [{ alias: '我' }], mode: 'cheapest', priorities: ['fiber'] }),
    '未知优先级目标抛错', '未知优化目标');
  await checkThrows(() => O.optimize({ plans, members: [{ alias: '我' }], mode: 'cheapest', priorities: ['fiber'] }),
    '错误信息列出合法值', 'protein');
  await checkThrows(() => O.optimize({ plans, members: [{ alias: '我', metrics: [{ metric: 'sugar', op: '<=', value: 10 }] }], mode: 'cheapest' }),
    '未知成员度量抛错', '未知营养度量');
  await checkThrows(() => O.optimize({ plans, members: [{ alias: '我', metrics: [{ metric: 'sugar', op: '<=', value: 10 }] }], mode: 'cheapest' }),
    '度量错误信息列出合法值', 'carbohydrate');
  // 防御：非有限 kcal（运行时 undefined）不得静默进入 LP
  const badPlans = [{ id: 'bad', channel: 'mcd-mcp', name: '坏计划', basePriceCents: 1000, maxQty: 1, slots: [{ roundName: '主食', options: [{ name: '坏堡', kcal: undefined, kcalKnown: true, priceCents: 1000, diffCents: 0, staple: true, veggie: false, fastCarb: 0, drink: false }] }] }];
  await checkThrows(() => O.optimize({ plans: badPlans, members: [{ alias: '我' }], mode: 'cheapest' }),
    '非有限 kcal 被显式拒绝（指出计划/选项）', '坏计划');
}

// ========== R03 食品规格 / 主食身份 / 饮料含糖 ==========
console.log('【R03】规格优先 / 菜单主食身份保留 / 组件饮料含糖解析');
{
  const mi = (code, name, priceCents, extra = {}) => ({
    code, name, priceCents, originalPriceCents: priceCents,
    category: extra.category ?? '单品', tags: [],
    kcal: extra.kcal ?? 0, protein: extra.protein ?? 0, fat: extra.fat ?? 0,
    carbohydrate: extra.carbohydrate ?? 0, sodium: extra.sodium ?? 0,
    isCombo: !!extra.isCombo, fastCarb: extra.fastCarb ?? 0,
    isVeggie: !!extra.isVeggie, isStaple: !!extra.isStaple,
    nutritionMatched: extra.nutritionMatched ?? true,
    ...(extra.isCombo ? { deconstruction: extra.deconstruction } : {}),
  });
  // 大/中/小薯条共用同一菜单单品 code（FRIES）；官网规格库 大=379 / 中=289 / 小=210
  const items = [
    mi('FRIES', '薯条', 1350, { kcal: 289, carbohydrate: 38 }),
    mi('FISH', '麦香鱼', 2000, { kcal: 325, isStaple: true, protein: 16 }),
    mi('COKE', '可口可乐', 1050, { kcal: 147, carbohydrate: 36, category: '饮品' }),
    mi('COKE0', '零度可乐', 1050, { kcal: 0, carbohydrate: 1, category: '饮品' }),
    mi('CMB', '三件套', 3000, {
      isCombo: true,
      deconstruction: [
        { roundName: '主食', defaultName: '麦香鱼', options: [{ name: '麦香鱼', diffCents: 0, code: 'FISH' }] },
        { roundName: '小食', defaultName: '大薯条', options: [
          { name: '大薯条', diffCents: 0, code: 'FRIES' },
          { name: '中薯条', diffCents: 0, code: 'FRIES' },
          { name: '小薯条', diffCents: 0, code: 'FRIES' },
        ] },
        { roundName: '饮料', defaultName: '可口可乐', options: [
          { name: '可口可乐', diffCents: 0 },
          { name: '零度可乐', diffCents: 0 },
        ] },
      ],
    }),
    // 仅存在于套餐中的「未知含糖」饮料组件（官网查无）——含糖应保持未知
    mi('CMB2', '双件套', 2000, {
      isCombo: true,
      deconstruction: [
        { roundName: '主食', defaultName: '麦香鱼', options: [{ name: '麦香鱼', diffCents: 0, code: 'FISH' }] },
        { roundName: '饮料', defaultName: '怡泉苏打水', options: [{ name: '怡泉苏打水', diffCents: 0 }] },
      ],
    }),
  ];
  const { comboPlans, singlePlans } = O.buildPlansFromMenuItems(items, { includeSingle: true });
  const optOf = (plans, id, roundName, name) => plans.find((p) => p.id === id)?.slots
    .find((s) => s.roundName === roundName)?.options.find((o) => o.name === name);

  // 规格：同一 code 共用，但槽位规格优先于单品泛化营养
  const singleFries = optOf(singlePlans, 'mcd-s-FRIES', '单品', '薯条');
  const bigFries = optOf(comboPlans, 'mcd-CMB', '小食', '大薯条');
  const midFries = optOf(comboPlans, 'mcd-CMB', '小食', '中薯条');
  const smallFries = optOf(comboPlans, 'mcd-CMB', '小食', '小薯条');
  check(singleFries?.kcal === 289, '单点「薯条」（无规格）回落菜单单品 289', String(singleFries?.kcal));
  check(bigFries?.kcal === 379, '套餐「大薯条」按官网规格 379（旧实现误用单品 289）', String(bigFries?.kcal));
  check(midFries?.kcal === 289 && smallFries?.kcal === 210, '中/小规格分别 289 / 210', `${midFries?.kcal}/${smallFries?.kcal}`);
  check(bigFries?.code === 'FRIES' && midFries?.code === 'FRIES' && smallFries?.code === 'FRIES', '大/中/小薯条共用同一 code');

  // 主食身份：菜单已知 isStaple 不被名称正则覆盖（麦香鱼正则不含）
  const singleFish = optOf(singlePlans, 'mcd-s-FISH', '单品', '麦香鱼');
  const comboFish = optOf(comboPlans, 'mcd-CMB', '主食', '麦香鱼');
  check(singleFish?.staple === true, '单点「麦香鱼」保留菜单主食身份 staple=true');
  check(comboFish?.staple === true, '套餐内「麦香鱼」同样 staple=true（旧实现 false → 无法满足 stapleMin:1）');
  check(singleFish?.kcal === 325 && comboFish?.kcal === 325, '同一食品跨单点/套餐营养一致（325）');

  // 饮料/含糖：仅存在于套餐的组件也解析
  const comboCola = optOf(comboPlans, 'mcd-CMB', '饮料', '可口可乐');
  const comboCola0 = optOf(comboPlans, 'mcd-CMB', '饮料', '零度可乐');
  check(comboCola?.drink === true, '套餐组件「可口可乐」drink=true（旧实现 false）');
  check(comboCola?.sugary === true, '套餐组件「可口可乐」sugary=true');
  check(comboCola?.fastCarb > 0, '套餐组件「可口可乐」fastCarb>0（旧实现 0）', String(comboCola?.fastCarb));
  check(comboCola?.kcal === 147, '套餐组件「可口可乐」官网回填 147 kcal', String(comboCola?.kcal));
  check(comboCola0?.drink === true && comboCola0?.sugary === false, '「零度可乐」drink=true / sugary=false');
  check(comboCola0?.fastCarb === 0, '「零度可乐」fastCarb=0');
  const unknownDrink = optOf(comboPlans, 'mcd-CMB2', '饮料', '怡泉苏打水');
  check(unknownDrink?.drink === true && unknownDrink?.sugary === undefined, '未知含糖组件保持「未知」（sugary=undefined，非默认 false）');

  // 求解侧：noSugaryDrink 成员不得被分配含糖/含糖未知饮料
  {
    const rs = await O.optimizeTopK({
      plans: comboPlans.filter((p) => p.id === 'mcd-CMB'),
      members: [{ alias: '我', stapleMin: 1, noSugaryDrink: true, demands: [{ id: 'd1', keyword: '可乐', qty: 1 }] }],
      mode: 'cheapest',
    }, 1);
    const mine = rs[0]?.memberAllocations?.[0];
    const names = (mine?.items ?? []).map((i) => i.itemName);
    check(!names.includes('可口可乐'), 'noSugaryDrink 成员未被分配含糖可乐', names.join('+') || '空');
    check(names.includes('零度可乐'), 'noSugaryDrink 成员被分配零度可乐（可确认不含糖）', names.join('+') || '空');
  }
  {
    // 唯一饮料含糖未知 → 保守：不得当作满足 noSugaryDrink
    const rs = await O.optimizeTopK({
      plans: comboPlans.filter((p) => p.id === 'mcd-CMB2'),
      members: [{ alias: '我', stapleMin: 1, noSugaryDrink: true, demands: [{ id: 'd1', keyword: '怡泉', qty: 1 }] }],
      mode: 'cheapest',
    }, 1);
    const mine = rs[0]?.memberAllocations?.[0];
    const names = (mine?.items ?? []).map((i) => i.itemName);
    check(!names.includes('怡泉苏打水'), '含糖未知饮料未被分配给 noSugaryDrink 成员（保守处理）', names.join('+') || '空');
  }
}

// ========== R05 Top-K 完整购物篮割 ==========
console.log('【R05】Top-K：A+B 之后必须能得到 A+C（不再强制每个已购计划都变化）');
{
  const plans = [
    plan1('A', '主食', 'A主食', 400, 1000, { staple: true }),
    plan1('B', '饮料', 'B饮料', 100, 100, { drink: true }),
    plan1('C', '饮料', 'C饮料', 100, 200, { drink: true }),
  ];
  const input = {
    plans,
    members: [{ alias: '我', stapleMin: 1, demands: [{ id: 'd1', keyword: '饮料', qty: 1 }] }],
    mode: 'cheapest',
  };
  const rs = await O.optimizeTopK(input, 3);
  const combos = rs.map((r) => r.assignments.map((a) => a.planId).sort().join('+'));
  check(rs.length >= 2, `返回至少 2 个购物篮（旧实现因强制每个计划变化只返回 1）`, String(rs.length));
  check(combos.includes('A+B'), '最优购物篮 A+B（¥11）', combos.join(' | '));
  check(combos.includes('A+C'), '次优购物篮 A+C（¥12，A 不变）也被返回', combos.join(' | '));
  check(new Set(combos).size === combos.length, '返回的购物篮互不相同');
}

// ========== P2 营养不完整措辞 ==========
console.log('【P2】营养不完整时不得使用「达成/偏差 0」语言');
{
  const mi = (code, name, extra = {}) => ({
    code, name, priceCents: 1500, originalPriceCents: 1500, category: '单品', tags: [],
    kcal: extra.kcal ?? 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0,
    isCombo: false, fastCarb: 0, isVeggie: false, isStaple: !!extra.isStaple,
    nutritionMatched: extra.nutritionMatched ?? true,
  });
  const { singlePlans } = O.buildPlansFromMenuItems([
    mi('UNK', '未知汉堡', { isStaple: true, kcal: 0, nutritionMatched: false }),
  ], { includeSingle: true });
  const r = await O.optimize({
    plans: singlePlans,
    members: [{ alias: '我', mustHave: ['汉堡'] }],
    mode: 'fit', kcalBudget: 600, fitToleranceKcal: 150,
  });
  const fitNote = r.notes.find((n) => n.includes('热量贴合')) ?? '';
  check(r.nutritionCompleteness?.complete === false, '完整性如实标注不完整（unknownCount>=1）', String(r.nutritionCompleteness?.unknownCount));
  check(fitNote.includes('按已知部分合计'), '理由文案含「按已知部分合计」', fitNote.slice(0, 80));
  check(fitNote.includes('营养未收录'), '理由文案含「含 N 项营养未收录」', fitNote.slice(0, 80));
  check(!fitNote.includes('偏差'), '理由文案不含「偏差 0」等完整达成语言', fitNote.slice(0, 80));
}

console.log(failures === 0 ? `\n[v142-optimizer] 全部通过（build=${BASE}）` : `\n[v142-optimizer] ${failures} 项未通过 ✗`);
process.exit(failures > 0 ? 1 : 0);
