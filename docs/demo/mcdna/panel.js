// McDNA v6 面板控制器：只请求 service 产物、只做展示与本机导出；不重算统计、不改写文案、不调用生图。
// v1.4.11：生成、Agent 提交、PNG 导出各自持有任务号；任何 await 之后写状态前都核对归属，
//   迟到的健康检查/解码/编码不得修改新卡片、也不得清空新草稿。
(() => {
  const $ = s => document.querySelector(s);
  let seq = 0;              // 卡片代次：换设置/重新生成/载入新快照都会递增
  let controller = null;    // 生成请求
  let submitTask = null;    // 进行中的 Agent 提交 { id, ctrl }
  let submitSeq = 0;
  let exportSeq = 0;        // PNG 导出代次（换卡/换隐私设置后旧导出作废）
  let urls = [], report = null;
  const GEN_LABEL = '生 成 战 报';
  function revoke() { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; }
  function clearWarnings() {
    const box = $('#mcdnaWarn');
    if (box) { box.textContent = ''; box.style.display = 'none'; }
    const exp = $('#mcdnaExportErr');
    if (exp) { exp.textContent = ''; exp.style.display = 'none'; }
  }
  function clearArtifact() {
    for (const id of ['#mcdnaImg', '#mcdnaImgBack']) { const img = $(id); img.style.display = 'none'; img.removeAttribute('src'); }
    for (const id of ['#mcdnaDl', '#mcdnaDlBack']) { const a = $(id); a.style.display = 'none'; a.removeAttribute('href'); }
    $('#mcdnaTools').style.display = 'none'; $('#mcdnaAgent').style.display = 'none'; $('#mcdnaMeta').textContent = '';
    $('#mcdnaAgentErr').style.display = 'none'; revoke(); report = null; clearWarnings();
  }
  function setSubmitState(busy, label) {
    const btn = $('#mcdnaSubmit');
    btn.disabled = !!busy;
    btn.textContent = label || '提交 Agent 文案';
  }
  function reset() {
    seq++;
    controller?.abort(); controller = null;
    // v1.4.11 W16：旧提交必须取消并复位按钮，否则挂起的请求会一直锁住新卡片的提交。
    submitSeq++;
    submitTask?.ctrl?.abort(); submitTask = null;
    setSubmitState(false);
    exportSeq++;            // v1.4.11 W05：隐私/数据切换后旧导出作废（不得下载旧画布）
    clearArtifact();
    $('#goMcdna').disabled = false; $('#goMcdna').textContent = GEN_LABEL;
  }
  function fail(message) { $('#mcdnaErr').textContent = message; $('#mcdnaErr').style.display = 'block'; clearArtifact(); }
  async function networkReason() {
    const health = new AbortController(), timer = setTimeout(() => health.abort(), 1500);
    try { const r = await fetch('/api/health', { signal: health.signal }); return r.ok ? '本地面板在线，但战报请求未完成。请检查网络后重试。' : '本地面板服务异常，请重新启动后重试。'; }
    catch { return '本地面板服务已停止或无法连接，请重新启动面板后重试。'; }
    finally { clearTimeout(timer); }
  }
  // 只接受自包含 SVG：无脚本、无外链资源。
  async function svgUrl(text) {
    const doc = new DOMParser().parseFromString(String(text ?? ''), 'image/svg+xml');
    if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') throw Error('响应不是有效的 SVG 图片');
    if (doc.querySelector('script,foreignObject') || [...doc.querySelectorAll('image')].some(x => !String(x.getAttribute('href') || x.getAttribute('xlink:href') || '').startsWith('data:image/'))) throw Error('图片包含不支持的外部资源');
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    try { const probe = new Image(); probe.src = url; await probe.decode(); return url; }
    catch (e) { URL.revokeObjectURL(url); throw Error('SVG 无法解码'); }
  }
  async function post(path, body, signal) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.needSetup || typeof data.frontSvg !== 'string') {
      const msg = data.message || data.error || (data.needSetup ? '尚未配置自己的账户，请在首次配置页接入 Token' : `HTTP ${response.status}`);
      const err = Error(msg + (data.code ? `（${data.code}）` : '')); err.business = true; err.code = data.code; throw err;
    }
    return data;
  }
  /** 渲染当前卡片。返回 false = 任务已过期（调用方不得再写任何 UI）。 */
  async function show(data, mine) {
    const made = [];
    try { made.push(await svgUrl(data.frontSvg)); made.push(await svgUrl(data.backSvg)); }
    catch (e) { made.forEach(u => URL.revokeObjectURL(u)); throw e; }
    if (mine !== seq) { made.forEach(u => URL.revokeObjectURL(u)); return false; }
    revoke(); urls = made; report = data;
    const source = data.stats?.demo ? 'demo' : 'official';
    const [front, back] = made;
    $('#mcdnaImg').src = front; $('#mcdnaImgBack').src = back;
    $('#mcdnaImg').style.display = 'block'; $('#mcdnaImgBack').style.display = 'block';
    const dl = $('#mcdnaDl'), dlb = $('#mcdnaDlBack');
    dl.href = front; dl.download = `mcdna-${source}-${data.amountMode}-front.svg`; dl.style.display = 'inline-flex';
    dlb.href = back; dlb.download = `mcdna-${source}-${data.amountMode}-back.svg`; dlb.style.display = 'inline-flex';
    $('#mcdnaTools').style.display = 'flex';
    const p = data.persona || {};
    $('#mcdnaMeta').textContent = `麦门 · ${p.sectName ?? '—'} ｜ 身份「${p.role ?? '—'}」 ｜ 场景「${p.sceneName ?? '—'}」 ｜ 文案：${data.commentaryStatus === 'agent' ? 'Agent 撰写（已过守门）' : '内置梗库（规则生成）'}${p.weak ? ' ｜ ' + p.why : ''}`;
    $('#mcdnaAgent').style.display = data.commentaryRequest ? 'block' : 'none';
    if (data.commentaryRequest) $('#mcdnaPrompt').value = data.commentaryRequest.prompt;
    $('#mcdnaBox').dataset.source = source; $('#mcdnaBox').dataset.amountMode = data.amountMode;
    $('#mcdnaBox').dataset.textSource = data.commentaryStatus;
    // v1.4.11 W19：后端 warnings（缺字/明细不全/金额适配未验证）必须展示，不能静默画方框。
    const warnBox = $('#mcdnaWarn');
    const warns = Array.isArray(data.warnings) ? data.warnings.filter(w => typeof w === 'string' && w) : [];
    warnBox.textContent = ''; warnBox.style.display = warns.length ? 'block' : 'none';
    warns.forEach((w, i) => {
      if (i < 3) { const d = document.createElement('div'); d.textContent = '⚠️ ' + w; warnBox.appendChild(d); return; }
      let more = warnBox.querySelector('details');
      if (!more) {
        more = document.createElement('details');
        const sum = document.createElement('summary'); sum.textContent = '更多说明'; more.appendChild(sum);
        warnBox.appendChild(more);
      }
      const d = document.createElement('div'); d.textContent = '· ' + w; more.appendChild(d);
    });
    return true;
  }
  document.querySelectorAll('input[name=mcdnasrc],input[name=mcdnaamt]').forEach(input => input.addEventListener('change', () => {
    reset(); $('#mcdnaBox').style.display = 'block'; $('#mcdnaEmpty').style.display = 'none';
    $('#mcdnaErr').textContent = '设置已更新，旧图片与下载已收起。请重新生成。'; $('#mcdnaErr').style.display = 'block';
  }));
  $('#goMcdna').addEventListener('click', async () => {
    reset(); const mine = seq;
    const demo = $('input[name=mcdnasrc]:checked').value === 'demo';
    const amountMode = $('input[name=mcdnaamt]:checked').value === 'full' ? 'full' : 'tier';
    const local = new AbortController(); controller = local;
    const timer = setTimeout(() => local.abort(), 60000);
    $('#mcdnaBox').style.display = 'block'; $('#mcdnaEmpty').style.display = 'none';
    $('#mcdnaErr').style.display = 'none'; $('#mcdnaErr').textContent = '';
    $('#goMcdna').disabled = true; $('#goMcdna').textContent = demo ? '正在排版…' : '正在读取官方订单…';
    try {
      const data = await post('/api/mcdna', { demo, amountMode }, local.signal);
      if (mine !== seq) return;
      await show(data, mine);
    } catch (e) {
      if (mine !== seq) return;
      // v1.4.11 W15：诊断文案本身是 await；返回后必须再次核对代次，迟到的健康检查不得清掉新卡片。
      const message = e.name === 'AbortError' ? '生成超过60秒，已取消等待。请稍后重试；没有替换成演示数据。'
        : e instanceof TypeError ? await networkReason()
        : (e.business ? '战报生成失败：' : '战报渲染失败：') + e.message;
      if (mine !== seq) return;
      fail(message);
    } finally {
      clearTimeout(timer);
      if (mine === seq) { $('#goMcdna').disabled = false; $('#goMcdna').textContent = GEN_LABEL; }
    }
  });
  // 本机导出 PNG：把当前预览的同一份 SVG 画到 1080×1440 画布，不新增业务请求。
  async function savePng(side) {
    const cardSeq = seq, myExport = ++exportSeq;
    const url = side === 'front' ? urls[0] : urls[1];
    const snap = report;
    const err = $('#mcdnaExportErr');
    if (!url || !snap) return;
    const owned = () => myExport === exportSeq && cardSeq === seq;
    if (err) { err.textContent = ''; err.style.display = 'none'; }
    try {
      const img = new Image(); img.src = url; await img.decode();
      // v1.4.11 W05：解码/编码期间可能已切换隐私模式并生成新卡——旧任务一律作废，不得下载旧画布。
      if (!owned() || (side === 'front' ? urls[0] : urls[1]) !== url) return;
      const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1440;
      canvas.getContext('2d').drawImage(img, 0, 0, 1080, 1440);
      const blob = await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(Error('PNG 导出失败'))), 'image/png'));
      if (!owned()) return;
      const a = document.createElement('a'), href = URL.createObjectURL(blob);
      // 文件名与内容都取导出开始时的快照，避免中途切换模式造成「明文图 + 脱敏文件名」。
      a.href = href; a.download = `mcdna-${snap.stats?.demo ? 'demo' : 'official'}-${snap.amountMode}-${side}.png`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) {
      // v1.4.11 W18：导出失败只影响导出，不得删除当前双面与 SVG 下载。
      if (!owned() || !err) return;
      err.textContent = 'PNG 导出失败：' + e.message + '。当前卡片与 SVG 下载保持不变，可重试或直接下载 SVG。';
      err.style.display = 'block';
    }
  }
  $('#mcdnaPngFront').addEventListener('click', () => savePng('front'));
  $('#mcdnaPngBack').addEventListener('click', () => savePng('back'));
  // Agent 文案：复制程序生成的提示词 → 当前 Agent 写 JSON → 粘贴回来，经服务端守门后只重绘背面文字。
  $('#mcdnaCopy').addEventListener('click', async () => {
    const box = $('#mcdnaPrompt');
    try { await navigator.clipboard.writeText(box.value); $('#mcdnaCopy').textContent = '已复制'; }
    catch { box.focus(); box.select(); $('#mcdnaCopy').textContent = '已选中，请手动复制'; }
    setTimeout(() => { $('#mcdnaCopy').textContent = '复制提示词'; }, 1800);
  });
  $('#mcdnaSubmit').addEventListener('click', async () => {
    const errBox = $('#mcdnaAgentErr'); errBox.style.display = 'none';
    if (!report) return;
    let reply;
    try { reply = JSON.parse($('#mcdnaReply').value.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); }
    catch { errBox.textContent = '没有读到 JSON：请粘贴 Agent 返回的那一段 {…}'; errBox.style.display = 'block'; return; }
    const cardSeq = seq, mySubmit = ++submitSeq;
    submitTask?.ctrl?.abort();
    const ctrl = new AbortController(); submitTask = { id: mySubmit, ctrl };
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const draft = $('#mcdnaReply').value;
    setSubmitState(true, '正在守门…');
    try {
      const data = await post('/api/mcdna/render', { reportId: report.reportId, amountMode: report.amountMode, commentary: { snapshotId: report.snapshotId, ...reply } }, ctrl.signal);
      if (mySubmit !== submitSeq || cardSeq !== seq) return;
      const shown = await show(data, cardSeq);
      if (!shown || mySubmit !== submitSeq || cardSeq !== seq) return;
      // v1.4.11 W17：只清空「提交时那一份」草稿；提交期间用户新写的内容必须保留。
      if ($('#mcdnaReply').value === draft) $('#mcdnaReply').value = '';
    } catch (e) {
      if (mySubmit !== submitSeq || cardSeq !== seq) return;
      errBox.textContent = (e.name === 'AbortError' ? '提交已取消或超时：' : e instanceof TypeError ? '连接失败：' : '') + e.message + '。当前卡片保持不变。';
      errBox.style.display = 'block';
    } finally {
      clearTimeout(timer);
      // v1.4.11 W16：只有「最新一次提交」才有权复位按钮；旧 finally 不得提前解锁新提交。
      if (mySubmit === submitSeq) { submitTask = null; setSubmitState(false); }
    }
  });
  // v1.4.11 W22：支持从 CLI 成品继续——`#mcdna?report=<reportId>` 载入同一快照（不重读订单、默认脱敏）。
  async function loadReport(reportId) {
    reset(); const mine = seq;
    $('#mcdnaBox').style.display = 'block'; $('#mcdnaEmpty').style.display = 'none';
    $('#mcdnaErr').style.display = 'none'; $('#mcdnaErr').textContent = '';
    $('#goMcdna').disabled = true; $('#goMcdna').textContent = '正在载入同一快照…';
    try {
      const data = await post('/api/mcdna/render', { reportId, amountMode: 'tier' });
      if (mine !== seq) return;
      const shown = await show(data, mine);
      if (shown) { $('#mcdnaErr').textContent = '已载入同一快照（脱敏）。如需完整金额请显式切换后重新生成。'; $('#mcdnaErr').style.display = 'block'; }
    } catch (e) {
      if (mine !== seq) return;
      const message = e instanceof TypeError ? await networkReason() : '载入快照失败：' + e.message;
      if (mine !== seq) return;
      $('#mcdnaErr').textContent = /E_REPORT_EXPIRED|过期|不存在/.test(e.message || '') ? '该快照已过期或已被淘汰，请重新生成战报；不会偷偷重读订单。' : message;
      $('#mcdnaErr').style.display = 'block';
    } finally {
      if (mine === seq) { $('#goMcdna').disabled = false; $('#goMcdna').textContent = GEN_LABEL; }
    }
  }
  const initialReport = (() => {
    const m = /(?:[#?&])report=([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})/i.exec(location.hash + location.search);
    return m ? m[1] : '';
  })();
  // `#mcdna` / `#mcdna?report=…` 必须直接切到战报页（页面本身没有 hash 路由）。
  if (initialReport || /(?:^|[#?&])mcdna(?:$|[?&])/.test(location.hash + location.search)) {
    if (typeof window.switchMode === 'function') window.switchMode('mcdna');
  }
  if (initialReport) loadReport(initialReport);
  window.addEventListener('pagehide', reset);
})();
