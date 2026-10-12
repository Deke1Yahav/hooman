"""End-to-end checks for 0.4.2-0.4.4: the install button (shown only while the app isn't installed on this device)
and the Drive guide (any drive app through the phone's picker and share menu; built-in Google Drive when set up).

    python tests/e2e_v6.py            # screenshots go to tests/out/

Covers Android with and without the browser's install dialog (beforeinstallprompt, accepted / dismissed),
"I've installed it", appinstalled, the memory across reloads and from the installed app to the browser,
getInstalledRelatedApps, iPhone Safari and the iPhone Home Screen app, and computers.
"""
import sys

from playwright.sync_api import sync_playwright

from e2e import OUT, serve, check, failures, import_example
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


def foot_link(page):
    return page.locator(".foot-note [data-act=install]").count() == 1


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
        check(foot_link(page), "the footer has an \"Install the app\" link")
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
        check(foot_link(page), "so does the footer, next to the deck format")
        page.locator(".foot-note [data-act=install]").click(); page.wait_for_selector(".sheet h3")
        check("Install the app" in page.locator(".sheet h3").inner_text(), "the footer link opens the steps")
        page.keyboard.press("Escape"); page.wait_for_timeout(250)

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
        check(banner(app) is None and not settings_has_install(app) and not foot_link(app), "the installed app shows no install button anywhere")
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
        check(banner(page) is None and not settings_has_install(page) and not foot_link(page) and stored(page) == "true", "the Home Screen app shows no install button")
        ctx.close()

        print("Computer")
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, service_workers="block"); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        check(banner(page) is None and not settings_has_install(page) and not foot_link(page), "a computer browser that can't install shows nothing")
        page.evaluate(OFFER, "accepted")
        b = banner(page)
        check(b is not None and "on this computer" in b[0] and b[1] == "Install", f"a computer browser that can install offers it ({b})")
        ctx.close()

        print("Drive guide")
        ctx = phone(browser, user_agent=ANDROID); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        page.locator(".foot-note [data-guide]").click(); page.wait_for_selector(".sheet h3")
        g = page.locator(".sheet").inner_text().lower()          # section titles are upper-case in CSS
        check("open a deck from a drive" in g and "save answers or a backup" in g and "work as a team" in g and "☰" in g and "save to drive" in g,
              "the footer's Drive guide: open from a drive, save to a drive, work as a team (Android words)")
        check("built in" not in g and "from a link" in g, "without Google ids: no built-in section, and Drive share links are explained")
        page.wait_for_timeout(700); page.screenshot(path=OUT / "65_drive_guide.png")
        page.get_by_role("button", name="Got it").click(); page.wait_for_timeout(300)
        check(page.locator(".sheet").count() == 0, "Got it closes the guide")
        page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet h3")
        page.locator(".sheet [data-guide]").click(); page.wait_for_timeout(300)
        check("Google Drive, OneDrive, Dropbox" in page.locator(".sheet h3").inner_text(), "settings opens the Drive guide")
        page.keyboard.press("Escape"); page.wait_for_timeout(250)
        import_example(page, "Is it a circle?")
        page.locator("[data-act=menu]").click(); page.locator(".sheet [data-m=share]").click(); page.wait_for_selector(".sheet h3:has-text('Share this deck')")
        sh = page.locator(".sheet").inner_text()
        check("config.js" not in sh and page.locator(".sheet [data-guide]").count() == 1, "the share sheet speaks to users (no config.js) and links the guide")
        page.locator(".sheet [data-guide]").click(); page.wait_for_timeout(300)
        check("open a deck from a drive" in page.locator(".sheet").inner_text().lower(), "the share sheet's link opens the guide")
        ctx.close()

        ctx = phone(browser, user_agent=IPHONE); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        page.locator(".foot-note [data-guide]").click(); page.wait_for_selector(".sheet h3")
        g = page.locator(".sheet").inner_text()
        check("Browse" in g and "iCloud Drive" in g and "Save to Files" in g, "on iPhone the guide uses iPhone words (Browse, iCloud Drive, Save to Files)")
        ctx.close()

        ctx = phone(browser, user_agent=ANDROID)
        ctx.route("**/js/config.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=(
            'export const GOOGLE = { clientId: "123-test.apps.googleusercontent.com", apiKey: "test-key", appId: "123" }; '
            'export const googleReady = () => true;')))
        ctx.route("https://accounts.google.com/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
        ctx.route("https://apis.google.com/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
        page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        page.locator(".foot-note [data-guide]").click(); page.wait_for_selector(".sheet h3")
        g = page.locator(".sheet").inner_text().lower()
        check("built in: google drive" in g and "open from google drive" in g and "team folder" in g and "any drive app" in g,
              "with Google ids: the built-in Drive features come first, then any drive app")
        page.wait_for_timeout(700); page.screenshot(path=OUT / "66_drive_guide_google.png")
        ctx.close()

        print("Video guide")
        ctx = phone(browser, user_agent=ANDROID); page = ctx.new_page(); watch(page, errors)
        page.goto(base); page.wait_for_selector(".hero")
        check(page.locator(".empty [data-videos]").count() == 1, "an empty home screen points newcomers to the video guide")
        page.locator(".foot-note [data-videos]").click(); page.wait_for_selector(".sheet h3")
        link = page.locator(".sheet a.video-link").first
        check(page.locator(".sheet h3").inner_text().endswith("Video guide") and link.get_attribute("href") == "https://youtu.be/PI-3ms1sx_E"
              and link.get_attribute("target") == "_blank" and "Part 1" in link.inner_text(), "the footer's Video guide lists Part 1 on YouTube, opening outside the app")
        check([page.locator(".sheet a.video-link").nth(i).get_attribute("href") for i in (1, 2)] == ["https://youtu.be/9HHWi0D_Dms", "https://youtu.be/Bi8DEyOR9Fc"]
              and "Coming next" not in page.locator(".sheet").inner_text(), "and Parts 2 and 3, with nothing left 'coming next'")
        page.wait_for_timeout(500); page.screenshot(path=OUT / "68_video_guide.png")
        page.get_by_role("button", name="Close").click(); page.wait_for_timeout(300)
        page.locator("[data-act=settings]").click(); page.wait_for_selector(".sheet h3")
        page.locator(".sheet [data-videos]").click(); page.wait_for_timeout(300)
        check("Video guide" in page.locator(".sheet h3").inner_text(), "Settings opens the video guide too")
        ctx.close()

        print("Layout")
        for w, h in [(360, 640), (390, 844)]:
            ctx = browser.new_context(viewport={"width": w, "height": h}, is_mobile=True, has_touch=True, user_agent=ANDROID, service_workers="block")
            page = ctx.new_page(); watch(page, errors); page.goto(base); page.wait_for_selector(".hero")
            fits = page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            r = page.locator("#install-slot .banner").bounding_box()
            check(fits and r and r["x"] >= 0 and r["x"] + r["width"] <= w, f"{w}x{h}: the banner fits, no sideways scroll")
            lines = page.evaluate("(() => { const f = document.querySelector('.foot-note'); return Math.round(f.getBoundingClientRect().height / parseFloat(getComputedStyle(f).lineHeight)); })()")
            check(lines <= 4, f"{w}x{h}: the footer stays on 4 short lines ({lines})")
            page.screenshot(path=OUT / f"64_install_{w}x{h}.png", full_page=True)
            ctx.close()

        check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
        browser.close()
    srv.shutdown()
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}; screenshots in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
