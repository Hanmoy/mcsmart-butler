// 统一整数优化引擎（MILP + HiGHS）——v6 内核（v1.2 可靠性修正轮）
// 三层语义分离（docs/GROUP_KERNEL_MILP_DESIGN.md v1.2 §九，用户拍板）：
//   买到了什么（buy/sel）→ 分给谁（asg 分配层，v6 恢复）→ 满足了谁哪条需求（dem 声明层）。
//   同一份食物至多被一条需求声明（声明 ≤ 分配），但可作为额外食物分配给成员（宜多不宜少）。
//   单人无心愿场景：食品默认归本人（由「最小化剩余」阶段自然实现），
//   主食/热量/价格/度量硬约束作用于「所得（asg）」——修复 v5 的 ¥13 饮料冒充正餐回归。
// 约束层级（用户拍板默认规则）：
//   硬约束：预算上限、明确营养上限（kcalCap/hardPriceCap/metrics）、禁忌、真实限购、
//           套餐选配规则、「恰好」型与 must 型需求、主食下限（单人正餐默认）。
//           v1.2：含营养上限（≤ 型）的成员不分配营养未收录品项——缺失 ≠ 0。
//   软需求：min 型心愿带缺口变量 gap——字典序 = 最不满意成员缺口最小 → 全体缺口最小
//           → （用户目标，可选）→ 最低价 → 最小剩余。覆盖率恒以原始需求为分母。
//   富余上限：需求声明数 ≤ qty + cap（单人 strictSurplus: cap=qty；多人 cap=qty+max(1,⌈qty/2⌉)）。
//   价格预算是上限不是目标：删除 price-fill（不奖励花满预算）。
// 目标方向（v1.2 修正）：「更少」型目标 = minimize(metric)、「更多」型 = maximize(metric)；
//   阶段锁定约束用正系数 + 对应不等号方向（旧实现负系数×minimize 双重取反 + 锁定恒真）。
// 热量语义（v1.2 明确）：cheapest → kcalBudget 硬上限；fit → 目标值，
//   最小化 |整桌热量 − 目标|，锁定带 = [目标−最优偏差, 目标+最优偏差]（只留并列解）。
// strictCover（v1.2 修正）：券品项必须全数分配给成员（无 lo → sel=asg），不再要求逐项承接心愿
//   ——单人无心愿条目时券同样可选；覆盖率仍由声明层如实计量。
// Top-K：no-good 割迭代求解，按「食物内容签名」（剔玩具/排列）去重，最多 K 个真实不同购物篮。
// 诚实边界不变：模型最优 ≠ 渠道核价；各阶段均最优才标 proven-optimal。
// 求解器：highs（v1.15，WASM，MIT）。
import { specTitleFromRaw } from './officialNutrition.js';
import { matchNutrition, type NutritionRow } from './nutrition.js';
import { resolveComponentNutrition } from './nutritionSupplements.js';
import { CONFIG } from './config.js';
import { foodKeyOf, foodMultisetSignature, normSpecKey, specOfName, type FoodUnitRef } from './foodIdentity.js';

export interface MealOption {
  name: string;
  kcal: number;
  /** false = 营养未知（kcal 值不可信）；undefined 视为已知 */
  kcalKnown?: boolean;
  priceCents: number;
  diffCents: number;
  staple: boolean;
  veggie: boolean;
  code?: string;
  fastCarb?: number;
  drink?: boolean;
  /** 含糖饮料判定（三态）：true=确认含糖，false=确认不含糖，undefined=未知。
   *  noSugaryDrink 成员不得被分配「含糖或含糖未知」的饮料（未知按保守处理，不当作满足需求）。 */
  sugary?: boolean;
  /** 非食品（玩具/餐具等）：可作购买选项展示，不计入营养聚合、去重签名与多样性统计 */
  nonFood?: boolean;
  protein?: number; fat?: number; carbohydrate?: number; sodium?: number;
  /** 营养来源说明（补录命中时透出，便于审计「该值来自哪里」） */
  nutritionSource?: string;
  /** v1.4.4 R04：营养值来自估算/区间（仅作参照）——不得作为严格达标结论的依据 */
  estimated?: boolean;
  /** v1.4.4 R04：营养补录未覆盖的字段（这些字段的 0 是占位，不得按 0 参与上限/达标判断） */
  unknownNutrition?: string[];
  /** v1.4.4 R11：快碳值是否可信（独立判定）；缺省时由内核按「含糖三态/营养已知」保守推导 */
  fastCarbKnown?: boolean;
  /** v1.4.4 R07：规格限定选项的规格标签（如「大」）。仅由合成的规格限定计划设置，
   *  且只承接同规格的心愿需求。 */
  specLabel?: string;
  /** v1.4.5 W03：券面声明了补差但无法归因到本选项——diffCents=0 是占位，不代表免费 */
  diffUnknown?: boolean;
  /** v1.4.6 R01：官方渠道换选差价（证据字段；券价不含此项） */
  officialDiffCents?: number;
}

export interface MealSlot {
  roundName: string;
  roundId?: string;
  defaultName?: string;
  options: MealOption[];
}

export interface ComboPlan {
  id: string;
  channel: 'mcd-mcp' | 'meituan-cps' | 'user';
  name: string;
  basePriceCents: number;
  slots: MealSlot[];
  maxQty: number;
  maxQtySource?: 'program-cap' | 'voucher-limit';
  isExternalCoupon?: boolean;
  strictCover?: boolean;
  /** v1.4.10 W02：对外履约编码（父 SKU）。规格型单品计划内部 id 为 `mcd-spec-…`，
   *  核价/下单必须用父商品 code + roundList，不能把内部计划名当 productCode 发出。 */
  fulfillCode?: string;
  /** 规格计划：规格轮次 id（与 fulfillCode 搭配生成 roundList） */
  fulfillRoundId?: string;
  /** 规格计划缺少官方规格轮次证据：补差按 0 处理，价格只能作参考（不得声称该规格真实售价） */
  specPriceUnverified?: boolean;
  /** v1.4.8 R04：本券**整包引用**的官方套餐 code（券面只有一条 combo-ref 且 qty=1）。
   *  有此证据的券可独立承接「套餐心愿」，而不必再额外购买官方套餐。
   *  少槽/多槽/不同规格的券不会设置该字段（不得冒充同款）。 */
  officialComboCode?: string;
  /** v1.4.9（R04 边界）：券面含几份同款官方套餐。仅 copies=1 才允许独立承接套餐心愿；
   *  多份券需份数精确匹配，本轮按「券 + 官方套餐」组合求解。 */
  officialComboCopies?: number;
}

/** 品类心愿（v1.4.10 W04）：饮料/汉堡/小食/甜品等类目需求。
 *  与具体商品需求分开：类目只约束「必须是这一类里的合法食品」，具体规格/禁忌仍由选项属性把关。 */
export type FoodCategory = 'drink' | 'staple' | 'side' | 'dessert';

export interface DemandUnit {
  id: string;
  keyword: string;
  code?: string;
  qty: number;
  exact?: boolean;        // 恰好 qty 份（硬约束）
  must?: boolean;         // 必须满足（硬 ≥qty）
  comboPlanId?: string;
  /** v1.4.10 W03：泛称套餐心愿的**候选套餐集合**（如「巨无霸套餐」可能对应三件套/四件套/精选）。
   *  旧实现只绑定 findMenuItem 命中的单个最低价 SKU，其余真实套餐永远无法承接该心愿。 */
  comboPlanIds?: string[];
  /** 心愿明确「三件套/四件套」时的结构要求（槽位数），不满足者不得冒充完整套餐 */
  comboSlotCount?: number;
  /** 心愿里的件数标记（如「四件套」）：候选套餐名必须带同一标记（真实菜单里件数与轮次数可能不等） */
  comboPieceToken?: string;
  /** v1.4.10 W05：**单品心愿**恰好只能由套餐承接时（门店无该单点 SKU），只要求该食品所在轮次，
   *  其余槽位不强制归同一人——同桌成员可以合法换选（如甲吃汉堡、乙要大薯条），
   *  避免「整餐必须归一人」导致乙被迫另买一份大薯条。显式「三件套/套餐」心愿不设此字段。 */
  comboFocusSlot?: string;
  /** v1.4.10 W04：品类需求（drink/staple/side/dessert） */
  category?: FoodCategory;
  /** v1.4.4 R07：心愿声明的规格（如「大」「中」「2块」）。带规格的心愿**只能由同规格选项承接**——
   *  不得用默认规格替代，规格营养与硬上限必须与提示同口径。 */
  specLabel?: string;
}

export type MetricName = 'kcal' | 'protein' | 'fat' | 'carbohydrate' | 'sodium' | 'veggie' | 'staple' | 'fastCarb';
export interface MetricConstraint { metric: MetricName; op: '>=' | '<='; value: number }

export interface MemberReq {
  alias: string;
  demands?: DemandUnit[];
  mustHave?: string[];      // 兼容：转为 must 型硬需求（qty=1）
  taboo?: string[];
  noSugaryDrink?: boolean;
  kcalCap?: number;
  stapleMin?: number;
  hardPriceCapCents?: number;
  metrics?: MetricConstraint[];
}

export type ObjectiveMetric = 'protein' | 'fat' | 'carbohydrate' | 'sodium' | 'fastCarb' | 'veggie';
/** 用户优先级目标（按顺序执行，≤2）：'price' = 更省钱（价格段前移），其余为营养度量（作用于购买篮） */
export type PriorityGoal = ObjectiveMetric | 'price';

// ---------- 度量名归一化（v1.4.2 R01） ----------
// 规范度量名集合（与 service 层约定一致）：protein | fat | carbohydrate | sodium | fastCarb | veggie | staple | kcal。
// 上层历史入口可能传 carb（见 service.ts 的 VALID_METRICS/VALID_OBJECTIVES），
// 若不归一，metricValueOf() 落到 switch 之外返回 undefined → 作为 LP 系数写入 → HiGHS 报
// 「Unable to read LP model ... error -1」。此处统一别名归一，未知值显式报错（绝不静默当 0）。
const VALID_METRIC_NAMES: ReadonlyArray<MetricName> = ['protein', 'fat', 'carbohydrate', 'sodium', 'fastCarb', 'veggie', 'staple', 'kcal'];
const VALID_OBJECTIVE_METRICS: ReadonlyArray<ObjectiveMetric> = ['protein', 'fat', 'carbohydrate', 'sodium', 'fastCarb', 'veggie'];
const METRIC_ALIAS: Readonly<Record<string, string>> = { carb: 'carbohydrate', carbs: 'carbohydrate' };

function normalizeMetricName(raw: string): MetricName {
  const v = METRIC_ALIAS[raw] ?? raw;
  if ((VALID_METRIC_NAMES as ReadonlyArray<string>).includes(v)) return v as MetricName;
  throw new Error(`未知营养度量「${raw}」：合法值为 ${VALID_METRIC_NAMES.join(' | ')}（carb/carbs 会自动归一为 carbohydrate）`);
}

function normalizePriorityGoal(raw: string): PriorityGoal {
  if (raw === 'price') return 'price';
  const v = METRIC_ALIAS[raw] ?? raw;
  if ((VALID_OBJECTIVE_METRICS as ReadonlyArray<string>).includes(v)) return v as ObjectiveMetric;
  throw new Error(`未知优化目标「${raw}」：合法值为 price | ${VALID_OBJECTIVE_METRICS.join(' | ')}（carb/carbs 会自动归一为 carbohydrate）`);
}

/** 入口归一（optimize / optimizeTopK 共用）：把 priorities 与各成员 metrics 的度量名归一到规范集合。
 *  幂等：已规范的输入原样返回；未知度量名抛出明确错误（列出合法值）。 */
export function normalizeOptimizeInput(input: OptimizeInput): OptimizeInput {
  const members = input.members.map((m) => (m.metrics && m.metrics.length > 0
    ? { ...m, metrics: m.metrics.map((c) => ({ ...c, metric: normalizeMetricName(String(c.metric)) })) }
    : m));
  const priorities = input.priorities && input.priorities.length > 0
    ? input.priorities.map((g) => normalizePriorityGoal(String(g)))
    : input.priorities;
  return { ...input, members, ...(priorities ? { priorities } : {}) };
}

/** LP 系数写入前的防御（R01）：任何非有限数（undefined / NaN / Infinity）立即抛错并指明度量与计划，
 *  绝不静默进入模型（旧实现把 undefined 当系数 → HiGHS error -1，无法定位来源）。 */
function assertFiniteNumber(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${what}取值无效（${String(value)}）——营养数据缺失或度量名未知，已拒绝写入 LP 系数`);
  }
  return value;
}

export interface OptimizeInput {
  plans: ComboPlan[];
  members: MemberReq[];
  totalBudgetCents?: number;
  kcalBudget?: number;         // fit 模式 = 贴合目标；cheapest = 硬上限
  mode: 'cheapest' | 'fit';
  fitToleranceKcal?: number;
  /** 用户优先级（有序，≤2）：如 ['sodium','price'] = 先钠最少、同等钠下更省钱 */
  priorities?: PriorityGoal[];
  strictSurplus?: boolean;     // 单人更严：富余声明上限 = qty
  externalCouponLimit?: number; // 整单外部券上限（程序搜索上限，默认 1；非平台规则，评审三轮 #1）
}

export interface SlotChoice {
  roundName: string;
  roundId?: string;
  chosenName: string;
  optionCode?: string;
  /** v1.4.7 R03：规格标签（大/中/小份等）。无 optionCode 时与名称共同构成食品身份，
   *  不得再用热量近似规格身份。 */
  specLabel?: string;
  kcal: number;
  kcalKnown?: boolean;
  refPriceCents: number;
  diffCents: number;
  count: number;
  protein: number;
  fat: number;
  carbohydrate: number;
  sodium: number;
  fastCarb: number;
  /** 营养来源说明：补录命中/菜单营养来源，供购买清单审计 */
  nutritionSource?: string;
  /** v1.4.4 R04：估算值仅供参考，不支持严格达标结论 */
  estimated?: boolean;
  /** 未知的营养字段；对应占位数值不构成达标证据 */
  unknownNutrition?: string[];
  /** true = 非食品（玩具等）：展示用，不计入营养聚合与去重签名 */
  nonFood?: boolean;
  /** v1.4.6 R01：官方渠道换选差价（证据字段；券价/分账不含此项） */
  officialDiffCents?: number;
}

export interface PlanAssignment {
  planId: string;
  channel: ComboPlan['channel'];
  planName: string;
  qty: number;
  basePriceCents: number;
  slotChoices: SlotChoice[];
  units: Array<{ unitIndex: number; slotChoices: SlotChoice[] }>;
  unitKcal: number;
  maxQtySource?: ComboPlan['maxQtySource'];
}

export interface MemberAllocation {
  alias: string;
  items: Array<{
    fromPlanId: string; planName: string; itemName: string; qty: number; kcal: number; refPriceCents: number; slotRound: string;
    kcalKnown?: boolean; optionCode?: string; specLabel?: string; nutritionSource?: string; estimated?: boolean; unknownNutrition?: string[];
  }>;
  kcal: number;
  /** v1.4.11 W01：本人**实际分配**的宏量（与 asg 同源），用于区分整篮营养与本人摄入。 */
  protein: number; fat: number; carbohydrate: number; sodium: number;
  refPriceCents: number;
  staple: number;
  veggie: number;
  unmetMustHave: string[];
  demands: Array<{ id: string; keyword: string; qty: number; exact?: boolean; claimed: number; satisfied: boolean }>;
}

export interface UnmetDemand {
  memberIdx: number;
  alias: string;
  demandId: string;
  keyword: string;
  reason: 'no-candidate' | 'kcal-unknown' | 'unsatisfied';
  /** v1.4.10 W07：缺口份数（unsatisfied 时为 qty−claimed；无候选时为整份 qty）。
   *  出口（购买清单/分账/复制文本）共用同一份结构化缺口，不再只靠 warnings 字符串。 */
  missingQty?: number;
}

export interface OptimizeResult {
  status: 'proven-optimal' | 'feasible' | 'infeasible';
  assignments: PlanAssignment[];
  memberAllocations: MemberAllocation[];
  leftovers: Array<{ planId: string; planName: string; itemName: string; qty: number; refPriceCents: number; kcal: number }>;
  unmetDemands: UnmetDemand[];
  coverage: { total: number; met: number };
  gapTotal: number;
  totals: { priceCents: number; kcal: number; staple: number; veggie: number; leftoverCents: number };
  notes: string[];
  lpStats: { vars: number; rows: number };
  /** 本解的**完整购物篮割**：覆盖模型内全部计划（未购计划 qty=0、counts=[]）的食品配置。
   *  v1.4.2 R05：以「整篮」为单位打破割（至少一个计划配置变化即可），不再逐计划强制变化，
   *  从而保留「A 不变、B→C」等合法购物篮；数量扩展/换品保留为合法候选，玩具变体自动落在割内。 */
  solutionPlanCuts: PlanNoGoodCut[];
  /** v1.4：营养完整性（区分真实 0 与未知）——缺热量的食品清单 + 已知部分热量合计。
   *  营养不完整时前端不得显示完整热量进度/绿色达标；该组合可单列为「价格参考方案」。 */
  nutritionCompleteness?: {
    complete: boolean;
    unknownItems: string[];
    knownKcal: number;
    totalKcal: number;
    unknownCount: number;
  };
}

// ---------- LP 构建 ----------

interface LpRow { name: string; coeffs: Array<{ v: number; c: number }>; sense: '=' | '<=' | '>='; rhs: number }

function escName(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').slice(0, 22) || 'x';
}

class LpModel {
  varIndex = new Map<string, number>();
  varNames: string[] = [];
  isInt: boolean[] = [];
  ubs: Array<number | undefined> = [];
  obj: number[] = [];
  rows: LpRow[] = [];
  addVar(name: string, objCoeff: number, integer = true, ub?: number): number {
    const existing = this.varIndex.get(name);
    if (existing !== undefined) return existing;
    const i = this.varNames.length;
    this.varNames.push(name); this.isInt.push(integer); this.obj.push(objCoeff); this.ubs.push(ub);
    this.varIndex.set(name, i);
    return i;
  }
  addRow(name: string, coeffs: Array<{ v: number; c: number }>, sense: '=' | '<=' | '>=', rhs: number): void {
    this.rows.push({ name, coeffs, sense, rhs });
  }
  build(sense: 'min' | 'max'): string {
    const L: string[] = [];
    L.push(sense === 'min' ? 'Minimize' : 'Maximize');
    const terms: string[] = [];
    this.varNames.forEach((n, i) => { if (this.obj[i] !== 0) terms.push(`${this.obj[i] >= 0 ? '+ ' : '- '}${Math.abs(this.obj[i])} ${n}`); });
    L.push(` obj: ${terms.length > 0 ? terms.join(' ') : '0 x0'}`);
    L.push('Subject To');
    this.rows.forEach((r, i) => {
      const t = r.coeffs.map((c) => `${c.c >= 0 ? '+ ' : '- '}${Math.abs(c.c)} ${this.varNames[c.v]}`);
      L.push(` c${i}_${r.name}: ${t.length > 0 ? t.join(' ') : '0 x0'} ${r.sense} ${r.rhs}`);
    });
    L.push('Bounds');
    this.varNames.forEach((n, i) => {
      L.push(` ${n} >= 0`);
      if (this.ubs[i] !== undefined) L.push(` ${n} <= ${this.ubs[i]}`);
    });
    L.push('Generals');
    const ints = this.varNames.filter((_, i) => this.isInt[i]);
    L.push(` ${ints.length > 0 ? ints.join(' ') : 'x0'}`);
    L.push('End');
    return L.join('\n');
  }
}

// ---------- 建模 ----------

interface InstMeta {
  p: number; r: number; o: number;
  kcal: number; kcalKnown: boolean;
  /** v1.4.4 R04：营养值来自估算/区间（仅作参照）——不得作为硬约束达标依据 */
  estimated: boolean;
  /** v1.4.4 R04：字段级未知值；不能把占位 0 用作硬约束证据 */
  unknownNutrition: string[];
  /** v1.4.4 R11：快碳值是否可信（独立判定）。饮料在「含糖三态未判定且营养未知」时不可信——
   *  未知饮料不得以 fastCarb=0 通过 fastCarb<=0 这类硬上限。 */
  fastCarbKnown: boolean;
  refPriceCents: number; diffCents: number;
  /** v1.4.6 R01：官方渠道的换选差价（仅证据/展示用，**不参与券价计算**）。
   *  券的核销补差必须来自券面证据；官方渠道的减价不是券的退款/补差规则。 */
  officialDiffCents?: number;
  staple: boolean; veggie: boolean;
  fastCarb: number; drink: boolean; sugary?: boolean;
  nonFood: boolean;
  nutritionSource?: string;
  protein: number; fat: number; carbohydrate: number; sodium: number;
  optName: string; optCode?: string;
  planId: string; planName: string; channel: ComboPlan['channel'];
  roundName: string; roundId?: string;
  /** v1.4.4 R07：规格限定选项的规格标签（仅由合成的规格限定计划设置） */
  specLabel?: string;
  strictCover: boolean;
  selVars: number[];
  asgVars: Array<number | undefined>;
  demClaims: Array<{ d: number; v: number; m: number }>;
  loVar?: number;
}

interface DemandMeta {
  di: number; m: number; d: DemandUnit; vars: Array<{ v: number; inst: number }>;
  slots?: Array<Array<number>>;
  /** v1.4.11 W03：完整套餐心愿的「候选计划 × 购买单元」承接变量（每份完整单元一个）。 */
  unitClaims?: Array<{ p: number; u: number; v: number }>;
  gapVar?: number; soft: boolean; candidateBlockedByKcal: boolean;
}

interface BuiltModel {
  lp: LpModel;
  insts: InstMeta[];
  demands: DemandMeta[];
  noCandidate: UnmetDemand[];
  plans: ComboPlan[];
  gapMaxVar?: number;
  /** v1.3：硬需求（恰好/必须）在当前候选池下无候选 → 模型不可行（不再静默跳过） */
  infeasibleHardDemand?: { keyword: string; alias: string };
  /** v1.4：某成员全部候选食品被排除（营养未知/禁忌），但其硬约束要求「至少摄入」
   *  （主食下限 / ≥ 型营养度量）→ 约束不可满足，模型不可行（旧实现 continue 跳过成员约束 → 伪最优） */
  infeasibleMember?: { alias: string; reason: string };
}

/** v1.3 Top-K no-good 割：计划级购买配置（数量 + 食品选项聚合计数）。
 *  语义 = 「排除与该计划配置完全相同的购买组合」，支持：
 *    - 数量扩展（1×A 之后 2×A 仍合法）——数量不等式不匹配 → 不被排除；
 *    - 换品/换轨（同数量不同内容）——计数不等式不匹配 → 不被排除；
 *    - 玩具变体自动排除——计数只含食品选项（剔除非食品），同配置换玩具不构成新解、不占搜索轮次。
 *  旧实现（选中 sel 变量列表 ≤ n-1）会连带排除一切超集（如 2×A），导致合法扩展丢失。 */
export interface PlanNoGoodCut {
  p: number;                                    // 方案索引
  qty: number;                                  // 该方案购买单元数
  counts: Array<{ r: number; o: number; n: number }>; // 食品选项聚合计数（Σ_u sel_{p,u,r,o}）
}

const MAX_UNITS = 8;

/** 非食品（玩具/餐具/奖品）：可作购买选项展示，但不参与营养聚合、去重签名与多样性统计 */
const RE_NONFOOD_OPT = /玩具|餐具|奖品/;

/** 需要真实营养数据的度量（营养未收录品项不得按 0 参与上限判断——「缺失 ≠ 0」纪律） */
const METRIC_NEEDS_NUTRITION: Record<MetricName, boolean> = {
  kcal: true, protein: true, fat: true, carbohydrate: true, sodium: true,
  veggie: false, staple: false, fastCarb: false,
};
const NUTRITION_FIELD_BY_METRIC: Partial<Record<MetricName, string>> = {
  kcal: 'kcal', protein: 'protein', fat: 'fat', carbohydrate: 'carbohydrate', sodium: 'sodium',
};
function lacksStrictMetricEvidence(inst: Pick<InstMeta, 'kcalKnown' | 'estimated' | 'unknownNutrition' | 'fastCarbKnown'>, metric: MetricName): boolean {
  if (metric === 'fastCarb') return !inst.fastCarbKnown;
  if (!METRIC_NEEDS_NUTRITION[metric]) return false;
  const field = NUTRITION_FIELD_BY_METRIC[metric];
  return inst.estimated || !field || inst.unknownNutrition.includes(field);
}

function normName(s: string): string {
  return s.replace(/[（(【\[].*?[)）】\]]/g, '').replace(/\s+/g, '').toLowerCase();
}

function tabooHitOpt(m: MemberReq, optName: string): boolean {
  return (m.taboo ?? []).some((t) => t && normName(optName).includes(normName(t)));
}

const RE_SIDE_NAME = /薯条|薯饼|鸡翅|鸡排|麦乐鸡|鸡块|玉米杯|沙拉|苹果片|派|小食/;
const RE_DESSERT_NAME = /新地|旋风|圆筒|冰淇淋|奶冻|爆珠|派|阿芙佳朵/;

/** 品类需求匹配（v1.4.10 W04）：类目只约束食品类别，具体品项由求解器选（含套餐槽位/券食品）。 */
function instCategoryMatches(inst: InstMeta, cat: FoodCategory): boolean {
  switch (cat) {
    case 'drink': return inst.drink;
    case 'staple': return inst.staple;
    case 'dessert': return RE_DESSERT_NAME.test(inst.optName);
    case 'side': return !inst.drink && !inst.staple && RE_SIDE_NAME.test(inst.optName);
    default: return false;
  }
}

function optionSatisfiesDemand(inst: InstMeta, d: DemandUnit): boolean {

  // v1.4.10 W05：规格按归一化词比较（大/大份/大薯 等价），且不再要求履约 code 完全一致——
  //   官方套餐槽位 code（4820 大薯条）与单点 code（4810）可能是同一份食品，
  //   旧实现用原始 code 门禁把合法换选挡在承接之外。购买/核价仍使用各路径自己的 code。
  const wantSpec = normSpecKey(d.specLabel);
  const instSpec = normSpecKey(inst.specLabel) || specOfName(inst.optName);
  if (wantSpec && instSpec !== wantSpec) return false;  // v1.4.10 W04：品类需求（饮料/汉堡/小食/甜品）
  if (d.category) return instCategoryMatches(inst, d.category);
  if (d.code) {
    const a = foodKeyOf({ code: inst.optCode, name: inst.optName, spec: inst.specLabel });
    const b = foodKeyOf({ code: d.code, name: d.keyword, spec: d.specLabel });
    if (a === b) return true;
  }
  const a = normName(inst.optName), b = normName(d.keyword);
  if (!a || !b) return false;
  return a === b || (b.length >= 2 && a.includes(b));
}

/** 一个完整购物篮割：覆盖模型内全部计划（未购计划 qty=0、counts=[]）。Top-K 每轮推入一个。 */
type BasketNoGoodCut = PlanNoGoodCut[];

function buildModel(input: OptimizeInput, noGoodCuts: BasketNoGoodCut[] = []): BuiltModel {
  const lp = new LpModel();
  const insts: InstMeta[] = [];
  const plans = input.plans;
  const members = input.members;

  const demandDefs: Array<{ m: number; d: DemandUnit }> = [];
  members.forEach((m, mi) => {
    for (const d of m.demands ?? []) demandDefs.push({ m: mi, d });
    (m.mustHave ?? []).forEach((kw, ki) => {
      demandDefs.push({ m: mi, d: { id: `${escName(m.alias)}-mh-${ki}`, keyword: kw, qty: 1, must: true } });
    });
  });

  // ---- 变量：购买单元 / 槽位选择 / 分配 / 剩余 ----
  for (let p = 0; p < plans.length; p++) {
    const plan = plans[p];
    const units = Math.max(1, Math.min(plan.maxQty > 0 ? plan.maxQty : 1, MAX_UNITS));
    for (let u = 0; u < units; u++) {
      lp.addVar(`buy_${p}_${u}`, 0, true, 1);
      if (u > 0) lp.addRow(`bmono_${p}_${u}`, [{ v: lp.varIndex.get(`buy_${p}_${u}`)!, c: 1 }, { v: lp.varIndex.get(`buy_${p}_${u - 1}`)!, c: -1 }], '<=', 0);
    }
    for (let r = 0; r < plan.slots.length; r++) {
      const slot = plan.slots[r];
      for (let o = 0; o < slot.options.length; o++) {
        const opt = slot.options[o];
        const selVars: number[] = [];
        for (let u = 0; u < units; u++) selVars.push(lp.addVar(`sel_${p}_${u}_${r}_${o}`, 0, true));
        const inst: InstMeta = {
          p, r, o,
          kcal: assertFiniteNumber(opt.kcal, `计划「${plan.name}」选项「${opt.name}」的 kcal `),
          kcalKnown: opt.kcalKnown !== false,
          estimated: !!opt.estimated,
          unknownNutrition: opt.unknownNutrition?.slice() ?? (opt.kcalKnown === false ? ['kcal', 'protein', 'fat', 'carbohydrate', 'sodium'] : []),
          // v1.4.4 R11：快碳可信性独立判定。选项未显式声明时按保守口径推导：
          //   饮料——仅在「含糖三态已判定（sugary !== undefined）」或营养已知时可信；
          //   非饮料——维持既有口径（fastCarb 由菜单启发式给出）。
          fastCarbKnown: opt.fastCarbKnown
            ?? (opt.drink ? (opt.sugary !== undefined || opt.kcalKnown !== false) : true),
          refPriceCents: opt.priceCents, diffCents: opt.diffCents,
          ...(opt.officialDiffCents ? { officialDiffCents: opt.officialDiffCents } : {}),
          staple: opt.staple, veggie: opt.veggie,
          fastCarb: opt.fastCarb ?? 0, drink: !!opt.drink, sugary: opt.sugary,
          nonFood: !!opt.nonFood,
          nutritionSource: opt.nutritionSource,
          protein: opt.protein ?? 0, fat: opt.fat ?? 0, carbohydrate: opt.carbohydrate ?? 0, sodium: opt.sodium ?? 0,
          optName: opt.name, optCode: opt.code,
          planId: plan.id, planName: plan.name, channel: plan.channel,
          roundName: slot.roundName, roundId: slot.roundId,
          ...(opt.specLabel ? { specLabel: opt.specLabel } : {}),
          strictCover: !!plan.strictCover,
          selVars, asgVars: [], demClaims: [],
        };
        if (!plan.strictCover) inst.loVar = lp.addVar(`lo_${p}_${r}_${o}`, 0, true);
        for (let mi = 0; mi < members.length; mi++) {
          const m = members[mi];
          if (tabooHitOpt(m, opt.name)) continue;
          // v1.4.2 R03：含糖未知的饮料按保守处理——不得分配给 noSugaryDrink 成员（仅「确认不含糖」的饮料可分配）
          if (m.noSugaryDrink && opt.drink && opt.sugary !== false) continue;
          if (m.kcalCap != null && lacksStrictMetricEvidence(inst, 'kcal')) continue;
          // 营养硬约束按指标字段逐项核验；缺失值（包括占位 0）和估算值不能作为严格达标证据。
          if ((m.metrics ?? []).some((c) => lacksStrictMetricEvidence(inst, c.metric))) continue;
          inst.asgVars[mi] = lp.addVar(`asg_${p}_${r}_${o}_${mi}`, 0, true);
        }
        insts.push(inst);
      }
    }
  }

  // ---- 约束：槽位选择 = 单元购买 ----
  for (let p = 0; p < plans.length; p++) {
    const plan = plans[p];
    const units = Math.max(1, Math.min(plan.maxQty > 0 ? plan.maxQty : 1, MAX_UNITS));
    for (let u = 0; u < units; u++) {
      for (let r = 0; r < plan.slots.length; r++) {
        const coeffs: Array<{ v: number; c: number }> = [{ v: lp.varIndex.get(`buy_${p}_${u}`)!, c: -1 }];
        for (let o = 0; o < plan.slots[r].options.length; o++) {
          const inst = insts.find((x) => x.p === p && x.r === r && x.o === o);
          if (inst) coeffs.push({ v: inst.selVars[u], c: 1 });
        }
        lp.addRow(`slot_${p}_${u}_${r}`, coeffs, '=', 0);
      }
    }
  }

  // ---- 需求候选与声明变量 ----
  const demands: DemandMeta[] = [];
  const noCandidate: UnmetDemand[] = [];
  // v1.3 修正：声明候选资格与分配候选资格（asgVars 创建条件）必须完全一致——
  // 旧实现 memberCanClaim 漏掉「营养上限成员不得分配营养未收录品项」规则，
  // 导致该类品项只有 dem 声明变量没有 asg 分配变量，关联约束被跳过 →
  // 「没有实际分配却显示需求已满足」。两条规则同一处维护，杜绝再次漂移。
  const memberCanClaim = (m: MemberReq, inst: InstMeta): boolean =>
    !tabooHitOpt(m, inst.optName)
    && !(m.noSugaryDrink && inst.drink && inst.sugary !== false)
    && !(m.kcalCap != null && lacksStrictMetricEvidence(inst, 'kcal'))
    && !((m.metrics ?? []).some((c) => lacksStrictMetricEvidence(inst, c.metric)));

  demandDefs.forEach(({ m, d }, di) => {
    const member = members[m];
    const soft = !d.exact && !d.must;
    const meta: DemandMeta = { di, m, d, vars: [], soft, candidateBlockedByKcal: false };

    if (d.comboPlanId || (d.comboPlanIds && d.comboPlanIds.length > 0)) {
      // v1.4.10 W03：套餐心愿 = **完整购买单元**，候选可以是官方套餐本体或整包引用同一套餐的券。
      //   旧实现只认 findMenuItem 命中的单个 SKU（comboPlanId），泛称「巨无霸套餐」被提前绑到一个
      //   最低价四件套，三件套等真实套餐永远不参与承接。
      const wantedIds = new Set<string>(d.comboPlanIds && d.comboPlanIds.length > 0 ? d.comboPlanIds : [d.comboPlanId!]);
      const candidatePlans: number[] = [];
      plans.forEach((p, i) => {
        if (wantedIds.has(p.id)) {
          // 结构要求：心愿明确「三件套/四件套」时，套餐名必须带同一件数标记，
          //   或槽位数与件数一致（不得用两件餐冒充三件套）
          if (d.comboPieceToken && !normName(p.name).includes(normName(d.comboPieceToken))
            && !(d.comboSlotCount != null && p.slots.length === d.comboSlotCount)) return;
          candidatePlans.push(i);
          return;
        }
        // 整包引用同一官方套餐的券（combo-ref 单份、槽位数一致）同样可承接
        const refCode = p.officialComboCode ? 'mcd-' + p.officialComboCode : '';
        if (!refCode || !wantedIds.has(refCode)) return;
        if (p.officialComboCopies !== undefined && p.officialComboCopies !== 1) return;
        const officialIdx = plans.findIndex((x) => x.id === refCode);
        if (officialIdx < 0) return;
        if (p.slots.length !== plans[officialIdx].slots.length) return;
        if (d.comboPieceToken && !normName(p.name).includes(normName(d.comboPieceToken))
          && !(d.comboSlotCount != null && p.slots.length === d.comboSlotCount)) return;
        candidatePlans.push(i);
      });
      if (candidatePlans.length === 0) {
        noCandidate.push({ memberIdx: m, alias: member.alias, demandId: d.id, keyword: d.keyword, reason: 'no-candidate', missingQty: d.qty });
        demands.push(meta);
        return;
      }
      const focusSlot = d.comboFocusSlot;
      if (focusSlot) {
        // v1.4.10 W05：单品心愿只要求「该食品所在轮次」被本人拿到；其余槽位不绑定本人。
        // v1.4.11 W03：候选套餐可能把该轮次放在不同下标——按**轮次名**收集为同一个承接组，
        //   不得按 rIdx 生成多组（多组是 AND 语义，会被迫同时买两份）。
        const vs: Array<number> = [];
        let blocked = false;
        for (const pIdx of candidatePlans) {
          for (const inst of insts.filter((x) => x.p === pIdx && x.roundName === focusSlot)) {
            if (!memberCanClaim(member, inst)) { blocked = true; continue; }
            const instIdx = insts.indexOf(inst);
            const v = lp.addVar(`dem_${di}_${inst.p}_${inst.r}_${inst.o}`, 0, true);
            meta.vars.push({ v, inst: instIdx });
            inst.demClaims.push({ d: di, v, m });
            vs.push(v);
          }
        }
        meta.slots = [vs];
        if (vs.length === 0) {
          if (blocked) meta.candidateBlockedByKcal = true;
          noCandidate.push({
            memberIdx: m, alias: member.alias, demandId: d.id, keyword: d.keyword,
            reason: meta.candidateBlockedByKcal ? 'kcal-unknown' : 'no-candidate', missingQty: d.qty,
          });
        }
      } else {
        // v1.4.11 W03：完整套餐心愿 = 一个**完整购买单元**，候选套餐各自独立承接。
        //   旧实现按「全部候选的最大槽数」建槽位变量组（三件套心愿被迫满足第四槽），
        //   且同一组可跨套餐拼槽（A 的堡 + B 的水也算一份完整套餐）。
        //   现在每个候选计划各建购买单元承接变量 dunit_{p,u}：≤ buy_{p,u}，
        //   且该计划**每个槽位**都必须有本人实际分配（Σasg ≥ Σdunit），
        //   跨计划拼槽不可能满足同一份套餐。
        const unitClaims: NonNullable<DemandMeta['unitClaims']> = [];
        let blockedByKcal = false;
        for (const pIdx of candidatePlans) {
          const plan = plans[pIdx];
          const units = Math.max(1, Math.min(plan.maxQty > 0 ? plan.maxQty : 1, MAX_UNITS));
          const slotAsgVars: number[][] = [];
          let blocked = false;
          for (let r = 0; r < plan.slots.length; r++) {
            const avs: number[] = [];
            for (const inst of insts.filter((x) => x.p === pIdx && x.r === r)) {
              if (!memberCanClaim(member, inst)) {
                if (inst.kcalKnown === false) blockedByKcal = true;
                continue;
              }
              const av = inst.asgVars[m];
              if (av !== undefined) avs.push(av);
            }
            slotAsgVars.push(avs);
            if (avs.length === 0) blocked = true;
          }
          if (blocked) continue;
          const claims: number[] = [];
          for (let u = 0; u < units; u++) {
            const buyVar = lp.varIndex.get(`buy_${pIdx}_${u}`);
            if (buyVar === undefined) continue;
            const v = lp.addVar(`dunit_${di}_${pIdx}_${u}`, 0, true, 1);
            lp.addRow(`dunit_buy_${di}_${pIdx}_${u}`, [{ v, c: 1 }, { v: buyVar, c: -1 }], '<=', 0);
            claims.push(v);
          }
          if (claims.length === 0) continue;
          unitClaims.push(...claims.map((v, u) => ({ p: pIdx, u, v })));
          slotAsgVars.forEach((avs, r) => {
            lp.addRow(`dunit_slot_${di}_${pIdx}_${r}`,
              [...avs.map((v) => ({ v, c: 1 })), ...claims.map((v) => ({ v, c: -1 }))], '>=', 0);
          });
        }
        meta.unitClaims = unitClaims;
        if (blockedByKcal) meta.candidateBlockedByKcal = true;
        if (unitClaims.length === 0) {
          noCandidate.push({
            memberIdx: m, alias: member.alias, demandId: d.id, keyword: d.keyword,
            reason: meta.candidateBlockedByKcal ? 'kcal-unknown' : 'no-candidate', missingQty: d.qty,
          });
        }
      }
    } else {
      for (let ii = 0; ii < insts.length; ii++) {
        const inst = insts[ii];
        if (!optionSatisfiesDemand(inst, d)) continue;
        if (!memberCanClaim(member, inst)) {
          if (inst.kcalKnown === false) meta.candidateBlockedByKcal = true;
          continue;
        }
        const v = lp.addVar(`dem_${di}_${inst.p}_${inst.r}_${inst.o}`, 0, true);
        meta.vars.push({ v, inst: ii });
        inst.demClaims.push({ d: di, v, m });
      }
      if (meta.vars.length === 0) {
        noCandidate.push({
          memberIdx: m, alias: member.alias, demandId: d.id, keyword: d.keyword,
          reason: meta.candidateBlockedByKcal ? 'kcal-unknown' : 'no-candidate', missingQty: d.qty,
        });
      }
    }
    demands.push(meta);
  });

  // ---- 约束：守恒（单元选择 = 分配 + 剩余）----
  for (const inst of insts) {
    const coeffs: Array<{ v: number; c: number }> = inst.selVars.map((v) => ({ v, c: 1 }));
    for (const av of inst.asgVars) if (av !== undefined) coeffs.push({ v: av, c: -1 });
    if (inst.loVar !== undefined) coeffs.push({ v: inst.loVar, c: -1 });
    lp.addRow(`cons_${inst.p}_${inst.r}_${inst.o}`, coeffs, '=', 0);
  }

  // ---- 约束：声明 ≤ 分配（同一成员同一食物实例，声明不超过其所得）----
  // v1.3 防御：分配变量不存在（该成员被约束排除）时，声明变量必须强制为 0——
  // 「需求满足必须有实际分配支撑，实际分配必须来自真实购买」（旧实现直接跳过约束行，
  // 声明变量自由取值 → 空手满足需求）。
  for (const inst of insts) {
    const byMember = new Map<number, Array<number>>();
    for (const claim of inst.demClaims) {
      if (!byMember.has(claim.m)) byMember.set(claim.m, []);
      byMember.get(claim.m)!.push(claim.v);
    }
    for (const [m, vs] of byMember) {
      const av = inst.asgVars[m];
      if (av === undefined) {
        lp.addRow(`claimzero_${inst.p}_${inst.r}_${inst.o}_${m}`, vs.map((v) => ({ v, c: 1 })), '<=', 0);
        continue;
      }
      lp.addRow(`claim_${inst.p}_${inst.r}_${inst.o}_${m}`, [...vs.map((v) => ({ v, c: 1 })), { v: av, c: -1 }], '<=', 0);
    }
  }

  // ---- 约束：「恰好 qty 份」= 本人跨渠道实际所得（v1.4.8 R06）----
  // 旧实现只约束声明变量之和 = qty：买 2 份双堡套餐时成员 asg=1+1（两个槽位各一份），
  // 声明仍可只写 1 → 「恰好一份」显示已满足，实际悄悄多分了一份；另一备选分四份同样算满足。
  // 现在按**实际分配变量**（asg_{inst,m}）封顶：同一食品身份/同一套餐槽位，本人合计不得超过 qty。
  // 多出来的份数必须显式留作剩余或分给其他成员（不得静默塞给同一人）。
  for (const dm of demands) {
    if (!dm.d.exact) continue;
    const m = dm.m;
    if (dm.unitClaims) {
      // v1.4.11 W03：完整套餐承接变量本身就是「份数」，满足行已用 '=' 固定为 qty，
      //   无需再按槽位另设上限（旧 slots 路径的跨槽重复计数问题不再存在）。
      continue;
    }
    if (dm.slots) {
      const groups = new Map<string, number[]>();
      for (const { inst } of dm.vars) {
        const it = insts[inst];
        const av = it.asgVars[m];
        if (av === undefined) continue;
        const key = `${it.p}|${it.r}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(av);
      }
      let gi = 0;
      for (const avs of groups.values()) {
        lp.addRow(`exact_${dm.di}_s${gi++}`, avs.map((v) => ({ v, c: 1 })), '<=', dm.d.qty);
      }
    } else {
      const avs: number[] = [];
      for (const { inst } of dm.vars) {
        const av = insts[inst].asgVars[m];
        if (av !== undefined) avs.push(av);
      }
      if (avs.length > 0) lp.addRow(`exact_${dm.di}`, avs.map((v) => ({ v, c: 1 })), '<=', dm.d.qty);
    }
  }

  // ---- 约束：需求满足（硬：exact/must；软：+ gap）与富余上限 ----
  // v1.3 修正（评审复现表）：
  //   软需求无候选 → 缺口变量固定计满（gap >= qty），空购物篮不再按缺口 0 与完整方案混排；
  //   硬需求（恰好/必须）无候选 → 直接判不可行（infeasibleHardDemand），不再静默跳过。
  let hasSoft = false;
  let infeasibleHardDemand: { keyword: string; alias: string } | null = null;
  let infeasibleMember: { alias: string; reason: string } | null = null;
  demands.forEach((dm) => {
    const allVars = dm.slots ? dm.slots.flat() : dm.unitClaims ? dm.unitClaims.map((x) => x.v) : dm.vars.map((x) => x.v);
    if (dm.slots) {
      dm.slots.forEach((vs, si) => {
        if (vs.length === 0) return;
        if (dm.soft) {
          hasSoft = true;
          dm.gapVar = lp.addVar(`gap_${dm.di}`, 0, true);
          lp.addRow(`dmd_${dm.di}_s${si}`, [...vs.map((v) => ({ v, c: 1 })), { v: dm.gapVar, c: 1 }], '>=', dm.d.qty);
        } else {
          lp.addRow(`dmd_${dm.di}_s${si}`, vs.map((v) => ({ v, c: 1 })), dm.d.exact ? '=' : '>=', dm.d.qty);
        }
      });
      // v1.3：任一槽位无候选（该槽需求无法承接）
      if (dm.slots.some((vs) => vs.length === 0)) {
        if (dm.soft) {
          hasSoft = true;
          dm.gapVar = lp.addVar(`gap_${dm.di}`, 0, true);
          lp.addRow(`dmd_${dm.di}_nocand`, [{ v: dm.gapVar, c: 1 }], '>=', dm.d.qty); // 全量缺口
        } else {
          infeasibleHardDemand = { keyword: dm.d.keyword, alias: members[dm.m].alias };
        }
      }
    } else if (allVars.length > 0) {
      if (dm.soft) {
        hasSoft = true;
        dm.gapVar = lp.addVar(`gap_${dm.di}`, 0, true);
        lp.addRow(`dmd_${dm.di}`, [...allVars.map((v) => ({ v, c: 1 })), { v: dm.gapVar, c: 1 }], '>=', dm.d.qty);
      } else {
        lp.addRow(`dmd_${dm.di}`, allVars.map((v) => ({ v, c: 1 })), dm.d.exact ? '=' : '>=', dm.d.qty);
      }
    } else {
      // 完全无候选
      if (dm.soft) {
        hasSoft = true;
        dm.gapVar = lp.addVar(`gap_${dm.di}`, 0, true);
        lp.addRow(`dmd_${dm.di}_nocand`, [{ v: dm.gapVar, c: 1 }], '>=', dm.d.qty); // 全量缺口
      } else {
        infeasibleHardDemand = { keyword: dm.d.keyword, alias: members[dm.m].alias };
      }
    }
    // 富余上限（非 exact；套餐意图按槽位分别计——三槽各承接 1 份 ≠ 全局富余 3 份，评审二轮修正）
    if (!dm.d.exact && allVars.length > 0) {
      const cap = input.strictSurplus ? dm.d.qty : dm.d.qty + Math.max(1, Math.ceil(dm.d.qty / 2));
      if (dm.slots) {
        dm.slots.forEach((vs, si) => {
          if (vs.length > 0) lp.addRow(`surplus_${dm.di}_s${si}`, vs.map((v) => ({ v, c: 1 })), '<=', cap);
        });
      } else {
        lp.addRow(`surplus_${dm.di}`, allVars.map((v) => ({ v, c: 1 })), '<=', cap);
      }
    }
  });

  // ---- 阶段 1 变量：最不满意成员缺口 M ----
  let gapMaxVar: number | undefined;
  if (hasSoft) {
    gapMaxVar = lp.addVar('gapmax', 0, true);
    for (let mi = 0; mi < members.length; mi++) {
      const memberGaps = demands.filter((dm) => dm.m === mi && dm.gapVar !== undefined).map((dm) => dm.gapVar!);
      if (memberGaps.length === 0) continue;
      lp.addRow(`mgap_${mi}`, [...memberGaps.map((v) => ({ v, c: 1 })), { v: gapMaxVar, c: -1 }], '<=', 0);
    }
  }

  // ---- 券严格承接（v1.2 语义修正）----
  // strictCover 只保留「实际分给谁」的约束：券品项必须全数分配给成员（建模上无 lo 变量 →
  // 守恒行 Σsel = Σasg 自动成立），不再要求逐项声明承接某条心愿——
  // 旧实现 Σasg = Σdem 使单人（无心愿条目）或券内食品多于心愿时券永远选不中。
  // 「满足哪条心愿」由声明层（dem，≤ 分配）独立如实计量，不虚增覆盖率。

  // ---- 成员硬约束（作用于所得 asg）----
  const metricVal = (inst: InstMeta, metric: MetricName): number => {
    let val: number;
    switch (metric) {
      case 'kcal': val = inst.kcal; break;
      case 'protein': val = inst.protein; break;
      case 'fat': val = inst.fat; break;
      case 'carbohydrate': val = inst.carbohydrate; break;
      case 'sodium': val = inst.sodium; break;
      case 'veggie': val = inst.veggie ? 1 : 0; break;
      case 'staple': val = inst.staple ? 1 : 0; break;
      case 'fastCarb': val = inst.fastCarb; break;
      default: val = undefined as unknown as number; break; // 运行时未知度量名 → 下方防御抛错
    }
    return assertFiniteNumber(val, `度量「${String(metric)}」在计划「${inst.planName}」选项「${inst.optName}」`);
  };
  for (let mi = 0; mi < members.length; mi++) {
    const m = members[mi];
    const memberAsgs = insts
      .filter((inst) => inst.asgVars[mi] !== undefined)
      .map((inst) => ({ inst, v: inst.asgVars[mi]! }));
    if (memberAsgs.length === 0) {
      // v1.4 修复（评审第 2 项）：该成员全部候选食品因营养未知/禁忌被排除时，
      // 旧实现直接 continue 跳过成员硬约束 → 返回「零食品、零主食」的伪 proven-optimal。
      // 若其硬约束要求「至少摄入」（主食下限 / ≥ 型营养度量），则该约束不可满足 → 明确判不可行。
      const needsIntake = (m.stapleMin != null && m.stapleMin > 0)
        || (m.metrics ?? []).some((c) => c.op === '>=' && c.value > 0);
      if (needsIntake) {
        infeasibleMember = {
          alias: m.alias,
          reason: '全部候选食品因营养数据缺失或禁忌无法分配给该成员，但其要求至少摄入（主食下限/营养下限）',
        };
      }
      continue;
    }
    if (m.kcalCap != null) lp.addRow(`mcal_${mi}`, memberAsgs.map(({ inst, v }) => ({ v, c: inst.kcal })), '<=', m.kcalCap);
    if (m.stapleMin != null && m.stapleMin > 0) {
      const st = memberAsgs.filter(({ inst }) => inst.staple);
      lp.addRow(`mstaple_${mi}`, st.map(({ v }) => ({ v, c: 1 })), '>=', m.stapleMin);
    }
    if (m.hardPriceCapCents != null) lp.addRow(`mprice_${mi}`, memberAsgs.map(({ inst, v }) => ({ v, c: inst.refPriceCents })), '<=', m.hardPriceCapCents);
    for (const c of m.metrics ?? []) {
      lp.addRow(`mmetric_${mi}_${escName(c.metric)}_${c.op === '>=' ? 'ge' : 'le'}`,
        memberAsgs.map(({ inst, v }) => ({ v, c: metricVal(inst, c.metric) })), c.op, c.value);
    }
  }

  // ---- 整单预算 / 整桌热量 ----
  const priceTerms: Array<{ v: number; c: number }> = [];
  for (let p = 0; p < plans.length; p++) {
    const units = Math.max(1, Math.min(plans[p].maxQty > 0 ? plans[p].maxQty : 1, MAX_UNITS));
    for (let u = 0; u < units; u++) priceTerms.push({ v: lp.varIndex.get(`buy_${p}_${u}`)!, c: plans[p].basePriceCents });
  }
  for (const inst of insts) {
    if (inst.diffCents !== 0) for (const v of inst.selVars) priceTerms.push({ v, c: inst.diffCents });
  }
  if (input.totalBudgetCents != null) lp.addRow('budget', priceTerms, '<=', input.totalBudgetCents);
  // 热量语义（v1.2 明确）：
  //   cheapest 模式 → kcalBudget 是硬上限（整桌热量不得超过）；
  //   fit 模式     → kcalBudget 是目标值（允许上下偏离，越贴近越优先——见 kcalfit 阶段），
  //                  fitToleranceKcal 是用户声明的可接受偏差（最优解仍超出时如实提示）。
  const kcalTermsAll = insts.flatMap((inst) => inst.selVars.map((v) => ({ v, c: inst.kcal })));
  if (input.kcalBudget != null && input.mode === 'cheapest' && kcalTermsAll.length > 0) {
    lp.addRow('tkcal', kcalTermsAll, '<=', input.kcalBudget);
  }
  if (input.mode === 'fit' && input.kcalBudget != null && kcalTermsAll.length > 0) {
    // 偏差变量：over ≥ K − target，under ≥ target − K；min(over+under) = |K − target|
    const over = lp.addVar('kcalover', 0, true);
    const under = lp.addVar('kcalunder', 0, true);
    lp.addRow('kcalfit_over', [...kcalTermsAll, { v: over, c: -1 }], '<=', input.kcalBudget);
    lp.addRow('kcalfit_under', [...kcalTermsAll, { v: under, c: 1 }], '>=', input.kcalBudget);
  }
  const couponTerms: Array<{ v: number; c: number }> = [];
  for (let p = 0; p < plans.length; p++) {
    if (!plans[p].isExternalCoupon) continue;
    const units = Math.max(1, Math.min(plans[p].maxQty > 0 ? plans[p].maxQty : 1, MAX_UNITS));
    for (let u = 0; u < units; u++) couponTerms.push({ v: lp.varIndex.get(`buy_${p}_${u}`)!, c: 1 });
  }
  if (couponTerms.length > 0) lp.addRow('coupon_total', couponTerms, '<=', input.externalCouponLimit ?? 1);
  // ---- Top-K no-good 割（v1.4.2 R05：完整购物篮割）----
  // 语义：每个「割」= 一轮解出的完整购物篮（覆盖模型内全部计划，未购计划 qty=0、counts=[]）。
  //   约束 Σ_p m_p ≤ P−1 → 至少一个计划配置发生变化即可。
  //   旧实现把一篮拆成若干独立割（每计划一个），ngm 按计划强制为 0 → 每个已购计划都必须变化，
  //   于是「A 不变、B→C」的合法购物篮（如 A+B 之后想得到 A+C）被误删。
  //   - 数量扩展（1×A → 2×A）与换品保留为合法候选（数量/计数指示器偏离即可打破割）；
  //   - 只含食品计数（剔除非食品）→ 玩具变体自动落在割内，不占搜索轮次；
  //   - 含未购计划（qty=0）：新增/换入计划都会使该计划 m=0 → 割被打破，超集不再被误删。
  // 编码（整数变量上的精确双向指示器，M 覆盖偏差上界 8）：
  //   dLo=1 ⟺ Σexpr ≤ rhs−1；dHi=1 ⟺ Σexpr ≥ rhs+1（计数同理）；
  //   m ≥ 1 − Σ指示器 → 配置全等时 m 强制为 1；割 Σ_p m ≤ P−1 → 至少一个计划真实偏离。
  const NG_M = 64;
  noGoodCuts.forEach((basket, ci) => {
    const basketM: number[] = [];
    for (const cut of basket) {
      if (cut.p < 0 || cut.p >= plans.length) continue;
      const units = Math.max(1, Math.min(plans[cut.p].maxQty > 0 ? plans[cut.p].maxQty : 1, MAX_UNITS));
      const buyVars = Array.from({ length: units }, (_, u) => lp.varIndex.get(`buy_${cut.p}_${u}`)!).filter((v) => v !== undefined);
      const indicators: number[] = [];
      /** dLo=1 ⟺ Σexpr ≤ rhs−1（低于此前值）；dHi=1 ⟺ Σexpr ≥ rhs+1（高于此前值）——整数域上双向精确 */
      const devIndicators = (name: string, expr: Array<{ v: number; c: number }>, rhs: number): void => {
        // 低偏离指示器：dL=1 ⟺ Σexpr ≤ rhs−1（整数域双向精确）
        lp.addVar(`${name}L`, 0, true, 1);
        lp.addRow(`${name}L_hi`, [...expr, { v: lp.varIndex.get(`${name}L`)!, c: NG_M }], '<=', rhs - 1 + NG_M); // dL=1 ⟹ Σ ≤ rhs−1
        lp.addRow(`${name}L_lo`, [...expr, { v: lp.varIndex.get(`${name}L`)!, c: NG_M }], '>=', rhs);            // dL=0 ⟹ Σ ≥ rhs
        indicators.push(lp.varIndex.get(`${name}L`)!);
        // 高偏离指示器：dH=1 ⟺ Σexpr ≥ rhs+1（整数域双向精确）
        lp.addVar(`${name}H`, 0, true, 1);
        lp.addRow(`${name}H_hi`, [...expr, { v: lp.varIndex.get(`${name}H`)!, c: -NG_M }], '>=', rhs + 1 - NG_M); // dH=1 ⟹ Σ ≥ rhs+1
        lp.addRow(`${name}H_lo`, [...expr, { v: lp.varIndex.get(`${name}H`)!, c: -NG_M }], '<=', rhs);            // dH=0 ⟹ Σ ≤ rhs
        indicators.push(lp.varIndex.get(`${name}H`)!);
      };
      if (buyVars.length > 0) devIndicators(`ngd_${ci}_${cut.p}_q`, buyVars.map((v) => ({ v, c: 1 })), cut.qty);
      for (const cnt of cut.counts) {
        const selVars = Array.from({ length: units }, (_, u) => lp.varIndex.get(`sel_${cut.p}_${u}_${cnt.r}_${cnt.o}`)).filter((v): v is number => v !== undefined);
        if (selVars.length > 0 && cnt.n > 0) devIndicators(`ngd_${ci}_${cut.p}_${cnt.r}_${cnt.o}`, selVars.map((v) => ({ v, c: 1 })), cnt.n);
      }
      const mVar = lp.addVar(`ngm_${ci}_${cut.p}`, 0, true, 1);
      // m ≥ 1 − Σd：全部指示器为 0（配置全等）时 m 强制为 1
      lp.addRow(`ngm_${ci}_${cut.p}`, [{ v: mVar, c: 1 }, ...indicators.map((v) => ({ v, c: 1 }))], '>=', 1);
      basketM.push(mVar);
    }
    // 该轮完整购物篮至少一个计划配置发生变化：Σ_p m ≤ P−1
    if (basketM.length > 0) lp.addRow(`ngcut_${ci}`, basketM.map((v) => ({ v, c: 1 })), '<=', basketM.length - 1);
  });

  return {
    lp, insts, demands, noCandidate, plans, gapMaxVar,
    ...(infeasibleHardDemand ? { infeasibleHardDemand } : {}),
    ...(infeasibleMember ? { infeasibleMember } : {}),
  };
}

function priceTermsOf(model: BuiltModel): Array<{ v: number; c: number }> {
  const out: Array<{ v: number; c: number }> = [];
  for (let p = 0; p < model.plans.length; p++) {
    const plan = model.plans[p];
    const units = Math.max(1, Math.min(plan.maxQty > 0 ? plan.maxQty : 1, MAX_UNITS));
    for (let u = 0; u < units; u++) out.push({ v: model.lp.varIndex.get(`buy_${p}_${u}`)!, c: plan.basePriceCents });
  }
  for (const inst of model.insts) {
    if (inst.diffCents !== 0) for (const v of inst.selVars) out.push({ v, c: inst.diffCents });
  }
  return out;
}

function priceTotalOf(model: BuiltModel, values: Map<string, number>): number {
  let total = 0;
  for (let p = 0; p < model.plans.length; p++) {
    const plan = model.plans[p];
    const units = Math.max(1, Math.min(plan.maxQty > 0 ? plan.maxQty : 1, MAX_UNITS));
    for (let u = 0; u < units; u++) total += (values.get(`buy_${p}_${u}`) ?? 0) * plan.basePriceCents;
  }
  for (const inst of model.insts) {
    if (inst.diffCents !== 0) for (const vv of inst.selVars) total += (values.get(model.lp.varNames[vv]) ?? 0) * inst.diffCents;
  }
  return Math.round(total);
}

// ---------- 求解 ----------

interface HighsSolution { Status: string; Columns: Record<string, { Primal: number }> }

// v1.3 性能轮：HiGHS WASM 模块级复用——每阶段每轮迭代不再重复加载/实例化求解器
// （隔离测量：同门店首次精算 10.2s / 复解 6.5s 中，求解器加载属重复固定开销）
type HighsFactory = () => Promise<{ solve: (lp: string) => HighsSolution }> | { solve: (lp: string) => HighsSolution };
let highsFactoryPromise: Promise<{ solve: (lp: string) => HighsSolution }> | null = null;

async function getHighs(): Promise<{ solve: (lp: string) => HighsSolution }> {
  if (!highsFactoryPromise) {
    highsFactoryPromise = (async () => {
      const mod = await import('highs');
      const factory = (mod as { default?: unknown }).default ?? mod;
      return typeof factory === 'function' ? await (factory as HighsFactory)() : (factory as { solve: (lp: string) => HighsSolution });
    })();
  }
  return highsFactoryPromise;
}

async function solveHighs(lpText: string): Promise<{ state: 'optimal' | 'feasible' | 'infeasible'; values: Map<string, number> } | null> {
  const highs = await getHighs();
  const res = highs.solve(lpText);
  const status = String(res.Status ?? '').toLowerCase();
  if (status !== 'optimal' && status !== 'feasible') return null;
  const values = new Map<string, number>();
  for (const [name, col] of Object.entries(res.Columns ?? {})) values.set(name, col.Primal ?? 0);
  return { state: status === 'optimal' ? 'optimal' : 'feasible', values };
}

// ---------- 菜单 → 方案池（server 精算/拼单共用） ----------
export interface MenuBuildOptions {
  includeSingle?: boolean;
  maxComboPriceCents?: number;
  /** 官方套餐单篮数量上限（可调配置 CONFIG.comboMaxQty 的注入点；默认读配置） */
  maxComboQty?: number;
  /** 单品单篮数量上限（可调配置 CONFIG.singleMaxQty 的注入点；默认读配置） */
  maxSingleQty?: number;
  /** v1.4.4 R07：带规格心愿 → 合成「规格限定单品计划」（调用方解析好的规格营养，显式入模）。
   *  规格型 SKU 在菜单里是单一条目，规格营养只在官网表按行给出；不合成时内核按默认规格入模，
   *  导致大份心愿的热量/硬上限口径与提示不一致。 */
  /** v1.4.10 W02/W05：官方营养表（按规格分行）——套餐槽位/券食品的营养也用它联结，
   *  避免「大薯条」等只在套餐里出现的选项被当成营养未知，从而被完整性阶段排到更贵的方案。 */
  table?: Map<string, NutritionRow>;
  specRequests?: Array<{
    /** 菜单基准单品（按 code 优先、名称兜底定位） */
    baseCode: string;
    baseName: string;
    /** 规格标签（如「大」「中」「2块」） */
    specLabel: string;
    /** 规格营养（显式给出，不做名称猜测） */
    kcal: number; protein: number; fat: number; carbohydrate: number; sodium: number;
    /** 营养来源说明 */
    sourceLabel?: string;
  }>;
}

export function buildPlansFromMenuItems(
  items: import("./menu.js").MenuItem[],
  opts: MenuBuildOptions = { includeSingle: true },
): { comboPlans: ComboPlan[]; singlePlans: ComboPlan[] } {
  const RE_STAPLE_S = /堡|麦满分|营养卷|粥|松饼|吉士蛋|巨无霸|板烧|安格斯|鳕鱼/;
  const RE_VEGGIE_S = /蔬菜|沙拉|玉米|苹果片/;
  const RE_SUGARY_DRINK_S = /可乐|雪碧|果汁|柠檬红茶|冰茶|奶铁|奶茶|奶冻|爆珠|雪冰|怡泉|美汁源|麦旋酷/;
  const RE_ZERO_SUGAR_S = /无糖|零度|零卡/;
  /** 饮料类目判定：轮次声明（RoundSpec.category='drink'）或菜单类目（中文「饮品/麦咖啡」）。
   *  v1.4.2 补强：此前饮料身份只靠名称正则，导致「拿铁/芬达/卡布奇诺」等不在正则里的饮品被判
   *  非饮料（drink=false → sugary=false），从而可被分配给 noSugaryDrink 成员——与「无法确认时
   *  保持未知」相悖。轮次类目是比名称更可靠的信号，三者任一命中即为饮料。 */
  const isDrinkCategory = (cat?: string): boolean => !!cat && (cat === 'drink' || /饮品|麦咖啡/.test(cat));
  /** v1.4.2 R03：统一的食品规格与特征解析。
   *  - 规格优先：名称自带规格（大/中/小/迷你/N块）且官网命中该规格 → 用官网规格营养，
   *    覆盖同一 code 的菜单单品泛化营养（如「大薯条」379 kcal 而非单品「薯条」289）；
   *  - 无规格才回落菜单单品（it），两者皆无再回落官网泛化命中；
   *  - 主食/蔬菜身份：菜单已知值优先（it.isStaple/isVeggie），不被名称正则重判覆盖；
   *  - 饮料/含糖：仅存在于套餐的组件也解析；含糖为三态，无法确认时保持「未知」（undefined）。 */
  const optionFromItem = (it: import("./menu.js").MenuItem | undefined, name: string, diffCents = 0, code?: string, roundCategory?: string) => {
    // 非食品（玩具/餐具等）：保留为购买选项（用户可见），但不参与营养聚合与去重（kcal=0 且已知，nonFood 标记）
    if (RE_NONFOOD_OPT.test(name)) {
      return {
        name, kcal: 0, kcalKnown: true as const,
        priceCents: it ? it.priceCents : 0, diffCents,
        staple: false, veggie: false,
        code: code ?? it?.code,
        fastCarb: 0, drink: false, sugary: false as const, nonFood: true as const,
        protein: 0, fat: 0, carbohydrate: 0, sodium: 0,
      };
    }
    // ---- 规格解析（槽位规格优先）----
    const specTitle = specTitleFromRaw(name);
    // v1.4.10 W05/W11：名称自带规格（大薯条/中杯可乐/两块鸡翅）时把规格标签写进选项身份，
    //   供需求承接、去重签名与购买清单共用；不再只依赖「合成的规格限定计划」。
    const specLabelOfName = specTitle ?? (specOfName(name) || undefined);
    // 零度/零卡饮料：官网产品名为「无糖…」，查询前归一，避免错配到同名含糖产品
    const lookupName = RE_ZERO_SUGAR_S.test(name) ? name.replace(/零度|零卡/g, '无糖') : name;
    // 统一营养解析链（官网权威库 → 用户补录层 → 未知保持未知）：
    // 组件不在当前菜单单品池时，用户补录层可补上官网库未收录品项的营养。
    // 组件不在菜单单品池时：先查官方营养表（按规格分行），再走官网/补录解析链
    const tableRow = !it && opts.table ? matchNutrition(name, opts.table) : undefined;
    const off = (!it || specTitle || it.nutritionMatched === false) ? resolveComponentNutrition(lookupName) : null;
    const specHit = !!specTitle && !!off?.matched && off.sourceKind === 'official-web' && off.specTitle === specTitle;
    const useMenu = (!!it && it.nutritionMatched !== false && !specHit) || (!it && !!tableRow);
    const useResolved = !!off?.matched && !specHit && !useMenu;
    const usesResolvedNutrition = specHit || useResolved;
    const kcal = usesResolvedNutrition ? off!.kcal : useMenu ? (it ? it.kcal : tableRow!.energyKcal) : 0;
    const protein = specHit || useResolved ? off!.protein : useMenu ? (it ? it.protein : tableRow!.protein) : 0;
    const fat = specHit || useResolved ? off!.fat : useMenu ? (it ? it.fat : tableRow!.fat) : 0;
    const carbohydrate = specHit || useResolved ? off!.carbohydrate : useMenu ? (it ? it.carbohydrate : tableRow!.carbohydrate) : 0;
    const sodium = specHit || useResolved ? off!.sodium : useMenu ? (it ? it.sodium : tableRow!.sodium) : 0;
    // 来源说明供购买清单审计：优先给解析链的具体来源，否则保留菜单已有来源标签。
    const nutritionSource = (specHit || useResolved) ? off!.sourceLabel : it?.nutritionSource;
    const unknownNutrition = usesResolvedNutrition ? off!.unknownFields
      : useMenu ? (it ? (it.nutritionUnknownFields ?? []) : [])
      : ['kcal', 'protein', 'fat', 'carbohydrate', 'sodium'];
    const kcalKnown = (usesResolvedNutrition || useMenu) && !unknownNutrition.includes('kcal');
    const carbohydrateKnown = !unknownNutrition.includes('carbohydrate');
    // ---- 特征解析 ----
    // 主食/蔬菜：菜单已知优先（不覆盖），无菜单项才按名称正则推断
    const staple = it ? !!it.isStaple : (RE_STAPLE_S.test(name) && !/薯/.test(name));
    const veggie = it ? !!it.isVeggie : RE_VEGGIE_S.test(name);
    // 饮料身份：轮次类目 或 菜单类目 或 名称正则（组件也能识别，不再默认 false）
    const drink = isDrinkCategory(roundCategory) || isDrinkCategory(it?.category) || RE_SUGARY_DRINK_S.test(name);
    // 含糖三态：非饮料=false；零糖名称=false；有营养数据按碳水≥5 判定；否则未知（undefined，保守）
    let sugary: boolean | undefined;
    if (!drink) sugary = false;
    else if (RE_ZERO_SUGAR_S.test(name)) sugary = false;
    else if (carbohydrateKnown && Number.isFinite(carbohydrate)) sugary = carbohydrate >= 5;
    else sugary = undefined;
    const fastCarb = useMenu ? (it ? (it.fastCarb ?? 0) : (sugary === true ? carbohydrate : 0)) : (sugary === true ? carbohydrate : 0);
    // v1.4.4 R11：快碳可信性独立判定——非饮料恒可信；饮料仅在「含糖三态已判定」时可信
    //   （未知饮料的 fastCarb 0 是占位，不得用于通过 fastCarb<=0 这类硬上限）。
    const fastCarbKnown = !drink || sugary !== undefined;
    // v1.4.4 R04：估算/区间营养仅作参照；未知字段需逐项保留，不能把占位 0 当作证据。
    const estimated = usesResolvedNutrition ? off!.valueKind === 'estimate' : (useMenu && it) ? !!it.nutritionEstimated : false;
    return {
      name, kcal, kcalKnown, priceCents: it ? it.priceCents : 0, diffCents,
      staple, veggie, code: code ?? it?.code,
      fastCarb, fastCarbKnown, drink, sugary,
      protein, fat, carbohydrate, sodium,
      ...(specLabelOfName ? { specLabel: specLabelOfName } : {}),
      ...(unknownNutrition.length ? { unknownNutrition } : {}),
      ...(estimated ? { estimated: true } : {}),
      ...(nutritionSource ? { nutritionSource } : it?.nutritionSource ? { nutritionSource: it.nutritionSource } : {}),
    };
  };
  const comboPlans: ComboPlan[] = items
    .filter((i) => i.isCombo && i.deconstruction && i.deconstruction.length > 0)
    .map((i) => ({
      id: "mcd-" + i.code, channel: "mcd-mcp" as const, name: i.name, basePriceCents: i.priceCents,
      maxQty: opts.maxComboQty ?? CONFIG.comboMaxQty,
      maxQtySource: 'program-cap' as const,
      slots: (i.deconstruction ?? []).map((r) => ({
        roundName: r.roundName,
        ...(r.roundId ? { roundId: r.roundId } : {}),
        defaultName: r.defaultName,
        options: r.options.map((o) => optionFromItem(
          o.code ? items.find((x) => x.code === o.code) : undefined,
          o.name, o.diffCents, o.code, r.category,
        )),
      })),
    }));
  const singlePlans: ComboPlan[] = opts.includeSingle === false ? [] : items
    .filter((i) => !i.isCombo)
    .map((i) => ({
      id: "mcd-s-" + i.code, channel: "mcd-mcp" as const, name: i.name, basePriceCents: i.priceCents,
      maxQty: opts.maxSingleQty ?? CONFIG.singleMaxQty,
      maxQtySource: 'program-cap' as const,
      slots: [{ roundName: i.category, defaultName: i.name, options: [optionFromItem(i, i.name, 0, undefined, i.category)] }],
    }));

  // v1.4.4 R07：规格限定单品计划。
  //   规格型 SKU（薯条/可乐等）在菜单里是**单一条目**，规格营养只在官网营养表按行给出
  //   （中薯条 289 / 大薯条 379）。不合成时内核按默认规格入模 → 大份心愿的热量、提示与硬上限
  //   不一致（评审 R07 已复现：379 kcal 通过 300 kcal 上限）。
  //   此处用**调用方解析好的规格营养**显式构造选项（不做名称猜测），并打上 specLabel；
  //   带规格的心愿只由同规格选项承接（见 optionSatisfiesDemand）。
  const specPlans: ComboPlan[] = [];
  const seenSpecPlan = new Set<string>();
  for (const req of opts.specRequests ?? []) {
    const it = items.find((x) => !x.isCombo && x.code === req.baseCode)
      ?? items.find((x) => !x.isCombo && x.name === req.baseName);
    if (!it) continue;
    const id = `mcd-spec-${it.code}-${req.specLabel}`;
    if (seenSpecPlan.has(id) || singlePlans.some((p) => p.id === id)) continue;
    seenSpecPlan.add(id);
    const displayName = `${req.specLabel}${it.name}`;
    const base = optionFromItem(it, displayName, 0, it.code, it.category);
    // v1.4.10 W02：规格型单品的**真实履约结构**——父 SKU + 规格轮次 + 选项 code/补差。
    //   旧实现只换营养与显示名，价格仍取父 SKU 基础价，核价时还把 `spec-…` 内部计划名
    //   当作 productCode 发出（实测 9900008751：小/中/大 = 950/1000/1200 分）。
    const wantSpec = normSpecKey(req.specLabel);
    const specRound = (it.specRounds ?? []).find((r) =>
      r.options.some((o) => (normSpecKey(specTitleFromRaw(o.name) ?? '') || specOfName(o.name)) === wantSpec));
    const specOpt = specRound?.options.find((o) =>
      (normSpecKey(specTitleFromRaw(o.name) ?? '') || specOfName(o.name)) === wantSpec);
    const realDiff = specOpt ? specOpt.diffCents : 0;
    specPlans.push({
      id, channel: 'mcd-mcp', name: displayName, basePriceCents: it.priceCents,
      maxQty: opts.maxSingleQty ?? CONFIG.singleMaxQty,
      maxQtySource: 'program-cap',
      ...(specRound ? { fulfillCode: it.code, fulfillRoundId: specRound.roundId } : {}),
      ...(specRound ? {} : { specPriceUnverified: true }),
      slots: [{
        roundName: it.category, defaultName: displayName,
        ...(specRound ? { roundId: specRound.roundId } : {}),
        options: [{
          ...base,
          name: displayName,
          kcal: req.kcal, kcalKnown: true,
          protein: req.protein, fat: req.fat, carbohydrate: req.carbohydrate, sodium: req.sodium,
          specLabel: req.specLabel,
          ...(specOpt?.code ? { code: specOpt.code } : {}),
          diffCents: realDiff,
          nutritionSource: req.sourceLabel ?? `规格营养（${req.specLabel}）`,
        }],
      }],
    });
  }
  return { comboPlans, singlePlans: [...singlePlans, ...specPlans] };
}

// ---------- 主求解（多阶段字典序 + Top-K） ----------

const OBJECTIVE_DIR: Record<ObjectiveMetric, 1 | -1> = {
  protein: 1, veggie: 1, fat: -1, carbohydrate: -1, sodium: -1, fastCarb: -1,
};

function metricValueOf(inst: InstMeta, metric: ObjectiveMetric): number {
  let val: number;
  switch (metric) {
    case 'protein': val = inst.protein; break;
    case 'fat': val = inst.fat; break;
    case 'carbohydrate': val = inst.carbohydrate; break;
    case 'sodium': val = inst.sodium; break;
    case 'fastCarb': val = inst.fastCarb; break;
    case 'veggie': val = inst.veggie ? 1 : 0; break;
    default: val = undefined as unknown as number; break; // 运行时未知目标度量 → 下方防御抛错
  }
  return assertFiniteNumber(val, `目标度量「${String(metric)}」在计划「${inst.planName}」选项「${inst.optName}」`);
}

function objTol(metric: ObjectiveMetric, value: number): number {
  switch (metric) {
    case 'protein': return Math.max(2, value * 0.05);
    case 'sodium': return Math.max(50, value * 0.05);
    case 'fat': case 'carbohydrate': case 'fastCarb': return Math.max(5, value * 0.05);
    case 'veggie': return 1;
  }
}

export async function optimize(input: OptimizeInput, opts: { noGoodCuts?: BasketNoGoodCut[] } = {}): Promise<OptimizeResult> {
  // v1.4.2 R01：入口归一——度量别名（carb→carbohydrate）与未知度量显式报错；幂等，可被 optimizeTopK 预归一
  input = normalizeOptimizeInput(input);
  const notes: string[] = [];
  const model = buildModel(input, opts.noGoodCuts ?? []);
  const lpStats = { vars: model.lp.varNames.length, rows: model.lp.rows.length };
  // v1.3：全部软需求都带缺口变量（无候选者固定计满），统一参与缺口字典序
  const softDemands = model.demands.filter((dm) => dm.soft);
  let finalValues: Map<string, number> | null = null;

  const infeasible = (why: string): OptimizeResult => ({
    status: 'infeasible', assignments: [], memberAllocations: [], leftovers: [],
    unmetDemands: [...model.noCandidate], coverage: { total: model.demands.length, met: 0 }, gapTotal: 0,
    totals: { priceCents: 0, kcal: 0, staple: 0, veggie: 0, leftoverCents: 0 },
    notes: [why], lpStats, solutionPlanCuts: [],
  });

  // v1.3：硬需求（恰好/必须）在当前候选池下无候选 → 直接判不可行（不再静默跳过伪装成可满足）
  if (model.infeasibleHardDemand) {
    const extra = model.noCandidate.length > 0 ? `另有 ${model.noCandidate.length} 条需求无候选` : '';
    return infeasible(`「${model.infeasibleHardDemand.alias}」的${input.members.some((m) => (m.demands ?? []).some((d) => d.exact)) ? '恰好' : '必须'}型需求「${model.infeasibleHardDemand.keyword}」在当前方案池中无候选，需求无法满足${extra ? '；' + extra : ''}`);
  }

  // v1.4：成员全部候选食品被排除（营养未知/禁忌），但硬约束要求至少摄入 → 无可行方案
  if (model.infeasibleMember) {
    return infeasible(`「${model.infeasibleMember.alias}」${model.infeasibleMember.reason}——当前候选池下无可行方案（不再返回零食品的伪最优）`);
  }

  const runStage = async (
    stage: 'gapmax' | 'gapsum' | 'nutricomplete' | 'price' | 'kcalfit' | 'leftover' | 'objective',
    extraRows: LpRow[],
    objective?: PriorityGoal,
  ): Promise<{ state: 'optimal' | 'feasible' | 'infeasible'; values: Map<string, number> } | null> => {
    const rebuilt = buildModel(input, opts.noGoodCuts ?? []);
    for (const r of extraRows) rebuilt.lp.addRow(r.name, r.coeffs, r.sense, r.rhs);
    if (stage === 'nutricomplete') {
      // v1.4：最小化「营养未收录（kcalKnown=false）品项的选购数」——防止缺热量的食品按 0 计入
      // kcalfit/营养目标，从而获得虚假的「精准贴合」排名。营养未知品项越少越优先。
      for (const inst of rebuilt.insts) {
        if (inst.kcalKnown) continue;
        for (const v of inst.selVars) rebuilt.lp.obj[v] = 1;
      }
      return await solveHighs(rebuilt.lp.build('min'));
    }
    if (stage === 'price') {
      for (const t of priceTermsOf(rebuilt)) rebuilt.lp.obj[t.v] = t.c;
      return await solveHighs(rebuilt.lp.build('min'));
    }
    if (stage === 'kcalfit') {
      // 贴合目标：最小化 |整桌热量 − 目标|（over+under），上下偏离同等对待
      const ov = rebuilt.lp.varIndex.get('kcalover');
      const un = rebuilt.lp.varIndex.get('kcalunder');
      if (ov !== undefined) rebuilt.lp.obj[ov] = 1;
      if (un !== undefined) rebuilt.lp.obj[un] = 1;
      return await solveHighs(rebuilt.lp.build('min'));
    }
    if (stage === 'gapmax') {
      if (rebuilt.gapMaxVar !== undefined) rebuilt.lp.obj[rebuilt.gapMaxVar] = 1;
      return await solveHighs(rebuilt.lp.build('min'));
    }
    if (stage === 'gapsum') {
      for (const dm of rebuilt.demands) if (dm.gapVar !== undefined) rebuilt.lp.obj[dm.gapVar] = 1;
      return await solveHighs(rebuilt.lp.build('min'));
    }
    if (stage === 'leftover') {
      for (const inst of rebuilt.insts) if (inst.loVar !== undefined) rebuilt.lp.obj[inst.loVar] = Math.max(1, inst.refPriceCents);
      return await solveHighs(rebuilt.lp.build('min'));
    }
    // objective：作用于「购买篮」（sel 层，与分配无关）。
    // v1.2 方向修正：目标系数一律用正的度量值，方向由求解语义决定——
    //   dir ≥ 0（蛋白质更多等）→ maximize；dir < 0（钠/碳水/脂肪更少等）→ minimize。
    // 旧实现 `dir * metric` 配 minimize 使负向目标变成「奖励更高的钠/碳水/脂肪」（双重取反）。
    const metric = objective as ObjectiveMetric;
    const dir = OBJECTIVE_DIR[metric] ?? 1;
    for (const inst of rebuilt.insts) {
      for (const v of inst.selVars) rebuilt.lp.obj[v] = metricValueOf(inst, metric);
    }
    return await solveHighs(rebuilt.lp.build(dir >= 0 ? 'max' : 'min'));
  };

  const extraRows: LpRow[] = [];
  let allOptimal = true;

  // ---- 阶段 1/2：软需求缺口（最不满意成员 → 全体）----
  if (softDemands.length > 0) {
    const r1 = await runStage('gapmax', extraRows);
    if (!r1) return infeasible('模型无可行解（硬约束冲突，含「恰好/必须」需求与成员上限）');
    if (r1.state !== 'optimal') allOptimal = false;
    const M1 = Math.round(r1.values.get('gapmax') ?? 0);
    extraRows.push({ name: 'fix_gapmax', coeffs: [{ v: model.lp.varIndex.get('gapmax')!, c: 1 }], sense: '<=', rhs: M1 });
    if (M1 > 0) notes.push(`存在无法完全满足的软需求（最不满意成员缺口 ${M1} 份），已按近似解呈现，覆盖率以原始需求为分母。`);

    const r2 = await runStage('gapsum', extraRows);
    if (!r2) return infeasible('缺口最小化阶段无解');
    if (r2.state !== 'optimal') allOptimal = false;
    const G2 = softDemands.reduce((s, dm) => s + Math.round(r2.values.get(`gap_${dm.di}`) ?? 0), 0);
    extraRows.push({
      name: 'fix_gapsum',
      coeffs: softDemands.map((dm) => ({ v: model.lp.varIndex.get(`gap_${dm.di}`)!, c: 1 })),
      sense: '<=', rhs: G2,
    });
    if (G2 > 0) notes.push(`全体需求缺口合计 ${G2} 份（详见 unmetDemands）。`);
  }

  // ---- 阶段：营养完整性（v1.4）----
  // 先最小化「营养未收录品项的选购数」，再进入热量贴合/营养目标阶段：
  // 缺热量的食品不得按 0 计入从而拿到「精准贴合」排名（营养完整的方案优先）。
  const unknownTerms = model.insts
    .filter((inst) => !inst.kcalKnown)
    .flatMap((inst) => inst.selVars.map((vv) => ({ v: vv, c: 1 })));
  if (unknownTerms.length > 0) {
    const ru = await runStage('nutricomplete', extraRows);
    if (ru) {
      if (ru.state !== 'optimal') allOptimal = false;
      const U = model.insts.reduce(
        (s, inst) => s + (inst.kcalKnown ? 0 : inst.selVars.reduce((ss, vv) => ss + Math.round(ru.values.get(model.lp.varNames[vv]) ?? 0), 0)),
        0,
      );
      extraRows.push({ name: 'fix_nutricomplete', coeffs: unknownTerms, sense: '<=', rhs: U });
      if (U > 0) notes.push(`营养完整性：方案中仍有 ${U} 份营养未收录食品（其热量按「未知」计，不计入达标与贴合判断，仅按已知部分合计展示）。`);
    }
  }

  // ---- 阶段：热量贴合（fit 模式；kcalBudget = 目标值而非硬上限）----
  if (input.mode === 'fit' && input.kcalBudget != null) {
    const r = await runStage('kcalfit', extraRows);
    if (!r) return infeasible('热量贴合阶段无解');
    if (r.state !== 'optimal') allOptimal = false;
    const dev = Math.round((r.values.get('kcalover') ?? 0) + (r.values.get('kcalunder') ?? 0));
    const used = model.insts.reduce((s, inst) => s + inst.selVars.reduce((ss, vv) => ss + Math.round(r.values.get(model.lp.varNames[vv]) ?? 0) * inst.kcal, 0), 0);
    // v1.4.2 P2：本阶段解中「营养未收录」品项数——其热量按未知计（未进 dev），
    // 若存在则不得使用「达成/偏差 0」等完整贴合语言（未知部分无法判定是否贴合）。
    const unknownInFit = model.insts.reduce(
      (s, inst) => s + (inst.kcalKnown ? 0 : inst.selVars.reduce((ss, vv) => ss + Math.round(r.values.get(model.lp.varNames[vv]) ?? 0), 0)),
      0,
    );
    const tol = input.fitToleranceKcal ?? 150;
    // 锁定带 = [目标 − 最优偏差, 目标 + 最优偏差]：只允许「同等贴近目标」的并列解进入后续阶段，
    // 不再允许旧实现 150 kcal 宽带内（同价更远离目标）的候选。
    const kcalLockCoeffs = model.insts.flatMap((inst) => inst.selVars.map((vv) => ({ v: vv, c: inst.kcal })));
    if (kcalLockCoeffs.length > 0) {
      extraRows.push({ name: 'fix_kcalfit_lo', coeffs: kcalLockCoeffs, sense: '>=', rhs: Math.max(0, input.kcalBudget - dev) });
      extraRows.push({ name: 'fix_kcalfit_hi', coeffs: kcalLockCoeffs, sense: '<=', rhs: input.kcalBudget + dev });
    }
    if (unknownInFit > 0) {
      // 营养不完整：只报「按已知部分合计」，不作达成/偏差判断（缺失 ≠ 0）
      notes.push(`热量贴合（营养不完整）：目标 ${input.kcalBudget} kcal；按已知部分合计 ${Math.round(used)} kcal，含 ${unknownInFit} 项营养未收录，无法判定是否贴合（营养不完整，不作贴合判断）。`);
    } else {
      notes.push(`热量贴合：目标 ${input.kcalBudget} kcal，最贴近可得 ${Math.round(used)} kcal（偏差 ${dev} kcal${dev > tol ? `，超出声明容差 ${tol}——已如实标注，无更贴近的可行组合` : ''}）；同偏差并列方案由后续优先级/价格决定。`);
    }
  }

  // ---- 阶段：用户优先级（有序 ≤2；'price' 价格段前移；营养度量作用于购买篮 sel 层）----
  // v1.2 锁定约束符号修正：锁定系数一律用正的度量值——
  //   dir ≥ 0（更多型）→ Σmetric ≥ objVal − tol（不低于已得最优）；
  //   dir < 0（更少型）→ Σmetric ≤ objVal + tol（不超过已得最优）。
  // 旧实现锁定系数乘了 dir（负值）且 sense 为 '<='，对更少型目标恒真（锁定失效）。
  const GOAL_LABEL: Record<PriorityGoal, string> = {
    price: '更省钱', protein: '蛋白质更多', fat: '脂肪更少',
    carbohydrate: '碳水更少', sodium: '钠更少', fastCarb: '快碳更少', veggie: '蔬菜更多',
  };
  const priorities = (input.priorities ?? []).slice(0, 2);
  let priceFixed = false;
  for (const goal of priorities) {
    if (goal === 'price') {
      const rp = await runStage('price', extraRows);
      if (!rp) return infeasible('价格优先阶段无解');
      if (rp.state !== 'optimal') allOptimal = false;
      const P = priceTotalOf(model, rp.values);
      extraRows.push({ name: `fix_price_${extraRows.length}`, coeffs: priceTermsOf(model), sense: '<=', rhs: P });
      priceFixed = true;
      notes.push(`优先级：更省钱（整单 ≤ ¥${(P / 100).toFixed(1)} 带内）。`);
    } else {
      const r = await runStage('objective', extraRows, goal);
      if (!r) return infeasible(`目标阶段（${goal}）无解`);
      if (r.state !== 'optimal') allOptimal = false;
      const dir = OBJECTIVE_DIR[goal as ObjectiveMetric] ?? 1;
      const goalMetric = goal as ObjectiveMetric;
      const objVal = model.insts.reduce((s, inst) => s + inst.selVars.reduce((ss, vv) => ss + Math.round(r.values.get(model.lp.varNames[vv]) ?? 0) * metricValueOf(inst, goalMetric), 0), 0);
      extraRows.push({
        name: `fix_obj_${escName(goal)}`,
        coeffs: model.insts.flatMap((inst) => inst.selVars.map((vv) => ({ v: vv, c: metricValueOf(inst, goalMetric) }))),
        sense: dir >= 0 ? '>=' : '<=',
        rhs: dir >= 0 ? Math.max(0, objVal - objTol(goalMetric, objVal)) : objVal + objTol(goalMetric, objVal),
      });
      notes.push(`优先级：${GOAL_LABEL[goal]}（购买篮${dir >= 0 ? '至少' : '至多'} ${Math.round(objVal)}${goalMetric === 'sodium' ? ' mg' : goalMetric === 'veggie' ? ' 份' : ' g'}，带内并列由后续阶段决定）。`);
    }
  }

  // ---- 阶段：最低价（未被「更省钱」优先级前移时）----
  if (!priceFixed) {
    const rp = await runStage('price', extraRows);
    if (!rp) return infeasible('模型无可行解');
    if (rp.state !== 'optimal') allOptimal = false;
    const P3 = priceTotalOf(model, rp.values);
    extraRows.push({ name: 'fix_price', coeffs: priceTermsOf(model), sense: '<=', rhs: P3 });
  }

  // ---- 阶段：最小剩余（宜多分配；硬约束冲突成员天然接不到）----
  const rl = await runStage('leftover', extraRows);
  if (!rl) return infeasible('剩余最小化阶段无解');
  if (rl.state !== 'optimal') allOptimal = false;
  finalValues = rl.values;

  // ---- 解析结果 ----
  const v = (name: string): number => Math.round(finalValues!.get(name) ?? 0);
  const assignments: PlanAssignment[] = [];
  const solutionPlanCuts: PlanNoGoodCut[] = [];
  for (let p = 0; p < model.plans.length; p++) {
    const plan = model.plans[p];
    const units = Math.max(1, Math.min(plan.maxQty > 0 ? plan.maxQty : 1, MAX_UNITS));
    const boughtUnits: number[] = [];
    for (let u = 0; u < units; u++) if (v(`buy_${p}_${u}`) > 0) boughtUnits.push(u);
    const planInsts = model.insts.filter((x) => x.p === p);
    // 本计划配置割（v1.4.2 R05：含未购计划——qty=0、counts=[]，保证整篮割语义完整，超集不被误删）
    const counts: PlanNoGoodCut['counts'] = [];
    if (boughtUnits.length > 0) {
      for (const inst of planInsts) {
        if (inst.nonFood) continue;
        const n = boughtUnits.reduce((s, u) => s + v(`sel_${p}_${u}_${inst.r}_${inst.o}`), 0);
        if (n > 0) counts.push({ r: inst.r, o: inst.o, n });
      }
    }
    solutionPlanCuts.push({ p, qty: boughtUnits.length, counts });
    if (boughtUnits.length === 0) continue;
    const unitConfigs: Array<{ unitIndex: number; slotChoices: SlotChoice[] }> = [];
    for (const u of boughtUnits) {
      const scs: SlotChoice[] = [];
      for (const inst of planInsts) {
        const selVal = v(`sel_${p}_${u}_${inst.r}_${inst.o}`);
        if (selVal > 0) {
          scs.push({
            roundName: inst.roundName, ...(inst.roundId ? { roundId: inst.roundId } : {}),
            chosenName: inst.optName, ...(inst.optCode ? { optionCode: inst.optCode } : {}),
            ...(inst.specLabel ? { specLabel: inst.specLabel } : {}),
            kcal: inst.kcal, kcalKnown: inst.kcalKnown, refPriceCents: inst.refPriceCents, diffCents: inst.diffCents, count: 1,
            protein: inst.protein, fat: inst.fat, carbohydrate: inst.carbohydrate, sodium: inst.sodium, fastCarb: inst.fastCarb,
            ...(inst.officialDiffCents ? { officialDiffCents: inst.officialDiffCents } : {}),
            ...(inst.nutritionSource ? { nutritionSource: inst.nutritionSource } : {}),
            ...(inst.estimated ? { estimated: true } : {}),
            ...(inst.unknownNutrition.length ? { unknownNutrition: inst.unknownNutrition.slice() } : {}),
            ...(inst.nonFood ? { nonFood: true } : {}),
          });
        }
      }
      unitConfigs.push({ unitIndex: u, slotChoices: scs });
    }
    const agg = new Map<string, SlotChoice>();
    for (const uc of unitConfigs) for (const sc of uc.slotChoices) {
      // v1.4.6 R04：聚合键必须包含**选项身份**（optionCode）与影响计算的属性（规格/热量/差价）。
      //   旧键只有「轮次 + 显示名」：同轮同名的大小份两个 code 碰撞后沿用第一项的 code、热量与差价，
      //   出现「逐份配置 300+500=800 kcal，聚合显示 500×2=1000 kcal」「条目合计 2200 分、方案总价 2100 分」。
      // v1.4.7 R03：身份键统一走 foodKeyOf（code 优先，无 code 用名称+规格），不再以热量替代规格。
      const key = `${sc.roundId ?? sc.roundName}|${foodKeyOf({ code: sc.optionCode, name: sc.chosenName, spec: sc.specLabel })}|${sc.kcal}|${sc.diffCents}`;
      const hit = agg.get(key);
      if (hit) hit.count += 1;
      else agg.set(key, { ...sc, count: 1 });
    }
    const unitKcal = unitConfigs[0]?.slotChoices.reduce((s, sc) => s + sc.kcal, 0) ?? 0;
    assignments.push({
      planId: plan.id, channel: plan.channel, planName: plan.name, qty: boughtUnits.length,
      basePriceCents: plan.basePriceCents, slotChoices: [...agg.values()],
      units: unitConfigs, unitKcal,
      ...(plan.maxQtySource ? { maxQtySource: plan.maxQtySource } : {}),
    });
  }

  // 需求满足计量（v1.3 语义统一）：
  //   普通需求 = 声明变量合计；
  //   套餐意图（comboPlanId，槽位型）= 完整套餐份数 = min(各槽位声明合计)——
  //   旧实现把两槽声明相加（1 份两槽套餐显示「领取 2 份」且 exact 判不满足）。
  //   任一槽位无候选 → 0（完整缺口由缺口变量承载）。
  const claimedOf = (dm: DemandMeta): number => {
    if (dm.unitClaims) {
      return dm.unitClaims.reduce((s, { v: vv }) => s + Math.round(finalValues!.get(model.lp.varNames[vv]) ?? 0), 0);
    }
    if (dm.slots) {
      if (dm.slots.length === 0 || dm.slots.some((vs) => vs.length === 0)) return 0;
      return Math.min(...dm.slots.map((vs) => vs.reduce((s, vv) => s + Math.round(finalValues!.get(model.lp.varNames[vv]) ?? 0), 0)));
    }
    return dm.vars.reduce((s, { v: vv }) => s + Math.round(finalValues!.get(model.lp.varNames[vv]) ?? 0), 0);
  };

  const memberAllocations: MemberAllocation[] = input.members.map((m, mi) => {
    const aggItems = new Map<string, MemberAllocation['items'][number]>();
    let kcal = 0, refPrice = 0, staple = 0, veggie = 0;
    let protein = 0, fat = 0, carbohydrate = 0, sodium = 0;
    for (const inst of model.insts) {
      const av = inst.asgVars[mi];
      if (av === undefined) continue;
      const gotN = v(`asg_${inst.p}_${inst.r}_${inst.o}_${mi}`);
      if (gotN <= 0) continue;
      // v1.4.7 R10：成员条目也按「食品身份 + 规格」聚合（旧键 planId+显示名：同名不同 code
      //   会合并成首 code、qty=2，kcalKnown 也沿用首条，而购买槽位其实仍有两个身份）。
      const key = `${inst.planId}|${foodKeyOf({ code: inst.optCode, name: inst.optName, spec: inst.specLabel })}`;
      const hit = aggItems.get(key);
      if (hit) {
        hit.qty += gotN; hit.kcal += inst.kcal * gotN; hit.refPriceCents += inst.refPriceCents * gotN;
        hit.estimated = !!hit.estimated || inst.estimated;
        // 可信字段合并：任一来源未知 → 该条目整体不宣称营养完整（不再沿用首条）
        hit.kcalKnown = hit.kcalKnown !== false && inst.kcalKnown !== false;
        hit.unknownNutrition = [...new Set([...(hit.unknownNutrition ?? []), ...inst.unknownNutrition])];
        if (!hit.nutritionSource && inst.nutritionSource) hit.nutritionSource = inst.nutritionSource;
      } else aggItems.set(key, {
        fromPlanId: inst.planId, planName: inst.planName, itemName: inst.optName, qty: gotN,
        kcal: inst.kcal * gotN, refPriceCents: inst.refPriceCents * gotN, slotRound: inst.roundName,
        kcalKnown: inst.kcalKnown, ...(inst.optCode ? { optionCode: inst.optCode } : {}),
        ...(inst.specLabel ? { specLabel: inst.specLabel } : {}),
        ...(inst.estimated ? { estimated: true } : {}), ...(inst.unknownNutrition.length ? { unknownNutrition: inst.unknownNutrition.slice() } : {}),
        ...(inst.nutritionSource ? { nutritionSource: inst.nutritionSource } : {}),
      });
      kcal += inst.kcal * gotN; refPrice += inst.refPriceCents * gotN;
      protein += inst.protein * gotN; fat += inst.fat * gotN;
      carbohydrate += inst.carbohydrate * gotN; sodium += inst.sodium * gotN;
      if (inst.staple) staple += gotN;
      if (inst.veggie) veggie += gotN;
    }
    const demandOut = model.demands.filter((dm) => dm.m === mi).map((dm) => {
      const claimed = claimedOf(dm);
      return { id: dm.d.id, keyword: dm.d.keyword, qty: dm.d.qty, ...(dm.d.exact ? { exact: true } : {}), claimed, satisfied: dm.d.exact ? claimed === dm.d.qty : claimed >= dm.d.qty };
    });
    return {
      alias: m.alias, items: [...aggItems.values()], kcal,
      protein: Math.round(protein), fat: Math.round(fat), carbohydrate: Math.round(carbohydrate), sodium: Math.round(sodium),
      refPriceCents: refPrice, staple, veggie,
      unmetMustHave: demandOut.filter((d) => !d.satisfied).map((d) => d.keyword),
      demands: demandOut,
    };
  });

  const leftovers: OptimizeResult['leftovers'] = [];
  for (const inst of model.insts) {
    if (inst.loVar === undefined) continue;
    const loN = v(`lo_${inst.p}_${inst.r}_${inst.o}`);
    if (loN > 0) leftovers.push({ planId: inst.planId, planName: inst.planName, itemName: inst.optName, qty: loN, refPriceCents: inst.refPriceCents * loN, kcal: inst.kcal * loN });
  }

  const unsatisfied: UnmetDemand[] = [];
  for (const dm of model.demands) {
    const claimed = claimedOf(dm);
    const ok = dm.d.exact ? claimed === dm.d.qty : claimed >= dm.d.qty;
    if (!ok) unsatisfied.push({ memberIdx: dm.m, alias: input.members[dm.m].alias, demandId: dm.d.id, keyword: dm.d.keyword, reason: 'unsatisfied', missingQty: Math.max(0, dm.d.qty - claimed) });
  }

  const gapTotal = softDemands.reduce((s, dm) => s + v(`gap_${dm.di}`), 0);
  const totals = {
    priceCents: priceTotalOf(model, finalValues!),
    kcal: memberAllocations.reduce((s, m) => s + m.kcal, 0),
    staple: memberAllocations.reduce((s, m) => s + m.staple, 0),
    veggie: memberAllocations.reduce((s, m) => s + m.veggie, 0),
    leftoverCents: leftovers.reduce((s, l) => s + l.refPriceCents, 0),
  };
  if (priorities.length > 0) notes.push(`用户优先级 ${priorities.join(" → ")} 已按字典序参与求解。`);
  if (leftovers.length > 0) notes.push(`存在未分配剩余品项（参考价 ¥${(totals.leftoverCents / 100).toFixed(1)}），费用按原价并入分账基数全体等比摊付。`);
  if (model.noCandidate.length > 0) notes.push(`${model.noCandidate.length} 条需求在当前方案池中无候选（缺口已全额计入，见 unmetDemands）。`);
  // v1.4.4 R04：按所有营养字段记录完整性，不能只看 kcal；未知字段的占位值不算完整营养合计。
  const unknownItemNames: string[] = [];
  const unknownFields = new Set<string>();
  let knownKcal = 0;
  let unknownCount = 0;
  for (const inst of model.insts) {
    const n = inst.selVars.reduce((s, vv) => s + v(model.lp.varNames[vv]), 0);
    if (n <= 0) continue;
    if (inst.kcalKnown) knownKcal += inst.kcal * n;
    for (const field of inst.unknownNutrition) unknownFields.add(field);
    if (inst.unknownNutrition.length > 0 || !inst.kcalKnown) {
      unknownCount += n;
      if (!unknownItemNames.includes(inst.optName)) unknownItemNames.push(inst.optName);
    }
  }
  const nutritionCompleteness = {
    complete: unknownCount === 0,
    unknownItems: unknownItemNames,
    unknownFields: [...unknownFields],
    knownKcal,
    totalKcal: totals.kcal,
    unknownCount,
  };
  notes.push('求解状态：' + (allOptimal ? 'proven-optimal' : 'feasible') + '；结果为模型内最优，需经渠道计价接口核价后为准。');
  return {
    status: allOptimal ? 'proven-optimal' : 'feasible',
    assignments, memberAllocations, leftovers,
    unmetDemands: [...model.noCandidate, ...unsatisfied],
    coverage: { total: model.demands.length, met: model.demands.length - unsatisfied.length },
    gapTotal, totals, notes, lpStats, solutionPlanCuts,
    nutritionCompleteness,
  };
}

// ---------- Top-K：no-good 迭代，返回最多 K 个「食物内容真实不同」的完整购物篮 ----------

/** 食物内容签名（v1.4.6 R02 / v1.4.7 R02-R03）：只描述「吃什么」——食品身份/规格/数量，
 *  **不含 planId / 购买渠道 / 价格**。同一食品组合从实时券、知识库券、官方套餐获得时不构成新方案；
 *  「从哪里买」由上层（unifyCandidates）作为同一组合的可选购买途径并列展示。
 *  身份规则与跨轨/前端共用 foodIdentity：有 optionCode 以 code 为准（同 code 别名归同一身份），
 *  无 code 时名称+规格共同参与——不同规格不会因名称相同被误合并，也不会用热量冒充规格。 */
function foodSignatureOf(r: OptimizeResult): string {
  const units: FoodUnitRef[] = [];
  for (const a of r.assignments) {
    if (a.units.length === 0) {
      units.push({ name: a.planName, qty: a.qty });
      continue;
    }
    for (const u of a.units) {
      for (const sc of u.slotChoices) {
        units.push({ code: sc.optionCode, name: sc.chosenName, spec: sc.specLabel, qty: 1, nonFood: sc.nonFood });
      }
    }
  }
  return foodMultisetSignature(units);
}

export async function optimizeTopK(
  input: OptimizeInput,
  k = 3,
  opts: { maxIterations?: number; shouldStop?: () => boolean; onTruncated?: (info: { want: number; got: number; freshIterations: number; totalIterations: number }) => void } = {},
): Promise<OptimizeResult[]> {
  // v1.4.2 R01：入口归一（别名 carb→carbohydrate、未知度量显式报错）——fail-fast，避免进入多轮求解后才报错
  input = normalizeOptimizeInput(input);
  const want = Math.max(1, k);
  const out: OptimizeResult[] = [];
  const seenFood = new Set<string>();
  // v1.4.2 R05：cuts 现在是「完整购物篮割」列表（每轮一个），不再是逐计划割的扁平列表。
  const cuts: BasketNoGoodCut[] = [];
  // v1.4.7 R11：迭代预算只计「新增不同食品内容」的轮次。
  //   旧实现把「内容重复解」也计入 K×3 预算：9 条同内容 A 路径 + 稍贵的 B 时，预算被 A 耗尽，
  //   B 根本没被搜索到，页面却像「只有一种组合」。重复解仍推进 no-good 割，但不再吃新鲜名额。
  const maxFreshIter = Math.max(want, opts.maxIterations ?? want * 3);
  const maxTotalIter = Math.max(maxFreshIter, want * 3, 60);
  let freshIter = 0;
  let totalIter = 0;
  // v1.4.7 R11：区分「搜索空间已穷尽」与「预算用尽」。
  //   穷尽时 got<want 是事实（确实只有这些组合），不得标成「达到迭代预算、可能还有未列出的组合」——
  //   旧实现只要 got<want 就上报截断，等于对「只有一种组合」的场景说谎。
  let stopReason: 'want-met' | 'exhausted' | 'cancelled' | 'budget' = 'budget';
  while (out.length < want && freshIter < maxFreshIter && totalIter < maxTotalIter) {
    if (opts.shouldStop?.()) { stopReason = 'cancelled'; break; } // v1.3：阶段取消钩子（等待反馈轮）
    totalIter++;
    const r = await optimize(input, { noGoodCuts: cuts });
    if (r.status === 'infeasible') { stopReason = 'exhausted'; break; }
    const key = foodSignatureOf(r);
    const fresh = !seenFood.has(key);
    seenFood.add(key);
    if (fresh) { out.push(r); freshIter++; }
    // v1.4.2 R05：把本解作为一个完整购物篮割（覆盖全部计划）整体推入——
    // 只要求「至少一个计划配置发生变化」，不再逐计划强制变化，从而保留 A+C 这类
    // 「A 不变、B→C」的合法购物篮；数量扩展/换品仍是合法候选，玩具变体自动落在割内。
    if (r.solutionPlanCuts.length === 0) { stopReason = 'exhausted'; break; }
    cuts.push(r.solutionPlanCuts);
  }
  if (out.length >= want) stopReason = 'want-met';
  // 只有「预算用尽且未凑满 K」才如实上报「备选搜索截断」（调用方在方案里标注，不得暗示只有一种组合）
  if (stopReason === 'budget') {
    opts.onTruncated?.({ want, got: out.length, freshIterations: freshIter, totalIterations: totalIter });
  }
  return out;
}
