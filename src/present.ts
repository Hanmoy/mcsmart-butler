// 展示模块：把 service 输出契约渲染为「先怎么买，再怎么看详情」的人类可读文本卡。
//   —— 基础点餐不依赖浏览器或宿主特有卡片；交互式宿主可另行渲染 JSON，本模块是通用兜底。
//   渲染只做转述：金额分→元、字段拼接；绝不补造价格、营养或购买链接（缺失字段显式标注）。
import type { SingleSolveOutput, GroupSolveOutput } from './service.js';
import type { KernelGroupSolution, BasketEntry } from './groupKernel.js';

const yuan = (cents: number | undefined | null): string =>
  cents === undefined || cents === null || !Number.isFinite(cents) ? '—' : `¥${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;

const line = (s = ''): string => s;

/** 单人双预算精算 → 文本卡 */
export function renderSingleText(out: SingleSolveOutput): string {
  if (!out.feasible || out.solutions.length === 0) {
    return [
      '【无可行方案】',
      out.reason || '硬约束下未找到可行组合。',
      '建议：放宽热量/价格预算，或减少营养硬约束后重试。',
    ].join('\n');
  }
  const L: string[] = [];
  L.push(`【怎么买】门店 ${out.store.storeCode} ${out.store.storeName}`);
  out.solutions.forEach((sol, i) => {
    const m = sol.metrics;
    L.push(line());
    L.push(`方案 ${i + 1}/${out.solutions.length}｜实付 ${yuan(m.price)}｜整篮 ${m.kcal} kcal${sol.intake && sol.intake.leftoverKcal > 0 ? `（本人摄入 ${sol.intake.memberKcal} kcal，剩余 ${sol.intake.leftoverKcal} kcal 未分配）` : '（预算内贴合）'}${i === 0 ? ' ← 推荐' : ''}`);
    if (sol.singleFallback) L.push('  （套餐池无解，已放宽加入单品）');
    for (const it of sol.items) {
      // v1.4.10 W16：行价优先使用 service 已给出的准确小计（subtotalCents），
      //   旧实现用四舍五入单价 × 份数，1000/1001 分两份会显示 2002 而实付 2001。
      const rowCents = typeof (it as { subtotalCents?: number }).subtotalCents === 'number'
        ? (it as { subtotalCents: number }).subtotalCents
        : it.price * it.qty;
      L.push(`  ▸ ${it.name} ×${it.qty}｜${yuan(rowCents)}｜${it.category}`);
      // R06：优先按真实逐份配置输出（相同配置合并数量、不同配置分行），不再用平均 kcal 冒充每一份。
      const units = (it.units ?? []).filter((u) => u.config.length > 0);
      if (units.length > 0) {
        for (const u of units) {
          const cfg = u.config.map((c) => `${c.roundName}：${c.chosenName}`).join(' + ');
          L.push(`      · ${u.qty} 份｜${u.kcal} kcal/份｜${yuan(u.priceCents)}/份｜${cfg}`);
        }
        continue;
      }
      for (const d of it.deconstruction ?? []) {
        if (!d.defaultName) continue;
        const cheaper = (d.options ?? []).filter((o) => o.diffCents < 0).slice(0, 2)
          .map((o) => `${o.name}(${yuan(o.diffCents)})`).join('、');
        L.push(`      · ${d.roundName}：${d.defaultName}${cheaper ? `｜可换选更低价：${cheaper}` : ''}`);
      }
    }
  });
  // 详情（推荐方案）
  const best = out.solutions[0];
  const m = best.metrics;
  L.push(line());
  L.push('【详情·推荐方案】');
  L.push(`  营养合计：热量 ${m.kcal} kcal｜蛋白质 ${m.protein}g｜脂肪 ${m.fat}g｜碳水 ${m.carb}g｜钠 ${m.sodium}mg${m.nutritionPartial ? '｜⚠️ 部分品项营养未收录，以上为已收录部分' : ''}`);
  // v1.4.11 W01：整篮营养 ≠ 本人摄入；有剩余时给出实际分配与逐项剩余（硬上限只对本人摄入成立）。
  if (best.intake && best.intake.leftoverKcal > 0) {
    const mi = best.intake.macros;
    L.push(`  本人摄入：${best.intake.memberKcal} kcal（整篮 ${best.intake.purchasedKcal} kcal，剩余 ${best.intake.leftoverKcal} kcal 未计入本人摄入）｜蛋白质 ${mi.protein}g｜脂肪 ${mi.fat}g｜碳水 ${mi.carbohydrate}g｜钠 ${mi.sodium}mg`);
    L.push(`  逐项剩余：${(best.intake.leftovers ?? []).map((l) => `${l.itemName}×${l.qty}（${l.kcal} kcal）`).join('、')}——费用已并入整单，硬上限按本人摄入判定`);
  }
  L.push(`  约束覆盖：主食 ${m.staple} 份、蔬菜 ${m.veggie} 份｜未满足软需求 ${best.gapTotal} 项`);
  if (best.leftovers?.length) {
    L.push(`  合理富余（计入实付但未分配给约束）：${best.leftovers.map((l) => `${l.itemName}×${l.qty}`).join('、')}`);
  }
  L.push(`  价格口径：${best.priceNote}（来源等级：${best.priceSource}）`);
  if (out.menuFromSnapshotAt) L.push(`  ⚠️ ${out.menuSnapshotNote ?? '菜单来自快照'}`);
  L.push(`  目标顺序：${out.objectives.join(' → ')}`);
  L.push(`  ${out.disclaimer}`);
  return L.join('\n');
}

/** 按渠道标签分组的购买清单 */
function basketByChannel(basket: BasketEntry[]): Array<{ channel: string; entries: BasketEntry[] }> {
  const groups = new Map<string, BasketEntry[]>();
  for (const b of basket) {
    const key = b.channelLabel || '其他';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(b);
  }
  return [...groups.entries()].map(([channel, entries]) => ({ channel, entries }));
}

function renderOneSolution(sol: KernelGroupSolution, index: number, total: number, recommend: boolean): string[] {
  const L: string[] = [];
  const t = sol.totals;
  L.push(`方案 ${index}/${total}｜${sol.trackNote ?? ''}｜整单实付 ${yuan(t.paidCents)}（原价 ${yuan(t.originalCents)}，优惠 ${yuan(t.discountCents)}）${recommend ? ' ← 推荐' : ''}`);
  L.push(`  排序依据：未满足软需求 ${sol.gapTotal} 项；求解状态 ${sol.solveState}`);
  for (const g of basketByChannel(sol.basket)) {
    L.push(`  【${g.channel}】`);
    g.entries.forEach((b, i) => {
      L.push(`    ${i + 1}. ${b.name} ×${b.qty}｜${yuan(b.refPriceCents)}｜${b.perUnitConfig.join(' + ') || '按默认配置'}`);
    });
  }
  // leftovers 为内核条件附加字段（有剩余品项时才存在），防御性读取
  const leftovers = (sol as { leftovers?: Array<{ itemName: string; qty: number }> }).leftovers;
  if (leftovers?.length) {
    L.push(`  合理富余：${leftovers.map((l) => `${l.itemName}×${l.qty}`).join('、')}（费用已并入整单）`);
  }
  return L;
}

/** 多人拼单 → 文本卡（先怎么买，再分账详情，再未满足与备注） */
export function renderGroupText(out: GroupSolveOutput): string {
  const L: string[] = [];
  const sol = out.solution as KernelGroupSolution;
  const store = sol.store;
  const basketLen = Array.isArray(sol.basket) ? sol.basket.length : 0;
  // v1.4.10 W08：回执/不可行终态必须在候选渲染**之前**分流。
  //   旧实现照常渲染「方案1/1 整单实付 ¥0 ← 推荐」，后文才说未生成方案——零元可购是虚假承诺。
  if (out.menuUnavailable || sol.solveState === 'infeasible' || (basketLen === 0 && (sol.totals?.paidCents ?? 0) === 0)) {
    L.push('【本轮未产生购买方案】');
    L.push(`门店 ${store.storeCode} ${store.storeName}`);
    if (out.menuUnavailable) L.push(`原因：${out.menuUnavailable.reason}`);
    else L.push(`原因：${sol.trackNote || '当前约束与菜单下无可行购买组合'}`);
    L.push('');
    L.push('【已收到的成员需求】');
    for (const mm of sol.members) {
      const wants = (mm.unresolvedWishes ?? []).filter(Boolean);
      L.push(`  ${mm.alias}：${wants.length ? wants.join('、') : '（未填心愿）'}`);
    }
    const unionDeals = out.channelDiagnostics?.union?.deals;
    if (unionDeals?.length) {
      L.push('');
      L.push(`【美团查询结果】${unionDeals.length} 条在售团单（仅查询结果，可查询 ≠ 可购买 ≠ 可核销）`);
      for (const d of unionDeals.slice(0, 10)) L.push(`  · ${d.name}｜¥${d.priceYuan}｜${d.status === 'admitted' ? '可自动比价' : d.status === 'unavailable' ? '不可购买' : '价格候选（内容未核验）'}`);
    }
    L.push('');
    L.push('建议：稍后重试、更换门店，或在官方 APP 核对营业时段后再仲裁。本工具不代下单、不托管资金。');
    return L.join('\n');
  }
  L.push('【怎么买】');
  L.push(`门店 ${store.storeCode} ${store.storeName}`);

  const candidates: Array<{ sol: KernelGroupSolution; label: string }> = [];
  if (out.unified && out.unified.length > 0) {
    out.unified.forEach((u, i) => candidates.push({ sol: u, label: `unified-${i + 1}` }));
  } else {
    candidates.push({ sol, label: 'main' });
    if (out.bundle) candidates.push({ sol: out.bundle as KernelGroupSolution, label: 'bundle' });
  }

  // v1.4.6 R16：推荐标记取内核给出的唯一推荐索引（与比价决策同源），不再固定标记第一个候选。
  const recIdx = Math.min(Math.max(0, out.recommendedIndex ?? 0), Math.max(0, candidates.length - 1));
  // v1.4.10 W17：截断时必须保留**真正推荐**的候选——旧实现只 slice(0,3)，
  //   recommendedIndex=3 时展示区没有推荐标记，分账却取第四个方案，用户拿不到该方案的购买清单。
  const shownIdx: number[] = [];
  for (let i = 0; i < Math.min(3, candidates.length); i++) shownIdx.push(i);
  if (!shownIdx.includes(recIdx)) shownIdx[shownIdx.length - 1] = recIdx;
  shownIdx.sort((a, b) => a - b);
  shownIdx.forEach((idx, order) => {
    L.push(...renderOneSolution(candidates[idx].sol, order + 1, shownIdx.length, idx === recIdx));
    L.push(line());
  });

  // 决策说明
  if (out.decision) {
    L.push(`【比价结论】${out.decision.label}：${out.decision.reason}（差额 ${yuan(out.decision.deltaCents)}，判平阈值 ${yuan(out.decision.thresholdCents)}）`);
  }

  // 详情·分账（推荐方案 = 内核推荐索引；缺省回退 unified[0] / solution）
  const best = candidates[recIdx]?.sol ?? (out.unified && out.unified[0]) ?? sol;
  L.push('【详情·分账（推荐方案）】');
  L.push('  规则：原价等比分摊 = 本人原价 × (整单实付 ÷ 整单原价)；个人券只冲减本人；尾差已守恒。');
  for (const mm of best.members) {
    const parts = [`原价 ${yuan(mm.originalCents)}`, `摊后 ${yuan(mm.shareCents)}`];
    if (mm.personalCouponCents) parts.push(`个人券 -${yuan(mm.personalCouponCents)}`);
    parts.push(`应付 ${yuan(mm.payableCents)}`);
    L.push(`  ${mm.alias}：${parts.join(' → ')}｜热量 ${mm.kcal} kcal`);
    if (mm.unresolvedWishes.length) L.push(`    ⚠️ 未满足心愿：${mm.unresolvedWishes.join('、')}`);
  }

  // 未满足与备注
  L.push('【未满足与备注】');
  const notes = best.orderNotes ?? [];
  if (notes.length) {
    L.push('  订单备注（在官方下单页填写，以可履约选项为准）：');
    for (const n of notes) L.push(`    · ${n}`);
  }
  // v1.4.10 W15：区分「未匹配到菜单」与「已匹配但本方案未满足」。
  //   内核在本方案未满足时写入「（…当前方案未能满足）」；其余原文才是菜单未匹配。
  const allUnresolved = best.members.flatMap((mm) => mm.unresolvedWishes.map((w) => ({ alias: mm.alias, w })));
  const notInMenu = allUnresolved.filter((x) => !/当前方案未能满足/.test(x.w));
  const unmetHere = allUnresolved.filter((x) => /当前方案未能满足/.test(x.w));
  if (notInMenu.length) L.push(`  ⚠️ 未匹配到菜单：${notInMenu.map((x) => `${x.alias} 的「${x.w}」`).join('；')}（建议官方 App 检索后补单）`);
  if (unmetHere.length) L.push(`  ⚠️ 本方案未满足（菜单内有候选，但当前组合/约束下未分配）：${unmetHere.map((x) => `${x.alias} 的「${x.w}」`).join('；')}`);
  if (!allUnresolved.length && !notes.length) L.push('  无');
  if (best.warnings?.length) for (const w of best.warnings) L.push(`  ⚠️ ${w}`);
  L.push(`  ${best.disclaimer ?? '数据来自麦当劳官方 MCP，仅供参考，实际以门店为准。'}`);
  return L.join('\n');
}
