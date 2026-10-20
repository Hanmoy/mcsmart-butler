// 营养数据解析：list-nutrition-foods 返回自描述表格字符串
// 格式: "[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  名称,null,1288,308,16,16,24,781,213\n..."
export interface NutritionRow {
  productName: string;
  energyKj: number;
  energyKcal: number;
  protein: number;
  fat: number;
  carbohydrate: number;
  sodium: number;
  calcium: number;
}

export function parseNutritionTable(raw: string | undefined): Map<string, NutritionRow> {
  const map = new Map<string, NutritionRow>();
  if (!raw) return map;
  // rawText 中「Original Response」是内嵌 JSON 字符串，换行为字面 \n 转义，需先还原
  const text = raw.replace(/\\n/g, '\n').replace(/\\t/g, ' ');
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s{1,4}(.+?),([^,]*),(-?\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+)\s*$/);
    if (!m) continue;
    const row: NutritionRow = {
      productName: m[1].trim(),
      energyKj: +m[3],
      energyKcal: +m[4],
      protein: +m[5],
      fat: +m[6],
      carbohydrate: +m[7],
      sodium: +m[8],
      calcium: +m[9],
    };
    if (!map.has(row.productName)) map.set(row.productName, row); // 去重（早餐/正餐同品名重复出现）
  }
  return map;
}

/** 名称归一：去括注、去引号与空白，便于别名匹配（例：「浓浓黑巧（冰/热）」→「浓浓黑巧」） */
export function normalizeName(name: string): string {
  return name
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/[“”"'「」]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/** 名称匹配：精确 → 归一精确 → 归一包含（仅在唯一命中时采用，避免「燕麦奶铁」错配到「大杯」规格） */
export function matchNutrition(name: string, table: Map<string, NutritionRow>): NutritionRow | undefined {
  if (table.has(name)) return table.get(name);
  const norm = normalizeName(name);
  if (table.has(norm)) return table.get(norm);
  for (const [k, v] of table) if (normalizeName(k) === norm) return v;
  const cands: NutritionRow[] = [];
  for (const [k, v] of table) {
    const nk = normalizeName(k);
    if (nk.includes(norm) || norm.includes(nk)) cands.push(v);
  }
  return cands.length === 1 ? cands[0] : undefined; // 多候选 = 规格不明，跳过而非猜测
}
