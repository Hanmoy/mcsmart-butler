// v1.4.4 CLI 行为回归（R17 / R18）
// 运行：npm test 或 node scripts/test-v144-cli.mjs（需先 tsc）
//
//   R17 批量导入坏项不得中途退出、不得部分落盘：合法项（含坏项之后的）必须全部写入，
//       坏项计 rejected，stdout 只输出一个完整汇总信封；单条命令仍保持原信封与退出码。
//   R18 停其它端口不得误删运行面板的 PID 记录；停对应端口才终止实例并清除记录。
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..'));
const CLI = join(ROOT, 'dist', 'cli.js');
const home = mkdtempSync(join(tmpdir(), 'mcsmart-v144-cli-'));
const tmp = mkdtempSync(join(tmpdir(), 'mcsmart-v144-cli-tmp-'));
let failures = 0;
const check = (cond, label) => { if (cond) console.log(`  ✓ ${label}`); else { console.error(`  ✗ ${label}`); failures++; } };

function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: tmp, encoding: 'utf-8',
    env: { ...process.env, MCSMART_HOME: home, MCD_MCP_TOKEN: '', MEITUAN_UNION_APPKEY: '', MEITUAN_UNION_APPSECRET: '', ...extraEnv },
  });
  let json = null;
  try { json = JSON.parse((r.stdout ?? '').trim()); } catch { /* 非单一 JSON */ }
  return { ...r, json };
}

// 环境探测：无法 spawn 子进程时明确跳过（真实环境仍执行）
{
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf-8' });
  if (probe.error || probe.stdout !== 'ok') {
    console.log(`【v1.4.4 CLI 回归】环境限制：无法启动 node 子进程（${probe.error?.code ?? 'no-stdout'}），本套跳过。`);
    process.exit(0);
  }
}

const recipe = (id, name) => ({
  id, name,
  items: [{ mode: 'fixed', keyword: '巨无霸', qty: 1 }],
  conditions: { orderType: 'instore' }, priceCents: 1000, originalPriceCents: 0,
  buyPath: 'x', redeemPath: 'y', evidence: 'e2e', verifiedAt: '2026-10-16', ruleVersion: 'v1',
});

// ---------- R17 批量导入：坏项不中断、不部分落盘、单一信封 ----------
console.log('【R17】CLI 批量导入：坏项计 rejected，合法项全部落盘，输出单一汇总信封');
{
  const batch = [recipe('rcp-r17-a', '甲券'), { name: '缺 id 的坏项', items: [{ mode: 'fixed', keyword: '巨无霸' }] }, recipe('rcp-r17-c', '丙券')];
  const file = join(tmp, 'batch-r17.json');
  writeFileSync(file, JSON.stringify(batch), 'utf-8');
  const r = run(['voucher', 'recipe', 'import', '--file', file]);
  check(r.status === 0, `退出码 0（实际 ${r.status}）`);
  check(r.json?.ok === true, 'stdout 是单一成功信封（可整体解析为 JSON）');
  check(r.json?.data?.imported === 2, `合法项导入 2 条（实际 ${r.json?.data?.imported}）`);
  check(r.json?.data?.skipped === 1, `坏项计 skipped=1（实际 ${r.json?.data?.skipped}）`);
  check(Array.isArray(r.json?.data?.rejected) && r.json.data.rejected.length === 1, 'rejected 携带 1 条具体原因');
  check(/#2/.test(r.json?.data?.rejected?.[0] ?? ''), `rejected 指出坏项位置（${r.json?.data?.rejected?.[0] ?? '无'}）`);

  const list = run(['voucher', 'recipe', 'list']);
  const ids = (list.json?.data?.recipes ?? []).map((x) => x.id);
  check(ids.includes('rcp-r17-a') && ids.includes('rcp-r17-c'), `坏项之后的合法项也已落盘（A=${ids.includes('rcp-r17-a')} C=${ids.includes('rcp-r17-c')}）`);

  // 单条命令向后兼容：仍是错误信封 + 退出码 2
  const bad = join(tmp, 'noid-r17.json');
  writeFileSync(bad, JSON.stringify({ name: '无 id', items: [{ mode: 'fixed', keyword: '巨无霸' }] }), 'utf-8');
  const v = run(['voucher', 'recipe', 'verify', '--file', bad]);
  check(v.status === 2 && v.json?.ok === false && v.json?.error?.code === 'E_INPUT_INVALID', `单条 verify 保持原信封与退出码 2（实际 ${v.status}/${v.json?.error?.code}）`);
  const a = run(['voucher', 'recipe', 'add', '--file', bad]);
  check(a.status === 2 && a.json?.error?.code === 'E_INPUT_INVALID', `单条 add 保持原信封与退出码 2（实际 ${a.status}/${a.json?.error?.code}）`);
}

// ---------- R18 停其它端口不得误删运行面板 PID 记录 ----------
console.log('【R18】ui --stop：停其它端口保留记录；停对应端口才终止并清除');
{
  const pidFile = join(home, 'panel.pid');
  // 启动一个长期驻留进程并记录其真实 pid
  const pidOut = join(tmp, 'sleeper.pid');
  const sleeper = spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1000)', pidOut], { stdio: 'ignore' });
  const deadline = Date.now() + 5000;
  while (!existsSync(pidOut) && Date.now() < deadline) { /* busy wait */ }
  const sleeperPid = Number(readFileSync(pidOut, 'utf-8').trim());
  check(Number.isFinite(sleeperPid) && sleeperPid > 0, `驻留进程已启动（pid=${sleeperPid}）`);

  writeFileSync(pidFile, JSON.stringify({ pid: sleeperPid, port: 19999, startedAt: '2026-10-16T00:00:00.000Z' }), 'utf-8');
  const stopOther = run(['ui', '--stop', '--port', '18888']);
  check(stopOther.status === 0, `停其它端口命令成功（实际 ${stopOther.status}）`);
  check(existsSync(pidFile), '停其它端口后 PID 记录仍保留（未误删）');
  check(JSON.parse(readFileSync(pidFile, 'utf-8')).pid === sleeperPid, '保留的记录内容未被篡改');
  // 驻留进程应仍存活
  let alive = true;
  try { process.kill(sleeperPid, 0); } catch { alive = false; }
  check(alive, '驻留进程未被误杀');

  const stopSelf = run(['ui', '--stop', '--port', '19999']);
  check(stopSelf.status === 0, `停对应端口命令成功（实际 ${stopSelf.status}）`);
  check(!existsSync(pidFile), '停对应端口后 PID 记录被清除');
  let gone = false;
  try { process.kill(sleeperPid, 0); } catch { gone = true; }
  check(gone, '对应实例已被终止');

  try { sleeper.kill('SIGKILL'); } catch { /* */ }
}

try { rmSync(home, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
console.log(failures === 0 ? '\nv1.4.4 CLI 行为回归全部通过 ✓' : `\n${failures} 项未通过 ✗`);
process.exitCode = failures === 0 ? 0 : 1;
