---
name: hooman-deck-builder
description: Build swipe decks for the phone app "Hooman in the Loop" (https://deke1yahav.github.io/hooman/), check them the way the app will, and read the exported answers back. Use this whenever someone wants a person to check, compare, label, fix or count things in images on their phone, for example "is this segmentation right?", "which model is better, A or B?", "fix the masks", "label these photos", "proofread my tracking", "human-in-the-loop review", or a dataset to clean before retraining. Also use it when they mention Hooman, a .hooman.zip, deck.json, llms.txt of this app, or hand you an .answers.zip or hooman-backup zip to analyse. Covers microscopy (16-bit, time-lapse, several channels, label masks, tracks) and ordinary photos (boxes, COCO).
---

# Hooman in the Loop: deck builder

Hooman in the Loop is a free, offline phone app (a web app at https://deke1yahav.github.io/hooman/). A person (the "hooman") swipes through cards to judge what a model found on their images, draws masks to fix it, and exports the answers.

Your job is to turn the user's images and model outputs into a **deck**: a `.hooman.zip` with `deck.json` plus the images. Later, you turn the exported answers back into numbers, tables or training data.

The full format is in `references/format.md`, the app's own llms.txt. Read its sections when you need a field you don't see here. The scripts in `scripts/` do the fiddly parts. Use them instead of hand-writing zips, because the app is strict about paths, sizes and masks, and the scripts get these right every time.

## 1. Understand what the hooman should decide

Before writing code, pin down four things. Ask only about what you can't infer.
1. **The question.** What should the person say about each card? Keep it short: it shows on the phone in up to 3 lines (about 120 characters).
2. **The answers.** Map them to swipes (right, left, up, down) plus up to 6 buttons.
   - Put a model's name in the answer `value` (`"A"`, `"B"`), and its button takes that model's colour.
   - Add `"then": "draw"` (draw the right mask), `"point"` or `"points"` (tap a spot or spots), or `"number"` / `"text"` when an answer needs more than a choice.
   - `"celebrate": true` fires confetti for the answer you hope to see (for example "model right"). People like it.
3. **The cards.** One card per image, per object (with `focus`), or per cell track?
4. **What to show.** Which model outputs (masks, boxes, points, polygons), which channels or time points, and whether a "where to look" guide is needed.

## 2. Pick the pattern and build it

`scripts/hooman.py` has a `Deck` class and ready-made builders. Put its folder on the path first: `sys.path.insert(0, "<skill>/scripts")`.

| The user wants | Use |
|---|---|
| yes/no (or any answers) over a folder of images | `from_folder(folder, question, out)` or `python scripts/hooman.py folder <dir> --question "..." --out x.hooman.zip` |
| model A vs model B, one card per object, only where they disagree | `model_duel(items, out)` with `[(name, image, labels_a, labels_b)]`, or the `duel` command |
| check each object of one model | `objects_deck(items, out)`: focus on the object, all outlines thin, it in bold |
| time-lapse (one or several channels), compare models per cell | `timelapse_deck(frames, out, channel_names=..., models={...}, guide="box")` |
| detections in COCO | `from_coco(coco.json, images_dir, out)` |
| draw masks from scratch (annotate) | `Deck(id)` with no question, plus optional `.classes(...)` |
| manual tracking | `Deck(id, mode="follow")`, with cards that have `frames` and `start=[x, y, frame]` |

Anything else: compose a `Deck` by hand:

```python
from hooman import Deck, box, point
deck = Deck("cells-v1", "Which model got the bold cell right?", title="Cells")
deck.source("A", label="Cellpose").source("B", label="StarDist").source("look", guide=True)
deck.answers(left=("Cellpose right", "A"), right=("StarDist right", "B"), up=("Both wrong", "both_wrong", "draw"), down="Unsure")
img = deck.image(raw_uint16)                         # numpy arrays, file paths or bytes; identical files stored once
a, b = deck.mask(lab_a, source="A"), deck.mask(lab_b, source="B")
deck.card(img, id="f1_c7", focus=[x, y, w, h], info="field 1 · cell 7",
          overlays=[a, b, deck.mask(lab_a, source="A", value=7, style="bold"), box(x, y, w, h, source="look")])
deck.save("cells.hooman.zip")                        # checks first; raises DeckError listing what to fix
```

## 3. Rules that matter (and why)

- **A stable `id`.** Answers on the phone are kept by deck id plus card id. Rebuild with the same ids and the hooman keeps their work; change the deck id to start fresh.
- **Masks are label images the same size as their image.** 0 is background, and every object has its own number. The app draws pixel-exact outlines, so a shifted or resized mask is visibly wrong. Never burn outlines into the image itself.
- **Show the object in question.** Draw a model's full mask thin, then the same mask again with `value=<id>` and `style="bold"`. "Start from" in the editor then copies only the bold object. Also add `focus` so the card opens zoomed on it.
- **Guides are not models.** A "where to look" box or ring goes in a source with `guide=True`. Otherwise it shows up as a model chip and in "Start from".
- **Microscopy stays raw.** Save 16-bit greyscale as 16-bit PNG: the app sets the contrast itself, and the person can adjust it per channel. Convert TIFF to PNG, because phones can't show TIFF.
- **Several channels per time point.** Use deck `channels` (names and colours) and give each frame its other `channels`. The person can switch channels, mix them, or see them side by side (format section 4b). Overlays and `frame` indexes refer to time points, not channels.
- **The same cell keeps the same number in every frame** of a `frames_are="time"` deck. The app relies on that ("same number = same cell").
- **Size budget.**
  - About 50 MB and 1000 cards per deck. Reuse one image for many object cards (the builder stores identical files once).
  - Keep the long side at 2048 px or less (1024 px or less when a card has many frames × channels).
  - Bigger sets: `split_cards(deck)` makes parts.
  - Captions (`info`) of about 40 characters or less fit on one line.

## 4. Check, then deliver

Run `python scripts/check_deck.py deck.hooman.zip`. It reports exactly what the app would refuse, with the same messages, plus warnings (long captions, oversized images). Fix every ERROR. `Deck.save()` runs the same check.

Hand the deck over in one of two ways:
- **As a file:** the user opens the zip in the app with **Import**, or on Android shares it to the installed app.
- **As a link**, so it opens straight in the app (also printable as a QR code):
  1. Host the zip (or deck.json with its images next to it) somewhere that allows cross-origin downloads: GitHub raw, a gist, Hugging Face, or a Google Drive file shared as "anyone with the link".
  2. Give the user `https://deke1yahav.github.io/hooman/?deck=<URL-encoded link>`.

Tell the user, in a sentence or two, how many cards there are, what each swipe means, and roughly how long it takes (about 3 to 5 seconds per card).

## 5. Read the answers back

The hooman exports `<deck id>.answers.zip`. It contains:
- `answers.csv` and `answers.json`, keyed by card id
- `masks/<card>.png` (one per frame in time decks)
- `by` (who answered), `from` / `from_values` / `edits` on drawn objects, `points` (taps, with the segmentation objects they hit), `end` (follow mode), `note`, `number` and `text`

If the user has a decks folder (Settings → Decks folder), saving the zip into it is the whole delivery: it appears in the app by itself, and a newer zip with the same `id` updates the deck (answers kept).

With live save on (Settings → Live save), the same zip is kept up to date in the user's Google Drive or a folder, as `<deck id>.<annotator>.answers.zip`, one per person. For a team, ask for every file in that folder: they compare directly.

```bash
python scripts/read_answers.py mine.answers.zip                    # counts, % with 95% intervals, time per card
python scripts/read_answers.py a.answers.zip b.answers.zip --csv all.csv   # + agreement (Cohen's / Fleiss' kappa)
python scripts/read_answers.py mine.answers.zip --masks fixed_masks/       # the drawn masks as numpy label arrays
```

Join the results back to the user's data on the card id. When you report, separate what the hooman decided (counts, which model won, with intervals) from what to do next (cards to relabel, masks to add to training). The "Results" screen in the app shows the same numbers, so the user can check you.

## Files

- `scripts/hooman.py`: `Deck`, overlay helpers (`box`, `point`, `polygon`, `.mask`), the builders, `split_cards`, and a command line.
- `scripts/check_deck.py`: the app's import checks in Python (standard library only).
- `scripts/read_answers.py`: load exports and backups, summary, agreement, masks, joined CSV.
- `references/format.md`: the complete deck format and recipes (the app's llms.txt). Sections:
  - 2: deck fields
  - 3: answers
  - 4: cards and overlays
  - 4b: channels
  - 5: annotate and the editor
  - 5b: follow mode
  - 6: what comes back
  - 7: recipes
  - 8: checklist
