// 双约束求解引擎 v3
// 硬约束：热量 ≤ kcalBudget、价格 ≤ priceBudgetCents（进 DP）
// 软硬约束：钠/碳水/蛋白/快碳/蔬菜份/主食份等用户自定义上下限（Top-K 候选池后过滤）
// 目标（v3 语义升级）：
//   'kcal-fill'  热量贴合——在 ≤ 预算硬约束下最大化热量利用（吃满预算，可加近似"贴合"）
//   'price-fill' 价格贴合——最大化价格利用（花满预算）
//   protein↑ / kcal↓ / price↓ / sodium↓ / fastCarb↓ / carb↓（营养目标，最小化/最大化语义不变）
// preferCombo：最终排序 tie-break（组合套餐优先于单点，回应用户实测反馈"套餐更便宜却倾向单点"）
import type { MenuItem } from './menu.js';

export type MetricKey = 'kcal' | 'price' | 'protein' | 'fat' | 'carb' | 'sodium' | 'fastCarb' | 'veggie' | 'staple';
export type ObjectiveMetric = 'protein' | 'kcal' | 'price' | 'sodium' | 'fastCarb' | 'carb' | 'kcal-fill' | 'price-fill';

export interface MetricConstraint {
  metric: Exclude<MetricKey, 'kcal' | 'price'>; // kcal/price 已是硬约束，不重复
  op: '<=' | '>=';
  value: number;
}

export interface SolveInput {
  items: MenuItem[];
  kcalBudget: number;
  priceBudgetCents: number;
  objective: ObjectiveMetric; // 兼容单目标；objectives 提供时以 objectives 为准
  objectives?: ObjectiveMetric[]; // 多选优化目标（按优先级分层字典序）
  constraints?: MetricConstraint[];
  maxItems?: number;
  poolSize?: number;
  preferCombo?: boolean; // 最终排序 tie-break：组合套餐优先（v3）
}

export interface SolveSolution {
  items: Array<{ item: MenuItem; qty: number }>;
  metrics: Record<MetricKey, number>;
}

export interface SolveResult {
  solutions: SolveSolution[];
  feasible: boolean;
  reason?: string;
  scanned: number;
  poolTried: number;
  objectives?: ObjectiveMetric[]; // 实际生效的优化目标序列
}

const MINIMIZE_METRICS: ReadonlySet<ObjectiveMetric> = new Set(['kcal', 'price', 'sodium', 'fastCarb', 'carb']);
const isMinimize = (m: ObjectiveMetric): boolean => MINIMIZE_METRICS.has(m);

function metricOf(solutionItems: Array<{ item: MenuItem; qty: number }>, metric: MetricKey): number {
  let sum = 0;
  for (const { item, qty } of solutionItems) {
    switch (metric) {
      case 'kcal': sum += item.kcal * qty; break;
      case 'price': sum += item.priceCents * qty; break;
      case 'protein': sum += item.protein * qty; break;
      case 'fat': sum += item.fat * qty; break;
      case 'carb': sum += item.carbohydrate * qty; break;
      case 'sodium': sum += item.sodium * qty; break;
      case 'fastCarb': sum += item.fastCarb * qty; break;
      case 'veggie': sum += (item.veggieCount ?? (item.isVeggie ? 1 : 0)) * qty; break;
      case 'staple': sum += (item.stapleCount ?? (item.isStaple ? 1 : 0)) * qty; break;
    }
  }
  return sum;
}

const METRIC_LABEL: Record<string, string> = {
  protein: '蛋白质(g)', fat: '脂肪(g)', carb: '碳水(g)', sodium: '钠(mg)',
  fastCarb: '快碳(g)', veggie: '蔬菜份', staple: '主食份',
};

/** 分层容差（按指标量纲，v0.5）：5% 统一比例在不同量纲上失真——
 *  价格（分）5% 在 ¥25 预算下是 ¥1.25，容差带过宽会让第二目标失去区分度；
 *  钠（mg）5% 可能是 50mg 的窄带、蛋白（g）5% 不足 1g 又过窄。
 *  这里为每个指标设绝对下限 + 相对比例双基准，量纲越小的指标绝对下限占比越高。 */
export function tolFor(metric: ObjectiveMetric, best: number): number {
  const rel = Math.abs(best) * 0.05;
  switch (metric) {
    case 'price': return Math.max(100, rel); // ≥ ¥1 的价格容差
    case 'kcal': return Math.max(25, rel); // ≥ 25 kcal
    case 'sodium': return Math.max(50, rel); // ≥ 50 mg
    case 'protein':
    case 'carb':
    case 'fastCarb': return Math.max(2, rel); // ≥ 2 g
    default: return Math.max(1, rel);
  }
}

export function solve(input: SolveInput): SolveResult {
  const { kcalBudget, priceBudgetCents } = input;
  const objective = (input.objectives && input.objectives.length > 0 ? input.objectives[0] : input.objective) as ObjectiveMetric;
  const maxItems = input.maxItems ?? 6;
  const poolSize = input.poolSize ?? 30;
  const constraints = input.constraints ?? [];
  const NEG = -1e9;

  if (input.items.length === 0) {
    return { solutions: [], feasible: false, reason: '门店菜单数据为空或营养数据未覆盖任何单品，请稍后重试或更换门店。', scanned: 0, poolTried: 0 };
  }
  const candidates = input.items.filter((i) => i.kcal <= kcalBudget && i.priceCents <= priceBudgetCents);
  if (candidates.length === 0) {
    const minKcal = Math.min(...input.items.map((i) => i.kcal));
    const minPrice = Math.min(...input.items.map((i) => i.priceCents));
    let reason = '当前门店菜单中没有任何单品能同时满足热量与价格预算。';
    if (minKcal > kcalBudget && minPrice <= priceBudgetCents) reason += ` 最低热量单品为 ${minKcal} kcal，高于热量预算 ${kcalBudget} kcal。`;
    else if (minPrice > priceBudgetCents && minKcal <= kcalBudget) reason += ` 最低热量单品价格 ¥${(minPrice / 100).toFixed(1)}，高于价格预算 ¥${(priceBudgetCents / 100).toFixed(1)}。`;
    else reason += ` 最低热量 ${minKcal} kcal / 最低价 ¥${(minPrice / 100).toFixed(1)}，请适当放宽预算。`;
    return { solutions: [], feasible: false, reason, scanned: 0, poolTried: 0 };
  }

  // ---- DP 维度与内存护栏 ----
  // 状态数 = (K+1)×(P+1)×(C+1)。预算过大时（例：5000kcal + ¥500）1元粒度会让回溯数组膨胀到 GB 级，
  // 因此按状态预算上限自适应 coarsen 价格粒度，并对缓冲区做复用（每轮仅重置，不重复分配）。
  const C = maxItems;
  const K = Math.max(1, Math.floor(kcalBudget));
  const MAX_STATES = 1_200_000;
  const yuanBudget = priceBudgetCents / 100;
  const stepsAtFine = Math.max(1, Math.ceil(yuanBudget));
  const maxP = Math.max(1, Math.floor(MAX_STATES / ((K + 1) * (C + 1))) - 1);
  const priceStepYuan = stepsAtFine > maxP ? Math.ceil(stepsAtFine / maxP) : 1; // 元/格
  const P = Math.max(1, Math.floor(yuanBudget / priceStepYuan));

  // 扁平索引：k ∈ [0,K], p ∈ [0,P], c ∈ [0,C]
  const stride1 = C + 1;
  const stride2 = (P + 1) * (C + 1);
  const idx3 = (k: number, p: number, c: number) => k * stride2 + p * stride1 + c;
  const total = (K + 1) * stride2;
  const dp = new Float64Array(total);
  const par = new Int16Array((candidates.length + 1) * total);
  const maxUsable = candidates.length;

  const valueOf = (i: MenuItem): number => {
    switch (objective) {
      case 'protein': return i.protein;
      case 'kcal': return -i.kcal;
      case 'price': return -i.priceCents / 100;
      case 'sodium': return -i.sodium / 10;
      case 'fastCarb': return -i.fastCarb / 10;
      case 'carb': return -i.carbohydrate / 10;
      case 'kcal-fill': return i.kcal;          // 热量贴合：硬约束 ≤ 预算下最大化利用（吃满）
      case 'price-fill': return i.priceCents / 100; // 价格贴合：最大化利用（花满）
    }
  };

  // 价格粒度换算：按格向上取整（保守），确保 DP 内累计格数 ≥ 实际总价，杜绝取整累积绕过预算
  const priceStepOf = (it: MenuItem): number => Math.min(P + 1, Math.ceil(it.priceCents / 100 / priceStepYuan));

  // 0/1 双维背包 DP（热量 × 价格格 × 品项数上限），支持禁用物品生成差异方案；缓冲区复用
  function reconstruct(banned: Set<string>): SolveSolution | null {
    const usable = candidates.filter((c) => !banned.has(c.code));
    if (usable.length === 0) return null;
    dp.fill(NEG);
    par.fill(-1);
    dp[0] = 0;
    for (let idx = 0; idx < usable.length; idx++) {
      const it = usable[idx];
      const kcalI = it.kcal;
      const priceI = priceStepOf(it);
      const val = valueOf(it);
      const nxt = dp.slice();
      for (let k = K; k >= kcalI; k--) {
        for (let p = P; p >= priceI; p--) {
          for (let c = C - 1; c >= 0; c--) {
            const from = idx3(k - kcalI, p - priceI, c);
            if (dp[from] <= NEG / 2) continue;
            const to = idx3(k, p, c + 1);
            const cand = dp[from] + val;
            if (cand > nxt[to]) {
              nxt[to] = cand;
              par[(idx + 1) * total + to] = idx;
            }
          }
        }
      }
      for (let j = 0; j < dp.length; j++) dp[j] = nxt[j];
    }
    let bestVal = NEG, bestK = 0, bestP = 0, bestC = 0;
    for (let k = 0; k <= K; k++) {
      for (let p = 0; p <= P; p++) {
        for (let c = 1; c <= C; c++) { // 至少 1 件商品：最小化目标下空集价值恒为 0，必须排除
          const v = dp[idx3(k, p, c)];
          if (v > bestVal) { bestVal = v; bestK = k; bestP = p; bestC = c; }
        }
      }
    }
    if (bestVal <= NEG / 2) return null;
    let k = bestK, p = bestP, c = bestC;
    const chosen: Array<{ item: MenuItem; qty: number }> = [];
    for (let idx = usable.length; idx > 0; idx--) {
      const pi = par[idx * total + idx3(k, p, c)];
      if (pi < 0) continue;
      const it = usable[pi];
      chosen.push({ item: it, qty: 1 });
      k -= it.kcal;
      p -= priceStepOf(it);
      c -= 1;
    }
    if (chosen.length === 0 || chosen.length > maxItems) return null;
    return { items: chosen, metrics: buildMetrics(chosen) };
  }

  function buildMetrics(items: Array<{ item: MenuItem; qty: number }>): Record<MetricKey, number> {
    const metrics = {} as Record<MetricKey, number>;
    for (const m of ['kcal', 'price', 'protein', 'fat', 'carb', 'sodium', 'fastCarb', 'veggie', 'staple'] as MetricKey[]) {
      metrics[m] = metricOf(items, m);
    }
    return metrics;
  }

  // 生成 Top-K 候选池（每轮禁用上一解全部物品），再按用户约束过滤
  const pool: SolveSolution[] = [];
  const banned = new Set<string>();
  let tries = 0;
  for (let round = 0; round < poolSize; round++) {
    const sol = reconstruct(banned);
    tries++;
    if (!sol) break;
    for (const s of sol.items) banned.add(s.item.code); // 无论是否入池都推进禁用集，避免重复解
    // 双保险：DP 内价格为保守粒度，此处用真实分价再校验一次预算
    if (sol.metrics.price > priceBudgetCents || sol.metrics.kcal > kcalBudget) continue;
    pool.push(sol);
  }

  // 多选优化目标（v0.5）：分层字典序——对前 n-1 个目标逐层收敛到各自最优值的量纲容差带，
  // 最后一个目标在带内做最终排序。n=2 时即"第一目标最优带内按第二目标排序"，n=3 时三层递进。
  const objectives: ObjectiveMetric[] = (input.objectives && input.objectives.length > 0
    ? input.objectives
    : [input.objective]).slice(0, 3);

  const passing = pool.filter((sol) =>
    constraints.every((c) => (c.op === '<=' ? sol.metrics[c.metric] <= c.value : sol.metrics[c.metric] >= c.value)),
  );
  if (passing.length > 0) {
    // fill 目标复用既有 metric 数值（kcal-fill↔kcal、price-fill↔price）
    const metricVal = (s: SolveSolution, m: ObjectiveMetric): number =>
      m === 'kcal-fill' ? s.metrics.kcal : m === 'price-fill' ? s.metrics.price : s.metrics[m];
    if (objectives.length >= 2) {
      let band = passing;
      // 前 n-1 层：逐目标收敛（fill 类与蛋白为最大化，其余最小化）
      for (const metric of objectives.slice(0, -1) as ObjectiveMetric[]) {
        const minimize = isMinimize(metric);
        const vals = band.map((s) => metricVal(s, metric));
        const best = minimize ? Math.min(...vals) : Math.max(...vals);
        const tol = tolFor(metric === 'kcal-fill' ? 'kcal' : metric === 'price-fill' ? 'price' : metric, best);
        band = band.filter((s) => (minimize ? metricVal(s, metric) <= best + tol : metricVal(s, metric) >= best - tol));
        if (band.length === 0) band = passing; // 容差带意外为空（数值异常）时回退全池，避免无解
      }
      // 最后一层：决定最终排序（fill 类与蛋白为最大化）；preferCombo 时组合套餐优先
      const last = objectives[objectives.length - 1];
      const lastMax = last === 'protein' || last === 'kcal-fill' || last === 'price-fill';
      const comboCount = (s: SolveSolution) => s.items.filter((i) => i.item.isCombo).length;
      band.sort((a, b) => {
        const primary = lastMax ? metricVal(b, last) - metricVal(a, last) : metricVal(a, last) - metricVal(b, last);
        if (primary !== 0) return primary;
        if (input.preferCombo) return comboCount(b) - comboCount(a);
        return 0;
      });
      return { solutions: band.slice(0, 3), feasible: true, scanned: candidates.length, poolTried: tries, objectives };
    }
    // 单目标：按目标重排（DP 已按目标构造，保持池内顺序即可）
    return { solutions: passing.slice(0, 3), feasible: true, scanned: candidates.length, poolTried: tries, objectives };
  }

  // 无解：基于池内最优解解释违反最严重的约束
  let reason: string;
  if (pool.length === 0) {
    reason = '在当前预算与品项上限内找不到可行组合，请放宽预算或提高品项上限。';
  } else {
    const best = pool[0];
    const violated = constraints
      .map((c) => ({ c, actual: best.metrics[c.metric] }))
      .filter(({ c, actual }) => (c.op === '<=' ? actual > c.value : actual < c.value))
      .sort((a, b) => Math.abs(b.actual - b.c.value) - Math.abs(a.actual - a.c.value));
    if (violated.length > 0) {
      reason = `在满足热量与价格预算的最优组合池（${pool.length} 个候选）中，最接近的方案是「${best.items.map((i) => i.item.name).join(' + ')}」，但仍无法满足：` +
        violated.slice(0, 3).map(({ c, actual }) => `${METRIC_LABEL[c.metric]} 实际 ${actual}${c.op === '<=' ? ' > 上限' : ' < 下限'} ${c.value}`).join('；') +
        '。可尝试放宽该约束、更换门店或调整优化目标。';
    } else {
      reason = '未找到满足全部约束的组合，请放宽约束。';
    }
  }
  return { solutions: [], feasible: false, reason, scanned: candidates.length, poolTried: tries };
}
