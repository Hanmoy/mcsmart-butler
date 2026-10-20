// 共享业务服务层（Skill 化改造 #1/#2 核心）：
//   网页路由（server.ts）与 CLI（cli.ts）的唯一业务编排来源——同一套算法、同一套契约、同一份配置。
//   本层只做「输入归一 → 调内核（menu/optimizer/groupKernel/vouchers/mcdna）→ 输出契约组装」；
//   商品匹配、套餐选配、营养计算、约束判断、方案排序与分账全部由确定性内核完成，
//   智能体/前端不得重新手算，避免同样输入产生不同结果。
import { join, dirname } from 'node:path';
import { McpClient } from './mcp.js';
import { findStores, loadMenuItems, type MenuLoadResult, type MenuItem } from './menu.js';
import { runWithOrderContext, reservationDateOf } from './orderContext.js';
import { resolveTargetTime, formatLocalDate, periodOfDate, type TargetTime } from './mealPeriod.js';
import { collectPeriodCatalog, sellablePoolOf, buildOmissionLedger, buildMenuAudit, type PeriodCatalog, type LedgerRow, type MenuAuditRow } from './periodCatalog.js';
import type { GroupMember } from './group.js';
import { parseGroupText } from './group.js';
import type { UserVoucherInput, VoucherTrackSolution } from './vouchers.js';
import { parseUserVoucher } from './vouchers.js';
import { fetchMcdnaStats, type AmountMode } from './mcdna.js';
import { createMcdnaSnapshot, renderMcdnaReport, McdnaReportError, MCDNA_TEMPLATES, MCDNA_ASSET_FILES } from './mcdnaReport.js';
import { OrderFormatError } from './orders.js';
import { optimizeTopK, buildPlansFromMenuItems, type MemberReq, type MetricConstraint, type PriorityGoal, type OptimizeResult } from './optimizer.js';
import { solveGroupWithKernel, recallChannelPlans, type KernelGroupSolution, type ChannelDiagnostics } from './groupKernel.js';
import type { GroupSolution } from './group.js';
import { CONFIG, applyUserConfig, readCredentials } from './config.js';
import { getLayout, userHomePaths, panelHtmlPath } from './paths.js';
import { catalogStats, menuStoreDetails } from './catalog.js';
import { lookupOfficialNutrition } from './officialNutrition.js';
import { resolveIndependentUnionCredentials } from './unionCps.js';
import { existsSync } from 'node:fs';

// ---------- 输入归一（CLI 与 HTTP 共用） ----------

/** 内核规范度量名（optimizer.MetricName）：入口只认这一套，用户可读别名在下方统一转换。
 *  修复 R01：历史实现把用户目标 `carb` 直接断言成内核 PriorityGoal，内核只认 `carbohydrate`，
 *  度量取到 undefined → HiGHS 报 Unable to read LP model。此处显式别名转换，不再冒充内核类型。 */
const CANONICAL_METRICS = ['protein', 'fat', 'carbohydrate', 'sodium', 'fastCarb', 'veggie', 'staple', 'kcal'] as const;
type CanonicalMetric = typeof CANONICAL_METRICS[number];

/** 用户可读度量名 → 内核规范名（carb/carbs 为 carbohydrate 别名）。大小写不敏感。 */
const METRIC_ALIAS: Readonly<Record<string, CanonicalMetric>> = {
  protein: 'protein', fat: 'fat', carbohydrate: 'carbohydrate', carbs: 'carbohydrate', carb: 'carbohydrate',
  sodium: 'sodium', fastcarb: 'fastCarb', veggie: 'veggie', staple: 'staple', kcal: 'kcal',
};

/** 用户可读优化目标 → 内核 PriorityGoal（仅营养度量与 price；kcal/kcal-fill/price-fill 由热量贴合阶段承载）。 */
const OBJECTIVE_ALIAS: Readonly<Record<string, PriorityGoal>> = {
  protein: 'protein', fat: 'fat', carbohydrate: 'carbohydrate', carbs: 'carbohydrate', carb: 'carbohydrate',
  sodium: 'sodium', fastcarb: 'fastCarb', veggie: 'veggie', price: 'price',
};

/** 非优先级目标名（由 fit 阶段承载，可出现在 objectives 里但不映射为 PriorityGoal）。 */
const NON_PRIORITY_OBJECTIVES: ReadonlySet<string> = new Set(['kcal', 'kcal-fill', 'price-fill']);
const LEGAL_OBJECTIVE_TEXT = 'protein/fat/carbohydrate/sodium/fastCarb/veggie/price/kcal/kcal-fill/price-fill（carb、carbs 为 carbohydrate 别名）';

const normKey = (raw: unknown): string => String(raw ?? '').trim().toLowerCase();

/** 归一化营养硬约束（唯一入口；响应回显与实际入模共用同一份，修复 R02）：
 *  - 别名转换（carb/carbs → carbohydrate；fastCarb 大小写不敏感）
 *  - 仅接受 op '>=' / '<='
 *  - 未知 metric/op、非数值 value → E_INPUT_INVALID（不再静默丢弃）
 *  - 同一 (metric, op) 重复 → 取最紧值（>= 取最大、<= 取最小），避免重复建行
 *  - 默认正餐定义 staple>=1（用户显式设置 staple 约束时不注入，避免打架）
 *  - 同度量上下界矛盾（如 kcal<=500 且 kcal>=900）→ E_NO_SOLUTION（明确无解） */
export function normalizeConstraints(raw: unknown): MetricConstraint[] {
  // v1.4.8 R14：容器类型必须显式校验。旧实现 `Array.isArray(raw) ? raw : []` 把
  //   `constraints:{metric:'sodium',op:'<=',value:800}`（对象而非数组）静默当成「无约束」，
  //   用户以为的钠上限从未进入模型，响应也不回显；字符串容器同样被静默丢弃。
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    throw new ServiceError('E_INPUT_INVALID',
      `constraints 必须是数组（收到 ${typeof raw}）`,
      'constraints 形如 [{ metric: "sodium", op: "<=", value: 800 }]');
  }
  const list = Array.isArray(raw) ? raw : [];
  const lower = new Map<CanonicalMetric, number>();
  const upper = new Map<CanonicalMetric, number>();
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ServiceError('E_INPUT_INVALID', `constraints 的每一项必须是对象（收到「${String(item)}」）`,
        'constraints 形如 [{ metric: "sodium", op: "<=", value: 800 }]');
    }
    const c = item as { metric?: unknown; op?: unknown; value?: unknown };
    const metric = METRIC_ALIAS[normKey(c?.metric)];
    if (!metric) {
      throw new ServiceError('E_INPUT_INVALID',
        `未知营养度量「${c?.metric ?? ''}」（合法值：${CANONICAL_METRICS.join('/')}；carb、carbs 为 carbohydrate 别名）`,
        '见 references/contracts.md §4 的 constraints 字段说明');
    }
    const op = c?.op === '>=' ? '>=' : c?.op === '<=' ? '<=' : null;
    if (!op) {
      throw new ServiceError('E_INPUT_INVALID', `不支持的操作符「${c?.op ?? ''}」（合法值：>= / <=）`,
        'constraints 形如 [{ metric: "sodium", op: "<=", value: 800 }]');
    }
    // v1.4.8 R14：null / 布尔 / 空字符串**不得**被 Number() 转成 0。
    //   旧实现 `Number(null) === 0` → 实际建成 sodium <= 0（用户没给值却得到「零钠」硬约束）。
    const rawVal = c?.value;
    const value = typeof rawVal === 'number' ? rawVal
      : typeof rawVal === 'string' && rawVal.trim() !== '' ? Number(rawVal)
      : Number.NaN;
    if (!Number.isFinite(value)) {
      throw new ServiceError('E_INPUT_INVALID',
        `约束 ${metric} ${op} 的 value 必须是数值（收到「${String(rawVal ?? '')}」）`,
        'value 不接受 null、布尔值或空字符串');
    }
    const bag = op === '<=' ? upper : lower;
    const prev = bag.get(metric);
    bag.set(metric, prev === undefined ? value : (op === '<=' ? Math.min(prev, value) : Math.max(prev, value)));
  }
  if (!lower.has('staple') && !upper.has('staple')) lower.set('staple', 1); // 默认正餐：至少 1 份主食
  for (const [metric, lo] of lower) {
    const hi = upper.get(metric);
    if (hi !== undefined && lo > hi) {
      throw new ServiceError('E_NO_SOLUTION', `约束矛盾：${metric} 下界 ${lo} 大于上界 ${hi}，无可行方案`,
        '请移除其中一条或放宽上下界后重试');
    }
  }
  const out: MetricConstraint[] = [];
  for (const metric of CANONICAL_METRICS) {
    if (lower.has(metric)) out.push({ metric, op: '>=', value: lower.get(metric)! });
    if (upper.has(metric)) out.push({ metric, op: '<=', value: upper.get(metric)! });
  }
  return out;
}

/** 用户目标 → 内核优先级目标（有序 ≤2）；未知目标抛 E_INPUT_INVALID（修复 R01 的断言掩盖）。 */
export function toPriorityGoals(raw: unknown): PriorityGoal[] {
  const goals: PriorityGoal[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const key = normKey(item);
    if (NON_PRIORITY_OBJECTIVES.has(key)) continue;
    const g = OBJECTIVE_ALIAS[key];
    if (!g) {
      throw new ServiceError('E_INPUT_INVALID', `未知优化目标「${item ?? ''}」（合法值：${LEGAL_OBJECTIVE_TEXT}）`,
        '见 references/contracts.md §4 的 objectives 字段说明');
    }
    goals.push(g);
  }
  return goals.slice(0, 2);
}

/** v1.3 等待反馈轮：阶段上报 + 取消钩子（CLI 可不传；HTTP 异步任务由 server 注入）。
 *  阶段名即用户可读文案：准备菜单 → 解析团购 → 优化组合 → 核验价格 → 生成方案。 */
export interface ServiceHooks {
  onStage?: (stage: string, note?: string) => void;
  /** 取消检查点：已取消时抛 E_CANCELLED（各阶段之间调用；求解循环内部亦有检查点） */
  assertLive?: () => void;
}

export interface StoresInput {
  city?: string;
  keyword?: string;
}

export interface SolveSingleInput {
  /** 热量预算上限 kcal（1..5000） */
  kcal?: number;
  /** 整单实付预算，元（1..500；内部转分） */
  yuan?: number;
  /** 有序优化目标（≤2 个，顺序即优先级） */
  objectives?: string[];
  /** 营养度量硬约束 */
  constraints?: Array<{ metric?: string; op?: string; value?: number }>;
  city?: string; keyword?: string; storeCode?: string; storeName?: string;
  preferCombo?: boolean;
  /** v1.4.9 N01：目标用餐时间（`HH:mm` 或 `yyyy-MM-dd HH:mm`）。缺省为即时口径（不传 reservationDate）。 */
  targetTime?: string;
}

export interface SolveGroupInput {
  storeCode?: string; storeName?: string;
  /** v1.3：城市上下文（美团团单检索 cityId；面板城市下拉透传） */
  city?: string;
  /** 结构化成员（经智能体/前端确认卡修正后） */
  members?: Array<Partial<GroupMember>>;
  /** 粘贴群聊文本（规则解析降级路径；对话场景 LLM 解析为主路径） */
  pastedText?: string;
  userVouchers?: UserVoucherInput[];
  /** v1.4.9 N01：目标用餐时间（`HH:mm` 或 `yyyy-MM-dd HH:mm`）。缺省为即时口径。 */
  targetTime?: string;
}

export interface McdnaInput {
  demo?: boolean;
  amountMode?: 'tier' | 'full';
  templateId?: string;
  /** 复用同一统计快照，不重新读订单；网页与新CLI进程均可接入。 */
  reportId?: string;
  commentary?: unknown;
}

// ---------- 门店查询 ----------

export interface StoreView {
  storeCode: string; storeName: string; address: string;
  distance?: number; open: boolean;
}

export async function serviceStores(client: McpClient, input: StoresInput): Promise<{
  city: string; keyword: string; cap: number; stores: StoreView[];
}> {
  const city = (input.city ?? '').trim();
  if (!city) throw new ServiceError('E_INPUT_INVALID', '缺少 city 参数（城市名，如「上海」）');
  const keyword = (input.keyword ?? city).trim() || city;
  const stores = await findStores(client, city, keyword);
  return {
    city, keyword, cap: 5,
    stores: stores.map((s) => ({
      storeCode: s.storeCode, storeName: s.storeName, address: s.address,
      distance: s.distance, open: s.businessStatus ?? false,
    })),
  };
}

// ---------- 分时段产品目录（v1.4.9 N01） ----------
//
// 评审要求：先收集各餐段商品，再按目标门店/日期/时段生成**独立**可售池，
//   不能把早餐与午晚餐混成一个即时可买方案。本入口只读官方菜单（不碰团购门店校验），
//   返回：分时段目录 + 两个餐段各自的可售池摘要 + 目标时段的逐商品遗漏账。

export interface PeriodCatalogInput {
  storeCode?: string; storeName?: string;
  city?: string; keyword?: string;
  /** 目录日期 `yyyy-MM-dd`，缺省为今天 */
  date?: string;
  /** 目标用餐时间（`HH:mm` 或 `yyyy-MM-dd HH:mm`），缺省按当前时刻所属餐段出账 */
  targetTime?: string;
}

export interface PeriodCatalogOutput {
  storeCode: string;
  storeName: string;
  catalog: PeriodCatalog;
  pools: Array<{ period: 'breakfast' | 'regular'; count: number; excluded: number; failedQueries: number; note: string }>;
  /** 目标时段的逐商品遗漏账 */
  targetPeriod: 'breakfast' | 'regular';
  ledger: LedgerRow[];
  orderContext: OrderContextEcho;
}

export async function servicePeriodCatalog(client: McpClient, input: PeriodCatalogInput): Promise<PeriodCatalogOutput> {
  let storeCode = input.storeCode?.trim();
  let storeName = input.storeName?.trim() ?? '';
  if (!storeCode) {
    const city = input.city?.trim() || CONFIG.defaultCity;
    const keyword = input.keyword?.trim() || CONFIG.defaultKeyword;
    const stores = await findStores(client, city, keyword);
    const open = stores.find((s) => s.businessStatus) ?? stores[0];
    if (!open) {
      throw new ServiceError('E_STORE_NOT_FOUND', `「${city}」未查询到门店，请确认城市/关键词后重试，或在面板中手动选择门店`);
    }
    storeCode = open.storeCode;
    storeName = storeName || open.storeName;
  }
  const target = resolveTargetTimeOrThrow(input.targetTime);
  const catalog = await collectPeriodCatalog(client, { storeCode, ...(input.date ? { date: input.date } : {}) });
  const periods: Array<'breakfast' | 'regular'> = ['breakfast', 'regular'];
  const pools = periods.map((p) => {
    const pool = sellablePoolOf(catalog, p);
    return { period: p, count: pool.items.length, excluded: pool.excluded.length, failedQueries: pool.failedQueries.length, note: pool.note };
  });
  const targetPeriod: 'breakfast' | 'regular' = target?.period ?? periodOfDate(new Date());
  const pool = sellablePoolOf(catalog, targetPeriod);
  return {
    storeCode,
    storeName,
    catalog,
    pools,
    targetPeriod,
    ledger: buildOmissionLedger(catalog, pool),
    orderContext: orderContextOut(target),
  };
}

// ---------- 单人双预算精算（模块 A，MILP 内核） ----------

/** 输入本地校验（无网络依赖；CLI 在构造 McpClient 前调用，保证输入错误优先于凭据错误报告）。
 *  注意检查原始值而非 clamp 后的值——历史实现 `Math.max(1, Number(x)||0)` 会把缺失字段静默钳成 1。
 *  v1.3 语义澄清：kcal 是「热量目标值」（fit 模式自动贴合，允许上下偏离），
 *  不是硬上限——硬上限需通过显式营养约束（constraints: [{metric:'kcal', op:'<=', value}]）设置。 */
export function validateSolveSingleInput(body: SolveSingleInput): void {
  const kcalRaw = Number(body.kcal);
  const yuanRaw = Number(body.yuan);
  if (!Number.isFinite(kcalRaw) || kcalRaw < 1 || kcalRaw > 5000) {
    throw new ServiceError('E_INPUT_INVALID', 'kcal 必须是 1..5000 的数值（热量目标值，单位 kcal；算法自动贴合，不是硬上限）',
      '输入样例见 references/examples.md 例 1');
  }
  if (!Number.isFinite(yuanRaw) || yuanRaw < 1 || yuanRaw > 500) {
    throw new ServiceError('E_INPUT_INVALID', 'yuan 必须是 1..500 的数值（整单实付预算，单位元）',
      '输入样例见 references/examples.md 例 1');
  }
  for (const o of body.objectives ?? []) {
    const key = normKey(o);
    if (!NON_PRIORITY_OBJECTIVES.has(key) && !OBJECTIVE_ALIAS[key]) {
      throw new ServiceError('E_INPUT_INVALID', `未知优化目标「${o ?? ''}」（合法值：${LEGAL_OBJECTIVE_TEXT}）`,
        '见 references/contracts.md §4 的 objectives 字段说明');
    }
  }
  normalizeConstraints(body.constraints); // 约束合法性/矛盾在入口即报（无网络依赖）
  resolveTargetTimeOrThrow(body.targetTime); // v1.4.9 N01：目标用餐时间格式在入口即报（不静默退回「现在」）
}

/** 目标用餐时间解析：非法格式一律 E_INPUT_INVALID（N01 要求「未选时间保持即时口径」，
 *  但不能把写错的预约时间悄悄当成即时口径——那会让用户以为已按 08:00 报价）。 */
function resolveTargetTimeOrThrow(raw: string | undefined): TargetTime | null {
  try {
    return resolveTargetTime(raw);
  } catch (e) {
    throw new ServiceError('E_INPUT_INVALID', e instanceof Error ? e.message : String(e),
      'targetTime 支持 HH:mm（今天该时刻）或 yyyy-MM-dd HH:mm；不传表示按当前时刻的即时口径');
  }
}

/** 目标时间的可读口径（输出回显 + 审计） */
function orderContextOut(target: TargetTime | null): {
  mode: 'immediate' | 'scheduled';
  targetTime?: string;
  reservationDate?: string;
  period?: 'breakfast' | 'regular';
  periodLabel?: string;
  note: string;
} {
  if (!target) {
    return {
      mode: 'immediate',
      note: '即时口径：菜单/套餐构成/计价均未传 reservationDate，按当前时刻查询。',
    };
  }
  return {
    mode: 'scheduled',
    targetTime: target.targetTime,
    reservationDate: target.reservationDate,
    period: target.period,
    periodLabel: target.period === 'breakfast' ? '早餐' : '常规时段',
    note: `预约口径：菜单、套餐构成与计价均按 ${target.reservationDate}（${target.period === 'breakfast' ? '早餐' : '常规时段'}）查询；`
      + '预约可售范围以官方该时刻返回为准，未返回的品项不进入本轮可购池。',
  };
}

// ---------- 只查券：不求解也能独立刷新团单清单（UI-4 数据闭环） ----------
//
// 背景：旧面板的「刷新最近结果中的团购券」只是重渲染上一次求解缓存的列表——只想查券的用户
//   必须先跑一次完整求解。此处提供只查询渠道、不做 MILP 的入口：解析门店 → 载入菜单（供同名
//   核验）→ 调 recallChannelPlans 拿渠道诊断，返回逐单状态/价格/未核验原因，供面板独立展示与导入。
export interface DealsOnlyInput { storeCode?: string; storeName?: string; city?: string; keyword?: string }
export interface DealsOnlyOutput {
  storeCode: string;
  storeName: string;
  menuAvailable: boolean;
  diagnostics: ChannelDiagnostics;
  /** 逐单清单（含未入池者；status 区分 可自动比价 / 价格候选 / 不可购买） */
  deals: NonNullable<ChannelDiagnostics['union']['deals']>;
}

export async function serviceDealsOnly(client: McpClient, input: DealsOnlyInput, hooks: ServiceHooks = {}): Promise<DealsOnlyOutput> {
  let storeCode = input.storeCode?.trim();
  let storeName = '';
  if (storeCode) {
    storeName = input.storeName?.trim() || `门店 ${storeCode}`;
  } else {
    const city = input.city?.trim() || CONFIG.defaultCity;
    const keyword = input.keyword?.trim() || CONFIG.defaultKeyword;
    const stores = await findStores(client, city, keyword);
    const open = stores.find((s) => s.businessStatus) ?? stores[0];
    if (!open) {
      throw new ServiceError('E_STORE_NOT_FOUND', `「${city}」未查询到门店，请确认城市/关键词后重试，或在面板中手动选择门店`, '用面板「查询门店」或 stores 命令确认门店后再查券');
    }
    storeCode = open.storeCode;
    storeName = `${open.storeName}（${open.address}）`;
  }
  hooks.onStage?.('准备菜单', '查询门店实时菜单（供同名核验）');
  hooks.assertLive?.();
  const EMPTY_MENU: MenuLoadResult = { items: [], unmatched: 0, comboCount: 0, comboUnmatched: 0, table: new Map() };
  let menuData: MenuLoadResult | null = null;
  try {
    menuData = await loadMenuItems(client, storeCode, { includeUnmatched: true });
  } catch { /* 菜单不可用不阻塞查券：同名核验会相应降级，诊断如实反映 */ }
  hooks.onStage?.('解析团购', '查询当地美团团单并逐项核验券面内容');
  hooks.assertLive?.();
  const { diagnostics } = await recallChannelPlans(client, { storeCode, storeName, city: input.city }, menuData ?? EMPTY_MENU, []);
  return {
    storeCode,
    storeName,
    menuAvailable: !!menuData,
    diagnostics,
    deals: diagnostics.union.deals ?? [],
  };
}

export async function serviceSolveSingle(client: McpClient, body: SolveSingleInput, hooks: ServiceHooks = {}): Promise<SingleSolveOutput> {
  validateSolveSingleInput(body);
  const target = resolveTargetTimeOrThrow(body.targetTime);
  // v1.4.9 N01：整条链路（菜单 → 套餐详情 → 计价）共用一个下单上下文，
  //   叶子调用按上下文补 reservationDate，避免「菜单按 08:00 查、计价按现在算」。
  return runWithOrderContext({
    orderType: 1,
    beType: 1,
    ...(target ? { reservationDate: target.reservationDate, period: target.period, targetTime: target.targetTime } : {}),
  }, () => solveSingleImpl(client, body, hooks, target));
}

async function solveSingleImpl(
  client: McpClient,
  body: SolveSingleInput,
  hooks: ServiceHooks,
  target: TargetTime | null,
): Promise<SingleSolveOutput> {
  validateSolveSingleInput(body); // 本地校验（CLI 也会在构造 client 前调用同一函数）
  const kcal = Math.max(1, Math.min(5000, Number(body.kcal) || 0));  const yuan = Math.max(1, Math.min(500, Number(body.yuan) || 0));
  // v6 目标语义：kcal 贴合为第一段（fit），用户首目标为第二段（带内最优），最低价随后。
  // 修复 R01：入口显式别名转换（carb → carbohydrate），不再用 `v is PriorityGoal` 断言冒充内核类型。
  const priorities = toPriorityGoals(body.objectives);

  // 修复 R02：唯一归一化入口——响应回显与实际入模共用同一份，非法项明确拒绝而非静默丢弃。
  const constraints = normalizeConstraints(body.constraints);

  // 门店解析：显式 storeCode > 城市/关键词搜索。
  // v1.2：不再静默回退演示门店——查询失败/无门店时明确报错，由用户手动选择（演示门店不得冒充当地门店）。
  let storeCode = body.storeCode?.trim();
  let storeName = '';
  if (storeCode) {
    storeName = body.storeName?.trim() || `门店 ${storeCode}`;
  } else {
    const city = body.city?.trim() || CONFIG.defaultCity;
    const keyword = body.keyword?.trim() || CONFIG.defaultKeyword;
    const stores = await findStores(client, city, keyword);
    const open = stores.find((s) => s.businessStatus) ?? stores[0];
    if (!open) {
      throw new ServiceError('E_STORE_NOT_FOUND', `「${city}」未查询到门店，请确认城市/关键词后重试，或在面板中手动选择门店`, '用面板「查询门店」或 stores 命令确认门店后再精算');
    }
    storeCode = open.storeCode;
    storeName = `${open.storeName}（${open.address}）`;
  }

  // v1.2 渠道解耦：官方菜单（实时 → 快照 → 不可用）与美团渠道分别查询、分别返回状态。
  // 官方菜单不可用时不再中断——美团查询照常运行，用户需求与渠道结果保留在响应中。
  hooks.onStage?.('准备菜单', '查询门店实时菜单与营养表');
  hooks.assertLive?.();
  const EMPTY_MENU: MenuLoadResult = { items: [], unmatched: 0, comboCount: 0, comboUnmatched: 0, table: new Map() };
  let menuData: MenuLoadResult | null = null;
  let menuError: string | null = null;
  try {
    menuData = await loadMenuItems(client, storeCode, {
      includeUnmatched: true,
      ...(target ? { reservationDate: target.reservationDate, mealPeriod: target.period } : {}),
    });
  } catch (e) {
    menuError = e instanceof Error ? e.message : String(e);
  }

  // v1.4.11 W02：单人建池同样传入官方营养表。旧实现只传 items，套餐内组件（不单卖）在
  //   官方营养表里有精确行也被当成「营养未知」→ 单人方案营养合计为 0，kcal 上限误报无解。
  //   只做同食品同规格联结（matchNutrition），不把套餐总营养摊给组件。
  const { comboPlans, singlePlans } = menuData
    ? buildPlansFromMenuItems(menuData.items, { includeSingle: true, table: menuData.table })
    : { comboPlans: [], singlePlans: [] };
  // 修复 R02：由同一份归一化约束派生内核入参（不再另建一份「展示用」约束）。
  //   kcal<= 由 kcalCap 承载、staple>= 由 stapleMin 承载，其余度量走 metrics——
  //   同一 (metric, op) 只建一行，避免重复行名导致 HiGHS 读模型失败。
  const kcalCapC = constraints.find((c) => c.metric === 'kcal' && c.op === '<=');
  const stapleMinC = constraints.find((c) => c.metric === 'staple' && c.op === '>=');
  const explicitKcalCap = kcalCapC ? kcalCapC.value : undefined;
  const stapleMin = stapleMinC ? stapleMinC.value : undefined;
  const metrics: MetricConstraint[] = constraints.filter((c) =>
    !(c.metric === 'kcal' && c.op === '<=') && !(c.metric === 'staple' && c.op === '>='));
  // 评审三轮：¥N 预算属于「整单实付」口径——totalBudgetCents 按真实购买价（底价+差价）约束
  const memberReq: MemberReq = {
    alias: '我',
    ...(explicitKcalCap !== undefined ? { kcalCap: explicitKcalCap } : {}),
    ...(stapleMin !== undefined && stapleMin > 0 ? { stapleMin } : {}),
    metrics,
  };
  // 评审三轮 #1：美团渠道接入单人求解池（白名单/同名核验团单 strictCover 联合求解 + 渠道诊断）
  hooks.onStage?.('解析团购', '查询当地美团团单并逐项核验券面内容');
  hooks.assertLive?.();
  const { voucherPlans, diagnostics } = await recallChannelPlans(client, { storeCode, storeName, city: body.city }, menuData ?? EMPTY_MENU, []);
  hooks.onStage?.('优化组合', `MILP 求解（套餐 ${comboPlans.length} + 券方案 ${voucherPlans.length}）`);
  hooks.assertLive?.();
  // v1.4.10 W01 回归修复：官方菜单不可用时**不把券方案当作可推荐购物篮**。
  //   v1.2 契约（AGENTS.md）：菜单不可用且无快照时，单人返回「保留美团团单列表的需求回执」。
  //   W01 把可核验券从个位数扩到数十条后，券方案足以凑出「可行解」，于是假门店号也会得到
  //   一份实付与推荐——门店本身都不存在，不能这样承诺。券仍作为价格候选保留在渠道诊断里。
  const solvableVoucherPlans = menuData ? voucherPlans : [];
  const basePlans = [...comboPlans, ...solvableVoucherPlans];
  const plansWithSingles = [...comboPlans, ...singlePlans, ...solvableVoucherPlans];
  const solveInput = {
    plans: basePlans, members: [memberReq], mode: 'fit' as const, kcalBudget: kcal,
    totalBudgetCents: Math.round(yuan * 100), fitToleranceKcal: CONFIG.fitToleranceKcal, priorities,
    strictSurplus: CONFIG.strictSurplusSingle,
    externalCouponLimit: CONFIG.externalCouponLimit,
  };
  // v1.4.7 R11：预算只计「新增不同食品内容」的轮次；重复内容解不再吃名额。
  //   预算耗尽时如实标注「备选搜索截断」，不暗示只有一种组合。
  let searchTruncated = false;
  const topKIter = {
    maxIterations: CONFIG.topK * 3,
    shouldStop: () => { hooks.assertLive?.(); return false; },
    onTruncated: () => { searchTruncated = true; },
  };
  let results: OptimizeResult[] = [];
  let singleFallback = false;
  // 兜底 P2：只有单品、没有可用套餐/券时也必须在单品池上求解（旧实现被外层
  //   comboPlans+voucherPlans>0 挡住 → 直接无解）。先解套餐/券基础池，无解或有单品可用时再放宽加单品。
  if (basePlans.length > 0) {
    results = await optimizeTopK(solveInput, CONFIG.topK, topKIter);
  }
  if (results.length === 0 && singlePlans.length > 0) {
    // v5（评审#3）：无糖可乐等真零热量单品回归候选池（kcalKnown 区分零热量与营养未知）。
    results = await optimizeTopK({ ...solveInput, plans: plansWithSingles }, CONFIG.topK, topKIter);
    singleFallback = basePlans.length > 0 && results.length > 0;
  }
  hooks.onStage?.('生成方案', '组装购买清单与营养摘要');
  // v6 输出：Top-K 个「完整购物篮」方案（不再把单个购买项包装成方案）；renderSol 原生支持备选列表
  const cnt = (sc: { count?: number }): number => sc.count ?? 1;
  const fromSnapshot = !!menuData?.fromSnapshotAt;
  const priceSourceOut: 'snapshot' | 'model-optimal' = fromSnapshot ? 'snapshot' : 'model-optimal';
  const priceNoteOut = fromSnapshot
    ? `历史快照参考价（${(menuData!.fromSnapshotAt ?? '').slice(0, 10)} 最后观测价，非实时；实际以门店结算为准）`
    : 'MILP 模型内最优价（套餐默认配置 + 槽位差价），换选与结算以下单页为准';
  const solutions = results.map((r) => {
    const items = r.assignments.map((asg) => {
      const isSingle = asg.planId.startsWith('mcd-s-');
      const isVoucher = asg.planId.startsWith('kv-');
      // v1.4.6 R03：券计划同样输出完整槽位与任选范围（旧实现只查 comboPlans →
      //   券方案 deconstruction 恒为 []，前端只能显示券名，看不到实际选中的食品与可替换项）。
      const chosenPlan = comboPlans.find((cp) => cp.id === asg.planId)
        ?? voucherPlans.find((vp) => vp.id === asg.planId);
      const slotChoices = asg.slotChoices;
      const kcalSum = slotChoices.reduce((s, sc) => s + (sc.nonFood ? 0 : sc.kcal * cnt(sc)), 0);
      const planPriceCents = asg.qty * asg.basePriceCents + slotChoices.reduce((s, sc) => s + sc.diffCents * cnt(sc), 0);
      const nutritionComplete = slotChoices.every((sc) => sc.nonFood || (sc.kcalKnown !== false && !sc.unknownNutrition?.length));
      // v1.4 修复（评审第 3 项）：按「套餐槽位序号 + roundId + 选项 code」定位实际选中项，
      // 不再用 roundName 查找（两个槽位同名「小食」时第二槽会串取第一槽的选中项）。
      // 同一份套餐的每个购买单元保留各自配置（units[]），聚合槽位仅用于汇总展示。
      const pickForSlot = (sl: { roundId?: string; roundName: string }, si: number) => {
        if (sl.roundId) {
          const byRound = slotChoices.find((sc) => sc.roundId === sl.roundId);
          if (byRound) return byRound;
        }
        // 无 roundId（券槽位等）：按槽位序号与首单元选择对齐（同名槽位不再互相串取）
        return asg.units[0]?.slotChoices[si];
      };
      // 修复 R06：输出真实逐份配置——相同配置合并数量、不同配置分行；
      // 不再用聚合后的平均 kcal 冒充两份不同搭配的套餐（旧实现按 roundId find() 取首份）。
      const unitGroups = new Map<string, { qty: number; kcal: number; priceCents: number; config: UnitConfigEntry[] }>();
      for (const u of asg.units ?? []) {
        const config: UnitConfigEntry[] = u.slotChoices.map((sc) => ({
          ...(sc.roundId ? { roundId: sc.roundId } : {}),
          roundName: sc.roundName,
          ...(sc.optionCode ? { chosenCode: sc.optionCode } : {}),
          chosenName: sc.chosenName,
          ...(sc.specLabel ? { specLabel: sc.specLabel } : {}),
          ...(sc.nutritionSource ? { nutritionSource: sc.nutritionSource } : {}),
          ...(sc.estimated ? { nutritionEstimated: true } : {}),
          ...(sc.unknownNutrition?.length ? { nutritionUnknownFields: sc.unknownNutrition.slice() } : {}),
          ...(sc.nonFood ? { nonFood: true } : {}),
        }));
        const unitKcal = u.slotChoices.reduce((s, sc) => s + (sc.nonFood ? 0 : sc.kcal * cnt(sc)), 0);
        const unitPriceCents = asg.basePriceCents + u.slotChoices.reduce((s, sc) => s + sc.diffCents * cnt(sc), 0);
        const key = JSON.stringify(config);
        const hit = unitGroups.get(key);
        if (hit) hit.qty += 1;
        else unitGroups.set(key, { qty: 1, kcal: unitKcal, priceCents: unitPriceCents, config });
      }
      const units = [...unitGroups.values()];
      return {
        code: asg.planId, name: asg.planName, qty: asg.qty,
        // v1.4.7 R09：单价是**参考值**（可能除不尽），行价一律用 subtotalCents。
        //   旧实现用舍入后的单价×份数重建总价：1000/1001 分两份 → 显示 1001×2=2002，而实付 2001。
        price: Math.round(planPriceCents / Math.max(1, asg.qty)),
        subtotalCents: planPriceCents,
        kcal: Math.round(kcalSum / Math.max(1, asg.qty)), kcalTotal: kcalSum, protein: null as number | null,
        category: isVoucher ? '美团团购 · 券品' : isSingle ? '单点（官方 App）' : '套餐（官方 App）',
        channel: (isVoucher ? 'meituan' : 'official') as 'meituan' | 'official',
        channelLabel: isVoucher ? '美团团购券' : isSingle ? '官方 App·小程序（单点）' : '官方 App·小程序（套餐）',
        fastCarb: 0, isVeggie: false, isStaple: true, isCombo: !isSingle && !isVoucher,
        nutritionComplete,
        ...(slotChoices.some((sc) => !!sc.estimated) ? { nutritionEstimated: true } : {}),
        ...(slotChoices.some((sc) => !!sc.unknownNutrition?.length) ? { nutritionUnknownFields: [...new Set(slotChoices.flatMap((sc) => sc.unknownNutrition ?? []))] } : {}),
        ...(slotChoices.some((sc) => !!sc.nutritionSource) ? { nutritionSources: [...new Set(slotChoices.map((sc) => sc.nutritionSource).filter((x): x is string => !!x))] } : {}),
        units,
        stapleCount: slotChoices.filter((sc) => !sc.nonFood && /堡|麦满分|卷|粥/.test(sc.chosenName)).reduce((s, sc) => s + cnt(sc), 0),
        deconstruction: chosenPlan ? chosenPlan.slots.map((sl, si) => {
          const picked = pickForSlot(sl, si);
          return {
            roundName: sl.roundName,
            ...(sl.roundId ? { roundId: sl.roundId } : {}),
            defaultName: picked?.chosenName ?? sl.defaultName ?? sl.options[0]?.name ?? '',
            ...(picked?.optionCode ? { chosenCode: picked.optionCode } : {}),
            options: sl.options.map((o) => ({ name: o.name, diffCents: o.diffCents })),
            category: '',
          };
        }) : [],
      };
    });
    // v1.4.7 R09：输出总价以「条目行价之和」为准（逐份价格求行价，不再用舍入平均单价重建）。
    //   与模型合计不一致时如实记录诊断（不静默改数），守恒关系可被测试逐分核对。
    const itemsSubtotal = items.reduce((s, it) => s + it.subtotalCents, 0);
    const priceCents = itemsSubtotal;
    const priceMismatch = itemsSubtotal !== r.totals.priceCents;
    // 营养同源聚合（评审三轮 #2）：直接用槽位自带宏量（与求解同一份数据），不再按名称回查菜单；
    // 非食品（玩具）不计入营养聚合
    const scs = r.assignments.flatMap((a) => a.slotChoices);
    const foodScs = scs.filter((sc) => !sc.nonFood);
    const nutritionComplete = scs.every((sc) => sc.nonFood || (sc.kcalKnown !== false && !sc.unknownNutrition?.length));
    const nutritionEstimated = scs.some((sc) => !sc.nonFood && !!sc.estimated);
    const nutritionUnknownFields = [...new Set(scs.flatMap((sc) => sc.unknownNutrition ?? []))];
    const nutritionKcalPartial = scs.some((sc) => !sc.nonFood && (sc.kcalKnown === false || sc.unknownNutrition?.includes('kcal')));
    const macro = (pick: (sc: typeof scs[number]) => number): number => Math.round(foodScs.reduce((s, sc) => s + pick(sc) * cnt(sc), 0));
      // v1.4.11 W01：整篮购买热量 vs 本人实际分配热量（内核 asg 层）。
      //   允许剩余时两者不同，必须分别展示；硬上限只对「本人摄入」成立。
      const purchasedKcal = Math.round(foodScs.reduce((s, sc) => s + sc.kcal * cnt(sc), 0));
      const intakeKcal = Math.round(r.memberAllocations[0]?.kcal ?? purchasedKcal);
      // v1.2：推荐理由（各阶段求解决策链，用户可读）随方案输出
      const reasonNotes = [...r.notes];
      if (priceMismatch) reasonNotes.push(`价格核对：条目行价合计 ${itemsSubtotal} 分与模型合计 ${r.totals.priceCents} 分不一致（已按条目行价展示，请以明细为准）。`);
      if (r.leftovers.length > 0 && intakeKcal !== purchasedKcal) {
        reasonNotes.push(`本人摄入口径：整篮 ${purchasedKcal} kcal，按你的硬约束实际分配 ${intakeKcal} kcal，剩余 ${Math.max(0, purchasedKcal - intakeKcal)} kcal（${r.leftovers.map((l) => `${l.itemName}×${l.qty}`).join('、')}）未计入本人摄入；费用仍按整篮支付。`);
      }
      if (items.some((it) => it.category === '美团团购 · 券品')) {
        reasonNotes.push('团购方案未校验具体适用门店，适用性以下单页为准（保留城市召回，不宣称全国通用）。');
        // v1.4.6 R01：券价只含券面有依据的补差；官方换选差价不计入券价
        if (voucherPlans.some((vp) => vp.slots.some((sl) => sl.options.some((o) => !!o.officialDiffCents)))) {
          reasonNotes.push('券渠道的换选补差没有券面依据：官方 App 的换选差价未计入券价；核销时如需补差，以券页/门店为准。');
        }
      }
      return {
        items,
        singleFallback,
        metrics: {
          kcal: Math.round(foodScs.reduce((s, sc) => s + sc.kcal * cnt(sc), 0)), price: priceCents,
          protein: macro((sc) => sc.protein), fat: macro((sc) => sc.fat),
          carb: macro((sc) => sc.carbohydrate), carbohydrate: macro((sc) => sc.carbohydrate),
          sodium: macro((sc) => sc.sodium), fastCarb: macro((sc) => sc.fastCarb),
          veggie: r.totals.veggie, staple: r.totals.staple,
          ...(nutritionComplete ? {} : { nutritionPartial: true as const }),
          ...(nutritionKcalPartial ? { nutritionKcalPartial: true as const } : {}),
          ...(nutritionEstimated ? { nutritionEstimated: true as const } : {}),
          ...(nutritionUnknownFields.length ? { nutritionUnknownFields } : {}),
        },
        // v1.4：营养不完整时，如实给出「缺哪些食品」，供 UI 显示「已知部分合计」而非完整进度/达标
        ...(nutritionComplete ? {} : { nutritionUnknownItems: r.nutritionCompleteness?.unknownItems ?? [] }),
        menuPriceCents: priceCents,
        finalPriceCents: priceCents,
        discountCents: 0,
        priceSource: priceSourceOut,
        priceNote: priceNoteOut,
        // v1.4.11 W01：本人摄入必须取**实际分配**（内核 asg 层），不是整篮合计。
        //   旧实现把整篮热量当本人摄入：显式 kcal<=500 的 800 kcal 套餐会显示「本人 800 kcal 可行」，
        //   而内核实际只分配 400、剩余 400 未分配——页面与文本口径与求解不一致。
        //   金额仍是整篮支付；剩余逐项如实列出。
        memberKcal: intakeKcal,
        intake: {
          purchasedKcal,
          memberKcal: intakeKcal,
          leftoverKcal: Math.max(0, purchasedKcal - intakeKcal),
          complete: r.leftovers.length === 0,
          macros: {
            protein: r.memberAllocations[0]?.protein ?? 0,
            fat: r.memberAllocations[0]?.fat ?? 0,
            carbohydrate: r.memberAllocations[0]?.carbohydrate ?? 0,
            sodium: r.memberAllocations[0]?.sodium ?? 0,
          },
          ...(r.leftovers.length > 0 ? {
            leftovers: r.leftovers.map((l) => ({ itemName: l.itemName, qty: l.qty, kcal: l.kcal, refPriceCents: l.refPriceCents })),
          } : {}),
        },
        solveState: r.status,
        slotChoices: r.assignments.flatMap((a) => a.slotChoices),
        coverage: r.coverage,
        gapTotal: r.gapTotal,
        reasonNotes,
        ...(r.leftovers.length > 0 ? { leftovers: r.leftovers } : {}),
      };
  });
  if (searchTruncated) {
    for (const sol of solutions) {
      (sol.reasonNotes ??= []).push('备选搜索达到迭代预算：已展示的是已找到的最优解，可能仍有未列出的不同组合（并非只有这些组合）。');
    }
  }
  const reasonOut = results.length === 0
    ? (!menuData
        ? `官方菜单暂不可用（${menuError ?? '未知原因'}），无法确认该门店可售商品，因此不生成推荐购物篮；已保留你的预算/目标与美团查询结果（见渠道诊断${(diagnostics.union.deals?.length ?? 0) > 0 ? `，本次查询到 ${diagnostics.union.deals!.length} 张团单` : ''}），可稍后重试或更换门店。`
        : '硬约束下无可行方案（请放宽预算/热量或检查约束）')
    : '';
  return {
    store: { storeCode, storeName },
    feasible: results.length > 0,
    reason: reasonOut,
    scanned: comboPlans.length + singlePlans.length,
    unmatched: menuData?.unmatched ?? 0,
    officialMenu: menuData
      ? menuData.fromSnapshotAt
        ? { status: 'snapshot' as const, snapshotAt: menuData.fromSnapshotAt, ...(menuData.snapshotPoolNote ? { note: menuData.snapshotPoolNote } : {}) }
        : { status: 'realtime' as const }
      : { status: 'unavailable' as const, reason: menuError ?? '' },
    ...(menuData?.fromSnapshotAt ? { menuFromSnapshotAt: menuData.fromSnapshotAt, menuSnapshotNote: menuData.snapshotPoolNote ?? '非营业时段，已使用菜单快照（价格为最后观测价，以实际营业时段结算为准）' } : {}),
    ...(menuData?.unmatched ? { unmatchedNote: '未联结营养的菜单条目数（含套餐组件；官网营养库已回填大部分，非「58 种食物无营养」）' } : {}),
    comboCount: menuData?.comboCount ?? 0,
    poolTried: 1,
    objective: 'fit',
    objectives: ['kcal-fit', ...priorities, 'price-min'],
    constraints,
    solutions,
    topK: solutions.length,
    ...(searchTruncated ? { searchTruncated: true as const } : {}),
    channelDiagnostics: diagnostics,
    orderContext: orderContextOut(target),
    ...(menuData ? { menuAudit: buildMenuAudit(menuData.items, {
      planCodes: new Set([...comboPlans, ...singlePlans].map((p) => planCodeOf(p.id)).filter(Boolean)),
      selectedCodes: new Set((results[0]?.assignments ?? []).map((a) => planCodeOf(a.planId)).filter(Boolean)),
    }) } : {}),
    disclaimer: '营养与价格数据来自麦当劳官方 MCP、官网营养库与 MILP 优化模型，仅供参考；价格为模型内最优，实际以门店结算为准。',
  };
}

/** 计划 id → 官方商品 code（`mcd-<code>` 套餐 / `mcd-s-<code>` 单品 / `kv-*` 券计划无官方 code） */
function planCodeOf(planId: string): string {
  if (planId.startsWith('mcd-s-')) return planId.slice(6);
  if (planId.startsWith('mcd-')) return planId.slice(4);
  return '';
}

// ---------- 多人拼单仲裁（模块 B，MILP 内核 v6） ----------

/** 输入本地校验（无网络依赖；CLI 在构造 McpClient 前调用） */
export function validateSolveGroupInput(body: SolveGroupInput): void {
  const hasMembers = (body.members ?? []).length > 0 || !!body.pastedText?.trim();
  if (!hasMembers) {
    throw new ServiceError('E_INPUT_INVALID', '至少需要 1 位成员（含心愿或禁忌）；可传 members 数组或 pastedText 粘贴文本');
  }
  if ((body.members ?? []).length > 8) {
    throw new ServiceError('E_INPUT_INVALID', '单次拼单最多支持 8 位成员');
  }
  resolveTargetTimeOrThrow(body.targetTime); // v1.4.9 N01：目标用餐时间格式在入口即报
}

export async function serviceSolveGroup(client: McpClient, body: SolveGroupInput, hooks: ServiceHooks = {}): Promise<GroupSolveOutput> {
  validateSolveGroupInput(body);
  const target = resolveTargetTimeOrThrow(body.targetTime);
  return runWithOrderContext({
    orderType: 1,
    beType: 1,
    ...(target ? { reservationDate: target.reservationDate, period: target.period, targetTime: target.targetTime } : {}),
  }, () => solveGroupImpl(client, body, hooks, target));
}

async function solveGroupImpl(
  client: McpClient,
  body: SolveGroupInput,
  hooks: ServiceHooks,
  target: TargetTime | null,
): Promise<GroupSolveOutput> {
  let storeCode = body.storeCode?.trim();
  let storeName = body.storeName?.trim() ?? '';
  // v1.2：不再静默回退演示门店——无显式门店时按默认城市真实查询，查不到则明确报错
  if (!storeCode) {
    const stores = await findStores(client, body.city?.trim() || CONFIG.defaultCity, CONFIG.defaultKeyword);
    const open = stores.find((s) => s.businessStatus) ?? stores[0];
    if (!open) {
      throw new ServiceError('E_STORE_NOT_FOUND', `「${body.city?.trim() || CONFIG.defaultCity}」未查询到门店，请在面板中先查询并选择门店`, '用面板「查询门店」确认门店后再发起拼单仲裁');
    }
    storeCode = open.storeCode;
    storeName = storeName || open.storeName;
  }

  let members: GroupMember[] = (body.members ?? []).map((m) => ({
    alias: (m.alias ?? '').trim() || `成员${Math.floor(Math.random() * 90 + 10)}`,
    wishes: (m.wishes ?? []).map((w) => w.trim()).filter(Boolean),
    taboos: (m.taboos ?? []).map((t) => t.trim()).filter(Boolean),
    kcalCap: Number(m.kcalCap) > 0 ? Number(m.kcalCap) : undefined,
    sugarFree: !!m.sugarFree,
    notes: Array.isArray(m.notes) ? m.notes.filter((x) => typeof x === 'string' && x.trim()).slice(0, 6) : undefined,
    personalCouponCents: Number(m.personalCouponCents) > 0 ? Math.round(Number(m.personalCouponCents)) : undefined,
  }));
  if (members.length === 0 && body.pastedText?.trim()) {
    const parsed = parseGroupText(body.pastedText);
    if (parsed.needsConfirm) members = parsed.members;
  }
  if (members.length === 0) {
    throw new ServiceError('E_INPUT_INVALID', '至少需要 1 位成员（含心愿或禁忌）；可传 members 数组或 pastedText 粘贴文本');
  }
  if (members.length > 8) {
    throw new ServiceError('E_INPUT_INVALID', '单次拼单最多支持 8 位成员');
  }
  // （前置校验见 validateSolveGroupInput；此处为解析粘贴文本后的最终判定）

  const userVouchers = (Array.isArray(body.userVouchers) ? body.userVouchers : [])
    .filter((v) => v && typeof v === 'object')
    .map(parseUserVoucher);
  if (userVouchers.length > 8) userVouchers.length = 8; // 防异常大包

  // v5 拼单内核（用户拍板默认 milp）；CONFIG.groupKernel='legacy' 回滚旧贪心内核
  if (CONFIG.groupKernel === 'milp') {
    const k = await solveGroupWithKernel(client, { storeCode, storeName, city: body.city, members, userVouchers }, hooks);
    const bundleOut = k.bundle && k.bundle.totals.paidCents < k.solution.totals.paidCents
      ? k.bundle
      : k.bundle ? { ...k.bundle, trackNote: k.bundle.trackNote + '（未优于散点，仅供参考）' } : null;
    return {
      solution: k.solution, bundle: bundleOut, voucherTrack: k.voucherTrack,
      decision: k.decision, unified: k.unified, recommendedIndex: k.recommendedIndex,
      channelDiagnostics: k.channelDiagnostics,
      orderContext: orderContextOut(target),
      ...(k.menuAudit ? { menuAudit: k.menuAudit } : {}),
      ...(k.menuUnavailable ? { menuUnavailable: k.menuUnavailable } : {}),
    };
  }

  // legacy 内核（回滚通道）：与 milp 输出同构（unified 缺省为空数组）
  const { solveGroupOrder, solveBundleTrack } = await import('./group.js');
  const { solveVoucherTrack, decideTrackWinner } = await import('./vouchers.js');
  const solution = await solveGroupOrder(client, { storeCode, storeName, members });
  const menu = await loadMenuItems(client, storeCode, { includeUnmatched: true });
  const bundle = await solveBundleTrack(client, { storeCode, storeName, members }, menu);
  let voucherTrack: VoucherTrackSolution | null = null;
  let decision: ReturnType<typeof decideTrackWinner> = null;
  try {
    voucherTrack = await solveVoucherTrack(client, { storeCode, storeName, members }, menu, {
      userVouchers,
      track2PaidCents: bundle?.totals.paidCents ?? solution.totals.paidCents,
    });
    const officialBest = (bundle && bundle.totals.paidCents < solution.totals.paidCents) ? bundle : solution;
    decision = decideTrackWinner(officialBest, voucherTrack);
  } catch { /* 券轨失败不阻塞官方双轨 */ }
  const bundleOut = bundle && bundle.totals.paidCents < solution.totals.paidCents
    ? bundle
    : bundle ? { ...bundle, trackNote: bundle.trackNote + '（未优于散点，仅供参考）' } : null;
  return {
    solution, bundle: bundleOut, voucherTrack, decision, unified: [], channelDiagnostics: undefined,
    orderContext: orderContextOut(target),
    menuAudit: buildMenuAudit(menu.items, {
      // legacy 内核没有统一 basket：按成员条目 code 近似标注「已入候选/已选中」
      planCodes: new Set(solution.members.flatMap((m) => m.items.map((it) => it.code))),
      selectedCodes: new Set(solution.members.flatMap((m) => m.items.map((it) => it.code))),
    }),
  };
}

// ---------- McDNA 战报（模块 D） ----------

export async function serviceMcdna(client: McpClient | null, input: McdnaInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('E_INPUT_INVALID', '战报输入必须是 JSON 对象');
  if (input.demo !== undefined && typeof input.demo !== 'boolean') throw new ServiceError('E_INPUT_INVALID', 'demo 必须是布尔值');
  if (input.amountMode !== undefined && input.amountMode !== 'tier' && input.amountMode !== 'full') throw new ServiceError('E_INPUT_INVALID', 'amountMode 必须是 tier 或 full');
  if (input.templateId !== undefined && !MCDNA_TEMPLATES.some(t => t.id === input.templateId)) throw new ServiceError('E_INPUT_INVALID', '未知战报模板；当前只有 status（麦门状态栏）');
  try {
    if (input.reportId !== undefined) return await renderMcdnaReport(input.reportId, input);
    if (input.commentary !== undefined) throw new ServiceError('E_INPUT_INVALID', '提交评语须指定当前 reportId，不能对新取的统计盲写');
    const demo = input.demo !== false;
    if (!demo && !client) throw new ServiceError('E_TOKEN_MISSING', '尚未配置自己的麦当劳 MCP 账户，请在面板完成接入');
    const amountMode: AmountMode = input.amountMode ?? CONFIG.mcdnaAmountMode;
    const stats = await fetchMcdnaStats(client, { demo, amountMode });
    return await renderMcdnaReport(createMcdnaSnapshot(stats), { templateId: input.templateId, amountMode });
  } catch (e) {
    if (e instanceof McdnaReportError || e instanceof OrderFormatError) throw new ServiceError(e.code, e.message);
    throw e;
  }
}

// ---------- 粘贴文本解析（确认卡回填；无网络依赖） ----------

export function serviceParseGroup(pastedText: string): {
  members: GroupMember[]; needsConfirm: boolean; note?: string;
} {
  const text = (pastedText ?? '').trim();
  if (!text) throw new ServiceError('E_INPUT_INVALID', '请提供群聊拼单文本 pastedText');
  const parsed = parseGroupText(text);
  if (!parsed.needsConfirm) {
    return {
      members: [], needsConfirm: false,
      note: '未能从文本中识别出任何成员诉求，请切换到快捷表单手动录入成员。',
    };
  }
  return { members: parsed.members, needsConfirm: true };
}

// ---------- doctor：环境自检（CLI 与 SKILL 工作流入口） ----------

export interface DoctorCheck {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** 失败时的修复建议（稳定文案，智能体可直接转述） */
  hint?: string;
}

export interface DoctorReport {
  layout: { mode: string; installRoot: string; seedDataDir: string; userHome: string };
  configErrors: Array<{ field: string; message: string }>;
  configWarnings: Array<{ field: string; message: string }>;
  credentials: { mcdTokenConfigured: boolean; meituanConfigured: boolean; verifiedAt: string | null; source: string };
  /** 能力状态汇总（智能体据此介绍功能，不得自行扩展能力说明） */
  capabilities: {
    programReady: boolean;          // 程序 + 求解器可加载
    panelReady: boolean;            // 面板资源完整、ui 命令可用
    realtimeOrdering: 'ready' | 'unverified' | 'missing-token' | 'unavailable'; // 实时配餐状态
    meituanSource: 'independent' | 'none';  // 美团独立来源
    offlineTools: string[];         // 无 Token 可用功能
    offlineOrdering: false;         // 本轮未实现离线配餐（诚实标注，勿宣传）
  };
  checks: DoctorCheck[];
  ok: boolean; // 无 fail 即 true
}

export async function doctorReport(client: McpClient | null, opts: { live?: boolean } = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const layout = getLayout();
  const { configFile } = userHomePaths(layout);

  // 1. 布局完整性
  checks.push({
    id: 'layout', name: '安装布局',
    status: 'ok',
    detail: `模式=${layout.mode === 'dev' ? '开发仓库' : '发布包'}；程序=${layout.runtimeRoot}；种子数据=${layout.seedDataDir}；数据目录=${layout.userHome}`,
  });

  // 2. 种子数据与快照来源（v1.2：如实列出覆盖门店与快照日期，不夸大覆盖范围）
  const cat = catalogStats();
  const storeDetails = menuStoreDetails();
  const nutritionOk = lookupOfficialNutrition('麦辣鸡腿堡', '') !== null;
  const storeText = storeDetails.length > 0
    ? storeDetails.map((s) => `${s.code}（${s.snapshotAt.slice(0, 10)}，${s.items} 项，${s.source === 'seed' ? '种子' : '本次运行观测'}）`).join('、')
    : '无';
  checks.push({
    id: 'seed-data', name: '静态数据',
    status: nutritionOk ? 'ok' : 'warn',
    detail: nutritionOk
      ? `官网营养表可查（样本通过）；本地快照覆盖 ${cat.menuStores} 家门店：${storeText}；团单 ${cat.deals} 条——快照均为历史观测数据，不是实时菜单，不代表覆盖范围`
      : '官网营养表不可用（种子数据缺失），营养聚合将退化为「营养未知」标注',
    ...(nutritionOk ? {} : { hint: '重新安装发布包（scripts/data 目录不完整）' }),
  });

  // 3. 配置合法性
  const cfgRes = applyUserConfig();
  const cfgStatus = cfgRes.errors.length > 0 ? 'fail' : cfgRes.warnings.length > 0 ? 'warn' : 'ok';
  checks.push({
    id: 'config', name: '配置校验',
    status: cfgStatus,
    detail: cfgRes.fileExists
      ? `已加载 ${configFile}${cfgRes.errors.length ? `；${cfgRes.errors.length} 个错误` : ''}${cfgRes.warnings.length ? `；${cfgRes.warnings.length} 个警告` : ''}`
      : `未发现用户配置（${configFile}），使用内置默认值`,
    ...(cfgRes.errors.length ? { hint: `修正 ${configFile} 中的 tuning 字段（详见 references/setup.md 的配置表）` } : {}),
  });

  // 4. HiGHS WASM 求解器
  let highsStatus: DoctorCheck['status'] = 'ok';
  let highsDetail = '';
  try {
    const { optimize } = await import('./optimizer.js');
    // 微型 LP 冒烟：只验证 HiGHS WASM 能加载并完成一次求解，不关心具体解
    const r = await optimize({
      plans: [{ id: 't1', channel: 'mcd-mcp', name: '测试套餐', basePriceCents: 1000, maxQty: 1, slots: [] }],
      members: [{ alias: 't' }], mode: 'cheapest',
    });
    highsDetail = `HiGHS WASM 微型求解通过（status=${r.status}）`;
  } catch (e) {
    highsStatus = 'fail';
    highsDetail = `求解器加载失败：${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push({
    id: 'solver', name: 'HiGHS 求解器',
    status: highsStatus, detail: highsDetail,
    ...(highsStatus === 'fail' ? { hint: '发布包 runtime/node_modules/highs 缺失或损坏；重新安装发布包' } : {}),
  });

  // 5. 面板资源与启动入口
  const panelHtmlOk = existsSync(panelHtmlPath(layout));
  const cliJsOk = existsSync(join(layout.runtimeRoot, 'cli.js'));
  const serverJsOk = existsSync(join(layout.runtimeRoot, 'server.js'));
  const mcdnaRoot = join(dirname(panelHtmlPath(layout)), 'mcdna');
  const mcdnaFiles = ['engine.mjs', 'panel.js', ...MCDNA_ASSET_FILES.map(f => `assets/${f}`)];
  const mcdnaOk = mcdnaFiles.every(file => existsSync(join(mcdnaRoot, file)));
  const panelOk = panelHtmlOk && cliJsOk && serverJsOk && mcdnaOk;
  checks.push({
    id: 'panel', name: '操作面板',
    status: panelOk ? 'ok' : 'fail',
    detail: panelOk
      ? `面板资源完整（${layout.mode === 'dev' ? 'public/' : 'ui/'}index.html）；启动入口：ui 命令（后台安静启动/复用/--stop 关闭）`
      : `面板资源不完整：index.html=${panelHtmlOk} cli.js=${cliJsOk} server.js=${serverJsOk} mcdna=${mcdnaOk}`,
    ...(panelOk ? {} : { hint: '重新安装发布包（ui/ 目录与 scripts/runtime/dist 必须完整）' }),
  });

  // 6. 麦当劳 Token（配置状态 + 验证记录）
  const cred = readCredentials();
  const tokenSource = process.env.MCD_MCP_TOKEN?.trim() ? 'env' : (cred.mcdMcpToken ? 'config' : 'none');
  const verifiedAt = (cred as { verifiedAt?: string }).verifiedAt ?? null;
  let tokenStatus: DoctorCheck['status'] = 'warn';
  let tokenDetail: string;
  if (!cred.mcdMcpToken) {
    tokenDetail = '未配置：实时菜单/计价不可用。打开面板（ui 命令）完成首次配置——只需一次，跨工作区复用';
  } else if (verifiedAt) {
    tokenStatus = 'ok';
    tokenDetail = `已配置（${tokenSource === 'env' ? '环境变量' : '本地数据目录'}，${maskFree()}）；最近验证通过 ${verifiedAt.slice(0, 19).replace('T', ' ')}`;
  } else {
    tokenDetail = `已配置（${tokenSource === 'env' ? '环境变量' : '本地数据目录'}）但尚未联网验证：可运行 doctor --live 或在面板中点击「验证连接」`;
  }
  checks.push({
    id: 'credentials', name: '麦当劳 MCP Token',
    status: tokenStatus, detail: tokenDetail,
    ...(!cred.mcdMcpToken ? { hint: '运行 ui 打开面板 → 引导页申请并粘贴 Token（只读验证，不读取订单/地址等个人数据）' } : {}),
  });

  // 7. 实时菜单与计价（--live 时真实验证；否则如实标注未验证）
  let realtimeReady = false;
  if (opts.live) {
    if (!cred.mcdMcpToken) {
      checks.push({ id: 'live', name: '实时菜单/计价', status: 'warn', detail: '跳过（未配置 Token）——离线配餐未实现，历史快照不能替代实时菜单' });
    } else {
      try {
        await (client ?? new McpClient(cred.mcdMcpToken, CONFIG.mcdMcpUrl)).call('now-time-info', {});
        realtimeReady = true;
        checks.push({ id: 'live', name: '实时菜单/计价', status: 'ok', detail: '麦当劳 MCP 连接正常（now-time-info 只读探活通过；实时配餐可用）' });
      } catch (e) {        const msg = e instanceof Error ? e.message : String(e);
        const cls = classifyUpstreamError(msg);
        checks.push({ id: 'live', name: '实时菜单/计价', status: 'fail', detail: msg, hint: cls.hint });
      }
    }
  } else {
    checks.push({
      id: 'live', name: '实时菜单/计价',
      status: cred.mcdMcpToken ? 'warn' : 'warn',
      detail: cred.mcdMcpToken ? '已配置但未联网验证（doctor --live 可验证）' : '不可用（未配置 Token）——离线配餐未实现',
    });
  }

  // 8. 美团渠道（独立接入：凭据三级来源 env > config.json > 随包内置）
  const unionResolved = resolveIndependentUnionCredentials();
  const unionSourceText = unionResolved?.source === 'env' ? '环境变量'
    : unionResolved?.source === 'config' ? '本地 config.json'
    : unionResolved?.source === 'bundled' ? '随包内置（来源：公开发布的 meituan-assistant 内置凭据，只读比价/零收益口径）'
    : '无';
  checks.push({
    id: 'channel-meituan', name: '美团联盟（独立接入）',
    status: unionResolved ? 'ok' : 'warn',
    detail: unionResolved
      ? `已配置联盟凭据（来源：${unionSourceText}），使用内置客户端直连联盟网关`
      : '无凭据：实时团单查询不可用（本地团单库/预置知识库参考价兜底，历史参考口径）；普通点餐不受影响',
  });

  // 9. 离线能力清单（诚实边界：离线配餐未实现）
  checks.push({
    id: 'offline', name: '离线能力',
    status: 'ok',
    detail: '无 Token 可用：打开面板与首次配置引导、parse-group 群聊解析、config 配置管理、doctor 自检、version、城市列表、预置券库浏览。'
      + '离线配餐未实现——实时菜单/计价必须配置 Token；历史快照不是实时菜单，模型价不是核价结果。',
  });

  const programReady = checks.find((c) => c.id === 'solver')!.status === 'ok';
  const capabilities: DoctorReport['capabilities'] = {
    programReady,
    panelReady: panelOk,
    realtimeOrdering: !cred.mcdMcpToken ? 'missing-token' : (opts.live ? (realtimeReady ? 'ready' : 'unavailable') : 'unverified'),
    meituanSource: unionResolved ? 'independent' : 'none',
    offlineTools: ['面板与首次配置', 'parse-group', 'config', 'doctor', 'version', '城市列表', '预置券库浏览'],
    offlineOrdering: false,
  };

  return {
    layout: { mode: layout.mode, installRoot: layout.installRoot, seedDataDir: layout.seedDataDir, userHome: layout.userHome },
    configErrors: cfgRes.errors, configWarnings: cfgRes.warnings,
    credentials: { mcdTokenConfigured: !!cred.mcdMcpToken, meituanConfigured: !!unionResolved, verifiedAt, source: tokenSource },
    capabilities,
    checks,
    ok: checks.every((c) => c.status !== 'fail'),
  };
}

function maskFree(): string {
  return '凭据不进日志与报告';
}

// ---------- 稳定错误码 ----------

export class ServiceError extends Error {
  constructor(public code: string, message: string, public hint?: string) {
    super(message);
  }
}

/** 上游错误消息 → 稳定错误码 + 处理建议（智能体据此行动，不需要解析中文报错猜原因） */
export function classifyUpstreamError(msg: string): { code: string; hint: string } {
  if (/连接失败或超时/.test(msg)) return { code: 'E_NETWORK', hint: '检查网络连通性后重试；持续失败可稍后再试或用 doctor --live 排查' };
  if (/限流/.test(msg)) return { code: 'E_RATE_LIMIT', hint: '等待 5–10 秒后重试一次；仍失败则减少调用频次' };
  if (/HTTP 40[13]/.test(msg)) return { code: 'E_TOKEN_INVALID', hint: 'Token 已失效或无权限：按 references/setup.md 重新获取并更新 config.json 的 credentials.mcdMcpToken' };
  if (/HTTP 404/.test(msg)) return { code: 'E_TOKEN_INVALID', hint: 'Token 或会话失效（已自动重试一次仍失败）：重新获取 Token 后更新配置' };
  if (/HTTP 5\d\d/.test(msg)) return { code: 'E_UPSTREAM', hint: '麦当劳官方 MCP 服务端错误，稍后重试' };
  if (/600057|打烊|营业/.test(msg)) return { code: 'E_STORE_CLOSED', hint: '门店非营业时段：结果已按菜单快照降级（价格=最后观测价），或换一家门店' };
  if (/门店/.test(msg) && /不存在|无|匹配/.test(msg)) return { code: 'E_STORE_NOT_FOUND', hint: '用 stores 命令按城市+关键词重新查询并选择门店' };
  return { code: 'E_UPSTREAM', hint: '查看 stderr 日志中的原始错误；必要时运行 doctor 排查环境' };
}

// ---------- 输出契约类型（与 server.ts HTTP 响应字段一一对应；详细字段说明见 references/contracts.md） ----------

/** 逐份配置中的单个槽位选择（前端按 units[].config 展示「每份怎么配」）。 */
export interface UnitConfigEntry {
  roundId?: string;
  roundName: string;
  chosenCode?: string;
  chosenName: string;
  /** v1.4.10 W11：该选项的规格（大/中/小/2块…）；购买清单与复制文本必须显示 */
  specLabel?: string;
  /** 营养值来源说明；只在补录/可追溯来源存在时提供 */
  nutritionSource?: string;
  /** 估算营养仅供参考；不支持严格达标结论 */
  nutritionEstimated?: boolean;
  /** 未知营养字段；占位值不构成完整营养资料 */
  nutritionUnknownFields?: string[];
  /** v1.4.7 R02：非食品（玩具/餐具）——不计入「吃什么」签名与营养聚合 */
  nonFood?: boolean;
}

/** 同一套餐内「配置完全相同」的购买单元合并后的结果（R06 对外契约）。 */
export interface ItemUnit {
  /** 相同配置的份数 */
  qty: number;
  /** 该配置单份热量 kcal */
  kcal: number;
  /** 该配置单份实付（含槽位差价），单位分 */
  priceCents: number;
  config: UnitConfigEntry[];
}

export type SingleSolveOutput = {
  store: { storeCode: string; storeName: string };
  feasible: boolean;
  reason: string;
  scanned: number;
  unmatched: number;
  /** v1.2：官方菜单渠道状态（实时/快照/不可用），与美团渠道独立 */
  officialMenu?: { status: 'realtime' | 'snapshot' | 'unavailable'; snapshotAt?: string; note?: string; reason?: string };
  menuFromSnapshotAt?: string;
  menuSnapshotNote?: string;
  unmatchedNote?: string;
  comboCount: number;
  poolTried: number;
  objective: string;
  objectives: string[];
  constraints: MetricConstraint[];
  solutions: Array<{
    items: Array<{
      code: string; name: string; qty: number; price: number; kcal: number; protein: number | null;
      /** v1.4.7 R09：行价（分，= 份数×底价 + 各槽位差价）——总额按行价求和，不用舍入单价重建 */
      subtotalCents: number;
      /** v1.4.7 R09：逐份热量精确合计（kcal 为单份参考值） */
      kcalTotal: number;
      category: string; fastCarb: number; isVeggie: boolean; isStaple: boolean; isCombo: boolean;
      /** v1.4.7 R08：渠道（meituan=团购券 / official=官方 App·小程序）——展示不得依赖标题推断 */
      channel: 'meituan' | 'official';
      channelLabel: string;
      nutritionComplete: boolean; nutritionEstimated?: boolean; nutritionUnknownFields?: string[]; stapleCount: number;
      /** 补录/菜单营养来源（为空表示没有额外补录来源说明） */
      nutritionSources?: string[];
      /** R06：真实逐份配置（相同配置合并数量、不同配置分行）；缺省时前端回退到 deconstruction */
      units?: ItemUnit[];
      deconstruction: Array<{ roundName: string; roundId?: string; defaultName: string; chosenCode?: string; options: Array<{ name: string; diffCents: number }>; category: string }>;
    }>;
    singleFallback: boolean;
    metrics: {
      kcal: number; price: number; protein: number; fat: number; carb: number; carbohydrate: number;
      sodium: number; fastCarb: number; veggie: number; staple: number; nutritionPartial?: true; nutritionKcalPartial?: true; nutritionEstimated?: true; nutritionUnknownFields?: string[];
    };
    menuPriceCents: number; finalPriceCents: number; discountCents: number;
    priceSource: string; priceNote: string; memberKcal: number; solveState: string;
    /** v1.4.11 W01：整篮购买热量 / 本人实际分配摄入 / 未分配剩余（费用按整篮支付）。
     *  硬上限只对 memberKcal 成立；metrics.kcal 仍是整篮合计。 */
    intake: {
      purchasedKcal: number; memberKcal: number; leftoverKcal: number; complete: boolean;
      /** 本人实际分配的宏量（钠/蛋白等硬上限按此口径判定，而非整篮合计） */
      macros: { protein: number; fat: number; carbohydrate: number; sodium: number };
      leftovers?: Array<{ itemName: string; qty: number; kcal: number; refPriceCents: number }>;
    };
    slotChoices: unknown[];
    coverage: { total: number; met: number };
    gapTotal: number;
    /** v1.2：推荐理由（热量贴合/优先级/价格各阶段的求解决策链，用户可读） */
    reasonNotes?: string[];
    leftovers?: Array<{ planId: string; planName: string; itemName: string; qty: number; refPriceCents: number; kcal: number }>;
  }>;
  topK: number;
  /** v1.4.7 R11：备选搜索达到预算上限（可能还有未展示的组合） */
  searchTruncated?: true;
  channelDiagnostics: unknown;
  /** v1.4.9 N01：本轮下单上下文（即时 / 预约到某时刻），供页面与 CLI 如实回显口径 */
  orderContext?: OrderContextEcho;
  /** v1.4.9 N01：逐商品遗漏账（官方返回 → 结构 → 营养 → 候选 → 选中） */
  menuAudit?: MenuAuditRow[];
  disclaimer: string;
};

/** N01：下单上下文回显（不参与计算，只描述本轮按什么时间口径查询） */
export interface OrderContextEcho {
  mode: 'immediate' | 'scheduled';
  targetTime?: string;
  reservationDate?: string;
  period?: 'breakfast' | 'regular';
  periodLabel?: string;
  note: string;
}

export type GroupSolveOutput = {
  /** milp 内核（默认）为 KernelGroupSolution；legacy 回滚内核为 GroupSolution */
  solution: KernelGroupSolution | GroupSolution;
  bundle: KernelGroupSolution | GroupSolution | null;
  voucherTrack: VoucherTrackSolution | null;
  decision: Awaited<ReturnType<typeof solveGroupWithKernel>>['decision'];
  unified: KernelGroupSolution[];
  /** v1.4.6 R16：唯一推荐方案在 unified 中的下标（与 decision 同源，页面/CLI/分账共用） */
  recommendedIndex?: number;
  channelDiagnostics?: Awaited<ReturnType<typeof solveGroupWithKernel>>['channelDiagnostics'];
  /** v1.2：官方菜单不可用（实时失败且无快照）——solution 为需求回执，美团查询结果保留在 channelDiagnostics */
  menuUnavailable?: { reason: string };
  /** v1.4.9 N01：本轮下单上下文（即时 / 预约到某时刻） */
  orderContext?: OrderContextEcho;
  /** v1.4.9 N01：逐商品遗漏账（官方返回 → 结构 → 营养 → 候选 → 选中） */
  menuAudit?: MenuAuditRow[];
};
