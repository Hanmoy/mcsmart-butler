// 面板长进程自持日志。仅记录事件/错误码/请求ID，不记录输入、订单、金额、Token或上游正文。
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getLayout, userHomePaths } from './paths.js';
export function panelLogPath(): string { return join(userHomePaths(getLayout()).logDir,'panel.log'); }
export function panelEvent(event: string, info: Record<string,string|number> = {}): void {
  try {
    const {logDir}=userHomePaths(getLayout());mkdirSync(logDir,{recursive:true});
    const file=panelLogPath();
    if(existsSync(file) && statSync(file).size>1024*1024){const rotated=file+'.1';rmSync(rotated,{force:true});renameSync(file,rotated);}
    appendFileSync(file,JSON.stringify({at:new Date().toISOString(),pid:process.pid,event,...info})+'\n',{mode:0o600});
  } catch { /* 诊断磁盘失败不使业务崩溃；不回显用户数据 */ }
}
