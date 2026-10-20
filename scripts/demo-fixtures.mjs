// 生成静态 Demo / README GIF 使用的演示回执。
// 说明：使用真实 service 输出契约 + 离线 mock MCP 菜单，只替换网络边界；
//       不连接真实账户、不查询真实门店、不生成真实订单。输出为确定性数据。
// 运行：node --env-file-if-exists=.env scripts/demo-fixtures.mjs [--out docs/demo/fixtures]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = resolve(process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : join(root, 'docs/demo/fixtures'));
process.env.MCSMART_HOME = join(root, '.work/demo-home');
process.env.MEITUAN_UNION_APPKEY = '';
process.env.MEITUAN_UNION_APPSECRET = '';
process.env.MCSMART_DISABLE_BUNDLED_UNION = '1';

const S = await import('../dist/service.js');

const MENU = {
  B_BL: { name: '板烧鸡腿堡', currentPrice: '24.00', originalPrice: '24.00' },
  B_SP: { name: '麦辣鸡腿堡', currentPrice: '25.00', originalPrice: '25.00' },
  B_BIG: { name: '巨无霸', currentPrice: '26.50', originalPrice: '26.50' },
  B_FISH: { name: '麦香鱼', currentPrice: '18.00', originalPrice: '18.00' },
  F_M: { name: '中薯条', currentPrice: '12.00', originalPrice: '12.00' },
  F_L: { name: '大薯条', currentPrice: '14.50', originalPrice: '14.50' },
  N_M: { name: '麦乐鸡（5块）', currentPrice: '13.00', originalPrice: '13.00' },
  D_COLA: { name: '可口可乐（中杯）', currentPrice: '9.00', originalPrice: '9.00' },
  D_ZERO: { name: '零度可乐（中杯）', currentPrice: '9.00', originalPrice: '9.00' },
  D_SPRITE: { name: '雪碧（中杯）', currentPrice: '8.00', originalPrice: '8.00' },
  D_TEA: { name: '冰红茶（中杯）', currentPrice: '8.00', originalPrice: '8.00' },
  C_BL: { name: '板烧鸡腿堡三件套', currentPrice: '32.00', originalPrice: '36.00' },
  C_SP: { name: '麦辣鸡腿堡三件套', currentPrice: '34.00', originalPrice: '38.00' },
  C_FISH: { name: '麦香鱼三件套', currentPrice: '30.00', originalPrice: '34.00' },
};
const priceOf = Object.fromEntries(Object.entries(MENU).map(([code, m]) => [code, Math.round(Number(m.currentPrice) * 100)]));

const ROUNDS = {
  C_BL: [
    { id: 101, name: '主食轮', choices: [
      { code: 'B_BL', name: '板烧鸡腿堡', isDefault: 1, diffPrice: '+0' },
      { code: 'B_BIG', name: '巨无霸', isDefault: 0, diffPrice: '+¥2' },
    ] },
    { id: 102, name: '小食轮', choices: [
      { code: 'F_M', name: '中薯条', isDefault: 1, diffPrice: '+0' },
      { code: 'F_L', name: '大薯条', isDefault: 0, diffPrice: '+¥2' },
    ] },
    { id: 103, name: '饮料轮', choices: [
      { code: 'D_COLA', name: '可口可乐（中杯）', isDefault: 1, diffPrice: '+0' },
      { code: 'D_ZERO', name: '零度可乐（中杯）', isDefault: 0, diffPrice: '+0' },
      { code: 'D_SPRITE', name: '雪碧（中杯）', isDefault: 0, diffPrice: '+0' },
    ] },
  ],
  C_SP: [
    { id: 201, name: '主食轮', choices: [
      { code: 'B_SP', name: '麦辣鸡腿堡', isDefault: 1, diffPrice: '+0' },
      { code: 'B_BIG', name: '巨无霸', isDefault: 0, diffPrice: '+¥2' },
    ] },
    { id: 202, name: '小食轮', choices: [
      { code: 'F_M', name: '中薯条', isDefault: 1, diffPrice: '+0' },
      { code: 'F_L', name: '大薯条', isDefault: 0, diffPrice: '+¥2' },
    ] },
    { id: 203, name: '饮料轮', choices: [
      { code: 'D_COLA', name: '可口可乐（中杯）', isDefault: 1, diffPrice: '+0' },
      { code: 'D_ZERO', name: '零度可乐（中杯）', isDefault: 0, diffPrice: '+0' },
      { code: 'D_SPRITE', name: '雪碧（中杯）', isDefault: 0, diffPrice: '+0' },
    ] },
  ],
  C_FISH: [
    { id: 301, name: '主食轮', choices: [{ code: 'B_FISH', name: '麦香鱼', isDefault: 1, diffPrice: '+0' }] },
    { id: 302, name: '小食轮', choices: [{ code: 'F_M', name: '中薯条', isDefault: 1, diffPrice: '+0' }] },
    { id: 303, name: '饮料轮', choices: [{ code: 'D_TEA', name: '冰红茶（中杯）', isDefault: 1, diffPrice: '+0' }] },
  ],
};

const NUTRITION = [
  { name: '板烧鸡腿堡', kcal: 402, protein: 27, fat: 18, carb: 37, sodium: 790 },
  { name: '麦辣鸡腿堡', kcal: 517, protein: 26, fat: 25, carb: 45, sodium: 1000 },
  { name: '巨无霸', kcal: 513, protein: 27, fat: 26, carb: 42, sodium: 961 },
  { name: '麦香鱼', kcal: 340, protein: 14, fat: 16, carb: 38, sodium: 580 },
  { name: '中薯条', kcal: 289, protein: 4, fat: 15, carb: 34, sodium: 210 },
  { name: '大薯条', kcal: 430, protein: 6, fat: 22, carb: 51, sodium: 310 },
  { name: '麦乐鸡（5块）', kcal: 230, protein: 14, fat: 13, carb: 12, sodium: 480 },
  { name: '可口可乐（中杯）', kcal: 147, protein: 0, fat: 0, carb: 37, sodium: 15 },
  { name: '零度可乐（中杯）', kcal: 0, protein: 0, fat: 0, carb: 0, sodium: 15 },
  { name: '雪碧（中杯）', kcal: 144, protein: 0, fat: 0, carb: 36, sodium: 20 },
  { name: '冰红茶（中杯）', kcal: 120, protein: 0, fat: 0, carb: 30, sodium: 18 },
];

function makeClient() {
  return {
    async call(tool, args = {}) {
      if (tool === 'query-meals') {
        return { data: {
          categories: [
            { name: '精选套餐', meals: ['C_BL', 'C_SP', 'C_FISH'].map(code => ({ code, tags: ['套餐'] })) },
            { name: '汉堡', meals: ['B_BL', 'B_SP', 'B_BIG', 'B_FISH'].map(code => ({ code, tags: [] })) },
            { name: '小食', meals: ['F_M', 'F_L', 'N_M'].map(code => ({ code, tags: [] })) },
            { name: '饮品', meals: ['D_COLA', 'D_ZERO', 'D_SPRITE', 'D_TEA'].map(code => ({ code, tags: [] })) },
          ],
          meals: MENU,
        } };
      }
      if (tool === 'list-nutrition-foods') {
        return { rawText: NUTRITION.map(r => `  ${r.name},null,${Math.round(r.kcal * 4.184)},${r.kcal},${r.protein},${r.fat},${r.carb},${r.sodium},0`).join('\n') };
      }
      if (tool === 'query-meal-detail') return { data: { rounds: ROUNDS[args.code] ?? [] } };
      if (tool === 'calculate-price') {
        const sum = (args.items ?? []).reduce((s, i) => s + (priceOf[i.productCode] ?? 0) * (i.quantity ?? 1), 0);
        return { data: { price: sum, discount: 0, productOriginalPrice: sum } };
      }
      if (tool === 'query-nearby-stores') return { data: [] };
      return { data: {} };
    },
  };
}

const client = makeClient();
const single = await S.serviceSolveSingle(client, {
  storeCode: 'S-DEMO',
  storeName: '麦当劳（人民广场店）',
  city: '上海',
  kcal: 700,
  yuan: 32,
  objectives: ['protein'],
  targetTime: undefined,
}, {});

const groupInput = {
  storeCode: 'S-DEMO',
  storeName: '麦当劳（人民广场店）',
  city: '上海',
  members: [
    { alias: '小林', wishes: ['板烧鸡腿堡', '零度可乐'], taboos: [] },
    { alias: '小周', wishes: ['麦辣鸡腿堡', '薯条'], taboos: [] },
    { alias: '小陈', wishes: ['麦香鱼'], taboos: [], kcalCap: 400 },
  ],
};
const group = await S.serviceSolveGroup(client, groupInput, {});
const demoText = '小林：板烧鸡腿堡、零度可乐\n小周：麦辣鸡腿堡、薯条\n小陈：麦香鱼，控卡 400';
const parsed = S.serviceParseGroup(demoText);
const mcdna = await S.serviceMcdna(null, { demo: true, amountMode: 'tier' });

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'single.json'), JSON.stringify(single, null, 2) + '\n');
writeFileSync(join(outDir, 'group.json'), JSON.stringify(group, null, 2) + '\n');
writeFileSync(join(outDir, 'group-input.json'), JSON.stringify(groupInput, null, 2) + '\n');
writeFileSync(join(outDir, 'parse-group.json'), JSON.stringify(parsed, null, 2) + '\n');
writeFileSync(join(outDir, 'mcdna.json'), JSON.stringify(mcdna, null, 2) + '\n');
writeFileSync(join(outDir, 'demo-text.txt'), demoText + '\n');

const summary = {
  single: {
    feasible: single.feasible,
    solutions: single.solutions?.length ?? 0,
    paid: single.solutions?.[0]?.price,
    kcal: single.solutions?.[0]?.metrics?.kcal,
    codes: single.solutions?.[0]?.items?.map(i => `${i.code}×${i.qty}`),
  },
  group: {
    unified: group.unified?.length ?? 0,
    recommendedIndex: group.recommendedIndex,
    paid: group.unified?.[group.recommendedIndex ?? 0]?.totals?.paidCents,
    members: group.unified?.[group.recommendedIndex ?? 0]?.members?.map(m => ({ alias: m.alias, items: m.items.map(i => `${i.name}×${i.qty}`) })),
    union: group.channelDiagnostics?.union?.stats ?? null,
  },
};
console.log(JSON.stringify(summary, null, 2));
