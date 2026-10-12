// Google Drive: sign in (Google Identity Services), pick files or a folder (Google Picker),
// download, upload (resumable, any size), and share a file as "anyone with the link".
// Google's scripts load only when a Drive feature is used, so the app stays offline-first.

import { GOOGLE, googleReady } from "./config.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com/drive/v3", UP = "https://www.googleapis.com/upload/drive/v3";
let token = null, tokenExp = 0, gisP = null, pickerP = null;
// Google's browser sign-in lasts about an hour. It is kept for that hour (drive.file scope only), so reopening
// the app doesn't ask again; after it, live save pauses until a tap (see livesave.js).
try { const s = JSON.parse(localStorage.getItem("hooman:gtoken") || "null"); if (s && s.exp > Date.now()) { token = s.t; tokenExp = s.exp; } } catch {}
const httpError = (what, status) => Object.assign(new Error(`${what} (HTTP ${status})`), { status });

export { googleReady };

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.async = true; s.onload = res;
    s.onerror = () => rej(new Error("could not reach Google (offline?)"));
    document.head.appendChild(s);
  });
}
const loadGIS = () => gisP || (gisP = loadScript("https://accounts.google.com/gsi/client").catch((e) => { gisP = null; throw e; }));
const loadPicker = () => pickerP || (pickerP = loadScript("https://apis.google.com/js/api.js")
  .then(() => new Promise((res) => window.gapi.load("picker", res))).catch((e) => { pickerP = null; throw e; }));

// Load Google's scripts ahead of the tap, so the sign-in popup opens inside the tap (popup blockers).
export function warmUp() { if (googleReady()) { loadGIS().catch(() => {}); loadPicker().catch(() => {}); } }

export const signedIn = (margin = 60000) => !!token && Date.now() < tokenExp - margin;
export function forget() { token = null; tokenExp = 0; try { localStorage.removeItem("hooman:gtoken"); } catch {} }

export async function getToken() {
  if (signedIn()) return token;
  await loadGIS();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE.clientId, scope: SCOPE,
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        token = r.access_token; tokenExp = Date.now() + (r.expires_in || 3600) * 1000;
        try { localStorage.setItem("hooman:gtoken", JSON.stringify({ t: token, exp: tokenExp })); } catch {}
        resolve(token);
      },
      error_callback: (e) => reject(new Error((e && e.type === "popup_closed") ? "Google sign-in was closed" : (e && e.message) || "Google sign-in failed")),
    });
    client.requestAccessToken();
  });
}

// kind: "files" (decks, backups, answers) | "folder". Resolves [{id, name, mimeType}] ([] when cancelled).
export async function pick({ kind = "files", multi = false, parent = null, title = "" } = {}) {
  const tok = await getToken();
  await loadPicker();
  const P = window.google.picker;
  return new Promise((resolve) => {
    let view;
    if (kind === "folder") view = new P.DocsView(P.ViewId.FOLDERS).setSelectFolderEnabled(true).setIncludeFolders(true).setMimeTypes("application/vnd.google-apps.folder");
    else {
      view = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setMimeTypes("application/zip,application/x-zip-compressed,application/json,application/octet-stream");
      if (parent) view.setParent(parent);
    }
    const b = new P.PickerBuilder().addView(view).setOAuthToken(tok).setDeveloperKey(GOOGLE.apiKey).setAppId(GOOGLE.appId)
      .setCallback((d) => {
        if (d.action === P.Action.PICKED) resolve(d.docs.map((x) => ({ id: x.id, name: x.name, mimeType: x.mimeType })));
        else if (d.action === P.Action.CANCEL) resolve([]);
      });
    if (multi) b.enableFeature(P.Feature.MULTISELECT_ENABLED);
    if (title) b.setTitle(title);
    b.build().setVisible(true);
  });
}

export async function download(id, name) {
  const tok = await getToken();
  const r = await fetch(`${API}/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw httpError("Drive download failed", r.status);
  return new File([await r.blob()], name || "drive.zip", { type: r.headers.get("content-type") || "application/zip" });
}

// Files shared as "anyone with the link": no sign-in needed, the API key is enough.
export async function downloadPublic(id) {
  const meta = await fetch(`${API}/files/${id}?fields=name&key=${GOOGLE.apiKey}`);
  if (!meta.ok) throw new Error(meta.status === 404 || meta.status === 403
    ? "that Google Drive file isn't shared as \"anyone with the link\" (or it no longer exists). Ask for a shared link, or download the file and import it"
    : `Google Drive answered HTTP ${meta.status}`);
  const { name } = await meta.json();
  const r = await fetch(`${API}/files/${id}?alt=media&key=${GOOGLE.apiKey}`);
  if (!r.ok) throw new Error(`Google Drive download failed (HTTP ${r.status})`);
  return new File([await r.blob()], name || "deck.zip", { type: "application/zip" });
}

// Create a file (in folderId) or replace the content of fileId. Resumable, so big decks work too.
export async function upload(blob, name, { folderId = null, fileId = null } = {}) {
  const tok = await getToken();
  const meta = fileId ? { name } : { name, ...(folderId ? { parents: [folderId] } : {}) };
  const start = await fetch(`${UP}/files${fileId ? `/${fileId}` : ""}?uploadType=resumable&fields=id,name,version,modifiedTime`, {
    method: fileId ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": blob.type || "application/zip" },
    body: JSON.stringify(meta),
  });
  if (start.status === 404 && fileId) return upload(blob, name, { folderId });      // deleted on Drive meanwhile
  const where = start.headers.get("location");
  if (!start.ok || !where) throw httpError("Google Drive upload failed", start.status);
  const put = await fetch(where, { method: "PUT", body: blob });
  if (!put.ok) throw httpError("Google Drive upload failed", put.status);
  return put.json();
}

// A file's version (it goes up with every change) and name; null when it was deleted or is in the bin.
export async function meta(id) {
  const tok = await getToken();
  const r = await fetch(`${API}/files/${id}?fields=id,name,version,modifiedTime,trashed`, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw httpError("Google Drive answered", r.status);
  const m = await r.json();
  return m.trashed ? null : m;
}

export async function createFolder(name) {
  const tok = await getToken();
  const r = await fetch(`${API}/files?fields=id,name`, {
    method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!r.ok) throw httpError("could not make a folder on Google Drive", r.status);
  return r.json();
}

export async function makePublic(id) {
  const tok = await getToken();
  const r = await fetch(`${API}/files/${id}/permissions`, {
    method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!r.ok) throw new Error(`could not share the file on Drive (HTTP ${r.status})`);
  return `https://drive.google.com/file/d/${id}/view?usp=sharing`;
}
