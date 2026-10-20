// 券核销时段判定（v1.4.6 R08）
//
// 背景：旧实现只判断「券有效期起止」，未消费券面声明的**星期**与**早餐餐段**规则。
//   实测：周六 08:00/20:00 查询「仅周二可核销」的 ¥9.9 券，isRedeemableNow 仍返回 true。
//
// 口径（诚实边界）：
//   1. 星期规则只从券面**明确文字**解析（「仅周二」「周一&周五」「周一至周五」），不推测；
//   2. 时段规则同样只取明确时间（「10:30-14:00」「10:30前」「17:00后」）；
//   3. 名称含「早餐」且无明确截止时间时，按项目既有早餐供应窗口（05:00–10:45，见 catalog.ts
//      菜单餐段启发式）判定，并在结果里标注该窗口来源为项目口径而非券面证据——
//      「现在吃」的自动方案因此不会在晚间推荐早餐券，同时不宣称该截止时间是券面规则。
//   4. 判定失败（无法解析）按「可核销」放行，保持旧行为，不因解析能力不足而误杀。
//
// 说明：本模块只做**时间维度**过滤；门店适用范围仍按既定决定不校验。

export interface RedeemWindow {
  /** 0=周日 … 6=周六；undefined = 券面未声明星期 */
  weekdays?: number[];
  /** 当日可核销起止（分钟，含起不含止）；undefined = 未声明 */
  startMin?: number;
  endMin?: number;
  /** 规则来源（写进提示，便于区分券面证据与项目口径） */
  source: string;
}

export interface RedeemWindowStatus {
  ok: boolean;
  window?: RedeemWindow;
  /** 不可核销时的原因（可直接展示） */
  reason?: string;
}

const WD: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/** 早餐供应窗口（分钟）：项目既有启发式，与菜单餐段过滤同源；不是券面规则 */
export const BREAKFAST_WINDOW = { startMin: 5 * 60, endMin: 10 * 60 + 45 };

const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 从券名/备注解析核销时段。返回 null = 无任何时段证据。 */
export function parseRedeemWindow(text: string): RedeemWindow | null {
  const src = String(text ?? '');
  if (!src) return null;
  let weekdays: number[] | undefined;
  let startMin: number | undefined;
  let endMin: number | undefined;
  const sources: string[] = [];

  // ① 星期：仅在有「仅/限/只/可核销」语义的片段内解析，避免把「周一上新」之类误当核销限制
  const segs = src.match(/[【\[（(][^】\]）)]*[】\]）)]|[^，。；,;]{0,12}(?:仅|限|只)[^，。；,;]{0,16}/g) ?? [];
  const wdSet = new Set<number>();
  for (const seg of segs) {
    if (!/(周|星期)/.test(seg)) continue;
    if (!/(仅|限|只|可核销)/.test(seg)) continue;
    // 区间：周一至周五 / 周一-周五
    const range = seg.match(/(?:周|星期)([一二三四五六日天])\s*(?:至|到|-|~|—)\s*(?:周|星期)?([一二三四五六日天])/);
    if (range) {
      const a = WD[range[1]]; const b = WD[range[2]];
      if (a !== undefined && b !== undefined) {
        for (let i = a; ; i = (i + 1) % 7) { wdSet.add(i); if (i === b) break; }
      }
    }
    for (const m of seg.matchAll(/(?:周|星期)([一二三四五六日天])/g)) {
      const d = WD[m[1]];
      if (d !== undefined) wdSet.add(d);
    }
  }
  if (wdSet.size > 0) {
    weekdays = [...wdSet].sort((a, b) => a - b);
    sources.push('券面星期限制');
  }

  // ② 明确时段：10:30-14:00 / 10:30~14:00 / 10:30前 / 17:00后
  const range = src.match(/(\d{1,2})[:：](\d{2})\s*(?:-|~|至|—|–)\s*(\d{1,2})[:：](\d{2})/);
  if (range) {
    const s = Number(range[1]) * 60 + Number(range[2]);
    const e = Number(range[3]) * 60 + Number(range[4]);
    if (s >= 0 && s < 24 * 60 && e > 0 && e <= 24 * 60 && e > s) { startMin = s; endMin = e; sources.push('券面时段'); }
  }
  if (startMin === undefined) {
    const before = src.match(/(\d{1,2})[:：](\d{2})\s*前/);
    const after = src.match(/(\d{1,2})[:：](\d{2})\s*后/);
    if (before) { endMin = Number(before[1]) * 60 + Number(before[2]); startMin = 0; sources.push('券面时段（截止）'); }
    else if (after) { startMin = Number(after[1]) * 60 + Number(after[2]); endMin = 24 * 60; sources.push('券面时段（起）'); }
  }

  // ③ 早餐餐段（项目口径，非券面证据）：只在没有明确时段时使用
  if (startMin === undefined && /早餐/.test(src)) {
    startMin = BREAKFAST_WINDOW.startMin;
    endMin = BREAKFAST_WINDOW.endMin;
    sources.push('早餐餐段（项目口径 05:00–10:45，非券面规则）');
  }

  if (!weekdays && startMin === undefined) return null;
  return {
    ...(weekdays ? { weekdays } : {}),
    ...(startMin !== undefined ? { startMin } : {}),
    ...(endMin !== undefined ? { endMin } : {}),
    source: sources.join('；'),
  };
}

/** 当前时点能否核销。now 可注入（验收脚本用固定时间复现，不依赖机器时钟）。
 *  when：判定的是「现在」还是「目标用餐时刻」（v1.4.11 W04）——只影响原因文案，不影响规则。 */
export function redeemWindowStatus(
  v: { name?: string; notes?: string[]; constraints?: { timeWindow?: string } },
  now: Date = new Date(),
  when: 'now' | 'target' = 'now',
): RedeemWindowStatus {
  const text = [v.name ?? '', ...(v.notes ?? []), v.constraints?.timeWindow ?? ''].join('；');
  const window = parseRedeemWindow(text);
  if (!window) return { ok: true };
  const dow = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const whenLabel = when === 'target' ? '目标时间是' : '今天是';
  if (window.weekdays && !window.weekdays.includes(dow)) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return {
      ok: false, window,
      reason: `券面限定核销日（${window.weekdays.map((d) => names[d]).join('、')}），${whenLabel}${names[dow]}`,
    };
  }
  if (window.startMin !== undefined && window.endMin !== undefined && (minutes < window.startMin || minutes >= window.endMin)) {
    return {
      ok: false, window,
      reason: `${when === 'target' ? '目标时间' : '当前'} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} 不在可核销时段 ${hhmm(window.startMin)}–${hhmm(window.endMin)}（${window.source}）`,
    };
  }
  return { ok: true, window };
}
