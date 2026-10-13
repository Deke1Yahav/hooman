"""End-to-end checks for 0.4's real-phone findings: several channels per time frame, the narrow card with
many answers, "Start from" in time decks (every frame, one number per cell) and bold-only "Start from".

    python tests/e2e_v5.py            # screenshots go to tests/out/
"""
import io
import json
import re
import sys
import zipfile

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright, expect

from e2e import OUT, ROOT, serve, check, failures, import_example, dismiss_tour, count, bad_zip, png1
from e2e_v3 import phone, watch, export, scr, tap

SCHEMA = json.loads((ROOT / "app" / "deck.schema.json").read_text(encoding="utf-8"))


def png16(a):
    b = io.BytesIO(); Image.fromarray(a.astype(np.uint16)).save(b, "PNG"); return b.getvalue()


def png8(a):
    b = io.BytesIO(); Image.fromarray(a.astype(np.uint8)).save(b, "PNG"); return b.getvalue()


CANVAS_RGB = """(() => { const c = document.querySelector('%s'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let r = 0, g = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; } const n = d.length / 4; return [r / n, g / n, b / n]; })()"""


def layout_deck(buttons=("Division", "Dead", "Debris", "Out of focus"), info="e400: 3 links, PyTrack: 2 links, frames 529-532", view=None, deck_id="t-layout"):
    """Square image, 4 time frames x 2 channels, 8 answers, a long caption: the narrow-card case from a real phone."""
    files, frames = {}, []
    r = np.random.default_rng(5)
    for t in range(4):
        files[f"c1_{t}.png"] = png16(200 + r.random((128, 128)) * 600)
        files[f"c2_{t}.png"] = png16(300 + r.random((128, 128)) * 400)
        frames.append({"name": f"t{t + 1}", "image": f"c1_{t}.png", "channels": [f"c2_{t}.png"]})
    lab = np.zeros((128, 128)); lab[30:70, 30:70] = 1; lab[80:110, 60:100] = 2
    files["m.png"] = png8(lab)
    deck = {"hooman": 1, "id": deck_id, "question": "Which model is right for the bold cell in every frame?", "frames_are": "time",
            "channels": [{"name": "electra", "color": "#3ddc97"}, {"name": "Oblique", "color": "#ffffff"}],
            "sources": {"e400": {}, "pytrack": {}, "look": {"guide": True}},
            "answers": {"left": {"label": "PyTrack right", "value": "pytrack"}, "right": {"label": "e400 right", "value": "e400"},
                        "up": {"label": "Both wrong", "value": "both_wrong", "then": "draw"}, "down": "Unsure"},
            "buttons": list(buttons),
            "cards": [{"id": f"c{k}", "frames": frames, "info": info,
                       "overlays": [{"source": "e400", "mask": "m.png"}, {"source": "e400", "mask": "m.png", "value": 1, "style": "bold"},
                                    {"source": "pytrack", "mask": "m.png"}, {"source": "look", "box": [20, 20, 60, 60]}]} for k in range(3)]}
    if view:
        deck["channel_view"] = view
    assert_schema(deck)
    return bad_zip(deck, files)


def assert_schema(deck):
    import jsonschema
    jsonschema.validate(deck, SCHEMA)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = phone(browser, permissions=["clipboard-read", "clipboard-write"]); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")

        print("1. several channels per time frame")
        import_example(page, "2 channels over time")
        chips = page.locator(".card .chanbar button")
        check(chips.all_inner_texts() == ["nuclei", "body", "Mix", "Side by side"], f"the card has a chip per channel, Mix and Side by side ({chips.all_inner_texts()})")
        check(page.locator(".card .chanbar [data-chan=mix]").get_attribute("aria-pressed") == "true", 'the deck opens in its "channel_view": "mix"')
        mix = page.evaluate(CANVAS_RGB % ".card canvas")
        check(mix[1] > mix[0] + 3, f"Mix adds the green nuclei channel to the white body channel (mean RGB {[round(x) for x in mix]})")
        page.screenshot(path=OUT / "50_channels_mix.png")
        page.locator(".card .chanbar [data-chan='1']").click(); page.wait_for_timeout(250)
        body = page.evaluate(CANVAS_RGB % ".card canvas")
        check(abs(body[0] - body[1]) < 4, "one channel on its own is grey")
        page.locator(".card [data-frame='2']").click(); page.wait_for_timeout(300)
        check(page.locator(".card .chanbar [data-chan='1']").get_attribute("aria-pressed") == "true", "switching the frame keeps the channel")
        page.locator(".card .chanbar [data-chan='0']").click(); page.wait_for_timeout(200)
        check(page.locator(".card [data-frame='2']").get_attribute("aria-pressed") == "true", "switching the channel keeps the frame")
        page.locator(".card .chanbar [data-chan=mix]").click(); page.wait_for_timeout(150)
        page.locator(".card [data-act=play]").click(); page.wait_for_timeout(1300); page.locator(".card [data-act=play]").click()
        check(page.locator(".card .chanbar [data-chan=mix]").get_attribute("aria-pressed") == "true", "playing keeps Mix")
        page.locator(".card .chanbar [data-chan=side]").click(); page.wait_for_timeout(300)
        stage_w = page.locator("#stage").bounding_box()["width"]
        check(page.locator(".card").bounding_box()["width"] >= stage_w - 4, "side by side uses the full width")
        page.screenshot(path=OUT / "51_channels_side.png")
        page.locator(".card .chanbar [data-chan='0']").click(); page.wait_for_timeout(200)
        page.locator("[data-act=contrast]").first.click(); page.wait_for_selector(".cpanel")
        check("Only nuclei" in page.locator(".cpanel").inner_text(), "contrast is per channel (Only nuclei)")
        page.locator(".cpanel [data-scope='nuclei']").click()
        before = page.evaluate(CANVAS_RGB % ".card canvas")
        page.locator(".cpanel [data-k=max]").fill("60"); page.wait_for_timeout(300)
        after = page.evaluate(CANVAS_RGB % ".card canvas")
        page.locator(".cpanel [data-cp=close]").click()
        page.locator(".card .chanbar [data-chan='1']").click(); page.wait_for_timeout(250)
        body2 = page.evaluate(CANVAS_RGB % ".card canvas")
        check(after[0] > before[0] + 5 and abs(body2[0] - body[0]) < 3, "the nuclei contrast changes nuclei only, not body")
        box = page.locator(".card canvas").bounding_box(); page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_selector(".zoom canvas")
        check(page.locator(".zoom [data-zchan]").count() == 4, "the zoom view has the channel chips too")
        page.locator("[data-z=close]").click()

        print("3 + 4. Start from in a time deck: every frame, one number per cell, only the bold object")
        page.locator(".card .chanbar [data-chan=mix]").click()
        page.keyboard.press("ArrowUp"); page.wait_for_selector(".editor canvas"); page.wait_for_timeout(500)
        dbg = lambda: page.evaluate("document.querySelector('.editor')._debug()")
        check(page.locator(".editor [data-chan]").count() == 3 and dbg()["cview"] == "mix", "the editor has the channel chips and opens in Mix")
        check(dbg()["chan"] == 0, "in Mix the wand reads channel 1")
        page.locator(".editor [data-chan='1']").click(); page.wait_for_timeout(150)
        check(dbg()["chan"] == 1, "on one channel the wand reads that channel")
        page.locator("[data-tool=wand]").click()
        check("It reads body" in page.locator(".ehint").inner_text(), "the wand's hint names the channel it reads")
        page.locator("[data-from=A]").click(); page.wait_for_timeout(500)
        check(dbg()["objects"] == 1, f"only the bold object is taken, not all of model A's ({dbg()['objects']})")
        page.locator("[data-tool=brush]").click()
        page.locator(".editor [data-frame='2']").click(); page.wait_for_timeout(250)
        check(dbg()["objects"] == 1 and dbg()["pixels"] > 500, "the last frame was filled too, with the same object")
        page.locator("[data-e=undo]").click(); page.wait_for_timeout(150)
        check(dbg()["pixels"] == 0, "one undo takes back every frame")
        page.locator("[data-e=redo]").click(); page.wait_for_timeout(150)
        page.screenshot(path=OUT / "52_startfrom_time.png")
        page.locator("[data-e=done]").click(); page.wait_for_timeout(700)
        path, data, _ = export(page, "example-channels", "channels.answers.zip")
        bw = next(a for a in data["answers"] if a["answer"] == "both_wrong")
        with zipfile.ZipFile(path) as z:
            vals = [sorted(set(np.unique(np.asarray(Image.open(io.BytesIO(z.read(o["mask"])))))) - {0}) for o in bw["overlays"]]
        check(len(bw["overlays"]) == 3 and vals == [[1], [1], [1]], f"3 frame masks, each with object 1 ({vals})")
        o1 = bw["objects"][0]
        check(o1.get("from") == "A" and o1.get("from_values") == [1], f"the object remembers model A's number ({o1})")

        print("   bold-only Start from in a single-frame deck")
        lab = np.zeros((64, 64)); lab[5:20, 5:20] = 1; lab[30:50, 30:50] = 2; lab[40:60, 2:15] = 3
        gz = bad_zip({"hooman": 1, "id": "t-bold", "question": "?", "sources": {"m": {}},
                      "answers": {"right": "Yes", "up": {"label": "Fix", "then": "draw"}},
                      "cards": [{"id": "c", "image": "a.png", "overlays": [{"source": "m", "mask": "m.png"}, {"source": "m", "mask": "m.png", "value": 2, "style": "bold"}]}]},
                     {"a.png": png1(64, 64), "m.png": png8(lab)})
        (OUT / "t-bold.zip").write_bytes(gz)
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.locator("#file").set_input_files(str(OUT / "t-bold.zip"))
        expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=10000)
        page.get_by_role("button", name="Open the deck").click(); page.wait_for_selector(".card canvas")
        page.keyboard.press("ArrowUp"); page.wait_for_selector(".editor canvas"); page.wait_for_timeout(300)
        page.locator("[data-from=m]").click(); page.wait_for_timeout(300)
        d = dbg()
        check(d["objects"] == 1 and d["pixels"] == int((lab == 2).sum()), f"with a bold overlay, Start from takes just that object ({d['objects']} object, {d['pixels']} px)")
        page.locator("[data-e=cancel]").click(); page.locator("[data-e=cancel]").click()

        print("   validator errors an LLM can fix")
        ch = {"hooman": 1, "question": "?", "channels": [{"name": "a"}, {"name": "b"}]}
        cases = [
            ("count.zip", bad_zip({**ch, "cards": [{"image": "x.png"}]}, {"x.png": png1()}), 'needs "channels": [1 more image path] for "b"'),
            ("count2.zip", bad_zip({**ch, "cards": [{"frames": [{"image": "x.png", "channels": ["y.png", "z.png"]}]}]}, {"x.png": png1(), "y.png": png1(), "z.png": png1()}), "has 2 extra channel images, but the deck has 2"),
            ("size.zip", bad_zip({**ch, "cards": [{"image": "x.png", "channels": ["y.png"]}]}, {"x.png": png1(16, 16), "y.png": png1(8, 8)}), "every channel must be the same size"),
            ("missing.zip", bad_zip({**ch, "cards": [{"image": "x.png", "channels": ["Y.png"]}]}, {"x.png": png1(), "y.png": png1()}), '"Y.png" is not in the zip (did you mean "y.png"?)'),
            ("tiff.zip", bad_zip({**ch, "cards": [{"image": "x.png", "channels": ["y.tif"]}]}, {"x.png": png1(), "y.tif": b"II*\x00"}), "is a TIFF"),
            ("plain.zip", bad_zip({**ch, "cards": ["x.png"]}, {"x.png": png1()}), "a plain image path can't hold the deck's 2 channels"),
            ("view.zip", bad_zip({**ch, "channel_view": "c", "cards": [{"image": "x.png", "channels": ["y.png"]}]}, {"x.png": png1(), "y.png": png1()}), '"channel_view" must be "mix", "side" or one channel'),
        ]
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        for name, data_, expected in cases:
            (OUT / name).write_bytes(data_)
            page.locator("#file").set_input_files(str(OUT / name))
            page.wait_for_selector(".errors li", timeout=10000)
            txt = page.locator(".sheet").inner_text()
            check(expected in txt, f"{name}: {expected!r}" + ("" if expected in txt else f" -- got: {txt[:200]!r}"))
            page.locator(".sheet").get_by_role("button", name="Close").click()

        print("   a shared deck keeps its channels")
        page.goto(base + "#/deck/example-channels"); page.wait_for_selector(".card canvas"); page.wait_for_timeout(300)
        page.locator("[data-act=menu]").click(); page.locator(".sheet [data-m=share]").click()
        with page.expect_download() as dl:
            page.get_by_role("button", name="Send as a file").click()
        zp = OUT / "channels.shared.zip"; dl.value.save_as(zp)
        page.keyboard.press("Escape")
        with zipfile.ZipFile(zp) as z:
            dj = json.loads(z.read("deck.json"))
        ok = True
        try: assert_schema(dj)
        except Exception as e: ok = False; print("     ", e)
        check(ok and dj.get("channels") and dj["cards"][0]["frames"][0].get("channels") == ["t0_body.png"] and dj.get("channel_view") == "mix",
              "the shared deck.json has channels, per-frame channel images and channel_view")
        ctx.close()

        print("2. a narrow card with many answers (8 answers, 4 frames, square image)")
        (OUT / "t-layout.zip").write_bytes(layout_deck())
        for w, h in [(360, 640), (390, 844), (412, 915)]:
            c2 = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, is_mobile=True, has_touch=True, service_workers="block")
            q = c2.new_page(); watch(q, errors)
            q.goto(base); q.wait_for_selector(".hero")
            q.locator("#file").set_input_files(str(OUT / "t-layout.zip"))
            expect(q.locator(".sheet h3")).to_contain_text("Ready", timeout=10000)
            q.get_by_role("button", name="Open the deck").click(); q.wait_for_selector(".card canvas"); q.wait_for_timeout(300); dismiss_tour(q)
            q.wait_for_timeout(300)
            card = q.locator(".card").bounding_box(); stage = q.locator("#stage").bounding_box()
            check(card["width"] >= 0.75 * stage["width"], f"{w}x{h}: the card keeps most of the width ({card['width']:.0f} of {stage['width']:.0f}px)")
            labels = q.locator(".card [data-frame]").all_inner_texts()
            clipped = q.evaluate("[...document.querySelectorAll('.card [data-frame], .card .chanbar button')].some(b => b.scrollWidth > b.clientWidth + 1)")
            check(not clipped and (labels == ["t1", "t2", "t3", "t4"] or labels == ["1", "2", "3", "4"]), f"{w}x{h}: frame and channel buttons show whole names ({labels})")
            cap_ok = q.evaluate("(() => { const c = document.querySelector('.cardfoot .caption'); return c.scrollWidth <= c.clientWidth + 1; })()")
            check(cap_ok and "two" in q.locator(".cardfoot").get_attribute("class"), f"{w}x{h}: the caption has its own line and fits")
            ans = q.locator("#answers").bounding_box(); extra = q.evaluate("document.documentElement.scrollHeight - window.innerHeight")
            check(card["y"] + card["height"] <= ans["y"] + 1 and (ans["y"] + ans["height"] <= h + 1 or extra <= 0.35 * h),
                  f"{w}x{h}: all 8 answers are below the card, on screen or a short scroll away (scroll {extra}px)")
            check(q.locator("#answers").get_attribute("class").count("compact") == 1, f"{w}x{h}: more than 6 answers use the compact buttons")
            q.screenshot(path=OUT / f"53_layout_{w}x{h}.png", full_page=True)
            c2.close()

        print("3. a phone, 6 answers, side by side from the start: compact, so the images get the room")
        (OUT / "t-layout6.zip").write_bytes(layout_deck(buttons=["Debris", "Not a cell"], info="one or two · movie 59 · frame 756", view="side", deck_id="t-layout6"))
        c3 = browser.new_context(viewport={"width": 390, "height": 760}, device_scale_factor=2, is_mobile=True, has_touch=True, service_workers="block")
        q = c3.new_page(); watch(q, errors)
        q.goto(base); q.wait_for_selector(".hero")
        q.locator("#file").set_input_files(str(OUT / "t-layout6.zip"))
        expect(q.locator(".sheet h3")).to_contain_text("Ready", timeout=10000)
        q.get_by_role("button", name="Open the deck").click(); q.wait_for_selector(".card canvas"); q.wait_for_timeout(300); dismiss_tour(q); q.wait_for_timeout(300)
        box = lambda sel: q.locator(sel).bounding_box()
        check("compact" in q.locator("#answers").get_attribute("class"), "a phone gets the compact layout, even with 6 answers in side by side")
        check(box("#chips")["height"] <= 34 and box(".cardfoot")["height"] <= 28,
              f"the legend is one row and the card footer one line ({box('#chips')['height']:.0f}px, {box('.cardfoot')['height']:.0f}px)")
        rows = q.evaluate("new Set([...document.querySelectorAll('#answers .ans')].map((b) => Math.round(b.getBoundingClientRect().top))).size")
        check(rows == 2, f"6 answers and Undo take two rows ({rows})")
        cv = box(".card canvas")
        check(cv["height"] >= 0.45 * 760, f"the images get most of the screen ({cv['height']:.0f}px of 760)")
        q.screenshot(path=OUT / "54_layout_phone_side.png")
        c3.close()

        check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; screenshots in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
