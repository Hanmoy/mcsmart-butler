// 团购券面内容逐项核验层（v1.3，评审「逐项核验真正做出来」拍板）：
//   数据流：团购商品 → 获取券详情 → 提取食品/规格/数量/选配规则 → 映射官方食品库 → 校验适用条件 → 进入求解。
//   官方库（MCP query-meals / query-meal-detail）负责确认食品身份与营养；
//   券详情负责证明这张券究竟包含什么。
//
// 证据来源分层（2026-10-14 真实联网调查结论，docs/CPS_DETAIL_INVESTIGATION_v13.md）：
//   S1 券名结构化模式（官方产品规则即券面）——「随心配 1+1」：红区主食 1 + 白区任选 1。
//      该券型的券面内容=产品名本身，模式即构成（任选范围由官方 SKU 真实轮次承接，零猜测）。
//   S2 官方菜单同名套餐核验——券名与当前门店官方菜单某套餐「归一化全名一致」→
//      query-meal-detail 取整包构成：各轮次【任选范围 + 默认项 + 差价】原样保留
//      （combo-ref 建模：固定槽与任选槽分别建模，不再只取官方默认搭配）。
//   S2b 官方菜单同名单品核验（v1.4.1）——券名（剥修饰/数量词后）与官方单品归一化全名一致 →
//      构成 = 该单品 × 数量（「麦旋风买一送一」=2×麦旋风）；「三件套/拼/任选」类多品打包绝不据此推断。
//   S3 联盟层券面明细——结构性不可得（已实测）：query_coupon 列表/精确查询（productViewSignList）
//      与 skuExtInfoDTO 均无食品清单；specification 字段仅支持医药业务（餐饮团单 20/20 null，v1.4.1 复核）；
//      get_referral_link H5 落地页为 App 壳（无 SSR 构成数据）；
//      App 内交易供给按项目红线不做逆向。→ 未核验项如实给出具体原因 + 券面主图（headUrl）人工可查。
// 缓存：核验结果随团单 upsert 持久化（catalog CatalogDeal.verify），同名券不重复核验、
//   保存时不再按券名白名单重新判断（旧实现会在保存时丢失已确认的组成与准入状态）。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLayout } from './paths.js';
import type { McpClient } from './mcp.js';
import type { MenuLoadResult } from './menu.js';
import { withOrderParams } from './orderContext.js';
import type { UnionDeal } from './unionClient.js';
import { CHOICE_CATEGORIES, type VoucherItemRef } from './vouchers.js';
import { matchRecipeCandidates, type VoucherRecipe } from './voucherRecipes.js';
import { resolveFixedVoucherFood } from './voucherFoods.js';

// ---------- 城市字典（美团联盟 cityId；官方 xlsx 预解析为 JSON 随包分发） ----------

let cityDictCache: Record<string, string> | null = null;

/** 城市名 → 美团联盟 cityId（「上海」「上海市」均可命中；查无返回 undefined） */
export function meituanCityId(city: string | undefined): string | undefined {
  const name = (city ?? '').trim();
  if (!name) return undefined;
  if (!cityDictCache) {
    try {
      const p = join(getLayout().seedDataDir, 'meituan-city-dict.json');
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf-8')) as { cities?: Record<string, string> };
        cityDictCache = raw.cities ?? {};
      }
    } catch { cityDictCache = {}; }
    cityDictCache ??= {};
  }
  return cityDictCache[name]
    ?? cityDictCache[`${name}市`]
    ?? Object.entries(cityDictCache).find(([k]) => name.length >= 2 && (k.startsWith(name) || name.startsWith(k.replace(/市$/, ''))))?.[1];
}

// ---------- 核验记录 ----------

export type DealVerifySource = 'recipe' | 'name-pattern' | 'official-menu';
export type DealVerifyStatus = 'pattern-verified' | 'menu-verified' | 'unverified';

/** 未核验原因细分（不归成一句「明细未核验」——每类原因对应不同的用户行动） */
export type DealUnverifiedReasonCode =
  | 'detail-unavailable'      // 详情未取得：联盟接口未提供券面构成（含详情页为 App 壳）
  | 'spec-unmappable'         // 规格无法匹配：券面品项无法映射到当前门店官方菜单/食品库
  | 'choice-range-unclear'    // 任选范围不明确：券面声明任选但可选集合无法从官方数据确认
  | 'name-mismatch';          // 券名与官方菜单无同名套餐（S2 无证据；亦无 S1 模式）

export interface DealVerifyRecord {
  status: DealVerifyStatus;
  /** 核验通过的构成（进入求解）；未核验时缺省 */
  contents?: VoucherItemRef[];
  /** S2 来源时的官方套餐 code（证据链） */
  comboCode?: string;
  /** v1.4：绑定的实际产品 code（combo-name 解析结果 / 随心配 SKU）——求解按此定位，不再按轮次数猜 */
  boundComboCode?: string;
  /** v1.4：绑定的官方轮次 id（顺序对齐券条目；用于稳定复现可选范围） */
  boundRoundIds?: string[];
  /** v1.4：规则版本（配方/核验规则版本；缓存与复用按版本判定） */
  ruleVersion?: string;
  /** v1.4：命中的配方 id（可审计） */
  recipeId?: string;
  /** 未核验时的具体原因 */
  reasonCode?: DealUnverifiedReasonCode;
  reason?: string;
  source?: DealVerifySource;
  verifiedAt: string;
  /** 券面主图（美团官方素材，人工核对券面的直接证据；本项目不 OCR 不据此宣称已解析） */
  headUrl?: string;
  /** v1.4：本次查询失败（不覆盖既有成功核验；仅在缓存层记录） */
  queryFailedAt?: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

// ---------- S1：券名结构化模式 ----------

/** 「随心配 1+1」等官方产品规则型券名 → 构成（模式即券面，任选范围由官方 SKU 轮次承接） */
export function parseDealPattern(name: string): VoucherItemRef[] | null {
  const n = name.replace(/\s+/g, '');
  if (/随心配1\+1/.test(n)) {
    return [
      { mode: 'choice', keyword: 'staple', qty: 1 },
      { mode: 'choice', keyword: 'white', qty: 1 },
    ];
  }
  // 「任选 N 件」「自由拼」类：券面仅声明数量、未给出可选集合——范围不明确，不做模式化（严禁猜测品类范围）
  return null;
}

function patternRangeKnown(refs: VoucherItemRef[]): boolean {
  return refs.every((r) => r.mode !== 'choice' || ['staple', 'white', 'side', 'drink', 'dessert'].includes(r.keyword));
}

// ---------- S2：官方菜单同名套餐核验 ----------

function normName(s: string): string {
  return s.replace(/[（(【\[].*?[)）】\]]/g, '').replace(/\s+/g, '').toLowerCase();
}

/** 规格短语归一（「中份」/「中杯」→「中」；「2块」→「2」）——用于「同规格简称」判定 */
function normSpecToken(s: string | undefined): string {
  return normName(s ?? '').replace(/[份杯个块条只支\-—_·+]/g, '');
}

// ---------- S2b：官方菜单同名单品核验（v1.4.1，全部团购入池轮） ----------
//
// 联盟列表里相当一部分团单的券名就是官方单品名（「那么大鸡排」「冰淇淋玉米杯」），
// 或为「数量词 + 官方单品名」（「麦旋风买一送一」「两个麦旋风」「圆筒四重奏」）。
// 这类券的构成有官方证据：券名（剥修饰/数量词后）与官方菜单单品归一化全名一致 →
// 构成 = 该单品 × 数量，与 S2 同一采信标准（归一化全名一致，零猜测）。
// 「三件套/组合/拼/任选」类是**多品打包**，数量词只修饰整体、不修饰单品——绝不据此推断构成。

/** 券面数量词 → 数量（券面声明的直译；只收录「同名单品 ×N」语义安全的词） */
const DEAL_QTY_WORDS: Array<[RegExp, number]> = [
  [/买一送一|第二个半价|第二份半价|双份|两个|两份/, 2],
  [/四重奏/, 4],
];

/** 多品打包/任选标记：出现即不做单品核验（构成无法从券名+官方单品确认） */
const RE_MULTI_PACK = /套餐|组合|件套|拼|任选|自由拼|搭配|随心配/;

/** 券名归一化身份（剥【】营销装饰与空白、小写）——商品身份比对用 */
export function dealIdentityKey(name: string): string {
  return normName((name ?? '').replace(/\s+/g, ''));
}

/**
 * 券面规格规则签名（v1.4.2）：由「归一化身份 + 数量语义 + 打包/任选标记」组成。
 * 缓存继承前比对：仅营销装饰变化可复用旧组成；数量语义或打包语义变化（如新增「买一送一」）
 * 不得复用旧组成——旧组成的件数与当前券面规则不再一致。
 */
export function dealSpecSignature(name: string): string {
  const decorated = (name ?? '').replace(/\s+/g, '');
  let qty = 1;
  for (const [re, n] of DEAL_QTY_WORDS) if (re.test(decorated)) qty = Math.max(qty, n);
  const multi = RE_MULTI_PACK.test(decorated) ? 'multi' : 'single';
  return `${normName(decorated)}|${multi}|q${qty}`;
}

/**
 * S2b 官方菜单同名单品核验（v1.4.2 修正方括号内数量丢失）：
 *   1) 先在**整条券名**（标题前 / 标题后 /【】内位置一致）识别明确数量语义；
 *      不同数量语义并存（如「买一送一」+「四重奏」）→ 冲突、无法确定 → 不自动核验；
 *   2) 出现打包/任选标记（含【】内）→ 多品打包，绝不单品化；
 *   3) **再**剥纯营销修饰（【】整段 + 已识别的数量词）得到身份候选，与官方单品归一化全名一致才采信。
 * 顺序修正要点：先提数量、后剥修饰——被删掉的【】内容可能就是构成规则，不是装饰标签。
 */
export function verifyByOfficialSingle(dealName: string, menu: MenuLoadResult): DealVerifyRecord | null {
  const decorated = dealName.replace(/\s+/g, '');
  if (!decorated || menu.items.length === 0) return null;

  // 1) 全券名（含【】内）识别明确数量语义；不同值并存 = 冲突规则 → 保留待确认
  let qtyText = decorated;
  const matched: number[] = [];
  for (const [re, n] of DEAL_QTY_WORDS) {
    const g = new RegExp(re.source, 'g');
    if (g.test(qtyText)) { matched.push(n); qtyText = qtyText.replace(g, ''); }
  }
  const distinct = [...new Set(matched)];
  if (distinct.length > 1) return null;          // 数量语义冲突 → 不自动核验
  const qty = distinct.length === 1 ? distinct[0] : 1;

  // 2) 打包/任选标记（含【】内）→ 构成无法从券名 + 官方单品确认
  if (RE_MULTI_PACK.test(decorated)) return null;

  // 3) 剥纯营销修饰（【】整段 + 已识别数量词）→ 身份候选
  const base = qtyText.replace(/[【\[][^】\]]*[】\]]/g, '');
  if (!base || RE_MULTI_PACK.test(base)) return null;
  const target = normName(base);
  if (target.length < 2) return null;
  // 归一化全名一致才采信（与 S2 同一证据标准；包含式匹配不采信）
  const item = menu.items.find((i) => !i.isCombo && normName(i.name) === target);
  if (!item) return null;
  return {
    status: 'menu-verified',
    contents: [{ mode: 'fixed', keyword: item.name, qty, fulfillCode: item.code }],
    comboCode: item.code,
    ruleVersion: 'single-name-v1',
    source: 'official-menu',
    verifiedAt: today(),
  };
}

/**
 * 券名 ↔ 官方菜单同名套餐：归一化全名一致才采信（包含式匹配不采信，不通过猜测扩大准入）。
 * 命中后 query-meal-detail 取整包构成 → combo-ref 整包引用（保留任选范围）。
 */
export async function verifyByOfficialMenu(
  client: McpClient,
  storeCode: string,
  dealName: string,
  menu: MenuLoadResult,
): Promise<DealVerifyRecord | null> {
  const target = normName(dealName);
  if (target.length < 4) return null;
  const combo = menu.items.find((i) => i.isCombo && normName(i.name) === target);
  if (!combo) return null;
  try {
    // v1.4.9 N01：券面同名核验同样按目标用餐时间取官方构成
    const res = await client.call('query-meal-detail', withOrderParams({ code: combo.code, storeCode, orderType: 1, beType: 1 }));
    const rounds = (res.data as { rounds?: Array<{ id?: number; choices?: Array<{ name?: string; isDefault?: number }> }> })?.rounds ?? [];
    const hasChoices = rounds.some((r) => (r.choices ?? []).filter((x) => x.name).length > 0);
    if (rounds.length === 0 || !hasChoices) {
      return { status: 'unverified', reasonCode: 'spec-unmappable', reason: `券名与官方套餐「${combo.name}」同名，但官方未返回该套餐的构成明细（规格无法匹配）`, verifiedAt: today() };
    }
    const contents: VoucherItemRef[] = [{ mode: 'combo-ref', keyword: combo.code, qty: 1, comboName: combo.name }];
    return {
      status: 'menu-verified', contents, comboCode: combo.code,
      boundComboCode: combo.code,
      boundRoundIds: rounds.map((r) => String(r.id ?? '')).filter(Boolean),
      ruleVersion: 'combo-name-v1',
      source: 'official-menu', verifiedAt: today(),
    };
  } catch {
    return { status: 'unverified', reasonCode: 'detail-unavailable', reason: `券名与官方套餐「${combo.name}」同名，但构成详情查询本次失败（详情未取得）`, verifiedAt: today() };
  }
}

// ---------- S0：券配方库（人工核验一次、长期复用） ----------

/**
 * 配方核验（v1.4）：团单名命中配方 → 直接用配方组成。
 *   - combo-name 配方：按官方同名套餐解析出真实 code + 轮次 id（构成来自官方，非猜测）；
 *     门店无同名套餐 → 保持未核验（不猜测组成）；
 *   - pattern 配方（随心配）：组成即产品规则；绑定 SKU 由求解层按品类确定性选择；
 *   - explicit 配方：直接采用录入的组成（用户/导入的核验结果）。
 */
export async function verifyByRecipe(
  client: McpClient,
  storeCode: string,
  dealName: string,
  menu: MenuLoadResult,
  recipe: VoucherRecipe,
): Promise<DealVerifyRecord> {
  if (recipe.resolve === 'combo-name') {
    const viaMenu = await verifyByOfficialMenu(client, storeCode, recipe.name, menu);
    if (viaMenu && viaMenu.status === 'menu-verified') {
      return { ...viaMenu, source: 'recipe', recipeId: recipe.id, ruleVersion: recipe.ruleVersion };
    }
    // v1.4.3 修正：官方同名套餐**存在于菜单**但构成详情未取得（或详情查询失败）时，
    //   沿用其具体原因（spec-unmappable / detail-unavailable），不得笼统归为「门店无同名套餐」——
    //   后者会把「接口没给构成」误报成「门店没有这个套餐」，误导用户。
    if (viaMenu) return { ...viaMenu, recipeId: recipe.id, ruleVersion: recipe.ruleVersion };
    // 当前门店确实没有同名官方套餐：配方存在但本店无法解析 → 如实标注未核验（不猜测）
    return {
      status: 'unverified', reasonCode: 'name-mismatch', recipeId: recipe.id, ruleVersion: recipe.ruleVersion,
      reason: `券配方「${recipe.name}」为官方同名套餐型，但当前门店官方菜单无同名套餐（无法解析组成）`,
      verifiedAt: today(),
    };
  }
  // 显式券面配方项映射到当前门店菜单；fixed 不做模糊包含匹配，choice 只允许官方绑定轮次。
  const itemRef = (it: VoucherRecipe['items'][number]): VoucherItemRef => ({
    mode: it.mode, keyword: it.keyword, qty: it.qty,
    ...(it.comboName ? { comboName: it.comboName } : {}),
    ...(it.spec ? { spec: it.spec } : {}),
    ...(it.choiceRange ? { choiceRange: it.choiceRange } : {}),
    ...(it.surcharge ? { surcharge: it.surcharge } : {}),
    ...(it.optionDiffs ? { optionDiffs: { ...it.optionDiffs } } : {}),
    ...(it.fulfillCode ? { fulfillCode: it.fulfillCode } : {}),
  });
  const boundCombo = recipe.binding?.comboCode
    ? menu.items.find((x) => x.isCombo && x.code === recipe.binding?.comboCode)
    : undefined;
  const boundRoundsExist = !!recipe.binding?.roundIds?.length && recipe.binding.roundIds.every((id) =>
    boundCombo?.deconstruction?.some((r) => r.roundId === id) || menu.items.some((x) => x.deconstruction?.some((r) => r.roundId === id)),
  );
  if (recipe.resolve === 'pattern' && recipe.items.some((it) => it.mode === 'choice')) {
    // 仅当任选项用的是**官方品类 key**（staple/white/side/drink/dessert，内核按官方轮次确定性对齐）时，
    // 才无需绑定；自定义任选项（无官方品类语义）必须绑定官方 SKU/轮次，否则拒绝自动准入。
    const allOfficialKeys = recipe.items
      .filter((it) => it.mode === 'choice')
      .every((it) => CHOICE_CATEGORIES.some((c) => c.key === it.keyword));
    const bindingUsable = !!boundCombo || boundRoundsExist;
    if (!allOfficialKeys && !bindingUsable) return {
      status: 'unverified', reasonCode: 'choice-range-unclear', recipeId: recipe.id, ruleVersion: recipe.ruleVersion,
      reason: `券配方「${recipe.name}」的任选项没有映射到当前门店对应官方 SKU/轮次，未自动准入`, verifiedAt: today(),
    };
  }
  if (recipe.resolve === 'pattern') {
    const refs = recipe.items.map(itemRef);
    return {
      status: 'pattern-verified', contents: refs, source: 'recipe', recipeId: recipe.id,
      ...(boundCombo ? { boundComboCode: boundCombo.code, comboCode: boundCombo.code,
        boundRoundIds: recipe.binding?.roundIds?.length ? recipe.binding.roundIds : boundCombo.deconstruction?.map((r) => r.roundId ?? '').filter(Boolean) } : {}),
      ruleVersion: recipe.ruleVersion, verifiedAt: recipe.verifiedAt || today(),
    };
  }
  // explicit：逐项绑定当前门店菜单；任何固定项缺失/歧义均拒绝自动准入。
  const refs: VoucherItemRef[] = [];
  for (const it of recipe.items) {
    if (it.mode === 'combo-ref') {
      const target = it.fulfillCode || it.keyword;
      const combo = menu.items.find((x) => x.isCombo && (x.code === target || normName(x.name) === normName(it.comboName || target)));
      if (!combo?.deconstruction?.length) return {
        status: 'unverified', reasonCode: 'name-mismatch', recipeId: recipe.id, ruleVersion: recipe.ruleVersion,
        reason: `整包引用「${it.comboName || target}」未映射到当前门店官方套餐`, verifiedAt: today(),
      };
      refs.push({ ...itemRef(it), keyword: combo.code, comboName: combo.name });
      continue;
    }
    if (it.mode === 'choice') {
      const hasDirectRange = Array.isArray(it.choiceRange) && it.choiceRange.length > 0
        && it.choiceRange.some((c) => resolveFixedVoucherFood({ keyword: c, mode: 'fixed', qty: 1 }, menu) !== null);
      if (!recipe.binding?.comboCode && !recipe.binding?.roundIds?.length && !hasDirectRange) return {
        status: 'unverified', reasonCode: 'choice-range-unclear', recipeId: recipe.id, ruleVersion: recipe.ruleVersion,
        // v1.4.4 R02：原因文案点名「券面声明的任选结构」，并说明该券保留为价格候选——
        //   证据不足时如实展示价格，绝不宣称完整核验。
        reason: `券面「${recipe.name}」含任选项（${it.spec || it.keyword}${it.choiceRange?.length ? `；声明范围 ${it.choiceRange.join('/')}` : ''}），`
          + `未绑定当前门店官方 SKU/轮次且无有效任选范围，任选范围无法从官方数据确认，未自动准入（保留价格候选，仅展示价格与券面图）`,
        verifiedAt: today(),
      };
      refs.push(itemRef(it));
      continue;
    }
    // v1.4.4 R01：固定品项身份解析——只允许「同一食品 + 同一规格 + 同一份量」的书写差异。
    //   红线（评审 R01）：别名绝不改变食品身份。官方菜单中下列均为**各自独立的单品**：
    //     无糖可口可乐 ≠ 可乐（糖型不同）／吉士汉堡包 ≠ 双层吉士汉堡（肉饼数不同）／
    //     脆薯饼 ≠ 心形薯饼5块（形态与份量不同）／香芋派·菠萝派·苹果派 ≠ 派（口味不同）／
    //     奥利奥麦旋风 ≠ 经典麦旋风（口味不同）。
    //   旧实现把上述名称并入同一食品，使券面内容被替换、营养与价格随之改变；且保留「包含式」兜底，
    //   使原品缺失时可借另一食品放行。两者一并删除：无法确定身份时保持未核验（保留价格候选）。
    const SAME_FOOD_ALIASES: Array<{ re: RegExp; target: string; spec: string }> = [
      // 官方菜单全名「麦麦脆汁鸡1块」的日常简称；必须与券面声明规格一致才采信，
      // 避免把「麦麦脆汁鸡-琵琶腿 / -腿」等不同规格单品误判为同一件。
      { re: /^麦麦脆汁鸡$/, target: '麦麦脆汁鸡1块', spec: '1块' },
    ];
    const findExact = () => {
      if (it.fulfillCode) {
        const byCode = menu.items.find((x) => !x.isCombo && x.code === it.fulfillCode);
        if (byCode) return byCode;
      }
      const singles = menu.items.filter((x) => !x.isCombo);
      const targetNorm = normName(it.keyword);
      if (!targetNorm) return undefined;
      // ① 归一化全名一致：同糖型、同规格的真实全名直接命中
      const exactMatch = singles.find((x) => normName(x.name) === targetNorm);
      if (exactMatch) return exactMatch;
      const declaredSpec = normSpecToken(it.spec);
      // ② 同一食品的书写变体（详略差异）：要求券面声明规格与别名目标规格一致
      for (const a of SAME_FOOD_ALIASES) {
        if (!a.re.test(it.keyword)) continue;
        if (!declaredSpec || declaredSpec !== normSpecToken(a.spec)) continue;
        const m = singles.find((x) => normName(x.name) === normName(a.target));
        if (m) return m;
      }
      // ③ 规格限定后缀匹配：「<规格词><品名>」（中薯条 = 中 + 薯条）。仅当券面声明了规格、
      //    且**唯一命中**时采信；大/中/小薯条同时命中即视为歧义 → 不采信。
      if (declaredSpec) {
        const hits = singles.filter((x) => {
          const nm = normName(x.name);
          if (nm === targetNorm || !nm.endsWith(targetNorm)) return false;
          const head = nm.slice(0, nm.length - targetNorm.length);
          return head !== '' && normSpecToken(head) === declaredSpec;
        });
        if (hits.length === 1) return hits[0];
      }
      // ④ 无证据：不再以包含关系替代身份一致（旧实现在此借另一食品放行）
      return undefined;
    };
    const exact = findExact();
    if (exact) {
      refs.push({ ...itemRef(it), keyword: exact.name, fulfillCode: exact.code });
    } else {
      const resolved = resolveFixedVoucherFood(it, menu);
      if (!resolved) return {
        status: 'unverified', reasonCode: 'spec-unmappable', recipeId: recipe.id, ruleVersion: recipe.ruleVersion,
        reason: `固定品项「${it.keyword}」无法确认食品身份或未收录营养，未自动准入`, verifiedAt: today(),
      };
      refs.push({ ...itemRef(it), keyword: resolved.displayName, fulfillCode: resolved.fulfillCode });
    }
  }
  return {
    status: refs.length > 0 ? 'pattern-verified' : 'unverified',
    ...(refs.length > 0 ? { contents: refs } : { reasonCode: 'spec-unmappable' as const, reason: '配方未定义组成' }),
    source: 'recipe', recipeId: recipe.id, ruleVersion: recipe.ruleVersion, verifiedAt: recipe.verifiedAt || today(),
  };
}

// ---------- 主入口 ----------

/** 单条团单的逐项核验（S0 配方 → S1 模式 → S2 官方同名 → 未核验细分原因）。零假造：全部证据来自官方接口/核验配方。 */
export async function verifyDealContents(
  client: McpClient,
  storeCode: string,
  deal: Pick<UnionDeal, 'name' | 'headUrl' | 'productViewSign' | 'skuViewId'>,
  menu: MenuLoadResult,
  city?: string,
): Promise<DealVerifyRecord> {
  const headUrl = deal.headUrl ? { headUrl: deal.headUrl } : {};
  // S0 券配方库（人工核验一次、长期复用；优先于详情猜测）
  // v1.4.3：同一券名可能命中多条配方（预置 combo-name 占位 + 用户层 explicit 构成）。
  //   按证据强度逐档尝试，取**首个核验通过**者；全部未通过时以最高优先级候选的具体原因作为结论
  //   （不再因首条占位配方失效就整券回落为笼统未核验）。
  // v1.4.4 R03：匹配前先过「商品身份 + 适用范围」——同名不同 productViewSign/skuViewId 的券绝不串用；
  //   声明了 scope.city/stores 的门店限定配方在上下文不匹配时排除（宁可保留价格候选，不跨店复用）。
  const candidates = matchRecipeCandidates(deal.name, undefined, {
    productViewSign: deal.productViewSign,
    skuViewId: deal.skuViewId,
    city,
    storeCode,
  });
  if (candidates.length > 0) {
    let firstFail: DealVerifyRecord | null = null;
    for (const recipe of candidates) {
      const rec = await verifyByRecipe(client, storeCode, deal.name, menu, recipe);
      if (rec.status !== 'unverified') return { ...rec, ...headUrl };
      firstFail ??= rec;
    }
    if (firstFail) return { ...firstFail, ...headUrl };
  }
  // S1 券名结构化模式
  const pattern = parseDealPattern(deal.name);
  if (pattern && patternRangeKnown(pattern)) {
    return { status: 'pattern-verified', contents: pattern, source: 'name-pattern', ruleVersion: '1plus1-v1', verifiedAt: today(), ...headUrl };
  }
  // S2 官方菜单同名套餐（仅非早餐营业时段的实时/快照菜单均可作为身份证据）
  if (menu.items.length > 0) {
    const viaMenu = await verifyByOfficialMenu(client, storeCode, deal.name, menu);
    if (viaMenu) return { ...viaMenu, ...headUrl };
  }
  // S2b 官方菜单同名单品（v1.4.1）：券名=官方单品名 / 数量词+官方单品名 → 构成=该单品×N（零猜测）
  const viaSingle = verifyByOfficialSingle(deal.name, menu);
  if (viaSingle) return { ...viaSingle, ...headUrl };
  // 未核验：按证据缺失的具体位置细分
  const trimmed = deal.name.replace(/\s+/g, '');
  if (/任选|自由拼|组合/.test(trimmed) && !/随心配/.test(trimmed)) {
    return {
      status: 'unverified', reasonCode: 'choice-range-unclear',
      reason: '券面声明「任选/自由拼」但可选集合无法从官方数据确认（任选范围不明确）',
      verifiedAt: today(), ...headUrl,
    };
  }
  return {
    status: 'unverified', reasonCode: 'detail-unavailable',
    reason: '联盟接口未提供券面食品清单（列表/精确查询/扩展字段均无构成；详情页为 App 壳），且配方库无此券——详情未取得，券面内容请看券面主图或下单页',
    verifiedAt: today(), ...headUrl,
  };
}

/** 未核验原因 → 用户可读短句（渠道诊断/排除明细共用，避免千篇一律「明细未核验」） */
export function unverifiedReasonText(rec: DealVerifyRecord): string {
  switch (rec.reasonCode) {
    case 'spec-unmappable': return '券面规格无法匹配官方食品库（规格无法匹配）';
    case 'choice-range-unclear': return '券面任选范围不明确（任选范围不明确）';
    case 'name-mismatch': return '券名与官方菜单无同名套餐（券面构成无官方证据）';
    case 'detail-unavailable':
    default: return '券面详情未取得（联盟接口不提供构成明细；券面主图可人工核对）';
  }
}
