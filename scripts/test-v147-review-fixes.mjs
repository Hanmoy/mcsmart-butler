// v1.4.7 评审修复回归（R01—R20）
// 运行：npm test 或 node scripts/test-v147-review-fixes.mjs（需先 tsc）
//
// 每个用例都对应 2026-10-17 复审报告里**已复现**的反例，断言行为而非实现细节：
//   R01 中文券名不得落到同一个配方 ID（同 ID 不同商品 → E_RECIPE_CONFLICT，不静默覆盖）
//   R02 同食品的套餐/散点分块、别名、槽位顺序只占一个 Top-K 名额
//   R03 同名不同规格不得被合并（规格参与身份，不用热量近似）
//   R04 CLI/HTTP/导入共用一套 schema：身份数组与结构化补差往返保留，未知字段报错
//   R05 删除配方 = 撤销核验：匹配/继承/断网兜底三条路径都不复活
//   R06 用户缩窄的任选范围不被种子迁移恢复；用户显式修订永不被覆盖
//   R07 skuViewId 不再冒充 productViewSign（缺 sign 的条目丢弃而非伪造）
//   R09 行价守恒：条目行价合计 = 模型合计 = 展示总价（单价×份数不再用于重建总价）
//   R11 Top-K 预算只计新鲜解；空间穷尽不得谎报「搜索截断」
//   R12 跨进程写入的面板/CLI 数据立即可见（文件指纹刷新）
//   R13 落盘失败必须抛错（不得回「已保存」）
//   R14 同一商品不同城市的价格互不覆盖
//   R15 已过券有效期的记录不得标「可购买」
//   R16 业务错误码/缺 data 不得当成「查询成功但 0 条」
//   R17/R18/R19/R20 消费者页面：出餐指引与分账并列、复制按钮按 action 派发、
//                       换券草稿清空上一张券条件、删除失败不得提示「已删除」
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v147-'));
process.env.MCSMART_HOME = TEST_HOME;
process.env.MEITUAN_UNION_APPKEY = '';
process.env.MEITUAN_UNION_APPSECRET = '';
process.env.MCSMART_DISABLE_BUNDLED_UNION = '1'; // 强制无联盟凭据（离线降级路径）
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const { foodKeyOf, foodMultisetSignature } = await import('../dist/foodIdentity.js');
const { optimize, optimizeTopK } = await import('../dist/optimizer.js');
const {
  saveRecipe, importRecipes, loadRecipes, removeRecipe, reviseRecipe, _resetRecipeCache,
  RecipeConflictError, matchRecipeCandidates, PRESET_RECIPES,
} = await import('../dist/voucherRecipes.js');
const { isRecipeRevoked, loadRevocations } = await import('../dist/revocations.js');
const { normalizeRecipeInput, RecipeSchemaError } = await import('../dist/recipeSchema.js');
const { UserStoreError, writeJsonAtomic } = await import('../dist/userStore.js');
const { upsertDeals, dealsSnapshot, mergeDealVerification } = await import('../dist/catalog.js');
const { parseCouponItems, searchProducts } = await import('../dist/unionClient.js');
const { fetchUnionMcDeals } = await import('../dist/unionCps.js');
const { serviceSolveSingle } = await import('../dist/service.js');

let failures = 0;
let checks = 0;
const check = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? `（${detail}）` : ''}`); failures++; }
};
const catchSync = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const catchAsync = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const recipeOf = (id, name, sign) => ({
  id, name, matchNames: [name], resolve: 'explicit', channel: 'meituan', channelLabel: '美团团购（到店）',
  items: [{ mode: 'fixed', keyword: '麦香鸡', qty: 1 }],
  conditions: { orderType: 'instore' }, priceCents: 1000, originalPriceCents: 0,
  buyPath: '（平台页面）', redeemPath: '（券面说明）', evidence: '测试证据', verifiedAt: '2026-10-17',
  ruleVersion: 'test-v1', source: 'user', ...(sign ? { productViewSign: sign } : {}),
});
const emptyMenu = () => ({ items: [], unmatched: 0, comboCount: 0, comboUnmatched: 0, table: new Map() });
const opt = (code, name, kcal, diffCents = 0, extra = {}) => ({
  code, name, kcal, priceCents: 0, diffCents, staple: false, veggie: false,
  protein: 1, fat: 1, carbohydrate: 1, sodium: 1, ...extra,
});

// ========== R01：中文券名不得落到同一个配方 ID ==========
console.log('【R01】同 ID 不同商品不得静默覆盖');
{
  const a = catchSync(() => saveRecipe(recipeOf('rcp-shared-v1', '【双人食】小食4件自由拼', 'AAA_1')));
  check(!a, '第一条配方保存成功', a?.message ?? 'ok');
  const b = catchSync(() => saveRecipe(recipeOf('rcp-shared-v1', '【早餐】火腿扒堡两件套', 'BBB_1')));
  check(b instanceof RecipeConflictError && b.code === 'E_RECIPE_CONFLICT',
    '同 ID 不同商品 → E_RECIPE_CONFLICT', b?.code ?? 'no-error');
  check(/小食4件自由拼/.test(b?.message ?? ''), '冲突信息指明原占用方（便于用户改 ID）');
  const kept = loadRecipes().filter((r) => r.id === 'rcp-shared-v1');
  check(kept.length === 1 && kept[0].name === '【双人食】小食4件自由拼', '原配方未被覆盖', kept[0]?.name ?? '缺失');

  // 身份相同重复保存 = 更新（幂等），不得因为「重存」报冲突
  const again = catchSync(() => saveRecipe(recipeOf('rcp-shared-v1', '【双人食】小食4件自由拼', 'AAA_1')));
  check(!again, '身份相同的重复保存幂等', again?.message ?? 'ok');

  // 批量导入同口径：冲突计入 conflicts，不得静默替换
  const imp = importRecipes([recipeOf('rcp-shared-v1', '【早餐】火腿扒堡两件套', 'BBB_1')]);
  check(imp.conflicts.length === 1 && imp.imported === 0, '导入同 ID 不同商品 → 计入 conflicts 并跳过',
    `imported=${imp.imported} conflicts=${imp.conflicts.length}`);

  // 两张中文券各自有商品标识 → 各自独立保存（不再都落到 rcp--v1）
  saveRecipe(recipeOf('rcp-AAA_1-v1', '中文券甲', 'AAA_1'));
  saveRecipe(recipeOf('rcp-BBB_1-v1', '中文券乙', 'BBB_1'));
  const ids = loadRecipes().map((r) => r.id);
  check(ids.includes('rcp-AAA_1-v1') && ids.includes('rcp-BBB_1-v1'), '两张中文券各自留存（不互相覆盖）');
}

// ========== R02：同一食品不同分块/顺序/别名只占一个名额 ==========
console.log('【R02】食品身份签名与 Top-K 名额');
{
  const same = foodMultisetSignature([{ code: 'H1', name: '麦香鸡', qty: 1 }, { code: 'F1', name: '中薯条', qty: 1 }]);
  const reordered = foodMultisetSignature([{ code: 'F1', name: '中薯条', qty: 1 }, { code: 'H1', name: '麦香鸡', qty: 1 }]);
  const alias = foodMultisetSignature([{ code: 'H1', name: '麦香鸡（汉堡）', qty: 1 }, { code: 'F1', name: '薯条 中', qty: 1 }]);
  check(same === reordered, '槽位顺序不影响身份', same);
  check(same === alias, '同 code 别名归同一身份', alias);
  const withToy = foodMultisetSignature([{ code: 'H1', name: '麦香鸡', qty: 1 }, { code: 'F1', name: '中薯条', qty: 1 }, { code: 'T1', name: '玩具', qty: 1, nonFood: true }]);
  check(same === withToy, '非食品（玩具）不构成不同方案', withToy);

  // 两种「包装」卖同一份食品：套餐 vs 另一个套餐（价格不同、planId 不同）→ 只占一个名额
  const mk = (id, price) => ({
    id, channel: 'mcd-mcp', name: `包装${id}`, basePriceCents: price, maxQty: 1,
    slots: [
      { roundName: '主食', options: [opt('H1', '麦香鸡', 400)] },
      { roundName: '小食', options: [opt('F1', '中薯条', 300)] },
    ],
  });
  const res = await optimizeTopK({
    plans: [mk('P1', 2500), mk('P2', 2600)],
    members: [{ alias: '我', demands: [{ id: 'd1', keyword: '麦香鸡', qty: 1, must: true }, { id: 'd2', keyword: '中薯条', qty: 1, must: true }] }],
    mode: 'cheapest', totalBudgetCents: 3000,
  }, 3, {});
  check(res.length === 1, `同食品的两个包装只占一个名额（Top-K=${res.length}）`);
}

// ========== R03：同名不同规格不得合并 ==========
console.log('【R03】规格参与食品身份');
{
  const small = foodKeyOf({ name: '薯条', spec: '小份' });
  const large = foodKeyOf({ name: '薯条', spec: '大份' });
  const noSpec = foodKeyOf({ name: '薯条' });
  check(small !== large, '同名不同规格 → 两个身份', `${small} ≠ ${large}`);
  check(small !== noSpec, '有规格与无规格不混为一谈');
  // v1.4.8 R07 修订：规格**始终**参与身份（同 code 的小/大份是不同食品）。
  //   旧断言「有 code 时以 code 为准」导致小薯/大薯（同 code 4810，210/379 kcal）被去重吞掉。
  check(foodKeyOf({ code: 'X1', name: '薯条', spec: '小份' }) !== foodKeyOf({ code: 'X1', name: '薯条（小）', spec: '大份' }),
    '有 code 时规格仍参与身份（小/大份不合并）');
  check(foodKeyOf({ code: 'X1', name: '薯条', spec: '小份' }) === foodKeyOf({ code: 'X1', name: '薯条（小）', spec: '小份' }),
    '同 code 同规格的不同写法 = 同一身份');

  // 同一套餐里两个槽位都叫「薯条」，但规格不同 → 槽位聚合保留两条
  const plan = {
    id: 'mcd-SPEC', channel: 'mcd-mcp', name: '双薯套餐', basePriceCents: 1000, maxQty: 1,
    slots: [
      { roundName: '小食', options: [opt(undefined, '薯条', 200, 0, { specLabel: '小份' })] },
      { roundName: '小食', options: [opt(undefined, '薯条', 400, 0, { specLabel: '大份' })] },
    ],
  };
  // 规格限定选项只承接同规格心愿（v1.4.4 R07），所以两位成员分别点小份/大份
  const r = await optimize({
    plans: [plan],
    members: [{ alias: '甲', demands: [{ id: 'd1', keyword: '薯条', qty: 1, specLabel: '小份' }] },
      { alias: '乙', demands: [{ id: 'd2', keyword: '薯条', qty: 1, specLabel: '大份' }] }],
    mode: 'cheapest', totalBudgetCents: 5000,
  });
  const scs = r.assignments[0]?.slotChoices ?? [];
  check(scs.length === 2, `同名不同规格的槽位不合并（slotChoices=${scs.length}）`);
  check(r.totals.kcal === 600, `热量按实际份数合计 200+400=600（实际 ${r.totals.kcal}）`);
}

// ========== R04：CLI/HTTP 共用 schema，身份数组与补差往返保留 ==========
console.log('【R04】配方输入 schema 往返');
{
  const raw = {
    id: 'rcp-rt-v1', name: '往返券', resolve: 'explicit', channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{
      mode: 'choice', keyword: 'A区4选1', qty: 1, spec: 'A区',
      choiceRange: ['麦辣鸡翅', '麦乐鸡'], optionDiffs: { 麦乐鸡: 200, 麦辣鸡翅: 0 }, surcharge: '麦乐鸡+2元',
      fulfillCode: 'F1',
    }],
    conditions: { orderType: 'instore', noStack: true, perUserLimit: 2 },
    priceCents: 2780, originalPriceCents: 3980,
    buyPath: '美团 App', redeemPath: '到店核销', evidence: '截图实证', verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2',
    productViewSign: 'PVS_A', skuViewId: 'SKU_A',
    productViewSigns: ['PVS_A', 'PVS_B'], skuViewIds: ['SKU_A', 'SKU_B'],
    headUrl: 'https://p0.meituan.net/x.jpg',
  };
  const cli = normalizeRecipeInput(raw, { strict: false });
  check(JSON.stringify(cli.productViewSigns) === JSON.stringify(['PVS_A', 'PVS_B']), 'CLI 路径保留 productViewSigns');
  check(JSON.stringify(cli.skuViewIds) === JSON.stringify(['SKU_A', 'SKU_B']), 'CLI 路径保留 skuViewIds');
  check(cli.items[0].optionDiffs?.麦乐鸡 === 200, 'CLI 路径保留结构化补差 optionDiffs',
    JSON.stringify(cli.items[0].optionDiffs));
  check(cli.productViewSign === 'PVS_A' && cli.skuViewId === 'SKU_A', '两个身份字段分别取值（不互相填充）');

  const http = normalizeRecipeInput(raw, { strict: true });
  check(JSON.stringify(http.productViewSigns) === JSON.stringify(['PVS_A', 'PVS_B']), 'HTTP 路径与 CLI 同口径');

  // 未知字段明确报错（不得静默丢弃）
  const unknown = catchSync(() => normalizeRecipeInput({ ...raw, productViewSignz: ['X'] }, { strict: false }));
  check(unknown instanceof RecipeSchemaError, '未知字段 → E_INPUT_INVALID', unknown?.code ?? 'no-error');
  const badItem = catchSync(() => normalizeRecipeInput({ ...raw, items: [{ mode: 'fixed', keyword: 'x', qty: 1, colour: 'red' }] }, { strict: false }));
  check(badItem instanceof RecipeSchemaError, '条目未知字段同样报错');

  // 导入路径同样保留身份数组
  importRecipes([raw]);
  const imported = loadRecipes().find((r) => r.id === 'rcp-rt-v1');
  check(JSON.stringify(imported?.productViewSigns) === JSON.stringify(['PVS_A', 'PVS_B'])
    && imported?.items?.[0]?.optionDiffs?.麦乐鸡 === 200, '导入路径同样保留身份数组与补差');
}

// ========== R05：删除配方 = 撤销核验 ==========
console.log('【R05】删除配方后三条路径都不复活');
{
  saveRecipe(recipeOf('rcp-revoke-v1', '可撤销券', 'REV_1'));
  check(!isRecipeRevoked('rcp-revoke-v1'), '保存后未处于撤销状态');
  const removed = removeRecipe('rcp-revoke-v1');
  check(removed && isRecipeRevoked('rcp-revoke-v1'), '删除后写入撤销记录',
    JSON.stringify(loadRevocations().map((r) => r.recipeId)));
  check(!loadRecipes().some((r) => r.id === 'rcp-revoke-v1'), '撤销配方不再出现在配方库');
  check(!matchRecipeCandidates('可撤销券').some((r) => r.id === 'rcp-revoke-v1'), '撤销配方不再参与匹配');

  // ② 核验继承路径：再次核验失败不得沿用旧组成
  const old = {
    sign: 'REV_1', name: '可撤销券', priceCents: 1290, poiName: '麦当劳', admitted: true,
    firstSeen: '2026-10-17', lastSeen: '2026-10-17',
    contents: [{ mode: 'fixed', keyword: '麦香鸡', qty: 1 }, { mode: 'fixed', keyword: '中薯条', qty: 1 }],
    verify: {
      status: 'pattern-verified', verifiedAt: '2026-10-17', lastSuccessAt: '2026-10-17',
      recipeId: 'rcp-revoke-v1', ruleVersion: 'test-v1', source: 'recipe',
    },
  };
  const eff = mergeDealVerification(old, {
    name: '可撤销券', attempted: true,
    verify: { status: 'unverified', reasonCode: 'detail-unavailable', reason: '查询失败', verifiedAt: '2026-10-17' },
  });
  check(eff.admitted === false && eff.inherited === false, '撤销配方的核验不被继承（admitted=false）');

  // ③ 断网兜底：目录里的旧核验不得把该券当可解
  upsertDeals([{
    sign: 'REV_1', name: '可撤销券', priceCents: 1290, poiName: '麦当劳', admitted: true,
    verify: old.verify, contents: old.contents, verifyAttempted: false,
  }]);
  const offline = await fetchUnionMcDeals({}, 'S-REV', emptyMenu(), '测试门店');
  const revokedBuild = offline.builds.find((b) => b.voucher.id === 'union-REV_1');
  check(!!revokedBuild && revokedBuild.solvable === false, '断网兜底不把撤销券当可解',
    `solvable=${revokedBuild?.solvable}`);
  check(/撤销/.test(revokedBuild?.storeNote ?? ''), '断网兜底如实说明原因', revokedBuild?.storeNote?.slice(-40) ?? '');

  // 重新保存同 ID = 提供新证据 → 解除撤销
  saveRecipe(recipeOf('rcp-revoke-v1', '可撤销券', 'REV_1'));
  check(!isRecipeRevoked('rcp-revoke-v1'), '重新保存后撤销记录解除');
  check(loadRecipes().some((r) => r.id === 'rcp-revoke-v1'), '重新保存后配方恢复可用');
}

// ========== R06：用户缩窄的任选范围不被种子恢复 ==========
console.log('【R06】用户修订优先于种子迁移');
{
  const preset = PRESET_RECIPES.find((r) => r.id === 'rcp-fandazi-4');
  check(!!preset, '预置配方 rcp-fandazi-4 存在');
  const narrowed = {
    ...preset, source: 'user',
    items: preset.items.map((it) => (/B区/.test(it.keyword) ? { ...it, choiceRange: (it.choiceRange ?? []).slice(0, 3) } : it)),
  };
  const path = join(TEST_HOME, 'voucher-recipes.json');
  const current = JSON.parse(readFileSync(path, 'utf-8'));
  current.recipes = [...current.recipes.filter((r) => r.id !== 'rcp-fandazi-4'), narrowed];
  writeFileSync(path, JSON.stringify(current, null, 1), 'utf-8');
  _resetRecipeCache();
  const loaded = loadRecipes().find((r) => r.id === 'rcp-fandazi-4');
  const range = loaded?.items?.find((i) => /B区/.test(i.keyword))?.choiceRange ?? [];
  check(range.length === 3, `用户缩窄的 3 项被保留（实际 ${range.length}）`);

  // 用户显式修订后，即使条目与种子同源也不再迁移
  reviseRecipe('rcp-fandazi-4', { items: narrowed.items, evidence: preset.evidence });
  const after = loadRecipes().find((r) => r.id === 'rcp-fandazi-4');
  check(after?.seedMeta?.userEdited === true, 'reviseRecipe 写入 userEdited 标记', String(after?.seedMeta?.userEdited));
  check((after?.items?.find((i) => /B区/.test(i.keyword))?.choiceRange ?? []).length === 3,
    '显式修订后任选范围不被种子恢复');
}

// ========== R07：skuViewId 不再冒充 productViewSign ==========
console.log('【R07】缺 productViewSign 的条目不得伪造身份');
{
  const onlySku = parseCouponItems({
    data: [{ couponPackDetail: { name: '仅 SKU 券', sellPrice: '9.9', skuViewId: 'SKUONLY_A' }, brandInfo: { brandName: '麦当劳' } }],
  }, 10);
  check(onlySku.length === 0, `只有 skuViewId 的条目被丢弃（实际 ${onlySku.length} 条）`);
  const both = parseCouponItems({
    data: [{ couponPackDetail: { name: '双标识券', sellPrice: '9.9', productViewSign: 'PVS_A_B', skuViewId: 'SKU_A' }, brandInfo: { brandName: '麦当劳' } }],
  }, 10);
  check(both.length === 1 && both[0].productViewSign === 'PVS_A_B' && both[0].skuViewId === 'SKU_A',
    '两个标识分别保留', JSON.stringify({ pvs: both[0]?.productViewSign, sku: both[0]?.skuViewId }));
  check(both[0]?.productViewSign !== both[0]?.skuViewId, 'productViewSign 不等于 skuViewId（无伪造）');
}

// ========== R09：行价守恒 ==========
console.log('【R09】条目行价合计 = 模型合计 = 展示总价');
{
  // 隔离：清空本地团单库，确保本次只解官方套餐轨（避免券方案混入影响金额断言）
  writeFileSync(join(TEST_HOME, 'catalog.json'),
    JSON.stringify({ menus: {}, deals: {}, nutritionRows: [], updatedAt: '' }, null, 1), 'utf-8');
  const client = {
    async call(tool) {
      if (tool === 'query-meals') {
        return {
          data: {
            categories: [
              { name: '套餐', meals: [{ code: 'C9', tags: ['套餐'] }] },
              { name: '单品', meals: [{ code: 'A', tags: [] }, { code: 'B', tags: [] }] },
            ],
            meals: {
              C9: { name: '混合配置套餐', currentPrice: '10.00', originalPrice: '10.00' },
              A: { name: '甲堡', currentPrice: '20.00', originalPrice: '20.00' },
              B: { name: '乙堡', currentPrice: '20.00', originalPrice: '20.00' },
            },
          },
        };
      }
      if (tool === 'list-nutrition-foods') {
        return { rawText: '  甲堡,null,1674,400,20,20,50,600,0\n  乙堡,null,837,200,10,10,25,300,0' };
      }
      if (tool === 'query-meal-detail') {
        return {
          data: {
            rounds: [{
              id: 1, name: '主食',
              choices: [
                { code: 'A', name: '甲堡', isDefault: 1, diffPrice: '+¥0.00' },
                { code: 'B', name: '乙堡', isDefault: 0, diffPrice: '+¥0.01' },
              ],
            }],
          },
        };
      }
      if (tool === 'query-nearby-stores') return { data: [] };
      return { data: {} };
    },
  };
  // 目标 600 kcal → 一份 400（甲堡，补差 0）+ 一份 200（乙堡，补差 1 分）。
  // 这样套餐行价 = 2×1000 + 1 = 2001 分，除不尽 2：旧实现用 round(2001/2)=1001 乘 2 得 2002，多收 1 分。
  const out = await serviceSolveSingle(client, { storeCode: 'S-R09', kcal: 600, yuan: 50 }, {});
  check(out.feasible && out.solutions.length > 0, '有可行解', `feasible=${out.feasible}`);
  const sol = out.solutions[0];
  const it = sol.items[0];
  check(it.qty === 2, `套餐 2 份（qty=${it.qty}）`);
  const sum = sol.items.reduce((s, x) => s + x.subtotalCents, 0);
  check(sum === sol.metrics.price, `行价合计 = 模型合计（${sum} = ${sol.metrics.price}）`);
  check(sum === sol.finalPriceCents && sum === sol.menuPriceCents,
    `展示总价同源（final=${sol.finalPriceCents} menu=${sol.menuPriceCents}）`);
  check(it.price * it.qty !== it.subtotalCents,
    `单价×份数不能用于重建总价（${it.price}×${it.qty}=${it.price * it.qty} ≠ ${it.subtotalCents}）`);
  check(!(sol.reasonNotes ?? []).some((n) => /价格核对/.test(n)), '行价与模型一致时不出价格核对告警');
  // 营养同源：条目逐份热量合计 = metrics.kcal
  const unitKcal = (it.units ?? []).reduce((s, u) => s + u.kcal * u.qty, 0);
  check(unitKcal === sol.metrics.kcal, `逐份热量合计 = 方案热量（${unitKcal} = ${sol.metrics.kcal}）`);
}

// ========== R11：Top-K 预算只计新鲜解 + 截断标注诚实 ==========
console.log('【R11】搜索预算与截断标注');
{
  // ① 搜索空间穷尽 → 不得谎报「达到迭代预算」
  let truncated = 0;
  const single = {
    id: 'mcd-ONLY', channel: 'mcd-mcp', name: '唯一套餐', basePriceCents: 1000, maxQty: 1,
    slots: [{ roundName: '主食', options: [opt('A1', '甲堡', 300)] }],
  };
  const r1 = await optimizeTopK({
    plans: [single], members: [{ alias: '我', demands: [{ id: 'd1', keyword: '甲堡', qty: 1, must: true }] }],
    mode: 'cheapest', totalBudgetCents: 5000,
  }, 3, { onTruncated: () => { truncated++; } });
  check(r1.length > 0 && r1.length < 3, `组合数少于 K 时如实返回（${r1.length}）`);
  check(truncated === 0, '空间已穷尽 → 不标「搜索截断」', `onTruncated=${truncated}`);

  // ② 大量「同内容不同写法」：每个槽位 3 个别名选项（内容完全一致）→ 不得把 K 个名额耗在重复内容上
  const aliasOpts = [opt(undefined, '甲堡', 100), opt(undefined, '甲堡', 100), opt(undefined, '甲堡', 100)];
  const many = {
    id: 'mcd-MANY', channel: 'mcd-mcp', name: '八槽同内容套餐', basePriceCents: 100, maxQty: 1,
    slots: Array.from({ length: 8 }, (_, k) => ({ roundName: `第${k + 1}槽`, roundId: `r${k}`, options: aliasOpts })),
  };
  let trunc2 = null;
  const r2 = await optimizeTopK({
    plans: [many], members: [{ alias: '我', demands: [{ id: 'd1', keyword: '甲堡', qty: 1, must: true }] }],
    mode: 'cheapest', totalBudgetCents: 3000,
  }, 5, { onTruncated: (info) => { trunc2 = info; } });
  const contents = new Set(r2.map((r) => foodMultisetSignature(r.assignments.flatMap((a) => a.units.flatMap((u) => u.slotChoices.map((sc) => ({ code: sc.optionCode, name: sc.chosenName, spec: sc.specLabel, qty: sc.count, nonFood: sc.nonFood })))))));
  check(r2.length === contents.size, `同内容写法不占额外名额（Top-K=${r2.length}，不同内容=${contents.size}）`);
  check(!!trunc2 && trunc2.want === 5 && trunc2.got === r2.length, '预算耗尽且未凑满 K → 如实标注截断',
    JSON.stringify(trunc2));
  check(!!trunc2 && trunc2.totalIterations > trunc2.freshIterations, '重复内容不占新鲜名额（totalIter > freshIter）',
    trunc2 ? `total=${trunc2.totalIterations} fresh=${trunc2.freshIterations}` : 'no-trunc');
}

// ========== R12：跨进程可见 ==========
console.log('【R12】面板/CLI 跨进程数据可见');
{
  loadRecipes(); // 预热缓存
  const path = join(TEST_HOME, 'voucher-recipes.json');
  const file = JSON.parse(readFileSync(path, 'utf-8'));
  file.recipes.push(recipeOf('rcp-otherproc-v1', '子进程写入的券', 'OTHER_1'));
  writeFileSync(path, JSON.stringify(file, null, 1), 'utf-8'); // 模拟另一个进程（CLI/Agent）写入
  check(loadRecipes().some((r) => r.id === 'rcp-otherproc-v1'), '子进程写入的配方立即可见（文件指纹刷新）');

  dealsSnapshot(); // 预热缓存
  const catPath = join(TEST_HOME, 'catalog.json');
  const cat = existsSync(catPath) ? JSON.parse(readFileSync(catPath, 'utf-8')) : { menus: {}, deals: {}, nutritionRows: [], updatedAt: '' };
  cat.deals = { ...(cat.deals ?? {}), OTHERPROC_1: { sign: 'OTHERPROC_1', name: '子进程写入的团单', priceCents: 1500, poiName: '麦当劳', admitted: false, firstSeen: '2026-10-17', lastSeen: '2026-10-17' } };
  writeFileSync(catPath, JSON.stringify(cat, null, 1), 'utf-8');
  check(dealsSnapshot().some((d) => d.sign === 'OTHERPROC_1'), '子进程写入的团单立即可见');
}

// ========== R13：落盘失败必须抛错 ==========
console.log('【R13】落盘失败不得回「已保存」');
{
  const blocked = join(TEST_HOME, 'blocked.json');
  mkdirSync(`${blocked}.tmp`, { recursive: true }); // tmp 被目录占用 → 原子写失败
  const err = catchSync(() => writeJsonAtomic(blocked, { a: 1 }));
  check(err instanceof UserStoreError && err.code === 'E_STORAGE', 'writeJsonAtomic 失败抛 E_STORAGE', err?.code ?? 'no-error');
  rmdirSync(`${blocked}.tmp`);

  const recipePath = join(TEST_HOME, 'voucher-recipes.json');
  const before = readFileSync(recipePath, 'utf-8');
  mkdirSync(`${recipePath}.tmp`, { recursive: true });
  const saveErr = catchSync(() => saveRecipe(recipeOf('rcp-fail-v1', '落盘失败券', 'FAIL_1')));
  check(saveErr instanceof UserStoreError && saveErr.code === 'E_STORAGE', '保存配方落盘失败 → 抛 E_STORAGE（不回「已保存」）',
    saveErr?.code ?? 'no-error');
  rmdirSync(`${recipePath}.tmp`);
  check(readFileSync(recipePath, 'utf-8') === before, '失败时磁盘内容未被破坏（原子写）');
  _resetRecipeCache();
  check(!loadRecipes().some((r) => r.id === 'rcp-fail-v1'), '失败条目没有半写状态');
}

// ========== R14：逐城市价格互不覆盖 ==========
console.log('【R14】同商品跨城价格互不覆盖');
{
  upsertDeals([{ sign: 'CITYDEAL_1', name: '城市限定券', priceCents: 1000, poiName: '麦当劳', city: '上海', admitted: false, saleStatus: true }]);
  upsertDeals([{ sign: 'CITYDEAL_1', name: '城市限定券', priceCents: 1200, poiName: '麦当劳', city: '合肥', admitted: false, saleStatus: true }]);
  const sh = dealsSnapshot(undefined, '上海').find((d) => d.sign === 'CITYDEAL_1');
  const hf = dealsSnapshot(undefined, '合肥').find((d) => d.sign === 'CITYDEAL_1');
  check(sh?.priceCents === 1000, `上海价格保留 1000（实际 ${sh?.priceCents}）`);
  check(hf?.priceCents === 1200, `合肥价格保留 1200（实际 ${hf?.priceCents}）`);
}

// ========== R15：过期券不得标「可购买」 ==========
console.log('【R15】已过券有效期的记录不得标可购买');
{
  const past = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
  upsertDeals([{
    sign: 'EXPIRED_1', name: '已过期券', priceCents: 1500, poiName: '麦当劳', city: '合肥',
    admitted: true, saleStatus: true, validTimeType: 2, validETime: past, validSTime: past - 86400,
    contents: [{ mode: 'fixed', keyword: '麦香鸡', qty: 1 }, { mode: 'fixed', keyword: '中薯条', qty: 1 }],
  }]);
  upsertDeals([{
    sign: 'ONGOING_1', name: '在售券', priceCents: 1500, poiName: '麦当劳', city: '合肥',
    admitted: true, saleStatus: true,
    contents: [{ mode: 'fixed', keyword: '麦香鸡', qty: 1 }, { mode: 'fixed', keyword: '中薯条', qty: 1 }],
  }]);
  const offline = await fetchUnionMcDeals({}, 'S-R15', emptyMenu(), '测试门店', { city: '合肥' });
  const expired = offline.builds.find((b) => b.voucher.id === 'union-EXPIRED_1');
  const ongoing = offline.builds.find((b) => b.voucher.id === 'union-ONGOING_1');
  check(expired?.purchasable === false, `过期券 purchasable=false（实际 ${expired?.purchasable}）`);
  check(expired?.solvable === false, '过期券不可解');
  check(/不可购买/.test(expired?.storeNote ?? ''), '文案与状态一致（不再「不可购买」却标可购买）');
  check(ongoing?.purchasable === true, `在售券 purchasable=true（实际 ${ongoing?.purchasable}）`);
}

// ========== R16：业务错误码不得当成「0 条成功」 ==========
console.log('【R16】业务错误/结构异常按渠道失败处理');
{
  const cred = { appkey: 'k', appsecret: 's' };
  const bizErr = await catchAsync(() => searchProducts(cred, {
    keyword: '麦当劳', limit: 20,
    transport: async () => ({ status: 200, json: { code: 401, message: 'invalid sign', data: [] } }),
  }));
  check(!!bizErr && /业务错误/.test(bizErr.message), 'HTTP 200 + code=401 → 抛业务错误', bizErr?.message?.slice(0, 40) ?? 'no-error');

  const noData = await catchAsync(() => searchProducts(cred, {
    keyword: '麦当劳', limit: 20,
    transport: async () => ({ status: 200, json: { code: 0 } }),
  }));
  check(!!noData && /data/.test(noData.message), '成功码但缺 data 数组 → 抛结构异常', noData?.message?.slice(0, 30) ?? 'no-error');

  const ok = await searchProducts(cred, {
    keyword: '麦当劳', limit: 20,
    transport: async () => ({
      status: 200,
      json: { code: 0, data: [{ couponPackDetail: { name: '正常券', sellPrice: '12.9', productViewSign: 'PVS_OK_1' }, brandInfo: { brandName: '麦当劳' } }] },
    }),
  });
  check(ok.length === 1 && ok[0].productViewSign === 'PVS_OK_1', '正常响应仍能解析', `deals=${ok.length}`);
}

// ========== R17/R18/R19/R20：消费者页面 ==========
console.log('【R17—R20】页面契约');
{
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf-8');
  // R17：多人出餐指引按方案折叠，且与分账并列在同一张卡
  check(/data-view-btn="serve"/.test(html), 'R17 出餐指引为方案卡内的可切换视图');
  check(/data-view-btn="bill"/.test(html) && /data-view-btn="serve"/.test(html), 'R17 分账与出餐指引并列');
  check(!/renderServeCard|出餐指引<\/h3>[\s\S]{0,40}<\/div>\s*<div class="card"/.test(html), 'R17 不再有独立的出餐指引卡片');
  // R18：复制按钮按 action 派发
  for (const action of ['purchase', 'bill', 'voucher', 'notes']) {
    check(new RegExp(`data-action="${action}"`).test(html), `R18 复制按钮带 data-action="${action}"`);
  }
  check(!/data-copy=/.test(html), 'R18 不再使用 data-copy 取值');
  check(/\.copybtn'\)\.forEach/.test(html), 'R18 复制按钮统一按 class 绑定（动态渲染也生效）');
  // R19：换券草稿清空上一张券的条件
  const draft = html.slice(html.indexOf('function startRecipeFromDeal'), html.indexOf('function updateRecipeImage'));
  for (const field of ['recipeScope', 'recipeTerms', 'recipeBuyPath', 'recipeRedeemPath', 'recipeCombo', 'forceRecipeSave']) {
    check(new RegExp(`#${field}'?\\)?\\.(value|innerHTML|checked)\\s*=`).test(draft), `R19 草稿重置 ${field}`);
  }
  check(/RECIPE_DEFAULT_BUY/.test(draft) && /RECIPE_DEFAULT_REDEEM/.test(draft), 'R19 购买/核销路径回到默认值');
  // R20：删除结果看 HTTP 状态
  check(/if\(!r\.ok\) throw new Error/.test(html), 'R20 删除失败不再提示「已删除」');
  check(/d\.note/.test(html), 'R20 删除回执按服务端 note 展示（撤销核验的后果可见）');
  // R01 前端：有商品标识用稳定 ID，否则 slug+时间戳
  check(/productViewSign\|\|x\.skuViewId/.test(html), 'R01 草稿 ID 优先用商品标识');
  check(/Date\.now\(\)\.toString\(36\)/.test(html), 'R01 无商品标识时追加时间戳（两张中文券不撞 ID）');
}

console.log('');
if (failures > 0) { console.error(`v1.4.7 评审修复回归：${checks - failures}/${checks} 通过，${failures} 项失败`); process.exit(1); }
console.log(`v1.4.7 评审修复回归：全部通过（${checks} 项）`);
