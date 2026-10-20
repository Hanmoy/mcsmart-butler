// 美团联盟 CPS_OPEN 客户端（TS 内置版）：本项目独立接入的协议实现层。
// 协议（与官方文档一致，已实测）：https://media.meituan.com
//   网关  : /cps_open/common/api/v1
//   签名  : 阿里云 API 网关 S-Ca——HMAC-SHA256(appsecret, StringToSign) → base64
//           StringToSign = "POST\n{Content-MD5}\nS-Ca-App:{appkey}\nS-Ca-Timestamp:{ms}\n{path}"
//   头    : S-Ca-App / S-Ca-Timestamp / S-Ca-Signature / S-Ca-Signature-Headers / Content-MD5
//   接口  : query_coupon（商品查询）/ get_referral_link（取链）
// 凭据（v1.1 独立接入）：本文件只做协议实现，不自行决定凭据来源；
//   调用方（unionCps）统一走 config 层 readCredentials()：env MEITUAN_UNION_* 优先，
//   其次用户数据目录 config.json 的 credentials 段。运行时不依赖任何外部 Skill。
// 推广合规（用户拍板）：不生成、不展示第三方归因短链——查询为只读，无推广无获利；
//   get_referral_link 仅供用户以自有凭据取链时使用。
import { createHmac, createHash } from 'node:crypto';

export const UNION_GATEWAY = 'https://media.meituan.com';
export const PATH_PRODUCT = '/cps_open/common/api/v1/query_coupon';
export const PATH_LINK = '/cps_open/common/api/v1/get_referral_link';

export interface UnionCredentials { appkey: string; appsecret: string; sid?: string }

/** env-only 凭据解析（保留给独立调用方；业务链路请用 unionCps.resolveIndependentUnionCredentials） */
export function resolveUnionCredentials(): UnionCredentials | null {
  const appkey = process.env.MEITUAN_UNION_APPKEY?.trim();
  const appsecret = process.env.MEITUAN_UNION_APPSECRET?.trim();
  if (!appkey || !appsecret) return null;
  return { appkey, appsecret, sid: process.env.MEITUAN_UNION_SID?.trim() || undefined };
}

/** S-Ca 签名（与 skill 版 sign_sca 逐字节一致：头块按字母序、尾接 path） */
export function signSca(appsecret: string, appkey: string, tsMs: string, contentMd5: string, path: string): string {
  const headBlock = `S-Ca-App:${appkey}\nS-Ca-Timestamp:${tsMs}\n`;
  const stringToSign = `POST\n${contentMd5}\n${headBlock}${path}`;
  return createHmac('sha256', appsecret).update(stringToSign, 'utf-8').digest('base64');
}

export function buildHeaders(cred: UnionCredentials, bodyStr: string, path: string, tsMs = String(Date.now())): Record<string, string> {
  const contentMd5 = createHash('md5').update(bodyStr, 'utf-8').digest('base64');
  return {
    'S-Ca-App': cred.appkey,
    'S-Ca-Timestamp': tsMs,
    'S-Ca-Signature': signSca(cred.appsecret, cred.appkey, tsMs, contentMd5, path),
    'S-Ca-Signature-Headers': 'S-Ca-App,S-Ca-Timestamp',
    'Content-MD5': contentMd5,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(cred.sid ? { 'S-Ca-Request-Id': `${cred.sid}-${tsMs}` } : {}),
  };
}

export interface Transport { (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; json: unknown; headers?: Record<string, string> }> }

const defaultTransport: Transport = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  let json: unknown = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json, headers: Object.fromEntries(r.headers.entries()) };
};

/** POST 到 CPS_OPEN 网关（轻量重试：429/5xx 各一次，指数退避） */
export async function apiPost(cred: UnionCredentials, path: string, body: Record<string, unknown>, transport: Transport = defaultTransport): Promise<Record<string, unknown>> {
  const bodyStr = JSON.stringify(body);
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, json, headers } = await transport(UNION_GATEWAY + path, {
      method: 'POST', headers: buildHeaders(cred, bodyStr, path), body: bodyStr,
    });
    lastStatus = status;
    if (status >= 200 && status < 300 && json && typeof json === 'object') return json as Record<string, unknown>;
    const retryable = status === 429 || (status >= 500 && status < 600);
    if (!retryable || attempt >= 1) {
      // 非 2xx：保留网关错误体（可能含业务 code），由调用方判读
      if (json && typeof json === 'object') return json as Record<string, unknown>;
      throw new Error(`CPS 网关 HTTP ${status}`);
    }
    const ra = headers?.['retry-after'];
    const delay = ra && /^\d+$/.test(ra) ? Math.max(500, Number(ra)) : 500 * (attempt + 1);
    await new Promise((r) => setTimeout(r, delay));
  }
  void lastStatus;
  throw new Error('CPS 网关请求失败');
}

export interface UnionDeal {
  /** 商品 productViewSign（取链用，A_B 段格式；与 skuViewId 是两个不同 ID——v1.3 起分开保留，绝不互相填充） */
  productViewSign: string;
  /** 商品 skuViewId（列表接口 couponPackDetail.skuViewId；历史字段，与 productViewSign 不同值） */
  skuViewId?: string;
  /** 券面主图（美团官方素材）：券面内容的可核验视觉证据（本项目不 OCR、不据此宣称已解析构成） */
  headUrl?: string;
  name: string;
  sellPrice: string;   // 元（字符串，接口原样）
  poiName: string;
  brand: string;
  /** 评审五轮：真实可用时间与规则（来源 query_coupon 结构化字段） */
  saleStart?: number;        // 售卖开始（Unix 秒）
  saleEnd?: number;          // 售卖结束（Unix 秒；过期团单不入池）
  saleStatus?: boolean;      // 在售状态
  validSTime?: number;       // 券有效期开始（绝对起止；Unix 秒；相对有效期券可能为 0）
  validETime?: number;       // 券有效期结束（绝对起止；相对有效期券可能为 0）
  validTimeType?: number;    // 1=购买后N天（相对有效期，绝对起止无意义）2=固定起止（以券面细则为准）
  couponValidDay?: number;   // v1.4.2：购买后 N 天（validTimeType=1 时的相对有效期天数；不得因绝对起止为 0 而误判过期）
  perUserLimit?: number;     // 真实单用户限购（purchaseLimitInfo，可缺省）
  availablePoiNum?: number;  // 适用门店数（全国范围；传经纬度/城市后=当地可用门店数）
}

/** query_coupon 多形态响应解析（与 skill 版 search_products_flat 同口径：无 productViewSign 丢弃）。
 *  v1.3 修正：productViewSign 与 skuViewId 分开取值（couponPackDetail.productViewSign 为准，
 *  缺失时回退顶层 productViewSign；skuViewId 独立保留——旧实现把 skuViewId 填进 productViewSign 字段）。 */
export function parseCouponItems(resp: Record<string, unknown>, limit: number): UnionDeal[] {
  let data = (resp?.data as unknown) ?? [];
  if (!Array.isArray(data)) data = [];
  const out: UnionDeal[] = [];
  for (const raw of (data as Array<Record<string, unknown>>).slice(0, limit)) {
    if (!raw || typeof raw !== 'object') continue;
    const cd = (raw.couponPackDetail ?? {}) as Record<string, unknown>;
    const ci = (raw.commissionInfo ?? {}) as Record<string, unknown>;
    const bi = (raw.brandInfo ?? {}) as Record<string, unknown>;
    const name = (cd.name ?? raw.name ?? raw.title ?? raw.productName) as string | undefined;
    // productViewSign（A_B 段）与 skuViewId（A 段）是两个不同标识，分别取、分别留。
    // v1.4.7 R07：**不再用 skuViewId 兜底 productViewSign**。旧实现 pvs 回退到 skuViewId，
    //   再把「相同的值」从 sku 字段省略 → 目录里出现伪造的完整身份（同一串 ID 同时冒充两种标识）。
    //   缺 productViewSign 的条目无法取链/核价，直接跳过（不伪造），skuViewId 仍单独保留。
    let pvs = (cd.productViewSign ?? raw.productViewSign) as string | string[] | undefined;
    if (Array.isArray(pvs)) pvs = pvs[0];
    let skuv = (cd.skuViewId ?? raw.skuViewId) as string | string[] | undefined;
    if (Array.isArray(skuv)) skuv = skuv[0];
    const price = (cd.sellPrice ?? raw.sellPrice ?? raw.price ?? raw.minPrice) as string | number | undefined;
    const poiName = (cd.poiName ?? raw.poiName ?? (bi as Record<string, unknown>)?.brandName ?? '') as string;
    if (!pvs || !name || price == null) continue;
    const vt = (raw.couponValidTimeInfo ?? {}) as Record<string, unknown>;
    const pl = (raw.purchaseLimitInfo ?? null) as Record<string, unknown> | null;
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const ap = (raw.availablePoiInfo ?? {}) as Record<string, unknown>;
    out.push({
      productViewSign: String(pvs),
      ...(skuv ? { skuViewId: String(skuv) } : {}),
      ...(typeof cd.headUrl === 'string' && cd.headUrl ? { headUrl: (cd.headUrl as string).split('@')[0] } : {}),
      name: String(name),
      sellPrice: String(price),
      poiName: String(poiName),
      brand: String(bi.brandName ?? '麦当劳'),
      saleStart: num(cd.startTime), saleEnd: num(cd.endTime), saleStatus: cd.saleStatus === true,
      validSTime: num(vt.couponValidSTime), validETime: num(vt.couponValidETime),
      validTimeType: num(vt.couponValidTimeType),
      couponValidDay: num(vt.couponValidDay),
      perUserLimit: pl ? num(pl.limitNum) ?? num(pl.perUserLimit) ?? num(pl.buyLimit) : undefined,
      availablePoiNum: num(ap.availablePoiNum),
    });
  }
  return out;
}

/** 搜索翻页游标（searchId 模式：同关键词同排序的下一页必须携带上次出参 searchId） */
export interface SearchPageMeta { hasNext: boolean; searchId?: string }

/** v1.4.10 W01：查询结果必须自带**范围与截断证据**。
 *  旧实现只返回数组，调用方无从知道「是全部就这些」还是「被 40/60 条上限截掉了」，
 *  于是「上海 12 页 232 条」被静默截成 40 条，漏召回无法察觉。 */
export interface UnionSearchResult {
  deals: UnionDeal[];
  /** 实际请求页数 */
  pages: number;
  /** 上游是否仍有下一页（false = 已取到目录末尾） */
  hasNext: boolean;
  /** 是否被客户端上限截断 */
  truncated: boolean;
  /** 截断原因（人可读） */
  truncatedReason?: string;
  /** 目录条数（去重后） */
  total: number;
}

/** 商品查询（到店团单：platform=2 到店 / bizLine=1 到餐）。
 *  业务错误码判读：CPS_OPEN 可能返回 HTTP 200 + body.code 非成功（如签名/凭据无效），
 *  此时 data 缺失——必须显式抛错，否则会被误读为「查询成功但 0 条」。
 *  v1.3 修正（官方文档 page.meituan.net 1701831807616 实测）：
 *    - cityId：搜索场景生效（美团城市字典 ID；不传经纬度时到店商品默认北京——必须显式传城市）；
 *    - longitude/latitude：×1e6 整型（与 cityId 二选一即可，都有则更准）；
 *    - sortField：搜索召回 1 综合 / 2 价格升序 / 6 离我最近（比价场景默认 2）；
 *    - 分页：searchId + pageNo 翻页（实测第 2 页与第 1 页零重叠），直到取满 limit 或 hasNext=false。
 *  v1.4.10 W01：`exhaustive: true` 时**取到 hasNext=false 为止**（完整发现目录），
 *   并返回 pages/hasNext/truncated/reason；默认（exhaustive=false）保持「取满 limit」的受控口径。 */
export async function searchProductsDetailed(
  cred: UnionCredentials,
  opts: {
    keyword: string; platform?: number; bizLine?: number; limit?: number;
    cityId?: string; loc?: { lat: number; lng: number };
    sortField?: 1 | 2 | 6; transport?: Transport;
    /** 取完目录（不按 limit 提前返回）；仍有安全页数上限 MAX_PAGES */
    exhaustive?: boolean;
  },
): Promise<UnionSearchResult> {
  const exhaustive = opts.exhaustive === true;
  const limit = exhaustive ? Number.POSITIVE_INFINITY : Math.min(Math.max(opts.limit ?? 20, 5), 60);
  const pageSize = 20;                                             // 接口默认分页大小（文档：不填返回 20）
  // 安全上限：完整目录也最多 40 页（800 条），超出如实标记 truncated
  const MAX_PAGES = 40;
  const body: Record<string, unknown> = {
    pageNo: 1, pageSize,
    sortField: opts.sortField ?? 2, ascDescOrder: 1,               // 比价召回 = 价格升序（旧实现固定 1=综合）
    searchText: opts.keyword,
  };
  if (opts.platform != null) body.platform = opts.platform;
  if (opts.bizLine != null) body.bizLine = opts.bizLine;
  if (opts.cityId) body.cityId = opts.cityId;
  if (opts.loc) { body.latitude = Math.round(opts.loc.lat * 1e6); body.longitude = Math.round(opts.loc.lng * 1e6); }

  const out: UnionDeal[] = [];
  const seen = new Set<string>();
  let searchId: string | undefined;
  let pages = 0;
  let hasNext = false;
  let truncated = false;
  let truncatedReason: string | undefined;
  // 实测（2026-10-14 真实联网）：searchId 翻页在页界处会重置排序（第 1 页末 19.9 → 第 2 页首 11.9），
  // 上游仅保证单页内有序——价格升序召回在客户端聚合后统一排序（含提前取满的返回路径）。
  const sortIfPrice = (): void => {
    if ((opts.sortField ?? 2) === 2) out.sort((a, b) => parseFloat(a.sellPrice) - parseFloat(b.sellPrice));
  };
  const maxPages = exhaustive ? MAX_PAGES : Math.ceil(limit / pageSize);
  for (let page = 1; page <= maxPages; page++) {
    const pageBody: Record<string, unknown> = { ...body, pageNo: page };
    if (searchId) pageBody.searchId = searchId;
    const resp = await apiPost(cred, PATH_PRODUCT, pageBody, opts.transport);
    pages = page;
    // v1.4.7 R16：先判业务状态，再看数据形态。旧实现「有 data 数组就跳过错误码判读」——
    //   HTTP 200 + {code:401,data:[]} 被当成「查询成功但 0 条」，进而可能触发「本次 0 条」的误删/误刷新。
    const bizCode = (resp as { code?: unknown }).code;
    if (bizCode !== undefined) {
      const okValues = [0, 200, '0', '200', 'success'];
      if (!okValues.includes(bizCode as never)) {
        const msg = String((resp as { message?: unknown }).message ?? '').slice(0, 120);
        throw new Error(`联盟业务错误 code=${JSON.stringify(bizCode)}${msg ? `：${msg}` : ''}`);
      }
    }
    if (!Array.isArray((resp as { data?: unknown }).data)) {
      // 无 data 字段且无成功业务码 → 响应结构异常，按渠道失败处理（不得视为 0 条成功）
      throw new Error('联盟响应缺少 data 数组（按渠道失败处理，不刷新成功时间戳）');
    }
    const meta: SearchPageMeta = {
      hasNext: resp.hasNext === true,
      ...(typeof resp.searchId === 'string' && resp.searchId ? { searchId: resp.searchId } : {}),
    };
    hasNext = meta.hasNext;
    for (const d of parseCouponItems(resp, pageSize)) {
      if (seen.has(d.productViewSign)) continue;
      seen.add(d.productViewSign);
      out.push(d);
      if (!exhaustive && out.length >= limit) {
        sortIfPrice();
        return {
          deals: out, pages, hasNext: true, truncated: true,
          truncatedReason: `按查询上限 ${limit} 条提前停止（上游仍有下一页）`, total: out.length,
        };
      }
    }
    if (!meta.hasNext || !meta.searchId) { hasNext = false; break; }   // 无游标/无下一页 → 停止（避免 pageNo 裸翻页重复）
    searchId = meta.searchId;
  }
  if (exhaustive && hasNext) {
    truncated = true;
    truncatedReason = `已取 ${pages} 页（安全上限 ${MAX_PAGES} 页），上游仍报告有下一页`;
  }
  sortIfPrice();
  return { deals: out, pages, hasNext, truncated, ...(truncatedReason ? { truncatedReason } : {}), total: out.length };
}

/** 兼容包装：只返回团单数组（旧调用方契约不变）。 */
export async function searchProducts(
  cred: UnionCredentials,
  opts: {
    keyword: string; platform?: number; bizLine?: number; limit?: number;
    cityId?: string; loc?: { lat: number; lng: number };
    sortField?: 1 | 2 | 6; transport?: Transport;
  },
): Promise<UnionDeal[]> {
  return (await searchProductsDetailed(cred, opts)).deals;
}

/** 取归因链接（仅限用户以自有凭据调用；本项目默认不生成第三方归因短链）。
 *  v1.3 修正：referralLinkMap 在响应顶层（实测），不在 data 内；保留 data 内读取作为兼容回退。
 *  productViewSign 取链必须携带 platform/bizLine（业务类型标识）。 */
export async function getReferralLink(
  cred: UnionCredentials,
  opts: { productViewSign: string; platform?: number; bizLine?: number; linkTypes?: number[] },
  transport?: Transport,
): Promise<string | undefined> {
  const body: Record<string, unknown> = {
    productViewSign: opts.productViewSign,
    linkTypeList: opts.linkTypes ?? [1],
  };
  if (opts.platform != null) body.platform = opts.platform;
  if (opts.bizLine != null) body.bizLine = opts.bizLine;
  const resp = await apiPost(cred, PATH_LINK, body, transport);
  const map = ((resp as Record<string, unknown>).referralLinkMap
    ?? ((resp as Record<string, unknown>).data as Record<string, unknown> | undefined)?.referralLinkMap
    ?? {}) as Record<string, string>;
  const l = map['1'];
  return typeof l === 'string' && l.startsWith('http') ? l : undefined;
}
