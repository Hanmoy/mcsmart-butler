// 静态演示专用网络适配层。
// 只拦截 /api/**；静态资源仍走 GitHub Pages。所有回执来自
// docs/demo/fixtures（由 scripts/demo-fixtures.mjs 用真实 service 生成），
// 不连接账户、不查询实时价格、不写任何用户数据。
(() => {
  const D = window.MCSMART_DEMO;
  if (!D || !D.single || !D.group) {
    console.error('[demo] 缺少 MCSMART_DEMO 数据，静态演示无法启动');
    return;
  }
  const nativeFetch = window.fetch.bind(window);
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

  function newJob(kind) {
    const id = `demo-${kind}-${++jobSeq}`;
    jobs.set(id, { kind, polls: 0 });
    return id;
  }

  function jobStatus(id) {
    const job = jobs.get(id);
    if (!job) return json({ error: '演示任务不存在', code: 'E_NOT_FOUND' }, 404);
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
      });
    }
    return json({
      jobId: id,
      stage: '生成方案',
      stages: ['准备菜单', '解析团购', '优化组合', '核验价格', '生成方案'],
      elapsedMs: 1460,
      done: true,
      cancelled: false,
      result: job.kind === 'group' ? D.group : D.single,
    });
  }

  async function handle(input, init = {}) {
    const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
    const url = new URL(raw, window.location.href);
    const path = url.pathname;
    const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    if (!isApi(path)) return nativeFetch(input, init);

    // 任务：异步入口返回 jobId，轮询时先给两帧阶段，再返回内置结果。
    if (method === 'POST' && path.endsWith('/api/jobs/solve')) {
      return json({ jobId: newJob('single') }, 202);
    }
    if (method === 'POST' && path.endsWith('/api/jobs/group-solve')) {
      return json({ jobId: newJob('group') }, 202);
    }
    if (method === 'POST' && /\/api\/jobs\/[^/]+\/cancel$/.test(path)) {
      return json({ ok: true });
    }
    if (method === 'GET' && /\/api\/jobs\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
      return jobStatus(id);
    }

    if (path.endsWith('/api/solve') && method === 'POST') return json(D.single);
    if (path.endsWith('/api/group-solve') && method === 'POST') return json(D.group);
    if (path.endsWith('/api/parse-group') && method === 'POST') return json(D.parseGroup);

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
          { storeCode: 'S-DEMO-2', storeName: '麦当劳（南京东路店）', address: '上海市黄浦区南京东路 300 号（演示地址）', distance: 860, open: true },
        ],
      });
    }
    if (path.endsWith('/api/prewarm')) return json({ accepted: true, storeCode: demoStore.storeCode });

    // McDNA：内置演示报告，不需要真实订单。
    if (path.endsWith('/api/mcdna/templates')) return json({ templates: [{ id: 'status', name: '麦门状态栏' }] });
    if (path.endsWith('/api/mcdna/render') || (path.endsWith('/api/mcdna') && method === 'POST')) {
      return json(D.mcdna);
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
      return json({ ok: false, code: 'E_DEMO_READONLY', message: '静态演示不连接账户，也不保存 Token' });
    }
    if (path.includes('/api/')) {
      return json({ ok: true, demo: true, note: '静态演示未实现该接口' });
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
    markResults();
    const observer = new MutationObserver(markResults);
    const results = document.getElementById('results');
    const groupResults = document.getElementById('groupResults');
    if (results) observer.observe(results, { childList: true, subtree: true });
    if (groupResults) observer.observe(groupResults, { childList: true, subtree: true });
  });
})();
