// 第三轨 Omni-Voucher Track 单测（v1.3.1 对齐：券池=美团 1+1 白区修正版；
// 抖音历史价券已按用户拍板移除，先做好两个官方渠道）。运行：npm test（含 build）
// 测试隔离（v1.2）：目录写入只落临时用户目录。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-vt-test-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });
import { tieThresholdCents, decideTrackWinner, officialEquivalentCents, parseUserVoucher,
  solveVoucherTrack, PRESET_VOUCHERS } from '../dist/vouchers.js';
import { solveGroupOrder, solveBundleTrack } from '../dist/group.js';

let failures = 0;
const check = (cond, label) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures++; }
};

// ---------- 1) 动态阈值 ----------
console.log('【1】动态阈值 tieThresholdCents（3 元保底 / 3% 放大 / 8 元封顶）');
check(tieThresholdCents(6800) === 300, `¥68 单 → ¥3 保底（实际 ${(tieThresholdCents(6800)/100).toFixed(1)}）`);
check(tieThresholdCents(10000) === 300, `¥100 单 → 3%=¥3.0（实际 ${(tieThresholdCents(10000)/100).toFixed(1)}）`);
check(tieThresholdCents(30000) === 800, `¥300 单 → ¥8 封顶（实际 ${(tieThresholdCents(30000)/100).toFixed(1)}）`);
check(tieThresholdCents(20000) === 600, `¥200 单 → 3%=¥6（实际 ${(tieThresholdCents(20000)/100).toFixed(1)}）`);

// ---------- 2) 决策三分支 ----------
console.log('【2】decideTrackWinner 三分支');
const mkSol = (track, paid) => ({
  store: { storeCode: 'S1', storeName: '测试门店' }, track,
  members: [], orderNotes: [],
  totals: { originalCents: 10000, paidCents: paid, discountCents: 10000 - paid, priceSource: 'calculate-price', priceNote: '测试' },
  deliveryFeeCents: 0, warnings: [], disclaimer: '',
});
const t2 = mkSol('bundle', 5000);
const t3win = { ...mkSol('voucher', 3990), voucherBreakdown: null, decision: 'voucher' };
const t3tie = { ...mkSol('voucher', 4700), voucherBreakdown: null, decision: 'tie-official' };
const t3lose = { ...mkSol('voucher', 5300), voucherBreakdown: null, decision: 'official' };
check(decideTrackWinner(t2, t3win)?.winner === 'voucher', 'delta=¥10.1 > T → 极限省钱');
check(decideTrackWinner(t2, t3tie)?.winner === 'tie-official', 'delta=¥3.0 ≤ T → 极速省心');
check(decideTrackWinner(t2, t3lose)?.winner === 'official', 'delta=-¥3.0 → 官方避坑');
check(decideTrackWinner(t2, null) === null, '轨道 3 缺失 → null');
check(decideTrackWinner(null, t3win) === null, '轨道 2 缺失 → null');

// ---------- 3) 券级倒挂判定 ----------
console.log('【3】officialEquivalentCents（1+1 等效价优先）');
const wishOf = (item, spec) => ({ memberIdx: 0, alias: '测试', spec, hit: item, specRow: null, kcal: 0 });
const mkItem = (name, priceCents) => ({ code: name, name, priceCents, originalPriceCents: priceCents, category: '测试', tags: [], kcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0, isCombo: false, fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: false, deconstruction: undefined, stapleCount: undefined, veggieCount: undefined, assumedSpec: undefined });
const ban = mkItem('板烧鸡腿堡', 2850);
const tea = mkItem('锡兰红茶', 1150);
const spec = { raw: '板烧鸡腿堡', keyword: '板烧鸡腿堡', qty: 1 };
const spec2 = { raw: '锡兰红茶', keyword: '锡兰红茶', qty: 1 };
const sku = { code: 'C1', name: '人气经典随心配', priceCents: 1490,
  rounds: [
    { id: '1', name: '红区', choices: [{ code: 'ban', name: '板烧鸡腿堡', diffCents: 0 }, { code: 'M1', name: '巨无霸', diffCents: -100 }] },
    { id: '2', name: '白区', choices: [{ code: 'tea', name: '锡兰红茶', diffCents: 0 }, { code: 'M5', name: '可乐', diffCents: 0 }] },
  ] };
const voucher13 = { ...PRESET_VOUCHERS.find(v => v.id === 'kb-meituan-1plus1'), items: [{ mode: 'fixed', keyword: '板烧鸡腿堡', qty: 1 }, { mode: 'fixed', keyword: '锡兰红茶', qty: 1 }] };
const covered = [{ refIdx: 0, wish: wishOf(ban, spec) }, { refIdx: 1, wish: wishOf(tea, spec2) }];
const equiv = officialEquivalentCents(voucher13, covered, [sku]);
check(equiv === 1490, `1+1 等效价 = ¥14.9（实际 ${(equiv/100).toFixed(1)}）`);
check(!(voucher13.priceCents >= equiv), '券 ¥13.9 < 等效 ¥14.9 → 未倒挂');
check(officialEquivalentCents(voucher13, covered, []) === 4000, `无 SKU 兜底 = 菜单原价 ¥40.0（实际 ${(officialEquivalentCents(voucher13, covered, [])/100).toFixed(1)}）`);

// ---------- 4) 用户自持券解析 ----------
console.log('【4】parseUserVoucher');
const uv = parseUserVoucher({ channelLabel: '抖音', name: '双人券', priceYuan: 39.9, contentsText: '巨无霸+中薯条、可乐' });
check(uv.source === 'user' && uv.kind === 'combo', '来源 user、类型 combo');
check(uv.priceCents === 3990, `¥39.9 → 3990 分（实际 ${uv.priceCents}）`);
check(uv.items.length === 3 && uv.items[1].keyword === '中薯条', `品项拆分 3 项（实际 ${uv.items.length}）`);
const uvCash = parseUserVoucher({ channelLabel: '银行', name: '立减', priceYuan: 10, contentsText: '' });
check(uvCash.kind === 'cash' && uvCash.items.length === 0, '无品项 → cash 型');

// ---------- 5) solveVoucherTrack 端到端（mock MCP） ----------
console.log('【5】solveVoucherTrack 端到端（mock MCP，券池=美团 1+1 白区修正版）');
const MENU = {
  M1: { name: '巨无霸', currentPrice: '26.5' },
  M2: { name: '麦辣鸡腿堡', currentPrice: '13.5' },
  M3: { name: '薯条', currentPrice: '13.5' },
  M4: { name: '板烧鸡腿堡', currentPrice: '28.5' },
  M5: { name: '可乐', currentPrice: '10.5' },
  M6: { name: '锡兰红茶', currentPrice: '11.5' },
  M7: { name: '香芋派', currentPrice: '7.5' },
  C1: { name: '人气经典随心配', currentPrice: '14.9' },
};
const priceOf = {};
for (const [code, m] of Object.entries(MENU)) priceOf[code] = Math.round(parseFloat(m.currentPrice) * 100);
const mockClient = {
  async call(tool, params) {
    if (tool === 'query-meals') {
      return { data: {
        categories: [
          { name: '汉堡小食', meals: ['M1','M2','M3','M4','M5','M6','M7'].map(code => ({ code, tags: [] })) },
          { name: '随心配/1+1', meals: [{ code: 'C1', tags: ['随心配'] }] },
        ],
        meals: MENU,
      } };
    }
    if (tool === 'list-nutrition-foods') return { data: {}, rawText: '' };
    if (tool === 'query-meal-detail') {
      return { data: { rounds: sku.rounds.map(r => ({ id: Number(r.id), name: r.name,
        choices: r.choices.map(c => ({ code: c.code, name: c.name, diffPrice: c.diffCents === 0 ? '+0' : (c.diffCents > 0 ? `+${(c.diffCents/100).toFixed(1)}` : `-${Math.abs(c.diffCents/100).toFixed(1)}`) })) })) } };
    }
    if (tool === 'calculate-price') {
      const sum = (params.items ?? []).reduce((s, i) => {
        const p = priceOf[i.productCode];
        return p ? s + p * (i.quantity ?? 1) : s;
      }, 0);
      return { data: { price: sum > 0 ? sum : 0, discount: 0, productOriginalPrice: sum } };
    }
    throw new Error('mock 未实现的工具：' + tool);
  },
};
const STORE = { storeCode: 'S1', storeName: '测试门店' };
// 心愿设计：堡卷券（staple+side+drink）覆盖 板烧/辣/可乐 3 心愿；余项=可乐
const fullMembers = [
  { alias: '小李', wishes: ['板烧鸡腿堡', '可乐'], taboos: [], notes: [] },
  { alias: '张哥', wishes: ['麦辣鸡腿堡', '薯条'], taboos: [], notes: [] },
];
const menuFull = await (async () => {
  const { loadMenuItems } = await import('../dist/menu.js');
  return loadMenuItems(mockClient, 'S1', { includeUnmatched: true });
})();

const solFull = await solveVoucherTrack(mockClient, { ...STORE, members: fullMembers }, menuFull, { track2PaidCents: 5000 });
check(!!solFull, '输出轨道 3');
if (solFull) {
  check(solFull.track === 'voucher' && solFull.totals.priceSource === 'mixed', 'track=voucher、priceSource=mixed');
  const sel = solFull.voucherBreakdown.selected[0];
  check(sel.voucher.id === 'kb-meituan-snack3', `堡卷小食券胜出（实际 ${sel.voucher.id}）`);
  check(sel.coveredWishes.length === 3, `覆盖 3 心愿（实际 ${sel.coveredWishes.length}）`);
  check(solFull.totals.paidCents === 2310 + solFull.voucherBreakdown.residualPaidCents, '综合 = 券 + 余项');
  check(solFull.members.reduce((s, m) => s + m.payableCents, 0) === solFull.totals.paidCents, '分账守恒');
  check(solFull.decision === 'voucher', `delta > T → voucher（实际 ${solFull.decision}）`);
  // 联盟实时层依赖外部实时目录：降级→降级提示 / 命中可解券→命中提示 / 正常返回但无可解形态→静默，
  // 三种状态均合法（实时目录形态随时段变化），此处仅信息性输出，不作硬断言
  const degraded = solFull.warnings.some(w => w.includes('联盟实时查询本次不可用'));
  const hit = solFull.warnings.some(w => w.includes('联盟实时层命中'));
  console.log(`  ℹ 联盟实时层状态：${degraded ? '降级（接口不可用）' : hit ? '命中可解券' : '正常返回，当前实时目录无可解形态（仅展示券）'}`);
}
const solTie = await solveVoucherTrack(mockClient, { ...STORE, members: fullMembers }, menuFull, { track2PaidCents: solFull ? solFull.totals.paidCents + 300 : 9999 });
check(solTie?.decision === 'tie-official', `delta=T 边界 → tie-official（实际 ${solTie?.decision}）`);
const solSparse = await solveVoucherTrack(mockClient, { ...STORE, members: [{ alias: '小李', wishes: ['可乐'], taboos: [], notes: [] }] }, menuFull, {});
check(solSparse === null, '心愿无法承接券内全部品项（strict）→ null');
const solTips = await solveVoucherTrack(mockClient, { ...STORE, members: fullMembers }, menuFull, {});
check(!!solTips && solTips.voucherBreakdown.candidateTips.some(t => t.voucher.id === 'kb-meituan-duo-meal'), '未核验明细券进入候选提示');
const solGroup = await solveGroupOrder(mockClient, { ...STORE, members: fullMembers.slice(0, 1) });
check(!!solGroup && solGroup.track === 'a-la-carte', '轨道 1 在 mock 菜单上正常');
const solBundle = await solveBundleTrack(mockClient, { ...STORE, members: fullMembers.slice(0, 1) }, menuFull);
check(solBundle === null || solBundle.track === 'bundle', '轨道 2 在 mock 菜单上正常');

console.log(failures === 0 ? '\n✅ 第三轨单测全部通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
