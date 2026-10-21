// 浏览器行为回归启动器：自动定位一个「装有 Playwright」的 Python 解释器再运行三套浏览器测试。
// 背景：不同机器的 python 可能未安装 Playwright；可用 PYTHON 指定解释器。
// 运行：npm run test:browser；CI 设置 MCSMART_REQUIRE_BROWSER=1 时，找不到解释器直接失败。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = ['test-v144-browser.py', 'test-mcdna-browser.py', 'test-v1411-browser.py', 'test-static-demo.py'].map(name => join(here, name));

const candidates = [process.env.PYTHON, 'python', 'python3', 'py'].filter(Boolean);

const hasPlaywright = (cmd) => {
  const r = spawnSync(cmd, ['-c', 'import playwright'], { encoding: 'utf-8' });
  return !r.error && r.status === 0;
};

let chosen = null;
for (const c of candidates) {
  if (c.includes('/') || c.includes('\\')) { if (!existsSync(c)) continue; }
  if (hasPlaywright(c)) { chosen = c; break; }
}

if (!chosen) {
  console.log('【浏览器行为回归】未找到装有 Playwright 的 Python 解释器，本套跳过（可设置环境变量 PYTHON 指定解释器；CI 请设置 MCSMART_REQUIRE_BROWSER=1）。');
  process.exit(process.env.MCSMART_REQUIRE_BROWSER === '1' ? 1 : 0);
}

console.log(`【浏览器行为回归】使用解释器：${chosen}`);
for (const script of scripts) {
  const run = spawnSync(chosen, ['-X', 'utf8', script], { stdio: 'inherit', cwd: dirname(here) });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
process.exit(0);
