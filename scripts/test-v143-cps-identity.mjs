// v1.4.3 CPS 商品身份贯通 + pattern 配方绑定规则（离线单测，禁止联网）：
//   I1 联网路径：build 携带 productViewSign / skuViewId / headUrl（两 ID 互不填充）
//   I2 skuViewId 随团单持久化到本地团单库（不丢身份）
//   I3 断网兜底：dbDealToBuild 仍携带 productViewSign(=sign) 与 headUrl
//   I4 pattern 配方：官方品类 key（staple/white）无需绑定即可 pattern-verified；
//       自定义任选 key 无绑定 → 拒绝自动准入；带官方绑定 → 通过
// 运行：npx tsc && node scripts/test-v143-cps-identity.mjs（默认 MCSMART_BUILD=../dist）
const BASE = process.env.MCSMART_BUILD ?? '../dist';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v143id-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const U = await import(`${BASE}/unionCps.js`);
const D = await import(`${BASE}/dealDetail.js`);
const C = await import(`${BASE}/catalog.js`);
const VR = await import(`${BASE}/voucherRecipes.js`);

let failures = 0;
const check = (cond, label, detail) => {
  const tag = cond ? '✓' : '✗';
  if (!cond) failures++;
  const d = detail === undefined ? ''
    : `（${typeof detail === 'object' ? JSON.stringify(detail).slice(0, 240) : detail}）`;
  console.log(`  ${tag} ${label}${d}`);
};

const mi = (name, over = {}) => ({
  code: `C-${name}`, name, priceCents: 1390, originalPriceCents: 1390,
  category: '小食', tags: [], kcal: 300, protein: 10, fat: 10, carbohydrate: 20, sodium: 300,
  isCombo: false, fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: true, ...over,
});
const menuOf = (names) => ({ items: names.map((n) => mi(n)), unmatched: 0, comboCount: 0, comboUnmatched: 0, table: new Map() });

const stubClient = { async call() { return { data: {} }; } };

let fetchHandler = null;
globalThis.fetch = async () => {
  const r = fetchHandler ? fetchHandler() : { json: { data: [] } };
  return { status: r.status ?? 200, json: async () => r.json, headers: new Headers(r.headers ?? {}) };
};

// 商品身份：productViewSign（A_B 段）与 skuViewId（A 段）是两个不同 ID
const PVS = 'P_A_VIEW';
const SKU = 'P_A';
const HEAD = 'https://img.meituan.net/coupon/head.jpg@350_0';
const mkCoupon = (o) => ({
  couponPackDetail: {
    name: o.name, productViewSign: o.pvs, skuViewId: o.sku, sellPrice: o.price,
    poiName: '身份测试店', headUrl: o.head,
    saleStatus: true,
  },
  brandInfo: { brandName: '麦当劳' },
});

// ========== I1 联网路径：build 携带 CPS 商品身份 ==========
console.log('\n【I1】联网路径：build 携带 productViewSign / skuViewId / headUrl（两 ID 互不填充）');
{
  fetchHandler = () => ({ json: { data: [mkCoupon({ name: '身份测试单品', pvs: PVS, sku: SKU, price: '13.90', head: HEAD })], hasNext: false } });
  process.env.MEITUAN_UNION_APPKEY = 'k';
  process.env.MEITUAN_UNION_APPSECRET = 's';
  delete process.env.MCSMART_DISABLE_BUNDLED_UNION;
  U._clearUnionQueryCache();
  const res = await U.fetchUnionMcDeals(stubClient, 'S1', menuOf(['身份测试单品']), '身份测试店', { city: '北京' });
  const b = res.builds.find((x) => x.voucher.id === `union-${PVS}`);
  check(!!b, '联网返回对应团单 build', b?.voucher?.id);
  check(b?.productViewSign === PVS, 'build.productViewSign = couponPackDetail.productViewSign', b?.productViewSign);
  check(b?.skuViewId === SKU, 'build.skuViewId 独立保留（≠ productViewSign）', b?.skuViewId);
  check(b?.headUrl === HEAD.split('@')[0], 'build.headUrl 提取并去尺寸后缀', b?.headUrl);
}

// ========== I2 skuViewId 随团单持久化 ==========
console.log('\n【I2】skuViewId 随团单持久化到本地团单库（身份不丢）');
{
  const row = C.dealBySign(PVS);
  check(!!row, '本地团单库存在该团单', row?.sign);
  check(row?.skuViewId === SKU, '持久化 skuViewId（≠ sign）', row?.skuViewId);
  check(row?.sign === PVS, '持久化 sign = productViewSign', row?.sign);
}

// ========== I3 断网兜底：身份仍随 build 下发 ==========
console.log('\n【I3】断网兜底：dbDealToBuild 仍携带 productViewSign(=sign) 与 headUrl');
{
  delete process.env.MEITUAN_UNION_APPKEY;
  delete process.env.MEITUAN_UNION_APPSECRET;
  process.env.MCSMART_DISABLE_BUNDLED_UNION = '1';
  U._clearUnionQueryCache();
  const res = await U.fetchUnionMcDeals(stubClient, 'S1', menuOf([]), '身份测试店', { city: '北京' });
  check(res.dbUsed === true, '断网 → 本地团单库兜底', res.dbUsed);
  const b = res.builds.find((x) => x.voucher.id === `union-${PVS}`);
  check(!!b, '兜底 build 命中', b?.voucher?.id);
  check(b?.productViewSign === PVS, '兜底 build.productViewSign = sign', b?.productViewSign);
  check(b?.headUrl === HEAD.split('@')[0], '兜底 build.headUrl 从核验记录带出', b?.headUrl);
}

// ========== I4 pattern 配方绑定规则 ==========
console.log('\n【I4】pattern 配方：官方品类 key 免绑定；自定义任选 key 无绑定 → 拒绝；带绑定 → 通过');
{
  VR._resetRecipeCache();
  // 官方品类 key（staple/white）：预置「随心配 1+1」= 官方规则，无需绑定即可核验
  const official = await D.verifyDealContents(stubClient, 'S1', { name: '随心配1+1套餐' }, menuOf([]));
  check(official.status === 'pattern-verified' && official.source === 'recipe',
    '官方品类 key（staple/white）→ 免绑定 pattern-verified', { status: official.status, source: official.source });

  // 自定义任选 key（无官方品类语义）：无绑定必须拒绝
  VR.saveRecipe({
    id: 'rcp-test-custom-choice', name: '自定义任选测试券', matchNames: ['自定义任选测试券'],
    resolve: 'pattern', channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'choice', keyword: 'mystery', qty: 1, spec: '神秘任选 1' }],
    conditions: { orderType: 'instore' }, priceCents: 990, originalPriceCents: 0,
    buyPath: '（测试）', redeemPath: '（测试）', evidence: '单测夹具', verifiedAt: '2026-10-15', ruleVersion: 'test-v1',
  });
  VR._resetRecipeCache();
  const noBind = await D.verifyDealContents(stubClient, 'S1', { name: '自定义任选测试券' }, menuOf([]));
  check(noBind.status === 'unverified' && noBind.reasonCode === 'choice-range-unclear',
    '自定义任选 key 无绑定 → 拒绝自动准入', { status: noBind.status, reasonCode: noBind.reasonCode });

  // 带官方绑定（comboCode 命中当前菜单套餐）→ 通过
  const combo = mi('测试套餐', { isCombo: true, code: 'CMB-X', deconstruction: [{ roundId: 'r1', options: [{ name: '测试单品' }] }] });
  VR.saveRecipe({
    id: 'rcp-test-custom-choice-bound', name: '自定义任选测试券B', matchNames: ['自定义任选测试券B'],
    resolve: 'pattern', channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'choice', keyword: 'mystery', qty: 1, spec: '神秘任选 1' }],
    conditions: { orderType: 'instore' }, priceCents: 990, originalPriceCents: 0,
    buyPath: '（测试）', redeemPath: '（测试）', evidence: '单测夹具', verifiedAt: '2026-10-15', ruleVersion: 'test-v1',
    binding: { comboCode: 'CMB-X', roundIds: ['r1'] },
  });
  VR._resetRecipeCache();
  const bound = await D.verifyDealContents(stubClient, 'S1', { name: '自定义任选测试券B' }, { items: [combo], unmatched: 0, comboCount: 1, comboUnmatched: 0, table: new Map() });
  check(bound.status === 'pattern-verified', '自定义任选 key 带官方绑定 → pattern-verified', { status: bound.status, source: bound.source });
}

// ========== I5 单品券必须真正进入求解池（v1.4.3 修正：旧门槛 slots>=2 把单品券挡在门外） ==========
console.log('\n【I5】单品券 / 多份券真正进入求解池（核验通过 ≠ 建池，此处验证二者一致）');
{
  const GK = await import(`${BASE}/groupKernel.js`);
  const menu = menuOf(['那么大鸡排', '麦旋风']);
  const coupons = [
    mkCoupon({ name: '那么大鸡排', pvs: 'I5_SINGLE', sku: 'I5_S', price: '10.90', head: HEAD }),      // S2b 同名单品 → fixed×1
    mkCoupon({ name: '麦旋风买一送一', pvs: 'I5_DOUBLE', sku: 'I5_D', price: '13.50', head: HEAD }),  // S2b 数量词 → fixed×2
  ];
  fetchHandler = () => ({ json: { data: coupons, hasNext: false } });
  process.env.MEITUAN_UNION_APPKEY = 'k';
  process.env.MEITUAN_UNION_APPSECRET = 's';
  delete process.env.MCSMART_DISABLE_BUNDLED_UNION;
  U._clearUnionQueryCache();
  const { voucherPlans, diagnostics } = await GK.recallChannelPlans(stubClient, { storeCode: 'S1', storeName: '身份测试店', city: '北京' }, menu, []);
  const u = diagnostics.union;
  const byStatus = {};
  for (const d of (u.deals ?? [])) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
  check(u.stats?.admitted === 2, '核验通过 2 张（单品券 + 多份券）', u.stats?.admitted);
  check(byStatus.admitted === u.stats?.admitted, '诊断 deals[] admitted 与 stats 一致（核验通过 = 实际建池）', `${byStatus.admitted}/${u.stats?.admitted}`);
  const single = voucherPlans.find((p) => p.name === '那么大鸡排');
  check(!!single, '单品券已建池（旧实现 slots>=2 会挡在门外）', single?.name);
  check(single?.slots.length === 1, '单品券槽位数 = 1', single?.slots.length);
  const dbl = voucherPlans.find((p) => p.name === '麦旋风买一送一');
  check(dbl?.slots.length === 2, '多份券（买一送一）槽位数 = 2（未因放开门槛而退化）', dbl?.slots.length);
}

console.log(failures === 0 ? '\nv1.4.3 CPS 身份贯通验收全部通过 ✓' : `\nv1.4.3 CPS 身份贯通失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);
