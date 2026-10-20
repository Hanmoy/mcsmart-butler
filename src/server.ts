// HTTP 服务：操作面板 + 求解/门店/城市/配置 API（薄壳层，业务编排全部在 service.ts）
//   v1.1 改造：
//   - 无 Token 也能启动并打开面板——引导流程（说明 → 官方平台申请 → 遮蔽输入 → 只读验证 → 保存）全在面板完成；
//   - 业务 API 在未配置 Token 时返回 needSetup 引导信号（不再启动即退出）；
//   - 配置 API 只写用户数据目录 config.json；Token 永不回显全文、不进日志；
//   - 资源路径按安装布局解析（开发=public/，发布包=ui/），不依赖 cwd。
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpClient } from './mcp.js';
import { CONFIG, APP_VERSION, applyUserConfig, readCredentials, writeCredentialsPartial, maskToken } from './config.js';
import { randomUUID } from 'node:crypto';
import { panelEvent, panelLogPath } from './panelLog.js';
import { MCDNA_TEMPLATES } from './mcdnaReport.js';
import { getLayout, userHomePaths } from './paths.js';
import {
  serviceStores, serviceSolveSingle, serviceSolveGroup, serviceMcdna, serviceParseGroup, serviceDealsOnly, servicePeriodCatalog,
  ServiceError, classifyUpstreamError, type ServiceHooks,
} from './service.js';
import { CITIES, nearestCity } from './cities.js';
import { loadMenuItems } from './menu.js';
import { normalizeRecipeInput as normalizeRecipeInputShared, RecipeSchemaError } from './recipeSchema.js';
import { UserStoreError } from './userStore.js';
import { UserFileLockError } from './userFileLock.js';
import { PRESET_VOUCHERS, KB_STALE_DAYS } from './vouchers.js';
import {
  PRESET_RECIPES, loadRecipes, validateRecipe, saveRecipe, removeRecipe, recipeCompositionSignature, normVoucherName, RecipeConflictError,
  type VoucherRecipe, type VoucherRecipeItem,
} from './voucherRecipes.js';
import {
  loadNutritionSupplements, resolveComponentNutrition, saveNutritionSupplement,
  importNutritionSupplements, removeNutritionSupplement, supplementId,
  type NutritionSupplement,
} from './nutritionSupplements.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const IS_UI_CHILD = process.env.MCSMART_UI_CHILD === '1'; // ui 命令后台拉起时标记（安静启动：少打日志）

// ---- v1.3 异步任务注册表（内存态；进程重启即清空——本地单用户工具，无需持久化） ----
interface JobRecord {
  id: string;
  kind: 'single' | 'group';
  stage: string;
  note?: string;
  stages: string[];
  startedAt: number;
  updatedAt?: number;
  done: boolean;
  cancelled: boolean;
  error?: string;
  errorCode?: string;
  result?: unknown;
}
const jobs = new Map<string, JobRecord>();
const JOB_TTL_MS = 10 * 60 * 1000;
/** v1.4.4 R15：取消是**明确终态**。取消一旦落定，任务即 done + cancelled，
 *  携带 E_CANCELLED 错误码、不带结果，后续任何迟到回执（成功或失败）都不得改写它。 */
function markJobCancelled(job: JobRecord): void {
  job.done = true;
  job.cancelled = true;
  job.stage = '已取消';
  job.note = undefined;
  job.result = undefined;
  job.error = '已按你的操作取消本次精算，输入已保留';
  job.errorCode = 'E_CANCELLED';
  job.updatedAt = Date.now();
}
function gcJobs(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - (j.updatedAt ?? j.startedAt) > JOB_TTL_MS) jobs.delete(id);
  }
  while (jobs.size > 24) {
    const oldest = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!oldest) break;
    jobs.delete(oldest.id);
  }
}

// 配置注入（数据目录 config.json → CONFIG 单例）
applyUserConfig();

/** 延迟构造的 MCP 客户端：Token 配置后即可用；未配置时由 requireClient 返回引导信号 */
let cachedClient: { token: string; client: McpClient } | null = null;
function requireClient(): McpClient | { needSetup: true } {
  const token = readCredentials().mcdMcpToken;
  if (!token) return { needSetup: true };
  if (!cachedClient || cachedClient.token !== token) cachedClient = { token, client: new McpClient(token, CONFIG.mcdMcpUrl) };
  return cachedClient.client;
}

/** 只读连通性验证：仅调用 now-time-info（不读订单/地址/任何个人数据） */
async function verifyTokenReadonly(token: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    const probe = new McpClient(token, CONFIG.mcdMcpUrl);
    await probe.call('now-time-info', {});
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cls = classifyUpstreamError(msg);
    return { ok: false, code: cls.code, message: msg.slice(0, 200) };
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'E_INPUT_INVALID') {
    super(message);
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new ApiError(413, '请求体过大（上限 64KB）', 'E_BODY_TOO_LARGE');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  try { return JSON.parse(raw) as unknown; }
  catch { throw new ApiError(400, '请求体必须是有效 JSON'); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 配方规范化（v1.4.7 R04）：与 CLI 共用 recipeSchema（同一白名单/同一校验），
 *  合法字段（含 productViewSigns/skuViewIds/optionDiffs）原样往返，未知字段明确报错。 */
function normalizeRecipe(value: unknown): { recipe?: VoucherRecipe; error?: string } {
  try {
    return { recipe: normalizeRecipeInputShared(value, { strict: true }) };
  } catch (e) {
    if (e instanceof RecipeSchemaError) return { error: e.message };
    throw e;
  }
}

function normalizeNutritionSupplement(value: unknown): { supplement?: NutritionSupplement; error?: string } {
  if (!isRecord(value)) return { error: '营养补录必须是 JSON 对象' };
  if (!nonEmptyText(value.name)) return { error: 'name 必填' };
  const kcal = value.kcal, protein = value.protein, fat = value.fat, carbohydrate = value.carbohydrate, sodium = value.sodium;
  if (!finiteNonnegative(kcal) || !finiteNonnegative(protein) || !finiteNonnegative(fat)
    || !finiteNonnegative(carbohydrate) || !finiteNonnegative(sodium)) return { error: '营养数值必须是非负有限数' };
  const source = value.source, evidence = value.evidence, verifiedAt = value.verifiedAt;
  if (!nonEmptyText(source) || !nonEmptyText(evidence) || !nonEmptyText(verifiedAt) || !/^\d{4}-\d{2}-\d{2}$/.test(String(verifiedAt))) return { error: 'source、evidence 和有效 YYYY-MM-DD 格式的 verifiedAt 必填' };
  if (value.id !== undefined && !nonEmptyText(value.id)) return { error: 'id 必须是非空字符串' };
  if (value.spec !== undefined && typeof value.spec !== 'string') return { error: 'spec 必须是字符串' };
  if (value.matchNames !== undefined && (!Array.isArray(value.matchNames) || !value.matchNames.every(nonEmptyText))) return { error: 'matchNames 必须是字符串数组' };
  if (value.verifiedBy !== undefined && typeof value.verifiedBy !== 'string') return { error: 'verifiedBy 必须是字符串' };
  const sourceTypes = ['official', 'brand', 'third-party', 'secondary', 'user', 'unknown'] as const;
  if (value.sourceType !== undefined && !sourceTypes.includes(value.sourceType as typeof sourceTypes[number])) return { error: 'sourceType 必须是 official/brand/third-party/secondary/user/unknown' };
  if (value.sourceUrl !== undefined && (typeof value.sourceUrl !== 'string' || (value.sourceUrl && !/^https?:\/\//i.test(value.sourceUrl)))) return { error: 'sourceUrl 必须是 http(s) URL' };
  const name = value.name.trim(), spec = typeof value.spec === 'string' ? value.spec.trim() : '';
  return { supplement: {
    id: typeof value.id === 'string' ? value.id.trim() : supplementId(name, spec || undefined), name,
    ...(Array.isArray(value.matchNames) ? { matchNames: value.matchNames.map((s) => s.trim()) } : {}),
    ...(spec ? { spec } : {}),
    ...(value.sourceType ? { sourceType: value.sourceType as NutritionSupplement['sourceType'] } : {}),
    ...(typeof value.sourceUrl === 'string' && value.sourceUrl ? { sourceUrl: value.sourceUrl.trim() } : {}),
    kcal, protein, fat,
    carbohydrate, sodium, source: source.trim(), evidence: evidence.trim(), verifiedAt: verifiedAt.trim(),
    ...(typeof value.verifiedBy === 'string' ? { verifiedBy: value.verifiedBy } : {}),
  } };
}

/** 面板 HTML：开发模式 public/index.html；发布包 ui/index.html（均按安装布局解析） */
function panelHtmlPath(): string {
  const l = getLayout();
  return l.mode === 'dev' ? join(l.installRoot, 'public', 'index.html') : join(l.installRoot, 'ui', 'index.html');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const requestId = randomUUID().slice(0, 8);
  try {
    // ---- 静态资源 ----
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      let html: string;
      try {
        html = readFileSync(panelHtmlPath(), 'utf-8');
      } catch {
        return json(res, 500, { error: '面板资源缺失（index.html 未随安装包分发）', code: 'E_LAYOUT', hint: '重新安装发布包（ui/ 目录必须完整）' });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/mcdna/panel.js') {
      const file = join(dirname(panelHtmlPath()), 'mcdna', 'panel.js');
      try {
        const js = readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(js); return;
      } catch { throw new ApiError(500, '战报页面资源缺失，请重新构建或安装', 'E_LAYOUT'); }
    }

    // 面板品牌静态资源（public/assets 开发版、ui/assets 发布包）。
    // 只放行单层文件名，避免路径穿越；图片缺失时由前端回退到内置 SVG。
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const name = url.pathname.slice('/assets/'.length);
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) return json(res, 404, { error: '资源不存在' });
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      const types: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.svg': 'image/svg+xml',
      };
      try {
        const buf = readFileSync(join(dirname(panelHtmlPath()), 'assets', name));
        res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(buf); return;
      } catch { return json(res, 404, { error: '资源不存在' }); }
    }

    // ---- 健康检查（ui 命令复用探测 + 状态展示）----
    if (req.method === 'GET' && url.pathname === '/api/health') {
      json(res, 200, {
        ok: true, name: 'mcsmart-butler', version: APP_VERSION,
        pid: process.pid, tokenConfigured: !!readCredentials().mcdMcpToken, uptimeSec: Math.round(process.uptime()),
      });
      return;
    }

    // ---- 首次配置 / Token 管理（无 Token 也可访问）----
    if (req.method === 'GET' && url.pathname === '/api/setup/status') {
      const cred = readCredentials();
      const { configFile } = userHomePaths(getLayout());
      json(res, 200, {
        tokenConfigured: !!cred.mcdMcpToken,
        tokenSource: process.env.MCD_MCP_TOKEN?.trim() ? 'env' : (cred.mcdMcpToken ? 'config' : 'none'),
        tokenMasked: cred.mcdMcpToken ? maskToken(cred.mcdMcpToken) : null, // 仅遮蔽摘要，绝不回显全文
        hasMeituan: !!(cred.meituanUnionAppkey && cred.meituanUnionAppsecret),
        configFile,
        mcdPortalUrl: 'https://open.mcd.cn/mcp',
        applyGuideUrl: 'https://github.com/M-China/mcd-mcp-server',
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/setup/token') {
      const body = await readJsonBody(req) as { token?: string };
      if (!isRecord(body) || typeof body.token !== 'string') throw new ApiError(400, 'token 必须是字符串');
      const token = (body.token ?? '').trim();
      if (!token || token.length < 8) return json(res, 400, { ok: false, code: 'E_INPUT_INVALID', message: 'Token 格式无效（至少 8 个字符），请粘贴从麦当劳官方 MCP 平台获取的完整 Token' });
      const v = await verifyTokenReadonly(token);
      if (!v.ok) {
        return json(res, 200, { ok: false, code: v.code, message: `连接验证未通过：${v.message}`, hint: v.code === 'E_TOKEN_INVALID' ? '请确认 Token 完整且未过期，重新复制粘贴' : '检查网络后重试' });
      }
      const w = writeCredentialsPartial({ mcdMcpToken: token, verifiedAt: new Date().toISOString() });
      if (!w.ok) return json(res, 500, { ok: false, code: 'E_INTERNAL', message: w.error });
      json(res, 200, { ok: true, message: `连接验证通过，已保存到本地数据目录（${maskToken(token)}）；跨工作区自动复用`, tokenMasked: maskToken(token) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/setup/verify') {
      const token = readCredentials().mcdMcpToken;
      if (!token) return json(res, 200, { ok: false, code: 'E_TOKEN_MISSING', message: '尚未配置 Token' });
      const v = await verifyTokenReadonly(token);
      return json(res, 200, v.ok
        ? { ok: true, message: '连接正常' }
        : { ok: false, code: v.code, message: `验证未通过：${v.message}` });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/setup/token') {
      // 清除：仅删 config.json 中的 Token；env 来源无法在此清除（提示用户）
      const fromEnv = !!process.env.MCD_MCP_TOKEN?.trim();
      const w = writeCredentialsPartial({ mcdMcpToken: undefined });
      cachedClient = null;
      json(res, 200, { ok: w.ok, message: w.ok ? '已清除本地保存的 Token' : w.error, ...(fromEnv ? { warn: '检测到环境变量 MCD_MCP_TOKEN 仍在生效，请从启动环境中移除' } : {}) });
      return;
    }

    // ---- 业务 API（未配置 Token 时返回引导信号）----

    // 城市列表（供下拉与定位最近城市匹配；离线可用）
    if (req.method === 'GET' && url.pathname === '/api/cities') {
      json(res, 200, { cities: CITIES.map((c) => c.name) });
      return;
    }

    // 定位 → 最近城市（离线可用）
    if (req.method === 'GET' && url.pathname === '/api/nearest-city') {
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lng'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json(res, 400, { error: 'lat/lng 无效' });
      const { city, distanceKm } = nearestCity(lat, lng);
      json(res, 200, { city: city.name, distanceKm: Math.round(distanceKm) });
      return;
    }

    // 券池透明化（预置知识库，离线可用）
    if (req.method === 'GET' && url.pathname === '/api/vouchers') {
      json(res, 200, {
        staleDays: KB_STALE_DAYS,
        presets: PRESET_VOUCHERS.map((v) => ({
          id: v.id, channel: v.channel, channelLabel: v.channelLabel, kind: v.kind,
          name: v.name, priceYuan: v.priceCents / 100,
          itemsKnown: v.items.length > 0,
          solvable: v.kind === 'combo' && (v.items.length >= 2 || v.items.some((it) => it.mode === 'combo-ref')),
          constraints: v.constraints, verifiedAt: v.verifiedAt, evidence: v.evidence,
          notes: v.notes ?? [],
          // 拍板③：明细未核验的券不透出 buyPath
          ...(v.items.length > 0 ? { buyPath: v.buyPath, redeemPath: v.redeemPath } : {}),
        })),
        disclaimer: '券价为调研核验日的参考价，购买时以各平台下单页实时价格为准；本系统不代购、不托管券码。',
      });
      return;
    }

    // ---- 配方 / 营养补录管理（纯本地用户数据，无 Token 也可用） ----
    if (req.method === 'GET' && url.pathname === '/api/recipes') {
      const all = loadRecipes();
      const q = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase();
      const recipes = all.filter((r) => !q || [r.name, ...r.matchNames, r.evidence, r.productViewSign ?? '', r.skuViewId ?? ''].some((s) => s.toLocaleLowerCase().includes(q)))
        .map((recipe) => {
          const check = validateRecipe(recipe);
          return { ...recipe, validation: { ok: check.ok, blocking: check.blocking, warnings: check.warnings } };
        });
      const filteredIds = new Set(recipes.map((r) => r.id));
      json(res, 200, { recipes, count: recipes.length, presetCount: PRESET_RECIPES.filter((r) => filteredIds.has(r.id)).length });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/recipes/verify') {
      const parsed = normalizeRecipe(await readJsonBody(req));
      if (!parsed.recipe) return json(res, 400, { error: parsed.error, code: 'E_INPUT_INVALID' });
      const check = validateRecipe(parsed.recipe);
      return json(res, 200, { ok: check.ok, recipeId: parsed.recipe.id, items: check.items, blocking: check.blocking, warnings: check.warnings });
    }
    if (req.method === 'POST' && url.pathname === '/api/recipes') {
      const body = await readJsonBody(req);
      const parsed = normalizeRecipe(body);
      if (!parsed.recipe) return json(res, 400, { error: parsed.error, code: 'E_INPUT_INVALID' });
      const check = validateRecipe(parsed.recipe);
      const force = isRecord(body) && body.force === true;
      if (check.blocking.length > 0 && !force) return json(res, 422, { saved: false, recipeId: parsed.recipe.id, ...check });
      const recipe = { ...parsed.recipe, source: 'user' as const };
      if (force && check.blocking.length > 0) recipe.evidence += `；强制写入（未解决核验阻断项：${check.blocking.map((i) => `第${i + 1}项 ${check.items[i]?.note ?? ''}`).join('；')}）`;
      saveRecipe(recipe);
      return json(res, 200, { saved: true, forced: force, recipeId: recipe.id, ...check });
    }
    if (req.method === 'POST' && url.pathname === '/api/recipes/import/preview') {
      const body = await readJsonBody(req);
      const entries = Array.isArray(body) ? body : (isRecord(body) && Array.isArray(body.recipes) ? body.recipes : null);
      if (!entries) return json(res, 400, { error: '请求体必须是配方数组或 {recipes:[]}', code: 'E_INPUT_INVALID' });
      if (entries.length > 100) return json(res, 413, { error: '单次预览最多 100 条配方', code: 'E_BODY_TOO_LARGE' });
      const existing = loadRecipes();
      const seen: VoucherRecipe[] = [];
      const signature = (r: VoucherRecipe) => JSON.stringify({
        composition: recipeCompositionSignature(r), conditions: r.conditions, scope: r.scope ?? null,
        binding: r.binding ?? null, productViewSign: r.productViewSign ?? null, skuViewId: r.skuViewId ?? null,
      });
      const namesOf = (r: VoucherRecipe) => new Set([r.name, ...r.matchNames].map(normVoucherName).filter(Boolean));
      const preview = entries.map((entry, index) => {
        const parsed = normalizeRecipe(entry);
        if (!parsed.recipe) return { index, ok: false, error: parsed.error ?? '配方结构无效', conflicts: [], nutritionMissing: [], publishable: false };
        const recipe = parsed.recipe;
        const check = validateRecipe(recipe);
        const names = namesOf(recipe);
        const conflicts = [...existing, ...seen].flatMap((other) => {
          const sameId = other.id === recipe.id;
          const sameName = [...names].some((name) => namesOf(other).has(name));
          if ((!sameId && !sameName) || signature(other) === signature(recipe)) return [];
          return [{ id: other.id, name: other.name, source: other.source, reason: sameId ? '相同配方 ID 的构成/规则不同' : '相同券名或别名对应不同构成/规则' }];
        });
        seen.push(recipe);
        const nutritionMissing = check.items.filter((item) => item.nutrition !== 'known').map((item) => ({ index: item.index, keyword: item.keyword, mode: item.mode, fields: item.nutritionUnknownFields ?? [], estimated: !!item.nutritionEstimated, status: item.nutrition, note: item.note }));
        const scope = recipe.scope?.city || recipe.scope?.stores?.length
          ? { city: recipe.scope.city ?? '', stores: recipe.scope.stores ?? [] }
          : { city: '', stores: [], note: '未限定范围（通用）' };
        return {
          index, id: recipe.id, name: recipe.name, recipe,
          ok: check.ok, check, conflicts, nutritionMissing, scope,
          publishable: check.ok && conflicts.length === 0,
        };
      });
      return json(res, 200, {
        total: entries.length,
        publishable: preview.filter((x) => x.publishable).length,
        blocked: preview.filter((x) => !x.ok).length,
        conflicted: preview.filter((x) => x.conflicts.length > 0).length,
        items: preview,
        publishableRecipes: preview.filter((x) => x.publishable).map((x) => x.recipe),
        note: '只读预览：不会写入配方库。请核对券面组成、营养来源、规则冲突与适用范围后，再单独确认发布。',
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/recipes/import') {
      const body = await readJsonBody(req);
      const entries = Array.isArray(body) ? body : (isRecord(body) && Array.isArray(body.recipes) ? body.recipes : null);
      if (!entries) return json(res, 400, { error: '请求体必须是配方数组或 {recipes:[]}', code: 'E_INPUT_INVALID' });
      const force = isRecord(body) && body.force === true;
      const rejected: Array<{ index: number; id?: string; error: string; blocking?: number[] }> = [];
      let imported = 0;
      entries.forEach((entry, index) => {
        const parsed = normalizeRecipe(entry);
        if (!parsed.recipe) { rejected.push({ index, error: parsed.error ?? '配方结构无效' }); return; }
        const recipe = parsed.recipe;
        const check = validateRecipe(recipe);
        if (check.blocking.length > 0 && !force) {
          rejected.push({ index, id: recipe.id, error: '配方核验存在阻断项', blocking: check.blocking });
          return;
        }
        if (force && check.blocking.length > 0) recipe.evidence += `；强制写入（未解决核验阻断项：${check.blocking.map((i) => `第${i + 1}项 ${check.items[i]?.note ?? ''}`).join('；')}）`;
        try {
          saveRecipe(recipe);
          imported++;
        } catch (e) {
          // v1.4.7 R01：同 ID 不同商品 → 该条拒收（不静默覆盖已有记录），其余条目继续
          rejected.push({ index, id: recipe.id, error: e instanceof Error ? e.message : String(e) });
        }
      });
      return json(res, 200, { imported, skipped: rejected.length, rejected });
    }
    if (req.method === 'DELETE' && /^\/api\/recipes\/[^/]+$/.test(url.pathname)) {
      let id: string;
      try { id = decodeURIComponent(url.pathname.slice('/api/recipes/'.length)); }
      catch { return json(res, 400, { error: '配方 id 编码无效', code: 'E_INPUT_INVALID' }); }
      // v1.4.7 R20：区分「删除用户配方」「删除覆盖 → 恢复预置」；预置本身只读。
      const isPreset = PRESET_RECIPES.some((r) => r.id === id);
      if (!removeRecipe(id)) {
        return json(res, 404, {
          error: isPreset ? '该预置配方没有用户覆盖记录，无需删除（预置只读）' : '用户配方不存在或已被删除',
          code: 'E_NOT_FOUND',
        });
      }
      return json(res, 200, {
        removed: true, id,
        ...(isPreset ? { restoredPreset: true, note: '已删除用户覆盖，恢复预置配方（预置核验仍然有效）' } : { revokedVerification: true, note: '已撤销该配方关联的券面核验（需重新核验后才可参与自动比价）' }),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/nutrition-supplements') {
      const all = loadNutritionSupplements();
      const q = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase();
      const supplements = all.filter((s) => !q || [s.name, ...(s.matchNames ?? []), s.source, s.evidence].some((v) => v.toLocaleLowerCase().includes(q)));
      return json(res, 200, { supplements, count: supplements.length, total: all.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/nutrition-supplements') {
      const parsed = normalizeNutritionSupplement(await readJsonBody(req));
      if (!parsed.supplement) return json(res, 400, { error: parsed.error, code: 'E_INPUT_INVALID' });
      saveNutritionSupplement(parsed.supplement);
      return json(res, 200, { saved: true, supplement: parsed.supplement });
    }
    if (req.method === 'POST' && url.pathname === '/api/nutrition-supplements/import') {
      const body = await readJsonBody(req);
      const entries = Array.isArray(body) ? body : (isRecord(body) && Array.isArray(body.supplements) ? body.supplements : null);
      if (!entries) return json(res, 400, { error: '请求体必须是营养补录数组或 {supplements:[]}', code: 'E_INPUT_INVALID' });
      const accepted: NutritionSupplement[] = [];
      const rejected: Array<{ index: number; id?: string; error: string }> = [];
      entries.forEach((entry, index) => {
        const parsed = normalizeNutritionSupplement(entry);
        if (parsed.supplement) accepted.push(parsed.supplement);
        else rejected.push({ index, ...(isRecord(entry) && typeof entry.id === 'string' ? { id: entry.id } : {}), error: parsed.error ?? '营养补录结构无效' });
      });
      const result = importNutritionSupplements(accepted);
      return json(res, 200, { imported: result.imported, skipped: rejected.length + result.skipped, rejected });
    }
    if (req.method === 'DELETE' && /^\/api\/nutrition-supplements\/[^/]+$/.test(url.pathname)) {
      let id: string;
      try { id = decodeURIComponent(url.pathname.slice('/api/nutrition-supplements/'.length)); }
      catch { return json(res, 400, { error: '营养补录 id 编码无效', code: 'E_INPUT_INVALID' }); }
      if (!removeNutritionSupplement(id)) return json(res, 404, { error: '营养补录不存在', code: 'E_NOT_FOUND' });
      return json(res, 200, { removed: true, id });
    }
    if (req.method === 'GET' && url.pathname === '/api/nutrition/resolve') {
      const name = (url.searchParams.get('name') ?? '').trim();
      if (!name) return json(res, 400, { error: 'name 必填', code: 'E_INPUT_INVALID' });
      const spec = url.searchParams.get('spec')?.trim() || name;
      return json(res, 200, { name, spec, nutrition: resolveComponentNutrition(name, spec) });
    }

    // 粘贴文本规则解析（离线可用，无 Token 也可用）
    if (req.method === 'POST' && url.pathname === '/api/parse-group') {
      const body = JSON.parse(await readBody(req)) as { pastedText?: string };
      json(res, 200, serviceParseGroup(body.pastedText ?? ''));
      return;
    }

    // 战报在实时业务门禁之前：无Token可演示，快照换模板/评语不读官方接口。
    if (req.method === 'GET' && url.pathname === '/api/mcdna/templates') {
      return json(res, 200, { templates: MCDNA_TEMPLATES });
    }
    if (req.method === 'POST' && (url.pathname === '/api/mcdna' || url.pathname === '/api/mcdna/render')) {
      const input = await readJsonBody(req);
      if (!isRecord(input)) throw new ApiError(400, '战报输入必须是 JSON 对象');
      if (url.pathname.endsWith('/render') && typeof input.reportId !== 'string') throw new ApiError(400, '重渲染必须提供 reportId');
      const needsClient = input.demo === false && input.reportId === undefined;
      const cc = needsClient ? requireClient() : null;
      if (cc && 'needSetup' in cc) return json(res, 200, { needSetup: true, code: 'E_TOKEN_MISSING', message: '尚未配置自己的麦当劳 MCP 账户，请在面板首次配置中接入' });
      return json(res, 200, await serviceMcdna(cc, input));
    }
    // 旧SVG入口保留，仅输出同一双面产物的正面；下载不应再请求此接口。
    if (req.method === 'GET' && url.pathname === '/api/mcdna') {
      const demo = url.searchParams.get('demo') !== '0';
      const cc = demo ? null : requireClient();
      if (cc && 'needSetup' in cc) return json(res, 200, cc);
      const out = await serviceMcdna(cc, { demo, amountMode: url.searchParams.get('full') === '1' ? 'full' : 'tier', templateId: url.searchParams.get('template') ?? undefined });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(out.frontSvg); return;
    }

    // 以下为需要实时数据的业务 API：未配置 Token → needSetup（前端切换到引导页）
    const client = requireClient();
    if ('needSetup' in client) {
      return json(res, 200, { needSetup: true, code: 'E_TOKEN_MISSING', message: '尚未配置麦当劳 MCP Token，请先完成首次配置', setupUrl: '/#setup' });
    }

    // 配方核验辅助：只返回当前所选门店实际菜单里的官方套餐 code/轮次/选项，避免手工猜 code。
    if (req.method === 'GET' && url.pathname === '/api/recipes/menu-candidates') {
      const storeCode = (url.searchParams.get('storeCode') ?? '').trim();
      if (!storeCode) return json(res, 400, { error: 'storeCode 必填', code: 'E_INPUT_INVALID' });
      const menu = await loadMenuItems(client, storeCode, { includeUnmatched: true });
      const combos = menu.items.filter((item) => item.isCombo && item.deconstruction?.length).map((item) => ({
        code: item.code, name: item.name,
        rounds: (item.deconstruction ?? []).map((r) => ({
          roundId: r.roundId, roundName: r.roundName, category: r.category, defaultName: r.defaultName,
          options: r.options.map((o) => ({ name: o.name, code: o.code, diffCents: o.diffCents })),
        })),
      }));
      return json(res, 200, { storeCode, source: menu.fromSnapshotAt ? 'snapshot' : 'realtime', snapshotAt: menu.fromSnapshotAt, combos });
    }

    // 城市门店级联列表（MCP 限制：每次查询最多返回 5 家）
    if (req.method === 'GET' && url.pathname === '/api/stores') {
      const city = (url.searchParams.get('city') ?? '').trim();
      const keyword = (url.searchParams.get('keyword') ?? city).trim() || city;
      try {
        const out = await serviceStores(client, { city, keyword });
        json(res, 200, out);
      } catch (e) {
        if (e instanceof ServiceError) return json(res, 400, { error: e.message, code: e.code });
        throw e;
      }
      return;
    }

    // 预热：提前拉取门店菜单与套餐营养（fire-and-forget），使首次「开始精算」无需等待
    if (req.method === 'POST' && url.pathname === '/api/prewarm') {
      const body = JSON.parse(await readBody(req)) as { storeCode?: string; city?: string; keyword?: string };
      let storeCode = body.storeCode?.trim();
      if (!storeCode) {
        const { findStores } = await import('./menu.js');
        const city = body.city?.trim() || CONFIG.defaultCity;
        const kw = body.keyword?.trim() || CONFIG.defaultKeyword;
        const stores = await findStores(client, city, kw);
        storeCode = (stores.find((s) => s.businessStatus) ?? stores[0])?.storeCode;
        // v1.2：查不到门店不再静默拿演示门店预热（不冒充当地门店）
        if (!storeCode) { json(res, 200, { accepted: false, reason: '未查询到门店，未预热' }); return; }
      }
      const warm = (async () => {
        const { loadMenuItems } = await import('./menu.js');
        const r = await loadMenuItems(client, storeCode!);
        return { items: r.items.length, combos: r.comboCount };
      })();
      warm.catch(() => undefined); // 失败静默，用户首次求解时会再试一次
      json(res, 202, { accepted: true, storeCode });
      return;
    }

    // UI-4：只查券（不求解）——解析门店 + 渠道查询，返回逐单清单与未核验原因，供数据管理页独立刷新
    if (req.method === 'POST' && url.pathname === '/api/deals') {
      const body = JSON.parse(await readBody(req)) as { storeCode?: string; storeName?: string; city?: string; keyword?: string };
      json(res, 200, await serviceDealsOnly(client, body));
      return;
    }

    // v1.4.9 N01：分时段产品目录——按餐段采集官方菜单，再生成目标时段可售池与逐商品遗漏账。
    //   只读官方菜单（不查询、不校验团购适用门店），消费者页不展示，供高级数据管理核对。
    if (req.method === 'POST' && url.pathname === '/api/menu/period-catalog') {
      const body = JSON.parse(await readBody(req)) as {
        storeCode?: string; storeName?: string; city?: string; keyword?: string; date?: string; targetTime?: string;
      };
      json(res, 200, await servicePeriodCatalog(client, body));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/solve') {
      const body = JSON.parse(await readBody(req));
      json(res, 200, await serviceSolveSingle(client, body));
      return;
    }

    // ---- 模块 B：拼单仲裁（P0 主线，PRD §二）----

    // 拼单求解：结构化成员（经确认卡修正后）+ 门店 → 三轨方案（散点/套壳/全网券包）+ 决策标签
    if (req.method === 'POST' && url.pathname === '/api/group-solve') {
      const body = JSON.parse(await readBody(req));
      json(res, 200, await serviceSolveGroup(client, body));
      return;
    }

    // ---- v1.3 异步任务（阶段进度上报 + 取消）：同业务编排（service 层），仅多一层任务壳 ----

    if (req.method === 'POST' && (url.pathname === '/api/jobs/solve' || url.pathname === '/api/jobs/group-solve')) {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const job: JobRecord = {
        id: jobId, stage: '排队中', stages: [], startedAt: Date.now(), done: false,
        cancelled: false, ...(url.pathname.endsWith('group-solve') ? { kind: 'group' as const } : { kind: 'single' as const }),
      };
      jobs.set(jobId, job);
      gcJobs();
      const hooks: ServiceHooks = {
        onStage: (stage, note) => {
          if (job.done || job.cancelled) return;
          if (job.stage !== stage) job.stages.push(stage);
          job.stage = stage;
          job.note = note;
          job.updatedAt = Date.now();
        },
        assertLive: () => {
          if (job.cancelled) throw new ServiceError('E_CANCELLED', '已按你的操作取消本次精算，输入已保留');
        },
      };
      const run = url.pathname.endsWith('group-solve')
        ? serviceSolveGroup(client, body, hooks)
        : serviceSolveSingle(client, body, hooks);
      run.then((result) => {
        // v1.4.4 R15：完成回执必须先检查取消状态——丢弃迟到结果。
        //   反例：菜单等待期间取消，随后菜单降级路径正常返回 → 旧实现仍写 done=true/stage='完成'
        //   并携带 result，前端同时看到 cancelled=true 与「完成」，且无 E_CANCELLED。
        if (job.cancelled) { markJobCancelled(job); return; }
        job.done = true; job.result = result; job.stage = '完成'; job.updatedAt = Date.now();
      })
        .catch((e) => {
          // 已取消：无论上游抛的是 E_CANCELLED 还是其他错误，终态都必须是「已取消」
          if (job.cancelled) { markJobCancelled(job); return; }
          job.done = true; job.error = e instanceof Error ? e.message : String(e);
          job.errorCode = e instanceof ServiceError ? e.code : undefined;
          job.updatedAt = Date.now();
        });
      json(res, 202, { jobId, pollMs: 400 });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
      const id = url.pathname.slice('/api/jobs/'.length);
      const job = jobs.get(id);
      if (!job) return json(res, 404, { error: '任务不存在或已过期', code: 'E_INPUT_INVALID' });
      json(res, 200, {
        jobId: job.id, kind: job.kind, stage: job.stage, note: job.note,
        stages: job.stages, elapsedMs: Date.now() - job.startedAt,
        done: job.done, cancelled: job.cancelled,
        ...(job.error ? { error: job.error, ...(job.errorCode ? { code: job.errorCode } : {}) } : {}),
        ...(job.done && job.result ? { result: job.result } : {}),
      });
      return;
    }
    if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
      const id = url.pathname.split('/')[3];
      const job = jobs.get(id);
      if (!job) return json(res, 404, { error: '任务不存在或已过期', code: 'E_INPUT_INVALID' });
      // v1.4.4 R15：取消立即成为明确终态（不再停在「取消中」等待迟到回执改写）
      if (!job.done) markJobCancelled(job); else job.cancelled = true;
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    // 上游错误细节仅落本地日志，对外限制长度并避免透出内部结构；绝不输出 Token
    const msg = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof ApiError || err instanceof ServiceError ? err.code : classifyUpstreamError(msg).code;
    panelEvent('request-error', { requestId, code: errorCode, method: req.method ?? '' });
    if (err instanceof ApiError) {
      json(res, err.status, { error: msg, code: err.code });
      return;
    }
    if (err instanceof ServiceError) {
      json(res, 400, { error: msg.length > 200 ? `${msg.slice(0, 200)}…` : msg, code: err.code, ...(err.hint ? { hint: err.hint } : {}) });
      return;
    }
    // v1.4.7 R01：配方身份冲突 → 409（不是 500，也不是静默覆盖）
    if (err instanceof RecipeConflictError) {
      json(res, 409, { error: msg, code: err.code, recipeId: err.recipeId, existingName: err.existingName });
      return;
    }
    // v1.4.7 R13：落盘失败必须报失败（旧实现静默成功）
    // v1.4.8 R12：现有文件损坏 → 409（需要用户修复/备份，不是服务器内部错误）
    if (err instanceof UserStoreError) {
      json(res, err.code === 'E_STORAGE_CORRUPT' ? 409 : 500, { error: msg, code: err.code, path: err.path });
      return;
    }
    // v1.4.8 R11：未取得跨进程锁 → 503 + retryable（本次未写入，可重试）
    if (err instanceof UserFileLockError) {
      json(res, 503, { error: msg, code: err.code, retryable: true });
      return;
    }
    const cls = classifyUpstreamError(msg);
    json(res, 500, {
      error: msg.length > 200 ? `${msg.slice(0, 200)}…` : msg,
      code: cls.code,
      requestId,
      hint: `请求诊断：${panelLogPath()}（请求ID ${requestId}）；日志不记录订单、金额或凭据。${cls.code !== 'E_UPSTREAM' ? cls.hint : ''}`,
    });
  }
});

server.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    // 由 ui 命令负责复用/换端口判定；直接启动时给出可读提示
    console.error(`端口 ${PORT} 已被占用。若为 mcsmart 面板旧实例，用「ui --stop」关闭后重开，或 PORT=其他端口 启动`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  // 只监听本机回环地址；后台子进程安静启动（stdout 由 ui 命令捕获）
  panelEvent('ready', { port: PORT, version: APP_VERSION });
  if (!IS_UI_CHILD) console.log(`麦麦智能管家面板已启动: http://127.0.0.1:${PORT}（仅本机可访问）`);
});

process.on('uncaughtExceptionMonitor', () => panelEvent('uncaught-exception'));
process.on('exit', code => panelEvent('exit', { code }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  panelEvent('shutdown', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
