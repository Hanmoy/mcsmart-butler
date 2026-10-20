// v1.4.2 操作面板前端静态断言：R04 确认卡成员状态 / R06 逐份配置展示 / R10 城市切换竞态 /
// R12 版本徽标 / R14 样式与信息层级。本机无浏览器自动化依赖，故只做源码结构断言。
// 运行：node scripts/test-v142-ui.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(here, '..', 'public', 'index.html');
const html = readFileSync(HTML_PATH, 'utf8');

let failures = 0;
const check = (cond, label, detail) => {
  const tag = cond ? '✓' : '✗';
  if (!cond) failures++;
  console.log(`  ${tag} ${label}${detail !== undefined ? `（${detail}）` : ''}`);
};
const slice = (from, len) => {
  const i = html.indexOf(from);
  return i < 0 ? '' : html.slice(i, i + len);
};
const count = (re) => (html.match(re) || []).length;

// ---------------------------------------------------------------- R04
console.log('\n[R04] 多人确认卡保留 sugarFree / notes');
const collectBlock = slice('function collectMembers', 1400);
check(!html.includes(".mrow').map(row=>({"), 'collectMembers 不再从 DOM 从零构造成员对象');
check(collectBlock.includes('Object.assign({}, base'), 'collectMembers 以解析结果为基底合并表单值');
check(/const memberBase\s*=\s*new Map\(\)/.test(html), '保存解析响应的完整成员状态（memberBase）');
check(html.includes('memberBase.set(id, { ...m })'), 'memberRow 把完整成员对象存入 memberBase');
check(html.includes('memberBase.clear()'), '重新解析时清空旧成员状态');
check(html.includes('class="m-sugarfree"'), '确认卡含「无糖」可编辑字段（复选框）');
check(html.includes('class="m-notes"'), '确认卡含「备注」可编辑字段');
check(collectBlock.includes('sugarFree'), '提交载荷包含 sugarFree');
check(/\bnotes,/.test(collectBlock), '提交载荷包含 notes');
check(html.includes("$('.m-sugarfree',row).checked || taboos.some(t=>SUGAR_FREE_RE.test(t))"),
  '手工「无糖」与解析 sugarFree 走同一条归一化路径');

// ---------------------------------------------------------------- R06
console.log('\n[R06] 购买清单按逐份配置展示');
const itemsBlock = slice('itemsHtml: s.items.map', 3200);
// v1.4.6 R03：单份券也必须展示逐份配置 → 条件改为 length > 0
check(/Array\.isArray\(it\.units\)\s*&&\s*it\.units\.length\s*>\s*0/.test(html), '存在消费 units 的分行渲染路径（length > 0，含单份券）');
check(itemsBlock.includes('u.config') && itemsBlock.includes('u.priceCents') && itemsBlock.includes('u.kcal'),
  '按配置分行消费 qty / config / priceCents / kcal');
check(/it\.units\.map\(\(u,\s*ui\)/.test(html), 'units 逐份遍历（不同配置不合并、不取平均）');
check(itemsBlock.includes('回落') && itemsBlock.includes('it.deconstruction'), 'units 缺失时回落到现有渲染逻辑（向后兼容）');

// ---------------------------------------------------------------- R10
console.log('\n[R10] 城市切换竞态');
check(/let storeQuerySeq\s*=\s*0/.test(html), '存在请求序号 storeQuerySeq');
check(html.includes('if (seq !== storeQuerySeq) return'), '只接受最新「城市 + 关键词」查询的结果（丢弃过期响应）');
check(/function clearStoreSelection/.test(html) && /clearStoreSelection\(\);\s*\/\/\s*新查询/.test(html),
  '新查询立即清空旧门店选择');
check(html.includes("$$('#go, #goGroup')") && /b\.disabled = !ready/.test(html),
  '无有效选择时禁用依赖门店的提交按钮（#go / #goGroup）');
check(/function storeMatchesContext/.test(html), '存在门店属于当前查询上下文的判定');
check(/function ensureStoreSelected/.test(html), '存在提交前门店上下文校验函数');
// v1.4.9 N01：除精算/拼单两个提交路径外，「读取分时段目录」也依赖当前门店选择，故为 3 处；
// 断言改为「不少于两个提交路径且含新增的目录读取」，避免新增只读入口时误报。
check(count(/if \(!ensureStoreSelected\(\)\) return;/g) >= 2 && html.includes('loadPeriodCatalog'),
  '精算 / 拼单（及分时段目录读取）都调用门店上下文校验', count(/if \(!ensureStoreSelected\(\)\) return;/g));
check(html.includes("storeCtx = ctx;"), '成功查询后记录查询上下文');
check(/storeQuerySeq/.test(html) && /#kwInput'\)\.addEventListener\('input'/.test(html), '换关键词时清空门店选择并要求重查');

// ---------------------------------------------------------------- R12
console.log('\n[R12] 版本徽标不硬编码');
check(!html.includes('v1.3'), 'HTML 里不再有 v1.3 字面量');
check(html.includes('id="verPill"'), '版本徽标有稳定 id（verPill）');
check(html.includes("jget('/api/health')"), '页面加载读取 GET /api/health');
check(/el\.textContent\s*=\s*\(h && h\.version\)/.test(html), '把 health.version 写入徽标');
check(html.includes("'版本未知'") && count(/'版本未知'/g) >= 2, '请求失败显示「版本未知」而非固定值');

// ---------------------------------------------------------------- R14
console.log('\n[R14] 样式与信息层级');
check(html.includes('type="text" class="m-alias"') && html.includes('type="text" class="m-wishes"') && html.includes('type="text" class="m-taboos"'),
  '代称 / 心愿 / 禁忌 input 补 type="text"（视觉与其它控件一致）');
check(/input:not\(\[type=checkbox\]\):not\(\[type=radio\]\), select, textarea/.test(html), 'CSS 仍覆盖带 type 的输入框（排除 checkbox / radio）');
check(!html.includes('class="mhead"'), '移除六列表头 .mhead（不再依赖表头对齐）');
check(/class="m-field m-f-wishes"/.test(html) && /class="m-field m-f-taboos"/.test(html) && /class="m-field m-f-notes"/.test(html),
  '成员卡改为「字段标签 + 明确分组」的卡片式布局');
check(/<details class="adv repl">/.test(html) && !/<details class="adv repl" open>/.test(html) && html.includes('可替换选项'),
  '「可替换选项」折叠容器存在且默认收起');
// v1.4.6 R10：技术诊断/候选榜整体移出消费者结果页，进入「高级数据管理」
check(html.includes('查询与候选诊断（后台）') && html.includes('id="dataDiagnostics"'), '技术信息移入「高级数据管理」诊断区');
check(!html.includes('技术诊断（候选池 / 建池统计 / 缓存）'), '消费者结果页不再出现技术诊断折叠块');
check(/function diagnosticsChipsOf/.test(html) && /候选池/.test(slice('function diagnosticsChipsOf', 900)), '候选池 / 建池统计位于后台诊断（diagnosticsChipsOf）');
check((html.match(/setDataDiagnostics\(/g) || []).length >= 2, '精算与拼单都把诊断写入后台面板');

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
