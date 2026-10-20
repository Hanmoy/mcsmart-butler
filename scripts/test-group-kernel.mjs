// v5 拼单内核集成验收（docs/GROUP_KERNEL_MILP_DESIGN.md v1.1 §六 B 组）
// 端到端：心愿解析 → 三轨嵌套池 → MILP → 核价 → GroupSolution 契约/分账 → 决策。
// 运行：npm test 或 npm run build && node scripts/test-group-kernel.mjs
// 测试隔离（v1.2）：mock 门店的菜单 upsert 只落临时用户目录，绝不污染开发种子/真实用户数据。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-kernel-test-'));
process.env.MCSMART_HOME = TEST_HOME; // getLayout 懒解析，首次目录访问前生效
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });
import { solveGroupWithKernel } from '../dist/groupKernel.js';
import { parseGroupText } from '../dist/group.js';
import { parseUserVoucher } from '../dist/vouchers.js';

let failures = 0;
const check = (cond, label) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures++; }
};

// ---------- mock MCP（与 test-voucher-track 同模式；C2 四件套用于套餐意图与 roundList 贯通） ----------
const MENU = {
  M1: { name: '巨无霸', currentPrice: '26.5' },
  M2: { name: '麦辣鸡腿堡', currentPrice: '13.5' },
  M3: { name: '薯条', currentPrice: '13.5' },
  M4: { name: '板烧鸡腿堡', currentPrice: '28.5' },
  M5: { name: '可乐', currentPrice: '10.5' },
  M6: { name: '锡兰红茶', currentPrice: '11.5' },
  M7: { name: '香芋派', currentPrice: '7.5' },
  C1: { name: '人气经典随心配', currentPrice: '14.9' },
  C2: { name: '巨无霸四件套', currentPrice: '42.0' },
};
const priceOf = {};
for (const [code, m] of Object.entries(MENU)) priceOf[code] = Math.round(parseFloat(m.currentPrice) * 100);
const ROUNDS = {
  C1: [
    { id: 1, name: '红区主食', choices: [
      { code: 'M1', name: '巨无霸', isDefault: 1, diffPrice: '+0' },
      { code: 'M4', name: '板烧鸡腿堡', isDefault: 0, diffPrice: '+0' },
    ] },
    { id: 2, name: '白区任选', choices: [
      { code: 'M6', name: '锡兰红茶', isDefault: 1, diffPrice: '+0' },
      { code: 'M5', name: '可乐', isDefault: 0, diffPrice: '+0' },
      { code: 'M7', name: '香芋派', isDefault: 0, diffPrice: '+0' },
    ] },
  ],
  C2: [
    { id: 11, name: '主食轮', choices: [{ code: 'M1', name: '巨无霸', isDefault: 1, diffPrice: '+0' }] },
    { id: 12, name: '小食轮', choices: [{ code: 'M3', name: '薯条', isDefault: 1, diffPrice: '+0' }] },
    { id: 13, name: '饮料轮', choices: [{ code: 'M5', name: '可乐', isDefault: 1, diffPrice: '+0' }] },
  ],
};
const mockClient = {
  async call(tool, params) {
    if (tool === 'query-meals') {
      return { data: {
        categories: [
          { name: '汉堡小食', meals: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'].map((code) => ({ code, tags: [] })) },
          { name: '随心配/1+1', meals: [{ code: 'C1', tags: ['随心配'] }] },
          { name: '精选套餐', meals: [{ code: 'C2', tags: ['套餐'] }] },
        ],
        meals: MENU,
      } };
    }
    if (tool === 'list-nutrition-foods') {
      // 真实格式自描述表格行（parseNutritionTable 契约）：名称,null,kJ,kcal,蛋白,脂肪,碳水,钠,钙
      const row = (n, kj, kcal, p, f, c, na) => `  ${n},null,${kj},${kcal},${p},${f},${c},${na},0`;
      return { data: {}, rawText: [
        row('巨无霸', 2146, 513, 27, 26, 42, 961),
        row('麦辣鸡腿堡', 1884, 450, 22, 24, 40, 890),
        row('薯条', 1214, 289, 4, 15, 34, 210),
        row('板烧鸡腿堡', 1683, 402, 27, 18, 37, 790),
        row('可乐', 616, 147, 0, 0, 37, 15),
        row('锡兰红茶', 418, 100, 0, 0, 25, 10),
        row('香芋派', 970, 232, 2, 11, 31, 150),
      ].join('\n') };
    }
    if (tool === 'query-meal-detail') {
      const rounds = ROUNDS[params.code];
      if (!rounds) throw new Error('mock 无该套餐详情：' + params.code);
      return { data: { rounds } };
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

// ---------- B1 三轨嵌套池 + 套餐意图 + 分账守恒 ----------
console.log('【B1】嵌套池覆盖单调；套餐名心愿按槽位默认项承接；分账守恒');
{
  const members = [
    { alias: '小明', wishes: ['一份巨无霸四件套'], taboos: [] },
    { alias: '小红', wishes: ['可乐'], taboos: [] },
  ];
  const k = await solveGroupWithKernel(mockClient, { ...STORE, members });
  check(k.solution.kernel === 'milp-v6' && Array.isArray(k.solution.basket), '内核标识与整单购买清单透出');
  check(k.solution.coverage.met < k.solution.coverage.total,
    `轨 1（单品池）覆盖 ${k.solution.coverage.met}/${k.solution.coverage.total}（套餐心愿无候选，不静默）`);
  check(k.bundle.coverage.met === 2, `轨 2（单点+套餐）覆盖 2/2（嵌套池覆盖单调）`);
  const c2 = k.bundle.basket.find((b) => b.code === 'C2');
  check(!!c2 && c2.qty === 1, '轨 2 购买巨无霸四件套 ×1');
  check((c2?.perUnitConfig?.[0] ?? '').includes('巨无霸') && (c2?.perUnitConfig?.[0] ?? '').includes('薯条'),
    `每份配置摘要贯通（${c2?.perUnitConfig?.[0]}）`);
  const xiaoming = k.bundle.members.find((m) => m.alias === '小明');
  check(!!xiaoming?.items.some((i) => i.name === '巨无霸') && !!xiaoming?.items.some((i) => i.name === '薯条') && !!xiaoming?.items.some((i) => i.name === '可乐'),
    '套餐意图按各槽位默认项分配给小明（主食+小食+饮料三槽全承接，子项级不重复列整包）');
  check(xiaoming?.items.every((i) => i.fromPlan === '巨无霸四件套'), '子项带 fromPlan 来源标注');
  const xiaohong = k.bundle.members.find((m) => m.alias === '小红');
  check(!!xiaohong?.items.some((i) => i.name === '可乐' && !i.fromPlan), '小红可乐由单品承接（C2 饮料轮已被套餐意图占用）');
  check(k.bundle.totals.paidCents === 5250, `轨 2 实付 ¥52.5（C2 ¥42 + 单品可乐 ¥10.5；实际 ¥${(k.bundle.totals.paidCents / 100).toFixed(1)}）`);
  const sumShare = k.bundle.members.reduce((s, m) => s + m.shareCents, 0);
  check(sumShare === k.bundle.totals.paidCents, `分账守恒 Σshare=paid（${sumShare}=${k.bundle.totals.paidCents}）`);
  check(k.bundle.members.reduce((s, m) => s + m.payableCents, 0) === k.bundle.totals.paidCents, 'Σ应付=实付（无个人券）');
  check(Array.isArray(k.bundle.alternatives) && k.bundle.alternatives.length >= 1,
    `同轨 Top-K 备选完整方案输出（${k.bundle.alternatives.length} 个，渠道轨 ≠ 方案）`);
  check(k.bundle.alternatives.every((a) => a.kernel === 'milp-v6' && Array.isArray(a.basket)), '备选同为完整内核方案（含购买清单）');
}

// ---------- B2 用户券联合最优 + 严格承接 ----------
console.log('【B2】用户自持券：联合最优胜出（¥9.9 < 官方随心配 ¥14.9），券品项严格承接');
{
  const members = [
    { alias: '甲', wishes: ['板烧鸡腿堡'], taboos: [] },
    { alias: '乙', wishes: ['锡兰红茶'], taboos: [] },
  ];
  const uv = parseUserVoucher({ channelLabel: '抖音', name: '双人超值券', priceYuan: 9.9, contentsText: '板烧鸡腿堡+锡兰红茶' });
  const k = await solveGroupWithKernel(mockClient, { ...STORE, members, userVouchers: [uv] });
  check(!!k.voucherTrack, '轨道 3 输出（券被购买）');
  const vt = k.voucherTrack;
  check(vt.totals.paidCents === 990, `券轨 ¥9.9（实际 ¥${(vt.totals.paidCents / 100).toFixed(1)}）`);
  check(k.decision?.winner === 'voucher', `决策=极限省钱（实际 ${k.decision?.winner}，delta ¥${((k.decision?.deltaCents ?? 0) / 100).toFixed(1)}）`);
  const sel = vt.voucherBreakdown.selected[0];
  check(sel.coveredWishes.length === 2, `券严格承接 2 心愿（实际 ${sel.coveredWishes.length}）`);
  check(vt.members.some((m) => m.items.some((i) => i.viaVoucherId)), '券品项带 viaVoucherId（前端券品分组依据）');
  check(vt.voucherBreakdown.residualPaidCents === 0, '券全承接无余项');
  check(vt.members.reduce((s, m) => s + m.payableCents, 0) === vt.totals.paidCents, '券轨分账守恒');
}

// ---------- B3 倒挂避坑（v1.2：未购入的倒挂券同样亮红灯） ----------
console.log('【B3】倒挂券（¥45 > 官方等效 ¥40）：内核不买，避坑红灯保留');
{
  // 双主食心愿：预置 1+1 券（红区+白区）在 v1.2 可购买（白区品项作为额外食品分配，不虚增覆盖），
  // 倒挂用户券（¥45）比散点（¥40）与预置券都贵 → 不被购买，但避坑红灯必须仍然点亮
  const members = [
    { alias: '甲', wishes: ['巨无霸'], taboos: [] },
    { alias: '乙', wishes: ['麦辣鸡腿堡'], taboos: [] },
  ];
  const uv = parseUserVoucher({ channelLabel: '抖音', name: '双堡券', priceYuan: 45.0, contentsText: '巨无霸+麦辣鸡腿堡' });
  const k = await solveGroupWithKernel(mockClient, { ...STORE, members, userVouchers: [uv] });
  check(!!k.voucherTrack, '券轨输出（v1.2：预置 1+1 券以额外食品分配入解）');
  check(!k.voucherTrack.basket.some((b) => b.name === '双堡券'), '¥45 倒挂券未被购买');
  check((k.voucherTrack.warnings ?? []).some((w) => w.includes('切勿购买') && w.includes('双堡券')),
    '未购入的倒挂券同样亮红灯（避坑文案存在）');
  const sel = k.voucherTrack?.voucherBreakdown.selected[0];
  check(sel != null && sel.inverted == null, '实际购入的券无倒挂（等效价口径）');
  check(k.decision?.winner === 'official' || k.decision?.winner === 'tie-official',
    `决策=官方侧（实际 ${k.decision?.winner}）`);
  check(k.bundle.totals.paidCents <= k.voucherTrack.totals.paidCents || k.decision?.winner === 'tie-official',
    `官方侧 ¥${(k.bundle.totals.paidCents / 100).toFixed(1)} 与券轨 ¥${(k.voucherTrack.totals.paidCents / 100).toFixed(1)} 决策一致`);
}

  // ---------- B4 宜多分配（无人认领子项分给成员，不进剩余） ----------
console.log('【B4】宜多不宜少：无人认领的套餐饮料作为额外食物分给成员');
{
  const members = [{ alias: '小明', wishes: ['一份巨无霸四件套'], taboos: [] }];
  const k = await solveGroupWithKernel(mockClient, { ...STORE, members });
  const sol = k.bundle ?? k.solution;
  check(sol.basket.some((b) => b.code === 'C2'), '四件套被购买');
  check(sol.members[0].items.some((i) => i.name === '可乐'), '饮料分给小明（宜多，超额部分如实计入所得）');
  check(!sol.warnings.some((w) => w.includes('剩余')), '无剩余（宜多分配后无 leftover）');
  check(sol.members.reduce((s, m) => s + m.shareCents, 0) === sol.totals.paidCents, '分账守恒');
}

// ---------- B5 粘贴文本端到端 ----------
console.log('【B5】群聊粘贴 → 解析 → 内核求解全链路');
{
  const parsed = parseGroupText('小明：巨无霸四件套一份\n小红：可乐');
  check(parsed.needsConfirm && parsed.members.length === 2, `解析 2 成员（实际 ${parsed.members.length}）`);
  const k = await solveGroupWithKernel(mockClient, { ...STORE, members: parsed.members });
  check(k.bundle.coverage.met === 2, `全链路覆盖 2/2（实际 ${k.bundle.coverage.met}/${k.bundle.coverage.total}）`);
  check(k.bundle.members[0].alias === '小明' && k.bundle.members[1].alias === '小红', '成员别名保留');
}

// ---------- B6 剩余成本全体均摊（评审二轮 #8：等额食品不再分成 10/20） ----------
console.log('【B6】剩余成本均摊：份额 = 原价等比 + 剩余/N（尾差仅分级差）');
{
  // 双成员禁忌全部白区品项 → C1 白区必然进剩余；验证份额公式
  const members = [
    { alias: '甲', wishes: ['板烧鸡腿堡'], taboos: ['可乐', '红茶', '派'] },
    { alias: '乙', wishes: ['麦辣鸡腿堡'], taboos: ['可乐', '红茶', '派'] },
  ];
  const k = await solveGroupWithKernel(mockClient, { ...STORE, members });
  const sol = k.bundle ?? k.solution;
  const paid = sol.totals.paidCents;
  const totalOrig = sol.members.reduce((s, m) => s + m.originalCents, 0);
  const loCents = (sol.leftovers ?? []).reduce((s, l) => s + l.refPriceCents, 0);
  check(loCents > 0, `白区饮品无人能接 → 进剩余（参考价 ¥${(loCents / 100).toFixed(1)}）`);
  const base = totalOrig + loCents;
  const leftoverCost = base > 0 ? (paid * loCents) / base : 0;
  for (const m of sol.members) {
    const expect = Math.round((m.originalCents / base) * paid + leftoverCost / sol.members.length);
    check(Math.abs(m.shareCents - expect) <= 1,
      `@${m.alias} 份额 ${m.shareCents} ≈ 均摊期望 ${expect}（旧内核把剩余全甩给末位成员）`);
  }
  check(sol.members.reduce((s, m) => s + m.shareCents, 0) === paid, '守恒 Σshare=paid');
}

// ---------- B7 核价权威（评审二轮 #7：核价高于模型价时如实展示核价） ----------
console.log('【B7】核价权威：quote ×2 → 按核价呈现 + 差额警示');
{
  const qClient = {
    ...mockClient,
    async call(tool, params) {
      const r = await mockClient.call(tool, params);
      if (tool === 'calculate-price' && r?.data?.price > 0) return { ...r, data: { ...r.data, price: Math.round(r.data.price * 2) } };
      return r;
    },
  };
  const members = [{ alias: '甲', wishes: ['板烧鸡腿堡'], taboos: [] }];
  const k = await solveGroupWithKernel(qClient, { ...STORE, members });
  const sol = k.bundle ?? k.solution;
  check(sol.totals.priceSource === 'calculate-price', 'priceSource=calculate-price（核价权威）');
  check(sol.totals.paidCents === 2980, `按核价 ¥29.8 呈现（实际 ¥${(sol.totals.paidCents / 100).toFixed(1)}；旧内核展示模型价 ¥14.9）`);
  check(sol.warnings.some((w) => w.includes('高于模型估算')), '差额警示存在');
  check(sol.members.reduce((s, m) => s + m.shareCents, 0) === sol.totals.paidCents, '核价口径下分账仍守恒');
}

console.log(failures === 0 ? '\n拼单内核集成验收全部通过 ✓' : `\n${failures} 项未通过 ✗`);
process.exit(failures === 0 ? 0 : 1);
