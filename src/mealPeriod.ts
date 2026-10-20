// 餐段与预约时间口径（v1.4.9 N01）
//
// 背景：官方 `query-meals` / `query-meal-detail` / `calculate-price` 都支持 `reservationDate`
//   （格式 `yyyy-MM-dd HH:mm`，非预约场景不传）。旧实现只在「当前时刻」查询，
//   于是「早上想吃午晚餐」「晚上想看早餐」都无法表达，早餐与常规时段还会被混成一个池子。
//
// 本模块是**唯一**的餐段/预约时间判定入口：
//   - 餐段划分（早餐 05:00–10:45，其余为常规时段）只在这里定义一次；
//   - 目标用餐时间 → reservationDate 的转换只在这里做，避免各调用点各自拼字符串。

export type MealPeriod = 'breakfast' | 'regular';

export const MEAL_PERIOD_LABEL: Record<MealPeriod, string> = {
  breakfast: '早餐',
  regular: '常规时段',
};

/** 早餐供应窗口（启发式 05:00–10:45；履约以门店实际供应为准） */
export const BREAKFAST_START_MIN = 5 * 60;
export const BREAKFAST_END_MIN = 10 * 60 + 45;

export const periodOfMinutes = (minuteOfDay: number): MealPeriod =>
  (minuteOfDay >= BREAKFAST_START_MIN && minuteOfDay <= BREAKFAST_END_MIN ? 'breakfast' : 'regular');

export const periodOfDate = (d: Date): MealPeriod => periodOfMinutes(d.getHours() * 60 + d.getMinutes());

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 本地时间 `yyyy-MM-dd` */
export const formatLocalDate = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 本地时间 `yyyy-MM-dd HH:mm`（官方 reservationDate 的格式） */
export const formatReservationDate = (d: Date): string =>
  `${formatLocalDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** 解析 `yyyy-MM-dd HH:mm`（本地时间）；格式或取值非法返回 null */
export function parseReservationDate(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
  // 反查：拒绝 2026-02-31 这类被 Date 静默滚动的日期
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

export interface TargetTime {
  /** 用户原样输入（回显用） */
  targetTime: string;
  /** 官方 reservationDate（`yyyy-MM-dd HH:mm`） */
  reservationDate: string;
  /** 该时间所属餐段 */
  period: MealPeriod;
  /** true = 与「现在」同一餐段（可用于提示「当前口径」） */
  samePeriodAsNow: boolean;
}

/**
 * 解析用户输入的目标用餐时间。
 * 接受 `HH:mm`（今天该时刻）或 `yyyy-MM-dd HH:mm`；空值返回 null（即时口径，不传 reservationDate）。
 * 非法输入抛错，由调用方转成 E_INPUT_INVALID——**不静默回退成当前时刻**（否则「预约」会悄悄变成「现在」）。
 */
export function resolveTargetTime(raw: string | undefined | null, now: Date = new Date()): TargetTime | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  let dt: Date | null = null;
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const mi = Number(hhmm[2]);
    if (h > 23 || mi > 59) throw new Error(`目标用餐时间「${text}」无效：小时需 0–23、分钟需 0–59`);
    dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0, 0);
  } else {
    dt = parseReservationDate(text);
    if (!dt) throw new Error(`目标用餐时间「${text}」格式无效：请用 HH:mm 或 yyyy-MM-dd HH:mm`);
  }
  const period = periodOfDate(dt);
  return {
    targetTime: text,
    reservationDate: formatReservationDate(dt),
    period,
    samePeriodAsNow: period === periodOfDate(now),
  };
}

/** 某餐段在该日期的采集锚点（预约查询必须带具体时刻） */
export const PERIOD_ANCHOR: Record<MealPeriod, string> = {
  breakfast: '08:00',
  regular: '12:00',
};
