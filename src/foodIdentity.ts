// 食品身份（v1.4.7 R02/R03/R10 统一契约）：
//   「吃什么」的唯一签名 = 食品身份 + 规格 + 数量，**不含**购买渠道、券 code、套餐 code、价格或热量。
//
// 为什么需要单独一层：
//   - 单人 Top-K、跨轨统一去重、前端分组三处此前各写一套字符串规则（显示名 / perUnitConfig / 名称+热量），
//     结果一边「该合并的没合并」（同一食品拆成套餐/散点、别名占两席），一边「不该合并的合并了」
//     （同名不同规格因名称相同被归为一组，或用热量替代规格身份）。
//   - 身份优先级：结构化 option code（官方 SKU/选项 code）> 归一化名称；**规格标签始终参与身份**
//     （v1.4.8 R07：同 code 的小/大份是不同食品——小薯 210 kcal / 大薯 379 kcal，合并会丢掉合法候选）。
//     同 code 同规格的别名、排列、渠道仍归同一身份。**绝不**用热量近似规格。
//   - 非食品（玩具/餐具）不参与「吃什么」签名：换玩具不构成不同方案。

export interface FoodUnitRef {
  /** 结构化选项 code（官方 SKU / 菜单选项 code）；有值时优先作为身份 */
  code?: string;
  /** 显示名（无 code 时参与身份） */
  name: string;
  /** 规格标签（大/中/小份、5块等）；无 code 时参与身份，有 code 时作为附加区分 */
  spec?: string;
  /** 份数（同身份累加） */
  qty: number;
  /** 非食品（玩具/餐具/奖品）：不计入签名 */
  nonFood?: boolean;
}

/** 名称归一：去首尾与内部空白、统一小写。仅用于「同一食品的不同写法」，不消除规格/糖型差异。 */
export function normFoodName(s: string | undefined): string {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 规格键（v1.4.8 R07）：只提取**有依据的规格词**（大/中/小/迷你/超大、N块/N个/N件/N片/N份/N杯）。
 * 其余描述（原味、香辣、冰/热）不参与身份，避免同一食品因文案差异被拆成两份。
 * 返回空串 = 未声明可识别规格（调用方不得把它当作「任意规格」通配，只是「未指定」）。
 */
export function normSpecKey(spec: string | undefined): string {
  const t = normFoodName(spec);
  if (!t) return '';
  const out: string[] = [];
  const re = /(超大|大|中|小|迷你)|(\d+)(块|个|件|片|只|根|份|杯)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) out.push(m[1] ?? `${m[2]}${m[3]}`);
  return out.join('+');
}

/** 名称里的规格词（大杯/大薯/大可乐…）：只在规格字紧跟已知品名或单位时采信，
 *  避免把「大脆鸡扒」这类产品名误当成大份。 */
const RE_NAME_SPEC = /(超大|大|中|小|迷你)(?=杯|份|薯|可乐|雪碧|薯条|咖啡|奶铁|豆浆|美式|红茶|果汁|牛奶|冰茶)/;
const RE_NAME_PIECE = /([一二两三四五六七八九十\d]+)\s*块/;

/** 从显示名推断规格键（仅用于身份签名，不改变展示名） */
export function specOfName(name: string | undefined): string {
  const s = String(name ?? '').replace(/\s+/g, '');
  const m = s.match(RE_NAME_SPEC);
  if (m) return m[1];
  // 后置规格（「薯条 中」「可乐 大」）：仅当规格字前还有品名主体时采信
  const tail = s.match(/^(..+)(超大|大|中|小|迷你)$/);
  if (tail) return tail[2];
  const p = s.match(RE_NAME_PIECE);
  if (p) {
    const n = ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 } as Record<string, number>)[p[1]] ?? parseInt(p[1], 10);
    if (Number.isFinite(n)) return `${n}块`;
  }
  return '';
}

/** 归一化品名主体：去括号描述、去规格前缀、统一「汉堡/汉堡包→堡」。
 *  同一食品的官方套餐槽位名、单点名、券名走同一主体名，才不会被路径差异拆开。 */
export function canonicalFoodName(name: string | undefined): string {
  let s = String(name ?? '').replace(/[（(【\[].*?[)）】\]]/g, '').replace(/\s+/g, '').toLowerCase();
  s = s.replace(RE_NAME_SPEC, '');
  s = s.replace(/^[一二两三四五六七八九十\d]+块/, '');
  if (s.length > 2) s = s.replace(/(超大|大|中|小|迷你)$/, '');
  s = s.replace(/汉堡包/g, '堡').replace(/汉堡/g, '堡');
  if (s.length > 2) s = s.replace(/堡$/, '');
  return s;
}

/**
 * 单个食品的身份键（v1.4.10 W06）。
 *   **不再使用购买路径 code 作为身份**：官方套餐槽位 code（4820）与券解析出的单点 code（4810）
 *   可能是同一份大薯条，旧实现按 code 判定 → 同价同食品被拆成两个方案名额；
 *   反之同 code 的小薯/大薯（4810）又因缺规格被合并。
 *   现在签名 = 归一化品名主体 + 规格（显式 spec 优先，其次从名称推断）；
 *   code 只作为履约/核价字段保留在购买途径上，不参与「吃什么」判定。
 */
export function foodKeyOf(u: { code?: string; name: string; spec?: string }): string {
  const spec = normSpecKey(u.spec) || specOfName(u.name);
  const base = canonicalFoodName(u.name) || normFoodName(u.name);
  return `n:${base}${spec ? `@${spec}` : ''}`;
}

/** 把若干食品引用聚合为「身份 → 份数」多重集签名（排序后拼接，与购买分块/槽位顺序无关）。
 *  同一食品从套餐、单点或不同渠道得到时签名一致 → 只占一个方案名额。 */
export function foodMultisetSignature(units: FoodUnitRef[]): string {
  const agg = new Map<string, number>();
  for (const u of units) {
    if (u.nonFood) continue;
    const qty = Math.max(0, Math.round(Number(u.qty) || 0));
    if (qty <= 0) continue;
    const key = foodKeyOf(u);
    agg.set(key, (agg.get(key) ?? 0) + qty);
  }
  if (agg.size === 0) return 'empty';
  return [...agg.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, n]) => `${k}×${n}`)
    .join('|');
}

/** 展示用摘要（诊断/日志；不用于身份判定） */
export function foodUnitsSummary(units: FoodUnitRef[]): string {
  return units.filter((u) => !u.nonFood)
    .map((u) => `${u.name}${u.spec ? `(${u.spec})` : ''}${u.qty > 1 ? `×${u.qty}` : ''}`)
    .join('＋') || '（无食品）';
}
