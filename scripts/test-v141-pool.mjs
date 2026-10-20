// v1.4.1「全部团购入池」单测：S2b 官方同名单品核验 + 准入口径（食品单位 ≥1）+ 价格候选状态。
// 运行：node scripts/test-v141-pool.mjs（无网络依赖；MCP 客户端传入即抛桩——证明 S2b/S2 无命中路径零 MCP 调用）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 目录隔离：catalog upsert / 配方层不触碰真实用户数据
const HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v141-'));
process.env.MCSMART_HOME = HOME;

let failures = 0;
const check = (cond, label, detail) => {
  const tag = cond ? '✓' : '✗';
  if (!cond) failures++;
  console.log(`  ${tag} ${label}${detail !== undefined ? `（${typeof detail === 'object' ? JSON.stringify(detail).slice(0, 220) : detail}）` : ''}`);
};

const { verifyDealContents, verifyByOfficialSingle } = await import('../dist/dealDetail.js');
const { recipeFoodUnits } = await import('../dist/voucherRecipes.js');

// 桩客户端：S2b/未命中路径不应发起任何 MCP 调用
const strictClient = { call: async (tool) => { throw new Error(`不应发起 MCP 调用：${tool}`); } };

const mi = (name, over = {}) => ({
  code: `C-${name}`, name, priceCents: 1400, originalPriceCents: 1400,
  category: '小食', tags: [], kcal: 300, protein: 12, fat: 14, carbohydrate: 28, sodium: 500,
  isCombo: false, fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: true, ...over,
});
const menu = (items) => ({ items, unmatched: 0, comboCount: 0, comboUnmatched: 0, table: [] });

console.log('\n[T1] S2b 官方同名单品核验：券名=官方单品名 → 构成=该单品×1');
{
  const m = menu([mi('那么大鸡排'), mi('麦旋风', { category: '甜品' })]);
  // v1.4.5：预置配方已收录「那么大鸡排」的显式构成（web-cross-v2），
  //   verifyDealContents 会先命中配方（更强证据）。此处直接测 S2b 这一通路本身。
  const r = verifyByOfficialSingle('那么大鸡排', m);
  check(r?.status === 'menu-verified', '状态 menu-verified', r?.status);
  check(r?.ruleVersion === 'single-name-v1', '规则版本 single-name-v1', r?.ruleVersion);
  check(r?.contents?.length === 1 && r.contents[0].mode === 'fixed' && r.contents[0].keyword === '那么大鸡排' && r.contents[0].qty === 1, '构成 = fixed 那么大鸡排 ×1', r?.contents);
  check(recipeFoodUnits(r?.contents ?? [], m) === 1, '展开食品单位数 = 1（旧口径 ≥2 会挡在门外）');
}

console.log('\n[T2] 数量词直译（券面声明，非猜测）：买一送一/两个/第二个半价 → ×2；四重奏 → ×4');
{
  const m = menu([mi('麦旋风', { category: '甜品' }), mi('圆筒')]);
  for (const [name, wantQty] of [['麦旋风买一送一', 2], ['【第二个半价】两个麦旋风', 2], ['圆筒四重奏', 4]]) {
    const r = verifyByOfficialSingle(name, m);
    check(!!r && r.contents?.[0]?.qty === wantQty, `${name} → ×${wantQty}`, r?.contents);
  }
  // 多数量词取最大不叠乘（第二个半价 = 两个 = 2）
  const r2 = verifyByOfficialSingle('【第二个半价】两个麦旋风', m);
  check(r2?.contents?.[0]?.qty === 2, '「第二个半价」+「两个」不叠乘为 4', r2?.contents);
}

console.log('\n[T3] 多品打包/任选券名绝不单品化（红色红线）');
{
  const m = menu([mi('那么大鸡排'), mi('新地', { category: '甜品' }), mi('麦香鸡', { isStaple: true })]);
  const cases = [
    ['【买一送一】新地任选', '任选'],
    ['【肉食主义】小食2件自由拼', '自由拼'],
    ['脆汁鸡小食饮料三件套', '件套'],
    ['咸甜三拼超值组合', '拼'],
  ];
  for (const [name] of cases) {
    const r = verifyByOfficialSingle(name, m);
    check(r === null, `${name} → 不做单品核验`, r);
  }
}

console.log('\n[T4] 归一化全名一致才采信：无同名单品 → 保持未核验（不猜测同义词）');
{
  const m = menu([mi('圆筒冰淇淋')]); // 券名「圆筒」≠官方「圆筒冰淇淋」：包含式匹配不采信
  const r = verifyByOfficialSingle('圆筒四重奏', m);
  check(r === null, '「圆筒四重奏」≠「圆筒冰淇淋」→ 不做单品核验', r);
  const rUnverified = await verifyDealContents(strictClient, 'S1', { name: '【未核验多品】神秘小食四件套' }, m);
  check(rUnverified.status === 'unverified', '无配方多品组合 → unverified', { status: rUnverified.status, reasonCode: rUnverified.reasonCode });
}

console.log('\n[T5] 修饰标签剥离后仍可命中（【】内是营销词，不参与身份判断）');
{
  const m = menu([mi('那么大鸡排')]);
  const r = verifyByOfficialSingle('【15天低价】那么大鸡排', m);
  check(!!r && r.contents?.[0]?.keyword === '那么大鸡排' && r.contents?.[0]?.qty === 1, '【15天低价】那么大鸡排 → ×1 那么大鸡排', r?.contents);
}

console.log('\n[T6] 准入口径：展开食品 ≥1 即可入池（单品券是合法购买单元），现金券（无内容）仍排除');
{
  const m = menu([mi('那么大鸡排')]);
  check(recipeFoodUnits([{ mode: 'fixed', keyword: '那么大鸡排', qty: 1 }], m) === 1, 'fixed×1 → 食品单位 1（≥1 准入）');
  check(recipeFoodUnits([{ mode: 'fixed', keyword: '麦旋风', qty: 2 }], m) === 2, 'fixed×2 → 食品单位 2');
  check(recipeFoodUnits([], m) === 0, '现金券无内容 → 0（排除）');
}

console.log('\n[T7] 随心配 1+1 在 S2b 之前被更高优先级通路命中（S0 预置配方 / S1 模式），不受打包词影响');
{
  const m = menu([mi('那么大鸡排')]);
  const r = await verifyDealContents(strictClient, 'S1', { name: '随心配1+1套餐' }, m);
  check(r.status === 'pattern-verified' && (r.source === 'recipe' || r.source === 'name-pattern'),
    '随心配 → pattern-verified（S0 配方或 S1 模式）', { status: r.status, source: r.source });
}

rmSync(HOME, { recursive: true, force: true });
console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
