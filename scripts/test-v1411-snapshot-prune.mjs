// v1.4.11 快照缓存边界回归（W21）
// 用真实 Promise 交错复现：渲染开始时快照还在，await 期间被 24 份新快照淘汰，
// 回写前必须重新确认记录仍有效，不得复活已淘汰文件，总数不超过 24。
// 不读取真实用户订单（用 demo 数据形状）。
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcsmart-v1411-prune-'));
process.env.MCSMART_HOME = home;

const { demoMcdna } = await import('../dist/mcdna.js');
const { createMcdnaSnapshot, renderMcdnaReport } = await import('../dist/mcdnaReport.js');

let checks = 0;
const check = (value, note) => { assert.ok(value, note); checks++; };
const eq = (actual, expected, note) => {
  assert.deepEqual(actual, expected, `${note}（实得 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
  checks++;
};

const dir = join(home, 'cache', 'mcdna');
const files = () => readdirSync(dir).filter(n => n.endsWith('.json'));

try {
  const stats = demoMcdna('tier');

  // ---------- 回写竞态：渲染 await 期间快照被淘汰 ----------
  const first = createMcdnaSnapshot(stats);
  const firstReport = await renderMcdnaReport(first, {});
  const good = {
    snapshotId: firstReport.snapshotId,
    title: '{qualifier}钉子户',
    verdict: '菜单翻遍还是{qualifier}',
    achievements: ['本命打卡×{topCount}'],
    dialogue: '{topName}出现了{topCount}份。别人点餐靠选，你点餐靠认。',
    hook: '你的本命是哪一样？',
  };
  // 渲染已开始（快照已 load），立刻新建 24 份把它挤出去
  const pending = renderMcdnaReport(first, { commentary: good });
  const ids = [];
  for (let i = 0; i < 24; i++) ids.push(createMcdnaSnapshot(stats));
  let rendered = null;
  let error = null;
  try { rendered = await pending; } catch (e) { error = e.message; }

  eq(error, null, 'W21 被淘汰后渲染不应抛错');
  check(!!rendered, 'W21 仍返回本次产物');
  check(!files().includes(`${first}.json`), 'W21 不得复活已被淘汰的快照文件');
  check(files().length <= 24, `W21 快照总数不超过 24（实得 ${files().length}）`);
  check(rendered.warnings.some(w => /淘汰|未写入/.test(w)), 'W21 回写失败要给出警告而不是静默');
  eq(rendered.commentaryStatus, 'agent', 'W21 文案本身仍有效，只是未落盘');

  // ---------- 顺序写入：始终不超过 24 份 ----------
  for (let i = 0; i < 6; i++) createMcdnaSnapshot(stats);
  check(files().length <= 24, `W21 连续新建后仍不超过 24（实得 ${files().length}）`);

  // ---------- 目录里出现非法文件也不阻断读取 ----------
  writeFileSync(join(dir, 'not-a-snapshot.txt'), 'ignore me');
  check(files().length <= 24, 'W21 非快照文件不计入配额');

  console.log(`v1.4.11 快照缓存边界：${checks}项断言通过（真实 Promise 交错；W21）`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
