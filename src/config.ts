// 运行时可调配置（Skill 化改造：常改内容集中一处 + 合法性校验）。
//
// 三层来源：内置默认 ← 用户数据目录 config.json 的 tuning 段 ← 单次请求参数（service 层负责最后一层）。
// 设计原则：
//  - 零依赖手写校验：每个字段有类型/范围/枚举约束；非法值拒绝加载并给出可读错误与修复建议；
//  - 未知字段降级为警告（防拼写错误静默失效），不阻断；
//  - CONFIG 为模块级单例：内核模块（menu/groupKernel 等）直接 import 读取调优值，
//    CLI/Server 启动早期调用 applyUserConfig() 完成注入；未注入时使用默认值（安全兜底）。
//  - 凭据（Token）不属于本文件：与调优参数分离，存 config.json 的 credentials 段或环境变量，
//    避免诊断/导出配置时把敏感信息一起带出去。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLayout, userHomePaths } from './paths.js';

export const CONFIG_SCHEMA_VERSION = 1;

/** 版本来源无法读取时的明确回退值（绝不静默回退成过期版本号；doctor/诊断据此如实暴露） */
export const DEV_VERSION_FALLBACK = '0.0.0-dev';

/** 版本解析来源：package.json=开发仓库；VERSION=发布包；fallback=都读不到 */
export type VersionSource = 'package.json' | 'VERSION' | 'fallback';

/** 读取指定 package.json 的版本（仅当 name === 'mcsmart-butler'）；不可读返回 null */
function readPackageVersion(pkgPath: string): string | null {
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string };
    if (pkg.name === 'mcsmart-butler' && typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch { /* 损坏的 package.json 视为不可读，继续向上查找 */ }
  return null;
}

/** 从 from 目录逐级向上查找最近的 mcsmart-butler/package.json 版本 */
function searchUpPackageVersion(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    const v = readPackageVersion(join(dir, 'package.json'));
    if (v) return v;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 解析程序版本（唯一来源 = package.json）：
 *  - 开发仓库布局：安装根 package.json 的 version；
 *  - 发布包布局：安装根 VERSION 文件（打包脚本写入，值取自 package.json），
 *    兜底再读包根 package.json；
 *  - 两者都读不到：明确回退 DEV_VERSION_FALLBACK 并标记 source=fallback。
 */
function resolveAppVersion(): { version: string; source: VersionSource } {
  try {
    const layout = getLayout();
    if (layout.mode === 'dev') {
      const v = readPackageVersion(join(layout.installRoot, 'package.json'));
      if (v) return { version: v, source: 'package.json' };
    } else {
      const versionFile = join(layout.installRoot, 'VERSION');
      if (existsSync(versionFile)) {
        const v = readFileSync(versionFile, 'utf-8').trim();
        if (v) return { version: v, source: 'VERSION' };
      }
      const v = readPackageVersion(join(layout.installRoot, 'package.json'));
      if (v) return { version: v, source: 'package.json' };
    }
  } catch { /* 布局不可定位：继续向上查找 */ }
  const up = searchUpPackageVersion(dirname(fileURLToPath(import.meta.url)));
  if (up) return { version: up, source: 'package.json' };
  return { version: DEV_VERSION_FALLBACK, source: 'fallback' };
}

const RESOLVED_VERSION = resolveAppVersion();

/** 程序版本（CLI version / server /api/health / 打包脚本共用；由 package.json 派生，不再硬编码） */
export const APP_VERSION = RESOLVED_VERSION.version;

/** 版本来源：fallback 表示无法读取版本来源（诊断可据此如实暴露，不假装成功） */
export const APP_VERSION_SOURCE: VersionSource = RESOLVED_VERSION.source;

/** 内置默认值（单一事实来源）。金额单位一律为分。 */
export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,

  // —— 求解策略 ——
  topK: 3,                      // 单人/多人默认输出方案数（1..5）
  maxUnifiedPlans: 5,           // 多人跨轨统一去重后的输出上限（1..5）
  fitToleranceKcal: 150,        // 单人热量贴合容差（声明值：最优偏差超过时如实提示；50..500）
  externalCouponLimit: 3,       // 整单外部券使用上限（0..5；程序上限，非平台规则）
  comboMaxQty: 3,               // 官方套餐单个购物篮数量上限（1..8）
  singleMaxQty: 2,              // 单品单个购物篮数量上限（1..8）
  strictSurplusSingle: true,    // 单人模式：富余声明上限 = 数量（false = 放宽到多人口径）

  // —— 排序策略 ——
  groupRankStrategy: 'coverage-first' as 'coverage-first' | 'cost-first',
  // coverage-first：未满足需求数升序优先（默认，先照顾「都想吃到」）；
  // cost-first    ：实付价升序优先（先照顾「更便宜」，未满足项靠后的方案也接受）。

  // —— 数据与缓存 ——
  menuCacheTtlMin: 15,          // 菜单缓存分钟（1..120）
  comboCacheTtlMin: 60,         // 套餐构成缓存分钟（30..1440）
  dealMaxAgeDays: 14,           // 本地团单库观测窗口天（1..30，超窗团单不参与求解）
  menuSnapshotMaxAgeDays: 30,   // 菜单快照「当前可购池」观测时效天（1..365，超窗按完整历史快照降级）
  comboMaxPriceCents: 7000,     // 套餐构成抓取价格上限，分（1000..20000）
  comboFetchLimit: 80,          // 套餐构成抓取条数上限（10..200）
  /** v1.4.10 W01：**受控求解池**上限——完整目录（分页取满）先全量发现，
   *  再按券面价升序取前 N 条逐条核验/入池（核验是逐单网络请求，需要成本上限）。
   *  超出部分不丢弃：保留为价格候选并逐条写明「未参与本次求解」的原因。 */
  unionSolvePoolLimit: 60,      // 受控求解池条数（10..200）
  unionSearchLimit: 40,         // 旧口径：单次查询条数上限（保留兼容；发现层已改为取满目录）
  // —— 分时段目录（v1.4.9 N01）——
  periodCatalogTtlMin: 10,      // 分时段目录缓存分钟（1..120）
  periodCatalogAnchors: '08:00,12:00,18:00', // 采集锚点（HH:mm，逗号分隔；早餐锚点 + 常规时段锚点）

  // —— 网络与上游 ——
  mcdMcpUrl: 'https://mcp.mcd.cn',            // 麦当劳 MCP 地址（测试可覆盖）
  mcpTimeoutMs: 15000,                        // MCP 请求超时毫秒（5000..60000）
  groupKernel: 'milp' as 'milp' | 'legacy',   // 拼单内核（legacy 仅为回滚保留）
  uiPort: 8787,                               // 操作面板端口（1024..65535；ui 命令可用 --port 覆盖）

  // —— 默认门店（用户未指定门店时的回退；正式使用建议在 config.json 里改成常用门店） ——
  defaultCity: '上海',
  defaultKeyword: '上海',
  demoStoreCode: '1450713',
  demoStoreName: '麦当劳上海黄浦华旭国际大厦餐厅（默认演示门店）',

  // —— 展示与诊断 ——
  mcdnaAmountMode: 'tier' as 'tier' | 'full', // McDNA 分享版金额档位化脱敏（full=完整金额，仅本人查看场景）
  logLevel: 'info' as 'silent' | 'info' | 'debug',
});

export type McsmartConfig = {
  -readonly [K in keyof typeof DEFAULT_CONFIG]: (typeof DEFAULT_CONFIG)[K];
};

/** 运行时单例：初始为内置默认；applyUserConfig() 后为「默认 ← 用户调优」合并结果。 */
export const CONFIG: McsmartConfig = { ...DEFAULT_CONFIG };

export interface ConfigIssue {
  field: string;
  message: string;
}

export interface ConfigPatchResult {
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
  applied: Partial<McsmartConfig>;
}

// ---- 校验工具（零依赖） ----

type Schema = Record<string, { kind: 'int' | 'num' | 'bool' | 'str' | 'enum'; min?: number; max?: number; enumValues?: readonly string[]; maxLen?: number }>;

const SCHEMA: Schema = {
  schemaVersion: { kind: 'int', min: CONFIG_SCHEMA_VERSION, max: CONFIG_SCHEMA_VERSION },
  topK: { kind: 'int', min: 1, max: 5 },
  maxUnifiedPlans: { kind: 'int', min: 1, max: 5 },
  fitToleranceKcal: { kind: 'int', min: 50, max: 500 },
  externalCouponLimit: { kind: 'int', min: 0, max: 5 },
  comboMaxQty: { kind: 'int', min: 1, max: 8 },
  singleMaxQty: { kind: 'int', min: 1, max: 8 },
  strictSurplusSingle: { kind: 'bool' },
  groupRankStrategy: { kind: 'enum', enumValues: ['coverage-first', 'cost-first'] },
  menuCacheTtlMin: { kind: 'int', min: 1, max: 120 },
  comboCacheTtlMin: { kind: 'int', min: 30, max: 1440 },
  dealMaxAgeDays: { kind: 'int', min: 1, max: 30 },
  menuSnapshotMaxAgeDays: { kind: 'int', min: 1, max: 365 },
  comboMaxPriceCents: { kind: 'int', min: 1000, max: 20000 },
  comboFetchLimit: { kind: 'int', min: 10, max: 200 },
  unionSolvePoolLimit: { kind: 'int', min: 10, max: 200 },
  unionSearchLimit: { kind: 'int', min: 10, max: 60 },
  periodCatalogTtlMin: { kind: 'int', min: 1, max: 120 },
  periodCatalogAnchors: { kind: 'str', maxLen: 120 },
  mcdMcpUrl: { kind: 'str', maxLen: 300 },
  mcpTimeoutMs: { kind: 'int', min: 5000, max: 60000 },
  groupKernel: { kind: 'enum', enumValues: ['milp', 'legacy'] },
  uiPort: { kind: 'int', min: 1024, max: 65535 },
  defaultCity: { kind: 'str', maxLen: 40 },
  defaultKeyword: { kind: 'str', maxLen: 40 },
  demoStoreCode: { kind: 'str', maxLen: 20 },
  demoStoreName: { kind: 'str', maxLen: 120 },
  mcdnaAmountMode: { kind: 'enum', enumValues: ['tier', 'full'] },
  logLevel: { kind: 'enum', enumValues: ['silent', 'info', 'debug'] },
};

const ALLOWED_FIELDS = new Set([...Object.keys(SCHEMA), 'schemaVersion']);

/** 校验任意输入对象是否为合法配置补丁。返回错误/警告与规范化后的补丁（只含合法字段）。 */
export function validateConfigObject(raw: unknown): ConfigPatchResult {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const patch: Record<string, unknown> = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: [{ field: '', message: '配置必须是 JSON 对象（键值表），收到 ' + describeType(raw) }], warnings, applied: {} };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED_FIELDS.has(key)) {
      warnings.push({ field: key, message: `未知配置字段「${key}」（可能是拼写错误），已忽略；可用字段见 references/setup.md` });
      continue;
    }
    const rule = SCHEMA[key];
    const v = rule ? value : (key === 'schemaVersion' ? value : undefined);
    if (!rule && key === 'schemaVersion') {
      if (v !== CONFIG_SCHEMA_VERSION) {
        errors.push({ field: key, message: `schemaVersion 必须是 ${CONFIG_SCHEMA_VERSION}（收到 ${JSON.stringify(v)}）；本版本程序不识别其他配置版本` });
      }
      continue;
    }
    const verdict = checkField(key, value, rule!);
    if (verdict.error) errors.push(verdict.error);
    else patch[key] = verdict.value;
  }
  return { errors, warnings, applied: patch as Partial<McsmartConfig> };
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  return typeof v;
}

function checkField(field: string, value: unknown, rule: Schema[string]): { error?: ConfigIssue; value?: unknown } {
  switch (rule.kind) {
    case 'int': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { error: { field, message: `「${field}」必须是整数，收到 ${JSON.stringify(value)}` } };
      }
      if (rule.min !== undefined && value < rule.min) return { error: { field, message: `「${field}」不能小于 ${rule.min}（收到 ${value}）` } };
      if (rule.max !== undefined && value > rule.max) return { error: { field, message: `「${field}」不能大于 ${rule.max}（收到 ${value}）` } };
      return { value };
    }
    case 'num': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: { field, message: `「${field}」必须是数字，收到 ${JSON.stringify(value)}` } };
      }
      return { value };
    }
    case 'bool': {
      if (typeof value !== 'boolean') return { error: { field, message: `「${field}」必须是 true/false，收到 ${JSON.stringify(value)}` } };
      return { value };
    }
    case 'str': {
      if (typeof value !== 'string' || !value.trim()) return { error: { field, message: `「${field}」必须是非空字符串，收到 ${JSON.stringify(value)}` } };
      if (rule.maxLen && value.length > rule.maxLen) return { error: { field, message: `「${field}」长度不能超过 ${rule.maxLen}` } };
      return { value: value.trim() };
    }
    case 'enum': {
      if (typeof value !== 'string' || !rule.enumValues!.includes(value)) {
        return { error: { field, message: `「${field}」必须是 ${rule.enumValues!.map((x) => `"${x}"`).join(' / ')} 之一，收到 ${JSON.stringify(value)}` } };
      }
      return { value };
    }
  }
}

/**
 * 读取用户数据目录 config.json 并把 tuning 段合并进 CONFIG 单例。
 * 文件不存在 → 静默返回（首次使用）；文件非法 → 返回错误但不中断（用默认值继续运行）。
 * credentials 段由调用方通过 readCredentials() 读取，这里只负责 tuning。
 */
export function applyUserConfig(): ConfigPatchResult & { configFile: string; fileExists: boolean } {
  const { configFile } = userHomePaths(getLayout());
  if (!existsSync(configFile)) {
    return { errors: [], warnings: [], applied: {}, configFile, fileExists: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configFile, 'utf-8'));
  } catch (e) {
    return {
      errors: [{ field: '', message: `配置文件解析失败（${e instanceof Error ? e.message : String(e)}）；已忽略该文件，按内置默认值运行。请修正 ${configFile}` }],
      warnings: [], applied: {}, configFile, fileExists: true,
    };
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const tuning = obj.tuning ?? obj; // 兼容：允许裸配置对象（无 tuning 包裹）
  const res = validateConfigObject(tuning);
  Object.assign(CONFIG, res.applied);
  return { ...res, configFile, fileExists: true };
}

export interface Credentials {
  mcdMcpToken?: string;
  /** Token 最近一次只读验证通过的时间（ISO；面板保存成功时写入。env 来源无法记录） */
  verifiedAt?: string;
  meituanUnionAppkey?: string;
  meituanUnionAppsecret?: string;
  meituanUnionSid?: string;
}

/**
 * 读取凭据：环境变量优先（12-factor），其次 config.json 的 credentials 段。
 * 空字符串环境变量视为未设置（回退文件）。绝不把凭据写入 CONFIG（诊断输出/日志不携带敏感信息）。
 */
export function readCredentials(): Credentials {
  let fromFile: Record<string, unknown> = {};
  try {
    const { configFile } = userHomePaths(getLayout());
    if (existsSync(configFile)) {
      const raw = JSON.parse(readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
      if (raw.credentials && typeof raw.credentials === 'object') fromFile = raw.credentials as Record<string, unknown>;
    }
  } catch { /* 配置文件损坏时凭据视为缺失，由 doctor 报告 */ }
  const pick = (env: string, file: string): string | undefined => {
    // 空字符串环境变量视为未设置（例如启动器已显式清空 MCD_MCP_TOKEN 时应回退 config.json）
    const fromEnv = (process.env[env] ?? '').trim();
    if (fromEnv) return fromEnv;
    const v = fromFile[file];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const mcdMcpToken = pick('MCD_MCP_TOKEN', 'mcdMcpToken');
  const savedVerifiedAt = typeof fromFile.verifiedAt === 'string' ? fromFile.verifiedAt.trim() : '';
  // 验证记录只属于文件中的凭据；环境变量覆盖后不能沿用旧 Token 的验证结果。
  const verifiedAt = mcdMcpToken && !process.env.MCD_MCP_TOKEN?.trim()
    && savedVerifiedAt && Number.isFinite(Date.parse(savedVerifiedAt)) ? savedVerifiedAt : undefined;
  return {
    mcdMcpToken,
    verifiedAt,
    meituanUnionAppkey: pick('MEITUAN_UNION_APPKEY', 'meituanUnionAppkey'),
    meituanUnionAppsecret: pick('MEITUAN_UNION_APPSECRET', 'meituanUnionAppsecret'),
    meituanUnionSid: pick('MEITUAN_UNION_SID', 'meituanUnionSid'),
  };
}

export interface CredentialWriteResult {
  ok: boolean;
  configFile?: string;
  error?: string;
}

/**
 * 部分更新用户 config.json 的 credentials 段（读-改-写，保留 tuning 与其他键）。
 * 仅面板「保存/清除 Token」流程使用；Token 只落本地数据目录，绝不回显全文。
 */
export function writeCredentialsPartial(patch: Partial<Credentials>): CredentialWriteResult {
  const { configFile } = userHomePaths(getLayout());
  let doc: Record<string, unknown> = {};
  try {
    if (existsSync(configFile)) doc = JSON.parse(readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, configFile, error: `现有配置文件解析失败，拒绝覆盖以防数据丢失（${e instanceof Error ? e.message : String(e)}）；请手动修正 ${configFile}` };
  }
  const cred = (doc.credentials && typeof doc.credentials === 'object' ? doc.credentials : {}) as Record<string, unknown>;
  const KEY_MAP: Record<keyof Credentials, string> = {
    mcdMcpToken: 'mcdMcpToken',
    verifiedAt: 'verifiedAt',
    meituanUnionAppkey: 'meituanUnionAppkey',
    meituanUnionAppsecret: 'meituanUnionAppsecret',
    meituanUnionSid: 'meituanUnionSid',
  };
  for (const [k, v] of Object.entries(patch)) {
    const fileKey = KEY_MAP[k as keyof Credentials];
    if (!fileKey) continue;
    if (v === undefined || v === null || v === '') delete cred[fileKey];
    else cred[fileKey] = v;
  }
  if (Object.keys(cred).length > 0) doc.credentials = cred;
  else delete doc.credentials;
  try {
    mkdirSync(getLayout().userHome, { recursive: true });
    writeFileSync(configFile, JSON.stringify(doc, null, 1), 'utf-8');
    return { ok: true, configFile };
  } catch (e) {
    return { ok: false, configFile, error: `配置写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Token 遮蔽显示（面板/日志安全）：只露前 4 后 4，中间用长度代替 */
export function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}（长度 ${token.length}）`;
}
