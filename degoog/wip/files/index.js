import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";

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

// ===== Page part check: a degoog image update replaces /app/src (layout.html + /public/ct), and this plugin can't
// write it back (degoog runs as uid 1000 via su-exec in entrypoint.sh; /app/src belongs to root). So it says so at the
// top of its Settings entry and in the log, read once at start (degoog restarts on image updates anyway)
export const PAGE_FILE = "/app/src/public/themes/degoog-theme/layout.html";
export const pagePartMissing = (html, exists = (p) => fs.existsSync(p)) => {
  if (typeof html !== "string") return false; // can't read it: say nothing rather than guess
  const m = /<script defer src="\/public\/ct\/(psl\.[0-9a-f]+\.js)" id="ct-psl"><\/script>/.exec(html);
  if (!m || !exists(`/app/src/public/ct/${m[1]}`)) return true;
  if (html.includes('<script type="module" id="ct-inline">')) return false; // older installs: page script inline
  const c = /<script type="module" src="\/public\/ct\/(ct\.[0-9a-f]+\.js)" id="ct-inline"><\/script>/.exec(html);
  return !c || !exists(`/app/src/public/ct/${c[1]}`);
};
let _pageHtml; try { _pageHtml = fs.readFileSync(PAGE_FILE, "utf8"); } catch {}
export const PAGE_MISSING = pagePartMissing(_pageHtml);
_pageHtml = undefined;
if (PAGE_MISSING) console.warn("[clean-titles] the page part is missing (a degoog update replaced it): run the installer again");

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
// redirect: "manual" returns a 3xx as is, with its Location (archive.today answers a found copy that way)
// imp: on 403/429/503 ask once more through degoog's curl-impersonate transport (a browser's TLS fingerprint; the
// degoog image ships it), for sites that turn away plain server requests (ESPN, recipe sites). Only with degoog's
// own fetch (ctx.fetch = outgoingFetch, whose 3rd argument picks the transport).
export const net = async (url, { etag = "", timeout = 10000, max = 2_000_000, accept = "*/*", headers = {}, redirect = "follow", imp = false } = {}) => {
  try {
    const f = _fetch || fetch;
    const init = () => ({ headers: { Accept: accept, ...headers, ...(etag ? { "If-None-Match": etag } : {}) }, signal: AbortSignal.timeout(timeout), redirect });
    let r = await f(url, init());
    if (imp && _fetch && [403, 429, 503].includes(r.status)) { try { const r2 = await _fetch(url, init(), "curl-impersonate"); if (r2 && typeof r2.status === "number") r = r2; } catch {} }
    if (r.status === 304) return { status: 304, text: "", etag };
    if (redirect === "manual" && r.status >= 300 && r.status < 400) return { status: r.status, text: "", etag: "", location: r.headers.get("location") || "" };
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
// Why a lookup came back empty (last time per feature), for the installer self-check only: no search words kept
export const WHY = {};
const why = (k, r) => { WHY[k] = r; return null; };
const WD = { height: "P2048", population: "P1082", born: "P569", age: "P569", died: "P570", founded: "P571", ceo: "P169", released: "P577", distance: "P625" };
const WD_API = "https://www.wikidata.org/w/api.php";
// Wikimedia's User-Agent policy asks for a project link; requests without one get throttled (429). degoog's public
// project page is used: nothing that identifies this server or its owner.
const WD_UA = { "User-Agent": "degoog-clean-titles/50 (+https://github.com/degoog-org/degoog; self-hosted search plugin)" };
// At most 2 Wikidata requests at a time from this server (their API etiquette: no parallel bursts)
let _wdBusy = 0; const _wdWait = [];
const wdSlot = async () => { if (_wdBusy >= 2) await new Promise((ok) => _wdWait.push(ok)); _wdBusy++; };
const wdFree = () => { _wdBusy--; const n = _wdWait.shift(); if (n) n(); };
const wdGet = async (params) => {
  const u = `${WD_API}?${new URLSearchParams({ ...params, format: "json" })}`;
  await wdSlot();
  let r;
  try {
    r = await net(u, { timeout: 3000, max: 4_000_000, accept: "application/json", headers: WD_UA });
    if (r.status === 429 || r.status === 0) { await new Promise((ok) => setTimeout(ok, 1000)); r = await net(u, { timeout: 3000, max: 4_000_000, accept: "application/json", headers: WD_UA }); }
  } finally { wdFree(); }
  if (r.status !== 200) { wdGet.last = `wikidata ${params.action} ${r.status ? `http ${r.status}` : "no answer"}`; return null; }
  let j;
  try { j = JSON.parse(r.text); } catch { wdGet.last = `wikidata ${params.action} not JSON`; return null; }
  if (j && j.error) { wdGet.last = `wikidata ${params.action} error ${String(j.error.code || j.error.info || "").slice(0, 40)}`; return null; }
  return j;
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
  if (v && typeof v === "object" && "amount" in v) return { amount: v.amount, unit: String(v.unit || "").split("/").pop(), asOf: (c.qualifiers && c.qualifiers.P585 && c.qualifiers.P585[0] && c.qualifiers.P585[0].datavalue && c.qualifiers.P585[0].datavalue.value && c.qualifiers.P585[0].datavalue.value.time) || undefined };
  if (v && typeof v === "object" && "time" in v) return { time: v.time, prec: v.precision };
  if (v && typeof v === "object" && "latitude" in v) return { lat: v.latitude, lon: v.longitude };
  if (v && typeof v === "object" && v["entity-type"] === "item") return { id: v.id };
  if (typeof v === "string") return v;
  return null;
};
const wdOne = async (name, prop) => {
  const s = await wdGet({ action: "wbsearchentities", search: name, language: "en", uselang: "en", type: "item", limit: "3" });
  if (!s) return why("wd", wdGet.last);
  const hits = (Array.isArray(s.search) ? s.search : []).filter((x) => x && x.id);
  if (!hits.length) return why("wd", "no Wikidata item");
  // The top item first; the next two only if it has no such value (e.g. a disambiguation page came first)
  const props = prop === "P569" ? ["P569", "P570"] : [prop];
  let hit = null, got = null, vals = [];
  for (const h of hits) {
    got = await Promise.all(props.map((p) => wdGet({ action: "wbgetclaims", entity: h.id, property: p })));
    if (!got[0]) return why("wd", wdGet.last);
    vals = wdBest(got[0].claims && got[0].claims[prop]).map(wdValue).filter(Boolean).slice(0, 1);
    if (vals.length) { hit = h; break; }
  }
  if (!vals.length) return why("wd", "item has no value for it");
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
  let v = null;
  try {
    v = await wdOne(s, prop);
    if (v && fact === "distance") { const b = await wdOne(s2, prop); v = b ? { ...v, b } : null; }
  } catch (e) { v = why("wd", `error: ${String(e && e.message || e).slice(0, 80)}`); }
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
// Products (phones, laptops, consoles, cars, cameras…): any item with a manufacturer or brand that isn't one of the
// types above. Wikidata gives the dates and a few specs; the Wikipedia infobox fills in the rest (kpInfobox).
const KP_PRODUCT = ["product", [], [["Released", "P577|P571"], ["Discontinued", "P2669|P576"], ["Launch price", "P2284"], ["Manufacturer", "P176|P1716"], ["Processor", "P880"], ["Memory", "P2928"], ["OS", "P306", 2], ["Predecessor", "P155"], ["Successor", "P156"]]];
const KP_ORDER = ["Released", "Discontinued", "Launch price", "Manufacturer", "Processor", "Graphics", "Memory", "Storage", "Display", "Battery", "Camera", "OS", "Engine", "Weight", "Predecessor", "Successor"];
// entity JSON (wbgetentities) -> {type, rows: [{k, prop, vals: [wdValue...], max}], image, title}
// up: {P31 value: its own "subclass of" (P279) values}, asked only when no P31 value is a known type
// (Golden Gate Bridge is a "suspension bridge", which is a subclass of "bridge")
export const kpPlan = (ent, up = {}) => {
  const cl = (ent && ent.claims) || {};
  const p31 = wdBest(cl.P31).map(wdValue).filter((v) => v && v.id).map((v) => v.id);
  const t = KP_TYPES.find(([, ids]) => p31.some((x) => ids.includes(x))) || ((cl.P176 || cl.P1716) && KP_PRODUCT) || KP_TYPES.find(([, ids]) => p31.some((x) => (up[x] || []).some((y) => ids.includes(y))));
  const rows = [];
  for (const [k, props, max = 1] of t ? t[2] : []) {
    for (const prop of props.split("|")) {
      const vals = wdBest(cl[prop]).map(wdValue).filter(Boolean).slice(0, max);
      if (vals.length) { rows.push({ k, prop, vals, max }); break; }
    }
  }
  const site = wdBest(cl.P856).map(wdValue).find((x) => typeof x === "string") || "";
  const img = wdBest(cl.P18).map((c) => c.mainsnak.datavalue.value).find((x) => typeof x === "string");
  const title = ent && ent.sitelinks && ent.sitelinks.enwiki && ent.sitelinks.enwiki.title;
  return { type: t ? t[0] : "", rows, image: img || "", title: title || "", p31, site };
};
// Units and currencies read by their English label (no guessed item ids)
const CUR_SYM = { "united states dollar": "$", "euro": "€", "pound sterling": "£", "japanese yen": "¥", "canadian dollar": "CA$", "australian dollar": "A$", "indian rupee": "₹", "renminbi": "CN¥" };
const UNIT_ABBR = { "gigabyte": "GB", "megabyte": "MB", "terabyte": "TB", "kilobyte": "KB", "gibibyte": "GiB", "mebibyte": "MiB", "gram": "g", "kilogram": "kg", "millimetre": "mm", "centimetre": "cm", "inch": "in", "milliampere hour": "mAh", "watt": "W", "gigahertz": "GHz", "megahertz": "MHz", "megapixel": "MP" };
// ----- Wikipedia infobox -> [{k, v}] (product specs). Wikitext of the article's lead section; values cleaned of
// references, links and templates; dates from {{Start date|2023|9|22}} etc. written like Wikidata's ("Sep 22, 2023").
const IB_KEYS = [["Released", /^(?:release_?date|released|first_?release|launch_?date|date_?released|introduced|introductory_?date)$/], ["Discontinued", /^(?:discontinued|discontinuation(?:_?date)?|end_?of_?production|production_?end|discontinued_?date)$/], ["Launch price", /^(?:price|introductory_?price|launch_?price|msrp|retail_?price|price_?launch|introductory_?price_?us)$/], ["Manufacturer", /^(?:manufacturer|maker)$/], ["Processor", /^(?:cpu|soc|processor|chipset)$/], ["Graphics", /^(?:gpu|graphics)$/], ["Memory", /^(?:memory|ram)$/], ["Storage", /^(?:storage|internal_?storage)$/], ["Display", /^(?:display|screen)$/], ["Battery", /^battery$/], ["Camera", /^(?:camera|rear_?camera|primary_?camera)$/], ["OS", /^(?:os|operating_?system|operatingsystem)$/], ["Engine", /^engine$/], ["Weight", /^(?:weight|mass)$/], ["Predecessor", /^predecessor$/], ["Successor", /^successor$/]];
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ibDate = (a) => {
  const n = a.filter((x) => !x.includes("=")).map((x) => x.trim()).filter(Boolean);
  const y = +n[0], m = +n[1], d = +n[2];
  if (!(y > 1000)) return "";
  return m >= 1 && m <= 12 ? (d >= 1 && d <= 31 ? `${MON3[m - 1]} ${d}, ${y}` : `${MON3[m - 1]} ${y}`) : String(y);
};
const ibTpl = (name, a) => {
  const t = name.trim().toLowerCase();
  if (/^(?:start date|end date|release date|film date|start date and age|end date and age|date|birth date|dts)$/.test(t)) return ibDate(a);
  if (/^(?:us\$|usd)$/.test(t)) return `$${(a[0] || "").trim()}`;
  if (/^(?:€|eur|euro)$/.test(t)) return `€${(a[0] || "").trim()}`;
  if (/^(?:£|gbp)$/.test(t)) return `£${(a[0] || "").trim()}`;
  if (/^(?:¥|jpy|yen)$/.test(t)) return `¥${(a[0] || "").trim()}`;
  if (t === "convert" || t === "cvt") return `${(a[0] || "").trim()} ${(a[1] || "").trim()}`;
  if (/^(?:nowrap|nobr|small|abbr|tooltip|nowrap begin|lang-?\w*|resize)$/.test(t)) return (t.startsWith("lang") && a.length > 1 ? a[1] : a[0]) || "";
  if (t === "nbsp" || t === "sp") return " ";
  if (/^(?:ubl|unbulleted list|plainlist|plain list|flatlist|hlist|bulleted list|ubil|br separated entries)$/.test(t)) return a.filter((x) => !/^\s*\w+\s*=/.test(x)).join("\n");
  return "";
};
export const ibClean = (v) => {
  let s = String(v || "").replace(/<!--[\s\S]*?-->/g, "").replace(/<ref[^>]*\/>/gi, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  s = s.replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, "").replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2").replace(/\[\[([^\]]*)\]\]/g, "$1");
  for (let i = 0; i < 8 && /\{\{[^{}]*\}\}/.test(s); i++) s = s.replace(/\{\{([^{}]*)\}\}/g, (_, x) => { const [n, ...a] = x.split("|"); return ibTpl(n, a); });
  s = s.replace(/\{\{|\}\}/g, "").replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, "$1").replace(/\[https?:\/\/\S+\]/g, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/'{2,}/g, "").replace(/&nbsp;/g, " ").replace(/&ndash;/g, "–").replace(/&amp;/g, "&");
  s = s.split("\n").map((x) => x.replace(/^[*#:;\s]+/, "").trim()).filter(Boolean).join(", ");
  s = s.replace(/\s+/g, " ").replace(/\s+,/g, ",").replace(/,(\s*,)+/g, ",").replace(/^[,;\s]+|[,;:\s]+$/g, "").replace(/\(\s*\)/g, "").trim();
  if (s.length > 140) s = `${s.slice(0, 140).replace(/[\s,;]+\S*$/, "")}…`;
  return s;
};
export const kpInfobox = (wikitext) => {
  const w = String(wikitext || ""), at = w.search(/\{\{\s*Infobox/i);
  if (at < 0) return [];
  let depth = 0, end = w.length;
  for (let i = at; i < w.length - 1; i++) {
    if (w[i] === "{" && w[i + 1] === "{") { depth++; i++; } else if (w[i] === "}" && w[i + 1] === "}") { depth--; i++; if (!depth) { end = i - 1; break; } }
  }
  const body = w.slice(at + 2, end), parts = [];
  let d = 0, cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i], two = body.slice(i, i + 2);
    if (two === "{{" || two === "[[") { d++; cur += two; i++; continue; }
    if (two === "}}" || two === "]]") { d--; cur += two; i++; continue; }
    if (c === "|" && d === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  const out = [];
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase().replace(/[\s-]+/g, "_");
    const hit = IB_KEYS.find(([, re]) => re.test(key));
    if (!hit || out.some((f) => f.k === hit[0])) continue;
    const v = ibClean(p.slice(eq + 1));
    if (v) out.push({ k: hit[0], v });
  }
  return out;
};
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
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
    if (u) return `${n.toLocaleString("en-US")} ${u[0]}`;
    const ul = String(labels[v.unit] || "").toLowerCase();
    if (row.prop === "P2284" && CUR_SYM[ul]) return `${CUR_SYM[ul]}${n.toLocaleString("en-US")}`;
    return ul ? `${n.toLocaleString("en-US")} ${UNIT_ABBR[ul] || labels[v.unit]}` : n.toLocaleString("en-US");
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
    const s = await wdGet({ action: "wbsearchentities", search: name, language: "en", uselang: "en", type: "item", limit: "7" });
    const h = s && Array.isArray(s.search) && s.search[0];
    // Other meanings of the same words (spec 9 meaning line), from the same answer: label + short description
    const alts = (s && Array.isArray(s.search) ? s.search : []).filter((x) => x && x.label && x.description && !/disambiguation|wikimedia|family name|given name|surname|scholarly article|list of/i.test(x.description)).slice(0, 7).map((x) => ({ label: String(x.label).slice(0, 80), desc: String(x.description).slice(0, 120) }));
    const e = h && h.id && await wdGet({ action: "wbgetentities", ids: h.id, props: "claims|sitelinks", sitefilter: "enwiki" });
    const ent = e && e.entities && e.entities[h.id];
    if (!s) why("kp", wdGet.last); else if (!h) why("kp", "no Wikidata item"); else if (!ent) why("kp", wdGet.last || "item not returned");
    if (ent) {
      let plan = kpPlan(ent);
      if (!plan.type && plan.title && plan.p31.length) {
        const ps = await Promise.all(plan.p31.slice(0, 3).map((id) => wdGet({ action: "wbgetclaims", entity: id, property: "P279" })));
        const up = {};
        plan.p31.slice(0, 3).forEach((id, i) => { up[id] = wdBest(ps[i] && ps[i].claims && ps[i].claims.P279).map(wdValue).filter((x) => x && x.id).map((x) => x.id); });
        plan = kpPlan(ent, up);
      }
      if (!plan.title) why("kp", "no English Wikipedia article");
      if (plan.title) {
        const ids = [...new Set(plan.rows.flatMap((r) => r.vals.flatMap((x) => x.id ? [x.id] : x.unit && /^Q\d+$/.test(x.unit) && !UNIT_NAME[x.unit] ? [x.unit] : [])))].slice(0, 20);
        const prod = plan.type === "product", maker = prod && (plan.rows.find((r) => r.k === "Manufacturer") || { vals: [] }).vals.find((x) => x.id);
        const page = encodeURIComponent(plan.title.replace(/ /g, "_"));
        const [lab, sum, raw, mk] = await Promise.all([
          ids.length ? wdGet({ action: "wbgetentities", ids: ids.join("|"), props: "labels", languages: "en" }) : null,
          net(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`, { timeout: 3000, max: 200000, accept: "application/json", headers: WD_UA }),
          prod ? net(`https://en.wikipedia.org/w/index.php?title=${page}&action=raw&section=0`, { timeout: 3000, max: 400000, headers: WD_UA }) : null,
          maker ? wdGet({ action: "wbgetclaims", entity: maker.id, property: "P856" }) : null,
        ]);
        const labels = {};
        for (const id of ids) { const l = lab && lab.entities && lab.entities[id] && lab.entities[id].labels && lab.entities[id].labels.en; if (l) labels[id] = l.value; }
        let sj = null;
        try { sj = sum.status === 200 ? JSON.parse(sum.text) : null; } catch {}
        let facts = plan.rows.map((r) => ({ k: r.k, v: kpText(r, labels) })).filter((f) => f.v);
        // Products: the infobox adds what Wikidata lacks (specs, launch price); its official sites back the panel up
        const hosts = [];
        if (prod) {
          const ib = raw && raw.status === 200 ? kpInfobox(raw.text) : [];
          for (const f of ib) if (!facts.some((x) => x.k === f.k)) facts.push(f);
          facts.sort((a, b) => KP_ORDER.indexOf(a.k) - KP_ORDER.indexOf(b.k));
          const ms = mk && mk.claims ? wdBest(mk.claims.P856).map(wdValue).find((x) => typeof x === "string") : "";
          for (const u of [plan.site, ms]) { const h = u && hostOf(u); if (h && !hosts.includes(h)) hosts.push(h); }
          if (!ib.length) why("kp-specs", raw ? `infobox ${raw.status === 200 ? "not found" : `http ${raw.status || "no answer"}`}` : "not asked");
        }
        const photo = plan.image ? `https://commons.wikimedia.org/w/index.php?title=Special:FilePath/${encodeURIComponent(plan.image)}&width=330` : sj && sj.thumbnail && sj.thumbnail.source || "";
        why("kp", [!plan.type && "type not known", !facts.length && "no facts", !(sj && sj.extract) && `Wikipedia summary ${sum.status ? `http ${sum.status}` : "no answer"}`, !photo && "no photo", photo && !_sign && "no image signer"].filter(Boolean).join(", ") || "ok");
        v = { qid: h.id, title: plan.title, name: h.label || plan.title, type: plan.type, desc: h.description || (sj && sj.description) || "", extract: sj && typeof sj.extract === "string" ? sj.extract : "", facts, photo: photo && _sign ? _sign(photo) : "", ...(hosts.length ? { hosts } : {}) };
      }
    }
    if (alts.length >= 2) v = { ...(v || {}), alts };
  } catch (e) { v = why("kp", `error: ${String(e && e.message || e).slice(0, 80)}`); }
  if (_kp.size > 1000) _kp.clear();
  _kp.set(key, { t: v ? Date.now() : Date.now() - TTL + 600000, v });
  return v;
};

// ===== Archived copy (spec 10): asked only when you tap "Open archived copy" in a result's menu =====
// archive.today, the Wayback Machine and Ghostarchive are asked in parallel; the first that has the page in this
// order wins: archive.today first for paywalled sites (it keeps the full text), else Wayback first (dead pages).
// None has it -> archive.today's save page for that address. Endpoints from knowledge, NOT live-checked here.
const ARCH_UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36" };
export const archSave = (u) => `https://archive.ph/?url=${encodeURIComponent(u)}`;
const _arch = new Map();
export const archFind = async (u, paywall) => {
  let url;
  try { url = new URL(u); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || u.length > 2000) return null;
  const key = createHash("sha256").update(`arch\n${u}`).digest("hex").slice(0, 24);
  const hit = _arch.get(key);
  if (hit && Date.now() - hit.t < (hit.v.src === "save" ? 600000 : TTL)) return hit.v;
  const today = async () => {
    const r = await net(`https://archive.ph/newest/${u}`, { timeout: 4000, redirect: "manual", headers: ARCH_UA, max: 400000 });
    const loc = r.location || "";
    return r.status >= 300 && r.status < 400 && /^https:\/\/archive\.(?:ph|today|is|li|vn|fo|md)\/(?:[A-Za-z0-9]{4,6}$|\d{14}\/|\d{4}\.\d{2}\.\d{2}-\d{6}\/)/.test(loc) ? loc : "";
  };
  const wayback = async () => {
    const r = await net(`https://archive.org/wayback/available?url=${encodeURIComponent(u)}`, { timeout: 4000, accept: "application/json", max: 100000 });
    try { const c = JSON.parse(r.text).archived_snapshots.closest; return c && c.available && /^https?:\/\/web\.archive\.org\/web\/\d+/.test(c.url) ? c.url.replace(/^http:/, "https:") : ""; } catch { return ""; }
  };
  const ghost = async () => {
    const r = await net(`https://ghostarchive.org/search?term=${encodeURIComponent(u)}`, { timeout: 4000, headers: ARCH_UA, max: 600000 });
    const m = /href="(\/archive\/[A-Za-z0-9]+)"/.exec(r.text || "");
    return m ? `https://ghostarchive.org${m[1]}` : "";
  };
  const [a, w, g] = await Promise.all([today(), wayback(), ghost()]);
  const order = paywall ? [[a, "archive.today"], [w, "Wayback Machine"], [g, "Ghostarchive"]] : [[w, "Wayback Machine"], [a, "archive.today"], [g, "Ghostarchive"]];
  const f = order.find(([x]) => x);
  const v = f ? { url: f[0], src: f[1] } : { url: archSave(u), src: "save" };
  if (_arch.size > 500) _arch.clear();
  _arch.set(key, { t: Date.now(), v });
  return v;
};

// ===== Quick view (spec 11): asked only when you tap "Quick view" in a result's menu =====
// The server fetches the page once and reads its schema.org JSON-LD (recipe, how-to, product, FAQ, event, app,
// movie/book, local business, article); else the page's main text (a small Readability-like pass); JS-only pages
// give nothing and stay links. Only text goes back to the page (drawn with textContent), never the page's HTML.
const ldStrip = (h) => String(h == null ? "" : h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " "; })
  .replace(/[ \t\r\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const ld1 = (x) => (Array.isArray(x) ? x[0] : x);
const ldTxt = (x, n = 300) => { const v = ld1(x); const t = ldStrip(typeof v === "object" && v ? v.name || v["@value"] || v.text || "" : v); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const ldTypes = (o) => [].concat(o && o["@type"] || []).map(String);
// "2026-11-20T10:00:00Z" -> "Nov 20, 2026" (a bare year stays a year)
const ldDay = (x) => { const t = ldTxt(x, 40); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); if (!m) return /^\d{4}$/.test(t) ? t : ""; return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); };
// ISO 8601 duration -> "1 hr 30 min"
export const isoDur = (d) => {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:\d+(?:\.\d+)?S)?)?$/i.exec(String(d || "").trim());
  if (!m) return "";
  const mins = Math.round((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0));
  if (!mins) return "";
  const h = Math.floor(mins / 60), r = mins % 60;
  return h ? `${h} hr${r ? ` ${r} min` : ""}` : `${r} min`;
};
const ldRating = (o) => { const a = o && ld1(o.aggregateRating); const v = a && Number(a.ratingValue), best = a && Number(a.bestRating || 5); const n = a && Number(a.ratingCount || a.reviewCount || 0); return v > 0 && best > 0 ? { v: Math.round((v / best) * 50) / 10, n: Number.isFinite(n) ? n : 0 } : null; };
const ldSteps = (ins) => {
  const out = [];
  const walk = (x) => {
    if (out.length >= 60 || x == null) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === "string") { ldStrip(x).split(/\n+/).map((t) => t.trim()).filter(Boolean).forEach((t) => out.push(t.slice(0, 600))); return; }
    if (typeof x === "object") {
      if (x.itemListElement) { walk(x.itemListElement); return; }
      const t = ldStrip(x.text || x.name || "");
      if (t) out.push(t.slice(0, 600));
    }
  };
  walk(ins);
  return out;
};
const ORDER = ["Recipe", "HowTo", "Product", "FAQPage", "Event", "SoftwareApplication", "MobileApplication", "WebApplication", "Movie", "TVSeries", "Book", "LocalBusiness", "Restaurant", "Store", "Article", "NewsArticle", "BlogPosting", "Report", "TechArticle"];
const LOCAL = /(?:LocalBusiness|Restaurant|Store|Cafe|CafeOrCoffeeShop|Bakery|BarOrPub|Hotel|Dentist|Physician|AutoRepair|Museum|TouristAttraction)$/;
// All JSON-LD objects of a page (arrays and @graph flattened), parse failures skipped
export const ldObjects = (html) => {
  const out = [];
  const re = /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 200) {
    let j;
    try { j = JSON.parse(m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "").trim()); } catch { continue; }
    const add = (x) => { if (Array.isArray(x)) x.forEach(add); else if (x && typeof x === "object") { out.push(x); if (x["@graph"]) add(x["@graph"]); } };
    add(j);
  }
  return out;
};
// The quick view for one page's HTML: {kind, title, facts: [[label, value]], lists: [{label, items}], text: [...]}
export const qvFrom = (html, base = "") => {
  const objs = ldObjects(html);
  const pick = ORDER.map((t) => objs.find((o) => ldTypes(o).some((x) => x === t || (t === "LocalBusiness" && LOCAL.test(x))))).find(Boolean);
  const facts = [], lists = [];
  const fact = (k, v) => { if (v) facts.push([k, String(v)]); };
  const star = (r) => (r ? `${r.v.toFixed(1)} ★${r.n ? ` (${r.n.toLocaleString("en-US")})` : ""}` : "");
  if (pick) {
    const t = ldTypes(pick).find((x) => ORDER.includes(x) || LOCAL.test(x)) || "";
    const title = ldTxt(pick.name || pick.headline, 200);
    let kind = "page";
    if (t === "Recipe") {
      kind = "recipe";
      fact("Rating", star(ldRating(pick))); fact("Total time", isoDur(pick.totalTime) || isoDur(pick.cookTime)); fact("Serves", ldTxt(pick.recipeYield, 40));
      const ing = [].concat(pick.recipeIngredient || pick.ingredients || []).map((x) => ldStrip(x)).filter(Boolean).slice(0, 80);
      if (ing.length) lists.push({ label: "ingredients", items: ing });
      const st = ldSteps(pick.recipeInstructions);
      if (st.length) lists.push({ label: "steps", items: st, ordered: true });
    } else if (t === "HowTo") {
      kind = "howto";
      fact("Time", isoDur(pick.totalTime));
      const st = ldSteps(pick.step);
      if (st.length) lists.push({ label: "steps", items: st, ordered: true });
    } else if (t === "Product") {
      kind = "product"; // no store prices (spec)
      fact("Rating", star(ldRating(pick))); fact("Brand", ldTxt(pick.brand, 80));
      const d = ldTxt(pick.description, 400); if (d) lists.push({ label: "", items: [d], para: true });
    } else if (t === "FAQPage") {
      kind = "faq";
      const qa = [].concat(pick.mainEntity || []).map((x) => x && `${ldTxt(x.name, 200)}\n${ldTxt(x.acceptedAnswer && (ld1(x.acceptedAnswer).text || ld1(x.acceptedAnswer)), 600)}`.trim()).filter((x) => x && x.includes("\n"));
      if (qa.length) lists.push({ label: "questions", items: qa, qa: true });
    } else if (t === "Event") {
      kind = "event";
      const loc = ld1(pick.location);
      fact("When", ldDay(pick.startDate)); fact("Where", loc && (ldTxt(loc.name, 120) || ldTxt(loc.address, 160)));
    } else if (/Application$/.test(t)) {
      kind = "app";
      fact("Rating", star(ldRating(pick))); fact("Runs on", ldTxt(pick.operatingSystem, 80)); fact("Category", ldTxt(pick.applicationCategory, 60));
    } else if (t === "Movie" || t === "TVSeries" || t === "Book") {
      kind = t === "Book" ? "book" : "movie";
      fact("Rating", star(ldRating(pick))); fact(t === "Book" ? "Author" : "Director", ldTxt(pick.author || pick.director, 120)); fact("Released", ldDay(pick.datePublished || pick.dateCreated)); fact(t === "Book" ? "Pages" : "Running time", t === "Book" ? ldTxt(pick.numberOfPages, 10) : isoDur(pick.duration));
    } else if (LOCAL.test(t)) {
      kind = "place";
      const a = ld1(pick.address);
      fact("Rating", star(ldRating(pick))); fact("Address", a && typeof a === "object" ? [a.streetAddress, a.addressLocality, a.addressRegion].map((x) => ldTxt(x, 80)).filter(Boolean).join(", ") : ldTxt(a, 200)); fact("Phone", ldTxt(pick.telephone, 40));
      const oh = [].concat(pick.openingHours || []).map((x) => ldTxt(x, 60)).filter(Boolean);
      if (oh.length) fact("Hours", oh.slice(0, 3).join("; "));
    } else {
      kind = "article";
      const words = Number(pick.wordCount);
      fact("By", ldTxt(pick.author, 80)); fact("Published", ldDay(pick.datePublished)); fact("Reading time", words > 0 ? `${Math.max(1, Math.round(words / 230))} min` : "");
      if (pick.isAccessibleForFree === false || String(pick.isAccessibleForFree).toLowerCase() === "false") fact("Access", "Paywall");
    }
    if (facts.length || lists.length) return { kind, title, facts, lists, text: kind === "article" ? mainText(html) : [] };
  }
  const text = mainText(html);
  return text.length ? { kind: "page", title: "", facts, lists, text } : null;
};
// Readability-like: paragraphs of real sentences from <article>/<main> (else the whole body), the first few
export const mainText = (html) => {
  const body = (/<article\b[\s\S]*?<\/article>/i.exec(html) || /<main\b[\s\S]*?<\/main>/i.exec(html) || [html])[0];
  const ps = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(body)) && ps.length < 4) { const t = ldStrip(m[1]).replace(/\s+/g, " "); if (t.length >= 80 && /[.!?]["')\]]?$/.test(t) && !/cookie|subscribe|sign up|javascript/i.test(t)) ps.push(t.length > 700 ? `${t.slice(0, 699).trimEnd()}…` : t); }
  return ps;
};
// Never fetch this server's own network: the bridge has no sign-in, so a quick view could otherwise be pointed at
// the LAN. Every hop of a redirect is checked.
const privateIp = (ip) => /^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|::$|f[cd]|fe80|::ffff:(?:127|10|192\.168|169\.254)\.)/i.test(ip);
export const publicUrl = async (u) => {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) return false;
  const h = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(?:localhost|.*\.local|.*\.internal|.*\.lan|.*\.home)$/i.test(h)) return false;
  try { const a = await lookup(h, { all: true }); return a.length > 0 && a.every((x) => !privateIp(x.address)); } catch { return false; }
};
const _qv = new Map();
const QV_UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" };
export const qvFor = async (u, check = publicUrl) => {
  const key = createHash("sha256").update(`qv\n${u}`).digest("hex").slice(0, 24);
  const hit = _qv.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  let v = null, at = u;
  for (let hop = 0; hop < 4; hop++) {
    if (!(await check(at))) { why("qv", "address not public (DNS)"); at = ""; break; }
    const r = await net(at, { timeout: 6000, max: 3_000_000, accept: "text/html,application/xhtml+xml", headers: QV_UA, redirect: "manual", imp: true });
    if (r.status >= 300 && r.status < 400 && r.location) { try { at = new URL(r.location, at).toString(); } catch { at = ""; break; } continue; }
    if (r.status === 200 && r.text) { v = qvFrom(r.text, at); why("qv", v ? `ok (${v.kind})` : "page has nothing to show"); }
    else why("qv", r.status >= 300 && r.status < 400 ? "redirect without address" : r.status ? `page http ${r.status}` : "no answer");
    break;
  }
  if (_qv.size > 300) _qv.clear();
  _qv.set(key, { t: v ? Date.now() : Date.now() - TTL + 600000, v });
  return v;
};

// Inline stars + time for first-screen recipe/review results (spec 11): "4.8 ★ · 45 min" from the same quick view.
// Asked by the page after the results are drawn, kept by the page for the next visit (never inserted late).
// Per-domain success counts (qv-domains.json: domain -> {ok, fail}) skip sites that block servers.
export const starLine = (v) => {
  if (!v) return "";
  const f = Object.fromEntries(v.facts);
  const r = f.Rating ? f.Rating.replace(/\s*\(.*\)$/, "") : "";
  return [r, v.kind === "recipe" ? f["Total time"] || "" : ""].filter(Boolean).join(" · ");
};
let _qd = null;
const qvDomains = () => { if (!_qd) { try { _qd = JSON.parse(fs.readFileSync(`${DIR}/qv-domains.json`, "utf8")) || {}; } catch { _qd = {}; } } return _qd; };
export const qvBlocked = (d) => { const c = qvDomains()[d]; return !!c && c.fail >= 3 && !c.ok; };
let _qdT = 0;
const qvCount = (d, ok) => {
  const m = qvDomains(), c = m[d] || (m[d] = { ok: 0, fail: 0 });
  if (ok) c.ok++; else c.fail++;
  const ks = Object.keys(m); if (ks.length > 2000) delete m[ks[0]];
  clearTimeout(_qdT); _qdT = setTimeout(() => { try { fs.writeFileSync(`${DIR}/qv-domains.json`, JSON.stringify(m)); } catch {} }, 2000);
};
export const starsFor = async (urls, check = publicUrl) => {
  const out = {};
  await Promise.all([...new Set(urls)].slice(0, 6).map(async (u) => {
    let d = "";
    try { d = new URL(u).hostname.replace(/^www\./, ""); } catch { return; }
    if (qvBlocked(d)) return;
    const v = await qvFor(u, check);
    qvCount(d, !!v);
    const line = starLine(v);
    if (line) out[u] = line;
  }));
  return out;
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
  const all = await Promise.all(LEAGUES.map(async ([l, tag]) => { const r = await net(`${ESPN}/${l}/teams`, { timeout: 4000, max: 3_000_000, accept: "application/json", headers: QV_UA, imp: true }); if (r.status !== 200) teamsList.last = r.status ? `http ${r.status}` : "no answer"; try { return r.status === 200 ? espnTeams(JSON.parse(r.text), l, tag) : []; } catch { teamsList.last = "not JSON"; return []; } }));
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
  if (!list.length) return why("sports", `ESPN team lists ${teamsList.last || "empty"}`);
  const t = teamFor(words, list);
  if (!t) return why("sports", "no single team matched");
  const hit = _games.get(t.id + t.league);
  if (hit && now - hit.t < (hit.v && hit.v.state === "in" ? 60000 : 600000)) return hit.v;
  const r = await net(`${ESPN}/${t.league}/teams/${t.id}/schedule`, { timeout: 4000, max: 5_000_000, accept: "application/json", headers: QV_UA, imp: true });
  let v = null;
  try {
    const evs = r.status === 200 ? JSON.parse(r.text).events : null;
    const ev = evs ? pickGame(evs, now) : null;
    const g = ev && espnGame(ev, _sign);
    if (g) v = { ...g, league: t.tag, team: t.abbr };
    why("sports", r.status !== 200 ? `ESPN schedule ${r.status ? `http ${r.status}` : "no answer"}` : !Array.isArray(evs) ? "schedule has no events list" : !ev ? `no game among ${evs.length} events` : !g ? "game has no two teams" : !(g.away.logo || g.home.logo) ? (_sign ? "no team logos" : "no image signer") : "ok");
  } catch (e) { why("sports", `error: ${String(e && e.message || e).slice(0, 80)}`); }
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
// Trending names: Wikipedia's 1,000 most-read articles of the last day count as known words, refreshed twice a day, so a
// name that is suddenly everywhere (a new person, show, game, product) is never "corrected" into a dictionary word.
// Only words are kept (trend.json: words + the time), no counts and nothing about your searches.
const TREND = new Set();
let trendAt = 0, trendLoaded = false;
const trendLoad = () => { if (trendLoaded) return; trendLoaded = true; try { const j = JSON.parse(fs.readFileSync(`${DIR}/trend.json`, "utf8")); for (const w of j.w || []) TREND.add(w); trendAt = Number(j.at) || 0; } catch {} };
export const trendWords = (titles) => {
  const out = new Set();
  for (const t of titles) {
    if (!t || /^(?:Main_Page|Special:|Wikipedia:|Portal:|Help:|File:|Category:|Template:|Talk:)/.test(t)) continue;
    for (const p of String(t).replace(/_\([^)]*\)$/, "").split(/[^\p{L}\p{N}]+/u)) { if (p.length >= 3 && !/^\d+$/.test(p) || (p.length === 2 && p === p.toUpperCase() && /\p{L}/u.test(p))) out.add(p.toLowerCase()); }
  }
  return [...out].slice(0, 6000);
};
const trendRefresh = async () => {
  trendLoad();
  if (Date.now() - trendAt < 20 * 3600000) return;
  for (const back of [1, 2, 3]) {
    const d = new Date(Date.now() - back * 86400000), pad = (n) => String(n).padStart(2, "0");
    const r = await net(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`, { timeout: 10000, accept: "application/json", headers: WD_UA });
    let titles = [];
    try { titles = JSON.parse(r.text).items[0].articles.map((a) => a.article); } catch {}
    const w = trendWords(titles);
    if (w.length >= 100) {
      TREND.clear(); for (const x of w) TREND.add(x); trendAt = Date.now();
      try { fs.writeFileSync(`${DIR}/trend.json.tmp`, JSON.stringify({ at: trendAt, w })); fs.renameSync(`${DIR}/trend.json.tmp`, `${DIR}/trend.json`); } catch {}
      return;
    }
  }
};
const trendSchedule = () => { trendLoad(); const run = () => trendRefresh().catch(() => {}); const a = setTimeout(run, 120000), b = setInterval(run, 12 * 3600000); if (a.unref) a.unref(); if (b.unref) b.unref(); };
const isName = (w) => NAMES.has(w) || TREND.has(w) || (learned.cap && learned.cap[w] || 0) >= 2;
// Settings > Clean Titles > "Typo fixer: learn words from my results" (off: nothing about your searches is stored or used)
let LEARN = false;
// Settings > Clean Titles: which of Sitelinks / Discussions / Videos / Top stories to show (all on unless turned off)
let SHOW = { sl: true, forum: true, video: true, news: true, ans: true, kp: true, img: true, qv: true, arch: true, mean: true, stars: true, plain: true, pw: true };
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
// Typo fixer data, fetched by the plugin itself the first time it's missing (spec: no one-time setup in the
// installer): SymSpell's English words and word pairs, then names from Wikipedia's article titles, made by
// names.js (shipped next to this file) in its own bun process so degoog never waits on it. Retried a day later
// if a download fails. Nothing about searches is sent anywhere.
const SYMSPELL = "https://raw.githubusercontent.com/wolfgarbe/SymSpell/master/SymSpell";
const DATA_FILES = [["words.txt", `${SYMSPELL}/frequency_dictionary_en_82_765.txt`, 50000], ["pairs.txt", `${SYMSPELL}/frequency_bigramdictionary_en_243_342.txt`, 200000]];
const hasFile = (f) => { try { return fs.statSync(`${DIR}/${f}`).size > 0; } catch { return false; } };
let _dataRun = null;
export const ensureData = (spawn = (cmd) => Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" })) => (_dataRun ||= (async () => {
  let got = false;
  for (const [f, url, minLines] of DATA_FILES) {
    if (hasFile(f)) continue;
    const r = await net(url, { timeout: 120000, max: 20_000_000, accept: "text/plain" });
    if (r.status === 200 && r.text.split("\n").length >= minLines) { try { fs.writeFileSync(`${DIR}/${f}.tmp`, r.text); fs.renameSync(`${DIR}/${f}.tmp`, `${DIR}/${f}`); got = true; } catch {} }
  }
  if (got) { loaded = false; WORDS.clear(); PAIRS.clear(); TOTAL = 0; PTOTAL = 0; } // read again on next use
  if (hasFile("words.txt") && !hasFile("names.txt") && hasFile("names.js")) { try { await spawn(["bun", `${DIR}/names.js`]).exited; loaded = false; NAMES.clear(); } catch {} }
  const ok = DATA_FILES.every(([f]) => hasFile(f));
  if (!ok) setTimeout(() => { _dataRun = null; }, 86400000).unref?.();
  return ok;
})());
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
// Bing answering with nothing at all (204, blocked, error) means it's down for this server: skip it for a while,
// backing off exponentially from 1 minute (1, 2, 4 … capped at 1 hour), reset by the first good answer (spec 15)
let bingDownUntil = 0, bingDowns = 0;
export const bingBackoff = (n) => Math.min(60000 * 2 ** Math.max(0, n - 1), 3600000);
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
      if (r.ok && r.status !== 204) { const j = JSON.parse(await r.text()); if (Array.isArray(j) && Array.isArray(j[1])) { if (isBing) bingDowns = 0; s = j[1].filter((x) => typeof x === "string"); if (s.length) break got; } }
    } catch { if (isBing) bingBad++; }
    if (isBing && bingTries && bingBad === bingTries && bingTries >= 2 && Date.now() >= bingDownUntil) bingDownUntil = Date.now() + bingBackoff(++bingDowns);
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
  const known = (w) => WORDS.has(w) || NAMES.has(w) || TREND.has(w) || (learned.w[w] || 0) >= 2 || !!learned.keep[w] || extra.has(w);
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

// Image AI (ct-vision container next to degoog, SigLIP 2 on the GPU): how well each image shows the search, and which
// images look alike. Down or missing -> null, and the page just keeps its word rule.
const VIS = process.env.CT_VISION_URL || "http://ct-vision:8077";
let visDownUntil = 0;
const vis = async (path, body, ms) => {
  if (Date.now() < visDownUntil) return null;
  try {
    const r = await fetch(VIS + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch (e) { if (!(e && e.name === "TimeoutError")) visDownUntil = Date.now() + 60000; return null; }
};
const jsonOut = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// Results hook (installed into degoog's search step by inline.js): before a web/Forums/News/Science search is sent,
// the answer AI (reranker on the GPU) scores every result for how well it fits the search (ctRel, 0..1), and for
// question-like searches each top result's best sentence (ctBest {s, p}) for the featured snippet. 1.6 s wait (a slower answer is kept for the next request);
// no AI or too slow -> results go out unchanged and the page uses its word rules. Same search again: from memory.
const AIC = new Map();
const stripT = (t) => String(t || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const sentences = (t) => stripT(t).replace(/^[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}\s*(?:\.\.\.|…|·|-|—)\s*/, "").split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/).map((x) => x.trim()).filter((x) => x.length >= 25 && x.length <= 400 && !/(?:\.\.\.|…)$/.test(x));
const QLIKE = /\?\s*$|^(?:what|whats|what's|how|who|whom|whose|when|where|why|which|is|are|was|were|can|could|does|do|did|should|will|would)\b/i;
// doi.org results show the publisher, not "doi.org": the page knows ~40 big publishers by DOI prefix; any other prefix
// is looked up here in Crossref's prefix list (10.xxxx -> owner name), once per prefix, kept in doi-prefixes.json
// (prefix and name only) and added to the results (ctPub) before they leave the server, so it is there at first paint.
const DOIP = new Map(), DOI_MISS = new Map();
let doiLoaded = false;
const doiLoad = () => { if (doiLoaded) return; doiLoaded = true; try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(`${DIR}/doi-prefixes.json`, "utf8")))) if (typeof v === "string" && v) DOIP.set(k, v); } catch {} };
const doiSave = () => { try { fs.writeFileSync(`${DIR}/doi-prefixes.json.tmp`, JSON.stringify(Object.fromEntries(DOIP))); fs.renameSync(`${DIR}/doi-prefixes.json.tmp`, `${DIR}/doi-prefixes.json`); } catch {} };
export const doiNice = (n) => {
  let t = String(n || "").replace(/\s+/g, " ").trim();
  const a = /\(([A-Z][A-Za-z0-9&.-]{1,9})\)\s*$/.exec(t);
  if (a) return a[1];
  t = t.replace(/\s*\([^)]*\)\s*$/, "").replace(/[,\s]+(?:B\.?V\.?|Ltd\.?|Limited|Inc\.?|LLC|L\.L\.C\.|GmbH|AG|S\.?A\.?|Co\.?|Corp\.?|Corporation|Verlag)$/i, "").trim();
  return t.slice(0, 40);
};
export const doiPrefixOf = (url) => { try { const u = new URL(url); if (!/^(?:dx\.)?doi\.org$/.test(u.hostname.replace(/^www\./, ""))) return ""; const m = /^\/(10\.\d{4,9})\//.exec(decodeURIComponent(u.pathname)); return m ? m[1] : ""; } catch { return ""; } };
const doiAsk = async (p) => {
  if (DOIP.has(p) || (DOI_MISS.get(p) || 0) > Date.now()) return;
  const r = await net(`https://api.crossref.org/prefixes/${encodeURIComponent(p)}`, { timeout: 4000, accept: "application/json", headers: WD_UA });
  let name = "";
  try { name = doiNice(JSON.parse(r.text).message.name); } catch {}
  if (name) { DOIP.set(p, name); doiSave(); } else DOI_MISS.set(p, Date.now() + 3600000);
};
const doiNames = async (rs) => {
  doiLoad();
  const need = new Set();
  for (const r of rs) { const p = doiPrefixOf(r.url); if (p && !DOIP.has(p)) need.add(p); }
  if (need.size) await Promise.race([Promise.all([...need].slice(0, 12).map((p) => doiAsk(p).catch(() => {}))), new Promise((r) => { const t = setTimeout(r, 900); if (t.unref) t.unref(); })]);
  let n = 0;
  for (const r of rs) { const p = doiPrefixOf(r.url); if (p && DOIP.has(p)) { r.ctPub = DOIP.get(p); n++; } }
  return n;
};
// ===== ⚑ Flags: "what's wrong with these results?" from the ⚑ in the tab row =====
// Save in the ⚑ box keeps each flag (the search, the tab, your note, its top 10 results) in flags.json on this
// server only. The local model (flagJudge) decides when what's waiting is worth a Claude session; the PC's hourly job
// then sends it all in one (core flagPrompt), plus the updater's last problem (update-issue.txt, sent at once).
const flagsFile = () => `${DIR}/flags.json`, issueFile = () => `${DIR}/update-issue.txt`;
let FLAGS = null;
const readFlags = () => { if (FLAGS) return FLAGS; try { const j = JSON.parse(fs.readFileSync(flagsFile(), "utf8")); FLAGS = j && Array.isArray(j.list) ? j : { list: [], issueAt: 0 }; } catch { FLAGS = { list: [], issueAt: 0 }; } return FLAGS; };
const saveFlags = () => { try { fs.writeFileSync(`${flagsFile()}.tmp`, JSON.stringify(FLAGS)); fs.renameSync(`${flagsFile()}.tmp`, flagsFile()); } catch {} };
const flagIssue = () => { try { const st = fs.statSync(issueFile()); const t = st.mtimeMs; const text = fs.readFileSync(issueFile(), "utf8").trim(); return text && t > (readFlags().issueAt || 0) ? { t, text: text.slice(-3000) } : null; } catch { return null; } };
const flagOpen = () => readFlags().list.filter((f) => !f.handed);
// Same as core.js FLAG_CATS / flagCats / flagCtxClean (test/flag.test.js checks they agree)
export const FLAG_CATS = [["offtopic", "Off-topic"], ["spam", "Spam / junk"], ["missing", "Missing what I wanted"], ["outdated", "Outdated"],
  ["order", "Wrong order"], ["layout", "Layout looks off"], ["broken", "Something's broken or slow"]];
export const flagCats = (a) => { const ok = new Set(FLAG_CATS.map((c) => c[0])); return [...new Set((Array.isArray(a) ? a : []).map(String))].filter((c) => ok.has(c)); };
// Context sent with each flag, clipped to sane sizes: {vw, vh, dpr, phone, load: {name: ms}, boxes: [{box, n}]}
export const flagCtxClean = (c) => {
  if (!c || typeof c !== "object") return null;
  const num = (v, max = 1e6) => (Number.isFinite(+v) ? Math.max(0, Math.min(max, Math.round(+v))) : null);
  const load = {};
  for (const [k, v] of Object.entries(c.load && typeof c.load === "object" ? c.load : {}).slice(0, 12)) { const n = num(v, 600000); if (n !== null) load[String(k).slice(0, 40)] = n; }
  const boxes = (Array.isArray(c.boxes) ? c.boxes : []).slice(0, 30).map((b) => ({ box: String((b && b.box) || "").slice(0, 60), n: num(b && b.n, 999) || 1 })).filter((b) => b.box);
  return { ver: String(c.ver || "").slice(0, 20), vw: num(c.vw, 10000), vh: num(c.vh, 10000), dpr: Number.isFinite(+c.dpr) ? Math.round(+c.dpr * 100) / 100 : null, phone: !!c.phone, load, boxes };
};

// Same as core.js flagPrompt (test/flag.test.js checks they agree): the text a Claude Code session opens with
export const flagPromptS = (flags, issue, max = 12000) => {
  const head = "degoog clean-titles: fix what my degoog reported. Read degoog/wip/QUICKSTART.md in acqcath/scripts first and follow its \"Flags\" steps: " +
    "commit the flags below to the private repo acqcath/degoog-flags, then fix the code so these searches come out right, release and merge. " +
    "Keep my searches out of the public repo.\n";
  const body = (fl, snip) => JSON.stringify({ flags: fl.map((f) => ({ at: new Date(f.t).toISOString(), q: f.q, tab: f.type, cats: f.cats || [], note: f.note, ctx: f.ctx || null, top: (f.top || []).map((r) => (snip ? { ai: r.ai ?? null, title: r.title, url: r.url, snippet: r.snippet } : { ai: r.ai ?? null, title: r.title, url: r.url })) })), updateIssue: issue || null });
  let fl = (flags || []).slice(-20);
  for (;;) {
    for (const snip of [true, false]) { const s = head + body(fl, snip); if (s.length <= max || fl.length <= 1) { if (s.length <= max || !snip) return s.slice(0, max); } }
    if (fl.length <= 1) return (head + body(fl, false)).slice(0, max);
    fl = fl.slice(1);
  }
};
// The model ai-summary is set to (on this PC, free), called through ai-summary's own provider code, so every
// provider it supports works here with its URL, key and model. null when ai-summary isn't installed or has no model.
const aiAsk = async (messages, maxTokens = 1500) => {
  const data = process.env.DEGOOG_DATA_DIR || `${process.cwd()}/data`;
  let all = {};
  try { all = JSON.parse(fs.readFileSync(process.env.DEGOOG_PLUGIN_SETTINGS_FILE || `${data}/plugin-settings.json`, "utf8")) || {}; } catch { return null; }
  const k = Object.keys(all).find((x) => x.toLowerCase() === "ai-summary-slot") || Object.keys(all).find((x) => /ai-summary/i.test(x));
  const raw = k && all[k];
  if (!raw || !String(raw.model || "").trim()) return null;
  const root = DIR.replace(/\/[^/]+\/?$/, "");
  let dir = "";
  try { dir = fs.readdirSync(root).find((d) => /ai-summary/i.test(d) && fs.existsSync(`${root}/${d}/providers/index.js`) && fs.existsSync(`${root}/${d}/src/settings.js`)) || ""; } catch {}
  if (!dir) return null;
  let P, S;
  try { P = await import(`${root}/${dir}/providers/index.js`); S = await import(`${root}/${dir}/src/settings.js`); } catch { return null; }
  if (typeof P.pickAdapter !== "function" || typeof S.parseSettings !== "function") return null;
  const st = S.parseSettings(raw);
  const ad = P.pickAdapter(st.provider, st.openAICompatProvider);
  const ab = new AbortController();
  const t = setTimeout(() => ab.abort(), 90000);
  let out = "";
  try {
    for await (const ch of ad.stream({ baseUrl: st.baseUrl, model: st.model, apiKey: st.apiKey, extraHeaders: st.extraHeaders, sessionId: "degoog-ctflag" }, messages, { maxTokens, disableThinking: true, tokenParam: st.tokenParam, signal: ab.signal })) {
      if (ch.kind === "text") out += ch.text;
      else if (ch.kind === "error") return null;
    }
  } catch { return null; } finally { clearTimeout(t); }
  return out;
};
// Is what's waiting worth a Claude session (which uses the user's weekly Claude usage)? The local model decides once
// per new set of reports; the PC's hourly job sends only on yes (or at once for an update breakage).
const JUDGE_SYS = "You decide whether a batch of user reports about their self-hosted search engine is worth sending to an expensive " +
  "coding assistant now, which uses up the user's limited weekly usage. Say send when the reports show real problems a code " +
  "change would fix (wrong, junk, missing or badly ordered results; a broken feature) and together they are enough work to " +
  "justify one session: several reports, or one serious or clearly systematic problem. Say wait when they are few and minor, " +
  "vague, or about one-off content no rule could fix, so more reports can join the batch. Reply with JSON only: " +
  '{"send": true or false, "why": "one short plain sentence for the user"}.';
export const judgeParse = (txt) => {
  const m = /\{[\s\S]*\}/.exec(String(txt || ""));
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return typeof j.send === "boolean" ? { send: j.send, why: String(j.why || "").replace(/\s+/g, " ").trim().slice(0, 200) } : null; } catch { return null; }
};
const flagHost = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
let _judging = null;
const flagJudge = () => (_judging ||= (async () => {
  const F = readFlags(), open = flagOpen();
  const key = open.map((f) => f.id).join(",");
  if (!open.length) return { send: false, why: "" };
  if (F.judge && F.judge.key === key) return F.judge;
  const list = open.map((f, i) => `${i + 1}. [${f.type}] "${f.q}"${(f.cats || []).length ? ` problems: ${f.cats.join(", ")}` : ""}${f.note ? ` note: ${f.note}` : " (no note)"}; top results: ${f.top.slice(0, 3).map((r) => `${flagHost(r.url)}: ${r.title}`).join(" | ")}`).join("\n");
  const v = judgeParse(await aiAsk([{ role: "system", content: JUDGE_SYS }, { role: "user", content: `Waiting reports (${open.length}):\n${list}` }]));
  F.judge = { key, send: v ? v.send : false, why: v ? v.why : "No local model answered (ai-summary's model), so these wait.", at: Date.now() };
  saveFlags();
  return F.judge;
})().finally(() => { _judging = null; }));
const judgeNow = () => { const F = readFlags(), key = flagOpen().map((f) => f.id).join(","); return F.judge && F.judge.key === key ? F.judge : null; };
const flagCount = () => flagOpen().length + (flagIssue() ? 1 : 0);

// ===== What a search needs (user, 2026-11-26): ONE batched reranker pass per search, before the results arrive, so
// the page can fetch and place blocks (Videos, Images, Forums, Top stories, Papers, info panel, answer card) on one
// scale with the results. Each question is a described option scored with its own instruction; no word lists.
// Groups: f = format shares (sum 1), n = needs (each 0..1, independent), b = block fits (each 0..1). Cached per search.
const NEED_TASK = "Given a web search query, judge whether the searcher needs this to be satisfied";
const FMT_TASK = "Given a web search query, judge whether this kind of result is the best way to give the searcher what they need";
const SHAPE_TASK = "Given a web search query, judge whether an answer in this shape would serve the searcher best";
const BLOCK_TASK = "Given a web search query, judge whether this block of results would help the searcher";
export const NEEDS = {
  f: [FMT_TASK, { video: "A video that shows it being done or demonstrated, step by step, in motion", image: "Pictures, photos, diagrams or charts that show what it looks like", text: "A written web page that explains or answers it in words" }],
  n: [NEED_TASK, { fresh: "Recent information: what is new, current or happening now", depth: "An in-depth, thorough explanation rather than a quick fact", trust: "An authoritative, expert or official source the searcher can rely on",
    people: "First-hand experiences and opinions from real people who tried it", doing: "Instructions to do or make something", knowing: "Information or an answer to understand or know something",
    question: "A direct answer to a specific question" }],
  b: [BLOCK_TASK, { forums: "Forum and discussion threads where people share their own experience", news: "Top news stories reporting recent events", papers: "Scientific papers and research studies",
    info: "A fact panel about one person, place, organization or thing", answer: "A short direct answer shown above the results",
    web: "A list of ordinary web pages about it" }],
  s: [SHAPE_TASK, { steps: "Numbered steps to follow in order", compare: "A side-by-side table comparing two or more options", timeline: "A timeline of dates and events in order",
    chart: "A chart of numbers, amounts or shares", plain: "A short written summary paragraph" }],
};
export const needsParse = (s) => {
  let i = 0;
  const out = {};
  for (const [g, [, opts]] of Object.entries(NEEDS)) {
    out[g] = {};
    for (const k of Object.keys(opts)) { const v = s[i++]; if (typeof v !== "number") return null; out[g][k] = v; }
  }
  for (const g of ["f", "s"]) { const t = Object.values(out[g]).reduce((a, b) => a + b, 0); if (t > 0) for (const k of Object.keys(out[g])) out[g][k] /= t; }
  return out;
};
// First-screen cutoff (M2): the worth (text share x AI score) of the last result each page showed on its first screen,
// last 200 searches, kept in cut.json on this server. Its median decides which blocks are worth fetching (core blockGo).
const cutFile = () => `${DIR}/cut.json`;
let CUTS = null;
const readCuts = () => { if (CUTS) return CUTS; try { const j = JSON.parse(fs.readFileSync(cutFile(), "utf8")); CUTS = Array.isArray(j) ? j.filter((x) => typeof x === "number") : []; } catch { CUTS = []; } return CUTS; };
export const cutAdd = (w) => { w = +w; if (!Number.isFinite(w) || w < 0 || w > 1) return false; const c = readCuts(); c.push(Math.round(w * 1e4) / 1e4); if (c.length > 200) c.splice(0, c.length - 200); try { fs.writeFileSync(`${cutFile()}.tmp`, JSON.stringify(c)); fs.renameSync(`${cutFile()}.tmp`, cutFile()); } catch {} return true; };
export const cutNow = () => { const v = [...readCuts()].sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
export const _cutReset = () => { CUTS = null; };
const NEEDC = new Map(), NEEDI = new Map();
export const needsFor = async (q) => {
  q = String(q || "").trim().slice(0, 300);
  if (!q || q.startsWith("!")) return null;
  const k = q.toLowerCase();
  if (NEEDC.has(k)) return NEEDC.get(k);
  if (NEEDI.has(k)) return NEEDI.get(k);
  const run = (async () => {
    const docs = [], tasks = [];
    for (const [task, opts] of Object.values(NEEDS)) for (const d of Object.values(opts)) { docs.push(d); tasks.push(task); }
    const j = await vis("/rank", { q, docs, tasks }, 1500);
    const v = j && Array.isArray(j.s) && j.s.length === docs.length ? needsParse(j.s) : null;
    if (v) { v.ms = j.ms; NEEDC.set(k, v); if (NEEDC.size > 2000) NEEDC.delete(NEEDC.keys().next().value); }
    return v;
  })().finally(() => NEEDI.delete(k));
  NEEDI.set(k, run);
  return run;
};

// ===== M4: the answer card's shape and the contested check, both written by ai-summary's model (aiAsk) =====
// The needs call picks the shape (s: steps / compare / timeline / chart / plain); /shape asks the model to answer
// in that shape from the top results only (JSON, checked here); /sides asks whether credible results disagree.
const SHAPE_SYS = {
  steps: 'Answer with the steps to do it, in order, each one short imperative sentence, at most 8. JSON only: {"steps": ["...", "..."], "src": [result numbers used]}',
  compare: 'Answer with a comparison table of the options the search names (2 to 4 columns), at most 6 rows of aspects, each cell a few words. JSON only: {"cols": ["Option A", "Option B"], "rows": [["aspect", "A value", "B value"]], "src": [result numbers used]}',
  timeline: 'Answer with the key dates and events in time order, at most 8, each event a few words. JSON only: {"events": [["date", "event"]], "src": [result numbers used]}',
  chart: 'Answer with the numbers asked about as a bar chart, at most 8 bars, all in one unit. JSON only: {"unit": "unit", "bars": [["label", number]], "src": [result numbers used]}',
};
const SHAPE_HEAD = "You answer a web search using ONLY the numbered search results given. Never add facts they don't state. If they don't contain what the shape needs, reply {}. ";
const cell = (x, n = 80) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, n);
export const shapeParse = (k, txt, nres) => {
  const m = /\{[\s\S]*\}/.exec(String(txt || ""));
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const src = (Array.isArray(j.src) ? j.src : []).map((i) => Math.round(+i) - 1).filter((i) => i >= 0 && i < nres).slice(0, 4);
  if (k === "steps") { const a = (Array.isArray(j.steps) ? j.steps : []).map((x) => cell(x, 160)).filter(Boolean).slice(0, 8); return a.length >= 2 ? { k, steps: a, src } : null; }
  if (k === "compare") {
    const cols = (Array.isArray(j.cols) ? j.cols : []).map((x) => cell(x, 40)).filter(Boolean).slice(0, 4);
    const rows = (Array.isArray(j.rows) ? j.rows : []).filter((r) => Array.isArray(r) && r.length === cols.length + 1).map((r) => r.map((x) => cell(x))).slice(0, 6);
    return cols.length >= 2 && rows.length >= 2 ? { k, cols, rows, src } : null;
  }
  if (k === "timeline") { const e = (Array.isArray(j.events) ? j.events : []).filter((r) => Array.isArray(r) && r.length >= 2).map((r) => [cell(r[0], 30), cell(r[1], 120)]).filter((r) => r[0] && r[1]).slice(0, 8); return e.length >= 2 ? { k, events: e, src } : null; }
  if (k === "chart") { const b = (Array.isArray(j.bars) ? j.bars : []).filter((r) => Array.isArray(r) && r.length >= 2 && Number.isFinite(+r[1]) && +r[1] >= 0).map((r) => [cell(r[0], 40), +r[1]]).filter((r) => r[0]).slice(0, 8); return b.length >= 2 && b.some((r) => r[1] > 0) ? { k, unit: cell(j.unit, 20), bars: b, src } : null; }
  return null;
};
const SIDES_SYS = "You check whether credible sources disagree about the answer to a search question. Use ONLY the numbered search results given. " +
  "Say split only when at least one credible result (an expert, official, scientific or established news source) on EACH side clearly states a conflicting answer; " +
  "different emphasis, extra detail or one fringe page is not a split. JSON only: {\"split\": false} or " +
  '{"split": true, "a": {"claim": "one short sentence", "src": [result numbers]}, "b": {"claim": "one short sentence", "src": [result numbers]}}';
export const sidesParse = (txt, nres) => {
  const m = /\{[\s\S]*\}/.exec(String(txt || ""));
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  if (j.split !== true) return { split: false };
  const side = (x) => { const src = [...new Set((x && Array.isArray(x.src) ? x.src : []).map((i) => Math.round(+i) - 1).filter((i) => i >= 0 && i < nres))].slice(0, 3); const claim = cell(x && x.claim, 200); return claim && src.length ? { claim, src } : null; };
  const a = side(j.a), b = side(j.b);
  return a && b && !a.src.some((i) => b.src.includes(i)) ? { split: true, a, b } : { split: false };
};
const resText = (rs) => rs.map((r, i) => `${i + 1}. ${cell(r.t, 200)} (${(() => { try { return new URL(r.u).hostname.replace(/^www\./, ""); } catch { return ""; } })()}): ${cell(r.s, 400)}`).join("\n");
const resIn = (b) => (Array.isArray(b.r) ? b.r : []).slice(0, 8).map((r) => ({ t: String((r && r.t) || ""), s: String((r && r.s) || ""), u: /^https?:\/\//.test(String((r && r.u) || "")) ? String(r.u) : "" })).filter((r) => r.t && r.u);
const SHC = new Map();
const cached = (k, run) => { if (SHC.has(k)) return SHC.get(k); const p = run().then((v) => { if (v === undefined) SHC.delete(k); return v; }); SHC.set(k, p); if (SHC.size > 500) SHC.delete(SHC.keys().next().value); return p; };
export const shapeFor = (q, k, rs) => (!SHAPE_SYS[k] || rs.length < 2 ? Promise.resolve(null) : cached(`s|${k}|${q.toLowerCase()}|${rs.map((r) => r.u).join("|")}`, async () => {
  const t = await aiAsk([{ role: "system", content: SHAPE_HEAD + SHAPE_SYS[k] }, { role: "user", content: `Search: ${q}\n\nResults:\n${resText(rs)}` }], 700);
  return t == null ? undefined : shapeParse(k, t, rs.length); // no model answer: not cached
}));
export const sidesFor = (q, rs) => (rs.length < 2 ? Promise.resolve(null) : cached(`b|${q.toLowerCase()}|${rs.map((r) => r.u).join("|")}`, async () => {
  const t = await aiAsk([{ role: "system", content: SIDES_SYS }, { role: "user", content: `Search: ${q}\n\nResults:\n${resText(rs)}` }], 400);
  return t == null ? undefined : sidesParse(t, rs.length);
}));

// A slow answer is never thrown away: the rank call keeps running past the wait below and fills AIC when it lands, so
// the very next request for the same results (a tab switch, a reload) already has it. Same request twice at once
// shares one run (INFL).
const INFL = new Map();
const RANK_WAIT_MS = 1600, RANK_RUN_MS = 6000;
globalThis.__ctResults = async (result, query, params) => {
  const type = String((params && params.type) || "web");
  if (!result || !Array.isArray(result.results) || !query || type === "videos") return;
  const q = String(query).trim().slice(0, 300);
  const rs = result.results.slice(0, 60);
  if (!rs.length || q.startsWith("!")) return;
  try { if (await doiNames(result.results)) result.ctPub = 1; } catch {}
  const key = `${type}|${q}|${rs.map((r) => r.url).join("|")}`;
  let got = AIC.get(key);
  if (!got) {
    let run = INFL.get(key);
    if (!run) {
      const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
      const docs = rs.map((r) => (type === "images" ? `${stripT(r.title)}. Picture from ${host(r.url)}` : `${stripT(r.title)}. ${stripT(r.snippet)}`).slice(0, 1200));
      const sents = [];
      if (type === "web" && (QLIKE.test(q) || q.split(/\s+/).length >= 2)) rs.slice(0, 6).forEach((r, i) => sentences(r.snippet).slice(0, 4).forEach((x) => sents.push([i, x])));
      run = (async () => {
        const j = await vis("/rank", { q, docs: docs.concat(sents.map(([, x]) => x)) }, RANK_RUN_MS);
        if (!j || !Array.isArray(j.s)) return null;
        const g = { rel: j.s.slice(0, docs.length), best: {} };
        sents.forEach(([i, x], k) => { const v = j.s[docs.length + k]; if (typeof v === "number" && (!g.best[i] || v > g.best[i].p)) g.best[i] = { s: x, p: v }; });
        AIC.set(key, g);
        if (AIC.size > 500) AIC.delete(AIC.keys().next().value);
        return g;
      })().finally(() => INFL.delete(key));
      INFL.set(key, run);
    }
    got = await Promise.race([run, new Promise((r) => { const t = setTimeout(() => r(null), RANK_WAIT_MS); if (t.unref) t.unref(); })]);
    if (!got) return;
  }
  rs.forEach((r, i) => { if (typeof got.rel[i] === "number") r.ctRel = got.rel[i]; if (got.best[i]) r.ctBest = got.best[i]; });
  result.ctAi = 1;
};

export const routes = [
  {
    // ⚑ Save: {q, type, cats, note, ctx, top: [{title, url, snippet}]} is kept until you send -> {n: how many wait}
    method: "post",
    path: "/flag",
    async handler(req) {
      let b = {};
      try { b = await req.json(); } catch {}
      const q = String(b.q || "").trim().slice(0, 300);
      if (!q) return jsonOut({ n: flagCount() });
      const F = readFlags(), now = Date.now();
      F.list.push({ id: now, t: now, q, type: String(b.type || "web").slice(0, 40), cats: flagCats(b.cats), note: String(b.note || "").trim().slice(0, 1000), ctx: flagCtxClean(b.ctx),
        top: (Array.isArray(b.top) ? b.top : []).slice(0, 10).map((r) => ({ ai: r && Number.isFinite(+r.ai) && r.ai !== null ? Math.max(0, Math.min(1, +r.ai)) : null, title: String((r && r.title) || "").slice(0, 200), url: String((r && r.url) || "").slice(0, 500), snippet: String((r && r.snippet) || "").slice(0, 300) })).filter((r) => /^https?:\/\//.test(r.url)) });
      if (F.list.length > 500) F.list = F.list.slice(-500);
      saveFlags();
      flagJudge().catch(() => {});
      return jsonOut({ n: flagCount() });
    },
  },
  {
    // ⚑ What's waiting: {flags, issue: the updater's last problem}; ?sent=1 (the Send tap) marks it all as sent
    method: "post",
    path: "/flags",
    async handler(req) {
      const open = flagOpen(), i = flagIssue();
      if (new URL(req.url).searchParams.get("sent") === "1") {
        const F = readFlags(), now = Date.now();
        for (const f of open) f.handed = now;
        if (i) F.issueAt = i.t;
        saveFlags();
        return jsonOut({ flags: [], issue: "" });
      }
      // The PC's hourly job (../autoupdate-job.ps1 SendReports): the prompt itself, with no " or \ in it, because
      // Windows PowerShell mangles those in arguments to programs
      const jd = open.length ? await flagJudge().catch(() => null) : null;
      if (new URL(req.url).searchParams.get("prompt") === "1") return jsonOut({ n: open.length + (i ? 1 : 0), issue: !!i, send: !!i || !!(jd && jd.send), why: jd ? jd.why : "", prompt: flagPromptS(open, i ? i.text : "").replace(/["\\]/g, "'") });
      return jsonOut({ flags: open, issue: i ? i.text : "", send: !!(jd && jd.send), why: jd ? jd.why : "" });
    },
  },
  {
    // Image AI: {q, u: [image addresses]} -> {p: [0..1 or null]} (how well each picture shows the search)
    method: "post",
    path: "/vis",
    async handler(req) {
      let b = {};
      try { b = await req.json(); } catch {}
      const q = String(b.q || "").slice(0, 200), urls = Array.isArray(b.u) ? b.u.slice(0, 300).map(String) : [];
      const j = await vis("/score", { q, urls, budget: 1.6 }, 2500);
      return jsonOut(j && Array.isArray(j.p) ? { p: j.p, ms: j.ms, d: j.device } : { p: null });
    },
  },
  {
    // What this search needs: {n: {f, n, b, ms, cut}} (null when the AI is off); one batched GPU pass, cached per search
    method: "get",
    path: "/needs",
    async handler(req) { const n = await needsFor(new URL(req.url).searchParams.get("q") || ""); return jsonOut({ n: n ? { ...n, cut: cutNow() } : null }); },
  },
  {
    // Answer card in a shape (M4): body {q, k: steps|compare|timeline|chart, r: [{t, s, u}]} -> {a: shaped answer or null}
    method: "post",
    path: "/shape",
    async handler(req) { let b = {}; try { b = await req.json(); } catch {} const q = String(b.q || "").trim().slice(0, 300); return jsonOut({ a: q ? (await shapeFor(q, String(b.k || ""), resIn(b))) || null : null }); },
  },
  {
    // Contested check (M4): body {q, r: [{t, s, u}]} -> {d: {split, a: {claim, src}, b: {claim, src}} or null}
    method: "post",
    path: "/sides",
    async handler(req) { let b = {}; try { b = await req.json(); } catch {} const q = String(b.q || "").trim().slice(0, 300); return jsonOut({ d: q ? (await sidesFor(q, resIn(b))) || null : null }); },
  },
  {
    // First-screen cutoff sample from the page: {w: worth of the last result on its first screen} -> {cut: median}
    method: "get",
    path: "/cut",
    async handler(req) { cutAdd(new URL(req.url).searchParams.get("w")); return jsonOut({ cut: cutNow() }); },
  },
  {
    // Answer AI: {q, d: [passages]} -> {s: [0..1 or null]} (how well each passage answers the question)
    method: "post",
    path: "/rank",
    async handler(req) {
      let b = {};
      try { b = await req.json(); } catch {}
      const j = await vis("/rank", { q: String(b.q || "").slice(0, 300), docs: Array.isArray(b.d) ? b.d.slice(0, 64).map(String) : [] }, 3000);
      return jsonOut(j && Array.isArray(j.s) ? { s: j.s } : { s: null });
    },
  },
  {
    // Image AI: {u: opened image, us: others} -> {sim: [-1..1 or null]} (how alike they look)
    method: "post",
    path: "/near",
    async handler(req) {
      let b = {};
      try { b = await req.json(); } catch {}
      const j = await vis("/near", { url: String(b.u || ""), urls: Array.isArray(b.us) ? b.us.slice(0, 300).map(String) : [], budget: 1 }, 1800);
      return jsonOut(j && Array.isArray(j.sim) ? { sim: j.sim } : { sim: null });
    },
  },
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
      return new Response(JSON.stringify({ sites, auto: autoList().filter((d) => sites[d] === "lower"), seo: SEO_ON, ai: aiStatus(data), flags: flagCount(), flagDue: !!flagIssue() || !!(judgeNow() && judgeNow().send), fx: readFx().rates ? { date: FX.date, rates: FX.rates } : null }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  },
  {
    // Self-check only: why the last lookup of each kind came back empty (feature reasons, never search words)
    method: "get",
    path: "/why",
    handler: () => new Response(JSON.stringify({ why: WHY }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }),
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
    path: "/qv",
    async handler(req) {
      const u = (new URL(req.url).searchParams.get("u") || "").slice(0, 2000);
      return new Response(JSON.stringify({ v: u ? await qvFor(u) : null }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  },
  {
    method: "post",
    path: "/qvs",
    async handler(req) {
      let u = [];
      try { const j = await req.json(); if (Array.isArray(j.u)) u = j.u.filter((x) => typeof x === "string" && x.length < 2000); } catch {}
      return new Response(JSON.stringify({ s: await starsFor(u) }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  },
  {
    method: "get",
    path: "/arch",
    async handler(req) {
      const p = new URL(req.url).searchParams;
      return new Response(JSON.stringify({ a: await archFind((p.get("u") || "").slice(0, 2000), p.get("pw") === "1") }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
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
    // Page-load timings from the page (milliseconds only), last 60 kept in perf.json for the installer's self-check
    method: "post",
    path: "/perf",
    async handler(req) {
      try {
        const j = await req.json();
        const num = (o) => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o).filter(([k, v]) => /^[a-z]{2,10}$/.test(k) && (typeof v === "number" || typeof v === "boolean" || (k === "type" && typeof v === "string" && v.length < 20)))) : null);
        const e = { t: Date.now(), dev: j.dev === "phone" ? "phone" : "pc", nav: num(j.nav), search: num(j.search) };
        let list = [];
        try { list = JSON.parse(fs.readFileSync(`${DIR}/perf.json`, "utf8")); } catch {}
        list = (Array.isArray(list) ? list : []).concat([e]).slice(-60);
        fs.writeFileSync(`${DIR}/perf.json`, JSON.stringify(list));
      } catch {}
      return new Response(null, { status: 204 });
    },
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
    // A YouTube video's own still (every video has hqdefault), signed for degoog's image proxy; the page asks only
    // for video cards whose result came without a working picture. Only an 11-character video id is accepted.
    method: "get",
    path: "/yt",
    handler(req) {
      const id = new URL(req.url).searchParams.get("id") || "";
      if (!/^[\w-]{11}$/.test(id)) return new Response("bad id", { status: 400 });
      if (!_sign) return new Response("not ready", { status: 503 });
      return new Response(null, { status: 302, headers: { Location: _sign(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`), "Cache-Control": "public, max-age=86400" } });
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
  description: (PAGE_MISSING ? "Run the installer again: a degoog update removed this plugin's page part, so it is off on the results page until then. " : "") + "Google-style result titles, and sharper news and video thumbnails.",
  trigger: "cleantitles",
  aliases: ["ct"],
  settingsSchema: [
    { key: "showSitelinks", label: "Sitelinks", type: "toggle", default: true, description: "The top result's other pages as links under it." },
    { key: "showDiscussions", label: "Discussions and forums", type: "toggle", default: true, description: "Reddit, Stack Overflow and forum threads from your results in one box." },
    { key: "showVideos", label: "Videos", type: "toggle", default: true, description: "Video results as a row of cards." },
    { key: "showTopStories", label: "Top stories", type: "toggle", default: true, description: "Fresh news cards when your results look like news (one extra News search)." },
    { key: "showAnswers", label: "Instant answers", type: "toggle", default: true, description: "One answer above the results: sums, conversions, currency, tracking numbers, versions, facts, CMU courses, scores." },
    { key: "showKnowledge", label: "Knowledge panel", type: "toggle", default: true, description: "About a person, place or thing, when your results include its encyclopedia article (replaces degoog's Wikipedia card)." },
    { key: "showMeanings", label: "Other meanings", type: "toggle", default: true, description: "A line offering a word's other meanings when all your results are about one of them." },
    { key: "showImagesRow", label: "Images row", type: "toggle", default: true, description: "A row of pictures for searches that clearly want them (one extra Images search, usually from degoog's cache)." },
    { key: "plainLists", label: "Plain lists for type and site searches", type: "toggle", default: true, description: "Searches naming a type (pdf, reddit, recipe…) or a site get a plain list, official docs first for programming." },
    { key: "showPaywall", label: "Paywall tag", type: "toggle", default: true, description: "The word \"Paywall\" on results from subscription sites." },
    { key: "showQuickView", label: "Quick view", type: "toggle", default: true, description: "In each result's menu: the page's recipe, steps, facts or first paragraphs, read by your server when you tap." },
    { key: "showStars", label: "Ratings on recipe and review results", type: "toggle", default: true, description: "Rating and time on the first results' source line (your server reads those pages after the results are drawn)." },
    { key: "showArchive", label: "Archived copy", type: "toggle", default: true, description: "In each result's menu: open a saved copy (archive.today, Wayback Machine, Ghostarchive), looked up when you tap." },
    { key: "sites", label: "Sites", type: "list", addLabel: "Add a site", description: "Prefer: moved up, no 2-per-site limit. Lower: moved down. Hide: never shown. Same list as Prefer / Normal / Lower / Hide in each result's menu, kept in degoog's own block and score lists.", itemSchema: [{ key: "site", label: "Site", type: "text", placeholder: "example.com" }, { key: "choice", label: "Choice", type: "select", options: ["prefer", "normal", "lower", "hide"], optionLabels: ["Prefer", "Normal", "Lower", "Hide"], default: "prefer" }] },
    { key: "autoLower", label: "Lower SEO junk automatically", type: "toggle", default: true, description: "Sites that show copy, SEO-bait, stale \"best 20XX\" or AI-written signs on most searches they're in (at least 5) are set to Lower, marked auto in the result menu. Only Lower, never Hide, and your own choice for a site always wins. Keeps only site names and two counts." },
    { key: "learnFromResults", label: "Typo fixer: learn words from my results", type: "toggle", description: "Only for typo fixing. On: keeps counts of words and names seen in your result titles, plus the Did you mean fixes you tap or turn down, so names and new words stop being corrected. No list of your searches is kept. Stays on this server. Off: nothing is stored." },
  ],
  configure(s) {
    sitesFromSettings(s ? s.sites : undefined);
    SEO_ON = !(s && (s.autoLower === false || s.autoLower === "false"));
    const off = (k) => !!s && (s[k] === false || s[k] === "false");
    SHOW = { sl: !off("showSitelinks"), forum: !off("showDiscussions"), video: !off("showVideos"), news: !off("showTopStories"), ans: !off("showAnswers"), kp: !off("showKnowledge"), img: !off("showImagesRow"), qv: !off("showQuickView"), arch: !off("showArchive"), mean: !off("showMeanings"), stars: !off("showStars"), plain: !off("plainLists"), pw: !off("showPaywall") };
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
    if (!process.env.CT_NO_TIMERS) { aiSchedule(); fxSchedule(); trendSchedule(); const t = setTimeout(() => ensureData(), 90000); if (t.unref) t.unref(); }
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