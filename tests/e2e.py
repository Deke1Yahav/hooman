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


def import_example(page, title):
    page.get_by_role("button", name="Try an example").click()
    page.locator(".example", has_text=title).click()
    expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=20000)
    page.get_by_role("button", name="Open the deck").click()
    page.wait_for_selector(".card canvas")
    page.wait_for_timeout(400)


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
        page.locator("[data-tool=lasso]").click()
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
        check(csv.splitlines()[0] == "card_id,image,answer,label,answered_at,ms,changes,mask", "csv header")
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

        print("small phones")
        for w, h in [(360, 640), (375, 667), (390, 720)]:
            page.set_viewport_size({"width": w, "height": h})
            page.goto(base + "#/deck/example-duel")
            page.wait_for_selector(".card canvas"); page.wait_for_timeout(400)
            page.screenshot(path=OUT / f"14_duel_{w}x{h}.png")
            card = page.locator(".card").bounding_box()
            ans = page.locator("#answers").bounding_box()
            fits = card["y"] + card["height"] <= ans["y"] + 1 and ans["y"] + ans["height"] <= h + 1
            check(fits, f"{w}x{h}: card and buttons fit on screen")
            wide = page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            check(wide, f"{w}x{h}: no sideways scroll")

        check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; screenshots in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
