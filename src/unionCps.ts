// 层 A：美团联盟 CPS 实时团购券查询（第三轨 v2 的主力券发现层）
// 数据源：media.meituan.com/cps_open（美团联盟官方网关），S-Ca 签名见 unionClient.ts。
//
// 独立接入声明（v1.1）：本项目使用内置 TS 客户端直连联盟网关，
// **运行时不再读取、不再回退任何外部 Skill 的目录、脚本或其私有凭据**。
// 凭据分层（与麦当劳 Token 同一套 readCredentials()）：
//   1. 环境变量 MEITUAN_UNION_APPKEY / MEITUAN_UNION_APPSECRET（/ 可选 SID）；
//   2. 用户数据目录 config.json 的 credentials.meituanUnionAppkey / meituanUnionAppsecret；
//   3. 两者皆无 → 不查询实时团单（调用方降级本地团单库/预置知识库），绝不猜测凭据。
//
// v1.3 检索修正（官方文档 + 实测）：
//   - cityId：用户所选城市经 meituan-city-dict.json（官方城市字典 2025 预解析）换算；
//     到店商品不传城市/经纬度时默认北京——绝不静默用北京冒充当地（缺陷修复）；
//   - sortField=2 价格升序（比价召回口径；旧实现固定 1=综合排序）；
//   - 分页：searchId 翻页直到取满 limit 或 hasNext=false（旧实现固定第 1 页 20 条，
//     不能据此宣称「当地全部优惠」或「最低价」）；
//   - productViewSign 与 skuViewId 分开保留（两个不同 ID，绝不互相填充）。
//
// v1.3 逐项核验闭环（dealDetail.ts 承载）：
//   团购商品 → 券详情核验（S1 券名模式 / S2 官方同名套餐 combo-ref）→ 映射官方库 → 入池求解；
//   未核验项保留具体原因（详情未取得 / 规格无法匹配 / 任选范围不明确），不归成一句「明细未核验」；
//   核验结果随团单持久化（CatalogDeal.verify），保存时不再按券名白名单重新判断。
//
// 合规与诚实边界（docs/CPS_AND_AUTH_RESEARCH.md 追加 4 + docs/CPS_DETAIL_INVESTIGATION_v13.md）：
//   1. 「接口查询成功」≠「可参与求解」：排除原因逐单标注；未核验券仅展示价格与券面图，绝不猜测券内容；
//      v1.4.1「全部团购入池」：在售未核验团单全部保留为**价格候选**（查询/展示/按券面价购买），
//      自动比价与营养/禁忌/心愿计算仍仅限核验通过的券（需要具体食品、规格及任选范围）；
//   2. 查询为只读，无推广无获利；本项目不生成第三方归因短链；
//   3. 接口失败/超时 → 返回 null，调用方降级到团单库，不阻塞拼单主流程。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { upsertDeals, dealsSnapshot, dealBySign, mergeDealVerification, isVerifyFresh } from './catalog.js';
import { searchProductsDetailed, type UnionDeal, type UnionCredentials, type UnionSearchResult } from './unionClient.js';
import { readCredentials, CONFIG } from './config.js';
import { getLayout } from './paths.js';
import { verifyDealContents, unverifiedReasonText, meituanCityId, type DealVerifyRecord } from './dealDetail.js';
import { recipeFoodUnits } from './voucherRecipes.js';
import { isRecipeRevoked } from './revocations.js';
import { redeemWindowStatus } from './redeemWindow.js';
import { targetRedeemDate } from './orderContext.js';

export type { UnionDeal } from './unionClient.js';

export interface UnionQueryResult {
  deals: UnionDeal[];
  degraded: boolean;      // true = 接口不可用/超时，已降级
  degradeReason?: string;
}

/** 渠道来源：independent = 项目自带凭据（env/config.json/随包内置）直连联盟网关；none = 无凭据未查询 */
export type UnionSource = 'independent' | 'none';

/** 凭据来源细分（诊断/展示用，不含密钥本身） */
export type UnionCredentialSource = 'env' | 'config' | 'bundled' | 'none';

/** 「接口查询成功」≠「可参与求解」：排除原因逐类计数（诚实呈现渠道可用性） */
export interface UnionExclusionStats {
  queried: number;           // 接口返回团单数
  admitted: number;          // 可参与自动求解（核验通过 + 在售 + 有效期内）
  detailUnverified: number;  // 券面明细未核验（未通过 S1/S2 核验）→ 仅展示不求解
  saleEnded: number;         // 售卖期已结束 / 已停售
  validityExpired: number;   // 券有效期已过
  other: number;             // 其他（数据不完整等）
  /** 核验入池数量（S1 模式 + S2 官方同名） */
  menuVerified: number;
  /** v1.3：未核验原因细分计数（不归成一句「明细未核验」） */
  unverifiedReasons?: Partial<Record<'detail-unavailable' | 'spec-unmappable' | 'choice-range-unclear' | 'name-mismatch', number>>;
  /** v1.4.1「全部团购入池」：价格候选数（在售可购买、可按券面价直接买，但内容未核验不参与自动比价）＝ detailUnverified 同口径换算 */
  priceCandidates: number;
  /** v1.4.10 W01：**完整发现目录**与**受控求解池**分离的透明口径。
   *  旧实现把「查询上限 40 条」当成目录全集，上海实测 232 条被静默截断，漏召回无从察觉。 */
  discovery?: {
    total: number;          // 完整目录条数（去重后）
    pages: number;          // 实际请求页数
    hasNext: boolean;       // 上游是否仍有下一页
    truncated: boolean;     // 是否被客户端上限截断
    truncatedReason?: string;
    poolLimit: number;      // 受控求解池上限（逐条核验的成本约束）
    poolSize: number;       // 实际进入受控池的条数
    poolOverflow: number;   // 因超出池上限未参与核验的条数（在售、可按券面价购买）
  };
}

const EMPTY_STATS: UnionExclusionStats = { queried: 0, admitted: 0, detailUnverified: 0, saleEnded: 0, validityExpired: 0, other: 0, menuVerified: 0, priceCandidates: 0 };

/** 统一凭据读取：env 优先，其次用户数据目录 config.json 的 credentials 段（同一 readCredentials，与麦当劳 Token 同源） */
/**
 * 统一凭据读取（三级，前两级供用户覆盖/更换，末级开箱即用）：
 *   1. 环境变量 MEITUAN_UNION_APPKEY / APPSECRET（/ 可选 SID）；
 *   2. 用户数据目录 config.json 的 credentials.meituanUnionAppkey / Appsecret；
 *   3. 随包内置凭据 data/union-credentials.json
 *      （拆自公开发布的 meituan-assistant 内置联盟凭据：作者公开发布即授权安装用户使用；
 *        本项目只读比价、零收益、不生成推广短链——与原 skill 同一使用口径）。
 * 运行时不读取、不回退任何外部 Skill 的目录/脚本——仅此静态数据文件随包分发。
 */
export function resolveIndependentUnionCredentials(): { cred: UnionCredentials; source: UnionCredentialSource } | null {
  const envKey = (process.env.MEITUAN_UNION_APPKEY ?? '').trim();
  const envSecret = (process.env.MEITUAN_UNION_APPSECRET ?? '').trim();
  if (envKey && envSecret) {
    const sid = (process.env.MEITUAN_UNION_SID ?? '').trim();
    return { cred: { appkey: envKey, appsecret: envSecret, ...(sid ? { sid } : {}) }, source: 'env' };
  }
  const c = readCredentials();
  if (c.meituanUnionAppkey && c.meituanUnionAppsecret) {
    return { cred: { appkey: c.meituanUnionAppkey, appsecret: c.meituanUnionAppsecret, ...(c.meituanUnionSid ? { sid: c.meituanUnionSid } : {}) }, source: 'config' };
  }
  try {
    // 测试/CI 隔离开关：MCSMART_DISABLE_BUNDLED_UNION=1 时跳过随包内置凭据（模拟"无凭据降级"场景）
    if (process.env.MCSMART_DISABLE_BUNDLED_UNION === '1') return null;
    const p = join(getLayout().seedDataDir, 'union-credentials.json');
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as { appkey?: string; appsecret?: string; sid?: string };
      const ak = (raw.appkey ?? '').trim();
      const sec = (raw.appsecret ?? '').trim();
      if (ak && sec) {
        return { cred: { appkey: ak, appsecret: sec, ...((raw.sid ?? '').trim() ? { sid: raw.sid!.trim() } : {}) }, source: 'bundled' };
      }
    }
  } catch { /* 内置凭据缺失/损坏 → 无凭据降级 */ }
  return null;
}

// ---- 查询层 TTL 缓存（v1.3 性能轮）：90s 内同城市+同关键词直接复用，避免单人→拼单连续操作重复打接口 ----

const QUERY_TTL_MS = 90 * 1000;
const queryCache = new Map<string, { at: number; deals: UnionDeal[]; discovery?: UnionSearchResult }>();

function cacheKeyOf(cityId: string | undefined, keyword: string): string {
  return `${cityId ?? ''}|${keyword}`;
}

/**
 * 团单获取（独立接入版）：凭据三级来源（env > config.json > 随包内置），内置客户端直连联盟网关；
 * 检索参数：城市 cityId（用户所选城市，官方字典换算）+ 价格升序 + searchId 分页；
 * 无凭据/查询失败 → null（调用方走团单库兜底）。不回退任何外部 Skill 的运行时。
 */
async function obtainDeals(
  keyword: string,
  limit: number,
  city: string | undefined,
  opts: { exhaustive?: boolean } = {},
): Promise<{ deals: UnionDeal[] | null; source: UnionSource; error?: string; discovery?: UnionSearchResult }> {
  const resolved = resolveIndependentUnionCredentials();
  if (!resolved) return { deals: null, source: 'none', error: '无美团联盟凭据（env / config.json / 随包内置均未提供）' };
  const cityId = meituanCityId(city);
  const exhaustive = opts.exhaustive === true;
  const key = cacheKeyOf(cityId, keyword) + (exhaustive ? '|full' : `|${limit}`);
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.at < QUERY_TTL_MS) return { deals: hit.deals, source: 'independent', ...(hit.discovery ? { discovery: hit.discovery } : {}) };
  try {
    // 比价召回口径：价格升序（sortField=2）；城市上下文显式传递（缺失时该参数缺省——
    // 接口侧会默认北京，这里如实在诊断中标注「未传城市」而不是冒充当地）
    const res = await searchProductsDetailed(resolved.cred, {
      keyword, platform: 2, bizLine: 1, limit, exhaustive,
      ...(cityId ? { cityId } : {}),
      sortField: 2,
    });
    queryCache.set(key, { at: Date.now(), deals: res.deals, discovery: res });
    return { deals: res.deals, source: 'independent', discovery: res };
  } catch (e) {
    // 失败信息不含凭据；调用方降级团单库
    return { deals: null, source: 'independent', error: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) };
  }
}

/** 测试钩子：清空查询缓存（验收脚本用） */
export function _clearUnionQueryCache(): void {
  queryCache.clear();
}

/**
 * 券名 → 覆盖形态解析（保留兼容：旧白名单快速路径）。
 * v1.3：业务逻辑统一走 dealDetail.verifyDealContents（S1 模式/S2 同名核验/细分原因）；
 * 本函数仅供外部兼容调用。
 */
export function parseUnionDealShape(name: string): Array<{ mode: 'choice'; keyword: string; qty: number }> | null {
  const n = name.replace(/\s+/g, '');
  if (/随心配1\+1/.test(n)) {
    return [{ mode: 'choice', keyword: 'staple', qty: 1 }, { mode: 'choice', keyword: 'side', qty: 1 }];
  }
  return null;
}

/** 门店匹配提示：poiName 与 MCP 门店名的关联强度（仅展示标注，不做硬过滤）。
 *  v1.4.5 W06：不宣称「跨店通用」——适用门店未经平台数据核验，统一表述为「未校验」。 */
export function storeMatchNote(poiName: string, storeName?: string): string {
  if (!storeName) return '未校验具体适用门店（以下单页为准）';
  const core = poiName.replace(/麦当劳|[（）()]/g, '').trim();
  return storeName.includes(core) && core.length >= 2
    ? '示例门店与当前门店匹配（适用门店仍未校验）'
    : '未校验具体适用门店（示例门店非当前门店，以下单页为准）';
}

export interface UnionVoucherBuild {
  voucher: import('./vouchers.js').Voucher;
  solvable: boolean;             // 内容核验通过且在售有效，可参与覆盖求解
  /** v1.4.1「全部团购入池」：在售有效期内（可按券面价购买）＝价格候选；false=停售/过期/数据不完整 */
  purchasable?: boolean;
  storeNote: string;
  buyLink?: string;              // 官方 H5 购买短链（link 接口 type 1）
  verify?: DealVerifyRecord;     // v1.3：逐项核验记录（含未核验细分原因与券面图）
  /** v1.4.3：CPS 商品身份（供人工核验入口精确定位团单；三者互不填充，缺失即不写） */
  productViewSign?: string;      // 商品 productViewSign（A_B 段，取链/唯一标识）
  skuViewId?: string;            // 商品 skuViewId（历史字段，与 productViewSign 不同值）
  headUrl?: string;              // 券面主图（视觉证据；本项目不 OCR、不据此宣称已解析构成）
}

/** CPS 商品身份字段的集中提取（三处 build 共用；缺失即不写，绝不互相填充） */
function cpsIdentity(d: { productViewSign?: string; skuViewId?: string; headUrl?: string }): Pick<UnionVoucherBuild, 'productViewSign' | 'skuViewId' | 'headUrl'> {
  return {
    ...(d.productViewSign ? { productViewSign: d.productViewSign } : {}),
    ...(d.skuViewId ? { skuViewId: d.skuViewId } : {}),
    ...(d.headUrl ? { headUrl: d.headUrl } : {}),
  };
}

/** 团购 deal → Voucher（channel=meituan） */
function dealToVoucher(d: UnionDeal): import('./vouchers.js').Voucher {
  const priceCents = Math.round(parseFloat(d.sellPrice) * 100) || 0;
  return {
    id: `union-${d.productViewSign}`,
    channel: 'meituan', channelLabel: '美团团购（联盟实时）', kind: 'combo',
    name: d.name,
    priceCents, originalPriceCents: 0,
    items: [],
    constraints: { orderType: 'instore', noStack: true, noPoints: true,
      ...(d.perUserLimit ? { perUserLimit: d.perUserLimit } : {}),
      expireNote: '联盟实时在售团单，价格以下单页为准' },
    buyPath: '美团 App 搜索该团单名称购买（仅只读比价，本项目不生成推广短链）',
    redeemPath: '到店出示券码核销；或绑定麦当劳 APP 后自助点餐（以券面说明为准）',
    verifiedAt: new Date().toISOString().slice(0, 10),
    source: 'preset',
    evidence: `美团联盟 CPS 实时查询（cps_open query_coupon，查询日 ${new Date().toISOString().slice(0, 10)}，门店 ${d.poiName}）`,
    notes: [`门店：${d.poiName}`],
  };
}

/** 单条团单的排除归类（诚实区分「接口查到」与「可参与求解」）。
 *  v1.4.2（R08）：异常价格（0/null/非法）→ other 并**终止自动准入**；未开售/已停售归 saleEnded；
 *  有效期按 validTimeType 解释（相对有效期不因绝对起止为 0 而误判过期）。
 *  分类互斥：每条团单恰好落入 admitted / detailUnverified / saleEnded / validityExpired / other 之一。 */
function classifyDeal(d: UnionDeal, nowSec: number): 'admitted' | 'saleEnded' | 'validityExpired' | 'detailUnverified' | 'other' {
  if (!isPriceValid(d)) return 'other';               // 异常/无法归类的价格 → 终止自动准入
  if (!isOnSaleNow(d, nowSec)) return 'saleEnded';    // 未开售 / 已停售 / 售卖期已结束
  if (isValidityExpired(d, nowSec)) return 'validityExpired';
  return 'detailUnverified'; // 准入由核验记录决定（S1/S2 通过 → admitted）
}

/** 价格是否合法可用（售价缺失/非数字/≤0 → 异常，不得成为免费可解券） */
function isPriceValid(d: { sellPrice?: string }): boolean {
  if (d.sellPrice == null) return false;
  const p = parseFloat(d.sellPrice);
  return Number.isFinite(p) && p > 0;
}

/** 售卖期是否覆盖当前（未开售、已结束、已停售均不算「当前可购买」） */
function isOnSaleNow(d: { saleStart?: number; saleEnd?: number; saleStatus?: boolean }, nowSec: number): boolean {
  if (d.saleStatus === false) return false;
  if (d.saleStart != null && d.saleStart > nowSec) return false;  // 尚未开售
  if (d.saleEnd != null && d.saleEnd < nowSec) return false;      // 售卖期已结束
  return true;
}

/** 券有效期是否已过（validTimeType=1「购买后N天」为相对有效期，绝对起止可能为 0，不得据此判过期） */
function isValidityExpired(d: { validTimeType?: number; validETime?: number }, nowSec: number): boolean {
  if (d.validTimeType === 1) return false;
  return d.validETime != null && d.validETime > 0 && d.validETime < nowSec;
}

/** 当前是否可核销（区分「可购买」与「当前可核销」）：
 *  相对有效期（购买后 N 天）当前购买即可用；绝对起止须覆盖当前时点。
 *  v1.4.6 R08：叠加券面星期/餐段规则（「仅周二可核销」「早餐两件套」等）。
 *    旧实现只看日期区间 → 周六也会把周二券、晚间也会把早餐券当作当前可核销。 */
function isRedeemableNow(
  d: { name?: string; validTimeType?: number; validSTime?: number; validETime?: number },
  nowSec: number,
): boolean {
  if (d.validTimeType === 1) return redeemOk(d.name, nowSec);
  if (d.validETime != null && d.validETime > 0 && d.validETime < nowSec) return false; // 已过期
  if (d.validSTime != null && d.validSTime > 0 && d.validSTime > nowSec) return false; // 尚未到可用起期
  return redeemOk(d.name, nowSec);
}

/** 券面时段/星期判定（与内核 admission 共用同一函数，避免两处口径分叉） */
function redeemOk(name: string | undefined, nowSec: number): boolean {
  return redeemWindowStatus({ name: name ?? '' }, new Date(nowSec * 1000)).ok;
}

export interface FetchUnionResult {
  builds: UnionVoucherBuild[];
  dbUsed: boolean;
  dbCount: number;
  source: UnionSource;
  stats: UnionExclusionStats;
  /** 无凭据/查询失败的原因（诚实呈现；不含凭据信息） */
  unavailableReason?: string;
}

/** 本地团单库条目 → build（v1.3：沿用持久化核验记录，不再按券名白名单重新判断） */
function dbDealToBuild(d: import('./catalog.js').CatalogDeal, nowSec: number, redeemSec: number, when: 'now' | 'target', storeName: string | undefined, fmtDay: (sec?: number) => string, menu: import('./menu.js').MenuLoadResult): UnionVoucherBuild {
  const voucher = dealToVoucher({
    productViewSign: d.sign, name: d.name,
    sellPrice: (d.priceCents / 100).toFixed(2), poiName: d.poiName, brand: '麦当劳',
    ...(d.perUserLimit ? { perUserLimit: d.perUserLimit } : {}), // v1.4：降级重建不丢限购信息
    ...(d.verify?.headUrl ? { headUrl: d.verify.headUrl } : {}),
  } as UnionDeal);
  voucher.items = d.contents ?? [];
  voucher.verifiedAt = d.verify?.lastSuccessAt ?? d.lastSeen; // 按最后成功核验/观测日期标注新旧
  // v1.4：核验绑定随券下发（求解按实际套餐 code / 轮次 id 定位，不按菜单顺序猜）
  if (d.verify) {
    const comboCode = d.verify.boundComboCode ?? d.verify.comboCode;
    voucher.binding = {
      ...(comboCode ? { comboCode } : {}),
      ...(d.verify.boundRoundIds?.length ? { roundIds: d.verify.boundRoundIds } : {}),
      ...(d.verify.recipeId ? { recipeId: d.verify.recipeId } : {}),
      ...(d.verify.ruleVersion ? { ruleVersion: d.verify.ruleVersion } : {}),
    };
  }
  if (d.validSTime && d.validETime) voucher.notes = [...(voucher.notes ?? []), `券有效期 ${fmtDay(d.validSTime)} ~ ${fmtDay(d.validETime)}`];
  // v1.4.2（R08/R09）：区分「可购买」与「当前可核销」；相对有效期不因绝对起止为 0 误判过期；
  //   过期核验（超出时效）不得作为可解券。
  const onSale = isOnSaleNow(d, nowSec) && d.priceCents > 0;
  const expired = isValidityExpired(d, nowSec);
  // v1.4.11 W04：可购买按「现在」，可核销按「目标用餐时刻」——预约周二时不能用周一的券。
  const redeemable = isRedeemableNow(d, redeemSec);
  const redeemReason = redeemable ? null : (redeemWindowStatus({ name: d.name }, new Date(redeemSec * 1000), when).reason ?? '尚未到券可用期，目标时间不可核销');
  const unavailable = !onSale || expired;
  // 核验状态：优先持久化核验记录（须在时效内）；v1.2 旧数据无 verify 字段时沿用 admitted+contents 兼容口径
  const verified = d.verify
    ? (d.verify.status === 'pattern-verified' || d.verify.status === 'menu-verified') && isVerifyFresh(d.verify)
    : !!d.admitted && ((d.contents?.length ?? 0) >= 2 || (d.contents ?? []).some((it) => it.mode === 'combo-ref'));
  // v1.4 准入修正：按展开后食品单位数判定（combo-ref 单引用可代表多件套餐——不得用引用条数代替食品数量）；
  // v1.4.1「全部团购入池」：核验通过的单品券（展开食品 1 件）同样入池——1 件也是合法购买单元。
  const foodUnits = recipeFoodUnits(d.contents ?? [], menu);
  // v1.4.7 R05：被用户撤销的配方核验在断网/缓存路径同样不得复活
  const revokedRecipe = !!d.verify?.recipeId && isRecipeRevoked(d.verify.recipeId);
  const solvable = verified && foodUnits >= 1 && !unavailable && redeemable && !revokedRecipe;
  const staleVerify = !!d.verify && (d.verify.status === 'pattern-verified' || d.verify.status === 'menu-verified') && !isVerifyFresh(d.verify);
  const reasonText = revokedRecipe
    ? '关联配方已被用户删除/撤销，核验失效，需重新核验'
    : d.verify && d.verify.status === 'unverified' && d.verify.reason
    ? d.verify.reason
    : staleVerify ? '券面明细核验已过期，需重新核验' : '券面明细未核验（仅展示）';
  return {
    voucher, solvable,
    // v1.4.7 R15：可购买 = 在售 ∧ 券有效期未过。旧实现只看在售，已过固定有效期的记录
    //   仍标 purchasable=true（文案却写「不可购买」），随后被当作价格候选展示。
    purchasable: onSale && !expired,
    verify: d.verify as DealVerifyRecord | undefined,
    ...cpsIdentity({ productViewSign: d.sign, ...(d.verify?.headUrl ? { headUrl: d.verify.headUrl } : {}) }),
    storeNote: storeMatchNote(d.poiName, storeName)
      + '；来自本地团单库（最近观测 ' + d.lastSeen + (d.verify?.lastSuccessAt ? '，最后成功核验 ' + d.verify.lastSuccessAt : '') + '）'
      + (unavailable ? '；售卖期已结束或券有效期已过，暂不可购买' : '')
      + (!unavailable && !redeemable ? `；${redeemReason ?? '当前不可核销'}` : '')
      + (solvable ? '' : `；${reasonText}`),
  };
}

/**
 * 拉取麦当劳到店团购券并构造 Voucher 列表（独立接入版 + v1.3 逐项核验闭环）。
 * 流程：团购商品 → verifyDealContents（S1 模式/S2 官方同名 → 构成+核验记录）→ 映射官方库 → 入池。
 * 未核验项保留具体原因；核验记录随 upsertDeals 持久化（保存时不重判）。
 * 接口不可用时本地团单库（近 dealMaxAgeDays 天观测）兜底，沿用已持久化的核验记录。
 */
export async function fetchUnionMcDeals(
  client: import('./mcp.js').McpClient,
  storeCode: string,
  menu: import('./menu.js').MenuLoadResult,
  storeName?: string,
  opts: { city?: string } = {},
): Promise<FetchUnionResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  // v1.4.11 W04：目标核销时刻（预约单）与「现在」分离；即时口径两者相同。
  const targetDate = targetRedeemDate();
  const redeemSec = targetDate ? Math.floor(targetDate.getTime() / 1000) : nowSec;
  const fmtDay = (sec?: number): string => (sec ? new Date(sec * 1000).toISOString().slice(5, 10) : '');
  const stats: UnionExclusionStats = { ...EMPTY_STATS, unverifiedReasons: {} };
  const bumpUnverified = (code?: string): void => {
    if (!code) return;
    const key = code as keyof NonNullable<UnionExclusionStats['unverifiedReasons']>;
    const cur = stats.unverifiedReasons![key] ?? 0;
    stats.unverifiedReasons![key] = cur + 1;
  };

  const city = opts.city?.trim() || undefined;
  // v1.4.10 W01：发现层取满目录（不再用 40/60 条上限冒充全集），再切出受控求解池。
  const { deals, source, error, discovery } = await obtainDeals('麦当劳', CONFIG.unionSearchLimit, city, { exhaustive: true });
  if (deals === null) {
    // 接口不可用/无凭据：本地团单库兜底（最近观测窗口），沿用持久化核验记录。
    // stats 语义 = 实时接口查询结果；接口未成功时保持全零（兜底条目由 dbUsed/dbCount 承载，不混入 queried）
    const stats: UnionExclusionStats = { ...EMPTY_STATS, unverifiedReasons: {} };
    const dbDeals = dealsSnapshot(undefined, city);
    if (dbDeals.length > 0) {
      const dbBuilds = dbDeals.map((d) => dbDealToBuild(d, nowSec, redeemSec, targetDate ? 'target' : 'now', storeName, fmtDay, menu));
      for (const b of dbBuilds) {
        if (b.solvable) stats.admitted++; // 兜底口径下仅统计可解数，不计入 queried
      }
      return { builds: dbBuilds, dbUsed: true, dbCount: dbBuilds.length, source: 'none', stats, ...(error ? { unavailableReason: error } : {}) };
    }
    return { builds: [{ voucher: DEGRADED_MARKER, solvable: false, storeNote: '' }], dbUsed: false, dbCount: 0, source: 'none', stats: { ...EMPTY_STATS, unverifiedReasons: {} }, ...(error ? { unavailableReason: error } : {}) };
  }

  // ---- 完整发现目录 → 受控求解池（v1.4.10 W01）----
  // 逐条核验是逐单网络请求，必须有成本上限；但**上限之外的在售团单不得静默消失**：
  // 它们仍作为价格候选返回，并逐条写明「未参与本次求解」的原因。
  const poolLimit = Math.max(10, Math.min(200, CONFIG.unionSolvePoolLimit));
  const sortedAll = deals.slice().sort((a, b) => (parseFloat(a.sellPrice) || 0) - (parseFloat(b.sellPrice) || 0));
  const poolDeals = sortedAll.slice(0, poolLimit);
  const overflowDeals = sortedAll.slice(poolLimit);
  stats.discovery = {
    total: sortedAll.length,
    pages: discovery?.pages ?? 0,
    hasNext: discovery?.hasNext ?? false,
    truncated: discovery?.truncated ?? false,
    ...(discovery?.truncatedReason ? { truncatedReason: discovery.truncatedReason } : {}),
    poolLimit,
    poolSize: poolDeals.length,
    poolOverflow: overflowDeals.length,
  };

  const builds: UnionVoucherBuild[] = [];
  // 持久化行与响应 builds 共用同一合并判断（mergeDealVerification）——联网与断网口径一致（v1.4.2 R09）
  const upsertRows: Parameters<typeof upsertDeals>[0] = [];
  const validSummary = (dd: UnionDeal): string => {
    if (dd.validSTime && dd.validETime) return `券有效期 ${fmtDay(dd.validSTime)} ~ ${fmtDay(dd.validETime)}`;
    if (dd.validTimeType === 1) return '券有效期：购买后 N 天内（以券面为准）';
    return '';
  };
  const baseRow = (d: UnionDeal): Omit<Parameters<typeof upsertDeals>[0][number], 'verify' | 'contents' | 'admitted' | 'verifyAttempted'> => ({
    sign: d.productViewSign,
    name: d.name,
    priceCents: Math.round(parseFloat(d.sellPrice) * 100) || 0,
    poiName: d.poiName,
    ...(d.skuViewId ? { skuViewId: d.skuViewId } : {}), // v1.4.3：skuViewId 独立保留（≠ productViewSign）
    // v1.4：适用上下文（城市/门店范围）随团单持久化，避免跨上下文错误复用
    ...(city ? { city } : {}),
    saleStart: d.saleStart, saleEnd: d.saleEnd, saleStatus: d.saleStatus,
    validSTime: d.validSTime, validETime: d.validETime, validTimeType: d.validTimeType,
    perUserLimit: d.perUserLimit, availablePoiNum: d.availablePoiNum,
  });

  // 池外团单：如实标记为「在售但未参与本次求解」，不核验、不入池、不隐藏
  for (const d of overflowDeals) {
    stats.queried++;
    const voucher = dealToVoucher(d);
    if (validSummary(d)) voucher.notes = [...(voucher.notes ?? []), validSummary(d)];
    builds.push({
      voucher, solvable: false, purchasable: isPriceValid(d) && isOnSaleNow(d, nowSec) && !isValidityExpired(d, nowSec),
      ...cpsIdentity(d),
      storeNote: storeMatchNote(d.poiName, storeName)
        + `；在售但未参与本次求解：完整目录共 ${sortedAll.length} 条，受控求解池按券面价升序取前 ${poolLimit} 条（可调 unionSolvePoolLimit）`,
    });
  }

  for (const d of poolDeals) {
    stats.queried++;
    const cls = classifyDeal(d, nowSec);
    const voucher = dealToVoucher(d);
    if (validSummary(d)) voucher.notes = [...(voucher.notes ?? []), validSummary(d)];
    const old = dealBySign(d.productViewSign);

    // 未开售/已停售/已过期/异常价格：**终止自动准入**（不核验、不入池）；分类计数互斥守恒
    if (cls === 'saleEnded' || cls === 'validityExpired' || cls === 'other') {
      if (cls === 'saleEnded') stats.saleEnded++;
      else if (cls === 'validityExpired') stats.validityExpired++;
      else stats.other++;
      // 未尝试核验：不写 queryFailedAt；仅在同上下文时沿用既有成功核验（不改准入）
      const eff = mergeDealVerification(old, { name: d.name, city, attempted: false });
      const note = cls === 'saleEnded' ? '；售卖期未覆盖当前（未开售/已停售/已结束），暂不可购买'
        : cls === 'validityExpired' ? '；券有效期已过，暂不可购买'
        : '；售价异常（0/缺失/非法），不纳入自动比价';
      builds.push({
        voucher, solvable: false, purchasable: false,
        ...cpsIdentity(d),
        ...(eff.verify ? { verify: eff.verify } : {}),
        storeNote: storeMatchNote(d.poiName, storeName) + note,
      });
      upsertRows.push({
        ...baseRow(d), admitted: eff.admitted, verifyAttempted: false,
        ...(eff.contents ? { contents: eff.contents } : {}), ...(eff.verify ? { verify: eff.verify } : {}),
      });
      continue;
    }

    // 逐项核验（v1.3）：S1 券名模式 → S2 官方同名套餐（combo-ref，保留任选范围）→ 细分原因
    const verify = await verifyDealContents(client, storeCode, d, menu, city);
    // v1.4.2（R09）：响应与持久化共用同一合并判断（同上下文瞬时失败可按策略沿用既有成功核验）
    const eff = mergeDealVerification(old, { name: d.name, city, attempted: true, verify, contents: verify.contents });
    // v1.4.4 R16：准入 = 「核验状态通过」∧「合并判定准入」。
    //   后者含内容证据时效（与降级路径 dbDealToBuild 的 isVerifyFresh 同口径）；
    //   只看 status 会把过期核验在实时路径当成可解，造成同一记录三路径状态不一致。
    const verifiedContent = !!eff.verify && eff.verify.status !== 'unverified';
    const staleEvidence = verifiedContent && !eff.admitted;
    const verifiedOk = verifiedContent && eff.admitted;
    // v1.4 准入修正：按「展开后的食品单位数」判定，不得用「引用条数」代替食品数量；
    // v1.4.1「全部团购入池」：核验通过的单品券（展开食品 1 件）同样入池——1 件也是合法购买单元。
    const foodUnits = recipeFoodUnits(eff.contents ?? [], menu);
    const redeemable = isRedeemableNow(d, redeemSec);   // v1.4.2（R08）：可购买 ≠ 可核销；v1.4.11 W04 按目标时刻
    const redeemReason = redeemable ? null : (redeemWindowStatus({ name: d.name }, new Date(redeemSec * 1000), targetDate ? 'target' : 'now').reason ?? '尚未到券可用期，目标时间不可核销');
    if (verifiedContent) {
      voucher.items = eff.contents!;
      const ev = eff.verify!;
      const comboCode = ev.boundComboCode ?? ev.comboCode;
      voucher.binding = {
        ...(comboCode ? { comboCode } : {}),
        ...(ev.boundRoundIds?.length ? { roundIds: ev.boundRoundIds } : {}),
        ...(ev.recipeId ? { recipeId: ev.recipeId } : {}),
        ...(ev.ruleVersion ? { ruleVersion: ev.ruleVersion } : {}),
      };
    }
    let solvable = false;
    if (verifiedOk && foodUnits >= 1 && redeemable) {
      solvable = true;
      stats.admitted++;
      stats.menuVerified++;
      const ev = eff.verify!;
      if (ev.source === 'official-menu' && ev.ruleVersion === 'single-name-v1')
        voucher.notes = [...(voucher.notes ?? []), `内容核验：券名与官方菜单同名单品一致，构成 = 该单品 ×${foodUnits}（官方菜单证据，零猜测）`];
      else if (ev.source === 'official-menu') voucher.notes = [...(voucher.notes ?? []), '内容核验：券名与官方菜单同名套餐完全一致，构成按官方套餐各轮次（含任选范围与默认项）计'];
      else if (ev.source === 'recipe') voucher.notes = [...(voucher.notes ?? []), `内容核验：命中券配方库（${ev.ruleVersion ?? 'recipe'}，核验 ${ev.verifiedAt}）`];
      else voucher.notes = [...(voucher.notes ?? []), '内容核验：券名即官方产品规则（随心配 1+1），红区/白区任选范围按官方 SKU 轮次计'];
      if (eff.inherited) voucher.notes = [...(voucher.notes ?? []), `本次详情未核验，沿用同上下文既有核验（最后成功 ${ev.lastSuccessAt ?? ev.verifiedAt}）`];
      voucher.evidence = `${voucher.evidence}；${ev.source === 'official-menu' ? (ev.ruleVersion === 'single-name-v1' ? '官方同名单品核验' : '官方同名套餐核验') : ev.source === 'recipe' ? '券配方库核验' : '券名模式核验'}（verify ${ev.verifiedAt}，展开食品 ${foodUnits} 件）`;
    } else {
      stats.detailUnverified++;
      if (eff.verify?.status === 'unverified') bumpUnverified(eff.verify.reasonCode);
      const reason = !redeemable
        ? (redeemReason ?? '当前不在券面可核销时段，暂不参与本次就餐求解')
        : staleEvidence ? '券面明细核验已过期，需重新核验'
        : unverifiedReasonText(eff.verify ?? verify);
      voucher.notes = [...(voucher.notes ?? []), `券面明细未核验：${reason}`];
    }
    builds.push({
      voucher, solvable, purchasable: true, verify: eff.verify ?? verify,
      ...cpsIdentity(d),
      storeNote: storeMatchNote(d.poiName, storeName)
        + (solvable ? '' : `；${redeemable ? (staleEvidence ? '券面明细核验已过期，需重新核验' : reasonText(eff.verify ?? verify)) : '尚未到券可用期，当前不可核销'}`),
    });
    upsertRows.push({
      ...baseRow(d), admitted: eff.admitted, verifyAttempted: true,
      ...(eff.contents ? { contents: eff.contents } : {}), ...(eff.verify ? { verify: eff.verify } : {}),
    });
  }
  // v1.4.1「全部团购入池」：在售但当前不可解的团单保留为价格候选（可查询 ≠ 可自动比价 ≠ 可核销）
  stats.priceCandidates = stats.detailUnverified;
  // 团单慢变数据本地化——拉取成功即入库（含可用期、真实限购与核验记录）。
  // v1.2 缺陷修复：保存时沿用本次核验结果；v1.4.2 继承前校验上下文（upsertDeals 内统一处理）
  upsertDeals(upsertRows);
  return { builds, dbUsed: false, dbCount: 0, source, stats };
}

function reasonText(v: DealVerifyRecord): string {
  return unverifiedReasonText(v);
}

/** 降级标记券：调用方识别后走预置知识库（不进求解） */
export const DEGRADED_MARKER: import('./vouchers.js').Voucher = {
  id: 'union-degraded', channel: 'meituan', channelLabel: '美团团购（联盟实时）', kind: 'cash',
  name: '（联盟接口本次不可用，已降级为预置知识库）',
  priceCents: 0, originalPriceCents: 0, items: [],
  constraints: { orderType: 'instore' },
  buyPath: '', redeemPath: '', verifiedAt: '1970-01-01', source: 'preset',
  evidence: 'degraded',
};
