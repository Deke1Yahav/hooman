"""Make the YouTube user guide for Hooman in the Loop: three parts, English narration.

    python tools/video/make_video.py 1                  # part 1 (getting started): tts, record, compose, thumb
    python tools/video/make_video.py 2                  # part 2 (real image, built by AI, fixed in the editor); runs a dry run
                                                        # first by default, for the export the final chat reads
    python tools/video/make_video.py 3                  # part 3 (tracking, review, customising)
    python tools/video/make_video.py 2 compose thumb    # some steps only

Steps:
  tts      narration per chapter with Piper (offline neural voice; LJSpeech = public domain)
  record   the real app, driven by script inside a phone frame (tools/video/stage.html), captured as sharp frames
           straight from Chrome (CDP screencast); each chapter lasts as long as its narration
  compose  ffmpeg: H.264 1080p + AAC (voice at each chapter's start), subtitles .srt, chapters + description
  thumb    a 1280x720 thumbnail
Needs: playwright, piper-tts, imageio-ffmpeg, numpy, Pillow, scipy. The voice model goes in video_work/voice/.
"""
import base64
import functools
import http.server
import json
import pathlib
import re
import subprocess
import sys
import threading
import time
import wave

ROOT = pathlib.Path(__file__).resolve().parents[2]
VIDEO = ROOT / "tools" / "video"
VOICE = ROOT / "video_work" / "voice" / "en_US-ljspeech-high.onnx"
LEAD, TAIL = 0.35, 0.75          # seconds of quiet before / after each chapter's narration
PARTS = {
    1: {"script": "script.json", "label": "user guide · part 1", "name": "Getting started", "file": "hooman-guide-1-getting-started",
        "title": "Hooman in the Loop (1/3): check and fix your AI's image results on your phone", "thumb": ("Swipe to <span>fix</span> your AI", "Part 1 · getting started")},
    2: {"script": "part2.json", "label": "user guide · part 2", "name": "Fix real masks", "file": "hooman-guide-2-fix-real-masks",
        "title": "Hooman in the Loop (2/3): an AI builds the deck, you fix the masks (real microscopy)", "thumb": ("AI builds it.<br>You <span>fix</span> it.", "Part 2 · the mask editor")},
    3: {"script": "part3.json", "label": "user guide · part 3", "name": "Tracking, review, customising", "file": "hooman-guide-3-tracking-review",
        "title": "Hooman in the Loop (3/3): tracking, review and your own answers", "thumb": ("Track, review,<br>make it <span>yours</span>", "Part 3 · tracking & more")},
}
DISPLAY = [("deke one yahav dot github dot I O, slash hooman", "deke1yahav.github.io/hooman"), ("A.I.", "AI"), ("Chat G P T", "ChatGPT"),
           ("ninety five percent", "95%"), ("sixteen bit", "16-bit"), ("half moon", "half-moon ◐"), ("ready made", "ready-made"),
           ("colour blind safe", "colour-blind-safe")]
PROMPT = ("Here's a nuclei image (mitosis.tif, BBBC, CC0) and the mask from my threshold model. Make a Hooman in the Loop deck "
          "so I can fix the model's mistakes on my phone: 128-pixel tiles where it merged or missed nuclei, its outlines in red, "
          "swipe up to fix.")


def work(part):
    return ROOT / "video_work" / f"part{part}"


def out_dir(part):
    return ROOT / "video_out" / f"part{part}"


def script(part):
    return json.loads((VIDEO / PARTS[part]["script"]).read_text(encoding="utf-8"))


def display(text):
    text = re.sub(r"A\.I\.(?=\s+[A-Z])", "AI.", text)          # "...the A.I. It reads" keeps its full stop
    for a, b in DISPLAY:
        text = text.replace(a, b)
    return text


def sentences(text):
    return [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]


def ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def serve():
    http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
    http.server.ThreadingHTTPServer.request_queue_size = 128
    http.server.ThreadingHTTPServer.daemon_threads = True
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/"


# ---------------------------------------------------------------- 1. narration
def tts(part):
    from piper import PiperVoice
    try:
        from piper import SynthesisConfig
        cfg = SynthesisConfig(length_scale=1.06)                     # a touch slower than the default: clearer
    except ImportError:
        cfg = None
    voice = PiperVoice.load(str(VOICE))
    d = work(part) / "tts"; d.mkdir(parents=True, exist_ok=True)
    durations = {}
    for seg in script(part):
        path = d / f"{seg['id']}.wav"
        with wave.open(str(path), "wb") as w:
            voice.synthesize_wav(seg["say"], w, syn_config=cfg) if cfg else voice.synthesize_wav(seg["say"], w)
        with wave.open(str(path)) as w:
            durations[seg["id"]] = w.getnframes() / w.getframerate()
        print(f"  {seg['id']:<9} {durations[seg['id']]:5.1f} s")
    (d / "durations.json").write_text(json.dumps(durations, indent=1))
    print(f"narration: {sum(durations.values()):.0f} s in total")


# ---------------------------------------------------------------- 2. recording
def sample_photos(part):
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
    d = work(part) / "photos"; d.mkdir(parents=True, exist_ok=True)
    out = []
    for i in range(4):
        im = Image.new("RGB", (640, 640), (30 + 9 * i, 52, 40))
        dr = ImageDraw.Draw(im)
        col = [(255, 120, 160), (255, 200, 60), (180, 120, 255), (120, 220, 255)][i]
        n = 8 if i % 2 == 0 else 5
        for k in range(n):                          # a flower: open (8 petals) or closed (5)
            a = k * 2 * 3.14159 / n
            r = 150 if i % 2 == 0 else 68
            cx, cy = 320 + r * np.cos(a), 320 + r * np.sin(a)
            dr.ellipse([cx - 80, cy - 80, cx + 80, cy + 80], fill=col)
        dr.ellipse([250, 250, 390, 390], fill=(255, 230, 120))
        p = d / f"flower{i + 1}.jpg"
        im.filter(ImageFilter.GaussianBlur(1.2)).save(p, quality=90)
        out.append(str(p))
    return out


class Rec:
    """Drives the app inside the stage: taps and swipes with a visible finger, typing, image-pixel taps."""

    def __init__(self, page, speed=1.0):
        self.page, self.speed = page, speed
        self.app = page.frame_locator("#phone")

    @property
    def frame(self):
        return self.page.frame(name="phone")

    def W(self, ms):
        self.page.wait_for_timeout(max(20, int(ms * self.speed)))

    def stage(self, fn, *a):
        return self.page.evaluate(f"(a) => stage.{fn}(...a)", list(a))

    def center(self, sel):
        loc = self.app.locator(sel).first
        loc.wait_for(state="visible", timeout=30000)
        b = loc.bounding_box()
        return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2

    def tap_at(self, x, y, after=350):
        self.stage("finger", x, y); self.W(380)
        self.stage("press", True); self.page.mouse.click(x, y); self.W(140); self.stage("press", False)
        self.W(after)

    def tap(self, sel, after=350):
        self.tap_at(*self.center(sel), after=after)

    def point(self, x, y, ms=900):                  # show the finger without tapping
        self.stage("finger", x, y); self.W(ms)

    def drag(self, x0, y0, x1, y1, ms=480, steps=16):
        self.stage("finger", x0, y0); self.W(350)
        self.stage("press", True); self.page.mouse.move(x0, y0); self.page.mouse.down()
        self.stage("glide", x1, y1, int(ms * self.speed))
        for k in range(1, steps + 1):
            self.page.mouse.move(x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps); self.W(ms / steps)
        self.page.mouse.up(); self.stage("press", False); self.W(250); self.stage("hide"); self.W(300)

    def swipe(self, dx, dy, sel=".card canvas"):
        x0, y0 = self.center(sel)
        self.drag(x0, y0, x0 + dx, y0 + dy)
        self.W(150)

    def type_into(self, sel, text):
        self.tap(sel, after=150)
        self.app.locator(sel).first.press_sequentially(text, delay=int(85 * self.speed) or 10)

    def esc(self):
        self.page.keyboard.press("Escape"); self.W(400)

    def open_example(self, name):
        self.tap("[data-act=examples]", after=600)
        self.tap(f".example:has-text('{name}')", after=200)
        self.app.locator(".sheet h3:has-text('Ready'), .sheet h3:has-text('already here')").first.wait_for(timeout=30000); self.W(600)
        if self.app.locator(".sheet h3:has-text('already here')").count():
            self.tap(".sheet [data-m=update]", after=300)
            self.app.locator(".sheet h3:has-text('Ready')").wait_for(timeout=30000); self.W(400)
        self.tap(".sheet [data-go]", after=900)

    def import_file(self, path):
        x, y = self.center("[data-act=import]")
        self.stage("finger", x, y); self.W(380); self.stage("press", True)
        with self.page.expect_file_chooser() as fc:
            self.page.mouse.click(x, y)
        fc.value.set_files(str(path)); self.W(140); self.stage("press", False)
        self.app.locator(".sheet h3:has-text('Ready'), .sheet h3:has-text('already here')").first.wait_for(timeout=30000); self.W(700)
        if self.app.locator(".sheet h3:has-text('already here')").count():
            self.tap(".sheet [data-m=copy]", after=300)
            self.app.locator(".sheet h3:has-text('Ready')").wait_for(timeout=30000); self.W(400)
        self.tap(".sheet [data-go]", after=900)

    # image pixels -> page pixels, in a screen that has a _debug() with its view transform
    def img_xy(self, root, x, y):
        d = self.frame.evaluate(f"() => document.querySelector('{root}')._debug()")
        b = self.app.locator(f"{root} canvas").bounding_box()
        return b["x"] + d["view"]["ox"] + x * d["view"]["s"], b["y"] + d["view"]["oy"] + y * d["view"]["s"]

    def card_xy(self, x, y, size):                  # a square card showing the whole image
        b = self.app.locator(".card canvas").bounding_box()
        return b["x"] + x * b["width"] / size, b["y"] + y * b["height"] / size

    def debug(self, root):
        return self.frame.evaluate(f"() => document.querySelector('{root}')._debug()")


def actions_part1(r, photos):
    def intro(): pass
    def open_app():
        r.W(2500); r.tap("[data-act=settings]", after=3800); r.esc()
    def example():
        r.W(1200); r.open_example("Model A vs model B")
        r.app.locator("#tour-name").wait_for(timeout=10000); r.W(900)
        r.type_into("#tour-name", "Dekel"); r.W(700)
        r.tap(".sheet [data-go]", after=600)
    def swipe_part():
        r.W(5200); r.swipe(-230, 10); r.W(900); r.swipe(230, 10); r.W(1200)
        r.tap(".ans[data-slot=down]", after=900); r.tap("[data-act=undo]", after=500)
    def zoom():
        r.W(400); r.tap(".card canvas", after=700)
        x, y = r.center(".zoom canvas")
        r.stage("finger", x, y); r.W(300)
        for _ in range(6):
            r.page.mouse.move(x, y); r.page.mouse.wheel(0, -120); r.W(110)
        r.stage("hide"); r.W(900)
        r.tap(".zoom [data-zsrc='A']", after=1100); r.tap(".zoom [data-zsrc='A']", after=700)
        r.tap("[data-z=close]", after=600)
        r.tap("[data-act=contrast]", after=700)
        x, y = r.center(".cpanel [data-k=max]")
        r.stage("finger", x + 40, y); r.W(300); r.stage("press", True)
        for v in range(100, 64, -3):
            r.app.locator(".cpanel [data-k=max]").fill(str(v)); r.W(70)
        r.stage("press", False); r.W(900); r.stage("hide")
        r.app.locator(".cpanel [data-cp=reset]").click(); r.W(400)
        r.tap(".cpanel [data-cp=close]", after=300)
    def editor():
        r.W(300); r.swipe(0, -250)
        r.app.locator(".editor canvas").wait_for(timeout=10000); r.W(1600)
        r.tap("[data-from=A]", after=1500); r.tap("[data-tool=wand]", after=900); r.tap(".editor canvas", after=1300)
        r.tap("[data-tool=cut]", after=1000); r.tap("[data-tool=merge]", after=900); r.tap("[data-tool=contour]", after=900)
        r.tap("[data-e=done]", after=800)
    def results():
        r.tap("[data-act=menu]", after=500); r.tap(".sheet [data-m=results]", after=2200)
        r.page.evaluate("() => document.getElementById('phone').contentWindow.scrollTo({top: 500, behavior: 'smooth'})"); r.W(2600)
        r.page.evaluate("() => document.getElementById('phone').contentWindow.scrollTo({top: 0, behavior: 'smooth'})"); r.W(900)
        r.tap("[data-r=back]", after=500)
    def channels():
        r.tap("[data-act=back]", after=600)
        r.open_example("2 channels over time"); r.W(1400)
        for sel, ms in [(".chanbar [data-chan='0']", 1300), (".chanbar [data-chan='1']", 1300), (".chanbar [data-chan=mix]", 1300), (".chanbar [data-chan=side]", 1800), (".chanbar [data-chan=mix]", 600)]:
            r.tap(sel, after=ms)
        r.tap(".card [data-act=play]", after=3200); r.tap(".card [data-act=play]", after=300)
    def ai():
        r.tap("[data-act=back]", after=700); r.tap("[data-act=ai]", after=0)
        r.app.locator("#ai-prompt").wait_for(timeout=10000)      # the prompt names the live format, not the recording server
        r.frame.evaluate("() => { const t = document.getElementById('ai-prompt'); t.value = t.value.split(location.origin + '/app/').join('https://deke1yahav.github.io/hooman/'); }")
        r.W(3500); r.tap(".sheet [data-copy]", after=1800); r.esc()
    def photos_part():
        r.tap("[data-act=photos]", after=900)
        x, y = r.center(".sheet [data-p=pick]")
        r.stage("finger", x, y); r.W(350); r.stage("press", True)
        r.app.locator("#ph-files").set_input_files(photos)   # what the chooser returns; its event is flaky in an iframe
        r.W(140); r.stage("press", False); r.W(600)
        r.app.locator("#ph-title").fill("Flowers"); r.app.locator("#ph-q").fill("")
        r.type_into("#ph-q", "Is the flower open?"); r.W(500)
        r.tap(".sheet [data-p=go]", after=300)
        r.app.locator(".sheet h3:has-text('Ready')").wait_for(timeout=30000); r.W(600)
        r.tap(".sheet [data-go]", after=1200); r.swipe(230, 10)
    def export_part():
        r.tap("[data-act=menu]", after=500); r.tap(".sheet [data-m=export]", after=2600); r.esc()
        r.tap("[data-act=menu]", after=500); r.tap(".sheet [data-m=share]", after=2400); r.esc()
        r.tap("[data-act=back]", after=600); r.tap("[data-act=settings]", after=2600); r.esc()
    def outro():
        r.stage("card", True, "Free and open source · works offline", "deke1yahav.github.io/hooman")
    return {"intro": intro, "open": open_app, "example": example, "swipe": swipe_part, "zoom": zoom, "editor": editor,
            "results": results, "channels": channels, "ai": ai, "photos": photos_part, "export": export_part, "outro": outro}


def actions_part2(r, part, export_to=None):
    real = ROOT / "video_work" / "real"
    T = json.loads((real / "targets.json").read_text())["tile1"]
    chats = json.loads((work(part) / "chat.json").read_text()) if (work(part) / "chat.json").exists() else {}

    def intro():
        r.W(300)
        r.tap("[data-act=settings]", after=300); r.esc()      # first run: the name, so the export says who fixed it
        r.page.evaluate("() => { const w = document.getElementById('phone').contentWindow; w.localStorage.setItem('hooman:annotator', JSON.stringify('Dekel')); w.localStorage.setItem('hooman:toured', 'true'); }")
    def build():
        r.stage("chat", chats.get("build"))
    def import_part():
        r.stage("chat", None); r.W(700)
        r.import_file(real / "nuclei-fix-v1.hooman.zip"); r.W(1200)
    def look():
        r.W(1600)
        for x, y in T["missed"][:2]:
            r.point(*r.card_xy(x, y, 128), ms=1100)
        m = T["merges"][0]
        r.point(*r.card_xy(*m["pieces"][0], 128), ms=900); r.point(*r.card_xy(*m["pieces"][1], 128), ms=900)
        r.stage("hide"); r.W(400)
        r.swipe(0, -250)
        r.app.locator(".editor canvas").wait_for(timeout=10000); r.W(700)
    def start():
        r.W(1200); r.tap("[data-from=model]", after=2200)
    def cut():
        r.tap("[data-tool=cut]", after=800)
        n0 = r.debug(".editor")["objects"]
        (a, b) = T["merges"][0]["line"]
        r.drag(*r.img_xy(".editor", *a), *r.img_xy(".editor", *b), ms=700)
        print(f"     cut: objects {n0} -> {r.debug('.editor')['objects']}")
        r.W(1500)
    def wand():
        r.tap("[data-tool=wand]", after=700)
        n0 = r.debug(".editor")["objects"]
        for x, y in T["missed"][:3]:
            r.tap_at(*r.img_xy(".editor", x, y), after=650)
        x, y = r.center("[data-size]")
        r.stage("finger", x, y); r.W(300); r.stage("press", True)
        for v in [0.1, 0.2, 0.3, 0.2, 0.1, 0.0]:
            r.app.locator("[data-size]").fill(f"{v:g}"); r.W(160)
        r.stage("press", False); r.stage("hide")
        print(f"     wand: objects {n0} -> {r.debug('.editor')['objects']}")
        r.W(600)
    def brush():
        x, y = T["missed"][min(2, len(T["missed"]) - 1)]      # touch up the nucleus the wand just added
        r.tap("[data-tool=brush]", after=500)
        r.drag(*r.img_xy(".editor", x - 4, y + 4), *r.img_xy(".editor", x + 4, y + 5), ms=500)
        r.tap("[data-tool=erase]", after=500)
        r.drag(*r.img_xy(".editor", x - 3, y + 5), *r.img_xy(".editor", x + 3, y + 5), ms=400)
        r.tap("[data-e=undo]", after=500); r.tap("[data-e=undo]", after=700)
    def save():
        r.tap("[data-e=done]", after=1500)
        r.tap("[data-act=menu]", after=500); r.tap(".sheet [data-m=export]", after=1200)
        x, y = r.center(".sheet [data-zip]")
        r.stage("finger", x, y); r.W(380); r.stage("press", True)
        with r.page.expect_download() as dl:
            r.page.mouse.click(x, y)
        r.W(140); r.stage("press", False)
        if export_to:
            dl.value.save_as(str(export_to))
        r.W(1600); r.esc()
    def back():
        r.stage("chat", chats.get("back"))
    def outro():
        r.stage("chat", None)
        r.stage("card", True, "Part 3: tracking, review and your own answers", "deke1yahav.github.io/hooman")
    return {"intro": intro, "build": build, "import": import_part, "look": look, "start": start, "cut": cut, "wand": wand,
            "brush": brush, "save": save, "back": back, "outro": outro}


def actions_part3(r):
    import numpy as np
    rr = np.random.default_rng(300); pos = rr.uniform(50, 206, (7, 2)); vel = rr.uniform(-9, 9, (7, 2))
    P0, V0, P1, V1 = np.array([70.0, 80.0]), np.array([9.0, 4.0]), np.array([170.0, 70.0]), np.array([-5.0, 8.0])

    def intro():
        r.page.evaluate("() => { const w = document.getElementById('phone').contentWindow; w.localStorage.setItem('hooman:annotator', JSON.stringify('Dekel')); w.localStorage.setItem('hooman:toured', 'true'); }")
    def jump():
        r.W(500); r.open_example("Follow a track"); r.W(1500)
        r.tap("[data-act=play]", after=2600); r.tap("[data-act=play]", after=400)
        r.tap(".ans[data-slot=left]", after=900)
        r.tap(".tapper [data-frame='2']", after=700)
        r.tap_at(*r.img_xy(".tapper", *(pos[3] + 2 * vel[3])), after=900)
        r.tap(".tapper [data-t=done]", after=600)
    def division():
        r.W(500); r.tap(".ans[data-slot=button]", after=900)
        r.tap(".tapper [data-frame='2']", after=500)
        for x, y in [pos[1] + 2 * vel[1] + [-6, 0], pos[1] + 2 * vel[1] + [6, 0]]:
            r.tap_at(*r.img_xy(".tapper", x, y), after=500)
        r.W(600); r.tap(".tapper [data-t=done]", after=500)
    def follow():
        r.tap("[data-act=back]", after=600)
        r.tap("[data-act=examples]", after=600); r.tap(".example:has-text('Follow the cells')", after=200)
        r.app.locator(".sheet h3:has-text('Ready')").wait_for(timeout=30000); r.W(500)
        r.tap(".sheet [data-go]", after=300)
        r.app.locator(".tapper canvas").wait_for(timeout=10000); r.W(1500)
        for t in (1, 2, 3):
            r.tap_at(*r.img_xy(".tapper", *(P0 + V0 * t)), after=700)
        x, y = r.img_xy(".tapper", *(P0 + V0 * 4))
        r.stage("finger", x, y); r.W(300); r.stage("press", True); r.page.mouse.move(x, y); r.page.mouse.down(); r.W(1600)
        r.page.mouse.up(); r.stage("press", False); r.W(400)
        r.tap(".tapper [data-t=divides]", after=500)
        c4 = P0 + V0 * 4
        r.tap_at(*r.img_xy(".tapper", c4[0], c4[1] - 11), after=400); r.tap_at(*r.img_xy(".tapper", c4[0], c4[1] + 11), after=900)
        r.app.locator(".tapper canvas").wait_for(timeout=10000)
        r.tap(".tapper [data-t=cancel]", after=500)
    def review():
        r.tap("[data-act=back]", after=600)
        r.tap(".deckrow:has-text('Follow a track')", after=900)
        r.tap("[data-act=menu]", after=500); r.tap(".sheet [data-m=review]", after=1500)
        r.tap(".filters .chip:nth-child(2)", after=1000); r.tap(".filters .chip:nth-child(1)", after=800)
        r.tap(".thumb >> nth=0", after=1200)
        r.swipe(230, 10); r.W(1200)
    def notes():
        r.tap("[data-act=back]", after=800)
        r.tap(".card .note-btn", after=500)
        r.type_into("#note-text", "Two cells touch here"); r.W(400)
        r.tap(".sheet [data-save]", after=1200)
    def buttons():
        r.tap("[data-act=menu]", after=500); r.tap(".sheet [data-m=edit]", after=1600)
        r.tap(".def:nth-child(3) [data-f=celebrate]", after=900)        # confetti for "Unsure" ("Same cell" has it already)
        r.app.locator(".sheet .defs").evaluate("e => e.parentElement.scrollTo({top: 400, behavior: 'smooth'})"); r.W(900)
        r.tap(".sheet [data-save]", after=900)
        r.swipe(0, -250); r.W(1600)
    def settings():
        r.tap("[data-act=back]", after=700); r.tap("[data-act=settings]", after=1200)
        r.tap("[data-col=cb]", after=900); r.esc()
        r.tap(".deckrow:has-text('Follow a track')", after=2200)
        r.tap("[data-act=back]", after=600); r.tap("[data-act=settings]", after=800)
        r.tap("[data-col=standard]", after=600)
        r.app.locator(".sheet").evaluate("e => e.scrollTo({top: 600, behavior: 'smooth'})"); r.W(2600); r.esc()
    def outro():
        r.stage("card", True, "Free and open source · works offline", "deke1yahav.github.io/hooman")
    return {"intro": intro, "jump": jump, "division": division, "follow": follow, "review": review, "notes": notes,
            "buttons": buttons, "settings": settings, "outro": outro}


def run_app(part, record_frames=True, speed=1.0, export_to=None):
    """Plays the part's chapters in the stage. Returns (frames, timeline, end) when recording."""
    from playwright.sync_api import sync_playwright
    segs = script(part)
    durations = json.loads((work(part) / "tts" / "durations.json").read_text()) if record_frames else {s["id"]: 0 for s in segs}
    srv, base = serve()
    frames, timeline = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--force-color-profile=srgb", "--font-render-hinting=none"])
        ctx = browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1, service_workers="block", accept_downloads=True)
        page = ctx.new_page()
        page.goto(base + "tools/video/stage.html")
        r = Rec(page, speed)
        r.app.locator(".hero").wait_for(timeout=30000)
        r.stage("part", PARTS[part]["label"])
        page.wait_for_timeout(600)
        if record_frames:
            cdp = ctx.new_cdp_session(page)

            def on_frame(params):
                frames.append((params["metadata"]["timestamp"], params["data"]))
                try:
                    cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
                except Exception:
                    pass
            cdp.on("Page.screencastFrame", on_frame)
            cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": 1920, "maxHeight": 1080, "everyNthFrame": 1})
            page.wait_for_timeout(400)
        acts = {1: lambda: actions_part1(r, sample_photos(1)), 2: lambda: actions_part2(r, 2, export_to), 3: lambda: actions_part3(r)}[part]()
        n = len(segs)
        for i, seg in enumerate(segs):
            start = time.time()
            dur = durations[seg["id"]]
            if seg["id"] != "intro":
                r.stage("card", False)
            r.stage("chapter", i, n, seg["chapter"], seg["title"])
            sents = sentences(display(seg["say"]))
            total = sum(len(s) for s in sents)
            sched, acc = [], 0
            for s in sents:
                sched.append([int((LEAD + dur * acc / total) * 1000), s]); acc += len(s)
            r.stage("subtitles", sched if record_frames else [])
            acts[seg["id"]]()
            r.stage("hide")
            left = LEAD + dur + TAIL - (time.time() - start)
            if record_frames and left > 0:
                page.wait_for_timeout(int(left * 1000))
            timeline.append({"id": seg["id"], "start": start, "dur": dur, "end": time.time()})
            print(f"  {seg['id']:<9} {timeline[-1]['end'] - start:5.1f} s")
        r.stage("subtitles", []); page.wait_for_timeout(1500 if record_frames else 100)
        end = time.time()
        if record_frames:
            cdp.send("Page.stopScreencast"); page.wait_for_timeout(300)
        browser.close()
    srv.shutdown()
    return frames, timeline, end


def chat_build():
    real = ROOT / "video_work" / "real"
    b = subprocess.run([sys.executable, str(VIDEO / "build_real_deck.py")], capture_output=True, text=True, check=True).stdout.strip().splitlines()
    c = subprocess.run([sys.executable, str(ROOT / "skill" / "hooman-deck-builder" / "scripts" / "check_deck.py"), str(real / "nuclei-fix-v1.hooman.zip")],
                       capture_output=True, text=True).stdout.strip().splitlines()
    b = [x.replace(str(real) + "\\", "").replace(str(real) + "/", "") for x in b]
    c = [x.replace(str(real) + "\\", "").replace(str(real) + "/", "") for x in c]
    return [{"who": "you", "name": "You", "text": PROMPT, "at": 300},
            {"who": "ai", "name": "Claude + Hooman skill", "at": 4200,
             "text": "Built it with the Hooman deck-builder skill, and checked it the way the app will. Swipe right = all right, up = fix it in the mask editor, down = unsure.",
             "term": ["$ python build_real_deck.py", *b, "$ python check_deck.py nuclei-fix-v1.hooman.zip", *c]}]


def dryrun(part):
    """Part 2: play the chapters fast to get the export, then put the real read_answers output in the final chat."""
    assert part == 2, "only part 2 has a dry run"
    w = work(part); w.mkdir(parents=True, exist_ok=True)
    chat = {"build": chat_build()}
    (w / "chat.json").write_text(json.dumps(chat, indent=1))
    exp = w / "nuclei-fix-v1.answers.zip"
    run_app(part, record_frames=False, speed=0.15, export_to=exp)
    s = subprocess.run([sys.executable, str(ROOT / "skill" / "hooman-deck-builder" / "scripts" / "read_answers.py"), str(exp)],
                       capture_output=True, text=True, check=True).stdout.strip().splitlines()
    chat["back"] = [{"who": "you", "name": "You", "text": "Here's my export, nuclei-fix-v1.answers.zip. What did I fix?", "at": 300},
                    {"who": "ai", "name": "Claude + Hooman skill", "at": 3400,
                     "text": "Your corrected tile is ready for training: the masks load as label arrays, and every object says where it came from.",
                     "term": ["$ python read_answers.py nuclei-fix-v1.answers.zip", *s, "$ python read_answers.py nuclei-fix-v1.answers.zip --masks fixed/"]}]
    (w / "chat.json").write_text(json.dumps(chat, indent=1))
    print("\n".join(s))


def record(part):
    w = work(part)
    frames, timeline, end = run_app(part)
    fdir = w / "frames"
    if fdir.exists():
        for f in fdir.glob("*.jpg"):
            f.unlink()
    fdir.mkdir(parents=True, exist_ok=True)
    t0 = frames[0][0]
    lst = []
    for k, (ts, data) in enumerate(frames):
        name = f"f{k:05d}.jpg"
        (fdir / name).write_bytes(base64.b64decode(data))
        nxt = frames[k + 1][0] if k + 1 < len(frames) else end
        lst.append((name, max(1 / 120, nxt - ts)))
    with open(fdir / "frames.ffconcat", "w") as f:
        f.write("ffconcat version 1.0\n")
        for name, d in lst:
            f.write(f"file '{name}'\nduration {d:.4f}\n")
        f.write(f"file '{lst[-1][0]}'\n")
    for t in timeline:
        t["start"] -= t0; t["end"] -= t0
    (w / "timeline.json").write_text(json.dumps({"total": end - t0, "chapters": timeline}, indent=1))
    print(f"recorded {len(frames)} frames, {end - t0:.0f} s")


# ---------------------------------------------------------------- 3. compose
def fmt_ts(t, srt=False):
    h, rem = divmod(t, 3600); m, s = divmod(rem, 60)
    if srt:
        return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int((s - int(s)) * 1000):03d}"
    return f"{int(m)}:{int(s):02d}" if h < 1 else f"{int(h)}:{int(m):02d}:{int(s):02d}"


MIN_CHAPTER = 10.5


def compose(part):
    w, o, P = work(part), out_dir(part), PARTS[part]
    segs = script(part)
    tl = json.loads((w / "timeline.json").read_text())
    total, chaps = tl["total"], tl["chapters"]
    hold = max(0.0, MIN_CHAPTER + 1.5 - (total - chaps[-1]["start"]))   # YouTube drops all chapters if one is under 10 s
    total += hold
    o.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(w / "frames" / "frames.ffconcat")]
    parts = []
    for k, c in enumerate(chaps):
        cmd += ["-i", str(w / "tts" / f"{c['id']}.wav")]
        ms = int((c["start"] + LEAD) * 1000)
        parts.append(f"[{k + 1}:a]aresample=48000,adelay={ms}|{ms}[a{k}]")
    mix = "".join(f"[a{k}]" for k in range(len(chaps)))
    fc = ";".join(parts) + f";{mix}amix=inputs={len(chaps)}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,apad[aout]"
    fc += f";[0:v]fps=30,tpad=stop_mode=clone:stop_duration={hold:.2f},scale=1920:1080:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st={total - 1.0:.2f}:d=1.0[vout]"
    out = o / f"{P['file']}.mp4"
    cmd += ["-filter_complex", fc, "-map", "[vout]", "-map", "[aout]", "-t", f"{total:.2f}",
            "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high",
            "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)
    print(f"video: {out} ({out.stat().st_size / 1e6:.1f} MB, {total:.0f} s)")

    srt, n = [], 1
    for seg, c in zip(segs, chaps):
        sents = sentences(display(seg["say"]))
        tot = sum(len(s) for s in sents); acc = 0
        for s in sents:
            a = c["start"] + LEAD + c["dur"] * acc / tot; acc += len(s)
            b = c["start"] + LEAD + c["dur"] * acc / tot
            srt.append(f"{n}\n{fmt_ts(a, True)} --> {fmt_ts(b, True)}\n{s}\n"); n += 1
    (o / f"{P['file']}.en.srt").write_text("\n".join(srt), encoding="utf-8")

    marks = []                                       # [start, name]; a chapter under 10 s (whole seconds, as YouTube reads them)
    for k, (seg, c) in enumerate(zip(segs, chaps)):  # joins the one before it
        end = int(chaps[k + 1]["start"]) if k + 1 < len(chaps) else int(total)
        if marks and end - int(c["start"]) < 10:
            joined = f"{marks[-1][1]} and {seg['chapter'][0].lower()}{seg['chapter'][1:]}"
            if len(joined) <= 28:
                marks[-1][1] = joined
        else:
            marks.append([0 if k == 0 else c["start"], seg["chapter"]])
    lines = [f"{fmt_ts(t)} {name}" for t, name in marks]
    about = {1: "the basics: swipe answers and undo · zoom, outlines and contrast · a first look at the mask editor · results with 95% confidence intervals · 16-bit microscopy with time-lapse and channels · decks made with AI or from your photos · export, sharing and backup.",
             2: "a real microscopy image (human nuclei in mitosis, BBBC, CC0) and a simple threshold model. Claude with the Hooman deck-builder skill builds the deck; then the mask editor fixes the model's real mistakes: start from the model, cut merged nuclei, add missed ones with the magic wand, brush, erase, undo, save and export, and the AI reads the corrected masks back.",
             3: "tracking: tapping where a cell really goes, divisions, and follow mode (manual tracking) · reviewing and changing answers · notes · editing the answer buttons (and confetti) · colour-blind-safe colours, your name, backup and team folders."}[part]
    desc = f"""{P['title']}

Hooman in the Loop is a free, open-source phone app for checking what an AI found in your images: swipe to judge each result, draw to fix the mistakes, and export clean answers and corrected masks for your next model. Works offline, no account, nothing leaves your phone.

This part covers {about}

▶ Open the app: https://deke1yahav.github.io/hooman/
▶ Deck format for your AI (ChatGPT, Claude, Gemini): https://deke1yahav.github.io/hooman/llms.txt
▶ Claude skill (builds and checks decks): https://deke1yahav.github.io/hooman/skill/hooman-deck-builder.zip
▶ Source code (MIT): https://github.com/Deke1Yahav/hooman

Chapters
{chr(10).join(lines)}

Part 1: Getting started · Part 2: Fix real masks · Part 3: Tracking, review, customising
Narration: Piper text-to-speech (LJSpeech voice, public domain).{" Image: BBBC, human nuclei in mitosis (David Root, CC0)." if part == 2 else ""}

#humanintheloop #machinelearning #microscopy #imageannotation #segmentation
"""
    meta = {"title": P["title"], "description": desc, "playlist": "Hooman in the Loop: user guide", "position": part,
            "tags": ["human in the loop", "image annotation", "data labeling", "segmentation", "microscopy", "cell segmentation",
                     "mask editor", "model evaluation", "open source", "cell tracking", "ground truth", "active learning"],
            "category": "Science & Technology", "language": "en", "chapters": lines}
    (o / "youtube.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    (o / "youtube-description.txt").write_text(desc, encoding="utf-8")
    print("subtitles, description and chapters written")


# ---------------------------------------------------------------- 4. thumbnail
def thumb(part):
    from playwright.sync_api import sync_playwright
    srv, base = serve()
    w, o, P = work(part), out_dir(part), PARTS[part]
    o.mkdir(parents=True, exist_ok=True); w.mkdir(parents=True, exist_ok=True)
    frames = sorted((w / "frames").glob("*.jpg"))
    tl = json.loads((w / "timeline.json").read_text())
    pick = {1: "swipe", 2: "wand", 3: "follow"}[part]
    ch = next(c for c in tl["chapters"] if c["id"] == pick)
    lines = (w / "frames" / "frames.ffconcat").read_text().splitlines()[1:]
    t, best = 0.0, frames[0].name
    for i in range(0, len(lines) - 1, 2):
        name = re.search(r"'(.+)'", lines[i]).group(1)
        if t <= ch["start"] + ch["dur"] * 0.85:
            best = name
        t += float(lines[i + 1].split()[1])
    from PIL import Image
    Image.open(w / "frames" / best).crop((1270, 92, 1700, 976)).save(w / "thumb_phone.png")
    head, sub = P["thumb"]
    html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face {{ font-family: A; font-weight: 700; src: url({base}app/fonts/atkinson-700.woff2); }}
      body {{ margin: 0; width: 1280px; height: 720px; overflow: hidden; font-family: A; color: #e8f0f2;
             background: radial-gradient(900px 600px at 70% 40%, #1d3239 0%, #0d1214 65%); }}
      .t {{ position: absolute; left: 70px; top: 165px; width: 760px; }}
      .t h1 {{ font-size: 96px; line-height: 1.0; margin: 0; }}
      .t h1 span {{ color: #c6ff3d; }}
      .t p {{ font-size: 40px; color: #b9e3ff; margin: 34px 0 0; }}
      .logo {{ position: absolute; left: 70px; top: 56px; display: flex; gap: 16px; align-items: center; font-size: 34px; color: #8fa3aa; }}
      .logo img {{ width: 64px; height: 64px; border-radius: 16px; }}
      .ph {{ position: absolute; right: 70px; top: 26px; width: 330px; height: 679px; transform: rotate(4deg);
             filter: drop-shadow(0 30px 50px rgba(0,0,0,.7)); }}
      .ph img {{ width: 100%; height: 100%; object-fit: cover; border-radius: 40px; }}
    </style></head><body>
      <div class="logo"><img src="{base}app/icons/icon-192.png">Hooman in the Loop</div>
      <div class="t"><h1>{head}</h1><p>{sub}</p></div>
      <div class="ph"><img src="{base}video_work/part{part}/thumb_phone.png"></div></body></html>"""
    (w / "thumb.html").write_text(html, encoding="utf-8")
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_context(viewport={"width": 1280, "height": 720}).new_page()
        pg.goto(base + f"video_work/part{part}/thumb.html"); pg.wait_for_timeout(700)
        pg.screenshot(path=str(o / f"{P['file']}-thumbnail.png"))
        b.close()
    srv.shutdown()
    print(f"thumbnail: {o / (P['file'] + '-thumbnail.png')}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    part = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 1
    steps = [s for s in sys.argv[2:]] or ["tts", *(["dryrun"] if part == 2 else []), "record", "compose", "thumb"]
    for s in steps:
        print(f"== part {part}: {s}")
        {"tts": tts, "record": record, "compose": compose, "thumb": thumb, "dryrun": dryrun}[s](part)
