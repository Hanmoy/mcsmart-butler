// 第三轨：全网合规渠道券包/团购增强轨（Omni-Voucher Track，PRD v1.3 §2.3.1-B）
// 技术方案：docs/VOUCHER_TRACK_DESIGN.md v1.0.1；市场证据：docs/COUPON_MARKET_RESEARCH.md
// 合规边界：
//   1. 只收录官方认可分销渠道（美团/抖音/银行/用户自持），拒绝代下单与券转售（PRD §1.2 Anti-Goals）；
//   2. 券价为知识库参考价（kb-reference）或用户自述价（user-claimed），不经 MCP 核验，
//      分账卡实付数字的唯一来源仍是 calculate-price（mcp-verified）；
//   3. 券购买/核销路径为纯文字指引：不做链接分发、不代购、不托管券码；
//   4. 明细未核验的券（items 为空）不参与自动求解，且前端不展示其购买路径（PRD 拍板③）。
import type { McpClient } from './mcp.js';
import type { MenuItem, MenuLoadResult } from './menu.js';
import type { NutritionRow } from './nutrition.js';
import {
  parseWishPhrase, findMenuItem, tabooHit, findSpecRow,
  solveGroupOrder, solveBundleTrack, loadComboSkus, norm,
  type GroupOrderInput, type GroupMember, type GroupSolution,
  type GroupMemberResult, type WishSpec, type ComboSkuInfo,
} from './group.js';
import { fetchUnionMcDeals } from './unionCps.js';
import { normSpecKey } from './foodIdentity.js';

// ---------- 类型定义 ----------

export type VoucherChannel = 'meituan' | 'dianping' | 'douyin' | 'bank' | 'owned';
export type VoucherKind = 'combo' | 'cash'; // combo=组合兑换券（可覆盖心愿）；cash=现金立减（仅支付提示，D7）
export type CostBasis = 'kb-reference' | 'user-claimed' | 'mcp-verified';

export interface VoucherItemRef {
  mode: 'fixed' | 'choice' | 'combo-ref';
  // fixed=固定品项（券面明确列出，qty 支持多份）；choice=品类任选（1+1 券的红区/白区，范围=官方 SKU 轮次）；
  // combo-ref=官方同名套餐整包引用（v1.3：券构成=官方套餐构成，保留各轮次【任选范围】而非仅默认项——
  // 固定槽与任选槽分别建模，不把官方默认选项直接当成券的全部内容）
  keyword: string;           // fixed: 品名关键词（如「麦辣鸡腿堡」）；choice: 品类 key（CHOICE_CATEGORIES）；combo-ref: 官方套餐 code
  qty: number;
  /** 逐项核验录入的商品规格（如「大」「中杯」）；官方实际营养/差价仍优先 */
  spec?: string;
  /** 券面声明的任选范围候选（保留证据描述，不替代官方 SKU 轮次） */
  choiceRange?: string[];
  /** 券面原文补差说明；求解应使用官方菜单 diffPrice */
  surcharge?: string;
  /** v1.4.5 W03：结构化逐选项补差（分；键=选项名或可唯一识别的简称）。优先于 surcharge 文本解析 */
  optionDiffs?: Record<string, number>;
  /** 官方履约 SKU code（与营养匹配标识分开保留） */
  fulfillCode?: string;
  /** combo-ref 专用：官方套餐名（展示/证据链） */
  comboName?: string;
}

export interface VoucherConstraints {
  orderType: 'instore' | 'delivery';
  timeWindow?: string;        // 适用时段展示（如「10:30-22:00」；时段硬校验未实测，仅提示不拦截）
  storeScope?: string;        // 门店范围说明（如「不含机场/景区/服务区门店」）
  noStack?: boolean;          // 不与其他优惠同享
  noPoints?: boolean;         // 用券消费不累积麦当劳积分
  samePhoneBind?: boolean;    // 需同手机号绑定官方 APP「到店券」核销（抖音券通路）
  perUserLimit?: number;      // 限购
  expireNote?: string;        // 有效期说明
}

export interface Voucher {
  id: string;
  channel: VoucherChannel;
  channelLabel: string;       // 展示名：「美团团购（到店）」「抖音生活服务」「银行立减」「本人自持」
  kind: VoucherKind;
  name: string;
  priceCents: number;         // 券售价（分）
  originalPriceCents: number; // 门市价（分），用于展示「省」
  items: VoucherItemRef[];    // 券内品项；kind='cash' 或明细未核验时为空数组（不参与求解）
  constraints: VoucherConstraints;
  buyPath: string;            // 购买路径（纯文字指引）
  redeemPath: string;         // 核销路径（纯文字指引）
  verifiedAt: string;         // 知识核验日期（ISO date），>KB_STALE_DAYS 天前端标「可能过期」
  source: 'preset' | 'user';
  evidence: string;           // 价格与内容的公开证据说明（README 可引用）
  notes?: string[];
  /** v1.4：核验绑定——combo-name 解析出的实际官方套餐 code + 官方轮次 id + 规则版本/配方 id。
   *  求解按此定位 SKU 与轮次（不再按「轮次数相同的第一个 SKU」猜，菜单顺序变化不得改变可选范围）；
   *  履约 code 与营养匹配标识分别保留，不互相替换。缺省时求解层走确定性品类对齐回退。 */
  binding?: { comboCode?: string; roundIds?: string[]; recipeId?: string; ruleVersion?: string };
}

/** 用户录入的自持兑换券（表单输入；现金立减请用成员 personalCouponCents，语义分离） */
export interface UserVoucherInput {
  channelLabel: string;       // 如「抖音」「美团」「本人购买」
  name: string;
  priceYuan: number;
  contentsText: string;       // 券内品项描述，顿号/加/空格分隔（如「巨无霸+中薯条+可乐」）
  storeScope?: string;
  expireNote?: string;
}

// ---------- 品类词表（D4：choice 条目按此匹配，显式可审计；随门店档期实测微调） ----------

export const CHOICE_CATEGORIES: Array<{ key: string; label: string; match: RegExp }> = [
  { key: 'staple',  label: '主食类', match: /堡|麦满分|卷|吉士蛋|巨无霸|板烧|麦香鱼|麦香鸡|安格斯/ },
  { key: 'side',    label: '小食类', match: /薯条|鸡翅|鸡排|麦乐鸡|派|玉米杯|沙拉|苹果片|鸡块/ },
  { key: 'drink',   label: '饮品类', match: /可乐|雪碧|冰茶|柠檬红茶|咖啡|奶铁|果汁|纯悦|牛奶/ },
  { key: 'dessert', label: '甜品冰淇淋类', match: /新地|旋风|圆筒|冰淇淋|雪冰/ },
  // 1+1 白区：小食/甜品/饮品混选（官方 1+1 的白区本就是跨品类任选）
  { key: 'white',   label: '白区任选（小食/甜品/饮品）', match: /薯条|鸡翅|鸡排|麦乐鸡|派|玉米杯|沙拉|苹果片|可乐|雪碧|冰茶|柠檬红茶|咖啡|奶铁|果汁|纯悦|牛奶|新地|旋风|圆筒|冰淇淋|雪冰/ },
];

export const KB_STALE_DAYS = 14; // 超过 14 天未核验 → 前端标「价格可能已变动」

// ---------- 预置券包知识库（只收录有公开证据的条目；每条带 evidence） ----------

export const PRESET_VOUCHERS: Voucher[] = [
  {
    id: 'kb-meituan-1plus1',
    channel: 'meituan', channelLabel: '美团团购（到店）', kind: 'combo',
    name: '随心配 1+1 套餐券（红区任选 1 + 白区任选 1）',
    priceCents: 1390, originalPriceCents: 1490,
    items: [
      { mode: 'choice', keyword: 'staple', qty: 1 },
      { mode: 'choice', keyword: 'white',   qty: 1 },
    ],
    constraints: { orderType: 'instore', noStack: true, noPoints: true, perUserLimit: 12, expireNote: '常驻团购，档期随平台更新' },
    buyPath: '美团/大众点评 APP 搜索「麦当劳」→ 门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示团购券码由店员核销；或绑定麦当劳 APP 后自助点餐（以券面说明为准）',
    verifiedAt: '2026-10-11', source: 'preset',
    evidence: '美团到店历史成交 ¥13.9（慢慢买/拔草哦聚合，COUPON_MARKET_RESEARCH [S2]）；官方 1+1 底价 ¥14.9、换选实测 ¥13.9——该券与官方换选同价，主要用于倒挂演示与跨店差价场景',
    notes: ['该券长期与官方随心配换选价持平，系统会自动提示「跨 App 无收益」'],
  },
  {
    id: 'kb-meituan-snack3',
    channel: 'meituan', channelLabel: '美团团购（到店）', kind: 'combo',
    name: '堡卷小食自由拼券（3 件自由组合）',
    priceCents: 2310, originalPriceCents: 3450,
    items: [
      { mode: 'choice', keyword: 'staple', qty: 1 },
      { mode: 'choice', keyword: 'side',   qty: 1 },
      { mode: 'choice', keyword: 'drink',  qty: 1 },
    ],
    constraints: { orderType: 'instore', noStack: true, noPoints: true, expireNote: '档期团购' },
    buyPath: '美团/大众点评 APP → 麦当劳门店团购页（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    verifiedAt: '2026-10-11', source: 'preset',
    evidence: '美团到店历史成交 ¥23.1（折 11.55/件，原价 34.5，慢慢买聚合 [S2]）；券内「3 件自由组合」为券名语义，组合范围未逐项核验，求解以品类词表命中为准',
  },
  {
    id: 'kb-meituan-duo-meal',
    channel: 'meituan', channelLabel: '美团团购（到店）', kind: 'combo',
    name: '月堡回归双人餐券',
    priceCents: 4690, originalPriceCents: 8050,
    items: [],
    constraints: { orderType: 'instore', noStack: true, expireNote: '档期团购' },
    buyPath: '美团/大众点评 APP → 麦当劳门店团购页（下单页价格与套餐明细为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    verifiedAt: '2026-10-11', source: 'preset',
    evidence: '美团到店历史成交 ¥46.9（原价 80.5，慢慢买聚合 [S2]）；券内品项明细未核验，不纳入自动比价，仅提示存在该渠道价',
  },
  // cash 型（D7）：随机金额/名额制，不进求解与成本公式，仅支付贴士
  {
    id: 'kb-bank-ceb-alipay',
    channel: 'bank', channelLabel: '银行立减（光大联名卡）', kind: 'cash',
    name: '周一支付宝消费满 40 随机立减 8-18 元',
    priceCents: 0, originalPriceCents: 0,
    items: [],
    constraints: { orderType: 'instore', noStack: true, perUserLimit: 2, expireNote: '银行活动轮换，以银行 App 实时页为准' },
    buyPath: '光大银行信用卡绑定支付宝 → 麦当劳门店/官方 APP/支付宝小程序支付时触发（名额制）',
    redeemPath: '支付时自动立减，无需领券',
    verifiedAt: '2026-10-11', source: 'preset',
    evidence: '光大银行麦当劳联名卡权益（阳光惠生活活动页/什么值得买 [S12]）；金额随机、名额有限，不可预知，故仅作支付提示',
  },
  {
    id: 'kb-bank-unionpay',
    channel: 'bank', channelLabel: '银行立减（银联云闪付）', kind: 'cash',
    name: '62 开头信用卡云闪付满 30-20/30-10（限量抢券）',
    priceCents: 0, originalPriceCents: 0,
    items: [],
    constraints: { orderType: 'instore', noStack: true, expireNote: '历史活动样例，各银行活动轮换，以银联/银行 App 为准' },
    buyPath: '银联云闪付 APP 抢券 → 指定门店云闪付 NFC 支付',
    redeemPath: '支付时自动立减',
    verifiedAt: '2026-10-11', source: 'preset',
    evidence: '银联历史活动（券妈妈 [S13]）；招行/工行/交行等同类立减按用户本地可得性录入（用户自持券通道）',
  },
];

// ---------- 用户自持券解析（表单 → Voucher；尽力而为，品项失配自然淘汰） ----------

export function parseUserVoucher(input: UserVoucherInput): Voucher {
  const priceCents = Math.round(Number(input.priceYuan) * 100);
  const parts = (input.contentsText ?? '').split(/[、+＋,，\s]+/).map((s) => s.trim()).filter(Boolean);
  return {
    id: `user-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    channel: 'owned', channelLabel: input.channelLabel?.trim() || '本人自持',
    kind: parts.length > 0 ? 'combo' : 'cash',
    name: input.name?.trim() || '用户自持券',
    priceCents: Number.isFinite(priceCents) && priceCents > 0 ? priceCents : 0,
    originalPriceCents: 0,
    items: parts.slice(0, 8).map((kw) => ({ mode: 'fixed' as const, keyword: kw, qty: 1 })),
    constraints: { orderType: 'instore', noStack: true, expireNote: input.expireNote, storeScope: input.storeScope },
    buyPath: '（本人已持有，无需购买）',
    redeemPath: '按券面说明核销；抖音/美团券可绑定麦当劳 APP「我的-到店券」自助点餐',
    verifiedAt: new Date().toISOString().slice(0, 10),
    source: 'user',
    evidence: `用户录入金额 ¥${(priceCents / 100).toFixed(2)}，按 user-claimed 口径参与比价`,
  };
}

// ---------- 匹配原语（D4：fixed 名称互含 / choice 品类词表，与轨道 2 matchChoice 同口径） ----------

/** fixed 条目：名称互含（norm 归一） */
function fixedMatchesName(ref: VoucherItemRef, name: string): boolean {
  const a = norm(ref.keyword), b = norm(name);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** 券条目 ↔ 菜单品项匹配 */
function itemMatchesMenuItem(ref: VoucherItemRef, it: MenuItem): boolean {
  if (ref.mode === 'choice') {
    const cat = CHOICE_CATEGORIES.find((c) => c.key === ref.keyword);
    if (!cat) return false;
    return cat.match.test(it.name) || cat.match.test(it.category);
  }
  return fixedMatchesName(ref, it.name);
}

/** 券条目 ↔ 1+1 换选 choice 名称匹配（fixed 名称互含 / choice 品类词表作用在 choice 名上） */
function itemMatchesChoiceName(ref: VoucherItemRef, choiceName: string): boolean {
  if (ref.mode === 'choice') {
    const cat = CHOICE_CATEGORIES.find((c) => c.key === ref.keyword);
    if (!cat) return false;
    return cat.match.test(choiceName);
  }
  return fixedMatchesName(ref, choiceName);
}

// ---------- 第三轨求解 ----------

interface ResolvedWish {
  memberIdx: number;
  alias: string;
  spec: WishSpec;
  hit: MenuItem;
  specRow: { row: NutritionRow; label: string } | null;
  kcal: number;
}

export interface VoucherBreakdown {
  selected: Array<{
    voucher: Voucher;
    coveredWishes: Array<{ alias: string; wish: string; itemName: string }>;
    basis: CostBasis;
    inverted?: { officialEquivalentCents: number; deltaCents: number }; // 券价 - 官方等效 ≥ 0 → 倒挂
  }>;
  candidateTips: Array<{ voucher: Voucher; reason: string }>;          // 未入选但值得知道的渠道价
  invertedWarnings: string[];                                          // 「切勿购买」避坑输出
  /** v1.4：逐券履约明细（遍历全部券购买记录；多券/多份券不再只取第一种）。
   *  保证 Σ(subtotalCents) + 官方部分 = 方案总价 = 分账合计。 */
  voucherParts?: Array<{
    voucherId: string;
    name: string;
    channelLabel: string;
    qty: number;                 // 该券购买份数（重复购买同券时如实计数）
    unitPriceCents: number;      // 单份券价
    subtotalCents: number;       // 该券费用（份数 × 单价 + 换选补差）
    surchargeCents: number;      // 换选补差合计
    config: Array<{ roundName: string; chosenName: string; count: number }>;
    redeemPath: string;
  }>;
  residualSource: 'bundle' | 'a-la-carte' | 'none';
  residualPaidCents: number;
  pointsNote: string;
}
export type VoucherTrackSolution = GroupSolution & {
  voucherBreakdown: VoucherBreakdown;
  decision: TrackWinner; // 单轨内预判定；三轨终判由 decideTrackWinner 输出
};
export type TrackWinner = 'official' | 'voucher' | 'tie-official';

const isStale = (v: Voucher): boolean =>
  Date.now() - new Date(v.verifiedAt).getTime() > KB_STALE_DAYS * 24 * 60 * 60 * 1000;

/**
 * 贪心覆盖（D1/D2/D8）：strict 完整承接 + 净省钱额最大。
 * 【PRD v1.3 拍板】MVP 单单限 1 张渠道大券——调用方只取 selected[0]（贪心首轮）；
 * 多券迭代能力保留在函数内，作为 P2 扩展开关。
 * 选券标准：净省钱额 = Σ(被覆盖心愿品项菜单原价) − 券价，降序；
 * 同分取覆盖心愿数多者，再取 verifiedAt 新者。
 */
function greedyCover(
  pool: ResolvedWish[],
  candidates: Voucher[],
): { selected: Array<{ voucher: Voucher; covered: Array<{ refIdx: number; wish: ResolvedWish }> }> } {
  const remaining = [...pool];
  const selected: Array<{ voucher: Voucher; covered: Array<{ refIdx: number; wish: ResolvedWish }> }> = [];
  for (;;) {
    let best: { voucher: Voucher; plan: Array<{ refIdx: number; wish: ResolvedWish }> } | null = null;
    let bestSaving = -1;   // 净省钱额（分）
    let bestCover = -1;    // tie-break 1：覆盖心愿数
    let bestAt = '';       // tie-break 2：核验日期（字符串比较即 ISO 日期序）
    for (const v of candidates) {
      if (selected.some((s) => s.voucher.id === v.id)) continue;
      // 每张券独立建消费池副本，尝试 strict 承接（qty 对齐）
      const local = [...remaining];
      const plan: Array<{ refIdx: number; wish: ResolvedWish }> = [];
      let feasible = true;
      for (let ri = 0; ri < v.items.length && feasible; ri++) {
        const ref = v.items[ri];
        for (let k = 0; k < ref.qty && feasible; k++) {
          const idx = local.findIndex((w) => itemMatchesMenuItem(ref, w.hit));
          if (idx < 0) { feasible = false; break; }   // D1 strict：任一 item 无心愿承接 → 该券不可选
          plan.push({ refIdx: ri, wish: local[idx] });
          local.splice(idx, 1);
        }
      }
      if (!feasible || plan.length < 2) continue;      // D2：覆盖 <2 心愿的券抵不过跨 App 摩擦
      const saving = plan.reduce((s, p) => s + p.wish.hit.priceCents * p.wish.spec.qty, 0) - v.priceCents;
      const newer = v.verifiedAt > bestAt;
      if (saving > bestSaving
        || (saving === bestSaving && plan.length > bestCover)
        || (saving === bestSaving && plan.length === bestCover && newer)) {
        bestSaving = saving; bestCover = plan.length; bestAt = v.verifiedAt;
        best = { voucher: v, plan };
      }
    }
    if (!best) break;
    for (const p of best.plan) {
      const i = remaining.indexOf(p.wish);
      if (i >= 0) remaining.splice(i, 1);
    }
    selected.push({ voucher: best.voucher, covered: best.plan });
  }
  return { selected };
}

/**
 * 券级倒挂检测（D5 / PRD v1.3；v1.4 同配修正）：
 *   以「用户实际选中的食品」为准（相同食品、数量、规格），不再另选更便宜的食品配置充当官方等效价。
 *   1) 若某官方套餐能以「完全相同配置」承接（每项选中食品各占一个轮次，按名称精确对应）
 *      → 等效价 = 套餐价 + 所选换选差价（即官方整单最优）；
 *   2) 否则 → 等效价 = 相同食品的官方单点原价合计（同配，无套餐优惠）。
 *   返回 0 = 无法完成同配核验（调用方不得据此给出「切勿购买」，仅提示「无价格优势/无法核验」）。
 * @deprecated v1.4.8 R05：本函数的比价对象由「已覆盖心愿」派生——未写进心愿的券内食品会被漏算，
 *   且 `norm()` 会删掉括号里的规格（中薯/小薯被视为同配）。请改用
 *   {@link officialEquivalentCentsForUnits}（以**实际购买单元**为准）。
 */
export function officialEquivalentCents(
  v: Voucher,
  covered: Array<{ refIdx: number; wish: ResolvedWish }>,
  skus: ComboSkuInfo[],
): number {
  const selected = covered.filter((c) => c.wish && c.wish.hit && typeof c.wish.hit.name === 'string' && c.wish.hit.name.length > 0);
  if (selected.length === 0) return 0; // 无同配可比对象 → 不可核验（禁止据零等效价判倒挂）
  // 1) 同配套餐（完全相同配置）
  for (const sku of skus) {
    if (sku.rounds.length < 2 || sku.rounds.length !== selected.length) continue;
    const used = new Set<number>();
    let ok = true;
    let total = sku.priceCents;
    for (const c of selected) {
      const name = norm(c.wish.hit.name);
      let ri = -1;
      for (let i = 0; i < sku.rounds.length; i++) {
        if (used.has(i)) continue;
        if (sku.rounds[i].choices.some((ch) => norm(ch.name) === name)) { ri = i; break; }
      }
      if (ri < 0) { ok = false; break; }
      used.add(ri);
      const choice = sku.rounds[ri].choices.find((ch) => norm(ch.name) === name);
      if (!choice) { ok = false; break; }
      total += choice.diffCents;
    }
    if (ok) return total; // 完全相同配置的官方等效价
  }
  // 2) 相同食品的官方单点原价合计（同配、同数量）
  return selected.reduce((s, c) => s + c.wish.hit.priceCents * (c.wish.spec?.qty ?? 1), 0);
}

// ---------- v1.4.8 R05：以「实际购买单元」为口径的同配比价 ----------

/** 实际购买单元：食品名 + 规格 + 份数 + 官方单点价（0 = 未知，无法核验） */
export interface OfficialEquivalentUnit {
  name: string;
  spec?: string;
  qty: number;
  officialUnitPriceCents: number;
}

/** 拆分「薯条（中份）」→ base=薯条 / spec=中；括号里的规格**不再被删掉**（R05 根因之一）。 */
function splitNameSpec(name: string): { base: string; spec: string } {
  const specs: string[] = [];
  const base = String(name ?? '').replace(/[（(【\[]([^）)】\]]*)[）)】\]]/g, (_m, inner: string) => {
    specs.push(inner);
    return '';
  });
  return { base: norm(base), spec: normSpecKey(specs.join('')) };
}

/** 同配判定：名称一致且规格一致。任一侧规格未知时**不**认作同配（中/小薯不得互换）。 */
function sameFoodUnit(choiceName: string, unitName: string, unitSpec?: string): boolean {
  const a = splitNameSpec(choiceName);
  const b = splitNameSpec(unitName);
  const spec = normSpecKey(unitSpec) || b.spec;
  if (a.base !== b.base) return false;
  if (!a.spec && !spec) return true;
  return a.spec === spec;
}

/**
 * 券级倒挂检测（v1.4.8 R05 重写）：比价对象 = 该券**实际购买的每一个食品单元**
 * （含未写进任何心愿的券内食品、含括号规格、含份数与券面补差）。
 *   1) 若某官方套餐能以完全相同的配置承接（轮次数 = 食品件数，逐件名称+规格对应）
 *      → 等效价 = 套餐价 + 对应换选差价；
 *   2) 否则 → 同配单点原价合计；
 *   3) 任一食品没有官方单点价 → 返回 0（不可核验，禁止据此下「切勿购买」结论）。
 */
export function officialEquivalentCentsForUnits(units: OfficialEquivalentUnit[], skus: ComboSkuInfo[]): number {
  const expanded: Array<{ name: string; spec: string; unit: number }> = [];
  for (const u of units) {
    const qty = Math.max(0, Math.round(Number(u.qty) || 0));
    if (qty <= 0) continue;
    const spec = normSpecKey(u.spec) || splitNameSpec(u.name).spec;
    for (let i = 0; i < qty; i++) expanded.push({ name: u.name, spec, unit: u.officialUnitPriceCents });
  }
  if (expanded.length === 0) return 0;
  // 1) 同配套餐（完全相同配置）
  for (const sku of skus) {
    if (sku.rounds.length < 2 || sku.rounds.length !== expanded.length) continue;
    const used = new Set<number>();
    let ok = true;
    let total = sku.priceCents;
    for (const e of expanded) {
      let ri = -1;
      for (let i = 0; i < sku.rounds.length; i++) {
        if (used.has(i)) continue;
        if (sku.rounds[i].choices.some((ch) => sameFoodUnit(ch.name, e.name, e.spec))) { ri = i; break; }
      }
      if (ri < 0) { ok = false; break; }
      used.add(ri);
      const choice = sku.rounds[ri].choices.find((ch) => sameFoodUnit(ch.name, e.name, e.spec));
      if (!choice) { ok = false; break; }
      total += choice.diffCents;
    }
    if (ok) return total;
  }
  // 2) 同配单点合计——任一食品缺官方价即不可核验（缺失 ≠ 0）
  if (expanded.some((e) => !(e.unit > 0))) return 0;
  return expanded.reduce((s, e) => s + e.unit, 0);
}

/** 倒挂/无优势提示文案（v1.4 同配口径）：
 *   - 同配同价 → 「无价格优势」（跨 App 无收益）；
 *   - 券价高于同配官方价 → 「切勿购买」；
 *   - 无法完成同配核验（equiv ≤ 0）→ 返回 null（不得凭空给避坑结论）。 */
export function invertedWarningText(
  channelLabel: string, name: string, priceCents: number, equivCents: number,
): string | null {
  if (!(equivCents > 0) || priceCents < equivCents) return null;
  const same = priceCents === equivCents;
  return same
    ? `⚠️ 无价格优势：${channelLabel}「${name}」券价 ¥${(priceCents / 100).toFixed(1)} 与官方同配置价 ¥${(equivCents / 100).toFixed(1)} 相同，跨 App 买券+绑定核销无收益。`
    : `⚠️ 避坑：${channelLabel}「${name}」券价 ¥${(priceCents / 100).toFixed(1)} 高于官方同配置价 ¥${(equivCents / 100).toFixed(1)}（官方渠道即可做到），切勿购买！`;
}

/** 动态阈值（PRD v1.3 拍板①）：3 元保底、按官方轨实付 3% 放大、8 元封顶 */
export function tieThresholdCents(track2PaidCents: number): number {
  return Math.min(Math.max(300, Math.round(track2PaidCents * 0.03)), 800);
}

/** 三轨决策标签（纯函数，可单测；PRD v1.3 双标签判定规则） */
export function decideTrackWinner(
  track2: GroupSolution | null,
  track3: VoucherTrackSolution | null,
): { winner: TrackWinner; label: string; reason: string; deltaCents: number; thresholdCents: number } | null {
  if (!track2 || !track3) return null;
  const delta = track2.totals.paidCents - track3.totals.paidCents;
  const T = tieThresholdCents(track2.totals.paidCents);
  if (delta >= 0 && delta <= T) {
    return {
      winner: 'tie-official',
      label: '极速省心方案（官方秒出餐，无跨 App 摩擦）',
      reason: `官方套壳 ¥${(track2.totals.paidCents / 100).toFixed(1)} 与券包方案 ¥${(track3.totals.paidCents / 100).toFixed(1)} 差价未超动态阈值 ¥${(T / 100).toFixed(1)}，不值得跨 App 买券+绑定核销`,
      deltaCents: delta, thresholdCents: T,
    };
  }
  if (delta > T) {
    return {
      winner: 'voucher',
      label: '极限省钱方案（跨渠道券包）',
      reason: `券包方案比官方套壳再省 ¥${(delta / 100).toFixed(1)}，值得拆单（券部分在第三方渠道购买核销，余项官方下单）`,
      deltaCents: delta, thresholdCents: T,
    };
  }
  return {
    winner: 'official',
    label: '官方渠道方案（券倒挂避坑）',
    reason: `券包方案反超官方 ¥${(-delta / 100).toFixed(1)}，存在团购倒挂/伪优惠，详见避坑警告`,
    deltaCents: delta, thresholdCents: T,
  };
}

/**
 * 第三轨主求解（PRD v1.3 §2.3.1-B，S1–S7）。
 * @param options.track2PaidCents 轨道 2 实付（供决策对比）；缺失时决策退化为 official（保守）
 */
const dbg = (...a: unknown[]) => { if (process.env.DEBUG_VOUCHER === '1') console.error('[voucher]', ...a); };

export async function solveVoucherTrack(
  client: McpClient,
  input: GroupOrderInput,
  menu: MenuLoadResult,
  options: { userVouchers?: Voucher[]; track2PaidCents?: number; useUnion?: boolean } = {},
): Promise<VoucherTrackSolution | null> {
  // ---- S1 心愿解析（与轨道 2 同口径：同一匹配函数，保证三轨可比） ----
  const resolved: ResolvedWish[] = [];
  const unresolvedByMember = new Map<number, string[]>(); // S1 失配心愿：进展示层，不阻断残余求解
  for (let mi = 0; mi < input.members.length; mi++) {
    const m = input.members[mi];
    for (const phrase of m.wishes) {
      const spec = parseWishPhrase(phrase);
      if (!spec || !spec.keyword) continue;
      const hitRes = findMenuItem(spec, menu.items);
      if (!hitRes || tabooHit(m, hitRes.item)) {
        if (!hitRes) {
          if (!unresolvedByMember.has(mi)) unresolvedByMember.set(mi, []);
          unresolvedByMember.get(mi)!.push(spec.raw);
        }
        continue;   // 未匹配/禁忌：与轨道 1/2 一致，不进券轨
      }
      const specRow = findSpecRow(menu.table, hitRes.item, spec);
      resolved.push({
        memberIdx: mi, alias: m.alias, spec, hit: hitRes.item, specRow,
        kcal: (specRow ? specRow.row.energyKcal : hitRes.item.kcal) * spec.qty,
      });
    }
  }
  dbg('S1 resolved =', resolved.length, resolved.map(r => r.spec.raw).join(','));
  if (resolved.length === 0) return null;

  // ---- S2 券召回：三层券池（v1.3.1）----
  // 层 A 联盟 CPS 实时层（主力）：union_api.py 查询美团到店团单，券内容三级降级解析
  //   （白名单 → MCP 套餐组成 → 仅展示）；接口失败自动降级预置知识库，不阻塞主流程。
  // 层 B 预置知识库（离线兜底）。层 C 用户自持券。
  let unionDegraded = false;
  let unionSolvableCount = 0;
  let unionDbUsed = false;
  const unionTips: Voucher[] = [];
  const pool: Voucher[] = [];
  if (options.useUnion !== false) {
    try {
      const { builds, dbUsed } = await fetchUnionMcDeals(client, input.storeCode, menu, input.storeName);
      unionDbUsed = dbUsed;
      for (const b of builds) {
        if (b.voucher.id === 'union-degraded') { unionDegraded = true; continue; }
        if (b.solvable) {
          unionSolvableCount++;
          if (b.buyLink) b.voucher.buyPath = `官方短链（零收益模式）：${b.buyLink}`;
          if (b.storeNote) b.voucher.notes = [...(b.voucher.notes ?? []), b.storeNote];
          pool.push(b.voucher);
        } else {
          b.voucher.notes = [...(b.voucher.notes ?? []), b.storeNote];
          unionTips.push(b.voucher);
        }
      }
    } catch { unionDegraded = true; }
  }
  pool.push(...PRESET_VOUCHERS.filter((v) => !pool.some((p) => p.name === v.name)));
  pool.push(...(options.userVouchers ?? []));
  const candidates = pool.filter(
    // v1.4：combo-ref 单引用可代表多件套餐，不得用引用条数门槛挡住整包券；
    // v1.4.1「全部团购入池」：核验通过的单品券（1 件）同样参与覆盖（现金券 items 为空仍排除）
    (v) => v.kind === 'combo' && v.constraints.orderType === 'instore'
      && v.items.length >= 1,
  );
  dbg('S2 candidates =', candidates.length, candidates.map(c => c.id.slice(0, 22)).join(','));
  if (candidates.length === 0) return null;

  // ---- S3 贪心覆盖（MVP 单单限 1 张：只取首轮最优券，D8） ----
  const { selected } = greedyCover(resolved, candidates);
  const chosen = selected.slice(0, 1);
  const coveredWishes = new Set(chosen.flatMap((s) => s.covered.map((c) => c.wish)));
  dbg('S3 chosen =', chosen.length, chosen.map(c => c.voucher.id.slice(0, 24)).join(','));
  if (chosen.length === 0) {
    // 无券可选：仍需输出避坑信息（候选券中倒挂者）→ 走「全余项」路径无意义，直接返回 null
    return null;
  }

  // ---- S4 余项分流：残余 members 直接复用现有轨道（D3，零算法重复） ----
  // 残余只传「已成功匹配且未被券覆盖」的心愿——S1 失配心愿进展示层，
  // 避免个别失配心愿令 solveGroupOrder 抛「全员未匹配」异常而放弃整条第三轨
  const coveredByMember = new Map<number, Set<string>>();
  for (const w of coveredWishes) {
    if (!coveredByMember.has(w.memberIdx)) coveredByMember.set(w.memberIdx, new Set());
    coveredByMember.get(w.memberIdx)!.add(w.spec.raw);
  }
  const residualMembers: GroupMember[] = input.members.map((m, i) => ({
    ...m,
    wishes: resolved.filter((w) => w.memberIdx === i && !coveredWishes.has(w)).map((w) => w.spec.raw),
  }));
  const hasResidual = residualMembers.some((m) => m.wishes.length > 0);
  let residual: GroupSolution | null = null;
  let residualSource: VoucherBreakdown['residualSource'] = 'none';
  if (hasResidual) {
    try {
      residual = await solveBundleTrack(client, { ...input, members: residualMembers }, menu);
      residualSource = 'bundle';
      if (!residual) {
        residual = await solveGroupOrder(client, { ...input, members: residualMembers });
        residualSource = 'a-la-carte';
      }
    } catch {
      // 残余心愿全部失配等极端情况：第三轨整体放弃，回退官方双轨（前端已有）
      return null;
    }
  }

  // ---- S5 综合成本：券参考价 + 余项 MCP 实付 ----
  const voucher = chosen[0].voucher;
  const voucherCents = voucher.priceCents;
  const residualPaid = residual ? residual.totals.paidCents : 0;
  const paidCents = voucherCents + residualPaid;

  // ---- S6 组装成员与原价等比分账（与轨道 1/2 同公式；尾差归末位成员守恒） ----
  const warnings: string[] = [];
  const members: GroupMemberResult[] = input.members.map((m, i) => {
    const mineCovered = resolved.filter((w) => w.memberIdx === i && coveredWishes.has(w));
    const res = residual?.members.find((x) => x.alias === m.alias);
    const items: GroupMemberResult['items'] = [];
    for (const w of mineCovered) {
      items.push({
        code: w.hit.code, name: w.hit.name, qty: w.spec.qty, priceCents: w.hit.priceCents,
        isCombo: w.hit.isCombo, nutritionMatched: w.hit.nutritionMatched || !!w.specRow,
        ...(w.specRow ? { nutritionNote: `按${w.specRow.label} ${w.specRow.row.energyKcal} kcal` } : {}),
        viaVoucherId: voucher.id,
      });
    }
    for (const it of res?.items ?? []) items.push({ ...it });
    const originalCents =
      mineCovered.reduce((s, w) => s + w.hit.priceCents * w.spec.qty, 0) + (res?.originalCents ?? 0);
    return {
      alias: m.alias, items, originalCents, shareCents: 0, payableCents: 0,
      savedCents: 0, personalCouponCents: m.personalCouponCents,
      kcal: mineCovered.reduce((s, w) => s + w.kcal, 0) + (res?.kcal ?? 0),
      unresolvedWishes: [...(res?.unresolvedWishes ?? []), ...(unresolvedByMember.get(i) ?? [])],
      tabooFiltered: res?.tabooFiltered ?? [],
      ...(m.notes?.length ? { note: m.notes.join('；') } : {}),
    };
  });

  const totalOriginal = members.reduce((s, m) => s + m.originalCents, 0);
  let assigned = 0;
  members.forEach((m, idx) => {
    const share = totalOriginal > 0
      ? (idx === members.length - 1 ? paidCents - assigned : Math.round((m.originalCents / totalOriginal) * paidCents))
      : 0;
    assigned += share;
    m.shareCents = Math.max(0, share);
    m.payableCents = Math.max(0, m.shareCents - (m.personalCouponCents ?? 0));
    m.savedCents = Math.max(0, m.originalCents - m.shareCents);
  });

  // ---- S7 倒挂检测 + 口径警示 ----
  let skus: ComboSkuInfo[] = [];
  try { skus = await loadComboSkus(client, input.storeCode, menu); } catch { skus = []; }
  const equiv = officialEquivalentCents(voucher, chosen[0].covered, skus);
  const selectedBreakdown: VoucherBreakdown['selected'] = [{
    voucher,
    coveredWishes: chosen[0].covered.map((c) => ({ alias: c.wish.alias, wish: c.wish.spec.raw, itemName: c.wish.hit.name })),
    basis: voucher.source === 'user' ? 'user-claimed' : 'kb-reference',
    ...(equiv > 0 && voucher.priceCents >= equiv
      ? { inverted: { officialEquivalentCents: equiv, deltaCents: voucher.priceCents - equiv } }
      : {}),
  }];
  const invertedWarnings: string[] = [];
  if (selectedBreakdown[0].inverted) {
    const inv = selectedBreakdown[0].inverted;
    const text = invertedWarningText(voucher.channelLabel, voucher.name, voucher.priceCents, inv.officialEquivalentCents);
    if (text) invertedWarnings.push(text);
  }
  // 未入选候选提示：全量券池（联盟实时 + 预置 + 用户）中未选中者——含未核验明细券（仅参考价，不透出路径）
  // 与 cash 型（支付贴士，PRD 拍板②）
  const seenTipIds = new Set([voucher.id]);
  const candidateTips: VoucherBreakdown['candidateTips'] = [...unionTips, ...PRESET_VOUCHERS, ...(options.userVouchers ?? [])]
    .filter((v) => !seenTipIds.has(v.id) && seenTipIds.add(v.id))
    .map((v) => ({
      voucher: v,
      reason: v.kind === 'cash'
        ? '支付立减贴士（金额随机/名额制，不参与比价）'
        : v.items.length === 0
          ? '渠道参考价（券面明细未核验，未纳入自动比价）'
          : `当前心愿组合下未入选（净省钱额低于「${voucher.name}」）`,
    }));

  if (unionDbUsed) warnings.push('美团联盟实时接口本次不可用，券池已使用本地团单库兜底（价格为最近观测参考价，已按新旧标注）。');
  else if (unionDegraded) warnings.push('美团联盟实时查询本次不可用，券池已降级为预置知识库（价格可能与实时有差异）。');
  else if (unionSolvableCount > 0) warnings.push(`美团联盟实时层命中 ${unionSolvableCount} 张在售团单（价格/内容来自官方接口与 MCP 数据，零录入）。`);
  const pointsNote = voucher.constraints.noPoints
    ? '用券核销部分不累积麦当劳会员积分（券面规则），积分价值未计入本对比。'
    : '';
  if (residual) warnings.push(...residual.warnings); // 余项口径与失配提示跟随现有轨道
  warnings.push('券部分为知识库/您录入的参考价，未经理 MCP 核价；分账卡实付为估算口径，结算差异请以各平台订单为准。');
  if (isStale(voucher)) warnings.push(`券「${voucher.name}」为 ${KB_STALE_DAYS} 天前的核验价，购买时请以平台实时页为准。`);
  if (voucher.constraints.samePhoneBind) warnings.push('该券需同手机号登录麦当劳 APP 绑定「到店券」后方可自助点餐核销。');
  if (pointsNote) warnings.push(pointsNote);
  if (input.members.some((m) => (m.personalCouponCents ?? 0) > 0)) {
    warnings.push('个人现金立减券仅冲减官方渠道部分应付；券面「不与其他优惠同享」，渠道券核销单不叠加官方优惠。');
  }
  if (members.some((m) => m.unresolvedWishes.length > 0)) {
    warnings.push(`仍有心愿未匹配到菜单品项：${members.filter((m) => m.unresolvedWishes.length > 0).map((m) => `@${m.alias}「${m.unresolvedWishes.join('、')}」`).join('；')}`);
  }

  const track2Paid = options.track2PaidCents;
  const deltaCents = track2Paid != null ? track2Paid - paidCents : -1;
  const T = track2Paid != null ? tieThresholdCents(track2Paid) : 0;
  const decision: TrackWinner = track2Paid == null
    ? 'official'
    : deltaCents >= 0 && deltaCents <= T ? 'tie-official' : deltaCents > T ? 'voucher' : 'official';

  return {
    store: { storeCode: input.storeCode, storeName: input.storeName ?? `门店 ${input.storeCode}` },
    track: 'voucher',
    trackNote: `轨道 3 · 全网合规券包：${voucher.channelLabel}「${voucher.name}」覆盖 ${coveredWishes.size} 个心愿` +
      `（券 ¥${(voucherCents / 100).toFixed(1)} 参考价）+ 余项官方核价 ¥${(residualPaid / 100).toFixed(1)}`,
    members,
    orderNotes: residual?.orderNotes ?? [],
    totals: {
      originalCents: totalOriginal,
      paidCents,
      discountCents: Math.max(0, totalOriginal - paidCents),
      priceSource: 'mixed',
      priceNote: `券部分 ¥${(voucherCents / 100).toFixed(1)}（参考价）+ 余项 ¥${(residualPaid / 100).toFixed(1)}（${residual?.totals.priceSource === 'calculate-price' ? 'MCP 计价' : residualSource === 'none' ? '无余项' : '菜单价估算'}）`,
    },
    deliveryFeeCents: 0,
    warnings,
    disclaimer:
      '券价为合规渠道公开参考价（docs/COUPON_MARKET_RESEARCH.md），本工具仅输出比价与购买/核销指引，' +
      '不代购、不托管券码、不做分销链接；价格以各平台下单页为准。',
    voucherBreakdown: {
      selected: selectedBreakdown,
      candidateTips,
      invertedWarnings,
      residualSource,
      residualPaidCents: residualPaid,
      pointsNote,
    },
    decision,
  };
}
