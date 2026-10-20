// v1.4.2 服务层验收（R01 入口别名 / R02 约束真实入模 / R06 逐份配置 / P2 单品兜底）
//   全部离线（mock MCP，不联网）；隔离 MCSMART_HOME，不污染真实用户数据。
// 运行：npx tsc --outDir .build-b && MCSMART_BUILD=../.build-b node scripts/test-v142-service.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v142-'));
process.env.MCSMART_HOME = TEST_HOME;
process.env.MEITUAN_UNION_APPKEY = '';
process.env.MEITUAN_UNION_APPSECRET = '';
process.env.MCSMART_DISABLE_BUNDLED_UNION = '1'; // 强制无联盟凭据（模拟降级，避免联网）
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const BASE = process.env.MCSMART_BUILD ?? '../dist';
const S = await import(`${BASE}/service.js`);
const P = await import(`${BASE}/present.js`);

let failures = 0;
let checks = 0;
const check = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? `（${detail}）` : ''}`); failures++; }
};
const expectError = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

// ---------- mock 客户端 ----------
// nutrition: [{ name, kcal, protein, fat, carb, sodium }]
function makeClient({ categories, meals, comboRounds = {}, nutrition = [] }) {
  return {
    async call(tool, args = {}) {
      if (tool === 'query-meals') return { data: { categories, meals } };
      if (tool === 'list-nutrition-foods') {
        return {
          rawText: nutrition
            .map((r) => `  ${r.name},null,${Math.round((r.kcal ?? 0) * 4.184)},${r.kcal ?? 0},${r.protein ?? 0},${r.fat ?? 0},${r.carb ?? 0},${r.sodium ?? 0},0`)
            .join('\n'),
        };
      }
      if (tool === 'query-meal-detail') return { data: { rounds: comboRounds[args.code] ?? [] } };
      if (tool === 'query-nearby-stores') return { data: [] };
      return { data: {} };
    },
  };
}

const solve = (client, body) => S.serviceSolveSingle(client, body, {});
const totalKcalOf = (out) => out.solutions[0].metrics.kcal;
const codesOf = (out) => out.solutions[0].items.map((it) => it.code).join(',');

// ========== R01：入口别名转换（carb → carbohydrate） ==========
console.log('【R01】入口别名转换与低碳排序');
{
  // 两个同热量同价、碳水不同的主食候选；objectives:['carb'] 应映射为 carbohydrate（更少）并选中低碳者
  const client = makeClient({
    categories: [{ name: '主食', meals: [{ code: 'A', tags: [] }, { code: 'B', tags: [] }] }],
    meals: { A: { name: '甲堡', currentPrice: '20.00', originalPrice: '20.00' }, B: { name: '乙堡', currentPrice: '20.00', originalPrice: '20.00' } },
    nutrition: [
      { name: '甲堡', kcal: 500, carb: 60, protein: 20, fat: 20, sodium: 800 },
      { name: '乙堡', kcal: 500, carb: 20, protein: 20, fat: 20, sodium: 800 },
    ],
  });
  const out = await solve(client, { storeCode: 'S-R01', kcal: 500, yuan: 50, objectives: ['carb'] });
  check(out.feasible && out.solutions.length > 0, 'objectives:[carb] 能跑通（不再 HiGHS 报错）', `feasible=${out.feasible}`);
  check(out.objectives.includes('carbohydrate'), "目标名已转成内核规范名 carbohydrate（非 carb）", out.objectives.join('→'));
  check(codesOf(out) === 'mcd-s-B', '同热量下按低碳方向排序，选中碳水 20g 的乙堡', `chosen=${codesOf(out)}`);
  check(out.solutions[0].metrics.carb === 20, '聚合碳水为 20g（无 undefined/NaN）', String(out.solutions[0].metrics.carb));
  const json = JSON.stringify(out);
  check(!/NaN|undefined/.test(json), 'JSON 中无 NaN/undefined');

  // carbs 别名同样接受
  const out2 = await solve(client, { storeCode: 'S-R01', kcal: 500, yuan: 50, objectives: ['carbs'] });
  check(out2.objectives.includes('carbohydrate'), 'carbs 亦为 carbohydrate 别名', out2.objectives.join('→'));

  // 未知目标 → E_INPUT_INVALID
  const err = await expectError(() => solve(client, { storeCode: 'S-R01', kcal: 500, yuan: 50, objectives: ['sugar'] }));
  check(err?.code === 'E_INPUT_INVALID', '未知优化目标抛 E_INPUT_INVALID', err?.code ?? 'no-error');
  check(/合法值/.test(err?.message ?? ''), '错误信息列出合法值', err?.message ?? '');
}

// ========== R02：约束真实入模 ==========
console.log('【R02】约束归一化与真实入模');
const r02Client = makeClient({
  categories: [
    { name: '套餐', meals: [{ code: 'D1', tags: ['套餐'] }] },
    { name: '单品', meals: [{ code: 'G1', tags: [] }, { code: 'K1', tags: [] }] },
  ],
  meals: {
    D1: { name: '测试豪华餐', currentPrice: '30.00', originalPrice: '30.00' },
    G1: { name: '巨无霸', currentPrice: '25.00', originalPrice: '25.00' },
    K1: { name: '可乐', currentPrice: '7.00', originalPrice: '7.00' },
  },
  comboRounds: {
    D1: [{ id: 1, name: '主食', choices: [{ code: 'G1', name: '巨无霸', isDefault: 1, diffPrice: '+¥0' }] }],
  },
  nutrition: [
    { name: '巨无霸', kcal: 500, carb: 45, protein: 26, fat: 26, sodium: 1000 },
    { name: '可乐', kcal: 0, carb: 0, protein: 0, fat: 0, sodium: 5 },
  ],
});
{
  // 2-a：kcal >= 900 必须真实生效（旧实现被丢弃，仍返回 600 kcal）
  const out = await solve(r02Client, { storeCode: 'S-R02', kcal: 600, yuan: 100, constraints: [{ metric: 'kcal', op: '>=', value: 900 }] });
  check(out.feasible, 'kcal>=900 有可行解', `feasible=${out.feasible}`);
  check(totalKcalOf(out) >= 900, '首方案热量 >= 900（约束真实入模）', `${totalKcalOf(out)} kcal`);
  check(out.constraints.some((c) => c.metric === 'kcal' && c.op === '>=' && c.value === 900), '响应回显 kcal>=900', JSON.stringify(out.constraints));
}
{
  // 2-b：staple <= 0 必须真实生效（旧实现仍返回 1 份主食）
  const out = await solve(r02Client, { storeCode: 'S-R02', kcal: 400, yuan: 100, constraints: [{ metric: 'staple', op: '<=', value: 0 }] });
  check(out.feasible, 'staple<=0 有可行解', `feasible=${out.feasible}`);
  check(out.solutions[0].metrics.staple === 0, '主食份数为 0（约束真实入模）', `${out.solutions[0].metrics.staple} 份`);
  check(!out.constraints.some((c) => c.metric === 'staple' && c.op === '>='), '用户显式 staple 约束时不注入默认 staple>=1', JSON.stringify(out.constraints));
}
{
  // 2-c：重复上限取最紧（<=700 与 <=500 → 500）
  const out = await solve(r02Client, { storeCode: 'S-R02', kcal: 600, yuan: 100, constraints: [{ metric: 'kcal', op: '<=', value: 700 }, { metric: 'kcal', op: '<=', value: 500 }] });
  const kcalCaps = out.constraints.filter((c) => c.metric === 'kcal' && c.op === '<=');
  check(kcalCaps.length === 1 && kcalCaps[0].value === 500, '重复上限合并为最紧的 500', JSON.stringify(out.constraints));
  check(out.feasible && totalKcalOf(out) <= 500, '首方案热量 <= 500', `${totalKcalOf(out)} kcal`);
}
{
  // 2-d：矛盾约束（<=500 且 >=900）→ 明确无解
  const err = await expectError(() => solve(r02Client, { storeCode: 'S-R02', kcal: 600, yuan: 100, constraints: [{ metric: 'kcal', op: '<=', value: 500 }, { metric: 'kcal', op: '>=', value: 900 }] }));
  check(err?.code === 'E_NO_SOLUTION', '矛盾约束抛 E_NO_SOLUTION（明确无解）', err?.code ?? 'no-error');
}
{
  // 2-e / 2-f：不支持的 metric / op → E_INPUT_INVALID
  const e1 = await expectError(() => solve(r02Client, { storeCode: 'S-R02', kcal: 600, yuan: 100, constraints: [{ metric: 'sugar', op: '<=', value: 10 }] }));
  check(e1?.code === 'E_INPUT_INVALID', '未知度量 sugar 抛 E_INPUT_INVALID', e1?.code ?? 'no-error');
  const e2 = await expectError(() => solve(r02Client, { storeCode: 'S-R02', kcal: 600, yuan: 100, constraints: [{ metric: 'protein', op: '==', value: 10 }] }));
  check(e2?.code === 'E_INPUT_INVALID', '不支持的操作符 == 抛 E_INPUT_INVALID', e2?.code ?? 'no-error');
}

// ========== R06：逐份配置（不同搭配的同一套餐分行） ==========
console.log('【R06】同一套餐两份不同配置逐份输出');
{
  const client = makeClient({
    categories: [
      { name: '套餐', meals: [{ code: 'C1', tags: ['套餐'] }] },
      { name: '单品', meals: [{ code: 'A', tags: [] }, { code: 'B', tags: [] }] },
    ],
    meals: {
      C1: { name: '测试双堡餐', currentPrice: '6.00', originalPrice: '6.00' },
      A: { name: '甲堡', currentPrice: '20.00', originalPrice: '20.00' },
      B: { name: '乙堡', currentPrice: '20.00', originalPrice: '20.00' },
    },
    comboRounds: {
      C1: [{ id: 1, name: '主食', choices: [{ code: 'A', name: '甲堡', isDefault: 1, diffPrice: '+¥0' }, { code: 'B', name: '乙堡', isDefault: 0, diffPrice: '+¥0' }] }],
    },
    nutrition: [
      { name: '甲堡', kcal: 100, carb: 10, protein: 6, fat: 4, sodium: 200 },
      { name: '乙堡', kcal: 200, carb: 20, protein: 10, fat: 8, sodium: 400 },
    ],
  });
  // 目标 300 kcal：最优为「甲堡+乙堡」两份同一套餐（合计 300），旧实现输出 qty:2 / kcal:150 只保留乙堡
  const out = await solve(client, { storeCode: 'S-R06', kcal: 300, yuan: 50 });
  check(out.feasible && out.solutions.length > 0, '有可行解', `feasible=${out.feasible}`);
  const items = out.solutions[0].items;
  check(items.length === 1 && items[0].code === 'mcd-C1', '只买一份套餐计划', items.map((i) => `${i.code}×${i.qty}`).join(','));
  const it = items[0];
  check(it.qty === 2, '套餐共 2 份', `qty=${it.qty}`);
  check(Array.isArray(it.units) && it.units.length === 2, '逐份配置分两行（不同配置不合并）', JSON.stringify(it.units?.map((u) => u.kcal)));
  const unitKcals = (it.units ?? []).map((u) => u.kcal).sort((a, b) => a - b).join(',');
  check(unitKcals === '100,200', '两份分别为 100 / 200 kcal', unitKcals);
  check((it.units ?? []).every((u) => u.qty === 1), '两行各 1 份', JSON.stringify(it.units?.map((u) => u.qty)));
  const chosen = (it.units ?? []).flatMap((u) => u.config.map((c) => c.chosenName)).sort().join(',');
  check(chosen === '乙堡,甲堡', '逐份配置保留各自选中项', chosen);
  const sumKcal = (it.units ?? []).reduce((s, u) => s + u.kcal * u.qty, 0);
  check(sumKcal === 300, '逐份热量合计 = 模型合计 300', String(sumKcal));
  check(it.kcal === 150, '向后兼容：聚合 kcal 仍为加权均值 150', String(it.kcal));
  // 文本卡按逐份配置输出
  const card = P.renderSingleText(out);
  check(card.includes('100 kcal/份') && card.includes('200 kcal/份'), '文本卡按逐份配置输出（100/200 各一行）');
}

// ========== P2：只有单品、没有可用套餐/券时也走兜底 ==========
console.log('【P2】只有单品时不再直接无解');
{
  const client = makeClient({
    categories: [{ name: '单品', meals: [{ code: 'A', tags: [] }, { code: 'F', tags: [] }] }],
    meals: {
      A: { name: '测试甲堡', currentPrice: '20.00', originalPrice: '20.00' },
      F: { name: '测试薯条', currentPrice: '12.00', originalPrice: '12.00' },
    },
    nutrition: [
      { name: '测试甲堡', kcal: 500, carb: 45, protein: 26, fat: 26, sodium: 1000 },
      { name: '测试薯条', kcal: 400, carb: 50, protein: 5, fat: 20, sodium: 300 },
    ],
  });
  const out = await solve(client, { storeCode: 'S-P2', kcal: 500, yuan: 50 });
  check(out.feasible && out.solutions.length > 0, '仅单品池也能求解（旧实现被外层条件挡住 → 无解）', `feasible=${out.feasible} 方案数=${out.solutions.length}`);
  check(out.comboCount === 0, '该菜单确实没有套餐', `comboCount=${out.comboCount}`);
  check(out.solutions[0].items.every((it) => it.code.startsWith('mcd-s-')), '方案由单品构成', codesOf(out));
}

console.log(`\n服务层验收：${checks - failures} 通过 / ${failures} 失败（共 ${checks} 项）`);
process.exit(failures > 0 ? 1 : 0);
