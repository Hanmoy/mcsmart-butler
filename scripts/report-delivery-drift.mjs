// 交付漂移报告（v1.4.4 R20）
//
// 目的：把「源码 / 发布包 / 安装位 / 公开数据」四处的**实际版本与内容**摊在一张表上，
//   避免出现「源码有新增配方、同版本旧包没有」「新增食品只在某台机器的用户库」这类静默漂移。
//
// 用法：
//   node scripts/report-delivery-drift.mjs                     # 报告源码 + dist-package + 默认安装位
//   node scripts/report-delivery-drift.mjs --install <目录>     # 指定安装位
//   node scripts/report-delivery-drift.mjs --json              # 机器可读输出
//
// 诚实边界：本脚本只**读取与报告**，不执行安装、不修改任何数据目录。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

/** v1.4.6 R13：采集与判错由**同一份资源清单**驱动。
 *  旧实现采集了 voucher-recipes-seed.json（并打印其哈希），判错循环却漏掉它，
 *  且从不比较安装位业务数据与页面 HTML —— 改坏这三类文件时脚本仍退出 0。 */
const DATA_FILES = [
  'catalog.json',
  'nutrition-official-web.json',
  'meituan-city-dict.json',
  'nutrition-seed.json',
  'voucher-recipes-seed.json',
];
/** 页面资源：源码在 public/，发布包与安装位在 ui/ */
const UI_FILE = 'index.html';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
const sha256 = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16); } catch { return null; } };

/** 目录内容指纹：对排序后的「相对路径 + 文件大小 + mtime」求哈希（不读全量内容，快且稳定） */
function treeFingerprint(dir, filter = () => true) {
  if (!existsSync(dir)) return null;
  const rows = [];
  const walk = (d, base = '') => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = base ? `${base}/${e.name}` : e.name;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile() && filter(rel)) {
        // 按「文件内容」而非 mtime 取指纹：否则每次重新编译（内容不变、时间戳变化）都会误报漂移，
        // 与本报告「同源仅表示内容哈希一致」的声明相矛盾。
        try { rows.push(`${rel}:${sha256(full)}`); } catch { /* */ }
      }
    }
  };
  walk(dir);
  return { files: rows.length, hash: createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16) };
}

/** 读取一个「安装/发布」布局的版本与关键数据 */
function inspectLayout(label, root, seedDataDir, runtimeDist) {
  const versionFile = join(root, 'VERSION');
  const installed = readJson(join(root, '.installed.json'));
  const skillMd = join(root, 'SKILL.md');
  let skillVersion = null;
  try { skillVersion = (readFileSync(skillMd, 'utf-8').match(/^version:\s*(.+)$/m) ?? [])[1]?.trim() ?? null; } catch { /* */ }
  const data = {};
  for (const f of DATA_FILES) {
    const p = join(seedDataDir, f);
    data[f] = { present: existsSync(p), hash: sha256(p) };
  }
  const uiPath = join(root, 'ui', UI_FILE);
  return {
    label, root,
    version: existsSync(versionFile) ? readFileSync(versionFile, 'utf-8').trim() : (installed?.version ?? null),
    installedVersion: installed?.version ?? null,
    skillMdVersion: skillVersion,
    runtime: treeFingerprint(runtimeDist, (rel) => rel.endsWith('.js')),
    data,
    ui: { present: existsSync(uiPath), hash: sha256(uiPath), resources: treeFingerprint(join(root, 'ui')) },
  };
}

// ---------- 源码 ----------
const pkg = readJson(join(ROOT, 'package.json')) ?? {};
const sourceDist = treeFingerprint(join(ROOT, 'dist'), (rel) => rel.endsWith('.js'));
const source = {
  label: '源码（开发仓库）', root: ROOT,
  version: pkg.version ?? null,
  runtime: sourceDist,
  data: Object.fromEntries(DATA_FILES
    .map((f) => { const p = join(ROOT, 'data', f); return [f, { present: existsSync(p), hash: sha256(p) }]; })),
  ui: (() => { const p = join(ROOT, 'public', UI_FILE); return { present: existsSync(p), hash: sha256(p), resources: treeFingerprint(join(ROOT, 'public')) }; })(),
};

// ---------- 发布包 ----------
const stageRoot = join(ROOT, 'dist-package', 'mcsmart-butler');
const pkgLayout = inspectLayout('发布包（dist-package/mcsmart-butler）', stageRoot, join(stageRoot, 'scripts', 'data'), join(stageRoot, 'scripts', 'runtime', 'dist'));
const buildInfo = readJson(join(ROOT, 'dist-package', 'BUILD_INFO.json'));

// ---------- 安装位 ----------
const installRoot = typeof args.install === 'string' ? args.install : join(homedir(), '.workbuddy-ai', 'skills', 'mcsmart-butler');
const install = inspectLayout(`安装位（${installRoot}）`, installRoot, join(installRoot, 'scripts', 'data'), join(installRoot, 'scripts', 'runtime', 'dist'));

// ---------- 公开数据覆盖 ----------
const presetRecipesPath = join(ROOT, 'dist', 'voucherRecipes.js');
let presetRecipeCount = null;
try {
  const mod = await import(new URL(`file://${presetRecipesPath.replace(/\\/g, '/')}`).href);
  presetRecipeCount = Array.isArray(mod.PRESET_RECIPES) ? mod.PRESET_RECIPES.length : null;
} catch { /* 未编译时跳过 */ }
const userRecipes = readJson(join(homedir(), '.mcsmart-butler', 'voucher-recipes.json'));
const userSupplements = readJson(join(homedir(), '.mcsmart-butler', 'nutrition-supplements.json'));
const seedSupplements = readJson(join(ROOT, 'data', 'nutrition-seed.json'));
const seedRecipes = readJson(join(ROOT, 'data', 'voucher-recipes-seed.json'));
const officialNutrition = readJson(join(ROOT, 'data', 'nutrition-official-web.json'));
const cityDict = readJson(join(ROOT, 'data', 'meituan-city-dict.json'));

// ---------- 未核验项（本地团单库） ----------
const catalog = readJson(join(homedir(), '.mcsmart-butler', 'catalog.json'));
const dealList = catalog && typeof catalog.deals === 'object' ? Object.values(catalog.deals) : [];
const unverifiedByReason = {};
let verifiedCount = 0, unverifiedCount = 0, noVerifyRecord = 0;
for (const d of dealList) {
  const st = d?.verify?.status;
  if (st === 'unverified') { unverifiedCount++; const k = d.verify.reasonCode ?? 'detail-unavailable'; unverifiedByReason[k] = (unverifiedByReason[k] ?? 0) + 1; }
  else if (st) verifiedCount++;
  else noVerifyRecord++;
}

const report = {
  generatedAt: new Date().toISOString(),
  source,
  package: { ...pkgLayout, buildInfo: buildInfo ?? null },
  install,
  coverage: {
    presetRecipes: presetRecipeCount,
    seedRecipes: Array.isArray(seedRecipes?.recipes) ? seedRecipes.recipes.length : null,
    userRecipes: Array.isArray(userRecipes?.recipes) ? userRecipes.recipes.length : null,
    nutritionSeedEntries: Array.isArray(seedSupplements?.entries) ? seedSupplements.entries.length : null,
    nutritionSeedNames: Array.isArray(seedSupplements?.entries) ? seedSupplements.entries.map((s) => s.name) : [],
    userSupplements: Array.isArray(userSupplements?.supplements) ? userSupplements.supplements.length : null,
    officialNutritionProducts: officialNutrition && typeof officialNutrition.Product === 'object' ? Object.keys(officialNutrition.Product).length : null,
    cityDictCities: cityDict && typeof cityDict.cities === 'object' ? Object.keys(cityDict.cities).length : null,
  },
  unverified: { total: dealList.length, verified: verifiedCount, unverified: unverifiedCount, noVerifyRecord, byReason: unverifiedByReason },
};

if (args.json) {
  console.log(JSON.stringify(report, null, 1));
} else {
  const L = [];
  const hashOf = (t) => (t?.runtime ? `${t.runtime.hash}（${t.runtime.files} 个 js）` : '—');
  L.push('交付漂移报告（源码 / 发布包 / 安装位 / 公开数据）');
  L.push(`生成时间：${report.generatedAt}`);
  L.push('');
  L.push('一、版本与运行时内容');
  L.push(`  源码            : ${source.version ?? '未知'}   runtime=${hashOf(source)}`);
  L.push(`  发布包          : ${pkgLayout.version ?? '（未构建）'}   runtime=${hashOf(pkgLayout)}   installed.json=${pkgLayout.installedVersion ?? '—'}   SKILL.md=${pkgLayout.skillMdVersion ?? '—'}`);
  L.push(`  安装位          : ${install.version ?? '（不存在）'}   runtime=${hashOf(install)}   installed.json=${install.installedVersion ?? '—'}   SKILL.md=${install.skillMdVersion ?? '—'}`);
  if (buildInfo) L.push(`  BUILD_INFO      : ${buildInfo.version} @ ${buildInfo.builtAt}`);
  const versions = [source.version, pkgLayout.version, install.version].filter(Boolean);
  L.push(`  一致性          : ${versions.length >= 2 ? (new Set(versions).size === 1 ? '✅ 一致' : `⚠️ 不一致（${[...new Set(versions)].join(' / ')}）`) : '（数据不足）'}`);
  L.push('');
  L.push('二、随包数据与页面（存在 / sha256 前 16 位）');
  for (const f of DATA_FILES) {
    const s = source.data[f], p = pkgLayout.data[f], i = install.data[f];
    const cell = (x) => (x?.present ? x.hash : '缺失');
    const same = s?.hash && p?.hash && s.hash === p.hash ? '同源' : (p?.present ? '⚠️ 与源码不同' : '⚠️ 包内缺失');
    L.push(`  ${f.padEnd(30)} 源码=${cell(s)}  包=${cell(p)}  ${same}`);
    if (i?.present || install.version) {
      const sameI = s?.hash && i?.hash && s.hash === i.hash ? '同源' : (i?.present ? '⚠️ 与源码不同' : '⚠️ 安装位缺失');
      L.push(`  ${''.padEnd(30)} 安装位=${cell(i)}  ${sameI}`);
    }
  }
  {
    const s = source.ui, p = pkgLayout.ui, i = install.ui;
    const cell = (x) => (x?.present ? x.hash : '缺失');
    L.push(`  ${UI_FILE.padEnd(30)} 源码=${cell(s)}  包=${cell(p)}  ${s?.hash && p?.hash && s.hash === p.hash ? '同源' : (p?.present ? '⚠️ 与源码不同' : '⚠️ 包内缺失')}`);
    if (i?.present || install.version) {
      L.push(`  ${''.padEnd(30)} 安装位=${cell(i)}  ${s?.hash && i?.hash && s.hash === i.hash ? '同源' : (i?.present ? '⚠️ 与源码不同' : '⚠️ 安装位缺失')}`);
    }
  }
  L.push('');
  L.push('三、公开数据覆盖');
  L.push(`  预置券配方      : ${report.coverage.presetRecipes ?? '—'} 条（随包种子 ${report.coverage.seedRecipes ?? '—'} 条）`);
  L.push(`  本机用户配方    : ${report.coverage.userRecipes ?? '—'} 条（不随包交付）`);
  L.push(`  营养种子条目    : ${report.coverage.nutritionSeedEntries ?? '—'} 条${report.coverage.nutritionSeedNames.length ? `（${report.coverage.nutritionSeedNames.join('、')}）` : ''}`);
  L.push(`  本机用户营养补录: ${report.coverage.userSupplements ?? '—'} 条（不随包交付）`);
  L.push(`  官网营养产品数  : ${report.coverage.officialNutritionProducts ?? '—'}`);
  L.push(`  城市字典城市数  : ${report.coverage.cityDictCities ?? '—'}`);
  L.push('');
  L.push('四、未核验项（本机团单库）');
  L.push(`  团单合计 ${report.unverified.total}：已核验 ${report.unverified.verified}，未核验 ${report.unverified.unverified}，无核验记录 ${report.unverified.noVerifyRecord}`);
  for (const [k, v] of Object.entries(unverifiedByReason).sort((a, b) => b[1] - a[1])) L.push(`    - ${k}: ${v}`);
  L.push('');
  L.push('诚实边界：本报告只读取与比对，不执行安装、不修改任何数据目录；「同源」仅表示内容哈希一致。');
  console.log(L.join('\n'));
}

// 漂移退出码：版本、运行时、随包业务数据与页面任一不一致即非零退出，便于 CI/交付检查捕获
const drift = [];
if (source.version && pkgLayout.version && source.version !== pkgLayout.version) drift.push('源码与发布包版本不一致');
if (source.version && install.version && source.version !== install.version) drift.push('源码与安装位版本不一致');
// 运行时内容漂移：同版本号也可能内容不同（R20 的核心问题），按内容指纹比对
if (source.runtime && pkgLayout.runtime && source.runtime.hash !== pkgLayout.runtime.hash) drift.push('发布包 runtime 内容与源码不一致');
if (source.runtime && install.runtime && install.version === source.version && source.runtime.hash !== install.runtime.hash) drift.push('安装位 runtime 内容与源码不一致');
// v1.4.6 R13：业务数据（含配方种子/营养种子/城市字典）与页面 HTML 必须逐项比对——
//   同一份 DATA_FILES 同时驱动采集与判错，新增资源只改清单即可，不会出现「打印了哈希但不判错」。
for (const f of DATA_FILES) {
  const srcHash = source.data[f]?.hash;
  if (!srcHash) continue;
  if (!pkgLayout.version) continue;
  if (!pkgLayout.data[f]?.hash) drift.push(`发布包缺少随包数据文件 ${f}`);
  else if (srcHash !== pkgLayout.data[f].hash) drift.push(`发布包内 ${f} 与源码不同`);
  if (install.version) {
    if (!install.data[f]?.hash) drift.push(`安装位缺少随包数据文件 ${f}`);
    else if (srcHash !== install.data[f].hash) drift.push(`安装位 ${f} 与源码不同`);
  }
}
if (source.ui?.hash && pkgLayout.version) {
  if (!pkgLayout.ui?.hash) drift.push(`发布包缺少页面 ${UI_FILE}`);
  else if (source.ui.hash !== pkgLayout.ui.hash) drift.push(`发布包页面 ${UI_FILE} 与源码不同`);
  if (install.version) {
    if (!install.ui?.hash) drift.push(`安装位缺少页面 ${UI_FILE}`);
    else if (source.ui.hash !== install.ui.hash) drift.push(`安装位页面 ${UI_FILE} 与源码不同`);
  }
}
if (source.ui.resources && pkgLayout.version && source.ui.resources.hash !== pkgLayout.ui.resources?.hash) drift.push('发布包战报/页面资源与源码不同');
if (source.ui.resources && install.version && source.ui.resources.hash !== install.ui.resources?.hash) drift.push('安装位战报/页面资源与源码不同');
if (drift.length > 0 && !args['no-fail']) {
  console.error('\n⚠️ 检出交付漂移：' + drift.join('；'));
  process.exitCode = 1;
}
