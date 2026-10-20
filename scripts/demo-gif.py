#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""录制 GitHub Pages 静态演示的 README GIF。

只用 docs/demo 的静态文件 + 内置 mock 回执，不启动真实后端。
产物：docs/screens/demo-single.gif、docs/screens/demo-group.gif
运行：python scripts/demo-gif.py
"""
from __future__ import annotations

import io
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OUT = DOCS / "screens"
OUT.mkdir(parents=True, exist_ok=True)
VIEWPORT = {"width": 1180, "height": 820}
GIF_SIZE = (960, 667)
CURSOR_SVG = (
    "data:image/svg+xml,"
    "%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='28' viewBox='0 0 24 28'%3E"
    "%3Cpath d='M2 2 L2 22 L8.3 16.7 L12.9 26 L17.8 24 L13.1 15 L22 14 Z' "
    "fill='white' stroke='%23131313' stroke-width='2' stroke-linejoin='round'/%3E"
    "%3C/svg%3E"
)
CURSOR_INIT = """
(() => {
  const style = document.createElement('style');
  style.textContent = `
    #demo-cursor { position: fixed; left: 0; top: 0; width: 24px; height: 28px;
      z-index: 2147483647; pointer-events: none; transform: translate(-2px, -2px);
      filter: drop-shadow(0 2px 2px rgba(0,0,0,.35)); }
    #demo-cursor.click { transform: translate(-2px, -2px) scale(.82); }
  `;
  const add = () => {
    document.head.appendChild(style);
    const img = document.createElement('img');
    img.id = 'demo-cursor';
    img.src = %s;
    img.alt = '';
    document.body.appendChild(img);
    document.addEventListener('mousemove', (e) => {
      img.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`;
    });
    document.addEventListener('mousedown', () => img.classList.add('click'));
    document.addEventListener('mouseup', () => img.classList.remove('click'));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
  else add();
})();
""" % repr(CURSOR_SVG)


class StaticServer:
    def __init__(self):
        class Quiet(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(DOCS), **kwargs)

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_port}/demo/"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class Recorder:
    def __init__(self, page):
        self.page = page
        self.frames = []
        self.durations = []

    def snap(self, duration=120):
        raw = self.page.screenshot(type="png")
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        im = im.resize(GIF_SIZE, Image.Resampling.LANCZOS)
        self.frames.append(im)
        self.durations.append(duration)

    def hold(self, seconds=0.5, fps=8):
        end = time.monotonic() + seconds
        step = 1.0 / fps
        while time.monotonic() < end:
            self.snap(int(step * 1000))
            self.page.wait_for_timeout(int(step * 1000))

    def wait_result(self, selector, seconds=4.0):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if self.page.locator(selector).count():
                return True
            self.snap(140)
            self.page.wait_for_timeout(140)
        return False

    def save(self, path, colors=160):
        quantized = []
        for im in self.frames:
            q = im.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
            quantized.append(q)
        quantized[0].save(
            path,
            save_all=True,
            append_images=quantized[1:],
            duration=self.durations,
            loop=0,
            optimize=True,
            disposal=2,
        )


def scroll_to(page, selector, offset=90, rec=None, frames=5):
    target = page.evaluate(
        """(sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          return el.getBoundingClientRect().top + window.scrollY;
        }""",
        selector,
    )
    if target is None:
        return
    start = page.evaluate("() => window.scrollY")
    dest = max(0, target - offset)
    for i in range(1, frames + 1):
        y = start + (dest - start) * i / frames
        page.evaluate("(y) => window.scrollTo(0, y)", y)
        page.wait_for_timeout(55)
        if rec:
            rec.snap(100)


def move_to(page, selector, rec, duration=160):
    loc = page.locator(selector).first
    box = loc.bounding_box()
    if not box:
        return
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=7)
    page.wait_for_timeout(90)
    rec.snap(duration)


def click(page, selector, rec, pause=0.35):
    move_to(page, selector, rec)
    page.locator(selector).first.click()
    page.wait_for_timeout(120)
    rec.hold(pause, fps=8)


def type_chars(page, selector, text, rec):
    click(page, selector, rec, pause=0.18)
    page.keyboard.press("Control+A")
    for ch in text:
        page.keyboard.type(ch)
        page.wait_for_timeout(130)
        rec.snap(170)
    page.wait_for_timeout(140)
    rec.snap(180)


def new_page(browser):
    page = browser.new_page(viewport=VIEWPORT, device_scale_factor=1)
    page.add_init_script(CURSOR_INIT)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE_URL, wait_until="networkidle", timeout=30000)
    page.wait_for_selector("#storeList .sbar-item", state="attached", timeout=15000)
    page.wait_for_timeout(300)
    page.evaluate("() => window.scrollTo(0, 0)")
    return page, errors


def record_single(browser):
    page, errors = new_page(browser)
    rec = Recorder(page)
    rec.hold(0.7, fps=7)
    scroll_to(page, "#kcal", offset=130, rec=rec, frames=4)
    rec.hold(0.25)
    type_chars(page, "#kcal", "700", rec)
    type_chars(page, "#yuan", "32", rec)
    click(page, 'label[for="o-protein"]', rec, pause=0.35)
    click(page, "#go", rec, pause=0.2)
    scroll_to(page, "#results", offset=95, rec=rec, frames=4)
    if not rec.wait_result("#results .sol", seconds=4.0):
        raise RuntimeError("单人演示没有出现结果；页面错误：" + " | ".join(errors))
    scroll_to(page, "#results .sol", offset=95, rec=rec, frames=6)
    rec.hold(2.2, fps=7)
    # 稍向下，展示“备选方案”与证据层级，再回到首卡收尾。
    page.evaluate("() => window.scrollBy(0, 330)")
    page.wait_for_timeout(250)
    rec.hold(0.9, fps=6)
    scroll_to(page, "#results .sol", offset=95, rec=rec, frames=4)
    rec.hold(1.5, fps=6)
    rec.save(OUT / "demo-single.gif")
    page.close()
    return len(rec.frames), errors


def record_group(browser):
    page, errors = new_page(browser)
    rec = Recorder(page)
    click(page, '.tab[data-mode="group"]', rec, pause=0.4)
    page.evaluate("() => window.scrollTo(0, 0)")
    rec.hold(0.6, fps=7)
    click(page, "#demoFillBtn", rec, pause=0.35)
    click(page, "#parseBtn", rec, pause=0.45)
    page.wait_for_selector("#memberList .mrow", timeout=10000)
    scroll_to(page, "#memberList", offset=120, rec=rec, frames=5)
    rec.hold(1.0, fps=7)
    scroll_to(page, "#goGroup", offset=150, rec=rec, frames=5)
    rec.hold(0.3)
    click(page, "#goGroup", rec, pause=0.2)
    scroll_to(page, "#groupResults", offset=95, rec=rec, frames=4)
    if not rec.wait_result("#groupResults .sol", seconds=4.5):
        raise RuntimeError("多人演示没有出现结果；页面错误：" + " | ".join(errors))
    scroll_to(page, "#groupResults .sol", offset=95, rec=rec, frames=6)
    rec.hold(1.6, fps=7)
    bill = '#groupResults .viewtoggle[data-view-btn="bill"]'
    if page.locator(bill).count():
        click(page, bill, rec, pause=0.35)
        scroll_to(page, "#groupResults .sol", offset=95, rec=rec, frames=4)
        rec.hold(2.8, fps=6)
    page.close()
    rec.save(OUT / "demo-group.gif")
    return len(rec.frames), errors


if __name__ == "__main__":
    server = StaticServer()
    BASE_URL = server.base
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            single_n, single_err = record_single(browser)
            group_n, group_err = record_group(browser)
            browser.close()
        for name, n, errs in (("single", single_n, single_err), ("group", group_n, group_err)):
            if errs:
                print(f"{name}: 页面异常 -> " + " | ".join(errs))
            print(f"{name}: {n} 帧 -> docs/screens/demo-{name}.gif")
        for name in ("single", "group"):
            size = (OUT / f"demo-{name}.gif").stat().st_size
            print(f"demo-{name}.gif: {size / 1024 / 1024:.2f} MB")
    finally:
        server.close()
