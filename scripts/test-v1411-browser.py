#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v1.4.11 面板异步/隐私回归：真实页面与浏览器，模拟业务回执。
覆盖 W05（PNG 隐私竞态）、W15（迟到健康检查）、W16（挂起提交）、W17（迟到解码清草稿）、
W18（导出失败隔离）、W19（后端警告展示）、W22（reportId 载入）。"""
import json, os, subprocess, tempfile, time, shutil, sys
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parent.parent
HOME = tempfile.mkdtemp(prefix='mcsmart-v1411-browser-')
PORT = 19031
BASE = f'http://127.0.0.1:{PORT}'
checks = 0
errors = []


def check(v, n):
    global checks
    assert v, n
    checks += 1
    print('  ✓ ' + n)


server = subprocess.Popen(['node', str(ROOT / 'dist/server.js')], cwd=ROOT,
                          env={**os.environ, 'PORT': str(PORT), 'MCSMART_HOME': HOME, 'MCD_MCP_TOKEN': ''},
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

STUB = r"""
(() => {
  const native = window.fetch; window.mcPending = [];
  window.mcPayload = (body) => {
    const amount = body.amountMode === 'full' ? 'full' : 'tier';
    const fill = amount === 'full' ? '#ff0000' : '#00ff00';
    const svg = side => `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" data-side="${side}"><rect width="1080" height="1440" fill="${fill}"/><text x="40" y="100">${side}-${amount}</text></svg>`;
    return { reportId: body.reportId || 'r1', snapshotId: 's1', amountMode: amount, stats: { demo: true },
      persona: { sectName: '单推派', role: '深夜加更', sceneName: '点餐柜台' }, copy: {},
      frontSvg: svg('front'), backSvg: svg('back'), commentaryStatus: body.commentary ? 'agent' : 'rules',
      commentaryRequest: { snapshotId: 's1', prompt: 'PROMPT-' + amount },
      warnings: ['以下字符像素字库未收录，以方框显示：𠮷', '食品明细不完整，背包与图鉴只含已取得部分'] };
  };
  window.mcRelease = (i, mode = 'ok') => {
    const q = window.mcPending[i];
    if (mode === 'network') { q.reject(new TypeError('Failed to fetch')); return; }
    if (mode === 'expired') { q.resolve(new Response(JSON.stringify({ code: 'E_REPORT_EXPIRED', message: '战报快照已超过1小时，请重新生成' }), { status: 400, headers: { 'Content-Type': 'application/json' } })); return; }
    q.resolve(new Response(JSON.stringify(window.mcPayload(q.body)), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
  window.fetch = (url, options) => {
    const u = String(url);
    if (u === '/api/mcdna' || u === '/api/mcdna/render') {
      return new Promise((resolve, reject) => window.mcPending.push({ url: u, body: JSON.parse(options.body), resolve, reject }));
    }
    if (u === '/api/health') return new Promise(r => setTimeout(() => r(new Response('{}', { status: 200 })), 500));
    return native(url, options);
  };
  window.__decodeDelay = 0;
  window.__decodeOnce = 0;
  const nativeDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function () {
    const d = window.__decodeOnce || window.__decodeDelay;
    if (window.__decodeOnce) window.__decodeOnce = 0;
    return d ? new Promise((res, rej) => setTimeout(() => nativeDecode.call(this).then(res, rej), d)) : nativeDecode.call(this);
  };
  window.__blobMode = 'ok';
  const nativeBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
    const mode = window.__blobMode;
    setTimeout(() => {
      if (mode === 'null') { cb(null); return; }
      if (mode === 'slow') { nativeBlob.call(this, cb, ...rest); return; }
      nativeBlob.call(this, cb, ...rest);
    }, mode === 'slow' ? 400 : 0);
  };
})();
"""

try:
    for _ in range(80):
        try:
            with urlopen(BASE + '/api/health', timeout=.5):
                break
        except Exception:
            time.sleep(.1)
    else:
        raise AssertionError('面板服务未就绪')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1180, 'height': 960}, accept_downloads=True)
        page.on('pageerror', lambda e: errors.append(str(e)))

        def route_api(route):
            path = route.request.url.split('?')[0]
            if path.endswith('/api/setup/status'):
                route.fulfill(json={'tokenConfigured': True, 'tokenSource': 'env', 'tokenMasked': 'stub-****'})
            elif path.endswith('/api/cities'):
                route.fulfill(json={'cities': ['上海']})
            elif path.endswith('/api/stores'):
                route.fulfill(json={'stores': []})
            elif path.endswith('/api/health'):
                route.continue_()
            else:
                route.fulfill(json={'ok': True})
        page.route('**/api/**', route_api)
        page.add_init_script(STUB)
        page.goto(BASE, wait_until='networkidle')
        page.click('.tab[data-mode=mcdna]')

        def gen(amount='tier'):
            i = page.evaluate('mcPending.length')
            page.click(f'label[for={"mc-full" if amount == "full" else "mc-tier"}]')
            page.click('#goMcdna')
            page.wait_for_function(f'mcPending.length==={i + 1}')
            page.evaluate(f'mcRelease({i})')
            page.wait_for_selector('#mcdnaImg', state='visible')
            return i

        # W19：后端 warnings 必须显示（缺字/明细不全）
        gen()
        check(page.is_visible('#mcdnaWarn'), 'W19 警告容器可见')
        warn = page.inner_text('#mcdnaWarn')
        check('字库未收录' in warn and '明细不完整' in warn, 'W19 缺字与明细不全提示均展示')

        # W05：完整金额导出 PNG 期间切脱敏 → 旧导出不得下载
        gen('full')
        page.evaluate('__blobMode="slow"')
        downloads = []
        page.on('download', lambda d: downloads.append(d))
        page.click('#mcdnaPngFront')
        page.click('label[for=mc-tier]')
        page.wait_for_timeout(1000)
        check(len(downloads) == 0, 'W05 切换隐私后旧 PNG 导出不下载')
        check(not page.is_visible('#mcdnaImg'), 'W05 切换后旧卡片已收起')
        page.evaluate('__blobMode="ok"')

        # W18：PNG 编码失败只影响导出，保留双面与 SVG 下载
        gen('tier')
        page.evaluate('__blobMode="null"')
        page.click('#mcdnaPngFront')
        page.wait_for_selector('#mcdnaExportErr', state='visible')
        check(page.is_visible('#mcdnaImg') and page.is_visible('#mcdnaImgBack'), 'W18 导出失败保留双面预览')
        check(page.is_visible('#mcdnaDl') and page.is_visible('#mcdnaDlBack'), 'W18 导出失败保留 SVG 下载')
        page.evaluate('__blobMode="ok"')

        # W15：A 网络失败后等待健康检查，期间 B 成功；A 的迟到检查不得清掉 B
        i = page.evaluate('mcPending.length')
        page.click('#goMcdna')
        page.wait_for_function(f'mcPending.length==={i + 1}')
        page.evaluate(f'mcRelease({i},"network")')
        page.wait_for_timeout(120)
        page.click('label[for=mc-full]')
        page.click('#goMcdna')
        page.wait_for_function(f'mcPending.length==={i + 2}')
        page.evaluate(f'mcRelease({i + 1})')
        page.wait_for_selector('#mcdnaImg', state='visible')
        ok_url = page.get_attribute('#mcdnaImg', 'src')
        page.wait_for_timeout(700)
        check(page.get_attribute('#mcdnaImg', 'src') == ok_url and not page.is_visible('#mcdnaErr'),
              'W15 迟到的健康检查不清掉新成功卡')

        # W16：挂起的 Agent 提交在换设置后必须复位，且不阻塞新卡提交
        page.click('#mcdnaAgent summary')
        page.fill('#mcdnaReply', '{"title":"{qualifier}钉子户","verdict":"菜单翻遍还是{qualifier}"}')
        i = page.evaluate('mcPending.length')
        page.click('#mcdnaSubmit')
        page.wait_for_function(f'mcPending.length==={i + 1}')
        check(page.is_disabled('#mcdnaSubmit'), 'W16 提交期间按钮锁定')
        page.click('label[for=mc-tier]')
        check(not page.is_disabled('#mcdnaSubmit'), 'W16 换设置后旧提交锁被解除')
        page.click('#goMcdna')
        page.wait_for_function(f'mcPending.length==={i + 2}')
        page.evaluate(f'mcRelease({i + 1})')
        page.wait_for_selector('#mcdnaImg', state='visible')
        check(not page.is_disabled('#mcdnaSubmit'), 'W16 新卡提交按钮可用')
        page.fill('#mcdnaReply', '{"title":"{qualifier}钉子户","verdict":"菜单翻遍还是{qualifier}"}')
        page.click('#mcdnaSubmit')
        page.wait_for_function(f'mcPending.length==={i + 3}')
        page.evaluate(f'mcRelease({i + 2})')
        page.wait_for_function('document.querySelector("#mcdnaBox").dataset.textSource==="agent"')
        check(True, 'W16 旧提交挂起不影响新卡提交与重绘')

        # W17：旧回执迟到解码期间切卡并输入新草稿 → 草稿必须保留
        page.evaluate('__decodeOnce=800')
        page.fill('#mcdnaReply', '{"title":"{qualifier}钉子户","verdict":"菜单翻遍还是{qualifier}"}')
        i = page.evaluate('mcPending.length')
        page.click('#mcdnaSubmit')
        page.wait_for_function(f'mcPending.length==={i + 1}')
        page.evaluate(f'mcRelease({i})')
        page.wait_for_timeout(100)
        page.click('label[for=mc-full]')
        page.click('#goMcdna')
        page.wait_for_function(f'mcPending.length==={i + 2}')
        page.evaluate(f'mcRelease({i + 1})')
        page.wait_for_selector('#mcdnaImg', state='visible')
        page.fill('#mcdnaReply', '这是新草稿')
        page.wait_for_timeout(1200)
        check(page.input_value('#mcdnaReply') == '这是新草稿', 'W17 迟到解码不清空新草稿')
        page.evaluate('__decodeDelay=0')

        # W22：reportId 载入同一快照（默认脱敏、不重读订单）
        rid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
        p2 = browser.new_page(viewport={'width': 1180, 'height': 960})
        seen = {}

        def route2(route):
            u = route.request.url
            if '/api/mcdna/render' in u:
                seen['body'] = json.loads(route.request.post_data)
                if seen.get('expired'):
                    route.fulfill(status=400, json={'code': 'E_REPORT_EXPIRED', 'message': '战报快照已超过1小时，请重新生成'})
                    return
                body = dict(seen['body'])
                amount = body.get('amountMode', 'tier')
                svg = lambda side: f'<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440"><rect width="1080" height="1440" fill="#00ff00"/><text x="40" y="100">{side}</text></svg>'
                route.fulfill(json={'reportId': rid, 'snapshotId': 's9', 'amountMode': amount, 'stats': {'demo': True},
                                    'persona': {'sectName': '单推派', 'role': '常客', 'sceneName': '点餐柜台'}, 'copy': {},
                                    'frontSvg': svg('front'), 'backSvg': svg('back'), 'commentaryStatus': 'rules',
                                    'commentaryRequest': {'snapshotId': 's9', 'prompt': 'P'}, 'warnings': []})
            elif '/api/setup/status' in u:
                route.fulfill(json={'tokenConfigured': True, 'tokenSource': 'env', 'tokenMasked': 'stub-****'})
            elif '/api/cities' in u:
                route.fulfill(json={'cities': ['上海']})
            elif '/api/stores' in u:
                route.fulfill(json={'stores': []})
            else:
                route.fulfill(json={'ok': True})
        p2.route('**/api/**', route2)
        p2.goto(BASE + '/#mcdna?report=' + rid, wait_until='networkidle')
        p2.wait_for_selector('#mcdnaImg', state='visible')
        check(p2.is_visible('#mode-mcdna'), 'W22 深链接自动切到战报页')
        check(seen['body']['reportId'] == rid and seen['body']['amountMode'] == 'tier', 'W22 按 reportId 载入且默认脱敏')
        check(p2.get_attribute('#mcdnaBox', 'data-amount-mode') == 'tier', 'W22 载入产物为脱敏模式')

        seen['expired'] = True
        p3 = browser.new_page()
        p3.route('**/api/**', route2)
        p3.goto(BASE + '/#mcdna?report=' + rid, wait_until='networkidle')
        p3.wait_for_selector('#mcdnaErr', state='visible')
        check('过期' in p3.inner_text('#mcdnaErr') and '淘汰' in p3.inner_text('#mcdnaErr'), 'W22 过期快照明确提示')

        check(not errors, f'pageerror=0（{errors}）')
        browser.close()
    print(f'v1.4.11 面板异步/隐私回归：{checks}项通过')
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
    shutil.rmtree(HOME, ignore_errors=True)
