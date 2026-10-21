// 模块 B：麦门拼单仲裁官（P0 主线：结构化输入 → 整单组装 → 计价核验 → 原价等比分账）
// 算法口径遵循 PRD v1.1 §2.3.3（原价等比分摊法）；满减凑单引擎已按 Q2 移出差异主线（非目标）。
// 粘贴解析为「规则版」：Web 演示端无 LLM 的降级路径；对话原型（SKILL.md）中由 LLM 解析为主路径，
// 两者输出同一 GroupMember 结构，经前端确认卡修正后再求解（PRD §2.2.1）。
// 心愿短语解析（v0.4）：数量词提取（两个/两份五块）、规格词归并（中薯/大杯→单一 SKU 时进备注）、
// 套餐/单点意图、口味词二段匹配（草莓麦旋风→麦旋风品类+提示）、特制/条件需求→订单备注。
import type { McpClient } from './mcp.js';
import { loadMenuItems, quotePrice, buildRoundSpecs, type MenuItem } from './menu.js';
import { withOrderParams } from './orderContext.js';
import type { NutritionRow } from './nutrition.js';
import { lookupOfficialNutrition, lookupOfficialSpecs, specTitleFromRaw } from './officialNutrition.js';
import { resolveComponentNutrition } from './nutritionSupplements.js';

export interface GroupMember {
  alias: string;
  wishes: string[]; // 心愿短语（原样保留，解析在 solve 内统一进行）
  taboos: string[]; // 禁忌关键词（命中品名即排除）
  kcalCap?: number; // 控卡上限（如「控卡450」；影响该成员候选池）
  sugarFree?: boolean; // 无糖要求（排除快碳饮品）
  notes?: string[]; // 特制/条件需求（少冰/去酸黄瓜/换餐等，进订单备注）
  personalCouponCents?: number; // 个人口述券冲减（分），从其应付中直接扣除
}

export interface GroupOrderInput {
  storeCode: string;
  storeName?: string;
  /** v1.3：城市上下文（传给美团联盟检索 cityId；缺失时诊断如实标注「未传城市」） */
  city?: string;
  members: GroupMember[];
}

export interface GroupMemberResult {
  alias: string;
  items: Array<{
    code: string; name: string; qty: number; priceCents: number; isCombo?: boolean;
    nutritionMatched?: boolean; nutritionNote?: string; nutritionSource?: string;
    nutritionEstimated?: boolean; nutritionUnknownFields?: string[];
    isBundleItem?: boolean; viaVoucherId?: string; fromPlan?: string; deconstruction?: import('./menu.js').RoundSpec[];
  }>;
  /** 成员热量合计是否缺少热量字段；缺失时 kcal 仅代表已知部分 */
  nutritionKcalPartial?: boolean;
  nutritionEstimated?: boolean;
  nutritionUnknownFields?: string[];
  nutritionSources?: string[];
  originalCents: number; // 本人品项菜单原价合计（qty 已计入）
  shareCents: number; // 原价等比分摊后的餐费份额
  payableCents: number; // 应付 = share - 个人券（≥0）
  savedCents: number; // originalCents - shareCents（个人券不计入「省」，避免口径混淆）
  personalCouponCents?: number; // 本人个人券冲减（分）
  note?: string; // 本人特制/规格备注（如「两块装请确认规格」「口味不可用已换品类」）
  kcal: number;
  unresolvedWishes: string[]; // 菜单中未能匹配的心愿（如实呈现，不编造）
  tabooFiltered: string[]; // 因禁忌被过滤掉的候选（透明化）
}

export interface GroupSolution {
  store: { storeCode: string; storeName: string };
  track: 'a-la-carte' | 'bundle' | 'voucher'; // 轨道1 散点 / 轨道2 套壳（P1 双轨比价）/ 轨道3 全网合规券包（v1.3）
  trackNote?: string; // 轨道说明（套壳明细/换选差异）
  members: GroupMemberResult[];
  orderNotes: string[]; // 订单备注（可直接粘贴到官方下单页备注栏）
  totals: {
    originalCents: number;
    paidCents: number; // calculate-price 实付（含整单优惠）
    discountCents: number;
    priceSource: 'calculate-price' | 'menu-price' | 'mixed';
    priceNote: string;
  };
  deliveryFeeCents: number; // P0 仅到店自提=0；外送费结构未实测，字段预留
  warnings: string[];
  disclaimer: string;
}

// ---------- 心愿短语解析（数量/规格/意图/备注） ----------

export interface WishSpec {
  raw: string; // 原始短语
  keyword: string; // 归一关键词（数量/规格/套餐字样已剥离）
  qty: number; // 数量（默认 1）
  exact?: boolean; // 恰好语义（「只要/恰好/正好两份」= =qty；默认至少 ≥qty）（v5 评审#2）
  wantCombo?: boolean; // 显式要套餐（套餐/件套/桶）
  wantSingle?: boolean; // 显式不要套餐（单点/不用套餐）
  specNote?: string; // 规格备注（菜单为单一 SKU 时提示确认）
  note?: string; // 特制/条件备注（少冰/去酸黄瓜/缺货反馈等）
  /** v1.4.10 W04：品类心愿（饮料/汉堡/小食/甜品）——没有具体品名时保留为结构化类目需求，
   *  由求解器在同类合法食品（含套餐槽位、券食品）中选择，不再静默丢弃。 */
  category?: 'drink' | 'staple' | 'side' | 'dessert';
}

const NUM_CN: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const RE_QTY = /([一二两二三四五六七八九十\d]+)\s*(份|个|杯|瓶|包|盒)/;
const RE_PIECE = /([一二两二三四五六七八九十\d]+)\s*块/;
const RE_SPEC = /大份|中份|小份|大杯|中杯|小杯|加量/;
const RE_COMBO_WORD = /套餐|件套|全家桶|豪华桶/;
const RE_SINGLE_WORD = /不用套餐|不要套餐|单点|散点/;
const FLAVOR_WORDS = /草莓|香芋|蓝莓|奥利奥|柠檬脆脆|巧克力|抹茶|椒盐/g;
const TAIL_WORDS = /[的话就行哦啦吧呀了呢]+$/;

/** 心愿短语 → 结构化 WishSpec（尽力而为；确认卡可修正） */
export function parseWishPhrase(phrase: string): WishSpec | null {
  let s = phrase.trim().replace(TAIL_WORDS, '');
  if (!s || /^随意|随便|都行|均可$/.test(s)) return { raw: phrase, keyword: '', qty: 1 };
  const spec: WishSpec = { raw: phrase, keyword: '', qty: 1 };
  // 数量（份/个/杯/瓶/包/盒 为份数单位）
  const qm = s.match(RE_QTY);
  if (qm) {
    const n = NUM_CN[qm[1]] ?? parseInt(qm[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 20) spec.qty = n;
    s = s.replace(qm[0], '');
  }
  // 「块」计数：无份/个修饰时为规格而非份数（两块麦辣鸡翅 = 一份两块装）
  const pm = s.match(RE_PIECE);
  if (pm) {
    const n = NUM_CN[pm[1]] ?? parseInt(pm[1], 10);
    if (Number.isFinite(n)) spec.specNote = `${n} 块装（请下单时确认规格）`;
    s = s.replace(pm[0], '');
  }
  // 意图
  if (/只要|恰好|正好|就点/.test(s)) spec.exact = true; // 恰好语义（v5）
  if (RE_COMBO_WORD.test(s)) spec.wantCombo = true;
  if (RE_SINGLE_WORD.test(s)) spec.wantSingle = true;
  // 规格词：当前门店多为单一 SKU，剥离后进备注
  const sm = s.match(RE_SPEC);
  if (sm) {
    spec.specNote = `${sm[0]}（当前门店菜单为单一规格，请以门店实际为准）`;
    s = s.replace(sm[0], '');
  }
  // 关键词清洗：意图词/口语动词/连接残留/称谓前缀
  spec.keyword = s
    .replace(/[一二两三四五六七八九十\d]+\s*件套/g, '')
    .replace(/套餐|件套|全家桶|豪华桶/g, '')
    .replace(/^(我想?吃?|想要?|要|再来?|然后|另外|加|点|喝|配|整个?|来|给我|帮我)+/g, '')
    .replace(/^(只要|恰好|正好|就点|一定要|必须要|务必)+/, '')
    .replace(/^饮料(选|要|来|点)?/, '') // 「饮料选雪碧」「饮料中杯可乐」→ 品名主体
    .replace(/^甜品(要)?/, '') // 「甜品要草莓麦旋风」→ 品名主体
    .replace(/^中薯$/, '薯条').replace(/^大薯$/, '薯条') // 中薯/大薯 → 薯条（当前门店单一薯条 SKU）
    // v1.4.10 W05：前置规格写法（大可乐/大薯条/中杯可乐）剥掉规格字，规格由 specNote/specLabel 承载
    .replace(/^(超大|大|中|小|迷你)(?=可乐|雪碧|薯条|咖啡|奶铁|豆浆|美式|红茶|果汁|牛奶|冰茶)/, '')
    .replace(/^(大|中|小)(?=杯|份)/, '')
    .replace(/汉堡包/g, '汉堡') // 吉士汉堡包 → 吉士汉堡
    .replace(/[的和呀呢哦]$/g, '')
    .replace(/[的了呀呢哦]/g, '')
    .trim();
  // v1.4.10 W04：无具体品名的类目心愿（饮料/大杯饮料/汉堡/小食/甜品）保留为结构化类目需求。
  //   旧实现把「饮料」整词抹掉后 keyword 为空 → 直接返回 null，成员空手却显示已覆盖。
  if (!spec.wantCombo && /^(汉堡|汉堡包|小食|小吃|甜品|甜点)$/.test(spec.keyword)) {
    spec.category = /汉堡/.test(spec.keyword) ? 'staple' : /小食|小吃/.test(spec.keyword) ? 'side' : 'dessert';
    spec.keyword = '';
  }
  if (!spec.keyword) {
    const cat = categoryOfPhrase(s, spec);
    if (cat) spec.category = cat;
  }
  // 纯意图短语（不用套餐/单点/散点）：意图已由 wantSingle 承载，无品名主体则整体跳过
  if (/^(不用|不要|单点|散点)?$/.test(spec.keyword) && !spec.category) return null;
  return spec;
}

/** 类目词识别（仅当短语没有具体品名时使用；套餐意图优先，避免「汉堡套餐」被当成汉堡类目）。 */
function categoryOfPhrase(s: string, spec: WishSpec): WishSpec['category'] | undefined {
  const t = s.replace(/^[我想吃要再来然后另外加点喝配整来给我帮我]+/, '').trim();
  if (!t || RE_COMBO_WORD.test(t) || spec.wantCombo) return undefined;
  if (/饮料|饮品/.test(t)) return 'drink';
  if (/^(汉堡|汉堡包|堡)$/.test(t)) return 'staple';
  if (/^(小食|小吃|配餐|配点|小菜)$/.test(t)) return 'side';
  if (/^(甜品|甜点|甜食)$/.test(t)) return 'dessert';
  return undefined;
}

// ---------- 粘贴文本规则解析（降级路径，尽力而为） ----------

const RE_ALIAS_LINE = /^\s*(?:@|【)?([\u4e00-\u9fa5a-zA-Z0-9_\-·]{1,12})(?:】|\s*[:：])/;
const RE_TABOO = /(?:不吃|不能吃|不想吃|不太想吃|不要|忌[口]?(?:食)?|别加|别放|去掉?|去)\s*([^\s，,。；;！!？?]{1,10})/g;
const RE_KCAL_CAP = /(?:控卡|热量|卡路里)[^\d]{0,6}(\d{2,4})/;
const RE_SPECIAL = /(少放?冰|去冰|不要?酸黄瓜|去酸黄瓜|不要?辣|不加辣|少辣)/g;
const RE_SWAP = /(换成?|换成要?)\s*([^\s，,。；;！!？?]{1,12})/g;
const RE_COND = /(如果|要是)[^，,。；;！!？?]{2,30}(的话)?/g;
// 段落过滤器（模块级常量，避免每次 extractWishes 调用重建正则对象）
const SKIP_RE = /^(我|我们|你|对了|然后|另外|就是|不过|还有|今天|现在|现在不太饿?)?[^\u4e00-\u9fa5a-zA-Z0-9]*$/;
const NEG_RE = /不需要|就不要|不要了|就不用|就不点|不要薯条|不要饮料|不用套餐|^不要/;
const NOISY_RE = /一共|就套餐里面|那份够了|帮我看看|告诉我|确认一下|配料和制作|补差价|加钱|加多少|如果|不行|就帮|的$|就行$/;
const DIET_RE = /^(我)?吃?(蛋奶素|素|素食)/;
const VERB_RE = /^(吃|要|来|喝|配|加|选|单点|换|升|整|点一?[个份杯瓶]|想吃|想要)/;
const FOOD_RE = /堡|鸡|鱼|薯|可乐|雪碧|派|新地|旋风|玉米|咖啡|茶|牛奶|纯悦|麦乐|鸡翅|鸡排|安格斯|吉士|巨无霸|板烧|薯饼|饮料|麦满分|随心配/;
const QTY_RE = /^[一二两三四五六七八九十\d]/; // 数量词开头 = 强心愿信号（一份巨无霸套餐）

/** 群聊文本 → 结构化成员。解析置信度低（识别不出任何成员）时返回空数组，由前端切换快捷表单 */
export function parseGroupText(text: string): { members: GroupMember[]; needsConfirm: boolean } {
  const members: GroupMember[] = [];
  const lines = text.split(/[\n\r]+|(?<=[。；;！!])\s*/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const aliasMatch = line.match(RE_ALIAS_LINE);
    const alias = aliasMatch?.[1] ?? (members.length === 0 && lines.length === 1 ? '拼单发起人' : '');
    if (!alias) {
      if (members.length > 0) extractWishes(line, members[members.length - 1]);
      continue;
    }
    let m = members.find((x) => x.alias === alias);
    if (!m) { m = { alias, wishes: [], taboos: [], notes: [] }; members.push(m); }
    // 代称剥离：心愿解析只处理行体（否则「小明： 我」这类残留会成为噪音心愿）
    extractWishes(aliasMatch ? line.slice(aliasMatch[0].length) : line, m);
  }
  for (const m of members) {
    if (m.wishes.length === 0 && m.taboos.length === 0) m.wishes.push('随意');
  }
  return { members, needsConfirm: members.length > 0 };
}

function extractWishes(line: string, m: GroupMember): void {
  const cap = line.match(RE_KCAL_CAP);
  if (cap) m.kcalCap = Number(cap[1]);
  if (/无糖|零卡|零度/.test(line)) m.sugarFree = true;
  const coupon = line.match(/(?:券|立减|免单)[^\d]{0,6}(\d{1,3})\s*元/);
  if (coupon) m.personalCouponCents = Number(coupon[1]) * 100;
  for (const t of line.matchAll(RE_TABOO)) {
    const kw = t[1].trim();
    if (kw && !m.taboos.includes(kw)) m.taboos.push(kw);
  }
  for (const sp of line.matchAll(RE_SPECIAL)) {
    const kw = sp[1].trim();
    if (kw && !(m.notes ?? []).includes(kw)) (m.notes ??= []).push(kw);
  }
  for (const sw of line.matchAll(RE_SWAP)) {
    const kw = `替换需求：${sw[0].trim()}`;
    if (!(m.notes ?? []).includes(kw)) (m.notes ??= []).push(kw);
  }
  for (const cd of line.matchAll(RE_COND)) {
    const kw = `条件需求：${cd[0].trim()}（缺货或不可履约时请反馈点餐人）`;
    if (!(m.notes ?? []).includes(kw)) (m.notes ??= []).push(kw);
  }
  // 心愿切分：按标点分段，段内按动词/量词定位起点；否定段/语气段/描述段跳过（过滤器为模块级常量）
  const segs = line
    .split(/[，,。；;！!？?、]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  for (const seg of segs) {
    // 先按连接词切分；数量词只有在前面已有完整食品时才作为下一条需求的起点。
    // 「只要两份五块麦乐鸡」的限定词、份数和块数必须留在同一需求里。
    const parts = seg
      .split(/(?=想吃?|想要?|再来?|然后|另外|还要|喝|配|加|单点|点一?[个份杯瓶]|来一?[个份杯瓶]|给我|和)/g)
      .flatMap((part) => {
        const chunks: string[] = [];
        let start = 0;
        for (const q of part.matchAll(/[一二两三四五六七八九十\d]+[份个杯瓶盒]/g)) {
          const prefix = part.slice(start, q.index);
          if (!FOOD_RE.test(prefix)) continue;
          chunks.push(prefix);
          start = q.index!;
        }
        chunks.push(part.slice(start));
        return chunks;
      })
      .map((p) => p.replace(/^(然后|另外|并且|还有|和|对了)/, '').trim())
      .filter(Boolean);
    for (const p of parts) {
      let cleaned = p.replace(/^(然后|另外|并且|还有|和|对了|再)/, '').replace(/(就行|就好|吧|呀|哦)$/, '').replace(/各$/, '').trim();
      if (cleaned.length < 2 || SKIP_RE.test(cleaned)) continue;
      if (NEG_RE.test(cleaned)) continue; // 否定段（不需要薯条等）
      if (NOISY_RE.test(cleaned)) continue; // 沟通性/条件性语句（已在 notes 提取）
      if (DIET_RE.test(cleaned)) { (m.notes ??= []).push(`饮食声明：${cleaned}`); continue; }
      if (/不能吃|忌口|不想吃/.test(cleaned)) continue; // 禁忌已由 RE_TABOO 提取
      // 纯量词/纯动词段（一份/两份/十块/想吃/饮料/单点）：剥掉后无实质内容则不加
      const bare = cleaned
        .replace(/[一二两三四五六七八九十\d]+[份个杯瓶块盒]?/g, '')
        .replace(/^(想吃?|想要?|要|来|喝|配|加|点|单点|给我|然后|另外|饮料选?|甜品|再)+/g, '')
        .trim();
      if (!bare || bare.length < 2) continue;
      if (!VERB_RE.test(cleaned) && !FOOD_RE.test(cleaned) && !QTY_RE.test(cleaned)) continue; // 无动词无品名非数量开头的描述段
      if (m.taboos.some((t) => cleaned.includes(t))) continue;
      if (!m.wishes.includes(cleaned)) m.wishes.push(cleaned);
    }
  }
}

// ---------- 心愿 ↔ 菜单匹配 ----------

export function norm(s: string): string {
  return s.replace(/[（(【\[].*?[)）】\]]/g, '').replace(/\s+/g, '').toLowerCase();
}

const RE_SUGARFREE_REQ = /^(无糖|不甜|少糖|去糖)$/;

/** 禁忌是否命中某品项（关键词命中品名，或无糖需求命中含糖饮品/甜品）。导出供轨道 3 复用 */
export function tabooHit(m: GroupMember, it: MenuItem): boolean {
  if (m.sugarFree && it.fastCarb > 0 && /饮品|麦咖啡/.test(it.category)) return true;
  for (const t of m.taboos) {
    const kw = norm(t);
    if (!kw) continue;
    if (RE_SUGARFREE_REQ.test(kw) || kw === '糖') {
      if (it.fastCarb > 0) return true;
      continue;
    }
    if (norm(it.name).includes(kw)) return true;
  }
  return false;
}

export interface MatchResult {
  item: MenuItem;
  flavorFallback?: boolean; // 口味词已剥离（草莓麦旋风→经典麦旋风），口味可能不符
  synonymsApplied?: boolean; // 汉堡→堡 同义转换命中
}

function matchByKeyword(keyword: string, items: MenuItem[], w: WishSpec): MenuItem[] {
  const k = norm(keyword);
  if (!k) return [];
  // 收集：精确 ∪ 包含（关键词 ≥2 字）∪ 反向——精确命中不代表唯一（「巨无霸」精确命中单品，
  // 但 wish 要求套餐时「巨无霸四件套」仅出现在包含集），合并后由意图排序决定
  const exact = items.filter((i) => norm(i.name) === k);
  const contains = k.length >= 2 ? items.filter((i) => norm(i.name).includes(k) && norm(i.name) !== k) : [];
  const reverse = k.length >= 2 ? items.filter((i) => k.includes(norm(i.name)) && norm(i.name) !== k) : [];
  const seen = new Set<string>();
  const cands: Array<{ item: MenuItem; exact: boolean }> = [];
  for (const i of [...exact, ...contains, ...reverse]) {
    if (seen.has(i.code)) continue;
    seen.add(i.code);
    cands.push({ item: i, exact: norm(i.name) === k });
  }
  const wishWantsCombo = w.wantCombo || /套餐|件套|桶|拼/.test(w.raw);
  // v1.4.9（R02 边界）：结构未取得的套餐**不参与心愿匹配**。
  //   它们没有轮次/构成证据，无法证明「这份餐里到底有什么」，把它们算作覆盖等于用未知冒充已知；
  //   旧行为（v1.4.8）只是排序降权，仍可能在无完整结构时被选中并计覆盖。
  //   这些条目仍留在目录与遗漏账里（menuAudit 会写明原因），不影响它们可被单独购买。
  const list = cands
    .filter((c) => !c.item.structureUnknown)
    .filter((c) => (w.wantSingle ? !c.item.isCombo : true))
    // v1.4.9（R02 边界）：心愿明确要「套餐/件套/桶」时，单品不得充当候选。
    //   旧实现允许反向包含（「板烧鸡腿麦满分套餐」⊃「板烧鸡腿麦满分」）把单堡算作命中，
    //   这正是评审看到的「只计主食热量却显示覆盖 1/1」的另一条路径。
    .filter((c) => (wishWantsCombo ? c.item.isCombo : true));
  // 意图排序：显式套餐→组合优先（同组合取最低价）→ 精确优先；默认非套餐优先 → 精确优先 → 价格
  list.sort((a, b) => {
    const ca = a.item, cb = b.item;
    if (ca.isCombo !== cb.isCombo) {
      if (wishWantsCombo) return ca.isCombo ? -1 : 1;
      if (!w.wantCombo) return ca.isCombo ? 1 : -1;
    }
    const ea = a.exact ? 0 : 1, eb = b.exact ? 0 : 1;
    if (ea !== eb) return ea - eb;
    // v1.4.8 R02：结构未取得的套餐（详情失败/无轮次）不得压过结构完整的同名套餐——
    //   否则「板烧鸡腿麦满分套餐」会命中更便宜的降级「…组合」条目，而它没有可建模的轮次。
    const ua = ca.structureUnknown ? 1 : 0, ub = cb.structureUnknown ? 1 : 0;
    if (ua !== ub) return ua - ub;
    return ca.priceCents - cb.priceCents || ca.name.length - cb.name.length;
  });
  return list.map((c) => c.item);
}

export function findMenuItem(w: WishSpec, items: MenuItem[]): MatchResult | undefined {  // 第 1 轮：原关键词
  let cands = matchByKeyword(w.keyword, items, w);
  if (cands.length > 0) return { item: cands[0] };
  // 第 2 轮：口味词剥离（草莓麦旋风 → 麦旋风），命中时标注口味可能不符
  const stripped = w.keyword.replace(FLAVOR_WORDS, '');
  if (stripped !== w.keyword && stripped.length >= 2) {
    cands = matchByKeyword(stripped, items, w);
    if (cands.length > 0) return { item: cands[0], flavorFallback: true };
  }
  // 第 3 轮：汉堡→堡 同义（麦辣鸡腿汉堡 → 麦辣鸡腿堡）
  const alt = w.keyword.replace(/汉堡/g, '堡');
  if (alt !== w.keyword && alt.length >= 2) {
    cands = matchByKeyword(alt, items, w);
    if (cands.length > 0) return { item: cands[0], synonymsApplied: true };
  }
  return undefined;
}

// ---------- 整单组装与分账（轨道 1：散点） ----------

/** 规格感知营养（v0.4）：官方营养表按规格分行（可乐中杯 147 / 大杯 224 / 无糖 0 kcal、
 *  中薯条 289 / 大薯条 379、麦辣鸡翅-2块 224）。心愿指定规格（大杯/无糖/两块…）时，
 *  在「品项 base + 规格」交集唯一命中的营养行上计算热量，实现分规格热量。
 *  导出供轨道 3 复用。 */
export function findSpecRow(
  table: Map<string, NutritionRow> | undefined,
  item: MenuItem,
  spec: WishSpec,
): { row: NutritionRow; label: string } | null {
  // 优先：官网营养计算器权威映射（产品→规格两级，覆盖 MCP 表缺失的奥利奥麦旋风/香芋派/纯悦等）。
  // 先用菜单品名查；不命中时用用户心愿关键词查（「奥利奥麦旋风」在官网有、菜单匹配到的「经典麦旋风」官网没有）
  let off = lookupOfficialNutrition(item.name, spec.raw);
  if (!off && spec.keyword) off = lookupOfficialNutrition(spec.keyword, spec.raw);
  if (off) {
    return {
      row: {
        productName: `${off.productName}(${off.specTitle})`,
        energyKj: off.energyKj,
        energyKcal: off.energyKcal,
        protein: off.protein,
        fat: off.fat,
        carbohydrate: off.carbohydrate,
        sodium: off.sodium,
        calcium: 0,
      },
      label: off.specTitle,
    };
  }
  // Fallback 1：MCP 营养表规格行匹配（原逻辑）
  if (table && table.size > 0) {
    const base = item.name.replace(/[（(【\[].*?[)）】\]]/g, '').trim();
    if (base) {
      const raw = spec.raw;
      const wantNoSugar = /无糖/.test(raw);
      // v1.4.10 W05：「大可乐」「大薯条」这类前置规格写法也参与规格行匹配（不只认大杯/大份）
      const rawSpec = specTitleFromRaw(raw);
      const sizeM = /^(超大|大|中|小|迷你)$/.test(rawSpec ?? '')
        ? [rawSpec!] as RegExpMatchArray
        : raw.match(/大杯|中杯|小杯|大份|中份|小份|大薯|中薯|小薯/);
      const pieceM = raw.match(/([一二两二三四五\d]+)\s*块/);
      if (wantNoSugar || sizeM || pieceM) {
        let rows = [...table.values()].filter((r) => {
          const rn = r.productName.replace(/[（(【\[].*?[)）】\]]/g, '').trim();
          if (rn === base) return true;
          return rn.includes(base) || base.includes(rn);
        });
        if (rows.length === 0 && /可乐/.test(base)) {
          rows = [...table.values()].filter((r) => /可乐/.test(r.productName));
        }
        if (wantNoSugar) rows = rows.filter((r) => /无糖/.test(r.productName));
        else rows = rows.filter((r) => !/无糖/.test(r.productName));
        if (sizeM) {
          const ch = sizeM[0].replace(/杯|份|薯/, ''); // 大杯→大、大薯→大（行名「大薯条」「可乐大杯」均含规格字）
          rows = rows.filter((r) => r.productName.includes(ch));
        } else if (rows.length > 1) {
          // 未指定杯型（如仅「无糖可乐」）但多规格并存：按默认中杯收敛，不唯一再放弃
          const mid = rows.filter((r) => /中杯|中份/.test(r.productName));
          if (mid.length === 1) rows = mid;
        }
        if (pieceM) {
          const n = NUM_CN[pieceM[1]] ?? parseInt(pieceM[1], 10);
          rows = rows.filter((r) => r.productName.replace(/[-—]/g, '').includes(`${n}块`));
        }
        const uniq = new Map<string, NutritionRow>();
        for (const r of rows) uniq.set(r.productName, r);
        if (uniq.size === 1) {
          const row = [...uniq.values()][0];
          const label = wantNoSugar ? '无糖' : sizeM ? sizeM[0] : `${pieceM![1]}块`;
          return { row, label };
        }
      }
    }
  }

  // Fallback 2：补录层（若官网与 MCP 表均未命中该规格行，查询权威补录层）
  let supNut = resolveComponentNutrition(item.name, spec.raw);
  if (!supNut.matched && spec.keyword) {
    supNut = resolveComponentNutrition(spec.keyword, spec.raw);
  }
  if (supNut.matched) {
    const rawSpecTitle = supNut.specTitle || spec.specNote || '默认';
    return {
      row: {
        productName: `${item.name}(${rawSpecTitle})`,
        energyKj: Math.round(supNut.kcal * 4.184),
        energyKcal: supNut.kcal,
        protein: supNut.protein,
        fat: supNut.fat,
        carbohydrate: supNut.carbohydrate,
        sodium: supNut.sodium,
        calcium: 0,
      },
      label: rawSpecTitle,
    };
  }
  return null;
}

function pickItemsForTrack(
  m: GroupMember,
  menu: { items: MenuItem[]; table?: Map<string, NutritionRow> },
  warnings: string[],
): { res: GroupMemberResult } {
  const res: GroupMemberResult = {
    alias: m.alias, items: [], originalCents: 0, shareCents: 0, payableCents: 0,
    savedCents: 0, personalCouponCents: m.personalCouponCents, kcal: 0,
    unresolvedWishes: [], tabooFiltered: [],
  };
  if (m.notes && m.notes.length > 0) res.note = m.notes.join('；');
  for (const phrase of m.wishes) {
    const spec = parseWishPhrase(phrase);
    if (!spec) continue;
    if (!spec.keyword) continue; // 「随意」等无关键词心愿：不猜品项
    const hit = findMenuItem(spec, menu.items);
    if (!hit) {
      res.unresolvedWishes.push(spec.raw);
      continue;
    }
    if (tabooHit(m, hit.item)) {
      res.tabooFiltered.push(`${spec.raw}（命中禁忌，已排除 ${hit.item.name}）`);
      continue;
    }
    const specRow = findSpecRow(menu.table, hit.item, spec);
    const kcalEach = specRow ? specRow.row.energyKcal : hit.item.kcal;
    const kcalKnown = hit.item.nutritionMatched || !!specRow;
    if (m.kcalCap) {
      if (!kcalKnown) {
        res.tabooFiltered.push(`${spec.raw}（${hit.item.name} 营养未收录，无法验证控卡上限 ${m.kcalCap}）`);
        continue;
      }
      if (kcalEach * spec.qty > m.kcalCap) {
        res.tabooFiltered.push(`${spec.raw}（${kcalEach} kcal × ${spec.qty} 超控卡上限 ${m.kcalCap}）`);
        continue;
      }
    }
    addWishItem(res, hit, spec, warnings, specRow);
    // 多规格未指定的透明提示（玉米杯 小53/大87 kcal 等）：不猜规格，如实告知
    if (!hit.item.nutritionMatched && !specRow) {
      const specs = lookupOfficialSpecs(hit.item.name) ?? (spec.keyword ? lookupOfficialSpecs(spec.keyword) : null);
      if (specs) warnings.push(`@${res.alias} ${hit.item.name} 有多个规格（${specs.map((x) => `${x.specTitle} ${x.energyKcal}`).join(' / ')} kcal），请确认规格，热量暂未计入`);
    }
  }
  if (res.unresolvedWishes.length > 0) {
    warnings.push(`@${m.alias} 的心愿「${res.unresolvedWishes.join('、')}」在当前门店菜单未匹配到品项，请点餐人在官方 APP 检索后补单。`);
  }
  return { res };
}

function addWishItem(
  res: GroupMemberResult,
  hit: MatchResult,
  spec: WishSpec,
  warnings: string[],
  specRow?: { row: NutritionRow; label: string } | null,
): void {
  const specOverrides = !!specRow && specRow.row.energyKcal !== hit.item.kcal; // 官网规格营养与菜单默认不同才标注
  const kcalEach = specRow ? specRow.row.energyKcal : hit.item.kcal;
  const dup = res.items.find((i) => i.code === hit.item.code);
  if (dup) { dup.qty += spec.qty; }
  else res.items.push({
    code: hit.item.code, name: hit.item.name, qty: spec.qty, priceCents: hit.item.priceCents,
    isCombo: hit.item.isCombo, nutritionMatched: hit.item.nutritionMatched || !!specRow,
    ...(specRow && specOverrides ? { nutritionNote: `按${specRow.label} ${specRow.row.energyKcal} kcal` } : {}),
  });
  res.originalCents += hit.item.priceCents * spec.qty;
  if (hit.item.nutritionMatched || specRow) res.kcal += kcalEach * spec.qty;
  const notes: string[] = [];
  if (hit.flavorFallback) notes.push(`「${spec.raw}」按品类匹配为 ${hit.item.name}，口味可能不符，请确认`);
  if (hit.synonymsApplied) notes.push(`「${spec.raw}」按同义词匹配为 ${hit.item.name}`);
  if (spec.wantCombo && !hit.item.isCombo) notes.push(`「${spec.raw}」要求套餐，当前门店仅有单品形式`);
  if (spec.specNote) notes.push(spec.specNote);
  if (specOverrides) notes.push(`热量按${specRow!.label}规格计（${specRow!.row.energyKcal} kcal/份）`);
  if (notes.length > 0) {
    const line = `@${res.alias} ${notes.join('；')}`;
    if (!warnings.includes(line)) warnings.push(line);
  }
}

export async function solveGroupOrder(
  client: McpClient,
  input: GroupOrderInput,
): Promise<GroupSolution> {
  const storeCode = input.storeCode;
  // 拼单用全量菜单（含营养未收录品项）：点单能力不受营养联结覆盖率的限制；
  // 控卡成员的 kcal 校验只在营养已联结的品项上执行，未收录品项如实标注。
  const menu = await loadMenuItems(client, storeCode, { includeUnmatched: true });
  const warnings: string[] = [];
  const members: GroupMemberResult[] = [];
  const orderNotes: string[] = [];

  for (const m of input.members) {
    const { res } = pickItemsForTrack(m, menu, warnings);
    members.push(res);
    if (m.notes && m.notes.length > 0) {
      orderNotes.push(`${m.alias}：${m.notes.join('；')}（特制需求以官方下单页可履约选项为准）`);
    }
  }

  const hasAnyItem = members.some((m) => m.items.length > 0);
  if (!hasAnyItem) {
    throw new Error('所有成员的心愿都未能匹配到当前门店菜单品项，请检查心愿关键词或更换门店。');
  }

  // 整单聚合计价：与精算模式同口径——calculate-price 与菜单促销价取低者并标注来源
  const cart = new Map<string, number>();
  for (const m of members) for (const i of m.items) cart.set(i.code, (cart.get(i.code) ?? 0) + i.qty);
  const cartList = [...cart.entries()].map(([code, qty]) => ({ code, qty }));
  const quote = await quotePrice(client, storeCode, cartList);
  const menuOriginalCents = members.reduce((s, m) => s + m.originalCents, 0);
  const useQuote = quote != null && quote.priceCents > 0 && quote.priceCents <= menuOriginalCents;
  const paidCents = useQuote ? quote!.priceCents : menuOriginalCents;
  const discountCents = useQuote ? quote!.discountCents : 0;
  const priceSource: GroupSolution['totals']['priceSource'] = useQuote ? 'calculate-price' : 'menu-price';
  if (!quote) warnings.push('计价接口本次未能返回报价，以下分摊按菜单促销价估算，实际以门店结算为准。');
  else if (!useQuote) warnings.push(`计价接口返回 ¥${(quote.priceCents / 100).toFixed(1)} 高于菜单促销价合计 ¥${(menuOriginalCents / 100).toFixed(1)}（特价商品需卡片/券条件），已按菜单价呈现。`);

  // 原价等比分摊（PRD §2.3.3）：成员应付 = 本人原价 × (整单实付 / 整单原价)；尾差归末位成员保证总额守恒
  const totalOriginal = members.reduce((s, m) => s + m.originalCents, 0);
  let assigned = 0;
  members.forEach((m, idx) => {
    const share = idx === members.length - 1 && totalOriginal > 0
      ? paidCents - assigned
      : Math.round((m.originalCents / totalOriginal) * paidCents);
    assigned += share;
    m.shareCents = Math.max(0, share);
    const coupon = m.personalCouponCents ?? 0;
    m.payableCents = Math.max(0, m.shareCents - coupon);
    m.savedCents = Math.max(0, m.originalCents - m.shareCents);
    if (coupon > 0) warnings.push(`@${m.alias} 的个人券（¥${(coupon / 100).toFixed(2)}）已在其应付中冲减，请点餐人核对该券适用条件。`);
  });

  if (orderNotes.length === 0 && members.every((m) => !m.note)) orderNotes.push('无特制需求，按标准配方下单即可。');

  return {
    store: { storeCode, storeName: input.storeName ?? `门店 ${storeCode}` },
    track: 'a-la-carte',
    members,
    orderNotes,
    totals: {
      originalCents: menuOriginalCents,
      paidCents,
      discountCents,
      priceSource,
      priceNote: useQuote ? '计价接口（含整单优惠）' : '菜单促销价估算',
    },
    deliveryFeeCents: 0,
    warnings,
    disclaimer:
      '数据来自麦当劳官方 MCP（菜单/计价），仅供参考，实际以门店结算为准。本工具仅输出决策清单与分账凭证，' +
      '不代下单、不托管资金、不共享他人账户权益。',
  };
}

// ---------- 轨道 2：随心配/组合套壳（P1 双轨比价） ----------
// 数据契约（2026-10-11 实测）：随心配 SKU 在门店菜单中可发现（分类「随心配/1+1」）；
// query-meal-detail 返回 rounds[].choices（diffPrice 换购差价）；
// calculate-price 支持 items[].roundList=[{round:"<rounds.id>",comboItemList:[{code,quantity}]}] 精确换选计价
// （实测 9900013304 默认 ¥14.9 → 换高达吉士双牛堡 ¥13.9，分毫不差）。
export interface ComboSkuInfo {
  code: string;
  name: string;
  priceCents: number; // 默认组合计价
  deconstruction?: import("./menu.js").RoundSpec[];
  rounds: Array<{ id: string; name: string; choices: Array<{ code: string; name: string; diffCents: number }> }>;
}

const comboDetailCache = new Map<string, { at: number; info: ComboSkuInfo | null; status: 'ok' | 'failed' }>();
const COMBO_TTL_MS = 60 * 60 * 1000;
/** v1.4.8 R08：套餐详情失败/无轮次的短重试窗口（与 menu.ts 同口径） */
const COMBO_FAIL_TTL_MS = 2 * 60 * 1000;

function parseDiffPrice(raw: string | undefined): number {
  if (!raw) return 0;
  const m = raw.replace(/\s/g, '').match(/([+-])¥?(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const cents = Math.round(parseFloat(m[2]) * 100);
  return m[1] === '-' ? -cents : cents;
}

export async function loadComboSkus(client: McpClient, storeCode: string, menu: { items: MenuItem[]; table?: Map<string, NutritionRow> }): Promise<ComboSkuInfo[]> {
  const skuItems = menu.items.filter((i) => /随心配|1\+1/i.test(i.category + i.tags.join('')));
  const out: ComboSkuInfo[] = [];
  for (const sku of skuItems) {
    const ck = `${storeCode}:${sku.code}`;
    const hit = comboDetailCache.get(ck);
    // v1.4.8 R08：失败结果只用短 TTL 重试（旧实现把 null 也按 60 分钟缓存 → 上游恢复后仍判「无轮次」）
    const ttl = hit?.status === 'ok' ? COMBO_TTL_MS : COMBO_FAIL_TTL_MS;
    if (hit && Date.now() - hit.at < ttl) { if (hit.info) out.push(hit.info); continue; }
    let info: ComboSkuInfo | null = null;
    try {
      // v1.4.9 N01：套餐构成也按目标用餐时间取（早餐/常规时段可售范围不同）
      const res = await client.call('query-meal-detail', withOrderParams({ code: sku.code, storeCode, orderType: 1, beType: 1 }));
      const data = res.data as { rounds?: Array<{ id?: number; name?: string; choices?: Array<{ code?: string; name?: string; diffPrice?: string }> }> };
      const rounds = (data?.rounds ?? [])
        .filter((r) => (r.choices?.length ?? 0) > 0)
        .map((r) => ({
          id: String(r.id ?? ''),
          name: r.name ?? '',
          choices: (r.choices ?? []).map((c) => ({ code: String(c.code ?? ''), name: c.name ?? '', diffCents: parseDiffPrice(c.diffPrice) })),
        }));
      if (rounds.length >= 2) info = { code: sku.code, name: sku.name, priceCents: sku.priceCents, rounds, deconstruction: buildRoundSpecs(data?.rounds ?? []) };
    } catch { info = null; }
    comboDetailCache.set(ck, { at: Date.now(), info, status: info ? 'ok' : 'failed' });
    if (info) out.push(info);
  }
  return out;
}

export async function solveBundleTrack(
  client: McpClient,
  input: GroupOrderInput,
  menu: { items: MenuItem[]; table?: Map<string, NutritionRow> },
): Promise<GroupSolution | null> {
  const storeCode = input.storeCode;
  const skus = await loadComboSkus(client, storeCode, menu);
  if (skus.length === 0) return null;

  const warnings: string[] = [];
  const members: GroupMemberResult[] = [];
  const cart: Array<{ productCode: string; quantity: number; roundList: Array<{ round: string; comboItemList: Array<{ code: string; quantity: number }> }> }> = [];
  let coveredWishCount = 0;
  const totalWishCount = input.members.reduce((s, m) => s + m.wishes.length, 0);

  for (const m of input.members) {
    const res: GroupMemberResult = {
      alias: m.alias, items: [], originalCents: 0, shareCents: 0, payableCents: 0,
      savedCents: 0, personalCouponCents: m.personalCouponCents, kcal: 0,
      unresolvedWishes: [], tabooFiltered: [],
    };
    if (m.notes && m.notes.length > 0) res.note = m.notes.join('；');

    // 心愿 → 菜单品项解析（与轨道 1 同一匹配函数，保证两轨可比）
    const resolved: Array<{ wish: string; spec: WishSpec; hit: MenuItem; specRow: { row: NutritionRow; label: string } | null }> = [];
    for (const phrase of m.wishes) {
      const spec = parseWishPhrase(phrase);
      if (!spec || !spec.keyword) continue;
      const hit = findMenuItem(spec, menu.items);
      if (!hit) { res.unresolvedWishes.push(spec.raw); continue; }
      if (tabooHit(m, hit.item)) { res.tabooFiltered.push(`${spec.raw}（命中禁忌，已排除 ${hit.item.name}）`); continue; }
      // 控卡口径与轨道 1 一致（官网规格营养优先，营养未收录才不可验证）
      const specRow = findSpecRow(menu.table, hit.item, spec);
      const kcalEach = specRow ? specRow.row.energyKcal : hit.item.kcal;
      const kcalKnown = hit.item.nutritionMatched || !!specRow;
      if (m.kcalCap) {
        if (!kcalKnown) {
          res.tabooFiltered.push(`${spec.raw}（${hit.item.name} 营养未收录，无法验证控卡上限 ${m.kcalCap}）`); continue;
        }
        if (kcalEach * spec.qty > m.kcalCap) {
          res.tabooFiltered.push(`${spec.raw}（${kcalEach} kcal × ${spec.qty} 超控卡上限 ${m.kcalCap}）`); continue;
        }
      }
      resolved.push({ wish: spec.raw, spec, hit: hit.item, specRow });
    }

    // 套壳检测：每 round 消耗一个已解析心愿（code 精确或名称互含），至少 2 个 round 命中才值得套壳
    const matchChoice = (hit: MenuItem, c: { code: string; name: string }): boolean => {
      if (c.code === hit.code) return true;
      const a = norm(c.name), b = norm(hit.name);
      if (!a || !b) return false;
      return a.includes(b) || b.includes(a);
    };
    let best: { sku: ComboSkuInfo; picks: Array<{ roundId: string; used: { wish: string; spec: WishSpec; hit: MenuItem; specRow: { row: NutritionRow; label: string } | null }; choice: ComboSkuInfo['rounds'][0]['choices'][0] }> } | null = null;
    for (const sku of skus) {
      const pool = resolved.filter((r) => r.spec.qty === 1); // 套壳仅接受 qty=1 的心愿（多份走散点更直观）
      const picks: Array<{ roundId: string; used: { wish: string; spec: WishSpec; hit: MenuItem; specRow: { row: NutritionRow; label: string } | null }; choice: ComboSkuInfo['rounds'][0]['choices'][0] }> = [];
      for (const round of sku.rounds) {
        const hitIdx = pool.findIndex((r) => matchChoice(r.hit, round.choices[0]) || round.choices.some((c) => matchChoice(r.hit, c)));
        if (hitIdx < 0) continue;
        const used = pool[hitIdx];
        const choice = round.choices
          .filter((c) => matchChoice(used.hit, c))
          .sort((a, b) => a.diffCents - b.diffCents)[0];
        picks.push({ roundId: round.id, used, choice });
        pool.splice(hitIdx, 1);
      }
      if (picks.length >= 2 && (!best || picks.length > best.picks.length)) best = { sku, picks };
    }

    if (best) {
      coveredWishCount += best.picks.length;
      const diffSum = best.picks.reduce((s, p) => s + p.choice.diffCents, 0);
      const skuLabel = `${best.sku.name}（${best.picks.map((p) => p.used.hit.name).join(' + ')}）`;
      res.items.push({ code: best.sku.code, name: skuLabel, qty: 1, priceCents: best.sku.priceCents + diffSum, isCombo: true, nutritionMatched: true, isBundleItem: true, deconstruction: best.sku.deconstruction });
      cart.push({
        productCode: best.sku.code, quantity: 1,
        roundList: best.picks.map((p) => ({ round: p.roundId, comboItemList: [{ code: p.choice.code, quantity: 1 }] })),
      });
    }

    // 未套壳心愿 → 散点补齐（含 qty>1），与套壳条目一起进入整单购物篮
    const bundled = best ? new Set(best.picks.map((p) => p.used.wish)) : new Set<string>();
    for (const r of resolved) {
      if (bundled.has(r.wish)) continue;
      const hit: MatchResult = { item: r.hit };
      addWishItem(res, hit, r.spec, warnings, r.specRow);
    }
    // 展示原价 = 套壳 SKU 价（含 diffPrice）+ 散点菜单价，作为本轨道分摊基数
    res.originalCents = res.items.reduce((s, i) => s + i.priceCents * i.qty, 0);
    // 散点条目并入整单购物篮（此前仅套壳 SKU 入篮导致整单漏计——2026-10-11 修复；
    // 用 isBundleItem 标记排除套壳条目，避免"散点心愿恰好同 code"时被误跳过）
    for (const i of res.items) {
      if (i.isBundleItem) continue;
      const exist = cart.find((c) => c.productCode === i.code && !c.roundList);
      if (exist) exist.quantity += i.qty;
      else cart.push({ productCode: i.code, quantity: i.qty, roundList: [] });
    }
    members.push(res);
  }

  if (coveredWishCount < 2 || cart.length === 0) return null; // 套壳收益不足，不值得出轨道 2

  const quote = await quoteWithRounds(client, storeCode, cart.map((c) => ({ code: c.productCode, qty: c.quantity, roundList: c.roundList })));
  const menuOriginalCents = members.reduce((s, m) => s + m.originalCents, 0);
  const useQuote = quote != null && quote.priceCents > 0 && quote.priceCents <= menuOriginalCents;
  const paidCents = useQuote ? quote!.priceCents : menuOriginalCents;
  const priceSource: GroupSolution['totals']['priceSource'] = useQuote ? 'calculate-price' : 'menu-price';
  if (!quote || quote.priceCents <= 0) warnings.push('套壳方案计价未返回有效报价，以下按菜单价估算。');
  else if (!useQuote) warnings.push(`套壳计价 ¥${(quote.priceCents / 100).toFixed(1)} 不低于散点菜单价 ¥${(menuOriginalCents / 100).toFixed(1)}，建议采用散点方案。`);

  const totalOriginal = members.reduce((s, m) => s + m.originalCents, 0);
  let assigned = 0;
  members.forEach((m, idx) => {
    const share = idx === members.length - 1 && totalOriginal > 0 ? paidCents - assigned : Math.round((m.originalCents / totalOriginal) * paidCents);
    assigned += share;
    m.shareCents = Math.max(0, share);
    m.payableCents = Math.max(0, m.shareCents - (m.personalCouponCents ?? 0));
    m.savedCents = Math.max(0, m.originalCents - m.shareCents);
  });

  if (members.some((m) => m.unresolvedWishes.length > 0)) {
    warnings.push(`仍有心愿未匹配到菜单品项：${members.filter((m) => m.unresolvedWishes.length > 0).map((m) => `@${m.alias}「${m.unresolvedWishes.join('、')}」`).join('；')}`);
  }

  return {
    store: { storeCode, storeName: input.storeName ?? `门店 ${storeCode}` },
    track: 'bundle',
    trackNote: `轨道 2 · 组合套壳：${coveredWishCount}/${totalWishCount} 个心愿以随心配/组合 SKU 覆盖，其余散点补齐`,
    members,
    orderNotes: [],
    totals: {
      originalCents: menuOriginalCents, paidCents, discountCents: useQuote ? quote!.discountCents : 0,
      priceSource, priceNote: useQuote ? '计价接口（含换选 diffPrice）' : '菜单价估算',
    },
    deliveryFeeCents: 0, warnings, disclaimer: '数据来自麦当劳官方 MCP，仅供参考，实际以门店结算为准。',
  };
}

/** 带换选计价：与 quotePrice 同口径，但透传 roundList；price<=0 视为无效报价（实测无券单点麦咖啡返回 0） */
async function quoteWithRounds(
  client: McpClient,
  storeCode: string,
  items: Array<{ code: string; qty: number; roundList?: Array<{ round: string; comboItemList: Array<{ code: string; quantity: number }> }> }>,
): Promise<{ priceCents: number; discountCents: number; originalCents: number } | null> {
  try {
    const res = await client.call('calculate-price', withOrderParams({
      storeCode, orderType: 1, beType: 1,
      items: items.map((i) => ({ productCode: i.code, quantity: i.qty, ...(i.roundList ? { roundList: i.roundList } : {}) })),
    }));
    const d = res.data as { price?: number; discount?: number; productOriginalPrice?: number };
    if (typeof d?.price !== 'number' || d.price <= 0) return null;
    return { priceCents: d.price, discountCents: d.discount ?? 0, originalCents: d.productOriginalPrice ?? d.price };
  } catch { return null; }
}
