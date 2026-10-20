// 安装布局解析（Skill 化改造 #5/#6）：所有资源路径按本模块自身位置推导，绝不依赖进程 cwd。
//
// 支持两种布局：
//   开发仓库：  <root>/package.json(name=mcsmart-butler 且存在 src/) + <root>/dist + <root>/data
//   发布包：    <root>/SKILL.md + <root>/scripts/runtime/dist + <root>/scripts/data
//
// 职责边界（只读/可写分离）：
//   seedDataDir   —— 随安装包分发的只读种子数据（catalog 种子、官网营养表）
//   userHome      —— 可写用户数据目录（配置、凭据、运行缓存、日志、生成物），
//                    由 MCSMART_HOME 环境变量覆盖，默认 <OS用户目录>/.mcsmart-butler。
//                    升级/回退只替换安装目录，userHome 不受影响（用户凭据与个人配置得以保留）。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export type LayoutMode = 'dev' | 'package';

export interface Layout {
  mode: LayoutMode;
  /** 安装根：开发=项目根（package.json 所在）；发布包=SKILL.md 所在目录 */
  installRoot: string;
  /** 编译产物目录（dist），Node 模块解析从这里向上找 node_modules（HiGHS） */
  runtimeRoot: string;
  /** 只读种子数据目录 */
  seedDataDir: string;
  /** 可写用户数据目录（配置/凭据/缓存/日志） */
  userHome: string;
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function detectDevRoot(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'mcsmart-butler' && existsSync(join(dir, 'src'))) return dir;
      } catch { /* 损坏 package.json 继续向上 */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function detectPackageRoot(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (
      existsSync(join(dir, 'SKILL.md')) &&
      existsSync(join(dir, 'scripts', 'runtime', 'dist')) &&
      existsSync(join(dir, 'scripts', 'data'))
    ) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let cached: Layout | null = null;

/** 解析安装布局（进程内缓存）。两种判据逐级向上**就近优先**：
 *  包构建在开发仓库内部时（如 dist-package/），包根比开发根更近，正确判为 package。 */
export function getLayout(): Layout {
  if (cached) return cached;
  const userHome = process.env.MCSMART_HOME
    ? resolve(process.env.MCSMART_HOME)
    : join(homedir(), '.mcsmart-butler');

  const start = moduleDir();
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (detectDevRoot(dir) === dir) {
      cached = {
        mode: 'dev', installRoot: dir,
        runtimeRoot: join(dir, 'dist'), seedDataDir: join(dir, 'data'), userHome,
      };
      return cached;
    }
    if (detectPackageRoot(dir) === dir) {
      cached = {
        mode: 'package', installRoot: dir,
        runtimeRoot: join(dir, 'scripts', 'runtime', 'dist'),
        seedDataDir: join(dir, 'scripts', 'data'), userHome,
      };
      return cached;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    '无法定位 mcsmart-butler 安装布局（既不是开发仓库也缺少发布包结构：需要 SKILL.md + scripts/runtime/dist + scripts/data）。' +
    '安装包可能不完整，请重新安装；开发环境请在项目根目录运行。',
  );
}

/** 用户数据目录内的固定文件布局 */
export function userHomePaths(l: Layout): {
  configFile: string; catalogFile: string; logDir: string; outDir: string;
} {
  return {
    configFile: join(l.userHome, 'config.json'),
    catalogFile: join(l.userHome, 'catalog.json'),
    logDir: join(l.userHome, 'logs'),
    outDir: join(l.userHome, 'out'),
  };
}

/** 面板 HTML 资源路径（开发=public/，发布包=ui/）；server 与 doctor 共用 */
export function panelHtmlPath(l: Layout): string {
  return l.mode === 'dev' ? join(l.installRoot, 'public', 'index.html') : join(l.installRoot, 'ui', 'index.html');
}
