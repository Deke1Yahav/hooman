"""Builds the example decks in app/examples/ (synthetic images, no licences needed).

Written the way an LLM would build a deck from llms.txt: numpy + Pillow + zipfile.
Each deck.json is checked against app/deck.schema.json.

    python tools/make_examples.py
"""
import io
import json
import math
import pathlib
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "examples"
rng = np.random.default_rng(7)


def png_bytes(arr_or_img):
    im = arr_or_img if isinstance(arr_or_img, Image.Image) else Image.fromarray(arr_or_img)
    b = io.BytesIO()
    im.save(b, "PNG", optimize=True)
    return b.getvalue()


def jpg_bytes(img, q=85):
    b = io.BytesIO()
    img.convert("RGB").save(b, "JPEG", quality=q)
    return b.getvalue()


def write_deck(name, deck, files):
    check(deck)
    OUT.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT / name, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("deck.json", json.dumps(deck, indent=1))
        for path, data in files.items():
            z.writestr(path, data, compress_type=zipfile.ZIP_STORED if path.endswith((".png", ".jpg")) else zipfile.ZIP_DEFLATED)
    print(f"{name}: {len(deck['cards'])} cards, {(OUT / name).stat().st_size // 1024} KB")


def check(deck):
    try:
        import jsonschema
    except ImportError:
        return
    schema = json.loads((ROOT / "app" / "deck.schema.json").read_text(encoding="utf-8"))
    jsonschema.validate(deck, schema)


# ---------------------------------------------------------------- 1. minimal yes/no
def shapes_deck():
    files, cards = {}, []
    kinds = ["circle", "square", "triangle", "circle", "star", "circle", "square", "circle", "triangle", "circle", "hexagon", "circle"]
    for i, kind in enumerate(kinds):
        hue = rng.integers(0, 360)
        bg = Image.new("RGB", (360, 360), tuple(int(x) for x in hsv(hue, 0.25, 0.95)))
        d = ImageDraw.Draw(bg)
        col = tuple(int(x) for x in hsv((hue + 180) % 360, 0.7, 0.75))
        cx, cy, r = 180 + rng.integers(-40, 40), 180 + rng.integers(-40, 40), rng.integers(70, 110)
        if kind == "circle":
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
        elif kind == "square":
            d.rectangle([cx - r, cy - r, cx + r, cy + r], fill=col)
        else:
            n = {"triangle": 3, "star": 10, "hexagon": 6}[kind]
            pts = []
            for k in range(n):
                rr = r if kind != "star" or k % 2 == 0 else r * 0.45
                t = -math.pi / 2 + 2 * math.pi * k / n
                pts.append((cx + rr * math.cos(t), cy + rr * math.sin(t)))
            d.polygon(pts, fill=col)
        path = f"img/{i + 1:03d}.jpg"
        files[path] = jpg_bytes(bg)
        cards.append(path)
    deck = {"hooman": 1, "id": "example-circles", "title": "Example · Is it a circle?", "question": "Is this a circle?",
            "answers": {"right": {"label": "Yes", "celebrate": True}, "left": "No", "up": "Unsure"}, "cards": cards}
    write_deck("circles.hooman.zip", deck, files)


def hsv(h, s, v):
    import colorsys
    return [255 * x for x in colorsys.hsv_to_rgb(h / 360, s, v)]


# ---------------------------------------------------------------- 2. model A vs model B
def blob_image(n_cells, size=384, seed=0):
    r = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size]
    labels = np.zeros((size, size), np.uint16)
    centers = []
    k = 0
    tries = 0
    while k < n_cells and tries < 2000:
        tries += 1
        cx, cy = r.uniform(40, size - 40, 2)
        if any(math.hypot(cx - a, cy - b) < 50 for a, b in centers):
            continue
        a, b, t = r.uniform(18, 30), r.uniform(14, 22), r.uniform(0, math.pi)
        X, Y = (xx - cx) * math.cos(t) + (yy - cy) * math.sin(t), -(xx - cx) * math.sin(t) + (yy - cy) * math.cos(t)
        inside = (X / a) ** 2 + (Y / b) ** 2 <= 1 + 0.12 * np.sin(5 * np.arctan2(Y, X) + r.uniform(0, 6))
        inside &= labels == 0
        k += 1
        labels[inside] = k
        centers.append((cx, cy))
    img = np.where(labels > 0, 0.75, 0.12) + 0.05 * r.standard_normal((size, size))
    img = np.asarray(Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.2)), float) / 255
    img += 0.04 * r.standard_normal((size, size))
    return (np.clip(img, 0, 1) * 255).astype(np.uint8), labels


def grow(mask, px):
    im = Image.fromarray(mask.astype(np.uint8) * 255)
    im = im.filter(ImageFilter.MaxFilter(2 * abs(px) + 1) if px > 0 else ImageFilter.MinFilter(2 * abs(px) + 1))
    return np.asarray(im) > 0


def model_masks(gt, seed):
    """Two imperfect 'models': each object is grown, shrunk, missed, cut or kept."""
    r = np.random.default_rng(seed)
    a, b = np.zeros_like(gt), np.zeros_like(gt)
    for k in range(1, gt.max() + 1):
        obj = gt == k
        for out, (miss, cut) in ((a, (0.08, 0.12)), (b, (0.12, 0.08))):
            u = r.random()
            if u < miss:
                continue
            m = obj.copy()
            if u < miss + cut:                          # cut in half: two objects instead of one
                ys, xs = np.nonzero(obj)
                half = xs < xs.mean()
                m1 = np.zeros_like(obj); m1[ys[half], xs[half]] = True
                m2 = obj & ~m1
                out[m1 & (out == 0)] = k
                out[m2 & (out == 0)] = 1000 + k
                continue
            m = grow(m, int(r.choice([-3, -2, 0, 0, 0, 2, 4])))
            out[m & (out == 0)] = k
    return a, b


def iou(x, y):
    u = (x | y).sum()
    return (x & y).sum() / u if u else 1.0


def duel_deck():
    files, cards = {}, []
    for im_i in range(3):
        img, gt = blob_image(12, seed=10 + im_i)
        ma, mb = model_masks(gt, seed=100 + im_i)
        name = f"field{im_i + 1}"
        files[f"img/{name}.png"] = png_bytes(img)
        files[f"A/{name}.png"] = png_bytes(ma)
        files[f"B/{name}.png"] = png_bytes(mb)
        for k in range(1, gt.max() + 1):
            obj = gt == k
            best = lambda m: max([iou(obj, m == v) for v in np.unique(m[obj]) if v] or [0])
            ia, ib = best(ma), best(mb)
            if abs(ia - ib) < 0.04 and min(ia, ib) > 0.85:
                continue                                  # the models agree: no card
            ys, xs = np.nonzero(obj)
            x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
            cards.append({
                "id": f"{name}_cell{k}", "image": f"img/{name}.png", "focus": [x0, y0, x1 - x0, y1 - y0],
                "info": f"{name} · cell {k}",
                "overlays": [{"source": "A", "mask": f"A/{name}.png"}, {"source": "B", "mask": f"B/{name}.png"},
                             {"source": "this cell", "point": [round(float(xs.mean()), 1), round(float(ys.mean()), 1)]}],
            })
    deck = {
        "hooman": 1, "id": "example-duel", "title": "Example · Model A vs model B",
        "question": "Which model outlined the marked cell right?",
        "help": "Red outlines are model A, green outlines are model B. The yellow ring marks the cell this card is about. Tap the chips to hide one model.",
        "sources": {"A": {"label": "Model A", "color": "#ff5d6c"}, "B": {"label": "Model B", "color": "#3ddc97"},
                    "this cell": {"label": "This cell", "color": "#f2c14e"}},
        "answers": {"left": {"label": "A is right", "value": "A"}, "right": {"label": "B is right", "value": "B"},
                    "up": {"label": "Both wrong", "value": "both_wrong", "then": "draw"}, "down": "Unsure"},
        "buttons": [{"label": "Not a cell", "value": "not_a_cell"}],
        "cards": cards,
    }
    write_deck("duel.hooman.zip", deck, files)


# ---------------------------------------------------------------- 3. boxes + labels + extra buttons
def boxes_deck():
    files, cards = {}, []
    kinds = ["circle", "square", "triangle"]
    for im_i in range(6):
        W, H = 480, 320
        bg = Image.new("RGB", (W, H), (236, 232, 222))
        d = ImageDraw.Draw(bg)
        for _ in range(300):
            x, y = rng.integers(0, W), rng.integers(0, H)
            d.point((int(x), int(y)), fill=(200, 196, 186))
        placed = []
        for j in range(int(rng.integers(2, 4))):
            for _ in range(50):
                r = int(rng.integers(30, 52))
                cx, cy = int(rng.integers(r + 10, W - r - 10)), int(rng.integers(r + 10, H - r - 10))
                if all(math.hypot(cx - a, cy - b) > r + rr + 16 for a, b, rr in placed):
                    break
            placed.append((cx, cy, r))
            kind = kinds[int(rng.integers(0, 3))]
            col = tuple(int(x) for x in hsv(int(rng.integers(0, 360)), 0.65, 0.7))
            if kind == "circle":
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
            elif kind == "square":
                d.rectangle([cx - r, cy - r, cx + r, cy + r], fill=col)
            else:
                d.polygon([(cx, cy - r), (cx + r, cy + r * 0.8), (cx - r, cy + r * 0.8)], fill=col)
            guess = kind if rng.random() < 0.7 else kinds[(kinds.index(kind) + 1) % 3]
            pad = int(rng.choice([2, 4, 6, 18, -8]))
            box = [cx - r - pad, cy - r - pad, 2 * (r + pad), 2 * (r + pad)]
            score = round(float(rng.uniform(0.55, 0.97)), 2)
            cards.append({"id": f"photo{im_i + 1}_det{j + 1}", "image": f"img/photo{im_i + 1}.jpg",
                          "focus": box, "info": f"detector says {guess} ({score})",
                          "overlays": [{"source": "detector", "box": box, "label": f"{guess} {score}"}]})
        files[f"img/photo{im_i + 1}.jpg"] = jpg_bytes(bg)
    deck = {
        "hooman": 1, "id": "example-boxes", "title": "Example · Check a detector",
        "question": "Is the detector's label right?",
        "sources": {"detector": {"label": "Detector", "color": "#4fc3f7"}},
        "answers": {"right": {"label": "Correct", "celebrate": True}, "left": "Wrong label", "up": "Unsure"},
        "buttons": ["Box too loose", "Box too tight"],
        "shuffle": True,
        "cards": cards,
    }
    write_deck("boxes.hooman.zip", deck, files)


# ---------------------------------------------------------------- 4. time-lapse frames + per-frame points
def timelapse_deck():
    files, cards = {}, []
    S = 256
    for t_i in range(4):
        r = np.random.default_rng(300 + t_i)
        n = 7
        pos = r.uniform(50, S - 50, (n, 2))
        vel = r.uniform(-9, 9, (n, 2))
        frames, labs = [], []
        yy, xx = np.mgrid[0:S, 0:S]
        for f in range(3):
            p = pos + vel * f
            lab = np.zeros((S, S), np.uint8)
            for k, (cx, cy) in enumerate(p, 1):
                lab[((xx - cx) / 17) ** 2 + ((yy - cy) / 13) ** 2 <= 1] = k
            img = np.where(lab > 0, 0.7, 0.1) + 0.05 * r.standard_normal((S, S))
            img = np.asarray(Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.6)))
            frames.append(img); labs.append(lab)
        # the tracker follows cell 1, but on some cards it jumps to the nearest other cell in the last frame
        jump = t_i in (1, 3)
        track = []
        for f in range(3):
            p = pos + vel * f
            k = 0
            if jump and f == 2:
                d = np.hypot(*(p - p[0]).T); d[0] = 1e9; k = int(d.argmin())
            track.append(p[k])
        name = f"movie{t_i + 1}"
        frame_list = []
        for f in range(3):
            files[f"img/{name}_t{f}.png"] = png_bytes(frames[f])
            files[f"masks/{name}_t{f}.png"] = png_bytes(labs[f])
            frame_list.append({"image": f"img/{name}_t{f}.png", "name": ["t-1", "t", "t+1"][f]})
        overlays = [{"source": "segmentation", "mask": f"masks/{name}_t{f}.png", "frame": f} for f in range(3)]
        overlays += [{"source": "tracker", "point": [round(float(x), 1), round(float(y), 1)], "frame": f, "label": "track 1"} for f, (x, y) in enumerate(track)]
        cards.append({"id": f"{name}_track1", "frames": frame_list, "info": f"{name} · track 1", "overlays": overlays})
    deck = {
        "hooman": 1, "id": "example-timelapse", "title": "Example · Follow a track",
        "question": "Does the tracker stay on the same cell in all 3 frames?",
        "help": "Use the frame buttons under the image, or ▶ to play. The ring is where the tracker thinks the cell is.",
        "sources": {"tracker": {"label": "Tracker", "color": "#f2c14e"}, "segmentation": {"label": "Cells", "color": "#4fc3f7"}},
        "answers": {"right": "Same cell", "left": "It jumps", "up": "Unsure"},
        "cards": cards,
    }
    write_deck("timelapse.hooman.zip", deck, files)


# ---------------------------------------------------------------- 5. annotate (no question) with classes
def fruit_deck():
    files, cards = {}, []
    kinds = {"apple": (205, 45, 50), "orange": (240, 140, 30), "leaf": (70, 150, 60)}
    for im_i in range(5):
        W, H = 400, 300
        img = Image.new("RGB", (W, H), (120, 86, 60))
        d = ImageDraw.Draw(img)
        for y in range(0, H, 6):
            d.line([(0, y), (W, y + int(rng.integers(-3, 3)))], fill=(112 + int(rng.integers(0, 12)), 80, 56))
        placed, overlays = [], []
        for j in range(int(rng.integers(3, 6))):
            kind = ["apple", "orange", "leaf"][int(rng.integers(0, 3))]
            for _ in range(60):
                r = int(rng.integers(24, 40))
                cx, cy = int(rng.integers(r + 6, W - r - 6)), int(rng.integers(r + 6, H - r - 6))
                if all(math.hypot(cx - a, cy - b) > r + rr + 6 for a, b, rr in placed):
                    break
            placed.append((cx, cy, r))
            col = kinds[kind]
            if kind == "leaf":
                pts = [(cx - r, cy), (cx - r * 0.2, cy - r * 0.6), (cx + r, cy - r * 0.1), (cx + r * 0.1, cy + r * 0.55)]
                d.polygon(pts, fill=col)
            else:
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
                d.ellipse([cx - r * 0.45, cy - r * 0.6, cx - r * 0.05, cy - r * 0.25], fill=tuple(min(255, c + 50) for c in col))
            if rng.random() < 0.6:                       # a rough model guess the hooman can start from
                if rng.random() < 0.5:
                    pad = int(rng.integers(-4, 8))
                    overlays.append({"source": "model", "box": [cx - r - pad, cy - r - pad, 2 * (r + pad), 2 * (r + pad)], "label": kind})
                else:
                    poly = [[round(cx + r * 0.9 * math.cos(t), 1), round(cy + r * 0.9 * math.sin(t), 1)] for t in np.linspace(0, 2 * math.pi, 9)[:-1]]
                    overlays.append({"source": "model", "polygon": poly, "label": kind})
        path = f"img/table{im_i + 1}.jpg"
        files[path] = jpg_bytes(img)
        card = {"id": f"table{im_i + 1}", "image": path, "info": "draw every fruit and leaf"}
        if overlays:
            card["overlays"] = overlays
        cards.append(card)
    deck = {
        "hooman": 1, "id": "example-fruit", "title": "Example · Mask the fruit",
        "help": "No question here: every card opens the mask editor. Pick a class, draw each object, tap + New object between objects. 'Start from model' copies the model's rough guesses.",
        "sources": {"model": {"label": "Model guess", "color": "#4fc3f7"}},
        "classes": [{"value": "apple", "color": "#ff5d6c"}, {"value": "orange", "color": "#ffa94d"}, {"value": "leaf", "color": "#3ddc97"}],
        "cards": cards,
    }
    write_deck("fruit.hooman.zip", deck, files)


# ---------------------------------------------------------------- 6. raw 16-bit microscopy, 2 channels
def nuclei_deck():
    """Dim 12-bit nuclei + a membrane channel, saved as raw 16-bit PNGs; a model mask with typical mistakes."""
    files, cards = {}, []
    S = 320
    yy, xx = np.mgrid[0:S, 0:S]
    for f_i in range(3):
        r = np.random.default_rng(500 + f_i)
        gt = np.zeros((S, S), np.uint16)
        centers = []
        k = 0
        while k < 14:
            cx, cy = r.uniform(25, S - 25, 2)
            if any(math.hypot(cx - a, cy - b) < 30 for a, b in centers):
                continue
            a, b, t = r.uniform(11, 17), r.uniform(9, 13), r.uniform(0, math.pi)
            X, Y = (xx - cx) * math.cos(t) + (yy - cy) * math.sin(t), -(xx - cx) * math.sin(t) + (yy - cy) * math.cos(t)
            m = ((X / a) ** 2 + (Y / b) ** 2 <= 1) & (gt == 0)
            k += 1; gt[m] = k; centers.append((cx, cy))
        # nuclei: dim (a 12-bit camera, ~300 counts over a 200 background), textured
        nuc = 200 + 30 * r.standard_normal((S, S))
        tex = np.asarray(Image.fromarray((r.random((S // 4, S // 4)) * 255).astype(np.uint8)).resize((S, S), Image.BICUBIC), float) / 255
        nuc += (gt > 0) * (220 + 160 * tex)
        from scipy.ndimage import gaussian_filter
        nuc = gaussian_filter(nuc, 1.2)
        # membrane: rings around each nucleus
        mem = 150 + 20 * r.standard_normal((S, S))
        for (cx, cy) in centers:
            d = np.hypot(xx - cx, yy - cy)
            mem += 260 * np.exp(-((d - 21) ** 2) / 8)
        # model: two touching nuclei merged, one missed, one split
        model = gt.copy()
        model[model == 2] = 1
        model[model == 5] = 0
        ys, xs = np.nonzero(gt == 8)
        if len(xs):
            left = xs < xs.mean(); model[ys[left], xs[left]] = 100
        name = f"field{f_i + 1}"
        files[f"img/{name}_dapi.png"] = png_bytes(np.clip(nuc, 0, 4095).astype(np.uint16))
        files[f"img/{name}_membrane.png"] = png_bytes(np.clip(mem, 0, 4095).astype(np.uint16))
        files[f"model/{name}.png"] = png_bytes(model)
        cards.append({"id": name, "frames": [{"image": f"img/{name}_dapi.png", "name": "DAPI"}, {"image": f"img/{name}_membrane.png", "name": "Membrane"}],
                      "info": f"{name} · raw 12-bit in 16-bit PNG", "overlays": [{"source": "model", "mask": f"model/{name}.png"}]})
    deck = {
        "hooman": 1, "id": "example-nuclei", "title": "Example · Fix the nuclei (16-bit)",
        "question": "Did the model segment every nucleus right?",
        "help": "Raw 16-bit images: the app picks the contrast (◐ to change it). If anything is wrong, swipe up: Pick or Start from model, then Cut merged nuclei, Merge split ones, Wand the missed ones.",
        "sources": {"model": {"label": "Model", "color": "#4fc3f7"}},
        "answers": {"right": {"label": "All right", "value": "ok", "celebrate": True}, "up": {"label": "Fix it", "value": "fixed", "then": "draw"}, "down": "Unsure"},
        "cards": cards,
    }
    write_deck("nuclei.hooman.zip", deck, files)


if __name__ == "__main__":
    nuclei_deck()
    fruit_deck()
    shapes_deck()
    duel_deck()
    boxes_deck()
    timelapse_deck()
    index = [
        {"file": "circles.hooman.zip", "title": "Is it a circle?", "about": "The smallest possible deck: images and one yes/no question."},
        {"file": "duel.hooman.zip", "title": "Model A vs model B", "about": "Two models' masks on the same cells. Pick the right one, or say both are wrong."},
        {"file": "boxes.hooman.zip", "title": "Check a detector", "about": "Boxes with labels and scores, plus extra answer buttons."},
        {"file": "timelapse.hooman.zip", "title": "Follow a track", "about": "Three frames per card: does the tracker stay on one cell?"},
        {"file": "fruit.hooman.zip", "title": "Mask the fruit", "about": "No question: draw masks with classes (apple, orange, leaf). Shows the mask editor."},
        {"file": "nuclei.hooman.zip", "title": "Fix the nuclei (16-bit)", "about": "Raw 16-bit microscopy, 2 channels, auto contrast. Fix a model's merged, split and missed nuclei."},
    ]
    (OUT / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    print("index.json written")
