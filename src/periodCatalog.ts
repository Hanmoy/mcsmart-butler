// 分时段产品目录与目标时段可售池（v1.4.9 N01）
//
// 需求（评审 N01）：不能只在「现在」查一次菜单就把早餐与午晚餐混成一个池子。
//   官方 `query-meals` 支持 `reservationDate`（`yyyy-MM-dd HH:mm`），因此可以按餐段锚点分别采集，
//   得到「门店 × 日期」的分时段目录，再按目标时段生成**独立**可售池。
//
// 三条硬边界（与评审口径一致）：
//   1. 目录存在 ≠ 目标时间可售：只有目标时段那次官方查询真实返回的商品才进池；
//   2. 查询失败/未知不复活：某餐段查询失败时，该餐段的品项一律「无法确认」，不得按历史推断可售；
//   3. 分时段价格不互相覆盖：同 code 在早餐与常规时段可能不同价，按餐段分别保留。
//
// 团购政策不变：本模块只处理官方菜单，不做券的具体适用门店校验。

import type { McpClient } from './mcp.js';
import { CONFIG } from './config.js';
import { collectMenuEntries, isComboMenuItem, type MenuItem } from './menu.js';
import { formatLocalDate, periodOfMinutes, type MealPeriod } from './mealPeriod.js';

export interface PeriodQueryResult {
  period: MealPeriod;
  /** 采集锚点 `HH:mm`（预约查询必须带具体时刻） */
  anchor: string;
  reservationDate: string;
  ok: boolean;
  itemCount: number;
  comboCount: number;
  error?: string;
}

export interface PeriodCatalogItem {
  code: string;
  name: string;
  category: string;
  categories: string[];
  tags: string[];
  isComboGuess: boolean;
  /** 分时段价格（分）：早餐与常规时段各自保留，不互相覆盖 */
  priceByPeriod: Partial<Record<MealPeriod, number>>;
  originalPriceByPeriod: Partial<Record<MealPeriod, number>>;
  /** 各餐段价格的来源锚点（审计：哪个时刻查到的） */
  priceAnchorByPeriod: Partial<Record<MealPeriod, string>>;
  /** 在哪些餐段的官方返回中出现过 */
  periods: MealPeriod[];
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface PeriodCatalog {
  storeCode: string;
  /** 目录所属日期 `yyyy-MM-dd` */
  date: string;
  fetchedAt: string;
  queries: PeriodQueryResult[];
  items: PeriodCatalogItem[];
  /** 各餐段可售条目数（按成功查询统计） */
  counts: Record<MealPeriod, number>;
  unionCount: number;
  note: string;
}

const periodOfAnchor = (anchor: string): MealPeriod => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(anchor.trim());
  if (!m) throw new Error(`餐段采集锚点「${anchor}」格式无效（需 HH:mm）`);
  return periodOfMinutes(Number(m[1]) * 60 + Number(m[2]));
};

const cache = new Map<string, { at: number; catalog: PeriodCatalog }>();
const cacheTtlMs = (): number => Math.max(1, CONFIG.periodCatalogTtlMin) * 60 * 1000;

/** 测试钩子：清空分时段目录缓存 */
export function _clearPeriodCatalogCache(): void { cache.clear(); }
/** 测试钩子：读取缓存键（审计缓存是否按「门店 + 日期」隔离） */
export function _periodCatalogCacheKeys(): string[] { return [...cache.keys()]; }

export interface CollectPeriodCatalogOptions {
  storeCode: string;
  /** 目录日期 `yyyy-MM-dd`；缺省为今天 */
  date?: string;
  /** 采集锚点（默认取配置 periodCatalogAnchors，如 08:00 / 12:00 / 18:00） */
  anchors?: string[];
  now?: Date;
  force?: boolean;
}

/**
 * 按餐段锚点采集门店分时段目录。
 * 单个锚点失败只记入 queries（ok=false），不影响其他餐段——失败餐段的可售性后续一律按「无法确认」处理。
 */
export async function collectPeriodCatalog(client: McpClient, opts: CollectPeriodCatalogOptions): Promise<PeriodCatalog> {
  const now = opts.now ?? new Date();
  const date = opts.date ?? formatLocalDate(now);
  const configured = CONFIG.periodCatalogAnchors.split(',').map((s) => s.trim()).filter(Boolean);
  const anchors = (opts.anchors && opts.anchors.length > 0 ? opts.anchors : configured).slice(0, 6);
  const key = `${opts.storeCode}:${date}:${anchors.join(',')}`;
  const hit = cache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < cacheTtlMs()) return hit.catalog;

  const queries: PeriodQueryResult[] = [];
  const byCode = new Map<string, PeriodCatalogItem>();
  // 每个餐段的可售条目数按 **code 去重**统计：同一餐段可能有多个采集锚点（12:00 / 18:00），
  // 直接把各锚点条数相加会把同一商品数两遍，虚报「该时段有 202 条」。
  const codeSets: Record<MealPeriod, Set<string>> = { breakfast: new Set(), regular: new Set() };

  for (const anchor of anchors) {
    const period = periodOfAnchor(anchor);
    const reservationDate = `${date} ${anchor}`;
    let ok = false;
    let itemCount = 0;
    let comboCount = 0;
    let error: string | undefined;
    try {
      const res = await client.call('query-meals', { storeCode: opts.storeCode, orderType: 1, beType: 1, reservationDate });
      const err = res as { code?: number; message?: string };
      if (err?.code === 600057 || /营业/.test(err?.message ?? '')) {
        throw new Error(`门店在该时段不在营业时间（数据源未返回菜单）`);
      }
      const data = res.data as { categories?: unknown; meals?: unknown };
      if (!data?.categories || !data?.meals) throw new Error('菜单数据结构异常');
      const entries = collectMenuEntries(data as Parameters<typeof collectMenuEntries>[0]);
      for (const entry of entries.values()) {
        if (RE_NONFOOD_SAFE.test(entry.name)) continue;
        itemCount++;
        const priceCents = Math.round(parseFloat(entry.currentPrice) * 100);
        const originalCents = Math.round(parseFloat(entry.originalPrice ?? entry.currentPrice) * 100);
        const combo = isComboMenuItem(entry.name, entry.tags);
        if (combo) comboCount++;
        const prev = byCode.get(entry.code);
        if (prev) {
          for (const c of entry.categories) if (!prev.categories.includes(c)) prev.categories.push(c);
          for (const t of entry.tags) if (!prev.tags.includes(t)) prev.tags.push(t);
          if (!prev.periods.includes(period)) prev.periods.push(period);
          prev.priceByPeriod[period] = priceCents;
          prev.originalPriceByPeriod[period] = originalCents;
          prev.priceAnchorByPeriod[period] = anchor;
          prev.isComboGuess = prev.isComboGuess || combo;
          prev.lastObservedAt = reservationDate;
        } else {
          byCode.set(entry.code, {
            code: entry.code,
            name: entry.name,
            category: entry.categories[0] ?? '',
            categories: [...entry.categories],
            tags: [...entry.tags],
            isComboGuess: combo,
            priceByPeriod: { [period]: priceCents },
            originalPriceByPeriod: { [period]: originalCents },
            priceAnchorByPeriod: { [period]: anchor },
            periods: [period],
            firstObservedAt: reservationDate,
            lastObservedAt: reservationDate,
          });
        }
      }
      ok = true;
      for (const code of entries.keys()) codeSets[period].add(code);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    queries.push({ period, anchor, reservationDate, ok, itemCount, comboCount, ...(error ? { error } : {}) });
  }

  const items = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  const counts: Record<MealPeriod, number> = { breakfast: codeSets.breakfast.size, regular: codeSets.regular.size };
  const okCount = queries.filter((q) => q.ok).length;
  const catalog: PeriodCatalog = {
    storeCode: opts.storeCode,
    date,
    fetchedAt: new Date().toISOString(),
    queries,
    items,
    counts,
    unionCount: items.length,
    note: `分时段目录：${date} 按 ${anchors.join(' / ')} 采集，成功 ${okCount}/${queries.length} 个锚点，`
      + `并集 ${items.length} 条（早餐 ${counts.breakfast}、常规 ${counts.regular}）。`
      + `目录存在不代表目标时间可售；价格按餐段分别保留，以官方下单页为准。`,
  };
  cache.set(key, { at: Date.now(), catalog });
  return catalog;
}

const RE_NONFOOD_SAFE = /玩具|餐具|礼品|袋子|包装盒|贴纸|卡片|盲盒/;

export interface PoolExclusion {
  code: string;
  name: string;
  reason: 'off-period' | 'unknown-period';
  detail: string;
}

export interface SellablePool {
  period: MealPeriod;
  reservationDate?: string;
  items: PeriodCatalogItem[];
  excluded: PoolExclusion[];
  /** 该餐段失败的查询（失败即「无法确认可售」） */
  failedQueries: PeriodQueryResult[];
  note: string;
}

/**
 * 生成目标时段可售池。
 * - 目标餐段查询成功 → 只收该餐段官方真实返回的商品；
 * - 目标餐段查询失败 → 全部标为「无法确认可售」，**不**按其他时段推断；
 * - 其他餐段专有商品 → off-period（不是「不存在」，而是「该时段不售」）。
 */
export function sellablePoolOf(catalog: PeriodCatalog, period: MealPeriod, opts: { reservationDate?: string } = {}): SellablePool {
  const failedQueries = catalog.queries.filter((q) => q.period === period && !q.ok);
  const poolOk = catalog.queries.some((q) => q.period === period && q.ok);
  const items: PeriodCatalogItem[] = [];
  const excluded: PoolExclusion[] = [];
  for (const it of catalog.items) {
    if (it.periods.includes(period)) { items.push(it); continue; }
    excluded.push(poolOk
      ? { code: it.code, name: it.name, reason: 'off-period', detail: `该时段官方查询未返回（只在 ${it.periods.join('/')} 观测到）` }
      : { code: it.code, name: it.name, reason: 'unknown-period', detail: '该时段官方查询失败，无法确认是否可售' });
  }
  const note = poolOk
    ? `${period === 'breakfast' ? '早餐' : '常规时段'}可售池 ${items.length} 条（官方该时段真实返回），剔除 ${excluded.length} 条非本时段商品。`
    : `${period === 'breakfast' ? '早餐' : '常规时段'}官方查询失败，本时段可售性无法确认（不以其他时段推断）。`;
  return { period, ...(opts.reservationDate ? { reservationDate: opts.reservationDate } : {}), items, excluded, failedQueries, note };
}

/** 逐商品遗漏账（评审 N01 第 5 条）：官方返回 → 时段归属 → 结构取得 → 营养可用 → 候选计划 → 实际选中 */
export interface LedgerRow {
  code: string;
  name: string;
  periods: MealPeriod[];
  priceCents?: number;
  /** 目标时段是否可售 */
  sellable: boolean;
  reason?: string;
  structure: 'ok' | 'unknown' | 'single' | 'not-expanded';
  nutrition: 'matched' | 'estimated' | 'unknown' | 'n/a';
  inPlans?: boolean;
  selected?: boolean;
}

export interface LedgerMenuFacts {
  isCombo: boolean;
  structureUnknown?: boolean;
  nutritionMatched: boolean;
  nutritionEstimated?: boolean;
}

export function buildOmissionLedger(
  catalog: PeriodCatalog,
  pool: SellablePool,
  opts: {
    menuFacts?: Map<string, LedgerMenuFacts>;
    planCodes?: Set<string>;
    selectedCodes?: Set<string>;
    /** 结构未取得时是否已进入拼单候选（structureUnknown 仍可购买但不得算覆盖） */
    coverageBlocked?: Set<string>;
  } = {},
): LedgerRow[] {
  const poolCodes = new Set(pool.items.map((i) => i.code));
  const excluded = new Map(pool.excluded.map((e) => [e.code, e]));
  return catalog.items.map((it) => {
    const facts = opts.menuFacts?.get(it.code);
    const structure: LedgerRow['structure'] = !facts ? 'not-expanded' : facts.isCombo ? (facts.structureUnknown ? 'unknown' : 'ok') : 'single';
    const nutrition: LedgerRow['nutrition'] = !facts ? 'n/a' : facts.nutritionMatched ? (facts.nutritionEstimated ? 'estimated' : 'matched') : 'unknown';
    const ex = excluded.get(it.code);
    const row: LedgerRow = {
      code: it.code,
      name: it.name,
      periods: [...it.periods],
      ...(it.priceByPeriod[pool.period] !== undefined ? { priceCents: it.priceByPeriod[pool.period] } : {}),
      sellable: poolCodes.has(it.code),
      structure,
      nutrition,
      ...(ex ? { reason: ex.detail } : {}),
      ...(opts.coverageBlocked?.has(it.code) ? { reason: '套餐结构未取得，可购买但不计心愿覆盖' } : {}),
    };
    if (opts.planCodes) row.inPlans = opts.planCodes.has(it.code);
    if (opts.selectedCodes) row.selected = opts.selectedCodes.has(it.code);
    return row;
  });
}

/** 求解侧逐商品审计（评审 N01 第 5 条的后半段）：官方返回 → 结构取得 → 营养可用 → 候选计划 → 实际选中。
 *  只进「高级数据管理 → 查询与候选诊断」，消费者页不展示技术大表。 */
export interface MenuAuditRow {
  code: string;
  name: string;
  isCombo: boolean;
  structure: 'ok' | 'unknown' | 'single';
  nutrition: 'matched' | 'estimated' | 'unknown';
  inPlans: boolean;
  selected: boolean;
  reason?: string;
}

export function buildMenuAudit(
  items: MenuItem[],
  opts: { planCodes: Set<string>; selectedCodes: Set<string>; structureBlocked?: Set<string> },
): MenuAuditRow[] {
  return items.map((it) => {
    const structure: MenuAuditRow['structure'] = it.isCombo ? (it.structureUnknown ? 'unknown' : 'ok') : 'single';
    const nutrition: MenuAuditRow['nutrition'] = it.nutritionMatched ? (it.nutritionEstimated ? 'estimated' : 'matched') : 'unknown';
    const inPlans = opts.planCodes.has(it.code);
    const selected = opts.selectedCodes.has(it.code);
    const reason = it.structureUnknown
      ? `套餐结构未取得（${it.structureIssue ?? '详情无轮次'}）：不参与心愿覆盖（无法证明构成），可在官方 App 单独购买`
      : !it.nutritionMatched
        ? '营养未联结（不计入营养达标证据）'
        : !inPlans
          ? '未进入候选计划（不满足成员约束或未被任何心愿命中）'
          : !selected ? '已入候选但本轮未选中（预算/覆盖更优方案优先）' : undefined;
    return { code: it.code, name: it.name, isCombo: it.isCombo, structure, nutrition, inPlans, selected, ...(reason ? { reason } : {}) };
  });
}
