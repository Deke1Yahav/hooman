"""End-to-end checks for 0.7's decks folder: deck zips put in a picked folder show up by themselves, a changed zip
updates its deck (answers kept, the deck on screen waits), answer exports are skipped and broken zips explained,
answers can go to the folder's "results", a half-loaded big deck resumes from the folder after a restart, and a
lapsed permission comes back with one tap.

    python tests/e2e_v9.py            # needs Google Chrome installed (stored folder handles; see e2e_v7)

The browser's private file system stands in for the picked folder (the real picker needs a person).
"""
import base64
import io
import json
import sys
import time
import zipfile

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

from e2e import OUT, serve, check, failures, dismiss_tour
from e2e_v3 import watch
from e2e_v8 import big_deck

PICK = """if (window.FileSystemHandle) {
  window.showDirectoryPicker = async (o) => (await navigator.storage.getDirectory()).getDirectoryHandle(o && o.id === "hooman-decks" ? "decks" : "picked", { create: true });
  FileSystemHandle.prototype.queryPermission = async function () { return localStorage.getItem("test:perm") || "granted"; };
  FileSystemHandle.prototype.requestPermission = async function () { localStorage.setItem("test:perm", "granted"); return "granted"; }; }"""
PUT = """async ([path, b64]) => { let d = await navigator.storage.getDirectory(); const parts = path.split("/");
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const bin = atob(b64), b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable(); await w.write(b); await w.close(); }"""
GET = """async (path) => { try { let d = await navigator.storage.getDirectory(); const parts = path.split("/");
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
  const b = new Uint8Array(await (await (await d.getFileHandle(parts.at(-1))).getFile()).arrayBuffer());
  let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); } catch (e) { return null; } }"""


def png(a):
    b = io.BytesIO(); Image.fromarray(a.astype(np.uint8)).save(b, "PNG"); return b.getvalue()


def small_deck(title, n=3):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for i in range(n):
            a = np.full((48, 48), 40, np.uint8); a[10:30, 10:30] = 200
            z.writestr(f"img/{i}.png", png(a), compress_type=zipfile.ZIP_STORED)
        z.writestr("deck.json", json.dumps({"hooman": 1, "id": "folder-a", "title": title, "question": "Bright square?",
                                            "answers": {"right": "Yes", "left": "No"}, "cards": [f"img/{i}.png" for i in range(n)]}))
    return out.getvalue()


def answers_zip():
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("answers.json", json.dumps({"hooman_answers": 1, "deck": {"id": "folder-a"}, "answers": []}))
    return out.getvalue()


def not_a_deck():
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("readme.txt", "hello")
    return out.getvalue()


b64 = lambda data: base64.b64encode(data).decode()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    errors = []
    zbig = big_deck("folder-big").read_bytes()
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="chrome")
        except Exception:
            print("  note: Google Chrome isn't installed; the decks folder checks need it (stored folder handles)")
            srv.shutdown(); sys.exit(0)
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, service_workers="block")
        ctx.add_init_script(PICK)
        page = ctx.new_page(); watch(page, errors)
        cdp = ctx.new_cdp_session(page)
        slow = lambda rate: cdp.send("Emulation.setCPUThrottlingRate", {"rate": rate})
        page.goto(base); page.wait_for_selector(".hero")
        page.evaluate(PUT, ["decks/folder-a.hooman.zip", b64(small_deck("Folder deck A"))])
        page.evaluate(PUT, ["decks/folder-a.Tester.answers.zip", b64(answers_zip())])
        page.evaluate(PUT, ["decks/notadeck.zip", b64(not_a_deck())])

        print("Choosing the folder brings its decks in")
        page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet #decks-row")
        row = page.locator(".sheet #decks-row")
        check("Choose a folder" in row.inner_text() and "Google Drive" in row.inner_text(), "Settings offers a decks folder (and says a synced folder works)")
        row.get_by_role("button", name="Choose a folder").click(); page.wait_for_timeout(1500)
        check("New from your folder" in page.locator("#toast").inner_text() and "Folder deck A" in page.locator("#toast").inner_text(), "the deck in the folder shows up, with a note")
        t = row.inner_text()
        check("“decks”" in t and "2 deck zips" in t and "couldn't be opened" in t, f"the row says what it found: 2 zips (the answers file skipped), 1 not a deck ({t!r})")
        page.screenshot(path=OUT / "90_decks_folder_settings.png")
        row.locator("[data-decks=errors]").click(); page.wait_for_selector(".sheet .errors")
        check("notadeck.zip" in page.locator(".sheet .errors").inner_text() and "deck.json" in page.locator(".sheet .errors").inner_text(), "the broken zip says why")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        check(page.locator(".deckrow", has_text="Folder deck A").count() == 1 and page.locator("[data-act=checkdecks]").count() == 1, "home lists it, with ↻ check folder")

        print("Answers into the folder's results")
        page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet #decks-row")
        page.locator(".sheet [data-decks=results]").click(); page.wait_for_timeout(800)
        check("results" in page.locator("#toast").inner_text(), "answers now go into “results” in the decks folder")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        page.locator(".deckrow", has_text="Folder deck A").click(); page.wait_for_selector(".card canvas"); dismiss_tour(page)
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(500)
        page.evaluate("import('./js/livesave.js').then((m) => m.settled())")
        got = page.evaluate(GET, "decks/results/folder-a.Tester.answers.zip")
        n = len(json.loads(zipfile.ZipFile(io.BytesIO(base64.b64decode(got))).read("answers.json"))["answers"]) if got else 0
        check(n == 1, f"the answer is in decks/results/folder-a.Tester.answers.zip ({n})")

        print("A changed zip updates its deck, but not under the hooman's hands")
        page.evaluate(PUT, ["decks/folder-a.hooman.zip", b64(small_deck("Folder deck A v2", 4))])
        page.evaluate("import('./js/decksfolder.js').then((m) => m.check({ force: true, openKey: 'folder-a' }))"); page.wait_for_timeout(800)
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        check(page.locator(".deckrow", has_text="Folder deck A v2").count() == 0, "the deck on screen isn't swapped while it's open")
        page.locator("[data-act=checkdecks]").click(); page.wait_for_timeout(1500)
        toast = page.locator("#toast").inner_text()
        row = page.locator(".deckrow", has_text="Folder deck A v2")
        check("Updated (answers kept)" in toast and row.count() == 1 and "1 / 4" in row.inner_text(), f"after leaving it, ↻ updates it and keeps the answer ({row.inner_text() if row.count() else toast!r})")
        page.locator("[data-act=checkdecks]").click(); page.wait_for_timeout(800)
        check("Nothing new" in page.locator("#toast").inner_text(), "checking again: nothing new")

        print("A big deck in the folder, interrupted, resumes by itself")
        slow(20)
        page.evaluate(PUT, ["decks/folder-big.hooman.zip", b64(zbig)])
        page.locator("[data-act=checkdecks]").click()
        page.locator(".deckrow", has_text="folder-big").wait_for(timeout=60000)
        check("loading" in page.locator(".deckrow", has_text="folder-big").inner_text(), "it opens at once and loads in the background")
        page.wait_for_timeout(1500)
        page.reload(); page.wait_for_selector(".hero")
        slow(1)
        t0 = time.time()
        while time.time() - t0 < 120 and page.evaluate("localStorage.getItem('hooman:loading:folder-big')") is not None:
            page.wait_for_timeout(500)
        done = page.evaluate("localStorage.getItem('hooman:loading:folder-big')") is None
        check(done and page.locator(".banner", has_text="still to load").count() == 0, f"after a restart it resumes from the folder without asking ({time.time() - t0:.0f} s)")

        print("The permission lapses: one tap brings it back")
        page.evaluate("localStorage.setItem('test:perm', 'prompt')")
        page.reload(); page.wait_for_selector(".hero"); page.wait_for_timeout(800)
        banner = page.locator(".banner", has_text="decks folder")
        check(banner.count() == 1, "home says the decks folder needs a tap")
        page.screenshot(path=OUT / "91_decks_folder_paused.png")
        banner.get_by_role("button", name="Reconnect").click(); page.wait_for_timeout(1200)
        check(page.locator(".banner", has_text="decks folder").count() == 0 and page.evaluate("localStorage.getItem('test:perm')") == "granted", "Reconnect reads it again")
        ctx.close()

        print("Browsers that can't pick folders")
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
        ctx.add_init_script("delete window.showDirectoryPicker; delete Window.prototype.showDirectoryPicker;")
        page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet h3")
        check(page.locator(".sheet #decks-row").count() == 0, "no decks folder where the browser can't pick folders")
        ctx.close()

        check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; screenshots in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
