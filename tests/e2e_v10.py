"""End-to-end checks for 0.10's Archive tab: finished decks move there by themselves, the deck menu moves a deck
either way, and the home screen remembers the tab. 0.13: the home screen's search filters the list as each letter is
typed. 0.14: About this deck (deck.json "about" and the hooman's own notes).

    python tests/e2e_v10.py           # screenshots go to tests/out/
"""
import sys

from playwright.sync_api import sync_playwright

from e2e import OUT, serve, check, failures, import_example
from e2e_v3 import phone, watch
from e2e_v9 import small_deck


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = phone(browser); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        import_example(page, "Is it a circle?")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        import_example(page, "Model A vs model B")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        check(page.locator(".tabs-row .tabs").count() == 0, "no tabs while nothing is archived")

        print("A finished deck goes to the Archive")
        page.goto(base + "#/deck/example-circles"); page.wait_for_selector(".card canvas")
        for _ in range(12):
            page.keyboard.press("ArrowRight"); page.wait_for_timeout(350)
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        tabs = page.locator(".tabs-row .tabs")
        check(tabs.count() == 1 and "To do (1)" in tabs.inner_text() and "Archive (1)" in tabs.inner_text(), f"tabs: To do (1) · Archive (1) ({tabs.inner_text() if tabs.count() else ''!r})")
        check(page.locator(".deckrow", has_text="circle").count() == 0 and page.locator(".deckrow", has_text="Model A").count() == 1, "My decks lists only the unfinished deck")
        page.locator("[data-tab=archive]").click(); page.wait_for_timeout(300)
        row = page.locator(".deckrow", has_text="circle")
        check(row.count() == 1 and "✓ 12 / 12" in row.inner_text(), "the Archive lists the finished deck, ticked")
        page.screenshot(path=OUT / "100_archive_tab.png")
        page.reload(); page.wait_for_selector(".hero")
        check(page.locator(".deckrow", has_text="circle").count() == 1, "the home screen remembers the Archive tab")

        print("The deck menu moves a deck either way")
        row = page.locator(".deckrow", has_text="circle"); row.click(); page.wait_for_timeout(600)
        page.locator("[data-act=menu]").click(); page.locator(".sheet [data-m=shelf]").click(); page.wait_for_timeout(600)
        check("Back in To do" in page.locator("#toast").inner_text() and page.locator(".deckrow", has_text="circle").count() == 1
              and page.locator(".tabs-row .tabs").count() == 0, "Back to my decks: a finished deck returns (and with nothing archived, no tabs)")
        page.locator(".deckrow", has_text="Model A").click(); page.wait_for_selector(".card canvas")
        page.locator("[data-act=menu]").click()
        check("Move to archive" in page.locator(".sheet [data-m=shelf]").inner_text(), "an unfinished deck offers Move to archive")
        page.locator(".sheet [data-m=shelf]").click(); page.wait_for_timeout(600)
        check(page.locator("[data-tab=archive]").get_attribute("aria-pressed") == "true" and page.locator(".deckrow", has_text="Model A").count() == 1,
              "it moves to the Archive")
        page.locator("[data-tab=decks]").click(); page.wait_for_timeout(300)
        check(page.locator(".deckrow", has_text="circle").count() == 1 and page.locator(".deckrow", has_text="Model A").count() == 0, "and My decks keeps the one brought back")

        print("Each row's ⋮: archive and delete from the home screen")
        page.locator(".deckitem", has_text="circle").locator("[data-act=rowmenu]").click(); page.wait_for_selector(".sheet .menu")
        check([b.inner_text() for b in page.locator(".sheet .menu button").all()] == ["Open", "About this deck", "Move to archive", "Delete from this phone"],
              "the row menu: Open, About this deck, Move to archive, Delete from this phone")
        page.locator(".sheet [data-r=shelf]").click(); page.wait_for_timeout(500)
        check("Moved to the Archive" in page.locator("#toast").inner_text() and page.locator("[data-tab=archive]").inner_text() == "Archive (2)", "Move to archive works from the home screen")
        page.locator("[data-tab=archive]").click(); page.wait_for_timeout(300)
        page.locator(".deckitem", has_text="circle").locator("[data-act=rowmenu]").click(); page.wait_for_selector(".sheet .menu")
        page.locator(".sheet [data-r=delete]").click(); page.wait_for_selector(".sheet h3:has-text('Delete')")
        check("all its answers" in page.locator(".sheet").inner_text(), "Delete asks first, and says the answers go too")
        page.screenshot(path=OUT / "101_delete_from_row.png")
        page.locator(".sheet [data-del]").click(); page.wait_for_timeout(600)
        check("Deleted" in page.locator("#toast").inner_text() and page.locator(".deckrow", has_text="circle").count() == 0, "the deck is gone")

        print("Search: every letter filters the list")
        page.locator("[data-tab=decks]").click(); page.wait_for_timeout(300)
        check(page.locator("#deck-search").count() == 0, "no search box with only a few decks")
        for title, did in [("Verify fx2_abswin_mix_flow", "verify-fx2_abswin_mix_flow-v1"), ("Verify cnx_adA_3d", "verify-cnx_adA_3d-v1"),
                           ("Consensus cells", "consensus-v1"), ("Divisions in the training labels", "divisions-train-v1")]:
            page.goto(base + "#/"); page.wait_for_selector(".hero")
            page.locator("#file").set_input_files(files=[{"name": f"{did}.hooman.zip", "mimeType": "application/zip", "buffer": small_deck(title, 2, did)}])
            page.locator(".sheet h3", has_text="Ready").wait_for(timeout=10000); page.keyboard.press("Escape"); page.wait_for_timeout(200)
        page.goto(base + "#/deck/consensus-v1"); page.wait_for_selector(".card canvas"); page.keyboard.press("ArrowRight"); page.wait_for_timeout(500)
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        box = page.locator("#deck-search")
        check(box.count() == 1, "with 5 decks the home screen has a search box")
        visible = lambda: page.locator("#home-list .deckitem:visible").count()
        counts = []
        for ch in "verify":
            box.press(ch); page.wait_for_timeout(60); counts.append(visible())
        check(counts == [4, 2, 2, 2, 2, 2], f"the list follows every letter typed: v, ve, ver, … ({counts})")
        divs = [d.inner_text() for d in page.locator("#home-list .list-div:visible").all()]
        check(divs == ["NEW"] or divs == ["New"], f"a heading shows only above rows still shown ({divs})")
        box.press_sequentially(" mix", delay=40); page.wait_for_timeout(100)
        rows = page.locator("#home-list .deckitem:visible")
        check(rows.count() == 1 and "abswin" in rows.inner_text() and "1 of 4" in page.locator("#search-meta").inner_text(),
              "two words, in any order of the name: “verify mix” finds fx2_abswin_mix_flow, 1 of 4")
        page.screenshot(path=OUT / "102_search.png")

        print("Search: the other tab, clearing, Enter")
        box.fill("model"); page.wait_for_timeout(100)
        meta = page.locator("#search-meta").inner_text()
        check(visible() == 0 and "Nothing here matches" in meta and "1 more in the Archive" in meta, f"no match here says so, and counts the Archive ({meta!r})")
        page.locator("#search-meta [data-tab=archive]").click(); page.wait_for_timeout(300)
        check(page.locator("#deck-search").input_value() == "model" and page.locator("#home-list .deckitem:visible", has_text="Model A").count() == 1,
              "one tap shows the Archive, still searched")
        page.locator("#search-x").click(); page.wait_for_timeout(100)
        check(page.locator("#deck-search").input_value() == "" and page.locator("#search-meta").is_hidden() and page.locator("#search-x").is_hidden(),
              "✕ clears the search")
        page.locator("[data-tab=decks]").click(); page.wait_for_timeout(300)
        page.locator("#deck-search").fill("abswin"); page.locator("#deck-search").press("Enter"); page.wait_for_timeout(600)
        check("#/deck/verify-fx2_abswin_mix_flow-v1" in page.url, "Enter opens the one deck that matches")
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        check(page.locator("#deck-search").input_value() == "abswin" and visible() == 1, "coming back, the search is still there")

        print("Search: typing goes on while the list is redrawn")
        box = page.locator("#deck-search"); box.fill(""); box.focus(); box.press_sequentially("cnx", delay=40)
        page.evaluate("import('./js/decksfolder.js').then((m) => m.stop())"); page.wait_for_timeout(400)   # a status change redraws home
        check(page.evaluate("document.activeElement && document.activeElement.id") == "deck-search" and box.input_value() == "cnx" and visible() == 1,
              "a redraw keeps the letters, the focus (the keyboard) and the filter")
        box.press_sequentially("x", delay=40); page.wait_for_timeout(100)
        check(visible() == 0, "and the next letter still filters")
        page.locator("#search-x").click(); page.wait_for_timeout(100)

        print("About this deck")
        about = ("Zebrafish fins, experiment 12 (March 2026), frames 1-40.\n\nCards: every cell where the two models disagree.\n"
                 "- **Model**: cyan outlines\n- Labels: yellow\n\nThe answers pick the training labels for v2.")
        page.locator("#file").set_input_files(files=[{"name": "about-deck.hooman.zip", "mimeType": "application/zip", "buffer": small_deck("Fins deck", 2, "about-deck", about)}])
        page.locator(".sheet h3", has_text="Ready").wait_for(timeout=10000); page.get_by_role("button", name="Open the deck").click()
        page.locator(".sheet h3", has_text="Fins deck").wait_for(timeout=10000)
        sheet = page.locator(".sheet")
        check("Zebrafish fins" in sheet.inner_text() and sheet.locator(".about li").count() == 2 and sheet.locator(".about b", has_text="Model").count() == 1
              and sheet.locator("[data-a=close]", has_text="Start").count() == 1,
              "opening a deck with an About shows it first: paragraphs, bullets, bold, and Start")
        page.screenshot(path=OUT / "103_about_first_open.png")
        sheet.locator("[data-a=close]").click(); page.wait_for_timeout(200)
        page.goto(base + "#/"); page.wait_for_selector(".hero"); page.goto(base + "#/deck/about-deck"); page.wait_for_selector(".card canvas"); page.wait_for_timeout(400)
        check(page.locator(".sheet").count() == 0, "only the first time")
        page.locator(".deckscreen .top h2").click(); page.locator(".sheet .about").wait_for()
        check("Zebrafish fins" in page.locator(".sheet").inner_text() and "None yet" in page.locator(".sheet").inner_text(), "a tap on the deck's title shows it again")
        page.locator(".sheet [data-a=edit]").click(); page.locator("#about-note").fill("Fish 3 is out of focus after frame 30.")
        page.locator(".sheet [data-a=save]").click(); page.wait_for_timeout(300)
        check(page.locator(".sheet .about.mine", has_text="Fish 3").count() == 1, "my notes go under it, saved")
        page.locator(".sheet [data-a=close]").click()
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        page.locator(".deckitem", has_text="Fins deck").locator("[data-act=rowmenu]").click(); page.wait_for_selector(".sheet .menu")
        page.locator(".sheet [data-r=about]").click(); page.locator(".sheet .about").first.wait_for()
        txt = page.locator(".sheet").inner_text()
        check("Zebrafish fins" in txt and "Fish 3 is out of focus" in txt and "2 cards" in txt, "the home screen's ⋮ shows it too, with my notes and the facts")
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        page.locator("#deck-search").fill("zebrafish"); page.wait_for_timeout(100)
        rows = page.locator("#home-list .deckitem:visible")
        check(rows.count() == 1 and "Fins deck" in rows.inner_text(), "the search finds a deck by its About")
        page.locator("#deck-search").fill("out of focus"); page.wait_for_timeout(100)
        check(page.locator("#home-list .deckitem:visible", has_text="Fins deck").count() == 1, "and by my notes")
        page.locator("#search-x").click()

        print("About: an updated deck, and a deck without one")
        page.locator("#file").set_input_files(files=[{"name": "about-deck.hooman.zip", "mimeType": "application/zip",
                                                      "buffer": small_deck("Fins deck", 3, "about-deck", about + "\n\nVersion 2: one card more.")}])
        page.locator(".sheet [data-m=update]").click(); page.locator(".sheet h3", has_text="Ready").wait_for(timeout=10000)
        page.get_by_role("button", name="Open the deck").click(); page.locator(".sheet .about").first.wait_for(timeout=10000)
        txt = page.locator(".sheet").inner_text()
        check("Version 2" in txt and "Fish 3 is out of focus" in txt, "an About that changed shows again when the deck is opened, and my notes stay")
        page.locator(".sheet [data-a=close]").click()
        page.goto(base + "#/deck/consensus-v1"); page.wait_for_selector(".card canvas"); page.wait_for_timeout(300)
        check(page.locator(".sheet").count() == 0, "a deck without an About opens straight to its cards")
        page.locator("[data-act=menu]").click(); page.locator(".sheet [data-m=about]").click(); page.locator(".sheet .about").first.wait_for()
        check("came without a description" in page.locator(".sheet").inner_text(), "its About says it came without one, and offers my notes")
        ctx.close()

        check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; screenshots in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
