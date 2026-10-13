"""End-to-end checks for 0.3: tap answers, follow mode, notes, number/text answers, per-frame masks,
results + annotator agreement, backup/restore, colour-blind mode, the iPhone warning.

    python tests/e2e_v3.py            # screenshots go to tests/out/
"""
import io
import json
import sys
import zipfile

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright, expect

from e2e import OUT, ROOT, serve, check, failures, bad_zip, png1, import_example, dismiss_tour, count, tap_add


def phone(browser, **kw):
    return browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                               service_workers="block", accept_downloads=True, **kw)


def watch(page, errors):
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)


def scr(page, sel, x, y):
    d, r = page.evaluate(f"document.querySelector('{sel}')._debug()"), page.locator(f"{sel} canvas").bounding_box()
    return r["x"] + d["view"]["ox"] + x * d["view"]["s"], r["y"] + d["view"]["oy"] + y * d["view"]["s"]


def tap(page, sel, x, y, wait=260):
    page.mouse.click(*scr(page, sel, x, y)); page.wait_for_timeout(wait)


def export(page, key, name):
    page.locator("[data-act=menu]").click()
    page.locator(".sheet [data-m=export]").click()
    with page.expect_download() as dl:
        page.get_by_role("button", name="Share or save the .zip").click()
    path = OUT / name
    dl.value.save_as(path)
    page.keyboard.press("Escape")
    with zipfile.ZipFile(path) as z:
        return path, json.loads(z.read("answers.json")), z


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = phone(browser)
        page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")

        print("tap answers: 'it jumps, tap the right cell' and divisions")
        import_example(page, "Follow a track")
        with zipfile.ZipFile(ROOT / "app" / "examples" / "timelapse.hooman.zip") as z:
            seg2 = np.asarray(Image.open(io.BytesIO(z.read("masks/movie1_t2.png"))))
        r = np.random.default_rng(300); pos = r.uniform(50, 206, (7, 2)); vel = r.uniform(-9, 9, (7, 2))
        cx, cy = pos[3] + 2 * vel[3]
        expect_val = int(seg2[int(cy), int(cx)])
        page.locator(".ans", has_text="It jumps").click()
        page.wait_for_selector(".tapper canvas"); page.wait_for_timeout(300)
        check(page.locator(".tapper [data-t=done]").is_disabled(), "Save waits for a tap")
        page.locator(".tapper [data-frame='2']").click(); page.wait_for_timeout(150)
        tap(page, ".tapper", cx, cy)
        tap(page, ".tapper", cx + 1, cy + 1)                       # a second tap moves the single point
        d = page.evaluate("document.querySelector('.tapper')._debug()")
        check(len(d["points"]) == 1 and d["points"][0]["frame"] == 2, "one point, on the frame where it was tapped")
        check(expect_val == 0 or (d["points"][0].get("hits") and d["points"][0]["hits"][0]["value"] == expect_val),
              f"the tap records the segmentation object under it ({d['points'][0].get('hits')}, expected {expect_val})")
        page.screenshot(path=OUT / "30_tapper.png")
        page.locator(".tapper [data-t=done]").click(); page.wait_for_timeout(500)
        check(count(page).startswith("1 /"), "saving the tap answers the card")
        page.locator(".ans", has_text="Divides").click()
        page.wait_for_selector(".tapper canvas"); page.wait_for_timeout(300)
        tap(page, ".tapper", 60, 60); tap(page, ".tapper", 120, 120); tap(page, ".tapper", 180, 60)
        tap(page, ".tapper", 180, 60)                              # tapping a point again removes it
        check(len(page.evaluate("document.querySelector('.tapper')._debug()")["points"]) == 2, "several points; a second tap on one removes it")
        page.locator(".tapper [data-t=done]").click(); page.wait_for_timeout(500)
        print("notes")
        page.locator(".note-btn").click()
        page.locator("#note-text").fill("cells overlap here")
        page.get_by_role("button", name="Save").click(); page.wait_for_timeout(200)
        check("has" in page.locator(".note-btn").get_attribute("class"), "the note button shows there's a note")
        _, data, _ = export(page, "example-timelapse", "timelapse.answers.zip")
        a1 = next(a for a in data["answers"] if a["answer"] == "jumps")
        a2 = next(a for a in data["answers"] if a["answer"] == "divides")
        check(len(a1["points"]) == 1 and len(a2["points"]) == 2, "exported points (1 for the jump, 2 daughters)")
        check(any(n.get("note") == "cells overlap here" for n in data.get("notes", [])), "a note on an unanswered card is exported")

        print("follow mode: tap the cell frame after frame, through a division")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        tap_add(page, "examples")
        page.locator(".example", has_text="Follow the cells").click()
        expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=20000)
        page.get_by_role("button", name="Open the deck").click()
        page.wait_for_selector(".tapper canvas"); page.wait_for_timeout(500)
        P0, V0, P1, V1 = np.array([70.0, 80.0]), np.array([9.0, 4.0]), np.array([170.0, 70.0]), np.array([-5.0, 8.0])
        for t in (1, 2, 3):
            tap(page, ".tapper", *(P0 + V0 * t))
        d = page.evaluate("document.querySelector('.tapper')._debug()")
        check(d["f"] == 4 and len(d["points"]) == 4, f"each tap moves on one frame (now frame {d['f']}, {len(d['points'])} points)")
        page.screenshot(path=OUT / "31_follow.png")
        page.locator(".tapper [data-t=divides]").click(); page.wait_for_timeout(150)
        c4 = P0 + V0 * 4
        tap(page, ".tapper", c4[0], c4[1] - 11); tap(page, ".tapper", c4[0], c4[1] + 11, wait=700)
        d = page.evaluate("document.querySelector('.tapper') && document.querySelector('.tapper')._debug()")
        check(d is not None and d["f"] == 1 and len(d["points"]) == 1, "after the daughters the next card's follow opens")
        tap(page, ".tapper", *(P1 + V1 * 1))
        page.locator(".tapper [data-t=missing]").click(); page.wait_for_timeout(200)
        tap(page, ".tapper", *(P1 + V1 * 3))
        page.locator(".tapper [data-t=back]").click(); page.wait_for_timeout(150)
        check(page.evaluate("document.querySelector('.tapper')._debug()")["f"] == 3, "↶ goes back one frame")
        tap(page, ".tapper", *(P1 + V1 * 3))
        page.locator(".tapper [data-t=ends]").click(); page.wait_for_timeout(700)
        page.locator(".tapper [data-t=cancel]").click(); page.wait_for_timeout(300)
        check(count(page).startswith("2 /"), "two tracks saved; cancel stops on the third card")
        _, data, _ = export(page, "example-follow", "follow.answers.zip")
        c1 = next(a for a in data["answers"] if a["card"] == "cell1")
        c2 = next(a for a in data["answers"] if a["card"] == "cell2")
        taps1 = [q for q in c1["points"] if not q.get("start") and not q.get("daughter")]
        check(c1["end"] == "divides" and sum(1 for q in c1["points"] if q.get("daughter")) == 2, "track 1 ends in a division with 2 daughters")
        check(all(q.get("hits") and q["hits"][0]["value"] == 1 for q in taps1), "every tap of track 1 hit segmentation object 1")
        check(c2["end"] == "ends" and any(q.get("missing") for q in c2["points"]), "track 2: a missing frame, then the cell ends")

        print("number and text answers")
        nz = bad_zip({"hooman": 1, "id": "t-num", "question": "How many cells?",
                      "answers": {"right": {"label": "Count", "then": "number"}, "left": {"label": "Comment", "then": "text"}},
                      "cards": ["a.png", "b.png"]}, {"a.png": png1(32, 32), "b.png": png1(32, 32)})
        (OUT / "t-num.zip").write_bytes(nz)
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.locator("#file").set_input_files(str(OUT / "t-num.zip"))
        expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=10000)
        page.get_by_role("button", name="Open the deck").click(); page.wait_for_selector(".card canvas")
        page.keyboard.press("ArrowRight"); page.wait_for_selector("#ask-v")
        page.locator("#ask-v").fill("abc"); page.get_by_role("button", name="Save").click()
        check("number" in page.locator("#ask-err").inner_text(), "a wrong number is refused")
        page.locator("#ask-v").fill("12"); page.get_by_role("button", name="Save").click(); page.wait_for_timeout(500)
        page.keyboard.press("ArrowLeft"); page.wait_for_selector("#ask-v")
        page.locator("#ask-v").fill("looks odd"); page.get_by_role("button", name="Save").click(); page.wait_for_timeout(500)
        _, data, _ = export(page, "t-num", "t-num.answers.zip")
        got = {a["answer"]: (a.get("number"), a.get("text")) for a in data["answers"]}
        check(got == {"count": (12, None), "comment": (None, "looks odd")}, f"number and text are exported ({got})")

        print("frames_are time: one mask per frame, the same object number across frames")
        tz = bad_zip({"hooman": 1, "id": "t-time", "mode": "annotate", "frames_are": "time", "cards": [{"id": "m1", "frames": ["f0.png", "f1.png"]}]},
                     {"f0.png": png1(64, 64), "f1.png": png1(64, 64)})
        (OUT / "t-time.zip").write_bytes(tz)
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.locator("#file").set_input_files(str(OUT / "t-time.zip"))
        expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=10000)
        page.get_by_role("button", name="Open the deck").click(); page.wait_for_selector(".editor canvas"); page.wait_for_timeout(300)
        page.locator("[data-tool=brush]").click()
        def stroke(x0, y0, x1, y1):
            page.mouse.move(*scr(page, ".editor", x0, y0)); page.mouse.down(); page.mouse.move(*scr(page, ".editor", x1, y1), steps=6); page.mouse.up(); page.wait_for_timeout(120)
        stroke(10, 10, 20, 10)
        page.locator(".editor [data-frame='1']").click(); page.wait_for_timeout(150)
        check("not in this frame" in page.locator("[data-objects]").inner_text(), "object 1 is listed on frame 2 as 'not in this frame'")
        stroke(40, 40, 50, 40)
        page.locator("[data-e=done]").click(); page.wait_for_timeout(600)
        path, data, _ = export(page, "t-time", "t-time.answers.zip")
        ov = data["answers"][0]["overlays"]
        with zipfile.ZipFile(path) as z:
            vals = [sorted(set(np.unique(np.asarray(Image.open(io.BytesIO(z.read(o["mask"])))))) - {0}) for o in ov]
        check(len(ov) == 2 and [o["frame"] for o in ov] == [0, 1] and vals == [[1], [1]], f"two masks, frame 0 and 1, both object 1 ({vals})")

        print("results + agreement")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        import_example(page, "Model A vs model B")
        for k in ["ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowRight", "ArrowRight", "ArrowDown"]:
            page.keyboard.press(k); page.wait_for_timeout(420)
        path, mine, _ = export(page, "example-duel", "duel-me.answers.zip")
        other = json.loads(json.dumps(mine)); other["annotator"] = "Maya"
        other["answers"][0]["answer"] = "B"; other["answers"][3]["answer"] = "A"
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            z.writestr("answers.json", json.dumps(other)); z.writestr("answers.csv", "card_id\n")
        (OUT / "duel-maya.answers.zip").write_bytes(b.getvalue())
        page.locator("[data-act=menu]").click(); page.get_by_role("button", name="Results").click()
        page.wait_for_selector(".r-bars")
        nums = page.locator(".r-num").all_inner_texts()
        check(nums[:3] == ["3 · 50%", "2 · 33%", "1 · 17%"], f"bars in button order with counts and % ({nums})")
        check("95% CI" in page.locator(".r-ci-text").first.inner_text(), "each bar has its 95% interval")
        page.locator("#cmp-file").set_input_files(str(OUT / "duel-maya.answers.zip"))
        page.wait_for_selector(".r-table")
        txt = page.locator("#agree").inner_text()
        pairs = [("A", "B"), ("A", "A"), ("A", "A"), ("B", "A"), ("B", "B"), ("unsure", "unsure")]
        po = 4 / 6; cats = ["A", "B", "unsure"]
        pe = sum(sum(1 for a, _ in pairs if a == c) * sum(1 for _, b in pairs if b == c) for c in cats) / 36
        kap = (po - pe) / (1 - pe)
        check("67%" in txt and f"{kap:.2f}" in txt, f"agreement 67% and Cohen's kappa {kap:.2f} ({txt.splitlines()[0]})")
        check(page.locator(".r-diffs .chip").count() == 2, "the two disagreements are listed")
        page.screenshot(path=OUT / "32_results.png", full_page=True)
        page.locator(".r-diffs .chip").first.click(); page.wait_for_selector(".card canvas")
        check("Back" in page.locator("[data-act=back]").inner_text(), "a disagreement opens that card")

        print("backup and restore")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.locator("[data-act=settings]").click()
        with page.expect_download() as dl:
            page.get_by_role("button", name="Back up answers (small)").click()
        small = OUT / "backup-small.zip"; dl.value.save_as(small)
        with zipfile.ZipFile(small) as z:
            man = json.loads(z.read("hooman-backup.json"))
        n_ans = sum(len(d["answers"]) for d in man["decks"])
        check(man["hooman_backup"] == 1 and len(man["decks"]) >= 5 and n_ans >= 12, f"the backup holds every deck's answers ({len(man['decks'])} decks, {n_ans} answers)")
        page.keyboard.press("Escape")
        page.locator("[data-act=settings]").click()
        with page.expect_download() as dl:
            page.get_by_role("button", name="Back up everything, with images").click()
        full = OUT / "backup-full.zip"; dl.value.save_as(full)
        page.keyboard.press("Escape")

        ctx2 = phone(browser); p2 = ctx2.new_page(); watch(p2, errors)
        p2.goto(base); p2.wait_for_selector(".hero")
        import_example(p2, "Model A vs model B")
        p2.goto(base + "#/"); p2.wait_for_selector(".hero")
        p2.locator("#file").set_input_files(str(small))
        p2.wait_for_selector(".sheet h3:has-text('Restored')")
        t = p2.locator(".sheet").inner_text()
        check("6 new answers" in t and "Not restored" in t, "an answers-only backup restores into decks that are here, and names the missing ones")
        p2.get_by_role("button", name="OK").click()
        p2.locator("#file").set_input_files(str(small)); p2.wait_for_selector(".sheet h3:has-text('Restored')")
        check("0 new answers, 0 newer" in p2.locator(".sheet").inner_text(), "restoring twice adds nothing")
        p2.get_by_role("button", name="OK").click()
        ctx2.close()

        ctx3 = phone(browser); p3 = ctx3.new_page(); watch(p3, errors)
        p3.goto(base); p3.wait_for_selector(".hero")
        p3.locator("#file").set_input_files(str(full))
        p3.wait_for_selector(".sheet h3:has-text('Restored')", timeout=30000)
        check(p3.locator(".sheet").inner_text().count("added to this device") >= 5, "a full backup brings back the decks themselves")
        p3.get_by_role("button", name="OK").click(); p3.wait_for_selector(".deckrow")
        p3.goto(base + "#/deck/example-follow"); p3.wait_for_timeout(800); dismiss_tour(p3)
        if p3.locator(".tapper").count(): p3.locator(".tapper [data-t=cancel]").click()
        p3.wait_for_timeout(300)
        check(p3.locator("#count").inner_text().startswith("2 /"), "restored answers show up in the deck")
        ctx3.close()

        ctx4 = phone(browser); p4 = ctx4.new_page(); watch(p4, errors)
        p4.goto(base); p4.wait_for_selector(".hero")
        import_example(p4, "Model A vs model B")
        p4.goto(base + "#/"); p4.wait_for_selector(".hero")
        p4.locator("#file").set_input_files(str(OUT / "duel-me.answers.zip"))
        p4.wait_for_selector(".sheet h3:has-text('Restored')")
        check("6 new answers" in p4.locator(".sheet").inner_text(), "a deck's own .answers.zip restores into that deck")
        ctx4.close()

        print("findings from real use: provenance, guides, bold, captions, storage, copy for the AI")
        with zipfile.ZipFile(ROOT / "app" / "examples" / "nuclei.hooman.zip") as z:
            model = np.asarray(Image.open(io.BytesIO(z.read("model/field1.png"))))
        cen = lambda m: (float(np.nonzero(m)[1].mean()) + 0.5, float(np.nonzero(m)[0].mean()) + 0.5)
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        import_example(page, "Fix the nuclei")
        page.keyboard.press("ArrowUp"); page.wait_for_selector(".editor canvas"); page.wait_for_timeout(400)
        page.locator("[data-from=model]").click(); page.wait_for_timeout(300)
        page.locator("[data-tool=merge]").click()
        tap(page, ".editor", *cen(model == 8), wait=150); tap(page, ".editor", *cen(model == 100), wait=150)
        page.locator("[data-e=done]").click(); page.wait_for_timeout(600)
        _, data, _ = export(page, "example-nuclei", "nuclei.answers.zip")
        fx = next(a for a in data["answers"] if a["answer"] == "fixed")
        merged = [o for o in fx["objects"] if o.get("from_values") == [8, 100]]
        untouched = [o for o in fx["objects"] if o.get("from") == "model" and not o.get("edits")]
        check(fx.get("from") == ["model"], f"the answer says it started from the model ({fx.get('from')})")
        check(len(merged) == 1 and "merge" in merged[0].get("edits", []) and merged[0].get("from") == "model",
              f"the merged object keeps the model's two numbers and the 'merge' edit ({merged})")
        check(len(untouched) == len(fx["objects"]) - 1, "the objects taken as they were have no edits")

        gz = io.BytesIO()
        lab = np.zeros((64, 64), np.uint8); lab[10:25, 10:25] = 1; lab[35:55, 30:50] = 2
        with zipfile.ZipFile(gz, "w") as z:
            z.writestr("deck.json", json.dumps({"hooman": 1, "id": "t-guide", "question": "Is the bold one right?",
                "sources": {"m": {"label": "Model"}, "look": {"guide": True}},
                "answers": {"right": "Yes", "left": "No", "up": {"label": "Fix", "then": "draw"}},
                "cards": [{"id": "c1", "image": "a.png", "info": "a long caption " * 6,
                           "overlays": [{"source": "look", "box": [5, 5, 26, 26]}, {"source": "m", "mask": "m.png"},
                                        {"source": "m", "mask": "m.png", "value": 1, "style": "bold"}]},
                          {"id": "c2", "image": "a.png"}]}))
            z.writestr("a.png", png1(64, 64)); b2 = io.BytesIO(); Image.fromarray(lab).save(b2, "PNG"); z.writestr("m.png", b2.getvalue())
        (OUT / "t-guide.zip").write_bytes(gz.getvalue())
        ctx6 = phone(browser, permissions=["clipboard-read", "clipboard-write"]); p6 = ctx6.new_page(); watch(p6, errors)
        p6.goto(base); p6.wait_for_selector(".hero")
        p6.locator("#file").set_input_files(str(OUT / "t-guide.zip"))
        expect(p6.locator(".sheet h3")).to_contain_text("Ready", timeout=10000)
        p6.get_by_role("button", name="Open the deck").click(); p6.wait_for_selector(".card canvas"); p6.wait_for_timeout(300); dismiss_tour(p6)
        check(p6.locator("#chips .chip").count() == 2 and p6.locator("#chips [data-src=look]").count() == 0, "a guide gets no model chip")
        p6.screenshot(path=OUT / "35_guide_bold.png")
        p6.locator(".cardfoot .caption").click()
        check(("a long caption " * 6).strip() in p6.locator(".sheet").inner_text(), "tapping the caption shows it in full")
        p6.keyboard.press("Escape")
        p6.keyboard.press("ArrowUp"); p6.wait_for_selector(".editor canvas"); p6.wait_for_timeout(300)
        check(p6.locator("[data-from=look]").count() == 0 and p6.locator("[data-from=m]").count() == 1 and p6.locator(".editor [data-src=look]").count() == 0,
              "the editor offers 'Start from Model' but not the guide")
        p6.locator("[data-e=cancel]").click(); p6.wait_for_timeout(200)
        p6.keyboard.press("ArrowRight"); p6.wait_for_timeout(450)
        p6.locator("[data-act=menu]").click(); p6.locator(".sheet [data-m=export]").click()
        p6.get_by_role("button", name="Copy for the AI (CSV text, no masks)").click(); p6.wait_for_timeout(300)
        clip = p6.evaluate("navigator.clipboard.readText()")
        check(clip.startswith('Answers from the app "Hooman in the Loop" for deck "t-guide"') and "card_id,image,answer" in clip and "\nc1,a.png,yes," in clip,
              "Copy for the AI puts the answers on the clipboard as CSV text")
        ctx6.close()

        ctx7 = phone(browser); ctx7.add_init_script("navigator.storage.estimate = async () => ({ quota: 200000, usage: 0 });")
        p7 = ctx7.new_page(); p7.goto(base); p7.wait_for_selector(".hero")
        tap_add(p7, "examples")
        p7.locator(".example", has_text="Model A vs model B").click()
        p7.wait_for_selector(".errors li", timeout=20000)
        check("needs about" in p7.locator(".sheet").inner_text(), "the importer refuses a deck that won't fit in the free storage")
        ctx7.close()

        print("colour-blind mode")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.locator("[data-act=settings]").click()
        page.locator("[data-col=cb]").click(); page.keyboard.press("Escape")
        page.goto(base + "#/deck/example-duel"); page.wait_for_selector(".card canvas"); page.wait_for_timeout(300)
        left = page.locator(".ans", has_text="A is right").evaluate("e => getComputedStyle(e).borderColor")
        check(left == "rgb(255, 159, 28)", f"model A turns orange, not red ({left})")
        page.screenshot(path=OUT / "33_colourblind.png")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.locator("[data-act=settings]").click(); page.locator("[data-col=standard]").click(); page.keyboard.press("Escape")
        page.goto(base + "#/deck/example-duel"); page.wait_for_selector(".card canvas")
        left = page.locator(".ans", has_text="A is right").evaluate("e => getComputedStyle(e).borderColor")
        check(left == "rgb(255, 93, 108)", f"standard colours come back unchanged ({left})")

        print("iPhone warning")
        ctx5 = browser.new_context(user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
                                   viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, service_workers="block")
        p5 = ctx5.new_page(); p5.goto(base); p5.wait_for_selector(".hero")
        check("Home Screen" in p5.locator(".banner").first.inner_text(), "iPhone Safari users are told to add the app to the Home Screen")
        p5.screenshot(path=OUT / "34_iphone_banner.png")
        ctx5.close()

        check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; screenshots in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
