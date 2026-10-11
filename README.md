# Hooman in the Loop

> The AI guesses. The hooman decides.

Hooman in the Loop is a phone-first web app (PWA) for checking a model's results by hand.
- Swipe to judge what a model found on your images.
- Draw to fix it.
- Export clean answers and corrected masks.

Any LLM can build a deck from the spec in [app/llms.txt](app/llms.txt). It runs offline, with no account and no server. Everything is stored on the device.

## Layout

```
app/                    the whole app: static files, no build step
  index.html, app.css   shell and styles (dark, phone-first)
  llms.txt              the deck format, written for LLMs (served with the app)
  deck.schema.json      JSON Schema of deck.json
  sw.js, manifest.webmanifest   offline cache + install + Android share target
  js/app.js             screens: home, swipe, review, sheets, zoom
  js/editor.js          mask editor (brush, eraser, lasso, objects, classes, undo)
  js/deck.js            deck.json -> normalized deck + LLM-pasteable errors
  js/importer.js        zip / deck.json / link import, size checks
  js/view.js            card renderer (pixel-exact vector mask outlines)
  js/png.js             label-PNG decode/encode (8/16-bit, palette, RGB), image size sniffing
  js/zip.js             zip read (deflate, zip64) / write
  js/store.js           IndexedDB: decks, files, answers, append-only log
  js/export.js          answers.csv + answers.json + masks/*.png
  examples/             example decks (built by tools/make_examples.py)
tools/make_examples.py  builds the example decks (also checks them against the schema)
tools/make_icons.py     draws the icons
tests/e2e.py            Playwright test in phone-sized Chromium; screenshots in tests/out/
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
```

The test covers:
- importing every example deck
- swipes (mouse and real touch), buttons, keys and undo
- review and changing an answer
- editing the answer buttons
- "both wrong → draw" in the mask editor (start from a model, brush, lasso, undo/redo)
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
