// v1.4.10 W01 回归：团购「完整发现目录」与「受控求解池」分离。
//   评审反例：上海同一关键词 12 页 232 条，旧实现按 40/60 条上限提前停止，漏召回无从察觉。
// 覆盖：
//   A1 12 页 232 条取满（hasNext=false，不标记截断）
//   A2 非 exhaustive 仍按 limit 提前停止，并如实标记 truncated + 原因
//   A3 上游重复页去重（条数不虚增）
//   A4 游标循环（hasNext 恒 true）在安全页数处停止并如实标记截断
//   A5 中途业务错误 / A6 响应缺 data / A7 中途限流 → 抛错，不冒充「取满成功」
//   A8 页界排序重置 → 客户端聚合后价格升序
//   B1 完整目录 232 → 受控池 60 + 池外 172，逐条保留且写明「未参与本次求解」
//   B2 池外条目仍可购买（价格候选），但不参与求解
//   B3 发现层被安全上限截断时，stats.discovery 如实透出
// 所有数据均为**构造夹具**，不声称现实在售；不联网（transport / fetch 均为桩）。
const BASE = process.env.MCSMART_BUILD ?? '../dist';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcsmart-v1410-'));
process.env.MCSMART_HOME = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ } });

const UC = await import(`${BASE}/unionClient.js`);
const U = await import(`${BASE}/unionCps.js`);

let failures = 0;
const check = (cond, label, detail) => {
  const tag = cond ? '✓' : '✗';
  if (!cond) failures++;
  const d = detail === undefined ? ''
    : `（${typeof detail === 'object' ? JSON.stringify(detail).slice(0, 200) : detail}）`;
  console.log(`  ${tag} ${label}${d}`);
};

const CRED = { appkey: 'stub-key', appsecret: 'stub-secret' };
const item = (i, price) => ({
  couponPackDetail: {
    name: `测试团单${i}`, productViewSign: `SIGN_${i}`, skuViewId: `SKU_${i}`,
    sellPrice: price == null ? (9.9 + (i % 50) * 0.1).toFixed(2) : String(price),
    poiName: '测试店', headUrl: 'https://img.meituan.net/x.jpg@350_0', saleStatus: true,
  },
  brandInfo: { brandName: '麦当劳' },
});
const pageResp = (arr, hasNext, searchId) => ({
  status: 200, json: { code: 200, data: arr, hasNext, ...(searchId ? { searchId } : {}) }, headers: {},
});

// ============================================================ A. 客户端分页
console.log('\n【A1】12 页 232 条：取满目录，不标记截断');
{
  const pages = Array.from({ length: 12 }, (_, p) => {
    const n = p === 11 ? 12 : 20;
    return Array.from({ length: n }, (_, k) => item(p * 20 + k + 1));
  });
  let calls = 0;
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls++;
    const p = body.pageNo - 1;
    const last = p === 11;
    return pageResp(pages[p], !last, last ? undefined : `cursor-${p + 1}`);
  };
  const r = await UC.searchProductsDetailed(CRED, { keyword: '麦当劳', limit: 40, transport, exhaustive: true });
  check(r.total === 232, '目录 232 条（不是 40）', r.total);
  check(r.pages === 12, '实际请求 12 页', r.pages);
  check(r.hasNext === false, '上游已到末尾（hasNext=false）', r.hasNext);
  check(r.truncated === false, '未被截断', `${r.truncated} ${r.truncatedReason ?? ''}`);
  check(calls === 12, '每页一次请求，无重复翻页', calls);
  check(r.deals[0].sellPrice && r.deals.length === 232, '条目全量返回（未按页丢项）', r.deals.length);
}

console.log('\n【A2】非 exhaustive：仍按 limit 提前停止，并如实标记截断');
{
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    const p = body.pageNo - 1;
    return pageResp(Array.from({ length: 20 }, (_, k) => item(p * 20 + k + 1)), true, `cursor-${p + 1}`);
  };
  const r = await UC.searchProductsDetailed(CRED, { keyword: '麦当劳', limit: 40, transport });
  check(r.total === 40, '受控口径取 40 条', r.total);
  check(r.truncated === true, '明确标记 truncated', r.truncated);
  check(String(r.truncatedReason).includes('40'), '截断原因写明查询上限', r.truncatedReason);
  check(r.hasNext === true, '仍如实报告上游还有下一页', r.hasNext);
}

console.log('\n【A3】上游重复页：按 productViewSign 去重，条数不虚增');
{
  const first = Array.from({ length: 20 }, (_, k) => item(k + 1));
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    // 第 2 页重复第 1 页（上游游标异常），第 3 页才是新内容
    if (body.pageNo === 1) return pageResp(first, true, 'c1');
    if (body.pageNo === 2) return pageResp(first, true, 'c2');
    return pageResp(Array.from({ length: 5 }, (_, k) => item(100 + k)), false, undefined);
  };
  const r = await UC.searchProductsDetailed(CRED, { keyword: '麦当劳', transport, exhaustive: true });
  check(r.total === 25, '去重后 25 条（20 + 5，重复页不计数）', r.total);
  check(r.pages === 3, '仍记录实际请求页数 3', r.pages);
}

console.log('\n【A4】游标循环：hasNext 恒 true 时在安全页数停止并如实标记截断');
{
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    const p = body.pageNo - 1;
    return pageResp(Array.from({ length: 20 }, (_, k) => item(p * 20 + k + 1)), true, 'same-cursor');
  };
  const r = await UC.searchProductsDetailed(CRED, { keyword: '麦当劳', transport, exhaustive: true });
  check(r.pages === 40, '最多 40 页（安全上限）后停止', r.pages);
  check(r.total === 800, '40 页 × 20 条', r.total);
  check(r.truncated === true && String(r.truncatedReason).includes('安全上限'), '截断原因写明安全上限', r.truncatedReason);
  check(r.hasNext === true, '不把「取到上限」写成「已取完」', r.hasNext);
}

console.log('\n【A5】中途业务错误：抛错，不返回部分结果');
{
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.pageNo <= 2) return pageResp(Array.from({ length: 20 }, (_, k) => item((body.pageNo - 1) * 20 + k + 1)), true, `c${body.pageNo}`);
    return { status: 200, json: { code: 401, message: 'signature invalid' }, headers: {} };
  };
  let err = null;
  try { await UC.searchProductsDetailed(CRED, { keyword: '麦当劳', transport, exhaustive: true }); } catch (e) { err = e; }
  check(!!err && String(err.message).includes('联盟业务错误'), '业务错误码显式抛错', err?.message);
  check(!!err && String(err.message).includes('401'), '错误信息保留上游 code', err?.message);
}

console.log('\n【A6】响应缺 data：按渠道失败处理（不当成 0 条成功）');
{
  const transport = async () => ({ status: 200, json: { code: 200, hasNext: false }, headers: {} });
  let err = null;
  try { await UC.searchProductsDetailed(CRED, { keyword: '麦当劳', transport, exhaustive: true }); } catch (e) { err = e; }
  check(!!err && String(err.message).includes('data'), '缺 data 数组抛错', err?.message);
}

console.log('\n【A7】中途限流：重试后仍失败 → 抛错，不冒充成功');
{
  let calls = 0;
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls++;
    if (body.pageNo === 1) return pageResp(Array.from({ length: 20 }, (_, k) => item(k + 1)), true, 'c1');
    return { status: 429, json: { code: 429, message: 'rate limited' }, headers: { 'retry-after': '1' } };
  };
  let err = null;
  try { await UC.searchProductsDetailed(CRED, { keyword: '麦当劳', transport, exhaustive: true }); } catch (e) { err = e; }
  check(!!err, '限流失败不被吞掉', err?.message);
  check(calls === 3, '第 2 页共尝试 2 次（1 次重试）后放弃', calls);
}

console.log('\n【A8】页界排序重置：客户端聚合后仍按价格升序');
{
  // 每页内部有序，但页界处价格回退（真实上游行为）
  const pages = [
    [19.9, 21.5, 23.0],
    [11.9, 12.5, 13.0],
    [9.9, 30.0, 31.0],
  ];
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    const p = body.pageNo - 1;
    const arr = pages[p].map((price, k) => item(p * 10 + k + 1, price.toFixed(2)));
    return pageResp(arr, p < pages.length - 1, p < pages.length - 1 ? `c${p + 1}` : undefined);
  };
  const r = await UC.searchProductsDetailed(CRED, { keyword: '麦当劳', transport, exhaustive: true });
  const prices = r.deals.map((d) => parseFloat(d.sellPrice));
  const sorted = prices.slice().sort((a, b) => a - b);
  check(prices.length === 9, '9 条全部保留', prices.length);
  check(prices.every((p, i) => p === sorted[i]), '聚合后价格升序（不受页界重置影响）', prices.join(','));
}

// ============================================================ B. 发现目录 vs 受控求解池
const stubClient = { async call() { return { data: {} }; } };
const mi = (name) => ({
  code: `C-${name}`, name, priceCents: 1390, originalPriceCents: 1390,
  category: '小食', tags: [], kcal: 300, protein: 10, fat: 10, carbohydrate: 20, sodium: 300,
  isCombo: false, fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: true,
});
const menuOf = (names) => ({ items: names.map(mi), unmatched: 0, comboCount: 0, comboUnmatched: 0, table: new Map() });

let fetchPages = null;   // (pageNo) => { data, hasNext, searchId }
globalThis.fetch = async (_url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : {};
  const r = fetchPages(body.pageNo ?? 1);
  return { status: 200, json: async () => r, headers: new Headers({}) };
};
process.env.MEITUAN_UNION_APPKEY = 'k';
process.env.MEITUAN_UNION_APPSECRET = 's';
delete process.env.MCSMART_DISABLE_BUNDLED_UNION;

console.log('\n【B1】完整目录 232 条 → 受控池 60 + 池外 172，逐条保留');
{
  const all = Array.from({ length: 232 }, (_, i) => item(i + 1, (9.9 + i * 0.1).toFixed(2)));
  fetchPages = (pageNo) => {
    const slice = all.slice((pageNo - 1) * 20, pageNo * 20);
    const hasNext = pageNo * 20 < all.length;
    return { code: 200, data: slice, hasNext, ...(hasNext ? { searchId: `c${pageNo}` } : {}) };
  };
  U._clearUnionQueryCache();
  const menu = menuOf(['测试团单1', '测试团单2']);
  const res = await U.fetchUnionMcDeals(stubClient, 'S1', menu, '测试店', { city: '上海' });
  const s = res.stats;
  check(!!s.discovery, '统计里带 discovery 口径', JSON.stringify(s.discovery ?? null));
  check(s.discovery.total === 232, '发现层 232 条（不是 40/60）', s.discovery.total);
  check(s.discovery.pages === 12, '发现层 12 页', s.discovery.pages);
  check(s.discovery.truncated === false, '发现层未截断', s.discovery.truncated);
  check(s.discovery.poolLimit === 60, '受控池上限 60', s.discovery.poolLimit);
  check(s.discovery.poolSize === 60, '入池 60 条', s.discovery.poolSize);
  check(s.discovery.poolOverflow === 172, '池外 172 条（不静默消失）', s.discovery.poolOverflow);
  check(res.builds.length === 232, '响应逐条保留：池内 60 + 池外 172', res.builds.length);
  check(s.queried === 232, 'queried 计全量目录（不是只计池内）', s.queried);
  const overflow = res.builds.filter((b) => (b.storeNote ?? '').includes('未参与本次求解'));
  check(overflow.length === 172, '池外条目逐条写明「未参与本次求解」', overflow.length);
  check(overflow.every((b) => b.solvable === false), '池外条目 solvable=false（不参与求解）');
  check(overflow.every((b) => b.purchasable === true), '池外条目 purchasable=true（仍可购买，作价格候选）');
  check(overflow[0].storeNote.includes('232') && overflow[0].storeNote.includes('60'),
    '池外原因写明目录总数与池上限', overflow[0].storeNote.slice(0, 80));
  // 池内 = 券面价升序前 60：最便宜的进池，最贵的在池外
  const priceOf = (b) => Number(b.voucher.priceCents ?? 0);
  const inPool = res.builds.filter((b) => !(b.storeNote ?? '').includes('未参与本次求解'));
  check(inPool.length === 60, '池内 60 条', inPool.length);
  const minOverflow = Math.min(...overflow.map(priceOf));
  const maxPool = Math.max(...inPool.map(priceOf));
  check(minOverflow >= maxPool, '池内价格不高于池外（按券面价升序截取）', `${maxPool} / ${minOverflow}`);
}

console.log('\n【B2】池外条目不被核验（成本受控）且不写准入');
{
  const all = Array.from({ length: 80 }, (_, i) => item(i + 1, (9.9 + i * 0.1).toFixed(2)));
  fetchPages = (pageNo) => {
    const slice = all.slice((pageNo - 1) * 20, pageNo * 20);
    const hasNext = pageNo * 20 < all.length;
    return { code: 200, data: slice, hasNext, ...(hasNext ? { searchId: `d${pageNo}` } : {}) };
  };
  U._clearUnionQueryCache();
  const menu = menuOf(['测试团单1']);
  const res = await U.fetchUnionMcDeals(stubClient, 'S1', menu, '测试店', { city: '上海' });
  const overflow = res.builds.filter((b) => (b.storeNote ?? '').includes('未参与本次求解'));
  check(overflow.length === 20, '80 条目录 → 池外 20 条', overflow.length);
  check(overflow.every((b) => !b.verify), '池外条目不写核验记录（未核验 ≠ 核验失败）');
  check(res.builds.length === 80, '池内 + 池外 = 目录（状态守恒）', res.builds.length);
}

console.log('\n【B3】发现层被安全上限截断：如实透出 truncated + 原因');
{
  // 上游 41 页恒 hasNext=true → 客户端 40 页后停止，并标记截断
  fetchPages = (pageNo) => ({
    code: 200,
    data: Array.from({ length: 20 }, (_, k) => item((pageNo - 1) * 20 + k + 1, (9.9 + k * 0.1).toFixed(2))),
    hasNext: true, searchId: 'loop',
  });
  U._clearUnionQueryCache();
  const res = await U.fetchUnionMcDeals(stubClient, 'S1', menuOf(['测试团单1']), '测试店', { city: '上海' });
  const d = res.stats.discovery;
  check(d.pages === 40, '发现层在 40 页安全上限停止', d.pages);
  check(d.truncated === true, '标记截断（不冒充全量）', d.truncated);
  check(String(d.truncatedReason).includes('安全上限'), '截断原因可读', d.truncatedReason);
  check(d.total === 800 && d.poolSize === 60 && d.poolOverflow === 740,
    '800 条目录仍守恒（60 入池 + 740 池外）', `${d.total}/${d.poolSize}/${d.poolOverflow}`);
}

// ============================================================ C. 真实录制回放
// 用评审实际采集的上海 232 条团购 + 12 页分页元数据回放（只读 docs 下的录制文件，不联网）。
console.log('\n【C1】真实录制回放：上海 12 页 232 条 → 发现层 232 / 池 60 / 池外 172');
{
  const { readFileSync, existsSync } = await import('node:fs');
  const ROOT = join(import.meta.dirname, '..');
  // 优先读完整录制；公开仓库只带最小回放夹具（scripts/fixtures/v1410），两者字段口径一致。
  const invPath = join(ROOT, 'docs', '套餐与单品核对清单_2026-10-18.json');
  const evPath = join(ROOT, 'docs', 'WB_MODIFICATION_REVIEW_EVIDENCE_2026-10-18.json');
  const inv = JSON.parse(readFileSync(existsSync(invPath) ? invPath : join(ROOT, 'scripts', 'fixtures', 'v1410', 'union-recorded-232.json'), 'utf-8'));
  const ev = JSON.parse(readFileSync(existsSync(evPath) ? evPath : join(ROOT, 'scripts', 'fixtures', 'v1410', 'union-pagination.json'), 'utf-8'));
  const rec = inv.union;
  const paging = ev.unionPagination;
  check(rec.length === 232, '录制目录 232 条', rec.length);
  check(paging.length === 12 && paging[11].hasNext === false, '录制 12 页且末页 hasNext=false', paging.length);

  // 按录制页界切页（页面内保持录制顺序，价格非升序——正是页界排序重置的真实情形）
  const pageSlices = [];
  let cursor = 0;
  for (const p of paging) { pageSlices.push(rec.slice(cursor, cursor + p.count)); cursor += p.count; }
  check(cursor === 232, '按页界切分后正好 232 条', cursor);

  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    const p = paging[body.pageNo - 1];
    if (!p) return pageResp([], false, undefined);
    const arr = pageSlices[body.pageNo - 1].map((d) => ({
      couponPackDetail: {
        name: d.name, productViewSign: d.productViewSign, skuViewId: d.skuViewId,
        sellPrice: d.sellPrice, poiName: '上海录制门店', headUrl: d.headUrl,
        startTime: d.saleStart, endTime: d.saleEnd, saleStatus: d.saleStatus,
      },
      brandInfo: { brandName: '麦当劳' },
    }));
    return pageResp(arr, p.hasNext, p.hasNext ? `real-${body.pageNo}` : undefined);
  };
  const r = await UC.searchProductsDetailed(CRED, { keyword: '麦当劳', transport, exhaustive: true });
  check(r.total === 232, '发现层取满 232 条（旧口径会在 40 条处停止）', r.total);
  check(r.pages === 12, '实际 12 页', r.pages);
  check(r.hasNext === false && r.truncated === false, '已取到目录末尾且未截断', `${r.hasNext}/${r.truncated}`);
  const names = new Set(r.deals.map((d) => d.name));
  check(names.size > 100, '条目内容为真实券名集合（非占位串）', names.size);
  check(r.deals.some((d) => d.name.includes('巨无霸')), '录制里含巨无霸相关团单（可被召回）',
    r.deals.filter((d) => d.name.includes('巨无霸')).slice(0, 3).map((d) => d.name).join(' / '));

  // 同一录制再走一遍业务层：目录 232 → 受控池 60 + 池外 172
  fetchPages = (pageNo) => {
    const p = paging[pageNo - 1];
    if (!p) return { code: 200, data: [], hasNext: false };
    const arr = pageSlices[pageNo - 1].map((d) => ({
      couponPackDetail: {
        name: d.name, productViewSign: d.productViewSign, skuViewId: d.skuViewId,
        sellPrice: d.sellPrice, poiName: '上海录制门店', headUrl: d.headUrl,
        startTime: d.saleStart, endTime: d.saleEnd, saleStatus: d.saleStatus,
      },
      brandInfo: { brandName: '麦当劳' },
    }));
    return { code: 200, data: arr, hasNext: p.hasNext, ...(p.hasNext ? { searchId: `real-${pageNo}` } : {}) };
  };
  U._clearUnionQueryCache();
  const menu = menuOf(['巨无霸', '板烧鸡腿堡']);
  const res = await U.fetchUnionMcDeals(stubClient, '1450684', menu, '上海录制门店', { city: '上海' });
  const d = res.stats.discovery;
  check(d.total === 232 && d.pages === 12, '业务层发现口径与客户端一致（232 / 12 页）', `${d.total}/${d.pages}`);
  check(d.poolSize === 60 && d.poolOverflow === 172, '受控池 60 + 池外 172（成本受控，条目守恒）',
    `${d.poolSize}/${d.poolOverflow}`);
  check(res.builds.length === 232, '响应 232 条（无静默丢失）', res.builds.length);
  check(res.builds.filter((b) => (b.storeNote ?? '').includes('未参与本次求解')).length === 172,
    '池外 172 条逐条带未参与原因');
}

console.log(failures === 0 ? '\nv1.4.10 W01 团购发现目录回归：全部通过 ✓' : `\nv1.4.10 W01：${failures} 项未通过`);
process.exit(failures === 0 ? 0 : 1);
