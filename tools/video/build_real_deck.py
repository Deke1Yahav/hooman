"""The "real edit" deck for the user guide, built the way an AI with the hooman-deck-builder skill would build it.

Image: human nuclei in mitosis, Broad Bioimage Benchmark Collection (Copyright David Root, CC0), via scikit-image's data.
Model: a deliberately simple real pipeline (smooth, global Otsu threshold, fill holes, connected components,
remove objects under 70 px), which merges touching nuclei and drops small ones: what a person fixes in the editor.

    python tools/video/build_real_deck.py     # -> video_work/real/nuclei-fix-v1.hooman.zip + targets.json
"""
import json
import pathlib
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy.spatial import ConvexHull

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "skill" / "hooman-deck-builder" / "scripts"))
from hooman import Deck  # noqa: E402

REAL = ROOT / "video_work" / "real"
TILE = 128


def otsu(a):
    h, _ = np.histogram(a, 256, (0, 256)); p = h / h.sum(); w = np.cumsum(p); mu = np.cumsum(p * np.arange(256))
    return int(np.argmax((mu[-1] * w - mu) ** 2 / (w * (1 - w) + 1e-12)))


def segment(img, k, min_size=0):
    sm = ndi.gaussian_filter(img.astype(float), 1.0)
    lab = ndi.label(ndi.binary_fill_holes(sm > otsu(sm) * k))[0]
    if min_size:                                     # "remove small objects": also drops small, dim nuclei
        sizes = np.bincount(lab.ravel()); keep = sizes >= min_size; keep[0] = False
        lab = ndi.label(keep[lab])[0]
    return lab


def main():
    img = np.asarray(Image.open(REAL / "mitosis.tif"))
    model = segment(img, 1.1, min_size=70)          # the "model" the hooman will fix
    loose = segment(img, 0.9)                        # finds the nuclei the model missed (for the demo's targets)
    tiles = []
    for y0 in range(0, 512 - TILE + 1, 64):
        for x0 in range(0, 512 - TILE + 1, 64):
            m = ndi.label(model[y0:y0 + TILE, x0:x0 + TILE] > 0)[0]
            l = loose[y0:y0 + TILE, x0:x0 + TILE]
            merges, missed, specks = [], [], []
            dist = ndi.distance_transform_edt(m > 0)
            for k in range(1, m.max() + 1):
                obj = m == k
                a = int(obj.sum())
                ys, xs = np.nonzero(obj)
                if a < 40:
                    specks.append([float(xs.mean()) + .5, float(ys.mean()) + .5]); continue
                if xs.min() < 3 or ys.min() < 3 or xs.max() > TILE - 4 or ys.max() > TILE - 4:
                    continue
                sol = a / ConvexHull(np.c_[xs, ys]).volume
                d = np.where(obj, dist, 0)
                pk = np.argwhere((d == ndi.maximum_filter(d, size=7)) & (d > 3))
                if sol < .82 and len(pk) >= 2:      # nuclei stuck together: cut across the narrowest neck between two centres
                    pk = sorted(pk.tolist(), key=lambda q: -d[q[0], q[1]])
                    best = None
                    for i1 in range(min(len(pk), 6)):
                        for i2 in range(i1 + 1, min(len(pk), 6)):
                            a1, a2 = np.array(pk[i1], float), np.array(pk[i2], float)
                            if np.hypot(*(a2 - a1)) < 6:
                                continue
                            ts = np.linspace(0, 1, 40)
                            line = a1[None] + ts[:, None] * (a2 - a1)[None]
                            vals = d[np.clip(line[:, 0].round().astype(int), 0, TILE - 1), np.clip(line[:, 1].round().astype(int), 0, TILE - 1)]
                            j = int(np.argmin(vals))
                            neck = vals[j] / min(d[pk[i1][0], pk[i1][1]], d[pk[i2][0], pk[i2][1]])
                            if 0 < vals[j] and neck < .8 and (best is None or neck < best[0]):
                                best = (neck, line[j], a1, a2, vals[j])
                    if best is None:
                        continue
                    _, nk, a1, a2, w = best
                    v = (a2 - a1)[::-1] / np.hypot(*(a2 - a1)); nrm = np.array([-v[1], v[0]]); half = 2 * (w + 4)
                    c = nk[::-1] + .5
                    merges.append({"line": [(c - nrm * half).tolist(), (c + nrm * half).tolist()], "pieces": [(a1[::-1] + .5).tolist(), (a2[::-1] + .5).tolist()], "area": a})
            for k in range(1, l.max() + 1):
                obj = l == k
                if obj.sum() > 25 and not (m[obj] > 0).any():
                    ys, xs = np.nonzero(obj)
                    if 6 < xs.mean() < TILE - 6 and 6 < ys.mean() < TILE - 6:
                        missed.append([float(xs.mean()) + .5, float(ys.mean()) + .5])
            tiles.append({"x0": x0, "y0": y0, "merges": merges, "missed": missed, "specks": specks, "objects": int(m.max())})
    good = sorted([t for t in tiles if t["merges"] and t["missed"]], key=lambda t: -(len(t["merges"]) + len(t["missed"])))
    picked, used = [], []
    for t in good:                                   # 4 tiles that don't overlap
        if all(abs(t["x0"] - u["x0"]) >= TILE or abs(t["y0"] - u["y0"]) >= TILE for u in used):
            picked.append(t); used.append(t)
        if len(picked) == 4:
            break

    deck = Deck("nuclei-fix-v1", "Is the model's segmentation right?", title="Fix the nuclei (real image)",
                help="Human nuclei in mitosis (BBBC, CC0). The model is a simple threshold. Swipe up to fix a tile in the mask editor.")
    deck.source("model", label="Model", color="#ff5d6c")
    deck.answers(right={"label": "All right", "value": "ok", "celebrate": True}, up=("Fix it", "fixed", "draw"), down="Unsure")
    targets = {}
    for i, t in enumerate(picked):
        crop = img[t["y0"]:t["y0"] + TILE, t["x0"]:t["x0"] + TILE]
        lab = ndi.label(model[t["y0"]:t["y0"] + TILE, t["x0"]:t["x0"] + TILE] > 0)[0]
        cid = f"tile{i + 1}"
        deck.card(deck.image(crop, name=f"img/{cid}.png"), id=cid, overlays=[deck.mask(lab, source="model", name=f"model/{cid}.png")],
                  info=f"x {t['x0']}, y {t['y0']} · {t['objects']} objects")
        targets[cid] = t
    out = deck.save(REAL / "nuclei-fix-v1.hooman.zip")
    (REAL / "targets.json").write_text(json.dumps(targets, indent=1))
    print(f"built {out.name}: {len(deck.cards)} cards ({TILE}x{TILE} tiles, raw image + model outlines), {deck.size_mb():.2f} MB, check: no problems")
    for cid, t in targets.items():
        print(f"  {cid}: {t['objects']} objects, {len(t['merges'])} merged, {len(t['missed'])} missed")


if __name__ == "__main__":
    main()
