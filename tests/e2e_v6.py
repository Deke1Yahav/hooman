"""End-to-end checks for 0.4.2's install button: shown only while the app isn't installed on this device.

    python tests/e2e_v6.py            # screenshots go to tests/out/

Covers Android with and without the browser's install dialog (beforeinstallprompt, accepted / dismissed),
"I've installed it", appinstalled, the memory across reloads and from the installed app to the browser,
getInstalledRelatedApps, iPhone Safari and the iPhone Home Screen app, and computers.
"""
import sys

from playwright.sync_api import sync_playwright

from e2e import OUT, serve, check, failures
from e2e_v3 import phone, watch

ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

# A stand-in for the browser's install dialog: Chrome fires this when the app can be installed.
OFFER = """(outcome) => { const e = new Event('beforeinstallprompt', { cancelable: true });
  e.prompt = () => { window.__prompted = (window.__prompted || 0) + 1; };
  e.userChoice = Promise.resolve({ outcome, platform: 'web' }); dispatchEvent(e); }"""
STANDALONE = """(() => { const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => /display-mode:\\s*standalone/.test(q) ? { matches: true, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } } : mm(q); })()"""
IOS_HOME = "Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true });"
RELATED = "Object.defineProperty(Navigator.prototype, 'getInstalledRelatedApps', { value: () => Promise.resolve([{ platform: 'webapp' }]) });"


def banner(page):
    page.wait_for_timeout(250)
    b = page.locator("#install-slot .banner")
    return (b.inner_text(), page.locator("#install-slot [data-act=install]").inner_text()) if b.count() else None


def stored(page):
    return page.evaluate("localStorage.getItem('hooman:installed')")


def settings_has_install(page):
    page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet h3")
    has = page.locator(".sheet [data-b=install]").count() == 1
    page.keyboard.press("Escape"); page.wait_for_timeout(250)
    return has


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()

        print("Android browser, no install dialog yet")
        ctx = phone(browser, user_agent=ANDROID); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        b = banner(page)
        check(b is not None and "Install Hooman on this phone" in b[0] and b[1] == "Show me", f"the install banner shows, with steps ({b})")
        page.screenshot(path=OUT / "60_install_banner_android.png")
        page.locator("#install-slot [data-act=install]").click(); page.wait_for_selector(".sheet h3")
        sheet = page.locator(".sheet").inner_text()
        check("Install the app" in sheet and "Install app" in sheet and "Samsung Internet" in sheet and "come with it" in sheet,
              "the steps: browser menu, Install app, decks come along")
        page.screenshot(path=OUT / "61_install_steps_android.png")
        page.get_by_role("button", name="I've installed it").click(); page.wait_for_timeout(300)
        check(banner(page) is None and stored(page) == "true", "\"I've installed it\" hides the banner and is remembered")
        page.reload(); page.wait_for_selector(".hero")
        check(banner(page) is None, "after a reload the banner stays hidden")
        check(settings_has_install(page), "settings still offers \"Install the app\" (in case it was a mistake)")

        print("Android: the browser offers to install (the app was removed)")
        page.evaluate(OFFER, "accepted")
        b = banner(page)
        check(b is not None and b[1] == "Install" and stored(page) == "false", f"the browser's offer brings the banner back, one-tap ({b})")
        page.locator("#install-slot [data-act=install]").click(); page.wait_for_timeout(300)
        check(page.evaluate("window.__prompted") == 1, "Install opens the browser's own install dialog")
        page.evaluate("dispatchEvent(new Event('appinstalled'))"); page.wait_for_timeout(300)
        check(banner(page) is None and stored(page) == "true", "once installed, the banner goes and the device remembers")
        check("Installed" in page.locator("#toast").inner_text(), "a toast says where to find it")
        ctx.close()

        print("Android: the install dialog is dismissed")
        ctx = phone(browser, user_agent=ANDROID); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        page.evaluate(OFFER, "dismissed")
        page.locator("#install-slot [data-act=install]").click(); page.wait_for_timeout(300)
        b = banner(page)
        check("Not now" in page.locator("#toast").inner_text() and b is not None and b[1] == "Show me",
              f"after \"not now\" the banner stays, now with the steps ({b})")
        ctx.close()

        print("Android: opened as the installed app, then in the browser")
        ctx = phone(browser, user_agent=ANDROID)
        app = ctx.new_page(); watch(app, errors); app.add_init_script(STANDALONE)
        app.goto(base); app.wait_for_selector(".hero")
        check(banner(app) is None and not settings_has_install(app), "the installed app shows no install button anywhere")
        tab = ctx.new_page(); watch(tab, errors)
        tab.goto(base); tab.wait_for_selector(".hero")
        check(banner(tab) is None, "the browser tab knows the app was installed (same storage on Android)")
        ctx.close()

        print("Android: the browser says the app is installed")
        ctx = phone(browser, user_agent=ANDROID); ctx.add_init_script(RELATED); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        check(banner(page) is None, "getInstalledRelatedApps hides the banner")
        ctx.close()

        print("iPhone Safari")
        ctx = phone(browser, user_agent=IPHONE); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        b = banner(page)
        check(b is not None and "Home Screen" in b[0] and "7 days" in b[0] and b[1] == "Show me", f"Safari: add to Home Screen, and why ({b})")
        page.screenshot(path=OUT / "62_install_banner_iphone.png")
        page.locator("#install-slot [data-act=install]").click(); page.wait_for_selector(".sheet h3")
        sheet = page.locator(".sheet").inner_text()
        check("Add to Home Screen" in sheet and "Share" in sheet and "Back up" in sheet, "the steps: Share, Add to Home Screen, back up first")
        page.screenshot(path=OUT / "63_install_steps_iphone.png")
        page.get_by_role("button", name="Close").click(); page.wait_for_timeout(300)
        check(banner(page) is not None, "Close keeps the banner")
        ctx.close()

        print("iPhone Home Screen app")
        ctx = phone(browser, user_agent=IPHONE); ctx.add_init_script(IOS_HOME); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        check(banner(page) is None and not settings_has_install(page) and stored(page) == "true", "the Home Screen app shows no install button")
        ctx.close()

        print("Computer")
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, service_workers="block"); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        check(banner(page) is None and not settings_has_install(page), "a computer browser that can't install shows nothing")
        page.evaluate(OFFER, "accepted")
        b = banner(page)
        check(b is not None and "on this computer" in b[0] and b[1] == "Install", f"a computer browser that can install offers it ({b})")
        ctx.close()

        print("Layout")
        for w, h in [(360, 640), (390, 844)]:
            ctx = browser.new_context(viewport={"width": w, "height": h}, is_mobile=True, has_touch=True, user_agent=ANDROID, service_workers="block")
            page = ctx.new_page(); watch(page, errors); page.goto(base); page.wait_for_selector(".hero")
            fits = page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            r = page.locator("#install-slot .banner").bounding_box()
            check(fits and r and r["x"] >= 0 and r["x"] + r["width"] <= w, f"{w}x{h}: the banner fits, no sideways scroll")
            page.screenshot(path=OUT / f"64_install_{w}x{h}.png")
            ctx.close()

        check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; screenshots in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
