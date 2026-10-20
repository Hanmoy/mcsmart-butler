// v1.4.3 营养补充链验收：官网权威库 → 用户补录层 → 未知（未知不得当作 0 卡）。
// 背景：官网营养计算器库（93 产品）未收录部分套餐组件（实测券面主食「双层脆鸡堡」不在库中），
// 导致券槽位营养未知、无法参与热量贴合类精算。本套验证补录层能补上该缺口且不覆盖官网权威值。
// 运行：npm run build && node scripts/test-v143-nutrition-core.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v143nutri-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const BASE = process.env.MCSMART_BUILD ?? '../dist';
const NS = await import(`${BASE}/nutritionSupplements.js`);
const O = await import(`${BASE}/optimizer.js`);

let fail = 0, pass = 0;
const ck = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  OK ${label}`); }
  else { fail++; console.log(`  NG ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail).slice(0, 240)}` : ''}`); }
};
const catches = (fn) => { try { fn(); return null; } catch (e) { return e; } };

function resetSupplements() {
  NS._resetSupplementCache();
  // 清空用户层文件，确保用例互不污染
  try { rmSync(join(TEST_HOME, 'nutrition-supplements.json'), { force: true }); } catch { /* */ }
  NS._resetSupplementCache();
}

console.log('\n[N1] 未补录时保持「未知」而非 0 卡');
resetSupplements();
const r1 = NS.resolveComponentNutrition('双层脆鸡堡');
ck(r1.matched === false, '官网库未收录的「双层脆鸡堡」解析为未知（matched=false）', r1);
ck(r1.kcal === 0 && r1.sourceKind === 'none', '未知时 sourceKind=none，kcal 不可用', r1);

console.log('\n[N2] 补录后取到补录值并透出来源');
resetSupplements();
NS.saveNutritionSupplement({
  id: 'sup-shuangceng-cheeseburger', name: '双层脆鸡堡',
  kcal: 468, protein: 23, fat: 26, carbohydrate: 39, sodium: 780,
  source: '麦当劳 APP 商品详情页', evidence: '券面图可见「双层脆鸡堡」，构成=官方同名单品；营养取 APP 商品页同名单品值',
  verifiedAt: '2026-10-15', verifiedBy: 'agent-vision',
});
NS._resetSupplementCache();
const r2 = NS.resolveComponentNutrition('双层脆鸡堡');
ck(r2.matched === true, '补录后命中（matched=true）', r2);
ck(r2.sourceKind === 'supplement', '来源标记为 supplement', r2.sourceKind);
ck(r2.kcal === 468, 'kcal 等于补录值', r2.kcal);
ck(!!r2.sourceLabel && r2.sourceLabel.includes('麦当劳 APP 商品详情页'), '来源说明可透出', r2.sourceLabel);

console.log('\n[N3] 官网权威值优先，补录不得覆盖');
resetSupplements();
NS.saveNutritionSupplement({
  id: 'sup-jushipei', name: '巨无霸', kcal: 999, protein: 0, fat: 0, carbohydrate: 0, sodium: 0,
  source: '测试用错误值', evidence: '用于验证官网优先', verifiedAt: '2026-10-15',
});
NS._resetSupplementCache();
const r3 = NS.resolveComponentNutrition('巨无霸');
ck(r3.matched === true && r3.sourceKind === 'official-web', '官网已收录品项仍取官网值（补录不覆盖）', r3);
ck(r3.kcal !== 999 && r3.kcal > 0, '未取补录的 999，取官网真实值', r3.kcal);

console.log('\n[N4] 规格匹配：补录规格不一致不命中');
resetSupplements();
NS.saveNutritionSupplement({
  id: 'sup-fries-da', name: '薯条', spec: '大',
  kcal: 379, protein: 4, fat: 17, carbohydrate: 49, sodium: 280,
  source: '官网营养计算器', evidence: '规格补录', verifiedAt: '2026-10-15',
});
NS._resetSupplementCache();
const r4a = NS.resolveComponentNutrition('大薯条');
ck(r4a.sourceKind === 'official-web', '「大薯条」先从官网规格库命中（官网优先）', r4a);
const r4b = NS.resolveComponentNutrition('薯条', '大');
ck(r4b.sourceKind === 'official-web' || r4b.matched === true, '官网规格优先，补录不劣化已有规格链', r4b);

console.log('\n[N5] 导入与删除');
resetSupplements();
const imp = NS.importNutritionSupplements({ supplements: [
  { name: '测试甲', kcal: 100, protein: 5, fat: 2, carbohydrate: 10, sodium: 150, source: '测试', evidence: 'e', verifiedAt: '2026-10-15' },
  { name: '测试乙', kcal: 200, protein: 6, fat: 3, carbohydrate: 20, sodium: 250, source: '测试', evidence: 'e', verifiedAt: '2026-10-15' },
  { name: '缺热量', source: '测试', evidence: 'e', verifiedAt: '2026-10-15' },
] });
ck(imp.imported === 2 && imp.skipped === 1, '导入 2 条合法、跳过 1 条非法（缺 kcal）', imp);
NS._resetSupplementCache();
const supList = NS.loadNutritionSupplements();
const supId = supList.find((s) => s.name === '测试甲')?.id;
ck(!!supId && supId.startsWith('sup-'), '导入项生成稳定 id', supId);
ck(NS.removeNutritionSupplement(supId) === true, '删除命中项返回 true', supId);
NS._resetSupplementCache();
ck(NS.resolveComponentNutrition('测试甲').matched === false, '删除后不再命中', null);

console.log('\n[N6] 端到端：补录后套餐组件进求解池时带来源');
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
// 券面主食「双层脆鸡堡」既作为套餐组件出现，也有一份同名但营养未知的菜单条目。
// 两条路径都必须使用统一补录解析链，不得把未知单品的 0 当真实值。
const items = [
  mi('S-CHICKEN', '双层脆鸡堡', 2500, { nutritionMatched: false, isStaple: true }),
  mi('CMBT', '测试三件套', 2300, {
    isCombo: true,
    deconstruction: [
      { roundName: '主食', defaultName: '双层脆鸡堡', options: [{ name: '双层脆鸡堡', diffCents: 0 }] },
      { roundName: '小食', defaultName: '中薯条', options: [{ name: '中薯条', diffCents: 0 }] },
      { roundName: '饮料', defaultName: '可乐', options: [{ name: '可乐', diffCents: 0 }, { name: '零度可乐', diffCents: 0 }] },
    ],
  }),
];
resetSupplements();
NS.saveNutritionSupplement({
  id: 'sup-shuangceng-cheeseburger', name: '双层脆鸡堡',
  kcal: 468, protein: 23, fat: 26, carbohydrate: 39, sodium: 780,
  source: '麦当劳 APP 商品详情页', evidence: '识图核验', verifiedAt: '2026-10-15', verifiedBy: 'agent-vision',
});
NS._resetSupplementCache();
const { comboPlans, singlePlans } = O.buildPlansFromMenuItems(items, { includeSingle: true });
ck(comboPlans.length === 1 && comboPlans[0].name === '测试三件套', '构造的套餐进入计划池', comboPlans.map((p) => p.name));
const stapleOpt = comboPlans[0]?.slots.find((s) => s.roundName === '主食')?.options[0];
ck(!!stapleOpt && stapleOpt.kcalKnown === true, '补录后套餐组件的营养为已知（旧实现 kcalKnown=false）', stapleOpt);
ck(stapleOpt?.kcal === 468, '套餐组件热量取补录值 468', stapleOpt?.kcal);
ck(!!stapleOpt?.nutritionSource && stapleOpt.nutritionSource.includes('麦当劳 APP 商品详情页'), '套餐组件透出补录来源', stapleOpt?.nutritionSource);
const singleChicken = singlePlans.find((p) => p.name === '双层脆鸡堡')?.slots[0]?.options[0];
ck(singleChicken?.kcalKnown === true && singleChicken.kcal === 468, '菜单中已存在但 nutritionMatched=false 的单品也回落补录层', singleChicken);
ck(singleChicken?.nutritionSource?.includes('麦当劳 APP 商品详情页'), '未知菜单单品透出来源', singleChicken?.nutritionSource);

console.log('\n[N7] 无补录时同一 fixture 保持未知（互不污染）');
resetSupplements();
const clean = O.buildPlansFromMenuItems(items, { includeSingle: true });
const stapleNoSup = clean.comboPlans[0]?.slots.find((s) => s.roundName === '主食')?.options[0];
ck(stapleNoSup?.kcalKnown === false, '清空补录后套餐组件回到未知状态', stapleNoSup);
ck(stapleNoSup?.nutritionSource === undefined, '未知时不伪造来源', stapleNoSup?.nutritionSource);
const singleUnknown = clean.singlePlans.find((p) => p.name === '双层脆鸡堡')?.slots[0]?.options[0];
ck(singleUnknown?.kcalKnown === false && singleUnknown.kcal === 0, '清空补录后未知菜单单品仍不伪装为 0 卡', singleUnknown);

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
if (fail > 0) process.exit(1);
