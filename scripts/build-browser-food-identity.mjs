// 将纯食品身份规则嵌入面板。后端/网页/静态 demo 只维护 src/foodIdentity.ts。
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function syncBrowserFoodIdentity({ check = false } = {}) {
  const source = readFileSync(new URL('../src/foodIdentity.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, removeComments: true } }).outputText.replace(/^export /gm, '').trim();
  const hash = createHash('sha256').update(source).digest('hex');
  const generated = '// BEGIN SHARED_FOOD_IDENTITY\n'
    + '// Generated from src/foodIdentity.ts; sha256=' + hash + '\n'
    + 'const sharedFoodKeyOf = (()=>{\n' + js + '\nreturn foodKeyOf;\n})();\n'
    + '// END SHARED_FOOD_IDENTITY';
  const path = new URL('../public/index.html', import.meta.url);
  const html = readFileSync(path, 'utf8');
  const marker = /\/\/ BEGIN SHARED_FOOD_IDENTITY[\s\S]*?\/\/ END SHARED_FOOD_IDENTITY/;
  if (!marker.test(html)) throw new Error('面板缺少食品身份生成区块');
  const updated = html.replace(marker, () => generated);
  if (check && updated !== html) throw new Error('网页食品身份规则过期，请运行 npm run build');
  if (!check && updated !== html) writeFileSync(path, updated, 'utf8');
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  syncBrowserFoodIdentity({ check: process.argv.includes('--check') });
}
