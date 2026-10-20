// McDNA 确定性统计：只读官方订单；演示必须显式选择，失败绝不替换为演示。
import type { McpClient } from './mcp.js';
import { extractOrders, type ParsedOrder } from './orders.js';
import { parseNutritionTable, type NutritionRow } from './nutrition.js';
export type AmountMode = 'tier' | 'full';
export interface McdnaStats {
  demo: boolean;
  dataState: 'ready' | 'empty' | 'cold-start';
  orderCount: number;
  periodText: string;
  dateFiltered: boolean;
  datedOrderCount: number;
  itemsKnownOrderCount: number;
  totalSpendCents: number | null;
  avgTicketCents: number | null;
  knownAmountOrderCount: number;
  spendBasis: 'order-paid' | 'item-subtotal' | 'mixed' | 'unknown';
  spendNote: string;
  amountContract: 'demo' | 'adapter-unverified';
  savedCents: number | null;
  clock: Array<{ slot: string; label: string; count: number }>;
  weekdayThursdayCount: number;
  nightCount: number;
  purityRatio: number | null;
  purityItem: string;
  distinctItems: number | null;
  totalItemsQty: number;
  pfc: { protein: number; carb: number; fat: number } | null;
  pfcUnknownQty: number;
  pfcKnownQty: number;
  topItems: Array<{ name: string; count: number }>;
  /** 全部单品（归一名、份数、出现在多少个订单里），按份数降序；只在本机快照内使用。 */
  items: Array<{ name: string; qty: number; orders: number }>;
  /** 有时间的订单按星期分布，0=周日。 */
  weekdayCounts: number[];
  /** 甜品与明确含糖饮料的份数（无糖可乐不计）。 */
  sweetQty: number;
  coffeeOrderCount: number;
  /** 商品名含「随心配」的订单数；真实订单里的命名待验证。 */
  comboOrderCount: number;
  /** 单笔 ≥6 份的订单数（只看份数，不推断几个人吃）。 */
  bigOrderCount: number;
  /** 同一天下单 ≥2 次的天数。 */
  doubleDayCount: number;
  hero: { title: string; sect: string; blurb: string; purityTag: string };
  serial: string;
  amountMode: AmountMode;
}
const CLOCK = [
  { slot: 'morning', label: '清晨', from: 6, to: 10 },
  { slot: 'noon', label: '午间', from: 10, to: 14 },
  { slot: 'afternoon', label: '午后', from: 14, to: 17 },
  { slot: 'evening', label: '傍晚', from: 17, to: 21 },
  { slot: 'night', label: '深夜', from: 21, to: 30 },
];
// 只折叠**确认属于促销**的括注。糖型、杯型、规格、风味、份量是食品身份的一部分，必须保留：
//   v1.4.11 W07：旧实现先剥掉所有【】/（）再只给可乐补糖型 → 「可口可乐【无糖】」「【含糖】」
//   都变成「可乐」，5 单含糖/无糖各一份被合并成一种食品（甜食 0、纯度 100%、派别被污染）。
const PROMO_BRACKET = /[【\[（(]\s*(?:优惠|促销|特惠|限时|新品|热卖|推荐|活动|赠品|买一送一|第二份半价|会员价|专享)[^】\]）)]*[】\]）)]/g;
export function normalizeForStats(raw: string): string {
  let s = raw.replace(PROMO_BRACKET, '').replace(/\s+/g, '').replace(/\(/g, '（').replace(/\)/g, '）');
  // 可乐统一品牌名，但保留糖型/杯型/风味三个身份维度（顺序固定，便于与营养表同口径比较）。
  if (/可口可乐|可乐/.test(s)) {
    const sugar = /无糖|零度|零糖/.test(s) ? '无糖' : /含糖|有糖/.test(s) ? '含糖' : '';
    const size = /超大杯/.test(s) ? '超大杯' : /大杯/.test(s) ? '大杯' : /中杯/.test(s) ? '中杯' : /小杯/.test(s) ? '小杯' : '';
    const flavor = /麦炫酷/.test(s) ? '麦炫酷' : '';
    const rest = s.replace(/零度|无糖|零糖|含糖|有糖|可口可乐|可乐|超大杯|大杯|中杯|小杯|麦炫酷/g, '')
      .replace(/[（(]\s*[)）]/g, '').replace(/[【\[]\s*[】\]]/g, '');
    const parts = [sugar, size, flavor].filter(Boolean);
    s = (rest || '') + '可乐' + (parts.length ? `（${parts.join('·')}）` : '');
  }
  return s || raw.trim();
}
function isSweet(name: string): boolean {
  if (/无糖|零度|零糖/.test(name)) return /新地|麦旋风|圆筒|派$|冰淇淋|圣代/.test(name);
  // 无声明糖型的可乐等只算饮料，不能推断其甜食属性。
  return /新地|麦旋风|圆筒|派$|冰淇淋|冰激凌|圣代/.test(name) || /含糖|有糖/.test(name);
}
const COFFEE = /咖啡|美式|奶铁|拿铁|卡布奇诺|玛奇朵|浓缩|鲜萃|澳白|摩卡/;
const BIG_ORDER_QTY = 6;
function heroOf(s: Pick<McdnaStats, 'orderCount' | 'clock' | 'purityRatio' | 'purityItem' | 'datedOrderCount' | 'totalItemsQty'>, sweetQty: number): McdnaStats['hero'] {
  if (s.orderCount === 0) return { title: '这一页，等下一单', sect: '暂无订单', blurb: '官方账户暂时没有返回可用订单。这里留给真实记录，不替你编一张人设。', purityTag: '' };
  if (s.orderCount < 5) return { title: '麦门初号机 · 见习品鉴官', sect: '冷启动', blurb: `目前有 ${s.orderCount} 单真实记录。样本还少，先认个脸熟，不急着下结论。`, purityTag: '' };
  const top = [...s.clock].sort((a,b) => b.count-a.count);
  const dominant = top[0];
  const tied = dominant.count === top[1]?.count;
  let title = '麦门日常记录员', sect = '随心开饭', blurb = '点过的餐慢慢攒成了一页。喜欢什么，还是看你下次怎么点。';
  if (s.datedOrderCount >= 5 && !tied && dominant.count / s.datedOrderCount >= .4) {
    const people: Record<string, string> = { morning: '早餐开场官', noon: '午间开饭官', afternoon: '午后加餐派', evening: '晚餐主力场', night: '夜间开饭官' };
    title = people[dominant.slot]; sect = '饭点有自己的节奏';
    blurb = `${s.datedOrderCount} 单有时间记录，${dominant.label}有 ${dominant.count} 单。你的开饭时间，倒是挺有自己的安排。`;
  }
  if (s.purityRatio !== null && s.purityRatio >= .5) {
    sect = '熟面孔常驻'; blurb = '菜单的选择不少，熟悉的口味还是会被你翻到。';
  } else if (s.totalItemsQty > 0 && sweetQty / s.totalItemsQty >= .4) {
    sect = '甜品常客'; blurb = '这段记录里，甜品和明确含糖的饮料占了不少位置。';
  }
  return { title, sect, blurb, purityTag: s.purityRatio !== null && s.purityRatio >= .7 ? `常点占比 ${Math.round(s.purityRatio*100)}% · 按份数` : '' };
}
export async function fetchMcdnaStats(client: McpClient | null, opts: { demo?: boolean; amountMode?: AmountMode } = {}): Promise<McdnaStats> {
  const amountMode = opts.amountMode ?? 'tier';
  if (opts.demo === true) return demoMcdna(amountMode);
  if (!client) throw new Error('HTTP 401：尚未配置自己的麦当劳 MCP 账户');
  // order-list 失败直接向上层传递；没有隐式演示路径。
  const response = await client.call('order-list', {});
  const orders = extractOrders(response.data);
  let table: Map<string, NutritionRow> | null = null;
  if (orders.some(o => o.items.length)) {
    try { table = parseNutritionTable((await client.call('list-nutrition-foods', {})).rawText); } catch { /* 营养可独立降级 */ }
  }
  return aggregateMcdna(orders, { demo: false, amountMode, table });
}
export function aggregateMcdna(orders: ParsedOrder[], opt: { demo: boolean; amountMode: AmountMode; table: Map<string, NutritionRow> | null }): McdnaStats {
  const clock = CLOCK.map(x => ({ slot: x.slot, label: x.label, count: 0 }));
  const counter = new Map<string, number>();
  const orderHits = new Map<string, number>();
  const weekday = [0, 0, 0, 0, 0, 0, 0];
  const perDay = new Map<string, number>();
  let coffeeOrders = 0, comboOrders = 0, bigOrders = 0;
  const basis = new Set<string>();
  let spend = 0, known = 0, dated = 0, itemsKnown = 0, thursday = 0, sweet = 0, totalQty = 0;
  let p = 0, c = 0, f = 0, pfcKnown = 0, pfcUnknown = 0;
  const times: number[] = [];
  // 营养只认保留规格/糖型的归一全名一致；不用包含式匹配。
  const nutrition = new Map<string, NutritionRow[]>();
  for (const row of opt.table?.values() ?? []) {
    const key = normalizeForStats(row.productName);
    nutrition.set(key, [...(nutrition.get(key) ?? []), row]);
  }
  for (const o of orders) {
    if (o.itemsKnown) itemsKnown++;
    if (o.ts !== null) {
      const d = new Date(o.ts + 8 * 3600000);
      const hour = d.getUTCHours(); const h = hour < 6 ? hour + 24 : hour;
      clock[CLOCK.findIndex(x => h >= x.from && h < x.to)].count++;
      dated++; times.push(o.ts); if (d.getUTCDay() === 4) thursday++;
      weekday[d.getUTCDay()]++;
      const day = d.toISOString().slice(0, 10); perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    let value: number | null = null;
    if (o.moneyBasis === 'order-paid' && o.paidCents !== null) {
      value = o.paidCents - (o.refundCents ?? 0);
      if (value < 0) value = null;
    } else if (o.moneyBasis === 'item-subtotal') {
      value = o.items.reduce((sum, it) => sum + (it.subtotalCents ?? 0), 0);
      // 已有退款但没有订单实付契约时，不把食品标价减退款冒充实付。
      if (o.refundCents !== null && o.refundCents > 0) value = null;
    }
    if (value !== null && Number.isSafeInteger(value)) { known++; spend += value; basis.add(o.moneyBasis); }
    const seen = new Set<string>();
    let orderQty = 0;
    for (const it of o.items) {
      const name = normalizeForStats(it.name);
      totalQty += it.qty; counter.set(name, (counter.get(name) ?? 0) + it.qty);
      orderQty += it.qty;
      if (!seen.has(name)) { seen.add(name); orderHits.set(name, (orderHits.get(name) ?? 0) + 1); }
      if (isSweet(name)) sweet += it.qty;
      const matches = nutrition.get(name) ?? [];
      const row = matches.length === 1 ? matches[0] : opt.table?.get(it.name);
      if (row && [row.protein, row.carbohydrate, row.fat].every(n => Number.isFinite(n) && n >= 0)) {
        p += row.protein * it.qty; c += row.carbohydrate * it.qty; f += row.fat * it.qty; pfcKnown += it.qty;
      } else pfcUnknown += it.qty;
    }
    if ([...seen].some(n => COFFEE.test(n))) coffeeOrders++;
    if ([...seen].some(n => /随心配/.test(n))) comboOrders++;
    if (o.itemsKnown && orderQty >= BIG_ORDER_QTY) bigOrders++;
  }
  const orderCount = orders.length;
  const topItems = [...counter].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,3).map(([name,count]) => ({name,count}));
  const items = [...counter].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).map(([name,qty]) => ({ name, qty, orders: orderHits.get(name) ?? 0 }));
  const energy = p*4+c*4+f*9;
  const completeMoney = known === orderCount && orderCount > 0 && Number.isSafeInteger(spend);
  const spendBasis = !completeMoney ? 'unknown' : basis.size > 1 ? 'mixed' : basis.has('order-paid') ? 'order-paid' : 'item-subtotal';
  const purityRatio = totalQty > 0 && itemsKnown === orderCount ? (topItems[0]?.count ?? 0)/totalQty : null;
  const base = { orderCount, clock, purityRatio, purityItem: topItems[0]?.name ?? '', datedOrderCount: dated, totalItemsQty: totalQty };
  return {
    ...base, demo: opt.demo, dataState: orderCount === 0 ? 'empty' : orderCount < 5 ? 'cold-start' : 'ready',
    periodText: times.length ? `${dateText(Math.min(...times))} — ${dateText(Math.max(...times))}${dated<orderCount?' · 时间不全':''}` : orderCount ? '订单区间未取得' : '暂无订单',
    dateFiltered: dated === orderCount && dated > 0, itemsKnownOrderCount: itemsKnown,
    totalSpendCents: completeMoney ? spend : null, avgTicketCents: completeMoney ? Math.round(spend/orderCount) : null,
    knownAmountOrderCount: known, spendBasis,
    spendNote: spendBasis === 'order-paid' ? '实付减已声明退款' : spendBasis === 'item-subtotal' ? '食品小计，非订单实付' : spendBasis === 'mixed' ? '实付与食品小计混合' : '金额字段缺失或未支持',
    amountContract: opt.demo ? 'demo' : 'adapter-unverified', savedCents: null,
    weekdayThursdayCount: thursday, nightCount: clock[4].count,
    distinctItems: itemsKnown === orderCount ? counter.size : null,
    pfc: energy > 0 ? {protein:p*4/energy,carb:c*4/energy,fat:f*9/energy} : null,
    pfcUnknownQty: pfcUnknown, pfcKnownQty: pfcKnown,
    topItems, hero: heroOf(base, sweet), serial: serialOf(orderCount,topItems), amountMode: opt.amountMode,
    items, weekdayCounts: weekday, sweetQty: sweet, coffeeOrderCount: coffeeOrders, comboOrderCount: comboOrders,
    bigOrderCount: bigOrders, doubleDayCount: [...perDay.values()].filter(n => n >= 2).length,
  };
}
function dateText(ts: number): string { return new Date(ts+8*3600000).toISOString().slice(0,10).replace(/-/g,'.'); }
function serialOf(count: number,top: McdnaStats['topItems']): string {
  let h=2166136261; for(const c of JSON.stringify([count,top])) {h^=c.charCodeAt(0);h=Math.imul(h,16777619);}
  return `McDNA-${(h>>>0).toString(16).toUpperCase().padStart(8,'0').slice(0,6)}`;
}
export function demoMcdna(amountMode: AmountMode): McdnaStats {
  // 演示样本刻意不用板烧：本命是麦辣鸡腿堡，另有巨无霸等其他汉堡，检验限定词随数据变化。
  const names=['麦辣鸡腿堡','可乐（无糖）中杯','中薯条','巨无霸','香芋派','吉士蛋麦满分','麦乐鸡5块','奥利奥麦旋风','美式咖啡中杯'];
  const orders: ParsedOrder[] = Array.from({length:14},(_,i) => ({
    ts: Date.parse(`2026-10-${String(i+1).padStart(2,'0')}T${String([8,12,12,12,12,12,15,15,15,18,22,22,22,22][i]).padStart(2,'0')}:00:00+08:00`),
    itemsKnown:true, paidCents:i===13?3860:3000,refundCents:null,moneyBasis:'order-paid',
    items: [{name:i<11?names[0]:names[i-10],qty:i<11?2:1,subtotalCents:null}, {name:names[1+i%8],qty:1,subtotalCents:null}],
  }));
  const table = new Map(names.slice(0,7).map((name,i) => [name,{productName:name,energyKj:1200,energyKcal:300,protein:i?8:16,carbohydrate:24,fat:12,sodium:0,calcium:0}]));
  const result=aggregateMcdna(orders,{demo:true,amountMode,table});
  return {...result,periodText:'演示样本 · 2026.10.01 — 2026.10.14',savedCents:9640,spendNote:'演示金额，非个人记录',serial:'McDNA-DEMO01'};
}

// ---------- SVG（680×440，GitHub Dark #0D1117，黑金红；PRD §3.4） ----------

const GOLD = '#FFC72C';
const RED = '#E63946';
const RED_SOFT = '#3A1B1E';
const INK = '#E6EDF3';
const MUTED = '#8B949E';
const CARD = '#161B22';
const LINE = '#30363D';
const FONT = 'font-family="-apple-system,Segoe UI,sans-serif"';

export function buildMcdnaSvg(s: McdnaStats): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const amount = (cents: number | null): string =>
    cents === null ? "待接入" :
    s.amountMode === 'full' ? `¥${(cents / 100).toFixed(2)}` : '¥'.repeat(Math.min(5, Math.floor(cents / 2000) + 1));

  // 左列：三数据卡（y 134/200/266，h58）+ PFC（y 348 起）
  const statCard = (y: number, value: string, label: string, valueFill = INK) =>
    `<rect x="40" y="${y}" width="290" height="58" rx="10" fill="${CARD}" stroke="${LINE}" stroke-width="0.8"/>` +
    `<text x="70" y="${y + 36}" ${FONT} font-size="20" font-weight="600" fill="${valueFill}">${value}</text>` +
    `<text x="303" y="${y + 35}" text-anchor="end" ${FONT} font-size="11" fill="${MUTED}">${label}</text>`;

  // 右列：生物钟 5 条（x 350-640，y 158 起，行距 19）
  const maxClock = Math.max(1, ...s.clock.map((c) => c.count));
  const clockRows = s.clock.map((c, i) => {
    const y = 158 + i * 19;
    const w = (c.count / maxClock) * 190;
    const hot = c.slot === 'night' ? RED : GOLD;
    return `<text x="350" y="${y + 9}" ${FONT} font-size="10.5" fill="${MUTED}">${c.label}</text>` +
      `<rect x="384" y="${y}" width="${Math.max(2, w)}" height="11" rx="2.5" fill="${c.count > 0 ? hot : LINE}"/>` +
      `<text x="640" y="${y + 9}" text-anchor="end" ${FONT} font-size="10.5" fill="${INK}">${c.count}</text>`;
  }).join('');

  // 右列：Top3 领奖台（底 y=400；1-2-3 顺排——冠军最左金色，阅读顺序与名次一致）
  const podium = s.topItems.map((t, i) => {
    const h = [54, 40, 30][i];
    const x = [380, 455, 530][i];
    const y = 400 - h;
    const fill = i === 0 ? GOLD : i === 1 ? RED_SOFT : CARD;
    const cntFill = i === 0 ? '#1F1400' : MUTED;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
    return `<rect x="${x}" y="${y}" width="62" height="${h}" rx="4" fill="${fill}" stroke="${LINE}" stroke-width="0.8"/>` +
      `<text x="${x + 31}" y="${y - 5}" text-anchor="middle" ${FONT} font-size="10" fill="${INK}">${medal} ${esc(t.name.length > 7 ? t.name.slice(0, 7) + '…' : t.name)}</text>` +
      `<text x="${x + 31}" y="${y + h - 6}" text-anchor="middle" ${FONT} font-size="9.5" fill="${cntFill}">×${t.count}</text>`;
  }).join('');

  // PFC 比例条（左列 y 358，宽 290）
  const pfcRow = s.pfc
    ? (() => {
      const pw = s.pfc.protein * 290, cw = s.pfc.carb * 290, fw = s.pfc.fat * 290;
      return `<rect x="40" y="358" width="${pw}" height="13" rx="3" fill="${GOLD}"/>` +
        `<rect x="${40 + pw}" y="358" width="${cw}" height="13" fill="#C98A1B"/>` +
        `<rect x="${40 + pw + cw}" y="358" width="${Math.max(2, fw)}" height="13" rx="3" fill="${RED}"/>` +
        `<text x="330" y="386" text-anchor="end" ${FONT} font-size="10" fill="${MUTED}">蛋白 ${Math.round(s.pfc.protein * 100)}% · 碳水 ${Math.round(s.pfc.carb * 100)}% · 脂肪 ${Math.round(s.pfc.fat * 100)}%</text>`;
    })()
    : `<text x="40" y="386" ${FONT} font-size="10" fill="${MUTED}">营养覆盖不足（未收录 ${s.pfcUnknownQty} 份），PFC 画像降级</text>`;

  const sectBadgeW = s.hero.sect.length * 13 + 20;
  const titleW = Math.min(s.hero.title.length * 26, 380);

  return `<svg width="100%" viewBox="0 0 680 440" xmlns="http://www.w3.org/2000/svg" role="img">
<title>McDNA 麦门人格图谱${s.demo ? '（演示数据）' : ''}</title>
<rect width="680" height="440" rx="16" fill="#0D1117"/>
<rect x="0.5" y="0.5" width="679" height="439" rx="15.5" fill="none" stroke="${LINE}"/>
<rect x="40" y="20" width="112" height="22" rx="11" fill="${RED}"/>
<text x="96" y="35" text-anchor="middle" ${FONT} font-size="11" font-weight="600" fill="#FFFFFF">McDNA 认证</text>
<text x="164" y="35" ${FONT} font-size="10.5" fill="${MUTED}">${esc(s.serial)} · ${esc(s.periodText)}</text>
<text x="640" y="35" text-anchor="end" ${FONT} font-size="10.5" fill="${MUTED}">${s.demo ? '演示数据' : '真实订单'}</text>

<text x="40" y="94" ${FONT} font-size="25" font-weight="700" fill="${GOLD}">${esc(s.hero.title)}</text>
<rect x="${Math.min(40 + titleW + 14, 520)}" y="72" width="${sectBadgeW}" height="21" rx="10.5" fill="${RED_SOFT}" stroke="${RED}" stroke-width="0.8"/>
<text x="${Math.min(40 + titleW + 14, 520) + 10}" y="87" ${FONT} font-size="11" fill="${RED}">${esc(s.hero.sect)}</text>
${s.hero.purityTag ? `<text x="640" y="87" text-anchor="end" ${FONT} font-size="12" font-weight="600" fill="${GOLD}">${esc(s.hero.purityTag)}</text>` : ''}
<text x="40" y="118" ${FONT} font-size="11" fill="${MUTED}">${esc(s.hero.blurb.length > 52 ? s.hero.blurb.slice(0, 52) + '…' : s.hero.blurb)}</text>

${statCard(134, String(s.orderCount), '打卡次数')}
${statCard(200, esc(amount(s.totalSpendCents)) + (s.amountMode === 'tier' ? `<tspan font-size="10" fill="${MUTED}"> 档位</tspan>` : ''), s.amountMode === 'tier' ? '累计消费·已脱敏' : '累计消费')}
${statCard(266, s.savedCents !== null ? esc(amount(s.savedCents)) : '待接入', s.savedCents !== null ? '羊毛战绩' : '羊毛战绩·字段待接入', GOLD)}

<text x="350" y="146" ${FONT} font-size="12" font-weight="600" fill="${INK}">饮食生物钟</text>
${clockRows}
<text x="350" y="272" ${FONT} font-size="10.5" fill="${MUTED}">周四执剑 ×${s.weekdayThursdayCount} · 深夜 ×${s.nightCount} · 品项 ${s.distinctItems} 种</text>

<text x="350" y="300" ${FONT} font-size="12" font-weight="600" fill="${INK}">复购领奖台 Top3</text>
${podium}

<text x="40" y="348" ${FONT} font-size="12" font-weight="600" fill="${INK}">PFC 供能比</text>
${pfcRow}
<text x="40" y="403" ${FONT} font-size="9.5" fill="${MUTED}">已收录 ${s.pfcKnownQty}/${s.totalItemsQty} 份；未收录 ${s.pfcUnknownQty} 份</text>

<text x="40" y="428" ${FONT} font-size="9.5" fill="#57606A">麦当劳官方 MCP 订单驱动 · 金额${s.amountMode === 'tier' ? '已档位化脱敏' : '完整显示'} · 不构成营养或医疗建议</text>
</svg>`;
}
