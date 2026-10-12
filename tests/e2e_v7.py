"""End-to-end checks for 0.5's live save: each deck's answers copied to a folder on this device and/or Google Drive
a few seconds after every answer; merging what another device wrote; pausing and reconnecting; the deck header mark.

    python tests/e2e_v7.py            # screenshots go to tests/out/

The folder is the browser's private file system standing in for a picked folder (the real picker needs a person),
and Google is the stand-in from e2e_v4 with file versions and folders added. Restarting with a remembered folder runs in
the installed Google Chrome: Playwright's own Chromium (like Edge 153) kills private sessions that read a stored folder
back. The crash guard (a start that never finished that read) is checked by planting its mark.
"""
import base64
import io
import json
import re
import sys
import zipfile

from playwright.sync_api import sync_playwright

from e2e import OUT, serve, check, failures, import_example
from e2e_v3 import phone, watch
from e2e_v4 import FakeDrive, google_context

NAME = "example-circles.Tester.answers.zip"
PICK = """if (window.FileSystemHandle) {
  window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("picked", { create: true });
  FileSystemHandle.prototype.queryPermission = async function () { return localStorage.getItem("test:perm") || "granted"; };
  FileSystemHandle.prototype.requestPermission = async function () { localStorage.setItem("test:perm", "granted"); return "granted"; }; }"""
NO_FOLDER = "delete window.showDirectoryPicker; delete Window.prototype.showDirectoryPicker;"
OPFS_READ = """async (name) => { try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked");
  const b = new Uint8Array(await (await (await d.getFileHandle(name)).getFile()).arrayBuffer());
  let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); } catch (e) { return null; } }"""
OPFS_WRITE = """async ([name, b64]) => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked");
  const bin = atob(b64), b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  const w = await (await d.getFileHandle(name, { create: true })).createWritable(); await w.write(b); await w.close(); }"""


class FakeDrive2(FakeDrive):
    """FakeDrive plus what live save needs: a version per file, metadata with it, and folders."""
    def __init__(self):
        super().__init__()
        self.versions, self.folders = {}, {}

    def add(self, fid, name, data):
        super().add(fid, name, data)
        self.versions[fid] = self.versions.get(fid, 0) + 1

    def handle(self, route):
        req, url = route.request, route.request.url
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, x-upload-content-type",
                "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, OPTIONS", "Access-Control-Expose-Headers": "Location"}
        js = {**cors, "Content-Type": "application/json"}
        if req.method == "POST" and re.search(r"googleapis\.com/drive/v3/files\?", url):
            meta = json.loads(req.post_data or "{}")
            fid = f"fold{len(self.folders) + 1}"
            self.folders[fid] = meta.get("name")
            return route.fulfill(status=200, headers=js, body=json.dumps({"id": fid, "name": meta.get("name")}))
        m = re.search(r"/drive/v3/files/([^/?]+)\?(.*)", url)
        if req.method == "GET" and m and "alt=media" not in m.group(2) and "version" in m.group(2):
            fid = m.group(1)
            if fid in self.folders:
                return route.fulfill(status=200, headers=js, body=json.dumps({"id": fid, "name": self.folders[fid]}))
            if fid in self.files:
                return route.fulfill(status=200, headers=js, body=json.dumps({"id": fid, "name": self.files[fid]["name"], "version": str(self.versions[fid])}))
            return route.fulfill(status=404, headers=cors, body="{}")
        return super().handle(route)

    def live_files(self):
        return {fid: f for fid, f in self.files.items() if f["name"] == NAME}


def answers_in(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return json.loads(z.read("answers.json"))


def with_extra_answer(data):
    """The same export as if another device had answered the deck's last open card."""
    d = answers_in(data)
    card = d["unanswered"][-1]
    d["answers"].append({"card": card, "answer": "no", "label": "No", "at": "2099-01-01T00:00:00.000Z", "ms": 900, "changes": 0, "by": "Tester"})
    d["unanswered"] = d["unanswered"][:-1]
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in zin.namelist():
            zout.writestr(n, json.dumps(d) if n == "answers.json" else zin.read(n))
    return out.getvalue(), card


def settle(page):
    page.evaluate("import('./js/livesave.js').then((m) => m.settled())")


def swipe(page, n=1):
    for _ in range(n):
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(450)


def mark(page):
    m = page.locator("#live-mark")
    return None if m.get_attribute("hidden") is not None else m.inner_text()


def open_settings_row(page, target):
    page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet #live-rows")
    return page.locator(f".sheet .live-row[data-row={target}]")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            real = p.chromium.launch(channel="chrome")
        except Exception:
            real = None
            print("  note: Google Chrome isn't installed; the restart checks for the folder are skipped")

        print("A folder on this device" + (f" (Chrome {real.version})" if real else ""))
        ctx = (real or browser).new_context(viewport={"width": 1280, "height": 800}, service_workers="block"); ctx.add_init_script(PICK)
        page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        row = open_settings_row(page, "folder")
        check("Choose a folder" in row.inner_text() and "OneDrive" in row.inner_text(), "Settings offers a folder, and says a synced folder works")
        row.get_by_role("button", name="Choose a folder").click(); page.wait_for_timeout(600)
        row = page.locator(".sheet .live-row[data-row=folder]")
        check("picked" in row.inner_text() and row.get_by_role("button", name="Turn off").count() == 1, f"the folder is on ({row.inner_text()!r})")
        page.screenshot(path=OUT / "70_live_settings.png")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        import_example(page, "Is it a circle?")
        check(mark(page) is not None, f"the deck header shows the live save mark ({mark(page)})")
        swipe(page, 2); settle(page)
        b64 = page.evaluate(OPFS_READ, NAME)
        d = answers_in(base64.b64decode(b64)) if b64 else {"answers": []}
        check(len(d["answers"]) == 2 and d.get("annotator") == "Tester", f"2 answers are in the folder as {NAME} ({len(d['answers'])})")
        check(mark(page) == "☁✓", f"the mark says saved ({mark(page)})")
        page.screenshot(path=OUT / "71_live_mark.png")

        print("Another device changed the file")
        data, card = with_extra_answer(base64.b64decode(b64))
        page.evaluate(OPFS_WRITE, [NAME, base64.b64encode(data).decode()])
        page.wait_for_timeout(50)
        swipe(page); settle(page)
        d = answers_in(base64.b64decode(page.evaluate(OPFS_READ, NAME)))
        cards = {a["card"] for a in d["answers"]}
        check(len(d["answers"]) == 4 and card in cards, f"its answer was merged in, then all 4 written ({len(d['answers'])})")
        check(page.locator("#count").inner_text().startswith("4 /"), f"the open deck counts the merged answer ({page.locator('#count').inner_text()})")

        print("Permission runs out, then a tap reconnects")
        if real:
            page.evaluate("localStorage.setItem('test:perm', 'prompt')")
            page.reload(); page.wait_for_selector(".card canvas"); page.wait_for_timeout(800)
            check(mark(page) == "☁!", f"after a restart without permission the mark asks for a tap ({mark(page)})")
            swipe(page); page.wait_for_timeout(4800); settle(page)
            n_before = len(answers_in(base64.b64decode(page.evaluate(OPFS_READ, NAME)))["answers"])
            check(n_before == 4, f"nothing is written while paused ({n_before})")
            page.locator("#live-mark").click(); page.wait_for_timeout(300); settle(page)
            n_after = len(answers_in(base64.b64decode(page.evaluate(OPFS_READ, NAME)))["answers"])
            check(n_after == 5 and mark(page) == "☁✓", f"the tap reconnects and the waiting answer is written ({n_after}, {mark(page)})")
            page.locator("#live-mark").click(); page.wait_for_timeout(200)
            check("picked" in page.locator("#toast").inner_text(), f"tapping the mark tells where it saves ({page.locator('#toast').inner_text()!r})")

        print("Home: no 'only on this device' warning for live-saved answers")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        check(page.locator(".banner", has_text="only on this device").count() == 0, "live-saved answers don't count as unsaved")

        print("The Drive guide points to live save")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.locator(".foot-note [data-guide]").click(); page.wait_for_selector(".sheet h3")
        g = page.locator(".sheet").inner_text().lower()
        check("save automatically" in g and "live save" in g and "syncs" in g, "the guide's \"Save automatically\" section names live save and synced folders")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)

        print("Turning it off")
        row = open_settings_row(page, "folder")
        row.get_by_role("button", name="Turn off").click(); page.wait_for_timeout(300)
        check("Choose a folder" in page.locator(".sheet .live-row[data-row=folder]").inner_text(), "Turn off goes back to Choose a folder")
        ctx.close()

        print("A start that never finished reading the folder back (the crash guard)")
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, service_workers="block"); ctx.add_init_script(PICK)
        page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        open_settings_row(page, "folder").get_by_role("button", name="Choose a folder").click(); page.wait_for_timeout(400)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        import_example(page, "Is it a circle?"); swipe(page); settle(page)
        page.evaluate("""() => new Promise((res) => { const r = indexedDB.open("hooman-handles", 1);
          r.onsuccess = () => { const tx = r.result.transaction("h", "readwrite"); tx.objectStore("h").put(true, "reading"); tx.oncomplete = res; }; })""")
        page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero", timeout=15000)
        row = open_settings_row(page, "folder")
        check("can't remember the folder" in row.inner_text() and row.get_by_role("button", name="Reconnect").count() == 1,
              f"the next start doesn't read the folder again, and asks for it ({row.inner_text()!r})")
        row.get_by_role("button", name="Reconnect").click(); page.wait_for_timeout(500)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        page.goto(base + "#/deck/example-circles"); page.wait_for_selector(".card canvas"); page.wait_for_timeout(500)
        swipe(page); settle(page)
        b64 = page.evaluate(OPFS_READ, NAME)
        d = answers_in(base64.b64decode(b64)) if b64 else {"answers": []}
        check(len(d["answers"]) == 2 and mark(page) == "☁✓", f"once chosen again it saves for the rest of the session ({len(d['answers'])}, {mark(page)})")
        page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero", timeout=15000)
        check("can't remember" in open_settings_row(page, "folder").inner_text(), "later starts on that browser version don't try again")
        ctx.close()

        print("Google Drive")
        fake = FakeDrive2()
        ctx = google_context(browser, fake); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        row = open_settings_row(page, "drive")
        check("Hooman in the Loop" in row.inner_text(), "the Drive row says where it saves")
        row.get_by_role("button", name="Turn on").click(); page.wait_for_timeout(500)
        check(page.evaluate("window.__signins") == 1, "Turn on signs in to Google (inside the tap)")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        import_example(page, "Is it a circle?")
        swipe(page, 2); settle(page)
        files = fake.live_files()
        fid = next(iter(files), None)
        parents = next((u["parents"] for u in fake.uploads if u["id"] == fid), None)
        check(len(files) == 1 and "Hooman in the Loop" in fake.folders.values() and parents == [k for k, v in fake.folders.items() if v == "Hooman in the Loop"],
              f"the answers file is in a new \"Hooman in the Loop\" Drive folder ({list(fake.folders.values())}, parents {parents})")
        check(fid and len(answers_in(files[fid]["data"])["answers"]) == 2, "with both answers")
        swipe(page); settle(page)
        check(len(fake.live_files()) == 1 and fake.versions.get(fid) == 2 and len(answers_in(fake.files[fid]["data"])["answers"]) == 3,
              f"the next answer updates the same file, no copies ({len(fake.live_files())} file, version {fake.versions.get(fid)})")

        print("Drive: another device changed the file")
        data, card = with_extra_answer(fake.files[fid]["data"])
        fake.add(fid, NAME, data)
        swipe(page); settle(page)
        d = answers_in(fake.files[fid]["data"])
        check(len(d["answers"]) == 5 and card in {a["card"] for a in d["answers"]}, f"merged first, then written: 5 answers ({len(d['answers'])})")

        print("Drive: the sign-in runs out")
        page.evaluate("localStorage.setItem('hooman:gtoken', JSON.stringify({ t: 'tok', exp: Date.now() - 1000 }))")
        page.reload(); page.wait_for_selector(".card canvas"); page.wait_for_timeout(800)
        check(mark(page) == "☁!", f"after the hour the mark asks for a tap ({mark(page)})")
        v = fake.versions[fid]
        swipe(page); page.wait_for_timeout(4800); settle(page)
        check(fake.versions[fid] == v, "nothing is uploaded while paused (no surprise sign-in popups)")
        signins = page.evaluate("window.__signins || 0")
        page.locator("#live-mark").click(); page.wait_for_timeout(400); settle(page)
        check(page.evaluate("window.__signins || 0") == signins + 1 and fake.versions[fid] == v + 1 and mark(page) == "☁✓",
              f"the tap signs in again and uploads the waiting answer (version {fake.versions[fid]}, {mark(page)})")
        page.reload(); page.wait_for_selector(".card canvas"); page.wait_for_timeout(800)
        check(mark(page) == "☁✓", f"reopening the app within the hour needs no tap ({mark(page)})")

        print("Drive: a deck with a team folder saves there")
        page.evaluate("window.__pickDocs = [{ id: 'team1', name: 'Team', mimeType: 'application/vnd.google-apps.folder' }]")
        page.locator("[data-act=menu]").click(); page.locator(".sheet [data-m=team]").click()
        page.locator(".sheet [data-t=choose]").click(); page.wait_for_timeout(600)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        swipe(page); settle(page)
        team = [u for u in fake.uploads if u["parents"] == ["team1"] and u["name"] == NAME]
        check(len(team) == 1, f"the next save goes to the team folder, where Results finds it ({len(team)})")
        ctx.close()

        print("Browsers without either")
        ctx = phone(browser, user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
        ctx.add_init_script(NO_FOLDER); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet #live-rows")
        t = page.locator(".sheet #live-rows").inner_text()
        check("can't keep a live copy" in t and "iPhone" in t and page.locator(".sheet #live-rows [data-guide]").count() == 1,
              "iPhone Safari is told plainly, and pointed to Back up and the Drive guide")
        ctx.close()

        print("Layout")
        for w, h in [(360, 640), (390, 844)]:
            ctx = browser.new_context(viewport={"width": w, "height": h}, is_mobile=True, has_touch=True, service_workers="block"); ctx.add_init_script(PICK)
            page = ctx.new_page(); watch(page, errors); page.goto(base); page.wait_for_selector(".hero")
            open_settings_row(page, "folder").get_by_role("button", name="Choose a folder").click(); page.wait_for_timeout(400)
            page.keyboard.press("Escape"); page.wait_for_timeout(300)
            import_example(page, "Model A vs model B"); page.wait_for_timeout(300)
            fits = page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            top = page.locator(".deckscreen .top").bounding_box(); mk = page.locator("#live-mark").bounding_box()
            check(fits and mk and mk["x"] + mk["width"] <= top["x"] + top["width"] + 1, f"{w}x{h}: the mark fits in the header, no sideways scroll")
            page.screenshot(path=OUT / f"72_live_{w}x{h}.png")
            ctx.close()

        check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
        if real:
            real.close()
    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; screenshots in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
