// v1.4.4 交付与持久化回归（R12 / R16 / R20）
// 运行：npm test 或 node scripts/test-v144-delivery.mjs（需先 tsc）
//
//   R12 跨进程交替写库：面板与 CLI 交替写配方库/营养库不得静默丢记录
//   R16 核验时效：同一记录在实时 / 缓存 / 降级三路径状态一致
//   R20 交付机制：纯净安装可解析随包种子；用户层可覆盖；待核验/冲突条目不得随包交付
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v144-delivery-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

let failures = 0;
const check = (cond, label) => { if (cond) console.log(`  ✓ ${label}`); else { console.error(`  ✗ ${label}`); failures++; } };

// ---------- R12 跨进程交替写库 ----------
console.log('【R12】面板与 CLI 交替写库不丢记录（真实跨进程）');
{
  const env = { ...process.env, MCSMART_HOME: TEST_HOME };
  // 每个子进程独立加载模块（独立内存缓存）→ 模拟「面板」与「CLI」两个长期驻留进程
  const recipesUrl = pathToFileURL(join(ROOT, 'dist', 'voucherRecipes.js')).href;
  const writeRecipe = (id, name) => spawnSync(process.execPath, ['-e', `
    const m = await import('${recipesUrl}');
    m.saveRecipe({ id: '${id}', name: '${name}', matchNames: ['${name}'], resolve: 'explicit',
      channel: 'meituan', channelLabel: '美团团购（到店）',
      items: [{ mode: 'fixed', keyword: '巨无霸', qty: 1 }],
      conditions: { orderType: 'instore' }, priceCents: 1000, originalPriceCents: 0,
      buyPath: 'x', redeemPath: 'y', evidence: 'e2e', verifiedAt: '2026-10-16', ruleVersion: 'v1' });
  `], { env, encoding: 'utf-8' });
  // 交替写：面板(A) → CLI(B) → 面板(C)。旧实现的面板内存缓存会把 CLI 的 B 覆盖掉。
  const r1 = writeRecipe('e2e-A', '端到端甲');
  const r2 = writeRecipe('e2e-B', '端到端乙');
  const r3 = writeRecipe('e2e-C', '端到端丙');
  if (r1.status !== 0 || r2.status !== 0 || r3.status !== 0) {
    check(false, `子进程写入失败：${(r1.stderr || r2.stderr || r3.stderr || '').slice(0, 300)}`);
  } else {
    const mod = await import('../dist/voucherRecipes.js');
    const ids = new Set(mod.loadRecipes().map((r) => r.id));
    check(ids.has('e2e-A') && ids.has('e2e-B') && ids.has('e2e-C'), `三条交替写入记录全部保留（A=${ids.has('e2e-A')} B=${ids.has('e2e-B')} C=${ids.has('e2e-C')}）`);
  }
}

// ---------- R16 核验时效三路径一致 ----------
console.log('【R16】配方核验时效在实时 / 缓存 / 降级三路径一致');
{
  const { mergeDealVerification, isVerifyFresh } = await import('../dist/catalog.js');
  const STALE = '2020-01-01';
  const FRESH = new Date().toISOString().slice(0, 10);
  const NAME = '巨无霸三件套';
  const CONTENTS = [{ mode: 'combo-ref', keyword: 'C2', qty: 1, comboName: '巨无霸四件套' }];
  const mkVerify = (at) => ({ status: 'pattern-verified', source: 'recipe', ruleVersion: 'recipe-v1', verifiedAt: at });
  const mkOld = (at) => ({ sign: 'PVS1', name: NAME, priceCents: 3750, poiName: 'P', admitted: true, contents: CONTENTS, verify: mkVerify(at) });

  check(isVerifyFresh(mkVerify(STALE)) === false, '过期证据 isVerifyFresh=false（2020）');
  check(isVerifyFresh(mkVerify(FRESH)) === true, '新鲜证据 isVerifyFresh=true（今日）');

  const onlineStale = mergeDealVerification(undefined, { name: NAME, attempted: true, verify: mkVerify(STALE), contents: CONTENTS });
  const offlineStale = mergeDealVerification(mkOld(STALE), { name: NAME, attempted: false });
  check(onlineStale.admitted === false, `实时路径：过期证据不得准入（admitted=${onlineStale.admitted}）`);
  check(offlineStale.admitted === false && offlineStale.inherited === false, `降级/缓存路径：过期证据不得准入（admitted=${offlineStale.admitted}）`);
  check(onlineStale.admitted === offlineStale.admitted, '实时与降级路径结论一致（同一记录）');
  check(onlineStale.verify?.lastSuccessAt === STALE, `查询成功不刷新内容证据（lastSuccessAt=${onlineStale.verify?.lastSuccessAt}）`);

  const onlineFresh = mergeDealVerification(undefined, { name: NAME, attempted: true, verify: mkVerify(FRESH), contents: CONTENTS });
  const offlineFresh = mergeDealVerification(mkOld(FRESH), { name: NAME, attempted: false });
  check(onlineFresh.admitted === true, '实时路径：新鲜证据可准入');
  check(offlineFresh.admitted === true && offlineFresh.inherited === true, '降级路径：新鲜证据可继承');
}

// ---------- R20 交付机制（纯净安装） ----------
console.log('【R20】纯净安装可解析随包种子；用户层可覆盖；待核验条目不随包交付');
{
  const NS = await import('../dist/nutritionSupplements.js');
  NS._resetSupplementCache();
  const all = NS.loadNutritionSupplements();
  check(all.length >= 5 && all.every((s) => s.origin === 'seed'), `空用户库时全部来自随包种子（${all.length} 条）`);

  for (const [name, kcal] of [['麦麦脆汁鸡', 320], ['蓝莓爆爆珠麦旋风', 280], ['心形薯饼5块', 240], ['灰焰圆筒', 110], ['马苏里拉拉丝芝士条', 220], ['经典麦旋风', 265], ['派', 232]]) {
    const r = NS.resolveComponentNutrition(name);
    check(r.matched && r.kcal === kcal && r.valueKind === 'estimate' && r.strictUsable === false,
      `${name} 纯净安装可解析且按估算交付（kcal=${r.kcal}，strictUsable=${r.strictUsable}）`);
  }
  // 经典麦旋风/派 已在 v1.4.5 补入官网产品页证据（估算交付），不再属于「待核验/冲突」清单
  for (const name of ['脆薯饼']) {
    const sup = NS.lookupSupplement(name);
    check(!(sup && String(sup.id).startsWith('seed-')), `未把待核验/冲突条目「${name}」随包交付`);
  }

  const huiyan = all.find((s) => s.name === '灰焰圆筒');
  NS.saveNutritionSupplement({ ...huiyan, id: 'seed-huiyan-yuantong', kcal: 999, source: '用户修订', evidence: '用户修订', verifiedAt: '2026-10-16', valueKind: 'exact' });
  NS._resetSupplementCache();
  const merged = NS.loadNutritionSupplements().filter((s) => s.name === '灰焰圆筒');
  check(merged.length === 1 && merged[0].origin === 'user' && merged[0].kcal === 999, '用户层同 id 覆盖种子（不重复出现）');
  check(NS.isSeedSupplement('seed-huiyan-yuantong') === true && NS.isSeedSupplement('nope') === false, 'isSeedSupplement 正确识别种子条目');
}

// ---------- R20 随包种子文件内容合规 ----------
console.log('【R20】随包种子文件内容合规（缺文件/空条目/声明精确值均视为交付缺陷）');
{
  const { readFileSync, existsSync } = await import('node:fs');
  const p = join(ROOT, 'data', 'nutrition-seed.json');
  check(existsSync(p), 'data/nutrition-seed.json 存在');
  if (existsSync(p)) {
    const seed = JSON.parse(readFileSync(p, 'utf-8'));
    const entries = Array.isArray(seed.entries) ? seed.entries : [];
    check(entries.length > 0, `种子条目非空（${entries.length} 条）`);
    check(entries.every((s) => s.name && s.source && s.evidence && /^\d{4}-\d{2}-\d{2}$/.test(String(s.verifiedAt ?? ''))), '每条含 name/source/evidence/verifiedAt');
    check(entries.every((s) => s.valueKind !== 'exact'), '无条目声明为精确值（审核后公开参考值按估算交付）');
  }
}

console.log(failures === 0 ? '\nv1.4.4 交付与持久化回归全部通过 ✓' : `\n${failures} 项未通过 ✗`);
process.exitCode = failures === 0 ? 0 : 1;
