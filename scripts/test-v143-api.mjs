// v1.4.3 面板 API 静态契约检查。运行：node scripts/test-v143-api.mjs
// server.ts 底部会自动监听，因此此测试不直接导入服务进程。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v143-api-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const here = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(here, '..', 'src', 'server.ts'), 'utf8');
const gate = server.indexOf("const client = requireClient();");
assert.ok(gate > 0, '业务 Token gate 存在');

const endpoints = [
  "url.pathname === '/api/recipes'",
  "url.pathname === '/api/recipes/verify'",
  "url.pathname === '/api/recipes/import'",
  "^\\/api\\/recipes\\/[^/]+$",
  "url.pathname === '/api/nutrition-supplements'",
  "url.pathname === '/api/nutrition-supplements/import'",
  "^\\/api\\/nutrition-supplements\\/[^/]+$",
  "url.pathname === '/api/nutrition/resolve'",
];
for (const endpoint of endpoints) {
  const at = server.indexOf(endpoint);
  assert.ok(at >= 0 && at < gate, `${endpoint} 位于 Token gate 之前`);
}
const menuCandidates = server.indexOf("url.pathname === '/api/recipes/menu-candidates'");
assert.ok(menuCandidates > gate, '当前门店官方菜单候选 API 位于 Token gate 之后');
assert.ok(server.slice(menuCandidates).includes('loadMenuItems(client, storeCode'), '菜单候选从用户选择门店实时/快照菜单加载');

const recipesStart = server.indexOf("if (req.method === 'GET' && url.pathname === '/api/recipes')");
const recipesEnd = server.indexOf('// 粘贴文本规则解析', recipesStart);
const recipeRoutes = server.slice(recipesStart, recipesEnd);
assert.ok(recipeRoutes.includes('validateRecipe(parsed.recipe)'), 'verify 路由调用配方核验');
assert.ok(recipeRoutes.includes('check.blocking.length > 0 && !force'), '阻断项默认阻止配方落盘');
assert.ok(recipeRoutes.includes('强制写入（未解决核验阻断项'), '强制写入原因记录到 evidence');
assert.ok(recipeRoutes.includes('PRESET_RECIPES.some'), '预置配方不可删除');
assert.ok(recipeRoutes.includes('loadRecipes()'), '配方列表读取预置与用户层合并结果');
assert.ok(server.includes("from './recipeSchema.js'") && server.includes('normalizeRecipeInputShared(value, { strict: true })'),
  '配方 API 与 CLI 共用 recipeSchema 校验（productViewSign/skuViewId 类型、商品身份数组与 headUrl 校验同源，v1.4.7 R04）');
assert.ok(recipeRoutes.includes('normalizeRecipe('), '配方路由统一走共享规范化入口');
const schema = readFileSync(join(here, '..', 'src', 'recipeSchema.ts'), 'utf8');
assert.ok(schema.includes('headUrl 必须是 http(s) URL'), '配方 schema 限定 headUrl 为 http(s)');
assert.ok(schema.includes('productViewSigns') && schema.includes('skuViewIds'), '配方 schema 保留商品身份数组（v1.4.7 R04）');
assert.ok(schema.includes("...(typeof raw.productViewSign === 'string' ? { productViewSign: raw.productViewSign.trim() } : {})"), 'schema 透传 productViewSign');
assert.ok(schema.includes("...(typeof raw.skuViewId === 'string' ? { skuViewId: raw.skuViewId.trim() } : {})"), 'schema 透传 skuViewId（与 productViewSign 独立）');
assert.ok(schema.includes('productViewSigns ? { productViewSigns }') && schema.includes('skuViewIds ? { skuViewIds }'), 'schema 透传商品身份数组');

const nutritionStart = server.indexOf("url.pathname === '/api/nutrition-supplements'");
const nutritionEnd = server.indexOf('// 粘贴文本规则解析', nutritionStart);
const nutritionRoutes = server.slice(nutritionStart, nutritionEnd);
for (const required of ['kcal', 'protein', 'fat', 'carbohydrate', 'sodium', 'source', 'evidence', 'verifiedAt', 'sourceType', 'sourceUrl']) {
  assert.ok(server.includes(`value.${required}`), `营养补录校验/透传 ${required}`);
}
assert.ok(nutritionRoutes.includes('importNutritionSupplements(accepted)'), '批量写入只接收通过严格校验的营养项');
assert.ok(nutritionRoutes.includes('resolveComponentNutrition(name, spec)'), 'resolve 路由调用营养解析');
assert.ok(server.includes('size > 64 * 1024'), '请求体限制 64KB');
assert.ok(server.includes("throw new ApiError(400, '请求体必须是有效 JSON')"), '非法 JSON 返回 400');
assert.ok(server.includes("new ApiError(413, '请求体过大（上限 64KB）'"), '超限请求返回 413');

console.log('v1.4.3 面板 API 静态契约检查通过');
