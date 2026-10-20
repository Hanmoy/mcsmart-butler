#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""静态演示冒烟：不启动后端，只服务 docs/ 下的静态文件。
验证：无页面异常、门店自动选中、单人结果、多人示例解析、多人结果与分账、
McDNA 内置演示回执。运行：python scripts/test-static-demo.py
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
BASE = 'http://127.0.0.1:19100/demo/'
errors = []
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
    page.goto(BASE, wait_until='networkidle', timeout=30000)
    page.wait_for_selector('#citySel option', state='attached', timeout=10000)
    page.wait_for_selector('#storeList .sbar-item', state='attached', timeout=10000)
    check(page.locator('#go').is_enabled(), '门店自动选中后单人按钮可用')

    page.fill('#kcal', '650')
    page.fill('#yuan', '32')
    page.click('#go')
    page.wait_for_selector('#results .sol', timeout=15000)
    check(page.locator('#results .sol').count() >= 1, '单人精算渲染出方案卡')
    single_text = page.locator('#results').inner_text()
    check('板烧鸡腿堡' in single_text or '套餐' in single_text, '单人结果包含实际食品组合')
    check(page.locator('#results .demo-data-flag').count() >= 1, '单人结果有演示数据标记')

    page.click('.tab[data-mode="group"]')
    page.click('#demoFillBtn')
    page.click('#parseBtn')
    page.wait_for_selector('#memberList .mrow', timeout=10000)
    check(page.locator('#memberList .mrow').count() == 3, '多人示例解析为 3 位成员')
    aliases = page.locator('#memberList .m-alias').evaluate_all('(els) => els.map(e => e.value)')
    check(aliases == ['小林', '小周', '小陈'], '成员确认卡回填三位成员')
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

    page.click('.tab[data-mode="mcdna"]')
    page.click('#goMcdna')
    page.wait_for_selector('#mcdnaImg[src]', timeout=15000)
    check(page.locator('#mcdnaImg').is_visible(), 'McDNA 演示卡可生成并显示')
    check(page.locator('#mcdnaImgBack').is_visible(), 'McDNA 双面都可显示')

    if errors:
        print('页面异常：')
        for e in errors:
            print('  - ' + e)
    check(not errors, '全程无页面异常')
    browser.close()

print(f'静态演示冒烟：{checks} 项通过')
