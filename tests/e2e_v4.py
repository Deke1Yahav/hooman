"""End-to-end checks for 0.4: new deck from photos, sharing a deck (file, link, QR), Drive links,
and the Google Drive features against a stand-in Google (sign-in, Picker and Drive REST are mocked).

    python tests/e2e_v4.py            # screenshots go to tests/out/
"""
import io
import json
import re
import sys
import zipfile
from urllib.parse import unquote

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright, expect

from e2e import OUT, ROOT, serve, check, failures, import_example, dismiss_tour, count
from e2e_v3 import phone, watch, export

SCHEMA = json.loads((ROOT / "app" / "deck.schema.json").read_text(encoding="utf-8"))


def schema_ok(deck):
    import jsonschema
    try:
        jsonschema.validate(deck, SCHEMA); return True
    except jsonschema.ValidationError as e:
        print("     schema:", e.message[:200]); return False


def photo(w, h, fmt, seed):
    r = np.random.default_rng(seed)
    a = (r.random((h, w, 3)) * 255).astype(np.uint8)
    b = io.BytesIO(); Image.fromarray(a).save(b, fmt); return b.getvalue()


GIS = """window.google = window.google || {}; window.google.accounts = { oauth2: { initTokenClient(cfg) {
  return { requestAccessToken() { window.__signins = (window.__signins || 0) + 1; setTimeout(() => cfg.callback({ access_token: "tok", expires_in: 3600 }), 5); } }; } } };"""
GAPI = """window.gapi = { load(name, cb) {
  const chain = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : () => chain(t)) });
  const P = { ViewId: { DOCS: "docs", FOLDERS: "folders" }, Action: { PICKED: "picked", CANCEL: "cancel" }, Feature: { MULTISELECT_ENABLED: "multi" } };
  P.DocsView = function () { return chain({ setParent(p) { window.__pickParent = p; return this; } }); };
  P.PickerBuilder = function () { let cb; const b = chain({ setCallback(f) { cb = f; return b; },
    build() { return { setVisible() { setTimeout(() => cb(window.__pickDocs && window.__pickDocs.length ? { action: "picked", docs: window.__pickDocs } : { action: "cancel" }), 5); } }; } }); return b; };
  window.google = window.google || {}; window.google.picker = P; cb(); } };"""


class FakeDrive:
    """Drive REST stand-in: files by id; resumable uploads; permissions."""
    def __init__(self):
        self.files, self.n, self.sessions, self.uploads, self.public = {}, 0, {}, [], set()

    def add(self, fid, name, data):
        self.files[fid] = {"name": name, "data": data}

    def handle(self, route):
        req, url = route.request, route.request.url
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, x-upload-content-type",
                "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, OPTIONS", "Access-Control-Expose-Headers": "Location"}
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        m = re.search(r"/upload/drive/v3/files(?:/([^?]+))?\?uploadType=resumable", url)
        if m:
            meta = json.loads(req.post_data or "{}")
            fid = m.group(1) or f"1Fake{self.n + 1:024d}"            # Drive-like id (long)
            if not m.group(1): self.n += 1
            sid = f"https://upload.example/session/{fid}"
            self.sessions[sid] = {"id": fid, "name": meta.get("name") or self.files.get(fid, {}).get("name"), "parents": meta.get("parents")}
            return route.fulfill(status=200, headers={**cors, "Location": sid}, body="")
        if url.startswith("https://upload.example/session/"):
            s = self.sessions[url]
            self.add(s["id"], s["name"], req.post_data_buffer)
            self.uploads.append(s)
            return route.fulfill(status=200, headers={**cors, "Content-Type": "application/json"}, body=json.dumps({"id": s["id"], "name": s["name"]}))
        m = re.search(r"/drive/v3/files/([^/?]+)/permissions", url)
        if m:
            self.public.add(m.group(1))
            return route.fulfill(status=200, headers={**cors, "Content-Type": "application/json"}, body="{}")
        m = re.search(r"/drive/v3/files/([^/?]+)\?(.*)", url)
        if m:
            fid, q = m.group(1), m.group(2)
            f = self.files.get(fid)
            keyed = "key=" in q and "authorization" not in {k.lower() for k in req.headers}
            if not f or (keyed and fid not in self.public and not fid.startswith("pub")):
                return route.fulfill(status=404, headers=cors, body="{}")
            if "alt=media" in q:
                return route.fulfill(status=200, headers={**cors, "Content-Type": "application/zip"}, body=f["data"])
            return route.fulfill(status=200, headers={**cors, "Content-Type": "application/json"}, body=json.dumps({"name": f["name"]}))
        return route.fulfill(status=404, headers=cors, body="")


def google_context(browser, fake, **kw):
    ctx = phone(browser, **kw)
    ctx.route("**/js/config.js", lambda r: r.fulfill(status=200, content_type="text/javascript",
              body='export const GOOGLE = { clientId: "test-client", apiKey: "test-key", appId: "123" };\nexport const googleReady = () => true;\n'))
    ctx.route("https://accounts.google.com/gsi/client", lambda r: r.fulfill(status=200, content_type="text/javascript", body=GIS))
    ctx.route("https://apis.google.com/js/api.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=GAPI))
    ctx.route("https://www.googleapis.com/**", fake.handle)
    ctx.route("https://upload.example/**", fake.handle)
    return ctx


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = phone(browser); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")

        print("new deck from photos")
        (OUT / "big.jpg").write_bytes(photo(3000, 2000, "JPEG", 1))
        (OUT / "small.png").write_bytes(photo(300, 200, "PNG", 2))
        (OUT / "mid.webp").write_bytes(photo(800, 800, "WEBP", 3))
        page.get_by_role("button", name="📷 New deck from photos").click()
        page.locator("#ph-files").set_input_files([str(OUT / "big.jpg"), str(OUT / "small.png"), str(OUT / "mid.webp")])
        check(page.locator("#ph-count").inner_text() == "3 photos", "three photos picked")
        page.locator("#ph-title").fill("Lab photos"); page.locator("#ph-q").fill("Is the sample clean?")
        page.locator("#ph-r").fill("Clean"); page.locator("#ph-l").fill("Dirty")
        page.screenshot(path=OUT / "40_photos_sheet.png")
        page.get_by_role("button", name="Make the deck").click()
        expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=20000)
        page.get_by_role("button", name="Open the deck").click(); page.wait_for_selector(".card canvas"); page.wait_for_timeout(300); dismiss_tour(page)
        check(count(page) == "0 / 3" and page.locator(".ans", has_text="Clean").count() == 1, "the deck has 3 cards and the typed answers")
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(420)

        print("share this deck as a file")
        page.locator("[data-act=menu]").click(); page.locator(".sheet [data-m=share]").click()
        with page.expect_download() as dl:
            page.get_by_role("button", name="Send as a file").click()
        z1 = OUT / "photos.hooman.zip"; dl.value.save_as(z1)
        page.keyboard.press("Escape")
        with zipfile.ZipFile(z1) as z:
            dj = json.loads(z.read("deck.json"))
            big = next(n for n in z.namelist() if "big" in n)
            bw = Image.open(io.BytesIO(z.read(big))).size
        check(schema_ok(dj) and len(dj["cards"]) == 3 and dj["question"] == "Is the sample clean?", "the shared deck.json follows the schema")
        check(max(bw) == 2048, f"a 3000 px photo is shrunk to 2048 px ({bw})")

        print("shared decks re-import and follow the schema")
        for title, key in [("Model A vs model B", "example-duel"), ("Follow the cells", "example-follow"), ("Mask the fruit", "example-fruit"), ("Follow a track", "example-timelapse")]:
            page.goto(base + "#/"); page.wait_for_selector(".hero")
            page.get_by_role("button", name="Try an example").click()
            page.locator(".example", has_text=title).click()
            expect(page.locator(".sheet h3")).to_contain_text(re.compile("Ready|already here"), timeout=20000)
            page.keyboard.press("Escape")
            page.goto(base + f"#/deck/{key}"); page.wait_for_timeout(700); dismiss_tour(page)
            for sel in [".editor [data-e=cancel]", ".tapper [data-t=cancel]"]:
                if page.locator(sel).count(): page.locator(sel).click(); page.wait_for_timeout(200)
            page.locator("[data-act=menu]").click(); page.locator(".sheet [data-m=share]").click()
            with page.expect_download() as dl:
                page.get_by_role("button", name="Send as a file").click()
            zp = OUT / f"{key}.shared.zip"; dl.value.save_as(zp)
            page.keyboard.press("Escape")
            with zipfile.ZipFile(zp) as z, zipfile.ZipFile(ROOT / "app" / "examples" / f"{key.split('-')[1]}.hooman.zip") as orig:
                dj, oj = json.loads(z.read("deck.json")), json.loads(orig.read("deck.json"))
                same_files = sorted(n for n in z.namelist() if n != "deck.json") == sorted(n for n in orig.namelist() if n != "deck.json")
            check(schema_ok(dj) and same_files and len(dj["cards"]) == len(oj["cards"]), f"{key}: shared deck matches the original ({len(dj['cards'])} cards, files {'same' if same_files else 'DIFFERENT'})")
        ctx2 = phone(browser); p2 = ctx2.new_page(); watch(p2, errors)
        p2.goto(base); p2.wait_for_selector(".hero")
        p2.locator("#file").set_input_files(str(OUT / "example-duel.shared.zip"))
        expect(p2.locator(".sheet h3")).to_contain_text("Ready", timeout=20000)
        p2.get_by_role("button", name="Open the deck").click(); p2.wait_for_selector(".card canvas"); p2.wait_for_timeout(300); dismiss_tour(p2)
        check(p2.locator("#chips .chip").count() == 3, "the re-imported duel deck keeps its guide as a guide (◐ + A + B)")
        ctx2.close()

        print("decks from links: QR code, and Drive links without Google set up")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.get_by_role("button", name="From a link").click()
        page.locator("#link-url").fill(base + "examples/circles.hooman.zip")
        page.locator(".sheet").get_by_role("button", name="Import", exact=True).click()
        expect(page.locator(".sheet h3")).to_contain_text(re.compile("Ready|already here"), timeout=20000)
        if page.locator(".sheet h3", has_text="already here").count():
            page.get_by_role("button", name="Update it, keep the answers").click()
            expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=20000)
        page.get_by_role("button", name="Open the deck").click(); page.wait_for_selector(".card canvas"); dismiss_tour(page)
        page.locator("[data-act=menu]").click(); page.locator(".sheet [data-m=share]").click()
        page.wait_for_selector(".share-link .qr svg")
        link = page.locator(".share-link input").input_value()
        check(link.startswith(base + "?deck=") and unquote(link.split("deck=")[1]) == base + "examples/circles.hooman.zip", "a deck from a link offers that link")
        page.locator(".share-link .qr").screenshot(path=OUT / "41_qr.png")
        import cv2
        decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(cv2.imread(str(OUT / "41_qr.png")))
        check(decoded == link, f"the QR code reads back as the link ({decoded[:60]}…)")
        page.keyboard.press("Escape")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.get_by_role("button", name="From a link").click()
        page.locator("#link-url").fill("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view?usp=sharing")
        page.locator(".sheet").get_by_role("button", name="Import", exact=True).click(); page.wait_for_selector(".errors li")
        check("Google Drive links" in page.locator(".errors").inner_text(), "a Drive link without Google set up explains what to do")
        page.keyboard.press("Escape")
        check(page.locator("[data-act=drive]").count() == 0, "no Drive button until Google is set up")
        ctx.close()

        print("Google Drive (stand-in Google): open, share a link, team folder, compare the team")
        fake = FakeDrive()
        fake.add("deck-circles", "circles.hooman.zip", (ROOT / "app" / "examples" / "circles.hooman.zip").read_bytes())
        g1 = google_context(browser, fake); q = g1.new_page(); watch(q, errors)
        q.goto(base); q.wait_for_selector(".hero")
        check(q.locator("[data-act=drive]").count() == 1, "the Drive button appears once Google is set up")
        q.evaluate("window.__pickDocs = [{ id: 'deck-circles', name: 'circles.hooman.zip' }]")
        q.locator("[data-act=drive]").click()
        expect(q.locator(".sheet h3")).to_contain_text("Ready", timeout=20000)
        q.get_by_role("button", name="Open the deck").click(); q.wait_for_selector(".card canvas"); dismiss_tour(q, "Dekel")
        check(count(q).endswith("/ 12"), "Open from Google Drive imports the picked deck")
        for k in ["ArrowRight", "ArrowRight", "ArrowLeft", "ArrowUp"]:
            q.keyboard.press(k); q.wait_for_timeout(420)
        q.locator("[data-act=menu]").click(); q.locator(".sheet [data-m=share]").click()
        q.get_by_role("button", name="Share a link (Google Drive)").click()
        q.wait_for_selector(".share-link .qr svg", timeout=20000)
        dlink = q.locator(".share-link input").input_value()
        up = fake.uploads[-1]
        check(up["name"] == "example-circles.hooman.zip" and zipfile.ZipFile(io.BytesIO(fake.files[up["id"]]["data"])).read("deck.json"), "the deck zip is uploaded to Drive")
        check(up["id"] in fake.public and "drive.google.com%2Ffile%2Fd%2F" + up["id"] in dlink, "it's shared as 'anyone with the link' and the app link points at it")
        q.screenshot(path=OUT / "42_share_link.png")
        q.keyboard.press("Escape")

        g2 = google_context(browser, fake); r2 = g2.new_page(); watch(r2, errors)
        r2.goto(dlink); r2.wait_for_selector(".sheet h3:has-text('Import a deck from a link?')")
        r2.locator(".sheet").get_by_role("button", name="Import", exact=True).click()
        expect(r2.locator(".sheet h3")).to_contain_text("Ready", timeout=20000)
        check(r2.evaluate("window.__signins || 0") == 0, "opening a shared Drive link needs no Google sign-in")
        r2.get_by_role("button", name="Open the deck").click(); r2.wait_for_selector(".card canvas"); dismiss_tour(r2, "Maya")
        for k in ["ArrowRight", "ArrowLeft", "ArrowLeft", "ArrowUp"]:
            r2.keyboard.press(k); r2.wait_for_timeout(420)
        r2.evaluate("window.__pickDocs = [{ id: 'team-folder', name: 'Lab team' }]")
        r2.locator("[data-act=menu]").click(); r2.locator(".sheet [data-m=team]").click()
        r2.get_by_role("button", name="Choose the folder").click(); r2.wait_for_timeout(500)
        check("Lab team" in r2.locator(".sheet").inner_text(), "the team folder is chosen")
        r2.get_by_role("button", name="Save my answers to the folder").click(); r2.wait_for_timeout(800)
        up = fake.uploads[-1]
        check(up["name"] == "example-circles.Maya.answers.zip" and up["parents"] == ["team-folder"], f"Maya's answers are saved into the team folder ({up['name']})")
        maya_id = up["id"]
        r2.get_by_role("button", name="Save my answers to the folder").click(); r2.wait_for_timeout(800)
        check(fake.uploads[-1]["id"] == maya_id, "saving again updates the same file instead of making a new one")
        g2.close()

        # a third person, made from Maya's file with one answer changed
        with zipfile.ZipFile(io.BytesIO(fake.files[maya_id]["data"])) as z:
            noa = json.loads(z.read("answers.json"))
        noa["annotator"] = "Noa"; noa["answers"][0]["answer"] = "unsure"
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z: z.writestr("answers.json", json.dumps(noa))
        fake.add("noa-answers", "example-circles.Noa.answers.zip", b.getvalue())
        q.goto(base + "#/results/example-circles"); q.wait_for_selector(".r-bars")
        q.evaluate("window.__pickDocs = [{ id: '%s', name: 'example-circles.Maya.answers.zip' }, { id: 'noa-answers', name: 'example-circles.Noa.answers.zip' }]" % maya_id)
        q.get_by_role("button", name="Compare with the team (Google Drive)…").click()
        q.wait_for_selector(".r-table [data-who]", timeout=15000)
        txt = q.locator("#agree").inner_text()
        check("Fleiss" in txt and q.locator(".r-table [data-who]").count() == 2, "the team view shows Fleiss' kappa and one row per teammate")
        q.screenshot(path=OUT / "43_team.png", full_page=True)
        q.locator(".r-table [data-who='0']").click(); q.wait_for_timeout(300)
        check("Maya" in q.locator("#agree").inner_text() and q.locator(".r-diffs .chip").count() >= 1, "tapping a teammate shows the details with them")
        g1.close()

        check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; screenshots in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
