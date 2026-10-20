// 本地产品目录（评审四轮，用户提议）：团单与门店菜单的慢变数据本地持久化
//   —— 拉取成功即 upsert（合并更新，lastSeen/firstSeen 追踪），拉取失败（打烊/接口降级）时用快照兜底；
//   团单价格与菜单价格均标注「最后观测」口径，核价权威仍是 calculate-price（打烊时明确降级提示）。
//   非食品不落目录；团单 contents 仅存白名单核验形态，未核验团单只存价格/名称作参考。
//
// Skill 化改造（读写分离）：
//   种子层 seedDataDir/catalog.json —— 随安装包分发的只读快照（首装兜底，永不回写）；
//   用户层 userHome/catalog.json    —— 运行期可写缓存（观测数据持续累积）。
//   读 = 用户层优先、种子层按店/团单兜底；写 = 只写用户层。升级替换安装目录不影响缓存。
import { join } from 'node:path';
import { getLayout, userHomePaths } from './paths.js';
import { CONFIG } from './config.js';
import { withUserFileLock } from './userFileLock.js';
import { fileStamp, readJsonFile, readJsonFileForWrite, writeJsonAtomic, UserStoreError } from './userStore.js';
import { isRecipeRevoked } from './revocations.js';
import { dealIdentityKey, dealSpecSignature } from './dealDetail.js';
import { periodOfDate, type MealPeriod } from './mealPeriod.js';
import type { MenuItem } from './menu.js';

const today = (): string => new Date().toISOString().slice(0, 10);

export interface CatalogMenuItem extends MenuItem {
  firstSeen: string;
  lastSeen: string;
  /** v1.4.8 R09：该品项被**实际观测到**的餐段集合（breakfast/regular）。
   *  早餐套餐（如「双层原味板烧鸡腿麦满分套餐」）名称/类目/标签都不含「早餐」，
   *  仅靠关键词无法识别；观测上下文是唯一可靠证据。只在早餐查询中出现过的品项，
   *  非早餐时段不得进入当前可购池（历史条目仍完整保留）。 */
  periods?: MealPeriod[];
}

export type { MealPeriod } from './mealPeriod.js';

export interface CatalogDeal {
  sign: string;
  name: string;
  priceCents: number;
  poiName: string;
  /** v1.4.3：商品 skuViewId（历史字段，与 sign/productViewSign 不同值；不互相填充） */
  skuViewId?: string;
  admitted: boolean;                    // 白名单核验（随心配 1+1）
  contents?: Array<{ mode: 'fixed' | 'choice' | 'combo-ref'; keyword: string; qty: number; comboName?: string }>;
  /** v1.3：逐项核验记录（S1 模式 / S2 官方同名 / 未核验细分原因+券面图）——保存时沿用，不再按券名重新判断 */
  verify?: {
    status: 'pattern-verified' | 'menu-verified' | 'unverified';
    reasonCode?: 'detail-unavailable' | 'spec-unmappable' | 'choice-range-unclear' | 'name-mismatch';
    reason?: string;
    comboCode?: string;
    /** v1.4：绑定的实际产品 code（combo-name 解析 / 随心配 SKU）与官方轮次 id——求解按此定位 */
    boundComboCode?: string;
    boundRoundIds?: string[];
    /** v1.4：规则版本 / 命中配方 id（缓存复用与可审计） */
    ruleVersion?: string;
    recipeId?: string;
    source?: 'recipe' | 'name-pattern' | 'official-menu';
    verifiedAt: string;
    /** v1.4：最近一次成功核验的日期与组成（本次查询失败时保留，避免覆盖为未核验） */
    lastSuccessAt?: string;
    lastSuccessContents?: Array<{ mode: 'fixed' | 'choice' | 'combo-ref'; keyword: string; qty: number; comboName?: string }>;
    /** v1.4：本次查询失败时间（与「最后成功核验」区分） */
    queryFailedAt?: string;
    headUrl?: string;
  };
  /** 评审五轮：真实可用时间与规则（query_coupon 结构化字段） */
  saleStart?: number;                   // 售卖开始（Unix 秒）
  saleEnd?: number;                     // 售卖结束
  saleStatus?: boolean;                 // 在售状态
  validSTime?: number;                  // 券有效期开始（购买后可用起止）
  validETime?: number;                  // 券有效期结束
  validTimeType?: number;               // 1=购买后N天 2=固定起止
  perUserLimit?: number;                // 真实单用户限购
  availablePoiNum?: number;             // 适用门店数
  /** v1.4：观测时的城市上下文（团单地域性；快照兜底按城市过滤，避免跨城市错误复用） */
  city?: string;
  /** v1.4.7 R14：逐城市价格观测。同一商品（sign）在不同城市的价格互不覆盖——
   *  旧实现只保留最后一次写入（先上海 ¥10 再合肥 ¥12 → 上海快照直接 0 条）。 */
  priceByCity?: Record<string, { priceCents: number; poiName?: string; lastSeen: string }>;
  firstSeen: string;
  lastSeen: string;
}

interface CatalogFile {
  menus: Record<string, { snapshotAt: string; items: CatalogMenuItem[] }>;
  deals: Record<string, CatalogDeal>;
  nutritionRows: Array<{ productName: string; energyKj: number; energyKcal: number; protein: number; fat: number; carbohydrate: number; sodium: number; calcium: number }>;
  updatedAt: string;
}

let seedCache: CatalogFile | null = null;
let userCache: CatalogFile | null = null;
let userStamp = '';
let seedProbed = false;
let dirty = false;

function seedFilePath(): string {
  return join(getLayout().seedDataDir, 'catalog.json');
}

function userFilePath(): string {
  return userHomePaths(getLayout()).catalogFile;
}

const emptyCatalog = (): CatalogFile => ({ menus: {}, deals: {}, nutritionRows: [], updatedAt: '' });

function parseFile(path: string): CatalogFile | null {
  const db = readJsonFile<CatalogFile>(path);
  if (!db || typeof db !== 'object' || Array.isArray(db)) return null;
  db.menus ??= {}; db.deals ??= {}; db.nutritionRows ??= [];
  return db;
}

/** 写入口专用：区分「不存在（可首建）」与「损坏/结构错误（拒绝覆盖）」。
 *  v1.4.8 R12：旧实现把两者都当空库，损坏 JSON 会被下一次保存整库覆盖。 */
function parseFileForWrite(path: string): CatalogFile | null {
  const raw = readJsonFileForWrite<unknown>(path, '产品目录');
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UserStoreError(path, 'shape', `产品目录结构无效（${path}）：顶层应为对象。为避免覆盖可恢复资料，本次保存已取消。`, 'E_STORAGE_CORRUPT');
  }
  const db = raw as CatalogFile;
  if (db.menus !== undefined && (typeof db.menus !== 'object' || db.menus === null || Array.isArray(db.menus))) {
    throw new UserStoreError(path, 'shape', `产品目录结构无效（${path}）：menus 应为对象。为避免覆盖可恢复资料，本次保存已取消。`, 'E_STORAGE_CORRUPT');
  }
  if (db.deals !== undefined && (typeof db.deals !== 'object' || db.deals === null || Array.isArray(db.deals))) {
    throw new UserStoreError(path, 'shape', `产品目录结构无效（${path}）：deals 应为对象。为避免覆盖可恢复资料，本次保存已取消。`, 'E_STORAGE_CORRUPT');
  }
  db.menus ??= {}; db.deals ??= {}; db.nutritionRows ??= [];
  return db;
}

function loadSeed(): CatalogFile {
  if (!seedProbed) { seedProbed = true; seedCache = parseFile(seedFilePath()) ?? emptyCatalog(); }
  return seedCache!;
}

/** 读取用户层（v1.4.7 R12）：按文件指纹（mtime+size）判断缓存是否过期。
 *  旧实现 `userCache ??=` 一旦读入就永不刷新——CLI/Agent 子进程写入的新团单，面板父进程读不到。 */
function loadUser(): CatalogFile {
  const path = userFilePath();
  const stamp = fileStamp(path);
  if (!userCache || stamp !== userStamp) {
    userCache = parseFile(path) ?? emptyCatalog();
    userStamp = stamp;
  }
  return userCache;
}

/** 写前重读（v1.4.4 R12）：把用户层缓存同步为磁盘最新版本，
 *  避免面板与 CLI 各持旧快照、互相整段覆盖对方写入的记录。
 *  v1.4.8 R12：损坏文件在这里抛 E_STORAGE_CORRUPT（写入口不得把损坏库当空库）。 */
function reloadUser(): CatalogFile {
  userCache = parseFileForWrite(userFilePath()) ?? emptyCatalog();
  userStamp = fileStamp(userFilePath());
  return userCache;
}

/** 变更入口：跨进程互斥 → 重读磁盘最新 → 变更 → 原子落盘（v1.4.4 R12） */
function mutateUser<T>(mutate: (user: CatalogFile) => T): T {
  return withUserFileLock(userFilePath(), () => {
    const user = reloadUser();
    const out = mutate(user);
    dirty = true;
    flush();
    return out;
  });
}

/** 合并只读视图：用户层字段优先，缺失部分回退种子层（按店/团单/营养表逐项兜底） */
function load(): CatalogFile {
  const user = loadUser();
  const seed = loadSeed();
  return {
    menus: { ...seed.menus, ...user.menus },
    deals: { ...seed.deals, ...user.deals },
    nutritionRows: user.nutritionRows.length > 0 ? user.nutritionRows : seed.nutritionRows,
    updatedAt: user.updatedAt || seed.updatedAt,
  };
}

/**
 * flush（v1.2 根因修复）：写用户层缓存本体。
 * 旧实现 upsert 改的是 load() 返回的临时合并视图，flush 写的却是另一份 userCache——
 * 所有保存静默丢失。现在 upsert 一律直接改 loadUser() 返回的本体，此处原子落盘：
 * 先写临时文件再 rename，避免写一半崩溃留下损坏 JSON。
 * v1.4.7 R13：落盘失败**抛错**（旧实现静默 catch → 调用方照常回「已保存」，重读后记录消失）。
 * 失败时保留 dirty，内存态仍可读；调用方必须把失败如实返回。
 */
function flush(): void {
  if (!dirty || !userCache) return;
  userCache.updatedAt = new Date().toISOString();
  const path = userFilePath();
  try {
    writeJsonAtomic(path, userCache);
    dirty = false;
    userStamp = fileStamp(path);
  } catch (e) {
    dirty = true; // 保留待重试标记
    throw e;
  }
}

const unionPeriods = (a?: MealPeriod[], b?: MealPeriod[]): MealPeriod[] => {
  const s = new Set<MealPeriod>([...(a ?? []), ...(b ?? [])]);
  return s.size > 0 ? [...s] : [];
};

const mergeItem = (oldIt: CatalogMenuItem | undefined, it: MenuItem, period: MealPeriod): CatalogMenuItem => ({
  ...it,
  firstSeen: oldIt?.firstSeen ?? today(),
  lastSeen: today(),
  periods: unionPeriods(oldIt?.periods, [period]),
});

/**
 * 菜单快照 upsert（v1.2 根因修复）：直接写用户层本体，合并基准 = 用户层现有 + 种子层同店兜底。
 * 按 code 合并（价格/解构随最新拉取更新，firstSeen 保留）；
 * 今天不在场的条目保留原观测时间——历史早餐等跨餐段品项不会因一次夜间更新被刷新成「今天可见」。
 * v1.4.8 R09：同时记录**观测餐段**（本次查询发生在早餐窗口还是常规时段），供当前可购池过滤。
 */
export function upsertMenuSnapshot(storeCode: string, items: MenuItem[], opts: { observedAt?: Date; period?: MealPeriod } = {}): void {
  const seedItems = loadSeed().menus[storeCode]?.items ?? [];
  // v1.4.9 N01：优先用调用方给出的目标餐段（预约查询可能不在「现在」的餐段里），
  //   否则按观测时刻推断——不能再用「现在几点」判断预约到 08:00 的那次采集。
  const period: MealPeriod = opts.period ?? periodOfDate(opts.observedAt ?? new Date());
  mutateUser((user) => {
    const byCode = new Map<string, CatalogMenuItem>();
    for (const it of [...seedItems, ...(user.menus[storeCode]?.items ?? [])]) byCode.set(it.code, it);
    const merged = new Map<string, CatalogMenuItem>();
    for (const it of items) {
      const oldIt = byCode.get(it.code);
      merged.set(it.code, mergeItem(oldIt, it, period));
    }
    for (const oldIt of byCode.values()) if (!merged.has(oldIt.code)) merged.set(oldIt.code, oldIt);
    user.menus[storeCode] = { snapshotAt: new Date().toISOString(), items: [...merged.values()] };
  });
}

export interface MenuSnapshotView {
  snapshotAt: string;
  items: MenuItem[];
  /** 目录中该门店历史观测条目总数 */
  total: number;
  /** 按观测时效剔除数（超出 menuSnapshotMaxAgeDays 窗口） */
  excludedStale: number;
  /** 按餐段剔除数（只在早餐观测到、当前不是早餐时段） */
  excludedOffPeriod: number;
  /** v1.4.8 R09：true = currentOnly 过滤后为空、**已回退完整历史快照**。
   *  仅为兼容旧字段保留：新实现不再回退（空池保持为空），该字段恒为 false。 */
  fellBackToFull: boolean;
  /** v1.4.8 R09：当前可购池为空的真实原因（stale=全部超出观测时效；off-period=全部非当前餐段；none=未空） */
  emptyReason?: 'stale' | 'off-period' | 'none';
}

const isBreakfastItem = (it: { category?: string; name?: string; tags?: string[] }): boolean =>
  /早餐/.test(it.category ?? '') || /早餐/.test(it.name ?? '') || (it.tags ?? []).some((t) => /早餐/.test(t));

/**
 * 门店菜单快照读取。currentOnly=true 时只保留「当前可买」口径的品项：
 *   1) 观测时效内（lastSeen 距今 ≤ CONFIG.menuSnapshotMaxAgeDays）；
 *   2) 餐段匹配：早餐专用品项在非早餐时段剔除。判定证据 = 名称/类目/标签含「早餐」
 *      **或**该品项只在早餐时段被观测到（periods 仅含 breakfast）——后者覆盖
 *      「双层原味板烧鸡腿麦满分套餐」这类名称/标签都不含「早餐」的早餐专属套餐。
 * v1.4.8 R09：过滤为空**不再回退完整历史快照**（旧实现让午餐池重新长出早餐品项，
 *   并把原因误报成「超出观测时效窗口」）。空池保持为空，由调用方给出可执行提示。
 */
export function menuSnapshot(storeCode: string, opts: { currentOnly?: boolean; now?: Date } = {}): MenuSnapshotView | null {
  const db = load();
  const snap = db.menus[storeCode];
  if (!snap || snap.items.length === 0) return null;
  const withSeen: Array<MenuItem & { firstSeen?: string; lastSeen?: string; periods?: MealPeriod[] }> = snap.items.map(({ firstSeen, lastSeen, periods, ...it }) => ({ ...it, firstSeen, lastSeen, periods }));
  const total = withSeen.length;
  if (!opts.currentOnly) {
    return { snapshotAt: snap.snapshotAt, items: withSeen, total, excludedStale: 0, excludedOffPeriod: 0, fellBackToFull: false, emptyReason: 'none' };
  }
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - CONFIG.menuSnapshotMaxAgeDays * 24 * 3600 * 1000;
  const breakfastNow = periodOfDate(now) === 'breakfast';
  let excludedStale = 0, excludedOffPeriod = 0;
  const filtered = withSeen.filter((it) => {
    const seenAt = it.lastSeen ? new Date(it.lastSeen).getTime() : 0;
    if (!seenAt || seenAt < cutoff) { excludedStale++; return false; }
    const periods = it.periods ?? [];
    const onlyBreakfast = periods.length > 0 && periods.every((p) => p === 'breakfast');
    if (!breakfastNow && (isBreakfastItem(it) || onlyBreakfast)) { excludedOffPeriod++; return false; }
    return true;
  });
  const emptyReason: MenuSnapshotView['emptyReason'] = filtered.length > 0
    ? 'none'
    : (excludedOffPeriod > 0 && excludedStale === 0 ? 'off-period' : 'stale');
  return { snapshotAt: snap.snapshotAt, items: filtered, total, excludedStale, excludedOffPeriod, fellBackToFull: false, emptyReason };
}

/** 当前代码认可的核验规则版本白名单（v1.4.2）。
 *  缓存继承前校验：旧成功核验所用规则版本已不在白名单（规则升级/语义变化）→ 不得静默复用。
 *  recipe 来源的 ruleVersion 由用户维护，不做白名单限制（见 contextCompatible）。 */
const KNOWN_VERIFY_RULE_VERSIONS: ReadonlySet<string> = new Set([
  'single-name-v1', 'combo-name-v1', '1plus1-v1',
]);

/** 「最后成功核验」可继承的最长时效（天）。超过即视为过期核验，不得静默继承。 */
const VERIFY_SUCCESS_MAX_AGE_DAYS = 30;

/** 核验成功记录是否在时效内（未来时间视为有效；无法解析视为过期） */
export function isVerifyFresh(verify: CatalogDeal['verify'] | undefined, nowMs: number = Date.now()): boolean {
  const at = verify?.lastSuccessAt ?? verify?.verifiedAt;
  if (!at) return false;
  const t = Date.parse(at.length === 10 ? `${at}T00:00:00Z` : at);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= VERIFY_SUCCESS_MAX_AGE_DAYS * 24 * 3600 * 1000;
}

export interface DealVerifyInput {
  name: string;
  /** 本次观测的城市上下文（团单地域性） */
  city?: string;
  /** 本次是否**实际执行**了核验（false = 停售/过期/异常价格等未核验路径，不写 queryFailedAt） */
  attempted?: boolean;
  verify?: CatalogDeal['verify'];
  contents?: CatalogDeal['contents'];
  /** v1.2 旧数据兼容：无 verify 记录时的准入标记（有 verify 时以核验状态为准） */
  admitted?: boolean;
}

export interface EffectiveDealState {
  verify?: CatalogDeal['verify'];
  contents?: CatalogDeal['contents'];
  admitted: boolean;
  /** true = 本次未核验但按明确策略沿用了既有成功核验（同上下文 + 时效内 + 规则未变） */
  inherited: boolean;
}

/** 继承既有成功核验前的上下文校验（v1.4.2）：
 *  商品身份 / 城市范围 / 规格规则签名（数量·打包语义）/ ruleVersion / 最后成功核验时效
 *  任一不一致 → 不得继承（区分「临时查询失败」与「内容或规则已变化」）。 */
function contextCompatible(old: CatalogDeal, incoming: DealVerifyInput): boolean {
  // 1) 商品身份（归一化券名）
  if (dealIdentityKey(old.name) !== dealIdentityKey(incoming.name)) return false;
  // 2) 城市/门店范围：两端都明确且不一致 → 跨上下文，不得继承
  if (old.city && incoming.city && old.city !== incoming.city) return false;
  // 3) 规格规则签名（数量语义 / 打包语义变化 → 旧组成不再匹配当前券面）
  if (dealSpecSignature(old.name) !== dealSpecSignature(incoming.name)) return false;
  // 4) ruleVersion：本次核验给出的规则版本与旧成功不一致 → 规则已变化
  const oldRv = old.verify?.ruleVersion;
  const newRv = incoming.verify?.ruleVersion;
  if (oldRv && newRv && oldRv !== newRv) return false;
  // 规则升级：旧成功所用规则版本已不在当前白名单（recipe 由用户维护，豁免）
  if (oldRv && old.verify?.source !== 'recipe' && !KNOWN_VERIFY_RULE_VERSIONS.has(oldRv)) return false;
  // 5) 最后成功核验时效
  if (!isVerifyFresh(old.verify)) return false;
  return true;
}

/** 合并「既有持久化核验」与「本次观测核验」→ 唯一的有效状态（响应与持久化共用，联网/断网口径一致）。 */
export function mergeDealVerification(old: CatalogDeal | undefined, incoming: DealVerifyInput): EffectiveDealState {
  const attempted = incoming.attempted ?? (incoming.verify != null);
  // 本次核验成功 → 直接采用并记为最后成功
  if (incoming.verify && incoming.verify.status !== 'unverified') {
    const record: CatalogDeal['verify'] = { ...incoming.verify, lastSuccessAt: incoming.verify.verifiedAt, lastSuccessContents: incoming.contents };
    // v1.4.4 R16：时效判定必须与「继承既有核验」路径同口径（统一实时 / 缓存 / 降级三路径状态）。
    //   记录里的 verifiedAt 是**内容证据日期**（配方核验日，或本次实时观测日）；查询成功不得刷新它。
    //   旧实现此处无条件 admitted=true → 2020 年核验的配方在线仍可解，而断网读同一记录却因
    //   isVerifyFresh 判否而不可解（同一记录两条路径结论相反）。
    if (!isVerifyFresh(record)) {
      return { verify: record, contents: incoming.contents, admitted: false, inherited: false };
    }
    return { verify: record, contents: incoming.contents, admitted: true, inherited: false };
  }
  // 本次未核验/失败：仅在上下文一致且时效内才沿用既有成功核验。
  // v1.4.7 R05：被用户明确撤销的配方核验**永不继承**——「再次核验失败」不得复活旧组成；
  //   只有一次新的成功核验（上面的分支）才能恢复。
  if (old?.verify?.recipeId && isRecipeRevoked(old.verify.recipeId)) {
    return { verify: incoming.verify, contents: incoming.contents, admitted: incoming.admitted ?? false, inherited: false };
  }
  const oldSuccess = old?.verify && old.verify.status !== 'unverified';
  if (old && oldSuccess && contextCompatible(old, incoming)) {
    const keep = old.verify!;
    return {
      verify: {
        ...keep,
        lastSuccessAt: keep.lastSuccessAt ?? keep.verifiedAt,
        lastSuccessContents: keep.lastSuccessContents ?? old.contents,
        ...(attempted ? { queryFailedAt: new Date().toISOString() } : {}),
        ...(incoming.verify?.headUrl ? { headUrl: incoming.verify.headUrl } : (keep.headUrl ? { headUrl: keep.headUrl } : {})),
      },
      contents: old.contents, admitted: true, inherited: true,
    };
  }
  // 本次未核验且无法沿用：保留调用方给出的准入标记（v1.2 旧数据兼容），否则视为未准入
  return { verify: incoming.verify, contents: incoming.contents, admitted: incoming.admitted ?? false, inherited: false };
}

/** 按 sign 读取团单（用户层优先、种子层兜底）——调用方在 upsert 前用同一基准做合并判断 */
export function dealBySign(sign: string): CatalogDeal | undefined {
  return loadUser().deals[sign] ?? loadSeed().deals[sign];
}

/** 团单 upsert（v1.2 根因修复：直接写用户层本体；sign 为键；价格/可用期随最新观测更新）。
 *  v1.4：核验缓存保留「最后成功核验」——本次查询失败（unverified）不覆盖既有已核验组成与准入状态。
 *  v1.4.2（R09）：继承前校验上下文（商品身份/城市/规格规则签名/ruleVersion/时效）；
 *    改名、规则变化、跨城、过期核验不得静默继承。合并判断与响应层共用 mergeDealVerification。 */
export function upsertDeals(
  deals: Array<Omit<CatalogDeal, 'firstSeen' | 'lastSeen'> & { verifyAttempted?: boolean }>,
): void {
  const seedDeals = loadSeed().deals;
  mutateUser((user) => {
    for (const d of deals) {
      const old = user.deals[d.sign] ?? seedDeals[d.sign];
      const { verifyAttempted, ...rest } = d;
      const eff = mergeDealVerification(old, {
        name: rest.name, city: rest.city, attempted: verifyAttempted,
        verify: rest.verify, contents: rest.contents, admitted: rest.admitted,
      });
      // v1.4.7 R14：城市价格观测分开留存——同 sign 跨城刷新不再互相覆盖。
      const priceByCity: NonNullable<CatalogDeal['priceByCity']> = { ...(old?.priceByCity ?? {}) };
      if (old && old.city && old.city !== rest.city && old.priceCents > 0) {
        priceByCity[old.city] = { priceCents: old.priceCents, ...(old.poiName ? { poiName: old.poiName } : {}), lastSeen: old.lastSeen };
      }
      if (rest.city && rest.priceCents > 0) {
        priceByCity[rest.city] = { priceCents: rest.priceCents, ...(rest.poiName ? { poiName: rest.poiName } : {}), lastSeen: today() };
      }
      // v1.4.7 R05：被撤销配方的核验已在 mergeDealVerification 中阻断（不再继承）；
      //   这里额外保证撤销记录的准入标记不因「本次未核验」被继承路径写回 true。
      const revoked = !!eff.verify?.recipeId && isRecipeRevoked(eff.verify.recipeId);
      user.deals[d.sign] = {
        ...rest,
        ...(Object.keys(priceByCity).length > 0 ? { priceByCity } : {}),
        verify: eff.verify,
        contents: eff.contents,
        admitted: revoked ? false : eff.admitted,
        firstSeen: old?.firstSeen ?? today(),
        lastSeen: today(),
      };
    }
  });
}

/** 团单快照：lastSeen 在 maxAgeDays 内的团单（打烊/接口降级时兜底；stale 标注由调用方按 lastSeen 处理）。默认窗口读配置 dealMaxAgeDays。
 *  v1.4.6 R09：指定城市时**只复用同城观测记录**。旧实现「无 city 的旧记录一律放行」，
 *    导致一条缺城市的 ¥15 记录同时进入上海与合肥的断网快照（跨城价格污染）。
 *    缺城市的旧记录仍保留在库中作为历史资料，但不再进入任何指定城市的自动候选。 */
export function dealsSnapshot(maxAgeDays?: number, city?: string): CatalogDeal[] {
  const window = maxAgeDays ?? CONFIG.dealMaxAgeDays;
  const db = load();
  const cutoff = Date.now() - window * 24 * 3600 * 1000;
  const cityKey = city?.trim();
  const out: CatalogDeal[] = [];
  for (const d of Object.values(db.deals)) {
    // 上下文绑定：指定城市时，只复用「同城观测」；城市未知的历史记录不参与该城市的自动候选
    if (cityKey && d.city !== cityKey) {
      // v1.4.7 R14：同 sign 的其它城市观测仍在 priceByCity 中——本城有观测就按本城价格复用
      const obs = d.priceByCity?.[cityKey];
      if (!obs) continue;
      if (new Date(obs.lastSeen).getTime() < cutoff) continue;
      out.push({
        ...d, city: cityKey, priceCents: obs.priceCents,
        ...(obs.poiName ? { poiName: obs.poiName } : {}),
        lastSeen: obs.lastSeen,
      });
      continue;
    }
    if (new Date(d.lastSeen).getTime() < cutoff) continue;
    out.push(d);
  }
  return out;
}

export function catalogStats(): { menuStores: number; deals: number } {
  const db = load();
  return { menuStores: Object.keys(db.menus).length, deals: Object.keys(db.deals).length };
}

/** 官方营养表快照（v1.2 根因修复：直接写用户层本体；全量静态数据，任意成功加载时刷新一次） */
export function upsertNutritionRows(rows: Array<{ productName: string; energyKj: number; energyKcal: number; protein: number; fat: number; carbohydrate: number; sodium: number; calcium: number }>): void {
  if (rows.length === 0) return;
  mutateUser((user) => { user.nutritionRows = rows; });
}

export function nutritionRowsSnapshot(): Array<{ productName: string; energyKj: number; energyKcal: number; protein: number; fat: number; carbohydrate: number; sodium: number; calcium: number }> {
  return load().nutritionRows ?? [];
}

/** doctor/诊断用：门店快照明细（代码 + 快照时间 + 条目数），如实呈现覆盖范围 */
export function menuStoreDetails(): Array<{ code: string; snapshotAt: string; items: number; source: 'user' | 'seed' }> {
  const user = loadUser();
  const seed = loadSeed();
  const codes = new Set([...Object.keys(seed.menus), ...Object.keys(user.menus)]);
  return [...codes].sort().map((code) => {
    const u = user.menus[code];
    if (u) return { code, snapshotAt: u.snapshotAt, items: u.items.length, source: 'user' as const };
    const s = seed.menus[code]!;
    return { code, snapshotAt: s.snapshotAt, items: s.items.length, source: 'seed' as const };
  });
}
