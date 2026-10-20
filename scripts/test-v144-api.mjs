// v1.4.4 面板 API 行为回归（R05 / R04+R11 / R03）
// 运行：npm test 或 node scripts/test-v144-api.mjs（需先 tsc）
//
//   R05 营养表单留空不得被 Number('') 静默落成 0：空串/空白/非法值必须拒收且不落库；
//       真实 0 在完整五项齐备时允许保存。未知钠必须被标为未知，不能冒充低钠。
//   R04 部分字段已知的记录：解析结果须显式列出 unknownFields，且 strictUsable=false。
//   R03 配方匹配尊重商品身份与城市范围：同名不同 productViewSign/skuViewId 或不同城市不得串用。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v144-api-'));
process.env.MCSMART_HOME = HOME; // 本进程内直接 import dist 模块时也要指向同一隔离数据目录
const PORT = 18981;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (cond, label) => { if (cond) console.log(`  ✓ ${label}`); else { console.error(`  ✗ ${label}`); failures++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, [join(ROOT, 'dist', 'server.js')], {
  cwd: ROOT, env: { ...process.env, MCSMART_HOME: HOME, PORT: String(PORT), MCD_MCP_TOKEN: 'stub-token-1234567890' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const cleanup = () => { try { child.kill('SIGKILL'); } catch { /* */ } try { rmSync(HOME, { recursive: true, force: true }); } catch { /* */ } };
process.on('exit', cleanup);

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return true; } catch { /* */ }
    await sleep(150);
  }
  return false;
}
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const getJson = async (path) => (await fetch(`${base}${path}`)).json();

try {
  const up = await waitUp();
  check(up, '面板本机服务已启动（真实 HTTP）');
  if (!up) throw new Error('服务未启动：' + log.slice(0, 400));

  // ---------- R05 ----------
  console.log('【R05】营养补录：空串 / 空白 / 非法值不得被当成 0 落库；真实 0 需完整齐备');
  const baseRec = { name: '审查测试食品', source: '测试来源', evidence: '证据', verifiedAt: '2026-10-16' };
  const emptyKcal = await post('/api/nutrition-supplements', { ...baseRec, kcal: '', protein: 1, fat: 1, carbohydrate: 1, sodium: 1 });
  check(emptyKcal.status === 400, `空串热量被拒（实际 ${emptyKcal.status}）`);
  check((await emptyKcal.json())?.code === 'E_INPUT_INVALID', '返回 E_INPUT_INVALID');
  const blankSodium = await post('/api/nutrition-supplements', { ...baseRec, kcal: 300, protein: 1, fat: 1, carbohydrate: 1, sodium: '   ' });
  check(blankSodium.status === 400, `纯空白钠被拒（实际 ${blankSodium.status}）`);
  const badNum = await post('/api/nutrition-supplements', { ...baseRec, kcal: 'abc', protein: 1, fat: 1, carbohydrate: 1, sodium: 1 });
  check(badNum.status === 400, `非法数值被拒（实际 ${badNum.status}）`);
  const negNum = await post('/api/nutrition-supplements', { ...baseRec, kcal: -5, protein: 1, fat: 1, carbohydrate: 1, sodium: 1 });
  check(negNum.status === 400, `负数被拒（实际 ${negNum.status}）`);

  const listAfterReject = await getJson('/api/nutrition-supplements?q=' + encodeURIComponent('审查测试食品'));
  check((listAfterReject.supplements ?? []).length === 0, '被拒的补录未落库（不存在「审查测试食品」）');

  const realZero = await post('/api/nutrition-supplements', { ...baseRec, kcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0 });
  check(realZero.status === 200, `完整五项的真实 0 允许保存（实际 ${realZero.status}）`);
  const listZero = await getJson('/api/nutrition-supplements?q=' + encodeURIComponent('审查测试食品'));
  check((listZero.supplements ?? []).length === 1 && listZero.supplements[0].kcal === 0, '真实 0 记录正确落库（kcal=0）');

  // ---------- R04 / R11：部分字段已知 → 未知显式化，strictUsable=false ----------
  console.log('【R04/R11】部分字段已知：未知字段显式列出，不得支撑严格达标（未知钠不冒充低钠）');
  const NS = await import(pathToFileURL(join(ROOT, 'dist', 'nutritionSupplements.js')).href);
  const { resolveComponentNutrition } = NS;
  NS._resetSupplementCache();
  const partial = resolveComponentNutrition('审查测试食品');
  check(partial.matched === true && partial.kcal === 0, '命中补录且热量取记录值');
  check(Array.isArray(partial.unknownFields) && partial.unknownFields.length === 0, '完整五项记录无未知字段');
  check(partial.strictUsable === true, '完整且非估算 → strictUsable=true');
  // 随包种子：公开参考值按估算交付
  const seedEntry = resolveComponentNutrition('灰焰圆筒');
  check(seedEntry.matched === true && seedEntry.kcal === 110, `随包种子条目命中（kcal=${seedEntry.kcal}）`);
  check(seedEntry.valueKind === 'estimate', '公开参考值按估算交付（valueKind=estimate）');
  // 仅热量已知的记录（程序化/种子层允许部分字段）→ 未知字段显式化
  NS.saveNutritionSupplement({ id: 'sup-partial-only', name: '仅热量已知食品', kcal: 200, source: '测试来源', evidence: '仅核验了热量', verifiedAt: '2026-10-16' });
  NS._resetSupplementCache();
  const partialOnly = resolveComponentNutrition('仅热量已知食品');
  check(partialOnly.matched === true && partialOnly.kcal === 200, '部分字段记录可命中且热量可用');
  check(partialOnly.unknownFields.includes('sodium'), '未收录的钠被显式列为未知（不得冒充低钠）');
  check(partialOnly.unknownFields.includes('protein') && partialOnly.unknownFields.includes('fat'), '未收录的蛋白质/脂肪同样列为未知');
  check(partialOnly.strictUsable === false, '含未知字段 → strictUsable=false（不得支撑严格达标）');

  // ---------- R03：商品身份与城市范围 ----------
  console.log('【R03】配方匹配尊重商品身份与城市范围：同名不同 ID / 不同城市不得串用');
  const VR = await import(pathToFileURL(join(ROOT, 'dist', 'voucherRecipes.js')).href);
  VR.saveRecipe({
    id: 'rcp-r03-city-sh', name: '城市限定券', matchNames: ['城市限定券'],
    resolve: 'explicit', channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'fixed', keyword: '巨无霸', qty: 1 }], conditions: { orderType: 'instore' },
    priceCents: 1000, originalPriceCents: 0, buyPath: 'x', redeemPath: 'y',
    evidence: 'e2e', verifiedAt: '2026-10-16', ruleVersion: 'v1',
    productViewSign: 'SIGN-SH', scope: { city: '上海' },
  });
  VR.saveRecipe({
    id: 'rcp-r03-generic', name: '城市限定券', matchNames: ['城市限定券'],
    resolve: 'explicit', channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'fixed', keyword: '巨无霸', qty: 1 }], conditions: { orderType: 'instore' },
    priceCents: 1000, originalPriceCents: 0, buyPath: 'x', redeemPath: 'y',
    evidence: 'e2e', verifiedAt: '2026-10-16', ruleVersion: 'v1',
  });
  const inSh = VR.matchRecipeCandidates('城市限定券', undefined, { productViewSign: 'SIGN-SH', city: '上海' });
  check(inSh.some((r) => r.id === 'rcp-r03-city-sh'), '上海 + 匹配商品 ID → 命中城市限定配方');
  const inBj = VR.matchRecipeCandidates('城市限定券', undefined, { productViewSign: 'SIGN-SH', city: '北京' });
  check(!inBj.some((r) => r.id === 'rcp-r03-city-sh'), '北京 → 排除上海限定配方（城市范围生效）');
  check(inBj.some((r) => r.id === 'rcp-r03-generic'), '北京 → 仍可命中无范围限定的同名配方');
  const wrongSign = VR.matchRecipeCandidates('城市限定券', undefined, { productViewSign: 'SIGN-BJ', city: '上海' });
  check(!wrongSign.some((r) => r.id === 'rcp-r03-city-sh'), '商品 ID 不一致 → 排除（同名不同 ID 不串用）');

  // ---------- UI-4：配方导入预览必须如实标注状态，且预览只读 ----------
  console.log('【UI-4】导入预览：标记估算/冲突/结构错误；只允许安全项进入确认发布');
  const previewBase = {
    id: 'rcp-preview-estimated', name: '预览状态券', matchNames: ['预览状态券'],
    resolve: 'explicit', channel: 'meituan', channelLabel: '美团团购（到店）',
    items: [{ mode: 'fixed', keyword: '灰焰圆筒', qty: 1 }], conditions: { orderType: 'instore' },
    priceCents: 800, originalPriceCents: 1200, buyPath: '测试购买路径', redeemPath: '测试核销路径',
    evidence: '导入预览测试', verifiedAt: '2026-10-16', ruleVersion: 'test-v1', scope: { city: '上海' },
  };
  const beforePreview = await getJson('/api/recipes?q=' + encodeURIComponent('预览状态券'));
  const previewResponse = await post('/api/recipes/import/preview', [
    previewBase,
    { ...previewBase, id: 'rcp-preview-conflict', items: [{ mode: 'combo-ref', keyword: '不同套餐', comboName: '不同套餐', qty: 1 }] },
    { id: '', name: '无效条目' },
  ]);
  const previewData = await previewResponse.json();
  check(previewResponse.status === 200, `只读预览请求成功（${previewResponse.status}）`);
  check(previewData.items?.[0]?.ok === true && previewData.items[0].publishable === true, '校验通过且无冲突的估算营养条目可进入待确认列表');
  check(previewData.items?.[0]?.nutritionMissing?.some((x) => x.estimated) === true, '预览明确标记估算营养值，不把它伪装成精确值');
  check(previewData.items?.[1]?.ok === true && previewData.items[1].conflicts.length === 1 && !previewData.items[1].publishable,
    '相同券名但构成不同被标冲突且不可发布');
  check(previewData.items?.[2]?.ok === false && previewData.blocked === 1, '结构错误条目被单独标记为阻断');
  const afterPreview = await getJson('/api/recipes?q=' + encodeURIComponent('预览状态券'));
  check((beforePreview.recipes ?? []).length === (afterPreview.recipes ?? []).length && (afterPreview.recipes ?? []).length === 0,
    '只读预览不写入配方库');
  const published = await post('/api/recipes/import', previewData.publishableRecipes);
  const publishedData = await published.json();
  const afterPublish = await getJson('/api/recipes?q=' + encodeURIComponent('预览状态券'));
  check(published.status === 200 && publishedData.imported === 1 && afterPublish.recipes?.length === 1,
    '确认后原子路径仅接收预览标为可发布的安全项');
} catch (e) {
  check(false, `执行异常：${e instanceof Error ? e.message : String(e)}`);
} finally {
  cleanup();
}

console.log(failures === 0 ? '\nv1.4.4 面板 API 行为回归全部通过 ✓' : `\n${failures} 项未通过 ✗`);
process.exitCode = failures === 0 ? 0 : 1;
