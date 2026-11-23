& {
$t = "$env:TEMP\ct-new"; New-Item -ItemType Directory -Force $t | Out-Null
[IO.File]::WriteAllText("$t\index.js", @'
import * as fs from "node:fs";
import { createHash } from "node:crypto";

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

// ===== Shared fetch helper: every outside request goes through here (timeout, size cap, never throws) =====
// -> {status, text, etag} or {status: 0} on any failure. 304 when the If-None-Match tag still matches.
export const net = async (url, { etag = "", timeout = 10000, max = 2_000_000, accept = "*/*", headers = {} } = {}) => {
  try {
    const f = _fetch || fetch;
    const r = await f(url, { headers: { Accept: accept, ...headers, ...(etag ? { "If-None-Match": etag } : {}) }, signal: AbortSignal.timeout(timeout), redirect: "follow" });
    if (r.status === 304) return { status: 304, text: "", etag };
    if (!r.ok) return { status: r.status, text: "", etag: "" };
    const text = await r.text();
    if (text.length > max) return { status: 0, text: "", etag: "" };
    return { status: r.status, text, etag: r.headers.get("etag") || "" };
  } catch { return { status: 0, text: "", etag: "" }; }
};

// ===== AI-image sites, Images tab only (laylavish's HUGE AI Blocklist) =====
// Checked once a day; downloaded again only when it changed (ETag). Kept here as ai-images.json; the page keeps a
// copy and hides those sites' pictures on the Images tab before paint. Web results are never touched by it.
const AI_URLS = [
  "https://raw.githubusercontent.com/laylavish/uBlockOrigin-HUGE-AI-Blocklist/main/list_uBlacklist.txt",
  "https://raw.githubusercontent.com/laylavish/uBlockOrigin-HUGE-AI-Blocklist/main/noai_hosts.txt",
  "https://raw.githubusercontent.com/laylavish/uBlockOrigin-HUGE-AI-Blocklist/main/list.txt",
];
// Domains from any of the list's formats: uBlacklist "*://*.x.com/*", hosts "0.0.0.0 x.com", uBlock "||x.com^"
// and href*="x.com" rules, or a bare domain per line. Comments skipped.
export const aiDomains = (text) => {
  const out = new Set();
  const add = (d) => { d = String(d || "").toLowerCase().replace(/^www\./, "").replace(/\.$/, ""); if (plainHost(d) && d.length < 100) out.add(d); };
  for (const raw of String(text || "").split("\n")) {
    const l = raw.trim();
    if (!l || /^[!#\[]/.test(l)) continue;
    let m;
    if ((m = /^\*:\/\/(?:\*\.)?([^/*]+)\/\*?$/.exec(l))) add(m[1]);
    else if ((m = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+(\S+)/.exec(l))) add(m[1]);
    else if ((m = /^\|\|([^\^/$]+)\^/.exec(l))) add(m[1]);
    else if (/href\*?=/.test(l)) { for (const h of l.matchAll(/href\*?=\s*["']?(?:https?:\/\/)?(?:\*\.)?([a-z0-9.-]+\.[a-z]{2,})/gi)) add(h[1]); }
    else if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l)) add(l);
  }
  return [...out].sort();
};
const aiFile = () => `${DIR}/ai-images.json`;
let AIIMG = null;
const readAi = () => { if (AIIMG) return AIIMG; try { const j = JSON.parse(fs.readFileSync(aiFile(), "utf8")); AIIMG = j && Array.isArray(j.list) ? j : { list: [] }; } catch { AIIMG = { list: [] }; } return AIIMG; };
const aiVersion = (list) => { let h = 2166136261; for (const c of list.join(",")) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h.toString(36); };
// One check: kept as is on any failure or on a list that doesn't look like the real one (under 300 domains)
export const aiRefresh = async () => {
  const cur = readAi();
  const urls = cur.url ? [cur.url, ...AI_URLS.filter((u) => u !== cur.url)] : AI_URLS;
  for (const url of urls) {
    const r = await net(url, { etag: url === cur.url ? cur.etag || "" : "", timeout: 20000 });
    if (r.status === 304) { AIIMG = { ...cur, at: Date.now() }; break; }
    if (r.status !== 200) continue;
    const list = aiDomains(r.text);
    if (list.length < 300) continue;
    AIIMG = { url, etag: r.etag, at: Date.now(), v: aiVersion(list), list };
    break;
  }
  if (AIIMG && AIIMG !== cur) try { fs.writeFileSync(aiFile(), JSON.stringify(AIIMG)); } catch {}
  return readAi();
};
let _aiTimer = null;
const aiSchedule = () => {
  if (_aiTimer) return;
  const due = Math.max(60000, (readAi().at || 0) + 86400000 - Date.now());
  _aiTimer = setTimeout(async () => { _aiTimer = null; await aiRefresh(); aiSchedule(); }, Math.min(due, 86400000));
  if (_aiTimer.unref) _aiTimer.unref();
};

// ===== Currency rates: the ECB's euro reference rates (published ~16:00 CET each TARGET working day) =====
// Checked hourly with no request unless a newer publication is due (the last weekday 16:00 Berlin time after the
// stored date), then one conditional GET. Kept in fx.json (rates aren't private); the page gets a copy via /sites.
const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const parseEcb = (xml) => {
  const t = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(String(xml || ""));
  const rates = {};
  for (const m of String(xml || "").matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) { const v = Number(m[2]); if (v > 0 && Number.isFinite(v)) rates[m[1]] = v; }
  return t && Object.keys(rates).length >= 20 && rates.USD ? { date: t[1], rates } : null;
};
// Date (YYYY-MM-DD) of the newest publication that should exist at `now`
export const ecbDue = (now = Date.now()) => {
  const berlin = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return p; };
  for (let ms = now, i = 0; i < 8; i++, ms -= 86400000) {
    const p = berlin(ms);
    if (p.weekday === "Sat" || p.weekday === "Sun") continue;
    if (i === 0 && Number(p.hour) < 16) continue;
    return `${p.year}-${p.month}-${p.day}`;
  }
  return "";
};
const fxFile = () => `${DIR}/fx.json`;
let FX = null;
export const readFx = () => { if (FX) return FX; try { const j = JSON.parse(fs.readFileSync(fxFile(), "utf8")); FX = j && j.rates ? j : { rates: null }; } catch { FX = { rates: null }; } return FX; };
export const fxRefresh = async (now = Date.now()) => {
  const cur = readFx();
  if (cur.date && cur.date >= ecbDue(now)) return cur;
  // A holiday leaves the ECB's date behind what's due: an unchanged answer (304) is fine, ask again next hour
  const r = await net(ECB_URL, { etag: cur.etag || "", timeout: 15000, max: 50000 });
  if (r.status === 200) { const p = parseEcb(r.text); if (p) { FX = { ...p, etag: r.etag }; try { fs.writeFileSync(fxFile(), JSON.stringify(FX)); } catch {} } }
  return readFx();
};
let _fxTimer = null;
const fxSchedule = () => {
  if (_fxTimer) return;
  _fxTimer = setTimeout(async () => { _fxTimer = null; await fxRefresh(); fxSchedule(); }, readFx().rates ? 3600000 : 30000);
  if (_fxTimer.unref) _fxTimer.unref();
};

// ===== Release cycles from endoflife.date, for the answer card ("latest ios", "is windows 10 supported") =====
// Only a product name comes from the page (never the search). Kept in RAM for degoog's result-cache time (TTL_MS),
// so repeat searches have it before the results; gone on restart. Hidden on any failure.
const TTL = (() => { const n = Number.parseInt(process.env.DEGOOG_CACHE_TTL_MS || "", 10); return Number.isFinite(n) && n > 0 ? n : 12 * 3600 * 1000; })();
const EOL_SLUGS = new Set(["ios", "ipados", "macos", "windows", "windows-server", "android", "python", "nodejs", "php", "go", "ruby", "django", "react", "angular", "vue", "ubuntu", "debian", "fedora", "postgresql", "mysql", "mongodb", "redis", "nginx", "kubernetes", "docker-engine", "dotnet", "firefox", "electron", "laravel", "rails", "spring-boot"]);
const _eol = new Map();
const day = (x) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : undefined);
// Either API shape -> [{cycle, releaseDate, eol, latest, latestReleaseDate}] newest first, or null
export const eolCycles = (j) => {
  const v0 = Array.isArray(j) ? j : null;
  const v1 = !v0 && j && j.result && Array.isArray(j.result.releases) ? j.result.releases : null;
  const out = (v0 || v1 || []).slice(0, 60).map((c) => v0
    ? { cycle: String(c.cycle ?? ""), releaseDate: day(c.releaseDate), eol: typeof c.eol === "boolean" ? c.eol : day(c.eol), latest: c.latest != null ? String(c.latest) : undefined, latestReleaseDate: day(c.latestReleaseDate) }
    : { cycle: String(c.name ?? ""), releaseDate: day(c.releaseDate), eol: day(c.eolFrom) || (typeof c.isEol === "boolean" ? c.isEol : undefined), latest: c.latest && c.latest.name != null ? String(c.latest.name) : undefined, latestReleaseDate: c.latest ? day(c.latest.date) : undefined })
    .filter((c) => c.cycle);
  return out.length ? out : null;
};
export const eolFor = async (slug) => {
  if (!EOL_SLUGS.has(slug)) return null;
  const hit = _eol.get(slug);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  let v = null;
  for (const url of [`https://endoflife.date/api/${slug}.json`, `https://endoflife.date/api/v1/products/${slug}/`]) {
    const r = await net(url, { timeout: 4000, max: 500000, accept: "application/json" });
    if (r.status !== 200) continue;
    try { v = eolCycles(JSON.parse(r.text)); } catch { v = null; }
    if (v) break;
  }
  // A failure is remembered for 10 minutes only, so a short outage doesn't hide the answer for half a day
  _eol.set(slug, { t: v ? Date.now() : Date.now() - TTL + 600000, v });
  return v;
};

// ===== Wikidata facts for the answer card =====
// The page sends the fact asked (one of WD) and the subject's name, never the whole search. Subject -> top item
// (wbsearchentities), then only that property (wbgetclaims). RAM cache under a hashed key for TTL_MS.
const WD = { height: "P2048", population: "P1082", born: "P569", age: "P569", died: "P570", founded: "P571", ceo: "P169", released: "P577", distance: "P625" };
const WD_API = "https://www.wikidata.org/w/api.php";
const WD_UA = { "User-Agent": "degoog-clean-titles/50 (self-hosted search; one lookup per search)" };
const wdGet = async (params) => {
  const r = await net(`${WD_API}?${new URLSearchParams({ ...params, format: "json" })}`, { timeout: 3000, max: 2_000_000, accept: "application/json", headers: WD_UA });
  if (r.status !== 200) return null;
  try { return JSON.parse(r.text); } catch { return null; }
};
const rankOrder = { preferred: 0, normal: 1 };
// Claims -> best ones first: preferred rank, still current (no end time), newest "point in time"
export const wdBest = (claims) => (Array.isArray(claims) ? claims : [])
  .filter((c) => c && c.rank !== "deprecated" && c.mainsnak && c.mainsnak.snaktype === "value" && c.mainsnak.datavalue)
  .map((c) => ({ c, r: rankOrder[c.rank] ?? 1, ended: !!(c.qualifiers && c.qualifiers.P582), at: (c.qualifiers && c.qualifiers.P585 && c.qualifiers.P585[0].datavalue && c.qualifiers.P585[0].datavalue.value.time) || "" }))
  .sort((a, b) => a.r - b.r || a.ended - b.ended || (b.at > a.at ? 1 : b.at < a.at ? -1 : 0))
  .map((x) => x.c);
const wdValue = (c) => {
  const v = c.mainsnak.datavalue.value;
  if (v && typeof v === "object" && "amount" in v) return { amount: v.amount, unit: String(v.unit || "").split("/").pop(), asOf: c.qualifiers && c.qualifiers.P585 ? c.qualifiers.P585[0].datavalue.value.time : undefined };
  if (v && typeof v === "object" && "time" in v) return { time: v.time, prec: v.precision };
  if (v && typeof v === "object" && "latitude" in v) return { lat: v.latitude, lon: v.longitude };
  if (v && typeof v === "object" && v["entity-type"] === "item") return { id: v.id };
  if (typeof v === "string") return v;
  return null;
};
const wdOne = async (name, prop) => {
  const s = await wdGet({ action: "wbsearchentities", search: name, language: "en", uselang: "en", type: "item", limit: "1" });
  const hit = s && Array.isArray(s.search) && s.search[0];
  if (!hit || !hit.id) return null;
  const props = prop === "P569" ? ["P569", "P570"] : [prop];
  const got = await Promise.all(props.map((p) => wdGet({ action: "wbgetclaims", entity: hit.id, property: p })));
  const vals = wdBest(got[0] && got[0].claims && got[0].claims[prop]).map(wdValue).filter(Boolean).slice(0, 1);
  if (!vals.length) return null;
  const out = { label: hit.label || name, desc: hit.description || "", v: vals };
  if (props[1]) { const d = wdBest(got[1] && got[1].claims && got[1].claims.P570).map(wdValue).filter(Boolean)[0]; if (d && d.time) out.died = d.time; }
  // CEO is another item: its name
  if (vals[0].id) {
    const e = await wdGet({ action: "wbgetentities", ids: vals[0].id, props: "labels", languages: "en" });
    const l = e && e.entities && e.entities[vals[0].id] && e.entities[vals[0].id].labels && e.entities[vals[0].id].labels.en;
    if (!l || !l.value) return null;
    out.v = [{ label: l.value }];
  }
  return out;
};
const _wd = new Map();
export const wdFor = async (fact, s, s2) => {
  const prop = WD[fact];
  s = String(s || "").trim().slice(0, 80); s2 = String(s2 || "").trim().slice(0, 80);
  if (!prop || s.length < 2 || (fact === "distance" && s2.length < 2)) return null;
  const key = createHash("sha256").update(`${fact}\n${s}\n${s2}`).digest("hex").slice(0, 24);
  const hit = _wd.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  let v = await wdOne(s, prop);
  if (v && fact === "distance") { const b = await wdOne(s2, prop); v = b ? { ...v, b } : null; }
  if (_wd.size > 1000) _wd.clear();
  _wd.set(key, { t: v ? Date.now() : Date.now() - TTL + 600000, v });
  return v;
};

// ===== CMU course data (ScottyLabs' public CMU Courses API, no login) =====
// One course at a time, when a course number is searched; kept in this plugin's folder until the next semester's
// course evaluations can exist (boundaries Jan 1 / Jun 1 / Sep 1), so most searches cost nothing.
const CMU_API = "https://course.apis.scottylabs.org";
const semStart = (now) => { const d = new Date(now), y = d.getUTCFullYear(); return [Date.UTC(y, 8, 1), Date.UTC(y, 5, 1), Date.UTC(y, 0, 1), Date.UTC(y - 1, 8, 1)].find((t) => t <= now); };
const _cmu = new Map();
export const cmuFor = async (id, now = Date.now()) => {
  if (!/^\d{2}-\d{3}$/.test(id)) return null;
  const hit = _cmu.get(id);
  if (hit && hit.t >= semStart(now) && (hit.v || now - hit.t < 86400000)) return hit.v;
  const file = `${DIR}/cmu-${id}.json`;
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j && j.t >= semStart(now) && j.v) { _cmu.set(id, j); return j.v; } } catch {}
  const get = async (path) => { const r = await net(`${CMU_API}${path}`, { timeout: 4000, max: 3_000_000, accept: "application/json" }); if (r.status !== 200) return undefined; try { return JSON.parse(r.text); } catch { return undefined; } };
  const [c, f] = await Promise.all([get(`/course/${id}`), get(`/fces?courseID=${id}`)]);
  const course = c && (c.course || c);
  const fces = Array.isArray(f) ? f : f && Array.isArray(f.fces) ? f.fces : [];
  let v = null;
  if (course && typeof course === "object" && (course.name || course.title)) {
    v = { course: { name: String(course.name || course.title), units: course.units != null ? String(course.units) : "", prereqs: String(course.prereqString || course.prereqs || "") }, fces: fces.slice(0, 400).map((r) => ({ year: r.year, semester: r.semester, instructor: r.instructor, numRespondents: r.numRespondents, responseRate: r.responseRate, hrsPerWeek: r.hrsPerWeek, rating: Array.isArray(r.rating) ? r.rating.slice(0, 10) : [], location: r.location })) };
  }
  const e = { t: now, v };
  _cmu.set(id, e);
  if (v) try { fs.writeFileSync(file, JSON.stringify(e)); } catch {}
  return v;
};

// ===== Knowledge panel data (Wikidata + Wikipedia), server part =====
// Asked at page load for entity-like searches; the page shows it only when the results include the same Wikipedia
// article (spec 3). Facts per type from the item's own "instance of" (P31) values, no subclass walking.
const KP_TYPES = [
  ["person", ["Q5"], [["Born", "P569"], ["Died", "P570"], ["Occupation", "P106", 2]]],
  ["place", ["Q515", "Q1093829", "Q5119", "Q486972", "Q1549591", "Q3957", "Q532", "Q6256", "Q35657", "Q15284"], [["Country", "P17"], ["Population", "P1082"], ["Area", "P2046"]]],
  ["company", ["Q4830453", "Q6881511", "Q783794", "Q891723", "Q43229", "Q167037"], [["Founded", "P571"], ["CEO", "P169"], ["Headquarters", "P159"], ["Founders", "P112", 2]]],
  ["structure", ["Q41176", "Q811979", "Q12518", "Q12280", "Q570116", "Q2319498", "Q839954"], [["Location", "P131"], ["Height", "P2048"], ["Opened", "P1619"], ["Built", "P571"], ["Architect", "P84"]]],
  ["film", ["Q11424", "Q5398426"], [["Released", "P577"], ["Director", "P57"], ["Running time", "P2047"]]],
  ["language", ["Q9143"], [["Designed by", "P287"], ["First appeared", "P571"], ["Latest version", "P348"]]],
  ["animal", ["Q16521"], [["Conservation status", "P141"]]],
];
// entity JSON (wbgetentities) -> {type, rows: [{k, prop, vals: [wdValue...], max}], image, title}
export const kpPlan = (ent) => {
  const cl = (ent && ent.claims) || {};
  const p31 = wdBest(cl.P31).map(wdValue).filter((v) => v && v.id).map((v) => v.id);
  const t = KP_TYPES.find(([, ids]) => p31.some((x) => ids.includes(x)));
  const rows = [];
  for (const [k, prop, max = 1] of t ? t[2] : []) {
    const vals = wdBest(cl[prop]).map(wdValue).filter(Boolean).slice(0, max);
    if (vals.length) rows.push({ k, prop, vals, max });
  }
  const img = wdBest(cl.P18).map((c) => c.mainsnak.datavalue.value).find((x) => typeof x === "string");
  const title = ent && ent.sitelinks && ent.sitelinks.enwiki && ent.sitelinks.enwiki.title;
  return { type: t ? t[0] : "", rows, image: img || "", title: title || "" };
};
const UNIT_NAME = { Q11573: ["m", 1], Q712226: ["km²", 1], Q25343: ["m²", 1e-6], Q7727: ["min", 1], Q174728: ["cm", 1] };
// One fact's text (labels: {Qid: name}); dates as written, "as of" for population, imperial next to metric
export const kpText = (row, labels) => row.vals.map((v) => {
  if (v.id) return labels[v.id] || "";
  if (v.time) { const m = /^([+-]\d+)-(\d{2})-(\d{2})/.exec(v.time); if (!m) return ""; const y = Number(m[1]); if (v.prec <= 9 || m[2] === "00") return String(y); const d = new Date(Date.UTC(2000, +m[2] - 1, +m[3] || 1)); return v.prec === 10 || m[3] === "00" ? `${d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })} ${y}` : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${y}`; }
  if (v.amount != null) {
    const n = Number(v.amount);
    if (!Number.isFinite(n)) return "";
    if (row.prop === "P1082") return `${Math.round(n).toLocaleString("en-US")}${v.asOf ? ` (${String(v.asOf).slice(1, 5)})` : ""}`;
    const u = UNIT_NAME[v.unit];
    if (row.prop === "P2048" && u && u[0] === "m") return `${n.toLocaleString("en-US")} m (${Math.round(n / 0.3048).toLocaleString("en-US")} ft)`;
    if (row.prop === "P2046" && u) { const km2 = u[0] === "km²" ? n : n * u[1]; return `${km2.toLocaleString("en-US", { maximumFractionDigits: 1 })} km² (${(km2 / 2.589988).toLocaleString("en-US", { maximumFractionDigits: 1 })} sq mi)`; }
    if (row.prop === "P2047" && u && u[0] === "min") return `${n} min`;
    return u ? `${n.toLocaleString("en-US")} ${u[0]}` : n.toLocaleString("en-US");
  }
  if (typeof v === "string") return v;
  return "";
}).filter(Boolean).join(", ");
const _kp = new Map();
export const kpFor = async (q) => {
  const name = String(q || "").trim().slice(0, 80);
  if (name.length < 2) return null;
  const key = createHash("sha256").update(`kp\n${name.toLowerCase()}`).digest("hex").slice(0, 24);
  const hit = _kp.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  let v = null;
  try {
    const s = await wdGet({ action: "wbsearchentities", search: name, language: "en", uselang: "en", type: "item", limit: "1" });
    const h = s && Array.isArray(s.search) && s.search[0];
    const e = h && h.id && await wdGet({ action: "wbgetentities", ids: h.id, props: "claims|sitelinks", sitefilter: "enwiki" });
    const ent = e && e.entities && e.entities[h.id];
    if (ent) {
      const plan = kpPlan(ent);
      if (plan.title) {
        const ids = [...new Set(plan.rows.flatMap((r) => r.vals.filter((x) => x.id).map((x) => x.id)))].slice(0, 20);
        const [lab, sum] = await Promise.all([
          ids.length ? wdGet({ action: "wbgetentities", ids: ids.join("|"), props: "labels", languages: "en" }) : null,
          net(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(plan.title.replace(/ /g, "_"))}`, { timeout: 3000, max: 200000, accept: "application/json", headers: WD_UA }),
        ]);
        const labels = {};
        for (const id of ids) { const l = lab && lab.entities && lab.entities[id] && lab.entities[id].labels && lab.entities[id].labels.en; if (l) labels[id] = l.value; }
        let sj = null;
        try { sj = sum.status === 200 ? JSON.parse(sum.text) : null; } catch {}
        const facts = plan.rows.map((r) => ({ k: r.k, v: kpText(r, labels) })).filter((f) => f.v);
        const photo = plan.image ? `https://commons.wikimedia.org/w/index.php?title=Special:FilePath/${encodeURIComponent(plan.image)}&width=330` : sj && sj.thumbnail && sj.thumbnail.source || "";
        v = { qid: h.id, title: plan.title, name: h.label || plan.title, type: plan.type, desc: h.description || (sj && sj.description) || "", extract: sj && typeof sj.extract === "string" ? sj.extract : "", facts, photo: photo && _sign ? _sign(photo) : "" };
      }
    }
  } catch { v = null; }
  if (_kp.size > 1000) _kp.clear();
  _kp.set(key, { t: v ? Date.now() : Date.now() - TTL + 600000, v });
  return v;
};

// ===== Sports (ESPN's public site API): a team's live, last or next game =====
// Team names come from ESPN's team lists (fetched once a day, only when a short search could be a team), so the
// search itself never leaves this server; a match costs one schedule request (RAM 60 s while live, else 10 min).
const ESPN = "https://site.api.espn.com/apis/site/v2/sports";
const LEAGUES = [["football/nfl", "NFL"], ["basketball/nba", "NBA"], ["baseball/mlb", "MLB"], ["hockey/nhl", "NHL"]];
let _teams = { t: 0, list: [] };
const normT = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
export const espnTeams = (j, league, tag) => {
  const ts = j && j.sports && j.sports[0] && j.sports[0].leagues && j.sports[0].leagues[0] && j.sports[0].leagues[0].teams;
  return (Array.isArray(ts) ? ts : []).map((x) => x && x.team).filter((t) => t && t.id && t.displayName)
    .map((t) => ({ id: String(t.id), league, tag, abbr: String(t.abbreviation || ""), name: String(t.displayName), nick: String(t.name || t.shortDisplayName || ""), place: String(t.location || "") }));
};
const teamsList = async () => {
  if (_teams.list.length && Date.now() - _teams.t < 86400000) return _teams.list;
  const all = await Promise.all(LEAGUES.map(async ([l, tag]) => { const r = await net(`${ESPN}/${l}/teams`, { timeout: 4000, max: 3_000_000, accept: "application/json" }); try { return r.status === 200 ? espnTeams(JSON.parse(r.text), l, tag) : []; } catch { return []; } }));
  const list = all.flat();
  _teams = { t: list.length ? Date.now() : Date.now() - 86400000 + 600000, list: list.length ? list : _teams.list };
  return _teams.list;
};
// "steelers", "pittsburgh steelers score", "steelers game", "lakers last night", "penguins nhl" -> one team, or null
export const teamFor = (q, list) => {
  let s = normT(q).replace(/\b(score|scores|game|games|schedule|result|results|today|tonight|last night|yesterday|next game|live)\b/g, " ").replace(/\s+/g, " ").trim();
  const lg = /\b(nfl|nba|mlb|nhl)\b/.exec(s);
  if (lg) s = s.replace(lg[0], "").trim();
  if (!s || s.split(" ").length > 4) return null;
  const hits = list.filter((t) => (!lg || t.tag.toLowerCase() === lg[1]) && [t.name, t.nick, `${t.place} ${t.nick}`].map(normT).includes(s));
  return hits.length === 1 ? hits[0] : null;
};
const scoreOf = (c) => (c && c.score != null ? (typeof c.score === "object" ? String(c.score.displayValue ?? c.score.value ?? "") : String(c.score)) : "");
// One schedule event -> the card's data
export const espnGame = (ev, sign) => {
  const comp = ev && Array.isArray(ev.competitions) && ev.competitions[0];
  if (!comp || !Array.isArray(comp.competitors) || comp.competitors.length !== 2) return null;
  const st = (comp.status || ev.status || {}).type || {};
  const side = (c) => ({ abbr: String((c.team && c.team.abbreviation) || ""), name: String((c.team && (c.team.shortDisplayName || c.team.displayName)) || ""), logo: (() => { const t = c.team || {}; const l = t.logo || (Array.isArray(t.logos) && t.logos[0] && t.logos[0].href) || ""; return l && sign ? sign(l) : ""; })(), score: scoreOf(c), winner: c.winner === true, record: Array.isArray(c.record) ? String((c.record[0] && (c.record[0].displayValue || c.record[0].summary)) || "") : Array.isArray(c.records) ? String((c.records[0] && c.records[0].summary) || "") : "", home: c.homeAway === "home" });
  const [a, b] = comp.competitors.map(side);
  return { state: String(st.state || ""), detail: String(st.shortDetail || st.detail || ""), date: String(ev.date || comp.date || ""), away: a.home ? b : a, home: a.home ? a : b };
};
// Live game first; else the last game if it ended within 2 days; else the next one; else the last one
export const pickGame = (events, now = Date.now()) => {
  const evs = (Array.isArray(events) ? events : []).map((e) => ({ e, st: ((((e.competitions || [])[0] || {}).status || e.status || {}).type || {}).state, t: Date.parse(e.date) })).filter((x) => Number.isFinite(x.t));
  const live = evs.find((x) => x.st === "in");
  if (live) return live.e;
  const past = evs.filter((x) => x.st === "post").sort((a, b) => b.t - a.t)[0];
  const next = evs.filter((x) => x.st === "pre" && x.t >= now - 6 * 3600000).sort((a, b) => a.t - b.t)[0];
  if (past && now - past.t < 2 * 86400000) return past.e;
  return (next || past || {}).e || null;
};
const _games = new Map();
export const sportsFor = async (q, now = Date.now()) => {
  const words = normT(q);
  if (!words || words.split(" ").length > 6) return null;
  const list = await teamsList();
  const t = teamFor(words, list);
  if (!t) return null;
  const hit = _games.get(t.id + t.league);
  if (hit && now - hit.t < (hit.v && hit.v.state === "in" ? 60000 : 600000)) return hit.v;
  const r = await net(`${ESPN}/${t.league}/teams/${t.id}/schedule`, { timeout: 4000, max: 5_000_000, accept: "application/json" });
  let v = null;
  try { const ev = r.status === 200 ? pickGame(JSON.parse(r.text).events, now) : null; const g = ev && espnGame(ev, _sign); if (g) v = { ...g, league: t.tag, team: t.abbr }; } catch {}
  _games.set(t.id + t.league, { t: now, v });
  return v;
};

// ===== Will ai-summary answer? (so the page reserves its spot only when the summary is sure to come) =====
// Mirrors its slot trigger(): a model is set, it isn't switched off, and "only for questions" (a search ending in
// "?") if that's on. Read from degoog's plugin-settings.json; only these two yes/no values leave the server.
export const aiStatus = (data) => {
  try {
    const all = JSON.parse(fs.readFileSync(process.env.DEGOOG_PLUGIN_SETTINGS_FILE || `${data}/plugin-settings.json`, "utf8"));
    const a = all && all["ai-summary-slot"];
    const yes = (v) => v === true || v === "true";
    if (!a || !String(a.model || "").trim() || yes(a.disabled)) return { on: false };
    return { on: true, qmark: yes(a.questionMarkOnly) };
  } catch { return { on: false }; }
};

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
      return new Response(JSON.stringify({ sites, auto: autoList().filter((d) => sites[d] === "lower"), seo: SEO_ON, ai: aiStatus(data), fx: readFx().rates ? { date: FX.date, rates: FX.rates } : null }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  },
  {
    method: "get",
    path: "/wd",
    async handler(req) {
      const u = new URL(req.url).searchParams;
      const d = await wdFor(u.get("f") || "", u.get("s") || "", u.get("s2") || "");
      return new Response(JSON.stringify({ d }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  },
  {
    method: "get",
    path: "/kp",
    async handler(req) {
      const q = (new URL(req.url).searchParams.get("q") || "").slice(0, 100);
      return new Response(JSON.stringify({ kp: await kpFor(q) }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  },
  {
    method: "get",
    path: "/sports",
    async handler(req) {
      const q = (new URL(req.url).searchParams.get("q") || "").slice(0, 100);
      return new Response(JSON.stringify({ g: await sportsFor(q) }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  },
  {
    method: "get",
    path: "/cmu",
    async handler(req) {
      const id = (new URL(req.url).searchParams.get("id") || "").replace(/^(\d{2})(\d{3})$/, "$1-$2");
      return new Response(JSON.stringify({ c: await cmuFor(id) }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  },
  {
    method: "get",
    path: "/eol",
    async handler(req) {
      const p = (new URL(req.url).searchParams.get("p") || "").toLowerCase();
      const cycles = await eolFor(p);
      return new Response(JSON.stringify({ cycles }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  },
  {
    // AI-image sites for the Images tab: the whole list only when the page's copy (v) is out of date
    method: "get",
    path: "/aiimg",
    handler(req) {
      const a = readAi(), v = new URL(req.url).searchParams.get("v") || "";
      const body = !a.list.length ? { v: "" } : v === a.v ? { v } : { v: a.v, list: a.list };
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
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
    if (!process.env.CT_NO_TIMERS) { aiSchedule(); fxSchedule(); }
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
'@)
[IO.File]::WriteAllText("$t\script.js", @'
// clean-titles v50-preview
const CT = (() => {
// clean-titles core: pure functions (no DOM), shared by the page script and the tests.
// Everything here runs synchronously before first paint, so it only uses data already in the page.

// ===== Sites: registrable domain via the public suffix list =====
// The list arrives compiled as a tree string (reversed labels): "uk(co,org,...),jp(ac,...)", "!" = also a rule itself
const pslParse = (enc) => {
  const root = {}, stack = [];
  let name = "", cur = root, last = null;
  // Small hand parser: one pass, no regex backtracking
  for (let i = 0; i <= enc.length; i++) {
    const ch = enc[i];
    if (ch === undefined || ch === "," || ch === "(" || ch === ")") {
      if (name) {
        const also = name.endsWith("!"), k = also ? name.slice(0, -1) : name;
        const n = cur[k] || (cur[k] = {});
        if (ch !== "(" || also) n.$ = 1;
        last = n;
        name = "";
      }
      if (ch === "(") { stack.push(cur); cur = last; }
      else if (ch === ")") cur = stack.pop();
    } else name += ch;
  }
  return root;
};
// Rules: plain, "*" wildcard, "!" exception (stored as key "!x"). Default rule "*": the last label is the suffix.
const regDomain = (host, psl) => {
  host = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return host;
  // No list (the static file failed to load): the host itself, minus www./m. - never guess a suffix, since the bare
  // default rule would make "co.uk" one site
  if (!psl) return host.replace(/^(?:www\d?|m)\./, "");
  const L = host.split(".");
  let n = psl, sfx = 1; // number of labels in the longest matching suffix
  for (let i = L.length - 1, d = 1; i >= 0 && n; i--, d++) {
    const lab = L[i];
    if (n["!" + lab]) { sfx = d - 1; break; }
    const next = n[lab] || n["*"];
    if (!next) break;
    if (next.$) sfx = d;
    n = next;
  }
  return sfx >= L.length ? host : L.slice(L.length - sfx - 1).join(".");
};

// ===== Dedupe: one key per document =====
// Hosts that are another site's copy or mirror, mapped to the original
const WIKI_MIRROR = /^(?:www\.)?(?:wikiwand\.com|wikipedia\.com|wiki2\.org|wikizero\.com|db0nus869y26v\.cloudfront\.net|everybodywiki\.com|en\.wikibrief\.org|newworldencyclopedia\.org)$/;
const SHORT = { "apple.co": "apple.com", "youtu.be": "youtube.com", "redd.it": "reddit.com", "amzn.to": "amazon.com", "amzn.eu": "amazon.com" };
const shortTarget = (host) => SHORT[host] || "";
// Locale path segments ("/en-us/", "/de_DE/", "/ja/") on sites that publish one page per locale
const LOCALE_SEG = /^(?:[a-z]{2}(?:[-_][a-z]{2,4})?|[a-z]{2}-[a-z]{4}(?:-[a-z]{2})?)$/i;
const LOCALE_SITES = /(^|\.)(apple\.com|microsoft\.com|mozilla\.org|developer\.mozilla\.org|learn\.microsoft\.com|docs\.github\.com|cloud\.google\.com|developer\.android\.com|docs\.aws\.amazon\.com|nextjs\.org|vuejs\.org|kotlinlang\.org|docs\.python\.org)$/;
// Wikipedia article key, from any mirror or form: "wiki:<lang>:<title>" (simple. counts as en)
const wikiKey = (h, path, sp) => {
  let m = /^(?:([a-z-]{2,12})\.)?(?:m\.)?wikipedia\.(?:org|com)$/.exec(h);
  let lang = m ? m[1] || "en" : "", title = "";
  if (m) {
    if (lang === "www") lang = "en";
    if (lang === "simple") lang = "en";
    const t = /^\/wiki\/(.+)$/.exec(path);
    title = t ? t[1] : sp.get("title") || "";
  } else if (/^(?:www\.)?wikiwand\.com$/.test(h)) {
    const t = /^\/([a-z-]{2,12})\/(?:articles\/)?(.+)$/.exec(path) || [null, "en", path.slice(1)];
    lang = t[1]; title = t[2];
  } else if (WIKI_MIRROR.test(h)) {
    const t = /^\/(?:wiki|entry|en\/wiki)\/(.+)$/.exec(path);
    if (!t) return "";
    lang = "en"; title = t[1];
  } else return "";
  if (!title) return "";
  try { title = decodeURIComponent(title); } catch {}
  title = title.replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return title ? `wiki:${lang}:${title}` : "";
};
// arXiv paper key: abs/pdf/html, any version, ar5iv and export mirrors -> "arxiv:<id>" (version kept separately)
const arxivId = (h, path) => {
  if (!/(^|\.)(arxiv\.org|ar5iv\.org|ar5iv\.labs\.arxiv\.org|alphaxiv\.org)$/.test(h)) return null;
  const m = /^\/(?:abs|pdf|html|papers?|overview)\/((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)?(?:\.pdf)?\/?$/i.exec(path);
  return m ? { id: m[1].toLowerCase(), v: m[2] ? Number(m[2].slice(1)) : 0, kind: /^\/pdf\//.test(path) ? "PDF" : /^\/html\//.test(path) || /ar5iv/.test(h) ? "HTML" : "abs" } : null;
};
// Pagination and comment pages that belong to the same article
// (a bare "/2" counts only after a word-like segment: "/my-article/2", never "/2" or "/2024/11")
const PAGE_TAIL = /\/(?:page|comment-page|p)-?\d+\/?$|\/(?:page|comments?|amp|all|print)\/?\d*\/?$|(?<=\/[a-z][^/]*[a-z][^/]*)\/\d{1,2}\/?$/i;
const DROP_PARAMS = /^(page|p|pg|start|comments?|cpage|amp|output|view|print|lang|hl|locale|ref|src|from|utm_\w+|fbclid|gclid|share|s|sh|via)$/i;
const docKey = (raw) => {
  let u;
  try { u = new URL(raw); } catch { return String(raw || ""); }
  let h = u.hostname.toLowerCase().replace(/^(?:www\d?|m|mobile|amp|old|new)\./, "");
  if (SHORT[h]) h = SHORT[h];
  const path0 = u.pathname.replace(/\/+$/, "") || "/";
  const w = wikiKey(u.hostname.toLowerCase(), u.pathname, u.searchParams);
  if (w) return w;
  const ax = arxivId(h, u.pathname);
  if (ax) return `arxiv:${ax.id}`;
  // *.react.dev language mirrors (es.react.dev, zh-hans.react.dev) are react.dev
  if (/\.react\.dev$/.test(h)) h = "react.dev";
  let segs = path0.split("/").filter(Boolean);
  if (LOCALE_SITES.test(h)) {
    segs = segs.filter((s, i) => !(i < 2 && LOCALE_SEG.test(s) && !/^(kb|api|docs|en)$/i.test(s) || (i < 2 && /^(en|kb)$/i.test(s))));
    // Apple support: /kb/HT201295, /en-us/HT201295 and /HT201295 are one article
  }
  let path = "/" + segs.join("/");
  path = path.replace(PAGE_TAIL, "").replace(/\.amp(?:\.html)?$|\/amp$/i, "").replace(/\/index\.(?:html?|php)$/i, "").replace(/\/+$/, "") || "/";
  const keep = [...u.searchParams].filter(([k]) => !DROP_PARAMS.test(k)).sort(([a], [b]) => (a < b ? -1 : 1));
  const qs = keep.length ? "?" + keep.map(([k, v]) => `${k}=${v}`).join("&") : "";
  return `${h}${path.toLowerCase()}${qs}`;
};
// Title for same-title comparisons: lowercase words only, site-name tail and "(page 2)" style bits dropped
const titleKey = (t) => String(t || "").toLowerCase()
  .replace(/\s*[|–—·:-]\s*(?:page|part)\s*\d+(?:\s*of\s*\d+)?\s*$/, "").replace(/\((?:page|part)\s*\d+\)/g, "")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Merge results: same document key, then same title within the same site. Input: [{url, title, ...}] in rank
// order. Output: kept items (first = best ranked), each with .alts = [{url, label}] for its other versions.
// Incremental form (endless scroll adds pages to the same search): add(item) -> {rec} for a new document,
// {dup: rec} for another copy of one already kept
const deduper = (psl) => {
  const byKey = new Map(), byTitle = new Map();
  return (it) => {
    let host = "";
    try { host = new URL(it.url).hostname.toLowerCase(); } catch {}
    const site = regDomain(SHORT[host.replace(/^www\./, "")] || host, psl);
    const k = docKey(it.url);
    const tk = titleKey(it.title);
    // 12+ characters: shorter titles ("Home", "Login") repeat across unrelated pages of one site
    const tkey = tk.length >= 12 ? `${site} ${tk}` : "";
    const hit = byKey.get(k) || (tkey && byTitle.get(tkey));
    if (hit) { addAlt(hit, it); return { dup: hit }; }
    const rec = { ...it, site, key: k, alts: [] };
    byKey.set(k, rec);
    if (tkey) byTitle.set(tkey, rec);
    return { rec };
  };
};
const dedupe = (items, psl) => {
  const add = deduper(psl), out = [];
  for (const it of items) { const r = add(it); if (r.rec) out.push(r.rec); }
  for (const r of out) r.alts = altLabels(r);
  return out;
};
const addAlt = (rec, it) => { (rec._m || (rec._m = [])).push(it); };
// Extra versions shown as small links: "PDF · HTML · v7 latest" (papers); other merged copies add nothing
const altLabels = (r) => {
  const all = [r, ...(r._m || [])];
  delete r._m;
  if (!r.key.startsWith("arxiv:")) return [];
  let host = "";
  const info = all.map((x) => { try { const u = new URL(x.url); host = u.hostname.replace(/^www\./, ""); return { x, a: arxivId(host, u.pathname) }; } catch { return null; } }).filter((y) => y && y.a);
  const id = r.key.slice(6), labs = [], seen = new Set([info[0] && info[0].a.kind]);
  for (const kind of ["PDF", "HTML"]) if (!seen.has(kind)) { seen.add(kind); labs.push({ label: kind, url: kind === "PDF" ? `https://arxiv.org/pdf/${id}` : `https://arxiv.org/html/${id}` }); }
  const vmax = Math.max(0, ...info.map((y) => y.a.v));
  const shownV = info[0] ? info[0].a.v : 0;
  if (vmax > 1 && shownV && shownV < vmax) labs.push({ label: `v${vmax} latest`, url: `https://arxiv.org/abs/${id}` });
  return labs;
};

// ===== Site cap: 2 per site, the rest folded =====
// Returns {shown, folds: Map(site -> [items])}. Lifts for a site the search names ("site:x", "reddit", "apple support")
const namedSites = (q, psl) => {
  const s = new Set();
  const m = /(?:^|\s)site:(\S+)/i.exec(q);
  if (m) s.add(regDomain(m[1].replace(/^https?:\/\//, "").replace(/\/.*$/, ""), psl));
  return { set: s, words: new Set(String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3)) };
};
// Search words that name a site without being its domain's first label (seen in the recorded searches
// "mdn array map", "npm lodash", "pip requests")
const SITE_WORD = { mdn: "mozilla.org", npm: "npmjs.com", pip: "pypi.org", pypi: "pypi.org" };
const siteNamed = (site, named) => named.set.has(site) || named.words.has(site.split(".")[0]) || [...named.words].some((w) => SITE_WORD[w] === site);
const capSites = (items, q, psl, cap = 2) => {
  const named = namedSites(q, psl), n = new Map(), shown = [], folds = new Map();
  for (const it of items) {
    const k = it.site;
    const c = n.get(k) || 0;
    n.set(k, c + 1);
    if (c < cap || siteNamed(k, named)) shown.push(it);
    else { if (!folds.has(k)) folds.set(k, []); folds.get(k).push(it); }
  }
  return { shown, folds };
};

// ===== One page of results, planned before paint =====
// The page script applies the plan; it keeps no logic of its own. ctx lives for one search (endless scroll pages
// reuse it): listCtx(q, psl, prefs) with prefs = {site: "prefer" | "lower" | "hide"} (missing = normal).
const listCtx = (q, psl, prefs = {}) => ({ add: deduper(psl), named: namedSites(q, psl), count: new Map(), prefs, cap: 2 });
const WEIGHT = { prefer: 0, lower: 2 };
// items: [{url, title, ...}] in page order. Returns {shown, dups, hidden (Hide pref), capped (past the cap with no
// result of that site on this page), folds: Map(site -> {after, items})}.
// Order: dedupe -> site prefs (Hide drops, Prefer up, Lower down, within this page) -> 2 per site, rest folded
const planPage = (items, ctx) => {
  const recs = [], dups = [], hidden = [], capped = [];
  for (const it of items) { const r = ctx.add(it); if (r.rec) recs.push(r.rec); else dups.push(it); }
  for (const r of recs) r.alts = altLabels(r);
  const kept = recs.filter((r) => (ctx.prefs[r.site] === "hide" ? (hidden.push(r), false) : true));
  const w = (r) => WEIGHT[ctx.prefs[r.site]] ?? 1;
  kept.sort((a, b) => w(a) - w(b)); // stable: rank order kept inside each group
  const shown = [], folds = new Map();
  for (const r of kept) {
    const c = ctx.count.get(r.site) || 0;
    ctx.count.set(r.site, c + 1);
    if (c < ctx.cap || ctx.prefs[r.site] === "prefer" || siteNamed(r.site, ctx.named)) { shown.push(r); continue; }
    // Folds only under a result of the same page: one placed on an earlier page would push down what's on screen
    const lastHere = [...shown].reverse().find((x) => x.site === r.site);
    if (!lastHere) { capped.push(r); continue; }
    if (!folds.has(r.site)) folds.set(r.site, { after: lastHere, items: [] });
    folds.get(r.site).items.push(r);
  }
  return { shown, dups, hidden, capped, folds };
};

// ===== Sites: Prefer / Normal / Lower / Hide, stored in degoog's own lists =====
// Hide = a line in domainBlockList; Prefer / Lower = "domain|N" in domainScoreList (N added to each result's score
// on the server, where a top result scores about 60). So degoog applies them itself on every tab, before render.
const SITE_SCORE = { prefer: 40, lower: -40, normal: 0 };
const plainHost = (l) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l);
// The lists' text -> {domain: "hide" | "prefer" | "lower"} (regex and uBlock lines are degoog's business; Hide wins)
const sitesFromLists = (block = "", score = "") => {
  const out = {};
  for (const raw of String(score).split("\n")) {
    const [d, n] = raw.split("|").map((x) => (x || "").trim());
    const v = Number(n);
    if (d && plainHost(d) && n && Number.isFinite(v) && v !== 0) out[d.toLowerCase()] = v > 0 ? "prefer" : "lower";
  }
  for (const raw of String(block).split("\n")) { const d = raw.trim().toLowerCase(); if (plainHost(d)) out[d] = "hide"; }
  return out;
};
// Block list without this site's own line (other lines, comments and patterns untouched)
const unblockText = (block, domain) => {
  const d = String(domain).toLowerCase();
  return String(block || "").split("\n").filter((l) => { const t = l.trim().toLowerCase(); return t !== d && t !== `www.${d}`; }).join("\n");
};

// ===== Anti-SEO: signs on one search's web results (the server adds them up per site) =====
// Essay-writing services (contract cheating). From well-known names, not a fetched list.
const CHEAT_SITES = new Set(["ukessays.com", "essaypro.com", "edubirdie.com", "papersowl.com", "studybay.com", "99papers.com", "grademiners.com", "essayshark.com", "writemypaper4me.org", "myassignmenthelp.com", "paperhelp.org", "speedypaper.com", "essaywriter.org", "ivoryresearch.com", "assignmentexpert.com"]);
const SEO_BAIT = /\b(?:search volume|keyword difficulty|monthly searches|cpc (?:of|is)|related keywords|keyword ideas for|people also search for|searches per month)\b/i;
// Phrases that mostly come from text generators; a strong one alone counts, else it takes two
const AI_STRONG = /\b(?:as an ai(?: language model)?|i hope this helps|delve[sd]? into|in today'?s (?:fast-paced|digital|ever-(?:changing|evolving))|navigat(?:e|ing) the (?:complexities|intricacies)|a testament to)\b/i;
const AI_WEAK = [/\bin conclusion\b/i, /\bit'?s (?:important|worth) (?:to note|noting)\b/i, /\btapestry\b/i, /\bgame[- ]changer\b/i, /\belevate your\b/i, /\bunlock(?:ing)? the (?:power|potential|secrets)\b/i, /\bwhether you'?re an? [^.]{2,40} or an?\b/i, /\bseamless(?:ly)?\b/i, /\bembark on\b/i, /\bever-evolving\b/i, /\bcomprehensive guide\b/i];
const aiTell = (t) => AI_STRONG.test(t) || AI_WEAK.filter((r) => r.test(t)).length >= 2;
// "Best ... 2023" when it's no longer 2023 (from March on, last year's list counts as stale too)
const staleBest = (title, now) => {
  if (!/\b(?:best|top \d+)\b/i.test(title)) return false;
  const d = new Date(now), y = d.getFullYear();
  const years = (title.match(/\b20\d\d\b/g) || []).map(Number);
  return years.length > 0 && Math.max(...years) < (d.getMonth() >= 2 ? y : y - 1);
};
const PAPER_HOST = /(?:^|\.)(?:arxiv\.org|openreview\.net|acm\.org|ieee\.org|springer\.com|doi\.org|semanticscholar\.org|researchgate\.net|aclanthology\.org)$|^(?:papers|proceedings)\.|\.edu$|\.ac\.[a-z]{2}$/;
// Snippet as 3-word runs (leading date dropped; the last, cut-off word too); overlap = shared share of the smaller set
const snipWords = (t) => {
  const w = cleanSnippet(t).text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 2).slice(0, 30);
  w.pop();
  const out = new Set();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
};
const overlap = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.min(a.size, b.size); };
// People's own thread titles ("best keyboard 2023?") aren't SEO lists
const FORUM_SITE = new Set(["reddit.com", "quora.com", "stackexchange.com", "stackoverflow.com", "youtube.com", "news.ycombinator.com", "ycombinator.com"]);
// items: [{url, title, snippet}] in page order -> {seen: [site], hit: {site: [reason]}} (each site once)
const seoSigns = (items, psl, now = Date.now()) => {
  const seen = new Set(), hit = {}, firstTitle = new Map();
  const add = (d, why) => { (hit[d] ||= []).includes(why) || hit[d].push(why); };
  for (const it of items) {
    let h = "";
    try { h = new URL(it.url).hostname.toLowerCase(); } catch { continue; }
    const d = regDomain(h, psl), title = String(it.title || ""), text = `${title} ${it.snippet || ""}`;
    seen.add(d);
    if (CHEAT_SITES.has(d)) add(d, "cheat");
    if (SEO_BAIT.test(text)) add(d, "bait");
    if (!FORUM_SITE.has(d) && staleBest(title, now)) add(d, "stale");
    if (aiTell(text)) add(d, "ai");
    // Same long title and mostly the same snippet as a result already shown from another site: a copy (the first
    // is taken as the original). Paper hosts are left out: the same paper is often on several of them, all genuine.
    const k = titleKey(title), w = snipWords(it.snippet);
    if (k.split(" ").length >= 5 && !PAPER_HOST.test(h)) {
      const o = firstTitle.get(k);
      if (!o) firstTitle.set(k, { d, w });
      else if (o.d !== d && overlap(o.w, w) >= 0.4) add(d, "copy");
    }
  }
  return { seen: [...seen], hit };
};
// A site is lowered when it showed signs on most searches it was in, after enough searches to tell
const SEO_MIN = 5;
const seoVerdict = (t) => !!t && t.seen >= SEO_MIN && t.hits * 2 > t.seen;

// ===== Paywall tag =====
// Sites where most articles need a subscription (hard or tight metered paywalls). Hand-kept, well-known names only;
// a "Paywall" word on the source line, nothing hidden or moved.
const PAYWALL_SITES = new Set(["nytimes.com", "wsj.com", "ft.com", "economist.com", "bloomberg.com", "washingtonpost.com", "theatlantic.com", "newyorker.com", "wired.com", "thetimes.co.uk", "thetimes.com", "telegraph.co.uk", "barrons.com", "hbr.org", "theinformation.com", "latimes.com", "bostonglobe.com", "businessinsider.com", "foreignaffairs.com", "foreignpolicy.com", "nymag.com", "vanityfair.com", "technologyreview.com", "scientificamerican.com", "newscientist.com", "chicagotribune.com", "sfchronicle.com", "seekingalpha.com", "theathletic.com", "thestar.com", "theglobeandmail.com", "afr.com", "spectator.co.uk", "marketwatch.com", "lemonde.fr", "spiegel.de", "nzz.ch", "haaretz.com"]);
// The Athletic lives under nytimes.com/athletic/ but nytimes.com itself is listed anyway
const paywalled = (host, psl) => PAYWALL_SITES.has(regDomain(String(host || "").toLowerCase(), psl));

// ===== Snippet cleanup =====
const MON = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
const DATE_RE = new RegExp(`^\\s*(${MON} \\d{1,2},? \\d{4}|\\d{1,2} ${MON},? \\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4}|\\d+ (?:sec|second|min|minute|hour|hr|day|week|month|year)s? ago|yesterday|today)\\s*(?:\\.\\.\\.|…|—|–|-|·|:)\\s*`, "i");
// Returns {date, text}: leading date moved out, junk ellipses removed, whitespace tidied
const cleanSnippet = (s) => {
  let t = String(s || "").replace(/\s+/g, " ").trim();
  let date = "";
  const m = DATE_RE.exec(t);
  if (m && t.length > m[0].length + 8) { date = m[1]; t = t.slice(m[0].length); }
  t = t.replace(/^(?:\.\.\.|…)\s*/, "").replace(/\s*(?:\.\.\.|…)\s*(?:\.\.\.|…)+/g, " … ").replace(/\s+(?:\.\.\.|…)$/, "…").replace(/\.\.\./g, "…").trim();
  return { date, text: t };
};
// Label for a date found in a snippet or given by the engine: relative ones stay as written, absolute ones go
// through relDate
const dateLabel = (raw, now = Date.now()) => {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/ago$|^(?:today|yesterday)$/i.test(s)) return s.toLowerCase();
  return relDate(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s, now) || s;
};
// "yesterday", "3 days ago" within about a week; otherwise the exact date. now injectable for tests
const relDate = (d, now = Date.now()) => {
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  if (!Number.isFinite(t)) return "";
  const day = (x) => { const y = new Date(x); return Date.UTC(y.getFullYear(), y.getMonth(), y.getDate()); };
  const days = Math.round((day(now) - day(t)) / 864e5);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days > 1 && days <= 6) return `${days} days ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

// ===== Patterns ("paste anything") =====
// UPS 1Z: 1Z + 15 characters + check digit. Letters count as (code - 63) % 10 (A=2 ... I=0, J=1 ...)
const upsValid = (s) => {
  const m = /^1Z([0-9A-Z]{15})(\d)$/.exec(String(s).toUpperCase().replace(/\s/g, ""));
  if (!m) return false;
  let sum = 0;
  [...m[1]].forEach((c, i) => { const v = /\d/.test(c) ? +c : (c.charCodeAt(0) - 63) % 10; sum += i % 2 ? v * 2 : v; });
  return (10 - (sum % 10)) % 10 === +m[2];
};
const isbnValid = (s) => {
  const x = String(s).toUpperCase().replace(/[\s-]/g, "");
  if (/^\d{9}[\dX]$/.test(x)) { let t = 0; for (let i = 0; i < 10; i++) t += (x[i] === "X" ? 10 : +x[i]) * (10 - i); return t % 11 === 0; }
  if (/^97[89]\d{10}$/.test(x)) { let t = 0; for (let i = 0; i < 13; i++) t += +x[i] * (i % 2 ? 3 : 1); return t % 10 === 0; }
  return false;
};
// CMU course numbers: "15-213" always looks like a course; bare "15213" only when that course exists
const cmuCourse = (q, courses) => {
  const s = String(q).trim();
  let m = /^(\d{2})-?(\d{3})\b(.*)$/.exec(s);
  if (!m) return null;
  const id = `${m[1]}-${m[2]}`, dashed = /^\d{2}-\d{3}/.test(s);
  if (!dashed && !(courses && courses.has(id))) return null;
  const rest = m[3].trim().toLowerCase();
  // Course-level only: nothing after, or a word about the course itself. A topic ("malloc lab") -> no card
  const level = !rest || /^(?:cmu\s*)?(?:course|class|workload|hours?|units?|fces?|reviews?|ratings?|professors?|profs?|instructors?|teachers?|syllabus|prereqs?|prerequisites?|difficulty|hard|easy|worth it)\s*\??$/.test(rest);
  return { id, level, prof: /prof|instructor|teacher/.test(rest) };
};

// ===== Answer card, local part (no network): math, units incl. cooking, tip / percent, date math, patterns =====
// answer(q, now) -> null, or { kind, label, value | title + href, detail, copy, swatch? }. Pure: the page draws it in
// the same pass that starts the search, so it never arrives late and needs no reserved space.
// Priority inside: exact pattern > calculation (spec: pattern > calculation > live > fact > snippet > AI).

// ----- Number formatting: headline rounded, exact value on the detail line -----
const NBSP = " ";
const MINUS = "−";
// Up to 6 significant digits on the headline ("about" values), thousands separators, "−" for negatives
const fmtNum = (x, sig = 6) => {
  if (!Number.isFinite(x)) return "";
  if (x === 0) return "0";
  const a = Math.abs(x);
  let s;
  if (a >= 1e15 || a < 1e-6) s = x.toExponential(Math.max(0, sig - 1)).replace(/\.?0+e/, "e").replace("e+", " × 10^").replace("e-", ` × 10^${MINUS}`);
  else {
    const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(a)));
    s = Number(x.toFixed(Math.min(digits, 10))).toLocaleString("en-US", { maximumFractionDigits: Math.min(digits, 10) });
  }
  return s.replace(/^-/, MINUS);
};
// Exact-ish (15 significant digits, floating noise removed) for the detail line and for copying
const exact = (x) => { const r = Number(x.toPrecision(15)); return Math.abs(r) >= 1e15 || (r !== 0 && Math.abs(r) < 1e-6) ? String(r) : r.toLocaleString("en-US", { maximumFractionDigits: 12 }); };
const plain = (x) => String(Number(x.toPrecision(15)));
const num = (s) => Number(String(s).replace(/,(?=\d{3}\b)/g, ""));
const NUM = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+";

// ----- Math: a small safe parser (no eval). Radians, like a calculator. -----
const FUNCS = { sqrt: Math.sqrt, cbrt: Math.cbrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, ln: Math.log, log: Math.log10, log2: Math.log2, abs: Math.abs, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round };
const CONSTS = { pi: Math.PI, "π": Math.PI, e: Math.E };
const tokenize = (src) => {
  const out = [];
  const re = new RegExp(`\\s*(?:(${NUM})|(\\*\\*|[-+*/^()!×÷−]|\\bx\\b)|([a-zπ][a-z0-9]*))`, "giy");
  let m, at = 0;
  const s = src.replace(/(\d)\s*x\s*(?=[\d(.])/gi, "$1*"); // "12 x 350"
  while (at < s.length) {
    re.lastIndex = at;
    m = re.exec(s);
    if (!m) { if (/^\s*$/.test(s.slice(at))) break; return null; }
    at = re.lastIndex;
    if (m[1]) out.push({ t: "n", v: num(m[1]) });
    else if (m[2]) out.push({ t: "o", v: { "×": "*", "÷": "/", "−": "-", "**": "^", x: "*", X: "*" }[m[2]] || m[2] });
    else { const w = m[3].toLowerCase(); if (w in FUNCS) out.push({ t: "f", v: w }); else if (w in CONSTS) out.push({ t: "n", v: CONSTS[w], c: w }); else return null; }
  }
  return out;
};
// expr := term (('+'|'-') term)* ; term := unary (('*'|'/') unary | implicit unary)* ; unary := '-' unary | power
// power := post ('^' unary)? ; post := atom '!'* ; atom := n | f atom | '(' expr ')'
const parse = (toks) => {
  let i = 0;
  const peek = () => toks[i], eat = (v) => (toks[i] && toks[i].t === "o" && toks[i].v === v ? (i++, true) : false);
  const atom = () => {
    const k = toks[i++];
    if (!k) throw 0;
    if (k.t === "n") return k.v;
    if (k.t === "f") { const a = eat("(") ? (() => { const v = expr(); if (!eat(")")) throw 0; return v; })() : unary(); return FUNCS[k.v](a); }
    if (k.t === "o" && k.v === "(") { const v = expr(); if (!eat(")")) throw 0; return v; }
    throw 0;
  };
  const fact = (n) => { if (!Number.isInteger(n) || n < 0 || n > 170) throw 0; let r = 1; for (let j = 2; j <= n; j++) r *= j; return r; };
  const post = () => { let v = atom(); while (eat("!")) v = fact(v); return v; };
  const power = () => { const b = post(); return eat("^") ? b ** unary() : b; };
  const unary = () => (eat("-") ? -unary() : eat("+") ? unary() : power());
  const term = () => {
    let v = unary();
    for (;;) {
      if (eat("*")) v *= unary();
      else if (eat("/")) { const d = unary(); if (d === 0) throw 0; v /= d; }
      else if (peek() && (peek().t === "n" || peek().t === "f" || (peek().t === "o" && peek().v === "("))) v *= unary(); // 2pi, 3(4+5)
      else return v;
    }
  };
  const expr = () => { let v = term(); for (;;) { if (eat("+")) v += term(); else if (eat("-")) v -= term(); else return v; } };
  const v = expr();
  if (i !== toks.length) throw 0;
  return v;
};
// Things that look like sums but aren't: phone numbers, dates, ZIP+4, course numbers, version numbers, ranges
const NOT_MATH = /^24\/7$|^\d{2}-\d{3}$|^\d{3}-\d{3}-\d{4}$|^\d{5}-\d{4}$|^\d{4}-\d{1,2}-\d{1,2}$|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$|^\d+(?:\.\d+){2,}$|^\d+-\d+$/;
const calc = (q) => {
  let s = String(q).trim().toLowerCase().replace(/^(?:what(?:'s| is)|calculate|calc|compute|solve)\s+/, "").replace(/\s*=\s*\??$|\?$/, "").trim();
  if (!s || s.length > 120 || NOT_MATH.test(s)) return null;
  const toks = tokenize(s);
  // Needs an operation: a bare number or word isn't a sum
  if (!toks || toks.length < 2 || !toks.some((k) => k.t === "f" || (k.t === "o" && k.v !== "(" && k.v !== ")") || k.c)) return null;
  if (toks.filter((k) => k.t === "n").length < 1) return null;
  let v;
  try { v = parse(toks); } catch { return null; }
  if (!Number.isFinite(v)) return null;
  // The sum as read: "12 × 350", "√" kept as the function name, π for pi, spaced operators
  const shown = toks.map((k, n) => {
    if (k.t === "n") return k.c ? (k.c === "e" ? "e" : "π") : exact(k.v);
    if (k.t === "f") return k.v;
    const o = { "*": " × ", "/": " ÷ ", "-": n === 0 || (toks[n - 1].t === "o" && toks[n - 1].v !== ")" && toks[n - 1].v !== "!") ? MINUS : ` ${MINUS} `, "+": " + " }[k.v];
    return o || k.v;
  }).join("").replace(/([a-z]\d*)(?=[\dπe])/g, "$1 ").replace(/(\d)(?=[π(a-z])/g, "$1").trim();
  return { kind: "calc", label: "Calculator", value: fmtNum(v, 10), detail: `${shown} = ${exact(v)}`, copy: plain(v) };
};

// ----- Units (incl. cooking). Factor = size of one unit in the base unit of its kind. -----
const U = {};
const unit = (kind, factor, names, show) => { for (const n of names) U[n] = { kind, factor, show: show || names[0] }; };
// length (m)
unit("len", 1e-3, ["mm", "millimeter", "millimeters", "millimetre", "millimetres"]);
unit("len", 1e-2, ["cm", "centimeter", "centimeters", "centimetre", "centimetres"]);
unit("len", 1, ["m", "meter", "meters", "metre", "metres"]);
unit("len", 1e3, ["km", "kilometer", "kilometers", "kilometre", "kilometres"]);
unit("len", 0.0254, ["in", "inch", "inches", "\""], "in");
unit("len", 0.3048, ["ft", "foot", "feet", "'"], "ft");
unit("len", 0.9144, ["yd", "yard", "yards"]);
unit("len", 1609.344, ["mi", "mile", "miles"]);
unit("len", 1852, ["nmi", "nautical mile", "nautical miles"]);
// mass (kg)
unit("mass", 1e-6, ["mg", "milligram", "milligrams"]);
unit("mass", 1e-3, ["g", "gram", "grams"]);
unit("mass", 1, ["kg", "kilogram", "kilograms", "kilo", "kilos"]);
unit("mass", 0.028349523125, ["oz", "ounce", "ounces"]);
unit("mass", 0.45359237, ["lb", "lbs", "pound", "pounds"]);
unit("mass", 6.35029318, ["st", "stone", "stones"]);
unit("mass", 1000, ["t", "tonne", "tonnes", "metric ton", "metric tons"]);
// volume (L) — US customary for cups/spoons/fl oz/pints/quarts/gallons (searches here are US)
unit("vol", 1e-3, ["ml", "milliliter", "milliliters", "millilitre", "millilitres"]);
unit("vol", 1, ["l", "liter", "liters", "litre", "litres"]);
unit("vol", 0.00492892159375, ["tsp", "teaspoon", "teaspoons"]);
unit("vol", 0.01478676478125, ["tbsp", "tablespoon", "tablespoons"]);
unit("vol", 0.0295735295625, ["fl oz", "fluid ounce", "fluid ounces", "floz"]);
unit("vol", 0.2365882365, ["cup", "cups", "c"]);
unit("vol", 0.473176473, ["pt", "pint", "pints"]);
unit("vol", 0.946352946, ["qt", "quart", "quarts"]);
unit("vol", 3.785411784, ["gal", "gallon", "gallons"]);
// speed (m/s)
unit("speed", 1 / 3.6, ["km/h", "kph", "kmh", "kilometers per hour"]);
unit("speed", 0.44704, ["mph", "miles per hour"]);
unit("speed", 1, ["m/s", "meters per second"]);
unit("speed", 1852 / 3600, ["knot", "knots", "kn"]);
// area (m²)
unit("area", 1, ["m2", "m²", "sq m", "square meter", "square meters"]);
unit("area", 0.09290304, ["ft2", "ft²", "sq ft", "square foot", "square feet"]);
unit("area", 4046.8564224, ["acre", "acres"]);
unit("area", 1e4, ["ha", "hectare", "hectares"]);
unit("area", 1e6, ["km2", "km²", "sq km", "square kilometer", "square kilometers"]);
unit("area", 2589988.110336, ["mi2", "mi²", "sq mi", "square mile", "square miles"]);
// data (bytes; decimal and binary as named)
unit("data", 1, ["b", "byte", "bytes"], "B");
unit("data", 1e3, ["kb", "kilobyte", "kilobytes"], "KB");
unit("data", 1e6, ["mb", "megabyte", "megabytes"], "MB");
unit("data", 1e9, ["gb", "gigabyte", "gigabytes"], "GB");
unit("data", 1e12, ["tb", "terabyte", "terabytes"], "TB");
unit("data", 1024, ["kib", "kibibyte", "kibibytes"], "KiB");
unit("data", 1024 ** 2, ["mib", "mebibyte", "mebibytes"], "MiB");
unit("data", 1024 ** 3, ["gib", "gibibyte", "gibibytes"], "GiB");
unit("data", 1024 ** 4, ["tib", "tebibyte", "tebibytes"], "TiB");
// time (s)
unit("time", 1, ["s", "sec", "secs", "second", "seconds"]);
unit("time", 60, ["min", "mins", "minute", "minutes"]);
unit("time", 3600, ["h", "hr", "hrs", "hour", "hours"]);
unit("time", 86400, ["day", "days"]);
unit("time", 604800, ["week", "weeks", "wk", "wks"]);
unit("time", 31557600, ["year", "years", "yr", "yrs"]); // Julian year (365.25 days)
// temperature: handled apart (offsets)
const TEMP = { c: "C", "°c": "C", celsius: "C", f: "F", "°f": "F", fahrenheit: "F", k: "K", kelvin: "K", kelvins: "K" };
const toK = (v, u) => (u === "C" ? v + 273.15 : u === "F" ? (v - 32) * 5 / 9 + 273.15 : v);
const fromK = (k, u) => (u === "C" ? k - 273.15 : u === "F" ? (k - 273.15) * 9 / 5 + 32 : k);
// Cooking: grams in one US cup (King Arthur's ingredient weight chart values for the common ones)
const CUP_G = { flour: 120, "all-purpose flour": 120, "all purpose flour": 120, "bread flour": 120, sugar: 198, "granulated sugar": 198, "white sugar": 198, "brown sugar": 213, "powdered sugar": 113, "icing sugar": 113, butter: 227, water: 236.6, milk: 227, rice: 191, oats: 89, "rolled oats": 89, honey: 336, "maple syrup": 312, oil: 198, "vegetable oil": 198, "olive oil": 200, cocoa: 84, "cocoa powder": 84, salt: 288, "chocolate chips": 170, yogurt: 227, cornstarch: 112 };
const unitShow = (u, v) => {
  const one = Math.abs(v) === 1;
  const n = { in: "in", ft: "ft", cup: one ? "cup" : "cups", tsp: "tsp", tbsp: "tbsp", "fl oz": "fl oz", pt: one ? "pint" : "pints", qt: one ? "quart" : "quarts", gal: one ? "gallon" : "gallons", day: one ? "day" : "days", week: one ? "week" : "weeks", year: one ? "year" : "years", acre: one ? "acre" : "acres", knot: one ? "knot" : "knots", stone: "st" }[u.show];
  return n || u.show;
};
const UNIT_NAMES = Object.keys(U).sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\/"']/g, "\\$&")).join("|");
const TEMP_NAMES = "°c|°f|celsius|fahrenheit|kelvins?|c|f|k";
const ING = Object.keys(CUP_G).sort((a, b) => b.length - a.length).join("|");
const UNIT_RE = new RegExp(`^(?:convert\\s+|how many\\s+(${UNIT_NAMES})\\s+(?:are\\s+)?in\\s+)?(-?${NUM})\\s*(${UNIT_NAMES}|${TEMP_NAMES})(?:\\s+(?:of\\s+)?(${ING}))?(?:\\s+(?:to|in|into|as|=)\\s+(${UNIT_NAMES}|${TEMP_NAMES}))?\\s*\\??$`, "i");
const convert = (q) => {
  const s = String(q).trim().toLowerCase().replace(/\s+/g, " ").replace(/degrees?\s+/g, "°");
  const m = UNIT_RE.exec(s);
  if (!m) return null;
  const v = num(m[2]);
  let from = m[3], to = m[5] || m[1], ing = m[4];
  if (!to) return null; // "5 km" alone: not asked
  if (TEMP[from] && TEMP[to]) {
    const a = TEMP[from], b = TEMP[to];
    if (a === b) return null;
    const r = fromK(toK(v, a), b);
    if (b === "K" && r < 0) return null;
    return { kind: "unit", label: "Unit converter", value: `${fmtNum(r, 4)}${a === "K" || b === "K" ? NBSP : ""}${b === "K" ? "K" : `°${b}`}`, detail: `${exact(v)}${a === "K" ? " K" : ` °${a}`} = ${exact(r)}${b === "K" ? " K" : ` °${b}`}`, copy: plain(r) };
  }
  const a = U[from], b = U[to];
  if (!a || !b) return null;
  // Cooking: cups/spoons <-> grams/ounces of a named ingredient
  if (a.kind !== b.kind) {
    const g = ing && CUP_G[ing];
    if (!g || !((a.kind === "vol" && b.kind === "mass") || (a.kind === "mass" && b.kind === "vol"))) return null;
    const perL = g / 1000 / U.cup.factor; // kg per litre
    const r = a.kind === "vol" ? (v * a.factor * perL) / b.factor : (v * a.factor / perL) / b.factor;
    return { kind: "unit", label: `Cooking · ${ing}`, value: `${fmtNum(r, 3)} ${unitShow(b, r)}`, detail: `${exact(v)} ${unitShow(a, v)} ${ing} ≈ ${exact(Number(r.toPrecision(4)))} ${unitShow(b, r)} · 1 cup = ${g} g`, copy: plain(Number(r.toPrecision(4))) };
  }
  if (a === b) return null;
  const r = (v * a.factor) / b.factor;
  return { kind: "unit", label: "Unit converter", value: `${fmtNum(r, 6)} ${unitShow(b, r)}`, detail: `${exact(v)} ${unitShow(a, v)} = ${exact(r)} ${unitShow(b, r)}`, copy: plain(r) };
};

// ----- Tip / percent -----
const percent = (q) => {
  const s = String(q).trim().toLowerCase().replace(/\s+/g, " ").replace(/\?$/, "").replace(/^what(?:'s| is) /, "").replace(/\$/g, "");
  let m;
  const P = `(${NUM})\\s*(?:%|percent)`;
  // "20% tip on 45.50", "tip 18% of 62", "15% tip for 80"
  if ((m = new RegExp(`^(?:tip (?:of )?)?${P}(?: tip)? (?:on|of|for) (${NUM})$`).exec(s)) && /tip/.test(s)) {
    const p = num(m[1]), b = num(m[2]), t = b * p / 100;
    return { kind: "percent", label: "Tip", value: `$${t.toFixed(2)}`, detail: `${exact(p)}% of $${b.toFixed(2)} · total $${(b + t).toFixed(2)}`, copy: t.toFixed(2) };
  }
  // "15% of 200"
  if ((m = new RegExp(`^${P} of (${NUM})$`).exec(s))) {
    const p = num(m[1]), b = num(m[2]), r = b * p / 100;
    return { kind: "percent", label: "Percent", value: fmtNum(r, 8), detail: `${exact(p)}% of ${exact(b)} = ${exact(r)}`, copy: plain(r) };
  }
  // "30 is what percent of 120", "30 out of 120 as a percent"
  if ((m = new RegExp(`^(${NUM}) (?:is what (?:%|percent) of|out of|of) (${NUM})(?: (?:as a |in )?(?:%|percent(?:age)?))?$`).exec(s)) && /percent|%/.test(s)) {
    const a = num(m[1]), b = num(m[2]);
    if (!b) return null;
    const r = a / b * 100;
    return { kind: "percent", label: "Percent", value: `${fmtNum(r, 4)}%`, detail: `${exact(a)} ÷ ${exact(b)} = ${exact(r)}%`, copy: plain(r) };
  }
  // "percent change from 80 to 100", "% increase from 50 to 65"
  if ((m = new RegExp(`^(?:%|percent(?:age)?) (?:change|increase|decrease|difference) from (${NUM}) to (${NUM})$`).exec(s))) {
    const a = num(m[1]), b = num(m[2]);
    if (!a) return null;
    const r = (b - a) / a * 100;
    return { kind: "percent", label: "Percent change", value: `${r > 0 ? "+" : ""}${fmtNum(r, 4)}%`, detail: `${exact(a)} → ${exact(b)} = ${exact(r)}%`, copy: plain(r) };
  }
  return null;
};

// ----- Date math (local calendar days) -----
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monIdx = (s) => MONTHS.findIndex((x) => x.startsWith(s.slice(0, 3)));
const day0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const nthWeekday = (y, m, wd, n) => { const d = new Date(y, m, 1); d.setDate(1 + ((wd - d.getDay() + 7) % 7) + (n - 1) * 7); return d; };
const easter = (y) => { // Anonymous Gregorian algorithm (Meeus/Jones/Butcher)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, mo - 1, da);
};
// US-centred holidays (the user's searches are US); each -> date in year y
const HOLIDAYS = {
  christmas: [(y) => new Date(y, 11, 25), "Christmas"], "christmas eve": [(y) => new Date(y, 11, 24), "Christmas Eve"],
  "new year": [(y) => new Date(y, 0, 1), "New Year's Day"], "new years": [(y) => new Date(y, 0, 1), "New Year's Day"], "new year's": [(y) => new Date(y, 0, 1), "New Year's Day"],
  "new years eve": [(y) => new Date(y, 11, 31), "New Year's Eve"], "new year's eve": [(y) => new Date(y, 11, 31), "New Year's Eve"],
  halloween: [(y) => new Date(y, 9, 31), "Halloween"], "valentines day": [(y) => new Date(y, 1, 14), "Valentine's Day"], "valentine's day": [(y) => new Date(y, 1, 14), "Valentine's Day"],
  "july 4th": [(y) => new Date(y, 6, 4), "Independence Day"], "4th of july": [(y) => new Date(y, 6, 4), "Independence Day"], "independence day": [(y) => new Date(y, 6, 4), "Independence Day"],
  thanksgiving: [(y) => nthWeekday(y, 10, 4, 4), "Thanksgiving"], easter: [easter, "Easter"],
  "mothers day": [(y) => nthWeekday(y, 4, 0, 2), "Mother's Day"], "mother's day": [(y) => nthWeekday(y, 4, 0, 2), "Mother's Day"],
  "fathers day": [(y) => nthWeekday(y, 5, 0, 3), "Father's Day"], "father's day": [(y) => nthWeekday(y, 5, 0, 3), "Father's Day"],
  "labor day": [(y) => nthWeekday(y, 8, 1, 1), "Labor Day"], "memorial day": [(y) => { const d = new Date(y, 5, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }, "Memorial Day"],
};
const longDate = (d) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const dayDiff = (a, b) => Math.round((day0(b) - day0(a)) / 864e5);
const parseDay = (s, now) => {
  let m;
  if ((m = new RegExp(`^${MON_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$`).exec(s))) return { d: new Date(m[3] ? +m[3] : now.getFullYear(), monIdx(m[1]), +m[2]), y: !!m[3] };
  if ((m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MON_RE}(?:,? (\\d{4}))?$`).exec(s))) return { d: new Date(m[3] ? +m[3] : now.getFullYear(), monIdx(m[2]), +m[1]), y: !!m[3] };
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return { d: new Date(+m[1], +m[2] - 1, +m[3]), y: true };
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return { d: new Date(+m[3], +m[1] - 1, +m[2]), y: true };
  const h = HOLIDAYS[s.replace(/^the /, "")];
  if (h) return { d: h[0](now.getFullYear()), y: false, name: h[1], f: h[0] };
  return null;
};
const dateMath = (q, nowMs = Date.now()) => {
  const now = new Date(nowMs);
  const s = String(q).trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]$/, "").replace(/^how many /, "");
  let m;
  // "days until christmas", "days till dec 25", "weeks until 2027-01-01"
  if ((m = /^(days|weeks) (?:until|till|til|to|before) (.+)$/.exec(s))) {
    const p = parseDay(m[2], now);
    if (!p || isNaN(p.d)) return null;
    // A date without a year that already passed this year means next year's
    if (!p.y && dayDiff(now, p.d) < 0) p.d = p.f ? p.f(now.getFullYear() + 1) : new Date(p.d.getFullYear() + 1, p.d.getMonth(), p.d.getDate());
    const n = dayDiff(now, p.d);
    if (n < 0) return null;
    const what = p.name || p.d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
    const v = m[1] === "weeks" ? `${fmtNum(n / 7, 3)} weeks` : n === 0 ? "Today" : `${n.toLocaleString("en-US")} ${n === 1 ? "day" : "days"}`;
    return { kind: "date", label: `Until ${what}`, value: v, detail: `${longDate(p.d)}${m[1] === "weeks" ? ` · ${n} days` : n >= 14 ? ` · ${Math.floor(n / 7)} weeks ${n % 7 ? `${n % 7} ${n % 7 === 1 ? "day" : "days"}` : ""}`.trimEnd() : ""}`, copy: String(m[1] === "weeks" ? Number((n / 7).toFixed(2)) : n) };
  }
  // "days since jan 1", "days since 2020-03-11"
  if ((m = /^days since (.+)$/.exec(s))) {
    const p = parseDay(m[1], now);
    if (!p || isNaN(p.d)) return null;
    if (!p.y && dayDiff(p.d, now) < 0) p.d = p.f ? p.f(now.getFullYear() - 1) : new Date(p.d.getFullYear() - 1, p.d.getMonth(), p.d.getDate());
    const n = dayDiff(p.d, now);
    if (n < 0) return null;
    return { kind: "date", label: `Since ${p.name || p.d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`, value: `${n.toLocaleString("en-US")} ${n === 1 ? "day" : "days"}`, detail: longDate(p.d), copy: String(n) };
  }
  // "30 days from today", "2 weeks from now", "90 days ago", "6 months from today"
  if ((m = /^(?:what (?:is|day is) |what date is )?(\d{1,5}) (days?|weeks?|months?|years?) (from (?:today|now)|ago|from now)$/.exec(s))) {
    const n = +m[1], u = m[2].replace(/s$/, ""), sign = m[3] === "ago" ? -1 : 1;
    const d = day0(now);
    if (u === "day") d.setDate(d.getDate() + sign * n);
    else if (u === "week") d.setDate(d.getDate() + sign * n * 7);
    else if (u === "month") d.setMonth(d.getMonth() + sign * n);
    else d.setFullYear(d.getFullYear() + sign * n);
    if (isNaN(d)) return null;
    return { kind: "date", label: `${n} ${n === 1 ? u : `${u}s`} ${sign < 0 ? "ago" : "from today"}`, value: d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }), detail: longDate(d), copy: d.toLocaleDateString("en-CA") };
  }
  return null;
};

// ----- Patterns ("paste anything"): exact shapes only, checksums where the format has one -----
const ups1Z = (s) => {
  const m = /^1Z([0-9A-Z]{15})(\d)$/.exec(s);
  if (!m) return false;
  let sum = 0;
  [...m[1]].forEach((c, i) => { const v = /\d/.test(c) ? +c : (c.charCodeAt(0) - 63) % 10; sum += i % 2 ? v * 2 : v; });
  return (10 - (sum % 10)) % 10 === +m[2];
};
const isbn = (x) => {
  if (/^\d{9}[\dX]$/.test(x)) { let t = 0; for (let i = 0; i < 10; i++) t += (x[i] === "X" ? 10 : +x[i]) * (10 - i); return t % 11 === 0; }
  if (/^97[89]\d{10}$/.test(x)) { let t = 0; for (let i = 0; i < 13; i++) t += +x[i] * (i % 2 ? 3 : 1); return t % 10 === 0; }
  return false;
};
const res = (label, title, href, detail, copy) => ({ kind: "pattern", label, title, href, detail, copy });
const hexColor = (h) => {
  const x = h.length <= 4 ? h.slice(1).split("").map((c) => c + c).join("") : h.slice(1, 7);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, l = (mx + mn) / 2, d = mx - mn;
  let hh = 0;
  if (d) { const R = r / 255, G = g / 255, B = b / 255; hh = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4; }
  const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { hex: `#${x.toUpperCase()}`, rgb: `rgb(${r}, ${g}, ${b})`, hsl: `hsl(${Math.round(((hh * 60) + 360) % 360)}, ${Math.round(sat * 100)}%, ${Math.round(l * 100)}%)` };
};
const ipv4 = (s) => { const p = s.split("."); return p.length === 4 && p.every((x) => /^(?:0|[1-9]\d{0,2})$/.test(x) && +x <= 255) ? p.map(Number) : null; };
const ipKind = ([a, b]) => (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ? "Private network address" : a === 127 ? "Loopback (this device)" : a === 169 && b === 254 ? "Link-local address" : a === 100 && b >= 64 && b <= 127 ? "Carrier-grade NAT address" : a >= 224 && a <= 239 ? "Multicast address" : a === 0 || a >= 240 ? "Reserved address" : "Public address");
const NOT_REPO = /^(?:and\/or|he\/him|she\/her|they\/them|km\/h|m\/s|w\/o|n\/a|24\/7|ft\/s|mi\/h|lb\/ft|ac\/dc)$|\.(?:com|org|net|io|edu|gov)\//i;
// IATA codes of large airlines (a bare "UA 123" is a flight; other two-letter codes need the word "flight")
const AIRLINES = new Set("AA UA DL WN B6 AS NK F9 HA G4 SY AC WS BA VS AF KL LH LX OS SN SK AY EI IB VY FR U2 AZ TP TK EK QR EY SV MS ET QF NZ VA JQ NH JL KE OZ CI BR CX SQ MH TG GA VN AI 6E AM AV LA CM".split(" "));
const pattern = (q) => {
  const raw = String(q).trim();
  const s = raw.replace(/\s+/g, " ");
  const tight = s.replace(/[\s-]/g, "").toUpperCase();
  let m;
  // Parcels
  if (ups1Z(tight)) return res("UPS tracking number", `Track UPS ${tight}`, `https://www.ups.com/track?tracknum=${tight}`, "Check digit OK", tight);
  if (/^TBA\d{12}$/.test(tight)) return res("Amazon tracking number", `Track Amazon package ${tight}`, `https://track.amazon.com/tracking/${tight}`, "Amazon Logistics", tight);
  if (/^(?:94|93|92|95)\d{18,20}$/.test(tight)) return res("USPS tracking number", `Track USPS ${tight}`, `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tight}`, "Format matches USPS (no check digit tested)", tight);
  // FedEx numbers have no published check digit that can be confirmed here, so only with the word "fedex"
  if ((m = /^fedex\s+(?:tracking\s+)?(\d{12}|\d{15}|\d{20})$|^(\d{12}|\d{15}|\d{20})\s+fedex$/i.exec(s))) { const n = m[1] || m[2]; return res("FedEx tracking number", `Track FedEx ${n}`, `https://www.fedex.com/fedextrack/?trknbr=${n}`, "FedEx", n); }
  // Books, papers, security advisories
  // 13 digits starting 978/979 on their own; 10 digits only after "isbn" (1 in 11 random numbers pass its check)
  if ((m = /^(isbn(?:-1[03])?:?\s*)?((?:97[89][\s-]?)?(?:\d[\s-]?){9}[\dXx])$/i.exec(s)) && (m[1] || /^97[89]/.test(m[2])) && isbn(m[2].replace(/[\s-]/g, "").toUpperCase())) { const n = m[2].replace(/[\s-]/g, "").toUpperCase(); return res(`ISBN-${n.length}`, `Open Library: ISBN ${n}`, `https://openlibrary.org/isbn/${n}`, "Checksum OK", n); }
  if ((m = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i.exec(s))) return res("DOI", `doi.org/${m[1]}`, `https://doi.org/${m[1]}`, "Digital Object Identifier", m[1]);
  if ((m = /^(?:arxiv:?\s*)?(\d{4}\.\d{4,5})(v\d+)?$/i.exec(s)) && +m[1].slice(2, 4) >= 1 && +m[1].slice(2, 4) <= 12) return res("arXiv paper", `arXiv:${m[1]}${m[2] || ""}`, `https://arxiv.org/abs/${m[1]}${m[2] || ""}`, `PDF: arxiv.org/pdf/${m[1]}${m[2] || ""}`, `arXiv:${m[1]}${m[2] || ""}`);
  if ((m = /^cve-(\d{4})-(\d{4,7})$/i.exec(s))) { const id = `CVE-${m[1]}-${m[2]}`; return res("Vulnerability", `${id} on NVD`, `https://nvd.nist.gov/vuln/detail/${id}`, "National Vulnerability Database", id); }
  // Windows error codes (0x8xxxxxxx and friends)
  if ((m = /^(?:error\s+(?:code\s+)?)?(0x[0-9a-f]{8})$/i.exec(s))) { const c = `0x${m[1].slice(2).toUpperCase()}`; return res("Windows error code", `${c} on Microsoft Learn`, `https://learn.microsoft.com/en-us/search/?terms=${c}`, `Decimal ${(parseInt(c, 16) | 0).toLocaleString("en-US").replace(/^-/, MINUS)}`, c); }
  // Network and color
  const ip = ipv4(s);
  if (ip) return { kind: "pattern", label: "IPv4 address", value: s, detail: ipKind(ip), copy: s };
  if ((m = /^(?:#|(?:hex|colou?r)\s+#?)([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s))) {
    const c = hexColor(`#${m[1]}`);
    return { kind: "pattern", label: "Color", value: c.hex, detail: `${c.rgb} · ${c.hsl}`, copy: c.hex, swatch: c.hex };
  }
  // Packages and repositories
  if ((m = /^(?:pip(?:3)? install|pip|pypi)\s+([a-z0-9][a-z0-9._-]{0,80})$/i.exec(s))) return res("Python package", `${m[1]} on PyPI`, `https://pypi.org/project/${m[1]}/`, `pip install ${m[1]}`, `pip install ${m[1]}`);
  if ((m = /^(?:npm (?:install|i)|npm)\s+((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213})$/i.exec(s))) return res("npm package", `${m[1]} on npm`, `https://www.npmjs.com/package/${m[1]}`, `npm install ${m[1]}`, `npm install ${m[1]}`);
  if ((m = /^(?:https?:\/\/github\.com\/)?([a-z\d][a-z\d-]{1,38})\/([\w.-]{2,100})$/i.exec(s)) && !/^\d+\/\d+$/.test(s) && !NOT_REPO.test(s)) return res("GitHub repository", `${m[1]}/${m[2]} on GitHub`, `https://github.com/${m[1]}/${m[2]}`, "github.com", `${m[1]}/${m[2]}`);
  // Flights ("UA 123", "dl1234"): with the word "flight"/"status", or a big airline's code alone ("rx 7800" is a GPU)
  if ((m = /^(?:flight\s+)?([a-z]{2}|[a-z]\d|\d[a-z])\s?(\d{1,4})(?:\s+(?:flight|status|flight status))?$/i.exec(s)) && (/flight|status/i.test(s) || AIRLINES.has(m[1].toUpperCase()))) {
    const code = `${m[1].toUpperCase()}${m[2]}`;
    return res("Flight", `Flight ${m[1].toUpperCase()} ${m[2]} status`, `https://www.flightaware.com/live/flight/${code}`, "FlightAware", code);
  }
  // Stock tickers: "$AAPL" (live price is a network answer, M4)
  if ((m = /^\$([a-z]{1,5}(?:\.[a-z])?)$/i.exec(s))) { const t = m[1].toUpperCase(); return res("Stock", `${t} quote`, `https://finance.yahoo.com/quote/${t}`, "Yahoo Finance", t); }
  return null;
};

// ----- Currency, from the ECB's daily reference rates (the server fetches them once after each publication and the
// page keeps a copy, so the answer is local and instant). fx = { date: "2026-11-20", rates: { USD: 1.08, ... } } per EUR.
const CUR = { usd: "USD", "us dollar": "USD", "us dollars": "USD", dollar: "USD", dollars: "USD", "$": "USD", eur: "EUR", euro: "EUR", euros: "EUR", "€": "EUR",
  gbp: "GBP", pound: "GBP", pounds: "GBP", "british pound": "GBP", "british pounds": "GBP", "£": "GBP", jpy: "JPY", yen: "JPY", "¥": "JPY", cny: "CNY", yuan: "CNY", rmb: "CNY",
  cad: "CAD", "canadian dollar": "CAD", "canadian dollars": "CAD", aud: "AUD", "australian dollar": "AUD", "australian dollars": "AUD", chf: "CHF", "swiss franc": "CHF", "swiss francs": "CHF",
  inr: "INR", rupee: "INR", rupees: "INR", "₹": "INR", krw: "KRW", won: "KRW", mxn: "MXN", peso: "MXN", pesos: "MXN", "mexican peso": "MXN", "mexican pesos": "MXN", sek: "SEK", nok: "NOK", dkk: "DKK",
  pln: "PLN", zloty: "PLN", czk: "CZK", huf: "HUF", ron: "RON", bgn: "BGN", isk: "ISK", try: "TRY", lira: "TRY", brl: "BRL", real: "BRL", reais: "BRL", zar: "ZAR", rand: "ZAR", nzd: "NZD",
  sgd: "SGD", hkd: "HKD", thb: "THB", baht: "THB", idr: "IDR", rupiah: "IDR", myr: "MYR", ringgit: "MYR", php: "PHP", ils: "ILS", shekel: "ILS", shekels: "ILS" };
const SYM = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹" };
const CUR_NAMES = Object.keys(CUR).sort((a, b) => b.length - a.length).map((n) => n.replace(/[$€£¥₹]/g, "\\$&")).join("|");
const CUR_RE = new RegExp(`^(?:convert\\s+)?(${CUR_NAMES})?\\s*(${NUM})\\s*(${CUR_NAMES})?\\s+(?:to|in|into|=)\\s+(${CUR_NAMES})\\s*\\??$`, "i");
const money = (v, c) => { const d = c === "JPY" || c === "KRW" || c === "ISK" || c === "HUF" || c === "IDR" ? 0 : 2; const t = v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); return SYM[c] ? `${SYM[c]}${t}` : `${t} ${c}`; };
const currency = (q, fx) => {
  if (!fx || !fx.rates) return null;
  const m = CUR_RE.exec(String(q).trim().toLowerCase().replace(/\s+/g, " "));
  if (!m || !(m[1] || m[3])) return null;
  const a = CUR[m[3] || m[1]], b = CUR[m[4]], v = num(m[2]);
  const per = (c) => (c === "EUR" ? 1 : fx.rates[c]);
  if (!a || !b || a === b || !per(a) || !per(b)) return null;
  const r = (v / per(a)) * per(b), one = per(b) / per(a);
  const day = fx.date ? new Date(`${fx.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
  return { kind: "currency", label: `Currency · ECB rate${day ? ` of ${day}` : ""}`, value: money(r, b), detail: `${money(v, a)} · 1 ${a} = ${one.toLocaleString("en-US", { maximumSignificantDigits: 5 })} ${b}`, copy: plain(Number(r.toFixed(b === "JPY" || b === "KRW" ? 0 : 2))) };
};

// ----- Versions and support (endoflife.date): the page asks the server for one product's release cycles at page
// load (only the product name leaves the page), and draws the answer with the results if it's in hand by then.
const EOL = [
  ["ios", "iOS", "ios|iphone os"], ["ipados", "iPadOS", "ipados"], ["macos", "macOS", "macos|mac os|osx|os x"], ["windows", "Windows", "windows"],
  ["windows-server", "Windows Server", "windows server"], ["android", "Android", "android"], ["python", "Python", "python"], ["nodejs", "Node.js", "node|nodejs|node\\.js"],
  ["php", "PHP", "php"], ["go", "Go", "go|golang"], ["ruby", "Ruby", "ruby"], ["django", "Django", "django"], ["react", "React", "react"], ["angular", "Angular", "angular"],
  ["vue", "Vue", "vue|vue\\.js|vuejs"], ["ubuntu", "Ubuntu", "ubuntu"], ["debian", "Debian", "debian"], ["fedora", "Fedora", "fedora"], ["postgresql", "PostgreSQL", "postgres|postgresql"],
  ["mysql", "MySQL", "mysql"], ["mongodb", "MongoDB", "mongodb|mongo"], ["redis", "Redis", "redis"], ["nginx", "nginx", "nginx"], ["kubernetes", "Kubernetes", "kubernetes|k8s"],
  ["docker-engine", "Docker Engine", "docker"], ["dotnet", ".NET", "\\.net|dotnet"], ["firefox", "Firefox", "firefox"], ["electron", "Electron", "electron"], ["laravel", "Laravel", "laravel"],
  ["rails", "Ruby on Rails", "rails|ruby on rails"], ["spring-boot", "Spring Boot", "spring boot"],
];
const EOL_ALT = EOL.map((x) => x[2]).join("|");
const eolOf = (w) => EOL.find((x) => new RegExp(`^(?:${x[2]})$`, "i").test(w));
// "latest ios", "what is the latest version of python", "node latest version", "is windows 10 supported",
// "python 3.8 end of life", "when does ubuntu 20.04 end support" -> {slug, name, cycle, ask}
const eolQuery = (q) => {
  const s = String(q || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/\?$/, "");
  let m, ask = "", w = "", cycle = "";
  if ((m = new RegExp(`^(?:what(?:'s| is) the )?(?:latest|newest|current) (?:version of |release of )?(${EOL_ALT})(?: version| release)?$`).exec(s))) { ask = "latest"; w = m[1]; }
  else if ((m = new RegExp(`^(${EOL_ALT}) (?:latest|newest|current)(?: version| release)?$`).exec(s))) { ask = "latest"; w = m[1]; }
  else if ((m = new RegExp(`^is (${EOL_ALT}) ([\\w.]+) (?:still )?supported$`).exec(s))) { ask = "support"; w = m[1]; cycle = m[2]; }
  else if ((m = new RegExp(`^(${EOL_ALT}) ([\\w.]+) (?:end of life|eol|end of support|support end(?:s)?|support)$`).exec(s))) { ask = "support"; w = m[1]; cycle = m[2]; }
  else if ((m = new RegExp(`^when (?:does|will) (${EOL_ALT}) ([\\w.]+) (?:reach end of life|end support|lose support|stop being supported)$`).exec(s))) { ask = "support"; w = m[1]; cycle = m[2]; }
  if (!ask) return null;
  const p = eolOf(w);
  return p ? { slug: p[0], name: p[1], cycle, ask } : null;
};
const dayText = (d, now) => {
  const t = Date.parse(`${d}T12:00:00Z`);
  if (!Number.isFinite(t)) return "";
  const days = Math.round((Date.UTC(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()) - Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate())) / 864e5);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days > 1 && days <= 6) return `${days} days ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const isDate = (x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
// cycles: [{cycle, releaseDate, eol, latest, latestReleaseDate}] newest first (endoflife.date's order)
const eolAnswer = (e, cycles, now = Date.now()) => {
  if (!e || !Array.isArray(cycles) || !cycles.length) return null;
  const today = new Date(now).toISOString().slice(0, 10);
  const ended = (c) => (c.eol === true || (isDate(c.eol) && c.eol <= today));
  if (e.ask === "latest") {
    const c = cycles.find((x) => x && x.latest && (!x.releaseDate || x.releaseDate <= today)) || cycles[0];
    if (!c || !c.latest) return null;
    const v = String(c.latest).startsWith(String(c.cycle).split("-")[0]) || /^\d/.test(String(c.latest)) ? c.latest : `${c.cycle} (${c.latest})`;
    const rel = isDate(c.latestReleaseDate) ? dayText(c.latestReleaseDate, now) : "";
    return { kind: "version", label: `Latest ${e.name}`, value: `${e.name} ${v}`, detail: [rel && `Released ${rel}`, ended(c) ? "no longer supported" : isDate(c.eol) ? `supported until ${dayText(c.eol, now)}` : "supported"].filter(Boolean).join(" · "), copy: String(v), src: "endoflife.date" };
  }
  // Support: that cycle ("10", "3.8", "20.04"); Windows' enterprise / IoT / LTSC editions aren't what people mean
  const want = String(e.cycle).toLowerCase();
  const pick = cycles.filter((c) => { const n = String(c.cycle).toLowerCase(); return (n === want || n.startsWith(`${want}-`) || n.startsWith(`${want}.`)) && !(e.slug === "windows" && /(?:^|-)(?:e|iot|lts|ltsc|ltsb)(?:-|$)/.test(n)); });
  if (!pick.length) return null;
  const c = pick[0];
  const end = isDate(c.eol) ? dayText(c.eol, now) : "";
  const ed = String(c.cycle).toLowerCase() === want ? "" : String(c.cycle).slice(want.length + 1).replace(/-w$/i, "").toUpperCase(); // "10-22h2-w" -> "22H2"
  const yes = !ended(c);
  return { kind: "version", label: `${e.name} ${e.cycle} support`, value: yes ? "Yes" : "No", detail: [yes ? (end ? `Supported until ${end}` : "Still supported") : (end ? `Ended ${end}` : "Ended"), ed, c.latest ? `latest ${c.latest}` : ""].filter(Boolean).join(" · "), copy: yes ? "Yes" : "No", src: "endoflife.date" };
};

// ----- Facts from Wikidata ("how tall is the eiffel tower", "pittsburgh population", "when was X born", "ceo of X",
// "distance between A and B"). The page sends only the fact asked and the subject's name; the server looks the
// subject up and sends back that one property. Drawn with the results if in hand, like every network answer.
const WD_PROP = { height: "P2048", population: "P1082", born: "P569", age: "P569", died: "P570", founded: "P571", ceo: "P169", released: "P577", distance: "P625" };
const WD_RULES = [
  [/^(?:how tall is|how high is|what is the height of|height of) (?:the )?(.+)$/, "height"], [/^(?:the )?(.+?) (?:height|how tall)$/, "height"],
  [/^(?:what is the )?population of (.+)$/, "population"], [/^(.+?) population$/, "population"], [/^how many people live in (.+)$/, "population"],
  [/^when (?:was|is) (.+?) born$/, "born"], [/^(.+?) (?:birthday|date of birth|born)$/, "born"], [/^how old is (.+)$/, "age"],
  [/^when did (.+?) die$/, "died"], [/^(.+?) (?:death date|died)$/, "died"],
  [/^when was (.+?) (?:founded|established|built)$/, "founded"], [/^(.+?) (?:founded|founding date)$/, "founded"],
  [/^(?:who is (?:the )?)?ceo of (.+)$/, "ceo"], [/^(.+?) ceo$/, "ceo"],
  [/^when (?:was|did) (.+?) (?:released|come out)$/, "released"], [/^(.+?) release date$/, "released"],
];
const wdQuery = (q) => {
  const s = String(q || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
  let m = /^(?:distance|how far is it|how far) (?:between|from) (.+?) (?:and|to) (.+)$/.exec(s) || /^how far is (.+?) from (.+)$/.exec(s);
  if (m) return { fact: "distance", s: m[1].replace(/^the /, ""), s2: m[2].replace(/^the /, "") };
  for (const [re, fact] of WD_RULES) if ((m = re.exec(s))) { const subj = m[1].replace(/^the /, "").trim(); if (subj.length >= 2 && subj.split(" ").length <= 6) return { fact, s: subj }; }
  return null;
};
const UNIT_M = { Q11573: 1, Q174728: 0.01, Q3710: 0.3048, Q828224: 1000, Q11570: null };
const wdDay = (t, prec) => {
  const m = /^([+-]\d+)-(\d{2})-(\d{2})/.exec(String(t || ""));
  if (!m) return "";
  const y = Number(m[1]);
  if (prec <= 9 || m[2] === "00") return y < 0 ? `${-y} BC` : String(y);
  const d = new Date(Date.UTC(2000, Number(m[2]) - 1, Number(m[3] === "00" ? 1 : m[3])));
  return prec === 10 || m[3] === "00" ? `${d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })} ${y}` : `${d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}, ${y}`;
};
const ageAt = (t, now, end) => {
  const a = /^\+(\d{4})-(\d{2})-(\d{2})/.exec(String(t || "")); if (!a) return null;
  const e = end ? /^\+(\d{4})-(\d{2})-(\d{2})/.exec(String(end)) : null;
  const n = new Date(now), Y = e ? +e[1] : n.getFullYear(), M = e ? +e[2] : n.getMonth() + 1, D = e ? +e[3] : n.getDate();
  if (+a[2] === 0) return null;
  return Y - +a[1] - (M < +a[2] || (M === +a[2] && D < +a[3]) ? 1 : 0);
};
const hav = (a, b) => { const R = 6371.0088, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r; const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
// d: server answer {label, desc, v: [{amount, unit} | {time, prec, asOf} | {label} | {lat, lon}], b?: same for subject 2}
const wdAnswer = (w, d, now = Date.now()) => {
  if (!w || !d || !d.label || !Array.isArray(d.v) || !d.v.length) return null;
  const v = d.v[0], who = d.label, src = "Wikidata";
  const desc = d.desc ? ` · ${d.desc}` : "";
  if (w.fact === "height") {
    const f = UNIT_M[v.unit];
    const amt = Number(v.amount);
    if (!f || !Number.isFinite(amt)) return null;
    const mtr = amt * f, ft = mtr / 0.3048;
    return { kind: "fact", label: `${who} · height`, value: `${fmtNum(mtr, 4)} m`, detail: `${Math.round(ft).toLocaleString("en-US")} ft${desc}`, copy: `${plain(mtr)} m`, src };
  }
  if (w.fact === "population") {
    const n = Number(v.amount);
    if (!Number.isFinite(n) || n <= 0) return null;
    const asOf = v.asOf ? wdDay(v.asOf, 9) : "";
    return { kind: "fact", label: `${who} · population`, value: Math.round(n).toLocaleString("en-US"), detail: `${asOf ? `as of ${asOf}` : ""}${asOf ? desc : desc.slice(3)}`, copy: String(Math.round(n)), src };
  }
  if (w.fact === "age") {
    const age = v.prec >= 11 ? ageAt(v.time, now, d.died) : null;
    if (age == null || d.died) return null; // "how old was" isn't asked; a person who died gets no "age"
    return { kind: "fact", label: `${who} · age`, value: `${age} years`, detail: `born ${wdDay(v.time, v.prec)}${desc}`, copy: String(age), src };
  }
  if (w.fact === "born" || w.fact === "died" || w.fact === "founded" || w.fact === "released") {
    const day = wdDay(v.time, v.prec);
    if (!day) return null;
    let extra = "";
    if (w.fact === "born" && v.prec >= 11) { const died = d.died; const age = ageAt(v.time, now, died); if (age != null) extra = died ? ` · died at ${age}` : ` · age ${age}`; }
    const what = { born: "born", died: "died", founded: "founded", released: "released" }[w.fact];
    return { kind: "fact", label: `${who} · ${what}`, value: day, detail: `${extra.slice(3)}${extra ? desc : desc.slice(3)}`, copy: day, src };
  }
  if (w.fact === "ceo") {
    if (!v.label) return null;
    return { kind: "fact", label: `${who} · CEO`, value: v.label, detail: desc.slice(3), copy: v.label, src };
  }
  if (w.fact === "distance") {
    const b = d.b;
    if (!b || !b.label || !Array.isArray(b.v) || !b.v.length || !Number.isFinite(v.lat) || !Number.isFinite(b.v[0].lat)) return null;
    const km = hav(v, b.v[0]), mi = km / 1.609344;
    return { kind: "fact", label: `${who} to ${b.label} · straight line`, value: `${fmtNum(km, 3)} km`, detail: `${Math.round(mi).toLocaleString("en-US")} mi as the crow flies`, copy: `${Math.round(km)} km`, src };
  }
  return null;
};

// ----- CMU course card (CMU Courses' numbers: ScottyLabs course-tool fce.ts aggregateFCEs + user.ts defaults) -----
// Drop 0% response rate, fall + spring only, Pittsburgh only, exact-duplicate rows merged, the 2 most recent counted
// semesters, means weighted by respondents. rating[7] = teaching, rating[8] = course (0-based).
const SEM = { spring: 1, summer: 2, fall: 3 };
const pct = (x) => { const n = parseFloat(String(x ?? "").replace("%", "")); return Number.isFinite(n) ? n : 0; };
const prettyName = (n) => { const m = /^\s*([^,]+),\s*(.+)$/.exec(String(n || "")); const t = (x) => x.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (a, b, c) => b + c.toUpperCase()); return m ? { full: `${t(m[2])} ${t(m[1])}`, last: t(m[1]) } : { full: t(String(n || "").trim()), last: t(String(n || "").trim().split(" ").pop() || "") }; };
const cmuAgg = (rows) => {
  const seen = new Set();
  const ok = (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!r || !Array.isArray(r.rating) || r.rating.length < 9) return false;
    const sem = String(r.semester || "").toLowerCase();
    if (sem !== "fall" && sem !== "spring") return false;
    if (pct(r.responseRate) <= 0 || !(Number(r.numRespondents) > 0)) return false;
    if (r.location && !/pittsburgh/i.test(String(r.location))) return false;
    const k = JSON.stringify(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const key = (r) => Number(r.year) * 10 + SEM[String(r.semester).toLowerCase()];
  const sems = [...new Set(ok.map(key))].sort((a, b) => b - a).slice(0, 2);
  const use = ok.filter((r) => sems.includes(key(r)));
  if (!use.length) return null;
  const wmean = (rs, f) => { let a = 0, n = 0; for (const r of rs) { const v = Number(f(r)), w = Number(r.numRespondents); if (Number.isFinite(v) && w > 0) { a += v * w; n += w; } } return n ? a / n : null; };
  const latest = use.filter((r) => key(r) === sems[0]);
  const profs = [];
  for (const r of latest) for (const raw of String(r.instructor || "").split(/;|\band\b/)) {
    const nm = raw.trim();
    if (!nm || profs.some((p) => p.raw === nm)) continue;
    const mine = use.filter((x) => String(x.instructor || "").includes(nm));
    profs.push({ raw: nm, ...prettyName(nm), rating: wmean(mine, (x) => x.rating[7]) });
  }
  profs.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const s0 = latest[0];
  return { hrs: wmean(use, (r) => r.hrsPerWeek), teach: wmean(use, (r) => r.rating[7]), course: wmean(use, (r) => r.rating[8]), n: use.reduce((a, r) => a + Number(r.numRespondents), 0), sem: `${String(s0.semester).replace(/^./, (c) => c.toUpperCase())} ${s0.year}`, profs };
};
const one = (x) => (x == null ? "" : (Math.round(x * 10) / 10).toFixed(1));
// c: cmuCourse(q) result; course: {courseID, name, units, prereqs}; fces: rows
const cmuAnswer = (c, course, fces) => {
  if (!c || !c.level || !course || !course.name) return null;
  const agg = cmuAgg(fces);
  const ids = String(course.prereqs || "").match(/\b\d{2}-?\d{3}\b/g) || [];
  const pre = [...new Set(ids.map((x) => (x.includes("-") ? x : `${x.slice(0, 2)}-${x.slice(2)}`)))];
  const parts = [];
  if (course.units != null && String(course.units).trim()) parts.push(`${String(course.units).trim()} units`);
  if (agg && agg.hrs != null) parts.push(`${one(agg.hrs)} hrs/wk`);
  if (agg && agg.course != null) parts.push({ stars: Math.round(agg.course * 10) / 10 });
  if (pre.length) parts.push(`prereq ${pre[0]}${pre.length > 1 ? ` +${pre.length - 1}` : ""}`);
  const profs = agg ? agg.profs.map((p) => ({ full: p.full, last: p.last, r: one(p.rating) })) : [];
  return { kind: "cmu", label: "CMU Courses", title: `${c.id} ${course.name}`, href: `https://cmucourses.com/course/${c.id}`, parts, sem: agg ? agg.sem : "", profs, prof: !!c.prof, copy: "" };
};

// ----- Sports card from the server's ESPN game ({state pre|in|post, detail, date, away, home, league}) -----
const sportsAnswer = (g, now = Date.now()) => {
  if (!g || !g.away || !g.home || !g.away.abbr || !g.home.abbr || !["pre", "in", "post"].includes(g.state)) return null;
  const t = Date.parse(g.date);
  const when = Number.isFinite(t) ? new Date(t).toLocaleString("en-US", g.state === "pre" ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { weekday: "short", month: "short", day: "numeric" }) : "";
  const status = g.state === "in" ? (g.detail || "Live") : g.state === "post" ? (g.detail || "Final") : "Next game";
  const rec = [g.away, g.home].filter((x) => x.record).map((x) => `${x.abbr} ${x.record.replace(/-/g, "–")}`).join(" · ");
  return { kind: "sports", label: g.league || "", live: g.state === "in", status, teams: [g.away, g.home], showScore: g.state !== "pre", detail: [when, rec].filter(Boolean).join(" · "), copy: g.state === "pre" ? "" : `${g.away.abbr} ${g.away.score} – ${g.home.score} ${g.home.abbr}` };
};

// ----- The one local answer for a search, or null. CMU course numbers are left to the CMU card (network). -----
const answer = (q, now = Date.now(), data = {}) => {
  const s = String(q || "").trim();
  if (!s || s.length > 200 || s.startsWith("!")) return null;
  if (/^\d{2}-\d{3}\b/.test(s)) return null;
  return pattern(s) || convert(s) || currency(s, data.fx) || percent(s) || dateMath(s, now) || calc(s);
};

return { pslParse, regDomain, shortTarget, arxivId, docKey, titleKey, deduper, dedupe, namedSites, capSites, listCtx, planPage, SITE_SCORE, sitesFromLists, unblockText, CHEAT_SITES, seoSigns, SEO_MIN, seoVerdict, PAYWALL_SITES, paywalled, cleanSnippet, dateLabel, relDate, upsValid, isbnValid, cmuCourse, fmtNum, calc, convert, percent, dateMath, pattern, currency, eolQuery, eolAnswer, WD_PROP, wdQuery, wdAnswer, cmuAgg, cmuAnswer, sportsAnswer, answer };
})();
// Every plugin request goes through degoog's command address: iPhone content blockers reject /api/plugin/ addresses
const bridge = (route, params = {}, body) => {
  const qs = new URLSearchParams(params);
  if (body !== undefined) qs.set("__body", body);
  const q = `!cleantitles bridge ${route} ${qs}`;
  // Always POST: on iPhone the GET form failed ("Load failed") while POST got through
  const req = fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }), cache: "no-store", ...(body !== undefined && body.length < 50000 ? { keepalive: true } : {}) });
  return req.then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (!j || typeof j.html !== "string") return null;
    const t = document.createElement("textarea");
    t.innerHTML = j.html;
    try { return JSON.parse(t.value); } catch { return null; }
  });
};
// Other plugins' requests (AI Summary...) that the iPhone's content blocker stops are sent again through the bridge
const _fetch0 = window.fetch.bind(window);
window.fetch = async (input, init) => {
  let path = "";
  try {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (u.origin === location.origin && u.pathname.startsWith("/api/plugin/")) path = u.pathname + u.search;
  } catch {}
  if (!path) return _fetch0(input, init);
  try { return await _fetch0(input, init); }
  catch (e) {
    const o = init || {}, method = String(o.method || (input && input.method) || "GET").toUpperCase();
    if (o.body != null && typeof o.body !== "string") throw e;
    const h = o.headers || {}, type = (typeof h.get === "function" ? h.get("Content-Type") : h["Content-Type"] || h["content-type"]) || "";
    const j = await bridge("relay", {}, JSON.stringify({ path, method, body: o.body, type })).catch(() => null);
    if (!j || typeof j.text !== "string") throw e;
    return new Response(j.text, { status: j.status || 200, headers: { "Content-Type": j.type || "text/plain" } });
  }
};
// One look for everything the plugin adds: it enters with degoog's own result fade (once, not again when
// re-attached after a redraw), and lines that sit above results start exactly where the results' text starts
const fadeIn = (e) => { e.classList.add("ct-in"); e.addEventListener("animationend", () => e.classList.remove("ct-in"), { once: true }); return e; };
const lineUp = () => {
  // Lined up with the content under it on every tab and screen size: a result's text, or the edge of the picture grid
  const main = document.getElementById("results-main");
  const c = main && [...main.querySelectorAll("#results-list .result-item .result-title, #results-list .image-card, #results-list .video-card")].find((e) => e.offsetParent);
  if (!c) return;
  const x = Math.round(c.getBoundingClientRect().left - main.getBoundingClientRect().left);
  if (Number.isFinite(x) && x >= 0 && x < 80) main.style.setProperty("--ct-x", `${x}px`);
};
addEventListener("resize", () => requestAnimationFrame(lineUp), { passive: true });
// Same search even if degoog tidied the address (e.g. dropped a #) meanwhile
// Which search a page address is, ignoring what endless scroll adds while you scroll (&loaded=2) and any #
const searchId = (h) => { try { const u = new URL(h); u.hash = ""; u.searchParams.delete("loaded"); return u.toString(); } catch { return String(h).split("#")[0]; } };
const sameSearch = (k) => searchId(location.href) === searchId(k);


// clean-titles: ONE pass per new result, run before the browser draws it (no timers, no re-scans).
// Network work (HD thumbnails, missing video descriptions) only starts for results near the screen.

// Leftover endings like " | Section | The Guardian" or " - Seoul Economic Daily", even when the site name
// doesn't match the address. " - " endings only go when they look like a name (short, capitalised, no numbers)
const SMALL = /^(of|the|and|for|on|in|at|de|la|le|du|&)$/i;
const nameLike = (s) => s.length <= 32 && !/\d/.test(s) && s.split(/\s+/).length <= 4 && s.split(/\s+/).every((w) => /^[A-Z&]/.test(w) || SMALL.test(w));
const stripTail = (t) => {
  for (let i = 0; i < 3; i++) {
    const m = /^(.+)\s+([|–—·-])\s+([^|–—·]+)$/.exec(t);
    if (!m) break;
    const head = m[1].trim(), tail = m[3].trim();
    if (m[2] === "|" ? tail.length <= 40 && head.length >= 12 : nameLike(tail) && head.length >= 20) t = head;
    else break;
  }
  return t;
};

const cleanTitle = (raw, href) => {
  try {
    const title = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!title) return raw;
    let host = "";
    try { host = new URL(href).hostname.toLowerCase().replace(/^www\./, ""); } catch {}
    let t = title.replace(/\s*[|–—·-]\s*(\.\.\.|…)$/, "").trim() || title;
    if (/(^|\.)reddit\.com$/.test(host)) {
      let m = t.match(/^r\/([\w-]+) on Reddit\s*[:\-–—]\s*(.+)$/i);
      if (m) return `${m[2].trim()} : r/${m[1]}`;
      m = t.match(/^(.+?)\s*:\s*r\/([\w-]+)(?:\s*[-|–—]\s*Reddit)?$/i);
      if (m) return `${m[1].trim()} : r/${m[2]}`;
      t = t.replace(/\s*[-|–—]\s*Reddit$/i, "");
      return t.length >= 6 ? t : title;
    }
    const seps = /\s+[|–—·]\s+|\s+-\s+/;
    let parts = t.split(seps);
    const SE = /(^|\.)(stackexchange\.com|stackoverflow\.com|superuser\.com|serverfault\.com|askubuntu\.com|mathoverflow\.net)$/;
    if (SE.test(host) && parts.length >= 2) {
      const siteLike = /stack ?exchange|stack ?overflow|super ?user|server ?fault|ask ?ubuntu|mathoverflow/i;
      if (siteLike.test(parts[parts.length - 1])) parts = parts.slice(0, -1);
      if (parts.length >= 2 && parts[0].length <= 40) parts = parts.slice(1);
      const out = parts.join(" - ").trim();
      return out.length >= 8 ? out : title;
    }
    if (parts.length >= 2 && host) {
      const labels = host.split(".");
      let core = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
      if (labels.length >= 3 && core.length <= 3) core = labels[labels.length - 3];
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const last = norm(parts[parts.length - 1]);
      const brandish = last.length >= 3 && (last.includes(core) || (core.includes(last) && last.length >= 4));
      if (brandish) {
        const out = parts.slice(0, -1).join(" - ").trim();
        if (out.length >= 12) return stripTail(out);
      }
    }
    return stripTail(t);
  } catch {
    return raw;
  }
};

// Adult results only when the search asks for them
const ADULT_HOST = /(porn|xvideos|xnxx|xhamster|redtube|youporn|spankbang|eporner|onlyfans|fansly|chaturbate|stripchat|camsoda|bongacams|livejasmin|rule34|hentai|motherless|txxx|brazzers|bangbros|realitykings|erome|thothub|fapello|nudostar|xxx)|(^|[.-])(sex|nsfw|nudes?|escorts?)([.-]|$)/i;
const ADULT_TEXT = /\b(xxx|nsfw|hentai|milfs?|blowjobs?|cumshots?|creampies?|gangbangs?|deepthroat|(?:free|hd|amateur) porn|porn (?:videos?|clips?|pics?|tube|stars?)|sex (?:videos?|tapes?|cams?|chat)|camgirls?|onlyfans leaks?|nudes? leak(?:ed|s)?)\b/i;
const WANTS_ADULT = /\b(porn\w*|sex\w*|nude\w*|naked|nsfw|xxx|hentai|onlyfans|erotic\w*|milfs?|boobs?|tits?|pussy|dick|cock|fap\w*|r34|rule ?34|lewd)\b/i;
let href = "", wantsAdult = false, webTab = true, wantsDict = true;
// Dictionary pages only when the search is about a word (Bing adds them for words like "under" or "fix")
const DICT = /(^|\.)(merriam-webster\.com|thefreedictionary\.com|dictionary\.cambridge\.org|dictionary\.com|collinsdictionary\.com|oxfordlearnersdictionaries\.com|vocabulary\.com|wordreference\.com|yourdictionary\.com|wiktionary\.org|urbandictionary\.com)$/i;
const readQuery = () => {
  if (location.href === href) return;
  href = location.href;
  try { wantsAdult = WANTS_ADULT.test(new URL(href).searchParams.get("q") || ""); } catch { wantsAdult = false; }
  try { webTab = !new URL(href).searchParams.get("type"); } catch { webTab = true; }
  try {
    const q = (new URL(href).searchParams.get("q") || "").trim();
    wantsDict = q.split(/\s+/).length <= 2 || /\b(define|definition|meaning|means?|synonyms?|antonyms?|pronounc\w*|spell\w*|dictionary|word|etymology|slang)\b/i.test(q);
  } catch { wantsDict = true; }
};
const adult = (host, text) => !wantsAdult && (ADULT_HOST.test(host) || ADULT_TEXT.test(text));
// Results the page never shows: adult ones the search didn't ask for, dictionary pages for non-word searches
const junk = (el) => {
  const a = el.querySelector("a.result-title");
  if (!a) return false;
  let h = "";
  try { h = new URL(a.href).hostname; } catch {}
  return adult(h, a.textContent || "") || (!wantsDict && DICT.test(h.replace(/^www\./, "")));
};

// ===== List pass (Web tab): dedupe -> site prefs -> 2 per site with folds, planned by core.js before paint =====
// Public suffix list: /public/ct/psl.<hash>.js, loaded with defer before this module, sets window.CT_PSL.
// If it failed to load, sites are whole host names (never a guessed suffix).
let PSL0;
const PSL = () => (PSL0 !== undefined ? PSL0 : (PSL0 = typeof window.CT_PSL === "string" && window.CT_PSL ? CT.pslParse(window.CT_PSL) : null));
// Prefer / Lower / Hide per site: this browser's copy of your choices in degoog's lists ({domain: choice}),
// refreshed from the server on each page load. degoog already applied them on the server; the page uses them for
// the 2-per-site limit (Prefer skips it) and keeps them within each endless-scroll page.
const SITES_KEY = "ct-sites";
let SITES = {};
try { const c = JSON.parse(localStorage.getItem(SITES_KEY) || "null"); if (c && typeof c === "object") SITES = c; } catch {}
const saveSites = () => { try { localStorage.setItem(SITES_KEY, JSON.stringify(SITES)); } catch {} };
// Sites lowered by the anti-SEO checks ("auto" in the menu), and whether those checks are on (Settings)
// Also: will ai-summary answer (a model set, not off, "only for questions"?), so its spot is kept only when it will come
// and the ECB currency rates for the answer card (fx)
let SITES_AUTO = [], SEO_ON = false, AI_ON = { on: false }, FX = null;
try { const c = JSON.parse(localStorage.getItem("ct-sites-auto") || "null"); if (c && Array.isArray(c.auto)) { SITES_AUTO = c.auto; SEO_ON = !!c.seo; if (c.ai) AI_ON = c.ai; if (c.fx && c.fx.rates) FX = c.fx; } } catch {}
const takeSites = (j) => {
  if (!j || !j.sites || typeof j.sites !== "object") return;
  SITES = j.sites; saveSites();
  SITES_AUTO = Array.isArray(j.auto) ? j.auto : []; SEO_ON = !!j.seo; AI_ON = j.ai && typeof j.ai === "object" ? j.ai : { on: false };
  if (j.fx && j.fx.rates) FX = j.fx;
  try { localStorage.setItem("ct-sites-auto", JSON.stringify({ auto: SITES_AUTO, seo: SEO_ON, ai: AI_ON, fx: FX })); } catch {}
};
bridge("sites", {}).then(takeSites).catch(() => {});
// Only whole-site entries count here (a line for one subdomain is left to degoog's own filter)
const sitePrefs = () => { const o = {}; for (const [d, v] of Object.entries(SITES)) if (siteOf(d) === d) o[d] = v; return o; };
const planned = new WeakSet();
let LP = null;
const listPass = () => {
  if (!webTab) return;
  const list = document.getElementById("results-list");
  if (!list) return;
  const fresh = [...list.querySelectorAll(".result-item")].filter((el) => !planned.has(el));
  if (!fresh.length) return;
  fresh.forEach((el) => planned.add(el));
  const key = searchId(location.href);
  // New search, or degoog redrew the whole list: start over
  if (!LP || LP.key !== key || !LP.first.isConnected) {
    list.querySelectorAll(".ct-fold").forEach((x) => x.remove());
    let q = "";
    try { q = new URL(location.href).searchParams.get("q") || ""; } catch {}
    LP = { key, first: fresh[0], ctx: CT.listCtx(q, PSL(), sitePrefs()), pend: [] };
  }
  const items = [];
  for (const el of fresh) {
    if (junk(el)) continue;
    const a = el.querySelector("a.result-title");
    if (a) items.push({ el, url: el.dataset.resultUrl || a.href, title: a.textContent || "" });
  }
  // Anti-SEO: the first page's results (as degoog ranked them) go to the server, which adds the signs up per site.
  // Worked out after this pass, so it never holds up drawing.
  if (SEO_ON && !LP.seo && fresh[0] === LP.first && !/[?&]page=[2-9]/.test(key)) {
    LP.seo = true;
    const q = (() => { try { return new URL(key).searchParams.get("q") || ""; } catch { return ""; } })();
    const seoItems = items.map((x) => ({ url: x.url, title: x.title, snippet: x.el.querySelector(".result-snippet")?.textContent || "" }));
    if (q && !q.startsWith("!") && seoItems.length >= 5) setTimeout(() => { try { const r = CT.seoSigns(seoItems, PSL()); bridge("seo", {}, JSON.stringify(r)).catch(() => {}); } catch {} }, 0);
  }
  const p = CT.planPage(items, LP.ctx);
  const hide = (r, flag) => { r.el.style.display = "none"; r.el.dataset[flag] = "1"; };
  p.dups.forEach((r) => hide(r, "ctDup"));
  p.hidden.forEach((r) => hide(r, "ctHide"));
  p.capped.forEach((r) => hide(r, "ctCap")); // still usable as sitelinks, like v49
  for (const f of p.folds.values()) f.items.forEach((r) => hide(r, "ctCap"));
  // Prefer / Lower changed the order: put this page's shown results in the planned order (hidden ones stay put)
  const dom = items.map((x) => x.el).filter((el) => el.style.display !== "none");
  if (p.shown.some((r, i) => r.el !== dom[i])) {
    const mark = document.createComment("");
    dom[0].before(mark);
    for (const r of p.shown) mark.before(r.el);
    mark.remove();
  }
  // Other versions of the one shown copy (papers): "PDF · HTML · v7 latest", drawn with the result
  for (const r of p.shown) if (r.alts.length) {
    const box = mk("div", "ct-alts");
    r.alts.forEach((x, i) => { if (i) box.append(" · "); const l = mk("a", "", x.label); l.href = x.url; box.append(l); });
    (r.el.querySelector(".result-snippet") || r.el.querySelector("a.result-title"))?.after(box);
  }
  for (const [site, f] of p.folds) { LP.pend.push({ site, after: f.after.el, els: f.items.map((r) => r.el) }); }
};
// Folds go in after the boxes (sitelinks, Discussions) took what they use, in the same pass, so counts are final
const foldPass = () => {
  if (!LP || !LP.pend.length) return;
  const pend = LP.pend;
  LP.pend = [];
  for (const f of pend) {
    const els = f.els.filter((el) => el.isConnected && !el.classList.contains("ct-grouped"));
    if (!els.length || !f.after.isConnected || f.after.classList.contains("ct-grouped")) continue;
    const row = mk("div", "ct-fold");
    const b = mk("button", "ct-fold-b", `${els.length} more from ${f.site}`);
    b.type = "button";
    b.setAttribute("aria-expanded", "false");
    b.append(mk("span", "ct-chev", "⌄"));
    row.append(b);
    f.after.after(row);
    row.after(...els);
    // Tap: the folded results open in place, where the line was
    b.addEventListener("click", () => {
      for (const el of els) { el.style.display = ""; delete el.dataset.ctCap; fadeIn(el); }
      row.remove();
    }, { once: true });
  }
};

// HD thumbnails: only for hosts the plugin can upgrade, swapped in only once the sharp copy has loaded
const HD_HOST = /(^|\.)(ytimg\.com|bing\.com|mm\.bing\.net|imgs\.search\.brave\.com)$/i;
const canHD = (src) => {
  try {
    const u = new URL(src, location.href);
    const inner = u.pathname.includes("/api/proxy/image") ? u.searchParams.get("url") || "" : u.href;
    return HD_HOST.test(new URL(inner).hostname);
  } catch { return false; }
};
// News-tab layout (banner vs small thumbnail beside the text, class ct-lowres) is decided once, before paint, from
// what the address says: a host the plugin can upgrade (hdImg crossfades the sharp copy into the same box) or a
// size hint of 480px+ keeps the banner; anything else gets the thumbnail. v49 added ct-lowres after the picture
// loaded, which re-laid the card after paint. All recorded News pictures (steelers, nvidia) are bing.com th?w=234
// or Brave rs:fit:200, both upgradable, so they keep the banner.
const sizeHint = (src) => {
  try {
    const u = new URL(src, location.href);
    const inner = new URL(u.pathname.includes("/api/proxy/image") ? u.searchParams.get("url") || "" : u.href);
    const w = Number(inner.searchParams.get("w")) || Number((/\/rs:fit:(\d+)/.exec(inner.pathname) || [])[1]) || 0;
    return w;
  } catch { return 0; }
};
const lowres = (el, img) => { const src = img.getAttribute("src") || ""; if (!canHD(src) && sizeHint(src) < 480) el.classList.add("ct-lowres"); };
const hdImg = (img) => {
  // Wait for the small picture so its real size is known
  if (!img.complete) { img.addEventListener("load", () => hdImg(img), { once: true }); img.addEventListener("error", () => hdImg(img), { once: true }); return; }
  const nw = img.naturalWidth, nh = img.naturalHeight;
  // Size the picture actually fills on this screen (object-fit: cover), in real pixels
  const need = nw ? Math.ceil(Math.max(img.clientWidth, nh ? img.clientHeight * nw / nh : 0) * (window.devicePixelRatio || 1)) : 640;
  if (nw && need <= nw * 1.15) return; // already sharp at this size: no request at all
  const orig = img.getAttribute("src") || "";
  if (!canHD(orig)) return; // no bigger copy exists anywhere
  const probe = new Image();
  probe.onload = () => {
    const wrap = img.parentElement;
    // A frame degoog hid (small picture failed) stays hidden: showing it now would push the text over
    if (!(probe.naturalWidth > nw) || img.getAttribute("src") !== orig || !wrap || wrap.style.display === "none" || !img.isConnected) return;
    // Same-size crossfade: the sharp copy, decoded first, lies exactly over the small one (same box, same
    // object-fit) and fades in with opacity only, so nothing moves or blinks
    (probe.decode ? probe.decode() : Promise.resolve()).catch(() => {}).then(() => {
      if (!img.isConnected) return;
      probe.alt = "";
      probe.className = `${img.className} ct-hd`;
      wrap.append(probe);
    });
  };
  bridge("hd", { w: Math.min(1280, Math.max(160, need)), src: orig })
    .then((j) => { if (j && j.to) probe.src = j.to; })
    .catch(() => {});
};

const PHONE = matchMedia("(max-width: 767px)");
// v50 cut: v49 fetched missing YouTube descriptions and appended them after the result was on screen. That
// grows the result (text changes, everything below moves) and it isn't sure to arrive, so no space can be kept for it.

// One shared watcher: runs a result's network work once it comes within ~1.5 screens
const work = new WeakMap();
const near = new IntersectionObserver((list) => {
  for (const e of list) {
    if (!e.isIntersecting) continue;
    near.unobserve(e.target);
    const f = work.get(e.target);
    work.delete(e.target);
    if (f) f();
  }
}, { rootMargin: "800px 0px" });

const row = (el) => {
  const a = el.querySelector("a.result-title");
  if (!a) return;
  if (junk(el)) { el.style.display = "none"; return; }
  if (el.dataset.ctDup || el.dataset.ctHide) return; // never shown: no cleanup, no network work
  const text = a.textContent || "";
  let u = null;
  try { u = new URL(a.href); } catch {}
  const out = cleanTitle(text, a.href);
  if (out && out !== text.replace(/\s+/g, " ").trim()) { a.title = text.trim(); a.textContent = out; }
  // Link line: just the site name, like Google on phones (the full address shows on hover)
  const cite = el.querySelector(".result-cite");
  let site = "";
  try { site = new URL(el.dataset.resultUrl || a.href).hostname.replace(/^www\./, ""); } catch {}
  // Forum threads (any tab): the community is the source ("r/Jersey", "Stack Overflow"), not repeated in the title,
  // and Reddit's "Archived post. New comments cannot be posted..." filler is dropped from the description
  const fn = u ? forumName(u, site) : "";
  if (fn) {
    site = fn;
    const t2 = a.textContent.replace(/\s*[:|\-–—]\s*r\/[\w-]+\s*$/i, "").trim();
    if (t2 && t2 !== a.textContent.trim()) { a.title = a.title || a.textContent.trim(); a.textContent = t2; }
    const sp = el.querySelector(".result-snippet");
    if (sp) for (const n of sp.childNodes) if (n.nodeType === 3) n.data = n.data.replace(/\s*Archived post\.\s*New comments (cannot be posted|\.\.\.)[^.]*\.?(\s*and votes cannot be cast\.?)?/gi, " ").replace(/\s{2,}/g, " ");
  }
  if (cite && site && cite.textContent.trim() !== site) { cite.title = cite.textContent.trim(); cite.textContent = site; }
  // Snippet: a leading date ("Feb 1, 2022 ... text", "3 days ago —") and junk ellipses go (core cleanSnippet);
  // the date (degoog's own first, else the one from the text) moves to the source line, after the site name
  const p0 = el.querySelector(".result-snippet");
  if (p0) {
    let dRaw = "";
    const rd = p0.querySelector(".result-date");
    if (rd) { dRaw = (rd.textContent || "").trim(); rd.remove(); }
    let n0 = p0.firstChild;
    while (n0 && n0.nodeType === 3 && !n0.data.trim()) n0 = n0.nextSibling;
    if (n0 && n0.nodeType === 3) { const c = CT.cleanSnippet(n0.data); if (!dRaw) dRaw = c.date; n0.data = c.text; }
    const label = dRaw ? CT.dateLabel(dRaw) : "";
    if (label && cite) { const d = mk("span", "ct-date", label); d.dataset.raw = dRaw; cite.after(d); }
  }
  // "Paywall": a word on the source line, drawn with the result (core PAYWALL_SITES)
  if (cite && u && CT.paywalled(u.hostname, PSL())) { const t = mk("span", "ct-paywall", "Paywall"); (el.querySelector(".result-url-row .ct-date") || cite).after(t); }
  const img = el.querySelector(".result-thumbnail-wrap img");
  if (img) { if (/[?&]type=news\b/.test(location.search)) lowres(el, img); work.set(el, () => hdImg(img)); near.observe(el); }
};

// AI-image sites (laylavish's list, from the server; Images tab only): this browser's copy, checked each page load
let AIIMG = null, AIV = "";
try { const c = JSON.parse(localStorage.getItem("ct-aiimg") || "null"); if (c && Array.isArray(c.list)) { AIIMG = new Set(c.list); AIV = c.v || ""; } } catch {}
if (/[?&]type=images\b/.test(location.search)) bridge("aiimg", { v: AIV }).then((j) => {
  if (!j || typeof j.v !== "string") return;
  if (!j.v) { AIIMG = null; try { localStorage.removeItem("ct-aiimg"); } catch {} return; }
  if (Array.isArray(j.list)) { AIIMG = new Set(j.list); try { localStorage.setItem("ct-aiimg", JSON.stringify({ v: j.v, list: j.list })); } catch {} }
}).catch(() => {});
const aiImg = (host) => { if (!AIIMG || !host) return false; for (let h = host; h.includes("."); h = h.slice(h.indexOf(".") + 1)) if (AIIMG.has(h)) return true; return false; };
const card = (el, isImage) => {
  const src = el.querySelector(isImage ? ".image-source" : ".video-source");
  const t = el.querySelector(isImage ? ".image-title" : ".video-title");
  const raw = (src && src.textContent || "").trim();
  const host = raw.toLowerCase().replace(/^www\./, "");
  const text = t && t.textContent || "";
  if (adult(host, text)) { el.style.display = "none"; return; }
  if (!isImage) return;
  if (aiImg(host)) { el.style.display = "none"; el.dataset.ctAi = "1"; return; }
  if (src && host !== raw) src.textContent = host;
  if (t && host) {
    const out = cleanTitle(text, `https://${host}/`);
    if (out && out !== text) { t.title = text.trim(); t.textContent = out; }
  }
};

const SEL = ".result-item, .image-card, .video-card";
const done = new WeakSet();
const handle = (el) => {
  if (done.has(el)) return;
  done.add(el);
  try {
    const c = el.classList;
    if (c.contains("result-item")) { row(el); siteItems(el); }
    else card(el, c.contains("image-card"));
  } catch (e) { console.warn("[clean-titles]", e); }
};
const scan = (n) => {
  if (n.matches(SEL)) handle(n);
  if (n.firstElementChild) n.querySelectorAll(SEL).forEach(handle);
};

// Command word at the END works like at the start ("ephemeral def", "boston weather", "tokyo time"), for every
// command with natural language on; the search stays as typed, the command's card goes on top, results below (like Google)
const CODE_TAIL = /\b(python|py|ruby|scala|elixir|groovy|kotlin|swift|lisp|clojure|julia|crystal|nim|js|javascript|ts|typescript|java|go|golang|rust|php|bash|sql|c\+\+|c#|csharp)$/i;
let tails = [["def", "define"], ["define", "define"], ["definition", "define"], ["meaning", "define"]];
fetch("/api/commands", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => {
    const add = [];
    for (const c of (j && j.commands) || []) {
      if (!c.naturalLanguage || !c.trigger) continue;
      for (const w of [c.trigger, ...(c.aliases || []), ...(c.naturalLanguagePhrases || [])]) if (w) add.push([String(w).toLowerCase(), c.trigger]);
    }
    tails = [...tails, ...add].sort((x, y) => y[0].length - x[0].length);
    glance();
  })
  .catch(() => {});
// Weather words anywhere ("weather in nyc tomorrow"): the leftover words are the place; no place = no card
const WX = /\b(weather|wether|forecast|temperature|temp)\b/i;
const WX_DROP = /\b(weather|wether|forecast|temperature|temp|today|tonight|tomorrow|tommorow|tmrw|now|current|currently|this|next|week|weekend|hourly|daily|10|day|radar|what'?s|whats|what|is|the|teh|how'?s|in|for|at|of|like|will|it|be)\b/gi;
const bangFor = (q) => {
  const t = String(q || "").trim();
  if (!t || /(^|\s)!\S+/.test(t)) return null;
  const low = t.toLowerCase();
  for (const [w, trig] of tails) {
    if (!low.endsWith(" " + w)) continue;
    const rest = t.slice(0, t.length - w.length).trim();
    if (!rest || CODE_TAIL.test(rest)) return null;
    if (/^((what'?s|whats|what|is|the|my|current|local|right|now)\s*)+$/i.test(rest)) return `!${trig}`;
    return `!${trig} ${rest}`;
  }
  if (WX.test(t)) {
    const place = t.replace(WX_DROP, " ").replace(/[?,.!]/g, " ").replace(/\s+/g, " ").trim();
    if (place) return `!weather ${place}`;
  }
  return null;
};
const cardCache = new Map();
// Search whose results are already on screen (set at the end of each pass). From then on nothing goes in above them:
// a card that comes after that is kept for next time but not shown on this page
let drawnFor = "";
const markDrawn = () => { if (document.querySelector("#results-list .result-item, #results-list .image-card, #results-list .video-card")) drawnFor = searchId(location.href); };
const glance = () => {
  const g = document.getElementById("at-a-glance");
  if (!g || !webTab) return;
  let q = "";
  try { q = (new URL(location.href).searchParams.get("q") || "").trim(); } catch {}
  const bang = bangFor(q);
  if (!bang) return;
  const good = [...g.querySelectorAll(".command-result")].some((c) => c.style.display !== "none" && c.parentElement?.style.display !== "none" && !/^\s*Usage:/.test(c.textContent));
  if (good) return;
  const put = (html) => {
    if (!html || g.querySelector(".ct-card")) return;
    g.style.display = "";
    g.innerHTML = `<div class="command-result ct-card">${html}</div>`;
    g.querySelectorAll("script").forEach((o) => { const n = document.createElement("script"); n.textContent = o.textContent; g.appendChild(n); });
  };
  const key = searchId(location.href);
  if (cardCache.has(bang)) { if (drawnFor !== key) put(cardCache.get(bang)); return; }
  cardCache.set(bang, "");
  fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: bang }), cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const html = d && d.html && !/Usage:|not found|could not|no results|error/i.test(d.html.replace(/<[^>]+>/g, " ")) ? d.html : "";
      cardCache.set(bang, html);
      if (drawnFor !== key && sameSearch(key)) put(html); // results not drawn yet: nothing below it moves
    })
    .catch(() => cardCache.delete(bang));
};

// Server answers a page needs for a search (typo fix + related searches, People also ask): asked as soon as the
// search's address is known (page load or a new search), in parallel with the engines. Used only if the answer is
// in hand when the results arrive, so it's drawn in the same pass; a later answer is dropped, never inserted after
// the results are on screen. data: undefined = still waiting, null = none.
const early = new Map();
const ask = (route, key, params) => {
  const e = { key, data: undefined };
  early.set(route, e);
  bridge(route, params).then((j) => { e.data = j || null; }, () => { e.data = null; });
};
const ready = (route, key) => { const e = early.get(route); return e && e.key === key ? e.data : undefined; };
let earlyFor = "";
const earlyStart = () => {
  const key = searchId(location.href);
  if (earlyFor === key) return;
  earlyFor = key;
  early.clear();
  let u;
  try { u = new URL(key); } catch { return; }
  const q = (u.searchParams.get("q") || "").trim();
  if (!q) return;
  const from = (u.searchParams.get("ct_from") || "").trim();
  ask("fix", key, { q, ...(u.searchParams.has("ct_keep") ? { keep: 1 } : {}), ...(u.searchParams.has("ct_acc") && from ? { acc: from } : {}) });
  if (webTab && Number(u.searchParams.get("page") || 1) <= 1 && !q.startsWith("!")) {
    ask("qs", key, { q });
    // Versions / support (endoflife.date): only the product name is sent; drawn with the results if in hand by then
    const eq = CT.eolQuery(q);
    if (eq) ask("eol", key, { p: eq.slug });
    // Facts (Wikidata): only the fact asked and the subject's name are sent
    const wq = !eq && !CT.answer(q, Date.now(), { fx: FX }) && CT.wdQuery(q);
    if (wq) ask("wd", key, { f: wq.fact, s: wq.s, ...(wq.s2 ? { s2: wq.s2 } : {}) });
    // CMU course card: "15-213" (and "15213", which the server answers only if that course exists: it's also a ZIP)
    const cq = cmuQ(q);
    if (cq && cq.level) ask("cmu", key, { id: cq.id });
    // A team's game (ESPN): short searches made of words only go to this server, which knows the team names
    if (!eq && !wq && !cq && /^[a-z][a-z .'&-]*$/i.test(q) && q.split(/\s+/).length <= 6 && !CT.answer(q, Date.now(), { fx: FX })) ask("sports", key, { q });
    // Top stories: the News search starts now, in parallel, only for a search that looked like news last time
    if (SHOW.news && newsy.has(qHash(q))) {
      const e = { key, data: undefined };
      early.set("news", e);
      fetch(`/api/search?q=${encodeURIComponent(q)}&type=news`).then((x) => (x.ok ? x.json() : null))
        .then((j) => { e.data = j && Array.isArray(j.results) ? j : null; }, () => { e.data = null; });
    }
  }
};

// Typo fix line above the results, related searches below them (Web tab), and learning from your results
const nearWord = (a, b) => {
  const lim = Math.max(1, Math.round(a.length / 3));
  if (Math.abs(a.length - b.length) > lim || a === b) return false;
  let p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const r = [i];
    for (let j = 1; j <= b.length; j++) r[j] = Math.min(p[j] + 1, r[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = r;
  }
  return p[b.length] <= lim;
};
const lower = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
let extrasFor = "";
const extras = () => {
  if (extrasFor === searchId(location.href)) return;
  const list = document.getElementById("results-list");
  if (!list || !list.querySelector(".result-item, .image-card, .video-card")) return;
  const key = (extrasFor = searchId(location.href));
  document.querySelectorAll("#ct-fix, #ct-related").forEach((e) => e.remove());
  let q = "", from = "";
  try {
    const u = new URL(key);
    q = (u.searchParams.get("q") || "").trim();
    from = (u.searchParams.get("ct_from") || "").trim();
  } catch {}
  if (!q) return;
  const go = (text, extra) => {
    const u = new URL(key);
    u.searchParams.set("q", text);
    for (const k of ["page", "ct_from", "ct_keep", "ct_acc"]) u.searchParams.delete(k);
    for (const [k, v] of Object.entries(extra || {})) u.searchParams.set(k, v);
    return u.toString();
  };
  // What this page's results say: titles, descriptions and site addresses of the first 10 shown
  const rows = [...list.querySelectorAll(".result-item")].filter((r) => r.style.display !== "none").slice(0, 10);
  const text = ` ${rows.map((r) => `${r.textContent} ${(r.querySelector("a.result-title") || {}).href || ""}`).join(" ").toLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ")} `;
  const count = (w) => text.split(` ${w} `).length - 1;
  if (webTab && rows.length) {
    const t = rows.map((r) => (r.querySelector("a.result-title") || {}).textContent || "");
    bridge("learn", {}, JSON.stringify({ t })).catch(() => {});
  }
  ((j) => {
      if (!j || !sameSearch(key) || !list.isConnected) return; // not in hand when the results came: dropped
      // Fixes that weren't sure before searching, like Google's "Did you mean": offered (never forced) only when
      // the results never use the typed word but clearly use one of its candidates (so names your results
      // know, like "Vitamix", stay as typed). Tap it once and that fix happens by itself from then on
      let dym = null;
      if (!from && webTab && j.words && j.words.length) {
        const out = lower(j.fix || q).split(" ");
        let changed = false;
        const tokens = text.trim().split(" ").length;
        for (const { w, c, p } of j.words) {
          if (count(w)) continue;
          let best = null, bn = 1;
          // A candidate only counts when the results use it well beyond chance: 4x more than everyday English would
          for (const x of c) { const n = count(x); if (n > bn && n > 4 * tokens * ((p && p[x]) || 0)) { bn = n; best = x; } }
          // ...or the word or word pair the results use most that is a couple of letters away (new names:
          // "asurascxns" -> "asura scans" when the results keep saying "Asura Scans")
          if (w.length >= 4) {
            const tk = text.trim().split(" "), seen = new Map();
            tk.forEach((x, k) => { for (const y of [x, k + 1 < tk.length ? `${x} ${tk[k + 1]}` : ""]) if (y) seen.set(y, (seen.get(y) || 0) + 1); });
            for (const [y, n] of seen) if (n > bn && !/\d/.test(y) && nearWord(w, y.replace(/ /g, ""))) { bn = n; best = y; }
          }
          if (best) { for (let k = 0; k < out.length; k++) if (out[k] === w) out[k] = best; changed = true; }
        }
        if (changed) dym = out.join(" ");
      }
      if (!dym && !from && j.dym) dym = lower(j.dym);
      // Keep words the results do use, written joined to a neighbour ("open ai" when they say "OpenAI")
      if (dym) {
        const qw = lower(j.fix || q).split(" "), dw = dym.split(" ");
        if (qw.length === dw.length) {
          for (let k = 0; k < qw.length; k++) if (dw[k] !== qw[k] && ((k > 0 && count(qw[k - 1] + qw[k])) || (k + 1 < qw.length && count(qw[k] + qw[k + 1])))) dw[k] = qw[k];
          dym = dw.join(" ") === qw.join(" ") ? null : dw.join(" ");
        }
      }
      const link = (s, href) => { const a = document.createElement("a"); a.href = href; a.textContent = s; return a; };
      // Like Google: the fixed words in bold italics, the rest plain
      const marked = (s, href) => {
        const a = document.createElement("a");
        a.href = href;
        const was = new Set(lower(q).split(" "));
        s.split(" ").forEach((w, k) => {
          if (k) a.append(" ");
          if (was.has(w)) a.append(w);
          else { const b = document.createElement("b"), i = document.createElement("i"); i.textContent = w; b.append(i); a.append(b); }
        });
        return a;
      };
      if (j.fix || dym) {
        const box = document.createElement("div");
        box.id = "ct-fix";
        const l1 = document.createElement("div");
        if (j.fix) {
          l1.append("Showing results for ", marked(j.fix, go(j.fix)));
          const l2 = document.createElement("div");
          l2.className = "ct-fix-alt";
          l2.append("Search instead for ", link(q, go(`"${q}"`, { ct_keep: "1" })));
          box.append(l1, l2);
        } else {
          l1.append("Did you mean: ", marked(dym, go(dym, { ct_from: q, ct_acc: "1" })));
          box.append(l1);
        }
        (document.getElementById("results-main") || list.parentElement).prepend(fadeIn(box));
        lineUp();
      }
      if (webTab && j.related && j.related.length) {
        const box = document.createElement("div");
        box.id = "ct-related";
        const h = document.createElement("h3");
        h.textContent = "Related searches";
        const g = document.createElement("div");
        g.className = "ct-rel-grid";
        for (const r of j.related) g.append(link(r, go(r)));
        box.append(h, g);
        list.after(fadeIn(box));
      }
    })(ready("fix", key));
};

// ===== Site choices, People also ask, and search Tools =====
const goTo = (text) => {
  const u = new URL(location.href);
  u.searchParams.set("q", text);
  for (const k of ["page", "ct_from", "ct_keep", "ct_acc"]) u.searchParams.delete(k);
  return u.toString();
};
const rowHost = (x) => { const w = x.querySelector(".result-actions"); return w ? w.dataset.host || "" : ""; };
// ===== Sites: Prefer / Normal / Lower / Hide, one rounded group in each result's menu (replaces Rank / Block) =====
// Stored in degoog's own block and score lists (core SITE_SCORE), through degoog's Settings routes with your
// Settings sign-in, so degoog applies them on the server on every tab. This browser keeps a read-only copy
// (ct-sites, refreshed from the server each page load) for the parts the page does: Prefer skips the 2-per-site limit.
const SITE_CHOICES = [["prefer", "Prefer"], ["normal", "Normal"], ["lower", "Lower"], ["hide", "Hide"]];
const siteOf = (host) => { const h = String(host || "").toLowerCase().replace(/^www\./, ""); return (h && CT.regDomain(h, PSL())) || h; };
const siteItems = (el) => {
  const menu = el.querySelector(".result-actions-menu");
  const host = rowHost(el);
  if (!menu || !host || menu.querySelector(".ct-seg")) return;
  const cur = SITES[siteOf(host)] || "normal";
  const seg = mk("div", "ct-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", `Results from ${siteOf(host)}`);
  for (const [v, label] of SITE_CHOICES) {
    const b = mk("button", "ct-seg-b", label);
    b.type = "button";
    b.dataset.ctSite = v;
    b.setAttribute("aria-pressed", String(v === cur));
    seg.append(b);
  }
  menu.prepend(seg);
  if (cur === "lower" && SITES_AUTO.includes(siteOf(host))) seg.after(mk("div", "ct-seg-note", "Lowered automatically (SEO signs). Your choice here wins."));
};
const settingsFetch = (path, body) => {
  let tok = null;
  try { tok = sessionStorage.getItem("degoog-settings-token"); } catch {}
  const h = body ? { "Content-Type": "application/json" } : {};
  if (tok) h["x-settings-token"] = tok;
  return fetch(path, body ? { method: "POST", headers: h, credentials: "same-origin", body: JSON.stringify(body) } : { headers: h, credentials: "same-origin" });
};
// Returns "" when saved, else what to tell the user
const saveSite = async (site, pref) => {
  try {
    if (SITES[site] === "hide" && pref !== "hide") {
      const g = await settingsFetch("/api/settings/general");
      if (g.status === 401) return "Sign in to Settings first";
      if (!g.ok) return "Couldn't save";
      const j = await g.json();
      // degoog leaves a very long list out of this answer: writing it back would erase it
      if (j.degoogOversizedFields && j.degoogOversizedFields.domainBlockList) return "Block list too long: change it in Settings";
      const w = await settingsFetch("/api/settings/field", { key: "domainBlockList", value: CT.unblockText(j.domainBlockList || "", site) });
      if (!w.ok) return w.status === 401 ? "Sign in to Settings first" : "Couldn't save";
    }
    const r = await settingsFetch("/api/settings/domain-action", pref === "hide" ? { kind: "block", source: site } : { kind: "score", source: site, score: CT.SITE_SCORE[pref] });
    return r.ok ? "" : r.status === 401 ? "Sign in to Settings first" : "Couldn't save";
  } catch { return "Couldn't save"; }
};
document.addEventListener("click", async (e) => {
  const b = e.target.closest && e.target.closest(".ct-seg-b");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const wrap = b.closest(".result-actions"), menu = b.closest(".result-actions-menu"), seg = b.closest(".ct-seg");
  const site = siteOf(wrap ? wrap.dataset.host : ""), pref = b.dataset.ctSite;
  if (!site || !seg || seg.dataset.busy) return;
  seg.dataset.busy = "1";
  const msg = await saveSite(site, pref);
  delete seg.dataset.busy;
  // Problem: said inside the menu, which stays open (fixed-height line, so the menu doesn't change size twice)
  let note = menu && menu.querySelector(".ct-seg-note");
  if (msg) { if (!note && menu) { note = mk("div", "ct-seg-note"); seg.after(note); } if (note) note.textContent = msg; return; }
  if (note) note.remove();
  if (pref === "normal") delete SITES[site]; else SITES[site] = pref;
  saveSites();
  // The server reads the lists again, so the Settings list shows this choice too
  bridge("sites", {}).then(takeSites).catch(() => {});
  if (menu) menu.hidden = true;
  const tg = wrap && wrap.querySelector(".result-actions-toggle");
  if (tg) tg.setAttribute("aria-expanded", "false");
  document.querySelectorAll(".ct-seg").forEach((g) => { const h = g.closest(".result-actions"); if (h && siteOf(h.dataset.host) === site) g.querySelectorAll(".ct-seg-b").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.ctSite === pref))); });
  // Your tap, so this page follows at once: Hide takes that site's results away, Prefer moves them up, Lower down
  const list = document.getElementById("results-list");
  if (!list || pref === "normal") return;
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => siteOf(rowHost(x)) === site);
  if (pref === "hide") rows.forEach((x) => { x.style.display = "none"; x.dataset.ctHide = "1"; });
  else if (pref === "prefer") list.prepend(...rows);
  else list.append(...rows);
}, true);

// People also ask, after the 3rd result: tap a question to see the best answer degoog finds for it
let paaFor = "";
// 3rd visible result right now (degoog can redraw the list after People also ask was requested)
const paaAnchor = () => [...(document.getElementById("results-list")?.querySelectorAll(".result-item, .ct-grp") || [])].filter((x) => x.style.display !== "none" && !x.classList.contains("ct-grouped"))[2];
let paaBox = null;

const paa = () => {
  if (!webTab) return;
  if (paaFor === searchId(location.href)) {
    // list was redrawn and took the box with it: put it back
    if (paaBox && !paaBox.isConnected) paaAnchor()?.after(paaBox);
    return;
  }
  const list = document.getElementById("results-list");
  if (!list) return;
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none");
  if (rows.length < 4) return;
  const key = (paaFor = searchId(location.href));
  let q = "", page = 1;
  try { const u = new URL(key); q = (u.searchParams.get("q") || "").trim(); page = Number(u.searchParams.get("page") || 1); } catch {}
  const old = document.getElementById("ct-qa");
  if (old) old.remove();
  paaBox = null;
  if (!q || page > 1 || q.startsWith("!")) return;
  ((j) => {
      // Not in hand when the results came (or none): dropped for this search
      if (!j || !Array.isArray(j.q)) return;
      if (j.q.length < 2) return;
      const box = document.createElement("div");
      box.id = "ct-qa";
      const h = document.createElement("h3");
      h.textContent = "People also ask";
      box.append(h);
      // Words written the way your results write them ("putty" -> "PuTTY")
      const cased = new Map();
      for (const r of document.querySelectorAll("#results-list .result-item .result-title")) for (const w of r.textContent.match(/[\p{L}\p{N}][\p{L}\p{N}'+.#-]*/gu) || []) {
        const k = w.toLowerCase(); if (w === k) continue;
        const m = cased.get(k) || new Map(); m.set(w, (m.get(w) || 0) + 1); cased.set(k, m);
      }
      const fixCase = (t) => t.replace(/[\p{L}\p{N}][\p{L}\p{N}'+.#-]*/gu, (w, i) => {
        const m = cased.get(w.toLowerCase());
        if (!m || !q.toLowerCase().split(/\s+/).includes(w.toLowerCase())) return w;
        const best = [...m].sort((a, b) => b[1] - a[1])[0][0];
        return i === 0 ? best[0].toUpperCase() + best.slice(1) : best;
      });
      for (const raw of j.q) {
        const text = fixCase(raw);
        const d = document.createElement("details");
        const s = document.createElement("summary");
        s.textContent = text;
        const body = document.createElement("div");
        body.className = "ct-qa-a";
        d.append(s, body);
        d.addEventListener("toggle", () => {
          if (!d.open || body.dataset.done) return;
          body.dataset.done = "1";
          body.textContent = "Loading…";
          const more = document.createElement("a");
          more.className = "ct-qa-more";
          more.href = goTo(text);
          more.textContent = `Search for: ${text}`;
          fetch(`/api/search?q=${encodeURIComponent(text)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((sj) => {
              body.textContent = "";
              const top = sj && Array.isArray(sj.results) ? sj.results.find((x) => x && x.url && x.snippet) : null;
              if (top) {
                // Same order and look as a result: answer, then site icon + name, then the page title
                const p = document.createElement("p");
                p.className = "ct-qa-text";
                let t = String(top.snippet).replace(/<[^>]+>/g, "").trim();
                const dm = /^([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\s*(?:\.\.\.|…|·|-|—)\s*/.exec(t);
                if (dm) { t = t.slice(dm[0].length); const ds = document.createElement("span"); ds.className = "result-date"; ds.textContent = `${dm[1]} · `; p.append(ds); }
                p.append(t);
                const row = document.createElement("div");
                row.className = "ct-qa-site";
                let host = "";
                try { host = new URL(top.url).hostname.replace(/^www\./, ""); } catch {}
                if (top.favicon) { const ic = document.createElement("img"); ic.src = top.favicon; ic.alt = ""; ic.onerror = () => ic.remove(); row.append(ic); }
                const cite = document.createElement("cite");
                cite.textContent = host;
                row.append(cite);
                const a = document.createElement("a");
                a.className = "ct-qa-src";
                a.href = top.url;
                a.textContent = cleanTitle(top.title || top.url, top.url);
                body.append(p, row, a);
              }
              body.append(more);
            })
            .catch(() => { body.textContent = ""; body.append(more); });
        });
        box.append(d);
      }
      paaBox = fadeIn(box);
      paaAnchor()?.after(box);
    })(ready("qs", key));
};

// Tools, like Google's advanced search: a small link beside the tabs opens the fields, filled from your search
const advParse = (q) => {
  const o = { all: "", exact: "", none: "", site: "", ft: "" };
  let s = ` ${q} `;
  s = s.replace(/\s"([^"]+)"/, (m, x) => { o.exact = x; return " "; });
  s = s.replace(/\ssite:(\S+)/i, (m, x) => { o.site = x; return " "; });
  s = s.replace(/\sfiletype:(\S+)/i, (m, x) => { o.ft = x; return " "; });
  const none = [];
  s = s.replace(/\s-(\S+)/g, (m, x) => { none.push(x); return " "; });
  o.none = none.join(" ");
  o.all = s.replace(/\s+/g, " ").trim();
  return o;
};
const tools = () => {
  const tabs = document.getElementById("results-tabs");
  if (!tabs || !tabs.firstElementChild || document.getElementById("ct-tools")) return;
  const t = document.createElement("button");
  t.type = "button";
  t.id = "ct-tools";
  t.textContent = "Tools";
  t.setAttribute("aria-expanded", "false");
  tabs.append(t);
  t.addEventListener("click", () => {
    let f = document.getElementById("ct-adv");
    if (f) { f.remove(); t.setAttribute("aria-expanded", "false"); return; }
    t.setAttribute("aria-expanded", "true");
    let q = "";
    try { q = new URL(location.href).searchParams.get("q") || ""; } catch {}
    const o = advParse(q);
    f = document.createElement("form");
    f.id = "ct-adv";
    for (const [k, label, ph] of [["all", "All these words"], ["exact", "This exact phrase"], ["none", "None of these words"], ["site", "Site or domain", "reddit.com"], ["ft", "File type", "pdf"]]) {
      const l = document.createElement("label");
      const sp = document.createElement("span");
      sp.textContent = label;
      const i = document.createElement("input");
      i.name = k;
      i.value = o[k];
      i.autocomplete = "off";
      i.setAttribute("autocapitalize", "off");
      if (ph) i.placeholder = ph;
      l.append(sp, i);
      f.append(l);
    }
    const btn = document.createElement("button");
    btn.type = "submit";
    btn.textContent = "Search";
    f.append(btn);
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const v = (k) => (f.elements[k].value || "").trim();
      const parts = [v("all")];
      if (v("exact")) parts.push(`"${v("exact").replace(/"/g, "")}"`);
      for (const w of v("none").split(/\s+/)) if (w) parts.push(`-${w.replace(/^-+/, "")}`);
      if (v("site")) parts.push(`site:${v("site").replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`);
      if (v("ft")) parts.push(`filetype:${v("ft").replace(/^\./, "")}`);
      const nq = parts.filter(Boolean).join(" ");
      if (nq) location.href = goTo(nq);
    });
    tabs.after(f);
    if (!PHONE.matches) f.elements.all.focus();
  });
};

// Image loading skeleton: degoog always draws 4 columns; match the real grid's 3/4/5/6 by width
const skel = (root) => {
  const g = root.matches?.(".skeleton-image-grid") ? root : root.querySelector?.(".skeleton-image-grid");
  if (!g) return;
  const w = g.clientWidth || innerWidth;
  const want = w <= 800 ? 3 : w <= 1100 ? 4 : w <= 1400 ? 5 : 6;
  const cols = [...g.children];
  cols.slice(want).forEach((c) => c.remove());
  for (let i = cols.length; i < want; i++) g.append(cols[i % cols.length].cloneNode(true));
};

// Weather card with no city ("Usage: !weather <city>") is noise: hide it (no default city on purpose)
const noUsage = (root) => {
  const list = root.matches?.(".command-result") ? [root] : [...(root.querySelectorAll?.(".command-result") || [])];
  for (const c of list) if (/^\s*Usage: !weather\b/.test(c.textContent)) {
    const box = c.parentElement?.children.length === 1 ? c.parentElement : c;
    box.style.display = "none";
  }
};

// Each step runs on its own: one error can't stop the others (errors go to the browser console)
// ===== Sitelinks, Discussions and forums, Videos, Top stories =====
// Built from the results already on the page (endless-scroll pages too), so they cost nothing: nothing is shown twice,
// nothing is lost (the per-site limit hides extra pages; these put them back to use), and each box sits where its
// best result ranked. Only Top stories asks for more, and only when the results themselves look like news.
const VIDEO_URL = (u, h) => (/(^|\.)youtube\.com$/.test(h) && /^\/(watch|shorts\/|live\/)/.test(u.pathname)) || h === "youtu.be" ||
  (/(^|\.)vimeo\.com$/.test(h) && /^\/\d+/.test(u.pathname)) || (/(^|\.)dailymotion\.com$/.test(h) && u.pathname.startsWith("/video/")) ||
  (/(^|\.)twitch\.tv$/.test(h) && /\/(videos|clip)\//.test(u.pathname)) || (/(^|\.)tiktok\.com$/.test(h) && /\/video\//.test(u.pathname));
const SE = { "stackoverflow.com": "Stack Overflow", "superuser.com": "Super User", "serverfault.com": "Server Fault", "askubuntu.com": "Ask Ubuntu", "mathoverflow.net": "MathOverflow" };
const forumName = (u, h) => {
  const p = u.pathname;
  if (/(^|\.)reddit\.com$/.test(h) && /^\/r\/[^/]+\/comments\//.test(p)) return `r/${p.split("/")[2]}`;
  if (h === "news.ycombinator.com" && p === "/item") return "Hacker News";
  if (SE[h] && /^\/questions\/\d+/.test(p)) return SE[h];
  if (/\.stackexchange\.com$/.test(h) && /^\/questions\/\d+/.test(p)) return h.replace(/\.stackexchange\.com$/, "").replace(/^./, (c) => c.toUpperCase()) + " Stack Exchange";
  if (/(^|\.)quora\.com$/.test(h) && p.length > 1 && !/^\/(profile|topic|search)\b/.test(p)) return "Quora";
  if (/(^|\.)github\.com$/.test(h) && /^\/[^/]+\/[^/]+\/discussions\/\d+/.test(p)) return `GitHub · ${p.split("/")[2]}`;
  if ((h === "lobste.rs" && p.startsWith("/s/")) || (h === "tildes.net" && p.length > 1)) return h;
  if (/^(forums?|community|communities|discuss|discussions?|discourse|boards)\./.test(h) || /\/(forums?|threads?)\/[^/]|showthread\.php|viewtopic\.php|\/community\/[^/]+\/(td-p|m-p)\/|\/t\/[^/]+\/\d+/.test(p)) return h;
  return "";
};
// Dates: "3 hours ago" is exact; "Nov 20, 2026" only gives the day
const when = (t) => {
  t = String(t || "").replace(/·/g, " ").trim();
  if (!t) return null;
  const m = /(\d+)\s+(minute|hour|day|week|month)s?\s+ago/i.exec(t);
  if (m) return { t: Date.now() - Number(m[1]) * { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2].toLowerCase()], exact: /minute|hour/i.test(m[2]) };
  const d = Date.parse(t);
  return isNaN(d) ? null : { t: d, exact: false };
};
const ago = (w) => {
  if (!w) return "";
  const s = (Date.now() - w.t) / 1000;
  if (w.exact) return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : `${Math.round(s / 3600)} hours ago`;
  const d = new Date(w.t), day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - day.getTime()) / 864e5);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(days > 300 ? { year: "numeric" } : {}) });
};
const fresh = (w) => !!w && Date.now() - w.t < (w.exact ? 2 : 3) * 864e5;
// "Looks like news": 3+ different sites with an exact "N minutes/hours ago" stamp from the last 24 h. Measured on the
// 50 recorded web searches: only steelers and taylor swift pass. v49's rule (2+ sites dated within 2-3 days) also
// fired on time in tokyo, days until christmas and 100 usd to eur (pages stamped with today's date).
const hot = (rows) => new Set(rows.filter((r) => r.w && r.w.exact && Date.now() - r.w.t < 864e5).map((r) => r.h)).size >= 3;
// Searches that looked like news, kept in this browser as a short hash of the search (not the words) for 12 h,
// the same time degoog keeps engine answers. Only these start a News search early on the next visit.
const NEWSY_KEY = "ct-newsy";
const qHash = (q) => { let h = 2166136261; for (const c of String(q).trim().toLowerCase()) h = Math.imul(h ^ c.codePointAt(0), 16777619); return (h >>> 0).toString(36); };
const newsy = (() => {
  let m = {};
  try { const c = JSON.parse(localStorage.getItem(NEWSY_KEY) || "{}"); if (c && typeof c === "object") m = c; } catch {}
  const now = Date.now();
  for (const k of Object.keys(m)) if (!(now - m[k] < 432e5)) delete m[k];
  return {
    has: (h) => h in m,
    add: (h) => {
      m[h] = Date.now();
      const ks = Object.keys(m); if (ks.length > 300) ks.sort((a, b) => m[a] - m[b]).slice(0, ks.length - 300).forEach((k) => delete m[k]);
      try { localStorage.setItem(NEWSY_KEY, JSON.stringify(m)); } catch {}
    },
  };
})();
const _info = new WeakMap();
const info = (el) => {
  if (_info.has(el)) return _info.get(el);
  let r = null;
  const a = el.querySelector("a.result-title");
  try {
    const u = new URL(a.href), h = u.hostname.replace(/^(www|m|old)\./, "");
    // The date: degoog's own (if row cleanup hasn't run), else the one cleanup moved to the source line (raw text kept)
    const p = el.querySelector(".result-snippet"), dEl = (p && p.querySelector(".result-date")) || el.querySelector(".result-url-row .ct-date");
    const raw = (a.textContent || "").replace(/\s+/g, " ").trim();
    r = {
      el, u, h, href: a.href, title: (el.dataset.ctCap ? cleanTitle(raw, a.href) : "") || raw,
      snippet: p ? (p.textContent || "").replace(dEl && p.contains(dEl) ? dEl.textContent : "", "").replace(/^\s*·\s*/, "").trim() : "",
      w: when(dEl ? dEl.dataset.raw || dEl.textContent : ""), thumb: el.querySelector(".result-thumbnail-wrap:not([style*='none']) img")?.src || "",
      fav: el.querySelector("img.result-favicon")?.src || "", dur: el.querySelector(".degoog-result--video-duration")?.textContent.trim() || "",
    };
    r.video = VIDEO_URL(u, h) || !!el.querySelector(".degoog-result--thumb--video");
    r.forum = r.video ? "" : forumName(u, h);
  } catch {}
  _info.set(el, r);
  return r;
};
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const favImg = (src) => {
  if (!src) return mk("span", "ct-fav ct-fav-x");
  const i = mk("img", "ct-fav"); i.alt = ""; i.loading = "lazy"; i.src = src;
  i.onerror = () => i.replaceWith(mk("span", "ct-fav ct-fav-x"));
  return i;
};
// "More" opens the matching tab exactly as tapping it would
const moreBtn = (label, type) => {
  const tab = document.querySelector(`.results-tab[data-type="tab:engine:${type}"], .results-tab[data-type="${type}"]`);
  if (!tab) return null;
  const b = mk("button", "ct-more", label);
  b.type = "button";
  b.onclick = () => { tab.click(); scrollTo({ top: 0 }); };
  return b;
};
// Sideways row (Videos, Top stories): swipe on phones, arrows on PC that only show when there's more to see
const scroller = () => {
  const wrap = mk("div", "ct-rowwrap"), row = mk("div", "ct-row");
  const prev = mk("button", "ct-arr ct-prev"), next = mk("button", "ct-arr ct-next");
  prev.type = next.type = "button"; prev.setAttribute("aria-label", "Back"); next.setAttribute("aria-label", "More");
  const upd = () => { wrap.classList.toggle("ct-can-prev", row.scrollLeft > 4); wrap.classList.toggle("ct-can-next", row.scrollLeft + row.clientWidth < row.scrollWidth - 4); };
  prev.onclick = () => row.scrollBy({ left: -row.clientWidth * 0.9, behavior: "smooth" });
  next.onclick = () => row.scrollBy({ left: row.clientWidth * 0.9, behavior: "smooth" });
  row.addEventListener("scroll", upd, { passive: true });
  wrap.append(prev, row, next);
  wrap.upd = () => requestAnimationFrame(upd);
  return [wrap, row];
};
const section = (cls, title) => { const s = fadeIn(mk("section", `ct-grp ${cls}`)); s.append(mk("h3", "ct-gh", title)); return s; };

const COUNT = /(\d[\d,.]*\s*[kK]?)\+?\s+(comments?|answers?|replies|reply|posts?|votes?)\b/i;
const forumRow = (r) => {
  const a = mk("a", "ct-fi"); a.href = r.href;
  const meta = mk("span", "ct-meta"); meta.append(favImg(r.fav), mk("span", "ct-src", r.forum));
  const n = COUNT.exec(r.snippet);
  const bits = [n ? `${n[1].trim()} ${n[2].toLowerCase()}` : "", ago(r.w)].filter(Boolean);
  if (bits.length) meta.append(mk("span", "ct-when", bits.join(" · ")));
  const snip = r.snippet.replace(new RegExp(`^\\s*${COUNT.source}[\\s.·:-]*`, "i"), "");
  // The community is already on the line above: drop it from the title (" : r/SteamDeck", " - Stack Overflow")
  const t = r.title.replace(/\s*[:|\-–—]\s*r\/[\w-]+\s*$/i, "").replace(new RegExp(`\\s*[-|–—:]\\s*${r.forum.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "") || r.title;
  a.append(meta, mk("span", "ct-ft", t));
  if (snip) a.append(mk("span", "ct-fs", snip));
  return a;
};
const siteName = (h) => (/youtu/.test(h) ? "YouTube" : h.replace(/\.(com|tv|net|org)$/, "").replace(/^./, (c) => c.toUpperCase()));
const videoCard = (r) => {
  const a = mk("a", "ct-card ct-vc"); a.href = r.href;
  const pic = mk("span", "ct-pic");
  if (r.thumb) { const i = mk("img"); i.src = r.thumb; i.alt = ""; i.loading = "lazy"; i.onerror = () => i.remove(); pic.append(i); }
  pic.append(mk("span", "ct-play"));
  if (r.dur) pic.append(mk("span", "ct-dur", r.dur));
  const meta = mk("span", "ct-meta"); meta.append(favImg(r.fav), mk("span", "ct-src", siteName(r.h)));
  if (r.w) meta.append(mk("span", "ct-when", ago(r.w)));
  a.append(pic, mk("span", "ct-ct", r.title), meta);
  return a;
};
const storyCard = (r) => {
  const a = mk("a", "ct-card ct-sc"); a.href = r.href;
  if (r.thumb) { const pic = mk("span", "ct-pic"); const i = mk("img"); i.src = r.thumb; i.alt = ""; i.loading = "lazy"; i.onerror = () => { i.style.visibility = "hidden"; /* keeps its box: no shape change after paint */ }; pic.append(i); a.append(pic); }
  else a.classList.add("ct-nopic");
  const meta = mk("span", "ct-meta"); meta.append(favImg(r.fav), mk("span", "ct-src", r.h));
  a.append(meta, mk("span", "ct-ct", r.title), mk("span", "ct-when", ago(r.w)));
  return a;
};

let G = { key: "" };
// Your Settings switches for these boxes. Known before results arrive, so the boxes are built in the same pass as
// the results (v49 waited for the server, which could rebuild the list after it was on screen): the last answer is
// kept in this browser (switch values only), and a change applies from the next page load. Missing = on.
const SHOW_KEY = "ct-show";
let SHOW = { sl: true, forum: true, video: true, news: true };
try { const c = JSON.parse(localStorage.getItem(SHOW_KEY) || "null"); if (c && typeof c === "object") SHOW = { ...SHOW, ...c }; } catch {}
bridge("prefs", {}).then((j) => { if (j && typeof j === "object") try { localStorage.setItem(SHOW_KEY, JSON.stringify(j)); } catch {} }).catch(() => {});
const used = (el) => el.classList.contains("ct-grouped");
const shown = (el) => el.style.display !== "none" && !used(el);
const groups = () => {
  if (!webTab || !SHOW) return;
  const list = document.getElementById("results-list");
  if (!list) return;
  const key = searchId(location.href);
  if (G.key !== key) {
    list.querySelectorAll(".ct-grp, .ct-sl").forEach((x) => x.remove());
    list.querySelectorAll(".ct-grouped").forEach((x) => x.classList.remove("ct-grouped"));
    G = { key, sl: null, slTop: null, forum: null, video: null, news: false };
  }
  for (const k of ["forum", "video", "sl"]) if (G[k] && !G[k].isConnected) G[k] = null; // degoog redrew the list
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none" || x.dataset.ctCap).map(info).filter(Boolean);
  const top = rows.find((r) => shown(r.el));
  if (!top) return;

  // Sitelinks: the top result's other pages from your results, under it (they leave the list, so no repeats)
  if (G.slTop !== top.el) { G.sl?.remove(); G.sl = null; G.slTop = top.el; }
  if (SHOW.sl && !top.video && !top.forum) {
    const base = top.href.split("#")[0];
    const same = rows.filter((r) => r !== top && r.h === top.h && !used(r.el) && !r.video && !r.forum && r.href.split("#")[0] !== base);
    const have = G.sl ? G.sl.children.length : 0;
    if (same.length && (G.sl || same.length >= 2) && have < 4) {
      if (!G.sl) { G.sl = fadeIn(mk("div", "ct-sl")); top.el.querySelector(".result-body")?.append(G.sl); }
      const brand = top.title.split(/\s[-|·:–—]\s/).pop();
      for (const r of same.slice(0, 4 - have)) {
        const a = mk("a", "ct-sl-i"); a.href = r.href;
        const t = r.title.split(/\s[-|·:–—]\s/).filter((x) => x !== brand).join(" - ") || r.title;
        a.append(mk("span", "ct-sl-t", t));
        if (r.snippet) a.append(mk("span", "ct-sl-d", r.snippet));
        G.sl.append(a);
        r.el.classList.add("ct-grouped");
      }
    }
  }
  // 2+ of a kind become one box, placed where the first of them ranked (the top result always stays a normal
  // result); up to 4 threads / 8 videos, joined by more as endless scroll loads them
  const box = (kind, test, max, build, title, tab, label, isRow) => {
    const c = rows.filter((r) => r !== top && test(r) && !used(r.el));
    let s = G[kind];
    if (!s && c.length < 2) return;
    if (!s) {
      s = G[kind] = section(`ct-${kind}`, title);
      if (isRow) { const [wrap, row] = scroller(); s.append(wrap); s.row = row; s.wrap = wrap; } else { s.row = mk("div", "ct-list"); s.append(s.row); }
      (c.find((r) => r.el.style.display !== "none") || c[0]).el.before(s);
      const m = moreBtn(label, tab); if (m) s.append(m);
    }
    const n = s.row.children.length;
    for (const r of c.slice(0, Math.max(0, max - n))) { s.row.append(build(r)); r.el.classList.add("ct-grouped"); }
    s.wrap?.upd();
  };
  if (SHOW.forum) box("forum", (r) => !!r.forum, 4, forumRow, "Discussions and forums", "forums", "More discussions", false);
  if (SHOW.video) box("video", (r) => r.video, 8, videoCard, "Videos", "videos", "More videos", true);

  // Top stories: only when the results look like news (hot). Drawn in this same pass, before paint, and only if the
  // News answer started at page load is already in hand; otherwise nothing is added and the search is remembered,
  // so the next visit starts the News search early. Fresh stories only, one per outlet, none already shown.
  if (SHOW.news && !G.news) {
    if (!hot(rows)) return;
    G.news = true;
    const q = new URLSearchParams(location.search).get("q") || "";
    if (!q) return;
    newsy.add(qHash(q));
    const j = ready("news", key);
    if (!j) return;
    const onPage = new Set(rows.map((r) => r.href.split("#")[0]));
    const seen = new Set();
    const items = (j.results || []).map((x) => {
      let u; try { u = new URL(x.url); } catch { return null; }
      const h = u.hostname.replace(/^(www|m)\./, "");
      const rel = /(\d+)\s+(minute|hour|day)s?\s+ago/i.exec(x.snippet || "");
      const w = rel ? when(rel[0]) : x.publishedAt ? { t: Date.parse(`${x.publishedAt}T12:00:00Z`), exact: false } : null;
      return { h, href: x.url, title: cleanTitle(String(x.title || ""), x.url) || String(x.title || ""), w, thumb: x.thumbnail || "", fav: x.favicon || "" };
    // Real News answers carry no date at all (recorded steelers/nvidia: 0 of 55 dated), so undated stories count as
    // current (a News search returns current news) and keep degoog's order; one dated older than fresh() is left out
    }).filter((r) => r && r.title && (!r.w || fresh(r.w)) && !onPage.has(r.href.split("#")[0]) && !seen.has(r.h) && seen.add(r.h)).slice(0, 8);
    if (items.length < 3) return;
    const t = [...list.querySelectorAll(".result-item")].find(shown);
    if (!t) return;
    const s = section("ct-news", "Top stories");
    const [wrap, row] = scroller();
    items.forEach((r) => row.append(storyCard(r)));
    s.append(wrap);
    const m = moreBtn("More news", "news"); if (m) s.append(m);
    t.after(s);
    wrap.upd();
  }
};

// ===== Answer card, local answers (core answers.js: math, units, cooking, tip/percent, dates, patterns) =====
// Worked out from the search words alone, so it's drawn in the same pass that clears the panel area for a new
// search: in place before the results, nothing reserved, nothing late. While it's there, every other panel in the
// area (AI summary, math-slot...) is hidden by CSS (one answer per search; patterns and sums come first).
let ansFor = null, ansVal = null, aiVal = false;
// A course number, bare digits allowed here (the server knows whether that course exists)
const cmuQ = (q) => { const m = /^(\d{2})-?(\d{3})\b/.exec(String(q || "").trim()); return m ? CT.cmuCourse(q, new Set([`${m[1]}-${m[2]}`])) : null; };
// AI summary only where the wording asks for judgement or explanation (spec: best / vs / why / explain / compare);
// facts and how-tos get results (a snippet later). A search that names a site or a type gets a plain list, no AI.
const AI_WORDS = /^(?:why|how (?:does|do|did|is|are|can|come)|explain|what(?:'s| is| are) the (?:difference|best|point)|difference between|should i|is it worth)\b|\b(?:vs\.?|versus|compared? to|comparison|best|pros and cons|worth it|better than|or)\b/i;
const TYPE_WORDS = /\b(?:pdf|paper|reddit|docs|documentation|recipe|github|lab|lecture|slides|video|videos|youtube|wiki|wikipedia)\b/i;
const aiWanted = (q) => {
  if (!AI_ON.on || !q || q.startsWith("!") || (AI_ON.qmark && !q.trim().endsWith("?"))) return false;
  if (!AI_WORDS.test(q) || TYPE_WORDS.test(q) || /\bbest buy\b/i.test(q)) return false;
  if (CT.eolQuery(q) || CT.wdQuery(q)) return false; // a fact or version answer comes first
  try { if (CT.namedSites(q, PSL()).size) return false; } catch {}
  return true;
};
// The AI spot: label, 3 text lines and the ⌄ line, at its final size before the results are drawn. ai-summary's
// panel (it comes after the results) stays where degoog put it, so degoog's own panel bookkeeping keeps working
// (it clears and sweeps that area), but CSS lays it over the spot's 3 lines: it takes no room and its text covers
// the placeholder lines once it streams. It never grows by itself: ⌄ opens it (your tap). No panel within degoog's
// slot limit (SLOT_PLUGIN_TIMEOUT_MS 10 s, + 2 s for the trip) after the results, or a failed answer
// -> "AI summary unavailable" in the same space.
const AIS = { key: "", got: false, fail: false, open: false, t: 0 };
const aiBox = () => {
  const box = mk("div", "ct-ai");
  const label = mk("div", "ct-ai-label");
  label.append(mk("span", "ct-ai-star", "✦"), " AI summary");
  const text = mk("div", "ct-ai-text");
  for (let i = 0; i < 3; i++) text.append(mk("span", "ct-ai-line"));
  text.append(mk("div", "ct-ai-err", "AI summary unavailable"));
  const more = mk("button", "ct-ai-more", "⌄");
  more.type = "button";
  more.setAttribute("aria-label", "Show the whole AI summary");
  box.append(label, text, more);
  return box;
};
const aiPass = (g, key) => {
  if (AIS.key !== key) { clearTimeout(AIS.t); Object.assign(AIS, { key, got: false, fail: false, open: false, t: 0 }); }
  let n = 0;
  for (const p of g.querySelectorAll(".glance-ai")) {
    const w = [...g.children].find((c) => c.contains(p)) || p;
    // Not an AI search (or a second panel): never drawn
    if (!aiVal || n++) { w.style.display = "none"; w.classList.remove("ct-ai-panel"); continue; }
    w.classList.add("ct-ai-panel");
    AIS.got = true;
    if (p.querySelector('.glance-ai-stream[data-state="error"]')) AIS.fail = true;
  }
  if (!aiVal) return;
  if (AIS.got && !n) AIS.fail = true; // ai-summary took its panel away ("hide on error")
  if (!AIS.got && !AIS.t && drawnFor === key) AIS.t = setTimeout(() => { if (!AIS.got && AIS.key === key) { AIS.fail = true; const b = document.querySelector("#at-a-glance > .ct-ai"); if (b) b.classList.add("ct-ai-fail"); } }, 12000);
  let box = [...g.children].find((c) => c.classList.contains("ct-ai"));
  if (!box) { g.style.display = ""; box = aiBox(); g.prepend(box); }
  box.classList.toggle("ct-ai-fail", AIS.fail);
  box.classList.toggle("ct-ai-open", AIS.open && !AIS.fail);
  g.classList.toggle("ct-ai-opened", AIS.open && !AIS.fail);
};
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest(".ct-ai-more");
  if (!b || AIS.fail) return;
  const g = document.getElementById("at-a-glance");
  AIS.open = true;
  if (g) { aiPass(g, AIS.key); g.querySelector(".ct-ai-panel .glance-ai-expand")?.click(); } // ai-summary's own "read more": unclamps, opens its follow-up chat
});
const ansCard = (a) => {
  const box = mk("div", "ct-ans");
  box.dataset.kind = a.kind;
  if (a.copy) { box.tabIndex = 0; box.setAttribute("role", "button"); box.dataset.copy = a.copy; box.setAttribute("aria-label", `${a.value || a.title || a.copy}. Copy`); }
  const label = mk("div", "ct-ans-label");
  label.append(mk("span", "ct-ans-l", a.src ? `${a.label} · ${a.src}` : a.label), mk("span", "ct-ans-copied", "Copied"));
  box.append(label);
  if (a.href) { const t = mk("a", "ct-ans-title", a.title); t.href = a.href; t.rel = "noopener"; box.append(t); }
  else if (a.kind !== "sports") {
    const v = mk("div", "ct-ans-value");
    if (a.swatch) { const sw = mk("span", "ct-ans-sw"); sw.style.background = a.swatch; v.append(sw); }
    v.append(a.value);
    box.append(v);
  }
  if (a.detail && a.kind !== "sports") box.append(mk("div", "ct-ans-detail", a.detail));
  if (a.kind === "sports") {
    // Label line: "NFL · Final" or "NFL · ● Live · Q3 4:12" (pulsing red dot); then logos, teams and scores
    const l = box.querySelector(".ct-ans-l");
    l.textContent = `${a.label} · `;
    if (a.live) l.append(mk("span", "ct-live-dot"), "Live · ");
    l.append(mk("span", "ct-sp-status", a.status));
    const row = mk("div", "ct-sp");
    a.teams.forEach((t, i) => {
      const side = mk("span", `ct-sp-team${t.winner ? " ct-win" : ""}`);
      const logo = mk("span", "ct-sp-logo");
      if (t.logo) { const im = new Image(); im.alt = ""; im.decoding = "async"; im.onload = () => im.classList.add("ct-on"); im.src = t.logo; logo.append(im); }
      side.append(logo, mk("span", "ct-sp-abbr", t.abbr));
      if (a.showScore) side.append(mk("span", "ct-sp-score", t.score));
      if (i === 0) side.classList.add("ct-sp-away");
      row.append(side);
      if (i === 0) row.append(mk("span", "ct-sp-dash", a.showScore ? "–" : "at"));
    });
    box.append(row);
    if (a.detail) box.append(mk("div", "ct-ans-detail", a.detail));
  }
  if (a.kind === "cmu") {
    // Facts line: "12 units · 14.3 hrs/wk · 4.0 ★★★★☆ · prereq 15-122"; people line: "Spring 2026 · Railing 4.3 · +N"
    const facts = mk("div", "ct-ans-detail ct-fit ct-fit-drop");
    a.parts.forEach((p) => {
      if (typeof p === "string") { facts.append(mk("span", "ct-it", p)); return; }
      const r = mk("span", "ct-it ct-rating", `${p.stars.toFixed(1)} `);
      const st = mk("span", "ct-stars", "★★★★★");
      st.style.setProperty("--r", String(p.stars));
      st.setAttribute("aria-label", `${p.stars.toFixed(1)} out of 5`);
      r.append(st);
      facts.append(r);
    });
    const people = mk("div", "ct-ans-detail ct-fit");
    if (a.sem) people.append(mk("span", "", a.sem));
    for (const p of a.profs) { const it = mk("span", "ct-it"); it.append(mk("span", "ct-fn", `${p.full.slice(0, p.full.length - p.last.length)}`), `${p.last} ${p.r}`); people.append(it); }
    people.append(mk("span", "ct-plus"));
    if (a.prof) box.append(people, facts); else box.append(facts, people);
  }
  return box;
};
// Live game: score and status refreshed in place (same size: tabular digits, fixed logo boxes) while the game is on
// and this tab is visible, every 60 s: the server keeps a live game for 60 s, so asking more often gets the same.
let liveT = 0;
const livePoll = (key, q) => {
  clearTimeout(liveT);
  liveT = setTimeout(async () => {
    if (searchId(location.href) !== key) return;
    if (document.visibilityState !== "visible") { document.addEventListener("visibilitychange", () => livePoll(key, q), { once: true }); return; }
    const j = await bridge("sports", { q }).catch(() => null);
    const a = j && j.g && CT.sportsAnswer(j.g);
    const box = document.querySelector("#at-a-glance > .ct-ans[data-kind=sports]");
    if (!a || !box || searchId(location.href) !== key) return;
    ansVal = a;
    box.querySelectorAll(".ct-sp-score").forEach((el, i) => { el.textContent = a.teams[i].score; });
    box.querySelectorAll(".ct-sp-team").forEach((el, i) => el.classList.toggle("ct-win", !!a.teams[i].winner));
    const st = box.querySelector(".ct-sp-status");
    if (st) st.textContent = a.status;
    if (!a.live) box.querySelector(".ct-live-dot")?.remove(); else livePoll(key, q);
  }, 60000);
};
// One line, items never cut (re-measured when the width changes): people that don't fit fold into "+N"; mixed
// facts (units, hours, rating, prereq) that don't fit are dropped whole from the end, never a bare "+N"
const fitLine = (line) => {
  const its = [...line.querySelectorAll(".ct-it")], more = line.querySelector(".ct-plus");
  if (!its.length) return;
  its.forEach((x) => { x.hidden = false; });
  if (more) more.hidden = true;
  let hid = 0;
  while (line.scrollWidth > line.clientWidth + 1 && hid < its.length - 1) { its[its.length - 1 - hid].hidden = true; hid++; if (more) { more.hidden = false; more.textContent = `+${hid}`; } }
};
const fitRO = typeof ResizeObserver === "function" ? new ResizeObserver((es) => es.forEach((e) => e.target.querySelectorAll(".ct-fit").forEach(fitLine))) : null;
const ansPass = () => {
  const g = document.getElementById("at-a-glance");
  if (!g) return;
  const key = searchId(location.href);
  if (ansFor !== key) {
    ansFor = key;
    let q = "", page = 1;
    try { const u = new URL(key); q = (u.searchParams.get("q") || "").trim(); page = Number(u.searchParams.get("page") || 1); } catch {}
    ansVal = webTab && page <= 1 ? CT.answer(q, Date.now(), { fx: FX }) : null;
    aiVal = webTab && page <= 1 && !ansVal && aiWanted(q);
    g.querySelectorAll(".ct-ans, .ct-ai").forEach((x) => x.remove());
  }
  // Network answers (endoflife.date...): only in the pass that draws the results, and only if already in hand;
  // later than that they're dropped for this page (the server keeps them for the next search)
  if (!ansVal && !aiVal && drawnFor !== key && document.querySelector("#results-list .result-item")) {
    let q = "";
    try { q = new URL(key).searchParams.get("q") || ""; } catch {}
    const j = ready("eol", key), w = ready("wd", key), cm = ready("cmu", key);
    if (j && j.cycles) ansVal = CT.eolAnswer(CT.eolQuery(q), j.cycles);
    else if (w && w.d) ansVal = CT.wdAnswer(CT.wdQuery(q), w.d);
    else if (cm && cm.c) ansVal = CT.cmuAnswer(cmuQ(q), cm.c.course, cm.c.fces);
    else { const sp = ready("sports", key); if (sp && sp.g) { ansVal = CT.sportsAnswer(sp.g); if (ansVal && ansVal.live) livePoll(key, q); } }
  }
  aiPass(g, key);
  if (!ansVal || g.querySelector(".ct-ans")) return;
  g.style.display = "";
  const card = ansCard(ansVal);
  g.prepend(card);
  card.querySelectorAll(".ct-fit").forEach(fitLine);
  if (fitRO) fitRO.observe(card);
};
// Tap (or Enter) on an instant answer copies it; "Copied" shows in its label line for a moment (same line, no shift)
const ansCopy = (e) => {
  const box = e.target.closest && e.target.closest(".ct-ans[data-copy]");
  if (!box || e.target.closest("a")) return;
  if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  const done = () => { box.classList.add("ct-copied"); clearTimeout(box._t); box._t = setTimeout(() => box.classList.remove("ct-copied"), 1500); };
  try { navigator.clipboard.writeText(box.dataset.copy).then(done, () => {}); } catch {}
};
document.addEventListener("click", ansCopy);
document.addEventListener("keydown", ansCopy);

const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`clean-titles ${name}:`, e); } };
const init = () => {
  safe("query", readQuery);
  safe("early", earlyStart);
  safe("usage", () => noUsage(document.body));
  safe("card", glance);
  safe("answer", ansPass);
  safe("list", listPass);
  safe("scan", () => scan(document.body));
  safe("skeleton", () => skel(document.body));
  safe("extras", extras); safe("groups", groups); safe("folds", foldPass); safe("ask", paa); safe("tools", tools);
  safe("drawn", markDrawn);
  // Runs right after degoog inserts results and before the screen updates; only looks inside what was added
  new MutationObserver((muts) => {
    safe("query", readQuery);
    safe("early", earlyStart);
    safe("answer", ansPass);
    safe("list", listPass);
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { safe("scan", () => scan(n)); safe("skeleton", () => skel(n)); safe("usage", () => noUsage(n)); }
    safe("extras", extras); safe("groups", groups); safe("folds", foldPass); safe("ask", paa); safe("tools", tools); safe("card", glance);
    safe("drawn", markDrawn);
    safe("ai", () => { const g = document.getElementById("at-a-glance"); if (g) aiPass(g, searchId(location.href)); });
  }).observe(document.body, { childList: true, subtree: true });
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
'@)
$c = docker ps -q | Where-Object { (docker inspect $_ --format '{{range .Mounts}}{{.Destination}} {{end}}') -match '/app/data' }
docker cp "$t\index.js" "${c}:/app/data/plugins/clean-titles/index.js"; docker exec $c rm -f /app/data/plugins/clean-titles/reports.json
# English word list for the typo fixer (82,765 words with how common each is; downloaded once)
if (-not (docker exec $c sh -c 'test -s /app/data/plugins/clean-titles/words.txt && echo y')) { Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/wolfgarbe/SymSpell/master/SymSpell/frequency_dictionary_en_82_765.txt' -OutFile "$t\words.txt"; docker cp "$t\words.txt" "${c}:/app/data/plugins/clean-titles/words.txt" }
# Common English word pairs for the typo fixer ("how to", "the weather"; downloaded once)
if (-not (docker exec $c sh -c 'test -s /app/data/plugins/clean-titles/pairs.txt && echo y')) { Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/wolfgarbe/SymSpell/master/SymSpell/frequency_bigramdictionary_en_243_342.txt' -OutFile "$t\pairs.txt"; docker cp "$t\pairs.txt" "${c}:/app/data/plugins/clean-titles/pairs.txt" }
# Names from Wikipedia's article titles for the typo fixer (made once: a big download, takes a few minutes)
if (-not (docker exec $c sh -c 'test -s /app/data/plugins/clean-titles/names.txt && echo y')) {
[IO.File]::WriteAllText("$t\names.js", @'
// Names from Wikipedia's article titles: words that aren't in the English word list but appear in 3+ titles
// ("Asura Scans", "OpenAI Five"), or are a one-word title written like a name (PuTTY, NASA, iPhone, R2-D2)
const fs = require("fs"), zlib = require("zlib"), readline = require("readline");
const DIR = "/app/data/plugins/clean-titles", GZ = "/tmp/ct-titles.gz";
const SRC = process.env.CT_TITLES_URL || "https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-all-titles-in-ns0.gz";
const words = new Set();
for (const l of fs.readFileSync(`${DIR}/words.txt`, "utf8").split("\n")) { const w = l.replace(/^﻿/, "").split(" ")[0]; if (w) words.add(w); }
const r = await fetch(SRC);
if (!r.ok) { console.log(`Wikipedia names: download failed (${r.status}), skipped; next update tries again`); process.exit(0); }
await Bun.write(GZ, r);
// Counting ~5 million different words in little memory: two 32 MB tables of counts, the smaller one wins
const N = 1 << 25, A = new Uint8Array(N), B = new Uint8Array(N);
const h = (s, seed) => { let x = seed; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0) & (N - 1); };
const each = async (fn) => {
  const rl = readline.createInterface({ input: fs.createReadStream(GZ).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    const title = line.replace(/_\([^)]*\)$/, "");
    const parts = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!parts.length || line === "page_title") continue;
    fn(title, parts);
  }
};
// 2-letter words only when written in capitals ("AI", "TV"), so "de", "la", "jr" stay out
const cand = (x) => x.length >= 2 && x.length <= 24 && !/^\d+$/.test(x) && !words.has(x);
await each((title, parts) => {
  if (parts.length < 2) return;
  for (const x of new Set(parts.filter((p) => p.length > 2 || p === p.toUpperCase()).map((p) => p.toLowerCase()))) if (cand(x)) { const i = h(x, 2166136261), j = h(x, 374761393); if (A[i] < 255) A[i]++; if (B[j] < 255) B[j]++; }
});
const out = new Set();
await each((title, parts) => {
  if (parts.length === 1) {
    const x = parts[0];
    if (cand(x.toLowerCase()) && (/\p{Ll}\p{Lu}/u.test(x) || (x.length >= 2 && x === x.toUpperCase() && /\p{L}/u.test(x)) || (/\d/.test(x) && /\p{L}/u.test(x)))) out.add(x.toLowerCase());
    return;
  }
  for (const p of parts) { const x = p.toLowerCase(); if ((p.length > 2 || p === p.toUpperCase()) && cand(x) && Math.min(A[h(x, 2166136261)], B[h(x, 374761393)]) >= 3) out.add(x); }
});
fs.writeFileSync(`${DIR}/names.txt`, [...out].join("\n"));
fs.rmSync(GZ, { force: true });
console.log(`Wikipedia names: ${out.size} saved`);
'@)
docker cp "$t\names.js" "${c}:/tmp/ct-names.js"; docker exec $c bun /tmp/ct-names.js; docker exec $c rm -f /tmp/ct-names.js /tmp/ct-titles.gz
}

# Plugin page code goes inside degoog's page itself: no separate file, so no content blocker can stop it
[IO.File]::WriteAllText("$t\inline.js", @'
const fs = require("fs");
const crypto = require("crypto");
const f = "/app/src/public/themes/degoog-theme/layout.html";
let h = fs.readFileSync(f, "utf8");
const code = fs.readFileSync("/tmp/ct.js", "utf8").replace(/<\/script/gi, "<\\/script");
// Public suffix list (which part of a host is the site: bbc.co.uk, user.github.io): a static file degoog serves
// with a 1-year immutable cache, named by its content so a new list gets a new name. Loaded with defer before the
// module (both run in page order, before results arrive); not inlined, as degoog doesn't compress pages (76 KB)
const psl = fs.readFileSync("/tmp/psl.enc", "utf8").trim();
const hash = crypto.createHash("sha256").update(psl).digest("hex").slice(0, 12);
const dir = "/app/src/public/ct";
fs.mkdirSync(dir, { recursive: true });
for (const old of fs.readdirSync(dir)) if (/^psl\.[0-9a-f]+\.js$/.test(old) && old !== `psl.${hash}.js`) fs.rmSync(`${dir}/${old}`);
fs.writeFileSync(`${dir}/psl.${hash}.js`, `window.CT_PSL=${JSON.stringify(psl)};\n`);
const block = `<script defer src="/public/ct/psl.${hash}.js" id="ct-psl"></script>\n<script type="module" id="ct-inline">const __PLUGIN_ID__="clean-titles";\n` + code + "\n</script>";
const re = /(?:<script defer src="\/public\/ct\/psl\.[0-9a-f]+\.js" id="ct-psl"><\/script>\n)?<script type="module" id="ct-inline">[\s\S]*?\n<\/script>/;
h = re.test(h) ? h.replace(re, () => block) : h.replace("</body>", () => block + "\n</body>");
fs.writeFileSync(f, h);
console.log(`public suffix list: /public/ct/psl.${hash}.js (${psl.length} chars)`);

'@)
[IO.File]::WriteAllText("$t\psl.enc", @'
ac(com,drr,edu,feedback,forms,gov,mil,net,org,sch),academy(official),ae(ac,co,gov,mil,net,org,sch),aero(accident-investigation,accident-prevention,aerobatic,aeroclub,aerodrome,agents,air-surveillance,air-traffic-control,aircraft,airline,airport,airtraffic,ambulance,association,author,ballooning,broker,caa,cargo,catering,certification,championship,charter,civilaviation,club,conference,consultant,consulting,control,council,crew,design,dgca,educator,emergency,engine,engineer,entertainment,equipment,exchange,express,federation,flight,freight,fuel,gliding,government,groundhandling,group,hanggliding,homebuilt,insurance,journal,journalist,leasing,logistics,magazine,maintenance,marketplace,media,microlight,modelling,navigation,parachuting,paragliding,passenger-association,pilot,press,production,recreation,repbody,res,research,rotorcraft,safety,scientist,services,show,skydiving,software,student,taxi,trader,trading,trainer,union,workinggroup,works),af(com,edu,gov,net,org),ag(co,com,net,nom,obj,org),ai(com,devs(apps),framer,kiloapps,net,off,org,uwu),al(com,edu,gov,mil,net,org),am(2na(*),co,com,commune,net,org,radio),ao(co,ed,edu,gov,gv,it,og,org,pb),app(agilevibes,aiven,base44,beget(*),botdash,brave!(s(*)),claude,clerk,clerkstage,cloudflare,cloudzyro,codepen,convex,corespeed,crbts,csb!(preview),developer(*),e2b,easypanel,edgecompute,encr!(frontend),evervault(relay),expo!(on,staging!(on)),fastedge,flutterflow,framer,gadget,github,glideos,hackclub,hasura,hosted(*),leapcell,loginline,lovable!(auth),luyani,magicpatterns,medusajs,messerli,miren,mocha,modelence!(cloud,sandbox),netlify,ngrok,ngrok-free,noop,northflank(*),nyat,on-fleek,ondigitalocean,onhercules,pplx,puter,railway(up),replit!(id),retool,rocketpreview,run(*,mtls(*)),shiptoday,sliplane,snowflake(*,privatelink(*)),spawnbase,sprites,streamlit,telebit,typedream,upsun(*),vercel,wal,wasmer,web,windsurf,wnext,zeabur,zerops(*)),apple(int!(cloud(*,r(*,ap-north-1(*),ap-south-1(*),ap-south-2(*),eu-central-1(*),eu-north-1(*),us-central-1(*),us-central-2(*),us-east-1(*),us-east-2(*),us-west-1(*),us-west-2(*),us-west-3(*))))),ar(bet,com,coop,edu,gob,gov,int,mil,musica,mutual,net,org,seg,senasa,tur),army(dns,v6),arpa(e164,home,in-addr,ip6,iris,uri,urn),as(gov),asia(cloudns,daemon,dix),at(123webseite,12hp,2ix,4,4lima,ac!(sth),co,dnshome,funkfeuer(wien),futurecms(*,ex(*),in(*)),futurehosting,futuremailing,gv,lima-city,my,myspreadshop,or,ortsinfo(ex(*),kunden(*)),priv),au(act,asn,com!(cloudlets(mel),myspreadshop),conf,edu!(act,catholic,nsw,nt,qld,sa,tas,vic,wa),gov!(qld,sa,tas,vic,wa),id,net,nsw,nt,org,oz,qld,sa,tas,vic,wa),aw(com),aws(on(af-south-1(airflow(*),lambda-url,transfer-webapp),ap-east-1(airflow(*),lambda-url,transfer-webapp),ap-east-2(transfer-webapp),ap-northeast-1(airflow(*),lambda-url,transfer-webapp),ap-northeast-2(airflow(*),lambda-url,transfer-webapp),ap-northeast-3(airflow(*),lambda-url,transfer-webapp),ap-south-1(airflow(*),lambda-url,transfer-webapp),ap-south-2(airflow(*),transfer-webapp),ap-southeast-1(airflow(*),lambda-url,transfer-webapp),ap-southeast-2(airflow(*),lambda-url,transfer-webapp),ap-southeast-3(airflow(*),lambda-url,transfer-webapp),ap-southeast-4(airflow(*),transfer-webapp),ap-southeast-5(airflow(*),transfer-webapp),ap-southeast-6(transfer-webapp),ap-southeast-7(airflow(*),transfer-webapp),ca-central-1(airflow(*),lambda-url,transfer-webapp),ca-west-1(airflow(*),transfer-webapp),eu-central-1(airflow(*),lambda-url,transfer-webapp),eu-central-2(airflow(*),transfer-webapp),eu-north-1(airflow(*),lambda-url,transfer-webapp),eu-south-1(airflow(*),lambda-url,transfer-webapp),eu-south-2(airflow(*),transfer-webapp),eu-west-1(airflow(*),lambda-url,transfer-webapp),eu-west-2(airflow(*),lambda-url,transfer-webapp),eu-west-3(airflow(*),lambda-url,transfer-webapp),il-central-1(airflow(*),transfer-webapp),me-central-1(airflow(*),transfer-webapp),me-south-1(airflow(*),lambda-url,transfer-webapp),mx-central-1(transfer-webapp),sa-east-1(airflow(*),lambda-url,transfer-webapp),us-east-1(airflow(*),lambda-url,transfer-webapp),us-east-2(airflow(*),lambda-url,transfer-webapp),us-gov-east-1(transfer-webapp,transfer-webapp-fips),us-gov-west-1(transfer-webapp,transfer-webapp-fips),us-west-1(airflow(*),lambda-url,transfer-webapp),us-west-2(airflow(*),lambda-url,transfer-webapp)),repost(private(*)),sagemaker(af-south-1(notebook,studio),ap-east-1(notebook,studio),ap-northeast-1(labeling,notebook,studio),ap-northeast-2(labeling,notebook,studio),ap-northeast-3(notebook,studio),ap-south-1(labeling,notebook,studio),ap-south-2(notebook),ap-southeast-1(labeling,notebook,studio),ap-southeast-2(labeling,notebook,studio),ap-southeast-3(notebook,studio),ap-southeast-4(notebook),ca-central-1(labeling,notebook,notebook-fips,studio),ca-west-1(notebook,notebook-fips),eu-central-1(labeling,notebook,studio),eu-central-2(notebook,studio),eu-north-1(notebook,studio),eu-south-1(notebook,studio),eu-south-2(notebook,studio),eu-west-1(labeling,notebook,studio),eu-west-2(labeling,notebook,studio),eu-west-3(notebook,studio),experiments(*),il-central-1(notebook,studio),me-central-1(notebook,studio),me-south-1(notebook,studio),sa-east-1(notebook,studio),us-east-1(labeling,notebook,notebook-fips,studio),us-east-2(labeling,notebook,notebook-fips,studio),us-gov-east-1(notebook,notebook-fips,studio,studio-fips),us-gov-west-1(notebook,notebook-fips,studio,studio-fips),us-west-1(notebook,notebook-fips,studio),us-west-2(labeling,notebook,notebook-fips,studio))),az(biz,co,com,edu,gov,info,int,mil,name,net,org,pp,pro),ba(brendly(shop),com,edu,gov,mil,net,org,rs),bar(resolve),basketball(aus,nz),bb(biz,co,com,edu,gov,info,net,org,store,tv),bd(ac,ai,co,com,edu,gov,id,info,it,mil,net,org,sch,tv),be(123website,ac,cloudns,interhostsolutions(cloud),kuleuven(ezproxy),my,myspreadshop,transurl(*),webhosting!(site)),berlin(ddns),bf(gov),bg(0,1,2,3,4,5,6,7,8,9,a,b,barsy,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z),bh(com,edu,gov,net,org),bi(co,com,edu,or,org),biz(activetrail,cloud-ip,cloudns,dscloud,dyndns,for-better,for-more,for-some,for-the,jozi,mmafan,myftp,no-ip,orx,selfip,webhop),bj(africa,agro,architectes,assur,avocats,co,com,eco,econo,edu,info,loisirs,money,net,org,ote,restaurant,resto,tourism,univ),bm(com,edu,gov,net,org),bn(co,com,edu,gov,net,org),bo(academia,agro,arte,blog,bolivia,ciencia,com,cooperativa,democracia,deporte,ecologia,economia,edu,empresa,gob,ia,indigena,industria,info,int,medicina,mil,movimiento,musica,natural,net,nombre,noticias,org,patria,plurinacional,politica,profesional,pueblo,revista,salud,tecnologia,tksat,transporte,tv,web,wiki),bot(grok(apps(*),pages(*))),box(sail),br(9guacu,abc,adm,adv,agr,aju,am,anani,aparecida,api,app,arq,art,ato,b,barueri,belem,bet,bhz,bib,bio,blog,bmd,boavista,bsb,campinagrande,campinas,caxias,cim,cng,cnt,com!(simplesite),contagem,coop,coz,cri,cuiaba,curitiba,def,des,det,dev,ecn,eco,edu,emp,enf,eng,esp,etc,eti,far,feira,flog,floripa,fm,fnd,fortal,fot,foz,fst,g12,geo,ggf,goiania,gov!(ac,al,am,ap,ba,ce,df,es,go,ma,mg,ms,mt,pa,pb,pe,pi,pr,rj,rn,ro,rr,rs,sc,se,sp,to),gru,ia,imb,ind,inf,jab,jampa,jdf,joinville,jor,jus,leg!(ac,al,am,ap,ba,ce,df,es,go,ma,mg,ms,mt,pa,pb,pe,pi,pr,rj,rn,ro,rr,rs,sc,se,sp,to),leilao,lel,log,londrina,macapa,maceio,manaus,maringa,mat,med,mil,morena,mp,mus,natal,net,niteroi,nom(*),not,ntr,odo,ong,org,osasco,palmas,poa,ppg,pro,psc,psi,pvh,qsl,radio,rec,recife,rep,ribeirao,rio,riobranco,riopreto,salvador,sampa,santamaria,santoandre,saobernardo,saogonca,seg,sjc,slg,slz,social,sorocaba,srv,taxi,tc,tche,tec,teo,the,tmp,trd,tur,tv,udi,vet,vix,vlog,wiki,xyz,zlg),bs(com,edu,gov,net,org,we),bt(com,edu,gov,net,org),build(shiptoday,v0,windsurf),builders(cloudsite),business(co),bw(ac,co,gov,net,org),by(com,gov,mediatech,mil,of),bz(co,com,edu,gov,gsj,mydns,net,org,za),ca(ab,awdev(*),barsy,bc,box,co,gc,mb,myspreadshop,nb,nf,nl,no-ip,ns,nt,nu,on,onid,pe,qc,sk,yk),camp(emf(at)),casa(nabu(ui)),case(sav),cc(ccwu,cleverapps,cloud-ip,cloudns,csx,ec,eu,fantasyleague,ftpaccess,game-server,gu,loc,myphotos,pvf,scrapping,spawn(instances),sryze,twmail,uk,us),cd(cc,gov),ch(123website,12hp,2ix,4lima,cloudns,cloudscale(cust,lpg(objects),rma(objects)),dnsking,firenet(*,svc(*)),flow(ae(alp1),appengine),gotdns,lima-city,linkyard-cloud,myspreadshop,objectstorage(lpg,rma),square7),ci(ac,asso,aéroport,co,com,ed,edu,go,gouv,int,kz,net,or,org,us,xyz),ck(!www,*),cl(cloudns,co,gob,gov,mil),cloud(antagonist,axarnet(es-1),begetcdn(*),convex!(eu-west-1,us-east-1),diadem,dnshome,elementor,emergent,encoway(eu),hstgr,jelastic(vip),jele,jenv-aruba(aruba(eur(it1)),it1),jote,jotelulu,k2(elastic,ru-msk(lb,s3,website),ru-spb(lb,s3,website),s3,website),keliweb!(cs),kuleuven,laravel,linkyard,magentosite(*),matlab,observablehq,on-rancher(*),online-server,onstackit(runs),oxa!(tn,uk),primetel!(uk),ravendb,reclaim(ca,uk,us),scw(baremetal(fr-par-1,fr-par-2,nl-ams-1),fr-par(cockpit,ddl,dtwh,fnc!(functions),ifr,k8s!(nodes),kafk,mgdb,rdb,s3,s3-website,scbl,whm),instances(priv,pub),k8s,nl-ams(cockpit,ddl,dtwh,ifr,k8s!(nodes),kafk,mgdb,rdb,s3,s3-website,scbl,whm),pl-waw(cockpit,ddl,dtwh,ifr,k8s!(nodes),kafk,mgdb,rdb,s3,s3-website,scbl),scalebook,smartlabeling),servebolt,statics(*),trafficplex,trendhosting(ch,de),unison-services,urown,vapor,voorloper,zap),club(barsy,cloudns,jele),cm(co,com,gov,net),cn(ac,ah,bj,canva-apps,canva-code,canvasite(my),com!(amazonaws(airflow(cn-north-1(*),cn-northwest-1(*)),cn-north-1(dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,rds(*),s3,s3-accesspoint,s3-deprecated,s3-object-lambda,s3-website),cn-northwest-1(dualstack(s3,s3-accesspoint),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,rds(*),s3,s3-accesspoint,s3-object-lambda,s3-website),compute(*),eb(cn-north-1,cn-northwest-1),elb(*)),amazonwebservices(on(cn-north-1(airflow(*),transfer-webapp),cn-northwest-1(airflow(*),transfer-webapp))),sagemaker(cn-north-1(notebook,studio),cn-northwest-1(notebook,studio))),cq,edu,fj,gd,gov,gs,gx,gz,ha,hb,he,hi,hk,hl,hn,jl,js,jx,khsj,ln,mil,mo,myqnapcloud,net,nm,nx,org,qh,quickconnect(direct),sc,sd,sh!(as),sn,sx,tj,tw,xj,xz,yn,zj,公司,網絡,网络),co(carrd,com,crd,edu,firewalledreplit!(id),gov,hidns,leadpages,lpages,mil,mypi,net,nom,org,otap(*),rdpa(clusters(*),srvrless(*)),repl!(id),supabase!(realtime,storage),umso,xmit(*)),codes(owo(*)),com(0emm(*),180r,1cooldns,1kapp,3utilities,4u,a2hosted,abrdns,adobeaemcloud!(dev(*)),africa,aivencloud(*),alibabacloudcs,amazonaws(af-south-1(aws-cloud9(webview-assets),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),airflow(af-south-1(*),ap-east-1(*),ap-northeast-1(*),ap-northeast-2(*),ap-northeast-3(*),ap-south-1(*),ap-south-2(*),ap-southeast-1(*),ap-southeast-2(*),ap-southeast-3(*),ap-southeast-4(*),ap-southeast-5(*),ap-southeast-7(*),ca-central-1(*),ca-west-1(*),eu-central-1(*),eu-central-2(*),eu-north-1(*),eu-south-1(*),eu-south-2(*),eu-west-1(*),eu-west-2(*),eu-west-3(*),il-central-1(*),me-central-1(*),me-south-1(*),sa-east-1(*),us-east-1(*),us-east-2(*),us-west-1(*),us-west-2(*)),ap-east-1(aws-cloud9(webview-assets),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),ap-northeast-1(analytics-gateway,aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),ap-northeast-2(analytics-gateway,aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),ap-northeast-3(aws-cloud9(webview-assets),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),ap-south-1(analytics-gateway,aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),ap-south-2(bedrock-agentcore(consent-portal),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),ap-southeast-1(analytics-gateway,aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),ap-southeast-2(analytics-gateway,aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),ap-southeast-3(dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),ap-southeast-4(dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),ap-southeast-5(bedrock-agentcore(consent-portal),dualstack(s3,s3-accesspoint,s3-website),execute-api,s3,s3-accesspoint,s3-deprecated,s3-object-lambda,s3-website),ap-southeast-7(bedrock-agentcore(consent-portal)),ca-central-1(aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-object-lambda,s3-website),ca-west-1(dualstack(s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-object-lambda,s3-website),compute(*),compute-1(*),elb(*),eu-central-1(analytics-gateway,aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),eu-central-2(dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),eu-north-1(aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),eu-south-1(aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),eu-south-2(bedrock-agentcore(consent-portal),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),eu-west-1(analytics-gateway,aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-deprecated,s3-object-lambda,s3-website),eu-west-2(aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),eu-west-3(aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),il-central-1(aws-cloud9(webview-assets),cloud9(vfs),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),me-central-1(dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),me-south-1(aws-cloud9(webview-assets),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),rds(af-south-1(*),ap-east-1(*),ap-east-2(*),ap-northeast-1(*),ap-northeast-2(*),ap-northeast-3(*),ap-south-1(*),ap-south-2(*),ap-southeast-1(*),ap-southeast-2(*),ap-southeast-3(*),ap-southeast-4(*),ap-southeast-5(*),ap-southeast-6(*),ap-southeast-7(*),ca-central-1(*),ca-west-1(*),eu-central-1(*),eu-central-2(*),eu-west-1(*),eu-west-2(*),eu-west-3(*),il-central-1(*),me-central-1(*),me-south-1(*),mx-central-1(*),sa-east-1(*),us-east-1(*),us-east-2(*),us-gov-east-1(*),us-gov-west-1(*),us-northeast-1(*),us-west-1(*),us-west-2(*)),s3,s3-1,s3-ap-east-1,s3-ap-northeast-1,s3-ap-northeast-2,s3-ap-northeast-3,s3-ap-south-1,s3-ap-southeast-1,s3-ap-southeast-2,s3-ca-central-1,s3-eu-central-1,s3-eu-north-1,s3-eu-west-1,s3-eu-west-2,s3-eu-west-3,s3-external-1,s3-fips-us-gov-east-1,s3-fips-us-gov-west-1,s3-global(accesspoint(mrap)),s3-me-south-1,s3-sa-east-1,s3-us-east-2,s3-us-gov-east-1,s3-us-gov-west-1,s3-us-west-1,s3-us-west-2,s3-website-ap-northeast-1,s3-website-ap-southeast-1,s3-website-ap-southeast-2,s3-website-eu-west-1,s3-website-sa-east-1,s3-website-us-east-1,s3-website-us-gov-west-1,s3-website-us-west-1,s3-website-us-west-2,sa-east-1(aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-object-lambda,s3-website),us-east-1!(analytics-gateway,aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-accesspoint-fips,s3-deprecated,s3-fips,s3-object-lambda,s3-website),us-east-2(analytics-gateway,aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-accesspoint-fips,s3-deprecated,s3-fips,s3-object-lambda,s3-website),us-gov-east-1(dualstack(s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-object-lambda,s3-website),us-gov-west-1(bedrock-agentcore(consent-portal),dualstack(s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-object-lambda,s3-website),us-west-1(aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-object-lambda,s3-website),us-west-2(analytics-gateway,aws-cloud9(webview-assets),bedrock-agentcore(consent-portal),cloud9(vfs,webview-assets),dualstack(s3,s3-accesspoint,s3-accesspoint-fips,s3-fips,s3-website),emrappui-prod,emrnotebooks-prod,emrstudio-prod,execute-api,s3,s3-accesspoint,s3-accesspoint-fips,s3-deprecated,s3-fips,s3-object-lambda,s3-website)),amazoncognito(af-south-1(auth),ap-east-1(auth),ap-east-2(auth),ap-northeast-1(auth),ap-northeast-2(auth),ap-northeast-3(auth),ap-south-1(auth),ap-south-2(auth),ap-southeast-1(auth),ap-southeast-2(auth),ap-southeast-3(auth),ap-southeast-4(auth),ap-southeast-5(auth),ap-southeast-6(auth),ap-southeast-7(auth),ca-central-1(auth),ca-west-1(auth),eu-central-1(auth),eu-central-2(auth),eu-north-1(auth),eu-south-1(auth),eu-south-2(auth),eu-west-1(auth),eu-west-2(auth),eu-west-3(auth),il-central-1(auth),me-central-1(auth),me-south-1(auth),mx-central-1(auth),sa-east-1(auth),us-east-1(auth,auth-fips),us-east-2(auth,auth-fips),us-gov-east-1(auth-fips),us-gov-west-1(auth-fips),us-west-1(auth,auth-fips),us-west-2(auth,auth-fips)),amazonlightsail!(cs(ap-east-1(*),ap-northeast-1(*),ap-northeast-2(*),ap-south-1(*),ap-southeast-1(*),ap-southeast-2(*),ap-southeast-3(*),ap-southeast-5(*),ca-central-1(*),eu-central-1(*),eu-north-1(*),eu-south-2(*),eu-west-1(*),eu-west-2(*),eu-west-3(*),sa-east-1(*),us-east-1(*),us-east-2(*),us-west-2(*))),amplifyapp,appchizi,applinzi,apps-1and1,appspacehosted,appspaceusercontent,appspot!(r(*)),atlassian-3p(*),atlassian-3p-us-gov-mod(*),atlassian-isolated-3p(*),atmeta,auiusercontent(*),authgear-staging,authgearapps,awsapprunner(*),awsapps,awsglobalaccelerator,balena-devices,barsycenter,barsyonline,base44-sandbox,blogdns,blogspot,blogsyte,boutir,bplaced,br,builtwithdark,bumbleshrimp,cafjs,canva-apps,canva-hosted-embed,canvacode,cdn77-storage,cechire,cf-ipfs,ciscofreak,claudeusercontent!(frame),clever-cloud(services(*)),cloudflare-ipfs,cn,co,code(builder(*),dev-builder(*),stg-builder(*)),codespot,cprapid,cpserver,cursorusercontent(*),customer-oci(*,oci(*),ocp(*),ocs(*)),damnserver,databricksapps(aws,azure(*),gcp),datadetect(demo,instance),dattolocal,dattorelay,dattoweb,ddnsfree,ddnsgeek,ddnsguru,ddnsking,de,deployagent,deus-canvas,devinapps(*),digitaloceanspaces(*),discordsays,discordsez,ditchyourip,dnsabr,dnsalias,dnsdojo,dnsiskinky,doesntexist,dojin,dontexist,doomdns,dopaas,drayddns,dreamhosters,drive-platform,dsmynas,durumis,dyn-o-saur,dynalias,dyndns-at-home,dyndns-at-work,dyndns-blog,dyndns-free,dyndns-home,dyndns-ip,dyndns-mail,dyndns-office,dyndns-pics,dyndns-remote,dyndns-server,dyndns-web,dyndns-wiki,dyndns-work,dynns,dynuddns,dynuhosting,elasticbeanstalk!(af-south-1,ap-east-1,ap-northeast-1,ap-northeast-2,ap-northeast-3,ap-south-1,ap-south-2,ap-southeast-1,ap-southeast-2,ap-southeast-3,ap-southeast-4,ap-southeast-5,ap-southeast-6,ap-southeast-7,ca-central-1,ca-west-1,eu-central-1,eu-central-2,eu-north-1,eu-south-1,eu-south-2,eu-west-1,eu-west-2,eu-west-3,il-central-1,me-central-1,me-south-1,sa-east-1,us-east-1,us-east-2,us-gov-east-1,us-gov-west-1,us-west-1,us-west-2),emergentagent(preview),encoreapi,est-a-la-maison,est-a-la-masion,est-le-patron,est-mon-blogueur,eu,eu1-plenit,evennode(eu-1,eu-2,eu-3,eu-4,us-1,us-2,us-3,us-4),familyds,fastly-edge,fastly-terrarium,fastvps-server,fbsbx(apps),fin-ncloudstorage(object(kr!(s3-website)),private(object(kr))),firebaseapp,firewall-gateway,fldrv,forgeblocks,framercanvas,freebox-os,freeboxos,freemyip,from-ak,from-al,from-ar,from-ca,from-ct,from-dc,from-de,from-fl,from-ga,from-hi,from-ia,from-id,from-il,from-in,from-ks,from-ky,from-ma,from-md,from-mi,from-mn,from-mo,from-ms,from-mt,from-nc,from-nd,from-ne,from-nh,from-nj,from-nm,from-nv,from-oh,from-ok,from-or,from-pa,from-pr,from-ri,from-sc,from-sd,from-tn,from-tx,from-ut,from-va,from-vt,from-wa,from-wi,from-wv,from-wy,gcorecdn,geekgalaxy,gentapps,gentlentapis,getmyip,giize,githubusercontent,gleeze,googleapis,googlecode,gotdns,gotpantheon,gov-ncloudstorage(kr,kr-private,object(kr!(s3-website),krs!(s3-website)),private(object(kr,krs))),gr,grayjayleagues,hatenablog,hatenadiary,health-carereform,hercules-app,hercules-dev,herokuapp!(compute(*)),hk,hobby-site,homelinux,homesecuritymac,homesecuritypc,homeunix,hosted-by-files,hosted-by-previder(paas),hostedpi,hosteur(rag-cloud,rag-cloud-ch),hotelwithflight,iamallama,ik-server(jcloud,jcloud-ver-jpc),ip-ddns,is-a-anarchist,is-a-blogger,is-a-bookkeeper,is-a-bulls-fan,is-a-caterer,is-a-chef,is-a-conservative,is-a-cpa,is-a-cubicle-slave,is-a-democrat,is-a-designer,is-a-doctor,is-a-financialadvisor,is-a-geek,is-a-green,is-a-guru,is-a-hard-worker,is-a-hunter,is-a-landscaper,is-a-lawyer,is-a-liberal,is-a-libertarian,is-a-llama,is-a-musician,is-a-nascarfan,is-a-nurse,is-a-painter,is-a-personaltrainer,is-a-photographer,is-a-player,is-a-republican,is-a-rockstar,is-a-socialist,is-a-student,is-a-teacher,is-a-techie,is-a-therapist,is-an-accountant,is-an-actor,is-an-actress,is-an-anarchist,is-an-artist,is-an-engineer,is-an-entertainer,is-certified,is-gone,is-into-anime,is-into-cars,is-into-cartoons,is-into-games,is-leet,is-not-certified,is-slick,is-uberleet,is-with-theband,isa-geek,isa-hockeynut,issmarterthanyou,it,jdevcloud,jelastic(demo),jpn,kasserver,kozow,la1-plenit,ladesk,likes-pie,likescandy,linode(members,nodebalancer(*)),linodeobjects(*),linodeusercontent(ip),live-website,localtonet,logoip,loseyourip,lovableproject,lpusercontent,lutrausercontent(*),magicpatternsapp,massivegrid(paas),messwithdns,metaaiusercontent(*),meteorapp!(eu),mex,miniserver,mochausercontent,modelscape,mwcloudnonprod,myactivedirectory,myasustor,mycloudnas,mydatto,mydbserver,mydobiss,myiphost,mynascloud,myoxypages,myqnapcloud,mysecuritycamera,myshopblocks,myshopify,myspreadshop,mytabit,mythic-beasts(caracal,customer,fentiger,lynx,ocelot,oncilla,onza,sphinx,vs,x,yali),mytuleap,myvnc,ncloud(objectstorage(kr,sg)),ncloudstorage(kr,kr-naver,kr-naver-dev,kr-private,object(de!(s3-website),kr!(s3-website),sg!(s3-website),us!(s3-website)),private(object(kr,sg)),website(kr,kr-naver,kr-naver-dev)),ncpstorage(object(jp,jp4(jp),jp5(jp),kr,s3-website-jp),private(object(jp,jp4(jp),jp5(jp),kr))),neat-url,net-freaks,nfshost,ninjaneer-sites,nospamproxy(cloud!(o365)),oaiusercontent(*),observableusercontent(static),on-aptible,on-forge,on-vapor,onrender,onthewifi,ooguy,operaunite,oraclecloudapps(*),oraclegovcloudapps(*),orsites,outsystemscloud,ownprovider,pagespeedmobilizer,paywhirl(*),pgfog,pivohosting,pixolino,playstation-cloud,pleskns,point2this,polyspace,postman-echo,prairielearn-user-content(*),prgmr(xen),project-study(dev),pythonanywhere!(eu),qa2,qbuser,qualifioapp,qualyhqpartner(*),qualyhqportal(*),quicksytes,quipelements(*),rackmaze,readthedocs-hosted,remotewd,render(app),reservd,rhcloud,rice-labs,routingthecloud,ru,sa,sakuratan,sakuraweb,salesforce(platform(code-builder-stg(test(001(*))))),same-app,same-preview,saves-the-whales,scrysec,securitytactics,selfip,sells-for-less,sells-for-u,servebbs,servebeer,servecounterstrike,serveexchange,serveftp,servegame,servehalflife,servehttp,servehumour,serveirc,servemp3,servep2p,servepics,servequake,servesarcasm,shopitsite,siiites,simple-url,simplesite,sinaapp,smushcdn,space-to-rent,stackhero-network,strapiapp!(media),streak-link,streaklinks,streakusercontent,streamlitapp,stufftoread,subsc-pay,taveusercontent,tb-hosting(site),teaches-yoga,temp-dns,theworkpc,thingdustdata,townnews-staging,try-snowplow,trycloudflare,tuleap-partners,typeform(pro),uk,unusualperson,upsunapp,us,us1-plenit,vipsinaapp,vivenushop,vultrobjects(*),w-corp-staticblitz,w-credentialless-staticblitz,w-staticblitz,wafaicloud(jed,ryd),wafflecell,webadorsite,webspace-host,wiardweb(pages),wiredbladehosting,withgoogle,withyoutube,wixsite,wixstudio,woltlab-demo,wordsmithmcpcontent!(staging),workisboring,wpdevcloud,wpenginepowered!(js),wphostedmail,wpmucdn,writesthisblog,x0,xtooldevice,yolasite,za,ztna-dingtalk(*)),community(myforum,nog,ravendb),company(mybox),cool(de,elementor),cr(ac,co,ed,fi,go,or,sa),cu(com,edu,gob,inf,nat,net,org),cv(com,dev,edu,id,int,net,nome,org,publ,store),cw(com,edu,net,org),cx(assessments,ath,calculators,cloudns,funnels,gov,info,paynow,quizzes,researched,tests),cy(ac,biz,com!(scaleforce(j)),ekloges,gov,ltd,mil,net,org,press,pro,tm),cz(co,contentproxy9(rsc),e4,gov,metacentrum(cloud(*),custom),muni(cloud(flt,usr)),realm),de(123webseite,12hp,2ix,4lima,barsy,bplaced,bwcloud-os-instance(*),co,com,community-pro,cosidns(dyn),ddnss!(dyn,dyndns),ddnssec,diskussionsbereich,dnshome,dnsupdater,dyn-berlin,dyn-ip24,dynamisches-dns,dyndns1,dyndnssec,firewall-gateway,frusky(*),fuettertdasnetz,git-repos,goip,gov,günstigbestellen,günstigliefern,heimdns,home-webserver!(dyn),home64,hs-heilbronn(it(pages,pages-research)),in-berlin,in-brb,in-butter,in-dsl,in-vpn,internet-dns,ipv64,iservschule,isteingeek,istmein,keymachine,l-o-g-i-n,lcube-server,lebtimnetz,leitungsen,lima-city,logoip,mein-iserv,my,my-gateway,my-router,myhome-server,myspreadshop,rub,ruhr-uni-bochum!(noc(io)),schuldock,schulplattform,schulserver,spdns,speedpartner(customer),square7,srvdns,svn-repos,taifun-dns,test-iserv,traeumtgerade,virtual-user,virtualuser,webspaceconfig,xenonconnect(*)),design(bss,graphic),dev(abyme,barsy,bearblog,botdash,brave!(s(*)),codepen,crm(aa(*),ab(*),ac(*),ad(*),ae(*),af(*),ci(*),d(*),pa(*),pb(*),pc(*),pd(*),pe(*),pf(*),w(*),wa(*),wb(*),wc(*),wd(*),we(*),wf(*)),deno,deno-staging,erp!(web),evervault(relay),fly,gateway(*),githubpreview,grebedoc,hrsn,inbrowser(*),is-a,is-a-fullstack,is-a-good,is-cool,is-not-a,iserv,lcl(*),lclstage(*),leapcell,localcert(user(*)),localplayer,loginline,lp!(api,objects),mediatech,mocha-sandbox,modx,myaddr,ngrok,ngrok-free,pagelemon,pages,panel,payload,platter-app,r2,reliantlabs!(sites),reliantpreview,replit(*,teams(*)),runcontainers,stg(*),stgstage(*),storage(t3),storageapi(t3),uncld,vercel,vivenushop,webhare(*),workers,xmit),direct(libp2p),diy(discourse),dk(123hjemmeside,biz,co,firm,myspreadshop,reg,store),dm(co,com,edu,gov,net,org),do(art,com,edu,gob,gov,mil,net,org,sld,web),dz(art,asso,com,edu,gov,net,org,pol,soc,tm),ec(abg,adm,agron,arqt,art,bar,base,chef,com,cont,cpa,cue,dent,dgn,disco,doc,edu,eng,esm,fin,fot,gal,gob,gov,gye,ibr,info,k12,lat,loj,med,mil,mktg,mon,net,ntr,odont,official,org,pro,prof,psic,psiq,pub,rio,rrpp,sal,tech,tul,tur,uio,vet,xxx),edu(rit(git-pages)),education(co),ee(aip,com,edu,fie,gov,lib,med,org,pri,riik),eg(ac,com,edu,eun,gov,info,me,mil,name,net,org,sci,sport,tv),email(intouch,tawk(p),tawkto(p)),er(*),es(123miweb,com,edu,gob,myspreadshop,nom,org),estate(compute(*)),et(biz,com,edu,gov,info,name,net,org),eu(amazonwebservices(on(eusc-de-east-1(cognito-idp(auth),transfer-webapp))),barsy,cloudns,deuxfleurs,directwp,dnshome,dogado(jelastic),nxa(*),prvw,spdns,transurl(*)),eus(party(user)),events(co,koobin),fan(mkm),fast(space,view),fi(123kotisivu,aland,cloudplatform(fi),dy,häkkinen,iki,kapsi,myspreadshop),financial(co),fj(ac,biz,com,edu,gov,id,info,mil,name,net,org,pro),fk(*),fm(com,edu,net,org,radio,user(*)),fo(co,com),fr(123siteweb,aeroport,asso,avocat,avoues,cci,chambagri,chirurgiens-dentistes,chirurgiens-dentistes-en-france,com,dedibox,experts-comptables,fbx-os,fbxos,freebox-os,freeboxos,goupile,gouv,greta,huissier-justice,kdns,medecin,myspreadshop,nom,notaires,on-web,pharmacien,port,prd,tm,veterinaire,ynh),fun(ms,vicp,yicp,zicp),games(pley,sheezy),gay(pages),gd(edu,gov),gdn(cnpy),ge(com,cyb,ddns,edu,gov,llc,net,online,org,pvt,school,tnx),gg(botdash,co,kaas,net,org,panel!(daemon),ply(at(*),d6),stackit),gh(biz,com,edu,gov,mil,net,org),gi(com,edu,gov,ltd,mod,org),gl(co,com,edu,net,org),global(appwrite),gn(ac,com,edu,gov,net,org),goog(cloud,translate,usercontent(*)),gp(asso,com,edu,mobi,net,org),gr(barsy,com,edu,gov,net,org,simplesite),group(discourse),gt(com,edu,gob,ind,mil,net,org),gu(com,edu,gov,guam,info,net,org,web),gw(nx),gy(co,com,edu,gov,net,org),health(hra),hk(com,edu,gov,idv,inc,ltd,net,org,个人,個人,公司,政府,敎育,教育,箇人,組織,組织,網絡,網络,组織,组织,网絡,网络),hn(com,edu,gob,mil,net,org),host(amba(app,cdn,fn,go),bolt,cloudaccess,easypanel,emergent,fastvps,freesite,gadget,half,iserv,jele,mircloud,myfast,tempurl,voati,wp2,wpmudev),hosting(opencraft),hr(brendly(shop),com,from,iz,name),ht(adult,art,asso,com,coop,edu,firm,gouv,info,med,net,org,perso,pol,pro,rel,rt,shop),hu(2000,agrar,bolt,casino,city,co,erotica,erotika,film,forum,games,hotel,info,ingatlan,jogasz,konyvelo,lakas,media,news,org,priv,reklam,sex,shop,sport,suli,szex,tm,tozsde,utazas,video),id(ac,ai,biz,co,desa,e,go,kop,mil,my,net,or,ponpes,sch,web,zone,ᬩᬮᬶ),ie(gov,myspreadshop),il(ac,co!(mytabit,ravpage,tabitorder),gov,idf,k12,muni,net,org),im(ac,co!(ltd,plc),com,net,org,tt,tv),in(5g,6g,ac,aero,ai,alumni,am,bank,barsy,bihar,biz,business,ca,cloudns,cn,co,com,coop,cs,delhi,dr,edu,er,fin,firm,gen,gov,gujarat,ind,indevs,info,int,internet,io,me,mil,net,nic,org,pg,post,pro,res,school,supabase,travel,tv,ub,uk,up,us,web),info(barrel-of-knowledge,barrell-of-knowledge,barsy,cloudns,dnsupdate,dvrcam,dynamic-dns,dyndns,for-our,forumz,groks-the,groks-this,here-for-more,ilovecollege,knowsitall,mayfirst,mittwald,mittwaldserver,no-ip,nsupdate,selfip,typo3server,v-info,webhop),int(eu),io(2038,apigee,azurecontainer(*),b-data,barsy,basicserver,beagleboard,beebyte(paas),beebyteapp(sekd1),bitbucket,bluebite,boxfuse,brave!(s(*)),browsersafetymark,bubble(cdn),bubbleapps,cleverapps,cloudbeesusercontent,co,com,dappnode(dyndns),darklang,dedyn,definima,drive-platform,editorx,edu,edugit,fh-muenster,forgerock(id),gitbook,github,gitlab,gov,hasura-app,hostyhosting,hypernode,icp0!(raw(*)),icp1!(raw(*)),jele,keenetic,kiloapps,lair(apps),loginline,lolipop,mailerpage,mil,mo-siemens,moonscale(*),musician,myaddr,myrdbx,net,ngrok!(ap,au,eu,in,jp,sa,us),nodeart(stage),nom,on-k3s(*),on-rio(*),org,pantheonsite,pstmn!(mock),qcx!(sys(*)),qoto,qzz,rb-hosting(site),readthedocs,resindevice,resinstaging(devices),sandcats,scrypted(client),stolos(*),subscribepage,telebit,terramind,thingdust(dev(cust,reservd),disrec(cust,reservd),prod(cust),testing(cust,reservd)),tickets,utwente,vaporcloud,virtualserver,webflow,webflowtest,webthings,wixstudio,wz),iq(com,edu,gov,mil,net,org),ir(ac,arvanedge,co,gov,id,net,org,sch,vistablog,ايران,ایران),it(123homepage,16-b,32-b,64-b,abr,abruzzo,ag,agrigento,al,alessandria,alto-adige,altoadige,an,ancona,andria-barletta-trani,andria-trani-barletta,andriabarlettatrani,andriatranibarletta,ao,aosta,aosta-valley,aostavalley,aoste,ap,aq,ar,arezzo,ascoli-piceno,ascolipiceno,asti,at,av,avellino,ba,balsan,balsan-sudtirol,balsan-suedtirol,balsan-südtirol,bari,barletta-trani-andria,barlettatraniandria,bas,basilicata,belluno,benevento,bergamo,bg,bi,biella,bl,bn,bo,bologna,bolzano,bolzano-altoadige,bozen,bozen-sudtirol,bozen-suedtirol,bozen-südtirol,br,brescia,brindisi,bs,bt,bulsan,bulsan-sudtirol,bulsan-suedtirol,bulsan-südtirol,bz,ca,cagliari,cal,calabria,caltanissetta,cam,campania,campidano-medio,campidanomedio,campobasso,carbonia-iglesias,carboniaiglesias,carrara-massa,carraramassa,caserta,catania,catanzaro,cb,ce,cesena-forli,cesena-forlì,cesenaforli,cesenaforlì,ch,chieti,ci,cl,cn,co,como,cosenza,cr,cremona,crotone,cs,ct,cuneo,cz,dell-ogliastra,dellogliastra,dnshome,edu,emilia-romagna,emiliaromagna,emr,en,enna,fc,fe,fermo,ferrara,fg,fi,firenze,florence,fm,foggia,forli-cesena,forlicesena,forlì-cesena,forlìcesena,fr,friuli-v-giulia,friuli-ve-giulia,friuli-vegiulia,friuli-venezia-giulia,friuli-veneziagiulia,friuli-vgiulia,friuliv-giulia,friulive-giulia,friulivegiulia,friulivenezia-giulia,friuliveneziagiulia,friulivgiulia,frosinone,fvg,ge,genoa,genova,go,gorizia,gov,gr,grosseto,ibxos,iglesias-carbonia,iglesiascarbonia,iliadboxos,im,imperia,is,isernia,kr,la-spezia,laquila,laspezia,latina,laz,lazio,lc,le,lecce,lecco,li,lig,liguria,livorno,lo,lodi,lom,lombardia,lombardy,lt,lu,lucania,lucca,macerata,mantova,mar,marche,massa-carrara,massacarrara,matera,mb,mc,me,medio-campidano,mediocampidano,messina,mi,milan,milano,mn,mo,modena,mol,molise,monza,monza-brianza,monza-e-della-brianza,monzabrianza,monzaebrianza,monzaedellabrianza,ms,mt,myspreadshop,na,naples,napoli,neen(jc),no,novara,nu,nuoro,og,ogliastra,olbia-tempio,olbiatempio,or,oristano,ot,pa,padova,padua,palermo,parma,pavia,pc,pd,pe,perugia,pesaro-urbino,pesarourbino,pescara,pg,pi,piacenza,piedmont,piemonte,pisa,pistoia,pmn,pn,po,pordenone,potenza,pr,prato,pt,pu,pug,puglia,pv,pz,ra,ragusa,ravenna,rc,re,reggio-calabria,reggio-emilia,reggiocalabria,reggioemilia,rg,ri,rieti,rimini,rm,rn,ro,roma,rome,rovigo,sa,salerno,sar,sardegna,sardinia,sassari,savona,si,sic,sicilia,sicily,siena,siracusa,so,sondrio,sp,sr,ss,su,sud-sardegna,sudsardegna,suedtirol,sv,syncloud,südtirol,ta,taa,taranto,te,tempio-olbia,tempioolbia,teramo,terni,tn,to,torino,tos,toscana,tp,tr,trani-andria-barletta,trani-barletta-andria,traniandriabarletta,tranibarlettaandria,trapani,trentin-sud-tirol,trentin-sudtirol,trentin-sued-tirol,trentin-suedtirol,trentin-süd-tirol,trentin-südtirol,trentino,trentino-a-adige,trentino-aadige,trentino-alto-adige,trentino-altoadige,trentino-s-tirol,trentino-stirol,trentino-sud-tirol,trentino-sudtirol,trentino-sued-tirol,trentino-suedtirol,trentino-süd-tirol,trentino-südtirol,trentinoa-adige,trentinoaadige,trentinoalto-adige,trentinoaltoadige,trentinos-tirol,trentinostirol,trentinosud-tirol,trentinosued-tirol,trentinosuedtirol,trentinosüd-tirol,trentinosüdtirol,trentinsud-tirol,trentinsudtirol,trentinsued-tirol,trentinsuedtirol,trentinsüd-tirol,trentinsüdtirol,trento,treviso,trieste,ts,turin,tuscany,tv,ud,udine,umb,umbria,urbino-pesaro,urbinopesaro,va,val-d-aosta,val-daosta,vald-aosta,valle-aosta,valle-d-aosta,valle-daosta,valleaosta,valled-aosta,valledaosta,vallee-aoste,vallee-d-aoste,valleeaoste,valleedaoste,vallée-aoste,vallée-d-aoste,valléeaoste,valléedaoste,vao,varese,vb,vc,vda,ve,ven,veneto,venezia,venice,verbania,verbano-cusio-ossola,vercelli,verona,vi,vibo-valentia,vibovalentia,vicenza,viterbo,vr,vs,vt,vv),je(co,net,of,org),jm(*),jo(agri,ai,com,edu,eng,fm,gov,mil,net,org,per,phd,sch,tv),jp(0am,0g0,0j0,0t0,2-d,ac,ad,aichi!(aisai,ama,anjo,asuke,chiryu,chita,fuso,gamagori,handa,hazu,hekinan,higashiura,ichinomiya,inazawa,inuyama,isshiki,iwakura,kanie,kariya,kasugai,kira,kiyosu,komaki,konan,kota,mihama,miyoshi,nishio,nisshin,obu,oguchi,oharu,okazaki,owariasahi,seto,shikatsu,shinshiro,shitara,tahara,takahama,tobishima,toei,togo,tokai,tokoname,toyoake,toyohashi,toyokawa,toyone,toyota,tsushima,yatomi),akita!(akita,daisen,fujisato,gojome,hachirogata,happou,higashinaruse,honjo,honjyo,ikawa,kamikoani,kamioka,katagami,kazuno,kitaakita,kosaka,kyowa,misato,mitane,moriyoshi,nikaho,noshiro,odate,oga,ogata,semboku,yokote,yurihonjo),angry,aomori!(aomori,gonohe,hachinohe,hashikami,hiranai,hirosaki,itayanagi,kuroishi,misawa,mutsu,nakadomari,noheji,oirase,owani,rokunohe,sannohe,shichinohe,shingo,takko,towada,tsugaru,tsuruta),babyblue,babymilk,backdrop,bambina,bitter,blush,bona,boo,boy,boyfriend,but,buyshop,candypop,capoo,catfood,cheap,chiba!(abiko,asahi,chonan,chosei,choshi,chuo,funabashi,futtsu,hanamigawa,ichihara,ichikawa,ichinomiya,inzai,isumi,kamagaya,kamogawa,kashiwa,katori,katsuura,kimitsu,kisarazu,kozaki,kujukuri,kyonan,matsudo,midori,mihama,minamiboso,mobara,mutsuzawa,nagara,nagareyama,narashino,narita,noda,oamishirasato,omigawa,onjuku,otaki,sakae,sakura,shimofusa,shirako,shiroi,shisui,sodegaura,sosa,tako,tateyama,togane,tohnosho,tomisato,urayasu,yachimata,yachiyo,yokaichiba,yokoshibahikari,yotsukaido),chicappa,chillout,chips,chowder,chu,ciao,co,cocotte,coolblog,cranky,crap,cutegirl,daa,daynight,deca,deci,digick,ed,eek,egoism,ehime!(ainan,honai,ikata,imabari,iyo,kamijima,kihoku,kumakogen,masaki,matsuno,matsuyama,namikata,niihama,ozu,saijo,seiyo,shikokuchuo,tobe,toon,uchiko,uwajima,yawatahama),fakefur,fashionstore,fem,flier,flop,floppy,fool,frenchkiss,fukui!(echizen,eiheiji,fukui,ikeda,katsuyama,mihama,minamiechizen,obama,ohi,ono,sabae,sakai,takahama,tsuruga,wakasa),fukuoka!(ashiya,buzen,chikugo,chikuho,chikujo,chikushino,chikuzen,chuo,dazaifu,fukuchi,hakata,higashi,hirokawa,hisayama,iizuka,inatsuki,kaho,kasuga,kasuya,kawara,keisen,koga,kurate,kurogi,kurume,minami,miyako,miyama,miyawaka,mizumaki,munakata,nakagawa,nakama,nishi,nogata,ogori,okagaki,okawa,oki,omuta,onga,onojo,oto,saigawa,sasaguri,shingu,shinyoshitomi,shonai,soeda,sue,tachiarai,tagawa,takata,toho,toyotsu,tsuiki,ukiha,umi,usui,yamada,yame,yanagawa,yukuhashi),fukushima!(aizubange,aizumisato,aizuwakamatsu,asakawa,bandai,date,fukushima,furudono,futaba,hanawa,higashi,hirata,hirono,iitate,inawashiro,ishikawa,iwaki,izumizaki,kagamiishi,kaneyama,kawamata,kitakata,kitashiobara,koori,koriyama,kunimi,miharu,mishima,namie,nango,nishiaizu,nishigo,okuma,omotego,ono,otama,samegawa,shimogo,shirakawa,showa,soma,sukagawa,taishin,tamakawa,tanagura,tenei,yabuki,yamato,yamatsuri,yanaizu,yugawa),gifu!(anpachi,ena,gifu,ginan,godo,gujo,hashima,hichiso,hida,higashishirakawa,ibigawa,ikeda,kakamigahara,kani,kasahara,kasamatsu,kawaue,kitagata,mino,minokamo,mitake,mizunami,motosu,nakatsugawa,ogaki,sakahogi,seki,sekigahara,shirakawa,tajimi,takayama,tarui,toki,tomika,wanouchi,yamagata,yaotsu,yoro),girlfriend,girly,gloomy,go,gonna,gr,greater,gunma!(annaka,chiyoda,fujioka,higashiagatsuma,isesaki,itakura,kanna,kanra,katashina,kawaba,kiryu,kusatsu,maebashi,meiwa,midori,minakami,naganohara,nakanojo,nanmoku,numata,oizumi,ora,ota,shibukawa,shimonita,shinto,showa,takasaki,takayama,tamamura,tatebayashi,tomioka,tsukiyono,tsumagoi,ueno,yoshioka),hacca,halfmoon,handcrafted,hateblo,hatenablog,hatenadiary,heavy,her,hiho,hippy,hiroshima!(asaminami,daiwa,etajima,fuchu,fukuyama,hatsukaichi,higashihiroshima,hongo,jinsekikogen,kaita,kui,kumano,kure,mihara,miyoshi,naka,onomichi,osakikamijima,otake,saka,sera,seranishi,shinichi,shobara,takehara),hokkaido!(abashiri,abira,aibetsu,akabira,akkeshi,asahikawa,ashibetsu,ashoro,assabu,atsuma,bibai,biei,bifuka,bihoro,biratori,chippubetsu,chitose,date,ebetsu,embetsu,eniwa,erimo,esan,esashi,fukagawa,fukushima,furano,furubira,haboro,hakodate,hamatonbetsu,hidaka,higashikagura,higashikawa,hiroo,hokuryu,hokuto,honbetsu,horokanai,horonobe,ikeda,imakane,ishikari,iwamizawa,iwanai,kamifurano,kamikawa,kamishihoro,kamisunagawa,kamoenai,kayabe,kembuchi,kikonai,kimobetsu,kitahiroshima,kitami,kiyosato,koshimizu,kunneppu,kuriyama,kuromatsunai,kushiro,kutchan,kyowa,mashike,matsumae,mikasa,minamifurano,mombetsu,moseushi,mukawa,muroran,naie,nakagawa,nakasatsunai,nakatombetsu,nanae,nanporo,nayoro,nemuro,niikappu,niki,nishiokoppe,noboribetsu,numata,obihiro,obira,oketo,okoppe,otaru,otobe,otofuke,otoineppu,oumu,ozora,pippu,rankoshi,rebun,rikubetsu,rishiri,rishirifuji,saroma,sarufutsu,shakotan,shari,shibecha,shibetsu,shikabe,shikaoi,shimamaki,shimizu,shimokawa,shinshinotsu,shintoku,shiranuka,shiraoi,shiriuchi,sobetsu,sunagawa,taiki,takasu,takikawa,takinoue,teshikaga,tobetsu,tohma,tomakomai,tomari,toya,toyako,toyotomi,toyoura,tsubetsu,tsukigata,urakawa,urausu,uryu,utashinai,wakkanai,wassamu,yakumo,yoichi),holy,hungry,hyogo!(aioi,akashi,ako,amagasaki,aogaki,asago,ashiya,awaji,fukusaki,goshiki,harima,himeji,ichikawa,inagawa,itami,kakogawa,kamigori,kamikawa,kasai,kasuga,kawanishi,miki,minamiawaji,nishinomiya,nishiwaki,ono,sanda,sannan,sasayama,sayo,shingu,shinonsen,shiso,sumoto,taishi,taka,takarazuka,takasago,takino,tamba,tatsuno,toyooka,yabu,yashiro,yoka,yokawa),ibaraki!(ami,asahi,bando,chikusei,daigo,fujishiro,hitachi,hitachinaka,hitachiomiya,hitachiota,ibaraki,ina,inashiki,itako,iwama,joso,kamisu,kasama,kashima,kasumigaura,koga,miho,mito,moriya,naka,namegata,oarai,ogawa,omitama,ryugasaki,sakai,sakuragawa,shimodate,shimotsuma,shirosato,sowa,suifu,takahagi,tamatsukuri,tokai,tomobe,tone,toride,tsuchiura,tsukuba,uchihara,ushiku,yachiyo,yamagata,yawara,yuki),icurus,ishikawa!(anamizu,hakui,hakusan,kaga,kahoku,kanazawa,kawakita,komatsu,nakanoto,nanao,nomi,nonoichi,noto,shika,suzu,tsubata,tsurugi,uchinada,wajima),itigo,iwate!(fudai,fujisawa,hanamaki,hiraizumi,hirono,ichinohe,ichinoseki,iwaizumi,iwate,joboji,kamaishi,kanegasaki,karumai,kawai,kitakami,kuji,kunohe,kuzumaki,miyako,mizusawa,morioka,ninohe,noda,ofunato,oshu,otsuchi,rikuzentakata,shiwa,shizukuishi,sumita,tanohata,tono,yahaba,yamada),jeez,jellybean,kagawa!(ayagawa,higashikagawa,kanonji,kotohira,manno,marugame,mitoyo,naoshima,sanuki,tadotsu,takamatsu,tonosho,uchinomi,utazu,zentsuji),kagoshima!(akune,amami,hioki,isa,isen,izumi,kagoshima,kanoya,kawanabe,kinko,kouyama,makurazaki,matsumoto,minamitane,nakatane,nishinoomote,satsumasendai,soo,tarumizu,yusui),kanagawa!(aikawa,atsugi,ayase,chigasaki,ebina,fujisawa,hadano,hakone,hiratsuka,isehara,kaisei,kamakura,kiyokawa,matsuda,minamiashigara,miura,nakai,ninomiya,odawara,oi,oiso,sagamihara,samukawa,tsukui,yamakita,yamato,yokosuka,yugawara,zama,zushi),kawaiishop,kawasaki(!city,*),kikirara,kill,kilo,kitakyushu(!city,*),kobe(!city,*),kochi!(aki,geisei,hidaka,higashitsuno,ino,kagami,kami,kitagawa,kochi,mihara,motoyama,muroto,nahari,nakamura,nankoku,nishitosa,niyodogawa,ochi,okawa,otoyo,otsuki,sakawa,sukumo,susaki,tosa,tosashimizu,toyo,tsuno,umaji,yasuda,yusuhara),kumamoto!(amakusa,arao,aso,choyo,gyokuto,kamiamakusa,kikuchi,kumamoto,mashiki,mifune,minamata,minamioguni,nagasu,nishihara,oguni,ozu,sumoto,takamori,uki,uto,yamaga,yamato,yatsushiro),kuron,kyoto!(ayabe,fukuchiyama,higashiyama,ide,ine,joyo,kameoka,kamo,kita,kizu,kumiyama,kyotamba,kyotanabe,kyotango,maizuru,minami,minamiyamashiro,miyazu,muko,nagaokakyo,nakagyo,nantan,oyamazaki,sakyo,seika,tanabe,uji,ujitawara,wazuka,yamashina,yawata),lg,littlestar,lolipopmc,lolitapunk,lomo,lovepop,lovesick,main,matrix,mie!(asahi,inabe,ise,kameyama,kawagoe,kiho,kisosaki,kiwa,komono,kumano,kuwana,matsusaka,meiwa,mihama,minamiise,misugi,miyama,nabari,shima,suzuka,tado,taiki,taki,tamaki,toba,tsu,udono,ureshino,watarai,yokkaichi),mimoza,miyagi!(furukawa,higashimatsushima,ishinomaki,iwanuma,kakuda,kami,kawasaki,marumori,matsushima,minamisanriku,misato,murata,natori,ogawara,ohira,onagawa,osaki,rifu,semine,shibata,shichikashuku,shikama,shiogama,shiroishi,tagajo,taiwa,tome,tomiya,wakuya,watari,yamamoto,zao),miyazaki!(aya,ebino,gokase,hyuga,kadogawa,kawaminami,kijo,kitagawa,kitakata,kitaura,kobayashi,kunitomi,kushima,mimata,miyakonojo,miyazaki,morotsuka,nichinan,nishimera,nobeoka,saito,shiiba,shintomi,takaharu,takanabe,takazaki,tsuno),mods,mond,mongolian,moo,mydns,nagano!(achi,agematsu,anan,aoki,asahi,azumino,chikuhoku,chikuma,chino,fujimi,hakuba,hara,hiraya,iida,iijima,iiyama,iizuna,ikeda,ikusaka,ina,karuizawa,kawakami,kiso,kisofukushima,kitaaiki,komagane,komoro,matsukawa,matsumoto,miasa,minamiaiki,minamimaki,minamiminowa,minowa,miyada,miyota,mochizuki,nagano,nagawa,nagiso,nakagawa,nakano,nozawaonsen,obuse,ogawa,okaya,omachi,omi,ookuwa,ooshika,otaki,otari,sakae,sakaki,saku,sakuho,shimosuwa,shinanomachi,shiojiri,suwa,suzaka,takagi,takamori,takayama,tateshina,tatsuno,togakushi,togura,tomi,ueda,wada,yamagata,yamanouchi,yasaka,yasuoka),nagasaki!(chijiwa,futsu,goto,hasami,hirado,iki,isahaya,kawatana,kuchinotsu,matsuura,nagasaki,obama,omura,oseto,saikai,sasebo,seihi,shimabara,shinkamigoto,togitsu,tsushima,unzen),nagoya(!city,*),namaste,nara!(ando,gose,heguri,higashiyoshino,ikaruga,ikoma,kamikitayama,kanmaki,kashiba,kashihara,katsuragi,kawai,kawakami,kawanishi,koryo,kurotaki,mitsue,miyake,nara,nosegawa,oji,ouda,oyodo,sakurai,sango,shimoichi,shimokitayama,shinjo,soni,takatori,tawaramoto,tenkawa,tenri,uda,yamatokoriyama,yamatotakada,yamazoe,yoshino),ne!(aseinet(user),gehirn,ivory,mail-box,mints,mokuren,opal,sakura,sumomo,topaz),netgamers,niigata!(aga,agano,gosen,itoigawa,izumozaki,joetsu,kamo,kariwa,kashiwazaki,minamiuonuma,mitsuke,muika,murakami,myoko,nagaoka,niigata,ojiya,omi,sado,sanjo,seiro,seirou,sekikawa,shibata,tagami,tainai,tochio,tokamachi,tsubame,tsunan,uonuma,yahiko,yoita,yuzawa),nikita,nobushi,noor,nyanta,o0o0,oita!(beppu,bungoono,bungotakada,hasama,hiji,himeshima,hita,kamitsue,kokonoe,kuju,kunisaki,kusu,oita,saiki,taketa,tsukumi,usa,usuki,yufu),okayama!(akaiwa,asakuchi,bizen,hayashima,ibara,kagamino,kasaoka,kibichuo,kumenan,kurashiki,maniwa,misaki,nagi,niimi,nishiawakura,okayama,satosho,setouchi,shinjo,shoo,soja,takahashi,tamano,tsuyama,wake,yakage),okinawa!(aguni,ginowan,ginoza,gushikami,haebaru,higashi,hirara,iheya,ishigaki,ishikawa,itoman,izena,kadena,kin,kitadaito,kitanakagusuku,kumejima,kunigami,minamidaito,motobu,nago,naha,nakagusuku,nakijin,nanjo,nishihara,ogimi,okinawa,onna,shimoji,taketomi,tarama,tokashiki,tomigusuku,tonaki,urasoe,uruma,yaese,yomitan,yonabaru,yonaguni,zamami),oops,or,osaka!(abeno,chihayaakasaka,chuo,daito,fujiidera,habikino,hannan,higashiosaka,higashisumiyoshi,higashiyodogawa,hirakata,ibaraki,ikeda,izumi,izumiotsu,izumisano,kadoma,kaizuka,kanan,kashiwara,katano,kawachinagano,kishiwada,kita,kumatori,matsubara,minato,minoh,misaki,moriguchi,neyagawa,nishi,nose,osakasayama,sakai,sayama,sennan,settsu,shijonawate,shimamoto,suita,tadaoka,taishi,tajiri,takaishi,takatsuki,tondabayashi,toyonaka,toyono,yao),parallel,parasite,pecori,peewee,penne,pepper,perma,pgw,pigboat,pinoko,punyu,pupu,pussycat,pya,raindrop,rdy,readymade,rgr,rulez,sadist,saga!(ariake,arita,fukudomi,genkai,hamatama,hizen,imari,kamimine,kanzaki,karatsu,kashima,kitagata,kitahata,kiyama,kouhoku,kyuragi,nishiarita,ogi,omachi,ouchi,saga,shiroishi,taku,tara,tosu,yoshinogari),saitama!(arakawa,asaka,chichibu,fujimi,fujimino,fukaya,hanno,hanyu,hasuda,hatogaya,hatoyama,hidaka,higashichichibu,higashimatsuyama,honjo,ina,iruma,iwatsuki,kamiizumi,kamikawa,kamisato,kasukabe,kawagoe,kawaguchi,kawajima,kazo,kitamoto,koshigaya,kounosu,kuki,kumagaya,matsubushi,minano,misato,miyashiro,miyoshi,moroyama,nagatoro,namegawa,niiza,ogano,ogawa,ogose,okegawa,omiya,otaki,ranzan,ryokami,saitama,sakado,satte,sayama,shiki,shiraoka,soka,sugito,toda,tokigawa,tokorozawa,tsurugashima,urawa,warabi,yashio,yokoze,yono,yorii,yoshida,yoshikawa,yoshimi),sakurastorage(isk01(s3),isk02(s3)),saloon,sapporo(!city,*),sblo,schoolbus,secret,sendai(!city,*),shiga!(aisho,gamo,higashiomi,hikone,koka,konan,kosei,koto,kusatsu,maibara,moriyama,nagahama,nishiazai,notogawa,omihachiman,otsu,ritto,ryuoh,takashima,takatsuki,torahime,toyosato,yasu),shimane!(akagi,ama,gotsu,hamada,higashiizumo,hikawa,hikimi,izumo,kakinoki,masuda,matsue,misato,nishinoshima,ohda,okinoshima,okuizumo,shimane,tamayu,tsuwano,unnan,yakumo,yasugi,yatsuka),shizuoka!(arai,atami,fuji,fujieda,fujikawa,fujinomiya,fukuroi,gotemba,haibara,hamamatsu,higashiizu,ito,iwata,izu,izunokuni,kakegawa,kannami,kawanehon,kawazu,kikugawa,kosai,makinohara,matsuzaki,minamiizu,mishima,morimachi,nishiizu,numazu,omaezaki,shimada,shimizu,shimoda,shizuoka,susono,yaizu,yoshida),skr,staba,stripper,sub,sunnyday,supersale,tank,theshop,thick,tochigi!(ashikaga,bato,haga,ichikai,iwafune,kaminokawa,kanuma,karasuyama,kuroiso,mashiko,mibu,moka,motegi,nasu,nasushiobara,nikko,nishikata,nogi,ohira,ohtawara,oyama,sakura,sano,shimotsuke,shioya,takanezawa,tochigi,tsuga,ujiie,utsunomiya,yaita),tokushima!(aizumi,anan,ichiba,itano,kainan,komatsushima,matsushige,mima,minami,miyoshi,mugi,nakagawa,naruto,sanagochi,shishikui,tokushima,wajiki),tokyo!(adachi,akiruno,akishima,aogashima,arakawa,bunkyo,chiyoda,chofu,chuo,edogawa,fuchu,fussa,hachijo,hachioji,hamura,higashikurume,higashimurayama,higashiyamato,hino,hinode,hinohara,inagi,itabashi,katsushika,kita,kiyose,kodaira,koganei,kokubunji,komae,koto,kouzushima,kunitachi,machida,meguro,minato,mitaka,mizuho,musashimurayama,musashino,nakano,nerima,ogasawara,okutama,ome,oshima,ota,setagaya,shibuya,shinagawa,shinjuku,suginami,sumida,tachikawa,taito,tama,toshima),tonkotsu,tottori!(chizu,hino,kawahara,koge,kotoura,misasa,nanbu,nichinan,sakaiminato,tottori,wakasa,yazu,yonago),toyama!(asahi,fuchu,fukumitsu,funahashi,himi,imizu,inami,johana,kamiichi,kurobe,nakaniikawa,namerikawa,nanto,nyuzen,oyabe,taira,takaoka,tateyama,toga,tonami,toyama,unazuki,uozu,yamada),uh-oh,under,undo,upper,usercontent,velvet,verse,versus,vivian,wakayama!(arida,aridagawa,gobo,hashimoto,hidaka,hirogawa,inami,iwade,kainan,kamitonda,katsuragi,kimino,kinokawa,kitayama,koya,koza,kozagawa,kudoyama,kushimoto,mihama,misato,nachikatsuura,shingu,shirahama,taiji,tanabe,wakayama,yuasa,yura),watson,webaccel(rs,user),weblike,websozai,whitesnow,wjg,xii,yamagata!(asahi,funagata,higashine,iide,kahoku,kaminoyama,kaneyama,kawanishi,mamurogawa,mikawa,murayama,nagai,nakayama,nanyo,nishikawa,obanazawa,oe,oguni,ohkura,oishida,sagae,sakata,sakegawa,shinjo,shirataka,shonai,takahata,tendo,tozawa,tsuruoka,yamagata,yamanobe,yonezawa,yuza),yamaguchi!(abu,hagi,hikari,hofu,iwakuni,kudamatsu,mitou,nagato,oshima,shimonoseki,shunan,tabuse,tokuyama,toyota,ube,yuu),yamanashi!(chuo,doshi,fuefuki,fujikawa,fujikawaguchiko,fujiyoshida,hayakawa,hokuto,ichikawamisato,kai,kofu,koshu,kosuge,minami-alps,minobu,nakamichi,nanbu,narusawa,nirasaki,nishikatsura,oshino,otsuki,showa,tabayama,tsuru,uenohara,yamanakako,yamanashi),yokohama(!city,*),zombie,三重,京都,佐賀,兵庫,北海道,千葉,和歌山,埼玉,大分,大阪,奈良,宮城,宮崎,富山,山口,山形,山梨,岐阜,岡山,岩手,島根,広島,徳島,愛媛,愛知,新潟,東京,栃木,沖縄,滋賀,熊本,石川,神奈川,福井,福岡,福島,秋田,群馬,茨城,長崎,長野,青森,静岡,香川,高知,鳥取,鹿児島),ke(ac,co,go,info,me,mobi,ne,or,sc),kg(ae,com,edu,fj,gov,mil,net,org,us,xx),kh(com,edu,gov,net,org),ki(biz,com,edu,gov,info,net,org),km(ass,asso,com,coop,edu,gouv,gov,medecin,mil,nom,notaires,org,pharmaciens,prd,presse,tm,veterinaire),kn(edu,gov,net,org),kp(com,edu,gov,org,rep,tra),kr(ac,ai,busan,c01,chungbuk,chungnam,co,daegu,daejeon,eliv-api,eliv-cdn,eliv-dns,es,gangwon,go,gwangju,gyeongbuk,gyeonggi,gyeongnam,hs,incheon,io,it,jeju,jeonbuk,jeonnam,kg,me,mil,mmv,ms,ne,or,pe,re,sc,seoul,ulsan,vki),krd(co,edu),kw(com,edu,emb,gov,ind,net,org),ky(com,edu,net,org),kz(com,edu,gov,jcloud,mil,net,org),la(bnr,com,edu,gov,info,int,net,org,per),lb(com,edu,gov,net,org),lc(co,com,edu,gov,net,org,oy),limo(eth(*)),link(canva,cyon,dweb(*),eth(*),inbrowser(*),joinmc,keenetic,myfritz,mypep,nftstorage(ipfs),storacha(ipfs),w3s(ipfs)),live(aem,ewp(*),hlx),lk(ac,assn,com,edu,gov,grp,hotel,int,ltd,net,ngo,org,sch,soc,web),lol(omg),lr(com,edu,gov,net,org),ls(ac,biz,co,edu,gov,info,net,org,sc),lt(gov),lu(123website),lv(asn,com,conf,edu,gov,id,mil,net,org),ly(com,edu,gov,id,med,net,org,plc,sch),ma(ac,co,gov,net,org,press),mc(asso,tm),md(ir),me(ac,barsy,brasilia,c66,co,craft,ddns,diskstation,dnsfor,dscloud,edgestack,edu,filegear,filegear-sg,gov,grok,hooc(seprox),hopto,i234,its,loginto,lohmus,mcdir,mybox,myds,net,nohost,noip,opencloud,org,priv,soundcast,synology,tcp4,transip(site),vp4,webhop,xwx),media(framer),menu(barsy,barsyonline),mg(co,com,edu,gov,mil,nom,org,prd),mk(com,edu,gov,inf,name,net,org),ml(ac,art,asso,com,edu,gouv,gov,info,inst,net,org,pr,presse),mm(*),mn(edu,gov,nyc,org),mo(com,edu,gov,net,org),mobi(barsy,dscloud),mp(ju),mr(gov),ms(com,edu,gov,minisite,net,org),mt(com,edu,net,org),mu(ac,co,com,gov,net,or,org),mv(aero,biz,com,coop,edu,gov,info,int,mil,museum,name,net,org,pro),mw(ac,biz,co,com,coop,edu,gov,int,net,org),mx(com,edu,gob,net,org),my(biz,com,edu,gov,mil,name,net,org),mz(ac,adv,co,edu,gov,mil,net,org),na(alt,co,com,gov,net,org),name(her(forgot),his(forgot),ispmanager,keenetic),navy(dns,v6),nc(asso,nom),net(adobeaemcloud,adobeio-static,adobeioruntime,akadns,akamai,akamai-staging,akamaiedge,akamaiedge-staging,akamaihd,akamaihd-staging,akamaiorigin,akamaiorigin-staging,akamaized,akamaized-staging,alwaysdata,apps-1and1,appudo,at-band-camp,atlassian-dev(prod(cdn)),azure-api,azure-mobile,azureedge,azurefd,azurestaticapps!(1,2,3,4,5,6,7,centralus,eastasia,eastus2,westeurope,westus2),azurewebsites!(australiacentral-01,australiacentral2-01,australiaeast-01,australiasoutheast-01,austriaeast-01,belgiumcentral-01,brazilsouth-01,brazilsoutheast-01,canadacentral-01,canadaeast-01,centralindia-01,centralus-01,centraluseuap-01,chilecentral-01,denmarkeast-01,eastasia-01,eastasiastage-01,eastus-01,eastus2-01,eastus2euap-01,eastus3-01,francecentral-01,francesouth-01,germanynorth-01,germanywestcentral-01,indiasouthcentral-01,indonesiacentral-01,israelcentral-01,israelnorthwest-01,italynorth-01,japaneast-01,japanwest-01,jioindiacentral-01,jioindiawest-01,koreacentral-01,koreasouth-01,malaysiawest-01,mexicocentral-01,newzealandnorth-01,northcentralus-01,northcentralusstage-01,northeastus5-01,northeurope-01,norwayeast-01,norwaywest-01,p(*),polandcentral-01,qatarcentral-01,southafricanorth-01,southafricawest-01,southcentralus-01,southcentralus2-01,southeastasia-01,southeastus5-01,southindia-01,spaincentral-01,swedencentral-01,swedensouth-01,switzerlandnorth-01,switzerlandwest-01,taiwannorth-01,taiwannorthwest-01,uaecentral-01,uaenorth-01,uksouth-01,ukwest-01,westcentralus-01,westeurope-01,westindia-01,westus-01,westus2-01,westus3-01),barsy,blackbaudcdn,blogdns,boomla,botdash,bounceme,bplaced,broke-it,buyshouses,casacam,cdn-edges,cdn77(r),cdn77-ssl,channelsdvr!(u),clickrising,cloudaccess,cloudapp,cloudflare!(cdn),cloudflareanycast(cdn),cloudflarecn(cdn),cloudflareglobal(cdn),cloudfront,cloudfunctions,cloudjiffy!(fra1-de,west1-us),cloudycluster,community-pro,ctfcloud,dattolocal,ddns,ddns-ip,de5,debian,definima,deno!(sandbox),dns-cloud,dns-dynamic,dnsalias,dnsdojo,dnsup,does-it,dontexist,dsmynas,dynalias,dynathome,dynu,dynuddns,dynv6,eating-organic,edgekey,edgekey-staging,edgesuite,edgesuite-staging,elastx(jls-sto1,jls-sto2,jls-sto3),endofinternet,familyds,fastly(freetls,map,prod(a,global),ssl(a,b,global)),fastlylb!(map),feste-ip,firewall-gateway,from-az,from-co,from-la,from-ny,gb,gets-it,ggff,grafana-dev,ham-radio-op,heteml,hicam,homeftp,homeip,homelinux,homeunix,hrsn(vps),hu,icp(*),in,in-dsl,in-the-band,in-vpn,iobb,ipifony,ipv64,is-a-chef,is-a-geek,isa-geek,jp,keyword-on,kicks-ass,kinghost,knx-server,krellian,live-on,localcert,localto(*),luyani,mafelo,massivegrid(paas(fr-1,lon-1,lon-2,ny-1,ny-2,sg-1)),meinforum,memset,moonscale,myamaze,mydatto,mydissent,myeffect,myfritz,mymediapc,mynetname(sn),mypsx,myradweb,mysecuritycamera,myspreadshop,mysynology,nhlfan,no-ip,now-dns,office-on-the,oninferno,opik,ovh(hosting(*),webpaas(*)),ownip,pgafan,podzone,privatizehealthinsurance,rackmaze,redirectme,reserve-online,routingthecloud,ru,saveincloud(jelastic,nordeste-idc),scaleforce(j),schokokeks,scrapper-site,se,seidat,selfip,sells-it,senseering,servebbs,serveblog,serveftp,serveminecraft,server-on,shopselect,siteleaf,spryt,square7,squares,srcf(soc,user),static-access,subsc-pay,supabase,sytes,thruhere,torproject!(pages),trafficmanager,ts!(c(*)),tunnelmole,twmail,uk,uni5,usgovcloudapi(core(blob,file,web),servicebus),usgovcloudapp,usgovtrafficmanager,vpndns,vps-host!(jelastic(atl,njs,ric)),vusercontent,webhop,windows(core(blob,file,web),servicebus),yandexcloud!(storage,website),za,zabc),network(aem,alces(*),appwrite,arvo,azimuth,co,tlon),new(builtwithrocket(*)),news(noticeable),nf(arts,com,firm,info,net,other,per,rec,store,web),ng(biz!(co,dl,go,lg,on),col,com,edu,firm,gen,gov,i,ltd,mil,mobi,name,net,ngo,org,plc,sch),ni(ac,biz,co,com,edu,gob,in,info,int,mil,net,nom,org,web),nl(123website,cistron,co,demon,gov,hosting-cluster!(site),khplay,myspreadshop,transurl(*)),no(123hjemmeside,aa!(gs),aarborte,aejrie,afjord,agdenes,ah!(gs),akershus(nes),aknoluokta,akrehamn,al,alaheadju,alesund,algard,alstahaug,alta,alvdal,amli,amot,andasuolo,andebu,andoy,andøy,ardal,aremark,arendal,arna,aseral,asker,askim,askoy,askvoll,askøy,asnes,audnedal,aukra,aure,aurland,aurskog-holand,aurskog-høland,austevoll,austrheim,averoy,averøy,badaddja,bahcavuotna,bahccavuotna,baidar,bajddar,balat,balestrand,ballangen,balsfjord,bamble,bardu,barum,batsfjord,bearalvahki,bearalváhki,beardu,beiarn,berg,bergen,berlevag,berlevåg,bievat,bievát,bindal,birkenes,bjerkreim,bjugn,bodo,bodø,bokn,bomlo,bremanger,bronnoy,bronnoysund,brumunddal,bryne,brønnøy,brønnøysund,bu!(gs),budejju,buskerud(nes),bygland,bykle,báhcavuotna,báhccavuotna,báidár,bájddar,bálát,bådåddjå,båtsfjord,bærum,bømlo,cahcesuolo,co,davvenjarga,davvenjárga,davvesiida,deatnu,dep,dielddanuorri,divtasvuodna,divttasvuotna,donna,dovre,drammen,drangedal,drobak,drøbak,dyroy,dyrøy,dønna,egersund,eid,eidfjord,eidsberg,eidskog,eidsvoll,eigersund,elverum,enebakk,engerdal,etne,etnedal,evenassi,evenes,evenášši,evje-og-hornnes,farsund,fauske,fedje,fet,fetsund,fhs,finnoy,finnøy,fitjar,fjaler,fjell,fla,flakstad,flatanger,flekkefjord,flesberg,flora,floro,florø,flå,fm!(gs),folkebibl,folldal,forde,forsand,fosnes,frana,fredrikstad,frogn,froland,frosta,froya,fræna,frøya,fuoisku,fuossko,fusa,fylkesbibl,fyresdal,førde,gaivuotna,galsa,gamvik,gangaviika,gaular,gausdal,giehtavuoatna,gielda,gildeskal,gildeskål,giske,gjemnes,gjerdrum,gjerstad,gjesdal,gjovik,gjøvik,gloppen,gol,gran,grane,granvin,gratangen,grimstad,grong,grue,gulen,guovdageaidnu,gáivuotna,gálsá,gáŋgaviika,ha,habmer,hadsel,hagebostad,halden,halsa,hamar,hamaroy,hamarøy,hammarfeasta,hammerfest,hapmir,haram,hareid,harstad,hasvik,hattfjelldal,haugesund,hedmark(os,valer,våler),hemne,hemnes,hemsedal,herad,hitra,hjartdal,hjelmeland,hl!(gs),hm!(gs),hobol,hobøl,hof,hokksund,hol,hole,holmestrand,holtalen,holtålen,honefoss,hordaland(os),hornindal,horten,hoyanger,hoylandet,hurdal,hurum,hvaler,hyllestad,hábmer,hámmárfeasta,hápmir,hå,hægebostad,hønefoss,høyanger,høylandet,ibestad,idrett,inderoy,inderøy,iveland,ivgu,jan-mayen!(gs),jessheim,jevnaker,jolster,jondal,jorpeland,jølster,jørpeland,kafjord,karasjohka,karasjok,karlsoy,karlsøy,karmoy,karmøy,kautokeino,kirkenes,klabu,klepp,klæbu,kommune,kongsberg,kongsvinger,kopervik,kraanghke,kragero,kragerø,kristiansand,kristiansund,krodsherad,krokstadelva,kråanghke,krødsherad,kvafjord,kvalsund,kvam,kvanangen,kvinesdal,kvinnherad,kviteseid,kvitsoy,kvitsøy,kvæfjord,kvænangen,kárášjohka,kåfjord,laakesvuemie,lahppi,langevag,langevåg,lardal,larvik,lavagis,lavangen,leangaviika,leaŋgaviika,lebesby,leikanger,leirfjord,leirvik,leka,leksvik,lenvik,lerdal,lesja,levanger,lier,lierne,lillehammer,lillesand,lindas,lindesnes,lindås,loabat,loabát,lodingen,lom,loppa,lorenskog,loten,lund,lunner,luroy,lurøy,luster,lyngdal,lyngen,láhppi,lærdal,lødingen,lørenskog,løten,malatvuopmi,malselv,malvik,mandal,marker,marnardal,masfjorden,masoy,matta-varjjat,meland,meldal,melhus,meloy,meløy,meraker,meråker,midsund,midtre-gauldal,mil,mjondalen,mjøndalen,mo-i-rana,moareke,modalen,modum,molde,more-og-romsdal(heroy,sande),mosjoen,mosjøen,moskenes,moss,moåreke,mr!(gs),muosat,muosát,museum,myspreadshop,málatvuopmi,mátta-várjjat,målselv,måsøy,møre-og-romsdal(herøy,sande),naamesjevuemie,namdalseid,namsos,namsskogan,nannestad,naroy,narviika,narvik,naustdal,navuotna,nedre-eiker,nesna,nesodden,nesoddtangen,nesseby,nesset,nissedal,nittedal,nl!(gs),nord-aurdal,nord-fron,nord-odal,norddal,nordkapp,nordland(bo,bø,heroy,herøy),nordre-land,nordreisa,nore-og-uvdal,notodden,notteroy,nt!(gs),návuotna,nååmesjevuemie,nærøy,nøtterøy,odda,of!(gs),oksnes,ol!(gs),omasvuotna,oppdal,oppegard,oppegård,orkanger,orkdal,orland,orskog,orsta,osen,oslo!(gs),osoyro,osteroy,osterøy,ostfold(valer),ostre-toten,osøyro,overhalla,ovre-eiker,oyer,oygarden,oystre-slidre,porsanger,porsangu,porsgrunn,porsáŋgu,priv,rade,radoy,radøy,rahkkeravju,raholt,raisa,rakkestad,ralingen,rana,randaberg,rauma,re,rendalen,rennebu,rennesoy,rennesøy,rindal,ringebu,ringerike,ringsaker,risor,rissa,risør,rl!(gs),roan,rodoy,rollag,romsa,romskog,roros,rost,royken,royrvik,ruovat,rygge,ráhkkerávju,ráisa,råde,råholt,rælingen,rødøy,rømskog,røros,røst,røyken,røyrvik,salangen,salat,saltdal,samnanger,sandefjord,sandnes,sandnessjoen,sandnessjøen,sandoy,sandøy,sarpsborg,sauda,sauherad,sel,selbu,selje,seljord,sf!(gs),siellak,sigdal,siljan,sirdal,skanit,skanland,skaun,skedsmo,skedsmokorset,ski,skien,skierva,skiervá,skiptvet,skjak,skjervoy,skjervøy,skjåk,skodje,skánit,skånland,slattum,smola,smøla,snaase,snasa,snillfjord,snoasa,snåase,snåsa,sogndal,sogne,sokndal,sola,solund,somna,sondre-land,songdalen,sor-aurdal,sor-fron,sor-odal,sor-varanger,sorfold,sorreisa,sortland,sorum,spjelkavik,spydeberg,st!(gs),stange,stat,stathelle,stavanger,stavern,steigen,steinkjer,stjordal,stjordalshalsen,stjørdal,stjørdalshalsen,stokke,stor-elvdal,stord,stordal,storfjord,strand,stranda,stryn,sula,suldal,sund,sunndal,suohkan,surnadal,svalbard!(gs),sveio,svelvik,sykkylven,sálat,sálát,søgne,sømna,søndre-land,sør-aurdal,sør-fron,sør-odal,sør-varanger,sørfold,sørreisa,sørum,tana,tananger,telemark(bo,bø),time,tingvoll,tinn,tjeldsund,tjielte,tjome,tjøme,tm!(gs),tokke,tolga,tonsberg,torsken,tr!(gs),trana,tranby,tranoy,tranøy,troandin,trogstad,tromsa,tromso,tromsø,trondheim,trysil,træna,trøgstad,tvedestrand,tydal,tynset,tysfjord,tysnes,tysvar,tysvær,tønsberg,uenorge,ullensaker,ullensvang,ulstein,ulvik,unjarga,unjárga,utsira,va!(gs),vaapste,vadso,vadsø,vaga,vagan,vagsoy,vaksdal,valle,vang,vanylven,vardo,vardø,varggat,varoy,vefsn,vega,vegarshei,vegårshei,vennesla,verdal,verran,vestby,vestfold(sande),vestnes,vestre-slidre,vestre-toten,vestvagoy,vestvågøy,vevelstad,vf!(gs),vgs,vik,vikna,vindafjord,voagat,volda,voss,vossevangen,várggát,vågan,vågsøy,vågå,værøy,ákŋoluokta,álaheadju,áltá,åfjord,åkrehamn,ål,ålesund,ålgård,åmli,åmot,årdal,ås,åseral,åsnes,øksnes,ørland,ørskog,ørsta,østfold(våler),østre-toten,øvre-eiker,øyer,øygarden,øystre-slidre,čáhcesuolo),now(dyn,here,tmp),np(*),nr(biz,com,edu,gov,info,net,org),nu(enterprisecloud,merseine,mine,shacknet),nz(ac,cloudns,co,cri,geek,gen,govt,health,iwi,kiwi,maori,mil,māori,net,org,parliament,school),om(co,com,edu,gov,med,museum,net,org,pro),one(kin(*),service,website),online(barsy,book,eero,eero-stage,heimdns,leapcell,websitebuilder),orange(tech),org(accesscam,ae,altervista,barsy,blogdns,blogsite,bmoattachments,boldlygoingnowhere,cable-modem,camdvr,cdn77(c,rsc),cdn77-secure(origin(ssl)),cloudns,collegefan,couchpotatofries,ddnss,dnsalias,dnsdojo,doesntexist,dontexist,doomdns,dpdns,dsmynas,duckdns,dvrdns,dynalias,dyndns!(go,home),dynserv,endofinternet,endoftheinternet,eu!(al,asso,at,au,be,bg,ca,cd,ch,cn,cy,cz,de,dk,edu,ee,es,fi,fr,gr,hr,hu,ie,il,in,int,is,it,jp,kr,lt,lu,lv,me,mk,mt,my,net,ng,nl,no,nz,pl,pt,ro,ru,se,si,sk,tr,uk,us),familyds,fedorainfracloud,fedorapeople,fedoraproject(cloud,os(app),stg(os(app))),freeddns,freedesktop,from-me,fspages,game-host,gotdns,hatenadiary,hepforge,hk,hobby-site,homedns,homeftp,homelinux,homeunix,hopto,httpbin,in-dsl,in-vpn,ip-dynamic,is-a-bruinsfan,is-a-candidate,is-a-celticsfan,is-a-chef,is-a-geek,is-a-knight,is-a-linux-user,is-a-patsfan,is-a-soxfan,is-found,is-local,is-lost,is-saved,is-very-bad,is-very-evil,is-very-good,is-very-nice,is-very-sweet,isa-geek,jpn,js,kicks-ass,misconfused,mlbfan,my-firewall,myfirewall,myftp,mysecuritycamera,mywire,nflfan,no-ip,now-dns,pimienta,podzone,poivron,potager,pubtls,read-books,readmyblog,routingthecloud,roxa,selfip,sellsyourhome,servebbs,serveftp,servegame,small-web,spdns,stuff-4-sale,sweetpepper,teckids(s3),toolforge,tunk,tuxfamily,twmail,ufcfan,us,webhop,webredirect,wmcloud!(beta),wmflabs,wz,za,zapto),ovh(nerdpol),pa(abo,ac,com,edu,gob,ing,med,net,nom,org,sld),page(aem,codeberg,deuxfleurs,ginta,heyflow,hlx,linkyhost,mybox,mymagic,omgs,pdns,plesk,prod,prvcy,rocky,solidres,statichost,vibekit),pe(com,edu,gob,mil,net,nom,org),pf(com,edu,org),pg(*),ph(cloudns,com,edu,gov,i,mil,net,ngo,org),photos(framer),pictures(1337),pizza(ngrok),pk(ac,biz,com,edu,fam,gkp,gob,gog,gok,gop,gos,gov,net,org,web),pl(agro,aid,art,atm,augustow,auto,babia-gora,bedzin,beep,beskidy,bialowieza,bialystok,bielawa,bielsko,bieszczady,biz,boleslawiec,bydgoszcz,bytom,cfolks,cieszyn,co,com,czeladz,czest,dfirma,dkonto,dlugoleka,ecommerce-shop,edu,elblag,elk,gda,gdansk,gdynia,gliwice,glogow,gmina,gniezno,gorlice,gov!(ap,griw,ic,is,kmpsp,konsulat,kppsp,kwp,kwpsp,mup,mw,oia,oirm,oke,oow,oschr,oum,pa,pinb,piw,po,pr,psp,psse,pup,rzgw,sa,sdn,sko,so,sr,starostwo,ug,ugim,um,umig,upow,uppo,us,uw,uzs,wif,wiih,winb,wios,witd,wiw,wkz,wsa,wskr,wsse,wuoz,wzmiuw,zp,zpisdn),grajewo,gsm,homesklep,ilawa,info,iqhs,jaworzno,jelenia-gora,jgora,kalisz,karpacz,kartuzy,kaszuby,katowice,kazimierz-dolny,kepno,ketrzyn,klodzko,kobierzyce,kolobrzeg,konin,konskowola,krakow,krasnik,kutno,lapy,lebork,leczna,legnica,lezajsk,limanowa,lodz,lomza,lowicz,lubartow,lubin,lublin,lukow,mail,malbork,malopolska,mazowsze,mazury,med,media,miasta,mielec,mielno,mil,mragowo,myspreadshop,naklo,net,nieruchomosci,nom,nowaruda,nysa,olawa,olecko,olkusz,olsztyn,opoczno,opole,org,ostroda,ostroleka,ostrowiec,ostrowwlkp,pabianice,pc,pila,pisz,plock,podhale,podlasie,polkowice,pomorskie,pomorze,poniatowa,powiat,poznan,priv,prochowice,pruszkow,przeworsk,pulawy,radom,rawa-maz,realestate,rel,rybnik,rzeszow,sanok,sdscloud,sejny,sex,shop,shoparena,sieradz,simplesite,skierniewice,sklep,skoczow,slask,slupsk,sopot,sos,sosnowiec,stalowa-wola,starachowice,stargard,suwalki,swidnica,swidnik,swiebodzin,swinoujscie,szczecin,szczytno,szkola,targi,tarnobrzeg,tgory,tm,torun,tourism,travel,turek,turystyka,tychy,unicloud,ustka,walbrzych,warmia,warszawa,waw,wegrow,wielun,wlocl,wloclawek,wodzislaw,wolomin,wroc,wroclaw,you2,zachpomor,zagan,zakopane,zarow,zgierz,zgora,zgorzelec),place(co,ship),plus(playit!(at(*),with)),pm(name,own),pn(co,edu,gov,net,org),pr(ac,biz,com,edu,est,gov,info,isla,name,net,org,pro,prof),pro(aaa,aca,acct,avocat,bar,barsy,cloudns,cpa,eng,enter(prod),jur,keenetic,law,med,ngrok,recht),ps(com,edu,gov,net,org,plo,sec),pt(123paginaweb,com,edu,gov,int,net,nome,org,publ),pub(barsy,id(*),kin(*)),pw(cloudns,gov,x443),py(com,coop,edu,gov,mil,net,org),qa(com,edu,gov,mil,name,net,org,sch),re(asso,can,com,netlib),reviews(aem),rip(clan),ro(arts,barsy,co,com,firm,info,nom,nt,org,rec,shop,store,tm,www),rocks(lima-city,myddns,stackit,v6,webspace),rs(ac,barsy,brendly(shop),co,edu,gov,in,org,ox),ru(ac,adygeya,bashkiria,bir,cbg,cldmail(hb),com,dagestan,edu,eurodir,gov,grozny,int,kalmykia,kustanai,marine,mcdir!(vps),mcpre,mil,mircloud,mordovia,msk,myjino!(hosting(*),landing(*),spectrum(*),vps(*)),mytis,na4u,nalchik,net,nov,org,pp,pyatigorsk,ras,spb,vladikavkaz,vladimir),run(appwrite(*),build(*),canva,cloud,code(*),database(*),development,liara!(iran),lovable,migration(*),needle,onporter,ravendb,repl,rwx,sanity,sm,stackit,val!(web),vercel,wix),rw(ac,co,coop,gov,mil,net,org),sa(com,edu,gov,med,net,org,pub,sch),sb(com,edu,gov,net,org),sc(com,edu,gov,net,org),scot(co,gov!(service),me,mygov,org),sd(com,edu,gov,info,med,net,org,tv),se(123minsida,a,ac,b,bd,brand,c,com,d,e,f,fh,fhsk,fhv,g,h,i,iopsys,itcouldbewor,k,komforb,kommunalforbund,komvux,l,lanbib,m,myspreadshop,n,naturbruksgymn,o,org,p,parti,pp,press,r,s,t,tm,u,w,x,y,z),services(loginline),sg(com,edu,enscaled,gov,net,org),sh(bearly,botda,com,gov,hashbang,lovable,mil,net,now,org,platform(ent,eu,us),surge,teleport),shop(barsy,barsyonline,base,hoplix,shopware),show(ms),si(f5,gitpage),site(barsy,byen,caffeine,canva(my),ceero,chatgpt,cloudera(*),co,convex!(eu-west-1,us-east-1),cpanel,cyon,docsflowy,fastvps,figma,figma-gov,heyflow,jele,jouwweb,kliv,loginline,madethis,medusajs,nippy,notion,novecore,omniwe,opensocial,piebox,platformsh(*),playcode,preview,puter,scw!(ams,waw),sol,sourcecraft,square,srht,support,tst(*),wpsquared),sk(org),sl(com,edu,gov,net,org),sn(art,com,edu,gouv,org,univ),so(com,edu,gov,me,net,org,surveys),space(app-ionos,deployagent,heiyu,hf!(static),manus,myfast,project,uber,vibehost,xs4all),ss(biz,co,com,edu,gov,me,net,org,sch),st(cn(*),co,com,consulado,edu,embaixada,helioho,kirara,mil,net,noho,org,principe,saotome,store),store(barsy,sellfy,shopware,storebase),studio(ai,sanity),su(abkhazia,adygeya,aktyubinsk,arkhangelsk,armenia,ashgabad,azerbaijan,balashov,bashkiria,bryansk,bukhara,chimkent,dagestan,east-kazakhstan,exnet,georgia,grozny,ivanovo,jambyl,kalmykia,kaluga,karacol,karaganda,karelia,khakassia,krasnodar,kurgan,kustanai,lenug,mangyshlak,mordovia,msk,murmansk,nalchik,navoi,north-kazakhstan,nov,obninsk,penza,pokrovsk,sochi,spb,tashkent,termez,togliatti,troitsk,tselinograd,tula,tuva,vladikavkaz,vladimir,vologda),support(barsy),sv(com,edu,gob,org,red),sx(gov),sy(com,edu,gov,mil,net,org),systems(miren),sz(ac,co,org),team(discourse,jelastic),tech(cleverapps),technology(co),tf(sch),th(ac,co,go,in,mi,net,online,or,shop),tj(biz,co,com,edu,go,gov,int,mil,name,net,nic,org,test,web),tl(gov),tm(co,com,edu,gov,mil,net,nom,org),tn(com,ens,fin,gov,ind,info,intl,mincom,nat,net,orangecloud,org,perso,tourism),to(611,com,edu,gov,mil,net,nett,org,quickconnect(direct),vpnplus,x0),today(prequalifyme),tools(addr(dyn),myaddr),top(ntdll,wadl(*)),tr(av,bbs,bel,biz,com,dr,edu,gen,gov,info,k12,kep,mil,name,nc!(gov),net,org,pol,tel,tsk,tv,web),tt(biz,co,com,edu,gov,info,mil,name,net,org,pro),tv(better-than,dyndns,from,on-the-web,sakura,worse-than),tw(club,com!(mymailer),ebiz,edu,game,gov,idv,mil,mydns,net,org,url),tz(ac,co,go,hotel,info,me,mil,mobi,ne,or,sc,tv),ua(biz,cc,cherkassy,cherkasy,chernigov,chernihiv,chernivtsi,chernovtsy,ck,cn,co,com,cr,crimea,cv,cx,dn,dnepropetrovsk,dnipropetrovsk,donetsk,dp,edu,gov,if,in,inf,ivano-frankivsk,kh,kharkiv,kharkov,kherson,khmelnitskiy,khmelnytskyi,kiev,kirovograd,km,kr,kropyvnytskyi,krym,ks,kv,kyiv,lg,lt,ltd,lugansk,luhansk,lutsk,lv,lviv,mk,mykolaiv,net,nikolaev,od,odesa,odessa,org,pl,poltava,pp,rivne,rovno,rv,sb,sebastopol,sevastopol,sm,sumy,te,ternopil,uz,uzhgorod,uzhhorod,v,vinnica,vinnytsia,vn,volyn,yalta,zakarpattia,zaporizhzhe,zaporizhzhia,zhitomir,zhytomyr,zp,zt),ug(ac,co,com,edu,go,gov,mil,ne,or,org,sc,us),uk(ac,barsy,co!(adimo,barsy,barsyonline,layershift(j),myspreadshop,nh-serv,no-ip,retrosnub(cust)),conn,copro,gov!(api,campaign,service),hosp,independent-commission,independent-inquest,independent-inquiry,independent-panel,independent-review,ltd,me,net,nhs,nimsite,oraclegovcloudapps(*),org!(affinitylottery,glug,lug,lugs,raffleentry,weeklylottery),plc,police,public-inquiry,pymnt,royal-commission,sch(*)),us(ak!(cc,k12,lib),al!(cc,k12,lib),ar!(cc,k12,lib),as!(cc,k12,lib),az!(cc,k12,lib),azure-api,azurewebsites,ca!(cc,k12,lib),cloudns,co!(cc,k12,lib),ct!(cc,k12,lib),databricksapps(aws-gov),dc!(cc,k12,lib),de!(cc),dni,enscaled(phx),fl!(cc,k12,lib),freeddns,ga!(cc,k12,lib),golffan,gu!(cc,k12,lib),heliohost,hi!(cc,lib),ia!(cc,k12,lib),id!(cc,k12,lib),il!(cc,k12,lib),in!(cc,k12,lib),is-by,isa,ks!(cc,k12,lib),ky!(cc,k12,lib),la!(cc,k12,lib),land-4-sale,ma!(cc,k12!(chtr,paroch,pvt),lib),md!(cc,k12,lib),me!(cc,k12,lib),mi!(ann-arbor,cc,cog,dst,eaton,gen,k12,lib,mus,tec,washtenaw),mircloud,mn!(cc,k12,lib),mo!(cc,k12,lib),ms!(cc,k12),mt!(cc,k12,lib),nc!(cc,k12,lib),nd,ne!(cc,k12,lib),ngo,nh!(cc,k12,lib),nj!(cc,k12,lib),nm!(cc,k12,lib),noip,nsn,nv!(cc,k12,lib),ny!(cc,k12,lib),oh!(cc,k12,lib),ok!(cc,k12,lib),or!(cc,k12,lib),pa!(cc,k12,lib),pointto,pr!(cc,k12,lib),ri!(cc,lib),sc!(cc,k12,lib),sd!(cc,lib),servername,srv!(gh,gl),stuff-4-sale,tn!(cc,k12,lib),tx!(cc,k12,lib),ut!(cc,k12,lib),va!(cc,k12,lib),vi!(cc,k12,lib),vt!(cc,k12,lib),wa!(aberdeen,bainbridge-isl,bellevue,bremerton,cc,centralia,chehalis,forks,gig-harbor,hoquiam,k12,keyport,kingston,lib,olympia,port-angeles,port-ludlow,port-orchard,port-townsend,poulsbo,redmond,renton,sea,seattle,sequim,shelton,silverdale,yarrow-point),wi!(cc,k12,lib),wv!(cc),wy!(cc,k12,lib)),uy(com,edu,gub,gv,mil,net,org),uz(co,com,net,org),vc(0e(*),com,edu,gov,gv!(d),mil,mydns,net,org),ve(arts,bib,co,com,e12,edu,emprende,firm,gob,gov,ia,info,int,mil,net,nom,org,rar,rec,store,tec,web),vg(edu),vi(co,com,k12,net,org),vip(hidns),vn(ac,ad,ai,angiang,ap,bacgiang,backan,baclieu,bacninh,baria-vungtau,bentre,binhdinh,binhduong,binhphuoc,binhthuan,biz,camau,cantho,caobang,com,daklak,daknong,danang,dienbien,dongnai,dongthap,edu,gialai,gov,hagiang,haiduong,haiphong,hanam,hanoi,hatinh,haugiang,health,hoabinh,hue,hungyen,id,info,int,io,khanhhoa,kiengiang,kontum,laichau,lamdong,langson,laocai,longan,namdinh,name,net,nghean,ninhbinh,ninhthuan,on,org,phutho,phuyen,pro,quangbinh,quangnam,quangngai,quangninh,quangtri,soctrang,sonla,tayninh,thaibinh,thainguyen,thanhhoa,thanhphohochiminh,thuathienhue,tiengiang,travinh,tuyenquang,vinhlong,vinhphuc,yenbai),vu(com,edu,net,org),website(framer),wf(biz,sch),wiki(framer),work(puter),ws(advisor(*),cloud66,com,dyndns,edu,gov,mypets,net,org),wtf(ddns),xyz(botdash,caffeine,exe,opentunnel,telebit(*)),ye(com,edu,gov,mil,net,org),yt(org),za(ac,agric,alt,co,edu,gov,grondar,law,mil,net,ngo,nic,nis,nom,org,school,tm,web),zm(ac,biz,co,com,edu,gov,info,mil,net,org,sch),zone(lima,prg1-zerops,stackit,triton(*),zerops(*)),zw(ac,co,gov,mil,org),рус(биз,ком,крым,мир,мск,орг,самара,сочи,спб,я),срб(ак,обр,од,орг,пр,упр),ישראל(אקדמיה,ישוב,ממשל,צהל),ไทย(ทหาร,ธุรกิจ,รัฐบาล,ศึกษา,องค์กร,เน็ต),香港(個人,公司,政府,教育,組織,網絡)
'@)
docker cp "$t\script.js" "${c}:/tmp/ct.js"; docker cp "$t\inline.js" "${c}:/tmp/inline.js"; docker cp "$t\psl.enc" "${c}:/tmp/psl.enc"
docker exec -u 0 $c bun /tmp/inline.js; docker exec -u 0 $c rm -f /tmp/ct.js /tmp/inline.js /tmp/psl.enc

# Your custom CSS, saved into degoog's settings
[IO.File]::WriteAllText("$t\custom.css", @'
/* Catppuccin Mocha colors */
html:root {
  --bg: #1e1e2e !important;
  --bg-light: #313244 !important;
  --bg-hover: #45475a !important;
  --border: #585b70 !important;
  --border-light: #313244 !important;
  --text-primary: #cdd6f4 !important;
  --text-secondary: #a6adc8 !important;
  --text-snippet: #bac2de !important;
  --text-cite: #9399b2 !important;
  --text-link: #89b4fa !important;
  --text-link-visited: #cba6f7 !important;
  --primary: #89b4fa !important;
  --primary-hover: #74c7ec !important;
  --search-bar-bg: #313244 !important;
  --search-bar-bg-hover: #45475a !important;
  --btn-bg: #313244 !important;
  --modal-footer: #181825 !important;
}

/* DESCRIPTION SIZE: change these two numbers to resize the descriptions on every tab (PC, then iPhone) */
html:root { --ct-desc-pc: 15px; --ct-desc-phone: 13.5px; }
/* v50: dates moved out of the description onto the source line, after the site name ("site · yesterday"):
   one line, never wrapped, same 13px/18px as the site name so the line height never changes */
.result-url-row .ct-date { flex: none; margin-left: -4px; font-size: 13px; line-height: 18px; white-space: nowrap; color: var(--text-cite); font-variant-numeric: tabular-nums; }
.result-url-row .ct-date::before { content: "·"; margin-right: 4px; }
@media (max-width: 767px) { .result-url-row .ct-date { color: var(--text-secondary); } }
.result-url-row .ct-paywall { flex: none; margin-left: -4px; font-size: 13px; line-height: 18px; white-space: nowrap; color: var(--text-secondary); }
.result-url-row .ct-paywall::before { content: "·"; margin-right: 4px; }
/* "N more from site.com ⌄": blue = tappable, underline on hover only; tucked under the site's 2nd result
   (results carry 12px top/bottom padding, so -8px leaves 4px between) */
.ct-fold { margin: -8px 0 4px; }
.ct-fold-b { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0; border: 0; background: none; font: inherit; font-size: 14px; line-height: 20px; color: var(--text-link); cursor: pointer; }
.ct-fold-b:hover { text-decoration: underline; }
.ct-fold-b:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 4px; }
.ct-chev { color: var(--text-secondary); }
@media (max-width: 767px) { .ct-fold-b { min-height: 44px; } }
/* Other versions of one paper ("PDF · HTML · v7 latest"): small gray line, the links blue */
.ct-alts { margin-top: 4px; font-size: 13px; line-height: 18px; color: var(--text-cite); white-space: nowrap; overflow: hidden; }
.ct-alts a { color: var(--text-link); text-decoration: none; }
.ct-alts a:visited { color: var(--text-link-visited); }
.ct-alts a:hover { text-decoration: underline; }
/* Typo fix line above results (Google's "Showing results for") */
#ct-fix { margin: 0 0 16px; padding-left: var(--ct-x, 0px); font-size: 14px; line-height: 21px; color: var(--text-secondary); }
/* Everything the plugin adds enters with degoog's own result fade-in */
.ct-in { animation: resultFadeIn .3s ease-out both; }
/* Sharp thumbnail laid over the small one: same box, opacity only (resultFadeIn also slides, which a picture
   swap must not do), same .3s as the result fade */
.result-thumbnail-wrap img.ct-hd { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; animation: ctXfade .3s ease-out both; }
@keyframes ctXfade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .ct-in, .result-thumbnail-wrap img.ct-hd { animation: none; } }
#ct-fix a, #ct-fix a :is(b, i) { color: var(--text-link) !important; font-weight: 400; }
#ct-fix a b { font-weight: 600; }
#ct-fix .ct-fix-alt { font-size: 13px; color: var(--text-cite); }
#ct-fix .ct-fix-alt a { font-weight: 400; }
/* Related searches under the results: compact pills, 2 per row on PC, 1 per row on phones */
#ct-related { margin: 16px 0 8px; }
#ct-related h3 { font-size: 17px; line-height: 22px; font-weight: 500; color: var(--text-primary); margin: 0 0 10px; }
#ct-related .ct-rel-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
#ct-related a { display: block; padding: 11px 16px; border-radius: 999px; background: var(--bg-light); color: var(--text-primary) !important; font-size: 14px; line-height: 18px; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (hover: hover) { #ct-related a:hover { background: var(--bg-hover); } }
@media (max-width: 767px) { #ct-related .ct-rel-grid { grid-template-columns: minmax(0, 1fr); } }

/* Google-style images */
.image-grid { gap: 12px !important; }
.image-column { gap: 16px !important; }
.image-card { overflow: visible !important; border-radius: 0 !important; }
.image-card:hover { opacity: 1 !important; }
.image-thumb-wrap { border-radius: 14px; background: var(--bg-light); }
/* Broken or still-loading pictures: plain tile, no alt text spilling over it */
.image-thumb { color: transparent !important; font-size: 0 !important; }
@media (hover: hover) {
  .image-card:hover .image-thumb { filter: brightness(0.85); }
}
.image-info {
  position: static !important; opacity: 1 !important; background: none !important;
  padding: 6px 2px 2px !important; gap: 2px !important;
}
.image-title { color: var(--text-primary) !important; font-size: 13.5px !important; font-weight: 500; }
.image-source { color: var(--text-secondary) !important; font-size: 12.5px !important; }

/* Images: title on one line, then the site name in grey, like Google Images */
.image-title, .image-source { display: block !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
.image-source { color: var(--text-cite) !important; }

/* Images tab: no side panel, full width */
#results-layout.media-mode #sidebar-col,
#results-layout.media-mode #image-filters-bar { display: none !important; }
#results-layout.media-mode #results-main { max-width: none !important; }

/* Cleaner web results */
.result-engines { display: none !important; }
#results-meta { display: none !important; }
#tools-bar { display: none !important; }
.engine-performance-panel { display: none !important; }
.result-snippet {
  display: -webkit-box !important;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.result-snippet:empty { display: none !important; }
/* Titles: one even weight (Google only highlights matches in the description) */
.result-title :is(b, strong, em, mark) { font-weight: inherit !important; font-style: inherit !important; background: none !important; color: var(--text-link) !important; }
/* Visited titles: highlighted words turn purple with the rest (plain "inherit" skips the visited colour in Safari) */
:is(a:visited, .result-title:visited) :is(b, strong, em, mark) { color: var(--text-link-visited) !important; }
/* Descriptions: matches brighter, not just heavier */
.result-snippet :is(b, strong, em, mark) { color: inherit !important; font-weight: inherit !important; font-style: inherit !important; background: none !important; }

/* Tabs: edge-to-edge divider, first label lines up with the logo */
#results-tabs {
  border-bottom: 1px solid transparent !important;
  border-image: linear-gradient(var(--border-light), var(--border-light)) 0 0 1 0 / 0 0 1px 0 / 0 100vw !important;
}
#results-tabs { scrollbar-width: none; }
@media (min-width: 768px) {
  #results-tabs .results-tab:first-child { margin-left: -1rem !important; }
}

/* Summary box */
#at-a-glance > :not(.ct-ans, .ct-ai, .ct-ai-panel) {
  margin: 16px 0 0 -16px !important;
  background: rgba(49, 50, 68, 0.85) !important;
  border: none !important; border-radius: 12px !important;
}

/* Wikipedia card: Google-size picture (tall photos like a phone no longer stretch the
   card into a big empty box) and plain body text instead of link blue */
.wiki-card .wiki-thumb { max-width: 36% !important; max-height: 180px !important; width: auto !important; height: auto !important; object-fit: contain !important; background: none !important; border-radius: 10px !important; margin: 0 0 8px 16px !important; }
.wiki-card .wiki-extract { color: var(--text-primary) !important; }
/* Never too long: every part has a ceiling. Description 5 lines (4 on phones), subtitle
   2 lines, title 2 lines, picture 180px (120px on phones), logo 60px; the full article
   is one tap away via the Wikipedia link. So the card tops out around 260px on PC */
.wiki-card .wiki-extract { display: -webkit-box !important; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden !important; margin: 0 !important; }
.wiki-card .wiki-desc { display: -webkit-box !important; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden !important; }
.wiki-card .wiki-title { display: -webkit-box !important; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden !important; }
.wiki-card .wiki-thumb--logo { max-height: 60px !important; }
@media (max-width: 767px) {
  .wiki-card .wiki-thumb { max-height: 120px !important; max-width: 34% !important; }
  .wiki-card .wiki-extract { -webkit-line-clamp: 4; }
}

/* Info panel: always open, no dropdown or duplicate title */
.degoog-accordion-toggle--sidebar { display: none !important; }
.sidebar-accordion .degoog-accordion-body { display: block !important; }

/* Phones: panel on top (degoog default), proper spacing, summary card below it */
@media (max-width: 767px) {
  .sidebar-accordion .degoog-accordion-body { padding-top: 16px !important; }
  #at-a-glance > :not(.ct-ans, .ct-ai, .ct-ai-panel) { margin: 12px 0 12px 0 !important; }
}

@media (min-width: 768px) {
  /* Image preview floats over the grid */
  #media-preview-panel {
    position: fixed !important; top: 0 !important; right: 0 !important;
    height: 100vh !important; z-index: 300 !important;
  }
  #media-preview-panel.open {
    width: 34vw !important; min-width: 360px !important;
    margin-inline-start: 0 !important;
    box-shadow: -8px 0 24px rgba(0,0,0,.5) !important;
  }

  /* Header: search bar ends at the 44rem content edge, gear in the corner */
  #results-header .results-logo { flex: none !important; width: 6.5rem !important; }
  #results-header #results-search-bar { flex: none !important; width: 36.75rem !important; max-width: none !important; }
  #nav-settings-results {
    position: absolute !important;
    top: 1rem !important; right: 1.25rem !important;
    height: 2.75rem !important; margin: 0 !important;
    display: flex !important; align-items: center !important;
  }

  /* One column like the phone: info panel, then AI summary, then results */
  #results-layout:not(.media-mode) {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr);
    row-gap: 0;
    align-items: start;
    max-width: 76rem;
  }
  #results-layout:not(.media-mode) #results-main { display: contents; }
  #results-layout:not(.media-mode) #results-main > * { grid-column: 1; order: 2; max-width: 44rem !important; }
  #results-layout:not(.media-mode) #at-a-glance { order: 1; }
  #results-layout:not(.media-mode) #sidebar-col {
    grid-column: 1; order: 0; width: auto !important;
    margin: 16px 0 0 -16px !important; max-width: calc(44rem + 16px) !important;
  }
  #results-layout:not(.media-mode) .skeleton-card,
  #results-layout:not(.media-mode) .command-result { max-width: none !important; }
  #results-page.centered-mode #results-header,
  #results-page.centered-mode #results-tabs,
  #results-page.centered-mode #results-layout:not(.media-mode) { max-width: 76rem !important; }
}

/* Hide the empty info-panel placeholders (results and AI summary still show loading) */
#results-layout:not(.media-mode) :is(.skeleton-sidebar, .skeleton-sidebar-panel) { display: none !important; }

/* Phones: degoog's own 3-column masonry (every picture keeps its real shape, no square
   cropping, no gaps), tight 4px gutters, rounded corners, and just the site name in
   small grey text under each picture. Titles stay on PC, where there is room */
@media (max-width: 767px) {
  /* Same 8px margin on both sides of the screen (the right column ran into the edge) */
  #results-layout.media-mode, #results-layout.media-mode #results-main { padding-inline: 0 !important; margin-inline: 0 !important; max-width: none !important; width: 100% !important; box-sizing: border-box !important; }
  .image-grid { gap: 4px !important; padding: 8px 8px 24px !important; margin: 0 !important; width: 100% !important; box-sizing: border-box !important; }
  .image-column { gap: 10px !important; }
  .image-thumb-wrap { background: var(--bg-light) !important; }
  .image-card { border-radius: 0 !important; overflow: visible !important; }
  .image-thumb-wrap { border-radius: 8px !important; overflow: hidden !important; }
  .image-thumb { height: auto !important; object-fit: contain !important; }
  .image-info { padding: 4px 2px 0 !important; gap: 2px !important; }
  .image-title { display: block !important; font-size: 12px !important; line-height: 15px !important; font-weight: 400 !important; color: var(--text-primary) !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
  .image-source { font-size: 11px !important; line-height: 14px !important; }
}

/* ===== Tabs ======================================================
   Sizes measured from Google's own pages (Nov 2026), in your Catppuccin theme.
   degoog bug: when the window regains focus it redraws the tab bar and forgets
   the active tab, so each tab's look also applies when the results on the page
   show which tab it is, and the tab underline is put back. */

/* Images: underline after the reset */
#results-page:not(:has(.results-tab.active)):has(#results-layout.media-mode) .results-tab[data-type="tab:engine:images"] { color: var(--text-primary) !important; border-bottom-color: var(--text-primary) !important; }

/* Every tab shares Google's web-result look (slim source line with a 16px favicon on top, flush with the title, 21px one-line title,
   15px snippet, 28px between results). Inside a result the lines sit tight so they read as one
   block; the bigger gap between results does the separating. Tab sections below only add differences */
.result-item { margin: 0 !important; padding: 12px 0 !important; border: 0 !important; }
/* First result sits a bit closer to the tabs */
.result-item:nth-child(1 of .result-item) { padding-top: 6px !important; }
.result-item .result-body { display: flex !important; flex-direction: column !important; }
.result-item .result-body > * { order: 4; }
.result-url-row { order: 0 !important; gap: 8px !important; margin-top: 0 !important; height: 18px !important; align-items: center !important; overflow: visible !important; min-width: 0 !important; }
.result-item :is(.result-favicon, .result-favicon-missing) { box-sizing: border-box !important; display: block !important; align-self: center !important; position: relative !important; top: 1.5px !important; margin: 0 0 0 1px !important; width: 16px !important; height: 16px !important; padding: 0 !important; border-radius: 4px !important; background: none !important; object-fit: contain; font-size: 9px !important; flex: none !important; }
.result-item .result-favicon-missing { border-radius: 4px !important; background: var(--bg-hover) !important; color: var(--text-primary) !important; font-size: 10px !important; font-weight: 600 !important; line-height: 1 !important; padding: 0 !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; }
/* Site icon that failed to load (degoog swaps in a letter): same grey 16px square as a missing icon, not a bare floating letter */
.result-item .result-favicon.result-favicon-fallback { border-radius: 4px !important; background: var(--bg-hover) !important; color: var(--text-primary) !important; font-size: 10px !important; font-weight: 600 !important; line-height: 1 !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; }
/* Link line stays calm: long URLs stop at ~Google's breadcrumb width instead of running the full column */
.result-item .result-cite { max-width: 440px !important; }
.result-item .result-cite { font-size: 13px !important; line-height: 18px !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; min-width: 0 !important; }
.result-item .result-title { order: 1 !important; margin-top: 4px !important; font-size: 21px !important; line-height: 26px !important; font-weight: 400 !important; display: block !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
@media (max-width: 767px) { .result-item .result-title { white-space: normal !important; display: -webkit-box !important; -webkit-line-clamp: 2 !important; -webkit-box-orient: vertical; } }
/* Phones: title leads; summary and link line step back (smaller and greyer) so only the title asks for attention */
@media (max-width: 767px) {
  .result-item .result-title { font-size: 18px !important; line-height: 23px !important; margin-top: 5px !important; letter-spacing: -0.1px; }
  /* .result-body raises priority: the shared rule further down would otherwise win on phones too */
  .result-item .result-body .result-snippet { font-size: var(--ct-desc-phone) !important; line-height: 19px !important; margin-top: 4px !important; color: var(--text-secondary) !important; }
  /* Web pictures: smaller, top lined up with the title (not the link line), so results stop looking like product ads */
  .result-item .result-item-inner .result-thumbnail-wrap { width: 76px !important; height: 76px !important; margin-top: 22px !important; border-radius: 8px !important; }
  .result-item .result-cite { font-size: 13px !important; color: var(--text-secondary) !important; }
  /* Results 24px apart, no lines (lines made them look like ad units) */
  .result-item { padding-block: 12px !important; }
}
.result-item .result-snippet { order: 3 !important; -webkit-line-clamp: 2 !important; margin-top: 3px !important; font-size: var(--ct-desc-pc) !important; line-height: calc(var(--ct-desc-pc) * 1.47) !important; color: var(--text-snippet) !important; }
.result-insecure-badge { border: 0 !important; background: none !important; padding: 0 !important; color: var(--text-cite) !important; font-size: 12px !important; font-weight: 400 !important; }
.result-date { color: var(--text-cite) !important; }
/* Thumbnails: Google's 92px rounded squares (Videos and News set their own) */
.result-item .result-thumbnail-wrap { width: 92px !important; height: 92px !important; border-radius: 8px !important; overflow: hidden !important; }
.result-item .result-thumbnail-wrap img { width: 100% !important; height: 100% !important; object-fit: cover !important; }
/* AI summary "Read more": filled grey pill, centred, no blue outline */
#at-a-glance :is(button, a):is([class*="more" i], [class*="expand" i]):not([hidden], .ct-ai-more) { border: 0 !important; outline: 0 !important; background: var(--bg-light) !important; color: var(--text-primary) !important; border-radius: 999px !important; width: auto !important; margin-inline: auto !important; padding: 8px 20px !important; display: flex !important; }

/* Science: shared look, plus Scholar's green source line */
#results-page:is(:has(.results-tab.active[data-type="tab:engine:science"]), :not(:has(.results-tab.active)):has(.result-item:is([data-result-url*="doi.org/"], [data-result-url*="openalex.org/"], [data-result-url*="semanticscholar.org/"], [data-result-url*="ncbi.nlm.nih.gov/"], [data-result-url*="arxiv.org/"], [data-result-url*="researchhub.com/"]))) {
  & .results-tab[data-type="tab:engine:science"] { color: var(--text-primary) !important; border-bottom-color: var(--text-primary) !important; }
  & .result-thumbnail-wrap { display: none !important; }
  & .result-cite { color: #9fc5a8 !important; }
  & .result-snippet { -webkit-line-clamp: 2 !important; }
  & .result-insecure-badge { display: none !important; }
}

/* Forums: shared look, no thumbnails, 2-line titles and snippets */
#results-page:is(:has(.results-tab.active[data-type="tab:engine:forums"]), :not(:has(.results-tab.active)):not(:has(.result-item:is([data-result-url*="doi.org/"], [data-result-url*="openalex.org/"], [data-result-url*="semanticscholar.org/"], [data-result-url*="ncbi.nlm.nih.gov/"], [data-result-url*="arxiv.org/"], [data-result-url*="researchhub.com/"]))):has(.result-item:is([data-result-url*="reddit.com/r/"], [data-result-url*="stackoverflow.com/"], [data-result-url*="stackexchange.com/"], [data-result-url*="superuser.com/"], [data-result-url*="serverfault.com/"], [data-result-url*="askubuntu.com/"], [data-result-url*="news.ycombinator.com/"]))) {
  & .results-tab[data-type="tab:engine:forums"] { color: var(--text-primary) !important; border-bottom-color: var(--text-primary) !important; }
  & .result-thumbnail-wrap { display: none !important; }
  & .result-snippet { -webkit-line-clamp: 2 !important; }
  /* Phones: forums keep the tighter 24px gaps (short results read better close together) */
  @media (max-width: 767px) {
    & .result-item { padding-block: 12px !important; }
    & .result-item:nth-child(1 of .result-item) { padding-top: 6px !important; }
  }
}

/* News = Google/Apple News cards: 2-column grid, image on top, bold headline; lead story full width */
#results-page:is(:has(.results-tab.active[data-type="tab:engine:news"]), :not(:has(.results-tab.active, #results-layout.media-mode, .degoog-result--thumb--video, .result-item:is([data-result-url*="doi.org/"], [data-result-url*="openalex.org/"], [data-result-url*="semanticscholar.org/"], [data-result-url*="ncbi.nlm.nih.gov/"], [data-result-url*="arxiv.org/"], [data-result-url*="researchhub.com/"]), .result-item:is([data-result-url*="reddit.com/r/"], [data-result-url*="stackoverflow.com/"], [data-result-url*="stackexchange.com/"], [data-result-url*="superuser.com/"], [data-result-url*="serverfault.com/"], [data-result-url*="askubuntu.com/"], [data-result-url*="news.ycombinator.com/"])))) {
  & .results-tab[data-type="tab:engine:news"] { color: var(--text-primary) !important; border-bottom-color: var(--text-primary) !important; }
  /* Cards: every picture is the same 16:9 frame; stories without a picture become full-width
     text cards, and pictured cards pack in pairs (dense), so no half-empty rows */
  & :has(> .result-item) { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; grid-auto-flow: row dense !important; gap: 0 16px !important; margin: 0 0 0 -16px !important; max-width: calc(44rem + 16px) !important; padding-top: 0 !important; }
  & :has(> .result-item) > :not(.result-item) { grid-column: 1 / -1 !important; }
  & .result-item { padding: 0 !important; border: 0 !important; border-radius: 12px !important; background: rgba(49, 50, 68, .45) !important; overflow: hidden !important; }
  & .result-item::before { inset: 0; border-radius: 12px; }
  & .result-item:hover::before { background-color: rgba(69, 71, 90, .35); }
  & .result-item-inner { display: flex !important; flex-direction: column !important; align-items: stretch !important; gap: 0 !important; height: 100% !important; }
  & .result-body { flex: 1 !important; min-width: 0 !important; width: auto !important; max-width: none !important; box-sizing: border-box !important; padding: 14px 16px 16px !important; }
  & .result-thumbnail-wrap {
    order: -1 !important; flex: none !important; float: none !important; margin: 0 !important; background: var(--bg-light) !important;
    width: 100% !important; height: auto !important; aspect-ratio: 16 / 9 !important; border-radius: 0 !important; align-self: stretch !important;
  }
  & .result-thumbnail-wrap img { width: 100% !important; height: 100% !important; object-fit: cover !important; }
  & .result-url-row { order: 0 !important; margin: 0 !important; height: 18px !important; }
  & .result-cite { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  & .result-title { margin-top: 8px !important; font-size: 18px !important; line-height: 24px !important; font-weight: 500 !important; white-space: normal !important; display: -webkit-box !important; -webkit-line-clamp: 3 !important; -webkit-box-orient: vertical; overflow: hidden; }
  & .result-snippet { margin-top: 6px !important; font-size: calc(var(--ct-desc-pc) - 1.5px) !important; line-height: calc((var(--ct-desc-pc) - 1.5px) * 1.48) !important; -webkit-line-clamp: 2 !important; }
  /* No picture (or one that failed to load: degoog then hides its frame with an inline
     display:none but leaves the img inside): full-width text card */
  & .result-item:not(:has(.result-thumbnail-wrap:not([style*="none"]) img)) { grid-column: 1 / -1 !important; }
  /* Stories with a picture are tiles; stories without one are a compact list split by thin lines (same as
     Discussions and People also ask), not a stack of mostly-empty tiles */
  & .result-item:has(.result-thumbnail-wrap:not([style*="none"]) img) { margin: 8px 0 !important; }
  & .result-item:not(:has(.result-thumbnail-wrap:not([style*="none"]) img)) { background: transparent !important; border-radius: 0 !important; border-bottom: 1px solid rgba(88, 91, 112, .45) !important; }
  & .result-item:not(:has(.result-thumbnail-wrap:not([style*="none"]) img)) .result-body { padding: 12px 16px !important; }
  & .result-item:not(:has(.result-thumbnail-wrap:not([style*="none"]) img)) .result-thumbnail-wrap { display: none !important; }
  & .result-item:not(:has(.result-thumbnail-wrap:not([style*="none"]) img)) .result-title { -webkit-line-clamp: 2 !important; }
  /* Pictures too small for a banner (the plugin marks them ct-lowres before paint, from the address):
     Google News style, a small sharp thumbnail beside the text instead of a blurry full-width banner */
  & .result-item.ct-lowres { grid-column: 1 / -1 !important; }
  & .result-item.ct-lowres .result-item-inner { flex-direction: row-reverse !important; align-items: flex-start !important; }
  & .result-item.ct-lowres .result-thumbnail-wrap { order: 0 !important; flex: none !important; width: 92px !important; height: 92px !important; aspect-ratio: auto !important; border-radius: 8px !important; margin: 14px 14px 14px 0 !important; align-self: flex-start !important; }
  /* Lead story (if it has a picture): full width, picture on the right */
  @media (min-width: 768px) {
    & .result-item:not(.ct-lowres):nth-child(1 of .result-item):has(.result-thumbnail-wrap:not([style*="none"]) img) { grid-column: 1 / -1 !important; }
    & .result-item:not(.ct-lowres):nth-child(1 of .result-item):has(.result-thumbnail-wrap:not([style*="none"]) img) .result-item-inner { flex-direction: row !important; }
    & .result-item:not(.ct-lowres):nth-child(1 of .result-item):has(.result-thumbnail-wrap:not([style*="none"]) img) .result-thumbnail-wrap { order: 2 !important; flex: 0 0 50% !important; width: 50% !important; aspect-ratio: 16 / 9 !important; align-self: center !important; }
    & .result-item:not(.ct-lowres):nth-child(1 of .result-item):has(.result-thumbnail-wrap:not([style*="none"]) img) .result-body { padding: 20px 20px 20px 16px !important; }
    & .result-item:not(.ct-lowres):nth-child(1 of .result-item):has(.result-thumbnail-wrap:not([style*="none"]) img) .result-title { font-size: 22px !important; line-height: 28px !important; -webkit-line-clamp: 2 !important; }
  }
  /* Phones: one card per row, Google News mobile style: every picture is a sharp 92px thumbnail beside
     the headline (news sources rarely have a sharp full-width copy, so big banners came out blurry) */
  @media (max-width: 767px) {
    & :has(> .result-item) { grid-template-columns: minmax(0, 1fr) !important; gap: 0 !important; margin: 0 !important; max-width: none !important; }
    & .result-item:has(.result-thumbnail-wrap:not([style*="none"]) img) { margin: 6px 0 !important; }
    & .result-title { font-size: 18px !important; line-height: 24px !important; }
    & .result-snippet { font-size: var(--ct-desc-phone) !important; line-height: calc(var(--ct-desc-phone) * 1.44) !important; }
    & .result-item-inner { flex-direction: row-reverse !important; align-items: flex-start !important; }
    & .result-thumbnail-wrap { order: 0 !important; flex: none !important; width: 92px !important; height: 92px !important; aspect-ratio: auto !important; border-radius: 8px !important; margin: 16px 16px 16px 0 !important; align-self: flex-start !important; }
    /* Like Google News on phones: source, headline beside the picture, date; no description, so every
       card is the same height, text never wraps into the empty space under the picture, and 16px padding all round */
    & .result-body { padding: 16px !important; }
    & .result-item:not(:has(.result-thumbnail-wrap:not([style*="none"]) img)) .result-body { padding: 12px 16px !important; }
    & .result-snippet { font-size: 0 !important; line-height: 0 !important; margin-top: 6px !important; }
    & .result-snippet:not(:has(.result-date)) { display: none !important; }
    & .result-snippet .result-date { display: inline-block !important; font-size: 12.5px !important; line-height: 18px !important; }
  }
}

/* Videos: Google's sizes, but the thumbnail sits beside the title so rows stay even
   when a video has no description (common in your results; Google always has one) */
#results-page:is(:has(.results-tab.active[data-type="tab:engine:videos"]), :not(:has(.results-tab.active)):has(.degoog-result--thumb--video)) {
  & .results-tab[data-type="tab:engine:videos"] { color: var(--text-primary) !important; border-bottom-color: var(--text-primary) !important; }
  /* Same link line, sizes and gaps as every other tab; the text block (18 + 4 + 26 + 3 + 44 = 95px)
     sits beside the 94px thumbnail, tops lined up */
  /* Non-video results: no empty thumbnail gap, text starts at the left edge */
  & .result-item:not(:has(.degoog-result--thumb--video)) .result-thumbnail-wrap { display: none !important; }
  /* Videos: thumbnail pinned left, text beside it; each row is as tall as the thumbnail
     (or the text, if longer), whatever else degoog puts inside the result */
  & .result-item:has(.degoog-result--thumb--video) {
    box-sizing: content-box !important; min-height: 94px !important; padding-left: 184px !important; padding-top: 12px !important;
    & .result-item-inner { display: block !important; }
    & .result-body { min-width: 0 !important; }
    & .result-body > :empty { display: none !important; }
    & .result-thumbnail-wrap {
      position: absolute !important; left: 0 !important; top: 12px !important; float: none !important;
      width: 168px !important; height: 94px !important; border-radius: 8px !important; margin: 0 !important;
    }
    & .result-snippet { -webkit-line-clamp: 2 !important; }
  }
  @media (max-width: 767px) {
    & .result-item:has(.degoog-result--thumb--video) { min-height: 72px !important; padding-left: 140px !important; padding-block: 12px !important; }
    & .result-item:has(.degoog-result--thumb--video) .result-thumbnail-wrap { width: 128px !important; height: 72px !important; top: 12px !important; }
    & .result-item .result-title { font-size: 16px !important; line-height: 21px !important; }
    & .result-item:has(.degoog-result--thumb--video) .result-snippet { display: none !important; }
  }
}

/* ===== Interaction (beyond Google) ================================
   The whole result is one big click/tap target with a soft highlight on hover,
   so you don't have to aim for the title. Thumbnails, the menu and links in
   the AI summary stay separately clickable. Keyboard focus is clearly visible. */
.result-item { position: relative !important; isolation: isolate; }
.result-item::before { content: ""; position: absolute; inset: 0 -16px; z-index: -1; border-radius: 12px; pointer-events: none; transition: background-color .15s; }
.result-item .result-title::after { content: ""; position: absolute; inset: 0; z-index: 1; }
.result-item :is(.result-thumbnail-wrap, .result-actions) { position: relative; z-index: 2; }
@media (hover: hover) {
  .result-item:hover { background-color: transparent !important; box-shadow: none !important; }
  .result-item:hover::before { background-color: rgba(49, 50, 68, .45); }
  .result-item:hover .result-title { text-decoration: underline; text-underline-offset: 3px; }
}
.result-title:focus-visible { outline: none; }
.result-item:has(.result-title:focus-visible)::before { background-color: rgba(49, 50, 68, .45); outline: 2px solid var(--primary); }
::selection { background: rgba(137, 180, 250, .3); }

/* ===== Platform polish ============================================ */

/* Mac: crisper light-on-dark text. iPhone: no font inflation in landscape,
   no grey flash when tapping, and the page colour shows when you over-scroll */
html { background: var(--bg) !important; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
:is(.results-tab, .result-item a, .result-thumbnail-wrap, .image-card) { -webkit-tap-highlight-color: transparent; }

/* iPhone: text boxes at 16px so Safari doesn't zoom in when you tap the search bar */
@media (max-width: 767px) {
  :is(input[type="text"], input[type="search"], input:not([type]), textarea) { font-size: 16px !important; }
  .results-tab { padding-block: 12px !important; }
}

/* AI summary: normal text colour and size, slim follow-up box */
.glance-ai :is(p, li, span:not(.glance-ai-sources-label)) { color: var(--text-primary) !important; }
.glance-ai :is(p, li) { font-size: 15px !important; line-height: 1.6 !important; }
/* AI summary sources, Google AI Overview style: a small link icon right after the sentence
   it supports (site name and details pop up on hover / tap), so the text reads cleanly and
   icons never wrap onto a line of their own. "+1" stays when a sentence has more sources */
.glance-ai .glance-ai-cite { background: rgba(69, 71, 90, .55) !important; border-radius: 999px !important; padding: 0 5px !important; margin: 0 0 0 3px !important; gap: 3px !important; height: 20px !important; min-width: 20px !important; max-width: none !important; justify-content: center !important; vertical-align: -3px !important; color: var(--text-secondary) !important; transition: background-color .15s; }
.glance-ai .glance-ai-cite .glance-ai-cite-host { display: none !important; }
.glance-ai .glance-ai-cite .glance-ai-cite-more { font-size: 11.5px !important; line-height: 18px !important; color: var(--text-secondary) !important; opacity: 1 !important; padding-right: 1px; }
.glance-ai .glance-ai-cite-favicon { width: 13px !important; height: 13px !important; border-radius: 3px !important; }
/* Show less: the plugin parks it half off the bottom edge of the card in the page colour,
   where it is nearly invisible; put it under the text as the same pill as Read more */
.glance-ai .glance-ai-collapse:not([hidden]) { position: static !important; transform: none !important; align-self: center !important; display: flex !important; margin: 12px auto 0 !important; padding: 8px 20px !important; border: 0 !important; border-radius: 999px !important; background: var(--bg-light) !important; color: var(--text-primary) !important; font-size: 13px !important; }
.glance-ai:has(.glance-ai-collapse:not([hidden])) { padding-bottom: 16px !important; margin-bottom: 0 !important; }
@media (hover: hover) { #at-a-glance :is(.glance-ai-expand, .glance-ai-collapse):hover { background: var(--bg-hover) !important; } }
@media (hover: hover) { .glance-ai .glance-ai-cite:hover { background: var(--bg-hover) !important; } }
.glance-ai .glance-ai-cite--open { background: var(--bg-hover) !important; }
/* Key phrases: bold like Google, no tinted box behind them */
.glance-ai .glance-ai-key { background: none !important; padding: 0 !important; color: var(--text-primary) !important; font-weight: 600 !important; }
.glance-ai textarea {
  min-height: 0 !important; height: 40px !important; resize: none !important;
  padding: 9px 14px !important; border-radius: 20px !important;
}

/* ===== Instant answers (define, time, weather, math, every ! command) ======
   Same card as the AI summary. degoog wraps each plugin's card in a second
   .command-result and both add 24px above and below with no side padding, so the
   outer one becomes one evenly padded, full-width card and the inner one goes flat.
   Boxes inside a card (buttons, tables, icon tiles) sit one shade darker so they
   don't vanish into the card, and lines use a visible grey. */
#at-a-glance > .command-result { width: auto !important; max-width: none !important; padding: 20px 24px 16px !important; }
#at-a-glance .command-result .command-result { padding: 0 !important; margin: 0 !important; max-width: none !important; width: auto !important; background: none !important; }
#at-a-glance .command-result :is(h3, h4):first-child { margin-top: 0 !important; }
#at-a-glance .command-result > :last-child, #at-a-glance .command-result .command-result > :last-child { margin-bottom: 0 !important; }
#at-a-glance :is(.weather-hero-icon, .weather-week-wrap, .math-calc-key, .math-calc-expr) { background: rgba(17, 17, 27, .45) !important; border: 0 !important; }
#at-a-glance :is(.weather-hero, .weather-week th, .weather-week td, .command-help-table th, .command-help-table td) { border-color: rgba(88, 91, 112, .45) !important; }
#at-a-glance .math-widget { background: none !important; }
@media (max-width: 767px) {
  #at-a-glance > .command-result { padding: 16px 18px 12px !important; }
}

/* Time: Google's clock card (big light time, date under it, place and zone in grey) */
#at-a-glance .time-place { font-size: 14px !important; line-height: 20px !important; font-weight: 400 !important; color: var(--text-secondary) !important; margin: 0 !important; }
#at-a-glance .time-time { font-size: 44px !important; line-height: 52px !important; font-weight: 400 !important; margin: 4px 0 2px !important; color: var(--text-primary) !important; font-variant-numeric: tabular-nums; }
#at-a-glance .time-date { font-size: 15px !important; line-height: 22px !important; color: var(--text-primary) !important; margin: 0 !important; }
#at-a-glance .time-zone { font-size: 13px !important; line-height: 18px !important; color: var(--text-cite) !important; margin: 4px 0 0 !important; }

/* Weather: Google's big light temperature; details 2 per row on phones */
#at-a-glance .weather-result { max-width: none !important; }
#at-a-glance .weather-location { font-size: 15px !important; font-weight: 500 !important; color: var(--text-secondary) !important; margin: 0 0 12px !important; }
#at-a-glance .weather-hero { margin-bottom: 16px !important; padding-bottom: 16px !important; }
#at-a-glance .weather-hero-icon { border-radius: 14px !important; }
#at-a-glance .weather-temp { font-size: 44px !important; line-height: 52px !important; font-weight: 400 !important; }
#at-a-glance .weather-desc { font-size: 15px !important; opacity: 1 !important; }
#at-a-glance .weather-now-grid { gap: 10px 16px !important; margin-bottom: 16px !important; }
#at-a-glance .weather-now-item { font-size: 13.5px !important; }
#at-a-glance .weather-week-wrap { border-radius: 12px !important; }
@media (max-width: 767px) {
  #at-a-glance .weather-now-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  #at-a-glance .weather-temp { font-size: 38px !important; line-height: 44px !important; }
  #at-a-glance .weather-hero-icon { width: 56px !important; height: 56px !important; }
}

/* Math: Google's calculator (light result, darker keys, blue equals) */
#at-a-glance .math-query { font-size: 15px !important; font-weight: 400 !important; letter-spacing: 0 !important; }
#at-a-glance .math-equals { display: none !important; }
#at-a-glance .math-result { font-size: 36px !important; line-height: 44px !important; font-weight: 400 !important; font-variant-numeric: tabular-nums; }
#at-a-glance .math-calc { max-width: none !important; }
#at-a-glance .math-calc-expr { font-weight: 400 !important; border-radius: 10px !important; }
#at-a-glance .math-calc-key { border-radius: 10px !important; }
@media (hover: hover) { #at-a-glance .math-calc-key:hover { background: var(--bg-hover) !important; } }
#at-a-glance .math-calc-eq { background: var(--primary) !important; color: #11111b !important; font-weight: 600 !important; }

/* Define (def / define word): Google's dictionary box */
#at-a-glance .define-result { padding: 0 !important; margin: 0 !important; max-width: none !important; width: auto !important; background: none !important; }
#at-a-glance .define-result .define-word { font-size: 28px !important; line-height: 36px !important; font-weight: 400 !important; margin: 0 !important; color: var(--text-primary) !important; }
#at-a-glance .define-phonetic { font-size: 14px !important; line-height: 20px !important; margin: 2px 0 14px !important; color: var(--text-secondary) !important; }
#at-a-glance .define-meaning { margin: 0 0 10px !important; }
#at-a-glance .define-pos { display: block !important; font-style: italic !important; font-size: 14px !important; line-height: 20px !important; color: var(--text-secondary) !important; margin-bottom: 6px !important; }
#at-a-glance .define-list { list-style: decimal !important; margin: 0 !important; padding-left: 22px !important; }
#at-a-glance .define-list li { font-size: 15px !important; line-height: 22px !important; margin: 0 0 8px !important; padding-left: 4px !important; color: var(--text-primary) !important; }
#at-a-glance .define-list li::marker { color: var(--text-secondary); }
#at-a-glance .define-example { display: block !important; font-size: 14px !important; line-height: 20px !important; margin-top: 2px !important; color: var(--text-secondary) !important; }
@media (max-width: 767px) {
  #at-a-glance > .command-result:has(.define-result) { padding: 16px 18px 8px !important; }
  #at-a-glance .define-result .define-word { font-size: 24px !important; line-height: 32px !important; }
}

/* PC: the hover box around a result ends where the AI summary box ends (it ran 16px past it) */
@media (min-width: 768px) { .result-item::before { right: 0 !important; } }

/* Result menu: a tiny faint dot button that brightens when used; inside, one rounded group of four evenly spaced
   choices for the site (Prefer / Normal / Lower / Hide); degoog's own items are hidden (the group replaces them) */
.result-actions-toggle { width: 16px !important; height: 16px !important; min-width: 0 !important; padding: 0 !important; margin: 0 0 0 4px !important; border: 0 !important; background: none !important; font-size: 12px !important; line-height: 16px !important; color: var(--text-cite) !important; opacity: .5; }
.result-actions-toggle:hover, .result-actions-toggle[aria-expanded="true"] { opacity: 1; }
.result-actions-menu:has(.ct-seg) > .result-actions-item { display: none !important; }
.ct-seg { display: grid; grid-template-columns: repeat(4, 1fr); margin: 6px; border: 1px solid rgba(88, 91, 112, .7); border-radius: 999px; overflow: hidden; min-width: 280px; }
.ct-seg-b { font: inherit; font-size: 13px; line-height: 18px; padding: 7px 10px; min-height: 32px; border: 0; background: none; color: var(--text-secondary); cursor: pointer; white-space: nowrap; }
.ct-seg-b + .ct-seg-b { border-left: 1px solid rgba(88, 91, 112, .7); }
.ct-seg-b:hover { color: var(--text-primary); }
.ct-seg-b[aria-pressed="true"] { background: rgba(205, 214, 244, .14); color: var(--text-primary); font-weight: 600; }
.ct-seg-b:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.ct-seg-note { font-size: 12.5px; line-height: 18px; padding: 0 14px 8px; color: var(--text-secondary); }
@media (max-width: 767px) { .ct-seg { min-width: 300px; } .ct-seg-b { min-height: 44px; } }

/* People also ask: Google's layout, sized like your results (heading = title size, answer = description, source = link line + title) */
#ct-qa { margin: 12px 0 12px; }
#ct-qa h3 { font-size: 20px; line-height: 26px; font-weight: 400; margin: 0 0 10px; color: var(--text-primary); }
#ct-qa details { border-top: 1px solid rgba(88, 91, 112, .45); }
#ct-qa details:last-child { border-bottom: 1px solid rgba(88, 91, 112, .45); }
#ct-qa summary { list-style: none; cursor: pointer; min-height: 48px; box-sizing: border-box; display: flex; align-items: center; padding: 12px 36px 12px 0; position: relative; font-size: 16px; line-height: 22px; color: var(--text-primary); }
#ct-qa summary::-webkit-details-marker { display: none; }
#ct-qa summary::after { content: ""; position: absolute; right: 8px; top: 50%; width: 8px; height: 8px; margin-top: -6px; border-right: 2px solid var(--text-secondary); border-bottom: 2px solid var(--text-secondary); transform: rotate(45deg); transition: transform .2s, margin-top .2s; }
#ct-qa details[open] summary::after { transform: rotate(-135deg); margin-top: -1px; }
.ct-qa-a { padding: 0 0 16px; }
.ct-qa-text { margin: 0 0 12px; font-size: var(--ct-desc-pc); line-height: calc(var(--ct-desc-pc) * 1.47); color: var(--text-snippet); }
.ct-qa-site { display: flex; align-items: center; gap: 8px; height: 18px; }
.ct-qa-site img { width: 16px; height: 16px; border-radius: 4px; object-fit: contain; }
.ct-qa-site cite { font-style: normal; font-size: 13px; line-height: 18px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ct-qa-src { display: block; margin: 4px 0 12px; font-size: 21px; line-height: 26px; color: var(--text-link); text-decoration: none; }
.ct-qa-more { font-size: 14px; color: var(--text-link); text-decoration: none; }
@media (max-width: 767px) {
  #ct-qa h3 { font-size: 18px; line-height: 23px; }
  .ct-qa-text { font-size: var(--ct-desc-phone); line-height: 19px; color: var(--text-secondary); }
  .ct-qa-src { font-size: 18px; line-height: 23px; margin-top: 5px; }
}

/* Sitelinks, Discussions and forums, Videos, Top stories: same family as People also ask (heading, dividers)
   and your News cards (12px rounded tiles); every row is one big tap target */
.result-item.ct-grouped { display: none !important; }
.ct-grp { margin: 4px 0 24px; }
.ct-gh { font-size: 20px; line-height: 26px; font-weight: 400; margin: 0 0 12px; color: var(--text-primary); }
.ct-meta { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; line-height: 18px; color: var(--text-secondary); }
.ct-fav { width: 16px; height: 16px; flex: none; border-radius: 4px; object-fit: contain; }
.ct-fav-x { background: var(--bg-light); }
.ct-src { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ct-when { flex: none; white-space: nowrap; color: var(--text-cite); }
.ct-src + .ct-when::before { content: "·"; margin-right: 6px; }
.ct-more { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; height: 40px; margin-top: 12px; border: 1px solid rgba(88, 91, 112, .45); border-radius: 20px; background: transparent; color: var(--text-primary); font: inherit; font-size: 14px; cursor: pointer; }
.ct-more::after { content: ""; width: 6px; height: 6px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(-45deg); }
.ct-more:hover { background: rgba(69, 71, 90, .35); }
/* Discussions: rows split by the same thin lines as People also ask */
.ct-list { border-top: 1px solid rgba(88, 91, 112, .45); }
.ct-fi { display: flex; flex-direction: column; gap: 4px; padding: 12px 0; border-bottom: 1px solid rgba(88, 91, 112, .45); text-decoration: none; }
.ct-ft { font-size: 18px; line-height: 24px; color: var(--text-link); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.ct-fi:visited .ct-ft { color: var(--text-link-visited); }
.ct-fi:hover .ct-ft { text-decoration: underline; }
.ct-fs { font-size: var(--ct-desc-pc); line-height: calc(var(--ct-desc-pc) * 1.47); color: var(--text-snippet); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
/* Videos and Top stories: a sideways row of News-style tiles, 3 across on PC, swipeable with a peek on phones */
.ct-rowwrap { position: relative; }
.ct-row { display: grid; grid-auto-flow: column; grid-auto-columns: calc((100% - 24px) / 3); gap: 12px; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none; overscroll-behavior-x: contain; }
.ct-row::-webkit-scrollbar { display: none; }
.ct-card { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding-bottom: 12px; border-radius: 12px; background: rgba(49, 50, 68, .45); overflow: hidden; text-decoration: none; scroll-snap-align: start; }
.ct-card:hover { background: rgba(69, 71, 90, .45); }
.ct-card > :not(.ct-pic) { margin: 0 12px; }
.ct-pic { position: relative; display: block; aspect-ratio: 16 / 9; background: var(--bg-light); overflow: hidden; }
.ct-pic img { display: block; width: 100%; height: 100%; object-fit: cover; }
.ct-play { position: absolute; left: 50%; top: 50%; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%; background: rgba(17, 17, 27, .6); }
.ct-play::after { content: ""; position: absolute; left: 16px; top: 12px; border-style: solid; border-width: 8px 0 8px 12px; border-color: transparent transparent transparent #fff; }
.ct-dur { position: absolute; right: 6px; bottom: 6px; padding: 1px 5px; border-radius: 4px; background: rgba(17, 17, 27, .8); color: #fff; font-size: 12px; line-height: 16px; font-variant-numeric: tabular-nums; }
.ct-ct { font-size: 15px; line-height: 20px; font-weight: 500; color: var(--text-primary); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.ct-vc .ct-ct { margin-top: 6px !important; }
.ct-sc .ct-meta { margin-top: 10px !important; }
.ct-sc .ct-ct { -webkit-line-clamp: 3; }
.ct-sc.ct-nopic .ct-ct { -webkit-line-clamp: 5; }
.ct-sc > .ct-when { margin-top: auto !important; font-size: 13px; }
.ct-arr { position: absolute; top: calc(50% - 18px); z-index: 2; width: 36px; height: 36px; padding: 0; border: 1px solid rgba(88, 91, 112, .45); border-radius: 50%; background: var(--bg-light); color: var(--text-primary); cursor: pointer; opacity: 0; pointer-events: none; transition: opacity .15s; }
.ct-arr::after { content: ""; position: absolute; left: 50%; top: 50%; width: 7px; height: 7px; margin: -4px 0 0 -5px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(-45deg); }
.ct-prev::after { margin-left: -2px; transform: rotate(135deg); }
.ct-prev { left: -18px; }
.ct-next { right: -18px; }
.ct-can-prev .ct-prev, .ct-can-next .ct-next { opacity: 1; pointer-events: auto; }
/* Sitelinks: 2 columns of page + one-line summary under the top result */
.ct-sl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 32px; margin-top: 14px; }
.ct-sl-i { display: flex; flex-direction: column; gap: 2px; min-width: 0; text-decoration: none; }
.ct-sl-t { font-size: 16px; line-height: 22px; color: var(--text-link); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ct-sl-i:visited .ct-sl-t { color: var(--text-link-visited); }
.ct-sl-i:hover .ct-sl-t { text-decoration: underline; }
.ct-sl-d { font-size: 13px; line-height: 18px; color: var(--text-snippet); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
@media (hover: none) { .ct-arr { display: none; } }
@media (max-width: 767px) {
  .ct-gh { font-size: 18px; line-height: 23px; }
  .ct-ft { font-size: 16px; line-height: 22px; }
  .ct-fs { font-size: var(--ct-desc-phone); line-height: 19px; color: var(--text-secondary); }
  .ct-row { grid-auto-columns: 72%; }
  .ct-news .ct-row { grid-auto-columns: 80%; }
  /* Phones: a tappable list with a chevron, like Google mobile */
  .ct-sl { grid-template-columns: 1fr; gap: 0; margin-top: 10px; border-top: 1px solid rgba(88, 91, 112, .45); }
  .ct-sl-i { position: relative; justify-content: center; min-height: 44px; padding-right: 28px; border-bottom: 1px solid rgba(88, 91, 112, .45); }
  .ct-sl-i::after { content: ""; position: absolute; right: 8px; top: 50%; width: 7px; height: 7px; margin-top: -4px; border-right: 2px solid var(--text-secondary); border-bottom: 2px solid var(--text-secondary); transform: rotate(-45deg); }
  .ct-sl-d { display: none; }
}

/* Tools: a small link beside the tabs, opening Google-style advanced search fields */
#ct-tools { background: none; border: 0; padding: 0 12px; font: inherit; font-size: 13.5px; color: var(--text-secondary); cursor: pointer; margin-left: auto; }
#ct-tools[aria-expanded="true"] { color: var(--text-primary); }
#ct-adv { display: grid; grid-template-columns: max-content minmax(0, 360px); gap: 8px 16px; align-items: center; padding: 14px 0 16px; max-width: 600px; font-size: 13.5px; color: var(--text-secondary); }
#ct-adv label { display: contents; }
#ct-adv input { font: inherit; color: var(--text-primary); background: var(--bg-light); border: 1px solid var(--border-light); border-radius: 8px; padding: 7px 10px; outline: none; }
#ct-adv input:focus { border-color: var(--primary); }
#ct-adv button { grid-column: 2; justify-self: start; font: 600 13.5px system-ui, sans-serif; padding: 8px 18px; border: 0; border-radius: 999px; background: var(--primary); color: #11111b; cursor: pointer; }
@media (max-width: 767px) { #ct-adv { grid-template-columns: 1fr; gap: 4px; padding: 12px 16px; } #ct-adv input { margin-bottom: 6px; font-size: 16px; } #ct-adv button { grid-column: 1; } }
/* ===== Answer card (local answers): a rich result, not a box. Gray label line -> 24px answer (or 18px blue title)
   -> one gray detail line. Same layout on PC and phone. ===== */
#at-a-glance:has(> .ct-ans) > :not(.ct-ans) { display: none !important; }
.ct-ans { position: relative; margin: 16px 0 8px; padding: 2px 0; cursor: default; border-radius: 8px; }
.ct-ans[data-copy] { cursor: copy; }
.ct-ans:focus-visible { outline: 2px solid var(--text-link); outline-offset: 4px; }
.ct-ans-label { position: relative; font-size: 13px; line-height: 18px; color: var(--text-secondary); white-space: nowrap; }
.ct-ans-copied { position: absolute; left: 0; top: 0; opacity: 0; color: var(--text-secondary); }
.ct-ans.ct-copied .ct-ans-l { opacity: 0; }
.ct-ans.ct-copied .ct-ans-copied { opacity: 1; }
.ct-ans-value { margin-top: 2px; font-size: 24px; line-height: 32px; color: var(--text-primary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.ct-ans-sw { display: inline-block; width: 22px; height: 22px; margin-right: 10px; vertical-align: -3px; border-radius: 6px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .25); }
.ct-ans-title { display: block; margin-top: 2px; font-size: 18px; line-height: 24px; color: var(--text-link); text-decoration: none; text-wrap: balance; overflow-wrap: anywhere; }
.ct-ans-title:visited { color: var(--text-link-visited); }
.ct-ans-title:hover { text-decoration: underline; }
.ct-ans-detail { margin-top: 2px; font-size: 13px; line-height: 18px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }
@media (hover: hover) { .ct-ans[data-copy]:hover .ct-ans-label::after { content: "⧉"; margin-left: 6px; font-size: 12px; color: var(--text-secondary); } }
@media (max-width: 767px) { .ct-ans-title { min-height: 44px; display: flex; align-items: center; } }

/* ===== AI summary spot: fixed size from before the results are drawn (label 18 + 4 + 3 lines of 24 + ⌄ line 28) =====
   ai-summary's panel stays degoog's child of #at-a-glance and is laid over the spot's 3 lines (takes no room). */
#at-a-glance:has(> .ct-ai) { position: relative; display: flex; flex-direction: column; }
#at-a-glance > .ct-ai { order: -1; position: relative; height: 122px; margin: 16px 0 8px; overflow: hidden; }
.ct-ai-label { font-size: 13px; line-height: 18px; color: var(--text-secondary); white-space: nowrap; }
.ct-ai-text { position: relative; display: flex; flex-direction: column; justify-content: space-around; height: 72px; margin-top: 4px; }
.ct-ai-line { display: block; height: 10px; border-radius: 5px; background: var(--bg-light); }
.ct-ai-line:nth-of-type(3) { width: 60%; }
.ct-ai-err { display: none; position: absolute; inset: 0; font-size: 15px; line-height: 24px; color: var(--text-secondary); background: var(--bg); }
.ct-ai-more { display: block; width: auto; margin: 0; border-radius: 0; height: 28px; min-width: 44px; padding: 0; border: 0; background: none; color: var(--text-link); font-size: 18px; line-height: 28px; text-align: left; cursor: pointer; }
.ct-ai-more:focus-visible { outline: 2px solid var(--text-link); outline-offset: 2px; }
.ct-ai.ct-ai-fail .ct-ai-err { display: block; }
.ct-ai.ct-ai-fail .ct-ai-more { visibility: hidden; }
/* The panel over the 3 lines: its own title, sources row, skeleton, buttons and chat hidden until opened */
#at-a-glance > .ct-ai-panel { position: absolute; left: 0; right: 0; top: 38px; /* spot's margin 16 + label 18 + 4 */ height: 72px; margin: 0 !important; padding: 0 !important; overflow: hidden; border: 0 !important; background: none !important; box-shadow: none !important; z-index: 1; }
#at-a-glance > .ct-ai-panel .results-slot-panel-title, #at-a-glance > .ct-ai-panel .glance-ai-head, #at-a-glance > .ct-ai-panel .glance-ai-rail, #at-a-glance > .ct-ai-panel .glance-ai-expand, #at-a-glance > .ct-ai-panel .glance-ai-collapse, #at-a-glance > .ct-ai-panel .glance-ai-chat, #at-a-glance > .ct-ai-panel .glance-ai-skeleton, #at-a-glance > .ct-ai-panel .glance-ai-writing, #at-a-glance > .ct-ai-panel .glance-ai-thinking-stream, #at-a-glance > .ct-ai-panel .glance-ai-thinking-label { display: none !important; }
#at-a-glance > .ct-ai-panel .results-slot-panel-body, #at-a-glance > .ct-ai-panel .glance-ai, #at-a-glance > .ct-ai-panel .glance-ai-summary-wrap { margin: 0 !important; padding: 0 !important; border: 0 !important; background: none !important; }
#at-a-glance > .ct-ai-panel .glance-ai-body { min-height: 0 !important; max-height: none !important; height: 72px; overflow: hidden; -webkit-mask-image: none; mask-image: none; }
#at-a-glance > .ct-ai-panel .glance-ai-stream, #at-a-glance > .ct-ai-panel .glance-ai-stream * { font-size: 15px !important; line-height: 24px !important; margin-top: 0 !important; margin-bottom: 0 !important; }
#at-a-glance > .ct-ai-panel .glance-ai-stream:not([data-state="pending"]) { min-height: 72px; background: var(--bg); }
#at-a-glance > .ct-ai-panel:has(.glance-ai-stream[data-state="error"]) { visibility: hidden; }
/* Opened with ⌄ (your tap): ai-summary's own panel at its own size, follow-up chat included; the spot steps aside */
#at-a-glance.ct-ai-opened > .ct-ai { display: none; }
#at-a-glance.ct-ai-opened > .ct-ai-panel { position: static; order: -1; height: auto; overflow: visible; }
#at-a-glance.ct-ai-opened > .ct-ai-panel .glance-ai-body { height: auto; }
#at-a-glance.ct-ai-opened > .ct-ai-panel .glance-ai-head, #at-a-glance.ct-ai-opened > .ct-ai-panel .glance-ai-chat:not([hidden]), #at-a-glance.ct-ai-opened > .ct-ai-panel .glance-ai-collapse:not([hidden]) { display: revert !important; }
@media (prefers-reduced-motion: no-preference) { .ct-ai-line { animation: ctPulse 1.4s ease-in-out infinite; } }
@keyframes ctPulse { 50% { opacity: .5; } }

/* CMU card details: amber stars filled to the exact rating; people line folds into "+N"; phones show last names */
.ct-rating { white-space: nowrap; }
.ct-stars { --r: 0; letter-spacing: 1px; background: linear-gradient(90deg, #f5b301 calc(var(--r) / 5 * 100%), var(--bg-light) 0); -webkit-background-clip: text; background-clip: text; color: transparent; }
.ct-fit > * + *::before { content: " · "; }
.ct-fit > [hidden] { display: none; }
@media (max-width: 767px) { .ct-fn { display: none; } }

/* Sports card: logos are the image anchors (fixed 28px boxes, shown once decoded), scores in tabular digits */
.ct-sp { display: flex; align-items: center; gap: 14px; margin-top: 4px; font-size: 24px; line-height: 32px; color: var(--text-primary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ct-sp-team { display: inline-flex; align-items: center; gap: 8px; color: var(--text-secondary); }
.ct-sp-team.ct-win { color: var(--text-primary); }
.ct-sp-away { flex-direction: row; }
.ct-sp-team:not(.ct-sp-away) { flex-direction: row-reverse; }
.ct-sp-logo { display: inline-block; width: 28px; height: 28px; flex: none; }
.ct-sp-logo img { width: 28px; height: 28px; object-fit: contain; opacity: 0; transition: opacity .3s; }
.ct-sp-logo img.ct-on { opacity: 1; }
.ct-sp-abbr { font-size: 15px; line-height: 20px; }
.ct-sp-score { min-width: 1.3em; text-align: center; }
.ct-sp-dash { color: var(--text-secondary); font-size: 15px; }
.ct-live-dot { display: inline-block; width: 7px; height: 7px; margin: 0 5px 1px 0; border-radius: 50%; background: #e5484d; vertical-align: middle; }
@media (prefers-reduced-motion: no-preference) { .ct-live-dot { animation: ctLive 1.6s ease-in-out infinite; } .ct-sp-logo img { transition: opacity .3s; } }
@media (prefers-reduced-motion: reduce) { .ct-sp-logo img { transition: none; } }
@keyframes ctLive { 50% { opacity: .35; } }

'@)
[IO.File]::WriteAllText("$t\setcss.js", @'
const fs = require("fs");
const f = "/app/data/server-settings.json";
const s = JSON.parse(fs.readFileSync(f, "utf8"));
s.settings = s.settings || {};
s.settings.customCss = fs.readFileSync("/tmp/custom.css", "utf8");
// Result menu with Rank higher / Rank lower / Block, and endless scroll (both built into degoog)
s.settings.domainBlockUiEnabled = true;
s.settings.domainScoreUiEnabled = true;
s.settings.infiniteScrollEnabled = true;
fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2));
fs.renameSync(f + ".tmp", f);
console.log("custom CSS saved into degoog: " + s.settings.customCss.length + " chars");
'@)
docker cp "$t\custom.css" "${c}:/tmp/custom.css"; docker cp "$t\setcss.js" "${c}:/tmp/setcss.js"
docker exec $c bun /tmp/setcss.js; docker exec $c rm -f /tmp/custom.css /tmp/setcss.js
[IO.File]::WriteAllText("$t\aittl.js", @'
// Run by the installer inside degoog (bun): ai-summary keeps its answers as long as degoog keeps the search results
// (TTL_MS, 12 h unless DEGOOG_CACHE_TTL_MS says otherwise), instead of its hard-coded 2 minutes. RAM/valkey cache
// only, like the results. Exactly one matching line is changed; 0 or several -> nothing changed, and it says so.
const fs = require("fs");
const root = process.env.DEGOOG_PLUGINS_DIR || "/app/data/plugins";
const MARK = "/* clean-titles: same as degoog's TTL_MS */";
const LINE = /^const SHORT_TTL_MS = 2 \* 60 \* 1000;[ \t]*$/gm;
const NEW = `${MARK} const SHORT_TTL_MS = (() => { const n = Number.parseInt(process.env.DEGOOG_CACHE_TTL_MS || "", 10); return Number.isFinite(n) && n > 0 ? n : 12 * 60 * 60 * 1000; })();`;
let dirs = [];
try { dirs = fs.readdirSync(root).filter((d) => /ai-summary/i.test(d)); } catch {}
if (!dirs.length) { console.log("AI summary cache: ai-summary not installed, nothing to do"); process.exit(0); }
for (const d of dirs) {
  const f = `${root}/${d}/index.js`;
  let src = "";
  try { src = fs.readFileSync(f, "utf8"); } catch { console.log(`AI summary cache: ${d} has no index.js, skipped`); continue; }
  if (src.includes(MARK)) { console.log(`AI summary cache: ${d} already keeps answers as long as search results (OK)`); continue; }
  const n = (src.match(LINE) || []).length;
  if (n !== 1) { console.log(`AI summary cache: NOTICE ${d}: found ${n} copies of the 2-minute line (expected 1), so nothing was changed. ai-summary may have been updated.`); continue; }
  const out = src.replace(LINE, NEW);
  fs.writeFileSync(f + ".ct-tmp", out);
  fs.renameSync(f + ".ct-tmp", f);
  console.log(`AI summary cache: ${d} now keeps answers as long as search results (OK)`);
}

'@)
docker cp "$t\aittl.js" "${c}:/tmp/aittl.js"; docker exec $c bun /tmp/aittl.js; docker exec $c rm -f /tmp/aittl.js
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $t
docker restart $c | Out-Null
$null = docker exec $c sh -c 'for i in $(seq 1 40); do curl -fs -o /dev/null http://127.0.0.1:${DEGOOG_PORT:-4444}/readyz && exit 0; sleep 1; done'

$ss = docker exec $c cat /app/data/server-settings.json | Out-String | ConvertFrom-Json
"plugin code inside the page (should be v50-preview): " + (docker exec $c grep -o -m1 'clean-titles v[0-9a-z-]*' /app/src/public/themes/degoog-theme/layout.html | Select-Object -First 1)
"public suffix file (should be a psl file): " + (docker exec $c sh -c 'ls /app/src/public/ct/')
"progressive results off (should be False): $($ss.settings.streamingEnabled -eq $true)"
"typo fixer word list (should be about 82800): " + (docker exec $c sh -c 'wc -l < /app/data/plugins/clean-titles/words.txt')
"typo fixer word pairs (should be about 243000): " + (docker exec $c sh -c 'wc -l < /app/data/plugins/clean-titles/pairs.txt')
"names from Wikipedia (should be well over 100000): " + (docker exec $c sh -c 'wc -l < /app/data/plugins/clean-titles/names.txt 2>/dev/null')
"result menu with Rank higher / Rank lower / Block (should be True): $($ss.settings.domainScoreUiEnabled -and $ss.settings.domainBlockUiEnabled)"
"endless scroll on (should be True): $($ss.settings.infiniteScrollEnabled)"
# Checks both code files for mistakes and tries the typo fixer and People also ask, from inside degoog
[IO.File]::WriteAllText("$env:TEMP\ct-check.js", @'
const fs = require("fs");
const test = (name, code) => {
  if (!code) return console.log(`${name}: MISSING`);
  try { new Bun.Transpiler({ loader: "js" }).transformSync(code); console.log(`${name}: OK`); }
  catch (e) { console.log(`${name}: ERROR ${(e.errors || [e]).slice(0, 3).map((x) => String(x.message || x).split("\n")[0]).join(" | ")}`); }
};
const m = /<script type="module" id="ct-inline">([\s\S]*?)\n<\/script>/.exec(fs.readFileSync("/app/src/public/themes/degoog-theme/layout.html", "utf8"));
test("page code check (should be OK)", m && m[1]);
test("server code check (should be OK)", fs.readFileSync("/app/data/plugins/clean-titles/index.js", "utf8"));
// Tries the typo fixer and People also ask the way your iPhone reaches them (through /api/command)
const ask = async (name, cmd) => {
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.DEGOOG_PORT || 4444}/api/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: `!cleantitles bridge ${cmd}` }), signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    console.log(`${name}: ${String(j.html || j.error).replace(/&quot;/g, '"').replace(/&amp;/g, "&").slice(0, 300)} (${Date.now() - t0} ms)`);
  } catch (e) { console.log(`${name}: failed: ${e}`); }
};
await ask("typo fix for 'teh wether tommorow' (should be the weather tomorrow)", "fix q=teh+wether+tommorow");
await ask("People also ask for 'pittsburgh steelers' (should list questions)", "qs q=pittsburgh+steelers");
'@)
docker cp "$env:TEMP\ct-check.js" "${c}:/tmp/ct-check.js"; docker exec $c bun /tmp/ct-check.js; docker exec $c rm -f /tmp/ct-check.js; Remove-Item -Force "$env:TEMP\ct-check.js"
} | Tee-Object -Variable o; $o | Out-String | Set-Clipboard
