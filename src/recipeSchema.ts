// 配方输入的**唯一**规范化入口（v1.4.7 R04）：
//   CLI（voucher recipe add/import/revise）、HTTP（/api/recipes、/api/recipes/import*）、
//   截图识图草稿都走这里，避免「网页能存、Agent 导入丢字段」的两套口径。
//
// 旧问题：CLI 的 normalizeRecipeInput 与 server 的 normalizeRecipe 各写一份，都漏掉了
//   productViewSigns / skuViewIds / optionDiffs —— 经 Agent 导入后商品身份数组与结构化补差消失，
//   不同商品 ID 也能命中同一配方。现在：
//   - 字段白名单显式声明：合法字段一律往返保留；未知字段**明确报错**（不静默丢弃）；
//   - 校验规则只写一份（必填/类型/取值范围）；
//   - strict=true（HTTP 保存路径）额外要求证据字段齐全，与既有 API 契约一致。
import type { VoucherRecipe, VoucherRecipeItem } from './voucherRecipes.js';

export class RecipeSchemaError extends Error {
  readonly code = 'E_INPUT_INVALID';
}

const TOP_LEVEL_FIELDS = new Set([
  'id', 'name', 'matchNames', 'resolve', 'channel', 'channelLabel', 'items', 'conditions',
  'priceCents', 'originalPriceCents', 'buyPath', 'redeemPath', 'evidence', 'verifiedAt', 'ruleVersion',
  'productViewSign', 'skuViewId', 'productViewSigns', 'skuViewIds', 'headUrl', 'source', 'scope', 'binding', 'seedMeta',
]);
/** 控制字段：不是配方数据，允许出现在请求体顶层 */
const CONTROL_FIELDS = new Set(['force', 'mode', 'dryRun']);

const ITEM_FIELDS = new Set(['mode', 'keyword', 'qty', 'spec', 'comboName', 'choiceRange', 'surcharge', 'optionDiffs', 'fulfillCode']);

const RESOLVES = ['combo-name', 'pattern', 'explicit'] as const;
const CHANNELS = ['meituan', 'dianping', 'douyin', 'bank', 'owned'] as const;
/** v1.4.8 R13：单条券面声明允许的最大份数（显式上限，超过在入口拒绝而不是下游截断）。 */
export const MAX_ITEM_QTY = 20;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function assertKnownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new RecipeSchemaError(`${where}包含未识别字段：${unknown.join('、')}。` +
      '合法字段见 references/contracts.md；未知字段不会被静默丢弃，请改名或先移除。');
  }
}

function parseOptionDiffs(v: unknown, where: string): Record<string, number> {
  if (!isRecord(v)) throw new RecipeSchemaError(`${where} optionDiffs 必须是 { 选项名: 分 } 对象`);
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v)) {
    const n = Number(val);
    if (!Number.isFinite(n)) throw new RecipeSchemaError(`${where} optionDiffs.${k} 必须是数值（单位：分）`);
    out[k] = Math.round(n);
  }
  return out;
}

export interface NormalizeRecipeOptions {
  /** true = HTTP 保存路径：证据字段（buyPath/redeemPath/evidence/verifiedAt/ruleVersion）必填 */
  strict?: boolean;
}

/** 规范化一条配方；非法输入抛 RecipeSchemaError（含可读原因）。 */
export function normalizeRecipeInput(raw: unknown, opts: NormalizeRecipeOptions = {}): VoucherRecipe {
  if (!isRecord(raw)) throw new RecipeSchemaError('配方必须是 JSON 对象');
  assertKnownKeys(raw, new Set([...TOP_LEVEL_FIELDS, ...CONTROL_FIELDS]), '配方');
  const id = text(raw.id);
  if (!id) throw new RecipeSchemaError('配方缺少必填字段 id（建议含来源与商品标识，如 rcp-<productViewSign>-v1）');
  const name = text(raw.name);
  if (!name) throw new RecipeSchemaError(`配方「${id}」缺少必填字段 name`);

  const resolve = RESOLVES.includes(raw.resolve as typeof RESOLVES[number]) ? raw.resolve as typeof RESOLVES[number] : (opts.strict ? null : 'explicit');
  if (!resolve) throw new RecipeSchemaError('resolve 必须是 combo-name、pattern 或 explicit');
  const channel = CHANNELS.includes(raw.channel as typeof CHANNELS[number]) ? raw.channel as typeof CHANNELS[number] : (opts.strict ? null : 'meituan');
  if (!channel) throw new RecipeSchemaError('channel 必须是 meituan/dianping/douyin/bank/owned 之一');
  const channelLabel = text(raw.channelLabel) || (opts.strict ? '' : '美团团购（到店）');
  if (!channelLabel) throw new RecipeSchemaError('channelLabel 必填');

  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new RecipeSchemaError(`配方「${id}」缺少 items[]（券面构成）`);
  }
  const items: VoucherRecipeItem[] = raw.items.map((entry, i) => {
    const where = `配方「${id}」第 ${i + 1} 条`;
    if (!isRecord(entry)) throw new RecipeSchemaError(`${where}必须是对象`);
    assertKnownKeys(entry, ITEM_FIELDS, where);
    const mode = entry.mode;
    if (mode !== 'fixed' && mode !== 'choice' && mode !== 'combo-ref') {
      throw new RecipeSchemaError(`${where} mode 必须是 fixed/choice/combo-ref`);
    }
    const keyword = text(entry.keyword);
    if (!keyword) throw new RecipeSchemaError(`${where}缺少 keyword（fixed=品名、choice=品类 key、combo-ref=官方套餐 code）`);
    // v1.4.8 R13：qty 必须是正安全整数，且有显式上限（本版本 20）。
    //   旧实现只校验 `> 0`：1.5 通过校验后在下游被取整/截断（fixed 1.5 → 2 槽、choice 1.5 → 1 槽），
    //   qty=9 只展开 8 槽，声明与展开数量不一致；HTTP 也照常回 ok=true。
    //   现在不支持的数量在**入口**拒绝，绝不静默截断。
    const qtyRaw = entry.qty === undefined ? 1 : Number(entry.qty);
    if (!Number.isSafeInteger(qtyRaw) || qtyRaw <= 0) {
      throw new RecipeSchemaError(`${where} qty 必须是正整数（收到「${String(entry.qty ?? 1)}」；份数不支持小数）`);
    }
    if (qtyRaw > MAX_ITEM_QTY) {
      throw new RecipeSchemaError(`${where} qty=${qtyRaw} 超出单条上限 ${MAX_ITEM_QTY}；请拆成多条声明或联系维护者评估上限`);
    }
    if (entry.choiceRange !== undefined && (!Array.isArray(entry.choiceRange) || !entry.choiceRange.every((x) => typeof x === 'string' && x.trim()))) {
      throw new RecipeSchemaError(`${where} choiceRange 必须是非空字符串数组`);
    }
    for (const field of ['spec', 'comboName', 'surcharge', 'fulfillCode'] as const) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string') throw new RecipeSchemaError(`${where} ${field} 必须是字符串`);
    }
    return {
      mode, keyword, qty: qtyRaw,
      ...(typeof entry.spec === 'string' ? { spec: entry.spec } : {}),
      ...(typeof entry.comboName === 'string' ? { comboName: entry.comboName } : {}),
      ...(Array.isArray(entry.choiceRange) ? { choiceRange: (entry.choiceRange as string[]).map((x) => x.trim()) } : {}),
      ...(typeof entry.surcharge === 'string' ? { surcharge: entry.surcharge } : {}),
      ...(entry.optionDiffs !== undefined ? { optionDiffs: parseOptionDiffs(entry.optionDiffs, where) } : {}),
      ...(typeof entry.fulfillCode === 'string' ? { fulfillCode: entry.fulfillCode } : {}),
    };
  });

  const condRaw = raw.conditions === undefined ? {} : raw.conditions;
  if (!isRecord(condRaw)) throw new RecipeSchemaError('conditions 必须是对象');
  const orderType = condRaw.orderType === undefined ? 'instore' : condRaw.orderType;
  if (orderType !== 'instore' && orderType !== 'delivery') throw new RecipeSchemaError('conditions.orderType 必须是 instore 或 delivery');
  const conditions: VoucherRecipe['conditions'] = { orderType };
  for (const field of ['timeWindow', 'storeScope', 'expireNote'] as const) {
    if (condRaw[field] !== undefined) {
      if (typeof condRaw[field] !== 'string') throw new RecipeSchemaError(`conditions.${field} 必须是字符串`);
      conditions[field] = condRaw[field] as string;
    }
  }
  for (const field of ['noStack', 'noPoints', 'samePhoneBind'] as const) {
    if (condRaw[field] !== undefined) {
      if (typeof condRaw[field] !== 'boolean') throw new RecipeSchemaError(`conditions.${field} 必须是布尔值`);
      conditions[field] = condRaw[field] as boolean;
    }
  }
  if (condRaw.perUserLimit !== undefined) {
    const n = Number(condRaw.perUserLimit);
    if (!Number.isFinite(n) || n < 0) throw new RecipeSchemaError('conditions.perUserLimit 必须是非负数');
    conditions.perUserLimit = n;
  }

  const money = (v: unknown, field: string): number => {
    if (v === undefined) return opts.strict ? NaN : 0;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  };
  const priceCents = money(raw.priceCents, 'priceCents');
  const originalPriceCents = money(raw.originalPriceCents, 'originalPriceCents');
  if (!Number.isFinite(priceCents) || !Number.isFinite(originalPriceCents)) {
    throw new RecipeSchemaError('priceCents 和 originalPriceCents 必须是非负有限数');
  }

  const optionalText = (v: unknown, field: string, fallback: string): string => {
    if (v === undefined) return opts.strict ? '' : fallback;
    if (typeof v !== 'string' || !v.trim()) throw new RecipeSchemaError(`${field} 必须是非空字符串`);
    return v.trim();
  };
  const buyPath = optionalText(raw.buyPath, 'buyPath', '（以平台页面为准）');
  const redeemPath = optionalText(raw.redeemPath, 'redeemPath', '（以券面说明为准）');
  const evidence = optionalText(raw.evidence, 'evidence', '（证据待补充）');
  const verifiedAt = optionalText(raw.verifiedAt, 'verifiedAt', new Date().toISOString().slice(0, 10));
  const ruleVersion = optionalText(raw.ruleVersion, 'ruleVersion', 'manual-v1');
  if (opts.strict && !(buyPath && redeemPath && evidence && verifiedAt && ruleVersion)) {
    throw new RecipeSchemaError('buyPath、redeemPath、evidence、verifiedAt 和 ruleVersion 必填');
  }

  const matchNamesRaw = raw.matchNames === undefined ? [name] : raw.matchNames;
  if (!Array.isArray(matchNamesRaw) || !matchNamesRaw.every((x) => typeof x === 'string' && x.trim())) {
    throw new RecipeSchemaError('matchNames 必须是非空字符串数组');
  }

  const stringArray = (v: unknown, field: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim())) throw new RecipeSchemaError(`${field} 必须是字符串数组`);
    return (v as string[]).map((x) => x.trim());
  };

  let scope: VoucherRecipe['scope'];
  if (raw.scope !== undefined) {
    if (!isRecord(raw.scope)) throw new RecipeSchemaError('scope 结构无效');
    if (raw.scope.city !== undefined && typeof raw.scope.city !== 'string') throw new RecipeSchemaError('scope.city 必须是字符串');
    const stores = stringArray(raw.scope.stores, 'scope.stores');
    scope = { ...(typeof raw.scope.city === 'string' ? { city: raw.scope.city } : {}), ...(stores ? { stores } : {}) };
  }
  let binding: VoucherRecipe['binding'];
  if (raw.binding !== undefined) {
    if (!isRecord(raw.binding)) throw new RecipeSchemaError('binding 结构无效');
    if (raw.binding.comboCode !== undefined && typeof raw.binding.comboCode !== 'string') throw new RecipeSchemaError('binding.comboCode 必须是字符串');
    const roundIds = stringArray(raw.binding.roundIds, 'binding.roundIds');
    binding = { ...(typeof raw.binding.comboCode === 'string' ? { comboCode: raw.binding.comboCode } : {}), ...(roundIds ? { roundIds } : {}) };
  }

  for (const field of ['productViewSign', 'skuViewId'] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') throw new RecipeSchemaError(`${field} 必须是字符串`);
  }
  const headUrl = raw.headUrl;
  if (headUrl !== undefined && (typeof headUrl !== 'string' || !/^https?:\/\//i.test(headUrl))) {
    throw new RecipeSchemaError('headUrl 必须是 http(s) URL');
  }
  const productViewSigns = stringArray(raw.productViewSigns, 'productViewSigns');
  const skuViewIds = stringArray(raw.skuViewIds, 'skuViewIds');

  return {
    id, name,
    matchNames: (matchNamesRaw as string[]).map((x) => x.trim()),
    resolve, channel, channelLabel,
    items, conditions, priceCents, originalPriceCents,
    buyPath, redeemPath, evidence, verifiedAt, ruleVersion,
    source: raw.source === 'preset' ? 'user' : raw.source === 'imported' ? 'imported' : 'user',
    ...(typeof raw.productViewSign === 'string' ? { productViewSign: raw.productViewSign.trim() } : {}),
    ...(typeof raw.skuViewId === 'string' ? { skuViewId: raw.skuViewId.trim() } : {}),
    ...(productViewSigns ? { productViewSigns } : {}),
    ...(skuViewIds ? { skuViewIds } : {}),
    ...(typeof headUrl === 'string' ? { headUrl } : {}),
    ...(scope ? { scope } : {}), ...(binding ? { binding } : {}),
    ...(isRecord(raw.seedMeta) ? { seedMeta: raw.seedMeta as NonNullable<VoucherRecipe['seedMeta']> } : {}),
  };
}
