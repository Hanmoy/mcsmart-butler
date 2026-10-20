// McDNA v6 人设层：程序决定派、身份、场景、主角、限定词与全部事实；
// 称号/判词/成就/评语/钩子是文字槽位，由当前 Agent 填写，或回退内置梗库。数字只经占位符由程序印出。
import type { McdnaStats } from './mcdna.js';

export type Body = 'burger' | 'muffin' | 'nugget' | 'fries' | 'cup' | 'coffee' | 'cone' | 'pie';
export type SectId = 'solo' | 'night' | 'morning' | 'dex' | 'sweet' | 'punctual' | 'combo' | 'rookie';
export type SceneId = 'counter' | 'night' | 'morning' | 'feast';
export type Pose = 'proud' | 'sleepy' | 'sprint';
export type FactValue = string | number;

export const SECTS: Record<SectId, { name: string; rule: string; prop: string }> = {
  solo: { name: '单推派', rule: '入门只需一样本命，终身不换', prop: 'lightstick' },
  night: { name: '夜巡派', rule: '麦门的灯不灭，本派不散会', prop: 'lantern' },
  morning: { name: '早课派', rule: '天亮第一单，本派早课签到', prop: 'clock' },
  dex: { name: '图鉴派', rule: '菜单不是用来点的，是用来通关的', prop: 'book' },
  sweet: { name: '甜区派', rule: '正餐是前菜，甜品才是主线', prop: 'spoon' },
  punctual: { name: '准点派', rule: '开饭时间比闹钟准', prop: 'watch' },
  combo: { name: '随心派', rule: '一加一是本派基本法', prop: 'dice' },
  rookie: { name: '见习派', rule: '三单入门，五单开光', prop: 'flag' },
};
export const SCENES: Record<SceneId, { name: string; pose: Pose }> = {
  counter: { name: '点餐柜台', pose: 'proud' },
  night: { name: '深夜窗边', pose: 'sleepy' },
  morning: { name: '清晨早餐', pose: 'sprint' },
  feast: { name: '满桌开席', pose: 'proud' },
};
export const BODIES: Body[] = ['burger', 'muffin', 'nugget', 'fries', 'cup', 'coffee', 'cone', 'pie'];
const TIE_ORDER: Body[] = ['burger', 'muffin', 'nugget', 'fries', 'cone', 'pie', 'coffee', 'cup'];
/** 背包与本命共用的排序：份数降序；并列时食物在前、饮料最后（并列的「可乐」不该压过汉堡当主角）。 */
export function sortItems<T extends { name: string; qty: number }>(items: T[]): T[] {
  const rank = (n: string) => { const b = bodyOf(n); return b ? TIE_ORDER.indexOf(b) : TIE_ORDER.length; };
  return [...items].sort((a, b) => b.qty - a.qty || rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
export const PROPS = Object.values(SECTS).map(s => s.prop);
export const SLOT_LABELS = ['清晨', '午间', '午后', '傍晚', '深夜'];
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ---------- 食品：类别（选身体）、图标、简称 ----------
// 顺序有意义：咖啡/甜品/早餐先于汉堡与炸鸡判定（如「麦辣鸡腿堡」是汉堡，不是炸鸡）。
const BODY_RULES: Array<[Body, RegExp]> = [
  ['coffee', /咖啡|美式|奶铁|拿铁|卡布奇诺|玛奇朵|浓缩|鲜萃|澳白|摩卡|McCaf/i],
  ['cone', /麦旋风|新地|圆筒|甜筒|冰淇淋|冰激凌|圣代|雪冰|奶昔|阿芙佳朵/],
  ['pie', /派$|派（|派派|蛋挞|挞$/],
  ['muffin', /麦满分|营养卷|粥|油条|双蛋堡|早餐/],
  ['burger', /堡|巨无霸|麦香鸡|麦香鱼|不素之霸|汉堡|鸡肉卷|卷$/],
  ['nugget', /麦乐鸡|鸡块|鸡翅|V翅|脆汁鸡|鸡排|鸡球|里脊|炸鸡|鸡腿|鸡米花/],
  ['fries', /薯条|薯饼|扭扭薯|芝士条|玉米杯|苹果片|小食|洋葱圈/],
  ['cup', /可乐|雪碧|芬达|红茶|果汁|豆浆|牛奶|燕麦奶|黑巧|抹茶|麦炫酷|柠|橙|饮|茶|纯悦|水$/],
];
export function bodyOf(name: string): Body | null {
  for (const [b, re] of BODY_RULES) if (re.test(name)) return b;
  return null;
}
const ICON_RULES: Array<[string, RegExp]> = [
  ['fish', /鱼/], ['muffin', /麦满分|双蛋堡|营养卷/], ['burger', /堡|巨无霸|麦香鸡|不素之霸/], ['wrap', /卷/],
  ['wings', /鸡翅|V翅/], ['drumstick', /脆汁鸡|鸡腿$|里脊|鸡排/], ['nugget', /麦乐鸡|鸡块|鸡球|炸鸡/],
  ['hashbrown', /薯饼/], ['fries', /薯条|扭扭薯|芝士条/], ['corn', /玉米/], ['porridge', /粥/],
  ['coffee', /咖啡|美式|奶铁|拿铁|卡布|玛奇朵|浓缩|鲜萃/], ['mcflurry', /麦旋风/], ['sundae', /新地|圣代|雪冰/],
  ['cone', /圆筒|甜筒|冰淇淋/], ['eggtart', /挞/], ['pie', /派/],
  ['cola', /可乐|雪碧|芬达|茶|汁|奶|豆浆|饮|柠|橙|黑巧|麦炫酷/],
];
export const ICONS = ['fish', 'muffin', 'burger', 'wrap', 'wings', 'drumstick', 'nugget', 'hashbrown', 'fries', 'corn', 'porridge', 'coffee', 'mcflurry', 'sundae', 'cone', 'eggtart', 'pie', 'cola', 'star', 'coin', 'heart', 'moon'];
export function iconOf(name: string): string {
  for (const [icon, re] of ICON_RULES) if (re.test(name)) return icon;
  return 'star';
}
// 简称只用于限定词与称号；全名仍按统计口径保留规格、糖型。
const SHORT_RULES: Array<[RegExp, string]> = [
  [/板烧.*麦满分/, '板烧麦满分'], [/猪柳蛋麦满分/, '猪柳蛋'], [/吉士蛋麦满分/, '吉士蛋'], [/猪柳麦满分/, '猪柳'],
  [/火腿扒麦满分/, '火腿扒'], [/脆鸡扒麦满分/, '脆鸡扒'], [/双蛋堡/, '双蛋堡'],
  [/板烧/, '板烧'], [/麦辣鸡腿/, '麦辣'], [/巨无霸/, '巨无霸'], [/双层吉士/, '双吉'], [/吉士汉堡/, '吉士堡'],
  [/安格斯/, '安格斯'], [/不素之霸/, '不素之霸'], [/龙焰/, '龙焰'], [/鳕鱼堡/, '鳕鱼堡'], [/鱼排堡/, '鱼排堡'],
  [/麦香鱼/, '麦香鱼'], [/麦香鸡/, '麦香鸡'], [/双牛堡/, '双牛堡'], [/脆鸡堡/, '脆鸡堡'], [/鸡排堡/, '鸡排堡'],
  [/麦乐鸡/, '麦乐鸡'], [/麦辣鸡翅/, '鸡翅'], [/V翅/, 'V翅'], [/脆汁鸡/, '脆汁鸡'], [/鸡块/, '鸡块'], [/鸡球/, '鸡球'],
  [/薯饼/, '薯饼'], [/扭扭薯/, '扭扭薯'], [/薯条/, '薯条'], [/玉米杯/, '玉米杯'], [/鸡肉粥/, '鸡肉粥'], [/粥/, '粥'],
  [/麦旋风/, '麦旋风'], [/新地/, '新地'], [/圆筒/, '圆筒'], [/(香芋|菠萝|苹果)派/, '$1派'], [/蛋挞/, '蛋挞'],
  [/可乐.*无糖|无糖.*可乐|零度/, '无糖可乐'], [/可乐/, '可乐'], [/雪碧/, '雪碧'], [/柠檬红茶/, '柠檬茶'],
  [/美式/, '美式'], [/奶铁|拿铁/, '拿铁'], [/卡布奇诺/, '卡布'], [/玛奇朵/, '玛奇朵'], [/鲜萃/, '鲜萃咖啡'], [/豆浆/, '豆浆'],
];
export function shortFoodName(name: string): string {
  for (const [re, short] of SHORT_RULES) { const m = name.match(re); if (m) return short.replace('$1', m[1] ?? ''); }
  const bare = name.replace(/[（(][^）)]*[）)]|【[^】]*】|\d+(?:块|个|对|份)|[中大小]杯|第二份半价|麦咖啡|™|®|\s/g, '');
  return Array.from(bare).length <= 5 ? bare || name : Array.from(bare).slice(0, 5).join('');
}
function categoryWord(body: Body, names: string[]): string {
  const all = (re: RegExp) => names.length > 0 && names.every(n => re.test(n));
  switch (body) {
    case 'burger': return '汉堡';
    case 'muffin': return all(/麦满分/) ? '麦满分' : '早餐';
    case 'nugget': return all(/麦乐鸡|鸡块/) ? '麦乐鸡' : '炸鸡';
    case 'fries': return all(/薯条/) ? '薯条' : '小食';
    case 'cup': return all(/可乐/) ? '可乐' : '饮料';
    case 'coffee': return '咖啡';
    case 'cone': return all(/麦旋风/) ? '麦旋风' : '甜品';
    case 'pie': return '派';
  }
}

// ---------- 人设判定 ----------
export interface Persona {
  sect: SectId; sectName: string; sectRule: string; prop: string; why: string; weak: boolean;
  roleId: string; role: string;
  scene: SceneId; sceneName: string; pose: Pose; body: Body; extras: Body[];
  qualifier: { word: string; level: 'item' | 'category' | 'none' };
  /** 准点派按星期触发（否则按时段）。 */
  punctualByWeekday: boolean;
  bar: { label: string; value: string; ratio: number; max: boolean; caption: string };
  facts: Record<string, FactValue>;
  factList: Array<{ id: string; value: FactValue; meaning: string }>;
  empty: boolean;
}
const FACT_MEANING: Record<string, string> = {
  orders: '订单数（等级）', portions: '总份数', kinds: '不同餐品种数', dated: '有时间的订单数',
  topName: '本命单品全名', topShort: '本命单品简称', topCount: '本命单品份数', topOrders: '本命单品出现在几单里', topPct: '本命单品占全部份数的百分比',
  qualifier: '限定词（本命单品简称，或本命类别词）', night: '深夜单数（21–6点）', morning: '清晨单数（6–10点）',
  peakSlot: '单数最多的时段', peakCount: '该时段单数', weekday: '单数最多的星期', weekdayCount: '该星期单数',
  sweet: '甜品与明确含糖饮料份数', coffee: '含咖啡的订单数', combo: '含随心配的订单数', bigOrders: '单笔≥6份的订单数',
  doubleDays: '一天下单≥2次的天数', need: '距离解锁正式门派还差的单数', sect: '门派名', role: '身份名',
};
const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

export function personaOf(s: McdnaStats): Persona {
  const items = sortItems(s.items ?? []);
  const total = s.totalItemsQty;
  const complete = s.orderCount > 0 && s.itemsKnownOrderCount === s.orderCount;
  const top = items[0] ?? null;
  const topShort = top ? shortFoodName(top.name) : '';
  const topShare = complete && top && total > 0 ? top.qty / total : null;
  const catQty = new Map<Body, number>(); const catNames = new Map<Body, string[]>();
  for (const it of items) { const b = bodyOf(it.name); if (!b) continue; catQty.set(b, (catQty.get(b) ?? 0) + it.qty); catNames.set(b, [...(catNames.get(b) ?? []), it.name]); }
  const cats = [...catQty].sort((a, b) => b[1] - a[1] || BODIES.indexOf(a[0]) - BODIES.indexOf(b[0]));
  // 限定词：单品占主导 → 单品简称；单品分散但同一类别过半 → 类别词（如多种汉堡 → 「汉堡」）。
  let qualifier: Persona['qualifier'] = top ? { word: topShort, level: 'item' } : { word: '', level: 'none' };
  // v1.4.11 W12：占比未知（明细不全）不得当作 0 通过「低于 35%」分支 → 否则会错误切到类别词。
  if (top && cats[0] && total > 0 && topShare !== null && topShare < 0.35 && cats[0][1] / total >= 0.5 && bodyOf(top.name) === cats[0][0]) {
    const sameCat = catNames.get(cats[0][0]) ?? [];
    if (sameCat.length > 1) qualifier = { word: categoryWord(cats[0][0], sameCat), level: 'category' };
  }
  const body: Body = qualifier.level === 'category' ? cats[0][0] : (top ? bodyOf(top.name) ?? cats[0]?.[0] ?? 'burger' : 'nugget');

  const dated = s.datedOrderCount;
  const slot = s.clock.map(c => c.count);
  const [morning, , , , night] = slot;
  const sortedSlots = slot.map((n, i) => [i, n] as const).sort((a, b) => b[1] - a[1]);
  const peak = dated > 0 && sortedSlots[0][1] > 0 && sortedSlots[0][1] !== sortedSlots[1][1] ? { i: sortedSlots[0][0], n: sortedSlots[0][1] } : null;
  const wk = (s.weekdayCounts ?? []).map((n, i) => [i, n] as const).sort((a, b) => b[1] - a[1]);
  const weekday = dated >= 4 && wk[0] && wk[0][1] >= 3 && wk[0][1] !== wk[1]?.[1] ? { i: wk[0][0], n: wk[0][1] } : null;
  const sweetShare = complete && total > 0 ? s.sweetQty / total : 0;
  const dexRatio = complete && s.distinctItems !== null && total > 0 ? s.distinctItems / total : 0;

  // 门派：每派有资格门槛；取「超过门槛最多」的一派；都不达标时取最接近的一派并标注 weak。
  let sect: SectId = 'rookie', why = '', weak = false;
  if (s.orderCount < 5) { why = s.orderCount === 0 ? '暂无订单' : `订单 ${s.orderCount} 单，少于 5 单`; }
  else {
    const cand: Array<{ id: SectId; score: number; ok: boolean; why: string }> = [];
    if (topShare !== null) cand.push({ id: 'solo', score: topShare / 0.5, ok: topShare >= 0.5, why: `本命单品占 ${pctOf(top!.qty, total)}%（门槛 50%）` });
    if (dated > 0) {
      cand.push({ id: 'night', score: night / dated / 0.4, ok: night >= 3 && night / dated >= 0.4 && peak?.i === 4, why: `深夜 ${night}/${dated} 单（门槛 40% 且最多）` });
      cand.push({ id: 'morning', score: morning / dated / 0.4, ok: morning >= 3 && morning / dated >= 0.4 && peak?.i === 0, why: `清晨 ${morning}/${dated} 单（门槛 40% 且最多）` });
      const mid = peak && peak.i >= 1 && peak.i <= 3 ? peak.n / dated : 0;
      const wkShare = weekday ? weekday.n / dated : 0;
      const usesWeekday = wkShare / 0.4 > mid / 0.5;
      cand.push({ id: 'punctual', score: Math.max(mid / 0.5, wkShare / 0.4), ok: mid >= 0.5 || (weekday !== null && wkShare >= 0.4),
        why: usesWeekday && weekday ? `${WEEKDAYS[weekday.i]} ${weekday.n}/${dated} 单（门槛 40%）` : peak ? `${SLOT_LABELS[peak.i]} ${peak.n}/${dated} 单（门槛 50%）` : '时段分散' });
    }
    if (complete && total >= 5) cand.push({ id: 'sweet', score: sweetShare / 0.35, ok: sweetShare >= 0.35, why: `甜品与含糖饮料 ${s.sweetQty}/${total} 份（门槛 35%）` });
    if (s.comboOrderCount > 0) cand.push({ id: 'combo', score: s.comboOrderCount / s.orderCount / 0.3, ok: s.comboOrderCount >= 3 && s.comboOrderCount / s.orderCount >= 0.3, why: `随心配 ${s.comboOrderCount}/${s.orderCount} 单（门槛 30%）` });
    if (complete && s.distinctItems !== null) cand.push({ id: 'dex', score: dexRatio / 0.6, ok: s.distinctItems >= 6 && dexRatio >= 0.6, why: `${total} 份里 ${s.distinctItems} 种（门槛 60% 且≥6 种）` });
    const ok = cand.filter(c => c.ok).sort((a, b) => b.score - a.score);
    const pick = ok[0] ?? [...cand].sort((a, b) => b.score - a.score)[0];
    if (pick) { sect = pick.id; why = pick.why; weak = !pick.ok; if (weak) why += '；都未达门槛，取最接近的一派'; }
    else { sect = 'dex'; why = '订单明细不全，无法判定偏好'; weak = true; }
  }
  const punctualByWeekday = sect === 'punctual' && weekday !== null && (!peak || peak.i < 1 || peak.i > 3 || (weekday.n / dated) / 0.4 > (peak.n / dated) / 0.5);

  // 身份：固定词表，按副卡显著度取一个；不含数字。
  const roles: Array<{ id: string; name: string; score: number }> = [];
  if (s.orderCount < 5) roles.push({ id: 'rookie', name: '新面孔', score: 99 });
  else {
    if (sect !== 'night' && night >= 2) roles.push({ id: 'nightExtra', name: '深夜加更', score: night / 2 });
    if (sect !== 'morning' && morning >= 2) roles.push({ id: 'morningExtra', name: '清晨打卡', score: morning / 2 });
    if (s.coffeeOrderCount >= 3) roles.push({ id: 'coffee', name: '咖啡搭子', score: s.coffeeOrderCount / 3 });
    if (s.doubleDayCount >= 2) roles.push({ id: 'double', name: '一天两顿', score: s.doubleDayCount / 2 });
    if (sect !== 'sweet' && s.sweetQty >= 3 && sweetShare >= 0.2) roles.push({ id: 'sweet', name: '甜区常客', score: sweetShare / 0.2 });
    if (s.bigOrderCount >= 2) roles.push({ id: 'feast', name: '满桌开席', score: s.bigOrderCount / 2 });
    if (sect !== 'combo' && s.comboOrderCount >= 2) roles.push({ id: 'combo', name: '随心配常客', score: s.comboOrderCount / 2 });
    if (sect !== 'solo' && top && top.orders >= 4) roles.push({ id: 'regular', name: '回头客', score: top.orders / 4 });
    if (sect !== 'punctual' && weekday) roles.push({ id: 'weekday', name: `${WEEKDAYS[weekday.i]}常客`, score: weekday.n / 3 });
    if (sect !== 'dex' && complete && (s.distinctItems ?? 0) >= 6) roles.push({ id: 'dex', name: '图鉴达人', score: (s.distinctItems ?? 0) / 6 });
  }
  roles.sort((a, b) => b.score - a.score);
  const role = roles[0] ?? { id: 'normal', name: '常规出勤', score: 0 };

  // 场景与姿势：门派优先，其次是显著的大单/时段。
  let scene: SceneId = 'counter';
  if (sect === 'night') scene = 'night';
  else if (sect === 'morning') scene = 'morning';
  else if (s.bigOrderCount >= 2 && s.bigOrderCount / Math.max(1, s.orderCount) >= 0.25) scene = 'feast';
  else if (dated > 0 && night >= 3 && night / dated >= 0.4) scene = 'night';
  else if (dated > 0 && morning >= 3 && morning / dated >= 0.4) scene = 'morning';
  const extras = scene === 'feast' ? cats.map(c => c[0]).filter(b => b !== body).slice(0, 2) : [];

  const F: Record<string, FactValue> = { orders: s.orderCount, sect: SECTS[sect].name, role: role.name };
  if (complete && total > 0) { F.portions = total; if (s.distinctItems !== null) F.kinds = s.distinctItems; }
  if (dated > 0) F.dated = dated;
  if (top) { F.topName = top.name; F.topShort = topShort; F.topCount = top.qty; F.topOrders = top.orders; if (topShare !== null) F.topPct = Math.round(topShare * 100); }
  if (qualifier.word) F.qualifier = qualifier.word;
  if (dated > 0 && night > 0) F.night = night;
  if (dated > 0 && morning > 0) F.morning = morning;
  if (peak) { F.peakSlot = SLOT_LABELS[peak.i]; F.peakCount = peak.n; }
  if (weekday) { F.weekday = WEEKDAYS[weekday.i]; F.weekdayCount = weekday.n; }
  if (complete && s.sweetQty > 0) F.sweet = s.sweetQty;
  if (s.coffeeOrderCount > 0) F.coffee = s.coffeeOrderCount;
  if (s.comboOrderCount > 0) F.combo = s.comboOrderCount;
  if (s.bigOrderCount > 0) F.bigOrders = s.bigOrderCount;
  if (s.doubleDayCount > 0) F.doubleDays = s.doubleDayCount;
  if (sect === 'rookie') F.need = Math.max(1, 5 - s.orderCount);

  // 主进度条：夸张值（MAX）必须并列真实占比。
  let bar: Persona['bar'];
  switch (sect) {
    case 'solo': {
      // v1.4.11 W13：MAX 只属于「达到 50% 门槛且数据完整」的强结论；弱匹配按真实占比显示，不满格。
      const share = topShare ?? 0, pct = pctOf(top!.qty, total);
      bar = share >= 0.5
        ? { label: `${qualifier.word}好感度`, value: 'MAX', ratio: 1, max: true, caption: `${total} 份里 ${top!.qty} 份是${topShort}，占 ${pct}%` }
        : { label: `${qualifier.word}好感度`, value: `${pct}%`, ratio: share, max: false, caption: `${total} 份里 ${top!.qty} 份是${topShort}，占 ${pct}%（未达 50% 门槛，未满格）` };
      break;
    }
    case 'night': bar = { label: '夜巡出勤', value: `${pctOf(night, dated)}%`, ratio: night / dated, max: false, caption: `${dated} 单里 ${night} 单在深夜（21–6 点）` }; break;
    case 'morning': bar = { label: '早课出勤', value: `${pctOf(morning, dated)}%`, ratio: morning / dated, max: false, caption: `${dated} 单里 ${morning} 单在清晨（6–10 点）` }; break;
    case 'dex': bar = { label: '图鉴进度', value: s.distinctItems === null ? '未知' : `${s.distinctItems} 种`, ratio: dexRatio, max: false, caption: s.distinctItems === null ? '订单明细不全，种类未统计' : `${total} 份里有 ${s.distinctItems} 种不同餐品` }; break;
    case 'sweet': bar = { label: '甜度', value: `${pctOf(s.sweetQty, total)}%`, ratio: sweetShare, max: false, caption: `${total} 份里 ${s.sweetQty} 份是甜品或明确含糖饮料` }; break;
    case 'combo': bar = { label: '随心配', value: `${pctOf(s.comboOrderCount, s.orderCount)}%`, ratio: s.comboOrderCount / s.orderCount, max: false, caption: `${s.orderCount} 单里 ${s.comboOrderCount} 单点了随心配` }; break;
    case 'punctual': bar = punctualByWeekday && weekday
      ? { label: `${WEEKDAYS[weekday.i]}准点率`, value: `${pctOf(weekday.n, dated)}%`, ratio: weekday.n / dated, max: false, caption: `${dated} 单里 ${weekday.n} 单在${WEEKDAYS[weekday.i]}` }
      : peak ? { label: `${SLOT_LABELS[peak.i]}准点率`, value: `${pctOf(peak.n, dated)}%`, ratio: peak.n / dated, max: false, caption: `${dated} 单里 ${peak.n} 单在${SLOT_LABELS[peak.i]}` }
      : { label: '准点率', value: '分散', ratio: 0.2, max: false, caption: '各时段单数接近，暂无固定饭点' }; break;
    default: bar = { label: '入门进度', value: `${s.orderCount}/5`, ratio: s.orderCount / 5, max: false, caption: s.orderCount ? `满 5 单解锁正式门派，还差 ${5 - s.orderCount} 单` : '官方账户暂未返回订单' };
  }
  const factList = Object.entries(F).map(([id, value]) => ({ id, value, meaning: FACT_MEANING[id] ?? id }));
  return {
    sect, sectName: SECTS[sect].name, sectRule: SECTS[sect].rule, prop: SECTS[sect].prop, why, weak,
    roleId: role.id, role: role.name, scene, sceneName: SCENES[scene].name, pose: SCENES[scene].pose, body, extras,
    qualifier, punctualByWeekday, bar, facts: F, factList, empty: s.orderCount === 0,
  };
}

// ---------- 文字槽位：内置梗库（人写，随包） ----------
export interface McdnaCopy { title: string; verdict: string; achievements: string[]; dialogue: string; hook: string }
type Variant = Omit<McdnaCopy, 'achievements'>;
const RULE_COPY: Record<SectId, Variant[]> = {
  solo: [
    { title: '{qualifier}钉子户', verdict: '菜单翻了一圈，最后还是{qualifier}', dialogue: '这段存档里，{topName}出现了{topCount}份。别人点餐靠选，你点餐靠认。', hook: '你的本命是哪一样？' },
    { title: '{qualifier}正宫', verdict: '换口味？本派不提倡', dialogue: '{topCount}份{topShort}，回头了{topOrders}单。菜单很长，你的答案很短。', hook: '你的本命是哪一样？' },
  ],
  night: [
    { title: '麦门夜巡队长', verdict: '夜越深，麦门越亮', dialogue: '有时间的{dated}单里，{night}单落在深夜。麦门的灯一亮，你就上线了。', hook: '你几点还在线？' },
    { title: '深夜常驻嘉宾', verdict: '月亮出来，你也出来', dialogue: '深夜出没{night}次，夜巡派认证。这个点的{qualifier}，味道好像更对。', hook: '你几点还在线？' },
  ],
  morning: [
    { title: '早课全勤生', verdict: '闹钟还没响，早餐先到了', dialogue: '{dated}单里有{morning}单在清晨。天刚亮就开饭，早课这件事你是认真的。', hook: '你几点开饭？' },
    { title: '{qualifier}早课代表', verdict: '天亮第一单，签到成功', dialogue: '清晨签到{morning}次，最常点的是{topShort}。早课派的点名册上，你在第一页。', hook: '你几点开饭？' },
  ],
  dex: [
    { title: '麦门菜单收集控', verdict: '点餐不靠缘分，靠通关', dialogue: '{portions}份里有{kinds}种不同餐品。菜单对你来说不是选择题，是收集册。', hook: '你解锁了几种？' },
    { title: '菜单通关玩家', verdict: '新品一上，图鉴就更', dialogue: '图鉴已解锁{kinds}种。别人在纠结点什么，你在纠结下次解锁哪个。', hook: '你解锁了几种？' },
  ],
  sweet: [
    { title: '甜区常驻嘉宾', verdict: '正餐是前菜，甜品是主线', dialogue: '{portions}份里有{sweet}份是甜品或含糖饮料。主线任务清楚，支线随缘。', hook: '你的甜区在哪？' },
    { title: '{qualifier}主线玩家', verdict: '甜品不是饭后，是饭本身', dialogue: '甜区打卡{sweet}份，最常点的是{topShort}。这条主线，你推得很稳。', hook: '你的甜区在哪？' },
  ],
  punctual: [
    { title: '{weekday}麦门礼拜', verdict: '每到{weekday}，准时报到', dialogue: '{weekday}下单{weekdayCount}次。这不是巧合，这是麦门的仪式感。', hook: '你的饭点准不准？' },
    { title: '{peakSlot}准点王', verdict: '开饭时间比闹钟准', dialogue: '{dated}单里{peakCount}单在{peakSlot}。到点就开饭，麦门给你记全勤。', hook: '你的饭点准不准？' },
  ],
  combo: [
    { title: '随心配研究员', verdict: '一加一，配出新花样', dialogue: '{orders}单里有{combo}单点了随心配。排列组合这门课，你修得很认真。', hook: '你的一加一怎么配？' },
    { title: '穷鬼套餐鉴赏家', verdict: '组合拳，打得很熟', dialogue: '随心配点了{combo}单。网友叫它穷鬼套餐，你叫它基本操作。', hook: '你的一加一怎么配？' },
  ],
  rookie: [
    { title: '麦门见习生', verdict: '先认个脸熟，不急着下结论', dialogue: '{topName}点了{topCount}份，第一印象不错。再来几单，管家就能认出你了。', hook: '再来{need}单就开光' },
    { title: '麦门新面孔', verdict: '入门手续，办理中', dialogue: '已经报到{orders}单。门派还没定，你的本命也许就在下一单。', hook: '再来{need}单就开光' },
  ],
};
const GENERIC: Variant = { title: '麦门常客', verdict: '存档已更新', dialogue: '这段存档有{orders}单。下次再来，状态栏接着涨。', hook: '晒出你的存档？' };
const EMPTY_COPY: McdnaCopy = { title: '麦门待报到', verdict: '这一页，等下一单', achievements: ['存档已创建'], dialogue: '官方账户暂时没有返回订单记录。这里先空着，不替你编一张人设。', hook: '下一单就开张' };
const SECT_ACH: Record<SectId, string[]> = {
  solo: ['本命打卡×{topCount}'], night: ['深夜出没×{night}'], morning: ['早课签到×{morning}'], dex: ['图鉴解锁×{kinds}'],
  sweet: ['甜区打卡×{sweet}'], punctual: ['{weekday}报到×{weekdayCount}', '{peakSlot}准点×{peakCount}'], combo: ['随心配×{combo}'], rookie: ['入门报到×{orders}'],
};
const ROLE_ACH: Record<string, string> = {
  nightExtra: '深夜加更×{night}', morningExtra: '清晨打卡×{morning}', coffee: '咖啡搭子×{coffee}', double: '一天两顿×{doubleDays}',
  sweet: '甜区常客×{sweet}', feast: '满桌开席×{bigOrders}', combo: '随心配×{combo}', regular: '回头客×{topOrders}',
  weekday: '{weekday}报到×{weekdayCount}', dex: '图鉴解锁×{kinds}',
};
// v1.4.11 W10：扫描**全部**花括号表达式（旧实现只认字母，{night_count}/{night-count} 直接绕过守门）。
const PH = /\{([^{}]*)\}/g;
const placeholders = (t: string) => [...t.matchAll(PH)].map(m => m[1]);
const available = (t: string, F: Record<string, FactValue>) => placeholders(t).every(k => k in F);
export function fillFacts(t: string, F: Record<string, FactValue>): string {
  return t.replace(PH, (_, k: string) => (k in F ? String(F[k]) : `{${k}}`));
}
export function ruleCopy(p: Persona, seed: number): McdnaCopy {
  if (p.empty) return EMPTY_COPY;
  const F = p.facts;
  const pool = RULE_COPY[p.sect].filter(v => available(v.title + v.verdict + v.dialogue + v.hook, F));
  // 准点派：按星期触发时用星期变体，按时段触发时用时段变体。
  const ordered = p.sect === 'punctual' ? pool.filter(v => v.title.includes('{weekday}') === p.punctualByWeekday) : pool;
  const list = ordered.length ? ordered : pool.length ? pool : [GENERIC];
  const v = list[Math.abs(seed) % list.length];
  const main = SECT_ACH[p.sect].find(a => available(a, F) && (p.sect !== 'punctual' || a.includes('{weekday}') === p.punctualByWeekday)) ?? SECT_ACH[p.sect].find(a => available(a, F));
  const second = ROLE_ACH[p.roleId];
  const ach = [main, second && available(second, F) && second !== main ? second : undefined].filter((x): x is string => !!x);
  return { ...v, achievements: ach.length ? ach : ['存档×{orders}'] };
}
export function resolveCopy(c: McdnaCopy, F: Record<string, FactValue>): McdnaCopy {
  return { title: fillFacts(c.title, F), verdict: fillFacts(c.verdict, F), achievements: c.achievements.map(a => fillFacts(a, F)), dialogue: fillFacts(c.dialogue, F), hook: fillFacts(c.hook, F) };
}
/** 给 Agent 看的人写范例：当前门派的梗库变体（已代入事实）。 */
export function goodExamples(p: Persona): McdnaCopy[] {
  return [0, 1].map(i => resolveCopy(ruleCopy(p, i), p.facts));
}

// ---------- Agent 文案守门 ----------
export const COPY_LIMITS = { title: [2, 10], verdict: [4, 16], achievement: [2, 10], dialogue: [8, 64], hook: [2, 14] } as const;
const BANNED = /减脂|减肥|自律|健康|养生|控卡|卡路里|热量|身材|长胖|发胖|胖|瘦|有钱|暴富|富婆|富豪|工资|打工|社畜|职业|上班|加班|摸鱼|熬夜|失眠|睡不着|单身|恋爱|情侣|孤独|emo|焦虑|抑郁|击败|超过.{0,6}(?:用户|人)|全国|排名|疯狂星期四|[vV]我|肯德基|KFC|汉堡王|德克士|塔斯汀|优惠|折扣|免费|送你/i;
const QUANTITY = /[零〇一二两三四五六七八九十百千万亿]+\s*(?:笔|单|份|次|种|天|元|块钱|杯|个|%|成|倍)/u;
// 食品词：Agent 直接写出的食品必须在用户订单里出现过（或是其已有类别的类别词）。
const FOOD_TOKENS: Array<[string, RegExp]> = [
  ['板烧', /板烧/], ['麦辣', /麦辣/], ['巨无霸', /巨无霸/], ['吉士', /吉士/], ['麦香鸡', /麦香鸡/], ['麦香鱼', /麦香鱼/],
  ['鳕鱼', /鳕鱼/], ['鱼排', /鱼排/], ['安格斯', /安格斯/], ['不素之霸', /不素之霸/], ['龙焰', /龙焰/], ['双牛', /双牛|牛堡/],
  ['鸡排', /鸡排/], ['麦满分', /麦满分/], ['猪柳', /猪柳/], ['麦乐鸡', /麦乐鸡/], ['鸡块', /麦乐鸡|鸡块/], ['鸡翅', /鸡翅|V翅/],
  ['脆汁鸡', /脆汁鸡/], ['薯条', /薯条/], ['薯饼', /薯饼/], ['玉米杯', /玉米杯/], ['可乐', /可乐/], ['雪碧', /雪碧/],
  ['豆浆', /豆浆/], ['美式', /美式/], ['拿铁', /拿铁|奶铁/], ['奶铁', /拿铁|奶铁/], ['麦旋风', /麦旋风/], ['新地', /新地/],
  ['圆筒', /圆筒|甜筒/], ['甜筒', /圆筒|甜筒/], ['香芋派', /香芋派/], ['菠萝派', /菠萝派/], ['苹果派', /苹果派/], ['蛋挞', /蛋挞/],
  ['粥', /粥/], ['油条', /油条/], ['随心配', /随心配/],
];
const CATEGORY_TOKENS: Array<[string, Body]> = [['汉堡', 'burger'], ['咖啡', 'coffee'], ['冰淇淋', 'cone'], ['早餐', 'muffin'], ['炸鸡', 'nugget']];

export interface CopyCheck { copy: McdnaCopy; resolved: McdnaCopy; factIds: string[]; issues: string[] }
export function checkCopy(raw: unknown, p: Persona, s: McdnaStats, hasGlyph: (ch: string) => boolean): CopyCheck {
  const issues: string[] = [];
  const v = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string).trim().normalize('NFC') : (issues.push(`${k} 必须是字符串`), ''));
  const copy: McdnaCopy = { title: str('title'), verdict: str('verdict'), achievements: [], dialogue: str('dialogue'), hook: str('hook') };
  if (!Array.isArray(v.achievements) || v.achievements.length < 1 || v.achievements.length > 3 || !v.achievements.every(a => typeof a === 'string')) issues.push('achievements 必须是 1–3 个字符串');
  else copy.achievements = (v.achievements as string[]).map(a => a.trim().normalize('NFC'));
  const F = p.facts;
  const names = (s.items ?? []).map(i => i.name).join('|');
  const cats = new Set((s.items ?? []).map(i => bodyOf(i.name)));
  const slots: Array<[string, string, readonly [number, number]]> = [
    ['称号', copy.title, COPY_LIMITS.title], ['判词', copy.verdict, COPY_LIMITS.verdict],
    ...copy.achievements.map((a, i) => [`成就${i + 1}`, a, COPY_LIMITS.achievement] as [string, string, readonly [number, number]]),
    ['评语', copy.dialogue, COPY_LIMITS.dialogue], ['钩子', copy.hook, COPY_LIMITS.hook],
  ];
  const used = new Set<string>();
  for (const [label, text, [min, max]] of slots) {
    if (!text) continue;
    for (const k of placeholders(text)) { if (!(k in F)) issues.push(`${label}引用了不存在的事实 {${k}}`); else used.add(k); }
    const bare = text.replace(PH, '');
    if (/[\p{N}¥￥$]/u.test(bare) || QUANTITY.test(bare)) issues.push(`${label}自写了数字或数量；数字请用 {事实编号}`);
    if (/https?:|www\.|@|token|密钥|手机号|身份证|[\p{Cc}<>]/iu.test(bare)) issues.push(`${label}含链接、标识、凭据或尖括号`);
    const banned = bare.match(BANNED);
    if (banned) issues.push(`${label}触及禁用话题「${banned[0]}」`);
    if (/穷/.test(bare) && !(/穷鬼套餐/.test(bare) && s.comboOrderCount > 0)) issues.push(`${label}不能推断经济状况（「穷鬼套餐」仅在点过随心配时可用）`);
    for (const [token, re] of FOOD_TOKENS) if (bare.includes(token) && !re.test(names)) issues.push(`${label}提到了订单里没有的「${token}」；请用 {qualifier} 或 {topShort}`);
    // v1.4.11 W11：食品词只证明「点过可乐」，不证明「无糖可乐」。糖型/杯型属于食品身份，
    //   含糖↔无糖、大杯↔中杯不得互相冒充（与 W07 的统计归一是两个不同缺陷）。
    const sugarClaim = /无糖|零度|零糖/.test(bare) ? '无糖' : /含糖|有糖/.test(bare) ? '含糖' : '';
    if (sugarClaim) {
      const claimRe = sugarClaim === '无糖' ? /无糖|零度|零糖/ : /含糖|有糖/;
      if (!claimRe.test(names)) issues.push(`${label}写成了「${sugarClaim}」，但订单里没有该糖型的食品`);
    }
    const sizeClaim = /(超大杯|大杯|中杯|小杯)/.exec(bare)?.[1];
    if (sizeClaim && !names.includes(sizeClaim)) issues.push(`${label}写成了「${sizeClaim}」，但订单里没有该杯型的食品`);
    for (const [token, b] of CATEGORY_TOKENS) if (bare.includes(token) && !cats.has(b)) issues.push(`${label}提到了订单里没有的类别「${token}」`);
    const rendered = fillFacts(text, F);
    // v1.4.11 W10：代入后不得残留任何花括号表达式（非法引用必须被拒绝，不能原样上卡）。
    const residual = /\{[^{}]*\}/.exec(rendered);
    if (residual) issues.push(`${label}代入后仍残留占位符 ${residual[0]}，请检查事实编号`);
    const len = Array.from(rendered).length;
    if (len < min || len > max) issues.push(`${label}代入事实后 ${len} 字，需 ${min}–${max} 字`);
    const missing = [...new Set(Array.from(rendered).filter(ch => !hasGlyph(ch)))];
    if (missing.length) issues.push(`${label}含像素字库未收录的字符：${missing.join('')}`);
  }
  copy.achievements.forEach((a, i) => { if (a && placeholders(a).length === 0) issues.push(`成就${i + 1}必须引用一个事实编号，例如 ×{topCount}`); });
  return { copy, resolved: resolveCopy(copy, F), factIds: [...used], issues: [...new Set(issues)] };
}
