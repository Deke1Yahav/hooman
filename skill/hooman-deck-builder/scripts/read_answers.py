"""Read what the hooman answered: one or more <deck>.answers.zip exports (or full backups) from Hooman in the Loop.

    python read_answers.py mine.answers.zip                         # summary: counts, % with 95% intervals, time, notes
    python read_answers.py a.answers.zip b.answers.zip c.answers.zip # + agreement (Cohen's kappa for 2, Fleiss' for more)
    python read_answers.py mine.answers.zip --csv joined.csv --masks out_masks/

In Python:
    from read_answers import load, summary, masks
    data = load("mine.answers.zip")             # dict: deck, annotator, answers (list of dicts keyed by "card"), history, notes
    for card, frames in masks("mine.answers.zip"):   # numpy label images the hooman drew (needs numpy + Pillow)
        ...
Only the standard library is needed except for masks().
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import pathlib
import sys
import zipfile


def load(path) -> dict:
    """answers.json of an export, or the first deck of a backup (use load_all for every deck)."""
    decks = load_all(path)
    return decks[0]


def load_all(path) -> list[dict]:
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if "answers.json" in names:
            d = json.loads(z.read("answers.json"))
            d["_source"] = str(path)
            return [d]
        if "hooman-backup.json" in names:
            m = json.loads(z.read("hooman-backup.json"))
            out = []
            for dk in m.get("decks", []):
                out.append({"hooman_answers": 1, "deck": {"id": dk["key"], "title": dk.get("title")}, "annotator": m.get("annotator"),
                            "answers": dk.get("answers", []), "history": dk.get("log", []), "notes": dk.get("notes", []), "_source": str(path), "_backup": True})
            return out
    raise ValueError(f"{path}: not a Hooman answers export (no answers.json) or backup (no hooman-backup.json)")


def wilson(k, n, z=1.96):
    if not n:
        return 0.0, 0.0
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def cohen(pairs):
    n = len(pairs)
    if not n:
        return None
    cats = {x for p in pairs for x in p}
    po = sum(a == b for a, b in pairs) / n
    pe = sum(sum(a == c for a, _ in pairs) * sum(b == c for _, b in pairs) for c in cats) / (n * n)
    return {"n": n, "agreement": po, "kappa": (po - pe) / (1 - pe) if pe < 1 else 1.0}


def fleiss(items):
    """items: [[rater1 answer, rater2 answer, ...], ...], same raters on every item."""
    N = len(items)
    if not N:
        return None
    n = len(items[0])
    tot, P = {}, 0.0
    for it in items:
        cnt = {}
        for a in it:
            cnt[a] = cnt.get(a, 0) + 1
            tot[a] = tot.get(a, 0) + 1
        P += (sum(v * v for v in cnt.values()) - n) / (n * (n - 1))
    P /= N
    Pe = sum((v / (N * n)) ** 2 for v in tot.values())
    return {"items": N, "raters": n, "kappa": (P - Pe) / (1 - Pe) if Pe < 1 else 1.0}


def words(k):
    return "worse than chance" if k < 0 else "slight" if k <= .2 else "fair" if k <= .4 else "moderate" if k <= .6 else "substantial" if k <= .8 else "almost perfect"


def summary(data: dict) -> str:
    ans = data.get("answers", [])
    n = len(ans)
    total = n + len(data.get("unanswered", []))
    counts, labels = {}, {}
    for a in ans:
        counts[a["answer"]] = counts.get(a["answer"], 0) + 1
        labels.setdefault(a["answer"], a.get("label") or a["answer"])
    deck = data.get("deck", {})
    lines = [f"{deck.get('title') or deck.get('id')}: {n} of {total or n} cards answered" + (f" by {data['annotator']}" if data.get("annotator") else "")]
    for v, k in sorted(counts.items(), key=lambda x: -x[1]):
        lo, hi = wilson(k, n)
        lines.append(f"  {labels[v]:<24} {k:>5}  {k / n:6.1%}  (95% CI {lo:.0%}-{hi:.0%})")
    ms = sorted(a["ms"] for a in ans if a.get("ms"))
    if ms:
        lines.append(f"  median {ms[len(ms) // 2] / 1000:.1f} s per card, {sum(ms) / 60000:.0f} min in total")
    drawn = sum(1 for a in ans if any(o.get("source") == "hooman" for o in a.get("overlays", [])))
    froms, new = {}, 0
    for a in ans:
        for o in a.get("objects", []):
            if o.get("from"):
                key = (str(o["from"]), "edited" if o.get("edits") else "taken as is")
                froms[key] = froms.get(key, 0) + 1
            else:
                new += 1
    if drawn:
        lines.append(f"  {drawn} card(s) with a drawn mask" + ("; objects: " + ", ".join(f"{k[0]} {k[1]} {v}" for k, v in sorted(froms.items())) if froms else "")
                     + (f", drawn new {new}" if new else ""))
    notes = [a for a in ans if a.get("note")] + list(data.get("notes", []))
    if notes:
        lines.append(f"  {len(notes)} note(s), e.g. {notes[0]['card']}: {notes[0].get('note') or notes[0].get('text')!r}")
    return "\n".join(lines)


def agreement(datas: list[dict]) -> str:
    who = [d.get("annotator") or pathlib.Path(d.get("_source", f"file{i}")).name for i, d in enumerate(datas)]
    maps = [{a["card"]: a["answer"] for a in d.get("answers", [])} for d in datas]
    lines = []
    for i in range(len(maps)):
        for j in range(i + 1, len(maps)):
            pairs = [(maps[i][c], maps[j][c]) for c in maps[i] if c in maps[j]]
            r = cohen(pairs)
            if r:
                lines.append(f"  {who[i]} vs {who[j]}: {r['n']} cards, {r['agreement']:.0%} agree, Cohen's kappa {r['kappa']:.2f} ({words(r['kappa'])})")
                diffs = [c for c in maps[i] if c in maps[j] and maps[i][c] != maps[j][c]]
                if diffs:
                    lines.append(f"    disagree on: {', '.join(diffs[:12])}{' ...' if len(diffs) > 12 else ''}")
    if len(maps) > 2:
        common = [c for c in maps[0] if all(c in m for m in maps)]
        f = fleiss([[m[c] for m in maps] for c in common])
        if f:
            lines.append(f"  all {f['raters']}: Fleiss' kappa {f['kappa']:.2f} ({words(f['kappa'])}) on {f['items']} cards everyone answered")
    return "\n".join(lines)


def masks(path):
    """Yield (card id, {frame: numpy label image}) for every mask the hooman drew. Needs numpy + Pillow."""
    import numpy as np
    from PIL import Image
    data = load(path)
    with zipfile.ZipFile(path) as z:
        for a in data.get("answers", []):
            mine = [o for o in a.get("overlays", []) if o.get("source") == "hooman" and o.get("mask")]
            if mine:
                yield a["card"], {o.get("frame", a.get("frame", 0)): np.asarray(Image.open(io.BytesIO(z.read(o["mask"])))) for o in mine}


def write_csv(datas, out):
    rows = []
    for d in datas:
        for a in d.get("answers", []):
            rows.append({"deck": d.get("deck", {}).get("id"), "annotator": a.get("by") or d.get("annotator") or "", "card": a["card"], "image": a.get("image"),
                         "answer": a["answer"], "label": a.get("label"), "at": a.get("at"), "ms": a.get("ms"), "changes": a.get("changes"),
                         "note": a.get("note", ""), "number": a.get("number", ""), "text": a.get("text", ""), "end": a.get("end", ""),
                         "points": json.dumps(a["points"]) if a.get("points") else "", "from": json.dumps(a["from"]) if a.get("from") else "",
                         "masks": " ".join(o["mask"] for o in a.get("overlays", []) if o.get("source") == "hooman")})
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]) if rows else ["card"])
        w.writeheader(); w.writerows(rows)
    return len(rows)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Summarize Hooman in the Loop answers (and compare annotators).")
    ap.add_argument("files", nargs="+"); ap.add_argument("--csv"); ap.add_argument("--masks", help="folder for the drawn masks as .npy (needs numpy + Pillow)")
    a = ap.parse_args(argv)
    datas = [d for f in a.files for d in load_all(f)]
    for d in datas:
        print(summary(d)); print()
    if len(datas) > 1:
        print("Agreement"); print(agreement(datas))
    if a.csv:
        print(f"wrote {write_csv(datas, a.csv)} rows to {a.csv}")
    if a.masks:
        import numpy as np
        out = pathlib.Path(a.masks); out.mkdir(parents=True, exist_ok=True)
        n = 0
        for f in a.files:
            for card, frames in masks(f):
                for fr, arr in frames.items():
                    np.save(out / f"{card.replace('/', '__')}_f{fr}.npy", arr); n += 1
        print(f"wrote {n} mask arrays to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
