// 静态 demo 契约与真实前端分组回归；不联网、不读取账户。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('public/index.html');
const functions = html.slice(html.indexOf('// BEGIN SHARED_FOOD_IDENTITY'), html.indexOf('// 美团团单独立列表'));
const ui = runInNewContext(functions + ';({groupByBasket, basketKeyOf, variantDesc, variantNutritionText:typeof variantNutritionText==="function"?variantNutritionText:null})', { PRICE_SOURCE_LABEL: {} });
const sandbox = {
  window: { fetch() { throw new Error('静态 API 不得穿透到网络'); }, location: { href: 'https://example.test/project/demo/' }, addEventListener() {} },
  document: { addEventListener() {} }, console, Response, URL, setTimeout,
};
runInNewContext(read('docs/demo/mock-data.js'), sandbox);
runInNewContext(read('scripts/demo-template/mock-fetch.js'), sandbox);
const D = sandbox.window.MCSMART_DEMO;
const request = (path, body, method = 'POST') => sandbox.window.fetch('/api/' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
const clone = value => JSON.parse(JSON.stringify(value));
let failures = 0, checks = 0;
async function test(name, run) {
  checks++;
  try { await run(); console.log('✓ ' + name); }
  catch (e) { failures++; console.error('✗ ' + name + ': ' + e.message); }
}

await test('板烧两种饮料选配只占一张推荐卡，原始方案完整保留', () => {
  const groups = ui.groupByBasket(D.single.solutions);
  assert.equal(groups.length, 2);
  assert.equal(groups.flat().length, D.single.solutions.length);
  assert.equal(groups[0][0].metrics.kcal, D.single.solutions[0].metrics.kcal);
});
await test('不同套餐、不同份数不会折叠为同一张卡', () => {
  const first = clone(D.single.solutions[0]);
  const second = clone(first);
  second.items[0].qty = 2;
  second.items[0].units[0].qty = 2;
  assert.equal(ui.groupByBasket([first, second]).length, 2);
  assert.notEqual(ui.basketKeyOf(first), ui.basketKeyOf(second));
});
await test('foods 数量参与食品签名', () => {
  const single = qty => ({ items: [{ name: '单点', qty, foods: [{ code: 'F', name: '薯条', qty }] }] });
  assert.notEqual(ui.basketKeyOf(single(1)), ui.basketKeyOf(single(2)));
});
await test('选配摘要按真实逐份配置与数量显示', () => {
  const s = clone(D.single.solutions[0]);
  s.items[0].deconstruction = [{ defaultName: '错误默认项' }];
  const text = ui.variantDesc(s);
  assert.ok(text.includes('零度可乐'));
  assert.ok(!text.includes('错误默认项'));
});
await test('单点同名不同规格和糖型保持独立', () => {
  const sol = name => ({ items: [{ name, qty: 1, code: 'parent', isCombo: false, units: [{ qty: 1, config: [{ chosenName: name, chosenCode: 'parent' }] }] }] });
  assert.equal(ui.groupByBasket([sol('可乐中杯'), sol('可乐大杯'), sol('无糖可乐中杯')]).length, 3);
});
await test('每个选配的宏量营养单独展示，缺失不显示为零', () => {
  assert.equal(typeof ui.variantNutritionText, 'function');
  const s = clone(D.single.solutions[0]);
  const text = ui.variantNutritionText(s);
  assert.ok(text.includes('蛋白质 31g'));
  s.metrics.protein = null;
  s.metrics.nutritionEstimated = true;
  const partial = ui.variantNutritionText(s);
  assert.ok(partial.includes('蛋白质 暂缺'));
  assert.ok(partial.includes('估算'));
});
await test('同食品的规格别名不会重新占用推荐卡', () => {
  const sol = name => ({ items: [{ name, qty: 1, units: [{ qty: 1, config: [{ chosenName: name, chosenCode: 'F_M' }] }] }] });
  assert.equal(ui.groupByBasket([sol('中薯条'), sol('薯条中份')]).length, 1);
  assert.equal(ui.groupByBasket([sol('中薯条'), sol('大薯条')]).length, 2);
});
await test('套餐选配的独立规格字段在摘要中可区分', () => {
  const s = clone(D.single.solutions[0]);
  s.items[0].units[0].config = [{ chosenName: '可乐', specLabel: '中杯' }];
  const medium = ui.variantDesc(s);
  s.items[0].units[0].config[0].specLabel = '大杯';
  const large = ui.variantDesc(s);
  assert.notEqual(medium, large);
  assert.ok(medium.includes('中杯') && large.includes('大杯'));
});
await test('请求条件与示例不同必须拒绝，不得返回固定推荐', async () => {
  const r = await request('jobs/solve', { kcal: 1000, yuan: 50, constraints: [{ metric: 'staple', op: '>=', value: 3 }] });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'E_DEMO_SCENARIO');
});
await test('每个演示场景都保存生成它的输入，至少包含双主食及无解', () => {
  assert.ok(D.singleCases?.length >= 3);
  assert.ok(D.singleCases.some(c => c.input.constraints.some(x => x.metric === 'staple' && x.value === 2)));
  assert.ok(D.singleCases.some(c => !c.result.feasible));
  for (const c of D.singleCases) {
    for (const s of c.result.solutions) {
      assert.ok(s.finalPriceCents <= Math.round(c.input.yuan * 100));
      const minimum = c.input.constraints.find(x => x.metric === 'staple')?.value ?? 1;
      assert.ok(s.metrics.staple >= minimum);
    }
  }
});
await test('取消任务后持续轮询也是 E_CANCELLED，不会迟到成功', async () => {
  const input = D.singleCases?.[0].input ?? { storeCode: 'S-DEMO', kcal: 700, yuan: 32, objectives: ['protein'], constraints: [{ metric: 'staple', op: '>=', value: 1 }] };
  const created = await (await request('jobs/solve', input)).json();
  assert.ok(created.jobId);
  await request('jobs/' + created.jobId + '/cancel');
  for (let i = 0; i < 4; i++) {
    const st = await (await request('jobs/' + created.jobId, null, 'GET')).json();
    assert.equal(st.code, 'E_CANCELLED');
    assert.equal(st.cancelled, true);
    assert.equal(st.result, undefined);
  }
});
await test('静态页面的写操作不假装保存成功', async () => {
  const r = await request('recipes', { name: '测试配方' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'E_DEMO_READONLY');
});
await test('不认识的 API 明确返回 404', async () => {
  const r = await request('not-implemented', null, 'GET');
  assert.equal(r.status, 404);
});
await test('多人示例不能接受被改写的成员与心愿', async () => {
  const input = clone(D.groupInput);
  input.members[0].wishes = ['不存在的自定义心愿'];
  const r = await request('group-solve', input);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'E_DEMO_SCENARIO');
});
await test('McDNA 不能将真实订单请求替换成演示成功', async () => {
  const r = await request('mcdna', { demo: false, amountMode: 'tier' });
  assert.equal(r.status, 400);
});
await test('静态演示不假装接受 Agent 改稿', async () => {
  const r = await request('mcdna/render', { commentary: { title: '自定义文案' } });
  assert.equal(r.status, 403);
});
await test('每个预设都能通过同步和异步入口取得对应回执', async () => {
  for (const c of D.singleCases) {
    const sync = await request('solve', c.input);
    assert.equal(sync.status, 200);
    assert.deepEqual(await sync.json(), clone(c.result));
    const created = await (await request('jobs/solve', c.input)).json();
    let status;
    for (let i = 0; i < 3; i++) status = await (await request('jobs/' + created.jobId, null, 'GET')).json();
    assert.deepEqual(status.result, clone(c.result));
  }
});
await test('已生成的静态适配层与源码一致', () => {
  assert.equal(read('docs/demo/mock-fetch.js'), read('scripts/demo-template/mock-fetch.js'));
  assert.equal(read('docs/demo/demo.css'), read('scripts/demo-template/demo.css'));
});
await test('新旧资源不兼容时，API 仍然被阻断', async () => {
  let nativeCalls = 0;
  const stale = {
    window: { MCSMART_DEMO: { single: {}, group: {} }, fetch() { nativeCalls++; return Promise.resolve(new Response('{}')); },
      location: { href: 'https://example.test/project/demo/' }, addEventListener() {} },
    console: { error() {} }, Response, URL,
  };
  runInNewContext(read('scripts/demo-template/mock-fetch.js'), stale);
  const r = await stale.window.fetch('/api/recipes', { method: 'POST' });
  assert.equal(nativeCalls, 0);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, 'E_DEMO_DATA');
});
console.log(`静态 demo 契约：${checks - failures}/${checks} 通过`);
if (failures) process.exitCode = 1;
