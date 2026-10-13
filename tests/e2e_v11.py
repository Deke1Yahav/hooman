"""0.11.7: a new version arrives whole. GitHub Pages lets browsers keep each file 10 minutes (max-age=600); the
service worker must take a new version's files from the server, never from those copies (0.11.6 ran 0.11.5's
decksfolder.js after a refresh), and the page reloads into the new version on the home screen.

    python tests/e2e_v11.py

The app is copied to a temporary folder and served with GitHub's cache header; a "new version" there changes one
file and sw.js's VERSION.
"""
import functools
import http.server
import pathlib
import re
import shutil
import sys
import tempfile
import threading

from playwright.sync_api import sync_playwright

from e2e import ROOT, check, failures


def serve_dir(d):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("Cache-Control", "max-age=600")          # as GitHub Pages sends
            super().end_headers()

        def log_message(self, *a):
            pass
    http.server.ThreadingHTTPServer.request_queue_size = 128
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(d)))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


CACHED = """async ([name, path]) => { const c = await caches.open(name); const r = await c.match(path); return r ? r.text() : null; }"""


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    src = ROOT / "app"
    sw = (src / "sw.js").read_text(encoding="utf-8")
    v = re.search(r'VERSION = "hooman-([\d.]+)"', sw).group(1)
    a = re.search(r'APP_VERSION = "([\d.]+)"', (src / "js" / "export.js").read_text(encoding="utf-8")).group(1)
    print("One version number")
    check(v == a, f"sw.js and the app say the same version ({v} / {a})")

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="hooman-sw-"))
    app = tmp / "app"
    shutil.copytree(src, app)
    prefs = app / "js" / "prefs.js"
    prefs.write_text(prefs.read_text(encoding="utf-8") + "\n// marker-A\n", encoding="utf-8")
    srv = serve_dir(app)
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        print("The first version installs")
        page.goto(base); page.wait_for_selector(".hero")
        page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=30000)
        page.reload(); page.wait_for_selector(".hero")              # a page that starts with a version (as every later visit)
        check("marker-A" in (page.evaluate(CACHED, [f"hooman-{v}", "js/prefs.js"]) or ""), "its files are in its cache")

        print("A new version: one changed file, a new sw.js; the browser still keeps the old file (10 minutes)")
        prefs.write_text(prefs.read_text(encoding="utf-8").replace("marker-A", "marker-B"), encoding="utf-8")
        (app / "sw.js").write_text(sw.replace(f'"hooman-{v}"', '"hooman-test-next"'), encoding="utf-8")
        reloaded = True
        try:
            with page.expect_navigation(timeout=30000):
                page.evaluate("navigator.serviceWorker.getRegistration().then((r) => r.update())")
        except Exception:
            reloaded = False
        page.wait_for_selector(".hero")
        check(reloaded, "the page on the home screen reloads into the new version by itself")
        new = page.evaluate(CACHED, ["hooman-test-next", "js/prefs.js"]) or ""
        check("marker-B" in new, "the new version's file came from the server, not the browser's 10-minute copy")
        running = page.evaluate("fetch('js/prefs.js').then((r) => r.text())")
        check("marker-B" in running and "marker-A" not in running, "and that is the file the app runs")
        check(page.evaluate("caches.keys()") == ["hooman-test-next"], f"the old version's cache is gone ({page.evaluate('caches.keys()')})")
        check(not errors, "no page errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
    srv.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
