import * as fs from "node:fs";

const INFO_HTML =
  `<div class="command-result"><p>Tidies result titles and loads sharper news/video thumbnails on every search page.</p></div>`;

let _sign = null;
let _fetch = null;

// Brave's image proxy (imgs.search.brave.com/<sig>/<options>/<base64 of original URL>) only
// sends 200x200 thumbnails. The original picture's address is inside it, so decode that.
const braveOriginal = (u) => {
  const segs = u.pathname.split("/").filter(Boolean);
  let last = -1;
  segs.forEach((s, i) => { if (i > 0 && s.includes(":")) last = i; });
  if (last < 1 || last >= segs.length - 1) return null;
  const rest = segs.slice(last + 1);
  let out = "";
  try {
    if (rest[0] === "plain") {
      out = decodeURIComponent(rest.slice(1).join("/")).replace(/@\w+$/, "");
    } else {
      const b64 = rest.join("").replace(/\.\w+$/, "").replace(/-/g, "+").replace(/_/g, "/");
      out = Buffer.from(b64, "base64").toString("utf8");
    }
  } catch { return null; }
  out = out.replace(/&amp;/g, "&").trim();
  return /^https?:\/\/[^\s]+$/i.test(out) ? out : null;
};

// Only these image hosts get upgraded, so this can never act as an open proxy
const upgrade = (raw, W) => {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase();
  // Bing's thumbnail service, on every host it uses (Bing News sends www.bing.com/th?id=...&w=234&h=132)
  if ((host === "th.bing.com" || host === "www.bing.com" || host === "bing.com" || /^tse\d*\.mm\.bing\.net$/.test(host)) && u.pathname.startsWith("/th")) {
    const w = parseInt(u.searchParams.get("w") || "0", 10);
    const h = parseInt(u.searchParams.get("h") || "0", 10);
    if (w && w >= W) return null;
    u.searchParams.set("w", String(W));
    if (w && h) u.searchParams.set("h", String(Math.round((W * h) / w)));
    else u.searchParams.delete("h");
    u.searchParams.set("qlt", "90");
    return u.toString();
  }
  const m = /^\/vi(_webp)?\/([\w-]{6,})\/(default|mqdefault|hqdefault|sddefault)\.(jpg|webp)$/.exec(u.pathname);
  if (/(^|\.)ytimg\.com$/.test(host) && m) {
    return `https://i.ytimg.com/vi/${m[2]}/hq720.jpg`;
  }
  if (host === "imgs.search.brave.com") return braveOriginal(u);
  return null;
};


// ===== Typo fixing and related searches, without Google =====
// Typo fixes are worked out on your PC: an English word list (82,765 words with how common each is) plus words
// learned from your own results (names like "Asura Scans" or "RTINGS"), so it keeps getting better the more you
// search. Bing's suggestions (Bing already gets your searches as an engine) add a second opinion and the related
// searches. Words you keep with "Search instead" are never changed again.
// Same as core.js sitesFromLists (the server file can't import the page's core; a test checks they agree)
const plainHost = (l) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l);
export const sitesFromLists = (block = "", score = "") => {
  const out = {};
  for (const raw of String(score).split("\n")) {
    const [d, n] = raw.split("|").map((x) => (x || "").trim());
    const v = Number(n);
    if (d && plainHost(d) && n && Number.isFinite(v) && v !== 0) out[d.toLowerCase()] = v > 0 ? "prefer" : "lower";
  }
  for (const raw of String(block).split("\n")) { const d = raw.trim().toLowerCase(); if (plainHost(d)) out[d] = "hide"; }
  return out;
};
let DIR = "/app/data/plugins/clean-titles";

// ===== Sites in Settings: the same Prefer / Normal / Lower / Hide list as each result's menu =====
// degoog's own block and score lists stay the one truth (degoog filters with them on the server, every tab). The
// "Sites" setting is a view of them: refreshed from the lists (each page load and at start), and when you save
// Settings, only the rows you changed there are written back into the lists. sites-mirror.json (this plugin's
// folder) holds what the setting last showed, so a start-up or an unrelated Settings save never undoes an edit
// made elsewhere (the menu, or degoog's own list fields).
export const SITE_SCORE = { prefer: 40, lower: -40 };
const CHOICES = ["prefer", "normal", "lower", "hide"];
// Kept as typed apart from the address bits ("www.x.com" stays: a block on x.com would also cover its subdomains)
const cleanSite = (x) => String(x || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#:].*$/, "").replace(/\.$/, "");
// Settings rows (JSON text, [{site, choice}]) -> {domain: choice}; Normal and unreadable rows left out
export const sitesOfRows = (raw) => {
  let rows = [];
  try { rows = typeof raw === "string" ? (raw.trim() ? JSON.parse(raw) : []) : raw; } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const out = {};
  for (const r of rows) {
    const d = cleanSite(r && r.site), c = String((r && r.choice) || "").toLowerCase();
    if (plainHost(d) && CHOICES.includes(c) && c !== "normal") out[d] = c;
  }
  return out;
};
export const rowsOfSites = (sites) => JSON.stringify(Object.keys(sites).sort().map((d) => ({ site: d, choice: sites[d] })));
const sameSites = (a, b) => rowsOfSites(a) === rowsOfSites(b);
// The lists' text with each changed site set to its new choice; every other line (patterns, comments) untouched
export const applySites = (block, score, delta) => {
  const ds = Object.keys(delta).sort();
  const mine = (l, d) => { const t = l.trim().toLowerCase(); return t === d || t === `www.${d}`; };
  let b = String(block || "").split("\n"), s = String(score || "").split("\n");
  b = b.filter((l) => !ds.some((d) => mine(l, d)));
  s = s.filter((l) => !ds.some((d) => mine(l.split("|")[0], d)));
  const tidy = (a) => { while (a.length && !a[a.length - 1].trim()) a.pop(); return a; };
  b = tidy(b); s = tidy(s);
  for (const d of ds) {
    if (delta[d] === "hide") b.push(d);
    else if (SITE_SCORE[delta[d]]) s.push(`${d}|${SITE_SCORE[delta[d]]}`);
  }
  return { block: b.join("\n"), score: s.join("\n") };
};
// degoog's own list and settings code (same process), so a write is seen by its filter at once. Missing in a
// future degoog -> the Settings list just stays read-only (the menu still works through degoog's Settings routes).
let SID = "clean-titles-command";
let _dg = null;
export const _setDegoog = (x, dir) => { _dg = Promise.resolve(x); if (dir) DIR = dir; };
const degoog = () => (_dg ||= (async () => {
  for (const base of [process.env.DEGOOG_SRC, `${process.cwd()}/src`, "/app/src"].filter(Boolean)) {
    try {
      const [l, p] = await Promise.all([import(`${base}/server/utils/filtering/domain-lists.ts`), import(`${base}/server/utils/settings/plugin-settings.ts`)]);
      if (typeof l.readDomainLists === "function" && typeof l.writeDomainList === "function" && typeof p.setSettings === "function") return { readDomainLists: l.readDomainLists, writeDomainList: l.writeDomainList, setSettings: p.setSettings };
    } catch {}
  }
  return null;
})());
const mirrorFile = () => `${DIR}/sites-mirror.json`;
const readMirror = () => { try { const j = JSON.parse(fs.readFileSync(mirrorFile(), "utf8")); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { return null; } };
let _sitesQ = Promise.resolve();
const queueSites = (fn) => (_sitesQ = _sitesQ.then(fn).catch(() => {}));
const showSites = async (dg, sites) => { await dg.setSettings(SID, { sites: rowsOfSites(sites) }); fs.writeFileSync(mirrorFile(), JSON.stringify(sites)); };
// The Settings list shows these sites from now on (after a page load read the lists)
export const mirrorTo = (sites) => queueSites(async () => {
  const m = readMirror();
  if (m && sameSites(m, sites)) return;
  const dg = await degoog();
  if (dg) await showSites(dg, sites);
});
// Each Settings value degoog hands the plugin (start-up and every save): your edits there go into the lists
export const sitesFromSettings = (raw) => queueSites(async () => {
  const dg = await degoog();
  if (!dg) return;
  const rows = sitesOfRows(raw), m = readMirror();
  if (rows && m && !sameSites(rows, m)) {
    const delta = {};
    for (const d of new Set([...Object.keys(rows), ...Object.keys(m)])) if ((rows[d] || "normal") !== (m[d] || "normal")) delta[d] = rows[d] || "normal";
    const lists = await dg.readDomainLists();
    const next = applySites(lists.domainBlockList, lists.domainScoreList, delta);
    if (next.block !== (lists.domainBlockList || "")) await dg.writeDomainList("domainBlockList", next.block);
    if (next.score !== (lists.domainScoreList || "")) await dg.writeDomainList("domainScoreList", next.score);
  }
  const now = await dg.readDomainLists();
  const sites = sitesFromLists(now.domainBlockList, now.domainScoreList);
  // Shown back as the lists now stand (also tidies a typed "https://www.x.com/page" to "x.com")
  if (!m || !rows || !sameSites(m, sites) || !sameSites(rows, sites)) await showSites(dg, sites);
});
export const _sitesIdle = () => _sitesQ;

// ===== Anti-SEO auto-Lower =====
// Each search's first page sends its signs (core seoSigns: copies, SEO-bait wording, stale "best 20XX" lists, AI
// tells, essay-writing services). Per site: searches it was in, and how many of those showed a sign. A site with
// signs on most of at least SEO_MIN searches is set to Lower in degoog's score list, marked auto. Only Lower, ever.
// A site you've set yourself is never counted, and changing an auto one yourself stops auto for it for good.
// Kept in sites-auto.json here: site names and two counts, nothing about the searches.
const SEO_MIN = 5;
let SEO_ON = true;
const autoFile = () => `${DIR}/sites-auto.json`;
let AUTO = null;
const readAuto = () => { if (AUTO) return AUTO; try { const j = JSON.parse(fs.readFileSync(autoFile(), "utf8")); AUTO = j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { AUTO = {}; } return AUTO; };
const autoList = () => Object.keys(readAuto()).filter((d) => AUTO[d].auto && !AUTO[d].off).sort();
let _seoHour = 0, _seoCount = 0;
export const seoReport = (raw) => queueSites(async () => {
  if (!SEO_ON) return;
  // At most 300 reports an hour (the bridge needs no sign-in)
  const hr = Math.floor(Date.now() / 3600000);
  if (hr !== _seoHour) { _seoHour = hr; _seoCount = 0; }
  if (++_seoCount > 300) return;
  let j = {};
  try { j = JSON.parse(raw); } catch { return; }
  const seen = (Array.isArray(j.seen) ? j.seen : []).map((d) => String(d).toLowerCase()).filter((d) => plainHost(d) && d.length < 100).slice(0, 60);
  const hit = j.hit && typeof j.hit === "object" ? j.hit : {};
  const dg = await degoog();
  let lists = null;
  try { lists = dg ? await dg.readDomainLists() : null; } catch {}
  const mine = lists ? sitesFromLists(lists.domainBlockList, lists.domainScoreList) : {};
  const A = readAuto(), lower = [];
  for (const d of new Set(seen)) {
    const t = (A[d] ||= { seen: 0, hits: 0 });
    if (t.off) continue;
    if (t.auto) { if (lists && mine[d] !== "lower") t.off = true; continue; } // you changed it: auto stops
    if (mine[d]) continue; // your own choice: not counted
    t.seen++;
    if (Array.isArray(hit[d]) && hit[d].length) t.hits++;
    if (t.seen >= SEO_MIN && t.hits * 2 > t.seen) lower.push(d);
  }
  if (lower.length && dg && lists) {
    const delta = Object.fromEntries(lower.map((d) => [d, "lower"]));
    const next = applySites(lists.domainBlockList, lists.domainScoreList, delta);
    await dg.writeDomainList("domainScoreList", next.score);
    for (const d of lower) A[d].auto = true;
  }
  // Sites seen once and clean are dropped after 5,000 entries, so the file stays small
  const keys = Object.keys(A);
  if (keys.length > 5000) for (const d of keys) if (!A[d].auto && !A[d].off && A[d].hits === 0 && A[d].seen <= 1) delete A[d];
  fs.writeFileSync(autoFile(), JSON.stringify(A));
  if (lower.length) { const now = await dg.readDomainLists(); await showSites(dg, sitesFromLists(now.domainBlockList, now.domainScoreList)); }
});
const WORDS = new Map();
let TOTAL = 0, PTOTAL = 0; // all word / word-pair counts added up: how common one is = its count / total
// How well two words go together compared with chance (above 0: English puts them side by side, like "open a";
// below 0: it avoids that, like "a sell", an article before a verb); null when there's no data on the pair
const fit = (a, b) => { const c = PAIRS.get(`${a} ${b}`), x = WORDS.get(a), y = WORDS.get(b); return c && x && y ? Math.log2((c / PTOTAL) / ((x / TOTAL) * (y / TOTAL))) : null; };
// Small grammar words ("a", "to", "of", "the"): searches often leave them out on purpose ("does openai sell data"),
// so a word only becomes one when it's that word with two letters swapped or one key off ("ot" -> "to"), never a dropped letter
const isFunc = (w) => TOTAL > 0 && (WORDS.get(w) || 0) / TOTAL >= 0.001;
const funcOk = (w, c) => !isFunc(c) || (w.length === c.length && slip(w, c));
// Names: words your results write with a capital mid-title ("AI", "PuTTY", "Asura") are never treated as typos
// ...and names from Wikipedia's article titles ("openai", "asura", "ai"), so it knows them without learning anything
const NAMES = new Set();
const isName = (w) => NAMES.has(w) || (learned.cap && learned.cap[w] || 0) >= 2;
// Settings > Clean Titles > "Learn from my search results" (off: nothing about your searches is stored or used)
let LEARN = false;
// Settings > Clean Titles: which of Sitelinks / Discussions / Videos / Top stories to show (all on unless turned off)
let SHOW = { sl: true, forum: true, video: true, news: true };
const EMPTY = () => ({ w: {}, b: {}, keep: {}, fix: {}, cap: {} });
const readLearned = () => { try { learned = Object.assign(EMPTY(), JSON.parse(fs.readFileSync(`${DIR}/learned.json`, "utf8"))); } catch { learned = EMPTY(); } };
const PAIRS = new Map();
let learned = { w: {}, b: {}, keep: {}, fix: {} };
let loaded = false, dirty = false;
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const toks = (s) => norm(s).replace(/[^\p{L}\p{N}' ]+/gu, " ").split(" ").filter((w) => w.length > 1 && w.length < 25);
const save = () => {
  if (!dirty || !LEARN) return;
  dirty = false;
  try {
    for (const k of ["w", "b"]) {
      const e = Object.entries(learned[k]);
      if (e.length > 40000) learned[k] = Object.fromEntries(e.sort((x, y) => y[1] - x[1]).slice(0, 30000));
    }
    fs.writeFileSync(`${DIR}/learned.json.tmp`, JSON.stringify(learned));
    fs.renameSync(`${DIR}/learned.json.tmp`, `${DIR}/learned.json`);
  } catch {}
};
const load = () => {
  if (loaded) return;
  loaded = true;
  try {
    for (const line of fs.readFileSync(`${DIR}/words.txt`, "utf8").split("\n")) {
      const [w, n] = line.replace(/^﻿/, "").trim().split(" ");
      if (w && n) { WORDS.set(w, Number(n)); TOTAL += Number(n); }
    }
  } catch {}
  try {
    for (const line of fs.readFileSync(`${DIR}/pairs.txt`, "utf8").split("\n")) {
      const p = line.replace(/^﻿/, "").trim().split(" ");
      if (p.length === 3) { PAIRS.set(`${p[0]} ${p[1]}`, Number(p[2])); PTOTAL += Number(p[2]); }
    }
  } catch {}
  if (LEARN) readLearned();
  // Wikipedia also has titles that are common misspellings ("Teh ...", "Tommorow ..."): a name that is a common word
  // with two letters swapped or a letter doubled/undoubled is treated as the typo it looks like, not a name
  const dbl = (w) => w.replace(/(.)\1+/g, "$1"), swaps = new Set(), dbls = new Set();
  for (const [w, n] of WORDS) if (n >= 1000000) { dbls.add(dbl(w)); for (let i = 0; i + 1 < w.length; i++) if (w[i] !== w[i + 1]) swaps.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2)); }
  try { for (const w of fs.readFileSync(`${DIR}/names.txt`, "utf8").split("\n")) if (w && !swaps.has(w) && !dbls.has(dbl(w))) NAMES.add(w); } catch {}
  const t = setInterval(save, 60000);
  if (t && t.unref) t.unref();
};
// Learn from a page of results: each word or word pair counts once per search
const learn = (titles) => {
  if (!LEARN) return;
  load();
  const ws = new Set(), bs = new Set(), caps = new Set();
  for (const t of titles.slice(0, 20)) {
    const k = toks(t);
    k.forEach((w, i) => { ws.add(w); if (i) bs.add(`${k[i - 1]} ${w}`); });
    // Capitalised after the first word (or all capitals, like "AI"): a name
    String(t).split(/[^\p{L}\p{N}'+.#-]+/u).filter(Boolean).forEach((x, i) => { if ((i > 0 && /^\p{Lu}/u.test(x)) || (x.length >= 2 && x === x.toUpperCase() && /\p{L}/u.test(x))) caps.add(x.toLowerCase()); });
  }
  if (!learned.cap) learned.cap = {};
  for (const w of caps) learned.cap[w] = (learned.cap[w] || 0) + 1;
  for (const w of ws) learned.w[w] = (learned.w[w] || 0) + 1;
  for (const b of bs) learned.b[b] = (learned.b[b] || 0) + 1;
  dirty = true;
};
const keep = (q) => { if (!LEARN) return; load(); for (const w of toks(q)) { learned.keep[w] = 1; delete learned.fix[w]; } dirty = true; };
// You tapped "Did you mean": that fix is used straight away next time (per word, so it carries to other searches)
const accept = (typed, fixed) => {
  if (!LEARN) return;
  load();
  const a = norm(typed).split(" "), b = norm(fixed).split(" ");
  for (let i = 0, j = 0; i < a.length && j < b.length; i++, j++) {
    if (a[i] === b[j]) continue;
    const two = b[j + 1] !== undefined && b.length - j > a.length - i ? `${b[j]} ${b[j + 1]}` : null;
    if (/\d/.test(a[i]) || a[i].length < 2) { if (two) j++; continue; }
    if (two && a[i + 1] === b[j + 2]) { learned.fix[a[i]] = two; j++; } else learned.fix[a[i]] = b[j];
    delete learned.keep[a[i]];
  }
  dirty = true;
};

const dist = (a, b) => {
  if (Math.abs(a.length - b.length) > 6) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
};

// Bing's suggestions for a search (cached a day)
const _sug = new Map();
// Bing answering with nothing at all (204, blocked, error) means it's down for this server: skip it for an hour
let bingDownUntil = 0;
const suggestions = async (q) => {
  const key = norm(q);
  if (!key) return [];
  const hit = _sug.get(key);
  if (hit && Date.now() - hit.t < 86400000) return hit.s;
  let s = [];
  // Bing first; DuckDuckGo's suggestions (same answer format) when Bing gives nothing
  const urls = [`https://api.bing.com/osjson.aspx?query=${encodeURIComponent(key)}`, `https://duckduckgo.com/ac/?q=${encodeURIComponent(key)}&type=list`];
  // degoog's own outgoing fetch first, then a plain one (the plain one is what reached Bing in testing)
  // Bing answers some browser names with an empty page, so a Chrome one goes first (it worked in testing)
  const UAS = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"];
  let bingBad = 0, bingTries = 0;
  got: for (const url of urls) for (const ua of UAS) for (const f of _fetch ? [_fetch, fetch] : [fetch]) {
    const isBing = url === urls[0];
    if (isBing && Date.now() < bingDownUntil) continue;
    if (isBing) bingTries++;
    try {
      const r = await f(url, {
        headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9", Accept: "application/json, text/javascript, */*" },
        signal: AbortSignal.timeout(1500),
      });
      if (isBing && (!r.ok || r.status === 204)) bingBad++;
      if (r.ok && r.status !== 204) { const j = JSON.parse(await r.text()); if (Array.isArray(j) && Array.isArray(j[1])) { s = j[1].filter((x) => typeof x === "string"); if (s.length) break got; } }
    } catch { if (isBing) bingBad++; }
    if (isBing && bingTries && bingBad === bingTries && bingTries >= 2) bingDownUntil = Date.now() + 3600000;
  }
  if (s.length) { if (_sug.size > 2000) _sug.clear(); _sug.set(key, { s, t: Date.now() }); }
  return s;
};

const skip = (qn) => qn.length < 3 || qn.length > 80 || /["!:\/\\@#]|https?|(^| )-\S|^[\d\s.,+\-*x^%()=]+$/.test(qn);

// Opinion 1: a Bing suggestion that is the same search with a few letters off (never words added or dropped)
const bingFix = (qn, sl) => {
  load();
  const qw = qn.split(" "), qs = qn.replace(/ /g, "");
  const lim = Math.min(3, Math.max(1, Math.round(qs.length / 5)));
  const close = (x, pool) => !/\d/.test(x) && pool.some((y) => dist(x, y) <= Math.max(1, Math.round(x.length / 3)));
  let best = null, bd = 99;
  for (const s of sl.slice(0, 6)) {
    const w = s.split(" ");
    for (const k of [qw.length - 1, qw.length, qw.length + 1]) {
      if (k < 1 || k > w.length) continue;
      const cw = w.slice(0, k), cand = cw.join(" "), cs = cand.replace(/ /g, "");
      if (cand === qn) continue;
      const joined = cs === qs;
      const qOnly = qw.filter((x) => !cw.includes(x)), cOnly = cw.filter((x) => !qw.includes(x));
      // Missing space plus a typo in that word ("asurascxns" -> "asura scans"): all other words must match exactly
      const split = cw.length === qw.length + 1 && qw.some((x, p) => !/\d/.test(x) && x.length >= 5 && cw.slice(0, p).join(" ") === qw.slice(0, p).join(" ") && cw.slice(p + 2).join(" ") === qw.slice(p + 1).join(" ") && dist(x, cw[p] + cw[p + 1]) <= Math.max(1, Math.floor(x.length / 4)));
      if (!joined && !split && (cw.length !== qw.length || !qOnly.every((x) => x.length >= 3 && close(x, cOnly)) || !cOnly.every((x) => close(x, qOnly)))) continue;
      // A suggestion that still has a misspelled word ("the weather tommorow in cairo") loses to a fully correct one
      const d0 = joined ? 0.5 : dist(qs, cs);
      const score = d0 + 2 * cw.filter((x) => !/\d/.test(x) && !WORDS.has(x) && (learned.w[x] || 0) < 2).length;
      if (d0 > 0 && d0 <= lim && score < bd) { bd = score; best = cand; }
    }
  }
  return best;
};

// Opinion 2: word by word on your PC. A word is left alone if it's a real word, one your results use, one in
// Bing's suggestions, or one you kept. Otherwise the most likely word 1-2 letters away wins, judged by how common
// it is, how often your results use it, and whether it fits the words around it ("asura scnas" -> "asura scans")
const ABC = "abcdefghijklmnopqrstuvwxyz'";
const edits = (w) => {
  const out = new Set();
  for (let i = 0; i <= w.length; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (b) out.add(a + b.slice(1));
    if (b.length > 1) out.add(a + b[1] + b[0] + b.slice(2));
    for (const c of ABC) { if (b) out.add(a + c + b.slice(1)); out.add(a + c + b); }
  }
  out.delete(w);
  return out;
};
// Is word b one plausible slip away from a: swapped letters, a missing or extra letter, a vowel mix-up, or a
// neighbouring key. "vitamix" -> "vitamin" (x and n are far apart) is not, so a name like that is never
// changed before searching
const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const keyAt = {};
ROWS.forEach((r, y) => [...r].forEach((ch, x) => { keyAt[ch] = [x + y * 0.5, y]; }));
const slip = (a, b) => {
  if (a.length !== b.length) return Math.abs(a.length - b.length) === 1;
  const d = [...a].map((ch, i) => i).filter((i) => a[i] !== b[i]);
  if (d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]]) return true;
  if (d.length !== 1) return false;
  const x = a[d[0]], y = b[d[0]];
  if (/[aeiouy]/.test(x) && /[aeiouy]/.test(y)) return true;
  const p = keyAt[x], q = keyAt[y];
  return !!(p && q && Math.abs(p[0] - q[0]) <= 1.5 && Math.abs(p[1] - q[1]) <= 1);
};
const localFix = (qn, extra) => {
  load();
  const known = (w) => WORDS.has(w) || NAMES.has(w) || (learned.w[w] || 0) >= 2 || !!learned.keep[w] || extra.has(w);
  const mine = (w) => (learned.w[w] || 0) >= 2 || extra.has(w);
  const pop = (w) => Math.log10((WORDS.get(w) || 0) + 10) + 4 * Math.log2((learned.w[w] || 0) + 1) + (extra.has(w) ? 4 : 0);
  // How well two words go together: common English pairs ("how to") and pairs from your results ("asura scans")
  const pair = (a, b) => (a && b ? 0.6 * Math.log10((PAIRS.get(`${a} ${b}`) || 0) + 1) + 3 * Math.log2((learned.b[`${a} ${b}`] || 0) + 1) : 0);
  const t0 = Date.now();
  // Space typed inside a word ("best blen der" -> "best blender"), when the halves aren't both real words
  const words = [];
  for (const w of qn.split(" ")) {
    const prev = words[words.length - 1], j = prev + w;
    if (prev && !/\d/.test(j) && (WORDS.get(j) || 0) >= 100000 && !(WORDS.has(prev) && WORDS.has(w) && (PAIRS.get(`${prev} ${w}`) || 0) > 0)) words[words.length - 1] = j;
    else words.push(w);
  }
  const unknown = [];
  const out = [];
  const fixWord = (w, i) => {
    const prev = i ? out[i - 1] : "", next = words[i + 1] || "";
    if (/\d/.test(w) || /^\W+$/.test(w)) return w;
    if (learned.fix[w]) return learned.fix[w];
    if (isName(w)) return w;
    if (w.length < 3 || known(w)) {
      // Real word in the wrong place ("how ot make", "the wether tomorrow"): a word 1 letter away that fits
      // its neighbours 300x better goes to the page check (never changed before searching)
      if ((WORDS.has(w) || w.length < 3) && (prev || next)) {
        const ctx = (x) => (prev ? Math.log10((PAIRS.get(`${prev} ${x}`) || 0) + 1) : 0) + (next ? Math.log10((PAIRS.get(`${x} ${next}`) || 0) + 1) : 0);
        let bc = null, bs = ctx(w) + 2.5;
        // ...and it must read as English on BOTH sides: no neighbour English avoids putting next to it ("open a sell")
        const fits = (c) => [prev && fit(prev, c), next && fit(c, next)].every((f) => f === null || f === "" || f >= 0);
        for (const c of edits(w)) if ((WORDS.get(c) || 0) >= (WORDS.get(w) || 0) && funcOk(w, c) && fits(c)) { const v = ctx(c); if (v > bs) { bs = v; bc = c; } }
        if (bc) unknown.push({ w, c: [bc] });
        // Real word that is one slip from a far more common one ("bets blender" -> "best blender"): the page
        // switches only if the results never use the typed word but keep using the common one
        else if (w.length >= 4 && !mine(w) && !learned.keep[w]) {
          const f = WORDS.get(w) || 0;
          const c = [...edits(w)].filter((x) => (WORDS.get(x) || 0) >= 20 * f && slip(w, x)).sort((x, y) => WORDS.get(y) - WORDS.get(x)).slice(0, 3);
          if (c.length) unknown.push({ w, c });
        }
      }
      // Short unknown word ("pro mx" -> "pro max"): the page picks whichever close word the results use
      if (w.length < 3 && !WORDS.has(w) && !unknown.some((u) => u.w === w)) {
        const c = [...edits(w)].filter((x) => WORDS.has(x) && funcOk(w, x)).sort((x, y) => WORDS.get(y) - WORDS.get(x)).slice(0, 8);
        if (c.length) unknown.push({ w, c });
      }
      return w;
    }
    const scored = new Map();
    const consider = (c, bonus, tier) => {
      const parts = c.split(" ");
      const s = Math.min(...parts.map(pop)) + pair(prev, parts[0]) + pair(parts[parts.length - 1], next) + (parts.length > 1 ? pair(parts[0], parts[1]) : 0) + bonus;
      const old = scored.get(c);
      if (!old || old.s < s) scored.set(c, { s, tier: Math.min(tier, old ? old.tier : 9) });
    };
    const e1 = [...edits(w)];
    for (const c of e1) if (known(c)) consider(c, 0, 1);
    // Two letters off ("definatly" -> "definitely", "restraunt" -> "restaurant"): a bit less likely than one
    if (w.length >= 5) for (const e of e1) { if (Date.now() - t0 > 250) break; for (const c of edits(e)) if (c !== w && known(c)) consider(c, -1.5, 2); }
    // Stuck keys ("bllendderr" -> "blender")
    const once = w.replace(/(.)\1+/g, "$1");
    if (once !== w && once.length >= 3) { if (known(once)) consider(once, -0.5, 1); for (const c of edits(once)) if (known(c)) consider(c, -1, 2); }
    // Missing space: "asurascans" -> "asura scans"
    for (let k = 2; k <= w.length - 2; k++) {
      const a = w.slice(0, k), b = w.slice(k);
      if (known(a) && known(b) && (a.length > 2 || WORDS.has(a)) && (b.length > 2 || WORDS.has(b))) consider(`${a} ${b}`, pair(a, b) > 0 ? 2 : -1.5, 1);
      // ...plus a typo in one half ("asurascxns" -> "asura scans")
      else if (w.length >= 7 && a.length >= 3 && b.length >= 3) {
        if (known(a)) { for (const c of edits(b)) if (known(c) && c.length > 2) consider(`${a} ${c}`, pair(a, c) > 0 ? 1 : -1.5, 2); }
        else if (known(b)) { for (const c of edits(a)) if (known(c) && c.length > 2) consider(`${c} ${b}`, pair(c, b) > 0 ? 1 : -1.5, 2); }
      }
    }
    if (!scored.size) { unknown.push({ w, c: soundAlike(w) }); return w; }
    const r = [...scored].sort((x, y) => y[1].s - x[1].s);
    const c = r.map((x) => x[0]).slice(0, 6);
    // Sure when the closest spelling clearly wins (10x more likely than any other equally close one, and not
    // beaten by a further one) and is a common word or one from your results
    const near1 = Math.min(...r.map((x) => x[1].tier));
    const tierR = r.filter((x) => x[1].tier === near1);
    const top = tierR[0][0].split(" ");
    const beaten = r.some((x) => x[1].tier > near1 && !x[0].includes(" ") && x[1].s > tierR[0][1].s - 1);
    // Long words are only fixed early to a very common word ("restraunt" could be "restaurant", so it waits)
    const common = top.length > 1 || (WORDS.get(top[0]) || 0) >= (w.length >= 8 ? 5000000 : 0);
    const typoLike = top.every(mine) || (common && (near1 > 1 ? w.length >= 8 && (WORDS.get(top[0]) || 0) >= 1000000 : top.length > 1 || slip(w, tierR[0][0])));
    const sure = typoLike && !beaten && r[0][0] === tierR[0][0] && (tierR.length === 1 || tierR[0][1].s - tierR[1][1].s >= 1) && top.every((x) => mine(x) || (WORDS.get(x) || 0) >= 100000) && (w.length >= 4 || tierR.length === 1 || tierR[0][1].s - tierR[1][1].s >= 1.5);
    if (sure) return c[0];
    unknown.push({ w, c });
    return w;
  };
  words.forEach((w, i) => out.push(fixWord(w, i)));
  // Sure words are fixed before searching. Unsure ones go to the page, which checks the results first and
  // only switches if they clearly use one of the candidates
  const fix = out.join(" ");
  // How common each candidate is in everyday English, so the page can tell "the results keep using it" from
  // "every text uses it" ("a", "the" are in any page, so seeing them proves nothing)
  const share = (x) => (TOTAL ? Math.min(...x.split(" ").map((y) => (WORDS.get(y) || 0) / TOTAL)) : 0);
  return { fix: fix !== qn ? fix : null, words: unknown.map((u) => ({ ...u, p: Object.fromEntries(u.c.map((x) => [x, share(x)])) })) };
};

// Sound-alike spellings ("chimminy" -> "chimney"): same consonant sounds, close in letters. Only offered
// through the page check (Did you mean), never changed before searching
const sk = (w) => {
  const s = w.toLowerCase().replace(/[^a-z]/g, "").replace(/^(kn|gn|pn|wr)/, (m) => m[1]).replace(/x/g, "ks").replace(/ph/g, "f").replace(/ck|q/g, "k").replace(/c(?=[eiy])/g, "s").replace(/ch|sh/g, "x").replace(/c/g, "k").replace(/dg|j/g, "g").replace(/gh/g, "").replace(/z/g, "s").replace(/th/g, "0").replace(/v/g, "f");
  return s ? s[0] + s.slice(1).replace(/[aeiouyhw]/g, "").replace(/(.)\1+/g, "$1") : "";
};
let SOUND = null;
const soundAlike = (w) => {
  if (w.length < 4) return [];
  if (!SOUND) {
    SOUND = new Map();
    for (const [x, n] of WORDS) if (n >= 20000 && x.length >= 3) { const k = sk(x); if (!SOUND.has(k)) SOUND.set(k, []); SOUND.get(k).push(x); }
  }
  return (SOUND.get(sk(w)) || []).filter((x) => dist(w, x) <= Math.max(3, Math.ceil(w.length / 2))).sort((a, b) => WORDS.get(b) - WORDS.get(a)).slice(0, 6);
};
// People also ask: question-style Bing suggestions for the search ("how ...", "what ...", "is ...")
const QW = /^(what|how|why|is|are|can|does|do|did|when|where|who|which|should|will|was)\b/;
// Search-box phrasing that isn't a real question ("what putty is used for", "how putty works"): skipped
const WH2 = /^(what|how|why|when|where|who|which) (?!(is|are|was|were|do|does|did|can|could|should|would|will|to|much|many|long|old|far|often|big|tall|fast|kind|type|types|size|happens|happened|causes|caused|makes|made|time|year|day|age|percent|color|colour|country|state|city|language|team|songs?|movies?|episode|season|i|you|we|they|he|she|it|my|your|a|an)\b)/;
const broken = (s) => WH2.test(s);
const questions = async (q) => {
  const qn = norm(q);
  const want = toks(qn).filter((w) => w.length >= 3);
  const lists = await Promise.all(["", "what ", "what is ", "what does ", "how ", "how to ", "how do ", "why ", "who is ", "when ", "is ", "can "].map((p) => suggestions(p + qn)));
  const out = [], seen = new Set();
  // Take turns between question forms (what, how, why, who, is...) so the list is varied like Google's
  const mixed = [];
  for (let i = 0; i < 8; i++) for (const l of lists) if (l[i]) mixed.push(l[i]);
  for (const s of mixed.map(norm)) {
    if (!QW.test(s) || seen.has(s) || s.split(" ").length < 3 || s === qn || broken(s)) continue;
    if (want.length && !want.some((w) => s.includes(w))) continue;
    // Same question in other words ("why are the steelers called that" / "why are they called steelers"): keep one
    const sw = new Set(s.split(" "));
    if (out.some((o) => { const ow = o.toLowerCase().replace(/\?$/, "").split(" "); return ow.filter((w) => sw.has(w)).length >= 0.7 * Math.max(ow.length, sw.size); })) continue;
    seen.add(s);
    out.push(s[0].toUpperCase() + s.slice(1) + (s.endsWith("?") ? "" : "?"));
    if (out.length >= 4) break;
  }
  return out;
};

// The fix for a search, or null. Both opinions agree on what's a real search: if Bing has suggestions that
// start with it, it's left alone
const _fix = new Map();
// The page now asks /fix at page load, while the search's own interceptor is working out the same fix: both share
// one run (one set of Bing suggestion requests), not two
const _fixRun = new Map();
const check = (q) => {
  const qn = norm(q);
  if (_fixRun.has(qn)) return _fixRun.get(qn);
  const p = check0(q).finally(() => _fixRun.delete(qn));
  _fixRun.set(qn, p);
  return p;
};
const check0 = async (q) => {
  const qn = norm(q);
  if (skip(qn)) return { fix: null, words: [] };
  if (_fix.has(qn)) return _fix.get(qn);
  const sl = (await suggestions(qn)).map(norm).filter(Boolean);
  let r = { fix: null, words: [] };
  if (!sl.some((s) => s.startsWith(qn))) {
    let b = bingFix(qn, sl);
    // Second look: Bing's suggestions for the fixed search often finish the job ("the weather tommorow" -> "the weather tomorrow")
    if (b && b.split(" ").some((x) => !/\d/.test(x) && !WORDS.has(x) && (learned.w[x] || 0) < 2)) { const b2 = bingFix(b, (await suggestions(b)).map(norm).filter(Boolean)); if (b2) b = b2; }
    if (b) r = { fix: b, words: [], via: "bing-suggest" };
    else { r = localFix(qn, new Set(sl.flatMap((s) => s.split(" ")))); r.via = "local"; }
  }
  // Sure enough to change the search only for clear slips. A short word changed by an added or missing letter
  // ("mx" -> "max") or a key-mash ("dfsdf") could be meant, so it's searched as typed with "Did you mean" instead
  if (r.fix && r.fix !== qn) {
    const qw = qn.split(" "), bw = r.fix.split(" ");
    const mash = (x) => x.length >= 4 && !/[aeiouy]/.test(x) && !WORDS.has(x) && !isName(x);
    const unsure = qw.length === bw.length && qw.some((x, i) => x !== bw[i] && !/\d/.test(x) && (mash(x) || (x.length <= 5 && (x.length !== bw[i].length || !slip(x, bw[i])))));
    if (unsure) r = { fix: null, words: r.words || [], dym: r.fix, via: r.via };
  }
  if (r.fix === qn) r.fix = null;
  // Only kept when Bing answered, so a slow moment never sticks
  if (sl.length) { if (_fix.size > 2000) _fix.clear(); _fix.set(qn, r); }
  return r;
};
const fixFor = async (q) => (await check(q)).fix;

export const interceptor = {
  name: "Clean Titles typo fixer",
  description: "Fixes typos before searching, like Google's 'Showing results for', and learns from your results.",
  init(ctx) {
    if (ctx && typeof ctx.fetch === "function" && !_fetch) _fetch = ctx.fetch;
    if (ctx && ctx.dir) DIR = ctx.dir;
    load();
  },
  async intercept(query, context) {
    if (!_fetch && context && typeof context.fetch === "function") _fetch = context.fetch;
    try { return { query: (await fixFor(query)) || query }; } catch { return { query }; }
  },
};

export const routes = [
  {
    method: "get",
    path: "/fix",
    async handler(req) {
      const u = new URL(req.url);
      const q = (u.searchParams.get("q") || "").slice(0, 200);
      if (u.searchParams.get("keep")) { keep(q); _fix.clear(); _fixRun.clear(); }
      if (u.searchParams.get("acc")) { accept(u.searchParams.get("acc").slice(0, 200), q); _fix.clear(); _fixRun.clear(); }
      const { fix, words, dym, via } = await check(q);
      const seen = new Set([norm(q), norm(fix || q)]);
      // Several suggestions that are the same search plus a different place ("... in hull", "... in surin") are a
      // list of other people's towns, not related searches: that whole group goes ("near me" stays)
      const all = (await suggestions(fix || q)).map(norm).filter((x) => x && !seen.has(x) && seen.add(x));
      const placeKey = (x) => { const m = /^(.+?) (in|at|near|from) (\S+(?: \S+){0,2})$/.exec(x); return m && m[3] !== "me" ? `${m[1]} ${m[2]}` : null; };
      const groups = new Map();
      for (const x of all) { const k = placeKey(x); if (k) groups.set(k, (groups.get(k) || 0) + 1); }
      const related = all.filter((x) => { const k = placeKey(x); return !k || groups.get(k) < 2; }).slice(0, 8);
      return new Response(JSON.stringify({ fix, words, dym, via, related }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  },
  {
    method: "get",
    path: "/qs",
    async handler(req) {
      const q = (new URL(req.url).searchParams.get("q") || "").slice(0, 200);
      let qs = [];
      try { if (!skip(norm(q))) qs = await questions(q); } catch {}
      return new Response(JSON.stringify({ q: qs }), { headers: { "Content-Type": "application/json", "Cache-Control": qs.length ? "private, max-age=3600" : "no-store" } });
    },
  },
  {
    // Another plugin's request the iPhone couldn't send (AI Summary...): made here inside degoog, answer sent back whole
    method: "post",
    path: "/relay",
    async handler(req) {
      let j = {};
      try { j = await req.json(); } catch {}
      const path = String(j.path || "");
      if (!/^\/api\/plugin\/[\w.-]+\/[\w./-]*$/.test(path.split("?")[0])) return new Response("bad path", { status: 400 });
      const post = j.method === "POST";
      try {
        const r = await fetch(`http://127.0.0.1:${Number(process.env.DEGOOG_PORT) || 4444}${path}`, { method: post ? "POST" : "GET", headers: j.type ? { "Content-Type": String(j.type) } : {}, body: post ? String(j.body ?? "") : undefined, signal: AbortSignal.timeout(90000) });
        return new Response(JSON.stringify({ status: r.status, type: r.headers.get("content-type") || "", text: await r.text() }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      } catch (e) {
        return new Response(JSON.stringify({ status: 502, type: "text/plain", text: String(e) }), { headers: { "Content-Type": "application/json" } });
      }
    },
  },
  {
    // Your site choices (Prefer / Lower / Hide), read from degoog's own block and score lists: domains only. The
    // page keeps a copy, so the next page knows before paint which sites skip the 2-per-site limit. Read-only:
    // changes go through degoog's Settings routes with your Settings sign-in, never through here.
    method: "get",
    path: "/sites",
    handler: () => {
      let block = "", score = "";
      const data = process.env.DEGOOG_DATA_DIR || `${process.cwd()}/data`;
      try {
        const j = JSON.parse(fs.readFileSync(process.env.DEGOOG_SEARCH_LISTS_FILE || `${data}/search/search-lists.json`, "utf8"));
        block = typeof j.domainBlockList === "string" ? j.domainBlockList : ""; score = typeof j.domainScoreList === "string" ? j.domainScoreList : "";
      } catch {
        try { const s = JSON.parse(fs.readFileSync(`${data}/server-settings.json`, "utf8")).settings || {}; block = String(s.domainBlockList || ""); score = String(s.domainScoreList || ""); } catch {}
      }
      const sites = sitesFromLists(block, score);
      mirrorTo(sites);
      return new Response(JSON.stringify({ sites, auto: autoList().filter((d) => sites[d] === "lower"), seo: SEO_ON }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  },
  {
    // Anti-SEO signs from one search (see seoReport); answers at once, the counting happens after
    method: "post",
    path: "/seo",
    async handler(req) {
      let t = "";
      try { t = await req.text(); } catch {}
      if (t.length < 20000) seoReport(t);
      return new Response(null, { status: 204 });
    },
  },
  {
    method: "get",
    path: "/prefs",
    handler: () => new Response(JSON.stringify(SHOW), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }),
  },
  {
    method: "post",
    path: "/learn",
    async handler(req) {
      try {
        const j = await req.json();
        if (Array.isArray(j.t)) learn(j.t.filter((x) => typeof x === "string").map((x) => x.slice(0, 300)));
      } catch {}
      return new Response(null, { status: 204 });
    },
  },
  {
    method: "get",
    path: "/hd",
    handler(req) {
      const src = new URL(req.url).searchParams.get("src") || "";
      let inner = src;
      let sig = "";
      if (src.includes("/api/proxy/image")) {
        const p = new URLSearchParams(src.split("?")[1] || "");
        inner = p.get("url") || "";
        sig = p.get("sig") || "";
      }
      if (!_sign) return new Response("not ready: restart degoog after enabling the plugin", { status: 503 });
      // Brave thumbnails can point anywhere, so only follow ones degoog itself signed for a real result
      if (/^https?:\/\/imgs\.search\.brave\.com\//i.test(inner)) {
        const want = new URLSearchParams((_sign(inner).split("?")[1]) || "").get("sig");
        if (!sig || sig !== want) return new Response("unsigned", { status: 403 });
      }
      const w = Math.min(1280, Math.max(160, parseInt(new URL(req.url).searchParams.get("w") || "1280", 10) || 1280));
      const better = upgrade(inner, w); // only as big as the picture is shown, so phones get small files
      if (!better) return new Response("no upgrade", { status: 404 });
      return new Response(null, { status: 302, headers: { Location: _sign(better), "Cache-Control": "public, max-age=86400" } });
    },
  },
];

export default {
  isClientExposed: false,
  name: "Clean Titles & HD Thumbnails",
  description: "Google-style result titles, and sharper news and video thumbnails.",
  trigger: "cleantitles",
  aliases: ["ct"],
  settingsSchema: [
    { key: "showSitelinks", label: "Sitelinks", type: "toggle", default: true, description: "The top result's other pages as links under it." },
    { key: "showDiscussions", label: "Discussions and forums", type: "toggle", default: true, description: "Reddit, Stack Overflow and forum threads from your results in one box." },
    { key: "showVideos", label: "Videos", type: "toggle", default: true, description: "Video results as a row of cards." },
    { key: "showTopStories", label: "Top stories", type: "toggle", default: true, description: "Fresh news cards when your results look like news (one extra News search)." },
    { key: "sites", label: "Sites", type: "list", addLabel: "Add a site", description: "Prefer: moved up, no 2-per-site limit. Lower: moved down. Hide: never shown. Same list as Prefer / Normal / Lower / Hide in each result's menu, kept in degoog's own block and score lists.", itemSchema: [{ key: "site", label: "Site", type: "text", placeholder: "example.com" }, { key: "choice", label: "Choice", type: "select", options: ["prefer", "normal", "lower", "hide"], optionLabels: ["Prefer", "Normal", "Lower", "Hide"], default: "prefer" }] },
    { key: "autoLower", label: "Lower SEO junk automatically", type: "toggle", default: true, description: "Sites that show copy, SEO-bait, stale \"best 20XX\" or AI-written signs on most searches they're in (at least 5) are set to Lower, marked auto in the result menu. Only Lower, never Hide, and your own choice for a site always wins. Keeps only site names and two counts." },
    { key: "learnFromResults", label: "Learn from my search results", type: "toggle", description: "Off: the typo fixer stores and uses nothing about your searches. On: it remembers words and names from your result titles, plus the Did you mean fixes you tap or turn down (kept on this server only)." },
  ],
  configure(s) {
    sitesFromSettings(s ? s.sites : undefined);
    SEO_ON = !(s && (s.autoLower === false || s.autoLower === "false"));
    const off = (k) => !!s && (s[k] === false || s[k] === "false");
    SHOW = { sl: !off("showSitelinks"), forum: !off("showDiscussions"), video: !off("showVideos"), news: !off("showTopStories") };
    const on = !!s && (s.learnFromResults === true || s.learnFromResults === "true");
    if (on === LEARN) return;
    LEARN = on;
    if (on) { if (loaded) readLearned(); } else { dirty = false; learned = EMPTY(); }
    _fix.clear();
  },

  init(ctx) {
    // degoog keeps a command's settings under "<folder>-command"
    if (ctx && ctx.id) SID = /-command$/i.test(ctx.id) ? String(ctx.id).toLowerCase() : `${String(ctx.id).toLowerCase()}-command`;
    if (ctx && ctx.dir) DIR = ctx.dir;
    if (ctx && typeof ctx.signProxyUrl === "function") _sign = ctx.signProxyUrl;
    if (ctx && typeof ctx.fetch === "function") _fetch = ctx.fetch;
  },

  // Bridge: the page reaches the routes above through degoog's command address (/api/command),
  // because iPhone content blockers reject /api/plugin/ addresses. "!cleantitles bridge <route> <query string>"
  async execute(args) {
    const m = /^bridge\s+(\w+)\s*([\s\S]*)$/.exec(String(args || ""));
    if (!m) return { title: "Clean Titles & HD Thumbnails", html: INFO_HTML };
    const r = routes.find((x) => x.path === "/" + m[1]);
    if (!r) return { title: "", html: "" };
    const params = new URLSearchParams(m[2].trim());
    const body = params.get("__body");
    params.delete("__body");
    const req = new Request(`http://local/${m[1]}?${params}`, body != null ? { method: "POST", headers: { "Content-Type": "application/json" }, body } : {});
    let out = "";
    try {
      const res = await r.handler(req);
      out = res.status >= 300 && res.status < 400 ? JSON.stringify({ to: res.headers.get("Location") || "" })
        : res.ok && res.status !== 204 ? await res.text() : JSON.stringify({ status: res.status });
    } catch { out = JSON.stringify({ status: 500 }); }
    return { title: "", html: out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") };
  },
};