// deck.json -> normalized deck + exact, LLM-pasteable errors and warnings. Spec: ../llms.txt

export const FORMAT = 1;
export const DIRS = ["right", "left", "up", "down"];
export const SOURCE_COLORS = ["#ff5d6c", "#3ddc97", "#4fc3f7", "#f2c14e", "#b48cff", "#ff8fab"];
const SLOT_COLORS = { right: "#3ddc97", left: "#ff5d6c", up: "#f2c14e", down: "#b48cff" };
const BUTTON_COLORS = ["#4fc3f7", "#ff8fab", "#c6ff3d", "#ffa94d", "#b9e3ff", "#e599f7"];
export const DEFAULT_ANSWERS = { right: "Yes", left: "No", up: "Unsure" };

const TOP = ["hooman", "id", "title", "question", "help", "about", "answers", "buttons", "sources", "classes", "shuffle", "cards", "mode", "frames_are", "channels", "channel_view"];
const CARD = ["id", "image", "frames", "question", "info", "focus", "overlays", "start", "channels"];
export const THEN = ["draw", "point", "points", "number", "text"];
const OVERLAY = ["box", "point", "polygon", "mask", "source", "label", "value", "style", "frame"];
const HINTS = {
  answer: "answers", images: "cards", items: "cards", card: "cards", files: "cards", version: "hooman",
  path: "image", file: "image", img: "image", src: "image", url: "image", overlay: "overlays", annotations: "overlays",
  bbox: "box", rect: "box", poly: "polygon", points: "polygon", segmentation: "polygon", center: "point", xy: "point",
  color: "sources", colour: "sources", name: "id", title: "info", text: "info", caption: "info",
};

export const slug = (s) => String(s).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "") || "answer";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isStr = (x) => typeof x === "string" && x.trim().length > 0;
const q = (s) => JSON.stringify(s);
const isURL = (p) => /^https?:\/\//i.test(p);

function unknownKeys(obj, known, where, warn) {
  for (const k of Object.keys(obj)) {
    if (known.includes(k)) continue;
    const hint = HINTS[k] && known.includes(HINTS[k]) ? ` (did you mean ${q(HINTS[k])}?)` : "";
    warn(`${where}: unknown field ${q(k)} is ignored${hint}`);
  }
}

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// files: {has(path) -> bool, list() -> string[]} relative to deck.json; fileName: the zip/json name (default id).
export function normalizeDeck(raw, files, fileName = "deck") {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  const paths = new Set();
  let suggestBudget = 20;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    err("deck.json: must be a JSON object like {\"hooman\": 1, \"question\": \"...\", \"cards\": [...]}");
    return { deck: null, errors, warnings, paths };
  }
  if (raw.hooman === undefined) err("deck.json: add \"hooman\": 1 (the format version) at the top");
  else if (raw.hooman !== FORMAT) err(`deck.json: "hooman" is ${q(raw.hooman)}, but this app reads format ${FORMAT}${raw.hooman > FORMAT ? "; update the app" : ""}`);
  unknownKeys(raw, TOP, "deck.json", warn);

  let id = raw.id;
  if (id !== undefined && !(typeof id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(id))) {
    err(`deck.json: "id" ${q(id)} may only use letters, digits, ".", "_" and "-" (1-64 characters)`);
    id = undefined;
  }
  if (id === undefined) {
    const base = String(raw.title || fileName.replace(/(\.hooman)?\.(zip|json)$/i, "")).normalize("NFKD");
    id = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "deck";
  }
  for (const k of ["title", "question", "help", "about"]) if (raw[k] !== undefined && typeof raw[k] !== "string") err(`deck.json: "${k}" must be text`);
  const title = isStr(raw.title) ? raw.title.trim() : id;
  let question = isStr(raw.question) ? raw.question.trim() : null;
  if (raw.mode !== undefined && !["swipe", "annotate", "follow"].includes(raw.mode)) err(`deck.json: "mode" must be "swipe", "annotate" or "follow"`);
  const mode = raw.mode === "follow" ? "follow" : raw.mode === "annotate" ? "annotate" : question ? "swipe" : "annotate";
  if (mode === "swipe" && !question) err('deck.json: "mode": "swipe" needs a "question"');
  if (mode === "annotate") question = null;
  if (raw.frames_are !== undefined && !["channels", "time"].includes(raw.frames_are)) err('deck.json: "frames_are" must be "channels" or "time"');
  const framesAre = raw.frames_are === "time" || (raw.frames_are === undefined && mode === "follow") ? "time" : "channels";
  // channels: several pictures per time frame (nuclei + cell body...). "image" stays channel 1.
  let channels = null;
  if (raw.channels !== undefined) {
    if (!Array.isArray(raw.channels) || raw.channels.length < 1 || raw.channels.length > 8) err('deck.json: "channels" must be a list of 1 to 8 channels, like [{"name": "nuclei", "color": "#3ddc97"}, {"name": "body", "color": "#ffffff"}]');
    else {
      channels = raw.channels.map((c, k) => {
        if (isStr(c)) return { name: c.trim() };
        if (!c || typeof c !== "object" || !isStr(c.name)) { err(`channels[${k}]: needs a "name", like {"name": "nuclei", "color": "#3ddc97"}`); return { name: `channel ${k + 1}` }; }
        unknownKeys(c, ["name", "color"], `channels[${k}]`, warn);
        return { name: c.name.trim(), ...(isStr(c.color) ? { color: c.color.trim() } : {}) };
      });
      if (new Set(channels.map((c) => c.name)).size !== channels.length) err("deck.json: the channel names must all be different");
    }
  }
  const C = channels ? channels.length : 1;
  const later = () => channels.slice(1).map((c) => q(c.name)).join(", ");
  let channelView = 0;
  if (raw.channel_view !== undefined) {
    const v = raw.channel_view, idx = channels ? channels.findIndex((c) => c.name === v) : -1;
    if ((v === "mix" || v === "side") && channels) channelView = v;
    else if (idx >= 0) channelView = idx;
    else err(`deck.json: "channel_view" must be "mix", "side" or one channel's name${channels ? ` (${channels.map((c) => q(c.name)).join(", ")})` : `, and it needs "channels"`}`);
  }
  // A frame's other channels (after "image"), checked against the deck's "channels".
  const extraChannels = (list, where) => {
    if (list === undefined) {
      if (C > 1) err(`${where}: the deck has ${C} "channels", so this needs "channels": [${C - 1} more image path${C > 2 ? "s" : ""}] for ${later()}, after "image"`);
      return [];
    }
    if (C === 1) { err(`${where}: has "channels" but the deck doesn't list its channels; add "channels": [{"name": ...}, {"name": ...}] at the top of deck.json`); return []; }
    if (!Array.isArray(list)) { err(`${where}: "channels" must be a list of image paths, one for each of ${later()}`); return []; }
    if (list.length !== C - 1) err(`${where}: has ${list.length} extra channel image${list.length === 1 ? "" : "s"}, but the deck has ${C} "channels", so it needs ${C - 1} (${later()}) after "image"`);
    return list.map((p, k) => checkPath(p, `${where} channels[${k}]`) || String(p));
  };
  if (raw.shuffle !== undefined && typeof raw.shuffle !== "boolean") err("deck.json: \"shuffle\" must be true or false");

  // sources first: answer colours can come from them
  const sources = [], srcIndex = new Map();
  const addSource = (name, label, color) => {
    if (srcIndex.has(name)) return srcIndex.get(name);
    const s = { name, label: label || name, color: color || SOURCE_COLORS[sources.length % SOURCE_COLORS.length] };
    srcIndex.set(name, s); sources.push(s); return s;
  };
  if (raw.sources !== undefined) {
    if (!raw.sources || typeof raw.sources !== "object" || Array.isArray(raw.sources)) err("deck.json: \"sources\" must be an object like {\"A\": {\"color\": \"#ff5d6c\"}}");
    else for (const [name, v] of Object.entries(raw.sources)) {
      const o = v && typeof v === "object" ? v : {};
      if (v !== null && typeof v !== "object") err(`sources.${name}: must be an object like {"label": "Model A", "color": "#ff5d6c"}`);
      if (o.guide !== undefined && typeof o.guide !== "boolean") err(`sources.${name}: "guide" must be true or false`);
      const s = addSource(name, isStr(o.label) ? o.label : name, isStr(o.color) ? o.color : null);
      if (o.guide === true) { s.guide = true; if (!isStr(o.color)) s.color = "#ffffff"; }
    }
  }

  // answers
  const answers = [];
  const parseAnswer = (v, slot, where, i) => {
    let o;
    if (isStr(v)) o = { label: v.trim() };
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      unknownKeys(v, ["label", "value", "then", "color", "celebrate"], where, warn);
      if (!isStr(v.label)) { err(`${where}: needs a "label", for example {"label": "Yes", "value": "yes"}`); return null; }
      o = { label: v.label.trim() };
      if (v.value !== undefined) { if (isStr(v.value)) o.value = v.value.trim(); else err(`${where}: "value" must be text`); }
      if (v.then !== undefined) { if (THEN.includes(v.then)) o.then = v.then; else err(`${where}: "then" must be one of ${THEN.map(q).join(", ")}`); }
      if (v.color !== undefined) { if (isStr(v.color)) o.color = v.color; else err(`${where}: "color" must be a CSS colour like "#3ddc97"`); }
      if (v.celebrate !== undefined) { if (typeof v.celebrate === "boolean") { if (v.celebrate) o.celebrate = true; } else err(`${where}: "celebrate" must be true or false`); }
    } else { err(`${where}: must be a label string or {"label": ..., "value": ...}`); return null; }
    o.value = o.value || slug(o.label);
    o.slot = slot;
    o.color = o.color || (srcIndex.has(o.value) && !srcIndex.get(o.value).guide ? srcIndex.get(o.value).color : slot === "button" ? BUTTON_COLORS[i % BUTTON_COLORS.length] : SLOT_COLORS[slot]);
    return o;
  };
  const rawAnswers = raw.answers === undefined ? DEFAULT_ANSWERS : raw.answers;
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) err("deck.json: \"answers\" must be an object like {\"right\": \"Yes\", \"left\": \"No\"}");
  else {
    for (const k of Object.keys(rawAnswers)) if (!DIRS.includes(k)) err(`answers: ${q(k)} is not a direction; use "right", "left", "up" or "down" (extra answers go in "buttons")`);
    for (const dir of DIRS) {
      if (rawAnswers[dir] === undefined || rawAnswers[dir] === null) continue;
      const a = parseAnswer(rawAnswers[dir], dir, `answers.${dir}`, 0);
      if (a) answers.push(a);
    }
  }
  if (raw.buttons !== undefined) {
    if (!Array.isArray(raw.buttons)) err("deck.json: \"buttons\" must be a list, like [\"Blurry\", {\"label\": \"Dead\", \"value\": \"dead\"}]");
    else {
      if (raw.buttons.length > 6) err(`deck.json: "buttons" has ${raw.buttons.length} items; at most 6 fit on a phone`);
      raw.buttons.slice(0, 6).forEach((b, i) => { const a = parseAnswer(b, "button", `buttons[${i}]`, i); if (a) answers.push(a); });
    }
  }
  if (mode === "swipe" && answers.length === 0 && errors.length === 0) err("deck.json: the deck has a question but no answers; add \"answers\" or leave it out to get Yes/No/Unsure");
  if (mode !== "swipe" && raw.answers !== undefined) warn(`deck.json: this is ${mode === "follow" ? "a follow deck (the hooman taps the cell in every frame)" : "an annotate deck (every card opens the mask editor)"}, so "answers" are not used`);

  // classes (mask editor)
  const classes = [];
  if (raw.classes !== undefined) {
    if (!Array.isArray(raw.classes)) err("deck.json: \"classes\" must be a list, like [\"leaf\", {\"value\": \"pot\", \"color\": \"#f2c14e\"}]");
    else raw.classes.forEach((c, i) => {
      if (isStr(c)) classes.push({ value: c.trim(), label: c.trim() });
      else if (c && typeof c === "object" && isStr(c.value)) classes.push({ value: c.value.trim(), label: isStr(c.label) ? c.label.trim() : c.value.trim(), color: isStr(c.color) ? c.color : undefined });
      else err(`classes[${i}]: must be a name string or {"value": ..., "label": ..., "color": ...}`);
    });
  }
  classes.forEach((c, i) => { c.color = c.color || BUTTON_COLORS[i % BUTTON_COLORS.length]; });

  // paths
  const allFiles = () => files.list();
  const checkPath = (p, where) => {
    if (!isStr(p)) { err(`${where}: must be a file path like "img/001.jpg"`); return null; }
    let path = p.trim();
    if (isURL(path)) { paths.add(path); return path; }
    if (path.includes("\\")) { warn(`${where}: ${q(p)} uses "\\"; paths use "/"`); path = path.replace(/\\/g, "/"); }
    path = path.replace(/^(\.\/)+/, "");
    if (path.startsWith("/")) { warn(`${where}: ${q(p)} starts with "/"; paths are relative to deck.json`); path = path.replace(/^\/+/, ""); }
    if (/\.tiff?$/i.test(path)) { err(`${where}: ${q(p)} is a TIFF; phones can't show TIFF. Convert it to PNG (llms.txt recipe 7.4)`); return null; }
    if (!files.has(path)) {
      let hint = "";
      if (suggestBudget-- > 0) {
        const list = allFiles(), low = path.toLowerCase(), base = path.split("/").pop();
        const near = list.find((f) => f.toLowerCase() === low) || list.find((f) => f.split("/").pop() === base)
          || list.find((f) => lev(f, path) <= 2);
        if (near) hint = ` (did you mean ${q(near)}?)`;
        else if (list.length === 0) hint = " (the zip has no other files)";
      }
      err(`${where}: ${q(path)} is not in the ${files.kind || "zip"}${hint}`);
      return null;
    }
    paths.add(path);
    return path;
  };

  // cards
  const cards = [], seen = new Map();
  if (!Array.isArray(raw.cards)) err("deck.json: \"cards\" must be a list of image paths or card objects");
  else if (raw.cards.length === 0) err("deck.json: \"cards\" is empty");
  else raw.cards.forEach((c, i) => {
    const at = (extra = "") => `cards[${i}]${extra}`;
    let card;
    if (typeof c === "string") {
      const path = checkPath(c, at());
      if (C > 1) err(`${at()}: a plain image path can't hold the deck's ${C} channels; write {"image": ${q(c)}, "channels": [...]} instead`);
      card = { id: c.trim(), frames: [{ path: path || c, name: "", channels: [path || c] }], overlays: [] };
    } else if (c && typeof c === "object" && !Array.isArray(c)) {
      const where = at(c.id !== undefined ? ` (id ${q(c.id)})` : "");
      unknownKeys(c, CARD, where, warn);
      let frames = [];
      if (c.image !== undefined && c.frames !== undefined) err(`${where}: use either "image" or "frames", not both`);
      if (c.frames !== undefined && c.channels !== undefined) err(`${where}: with "frames", put "channels" inside each frame, not on the card`);
      if (c.image !== undefined) { const p0 = checkPath(c.image, `${where} image`) || String(c.image); frames = [{ path: p0, name: "", channels: [p0, ...extraChannels(c.channels, where)] }]; }
      else if (c.frames !== undefined) {
        if (!Array.isArray(c.frames) || c.frames.length === 0) err(`${where}: "frames" must be a non-empty list`);
        else frames = c.frames.map((f, j) => {
          const fp = typeof f === "object" && f ? f.image : f;
          const name = typeof f === "object" && f && isStr(f.name) ? f.name.trim() : String(j + 1);
          const p0 = checkPath(fp, `${where} frames[${j}]`) || String(fp);
          return { path: p0, name, channels: [p0, ...extraChannels(typeof f === "object" && f ? f.channels : undefined, `${where} frames[${j}]`)] };
        });
      } else err(`${where}: needs "image": "path/to/image.jpg" (or "frames": [...])`);
      const cid = c.id !== undefined ? c.id : frames[0] ? frames[0].path : `card${i}`;
      if (!(typeof cid === "string" && cid.length > 0) && typeof cid !== "number") err(`${where}: "id" must be text`);
      card = { id: String(cid), frames, overlays: [] };
      for (const k of ["question", "info"]) if (c[k] !== undefined) { if (typeof c[k] === "string") card[k] = c[k]; else err(`${where}: "${k}" must be text`); }
      if (c.start !== undefined) {
        if (Array.isArray(c.start) && (c.start.length === 2 || c.start.length === 3) && c.start.every(isNum) && (c.start.length === 2 || (Number.isInteger(c.start[2]) && c.start[2] >= 0 && c.start[2] < frames.length))) card.start = c.start;
        else err(`${where}: "start" must be [x, y] or [x, y, frame] (the cell to follow)`);
      }
      if (c.focus !== undefined) {
        if (Array.isArray(c.focus) && c.focus.length === 4 && c.focus.every(isNum) && c.focus[2] > 0 && c.focus[3] > 0) card.focus = c.focus;
        else err(`${where}: "focus" must be [x, y, w, h] in pixels with w and h above 0`);
      }
      if (c.overlays !== undefined) {
        if (!Array.isArray(c.overlays)) err(`${where}: "overlays" must be a list`);
        else c.overlays.forEach((o, j) => {
          const ow = `${where} overlays[${j}]`;
          if (!o || typeof o !== "object" || Array.isArray(o)) { err(`${ow}: must be an object like {"box": [x, y, w, h]}`); return; }
          const shapes = ["box", "point", "polygon", "mask"].filter((k) => o[k] !== undefined);
          if (shapes.length !== 1) {
            const alt = Object.keys(o).find((k) => HINTS[k] && ["box", "point", "polygon"].includes(HINTS[k]));
            err(`${ow}: needs exactly one of "box", "point", "polygon" or "mask"${shapes.length > 1 ? ` (found ${shapes.join(", ")})` : alt ? ` (use ${q(HINTS[alt])} instead of ${q(alt)})` : ""}`);
            return;
          }
          unknownKeys(o, OVERLAY, ow, warn);
          const shape = shapes[0], ov = { shape };
          if (shape === "box") {
            if (Array.isArray(o.box) && o.box.length === 4 && o.box.every(isNum) && o.box[2] > 0 && o.box[3] > 0) ov.box = o.box;
            else { err(`${ow}: "box" must be [x, y, w, h] in pixels with w and h above 0 (got ${q(o.box)})`); return; }
          } else if (shape === "point") {
            if (Array.isArray(o.point) && o.point.length === 2 && o.point.every(isNum)) ov.point = o.point;
            else { err(`${ow}: "point" must be [x, y] (got ${q(o.point)})`); return; }
          } else if (shape === "polygon") {
            if (Array.isArray(o.polygon) && o.polygon.length >= 3 && o.polygon.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every(isNum))) ov.polygon = o.polygon;
            else { err(`${ow}: "polygon" must be a list of at least 3 [x, y] points${Array.isArray(o.polygon) && o.polygon.every(isNum) ? " (it looks flat like COCO; pair the numbers as [[x, y], ...])" : ""}`); return; }
          } else {
            const mp = checkPath(o.mask, `${ow} mask`);
            if (!mp) return;
            if (!/\.png$/i.test(mp) && !isURL(mp)) { err(`${ow}: mask ${q(mp)} must be a PNG label image`); return; }
            ov.mask = mp;
          }
          if (o.source !== undefined && !isStr(o.source)) err(`${ow}: "source" must be a name`);
          ov.source = isStr(o.source) ? o.source.trim() : "model";
          addSource(ov.source);
          if (o.label !== undefined) ov.label = String(o.label);
          if (o.value !== undefined) {
            if (Number.isInteger(o.value) && o.value >= 1) ov.value = o.value;
            else err(`${ow}: "value" must be a whole number of 1 or more (the object's label in the mask)`);
            if (shape !== "mask") warn(`${ow}: "value" only applies to masks`);
          }
          if (o.style !== undefined) { if (["outline", "fill", "bold"].includes(o.style)) ov.style = o.style; else err(`${ow}: "style" must be "outline", "fill" or "bold"`); }
          if (o.frame !== undefined) {
            if (Number.isInteger(o.frame) && o.frame >= 0 && o.frame < frames.length) ov.frame = o.frame;
            else err(`${ow}: "frame" ${q(o.frame)} must be a frame index from 0 to ${Math.max(0, frames.length - 1)}`);
          }
          card.overlays.push(ov);
        });
      }
    } else { err(`${at()}: must be an image path or a card object`); return; }
    if (seen.has(card.id)) err(`${at()}: id ${q(card.id)} is already used by cards[${seen.get(card.id)}]; card ids must be unique`);
    else seen.set(card.id, i);
    cards.push(card);
  });

  if (errors.length) return { deck: null, errors, warnings, paths };
  if (mode === "follow") cards.forEach((c, i) => { if (c.frames.length < 2) errors.push(`cards[${i}] (id ${q(c.id)}): a follow deck needs "frames" (at least 2 time points)`); });
  if (errors.length) return { deck: null, errors, warnings, paths };
  // annotate and follow decks answer with a drawing or a track; these values label it in tallies and exports
  const finalAnswers = mode === "swipe" ? answers : mode === "annotate" ? [
    { slot: "button", label: "Annotated", value: "annotated", color: "#c6ff3d" },
    { slot: "button", label: "Nothing to mark", value: "empty", color: "#8fa3aa" },
  ] : [
    { slot: "button", label: "Followed to the end", value: "last_frame", color: "#3ddc97" },
    { slot: "button", label: "Cell ends", value: "ends", color: "#ff5d6c" },
    { slot: "button", label: "Divides", value: "divides", color: "#b48cff" },
    { slot: "button", label: "Leaves view", value: "leaves", color: "#f2c14e" },
  ];
  const deck = { hooman: FORMAT, id, title, question, mode, framesAre, ...(channels ? { channels, channelView } : {}), help: isStr(raw.help) ? raw.help : "", about: isStr(raw.about) ? raw.about.trim() : "", shuffle: !!raw.shuffle, answers: finalAnswers, sources, classes, cards };
  return { deck, errors, warnings, paths };
}

// Effective answers: the deck's, unless the hooman edited them in the app.
export function answerDefs(rec) {
  return rec.custom && Array.isArray(rec.custom.answers) ? rec.custom.answers : rec.deck.answers;
}
