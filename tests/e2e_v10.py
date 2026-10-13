"""End-to-end checks for 0.10's Archive tab: finished decks move there by themselves, the deck menu moves a deck
either way, and the home screen remembers the tab.

    python tests/e2e_v10.py           # screenshots go to tests/out/
"""
import sys

from playwright.sync_api import sync_playwright

from e2e import OUT, serve, check, failures, import_example
from e2e_v3 import phone, watch


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
        check(page.locator(".section-title .tabs").count() == 0, "no tabs while nothing is archived")

        print("A finished deck goes to the Archive")
        page.goto(base + "#/deck/example-circles"); page.wait_for_selector(".card canvas")
        for _ in range(12):
            page.keyboard.press("ArrowRight"); page.wait_for_timeout(350)
        page.goto(base + "#/"); page.wait_for_selector(".hero")
        tabs = page.locator(".section-title .tabs")
        check(tabs.count() == 1 and "My decks (1)" in tabs.inner_text() and "Archive (1)" in tabs.inner_text(), f"tabs: My decks (1) · Archive (1) ({tabs.inner_text() if tabs.count() else ''!r})")
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
        check("Back in My decks" in page.locator("#toast").inner_text() and page.locator(".deckrow", has_text="circle").count() == 1
              and page.locator(".section-title .tabs").count() == 0, "Back to my decks: a finished deck returns (and with nothing archived, no tabs)")
        page.locator(".deckrow", has_text="Model A").click(); page.wait_for_selector(".card canvas")
        page.locator("[data-act=menu]").click()
        check("Move to archive" in page.locator(".sheet [data-m=shelf]").inner_text(), "an unfinished deck offers Move to archive")
        page.locator(".sheet [data-m=shelf]").click(); page.wait_for_timeout(600)
        check(page.locator("[data-tab=archive]").get_attribute("aria-pressed") == "true" and page.locator(".deckrow", has_text="Model A").count() == 1,
              "it moves to the Archive")
        page.locator("[data-tab=decks]").click(); page.wait_for_timeout(300)
        check(page.locator(".deckrow", has_text="circle").count() == 1 and page.locator(".deckrow", has_text="Model A").count() == 0, "and My decks keeps the one brought back")
        ctx.close()

        check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; screenshots in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
