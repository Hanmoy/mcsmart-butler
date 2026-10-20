// v1.4.10 评审修复回归（W01–W17 中的可离线验证部分）
// 覆盖：
//   W03 套餐需求允许官方合法换选（无糖可乐同轮同价可承接）
//   W05 规格心愿由同规格选项承接（大份薯条走套餐换选；不回落中份）
//   W02 规格单品用父 SKU + 真实补差 + roundList 履约（小/中/大 = 950/1000/1200）
//   W04 品类心愿（饮料）结构化承接，空手不得显示已满足
//   W06 食品身份 = 名称主体 + 规格 + 数量（不按路径 code 拆分/合并）
//   W08/W15/W16/W17 文本回执分流、原因区分、准确行价、推荐候选保留
//   W09 遗漏账以真实建池记录判定 inPlans
// 所有价格/菜单均为**构造夹具**，不声称现实在售或真实结算。
import { solveGroupWithKernel } from '../dist/groupKernel.js';
import { renderGroupText } from '../dist/present.js';
import { foodMultisetSignature, foodKeyOf } from '../dist/foodIdentity.js';
import { parseWishPhrase } from '../dist/group.js';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}${detail ? `（${detail}）` : ''}`); failures++; }
};

// ---------- 构造夹具（真实编码沿用报告，价格/营养为测试输入） ----------
const MENU = {
  '9900008751': { name: '可乐', currentPrice: '9.5' },
  '4810': { name: '薯条', currentPrice: '13.5' },
  '5462': { name: '板烧鸡腿堡三件套', currentPrice: '34.5' },
  '5466': { name: '巨无霸三件套', currentPrice: '37.5' },
  '888': { name: '巨无霸四件套', currentPrice: '32.0' },
};
const priceOf = {};
for (const [c, m] of Object.entries(MENU)) priceOf[c] = Math.round(parseFloat(m.currentPrice) * 100);
const SPEC_DIFF = { 3000: 0, 3050: 50, 3100: 250 };
const COMBO_DIFF = { 4820: 200 };
const ROUNDS = {
  '9900008751': [
    { id: 1, name: '规格', choices: [
      { code: '3000', name: '可乐小杯', isDefault: 1, diffPrice: '+0' },
      { code: '3050', name: '可乐中杯', isDefault: 0, diffPrice: '+0.5' },
      { code: '3100', name: '可乐大杯', isDefault: 0, diffPrice: '+2.5' },
    ] },
  ],
  '5462': [
    { id: 21, name: '主食轮', choices: [{ code: 'B1', name: '板烧鸡腿堡', isDefault: 1, diffPrice: '+0' }] },
    { id: 22, name: '小食轮', choices: [
      { code: '4810', name: '中薯条', isDefault: 1, diffPrice: '+0' },
      { code: '4820', name: '大薯条', isDefault: 0, diffPrice: '+2' },
    ] },
    { id: 23, name: '饮料轮', choices: [
      { code: '3050', name: '可乐中杯', isDefault: 1, diffPrice: '+0' },
      { code: '3071', name: '无糖可口可乐中杯', isDefault: 0, diffPrice: '+0' },
    ] },
  ],
  '5466': [
    { id: 31, name: '主食轮', choices: [{ code: 'B2', name: '巨无霸', isDefault: 1, diffPrice: '+0' }] },
    { id: 32, name: '小食轮', choices: [{ code: '4810', name: '中薯条', isDefault: 1, diffPrice: '+0' }] },
    { id: 33, name: '饮料轮', choices: [
      { code: '3050', name: '可乐中杯', isDefault: 1, diffPrice: '+0' },
      { code: '3071', name: '无糖可口可乐中杯', isDefault: 0, diffPrice: '+0' },
    ] },
  ],
  '888': [
    { id: 41, name: '主食轮', choices: [{ code: 'B2', name: '巨无霸', isDefault: 1, diffPrice: '+0' }] },
    { id: 42, name: '小食轮', choices: [{ code: '4810', name: '中薯条', isDefault: 1, diffPrice: '+0' }] },
    { id: 43, name: '饮料轮', choices: [{ code: '3050', name: '可乐中杯', isDefault: 1, diffPrice: '+0' }] },
    { id: 44, name: '甜品轮', choices: [{ code: 'P1', name: '香芋派', isDefault: 1, diffPrice: '+0' }] },
  ],
};
const NUTRITION = [
  ['可乐', 616, 147, 0, 0, 37, 15],
  ['可乐大杯', 940, 224, 0, 0, 58, 20],
  ['可乐小杯', 420, 100, 0, 0, 25, 10],
  ['薯条', 1214, 289, 4, 15, 34, 210],
  ['大薯条', 1590, 379, 5, 19, 45, 300],
  ['板烧鸡腿堡', 1683, 402, 27, 18, 37, 790],
  ['巨无霸', 2146, 513, 27, 26, 42, 961],
  ['香芋派', 970, 232, 2, 11, 31, 150],
];
const client = {
  async call(tool, params) {
    if (tool === 'query-meals') {
      return { data: {
        categories: [
          { name: '汉堡小食', meals: ['9900008751', '4810'].map((code) => ({ code, tags: [] })) },
          { name: '精选套餐', meals: ['5462', '5466', '888'].map((code) => ({ code, tags: ['套餐'] })) },
        ],
        meals: MENU,
      } };
    }
    if (tool === 'list-nutrition-foods') {
      const row = (n, kj, kcal, p, f, c, na) => `  ${n},null,${kj},${kcal},${p},${f},${c},${na},0`;
      return { data: {}, rawText: NUTRITION.map((r) => row(...r)).join('\n') };
    }
    if (tool === 'query-meal-detail') {
      const rounds = ROUNDS[params.code];
      if (!rounds) throw new Error('夹具无该商品详情：' + params.code);
      return { data: { rounds } };
    }
    if (tool === 'calculate-price') {
      const sum = (params.items ?? []).reduce((s, i) => {
        let diff = 0;
        for (const rl of i.roundList ?? []) {
          for (const c of rl.comboItemList) {
            diff += (i.productCode === '9900008751' ? (SPEC_DIFF[c.code] ?? 0) : (COMBO_DIFF[c.code] ?? 0));
          }
        }
        return s + ((priceOf[i.productCode] ?? 0) + diff) * (i.quantity ?? 1);
      }, 0);
      return { data: { price: sum, discount: 0, productOriginalPrice: sum } };
    }
    throw new Error('夹具未实现工具：' + tool);
  },
};
const STORE = { storeCode: 'S1410', storeName: '夹具门店' };

// ---------- W03 套餐需求允许官方合法换选 ----------
console.log('【W03】无糖成员：套餐饮料轮改用同轮零差价无糖选项，覆盖不塌陷');
{
  const k = await solveGroupWithKernel(client, { ...STORE, members: [
    { alias: '甲', wishes: ['板烧鸡腿堡三件套'], taboos: [], sugarFree: true },
    { alias: '乙', wishes: ['巨无霸三件套'], taboos: [], sugarFree: true },
  ] });
  const sol = k.bundle ?? k.solution;
  check(sol.coverage.met === 2, `两人套餐心愿均满足（${sol.coverage.met}/${sol.coverage.total}）`);
  const drinkCodes = sol.basket.flatMap((b) => (b.foods ?? []).filter((f) => /可乐/.test(f.name)).map((f) => f.code));
  check(drinkCodes.includes('3071'), `饮料轮选择无糖 3071（${drinkCodes.join(',') || '无'}）`);
  check(!drinkCodes.includes('3050'), '含糖 3050 未被分配给无糖成员');
  check(sol.totals.paidCents === 7200, `模型合计 7200 分（实际 ${sol.totals.paidCents}）`);
}

// ---------- W05 规格心愿由同规格选项承接 ----------
console.log('【W05】大份薯条：套餐合法换选可承接；没有大份时不得用中份冒充');
{
  const k = await solveGroupWithKernel(client, { ...STORE, members: [
    { alias: '甲', wishes: ['板烧鸡腿堡'], taboos: [] },
    { alias: '乙', wishes: ['大份薯条'], taboos: [] },
  ] });
  const sol = k.bundle ?? k.solution;
  check(sol.coverage.met === 2, `板烧 + 大份薯条覆盖 2/2（实际 ${sol.coverage.met}/${sol.coverage.total}）`);
  const combo = sol.basket.find((b) => b.code === '5462');
  const bigFries = (combo?.foods ?? []).find((f) => f.code === '4820');
  check(!!bigFries, `购买清单使用大薯条 4820（${combo?.perUnitConfig?.join(' / ') ?? '未购买套餐'}）`);
  check(sol.totals.paidCents === 3650, `套餐换大薯 +200 = 3650 分（实际 ${sol.totals.paidCents}）`);
}

// ---------- W02 规格单品真实补差 + 履约编码 ----------
console.log('【W02】大可乐：父 SKU 9900008751 + 规格轮次 3100，模型价 1200 分');
{
  const k = await solveGroupWithKernel(client, { ...STORE, members: [{ alias: '甲', wishes: ['大可乐'], taboos: [] }] });
  const sol = k.bundle ?? k.solution;
  const row = sol.basket.find((b) => /可乐/.test(b.name));
  check(!!row && row.code === '9900008751', `购买行使用父 SKU（${row?.code ?? '无'}）`);
  check(!sol.basket.some((b) => /^spec-|mcd-spec/.test(b.code)), '购买清单不含内部规格计划 ID');
  const rl = row?.roundList ?? [];
  const optCode = rl[0]?.comboItemList?.[0]?.code;
  check(rl.length === 1 && rl[0].round === '1' && optCode === '3100', `roundList = 轮次1/选项3100（${JSON.stringify(rl)}）`);
  check(sol.totals.paidCents === 1200, `大杯实付 1200 分（实际 ${sol.totals.paidCents}）`);
  const mid = await solveGroupWithKernel(client, { ...STORE, members: [{ alias: '甲', wishes: ['中杯可乐'], taboos: [] }] });
  check((mid.bundle ?? mid.solution).totals.paidCents === 1000, `中杯 1000 分（实际 ${(mid.bundle ?? mid.solution).totals.paidCents}）`);
}

// ---------- W04 品类心愿 ----------
console.log('【W04】「饮料」类目心愿：必须实际拿到饮料才算满足');
{
  const k = await solveGroupWithKernel(client, { ...STORE, members: [
    { alias: '甲', wishes: ['板烧鸡腿堡'], taboos: [] },
    { alias: '乙', wishes: ['饮料'], taboos: [] },
  ] });
  const sol = k.bundle ?? k.solution;
  const yi = sol.members.find((m) => m.alias === '乙');
  check(sol.coverage.met === 2, `饮料由实际食品承接（${sol.coverage.met}/${sol.coverage.total}）`);
  check(!!yi?.items.some((i) => /可乐|红茶|雪碧/.test(i.name)), `乙实际得到饮料（${yi?.items.map((i) => i.name).join('、') || '空手'}）`);
  const big = await solveGroupWithKernel(client, { ...STORE, members: [{ alias: '丙', wishes: ['大杯饮料'], taboos: [] }] });
  const bigSol = big.bundle ?? big.solution;
  const drink = bigSol.basket.flatMap((b) => (b.foods ?? []));
  // 本夹具没有大杯饮料候选：必须如实记为缺口，不得用中杯冒充
  check(bigSol.coverage.met === 0 && !drink.some((f) => f.spec === '中'),
    `大杯饮料无候选时如实缺口（${bigSol.coverage.met}/${bigSol.coverage.total}，${drink.map((f) => f.name).join('、') || '无'}）`);
}

// ---------- W06 食品身份 ----------
console.log('【W06】身份签名：名称主体 + 规格 + 数量，购买 code 不参与');
{
  const a = foodMultisetSignature([{ code: '4820', name: '大薯条', qty: 1 }]);
  const b = foodMultisetSignature([{ code: '4810', name: '大薯条', qty: 1 }]);
  check(a === b, `同食品不同路径 code 归同一身份（${a}）`);
  const small = foodMultisetSignature([{ code: '4810', name: '小薯条', qty: 1 }]);
  check(small !== a, `小薯与大薯保持两个身份（${small} vs ${a}）`);
  check(foodKeyOf({ code: 'X1', name: '麦香鸡（汉堡）' }) === foodKeyOf({ code: 'X2', name: '麦香鸡汉堡' }),
    '别名/括号写法归同一身份');
  const two = foodMultisetSignature([{ code: '4820', name: '大薯条', qty: 2 }]);
  check(two !== a, '数量差异构成不同购物篮');
}

// ---------- W08/W15/W16/W17 文本出口 ----------
console.log('【W08/W15/W16/W17】文本回执分流、原因区分、准确行价、推荐保留');
{
  const base = {
    store: { storeCode: 'S', storeName: 'S' }, members: [], orderNotes: [], warnings: [], disclaimer: '',
    coverage: { total: 1, met: 1 }, solveState: 'proven-optimal', kernel: 'milp-v6', gapTotal: 0, alternatives: [], basket: [],
  };
  const receipt = renderGroupText({
    solution: { ...base, track: 'bundle', solveState: 'infeasible', trackNote: '官方菜单不可用 · 需求回执（非配餐方案）',
      members: [{ alias: '甲', items: [], unresolvedWishes: ['板烧套餐'], originalCents: 0, shareCents: 0, payableCents: 0, savedCents: 0, kcal: 0, tabooFiltered: [] }],
      totals: { originalCents: 0, paidCents: 0, discountCents: 0, priceSource: 'menu-price', priceNote: '' } },
    bundle: null, voucherTrack: null, decision: null, unified: [], recommendedIndex: 0,
    menuUnavailable: { reason: '门店菜单暂不可用' },
  });
  check(!/实付 ¥|← 推荐|应转/.test(receipt), '菜单不可用回执不含实付/推荐/应转');
  check(/未产生购买方案/.test(receipt) && /板烧套餐/.test(receipt), '回执保留原因与成员需求');

  const mk = (paid, idx) => ({
    ...base, track: 'bundle', basket: [{ kind: 'single', code: 'X', name: '测试', qty: 1, refPriceCents: paid, perUnitConfig: [], channelLabel: '官方 App' }],
    members: [{ alias: '甲', items: [], unresolvedWishes: ['巨无霸套餐（至少1 份，当前方案未能满足）'], originalCents: paid, shareCents: paid, payableCents: paid, savedCents: 0, kcal: 0, tabooFiltered: [] }],
    totals: { originalCents: paid, paidCents: paid, discountCents: 0, priceSource: 'calculate-price', priceNote: '' },
  });
  const sols = [mk(1000), mk(1100), mk(1200), mk(1300)];
  const out = { solution: sols[0], bundle: sols[0], voucherTrack: null, decision: null, unified: sols, recommendedIndex: 3 };
  const text = renderGroupText(out);
  const recLine = text.split('\n').find((l) => l.includes('← 推荐')) ?? '';
  check(/方案 3\/3/.test(recLine) || /方案 4\//.test(recLine), `推荐候选保留在展示区（${recLine.slice(0, 30)}）`);
  check(!/未匹配到菜单：.*当前方案未能满足/.test(text), '本方案未满足不再写成未匹配到菜单');
  check(/本方案未满足/.test(text), '已匹配但本方案未满足有独立表述');
}

// ---------- W09 遗漏账 ----------
console.log('【W09】遗漏账：已建池但未选中的套餐 inPlans=true');
{
  const k = await solveGroupWithKernel(client, { ...STORE, members: [{ alias: '甲', wishes: ['巨无霸三件套'], taboos: [] }] });
  const row888 = (k.menuAudit ?? []).find((r) => r.code === '888');
  check(!!row888 && row888.inPlans === true, `四件套 inPlans=true（${row888?.inPlans}）`);
  check(!!row888 && row888.selected === false, '四件套 selected=false（本轮未选中）');
  const sol = k.bundle ?? k.solution;
  check(sol.basket.some((b) => b.code === '5466'), '明确三件套时选中三件套（不因四件套更便宜而替换）');
}

console.log(failures === 0 ? '\nv1.4.10 评审修复回归：全部通过' : `\n${failures} 项未通过 ✗`);
process.exit(failures === 0 ? 0 : 1);
