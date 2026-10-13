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
from e2e_v8 import big_deck, UNSAVE

PICK = """if (window.FileSystemHandle) {
  window.showDirectoryPicker = async (o) => {
    if (localStorage.getItem("test:abort")) throw new DOMException("The user aborted a request.", "AbortError");
    return (await navigator.storage.getDirectory()).getDirectoryHandle(o && o.id === "hooman-decks" ? (localStorage.getItem("test:decksdir") || "decks") : "picked", { create: true }); };
  FileSystemHandle.prototype.queryPermission = async function () { return localStorage.getItem("test:perm") || "granted"; };
  FileSystemHandle.prototype.requestPermission = async function () {
    if (localStorage.getItem("test:deny")) return "denied";
    localStorage.setItem("test:perm", "granted"); return "granted"; };
  // A slow Google Drive: test:hang listings never answer (or answer after test:hangms); test:unreadable: that zip's
  // bytes can't be read (Drive lost the file)
  const entries = FileSystemDirectoryHandle.prototype.entries;
  FileSystemDirectoryHandle.prototype.entries = function () {
    const it = entries.call(this), hang = +(localStorage.getItem("test:hang") || 0), ms = +(localStorage.getItem("test:hangms") || 0);
    window.__lists = (window.__lists || 0) + 1;
    if (!hang) return it;
    localStorage.setItem("test:hang", String(hang - 1));
    let first = true;
    return { next() { if (!first) return it.next(); first = false; return ms ? new Promise((r) => setTimeout(r, ms)).then(() => it.next()) : new Promise(() => {}); },
             [Symbol.asyncIterator]() { return this; } };
  };
  const getFile = FileSystemFileHandle.prototype.getFile;
  FileSystemFileHandle.prototype.getFile = async function () {
    const slow = +(localStorage.getItem("test:slowfile") || 0);
    if (slow) await new Promise((r) => setTimeout(r, slow));
    const f = await getFile.call(this);
    if (localStorage.getItem("test:unreadable") !== this.name) return f;
    const bad = () => Promise.reject(new DOMException("The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.", "NotReadableError"));
    return new Proxy(f, { get(t, k) { if (k === "slice") return () => ({ arrayBuffer: bad, text: bad }); if (k === "arrayBuffer" || k === "text") return bad;
                                      const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v; } });
  }; }"""
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


def small_deck(title, n=3, deck_id="folder-a"):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for i in range(n):
            a = np.full((48, 48), 40, np.uint8); a[10:30, 10:30] = 200
            z.writestr(f"img/{i}.png", png(a), compress_type=zipfile.ZIP_STORED)
        z.writestr("deck.json", json.dumps({"hooman": 1, "id": deck_id, "title": title, "question": "Bright square?",
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
        check("took" in t and "folders" in t and "file info" in t and "reading" in t, "and where the time went (folders · file info · reading)")
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

        print("The status table next to the answers")
        page.wait_for_timeout(3500)
        st = page.evaluate(GET, "decks/results/hooman-status.Tester.json")
        st = json.loads(base64.b64decode(st)) if st else {"decks": []}
        row = next((r for r in st["decks"] if r["deck"] == "folder-a"), {})
        check(row.get("answered") == 1 and row.get("state") == "in progress" and row.get("zip") == "folder-a.hooman.zip"
              and row.get("answers_file") == "folder-a.Tester.answers.zip" and row.get("new_since_processed") is None,
              f"hooman-status.Tester.json has the deck's row: zip, answered, state, answers file ({ {k: row.get(k) for k in ('answered', 'state', 'zip')} })")
        csv = page.evaluate(GET, "decks/results/hooman-status.Tester.csv")
        csv = base64.b64decode(csv).decode() if csv else ""
        check(csv.startswith("deck,title,zip,cards,answered,open,state,last_answer_at,answers_file,saved_at,processed_up_to,new_since_processed") and "folder-a" in csv,
              "and the same as a CSV")
        page.evaluate(PUT, ["decks/results/processed.json", b64(json.dumps({"hooman_processed": 1, "files": {
            "folder-a.Tester.answers.zip": {"up_to": "2000-01-01T00:00:00Z", "processed_at": "2000-01-01T00:00:00Z", "by": "test"}}}).encode())])
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(500)
        page.evaluate("import('./js/livesave.js').then((m) => m.settled())"); page.wait_for_timeout(3500)
        st = json.loads(base64.b64decode(page.evaluate(GET, "decks/results/hooman-status.Tester.json")))
        row = next((r for r in st["decks"] if r["deck"] == "folder-a"), {})
        check(row.get("processed_up_to") == "2000-01-01T00:00:00Z" and row.get("new_since_processed") == 2,
              f"the AI's processed.json shows up: processed up to, and 2 answers new since ({row.get('new_since_processed')})")

        print("A changed zip updates its deck, but not under the hooman's hands")
        page.evaluate(PUT, ["decks/folder-a.hooman.zip", b64(small_deck("Folder deck A v2", 4))])
        page.evaluate("import('./js/decksfolder.js').then((m) => m.check({ force: true, openKey: 'folder-a' }))"); page.wait_for_timeout(800)
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        check(page.locator(".deckrow", has_text="Folder deck A v2").count() == 0, "the deck on screen isn't swapped while it's open")
        page.locator("[data-act=checkdecks]").click(); page.wait_for_timeout(1500)
        toast = page.locator("#toast").inner_text()
        row = page.locator(".deckrow", has_text="Folder deck A v2")
        check("Updated (answers kept)" in toast and row.count() == 1 and "2 / 4" in row.inner_text(), f"after leaving it, ↻ updates it and keeps the answers ({row.inner_text() if row.count() else toast!r})")
        page.locator("[data-act=checkdecks]").click(); page.wait_for_timeout(800)
        check("nothing new" in page.locator("#toast").inner_text().lower(), "checking again: nothing new")

        print("A big deck in the folder, interrupted, resumes by itself")
        page.evaluate(PUT, ["decks/folder-big.hooman.zip", b64(zbig)])
        page.locator("[data-act=checkdecks]").click()
        page.locator(".deckrow", has_text="folder-big").wait_for(timeout=60000)
        check(page.locator(".deckrow", has_text="folder-big").count() == 1, "it opens at once (the zip is saved in the background)")
        t0 = time.time()
        while time.time() - t0 < 60 and page.evaluate("localStorage.getItem('hooman:loading:folder-big')") is not None:
            page.wait_for_timeout(300)
        page.evaluate(UNSAVE, "folder-big")      # as if the app had closed before the zip was saved
        page.reload(); page.wait_for_selector(".hero")
        t0 = time.time()
        while time.time() - t0 < 120 and page.evaluate("localStorage.getItem('hooman:loading:folder-big')") is not None:
            page.wait_for_timeout(500)
        done = page.evaluate("localStorage.getItem('hooman:loading:folder-big')") is None
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        check(done and page.locator(".banner", has_text="fully saved").count() == 0, f"after a restart it finishes from the folder without asking ({time.time() - t0:.0f} s)")

        print("A card 0.7 marked broken because its file couldn't be read is finished from the folder")
        page.evaluate("""async () => { const d = await new Promise((res) => { const r = indexedDB.open("hooman"); r.onsuccess = () => res(r.result); });
          const rec = await new Promise((res) => { const q = d.transaction("decks").objectStore("decks").get("folder-big"); q.onsuccess = () => res(q.result); });
          const c = rec.deck.cards[300]; delete c.w; delete c.h;
          c.broken = "The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.";
          await new Promise((res) => { const tx = d.transaction(["decks", "archives"], "readwrite"); tx.objectStore("decks").put(rec); tx.objectStore("archives").delete("folder-big"); tx.oncomplete = res; }); }""")
        page.reload(); page.wait_for_selector(".hero"); page.wait_for_timeout(800)
        page.goto(base + "#/deck/folder-big?card=c300"); page.wait_for_selector(".card-note", timeout=20000)
        note = page.locator(".card-note").inner_text()
        check("can't be shown" not in note and "isn't on the phone yet" in note and page.locator(".card-note [data-act=finishzip]").count() == 1,
              f"not 'can't be shown' any more: the card offers Finish now ({note.splitlines()[0]!r})")
        page.evaluate("window.__lists = 0; localStorage.setItem('test:slowfile', '2500')")
        page.locator(".card-note [data-act=finishzip]").click(); page.wait_for_timeout(600)
        note = page.locator(".card-note").inner_text() if page.locator(".card-note").count() else ""
        check("Getting the rest of the deck" in note and "folder-big.hooman.zip" in note and page.locator(".card-note [data-since]").count() == 1,
              f"Finish now shows what it is doing on the card, with a running timer ({note!r})")
        page.screenshot(path=OUT / "96_finish_now_progress.png")
        page.evaluate("localStorage.removeItem('test:slowfile')")
        page.locator(".cardfoot", has_text="c300").wait_for(timeout=60000)
        check(page.locator(".card canvas").count() == 1 and page.locator(".card-note").count() == 0, "one tap: the deck is saved from the folder and the card shows")
        check(page.evaluate("window.__lists") == 0, f"Finish now asked for that one zip, without listing the folder ({page.evaluate('window.__lists')} listings)")
        page.goto(base + "#/"); page.wait_for_selector(".hero")

        print("The permission lapses: one tap brings it back")
        page.evaluate("localStorage.setItem('test:perm', 'prompt')")
        page.reload(); page.wait_for_selector(".hero"); page.wait_for_timeout(800)
        banner = page.locator(".folder-line.warn", has_text="needs a tap")
        check(banner.count() == 1, "the folder line says the decks folder needs a tap")
        page.screenshot(path=OUT / "91_decks_folder_paused.png")
        banner.click(); page.wait_for_timeout(1200)
        check(page.locator(".folder-line.warn").count() == 0 and page.evaluate("localStorage.getItem('test:perm')") == "granted", "Reconnect reads it again")

        print("Subfolders, newest copy first")
        page.evaluate(PUT, ["decks/projects/older/deep-b.hooman.zip", b64(small_deck("Deck B old", 2, "deep-b"))])
        page.wait_for_timeout(1200)
        page.evaluate(PUT, ["decks/projects/newer/deep-b.hooman.zip", b64(small_deck("Deck B new", 2, "deep-b"))])
        page.evaluate(PUT, ["decks/results/stray.hooman.zip", b64(small_deck("In results", 2, "stray"))])
        page.locator("[data-act=checkdecks]").click(); page.wait_for_timeout(2000)
        check(page.locator(".deckrow", has_text="Deck B new").count() == 1 and page.locator(".deckrow", has_text="Deck B old").count() == 0,
              "a deck in a subfolder shows up, and of two copies the newest is used")
        check(page.locator(".deckrow", has_text="In results").count() == 0, "the results folder isn't searched for decks")

        print("Every outcome of choosing a folder is visible")
        page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet #decks-row")
        page.locator(".sheet [data-decks=off]").click(); page.wait_for_timeout(400)
        page.evaluate("localStorage.setItem('test:abort', '1')")
        page.locator(".sheet [data-decks=on]").click(); page.wait_for_timeout(600)
        check("No folder was chosen" in page.locator("#toast").inner_text(), "a cancelled picker says no folder was chosen")
        page.evaluate("localStorage.removeItem('test:abort'); localStorage.setItem('test:decksdir', 'answersonly')")
        page.evaluate(PUT, ["answersonly/x.Dekel.answers.zip", b64(answers_zip())])
        page.locator(".sheet [data-decks=on]").click(); page.wait_for_timeout(1500)
        toast = page.locator("#toast").inner_text()
        check("no deck zips" in toast and "results, not decks" in toast, f"a folder with only answers files says so ({toast!r})")
        page.evaluate("localStorage.removeItem('test:decksdir')")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)

        print("On a phone, big zips wait for a tap")
        page.evaluate("localStorage.setItem('test:decksdir', 'phone'); localStorage.setItem('hooman:decks.autoMax', '100')")
        page.evaluate(PUT, ["phone/tap-one.hooman.zip", b64(small_deck("Tap one", 2, "tap-one"))])
        page.evaluate(PUT, ["phone/sub/tap-two.hooman.zip", b64(small_deck("Tap two", 2, "tap-two"))])
        page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet #decks-row")
        page.locator(".sheet [data-decks=off]").click(); page.wait_for_timeout(300)
        page.locator(".sheet [data-decks=on]").click(); page.wait_for_timeout(1500)
        page.keyboard.press("Escape"); page.goto(base + "#/"); page.wait_for_selector(".hero")
        clouds = page.locator(".deckrow.cloud")
        check(clouds.count() == 2 and page.locator(".deckrow:not(.cloud)", has_text="Tap one").count() == 0,
              f"the zips are listed at once, nothing downloaded ({clouds.count()} to tap: {[c.inner_text().splitlines()[0] for c in clouds.all()]})")
        page.screenshot(path=OUT / "92_decks_tap_to_load.png")
        clouds.filter(has_text="tap-one").click()
        page.wait_for_selector(".card canvas", timeout=20000)
        check("tap-one" in page.url, "a tap loads that deck and opens it")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        check(page.locator(".deckrow.cloud").count() == 1 and page.locator(".deckrow", has_text="Tap one").count() == 1, "the other one still waits; the loaded one is a deck now")
        print("Deleting a folder deck from the phone keeps it one tap away; a waiting zip can be hidden")
        page.locator(".deckitem", has_text="Tap one").locator("[data-act=rowmenu]").click(); page.wait_for_selector(".sheet .menu")
        page.locator(".sheet [data-r=delete]").click(); page.wait_for_selector(".sheet h3:has-text('Delete')")
        check("stays in" in page.locator(".sheet").inner_text(), "Delete says the zip stays in the folder")
        page.locator(".sheet [data-del]").click(); page.wait_for_timeout(700)
        check(page.locator(".deckrow:not(.cloud)", has_text="Tap one").count() == 0 and page.locator(".deckrow.cloud", has_text="tap-one").count() == 1,
              "the deck left the phone and is back as tap to load")
        page.locator("[data-act=checkdecks]").click(); page.wait_for_timeout(1500)
        check(page.locator(".deckrow.cloud", has_text="tap-one").count() == 1 and page.locator(".deckrow:not(.cloud)", has_text="Tap one").count() == 0,
              "a check doesn't load it back by itself")
        page.locator(".deckitem", has_text="tap-two").locator("[data-act=zipmenu]").click(); page.wait_for_selector(".sheet .menu")
        page.locator(".sheet [data-z=hide]").click(); page.wait_for_timeout(500)
        page.locator("[data-act=checkdecks]").click(); page.wait_for_timeout(1500)
        check(page.locator(".deckrow.cloud", has_text="tap-two").count() == 0, "a hidden zip stays out of the list after a check")
        page.evaluate("localStorage.removeItem('hooman:decks.autoMax'); localStorage.removeItem('test:decksdir')")

        print("After the background, the next tap anywhere reconnects both folders")
        page.evaluate("localStorage.setItem('test:perm', 'prompt')")
        page.reload(); page.wait_for_selector(".hero"); page.wait_for_timeout(1000)
        check(page.locator(".folder-line.warn").count() == 1, "access lapsed: the folder line asks for a tap")
        page.locator(".hero h1").click(); page.wait_for_timeout(1500)
        check(page.evaluate("localStorage.getItem('test:perm')") == "granted" and page.locator(".folder-line.warn").count() == 0,
              "a tap on anything (here the title) asked again: the decks folder is back")
        st = page.evaluate("import('./js/livesave.js').then((m) => m.status().folder.status)")
        check(st in ("ok", "saving"), f"and live save in its results folder with it ({st})")

        print("Reconnect says when the phone refuses")
        page.evaluate("localStorage.setItem('test:perm', 'prompt'); localStorage.setItem('test:deny', '1')")
        page.reload(); page.wait_for_selector(".hero"); page.wait_for_timeout(800)
        page.locator(".folder-line.warn").click(); page.wait_for_timeout(800)
        check("didn't give access" in page.locator("#toast").inner_text(), "a refused permission is said, with what to do")
        page.evaluate("localStorage.removeItem('test:deny')")

        print("A slow Google Drive: asked again once, then 'didn't answer, tap to try again', never a zip to fix")
        page.evaluate("localStorage.setItem('hooman:decks.listMs', '1000'); localStorage.setItem('test:decksdir', 'slow'); localStorage.setItem('test:perm', 'granted')")
        page.evaluate(PUT, ["slow/slow-one.hooman.zip", b64(small_deck("Slow one", 2, "slow-one"))])
        page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet #decks-row")
        page.locator(".sheet [data-decks=off]").click(); page.wait_for_timeout(300)
        page.locator(".sheet [data-decks=on]").click(); page.wait_for_timeout(1500)
        page.keyboard.press("Escape"); page.goto(base + "#/"); page.wait_for_selector(".hero")
        try: page.locator(".deckrow", has_text="Slow one").wait_for(timeout=10000)
        except Exception: pass
        check(page.locator(".deckrow", has_text="Slow one").count() == 1, "the folder's deck is here")
        page.evaluate("window.__lists = 0; localStorage.setItem('test:hang', '1')")
        page.locator("[data-act=checkdecks]").click(); page.wait_for_timeout(2500)
        check(page.evaluate("window.__lists") == 2 and page.locator(".folder-line.warn").count() == 0 and "1 deck" in page.locator(".folder-line").inner_text(),
              f"a listing that stalls is asked for again, and the second answer is used ({page.evaluate('window.__lists')} listings)")
        page.evaluate("localStorage.setItem('test:hang', '2')")
        page.locator("[data-act=checkdecks]").click(); page.wait_for_timeout(400)
        busy = page.locator(".folder-line.busy")
        txt = busy.inner_text() if busy.count() else ""
        check("Asking Google Drive for the files in “slow”" in txt and "asks again after" in txt and busy.locator("[data-since]").count() == 1,
              f"while it waits, the line says what it asks Drive for, with a running timer ({txt!r})")
        page.screenshot(path=OUT / "94_decks_live_step.png")
        page.wait_for_timeout(1100)
        txt = busy.inner_text() if busy.count() else ""
        check("asked again" in txt, f"then that it asked again ({txt!r})")
        page.wait_for_timeout(2000)
        line = page.locator(".folder-line").inner_text()
        check(page.locator(".folder-line.warn").count() == 1 and "didn't answer" in line and "try again" in line, f"then the folder line says Drive didn't answer ({line!r})")
        check(page.locator(".folder-errs").count() == 0 and page.locator(".deckrow", has_text="Slow one").count() == 1,
              "no zip is blamed ('couldn't be opened' isn't offered), the decks on the phone stay")
        check("Google Drive may be slow" in page.locator("#toast").inner_text(), "Check now says why")
        page.screenshot(path=OUT / "93_decks_drive_slow.png")
        page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet #decks-row")
        check("couldn't read it" in page.locator(".sheet #decks-row").inner_text(), "Settings says the folder couldn't be read, and why")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        page.locator(".folder-log").click(); page.wait_for_selector(".sheet .activity")
        log = page.locator(".sheet .activity").inner_text()
        check("Check: you tapped Check" in log and "didn't answer in" in log and "asking again" in log and "Couldn't finish" in log,
              "What happened lists each step, newest first, with times")
        page.wait_for_timeout(500); page.screenshot(path=OUT / "95_decks_what_happened.png")
        page.locator(".sheet [data-l=close]").click(); page.wait_for_timeout(300)
        page.locator(".folder-line.warn").click(); page.wait_for_timeout(1500)
        check(page.locator(".folder-line.warn").count() == 0 and "1 deck" in page.locator(".folder-line").inner_text(), "a tap tries again, and it's back")

        print("Time in the background isn't counted against Drive")
        page.evaluate("""() => { window.__vis = 'visible';
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__vis });
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__vis === 'hidden' }); }""")
        page.evaluate("window.__lists = 0; localStorage.setItem('test:hang', '1'); localStorage.setItem('test:hangms', '2500')")
        page.evaluate("""import('./js/decksfolder.js').then((m) => { window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
          m.check({ force: true, fresh: true }); })""")
        page.wait_for_timeout(3000)
        page.evaluate("window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange'))")
        page.wait_for_timeout(1200)
        check(page.evaluate("window.__lists") == 1 and page.locator(".folder-line.warn").count() == 0,
              f"a listing that answered while the app was in the background isn't a timeout ({page.evaluate('window.__lists')} listings)")
        page.evaluate("delete document.visibilityState; delete document.hidden; localStorage.removeItem('test:hangms')")

        print("A zip Drive can't hand over isn't 'a deck to fix', and is read again next time")
        page.evaluate(PUT, ["slow/unread-me.hooman.zip", b64(small_deck("Unread me", 2, "unread-me"))])
        page.evaluate("localStorage.setItem('test:unreadable', 'unread-me.hooman.zip')")
        page.locator("[data-act=checkdecks]").click(); page.wait_for_timeout(2000)
        check(page.locator(".folder-line.warn").count() == 1 and page.locator(".folder-errs").count() == 0, "the line asks to try again; no zip is called broken")
        page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet #decks-row")
        check("unread-me" in page.locator(".sheet #decks-row").inner_text(), "Settings names the zip that couldn't be read")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        page.evaluate("localStorage.removeItem('test:unreadable')")
        page.locator(".folder-line.warn").click(); page.wait_for_timeout(2000)
        check(page.locator(".deckrow", has_text="Unread me").count() == 1 and page.locator(".folder-line.warn").count() == 0, "next time it's read, and the deck is here")
        page.evaluate("localStorage.removeItem('hooman:decks.listMs'); localStorage.removeItem('test:decksdir')")
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
