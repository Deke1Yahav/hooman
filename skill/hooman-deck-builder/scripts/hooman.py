"""Build decks for the phone app "Hooman in the Loop" (https://deke1yahav.github.io/hooman/).

A deck is a zip: deck.json + images (+ masks). The format is in ../references/format.md (= the app's llms.txt).
This module needs only the Python standard library for files you already have on disk; numpy + Pillow are
used when you pass arrays (images, label masks) instead of paths.

    from hooman import Deck
    deck = Deck("cells-v1", "Is the cell segmented right?", title="Cells")
    img = deck.image("raw/001.png")                       # a file, bytes, or a numpy array
    deck.card(img, id="001", overlays=[deck.mask(labels, source="model")])
    deck.save("cells.hooman.zip")                         # validates first, raises DeckError with fixable messages

High-level builders: from_folder(), model_duel(), objects_deck(), timelapse_deck(), from_coco().
Command line:  python hooman.py folder <dir> --question "..." --out deck.hooman.zip   (see --help)
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import pathlib
import re
import sys
import zipfile

IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif")
DIRS = ("right", "left", "up", "down")


class DeckError(Exception):
    """The deck would be rejected by the app. .errors lists the exact problems."""

    def __init__(self, errors):
        super().__init__("\n".join(errors))
        self.errors = errors


# ---------------------------------------------------------------- encoding helpers

def _np():
    import numpy as np  # noqa: WPS433 (optional dependency)
    return np


def png_bytes(arr) -> bytes:
    """numpy array -> PNG bytes. uint16 stays 16-bit (label images > 255 objects, raw microscopy)."""
    from PIL import Image
    np = _np()
    a = np.asarray(arr)
    if a.dtype == bool:
        a = a.astype(np.uint8)
    if a.dtype.kind in "iu" and a.ndim == 2:
        a = a.astype(np.uint8 if a.max(initial=0) < 256 and a.dtype.itemsize == 1 else np.uint16)
    elif a.dtype.kind == "f":
        raise ValueError("float image: stretch it to uint8 (stretch_to_uint8) or keep it as uint16 first")
    b = io.BytesIO()
    Image.fromarray(a).save(b, "PNG")
    return b.getvalue()


def label_png(labels) -> bytes:
    """Label image (0 = background, 1..n = objects) -> PNG, 8-bit when < 256 objects, else 16-bit."""
    np = _np()
    a = np.asarray(labels)
    if a.max(initial=0) > 65535:
        raise ValueError("more than 65535 objects in one mask: split it")
    return png_bytes(a.astype(np.uint8 if a.max(initial=0) < 256 else np.uint16))


def stretch_to_uint8(arr, low=0.5, high=99.8):
    """Percentile stretch (for colour or when you want a fixed look). Raw 16-bit grey can stay 16-bit instead."""
    np = _np()
    a = np.asarray(arr, dtype=float)
    lo, hi = np.percentile(a, [low, high])
    return (np.clip((a - lo) / (hi - lo + 1e-9), 0, 1) * 255).astype(np.uint8)


def image_size(data: bytes):
    """(width, height, kind) from the first bytes of PNG/JPEG/GIF/WebP; kind 'tiff' for TIFF; None if unknown."""
    b = data[:262144]
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(b[16:20], "big"), int.from_bytes(b[20:24], "big"), "png"
    if b[:4] == b"GIF8":
        return int.from_bytes(b[6:8], "little"), int.from_bytes(b[8:10], "little"), "gif"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        kind = b[12:16]
        if kind == b"VP8 ":
            return int.from_bytes(b[26:28], "little") & 0x3FFF, int.from_bytes(b[28:30], "little") & 0x3FFF, "webp"
        if kind == b"VP8L":
            v = int.from_bytes(b[21:25], "little")
            return (v & 0x3FFF) + 1, ((v >> 14) & 0x3FFF) + 1, "webp"
        if kind == b"VP8X":
            return 1 + int.from_bytes(b[24:27], "little"), 1 + int.from_bytes(b[27:30], "little"), "webp"
    if b[:2] == b"\xff\xd8":
        p = 2
        while p + 9 < len(b):
            if b[p] != 0xFF:
                p += 1
                continue
            m = b[p + 1]
            if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7 or m == 0xFF:
                p += 1 if m == 0xFF else 2
                continue
            ln = int.from_bytes(b[p + 2:p + 4], "big")
            if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                return int.from_bytes(b[p + 7:p + 9], "big"), int.from_bytes(b[p + 5:p + 7], "big"), "jpeg"
            p += 2 + ln
        return None
    if b[:2] in (b"II", b"MM"):
        return 0, 0, "tiff"
    return None


def png_bit_depth(data: bytes):
    return data[24] if data[:8] == b"\x89PNG\r\n\x1a\n" else None


# ---------------------------------------------------------------- overlays

def _clean(d):
    return {k: v for k, v in d.items() if v is not None}


def box(x, y, w, h, source="model", label=None, style=None, frame=None):
    return _clean({"box": [round(float(x), 2), round(float(y), 2), round(float(w), 2), round(float(h), 2)], "source": source, "label": label, "style": style, "frame": frame})


def point(x, y, source="model", label=None, style=None, frame=None):
    return _clean({"point": [round(float(x), 2), round(float(y), 2)], "source": source, "label": label, "style": style, "frame": frame})


def polygon(points, source="model", label=None, style=None, frame=None):
    return _clean({"polygon": [[round(float(x), 2), round(float(y), 2)] for x, y in points], "source": source, "label": label, "style": style, "frame": frame})


# ---------------------------------------------------------------- the deck

class Deck:
    """Collects files and cards, then writes <name>.hooman.zip. Identical files are stored once."""

    def __init__(self, id, question=None, title=None, *, mode=None, help=None, about=None, shuffle=False, frames_are=None):
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", id or ""):
            raise ValueError('deck id: 1-64 letters, digits, ".", "_" or "-" (keep it stable across rebuilds)')
        self.data = {"hooman": 1, "id": id}
        if title:
            self.data["title"] = title
        if question:
            self.data["question"] = question
        if mode:
            self.data["mode"] = mode
        if help:
            self.data["help"] = help
        if about:
            self.data["about"] = about
        if shuffle:
            self.data["shuffle"] = True
        if frames_are:
            self.data["frames_are"] = frames_are
        self.files: dict[str, bytes] = {}
        self._by_hash: dict[str, str] = {}
        self.cards: list[dict] = []

    # --- deck-level settings
    def answers(self, **dirs):
        """right/left/up/down = "Label" | ("Label", "value") | ("Label", "value", "then") | dict(label=..., value=..., then=..., celebrate=...)."""
        out = {}
        for k, v in dirs.items():
            if k not in DIRS:
                raise ValueError(f"answers: {k!r} is not one of {DIRS}")
            out[k] = _answer(v)
        self.data["answers"] = out
        return self

    def buttons(self, *items):
        self.data["buttons"] = [_answer(v) for v in items]
        return self

    def source(self, name, label=None, color=None, guide=False):
        s = self.data.setdefault("sources", {})
        s[name] = _clean({"label": label, "color": color, "guide": True if guide else None})
        return self

    def classes(self, *items):
        self.data["classes"] = [c if isinstance(c, (str, dict)) else str(c) for c in items]
        return self

    def channels(self, *items, view=None):
        """channels("nuclei", ("body", "#ffffff")) or dicts; view: "mix" | "side" | a channel name."""
        chans = []
        for c in items:
            if isinstance(c, str):
                chans.append({"name": c})
            elif isinstance(c, (tuple, list)):
                chans.append(_clean({"name": c[0], "color": c[1] if len(c) > 1 else None}))
            else:
                chans.append(dict(c))
        self.data["channels"] = chans
        if view:
            self.data["channel_view"] = view
        return self

    # --- files
    def _add(self, data: bytes, name: str) -> str:
        h = hashlib.sha1(data).hexdigest()
        if h in self._by_hash:
            return self._by_hash[h]
        base, n = name, 1
        while name in self.files:
            stem, ext = os.path.splitext(base)
            name = f"{stem}_{n}{ext}"
            n += 1
        self.files[name] = data
        self._by_hash[h] = name
        return name

    def image(self, src, name=None, folder="img") -> str:
        """Add a picture: a path, bytes, or a numpy array (uint8 grey/RGB, or uint16 grey kept raw). Returns its path in the deck."""
        if isinstance(src, (str, os.PathLike)):
            p = pathlib.Path(src)
            data = p.read_bytes()
            kind = image_size(data)
            if kind and kind[2] == "tiff":
                return self.image(_read_tiff(p), name=name or f"{folder}/{p.stem}.png", folder=folder)
            return self._add(data, name or f"{folder}/{p.name}")
        if isinstance(src, (bytes, bytearray)):
            return self._add(bytes(src), name or f"{folder}/{len(self.files):05d}.png")
        return self._add(png_bytes(src), name or f"{folder}/{len(self.files):05d}.png")

    def mask(self, labels, source="model", *, value=None, style=None, frame=None, label=None, name=None, folder="masks") -> dict:
        """A mask overlay from a label image (array, PNG path or bytes). value + style="bold" = the object in question."""
        if isinstance(labels, (str, os.PathLike)):
            path = self._add(pathlib.Path(labels).read_bytes(), name or f"{folder}/{pathlib.Path(labels).name}")
        elif isinstance(labels, (bytes, bytearray)):
            path = self._add(bytes(labels), name or f"{folder}/{len(self.files):05d}.png")
        else:
            path = self._add(label_png(labels), name or f"{folder}/{len(self.files):05d}.png")
        return _clean({"mask": path, "source": source, "value": int(value) if value is not None else None, "style": style, "frame": frame, "label": label})

    # --- cards
    def card(self, image=None, *, frames=None, channels=None, id=None, overlays=None, question=None, info=None, focus=None, start=None):
        """image: a path from .image(); frames: [path | {"image", "name", "channels"}]; channels: extra channel paths for a single image."""
        c = {}
        if id is not None:
            c["id"] = str(id)
        if frames is not None:
            c["frames"] = frames
        else:
            c["image"] = image
            if channels:
                c["channels"] = list(channels)
        for k, v in (("question", question), ("info", info), ("focus", focus), ("start", start)):
            if v is not None:
                c[k] = [round(float(x), 2) for x in v] if k in ("focus", "start") else v
        if overlays:
            c["overlays"] = list(overlays)
        self.cards.append(c)
        return c

    # --- output
    def to_json(self) -> dict:
        return {**self.data, "cards": self.cards}

    def check(self) -> list[str]:
        """The problems the app would report (empty list = fine). Uses check_deck.py's rules."""
        from check_deck import check_files
        return check_files(self.to_json(), self.files)[0]

    def save(self, out: str, validate=True) -> pathlib.Path:
        if validate:
            errs = self.check()
            if errs:
                raise DeckError(errs)
        out = pathlib.Path(out)
        if not out.name.endswith(".zip"):
            out = out.with_name(out.name + ".hooman.zip")
        out.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out, "w") as z:
            z.writestr("deck.json", json.dumps(self.to_json(), indent=1, ensure_ascii=False), compress_type=zipfile.ZIP_DEFLATED)
            for path, data in self.files.items():
                z.writestr(path, data, compress_type=zipfile.ZIP_STORED if path.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")) else zipfile.ZIP_DEFLATED)
        return out

    def size_mb(self) -> float:
        return sum(len(d) for d in self.files.values()) / 1e6


def _answer(v):
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        return _clean(v)
    v = list(v)
    return _clean({"label": v[0], "value": v[1] if len(v) > 1 else None, "then": v[2] if len(v) > 2 else None})


def _read_tiff(path):
    try:
        import tifffile
        return tifffile.imread(str(path))
    except ImportError:
        from PIL import Image
        return _np().asarray(Image.open(path))


# ---------------------------------------------------------------- high-level builders

def from_folder(folder, question, out=None, *, id=None, title=None, answers=None, pattern=None):
    """Yes/no (or custom answers) deck from every image in a folder."""
    folder = pathlib.Path(folder)
    files = sorted(p for p in folder.rglob("*") if p.suffix.lower() in IMAGE_EXT + (".tif", ".tiff") and (not pattern or re.search(pattern, p.name)))
    if not files:
        raise ValueError(f"no images in {folder}")
    deck = Deck(id or _slug(folder.name), question, title=title or folder.name)
    if answers:
        deck.answers(**answers)
    for p in files:
        rel = p.relative_to(folder).as_posix()
        deck.card(deck.image(p, name=f"img/{rel}" if p.suffix.lower() in IMAGE_EXT else None), id=rel)
    return deck.save(out) if out else deck


def _bbox(mask, pad=0.0):
    np = _np()
    ys, xs = np.nonzero(mask)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    m = pad * max(x1 - x0, y1 - y0)
    return [float(x0 - m), float(y0 - m), float(x1 - x0 + 2 * m), float(y1 - y0 + 2 * m)]


def _best_iou(obj, labels):
    np = _np()
    vals = [v for v in np.unique(labels[obj]) if v]
    best = 0.0
    for v in vals:
        other = labels == v
        best = max(best, (obj & other).sum() / max(1, (obj | other).sum()))
    return best


def model_duel(items, out=None, *, id="duel-v1", title="Model A vs model B", names=("A", "B"), labels=("Model A", "Model B"),
               per_object=True, only_disagreements=True, agree_iou=0.9, question=None, draw_when_both_wrong=True):
    """items: [(name, image, labels_a, labels_b)] with numpy arrays. One card per object of model A (and B's
    objects A missed), only where the two disagree; the object in question is bold; both full masks thin."""
    np = _np()
    a_name, b_name = names
    deck = Deck(id, question or ("Which model outlined the bold object right?" if per_object else "Which model got it right?"), title=title)
    deck.source(a_name, label=labels[0]).source(b_name, label=labels[1])
    deck.answers(left=(f"{labels[0].split()[-1]} right" if len(labels[0].split()) > 1 else f"{a_name} right", a_name),
                 right=(f"{labels[1].split()[-1]} right" if len(labels[1].split()) > 1 else f"{b_name} right", b_name),
                 up=("Both wrong", "both_wrong", "draw" if draw_when_both_wrong else None), down="Unsure")
    for name, image, la, lb in items:
        la, lb = np.asarray(la), np.asarray(lb)
        img = deck.image(image, name=f"img/{name}.png")
        ma = deck.mask(la, source=a_name, name=f"{a_name}/{name}.png")
        mb = deck.mask(lb, source=b_name, name=f"{b_name}/{name}.png")
        if not per_object:
            deck.card(img, id=name, overlays=[ma, mb])
            continue
        todo = [(a_name, la, lb, v) for v in np.unique(la) if v] + [(b_name, lb, la, v) for v in np.unique(lb) if v and not (la[lb == v] > 0).any()]
        for src, mine, other, v in todo:
            obj = mine == v
            iou = _best_iou(obj, other)
            if only_disagreements and iou >= agree_iou:
                continue
            bold = deck.mask(mine, source=src, value=int(v), style="bold", name=f"{src}/{name}.png")
            deck.card(img, id=f"{name}_{src}{int(v)}", focus=_bbox(obj, 0.1), info=f"{name} · {src} object {int(v)} · IoU {iou:.2f}",
                      overlays=[ma, mb, bold])
    return deck.save(out) if out else deck


def objects_deck(items, out=None, *, id="objects-v1", title="One card per object", question="Is this object right?", source="model", answers=None):
    """items: [(name, image, labels)]. One card per object: focus on it, all outlines thin, it in bold."""
    np = _np()
    deck = Deck(id, question, title=title).source(source)
    if answers:
        deck.answers(**answers)
    for name, image, lab in items:
        lab = np.asarray(lab)
        img = deck.image(image, name=f"img/{name}.png")
        m = deck.mask(lab, source=source, name=f"{source}/{name}.png")
        for v in np.unique(lab):
            if not v:
                continue
            deck.card(img, id=f"{name}_{int(v)}", focus=_bbox(lab == v, 0.1), info=f"{name} · object {int(v)}",
                      overlays=[m, deck.mask(lab, source=source, value=int(v), style="bold", name=f"{source}/{name}.png")])
    return deck.save(out) if out else deck


def timelapse_deck(frames, out=None, *, id="timelapse-v1", title="Time-lapse", question="Is the bold cell followed right?",
                   channel_names=("channel 1",), channel_colors=None, channel_view=None, models=None, cell_ids=None, guide=None, answers=None):
    """frames: [[channel arrays for t0], [.. for t1], ...] (raw uint16 is fine).
    models: {"A": [labels_t0, labels_t1, ...], ...} with the SAME number for the same cell in every frame.
    cell_ids: the cells to make cards for (default: every cell of the first model). guide: "box" draws a dashed box around the cell."""
    np = _np()
    deck = Deck(id, question, title=title, frames_are="time")
    colors = channel_colors or [None] * len(channel_names)
    if len(channel_names) > 1:
        deck.channels(*[(n, c) if c else n for n, c in zip(channel_names, colors)], view=channel_view)
    fr = []
    for t, chans in enumerate(frames):
        chans = list(chans) if isinstance(chans, (list, tuple)) else [chans]
        paths = [deck.image(c, name=f"img/t{t}_{_slug(channel_names[k] if k < len(channel_names) else str(k))}.png") for k, c in enumerate(chans)]
        f = {"name": f"t{t + 1}", "image": paths[0]}
        if len(paths) > 1:
            f["channels"] = paths[1:]
        fr.append(f)
    models = models or {}
    for m in models:
        deck.source(m)
    if guide:
        deck.source("look", guide=True)
    first = next(iter(models.values()), None)
    ids = cell_ids if cell_ids is not None else (sorted(int(v) for v in np.unique(np.asarray(first[0])) if v) if first is not None else [None])
    if answers:
        deck.answers(**answers)
    for k in ids:
        ov = []
        for m, labs in models.items():
            for t, lab in enumerate(labs):
                mm = deck.mask(lab, source=m, frame=t, name=f"{m}/t{t}.png")
                ov.append(mm)
                if k is not None and (np.asarray(lab) == k).any():
                    ov.append(deck.mask(lab, source=m, frame=t, value=int(k), style="bold", name=f"{m}/t{t}.png"))
        if guide and k is not None and first is not None and (np.asarray(first[0]) == k).any():
            ov.append(box(*_bbox(np.asarray(first[0]) == k, 0.25), source="look", frame=0))
        deck.card(frames=fr, id=f"cell{k}" if k is not None else "movie", overlays=ov, info=f"cell {k}" if k is not None else None)
    return deck.save(out) if out else deck


def from_coco(coco_json, images_dir, out=None, *, id="coco-v1", title="Check the detections", question="Is the label right?", per_object=True, answers=None):
    """COCO detections/segmentations -> one card per annotation (box/polygon with its category), or one card per image."""
    coco = json.loads(pathlib.Path(coco_json).read_text(encoding="utf-8"))
    cats = {c["id"]: c["name"] for c in coco.get("categories", [])}
    by_img = {}
    for a in coco.get("annotations", []):
        by_img.setdefault(a["image_id"], []).append(a)
    deck = Deck(id, question, title=title).source("model")
    deck.answers(**(answers or {"right": "Correct", "left": "Wrong", "up": "Unsure"}))
    for im in coco.get("images", []):
        path = deck.image(pathlib.Path(images_dir) / im["file_name"], name=f"img/{im['file_name']}")
        ovs = []
        for a in by_img.get(im["id"], []):
            lab = f"{cats.get(a.get('category_id'), '?')}" + (f" {a['score']:.2f}" if "score" in a else "")
            seg = a.get("segmentation")
            if isinstance(seg, list) and seg and isinstance(seg[0], list) and len(seg[0]) >= 6:
                ovs.append(polygon(list(zip(seg[0][0::2], seg[0][1::2])), label=lab))
            elif "bbox" in a:
                ovs.append(box(*a["bbox"], label=lab))
        if per_object:
            for i, o in enumerate(ovs):
                bb = o.get("box") or _poly_bbox(o["polygon"])
                deck.card(path, id=f"{im['file_name']}#{i}", focus=bb, overlays=[{**o, "style": "bold"}], info=o.get("label"))
        else:
            deck.card(path, id=im["file_name"], overlays=ovs)
    return deck.save(out) if out else deck


def _poly_bbox(pts):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]


def _slug(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", str(s)).strip("-")[:64] or "deck"


def split_cards(deck: Deck, size=1000):
    """Big decks: yield Deck parts of at most `size` cards (ids <id>-part1, -part2, ...; images only where used)."""
    for i in range(0, len(deck.cards), size):
        part = Deck(f"{deck.data['id']}-part{i // size + 1}", deck.data.get("question"), title=f"{deck.data.get('title', deck.data['id'])} ({i // size + 1}/{(len(deck.cards) + size - 1) // size})")
        part.data.update({k: v for k, v in deck.data.items() if k not in ("id", "title")})
        part.data["id"] = f"{deck.data['id']}-part{i // size + 1}"
        part.cards = deck.cards[i:i + size]
        used = json.dumps(part.cards)
        part.files = {p: d for p, d in deck.files.items() if f'"{p}"' in used}
        yield part


# ---------------------------------------------------------------- command line

def main(argv=None):
    ap = argparse.ArgumentParser(description="Build a Hooman in the Loop deck (.hooman.zip).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("folder", help="yes/no deck from a folder of images")
    f.add_argument("folder"); f.add_argument("--question", required=True); f.add_argument("--out", required=True)
    f.add_argument("--id"); f.add_argument("--title")
    f.add_argument("--right", default="Yes"); f.add_argument("--left", default="No"); f.add_argument("--up", default="Unsure")
    d = sub.add_parser("duel", help="model A vs B: folders of images and of label PNGs with the same file names")
    d.add_argument("--images", required=True); d.add_argument("--a", required=True); d.add_argument("--b", required=True); d.add_argument("--out", required=True)
    d.add_argument("--names", default="A,B"); d.add_argument("--labels", default="Model A,Model B"); d.add_argument("--id", default="duel-v1")
    d.add_argument("--all", action="store_true", help="every object, not only where the models disagree"); d.add_argument("--whole", action="store_true", help="one card per image")
    c = sub.add_parser("coco", help="COCO json + images folder")
    c.add_argument("coco"); c.add_argument("images"); c.add_argument("--out", required=True); c.add_argument("--id", default="coco-v1"); c.add_argument("--per-image", action="store_true")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "folder":
            out = from_folder(a.folder, a.question, a.out, id=a.id, title=a.title, answers={"right": a.right, "left": a.left, "up": a.up})
        elif a.cmd == "duel":
            from PIL import Image
            np = _np()
            items = []
            for p in sorted(pathlib.Path(a.images).iterdir()):
                if p.suffix.lower() not in IMAGE_EXT + (".tif", ".tiff"):
                    continue
                la, lb = pathlib.Path(a.a) / (p.stem + ".png"), pathlib.Path(a.b) / (p.stem + ".png")
                if not la.exists() or not lb.exists():
                    print(f"skip {p.name}: no {la.name} in both mask folders", file=sys.stderr)
                    continue
                img = _read_tiff(p) if p.suffix.lower() in (".tif", ".tiff") else np.asarray(Image.open(p))
                items.append((p.stem, img, np.asarray(Image.open(la)), np.asarray(Image.open(lb))))
            names, labels = a.names.split(","), a.labels.split(",")
            out = model_duel(items, a.out, id=a.id, names=names, labels=labels, only_disagreements=not a.all, per_object=not a.whole)
        else:
            out = from_coco(a.coco, a.images, a.out, id=a.id, per_object=not a.per_image)
    except DeckError as e:
        print("The app would reject this deck:\n" + "\n".join(f"  - {x}" for x in e.errors), file=sys.stderr)
        return 1
    print(f"wrote {out} ({pathlib.Path(out).stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).parent))
    sys.exit(main())
