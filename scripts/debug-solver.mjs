// 合成用例调试求解器
import { solve } from '../dist/solver.js';

const items = [
  { code: 'a', name: 'A堡', priceCents: 2000, kcal: 400, protein: 25, fat: 10, carbohydrate: 30, sodium: 800, fastCarb: 0, isVeggie: false, isStaple: true, nutritionMatched: true },
  { code: 'b', name: 'B饮料', priceCents: 500, kcal: 100, protein: 0, fat: 0, carbohydrate: 25, sodium: 0, fastCarb: 25, isVeggie: false, isStaple: false, nutritionMatched: true },
  { code: 'c', name: 'C蔬菜', priceCents: 600, kcal: 32, protein: 1, fat: 0, carbohydrate: 7, sodium: 10, fastCarb: 0, isVeggie: true, isStaple: false, nutritionMatched: true },
  { code: 'd', name: 'D鸡排', priceCents: 1500, kcal: 385, protein: 24, fat: 21, carbohydrate: 24, sodium: 996, fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: true },
  { code: 'e', name: 'E零度', priceCents: 800, kcal: 0, protein: 0, fat: 0, carbohydrate: 1, sodium: 25, fastCarb: 0, isVeggie: false, isStaple: false, nutritionMatched: true },
];

for (const obj of ['protein', 'sodium', 'fastCarb']) {
  const r = solve({ items, kcalBudget: 600, priceBudgetCents: 3000, objective: obj, maxItems: 6, poolSize: 5 });
  console.log(`\n== ${obj} feasible=${r.feasible} pool=${r.poolTried}`);
  for (const s of r.solutions) console.log('  ', s.items.map((i) => i.item.name).join('+'), JSON.stringify(s.metrics));
  if (!r.feasible) console.log('   reason:', r.reason);
}

// 价格守卫回归：3×¥3.4 = ¥10.2 > 预算 ¥9.5；旧「四舍五入」粒度会误判可行
const cheap = [1, 2, 3].map((i) => ({ code: 'x' + i, name: '小食' + i, priceCents: 340, kcal: 50, protein: 2, fat: 2, carbohydrate: 5, sodium: 100, fastCarb: 0, isVeggie: false, isStaple: true, nutritionMatched: true }));
const guard = solve({ items: cheap, kcalBudget: 600, priceBudgetCents: 950, objective: 'protein', maxItems: 6, poolSize: 8 });
const violation = guard.solutions.some((s) => s.metrics.price > 950);
console.log(`\n== 价格守卫：3×¥3.4 vs 预算¥9.5 → feasible=${guard.feasible}，超预算解=${violation ? '有(BUG!)' : '无 ✓'}`);
for (const s of guard.solutions) console.log('  ', s.items.map((i) => i.item.name).join('+'), '实付', s.metrics.price, '分');
