#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""静态演示冒烟：不启动后端，只服务 docs/ 下的静态文件。
验证：套餐分组、预设条件与回执一致、取消/重试/跨页隔离、多人分账、
McDNA 演示边界与四档宽度。自动启动临时静态文件服务，不需要后端。
运行：python scripts/test-static-demo.py
"""
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parent.parent
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT / 'docs')))
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{server.server_port}/demo/'
errors = []
requests = []
checks = 0


def check(v, label):
    global checks
    assert v, label
    checks += 1
    print('  ✓ ' + label)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1180, 'height': 820})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: requests.append(r.url))
    page.goto(BASE, wait_until='networkidle', timeout=30000)
    page.wait_for_selector('#citySel option', state='attached', timeout=10000)
    page.wait_for_selector('#storeList .sbar-item', state='attached', timeout=10000)
    check(page.locator('#go').is_enabled(), '门店自动选中后单人按钮可用')

    check(page.input_value('#kcal') == '700' and page.input_value('#yuan') == '32', '启动时输入与默认回执场景一致')
    check(page.locator('#kcal').get_attribute('readonly') is not None, '热量输入明确锁定')
    check(page.locator('#st-2').is_disabled(), '主食份数通过场景切换，不接受虚假自定义')
    page.click('#go')
    page.wait_for_selector('#results .sol', timeout=15000)
    check(page.locator('#results .sol').count() == 2, '两个板烧选配合为一张，共两组推荐')
    single_text = page.locator('#results').inner_text()
    check('板烧鸡腿堡' in single_text or '套餐' in single_text, '单人结果包含实际食品组合')
    check(page.locator('#results .demo-data-flag').count() >= 1, '单人结果有演示数据标记')
    choices = page.locator('#results .configuration-variants').first
    choices.locator('summary').click()
    check('零度可乐' in choices.inner_text() and '雪碧' in choices.inner_text(), '折叠区保留两种实际饮料选配')
    check('691 kcal' in choices.inner_text() and '796 kcal' in choices.inner_text(), '每个选配单独显示热量')
    check('不叠加购买' in choices.inner_text(), '说明两个配置是择一购买')

    # 反复提交不能追加旧卡片或复制表单。
    for _ in range(3):
        page.click('#go')
        page.wait_for_selector('#results .sol')
        check(page.locator('#results .sol').count() == 2, '重复提交替换旧结果')
    check(page.locator('#kcal').count() == 1 and page.locator('#targetTime').count() == 1, '反复提交后表单字段仍各一份')

    page.select_option('#demoScenario', 'two-staples')
    check(page.input_value('#kcal') == '1000' and page.input_value('#yuan') == '50', '双主食示例同步热量与预算')
    check(page.locator('#st-2').is_checked(), '双主食示例同步主食下限')
    check(page.locator('#results .sol').count() == 0, '切换场景立即清掉旧结果')
    page.click('#go')
    page.wait_for_selector('#results .sol')
    staples = page.locator('#results .macros .m').all_text_contents()
    staple_values = [int(s.split()[-1]) for s in staples if '主食份' in s]
    check(bool(staple_values) and all(v >= 2 for v in staple_values), '双主食场景所有展示方案都满足至少两份')

    page.select_option('#demoScenario', 'low-budget')
    page.click('#go')
    page.wait_for_selector('#results .warn')
    check('无可行方案' in page.locator('#results').inner_text(), '预算不足如实显示无解')
    check(page.locator('#results .sol').count() == 0, '无解不留下旧推荐或零元推荐')

    page.select_option('#demoScenario', 'lunch')
    page.click('#go')
    page.wait_for_selector('#results .p-cancel')
    check(page.locator('#demoScenario').is_disabled(), '求解期间禁止切场景避免结果错配')
    page.locator('#results .p-cancel').click()
    page.wait_for_function("document.querySelector('#results').textContent.includes('已取消')")
    check(page.locator('#results .sol').count() == 0, '取消后没有迟到推荐')
    page.wait_for_function("!document.querySelector('#demoScenario').disabled")
    page.click('#go')
    page.wait_for_selector('#results .sol')
    check(page.locator('#results .sol').count() == 2, '取消后可重试')

    page.click('.tab[data-mode="group"]')
    page.click('#demoFillBtn')
    page.click('#parseBtn')
    page.wait_for_selector('#memberList .mrow', timeout=10000)
    check(page.locator('#memberList .mrow').count() == 3, '多人示例解析为 3 位成员')
    aliases = page.locator('#memberList .m-alias').evaluate_all('(els) => els.map(e => e.value)')
    check(aliases == ['小林', '小周', '小陈'], '成员确认卡回填三位成员')
    check(page.locator('#memberList .m-alias').first.get_attribute('readonly') is not None, '多人示例成员锁定')
    page.click('#goGroup')
    page.wait_for_selector('#groupResults .sol', timeout=15000)
    group_text = page.locator('#groupResults').inner_text()
    check('¥' in group_text, '多人结果展示金额')
    bill = page.locator('#groupResults .viewtoggle[data-view-btn="bill"]').first
    check(bill.count() == 1, '多人卡有分账切换按钮')
    bill.click()
    group_text = page.locator('#groupResults').inner_text()
    check('小林' in group_text and '小周' in group_text, '分账视图按成员显示')
    check('分账' in group_text, '分账视图可切换')
    check(page.locator('#groupResults .demo-data-flag').count() >= 1, '多人结果有演示数据标记')

    # 单人/多人并发：取消单人任务不影响已启动的多人任务。
    page.click('.tab[data-mode="solve"]')
    page.click('#go')
    page.click('.tab[data-mode="group"]')
    page.click('#goGroup')
    page.click('.tab[data-mode="solve"]')
    page.locator('#results .p-cancel').click()
    page.wait_for_function("document.querySelector('#results').textContent.includes('已取消')")
    page.wait_for_selector('#groupResults .sol', state='attached')
    check(page.locator('#groupResults .sol').count() > 0, '跨页取消只终止本卡，多人仍完成')

    page.click('.tab[data-mode="mcdna"]')
    check(page.locator('#mc-real').is_disabled() and page.locator('#mc-full').is_disabled(), '战报锁定演示样本与脱敏档位')
    page.click('#goMcdna')
    page.wait_for_selector('#mcdnaImg[src]', timeout=15000)
    check(page.locator('#mcdnaImg').is_visible(), 'McDNA 演示卡可生成并显示')
    check(page.locator('#mcdnaImgBack').is_visible(), 'McDNA 双面都可显示')
    check(not page.locator('#mcdnaAgent').is_visible(), '静态报告不展示假改稿入口')

    page.click('.tab[data-mode="solve"]')
    for width in [1280, 820, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 820})
        check(page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{width}px 无横向溢出')
        check(page.locator('#kcal').count() == 1 and page.locator('#targetTime').count() == 1, f'{width}px 表单没有重复节点')
    check(not any('/api/' in u for u in requests), '所有 API 都在静态适配层内处理，未穿透网络')

    if errors:
        print('页面异常：')
        for e in errors:
            print('  - ' + e)
    check(not errors, '全程无页面异常')
    browser.close()
server.shutdown()

print(f'静态演示冒烟：{checks} 项通过')
