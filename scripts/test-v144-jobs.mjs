// v1.4.4 异步任务终态回归（R15）
// 运行：npm test 或 node scripts/test-v144-jobs.mjs（需先 tsc）
//
//   R15 取消后的迟到回执不得把任务标成完成：真实本地 HTTP + 模拟上游（延迟后失败），
//       在菜单等待期取消 → 终态必须是 done + cancelled + 非「完成」、丢弃结果、带 E_CANCELLED；
//       未取消的任务仍正常走完（不误伤正常路径）。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v144-jobs-'));
const PORT = 18983;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (cond, label) => { if (cond) console.log(`  ✓ ${label}`); else { console.error(`  ✗ ${label}`); failures++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 模拟上游 shim：把麦当劳 MCP 请求延迟后置为失败，制造「取消发生在菜单等待期间、随后服务走降级路径」的迟到回执
const stubPath = join(HOME, 'mcp-stub.mjs');
writeFileSync(stubPath, `
const realFetch = globalThis.fetch;
const DELAY = Number(process.env.MCP_STUB_DELAY_MS || 1500);
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.includes('mcp.mcd.cn')) { await new Promise((r) => setTimeout(r, DELAY)); throw new Error('stub: 模拟上游不可达'); }
  return realFetch(input, init);
};
`, 'utf-8');

const child = spawn(process.execPath, ['--import', pathToFileURL(stubPath).href, join(ROOT, 'dist', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, MCSMART_HOME: HOME, PORT: String(PORT), MCD_MCP_TOKEN: 'stub-token-1234567890', MCP_STUB_DELAY_MS: '1500' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });
const cleanup = () => { try { child.kill('SIGKILL'); } catch { /* */ } try { rmSync(HOME, { recursive: true, force: true }); } catch { /* */ } };
process.on('exit', cleanup);

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return true; } catch { /* */ }
    await sleep(150);
  }
  return false;
}
async function startGroup(body) {
  const r = await fetch(`${base}/api/jobs/group-solve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}
async function poll(jobId) {
  let st = null;
  for (let i = 0; i < 120; i++) {
    st = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
    if (st.done) return st;
    await sleep(150);
  }
  return st;
}

console.log('【R15】取消成为明确终态：迟到回执不得把任务改写成「完成」');
try {
  const up = await waitUp();
  check(up, '面板本机服务已启动（真实 HTTP）');
  if (!up) throw new Error('服务未启动：' + childLog.slice(0, 400));

  const body = { storeCode: 'S1', storeName: '测试门店', members: [{ alias: '甲', wishes: ['巨无霸'], taboos: [] }] };
  const started = await startGroup(body);
  check(started.status === 202 && !!started.json.jobId, `异步任务已受理（202 / ${started.json.jobId}）`);

  const cancel = await fetch(`${base}/api/jobs/${started.json.jobId}/cancel`, { method: 'POST' });
  check(cancel.ok, '取消请求已受理');

  const st = await poll(started.json.jobId);
  console.log('    终态:', JSON.stringify({ stage: st?.stage, done: st?.done, cancelled: st?.cancelled, code: st?.code, hasResult: !!st?.result, error: st?.error }));
  check(st?.done === true, '任务进入终态 done=true');
  check(st?.cancelled === true, '取消标记保留 cancelled=true');
  check(st?.stage !== '完成', `阶段不再是「完成」（实际「${st?.stage}」）`);
  check(!st?.result, '迟到结果被丢弃（无 result）');
  check(st?.code === 'E_CANCELLED', `带明确取消错误码 E_CANCELLED（实际 ${st?.code}）`);

  // 正常路径不受影响
  const started2 = await startGroup(body);
  const st2 = await poll(started2.json.jobId);
  check(st2?.done === true && st2?.cancelled === false && !st2?.error, `未取消任务正常走完（stage=${st2?.stage}, error=${st2?.error ?? '无'}）`);
} catch (e) {
  check(false, `执行异常：${e instanceof Error ? e.message : String(e)}`);
} finally {
  cleanup();
}

console.log(failures === 0 ? '\nv1.4.4 异步任务终态回归全部通过 ✓' : `\n${failures} 项未通过 ✗`);
process.exitCode = failures === 0 ? 0 : 1;
