// 团购食品身份与规格解析（Task 3：食品解析与当前门店菜单解耦）
//
// 核心纪律（2026-10-17 用户决定）：
//   1. 券内容已知，但食品不在当前所选门店菜单中，不应直接排除；
//   2. 团购食品身份和营养解析，与当前门店官方菜单的可购性分开；
//   3. 身份解析顺序：证据明确的商品／食品标识 → 同食品同规格的审核别名 → 官网权威营养与补录层；
//   4. 缺失单点价时不虚构价格，不宣称节省了某个准确金额；
//   5. 真正不知道食品组成时不能编造；任选券仅支持已确认合法搭配时，明确为受限方案。
import type { MenuItem, MenuLoadResult } from './menu.js';
import type { VoucherRecipeItem } from './voucherRecipes.js';
import { MAX_ITEM_QTY } from './recipeSchema.js';
import {
  resolveComponentNutrition,
  type ResolvedComponentNutrition,
  type NutritionMetric,
  nutritionFieldKnown,
} from './nutritionSupplements.js';

export interface ResolvedVoucherFood {
  keyword: string;
  displayName: string;
  spec?: string;
  qty: number;
  // 营养
  kcal: number;
  kcalKnown: boolean;
  protein: number;
  fat: number;
  carbohydrate: number;
  sodium: number;
  valueKind: 'exact' | 'estimate' | 'none';
  unknownFields: string[];
  strictUsable: boolean;
  nutritionSource?: string;
  nutritionEstimated?: boolean;
  // 分类与健康度量
  isStaple: boolean;
  isVeggie: boolean;
  isDrink: boolean;
  isSugary?: boolean;
  fastCarb: number;
  fastCarbKnown: boolean;
  // 履约与可购性
  fulfillCode?: string;
  priceCents: number;
  inStoreMenu: boolean;
  matched: boolean;
}

export interface ResolvedVoucherSlotOption {
  name: string;
  kcal: number;
  kcalKnown: boolean;
  priceCents: number;
  diffCents: number;
  /** v1.4.5 W03：券面有补差说明但无法归因到本选项——0 是占位，不得宣称「免费」 */
  diffUnknown?: boolean;
  staple: boolean;
  veggie: boolean;
  code?: string;
  fastCarb: number;
  fastCarbKnown: boolean;
  drink: boolean;
  sugary?: boolean;
  protein: number;
  fat: number;
  carbohydrate: number;
  sodium: number;
  estimated?: boolean;
  unknownNutrition?: string[];
  nutritionSource?: string;
}

export interface ResolvedVoucherSlot {
  roundName: string;
  defaultName: string;
  roundId?: string;
  options: ResolvedVoucherSlotOption[];
}

/** 逐组解析报告（v1.4.5 W03）：声明了多少项、解析成功多少项、哪些项不支持及原因。
 *  用于区分「完整支持」与「部分支持」——部分可算不等于券面全部可选。 */
export interface VoucherGroupReport {
  group: string;
  mode: 'fixed' | 'choice' | 'combo-ref';
  qty: number;
  declared: number;
  resolved: number;
  complete: boolean;
  unsupported: Array<{ name: string; reason: string }>;
  /** 券面声明了补差但无法结构化到选项（此时 diffCents 的 0 不代表免费） */
  surchargeUnknown?: boolean;
}

export interface VoucherFoodResolution {
  ok: boolean;
  /** 全部声明项均已解析（false = 部分支持，不得宣称完整） */
  complete: boolean;
  recipeId: string;
  slots: ResolvedVoucherSlot[];
  foods: ResolvedVoucherFood[];
  groups: VoucherGroupReport[];
  unresolvedReasons?: string[];
  isRestrictedCombo?: boolean;
  restrictedNote?: string;
}

function normName(s: string): string {
  return (s ?? '').replace(/[（(【\[].*?[)）】\]]/g, '').replace(/\s+/g, '').toLowerCase();
}

function normSpecToken(s: string | undefined): string {
  return normName(s ?? '').replace(/[份杯个块条只支\-—_·+]/g, '');
}

// 含糖饮品与饮料身份判定（与 groupKernel / optimizer 同口径）
const RE_SUGARY_DRINK_OPT = /可乐|雪碧|果汁|柠檬红茶|冰茶|奶铁|奶茶|奶冻|爆珠|雪冰|怡泉|美汁源|麦旋酷|芬达|拿铁|咖啡|纯悦|牛奶/;
const RE_ZERO_SUGAR_OPT = /无糖|零度|零卡/;
const RE_STAPLE_OPT = /堡|麦满分|卷|吉士蛋|巨无霸|板烧|麦香鱼|麦香鸡|安格斯/;

export function isDrinkName(name: string, category?: string, roundCategory?: string): boolean {
  if (category && (category === 'drink' || /饮品|麦咖啡/.test(category))) return true;
  if (roundCategory && (roundCategory === 'drink' || /饮品|饮料/.test(roundCategory))) return true;
  return RE_SUGARY_DRINK_OPT.test(name);
}

export function sugaryOf(name: string, drink: boolean, kcalKnown: boolean, carbohydrate: number): boolean | undefined {
  if (!drink) return false;
  if (RE_ZERO_SUGAR_OPT.test(name)) return false;
  if (kcalKnown && Number.isFinite(carbohydrate)) return carbohydrate >= 5;
  return undefined;
}

/** 审核后的同食品别名（保留糖型、数量、规格、份量，严禁跨品类或改变肉饼数） */
export const SAME_FOOD_ALIASES: Array<{ re: RegExp; canonicalName: string; defaultSpec?: string }> = [
  { re: /^麦麦脆汁鸡$/, canonicalName: '麦麦脆汁鸡1块', defaultSpec: '1块' },
  { re: /^麦辣鸡翅$/, canonicalName: '麦辣鸡翅2块', defaultSpec: '2块' },
  { re: /^麦乐鸡$/, canonicalName: '麦乐鸡5块', defaultSpec: '5块' },
  { re: /^经典麦旋风$/, canonicalName: '经典麦旋风', defaultSpec: '1个' },
  { re: /^奥利奥麦旋风$/, canonicalName: '奥利奥麦旋风', defaultSpec: '1个' },
  { re: /^心形薯饼5块$/, canonicalName: '心形薯饼5块', defaultSpec: '5块' },
  { re: /^马苏里拉拉丝芝士条$/, canonicalName: '马苏里拉拉丝芝士条', defaultSpec: '1份' },
  { re: /^灰焰圆筒$/, canonicalName: '灰焰圆筒', defaultSpec: '1个' },
  { re: /^蓝莓爆爆珠麦旋风$/, canonicalName: '蓝莓爆爆珠麦旋风', defaultSpec: '1个' },
  { re: /^那么大鸡排$/, canonicalName: '那么大鸡排（椒盐风味）', defaultSpec: '1份' },
  { re: /^圆筒冰淇淋$/, canonicalName: '圆筒冰淇淋', defaultSpec: '1个' },
  { re: /^玉米杯$/, canonicalName: '玉米杯', defaultSpec: '1份' },
  { re: /^吉士汉堡包$/, canonicalName: '吉士汉堡包', defaultSpec: '1个' },
  { re: /^香芋派$/, canonicalName: '香芋派', defaultSpec: '1个' },
  { re: /^菠萝派$/, canonicalName: '菠萝派', defaultSpec: '1个' },
  { re: /^(麦辣鸡腿堡|麦辣鸡腿汉堡)$/, canonicalName: '麦辣鸡腿汉堡', defaultSpec: '1个' },
  { re: /^(双层吉士堡|双层吉士汉堡)$/, canonicalName: '双层吉士汉堡', defaultSpec: '1个' },
  { re: /^(美式咖啡|中杯美式|美式|冰美式)$/, canonicalName: '冰美式', defaultSpec: '中' },
  { re: /^(奶铁|中杯奶铁|冰奶铁)$/, canonicalName: '冰奶铁', defaultSpec: '中' },
  { re: /^(优品豆浆|小豆浆)$/, canonicalName: '优品豆浆', defaultSpec: '小' },
  // v1.4.5 W01：热鲜萃与冰鲜萃是**两种商品**（仅营养参考值相同），不得合并为一个展示身份——
  //   合并会让早餐券的「鲜萃咖啡/鲜萃冰咖」两项在槽位里变成同名重复项。
  { re: /^(鲜萃咖啡|小鲜萃)$/, canonicalName: '鲜萃咖啡', defaultSpec: '小杯' },
  { re: /^(酥酥多笋卷)$/, canonicalName: '酥酥多笋卷', defaultSpec: '1份' },
  { re: /^(酥脆带骨里脊|带骨里脊)$/, canonicalName: '酥脆带骨里脊', defaultSpec: '1块' },
  { re: /^(吉士蛋麦满分|吉士蛋堡)$/, canonicalName: '吉士蛋麦满分', defaultSpec: '1个' },
  { re: /^(小薯条)$/, canonicalName: '薯条', defaultSpec: '小' },
  { re: /^(中薯条)$/, canonicalName: '薯条', defaultSpec: '中' },
  { re: /^(大薯条)$/, canonicalName: '薯条', defaultSpec: '大' },
  // v1.4.5 W02：可乐类统一用「可乐」作为匹配名（官网产品名「可口可乐」经归一化后同为「可乐」），
  //   规格由 spec 承载——展示名才是「小可乐」，不会出现「小可口可乐」。
  { re: /^(小可乐|小杯可乐)$/, canonicalName: '可乐', defaultSpec: '小' },
  { re: /^(中可乐|中杯可乐)$/, canonicalName: '可乐', defaultSpec: '中' },
  { re: /^(大可乐|大杯可乐)$/, canonicalName: '可乐', defaultSpec: '大' },
  { re: /^(无糖小可乐|小无糖可乐)$/, canonicalName: '无糖可乐', defaultSpec: '小' },
  { re: /^(无糖中可乐|中无糖可乐|无糖可乐)$/, canonicalName: '无糖可乐', defaultSpec: '中' },
  { re: /^(无糖大可乐|大无糖可乐)$/, canonicalName: '无糖可乐', defaultSpec: '大' },
  { re: /^(草莓麦旋风)$/, canonicalName: '草莓麦旋风', defaultSpec: '1个' },
];

/** 严格规格 token：声明了这类规格却没有权威命中时，必须记「未知」，不得回落到默认份量 */
const RE_STRICT_SPEC = /^(迷你|小|中|大|[一二两三四五六七八九十\d]+(块|个|份|杯|条|只|支))$/;

export function isStrictSpecToken(spec?: string): boolean {
  return !!spec && RE_STRICT_SPEC.test(spec.replace(/\s+/g, ''));
}

/** 组合展示名（v1.4.5 W02）：件数规格作后缀（麦辣鸡翅4块），份量规格作前缀（小薯条/小可乐）。
 *  规格未声明或与品名重复时保持原品名。 */
export function composeDisplayName(base: string, spec?: string): string {
  const s = (spec ?? '').replace(/\s+/g, '');
  if (!s) return base;
  const piece = s.match(/^(\d+)块$/);
  if (piece) return `${base.replace(/\d+块$/, '')}${piece[1]}块`;
  if (/^(迷你|小|中|大)$/.test(s)) {
    const stripped = base.replace(/^(迷你|小|中|大)(?=[^杯份])/, '');
    return `${s}${stripped}`;
  }
  return base; // 1个/1份 等数量词不改变展示名
}

/** 解析券中单项固定食品的身份、规格、营养与当前门店可购性（与当前单点菜单解耦） */
export function resolveFixedVoucherFood(
  ref: VoucherRecipeItem,
  menu?: MenuLoadResult,
): ResolvedVoucherFood | null {
  const keywordNorm = normName(ref.keyword);
  if (!keywordNorm) return null;

  const declaredSpec = normSpecToken(ref.spec);
  let matchedMenuItem: MenuItem | undefined;

  // ① 尝试在当前门店菜单中定位
  if (menu && menu.items.length > 0) {
    const singles = menu.items.filter((x) => !x.isCombo);
    if (ref.fulfillCode) {
      matchedMenuItem = singles.find((x) => x.code === ref.fulfillCode);
    }
    if (!matchedMenuItem) {
      // 归一化全名匹配
      matchedMenuItem = singles.find((x) => normName(x.name) === keywordNorm);
    }
    if (!matchedMenuItem) {
      // 审核别名匹配
      for (const a of SAME_FOOD_ALIASES) {
        if (!a.re.test(ref.keyword)) continue;
        if (declaredSpec && a.defaultSpec && declaredSpec !== normSpecToken(a.defaultSpec)) continue;
        const hit = singles.find((x) => normName(x.name) === normName(a.canonicalName));
        if (hit) { matchedMenuItem = hit; break; }
      }
    }
    if (!matchedMenuItem && declaredSpec) {
      // 规格词限定匹配（例如「中薯条」）
      const hits = singles.filter((x) => {
        const nm = normName(x.name);
        if (nm === keywordNorm || !nm.endsWith(keywordNorm)) return false;
        const head = nm.slice(0, nm.length - keywordNorm.length);
        return head !== '' && normSpecToken(head) === declaredSpec;
      });
      if (hits.length === 1) matchedMenuItem = hits[0];
    }
  }

  // ② 营养解析（权威官网库优先 → 补录层回退 → 未知）
  // 查找规范食品名与规格
  let canonicalName = matchedMenuItem ? matchedMenuItem.name : ref.keyword;
  const aliasHit = SAME_FOOD_ALIASES.find((a) => a.re.test(ref.keyword));
  if (!matchedMenuItem && aliasHit) {
    canonicalName = aliasHit.canonicalName;
  }

  // v1.4.5 W02：规格优先级 = 券面声明 > 别名默认规格 > 品名本身。
  //   声明了严格规格（小/中/大/N块…）却解析不到同规格权威值时，**不得**回落到默认份量冒充匹配。
  const declaredSpecRaw = (ref.spec ?? '').replace(/\s+/g, '');
  const effectiveSpec = declaredSpecRaw || aliasHit?.defaultSpec || '';
  const specRaw = effectiveSpec || ref.keyword;
  let nut = resolveComponentNutrition(canonicalName, specRaw);
  if (!nut.matched && canonicalName !== ref.keyword) {
    nut = resolveComponentNutrition(ref.keyword, specRaw);
  }
  const strictSpec = isStrictSpecToken(effectiveSpec);
  if (!nut.matched && strictSpec) {
    // 规格已声明但无法确认（如「麦辣鸡翅 4块」官网仅有 2块 且非整倍数、「脆汁鸡 999块」）→ 未知
    const quantityOnly = /^1(个|份|杯|条|只|支)$/.test(effectiveSpec);
    if (!quantityOnly) return null;
  }
  if (!nut.matched) {
    nut = resolveComponentNutrition(ref.keyword, ref.keyword);
  }

  // 若食品身份及营养完全无法解析，返回 null（不能凭空编造）
  if (!nut.matched && !matchedMenuItem?.nutritionMatched) {
    return null;
  }

  const inStoreMenu = !!matchedMenuItem;
  const priceCents = matchedMenuItem ? matchedMenuItem.priceCents : 0;
  const fulfillCode = matchedMenuItem ? matchedMenuItem.code : ref.fulfillCode;

  // 展示名只反映**券面已声明**的规格（或品名自带规格），不把内部推断的默认规格写进名字
  const keywordHasSpec = /^(迷你|小|中|大)/.test(ref.keyword)
    || /(迷你|小|中|大)(可乐|雪碧|薯条|咖啡|奶铁|豆浆|美式)/.test(ref.keyword)
    || /(\d+|[一二两三四五])块$/.test(ref.keyword);
  const displaySpec = declaredSpecRaw || (keywordHasSpec ? (aliasHit?.defaultSpec ?? '') : '');
  const displayName = composeDisplayName(canonicalName, displaySpec);

  const isDrink = isDrinkName(displayName, matchedMenuItem?.category);
  const known = (m: NutritionMetric) => nutritionFieldKnown(nut, m);
  const carbKnown = known('carbohydrate');
  const sugaryVal = sugaryOf(displayName, isDrink, carbKnown, nut.carbohydrate);

  return {
    keyword: ref.keyword,
    displayName,
    spec: ref.spec,
    qty: Math.max(1, Number(ref.qty) || 1),
    kcal: known('kcal') ? nut.kcal : (matchedMenuItem?.kcal ?? 0),
    kcalKnown: known('kcal') || (matchedMenuItem?.nutritionMatched ?? false),
    protein: known('protein') ? nut.protein : (matchedMenuItem?.protein ?? 0),
    fat: known('fat') ? nut.fat : (matchedMenuItem?.fat ?? 0),
    carbohydrate: carbKnown ? nut.carbohydrate : (matchedMenuItem?.carbohydrate ?? 0),
    sodium: known('sodium') ? nut.sodium : (matchedMenuItem?.sodium ?? 0),
    valueKind: nut.valueKind,
    unknownFields: [...nut.unknownFields],
    strictUsable: nut.strictUsable,
    nutritionSource: nut.sourceLabel || matchedMenuItem?.nutritionSource,
    nutritionEstimated: nut.valueKind === 'estimate' || !!matchedMenuItem?.nutritionEstimated,
    isStaple: (RE_STAPLE_OPT.test(displayName) && !/薯/.test(displayName)) || (matchedMenuItem?.isStaple ?? false),
    isVeggie: /蔬菜|沙拉|玉米|苹果片/.test(displayName) || (matchedMenuItem?.isVeggie ?? false),
    isDrink,
    isSugary: sugaryVal,
    fastCarb: isDrink && carbKnown && nut.carbohydrate >= 5 ? nut.carbohydrate : (matchedMenuItem?.fastCarb ?? 0),
    fastCarbKnown: !isDrink || sugaryVal !== undefined,
    fulfillCode,
    priceCents,
    inStoreMenu,
    matched: true,
  };
}

/** 券配方来源（Voucher 与 VoucherRecipe 均结构兼容：只需要 id/items/规则与证据字段） */
export interface VoucherFoodSource {
  id?: string;
  items: VoucherRecipeItem[];
  ruleVersion?: string;
  evidence?: string;
}

/**
 * 券面补差 → 选项差价（v1.4.5 W03）。
 * 结构化 optionDiffs（分）优先；否则解析券面文本（「换鸡翅加 2 元」「升大杯 +2 元」）。
 * 返回 known=false 表示券面声明了补差但无法归因到该选项——调用方必须按「差价未知」处理，
 * 不得把 0 当作「免费」。
 */
export function optionDiffCents(
  item: Pick<VoucherRecipeItem, 'surcharge' | 'optionDiffs'>,
  optionName: string,
): { diffCents: number; known: boolean } {
  const opt = normName(optionName);
  if (item.optionDiffs && Object.keys(item.optionDiffs).length > 0) {
    const key = Object.keys(item.optionDiffs).find((k) => {
      const nk = normName(k);
      return nk !== '' && (nk === opt || opt.includes(nk) || nk.includes(opt));
    });
    if (key) return { diffCents: Math.round(Number(item.optionDiffs[key]) || 0), known: true };
    return { diffCents: 0, known: false }; // 结构化差价未覆盖本选项 → 未知
  }
  const text = (item.surcharge ?? '').trim();
  if (!text) return { diffCents: 0, known: true };
  for (const clause of text.split(/[；;，,、]/).map((s) => s.trim()).filter(Boolean)) {
    const m = clause.match(/^(.*?)(?:加|＋|\+)\s*(\d+(?:\.\d+)?)\s*元/);
    if (!m) continue;
    const target = normName(m[1]).replace(/^(换|升级|升|选|改)/, '');
    if (!target || target.length < 2) continue;
    if (opt.includes(target) || target.includes(opt)) {
      return { diffCents: Math.round(parseFloat(m[2]) * 100), known: true };
    }
  }
  return { diffCents: 0, known: false };
}

/**
 * 将整条配方解析为食品单元与槽位（单人/多人求解共用唯一食品解析结果）。
 * 与当前官方单点菜单的可购性解耦。
 *
 * v1.4.5 W01/W03：
 *  - choice 条目声明了**具体食品范围**时，按 qty 展开为实际购买单元（不再借用官方 SKU 轮次）；
 *  - 逐组输出声明数/解析数/不支持项（groups），区分「完整支持」与「部分支持」；
 *  - 券面补差按选项归因，无法归因时标记 diffUnknown（0 不代表免费）。
 */
export function resolveVoucherFoods(
  recipe: VoucherFoodSource,
  context: { menu?: MenuLoadResult } = {},
): VoucherFoodResolution {
  const foods: ResolvedVoucherFood[] = [];
  const slots: ResolvedVoucherSlot[] = [];
  const groups: VoucherGroupReport[] = [];
  const unresolvedReasons: string[] = [];
  let blocking = false;

  const isRestrictedCombo = recipe.ruleVersion === 'restricted-combo-v1'
    || recipe.evidence?.includes('仅计算已确认的搭配')
    || recipe.evidence?.includes('非完整任选');

  const toOption = (
    resolved: ResolvedVoucherFood,
    diffCents: number,
    diffUnknown?: boolean,
  ): ResolvedVoucherSlotOption => ({
    name: resolved.displayName,
    kcal: resolved.kcal,
    kcalKnown: resolved.kcalKnown,
    priceCents: resolved.priceCents,
    diffCents,
    ...(diffUnknown ? { diffUnknown: true } : {}),
    staple: resolved.isStaple,
    veggie: resolved.isVeggie,
    code: resolved.fulfillCode,
    fastCarb: resolved.fastCarb,
    fastCarbKnown: resolved.fastCarbKnown,
    drink: resolved.isDrink,
    sugary: resolved.isSugary,
    protein: resolved.protein,
    fat: resolved.fat,
    carbohydrate: resolved.carbohydrate,
    sodium: resolved.sodium,
    ...(resolved.nutritionEstimated ? { estimated: true } : {}),
    ...(resolved.unknownFields.length ? { unknownNutrition: [...resolved.unknownFields] } : {}),
    ...(resolved.nutritionSource ? { nutritionSource: resolved.nutritionSource } : {}),
  });

  for (const item of recipe.items) {
    // v1.4.8 R13：不再 Math.min(8, …) 静默截断。入口（recipeSchema）已保证正整数且 ≤ MAX_ITEM_QTY；
    //   历史数据可能带小数/超限值——这里按「取整后落在 [1, MAX]」处理并在越界时记入 unresolvedReasons，
    //   让声明与展开数量守恒可被审计（绝不悄悄少给/多给食品）。
    const rawQty = Number(item.qty ?? 1);
    const refQty = Number.isFinite(rawQty) ? Math.round(rawQty) : 1;
    if (!Number.isSafeInteger(refQty) || refQty < 1 || refQty > MAX_ITEM_QTY) {
      const reason = `条目「${item.keyword}」份数 ${String(item.qty)} 无效（应为 1..${MAX_ITEM_QTY} 的整数）`;
      unresolvedReasons.push(reason);
      groups.push({ group: item.keyword, mode: item.mode, qty: refQty, declared: 0, resolved: 0, complete: false, unsupported: [{ name: item.keyword, reason }] });
      blocking = true;
      continue;
    }
    if (item.mode === 'fixed') {
      const resolved = resolveFixedVoucherFood(item, context.menu);
      if (!resolved) {
        const reason = `固定品项「${item.keyword}」无法确认食品身份或未收录营养`;
        unresolvedReasons.push(reason);
        groups.push({ group: item.keyword, mode: 'fixed', qty: refQty, declared: 1, resolved: 0, complete: false, unsupported: [{ name: item.keyword, reason }] });
        blocking = true;
        continue;
      }
      foods.push(resolved);
      const option = toOption(resolved, 0);
      for (let q = 0; q < resolved.qty; q++) {
        slots.push({ roundName: resolved.displayName, defaultName: resolved.displayName, options: [option] });
      }
      groups.push({ group: item.keyword, mode: 'fixed', qty: refQty, declared: 1, resolved: 1, complete: true, unsupported: [] });
    } else if (item.mode === 'combo-ref') {
      // 官方同名套餐整包
      const comboName = item.comboName || item.keyword;
      const combo = context.menu?.items.find((x) => x.isCombo && (x.code === item.keyword || normName(x.name) === normName(comboName)));
      if (!combo || !combo.deconstruction || combo.deconstruction.length === 0) {
        const reason = `官方套餐整包「${comboName}」未在当前菜单中取得轮次明细`;
        unresolvedReasons.push(reason);
        groups.push({ group: comboName, mode: 'combo-ref', qty: refQty, declared: 0, resolved: 0, complete: false, unsupported: [{ name: comboName, reason }] });
        blocking = true;
        continue;
      }
      const before = slots.length;
      const missingRounds: string[] = [];
      for (let q = 0; q < refQty; q++) {
        for (const round of combo.deconstruction) {
          const roundName = refQty > 1 ? `${round.roundName}（第${q + 1}份）` : round.roundName;
          const opts: ResolvedVoucherSlotOption[] = [];
          for (const opt of round.options) {
            const resolvedOpt = resolveFixedVoucherFood({ keyword: opt.name, mode: 'fixed', qty: 1 }, context.menu);
            if (resolvedOpt) opts.push(toOption(resolvedOpt, opt.diffCents));
          }
          if (opts.length > 0) {
            slots.push({
              roundName,
              defaultName: round.defaultName || opts[0].name,
              ...(round.roundId ? { roundId: round.roundId } : {}),
              options: opts,
            });
          } else {
            missingRounds.push(round.roundName);
          }
        }
      }
      const declared = combo.deconstruction.length * refQty;
      groups.push({
        group: comboName, mode: 'combo-ref', qty: refQty, declared,
        resolved: slots.length - before, complete: missingRounds.length === 0,
        unsupported: missingRounds.map((r) => ({ name: r, reason: '轮次内选项均无法解析' })),
      });
      if (slots.length === before) {
        unresolvedReasons.push(`官方套餐「${comboName}」的轮次选项均无法解析`);
        blocking = true;
      }
    } else if (item.mode === 'choice') {
      const range = Array.isArray(item.choiceRange) ? item.choiceRange.filter((c) => typeof c === 'string' && c.trim() !== '') : [];
      if (range.length === 0) {
        // 纯任选（未受限）且无官方 SKU 轮次绑定及可选范围
        const reason = `任选项「${item.keyword}」可选范围未绑定官方 SKU 轮次，也未声明具体食品范围`;
        unresolvedReasons.push(reason);
        groups.push({ group: item.keyword, mode: 'choice', qty: refQty, declared: 0, resolved: 0, complete: false, unsupported: [{ name: item.keyword, reason }] });
        blocking = true;
        continue;
      }
      const opts: ResolvedVoucherSlotOption[] = [];
      const unsupported: Array<{ name: string; reason: string }> = [];
      let anyDiffUnknown = false;
      for (const candidate of range) {
        const resolvedOpt = resolveFixedVoucherFood({ keyword: candidate, mode: 'fixed', qty: 1 }, context.menu);
        if (!resolvedOpt) {
          unsupported.push({ name: candidate, reason: '食品身份或规格无法确认（未收录营养）' });
          continue;
        }
        const diff = optionDiffCents(item, resolvedOpt.displayName);
        if (!diff.known) anyDiffUnknown = true;
        opts.push(toOption(resolvedOpt, diff.diffCents, !diff.known));
      }
      if (opts.length === 0) {
        const reason = `任选项「${item.keyword}」的声明范围无法匹配任何有效食品`;
        unresolvedReasons.push(reason);
        groups.push({ group: item.keyword, mode: 'choice', qty: refQty, declared: range.length, resolved: 0, complete: false, unsupported: unsupported.length ? unsupported : [{ name: item.keyword, reason }] });
        blocking = true;
        continue;
      }
      for (let q = 0; q < refQty; q++) {
        const roundName = refQty > 1 ? `${item.spec || item.keyword}（第${q + 1}件）` : (item.spec || item.keyword);
        slots.push({ roundName, defaultName: opts[0].name, options: opts });
      }
      groups.push({
        group: item.keyword, mode: 'choice', qty: refQty, declared: range.length,
        resolved: opts.length, complete: unsupported.length === 0, unsupported,
        ...(anyDiffUnknown ? { surchargeUnknown: true } : {}),
      });
    }
  }

  const ok = !blocking && slots.length > 0;
  const complete = ok && groups.every((g) => g.complete);
  return {
    ok,
    complete,
    recipeId: recipe.id ?? 'unknown',
    slots: ok ? slots : [],
    foods: ok ? foods : [],
    groups,
    ...(unresolvedReasons.length ? { unresolvedReasons } : {}),
    ...(isRestrictedCombo ? { isRestrictedCombo: true, restrictedNote: '仅计算已确认的合法搭配（非完整任选）' } : {}),
  };
}
