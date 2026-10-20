// v1.4.3 批量落库支撑修复验收（三处真实缺陷的回归）：
//   B1-B3 营养补录层：单字品名（「派」）精确别名必须命中；模糊包含仍须双向 ≥2 字防错配。
//   B4    配方落库：saveRecipe 缺省 source 必须补成 'user'（否则读回被当作预置层，不可删/不可识别）。
//   B5-B6 配方候选链：同券名多配方时按证据强度排序（combo-name > explicit > pattern，同档用户层优先），
//         核验期逐档回退，首条占位配方失效不再导致整券笼统未核验。
// 运行：npm run build && node scripts/test-v143-batch-coverage.mjs
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v143cov-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const BASE = process.env.MCSMART_BUILD ?? '../dist';
const NS = await import(`${BASE}/nutritionSupplements.js`);
const VR = await import(`${BASE}/voucherRecipes.js`);
const DD = await import(`${BASE}/dealDetail.js`);

let fail = 0, pass = 0;
const ck = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  OK ${label}`); }
  else { fail++; console.log(`  NG ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail).slice(0, 240)}` : ''}`); }
};

const SUP_FILE = join(TEST_HOME, 'nutrition-supplements.json');
const REC_FILE = join(TEST_HOME, 'voucher-recipes.json');
function resetSupplements() {
  NS._resetSupplementCache();
  try { rmSync(SUP_FILE, { force: true }); } catch { /* */ }
  NS._resetSupplementCache();
}
function resetRecipes() {
  VR._resetRecipeCache();
  try { rmSync(REC_FILE, { force: true }); } catch { /* */ }
  VR._resetRecipeCache();
}

// ---------------- B1-B3 营养补录层：单字品名 ----------------
console.log('\n[B1] 单字品名（「派」）精确别名必须命中补录层');
resetSupplements();
NS.saveNutritionSupplement({
  id: 'ns-pie', name: '派', matchNames: ['派'],
  kcal: 232, protein: 2, fat: 12, carbohydrate: 28, sodium: 159,
  source: '麦当劳官网营养计算器（香芋派）', sourceType: 'official',
  sourceUrl: 'https://www.mcdonalds.com.cn/nutrition_calculator',
  evidence: '官网营养计算器「香芋派」每份 971kJ / 232kcal / P2 / F12 / C28 / Na159；按官方菜单派类合并粒度映射到单品「派」',
  verifiedAt: '2026-10-15', verifiedBy: 'import',
});
const p1 = NS.resolveComponentNutrition('派', '派');
ck(p1.matched === true, '「派」命中补录层（旧实现因整体 length>=2 门槛恒不命中）', p1);
ck(p1.kcal === 232 && p1.sourceKind === 'supplement', '取到 232kcal 且来源类别=supplement', p1);
const p2 = NS.resolveComponentNutrition('派', '');
ck(p2.matched === true, '无规格短语时同样命中（specRaw 回落到 name）', p2);

console.log('\n[B2] 单字品名不得被模糊包含误吸（防错配）');
const p3 = NS.resolveComponentNutrition('苹果派', '苹果派');
ck(p3.matched === false, '「苹果派」不被单字「派」模糊吸走（官网无、补录层亦不应命中）', p3);
const p4 = NS.resolveComponentNutrition('蓝莓派', '蓝莓派');
ck(p4.matched === false, '「蓝莓派」同上（未被「派」吸走）', p4);
const p5 = NS.resolveComponentNutrition('香芋派', '香芋派');
ck(p5.matched === true && p5.sourceKind === 'official-web', '「香芋派」仍由官网权威库命中（官网优先于补录层）', p5);
const p6 = NS.resolveComponentNutrition('菠萝派', '菠萝派');
ck(p6.matched === true && p6.sourceKind === 'official-web' && p6.kcal === 221, '「菠萝派」由官网权威库命中（221kcal），未被单字补录顶替', p6);

console.log('\n[B3] 多字品名的模糊包含仍生效（防护未过度收紧）');
resetSupplements();
NS.saveNutritionSupplement({
  id: 'ns-corn-cup', name: '玉米杯', matchNames: ['玉米杯'],
  kcal: 53, protein: 2, fat: 1, carbohydrate: 7, sodium: 1,
  source: '麦当劳官网营养计算器', sourceType: 'official',
  sourceUrl: 'https://www.mcdonalds.com.cn/nutrition_calculator',
  evidence: '官网营养计算器「玉米杯」每份 223kJ / 53kcal', verifiedAt: '2026-10-15',
});
const c1 = NS.resolveComponentNutrition('大杯玉米杯', '大杯玉米杯');
ck(c1.matched === true, '「大杯玉米杯」按包含关系命中「玉米杯」补录', c1);

// ---------------- B4 配方落库 source 缺省 ----------------
console.log('\n[B4] saveRecipe 缺省 source 必须补成 user（否则读回被当作预置层）');
resetRecipes();
VR.saveRecipe({
  id: 'rcp-src-default', name: '来源缺省券', matchNames: ['来源缺省券'], resolve: 'explicit',
  channel: 'meituan', channelLabel: '美团团购（到店）',
  items: [{ mode: 'fixed', keyword: '薯条', qty: 1 }],
  conditions: { orderType: 'instore' }, priceCents: 1000, originalPriceCents: 0,
  buyPath: 'x', redeemPath: 'y', evidence: 'e', verifiedAt: '2026-10-15', ruleVersion: 'vision-manual-v1',
  // source 故意缺省
});
const srcRec = VR.loadRecipes().find((r) => r.id === 'rcp-src-default');
ck(srcRec?.source === 'user', "缺省 source 落库后被补成 'user'（旧实现留下 undefined，读回被误当预置层）", srcRec?.source);
const rawFile = JSON.parse(readFileSync(REC_FILE, 'utf-8'));
const rawRec = (rawFile.recipes ?? rawFile).find((r) => r.id === 'rcp-src-default');
ck(rawRec?.source === 'user', "磁盘文件内 source 亦为 'user'（可审计）", rawRec?.source);
ck(VR.removeRecipe('rcp-src-default') === true, 'user 层配方可被删除（预置层不可删，可作为层归属的旁证）');

// ---------------- B5 候选链排序 ----------------
console.log('\n[B5] matchRecipeCandidates 按证据强度排序（combo-name > explicit > pattern）');
resetRecipes();
// 真实预置层：rcp-maiheung-3（combo-name 占位）+ rcp-maixiangji-3-v1（v1.4.5 并入的 explicit 构成）
const base5 = VR.matchRecipeCandidates('麦香鸡三件套');
ck(base5.length === 2 && base5[0].resolve === 'combo-name' && base5.every((r) => r.source !== 'user'),
  '仅预置层时命中 combo-name 占位 + explicit 构成（均为随包配方）', base5.map((r) => `${r.id}/${r.resolve}/${r.source}`));
// 用户层补一条同名 explicit（券面核验构成）
VR.saveRecipe({
  id: 'rcp-maixiangji-explicit', name: '麦香鸡三件套', matchNames: ['麦香鸡三件套'], resolve: 'explicit',
  channel: 'meituan', channelLabel: '美团团购（到店）',
  items: [{ mode: 'fixed', keyword: '麦香鸡', qty: 1 }, { mode: 'fixed', keyword: '薯条', qty: 1 }, { mode: 'fixed', keyword: '可乐', qty: 1 }],
  conditions: { orderType: 'instore' }, priceCents: 1990, originalPriceCents: 0,
  buyPath: 'x', redeemPath: 'y', evidence: 'e', verifiedAt: '2026-10-15', ruleVersion: 'vision-manual-v1', source: 'user',
});
const cands = VR.matchRecipeCandidates('麦香鸡三件套');
ck(cands.length === 3, '同券名的预置占位与两条 explicit（随包 + 用户层）同时进入候选（旧实现只取其一）', cands.map((r) => r.id));
ck(cands[0]?.resolve === 'combo-name', '首位为 combo-name（官方同名套餐证据最强）', cands[0]?.resolve);
ck(cands.slice(1).every((r) => r.resolve === 'explicit') && cands.some((r) => r.id === 'rcp-maixiangji-explicit' && r.source === 'user'),
  '其后为 explicit 档，含用户层配方（可回退档）', cands.map((r) => `${r.id}/${r.source}`));
ck(VR.matchRecipe('麦香鸡三件套')?.id === cands[0].id, 'matchRecipe 返回最高证据强度的一条（与候选链首位一致）', VR.matchRecipe('麦香鸡三件套')?.id);

// ---------------- B6 逐档回退 ----------------
console.log('\n[B6] 首档 combo-name 失效时回退 explicit（不再整券笼统未核验）');
{
  // 预置层占位：combo-name 指向「同名券」官方套餐，但菜单里没有 → 该档必失败
  VR.saveRecipe({
    id: 'rcp-preset-placeholder', name: '同名券', matchNames: ['同名券'], resolve: 'combo-name',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'combo-ref', keyword: '同名券', qty: 1, comboName: '同名券' }],
    conditions: { orderType: 'instore' }, priceCents: 1000, originalPriceCents: 0,
    buyPath: 'x', redeemPath: 'y', evidence: 'e', verifiedAt: '2026-10-15', ruleVersion: 'combo-name-v1',
  });
  // 用户层：explicit 构成「薯条×1」，菜单里有同名单品 → 该档应成功
  VR.saveRecipe({
    id: 'rcp-explicit-real', name: '同名券', matchNames: ['同名券'], resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'fixed', keyword: '薯条', qty: 1 }],
    conditions: { orderType: 'instore' }, priceCents: 1000, originalPriceCents: 0,
    buyPath: 'x', redeemPath: 'y', evidence: 'e', verifiedAt: '2026-10-15', ruleVersion: 'vision-manual-v1',
  });
  const chain = VR.matchRecipeCandidates('同名券');
  ck(chain.length === 2 && chain[0].resolve === 'combo-name', '候选链首档为 combo-name 占位', chain.map((r) => r.id));
  const menu = {
    items: [{ code: 'F1', name: '薯条', isCombo: false, priceCents: 1350, kcal: 289, protein: 3, fat: 13, carbohydrate: 37, sodium: 220, category: '', tags: [], fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: true }],
    unmatched: 0, comboCount: 0, comboUnmatched: 0, table: new Map(),
  };
  const client = { async call() { throw new Error('本用例不应触网（combo-name 档应在本地即判失败）'); } };
  const rec = await DD.verifyDealContents(client, 'STORE-1', { name: '同名券' }, menu);
  ck(rec.status === 'pattern-verified', '回退到 explicit 档并核验通过（旧实现停在 combo-name 档 → unverified）', rec.status);
  ck(rec.recipeId === 'rcp-explicit-real', '命中记录指向真正生效的用户层配方', rec.recipeId);
  ck(rec.contents?.[0]?.keyword === '薯条' && rec.contents?.[0]?.qty === 1, '构成=薯条×1（券面核验构成，非占位猜测）', rec.contents?.[0]);
}

console.log(fail === 0 ? `\n全部通过 ✓（${pass} 项）` : `\n${fail} 项未通过 ✗（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
