// v1.4.5 团购券业务反例回归（W01–W03 / W06）
// 运行：node scripts/test-v145-coupons.mjs（需先 tsc；无网络依赖）
//
// 这些用例在 v1.4.4 旧行为下会失败：
//   W01 建槽不消费配方 choiceRange / 不按 qty 展开 / 无官方 SKU 直接返回 null
//   W02 规格不决定营养（小/中/大一律取中份），无依据规格回退默认份量
//   W03 部分选项被静默丢弃仍报成功；券面补差一律写 0
//   W06 配方匹配按 scope.stores 硬过滤
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v145-'));
process.env.MCSMART_HOME = HOME;

let failures = 0;
const check = (cond, label, detail) => {
  if (!cond) failures++;
  const tag = cond ? '✓' : '✗';
  console.log(`  ${tag} ${label}${detail !== undefined ? `（${typeof detail === 'object' ? JSON.stringify(detail).slice(0, 240) : detail}）` : ''}`);
};

const VR = await import('../dist/voucherRecipes.js');
const VF = await import('../dist/voucherFoods.js');
const K = await import('../dist/groupKernel.js');

const EMPTY_MENU = { items: [], unmatched: 0, comboCount: 0, comboUnmatched: 0, table: new Map() };
const TWO_ROUND_FIXTURE = {
  code: 'OFFICIAL-FIXTURE', name: '官方两轮随心配夹具', priceCents: 2000,
  rounds: [
    { id: 'a', name: '主食', choices: [{ code: 'BIGMAC', name: '巨无霸', diffCents: 0 }] },
    { id: 'b', name: '小食', choices: [{ code: 'FRIES', name: '薯条', diffCents: 0 }] },
  ],
};

console.log('\n[W01] 券面声明范围进入实际建槽（不借用其他套餐、不丢份数）');
{
  const four = VR.loadRecipes().find((r) => r.id === 'rcp-fandazi-4');
  const slots = four ? K.voucherSlots(VR.recipeToVoucher(four, 2780), EMPTY_MENU, [TWO_ROUND_FIXTURE]) : null;
  check(slots?.length === 4, '小食 4 件自由拼在空菜单下生成 4 个槽位（旧实现仅 2 槽）', { slots: slots?.length ?? 0 });

  const bf = VR.loadRecipes().find((r) => r.id === 'rcp-dacui-maimanfen-2');
  const bfSlots = bf ? K.voucherSlots(VR.recipeToVoucher(bf, 1300), EMPTY_MENU, [TWO_ROUND_FIXTURE]) : null;
  const drinkSlot = bfSlots?.find((s) => /饮品/.test(s.roundName));
  const drinkNames = drinkSlot?.options.map((o) => o.name) ?? [];
  const declared = bf?.items.find((it) => it.mode === 'choice' && /饮品/.test(it.spec ?? ''))?.choiceRange ?? [];
  check(declared.length > 0 && declared.every((d) => drinkNames.includes(d)) && !drinkNames.some((n) => /堡|鸡翅|鸡排/.test(n)),
    '早餐饮品槽只出现券面声明的饮品（旧实现借用「两轮随心配」返回汉堡）', { declared, actual: drinkNames });

  const officialOnly = VR.loadRecipes().find((r) => r.id === 'rcp-1plus1');
  const onePlusOne = officialOnly ? K.voucherSlots(VR.recipeToVoucher(officialOnly, 1390), EMPTY_MENU, []) : null;
  check(onePlusOne === null, '缺官方轮次时 1+1 不猜测（不得按轮次数借用其他套餐）', { slots: onePlusOne?.length ?? null });
}

console.log('\n[W02] 规格决定营养（不把小份算成中份，不为无依据规格编造）');
{
  const cases = [['小薯条', '小', 210], ['大薯条', '大', 379], ['小可乐', '小', 107], ['中可乐', '中', 147]];
  for (const [name, spec, kcal] of cases) {
    const got = VF.resolveFixedVoucherFood({ mode: 'fixed', keyword: name, qty: 1, spec }, EMPTY_MENU)?.kcal;
    check(got === kcal, `${name}（spec=${spec}）→ ${kcal} kcal`, { got });
  }
  const wing4 = VF.resolveFixedVoucherFood({ mode: 'fixed', keyword: '麦辣鸡翅', qty: 1, spec: '4块' }, EMPTY_MENU);
  check(wing4?.kcal === 448, '一份四块鸡翅 = 两份两块（448 kcal）', { got: wing4?.kcal ?? null });
  const bogus = VF.resolveFixedVoucherFood({ mode: 'fixed', keyword: '麦麦脆汁鸡', qty: 1, spec: '999块' }, EMPTY_MENU);
  check(bogus === null, '无依据规格（999块）不得回退默认份量冒充已知', { got: bogus?.kcal ?? null });
  for (const [name, spec, kcal] of [['麦麦脆汁鸡', '1块', 320], ['心形薯饼', '5块', 240], ['马苏里拉拉丝芝士条', '1份', 220]]) {
    const got = VF.resolveFixedVoucherFood({ mode: 'fixed', keyword: name, qty: 1, spec }, EMPTY_MENU);
    check(got?.kcal === kcal && got.nutritionEstimated === true, `${name}（${spec}）调查值 ${kcal} kcal 且保留估算标记`, { got: got?.kcal ?? null });
  }
}

console.log('\n[W03] 声明范围完整性与补差（部分支持不得报完整）');
{
  const base = { id: 'probe', name: 'probe', resolve: 'explicit', ruleVersion: 'probe-v1' };
  const partial = VF.resolveVoucherFoods({ ...base, items: [{ mode: 'choice', keyword: 'side', qty: 1, choiceRange: ['麦乐鸡', '火星不存在食品'] }] }, { menu: EMPTY_MENU });
  check(partial.ok === true && partial.complete === false && partial.groups?.[0]?.unsupported.length === 1,
    '部分选项不可解析：保留已支持项且明确 complete=false', { complete: partial.complete, unsupported: partial.groups?.[0]?.unsupported });

  const sur = VF.resolveVoucherFoods({ ...base, items: [{ mode: 'choice', keyword: 'side', qty: 1, choiceRange: ['麦乐鸡', '麦辣鸡翅'], surcharge: '换鸡翅加2元' }] }, { menu: EMPTY_MENU });
  const wing = sur.slots?.[0]?.options.find((o) => /鸡翅/.test(o.name));
  check(wing?.diffCents === 200, '券面「换鸡翅加2元」→ 该选项差价 200 分（旧实现全写 0）', { diff: wing?.diffCents ?? null });

  const range = VR.loadRecipes().find((r) => r.id === 'rcp-fandazi-4')?.items.find((it) => /B区/.test(it.keyword));
  check(range?.choiceRange?.length === 7 && range.choiceRange.some((x) => /无糖/.test(x)),
    '饭搭子 B 区声明 7 项（含无糖可乐）', { count: range?.choiceRange?.length ?? 0, range: range?.choiceRange });
}

console.log('\n[W06] 具体门店字段仅作元数据（不硬过滤）');
{
  const recipe = {
    ...VR.loadRecipes()[0], id: 'probe-scope', name: 'probe-scope', resolve: 'explicit',
    scope: { stores: ['ANOTHER-STORE'] }, items: [{ mode: 'fixed', keyword: '巨无霸', qty: 1 }],
  };
  check(VR.matchRecipeCandidates('probe-scope', [recipe], { storeCode: 'REVIEW' }).length === 1,
    '同一商品结构在不同 storeCode 下仍匹配（旧实现按 scope.stores 排除）', null);
}

console.log('\n[W05] 随包配方种子与 PRESET_RECIPES 同源');
{
  const seed = JSON.parse(fs.readFileSync(join(process.cwd(), 'data', 'voucher-recipes-seed.json'), 'utf8'));
  const recipes = Array.isArray(seed?.recipes) ? seed.recipes : [];
  check(recipes.length === VR.PRESET_RECIPES.length, `种子条数 = PRESET_RECIPES（${VR.PRESET_RECIPES.length}）`, { seed: recipes.length });
  check(JSON.stringify(recipes) === JSON.stringify(VR.PRESET_RECIPES), '种子内容与 PRESET_RECIPES 完全一致（防漂移）', null);
  const critical = ['rcp-maixiangji-3-v1', 'rcp-namedajipai-single', 'rcp-2-maixuanfeng', 'rcp-xiantian-sanpin'];
  check(critical.every((id) => VR.PRESET_RECIPES.some((r) => r.id === id)),
    '关键券配方随包（干净安装可解析）', { missing: critical.filter((id) => !VR.PRESET_RECIPES.some((r) => r.id === id)) });
}

if (failures > 0) {
  console.log(`\n${failures} 项未通过 ✗`);
  process.exit(1);
}
console.log('\nv1.4.5 团购券业务反例全部通过 ✓');
