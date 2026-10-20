#!/usr/bin/env node
// 券配方种子镜像生成（v1.4.5）
//
// 唯一公共来源：src/voucherRecipes.ts 的 PRESET_RECIPES。
// data/voucher-recipes-seed.json 是它的**随包镜像**（打包脚本会复制并断言两者内容一致）。
// 修改预置配方后必须运行本脚本重新生成镜像，否则打包在「券配方种子断言」处失败。
//
// 用法：node scripts/sync-recipe-seed.mjs [--check]
//   --check  只校验不写入；不一致时退出 1（可用于 CI / npm test）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SEED = path.join(ROOT, 'data', 'voucher-recipes-seed.json');
const checkOnly = process.argv.includes('--check');

const { PRESET_RECIPES } = await import(pathToFileURL(path.join(ROOT, 'dist', 'voucherRecipes.js')).href);
if (!Array.isArray(PRESET_RECIPES) || PRESET_RECIPES.length === 0) {
  console.error('PRESET_RECIPES 为空或不可读（先运行 tsc 编译）');
  process.exit(1);
}

const next = {
  version: 1,
  updatedAt: new Date().toISOString().slice(0, 10),
  source: `麦当劳美团团购真实券面核验预置种子（v1.4.5，与 PRESET_RECIPES 同步，共 ${PRESET_RECIPES.length} 条）`,
  recipes: PRESET_RECIPES,
};

const current = fs.existsSync(SEED) ? JSON.parse(fs.readFileSync(SEED, 'utf8')) : null;
const same = current && JSON.stringify(current.recipes) === JSON.stringify(PRESET_RECIPES);

if (checkOnly) {
  if (!same) {
    console.error(`配方种子漂移：${SEED} 与 PRESET_RECIPES 不一致（种子 ${current?.recipes?.length ?? 0} 条 / 源码 ${PRESET_RECIPES.length} 条）`);
    process.exit(1);
  }
  console.log(`配方种子一致：${PRESET_RECIPES.length} 条`);
  process.exit(0);
}

if (same) {
  console.log(`配方种子已是最新：${PRESET_RECIPES.length} 条`);
} else {
  fs.writeFileSync(SEED, JSON.stringify(next, null, 1) + '\n');
  console.log(`配方种子已更新：${PRESET_RECIPES.length} 条 → ${SEED}`);
}
