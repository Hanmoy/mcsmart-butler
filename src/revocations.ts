// 配方撤销记录（v1.4.7 R05）：用户删除/停用配方是**明确撤销**，与「上游暂时查询失败」不同。
//
// 旧行为：删除配方只删用户层条目，目录里既有核验（contents/admitted）照旧存在 →
//   断网/缓存路径仍把该券当「可解」，再次核验失败还会继承旧核验。
// 现行为：删除即写撤销记录（只记 id + 时间 + 原因），所有读取核验的路径都先查这张表：
//   - 券配方匹配（matchRecipeCandidates）不再返回被撤销的配方；
//   - 目录核验继承（mergeDealVerification）不再沿用被撤销配方的核验；
//   - 断网兜底重建（dbDealToBuild）不再把被撤销配方的券当可解。
// 原始证据保留在目录/配方文件里，不删不改；用户重新保存同 id 配方即解除撤销（新证据）。
import { join } from 'node:path';
import { getLayout } from './paths.js';
import { withUserFileLock } from './userFileLock.js';
import { fileStamp, readJsonFile, writeJsonAtomic } from './userStore.js';

export interface RevocationRecord {
  recipeId: string;
  at: string;
  reason: string;
}

interface RevocationFile { version: 1; updatedAt: string; records: RevocationRecord[] }

let cache: RevocationFile | null = null;
let stamp = '';

function filePath(): string {
  return join(getLayout().userHome, 'recipe-revocations.json');
}

const empty = (): RevocationFile => ({ version: 1, updatedAt: '', records: [] });

function read(): RevocationFile {
  const p = filePath();
  const s = fileStamp(p);
  if (!cache || s !== stamp) {
    const raw = readJsonFile<Partial<RevocationFile>>(p);
    cache = { version: 1, updatedAt: raw?.updatedAt ?? '', records: Array.isArray(raw?.records) ? raw!.records : [] };
    stamp = s;
  }
  return cache;
}

export function loadRevocations(): RevocationRecord[] {
  return read().records;
}

/** 该配方是否被用户明确撤销（每次读取都按文件指纹刷新，跨进程可见） */
export function isRecipeRevoked(recipeId: string | undefined): boolean {
  if (!recipeId) return false;
  return read().records.some((r) => r.recipeId === recipeId);
}

/** 写入撤销记录（幂等：同 id 只保留最新一条） */
export function revokeRecipe(recipeId: string, reason: string): void {
  if (!recipeId) return;
  withUserFileLock(filePath(), () => {
    const current = read();
    const records = current.records.filter((r) => r.recipeId !== recipeId);
    records.push({ recipeId, at: new Date().toISOString(), reason });
    const next: RevocationFile = { version: 1, updatedAt: new Date().toISOString(), records };
    writeJsonAtomic(filePath(), next);
    cache = next;
    stamp = fileStamp(filePath());
  });
}

/** 解除撤销（用户重新保存同 id 配方 = 提供新证据） */
export function clearRevocation(recipeId: string): void {
  if (!recipeId) return;
  withUserFileLock(filePath(), () => {
    const current = read();
    if (!current.records.some((r) => r.recipeId === recipeId)) return;
    const next: RevocationFile = {
      version: 1, updatedAt: new Date().toISOString(),
      records: current.records.filter((r) => r.recipeId !== recipeId),
    };
    writeJsonAtomic(filePath(), next);
    cache = next;
    stamp = fileStamp(filePath());
  });
}

/** 测试钩子：清空内存缓存 */
export function _resetRevocationCache(): void { cache = null; stamp = ''; }
