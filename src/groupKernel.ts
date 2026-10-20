// 拼单三轨 MILP 统一内核（v5，docs/GROUP_KERNEL_MILP_DESIGN.md v1.1 §四）
// 三轨 = 同一引擎的三种嵌套池配置（需求行对三轨同口径硬约束，覆盖单调不减）：
//   轨 1 = 单品池（a-la-carte）｜ 轨 2 = 单点+套餐（bundle）｜ 轨 3 = 单点+套餐+券（voucher）
// 关键口径（评审落地）：
//   #1 券白名单：仅三类逐项核验来源入池（联盟 MCP 套餐组成 fixed / 联盟 1+1→官方 SKU 真实
//      rounds+diffPrice / 用户自持 fixed 名称匹配），未核验 choice 型券仅参考展示；
//   #2 心愿→需求单位（独立 ID/code/数量/exact/套餐意图），每份食物至多满足一个需求单位；
//   #3 三轨同覆盖要求，无候选心愿记 unmet 绝不静默；
//   #4 外部券整单 ≤1 + 逐方案 maxQty（内核层已生效），maxQtySource 区分真实限购与程序上限；
//   #6 券严格承接入模（strictCover），不再事后删券；
//   #7 leftovers 显式输出，费用按原价并入分账基数全体等比摊付。
// 诚实边界：所有「最优」均指模型内最优（proven-optimal 仅指模型内）；渠道核价结论单独标注。
import type { McpClient } from './mcp.js';
import { loadMenuItems, type MenuItem, type MenuLoadResult } from './menu.js';
import { withOrderParams, targetRedeemDate } from './orderContext.js';
import { buildMenuAudit, type MenuAuditRow } from './periodCatalog.js';
import { CONFIG } from './config.js';
import type { NutritionRow } from './nutrition.js';
import {
  parseWishPhrase, findMenuItem, tabooHit, findSpecRow, loadComboSkus, norm,
  type GroupMember, type GroupOrderInput, type GroupSolution, type GroupMemberResult,
  type WishSpec, type ComboSkuInfo,
} from './group.js';
import {
  optimizeTopK, buildPlansFromMenuItems,
  type ComboPlan, type MemberReq, type DemandUnit, type OptimizeResult, type PlanAssignment,
} from './optimizer.js';
import { foodKeyOf, foodMultisetSignature, type FoodUnitRef } from './foodIdentity.js';
import {
  PRESET_VOUCHERS, CHOICE_CATEGORIES, officialEquivalentCentsForUnits, invertedWarningText, decideTrackWinner, tieThresholdCents,
  type Voucher, type VoucherTrackSolution, type VoucherBreakdown, type TrackWinner,
} from './vouchers.js';
import { fetchUnionMcDeals } from './unionCps.js';
import { resolveComponentNutrition, nutritionFieldKnown, type NutritionMetric } from './nutritionSupplements.js';
import { specTitleFromRaw } from './officialNutrition.js';
import { resolveFixedVoucherFood, resolveVoucherFoods } from './voucherFoods.js';
import { redeemWindowStatus } from './redeemWindow.js';

const RE_STAPLE_OPT = /堡|麦满分|营养卷|粥|松饼|吉士蛋|巨无霸|板烧|安格斯|鳕鱼|麦香鸡|麦香鱼|油条|贝果|可颂/;

// ---------- 类型 ----------

export interface BasketEntry {
  kind: 'single' | 'combo' | 'voucher';
  code: string;
  name: string;
  qty: number;
  refPriceCents: number;       // 该行模型价（券行=券参考价+补差）
  perUnitConfig: string[];     // 每份配置摘要（如「巨无霸＋中薯条」）——仅展示
  /** v1.4.7 R02/R03：结构化食品清单（身份/规格/数量）——「吃什么」签名与前端分组共用；
   *  不得从 perUnitConfig 字符串反推身份（同名不同规格会串）。 */
  foods?: Array<{ code?: string; name: string; spec?: string; qty: number }>;
  nutritionSources?: string[];
  nutritionEstimated?: boolean;
  nutritionUnknownFields?: string[];
  roundList?: Array<{ round: string; comboItemList: Array<{ code: string; quantity: number }> }>;
  validNote?: string;
  channelLabel: string;
}

export type KernelGroupSolution = GroupSolution & {
  coverage: { total: number; met: number };
  solveState: OptimizeResult['status'];
  kernel: 'milp-v6';
  basket: BasketEntry[];
  gapTotal: number;
  /** v1.4.10 W07：结构化缺口（成员 / 心愿 / 原因 / 缺几份）。
   *  购买清单、分账卡、复制文本三处共用同一份数据——旧实现只有 warnings 字符串，
   *  分账与复制清单因此丢掉缺口，出现「清单看起来全满足」的错觉。 */
  unmet?: Array<{ alias: string; keyword: string; reason: 'no-candidate' | 'kcal-unknown' | 'unsatisfied' | 'structure-unknown' | 'taboo'; missingQty: number }>;
  alternatives: KernelGroupSolution[]; // 同轨 Top-K 备选完整方案（渠道轨 ≠ 方案）
  /** v1.4.6 R02：同一「吃什么」的其它购买途径（渠道/券/价格等级）。
   *  食品内容相同的方案只占一个推荐名额，购买途径并列展示，不再各占一张卡。 */
  purchaseOptions?: Array<{
    label: string; paidCents: number; priceSource: string; track: string; note?: string;
    /** v1.4.10 W14：该途径的**可执行明细**（买什么、几份），用户不必回到卡片正文猜这条途径怎么下 */
    items?: string[];
  }>;
};

export interface GroupKernelResult {
  solution: KernelGroupSolution;            // 轨 1
  bundle: KernelGroupSolution | null;       // 轨 2
  voucherTrack: VoucherTrackSolution | null;// 轨 3
  decision: ReturnType<typeof decideTrackWinner>;
  unified: KernelGroupSolution[];           // 跨轨统一去重排序后的候选（评审三轮 #6，≤5）
  /** v1.4.6 R16：唯一推荐方案在 unified 中的下标（页面 / CLI / 分账共用，与 decision 同源） */
  recommendedIndex: number;
  channelDiagnostics: ChannelDiagnostics;
  /** v1.2：官方菜单不可用（实时失败且无快照）——solution 为需求回执（不构成配餐方案），美团查询结果保留 */
  menuUnavailable?: { reason: string };
  /** v1.4.9 N01：逐商品遗漏账（官方返回 → 结构 → 营养 → 候选 → 选中），只进高级诊断 */
  menuAudit?: MenuAuditRow[];
}

interface ResolvedDemand {
  mi: number;
  alias: string;
  raw: string;
  spec: WishSpec;
  /** v1.4.10 W04：品类心愿没有单一命中品项（由类目集合承接）时为 undefined */
  hit?: MenuItem;
  specRow: { row: NutritionRow; label: string } | null;
  demand: DemandUnit;
}

/** 品类心愿的可读名（需求回执/未满足提示用） */
const CATEGORY_LABEL: Record<NonNullable<WishSpec['category']>, string> = {
  drink: '饮料', staple: '汉堡（主食）', side: '小食', dessert: '甜品',
};
const NUM_CN_LOCAL: Record<string, number> = { 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 };

const dbg = (...a: unknown[]) => { if (process.env.DEBUG_VOUCHER === '1') console.error('[kernel]', ...a); };

// ---------- S1 心愿 → 需求单位 ----------

/** v1.4.4 R07：规格标签等价判定（跨来源归一）。
 *  官网权威库的 label 为「大 / 中 / 5块」；MCP 营养表 fallback 的 label 为原始匹配片段
 *  （「大薯 / 中薯 / 大杯」）。二者指同一规格，归一化后比较，避免因来源差异漏判规格限定。 */
function specLabelMatches(rowLabel: string, requested: string): boolean {
  const norm = (s: string) => s.replace(/[份杯薯块条只支\s]/g, '');
  const a = norm(rowLabel), b = norm(requested);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function resolveDemands(members: GroupMember[], menu: MenuLoadResult): {
  resolved: ResolvedDemand[];
  unmatched: Array<{ mi: number; demand: DemandUnit }>;
  unresolvedByMember: Map<number, string[]>;
  tabooByMember: Map<number, string[]>;
  matchWarnings: string[];
} {
  const resolved: ResolvedDemand[] = [];
  const unmatched: Array<{ mi: number; demand: DemandUnit }> = [];
  const unresolvedByMember = new Map<number, string[]>();
  const tabooByMember = new Map<number, string[]>();
  const matchWarnings: string[] = [];
  members.forEach((m, mi) => {
    for (const phrase of m.wishes) {
      const spec = parseWishPhrase(phrase);
      if (!spec) continue;
      const must = /一定要|必须要|务必/.test(spec.raw); // 「一定要」类心愿 → 硬需求（评审二轮 #5）
      const demandId = `m${mi}w${resolved.filter((r) => r.mi === mi).length}`;
      // v1.4.10 W04：品类心愿（饮料/大杯饮料/汉堡/小食/甜品）→ 结构化类目需求。
      //   旧实现 keyword 为空即 continue，既无 demand 也无 unresolved：成员空手仍显示已覆盖。
      //   类目需求进入模型后：无候选 → 软需求缺口全额计入；有候选 → 由同类合法食品（含套餐槽位/券食品）承接。
      if (spec.category) {
        const requestedCatSpec = specTitleFromRaw(spec.raw);
        const demand: DemandUnit = {
          id: demandId,
          keyword: CATEGORY_LABEL[spec.category],
          qty: Math.max(1, spec.qty),
          ...(spec.exact ? { exact: true } : {}),
          ...(must ? { must: true } : {}),
          category: spec.category,
          ...(requestedCatSpec ? { specLabel: requestedCatSpec } : {}),
        };
        resolved.push({ mi, alias: m.alias, raw: spec.raw, spec, specRow: null, demand });
        if (requestedCatSpec) {
          const line = `@${m.alias} 「${spec.raw}」按「${CATEGORY_LABEL[spec.category]}」类目 + ${requestedCatSpec}规格承接`;
          if (!matchWarnings.includes(line)) matchWarnings.push(line);
        }
        continue;
      }
      if (!spec.keyword) continue; // 「随意」等：不猜品项（与轨道 1/2/3 现有口径一致）
      const hit = findMenuItem(spec, menu.items);
      if (!hit) {
        // v1.4.4 R06：未匹配心愿**不得在入模前丢弃**。旧实现只记进提示，需求不进模型 →
        //   硬需求（一定要/必须要）静默失效、软需求不在覆盖分母里（覆盖率虚高、gapTotal=0）。
        //   现在以「无候选需求」入模：软需求全额计入缺口，硬需求判无解并指名成员。
        if (!unresolvedByMember.has(mi)) unresolvedByMember.set(mi, []);
        unresolvedByMember.get(mi)!.push(spec.raw);
        unmatched.push({
          mi,
          demand: {
            id: `m${mi}u${unmatched.filter((x) => x.mi === mi).length}`,
            keyword: spec.keyword,
            qty: Math.max(1, spec.qty),
            ...(spec.exact ? { exact: true } : {}),
            ...(must ? { must: true } : {}),
          },
        });
        continue;
      }
      if (tabooHit(m, hit.item)) {
        if (!tabooByMember.has(mi)) tabooByMember.set(mi, []);
        tabooByMember.get(mi)!.push(`${spec.raw}（命中禁忌，已排除 ${hit.item.name}）`);
        continue;
      }
      const specRow = findSpecRow(menu.table, hit.item, spec);
      // v1.4.4 R07：规格进入候选身份——规格营养与默认营养不同时，该心愿只由同规格选项承接。
      //   前置门禁：必须是**显式声明规格**的心愿（大/中/小/份/杯/N块）。否则会误伤普通心愿——
      //   findSpecRow 走官网权威库时，对无规格心愿同样会回落默认规格行（specTitleFromRaw=null），
      //   其 kcal 与 MCP 菜单口径常有偏差 → 普通心愿被误判为规格限定，从而把套餐组件/券品项
      //   （不带 specLabel）全部排除在承接之外（回归：B2 券轨、B6 剩余参考价、B7 核价权威）。
      const requestedSpec = specTitleFromRaw(spec.raw);
      const specQualified = !!requestedSpec && !!specRow && specLabelMatches(specRow.label, requestedSpec)
        && specRow.row.energyKcal !== hit.item.kcal;
      // v1.4.10 W05：即便没有规格营养行，尺寸类规格（大/中/小）也必须进入承接身份——
      //   否则「大份薯条」会被中份/大份选项同时承接（旧实现只用营养行差异决定）。
      //   件数类（2块）仍要求营养行证据，避免把「两块装」误判成硬规格。
      const sizeSpec = requestedSpec && /^(超大|大|中|小|迷你)$/.test(requestedSpec) ? requestedSpec : undefined;
      // v1.4.10 W03：套餐心愿 = 完整购买单元。候选集合包含所有同名合法套餐（三件套/四件套/精选等），
      //   明确「N 件套」时保留槽位数要求；不再只绑定 findMenuItem 命中的单个最低价 SKU。
      let comboPlanIds: string[] | undefined;
      let comboSlotCount: number | undefined;
      let comboPieceToken: string | undefined;
      /** v1.4.10 W05：单品心愿（无「套餐/件套」字样）只因门店没有该单点 SKU 而命中套餐时，
       *  只要求该食品所在轮次，其余槽位留给同桌成员合法换选——否则「整餐归一人」会把
       *  乙的大薯条心愿挡在套餐换选之外，只能另买一份（实测 4800 分 vs 换选 3650 分）。 */
      let comboFocusSlot: string | undefined;
      if (hit.item.isCombo && !hit.item.structureUnknown) {
        const mCount = /([二两三四五六七八])\s*件套/.exec(spec.raw);
        const nSlot = mCount ? (NUM_CN_LOCAL[mCount[1]] ?? undefined) : undefined;
        comboSlotCount = nSlot;
        comboPieceToken = mCount ? `${mCount[1]}件套` : undefined;
        const k = norm(spec.keyword);
        const cands = menu.items.filter((i) => i.isCombo && !i.structureUnknown
          && k.length >= 2 && norm(i.name).includes(k)
          && (!comboPieceToken || norm(i.name).includes(norm(comboPieceToken)) || (i.deconstruction?.length ?? 0) === nSlot));
        if (cands.length > 0) comboPlanIds = [...new Set(cands.map((i) => 'mcd-' + i.code))];
        if (!spec.wantCombo && k.length >= 2) {
          const round = (hit.item.deconstruction ?? []).find((r) =>
            norm(r.defaultName ?? '').includes(k) || r.options.some((o) => norm(o.name).includes(k)));
          if (round?.roundName) comboFocusSlot = round.roundName;
        }
      }
      const demand: DemandUnit = {
        id: demandId,
        keyword: hit.item.isCombo ? spec.keyword : hit.item.name,
        ...(hit.item.isCombo ? {} : { code: hit.item.code }),
        qty: Math.max(1, spec.qty),
        ...(spec.exact ? { exact: true } : {}),
        ...(must ? { must: true } : {}),
        ...(specQualified ? { specLabel: specRow!.label } : sizeSpec ? { specLabel: sizeSpec } : {}),
        // 套餐意图：心愿解析命中套餐 SKU → 按完整购买单元承接（默认项仅作默认展示，合法换选可选）
        ...(hit.item.isCombo ? { comboPlanId: 'mcd-' + hit.item.code } : {}),
        ...(comboPlanIds ? { comboPlanIds } : {}),
        ...(comboSlotCount ? { comboSlotCount } : {}),
        ...(comboPieceToken ? { comboPieceToken } : {}),
        ...(comboFocusSlot ? { comboFocusSlot } : {}),
      };
      resolved.push({ mi, alias: m.alias, raw: spec.raw, spec, hit: hit.item, specRow, demand });
      // 匹配口径透明提示（与 legacy addWishItem 同类）
      const notes: string[] = [];
      if (hit.flavorFallback) notes.push(`「${spec.raw}」按品类匹配为 ${hit.item.name}，口味可能不符，请确认`);
      if (hit.synonymsApplied) notes.push(`「${spec.raw}」按同义词匹配为 ${hit.item.name}`);
      if (spec.wantCombo && !hit.item.isCombo) notes.push(`「${spec.raw}」要求套餐，当前门店仅有单品形式`);
      if (spec.specNote) notes.push(spec.specNote);
      if (spec.exact) notes.push(`「${spec.raw}」按恰好 ${spec.qty} 份承接`);
      if (specQualified) notes.push(`已按${specRow!.label}规格入模（${specRow!.row.energyKcal} kcal/份，热量与硬上限同口径）`);
      if (notes.length > 0) {
        const line = `@${m.alias} ${notes.join('；')}`;
        if (!matchWarnings.includes(line)) matchWarnings.push(line);
      }
    }
  });
  return { resolved, unmatched, unresolvedByMember, tabooByMember, matchWarnings };
}

/** v1.4.4 R07：由「带规格心愿」派生规格限定单品计划请求（规格营养显式入模，不做名称猜测）。 */
function specRequestsOf(resolved: ResolvedDemand[]): NonNullable<Parameters<typeof buildPlansFromMenuItems>[1]>['specRequests'] {
  const out: NonNullable<Parameters<typeof buildPlansFromMenuItems>[1]>['specRequests'] = [];
  const seen = new Set<string>();
  for (const rd of resolved) {
    if (!rd.demand.specLabel || !rd.specRow || !rd.hit) continue;
    const key = `${rd.hit.code}|${rd.demand.specLabel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      baseCode: rd.hit.code, baseName: rd.hit.name,
      specLabel: rd.demand.specLabel,
      kcal: rd.specRow.row.energyKcal, protein: rd.specRow.row.protein, fat: rd.specRow.row.fat,
      carbohydrate: rd.specRow.row.carbohydrate, sodium: rd.specRow.row.sodium,
      sourceLabel: `官网营养计算器规格行（${rd.specRow.row.productName}）`,
    });
  }
  return out;
}

// ---------- 成员需求归一化（R04） ----------

/** 无糖表述词表（手工书写变体）——与 group.ts 既有解析对齐：
 *  sugarFree 标记解析词 = 无糖|零卡|零度；tabooHit 禁忌词 = 无糖|不甜|少糖|去糖|糖。
 *  此处仅补齐「不加糖 / 无糖可乐」等手工书写变体，不引入冲突判定。 */
const RE_SUGARFREE_MANUAL = /无糖|去糖|不加糖|零度|零卡|少糖|不甜/;

/** 探测用「含糖饮品」（category=饮品、fastCarb>0）：用于复用 group.ts 的 tabooHit 判定
 *  （sugarFree 标记 或 禁忌中的无糖词表），避免在本文件复制出第二套不一致的词表。 */
const SUGARY_DRINK_PROBE: MenuItem = {
  code: '__sugary-probe__', name: '含糖饮品', priceCents: 0, originalPriceCents: 0,
  category: '饮品', tags: [], kcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0,
  isCombo: false, fastCarb: 1, isVeggie: false, isStaple: false, nutritionMatched: false,
};

/** 是否为无糖表述（用于从禁忌列表中剥离：其语义已由 noSugaryDrink 承载，
 *  避免 optimizer 的禁忌名匹配把「无糖可乐」等无糖饮品误判为禁忌）。 */
function isSugarFreePhrase(t: string): boolean {
  const k = norm(t);
  return k === '糖' || RE_SUGARFREE_MANUAL.test(k);
}

/** R04：成员无糖需求归一化——sugarFree 标记 或 禁忌/备注中的无糖表述，二者产生同一约束效果。
 *  复用 group.ts 的 tabooHit（同一禁忌词表）；手工书写变体由 RE_SUGARFREE_MANUAL 补齐。 */
export function memberNoSugaryDrink(m: GroupMember): boolean {
  if (m.sugarFree) return true;
  if (tabooHit({ ...m, taboos: m.taboos ?? [] }, SUGARY_DRINK_PROBE)) return true;
  return [...(m.taboos ?? []), ...(m.notes ?? [])].some((t) => RE_SUGARFREE_MANUAL.test(norm(t)));
}

function memberReqsOf(
  members: GroupMember[],
  resolved: ResolvedDemand[],
  unmatched: Array<{ mi: number; demand: DemandUnit }> = [],
): MemberReq[] {
  return members.map((m, mi) => ({
    alias: m.alias,
    // v1.4.4 R06：未匹配心愿同样入模（无候选需求）——覆盖分母与缺口如实计量，
    //   硬需求（一定要/必须要）无候选时判无解并指名成员，不再静默失效。
    demands: [
      ...resolved.filter((r) => r.mi === mi).map((r) => r.demand),
      ...unmatched.filter((u) => u.mi === mi).map((u) => u.demand),
    ],
    // R04：无糖禁忌词语义已由 noSugaryDrink 承载，从禁忌列表剥离（否则「无糖可乐」会被名匹配误杀）
    taboo: (m.taboos ?? []).filter((t) => !isSugarFreePhrase(t)),
    noSugaryDrink: memberNoSugaryDrink(m),
    kcalCap: m.kcalCap,
  }));
}

// ---------- S2 券召回与白名单方案池（评审 #1） ----------

function fixedNameMatch(keyword: string, name: string): boolean {
  const a = norm(keyword), b = norm(name);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// 含糖饮品判定（R04 配套）：与 optimizer.buildPlansFromMenuItems 同口径——
// 非饮料=false；无糖/零度/零卡名=false；有营养数据按碳水≥5；否则未知（undefined）。
// noSugaryDrink 成员不得被分配「含糖或含糖未知」的饮料（未知按保守处理，不当作满足需求）。
const RE_SUGARY_DRINK_OPT = /可乐|雪碧|果汁|柠檬红茶|冰茶|奶铁|奶茶|奶冻|爆珠|雪冰|怡泉|美汁源|麦旋酷|芬达|拿铁|咖啡|纯悦|牛奶/;
const RE_ZERO_SUGAR_OPT = /无糖|零度|零卡/;

/** 饮料身份统一判定：轮次类目 或 菜单类目 或 名称正则（组件路径也走这一路，避免口径分叉） */
function isDrinkName(name: string, category?: string, roundCategory?: string): boolean {
  if (category && (category === 'drink' || /饮品|麦咖啡/.test(category))) return true;
  if (roundCategory && (roundCategory === 'drink' || /饮品|饮料/.test(roundCategory))) return true;
  return RE_SUGARY_DRINK_OPT.test(name);
}

function sugaryOf(name: string, drink: boolean, kcalKnown: boolean, carbohydrate: number): boolean | undefined {
  if (!drink) return false;
  if (RE_ZERO_SUGAR_OPT.test(name)) return false;
  if (kcalKnown && Number.isFinite(carbohydrate)) return carbohydrate >= 5;
  return undefined;
}

/** 由菜单单品构造选项。
 *  v1.4.6 R01：`diffCents` = **本次购买渠道实际收取的补差**（券渠道只在券面有补差依据时非零）；
 *  `officialDiffCents` = 官方渠道的换选差价，仅作证据保留，绝不叠加到券价上。 */
function optionOfMenuItem(it: MenuItem, diffCents = 0, displayName = it.name, specRaw?: string, officialDiffCents?: number) {
  const requestedSpec = specRaw ? specTitleFromRaw(`${specRaw}${it.name}`) : null;
  // 已匹配 MCP 营养时保留其值，除非券面有可识别的规格；未知项回落官网/用户补录。
  const resolved = (!it.nutritionMatched || requestedSpec) ? resolveComponentNutrition(it.name, requestedSpec ? `${specRaw}${it.name}` : it.name) : null;
  const specHit = !!requestedSpec && !!resolved?.matched && (
    resolved.specTitle === requestedSpec ||
    resolved.sourceKind === 'supplement' ||
    (resolved.sourceKind === 'official-web' && resolved.specTitle === requestedSpec)
  );
  const supplementHit = !it.nutritionMatched && !!resolved?.matched;
  const specUnknown = !!requestedSpec && !specHit;
  const resolvedHit = specHit || supplementHit;
  const rn = resolvedHit ? resolved! : null;
  // v1.4.4 R04：逐字段可信性。补录可能只覆盖部分字段（其余为未知），未知字段的 0 是占位，
  //   不得按 0 参与上限/达标判断（与既有「缺失 ≠ 0」纪律一致）。
  const menuUnknown: string[] = it.nutritionUnknownFields ?? [];
  const fieldKnown = (m: NutritionMetric): boolean => {
    if (specUnknown) return false;
    if (rn) return nutritionFieldKnown(rn, m);
    return it.nutritionMatched && !menuUnknown.includes(m);
  };
  const pick = (m: NutritionMetric, menuVal: number): number => (fieldKnown(m) ? (rn ? (rn[m] as number) : menuVal) : 0);
  const kcalKnown = fieldKnown('kcal');
  const kcal = pick('kcal', it.kcal);
  const protein = pick('protein', it.protein);
  const fat = pick('fat', it.fat);
  const carbohydrate = pick('carbohydrate', it.carbohydrate);
  const sodium = pick('sodium', it.sodium);
  const carbKnown = fieldKnown('carbohydrate');
  const drink = isDrinkName(displayName, it.category);
  const nutritionSource = resolvedHit ? resolved!.sourceLabel : it.nutritionSource;
  // v1.4.4 R04：估算/区间值保留为参考，但不支持严格达标结论 → 带 estimated 标记，内核硬约束中排除
  const estimated = (!!rn && rn.valueKind === 'estimate') || (!rn && !!it.nutritionEstimated);
  const unknownNutrition = rn ? [...rn.unknownFields] : (menuUnknown.length ? [...menuUnknown] : undefined);
  // v1.4.4 R11：快碳可信性独立判定——非饮料恒可信；饮料仅在「含糖三态已判定」时可信
  const sugaryVal = sugaryOf(displayName, drink, carbKnown, carbohydrate);
  const fastCarbKnown = !drink || sugaryVal !== undefined;
  return {
    name: displayName,
    kcal,
    kcalKnown,
    priceCents: it.priceCents,
    diffCents,
    ...(officialDiffCents ? { officialDiffCents } : {}),
    staple: it.isStaple,
    veggie: it.isVeggie,
    code: it.code,
    fastCarb: drink && carbKnown && carbohydrate >= 5 ? carbohydrate : it.fastCarb,
    fastCarbKnown,
    drink,
    sugary: sugaryVal,
    protein, fat, carbohydrate, sodium,
    ...(estimated ? { estimated: true } : {}),
    ...(unknownNutrition?.length ? { unknownNutrition } : {}),
    ...(nutritionSource ? { nutritionSource } : {}),
  };
}

/** 券建槽诊断（v1.4.5 W04）：逐券记录建槽来源、是否完整、未支持项与失败原因。
 *  供验收脚本区分「组成可解析 / 进入候选池 / 有可行解 / 被推荐选中」四个阶段。 */
export interface VoucherSlotDiagnostics {
  reasons: string[];
  source?: 'food-resolution' | 'official-rounds';
  complete?: boolean;
  /** v1.4.6 R01：券内换选补差无券面依据（官方渠道差价不等于券的核销补差） */
  surchargeUnknown?: boolean;
  groups?: import('./voucherFoods.js').VoucherGroupReport[];
}

/** 官方轮次型券的 SKU 选择（v1.4.5 W01）：
 *  只接受①显式绑定 comboCode、②显式绑定 roundIds、③与券名同源的官方 SKU（随心配/1+1）。
 *  删除「轮次数刚好等于券条目数 → 借用任意套餐」的旧启发式——它会把别的套餐的轮次当成券内容。 */
function selectOfficialRoundSku(
  v: Voucher,
  choiceRefs: Voucher['items'],
  skus: ComboSkuInfo[],
): ComboSkuInfo | null {
  if (v.binding?.comboCode) return skus.find((s) => s.code === v.binding!.comboCode) ?? null;
  if (v.binding?.roundIds && v.binding.roundIds.length > 0) {
    return skus.find((s) => v.binding!.roundIds!.every((id) => s.rounds.some((r) => r.id === id))) ?? null;
  }
  if (!/随心配|1\+1/.test(norm(v.name))) return null;
  const ordered = [...skus].sort((a, b) => a.code.localeCompare(b.code));
  return ordered.find((s) => /随心配|1\+1/.test(norm(s.name)) && s.rounds.length >= choiceRefs.length) ?? null;
}

/** 券 → 槽位（逐项核验）。返回 null = 未核验，不入池（仅参考展示）。
 *  v1.3：
 *    - fixed 引用支持 qty（券含两份汉堡 → 两个独立槽位，完整保留数量——旧实现忽略 qty 丢份数）；
 *    - combo-ref（官方同名套餐整包）：按官方套餐 deconstruction 展开——每个轮次=一个槽位，
 *      保留【任选范围 + 默认项 + 差价】，固定槽与任选槽分别建模（不再只取官方默认搭配）；
 *    - choice（1+1 红区/白区）：映射官方 SKU 对应轮次的真实 choices（含实测 diffPrice）。
 *  v1.4.5 W01：声明了**具体食品范围**的 choice 一律由食品解析器生成购买单元（含 qty 展开、
 *    券面补差），不再因「没有官方 SKU」被提前拒绝；官方轮次型只走明确绑定/同源 SKU。 */
export function voucherSlots(
  v: Voucher,
  menu: MenuLoadResult,
  skus: ComboSkuInfo[] = [],
  diag?: VoucherSlotDiagnostics,
): ComboPlan['slots'] | null {
  const slots: ComboPlan['slots'] = [];
  const choiceRefs = v.items.filter((it) => it.mode === 'choice');
  const fail = (reason: string): null => {
    diag?.reasons.push(reason);
    return null;
  };

  // ① 券面声明了可枚举食品范围 → 唯一由食品解析器生成购买单元（单人/多人/诊断共用同一份结果）
  const hasDirectRange = choiceRefs.some((it) => Array.isArray(it.choiceRange)
    && it.choiceRange.some((c) => resolveFixedVoucherFood({ keyword: c, mode: 'fixed', qty: 1 }, menu) !== null));
  if (hasDirectRange) {
    const res = resolveVoucherFoods(
      { id: v.id, items: v.items, ruleVersion: v.binding?.ruleVersion, evidence: v.evidence },
      { menu },
    );
    if (diag) {
      diag.source = 'food-resolution';
      diag.complete = res.complete;
      diag.groups = res.groups;
    }
    if (!res.ok || res.slots.length === 0) {
      return fail(res.unresolvedReasons?.join('；') || '券面食品解析未生成任何购买单元');
    }
    return res.slots.map((s) => ({
      roundName: s.roundName,
      defaultName: s.defaultName,
      ...(s.roundId ? { roundId: s.roundId } : {}),
      options: s.options,
    }));
  }

  // ② 官方轮次引用型：必须有可核验的官方 SKU 绑定（否则保持未核验，不猜）
  let sku: ComboSkuInfo | null = null;
  if (choiceRefs.length > 0) {
    sku = selectOfficialRoundSku(v, choiceRefs, skus);
    if (!sku) return fail('任选范围未绑定官方 SKU 轮次，且券面未声明具体食品范围（不按轮次数猜测其他套餐）');
  }
  if (diag) {
    diag.source = 'official-rounds';
    diag.complete = true;
    diag.groups = [];
  }
  let roundCursor = 0;
  // v1.4.6 R01：官方套餐/官方 SKU 的换选差价是**官方渠道**的价格规则，不是券的核销补差规则。
  //   旧实现把官方 diffCents 直接加在券底价上（实测：¥13.90 的随心配因麦香鸡官方 −¥1 被算成 ¥12.90，
  //   并因此通过 ¥13 预算准入）。现在官方差价只记入 officialDiffCents 作为结构证据，
  //   券价只加「券面有依据」的补差（券配方 optionDiffs/surcharge 路径）；无依据时如实标注未知。
  let officialDiffSeen = false;
  const officialDiffOf = (cents: number | undefined): number => {
    if (cents && cents !== 0) officialDiffSeen = true;
    return 0;
  };
  const pushFixed = (ref: Voucher['items'][number]): boolean => {
    const exact = ref.fulfillCode
      ? menu.items.filter((it) => !it.isCombo && it.code === ref.fulfillCode)
      : menu.items.filter((it) => !it.isCombo && norm(it.name) === norm(ref.keyword));
    // 固定食品优先唯一映射到当前门店单品；门店无此单品时回落到独立团购食品解析（解耦单点可购性）
    if (exact.length === 1) {
      const item = exact[0];
      const spec = ref.spec ?? '';
      const specIsSize = /大|中|小|杯|份|薯|块|迷你/.test(spec);
      const displayName = specIsSize && !norm(item.name).includes(norm(spec)) ? `${spec}${item.name}` : item.name;
      const option = optionOfMenuItem(item, 0, displayName, specIsSize ? spec : undefined);
      slots.push({ roundName: ref.keyword, defaultName: displayName, options: [option] });
      return true;
    }
    const resolved = resolveFixedVoucherFood(ref, menu);
    if (!resolved) return false;
    const option: ComboPlan['slots'][number]['options'][number] = {
      name: resolved.displayName,
      kcal: resolved.kcal,
      kcalKnown: resolved.kcalKnown,
      priceCents: resolved.priceCents,
      diffCents: 0,
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
    };
    slots.push({ roundName: ref.keyword, defaultName: resolved.displayName, options: [option] });
    return true;
  };
  for (const ref of v.items) {
    if (ref.mode === 'combo-ref') {
      // 官方同名套餐整包：按 deconstruction 轮次展开（每轮一个槽位，任选范围原样保留）
      const combo = menu.items.find((it) => it.isCombo && it.code === ref.keyword);
      if (!combo?.deconstruction || combo.deconstruction.length === 0) {
        return fail(`官方套餐整包「${ref.comboName || ref.keyword}」未在当前菜单中取得轮次明细`);
      }
      // v1.4.4 R10：按引用份数 ref.qty 展开**完整**槽位。
      //   旧实现忽略 qty：两槽套餐 qty:2 时 recipeFoodUnits() 计 4 件，而这里只生成 2 槽 →
      //   四件需求被判无解（券内食品数量缩水）。现按 qty 复制整套轮次槽位：
      //   第 2 份起的 roundName 加「第N份」后缀以便呈现区分；roundId 原样保留
      //   （roundListOf 按 roundId 聚合数量，正是官方计价接口所需口径）。
      const roundSlots: ComboPlan['slots'] = [];
      for (const round of combo.deconstruction) {
        const opts = round.options
          .map((o) => {
            const byCode = o.code ? menu.items.find((x) => !x.isCombo && x.code === o.code) : undefined;
            const exactNameHits = menu.items.filter((x) => !x.isCombo && norm(x.name) === norm(o.name));
            const mi = byCode ?? (exactNameHits.length === 1 ? exactNameHits[0] : undefined);
            if (mi) return optionOfMenuItem(mi, officialDiffOf(o.diffCents), o.name, o.name, o.diffCents);
            // 组件不在当前菜单单品池（套餐组件体系）→ 统一解析链：
            // 官网权威库 → 用户补录层 → 未知（matched=false 时 kcal=0 但不得当作真实 0）
            const off = resolveComponentNutrition(o.name);
            const drink = isDrinkName(o.name, undefined, round.category);
            // v1.4.4 R04：逐字段可信性（补录可能部分字段未知）；估算值带 estimated 标记
            const known = (m: NutritionMetric) => nutritionFieldKnown(off, m);
            const carbKnown = known('carbohydrate');
            const sugaryVal = sugaryOf(o.name, drink, carbKnown, off.carbohydrate);
            return {
              name: o.name, kcal: known('kcal') ? off.kcal : 0, kcalKnown: known('kcal'),
              priceCents: 0, diffCents: officialDiffOf(o.diffCents),
              ...(o.diffCents ? { officialDiffCents: o.diffCents } : {}), staple: RE_STAPLE_OPT.test(o.name) && !/薯/.test(o.name), veggie: /蔬菜|沙拉|玉米|苹果片/.test(o.name),
              code: o.code, fastCarb: carbKnown && drink && off.carbohydrate >= 5 ? off.carbohydrate : 0,
              fastCarbKnown: !drink || sugaryVal !== undefined, drink,
              sugary: sugaryVal,
              protein: known('protein') ? off.protein : 0, fat: known('fat') ? off.fat : 0,
              carbohydrate: carbKnown ? off.carbohydrate : 0, sodium: known('sodium') ? off.sodium : 0,
              ...(off.valueKind === 'estimate' ? { estimated: true } : {}),
              ...(off.unknownFields.length ? { unknownNutrition: [...off.unknownFields] } : {}),
              ...(off.matched && off.sourceKind === 'supplement' ? { nutritionSource: off.sourceLabel } : {}),
            };
          })
          .filter((o) => !!o.name);
        if (opts.length === 0) return fail(`官方套餐「${combo.name}」轮次「${round.roundName}」无可用选项`);
        roundSlots.push({ roundName: round.roundName, ...(round.roundId ? { roundId: round.roundId } : {}), defaultName: round.defaultName || opts[0].name, options: opts });
      }
      const refQty = Math.max(1, Math.min(8, Math.floor(ref.qty ?? 1)));
      for (let q = 0; q < refQty; q++) {
        for (const s of roundSlots) {
          slots.push(refQty > 1 ? { ...s, roundName: `${s.roundName}（第${q + 1}份）` } : s);
        }
      }
      continue;
    }
    if (ref.mode === 'fixed') {
      for (let q = 0; q < Math.max(1, ref.qty); q++) {
        if (!pushFixed(ref)) return fail(`固定品项「${ref.keyword}」无法确认食品身份或未收录营养`);
      }
      continue;
    }
    // choice（官方轮次型）：映射官方 SKU 的对应轮次（顺序对齐），选项=该轮真实 choices（含实测 diffPrice）
    const round = sku!.rounds[roundCursor++];
    if (!round) return fail(`官方 SKU「${sku!.name}」缺少第 ${roundCursor} 个轮次`);
    const cat = CHOICE_CATEGORIES.find((c) => c.key === ref.keyword);
    const opts = round.choices
      .map((c) => {
        const byCode = menu.items.find((x) => !x.isCombo && x.code === c.code);
        const hits = menu.items.filter((x) => !x.isCombo && norm(x.name) === norm(c.name));
        const mi = byCode ?? (hits.length === 1 ? hits[0] : undefined);
        if (mi) return optionOfMenuItem(mi, officialDiffOf(c.diffCents), c.name, c.name, c.diffCents);
        const resolved = resolveFixedVoucherFood({ keyword: c.name, mode: 'fixed', qty: 1 }, menu);
        if (resolved) {
          return {
            name: c.name,
            kcal: resolved.kcal,
            kcalKnown: resolved.kcalKnown,
            priceCents: resolved.priceCents,
            diffCents: officialDiffOf(c.diffCents),
            ...(c.diffCents ? { officialDiffCents: c.diffCents } : {}),
            staple: resolved.isStaple,
            veggie: resolved.isVeggie,
            code: resolved.fulfillCode || c.code,
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
          };
        }
        return null;
      })
      .filter((o): o is NonNullable<typeof o> => o !== null);
    if (opts.length === 0) return fail(`官方轮次「${round.name || ref.keyword}」无可用选项`);
    // 品类校验：该轮选项须命中券面品类词表（可审计；不命中=映射不可信，不入池）
    if (cat && !round.choices.some((c) => cat.match.test(c.name))) return fail(`官方轮次「${round.name || ref.keyword}」与券面品类不符`);
    const base = { roundName: round.name || ref.keyword, roundId: round.id, defaultName: opts[0].name, options: opts };
    const times = Math.max(1, Math.min(8, Math.floor(ref.qty ?? 1)));
    for (let q = 0; q < times; q++) {
      slots.push(times > 1 ? { ...base, roundName: `${base.roundName}（第${q + 1}件）` } : base);
    }
  }
  // v1.4.3 修正：单品券（1 个槽位）是合法购买单元，必须入池。
  //   v1.4.1「全部团购入池」策略已在 unionCps（foodUnits ≥ 1）与本函数上方注释中声明，
  //   但此处旧门槛 `>= 2` 与之矛盾，导致「核验通过的单品券」永远无法建池
  //   （实测：S2b 同名单品券「那么大鸡排」solvable=true 却被排除，价格候选层多出 1 条）。
  //   逐项解析是「全有或全无」：任一固定项/任选项/套餐轮次解析失败都已提前 return null，
  //   因此 slots.length ≥ 1 即代表券面全部声明项均已映射，不会把残缺映射放进求解池。
  if (diag && officialDiffSeen) diag.surchargeUnknown = true;
  return slots.length >= 1 ? slots : fail('券面未生成任何购买单元');
}

export interface ChannelDiagnostics {
  union: {
    queried: number; admitted: number; tips: number; degraded: boolean;
    dbUsed: boolean; dbCount: number;
    source: 'independent' | 'none';   // independent=项目自有凭据直连联盟网关；none=未查询（本地团单库兜底）
    /** 「接口查询成功」≠「可参与求解」的逐类排除统计（v1.4.1：priceCandidates=在售未核验的价格候选数） */
    stats?: {
      queried: number; admitted: number; detailUnverified: number; saleEnded: number; validityExpired: number;
      other: number; menuVerified: number; priceCandidates?: number; unverifiedReasons?: Record<string, number>;
      /** v1.4.10 W01：完整发现目录 vs 受控求解池（含是否截断与原因） */
      discovery?: {
        total: number; pages: number; hasNext: boolean; truncated: boolean; truncatedReason?: string;
        poolLimit: number; poolSize: number; poolOverflow: number;
      };
    };
    /** v1.3：查询到的团单独立列表（含未入池者——可查询 ≠ 可购买 ≠ 可核销，状态逐单标注；未核验原因细分）
     *  v1.4.1：status='admitted' 可自动比价 / 'price-candidate' 在售可购买但内容未核验 / 'unavailable' 停售过期等 */
    deals?: Array<{ name: string; priceYuan: number; verified: boolean; note: string; headUrl?: string; reasonCode?: string; status?: 'admitted' | 'price-candidate' | 'unavailable'; productViewSign?: string; skuViewId?: string }>;
    /** 无凭据/查询失败原因（诚实呈现，不含凭据） */
    unavailableReason?: string;
  };
  preset: { considered: number; admitted: number };
  user: { considered: number; admitted: number };
  /** v1.4.5 W04：逐券建槽覆盖（声明项/已解析项/未支持项/是否完整）。
   *  「部分支持」必须在此如实体现，不得按「完整支持」对外表述。 */
  slotCoverage?: Array<{
    id: string; name: string;
    source?: 'food-resolution' | 'official-rounds';
    complete: boolean;
    declared: number; resolved: number;
    unsupported: string[];
    surchargeUnknown?: boolean;
    reasons?: string[];
  }>;
  voucherPlanRules: {
    perVoucherMaxQty: string;   // 真实券面限购（min(券面, 4 单元搜索上限)）
    externalOrderLimit: string; // 程序搜索上限（≤3 张/单），明确标注非平台规则
  };
  excluded: Array<{ name: string; priceYuan: number; reason: string }>;
}

async function recallVouchers(
  client: McpClient,
  input: GroupOrderInput,
  menu: MenuLoadResult,
  userVouchers: Voucher[],
): Promise<{ pool: Voucher[]; tips: Voucher[]; plans: Map<string, { voucher: Voucher; plan: ComboPlan }>; unionDegraded: boolean; unionSolvableCount: number; diagnostics: ChannelDiagnostics; sameComboNotes: string[] }> {
  const pool: Voucher[] = [];
  const tips: Voucher[] = [];
  /** v1.4.9：多份同款套餐券的承接边界说明（券轨 warnings 里如实展示） */
  const sameComboNotes: string[] = [];
  const excluded: ChannelDiagnostics['excluded'] = [];
  let unionDegraded = false;
  let unionQueried = 0;
  let unionContentVerified = 0; // 「内容已识别」：券面内容核验通过（unionCps solvable 口径）
  let unionDbUsed = false;
  let unionDbCount = 0;
  let unionSource: 'independent' | 'none' = 'none';
  let unionStats: import('./unionCps.js').UnionExclusionStats | undefined;
  let unionUnavailableReason: string | undefined;
  const unionDealList: ChannelDiagnostics['union']['deals'] = [];
  // v1.4.2（R13）：先收集团单，最终徽章/计数取「建池成功」结果，故状态在 plans 构建后再定稿
  const unionBuilds: Array<{ build: import('./unionCps.js').UnionVoucherBuild; note: string }> = [];
  const unionVerifiedIds = new Set<string>(); // 内容已核验的券 id（用于排除原因细分）
  // 层 A：联盟实时（独立接入：项目自有凭据直连；失败自动降级，不阻塞）
  try {
    const { builds, dbUsed, dbCount, source, stats, unavailableReason } = await fetchUnionMcDeals(client, input.storeCode, menu, input.storeName, { city: input.city });
    unionDbUsed = dbUsed; unionDbCount = dbCount; unionSource = source;
    unionStats = stats; unionUnavailableReason = unavailableReason;
    for (const b of builds) {
      if (b.voucher.id === 'union-degraded') { unionDegraded = true; continue; }
      unionQueried++;
      const note = b.storeNote || (b.solvable ? '可参与求解' : '券面明细未核验（仅展示，不比价）');
      unionBuilds.push({ build: b, note });
      if (b.solvable) {
        unionContentVerified++;
        unionVerifiedIds.add(b.voucher.id);
        if (b.buyLink) b.voucher.buyPath = `官方短链（零收益模式）：${b.buyLink}`;
        pool.push(b.voucher);
      } else {
        tips.push(b.voucher);
        excluded.push({ name: b.voucher.name, priceYuan: b.voucher.priceCents / 100, reason: note });
      }
    }
  } catch { unionDegraded = true; }
  // 层 B：预置知识库（choice 型默认不核验，buildVoucherSlots 失败则仅参考）
  // 层 C：用户自持券
  const candidates = [...pool, ...PRESET_VOUCHERS, ...userVouchers];
  const skus = await loadComboSkus(client, input.storeCode, menu).catch(() => [] as ComboSkuInfo[]);
  const plans = new Map<string, { voucher: Voucher; plan: ComboPlan }>();
  const seenTip = new Set<string>();
  const inPool = new Set<string>();
  const slotCoverage: NonNullable<ChannelDiagnostics['slotCoverage']> = [];
  let presetConsidered = 0, presetAdmitted = 0, userConsidered = 0, userAdmitted = 0;
  for (const v of candidates) {
    if (inPool.has(v.id)) continue;
    if (v.source === 'preset') presetConsidered++;
    if (v.source === 'user') userConsidered++;
    // v1.4 准入修正：combo-ref 单引用可代表多件套餐（展开后由 voucherSlots 校验槽位），
    // 不得用「引用条数 ≥2」把合法的整包券挡在建池门外。
    // v1.4.1「全部团购入池」：核验通过的单品券（1 个槽位）同样入池——1 件也是合法购买单元；
    // 现金立减券（items 为空）仍排除。能否映射到当前门店菜单由 voucherSlots 把关。
    const eligible = v.kind === 'combo' && v.constraints.orderType === 'instore'
      && v.items.length >= 1;
    if (!eligible) {
      if (!seenTip.has(v.id)) { seenTip.add(v.id); tips.push(v); excluded.push({ name: v.name, priceYuan: v.priceCents / 100, reason: v.items.length === 0 ? '现金立减/券面无明细，不参与自动比价' : '非到店组合券' }); }
      continue;
    }
    // v1.4.6 R08：券面星期/餐段规则必须进入「当前可核销」判定。
    //   旧实现只校验有效期区间 → 周六 08:00 也会把「仅周二可核销」的券、晚间也会把早餐券纳入自动方案。
    // v1.4.11 W04：预约单按**目标用餐时刻**判定（周一预约周二不能只用周一的券）；
    //   即时口径 targetRedeemDate() 为 undefined → 与旧行为一致（现在）。
    const target = targetRedeemDate();
    const windowState = redeemWindowStatus({ name: v.name, notes: v.notes, constraints: v.constraints }, target, target ? 'target' : 'now');
    if (!windowState.ok) {
      if (!seenTip.has(v.id)) {
        seenTip.add(v.id); tips.push(v);
        excluded.push({ name: v.name, priceYuan: v.priceCents / 100, reason: `${windowState.reason ?? '当前不在可核销时段'}（可购买，但不参与本次「现在吃」的自动比价）` });
      }
      continue;
    }
    const slotDiag: VoucherSlotDiagnostics = { reasons: [] };
    const slots = voucherSlots(v, menu, skus, slotDiag);
    const declared = slotDiag.groups?.reduce((s, g) => s + g.declared, 0) ?? 0;
    const resolvedUnits = slotDiag.groups?.reduce((s, g) => s + g.resolved, 0) ?? 0;
    const unsupported = slotDiag.groups?.flatMap((g) => g.unsupported.map((u) => u.name)) ?? [];
    const surchargeUnknown = !!slotDiag.surchargeUnknown || !!slotDiag.groups?.some((g) => g.surchargeUnknown);
    if (!slots) {
      // 未核验/无法映射：不进求解池（评审 #1），仅参考展示
      if (!seenTip.has(v.id)) {
        seenTip.add(v.id); tips.push(v);
        excluded.push({ name: v.name, priceYuan: v.priceCents / 100,
          reason: unionVerifiedIds.has(v.id)
            ? `券内容已核验但无法映射到当前门店菜单，未进入自动比价（保留为价格候选）${slotDiag.reasons[0] ? `：${slotDiag.reasons[0]}` : ''}`
            : `券内品项无法映射到当前门店菜单（未核验），不参与自动比价${slotDiag.reasons[0] ? `：${slotDiag.reasons[0]}` : ''}` });
      }
      slotCoverage.push({
        id: v.id, name: v.name, complete: false, declared, resolved: resolvedUnits, unsupported,
        ...(slotDiag.source ? { source: slotDiag.source } : {}),
        ...(slotDiag.reasons.length ? { reasons: slotDiag.reasons.slice(0, 3) } : {}),
      });
      continue;
    }
    slotCoverage.push({
      id: v.id, name: v.name,
      ...(slotDiag.source ? { source: slotDiag.source } : {}),
      complete: slotDiag.complete ?? true,
      declared, resolved: resolvedUnits, unsupported,
      ...(surchargeUnknown ? { surchargeUnknown: true } : {}),
    });
    // 券规则真实化（评审三轮 #1）：单券限购取券面 perUserLimit（搜索上限 4 单元），
    // 整单外部券上限为程序搜索上限（externalCouponLimit=3），均明确标注非平台规则
    const perVoucher = Math.min(v.constraints.perUserLimit ?? 1, 4);
    // v1.4.8 R04：券面**只有** combo-ref 且 qty=1、且全部指向同一官方套餐 → 该券就是那张官方套餐（整包引用）。
    //   只有这种「内容与官方套餐完全同构」的券才被允许独立承接套餐心愿；
    //   带额外食品、固定品项组合或指向不同套餐的券不设置该证据（不得冒充同款）。
    // v1.4.9（R04 边界）：多份同款券（2 份同套餐）会记下 officialComboCopies，
    //   但**不**当作单份需求的独立承接（份数必须精确匹配，否则会少买/多买）；
    //   同时输出一条可读说明，避免「为什么券没被用来承接」只能靠猜。
    const comboRefItems = v.items.filter((it) => it.mode === 'combo-ref');
    const allComboRef = v.items.length > 0 && comboRefItems.length === v.items.length
      && comboRefItems.every((it) => Number(it.qty ?? 1) === 1)
      && new Set(comboRefItems.map((it) => it.keyword)).size === 1;
    const officialComboCode = allComboRef ? comboRefItems[0].keyword : undefined;
    const officialComboCopies = allComboRef ? comboRefItems.length : undefined;
    if (allComboRef && comboRefItems.length > 1) {
      sameComboNotes.push(`券「${v.name}」含 ${comboRefItems.length} 份同款官方套餐（${comboRefItems[0].keyword}）：本轮按「券 + 官方套餐」组合求解，不把它当作单份套餐的独立承接（份数需精确匹配）。`);
    }
    const plan: ComboPlan = {
      id: `kv-${v.id}`,
      channel: v.channel === 'owned' ? 'user' : 'meituan-cps',
      name: v.name,
      basePriceCents: v.priceCents,
      maxQty: Math.max(1, perVoucher),
      maxQtySource: 'voucher-limit',
      isExternalCoupon: true,
      strictCover: true, // PRD v1.3 严格承接入模（评审 #6）
      slots,
      ...(officialComboCode ? { officialComboCode } : {}),
      ...(officialComboCopies ? { officialComboCopies } : {}),
    };
    plans.set(plan.id, { voucher: v, plan });
    inPool.add(v.id);
    if (v.source === 'preset') presetAdmitted++;
    if (v.source === 'user') userAdmitted++;
  }
  // v1.4.2（R13）：区分三态——「内容已识别」→「已映射到本门店」→「实际进入求解池」。
  // 徽章与「自动比价」计数一律取建池成功（plans 内）结果；建池失败项保留为价格候选并给出原因。
  const unionPlanIds = new Set<string>();
  for (const { voucher } of plans.values()) {
    if (voucher.channel === 'meituan' && voucher.id.startsWith('union-')) unionPlanIds.add(voucher.id);
  }
  let unionPoolAdmitted = 0; // 实际进入求解池
  for (const { build: b, note } of unionBuilds) {
    const inPoolNow = unionPlanIds.has(b.voucher.id);
    let status: 'admitted' | 'price-candidate' | 'unavailable';
    let finalNote = note;
    if (inPoolNow) {
      status = 'admitted'; unionPoolAdmitted++;
      finalNote = b.storeNote || '可参与自动比价（已进入求解池）';
    } else if (b.purchasable === false) {
      status = 'unavailable'; // 停售/过期/数据不完整
    } else {
      status = 'price-candidate';
      if (b.solvable) finalNote = `${b.storeNote ? b.storeNote + '；' : ''}内容已核验但无法映射到当前门店菜单，未进入自动比价（保留为价格候选）`;
    }
    unionDealList.push({
      name: b.voucher.name, priceYuan: b.voucher.priceCents / 100, verified: inPoolNow,
      note: finalNote, status,
      ...(b.headUrl ? { headUrl: b.headUrl } : (b.verify?.headUrl ? { headUrl: b.verify.headUrl } : {})),
      ...(b.verify?.status === 'unverified' && b.verify.reasonCode ? { reasonCode: b.verify.reasonCode } : {}),
      ...(b.productViewSign ? { productViewSign: b.productViewSign } : {}), // v1.4.3：CPS 商品身份供人工核验入口精确定位
      ...(b.skuViewId ? { skuViewId: b.skuViewId } : {}),
    });
  }
  // stats 互斥守恒（R13）：查询 = 可自动比价 + 价格候选 + 停售 + 过期 + 其他。
  // 兜底路径 unionCps 不计 queried，内核按实际返回条数补正；未进入自动比价者一律计入价格候选。
  const unionStatsReconciled: typeof unionStats = unionStats ? (() => {
    const queried = unionQueried;
    const consumed = unionPoolAdmitted + unionStats.saleEnded + unionStats.validityExpired + unionStats.other;
    const priceCandidates = Math.max(0, queried - consumed);
    return {
      ...unionStats,
      queried,
      admitted: unionPoolAdmitted,        // 自动比价 = 建池成功（R13）
      menuVerified: unionContentVerified, // 券名↔官方菜单核验通过（内容已识别）
      detailUnverified: priceCandidates,  // 未进入自动比价（含内容已核验但未映射者）
      priceCandidates,
    };
  })() : undefined;
  dbg('券池:', [...plans.values()].map((x) => x.voucher.id).join(',') || '（无）', 'tips:', tips.length);
  const diagnostics: ChannelDiagnostics = {
    union: {
      queried: unionQueried, admitted: unionPoolAdmitted, tips: tips.filter((t) => t.channel === 'meituan' && t.id.startsWith('union-')).length,
      degraded: unionDegraded, dbUsed: unionDbUsed, dbCount: unionDbCount, source: unionSource,
      ...(unionStatsReconciled ? { stats: unionStatsReconciled } : {}),
      ...(unionDealList.length > 0 ? { deals: unionDealList } : {}),
      ...(unionUnavailableReason ? { unavailableReason: unionUnavailableReason } : {}),
    },
    preset: { considered: presetConsidered, admitted: presetAdmitted },
    user: { considered: userConsidered, admitted: userAdmitted },
    ...(slotCoverage.length ? { slotCoverage } : {}),
    voucherPlanRules: {
      perVoucherMaxQty: '单券可买份数 = 券面限购（搜索上限 4 份）',
      externalOrderLimit: '整单外部券 ≤ 3 张（程序搜索上限，非平台规则；真实限购以下单页为准）',
    },
    excluded,
  };
  return { pool: [...plans.values()].map((x) => x.voucher), tips, plans, unionDegraded, unionSolvableCount: unionPoolAdmitted, diagnostics, sameComboNotes };
}

/** 单人模块渠道接入（评审三轮 #1）：导出券方案池 + 渠道诊断供 /api/solve 使用 */
export async function recallChannelPlans(
  client: McpClient,
  input: { storeCode: string; storeName?: string; city?: string },
  menu: MenuLoadResult,
  userVouchers: Voucher[],
): Promise<{ voucherPlans: ComboPlan[]; diagnostics: ChannelDiagnostics }> {
  const r = await recallVouchers(client, { ...input, members: [] }, menu, userVouchers);
  return { voucherPlans: [...r.plans.values()].map((x) => x.plan), diagnostics: r.diagnostics };
}

/** 统一候选（评审三轮 #6）：跨轨去重 + 排序（需求满足 → 优先级 → 价格），最多 5 个。
 *  v1.2：去重签名剔除非食品段（玩具/餐具）——玩具变化不产生"不同方案"。
 *  v1.3：同签名冲突时优先保留「有效核价」方案（旧实现保留先到者，会出现
 *  「同购物篮 20 元模型价挤掉 15 元有效核价」的倒挂），随后统一重排。
 *  v1.4.6 R02：签名改为**食物内容**（食品/规格/数量），不再含购买 code/planId——
 *  同一份「麦香鸡＋香芋派」从实时券、知识库券或官方套餐得到时只占一个名额，
 *  其余来源收进 purchaseOptions 作为可选购买途径（价格与证据等级分别标注）。 */
/** 「吃什么」签名（v1.4.7 R02/R03）：逐份结构化食品（身份/规格/数量）聚合为多重集；
 *  **不再**从 perUnitConfig 字符串反推（同名不同规格会串、套餐/散点分块会重复占名额）。
 *  旧契约（无 foods 字段）回退为「品名 + 份数」，仅作兼容，不与新数据混用。 */
function foodContentSigOf(s: KernelGroupSolution): string {
  const units: FoodUnitRef[] = [];
  for (const b of s.basket) {
    if (b.foods && b.foods.length > 0) {
      for (const f of b.foods) units.push({ code: f.code, name: f.name, spec: f.spec, qty: Math.max(1, f.qty) });
      continue;
    }
    for (let i = 0; i < Math.max(1, b.qty); i++) units.push({ name: b.name, qty: 1 });
  }
  return foodMultisetSignature(units);
}

const priceEvidence = (s: KernelGroupSolution): number =>
  s.totals.priceSource === 'calculate-price' ? 2 : s.totals.priceSource === 'mixed' ? 1 : 0;

/** v1.4.8 R03：在统一候选里定位「被选中的方案」。去重时 keep 可能是另一个对象，
 *  直接 indexOf 会落到 -1（旧实现静默回落 0 号，把不相干的方案标成推荐）。 */
function indexOfCandidate(list: KernelGroupSolution[], target: KernelGroupSolution): number {
  const direct = list.indexOf(target);
  if (direct >= 0) return direct;
  const sig = foodContentSigOf(target);
  const bySig = list.findIndex((x) => foodContentSigOf(x) === sig);
  return bySig >= 0 ? bySig : 0;
}

function purchaseOptionOf(s: KernelGroupSolution): NonNullable<KernelGroupSolution['purchaseOptions']>[number] {
  const channels = [...new Set(s.basket.map((b) => b.channelLabel).filter(Boolean))];
  const label = channels.length > 0 ? channels.join(' + ') : (s.track === 'voucher' ? '渠道券' : '官方 App');
  return {
    label, paidCents: s.totals.paidCents, priceSource: s.totals.priceSource, track: s.track,
    ...(s.trackNote ? { note: s.trackNote } : {}),
    // v1.4.10 W14：可执行明细（品名×份数 + 换选配置），与卡内购买清单同源
    items: s.basket.map((b) => `${b.name}×${b.qty}${b.perUnitConfig?.length ? `（${b.perUnitConfig.join(' / ')}）` : ''}`),
  };
}

export function unifyCandidates(
  tracks: KernelGroupSolution[],
  cmp?: (a: KernelGroupSolution, b: KernelGroupSolution) => number,
): KernelGroupSolution[] {
  const bySig = new Map<string, KernelGroupSolution>();
  for (const t of tracks) {
    for (const s of [t, ...(t.alternatives ?? [])]) {
      const sig = foodContentSigOf(s);
      const existing = bySig.get(sig);
      if (!existing) { bySig.set(sig, s); continue; }
      // 同购物篮：有效核价 > 混合 > 模型价；同证据级别取实付更低者
      const better = priceEvidence(s) > priceEvidence(existing)
        || (priceEvidence(s) === priceEvidence(existing) && s.totals.paidCents < existing.totals.paidCents);
      const keep = better ? s : existing;
      // 购买途径并列保留（去重：同渠道 + 同实付只留一条）
      const opts = [...(existing.purchaseOptions ?? [purchaseOptionOf(existing)]), ...(s.purchaseOptions ?? [purchaseOptionOf(s)])];
      const seen = new Set<string>();
      keep.purchaseOptions = opts.filter((o) => {
        const k = `${o.label}|${o.paidCents}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      bySig.set(sig, keep);
    }
  }
  const all = [...bySig.values()];
  const byGap = (a: KernelGroupSolution, b: KernelGroupSolution) => (a.gapTotal - b.gapTotal) || (a.totals.paidCents - b.totals.paidCents);
  all.sort(cmp ?? byGap);
  return all.slice(0, Math.max(1, CONFIG.maxUnifiedPlans));
}

/** 随心配型 SKU 增补（legacy 轨 2 同源数据）：品名/标签不触发 isCombo 识别的 1+1 SKU
 *  （如「人气经典随心配」）在菜单层无 deconstruction，buildPlansFromMenuItems 会漏掉；
 *  用 loadComboSkus 的实测 rounds（含 roundId/选项 code/diffPrice）补齐方案池。
 *  v1.4.6 R15：**不得静默删除空轮次**。旧实现 `.filter(options.length > 0)` 后只要求剩余 ≥2 槽，
 *  三轮套餐的第三轮缺名称时会被缩成两件餐并照常入池（必选食品凭空消失）。
 *  现在任一轮次无可用选项 → 该 SKU 整体不入池，并记录原因（宁可不可用，不可少给食品）。 */
export function augmentComboPlans(
  comboPlans: ComboPlan[],
  skus: ComboSkuInfo[],
  menu: MenuLoadResult,
): { plans: ComboPlan[]; skipped: Array<{ name: string; reason: string }> } {
  const have = new Set(comboPlans.map((p) => p.id));
  const extra: ComboPlan[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const sku of skus) {
    const id = 'mcd-' + sku.code;
    if (have.has(id)) continue;
    const slots: ComboPlan['slots'] = sku.rounds.map((r, idx) => ({
      roundName: r.name || `轮次 ${idx + 1}`,
      roundId: r.id,
      defaultName: sku.deconstruction?.[idx]?.defaultName ?? r.choices[0]?.name ?? '',
      options: r.choices
        .map((c) => {
          const mi = menu.items.find((x) => x.name === c.name);
          if (mi) return { ...optionOfMenuItem(mi, c.diffCents), code: c.code || mi.code };
          const nut = resolveComponentNutrition(c.name);
          const known = nut.matched;
          const drink = isDrinkName(c.name, undefined, sku.deconstruction?.[idx]?.category);
          // v1.4.4 R04：逐字段可信性（补录可能部分字段未知）；估算值带 estimated 标记
          const fk = (m: NutritionMetric) => nutritionFieldKnown(nut, m);
          const carbKnown = fk('carbohydrate');
          const sugaryVal = sugaryOf(c.name, drink, carbKnown, nut.carbohydrate);
          return {
            name: c.name, kcal: fk('kcal') ? nut.kcal : 0, kcalKnown: fk('kcal'),
            priceCents: 0, diffCents: c.diffCents,
            staple: RE_STAPLE_OPT.test(c.name) && !/薯/.test(c.name), veggie: /蔬菜|沙拉|玉米|苹果片/.test(c.name),
            code: c.code, fastCarb: carbKnown && drink && nut.carbohydrate >= 5 ? nut.carbohydrate : 0,
            fastCarbKnown: !drink || sugaryVal !== undefined, drink, sugary: sugaryVal,
            protein: fk('protein') ? nut.protein : 0, fat: fk('fat') ? nut.fat : 0,
            carbohydrate: carbKnown ? nut.carbohydrate : 0, sodium: fk('sodium') ? nut.sodium : 0,
            ...(nut.valueKind === 'estimate' ? { estimated: true } : {}),
            ...(nut.unknownFields.length ? { unknownNutrition: [...nut.unknownFields] } : {}),
            ...(known ? { nutritionSource: nut.sourceLabel } : {}),
          };
        })
        .filter((o) => !!o.name),
    }));
    const emptyRounds = slots.filter((s) => s.options.length === 0).map((s) => s.roundName);
    if (emptyRounds.length > 0) {
      skipped.push({
        name: sku.name,
        reason: `官方 SKU 轮次「${emptyRounds.join('、')}」无可用选项，无法完整建模（不按剩余轮次缩水入池）`,
      });
      continue;
    }
    if (slots.length >= 2) {
      extra.push({
        id, channel: 'mcd-mcp', name: sku.name, basePriceCents: sku.priceCents,
        maxQty: 3, maxQtySource: 'program-cap', slots,
      });
    }
  }
  return { plans: [...comboPlans, ...extra], skipped };
}

// ---------- S3 三轨求解（嵌套池 + 软重解） ----------

interface TrackRun { results: OptimizeResult[]; truncated?: boolean }

async function runTrack(plans: ComboPlan[], memberReqs: MemberReq[]): Promise<TrackRun | null> {
  // v6：软需求带缺口变量（最不满意成员缺口 → 全体缺口 → 价格 → 剩余），
  // 不再整批删成员心愿；覆盖率恒以原始需求为分母（评审二轮 #4/#5）
  // v1.4.7 R11：预算只计新增内容轮次；耗尽时标注「备选搜索截断」（不得暗示只有一种组合）
  let truncated = false;
  const results = await optimizeTopK(
    { plans, members: memberReqs, mode: 'cheapest', strictSurplus: false, externalCouponLimit: 3 },
    3,
    { onTruncated: () => { truncated = true; } },
  );
  return results.length > 0 ? { results, ...(truncated ? { truncated: true } : {}) } : null;
}

// ---------- S5 核价（官方部分 calculate-price；券部分参考价） ----------

function roundListOf(a: OptimizeResult['assignments'][number]): Array<{ round: string; comboItemList: Array<{ code: string; quantity: number }> }> | undefined {
  const byRound = new Map<string, Map<string, number>>();
  for (const u of a.units) {
    for (const sc of u.slotChoices) {
      if (!sc.roundId || !sc.optionCode) continue;
      if (!byRound.has(sc.roundId)) byRound.set(sc.roundId, new Map());
      const m = byRound.get(sc.roundId)!;
      m.set(sc.optionCode, (m.get(sc.optionCode) ?? 0) + (sc.count ?? 1));
    }
  }
  return byRound.size > 0
    ? [...byRound.entries()].map(([round, items]) => ({
        round,
        comboItemList: [...items.entries()].map(([code, quantity]) => ({ code, quantity })),
      }))
    : undefined;
}

function officialBasketOf(
  r: OptimizeResult,
  planById?: Map<string, ComboPlan>,
): Array<{ code: string; qty: number; roundList?: Array<{ round: string; comboItemList: Array<{ code: string; quantity: number }> }> }> {
  const basket: Array<{ code: string; qty: number; roundList?: Array<{ round: string; comboItemList: Array<{ code: string; quantity: number }> }> }> = [];
  for (const a of r.assignments) {
    if (a.channel !== 'mcd-mcp') continue;
    const plan = planById?.get(a.planId);
    // v1.4.10 W02：规格型单品必须用**父 SKU** + 规格轮次履约；内部计划 id（mcd-spec-…）
    //   绝不能当 productCode 发给核价/下单接口。
    if (plan?.fulfillCode) {
      const roundList = roundListOf(a);
      basket.push({ code: plan.fulfillCode, qty: a.qty, ...(roundList ? { roundList } : {}) });
      continue;
    }
    if (a.planId.startsWith('mcd-spec-')) {
      // 无官方规格轮次证据：仍按父 SKU 基础价履约（价格标注为未核验），绝不发内部 ID
      const code = a.planId.slice('mcd-spec-'.length).split('-')[0];
      basket.push({ code, qty: a.qty });
      continue;
    }
    if (a.planId.startsWith('mcd-s-')) {
      basket.push({ code: a.planId.slice(6), qty: a.qty });
      continue;
    }
    // 套餐：由 per-unit 配置聚合 roundList（roundId + 选项 code + 数量，评审 #5 贯通链路）
    const roundList = roundListOf(a);
    basket.push({ code: a.planId.slice(4), qty: a.qty, ...(roundList ? { roundList } : {}) });
  }
  return basket;
}

async function quoteWithRounds(
  client: McpClient,
  storeCode: string,
  items: Array<{ code: string; qty: number; roundList?: Array<{ round: string; comboItemList: Array<{ code: string; quantity: number }> }> }>,
  memo?: Map<string, { priceCents: number; discountCents: number } | null>,
): Promise<{ priceCents: number; discountCents: number } | null> {
  if (items.length === 0) return { priceCents: 0, discountCents: 0 };
  const key = JSON.stringify(items);
  const hit = memo?.get(key);
  if (hit !== undefined) return hit;
  let out: { priceCents: number; discountCents: number } | null = null;
  try {
    const res = await client.call('calculate-price', withOrderParams({
      storeCode, orderType: 1, beType: 1,
      items: items.map((i) => ({ productCode: i.code, quantity: i.qty, ...(i.roundList ? { roundList: i.roundList } : {}) })),
    }));
    const d = res.data as { price?: number; discount?: number };
    if (typeof d?.price === 'number' && d.price > 0) out = { priceCents: d.price, discountCents: d.discount ?? 0 };
  } catch { out = null; }
  memo?.set(key, out);
  return out;
}

// ---------- S6 契约映射（GroupSolution 组装 + 分账） ----------

function assignmentsPriceOf(r: OptimizeResult, filter: (planId: string, channel: string) => boolean): number {
  return r.assignments
    .filter((a) => filter(a.planId, a.channel))
    .reduce((s, a) => s + a.qty * a.basePriceCents + a.slotChoices.reduce((ss, sc) => ss + sc.diffCents * (sc.count ?? 1), 0), 0);
}

function basketEntriesOf(
  r: OptimizeResult,
  planVouchers: Map<string, { voucher: Voucher; plan: ComboPlan }>,
  planById?: Map<string, ComboPlan>,
): BasketEntry[] {
  const out: BasketEntry[] = [];
  /** v1.4.7 R02/R03：逐份展开的结构化食品清单（非食品剔除）——身份签名/前端分组只用它 */
  const foodsOf = (a: PlanAssignment): NonNullable<BasketEntry['foods']> => {
    const foods: NonNullable<BasketEntry['foods']> = [];
    for (const u of a.units) {
      for (const sc of u.slotChoices) {
        if (sc.nonFood) continue;
        foods.push({
          ...(sc.optionCode ? { code: sc.optionCode } : {}),
          name: sc.chosenName,
          ...(sc.specLabel ? { spec: sc.specLabel } : {}),
          qty: 1,
        });
      }
    }
    return foods;
  };
  for (const a of r.assignments) {
    const perUnit = a.units.map((u) => u.slotChoices.map((sc) => sc.chosenName).join('＋'));
    const foodChoices = a.slotChoices.filter((sc) => !sc.nonFood);
    const nutritionSources = [...new Set(foodChoices.map((sc) => sc.nutritionSource).filter((x): x is string => !!x))];
    const nutritionEstimated = foodChoices.some((sc) => !!sc.estimated);
    const nutritionUnknownFields = [...new Set(foodChoices.flatMap((sc) => sc.unknownNutrition ?? []))];
    const foods = foodsOf(a);
    if (a.channel === 'mcd-mcp') {
      const plan = planById?.get(a.planId);
      const isSinglePlan = a.planId.startsWith('mcd-s-') || a.planId.startsWith('mcd-spec-');
      out.push({
        kind: isSinglePlan ? 'single' : 'combo',
        code: plan?.fulfillCode ?? (a.planId.startsWith('mcd-spec-')
          ? a.planId.slice('mcd-spec-'.length).split('-')[0]
          : a.planId.startsWith('mcd-s-') ? a.planId.slice(6) : a.planId.slice(4)),
        name: a.planName, qty: a.qty,
        refPriceCents: a.qty * a.basePriceCents + a.slotChoices.reduce((s, sc) => s + sc.diffCents * (sc.count ?? 1), 0),
        perUnitConfig: perUnit,
        foods,
        ...(nutritionSources.length ? { nutritionSources } : {}),
        ...(nutritionEstimated ? { nutritionEstimated: true } : {}),
        ...(nutritionUnknownFields.length ? { nutritionUnknownFields } : {}),
        ...(isSinglePlan && !plan?.fulfillRoundId ? {} : { roundList: roundListOf(a) }),
        channelLabel: '官方 App',
      });
    } else {
      const vp = planVouchers.get(a.planId);
      const validNote = vp?.voucher.notes?.find((n) => n.startsWith('券有效期'));
      out.push({
        kind: 'voucher', code: a.planId, name: a.planName, qty: a.qty,
        refPriceCents: a.qty * a.basePriceCents + a.slotChoices.reduce((s, sc) => s + sc.diffCents * (sc.count ?? 1), 0),
        perUnitConfig: perUnit,
        foods,
        ...(nutritionSources.length ? { nutritionSources } : {}),
        ...(nutritionEstimated ? { nutritionEstimated: true } : {}),
        ...(nutritionUnknownFields.length ? { nutritionUnknownFields } : {}),
        ...(roundListOf(a) ? { roundList: roundListOf(a) } : {}),
        ...(validNote ? { validNote } : {}),
        channelLabel: vp ? vp.voucher.channelLabel : '渠道券',
      });
    }
  }
  return out;
}

/** 心愿口径覆盖率（v1.4.11 W09）：按**稳定心愿逐条**计量，不再用「总数 − 未匹配 − 缺口」混合扣减。
 *  旧实现把条数、份数缺口与未匹配混在一起：一条多份心愿缺 3 份会抹掉另一条已满足心愿；
 *  一人满足、一人未匹配显示 0/2；因禁忌空手却仍显示 2/2。
 *  现在：每条心愿独立判定——未匹配、命中禁忌、解析无需求内容均不计入分母；
 *  已解析的心愿必须其对应需求全部 satisfied 才算满足（份数缺口只影响该条，不牵连其它条）。 */
function wishLevelCoverage(
  input: GroupOrderInput,
  r: OptimizeResult,
  ctx: {
    resolved: ResolvedDemand[];
    unresolvedByMember: Map<number, string[]>;
    tabooByMember: Map<number, string[]>;
  },
): { total: number; met: number } {
  const wishTotal = input.members.reduce((s, m) => s + (m.wishes?.length ?? 0), 0);
  if (wishTotal === 0) return r.coverage; // 没有心愿（只有禁忌）→ 沿用需求口径
  const key = (mi: number, raw: string): string => `${mi}\u0000${raw}`;
  const resolvedByKey = new Map<string, ResolvedDemand[]>();
  for (const rd of ctx.resolved) {
    const k = key(rd.mi, rd.raw);
    resolvedByKey.set(k, [...(resolvedByKey.get(k) ?? []), rd]);
  }
  const unresolved = new Set<string>();
  for (const [mi, list] of ctx.unresolvedByMember) for (const raw of list) unresolved.add(key(mi, raw));
  const tabooOf = (mi: number, raw: string): boolean =>
    (ctx.tabooByMember.get(mi) ?? []).some((s) => s === raw || s.startsWith(raw + '（'));
  let total = 0, met = 0;
  input.members.forEach((m, mi) => {
    for (const raw of m.wishes ?? []) {
      const rds = resolvedByKey.get(key(mi, raw)) ?? [];
      const isUnresolved = unresolved.has(key(mi, raw));
      const isTaboo = tabooOf(mi, raw);
      // 既未解析出需求、也不在未匹配/禁忌清单里（如「随意」）→ 不是一条可计量的需求，不进分母
      if (rds.length === 0 && !isUnresolved && !isTaboo) continue;
      total++;
      if (isUnresolved || isTaboo || rds.length === 0) continue;
      const ok = rds.every((rd) => {
        const out = r.memberAllocations[mi]?.demands.find((d) => d.id === rd.demand.id);
        return out?.satisfied === true;
      });
      if (ok) met++;
    }
  });
  return { total, met };
}

function toGroupSolution(
  track: GroupSolution['track'],
  input: GroupOrderInput,
  r: OptimizeResult,
  ctx: {
    resolved: ResolvedDemand[];
    unresolvedByMember: Map<number, string[]>;
    tabooByMember: Map<number, string[]>;
    matchWarnings: string[];
    quote: { useQuote: boolean; discountCents: number; priceCents: number } | null;
    voucherPartCents: number;
    planVouchers: Map<string, { voucher: Voucher; plan: ComboPlan }>;
    planById?: Map<string, ComboPlan>;
    unionDegraded: boolean;
    unionSolvableCount: number;
    /** v1.4.4 R06：无候选需求（未匹配心愿）的 demand id——其原文已在 unresolvedByMember 中，
     *  此处跳过，避免同一条心愿重复出现在未满足提示里。 */
    unmatchedIds: Set<string>;
  },
): KernelGroupSolution {
  const storeCode = input.storeCode;
  const warnings: string[] = [...ctx.matchWarnings];
  const demandRaw = new Map(ctx.resolved.map((rd) => [rd.demand.id, rd]));

  const members: GroupMemberResult[] = input.members.map((m, mi) => {
    const alloc = r.memberAllocations[mi];
    const items: GroupMemberResult['items'] = [];
    for (const it of alloc.items) {
      const isSingle = it.fromPlanId.startsWith('mcd-s-');
      const isVoucherPlan = ctx.planVouchers.has(it.fromPlanId);
      const rd = ctx.resolved.find((x) => x.mi === mi && x.hit?.name === it.itemName && x.specRow);
      items.push({
        code: it.optionCode ?? it.itemName,
        name: it.itemName,
        qty: it.qty,
        priceCents: Math.round(it.refPriceCents / Math.max(1, it.qty)),
        isCombo: !isSingle && !isVoucherPlan, // 官方套餐子项 → 官方套餐分组；券品走 viaVoucherId
        nutritionMatched: it.kcalKnown !== false,
        ...(it.nutritionSource ? { nutritionSource: it.nutritionSource } : {}),
        ...(it.estimated ? { nutritionEstimated: true } : {}),
        ...(it.unknownNutrition?.length ? { nutritionUnknownFields: it.unknownNutrition.slice() } : {}),
        isBundleItem: !isSingle,
        ...(isVoucherPlan ? { viaVoucherId: it.fromPlanId } : {}),
        ...(isSingle ? {} : { fromPlan: it.planName }),
        ...(rd?.specRow && rd.hit && rd.specRow.row.energyKcal !== rd.hit.kcal ? { nutritionNote: `按${rd.specRow.label} ${rd.specRow.row.energyKcal} kcal` } : {}),
      });
    }
    const unresolved = [...(ctx.unresolvedByMember.get(mi) ?? [])];
    for (const d of alloc.demands.filter((x) => !x.satisfied)) {
      if (ctx.unmatchedIds.has(d.id)) continue;   // R06：原文已在 unresolvedByMember 中，不重复
      const rd = demandRaw.get(d.id);
      unresolved.push(rd ? `${rd.raw}（${d.exact ? '恰好' : '至少'}${d.qty} 份，当前方案未能满足）` : d.keyword);
    }
    const nutritionUnknownFields = [...new Set(items.flatMap((item) => item.nutritionUnknownFields ?? []))];
    const nutritionSources = [...new Set(items.map((item) => item.nutritionSource).filter((source): source is string => !!source))];
    const nutritionKcalPartial = items.some((item) => item.nutritionMatched === false || item.nutritionUnknownFields?.includes('kcal'));
    const nutritionEstimated = items.some((item) => !!item.nutritionEstimated);
    const res: GroupMemberResult = {
      alias: m.alias,
      items,
      ...(nutritionKcalPartial ? { nutritionKcalPartial: true } : {}),
      ...(nutritionEstimated ? { nutritionEstimated: true } : {}),
      ...(nutritionUnknownFields.length ? { nutritionUnknownFields } : {}),
      ...(nutritionSources.length ? { nutritionSources } : {}),
      originalCents: Math.max(0, alloc.refPriceCents),
      shareCents: 0, payableCents: 0, savedCents: 0,
      personalCouponCents: m.personalCouponCents,
      kcal: alloc.kcal,
      unresolvedWishes: unresolved,
      tabooFiltered: ctx.tabooByMember.get(mi) ?? [],
      ...(m.notes?.length ? { note: m.notes.join('；') } : {}),
    };
    if (ctx.unresolvedByMember.get(mi)?.length) {
      warnings.push(`@${m.alias} 的心愿「${ctx.unresolvedByMember.get(mi)!.join('、')}」在当前门店菜单未匹配到品项，请点餐人在官方 APP 检索后补单。`);
    }
    return res;
  });

  // 分账（原价等比；剩余成本按原价并入基数后【全体均摊】，尾差仅分级差归末位——评审二轮 #8：
  // 旧公式把 paid−Σ比例份额 全部甩给末位成员，等额食品会分出 10/20）
  const totalOriginal = members.reduce((s, m) => s + m.originalCents, 0);
  const leftoverCents = r.totals.leftoverCents;
  const base = totalOriginal + leftoverCents;
  const officialModelCents = assignmentsPriceOf(r, (_p, ch) => ch === 'mcd-mcp');
  const voucherRefCents = ctx.voucherPartCents;
  const quote = ctx.quote;
  const useQuote = !!quote && quote.useQuote;
  const officialPaid = useQuote ? Math.max(0, (quote!.priceCents ?? 0)) : officialModelCents;
  const paidCents = voucherRefCents + officialPaid;
  // v1.4.4 R08：参考价全缺时的**显式分摊依据**。
  //   套餐组件仅在套餐内存在（无独立单品参考价）→ 各成员 originalCents 全为 0 → base=0。
  //   旧实现 base>0 ? ... : 0 后把整单当尾差加给末位成员：两人各得一份 ¥20 套餐却分成 ¥0/¥40，
  //   且成员换序后付款人随之交换（与顺序相关，非分摊）。
  //   现改为：以「本人所得食品单位数」为权重等分摊（全缺/部分缺同口径，顺序无关）；
  //   单位数也为 0（无食品）时按人数等额分摊。尾差始终仅限舍入分级差。
  const unitCounts = members.map((m) => m.items.reduce((s, i) => s + Math.max(1, i.qty), 0));
  const unitTotal = unitCounts.reduce((s, x) => s + x, 0);
  const missingRef = members.some((m, i) => m.originalCents === 0 && unitCounts[i] > 0);
  const useUnitBasis = missingRef && unitTotal > 0;
  let rawShares: number[];
  if (useUnitBasis) {
    // 单位数等分摊：剩余成本一并按单位数分摊（不叠加人均项，避免总额溢出）
    rawShares = members.map((_m, i) => Math.round((unitCounts[i] / unitTotal) * paidCents));
  } else if (base > 0) {
    const leftoverCost = (paidCents * leftoverCents) / base;
    const perMemberLeftover = members.length > 0 ? leftoverCost / members.length : 0;
    rawShares = members.map((m) => Math.round((m.originalCents / base) * paidCents + perMemberLeftover));
  } else {
    // 无参考价且无食品单位：按人数等额分摊（仍有明确依据，不甩给末位）
    rawShares = members.map(() => (members.length > 0 ? Math.round(paidCents / members.length) : 0));
  }
  if (members.length > 0) {
    rawShares[members.length - 1] += paidCents - rawShares.reduce((s, x) => s + x, 0); // 尾差（分级差）
  }
  if (useUnitBasis) {
    warnings.push('部分食品仅在套餐内提供、无独立参考价，本次分账改按「各自所得食品份数」等分摊（非原价等比）；如需按原价分摊请单点对应食品后重算。');
  }
  members.forEach((m, idx) => {
    m.shareCents = Math.max(0, rawShares[idx]);
    m.payableCents = Math.max(0, m.shareCents - (m.personalCouponCents ?? 0));
    m.savedCents = Math.max(0, m.originalCents - m.shareCents);
    if ((m.personalCouponCents ?? 0) > 0) {
      warnings.push(`@${m.alias} 的个人券（¥${((m.personalCouponCents ?? 0) / 100).toFixed(2)}）已在其应付中冲减，请点餐人核对该券适用条件。`);
    }
  });

  if (leftoverCents > 0) {
    warnings.push(`存在未分配剩余品项（参考价 ¥${(leftoverCents / 100).toFixed(1)}），费用已按原价并入分账基数由全体成员均摊。`);
  }
  if (r.gapTotal > 0 || r.unmetDemands.some((u) => u.reason === 'unsatisfied')) {
    warnings.push('部分心愿无法完全满足，已按「最不满意成员缺口最小 → 全体缺口最小 → 最低价」的优先级给出近似方案（覆盖率以原始心愿为分母）。');
  }
  const unmetCount = r.unmetDemands.length;
  // v1.4.10 W07：结构化缺口（去重 + 份数合并）。出口三处共用，避免分账/复制清单丢缺口。
  // v1.4.11 W09：同一条心愿既被判 no-candidate 又留 unsatisfied 时，只保留更具体的原因，
  //   份数取较大值（不把同 1 份重复计成 2 份缺口）。
  const unmetList: NonNullable<KernelGroupSolution['unmet']> = [];
  {
    const reasonRank: Record<string, number> = { taboo: 4, 'no-candidate': 3, 'structure-unknown': 2, 'kcal-unknown': 2, unsatisfied: 1 };
    const seen = new Map<string, NonNullable<KernelGroupSolution['unmet']>[number]>();
    for (const u of r.unmetDemands) {
      const key = `${u.alias}|${u.keyword}`;
      const qty = Math.max(1, u.missingQty ?? 1);
      const hit = seen.get(key);
      if (!hit) {
        const item = { alias: u.alias, keyword: u.keyword, reason: u.reason, missingQty: qty };
        seen.set(key, item);
        unmetList.push(item);
        continue;
      }
      if (hit.reason === u.reason) { hit.missingQty += qty; continue; }
      if ((reasonRank[u.reason] ?? 0) > (reasonRank[hit.reason] ?? 0)) hit.reason = u.reason;
      hit.missingQty = Math.max(hit.missingQty, qty);
    }
    // v1.4.11 W09：禁忌冲突 / 完全未解析的心愿也要有结构化缺口记录。
    //   覆盖率已按心愿口径扣掉，但缺口语义不能静默——否则用户只看到 1/2 却找不到少的那条。
    const tabooBlocked = new Map<string, string[]>();
    input.members.forEach((m, mi) => {
      const taboos = ctx.tabooByMember.get(mi) ?? [];
      const unresolved = ctx.unresolvedByMember.get(mi) ?? [];
      for (const raw of m.wishes ?? []) {
        const key = `${m.alias}|${raw}`;
        if (seen.has(key)) continue;
        const isTaboo = taboos.some((s) => s === raw || s.startsWith(raw + '（'));
        if (!isTaboo && !unresolved.includes(raw)) continue;
        const item = { alias: m.alias, keyword: raw, reason: (isTaboo ? 'taboo' : 'no-candidate') as 'taboo' | 'no-candidate', missingQty: 1 };
        seen.set(key, item);
        unmetList.push(item);
        if (isTaboo) tabooBlocked.set(m.alias, [...(tabooBlocked.get(m.alias) ?? []), raw]);
      }
    });
    for (const [alias, ks] of tabooBlocked) {
      warnings.push(`@${alias} 以下心愿与本人禁忌冲突，本次未安排：${ks.join('、')}（如需保留请先确认禁忌口径）`);
    }
  }
  if (unmetCount > 0) {
    const byAlias = new Map<string, Set<string>>();
    for (const u of r.unmetDemands) {
      if (!byAlias.has(u.alias)) byAlias.set(u.alias, new Set());
      // 同一心愿的 no-candidate 与 unsatisfied 记录去重（v1.2：不再重复罗列）
      byAlias.get(u.alias)!.add(u.keyword + (u.reason === 'kcal-unknown' ? '（营养未收录，控卡无法验证）' : ''));
    }
    for (const [alias, ks] of byAlias) warnings.push(`@${alias} 以下心愿在当前方案池中无可用候选：${[...ks].join('、')}`);
  }
  if (!quote) warnings.push('计价接口本次未能返回报价，官方部分按 MILP 模型价（菜单价口径）估算，实际以门店结算为准。');
  else if (officialModelCents > 0 && (quote!.priceCents ?? 0) > officialModelCents) {
    warnings.push(`渠道核价 ¥${((quote!.priceCents ?? 0) / 100).toFixed(1)} 高于模型估算 ¥${(officialModelCents / 100).toFixed(1)}，已按核价呈现（差额可能来自套餐裸码计价/换选差价/优惠条件，以下单页为准）。`);
  }
  warnings.push('本方案由 MILP 统一内核求解：价格为模型内最优（已核价候选中最低），换选与结算以官方下单页为准。');
  if (input.members.some((m) => m.notes?.length)) {
    warnings.push('特制需求已写入订单备注，以官方下单页可履约选项为准。');
  }

  const orderNotes = input.members.filter((m) => m.notes?.length).map((m) => `${m.alias}：${m.notes!.join('；')}（特制需求以官方下单页可履约选项为准）`);

  const priceSource: GroupSolution['totals']['priceSource'] = voucherRefCents > 0 ? 'mixed' : useQuote ? 'calculate-price' : 'menu-price';
  const priceNote = voucherRefCents > 0
    ? `券部分 ¥${(voucherRefCents / 100).toFixed(1)}（参考价）+ 官方部分 ¥${(officialPaid / 100).toFixed(1)}（${useQuote ? '计价接口核验' : '模型价估算'}）`
    : useQuote ? '计价接口核验（含整单优惠）' : 'MILP 模型价（菜单价口径）';

  return {
    store: { storeCode, storeName: input.storeName ?? `门店 ${storeCode}` },
    track,
    trackNote: `MILP 内核 · 心愿覆盖 ${r.coverage.met}/${r.coverage.total} · 模型内最优${r.status === 'proven-optimal' ? '' : '（可行解）'}` +
      (r.gapTotal > 0 ? ` · 近似方案（缺口 ${r.gapTotal} 份）` : ''),
    members,
    orderNotes: orderNotes.length > 0 ? orderNotes : ['无特制需求，按标准配方下单即可。'],
    totals: {
      originalCents: totalOriginal,
      paidCents,
      discountCents: Math.max(0, totalOriginal - paidCents),
      priceSource,
      priceNote,
    },
    deliveryFeeCents: 0,
    warnings,
    disclaimer:
      '数据来自麦当劳官方 MCP（菜单/计价），券价为合规渠道参考价。本工具仅输出决策清单与分账凭证，' +
      '不代下单、不托管资金、不共享他人账户权益。',
    // v1.4.9（R02 边界）：覆盖率改成**心愿口径**。
    //   旧实现直接用优化器的需求单元计数：一条心愿可能拆成多个单元，未匹配的心愿不产生单元，
    //   于是「板烧鸡腿麦满分套餐（结构未取得）」显示未满足、同成员另一条心愿满足时仍显示 2/2。
    //   现在 = 心愿总数 − 未匹配心愿数 − 需求缺口，且不低于 0。
    coverage: wishLevelCoverage(input, r, ctx),
    solveState: r.status,
    kernel: 'milp-v6',
    basket: basketEntriesOf(r, ctx.planVouchers, ctx.planById),
    gapTotal: r.gapTotal,
    alternatives: [],
    ...(r.leftovers.length > 0 ? { leftovers: r.leftovers } : {}),
    ...(unmetList.length > 0 ? { unmet: unmetList } : {}),
  };
}

// ---------- 轨 3 履约明细（VoucherTrackSolution 兼容契约） ----------

/** v1.4.8 R05：把一次券购买展开成「实际购买的食品单元」（同配比价的唯一对象）。
 *  规格取自 slotChoice.specLabel（不再依赖括号被删掉的显示名），官方单点价取自该券计划选项。 */
function voucherUnitsOf(
  assign: OptimizeResult['assignments'][number],
  plan: ComboPlan,
): Array<{ name: string; spec?: string; qty: number; officialUnitPriceCents: number }> {
  const out: Array<{ name: string; spec?: string; qty: number; officialUnitPriceCents: number }> = [];
  for (const u of assign.units) {
    for (const sc of u.slotChoices) {
      const slot = plan.slots.find((s) => s.roundName === sc.roundName);
      const opt = slot?.options.find((o) => (sc.optionCode && o.code === sc.optionCode) || o.name === sc.chosenName);
      out.push({
        name: sc.chosenName,
        ...(sc.specLabel ? { spec: sc.specLabel } : {}),
        qty: Math.max(1, sc.count ?? 1),
        officialUnitPriceCents: opt?.priceCents ?? 0,
      });
    }
  }
  return out;
}

function buildVoucherTrack(
  track3: KernelGroupSolution,
  r3: OptimizeResult,
  input: GroupOrderInput,
  ctx: {
    resolved: ResolvedDemand[];
    planVouchers: Map<string, { voucher: Voucher; plan: ComboPlan }>;
    tips: Voucher[];
    skus: ComboSkuInfo[];
    unionDegraded: boolean;
    unionSolvableCount: number;
    officialPaidCents: number;
    track2PaidCents: number;
  },
): (VoucherTrackSolution & KernelGroupSolution) | null {
  // v1.4 修复（评审第 5 项）：遍历「全部券购买记录」，不再只取第一种券——
  // 多券/多份券的数量、配置、补差、核销逐券输出；保证 Σ券费 + 官方费 = 方案总价 = 分账合计。
  const voucherAssigns = r3.assignments.filter((a) => ctx.planVouchers.has(a.planId));
  if (voucherAssigns.length === 0) return null; // 未购买任何券 → 与 legacy 行为一致返回 null

  const coveredWishes: Array<{ alias: string; wish: string; itemName: string }> = [];
  const selectedBreakdown: VoucherBreakdown['selected'] = [];
  const voucherParts: NonNullable<VoucherBreakdown['voucherParts']> = [];
  const warnings: string[] = [];
  let voucherTotalCents = 0;

  for (const assign of voucherAssigns) {
    const { voucher, plan } = ctx.planVouchers.get(assign.planId)!;
    // 券覆盖归属（v1.2 语义）：券方案所得子项 ↔ 该成员已解析心愿，匹配上的如实计入心愿覆盖；
    // 未匹配心愿的券内食品仍会分配给成员（strictCover = 全数分配给成员，不再要求声明承接），
    // 标注为「（券内品项）」，不虚增心愿满足率。
    const myCovered: Array<{ alias: string; wish: string; itemName: string }> = [];
    r3.memberAllocations.forEach((alloc, mi) => {
      const mine = alloc.items.filter((it) => it.fromPlanId === assign.planId);
      const myDemands = ctx.resolved.filter((rd) => rd.mi === mi);
      const used = new Set<string>();
      for (const it of mine) {
        for (let k = 0; k < it.qty; k++) {
          const rd = myDemands.find((d) => !used.has(d.demand.id)
            && (d.demand.category
              ? (d.demand.category === 'drink' ? /可乐|雪碧|果汁|冰茶|咖啡|奶|纯悦/.test(it.itemName) : true)
              : (d.hit && (d.hit.code === it.optionCode || d.hit.name === it.itemName || norm(d.hit.name).includes(norm(it.itemName)) || norm(it.itemName).includes(norm(d.hit.name))))));
          if (rd) { used.add(rd.demand.id); myCovered.push({ alias: alloc.alias, wish: rd.raw, itemName: it.itemName }); }
          else myCovered.push({ alias: alloc.alias, wish: '（券内品项）', itemName: it.itemName });
        }
      }
    });
    coveredWishes.push(...myCovered);

    // 逐券履约明细（数量/配置/补差/核销）
    const surchargeCents = assign.slotChoices.reduce((s, sc) => s + sc.diffCents * (sc.count ?? 1), 0);
    const subtotalCents = assign.qty * assign.basePriceCents + surchargeCents;

    // v1.4.8 R05：同配比价的对象是**本次实际购买的食品单元**（食品 + 规格 + 数量 + 券面补差），
    //   不再由「已覆盖心愿」反推：未写进心愿的券内食品（如脆汁鸡）会被漏算，
    //   而 `norm()` 删掉括号规格后中薯/小薯被当成同配（评审已复现：2310 券被拿去与 1490 单堡比较）。
    const equivUnits = voucherUnitsOf(assign, plan);
    const equiv = officialEquivalentCentsForUnits(equivUnits, ctx.skus);
    const inverted = equiv > 0 && subtotalCents >= equiv
      ? { officialEquivalentCents: equiv, deltaCents: subtotalCents - equiv } : undefined;
    selectedBreakdown.push({
      voucher, coveredWishes: myCovered,
      basis: voucher.source === 'user' ? 'user-claimed' : 'kb-reference',
      ...(inverted ? { inverted } : {}),
    });
    const warnText = inverted ? invertedWarningText(voucher.channelLabel, voucher.name, subtotalCents, equiv) : null;
    if (warnText) warnings.push(warnText);

    voucherTotalCents += subtotalCents;
    voucherParts.push({
      voucherId: voucher.id, name: voucher.name, channelLabel: voucher.channelLabel,
      qty: assign.qty, unitPriceCents: assign.basePriceCents, subtotalCents, surchargeCents,
      config: assign.slotChoices.map((sc) => ({ roundName: sc.roundName, chosenName: sc.chosenName, count: sc.count ?? 1 })),
      redeemPath: voucher.redeemPath,
    });
  }

  const seenTipIds = new Set(voucherAssigns.map((a) => ctx.planVouchers.get(a.planId)!.voucher.id));
  // v1.2：未购入的倒挂券同样亮红灯（避免「内核没买就没提醒」的静默区）——逐券做严格可承接 + 等效价比对
  for (const { voucher: other } of ctx.planVouchers.values()) {
    if (seenTipIds.has(other.id)) continue;
    seenTipIds.add(other.id);
    const plan = ctx.planVouchers.get(`kv-${other.id}`)!.plan;
    // v1.4.8 R05：未购买的任选券存在多种合法搭配，**不能**由其中一种搭配推导整券「切勿购买」，
    //   也不能让「调整选项顺序」改变结论。仅在券面配置唯一时给出整券结论；
    //   多种搭配的券留给「候选提示」（不虚构同配价）。
    const configCount = plan.slots.reduce((n, s) => n * Math.max(1, s.options.length), 1);
    if (configCount !== 1) continue;
    const otherUnits = plan.slots.flatMap((s) => s.options.map((o) => ({
      name: o.name,
      ...(o.specLabel ? { spec: o.specLabel } : {}),
      qty: 1,
      officialUnitPriceCents: o.priceCents,
    })));
    const otherEquiv = officialEquivalentCentsForUnits(otherUnits, ctx.skus);
    const text = invertedWarningText(other.channelLabel, other.name, other.priceCents, otherEquiv);
    if (text && !warnings.includes(text)) warnings.push(text);
  }
  const candidateTips: VoucherBreakdown['candidateTips'] = [...ctx.tips, ...PRESET_VOUCHERS]
    .filter((v) => !seenTipIds.has(v.id) && seenTipIds.add(v.id))
    .map((v) => ({
      voucher: v,
      reason: v.kind === 'cash'
        ? '支付立减贴士（金额随机/名额制，不参与比价）'
        : v.items.length === 0 || !v.items.some((x) => x.mode === 'fixed')
          ? '渠道参考价（券面明细未逐项核验，未纳入自动比价）'
          : '当前心愿组合下未入选（整单联合最优未选中该券）',
    }));

  // v1.4.6 R01：券价只含券面有依据的补差。官方渠道换选差价（如主食 −¥1）不得当作券的核销补差；
  //   实际是否补差以券页/门店为准，必须如实提示，不能静默按「免费换选」呈现。
  const voucherPlanById = new Map(voucherAssigns.map((a) => [a.planId, ctx.planVouchers.get(a.planId)?.plan]));
  const hasOfficialDiff = [...voucherPlanById.values()].some((p) => !!p && p.slots.some((sl) => sl.options.some((o) => !!o.officialDiffCents)));
  if (hasOfficialDiff) {
    warnings.push('券渠道的换选补差没有券面依据：官方 App 的换选差价（如部分主食 −¥1）未计入券价；核销时如需补差，以券页/门店为准。');
  }
  if (ctx.unionDegraded) warnings.push('美团联盟实时查询本次不可用，券池已降级为预置知识库（价格可能与实时有差异）。');
  else if (ctx.unionSolvableCount > 0) warnings.push(`美团联盟实时层 ${ctx.unionSolvableCount} 张在售团单已通过内容核验并进入自动比价（价格/内容来自官方接口与 MCP 数据，零录入）。`);
  warnings.push('券部分为知识库/您录入的参考价，未经理 MCP 核价；分账卡实付为估算口径，结算差异请以各平台订单为准。');
  const purchasedVouchers = selectedBreakdown.map((s) => s.voucher);
  if (purchasedVouchers.length > 0) {
    warnings.push('团购方案未校验具体适用门店，适用性以下单页为准（保留城市召回，不宣称全国通用）。');
  }
  if (purchasedVouchers.some((v) => v.constraints.noPoints)) warnings.push('用券核销部分不累积麦当劳会员积分（券面规则），积分价值未计入本对比。');
  for (const v of purchasedVouchers) {
    if (Date.now() - new Date(v.verifiedAt).getTime() > 14 * 24 * 3600 * 1000) warnings.push(`券「${v.name}」为 14 天前的核验价，购买时请以平台实时页为准。`);
    if (v.constraints.samePhoneBind) warnings.push(`券「${v.name}」需同手机号登录麦当劳 APP 绑定「到店券」后方可自助点餐核销。`);
  }
  if (input.members.some((m) => (m.personalCouponCents ?? 0) > 0)) {
    warnings.push('个人现金立减券仅冲减官方渠道部分应付；券面「不与其他优惠同享」，渠道券核销单不叠加官方优惠。');
  }
  for (const w of track3.warnings) if (!warnings.includes(w) && !/MILP/.test(w)) warnings.push(w);

  const track2Paid = ctx.track2PaidCents;
  const deltaCents = track2Paid - track3.totals.paidCents;
  const T = tieThresholdCents(track2Paid);
  const decision: TrackWinner = deltaCents >= 0 && deltaCents <= T ? 'tie-official' : deltaCents > T ? 'voucher' : 'official';

  // 官方部分 = 方案总价 − 全部券费用（遍历所有券购买记录；旧实现只扣第一种券 →
  // 第二种券金额被错误归到官方补单，重复购买同券时又漏计数量）。
  const officialPart = track3.totals.paidCents - voucherTotalCents;
  const voucherDesc = voucherParts
    .map((p) => `${p.channelLabel}「${p.name}」×${p.qty}（¥${(p.subtotalCents / 100).toFixed(1)}）`)
    .join(' + ');

  return {
    ...track3,
    trackNote: `轨道 3 · 全网合规券包（MILP 严格承接）：${voucherDesc} 覆盖 ${coveredWishes.length} 个心愿` +
      ` + 官方部分 ¥${(Math.max(0, officialPart) / 100).toFixed(1)}`,
    members: track3.members,
    orderNotes: track3.orderNotes,
    warnings,
    voucherBreakdown: {
      selected: selectedBreakdown,
      candidateTips,
      invertedWarnings: warnings.filter((w) => /无价格优势|切勿购买/.test(w)),
      voucherParts,
      residualSource: officialPart > 0 ? 'a-la-carte' : 'none',
      residualPaidCents: Math.max(0, officialPart),
      pointsNote: purchasedVouchers.some((v) => v.constraints.noPoints) ? '用券核销部分不累积麦当劳会员积分（券面规则）。' : '',
    },
    decision,
  };
}

/** 倒挂避坑提示卡（评审后补充）：内核会正确地拒绝购买倒挂券，但 PRD v1.3 拍板要求
 *  「触发团购倒挂时向用户亮红灯」——当池中存在「可严格承接 ≥2 心愿且不低于官方等效价」的券时，
 *  输出仅作提示的 voucherTrack（不改变任何购买建议，实付与官方最优轨一致）。 */
function buildInvertedAdvisory(
  officialBest: KernelGroupSolution,
  resolved: ResolvedDemand[],
  planMap: Map<string, { voucher: Voucher; plan: ComboPlan }>,
  skus: ComboSkuInfo[],
): (VoucherTrackSolution & KernelGroupSolution) | null {
  for (const { voucher } of planMap.values()) {
    // 严格可承接性：每个槽位都能被未占用的已解析心愿承接
    const used = new Set<string>();
    const coveredWishes: Array<{ alias: string; wish: string; itemName: string }> = [];
    const equivUnits: Array<{ name: string; spec?: string; qty: number; officialUnitPriceCents: number }> = [];
    let coverable = true;
    const plan = planMap.get(`kv-${voucher.id}`)!.plan;
    for (const slot of plan.slots) {
      let matched: ResolvedDemand | undefined;
      let matchedOpt: ComboPlan['slots'][number]['options'][number] | undefined;
      for (const opt of slot.options) {
        const rd = resolved.find((x) => !used.has(x.demand.id)
          && ((x.demand.code && opt.code) ? x.demand.code === opt.code
            : norm(opt.name).includes(norm(x.demand.keyword))));
        if (rd) { matched = rd; matchedOpt = opt; break; }
      }
      if (!matched || !matchedOpt) { coverable = false; break; }
      used.add(matched.demand.id);
      coveredWishes.push({ alias: matched.alias, wish: matched.raw, itemName: matchedOpt.name || slot.options[0].name });
      // v1.4.8 R05：同配价按**该券实际要买的食品**（含规格/份数/官方单点价）构造
      equivUnits.push({
        name: matchedOpt.name,
        ...(matchedOpt.specLabel ? { spec: matchedOpt.specLabel } : {}),
        qty: 1,
        officialUnitPriceCents: matchedOpt.priceCents,
      });
    }
    if (!coverable) continue;
    const equiv = officialEquivalentCentsForUnits(equivUnits, skus);
    if (!(equiv > 0 && voucher.priceCents >= equiv)) continue; // 未倒挂/无法同配核验 → 无需避坑卡
    const inverted = { officialEquivalentCents: equiv, deltaCents: voucher.priceCents - equiv };
    const warnText = invertedWarningText(voucher.channelLabel, voucher.name, voucher.priceCents, equiv);
    if (!warnText) continue;
    return {
      ...officialBest,
      track: 'voucher',
      trackNote: `轨道 3 · 倒挂避坑提示：${voucher.channelLabel}「${voucher.name}」未纳入购买方案（官方同配置更优/无优势，无需任何操作）`,
      warnings: [warnText, '本卡片为比价避坑提示：统一内核已自动放弃该倒挂券，推荐方案不受影响。'],
      voucherBreakdown: {
        selected: [{ voucher, coveredWishes, basis: voucher.source === 'user' ? 'user-claimed' as const : 'kb-reference' as const, inverted }],
        candidateTips: [],
        invertedWarnings: [warnText],
        voucherParts: [{
          voucherId: voucher.id, name: voucher.name, channelLabel: voucher.channelLabel,
          qty: 0, unitPriceCents: voucher.priceCents, subtotalCents: 0, surchargeCents: 0,
          config: coveredWishes.map((cw) => ({ roundName: '券内品项', chosenName: cw.itemName, count: 1 })),
          redeemPath: voucher.redeemPath,
        }],
        residualSource: 'a-la-carte',
        residualPaidCents: officialBest.totals.paidCents,
        pointsNote: '',
      },
      decision: 'official' as TrackWinner,
      coverage: officialBest.coverage,
      solveState: officialBest.solveState,
      kernel: officialBest.kernel,
      basket: officialBest.basket,
    };
  }
  return null;
}

// ---------- 主入口 ----------

const EMPTY_MENU: MenuLoadResult = { items: [], unmatched: 0, comboCount: 0, comboUnmatched: 0, table: new Map() };

export async function solveGroupWithKernel(
  client: McpClient,
  input: GroupOrderInput & { userVouchers?: Voucher[] },
  hooks: { onStage?: (stage: string, note?: string) => void; assertLive?: () => void } = {},
): Promise<GroupKernelResult> {
  const storeCode = input.storeCode;
  // v1.2 渠道解耦：官方菜单失败不再终止整单——先抓美团查询结果（不依赖官方菜单），再按快照/降级分支处理
  hooks.onStage?.('准备菜单', '查询门店实时菜单与营养表');
  hooks.assertLive?.();
  let menu: MenuLoadResult;
  let menuError: string | null = null;
  try {
    menu = await loadMenuItems(client, storeCode, { includeUnmatched: true });
  } catch (e) {
    menu = EMPTY_MENU;
    menuError = e instanceof Error ? e.message : String(e);
  }

  // ---- 降级分支：无实时菜单且无快照 → 回执成员需求 + 美团团单列表（官方方案无从构建）----
  if (menuError !== null) {
    const recall = await recallVouchers(client, input, EMPTY_MENU, input.userVouchers ?? []).catch(() => null);
    const members: GroupMemberResult[] = input.members.map((m) => ({
      alias: m.alias,
      items: [],
      originalCents: 0, shareCents: 0, payableCents: 0, savedCents: 0,
      personalCouponCents: m.personalCouponCents,
      kcal: 0,
      unresolvedWishes: [...m.wishes],
      tabooFiltered: [],
      ...(m.notes?.length ? { note: m.notes.join('；') } : {}),
    }));
    const wishTotal = input.members.reduce((s, m) => s + m.wishes.length, 0);
    const warnings = [
      `官方菜单暂不可用：${menuError}`,
      '本轮未产生购买方案（官方方案无法构建，券内容需对照官方菜单核验）；已保留你的成员需求与美团查询结果，可稍后重试或更换门店。',
      '美团团单仅展示查询结果（可查询 ≠ 可购买 ≠ 可核销），购买与核销以各平台页面为准。',
    ];
    if (recall?.diagnostics.union.deals?.length) {
      warnings.push(`美团查询到 ${recall.diagnostics.union.deals.length} 条在售团单（详见渠道诊断）。`);
    }
    const solution: KernelGroupSolution = {
      store: { storeCode, storeName: input.storeName ?? `门店 ${storeCode}` },
      track: 'bundle',
      trackNote: '官方菜单不可用 · 需求回执（非配餐方案）',
      members,
      orderNotes: input.members.filter((m) => m.notes?.length).map((m) => `${m.alias}：${m.notes!.join('；')}`),
      totals: { originalCents: 0, paidCents: 0, discountCents: 0, priceSource: 'menu-price', priceNote: '未产生购买方案' },
      deliveryFeeCents: 0,
      warnings,
      disclaimer: '本轮为官方菜单不可用时的需求回执与渠道查询结果，不构成任何购买建议。',
      coverage: { total: wishTotal, met: 0 },
      solveState: 'infeasible',
      kernel: 'milp-v6',
      basket: [],
      gapTotal: 0,
      alternatives: [],
    };
    return {
      solution,
      bundle: null, voucherTrack: null, decision: null,
      unified: [solution], recommendedIndex: 0,
      channelDiagnostics: recall?.diagnostics ?? {
        union: { queried: 0, admitted: 0, tips: 0, degraded: true, dbUsed: false, dbCount: 0, source: 'none', unavailableReason: menuError.slice(0, 120) },
        preset: { considered: 0, admitted: 0 },
        user: { considered: 0, admitted: 0 },
        voucherPlanRules: { perVoucherMaxQty: '单券可买份数 = 券面限购（搜索上限 4 份）', externalOrderLimit: '整单外部券 ≤ 3 张（程序搜索上限，非平台规则）' },
        excluded: [],
      },
      menuUnavailable: { reason: menuError },
    };
  }

  // S1 心愿 → 需求单位
  const { resolved, unmatched, unresolvedByMember, tabooByMember, matchWarnings } = resolveDemands(input.members, menu);
  if (menu.fromSnapshotAt) {
    matchWarnings.unshift(`当前门店数据源未返回实时菜单，已使用 ${(menu.fromSnapshotAt ?? '').slice(0, 10)} 的菜单快照（${menu.snapshotPoolNote ?? '价格为最后观测参考价'}）。`);
  }
  const reqs = memberReqsOf(input.members, resolved, unmatched);
  const demandTotal = reqs.reduce((s, m) => s + (m.demands?.length ?? 0), 0);
  if (demandTotal === 0) {
    throw new Error('所有成员的心愿都未能匹配到当前门店菜单品项，请检查心愿关键词或更换门店。');
  }

  // S2 池构建（嵌套）+ 券白名单方案
  hooks.onStage?.('解析团购', '查询当地美团团单并逐项核验券面内容');
  hooks.assertLive?.();
  const skus = await loadComboSkus(client, storeCode, menu).catch(() => [] as ComboSkuInfo[]);
  const built = buildPlansFromMenuItems(menu.items, { includeSingle: true, table: menu.table, specRequests: specRequestsOf(resolved) });
  const augmented = augmentComboPlans(built.comboPlans, skus, menu);
  const comboPlans = augmented.plans;
  if (augmented.skipped.length > 0) {
    // R15：官方 SKU 缺轮次时如实说明「该套餐未入池」，不静默缩成两件餐
    matchWarnings.push(`官方套餐完整性：${augmented.skipped.map((s) => `${s.name}（${s.reason}）`).join('；')}`);
  }
  const singlePlans = built.singlePlans;
  const recall = await recallVouchers(client, input, menu, input.userVouchers ?? []);
  const voucherPlans = [...recall.plans.values()].map((x) => x.plan);
  // v1.4.10 W02：计划 id → 真实履约编码（规格型单品 = 父 SKU + 规格轮次）
  const planById = new Map<string, ComboPlan>();
  for (const p of [...singlePlans, ...comboPlans, ...voucherPlans]) planById.set(p.id, p);

  // S3 三轨求解（Top-K per track；软需求缺口字典序在 optimize 内完成）
  hooks.onStage?.('优化组合', `MILP 三轨求解（单品 ${singlePlans.length} / 套餐 ${comboPlans.length} / 券方案 ${voucherPlans.length}）`);
  hooks.assertLive?.();
  const [t1, t2, t3] = await Promise.all([
    runTrack(singlePlans, reqs),
    runTrack([...singlePlans, ...comboPlans], reqs),
    runTrack([...singlePlans, ...comboPlans, ...voucherPlans], reqs),
  ]);
  if (!t1 && !t2 && !t3) throw new Error('拼单求解无可行方案：硬约束（预算/恰好/必须需求/成员上限）在当前门店菜单与券池下均无解，请调整后重试。');
  dbg('三轨:', [t1, t2, t3].map((t) => (t ? `${t.results[0].status}/${t.results[0].totals.priceCents}/cov${t.results[0].coverage.met}/alt${t.results.length - 1}` : 'null')).join(' | '));

  // S5+S6 各轨核价与契约映射（核价权威：quote 有效即为准，评审二轮 #7；Top-K 备选随轨输出）
  // v1.3 性能轮：同一请求内相同购物篮复用报价（实测三轨同篮重复核价占等待时间的主要部分之一）
  hooks.onStage?.('核验价格', '官方计价接口核验各候选购物篮');
  hooks.assertLive?.();
  const quoteMemo = new Map<string, { priceCents: number; discountCents: number } | null>();
  const mkCtx = (t: TrackRun) => ({
    resolved, unresolvedByMember, tabooByMember, matchWarnings,
    unmatchedIds: new Set(unmatched.map((u) => u.demand.id)),
    quote: null as null | { useQuote: boolean; discountCents: number; priceCents: number },
    voucherPartCents: 0,
    planVouchers: recall.plans,
    planById,
    unionDegraded: recall.unionDegraded,
    unionSolvableCount: recall.unionSolvableCount,
  });

  const buildTrack = async (track: GroupSolution['track'], run: TrackRun | null, fallback?: KernelGroupSolution): Promise<KernelGroupSolution | null> => {
    if (!run) return fallback ?? null;
    const primary = run.results[0];
    const basket = officialBasketOf(primary, planById);
    const officialModel = assignmentsPriceOf(primary, (_p, ch) => ch === 'mcd-mcp');
    const voucherPart = assignmentsPriceOf(primary, (p, ch) => ch !== 'mcd-mcp' && recall.plans.has(p));
    const q = await quoteWithRounds(client, storeCode, basket, quoteMemo);
    const useQuote = !!q && q.priceCents > 0;
    const ctx = { ...mkCtx(run), quote: q ? { useQuote, discountCents: q.discountCents, priceCents: q.priceCents } : null, voucherPartCents: voucherPart };
    const sol = toGroupSolution(track, input, primary, ctx);
    // 同轨 Top-K 备选（仅模型价口径，不再逐一核价；渠道轨 ≠ 方案）
    sol.alternatives = run.results.slice(1).map((r) => toGroupSolution(track, input, r, { ...ctx, quote: null }));
    if (run.truncated) sol.warnings.push('备选搜索达到迭代预算：已展示的是已找到的最优解，可能仍有未列出的不同组合（并非只有这些组合）。');
    return sol;
  };

  const solutionTrack = await buildTrack('a-la-carte', t1);
  const bundleTrack = await buildTrack('bundle', t2, solutionTrack ?? undefined);
  // v1.4.8 R03：官方最优、券比价基准与最终推荐**共用同一个比较器**。
  //   旧实现 unified 按「未满足数 → 实付」排序，而 officialBest / 推荐索引只比 paidCents：
  //   评审夹具里 5800 分、覆盖 2/2 的完整套餐方案排第 0，推荐却指向 2350 分、覆盖 1/2 的残缺单点。
  const rankCmp = (a: KernelGroupSolution, b: KernelGroupSolution): number =>
    CONFIG.groupRankStrategy === 'cost-first'
      ? (a.totals.paidCents - b.totals.paidCents) || (a.gapTotal - b.gapTotal)
      : (a.gapTotal - b.gapTotal) || (a.totals.paidCents - b.totals.paidCents);
  const betterOfficial = (a: KernelGroupSolution, b: KernelGroupSolution): KernelGroupSolution => (rankCmp(a, b) <= 0 ? a : b);
  const officialBestOf = (): KernelGroupSolution => (bundle ? betterOfficial(bundle, solution) : solution);
  // v1.4.4 R09：整体失败必须依据**全部可用轨道**，不得因单点轨无解就误报「官方两轨均无可行方案」。
  //   反例：心愿「恰好三份巨无霸」而单品限购 2 份，但套餐可提供同一 SKU → t1=null、t2 可行，
  //   旧实现仍抛错（套餐池独立求解本可 proven-optimal）。现以可行套餐轨作为主方案，
  //   track 如实标注为 bundle（不伪装成单点轨）。
  // v1.4.6 R05：官方两轨都无解但券轨可行时，返回券方案（旧实现直接抛「无解」）。
  const officialFeasible = !!(solutionTrack || bundleTrack);
  let solution: KernelGroupSolution;
  if (officialFeasible) {
    solution = solutionTrack ?? bundleTrack!;
  } else {
    const voucherOnly = await buildTrack('voucher', t3);
    if (!voucherOnly) throw new Error('拼单求解失败：官方两轨与券轨均无可行方案。');
    voucherOnly.trackNote = `仅券渠道可行 · ${voucherOnly.trackNote}`;
    voucherOnly.warnings.push('官方渠道（单点/套餐）在当前约束下无可行方案；本方案完全依赖渠道券履约，官方部分为空。');
    solution = voucherOnly;
  }
  const bundle: KernelGroupSolution | null = bundleTrack;

  // 轨 3：券履约明细 + 决策
  let voucherTrack: (VoucherTrackSolution & KernelGroupSolution) | null = null;
  let decision: ReturnType<typeof decideTrackWinner> = null;
  if (t3) {
    // v1.4.6 R14：第三轨的**每个** Top-K 结果各自核价、各自构建券费用/购买清单/分账，再进入统一去重排序。
    //   旧实现只映射 results[0]：Top-K 里「9 元 A」「9.5 元 A＋B」的第二项在输出阶段被丢弃，
    //   而更贵的官方 15 元 A＋B 反而保留。
    const t3sols: Array<VoucherTrackSolution & KernelGroupSolution> = [];
    for (const r of t3.results) {
      const officialModel = assignmentsPriceOf(r, (_p, ch) => ch === 'mcd-mcp');
      const voucherPart = assignmentsPriceOf(r, (p, ch) => ch !== 'mcd-mcp' && recall.plans.has(p));
      const basket = officialBasketOf(r, planById);
      const q = await quoteWithRounds(client, storeCode, basket, quoteMemo);
      const useQuote = !!q && q.priceCents > 0;
      const ctx = { ...mkCtx(t3), quote: q ? { useQuote, discountCents: q.discountCents, priceCents: q.priceCents } : null, voucherPartCents: voucherPart };
      const sol = toGroupSolution('voucher', input, r, ctx);
      const officialBestFor = officialBestOf();
      const vt = buildVoucherTrack(sol, r, input, {
        resolved, planVouchers: recall.plans, tips: recall.tips, skus,
        unionDegraded: recall.unionDegraded, unionSolvableCount: recall.unionSolvableCount,
        officialPaidCents: officialModel, track2PaidCents: officialBestFor.totals.paidCents,
      });
      if (vt) t3sols.push(vt);
    }
    voucherTrack = t3sols[0] ?? null;
    if (voucherTrack && t3sols.length > 1) voucherTrack.alternatives = t3sols.slice(1);
    // v1.4.9（R04 边界）：把「多份同款券未作独立承接」的口径如实写进券轨警告，
    //   不让用户以为系统漏掉了这张券。
    if (voucherTrack && recall.sameComboNotes.length > 0) {
      voucherTrack.warnings = [...(voucherTrack.warnings ?? []), ...recall.sameComboNotes];
    }
    const officialBest = officialBestOf();
    if (voucherTrack) {
      if (!officialFeasible) {
        // 没有官方可行方案时不存在「与官方比价」，不给出 winner 结论（避免自比自的伪结论）
        decision = null;
        voucherTrack.warnings.push('官方渠道本次无可行方案，以下为券渠道内部比较，不与官方价格比较。');
        solution = voucherTrack; // 主方案与券履约明细同源（避免统一候选里出现两份同内容方案）
      } else if (voucherTrack.coverage.met < officialBest.coverage.met) {
        // 覆盖感知决策：价格比较仅在覆盖可比时生效；覆盖不足的轨 3 标注不推荐
        voucherTrack.warnings.push('⚠️ 券包轨道覆盖的心愿少于官方轨道，价格不具备直接可比性，以下仅供参考。');
        decision = null;
      } else {
        decision = decideTrackWinner(officialBest, voucherTrack);
      }
    } else if (officialFeasible) {
      // 未购买任何券：池中存在倒挂券时输出避坑提示卡（PRD 拍板 UX，不改变推荐）
      const advisory = buildInvertedAdvisory(officialBest, resolved, recall.plans, skus);
      if (advisory) {
        voucherTrack = advisory;
        decision = {
          winner: 'official',
          label: '官方渠道方案（券倒挂避坑）',
          reason: `券「${advisory.voucherBreakdown.selected[0].voucher.name}」反超官方等效价，存在团购倒挂/伪优惠，详见避坑警告`,
          deltaCents: -(advisory.voucherBreakdown.selected[0].inverted?.deltaCents ?? 0),
          thresholdCents: tieThresholdCents(officialBest.totals.paidCents),
        };
      }
    }
  }

  // 排序策略（可调配置）：coverage-first = 内核默认（未满足数 → 实付价）；cost-first = 实付价优先
  hooks.onStage?.('生成方案', '组装购买清单、分账与渠道诊断');
  const cmp = CONFIG.groupRankStrategy === 'cost-first' ? rankCmp : undefined;
  const unified = unifyCandidates([solution, ...(bundle ? [bundle] : []), ...(voucherTrack ? [voucherTrack] : [])], cmp);
  // v1.4.6 R16：唯一推荐决定。旧实现页面用 unified[0] 标「推荐」、决策用 decideTrackWinner，
  //   夹具中券 9.5 元 / 官方 10 元、decision=tie-official 时，CLI 把券标成推荐 —— 两处同名结论相反。
  //   现在由决策派生唯一推荐索引，页面 / CLI / 分账共用；「最便宜」仍单独标注。
  // v1.4.8 R03：候选可能已被同内容去重合并（keep 不是同一个对象），按食物内容签名定位，避免回落 0 号。
  let recommendedIndex = 0;
  if (officialFeasible) {
    const chosen = decision?.winner === 'voucher' && voucherTrack ? voucherTrack : officialBestOf();
    recommendedIndex = indexOfCandidate(unified, chosen);
  }
  // v1.4.9 N01：逐商品遗漏账——「官方返回 → 结构取得 → 营养可用 → 候选方案 → 实际选中」，
  //   供高级数据管理核对「为什么这个商品没进方案」，消费者页不展示。
  const chosenSol = unified[recommendedIndex];
  // v1.4.10 W09：遗漏账的「已入池」必须取**真实建池记录**，不能用最终 Top-5 篮子反推——
  //   旧实现从 unified 取 code，已建池但本轮未进 Top-K 的商品会被误写成「未进入候选计划」。
  const builtCodes = new Set<string>();
  for (const p of [...singlePlans, ...comboPlans, ...voucherPlans]) {
    if (p.id.startsWith('mcd-spec-')) builtCodes.add(p.id.slice('mcd-spec-'.length).split('-')[0]);
    else if (p.id.startsWith('mcd-s-')) builtCodes.add(p.id.slice(6));
    else if (p.id.startsWith('mcd-')) builtCodes.add(p.id.slice(4));
  }
  const menuAudit = buildMenuAudit(menu.items, {
    planCodes: builtCodes,
    selectedCodes: new Set((chosenSol?.basket ?? []).map((b) => b.code)),
  });
  return {
    solution, bundle, voucherTrack, decision, unified, recommendedIndex,
    channelDiagnostics: recall.diagnostics,
    menuAudit,
  };
}
