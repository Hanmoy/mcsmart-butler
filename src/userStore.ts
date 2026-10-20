// 用户数据文件的统一读写口径（v1.4.7 R12/R13，v1.4.8 R12 补强）：
//   1) 读取缓存必须随磁盘变化失效——面板与 CLI/Agent 是不同进程，父进程读一次就永久缓存的话，
//      子进程写入的新配方/团单在面板里「看不见」，只能靠另一次保存碰巧刷新（旧实现正是如此）。
//   2) 落盘失败必须抛错——旧实现 catch 后静默返回，调用方照样回「已保存」，而磁盘上并没有这条记录
//      （隔离复现：目标 JSON 变成目录时 save 返回成功，重读后首条丢失）。
//   3) 原子写：tmp + rename，避免写一半崩溃留下损坏 JSON。
//   4) v1.4.8 R12：**区分「文件不存在」与「文件损坏」**。旧实现两者都返回 null，
//      于是「截断的 JSON」被当作空库，下一次保存直接把可恢复资料覆盖掉（评审已复现：
//      配方库 A/B → 截断两字符 → 保存 C → 只剩 C，且 HTTP 回 200 saved=true）。
//      现在：只读展示可降级；**写入口**遇到损坏/结构错误一律抛 E_STORAGE_CORRUPT，原字节保留不动。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 稳定错误码：E_STORAGE（写失败）/ E_STORAGE_CORRUPT（现有文件损坏，拒绝覆盖） */
export class UserStoreError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
    message: string,
    readonly code: 'E_STORAGE' | 'E_STORAGE_CORRUPT' = 'E_STORAGE',
  ) {
    super(message);
    this.name = 'UserStoreError';
  }
}

/** 文件指纹（mtime + size）；文件不存在返回 'missing'。用于判断内存缓存是否过期。 */
export function fileStamp(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

/** 读取结果四态：存在且可解析 / 不存在 / 读不了（权限、目录占用等）/ JSON 损坏 */
export type JsonFileState<T> =
  | { state: 'ok'; value: T }
  | { state: 'missing' }
  | { state: 'unreadable'; error: string }
  | { state: 'corrupt'; error: string };

/** 区分「不存在」与「损坏」的读取（写入口必须用这个，不能只看 null）。 */
export function readJsonFileState<T>(path: string): JsonFileState<T> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', error: e instanceof Error ? e.message : String(e) };
  }
  try {
    return { state: 'ok', value: JSON.parse(raw) as T };
  } catch (e) {
    return { state: 'corrupt', error: e instanceof Error ? e.message : String(e) };
  }
}

/** 读取 JSON；不存在/损坏 → null（保持各模块**只读**容错口径：损坏文件按空库展示，不可写回） */
export function readJsonFile<T>(path: string): T | null {
  const r = readJsonFileState<T>(path);
  return r.state === 'ok' ? r.value : null;
}

/**
 * 写入口专用读取：不存在 → null；损坏/读不了 → 抛 E_STORAGE_CORRUPT（原文件字节保持不变）。
 * 调用方据此返回失败，绝不把损坏库当成空库覆盖。
 */
export function readJsonFileForWrite<T>(path: string, what = '数据文件'): T | null {
  const r = readJsonFileState<T>(path);
  if (r.state === 'ok') return r.value;
  if (r.state === 'missing') return null;
  const why = r.state === 'corrupt' ? `JSON 解析失败（${r.error}）` : `无法读取（${r.error}）`;
  throw new UserStoreError(path, r.state, `${what}已损坏：${path} ${why}。为避免覆盖可恢复资料，本次保存已取消；请先修复或备份该文件。`, 'E_STORAGE_CORRUPT');
}

/** 原子落盘（失败抛 UserStoreError，不再静默吞掉） */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf-8');
    renameSync(tmp, path);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new UserStoreError(path, reason, `写入失败：${path}（${reason}）`);
  }
}

/** 是否存在（保留旧导出语义，供只读路径判断） */
export function fileExists(path: string): boolean {
  return existsSync(path);
}
