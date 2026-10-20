// 一次求解/查询的「下单上下文」（v1.4.9 N01）
//
// 为什么需要它：官方 `query-meals` / `query-meal-detail` / `calculate-price` 都支持
//   `reservationDate`，但调用点分散在 menu / group / groupKernel / dealDetail 的叶子里。
//   逐个加参数会把「目标用餐时间」一路穿过 MILP 内核的签名；加全局变量又会在并发任务间串档
//   （面板同时跑多个 job，进程内共享）。
//
// 因此用 AsyncLocalStorage：入口（service）用 `runWithOrderContext` 圈定一次请求，
//   叶子用 `withOrderParams` 读取——并发隔离、签名不动、可测试（测试直接圈一个上下文）。
//   约定：**即时口径不传 reservationDate**（官方 schema：非预约场景不传），
//   所以未设置上下文或未指定目标时间时，行为与旧版完全一致。

import { AsyncLocalStorage } from 'node:async_hooks';
import type { MealPeriod } from './mealPeriod.js';

export interface OrderContext {
  storeCode?: string;
  /** 1-到店（含得来速车道），2-外送 */
  orderType?: 1 | 2;
  /** 1-到店取餐，2-麦乐送到家，5-得来速，6-企业团餐 */
  beType?: 1 | 2 | 5 | 6;
  /** 官方 reservationDate（`yyyy-MM-dd HH:mm`）；即时口径为 undefined */
  reservationDate?: string;
  /** 目标用餐时间所属餐段 */
  period?: MealPeriod;
  /** 用户输入的目标用餐时间原样（回显/审计用） */
  targetTime?: string;
}

const als = new AsyncLocalStorage<OrderContext>();

/** 在给定上下文中执行（并发安全：不同请求各自持有自己的上下文） */
export function runWithOrderContext<T>(ctx: OrderContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function currentOrderContext(): OrderContext | undefined {
  return als.getStore();
}

/** 当前请求的 reservationDate（即时口径返回 undefined） */
export function reservationDateOf(): string | undefined {
  return als.getStore()?.reservationDate;
}

/** 当前请求的目标餐段（未指定时 undefined，调用方按「现在」推断） */
export function orderPeriodOf(): MealPeriod | undefined {
  return als.getStore()?.period;
}

/**
 * 目标核销时刻（v1.4.11 W04）：预约单返回目标用餐时间；即时口径返回 undefined（= 现在）。
 * 券的「星期/时段」限制必须按目标时刻判定，而不是查询当天——周一预约周二不能只用周一的券。
 * reservationDate 由 service 生成为本地时间 `yyyy-MM-dd HH:mm`，此处按同一时区解析。
 */
export function targetRedeemDate(): Date | undefined {
  const rd = als.getStore()?.reservationDate;
  if (!rd) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(rd);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * 把当前上下文的 reservationDate 合并进官方调用参数。
 * 即时口径**不加字段**（而不是加一个空串），避免把「现在」误表达成预约。
 */
export function withOrderParams<T extends Record<string, unknown>>(params: T): T & { reservationDate?: string } {
  const rd = reservationDateOf();
  return rd ? { ...params, reservationDate: rd } : { ...params };
}
