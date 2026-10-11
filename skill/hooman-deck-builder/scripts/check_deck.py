"""Check a Hooman in the Loop deck the way the app will, before the hooman imports it.

    python check_deck.py my.hooman.zip          # prints the problems (same wording as the app), exit 1 if any

Only the Python standard library is needed. Mirrors the app's import rules (deck.js + importer.js):
structure, answers, sources, channels, paths (case-sensitive, with "did you mean"), image types and
sizes, masks the size of their image, channel images the size of their frame.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from hooman import image_size  # noqa: E402

TOP = {"hooman", "id", "title", "question", "help", "answers", "buttons", "sources", "classes", "shuffle", "cards", "mode", "frames_are", "channels", "channel_view"}
CARD = {"id", "image", "frames", "question", "info", "focus", "overlays", "start", "channels"}
OVERLAY = {"box", "point", "polygon", "mask", "source", "label", "value", "style", "frame"}
THEN = {"draw", "point", "points", "number", "text"}
DIRS = ("right", "left", "up", "down")
q = json.dumps


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and x == x and abs(x) != float("inf")


def _near(path, names):
    low, base = path.lower(), path.rsplit("/", 1)[-1]
    for n in names:
        if n.lower() == low:
            return n
    for n in names:
        if n.rsplit("/", 1)[-1] == base:
            return n
    return None


def check_files(deck, files: dict):
    """deck: the parsed deck.json; files: {path: bytes} relative to deck.json. Returns (errors, warnings)."""
    E, W = [], []
    names = list(files)
    sizes = {}

    def need(path, where):
        if not isinstance(path, str) or not path.strip():
            E.append(f'{where}: must be a file path like "img/001.jpg"'); return None
        p = path.strip()
        if re.match(r"https?://", p, re.I):
            return p
        if p.lower().endswith((".tif", ".tiff")):
            E.append(f"{where}: {q(p)} is a TIFF; phones can't show TIFF. Convert it to PNG (llms.txt recipe 7.4)"); return None
        if p not in files:
            near = _near(p, names)
            E.append(f"{where}: {q(p)} is not in the zip" + (f" (did you mean {q(near)}?)" if near else "")); return None
        if p not in sizes:
            sizes[p] = image_size(files[p])
            if sizes[p] is None:
                E.append(f"{where}: {q(p)} is not a JPEG, PNG, WebP or GIF image"); return None
            if sizes[p][2] == "tiff":
                E.append(f"{where}: {q(p)} is a TIFF; phones can't show TIFF. Convert it to PNG (llms.txt recipe 7.4)"); return None
        return p if sizes.get(p) else None

    if not isinstance(deck, dict):
        return ['deck.json: must be a JSON object like {"hooman": 1, "question": "...", "cards": [...]}'], W
    if deck.get("hooman") != 1:
        E.append('deck.json: add "hooman": 1 (the format version) at the top' if "hooman" not in deck else f'deck.json: "hooman" is {q(deck["hooman"])}, but the app reads format 1')
    for k in deck:
        if k not in TOP:
            W.append(f"deck.json: unknown field {q(k)} is ignored")
    if "id" in deck and not (isinstance(deck["id"], str) and re.fullmatch(r"[A-Za-z0-9._-]{1,64}", deck["id"])):
        E.append(f'deck.json: "id" {q(deck["id"])} may only use letters, digits, ".", "_" and "-" (1-64 characters)')
    mode = deck.get("mode") or ("swipe" if deck.get("question") else "annotate")
    if mode not in ("swipe", "annotate", "follow"):
        E.append('deck.json: "mode" must be "swipe", "annotate" or "follow"')
    if deck.get("frames_are") not in (None, "channels", "time"):
        E.append('deck.json: "frames_are" must be "channels" or "time"')
    if isinstance(deck.get("question"), str) and len(deck["question"]) > 120:
        W.append(f"deck.json: the question is {len(deck['question'])} characters; about 120 fit on a phone (3 lines)")

    sources = deck.get("sources", {})
    if not isinstance(sources, dict):
        E.append('deck.json: "sources" must be an object like {"A": {"color": "#ff5d6c"}}'); sources = {}

    def answer(v, where):
        if isinstance(v, str) and v.strip():
            return
        if not isinstance(v, dict) or not isinstance(v.get("label"), str) or not v["label"].strip():
            E.append(f'{where}: needs a "label", for example {{"label": "Yes", "value": "yes"}}'); return
        for k in v:
            if k not in ("label", "value", "then", "color", "celebrate"):
                W.append(f"{where}: unknown field {q(k)} is ignored")
        if "then" in v and v["then"] not in THEN:
            E.append(f'{where}: "then" must be one of {", ".join(q(t) for t in sorted(THEN))}')
        if "celebrate" in v and not isinstance(v["celebrate"], bool):
            E.append(f'{where}: "celebrate" must be true or false')

    if mode == "swipe":
        ans = deck.get("answers", {"right": "Yes", "left": "No", "up": "Unsure"})
        if not isinstance(ans, dict):
            E.append('deck.json: "answers" must be an object like {"right": "Yes", "left": "No"}')
        else:
            for k, v in ans.items():
                if k not in DIRS:
                    E.append(f'answers: {q(k)} is not a direction; use "right", "left", "up" or "down" (extra answers go in "buttons")')
                elif v is not None:
                    answer(v, f"answers.{k}")
        btns = deck.get("buttons", [])
        if not isinstance(btns, list):
            E.append('deck.json: "buttons" must be a list')
        else:
            if len(btns) > 6:
                E.append(f'deck.json: "buttons" has {len(btns)} items; at most 6 fit on a phone')
            for i, b in enumerate(btns[:6]):
                answer(b, f"buttons[{i}]")

    chans = deck.get("channels")
    C = 1
    if chans is not None:
        if not isinstance(chans, list) or not 1 <= len(chans) <= 8:
            E.append('deck.json: "channels" must be a list of 1 to 8 channels, like [{"name": "nuclei"}, {"name": "body"}]')
        else:
            cn = [c if isinstance(c, str) else (c or {}).get("name") for c in chans]
            if not all(isinstance(n, str) and n for n in cn):
                E.append('deck.json: every channel needs a "name"')
            elif len(set(cn)) != len(cn):
                E.append("deck.json: the channel names must all be different")
            C = len(chans)
            cv = deck.get("channel_view")
            if cv is not None and cv not in ("mix", "side") and cv not in cn:
                E.append(f'deck.json: "channel_view" must be "mix", "side" or one channel\'s name ({", ".join(q(n) for n in cn)})')
    elif "channel_view" in deck:
        E.append('deck.json: "channel_view" must be "mix", "side" or one channel\'s name, and it needs "channels"')
    later = ", ".join(q(c if isinstance(c, str) else c.get("name")) for c in (chans or [])[1:]) if isinstance(chans, list) else ""

    def extra(lst, where):
        if lst is None:
            if C > 1:
                E.append(f'{where}: the deck has {C} "channels", so this needs "channels": [{C - 1} more image path{"s" if C > 2 else ""}] for {later}, after "image"')
            return []
        if C == 1:
            E.append(f'{where}: has "channels" but the deck doesn\'t list its channels; add "channels": [{{"name": ...}}, ...] at the top'); return []
        if not isinstance(lst, list):
            E.append(f'{where}: "channels" must be a list of image paths'); return []
        if len(lst) != C - 1:
            E.append(f'{where}: has {len(lst)} extra channel image{"" if len(lst) == 1 else "s"}, but the deck has {C} "channels", so it needs {C - 1} ({later}) after "image"')
        return [need(p, f"{where} channels[{k}]") for k, p in enumerate(lst)]

    cards = deck.get("cards")
    if not isinstance(cards, list) or not cards:
        E.append('deck.json: "cards" must be a non-empty list of image paths or card objects')
        cards = []
    seen = {}
    big = 0
    for i, c in enumerate(cards):
        at = f"cards[{i}]"
        if isinstance(c, str):
            if C > 1:
                E.append(f"{at}: a plain image path can't hold the deck's {C} channels; write {{\"image\": {q(c)}, \"channels\": [...]}} instead")
            p = need(c, at)
            frames, cid, card = [(p, [])], c, {}
        elif isinstance(c, dict):
            where = at + (f" (id {q(c['id'])})" if "id" in c else "")
            for k in c:
                if k not in CARD:
                    W.append(f"{where}: unknown field {q(k)} is ignored")
            if ("image" in c) == ("frames" in c):
                E.append(f'{where}: needs either "image" or "frames" (not both)')
            if "frames" in c and "channels" in c:
                E.append(f'{where}: with "frames", put "channels" inside each frame, not on the card')
            frames = []
            if "image" in c:
                frames = [(need(c["image"], f"{where} image"), extra(c.get("channels"), where))]
            elif isinstance(c.get("frames"), list) and c["frames"]:
                for j, f in enumerate(c["frames"]):
                    fp = f.get("image") if isinstance(f, dict) else f
                    frames.append((need(fp, f"{where} frames[{j}]"), extra(f.get("channels") if isinstance(f, dict) else None, f"{where} frames[{j}]")))
            elif "frames" in c:
                E.append(f'{where}: "frames" must be a non-empty list')
            cid, card = c.get("id", c.get("image") or (c.get("frames") or [None])[0]), c
            if isinstance(cid, dict):
                cid = cid.get("image")
            at = where
        else:
            E.append(f"{at}: must be an image path or a card object"); continue
        cid = str(cid)
        if cid in seen:
            E.append(f"{at}: id {q(cid)} is already used by cards[{seen[cid]}]; card ids must be unique")
        seen.setdefault(cid, i)
        s0 = sizes.get(frames[0][0]) if frames and frames[0][0] else None
        if s0 and max(s0[0], s0[1]) > 4096:
            big += 1
        for j, (fp, chs) in enumerate(frames):
            s = sizes.get(fp) if fp else None
            if s and s0 and j and s[:2] != s0[:2]:
                E.append(f"{at}: frames[{j}] {q(fp)} is {s[0]}×{s[1]} but frames[0] is {s0[0]}×{s0[1]}; all frames must be the same size")
            for p in chs:
                sc = sizes.get(p) if p else None
                if sc and s and sc[:2] != s[:2]:
                    E.append(f"{at}: channel image {q(p)} is {sc[0]}×{sc[1]} but its \"image\" is {s[0]}×{s[1]}; every channel must be the same size")
        if isinstance(card.get("info"), str) and len(card["info"]) > 40:
            W.append(f"{at}: info is {len(card['info'])} characters; about 40 fit on one line (the hooman can tap to read it all)")
        if "focus" in card and not (isinstance(card["focus"], list) and len(card["focus"]) == 4 and all(_num(x) for x in card["focus"]) and card["focus"][2] > 0 and card["focus"][3] > 0):
            E.append(f'{at}: "focus" must be [x, y, w, h] in pixels with w and h above 0')
        for k, o in enumerate(card.get("overlays", []) or []):
            ow = f"{at} overlays[{k}]"
            if not isinstance(o, dict):
                E.append(f'{ow}: must be an object like {{"box": [x, y, w, h]}}'); continue
            shapes = [s for s in ("box", "point", "polygon", "mask") if s in o]
            if len(shapes) != 1:
                hint = next((f' (use "box" instead of "{a}")' for a in ("bbox", "rect") if a in o), "")
                E.append(f'{ow}: needs exactly one of "box", "point", "polygon" or "mask"{hint}'); continue
            for kk in o:
                if kk not in OVERLAY:
                    W.append(f"{ow}: unknown field {q(kk)} is ignored")
            sh = shapes[0]
            if sh == "box" and not (isinstance(o["box"], list) and len(o["box"]) == 4 and all(_num(x) for x in o["box"]) and o["box"][2] > 0 and o["box"][3] > 0):
                E.append(f'{ow}: "box" must be [x, y, w, h] in pixels with w and h above 0 (got {q(o["box"])})')
            if sh == "point" and not (isinstance(o["point"], list) and len(o["point"]) == 2 and all(_num(x) for x in o["point"])):
                E.append(f'{ow}: "point" must be [x, y]')
            if sh == "polygon":
                pg = o["polygon"]
                if not (isinstance(pg, list) and len(pg) >= 3 and all(isinstance(p, list) and len(p) == 2 and all(_num(x) for x in p) for p in pg)):
                    flat = isinstance(pg, list) and all(_num(x) for x in pg)
                    E.append(f'{ow}: "polygon" must be a list of at least 3 [x, y] points' + (" (it looks flat like COCO; pair the numbers as [[x, y], ...])" if flat else ""))
            if sh == "mask":
                mp = need(o["mask"], f"{ow} mask")
                if mp and not re.match(r"https?://", mp):
                    sm = sizes.get(mp)
                    if sm and sm[2] != "png":
                        E.append(f"{ow}: mask {q(mp)} must be a PNG (it is {sm[2].upper()})")
                    elif sm and s0 and sm[:2] != s0[:2]:
                        E.append(f"{ow}: mask {q(mp)} is {sm[0]}×{sm[1]} but the image is {s0[0]}×{s0[1]}; a mask must be exactly the image size")
            if "value" in o and not (isinstance(o["value"], int) and not isinstance(o["value"], bool) and o["value"] >= 1):
                E.append(f'{ow}: "value" must be a whole number of 1 or more (the object\'s label in the mask)')
            if "style" in o and o["style"] not in ("outline", "fill", "bold"):
                E.append(f'{ow}: "style" must be "outline", "fill" or "bold"')
            if "frame" in o and not (isinstance(o["frame"], int) and 0 <= o["frame"] < max(1, len(frames))):
                E.append(f'{ow}: "frame" {q(o["frame"])} must be a frame index from 0 to {max(0, len(frames) - 1)}')
        if mode == "follow" and len(frames) < 2:
            E.append(f'{at}: a follow deck needs "frames" (at least 2 time points)')
    total = sum(len(b) for b in files.values())
    if big:
        W.append(f"{big} card(s) have images larger than 4096 px; keep the long side at 2048 px or less")
    if total > 150e6:
        W.append(f"this deck is {total / 1e6:.0f} MB; phones are happiest under about 100 MB. Split it into parts (llms.txt section 1b)")
    if len(cards) > 2000:
        W.append(f"this deck has {len(cards)} cards; split it into parts of up to about 1000 (llms.txt section 1b)")
    return E, W


def check_zip(path):
    """(errors, warnings) for a .hooman.zip, as the app would report them."""
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if not n.endswith("/") and not n.startswith("__MACOSX/")]
        root = ""
        if "deck.json" not in names:
            found = [n for n in names if n.endswith("/deck.json")]
            if len(found) == 1 and found[0].count("/") == 1:
                root = found[0][: -len("deck.json")]
            else:
                return [f"no deck.json at the top of the zip (found: {', '.join(names[:5])})"], []
        try:
            deck = json.loads(z.read(root + "deck.json").decode("utf-8-sig"))
        except json.JSONDecodeError as e:
            return [f"deck.json is not valid JSON at line {e.lineno}, column {e.colno}: {e.msg}"], []
        files = {n[len(root):]: z.read(n) for n in names if n.startswith(root) and n != root + "deck.json"}
    return check_files(deck, files)


def main(argv=None):
    argv = argv or sys.argv[1:]
    if not argv:
        print(__doc__); return 2
    bad = 0
    for p in argv:
        errs, warns = check_zip(p)
        print(f"{p}: {'OK' if not errs else f'{len(errs)} problem(s)'}" + (f", {len(warns)} warning(s)" if warns else ""))
        for e in errs:
            print(f"  ERROR   {e}")
        for w in warns:
            print(f"  warning {w}")
        bad += bool(errs)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
