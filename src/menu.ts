// 菜单加载与营养联结
import type { McpClient } from './mcp.js';
import { matchNutrition, normalizeName, parseNutritionTable, type NutritionRow } from './nutrition.js';
import { resolveComponentNutrition } from './nutritionSupplements.js';
import { upsertMenuSnapshot, menuSnapshot, upsertNutritionRows, nutritionRowsSnapshot } from './catalog.js';
import { CONFIG } from './config.js';
import { periodOfDate, parseReservationDate, type MealPeriod } from './mealPeriod.js';
import { reservationDateOf, withOrderParams } from './orderContext.js';

export interface MenuItem {
  code: string;
  name: string;
  priceCents: number; // 计价单位：分
  originalPriceCents: number;
  category: string;
  tags: string[];
  kcal: number;
  protein: number;
  fat: number;
  carbohydrate: number;
  sodium: number;
  isCombo: boolean; // 是否为套餐（三件套/四件套/随心选等，营养由 rounds 默认项聚合）
  /** 启发式派生指标（无官方数据，按品名/类目推断，UI 需标注为估计值） */
  fastCarb: number; // 快碳 g：含糖饮料/甜品/薯类 的碳水计入
  isVeggie: boolean; // 是否计入蔬菜份（蔬菜/沙拉/玉米/苹果片）
  isStaple: boolean; // 是否为主食载体（堡/麦满分/卷/粥等）
  nutritionMatched: boolean;
  /** 营养来源说明（官网 / MCP / 用户补录；用于用户审计） */
  nutritionSource?: string;
  /** v1.4.4 R04：营养值来自估算/区间（用户补录层的估算记录）——仅作参照，不支持严格达标结论 */
  nutritionEstimated?: boolean;
  /** v1.4.4 R04：补录未覆盖的营养字段（这些字段的 0 是占位，不得按 0 参与上限/达标判断） */
  nutritionUnknownFields?: string[];
  /** 规格型 SKU（可乐/薯条等单 SKU 多营养规格）按「中杯/中份」默认规格联结营养时的标注（v0.4） */
  assumedSpec?: string;
  /** 套餐解构（v3 核心）：轮次 → 可选范围/默认项/差价；「按规则随意搭配」与 staple 精确计数的数据基础 */
  deconstruction?: RoundSpec[];
  /** 解构精确计数：默认项中主食份数（修复整包只算 1 份的口径错误） */
  stapleCount?: number;
  veggieCount?: number;
  /** 目录观测时间（自本地目录快照加载时附加；实时路径无此字段）——历史目录与当前可买区分依据 */
  lastSeen?: string;
  firstSeen?: string;
  /** v1.4.8 R02/R08：套餐结构未取得（详情失败/无轮次）。此类条目**不得**当作已知单品，
   *  也不得被当作「心愿已覆盖」的证据；仅作为可购买候选展示（营养未知）。 */
  structureUnknown?: boolean;
  /** 结构未取得的原因（审计用） */
  structureIssue?: string;
  /** v1.4.10 W02：规格型单品的官方规格轮次（父 SKU + 选项 code/补差/默认项）。
   *  实测 9900008751 可乐：默认小杯（3000），中杯 +0.5（3050）、大杯 +2.5（3100）。
   *  有此证据时规格心愿按真实补差入模与核价；无证据不得用营养表默认规格冒充售价。 */
  specRounds?: SpecRound[];
}

/** 规格轮次（query-meal-detail 对单品父 SKU 返回的 rounds） */
export interface SpecRound {
  roundId: string;
  roundName: string;
  options: Array<{ code: string; name: string; diffCents: number; isDefault: boolean }>;
}

/** 套餐解构的统一子品项描述：一轮 = 一个可选位（多选一），options 为可随意搭配的范围。
 *  v5（评审#5）：贯通 roundId 与选项 code——calculate-price roundList 精确还原的数据基础，
 *  此前解构丢失两者导致「同套餐两份不同搭配无法还原购物篮」。 */
export interface RoundSpec {
  roundName: string;
  roundId?: string;
  category: 'staple' | 'side' | 'drink' | 'dessert' | 'unknown';
  defaultName: string;
  options: Array<{ name: string; diffCents: number; code?: string }>; // diffCents 相对套餐底价的换选差价（分）
}

function parseDiffPriceCents(raw: string | undefined): number {
  if (!raw) return 0;
  const m = raw.replace(/\s/g, '').match(/([+-])¥?(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const cents = Math.round(parseFloat(m[2]) * 100);
  return m[1] === '-' ? -cents : cents;
}

/** 从 query-meal-detail 的 rounds 构造套餐解构（menu 与拼单层共用）。
 *  v5：透传轮次 id 与选项 code（roundList 还原必需），不再静默丢弃。 */
export function buildRoundSpecs(roundsRaw: Array<{ id?: number | string; name?: string; choices?: Array<{ code?: string; name?: string; isDefault?: number; diffPrice?: string }> }>): RoundSpec[] {
return roundsRaw.map((r) => {
  const choices = (r.choices ?? []).filter((x): x is { code?: string; name?: string; isDefault?: number; diffPrice?: string } => !!x && !!x.name);
  const def = choices.find((x) => x.isDefault === 1) ?? choices[0];
  const roundName = r.name ?? def?.name ?? '';
  let category: RoundSpec['category'] = 'unknown';
  if (def?.name) {
    if (RE_STAPLE.test(def.name) && !/薯/.test(def.name)) category = 'staple';
    else if (/可乐|雪碧|果汁|冰茶|咖啡|奶铁|纯悦|牛奶/.test(def.name)) category = 'drink';
    else if (/新地|旋风|圆筒|冰淇淋/.test(def.name)) category = 'dessert';
    else if (/薯条|鸡翅|鸡排|麦乐鸡|玉米杯|沙拉|苹果片|派/.test(def.name)) category = 'side';
  }
  if (category === 'unknown') {
    if (/主食/.test(roundName)) category = 'staple';
    else if (/饮料|饮品|咖啡/.test(roundName)) category = 'drink';
    else if (/小食|配/.test(roundName)) category = 'side';
  }
  return {
    roundName,
    ...(r.id != null && r.id !== '' ? { roundId: String(r.id) } : {}),
    category,
    defaultName: def?.name ?? '',
    options: choices.map((x) => ({ name: x.name!, diffCents: parseDiffPriceCents(x.diffPrice), ...(x.code ? { code: String(x.code) } : {}) })),
  };
}).filter((r) => r.options.length > 0);
}

// 套餐识别：既看标签，也看品名（实测「三件套/四件套/随心选/双拼」等常不带套餐标签）。
// v1.4.8 R02：补上「套餐／组合」。早餐菜单里 25 项名称含「套餐/组合」的商品此前全被判成单品，
//   其中「原味板烧鸡腿麦满分组合」（9900003493，10.8 元）只按主食 246 kcal 计量，
//   还让「板烧鸡腿麦满分套餐」心愿显示「已覆盖」——用主食热量冒充整套餐是明确的数据错误。
const RE_COMBO_NAME = /件套|双拼|四宫格|分享餐|双人餐|单人餐|全家桶|豪华桶|随心选|随心拼|桶$|套餐|组合/;
// 标签侧的「二件套/三件套/四件套」是官方分类里最强的套餐证据（同一 code 在不同分类下标签不同，
// 见 R02 的 DUPLICATE-METADATA 证据：首次出现的「6折起早餐卡专区」无标签，第二次「麦满分系列」带「二件套」）。
const RE_COMBO_TAG = /套餐|多人餐|亲子餐|开心乐园餐|件套|组合/;
const isCombo = (name: string, tags: string[]): boolean =>
  tags.some((t) => RE_COMBO_TAG.test(t)) || RE_COMBO_NAME.test(name);

/** v1.4.9 N01：套餐判定对分时段目录开放（同一判定，不在两处维护）。 */
export const isComboMenuItem = (name: string, tags: string[]): boolean => isCombo(name, tags);

/** 名称本身即声明「这是套餐结构」——详情取不到轮次时不得退回单品口径（R02）。 */
const RE_COMBO_DECLARED = /件套|套餐|组合|随心配|随心选|随心拼|双拼|分享餐|双人餐|全家桶|四宫格/;

const RE_SUGARY_DRINK = /可乐|雪碧|果汁|柠檬红茶|冰茶|奶铁|奶茶|奶冻|爆珠|雪冰|怡泉|美汁源|麦旋酷/;
const RE_ZERO_SUGAR = /无糖|零度|零卡/;
const RE_DESSERT = /新地|旋风|雪冰|冰淇淋|圆筒|派|拉明顿|阿芙佳朵|果酱|奶冻款|爆珠款/;
const RE_POTATO = /薯条|薯饼|脆薯|脆薯饼/;
const RE_NONFOOD = /玩具|餐具|奖品/; // 评审三轮 #2：非食品不进单品池与营养覆盖统计
export const RE_STAPLE = /堡|麦满分|营养卷|粥|松饼|油条|贝果|可颂|吉士蛋|巨无霸|麦香鸡|麦香鱼|板烧|安格斯|鳕鱼/;
export const RE_VEGGIE = /蔬菜|沙拉|玉米|苹果片|生菜/;

// 快碳口径：含糖饮料 + 甜品（添加糖/精制碳水）。薯类按慢碳处理，不计入快碳。
function derive(name: string, category: string, carb: number): { fastCarb: number; isVeggie: boolean; isStaple: boolean } {
  const isDrink = /饮品|麦咖啡/.test(category) || RE_SUGARY_DRINK.test(name);
  const sugaryDrink = isDrink && carb >= 5 && !RE_ZERO_SUGAR.test(name);
  const isDessert = RE_DESSERT.test(name);
  const fastCarb = sugaryDrink || isDessert ? carb : 0;
  const isVeggie = RE_VEGGIE.test(name);
  const isStaple = RE_STAPLE.test(name) && !RE_POTATO.test(name);
  return { fastCarb, isVeggie, isStaple };
}

/** 并发受限的批量映射（避免套餐详情批量请求打爆上游） */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface StoreInfo {
  storeCode: string;
  storeName: string;
  address: string;
  distance?: number;
  businessStatus?: boolean;
}

/** 官方 query-meals 的原始分类/商品表 → 按 code 聚合的条目（v1.4.9 N01 抽出复用）。
 *  v1.4.8 R02 的聚合语义在这里唯一维护：同一 code 出现在多个分类下时，
 *  **分类与标签全量合并**后再判定是否为套餐——不能只看第一次出现的证据。 */
export interface MenuEntry {
  code: string;
  name: string;
  currentPrice: string;
  originalPrice?: string;
  categories: string[];
  tags: string[];
}

export function collectMenuEntries(data: {
  categories?: Array<{ name: string; meals: Array<{ code: string; tags?: string[] }> }>;
  meals?: Record<string, { name: string; currentPrice: string; originalPrice?: string }>;
}): Map<string, MenuEntry> {
  const entries = new Map<string, MenuEntry>();
  for (const cat of data.categories ?? []) {
    const catName = cat.name.replace(/\n/g, '');
    for (const meal of cat.meals ?? []) {
      const detail = data.meals?.[meal.code];
      if (!detail?.name || !detail?.currentPrice) continue;
      const prev = entries.get(meal.code);
      if (prev) {
        if (!prev.categories.includes(catName)) prev.categories.push(catName);
        for (const t of meal.tags ?? []) if (!prev.tags.includes(t)) prev.tags.push(t);
      } else {
        entries.set(meal.code, {
          code: meal.code,
          name: detail.name,
          currentPrice: detail.currentPrice,
          ...(detail.originalPrice ? { originalPrice: detail.originalPrice } : {}),
          categories: [catName],
          tags: [...(meal.tags ?? [])],
        });
      }
    }
  }
  return entries;
}

export interface MenuLoadResult {
  items: MenuItem[];
  unmatched: number;
  comboCount: number;
  comboUnmatched: number;
  /** 官方营养表（按规格分行：可乐中杯 147 / 大杯 224 kcal 等），供规格感知计算（v0.4） */
  table: ReturnType<typeof import('./nutrition.js').parseNutritionTable>;
  /** 评审四轮：数据源未返回实时菜单（打烊/非营业时段）时，本结果来自本地菜单快照（ISO 时间） */
  fromSnapshotAt?: string;
  /** v1.2：快照「当前可购池」口径说明（观测时效 + 餐段过滤明细；参考价=最后观测价） */
  snapshotPoolNote?: string;
  /** v1.4.8 R02：识别为套餐但结构未取得的品项及原因（逐项可审计，不静默丢弃） */
  structureIssues?: string[];
  /** v1.4.8 R10：套餐详情抓取被条数上限截断时的如实记录（不宣称比较了全量） */
  comboCapped?: { limit: number; excluded: number; names: string[] };
}

// 缓存 TTL 与抓取上限改为可调配置（config.ts 注入；未配置时用默认值）
const cacheTtlMs = (): number => CONFIG.menuCacheTtlMin * 60 * 1000;
const comboCacheTtlMs = (): number => CONFIG.comboCacheTtlMin * 60 * 1000; // 套餐构成变化极少，单独长缓存
// v1.4.8 R10：`comboMaxPriceCents` 不再作为目录层过滤条件。
//   旧实现按 ¥70 上限静默丢弃官方已返回的商品（实测「堡堡随心拼（7件任选）」¥73 直接不加载、不查详情），
//   那是程序性能取舍，不是官方停售条件。现在目录保留完整商品，只保留条数上限（comboFetchLimit），
//   截断数量与品名在 MenuLoadResult.comboCapped 中如实透出。配置项保留以兼容既有调优文件。
const comboFetchLimit = (): number => CONFIG.comboFetchLimit;
const menuCache = new Map<string, { at: number; result: MenuLoadResult }>();
// v1.2：失败结果短缓存（2 分钟）——瞬时上游故障不再毒化套餐池整小时
const COMBO_FAIL_TTL_MS = 2 * 60 * 1000;
/** v1.4.8 R08：status 明确区分「详情成功」与「失败/降级」，不再以 item 非空判断成功 */
const comboCache = new Map<string, { at: number; item: MenuItem | null; status: 'ok' | 'failed' }>();
/** v1.4.10 W02：规格轮次缓存（与套餐详情同 TTL；失败短重试） */
const specRoundCache = new Map<string, { at: number; rounds: SpecRound[] | null }>();
/** 需要探测规格轮次的单品名（单 SKU 多规格的常见品类） */
const RE_SPEC_CAPABLE = /可乐|雪碧|芬达|薯条|咖啡|拿铁|美式|红茶|果汁|牛奶|纯悦|豆浆|冰茶|奶铁/;

export interface MenuLoadOptions {
  includeUnmatched?: boolean;
  /** v1.4.9 N01：目标用餐时间对应的官方 reservationDate（`yyyy-MM-dd HH:mm`）；即时口径不传 */
  reservationDate?: string;
  /** v1.4.9 N01：该时间所属餐段（写入快照的观测餐段，避免按「现在」误判） */
  mealPeriod?: MealPeriod;
}

/** 当前生效的预约时间：显式传入优先，其次取请求上下文（N01 统一口径）。 */
const effectiveReservationDate = (opts: MenuLoadOptions): string | undefined =>
  opts.reservationDate ?? reservationDateOf();

/** 拉取门店菜单：单品与营养表直接联结；套餐按 rounds 默认项聚合营养。
 *  includeUnmatched=true（拼单场景）：保留营养未联结的单品（kcal=0, nutritionMatched=false）——
 *  拼单是「点得起」不是「算得准」，可乐等营养表未收录品项必须可被匹配；缓存键独立避免串档。
 *  v1.4.9 N01：reservationDate 贯通 query-meals 与 query-meal-detail，并按它隔离缓存
 *  （不同用餐时间的菜单/价格/可售范围不同，共用一个键会把 12:00 的池子当成 08:00 的）。 */
async function loadMenuItemsFresh(client: McpClient, storeCode: string, opts: MenuLoadOptions = {}): Promise<MenuLoadResult> {
  const rd = effectiveReservationDate(opts);
  const cacheKey = `${storeCode}:${rd ?? 'now'}${opts.includeUnmatched ? ':full' : ''}`;
  const cached = menuCache.get(cacheKey);
  if (cached && Date.now() - cached.at < cacheTtlMs()) return cached.result;

  const menuRes = await client.call('query-meals', { storeCode, orderType: 1, beType: 1, ...(rd ? { reservationDate: rd } : {}) });
  // 评审三轮验证发现：深夜数据源对打烊门店返回 code 600057（无菜单）——给出可理解的提示而非「结构异常」
  // （code/message 位于响应顶层而非 data 内；client.call 对 success:false 不抛错，仅透传）
  const menuErr = menuRes as { code?: number; message?: string };
  if (menuErr?.code === 600057 || /营业/.test(menuErr?.message ?? '')) {
    throw new Error(rd
      ? `门店在 ${rd} 不在营业时间（数据源未返回菜单），请换一个用餐时间或更换 24h 门店。`
      : '门店当前不在营业时间（数据源未返回菜单），请稍后重试或更换 24h 门店。');
  }
  const data = menuRes.data as {
    categories?: Array<{ name: string; meals: Array<{ code: string; tags?: string[] }> }>;
    meals?: Record<string, { name: string; currentPrice: string; originalPrice?: string }>;
  };
  if (!data?.categories || !data?.meals) throw new Error('菜单数据结构异常');

  const nutriRes = await client.call('list-nutrition-foods', {});
  const table = parseNutritionTable(nutriRes.rawText);
  upsertNutritionRows([...table.values()]);

  const items: MenuItem[] = [];
  const combos: Array<{ code: string; name: string; category: string; tags: string[]; priceCents: number; originalPriceCents: number }> = [];
  const comboCapped: string[] = [];
  const codeToNutrition = new Map<string, MenuItem>();
  const structureIssues: string[] = [];
  let unmatched = 0;

  const entries = collectMenuEntries(data);

  for (const entry of entries.values()) {
    const detail = { name: entry.name, currentPrice: entry.currentPrice, originalPrice: entry.originalPrice };
    const meal = { code: entry.code, tags: entry.tags };
    const cat = { name: entry.categories[0] ?? '' };
    {
      if (RE_NONFOOD.test(detail.name)) continue; // 玩具/餐具等非食品：不进单品池、不计入营养覆盖统计
      const tags = meal.tags ?? [];
      const priceCents = Math.round(parseFloat(detail.currentPrice) * 100);
      const base = {
        code: meal.code,
        name: detail.name,
        priceCents,
        originalPriceCents: Math.round(parseFloat(detail.originalPrice ?? detail.currentPrice) * 100),
        category: cat.name.replace(/\n/g, ''),
        tags,
      };
      if (isCombo(detail.name, tags)) {
        // 套餐：营养需聚合 rounds（v1.4.8 R10：价格上限不再在目录层静默丢弃官方已返回的商品，
        // 只保留条数上限作为性能边界，并在结果中如实记录截断）
        if (combos.length < comboFetchLimit()) combos.push(base);
        else comboCapped.push(detail.name);
        continue;
      }
      const row0 = matchNutrition(detail.name, table);
      let row = row0;
      let assumedSpec: string | undefined;
      let nutritionSource = row0 ? '麦当劳官方 MCP 营养表' : undefined;
      // v1.4.4 R04：补录层营养的数值性质（估算值仅作参照；未覆盖字段按未知处理）
      let nutritionEstimated = false;
      let nutritionUnknownFields: string[] = [];
      // 规格型 SKU（可乐/薯条/雪碧等单 SKU 多营养规格）：官方营养表按「可乐中杯/大杯/小杯」分行。
      // 联结失败时若存在多个规格行，按「中杯/中份」默认规格联结（到店自取单 SKU 的常规默认装），
      // 并标注 assumedSpec 供 UI 与拼单规格覆盖使用（v0.4）。
      if (!row) {
        const nk = normalizeName(detail.name);
        if (nk.length >= 2) {
          const specRows = [...table.values()].filter((r) => {
            const rn = normalizeName(r.productName);
            return rn.includes(nk) || (nk.includes('可乐') && rn.includes('可乐'));
          });
          const uniq = new Set(specRows.map((r) => normalizeName(r.productName)));
          if (uniq.size >= 2) {
            const mid = specRows.find((r) => /中杯|中份/.test(r.productName));
            if (mid) {
              row = mid;
              assumedSpec = (mid.productName.match(/中杯|中份/) ?? ['中杯'])[0];
              nutritionSource = '麦当劳官方 MCP 营养表（默认规格：中）';
            }
          }
        }
      }
      if (!row) {
        // 评审二轮 #9：官网库/补录层营养（含默认规格收敛），大幅缩小「未联结」集合
        const off = resolveComponentNutrition(detail.name);
        if (off.matched) {
          row = {
            productName: off.sourceKind === 'supplement' ? `${detail.name}(补录)` : `${detail.name}(${off.specTitle ?? '默认'})`,
            energyKj: off.kcal, energyKcal: off.kcal,
            protein: off.protein, fat: off.fat, carbohydrate: off.carbohydrate, sodium: off.sodium, calcium: 0,
          };
          if (off.specTitle && !['1个', '默认', '1份'].includes(off.specTitle)) assumedSpec = off.specTitle;
          nutritionSource = off.sourceLabel;
          // v1.4.4 R04：估算值与未覆盖字段如实透出（估算值仅作参照，不支持严格达标结论）
          nutritionEstimated = off.valueKind === 'estimate';
          nutritionUnknownFields = [...off.unknownFields];
        }
      }
      if (!row) {
        if (opts.includeUnmatched) {
          const d0 = derive(detail.name, base.category, 0);
          items.push({ ...base, kcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0,
            fastCarb: d0.fastCarb, isVeggie: d0.isVeggie, isStaple: d0.isStaple,
            isCombo: false, nutritionMatched: false });
        } else unmatched++;
        continue;
      }
      const d = derive(detail.name, base.category, row.carbohydrate);
      const item: MenuItem = {
        ...base,
        kcal: row.energyKcal,
        protein: row.protein,
        fat: row.fat,
        carbohydrate: row.carbohydrate,
        sodium: row.sodium,
        fastCarb: d.fastCarb,
        isVeggie: d.isVeggie,
        isStaple: d.isStaple,
        isCombo: false,
        nutritionMatched: true,
        ...(nutritionSource ? { nutritionSource } : {}),
        ...(assumedSpec ? { assumedSpec } : {}),
        ...(nutritionEstimated ? { nutritionEstimated: true } : {}),
        ...(nutritionUnknownFields.length ? { nutritionUnknownFields } : {}),
      };
      items.push(item);
      codeToNutrition.set(meal.code, item);
    }
  }

  // ---- v1.4.10 W02：规格型单品（可乐/薯条/咖啡等单 SKU 多规格）的真实规格轮次 ----
  //   只对名称命中常见规格品类、且营养已联结的单品探测；失败不阻塞菜单（无证据时规格价格标未知）。
  const specCandidates = items.filter((it) => !it.isCombo && it.priceCents > 0 && RE_SPEC_CAPABLE.test(it.name));
  if (specCandidates.length > 0) {
    await mapWithConcurrency(specCandidates, 8, async (it) => {
      const ck = `spec:${storeCode}:${it.code}${rd ? `@${rd}` : ''}`;
      const hit = specRoundCache.get(ck);
      const ttl = hit?.rounds ? comboCacheTtlMs() : COMBO_FAIL_TTL_MS;
      if (hit && Date.now() - hit.at < ttl) { if (hit.rounds) it.specRounds = hit.rounds; return; }
      let rounds: SpecRound[] | null = null;
      try {
        const res = await client.call('query-meal-detail', { storeCode, orderType: 1, beType: 1, code: it.code, ...(rd ? { reservationDate: rd } : {}) });
        const raw = (res.data as { rounds?: Array<{ id?: number | string; name?: string; choices?: Array<{ code?: string; name?: string; isDefault?: number; diffPrice?: string }> }> })?.rounds ?? [];
        const built: SpecRound[] = raw
          .filter((r) => (r.choices?.length ?? 0) > 0)
          .map((r) => ({
            roundId: String(r.id ?? ''),
            roundName: r.name ?? '',
            options: (r.choices ?? [])
              .filter((c): c is { code?: string; name?: string; isDefault?: number; diffPrice?: string } => !!c && !!c.name)
              .map((c) => ({ code: String(c.code ?? ''), name: c.name!, diffCents: parseDiffPriceCents(c.diffPrice), isDefault: c.isDefault === 1 })),
          }))
          .filter((r) => r.roundId && r.options.length > 0);
        // 只有 ≥2 个可选规格才构成「规格轮次」；单选项不是规格证据
        if (built.some((r) => r.options.length >= 2)) rounds = built;
      } catch { rounds = null; }
      specRoundCache.set(ck, { at: Date.now(), rounds });
      if (rounds) it.specRounds = rounds;
    });
  }

  // ---- 套餐营养聚合（并发 6，长缓存）----
  // 缓存键区分 includeUnmatched：精算模式失败缓存 null、拼单模式失败缓存降级条目，
  // 共用键会让先精算后拼单的进程拿到 null（套餐又"匹配不到"），反之会让 kcal=0 的降级
  // 条目污染精算求解池（menuCache 已用 :full 后缀，此处曾遗漏）
  const comboKey = (code: string) => `${storeCode}:${code}${opts.includeUnmatched ? ':full' : ''}${rd ? `@${rd}` : ''}`;
  let comboUnmatched = 0;
  const comboItems = await mapWithConcurrency(combos, 10, async (c) => {
    const ck = comboKey(c.code);
    const hit = comboCache.get(ck);
    // v1.4.8 R08：成功与失败/降级分开计时。旧实现以「条目非空」判断成功，
    //   于是 includeUnmatched 下的降级条目（无轮次、kcal=0）被当成成功缓存 60 分钟，
    //   上游恢复后 16 分钟重新加载仍不会重试（评审已复现）。
    if (hit && Date.now() - hit.at < (hit.status === 'ok' ? comboCacheTtlMs() : COMBO_FAIL_TTL_MS)) return hit.item;
    let built: MenuItem | null = null;
    let status: 'ok' | 'failed' = 'failed';
    try {
      const res = await client.call('query-meal-detail', { storeCode, orderType: 1, beType: 1, code: c.code, ...(rd ? { reservationDate: rd } : {}) });
      const roundsRaw = (res.data as { rounds?: Array<{ name?: string; choices?: Array<{ code?: string; name?: string; isDefault?: number; diffPrice?: string }> }> })?.rounds ?? [];
      const rounds = roundsRaw;
      // 套餐解构（v3 核心）：每个套餐 → 统一子品项描述（轮次/可选范围/默认项/差价），
      // 是「按规则随意搭配」与 staple/veggie 精确计数的数据基础
      const deconstruction = buildRoundSpecs(roundsRaw);
      const picks = rounds
        .map((r) => {
          const ch = r.choices ?? [];
          return ch.find((x) => x.isDefault === 1) ?? ch[0];
        })
        .filter((x): x is { code?: string; name?: string } => !!x);
      if (picks.length === 0) throw new Error('套餐详情未返回可用轮次（无默认选项）');
      if (deconstruction.length === 0) throw new Error('套餐详情轮次无可用选项（无法建模）');
      let kcal = 0, protein = 0, fat = 0, carb = 0, sodium = 0, fastCarb = 0;
      let isVeggie = false, isStaple = false;
      let componentUnknown = false; // 评审二轮 #9：缺失组件不再整包丢弃，如实标注
      for (const p of picks) {
        const byCode = p.code ? codeToNutrition.get(p.code) : undefined;
        let comp: { kcal: number; protein: number; fat: number; carb: number; sodium: number; fastCarb: number; isVeggie: boolean; isStaple: boolean } | null = null;
        if (byCode) {
          comp = {
            kcal: byCode.kcal, protein: byCode.protein, fat: byCode.fat,
            carb: byCode.carbohydrate, sodium: byCode.sodium,
            fastCarb: byCode.fastCarb, isVeggie: byCode.isVeggie, isStaple: byCode.isStaple,
          };
        } else {
          let row = p.name ? matchNutrition(p.name, table) : undefined;
          if (!row) {
            // 统一营养解析链：官网权威库 → 用户补录层 → 未知
            const off = p.name ? resolveComponentNutrition(p.name) : null;
            // v1.4.4 R04：补录未覆盖字段时不得把 0 当作真实值聚合（缺失 ≠ 0）——按组件未知处理
            if (off?.matched && off.unknownFields.length === 0) row = {
              productName: off.sourceKind === 'supplement' ? `${p.name}(补录)` : `${p.name}(${off.specTitle ?? '默认'})`,
              energyKj: off.kcal, energyKcal: off.kcal,
              protein: off.protein, fat: off.fat, carbohydrate: off.carbohydrate, sodium: off.sodium, calcium: 0,
            };
          }
          if (!row) { componentUnknown = true; continue; } // 继续检查其他组件，不因单个组件缺失丢整包
          const dd = derive(p.name ?? '', '', row.carbohydrate);
          comp = {
            kcal: row.energyKcal, protein: row.protein, fat: row.fat,
            carb: row.carbohydrate, sodium: row.sodium,
            fastCarb: dd.fastCarb, isVeggie: dd.isVeggie, isStaple: dd.isStaple,
          };
        }
        kcal += comp.kcal; protein += comp.protein; fat += comp.fat; carb += comp.carb; sodium += comp.sodium;
        fastCarb += comp.fastCarb; isVeggie = isVeggie || comp.isVeggie; isStaple = isStaple || comp.isStaple;
      }
      // v3 套餐解构精确计数（轮级判定）：任一轮的 options 含主食类品项 → 该轮必出 1 份主食；
      // 比默认项判定稳健（随心选型套餐的默认项可能是聚合名）。veggie 保持默认项判定（小食轮不必然是蔬菜）。
      const stapleCount = deconstruction.filter((r) =>
        r.category === 'staple' || r.options.some((o) => RE_STAPLE.test(o.name) && !/薯/.test(o.name)),
      ).length;
      const defaultNames = deconstruction.map((r) => r.defaultName);
      const veggieCount = defaultNames.filter((n) => RE_VEGGIE.test(n)).length;
      built = {
        ...c,
        kcal, protein, fat, carbohydrate: carb, sodium, fastCarb,
        // 套餐本身即正餐结构：含任意主食组件，或本身以「餐/套」命名
        isVeggie,
        isStaple: isStaple || /餐|套/.test(c.name),
        isCombo: true,
        nutritionMatched: !componentUnknown,
        ...(deconstruction.length > 0 ? { deconstruction, stapleCount, veggieCount } : {}),
      };
      status = 'ok';
    } catch (e) {
      // v1.4.8 R02/R08：套餐结构未取得 → **不得当作已知单品**（旧实现用主食营养联结掩盖缺失）。
      //   拼单场景保留为「结构未知」的可购买候选（营养未知，不参与心愿覆盖）；
      //   精算场景直接剔除，避免把 kcal=0 的降级条目当真实热量求解。
      const issue = e instanceof Error ? e.message : String(e);
      structureIssues.push(`${c.name}（${c.code}）：${issue}`);
      built = opts.includeUnmatched
        ? { ...c, kcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0, fastCarb: 0, isVeggie: false, isStaple: /餐|套/.test(c.name), isCombo: true, nutritionMatched: false, structureUnknown: true, structureIssue: issue }
        : null;
    }
    comboCache.set(ck, { at: Date.now(), item: built, status });
    return built;
  });
  for (const ci of comboItems) {
    if (ci) items.push(ci);
    else comboUnmatched++;
  }

  const result: MenuLoadResult = {
    items,
    unmatched: unmatched + comboUnmatched,
    comboCount: comboItems.filter(Boolean).length,
    comboUnmatched,
    table,
    ...(structureIssues.length > 0 ? { structureIssues } : {}),
    ...(comboCapped.length > 0 ? { comboCapped: { limit: comboFetchLimit(), excluded: comboCapped.length, names: comboCapped } } : {}),
  };
  if (items.length > 0) menuCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

// ---------- 测试钩子（v1.4.8 R08；只读/清缓存，不改变业务行为） ----------
/** 读取套餐详情缓存状态：'ok'=详情成功，'failed'=失败/降级（短 TTL 重试） */
export function _comboCacheState(storeCode: string, code: string, includeUnmatched = false): 'ok' | 'failed' | 'missing' {
  const hit = comboCache.get(`${storeCode}:${code}${includeUnmatched ? ':full' : ''}`);
  return hit ? hit.status : 'missing';
}
/** 清空套餐详情缓存（模拟失败 TTL 到期） */
export function _clearComboCache(): void { comboCache.clear(); }
/** 清空菜单结果缓存（模拟菜单 TTL 到期后的重新加载） */
export function _clearMenuCache(): void { menuCache.clear(); }

/** 查询附近门店（searchType=2 需 city 与 keyword 同时传，实测契约） */export async function findStores(client: McpClient, city: string, keyword: string): Promise<StoreInfo[]> {
  const res = await client.call('query-nearby-stores', { beType: 1, searchType: 2, city, keyword });
  const list = (res.data as StoreInfo[] | undefined) ?? [];
  return list.map((s) => ({
    storeCode: s.storeCode,
    storeName: s.storeName,
    address: s.address,
    distance: s.distance,
    businessStatus: s.businessStatus,
  }));
}

/** 计算购物车实付价（单位：分）。失败时返回 null 由调用方回退菜单价 */
export async function quotePrice(
  client: McpClient,
  storeCode: string,
  items: Array<{ code: string; qty: number }>,
): Promise<{ priceCents: number; discountCents: number; originalCents: number } | null> {
  try {
    // v1.4.9 N01：预约场景必须按目标用餐时间核价（同一食品在早餐/常规时段价格不同）
    const res = await client.call('calculate-price', withOrderParams({
      storeCode,
      orderType: 1,
      beType: 1,
      items: items.map((i) => ({ productCode: i.code, quantity: i.qty })),
    }));
    const d = res.data as { price?: number; discount?: number; productOriginalPrice?: number };
    // 实测：个别券绑定商品（如麦咖啡）无券单点计价返回 price=0，视为无效报价回退菜单价
    if (typeof d?.price !== 'number' || d.price <= 0) return null;
    return { priceCents: d.price, discountCents: d.discount ?? 0, originalCents: d.productOriginalPrice ?? d.price };
  } catch {
    return null;
  }
}


/** 评审四轮（用户提议）：持久化产品目录——拉取成功即合并快照，
 *  打烊/非营业时段数据源拒绝时用快照兜底并标注时间；价格口径随之降级为「最后观测价」。
 *  v1.2：兜底读取走「当前可购池」口径（观测时效 + 餐段过滤，历史目录保留但不当当前可买）。
 *  v1.4.8 R09：**过滤为空不再复活全部历史品项**——旧实现让午餐池重新长出早餐套餐，
 *    还把原因误报成「超出观测时效窗口」。现在明确区分「超窗」与「非当前餐段」，并给出可执行提示。 */
export async function loadMenuItems(client: McpClient, storeCode: string, opts: MenuLoadOptions = {}): Promise<MenuLoadResult> {
  const rd = effectiveReservationDate(opts);
  const targetAt = rd ? parseReservationDate(rd) : null;
  try {
    const fresh = await loadMenuItemsFresh(client, storeCode, opts);
    // v1.4.9 N01：观测餐段按**目标用餐时间**记录，而不是按「现在几点」——
    //   否则 08:00 的预约采集会被记成 regular，快照兜底时早餐品项永远不进池。
    upsertMenuSnapshot(storeCode, fresh.items, {
      ...(targetAt ? { observedAt: targetAt } : {}),
      ...(opts.mealPeriod ?? targetAt ? { period: opts.mealPeriod ?? periodOfDate(targetAt!) } : {}),
    });
    return fresh;
  } catch (e) {
    const snap = menuSnapshot(storeCode, { currentOnly: true, ...(targetAt ? { now: targetAt } : {}) });
    if (!snap || snap.items.length === 0) {
      const full = menuSnapshot(storeCode);
      if (!full || full.items.length === 0) throw e;
      const why = snap?.emptyReason === 'off-period'
        ? `本地目录只观测到非当前餐段的商品（历史 ${full.total} 条，其中非当前餐段 ${snap.excludedOffPeriod} 条）`
        : `本地目录的观测已超出时效窗口（历史 ${full.total} 条）`;
      throw new Error(`门店菜单暂不可用，且${why}。历史目录仅作参考，不进入当前可购池；请在营业时段重新拉取当前菜单，或更换 24h 门店。`);
    }
    const includeUnmatched = !!opts.includeUnmatched;
    const items = snap.items.filter((it) => includeUnmatched || it.nutritionMatched || it.isCombo);
    const droppedSingles = snap.items.filter((it) => !it.isCombo && !it.nutritionMatched).length;
    const rows = nutritionRowsSnapshot();
    const poolNote = `菜单快照（${snap.snapshotAt.slice(0, 10)} 观测）：历史观测 ${snap.total} 条，按观测时效/餐段纳入当前可购池 ${snap.items.length} 条`
      + (snap.excludedStale + snap.excludedOffPeriod > 0 ? `（剔除超窗 ${snap.excludedStale}、非当前餐段 ${snap.excludedOffPeriod}）` : '')
      + '；价格为最后观测参考价，以实际营业时段结算为准。';
    const result: MenuLoadResult = {
      items,
      unmatched: includeUnmatched ? 0 : droppedSingles,
      comboCount: items.filter((i) => i.isCombo).length,
      comboUnmatched: 0,
      table: parseNutritionTable(rows.map((r: any) => `  ${r.productName},null,${r.energyKj},${r.energyKcal},${r.protein},${r.fat},${r.carbohydrate},${r.sodium},${r.calcium}`).join('\n')),
      fromSnapshotAt: snap.snapshotAt,
      snapshotPoolNote: poolNote,
    };
    return result;
  }
}