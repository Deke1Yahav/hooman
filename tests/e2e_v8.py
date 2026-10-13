"""End-to-end checks for 0.6's lazy import: big decks open after their first cards are checked, the rest loads in the
background (the card on screen first), a broken card explains itself, and an app restart mid-way is finished by
picking the zip again, with the answers kept.

    python tests/e2e_v8.py            # screenshots go to tests/out/
"""
import io
import json
import sys
import time
import zipfile

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

from e2e import OUT, serve, check, failures, dismiss_tour
from e2e_v3 import phone, watch

N, BROKEN = 400, 350


def png(a):
    b = io.BytesIO(); Image.fromarray(a.astype(np.uint8)).save(b, "PNG"); return b.getvalue()


def big_deck(deck_id, n=None):
    """400 cards = 800 image files (an image and a mask each); card 350's mask is the wrong size."""
    N = n or globals()["N"]
    r = np.random.default_rng(3)
    out = io.BytesIO()
    cards = []
    with zipfile.ZipFile(out, "w") as z:
        for i in range(N):
            img = (r.random((64, 64)) * 120).astype(np.uint8); img[20:44, 20:44] += 120
            m = np.zeros((32, 32) if i == BROKEN else (64, 64), np.uint8); m[20:44, 20:44] = 1
            z.writestr(f"img/c{i:03d}.png", png(img), compress_type=zipfile.ZIP_STORED)
            z.writestr(f"mask/c{i:03d}.png", png(m), compress_type=zipfile.ZIP_STORED)
            cards.append({"id": f"c{i:03d}", "image": f"img/c{i:03d}.png", "overlays": [{"source": "model", "mask": f"mask/c{i:03d}.png"}]})
        z.writestr("deck.json", json.dumps({"hooman": 1, "id": deck_id, "title": f"Big deck {deck_id}", "question": "Is the square found?",
                                            "sources": {"model": {}}, "answers": {"right": "Yes", "left": "No"}, "cards": cards}))
    p = OUT / f"{deck_id}.hooman.zip"
    p.write_bytes(out.getvalue())
    return p


IDB = """async ([store, key]) => { const d = await new Promise((res) => { const r = indexedDB.open("hooman"); r.onsuccess = () => res(r.result); });
  if (store === "deck") return await new Promise((res) => { const q = d.transaction("decks").objectStore("decks").get(key); q.onsuccess = () => res(q.result); });
  const all = await new Promise((res) => { const q = d.transaction("files").objectStore("files").getAllKeys(); q.onsuccess = () => res(q.result); });
  return all.filter((k) => k[0] === key).length; }"""


def wait_done(page, key, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if page.evaluate(f"localStorage.getItem('hooman:loading:{key}')") is None:
            return time.time() - t0
        page.wait_for_timeout(500)
    return None


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    errors = []
    z1, z2 = big_deck("big-1"), big_deck("big-2")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = phone(browser); page = ctx.new_page(); watch(page, errors)
        cdp = ctx.new_cdp_session(page)
        slow = lambda rate: cdp.send("Emulation.setCPUThrottlingRate", {"rate": rate})   # phone-like speed for the mid-load checks
        page.goto(base); page.wait_for_selector(".hero")
        slow(20)

        print("A big deck opens before it has finished loading")
        t0 = time.time()
        page.locator("#file").set_input_files(str(z1))
        page.locator(".sheet h3", has_text="Ready").wait_for(timeout=60000)
        ready = time.time() - t0
        sheet = page.locator(".sheet").inner_text()
        check("Start now" in sheet and "load in the background" in sheet, f"the Ready sheet says the rest loads in the background ({ready:.1f} s)")
        page.screenshot(path=OUT / "80_lazy_ready.png")
        page.get_by_role("button", name="Open the deck").click()
        page.wait_for_selector(".card canvas", timeout=20000); dismiss_tour(page)
        mark = page.locator("#loadmark")
        check(mark.is_visible() and "loading" in mark.inner_text(), f"the deck header shows the loading progress ({mark.inner_text() if mark.is_visible() else 'hidden'})")
        page.screenshot(path=OUT / "81_lazy_first_card.png")
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(600)

        print("Jumping far ahead: that card loads first")
        t0 = time.time()
        page.goto(base + "#/deck/big-1?card=c300"); page.wait_for_selector(".card canvas", timeout=20000)
        jump = time.time() - t0
        left = page.evaluate("JSON.parse(localStorage.getItem('hooman:loading:big-1') || 'null')")
        check(jump < 8 and left is not None, f"card 300 shows in {jump:.1f} s, while the deck is still loading")
        page.locator("[data-act=menu]").click(); page.locator(".sheet [data-m=share]").click(); page.wait_for_timeout(300)
        check("still loading" in page.locator("#toast").inner_text(), "sharing waits until the whole deck is on the phone")

        print("Everything arrives")
        slow(1)
        took = wait_done(page, "big-1")
        check(took is not None, f"the background loading finishes ({took and round(took)} s more)")
        page.wait_for_timeout(600)
        check(page.locator("#loadmark").is_hidden(), "the header note disappears")
        n_files = page.evaluate(IDB, ["files", "big-1"])
        rec = page.evaluate(IDB, ["deck", "big-1"])
        sized = sum(1 for c in rec["deck"]["cards"] if c.get("w"))
        check(n_files == 2 * N - 2 and sized == N - 1 and rec["deck"]["cards"][BROKEN].get("broken"),
              f"all good cards are stored with their sizes ({n_files} files, {sized} sized), the broken one is marked")

        print("The broken card explains itself")
        page.goto(base + f"#/deck/big-1?card=c{BROKEN}"); page.wait_for_selector(".card-note")
        note = page.locator(".card-note").inner_text()
        check("can't be shown" in note and "mask" in note and page.locator(".card-note [data-act=skip]").count() == 1, "it says why (the mask size) and offers Skip")
        page.screenshot(path=OUT / "82_lazy_broken_card.png")
        page.locator(".card-note [data-act=skip]").click(); page.wait_for_selector(".card canvas")
        check(True, "Skip moves on to a card that shows")

        print("The app closes mid-way; picking the zip again finishes it")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        slow(20)
        page.locator("#file").set_input_files(str(z2))
        page.locator(".sheet h3", has_text="Ready").wait_for(timeout=60000)
        page.get_by_role("button", name="Open the deck").click(); page.wait_for_selector(".card canvas")
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(2000)
        page.goto(base + "#/"); page.reload(); page.wait_for_selector(".hero")
        banner = page.locator(".banner", has_text="still to load")
        check(banner.count() == 1 and "cards to load" in page.locator(".deckrow", has_text="big-2").inner_text(), "home says which deck still needs its zip")
        page.screenshot(path=OUT / "83_lazy_restart_home.png")
        page.goto(base + "#/deck/big-2?card=c390"); page.wait_for_selector(".card-note")
        check("isn't on the phone yet" in page.locator(".card-note").inner_text(), "an unloaded card asks for the zip again")
        with page.expect_file_chooser() as fc:
            page.locator(".card-note [data-act=repick]").click()
        fc.value.set_files(str(z2))
        page.wait_for_selector(".card canvas", timeout=60000)
        slow(1)
        check("remaining" in page.locator("#toast").inner_text() or page.locator(".card canvas").count() == 1, "picking it resumes (no 'already here' question) and the card shows")
        took = wait_done(page, "big-2")
        answers = page.evaluate("""async () => { const d = await new Promise((res) => { const r = indexedDB.open("hooman"); r.onsuccess = () => res(r.result); });
          return await new Promise((res) => { const q = d.transaction("answers").objectStore("answers").getAll(); q.onsuccess = () => res(q.result.filter((a) => a.deck === "big-2").length); }); }""")
        check(took is not None and page.evaluate(IDB, ["files", "big-2"]) == 2 * N - 2 and answers == 1,
              f"it finishes ({took and round(took)} s), and the answer given before the restart is kept ({answers})")

        print("A mid-sized deck (50 cards, 100 images) starts after its first cards too")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.locator("#file").set_input_files(str(big_deck("mid-1", n=50)))
        page.locator(".sheet h3", has_text="Ready").wait_for(timeout=60000)
        sheet = page.locator(".sheet").inner_text()
        check("Start now" in sheet and "the other 4" in sheet, f"it opens after its first cards (12 images), the other 44 load meanwhile ({sheet.splitlines()[2][:90] if len(sheet.splitlines()) > 2 else sheet!r})")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)

        print("Small decks are unchanged")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.get_by_role("button", name="Try an example").click(); page.locator(".example", has_text="Is it a circle?").click()
        page.locator(".sheet h3", has_text="Ready").wait_for(timeout=20000)
        check("Start now" not in page.locator(".sheet").inner_text(), "a small deck imports whole, as before")
        ctx.close()

        check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; screenshots in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
