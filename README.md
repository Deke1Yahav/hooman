# Hooman in the Loop

> The AI guesses. The hooman decides.

▶ **Video guide:** [Part 1: Getting started](https://youtu.be/PI-3ms1sx_E) (3 min) · [Part 2: An AI builds the deck, you fix the masks](https://youtu.be/9HHWi0D_Dms) (2 min) · [Part 3: Tracking, review and your own answers](https://youtu.be/Bi8DEyOR9Fc) (2 min)

Hooman in the Loop is a phone-first web app (PWA) for checking a model's results by hand.
- Swipe to judge what a model found on your images.
- Draw to fix it.
- Export clean answers and corrected masks, or let live save copy them to Google Drive or a folder seconds after each answer.

Any LLM can build a deck from the spec in [app/llms.txt](app/llms.txt). Claude users can add the [hooman-deck-builder skill](https://deke1yahav.github.io/hooman/skill/hooman-deck-builder.zip): it builds and checks decks, and reads the answers back, with tested scripts. The app runs offline, with no account and no server. Everything is stored on the device.

## Layout

```
app/                    the whole app: static files, no build step
  index.html, app.css   shell and styles (dark, phone-first)
  llms.txt              the deck format, written for LLMs (served with the app)
  deck.schema.json      JSON Schema of deck.json
  sw.js, manifest.webmanifest   offline cache + install + Android share target
  js/app.js             screens: home, swipe, review, sheets, zoom
  js/editor.js          mask editor: brush, contour, polygon, magic wand, pick, erase, cut, merge,
                        fill holes, delete; objects + classes, channels, undo/redo
  js/contrast.js        black/white point, gamma, invert per deck or channel
  js/tapping.js         tap answers (point / points) and follow mode (manual tracking)
  js/gestures.js        tap / pan / pinch / hold for the tap screens
  js/results.js         results: counts, 95% Wilson intervals, Cohen's kappa vs another export
  js/backup.js          backup / restore (merging), restoring a deck's own .answers.zip
  js/settings.js        annotator name, colour-blind palette, backup bookkeeping
  js/share.js           deck.json rebuilt from a stored deck, deck zips, QR codes, Drive link ids
  js/photos.js          "New deck from photos" (no AI)
  js/drive.js           Google Drive: sign-in, Picker, download/upload, share links (drive.file scope)
  js/install.js         "Install the app": shown only until it is installed on this device
  js/livesave.js        live save: each deck's answers to Google Drive and/or a folder, seconds after each answer
  js/config.js          the Google Cloud ids for this copy of the app (empty = Drive features hidden)
  vendor/qrcode.mjs     QR code generator (Kazuhiko Arase, MIT)
  js/prefs.js           per-viewer settings (localStorage)
  js/deck.js            deck.json -> normalized deck + LLM-pasteable errors
  js/importer.js        zip / deck.json / link import, size checks; big zips (40+ images or 30+ MB) open after their first card
  js/decksfolder.js     the decks folder: deck zips put in a picked folder show up by themselves (and update their decks)
  js/handles.js         picked folders kept between visits (with a guard for browsers that crash reading them back)
  js/loading.js         the background loading of big decks: the card on screen first, resumable by picking the zip again
  js/view.js            card renderer (pixel-exact vector mask outlines)
  js/png.js             label-PNG decode/encode (8/16-bit, palette, RGB), image size sniffing
  js/zip.js             zip read (deflate, zip64) / write
  js/store.js           IndexedDB: decks, files, answers, append-only log
  js/export.js          answers.csv + answers.json + masks/*.png
  examples/             example decks (built by tools/make_examples.py)
  skill/                the deck-builder skill as a download (built by tools/build_skill.py)
skill/hooman-deck-builder/   Claude skill: SKILL.md, scripts/hooman.py (build), check_deck.py (the app's checks),
                        read_answers.py (summary, kappa, masks); references/ = llms.txt + schema (synced)
skill/tests/test_skill.py    builds decks, checks parity with the app's messages, imports them in the app
tools/build_skill.py    syncs the skill's references, zips it into app/skill/, installs it to ~/.claude/skills
tools/video/            the YouTube user guide: make_video.py (Piper narration, Playwright recording, ffmpeg),
                        stage.html, script.json / part2.json / part3.json (narration), build_real_deck.py (BBBC CC0 image)
tools/make_examples.py  builds the example decks (also checks them against the schema)
tools/make_icons.py     draws the icons
tests/e2e.py            Playwright test in phone-sized Chromium; screenshots in tests/out/
tests/e2e_v3.py         0.3 features: tap/follow answers, notes, number/text, per-frame masks, results,
                        backup/restore, guides, bold, provenance, storage check, copy for the AI, colours
tests/e2e_v4.py         0.4: decks from photos, sharing (file, link, QR), Drive features against a stand-in Google
tests/e2e_v5.py         0.4: channels per time frame, narrow-card layout, Start from across frames / bold only
tests/e2e_v6.py         0.4.2-0.4.4: the install button (Android dialog or steps, iPhone, installed app, computers), the Drive guide
tests/e2e_v9.py         0.7: the decks folder (new, changed and broken zips, resume, results subfolder, reconnect), in Google Chrome
tests/e2e_v8.py         0.6: big decks open at once and load in the background (jump ahead, broken card, restart + resume)
tests/e2e_v7.py         0.5: live save to a folder (in the installed Google Chrome) and to Google Drive (stand-in): merging,
                        pausing and reconnecting, team folders, the crash guard
reference/              the earlier claude.ai pages this app grew from (read-only)
```

## Run it locally

```
cd app
python -m http.server 8000      # open http://localhost:8000
```

The service worker and the share target need HTTPS or localhost. Everything else also works over plain http on a local network.

## Test

```
python tests/e2e.py
python tests/e2e_v3.py
python tests/e2e_v4.py
python tests/e2e_v5.py
python tests/e2e_v6.py
python tests/e2e_v7.py
python tests/e2e_v8.py
python tests/e2e_v9.py
python skill/tests/test_skill.py
```

The test covers:
- importing every example deck
- swipes (mouse and real touch), buttons, keys and undo
- review and changing an answer
- editing the answer buttons
- "both wrong → draw" in the mask editor (start from a model, brush, contour, undo/redo)
- raw 16-bit microscopy: auto contrast, the contrast panel, channel switching, and the cell tools (pick, merge, cut, wand + slider, contour, polygon, delete, fill holes)
- the confetti blast on a `celebrate` answer
- annotate decks with classes
- export contents
- persistence after a reload
- update-in-place
- the error messages for broken decks
- layout at 360×640, 375×667 and 390×720

## Deploy

Live at **https://deke1yahav.github.io/hooman/**. GitHub Pages serves the `gh-pages` branch, which is the `app/` folder on its own. To release:

```
# bump VERSION in app/sw.js first, so installed copies update
git subtree split --prefix app -b gh-pages-new
git push -f origin gh-pages-new:gh-pages
git branch -D gh-pages-new
```

Any other static HTTPS host works too (Netlify, a lab server): copy `app/` as it is.

## User guide videos

```
pip install piper-tts playwright imageio-ffmpeg     # + the en_US-ljspeech-high voice
python tools/video/make_video.py 1                  # part 1: getting started (2 = real masks, 3 = tracking and review)
python tools/video/make_video.py 2 compose thumb    # only some steps: tts, dryrun (part 2), record, compose, thumb
```

Each part goes to `video_out/partN/`: the mp4, English subtitles (.srt), a thumbnail, and the YouTube title, description and chapters.

## Licence

[MIT](LICENSE): free for everyone to use, change and share. The bundled fonts (Atkinson Hyperlegible, JetBrains Mono) are under the SIL Open Font License; see [app/fonts/OFL.txt](app/fonts/OFL.txt).
