// 诊断：¥9.9 早餐券覆盖对账（v1.4.6 R07）
//
// 目的：把「已保存的早餐团单」逐**身份**（券名 + skuViewId）对账，给出当前支持状态与证据来源，
//      而不是笼统写一句「未核验」。评审 R07 的要求是「明确每个当前支持状态及证据来源」，
//      因此这里输出的每一行都必须能追到具体证据（配方 / 券名模式 / 官方同名套餐 / 官方同名单品），
//      取不到证据时说明**缺在哪一步**，不用「全入池」替代正确性。
//
// 用法：
//   node scripts/diag-breakfast-coverage.mjs            # 默认 合肥 / ¥9.90
//   node scripts/diag-breakfast-coverage.mjs 上海 990
//
// 只读：仅读取用户层 catalog 与配方库，不写任何文件（可安全对真实用户目录运行）。
import { dealsSnapshot, menuSnapshot, menuStoreDetails } from '../dist/catalog.js';
import { loadRecipes, matchRecipeCandidates, normVoucherName } from '../dist/voucherRecipes.js';
import { parseDealPattern, verifyByOfficialSingle } from '../dist/dealDetail.js';
import { redeemWindowStatus } from '../dist/redeemWindow.js';

const city = process.argv[2] || '合肥';
const priceCents = Number(process.argv[3] || 990);
const yuan = (c) => `¥${(c / 100).toFixed(2)}`;
const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dayOf = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '—');

// ---------- 证据面 1：菜单快照（S2/S2b 的唯一来源） ----------
const stores = menuStoreDetails();
const snapshots = stores
  .map((s) => ({ ...s, view: menuSnapshot(s.code) }))
  .filter((s) => s.view);
const allItems = snapshots.flatMap((s) => s.view.items.map((it) => ({ ...it, storeCode: s.code })));
const isBreakfastItem = (it) => /早餐/.test(it.category ?? '') || /早餐/.test(it.name ?? '') || (it.tags ?? []).some((t) => /早餐/.test(t));
const breakfastItems = allItems.filter(isBreakfastItem);

console.log('早餐券覆盖对账（v1.4.6 R07）');
console.log(`口径：城市=${city}｜价格=${yuan(priceCents)}｜身份 = 券名 + skuViewId 去重｜只读用户目录`);
console.log(`菜单快照：${snapshots.length} 店（${snapshots.map((s) => s.code).join('/')}）｜条目 ${allItems.length}｜含「早餐」标记 ${breakfastItems.length} 条`);
if (breakfastItems.length) {
  console.log(`  早餐标记品项：${[...new Set(breakfastItems.map((i) => i.name))].join('、')}`);
}
console.log('');

// ---------- 身份集 ----------
const deals = dealsSnapshot(3650, city).filter((d) => d.priceCents === priceCents && /早餐/.test(d.name || ''));
const byIdentity = new Map();
for (const d of deals) {
  const key = `${d.name}#${d.skuViewId ?? d.sign}`;
  if (!byIdentity.has(key)) byIdentity.set(key, []);
  byIdentity.get(key).push(d);
}
const identities = [...byIdentity.entries()].map(([key, rows]) => ({ key, deal: rows[0], rows }));

const recipes = loadRecipes();
// 券名去掉【】营销/时段标签后的「身份候选」，用于判断早市单品是否在快照里
const nameCandidate = (name) => name.replace(/[【\[][^】\]]*[】\]]/g, '').replace(/早餐两件套|早餐套餐|早餐/, '').trim();

let autoVerified = 0;
let recipeCovered = 0;

for (const [idx, { deal, rows }] of identities.entries()) {
  const now = new Date();
  const win = redeemWindowStatus({ name: deal.name, notes: deal.notes, constraints: deal.constraints }, now);
  const recipeHits = matchRecipeCandidates(deal.name, recipes, {
    productViewSign: deal.sign,
    skuViewId: deal.skuViewId,
    city: deal.city,
    storeCode: deal.sign?.split('_')[1],
  });
  const pattern = parseDealPattern(deal.name);
  const sameNameCombo = allItems.filter((i) => i.isCombo && normVoucherName(i.name) === normVoucherName(deal.name));
  const viaSingle = snapshots.map((s) => verifyByOfficialSingle(deal.name, s.view)).filter(Boolean);
  const candidate = nameCandidate(deal.name);
  const candidateHits = candidate ? allItems.filter((i) => !i.isCombo && normVoucherName(i.name) === normVoucherName(candidate)) : [];

  // 证据判定：与 verifyDealContents 同一优先级（配方 → 券名模式 → 官方同名套餐 → 官方同名单品）
  let verdict;
  let source;
  if (recipeHits.length) {
    const usable = recipeHits.find((r) => r.items?.length);
    if (usable) {
      verdict = '已核验（配方）';
      source = `recipe:${usable.id}`;
      recipeCovered++;
      autoVerified++;
    } else {
      verdict = '未核验（配方占位无构成）';
      source = `recipe:${recipeHits[0].id}（items 为空）`;
    }
  } else if (pattern) {
    verdict = '已核验（券名模式）';
    source = 'name-pattern:1plus1-v1';
    autoVerified++;
  } else if (sameNameCombo.length) {
    verdict = '待详情（官方同名套餐，构成未取）';
    source = `official-menu:${sameNameCombo[0].code}`;
  } else if (viaSingle.length) {
    verdict = '已核验（官方同名单品）';
    source = `official-single:${viaSingle[0].contents?.[0]?.fulfillCode}`;
    autoVerified++;
  } else {
    verdict = '未核验（detail-unavailable）';
    source = '无（配方/券名模式/官方同名套餐/官方同名单品均未命中）';
  }

  console.log(`${idx + 1}) ${deal.name}`);
  console.log(`   身份 skuViewId=${deal.skuViewId ?? '—'}｜可售 ${dayOf(deal.saleStart)}→${dayOf(deal.saleEnd)}｜可用门店 ${deal.availablePoiNum ?? '—'}｜最近观测 ${deal.lastSeen}`);
  console.log(`   核验状态 ${verdict}｜证据来源 ${source}`);
  console.log(`     · 配方库：${recipeHits.length} 条命中（按券名 + 商品身份，同名不同 sign 不串用）`);
  console.log(`     · 券名模式：${pattern ? '命中 1+1 结构' : '不适用（「两件套」为打包声明，不单品化）'}`);
  console.log(`     · 官方同名套餐：${sameNameCombo.length ? sameNameCombo.map((i) => i.name).join('、') : '无（快照无同名套餐）'}`);
  console.log(`     · 官方同名单品：${viaSingle.length ? '命中' : `无（「${candidate}」${candidateHits.length ? '在快照中' : '不在任何快照'}）`}`);
  console.log(`   核销时段：${win.window ? describeWindow(win.window) : '券面无时段证据（不限制）'}${win.ok ? '' : `｜当前不可核销：${win.reason}`}`);
  if (verdict.startsWith('未核验')) {
    console.log(`   拦截原因：${blocker(deal.name, candidateHits, breakfastItems, candidate)}`);
    console.log('   当前支持：价格候选（可比价；不参与配餐求解，避免用猜测构成算热量与预算）');
  }
  if (rows.length > 1) {
    console.log(`   备注：同身份 ${rows.length} 条观测记录（${rows.map((r) => r.sign).join(' / ')}）`);
  }
  console.log('');
}

console.log('汇总');
console.log(`  身份 ${identities.length} 个｜券名 ${new Set(identities.map((i) => i.deal.name)).size} 个｜可自动核验 ${autoVerified} 个｜配方覆盖 ${recipeCovered} 个`);
console.log(`  共同缺口：早市限定单品在官方菜单快照中 ${breakfastItems.length} 条，券面「两件套」构成无接口证据`);
console.log('  下一步（二选一，均需新证据，不得猜测）：');
console.log('    ① 在早餐时段（05:00–10:45）对同一批门店采集一次官方菜单快照 → 早市单品进入 S2b 证据面；');
console.log('    ② 用券面截图/下单页核对构成后补配方（scripts 里 importRecipes 的 explicit 形态），一次核验长期复用。');

// 对照组：配方覆盖的券（证明「有证据就能落地」，与上面的缺口区分开）
const control = recipes.filter((r) => /灰焰/.test(r.name || ''));
if (control.length) {
  console.log('');
  console.log('对照（有配方证据的券，不受「缺官方菜单」影响）');
  for (const r of control) {
    const qty = (r.items ?? []).reduce((s, it) => s + (it.qty || 1), 0);
    console.log(`  ${r.name}｜recipe:${r.id}｜${r.items?.map((it) => `${it.keyword}×${it.qty}`).join(' + ')}｜券价 ${yuan(r.priceCents)}｜合计 ${qty} 件（营养为估算，带 estimated 标记）`);
  }
}

function describeWindow(w) {
  const parts = [];
  if (w.weekdays?.length) parts.push(w.weekdays.map((d) => DOW[d]).join('、'));
  if (w.startMin !== undefined && w.endMin !== undefined) {
    const hh = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    parts.push(`${hh(w.startMin)}–${hh(w.endMin)}`);
  }
  return parts.length ? `${parts.join(' ')}（来源：${w.source}）` : '券面无时段证据（不限制）';
}

function blocker(name, candidateHits, breakfastItems, candidate) {
  if (!candidateHits.length) {
    return `早市限定「${candidate}」不在任何门店菜单快照（快照含早餐标记 ${breakfastItems.length} 条）→ 官方侧无该单品，构成与营养都无法确认`;
  }
  return `「${candidate}」在快照中，但券面「两件套」的搭配与份量无接口证据（快照只给单品，不给券面组合）`;
}
