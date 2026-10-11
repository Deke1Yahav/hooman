"""Draws the app icon (a red/green loop around a smiling hooman) as SVG and PNGs.

    python tools/make_icons.py
"""
import math
import pathlib

from PIL import Image, ImageDraw

OUT = pathlib.Path(__file__).resolve().parent.parent / "app" / "icons"
BG, RED, GREEN, FACE = "#0d1214", "#ff5d6c", "#3ddc97", "#e8f0f2"


def geometry(S, k=1.0):
    """Shapes in a S x S box; k < 1 shrinks the drawing into the maskable safe zone."""
    c, R, w = S / 2, 0.33 * S * k, 0.075 * S * k
    arcs = [(RED, 112, 248), (GREEN, 292, 428)]          # degrees, clockwise from 3 o'clock (screen coords)
    heads = []
    for _, _, end in arcs:
        t = math.radians(end)
        px, py = c + R * math.cos(t), c + R * math.sin(t)
        tx, ty = -math.sin(t), math.cos(t)                  # clockwise tangent
        nx, ny = math.cos(t), math.sin(t)
        a, b = 0.10 * S * k, 0.085 * S * k
        heads.append([(px + tx * a, py + ty * a), (px + nx * b, py + ny * b), (px - nx * b, py - ny * b)])
    eyes = [(c - 0.085 * S * k, c - 0.05 * S * k), (c + 0.085 * S * k, c - 0.05 * S * k)]
    return dict(c=c, R=R, w=w, arcs=arcs, heads=heads, eyes=eyes, er=0.042 * S * k,
                smile=(c, c - 0.005 * S * k, 0.13 * S * k, 25, 155), sw=0.032 * S * k)


def png(S, maskable=False):
    Z = 4                                                   # supersample, then shrink
    big = S * Z
    g = geometry(big, 0.8 if maskable else 1.0)
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if maskable:
        d.rectangle([0, 0, big, big], fill=BG)
    else:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=0.22 * big, fill=BG)
    c, R, w = g["c"], g["R"], g["w"]
    for (color, a0, a1), head in zip(g["arcs"], g["heads"]):
        d.arc([c - R - w / 2, c - R - w / 2, c + R + w / 2, c + R + w / 2], a0, a1, fill=color, width=round(w))
        d.polygon(head, fill=color)
    for x, y in g["eyes"]:
        d.ellipse([x - g["er"], y - g["er"], x + g["er"], y + g["er"]], fill=FACE)
    sx, sy, sr, s0, s1 = g["smile"]
    d.arc([sx - sr, sy - sr, sx + sr, sy + sr], s0, s1, fill=FACE, width=round(g["sw"]))
    return im.resize((S, S), Image.LANCZOS)


def svg(S=512):
    g = geometry(S)
    c, R, w = g["c"], g["R"], g["w"]
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}">',
             f'<rect width="{S}" height="{S}" rx="{0.22 * S:.1f}" fill="{BG}"/>']
    for (color, a0, a1), head in zip(g["arcs"], g["heads"]):
        p0 = (c + R * math.cos(math.radians(a0)), c + R * math.sin(math.radians(a0)))
        p1 = (c + R * math.cos(math.radians(a1)), c + R * math.sin(math.radians(a1)))
        parts.append(f'<path d="M{p0[0]:.1f} {p0[1]:.1f} A{R:.1f} {R:.1f} 0 0 1 {p1[0]:.1f} {p1[1]:.1f}" fill="none" stroke="{color}" stroke-width="{w:.1f}"/>')
        parts.append(f'<polygon points="{" ".join(f"{x:.1f},{y:.1f}" for x, y in head)}" fill="{color}"/>')
    for x, y in g["eyes"]:
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{g["er"]:.1f}" fill="{FACE}"/>')
    sx, sy, sr, s0, s1 = g["smile"]
    q0 = (sx + sr * math.cos(math.radians(s0)), sy + sr * math.sin(math.radians(s0)))
    q1 = (sx + sr * math.cos(math.radians(s1)), sy + sr * math.sin(math.radians(s1)))
    parts.append(f'<path d="M{q0[0]:.1f} {q0[1]:.1f} A{sr:.1f} {sr:.1f} 0 0 1 {q1[0]:.1f} {q1[1]:.1f}" fill="none" stroke="{FACE}" stroke-width="{g["sw"]:.1f}" stroke-linecap="round"/>')
    parts.append("</svg>")
    return "\n".join(parts)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "icon.svg").write_text(svg(), encoding="utf-8")
    for S in (192, 512):
        png(S).save(OUT / f"icon-{S}.png")
    png(512, maskable=True).save(OUT / "icon-maskable-512.png")
    print("icons written to", OUT)
