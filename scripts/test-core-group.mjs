// 本体多人链路：粘贴数量→真实购买、硬需求匹配、分账整数分守恒。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'mcsmart-core-group-'));
process.env.MCSMART_HOME = home;
process.env.MCSMART_DISABLE_BUNDLED_UNION = '1';
for (const key of ['MCD_MCP_TOKEN', 'MEITUAN_UNION_APPKEY', 'MEITUAN_UNION_APPSECRET', 'MEITUAN_UNION_SID']) delete process.env[key];
globalThis.fetch = () => { throw new Error('多人回归禁止业务联网'); };
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
const { parseWishPhrase, parseGroupText } = await import('../dist/group.js');
const { solveGroupWithKernel } = await import('../dist/groupKernel.js');
const { CONFIG } = await import('../dist/config.js');
CONFIG.topK = 1;
const member = (alias, wishes, extra = {}) => ({ alias, wishes, taboos: [], ...extra });
let checks = 0, failures = 0;
async function test(label, run) {
  checks++;
  try { await run(); console.log('✓ ' + label); }
  catch (e) { failures++; console.error('✗ ' + label + ': ' + e.message); }
}
function clientOf(entries, rounds = {}, quote) {
  return { async call(tool, args = {}) {
    if (tool === 'query-meals') return { data: { meals: Object.fromEntries(entries.map(e => [e.code, { name: e.name, currentPrice: String(e.price / 100) }])),
      categories: [{ name: '单品', meals: entries.filter(e => !e.combo).map(e => ({ code: e.code })) },
        { name: '套餐', meals: entries.filter(e => e.combo).map(e => ({ code: e.code, tags: ['套餐'] })) }] } };
    if (tool === 'list-nutrition-foods') return { rawText: entries.filter(e => !e.combo).map(e => `  ${e.name},null,1000,250,10,10,30,100,0`).join('\n') };
    if (tool === 'query-meal-detail') return { data: { rounds: rounds[args.code] || [] } };
    if (tool === 'calculate-price') return { data: { price: quote ? quote(args) : args.items.reduce((s, i) => s + entries.find(e => e.code === i.productCode).price * i.quantity, 0), discount: 0 } };
    throw new Error('离线夹具不支持 ' + tool);
  } };
}
await test('粘贴保留两份五块装，实际购买两份且全覆盖', async () => {
  const parsed = parseGroupText('甲：两份五块麦乐鸡');
  const spec = parseWishPhrase(parsed.members[0].wishes[0]);
  assert.equal(spec.qty, 2);
  assert.ok(spec.specNote.includes('5'));
  const r = await solveGroupWithKernel(clientOf([{ code: 'N', name: '麦乐鸡', price: 1000 }]), { storeCode: 'CORE-QTY-PASTE', members: parsed.members });
  assert.equal(r.solution.basket.reduce((s, b) => s + b.qty, 0), 2);
  assert.equal(r.solution.totals.paidCents, 2000);
  assert.deepEqual(r.solution.coverage, { total: 1, met: 1 });
});
await test('粘贴保留只要限定词，不把恰好需求降成至少', () => {
  const parsed = parseGroupText('甲：只要两份麦乐鸡');
  const spec = parseWishPhrase(parsed.members[0].wishes[0]);
  assert.equal(spec.exact, true);
  assert.equal(spec.qty, 2);
});
await test('限定词不污染套餐或饮料类目匹配主体', () => {
  assert.equal(parseWishPhrase('只要一份巨无霸套餐').keyword, '巨无霸');
  assert.equal(parseWishPhrase('一定要一份巨无霸套餐').keyword, '巨无霸');
  assert.equal(parseWishPhrase('恰好两杯饮料').category, 'drink');
  assert.equal(parseWishPhrase('一定要一杯饮料').category, 'drink');
});
await test('只要/一定要合法套餐仍选择含换选差价后的便宜方案', async () => {
  const rounds = diff => [{ id: 1, name: '主食', choices: [{ code: 'B', name: '巨无霸', isDefault: 1, diffPrice: '+0' }] },
    { id: 2, name: '饮料', choices: [{ code: 'D', name: '可乐中杯', isDefault: 1, diffPrice: '+0' }, { code: 'Z', name: '无糖可口可乐中杯', isDefault: 0, diffPrice: '+' + diff }] }];
  const entries = [{ code: 'LC', name: '巨无霸套餐', price: 2000, combo: true }, { code: 'HC', name: '巨无霸套餐', price: 2500, combo: true }];
  for (const [i, phrase] of ['一份巨无霸套餐', '只要一份巨无霸套餐', '一定要一份巨无霸套餐'].entries()) {
    const client = clientOf(entries, { LC: rounds(15), HC: rounds(0) }, args => args.items.reduce((s, it) => s + (it.productCode === 'LC' ? 3500 : 2500) * it.quantity, 0));
    const r = await solveGroupWithKernel(client, { storeCode: 'CORE-COMBO-' + i, members: [member('甲', [phrase], { sugarFree: true }), member('乙', ['随意'])] });
    assert.equal(r.bundle.totals.paidCents, 2500, phrase);
    assert.ok(r.bundle.basket.some(b => b.code === 'HC'));
  }
});
await test('负尾差不落成负份额或破坏总额，无食品成员保持零份额', async () => {
  const client = clientOf([{ code: 'A', name: '巨无霸', price: 1000 }, { code: 'B', name: '麦辣鸡腿堡', price: 1000 }], {}, () => 1999);
  const r = await solveGroupWithKernel(client, { storeCode: 'CORE-ROUNDING', members: [member('甲', ['巨无霸']), member('乙', ['麦辣鸡腿堡']), member('丙', ['未上市审查食品'])] });
  const s = r.solution;
  assert.equal(s.totals.paidCents, 1999);
  assert.equal(s.members.reduce((n, m) => n + m.shareCents, 0), 1999);
  assert.equal(s.members.reduce((n, m) => n + m.payableCents, 0), 1999);
  assert.ok(s.members.every(m => Number.isInteger(m.shareCents) && m.shareCents >= 0));
  assert.equal(s.members[2].shareCents, 0);
});
console.log(`本体多人回归：${checks - failures}/${checks} 通过`);
if (failures) process.exitCode = 1;
