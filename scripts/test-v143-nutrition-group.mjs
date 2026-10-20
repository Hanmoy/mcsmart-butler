// v1.4.3 群组内核营养补录解析链验收。
// 覆盖用户券 combo-ref 复用官方套餐槽位时：菜单已知营养优先、未知菜单单品回落补录、营养来源透出。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v143-group-'));
process.env.MCSMART_HOME = TEST_HOME;
process.env.MEITUAN_UNION_APPKEY = '';
process.env.MEITUAN_UNION_APPSECRET = '';
process.env.MCSMART_DISABLE_BUNDLED_UNION = '1';
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const BASE = process.env.MCSMART_BUILD ?? '../dist';
const K = await import(`${BASE}/groupKernel.js`);
const NS = await import(`${BASE}/nutritionSupplements.js`);
NS._resetSupplementCache();

let pass = 0, fail = 0;
const ck = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  OK ${label}`); }
  else { fail++; console.log(`  NG ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 220)}`}`); }
};

const menuItems = [
  {
    code: 'CHICKEN-UNKNOWN', name: '双层脆鸡堡', priceCents: 2500, originalPriceCents: 2500,
    category: '主食', tags: [], kcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0,
    isCombo: false, fastCarb: 0, isVeggie: false, isStaple: true, nutritionMatched: false,
  },
  {
    code: 'FRIES-OF', name: '中薯条', priceCents: 1350, originalPriceCents: 1350,
    category: '小食', tags: [], kcal: 289, protein: 4, fat: 15, carbohydrate: 34, sodium: 210,
    isCombo: false, fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: true,
  },
  {
    code: 'COMBO-TEST', name: '双层脆鸡堡三件套', priceCents: 2990, originalPriceCents: 2990,
    category: '套餐', tags: [], kcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0,
    isCombo: true, fastCarb: 0, isVeggie: false, isStaple: true, nutritionMatched: false,
    deconstruction: [
      { roundName: '主食', roundId: 'round-staple', category: 'staple', defaultName: '双层脆鸡堡', options: [{ name: '双层脆鸡堡', diffCents: 0, code: 'CHICKEN-UNKNOWN' }] },
      { roundName: '小食', roundId: 'round-side', category: 'side', defaultName: '中薯条', options: [{ name: '中薯条', diffCents: 0, code: 'FRIES-OF' }] },
    ],
  },
];
const menu = { items: menuItems, unmatched: 1, comboCount: 1, comboUnmatched: 0, table: new Map() };
const userVoucher = {
  id: 'user-nutrition-voucher', channel: 'owned', channelLabel: '用户自持券', kind: 'combo',
  name: '核验三件套券', priceCents: 1990, originalPriceCents: 2990,
  items: [{ mode: 'combo-ref', keyword: 'COMBO-TEST', comboName: '双层脆鸡堡三件套', qty: 1 }],
  constraints: { orderType: 'instore' }, buyPath: '用户记录', redeemPath: '用户记录',
  verifiedAt: '2026-10-15', source: 'user', evidence: '测试构造的官方同名套餐引用',
};
const mock = { async call() { throw new Error('离线测试不调用上游'); } };
const input = { storeCode: 'LOCAL-STORE', storeName: '本地构造门店', city: '上海' };

console.log('\n[G1] 没有补录时，未知营养不得变成 0 卡假已知');
let recalled = await K.recallChannelPlans(mock, input, menu, [userVoucher]);
let plan = recalled.voucherPlans.find((p) => p.id === 'kv-user-nutrition-voucher');
let chicken = plan?.slots.find((s) => s.roundName === '主食')?.options[0];
ck(!!plan, '官方套餐引用成功映射到券计划', recalled.voucherPlans.map((p) => p.id));
ck(chicken?.kcalKnown === false && chicken.kcal === 0, '菜单营养未知且无补录时仍标未知', chicken);

console.log('\n[G2] 用户补录回落命中，官方菜单已知值仍优先');
NS.saveNutritionSupplement({
  id: 'sup-chicken', name: '双层脆鸡堡', kcal: 514, protein: 22.9, fat: 24.5, carbohydrate: 48.8, sodium: 1160,
  source: 'FatSecret Platform API', sourceType: 'third-party', sourceUrl: 'https://www.fatsecret.cn/',
  evidence: '每份数据；第三方来源，非官方，核验状态仍应由用户确认', verifiedAt: '2026-10-15', verifiedBy: 'user',
});
NS.saveNutritionSupplement({
  id: 'sup-fries-wrong', name: '中薯条', kcal: 999, protein: 99, fat: 99, carbohydrate: 99, sodium: 999,
  source: '测试值', sourceType: 'user', sourceUrl: 'https://example.invalid/', evidence: '用于验证官方优先', verifiedAt: '2026-10-15', verifiedBy: 'user',
});
NS._resetSupplementCache();
recalled = await K.recallChannelPlans(mock, input, menu, [userVoucher]);
plan = recalled.voucherPlans.find((p) => p.id === 'kv-user-nutrition-voucher');
chicken = plan?.slots.find((s) => s.roundName === '主食')?.options[0];
const fries = plan?.slots.find((s) => s.roundName === '小食')?.options[0];
ck(chicken?.kcalKnown === true && chicken.kcal === 514, '套餐券槽位回落至补录营养 514 kcal', chicken);
ck(chicken?.nutritionSource?.includes('FatSecret Platform API'), '券槽位携带来源类别与来源名', chicken?.nutritionSource);
ck(fries?.kcalKnown === true && fries.kcal === 289, 'MCP 菜单已知中薯条优先于同名补录 999 kcal', fries);
ck(fries?.code === 'FRIES-OF' && chicken?.code === 'CHICKEN-UNKNOWN', '券内组件 code 保留，便于官方 SKU/营养映射', { fries: fries?.code, chicken: chicken?.code });

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
if (fail) process.exit(1);
