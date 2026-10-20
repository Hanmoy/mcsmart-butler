// v1.4.2 拼单内核修复验收（R04 无糖需求归一化 + R13 自动比价计数取建池成功结果）
//   R04：成员无糖需求归一化——sugarFree 标记 或 禁忌/备注中的无糖表述，产生同一约束效果；
//        含糖（含含糖未知）饮品不得分配给该成员，也不得标为需求满足。
//   R13：区分「内容已识别」「已映射到本门店」「实际进入求解池」；徽章与自动比价计数取建池成功结果，
//        建池失败项保留为价格候选并给出原因；stats 各计数互斥守恒。
// 运行：npx tsc --outDir .build-f && MCSMART_BUILD=../.build-f node scripts/test-v142-group.mjs
// 测试隔离：MCSMART_HOME 指向临时目录，绝不污染真实用户数据。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v142-'));
process.env.MCSMART_HOME = TEST_HOME;
process.env.MEITUAN_UNION_APPKEY = '';
process.env.MEITUAN_UNION_APPSECRET = '';
process.env.MCSMART_DISABLE_BUNDLED_UNION = '1'; // 无凭据 → 联盟层降级为本地团单库（测试可控）
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const BASE = process.env.MCSMART_BUILD ?? '../dist';
const K = await import(`${BASE}/groupKernel.js`);
const CAT = await import(`${BASE}/catalog.js`);

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? `（${detail}）` : ''}`); failures++; }
};

// ---------- mock MCP 菜单 ----------
// M9「无糖可乐」与 M8「雪碧」故意不给营养行（含糖未知）；M5「可乐」有营养行（已知含糖）。
const MENU = {
  M1: { name: '巨无霸', currentPrice: '26.5' },
  M2: { name: '板烧鸡腿堡', currentPrice: '28.5' },
  M3: { name: '薯条', currentPrice: '13.5' },
  M5: { name: '可乐', currentPrice: '10.5' },
  M8: { name: '雪碧', currentPrice: '9.5' },
  M9: { name: '无糖可乐', currentPrice: '10.5' },
  C2: { name: '巨无霸四件套', currentPrice: '42.0' },
  C3: { name: '雪碧小食套餐', currentPrice: '36.0' },
};
const priceOf = {};
for (const [code, m] of Object.entries(MENU)) priceOf[code] = Math.round(parseFloat(m.currentPrice) * 100);

const ROUNDS = {
  // 默认饮料 = 无糖可乐（聚合 fastCarb=0），可选可乐（已知含糖）
  C2: [
    { id: 11, name: '主食轮', choices: [{ code: 'M1', name: '巨无霸', isDefault: 1, diffPrice: '+0' }] },
    { id: 12, name: '小食轮', choices: [{ code: 'M3', name: '薯条', isDefault: 1, diffPrice: '+0' }] },
    { id: 13, name: '饮料轮', choices: [
      { code: 'M9', name: '无糖可乐', isDefault: 1, diffPrice: '+0' },
      { code: 'M5', name: '可乐', isDefault: 0, diffPrice: '+0' },
    ] },
  ],
  // 饮料轮只有含糖未知的雪碧（fastCarb=0）
  C3: [
    { id: 21, name: '主食轮', choices: [{ code: 'M1', name: '巨无霸', isDefault: 1, diffPrice: '+0' }] },
    { id: 22, name: '饮料轮', choices: [{ code: 'M8', name: '雪碧', isDefault: 1, diffPrice: '+0' }] },
  ],
};

const mockClient = {
  async call(tool, params) {
    if (tool === 'query-meals') {
      return { data: {
        categories: [
          { name: '汉堡小食', meals: ['M1', 'M2', 'M3'].map((code) => ({ code, tags: [] })) },
          { name: '饮品', meals: ['M5', 'M8', 'M9'].map((code) => ({ code, tags: [] })) },
          { name: '精选套餐', meals: [{ code: 'C2', tags: ['套餐'] }, { code: 'C3', tags: ['套餐'] }] },
        ],
        meals: MENU,
      } };
    }
    if (tool === 'list-nutrition-foods') {
      const row = (n, kj, kcal, p, f, c, na) => `  ${n},null,${kj},${kcal},${p},${f},${c},${na},0`;
      return { data: {}, rawText: [
        row('巨无霸', 2146, 513, 27, 26, 42, 961),
        row('板烧鸡腿堡', 1683, 402, 27, 18, 37, 790),
        row('薯条', 1214, 289, 4, 15, 34, 210),
        row('可乐', 616, 147, 0, 0, 37, 15),
        // 雪碧 / 无糖可乐 无营养行 → 含糖未知（fastCarb=0）
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
const itemNames = (m) => (m?.items ?? []).map((i) => `${i.name}×${i.qty}`).sort();

// ========== R04 无糖需求归一化 ==========
console.log('【R04-A】{taboos:["无糖"]} 与 {sugarFree:true} 产生同一约束效果（组合饮料轮换选无糖）');
{
  const members = [
    { alias: '甲', wishes: ['一份巨无霸四件套'], taboos: ['无糖'] },
    { alias: '乙', wishes: ['一份巨无霸四件套'], taboos: [], sugarFree: true },
  ];
  const k = await K.solveGroupWithKernel(mockClient, { ...STORE, members });
  const sol = k.bundle ?? k.solution;
  const jia = sol.members.find((m) => m.alias === '甲');
  const yi = sol.members.find((m) => m.alias === '乙');
  const hasCola = (m) => (m?.items ?? []).some((i) => i.name === '可乐');
  check(!hasCola(jia) && !hasCola(yi), '甲（禁忌=无糖）与乙（sugarFree）均未被分配含糖可乐',
    `甲[${itemNames(jia).join(',')}] 乙[${itemNames(yi).join(',')}]`);
  check(JSON.stringify(itemNames(jia)) === JSON.stringify(itemNames(yi)),
    '两者分配结果一致（同一约束效果）', `甲[${itemNames(jia).join(',')}] vs 乙[${itemNames(yi).join(',')}]`);
  check((jia?.items ?? []).some((i) => i.name === '无糖可乐'),
    '无糖需求成员拿到无糖可乐（未被误伤）', `甲[${itemNames(jia).join(',')}]`);
}

console.log('【R04-B】含糖未知饮品（无营养行，fastCarb=0）同样不得分配给无糖成员');
{
  const members = [{ alias: '丙', wishes: ['巨无霸', '一份雪碧小食套餐'], taboos: [], sugarFree: true }];
  const k = await K.solveGroupWithKernel(mockClient, { ...STORE, members });
  const sol = k.bundle ?? k.solution;
  const bing = sol.members.find((m) => m.alias === '丙');
  const hasSprite = (bing?.items ?? []).some((i) => i.name === '雪碧');
  check(!hasSprite, '丙未被分配雪碧（含糖未知）', `items=[${itemNames(bing).join(',')}]`);
  check((bing?.unresolvedWishes ?? []).some((w) => w.includes('雪碧')),
    '雪碧套餐心愿标为未满足', `unresolved=[${(bing?.unresolvedWishes ?? []).join('、')}]`);
}

console.log('【R04-C】memberNoSugaryDrink 归一化：标记 / 禁忌 / 备注 三路等价');
{
  if (typeof K.memberNoSugaryDrink === 'function') {
    const f = K.memberNoSugaryDrink;
    const base = (over = {}) => ({ alias: 'x', wishes: [], taboos: [], ...over });
    check(f(base({ sugarFree: true })) === true, 'sugarFree 标记 → true');
    check(f(base({ taboos: ['无糖'] })) === true, '禁忌「无糖」→ true');
    check(f(base({ taboos: ['不加糖'] })) === true, '禁忌「不加糖」→ true');
    check(f(base({ notes: ['去冰', '零度'] })) === true, '备注「零度」→ true');
    check(f(base({ taboos: ['无糖可乐'] })) === true, '禁忌「无糖可乐」→ true');
    check(f(base({ taboos: ['不要香菜'] })) === false, '无关禁忌 → false');
    check(f(base({})) === false, '无任何无糖表述 → false');
  } else {
    check(false, 'memberNoSugaryDrink 未导出（R04 未修复）');
  }
}

// ========== R13 自动比价计数取建池成功结果 ==========
console.log('【R13】内容已识别但无法建池：诊断计数与实际计划 ID 对账');
{
  const today = new Date().toISOString().slice(0, 10);
  const seed = (sign, name, contents) => ({
    sign, name, priceCents: 990, poiName: '麦当劳测试门店',
    admitted: true, contents,
    verify: { status: 'pattern-verified', verifiedAt: today, ruleVersion: 'single-name-v1', source: 'official-menu' },
  });
  // 1) 菜单不可用：券面固定品项在当前门店菜单不存在
  // 2) 组件缺失：券含两个固定品项，其一在当前门店菜单不存在
  // 3) 任选范围缺失：choice 型券，门店无随心配 SKU（无法定位任选轮次）
  // 4) 正常：券面两件固定品项均可映射 → 应真正入池
  CAT.upsertDeals([
    seed('U-GHOST', '幽灵汉堡券', [{ mode: 'fixed', keyword: '幽灵汉堡X', qty: 1 }]),
    seed('U-PART', '缺组件券', [{ mode: 'fixed', keyword: '板烧鸡腿堡', qty: 1 }, { mode: 'fixed', keyword: '幽灵配菜Y', qty: 1 }]),
    seed('U-CHOICE', '任选券', [{ mode: 'choice', keyword: 'staple', qty: 1 }, { mode: 'choice', keyword: 'side', qty: 1 }]),
    seed('U-OK', '可映射券', [{ mode: 'fixed', keyword: '板烧鸡腿堡', qty: 1 }, { mode: 'fixed', keyword: '薯条', qty: 1 }]),
  ]);

  // 心愿 = 可映射券内容 → 该券会被购买，从而可从购买清单反查「实际进入求解池」的计划 ID
  const members = [{ alias: '小明', wishes: ['板烧鸡腿堡', '薯条'], taboos: [] }];
  const k = await K.solveGroupWithKernel(mockClient, { ...STORE, members });
  const u = k.channelDiagnostics.union;
  const deals = u.deals ?? [];
  const st = u.stats;

  const unionPlanIds = new Set();
  for (const sol of [k.solution, k.bundle, k.voucherTrack]) {
    for (const b of (sol?.basket ?? [])) {
      if (b.kind === 'voucher' && String(b.code).startsWith('kv-union-')) unionPlanIds.add(b.code);
    }
  }

  check(u.admitted === unionPlanIds.size,
    'union.admitted = 实际进入求解池的券计划数', `admitted=${u.admitted} 实际计划=${unionPlanIds.size}`);
  check(unionPlanIds.has('kv-union-U-OK') && unionPlanIds.size === 1,
    '仅「可映射券」建池成功', [...unionPlanIds].join(','));

  const statusOf = (n) => deals.find((d) => d.name === n)?.status;
  check(statusOf('幽灵汉堡券') === 'price-candidate', '菜单不可用 → 价格候选', statusOf('幽灵汉堡券'));
  check(statusOf('缺组件券') === 'price-candidate', '组件缺失 → 价格候选', statusOf('缺组件券'));
  check(statusOf('任选券') === 'price-candidate', '任选范围缺失 → 价格候选', statusOf('任选券'));
  check(statusOf('可映射券') === 'admitted', '可映射券 → 可自动比价', statusOf('可映射券'));

  check(deals.filter((d) => d.status === 'admitted').length === 1,
    '列表徽章「可自动比价」仅 1 条', `实际 ${deals.filter((d) => d.status === 'admitted').length}`);

  const excludedNames = new Set((k.channelDiagnostics.excluded ?? []).map((e) => e.name));
  check(excludedNames.has('幽灵汉堡券') && excludedNames.has('缺组件券') && excludedNames.has('任选券'),
    '建池失败项保留于排除列表并给出原因');
  check(!excludedNames.has('可映射券'), '建池成功项不在排除列表');

  check(!!st, 'stats 存在');
  if (st) {
    check(st.admitted === unionPlanIds.size, 'stats.admitted = 建池成功数', `${st.admitted}`);
    const sum = st.admitted + (st.priceCandidates ?? 0) + st.saleEnded + st.validityExpired + st.other;
    check(sum === st.queried, 'stats 各计数互斥守恒（Σ = queried）',
      `${st.admitted}+${st.priceCandidates ?? 0}+${st.saleEnded}+${st.validityExpired}+${st.other}=${sum} vs queried=${st.queried}`);
    check(st.queried === u.queried && deals.length === u.queried,
      'queried = 内核实际返回的团单条数（与列表长度一致）', `queried=${st.queried} 列表=${deals.length}`);
    // 内容已识别数 ≥ 本次核验通过的 4 张（种子库另有历史团单，故不硬编码）
    check(st.menuVerified >= 4 && st.menuVerified <= st.queried,
      'menuVerified = 内容已识别数（≥ 本次核验的 4 张）', `menuVerified=${st.menuVerified} queried=${st.queried}`);
  }
}

console.log(failures === 0 ? '\nR04/R13 验收全部通过 ✓' : `\n${failures} 项未通过 ✗`);
process.exit(failures === 0 ? 0 : 1);
