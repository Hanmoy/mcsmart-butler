// 营养补充层（v1.4.3）：官网营养库未收录品项的可追溯补录。
//
// 背景：官网营养计算器库（data/nutrition-official-web.json，93 产品）未覆盖部分套餐组件。
// 实测：券面主食「双层脆鸡堡」不在库中（库内仅「大脆鸡扒麦满分」含「脆鸡」），
// 导致券槽位营养未知（kcal=0 / matched=false），该券无法参与热量贴合类精算。
//
// 本层提供**带来源与证据的用户层补录**：
//   - 读写在用户数据目录（MCSMART_HOME/nutrition-supplements.json），安装目录只读；
//   - 每条必须带 source（来源）、evidence（证据）、verifiedAt（核验日期），可审计；
//   - 解析顺序：官网权威库优先 → 未命中回落本层 → 仍无则保持「未知」。
//
// 诚实边界：本层是「官网库未收录时」的补录，不用于覆盖官网已收录的权威值；
// 未命中一律返回 matched=false，调用方必须按「未知」处理，不得把 0 当作真实营养。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLayout } from './paths.js';
import { withUserFileLock } from './userFileLock.js';
import { fileStamp, readJsonFile, writeJsonAtomic } from './userStore.js';
import { lookupOfficialNutrition, specTitleFromRaw } from './officialNutrition.js';

/** 录入者类型：agent-vision=智能体识图核验 / user=用户手工 / import=批量导入 */
export type SupplementVerifiedBy = 'agent-vision' | 'user' | 'import' | string;

/** 营养五项（v1.4.4 R04：允许部分已知——未提供的字段即「未知」，绝不以 0 代未知） */
export type NutritionMetric = 'kcal' | 'protein' | 'fat' | 'carbohydrate' | 'sodium';
export const NUTRITION_METRICS: readonly NutritionMetric[] = ['kcal', 'protein', 'fat', 'carbohydrate', 'sodium'];

/** 数值性质：exact=可追溯精确值；estimate=估算/区间/同类参考（仅作参照，不支持严格达标结论） */
export type NutritionValueKind = 'exact' | 'estimate';

/** 估算/区间类表述（v1.4.4 R04）：命中即按估算处理，除非显式标注 valueKind='exact' */
const RE_ESTIMATE_EVIDENCE = /约|大约|估算|估计|区间|范围|同类参考|近似|左右|上下|波动|不等/;

/** 推断数值性质（v1.4.4 R04）：显式 valueKind 优先；否则按证据/份量说明中的估算措辞判定 */
export function inferValueKind(s: Pick<NutritionSupplement, 'valueKind' | 'evidence' | 'servingNote'>): NutritionValueKind {
  if (s.valueKind === 'exact' || s.valueKind === 'estimate') return s.valueKind;
  return RE_ESTIMATE_EVIDENCE.test(`${s.evidence ?? ''} ${s.servingNote ?? ''}`) ? 'estimate' : 'exact';
}

export interface NutritionSupplement {
  id: string;
  /** 品名（归一化匹配主键） */
  name: string;
  /** 匹配别名（去括号/空格/小写后比较） */
  matchNames?: string[];
  /** 规格（如「中」「大」「1个」；缺省=通用，适用于任意规格请求） */
  spec?: string;
  // v1.4.4 R04：五项均可缺省——缺省 = 未知（不得补 0 凑结构）
  kcal?: number;
  protein?: number;
  fat?: number;
  carbohydrate?: number;
  sodium?: number;
  /** 数值性质（缺省时按证据措辞推断，见 inferValueKind） */
  valueKind?: NutritionValueKind;
  /** 逐字段来源（缺省=沿用 source/sourceUrl；用于「具体原始来源与字段对应」） */
  fieldSources?: Partial<Record<NutritionMetric, string>>;
  /** 份量口径（如「每份 105g」「每个 62g」）：核对数值对应的规格，避免跨份量误用 */
  servingNote?: string;
  /** 数据来源（如「麦当劳官网营养计算器」「麦当劳 APP 商品详情页」或平台/出版物名称） */
  source: string;
  /** 来源类别：官方/品牌第一方/第三方数据库/二手文章/用户提交/未知 */
  sourceType?: 'official' | 'brand' | 'third-party' | 'secondary' | 'user' | 'unknown';
  /** 可点击的来源 URL（优先存原始页面，不存搜索结果摘要） */
  sourceUrl?: string;
  /** 证据说明（记录页面字段、每份克重及口径；可审计） */
  evidence: string;
  /** 核验日期（ISO date） */
  verifiedAt: string;
  /** 录入者 */
  verifiedBy?: SupplementVerifiedBy;
}

export type NutritionSourceKind = 'official-web' | 'supplement' | 'none';

export interface ResolvedComponentNutrition {
  kcal: number;
  protein: number;
  fat: number;
  carbohydrate: number;
  sodium: number;
  /** 是否取得可用营养（false 时各值为 0，调用方须按「未知」处理） */
  matched: boolean;
  sourceKind: NutritionSourceKind;
  /** 展示用来源说明（matched=false 时为 undefined） */
  sourceLabel?: string;
  /** 命中的规格名 */
  specTitle?: string;
  /** v1.4.4 R04：未取得可信数值的字段——这些字段的 0 是占位，调用方不得当作真实 0 */
  unknownFields: NutritionMetric[];
  /** v1.4.4 R04：数值性质（official-web 恒为 exact；none 表示未命中） */
  valueKind: NutritionValueKind | 'none';
  /** v1.4.4 R04：是否可支撑**严格达标结论**（估算值或存在未知字段时恒为 false） */
  strictUsable: boolean;
}

/** 该字段是否取得可信数值（v1.4.4 R04：未知字段不得按 0 参与上限/达标判断） */
export function nutritionFieldKnown(n: ResolvedComponentNutrition, m: NutritionMetric): boolean {
  return n.matched && !n.unknownFields.includes(m);
}

// ---------- 名称归一（与 officialNutrition 同口径） ----------

function normName(s: string): string {
  return s
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/\s+/g, '')
    .replace(/可口可乐/g, '可乐')
    .toLowerCase();
}

// ---------- 用户层持久化（读写分离：写只落用户数据目录） ----------

function supplementsFilePath(): string {
  return join(getLayout().userHome, 'nutrition-supplements.json');
}

interface SupplementFile { version: 1; supplements: NutritionSupplement[]; updatedAt: string }

let userCache: SupplementFile | null = null;
let userStamp = '';

/** 直接从磁盘重读（忽略内存缓存）——**每次变更前必须调用**（v1.4.4 R12：跨进程丢更新的修复点） */
function readUserFileFromDisk(): SupplementFile {
  try {
    const p = supplementsFilePath();
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<SupplementFile>;
      return { version: 1, supplements: Array.isArray(raw.supplements) ? raw.supplements : [], updatedAt: raw.updatedAt ?? '' };
    }
  } catch { /* 文件损坏/不存在：按空库处理，保持既有容错口径 */ }
  return { version: 1, supplements: [], updatedAt: '' };
}

/** 只读路径（v1.4.7 R12）：按文件指纹刷新缓存（CLI/Agent 写入后面板无需重启即可见） */
function loadUserFile(): SupplementFile {
  const p = supplementsFilePath();
  const stamp = fileStamp(p);
  if (!userCache || stamp !== userStamp) {
    userCache = readUserFileFromDisk();
    userStamp = stamp;
  }
  return userCache;
}

/** 写前重读：把内存态同步为磁盘最新版本（v1.4.4 R12） */
function reloadUserFile(): SupplementFile {
  userCache = readUserFileFromDisk();
  userStamp = fileStamp(supplementsFilePath());
  return userCache;
}

/** v1.4.7 R13：落盘失败抛 E_STORAGE（不再静默返回成功） */
function flush(): void {
  if (!userCache) return;
  userCache.updatedAt = new Date().toISOString();
  writeJsonAtomic(supplementsFilePath(), userCache);
  userStamp = fileStamp(supplementsFilePath());
}

/** 变更入口：跨进程互斥 → 重读磁盘最新 → 变更 → 原子落盘（v1.4.4 R12） */
function mutateUserFile<T>(mutate: (file: SupplementFile) => T): T {
  return withUserFileLock(supplementsFilePath(), () => {
    const file = reloadUserFile();
    const out = mutate(file);
    flush();
    return out;
  });
}

/** 全部补录条目（用户层） */
export function loadUserNutritionSupplements(): NutritionSupplement[] {
  return loadUserFile().supplements;
}

// ---------- 随包种子层（v1.4.4 R20：审核后公开营养的交付机制） ----------
//
// 背景（评审 R20 交付漂移）：已核验的公开营养此前只存在于**某台机器的用户库**里——
//   空 MCSMART_HOME 的纯净安装全部未知，同版本旧包也不含新配方。
// 机制：随包只读种子 data/nutrition-seed.json（版本化、可审计、随包升级）→ 用户层覆盖。
//   - 只交付**审核通过的公开来源条目**；绝不把本机用户库整体随包复制；
//   - 用户层同 id 覆盖种子（用户可自行修订）；种子条目不可从面板删除（删除只作用于用户层）；
//   - 种子文件缺失/损坏 → 按空种子处理，不影响用户层（诚实降级）。
interface SeedFile { version: 1; updatedAt: string; source?: string; entries: NutritionSupplement[] }

let seedCache: SeedFile | null = null;

function loadSeedFile(): SeedFile {
  if (seedCache) return seedCache;
  try {
    const p = join(getLayout().seedDataDir, 'nutrition-seed.json');
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<SeedFile>;
      const entries = (Array.isArray(raw.entries) ? raw.entries : [])
        .filter((s) => !!s && typeof s.name === 'string' && validateNutritionSupplement(s))
        .map((s) => ({ ...s, id: s.id || supplementId(s.name, s.spec), valueKind: s.valueKind ?? inferValueKind(s) }));
      seedCache = { version: 1, updatedAt: raw.updatedAt ?? '', ...(raw.source ? { source: raw.source } : {}), entries };
      return seedCache;
    }
  } catch { /* 种子损坏/缺失：按空种子处理 */ }
  seedCache = { version: 1, updatedAt: '', entries: [] };
  return seedCache;
}

/** 补录条目的来源层（供面板/报告区分「随包种子」与「本机用户」） */
export type SupplementOrigin = 'seed' | 'user';
export type SupplementView = NutritionSupplement & { origin: SupplementOrigin };

/** 种子 + 用户层合并视图（用户层同 id 覆盖种子）。解析与列表展示统一走这里。 */
export function allSupplements(): SupplementView[] {
  const user = loadUserFile().supplements;
  const userIds = new Set(user.map((s) => s.id));
  const seed = loadSeedFile().entries.filter((s) => !userIds.has(s.id)).map((s) => ({ ...s, origin: 'seed' as const }));
  return [...seed, ...user.map((s) => ({ ...s, origin: 'user' as const }))];
}

/** 全部生效补录条目（种子 ∪ 用户） */
export function loadNutritionSupplements(): NutritionSupplement[] {
  return allSupplements();
}

/** 生成稳定的补录 id（同名同规格幂等覆盖） */
export function supplementId(name: string, spec?: string): string {
  return `sup-${normName(name)}${spec ? `-${normName(spec)}` : ''}`;
}

// ---------- 匹配 ----------

interface Scored { s: NutritionSupplement; score: number }

function matchSupplement(supplements: NutritionSupplement[], name: string, specTitle?: string): NutritionSupplement | null {
  const nameNorm = normName(name);
  if (!nameNorm) return null; // 空名不匹配
  const hits: Scored[] = [];
  for (const s of supplements) {
    const names = [s.name, ...(s.matchNames ?? [])].map(normName).filter((n) => n !== '');
    let nameScore = -1;
    if (names.includes(nameNorm)) nameScore = 0;
    // v1.4.3 修正：短名防护只对**模糊包含**生效。原先对整体 nameNorm 施加 length>=2 门槛，
    //   导致「派」这类单字品项即使补录层显式声明了精确别名（matchNames:["派"]）也永远匹配不上，
    //   使「派派四重奏（派×4）」因「固定品项未解析到营养来源」被拒。
    //   精确同名（names.includes）不存在错配风险，任何长度都应命中；
    //   模糊包含才需要双向 length>=2（防「派」被「香芋派/菠萝派」误吸）。
    else if (nameNorm.length >= 2 && names.some((n) => n.length >= 2 && (nameNorm.includes(n) || n.includes(nameNorm)))) nameScore = 2;
    if (nameScore < 0) continue;
    // 规格匹配：补录指定了规格时，请求规格必须一致；请求无规格则允许（降权）
    const supSpec = s.spec ? normName(s.spec) : '';
    const reqSpec = specTitle ? normName(specTitle) : '';
    if (supSpec && reqSpec && supSpec !== reqSpec && !reqSpec.includes(supSpec) && !supSpec.includes(reqSpec)) continue;
    const specPenalty = supSpec && !reqSpec ? 1 : 0;
    hits.push({ s, score: nameScore + specPenalty });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.score - b.score);
  return hits[0].s;
}

/** 按名称（可选规格）查补录条目（种子 ∪ 用户层，用户层同 id 覆盖种子） */
export function lookupSupplement(name: string, specTitle?: string): NutritionSupplement | null {
  return matchSupplement(allSupplements(), name, specTitle);
}

// ---------- 统一解析（官网权威库优先 → 补录回落 → 未知） ----------

/**
 * 解析一个套餐组件/食品的营养。
 * @param name 品名
 * @param specRaw 规格原始短语（如「大薯条」；缺省回落到 name，与既有调用口径一致）
 */
export function resolveComponentNutrition(name: string, specRaw: string = name): ResolvedComponentNutrition {
  const official = lookupOfficialNutrition(name, specRaw);
  if (official) {
    return {
      kcal: official.energyKcal, protein: official.protein, fat: official.fat,
      carbohydrate: official.carbohydrate, sodium: official.sodium,
      matched: true, sourceKind: 'official-web',
      sourceLabel: `官网营养计算器（${official.productName}·${official.specTitle}`
        + `${official.scaleNote ? `，${official.scaleNote}` : ''}）`,
      specTitle: official.specTitle,
      unknownFields: [], valueKind: 'exact', strictUsable: true,
    };
  }
  const cleanedSpec = specRaw ? specRaw.replace(name, '').trim() : '';
  const specTitle = specTitleFromRaw(specRaw) ?? (cleanedSpec ? cleanedSpec : (specRaw !== name ? specRaw : undefined));
  const sup = lookupSupplement(name, specTitle ?? undefined);
  if (sup) {
    const kind = inferValueKind(sup);
    // v1.4.4 R04：未提供的字段是「未知」，不是 0——显式记入 unknownFields，调用方须按未知处理；
    //   估算/区间类记录保留为参考，但不得成为「完整营养」或严格达标依据。
    const unknownFields = NUTRITION_METRICS.filter((m) => typeof sup[m] !== 'number' || !Number.isFinite(sup[m] as number));
    const estimate = kind === 'estimate';
    const notes: string[] = [];
    if (estimate) notes.push('估算值，仅供参照，不作为严格达标依据');
    if (unknownFields.length) notes.push(`未收录字段 ${unknownFields.join('/')}，按未知处理`);
    return {
      kcal: sup.kcal ?? 0, protein: sup.protein ?? 0, fat: sup.fat ?? 0,
      carbohydrate: sup.carbohydrate ?? 0, sodium: sup.sodium ?? 0,
      matched: true, sourceKind: 'supplement',
      sourceLabel: `补录营养（${sup.sourceType ?? '来源类别未标注'}：${sup.source}`
        + `${sup.verifiedAt ? `，核验 ${sup.verifiedAt}` : ''}${sup.servingNote ? `，份量 ${sup.servingNote}` : ''}`
        + `${sup.sourceUrl ? `，来源页 ${sup.sourceUrl}` : ''}）`
        + (notes.length ? `［${notes.join('；')}］` : ''),
      specTitle: sup.spec,
      unknownFields,
      valueKind: kind,
      // 估算值 / 存在未知字段 → 不支持严格达标结论
      strictUsable: !estimate && unknownFields.length === 0,
    };
  }
  return {
    kcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0,
    matched: false, sourceKind: 'none',
    unknownFields: [...NUTRITION_METRICS], valueKind: 'none', strictUsable: false,
  };
}

// ---------- 录入 / 导入 / 删除 ----------

function validateNutritionSupplement(s: Partial<NutritionSupplement>): s is NutritionSupplement {
  const sourceTypes: readonly string[] = ['official', 'brand', 'third-party', 'secondary', 'user', 'unknown'];
  // v1.4.4 R04：允许部分字段已知——至少提供一项；已提供的必须是非负有限数。
  //   禁止为满足结构把未知补成 0（旧实现要求五项齐全，等于逼用户编造数值）。
  const provided = NUTRITION_METRICS.map((m) => s[m]).filter((v) => v !== undefined);
  const fieldsOk = provided.length > 0
    && provided.every((v) => typeof v === 'number' && Number.isFinite(v) && (v as number) >= 0);
  const kindOk = s.valueKind === undefined || s.valueKind === 'exact' || s.valueKind === 'estimate';
  const fieldSourcesOk = s.fieldSources === undefined
    || (typeof s.fieldSources === 'object' && s.fieldSources !== null
      && Object.entries(s.fieldSources).every(([k, v]) => NUTRITION_METRICS.includes(k as NutritionMetric) && typeof v === 'string' && v.trim() !== ''));
  const servingOk = s.servingNote === undefined || (typeof s.servingNote === 'string' && s.servingNote.trim() !== '');
  return typeof s.name === 'string' && s.name.trim() !== ''
    && fieldsOk && kindOk && fieldSourcesOk && servingOk
    && typeof s.source === 'string' && s.source.trim() !== ''
    && typeof s.evidence === 'string' && s.evidence.trim() !== ''
    && typeof s.verifiedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.verifiedAt)
    && (s.sourceType === undefined || sourceTypes.includes(s.sourceType))
    && (s.sourceUrl === undefined || /^https?:\/\//i.test(s.sourceUrl));
}

/** 录入或修订（同 id 覆盖）；至少一项营养 + 来源/证据/日期齐备；数值性质与份量随记录保存 */
export function saveNutritionSupplement(s: NutritionSupplement): void {
  if (!validateNutritionSupplement(s)) {
    throw new Error('营养补录至少需提供一项非负有限的营养数值（kcal/蛋白质/脂肪/碳水/钠），并填写来源、证据与 YYYY-MM-DD 核验日期；未知项请留空，不要填 0');
  }
  // 数值性质在写入时固化（估算/精确），读路径对旧记录仍按证据措辞推断（inferValueKind）
  const rec: NutritionSupplement = {
    ...s,
    id: s.id || supplementId(s.name, s.spec),
    valueKind: s.valueKind ?? inferValueKind(s),
  };
  mutateUserFile((file) => {
    const idx = file.supplements.findIndex((x) => x.id === rec.id);
    if (idx >= 0) file.supplements[idx] = rec; else file.supplements.push(rec);
  });
}

/** 批量导入（数组或 {supplements:[...] }；非法/不完整项跳过并计数，绝不默认未知营养为 0） */
export function importNutritionSupplements(input: unknown): { imported: number; skipped: number } {
  const arr = Array.isArray(input)
    ? input
    : (input && typeof input === 'object' && Array.isArray((input as { supplements?: unknown[] }).supplements)
      ? (input as { supplements: unknown[] }).supplements : null);
  if (!arr) return { imported: 0, skipped: 0 };
  let imported = 0, skipped = 0;
  mutateUserFile((file) => {
    for (const raw of arr) {
      const r = raw as Partial<NutritionSupplement>;
      if (!r || !validateNutritionSupplement(r)) { skipped++; continue; }
      const rec: NutritionSupplement = {
        ...r,
        id: typeof r.id === 'string' && r.id ? r.id : supplementId(r.name, r.spec),
        name: r.name,
        kcal: r.kcal, protein: r.protein, fat: r.fat, carbohydrate: r.carbohydrate, sodium: r.sodium,
        valueKind: r.valueKind ?? inferValueKind(r),
        fieldSources: r.fieldSources, servingNote: r.servingNote,
        source: r.source, evidence: r.evidence, verifiedAt: r.verifiedAt,
        verifiedBy: r.verifiedBy ?? 'import',
      };
      const idx = file.supplements.findIndex((x) => x.id === rec.id);
      if (idx >= 0) file.supplements[idx] = rec; else file.supplements.push(rec);
      imported++;
    }
  });
  return { imported, skipped };
}

/** 删除补录（返回是否命中） */
/** 删除**用户层**补录条目。随包种子条目不可删除（返回 false，调用方据此给出明确提示）；
 *  如需停用种子条目，请保存同 id 的用户层条目覆盖之。 */
export function removeNutritionSupplement(id: string): boolean {
  return mutateUserFile((file) => {
    const idx = file.supplements.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    file.supplements.splice(idx, 1);
    return true;
  });
}

/** 该 id 是否为随包种子条目（面板/CLI 用于给出「种子不可删除」的明确提示） */
export function isSeedSupplement(id: string): boolean {
  return loadSeedFile().entries.some((s) => s.id === id);
}

/** 测试钩子：清空内存缓存（隔离测试用） */
export function _resetSupplementCache(): void { userCache = null; seedCache = null; }
