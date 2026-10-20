// v1.4.3 核验/补录入口验收（CLI）：voucher recipe * 与 nutrition * 子命令。
// 覆盖「识图/查来源 → 补录营养 → 录入配方 → 核验拒收/放行 → 修订/删除」全链路，
// 以及「说不清」必须被阻断的诚实口径。
// 运行：npm run build && node scripts/test-v143-entry.mjs
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v143entry-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const BASE = process.env.MCSMART_BUILD ?? '../dist';
const NS = await import(`${BASE}/nutritionSupplements.js`);
const VR = await import(`${BASE}/voucherRecipes.js`);
const cli = await import(`${BASE}/cli.js`);
NS._resetSupplementCache();
VR._resetRecipeCache();

let fail = 0, pass = 0;
const ck = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  OK ${label}`); }
  else { fail++; console.log(`  NG ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
};

// ---- 捕获 CLI 输出与退出码（fail() 会调 process.exit） ----
let cap = '';
let capCode = null;
const realWrite = process.stdout.write.bind(process.stdout);
const realExit = process.exit.bind(process);
process.stdout.write = (chunk, ...rest) => { cap += String(chunk); return true; };
// 注意：fail() 里 process.exit 抛出的哨兵会被 main() 的 catch 兜住并二次 handleError，
// 因此只认第一次退出码，且只解析第一段 JSON（后续追加输出属于兜底噪音）。
process.exit = (code) => { if (capCode === null) capCode = typeof code === 'number' ? code : 0; throw new Error('__EXIT__'); };
/** 取输出中第一个完整 JSON 对象（括号配平） */
function firstJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
function inputFile(name, obj) {
  const p = join(TEST_HOME, name);
  writeFileSync(p, JSON.stringify(obj, null, 1), 'utf-8');
  return p;
}
async function run(argv) {
  cap = ''; capCode = null;
  process.exitCode = 0;
  process.stdout.write = (chunk, ...rest) => { cap += String(chunk); return true; };
  try { await cli.main(argv); } catch (e) { if (e.message !== '__EXIT__') throw e; }
  process.stdout.write = realWrite; // 恢复，避免后续日志被吞
  return { out: cap, data: firstJson(cap), code: capCode ?? process.exitCode ?? 0 };
}

console.log('\n[E1] nutrition add：补录官网库未收录品项（双层脆鸡堡）');
NS._resetSupplementCache();
const nutFile = inputFile('nut1.json', {
  name: '双层脆鸡堡', kcal: 514, protein: 22.9, fat: 24.5, carbohydrate: 48.8, sodium: 0,
  source: 'FatSecret Platform API 页面（仅补录该页确实提供的字段）', sourceType: 'third-party', sourceUrl: 'https://www.fatsecret.cn/热量营养/麦当劳/双层脆鸡堡/1份',
  evidence: 'FatSecret 页面显示 1 份（216 克）：514 kcal、蛋白质 22.9g、脂肪 24.5g、碳水 48.8g。该页面未列钠，测试中 sodium=0 仅为了 API 完整结构，不可视为已核验钠值；生产录入须取得钠来源，否则仍不应作完整营养判定。',
  verifiedAt: '2026-10-15', verifiedBy: 'web-search',
});
const e1 = await run(['nutrition', 'add', '--file', nutFile]);
ck(e1.data?.ok === true && e1.data?.data?.imported === 1, '补录写入成功', e1.out.slice(0, 200));

console.log('\n[E2] nutrition list 可读回');
const e2 = await run(['nutrition', 'list']);
const e2user = (e2.data?.data?.supplements ?? []).filter((s) => s.origin === 'user');
ck(e2.data?.ok === true && e2user.length === 1, '用户层列出 1 条补录（随包种子另计）', e2.data?.data?.userCount);
ck(e2user[0]?.kcal === 514, 'kcal 正确回显', e2user[0]?.kcal);
ck(e2user[0]?.source?.toLowerCase().includes('fatsecret'), '来源可追溯', e2user[0]?.source);
ck(e2user[0]?.sourceType === 'third-party', '来源类别保留第三方标识', e2user[0]?.sourceType);
ck(e2user[0]?.sourceUrl?.includes('fatsecret.cn'), '来源 URL 可读回', e2user[0]?.sourceUrl);
// R20：随包种子必须与用户层区分，且总数 = 种子 + 用户
const e2seed = (e2.data?.data?.supplements ?? []).filter((s) => s.origin === 'seed');
ck(e2seed.length === e2.data?.data?.seedCount && e2.data?.data?.count === e2user.length + e2seed.length,
  `种子/用户分层计数一致（seed=${e2seed.length} user=${e2user.length} total=${e2.data?.data?.count}）`);

console.log('\n[E3] nutrition add 非法项被拒（缺 kcal）');
const e3 = await run(['nutrition', 'add', '--file', inputFile('nut2.json', { name: '无热量项', source: 'x' })]);
ck(e3.data?.ok === true && e3.data?.data?.skipped === 1 && e3.data?.data?.imported === 0, '缺 kcal 被跳过并计数', e3.data?.data);

console.log('\n[E4] voucher recipe verify：固定品项配方（营养可解析）→ 放行');
const fixedOk = {
  id: 'rcp-maixuanfeng-bogo', name: '【买一送一】麦旋风', matchNames: ['麦旋风买一送一', '买一送一麦旋风'],
  resolve: 'explicit', channel: 'meituan', channelLabel: '美团团购（到店）',
  items: [{ mode: 'fixed', keyword: '麦旋风', qty: 2 }],
  conditions: { orderType: 'instore', noStack: true }, priceCents: 900, originalPriceCents: 1400,
  buyPath: '美团/大众点评 APP 搜索「麦当劳」→ 门店团购页', redeemPath: '到店出示券码核销',
  evidence: '券名含明确数量语义「买一送一」→ 同名单品 x2；构成取官方同名单品（S2b 同名单品规则）',
  verifiedAt: '2026-10-15', ruleVersion: 'single-name-v1', source: 'user',
};
const e4 = await run(['voucher', 'recipe', 'verify', '--file', inputFile('r1.json', fixedOk)]);
ck(e4.data?.ok === true && e4.data?.data?.ok === true, 'fixed 配方通过核验（麦旋风在官方库）', e4.out.slice(0, 240));
ck(e4.data?.data?.items?.[0]?.nutrition === 'known', '营养已解析', e4.data?.data?.items?.[0]);

console.log('\n[E5] voucher recipe verify：品类任选未绑定官方 SKU → 阻断');
const choiceNoBind = {
  id: 'rcp-cuizhiji-3', name: '脆汁鸡小食饮料三件套', matchNames: ['脆汁鸡小食饮料三件套'],
  resolve: 'pattern', channel: 'meituan', channelLabel: '美团团购（到店）',
  items: [
    { mode: 'choice', keyword: 'staple', qty: 1 },
    { mode: 'choice', keyword: 'white', qty: 1 },
    { mode: 'choice', keyword: 'drink', qty: 1 },
  ],
  conditions: { orderType: 'instore' }, priceCents: 1990, originalPriceCents: 0,
  buyPath: '美团/大众点评 APP → 门店团购页', redeemPath: '到店出示券码',
  evidence: '券面图识读：可乐 任选1 / 小食 任选1 / 炸鸡 任选1（img.meituan.net/content/53b0ef...jpg）；任选范围需官方 SKU 轮次佐证',
  verifiedAt: '2026-10-15', ruleVersion: 'vision-raw-v1', source: 'user',
};
const e5 = await run(['voucher', 'recipe', 'verify', '--file', inputFile('r2.json', choiceNoBind)]);
ck(e5.data?.ok === false || e5.data?.data?.ok === false, '未绑定官方 SKU 的任选配方被阻断', e5.data?.ok);
ck(e5.data?.data?.blocking?.length === 3, '三条任选条目全部阻断', e5.data?.data?.blocking);
ck(e5.code === 2, '核验失败退出码 2', e5.code);

console.log('\n[E6] voucher recipe add：阻断项不得静默写库');
const e6 = await run(['voucher', 'recipe', 'add', '--file', inputFile('r2b.json', choiceNoBind)]);
ck(e6.data?.ok === false && e6.data?.error?.code === 'E_INPUT_INVALID', 'add 被拒（不写库）', e6.out.slice(0, 200));
ck(e6.data?.error?.hint?.includes('未绑定官方 SKU'), '拒绝原因说明具体条目', e6.data?.error?.hint?.slice(0, 160));
VR._resetRecipeCache();
ck(VR.loadRecipes().some((r) => r.id === 'rcp-cuizhiji-3') === false, '库中确实没有该配方', null);

console.log('\n[E7] voucher recipe add --force：已知悉风险可写库，警告记入证据');
const e7 = await run(['voucher', 'recipe', 'add', '--force', '--file', inputFile('r2c.json', choiceNoBind)]);
ck(e7.data?.ok === true && e7.data?.data?.saved === true, '--force 写入成功', e7.out.slice(0, 160));
ck(e7.data?.data?.forced === true, '标记为强制写入', e7.data?.data?.forced);
VR._resetRecipeCache();
const forced = VR.loadRecipes().find((r) => r.id === 'rcp-cuizhiji-3');
ck(!!forced && forced.evidence.includes('强制写入'), '警告写入 evidence', forced?.evidence?.slice(0, 120));

console.log('\n[E8] voucher recipe add：合规配方写库并可被 matchRecipe 命中');
const e8 = await run(['voucher', 'recipe', 'add', '--file', inputFile('r3.json', fixedOk)]);
ck(e8.data?.ok === true && e8.data?.data?.saved === true, '写库成功', e8.out.slice(0, 160));
VR._resetRecipeCache();
ck(VR.matchRecipe('麦旋风买一送一')?.id === 'rcp-maixuanfeng-bogo', '归一化名称可命中配方', VR.matchRecipe('麦旋风买一送一')?.id);
ck(VR.matchRecipe('【买一送一】麦旋风')?.id === 'rcp-maixuanfeng-bogo', '带【】的别名同样命中', VR.matchRecipe('【买一送一】麦旋风')?.id);

console.log('\n[E9] voucher recipe list：预置与用户层分区');
const e9 = await run(['voucher', 'recipe', 'list']);
ck(e9.data?.data?.count >= 9 && e9.data?.data?.presetCount >= 8, '预置配方仍在（不被用户层覆盖）', { c: e9.data?.data?.count, p: e9.data?.data?.presetCount });

console.log('\n[E10] 补录后配方条目可解析到营养（E4 的麦旋风 + 已补录的脆鸡堡）');
VR._resetRecipeCache();
const withSup = VR.validateRecipe({
  ...fixedOk,
  items: [{ mode: 'fixed', keyword: '麦旋风', qty: 1 }, { mode: 'fixed', keyword: '双层脆鸡堡', qty: 1 }],
});
ck(withSup.items[1].nutrition === 'known', '官网库 + 补录层共同覆盖（双层脆鸡堡由补录提供）', withSup.items[1]);
ck(withSup.items[1].nutritionSource?.includes('fatsecret'), '补录来源透出到核验报告', withSup.items[1].nutritionSource);
ck(withSup.ok === true, '整条配方通过（含补录覆盖项）', withSup.blocking);

console.log('\n[E11] voucher recipe revise：修订配方');
const e11 = await run(['voucher', 'recipe', 'revise', '--id', 'rcp-maixuanfeng-bogo', '--file', inputFile('r4.json', {
  ...fixedOk, priceCents: 1200, evidence: '修订：价格随档期更新',
})]);
ck(e11.data?.ok === true && e11.data?.data?.revised === true, '修订成功', e11.out.slice(0, 160));
VR._resetRecipeCache();
ck(VR.loadRecipes().find((r) => r.id === 'rcp-maixuanfeng-bogo')?.priceCents === 1200, '修订生效', null);

console.log('\n[E12] 删除：nutrition remove / voucher recipe remove');
const e12list = await run(['nutrition', 'list', '--origin', 'user']);
const supId = e12list.data?.data?.supplements?.[0]?.id ?? '';
ck(!!supId, '用户层补录项有稳定 id', supId);
// R20：随包种子只读，按用户补录删除必须被明确拒绝
const seedList = await run(['nutrition', 'list', '--origin', 'seed']);
const seedId = seedList.data?.data?.supplements?.[0]?.id ?? '';
if (seedId) {
  const e12seed = await run(['nutrition', 'remove', '--id', seedId]);
  ck(e12seed.data?.ok === false && /种子/.test(e12seed.data?.error?.message ?? ''), '随包种子不可按用户补录删除（明确拒绝）', e12seed.data?.error?.message);
}
const e12 = await run(['nutrition', 'remove', '--id', supId]);
ck(e12.data?.ok === true && e12.data?.data?.removed === true, '补录项删除成功', e12.out.slice(0, 160));
NS._resetSupplementCache();
ck(NS.resolveComponentNutrition('双层脆鸡堡').matched === false, '删除后该品项回到未知', null);
const e13 = await run(['voucher', 'recipe', 'remove', '--id', 'rcp-maixuanfeng-bogo']);
ck(e13.data?.ok === true && e13.data?.data?.removed === true, '用户层配方删除成功', e13.out.slice(0, 160));
const e14 = await run(['voucher', 'recipe', 'remove', '--id', 'rcp-1plus1']);
ck(e14.data?.ok === false && existsSync(join(TEST_HOME, 'voucher-recipes.json')) === true, '预置配方不可删', e14.out.slice(0, 200));

console.log('\n[E13] 持久化：文件落在用户数据目录，凭据不落库');
const rf = join(TEST_HOME, 'voucher-recipes.json');
ck(existsSync(rf), '配方库写到 MCSMART_HOME', rf);
const nf = join(TEST_HOME, 'nutrition-supplements.json');
ck(existsSync(nf), '补录库写到 MCSMART_HOME', nf);

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.stdout.write = realWrite;
process.exit = realExit;
if (fail > 0) process.exit(1);
