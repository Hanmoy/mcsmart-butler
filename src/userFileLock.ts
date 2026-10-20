// 用户数据目录内的**文件级跨进程互斥** + 「写前重读」辅助（v1.4.4 R12，v1.4.8 R11 重写）。
//
// 背景（评审 R12 已复现）：面板进程与 CLI 进程各自持有模块级内存缓存（userCache），
//   各自 flush 时会用**旧快照**覆盖对方的写入：
//     面板保存 A → CLI 保存 B → 面板保存 C，三次都「成功」，最终只剩 A/C，B 静默丢失。
//   原子 rename 只保证文件完整性，**不能**防止旧快照覆盖新记录。
//
// 修复由两部分组成，缺一不可：
//   1) 写前重读：每次变更前从磁盘重读最新内容（见各模块的 readUserFileFromDisk），
//      使「读-改-写」基于最新版本；
//   2) 跨进程互斥：本模块的 withUserFileLock 让同一数据文件上的读-改-写串行化，
//      避免两个进程同时重读后再互相覆盖（重读仍可能撞上并发窗口）。
//
// v1.4.8 R11 修正（评审已复现「双成功仍丢记录」）：
//   - 旧实现超时后**降级为无锁执行**：A 持锁慢写 4.3s，B 等 3s 后无锁写入，A/B 都回成功，最终只剩 A。
//     现在超时抛 `E_LOCK_BUSY`（可重试），**绝不执行写回调**——没有锁就没有写。
//   - 旧实现只按锁文件年龄判「陈旧」并抢占：活进程持锁超过 5s 会被 B 抢走，临界区重叠。
//     现在锁文件写入持有者 {pid, token, at}，仅当**持有进程已不存在**（或锁内容不可解析且文件足够旧）
//     才允许抢占；活进程持锁再久也只能等待。
//   - 释放前校验持有权 token：A 退出时不再删除 B 的锁。
//
// 边界（如实声明）：单机互斥，锁文件与目标文件同目录，不面向网络文件系统（NFS/SMB 语义不保证）。
import { openSync, closeSync, unlinkSync, writeSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 同步睡眠（不引入异步改造：本函数在同步写入路径上被调用） */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 极端环境无 SharedArrayBuffer 时的忙等兜底 */ }
  }
}

export interface UserFileLockOptions {
  /** 等待锁的最长时间（毫秒；超时抛 E_LOCK_BUSY，**不会**无锁执行写回调） */
  timeoutMs?: number;
  /** 锁文件内容不可解析（崩溃残锁）时，视为可抢占的文件年龄（毫秒） */
  staleMs?: number;
  /** 轮询间隔（毫秒） */
  pollMs?: number;
}

/** 锁忙错误：稳定错误码 E_LOCK_BUSY，调用方可提示「稍后重试」，不得当作保存成功。 */
export class UserFileLockError extends Error {
  readonly code = 'E_LOCK_BUSY';
  readonly retryable = true;
  constructor(readonly path: string, message: string) {
    super(message);
    this.name = 'UserFileLockError';
  }
}

interface LockOwner { pid: number; token: string; at: string }

function readOwner(lockPath: string): LockOwner | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<LockOwner>;
    if (raw && typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0) {
      return { pid: raw.pid, token: String(raw.token ?? ''), at: String(raw.at ?? '') };
    }
  } catch { /* 空文件/旧格式/正在写入：交由文件年龄判定 */ }
  return null;
}

/** 进程是否仍存活。EPERM = 进程存在但无权限（视为存活，绝不抢占）。 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 在 `targetPath` 上取得互斥后执行 `fn`（同步）。锁文件为 `${targetPath}.lock`。
 * 无论 `fn` 是否抛错都会释放锁；**未取得锁时绝不调用 `fn`**（超时抛 UserFileLockError）。
 */
export function withUserFileLock<T>(targetPath: string, fn: () => T, opts: UserFileLockOptions = {}): T {
  const lockPath = `${targetPath}.lock`;
  // v1.4.8 R11：默认等待放宽到 8s（覆盖「另一进程读完后慢写 4s」的常见场景），
  //   仍不够时如实报锁忙而不是冒险无锁写入。
  const timeoutMs = opts.timeoutMs ?? 8000;
  const staleMs = opts.staleMs ?? 10000;
  const pollMs = opts.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${Date.now()}-${randomUUID()}`;
  let fd: number | null = null;

  // 目录可能尚未创建（首装/换 MCSMART_HOME）——锁文件创建前先保证父目录存在，
  // 否则会以 ENOENT 误报「数据文件写入失败」。
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* 由后续 openSync 报出真实原因 */ }

  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      try { writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() } satisfies LockOwner)); } catch { /* 内容仅用于诊断与持有权校验 */ }
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw e;
      const owner = readOwner(lockPath);
      let canSteal = false;
      if (owner) {
        // 只有持有进程**已不存在**才允许抢占——活进程持锁再久也不是「死锁」
        if (!pidAlive(owner.pid)) canSteal = true;
      } else {
        // 崩溃残锁（内容为空/不可解析）：按文件年龄判定，避免把「刚创建尚未写入」误抢
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > staleMs) canSteal = true;
        } catch { continue; } // 锁刚被释放：立即重试
      }
      if (canSteal) {
        try { unlinkSync(lockPath); } catch { /* 已被他人清理 */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new UserFileLockError(targetPath,
          `数据文件正被其他进程写入（等待 ${Math.round(timeoutMs / 1000)}s 未获得锁），本次未保存，请稍后重试。`);
      }
      sleepSync(pollMs);
    }
  }

  try {
    return fn();
  } finally {
    try { if (fd !== null) closeSync(fd); } catch { /* 忽略 */ }
    // 持有权校验：只有锁仍属于本 token 才删除（避免删除抢占者的锁）
    const owner = readOwner(lockPath);
    if (!owner || owner.token === token) {
      try { unlinkSync(lockPath); } catch { /* 已被清理：忽略 */ }
    }
  }
}
