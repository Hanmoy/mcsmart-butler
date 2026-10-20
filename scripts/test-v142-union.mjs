// v1.4.2 联盟链路修复验收（离线单测，禁止联网）：
//   R07 S2b 数量语义：标题前 / 标题后 /【】内一致；数量冲突或赠送/任选不确定时不得自动核验。
//   R08 团单时间与异常价格准入：可购买 ≠ 当前可核销；相对有效期不因绝对起止为 0 误判过期；
//       异常价格（0/null/非法）终止自动准入；分类计数互斥守恒。
//   R09 缓存继承：改名 / 跨城 / 规则变化 / 过期核验不得静默继承；联网与断网口径一致。
// 运行：npx tsc --outDir .build-d && MCSMART_BUILD=../.build-d node scripts/test-v142-union.mjs
//   （默认 MCSMART_BUILD=../dist，即 npm run build 后的常规产物）
const BASE = process.env.MCSMART_BUILD ?? '../dist';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 目录隔离：catalog / 配方层不触碰真实用户数据
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v142-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const D = await import(`${BASE}/dealDetail.js`);
const U = await import(`${BASE}/unionCps.js`);
const C = await import(`${BASE}/catalog.js`);

let failures = 0;
const check = (cond, label, detail) => {
  const tag = cond ? '✓' : '✗';
  if (!cond) failures++;
  const d = detail === undefined ? ''
    : `（${typeof detail === 'object' ? JSON.stringify(detail).slice(0, 220) : detail}）`;
  console.log(`  ${tag} ${label}${d}`);
};

// ---------- 夹具 ----------
const mi = (name, over = {}) => ({
  code: `C-${name}`, name, priceCents: 1390, originalPriceCents: 1390,
  category: '小食', tags: [], kcal: 300, protein: 10, fat: 10, carbohydrate: 20, sodium: 300,
  isCombo: false, fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: true, ...over,
});
const menuOf = (names) => ({ items: names.map((n) => mi(n)), unmatched: 0, comboCount: 0, comboUnmatched: 0, table: new Map() });

const stubClient = { async call() { return { data: {} }; } };

// 联网桩：覆盖全局 fetch，返回构造的 query_coupon 响应（不触网）
let fetchHandler = null;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls++;
  const r = fetchHandler ? fetchHandler() : { json: { data: [] } };
  return { status: r.status ?? 200, json: async () => r.json, headers: new Headers(r.headers ?? {}) };
};

const mkCoupon = (o) => ({
  couponPackDetail: {
    name: o.name, productViewSign: o.sign, skuViewId: o.sign, sellPrice: o.price,
    poiName: '测试店', headUrl: 'https://img.meituan.net/x.jpg@350_0',
    startTime: o.saleStart, endTime: o.saleEnd,
    saleStatus: o.saleStatus === undefined ? true : o.saleStatus,
  },
  couponValidTimeInfo: {
    couponValidSTime: o.validSTime, couponValidETime: o.validETime,
    couponValidTimeType: o.validTimeType, couponValidDay: o.couponValidDay,
  },
  brandInfo: { brandName: '麦当劳' },
});

const today = new Date().toISOString().slice(0, 10);

// ========== R07 S2b 数量语义 ==========
console.log('\n【R07】S2b 数量语义：标题前 / 标题后 /【】内一致；冲突与不确定不核验');
{
  const m = menuOf(['麦旋风']);
  const cases = [
    ['麦旋风买一送一', 2],
    ['【买一送一】麦旋风', 2],
    ['【双份】麦旋风', 2],
    ['麦旋风【买一送一】', 2],
    ['两个麦旋风', 2],
    ['【第二个半价】两个麦旋风', 2],
    ['麦旋风', 1],
    ['【15天低价】麦旋风', 1],
  ];
  for (const [name, want] of cases) {
    const r = D.verifyByOfficialSingle(name, m);
    check(!!r && r.status === 'menu-verified' && r.contents?.[0]?.qty === want && r.contents?.[0]?.keyword === '麦旋风',
      `${name} → 麦旋风 ×${want}`, r?.contents?.[0]?.qty);
  }
  // 同一数量语义位置不同 → 结果一致（修复前【】内被整段删除 → 丢失为 ×1）
  const q = (n) => D.verifyByOfficialSingle(n, m)?.contents?.[0]?.qty;
  check(q('麦旋风买一送一') === q('【买一送一】麦旋风') && q('【买一送一】麦旋风') === 2,
    '「买一送一」在标题后与【】内结果一致（=2）', `${q('麦旋风买一送一')} / ${q('【买一送一】麦旋风')}`);
  // 冲突数量语义 → 不自动核验
  check(D.verifyByOfficialSingle('买一送一四重奏麦旋风', m) === null, '「买一送一」+「四重奏」冲突 → 不自动核验');
  // 赠送异品 / 任选范围不确定 → 不自动核验
  check(D.verifyByOfficialSingle('麦旋风赠可乐', m) === null, '「麦旋风赠可乐」赠送异品 → 不自动核验');
  const rMulti = await D.verifyDealContents(stubClient, 'S1', { name: '【买一送一】麦旋风任选' }, m);
  check(rMulti.status === 'unverified', '【买一送一】麦旋风任选 → 不自动核验（任选范围不确定）', rMulti.status);
  // 端到端：verifyDealContents 各位置一致
  for (const [name, want] of [['麦旋风买一送一', 2], ['【买一送一】麦旋风', 2], ['【双份】麦旋风', 2]]) {
    const r = await D.verifyDealContents(stubClient, 'S1', { name }, m);
    check(r.status === 'menu-verified' && r.contents?.[0]?.qty === want, `verifyDealContents ${name} → ×${want}`, r.contents);
  }
}

// ========== R08 时间与异常价格准入 ==========
console.log('\n【R08】时间与异常价格准入：可购买 ≠ 当前可核销；相对有效期不误判；异常价格终止准入；计数互斥守恒');
{
  const now = Math.floor(Date.now() / 1000);
  const deals = [
    mkCoupon({ name: '测试单品甲', sign: 'R08_A', price: '13.90' }),
    mkCoupon({ name: '测试单品乙', sign: 'R08_B', price: '13.90', validTimeType: 1, validSTime: 0, validETime: 0, couponValidDay: 7 }),
    mkCoupon({ name: '测试单品丙', sign: 'R08_C', price: '13.90', saleStart: now + 86400 }),
    mkCoupon({ name: '测试单品丁', sign: 'R08_D', price: '13.90', saleStatus: false }),
    mkCoupon({ name: '测试单品戊', sign: 'R08_E', price: '13.90', validTimeType: 2, validSTime: now + 86400, validETime: now + 7 * 86400 }),
    mkCoupon({ name: '测试单品己', sign: 'R08_F', price: '13.90', validTimeType: 2, validSTime: now - 7 * 86400, validETime: now - 86400 }),
    mkCoupon({ name: '测试单品庚', sign: 'R08_G', price: '0' }),
    mkCoupon({ name: '测试单品辛', sign: 'R08_H', price: 'abc' }),
  ];
  fetchHandler = () => ({ json: { data: deals, hasNext: false } });
  process.env.MEITUAN_UNION_APPKEY = 'k';
  process.env.MEITUAN_UNION_APPSECRET = 's';
  delete process.env.MCSMART_DISABLE_BUNDLED_UNION;
  U._clearUnionQueryCache();
  const menu = menuOf(['测试单品甲', '测试单品乙', '测试单品丙', '测试单品丁', '测试单品戊', '测试单品己', '测试单品庚', '测试单品辛']);
  const res = await U.fetchUnionMcDeals(stubClient, 'S1', menu, '测试店', { city: '北京' });
  const s = res.stats;
  const byId = (id) => res.builds.find((b) => b.voucher.id === `union-${id}`);

  check(s.queried === 8, '查询 8 条', s.queried);
  check(s.admitted === 2, 'admitted = 2（甲正常在售 / 乙相对有效期）', s.admitted);
  check(s.saleEnded === 2, 'saleEnded = 2（丙未开售 / 丁已停售）', s.saleEnded);
  check(s.validityExpired === 1, 'validityExpired = 1（己已过期）', s.validityExpired);
  check(s.detailUnverified === 1, 'priceCandidate = 1（戊固定未来有效）', s.detailUnverified);
  check(s.other === 2, 'other = 2（庚 0 价 / 辛 非法价）', s.other);
  check(s.admitted + s.detailUnverified + s.saleEnded + s.validityExpired + s.other === s.queried,
    '分类计数互斥守恒（admitted + price-candidate + unavailable + other = queried）',
    `${s.admitted}+${s.detailUnverified}+${s.saleEnded}+${s.validityExpired}+${s.other}=${s.queried}`);

  check(byId('R08_A')?.solvable === true, '甲（正常在售）可解');
  check(byId('R08_B')?.solvable === true, '乙（购买后 7 天 / 绝对起止 0）不被误判过期、可解');
  check(byId('R08_C')?.solvable === false && byId('R08_C')?.purchasable === false, '丙（明天才开售）不可解且不可购买');
  check(byId('R08_D')?.solvable === false && byId('R08_D')?.purchasable === false, '丁（已停售）不可解且不可购买');
  check(byId('R08_E')?.solvable === false && byId('R08_E')?.purchasable === true, '戊（明天才可用）可购买但当前不可核销');
  check(byId('R08_F')?.solvable === false, '己（已过期）不可解');
  check(byId('R08_G')?.solvable === false && byId('R08_G')?.purchasable === false && byId('R08_G')?.verify === undefined,
    '庚（0 价）不可解、无核验记录（异常价格终止自动准入）');
  check(byId('R08_H')?.solvable === false && byId('R08_H')?.verify === undefined, '辛（非法价）不可解、无核验记录');
}

// ========== R09 缓存继承上下文校验 ==========
console.log('\n【R09】缓存继承：上下文校验（改名 / 跨城 / 规则变化 / 过期核验不继承；同上下文可降级）');
{
  const successRec = (over = {}) => ({ status: 'menu-verified', ruleVersion: 'single-name-v1', source: 'official-menu', verifiedAt: today, ...over });
  const failRec = (over = {}) => ({ status: 'unverified', reasonCode: 'detail-unavailable', reason: '本次详情查询失败', verifiedAt: today, ...over });
  const contents1 = [{ mode: 'fixed', keyword: 'R09测试单品', qty: 1 }];
  const seedSuccess = (sign, over = {}) => C.upsertDeals([{
    sign, name: over.name ?? 'R09测试单品', priceCents: 1390, poiName: '测试店', admitted: true,
    contents: over.contents ?? contents1, verify: successRec(over.verify), city: over.city ?? '北京',
  }]);
  const thenFail = (sign, over = {}) => C.upsertDeals([{
    sign, name: over.name ?? 'R09测试单品', priceCents: over.priceCents ?? 1390, poiName: '测试店', admitted: false,
    verify: failRec(over.verify), city: over.city ?? '北京',
  }]);

  // 1) 同上下文瞬时失败 → 按明确策略降级（沿用既有成功核验）
  seedSuccess('R09_OK');
  thenFail('R09_OK', { priceCents: 1290 });
  let d = C.dealBySign('R09_OK');
  check(d?.contents?.length === 1, '同上下文瞬时失败 → 继承既有组成', d?.contents);
  check(d?.admitted === true, '同上下文 → 准入状态保留');
  check(d?.verify?.lastSuccessAt === today && !!d?.verify?.queryFailedAt, '保留最后成功核验日期并记录 queryFailedAt', d?.verify?.lastSuccessAt);
  check(d?.priceCents === 1290, '价格等实时字段仍随最新观测更新', d?.priceCents);

  // 2) 改名 → 不继承
  seedSuccess('R09_RENAME');
  thenFail('R09_RENAME', { name: 'R09改名后的另一个套餐', priceCents: 990 });
  d = C.dealBySign('R09_RENAME');
  check(!d?.contents?.length && d?.admitted === false, '改名 → 不继承旧组成与准入', d?.contents);

  // 3) 跨城 → 不继承
  seedSuccess('R09_CITY', { city: '上海' });
  thenFail('R09_CITY', { city: '北京' });
  d = C.dealBySign('R09_CITY');
  check(!d?.contents?.length && d?.admitted === false, '跨城（上海→北京）→ 不继承旧组成', d?.contents);

  // 4a) 旧成功所用规则版本已不在白名单 → 不继承
  seedSuccess('R09_RV1', { verify: { ruleVersion: 'single-name-v0' } });
  thenFail('R09_RV1');
  d = C.dealBySign('R09_RV1');
  check(!d?.contents?.length, '旧规则版本（single-name-v0）不在白名单 → 不继承', d?.contents);

  // 4b) 本次核验给出的规则版本与旧成功不一致 → 不继承
  seedSuccess('R09_RV2');
  thenFail('R09_RV2', { verify: { ruleVersion: 'single-name-v2' } });
  d = C.dealBySign('R09_RV2');
  check(!d?.contents?.length, '本次规则版本与旧成功不一致 → 不继承', d?.contents);

  // 5) 过期核验（2020）→ 不继承
  seedSuccess('R09_STALE', { verify: { verifiedAt: '2020-01-01' } });
  thenFail('R09_STALE');
  d = C.dealBySign('R09_STALE');
  check(!d?.contents?.length, '过期核验（2020）→ 不继承', d?.contents);

  // 6) 规格规则签名变化（数量语义）→ 不继承
  seedSuccess('R09_SIG', { name: '【买一送一】R09测试单品', contents: [{ mode: 'fixed', keyword: 'R09测试单品', qty: 2 }] });
  thenFail('R09_SIG');
  d = C.dealBySign('R09_SIG');
  check(!d?.contents?.length, '数量语义变化（买一送一 → 单品）→ 不继承旧 ×2 组成', d?.contents);
}

// ========== R09b 联网 / 断网口径一致 ==========
console.log('\n【R09b】联网与断网口径一致：联网继承的成功核验，断网兜底同样可解');
{
  process.env.MEITUAN_UNION_APPKEY = 'k';
  process.env.MEITUAN_UNION_APPSECRET = 's';
  delete process.env.MCSMART_DISABLE_BUNDLED_UNION;
  const fullMenu = menuOf(['R09联网单品']);
  const onlineDeal = [mkCoupon({ name: 'R09联网单品', sign: 'R09_NET', price: '13.90' })];
  fetchHandler = () => ({ json: { data: onlineDeal, hasNext: false } });

  U._clearUnionQueryCache();
  const r1 = await U.fetchUnionMcDeals(stubClient, 'S1', fullMenu, '测试店', { city: '北京' });
  const b1 = r1.builds.find((b) => b.voucher.id === 'union-R09_NET');
  check(b1?.solvable === true, '联网首次：核验通过 → 可解', b1?.verify?.status);

  // 本次组成未核验（空菜单）→ 响应与持久化使用同一合并判断 → 沿用既有成功（修复前本次 builds 不可解）
  U._clearUnionQueryCache();
  const r2 = await U.fetchUnionMcDeals(stubClient, 'S1', menuOf([]), '测试店', { city: '北京' });
  const b2 = r2.builds.find((b) => b.voucher.id === 'union-R09_NET');
  check(b2?.solvable === true && b2?.verify?.status === 'menu-verified',
    '联网但本次未核验 → 沿用既有成功（响应与持久化同判断）', b2?.verify?.status);

  // 断网：删凭据 + 禁内置 → 本地团单库兜底
  delete process.env.MEITUAN_UNION_APPKEY;
  delete process.env.MEITUAN_UNION_APPSECRET;
  process.env.MCSMART_DISABLE_BUNDLED_UNION = '1';
  U._clearUnionQueryCache();
  const r3 = await U.fetchUnionMcDeals(stubClient, 'S1', fullMenu, '测试店', { city: '北京' });
  check(r3.dbUsed === true, '断网 → 本地团单库兜底');
  const b3 = r3.builds.find((b) => b.voucher.id === 'union-R09_NET');
  check(b3?.solvable === true, '断网兜底：与联网继承同口径 → 同样可解', b3?.solvable);
}

console.log(`\n桩 fetch 调用次数：${fetchCalls}（联网路径已覆盖）`);
console.log(failures === 0 ? 'v1.4.2 联盟链路修复验收全部通过 ✓' : `v1.4.2 验收失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);
