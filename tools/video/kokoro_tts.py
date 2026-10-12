"""Narration with Kokoro (82M, Apache 2.0): a far more natural voice than Piper, still offline and free.

Runs in its own environment (it needs kokoro-onnx; the video script calls it there):
    python -m venv %USERPROFILE%/.venvs/hooman-tts
    %USERPROFILE%/.venvs/hooman-tts/Scripts/python -m pip install kokoro-onnx soundfile
Model files (kokoro-v1.0.onnx, voices-v1.0.bin) from https://github.com/thewh1teagle/kokoro-onnx/releases go in
video_work/tts_models/.

    python kokoro_tts.py jobs.json out_dir --voice af_heart --speed 1.0
jobs.json: [{"id": "intro", "text": "..."}, ...]  ->  out_dir/<id>.wav (24 kHz mono) + out_dir/durations.json
"""
import argparse
import json
import pathlib
import re

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

MODELS = pathlib.Path(__file__).resolve().parents[2] / "video_work" / "tts_models"
PAUSE = {".": 0.32, "?": 0.34, "!": 0.32, ":": 0.22, ";": 0.2}      # between sentences: a speaker's breath, not a robot's gap


def sentences(text):
    return [s for s in re.split(r"(?<=[.!?:;])\s+(?=[A-Z0-9\"“])", text.strip()) if s]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs"); ap.add_argument("out")
    ap.add_argument("--voice", default="af_heart"); ap.add_argument("--speed", type=float, default=1.0); ap.add_argument("--lang", default="en-us")
    a = ap.parse_args()
    k = Kokoro(str(MODELS / "kokoro-v1.0.onnx"), str(MODELS / "voices-v1.0.bin"))
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    durations = {}
    for job in json.loads(pathlib.Path(a.jobs).read_text(encoding="utf-8")):
        parts, sr = [], 24000
        for s in sentences(job["text"]):
            audio, sr = k.create(s, voice=a.voice, speed=a.speed, lang=a.lang)
            parts += [audio, np.zeros(int(sr * PAUSE.get(s[-1], 0.25)), dtype=audio.dtype)]
        audio = np.concatenate(parts[:-1]) if parts else np.zeros(1, dtype=np.float32)
        sf.write(out / f"{job['id']}.wav", audio, sr, subtype="PCM_16")
        durations[job["id"]] = len(audio) / sr
        print(f"  {job['id']:<9} {durations[job['id']]:5.1f} s")
    (out / "durations.json").write_text(json.dumps(durations, indent=1))


if __name__ == "__main__":
    main()
