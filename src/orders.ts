// McDNA 的唯一订单适配入口。字段语义是适配契约，不代表官方真实金额字段已实测。
// price/unitPrice/subtotal/totalPrice 兼容旧结构，明确按元；*Cents 按分。
// amount、paidAmount 只有显式 moneyUnit 时才采信，绝不按价格大小猜单位。
export interface ParsedOrderItem {
  name: string;
  qty: number;
  subtotalCents: number | null;
}
export interface ParsedOrder {
  items: ParsedOrderItem[];
  itemsKnown: boolean;
  ts: number | null;
  paidCents: number | null;
  refundCents: number | null;
  moneyBasis: 'order-paid' | 'item-subtotal' | 'unknown';
}
export class OrderFormatError extends Error {
  readonly code = 'E_ORDER_FORMAT';
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function number(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function money(v: unknown, unit: 'yuan' | 'cents'): number | null {
  const n = number(v);
  if (n === null) return null;
  const c = unit === 'yuan' ? Math.round((n + Number.EPSILON) * 100) : n;
  return Number.isSafeInteger(c) ? c : null;
}
function moneyField(o: Record<string, unknown>, cents: string[], yuan: string[], ambiguous: string[] = []): number | null {
  for (const k of cents) if (Object.hasOwn(o, k)) return money(o[k], 'cents');
  for (const k of yuan) if (Object.hasOwn(o, k)) return money(o[k], 'yuan');
  if (o.moneyUnit === 'yuan' || o.moneyUnit === 'cents') {
    for (const k of ambiguous) if (Object.hasOwn(o, k)) return money(o[k], o.moneyUnit);
  }
  return null;
}
export function extractOrders(data: unknown): ParsedOrder[] {
  let arr: unknown = data;
  for (let depth = 0; depth < 3 && !Array.isArray(arr); depth++) {
    if (!record(arr)) break;
    arr = arr.list ?? arr.orders ?? arr.orderList ?? arr.data;
  }
  if (!Array.isArray(arr)) throw new OrderFormatError('官方订单响应结构尚不支持；没有改用演示数据。');
  return arr.map((raw, index) => {
    if (!record(raw)) throw new OrderFormatError(`第 ${index + 1} 笔订单不是对象；无法可靠统计。`);
    const itemList = raw.items ?? raw.productList ?? raw.meals;
    if (itemList !== undefined && !Array.isArray(itemList)) throw new OrderFormatError('订单食品明细不是数组；无法可靠统计。');
    const items: ParsedOrderItem[] = (Array.isArray(itemList) ? itemList : []).map((it: unknown) => {
      if (!record(it)) throw new OrderFormatError('订单食品明细存在非对象条目。');
      const name = it.name ?? it.productName;
      if (typeof name !== 'string' || !name.trim()) throw new OrderFormatError('食品名称缺失，不能编造“未知餐品”参与排行。');
      const qty = it.quantity === undefined && it.qty === undefined ? 1 : number(it.quantity ?? it.qty);
      if (qty === null || !Number.isSafeInteger(qty) || qty < 1 || qty > 10000) throw new OrderFormatError('食品份数必须是 1..10000 的整数。');
      const line = moneyField(it, ['subtotalCents', 'totalPriceCents'], ['subtotal', 'totalPrice']);
      const unit = moneyField(it, ['unitPriceCents', 'priceCents'], ['unitPrice', 'price'], ['amount']);
      const subtotalCents = line !== null ? line : unit !== null && Number.isSafeInteger(unit * qty) ? unit * qty : null;
      return { name: name.trim(), qty, subtotalCents };
    });
    const paidCents = moneyField(raw, ['paidCents'], ['paidYuan'], ['paidAmount', 'actualAmount']);
    const refundCents = moneyField(raw, ['refundCents'], ['refundYuan'], ['refundAmount']);
    return {
      items, itemsKnown: Array.isArray(itemList),
      ts: parseTs(raw.createTime ?? raw.orderTime ?? raw.createDate ?? raw.date ?? raw.orderDate),
      paidCents, refundCents,
      moneyBasis: paidCents !== null ? 'order-paid' : items.length > 0 && items.every(i => i.subtotalCents !== null) ? 'item-subtotal' : 'unknown',
    };
  });
}
export function parseTs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const t = v > 1e12 ? v : v * 1000;
    return Number.isFinite(new Date(t).getTime()) ? t : null;
  }
  if (typeof v === 'string' && v.trim()) {
    if (/^\d{10,13}$/.test(v.trim())) return parseTs(Number(v));
    // 官方未带时区的本地时间按中国标准时间读，不依赖安装机器的时区。
    let s = v.trim().replace(/\//g, '-');
    if (/^\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d(?::\d\d)?)?$/.test(s)) s = s.replace(' ', 'T') + (s.length === 10 ? 'T00:00:00' : '') + '+08:00';
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  return null;
}
