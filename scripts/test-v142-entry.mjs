// v1.4.2 技能入口与发布一致性验收
//   R11  泛化开始请求 → ui --open；启动/复用两分支共用「打开浏览器」步骤（复用不得跳过）
//   R12  版本单一来源：package.json → APP_VERSION → CLI version / /api/health
//   启动 总截止时间语义 + 子进程日志落盘脱敏
// 运行：npx tsc --outDir .build-e && MCSMART_BUILD=../.build-e node scripts/test-v142-entry.mjs
// 隔离 MCSMART_HOME，不污染真实数据；不触发真实浏览器（注入 __uiHooks.openBrowser）。
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v142-'));
process.env.MCSMART_HOME = TEST_HOME;
process.env.MCD_MCP_TOKEN = '';
process.env.MEITUAN_UNION_APPKEY = '';
process.env.MEITUAN_UNION_APPSECRET = '';
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const BASE = process.env.MCSMART_BUILD ?? '../dist';
const baseUrl = new URL(`${BASE}/`, import.meta.url);
const buildDir = fileURLToPath(baseUrl);
const cli = await import(new URL('cli.js', baseUrl).href);

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? `（${detail}）` : ''}`); failures++; }
};

/** 捕获 main() 写到 stdout 的结构化 JSON（main 成功路径只 emit 一次） */
async function captureMain(argv) {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = (chunk) => { buf += String(chunk); return true; };
  try { await cli.main(argv); } finally { process.stdout.write = orig; }
  return JSON.parse(buf.trim());
}

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// ========== R11 入口 ==========
console.log('【R11】入口：泛化开始 → ui --open；启动/复用共用打开步骤');
{
  check(cli.decideUiAction({ ok: true, name: 'mcsmart-butler' }) === 'reuse', '已运行本面板 → reuse');
  check(cli.decideUiAction({ ok: true, name: 'other' }) === 'port-busy', '他程序占用端口 → port-busy');
  check(cli.decideUiAction(null) === 'start', '无面板 → start');

  const w = cli.browserOpenPlan('http://127.0.0.1:8787/', 'win32');
  check(w.cmd === 'cmd' && w.args.includes('http://127.0.0.1:8787/'), 'win32 打开命令含 url', `${w.cmd} ${w.args.join(' ')}`);
  check(cli.browserOpenPlan('http://x/', 'darwin').cmd === 'open', 'darwin 用 open');
  check(cli.browserOpenPlan('http://x/', 'linux').cmd === 'xdg-open', 'linux 用 xdg-open');

  // 端到端：本机已运行面板（模拟）→ ui --open 必须执行打开（旧实现复用分支提前 return 跳过）
  const panel = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'mcsmart-butler', version: 'test', pid: process.pid, tokenConfigured: false }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => panel.listen(0, '127.0.0.1', r));
  const port = panel.address().port;
  const opened = [];
  cli.__uiHooks.openBrowser = (url) => { opened.push(url); return true; };

  const withOpen = await captureMain(['ui', '--open', '--port', String(port)]);
  check(withOpen.ok === true && withOpen.data.action === 'reuse', '复用分支返回 action=reuse', withOpen.data?.action);
  check(opened.length === 1 && opened[0] === `http://127.0.0.1:${port}/`, '复用分支执行了打开浏览器（旧实现跳过）', JSON.stringify(opened));
  check(withOpen.data.opened === true, '返回体标记 opened=true');

  opened.length = 0;
  const noOpen = await captureMain(['ui', '--port', String(port)]);
  check(noOpen.data.action === 'reuse' && opened.length === 0, '未传 --open 时仅返回 url、不打开');

  delete cli.__uiHooks.openBrowser;
  await new Promise((r) => panel.close(r));

  // SKILL.md 文本约定
  const skillMd = readFileSync(join(ROOT, 'skill-template', 'SKILL.md'), 'utf-8');
  check(skillMd.includes('先运行 `mcsmart ui --open`'), 'SKILL.md 规定泛化开始先执行 ui --open');
  check(skillMd.includes('不要在菜单选项里要求用户先选择'), 'SKILL.md 明确不先让用户选菜单');
  check(skillMd.includes('有明确任务'), 'SKILL.md 区分「有明确任务」直接执行');
  check(skillMd.includes('不要把全量 doctor 放在每次打开之前'), 'SKILL.md 打开前不跑全量 doctor');
}

// ========== R12 版本单一来源 ==========
console.log('【R12】版本单一来源：package.json → APP_VERSION → CLI/health');
{
  const cfg = await import(new URL('config.js', baseUrl).href);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  check(cfg.APP_VERSION === pkg.version, `APP_VERSION 派生自 package.json（${pkg.version}）`, cfg.APP_VERSION);
  check(cfg.APP_VERSION_SOURCE === 'package.json', '版本来源标记 = package.json', cfg.APP_VERSION_SOURCE);

  const v = await captureMain(['version']);
  check(v.data.version === pkg.version, 'CLI version = package.json 版本', v.data.version);
  check(v.data.versionSource === 'package.json', 'CLI version 暴露来源', v.data.versionSource);

  // /api/health 版本一致（启动编译产物 server.js）
  const serverJs = join(buildDir, 'server.js');
  check(existsSync(serverJs), '编译产物 server.js 存在', serverJs);
  if (existsSync(serverJs)) {
    const sPort = await freePort();
    let errBuf = '';
    const child = spawn(process.execPath, [serverJs], {
      env: { ...process.env, PORT: String(sPort), MCSMART_UI_CHILD: '1', MCSMART_HOME: TEST_HOME },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (d) => { errBuf += String(d); });
    let health = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${sPort}/api/health`, { signal: AbortSignal.timeout(800) });
        if (res.ok) { health = await res.json(); break; }
      } catch { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    child.kill();
    check(!!health, '面板服务可启动并响应 /api/health', health ? `pid=${health.pid}` : errBuf.slice(0, 200));
    check(health?.version === pkg.version, '/api/health version = package.json 版本', health?.version);
  }

  // 打包前一致性校验：源码/产物/SKILL.md 三处不一致必须抛错
  const pack = await import(new URL('./package-skill.mjs', import.meta.url).href);
  const stage = join(TEST_HOME, 'fake-stage');
  mkdirSync(stage, { recursive: true });
  const writeStage = (skillV, versionV, installedV) => {
    writeFileSync(join(stage, 'SKILL.md'), `---\nname: mcsmart-butler\nversion: "${skillV}"\n---\n`, 'utf-8');
    writeFileSync(join(stage, 'VERSION'), `${versionV}\n`, 'utf-8');
    writeFileSync(join(stage, '.installed.json'), JSON.stringify({ version: installedV }), 'utf-8');
  };

  writeStage('1.4.1', '1.4.1', '1.4.1');
  let ok = true, msg = '';
  try { pack.assertVersionConsistency({ sourceVersion: '1.4.1', targetVersion: '1.4.1', stage }); } catch (e) { ok = false; msg = e.message; }
  check(ok, '三处一致 → 校验通过', msg.slice(0, 80));

  writeStage('1.4.0', '1.4.1', '1.4.1');
  let diff = '';
  try { pack.assertVersionConsistency({ sourceVersion: '1.4.1', targetVersion: '1.4.1', stage }); } catch (e) { diff = e.message; }
  check(/SKILL\.md/.test(diff) && /1\.4\.0/.test(diff), 'SKILL.md 版本不一致 → 抛错并打印差异', diff.replace(/\n/g, ' | ').slice(0, 140));

  writeStage('1.4.2', '1.4.2', '1.4.2');
  let ov = '';
  try { pack.assertVersionConsistency({ sourceVersion: '1.4.1', targetVersion: '1.4.2', stage }); } catch (e) { ov = e.message; }
  check(/--version/.test(ov), '--version 覆盖与 package.json 不一致 → 抛错', ov.slice(0, 120));

  // 版本来源完全不可读 → 明确回退 0.0.0-dev（绝不静默回退成过期版本号）
  const orphan = mkdtempSync(join(tmpdir(), 'mcsmart-v142-orphan-'));
  try {
    copyFileSync(join(buildDir, 'config.js'), join(orphan, 'config.js'));
    copyFileSync(join(buildDir, 'paths.js'), join(orphan, 'paths.js'));
    const orphanCfg = await import(new URL('config.js', pathToFileURL(join(orphan, 'config.js'))).href);
    check(orphanCfg.APP_VERSION === '0.0.0-dev', '无法读取版本来源 → 回退 0.0.0-dev', orphanCfg.APP_VERSION);
    check(orphanCfg.APP_VERSION_SOURCE === 'fallback', '来源标记 = fallback（诊断可如实暴露）', orphanCfg.APP_VERSION_SOURCE);
  } finally {
    rmSync(orphan, { recursive: true, force: true });
  }
}

// ========== 启动：总截止时间 + 日志脱敏 ==========
console.log('【启动】总截止时间语义 + 日志脱敏');
{
  // 截止时间语义：探测恒失败 → 在截止时间内收敛返回 null（非「固定 sleep × 次数」叠加）
  let t = 0, probes = 0;
  const res = await cli.waitForPanelReady(async () => { probes++; return null; },
    { deadlineMs: 2000, intervalMs: 500, now: () => t, sleep: async (ms) => { t += ms; } });
  check(res === null, '超时返回 null');
  check(t <= 2000, '总耗时不超过截止时间', `elapsed=${t}ms probes=${probes}`);
  check(probes <= 6, '探测次数受截止时间约束（旧实现固定 20 次）', `probes=${probes}`);

  // 先探后等：就绪即返回，无固定首等 500ms
  let t2 = 0, n = 0;
  const okRes = await cli.waitForPanelReady(
    async () => { n++; return n >= 3 ? { ok: true, name: 'mcsmart-butler' } : null; },
    { deadlineMs: 5000, intervalMs: 500, now: () => t2, sleep: async (ms) => { t2 += ms; } });
  check(okRes?.ok === true && n === 3, '就绪后立即返回（无固定首等）', `n=${n} t=${t2}ms`);

  // 脱敏：含 appSecret / Bearer / JSON token / env token 的假日志
  const fake = '[panel] boot appSecret=abc123secret token=deadbeef Authorization: Bearer eyJhbGciOi.J9xx.more {"mcdMcpToken":"tok-98765"} mcd_mcp_token=zzzsecret';
  const out = cli.redactLog(fake);
  check(!out.includes('abc123secret'), 'appSecret 值被脱敏');
  check(!out.includes('deadbeef'), 'token 值被脱敏');
  check(!out.includes('eyJhbGciOi.J9xx.more'), 'Bearer 值被脱敏');
  check(!out.includes('tok-98765'), 'JSON token 值被脱敏');
  check(!out.includes('zzzsecret'), 'env 形式 token 值被脱敏');
  check(out.includes('appSecret='), '保留键名便于定位（仅替换值）');
}

console.log(failures === 0 ? '\nv1.4.2 入口与发布一致性验收全部通过 ✓' : `\nv1.4.2 验收失败 ${failures} 项 ✗`);
process.exit(failures === 0 ? 0 : 1);
