// 静态演示专用网络适配层。
// 只拦截 /api/**；静态资源仍走 GitHub Pages。所有回执来自
// docs/demo/fixtures（由 scripts/demo-fixtures.mjs 用真实 service 生成），
// 不连接账户、不查询实时价格、不写任何用户数据。
(() => {
  const D = window.MCSMART_DEMO;
  const nativeFetch = window.fetch.bind(window);
  if (!D || !D.single || !D.group || !D.singleCases?.length || !D.groupInput) {
    console.error('[demo] 缺少 MCSMART_DEMO 数据，静态演示无法启动');
    // 缓存/部署混载时也不能让 API 穿透到网络或展示旧回执。
    window.fetch = (input, init) => {
      const raw = typeof input === 'string' ? input : input?.url || String(input);
      if (new URL(raw, window.location.href).pathname.includes('/api/')) {
        return Promise.resolve(new Response(JSON.stringify({ error: '演示数据版本不兼容，请刷新页面后重试', code: 'E_DEMO_DATA' }),
          { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
      }
      return nativeFetch(input, init);
    };
    return;
  }
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
  const jobs = new Map();
  let jobSeq = 0;
  const demoStore = { storeCode: 'S-DEMO', storeName: '麦当劳（人民广场店）' };

  function isApi(path) {
    return path.includes('/api/');
  }

  const scenarioError = () => json({ error: '静态演示仅支持预设场景；请切换示例。任意输入计算请运行本地完整版。', code: 'E_DEMO_SCENARIO' }, 400);
  const readonly = () => json({ error: '静态演示不保存数据或连接账户；请使用本地完整版。', code: 'E_DEMO_READONLY' }, 403);
  const singleKey = b => JSON.stringify({
    storeCode: b.storeCode, city: b.city || '上海', kcal: Number(b.kcal), yuan: Number(b.yuan),
    objectives: b.objectives || (b.objective ? [b.objective] : []),
    constraints: (b.constraints || []).map(c => [c.metric, c.op, Number(c.value)]).sort(),
    targetTime: String(b.targetTime || '').trim(),
  });
  const groupKey = b => JSON.stringify({
    storeCode: b.storeCode, city: b.city || '上海', targetTime: String(b.targetTime || '').trim(),
    userVouchers: b.userVouchers || [],
    members: (b.members || []).map(m => ({ alias: m.alias, wishes: m.wishes || [], taboos: m.taboos || [],
      notes: m.notes || [], sugarFree: !!m.sugarFree, kcalCap: m.kcalCap || null, personalCouponCents: m.personalCouponCents || null })),
  });
  function matchedResult(kind, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    if (kind === 'single' && (!Array.isArray(body.constraints || []) || !Array.isArray(body.objectives || []))) return undefined;
    if (kind === 'single' && (body.constraints || []).some(c => !c || typeof c !== 'object')) return undefined;
    if (kind === 'group' && (!Array.isArray(body.members) || body.members.some(m => !m || typeof m !== 'object'))) return undefined;
    if (kind === 'single') return D.singleCases.find(c => singleKey(c.input) === singleKey(body))?.result;
    return groupKey(D.groupInput) === groupKey(body) ? D.group : undefined;
  }

  function newJob(kind, result) {
    const id = `demo-${kind}-${++jobSeq}`;
    jobs.set(id, { kind, result, polls: 0, cancelled: false });
    if (jobs.size > 32) jobs.delete(jobs.keys().next().value);
    return id;
  }

  function jobStatus(id) {
    const job = jobs.get(id);
    if (!job) return json({ error: '演示任务不存在', code: 'E_NOT_FOUND' }, 404);
    if (job.cancelled) return json({ jobId: id, done: true, cancelled: true, code: 'E_CANCELLED', error: '已取消本次演示', elapsedMs: 0, stages: [] });
    job.polls += 1;
    if (job.polls <= 2) {
      const stages = job.polls === 1
        ? ['准备菜单']
        : ['准备菜单', '解析团购', '优化组合'];
      return json({
        jobId: id,
        stage: stages[stages.length - 1],
        stages,
        elapsedMs: job.polls * 430,
        done: false,
        cancelled: false,
        note: '演示进度 · 正在展示预先计算的示例，不查询实时数据',
      });
    }
    return json({
      jobId: id,
      stage: '生成方案',
      stages: ['准备菜单', '解析团购', '优化组合', '核验价格', '生成方案'],
      elapsedMs: 1460,
      done: true,
      cancelled: false,
      result: job.result,
    });
  }

  async function handle(input, init = {}) {
    const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
    const url = new URL(raw, window.location.href);
    const path = url.pathname;
    const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    if (!isApi(path)) return nativeFetch(input, init);
    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      try { body = typeof init.body === 'string' ? JSON.parse(init.body) : input?.clone ? await input.clone().json() : {}; }
      catch { return json({ error: '请求体必须是 JSON', code: 'E_INPUT_INVALID' }, 400); }
    }

    // 任务：异步入口返回 jobId，轮询时先给两帧阶段，再返回内置结果。
    if (method === 'POST' && (path.endsWith('/api/jobs/solve') || path.endsWith('/api/jobs/group-solve'))) {
      const kind = path.endsWith('/api/jobs/group-solve') ? 'group' : 'single';
      const result = matchedResult(kind, body);
      return result ? json({ jobId: newJob(kind, result) }, 202) : scenarioError();
    }
    if (method === 'POST' && /\/api\/jobs\/[^/]+\/cancel$/.test(path)) {
      const id = decodeURIComponent(path.split('/').at(-2));
      const job = jobs.get(id);
      if (!job) return json({ error: '演示任务不存在', code: 'E_NOT_FOUND' }, 404);
      if (job.polls < 3) job.cancelled = true;
      return json({ ok: true, cancelled: job.cancelled });
    }
    if (method === 'GET' && /\/api\/jobs\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
      return jobStatus(id);
    }

    if ((path.endsWith('/api/solve') || path.endsWith('/api/group-solve')) && method === 'POST') {
      const result = matchedResult(path.endsWith('/api/group-solve') ? 'group' : 'single', body);
      return result ? json(result) : scenarioError();
    }
    if (path.endsWith('/api/parse-group') && method === 'POST') return String(body.pastedText || '').trim() === D.demoText.trim() ? json(D.parseGroup) : scenarioError();
    const previewPost = ['/api/prewarm', '/api/mcdna/render', '/api/mcdna', '/api/deals', '/api/menu/period-catalog'];
    if (!['GET', 'HEAD'].includes(method) && !(method === 'POST' && previewPost.some(p => path.endsWith(p)))) return readonly();

    if (path.endsWith('/api/setup/status')) {
      return json({
        tokenConfigured: true,
        tokenSource: 'env',
        tokenMasked: 'DEMO-****',
        hasMeituan: false,
        configFile: '静态演示不读写本机配置',
        mcdPortalUrl: 'https://open.mcd.cn/mcp',
        applyGuideUrl: 'https://github.com/M-China/mcd-mcp-server',
      });
    }
    if (path.endsWith('/api/health')) {
      return json({ ok: true, name: 'mcsmart-butler', version: D.version, tokenConfigured: true, uptimeSec: 0, pid: 0 });
    }
    if (path.endsWith('/api/cities')) return json({ cities: ['上海'] });
    if (path.endsWith('/api/nearest-city')) return json({ city: '上海', distanceKm: 0 });
    if (path.endsWith('/api/stores')) {
      return json({
        stores: [
          { storeCode: demoStore.storeCode, storeName: demoStore.storeName, address: '上海市黄浦区人民大道 100 号（演示地址）', distance: 280, open: true },
        ],
      });
    }
    if (path.endsWith('/api/prewarm')) return json({ accepted: true, storeCode: demoStore.storeCode });

    // McDNA：内置演示报告，不需要真实订单。
    if (path.endsWith('/api/mcdna/templates')) return json({ templates: [{ id: 'status', name: '麦门状态栏' }] });
    if (path.endsWith('/api/mcdna/render') && method === 'POST') return readonly();
    if (path.endsWith('/api/mcdna') && method === 'POST') {
      if (body.demo !== true || body.amountMode !== 'tier') return scenarioError();
      return json({ ...D.mcdna, commentaryRequest: undefined });
    }
    if (path.endsWith('/api/mcdna') && method === 'GET') {
      return new Response(D.mcdna.frontSvg, { status: 200, headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' } });
    }

    // 高级数据管理：静态演示只展示空状态，不让页面报错。
    if (path.endsWith('/api/recipes') && method === 'GET') return json({ recipes: [], count: 0, presetCount: 0 });
    if (path.endsWith('/api/nutrition-supplements') && method === 'GET') return json({ supplements: [], count: 0, total: 0 });
    if (path.endsWith('/api/deals') && method === 'POST') {
      return json({
        storeCode: demoStore.storeCode, storeName: demoStore.storeName, menuAvailable: false, deals: [],
        diagnostics: { union: { source: 'none', queried: 0, deals: [], stats: { queried: 0, admitted: 0, priceCandidates: 0, menuVerified: 0, saleEnded: 0, validityExpired: 0, other: 0 } } },
      });
    }
    if (path.endsWith('/api/menu/period-catalog') && method === 'POST') {
      return json({
        storeCode: demoStore.storeCode, storeName: demoStore.storeName,
        catalog: { storeCode: demoStore.storeCode, date: '', fetchedAt: '', queries: [], items: [], counts: { breakfast: 0, regular: 0 }, unionCount: 0, note: '静态演示未提供分时段目录' },
        pools: [], ledger: [], targetPeriod: null, note: '静态演示未提供分时段目录',
      });
    }
    if (path.endsWith('/api/recipes/menu-candidates')) return json({ storeCode: demoStore.storeCode, source: 'demo', combos: [] });
    if (path.endsWith('/api/vouchers')) return json({ presets: [], disclaimer: '静态演示未接入券库' });
    if (path.endsWith('/api/setup/token') || path.endsWith('/api/setup/verify')) {
      return readonly();
    }
    if (path.includes('/api/')) {
      return json({ error: '静态演示未提供该接口', code: 'E_NOT_FOUND' }, 404);
    }
    return nativeFetch(input, init);
  }

  window.fetch = (input, init) => handle(input, init).catch((e) => {
    console.error('[demo] fetch failed', e);
    return json({ error: e && e.message ? e.message : String(e), code: 'E_DEMO' }, 500);
  });

  // 顶部状态胶囊不要说成“Token 已配置”：静态演示没有连接任何账户。
  const markTokenPill = () => {
    const pill = document.getElementById('tokenPill');
    if (!pill) return;
    pill.textContent = '● 静态演示';
    pill.title = '静态演示不连接真实账户，也不读取本机 Token';
    pill.classList.add('demo-pill');
  };
  window.addEventListener('load', () => {
    markTokenPill();
    setTimeout(markTokenPill, 400);
    setTimeout(markTokenPill, 1200);
  });

  // 预设输入与预计算回执一起切换，不把固定回执伪装成任意输入的计算结果。
  function setupScenarioUi() {
    const solve = document.getElementById('mode-solve');
    const form = solve.firstElementChild;
    const picker = document.createElement('div');
    picker.className = 'panel demo-scenarios';
    picker.innerHTML = '<label class="lb" for="demoScenario">选择演示场景</label><select id="demoScenario"></select><p class="note">以下条件随场景锁定。结果由同一套 service / MILP 在模拟菜单上预先计算。需要自由输入？<a href="https://github.com/Hanmoy/mcsmart-butler#30-秒跑起来" target="_blank" rel="noopener">运行本地完整版</a>。</p>';
    form.prepend(picker);
    const select = picker.querySelector('select');
    for (const c of D.singleCases) {
      const option = document.createElement('option');
      option.value = c.id; option.textContent = c.label;
      select.appendChild(option);
    }
    const applyScenario = () => {
      const c = D.singleCases.find(c => c.id === select.value);
      document.getElementById('kcal').value = c.input.kcal;
      document.getElementById('yuan').value = c.input.yuan;
      const staple = c.input.constraints.find(x => x.metric === 'staple')?.value || 0;
      document.getElementById('st-' + staple).checked = true;
      const goals = [...document.querySelectorAll('#objSeg input')];
      for (const el of goals) { el.checked = false; el.dispatchEvent(new Event('change')); }
      for (const goal of c.input.objectives) {
        const el = goals.find(el => el.value === goal);
        if (el) { el.checked = true; el.dispatchEvent(new Event('change')); }
      }
      document.getElementById('results').textContent = '已选择「' + c.label + '」，点击「开始精算」查看该场景的示例结果。';
      document.getElementById('status').style.display = 'none';
    };
    select.addEventListener('change', applyScenario);
    applyScenario();
    for (const el of form.querySelectorAll('input, button.btn-kcal, select[data-op]')) {
      if (el.type === 'text') el.readOnly = true;
      else el.disabled = true;
      el.title = '静态示例条件，请通过上方场景选择器切换';
    }
    const go = document.getElementById('go');
    const syncBusy = () => { select.disabled = go.disabled; };
    new MutationObserver(syncBusy).observe(go, { attributes: true, attributeFilter: ['disabled'] });
    syncBusy();

    const group = document.getElementById('mode-group');
    const note = document.createElement('div');
    note.className = 'notice';
    note.textContent = '三人拼单示例：点击「填入示例」→「解析」→「开始拼单仲裁」。成员与条件已锁定，避免固定结果被误读为你的新需求。';
    group.firstElementChild.prepend(note);
    document.getElementById('pasteBox').readOnly = true;
    document.getElementById('groupTargetTime').readOnly = true;
    for (const id of ['addMember', 'addVoucher', 'locBtn', 'citySel']) document.getElementById(id).disabled = true;
    document.getElementById('kwInput').readOnly = true;
    document.getElementById('storeHint').textContent = '仅提供一个模拟门店，菜单与价格为示例。静态演示不会读取位置或查询真实门店。';
    const members = document.getElementById('memberList');
    const lockMembers = () => members.querySelectorAll('input, button').forEach(el => {
      if (el.type === 'text') el.readOnly = true;
      else if (!el.disabled) el.disabled = true;
    });
    lockMembers();
    new MutationObserver(lockMembers).observe(members, { childList: true, subtree: true });
    // 标题与控件状态一致，成员条目仍可展开核对。
    for (const h of group.querySelectorAll('h2')) h.innerHTML = h.innerHTML.replace('成员确认卡（可编辑）', '成员确认卡（静态示例）');
    for (const id of ['mc-real', 'mc-full']) document.getElementById(id).disabled = true;
    document.querySelector('#mode-mcdna .panel .hint').textContent = '静态演示仅展示内置样本与档位脱敏金额，不读取真实订单、不接受 Agent 改稿。双面 SVG / PNG 导出仍可使用；完整功能请运行本地面板。';
  }

  // 结果卡上明确标注演示数据，避免价格被误读为真实报价。
  const markResults = () => {
    document.querySelectorAll('#results .sol, #groupResults .sol').forEach((card) => {
      if (card.querySelector(':scope > .demo-data-flag')) return;
      const note = document.createElement('div');
      note.className = 'demo-data-flag';
      note.textContent = '静态演示数据 · 不构成真实报价或下单结果';
      card.appendChild(note);
    });
  };
  document.addEventListener('DOMContentLoaded', () => {
    setupScenarioUi();
    markResults();
    const observer = new MutationObserver(markResults);
    const results = document.getElementById('results');
    const groupResults = document.getElementById('groupResults');
    if (results) observer.observe(results, { childList: true, subtree: true });
    if (groupResults) observer.observe(groupResults, { childList: true, subtree: true });
  });
})();
