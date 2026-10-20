// 券配方库（v1.4，评审第 1 项）：可维护的真实券组成知识层。
//
// 背景（docs/CPS_DETAIL_INVESTIGATION_v13.md）：券面食品清单在联盟 CPS 层结构性不可得
// （列表/精确查询/skuExtInfoDTO 均无构成，H5 详情页为 App 壳）。若每次都等详情接口返回清单，
// 求解会反复卡住。本层把「人工核验一次、长期复用」的券组成沉淀为**可维护配方**：
//   配方承载组成与规则（商品标识/食品及规格/数量/任选范围/补差规则/适用条件/证据/核验日期/规则版本），
//   价格与售卖状态仍以实时团单为准（配方只补组成，不冻结价格）。
//
// 与实时层的关系：
//   - 配方优先：团单名命中配方 → 直接用配方组成（核验记录写入 ruleVersion/证据链），不再走详情猜测；
//   - 未命中配方 → 回落 dealDetail 的 S1 券名模式 / S2 官方同名套餐核验；
//   - 配方可核验后录入、批量导入、按 id 修订；用户层配方优先于预置层。
//
// 诚实边界：预置配方只收录有公开证据链的券型（官方产品规则 / 官方同名套餐），
// 不凭券名猜测「任选 N 件」的可选集合；范围无法确认的券保持未核验。
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getLayout, userHomePaths } from './paths.js';
import { withUserFileLock } from './userFileLock.js';
import { fileStamp, readJsonFile, readJsonFileForWrite, writeJsonAtomic, UserStoreError } from './userStore.js';
import { clearRevocation, isRecipeRevoked, revokeRecipe } from './revocations.js';
import { resolveComponentNutrition } from './nutritionSupplements.js';
import { resolveFixedVoucherFood } from './voucherFoods.js';
import type { VoucherItemRef, VoucherConstraints, VoucherChannel } from './vouchers.js';
import type { MenuLoadResult } from './menu.js';

/** 配方条目：在券条目基础上补充规格、任选范围、补差规则与履约 code（与营养匹配标识分离） */
export interface VoucherRecipeItem extends VoucherItemRef {
  /** 食品及规格（如「中薯条」「大杯可乐」；用于展示与规格核验） */
  spec?: string;
  /** 任选范围（可选集合；combo-ref 时由官方套餐轮次展开，此处仅记录声明范围） */
  choiceRange?: string[];
  /** 补差规则（如「升大杯 +2 元」） */
  surcharge?: string;
  /** v1.4.5 W03：结构化逐选项补差（分）；缺省时按 surcharge 文本归因 */
  optionDiffs?: Record<string, number>;
  /** 履约 code（官方轮次选项 code，用于 calculate-price 的 roundList；与营养匹配标识分离保留） */
  fulfillCode?: string;
}

/** 配方解析方式：combo-name=按官方同名套餐解析；pattern=券名即产品规则（随心配）；explicit=显式列出 */
export type RecipeResolve = 'combo-name' | 'pattern' | 'explicit';

export interface VoucherRecipe {
  id: string;
  /** 券名（展示与匹配主键） */
  name: string;
  /** 归一化匹配别名（含券名本身，去括号/空格/小写） */
  matchNames: string[];
  resolve: RecipeResolve;
  channel: VoucherChannel;
  channelLabel: string;
  items: VoucherRecipeItem[];
  conditions: VoucherConstraints;
  /** 参考价（分）；实时团单命中时以实时价覆盖 */
  priceCents: number;
  originalPriceCents: number;
  buyPath: string;
  redeemPath: string;
  /** 证据说明（核验依据；配方可审计） */
  evidence: string;
  /** 核验日期（ISO date） */
  verifiedAt: string;
  /** 规则版本（券规则随档期变化时递增，缓存/核验按版本复用） */
  ruleVersion: string;
  /** CPS 商品身份与券面素材，仅用于关联和可追溯查看，不代表组成已核验 */
  productViewSign?: string;
  skuViewId?: string;
  productViewSigns?: string[];
  skuViewIds?: string[];
  headUrl?: string;
  source: 'preset' | 'imported' | 'user';
  /** 适用上下文（城市/门店范围；缺省=通用） */
  scope?: { city?: string; stores?: string[] };
  /** 官方 SKU 绑定：choice 型配方必须（任选范围的权威来源）；combo-ref 建议填写 */
  binding?: { comboCode?: string; roundIds?: string[] };
  /** v1.4.7 R06：种子来源与用户修改标记。
   *  旧迁移判定只看「证据文本同源 + 食品签名在种子内」，无法区分「用户主动删掉一个任选范围」
   *  与「系统旧副本」，会把用户缩小的范围恢复成种子版本。现在：
   *    - seedHash 记录保存时对应预置配方的构成指纹；
   *    - userEdited=true 表示用户显式修改过构成/范围 → 永不按种子迁移；
   *    - 无 seedMeta 的历史记录走保守判定（用户条目少于种子或范围是种子真子集 → 视为用户修订）。 */
  seedMeta?: { seedVersion?: string; seedHash: string; userEdited: boolean; updatedAt: string };
}

// ---------- 名称归一（与 dealDetail 同口径：去括号内容 + 去空格 + 小写） ----------

export function normVoucherName(s: string): string {
  return s.replace(/[（(【\[].*?[)）】\]]/g, '').replace(/\s+/g, '').toLowerCase();
}

// ---------- 预置配方（只收录有公开证据链的常见券；价格仅参考，实时价优先） ----------

const MEITUAN_INSTORE: VoucherConstraints = { orderType: 'instore', noStack: true, noPoints: true };

export const PRESET_RECIPES: VoucherRecipe[] = [
  {
    id: 'rcp-1plus1',
    name: '随心配 1+1 套餐',
    matchNames: ['随心配1+1套餐', '随心配1+1', '随心配'],
    resolve: 'pattern',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'choice', keyword: 'staple', qty: 1, spec: '红区主食任选 1', choiceRange: ['官方随心配红区全部轮次选项'], surcharge: '红区换选按官方 diffPrice' },
      { mode: 'choice', keyword: 'white', qty: 1, spec: '白区（小食/甜品/饮品）任选 1', choiceRange: ['官方随心配白区全部轮次选项'], surcharge: '白区换选按官方 diffPrice' },
    ],
    conditions: { ...MEITUAN_INSTORE, perUserLimit: 12, expireNote: '常驻团购，档期随平台更新' },
    priceCents: 1390, originalPriceCents: 1490,
    buyPath: '美团/大众点评 APP 搜索「麦当劳」→ 门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示团购券码由店员核销；或绑定麦当劳 APP 后自助点餐（以券面说明为准）',
    evidence: '官方产品规则：随心配 1+1 = 红区任选 1 + 白区任选 1（任选范围=官方 SKU 真实轮次，含实测 diffPrice）；券名即券面（S1 模式）',
    verifiedAt: '2026-10-14', ruleVersion: '1plus1-v1', source: 'preset',
  },
  {
    id: 'rcp-huiyan-yuantong-2',
    name: '灰焰圆筒第二份半价',
    matchNames: ['灰焰圆筒第二份半价'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    // v1.4.6 R07：把已有调查证据固化为**可复用配方**，不再依赖当次官方菜单实时核验。
    //   商品身份只绑定已核验的 A 段 TL4PT4MWJ62WDIWUMHTA4DDTHQ（2026-10-15 上海成功核验）；
    //   同名不同 A 段（5CCJIIXASFUOZ54F24U7JLOXXE）不得仅凭同名套用本配方（由身份过滤阻断）。
    productViewSign: 'TL4PT4MWJ62WDIWUMHTA4DDTHQ_DI5IN6MNTCOVEYOLW7RDMFWZLI',
    productViewSigns: ['TL4PT4MWJ62WDIWUMHTA4DDTHQ_DI5IN6MNTCOVEYOLW7RDMFWZLI', 'TL4PT4MWJ62WDIWUMHTA4DDTHQ_RLQKQJ77M4PETTBFFUWAXH2DIE'],
    skuViewId: 'TL4PT4MWJ62WDIWUMHTA4DDTHQ',
    items: [{ mode: 'fixed', keyword: '灰焰圆筒', qty: 2, spec: '1个', fulfillCode: '521951' }],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 750, originalPriceCents: 0,
    buyPath: '美团/大众点评 APP → 麦当劳门店团购页（下单页价格为准）',
    redeemPath: '到店出示团购券码核销（以券面说明为准）',
    evidence: '券名「灰焰圆筒第二份半价」与官方同名单品归一化全名一致（S2b single-name-v1；2026-10-15 上海商品 A=TL4PT4MWJ62WDIWUMHTA4DDTHQ 成功核验）：构成 = 灰焰圆筒 ×2，官方 code 521951；同 A 段商品跨城复用（按商品身份，不按同名推断）；营养 110 kcal/支为估算（见营养种子）',
    verifiedAt: '2026-10-15', ruleVersion: 'single-name-v1', source: 'preset',
  },
  {
    id: 'rcp-longyan-chicken-3',
    name: '龙焰鸡腿堡三件套',
    matchNames: ['龙焰鸡腿堡三件套'],
    resolve: 'combo-name',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'combo-ref', keyword: '龙焰鸡腿堡三件套', qty: 1, comboName: '龙焰鸡腿堡三件套', spec: '官方同名套餐整包（3 件）' }],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2570, originalPriceCents: 0,
    buyPath: '美团/大众点评 APP → 麦当劳门店团购页（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '券名与官方菜单套餐「龙焰鸡腿堡三件套」归一化全名一致（S2）；构成取官方套餐各轮次（含任选范围+默认项+差价）',
    verifiedAt: '2026-10-14', ruleVersion: 'combo-name-v1', source: 'preset',
  },
  {
    id: 'rcp-longyan-cheese-3',
    name: '龙焰芝士棒鸡腿堡三件套',
    matchNames: ['龙焰芝士棒鸡腿堡三件套'],
    resolve: 'combo-name',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'combo-ref', keyword: '龙焰芝士棒鸡腿堡三件套', qty: 1, comboName: '龙焰芝士棒鸡腿堡三件套', spec: '官方同名套餐整包（3 件）' }],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2850, originalPriceCents: 0,
    buyPath: '美团/大众点评 APP → 麦当劳门店团购页（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '券名与官方菜单套餐「龙焰芝士棒鸡腿堡三件套」归一化全名一致（S2）；构成取官方套餐各轮次',
    verifiedAt: '2026-10-14', ruleVersion: 'combo-name-v1', source: 'preset',
  },
  {
    id: 'rcp-maiheung-3',
    name: '麦香鸡三件套',
    matchNames: ['麦香鸡三件套'],
    resolve: 'combo-name',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'combo-ref', keyword: '麦香鸡三件套', qty: 1, comboName: '麦香鸡三件套', spec: '官方同名套餐整包（3 件）' }],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1990, originalPriceCents: 0,
    buyPath: '美团/大众点评 APP → 麦当劳门店团购页（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '券名与官方菜单同名套餐归一化全名一致（S2）；无同名套餐门店保持未核验（不猜测组成）',
    verifiedAt: '2026-10-14', ruleVersion: 'combo-name-v1', source: 'preset',
  },
  {
    id: 'rcp-banshao-2',
    name: '板烧鸡腿堡两件套',
    matchNames: ['板烧鸡腿堡两件套'],
    resolve: 'combo-name',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'combo-ref', keyword: '板烧鸡腿堡两件套', qty: 1, comboName: '板烧鸡腿堡两件套', spec: '官方同名套餐整包（2 件）' }],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1790, originalPriceCents: 0,
    buyPath: '美团/大众点评 APP → 麦当劳门店团购页（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '券名与官方菜单同名套餐归一化全名一致（S2）；构成取官方套餐各轮次',
    verifiedAt: '2026-10-14', ruleVersion: 'combo-name-v1', source: 'preset',
  },
  {
    id: 'rcp-jumbo-3',
    name: '巨无霸三件套',
    matchNames: ['巨无霸三件套'],
    resolve: 'combo-name',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'combo-ref', keyword: '巨无霸三件套', qty: 1, comboName: '巨无霸三件套', spec: '官方同名套餐整包（3 件）' }],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 3750, originalPriceCents: 0,
    buyPath: '美团/大众点评 APP → 麦当劳门店团购页（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '券名与官方菜单同名套餐归一化全名一致（S2）；构成取官方套餐各轮次',
    verifiedAt: '2026-10-14', ruleVersion: 'combo-name-v1', source: 'preset',
  },
  {
    id: 'rcp-malai-3',
    name: '麦辣鸡腿汉堡三件套',
    matchNames: ['麦辣鸡腿汉堡三件套', '麦辣鸡腿堡三件套'],
    resolve: 'combo-name',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'combo-ref', keyword: '麦辣鸡腿汉堡三件套', qty: 1, comboName: '麦辣鸡腿汉堡三件套', spec: '官方同名套餐整包（3 件）' }],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 3350, originalPriceCents: 0,
    buyPath: '美团/大众点评 APP → 麦当劳门店团购页（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '券名与官方菜单同名套餐归一化全名一致（S2）；构成取官方套餐各轮次',
    verifiedAt: '2026-10-14', ruleVersion: 'combo-name-v1', source: 'preset',
  },
  {
    id: 'rcp-maiheungfish-3',
    name: '麦香鱼套餐',
    matchNames: ['麦香鱼套餐'],
    resolve: 'combo-name',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'combo-ref', keyword: '麦香鱼套餐', qty: 1, comboName: '麦香鱼套餐', spec: '官方同名套餐整包（3 件）' }],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 3300, originalPriceCents: 0,
    buyPath: '美团/大众点评 APP → 麦当劳门店团购页（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '券名与官方菜单同名套餐归一化全名一致（S2）；构成取官方套餐各轮次',
    verifiedAt: '2026-10-14', ruleVersion: 'combo-name-v1', source: 'preset',
  },
  {
    id: 'rcp-487-meatlover',
    name: '【487大卡】无肉不欢套餐',
    matchNames: ['【487大卡】无肉不欢套餐', '无肉不欢套餐'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '吉士汉堡包', qty: 1, spec: '1个' },
      { mode: 'fixed', keyword: '麦辣鸡翅', qty: 1, spec: '2块' },
      { mode: 'fixed', keyword: '无糖可口可乐', qty: 1, spec: '中' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2550, originalPriceCents: 3500,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '全网信源交叉比对：麦当劳官方500大卡精选套餐公告 + 界面新闻/美团详情，构成固定为吉士汉堡包+麦辣鸡翅2块+中杯零度可乐，官方实测热量约482~487kcal',
    verifiedAt: '2026-10-16', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-shuangshu-yuantong',
    name: '双薯双圆筒',
    matchNames: ['双薯双圆筒'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '薯条', qty: 2, spec: '中份' },
      { mode: 'fixed', keyword: '圆筒冰淇淋', qty: 2, spec: '1个' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1990, originalPriceCents: 3700,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '全网信源交叉比对：什么值得买优惠爆料 + 美团团单明细，构成明确为中薯条2份+经典圆筒冰淇淋2个',
    verifiedAt: '2026-10-16', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-shuangshu-shuangle',
    name: '双薯双乐',
    matchNames: ['双薯双乐'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '薯条', qty: 2, spec: '中份' },
      { mode: 'fixed', keyword: '可口可乐', qty: 2, spec: '中杯' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2350, originalPriceCents: 4100,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '全网信源交叉比对：美团本地生活特惠 + SMZDM 爆料图文，构成明确为中薯条2份+中杯可口可乐2杯',
    verifiedAt: '2026-10-16', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-shuangshu-maileji',
    name: '双薯双麦乐鸡',
    matchNames: ['双薯双麦乐鸡'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '薯条', qty: 2, spec: '中份' },
      { mode: 'fixed', keyword: '麦乐鸡', qty: 2, spec: '5块' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2690, originalPriceCents: 4500,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '全网信源交叉比对：美团团购套餐详情，双薯双麦乐鸡构成明确为中薯条2份+麦乐鸡5块×2份（共10块）',
    verifiedAt: '2026-10-16', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-jishu-box',
    name: '麦当劳鸡薯双全盒',
    matchNames: ['麦当劳鸡薯双全盒', '鸡薯双全盒'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '心形薯饼5块', qty: 1, spec: '5块' },
      { mode: 'fixed', keyword: '麦乐鸡', qty: 1, spec: '5块' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1590, originalPriceCents: 2600,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '全网信源交叉比对：麦当劳官网活动公告（mcdonalds.com.cn）公示「鸡薯双全盒：5块心形薯饼+5块麦乐鸡配酱」',
    verifiedAt: '2026-10-16', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-xuanfeng-afternoon',
    name: '快乐旋风下午茶夜宵单人餐',
    matchNames: ['快乐旋风下午茶夜宵单人餐'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSigns: [
      'AV32WSKGPLRTOJ3FLV2DR2EZIA_VE6Y7HURK7DIZNVIAXBHK2NAKA',
      '6MBF3A4XO2II7P6AGL7W74MM6I_VE6Y7HURK7DIZNVIAXBHK2NAKA'
    ],
    skuViewIds: [
      'AV32WSKGPLRTOJ3FLV2DR2EZIA',
      '6MBF3A4XO2II7P6AGL7W74MM6I'
    ],
    items: [
      { mode: 'choice', keyword: '炸鸡2选1', qty: 1, spec: '炸鸡2选1', choiceRange: ['麦辣鸡翅', '麦乐鸡'] },
      { mode: 'fixed', keyword: '中薯条', qty: 1, spec: '中' },
      { mode: 'choice', keyword: '麦旋风2选1', qty: 1, spec: '麦旋风2选1', choiceRange: ['奥利奥麦旋风', '草莓麦旋风'] },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1990, originalPriceCents: 4150,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 51 官方备注实证：炸鸡2选1（麦辣鸡翅2块/麦乐鸡5块） + 中薯条 + 麦旋风2选1（奥利奥/草莓）',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-paipai-4',
    name: '派派四重奏',
    matchNames: ['派派四重奏'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '香芋派', qty: 2, spec: '1个' },
      { mode: 'fixed', keyword: '菠萝派', qty: 2, spec: '1个' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1500, originalPriceCents: 2800,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '全网信源交叉比对：新浪新闻促销通报与美团团购，构成明确为经典香芋派2个+经典菠萝派2个（共4个）',
    verifiedAt: '2026-10-16', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-malai-wings-4',
    name: '2对麦辣鸡翅',
    matchNames: ['2对麦辣鸡翅'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '麦辣鸡翅', qty: 2, spec: '2块' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1990, originalPriceCents: 2900,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '麦当劳官方规格：1对=2块，2对=4块麦辣鸡翅（qty=2, spec=2块）',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-dabao-koufu-3',
    name: '大堡口福三件套',
    matchNames: ['大堡口福三件套'],
    resolve: 'combo-name',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'combo-ref', keyword: '大堡口福三件套', qty: 1, comboName: '大堡口福三件套', spec: '官方同名套餐整包（3 件）' }],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2390, originalPriceCents: 4200,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '券名与官方菜单套餐「大堡口福三件套」归一化全名一致（S2）；构成取官方套餐各轮次（含任选范围+默认项+差价）',
    verifiedAt: '2026-10-16', ruleVersion: 'combo-name-v1', source: 'preset',
  },
  {
    id: 'rcp-zhanzhan-zhaji-3',
    name: '蘸蘸炸鸡3选1',
    matchNames: ['蘸蘸炸鸡3选1', '蘸蘸炸鸡'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '麦麦脆汁鸡', qty: 1, spec: '1块' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1190, originalPriceCents: 1500,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '仅计算已确认的合法搭配（非完整任选）：麦麦脆汁鸡1块（配蘸酱），经信源交叉比对与官方规格核验',
    verifiedAt: '2026-10-17', ruleVersion: 'restricted-combo-v1', source: 'preset',
  },
  {
    id: 'rcp-tianxian-shuangpin-1plus1',
    name: '【任选1+1】甜咸双拼小食单人餐',
    matchNames: ['【任选1+1】甜咸双拼小食单人餐', '甜咸双拼小食单人餐', '【甜咸双拼】甜咸小食两件套单人餐'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '麦乐鸡', qty: 1, spec: '5块' },
      { mode: 'fixed', keyword: '香芋派', qty: 1, spec: '1个' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1590, originalPriceCents: 2300,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '仅计算已确认的合法搭配（非完整任选）：麦乐鸡5块 + 香芋派1个，经信源交叉比对与官方规格核验',
    verifiedAt: '2026-10-17', ruleVersion: 'restricted-combo-v1', source: 'preset',
  },
  {
    id: 'rcp-wangpai-xiaoshipin',
    name: '王牌小食拼【仅麦当劳app核销】',
    matchNames: ['王牌小食拼【仅麦当劳app核销】', '王牌小食拼'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '麦辣鸡翅', qty: 1, spec: '2块' },
      { mode: 'fixed', keyword: '薯条', qty: 1, spec: '中份' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1590, originalPriceCents: 2600,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '绑定麦当劳 APP 核销',
    evidence: '全网信源交叉比对：美团特惠爆料：经典王牌麦辣鸡翅2块+中薯条1份',
    verifiedAt: '2026-10-16', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-cuizhiji-xiaoshi-yinliao-3',
    name: '脆汁鸡小食饮料三件套',
    matchNames: ['脆汁鸡小食饮料三件套', '小食饮料三件套'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '麦麦脆汁鸡', qty: 1, spec: '1块' },
      { mode: 'fixed', keyword: '薯条', qty: 1, spec: '中份' },
      { mode: 'fixed', keyword: '可口可乐', qty: 1, spec: '中杯' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1990, originalPriceCents: 3400,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '全网信源交叉比对：美团详情与SMZDM爆料：麦麦脆汁鸡1块+中薯条1份+中杯可乐1杯',
    verifiedAt: '2026-10-16', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-xiantian-xiaoshi-yinliao-3',
    name: '【咸甜搭配】小食饮料三件套',
    matchNames: ['【咸甜搭配】小食饮料三件套', '咸甜搭配小食饮料三件套'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '麦辣鸡翅', qty: 1, spec: '2块' },
      { mode: 'fixed', keyword: '香芋派', qty: 1, spec: '1个' },
      { mode: 'fixed', keyword: '可口可乐', qty: 1, spec: '中杯' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1990, originalPriceCents: 3500,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '全网信源交叉比对：美团团单详情：麦辣鸡翅2块+香芋派1个+中杯可乐1杯',
    verifiedAt: '2026-10-16', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-roushi-zhuyi-2',
    name: '【肉食主义】小食2件自由拼',
    matchNames: [
      '【肉食主义】小食2件自由拼',
      '【肉食主义】1+1小食自由拼',
      '【任选2件】鸡肉小食两件套',
      '鸡肉小食两件套',
      '肉食主义小食2件自由拼',
    ],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '麦辣鸡翅', qty: 1, spec: '2块' },
      { mode: 'fixed', keyword: '麦乐鸡', qty: 1, spec: '5块' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1990, originalPriceCents: 3000,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '仅计算已确认的合法搭配（非完整任选）：麦辣鸡翅2块 + 麦乐鸡5块，经信源交叉比对与官方规格核验',
    verifiedAt: '2026-10-17', ruleVersion: 'restricted-combo-v1', source: 'preset',
  },
  {
    id: 'rcp-lanmeibaobaozhu-maixuanfeng-2',
    name: '蓝莓爆爆珠麦旋风第二份半价',
    matchNames: ['蓝莓爆爆珠麦旋风第二份半价'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '蓝莓爆爆珠麦旋风', qty: 2, spec: '1个' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2150, originalPriceCents: 3000,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '全网信源交叉比对：券名直译与美团团单：蓝莓爆爆珠麦旋风共2份（第二份半价）',
    verifiedAt: '2026-10-16', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-mini-malamix',
    name: '【超值热销】mini麦麦麻辣拌',
    matchNames: ['【超值热销】mini麦麦麻辣拌', 'mini麦麦麻辣拌'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '麦麦脆汁鸡', qty: 1, spec: '1块' },
      { mode: 'fixed', keyword: '麦乐鸡', qty: 1, spec: '5块' },
      { mode: 'fixed', keyword: '薯条', qty: 1, spec: '中份' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2490, originalPriceCents: 4300,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '全网信源交叉比对：美团达人整活套餐与SMZDM爆料：麦麦脆汁鸡1块+麦乐鸡5块+中薯条1份配辣拌拌料',
    verifiedAt: '2026-10-16', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-aishu-4',
    name: '【薯饼上新】爱薯四重奏',
    matchNames: ['【薯饼上新】爱薯四重奏', '爱薯四重奏'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '薯条', qty: 1, spec: '中份' },
      { mode: 'fixed', keyword: '心形薯饼5块', qty: 1, spec: '5块' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2560, originalPriceCents: 4200,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '全网信源交叉比对：抖音/美团新品套餐：中薯条1份+爱心薯饼5块（比心薯）',
    verifiedAt: '2026-10-16', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-fandazi-4',
    name: '【双人食】小食4件自由拼',
    matchNames: ['【双人食】小食4件自由拼', '【饭搭子一起吃】小食4件自由拼', '小食4件自由拼'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSigns: [
      'NNRFMJXJGH2Y3CEWDRHLKVZYLE_VE6Y7HURK7DIZNVIAXBHK2NAKA',
      '2TQNK4MZRK3BQWWQ2NRSSQ4YDM_VE6Y7HURK7DIZNVIAXBHK2NAKA'
    ],
    skuViewIds: [
      'NNRFMJXJGH2Y3CEWDRHLKVZYLE',
      '2TQNK4MZRK3BQWWQ2NRSSQ4YDM'
    ],
    items: [
      { mode: 'choice', keyword: 'A区肉食/中薯4选2可重复', qty: 2, spec: 'A区4选1', choiceRange: ['麦辣鸡翅', '酥脆带骨里脊', '麦乐鸡', '中薯条'] },
      // v1.4.5 W03：B区证据写明「7选2」，旧实现只列 6 项（漏「无糖中可」）——声明范围必须与证据一致。
      { mode: 'choice', keyword: 'B区饮品/甜品7选2可重复', qty: 2, spec: 'B区7选1', choiceRange: ['中可乐', '无糖中可乐', '中雪碧', '锡兰红茶', '圆筒冰淇淋', '香芋派', '菠萝派'] },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2780, originalPriceCents: 3500,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 50 官方备注实证：A区4选2可重复（辣翅/里脊/麦乐鸡/中薯） + B区7选2可重复（中可/无糖中可/中雪碧/红茶/圆筒/香芋派/菠萝派）',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-10-kuai-maileji',
    name: '10块麦乐鸡',
    matchNames: ['10块麦乐鸡'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '麦乐鸡', qty: 2, spec: '5块' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1400, originalPriceCents: 2400,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '麦当劳官方规格：麦乐鸡标准份为5块/份，10块麦乐鸡=2份（共10块），配官方餐酱',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-2-maixuanfeng',
    name: '两个麦旋风',
    matchNames: ['两个麦旋风', '【第二个半价】两个麦旋风', '两个麦旋风【单个仅需7.5元】'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '经典麦旋风', qty: 2, spec: '1个' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2100, originalPriceCents: 2800,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '全网信源交叉比对：经典奥利奥/草莓麦旋风任选2个，按同食品同规格审核别名承接经典麦旋风×2',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-yuantong-4',
    name: '圆筒四重奏',
    matchNames: ['圆筒四重奏'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '圆筒冰淇淋', qty: 4, spec: '1个' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1500, originalPriceCents: 2400,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '券名直译与美团团单：标准圆筒冰淇淋4个',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-bingqilin-yumibei',
    name: '冰淇淋玉米杯',
    matchNames: ['冰淇淋玉米杯'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '圆筒冰淇淋', qty: 1, spec: '1个' },
      { mode: 'fixed', keyword: '玉米杯', qty: 1, spec: '1份' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1090, originalPriceCents: 1800,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '券面直译与美团团单：标准圆筒冰淇淋1个+经典玉米杯1份',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-xiantian-sanpin',
    name: '咸甜三拼超值组合',
    matchNames: ['咸甜三拼超值组合', '【麦麦新吃法】咸甜三拼超值组合'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '薯条', qty: 1, spec: '中份' },
      { mode: 'fixed', keyword: '经典麦旋风', qty: 1, spec: '1个' },
      { mode: 'fixed', keyword: '麦乐鸡', qty: 1, spec: '5块' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1990, originalPriceCents: 3300,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '识图核验与美团团单：中薯条1份+经典麦旋风1个+麦乐鸡5块',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v1', source: 'preset',
  },
  {
    id: 'rcp-1plus1-deluxe-24',
    name: '【24种搭配】1+1堡卷小食自由拼',
    matchNames: ['【24种搭配】1+1堡卷小食自由拼', '1+1堡卷小食自由拼', '堡卷小食自由拼'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSign: 'DITQ2IMCJ55KPUZO3EM6LJ2THI_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'DITQ2IMCJ55KPUZO3EM6LJ2THI',
    items: [
      { mode: 'choice', keyword: '堡卷4选1', qty: 1, spec: '主食4选1', choiceRange: ['双层吉士汉堡', '麦辣鸡腿汉堡', '板烧鸡腿堡', '培根蔬萃双层牛堡'] },
      { mode: 'choice', keyword: '品质小食6选1', qty: 1, spec: '小食6选1', choiceRange: ['麦麦脆汁鸡', '麦辣鸡翅', '麦乐鸡', '中薯条', '那么大鸡排', '菠萝派'] },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2390, originalPriceCents: 3450,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 7 / Image 35 实证：A区大堡/卷4选1 + B区品质肉食/中薯6选1（共24种搭配）',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-dacui-maimanfen-2',
    name: '大脆鸡扒麦满分两件套',
    matchNames: ['大脆鸡扒麦满分两件套'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSign: 'C6BKVJ4LLJCNDZCZQGJTEME5YU_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'C6BKVJ4LLJCNDZCZQGJTEME5YU',
    items: [
      { mode: 'fixed', keyword: '大脆鸡扒麦满分', qty: 1, spec: '1个' },
      { mode: 'choice', keyword: '饮品3选1', qty: 1, spec: '饮品3选1', choiceRange: ['鲜萃咖啡', '鲜萃冰咖', '优品豆浆'] },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '早餐档期团购，以平台实时页为准' },
    priceCents: 1300, originalPriceCents: 2300,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 1 实证：大脆鸡扒麦满分 + 饮品3选1（鲜萃冰咖/小鲜萃/小豆浆）',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-bingqilin-hongcha',
    name: '冰淇淋红茶套餐',
    matchNames: ['冰淇淋红茶套餐'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSign: 'RBKWPASMPZNVLZKBREPKUXDDIU_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'RBKWPASMPZNVLZKBREPKUXDDIU',
    items: [
      { mode: 'fixed', keyword: '圆筒冰淇淋', qty: 1, spec: '1个' },
      { mode: 'fixed', keyword: '锡兰红茶', qty: 1, spec: '默认' },
      { mode: 'fixed', keyword: '中薯条', qty: 1, spec: '中' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1390, originalPriceCents: 2500,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 36 实证：圆筒冰淇淋 + 锡兰红茶 + 中薯条',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-yizao-meishi',
    name: '一早美式',
    matchNames: ['一早美式'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSign: 'GCCMCG55B4UYHPGA3WLLYR3CGE_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'GCCMCG55B4UYHPGA3WLLYR3CGE',
    items: [
      { mode: 'choice', keyword: '麦满分3选1', qty: 1, spec: '麦满分3选1', choiceRange: ['吉士蛋麦满分', '大脆鸡扒麦满分', '火腿扒麦满分'] },
      { mode: 'fixed', keyword: '中杯美式', qty: 1, spec: '中' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '早餐档期团购，以平台实时页为准' },
    priceCents: 1490, originalPriceCents: 2600,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 37 实证：麦满分3选1（吉士蛋/大脆鸡扒/火腿扒） + 中杯麦咖啡美式',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-tianxian-shuangpin-2',
    name: '【甜咸双拼】甜咸小食两件套单人餐',
    matchNames: ['【甜咸双拼】甜咸小食两件套单人餐', '甜咸小食两件套单人餐', '甜咸双拼小食两件套'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSign: 'Q3UJH4TMC7LSSMAZPJDEDZ3UUA_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'Q3UJH4TMC7LSSMAZPJDEDZ3UUA',
    items: [
      { mode: 'choice', keyword: '鸡翅2选1', qty: 1, spec: '鸡翅2选1', choiceRange: ['麦辣鸡翅', '薄皮焦香V翅'] },
      { mode: 'choice', keyword: '甜派2选1', qty: 1, spec: '甜派2选1', choiceRange: ['菠萝派', '香芋派'] },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1590, originalPriceCents: 2600,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 38 实证：鸡翅2选1（麦辣鸡翅2块/薄皮焦香V翅2块） + 派2选1（菠萝派/香芋派）',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-naitie-zuhe',
    name: '奶铁组合',
    matchNames: ['奶铁组合'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSign: 'TNDUEETTC34F3XZHQRIGQFBNZ4_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'TNDUEETTC34F3XZHQRIGQFBNZ4',
    items: [
      { mode: 'choice', keyword: '麦满分3选1', qty: 1, spec: '麦满分3选1', choiceRange: ['吉士蛋麦满分', '大脆鸡扒麦满分', '火腿扒麦满分'] },
      { mode: 'fixed', keyword: '中杯奶铁', qty: 1, spec: '中' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '早餐档期团购，以平台实时页为准' },
    priceCents: 1690, originalPriceCents: 2900,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 39 实证：麦满分3选1（吉士蛋/大脆鸡扒/火腿扒） + 中杯麦咖啡奶铁',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-zhaji-xiaoshi-2',
    name: '炸鸡小食2件自由拼',
    matchNames: ['炸鸡小食2件自由拼'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSign: 'SQSML2I647QX6EEQ57G776ANPQ_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'SQSML2I647QX6EEQ57G776ANPQ',
    items: [
      { mode: 'choice', keyword: '炸鸡3选2可重复', qty: 2, spec: '炸鸡3选1', choiceRange: ['麦辣鸡翅', '酥脆带骨里脊', '麦乐鸡'] },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1990, originalPriceCents: 3200,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 40 实证：3选2可重复（1对麦辣鸡翅/带骨里脊/5块麦乐鸡）',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-susu-duosunjuan-3',
    name: '酥酥多笋卷三件套',
    matchNames: ['酥酥多笋卷三件套'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSigns: [
      'DRF363OXYB5YF67J75XENDKLYQ_VE6Y7HURK7DIZNVIAXBHK2NAKA',
      'UFC6KYU5CFNNRSYY3C33LLEEUI_VE6Y7HURK7DIZNVIAXBHK2NAKA'
    ],
    skuViewIds: [
      'DRF363OXYB5YF67J75XENDKLYQ',
      'UFC6KYU5CFNNRSYY3C33LLEEUI'
    ],
    items: [
      { mode: 'fixed', keyword: '酥酥多笋卷', qty: 1, spec: '1份' },
      { mode: 'fixed', keyword: '小薯条', qty: 1, spec: '小' },
      { mode: 'fixed', keyword: '中可乐', qty: 1, spec: '中' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2090, originalPriceCents: 3600,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 41 实证：酥酥多笋卷 + 小薯条 + 中可乐',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-shu-nizuidap-afternoon',
    name: '薯你最搭下午茶',
    matchNames: ['薯你最搭下午茶'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSign: 'ISEDSLQHWRU4DH3FQ2V2PFLDEA_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'ISEDSLQHWRU4DH3FQ2V2PFLDEA',
    items: [
      { mode: 'choice', keyword: '炸鸡2选2可重复', qty: 2, spec: '炸鸡2选1', choiceRange: ['麦乐鸡', '麦辣鸡翅'] },
      { mode: 'choice', keyword: '饮品甜品2选1', qty: 1, spec: '饮品甜品2选1', choiceRange: ['圆筒冰淇淋', '小可乐'] },
      { mode: 'fixed', keyword: '小薯条', qty: 2, spec: '小' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 2990, originalPriceCents: 4800,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 42 实证：炸鸡2选2（5块麦乐鸡/2块麦辣鸡翅） + 饮品2选1（圆筒/小可乐） + 小薯条2份',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-shushu-maixuanfeng',
    name: '薯薯麦旋风',
    matchNames: ['薯薯麦旋风'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSign: 'JH6KKCSISOL4TPQSQZ6JXM6X3Y_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'JH6KKCSISOL4TPQSQZ6JXM6X3Y',
    items: [
      { mode: 'fixed', keyword: '中薯条', qty: 2, spec: '中' },
      { mode: 'choice', keyword: '麦旋风2选1', qty: 1, spec: '麦旋风2选1', choiceRange: ['奥利奥麦旋风', '草莓麦旋风'] },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 1990, originalPriceCents: 3500,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 45 实证：中薯条2份 + 麦旋风2选1（奥利奥麦旋风/草莓麦旋风）',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-peigen-shucui-single-3',
    name: '【麦乐送可用】培根蔬萃双层牛堡单人餐',
    matchNames: ['【麦乐送可用】培根蔬萃双层牛堡单人餐', '培根蔬萃双层牛堡单人餐'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（麦乐送/到店）',
    productViewSign: 'WFKQE2J6A5QWUITVBGMOHP6Z7Q_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'WFKQE2J6A5QWUITVBGMOHP6Z7Q',
    items: [
      { mode: 'fixed', keyword: '培根蔬萃双层牛堡', qty: 1, spec: '1个' },
      { mode: 'fixed', keyword: '中薯条', qty: 1, spec: '中' },
      { mode: 'fixed', keyword: '中可乐', qty: 1, spec: '中' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 3550, originalPriceCents: 4900,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '出示券码或麦乐送绑定核销（以券面说明为准）',
    evidence: '截图 Image 43 实证：培根蔬萃双层牛堡 + 中薯条 + 中可乐',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-busuzhiba-single-3',
    name: '【麦乐送可用】不素之霸双层牛堡单人餐',
    matchNames: ['【麦乐送可用】不素之霸双层牛堡单人餐', '不素之霸双层牛堡单人餐'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（麦乐送/到店）',
    productViewSign: 'Q5UZOTQJVYPCSIA5LBZA5HVS6A_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'Q5UZOTQJVYPCSIA5LBZA5HVS6A',
    items: [
      { mode: 'fixed', keyword: '不素之霸双层牛堡', qty: 1, spec: '1个' },
      { mode: 'fixed', keyword: '中薯条', qty: 1, spec: '中' },
      { mode: 'fixed', keyword: '中可乐', qty: 1, spec: '中' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 3650, originalPriceCents: 4900,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '出示券码或麦乐送绑定核销（以券面说明为准）',
    evidence: '信源交叉与麦乐送系列实证：不素之霸双层牛堡 + 中薯条 + 中可乐',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-juwuba-single-3',
    name: '【麦乐送可用】巨无霸单人餐',
    matchNames: ['【麦乐送可用】巨无霸单人餐', '巨无霸单人餐'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（麦乐送/到店）',
    productViewSign: 'W6DLJULDVMFYUA4INZJQCSHTU4_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'W6DLJULDVMFYUA4INZJQCSHTU4',
    items: [
      { mode: 'fixed', keyword: '巨无霸', qty: 1, spec: '1个' },
      { mode: 'fixed', keyword: '中薯条', qty: 1, spec: '中' },
      { mode: 'fixed', keyword: '中可乐', qty: 1, spec: '中' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 3650, originalPriceCents: 4900,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '出示券码或麦乐送绑定核销（以券面说明为准）',
    evidence: '截图 Image 46 官方备注实证：巨无霸*1 + 中薯条*1 + 中可乐*1',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-maila-single-3',
    name: '麦辣鸡腿堡单人餐',
    matchNames: ['麦辣鸡腿堡单人餐', '【麦乐送可用】麦辣鸡腿堡单人餐'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（麦乐送/到店）',
    productViewSign: 'U5BG5J3TMVVKBPNN5UPF6VAN74_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'U5BG5J3TMVVKBPNN5UPF6VAN74',
    items: [
      { mode: 'fixed', keyword: '麦辣鸡腿汉堡', qty: 1, spec: '1个' },
      { mode: 'fixed', keyword: '中薯条', qty: 1, spec: '中' },
      { mode: 'fixed', keyword: '中可乐', qty: 1, spec: '中' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 3350, originalPriceCents: 4600,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '出示券码或麦乐送绑定核销（以券面说明为准）',
    evidence: '截图 Image 47 官方备注实证：麦辣鸡腿堡*1 + 中薯条*1 + 中可乐*1',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-maixiangyu-single-3',
    name: '麦香鱼单人餐',
    matchNames: ['麦香鱼单人餐'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    productViewSign: 'TDK67P5PEQNUTXJQMJQ5QACMDE_VE6Y7HURK7DIZNVIAXBHK2NAKA',
    skuViewId: 'TDK67P5PEQNUTXJQMJQ5QACMDE',
    items: [
      { mode: 'fixed', keyword: '麦香鱼', qty: 1, spec: '1个' },
      { mode: 'fixed', keyword: '中薯条', qty: 1, spec: '中' },
      { mode: 'fixed', keyword: '中可乐', qty: 1, spec: '中' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 3300, originalPriceCents: 4400,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '经典三件套实证：麦香鱼 + 中薯条 + 中可乐',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-baobaoyu-manzu',
    name: '堡堡鱼满足',
    matchNames: ['堡堡鱼满足'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'fixed', keyword: '麦香鱼', qty: 3, spec: '1个' },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 3720, originalPriceCents: 6750,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 48 官方备注实证：麦香鱼*3',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  {
    id: 'rcp-maiba-jingdian-shuangren',
    name: '【鸡牛双拼】麦霸经典双人餐',
    matchNames: ['【鸡牛双拼】麦霸经典双人餐', '麦霸经典双人餐'],
    resolve: 'explicit',
    channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [
      { mode: 'choice', keyword: '牛堡2选1', qty: 1, spec: '牛堡2选1', choiceRange: ['巨无霸', '不素之霸双层牛堡'] },
      { mode: 'choice', keyword: '鸡堡2选1', qty: 1, spec: '鸡堡2选1', choiceRange: ['麦香鸡', '麦辣鸡腿汉堡'] },
      { mode: 'choice', keyword: '小食3选1', qty: 1, spec: '小食3选1', choiceRange: ['麦辣鸡翅', '中薯条', '麦乐鸡'] },
      { mode: 'choice', keyword: '小饮品3选2可重复', qty: 2, spec: '饮品3选1', choiceRange: ['小可乐', '锡兰红茶'] },
    ],
    conditions: { ...MEITUAN_INSTORE, expireNote: '档期团购，以平台实时页为准' },
    priceCents: 4690, originalPriceCents: 7450,
    buyPath: '美团 APP → 麦当劳门店团购页购买（下单页价格为准）',
    redeemPath: '到店出示券码核销（以券面说明为准）',
    evidence: '截图 Image 52 官方备注实证：巨无霸/不素之霸2选1 + 麦香鸡/麦辣鸡腿堡2选1 + 辣翅/中薯/麦乐鸡3选1 + 小可/无糖小可/红茶3选2',
    verifiedAt: '2026-10-17', ruleVersion: 'web-cross-v2', source: 'preset',
  },
  // ---------- v1.4.5：识图/网页核验后并入随包的显式构成（原仅存在于用户层，干净安装不可得） ----------
    {
    "id": "rcp-yuantong-sizhongzou-v1",
    "name": "圆筒四重奏",
    "matchNames": [
      "圆筒四重奏"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "圆筒冰淇淋",
        "qty": 4,
        "spec": "1个"
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 1500,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「圆筒四重奏」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：CPS 券面主图显示 4 支圆筒冰淇淋，券名「圆筒四重奏」；逐项映射官方单品「圆筒冰淇淋」×4。图片识读仅为候选，经人工确认后落库；构成证据 = 券面主图 + 官方菜单单品。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "7CSMQJ4TUKG4GQP65HAQXOA32I_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "7CSMQJ4TUKG4GQP65HAQXOA32I",
    "headUrl": "https://img.meituan.net/content/8f8582901fb47cb02c86f8b823532b58782560.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-shuangshu-shuangyuantong-v1",
    "name": "双薯双圆筒",
    "matchNames": [
      "双薯双圆筒"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "薯条",
        "qty": 2,
        "spec": "中份"
      },
      {
        "mode": "fixed",
        "keyword": "圆筒冰淇淋",
        "qty": 2,
        "spec": "1个"
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）；薯条规格券面未标注，按门店在售「薯条」单品映射"
    },
    "priceCents": 1990,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「双薯双圆筒」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：CPS 券面主图显示 2 盒薯条 + 2 支圆筒冰淇淋，券名「双薯双圆筒」；逐项映射官方单品「薯条」×2 + 「圆筒冰淇淋」×2。薯条规格券面未标注 → 不臆造大/中/小，按门店在售单品映射（规格以下单页为准）。图片识读仅为候选，经人工确认后落库。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "FBWI2EWILQC3RPDV3HRSLWWMF4_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "FBWI2EWILQC3RPDV3HRSLWWMF4",
    "headUrl": "https://img.meituan.net/content/c4617170c439ddbd893f82f31af77dbe424509.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-bingqilin-yumibei-v1",
    "name": "冰淇淋玉米杯",
    "matchNames": [
      "冰淇淋玉米杯"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "圆筒冰淇淋",
        "qty": 1,
        "spec": "1个"
      },
      {
        "mode": "fixed",
        "keyword": "玉米杯",
        "qty": 1,
        "spec": "1份"
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 1090,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「冰淇淋玉米杯」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：券面主图：1 支圆筒冰淇淋 + 1 杯玉米杯（券名「冰淇淋玉米杯」）。映射官方菜单单品；图片识读仅为候选，经逐项人工确认后落库。构成证据 = 券面主图 + 官方菜单单品。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "F7FJ2LEFYKEZ4WGBFXJV4QNZPQ_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "F7FJ2LEFYKEZ4WGBFXJV4QNZPQ",
    "headUrl": "https://p0.meituan.net/content/45d0bd39ef6cb4a1b16f61f838ddeaff750330.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-2-xindi-v1",
    "name": "2个新地【单个仅需6.5元】",
    "matchNames": [
      "2个新地【单个仅需6.5元】"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "新地",
        "qty": 2
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 1300,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「2个新地【单个仅需6.5元】」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：券面主图：2 杯新地（图注「新地任选*2」= 口味任选，同 SKU）；券名「2个新地」。映射官方菜单单品；图片识读仅为候选，经逐项人工确认后落库。构成证据 = 券面主图 + 官方菜单单品。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "EZ2IJIRKH5G4S7O5RE5XZ5ZYHQ_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "EZ2IJIRKH5G4S7O5RE5XZ5ZYHQ",
    "headUrl": "https://img.meituan.net/content/f42488827bb1e6acf14e6b1a9a75211d778852.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-zhongshutiao-maiyisongyi-v1",
    "name": "中薯条买一送一【仅麦当劳app核销】",
    "matchNames": [
      "中薯条买一送一【仅麦当劳app核销】"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "薯条",
        "qty": 2,
        "spec": "中"
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 1350,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「中薯条买一送一【仅麦当劳app核销】」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：券面主图：2 盒中薯条；券名「中薯条买一送一」= 买 1 送 1 → ×2。映射官方菜单单品；图片识读仅为候选，经逐项人工确认后落库。构成证据 = 券面主图 + 官方菜单单品。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "T3X3AJXLO75LGCPK3Q2AO36ERY_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "T3X3AJXLO75LGCPK3Q2AO36ERY",
    "headUrl": "https://img.meituan.net/content/c1303750c7a07566651bc0faab640978368571.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-10-kuai-maileji-v1",
    "name": "10块麦乐鸡",
    "matchNames": [
      "10块麦乐鸡"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "麦乐鸡",
        "qty": 2,
        "spec": "5块"
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 1400,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「10块麦乐鸡」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：券面主图：10 块麦乐鸡；官方菜单「麦乐鸡」= 5 块/份 → ×2（10÷5）。映射官方菜单单品；图片识读仅为候选，经逐项人工确认后落库。构成证据 = 券面主图 + 官方菜单单品。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "OIDB6JGRV3AEIIIMSRBTJT6FDY_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "OIDB6JGRV3AEIIIMSRBTJT6FDY",
    "headUrl": "https://img.meituan.net/content/0cb4502cbb2b82263efcd85359c365dd944249.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-2-maixuanfeng-v1",
    "name": "两个麦旋风【单个仅需7.5元】",
    "matchNames": [
      "两个麦旋风【单个仅需7.5元】"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "经典麦旋风",
        "qty": 2,
        "spec": "1个"
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 1500,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「两个麦旋风【单个仅需7.5元】」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：券面主图：2 杯奥利奥麦旋风；券名「两个麦旋风」→ ×2（经典款）。映射官方菜单单品；图片识读仅为候选，经逐项人工确认后落库。构成证据 = 券面主图 + 官方菜单单品。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "IVULXK7XK55XODLETMCX5FPFZI_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "IVULXK7XK55XODLETMCX5FPFZI",
    "headUrl": "https://img.meituan.net/content/b57aa1a211d38da2f41dfe1bc99b0052759474.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-maixiangji-3-v1",
    "name": "麦香鸡三件套",
    "matchNames": [
      "麦香鸡三件套"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "麦香鸡",
        "qty": 1
      },
      {
        "mode": "fixed",
        "keyword": "薯条",
        "qty": 1
      },
      {
        "mode": "fixed",
        "keyword": "可乐",
        "qty": 1
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 1990,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「麦香鸡三件套」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：券面主图：麦香鸡汉堡 + 薯条 + 可乐（三件套）；薯条/可乐规格券面未标注，按门店在售单品映射。映射官方菜单单品；图片识读仅为候选，经逐项人工确认后落库。构成证据 = 券面主图 + 官方菜单单品。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "5CKTSLEAFRQOEVW2RBIB5S2GPQ_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "5CKTSLEAFRQOEVW2RBIB5S2GPQ",
    "headUrl": "https://p0.meituan.net/content/07a346ac67fa9648832cda042dc5a7aa867276.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-2-dui-malajichi-v1",
    "name": "2对麦辣鸡翅",
    "matchNames": [
      "2对麦辣鸡翅"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "麦辣鸡翅",
        "qty": 2,
        "spec": "2块"
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 1990,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「2对麦辣鸡翅」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：券面主图：4 块麦辣鸡翅；官方菜单「麦辣鸡翅」= 1 对(2块)/份 → 2 对 = ×2。映射官方菜单单品；图片识读仅为候选，经逐项人工确认后落库。构成证据 = 券面主图 + 官方菜单单品。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "F3GTIJJR2E73BGFCWDG7KEHF2E_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "F3GTIJJR2E73BGFCWDG7KEHF2E",
    "headUrl": "https://img.meituan.net/content/fab1801598aefb45b96bd9d96fa588a11028699.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-xiantian-sanpin-v1",
    "name": "咸甜三拼超值组合",
    "matchNames": [
      "咸甜三拼超值组合"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "薯条",
        "qty": 1
      },
      {
        "mode": "fixed",
        "keyword": "经典麦旋风",
        "qty": 1
      },
      {
        "mode": "fixed",
        "keyword": "麦乐鸡",
        "qty": 1
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 1990,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「咸甜三拼超值组合」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：券面主图：薯条 + 麦旋风 + 麦乐鸡(5块)；券名「咸甜三拼超值组合」。映射官方菜单单品；图片识读仅为候选，经逐项人工确认后落库。构成证据 = 券面主图 + 官方菜单单品。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "SDLZT56SVIRCEACLDLUF7K3B4E_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "SDLZT56SVIRCEACLDLUF7K3B4E",
    "headUrl": "https://img.meituan.net/content/0a2f7c62280c459b631a4917b7965b36922378.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-xiantian-sanpin-b-v1",
    "name": "【麦麦新吃法】咸甜三拼超值组合",
    "matchNames": [
      "【麦麦新吃法】咸甜三拼超值组合"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "薯条",
        "qty": 1
      },
      {
        "mode": "fixed",
        "keyword": "经典麦旋风",
        "qty": 1
      },
      {
        "mode": "fixed",
        "keyword": "麦乐鸡",
        "qty": 1
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 1990,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「【麦麦新吃法】咸甜三拼超值组合」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：券面主图（副标题「麦乐鸡薯条麦旋风组合」）：薯条 + 麦旋风 + 麦乐鸡(5块)。映射官方菜单单品；图片识读仅为候选，经逐项人工确认后落库。构成证据 = 券面主图 + 官方菜单单品。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "TH6SMXW64YAHGRPWIYLZKOH2OQ_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "TH6SMXW64YAHGRPWIYLZKOH2OQ",
    "headUrl": "https://p0.meituan.net/content/854af62168f4d1f87db66ab4b0dcc07d846318.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-shuangshu-shuangle-v1",
    "name": "双薯双乐",
    "matchNames": [
      "双薯双乐"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "薯条",
        "qty": 2
      },
      {
        "mode": "fixed",
        "keyword": "可乐",
        "qty": 2
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 2350,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「双薯双乐」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：券面主图：2 盒薯条 + 2 杯可乐；券名「双薯双乐」。映射官方菜单单品；图片识读仅为候选，经逐项人工确认后落库。构成证据 = 券面主图 + 官方菜单单品。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "PBGAK5MIHS4SVATPYAKUJJBYGA_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "PBGAK5MIHS4SVATPYAKUJJBYGA",
    "headUrl": "https://img.meituan.net/content/df28b554c9c175cb57193349299365b7454280.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-shuangshu-shuangmaileji-v1",
    "name": "双薯双麦乐鸡",
    "matchNames": [
      "双薯双麦乐鸡"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "薯条",
        "qty": 2
      },
      {
        "mode": "fixed",
        "keyword": "麦乐鸡",
        "qty": 2
      }
    ],
    "conditions": {
      "orderType": "instore",
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 2690,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「双薯双麦乐鸡」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：券面主图：2 盒薯条 + 10 块麦乐鸡（5 块/份 → ×2）；券名「双薯双麦乐鸡」。映射官方菜单单品；图片识读仅为候选，经逐项人工确认后落库。构成证据 = 券面主图 + 官方菜单单品。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "WRSHC7HGZAUFBQIBWNTDC5MO5E_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "WRSHC7HGZAUFBQIBWNTDC5MO5E",
    "headUrl": "https://img.meituan.net/content/dd3acb4e4f1233be203731efdc00b277452190.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-paipai-sizhongzou-v1",
    "name": "派派四重奏",
    "matchNames": [
      "派派四重奏"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "items": [
      {
        "mode": "fixed",
        "keyword": "派",
        "qty": 4
      }
    ],
    "conditions": {
      "orderType": "instore",
      "noStack": true,
      "noPoints": true,
      "expireNote": "多店通用·仅到店（券面图）"
    },
    "priceCents": 1500,
    "originalPriceCents": 0,
    "buyPath": "美团 App 搜索「派派四重奏」到店团购（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "识图核验 2026-10-15：CPS 券面主图标注「派任选*4」，¥15。官方菜单将派类合并为单一 SKU「派」(code 9900008752)，故按官方粒度映射为 派×4；派营养取自补录层（官网营养计算器·香芋派）。",
    "verifiedAt": "2026-10-15",
    "ruleVersion": "vision-manual-v1",
    "productViewSign": "4VEOJCGCX2OWTHGVXUGQYYYNQE_DI5IN6MNTCOVEYOLW7RDMFWZLI",
    "skuViewId": "4VEOJCGCX2OWTHGVXUGQYYYNQE",
    "headUrl": "https://img.meituan.net/content/cc4fffb10d219e9ff0da486adcc1c4c5979952.jpg",
    "source": "preset"
  },
    {
    "id": "rcp-namedajipai-single",
    "name": "那么大鸡排",
    "matchNames": [
      "那么大鸡排",
      "那么大鸡排（椒盐风味）"
    ],
    "resolve": "explicit",
    "channel": "meituan",
    "channelLabel": "美团团购（到店）",
    "productViewSign": "3XNKCWPVVN4R44V6TJ5BH3DNR4_VE6Y7HURK7DIZNVIAXBHK2NAKA",
    "skuViewId": "3XNKCWPVVN4R44V6TJ5BH3DNR4",
    "items": [
      {
        "mode": "fixed",
        "keyword": "那么大鸡排",
        "qty": 1,
        "spec": "1份"
      }
    ],
    "conditions": {
      "orderType": "instore",
      "noStack": true,
      "noPoints": true,
      "expireNote": "档期团购，以平台实时页为准"
    },
    "priceCents": 1090,
    "originalPriceCents": 1500,
    "buyPath": "美团 APP → 麦当劳门店团购页购买（下单页价格为准）",
    "redeemPath": "到店出示券码核销（以券面说明为准）",
    "evidence": "券名直译与官方同名单品核验：标准那么大鸡排（椒盐风味）1份",
    "verifiedAt": "2026-10-17",
    "ruleVersion": "web-cross-v2",
    "source": "preset"
  },
];

// ---------- 用户层持久化（核验后录入 / 导入 / 修订；读写分离，写只落用户数据目录） ----------

function recipeFilePath(): string {
  return join(getLayout().userHome, 'voucher-recipes.json');
}

interface RecipeFile { version: 1; recipes: VoucherRecipe[]; updatedAt: string }

let userCache: RecipeFile | null = null;
let userStamp = '';

/** 直接从磁盘重读（忽略内存缓存）——**每次变更前必须调用**，避免用旧快照覆盖其它进程的新记录（v1.4.4 R12）
 *  v1.4.8 R12：写路径用严格读取——损坏 JSON / 结构错误抛 E_STORAGE_CORRUPT，不再当空库覆盖。 */
function readUserFileFromDisk(): RecipeFile {
  const raw = readJsonFile<Partial<RecipeFile>>(recipeFilePath());
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, recipes: [], updatedAt: '' };
  return { version: 1, recipes: Array.isArray(raw.recipes) ? raw.recipes : [], updatedAt: raw.updatedAt ?? '' };
}

/** 写入口专用：区分「不存在（可首建）」与「损坏/结构错误（拒绝覆盖）」。 */
function readUserFileFromDiskStrict(): RecipeFile {
  const path = recipeFilePath();
  const raw = readJsonFileForWrite<unknown>(path, '配方库');
  if (raw === null) return { version: 1, recipes: [], updatedAt: '' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UserStoreError(path, 'shape', `配方库结构无效（${path}）：顶层应为对象。为避免覆盖可恢复资料，本次保存已取消。`, 'E_STORAGE_CORRUPT');
  }
  const rec = raw as Partial<RecipeFile>;
  if (rec.recipes !== undefined && !Array.isArray(rec.recipes)) {
    throw new UserStoreError(path, 'shape', `配方库结构无效（${path}）：recipes 应为数组。为避免覆盖可恢复资料，本次保存已取消。`, 'E_STORAGE_CORRUPT');
  }
  return { version: 1, recipes: Array.isArray(rec.recipes) ? rec.recipes : [], updatedAt: rec.updatedAt ?? '' };
}

/** 只读路径（v1.4.7 R12）：按文件指纹（mtime+size）判断缓存是否过期。
 *  旧实现 `??=` 读一次就永久缓存——CLI/Agent 子进程新写入的配方，面板父进程看不到。 */
function loadUserFile(): RecipeFile {
  const p = recipeFilePath();
  const stamp = fileStamp(p);
  if (!userCache || stamp !== userStamp) {
    userCache = readUserFileFromDisk();
    userStamp = stamp;
  }
  return userCache;
}

/** 写前重读：把内存态同步为磁盘最新版本（v1.4.4 R12 跨进程丢更新的直接修复点） */
function reloadUserFile(): RecipeFile {
  userCache = readUserFileFromDiskStrict();
  userStamp = fileStamp(recipeFilePath());
  return userCache;
}

/** 落盘（v1.4.7 R13）：失败抛 E_STORAGE，调用方不得回「已保存」。 */
function flush(): void {
  if (!userCache) return;
  userCache.updatedAt = new Date().toISOString();
  writeJsonAtomic(recipeFilePath(), userCache);
  userStamp = fileStamp(recipeFilePath());
}

/** 变更入口：跨进程互斥 → 重读磁盘最新 → 变更 → 原子落盘（v1.4.4 R12）。
 *  旧实现直接改内存缓存再 flush，会把其它进程期间写入的记录整段覆盖。 */
function mutateUserFile<T>(mutate: (file: RecipeFile) => T): T {
  return withUserFileLock(recipeFilePath(), () => {
    const file = reloadUserFile();
    const out = mutate(file);
    flush();
    return out;
  });
}

/** 预置配方构成指纹（v1.4.7 R06）：用于判断用户层条目是否仍与当前种子同源。 */
function recipeSeedHash(r: Pick<VoucherRecipe, 'items' | 'ruleVersion'>): string {
  return createHash('sha1').update(JSON.stringify({ rv: r.ruleVersion ?? '', items: r.items })).digest('hex').slice(0, 16);
}

/** 配方条目身份签名（不含任选范围）：用于判断用户层条目是否只是种子的旧副本。 */
function recipeItemCoreSig(it: VoucherRecipe['items'][number]): string {
  return [it.mode, it.keyword, it.qty, it.spec ?? '', it.comboName ?? '', it.fulfillCode ?? ''].join('~');
}

/** 用户是否显式缩窄了某个任选范围（种子真子集）——这是用户修订，不得被种子迁移覆盖。 */
function userNarrowedChoiceRange(preset: VoucherRecipe, user: VoucherRecipe): boolean {
  for (const u of user.items) {
    const p = preset.items.find((pi) => recipeItemCoreSig(pi) === recipeItemCoreSig(u));
    if (!p) continue;
    const pr = p.choiceRange ?? [];
    const ur = u.choiceRange ?? [];
    if (ur.length > 0 && pr.length > 0 && ur.length < pr.length && ur.every((x) => pr.includes(x))) return true;
  }
  return false;
}

/** v1.4.6 R06 / v1.4.7 R06：识别「系统导入副本」——同 id、同 ruleVersion、证据文本同源，
 *  且用户条目没有新增/替换食品、没有删减条目、没有缩窄任选范围。
 *  这类条目应跟随种子更新（否则历史副本会永久压住后续调查修正）；真正的用户修订不动。 */
function isSystemImportCopy(preset: VoucherRecipe, user: VoucherRecipe): boolean {
  if (user.seedMeta?.userEdited === true) return false;      // 明确标记过用户修改 → 永不迁移
  if ((preset.ruleVersion ?? '') !== (user.ruleVersion ?? '')) return false;
  const normEv = (s?: string): string => (s ?? '').replace(/\s+/g, '');
  const ue = normEv(user.evidence), pe = normEv(preset.evidence);
  if (!ue || !pe) return false;
  if (ue !== pe && !ue.includes(pe)) return false;
  // 用户主动删减条目 → 是用户修订，不是系统旧副本
  if (user.items.length < preset.items.length) return false;
  if (userNarrowedChoiceRange(preset, user)) return false;
  const presetSigs = new Set(preset.items.map(recipeItemCoreSig));
  return user.items.length > 0 && user.items.every((it) => presetSigs.has(recipeItemCoreSig(it)));
}

/** 合并：保留用户层字段（来源、别名、适用范围等），构成与证据以种子为准并标注迁移。 */
function mergeSystemImportCopy(preset: VoucherRecipe, user: VoucherRecipe): VoucherRecipe | null {
  if (!isSystemImportCopy(preset, user)) return null;
  if (JSON.stringify(preset.items) === JSON.stringify(user.items)) return null;
  return {
    ...preset,
    ...user,
    items: preset.items,
    evidence: `${preset.evidence}；已按最新调查证据补齐选项（用户层系统导入副本迁移，保留用户其它字段）`,
    seedMeta: { ...(user.seedMeta ?? {}), seedVersion: preset.ruleVersion, seedHash: recipeSeedHash(preset), userEdited: false, updatedAt: new Date().toISOString() },
  };
}

/** 全部配方：用户层优先（同 id 覆盖预置），预置兜底。
 *  v1.4.6 R06：同 id 的系统导入副本先与种子做定向迁移（补齐后续调查修正的选项），再覆盖预置。
 *  v1.4.7 R05：被用户撤销的配方不再出现在匹配库中（撤销记录随文件跨进程可见）。 */
export function loadRecipes(): VoucherRecipe[] {
  const user = loadUserFile();
  const byId = new Map<string, VoucherRecipe>();
  for (const r of PRESET_RECIPES) byId.set(r.id, r);
  for (const r of user.recipes) {
    const preset = byId.get(r.id);
    byId.set(r.id, (preset ? mergeSystemImportCopy(preset, r) : null) ?? r);
  }
  return [...byId.values()].filter((r) => !isRecipeRevoked(r.id));
}

/** 配方匹配上下文（v1.4.4 R03）：商品身份 + 适用范围。
 *  商品身份**优先于券名**——productViewSign / skuViewId 是联盟侧商品标识，
 *  同名不同 ID 的券必须靠 ID 区分；绝不允许「券名相同即视为同一张券」。 */
export interface RecipeMatchContext {
  /** 联盟商品 productViewSign（A_B 段） */
  productViewSign?: string;
  /** 联盟 skuViewId（与 productViewSign 是不同值；绝不互相填充） */
  skuViewId?: string;
  /** 当前城市（用于 scope.city 过滤） */
  city?: string;
  /** 当前门店 code（用于 scope.stores 过滤） */
  storeCode?: string;
}

/** 证据强度档位（同档 = 同级候选；跨档允许逐档回退，同档构成冲突必须阻断） */
export function recipeTier(r: VoucherRecipe): number {
  return r.resolve === 'combo-name' ? 0 : r.resolve === 'explicit' ? 1 : 2;
}

/** 配方构成签名（v1.4.4 R03）：用于判定同级候选是否**构成不同**。
 *  同签名 = 同一套构成（不构成冲突）；不同签名 = 券面内容无法唯一确定 → 必须阻断。 */
export function recipeCompositionSignature(r: VoucherRecipe): string {
  return r.items
    .map((it) => [it.mode, it.keyword, it.qty, it.spec ?? '', it.comboName ?? '', it.fulfillCode ?? '', (it.choiceRange ?? []).join('+')].join('~'))
    .join('|');
}

/** 名称匹配配方（归一化全名一致；别名命中）——返回**证据强度最高**的一条。 */
export function matchRecipe(name: string, recipes: VoucherRecipe[] = loadRecipes(), ctx: RecipeMatchContext = {}): VoucherRecipe | null {
  return matchRecipeCandidates(name, recipes, ctx)[0] ?? null;
}

/** 券名匹配的全部候选配方，按**证据强度**排序，供核验期逐档回退。
 *
 *  v1.4.3：同一券名可能同时命中多条配方（例如「麦香鸡三件套」既有预置的 combo-name 占位，
 *  又有用户层识图核验的 explicit 构成）。原实现只取一条，任一档失效即整券判未核验。
 *  改为候选链后，核验按证据强度逐档尝试：
 *    ① combo-name —— 官方同名套餐整包（官方产品定义，最强）
 *    ② explicit   —— 券面逐项核验构成（券面主图 + 官方单品）
 *    ③ pattern    —— 券名即产品规则（随心配类）
 *  同档内用户层（已核验、带证据）优先于预置层（占位）。
 *
 *  v1.4.4 R03：候选先经**身份与适用范围**过滤，再排序：
 *    - 配方声明了 productViewSign / skuViewId 且与当前券不一致 → 排除（同名不同 ID 不得串用）；
 *    - 配方声明了 scope.city / scope.stores 且当前上下文不在范围内 → 排除
 *      （门店限定配方在无门店上下文时同样排除——宁可保留价格候选，不跨店复用）；
 *    - 同 ID 精确命中的配方排在仅名称命中的配方之前（身份优先于名称）。
 */
export function matchRecipeCandidates(name: string, recipes: VoucherRecipe[] = loadRecipes(), ctx: RecipeMatchContext = {}): VoucherRecipe[] {
  const n = normVoucherName(name);
  if (n.length < 2) return [];
  const rank = (r: VoucherRecipe): number => {
    const byResolve = recipeTier(r);
    const byLayer = r.source === 'user' ? 0 : 1;
    return byResolve * 2 + byLayer;
  };
  const identityHit = (r: VoucherRecipe): boolean => {
    const skuList = [r.skuViewId, ...(r.skuViewIds ?? [])].filter(Boolean) as string[];
    const signList = [r.productViewSign, ...(r.productViewSigns ?? [])].filter(Boolean) as string[];
    return (!!ctx.skuViewId && skuList.includes(ctx.skuViewId))
      || (!!ctx.productViewSign && signList.some((s) => s === ctx.productViewSign || s.split('_')[0] === ctx.productViewSign!.split('_')[0]));
  };
  return recipes
    .filter((r) => !isRecipeRevoked(r.id))   // v1.4.7 R05：用户撤销的配方不参与匹配
    .filter((r) => normVoucherName(r.name) === n || r.matchNames.some((m) => normVoucherName(m) === n))
    // ① 商品身份：声明了 ID 且与当前券不一致 → 排除（未声明 ID 的配方无法据此排除）
    .filter((r) => {
      const skuList = [r.skuViewId, ...(r.skuViewIds ?? [])].filter(Boolean) as string[];
      const signList = [r.productViewSign, ...(r.productViewSigns ?? [])].filter(Boolean) as string[];

      const sameSku = (ctx.skuViewId && skuList.includes(ctx.skuViewId))
        || (ctx.productViewSign && signList.some((s) => s.split('_')[0] === ctx.productViewSign!.split('_')[0]));
      if (sameSku) return true;

      if (skuList.length > 0 && ctx.skuViewId && !skuList.includes(ctx.skuViewId)) return false;
      if (signList.length > 0 && ctx.productViewSign) {
        const ctxPrefix = ctx.productViewSign.split('_')[0];
        if (!signList.some((s) => s.split('_')[0] === ctxPrefix)) return false;
      }
      return true;
    })
    // ② 适用范围（v1.4.5 W06 用户口径）：**城市召回保留**；具体门店字段只作元数据，
    //    不做硬过滤——同一券配方在不同 storeCode 下仍应匹配同一商品与食品结构。
    //    门店适用性未经平台数据核验，一律显示「未校验具体适用门店」，不宣称全国/跨店通用。
    .filter((r) => {
      const sc = r.scope;
      if (!sc) return true;
      if (sc.city && normVoucherName(sc.city) !== normVoucherName(ctx.city ?? '')) return false;
      return true;
    })
    // ③ 身份精确命中优先，其后按证据强度；Array.prototype.sort 稳定，同秩保持原相对顺序
    .sort((a, b) => (Number(identityHit(b)) - Number(identityHit(a))) || (rank(a) - rank(b)));
}

/** 配方身份冲突（v1.4.7 R01）：同 id 但商品身份不同——拒绝静默覆盖。 */
export class RecipeConflictError extends Error {
  readonly code = 'E_RECIPE_CONFLICT';
  constructor(readonly recipeId: string, readonly existingName: string, message: string) {
    super(message);
  }
}

/** 两条配方是否指向不同商品（身份判定：CPS 商品 ID 优先，其次归一化券名）。
 *  同 id 且身份不同 = 覆盖风险；同名不同 id 允许并存（各自保留，匹配期按证据强度排序）。 */
function recipeIdentityConflict(a: VoucherRecipe, b: VoucherRecipe): boolean {
  const signs = (r: VoucherRecipe): string[] => [r.productViewSign, ...(r.productViewSigns ?? [])].filter(Boolean) as string[];
  const skus = (r: VoucherRecipe): string[] => [r.skuViewId, ...(r.skuViewIds ?? [])].filter(Boolean) as string[];
  const sa = signs(a), sb = signs(b);
  if (sa.length > 0 && sb.length > 0 && !sa.some((x) => sb.includes(x))) return true;
  const ka = skus(a), kb = skus(b);
  if (ka.length > 0 && kb.length > 0 && !ka.some((x) => kb.includes(x))) return true;
  return normVoucherName(a.name) !== normVoucherName(b.name);
}

/** 核验后录入 / 修订（同 id 覆盖）。
 *  v1.4.7 R01：同 id 但商品身份不同 → 抛 E_RECIPE_CONFLICT（旧实现无条件按 id 覆盖，
 *  两张中文券被 slug 成同一个 `rcp--v1` 时，后保存的把前一条静默替换掉）。
 *  身份相同的重复保存视为更新（幂等）。修订已有条目请显式传 allowReplace。 */
export function saveRecipe(recipe: VoucherRecipe, opts: { allowReplace?: boolean } = {}): void {
  const preset = PRESET_RECIPES.find((r) => r.id === recipe.id);
  const rec: VoucherRecipe = {
    ...recipe,
    source: recipe.source === 'preset' ? 'user' : (recipe.source ?? 'user'),
    // v1.4.7 R06：记录种子来源与「用户是否改过构成」——迁移判定不再依赖证据文本猜测
    ...(preset ? {
      seedMeta: {
        seedVersion: preset.ruleVersion,
        seedHash: recipeSeedHash(preset),
        userEdited: JSON.stringify(recipe.items) !== JSON.stringify(preset.items),
        updatedAt: new Date().toISOString(),
      },
    } : {}),
  };
  mutateUserFile((user) => {
    const idx = user.recipes.findIndex((r) => r.id === rec.id);
    const existing = idx >= 0 ? user.recipes[idx] : preset;
    if (existing && !opts.allowReplace && recipeIdentityConflict(existing, rec)) {
      throw new RecipeConflictError(rec.id, existing.name,
        `配方 ID「${rec.id}」已被「${existing.name}」占用，本次提交的是「${rec.name}」：同 ID 不同商品不得静默覆盖。` +
        '请换一个能区分商品的 ID（含来源/商品标识），或先删除原配方。');
    }
    if (idx >= 0) user.recipes[idx] = rec; else user.recipes.push(rec);
  });
  // 重新保存 = 提供新证据 → 解除撤销记录（恢复可用）
  clearRevocation(rec.id);
}

/** 批量导入（数组或 {recipes:[...]}；非法项跳过并计数）。
 *  v1.4.7 R04：商品身份数组（productViewSigns / skuViewIds）与结构化补差原样保留——
 *    旧实现只透传单值 ID，经 Agent 导入后「不同商品 ID 也能匹配同一配方」。
 *  v1.4.7 R01：同 id 但商品身份不同 → 跳过并计数（不静默覆盖）。 */
export function importRecipes(input: unknown): { imported: number; skipped: number; conflicts: Array<{ id: string; name: string; reason: string }> } {
  const arr = Array.isArray(input) ? input : (input && typeof input === 'object' && Array.isArray((input as { recipes?: unknown[] }).recipes) ? (input as { recipes: unknown[] }).recipes : null);
  if (!arr) return { imported: 0, skipped: 0, conflicts: [] };
  let imported = 0, skipped = 0;
  const conflicts: Array<{ id: string; name: string; reason: string }> = [];
  const cleared: string[] = [];
  mutateUserFile((user) => {
    for (const raw of arr) {
      const r = raw as Partial<VoucherRecipe>;
      if (!r || typeof r.id !== 'string' || typeof r.name !== 'string' || !Array.isArray(r.items) || r.items.length === 0) { skipped++; continue; }
      const rec: VoucherRecipe = {
        id: r.id, name: r.name, matchNames: Array.isArray(r.matchNames) ? r.matchNames : [r.name],
        resolve: (r.resolve === 'combo-name' || r.resolve === 'pattern' || r.resolve === 'explicit') ? r.resolve : 'explicit',
        channel: (r.channel ?? 'meituan') as VoucherChannel, channelLabel: r.channelLabel ?? '美团团购（到店）',
        items: r.items as VoucherRecipeItem[], conditions: (r.conditions ?? { orderType: 'instore' }) as VoucherConstraints,
        priceCents: Number(r.priceCents) || 0, originalPriceCents: Number(r.originalPriceCents) || 0,
        buyPath: r.buyPath ?? '（以平台页面为准）', redeemPath: r.redeemPath ?? '（以券面说明为准）',
        evidence: r.evidence ?? '导入配方（证据待补充）', verifiedAt: r.verifiedAt ?? new Date().toISOString().slice(0, 10),
        ruleVersion: r.ruleVersion ?? 'imported-v1', source: 'imported',
        ...(typeof r.productViewSign === 'string' ? { productViewSign: r.productViewSign } : {}),
        ...(typeof r.skuViewId === 'string' ? { skuViewId: r.skuViewId } : {}),
        ...(Array.isArray(r.productViewSigns) ? { productViewSigns: r.productViewSigns.filter((x): x is string => typeof x === 'string') } : {}),
        ...(Array.isArray(r.skuViewIds) ? { skuViewIds: r.skuViewIds.filter((x): x is string => typeof x === 'string') } : {}),
        ...(typeof r.headUrl === 'string' ? { headUrl: r.headUrl } : {}),
        ...(r.scope ? { scope: r.scope } : {}), ...(r.binding ? { binding: r.binding } : {}),
        ...(r.seedMeta ? { seedMeta: r.seedMeta } : {}),
      };
      const idx = user.recipes.findIndex((x) => x.id === rec.id);
      const existing = idx >= 0 ? user.recipes[idx] : PRESET_RECIPES.find((x) => x.id === rec.id);
      if (existing && recipeIdentityConflict(existing, rec)) {
        conflicts.push({ id: rec.id, name: rec.name, reason: `同 ID 已被「${existing.name}」占用（不同商品身份）` });
        skipped++;
        continue;
      }
      if (idx >= 0) user.recipes[idx] = rec; else user.recipes.push(rec);
      cleared.push(rec.id);
      imported++;
    }
  });
  for (const id of cleared) clearRevocation(id);
  return { imported, skipped, conflicts };
}

/** 修订（浅合并 patch；返回是否命中）。v1.4.7 R06：用户显式修订 → seedMeta.userEdited=true，
 *  该条目此后不再按种子迁移（用户删掉/替换的选项不得被「最新调查证据」自动恢复）。 */
export function reviseRecipe(id: string, patch: Partial<VoucherRecipe>): boolean {
  const hit = mutateUserFile((user) => {
    const idx = user.recipes.findIndex((r) => r.id === id);
    const base = idx >= 0 ? user.recipes[idx] : PRESET_RECIPES.find((r) => r.id === id);
    if (!base) return false;
    const preset = PRESET_RECIPES.find((r) => r.id === id);
    const next: VoucherRecipe = {
      ...base, ...patch, id, source: 'user',
      ...(preset ? {
        seedMeta: {
          seedVersion: preset.ruleVersion,
          seedHash: recipeSeedHash(preset),
          userEdited: true,
          updatedAt: new Date().toISOString(),
        },
      } : {}),
    };
    if (idx >= 0) user.recipes[idx] = next; else user.recipes.push(next);
    return true;
  });
  if (hit) clearRevocation(id);
  return hit;
}

/** 测试钩子：清空用户层内存缓存（隔离测试用） */
export function _resetRecipeCache(): void { userCache = null; }

// ---------- 配方 → 求解/核验 ----------

/** 展开后的食品单位数（combo-ref 按官方套餐轮次数；fixed/choice 按 qty）。
 *  用于准入判定——不得用「引用条数」代替「食品数量」。 */
export function recipeFoodUnits(items: VoucherItemRef[], menu: MenuLoadResult): number {
  let n = 0;
  for (const it of items) {
    const q = Math.max(1, it.qty);
    if (it.mode === 'combo-ref') {
      const combo = menu.items.find((x) => x.isCombo && (x.code === it.keyword || normVoucherName(x.name) === normVoucherName(it.keyword)));
      n += Math.max(0, combo?.deconstruction?.length ?? 0) * q;
    } else {
      n += q;
    }
  }
  return n;
}

/** 配方 → Voucher（价格可由实时团单覆盖；组成来自配方） */
export function recipeToVoucher(r: VoucherRecipe, priceOverrideCents?: number): import('./vouchers.js').Voucher {
  return {
    id: `rcp-${r.id}`,
    channel: r.channel, channelLabel: r.channelLabel, kind: 'combo',
    name: r.name,
    priceCents: priceOverrideCents ?? r.priceCents,
    originalPriceCents: r.originalPriceCents,
    items: r.items.map((it) => ({
      mode: it.mode, keyword: it.keyword, qty: it.qty,
      ...(it.comboName ? { comboName: it.comboName } : {}),
      ...(it.spec ? { spec: it.spec } : {}),
      ...(it.choiceRange ? { choiceRange: it.choiceRange } : {}),
      ...(it.surcharge ? { surcharge: it.surcharge } : {}),
      ...(it.optionDiffs ? { optionDiffs: { ...it.optionDiffs } } : {}),
      ...(it.fulfillCode ? { fulfillCode: it.fulfillCode } : {}),
    })),
    constraints: r.conditions,
    buyPath: r.buyPath, redeemPath: r.redeemPath,
    verifiedAt: r.verifiedAt, source: r.source === 'preset' ? 'preset' : 'user',
    evidence: `券配方库（${r.ruleVersion}，核验 ${r.verifiedAt}）：${r.evidence}`,
    notes: [`配方规则版本 ${r.ruleVersion}`],
    binding: { recipeId: r.id, ruleVersion: r.ruleVersion, ...(r.binding?.comboCode ? { comboCode: r.binding.comboCode } : {}), ...(r.binding?.roundIds && r.binding.roundIds.length ? { roundIds: r.binding.roundIds } : {}) },
  };
}

// ---------- 配方核验（核验入口的判定核心）：识图/导入的配方必须逐项可追溯 ----------

/** 单个条目的核验结论 */
export interface RecipeCheckItem {
  index: number;
  keyword: string;
  mode: 'fixed' | 'choice' | 'combo-ref';
  qty: number;
  /** 该条目是否有可追溯的构成依据 */
  structural: 'name-hit' | 'official-sku-bound' | 'needs-store-context' | 'none';
  /** 营养是否已解析（choice/combo-ref 在无门店上下文时可能为 unknown，但不算违规） */
  nutrition: 'known' | 'partial' | 'estimated' | 'unknown';
  nutritionUnknownFields?: string[];
  nutritionEstimated?: boolean;
  nutritionSource?: string;
  note: string;
}

/** 配方核验报告 */
export interface RecipeCheck {
  ok: boolean;                 // 无阻断项
  items: RecipeCheckItem[];
  /** 阻断项索引（必须处理，否则不写库） */
  blocking: number[];
  /** 告警项索引（可写库但须记录在证据里） */
  warnings: number[];
}

/**
 * 核验一条配方。
 *
 * 判定口径（诚实优先，绝不把「说不清」当成通过）：
 *  - fixed：条目必须能解析到营养来源（官网库或补录层）；解析不到 = 阻断。
 *  - choice：范围来自官方 SKU 轮次，必须已绑定官方 SKU（binding.comboCode 或 binding.roundIds
 *    或 resolve='pattern' 且存在同名词条佐证），否则「任选范围」无依据 = 阻断。
 *  - combo-ref：券构成 = 官方同名套餐构成，需门店菜单上下文才能展开；无上下文时降级为
 *    「待门店核验」告警（不阻断），但要求券名与官方套餐名的归一化匹配关系被记录在证据里。
 *
 * 注意：本函数只做**结构与营养可追溯性**判定，不替代求解期的门店映射（voucherSlots 仍会逐项核验）。
 */
export function validateRecipe(recipe: VoucherRecipe): RecipeCheck {
  const items: RecipeCheckItem[] = [];
  const blocking: number[] = [];
  const warnings: number[] = [];
  const hasSkuBinding = !!(recipe.binding?.comboCode || (recipe.binding?.roundIds && recipe.binding.roundIds.length > 0));

  recipe.items.forEach((ref, index) => {
    const base = { index, keyword: ref.keyword, mode: ref.mode, qty: Math.max(1, Number(ref.qty) || 1) };
    if (ref.mode === 'fixed') {
      const resolved = resolveFixedVoucherFood(ref);
      if (!resolved) {
        items.push({ ...base, structural: 'none', nutrition: 'unknown', note: '固定品项未解析到营养来源（官网库与补录层均未收录），需先补录营养或修正品名' });
        blocking.push(index);
        return;
      }
      const unknownFields = resolved.unknownFields ?? [];
      const nutritionEstimated = resolved.valueKind === 'estimate' || !!resolved.nutritionEstimated;
      items.push({
        ...base, structural: 'name-hit', nutrition: unknownFields.length ? 'partial' : nutritionEstimated ? 'estimated' : 'known',
        ...(unknownFields.length ? { nutritionUnknownFields: unknownFields } : {}),
        ...(nutritionEstimated ? { nutritionEstimated: true } : {}),
        nutritionSource: resolved.nutritionSource,
        note: `固定品项构成明确（qty=${base.qty}），营养来源：${resolved.nutritionSource ?? '未知'}${unknownFields.length ? `；未收录字段：${unknownFields.join('/')}` : ''}${nutritionEstimated ? '；数值为估算，仅供参考' : ''}`,
      });
      if (unknownFields.length || nutritionEstimated) warnings.push(index);
      return;
    }
    if (ref.mode === 'choice') {
      const hasDirectRange = Array.isArray(ref.choiceRange) && ref.choiceRange.length > 0;
      if (!hasSkuBinding && !hasDirectRange) {
        items.push({ ...base, structural: 'none', nutrition: 'unknown', note: '品类任选条目未绑定官方 SKU 轮次且未声明具体可选范围，任选范围无依据（不得凭券名猜测范围）' });
        blocking.push(index);
        return;
      }
      if (hasDirectRange && !hasSkuBinding) {
        items.push({
          ...base, structural: 'name-hit', nutrition: 'known',
          note: `品类任选条目已显式声明可选范围（${ref.choiceRange!.join('/')}，共 ${ref.choiceRange!.length} 项），求解期将逐项展开选项`,
        });
        return;
      }
      items.push({
        ...base, structural: 'official-sku-bound', nutrition: 'unknown',
        note: `品类任选条目已绑定官方 SKU（${recipe.binding?.comboCode ?? recipe.binding?.roundIds?.join(',')}）；范围以官方轮次为准，求解期需门店上下文展开`,
      });
      warnings.push(index);
      return;
    }
    // combo-ref
    const comboName = ref.comboName || ref.keyword;
    items.push({
      ...base, structural: 'needs-store-context', nutrition: 'unknown',
      note: `官方同名套餐整包引用「${comboName}」；构成以官方套餐各轮次为准，求解期按门店菜单展开（不把默认搭配当成券的全部内容）`,
    });
    warnings.push(index);
  });

  return { ok: blocking.length === 0, items, blocking, warnings };
}

/** 删除用户层配方（预置配方不可删，返回是否命中并删除）。
 *  v1.4.7 R05：删除 = 明确撤销。写入撤销记录后，所有核验路径（实时/缓存/断网/种子兜底）
 *  都不再使用该配方；原始证据保留在目录中，重新保存同 id 配方即恢复。
 *  覆盖预置同 id 的用户条目被删除时属于「恢复预置」语义，不写撤销记录。 */
export function removeRecipe(id: string): boolean {
  const removed = mutateUserFile((user) => {
    const idx = user.recipes.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    user.recipes.splice(idx, 1);
    return true;
  });
  if (removed && !PRESET_RECIPES.some((r) => r.id === id)) {
    revokeRecipe(id, '用户删除配方：相关券面核验失效，需重新核验');
  }
  return removed;
}
