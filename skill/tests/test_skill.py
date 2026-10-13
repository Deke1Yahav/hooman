"""Tests for the hooman-deck-builder skill: every builder -> schema + check_deck + a real import in the app,
check_deck vs the app on broken decks, and read_answers on an export the app made.

    python skill/tests/test_skill.py
"""
import io
import json
import pathlib
import sys
import tempfile
import zipfile

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "skill" / "hooman-deck-builder" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import hooman  # noqa: E402
from check_deck import check_zip  # noqa: E402
import read_answers  # noqa: E402
from e2e import serve, check, failures, bad_zip, png1, dismiss_tour  # noqa: E402

SCHEMA = json.loads((ROOT / "app" / "deck.schema.json").read_text(encoding="utf-8"))
OUT = pathlib.Path(tempfile.mkdtemp(prefix="hooman-skill-"))


def schema_ok(path):
    import jsonschema
    with zipfile.ZipFile(path) as z:
        jsonschema.validate(json.loads(z.read("deck.json")), SCHEMA)
    return True


def blobs(seed, n=6, S=96):
    r = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:S, 0:S]
    lab = np.zeros((S, S), np.uint16)
    for k in range(1, n + 1):
        cx, cy = r.uniform(14, S - 14, 2)
        lab[(((xx - cx) / 9) ** 2 + ((yy - cy) / 7) ** 2 <= 1) & (lab == 0)] = k
    img = (200 + (lab > 0) * 600 + r.random((S, S)) * 80).astype(np.uint16)
    return img, lab


def build_all():
    out = {}
    folder = OUT / "photos"; folder.mkdir()
    for i in range(3):
        Image.fromarray((np.random.default_rng(i).random((40, 60, 3)) * 255).astype(np.uint8)).save(folder / f"p{i}.jpg")
    Image.fromarray((np.random.default_rng(9).random((30, 30)) * 60000).astype(np.uint16)).save(folder / "raw.tif")
    out["folder"] = hooman.from_folder(folder, "Is it sharp?", OUT / "folder.hooman.zip", answers={"right": "Sharp", "left": "Blurry"})

    items = []
    for i in range(2):
        img, lab = blobs(i)
        b = lab.copy(); b[b == 2] = 0; b = np.roll(b, 2, axis=1)
        items.append((f"f{i}", img, lab, b))
    out["duel"] = hooman.model_duel(items, OUT / "duel.hooman.zip")
    out["objects"] = hooman.objects_deck([(n, im, la) for n, im, la, _ in items], OUT / "objects.hooman.zip", answers={"right": "Right", "left": "Wrong"})

    frames, A, B = [], [], []
    for t in range(3):
        img, lab = blobs(7)
        lab_t = np.roll(lab, 3 * t, axis=0)
        frames.append([np.roll(img, 3 * t, axis=0), (np.roll(img, 3 * t, axis=0) // 2).astype(np.uint16)])
        A.append(lab_t); B.append((lab_t > 0).astype(np.uint16) * np.roll(lab_t, 1, axis=1))
    out["timelapse"] = hooman.timelapse_deck(frames, OUT / "time.hooman.zip", channel_names=("nuclei", "body"), channel_colors=("#3ddc97", "#ffffff"),
                                             channel_view="mix", models={"A": A, "B": B}, cell_ids=[1, 2], guide="box",
                                             answers={"left": ("A right", "A"), "right": ("B right", "B"), "up": ("Both wrong", "both_wrong", "draw"), "down": "Unsure"})
    coco = {"images": [{"id": 1, "file_name": "p0.jpg"}], "categories": [{"id": 3, "name": "cat"}],
            "annotations": [{"image_id": 1, "category_id": 3, "bbox": [5, 5, 20, 15], "score": 0.9},
                            {"image_id": 1, "category_id": 3, "segmentation": [[30, 5, 50, 5, 50, 25, 30, 25]]}]}
    (OUT / "coco.json").write_text(json.dumps(coco))
    out["coco"] = hooman.from_coco(OUT / "coco.json", folder, OUT / "coco.hooman.zip")

    d = hooman.Deck("annotate-v1", title="Mask it").classes("cell", {"value": "debris", "color": "#f2c14e"})
    d.card(d.image(items[0][1]), id="a")
    out["annotate"] = d.save(OUT / "annotate.hooman.zip")
    f = hooman.Deck("follow-v1", mode="follow", title="Follow")
    fr = [{"name": f"t{t}", "image": f.image(frames[t][0], name=f"t/{t}.png")} for t in range(3)]
    f.card(frames=fr, id="c1", start=[40, 40, 0], overlays=[f.mask(A[t], source="seg", frame=t, name=f"seg/{t}.png") for t in range(3)])
    out["follow"] = f.save(OUT / "follow.hooman.zip")
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    from playwright.sync_api import sync_playwright, expect
    print("builders: schema + check_deck")
    decks = build_all()
    for name, path in decks.items():
        errs, warns = check_zip(path)
        check(not errs and schema_ok(path), f"{name}: passes check_deck and the schema ({pathlib.Path(path).stat().st_size // 1024} KB, {len(warns)} warnings)")
    with zipfile.ZipFile(decks["folder"]) as z:
        names = z.namelist()
    check("img/raw.png" in names or any(n.endswith("raw.png") for n in names), "a TIFF in the folder is converted to PNG")
    with zipfile.ZipFile(decks["duel"]) as z:
        dj = json.loads(z.read("deck.json"))
    check(all(any(o.get("style") == "bold" for o in c["overlays"]) and "focus" in c for c in dj["cards"]) and len(dj["cards"]) >= 2,
          f"duel: one card per disagreeing object, each with focus and a bold object ({len(dj['cards'])} cards)")
    imgs = [n for n in names]
    with zipfile.ZipFile(decks["objects"]) as z:
        check(sum(1 for n in z.namelist() if n.startswith("img/")) == 2, "objects deck stores each image once although many cards use it")
    big = hooman.Deck("big", "?")
    im = big.image(np.zeros((8, 8), np.uint8))
    for i in range(2500):
        big.card(im, id=str(i))
    parts = list(hooman.split_cards(big, 1000))
    check([len(p.cards) for p in parts] == [1000, 1000, 500] and parts[1].data["id"] == "big-part2", "split_cards makes parts of 1000")
    try:
        bad = hooman.Deck("bad", "?"); bad.card("nope.png"); bad.save(OUT / "bad.hooman.zip"); check(False, "save refuses a broken deck")
    except hooman.DeckError as e:
        check('"nope.png" is not in the zip' in str(e), "save refuses a broken deck with the app's message")

    print("check_deck says what the app says")
    ch = {"hooman": 1, "question": "?", "channels": [{"name": "a"}, {"name": "b"}]}
    cases = [
        bad_zip({"question": "?", "cards": ["a.png"]}, {"a.png": png1()}),
        bad_zip({"hooman": 1, "question": "?", "cards": ["img/A.png"]}, {"img/a.png": png1()}),
        bad_zip({"hooman": 1, "question": "?", "cards": [{"image": "a.png", "overlays": [{"mask": "m.png"}]}]}, {"a.png": png1(16, 16), "m.png": png1(8, 8)}),
        bad_zip({"hooman": 1, "question": "?", "cards": [{"image": "a.png", "overlays": [{"polygon": [1, 2, 3, 4, 5, 6]}]}]}, {"a.png": png1()}),
        bad_zip({"hooman": 1, "question": "?", "cards": ["a.png", {"image": "a.png"}]}, {"a.png": png1()}),
        bad_zip({**ch, "cards": [{"image": "x.png"}]}, {"x.png": png1()}),
        bad_zip({**ch, "cards": [{"image": "x.png", "channels": ["y.png"]}]}, {"x.png": png1(16, 16), "y.png": png1(8, 8)}),
    ]
    paths = []
    for i, data in enumerate(cases):
        pth = OUT / f"broken{i}.zip"; pth.write_bytes(data); paths.append(pth)
    from e2e import ROOT as APPROOT  # noqa: F401
    srv = serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 390, "height": 844}, service_workers="block", accept_downloads=True)
        page = ctx.new_page(); page.goto(base); page.wait_for_selector(".hero")
        for pth in paths:
            mine = check_zip(pth)[0]
            page.locator("#file").set_input_files(str(pth)); page.wait_for_selector(".errors li", timeout=10000)
            app = page.locator(".errors").first.inner_text()
            same = bool(mine) and all(e.split(": ", 1)[-1][:40] in app for e in mine[:2])
            check(same, f"{pth.name}: same message as the app ({mine[0][:70] if mine else 'none'}…)")
            page.locator(".sheet").get_by_role("button", name="Close").click()

        print("every built deck imports in the app")
        for name, path in decks.items():
            page.goto(base + "#/"); page.wait_for_selector(".hero")
            page.locator("#file").set_input_files(str(path))
            expect(page.locator(".sheet h3")).to_contain_text("Ready", timeout=20000)
            check(True, f"{name}: the app imports it")
            page.keyboard.press("Escape")

        print("read_answers on a real export")
        page.goto(base + "#/deck/duel-v1"); page.wait_for_timeout(800); dismiss_tour(page, "Tester")
        for k in ["ArrowLeft", "ArrowRight", "ArrowDown"]:
            page.keyboard.press(k); page.wait_for_timeout(450)
        page.keyboard.press("ArrowUp"); page.wait_for_selector(".editor canvas"); page.wait_for_timeout(300)
        page.locator("[data-from=A]").click(); page.wait_for_timeout(300)
        page.locator("[data-e=done]").click(); page.wait_for_timeout(600)
        page.locator("[data-act=menu]").click(); page.locator(".sheet [data-m=export]").click()
        with page.expect_download() as dl:
            page.get_by_role("button", name="Share or save the .zip").click()
        exp = OUT / "duel.answers.zip"; dl.value.save_as(exp)
        b.close()
    srv.shutdown()
    data = read_answers.load(exp)
    s = read_answers.summary(data)
    check("4 of" in s and "95% CI" in s and "by Tester" in s, "summary: counts, intervals and the annotator")
    ms = list(read_answers.masks(exp))
    check(len(ms) == 1 and list(ms[0][1].values())[0].max() >= 1, "masks(): the drawn mask comes back as a label array")
    other = json.loads(json.dumps(data)); other["annotator"] = "Maya"; other["answers"][0]["answer"] = "unsure"
    zb = io.BytesIO()
    with zipfile.ZipFile(zb, "w") as z: z.writestr("answers.json", json.dumps(other))
    (OUT / "maya.answers.zip").write_bytes(zb.getvalue())
    agr = read_answers.agreement([data, read_answers.load(OUT / "maya.answers.zip")])
    check("Tester vs Maya: 4 cards, 75% agree" in agr, f"agreement between two exports ({agr.splitlines()[0].strip()})")
    n = read_answers.write_csv([data], OUT / "joined.csv")
    check(n == 4, "joined CSV has one row per answer")

    print("read_answers on a decks folder (results/, status table, processed ledger)")
    folder = OUT / "decks"; (folder / "results").mkdir(parents=True, exist_ok=True)
    (folder / "results" / "example-duel.Tester.answers.zip").write_bytes(exp.read_bytes())
    (folder / "results" / "hooman-status.Tester.json").write_text(json.dumps({"hooman_status": 1, "annotator": "Tester", "app": "test", "updated_at": "now",
        "decks": [{"deck": "example-duel", "state": "in progress", "answered": 4, "cards": 30, "new_since_processed": None, "last_answer_at": "x"}]}))
    found = read_answers.answers_files(folder)
    check([p.name for p in found] == ["example-duel.Tester.answers.zip"], "a folder: the answers in results/ are found")
    st = read_answers.status_text(read_answers.status_tables(folder))
    check("example-duel" in st and "in progress" in st, "the app's status table is read")
    datas = [read_answers.load(p) for p in found]
    check(len(read_answers.only_new(datas[0], read_answers.read_ledger(folder))["answers"]) == 4, "before processing, every answer is new")
    read_answers.mark_processed(folder, datas, "test")
    led = read_answers.read_ledger(folder)
    check((folder / "results" / "processed.json").exists() and led["files"]["example-duel.Tester.answers.zip"]["answers"] == 4,
          "--mark-processed writes results/processed.json")
    check(len(read_answers.only_new(datas[0], led)["answers"]) == 0, "after processing, nothing is new")
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        read_answers.main([str(folder), "--new"])
    check("since they were last processed" in buf.getvalue() and "0 of" in buf.getvalue(), "the --new command line works on a folder")
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; files in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
