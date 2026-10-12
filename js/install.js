// "Install the app": whether this browser still needs it, and the browser's own install dialog where there is one.
//
// installed = running as the installed app (display-mode / iOS navigator.standalone), or the browser says so
// (getInstalledRelatedApps, Chrome on Android), or this device remembers it: the app was installed here
// (appinstalled), opened as the installed app (Android shares storage with the browser), or the hooman said so.
// A beforeinstallprompt means the browser can install it, so it isn't installed (any more): the memory is cleared.
import { prefs } from "./prefs.js";

let deferred = null, related = false, onChange = () => {};

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isAndroid = () => /Android/i.test(navigator.userAgent);
export const standalone = () => navigator.standalone === true ||
  ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"].some((m) => matchMedia(`(display-mode: ${m})`).matches);

// "app": we are the installed app · "prompt": one tap installs · "steps": a phone browser without a dialog (iPhone, Firefox…)
// "installed": installed, opened here from the browser · "none": a computer browser that can't install it
export function installState() {
  if (standalone()) return "app";
  if (deferred) return "prompt";
  if (related || prefs.get("installed", false)) return "installed";
  return isIOS() || isAndroid() ? "steps" : "none";
}

export function markInstalled(on = true) { prefs.set("installed", on); onChange(); }

// The browser's install dialog. Resolves "accepted", "dismissed", or null when there is none to show.
export async function promptInstall() {
  const e = deferred;
  if (!e) return null;
  deferred = null;
  e.prompt();
  const { outcome } = await e.userChoice;
  if (outcome === "accepted") prefs.set("installed", true);
  onChange();
  return outcome;
}

export function watchInstall(changed) {
  onChange = changed;
  if (standalone()) prefs.set("installed", true);
  if (navigator.getInstalledRelatedApps) {
    navigator.getInstalledRelatedApps().then((apps) => { if (apps.length) { related = true; onChange(); } }).catch(() => {});
  }
}

addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();                                  // our own button instead of the browser's mini-bar
  deferred = e; related = false; prefs.set("installed", false);
  onChange();
});
addEventListener("appinstalled", () => { deferred = null; prefs.set("installed", true); onChange("installed"); });
