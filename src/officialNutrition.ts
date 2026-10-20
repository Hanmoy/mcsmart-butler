// 官网营养计算器数据库（data/nutrition-official-web.json）
// 来源：mcdonalds.com.cn/nutrition_calculator 页面内嵌数据（2025-04 快照），与 MCP list-nutrition-foods 同源；
// 结构更优：产品 → 规格（小/中/大/1个/2块/5块）两级权威映射，覆盖 MCP 表缺失的奥利奥麦旋风、香芋派、纯悦等。
// 列语义（14 项）：[0]参考重量g [1]能量kJ [2]蛋白质g [3]脂肪g [4]碳水g [5]钠mg ... [13]钙mg
// kcal 换算口径与官网 JS 一致：Math.round(kJ / 4.184)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLayout } from './paths.js';

export interface OfficialNutritionHit {
  productName: string; // 官网产品名
  specTitle: string; // 规格名（小/中/大/1个/2块/5块/默认…）；请求规格可换算时保留**请求规格**
  weightG: number; // 参考重量
  energyKj: number;
  energyKcal: number;
  protein: number;
  fat: number;
  carbohydrate: number;
  sodium: number;
  /** v1.4.5 W02：件数规格换算倍数（请求 4块、官网仅 2块 → 2）；1=未换算 */
  scaleFactor?: number;
  /** 换算口径说明（如「按官网 2块 × 2 换算」）；未换算时缺省 */
  scaleNote?: string;
}

interface OfficialSpec { title: string; nutrition: string[]; nutrition_desc?: string | null; }
interface OfficialProduct { id: string; title: string; ProductType: string[]; }
interface OfficialData {
  category_list: unknown[];
  Product: Record<string, OfficialProduct>;
  ProductType: Record<string, OfficialSpec>;
}

let cache: OfficialData | null = null;
let loadFailed = false; // 读取失败哨兵：避免每次调用重复读盘（仅首次失败时触发一次）

function load(): OfficialData | null {
  if (cache !== null || loadFailed) return cache;
  try {
    // 只读种子数据：路径由安装布局推导（开发=项目 data/，发布包=scripts/data/），不依赖 cwd
    cache = JSON.parse(readFileSync(join(getLayout().seedDataDir, 'nutrition-official-web.json'), 'utf-8')) as OfficialData;
  } catch { cache = null; loadFailed = true; }
  return cache;
}

function normName(s: string): string {
  return s
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/\s+/g, '')
    .replace(/可口可乐/g, '可乐')
    .replace(/（/g, '(')
    .toLowerCase();
}

/** 心愿短语中的规格词 → 官网 ProductType.title（大杯→大、两块→2块、迷你→迷你…）。
 *  注意「一份/一个」是数量词而非规格，不在此处理（qty 已单独提取）。
 *  v1.4.5 W02：券配方常把规格写成裸 token（spec:'小'/'中'/'大'）——旧实现只认「小杯/小薯」，
 *  导致「小薯条 spec=小」回落到官网默认「中」规格（289 kcal 冒充小份 210 kcal）。 */
export function specTitleFromRaw(raw: string): string | null {
  const s = (raw ?? '').replace(/\s+/g, '');
  if (!s) return null;
  // ① 裸规格 token（券配方 spec 字段直接写「小/中/大/迷你」）
  const bare = s.match(/^(迷你|小|中|大)$/);
  if (bare) return bare[1];
  // ② 带单位写法：大杯/中份/小薯/大薯条…
  const sizeM = s.match(/大杯|中杯|小杯|大份|中份|小份|大薯|中薯|小薯|迷你/);
  if (sizeM) return sizeM[0].replace(/杯|份/, '').replace(/薯/, '');
  // ③ 规格词紧邻品名（「无糖中可乐」「大可乐」）：仅当规格字后紧跟已知品名时采信，避免误伤「大脆鸡扒」
  const inlineM = s.match(/(迷你|小|中|大)(?=可乐|雪碧|薯条|咖啡|奶铁|豆浆|美式|红茶|果汁|牛奶|冰茶)/);
  if (inlineM) return inlineM[1];
  // ④ 件数规格（两块 / 4块）
  const pieceM = s.match(/([一二两三四五六七八九十\d]+)\s*块/);
  if (pieceM) {
    const n = ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 } as Record<string, number>)[pieceM[1]] ?? parseInt(pieceM[1], 10);
    if (Number.isFinite(n)) return `${n}块`;
  }
  return null;
}

/** 规格等价判定（v1.4.5 W02）：「1个」与「1份」对单份商品等价；「2块」只与「2块」等价。
 *  规格**不等价即视为未知**，绝不回落到官网默认规格冒充匹配。 */
export function specEquivalent(a: string, b: string): boolean {
  const na = a.replace(/\s+/g, '');
  const nb = b.replace(/\s+/g, '');
  if (na === nb) return true;
  const unit = (t: string) => t.replace(/[个份杯条只支]/g, '');
  return unit(na) === unit(nb) && /^\d+$/.test(unit(na));
}

/** 件数规格解析：「2块」→2；非件数规格→null */
function parsePieces(title: string): number | null {
  const m = title.replace(/\s+/g, '').match(/^(\d+)块$/);
  return m ? parseInt(m[1], 10) : null;
}

function productMatches(itemNameNorm: string, variants: string[], titleNorm: string): 'exact' | 'contains' | null {
  if (itemNameNorm.length < 2) return null; // 过短品名（如「派」）不做产品级匹配，防错配
  if (variants.some((v) => v === titleNorm)) return 'exact';
  if (variants.some((v) => v.length >= 2 && (titleNorm.includes(v) || v.includes(titleNorm)))) return 'contains';
  return null;
}

/** 官网权威营养查找：菜单品项名 + 心愿规格短语 → 命中则返回结构化营养（不命中返回 null，调用方走 fallback） */
export function lookupOfficialNutrition(itemName: string, specRaw: string): OfficialNutritionHit | null {
  const data = load();
  if (!data) return null;
  const nameNorm = normName(itemName);
  const variants = [
    nameNorm,
    nameNorm.replace(/堡(?!包)/g, '汉堡'),
    nameNorm.replace(/美式咖啡|中杯美式|美式/, '美式'),
    nameNorm.replace(/中杯奶铁|奶铁咖啡/, '奶铁'),
    nameNorm.replace(/小杯优品豆浆|小豆浆/, '优品豆浆'),
  ].filter((v) => v.length >= 2);
  const wantNoSugar = /无糖/.test(specRaw);
  const specTitle = specTitleFromRaw(specRaw);
  const product = matchProduct(nameNorm, variants, wantNoSugar, !!specTitle);
  if (!product) return null;

  // 规格级匹配
  const specs = product.ProductType.map((id) => data.ProductType[id]).filter(Boolean);
  if (specs.length === 0) return null;
  let chosen: OfficialSpec | undefined;
  let scale = 1;
  let scaleNote: string | undefined;
  if (specTitle) {
    chosen = specs.find((s) => specEquivalent(specTitle, s.title));
    if (!chosen) {
      // v1.4.5 W02：件数规格可按「每块同口径」整倍数换算（4块 = 2块 × 2）；
      //   非整倍数/倍数过大（如 999块）不换算——视为未知，绝不回落到默认份量。
      const req = parsePieces(specTitle);
      if (req) {
        const base = specs
          .map((s) => ({ s, n: parsePieces(s.title) }))
          .find((x) => x.n !== null && req % x.n === 0 && req / x.n >= 2 && req / x.n <= 8);
        if (base && base.n) {
          chosen = base.s;
          scale = req / base.n;
          scaleNote = `按官网 ${base.s.title} × ${scale} 换算`;
        }
      }
      if (!chosen) {
        // 规格词本就写在产品名里（如「迷你新地」）→ 沿用默认规格；否则明确「规格未知」
        if (!normName(product.title).includes(normName(specTitle))) return null;
      }
    }
  }
  if (!chosen) {
    const defaults = specs.filter((s) => /^(1个|默认|1份)$/.test(s.title));
    if (defaults.length === 1) chosen = defaults[0];
    else if (specs.length === 1) chosen = specs[0];
    else {
      const mid = specs.find((s) => s.title === '中');
      if (mid) chosen = mid; // 多规格未指定（如官网「可乐」小/中/大）→ 按中杯默认，与 MCP 规格策略一致
      else {
        const small = specs.find((s) => s.title === '小');
        if (small) chosen = small;
      }
    }
  }
  if (!chosen) return null;
  const n = chosen.nutrition;
  if (!n || n.length < 6) return null;
  const energyKj = Number(n[1]);
  const scaleField = (v: number): number => (scale === 1 ? v : Math.round(v * scale * 10) / 10);
  return {
    productName: product.title,
    specTitle: specTitle ?? chosen.title,
    weightG: scale === 1 ? (Number(n[0]) || 0) : Math.round((Number(n[0]) || 0) * scale),
    energyKj: scale === 1 ? energyKj : Math.round(energyKj * scale),
    energyKcal: Math.round((energyKj * scale) / 4.184),
    protein: scaleField(Number(n[2]) || 0),
    fat: scaleField(Number(n[3]) || 0),
    carbohydrate: scaleField(Number(n[4]) || 0),
    sodium: scaleField(Number(n[5]) || 0),
    ...(scale !== 1 ? { scaleFactor: scale, ...(scaleNote ? { scaleNote } : {}) } : {}),
  };
}

function matchProduct(nameNorm: string, variants: string[], wantNoSugar: boolean, hasSpecTitle: boolean): OfficialProduct | null {
  const candidates: Array<{ p: OfficialProduct; rank: number }> = [];
  for (const p of Object.values(load()!.Product)) {
    const t = normName(p.title);
    if (wantNoSugar && !/无糖/.test(t)) continue;
    if (!wantNoSugar && /无糖/.test(t) && !/无糖/.test(nameNorm)) continue;
    const rank = productMatches(nameNorm, variants, t);
    if (rank) candidates.push({ p, rank: rank === 'exact' ? 0 : 1 });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.rank - b.rank || normName(a.p.title).length - normName(b.p.title).length);
  return candidates[0].p;
}

/** 官网多规格清单（用于「规格未定，热量未计入」的透明提示） */
export function lookupOfficialSpecs(itemName: string): Array<{ specTitle: string; energyKcal: number }> | null {
  const data = load();
  if (!data) return null;
  const nameNorm = normName(itemName);
  const variants = [nameNorm, nameNorm.replace(/堡(?!包)/g, '汉堡')].filter((v) => v.length >= 2);
  const product = matchProduct(nameNorm, variants, false, false);
  if (!product) return null;
  const specs = product.ProductType.map((id) => data.ProductType[id]).filter(Boolean);
  if (specs.length < 2) return null;
  return specs.map((s) => ({ specTitle: s.title, energyKcal: Math.round(Number(s.nutrition[1]) / 4.184) }));
}
