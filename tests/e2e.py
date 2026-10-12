"""End-to-end check of the app in a phone-sized Chromium (Playwright).

    python tests/e2e.py            # screenshots go to tests/out/

Serves app/ on localhost, imports the example decks, swipes, undoes, reviews, edits answers,
exports, and imports broken decks to check the error messages.
"""
import functools
import http.server
import io
import json
import pathlib
import sys
import threading
import zipfile

from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "out"
failures = []


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "app"))
    http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
    http.server.ThreadingHTTPServer.request_queue_size = 128   # the app loads ~30 modules at once; the default backlog is 5
    http.server.ThreadingHTTPServer.daemon_threads = True
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)  # a free port
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        failures.append(msg)


def bad_zip(deck, files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("deck.json", deck if isinstance(deck, str) else json.dumps(deck))
        for k, v in files.items():
            z.writestr(k, v)
    return b.getvalue()


def png1(w=8, h=8):
    from PIL import Image
    b = io.BytesIO(); Image.new("L", (w, h)).save(b, "PNG"); return b.getvalue()


def import_example(page, title, wait_card=True):
    page.get_by_role("button", name="Try an example").click()
    page.locator(".example", has_text=title).click()
    expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=20000)
    page.get_by_role("button", name="Open the deck").click()
    if wait_card:
        page.wait_for_selector(".card canvas")
    page.wait_for_timeout(400)
    dismiss_tour(page)


def dismiss_tour(page, name="Tester"):
    if page.locator(".sheet h3", has_text="Welcome").count():
        page.locator("#tour-name").fill(name)
        page.get_by_role("button", name="Let's go").click()
        page.wait_for_timeout(150)


def count(page):
    return page.locator("#count").inner_text()


def swipe(page, dx, dy):
    box = page.locator(".card").bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    for i in range(1, 11):
        page.mouse.move(x + dx * i / 10, y + dy * i / 10)
        page.wait_for_timeout(16)
    page.mouse.up()
    page.wait_for_timeout(450)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                                  service_workers="block", accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

        print("home")
        page.goto(base)
        expect(page.locator(".hero h1")).to_have_text("Hooman in the Loop")
        page.screenshot(path=OUT / "01_home_empty.png")

        print("duel deck: import, swipe, buttons, undo, keys")
        import_example(page, "Model A vs model B")
        page.screenshot(path=OUT / "02_duel_card.png")
        n_cards = int(count(page).split("/")[1])
        check(count(page) == f"0 / {n_cards}", f"starts at 0 / {n_cards}")
        page.locator(".ans", has_text="A is right").click(); page.wait_for_timeout(450)
        check(count(page).startswith("1 /"), "button answer counts")
        swipe(page, 220, 10)
        check(count(page).startswith("2 /"), "swipe right counts")
        swipe(page, 30, 15)
        check(count(page).startswith("2 /"), "a short drag snaps back")
        page.locator("[data-act=undo]").click(); page.wait_for_timeout(300)
        check(count(page).startswith("1 /"), "undo takes back one answer")
        page.keyboard.press("ArrowDown"); page.wait_for_timeout(450)
        page.keyboard.press("1"); page.wait_for_timeout(450)
        check(count(page).startswith("3 /"), "keyboard answers count")

        print("both wrong -> draw the right mask")
        page.keyboard.press("ArrowUp")
        page.wait_for_selector(".editor canvas"); page.wait_for_timeout(400)
        check(count(page).startswith("3 /"), "the editor opens before anything is saved")
        page.screenshot(path=OUT / "15_editor_open.png")
        page.locator("[data-e=cancel]").click(); page.wait_for_timeout(200)
        check(page.locator(".editor").count() == 0 and count(page).startswith("3 /"), "cancel without drawing saves nothing")
        page.locator(".ans", has_text="Both wrong").click()
        page.wait_for_selector(".editor canvas"); page.wait_for_timeout(400)
        page.locator("[data-from='A']").click(); page.wait_for_timeout(300)
        check(page.locator("[data-obj]").count() >= 1, "start from model A copies its object")
        ebox = page.locator(".editor canvas").bounding_box()
        cx, cy = ebox["x"] + ebox["width"] / 2, ebox["y"] + ebox["height"] / 2
        page.mouse.move(cx - 60, cy + 40); page.mouse.down()
        for i in range(12):
            page.mouse.move(cx - 60 + i * 10, cy + 40 + (i % 3) * 4)
        page.mouse.up(); page.wait_for_timeout(150)
        page.locator("[data-e=new]").click()
        page.locator("[data-tool=contour]").click()
        page.mouse.move(cx + 40, cy - 80); page.mouse.down()
        for x, y in [(cx + 90, cy - 80), (cx + 90, cy - 30), (cx + 40, cy - 30), (cx + 40, cy - 78)]:
            page.mouse.move(x, y, steps=5)
        page.mouse.up(); page.wait_for_timeout(200)
        n_obj = page.locator("[data-obj]").count()
        page.locator("[data-e=undo]").click(); page.wait_for_timeout(100)
        page.locator("[data-e=redo]").click(); page.wait_for_timeout(100)
        check(page.locator("[data-obj]").count() == n_obj, f"undo + redo keep the objects ({n_obj})")
        page.screenshot(path=OUT / "16_editor_drawn.png")
        page.locator("[data-tool=brush]").click()
        page.locator("[data-e=done]").click()
        page.wait_for_timeout(600)
        check(page.locator(".editor").count() == 0 and count(page).startswith("4 /"), "saving the drawing answers the card")
        tally = page.locator("#tally").inner_text()
        check("Both wrong 1" in tally and "Unsure 1" in tally and "Not a cell 1" in tally, f"tally shows each answer ({tally!r})")

        print("zoom")
        box = page.locator(".card").bounding_box()
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_selector(".zoom canvas"); page.wait_for_timeout(300)
        page.screenshot(path=OUT / "03_zoom.png")
        page.locator(".zoom [data-zsrc='A']").click(); page.wait_for_timeout(150)
        page.screenshot(path=OUT / "04_zoom_A_hidden.png")
        page.locator(".zoom [data-zsrc='A']").click()
        page.locator("[data-z=close]").click()
        check(page.locator(".zoom").count() == 0, "zoom closes")

        print("review and change an answer")
        page.locator("[data-act=menu]").click()
        page.get_by_role("button", name="Review and change answers").click()
        page.wait_for_selector(".thumb"); page.wait_for_timeout(500)
        page.screenshot(path=OUT / "05_review.png")
        first = page.locator(".thumb").first
        old = first.inner_text()
        first.click()
        page.wait_for_selector(".card canvas"); page.wait_for_timeout(300)
        page.locator(".ans", has_text="B is right").click()
        page.wait_for_selector(".thumb"); page.wait_for_timeout(300)
        new = page.locator(".thumb").first.inner_text()
        check(old.strip().upper() == "A IS RIGHT" and new.strip().upper() == "B IS RIGHT", f"review re-answer changes the card ({old!r} -> {new!r})")
        page.locator(".chip", has_text="Not answered").click(); page.wait_for_timeout(200)
        check(page.locator(".thumb").count() == n_cards - 4, "filter: not answered")
        page.locator(".chip", has_text="All").first.click()
        page.locator("[data-act=back]").click()
        page.wait_for_selector(".card canvas")

        print("edit answers")
        page.locator("[data-act=menu]").click()
        page.get_by_role("button", name="Edit the answer buttons").click()
        page.locator("[data-f=label]").nth(3).fill("No idea")
        page.get_by_role("button", name="＋ Add an answer").click()
        page.locator("[data-f=label]").last.fill("Out of focus")
        page.screenshot(path=OUT / "06_edit_answers.png")
        page.get_by_role("button", name="Save").click(); page.wait_for_timeout(300)
        check(page.locator(".ans", has_text="No idea").count() == 1, "renamed answer shows")
        check(page.locator(".ans", has_text="Out of focus").count() == 1, "added answer shows")
        page.locator(".ans", has_text="Out of focus").click(); page.wait_for_timeout(450)
        page.screenshot(path=OUT / "07_after_edit.png")

        print("export")
        page.locator("[data-act=menu]").click()
        page.get_by_role("button", name="Export answers").click()
        with page.expect_download() as dl:
            page.get_by_role("button", name="Share or save the .zip").click()
        path = OUT / "duel.answers.zip"
        dl.value.save_as(path)
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            data = json.loads(z.read("answers.json"))
            csv = z.read("answers.csv").decode()
        check(names[:2] == ["answers.csv", "answers.json"], f"zip has the csv and json ({names})")
        check(len(data["answers"]) == 5 and len(data["unanswered"]) == n_cards - 5, f"5 answers exported ({len(data['answers'])})")
        values = sorted(a["answer"] for a in data["answers"])
        check(values == sorted(["B", "both_wrong", "unsure", "not_a_cell", "out_of_focus"]), f"exported values {values}")
        check(any(h.get("undo") for h in data["history"]), "history keeps the undo")
        bw = next(a for a in data["answers"] if a["answer"] == "both_wrong")
        mpath = bw.get("overlays", [{}])[0].get("mask")
        check(bool(mpath) and mpath in names, f"the drawn mask is in the zip ({mpath})")
        if mpath and mpath in names:
            from PIL import Image
            import numpy as np
            with zipfile.ZipFile(path) as z:
                m = np.asarray(Image.open(io.BytesIO(z.read(mpath))))
            check(m.shape == (384, 384) and len(np.unique(m)) - 1 == len(bw["objects"]) >= 2,
                  f"mask is a 384x384 label image with {len(bw['objects'])} objects (found {len(np.unique(m)) - 1})")
        check(csv.splitlines()[0] == "card_id,image,answer,label,answered_at,ms,changes,mask,annotator,note,number,text,points", "csv header")
        check(data.get("annotator") == "Tester" and all(a.get("by") == "Tester" for a in data["answers"]), "the tour's name goes into every answer")
        changed = [a for a in data["answers"] if a["changes"] > 0]
        check(len(changed) == 1 and changed[0]["answer"] == "B", "the changed answer has changes=1")
        page.keyboard.press("Escape")

        print("persistence after reload")
        page.reload(); page.wait_for_selector(".card canvas"); page.wait_for_timeout(300)
        check(count(page).startswith("5 /"), "answers survive a reload")
        page.locator("[data-act=back]").click()
        page.wait_for_selector(".deckrow")

        print("other examples")
        for title, shot in [("Is it a circle?", "08_circles"), ("Check a detector", "09_boxes"), ("Follow a track", "10_timelapse")]:
            page.goto(base + "#/")
            page.wait_for_selector(".hero")
            import_example(page, title)
            page.screenshot(path=OUT / f"{shot}.png")
        page.locator("[data-frame='2']").click(); page.wait_for_timeout(150)
        page.screenshot(path=OUT / "11_timelapse_frame3.png")
        for _ in range(4):
            swipe(page, 0, -260)
        page.wait_for_timeout(800)
        check(page.locator(".done").count() == 1, "finishing a deck shows the done screen")
        page.screenshot(path=OUT / "12_done.png")

        print("annotate deck: the editor opens on every card")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.get_by_role("button", name="Try an example").click()
        page.locator(".example", has_text="Mask the fruit").click()
        expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=20000)
        page.get_by_role("button", name="Open the deck").click()
        page.wait_for_selector(".editor canvas"); page.wait_for_timeout(400)
        page.screenshot(path=OUT / "17_annotate_editor.png")
        page.locator("[data-cls=orange]").click()
        ebox = page.locator(".editor canvas").bounding_box()
        cx, cy = ebox["x"] + ebox["width"] / 2, ebox["y"] + ebox["height"] / 2
        page.mouse.move(cx - 30, cy); page.mouse.down(); page.mouse.move(cx + 30, cy, steps=8); page.mouse.up()
        page.locator("[data-e=new]").click()
        page.locator("[data-cls=leaf]").click()
        page.mouse.move(cx - 30, cy + 50); page.mouse.down(); page.mouse.move(cx + 30, cy + 50, steps=8); page.mouse.up()
        if page.locator("[data-from=model]").count():
            page.locator("[data-from=model]").click(); page.wait_for_timeout(200)
        page.screenshot(path=OUT / "18_annotate_drawn.png")
        page.locator("[data-e=done]").click()
        page.wait_for_timeout(700)
        check(page.locator(".editor").count() == 1 and "card 2 of 5" in page.locator(".editor .bar h3").inner_text(), "saving opens the next card's editor")
        page.locator("[data-e=cancel]").click(); page.wait_for_timeout(300)
        check(page.locator(".editor").count() == 0 and page.locator("[data-act=draw]").count() == 1, "cancel goes back to the card with a Draw button")
        page.screenshot(path=OUT / "19_annotate_card.png")
        page.locator("[data-act=draw]").click(); page.wait_for_selector(".editor canvas")
        page.locator("[data-e=done]").click(); page.wait_for_timeout(600)       # nothing drawn: "Nothing to mark"
        page.locator("[data-e=cancel]").click(); page.wait_for_timeout(200)
        tally = page.locator("#tally").inner_text()
        check("Annotated 1" in tally and "Nothing to mark 1" in tally, f"annotate tally ({tally!r})")
        page.locator("[data-act=menu]").click()
        page.get_by_role("button", name="Export answers").click()
        with page.expect_download() as dl:
            page.get_by_role("button", name="Share or save the .zip").click()
        path = OUT / "fruit.answers.zip"
        dl.value.save_as(path)
        with zipfile.ZipFile(path) as z:
            data = json.loads(z.read("answers.json"))
            names = z.namelist()
        ann = next((a for a in data["answers"] if a["answer"] == "annotated"), None)
        classes = sorted(o.get("class", "") for o in ann["objects"]) if ann else []
        check(ann is not None and "orange" in classes and "leaf" in classes, f"objects keep their classes ({classes})")
        check(ann is not None and ann["overlays"][0]["mask"] in names, "annotate mask exported")
        page.keyboard.press("Escape")

        print("same id again: update keeps answers")
        page.goto(base + "#/")
        page.wait_for_selector(".hero")
        page.get_by_role("button", name="Try an example").click()
        page.locator(".example", has_text="Follow a track").click()
        expect(page.locator(".sheet h3")).to_contain_text("already here", timeout=20000)
        page.get_by_role("button", name="Update it, keep the answers").click()
        expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=20000)
        page.get_by_role("button", name="Open the deck").click()
        page.wait_for_timeout(500)
        check(page.locator(".done").count() == 1, "update keeps the answers")

        print("broken decks give exact errors")
        cases = [
            ("no_version.zip", bad_zip({"question": "?", "cards": ["a.png"]}, {"a.png": png1()}), ["add \"hooman\": 1"]),
            ("missing.zip", bad_zip({"hooman": 1, "question": "?", "cards": ["img/A.png", "img/b.png"]}, {"img/a.png": png1(), "img/b.png": png1()}),
             ['"img/A.png" is not in the zip (did you mean "img/a.png"?)']),
            ("badjson.zip", bad_zip('{"hooman": 1, "cards": ["a.png",]}', {"a.png": png1()}), ["not valid JSON"]),
            ("masksize.zip", bad_zip({"hooman": 1, "question": "?", "cards": [{"image": "a.png", "overlays": [{"mask": "m.png"}, {"bbox": [1, 2, 3, 4]}]}]},
                                     {"a.png": png1(16, 16), "m.png": png1(8, 8)}), ['use "box" instead of "bbox"']),
            ("masksize2.zip", bad_zip({"hooman": 1, "question": "?", "cards": [{"image": "a.png", "overlays": [{"mask": "m.png"}]}]},
                                      {"a.png": png1(16, 16), "m.png": png1(8, 8)}), ["is 8×8 but the image is 16×16"]),
            ("cocopoly.zip", bad_zip({"hooman": 1, "question": "?", "cards": [{"image": "a.png", "overlays": [{"polygon": [1, 2, 3, 4, 5, 6]}]}]},
                                     {"a.png": png1()}), ["looks flat like COCO"]),
            ("dupe.zip", bad_zip({"hooman": 1, "question": "?", "cards": ["a.png", {"image": "a.png"}]}, {"a.png": png1()}), ["already used by cards[0]"]),
            ("tiff.zip", bad_zip({"hooman": 1, "question": "?", "cards": ["a.tif"]}, {"a.tif": b"II*\x00"}), ["is a TIFF"]),
            ("nested.zip", bad_zip("{}", {}) if False else None, None),
        ]
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        for name, data, expected in cases:
            if data is None:
                continue
            (OUT / name).write_bytes(data)
            page.locator("#file").set_input_files(str(OUT / name))
            page.wait_for_selector(".errors li", timeout=10000)
            text = page.locator(".sheet").inner_text()
            for e in expected:
                check(e in text, f"{name}: error says {e!r}")
            if name == "missing.zip":
                page.screenshot(path=OUT / "13_errors.png")
            page.get_by_role("button", name="Close").click()

        # a zip with one wrapping folder is accepted
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            z.writestr("mydeck/deck.json", json.dumps({"hooman": 1, "title": "Wrapped", "cards": ["x.png"]}))
            z.writestr("mydeck/x.png", png1(20, 10))
        (OUT / "wrapped.zip").write_bytes(b.getvalue())
        page.locator("#file").set_input_files(str(OUT / "wrapped.zip"))
        expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=10000)
        check(True, "one wrapping folder is accepted")
        page.keyboard.press("Escape")

        print("real touch input (CDP)")
        cdp = ctx.new_cdp_session(page)
        def touch(kind, pts):
            cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})
        page.goto(base + "#/deck/example-circles"); page.wait_for_selector(".card canvas"); page.wait_for_timeout(300)
        before = count(page)
        b = page.locator(".card").bounding_box(); x0, y0 = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
        touch("touchStart", [(x0, y0)])
        for i in range(1, 9):
            touch("touchMove", [(x0 - 28 * i, y0 + 2 * i)]); page.wait_for_timeout(16)
        touch("touchEnd", []); page.wait_for_timeout(500)
        check(count(page) != before, f"a finger swipe answers ({before} -> {count(page)})")
        page.goto(base + "#/deck/example-fruit"); page.wait_for_selector(".editor canvas"); page.wait_for_timeout(400)
        n0 = page.locator("[data-obj]").count()
        objs0 = page.locator("[data-objects]").inner_text()
        b = page.locator(".editor canvas").bounding_box(); x0, y0 = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
        touch("touchStart", [(x0 - 20, y0)]); touch("touchStart", [(x0 - 20, y0), (x0 + 20, y0)])
        for i in range(1, 8):
            touch("touchMove", [(x0 - 20 - 8 * i, y0), (x0 + 20 + 8 * i, y0)]); page.wait_for_timeout(16)
        touch("touchEnd", []); page.wait_for_timeout(300)
        check(page.locator("[data-objects]").inner_text() == objs0, "a two-finger pinch zooms and paints nothing")
        touch("touchStart", [(x0, y0)])
        for i in range(1, 8):
            touch("touchMove", [(x0 + 6 * i, y0 + 3 * i)]); page.wait_for_timeout(16)
        touch("touchEnd", []); page.wait_for_timeout(300)
        check("(empty)" not in page.locator("[data-objects]").inner_text(), "a one-finger stroke paints")
        page.screenshot(path=OUT / "20_touch_editor.png")
        page.locator("[data-e=cancel]").click(); page.locator("[data-e=cancel]").click(); page.wait_for_timeout(200)
        check(page.locator(".editor").count() == 0, "cancel twice discards the drawing")

        print("16-bit microscopy: auto contrast, contrast panel, cell tools")
        import numpy as np
        from PIL import Image
        from scipy import ndimage
        with zipfile.ZipFile(ROOT / "app" / "examples" / "nuclei.hooman.zip") as z:
            model = np.asarray(Image.open(io.BytesIO(z.read("model/field1.png"))))
            dapi = np.asarray(Image.open(io.BytesIO(z.read("img/field1_dapi.png")))).astype(float)
        cen = lambda m: (float(np.nonzero(m)[1].mean()) + 0.5, float(np.nonzero(m)[0].mean()) + 0.5)
        sm = ndimage.gaussian_filter(dapi, 1.5)
        blobs, nb = ndimage.label(sm > (np.percentile(sm, 50) + np.percentile(sm, 99.5)) / 2)
        missed = [k for k in range(1, nb + 1) if (blobs == k).sum() > 60 and not (model[blobs == k] > 0).any()]
        busy = ndimage.binary_dilation((model > 0) | (blobs > 0), iterations=6)
        free = [(x, y) for y in range(30, 290, 10) for x in range(30, 290, 10) if not busy[y - 22:y + 22, x - 22:x + 22].any()]
        n_model = len(np.unique(model)) - 1

        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.get_by_role("button", name="Try an example").click()
        page.locator(".example", has_text="Fix the nuclei").click()
        expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=20000)
        page.get_by_role("button", name="Open the deck").click()
        page.wait_for_selector(".card canvas"); page.wait_for_timeout(500)
        mean = "(() => { const c = document.querySelector('%s'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i]; return s / (d.length / 4); })()"
        p99 = "(() => { const c = document.querySelector('.card canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const v = []; for (let i = 0; i < d.length; i += 4) v.push(d[i]); v.sort((a, b) => a - b); return v[Math.floor(v.length * 0.99)]; })()"
        bright0, top = page.evaluate(mean % ".card canvas"), page.evaluate(p99)
        check(top > 180, f"raw 16-bit images get auto contrast (nuclei reach {top}/255; the browser alone would show about 2/255)")
        page.screenshot(path=OUT / "22_nuclei_card.png")
        page.locator("[data-act=contrast]").first.click()
        page.wait_for_selector(".cpanel")
        page.locator(".cpanel [data-k=max]").fill("70"); page.wait_for_timeout(300)
        bright1 = page.evaluate(mean % ".card canvas")
        check(bright1 > bright0 + 10, f"lowering the white point brightens the image ({bright0:.0f} -> {bright1:.0f})")
        check(page.locator(".cpanel .seg button").count() == 2, "contrast can apply to all frames or one channel")
        page.screenshot(path=OUT / "23_contrast_panel.png")
        page.locator(".cpanel [data-cp=reset]").click(); page.wait_for_timeout(200)
        page.locator(".cpanel [data-cp=close]").click()

        page.keyboard.press("ArrowUp")
        page.wait_for_selector(".editor canvas"); page.wait_for_timeout(500)
        dbg = lambda: page.evaluate("document.querySelector('.editor')._debug()")
        def scr(x, y):
            d, r = dbg(), page.locator(".editor canvas").bounding_box()
            return r["x"] + d["view"]["ox"] + x * d["view"]["s"], r["y"] + d["view"]["oy"] + y * d["view"]["s"]
        def tap(x, y): page.mouse.click(*scr(x, y)); page.wait_for_timeout(150)
        check(page.locator(".editor [data-chan]").count() == 3, "the editor has channel buttons (DAPI, Membrane, Mix)")
        page.locator(".editor [data-chan='1']").click(); page.wait_for_timeout(150)
        check(dbg()["chan"] == 1, "switching to the membrane channel in the editor")
        page.locator(".editor [data-chan='0']").click()

        page.locator("[data-tool=pick]").click()
        tap(*cen(model == 3))
        d = dbg(); check(d["objects"] == 1 and d["pixels"] == int((model == 3).sum()), f"pick takes the model's object exactly ({d['pixels']} px)")
        page.locator("[data-e=clear]").click()
        page.locator("[data-from=model]").click(); page.wait_for_timeout(300)
        d = dbg(); check(d["objects"] == n_model, f"start from model copies all {n_model} objects ({d['objects']})")

        page.locator("[data-tool=merge]").click()
        tap(*cen(model == 8)); tap(*cen(model == 100))
        check(dbg()["objects"] == n_model - 1, "merge joins the two halves of a split nucleus")
        cx, cy = cen((model == 8) | (model == 100))
        page.locator("[data-tool=cut]").click()
        page.mouse.move(*scr(cx, cy - 22)); page.mouse.down(); page.mouse.move(*scr(cx, cy + 22), steps=10); page.mouse.up(); page.wait_for_timeout(200)
        check(dbg()["objects"] == n_model, "cut splits it again")

        def lone_line(v):                       # a vertical line through object v that crosses no other object
            ys, xs = np.nonzero(model == v)
            lx, y0, y1 = int(round(xs.mean())), max(0, ys.min() - 2), min(model.shape[0] - 1, ys.max() + 2)
            col = model[y0:y1 + 1, lx]
            return (lx + 0.5, y0, y1 + 1) if set(np.unique(col).tolist()) <= {0, int(v)} and (col == v).sum() >= 5 else None
        v, (lx, ly0, ly1) = next((v, ln) for v in sorted(set(np.unique(model).tolist()) - {0}, key=lambda v: -(model == v).sum()) if (ln := lone_line(v)))
        page.locator("[data-e=clear]").click(); page.wait_for_timeout(200)
        page.locator("[data-tool=cut]").click(); page.wait_for_timeout(100)
        page.mouse.move(*scr(lx, ly0)); page.mouse.down(); page.mouse.move(*scr(lx, ly1), steps=12); page.mouse.up(); page.wait_for_timeout(500)
        d = dbg()
        check(d["objects"] == 2 and d["pixels"] == int((model == v).sum()),
              f"with nothing drawn yet, a cut across a model's outline takes that object and cuts it ({d['objects']} objects, {d['pixels']} px)")
        page.locator("[data-e=clear]").click(); page.locator("[data-from=model]").click(); page.wait_for_timeout(300)

        check(len(missed) >= 1, f"the test found the nucleus the model missed ({len(missed)})")
        if missed:
            page.locator("[data-tool=wand]").click()
            px0 = dbg()["pixels"]
            tap(*cen(blobs == missed[0]))
            d = dbg(); area = d["pixels"] - px0
            check(d["objects"] == n_model + 1 and 80 < area < 1500, f"the wand fills the missed nucleus ({area} px)")
            page.locator("[data-size]").fill("0.6"); page.wait_for_timeout(200)
            area2 = dbg()["pixels"] - px0
            check(dbg()["objects"] == n_model + 1 and area2 > area, f"the slider grows the wand region ({area} -> {area2} px)")
            page.screenshot(path=OUT / "24_wand.png")

        check(len(free) >= 2, "the test found empty background")
        if len(free) >= 2:
            n1, px1 = dbg()["objects"], dbg()["pixels"]
            page.locator("[data-tool=contour]").click()
            (fx, fy), r = free[0], 12
            ring = [scr(fx + r * np.cos(t), fy + r * np.sin(t)) for t in np.linspace(0, 2 * np.pi, 24)]
            page.mouse.move(*ring[0]); page.mouse.down()
            for p_ in ring[1:]: page.mouse.move(*p_)
            page.mouse.up(); page.wait_for_timeout(200)
            d = dbg(); check(d["objects"] == n1 + 1 and d["pixels"] - px1 > 300, f"a closed contour fills its inside ({d['pixels'] - px1} px)")
            page.locator("[data-tool=polygon]").click()
            (gx, gy) = free[-1]
            for (x, y) in [(gx - 10, gy - 10), (gx + 10, gy - 10), (gx + 10, gy + 10), (gx - 10, gy + 10)]:
                tap(x, y)
            check(page.locator("[data-e=polyfill]").count() == 1, "the polygon offers ✓ Fill while open")
            tap(gx - 10, gy - 10)
            d2 = dbg(); check(d2["objects"] == n1 + 2 and 300 < d2["pixels"] - d["pixels"] < 500, f"tapping the first corner fills the polygon ({d2['pixels'] - d['pixels']} px)")
            page.screenshot(path=OUT / "25_tools.png")
            page.locator("[data-tool=delete]").click(); page.wait_for_timeout(150)
            check(dbg()["objects"] == n1 + 1, "delete removes the selected object")
            page.locator("[data-tool=fill]").click(); page.wait_for_timeout(150)
            check(page.locator(".ehint span").inner_text() != "", "fill holes reports what it did")
        page.locator("[data-e=done]").click(); page.wait_for_timeout(600)
        check(page.locator(".editor").count() == 0 and count(page).startswith("1 /"), "the fixed mask is saved as the answer")

        print("dopamine")
        page.goto(base + "#/deck/example-circles"); page.wait_for_selector(".card canvas"); page.wait_for_timeout(300)
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(120)
        check(page.locator(".yay.blast").count() == 1, "a celebrate answer fires the confetti blast")
        page.screenshot(path=OUT / "26_blast.png")
        page.wait_for_timeout(1600)
        page.keyboard.press("ArrowLeft"); page.wait_for_timeout(150)
        check(page.locator(".yay.blast").count() == 0, "other answers don't")

        print("small phones")
        for w, h in [(360, 640), (375, 667), (390, 720)]:
            page.set_viewport_size({"width": w, "height": h})
            page.goto(base + "#/deck/example-duel")
            page.wait_for_selector(".card canvas"); page.wait_for_timeout(400)
            page.screenshot(path=OUT / f"14_duel_{w}x{h}.png")
            card = page.locator(".card").bounding_box()
            ans = page.locator("#answers").bounding_box()
            extra = page.evaluate("document.documentElement.scrollHeight - window.innerHeight")
            fits = card["y"] + card["height"] <= ans["y"] + 1 and (ans["y"] + ans["height"] <= h + 1 or extra <= 0.35 * h) and card["width"] >= 0.7 * (w - 32)
            check(fits, f"{w}x{h}: card at least 70% wide, buttons below it, at most a little scrolling (card {card['width']:.0f}px, scroll {extra}px)")
            wide = page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            check(wide, f"{w}x{h}: no sideways scroll")

        check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; screenshots in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
