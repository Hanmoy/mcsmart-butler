// v1.4.8 评审修复回归（R01—R14 + N01 相关口径）
// 运行：npm test 或 node scripts/test-v148-review-fixes.mjs（需先 tsc）
//
// 每个用例都对应 2026-10-18 评审报告里**已复现**的反例，断言行为而非实现细节：
//   R01 重复点击详情 / 交叉切换：恰有一个内容区可见，按钮文案由活动视图派生
//   R02 早餐「套餐/组合」按完整轮次建模（真实菜单回执回放），结构存疑不当单品
//   R03 推荐与官方最优共用「未满足数 → 实付」比较器（完整套餐不得输给残缺便宜单点）
//   R04 同款 combo-ref 券可独立承接套餐心愿（少槽/多槽不冒充）
//   R05 倒挂比价以实际购买单元为准（未写心愿的券内食品不漏算；中/小薯不互换）
//   R06 「恰好一份」约束本人跨渠道实际所得（不得悄悄多分）
//   R07 规格参与食品身份（同 code 小/大份不合并）
//   R08 套餐详情失败/降级按短 TTL 重试（不得当作成功缓存）
//   R09 快照当前可购池过滤为空时保持为空（不复活早餐品项）
//   R10 套餐价格上限不再在目录层静默丢弃官方商品
//   R11 锁超时返回 E_LOCK_BUSY 且不执行写回调；活进程锁不被按年龄抢占
//   R12 损坏用户文件不得被当空库覆盖（E_STORAGE_CORRUPT，原字节保留）
//   R13 qty 正安全整数 + 显式上限，声明与展开数量守恒
//   R14 constraints 容器类型与非数值 value 被拒绝（null 不再变成 0）
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, truncateSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'v148');
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v148-'));
process.env.MCSMART_HOME = TEST_HOME;
process.env.MEITUAN_UNION_APPKEY = '';
process.env.MEITUAN_UNION_APPSECRET = '';
process.env.MCSMART_DISABLE_BUNDLED_UNION = '1';
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const { loadMenuItems, _comboCacheState, _clearComboCache, _clearMenuCache } = await import('../dist/menu.js');
const { solveGroupWithKernel } = await import('../dist/groupKernel.js');
const { optimize, buildPlansFromMenuItems } = await import('../dist/optimizer.js');
const { foodKeyOf, foodMultisetSignature } = await import('../dist/foodIdentity.js');
const { officialEquivalentCentsForUnits } = await import('../dist/vouchers.js');
const { normalizeConstraints } = await import('../dist/service.js');
const { normalizeRecipeInput } = await import('../dist/recipeSchema.js');
const { withUserFileLock, UserFileLockError } = await import('../dist/userFileLock.js');
const { readJsonFileState, readJsonFileForWrite, UserStoreError } = await import('../dist/userStore.js');
const { saveRecipe, loadRecipes, _resetRecipeCache } = await import('../dist/voucherRecipes.js');
const { resolveVoucherFoods } = await import('../dist/voucherFoods.js');
const { menuSnapshot } = await import('../dist/catalog.js');
const { parseWishPhrase, findMenuItem } = await import('../dist/group.js');

let failures = 0;
let checks = 0;
const check = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? `（${detail}）` : ''}`); failures++; }
};
const catchSync = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const catchAsync = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const json = (p) => JSON.parse(readFileSync(p, 'utf-8'));

/** 回放用假 MCP 客户端：只回答菜单/营养/详情，计价明确失败（模型价口径）。 */
function replayClient({ menu, details, nutritionRaw, onDetail }) {
  return {
    async call(tool, args = {}) {
      if (tool === 'query-meals') return menu;
      if (tool === 'list-nutrition-foods') return { rawText: nutritionRaw, data: {} };
      if (tool === 'query-meal-detail') {
        onDetail?.(args.code);
        const d = details[args.code];
        if (!d) throw new Error(`mock: 详情不可用 ${args.code}`);
        return d;
      }
      if (tool === 'calculate-price') throw new Error('mock: 不核价');
      if (tool === 'query-nearby-stores') return { data: [] };
      throw new Error(`mock: ${tool}`);
    },
  };
}

// ========== R01：详情按钮重复点击 / 交叉切换 ==========
console.log('【R01】卡片视图切换：单一活动视图，重复点击回购买清单');
{
  const html = readFileSync(join(HERE, '..', 'public', 'index.html'), 'utf-8');
  check(/function applyCardView\(/.test(html), '存在统一的视图切换函数（状态由 data-active-view 派生）');
  check(!/views\[target\]\.style\.display !== 'none'/.test(html), '不再用「当前是否可见」反推状态（重复点击会隐藏全部内容）');
  check(/active === target \? 'buy' : target/.test(html), '再次点击当前详情 → 回购买清单');
  check(/btn\.textContent = on \? '🛒 返回购买清单'/.test(html), '按钮文案由活动视图统一派生（不再串状态）');
  check(/const target = views\[next\] \? next : 'buy'/.test(html), '缺失视图（无出餐内容）回落购买清单');
}

// ========== R02：早餐套餐结构（真实回执回放） ==========
console.log('【R02】早餐「套餐/组合」按完整轮次建模（真实 08:00 菜单回放）');
const breakfastMenu = json(join(FIX, 'menu-0800.json'));
const nutritionRaw = json(join(FIX, 'nutrition.json')).rawText;
const breakfastDetails = {
  '9900003457': json(join(FIX, 'detail-9900003457.json')),
  '9900003459': json(join(FIX, 'detail-9900003459.json')),
};
let breakfastResult;
{
  const client = replayClient({ menu: breakfastMenu, details: breakfastDetails, nutritionRaw });
  breakfastResult = await loadMenuItems(client, 'BREAKFAST-STORE', { includeUnmatched: true });
  const combos = breakfastResult.items.filter((i) => i.isCombo);
  const structured = combos.filter((i) => (i.deconstruction?.length ?? 0) > 0);
  const set3457 = breakfastResult.items.find((i) => i.code === '9900003457');
  const set3459 = breakfastResult.items.find((i) => i.code === '9900003459');
  check(structured.length === 2, `取得完整轮次的早餐套餐数 = 2（实际 ${structured.length}；识别为套餐共 ${combos.length} 项）`);
  check(set3457?.deconstruction?.length === 3, `原味板烧鸡腿麦满分套餐展开 3 个轮次（实际 ${set3457?.deconstruction?.length}）`);
  check(set3459?.deconstruction?.length === 3, `双层原味板烧鸡腿麦满分套餐展开 3 个轮次（实际 ${set3459?.deconstruction?.length}）`);
  check((set3457?.kcal ?? 0) > 300, `整套餐热量按完整结构聚合（${set3457?.kcal} kcal，不再用主食 246 kcal 冒充）`);
  check((set3457?.stapleCount ?? 0) >= 1, `主食份数来自轮次判定（${set3457?.stapleCount}）`);
  const structIssue = (breakfastResult.structureIssues ?? []).find((s) => s.includes('原味板烧鸡腿麦满分组合'));
  check(!!structIssue, '「原味板烧鸡腿麦满分组合」结构未取得时记入 structureIssues（不再当单品）',
    structIssue ? structIssue.slice(0, 60) : '未记录');
  const degraded = breakfastResult.items.find((i) => i.code === '9900003493');
  check(!degraded || degraded.structureUnknown === true, '降级条目带 structureUnknown 标记（不得充当已覆盖证据）');
  check(combos.every((i) => !i.structureUnknown || (i.deconstruction?.length ?? 0) === 0),
    '「结构未知」与「有轮次」互斥（不出现半成品结构）');

  // 心愿「板烧鸡腿麦满分套餐」必须命中真套餐，而不是组合单品
  const spec = parseWishPhrase('板烧鸡腿麦满分套餐');
  const hit = findMenuItem(spec, breakfastResult.items);
  check(hit?.item?.code === '9900003457', `心愿命中真套餐（${hit?.item?.code} ${hit?.item?.name}）`);
  check(hit?.item?.isCombo === true, '命中的是套餐（isCombo=true）');

  // 同 code 的第二次分类标签必须被聚合（DUPLICATE-METADATA 反例）
  const tags3457 = breakfastResult.items.find((i) => i.code === '9900003457')?.tags ?? [];
  check(tags3457.length > 0, `同 code 多分类标签被聚合（${tags3457.join('/') || '无'}）`);
}

// ========== R08：详情失败/降级按短 TTL 重试 ==========
console.log('【R08】套餐详情失败不得当作成功缓存');
{
  _clearComboCache(); _clearMenuCache();
  let attempts = 0;
  const menu = {
    success: true,
    data: {
      categories: [{ name: '套餐区', meals: [{ code: 'R08-C', tags: ['三件套'] }] }],
      meals: { 'R08-C': { name: '测试三件套', currentPrice: '30', originalPrice: '40' } },
    },
  };
  const detail = {
    success: true,
    data: {
      code: 'R08-C',
      rounds: [
        { id: 1, name: '主食', choices: [{ code: 'A1', name: '甲堡', isDefault: 1, diffPrice: '+ ¥0' }] },
        { id: 2, name: '小食', choices: [{ code: 'A2', name: '中薯条', isDefault: 1, diffPrice: '+ ¥0' }] },
      ],
    },
  };
  const nut = '[2]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  甲堡,null,1000,240,12,8,25,500,100\n  中薯条,null,1210,289,4,12,38,165,18';
  const failing = replayClient({
    menu, details: {}, nutritionRaw: nut,
    onDetail: () => { attempts++; },
  });
  const r1 = await loadMenuItems(failing, 'R08-STORE', { includeUnmatched: true });
  check(attempts === 1, `首次详情失败调用 1 次（实际 ${attempts}）`);
  check(_comboCacheState('R08-STORE', 'R08-C', true) === 'failed', '失败状态记为 failed（不再伪装成功）');
  check((r1.structureIssues ?? []).length > 0, '失败原因逐项记录');

  // 失败 TTL 内再次加载（清菜单缓存以绕过 15 分钟结果缓存）→ 不重复打上游
  _clearMenuCache();
  await loadMenuItems(failing, 'R08-STORE', { includeUnmatched: true });
  check(attempts === 1, `失败 TTL 内不重复请求（实际 ${attempts} 次）`);

  // 模拟失败 TTL 到期 → 重新加载必须重试，并在上游恢复后拿到完整结构
  _clearComboCache(); _clearMenuCache();
  const okClient = replayClient({ menu, details: { 'R08-C': detail }, nutritionRaw: nut, onDetail: () => { attempts++; } });
  const r3 = await loadMenuItems(okClient, 'R08-STORE', { includeUnmatched: true });
  check(attempts === 2, `TTL 到期后重试（实际 ${attempts} 次）`);
  check(_comboCacheState('R08-STORE', 'R08-C', true) === 'ok', '上游恢复后状态更新为 ok');
  check(r3.items.find((i) => i.code === 'R08-C')?.deconstruction?.length === 2, '恢复后取得完整轮次');
}

// ========== R03/R04：推荐比较器与同款券承接 ==========
console.log('【R03】完整套餐方案不得输给有缺口的便宜单点');
const synthMenu = {
  success: true,
  data: {
    categories: [
      { name: '套餐区', meals: [{ code: 'T-C3', tags: ['三件套'] }] },
      { name: '单点区', meals: [{ code: 'T-BS' }] },
    ],
    meals: {
      'T-C3': { name: '板烧鸡腿堡三件套', currentPrice: '58', originalPrice: '70' },
      'T-BS': { name: '板烧鸡腿堡', currentPrice: '23.5' },
    },
  },
};
const synthDetail = {
  success: true,
  data: {
    code: 'T-C3',
    rounds: [
      { id: 1, name: '主食', choices: [{ code: 'T-BS', name: '板烧鸡腿堡', isDefault: 1, diffPrice: '+ ¥0' }] },
      { id: 2, name: '小食', choices: [{ code: 'T-FRIES', name: '中薯条', isDefault: 1, diffPrice: '+ ¥0' }] },
      { id: 3, name: '饮料', choices: [{ code: 'T-COLA', name: '可口可乐（中杯）', isDefault: 1, diffPrice: '+ ¥0' }] },
    ],
  },
};
const synthNutrition = '[3]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n'
  + '  板烧鸡腿堡,null,1400,334,17,13,35,700,100\n  中薯条,null,1210,289,4,12,38,165,18\n  可口可乐（中杯）,null,600,143,0,0,35,10,0';
{
  _clearComboCache(); _clearMenuCache();
  const client = replayClient({ menu: synthMenu, details: { 'T-C3': synthDetail }, nutritionRaw: synthNutrition });
  const res = await solveGroupWithKernel(client, {
    storeCode: 'R03-STORE',
    members: [
      { alias: '甲', wishes: ['板烧鸡腿堡三件套'], taboos: [] },
      { alias: '乙', wishes: ['板烧鸡腿堡'], taboos: [] },
    ],
  });
  const rec = res.unified[res.recommendedIndex];
  const cheap = res.unified.find((u) => u.totals.paidCents === 2350);
  check(res.unified[0].coverage?.met === 2 && res.unified[0].gapTotal === 0, `统一候选首位 = 覆盖 2/2 的完整方案（${res.unified[0]?.totals.paidCents} 分）`);
  check(rec?.gapTotal === 0 && rec?.coverage?.met === 2, `推荐指向完整方案（${rec?.totals.paidCents} 分，缺口 ${rec?.gapTotal}）`);
  check(res.recommendedIndex === 0, `推荐索引与统一候选首位一致（${res.recommendedIndex}）`);
  check(rec?.totals.paidCents !== 2350, '推荐不再是那个有缺口的便宜单点');
  check(!!cheap && cheap.gapTotal === 1, '便宜单点仍作为「有缺口的备选」存在（未被删除）');
}

console.log('【R04】同款 combo-ref 券可独立承接套餐心愿');
{
  _clearComboCache(); _clearMenuCache();
  const client = replayClient({ menu: synthMenu, details: { 'T-C3': synthDetail }, nutritionRaw: synthNutrition });
  const res = await solveGroupWithKernel(client, {
    storeCode: 'R04-STORE',
    members: [
      { alias: '甲', wishes: ['板烧鸡腿堡三件套'], taboos: [] },
      { alias: '乙', wishes: ['板烧鸡腿堡'], taboos: [] },
    ],
    userVouchers: [{
      id: 'uv-combo-ref', channel: 'meituan', channelLabel: '美团团购（到店）', kind: 'combo',
      name: '板烧鸡腿堡三件套券', priceCents: 1000, originalPriceCents: 5800,
      items: [{ mode: 'combo-ref', keyword: 'T-C3', qty: 1 }],
      constraints: { orderType: 'instore' },
      buyPath: '（平台页面）', redeemPath: '（券面说明）', verifiedAt: '2026-10-18',
      source: 'user', evidence: '测试：券面即官方同款套餐',
    }],
  });
  const withVoucher = res.unified.find((u) => u.basket.some((b) => /券/.test(b.name)));
  check(!!withVoucher && withVoucher.totals.paidCents === 3350,
    `券 + 一份官方单点 = 3350 分（实际 ${withVoucher?.totals.paidCents}）`);
  check(!!withVoucher && !withVoucher.basket.some((b) => /三件套/.test(b.name) && !/券/.test(b.name)),
    '券方案内不再购买官方套餐（券独立承接套餐心愿）');
  check(!!withVoucher && withVoucher.totals.paidCents < 5800, `比单买官方套餐（5800 分）更省（${withVoucher?.totals.paidCents} < 5800）`);
  check(res.unified[res.recommendedIndex]?.basket.some((b) => /券/.test(b.name)), '推荐方案使用同款券承接套餐');
}

console.log('【R04-反例】少槽/带额外食品的券不得冒充同款');
{
  // 券面 = 官方套餐 + 额外一份薯条 → 槽位数多于官方套餐，不得作为套餐心愿的承接者
  const plans = buildPlansFromMenuItems([
    { code: 'X-C3', name: '测试三件套', priceCents: 5800, originalPriceCents: 5800, category: '套餐', tags: ['三件套'], kcal: 700, protein: 30, fat: 20, carbohydrate: 60, sodium: 900, fastCarb: 0, isVeggie: false, isStaple: true, isCombo: true, nutritionMatched: true,
      deconstruction: [
        { roundName: '主食', category: 'staple', defaultName: '甲堡', options: [{ name: '甲堡', diffCents: 0, code: 'A1' }] },
        { roundName: '小食', category: 'side', defaultName: '中薯条', options: [{ name: '中薯条', diffCents: 0, code: 'A2' }] },
      ] },
    { code: 'A1', name: '甲堡', priceCents: 2000, originalPriceCents: 2000, category: '汉堡', tags: [], kcal: 300, protein: 15, fat: 10, carbohydrate: 30, sodium: 500, fastCarb: 0, isVeggie: false, isStaple: true, isCombo: false, nutritionMatched: true },
    { code: 'A2', name: '中薯条', priceCents: 1200, originalPriceCents: 1200, category: '小食', tags: [], kcal: 289, protein: 4, fat: 12, carbohydrate: 38, sodium: 165, fastCarb: 0, isVeggie: false, isStaple: false, isCombo: false, nutritionMatched: true },
  ]);
  check(plans.comboPlans.length === 1, '合成官方套餐计划 1 个');
  const voucherPlan = {
    id: 'kv-x', channel: 'meituan-cps', name: '三件套+额外薯条券', basePriceCents: 1500, maxQty: 1,
    strictCover: true, slots: [
      { roundName: '主食', defaultName: '甲堡', options: [{ name: '甲堡', kcal: 300, priceCents: 2000, diffCents: 0, staple: true, veggie: false, code: 'A1', protein: 15, fat: 10, carbohydrate: 30, sodium: 500 }] },
      { roundName: '小食', defaultName: '中薯条', options: [{ name: '中薯条', kcal: 289, priceCents: 1200, diffCents: 0, staple: false, veggie: false, code: 'A2', protein: 4, fat: 12, carbohydrate: 38, sodium: 165 }] },
      { roundName: '额外小食', defaultName: '中薯条', options: [{ name: '中薯条', kcal: 289, priceCents: 1200, diffCents: 0, staple: false, veggie: false, code: 'A2', protein: 4, fat: 12, carbohydrate: 38, sodium: 165 }] },
    ],
    officialComboCode: 'X-C3',
  };
  const r = await optimize({
    plans: [...plans.comboPlans, voucherPlan],
    members: [{ alias: '甲', demands: [{ id: 'd1', keyword: '测试三件套', qty: 1, comboPlanId: 'mcd-X-C3' }] }],
    mode: 'cheapest',
  });
  const bought = r.assignments.map((a) => a.planId);
  check(bought.includes('mcd-X-C3'), `多槽券未被当作同款承接（实际购买 ${bought.join(',') || '无'}）`);
}

// ========== R05：同配比价以实际购买单元为准 ==========
console.log('【R05】倒挂比价不得漏食品、不得丢规格');
{
  // 反例：券含板烧 1490 + 脆汁鸡 1290（券价 2310），同配单点应为 2780，而不是 1490
  const units = [
    { name: '板烧鸡腿堡', qty: 1, officialUnitPriceCents: 1490 },
    { name: '脆汁鸡', qty: 1, officialUnitPriceCents: 1290 },
  ];
  const equiv = officialEquivalentCentsForUnits(units, []);
  check(equiv === 2780, `券内全部食品计入同配价（${equiv} 分）`);
  check(equiv !== 1490, '不再只用「已覆盖心愿」的单品价（1490）作比较基准');

  // 规格：中薯/小薯不得互换
  const skus = [{
    code: 'SKU-2', name: '双件', priceCents: 2000,
    rounds: [
      { id: '1', name: '主食', choices: [{ code: 'F1', name: '薯条（中份）', diffCents: 0 }] },
      { id: '2', name: '饮料', choices: [{ code: 'F2', name: '可口可乐', diffCents: 0 }] },
    ],
    deconstruction: [],
  }];
  const mid = officialEquivalentCentsForUnits([
    { name: '薯条（中份）', qty: 1, officialUnitPriceCents: 1200 },
    { name: '可口可乐', qty: 1, officialUnitPriceCents: 900 },
  ], skus);
  const small = officialEquivalentCentsForUnits([
    { name: '薯条（小份）', qty: 1, officialUnitPriceCents: 1000 },
    { name: '可口可乐', qty: 1, officialUnitPriceCents: 900 },
  ], skus);
  check(mid === 2000, `同配套餐命中（中薯 = 套餐价 ${mid}）`);
  check(small !== 2000, `小薯不得套用中薯套餐价（${small}）`);
  check(small === 0 || small === 1900, `小薯无同配套餐价时按单点合计或明确不可核验（${small}）`);

  // 份数：一份 vs 两份不得等价
  const one = officialEquivalentCentsForUnits([{ name: '薯条（中份）', qty: 1, officialUnitPriceCents: 1200 }], []);
  const two = officialEquivalentCentsForUnits([{ name: '薯条（中份）', qty: 2, officialUnitPriceCents: 1200 }], []);
  check(one === 1200 && two === 2400, `份数参与同配价（${one} / ${two}）`);

  // 缺失官方单点价 → 不可核验（不得给出 0 元基准）
  const unknown = officialEquivalentCentsForUnits([{ name: '未知食品', qty: 1, officialUnitPriceCents: 0 }], []);
  check(unknown === 0, '任一食品缺官方价 → 返回 0（不可核验）');
}

// ========== R06：恰好一份 = 实际所得 ==========
console.log('【R06】「恰好一份」约束本人实际所得，不得悄悄多分');
{
  const opt = (name, kcal, price, code) => ({ name, kcal, priceCents: price, diffCents: 0, staple: true, veggie: false, code, protein: 20, fat: 15, carbohydrate: 40, sodium: 600 });
  const plans = [
    { id: 'mcd-s-A', channel: 'mcd-mcp', name: '甲堡', basePriceCents: 1200, maxQty: 2,
      slots: [{ roundName: '单品', defaultName: '甲堡', options: [opt('甲堡', 500, 1200, 'A')] }] },
    { id: 'mcd-D', channel: 'mcd-mcp', name: '双堡套餐', basePriceCents: 1000, maxQty: 2,
      slots: [
        { roundName: '堡1', defaultName: '甲堡', options: [opt('甲堡', 500, 1200, 'A')] },
        { roundName: '堡2', defaultName: '甲堡', options: [opt('甲堡', 500, 1200, 'A')] },
      ] },
  ];
  const r = await optimize({
    plans,
    members: [{ alias: '甲', demands: [{ id: 'd1', keyword: '甲堡', qty: 1, exact: true }] }],
    mode: 'cheapest',
  });
  const mine = r.memberAllocations[0]?.items.reduce((s, it) => s + it.qty, 0) ?? 0;
  check(mine === 1, `本人实际所得 = 1 份（实际 ${mine} 份）`);
  check(r.status !== 'infeasible', `仍有可行解（${r.status}，${r.totals.priceCents} 分）`);
  check(r.totals.priceCents <= 1200, `多出的份数留作剩余而非塞给本人（实付 ${r.totals.priceCents} 分）`);

  // 反例：恰好两份时正常分配两份（不得误伤合法需求）
  const bad = await optimize({
    plans: [plans[0]],
    members: [{ alias: '甲', demands: [{ id: 'd1', keyword: '甲堡', qty: 2, exact: true }] }],
    mode: 'cheapest',
  });
  const two = bad.memberAllocations[0]?.items.reduce((s, it) => s + it.qty, 0) ?? 0;
  check(bad.status !== 'infeasible' && two === 2, `恰好两份时正常分配两份（${bad.status}，${two} 份）`);
}

// ========== R07：规格参与食品身份 ==========
console.log('【R07】同 code 不同规格保持两个身份');
{
  const small = foodKeyOf({ code: '4810', name: '薯条', spec: '小份' });
  const large = foodKeyOf({ code: '4810', name: '薯条', spec: '大份' });
  check(small !== large, `小/大份身份不同（${small} ≠ ${large}）`);
  check(foodKeyOf({ code: '4810', name: '薯条', spec: '小份' }) === foodKeyOf({ code: '4810', name: '薯条（小）', spec: '小份' }),
    '同 code 同规格的不同写法仍合并');
  check(foodMultisetSignature([{ code: '4810', name: '薯条', spec: '小份', qty: 1 }])
    !== foodMultisetSignature([{ code: '4810', name: '薯条', spec: '大份', qty: 1 }]),
    '去重签名同样区分规格');
  check(foodKeyOf({ code: '4810', name: '薯条', spec: '原味' }) === foodKeyOf({ code: '4810', name: '薯条' }),
    '非规格描述（原味）不制造伪身份');
}

// ========== R09：快照当前可购池 ==========
console.log('【R09】过滤为空不得复活早餐品项');
{
  const { upsertMenuSnapshot } = await import('../dist/catalog.js');
  const item = (code, name, category, tags) => ({
    code, name, priceCents: 1000, originalPriceCents: 1000, category, tags,
    kcal: 300, protein: 10, fat: 10, carbohydrate: 30, sodium: 500,
    fastCarb: 0, isVeggie: false, isStaple: true, isCombo: false, nutritionMatched: true,
  });
  // 08:00 观测：三项都是早餐时段观测到（名称/标签都不含「早餐」的两项靠观测上下文识别）
  const morning = new Date();
  morning.setHours(8, 0, 0, 0);
  upsertMenuSnapshot('R09-STORE', [
    item('B1', '双层原味板烧鸡腿麦满分套餐', '麦满分系列', ['三件套']),
    item('B2', '原味板烧鸡腿麦满分', '麦满分系列', ['单品']),
    item('B3', '脆香油条', '早餐小食', []),
  ], { observedAt: morning });
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const view = menuSnapshot('R09-STORE', { currentOnly: true, now: noon });
  check(view.items.length === 0, `非早餐时段当前池为空（实际 ${view.items.length} 项）`);
  check(view.fellBackToFull === false, '不再回退完整历史快照');
  check(view.emptyReason === 'off-period', `原因为「非当前餐段」（${view.emptyReason}）`);
  const full = menuSnapshot('R09-STORE');
  check(full.items.length === 3, `历史目录仍完整保留（${full.items.length} 条）`);

  // 同一批商品在午餐时段再次观测 → 进入常规时段集合，午间不再被误排除
  upsertMenuSnapshot('R09-STORE', [item('B2', '原味板烧鸡腿麦满分', '麦满分系列', ['单品'])], { observedAt: noon });
  const view2 = menuSnapshot('R09-STORE', { currentOnly: true, now: noon });
  check(view2.items.length === 1 && view2.items[0].code === 'B2', `午餐观测到的品项进入当前池（${view2.items.map((i) => i.code).join(',')}）`);
}

// ========== R10：价格上限不再静默丢弃 ==========
console.log('【R10】官方已返回的套餐不得因价格上限被静默丢弃');
{
  _clearComboCache(); _clearMenuCache();
  const seen = [];
  const menu = {
    success: true,
    data: {
      categories: [{ name: '套餐区', meals: [{ code: 'P73', tags: ['套餐'] }, { code: 'P120', tags: ['套餐'] }] }],
      meals: {
        P73: { name: '堡堡随心拼（7件任选）', currentPrice: '73' },
        P120: { name: '豪华分享餐', currentPrice: '120' },
      },
    },
  };
  const mkDetail = (code, names) => ({
    success: true,
    data: { code, rounds: names.map((n, i) => ({ id: i + 1, name: `轮${i + 1}`, choices: [{ code: `P${i}`, name: n, isDefault: 1, diffPrice: '+ ¥0' }] })) },
  });
  const client = replayClient({
    menu,
    details: { P73: mkDetail('P73', ['甲堡', '中薯条']), P120: mkDetail('P120', ['甲堡', '中薯条', '可乐']) },
    nutritionRaw: synthNutrition,
    onDetail: (c) => seen.push(c),
  });
  const r = await loadMenuItems(client, 'R10-STORE', { includeUnmatched: true });
  check(seen.includes('P73') && seen.includes('P120'), `¥73 / ¥120 套餐均查询了详情（${seen.join(',')}）`);
  check(r.items.filter((i) => i.isCombo).length === 2, `两个套餐都进入目录（${r.items.filter((i) => i.isCombo).length}）`);
  check(r.comboCapped === undefined, '未发生条数截断时不虚构截断记录');
}

// ========== R11：锁语义 ==========
console.log('【R11】锁超时不得无锁写入；活进程锁不得按年龄抢占');
{
  const dir = join(TEST_HOME, 'lock');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'data.json');

  // 1) 活进程持锁（模拟另一进程 pid 存活）→ 超时抛 E_LOCK_BUSY，回调执行 0 次
  writeFileSync(`${target}.lock`, JSON.stringify({ pid: process.pid, token: 'other', at: new Date().toISOString() }));
  let ran = 0;
  const err = catchSync(() => withUserFileLock(target, () => { ran++; return 'x'; }, { timeoutMs: 150, pollMs: 20 }));
  check(err instanceof UserFileLockError, `超时抛 UserFileLockError（${err?.code}）`);
  check(err?.code === 'E_LOCK_BUSY', '稳定错误码 E_LOCK_BUSY（可重试）');
  check(ran === 0, `未获锁时写回调执行次数 = 0（实际 ${ran}）`);
  check(existsSync(`${target}.lock`), '他人的锁文件未被删除');

  // 2) 活进程持锁超过 staleMs 也不得被抢占
  const old = Date.now() - 60_000;
  writeFileSync(`${target}.lock`, JSON.stringify({ pid: process.pid, token: 'other', at: new Date(old).toISOString() }));
  const err2 = catchSync(() => withUserFileLock(target, () => { ran++; }, { timeoutMs: 150, pollMs: 20, staleMs: 50 }));
  check(err2?.code === 'E_LOCK_BUSY' && ran === 0, '活进程持锁再久也不按年龄抢占（回调仍为 0 次）');

  // 3) 持有者进程已不存在 → 可抢占（崩溃残锁不阻塞用户）
  writeFileSync(`${target}.lock`, JSON.stringify({ pid: 999999, token: 'dead', at: new Date().toISOString() }));
  const got = catchSync(() => withUserFileLock(target, () => { ran++; return 'ok'; }, { timeoutMs: 500, pollMs: 20 }));
  check(got === null && ran === 1, `崩溃残锁被回收并成功执行（ran=${ran}）`);
  check(!existsSync(`${target}.lock`), '执行完毕后锁被释放');

  // 4) 释放前校验持有权：临界区内锁被他人替换 → 不得删除他人的锁
  const t2 = join(dir, 'data2.json');
  withUserFileLock(t2, () => {
    writeFileSync(`${t2}.lock`, JSON.stringify({ pid: process.pid, token: 'replaced', at: new Date().toISOString() }));
  });
  check(existsSync(`${t2}.lock`), '锁被替换后不删除他人锁（持有权校验生效）');
  rmSync(`${t2}.lock`, { force: true });
}

// ========== R12：损坏文件保护 ==========
console.log('【R12】损坏用户文件不得被当空库覆盖');
{
  const dir = join(TEST_HOME, 'corrupt');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'recipes.json');
  writeFileSync(file, '{"version":1,"recipes":[{"id":"A"},{"id":"B"}],"updatedAt":""}');
  truncateSync(file, 10); // 截断成非法 JSON
  const before = readFileSync(file, 'utf-8');

  check(readJsonFileState(file).state === 'corrupt', '状态区分为 corrupt（不是 missing）');
  const err = catchSync(() => readJsonFileForWrite(file, '配方库'));
  check(err instanceof UserStoreError, `写入口抛 UserStoreError（${err?.code}）`);
  check(err?.code === 'E_STORAGE_CORRUPT', '稳定错误码 E_STORAGE_CORRUPT');
  check(readFileSync(file, 'utf-8') === before, '原文件字节未被修改（可恢复资料保留）');

  // 保存路径同样拒绝覆盖（必须命中真实的配方库路径，而不是任意测试文件）
  const recipeFile = join(TEST_HOME, 'voucher-recipes.json');
  writeFileSync(recipeFile, '{"version":1,"recipes":[{"id":"A"},{"id":"B"}],"updatedAt":""}');
  truncateSync(recipeFile, 10);
  const recipeBefore = readFileSync(recipeFile, 'utf-8');
  _resetRecipeCache();
  const saveErr = catchSync(() => saveRecipe({
    id: 'rcp-c', name: '测试券', matchNames: ['测试券'], resolve: 'explicit', channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'fixed', keyword: '麦香鸡', qty: 1 }], conditions: { orderType: 'instore' },
    priceCents: 1000, originalPriceCents: 0, buyPath: 'x', redeemPath: 'y', evidence: 'e',
    verifiedAt: '2026-10-18', ruleVersion: 'test-v1', source: 'user',
  }));
  check(saveErr?.code === 'E_STORAGE_CORRUPT', `保存遇到损坏库返回 E_STORAGE_CORRUPT（${saveErr?.code ?? '无错误'}）`);
  check(readFileSync(recipeFile, 'utf-8') === recipeBefore, '保存失败后原字节仍未被覆盖');
  check(!existsSync(recipeFile) || !readFileSync(recipeFile, 'utf-8').includes('rcp-c'), '损坏库中没有写入新记录');

  // 文件不存在 → 正常首建（不得把「不存在」当损坏）
  const fresh = join(dir, 'fresh.json');
  check(readJsonFileForWrite(fresh) === null, '文件不存在时返回 null（允许首建）');
  check(readJsonFileState(fresh).state === 'missing', '状态为 missing');
}

// ========== R13：qty 契约 ==========
console.log('【R13】qty 必须是正安全整数，声明与展开数量守恒');
{
  const base = {
    id: 'rcp-q', name: '份数测试', matchNames: ['份数测试'], resolve: 'explicit', channel: 'meituan', channelLabel: '美团团购（到店）',
    conditions: { orderType: 'instore' }, priceCents: 1000, originalPriceCents: 0,
    buyPath: 'x', redeemPath: 'y', evidence: 'e', verifiedAt: '2026-10-18', ruleVersion: 'test-v1', source: 'user',
  };
  const withQty = (qty) => ({ ...base, items: [{ mode: 'fixed', keyword: '麦香鸡', qty }] });
  check(catchSync(() => normalizeRecipeInput(withQty(1.5)))?.code === 'E_INPUT_INVALID', '1.5 被拒绝（不再取整成 2 槽）');
  check(catchSync(() => normalizeRecipeInput(withQty(0)))?.code === 'E_INPUT_INVALID', '0 被拒绝');
  check(catchSync(() => normalizeRecipeInput(withQty(21)))?.code === 'E_INPUT_INVALID', '超上限 21 被拒绝（显式声明上限 20）');
  check(normalizeRecipeInput(withQty(9)).items[0].qty === 9, '9 份通过校验（不再被截成 8）');

  const menu = {
    items: [{
      code: 'M1', name: '麦香鸡', priceCents: 1200, originalPriceCents: 1200, category: '汉堡', tags: [],
      kcal: 400, protein: 20, fat: 18, carbohydrate: 40, sodium: 700, fastCarb: 0,
      isVeggie: false, isStaple: true, isCombo: false, nutritionMatched: true,
    }],
    unmatched: 0, comboCount: 0, comboUnmatched: 0, table: new Map(),
  };
  const res = resolveVoucherFoods({ id: 'rcp-q', items: [{ mode: 'fixed', keyword: '麦香鸡', qty: 9 }] }, { menu });
  check(res.slots.length === 9, `固定 9 件完整展开 9 槽（实际 ${res.slots.length}）`);
  const res1 = resolveVoucherFoods({ id: 'rcp-q2', items: [{ mode: 'choice', keyword: 'staple', qty: 5, choiceRange: ['麦香鸡'] }] }, { menu });
  check(res1.slots.length === 5, `任选 5 件完整展开 5 槽（实际 ${res1.slots.length}）`);
}

// ========== R14：constraints 容器与取值 ==========
console.log('【R14】constraints 类型错误不得被静默丢弃');
{
  const obj = catchSync(() => normalizeConstraints({ metric: 'sodium', op: '<=', value: 800 }));
  check(obj?.code === 'E_INPUT_INVALID', `对象容器被拒绝（${obj?.code}）`);
  const str = catchSync(() => normalizeConstraints('sodium<=800'));
  check(str?.code === 'E_INPUT_INVALID', '字符串容器被拒绝');
  const nul = catchSync(() => normalizeConstraints([{ metric: 'sodium', op: '<=', value: null }]));
  check(nul?.code === 'E_INPUT_INVALID', 'value=null 被拒绝（不再转成 sodium<=0）');
  const bool = catchSync(() => normalizeConstraints([{ metric: 'sodium', op: '<=', value: true }]));
  check(bool?.code === 'E_INPUT_INVALID', 'value=true 被拒绝');
  const empty = catchSync(() => normalizeConstraints([{ metric: 'sodium', op: '<=', value: '' }]));
  check(empty?.code === 'E_INPUT_INVALID', 'value="" 被拒绝');
  const ok = normalizeConstraints([{ metric: 'sodium', op: '<=', value: '800' }]);
  check(ok.some((c) => c.metric === 'sodium' && c.op === '<=' && c.value === 800), '合法数值（含数字字符串）完整入模');
  check(normalizeConstraints(undefined).some((c) => c.metric === 'staple' && c.value === 1), '未提供约束时保留默认正餐定义');
}

console.log(`\nv1.4.8 评审修复回归：${failures === 0 ? '全部通过' : `${failures} 项失败`}（${checks} 项）`);
process.exit(failures === 0 ? 0 : 1);
