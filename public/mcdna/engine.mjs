// McDNA v6「麦门状态栏」渲染器：纯函数。输入由 src/mcdnaReport.ts 算好的视图模型，输出自包含 SVG。
// 文字一律用随包像素点阵字（Fusion Pixel 12px，OFL-1.1）绘成矢量方块，不依赖系统字体；图片只接受 data: URI。
// 本文件不计算统计、不判定门派、不改写文案，只负责排版。
const W = 540, H = 720;
const C = { ink: '#24314e', red: '#c8432e', cream: '#f5e6c8', yellow: '#e6b23a', sub: '#e8d6b4' };
const SLOT = ['清晨', '午间', '午后', '傍晚', '深夜'];
const NO_START = '，。、！？；：）」』》】…—·%,.!?;:)';
const r2 = n => Math.round(n * 100) / 100;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function seeded(str) {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  let x = h >>> 0 || 1;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function jitter(hex, amt, rnd) {
  const n = parseInt(hex.slice(1), 16), k = 1 + (rnd() - 0.5) * amt;
  const c = v => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
const TOFU = 'M1 2h10v1h-10zM1 11h10v1h-10zM1 3h1v8h-1zM10 3h1v8h-1z';
function glyphPath(rows) {
  let d = '';
  rows.forEach((m, y) => {
    for (let x = 0; x < 16;) {
      if (m & (0x8000 >> x)) { let e = x; while (e < 16 && (m & (0x8000 >> e))) e++; d += `M${x} ${y}h${e - x}v1h${x - e}z`; x = e; } else x++;
    }
  });
  return d || 'M0 0';
}

// 像素字排版：注册用到的字形到 <defs>，正文用 <use> 复用。
class Pix {
  constructor(font) { this.font = font; this.defs = new Map(); this.missing = new Set(); }
  adv(ch) { const g = this.font.glyph(ch.codePointAt(0)); return g ? g.adv : 12; }
  width(t, s) { let w = 0; for (const ch of t) w += this.adv(ch); return w * s; }
  id(ch) {
    const cp = ch.codePointAt(0), id = 'g' + cp.toString(16);
    if (!this.defs.has(id)) { const g = this.font.glyph(cp); if (!g) this.missing.add(ch); this.defs.set(id, g ? glyphPath(g.rows) : TOFU); }
    return id;
  }
  // y 为字形顶边；anchor = start | middle | end
  text(x, y, t, s, fill, anchor = 'start', extra = '') {
    t = String(t);
    const w = this.width(t, s), x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    let cx = 0, uses = '';
    for (const ch of t) { if (ch !== ' ' && ch !== '\u3000') uses += `<use href="#${this.id(ch)}" x="${cx}"/>`; cx += this.adv(ch); }
    return `<g transform="translate(${r2(x0)} ${r2(y)}) scale(${s})" fill="${fill}"${extra}>${uses}</g>`;
  }
  ellipsize(t, s, maxW) {
    t = String(t);
    if (this.width(t, s) <= maxW) return t;
    const chars = Array.from(t);
    while (chars.length > 1 && this.width(chars.join('') + '…', s) > maxW) chars.pop();
    return chars.join('') + '…';
  }
  fit(t, maxW, scales) { return scales.find(s => this.width(t, s) <= maxW) ?? scales[scales.length - 1]; }
  wrap(t, s, maxW) {
    const lines = []; let line = '';
    for (const ch of Array.from(String(t))) {
      if (line && this.width(line + ch, s) > maxW) {
        if (NO_START.includes(ch) && Array.from(line).length > 1) { const a = Array.from(line); const last = a.pop(); lines.push(a.join('')); line = last + ch; }
        else { lines.push(line); line = ch; }
      } else line += ch;
    }
    if (line) lines.push(line);
    // 避免单字孤行：从上一行借一个字下来。
    const n = lines.length;
    if (n > 1 && Array.from(lines[n - 1]).filter(c => !NO_START.includes(c)).length <= 1) {
      const prev = Array.from(lines[n - 2]);
      if (prev.length >= 4) {
        let moved = prev.pop();
        if (NO_START.includes(moved) && prev.length > 3) moved = prev.pop() + moved;
        lines[n - 2] = prev.join(''); lines[n - 1] = moved + lines[n - 1];
      }
    }
    return lines;
  }
  defsSvg() { return [...this.defs].map(([id, d]) => `<path id="${id}" d="${d}"/>`).join(''); }
}

function stepPath(x, y, w, h, s) {
  return `M${x + 2 * s},${y} H${x + w - 2 * s} V${y + s} H${x + w - s} V${y + 2 * s} H${x + w} V${y + h - 2 * s} H${x + w - s} V${y + h - s} H${x + w - 2 * s} V${y + h} H${x + 2 * s} V${y + h - s} H${x + s} V${y + h - 2 * s} H${x} V${y + 2 * s} H${x + s} V${y + s} H${x + 2 * s} Z`;
}
const cross = (cx, cy) => `<path d="M${cx - 9},${cy - 9}L${cx + 9},${cy + 9}M${cx + 9},${cy - 9}L${cx - 9},${cy + 9}" stroke="${C.red}" stroke-width="4" stroke-linecap="round"/>`;
const FRAME = `<g filter="url(#yarn)" fill="none"><path d="${stepPath(11, 11, 518, 698, 9)}" stroke="${C.ink}" stroke-width="5" opacity=".92"/><path d="${stepPath(19, 19, 502, 682, 7)}" stroke="${C.red}" stroke-width="2.4" stroke-dasharray="8 6" opacity=".85"/>${cross(24, 24)}${cross(516, 24)}${cross(24, 696)}${cross(516, 696)}</g>`;
function roughPath(x, y, w, h, rnd) {
  const N = 14, p = [];
  for (let i = 0; i <= N; i++) p.push([x + (i / N) * w, y + rnd() * h * 0.012]);
  for (let i = 0; i <= N; i++) p.push([x + w - rnd() * w * 0.008, y + (i / N) * h]);
  for (let i = N; i >= 0; i--) p.push([x + (i / N) * w, y + h - rnd() * h * 0.012]);
  for (let i = N; i >= 0; i--) p.push([x + rnd() * w * 0.008, y + (i / N) * h]);
  return 'M' + p.map(q => `${r2(q[0])},${r2(q[1])}`).join('L') + 'Z';
}
function patch(x, y, w, h, rnd, { stitch = C.red, stitchOpacity = 0.85, fill = null } = {}) {
  const d = roughPath(x, y, w, h, rnd);
  const face = fill ? `<path d="${d}" fill="${fill}"/>` : `<path d="${d}" fill="url(#card)"/><path d="${d}" fill="#fff0d2" fill-opacity=".32"/>`;
  return `<g filter="url(#shadow)">${face}</g><rect x="${x + 6}" y="${y + 6}" width="${w - 12}" height="${h - 12}" rx="3" fill="none" stroke="${stitch}" stroke-opacity="${stitchOpacity}" stroke-width="2" stroke-dasharray="6 4"/>`;
}
// 等比放进盒子；align: 'bl' 左下 | 'bc' 底部居中 | 'c' 居中 | 'l' 左中
function img(a, x, y, w, h, align = 'c', extra = '') {
  if (!a) return '';
  const k = Math.min(w / a.w, h / a.h), iw = a.w * k, ih = a.h * k;
  const ix = align === 'bl' || align === 'l' ? x : x + (w - iw) / 2;
  const iy = align === 'bl' || align === 'bc' ? y + h - ih : y + (h - ih) / 2;
  return `<image href="${a.uri}" x="${r2(ix)}" y="${r2(iy)}" width="${r2(iw)}" height="${r2(ih)}"${extra}/>`;
}
function chip(px, x, y, t, { fill = 'none', stroke = C.ink, color = C.ink, dash = true, pad = 7 } = {}) {
  const w = px.width(t, 1) + pad * 2;
  return { w, svg: `<rect x="${x}" y="${y}" width="${r2(w)}" height="20" fill="${fill}" stroke="${stroke}" stroke-width="2"${dash ? ' stroke-dasharray="5 3"' : ''}/>` + px.text(x + pad, y + 3, t, 1, color) };
}

function defs(vm, px, extra = '') {
  return `<defs><clipPath id="round"><rect width="${W}" height="${H}" rx="10"/></clipPath>
<image id="cb" href="${vm.assets.cardboard.uri}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>
<pattern id="card" patternUnits="userSpaceOnUse" width="700" height="933"><use href="#cb" transform="scale(1.2963)"/></pattern>
<radialGradient id="vig" cx="50%" cy="50%" r="75%"><stop offset=".62" stop-color="#462808" stop-opacity="0"/><stop offset="1" stop-color="#462808" stop-opacity=".38"/></radialGradient>
<filter id="yarn" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3"/><feDisplacementMap in="SourceGraphic" scale="2.2"/></filter>
<filter id="shadow" x="-6%" y="-6%" width="112%" height="120%"><feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#3c230a" flood-opacity=".32"/></filter>
<filter id="lift" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="3" stdDeviation="2" flood-color="#3c230a" flood-opacity=".38"/></filter>
${extra}${px.defsSvg()}</defs>`;
}
function shell(vm, side, px, body, extraDefs, label) {
  const attrs = `data-template="status" data-side="${side}" data-source="${vm.demo ? 'demo' : 'official'}" data-text-source="${vm.textSource}" data-sect="${esc(vm.persona.sect)}" data-scene="${esc(vm.persona.scene)}" data-body="${esc(vm.persona.body)}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label.title)}" ${attrs}><title>${esc(label.title)}</title><desc>${esc(label.desc)}</desc>${defs(vm, px, extraDefs)}<g clip-path="url(#round)"><use href="#cb"/><rect width="${W}" height="${H}" fill="url(#vig)"/>${FRAME}${body}</g></svg>`;
}
function header(px, left, mid, tag) {
  const tw = px.width(tag, 1) + 16;
  return px.text(48, 30, left, 2, C.ink) + px.text(W / 2, 37, mid, 1, C.ink, 'middle')
    + `<rect x="${r2(492 - tw)}" y="33" width="${r2(tw)}" height="22" fill="none" stroke="${C.red}" stroke-width="2" stroke-dasharray="5 3"/>` + px.text(492 - tw + 8, 37, tag, 1, C.red);
}

function front(vm, px, rnd) {
  const P = vm.persona, T = vm.copy;
  let s = header(px, 'McDNA', px.ellipsize(`麦门状态栏 · ${vm.period}`, 1, 260), vm.demo ? '演示数据' : '官方存档');
  // —— 角色卡 ——
  s += patch(30, 72, 480, 212, rnd);
  s += `<g filter="url(#lift)">${img(vm.assets.hero, 42, 98, 150, 172, 'bl')}</g>`;
  const pa = vm.assets.prop, pk = pa ? Math.min(62 / pa.w, 70 / pa.h) : 1;
  if (pa) s += `<g filter="url(#lift)" transform="rotate(12 ${r2(216 - pa.w * pk / 2)} ${r2(264 - pa.h * pk / 2)})">${img(pa, 216 - pa.w * pk, 264 - pa.h * pk, pa.w * pk, pa.h * pk)}</g>`;
  const X = 226, IW = 270;
  const sectT = `麦门 · ${P.sectName}`, sw = px.width(sectT, 1) + 16;
  s += `<rect x="${X}" y="86" width="${r2(sw)}" height="20" fill="${C.ink}"/>` + px.text(X + 8, 89, sectT, 1, C.cream);
  const roleT = px.ellipsize(`身份 · ${P.role}`, 1, IW - sw - 18), rw = px.width(roleT, 1) + 12;
  s += `<rect x="${r2(X + sw + 6)}" y="87" width="${r2(rw)}" height="18" fill="none" stroke="${C.red}" stroke-width="2" stroke-dasharray="5 3"/>` + px.text(X + sw + 12, 89, roleT, 1, C.red);
  const ts = px.fit(T.title, IW, [3, 2.5, 2, 1.5]);
  const title = px.ellipsize(T.title, ts, IW);
  s += px.text(X + 2, 114 + 2, title, ts, C.ink, 'start', ' opacity=".85"') + px.text(X, 114, title, ts, C.red);
  s += px.text(X, 160, `Lv.${vm.orders}`, 2, C.ink);
  s += px.text(X + px.width(`Lv.${vm.orders}`, 2) + 8, 172, '等级＝这段时间的下单数', 1, C.ink, 'start', ' opacity=".8"');
  s += px.text(X, 202, px.ellipsize(P.bar.label, 1, 170), 1, C.ink) + px.text(X + IW, 192, P.bar.value, 2, C.red, 'end');
  s += `<rect x="${X}" y="222" width="${IW}" height="24" rx="12" fill="${C.cream}" fill-opacity=".5" stroke="${C.ink}" stroke-width="3"/>`;
  const N = 26, cx0 = X + 9, cw = (IW - 18 - (N - 1) * 2) / N, on = Math.max(P.bar.ratio > 0 ? 1 : 0, Math.round(N * Math.min(1, P.bar.ratio)));
  for (let i = 0; i < on; i++) { const x = cx0 + i * (cw + 2); s += `<rect x="${r2(x)}" y="228" width="${r2(cw)}" height="12" rx="1" fill="${jitter(C.red, 0.22, rnd)}" transform="rotate(${r2((rnd() - 0.5) * 10)} ${r2(x + cw / 2)} 234)"/>`; }
  if (P.bar.max) for (let k = 0; k < 6; k++) { const z = 5 + rnd() * 5, x = X + IW - 6 + k * 5 + rnd() * 4, y = 214 + rnd() * 30; s += `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(z)}" height="${r2(z)}" rx="1" fill="${jitter(C.red, 0.25, rnd)}" transform="rotate(${r2(rnd() * 40 - 20)} ${r2(x + z / 2)} ${r2(y + z / 2)})"/>`; }
  s += px.text(X, 254, px.ellipsize(P.bar.caption, 1, IW), 1, C.ink, 'start', ' opacity=".85"');
  // —— 背包 ——
  s += patch(30, 296, 480, 134, rnd, { stitch: C.ink, stitchOpacity: 0.7 });
  s += px.text(46, 307, '背包 · 按份数', 1, C.ink);
  s += px.text(494, 307, vm.kinds === null ? (vm.qty ? `明细不全 · 已知 ${vm.qty} 份` : '明细未取得') : `共 ${vm.kinds} 种 / ${vm.qty} 份`, 1, C.ink, 'end');
  const sw4 = (452 - 30) / 4, items = vm.items, more = vm.kinds !== null && vm.kinds > 4;
  const shown = items.slice(0, more ? 3 : 4);
  for (let i = 0; i < 4; i++) {
    const x = 44 + i * (sw4 + 10), y = 328, it = shown[i];
    if (it) {
      s += `<rect x="${r2(x)}" y="${y}" width="${r2(sw4)}" height="88" fill="${i ? C.cream : C.yellow}" fill-opacity="${i ? 0.55 : 0.45}" stroke="${C.ink}" stroke-width="3"/>`;
      s += `<g filter="url(#lift)">${img(vm.assets.icons[it.icon], x + 8, y + 10, 64, 44, 'l')}</g>`;
      const cnt = `×${it.qty}`;
      for (const [dx, dy] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) s += px.text(x + sw4 - 5 + dx, y + 4 + dy, cnt, 2, C.cream, 'end');
      s += px.text(x + sw4 - 5, y + 4, cnt, 2, C.red, 'end');
      s += px.text(x + sw4 / 2, y + 64, px.ellipsize(it.name, 1, sw4 - 8), 1, C.ink, 'middle');
    } else if (i === 3 && more) {
      s += `<rect x="${r2(x)}" y="${y}" width="${r2(sw4)}" height="88" fill="${C.cream}" fill-opacity=".55" stroke="${C.ink}" stroke-width="3"/>`;
      s += px.text(x + sw4 / 2, y + 18, `+${vm.kinds - 3}`, 2, C.ink, 'middle') + px.text(x + sw4 / 2, y + 56, px.ellipsize(`其他 ${vm.otherQty} 份`, 1, sw4 - 8), 1, C.ink, 'middle');
    } else {
      s += `<rect x="${r2(x)}" y="${y}" width="${r2(sw4)}" height="88" fill="${C.cream}" fill-opacity=".3" stroke="${C.ink}" stroke-opacity=".7" stroke-width="3" stroke-dasharray="7 5"/>` + px.text(x + sw4 / 2, y + 38, '空位 · 待解锁', 1, C.ink, 'middle', ' opacity=".7"');
    }
  }
  // —— 属性 ——
  s += patch(30, 444, 480, 178, rnd);
  const stat = (x, y, icon, key, val) => `${icon ? `<g filter="url(#lift)">${img(icon, x, y + 3, 28, 28)}</g>` : ''}` + px.text(x + 36, y + 10, key, 1, C.ink, 'start', ' opacity=".85"') + val(x + 219, y)
    + `<line x1="${x}" y1="${y + 38}" x2="${x + 219}" y2="${y + 38}" stroke="${C.ink}" stroke-opacity=".45" stroke-width="2" stroke-dasharray="6 4"/>`;
  const big = (n, unit) => (x, y) => { const uw = unit ? px.width(unit, 1) : 0; return px.text(x - uw, y + 4, String(n), 2, C.ink, 'end') + (unit ? px.text(x, y + 14, unit, 1, C.ink, 'end') : ''); };
  const small = t => (x, y) => px.text(x, y + 10, t, 1, C.ink, 'end');
  const wallet = vm.wallet.mode === 'full'
    ? (vm.wallet.text ? big(vm.wallet.text, '') : small('未取得'))
    : (x, y) => {
      if (!vm.wallet.text) return small('未取得')(x, y);
      const tw = px.width(vm.wallet.text, 2), pal = ['#8a6a4a', '#a8845c', '#5c4630', '#c9a77a', '#24314e', '#6d5238'];
      let m = ''; for (let i = 0; i < 27; i++) m += `<rect x="${r2(x - tw - 8 - 71 + (i % 9) * 8)}" y="${y + 6 + Math.floor(i / 9) * 8}" width="7" height="7" rx="1" fill="${pal[Math.floor(rnd() * pal.length)]}"/>`;
      return m + px.text(x, y + 4, vm.wallet.text, 2, C.ink, 'end');
    };
  s += stat(44, 454, vm.assets.icons.coin, vm.wallet.mode === 'full' ? '钱包' : '钱包 · 打码', wallet);
  s += stat(277, 454, vm.assets.icons.heart, '图鉴收集', vm.kinds === null ? small('未统计') : big(vm.kinds, ' 种'));
  s += stat(44, 496, vm.assets.watch, '常驻时段', vm.dated === 0 ? small('没有时间') : vm.peak ? (x, y) => px.text(x - px.width(` ×${vm.peak.n}`, 1), y + 4, vm.peak.label, 2, C.ink, 'end') + px.text(x, y + 14, ` ×${vm.peak.n}`, 1, C.ink, 'end') : small('不固定'));
  const nm = vm.night + vm.morning === 0
    ? ['最常点', vm.assets.icons.star, vm.top ? (x, y) => px.text(x - px.width(` ×${vm.top.qty}`, 2), y + 10, px.ellipsize(vm.top.short, 1, 90) + ' ', 1, C.ink, 'end') + px.text(x, y + 4, `×${vm.top.qty}`, 2, C.ink, 'end') : small('暂无')]
    : vm.night >= vm.morning ? ['深夜出没', vm.assets.icons.moon, big(`×${vm.night}`, '')] : ['清晨出没', vm.assets.clock, big(`×${vm.morning}`, '')];
  s += stat(277, 496, nm[1], nm[0], nm[2]);
  if (vm.dated > 0) {
    const mx = Math.max(...vm.clock), cwid = (452 - 40) / 5;
    vm.clock.forEach((c, i) => {
      const cx = 44 + i * (cwid + 10) + cwid / 2, hot = c === mx && c > 0;
      for (let k = 0; k < Math.min(c, 6); k++) s += `<rect x="${r2(cx - 15)}" y="${596 - (k + 1) * 9 + 2}" width="30" height="7" rx="1" fill="${jitter(hot ? C.red : C.ink, 0.25, rnd)}" transform="rotate(${r2((rnd() - 0.5) * 8)} ${r2(cx)} ${596 - k * 9 - 3.5})"/>`;
      if (c > 6) s += px.text(cx + 18, 542, '+', 1, hot ? C.red : C.ink);
      s += px.text(cx, 600, `${SLOT[i]} ${c}`, 1, hot ? C.red : C.ink, 'middle');
    });
  } else s += px.text(W / 2, 560, '订单没有时间字段，本期不统计饭点', 1, C.ink, 'middle', ' opacity=".8"');
  // —— 供能比与口径 ——
  if (vm.pfc) {
    s += px.text(34, 642, '供能比', 1, C.ink);
    const parts = [['蛋白', vm.pfc.p, C.red], ['碳水', vm.pfc.c, C.yellow], ['脂肪', vm.pfc.f, C.ink]], mw = (506 - 86 - 28) / 3;
    parts.forEach(([k, v, col], i) => {
      const x = 86 + i * (mw + 14), tx = x + 30, tw = mw - 30 - 34;
      s += px.text(x, 642, k, 1, C.ink) + `<rect x="${r2(tx)}" y="643" width="${r2(tw)}" height="10" fill="${C.cream}" fill-opacity=".5" stroke="${C.ink}" stroke-width="2"/><rect x="${r2(tx + 1)}" y="644" width="${r2(Math.max(0, (tw - 2) * v / 100))}" height="8" fill="${col}"/>` + px.text(x + mw, 642, `${v}%`, 1, C.ink, 'end');
    });
  } else s += px.text(34, 642, px.ellipsize(`营养只收录 ${vm.pfcKnown}/${vm.qty} 份，不足八成，本期不显示供能比`, 1, 472), 1, C.ink);
  s += px.text(34, 668, vm.pfc ? `营养已收录 ${vm.pfcKnown}/${vm.qty} 份 · 不作健康评价` : '不作健康评价', 1, C.ink, 'start', ' opacity=".8"');
  s += px.text(506, 668, `${vm.wallet.mode === 'full' ? '金额完整显示' : '金额已打码'} · 时间 ${vm.dated}/${vm.orders} 单`, 1, C.ink, 'end', ' opacity=".8"');
  return s;
}

function back(vm, px, rnd) {
  const P = vm.persona, T = vm.copy;
  let s = header(px, 'McDNA', '存档 02 / 02', `${vm.demo ? '演示 · ' : ''}${vm.textSource === 'agent' ? 'Agent 撰写' : '规则生成'}`);
  // —— 场景 ——
  const sc = vm.assets.scene, k = Math.max(480 / sc.w, 300 / sc.h);
  s += `<rect x="30" y="68" width="480" height="300" fill="#3c230a" opacity=".35"/><g clip-path="url(#sceneclip)"><image href="${sc.uri}" x="${r2(270 - sc.w * k / 2)}" y="${r2(214 - sc.h * k / 2)}" width="${r2(sc.w * k)}" height="${r2(sc.h * k)}"/>`;
  vm.assets.extras.forEach((a, i) => { s += `<g filter="url(#lift)">${img(a, i ? 340 : 60, 214, 140, 120, 'bc')}</g>`; });
  s += `<g filter="url(#lift)">${img(vm.assets.actor, 150, 168, 240, 170, 'bc')}</g></g>`;
  s += `<rect x="30" y="64" width="480" height="300" fill="none" stroke="${C.ink}" stroke-width="4"/>`;
  const cap = px.ellipsize(`${P.sectName} · 派规：${P.sectRule}`, 1, 440), capW = px.width(cap, 1) + 16;
  s += `<rect x="40" y="74" width="${r2(capW)}" height="22" fill="${C.ink}" fill-opacity=".88"/>` + px.text(48, 78, cap, 1, C.cream);
  // —— 成就 ——
  s += `<g transform="rotate(-2 270 367)">` + patch(72, 328, 396, 78, rnd);
  s += `<g filter="url(#lift)">${img(vm.assets.prop, 90, 339, 52, 56)}</g>`;
  const AX = 154, AW = 296;
  s += px.text(AX, 340, '★ 成就解锁 ★', 1, C.red);
  const a0 = T.achievements[0] ?? '', as = px.fit(a0, AW, [2, 1.5, 1]);
  s += px.text(AX, 356, px.ellipsize(a0, as, AW), as, C.ink);
  if (T.achievements.length > 1) s += px.text(AX, 386, px.ellipsize('另得：' + T.achievements.slice(1).join(' · '), 1, AW), 1, C.ink, 'start', ' opacity=".85"');
  s += `</g>`;
  // —— 对话框 ——
  s += patch(30, 424, 480, 178, rnd, { stitch: C.cream, stitchOpacity: 0.55, fill: 'rgba(36,49,78,.92)' });
  const spk = '麦麦管家', spw = px.width(spk, 1) + 20;
  s += `<rect x="48" y="410" width="${r2(spw)}" height="24" fill="${C.red}" stroke="${C.ink}" stroke-width="2"/>` + px.text(58, 415, spk, 1, C.cream);
  const SX = 52, SW = 436, top = 444, bottom = 590;
  const vs = px.fit(T.verdict, SW, [2.5, 2]);
  const vLines = px.wrap(T.verdict, vs, SW), vLH = 16 * vs;
  let y = top;
  for (const line of vLines) { s += px.text(SX, y, line, vs, C.cream); y += vLH; }
  y += 6;
  const plans = [[2, 30], [1.5, 24], [1, 20]];
  let plan = plans.find(([sc2, lh]) => y + px.wrap(T.dialogue, sc2, SW).length * lh - (lh - 14 * sc2) <= bottom) ?? plans[2];
  for (const line of px.wrap(T.dialogue, plan[0], SW)) { s += px.text(SX, y, line, plan[0], C.sub); y += plan[1]; }
  s += `<path d="M472 584h12l-6 7z" fill="${C.yellow}"/>`;
  // —— 存档条与结尾钩子 ——
  let x = 44;
  const chips = [['存档'], ['', vm.orders, ' 单'], ...(vm.kinds !== null ? [['', vm.kinds, ' 种餐品']] : []), ...(vm.top ? [[px.ellipsize(vm.top.short, 1, 84) + ' ', vm.top.qty, ' 份']] : [])];
  for (const [pre, n, unit] of chips) {
    const t = pre + (n ?? '') + (unit ?? ''), w = px.width(t, 1) + 14;
    if (x + w > 496) break;
    s += `<rect x="${r2(x)}" y="614" width="${r2(w)}" height="22" fill="${C.cream}" fill-opacity=".35" stroke="${C.ink}" stroke-width="2" stroke-dasharray="5 3"/>`;
    s += px.text(x + 7, 618, pre, 1, C.ink);
    if (n !== undefined) { const nx = x + 7 + px.width(pre, 1); s += px.text(nx, 618, String(n), 1, C.red) + px.text(nx + px.width(String(n), 1), 618, unit, 1, C.ink); }
    x += w + 6;
  }
  const hs = px.fit(T.hook, 330, [2, 1.5]);
  s += px.text(44, hs === 2 ? 650 : 654, px.ellipsize(T.hook, hs, 330), hs, C.ink);
  const ctaW = px.width('晒出你的存档', 1);
  s += `<path d="M${r2(496 - ctaW - 14)} 650.5l8 5-8 5z" fill="${C.red}"/>` + px.text(496, 648, '晒出你的存档', 1, C.red, 'end') + px.text(496, 668, '#我的麦门状态栏', 1, C.ink, 'end');
  return s;
}

function labels(vm, side) {
  const P = vm.persona, T = vm.copy;
  const src = vm.demo ? '演示数据' : '官方订单';
  if (side === 'front') return {
    title: `McDNA 麦门状态栏 · ${src} · 正面`,
    desc: [`麦门 · ${P.sectName}`, `身份 · ${P.role}`, T.title, `Lv.${vm.orders}`, `${P.bar.label} ${P.bar.value}`, P.bar.caption,
      ...vm.items.slice(0, 4).map(i => `${i.name} ×${i.qty}`), vm.wallet.mode === 'full' ? `钱包 ${vm.wallet.text ?? '未取得'}` : '金额已打码',
      `营养已收录 ${vm.pfcKnown}/${vm.qty} 份 · 不作健康评价`].join('；'),
  };
  return {
    title: `McDNA 麦门状态栏 · ${src} · 背面 · ${vm.textSource === 'agent' ? 'Agent 撰写' : '规则生成'}`,
    desc: [`${P.sectName} · 派规：${P.sectRule}`, `场景 · ${P.sceneName}`, ...T.achievements, T.verdict, T.dialogue, T.hook].join('；'),
  };
}

export const McDNAReport = {
  version: 6,
  template: 'status',
  /** @returns {{svg:string, missing:string[]}} */
  render(vm, { side, font }) {
    if (side !== 'front' && side !== 'back') throw new Error('版面必须是 front 或 back');
    if (!font || typeof font.glyph !== 'function') throw new Error('像素字库未加载');
    const px = new Pix(font), rnd = seeded(`${vm.serial}|${side}`);
    const body = side === 'front' ? front(vm, px, rnd) : back(vm, px, rnd);
    const extra = side === 'back' ? '<clipPath id="sceneclip"><rect x="30" y="64" width="480" height="300"/></clipPath>' : '';
    return { svg: shell(vm, side, px, body, extra, labels(vm, side)), missing: [...px.missing] };
  },
  /** 供守门测量：返回按给定缩放换行后的行数。 */
  measure(font, text, scale, maxWidth) { return new Pix(font).wrap(text, scale, maxWidth).length; },
};
