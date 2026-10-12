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

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

MODELS = pathlib.Path(__file__).resolve().parents[2] / "video_work" / "tts_models"
MAX_PAUSE = 0.45          # seconds; the voice sometimes rests 0.6-0.7 s between sentences, which sounds slow


def cap_pauses(audio, sr, longest=MAX_PAUSE, floor_db=-40.0, win=0.01):
    """Shorten every quiet stretch longer than `longest` to `longest` (the middle of it is cut)."""
    n = int(sr * win)
    frames = len(audio) // n
    if frames < 2:
        return audio
    rms = np.sqrt(np.mean(audio[: frames * n].reshape(frames, n).astype(np.float64) ** 2, axis=1))
    quiet = 20 * np.log10(rms + 1e-9) < floor_db
    keep, i, cap = [], 0, int(longest / win)
    while i < frames:
        j = i
        while j < frames and quiet[j] == quiet[i]:
            j += 1
        if quiet[i] and j - i > cap:
            half = cap // 2
            keep.append((i * n, (i + half) * n)); keep.append(((j - (cap - half)) * n, j * n))
        else:
            keep.append((i * n, j * n))
        i = j
    keep.append((frames * n, len(audio)))
    return np.concatenate([audio[a:b] for a, b in keep])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs"); ap.add_argument("out")
    ap.add_argument("--voice", default="af_heart"); ap.add_argument("--speed", type=float, default=1.0); ap.add_argument("--lang", default="en-us")
    a = ap.parse_args()
    k = Kokoro(str(MODELS / "kokoro-v1.0.onnx"), str(MODELS / "voices-v1.0.bin"))
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    durations = {}
    for job in json.loads(pathlib.Path(a.jobs).read_text(encoding="utf-8")):
        # The whole chapter at once: the voice then carries its own rhythm from sentence to sentence.
        # (Sentence by sentence with fixed gaps sounded stop-and-go.)
        audio, sr = k.create(job["text"], voice=a.voice, speed=a.speed, lang=a.lang)
        audio = cap_pauses(audio, sr)
        sf.write(out / f"{job['id']}.wav", audio, sr, subtype="PCM_16")
        durations[job["id"]] = len(audio) / sr
        print(f"  {job['id']:<9} {durations[job['id']]:5.1f} s")
    (out / "durations.json").write_text(json.dumps(durations, indent=1))


if __name__ == "__main__":
    main()
