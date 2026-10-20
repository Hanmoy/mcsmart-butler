#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""McDNA 页面可靠性回归：真实页面/浏览器、模拟业务回执；视觉定稿前也可复用。"""
import json, os, struct, subprocess, tempfile, time, shutil, sys
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parent.parent
HOME=tempfile.mkdtemp(prefix='mcsmart-mcdna-browser-')
PORT=19027
BASE=f'http://127.0.0.1:{PORT}'
checks=0
errors=[]
def check(v,n):
    global checks
    assert v,n
    checks+=1
    print('  ✓ '+n)
server=subprocess.Popen(['node',str(ROOT/'dist/server.js')],cwd=ROOT,env={**os.environ,'PORT':str(PORT),'MCSMART_HOME':HOME,'MCD_MCP_TOKEN':''},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
    for i in range(80):
        try:
            with urlopen(BASE+'/api/health',timeout=.5) as r: break
        except Exception: time.sleep(.1)
    else: raise AssertionError('面板服务未就绪，测试不能冒充通过')
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':1180,'height':960},accept_downloads=True)
        page.on('pageerror',lambda e:errors.append(str(e)))
        def route_api(route):
            path=route.request.url.split('?')[0]
            if path.endswith('/api/setup/status'): route.fulfill(json={'tokenConfigured':True,'tokenSource':'env','tokenMasked':'stub-****'})
            elif path.endswith('/api/cities'):route.fulfill(json={'cities':['上海']})
            elif path.endswith('/api/stores'):route.fulfill(json={'stores':[]})
            elif path.endswith('/api/health'):route.continue_()
            else:route.fulfill(json={'ok':True})
        page.route('**/api/**',route_api)
        page.goto(BASE,wait_until='networkidle')
        page.click('.tab[data-mode=mcdna]')
        # fetch桩刻意忽略AbortSignal，模拟取消以后仍到达的旧回执。
        page.evaluate("""() => {
          const native=window.fetch; window.mcPending=[];
          window.fetch=(url,options)=>{const u=String(url);return u==='/api/mcdna'||u==='/api/mcdna/render'?new Promise((resolve,reject)=>window.mcPending.push({url:u,body:JSON.parse(options.body),resolve,reject})):native(url,options);};
          window.mcRelease=(i,mode='ok')=>{const q=window.mcPending[i];if(mode==='network'){q.reject(new TypeError('Failed to fetch'));return;}
            const bad=(status,body)=>q.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
            if(mode==='json'){bad(400,{error:'尚未配置账户',code:'E_TOKEN_MISSING'});return;}
            if(mode==='reject'){bad(400,{message:'Agent 文案未通过守门：称号自写了数字',code:'E_INPUT_INVALID'});return;}
            const amount=q.body.amountMode==='full'?'full':'tier',value=amount==='full'?'¥428.60':'¥¥¥¥¥',agent=!!q.body.commentary;
            const svg=side=>mode==='invalid'&&side==='back'?'<svg broken':`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 540 720" data-side="${side}"><rect width="540" height="720" fill="${agent?'#e6b23a':'#fff6da'}"/><text x="40" y="100">${value} ${side}${agent?' agent':''}</text></svg>`;
            q.resolve(new Response(JSON.stringify({reportId:'r1',snapshotId:'s1',amountMode:amount,stats:{demo:true},persona:{sectName:'单推派',role:'深夜加更',sceneName:'点餐柜台'},copy:{},
              frontSvg:svg('front'),backSvg:svg('back'),commentaryStatus:agent?'agent':'rules',commentaryRequest:{snapshotId:'s1',prompt:'PROMPT-'+amount}}),{headers:{'Content-Type':'application/json'}}));
          };
        }""")
        # 完整 -> 脱敏；两份请求逆序返回，首个回执必须被淘汰。
        page.click('label[for=mc-full]');page.click('#goMcdna')
        page.wait_for_function('mcPending.length===1')
        check(page.is_disabled('#goMcdna'),'请求期间有生成态，重复点击不会追加业务请求')
        page.click('label[for=mc-tier]')
        check(not page.is_visible('#mcdnaImg') and not page.is_visible('#mcdnaDl'),'切换脱敏立即收起旧图与下载')
        page.click('#goMcdna');page.wait_for_function('mcPending.length===2')
        check(page.evaluate('mcPending[1].body.amountMode')=='tier' and page.evaluate('mcPending[1].body.demo')==True,'请求体携带当前来源与金额模式')
        page.evaluate('mcRelease(1)');page.wait_for_selector('#mcdnaImg',state='visible')
        tier_url=page.get_attribute('#mcdnaImg','src')
        check(page.is_visible('#mcdnaImgBack') and page.get_attribute('#mcdnaImgBack','src')!=tier_url,'正反面同时预览')
        page.evaluate('mcRelease(0)');page.wait_for_timeout(150)
        check(page.get_attribute('#mcdnaImg','src')==tier_url,'旧完整金额回执不能覆盖新脱敏预览')
        check(page.get_attribute('#mcdnaBox','data-amount-mode')=='tier','产物金额模式与当前选项一致')
        check(page.get_attribute('#mcdnaDl','href')==tier_url,'下载与预览使用同一Blob')
        with page.expect_download() as dl:page.click('#mcdnaDl')
        data=Path(dl.value.path()).read_text('utf-8')
        check('428.60' not in data and '¥¥¥¥¥' in data,'实际下载为脱敏首响，未重新请求业务API')
        with page.expect_download() as dl:page.click('#mcdnaPngBack')
        png=Path(dl.value.path()).read_bytes()
        check(png[:8]==b'\x89PNG\r\n\x1a\n' and struct.unpack('>II',png[16:24])==(1080,1440) and dl.value.suggested_filename.endswith('-tier-back.png'),'背面导出 1080×1440 PNG')
        check(page.evaluate('mcPending.length')==2,'下载不新增业务生成')
        # Agent 文案：复制提示词 → 粘贴 JSON → 守门拒绝保持原卡 → 接受后重绘。
        page.click('#mcdnaAgent summary')
        check(page.input_value('#mcdnaPrompt')=='PROMPT-tier','提示词来自当前快照')
        page.fill('#mcdnaReply','这不是JSON');page.click('#mcdnaSubmit')
        check(page.is_visible('#mcdnaAgentErr') and page.evaluate('mcPending.length')==2,'非 JSON 回复本地拦截，不发请求')
        page.fill('#mcdnaReply','```json\n{"title":"{qualifier}钉子户","verdict":"菜单翻遍还是{qualifier}"}\n```');page.click('#mcdnaSubmit')
        page.wait_for_function('mcPending.length===3')
        body=page.evaluate('mcPending[2].body')
        check(page.evaluate('mcPending[2].url')=='/api/mcdna/render' and body['reportId']=='r1' and body['amountMode']=='tier' and body['commentary']['snapshotId']=='s1' and body['commentary']['title']=='{qualifier}钉子户','提交绑定当前 reportId/snapshotId/金额模式，去掉 Markdown 围栏')
        page.evaluate('mcRelease(2,"reject")');page.wait_for_selector('#mcdnaAgentErr',state='visible')
        check('守门' in page.inner_text('#mcdnaAgentErr') and page.get_attribute('#mcdnaImg','src')==tier_url and not page.is_visible('#mcdnaErr'),'守门拒绝只提示、不撤下当前卡片')
        page.click('#mcdnaSubmit');page.wait_for_function('mcPending.length===4');page.evaluate('mcRelease(3)')
        page.wait_for_function(f'document.querySelector("#mcdnaImg").src!=="{tier_url}"')
        check(page.get_attribute('#mcdnaBox','data-text-source')=='agent' and not page.is_visible('#mcdnaAgentErr') and page.input_value('#mcdnaReply')=='','接受后重绘并标记 Agent 文案')
        # 当前首响失败、非法SVG、连接失败均不留破图；再点击可以恢复。
        for mode in ['json','invalid','network']:
            i=page.evaluate('mcPending.length');page.click('#goMcdna');page.wait_for_function(f'mcPending.length==={i+1}')
            page.evaluate(f'mcRelease({i},"{mode}")');page.wait_for_selector('#mcdnaErr',state='visible')
            check(not page.is_visible('#mcdnaImg') and not page.is_visible('#mcdnaImgBack') and not page.is_visible('#mcdnaDl') and not page.is_visible('#mcdnaTools'),mode+'失败无破图、无下载')
            check(page.locator('#mcdnaImg').count()==1 and page.locator('#mcdnaDl').count()==1,mode+'失败保留DOM可重试')
            page.wait_for_function('!document.querySelector("#goMcdna").disabled')
        # 成功以后的迟到失败不能污染当前成功。
        i=page.evaluate('mcPending.length');page.click('#goMcdna');page.wait_for_function(f'mcPending.length==={i+1}')
        page.click('label[for=mc-full]');page.click('#goMcdna');page.wait_for_function(f'mcPending.length==={i+2}')
        page.evaluate(f'mcRelease({i+1})');page.wait_for_selector('#mcdnaImg',state='visible')
        full_url=page.get_attribute('#mcdnaImg','src');page.evaluate(f'mcRelease({i},"network")');page.wait_for_timeout(150)
        check(page.get_attribute('#mcdnaImg','src')==full_url and not page.is_visible('#mcdnaErr'),'迟到失败不能覆盖当前成功')
        # 手机宽度与设置切换。
        page.set_viewport_size({'width':390,'height':844});page.click('label[for=mc-tier]')
        check(not page.is_visible('#mcdnaImg'),'手机切换脱敏收起完整金额')
        check(page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),'390px无横向溢出')
        i=page.evaluate('mcPending.length');page.click('#goMcdna');page.wait_for_function(f'mcPending.length==={i+1}');page.evaluate(f'mcRelease({i})')
        page.wait_for_selector('#mcdnaImg',state='visible')
        check(not errors,'pageerror=0')
        browser.close()
    print(f'McDNA浏览器可靠性：{checks}项通过（模拟回执，真实页面）')
finally:
    server.terminate()
    try:server.wait(timeout=5)
    except subprocess.TimeoutExpired:server.kill();server.wait()
    shutil.rmtree(HOME,ignore_errors=True)
