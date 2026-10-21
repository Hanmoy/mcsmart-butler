// 从真实面板源码生成 GitHub Pages 静态演示。
// - 同一份 public/index.html + 同一套 DOM / 交互 / 渲染路径
// - 只在网络边界注入 mock-fetch.js（不接账户、不查实时价格、不下单）
// - 演示回执由 scripts/demo-fixtures.mjs 用真实 service + 离线菜单生成
// 运行：node scripts/demo-fixtures.mjs && node scripts/build-static-demo.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBrowserFoodIdentity } from './build-browser-food-identity.mjs';

syncBrowserFoodIdentity();

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const srcPublic = join(root, 'public');
const out = join(root, 'docs/demo');
const fixtures = process.argv.includes('--fixtures')
  ? resolve(process.argv[process.argv.indexOf('--fixtures') + 1]) : join(out, 'fixtures');
const template = join(root, 'scripts/demo-template');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function readJson(name) {
  const p = join(fixtures, name);
  if (!existsSync(p)) throw new Error(`缺少演示数据 ${p}；请先运行 node scripts/demo-fixtures.mjs`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, entry.name);
    const b = join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else if (entry.isFile()) copyFileSync(a, b);
  }
}

const single = readJson('single.json');
const singleCases = readJson('single-cases.json');
const group = readJson('group.json');
const groupInput = readJson('group-input.json');
const parseGroup = readJson('parse-group.json');
const mcdna = readJson('mcdna.json');
const demoText = readFileSync(join(fixtures, 'demo-text.txt'), 'utf8').trim();

if (!single.feasible || !Array.isArray(single.solutions) || single.solutions.length === 0) {
  throw new Error('单人演示回执不可用：需要至少一个可行方案');
}
if (!group.unified || group.unified.length === 0) {
  throw new Error('多人演示回执不可用：unified 为空');
}
if (!parseGroup.members || parseGroup.members.length === 0) {
  throw new Error('多人示例解析回执不可用');
}

// mock-data.js：演示回执一次性注入，页面启动时不需要再请求本地 JSON。
const demoData = {
  version: pkg.version,
  demoText,
  single,
  singleCases,
  group,
  groupInput,
  parseGroup,
  mcdna,
};
writeFileSync(
  join(out, 'mock-data.js'),
  '/* 由 scripts/build-static-demo.mjs 生成；数据来自 scripts/demo-fixtures.mjs。 */\n'
    + 'window.MCSMART_DEMO = ' + JSON.stringify(demoData) + ';\n',
  'utf8',
);

// 复制静态资源与 mock 适配层。
copyDir(join(srcPublic, 'assets'), join(out, 'assets'));
copyDir(join(srcPublic, 'mcdna'), join(out, 'mcdna'));
copyFileSync(join(template, 'mock-fetch.js'), join(out, 'mock-fetch.js'));
copyFileSync(join(template, 'demo.css'), join(out, 'demo.css'));

const banner = [
  '<div class="demo-banner" role="note">',
  '  <span class="demo-tag">DEMO</span>',
  '  <span><strong>静态示例演示</strong> · 可切换预设场景，条件与结果一一对应。任意输入计算请使用本地完整版。不连接账户、不查实时价格、不会下单。</span>',
  '  <span class="demo-sub">价格与营养均为示例，不构成真实报价。</span>',
  '  <span class="demo-links"><a href="https://github.com/Hanmoy/mcsmart-butler" target="_blank" rel="noopener">源码</a><a href="https://github.com/Hanmoy/mcsmart-butler/releases" target="_blank" rel="noopener">下载</a></span>',
  '</div>',
].join('\n');

let html = readFileSync(join(srcPublic, 'index.html'), 'utf8');
if (!html.includes('<body>')) throw new Error('public/index.html 缺少 <body>');
html = html.replace(/<title>[^<]*<\/title>/, '<title>麦麦智能管家 · 静态演示</title>');
html = html.replace(
  '<span class="tag-chip">麦当劳官方 MCP · 实时数据</span>',
  '<span class="tag-chip demo-chip">静态演示 · 模拟数据</span>',
);
html = html.replace('<body>', () => `<body>\n${banner}`);
html = html.replace('</head>', '  <link rel="stylesheet" href="demo.css">\n</head>');
if (!html.includes('<script src="/mcdna/panel.js"></script>')) throw new Error('public/index.html 缺少 mcdna 脚本引用');
html = html.replace('<script src="/mcdna/panel.js"></script>', '<script src="mcdna/panel.js"></script>');

const mainScript = '\n<script>\nconst $ =';
if (!html.includes(mainScript)) throw new Error('public/index.html 主脚本锚点变化，无法注入 mock');
html = html.replace(
  mainScript,
  '\n<script src="mock-data.js"></script>\n<script src="mock-fetch.js"></script>\n<script>\nconst $ =',
);

// 演示页把“填入示例”换成与多人回执一致的群聊文本。
const demoLiteral = JSON.stringify(demoText);
const before = html;
html = html.replace(/\$\('#pasteBox'\)\.value = '[^']*';/, () => `$('#pasteBox').value = ${demoLiteral};`);
if (html === before) throw new Error('未找到多人“填入示例”文本，无法同步演示数据');
html = html.replace('<head>', '<head>\n<!-- 静态演示：由 scripts/build-static-demo.mjs 生成，请勿手改 -->');

writeFileSync(join(out, 'index.html'), html, 'utf8');

// GitHub Pages 根路径给一个轻量入口，避免 /docs/ 404。
writeFileSync(join(root, 'docs/index.html'), `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>麦麦智能管家 · 静态演示</title>
<style>
  html, body { margin: 0; min-height: 100%; background: #fbf6ea; color: #241e15; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 12vh 22px 48px; }
  .eyebrow { color: #b3261e; font-weight: 700; letter-spacing: .08em; font-size: 12px; }
  h1 { font-size: clamp(30px, 6vw, 52px); line-height: 1.12; margin: 14px 0 16px; }
  p { color: #5c5342; line-height: 1.8; font-size: 16px; }
  .cta { display: inline-block; margin-top: 20px; padding: 13px 22px; border-radius: 8px; background: #d32a1e; color: #fff; text-decoration: none; font-weight: 700; }
  .note { margin-top: 18px; font-size: 12px; color: #7a7160; }
</style>
</head>
<body>
<main>
  <div class="eyebrow">MCSMART BUTLER · STATIC DEMO</div>
  <h1>把“大家想吃什么？”<br>变成一份能照着点的组合。</h1>
  <p>这是静态示例演示：切换预设场景，查看对应的推荐组合、预算不足回执、多人分账与购买清单。不登录账户、不查询实时价格、不会下单。任意输入计算请使用本地完整版。</p>
  <a class="cta" href="./demo/">进入静态演示 →</a>
  <p class="note">项目源码：<a href="https://github.com/Hanmoy/mcsmart-butler">github.com/Hanmoy/mcsmart-butler</a></p>
</main>
</body>
</html>
`, 'utf8');

// 关闭 Jekyll 对 .mjs 等文件的处理疑虑；GitHub Pages 会原样提供静态资源。
writeFileSync(join(root, 'docs/.nojekyll'), '', 'utf8');

const count = (dir) => {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? count(join(dir, entry.name)) : 1;
  }
  return n;
};
console.log(JSON.stringify({
  version: pkg.version,
  demo: 'docs/demo/index.html',
  files: {
    assets: count(join(out, 'assets')),
    mcdna: count(join(out, 'mcdna')),
    total: count(out),
  },
  fixtures: {
    singleSolutions: single.solutions.length,
    groupCandidates: group.unified.length,
    groupRecommended: group.recommendedIndex,
    demoTextLength: demoText.length,
  },
}, null, 2));
