// 统一 CLI 入口（Skill 化改造 #2）：mcsmart.mjs（发布包薄启动器）加载本模块的编译产物。
//   设计约定：
//   - 复杂输入一律走 UTF-8 JSON 文件（--file）或标准输入（--stdin），规避 Windows 命令行
//     引号与中文转义问题；简单标量（城市/关键词）用命令行参数。
//   - 正常结果 = 结构化 JSON 到 stdout；日志/进度 = stderr。两者严格分离。
//   - 错误 = 稳定错误码 + 处理建议（error.code/error.hint），智能体无需解析报错文字猜原因。
//   - 所有业务逻辑委托 service.ts（与网页同源）；本文件只做参数解析、装配与输出。
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { McpClient } from './mcp.js';
import { CONFIG, APP_VERSION, APP_VERSION_SOURCE, applyUserConfig, readCredentials } from './config.js';
import { getLayout, userHomePaths } from './paths.js';
import {
  serviceStores, serviceSolveSingle, serviceSolveGroup, serviceMcdna, serviceParseGroup, servicePeriodCatalog,
  doctorReport, classifyUpstreamError, ServiceError, validateSolveSingleInput, validateSolveGroupInput,
  type SolveSingleInput, type SolveGroupInput, type StoresInput,
} from './service.js';
import { renderSingleText, renderGroupText } from './present.js';
import { normalizeRecipeInput as normalizeRecipeInputShared, RecipeSchemaError } from './recipeSchema.js';
import { UserStoreError } from './userStore.js';
import {
  loadRecipes, saveRecipe, importRecipes, reviseRecipe, removeRecipe, validateRecipe, RecipeConflictError,
  type VoucherRecipe, type RecipeCheck,
} from './voucherRecipes.js';
import {
  saveNutritionSupplement, importNutritionSupplements,
  removeNutritionSupplement, isSeedSupplement, allSupplements, type NutritionSupplement,
} from './nutritionSupplements.js';

// ---------- 日志（stderr；级别受 CONFIG.logLevel 控制） ----------

// 凭据键名（大小写不敏感）；用于日志脱敏：命中「键 + 值」形式只替换值，保留键名便于定位
const SECRET_KEY = String.raw`(?:appsecret|app_secret|appkey|app_key|apikey|api_key|access_token|refresh_token|mcd_mcp_token|password|passwd|pwd|authorization|cookie|token|secret)`;

/**
 * 日志脱敏（写盘前必经）：移除 Token / appSecret / Bearer 等凭据值，保留键名。
 * 覆盖三种形态：Authorization: Bearer xxx、key=value / key: value、JSON "key":"value"。
 */
export function redactLog(text: string): string {
  return String(text)
    // 1) Authorization: Bearer xxx
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    // 2) JSON 形式 "key":"value"
    .replace(new RegExp(String.raw`("[A-Za-z0-9_]*` + SECRET_KEY + String.raw`[A-Za-z0-9_]*"\s*:\s*")[^"]*(")`, 'gi'), '$1***$2')
    // 3) key=value / key: value（未加引号；也覆盖 URL 查询串）
    .replace(new RegExp(String.raw`(` + SECRET_KEY + String.raw`\s*[:=]\s*)([^\s"',;)\]}&]+)`, 'gi'), '$1***');
}

function log(level: 'info' | 'debug', msg: string): void {
  if (CONFIG.logLevel === 'silent') return;
  if (level === 'debug' && CONFIG.logLevel !== 'debug') return;
  process.stderr.write(`[${new Date().toISOString()}] [${level}] ${redactLog(msg)}\n`);
}

// ---------- argv 解析（零依赖） ----------

interface Args {
  command: string;
  flags: Record<string, string | boolean>;
  /** 全部裸参数（command = positional[0]；子命令从 positional[1] 起） */
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0] ?? '', flags, positional };
}

// ---------- JSON 输入读取 ----------

async function readJsonInput(flags: Record<string, string | boolean>): Promise<unknown> {
  if (flags.file) {
    const path = String(flags.file);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (e) {
      throw new ServiceError('E_INPUT_INVALID', `无法读取输入文件 ${path}：${e instanceof Error ? e.message : String(e)}`,
        '确认文件存在且可读；路径含空格或中文时建议用 --file 传 UTF-8 JSON 文件（本命令已按 UTF-8 解码）');
    }
    try { return JSON.parse(raw); } catch (e) {
      throw new ServiceError('E_INPUT_INVALID', `输入文件不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
        '输入必须是 UTF-8 编码的 JSON 对象；样例见 references/examples.md');
    }
  }
  if (flags.stdin) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) throw new ServiceError('E_INPUT_INVALID', '--stdin 已指定但标准输入为空', '用法示例：cat input.json | mcsmart.mjs solve-single --stdin');
    try { return JSON.parse(raw); } catch (e) {
      throw new ServiceError('E_INPUT_INVALID', `标准输入不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {};
}

// ---------- 输出 ----------

function emitJson(data: unknown): void {
  process.stdout.write(JSON.stringify({ ok: true, data }, null, 1) + '\n');
}

function fail(code: string, message: string, hint?: string): never {
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } }, null, 1) + '\n');
  process.exit(EXIT_BY_CODE[code] ?? 1);
}

// R17：批量导入时，单条输入的校验错误必须是「可捕获的异常」，而不是直接结束进程。
//   旧实现里 normalizeRecipeInput 直接调用 fail() → process.exit，导致批到坏项就中途退出、
//   已写入的条目部分落盘、后续合法条目永不处理、stdout 也拿不到完整汇总信封。
//   这里把「输入不合法」表达为异常，由调用方决定：单条命令转 fail（保持原有信封与退出码），
//   批量命令计为 rejected 并继续处理。
class CliInputError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'CliInputError';
    this.code = code;
    this.hint = hint;
  }
}

/** 单条命令入口：把 CliInputError 还原成原有的 fail 信封与退出码 */
function normalizeRecipeInputOrFail(raw: unknown): VoucherRecipe {
  try {
    return normalizeRecipeInput(raw);
  } catch (e) {
    if (e instanceof CliInputError) fail(e.code, e.message, e.hint);
    throw e;
  }
}

const EXIT_BY_CODE: Record<string, number> = {
  E_INPUT_INVALID: 2, E_CONFIG_INVALID: 2,
  E_TOKEN_MISSING: 3, E_LAYOUT: 3,
  E_NETWORK: 4, E_TOKEN_INVALID: 4, E_RATE_LIMIT: 4, E_UPSTREAM: 4,
  E_STORE_CLOSED: 4, E_STORE_NOT_FOUND: 4, E_NO_SOLUTION: 5,
  E_INTERNAL: 1,
};

function handleError(e: unknown): never {
  if (e instanceof ServiceError) fail(e.code, e.message, e.hint);
  if (e instanceof CliInputError) fail(e.code, e.message, e.hint);
  // v1.4.7 R01/R13：身份冲突与落盘失败必须给出稳定错误码（不得被当成上游错误）
  if (e instanceof RecipeConflictError) {
    fail(e.code, e.message, '换一个能区分商品的配方 id（含 productViewSign/skuViewId），或先用 revise 修订既有条目');
  }
  if (e instanceof UserStoreError) {
    fail(e.code, e.message, `检查数据目录权限与磁盘空间：${e.path}`);
  }
  const msg = e instanceof Error ? e.message : String(e);
  const cls = classifyUpstreamError(msg);
  fail(cls.code, msg, cls.hint);
}

// ---------- ui 命令：操作面板（启动 / 复用 / 停止） ----------

interface PanelHealth {
  ok: boolean; name?: string; version?: string; pid?: number; tokenConfigured?: boolean; uptimeSec?: number;
}

/** 面板启动总截止时间（毫秒）与探测间隔：总时长由 deadline 约束，而非「固定 sleep × 重试次数」叠加 */
const PANEL_START_DEADLINE_MS = 10_000;
const PANEL_PROBE_INTERVAL_MS = 300;

/** 测试注入点：生产不设置即用真实实现（避免测试真的拉起浏览器/写盘） */
export const __uiHooks: {
  openBrowser?: (url: string) => boolean;
} = {};

async function probePanel(port: number): Promise<PanelHealth | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return (await res.json()) as PanelHealth;
  } catch { return null; }
}

function panelPidFile(): string {
  return join(userHomePaths(getLayout()).outDir, '..', 'panel.pid');
}

/** 进程是否存活（信号 0 只探测，不实际投递）；权限不足等异常一律视为「不可确认」→ 视为存活以免误删记录 */
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
}

/** 轮询等待进程退出；超时返回 false（表示无法确认已退出，调用方应保留记录） */
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isProcessAlive(pid);
}

/** 计算打开浏览器的启动命令（纯函数，便于单测；不实际执行） */
export function browserOpenPlan(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

/** 打开系统默认浏览器（启动与复用两条分支共用此步骤；失败不影响面板可用） */
function openBrowser(url: string): boolean {
  if (__uiHooks.openBrowser) return __uiHooks.openBrowser(url);
  try {
    const { cmd, args } = browserOpenPlan(url);
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

/** ui 动作决策（纯函数）：已运行本面板 → reuse；端口被其他程序占用 → port-busy；否则 start */
export function decideUiAction(existing: PanelHealth | null): 'reuse' | 'port-busy' | 'start' {
  if (existing?.ok && existing.name === 'mcsmart-butler') return 'reuse';
  if (existing) return 'port-busy';
  return 'start';
}

/**
 * 等待面板就绪：以「总截止时间」为界反复探测（先探后等，避免固定首等 500ms 拖慢拉起）。
 * now/sleep/probe 可注入，便于单测截止时间语义。
 */
export async function waitForPanelReady(
  probe: () => Promise<PanelHealth | null>,
  opts: { deadlineMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PanelHealth | null> {
  const deadlineMs = opts.deadlineMs ?? PANEL_START_DEADLINE_MS;
  const intervalMs = opts.intervalMs ?? PANEL_PROBE_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  for (;;) {
    const health = await probe();
    if (health?.ok) return health;
    const remaining = deadlineMs - (now() - start);
    if (remaining <= 0) return null;
    await sleep(Math.min(intervalMs, remaining));
  }
}

/** 后台进程不依赖CLI管道；server 自持结构化诊断日志，CLI退出后仍可追踪错误。 */
function spawnPanelChild(serverJs: string, port: number, logPath: string): { child: ChildProcess; detachLogging: () => void } {
  mkdirSync(dirname(logPath), { recursive: true });
  try { appendFileSync(logPath, ''); } catch { /* 确保日志文件存在，失败文案指向的路径真实存在 */ }
  const child = spawn(process.execPath, [serverJs], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, MCSMART_UI_CHILD: '1', PORT: String(port) },
  });
  child.unref();
  const detachLogging = (): void => { /* 兼容启动器流程；已无管道需解除 */ };
  return { child, detachLogging };
}

async function cmdUi(flags: Record<string, string | boolean>): Promise<void> {
  const layout = getLayout();
  const port = Number(flags.port) > 0 ? Number(flags.port) : CONFIG.uiPort;
  const url = `http://127.0.0.1:${port}/`;
  const panelLogPath = join(userHomePaths(layout).logDir, 'panel.log');
  const shouldOpen = !!flags.open;

  // --stop：关闭后台面板
  if (flags.stop) {
    const pidFile = panelPidFile();
    let killed = false;
    if (existsSync(pidFile)) {
      // R18：PID 记录只描述「本面板托管的实例」。停其它端口时不得误删这条记录——
      //   仅当记录端口与请求端口一致（确实停了对应实例），或记录的进程确已退出（记录失效）时才清除。
      let rec: { pid: number; port: number } | null = null;
      try { rec = JSON.parse(readFileSync(pidFile, 'utf-8')) as { pid: number; port: number }; } catch { rec = null; }
      if (rec && typeof rec.pid === 'number' && rec.port === port) {
        try { process.kill(rec.pid); } catch { /* 进程已不存在 */ }
        killed = true;
        // 确认对应实例已退出（或进程本就不存在）后再清除记录，避免误删仍在运行实例的句柄。
        const gone = await waitForProcessExit(rec.pid, 1000);
        if (gone) rmSync(pidFile, { force: true });
      } else if (rec && typeof rec.pid === 'number') {
        // 记录属于其它端口：进程仍存活则原样保留；确已退出才清理失效记录。
        if (!isProcessAlive(rec.pid)) rmSync(pidFile, { force: true });
      } else {
        // 记录无法解析 → 视为失效记录，清理
        rmSync(pidFile, { force: true });
      }
    }
    const still = await probePanel(port);
    if (still && !killed) {
      fail('E_INPUT_INVALID', `端口 ${port} 上的服务不是本面板托管的实例（无 PID 记录），未执行关闭`, '若确认要停掉该端口的服务，请用任务管理器或对应启动方关闭；或用 --port 指定其他端口的 mcsmart 面板');
    }
    emitJson({ ok: true, action: 'stop', port, stopped: killed || !still, message: killed ? `面板已关闭（端口 ${port}）` : `端口 ${port} 当前没有运行中的面板` });
    return;
  }

  const existing = await probePanel(port);
  const action = decideUiAction(existing);

  if (action === 'port-busy') {
    fail('E_PORT_BUSY', `端口 ${port} 被其他程序占用`, `换一个端口：ui --port 8899（或在 config.json tuning.uiPort 修改默认端口）`);
  }

  // 复用分支：与启动分支共用同一个「打开浏览器」步骤（不得提前 return 跳过打开）
  if (action === 'reuse') {
    // v1.4.11 W22：面板在跑但 PID 记录缺失/失效时（如上次异常退出已清记录），
    //   这里补写回真实 pid —— 否则 mcdna 拿不到 panelUrl，只能退回 panelHint。
    const pidFile = panelPidFile();
    const recorded = (() => {
      try { return JSON.parse(readFileSync(pidFile, 'utf-8')) as { pid?: number; port?: number }; } catch { return null; }
    })();
    if (existing?.pid && (!recorded || recorded.pid !== existing.pid || recorded.port !== port)) {
      try {
        mkdirSync(dirname(pidFile), { recursive: true });
        writeFileSync(pidFile, JSON.stringify({ pid: existing.pid, port, startedAt: new Date().toISOString() }), 'utf-8');
      } catch { /* 记录失败不影响复用，只是少一个 panelUrl */ }
    }
    const opened = shouldOpen ? openBrowser(url) : false;
    emitJson({
      ok: true, action: 'reuse', url, port,
      pid: existing?.pid, version: existing?.version, tokenConfigured: existing?.tokenConfigured,
      opened,
      message: `面板已在运行，直接使用：${url}`,
      hint: shouldOpen ? undefined : '加 --open 可同时打开系统浏览器；ui --stop 关闭面板',
    });
    return;
  }

  // 启动分支：后台安静启动（detached 子进程；输出落盘用户数据目录日志并脱敏；PID 记录到用户数据目录）
  const serverJs = join(layout.runtimeRoot, 'server.js');
  if (!existsSync(serverJs)) {
    fail('E_LAYOUT', `面板服务缺失（${serverJs}）`, '安装包不完整（scripts/runtime/dist），请重新安装');
  }
  const { child, detachLogging } = spawnPanelChild(serverJs, port, panelLogPath);
  const pidFile = panelPidFile();
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString() }), 'utf-8');

  const ready = await waitForPanelReady(() => probePanel(port));
  detachLogging();
  if (!ready?.ok) {
    rmSync(pidFile, { force: true });
    fail('E_INTERNAL', `面板启动超时（端口 ${port}）`, `查看面板日志：${panelLogPath}（已创建）；或换端口重试 ui --port 8899`);
  }

  const opened = shouldOpen ? openBrowser(url) : false;
  emitJson({
    ok: true, action: 'started', url, port, pid: child.pid, opened,
    tokenConfigured: ready.tokenConfigured,
    logFile: panelLogPath,
    message: `面板已启动：${url}${ready.tokenConfigured ? '' : '（首次使用请先在面板中完成 Token 配置）'}`,
    hint: shouldOpen ? undefined : '加 --open 可同时打开系统浏览器；ui --stop 关闭面板',
  });
}

// ---------- 命令实现 ----------

const VERSION = APP_VERSION;

function requireClient(): McpClient {
  const cred = readCredentials();
  if (!cred.mcdMcpToken) {
    fail('E_TOKEN_MISSING', '未配置麦当劳 MCP Token：本次命令需要实时菜单/计价数据',
      '按 references/setup.md 完成首次配置：申请个人 Token 后写入数据目录 config.json 的 credentials.mcdMcpToken（或环境变量 MCD_MCP_TOKEN），再运行 mcsmart.mjs doctor 验证。离线能力（doctor/config/parse-group）无需 Token。');
  }
  log('debug', `MCP URL=${CONFIG.mcdMcpUrl}`);
  return new McpClient(cred.mcdMcpToken!, CONFIG.mcdMcpUrl);
}

async function cmdDoctor(flags: Record<string, string | boolean>): Promise<void> {
  const cred = readCredentials();
  const client = cred.mcdMcpToken ? new McpClient(cred.mcdMcpToken, CONFIG.mcdMcpUrl) : null;
  const report = await doctorReport(client, { live: !!flags.live });
  emitJson(report);
  if (!report.ok) process.exit(4);
}

async function cmdStores(flags: Record<string, string | boolean>): Promise<void> {
  const input: StoresInput = {
    city: (flags.city as string) ?? undefined,
    keyword: (flags.keyword as string) ?? undefined,
    ...((await readJsonInput(flags)) as StoresInput),
  };
  const out = await serviceStores(requireClient(), input);
  emitJson(out);
}

async function cmdSolveSingle(flags: Record<string, string | boolean>): Promise<void> {
  const input = withTargetTime((await readJsonInput(flags)) as SolveSingleInput, flags);
  validateSolveSingleInput(input); // 输入错误优先于凭据错误（本地校验，无网络依赖）
  const out = await serviceSolveSingle(requireClient(), input);
  if (String(flags.format ?? 'json') === 'text') {
    process.stdout.write(renderSingleText(out) + '\n');
  } else {
    emitJson(out);
  }
}

async function cmdSolveGroup(flags: Record<string, string | boolean>): Promise<void> {
  const input = withTargetTime((await readJsonInput(flags)) as SolveGroupInput, flags);
  validateSolveGroupInput(input); // 输入错误优先于凭据错误
  const out = await serviceSolveGroup(requireClient(), input);
  if (String(flags.format ?? 'json') === 'text') {
    process.stdout.write(renderGroupText(out) + '\n');
  } else {
    emitJson(out);
  }
}

/** v1.4.9 N01：`--target-time 08:00` 等价于输入里的 targetTime（不传则保持即时口径） */
function withTargetTime<T extends { targetTime?: string }>(input: T, flags: Record<string, string | boolean>): T {
  const raw = flags['target-time'] ?? flags.time;
  return raw === undefined || raw === true || raw === '' ? input : { ...input, targetTime: String(raw) };
}

/** v1.4.9 N01：读取分时段产品目录（只读官方菜单；不查询/不校验团购适用门店） */
async function cmdCatalog(flags: Record<string, string | boolean>): Promise<void> {
  const str = (v: string | boolean | undefined): string | undefined =>
    v === undefined || v === true || v === '' ? undefined : String(v);
  const out = await servicePeriodCatalog(requireClient(), {
    storeCode: str(flags.store), city: str(flags.city), keyword: str(flags.keyword),
    date: str(flags.date), targetTime: str(flags['target-time'] ?? flags.time),
  });
  emitJson(out);
}

async function cmdParseGroup(flags: Record<string, string | boolean>): Promise<void> {
  const input = (await readJsonInput(flags)) as { pastedText?: string };
  emitJson(serviceParseGroup(input.pastedText ?? ''));
}

async function cmdMcdna(flags: Record<string, string | boolean>): Promise<void> {
  const raw = await readJsonInput(flags);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ServiceError('E_INPUT_INVALID', '战报输入必须是 JSON 对象');
  const body = raw as { demo?: boolean; amountMode?: 'tier' | 'full'; templateId?: string; reportId?: string; commentary?: unknown; snapshotId?: string };
  const input = {
    ...body,
    ...(body.snapshotId ? { commentary: body } : {}),
    ...(flags.demo !== undefined ? { demo: String(flags.demo) !== '0' } : {}),
    ...(flags.amount ? { amountMode: String(flags.amount) as 'tier' | 'full' } : {}),
    ...(flags.template ? { templateId: String(flags.template) } : {}),
    ...(flags['report-id'] ? { reportId: String(flags['report-id']) } : {}),
  };
  const out = await serviceMcdna(input.reportId || input.demo !== false ? null : requireClient(), input);
  // SVG 落盘（默认用户数据目录 out/；--out 可覆盖），stdout 只给 stats 与路径
  const layout = getLayout();
  const outDir = userHomePaths(layout).outDir;
  const target = flags.out ? String(flags.out) : join(outDir, `mcdna-${Date.now()}.svg`);
  const stem = target.replace(/\.svg$/i, '');
  const backPath = stem + '-back.svg';
  const agentPath = stem + '-agent.json';
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, out.frontSvg, 'utf-8');
    writeFileSync(backPath, out.backSvg, 'utf-8');
    if (out.commentaryRequest) writeFileSync(agentPath, JSON.stringify({ reportId: out.reportId, ...out.commentaryRequest }, null, 2), 'utf-8');
  } catch (e) {
    throw new ServiceError('E_INTERNAL', `SVG 写入失败（${target}）：${e instanceof Error ? e.message : String(e)}`);
  }
  // v1.4.11 W22：给面板一个可载入**同一快照**的本机链接（仅当面板确实在运行）。
  //   面板侧 `#mcdna?report=<reportId>` 走 /api/mcdna/render，默认脱敏、不重读订单。
  let panelUrl: string | null = null;
  try {
    const pidFile = panelPidFile();
    if (existsSync(pidFile)) {
      const rec = JSON.parse(readFileSync(pidFile, 'utf-8')) as { pid?: number; port?: number };
      if (typeof rec.port === 'number' && rec.port > 0) {
        const health = await probePanel(rec.port);
        if (health?.ok && health.name === 'mcsmart-butler') panelUrl = `http://127.0.0.1:${rec.port}/#mcdna?report=${out.reportId}`;
      }
    }
  } catch { /* 面板未运行/记录损坏都不影响 CLI 交付 */ }
  emitJson({
    stats: out.stats,
    svgPath: target,
    backSvgPath: backPath, agentRequestPath: out.commentaryRequest ? agentPath : null,
    reportId: out.reportId, snapshotId: out.snapshotId, templateId: out.templateId,
    panelUrl,
    ...(panelUrl ? {} : { panelHint: `运行 mcsmart ui 后打开 #mcdna?report=${out.reportId}，可在面板载入同一快照并按默认脱敏导出正反面 PNG（不重读订单）` }),
    persona: out.persona, copy: out.copy,
    commentaryStatus: out.commentaryStatus, hashes: out.hashes, warnings: out.warnings,
    note: `「麦门状态栏」双面 SVG（1080×1440）已保存；门派 ${out.persona.sectName} / 身份 ${out.persona.role}；${out.commentaryStatus === 'agent' ? '称号与评语为已过守门的 Agent 文案' : '称号与评语取内置梗库，可按 agentRequestPath 的提示词重写后用 --report-id 提交'}。${out.stats.demo ? '演示数据不是个人记录。' : ''}`,
  });
}

async function cmdConfig(flags: Record<string, string | boolean>): Promise<void> {
  const layout = getLayout();
  const res = applyUserConfig();
  if (flags.check) {
    emitJson({
      configFile: res.configFile,
      fileExists: res.fileExists,
      errors: res.errors, warnings: res.warnings,
      valid: res.errors.length === 0,
      effective: CONFIG,
    });
    if (res.errors.length > 0) process.exit(2);
    return;
  }
  emitJson({
    configFile: res.configFile, fileExists: res.fileExists,
    layout: { mode: layout.mode, installRoot: layout.installRoot, seedDataDir: layout.seedDataDir, userHome: layout.userHome },
    effective: CONFIG,
    hint: '修改调优参数：编辑数据目录 config.json 的 tuning 段（字段与取值范围见 references/setup.md）；mcsmart.mjs config --check 可校验',
  });
}

// ---------- 券配方核验录入 / 营养补录（v1.4.3：识图与网络来源的落库入口） ----------
//
// 背景：券面食品清单在联盟 CPS 层结构性不可得（specification / skuExtInfoDTO 均为 null）。
// 真实可用的补全路径是「识图/查官方菜单或权威营养页 → 逐项解析到官方菜单与营养来源 → 落库」。
// 本组命令提供**可实际使用**的核验与补录入口（此前只有函数、没有命令暴露）：
//   - 每条录入必须能追溯到来源（source / evidence / verifiedAt），否则拒收；
//   - 固定品项必须能解析到营养（官网库或补录层），否则阻断——不拿「说不清」冒充已核验；
//   - 品类任选条目必须绑定官方 SKU 轮次，不得凭券名猜测任选范围；
//   - 官方同名套餐整包引用标记为「待门店上下文展开」，不把默认搭配当作券的全部内容。

/** 从任意输入构造一条合规配方（v1.4.7 R04：与 HTTP 共用 recipeSchema，不再各写一份）。
 *  CLI 侧补默认值（条件/证据可后补），但商品身份数组、结构化补差等字段必须原样往返。 */
function normalizeRecipeInput(raw: unknown): VoucherRecipe {
  try {
    return normalizeRecipeInputShared(raw, { strict: false });
  } catch (e) {
    if (e instanceof RecipeSchemaError) throw new CliInputError('E_INPUT_INVALID', e.message, '配方形如 { id, name, items:[...], conditions, productViewSign(s), skuViewId(s) }；字段契约见 references/contracts.md');
    throw e;
  }
}

/** 阻断项转成可读原因 */
function blockingReasons(check: RecipeCheck, recipeName: string): string[] {
  return check.blocking.map((i) => `第 ${i + 1} 条（${check.items[i].mode}:${check.items[i].keyword}）${check.items[i].note}`)
    .map((x) => `配方「${recipeName}」：${x}`);
}

async function cmdVoucher(flags: Record<string, string | boolean>, sub: string[]): Promise<void> {
  const group = sub[0] ?? '';
  if (group !== 'recipe') {
    fail('E_INPUT_INVALID', `voucher 缺少子命令（期望 recipe，收到「${group || '（空）'}」）`,
      '用法：mcsmart.mjs voucher recipe list|verify|add|import|revise|remove [--file F | --stdin]');
  }
  const action = sub[1] ?? '';
  switch (action) {
    case 'list': {
      const recipes = loadRecipes().map((r) => ({
        id: r.id, name: r.name, source: r.source, ruleVersion: r.ruleVersion, verifiedAt: r.verifiedAt,
        resolve: r.resolve, items: r.items.length, priceCents: r.priceCents,
        ...(r.productViewSign ? { productViewSign: r.productViewSign } : {}),
        ...(r.skuViewId ? { skuViewId: r.skuViewId } : {}),
        ...(r.headUrl ? { headUrl: r.headUrl } : {}),
        ...(r.binding?.comboCode ? { comboCode: r.binding.comboCode } : {}),
        evidence: r.evidence,
      }));
      emitJson({ count: recipes.length, recipes, presetCount: recipes.filter((r) => r.source === 'preset').length });
      return;
    }
    case 'verify': {
      const raw = await readJsonInput(flags);
      const recipe = normalizeRecipeInputOrFail(raw);
      const check = validateRecipe(recipe);
      emitJson({ recipeId: recipe.id, ok: check.ok, blocking: check.blocking, warnings: check.warnings, items: check.items });
      // 核验失败仍输出结构化报告，再以稳定退出码 2 结束（不触发 main() 的兜底错误二次输出）。
      if (!check.ok) process.exitCode = 2;
      return;
    }
    case 'add': {
      const raw = await readJsonInput(flags);
      const recipe = normalizeRecipeInputOrFail(raw);
      const check = validateRecipe(recipe);
      if (!check.ok && !flags.force) {
        fail('E_INPUT_INVALID', '配方未通过核验（存在无法追溯的构成条目）',
          blockingReasons(check, recipe.name).join('；') + '。处理后可重试；确认已知悉风险可加 --force 强制写入（警告会记入证据）');
      }
      if (!check.ok) {
        recipe.evidence = `${recipe.evidence}；强制写入（存在阻断项）——${blockingReasons(check, recipe.name).join('；')}`;
      }
      saveRecipe(recipe);
      emitJson({ saved: true, recipeId: recipe.id, ok: check.ok, forced: !check.ok, warnings: check.warnings, items: check.items });
      return;
    }
    case 'import': {
      const raw = await readJsonInput(flags);
      const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as { recipes?: unknown[] }).recipes) ? (raw as { recipes: unknown[] }).recipes : null);
      if (!arr) fail('E_INPUT_INVALID', 'import 需要 JSON 数组或 {recipes:[...]}', '用法：mcsmart.mjs voucher recipe import --file recipes.json');
      let imported = 0, skipped = 0;
      const rejected: string[] = [];
      for (const one of arr) {
        try {
          const recipe = normalizeRecipeInput(one);
          const check = validateRecipe(recipe);
          if (!check.ok && !flags.force) { skipped++; rejected.push(`${recipe.id || recipe.name}：${blockingReasons(check, recipe.name).join('；')}`); continue; }
          if (!check.ok) recipe.evidence = `${recipe.evidence}；强制写入（存在阻断项）——${blockingReasons(check, recipe.name).join('；')}`;
          saveRecipe(recipe);
          imported++;
        } catch (e) {
          // R17：坏项只计 rejected，绝不中断整批——合法项（含坏项之后的）仍照常写入。
          skipped++;
          const reason = e instanceof CliInputError ? e.message : (e instanceof Error ? e.message : String(e));
          const idx = arr.indexOf(one);
          rejected.push(`#${idx + 1}：${reason}`);
        }
      }
      emitJson({ imported, skipped, ...(rejected.length ? { rejected } : {}) });
      return;
    }
    case 'revise': {
      const id = typeof flags.id === 'string' ? flags.id : '';
      if (!id) fail('E_INPUT_INVALID', 'revise 需要 --id 指定配方', '用法：mcsmart.mjs voucher recipe revise --id rcp-xxx --file patch.json');
      const raw = await readJsonInput(flags);
      const patch = normalizeRecipeInputOrFail({ ...(raw as object), id });
      const check = validateRecipe(patch);
      if (!check.ok && !flags.force) {
        fail('E_INPUT_INVALID', '修订后的配方未通过核验', blockingReasons(check, patch.name).join('；'));
      }
      const ok = reviseRecipe(id, patch);
      if (!ok) fail('E_INPUT_INVALID', `未找到配方「${id}」`, '先运行 mcsmart.mjs voucher recipe list 查看已有配方 id');
      emitJson({ revised: true, recipeId: id, ok: check.ok, warnings: check.warnings });
      return;
    }
    case 'remove': {
      const id = typeof flags.id === 'string' ? flags.id : '';
      if (!id) fail('E_INPUT_INVALID', 'remove 需要 --id 指定配方', '用法：mcsmart.mjs voucher recipe remove --id rcp-xxx（预置配方不可删）');
      const ok = removeRecipe(id);
      if (!ok) fail('E_INPUT_INVALID', `未找到可删除的用户层配方「${id}」`, '预置配方（source=preset）不可删除，只能用 revise 覆盖同 id');
      emitJson({ removed: true, recipeId: id });
      return;
    }
    default:
      fail('E_INPUT_INVALID', `未知 voucher recipe 子命令「${action || '（空）'}」`,
        '可用：list | verify（只核验不写库） | add（核验通过后写库） | import（批量） | revise（按 id 修订） | remove');
  }
}

async function cmdNutrition(flags: Record<string, string | boolean>, sub: string[]): Promise<void> {
  const action = sub[0] ?? '';
  switch (action) {
    case 'list': {
      const all = allSupplements();
      const originFilter = typeof flags.origin === 'string' ? flags.origin : '';
      const list = all
        .filter((s) => !originFilter || s.origin === originFilter)
        .map((s) => ({
          id: s.id, name: s.name, spec: s.spec ?? '', kcal: s.kcal,
          protein: s.protein, fat: s.fat, carbohydrate: s.carbohydrate, sodium: s.sodium,
          source: s.source, sourceType: s.sourceType ?? 'unknown', sourceUrl: s.sourceUrl ?? '', evidence: s.evidence, verifiedAt: s.verifiedAt, verifiedBy: s.verifiedBy ?? '',
          // R20：区分「随包种子」与「本机用户层」——种子只读，删除/覆盖须落在用户层
          origin: s.origin,
        }));
      const seedCount = all.filter((s) => s.origin === 'seed').length;
      emitJson({
        count: list.length, seedCount, userCount: all.length - seedCount,
        path: join(getLayout().userHome, 'nutrition-supplements.json'),
        supplements: list,
      });
      return;
    }
    case 'add': case 'import': {
      const raw = await readJsonInput(flags);
      const arr = Array.isArray(raw) ? raw : [raw];
      let imported = 0, skipped = 0;
      const rejected: string[] = [];
      for (const one of arr) {
        const o = (one ?? {}) as Partial<NutritionSupplement>;
        const metrics = [o.kcal, o.protein, o.fat, o.carbohydrate, o.sodium];
        const complete = metrics.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
        const sourceTypes = ['official', 'brand', 'third-party', 'secondary', 'user', 'unknown'];
        const sourceUrlOk = o.sourceUrl === undefined || (typeof o.sourceUrl === 'string' && /^https?:\/\//i.test(o.sourceUrl));
        if (typeof o.name !== 'string' || o.name.trim() === '' || !complete
          || typeof o.source !== 'string' || !o.source.trim()
          || typeof o.evidence !== 'string' || !o.evidence.trim()
          || typeof o.verifiedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.verifiedAt)
          || (o.sourceType !== undefined && !sourceTypes.includes(o.sourceType)) || !sourceUrlOk) {
          skipped++; rejected.push(`${JSON.stringify(o).slice(0, 80)}（需完整营养五项、来源、证据、核验日期；来源 URL 如提供须为 http(s)）`); continue;
        }
        saveNutritionSupplement({
          id: typeof o.id === 'string' && o.id ? o.id : '',
          name: o.name.trim(),
          ...(Array.isArray(o.matchNames) ? { matchNames: o.matchNames.map((x) => String(x)) } : {}),
          ...(typeof o.spec === 'string' && o.spec ? { spec: o.spec } : {}),
          ...(o.sourceType ? { sourceType: o.sourceType } : {}),
          ...(typeof o.sourceUrl === 'string' && o.sourceUrl ? { sourceUrl: o.sourceUrl } : {}),
          kcal: o.kcal!, protein: o.protein!, fat: o.fat!,
          carbohydrate: o.carbohydrate!, sodium: o.sodium!,
          source: o.source.trim(), evidence: o.evidence.trim(),
          verifiedAt: o.verifiedAt,
          verifiedBy: typeof o.verifiedBy === 'string' && o.verifiedBy ? o.verifiedBy : 'user',
        });
        imported++;
      }
      emitJson({ imported, skipped, ...(rejected.length ? { rejected } : {}) });
      return;
    }
    case 'remove': {
      const id = typeof flags.id === 'string' ? flags.id : '';
      if (!id) fail('E_INPUT_INVALID', 'remove 需要 --id 指定补录项', '用法：mcsmart.mjs nutrition remove --id sup-（id 见 nutrition list）');
      // R20：随包种子是只读交付物，不能按「用户补录」删除；如需修正，在用户层写入同 id 覆盖。
      if (isSeedSupplement(id)) {
        fail('E_INPUT_INVALID', `「${id}」是随包种子条目，不可删除`,
          '种子条目随安装包分发、只读；如需修正该品项，请用 nutrition add 在用户层写入同 id 补录覆盖（用户层优先于种子）');
      }
      const ok = removeNutritionSupplement(id);
      if (!ok) fail('E_INPUT_INVALID', `未找到用户层营养补录项「${id}」`, '先运行 mcsmart.mjs nutrition list --origin user 查看可删除的用户层 id');
      emitJson({ removed: true, id });
      return;
    }
    default:
      fail('E_INPUT_INVALID', `未知 nutrition 子命令「${action || '（空）'}」`, '可用：list | add（写库） | import（批量） | remove');
  }
}

// ---------- 主流程 ----------

export async function main(argv: string[]): Promise<void> {
  const { command, flags, positional } = parseArgs(argv);
  try {
    // 配置注入尽早完成：CONFIG 单例供所有内核模块读取（doctor/config 也会报告配置错误而非阻断）
    applyUserConfig();
    switch (command) {
      case 'doctor': return await cmdDoctor(flags);
      case 'stores': return await cmdStores(flags);
      case 'solve-single': return await cmdSolveSingle(flags);
      case 'solve-group': return await cmdSolveGroup(flags);
      case 'parse-group': return await cmdParseGroup(flags);
      case 'catalog': return await cmdCatalog(flags);
      case 'mcdna': return await cmdMcdna(flags);
      case 'config': return await cmdConfig(flags);
      case 'voucher': return await cmdVoucher(flags, positional.slice(1));
      case 'nutrition': return await cmdNutrition(flags, positional.slice(1));
      case 'ui': return await cmdUi(flags);
      case 'version': {
        let highs = 'unknown';
        try {
          const mod = await import('highs');
          highs = ((mod as { default?: { version?: string } }).default?.version ?? (mod as { version?: string }).version) ?? 'loaded';
        } catch { highs = 'load-failed'; }
        emitJson({ name: 'mcsmart-butler', version: VERSION, versionSource: APP_VERSION_SOURCE, node: process.version, highs, layout: getLayout().mode });
        return;
      }
      case '': case 'help': case '--help': {
        process.stdout.write([
          `麦麦智能管家 CLI v${VERSION} —— 网页与 Skill 共用同一业务内核`,
          '',
          '用法：mcsmart.mjs <命令> [选项]',
          '',
          '命令：',
          '  doctor [--live]                 环境自检（--live 联网探活麦当劳 MCP）',
          '  ui [--port N] [--open] [--stop] 操作面板：启动或复用（--open 打开系统浏览器，复用分支同样打开）',
          '  stores --city 城市 [--keyword 关键词]   查询附近门店（每次最多 5 家）',
          '  solve-single --file F | --stdin 单人双预算配餐（热量×价格 MILP 求解）',
          '  solve-group  --file F | --stdin 多人拼单仲裁（三轨比价 + 透明分账）',
          '  parse-group  --file F | --stdin 粘贴群聊文本 → 结构化成员（确认卡）',
          '  catalog [--store 门店码] [--date yyyy-MM-dd] [--target-time HH:mm]  分时段产品目录与目标时段可售池（只读官方菜单）',
  '  mcdna [--demo 0] [--amount tier|full] [--out 路径] [--report-id ID]  麦门状态栏双面战报 SVG（提交 Agent 文案：stdin 传 {snapshotId,title,verdict,achievements,dialogue,hook}）',
          '  config [--check]                查看/校验生效配置',
          '  voucher recipe list|verify|add|import|revise|remove   券配方核验库（识图/官方菜单核验后落库）',
          '  nutrition list|add|import|remove    营养补录库（官网库未收录品项的可追溯补录；list --origin seed|user 区分随包种子与本机用户层，种子只读）',
          '  version                         版本信息',
          '',
          '全局选项：',
          '  --format text                   solve-single/solve-group 输出人类可读购买卡（默认 json）',
          '  --target-time HH:mm|"yyyy-MM-dd HH:mm"  solve-single/solve-group/catalog 按该用餐时间查询（菜单/详情/计价同口径；缺省=现在）',
          '',
          '输入约定：复杂输入传 UTF-8 JSON 文件（--file 路径）或标准输入（--stdin）；',
          '正常结果输出结构化 JSON 到 stdout，日志写 stderr；错误携带稳定错误码 error.code 与处理建议 error.hint。',
          '首次使用：先运行 ui 打开面板完成 Token 配置（一次性，跨工作区复用）。',
          '团购券补充核验：voucher recipe add --file F（固定品项须能解析到营养，品类任选须绑定官方 SKU 轮次）；',
          '券面新品项无营养时先用 nutrition add --file F 补录来源与证据，再录入配方。',
          '字段契约详见 references/contracts.md；配置与首次使用见 references/setup.md。',
        ].join('\n') + '\n');
        return;
      }
      default:
        fail('E_INPUT_INVALID', `未知命令「${command}」`, '运行 mcsmart.mjs help 查看可用命令');
    }
  } catch (e) {
    if (e instanceof Error && /无法定位 mcsmart-butler 安装布局/.test(e.message)) {
      fail('E_LAYOUT', e.message, '安装包不完整：确认 SKILL.md、scripts/runtime/dist、scripts/data 三个部分齐全后重新安装');
    }
    handleError(e);
  }
}

// 直接执行（经 mcsmart.mjs 启动器或 node dist/cli.js）
const invokedDirectly = process.argv[1] && /cli\.(js|mjs)$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  main(process.argv.slice(2)).catch(handleError);
}
