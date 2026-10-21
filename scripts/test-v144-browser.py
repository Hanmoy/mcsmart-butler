#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""浏览器行为回归（v1.4.4 R14 / R19；v1.4.7 R17；v1.4.8 R01；v1.4.9 N01）

真实浏览器（Playwright）加载面板真实 HTML/JS，仅拦截 /api/** 做确定性桩：
  R14 单人页取消按钮必须取消「该卡片自己的」jobId——单人任务 + 多人任务并存时，
      在单人页点取消，实际请求必须是 /api/jobs/<单人 jobId>/cancel，绝不串到多人任务。
  R19 战报首次失败后必须能重试：失败只写独立错误元素，不破坏 #mcdnaBox 结构；
      恢复条件后再次点击即成功，且全程无未捕获的页面异常（旧实现会因 img 被移除而报错）。
  R17 分账/出餐指引在方案卡内切换，估算热量不写成精确总量。
  R01 每张卡只保留一个活动视图：重复点击同一详情回购买清单（不得三区全隐藏成空卡），
      分账↔出餐交叉切换后按钮文案、选中态与可见区一致，多卡互不影响。
  N01 用餐时间（预约口径）随请求透传且留空不塞空串；结果页如实回显口径；
      分时段目录面板按锚点呈现（失败锚点如实标注）；高级诊断含逐商品遗漏账。

运行：python scripts/test-v144-browser.py（需已 tsc；依赖 Playwright + chromium）
"""
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOME = tempfile.mkdtemp(prefix="mcsmart-v144-browser-")
PORT = 18982
BASE = f"http://127.0.0.1:{PORT}"

failures = []
page_errors = []
cancel_urls = []
mcdna_mode = {"fail": True}
deals_posts = []
recipe_preview_posts = []
recipe_import_posts = []
solve_posts = []
solve_job_posts = []
group_job_posts = []
group_job_counter = 0
period_catalog_posts = []


def check(cond, label):
    if cond:
        print(f"  \u2713 {label}")
    else:
        print(f"  \u2717 {label}")
        failures.append(label)


server = subprocess.Popen(
    ["node", str(ROOT / "dist" / "server.js")],
    cwd=str(ROOT),
    env={**os.environ, "MCSMART_HOME": HOME, "PORT": str(PORT), "MCD_MCP_TOKEN": "stub-token-1234567890"},
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)


def wait_up():
    import urllib.request
    for _ in range(80):
        try:
            with urllib.request.urlopen(f"{BASE}/api/health", timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.15)
    return False


def handler(route, request):
    url = request.url
    path = url.split("?")[0]
    method = request.method
    if "/cancel" in path and method == "POST":
        cancel_urls.append(path)
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True}))
        return
    if path.endswith("/api/cities"):
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"cities": ["上海", "北京"]}))
        return
    if path.endswith("/api/stores"):
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"stores": [
            {"storeCode": "S1", "storeName": "测试门店", "address": "测试路 1 号", "distance": 120, "open": True},
        ]}))
        return
    if path.endswith("/api/menu/period-catalog") and method == "POST":
        period_catalog_posts.append(request.post_data_json)
        route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "storeCode": "S1", "storeName": "测试门店",
            "catalog": {
                "storeCode": "S1", "date": "2026-10-19", "fetchedAt": "2026-10-17 18:00",
                "queries": [
                    {"anchor": "08:00", "period": "breakfast", "ok": True, "itemCount": 60},
                    {"anchor": "12:00", "period": "regular", "ok": True, "itemCount": 101},
                    {"anchor": "18:00", "period": "regular", "ok": False, "itemCount": 0, "error": "官方查询失败"},
                ],
                "items": [],
                "counts": {"breakfast": 60, "regular": 101},
                "unionCount": 161,
                "note": "只读：不查询/不校验团购适用门店，不发起下单。",
            },
            "pools": [
                {"period": "breakfast", "count": 60, "excluded": 101, "failedQueries": 0, "note": "按 08:00 官方返回"},
                {"period": "regular", "count": 101, "excluded": 60, "failedQueries": 0, "note": "按 12:00 官方返回"},
            ],
            "targetPeriod": "breakfast",
            "ledger": [
                {"code": "9900003457", "name": "早餐套餐", "sellable": True, "structure": "ok", "priceCents": 1200, "reason": ""},
                {"code": "9900009999", "name": "常规套餐", "sellable": False, "structure": "unknown", "reason": "off-period"},
            ],
            "orderContext": {"mode": "scheduled", "targetTime": "2026-10-19 08:00",
                             "reservationDate": "2026-10-19 08:00", "period": "breakfast",
                             "periodLabel": "早餐", "note": "已按该时刻查询"},
        }))
        return
    if path.endswith("/api/jobs/solve") and method == "POST":
        solve_job_posts.append(request.post_data_json)
        route.fulfill(status=202, content_type="application/json", body=json.dumps({"jobId": "single-1"}))
        return
    if path.endswith("/api/jobs/group-solve") and method == "POST":
        global group_job_counter
        group_job_posts.append(request.post_data_json)
        group_job_counter += 1
        jid = "group-1" if group_job_counter == 1 else "group-display"
        route.fulfill(status=202, content_type="application/json", body=json.dumps({"jobId": jid}))
        return
    if "/api/jobs/" in path and method == "GET":
        jid = path.rstrip("/").split("/")[-1]
        if jid == "group-display":
            # 两张方案卡：卡1 带估算营养 + 订单备注（覆盖 R17 热量口径与 R01 出餐指引），
            # 卡2 用于验证「多卡互不影响」——切换卡1 的视图不得改变卡2。
            sol_display = {
                "store": {"storeCode": "S1", "storeName": "测试门店"}, "track": "a-la-carte",
                "members": [{"alias": "营养测试", "note": "不要酸黄瓜", "items": [{"code": "item-1", "name": "估算套餐", "qty": 1, "priceCents": 1200,
                    "nutritionMatched": True, "nutritionEstimated": True, "nutritionUnknownFields": ["sodium"], "nutritionSource": "测试审核营养源"}],
                    "originalCents": 1200, "shareCents": 1200, "payableCents": 1200, "savedCents": 0, "kcal": 430,
                    "nutritionEstimated": True, "nutritionUnknownFields": ["sodium"], "nutritionSources": ["测试审核营养源"],
                    "unresolvedWishes": [], "tabooFiltered": []}],
                "orderNotes": ["少冰：可乐去冰"], "totals": {"originalCents": 1200, "paidCents": 1200, "discountCents": 0,
                    "priceSource": "calculate-price", "priceNote": "测试计价"}, "deliveryFeeCents": 0, "warnings": [], "disclaimer": "测试",
                "coverage": {"total": 1, "met": 1}, "solveState": "proven-optimal", "kernel": "milp-v6",
                "basket": [{"kind": "single", "code": "item-1", "name": "估算套餐", "qty": 1, "refPriceCents": 1200,
                    "perUnitConfig": ["估算套餐"], "nutritionEstimated": True, "nutritionUnknownFields": ["sodium"],
                    "nutritionSources": ["测试审核营养源"], "channelLabel": "官方 App"}], "gapTotal": 0, "alternatives": []
            }
            sol_alt = copy.deepcopy(sol_display)
            sol_alt["members"][0].update({"alias": "乙", "note": "", "kcal": 300, "nutritionEstimated": False,
                                          "nutritionUnknownFields": [], "nutritionSources": [], "payableCents": 900,
                                          "shareCents": 900, "originalCents": 900})
            sol_alt["members"][0]["items"][0].update({"code": "item-2", "name": "第二方案单品", "priceCents": 900,
                                                      "nutritionEstimated": False, "nutritionUnknownFields": [],
                                                      "nutritionSource": ""})
            sol_alt["orderNotes"] = []
            sol_alt["totals"] = {"originalCents": 900, "paidCents": 900, "discountCents": 0,
                                 "priceSource": "calculate-price", "priceNote": "测试计价"}
            sol_alt["basket"][0].update({"code": "item-2", "name": "第二方案单品", "refPriceCents": 900,
                                         "perUnitConfig": ["第二方案单品"], "nutritionEstimated": False,
                                         "nutritionUnknownFields": [], "nutritionSources": []})
            display_result = {
                "solution": sol_display, "bundle": None, "voucherTrack": None, "decision": None,
                "unified": [sol_display, sol_alt], "channelDiagnostics": None,
            }
            # v1.4.9 N01：结果页必须如实回显本轮口径（预约到某时刻 → 显示用餐时间与餐段）
            display_result["orderContext"] = {
                "mode": "scheduled", "targetTime": "2026-10-19 08:00",
                "reservationDate": "2026-10-19 08:00", "period": "breakfast",
                "periodLabel": "早餐", "note": "已按该时刻向官方查询菜单、套餐构成与价格",
            }
            # v1.4.9 N01：高级诊断里的逐商品遗漏账（结构未取得必须写明原因）
            display_result["menuAudit"] = [
                {"code": "item-1", "name": "估算套餐", "structure": "ok", "nutrition": "estimated",
                 "inPlans": True, "selected": True, "reason": ""},
                {"code": "9900003457", "name": "结构未取得套餐", "structure": "unknown", "nutrition": "unknown",
                 "inPlans": False, "selected": False, "reason": "官方详情长期不可用，不参与心愿覆盖"},
            ]
            display_result["channelDiagnostics"] = {
                "union": {"source": "independent", "queried": 2, "admitted": 1, "deals": [],
                          "stats": {"queried": 2, "admitted": 1, "priceCandidates": 0, "menuVerified": 1,
                                    "saleEnded": 0, "validityExpired": 0, "other": 0}},
            }
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "jobId": jid, "stage": "完成", "stages": ["完成"], "elapsedMs": 1200, "done": True, "cancelled": False, "result": display_result,
            }))
        else:
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "jobId": jid, "stage": "正在求解", "stages": ["正在求解"], "elapsedMs": 1200, "done": False, "cancelled": False,
            }))
        return
    if path.endswith("/api/mcdna"):
        if mcdna_mode["fail"]:
            route.fulfill(status=500, content_type="application/json",
                          body=json.dumps({"needSetup": True, "message": "尚未配置账户，请先填写 Token", "code": "E_TOKEN_MISSING"}))
        else:
            svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="4" y="24">ok</text></svg>'
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "reportId": "r1", "snapshotId": "s1", "amountMode": "tier", "stats": {"demo": True},
                "persona": {"sectName": "单推派", "role": "回头客", "sceneName": "点餐柜台"}, "copy": {},
                "frontSvg": svg, "backSvg": svg, "commentaryStatus": "rules", "commentaryRequest": None}))
        return
    if path.endswith("/api/setup/status"):
        route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "tokenConfigured": True, "tokenSource": "env", "tokenMasked": "stub-****"}))
        return
    if path.endswith("/api/recipes/import/preview") and method == "POST":
        recipe_preview_posts.append(request.post_data_json)
        recipe = {"id": "preview-ok", "name": "已核验测试券", "matchNames": ["已核验测试券"], "resolve": "explicit",
                  "ruleVersion": "test-v1", "items": [{"mode": "fixed", "keyword": "麦香鸡", "qty": 1}],
                  "conditions": {"orderType": "instore"}, "scope": {"city": "上海"}}
        route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "total": 2, "publishable": 1, "blocked": 1, "conflicted": 0,
            "items": [
                {"index": 0, "id": recipe["id"], "name": recipe["name"], "recipe": recipe, "ok": True,
                 "check": {"ok": True, "items": [], "warnings": [], "blocking": []}, "conflicts": [],
                 "nutritionMissing": [], "scope": {"city": "上海", "stores": []}, "publishable": True},
                {"index": 1, "ok": False, "error": "配方结构无效", "conflicts": [], "nutritionMissing": [], "publishable": False},
            ], "publishableRecipes": [recipe], "note": "只读预览：不会写入配方库。"}))
        return
    if path.endswith("/api/recipes/import") and method == "POST":
        recipe_import_posts.append(request.post_data_json)
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"imported": len(request.post_data_json), "skipped": 0, "rejected": []}))
        return
    if path.endswith("/api/recipes") and method == "GET":
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"recipes": [], "count": 0, "presetCount": 0}))
        return
    if path.endswith("/api/nutrition-supplements") and method == "GET":
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"supplements": [], "count": 0}))
        return
    if path.endswith("/api/deals") and method == "POST":
        deals_posts.append(request.post_data_json)
        route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "storeCode": "S1", "storeName": "测试门店", "menuAvailable": True,
            "deals": [
                {"name": "已核验券", "priceYuan": 8.0, "status": "admitted", "verified": True, "note": "可自动比价"},
                {"name": "价格候选券", "priceYuan": 6.0, "status": "price-candidate", "verified": False, "note": "详情未核验"},
            ],
            "diagnostics": {"union": {"source": "independent", "stats": {"queried": 2, "admitted": 1, "priceCandidates": 1, "menuVerified": 1},
                             "deals": [], "unavailableReason": ""}}
        }))
        return
    if path.endswith("/api/solve") and method == "POST":
        solve_posts.append(request.post_data_json)
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"solutions": []}))
        return
    route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True}))


def main():
    if not wait_up():
        print("面板服务未启动，浏览器回归跳过。")
        return 0
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1365, "height": 1000})
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.route("**/api/**", handler)
        page.goto(BASE, wait_until="domcontentloaded")

        # ---------- R14 ----------
        print("【R14】单人页取消按钮只取消自己的 jobId（单人 + 多人任务并存）")
        page.wait_for_selector("#citySel option", state="attached", timeout=8000)
        # 页面启动会自动查门店并折叠条件；列表保留在 DOM 中但默认隐藏。
        page.wait_for_selector("#storeList .sbar-item", state="attached", timeout=8000)
        page.fill("#kcal", "600")
        page.fill("#yuan", "30")
        page.click("#go")
        page.wait_for_selector("#results .progress-card", timeout=8000)
        page.wait_for_selector("#results .p-cancel:not([disabled])", timeout=8000)

        page.click('.tab[data-mode="group"]')
        page.click("#addMember")
        page.wait_for_selector("#memberList .mrow", timeout=8000)
        page.fill("#memberList .m-alias", "甲")
        page.click("#goGroup")
        page.wait_for_selector("#groupResults .progress-card", timeout=8000)

        page.click('.tab[data-mode="solve"]')
        page.wait_for_selector("#results .p-cancel:not([disabled])", timeout=8000)
        page.click("#results .p-cancel")
        for _ in range(40):
            if cancel_urls:
                break
            page.wait_for_timeout(100)
        check(len(cancel_urls) == 1, f"点一次取消只发一次取消请求（实际 {len(cancel_urls)}）")
        check(cancel_urls and cancel_urls[0].endswith("/api/jobs/single-1/cancel"),
              f"取消的是单人任务 single-1（实际 {cancel_urls[0] if cancel_urls else '无'}）")
        check(not any("group-1" in u for u in cancel_urls), "未误取消多人任务 group-1")

        # ---------- R19 ----------
        print("【R19】战报首次失败后可在不刷新的情况下重试")
        page.click('.tab[data-mode="mcdna"]')
        page.click("#goMcdna")
        page.wait_for_selector("#mcdnaErr", state="visible", timeout=8000)
        err_text = page.inner_text("#mcdnaErr")
        check("失败" in err_text, f"首次失败给出可见错误（{err_text[:40]}）")
        check(page.locator("#mcdnaImg").count() == 1, "失败后 img 仍留在 DOM（未被 innerHTML 覆盖）")
        check(page.locator("#mcdnaDl").count() == 1, "失败后下载链接仍留在 DOM")

        mcdna_mode["fail"] = False
        page.click("#goMcdna")
        page.wait_for_timeout(400)
        src = page.get_attribute("#mcdnaImg", "src")
        check(bool(src) and src.startswith("blob:"), f"重试成功复用首响Blob（无二次取数）（{src}）")
        check(page.is_visible("#mcdnaDl"), "重试成功后下载链接可见")
        check(not page.is_visible("#mcdnaErr"), "重试成功后错误元素被隐藏")

        # ---------- UI-1/UI-2/UI-3/UI-4：窄屏消费者入口、门店状态、查券与导入预览 ----------
        print("【UI】390×844：入口分层、门店收纳、输入样式、独立查券与配方导入闭环")
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_selector("#citySel option", state="attached", timeout=8000)
        page.wait_for_selector("#storeSelLine button[data-store-expand]", state="visible", timeout=8000)
        check(page.locator("#tabs .tab").count() == 3, "一级导航仅显示三项消费者入口")
        check("当前门店" in page.inner_text("#storeSelLine"), "收起门店区仍展示当前门店")
        check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "390px 视口没有横向溢出")
        page.click("#storeSelLine [data-store-expand]")
        check(page.is_visible("#storebar .sbar-top") and page.is_visible("#storeList"), "更换门店可展开查询条件与候选列表")
        page.click("#openDataManagement")
        check(page.is_visible("#mode-recipes") and not page.is_visible("#storebarWrap"), "高级数据管理可进入且不占用门店区域")
        style_data = page.evaluate("""() => {
          const ids = ['#setTokenInput', '#recipeHeadUrl', '#recipeVerifiedAt'];
          return ids.map(id => { const e=document.querySelector(id), s=getComputedStyle(e); return {id, radius:s.borderRadius, border:s.borderTopWidth+' '+s.borderTopStyle, padding:s.padding, minHeight:s.minHeight}; });
        }""")
        check(len(style_data) == 3 and len({x["radius"] for x in style_data}) == 1 and all(x["border"].startswith("1px solid") for x in style_data),
              "密码、网址、日期输入使用统一边框与圆角")
        check(style_data[-1]["minHeight"] == "38px", "日期输入具备可用的最小高度")

        solve_jobs_before_deals = len(solve_job_posts)
        group_jobs_before_deals = len(group_job_posts)
        page.click("#refreshRecipeDeals")
        for _ in range(40):
            if deals_posts:
                break
            page.wait_for_timeout(100)
        check(len(deals_posts) == 1 and deals_posts[0].get("storeCode") == "S1", "只查券请求携带已选门店")
        check(len(solve_posts) == 0 and len(solve_job_posts) == solve_jobs_before_deals and len(group_job_posts) == group_jobs_before_deals,
              "只查券没有触发同步或任务式精算/拼单求解")
        page.wait_for_function("document.querySelector('#recipeDealList').innerText.includes('已核验券')", timeout=8000)
        check("已核验券" in page.inner_text("#recipeDealList"), "独立查券结果显示可核验团单")

        page.locator("#mode-recipes details").filter(has_text="导入研究配方").locator("summary").click()
        page.fill("#recipeImportJson", '[{"id":"draft-only"}]')
        page.click("#previewRecipeImport")
        page.wait_for_function("document.querySelector('#recipeImportPreview').textContent.includes('只读预览')", timeout=8000)
        check(len(recipe_preview_posts) == 1, "导入内容经服务端只读预览")
        check("可发布 1 条" in page.inner_text("#recipeImportPreview"), "预览准确展示可发布数量")
        check(page.is_enabled("#confirmRecipeImport"), "仅有安全可发布项时启用确认按钮")
        page.once("dialog", lambda dialog: dialog.accept())
        page.click("#confirmRecipeImport")
        for _ in range(40):
            if recipe_import_posts:
                break
            page.wait_for_timeout(100)
        check(len(recipe_import_posts) == 1 and len(recipe_import_posts[0]) == 1 and recipe_import_posts[0][0]["id"] == "preview-ok",
              "确认发布仅提交预览中的可发布项")

        page.click('.tab[data-mode="group"]')
        page.click("#addMember")
        page.fill("#memberList .m-alias", "营养测试")
        page.click("#goGroup")
        page.wait_for_function("document.querySelector('#groupResults').innerText.includes('营养部分已知')", timeout=12000)
        group_text = page.inner_text("#groupResults")
        check("缺钠" in group_text and "含估算值" in group_text, "多人购买清单明确呈现缺失字段与估算营养")
        check("仅供参考" in group_text, "多人结果提示估算营养不作硬约束证据")
        # v1.4.10 W13：同源营养说明改为卡片底部汇总一次（折叠），逐行不再重复
        src_details = page.locator("#groupResults .sol").first.locator("details").filter(has_text="营养来源")
        check(src_details.count() >= 1, "营养来源收进卡片底部折叠汇总")
        src_details.first.locator("summary").click()
        page.wait_for_timeout(80)
        check("测试审核营养源" in page.locator("#groupResults .sol").first.inner_text(),
              "展开汇总后仍可追溯到具体营养来源（不删除关键信息）")
        # v1.4.7 R17：分账/出餐指引改为方案卡内 viewtoggle 切换（不再有独立卡片）
        # v1.4.8 R01：三态视图每卡独立，活动视图存于卡片自身（data-active-view），
        #   显示/按钮文案/选中态全部由它派生；断言走真实点击后的可见区与文案，不查源码。
        cards = page.locator("#groupResults .sol")
        check(cards.count() == 2, f"多人结果按统一候选逐张渲染方案卡（实际 {cards.count()} 张）")
        card1, card2 = cards.nth(0), cards.nth(1)

        def visible_views(card):
            return card.evaluate("""el => Array.from(el.querySelectorAll('[data-view]'))
                .filter(v => getComputedStyle(v).display !== 'none')
                .map(v => v.getAttribute('data-view'))""")

        def view_labels(card):
            return card.evaluate("""el => { const o = {};
                el.querySelectorAll('.viewtoggle').forEach(b => { o[b.getAttribute('data-view-btn')] = b.textContent.trim(); });
                return o; }""")

        def click_view(card, name):
            card.locator('.viewtoggle[data-view-btn="' + name + '"]').click()
            page.wait_for_timeout(60)

        check(visible_views(card1) == ["buy"], f"初始只显示购买清单（实际 {visible_views(card1)}）")
        check(card1.locator('[data-view="serve"]').count() == 1, "方案卡内含出餐指引视图（券履约/订单备注同卡内联）")

        click_view(card1, "bill")
        check("热量参考合计 430 kcal（含估算）" in card1.locator("[data-view='bill']").inner_text(),
              "分账视图避免把估算热量写成精确总量")
        check(visible_views(card1) == ["bill"], f"进入分账后恰有一个内容区可见（实际 {visible_views(card1)}）")
        labels = view_labels(card1)
        check(labels.get("bill", "").startswith("🛒") and "返回购买清单" in labels.get("bill", ""),
              f"分账按钮切换为返回购买清单（实际 {labels.get('bill')}）")
        check(labels.get("serve", "").startswith("🎫"), f"未选中的出餐按钮保持原文案（实际 {labels.get('serve')}）")

        # R01 反例一：旧实现「当前是否可见」反推状态，重复点击当前详情会让三个内容区一起隐藏（空卡）
        click_view(card1, "bill")
        check(visible_views(card1) == ["buy"], f"再次点击分账详情回到购买清单（实际 {visible_views(card1)}）")
        labels = view_labels(card1)
        check(labels.get("bill", "").startswith("💰") and labels.get("serve", "").startswith("🎫"),
              f"回到购买清单后两个按钮文案全部还原（实际 {labels}）")

        click_view(card1, "serve")
        check(visible_views(card1) == ["serve"], f"进入出餐指引后恰有一个内容区可见（实际 {visible_views(card1)}）")
        click_view(card1, "serve")
        check(visible_views(card1) == ["buy"], f"再次点击出餐指引回到购买清单（实际 {visible_views(card1)}）")

        # R01 反例二：旧实现分账↔出餐交叉切换后，出餐按钮仍写「返回购买清单」却进入出餐内容
        click_view(card1, "serve")
        click_view(card1, "bill")
        labels = view_labels(card1)
        check(visible_views(card1) == ["bill"], f"出餐→分账交叉切换后只显示分账（实际 {visible_views(card1)}）")
        check(labels.get("bill", "").startswith("🛒") and labels.get("serve", "").startswith("🎫"),
              f"交叉切换后按钮文案跟随活动视图而非历史点击（实际 {labels}）")
        check(card1.get_attribute("data-active-view") == "bill", "活动视图记录在卡片自身状态上")

        # 多卡互不影响：卡1 停在出餐、卡2 切到分账，各自文案跟随自己
        click_view(card1, "serve")
        click_view(card2, "bill")
        check(visible_views(card1) == ["serve"] and visible_views(card2) == ["bill"],
              f"两卡各自维护活动视图（卡1={visible_views(card1)} 卡2={visible_views(card2)}）")
        labels1, labels2 = view_labels(card1), view_labels(card2)
        check(labels1.get("serve", "").startswith("🛒") and labels2.get("bill", "").startswith("🛒"),
              "两卡的按钮文案各自跟随自己的活动视图")
        seqs = cards.evaluate_all("""els => els.map(el => Array.from(el.querySelectorAll('.copybtn'))
            .map(b => b.getAttribute('data-seq')))""")
        check(len(seqs) == 2 and len(set(seqs[0])) == 1 and len(set(seqs[1])) == 1 and set(seqs[0]).isdisjoint(set(seqs[1])),
              f"每张卡的复制按钮只绑定该卡自己的方案序号（实际 {seqs}）")

        # ---------- v1.4.9 N01：用餐时间口径 / 分时段目录 / 逐商品遗漏账 ----------
        print("【N01】用餐时间口径透传、分时段目录面板、逐商品遗漏账")
        page.click('.tab[data-mode="solve"]')
        page.wait_for_selector("#targetTime", state="visible", timeout=8000)
        check(page.is_visible("#targetTime"), "单人表单提供「用餐时间（选填 · 预约口径）」输入")
        check(bool(solve_job_posts) and "targetTime" not in solve_job_posts[0],
              f"留空时不塞空串（首个请求 {solve_job_posts[0] if solve_job_posts else '无'}）")
        page.fill("#targetTime", "08:00")
        page.click("#go")
        for _ in range(40):
            if len(solve_job_posts) >= 2:
                break
            page.wait_for_timeout(100)
        got = (solve_job_posts[-1] if solve_job_posts else {}).get("targetTime")
        check(got == "08:00", f"单人用餐时间随请求透传（实际 {got}）")

        page.click('.tab[data-mode="group"]')
        page.wait_for_selector("#groupTargetTime", state="visible", timeout=8000)
        check(page.is_visible("#groupTargetTime"), "拼单表单提供同一口径输入")
        page.fill("#groupTargetTime", "2026-10-19 08:00")
        page.click("#goGroup")
        for _ in range(40):
            if len(group_job_posts) >= 2:
                break
            page.wait_for_timeout(100)
        ggot = (group_job_posts[-1] if group_job_posts else {}).get("targetTime")
        check(ggot == "2026-10-19 08:00", f"拼单用餐时间随请求透传（实际 {ggot}）")

        page.wait_for_function("document.querySelector('#groupStatus').innerText.includes('用餐时间')", timeout=12000)
        gstatus = page.inner_text("#groupStatus")
        check("2026-10-19 08:00" in gstatus and "早餐" in gstatus,
              f"结果页如实回显用餐时间口径（{gstatus[:60].replace(chr(10), ' ')}）")

        page.click("#openDataManagement")
        page.wait_for_function("document.querySelector('#dataDiagnostics').innerText.includes('逐商品遗漏账')", timeout=8000)
        dd = page.inner_text("#dataDiagnostics")
        check("逐商品遗漏账（2 条" in dd and "已选中 1" in dd, f"高级诊断含逐商品遗漏账（{dd[:40].replace(chr(10), ' ')}）")
        page.locator("#dataDiagnostics details").filter(has_text="逐商品遗漏账").locator("summary").click()
        page.wait_for_timeout(120)
        dd2 = page.inner_text("#dataDiagnostics")
        check("结构未取得" in dd2 and "不参与心愿覆盖" in dd2, "遗漏账展开后写明结构未取得的原因")
        check("估算套餐" in dd2, "遗漏账逐商品列出（含已选中项）")

        page.fill("#periodCatalogDate", "2026-10-19")
        page.fill("#periodCatalogTime", "08:00")
        page.click("#loadPeriodCatalog")
        for _ in range(60):
            if period_catalog_posts:
                break
            page.wait_for_timeout(100)
        check(len(period_catalog_posts) == 1 and period_catalog_posts[0].get("storeCode") == "S1",
              f"目录读取携带已选门店（实际 {period_catalog_posts[0] if period_catalog_posts else '无'}）")
        check(bool(period_catalog_posts) and period_catalog_posts[0].get("date") == "2026-10-19"
              and period_catalog_posts[0].get("targetTime") == "08:00",
              "目录读取携带日期与目标时段")
        page.wait_for_function("document.querySelector('#periodCatalogOut').innerText.includes('早餐')", timeout=8000)
        pcout = page.inner_text("#periodCatalogOut")
        check("60 条" in pcout and "101 条" in pcout, "分时段目录按锚点逐条呈现条数")
        check("查询失败" in pcout, "失败锚点如实标注，不用其他时段推断")
        check("可售 60 条" in pcout, "目标时段可售池条数可见")
        check("并集 161 条" in pcout, "目录并集条数与单餐段区分（不把 12:00/18:00 重复计数）")
        page.locator("#periodCatalogOut details").filter(has_text="逐商品遗漏账").locator("summary").click()
        page.wait_for_timeout(120)
        pcout2 = page.inner_text("#periodCatalogOut")
        check("9900009999" in pcout2 and "off-period" in pcout2, "未进池商品逐条带原因（可审计，不静默丢弃）")
        check("9900003457" in pcout2 and "结构完整" in pcout2, "池内商品带结构与分时段价格")

        # ---------- v1.4.10 W07/W10-W14：出口与展示一致性 ----------
        print("【W07/W10-W14】缺口共享 / 按吃什么分组 / 规格贯通 / 行价与途径证据等级")
        r = page.evaluate("""() => {
          const mk = (o) => Object.assign({
            store:{storeCode:'S1', storeName:'测试门店'}, track:'a-la-carte',
            members:[], basket:[], warnings:[], totals:{originalCents:0, paidCents:0, discountCents:0, priceSource:'calculate-price'},
            coverage:{total:0, met:0}, gapTotal:0,
          }, o);
          const out = {};
          // W10：同一食品组合、不同购买路径 code → 同组；规格不同 → 不同组
          //   （单人结果的 items 才是分组输入：groupByBasket(d.solutions)）
          const s1 = mk({items:[
            {code:'X1', name:'麦香鸡', qty:1, refPriceCents:1000, foods:[{code:'A', name:'麦香鸡', qty:1}]},
            {code:'Y1', name:'香芋派', qty:1, refPriceCents:500, foods:[{code:'B', name:'香芋派', qty:1}]}]});
          const s2 = mk({items:[{code:'P1', name:'麦香鸡+香芋派券', qty:1, refPriceCents:1400,
            foods:[{code:'A', name:'麦香鸡', qty:1}, {code:'B', name:'香芋派', qty:1}]}]});
          out.groupsSameFood = groupByBasket([s1, s2]).length;
          const s3 = mk({items:[{code:'Z1', name:'可乐', qty:1, refPriceCents:1200,
            foods:[{code:'Z1', name:'可乐', spec:'大杯', qty:1}]}]});
          const s4 = mk({items:[{code:'Z1', name:'可乐', qty:1, refPriceCents:1000,
            foods:[{code:'Z1', name:'可乐', spec:'中杯', qty:1}]}]});
          out.groupsDiffSpec = groupByBasket([s3, s4]).length;
          out.specKeys = [basketKeyOf(s3), basketKeyOf(s4)];
          // W11：规格展示（品名未含规格时补出，已含则不重复）
          out.specText = basketSpecText({foods:[{name:'可乐', spec:'大杯', qty:1}]});
          out.specNoDup = basketSpecText({foods:[{name:'大薯条（大）', spec:'大', qty:1}]});
          // W12：除不尽的份数价不画「单价 × 份数 = 合计」
          const s12 = mk({basket:[{kind:'single', code:'C1', name:'套餐', qty:3, refPriceCents:1000, channelLabel:'官方 App'}],
            members:[{alias:'甲', items:[{name:'套餐', qty:3}], originalCents:1000, shareCents:1000, payableCents:1000, savedCents:0}]});
          out.priceRow = purchaseViewHtml(s12);
          const s12b = mk({basket:[{kind:'single', code:'C1', name:'套餐', qty:3, refPriceCents:1200, channelLabel:'官方 App'}], members:[]});
          out.priceRowDiv = purchaseViewHtml(s12b);
          // W13：同源营养说明只汇总一次（逐行不再重复）
          const rows = Array.from({length:10},(_,i)=>({kind:'single', code:'R'+i, name:'食品'+i, qty:1,
            refPriceCents:100, channelLabel:'官方 App', nutritionSources:['麦当劳官方营养表（测试）']}));
          const s13 = mk({basket:rows, members:[{alias:'甲', items:[], originalCents:1000, shareCents:1000,
            payableCents:1000, savedCents:0, nutritionSources:['麦当劳官方营养表（测试）']}]});
          out.nutritionHtml = purchaseViewHtml(s13);
          out.nutritionRowSource = (out.nutritionHtml.match(/营养来源：/g)||[]).length;
          out.nutritionSummary = (out.nutritionHtml.match(/同源说明已合并/g)||[]).length;
          // W07 + W14：结构化缺口三处共用；购买途径逐条标证据等级与可执行明细
          const sAll = mk({
            basket:[{kind:'single', code:'C1', name:'板烧鸡腿堡三件套', qty:1, refPriceCents:3450, channelLabel:'官方 App',
              perUnitConfig:['板烧鸡腿堡','中薯条','可乐中杯'], foods:[{code:'B1', name:'板烧鸡腿堡', qty:1}]}],
            members:[{alias:'甲', items:[{name:'板烧鸡腿堡三件套', qty:1}], originalCents:3450, shareCents:3450, payableCents:3450, savedCents:0}],
            coverage:{total:2, met:1}, gapTotal:1,
            unmet:[{alias:'乙', keyword:'巨无霸套餐', reason:'unsatisfied', missingQty:1}],
            purchaseOptions:[
              {label:'官方 App', paidCents:3450, priceSource:'calculate-price', track:'a-la-carte', items:['板烧鸡腿堡三件套×1']},
              {label:'美团团购', paidCents:3390, priceSource:'snapshot', track:'voucher', note:'券面价，未核价', items:['板烧鸡腿堡三件套券×1']},
            ],
          });
          out.cardHtml = groupCard(sAll, 1, true, false);
          out.copyText = purchasePlainText(sAll);
          return out;
        }""")
        check(r["groupsSameFood"] == 1, f"同食品不同购买路径合成 1 张卡（实际 {r['groupsSameFood']}）")
        check(r["groupsDiffSpec"] == 2, f"同 code 不同规格不合并（实际 {r['groupsDiffSpec']}）")
        # 规格归一后「大杯 / 大」使用同一尺寸键；核对两种尺寸仍各自保留。
        check(r["specKeys"][0] != r["specKeys"][1] and "@大" in r["specKeys"][0] and "@中" in r["specKeys"][1],
              f"身份键带规格（{r['specKeys']}）")
        check("可乐（大杯）" in r["specText"], f"购买行补出规格（实际 {r['specText']}）")
        check(r["specNoDup"] == "", f"品名已含规格时不重复（实际 {r['specNoDup']}）")
        check("（3 份合计" in r["priceRow"] and "3.33" not in r["priceRow"],
              "除不尽的份数价只给合计并注明份数（不画 3.33×3=10）")
        check("×3 = " in r["priceRowDiv"], "能整除时仍给单价×份数=合计")
        check(r["nutritionRowSource"] == 0 and r["nutritionSummary"] == 1,
              f"同源营养说明只汇总一次（行内 {r['nutritionRowSource']} / 汇总 {r['nutritionSummary']}）")
        check("已核价（计价接口）" in r["cardHtml"] and "历史快照参考价" in r["cardHtml"],
              "多条购买途径逐条标注价格证据等级")
        check("券面价，未核价" in r["cardHtml"], "途径备注（未核价原因）可见")
        check("板烧鸡腿堡三件套券×1" in r["cardHtml"], "每条途径带可执行明细")
        check("还缺：" in r["cardHtml"] and "巨无霸套餐（本方案未能分配）" in r["cardHtml"],
              "结构化缺口在卡片可见（含成员与原因）")
        check("还缺（本单未能满足）" in r["copyText"] and "@乙 巨无霸套餐（本方案未能分配）" in r["copyText"],
              "复制清单带缺口（不依赖 warning 文本推导）")

        check(len(page_errors) == 0, f"全程无未捕获页面异常（实际 {len(page_errors)}：{page_errors[:2]}）")

        browser.close()
    return 0


try:
    main()
finally:
    try:
        server.terminate()
    except Exception:
        pass
    try:
        shutil.rmtree(HOME, ignore_errors=True)
    except Exception:
        pass

if failures:
    print(f"\n{len(failures)} 项未通过 \u2717")
    sys.exit(1)
print("\nv1.4.9 浏览器行为回归全部通过 \u2713")
