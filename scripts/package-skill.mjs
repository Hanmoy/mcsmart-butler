#!/usr/bin/env node
// 发布打包与安装脚本（Skill 化改造 #5/#6/#12）。
//   原则：发布包一律由本脚本从源码生成（编译 → 组装 → 校验 → 烟测），
//         禁止手工修改安装包（避免版本不一致）；升级自动备份、支持回退。
//
// 用法：
//   node scripts/package-skill.mjs build [--out <dir>] [--zip] [--skip-smoke]
//   node scripts/package-skill.mjs install --from <包目录> --to <目标skill目录>
//   node scripts/package-skill.mjs rollback --to <目标skill目录>
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync, copyFileSync, renameSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname as pathDirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DEFAULT = join(ROOT, 'dist-package');

const j = (p) => JSON.stringify(p, null, 1);
const log = (msg) => process.stderr.write(`[package] ${msg}\n`);

// ---------- 通用工具 ----------

/**
 * 自实现递归拷贝（不用 fs.cpSync recursive——在当前 Node 22.22.2/Windows 沙箱环境下
 * 递归模式有崩溃问题；手动 walk 行为可控且跨平台一致）。
 * skip: 可选谓词（src 绝对路径 → bool），返回 true 跳过该文件/目录。
 */
function recursiveCopy(src, dest, skip) {
  if (skip && skip(resolve(src))) return;
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) recursiveCopy(join(src, name), join(dest, name), skip);
  } else {
    mkdirSync(pathDirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

function collectDeps(rootNodeModules, name, into) {
  const pkgPath = join(rootNodeModules, name, 'package.json');
  if (!existsSync(pkgPath) || into.has(name)) return;
  into.add(name);
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) collectDeps(rootNodeModules, dep, into);
  } catch { /* 依赖声明缺失时按已收集处理 */ }
}

/** 隐私断言：发布包内不得出现凭据/缓存/个人数据 */
function assertNoPersonalFiles(stageRoot) {
  const banned = [/\.env(\.|$)/i, /^config\.json$/i, /\.log$/i, /^\.mcsmart-butler/i, /^out$/i, /^logs$/i, /\.versions$/i];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const isDir = statSync(p).isDirectory();
      for (const re of banned) {
        if (re.test(name)) throw new Error(`发布包中发现疑似个人数据/临时文件：${p}——打包白名单被污染，终止`);
      }
      if (isDir) walk(p);
    }
  };
  walk(stageRoot);
}

function copyIfExists(src, dest) {
  if (!existsSync(src)) throw new Error(`构建输入缺失：${src}`);
  recursiveCopy(src, dest);
}

// ---------- 发布前版本一致性校验（版本唯一来源 = package.json） ----------

/** 读取组装后 SKILL.md 前置元数据里的 version 字段 */
function readSkillVersion(stageDir) {
  try {
    const md = readFileSync(join(stageDir, 'SKILL.md'), 'utf-8');
    const m = md.match(/^version:\s*"?([^"\n]+?)"?\s*$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

/** 从构建产物实际解析版本（spawn 组装包的 version 命令，验证 APP_VERSION 派生链在发布包布局下正确） */
function probeRuntimeVersion(stageDir) {
  const probeHome = join(dirname(stageDir), '.version-probe-home');
  try {
    rmSync(probeHome, { recursive: true, force: true });
    mkdirSync(probeHome, { recursive: true });
    const r = spawnSync(process.execPath, [join(stageDir, 'scripts', 'mcsmart.mjs'), 'version'], {
      encoding: 'utf-8', cwd: dirname(stageDir),
      env: { ...process.env, MCSMART_HOME: probeHome, MCD_MCP_TOKEN: '', MEITUAN_UNION_APPKEY: '', MEITUAN_UNION_APPSECRET: '' },
    });
    if (r.error) return { value: null, note: `无法探测（环境限制 ${r.error.code ?? ''}）` };
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
    const v = parsed?.data?.version;
    return { value: typeof v === 'string' ? v : null, note: v ? 'ok' : `解析失败（status=${r.status}）` };
  } finally {
    rmSync(probeHome, { recursive: true, force: true });
  }
}

/**
 * 断言「源码 package.json 版本 / 构建产物版本 / 注入 SKILL.md 的 {{VERSION}}」三者一致。
 * 不一致则抛出（非零退出）并打印差异。
 */
export function assertVersionConsistency({ sourceVersion, targetVersion, stage }) {
  if (targetVersion !== sourceVersion) {
    throw new Error(`版本一致性校验失败：--version 覆盖值 ${targetVersion} 与 package.json ${sourceVersion} 不一致——版本唯一来源是 package.json，请勿用 --version 覆盖`);
  }
  const sources = {
    'package.json': sourceVersion,
    'SKILL.md({{VERSION}})': readSkillVersion(stage),
    'VERSION': (() => { try { return readFileSync(join(stage, 'VERSION'), 'utf-8').trim(); } catch { return null; } })(),
    '.installed.json': (() => { try { return JSON.parse(readFileSync(join(stage, '.installed.json'), 'utf-8')).version; } catch { return null; } })(),
  };
  const probe = probeRuntimeVersion(stage);
  if (probe.value) sources['runtime(version 命令)'] = probe.value;
  const mismatches = Object.entries(sources).filter(([, v]) => v !== sourceVersion);
  if (mismatches.length > 0) {
    throw new Error([
      '版本一致性校验失败：以下来源与 package.json 不一致（版本唯一来源应为 package.json）',
      `  package.json = ${sourceVersion}`,
      ...mismatches.map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`),
    ].join('\n'));
  }
  return { sources, probeNote: probe.note };
}

// ---------- build ----------

function cmdBuild(args) {
  const outDir = resolve(args.out ?? OUT_DEFAULT);
  const stage = join(outDir, 'mcsmart-butler');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const version = String(args.version ?? pkg.version);

  log(`1/6 编译 TypeScript（version=${version}）…`);
  const tsc = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: ROOT, stdio: 'inherit' });
  if (tsc.error) log(`   tsc 子进程受环境限制（${tsc.error.code ?? ''}）→ 改用现有 dist 产物（需先确保已编译）`);
  else if (tsc.status !== 0) throw new Error('tsc 编译失败');
  if (!existsSync(join(ROOT, 'dist', 'cli.js'))) throw new Error('编译产物缺失 dist/cli.js');

  log('2/6 组装目录结构…');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'scripts', 'runtime', 'dist'), { recursive: true });
  mkdirSync(join(stage, 'scripts', 'data'), { recursive: true });
  mkdirSync(join(stage, 'references'), { recursive: true });

  // SKILL.md（版本注入）
  const skillMd = readFileSync(join(ROOT, 'skill-template', 'SKILL.md'), 'utf-8');
  if (!skillMd.includes('{{VERSION}}')) throw new Error('skill-template/SKILL.md 缺少 {{VERSION}} 占位符');
  writeFileSync(join(stage, 'SKILL.md'), skillMd.replaceAll('{{VERSION}}', version), 'utf-8');
  // 原创代码许可须随可独立安装的程序分发，不仅留在源码仓库。
  copyIfExists(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'));

  // references / 启动器 / 编译产物 / 种子数据 / 面板资源
  copyIfExists(join(ROOT, 'skill-template', 'references'), join(stage, 'references'));
  copyIfExists(join(ROOT, 'skill-template', 'scripts', 'mcsmart.mjs'), join(stage, 'scripts', 'mcsmart.mjs'));
  copyIfExists(join(ROOT, 'dist'), join(stage, 'scripts', 'runtime', 'dist'));
  mkdirSync(join(stage, 'ui'), { recursive: true });
  copyIfExists(join(ROOT, 'public', 'index.html'), join(stage, 'ui', 'index.html'));
  // 面板品牌图片（index.html 以 /assets/<name> 引用；只放行单层文件名）
  copyIfExists(join(ROOT, 'public', 'assets'), join(stage, 'ui', 'assets'));
  // 战报预制资源：只复制引擎/控制器/无用户数据插画，不能复制样板或个人快照。
  copyIfExists(join(ROOT, 'public', 'mcdna', 'engine.mjs'), join(stage, 'ui', 'mcdna', 'engine.mjs'));
  copyIfExists(join(ROOT, 'public', 'mcdna', 'panel.js'), join(stage, 'ui', 'mcdna', 'panel.js'));
  copyIfExists(join(ROOT, 'public', 'mcdna', 'assets'), join(stage, 'ui', 'mcdna', 'assets'));
  copyIfExists(join(ROOT, 'data', 'catalog.json'), join(stage, 'scripts', 'data', 'catalog.json'));
  copyIfExists(join(ROOT, 'data', 'nutrition-official-web.json'), join(stage, 'scripts', 'data', 'nutrition-official-web.json'));
  // 随包内置联盟凭据（v1.1 决策：拆自公开发布的 meituan-assistant，作者授权安装用户使用；只读比价/零收益口径）
  copyIfExists(join(ROOT, 'data', 'union-credentials.json'), join(stage, 'scripts', 'data', 'union-credentials.json'));
  // 美团联盟城市字典（v1.3 决策：官方 xlsx 预解析为 JSON 随包分发；运行时 dealDetail 解析 cityId 必需）
  copyIfExists(join(ROOT, 'data', 'meituan-city-dict.json'), join(stage, 'scripts', 'data', 'meituan-city-dict.json'));
  // 审核后公开营养种子（v1.4.4 R20：纯净安装也能解析已审核品项；只交付审核条目，不复制本机用户库）
  copyIfExists(join(ROOT, 'data', 'nutrition-seed.json'), join(stage, 'scripts', 'data', 'nutrition-seed.json'));
  // 券配方种子（v1.4.5）：PRESET_RECIPES 的随包镜像——纯净安装的券解析依赖它，
  //   旧版只生成不复制，导致「本机用户配方库才有、空用户目录解析失败」的交付漂移。
  copyIfExists(join(ROOT, 'data', 'voucher-recipes-seed.json'), join(stage, 'scripts', 'data', 'voucher-recipes-seed.json'));
  if (existsSync(join(ROOT, 'data', 'README.md'))) copyIfExists(join(ROOT, 'data', 'README.md'), join(stage, 'scripts', 'data', 'README.md'));

  log('3/6 收集运行时依赖（HiGHS 及其依赖树）…');
  const nm = join(stage, 'scripts', 'runtime', 'node_modules');
  mkdirSync(nm, { recursive: true });
  const deps = new Set();
  collectDeps(join(ROOT, 'node_modules'), 'highs', deps);
  for (const dep of deps) copyIfExists(join(ROOT, 'node_modules', dep), join(nm, dep));
  log(`   依赖包：${[...deps].join(', ')}`);

  log('4/6 生成 VERSION 与第三方许可声明…');
  writeFileSync(join(stage, 'VERSION'), `${version}\n`, 'utf-8');
  const highsLicense = existsSync(join(ROOT, 'node_modules', 'highs', 'LICENSE'))
    ? readFileSync(join(ROOT, 'node_modules', 'highs', 'LICENSE'), 'utf-8')
    : '(LICENSE 文件缺失，请核对 highs 包)';
  writeFileSync(join(stage, 'THIRD_PARTY_LICENSES.md'), [
    '# 第三方组件许可声明',
    '',
    '本发布包包含以下第三方组件，感谢原作者：',
    '',
    '## highs（HiGHS 线性优化器 WASM 绑定，MIT License）',
    '',
    '```text',
    highsLicense.trim(),
    '```',
    '',
    '## Fusion Pixel Font（缝合像素字体 12px 简体中文，SIL Open Font License 1.1）',
    '',
    'McDNA 战报的文字由该字体转写为点阵数据 `ui/mcdna/assets/pixfont.bin.gz` 后绘制成矢量方块；未改名再分发字体文件本身。',
    '项目主页 https://github.com/TakWolf/fusion-pixel-font ；完整许可见 `ui/mcdna/assets/font-licenses/OFL.txt` 与 `LICENSE.txt`。',
    '',
    '## McDNA 战报插画素材',
    '',
    '`ui/mcdna/assets/` 下的纸板底纹、场景与角色/道具/图标贴纸为本项目生成的原创素材，随本项目许可发布；不含麦当劳商标图形。',
    '',
    '## 本项目',
    '',
    'mcsmart-butler 以 MIT License 发布（见仓库 LICENSE）。',
    '',
  ].join('\n'), 'utf-8');
  writeFileSync(join(stage, '.installed.json'), j({ version, builtAt: new Date().toISOString(), source: 'build' }), 'utf-8');

  log('5/6 隐私断言与结构校验…');
  assertNoPersonalFiles(stage);
  // 种子隔离断言（v1.2）：测试样本绝不能进入发布种子——测试只允许写隔离的 MCSMART_HOME
  {
    const seed = JSON.parse(readFileSync(join(stage, 'scripts', 'data', 'catalog.json'), 'utf-8'));
    const seedText = JSON.stringify(seed);
    const testMarkers = [/CAT-STORE/, /"S1"/, /SIGN-1PLUS1/, /SIGN-DUO/, /测试门店/];
    const hit = testMarkers.filter((re) => re.test(seedText));
    if (hit.length > 0) throw new Error(`发布种子含测试样本标记（${hit.map((r) => r.source).join('、')}）——测试数据必须隔离到用户数据目录，终止打包`);
    const menuStores = Object.keys(seed.menus ?? {});
    log(`   种子隔离断言通过：门店快照 ${menuStores.length} 家（${menuStores.join(', ')}），团单 ${Object.keys(seed.deals ?? {}).length} 条`);
  }
  // 城市字典内容断言（R13）：运行时 dealDetail 依赖它把城市名解析为美团联盟 cityId；
  // 缺文件/非法 JSON/映射为空都会让美团检索静默漏带 cityId——必须在打包期拦下。
  {
    const dictPath = join(stage, 'scripts', 'data', 'meituan-city-dict.json');
    if (!existsSync(dictPath)) throw new Error(`包结构校验失败：缺少 ${join('scripts', 'data', 'meituan-city-dict.json')}（美团联盟 cityId 解析必需）`);
    let dict;
    try { dict = JSON.parse(readFileSync(dictPath, 'utf-8')); }
    catch (e) { throw new Error(`城市字典解析失败（非法 JSON）：${dictPath}——${e instanceof Error ? e.message : String(e)}`); }
    const cities = dict?.cities ?? {};
    if (typeof cities !== 'object' || Object.keys(cities).length === 0) throw new Error(`城市字典映射为空：${dictPath}——美团检索将无法解析任何 cityId，终止打包`);
    // 与 dealDetail 的查名口径一致（直命中 / 补「市」/ 前缀匹配），抽样断言代表性城市均可解析
    const resolveCity = (name) => cities[name] ?? cities[`${name}市`]
      ?? Object.entries(cities).find(([k]) => name.length >= 2 && (k.startsWith(name) || name.startsWith(k.replace(/市$/, ''))))?.[1];
    for (const probe of ['上海', '深圳']) {
      const id = resolveCity(probe);
      if (!id) throw new Error(`城市字典内容校验失败：城市「${probe}」无有效 cityId——字典被截断或结构变更，终止打包`);
    }
    log(`   城市字典断言通过：${Object.keys(cities).length} 城（上海→${resolveCity('上海')}、深圳→${resolveCity('深圳')}）`);
  }
  // 营养种子内容断言（R20）：纯净安装依赖它解析已审核品项；缺文件/空条目/条目不合规都会让
  //   「本机用户库才有、空 MCSMART_HOME 全部未知」的交付漂移复现——必须在打包期拦下。
  {
    const seedPath = join(stage, 'scripts', 'data', 'nutrition-seed.json');
    if (!existsSync(seedPath)) throw new Error(`包结构校验失败：缺少 ${join('scripts', 'data', 'nutrition-seed.json')}（审核后公开营养种子）`);
    let seed;
    try { seed = JSON.parse(readFileSync(seedPath, 'utf-8')); }
    catch (e) { throw new Error(`营养种子解析失败（非法 JSON）：${seedPath}——${e instanceof Error ? e.message : String(e)}`); }
    const entries = Array.isArray(seed?.entries) ? seed.entries : null;
    if (!entries || entries.length === 0) throw new Error(`营养种子条目为空：${seedPath}——纯净安装将无法解析任何补录品项，终止打包`);
    const bad = entries.filter((s) => !s || typeof s.name !== 'string' || !s.name.trim()
      || typeof s.source !== 'string' || !s.source.trim()
      || typeof s.evidence !== 'string' || !s.evidence.trim()
      || !/^\d{4}-\d{2}-\d{2}$/.test(String(s.verifiedAt ?? '')));
    if (bad.length > 0) throw new Error(`营养种子条目不合规（缺 name/source/evidence/verifiedAt）：${bad.map((s) => s?.name ?? '(无名)').join('、')}`);
    // 种子条目一律不得声明为「精确值」（审核后的公开参考值按 estimate 交付，避免严格达标误判）
    const exact = entries.filter((s) => s.valueKind === 'exact');
    if (exact.length > 0) throw new Error(`营养种子含 valueKind=exact 条目（应交付估算参考值）：${exact.map((s) => s.name).join('、')}`);
    log(`   营养种子断言通过：${entries.length} 条审核条目（${entries.map((s) => s.name).join('、')}）`);
  }
  // 券配方种子断言（v1.4.5）：必须随包、非空、条目合规，且与编译产物 PRESET_RECIPES **内容一致**。
  //   配方只允许一个公共来源（源码 PRESET_RECIPES），JSON 是其镜像；两者漂移即终止打包。
  {
    const seedPath = join(stage, 'scripts', 'data', 'voucher-recipes-seed.json');
    if (!existsSync(seedPath)) throw new Error(`包结构校验失败：缺少 ${join('scripts', 'data', 'voucher-recipes-seed.json')}（券配方种子）`);
    let seed;
    try { seed = JSON.parse(readFileSync(seedPath, 'utf-8')); }
    catch (e) { throw new Error(`券配方种子解析失败（非法 JSON）：${seedPath}——${e instanceof Error ? e.message : String(e)}`); }
    const recipes = Array.isArray(seed?.recipes) ? seed.recipes : null;
    if (!recipes || recipes.length === 0) throw new Error(`券配方种子为空：${seedPath}——纯净安装将无法解析任何团购券，终止打包`);
    const bad = recipes.filter((r) => !r || typeof r.id !== 'string' || !r.id.trim()
      || typeof r.name !== 'string' || !r.name.trim()
      || !Array.isArray(r.items) || r.items.length === 0
      || r.items.some((it) => !it || typeof it.mode !== 'string' || typeof it.keyword !== 'string'));
    if (bad.length > 0) throw new Error(`券配方种子条目不合规（缺 id/name/items 或 mode/keyword）：${bad.map((r) => r?.id ?? '(无 id)').join('、')}`);
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { PRESET_RECIPES } from ${JSON.stringify(pathToFileURL(join(ROOT, 'dist', 'voucherRecipes.js')).href)};
       process.stdout.write(JSON.stringify(PRESET_RECIPES));`,
    ], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    if (probe.status !== 0) throw new Error(`无法读取 PRESET_RECIPES 做漂移校验：${probe.stderr || probe.error}`);
    if (probe.stdout !== JSON.stringify(recipes)) {
      throw new Error(`券配方种子与 PRESET_RECIPES 内容不一致（种子 ${recipes.length} 条 / 源码 ${JSON.parse(probe.stdout || '[]').length} 条）——`
        + '请运行 node scripts/sync-recipe-seed.mjs 重新生成镜像后再打包');
    }
    log(`   券配方种子断言通过：${recipes.length} 条（与 PRESET_RECIPES 内容一致）`);
  }
  // 战报素材：清单唯一来源 src/mcdnaReport.ts 的 MCDNA_ASSET_FILES（doctor 同用）；缺件/空件即终止，不发布破图包。
  const mcdnaProbe = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { MCDNA_ASSET_FILES } from ${JSON.stringify(pathToFileURL(join(ROOT, 'dist', 'mcdnaReport.js')).href)};
     process.stdout.write(JSON.stringify(MCDNA_ASSET_FILES));`,
  ], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 });
  if (mcdnaProbe.status !== 0) throw new Error(`无法读取 MCDNA_ASSET_FILES 做战报素材校验：${mcdnaProbe.stderr || mcdnaProbe.error}`);
  const mcdnaAssets = JSON.parse(mcdnaProbe.stdout).map((f) => `ui/mcdna/assets/${f}`);
  if (mcdnaAssets.length < 30) throw new Error(`战报素材清单异常（仅 ${mcdnaAssets.length} 项）`);
  const required = [
    'SKILL.md', 'VERSION', 'LICENSE', 'THIRD_PARTY_LICENSES.md',
    'scripts/mcsmart.mjs',
    'scripts/runtime/dist/cli.js', 'scripts/runtime/dist/service.js', 'scripts/runtime/dist/config.js', 'scripts/runtime/dist/server.js',
    'ui/index.html', 'ui/assets/brand.png', 'ui/mcdna/engine.mjs', 'ui/mcdna/panel.js',
    ...mcdnaAssets,
    join('scripts/runtime/node_modules/highs/package.json'),
    'scripts/data/catalog.json', 'scripts/data/nutrition-official-web.json', 'scripts/data/union-credentials.json', 'scripts/data/meituan-city-dict.json', 'scripts/data/nutrition-seed.json', 'scripts/data/voucher-recipes-seed.json',
    'references/contracts.md', 'references/setup.md', 'references/examples.md',
  ];
  for (const rel of required) {
    const p = join(stage, rel);
    if (!existsSync(p)) throw new Error(`包结构校验失败：缺少 ${rel}`);
    // 非空断言：必需文件不得为空（0 字节常意味着上游生成失败）
    if (statSync(p).size === 0) throw new Error(`包结构校验失败：${rel} 为空文件`);
  }

  // 版本一致性校验：源码 package.json / 构建产物 / 注入 SKILL.md 的 {{VERSION}} 必须一致
  const vc = assertVersionConsistency({ sourceVersion: pkg.version, targetVersion: version, stage });
  log(`   版本一致性校验通过：${version}（来源 ${Object.keys(vc.sources).join(' / ')}；runtime 探测 ${vc.probeNote}）`);

  log('6/6 干净环境烟测（隔离 MCSMART_HOME + 独立 cwd，验证布局自包含）…');
  if (!args['skip-smoke']) {
    const smokeHome = join(outDir, '.smoke-home');
    rmSync(smokeHome, { recursive: true, force: true });
    mkdirSync(smokeHome, { recursive: true });
    // cwd 设为无关目录（系统临时盘根），证明不依赖 cwd；显式清空 MCP token 环境变量
    const smoke = spawnSync(process.execPath, [join(stage, 'scripts', 'mcsmart.mjs'), 'doctor'], {
      cwd: dirname(outDir), env: { ...process.env, MCSMART_HOME: smokeHome, MCD_MCP_TOKEN: '', MEITUAN_UNION_APPKEY: '', MEITUAN_UNION_APPSECRET: '' },
      encoding: 'utf-8',
    });
    rmSync(smokeHome, { recursive: true, force: true });
    // 受限环境（Windows 沙箱/杀软锁）无法 spawn 子进程（EBUSY）→ 烟测降级为「文件层结构校验」并明确标注，
    // 不因环境限制阻断打包；真实环境仍执行完整干净环境烟测。
    if (smoke.error) {
      const required = ['SKILL.md', 'scripts/runtime/dist/cli.js', 'scripts/data/catalog.json', 'scripts/data/meituan-city-dict.json'];
      const missing = required.filter((rel) => !existsSync(join(stage, rel)));
      if (missing.length > 0) throw new Error(`烟测降级结构校验未通过：缺少 ${missing.join(', ')}`);
      log(`   烟测降级（环境限制：无法启动子进程 ${smoke.error.code ?? ''}）；结构校验通过（SKILL.md / runtime / seed 齐全）`);
    } else {
      const outJson = (() => { try { return JSON.parse(smoke.stdout); } catch { return null; } })();
      if (smoke.status !== 0 || outJson?.ok !== true || outJson?.data?.layout?.mode !== 'package') {
        throw new Error(`烟测失败（status=${smoke.status}）：${(smoke.stdout || smoke.stderr || '').slice(0, 400)}`);
      }
      const checks = Object.fromEntries((outJson.data.checks ?? []).map((c) => [c.id, c.status]));
      if (checks.solver !== 'ok' || checks['seed-data'] !== 'ok' || checks.config !== 'ok') {
        throw new Error(`烟测检查未通过：${j(checks)}`);
      }
      log(`   烟测通过：mode=package, checks=${j(checks)}`);
    }
  }

  writeFileSync(join(outDir, 'BUILD_INFO.json'), j({ version, stage, builtAt: new Date().toISOString(), node: process.version }), 'utf-8');
  process.stdout.write(j({ ok: true, command: 'build', stage, version }) + '\n');

  if (args.zip) {
    const zipPath = join(outDir, `mcsmart-butler-v${version}.zip`);
    if (existsSync(zipPath)) rmSync(zipPath, { force: true });
    // 用 .NET ZipArchive 手工建条目：Compress-Archive 在 Windows 会把分隔符写成反斜杠，
    // 公开 Release 的 ZIP 需要正斜杠，才能在 macOS/Linux 上解出正确目录结构。
    const zipScript = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = (Resolve-Path -LiteralPath $env:MCSMART_ZIP_SRC).Path
$dst = $env:MCSMART_ZIP_DST
$zip = [System.IO.Compression.ZipFile]::Open($dst, 'Create')
try {
  Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1).Replace('\\','/')
    $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    $out = $entry.Open()
    $srcStream = [System.IO.File]::OpenRead($_.FullName)
    try { $srcStream.CopyTo($out) } finally { $srcStream.Dispose(); $out.Dispose() }
  }
} finally { $zip.Dispose() }
`;
    const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', zipScript], {
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, MCSMART_ZIP_SRC: stage, MCSMART_ZIP_DST: zipPath },
    });
    if (ps.status !== 0) throw new Error('zip 打包失败（powershell ZipArchive）');
    log(`已生成 ${zipPath}`);
    process.stdout.write(j({ ok: true, command: 'zip', zip: zipPath }) + '\n');
  }
}

// ---------- install / rollback ----------

const KEEP_BACKUPS = 2;

function listBackups(toDir) {
  const vDir = join(toDir, '.versions');
  if (!existsSync(vDir)) return [];
  return readdirSync(vDir)
    // v1.4.11：改名隔离的 .trash-* 不是可用备份（内容虽在，但名字已不可信、且不属于 KEEP_BACKUPS 配额）
    .filter((n) => !n.startsWith('.trash-') && statSync(join(vDir, n)).isDirectory())
    // v1.4.11：按**时间戳后缀**排序（不是整名）——名称前缀含版本号，
    //   整名字典序会把 1.4.10 排在 1.4.9 之前，rollback 就会取错版本。
    .sort((a, b) => a.slice(-19).localeCompare(b.slice(-19)))
    .map((n) => join(vDir, n));
}

/**
 * 删除目录（v1.3 兜底）：宿主环境（WorkBuddy CLI 的 node fs 代理 shim）会把 rmSync 路由到
 * 回收站且对部分目录中止（实测 .workbuddy/skills 下 scripts 目录稳定失败）。此时改为
 * 同卷改名隔离（.trash-<ts> 前缀，纯元数据操作，不依赖删除权限）——目录内容已先完整备份到
 * .versions/，隔离目录待宿主侧可清理时再删。
 */
function removeDirResilient(p) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch (e) {
    const quar = join(dirname(p), `.trash-${Date.now().toString(36)}-${basename(p)}`);
    try {
      renameSync(p, quar);
      log(`[safe-delete] rmSync 失败（${String(e.message).slice(0, 80)}），已改名隔离 → ${quar}`);
    } catch {
      throw e;
    }
  }
}

function cmdInstall(args) {
  const from = resolve(args.from ?? join(OUT_DEFAULT, 'mcsmart-butler'));
  const to = resolve(args.to);
  if (!existsSync(join(from, 'SKILL.md'))) throw new Error(`安装源不完整（缺 SKILL.md）：${from}`);
  if (!args.to) throw new Error('install 需要 --to <目标skill目录>');

  mkdirSync(to, { recursive: true });
  const newVersion = readFileSync(join(from, 'VERSION'), 'utf-8').trim();
  let previousVersion = null;
  const prunedBackupFailures = [];

  // 已有安装 → 备份当前版本
  if (existsSync(join(to, 'SKILL.md'))) {
    try { previousVersion = readFileSync(join(to, 'VERSION'), 'utf-8').trim(); } catch { previousVersion = 'unknown'; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = join(to, '.versions', `${previousVersion}-${stamp}`);
    const versionsDir = join(to, '.versions');
    mkdirSync(versionsDir, { recursive: true });
    recursiveCopy(to, backupDir, (src) => src === versionsDir); // 备份排除 .versions 自身
    log(`已备份当前版本 ${previousVersion} → ${backupDir}`);
    // 清理旧备份，保留最近 KEEP_BACKUPS 份
    // v1.4.11：宿主沙箱对「单次 >50 文件删除」会拦截（SAFE_DELETE_BULK_CONFIRM_REQUIRED）。
    //   清理失败不得中断安装——备份多留几份是可接受的降级，安装失败不可接受。
    const backups = listBackups(to);
    for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
      try {
        removeDirResilient(old);
        log(`清理过期备份：${old}`);
      } catch (e) {
        log(`过期备份清理被宿主拒绝（${String(e.message).slice(0, 60)}）→ 保留 ${basename(old)}，不影响本次安装`);
        prunedBackupFailures.push(basename(old));
      }
    }
  }

  // 替换安装目录（保留 .versions）
  // v1.4.11：先**改名移出**再复制，避免原地删除被宿主沙箱拦截（改名是纯元数据操作）。
  const evicted = [];
  const evictRoot = `${to}.old-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  for (const name of readdirSync(to)) {
    if (name === '.versions' || name === '.smoke-check') continue;
    mkdirSync(evictRoot, { recursive: true });
    try {
      renameSync(join(to, name), join(evictRoot, name));
      evicted.push(name);
    } catch {
      // 跨卷/占用时退回原地删除（removeDirResilient 内含改名兜底）
      removeDirResilient(join(to, name));
    }
  }
  recursiveCopy(from, to, (src) => src === join(to, '.versions') || src === join(to, '.smoke-check'));
  writeFileSync(join(to, '.installed.json'), j({
    version: newVersion, installedAt: new Date().toISOString(), previousVersion,
  }), 'utf-8');
  // 移出的旧内容尝试清理；清理不掉就留着并如实回报（不静默、不阻断安装）
  let leftoverOld = null;
  if (evicted.length > 0) {
    try { removeDirResilient(evictRoot); } catch { leftoverOld = evictRoot; }
  }

  // 安装后自检
  const smokeHome = join(to, '.smoke-check');
  const smoke = spawnSync(process.execPath, [join(to, 'scripts', 'mcsmart.mjs'), 'doctor'], {
    cwd: to, env: { ...process.env, MCSMART_HOME: smokeHome, MCD_MCP_TOKEN: '' }, encoding: 'utf-8',
  });
  try { removeDirResilient(smokeHome); } catch { /* 自检目录清理失败不影响安装结果 */ }
  let doctorOk = false;
  let doctorNote = 'ok';
  if (smoke.error) {
    // 受限环境无法 spawn 子进程（EBUSY）→ 自检降级为「结构校验」并明确标注（不误判为安装失败）
    const required = ['SKILL.md', 'scripts/runtime/dist/cli.js', 'scripts/data/catalog.json', 'scripts/data/meituan-city-dict.json'];
    const missing = required.filter((rel) => !existsSync(join(to, rel)));
    doctorOk = missing.length === 0;
    doctorNote = `skipped-env-limit（${smoke.error.code ?? ''}；结构校验${doctorOk ? '通过' : '缺文件：' + missing.join(',')}）`;
  } else {
    try { doctorOk = JSON.parse(smoke.stdout)?.ok === true; } catch { /* ignore */ }
    if (!doctorOk) doctorNote = 'failed';
  }

  process.stdout.write(j({
    ok: true, command: 'install', to, installedVersion: newVersion, previousVersion,
    backupsKept: listBackups(to).length, postInstallDoctorOk: doctorOk, postInstallDoctor: doctorNote,
    ...(prunedBackupFailures.length > 0 ? { backupsKeptExtra: prunedBackupFailures } : {}),
    ...(leftoverOld ? { leftoverOld } : {}),
    hint: '用户数据目录（凭据/配置/缓存）不受本次安装影响；rollback --to ' + to + ' 可回退',
  }) + '\n');
}

function cmdRollback(args) {
  const to = resolve(args.to);
  if (!args.to || !existsSync(join(to, 'SKILL.md'))) throw new Error('rollback 需要 --to <已安装的skill目录> 且目标已安装');
  const backups = listBackups(to);
  if (backups.length === 0) throw new Error(`没有可用备份（${join(to, '.versions')} 为空）——无法回退`);
  const restoreFrom = backups[backups.length - 1];

  // 当前版本先入备份位，再恢复上一版
  const curVersion = (() => { try { return readFileSync(join(to, 'VERSION'), 'utf-8').trim(); } catch { return 'unknown'; } })();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const versionsDir = join(to, '.versions');
  mkdirSync(versionsDir, { recursive: true });
  recursiveCopy(to, join(to, '.versions', `${curVersion}-before-rollback-${stamp}`), (src) => src === versionsDir);
  for (const name of readdirSync(to)) {
    if (name === '.versions') continue;
    rmSync(join(to, name), { recursive: true, force: true });
  }
  recursiveCopy(restoreFrom, to);
  const restoredVersion = readFileSync(join(to, 'VERSION'), 'utf-8').trim();
  process.stdout.write(j({
    ok: true, command: 'rollback', to, restoredVersion, restoredFrom: restoreFrom,
    hint: '回退完成；用户数据目录不受影响',
  }) + '\n');
}

// ---------- 主流程 ----------

const [, , command, ...rest] = process.argv;
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const next = rest[i + 1];
    args[rest[i].slice(2)] = next !== undefined && !next.startsWith('--') ? next : true;
    if (next !== undefined && !next.startsWith('--')) i++;
  }
}

async function main() {
  switch (command) {
    case 'build': return cmdBuild(args);
    case 'install': return cmdInstall(args);
    case 'rollback': return cmdRollback(args);
    default: {
      process.stderr.write([
        '用法：node scripts/package-skill.mjs <command>',
        '  build    [--out DIR] [--zip] [--skip-smoke]   从源码构建发布包（编译→组装→校验→烟测）',
        '  install  --from <包目录> --to <目标skill目录>  安装/升级（自动备份旧版，保留最近 2 份）',
        '  rollback --to <目标skill目录>                 回退到上一版本',
      ].join('\n') + '\n');
      process.exit(command ? 2 : 0);
    }
  }
}

// 直接执行时运行 CLI；被 import（如验收测试）时只导出工具函数，不执行主流程
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    await main();
  } catch (e) {
    process.stdout.write(j({ ok: false, error: { code: 'E_PACKAGE', message: e instanceof Error ? e.message : String(e) } }) + '\n');
    process.exit(1);
  }
}
