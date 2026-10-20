#!/usr/bin/env node
// mcsmart-butler 启动器：定位 runtime/dist/cli.js 并执行。
// 路径按本文件自身位置解析（安装目录自包含），不依赖进程当前工作目录。
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(code, message, hint) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message, hint } }, null, 1) + '\n');
  process.exit(3);
}

// Node >= 20 是硬前提（AbortSignal.timeout / structuredClone / ESM 特性）
const [major] = process.versions.node.split('.').map(Number);
if (!(major >= 20)) {
  fail('E_LAYOUT', `Node.js 版本过低（当前 ${process.versions.node}，需要 >= 20）`,
    '升级 Node.js 20 LTS 或更高版本后重试：https://nodejs.org/');
}

try {
  const here = dirname(fileURLToPath(import.meta.url));
  const mod = await import(pathToFileURL(join(here, 'runtime', 'dist', 'cli.js')).href);
  await mod.main(process.argv.slice(2));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ERR_MODULE_NOT_FOUND/.test(msg) && /highs/.test(msg)) {
    fail('E_LAYOUT', '求解器组件（HiGHS）缺失或安装包不完整', '重新安装发布包（scripts/runtime/node_modules 必须完整）；运行前可先执行 node scripts/mcsmart.mjs doctor 排查');
  }
  fail('E_LAYOUT', `程序加载失败：${msg.slice(0, 300)}`, '安装包可能不完整（需要 SKILL.md + scripts/runtime/dist + scripts/data 齐全），请重新安装；或运行 doctor 排查');
}
