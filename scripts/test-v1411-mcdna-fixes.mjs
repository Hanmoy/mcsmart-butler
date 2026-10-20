// v1.4.11 战报统计可信度回归（W07/W10/W11/W12/W13/W14）
// 全部为构造订单，不读取真实用户订单；营养表为测试输入。
//   W07 食品身份归一：糖型/杯型/风味保留，不折叠成同一食品
//   W10 文案占位符：下划线与连字符编号都必须拒绝（代入后仍残留即拒）
//   W11 糖型/杯型声明：没点过无糖不得写「无糖」
//   W12 明细不全：占比未知不得当作 0 通过「低于 35%」分支切成类别词
//   W13 进度条：未达 50% 门槛不得满格
//   W14 营养明细不全：PFC 供能比不展示并给出警告
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcsmart-v1411-mcdna-'));
process.env.MCSMART_HOME = home;

const { extractOrders } = await import('../dist/orders.js');
const { aggregateMcdna, normalizeForStats } = await import('../dist/mcdna.js');
const { personaOf, checkCopy } = await import('../dist/mcdnaPersona.js');
const { createMcdnaSnapshot, renderMcdnaReport } = await import('../dist/mcdnaReport.js');

let checks = 0;
const check = (value, note) => { assert.ok(value, note); checks++; };
const eq = (actual, expected, note) => {
  assert.deepEqual(actual, expected, `${note}（实得 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
  checks++;
};
const agg = (list, table = null) => aggregateMcdna(extractOrders(list), { demo: false, amountMode: 'tier', table });

try {
  // ---------- W07：糖型是两种食品 ----------
  {
    const orders = Array.from({ length: 5 }, (_, i) => ({
      createTime: `2026-10-${String(i + 1).padStart(2, '0')} 12:10:00`,
      items: [{ name: '可口可乐【无糖】', quantity: 1 }, { name: '可口可乐【含糖】', quantity: 1 }],
    }));
    const s = agg(orders);
    eq(s.distinctItems, 2, 'W07 含糖/无糖是两种食品');
    eq(s.items.map(i => i.name).sort(), ['可乐（含糖）', '可乐（无糖）'], 'W07 归一后保留糖型');
    eq(s.sweetQty, 5, 'W07 只有含糖那 5 份计入甜食');
    eq(s.purityRatio, 0.5, 'W07 纯度按半份计');
    eq(s.topItems[0].count, 5, 'W07 本命单品不把两种可乐合并成 10 份');
    check(normalizeForStats('可口可乐【无糖】') !== normalizeForStats('可口可乐【含糖】'), 'W07 归一函数不合并糖型');
    check(normalizeForStats('可口可乐中杯') !== normalizeForStats('可口可乐大杯'), 'W07 归一函数不合并杯型');
    check(!/[【】]/.test(normalizeForStats('可口可乐【无糖】')), 'W07 归一后不留空括号');
  }

  // ---------- W10/W11：文案守门 ----------
  {
    const s = agg(Array.from({ length: 5 }, (_, i) => ({
      createTime: `2026-10-0${i + 1} 12:10:00`,
      items: [{ name: '可口可乐（含糖）中杯', quantity: 2 }, { name: '巨无霸', quantity: 1 }],
    })));
    const p = personaOf(s);
    const issues = (copy) => checkCopy(copy, p, s, () => true).issues;
    const base = { title: '本命×{topCount}', verdict: '菜单翻遍还是{topShort}', achievements: ['本命打卡×{topCount}'], dialogue: '{topName}出现了{topCount}份。别人点餐靠选，你点餐靠认。', hook: '你的本命是哪一样？' };
    const underscore = issues({ ...base, title: '本命×{top_count}' });
    check(underscore.some(x => /占位符|不存在的事实/.test(x)), 'W10 下划线编号必须被拒');
    const dash = issues({ ...base, title: '本命×{top-count}' });
    check(dash.some(x => /占位符|不存在的事实/.test(x)), 'W10 连字符编号必须被拒');
    const ok = issues(base);
    check(ok.length === 0, `W10 合法占位符应通过（实得 ${JSON.stringify(ok)}）`);

    const sugar = issues({
      title: '无糖可乐常客', verdict: '只喝无糖那杯', achievements: ['本命打卡×{topCount}'],
      dialogue: '无糖可乐常客，点餐很稳定，从不换口味。', hook: '你也喝无糖？',
    });
    check(sugar.some(x => /「无糖」/.test(x)), 'W11 没点过无糖不得写「无糖」');
    check(sugar.filter(x => /「无糖」/.test(x)).length >= 3, 'W11 称号/判词/评语/钩子逐处拦截');
  }

  // ---------- W12：未知占比不得当作 0 通过「低于 35%」分支 ----------
  {
    // 报告反例：5 单仅 4 单明细已知，巨无霸 9 份、麦香鸡 1 份
    const partial = [
      { createTime: '2026-10-01 12:10:00', items: [{ name: '巨无霸', quantity: 3 }, { name: '麦香鸡', quantity: 1 }] },
      ...Array.from({ length: 3 }, (_, i) => ({ createTime: `2026-10-0${i + 2} 12:10:00`, items: [{ name: '巨无霸', quantity: 2 }] })),
      { createTime: '2026-10-05 12:10:00' },
    ];
    const s = agg(partial);
    eq([s.itemsKnownOrderCount, s.orderCount], [4, 5], 'W12 夹具是 4/5 单有明细');
    eq(s.distinctItems, null, 'W12 明细不全时不同餐品种数未知');
    const p = personaOf(s);
    eq(p.qualifier.level, 'item', 'W12 占比未知不得切到类别词「汉堡」');
    eq(p.qualifier.word, '巨无霸', 'W12 限定词仍是已知最多的单品');
    check(p.facts.topPct === undefined, 'W12 占比未知时不输出百分比事实');

    // 完整对照：同样的明细补齐第 5 单，仍用「巨无霸」
    const full = agg(partial.map((o, i) => (i === 4 ? { ...o, items: [{ name: '巨无霸', quantity: 1 }] } : o)));
    const pf = personaOf(full);
    eq(pf.qualifier.level, 'item', 'W12 完整 90% 样本仍是单品限定词');
    eq(pf.qualifier.word, '巨无霸', 'W12 完整样本限定词是巨无霸');
    eq(pf.facts.topPct, 91, 'W12 完整样本给出真实占比（10/11）');

    // 完整且真实分散、同类别过半 → 仍能切类别词
    const spread = agg(['巨无霸', '麦辣鸡腿堡', '板烧鸡腿堡', '麦香鱼'].map((name, i) => ({
      createTime: `2026-10-0${i + 1} 12:10:00`, items: [{ name, quantity: 1 }],
    })));
    const ps = personaOf(spread);
    eq(ps.qualifier.level, 'category', 'W12 完整且分散时切类别词');
    eq(ps.qualifier.word, '汉堡', 'W12 类别词是「汉堡」');
  }

  // ---------- W13：未达门槛的进度条不满格 ----------
  {
    const s = agg(Array.from({ length: 5 }, () => ({
      items: ['巨无霸', '麦香鸡', '中薯条', '麦乐鸡', '玉米杯'].map(name => ({ name, quantity: 1 })),
    })));
    const p = personaOf(s);
    eq(p.sect, 'solo', 'W13 五派都未达标时取最接近的一派');
    eq(p.weak, true, 'W13 未达门槛必须标注 weak');
    eq(p.bar.max, false, 'W13 20% 不得满格');
    eq(p.bar.ratio, 0.2, 'W13 进度条用真实占比');
    eq(p.bar.value, '20%', 'W13 进度条显示真实百分比');
    check(/未达 50% 门槛/.test(p.bar.caption), 'W13 文案说明未达门槛');
    check(/未达门槛/.test(p.why), 'W13 判词说明是"最接近"而非"达标"');
  }

  // ---------- W14：明细不足不展示 PFC ----------
  {
    const table = new Map([['巨无霸', { productName: '巨无霸', energyKcal: 500, protein: 25, fat: 20, carbohydrate: 40, sodium: 900 }]]);
    const s = agg([
      { createTime: '2026-10-01 12:00:00', items: [{ name: '巨无霸', quantity: 1 }] },
      ...Array.from({ length: 4 }, (_, i) => ({ createTime: `2026-10-0${i + 2} 12:00:00` })),
    ], table);
    eq([s.itemsKnownOrderCount, s.orderCount], [1, 5], 'W14 夹具是 1/5 单有明细');
    const rep = await renderMcdnaReport(createMcdnaSnapshot(s), {});
    eq(rep.stats.pfc, null, 'W14 局部样本不展示 PFC 供能比');
    check(rep.warnings.some(w => /PFC 供能比不展示/.test(w)), 'W14 给出不展示的原因');
    check(rep.warnings.some(w => /食品明细不完整/.test(w)), 'W14 说明明细不完整');
    check(!/供能比/.test(rep.frontSvg), 'W14 卡面不得出现供能比结论');
  }

  console.log(`v1.4.11 战报统计可信度：${checks}项断言通过（构造订单；W07/W10/W11/W12/W13/W14）`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
