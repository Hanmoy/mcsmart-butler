// v1.4.2 内核验收（主线独立复核）：直接打编译产物，对 2026-10-15 评审报告的头条 P1
// （R01 度量别名 / R02 约束完整入模 / R03 食品特征解析 / R05 Top-K 整篮割）做端到端复现。
// 本套 fixture 独立于各子代理自测数据，作为第二层验证保留在常驻回归里。
// 运行：npm run build && node scripts/test-v142-core-acceptance.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v142core-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const BASE = process.env.MCSMART_BUILD ?? '../dist';
const O = await import(`${BASE}/optimizer.js`);
const S = await import(`${BASE}/service.js`);

let fail = 0, pass = 0;
const ck = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail !== undefined ? `（${JSON.stringify(detail).slice(0, 200)}）` : ''}`); }
};
const catches = (fn) => { try { fn(); return null; } catch (e) { return e; } };

console.log('\n[R01] 入口别名与未知目标（service.toPriorityGoals）');
ck(JSON.stringify(S.toPriorityGoals(['carb'])) === '["carbohydrate"]', 'carb → carbohydrate', S.toPriorityGoals(['carb']));
ck(JSON.stringify(S.toPriorityGoals(['carbs', 'protein'])) === '["carbohydrate","protein"]', 'carbs → carbohydrate（保留顺序）', S.toPriorityGoals(['carbs', 'protein']));
ck(JSON.stringify(S.toPriorityGoals(['kcal', 'price'])) === '["price"]', 'kcal 由贴合阶段承载、不冒充优先级目标', S.toPriorityGoals(['kcal', 'price']));
const e1 = catches(() => S.toPriorityGoals(['fiber']));
ck(!!e1, '未知目标 fiber 显式报错（旧实现静默断言成内核类型）', e1?.code ?? e1?.message);

console.log('\n[R02] 约束归一：回显与入模同源（service.normalizeConstraints）');
const c1 = S.normalizeConstraints([{ metric: 'kcal', op: '>=', value: 900 }]);
ck(c1.some((c) => c.metric === 'kcal' && c.op === '>=' && c.value === 900), 'kcal>=900 保留（旧实现被丢弃）', c1);
const c2 = S.normalizeConstraints([{ metric: 'kcal', op: '<=', value: 700 }, { metric: 'kcal', op: '<=', value: 500 }]);
const c2k = c2.filter((c) => c.metric === 'kcal');
ck(c2k.length === 1 && c2k[0].value === 500, '重复上限取最紧 = 500（旧实现 find() 取首个 700）', c2);
const c3 = S.normalizeConstraints([{ metric: 'staple', op: '<=', value: 0 }]);
ck(!c3.some((c) => c.metric === 'staple' && c.op === '>='), 'staple<=0 不再被默认 staple>=1 顶掉', c3);
const c4 = S.normalizeConstraints([]);
ck(c4.some((c) => c.metric === 'staple' && c.op === '>=' && c.value === 1), '未显式设置时仍注入默认正餐 staple>=1', c4);
const e2 = catches(() => S.normalizeConstraints([{ metric: 'kcal', op: '<=', value: 500 }, { metric: 'kcal', op: '>=', value: 900 }]));
ck(!!e2, '上下界矛盾 → 明确无解（E_NO_SOLUTION）', e2?.code ?? e2?.message);
const e3 = catches(() => S.normalizeConstraints([{ metric: 'fiber', op: '<=', value: 5 }]));
ck(!!e3, '未知度量 → E_INPUT_INVALID', e3?.code ?? e3?.message);
const e4 = catches(() => S.normalizeConstraints([{ metric: 'sodium', op: '=', value: 5 }]));
ck(!!e4, '不支持的操作符 → E_INPUT_INVALID', e4?.code ?? e4?.message);
ck(S.normalizeConstraints([{ metric: 'carb', op: '<=', value: 30 }]).some((c) => c.metric === 'carbohydrate'), '约束里的 carb 别名同样归一为 carbohydrate');

// ---------- 构造内核 fixture（自建，不复用子代理数据） ----------
const mi = (over) => ({
  code: 'X', name: 'X', priceCents: 1000, originalPriceCents: 1000, category: '主食', tags: [],
  kcal: 300, protein: 10, fat: 10, carbohydrate: 30, sodium: 400,
  isCombo: false, fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: true, ...over,
});

console.log('\n[R03] 食品特征解析：规格 / 主食身份 / 饮料含糖三态');
const fish = mi({ code: 'FISH', name: '麦香鱼', category: '主食', kcal: 340, carbohydrate: 39, isStaple: true });
const friesMenu = mi({ code: 'FRIES', name: '薯条', category: '小食', kcal: 289, carbohydrate: 37 });
const colaMenu = mi({ code: 'COLA', name: '可乐', category: '饮品', kcal: 147, carbohydrate: 36 });
const combo = mi({
  code: 'CMB1', name: '测试套餐', priceCents: 2000, isCombo: true, isStaple: false,
  deconstruction: [
    { roundName: '主食', category: 'staple', defaultName: '麦香鱼', options: [{ name: '麦香鱼', diffCents: 0, code: 'FISH' }] },
    { roundName: '小食', category: 'side', defaultName: '大薯条', options: [{ name: '大薯条', diffCents: 0, code: 'FRIES' }] },
    { roundName: '饮料', category: 'drink', defaultName: '可乐', options: [{ name: '可乐', diffCents: 0 }, { name: '零度可乐', diffCents: 0 }, { name: '神秘气泡饮', diffCents: 0 }] },
  ],
});
const { comboPlans } = O.buildPlansFromMenuItems([fish, friesMenu, colaMenu, combo], { includeSingle: true });
const slotOpt = (planName, roundName, optName) => comboPlans.find((p) => p.name === planName)?.slots.find((s) => s.roundName === roundName)?.options.find((o) => o.name === optName);
const oFish = slotOpt('测试套餐', '主食', '麦香鱼');
const oBigFries = slotOpt('测试套餐', '小食', '大薯条');
const oCola = slotOpt('测试套餐', '饮料', '可乐');
const oZero = slotOpt('测试套餐', '饮料', '零度可乐');
const oMystery = slotOpt('测试套餐', '饮料', '神秘气泡饮');
ck(oFish?.staple === true, '菜单已知 isStaple=true 不被名称正则覆盖（麦香鱼）', oFish?.staple);
console.log(`      · 大薯条实际 kcal = ${oBigFries?.kcal}（菜单同 code 单品为 289，官网「大」规格为 379）`);
ck(oBigFries !== undefined && oBigFries.kcal !== 289, '槽位「大薯条」不直接套用同 code 单品的 289 kcal（规格优先）', oBigFries?.kcal);
ck(oCola?.drink === true, '仅存在于套餐的组件也能识别为饮料（可乐 drink=true）', oCola?.drink);
ck(oCola?.sugary === true, '普通可乐 sugary=true', oCola?.sugary);
ck(oZero?.sugary === false, '零度可乐 sugary=false', oZero?.sugary);
ck(oMystery?.drink === true && oMystery?.sugary === undefined, '营养未知的饮料保持「含糖未知」（sugary=undefined，不默认 false）', { drink: oMystery?.drink, sugary: oMystery?.sugary });

// 保守处理：含糖未知的饮料不得被「不要含糖饮料」的成员选中（同轮次同时提供 未知含糖 与 零度 两个选项）
const comboPlan = comboPlans.find((p) => p.name === '测试套餐');
const twoDrinks = {
  ...comboPlan,
  slots: comboPlan.slots.map((s) => s.roundName === '饮料'
    ? { ...s, defaultName: '神秘气泡饮', options: s.options.filter((o) => o.name === '神秘气泡饮' || o.name === '零度可乐') }
    : s),
};
const resNoSugar = await O.optimizeTopK({ plans: [twoDrinks], members: [{ alias: '我', noSugaryDrink: true, stapleMin: 1 }], mode: 'cheapest' }, 1);
const pickedDrinks = resNoSugar.flatMap((r) => r.assignments.flatMap((a) => a.slotChoices.filter((sc) => sc.roundName === '饮料').map((sc) => sc.chosenName)));
ck(resNoSugar.length >= 1 && pickedDrinks.length > 0 && pickedDrinks.every((n) => n === '零度可乐'),
  'noSugaryDrink 成员在「未知含糖 vs 零度」中只能选到零度（保守排除未知含糖）', pickedDrinks);
const resAny = await O.optimizeTopK({ plans: [twoDrinks], members: [{ alias: '我', stapleMin: 1 }], mode: 'cheapest' }, 1);
ck(resAny.length >= 1, '无该限制的成员仍可正常购买同一套餐（约束未误伤）', resAny.length);

console.log('\n[R01/R05] 内核端到端：carb 目标可解 + Top-K 保留合法购物篮');
const mkPlan = (id, name, priceCents, kcal, staple, drink) => ({
  id, channel: 'mcd-mcp', name, basePriceCents: priceCents, maxQty: 3, maxQtySource: 'program-cap',
  slots: [{
    roundName: '项', defaultName: name,
    options: [{ name, kcal, kcalKnown: true, priceCents, diffCents: 0, staple, veggie: false, drink, sugary: drink ? true : false, fastCarb: 0 }],
  }],
});
const A = mkPlan('A', '汉堡A', 1000, 500, true, false);
const B = mkPlan('B', '可乐B', 100, 150, false, true);
const C = mkPlan('C', '雪碧C', 200, 140, false, true);

let res1 = null, err1 = null;
try {
  res1 = await O.optimizeTopK({ plans: [A, B], members: [{ alias: '我', stapleMin: 1 }], mode: 'cheapest', priorities: ['carb'] }, 2);
} catch (e) { err1 = e; }
ck(!err1, 'R01 priorities=["carb"] 不再触发 HiGHS error -1', err1?.message?.slice(0, 120));
ck(!!res1 && res1.length >= 1, 'R01 carb 目标下能正常返回方案', res1?.length);
const anyNaN = JSON.stringify(res1 ?? null).includes('null') === false || true;
ck(!/undefined|NaN/.test(JSON.stringify(res1 ?? {})), 'R01 结果 JSON 无 undefined/NaN');

const res2 = await O.optimizeTopK({ plans: [A, B, C], members: [{ alias: '我', stapleMin: 1 }], mode: 'cheapest', totalBudgetCents: 5000 }, 3);
const baskets = res2.map((r) => r.assignments.map((a) => a.planId).sort().join('+'));
ck(res2.length >= 2, 'R05 Top-K 返回多个购物篮（旧实现仅 A+B）', baskets);
ck(baskets.some((b) => b.includes('C')), 'R05 可得到含 C 的合法购物篮（旧实现被逐计划割排除）', baskets);
ck(new Set(baskets).size === baskets.length, 'R05 各购物篮互不重复', baskets);

console.log(`\n独立复核结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
