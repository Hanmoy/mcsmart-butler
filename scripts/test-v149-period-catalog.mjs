// v1.4.9 N01 回归：分时段产品目录 + 目标时段可售池 + 下单上下文贯通
// 运行：npm test 或 node scripts/test-v149-period-catalog.mjs（需先 tsc）
//
// 覆盖评审 N01 的五条要求，以及 v1.4.8 遗留的两处边界：
//   N01-1 统一查询上下文：targetTime → reservationDate 贯通菜单 / 套餐详情 / 计价，并在输出回显口径
//   N01-2 保留完整目录：按餐段锚点采集、同 code 跨分类合并、分时段价格不互相覆盖
//   N01-3 独立可售池：只收目标时段官方真实返回的商品；某餐段查询失败一律「无法确认」，不用其他时段推断
//   N01-4 完整展开后计算：套餐结构（轮次/选项/差价）仍走同一条链路（此处只验证入池口径未破坏）
//   N01-5 可审计遗漏账：官方返回 → 结构取得 → 营养可用 → 候选方案 → 实际选中，逐商品给原因
//   R02 边界：结构未取得的套餐不参与心愿覆盖（不再用未知冒充已知）
//   R04 边界：多份同款券记 officialComboCopies，但不冒充单份需求的独立承接
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'v149');
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v149-'));
process.env.MCSMART_HOME = TEST_HOME;
process.env.MEITUAN_UNION_APPKEY = '';
process.env.MEITUAN_UNION_APPSECRET = '';
process.env.MCSMART_DISABLE_BUNDLED_UNION = '1';
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const { periodOfDate, periodOfMinutes, resolveTargetTime, formatReservationDate, parseReservationDate, formatLocalDate } = await import('../dist/mealPeriod.js');
const { collectPeriodCatalog, sellablePoolOf, _clearPeriodCatalogCache } = await import('../dist/periodCatalog.js');
const { serviceSolveSingle, serviceSolveGroup, servicePeriodCatalog } = await import('../dist/service.js');
const { recallChannelPlans } = await import('../dist/groupKernel.js');
const { optimize, buildPlansFromMenuItems } = await import('../dist/optimizer.js');
const { _clearMenuCache, _clearComboCache } = await import('../dist/menu.js');

let failed = 0;
const check = (cond, label, extra) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failed++; console.log(`  ✗ ${label}${extra === undefined ? '' : `（实际 ${JSON.stringify(extra)}）`}`); }
};

const loadMenu = (f) => JSON.parse(readFileSync(join(FIX, f), 'utf-8')).data;

// ---------------------------------------------------------------- 测试桩
const NUTRI = [
  '  板烧鸡腿麦满分,null,900,215,14,7,20,500,0',
  '  中薯条,null,1200,287,3,14,36,200,0',
  '  可乐中杯,null,620,147,0,0,37,10,0',
].join('\n');

const MENU_SYNTH = {
  categories: [
    { name: '早餐', meals: [{ code: 'S1', tags: [] }, { code: 'S3', tags: [] }] },
    { name: '套餐', meals: [{ code: 'C1', tags: ['二件套'] }] },
    { name: '小食', meals: [{ code: 'S2', tags: [] }] },
  ],
  meals: {
    S1: { name: '板烧鸡腿麦满分', currentPrice: '12.5' },
    S2: { name: '中薯条', currentPrice: '11' },
    S3: { name: '可乐中杯', currentPrice: '9' },
    C1: { name: '板烧鸡腿麦满分套餐', currentPrice: '20' },
  },
};

const DETAIL_C1 = {
  rounds: [
    { id: 1, name: '主食', choices: [{ code: 'S1', name: '板烧鸡腿麦满分', isDefault: 1, diffPrice: '0' }] },
    { id: 2, name: '小食', choices: [{ code: 'S2', name: '中薯条', isDefault: 1, diffPrice: '0' }] },
    { id: 3, name: '饮品', choices: [{ code: 'S3', name: '可乐中杯', isDefault: 1, diffPrice: '0' }] },
  ],
};

function makeClient({ menus, detailFails = new Set(), calls = [] }) {
  return {
    async call(tool, params) {
      calls.push({ tool, params });
      if (tool === 'query-meals') {
        const key = params.reservationDate ? params.reservationDate.slice(11) : 'now';
        const payload = menus[key];
        if (payload === 'FAIL') throw new Error('upstream 500（模拟该餐段查询失败）');
        if (!payload) throw new Error(`未准备该时段的菜单桩：${key}`);
        return { data: payload };
      }
      if (tool === 'list-nutrition-foods') return { rawText: NUTRI };
      if (tool === 'query-meal-detail') {
        if (detailFails.has(params.code)) throw new Error('detail unavailable（模拟结构未取得）');
        return { data: DETAIL_C1 };
      }
      if (tool === 'calculate-price') return { data: { price: 1500, discount: 0, productOriginalPrice: 1500 } };
      return { data: {} };
    },
  };
}

// ---------------------------------------------------------------- N01-1 时间口径
console.log('\n[N01-1] 目标用餐时间 → reservationDate（唯一入口）');
check(periodOfMinutes(8 * 60) === 'breakfast' && periodOfMinutes(12 * 60) === 'regular', '餐段划分：08:00 早餐 / 12:00 常规');
check(periodOfMinutes(5 * 60) === 'breakfast' && periodOfMinutes(10 * 60 + 45) === 'breakfast', '早餐窗口含边界 05:00 与 10:45');
check(periodOfMinutes(10 * 60 + 46) === 'regular', '10:46 起为常规时段');
check(resolveTargetTime(undefined) === null, '未填目标时间 = 即时口径（不传 reservationDate）');
const t0800 = resolveTargetTime('08:00');
const today = formatLocalDate(new Date());
check(t0800 && t0800.reservationDate === `${today} 08:00` && t0800.period === 'breakfast', 'HH:mm 补全为「今天 + 该时刻」并判定早餐段', t0800 && t0800.reservationDate);
const tExact = resolveTargetTime('2026-10-19 18:30');
check(tExact && tExact.reservationDate === '2026-10-19 18:30' && tExact.period === 'regular', '完整时间原样保留（2026-10-19 18:30 → 常规时段）');
let badRejected = 0;
for (const bad of ['25:00', '08:60', '2026-02-31 08:00', '早上八点']) {
  try { resolveTargetTime(bad); } catch { badRejected++; }
}
check(badRejected === 4, '非法目标时间全部拒绝（不静默退回「现在」）', badRejected);
check(parseReservationDate('2026-10-18 08:00') !== null && parseReservationDate('2026-13-01 08:00') === null, 'reservationDate 解析拒绝非法月份');

// ---------------------------------------------------------------- N01-2 分时段目录
console.log('\n[N01-2] 分时段目录：按餐段采集、合并同 code、价格分时段保留');
_clearPeriodCatalogCache();
const FIX_MENUS = { '08:00': loadMenu('menu-0800.json'), '12:00': loadMenu('menu-1200.json'), '18:00': loadMenu('menu-1800.json') };
const catClient = makeClient({ menus: FIX_MENUS });
const catalog = await collectPeriodCatalog(catClient, { storeCode: '1450684', date: '2026-10-18' });
check(catalog.queries.length === 3 && catalog.queries.every((q) => q.ok), '三个锚点全部成功（08:00 / 12:00 / 18:00）', catalog.queries.map((q) => `${q.anchor}:${q.ok}`));
check(catalog.counts.breakfast === 60, '早餐段 60 条（真实回执）', catalog.counts.breakfast);
check(catalog.counts.regular === 101, '常规段按 code 去重 101 条（12:00 与 18:00 不重复计数）', catalog.counts.regular);
check(catalog.unionCount === catalog.items.length && catalog.unionCount > 101, '并集大于单餐段（早餐与常规都有独有商品）', catalog.unionCount);
check(catalog.items.every((i) => i.priceByPeriod && Object.keys(i.priceByPeriod).length >= 1), '每条目录项都带分时段价格');
check(catalog.queries.every((q) => q.reservationDate.startsWith('2026-10-18 ')), '预约查询按「日期 + 锚点」发出', catalog.queries.map((q) => q.reservationDate));

// 合成一条跨餐段不同价的商品：验证价格不互相覆盖（真实回执里同 code 价格一致，故此处显式构造）
const catClient2 = makeClient({ menus: JSON.parse(JSON.stringify(FIX_MENUS)) });
const catalogs2Menus = catClient2;
void catalogs2Menus;
const menusMutated = JSON.parse(JSON.stringify(FIX_MENUS));
const sharedCode = '1041000';
menusMutated['08:00'].meals[sharedCode] = { name: '测试跨餐段商品', currentPrice: '9' };
menusMutated['12:00'].meals[sharedCode] = { name: '测试跨餐段商品', currentPrice: '12' };
menusMutated['08:00'].categories[0].meals.push({ code: sharedCode, tags: [] });
menusMutated['12:00'].categories[0].meals.push({ code: sharedCode, tags: [] });
_clearPeriodCatalogCache();
const catalog2 = await collectPeriodCatalog(makeClient({ menus: menusMutated }), { storeCode: '1450684', date: '2026-10-18' });
const shared = catalog2.items.find((i) => i.code === sharedCode);
check(!!shared && shared.priceByPeriod.breakfast === 900 && shared.priceByPeriod.regular === 1200,
  '同 code 早餐价与常规价分别保留（不互相覆盖）', shared && shared.priceByPeriod);
check(!!shared && shared.periods.includes('breakfast') && shared.periods.includes('regular'), '该商品同时标记两个餐段', shared && shared.periods);

// ---------------------------------------------------------------- N01-3 独立可售池
console.log('\n[N01-3] 目标时段可售池：只收该时段真实返回，失败不推断');
_clearPeriodCatalogCache();
const catalog3 = await collectPeriodCatalog(makeClient({ menus: FIX_MENUS }), { storeCode: '1450684', date: '2026-10-18' });
const breakfastPool = sellablePoolOf(catalog3, 'breakfast');
const regularPool = sellablePoolOf(catalog3, 'regular');
check(breakfastPool.items.length === 60 && regularPool.items.length === 101, '早餐池 60 / 常规池 101（各时段独立）', [breakfastPool.items.length, regularPool.items.length]);
check(breakfastPool.items.every((i) => i.periods.includes('breakfast')), '早餐池里没有常规段商品');
const breakfastCombo = breakfastPool.items.find((i) => i.code === '9900003457');
check(!!breakfastCombo, '早餐套餐 9900003457 在早餐池内');
check(!regularPool.items.some((i) => i.code === '9900003457'), '早餐专属套餐不进入常规池（不混成即时可买方案）');
check(regularPool.excluded.some((e) => e.code === '9900003457' && e.reason === 'off-period'), '被剔除的早餐套餐记录原因 off-period');
check(breakfastPool.excluded.length + breakfastPool.items.length === catalog3.items.length, '池内 + 剔除 = 目录全集（不漏项）');

_clearPeriodCatalogCache();
const failClient = makeClient({ menus: { '08:00': 'FAIL', '12:00': FIX_MENUS['12:00'], '18:00': FIX_MENUS['18:00'] } });
const catalogFail = await collectPeriodCatalog(failClient, { storeCode: '1450684', date: '2026-10-18' });
const failPool = sellablePoolOf(catalogFail, 'breakfast');
check(catalogFail.queries.find((q) => q.anchor === '08:00')?.ok === false, '早餐锚点查询失败被如实记录');
check(failPool.items.length === 0, '失败餐段可售池为空（不用其他时段推断）', failPool.items.length);
check(failPool.excluded.length > 0 && failPool.excluded.every((e) => e.reason === 'unknown-period'), '全部标为「无法确认可售」', failPool.excluded[0]?.reason);
check(failPool.failedQueries.length === 1, '失败的查询随池一起返回，便于审计');
check(sellablePoolOf(catalogFail, 'regular').items.length === 101, '另一餐段不受影响（各自独立判定）');

// ---------------------------------------------------------------- N01-1 贯通到菜单/详情/计价
console.log('\n[N01-1] 上下文贯通：菜单 / 套餐详情 / 计价都带同一个 reservationDate');
_clearMenuCache(); _clearComboCache();
const solveCalls = [];
const solveClient = makeClient({ menus: { now: MENU_SYNTH, '08:00': MENU_SYNTH }, calls: solveCalls });
const singleOut = await serviceSolveSingle(solveClient, { kcal: 600, yuan: 30, storeCode: 'S1', targetTime: '08:00' });
const menuCall = solveCalls.find((c) => c.tool === 'query-meals');
check(!!menuCall && menuCall.params.reservationDate === `${today} 08:00`, 'query-meals 带 reservationDate', menuCall && menuCall.params);
const detailCall = solveCalls.find((c) => c.tool === 'query-meal-detail');
check(!!detailCall && detailCall.params.reservationDate === `${today} 08:00`, 'query-meal-detail 带同一 reservationDate', detailCall && detailCall.params);
check(singleOut.orderContext?.mode === 'scheduled' && singleOut.orderContext.reservationDate === `${today} 08:00`,
  '输出回显预约口径（页面据此显示「用餐时间」）', singleOut.orderContext);

_clearMenuCache(); _clearComboCache();
const immCalls = [];
const immClient = makeClient({ menus: { now: MENU_SYNTH }, calls: immCalls });
const immOut = await serviceSolveSingle(immClient, { kcal: 600, yuan: 30, storeCode: 'S1' });
check(immOut.orderContext?.mode === 'immediate', '未填时间 → 即时口径回显');
check(immCalls.every((c) => c.params.reservationDate === undefined), '即时口径不给官方调用加 reservationDate（不是空串）', immCalls.filter((c) => c.params.reservationDate !== undefined).length);

let invalidCode = '';
try { await serviceSolveSingle(makeClient({ menus: { now: MENU_SYNTH } }), { kcal: 600, yuan: 30, storeCode: 'S1', targetTime: '25:00' }); }
catch (e) { invalidCode = e.code ?? ''; }
check(invalidCode === 'E_INPUT_INVALID', '非法 targetTime 在入口报 E_INPUT_INVALID', invalidCode);

// 拼单链路：calculate-price 也必须同口径
_clearMenuCache(); _clearComboCache();
const groupCalls = [];
const groupClient = makeClient({ menus: { now: MENU_SYNTH, '08:00': MENU_SYNTH }, calls: groupCalls });
const groupOut = await serviceSolveGroup(groupClient, {
  storeCode: 'S1', storeName: '测试门店', targetTime: '08:00',
  members: [{ alias: '甲', wishes: ['板烧鸡腿麦满分套餐'] }],
});
const priceCall = groupCalls.find((c) => c.tool === 'calculate-price');
check(!!priceCall && priceCall.params.reservationDate === `${today} 08:00`, '拼单计价 calculate-price 带同一 reservationDate', priceCall && priceCall.params);
check(groupOut.orderContext?.mode === 'scheduled', '拼单输出回显预约口径');
check(Array.isArray(groupOut.menuAudit) && groupOut.menuAudit.length > 0, '拼单输出逐商品遗漏账', groupOut.menuAudit && groupOut.menuAudit.length);
const auditCombo = (groupOut.menuAudit ?? []).find((r) => r.code === 'C1');
check(!!auditCombo && auditCombo.structure === 'ok' && auditCombo.selected === true, '套餐结构完整且被选中（结构 / 选中两段都有结论）', auditCombo);

// ---------------------------------------------------------------- N01-5 + R02 结构存疑
console.log('\n[N01-5 / R02] 结构未取得的套餐：不进覆盖、在遗漏账里写明原因');
_clearMenuCache(); _clearComboCache();
const structClient = makeClient({ menus: { now: MENU_SYNTH }, detailFails: new Set(['C1']) });
const structOut = await serviceSolveGroup(structClient, {
  storeCode: 'S1', storeName: '测试门店',
  members: [{ alias: '甲', wishes: ['板烧鸡腿麦满分套餐', '可乐中杯'] }],
});
const m0 = structOut.solution.members[0];
check(m0.unresolvedWishes.includes('板烧鸡腿麦满分套餐'), '结构未取得的套餐心愿如实记为未满足', m0.unresolvedWishes);
check(!m0.unresolvedWishes.includes('可乐中杯'), '同成员可满足的心愿不受影响（不是整体失败）', m0.unresolvedWishes);
check(structOut.solution.coverage.met < structOut.solution.coverage.total, '覆盖率不把结构未知项算作已满足', structOut.solution.coverage);
const structRow = (structOut.menuAudit ?? []).find((r) => r.code === 'C1');
check(!!structRow && structRow.structure === 'unknown', '遗漏账标记结构未取得', structRow);
check(!!structRow && /不参与心愿覆盖/.test(structRow.reason ?? ''), '遗漏账写明「不参与心愿覆盖」', structRow && structRow.reason);

// ---------------------------------------------------------------- R04 多份同款券
console.log('\n[R04] 多份同款券：记录份数证据，但不冒充单份承接');
_clearMenuCache(); _clearComboCache();
const DECON = [
  { roundName: '主食', category: 'staple', defaultName: '板烧鸡腿麦满分', options: [{ name: '板烧鸡腿麦满分', diffCents: 0, code: 'S1' }] },
  { roundName: '小食', category: 'side', defaultName: '中薯条', options: [{ name: '中薯条', diffCents: 0, code: 'S2' }] },
];
const voucherBase = {
  channel: 'owned', channelLabel: '本人自持', kind: 'combo', originalPriceCents: 0,
  constraints: { orderType: 'instore', noStack: true }, buyPath: '（本人已持有，无需购买）',
  redeemPath: '按券面说明核销', verifiedAt: '2026-10-18', source: 'user', evidence: '测试券',
};
const menuForRecall = {
  items: [
    { code: 'S1', name: '板烧鸡腿麦满分', priceCents: 1250, originalPriceCents: 1250, category: '早餐', tags: [], kcal: 215, protein: 14, fat: 7, carbohydrate: 20, sodium: 500, isCombo: false, fastCarb: 0, isVeggie: false, isStaple: true, nutritionMatched: true },
    { code: 'S2', name: '中薯条', priceCents: 1100, originalPriceCents: 1100, category: '小食', tags: [], kcal: 287, protein: 3, fat: 14, carbohydrate: 36, sodium: 200, isCombo: false, fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: true },
    { code: 'C1', name: '板烧鸡腿麦满分套餐', priceCents: 2000, originalPriceCents: 2000, category: '套餐', tags: ['二件套'], kcal: 502, protein: 17, fat: 21, carbohydrate: 56, sodium: 700, isCombo: true, fastCarb: 0, isVeggie: false, isStaple: true, nutritionMatched: true, deconstruction: DECON },
  ],
  unmatched: 0, comboCount: 1, comboUnmatched: 0, table: new Map(),
};
const singleCopy = await recallChannelPlans(makeClient({ menus: { now: MENU_SYNTH } }), { storeCode: 'S1', storeName: '测试门店' }, menuForRecall, [
  { ...voucherBase, id: 'u-one', name: '单份板烧套餐券', priceCents: 1000, items: [{ mode: 'combo-ref', keyword: 'C1', qty: 1, comboName: '板烧鸡腿麦满分套餐' }] },
]);
const onePlan = singleCopy.voucherPlans[0];
check(!!onePlan && onePlan.officialComboCode === 'C1' && onePlan.officialComboCopies === 1,
  '单份同款券：officialComboCode + copies=1（可独立承接）', onePlan && { code: onePlan.officialComboCode, copies: onePlan.officialComboCopies });

const twoCopy = await recallChannelPlans(makeClient({ menus: { now: MENU_SYNTH } }), { storeCode: 'S1', storeName: '测试门店' }, menuForRecall, [
  { ...voucherBase, id: 'u-two', name: '双份板烧套餐券', priceCents: 1800, items: [
    { mode: 'combo-ref', keyword: 'C1', qty: 1, comboName: '板烧鸡腿麦满分套餐' },
    { mode: 'combo-ref', keyword: 'C1', qty: 1, comboName: '板烧鸡腿麦满分套餐' },
  ] },
]);
const twoPlan = twoCopy.voucherPlans[0];
check(!!twoPlan && twoPlan.officialComboCode === 'C1' && twoPlan.officialComboCopies === 2,
  '双份同款券：记录 copies=2（份数证据可审计）', twoPlan && { code: twoPlan.officialComboCode, copies: twoPlan.officialComboCopies });
check(!!twoPlan && twoPlan.slots.length === 2 * DECON.length, '双份券的槽位是官方的两倍（结构上不能冒充单份）', twoPlan && twoPlan.slots.length);

const mixed = await recallChannelPlans(makeClient({ menus: { now: MENU_SYNTH } }), { storeCode: 'S1', storeName: '测试门店' }, menuForRecall, [
  { ...voucherBase, id: 'u-mix', name: '套餐+单堡券', priceCents: 1500, items: [
    { mode: 'combo-ref', keyword: 'C1', qty: 1, comboName: '板烧鸡腿麦满分套餐' },
    { mode: 'fixed', keyword: '板烧鸡腿麦满分', qty: 1 },
  ] },
]);
check(!mixed.voucherPlans[0]?.officialComboCode, '带额外固定品项的券不记录同款证据（不冒充）', mixed.voucherPlans[0] && mixed.voucherPlans[0].officialComboCode);

// 行为断言：单份券可承接「1 份套餐」心愿；双份券不得承接同一份需求
{
  const { comboPlans } = buildPlansFromMenuItems(menuForRecall.items);
  const demand = { alias: '甲', demands: [{ id: 'd1', keyword: '板烧鸡腿麦满分套餐', qty: 1, comboPlanId: 'mcd-C1' }] };
  const r1 = await optimize({ plans: [...comboPlans, onePlan], members: [demand], mode: 'cheapest' });
  check(r1.assignments.some((a) => a.planId === 'kv-u-one'),
    `单份同款券承接了套餐心愿（实际购买 ${r1.assignments.map((a) => a.planId).join(',') || '无'}）`);
  const r2 = await optimize({ plans: [...comboPlans, twoPlan], members: [demand], mode: 'cheapest' });
  check(r2.assignments.some((a) => a.planId === 'mcd-C1') && !r2.assignments.some((a) => a.planId === 'kv-u-two'),
    `双份券不冒充单份需求，仍买官方套餐（实际 ${r2.assignments.map((a) => a.planId).join(',') || '无'}）`);
}

// ---------------------------------------------------------------- N01-5 目录 API
console.log('\n[N01-5] 分时段目录入口：池摘要 + 目标时段遗漏账');
_clearPeriodCatalogCache();
const apiOut = await servicePeriodCatalog(makeClient({ menus: FIX_MENUS }), { storeCode: '1450684', storeName: '测试门店', date: '2026-10-18', targetTime: '08:00' });
check(apiOut.catalog.queries.length === 3 && apiOut.pools.length === 2, '返回三锚点目录与两个餐段池摘要');
check(apiOut.targetPeriod === 'breakfast', '目标时段按 targetTime 判定', apiOut.targetPeriod);
check(apiOut.ledger.length === apiOut.catalog.items.length, '遗漏账逐商品覆盖（不漏项）', [apiOut.ledger.length, apiOut.catalog.items.length]);
check(apiOut.ledger.filter((r) => r.sellable).length === 60, '目标时段可售条数与早餐池一致', apiOut.ledger.filter((r) => r.sellable).length);
check(apiOut.ledger.every((r) => r.sellable || !!r.reason), '未进池的商品都带原因', apiOut.ledger.filter((r) => !r.sellable && !r.reason).length);
check(apiOut.ledger.every((r) => r.structure === 'not-expanded'), '未与求解结果联结时结构阶段标为「未展开」（不假装已知）');

console.log(failed === 0 ? '\nv1.4.9 N01 回归：全部通过 ✓' : `\n${failed} 项未通过 ✗`);
process.exit(failed === 0 ? 0 : 1);
