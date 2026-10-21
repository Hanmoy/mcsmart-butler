// 项目本体：食品身份、Top-K 与网页签名一致性。仅使用离线构造输入。
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const home = mkdtempSync(join(tmpdir(), 'mcsmart-core-review-'));
process.env.MCSMART_HOME = home;
process.env.MCSMART_DISABLE_BUNDLED_UNION = '1';
for (const key of ['MCD_MCP_TOKEN', 'MEITUAN_UNION_APPKEY', 'MEITUAN_UNION_APPSECRET', 'MEITUAN_UNION_SID']) delete process.env[key];
globalThis.fetch = () => { throw new Error('本体回归禁止业务联网'); };
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
const { foodKeyOf } = await import('../dist/foodIdentity.js');
const { optimizeTopK } = await import('../dist/optimizer.js');
const { serviceSolveSingle } = await import('../dist/service.js');
const { renderSingleText } = await import('../dist/present.js');
const { CONFIG } = await import('../dist/config.js');
CONFIG.topK = 1;

let failures = 0, checks = 0;
async function test(label, fn) {
  checks++;
  try { await fn(); console.log('✓ ' + label); }
  catch (e) { failures++; console.error('✗ ' + label + ': ' + e.message); }
}
await test('本体食品身份保留括号内糖型', () => {
  assert.notEqual(foodKeyOf({ name: '可乐（无糖）', spec: '中杯' }), foodKeyOf({ name: '可乐（含糖）', spec: '中杯' }));
});
await test('本体食品身份保留括号内口味', () => {
  assert.notEqual(foodKeyOf({ name: '鸡翅（原味）' }), foodKeyOf({ name: '鸡翅（香辣）' }));
});
await test('规格前置/后置/括号写法归为同食品，保留大小份差异', () => {
  const refs = [{ name: '中薯条' }, { name: '薯条中份' }, { name: '薯条（中）' }, { name: '薯条', spec: '中份' }];
  assert.equal(new Set(refs.map(foodKeyOf)).size, 1);
  assert.notEqual(foodKeyOf({ name: '薯条（中）' }), foodKeyOf({ name: '薯条（大）' }));
});
const option = (name, kcal, staple, code) => ({ name, kcal, kcalKnown: true, priceCents: 0, diffCents: 0, staple, veggie: false,
  code, protein: 0, fat: 0, carbohydrate: 0, sodium: 0, fastCarb: 0, drink: !staple });
await test('真实 Top-K 保留无糖与含糖两个合法配置', async () => {
  const plans = [['zero', '可乐（无糖）', 0], ['sugar', '可乐（含糖）', 150]].map(([id, name, kcal]) => ({
    id, channel: 'mcd-mcp', name: id, basePriceCents: 1000, maxQty: 1, slots: [
      { roundName: '主食', options: [option('审查主食堡', 400, true, 'MAIN')] },
      { roundName: '饮料', options: [option(name, kcal, false, id)] },
    ],
  }));
  const r = await optimizeTopK({ plans, members: [{ alias: '我', stapleMin: 1 }], mode: 'fit', kcalBudget: 400, totalBudgetCents: 1000 }, 2);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map(r => r.totals.kcal), [400, 550]);
});
await test('网页与本体用同一食品身份规则', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('// BEGIN SHARED_FOOD_IDENTITY'), html.indexOf('// 美团团单独立列表'));
  const key = runInNewContext(source + ';foodIdentityKey');
  for (const ref of [
    { name: '可乐（无糖）', spec: '中杯' }, { name: '可乐（含糖）', spec: '中杯' },
    { name: '鸡翅（香辣）' }, { name: '薯条（中）' }, { name: '中薯条' }, { name: '薯条中份' },
    { name: '麦香鸡（汉堡）' }, { name: '麦香鸡汉堡' },
  ]) assert.equal(key(ref), foodKeyOf(ref), JSON.stringify(ref));
});

function serviceClient(extraName, extraNutrition) {
  const meals = { A: { name: '审查营养甲堡', currentPrice: '15' } };
  const categories = [{ name: '汉堡', meals: [{ code: 'A' }] }];
  const rows = [['审查营养甲堡', 400, 10, 20, 30, 100]];
  const rounds = [];
  if (extraName) {
    meals.B = { name: extraName, currentPrice: '5' };
    meals.C = { name: '审查完整二件套餐', currentPrice: '20' };
    categories.push({ name: '套餐', meals: [{ code: 'C', tags: ['套餐'] }] });
    rounds.push({ id: 1, name: '主食', choices: [{ code: 'A', name: meals.A.name, isDefault: 1, diffPrice: '+0' }] },
      { id: 2, name: '小食饮品', choices: [{ code: 'B', name: extraName, isDefault: 1, diffPrice: '+0' }] });
    if (extraNutrition) rows.push([extraName, ...extraNutrition]);
  }
  return { async call(tool, args = {}) {
    if (tool === 'query-meals') return { data: { meals, categories } };
    if (tool === 'list-nutrition-foods') return { rawText: rows.map(([n,k,p,f,c,s]) => `  ${n},null,${k*4},${k},${p},${f},${c},${s},0`).join('\n') };
    if (tool === 'query-meal-detail') return { data: { rounds: args.code === 'C' ? rounds : [] } };
    throw new Error('离线夹具不支持 ' + tool);
  } };
}
await test('零卡剩余时 service 与文本仍明确本人钠摄入及剩余品项', async () => {
  const out = await serviceSolveSingle(serviceClient('无糖可口可乐', [0, 0, 0, 0, 50]), {
    storeCode: 'CORE-ZERO', kcal: 400, yuan: 20, constraints: [{ metric: 'sodium', op: '<=', value: 110 }],
  });
  assert.ok(out.feasible);
  const s = out.solutions[0], text = renderSingleText(out);
  assert.equal(s.intake.macros.sodium, 100);
  assert.equal(s.metrics.sodium, 150);
  assert.equal(s.intake.leftoverKcal, 0);
  assert.equal(s.intake.complete, false);
  assert.ok(s.reasonNotes.some(n => n.includes('剩余') && n.includes('无糖可口可乐')));
  assert.ok(text.includes('本人摄入') && text.includes('钠 100mg'));
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const renderer = html.slice(html.indexOf('function renderSol('), html.indexOf('// ---- 拼单模式 ----'));
  const render = runInNewContext(renderer + ';renderSol', { $: () => ({ value: '400' }), esc: String, fmtYuan: String,
    PRICE_SOURCE_LABEL: {}, configChoiceText: c => c.chosenName, renderCard: o => o });
  assert.ok(render(s, 0).middleHtml.includes('本人摄入'));
});
await test('CLI 文本如实转述偏差，不把偏离600kcal称为贴合', async () => {
  const out = await serviceSolveSingle(serviceClient(), { storeCode: 'CORE-FAR', kcal: 1000, yuan: 15 });
  assert.ok(out.feasible);
  const text = renderSingleText(out);
  assert.ok(!text.includes('预算内贴合'));
  assert.ok(text.includes('偏差 600') && text.includes('超出声明容差'));
});
await test('CLI 保留方案的估算营养标记', async () => {
  const out = await serviceSolveSingle(serviceClient('麦麦脆汁鸡'), { storeCode: 'CORE-ESTIMATE', kcal: 720, yuan: 20 });
  assert.ok(out.solutions[0].metrics.nutritionEstimated);
  assert.ok(renderSingleText(out).includes('估算'));
});
await test('原问题参数直接进入本体：1000kcal、50元、至少两份主食', async () => {
  const out = await serviceSolveSingle(serviceClient('无糖可口可乐', [0, 0, 0, 0, 50]), {
    storeCode: 'CORE-ORIGINAL-INPUT', kcal: 1000, yuan: 50,
    constraints: [{ metric: 'staple', op: '>=', value: 2 }],
  });
  assert.ok(out.feasible);
  assert.ok(out.solutions.length > 0);
  for (const s of out.solutions) {
    assert.ok(s.metrics.staple >= 2);
    assert.ok(s.finalPriceCents <= 5000);
    assert.equal(s.items.reduce((n, it) => n + it.subtotalCents, 0), s.finalPriceCents);
  }
});
console.log(`本体推荐回归：${checks - failures}/${checks} 通过`);
if (failures) process.exitCode = 1;
