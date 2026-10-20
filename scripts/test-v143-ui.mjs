// v1.4.3 券面核验/营养补录操作面板静态契约检查。
// 当前不装入浏览器自动化依赖；同时用 vm.Script 校验内联脚本语法。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i);
assert.ok(scriptMatch, '主页面存在 inline script');
new Script(scriptMatch[1], { filename: 'public/index.html:inline-script' });

const checks = [];
const check = (cond, label) => { assert.ok(cond, label); checks.push(label); };

check(html.includes('id="openDataManagement"') && html.includes('id="mode-recipes"') && html.includes("switchMode('recipes')"), '高级数据管理次级入口可打开配方与营养管理页');
check(html.includes('人工核验草稿') && html.includes('startRecipeFromDeal'), '最近查询团单可载入人工核验草稿');
check(html.includes('id="recipeHeadUrl"') && html.includes('id="recipeImagePreview"') && html.includes('safeHttpUrl'), '券面图 URL 仅允许 http(s) 并提供图片预览/外链');
check(html.includes('图片可辅助读出可见商品文字，但不等于完整券面构成证据'), '明示视觉候选不等于组成证据');
check(html.includes("'/api/recipes/verify'") && html.includes("'/api/recipes'"), '先调用核验 API，再调用保存 API');
check(html.includes("lastRecipeCheck=null; $('#saveRecipeBtn').disabled=true"), '草稿变更会清除旧核验结果并禁用保存');
check(html.includes('id="forceRecipeSave"') && html.includes("...(force?{force:true}:{})"), '强制保存必须勾选明确确认框');
check(html.includes('const binding=combo?{comboCode:combo.code') && html.includes('roundIds:(combo.rounds||[])'), '草稿提交时用当前官方套餐 code 与轮次绑定');
check(html.includes("'/api/recipes/menu-candidates?storeCode='"), '从当前门店 API 获取官方套餐 code/轮次');
check(html.includes("'/api/nutrition/resolve?name='"), '营养补录前可检查官方库/现有补录命中');
check(html.includes("'/api/nutrition-supplements'"), '营养补录经 API 保存并读取来源');
check(html.includes("'/api/recipes/'") && html.includes("'/api/nutrition-supplements/'"), '用户层配方和营养补录可删除');
check(html.includes('official-web') && html.includes('官网命中仍优先'), '解释官方营养值优先，补录不覆盖');
check(html.includes('nutritionSource') && html.includes('nutritionSources'), '方案清单显示营养来源追溯信息');
check(server.indexOf("url.pathname === '/api/recipes'") < server.indexOf('const client = requireClient();'), '本地配方读写 API 位于 Token gate 之前');
check(server.indexOf("url.pathname === '/api/recipes/menu-candidates'") > server.indexOf('const client = requireClient();'), '官方菜单/SKU 候选读取要求 Token 并走当前门店');
check(server.includes("sourceTypes = ['official', 'brand', 'third-party', 'secondary', 'user', 'unknown']"), 'API 限定可识别的来源分级');
check(html.includes('recipeDraftProductViewSign') && html.includes('recipeDraftSkuViewId'), '人工核验草稿保留 CPS 商品身份（productViewSign/skuViewId）');
check(html.includes('...(recipeDraftProductViewSign?{productViewSign:recipeDraftProductViewSign}:{})')
  && html.includes('...(recipeDraftSkuViewId?{skuViewId:recipeDraftSkuViewId}:{})'), '草稿提交时回写 productViewSign/skuViewId（缺失即不写，两 ID 不互填）');
check(html.includes('...(safeHttpUrl($(\'#recipeHeadUrl\').value.trim())?{headUrl:safeHttpUrl($(\'#recipeHeadUrl\').value.trim())}:{})'), '草稿 headUrl 仅接受 http(s)（与券面图预览同校验）');

console.log(`v1.4.3 面板静态检查通过：${checks.length} 项；未做真实浏览器走查`);
