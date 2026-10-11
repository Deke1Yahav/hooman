"""Sync the skill's copy of the format (llms.txt + schema), then package it for download and for Claude Code.

    python tools/build_skill.py            # -> app/skill/hooman-deck-builder.zip (+ .skill), and ~/.claude/skills/hooman-deck-builder
    python tools/build_skill.py --no-install
"""
import pathlib
import shutil
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKILL = ROOT / "skill" / "hooman-deck-builder"


def main():
    shutil.copyfile(ROOT / "app" / "llms.txt", SKILL / "references" / "format.md")
    shutil.copyfile(ROOT / "app" / "deck.schema.json", SKILL / "references" / "deck.schema.json")
    out = ROOT / "app" / "skill"
    out.mkdir(exist_ok=True)
    files = [p for p in sorted(SKILL.rglob("*")) if p.is_file() and "__pycache__" not in p.parts]
    zp = out / "hooman-deck-builder.zip"
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, f"hooman-deck-builder/{p.relative_to(SKILL).as_posix()}")
    shutil.copyfile(zp, out / "hooman-deck-builder.skill")
    print(f"packaged {len(files)} files -> {zp}")
    if "--no-install" not in sys.argv:
        dest = pathlib.Path.home() / ".claude" / "skills" / "hooman-deck-builder"
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(SKILL, dest, ignore=shutil.ignore_patterns("__pycache__"))
        print(f"installed for Claude Code -> {dest}")


if __name__ == "__main__":
    main()
