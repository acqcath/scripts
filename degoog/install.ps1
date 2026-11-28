& {
$ctSw = [Diagnostics.Stopwatch]::StartNew(); $ctT = [ordered]@{}
$t = "$env:TEMP\ct-new"; New-Item -ItemType Directory -Force $t | Out-Null
[IO.File]::WriteAllText("$t\index.js", @'
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

// ===== M6: product panel (⚑ 2026-11-28 "yamaha dbr10 release"): when the needs call rates a product panel, the
// top results' pages are read for schema.org Product data (+ og:/product: meta tags) and merged into one panel:
// name, picture, brand, price range across sellers, rating, key specs, release date. The maker's page leads.
const ldNum = (x) => { const n = Number(String(x == null ? "" : x).replace(/[^\d.]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
const metaTag = (html, k) => { const m = new RegExp(`<meta[^>]+(?:property|name)=["']${k.replace(/[.:]/g, "\\$&")}["'][^>]*>`, "i").exec(html); const c = m && /content=["']([^"']*)["']/i.exec(m[0]); return c ? ldStrip(c[1]) : ""; };
const ldImg = (x) => { const v = ld1(x); const u = typeof v === "string" ? v : v && (v.url || v.contentUrl || v["@id"]); return /^https?:\/\//.test(String(u || "")) ? String(u) : ""; };
// Offers of any shape (Offer, AggregateOffer with lowPrice/highPrice, nested offers, priceSpecification)
const ldOffers = (x, out = []) => {
  if (!x || out.length >= 40) return out;
  if (Array.isArray(x)) { x.forEach((o) => ldOffers(o, out)); return out; }
  if (typeof x !== "object") return out;
  const spec = ld1(x.priceSpecification) || {};
  const cur = String(x.priceCurrency || spec.priceCurrency || "").toUpperCase().slice(0, 3);
  const seller = ldTxt(x.seller, 60);
  for (const v of [x.price, spec.price, x.lowPrice, x.highPrice]) { const n = ldNum(v); if (n && cur) out.push({ p: n, cur, seller }); }
  if (x.offers) ldOffers(x.offers, out);
  return out;
};
// One page -> its product, or null: {name, brand, img, offers: [{p, cur, seller}], rating: {v, n}, specs: [[k, v]], rel, id}
export const productFrom = (html, url = "") => {
  const objs = ldObjects(html);
  const o = objs.find((x) => ldTypes(x).some((t) => /^(?:Product|ProductGroup|IndividualProduct|ProductModel|Vehicle|Car)$/.test(t)));
  const og = { name: metaTag(html, "og:title"), img: metaTag(html, "og:image"), price: metaTag(html, "product:price:amount") || metaTag(html, "og:price:amount"), cur: (metaTag(html, "product:price:currency") || metaTag(html, "og:price:currency")).toUpperCase().slice(0, 3), brand: metaTag(html, "product:brand") };
  const isProd = o || /product/i.test(metaTag(html, "og:type")) || (og.price && og.cur);
  if (!isProd) return null;
  const v = o || {};
  const offers = ldOffers(v.offers);
  if (!offers.length && og.price && og.cur && ldNum(og.price)) offers.push({ p: ldNum(og.price), cur: og.cur, seller: "" });
  const specs = [];
  for (const a of [].concat(v.additionalProperty || [])) { const k = ldTxt(a && a.name, 40), val = ldTxt(a && (a.value ?? a.description), 80); if (k && val && specs.length < 16) specs.push([k, a.unitText ? `${val} ${ldTxt(a.unitText, 12)}` : val]); }
  for (const [k, f] of [["Color", "color"], ["Model", "model"], ["Weight", "weight"], ["Material", "material"]]) { const val = ldTxt(v[f] && (ld1(v[f]).value ?? v[f]), 60); if (val && !specs.some(([a]) => a.toLowerCase() === k.toLowerCase())) specs.push([k, val]); }
  const name = ldTxt(v.name, 160) || og.name;
  if (!name) return null;
  let host = ""; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
  return { name, brand: ldTxt(v.brand || v.manufacturer, 60) || og.brand, img: ldImg(v.image) || (/^https?:\/\//.test(og.img) ? og.img : ""), offers, rating: ldRating(v), specs,
    rel: ldDay(v.releaseDate || v.productionDate), id: ldTxt(v.gtin13 || v.gtin12 || v.gtin || v.mpn || v.sku, 40), url, host };
};
const nameKey = (t) => String(t || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Merge the pages' products into one panel. score[i] = the AI's fit of page i's product name to the search (or null):
// the best-fitting product is the panel; another page joins it when it is the same product (same gtin/mpn, or every
// word of one name is in the other). The maker's own page (host carries the brand) leads name, picture, specs.
export const productMerge = (items, score = []) => {
  const xs = items.map((p, i) => p && { ...p, s: typeof score[i] === "number" ? score[i] : null }).filter(Boolean);
  if (!xs.length) return null;
  const best = xs.reduce((a, b) => ((b.s ?? -1) > (a.s ?? -1) ? b : a));
  // Same product: same gtin/mpn, or every word of the shorter name is in the longer one ("DBR10 Powered Speaker" in
  // "Yamaha DBR10 10\" Powered Speaker")
  const words = (t) => new Set(nameKey(t).split(" ").filter(Boolean)), w0 = words(best.name);
  const sub = (a, b) => a.size > 0 && [...a].every((w) => b.has(w));
  const same = xs.filter((p) => (best.id && p.id && p.id === best.id) || (() => { const w = words(p.name); return sub(w, w0) || sub(w0, w); })());
  const bk = nameKey(best.brand).split(" ")[0];
  const maker = bk && same.find((p) => p.host.replace(/[^a-z0-9]/g, "").includes(bk));
  const lead = maker || best;
  const offers = same.flatMap((p) => p.offers.map((o) => ({ ...o, host: p.host })));
  const curs = {}; offers.forEach((o) => { curs[o.cur] = (curs[o.cur] || 0) + 1; });
  const cur = Object.keys(curs).sort((a, b) => curs[b] - curs[a])[0];
  const ps = offers.filter((o) => o.cur === cur).map((o) => o.p).sort((a, b) => a - b);
  const sellers = new Set(offers.filter((o) => o.cur === cur).map((o) => o.seller || o.host));
  const rated = same.filter((p) => p.rating).sort((a, b) => (b.rating.n || 0) - (a.rating.n || 0))[0];
  const specs = [];
  for (const p of [lead, ...same.filter((x) => x !== lead)]) for (const [k, v] of p.specs) if (specs.length < 10 && !specs.some(([a]) => a.toLowerCase() === k.toLowerCase())) specs.push([k, v]);
  const rels = same.map((p) => p.rel).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { name: lead.name, brand: lead.brand || best.brand, img: lead.img || (same.find((p) => p.img) || {}).img || "", url: lead.url,
    price: ps.length ? { lo: ps[0], hi: ps[ps.length - 1], cur, sellers: sellers.size } : null, rating: rated ? rated.rating : null, specs, rel: rels[0] || "", from: same.map((p) => p.host) };
};
const PROD_HOPS = 4;
const pageHtml = async (u, check = publicUrl) => {
  let at = u;
  for (let hop = 0; hop < PROD_HOPS; hop++) {
    if (!(await check(at))) return null;
    const r = await net(at, { timeout: 4000, max: 3_000_000, accept: "text/html,application/xhtml+xml", headers: QV_UA, redirect: "manual", imp: true });
    if (r.status >= 300 && r.status < 400 && r.location) { try { at = new URL(r.location, at).toString(); } catch { return null; } continue; }
    return r.status === 200 && r.text ? { html: r.text, url: at } : null;
  }
  return null;
};
const _prod = new Map();
export const productFor = async (q, urls, check = publicUrl) => {
  const key = `${q.toLowerCase()}\n${urls.join("\n")}`;
  const hit = _prod.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const us = urls.filter((u) => { try { return !qvBlocked(new URL(u).hostname.replace(/^www\./, "")); } catch { return false; } }).slice(0, 6);
  const items = await Promise.all(us.map(async (u) => {
    const pg = await pageHtml(u, check).catch(() => null);
    let d = ""; try { d = new URL(u).hostname.replace(/^www\./, ""); } catch {}
    const p = pg ? productFrom(pg.html, pg.url) : null;
    if (d) qvCount(d, !!pg);
    return p;
  }));
  const got = items.filter(Boolean);
  let v = null;
  if (got.length) {
    // The AI rates each product's name against the search (same reranker pass as everything else); without it, the
    // first page's product leads
    const j = await vis("/rank", { q, docs: got.map((p) => [p.brand, p.name].filter(Boolean).join(" ")) }, 2000);
    v = productMerge(got, j && Array.isArray(j.s) ? j.s : got.map((_, i) => -i));
  }
  if (_prod.size > 300) _prod.clear();
  _prod.set(key, { t: v ? Date.now() : Date.now() - TTL + 600000, v });
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
let SHOW = { learn: true, sl: true, forum: true, video: true, news: true, ans: true, kp: true, img: true, qv: true, arch: true, mean: true, stars: true, plain: true, pw: true };
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
  } catch (e) { if (!(e && e.name === "TimeoutError")) visDown(); return null; }
};
// ct-vision not answering (e.g. still loading after a restart): skip it, and check its /health every 3 s so the AI is
// back the moment it is up (was a blind 60 s pause, which kept the AI off for up to a minute after every start)
let visPoll = null;
const visDown = () => {
  visDownUntil = Date.now() + 3600000;
  if (visPoll) return;
  visPoll = setInterval(async () => {
    try { const r = await fetch(VIS + "/health", { signal: AbortSignal.timeout(2000) }); if (r.ok) { visDownUntil = 0; clearInterval(visPoll); visPoll = null; } } catch {}
  }, 3000);
  if (visPoll.unref) visPoll.unref();
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
    product: "A product panel with one specific product's price, specs, rating and release date",
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

// ===== Unsolved-search learning (M5): layout only, keyed by the needs profile, never sites or viewpoints =====
// The profile of a search: its top format, top need and top answer shape from the needs call ("video|doing|steps")
const topOf = (o) => { if (!o || typeof o !== "object") return ""; const e = Object.entries(o).filter(([, v]) => typeof v === "number").sort((a, b) => b[1] - a[1]); return e.length ? e[0][0] : ""; };
export const needsKey = (n) => (n ? [topOf(n.f), topOf(n.n), topOf(n.s)].join("|") : "");
// Which block a tapped link sat in, by the page's own block classes (videos and pictures are formats, the rest blocks)
export const LEARN_KINDS = { video: "f", image: "f", text: "f", forums: "b", news: "b", papers: "b", info: "b", answer: "b", web: "b" };
// Each kind's factor = (searches it solved + 1) / (the mean solves per kind in that group + 1): no solves -> 1 for all;
// a kind that solved more than its share rises, one that solved less falls, by the measured counts only
export const learnFactors = (st, keys) => {
  const s = st || {}, tot = keys.reduce((a, k) => a + (+s[k] || 0), 0), mean = tot / (keys.length || 1);
  return Object.fromEntries(keys.map((k) => [k, ((+s[k] || 0) + 1) / (mean + 1)]));
};
// The needs call's shares, nudged by what solved searches with this profile; each group keeps its total
export const nudgeNeeds = (n, st) => {
  if (!n || !st) return n;
  const out = { ...n };
  for (const g of ["f", "b"]) {
    const o = n[g];
    if (!o || typeof o !== "object") continue;
    const keys = Object.keys(o).filter((k) => typeof o[k] === "number" && LEARN_KINDS[k] === g);
    if (!keys.length) continue;
    const fac = learnFactors(st, keys), sum = keys.reduce((a, k) => a + o[k], 0), raw = keys.map((k) => o[k] * fac[k]), rs = raw.reduce((a, x) => a + x, 0);
    out[g] = { ...o };
    keys.forEach((k, i) => { out[g][k] = rs > 0 ? (raw[i] * sum) / rs : o[k]; });
  }
  return out;
};

// The log (private, this server only): each search's time, words and profile, the block of the last link opened
// from it, and whether the next search was the same need. Words are kept 30 days, the per-profile counts for good.
const learnFile = () => `${DIR}/learn.json`;
let UNS = null;
const learnLoad = () => { if (!UNS) { try { UNS = JSON.parse(fs.readFileSync(learnFile(), "utf8")); } catch {} if (!UNS || !Array.isArray(UNS.log)) UNS = { log: [], stat: {} }; } return UNS; };
let _lsT = 0;
const learnSave = () => { clearTimeout(_lsT); _lsT = setTimeout(() => { try { fs.writeFileSync(`${learnFile()}.tmp`, JSON.stringify(UNS)); fs.renameSync(`${learnFile()}.tmp`, learnFile()); } catch {} }, 1000); if (_lsT.unref) _lsT.unref(); };
// "Within minutes" = shorter than the median gap between your searches (measured from the log; 5+ gaps needed)
export const learnWindow = (log) => { const g = []; for (let i = 1; i < log.length; i++) g.push(log[i].t - log[i - 1].t); return g.length >= 5 ? median(g) : null; };
const SAME_SYS = "Two searches by one person, a few minutes apart. Answer with one word: SAME if the second search " +
  "looks for the same thing as the first (the first didn't give it: reworded, narrowed, fixed), NEXT if it is a " +
  "different or follow-up question (the first was answered).";
export const sameParse = (t) => { const m = /\b(same|next)\b/i.exec(String(t || "")); return m ? m[1].toLowerCase() : null; };
const credit = (e) => { if (e && e.open && e.k && !e.done) { const st = (UNS.stat[e.k] ||= {}); st[e.open] = (st[e.open] || 0) + 1; e.done = 1; } };
// A new search: the one before it is judged (only inside the window, by ai-summary's model) and credited if solved
export const learnSearch = async (q, n, now = Date.now(), ask = aiAsk) => {
  const L = learnLoad(), k = needsKey(n);
  L.log = L.log.filter((e) => now - e.t < 30 * 86400000);
  const prev = L.log[L.log.length - 1];
  if (prev && prev.q.toLowerCase() === q.toLowerCase()) return; // the same page again (reload, endless scroll)
  const win = learnWindow(L.log), e = { t: now, q, k, open: "" };
  L.log.push(e);
  if (L.log.length > 2000) L.log.splice(0, L.log.length - 2000);
  if (prev && !prev.done) {
    if (win != null && now - prev.t < win) {
      const v = sameParse(await ask([{ role: "system", content: SAME_SYS }, { role: "user", content: `First: ${prev.q}\nSecond: ${q}` }], 5).catch(() => null));
      if (v === "same") prev.done = 1; // unsolved: what was opened from it gets no credit
      else if (v === "next") credit(prev);
    } else credit(prev);
  }
  learnSave();
};
// A link opened from a search's page: which block it sat in (the last one opened before the next search counts)
export const learnOpen = (q, kind) => {
  if (!LEARN_KINDS[kind]) return false;
  const L = learnLoad();
  for (let i = L.log.length - 1; i >= Math.max(0, L.log.length - 5); i--) if (L.log[i].q.toLowerCase() === q.toLowerCase()) { L.log[i].open = kind; learnSave(); return true; }
  return false;
};
const SHOW_LEARN = () => SHOW.learn !== false;
export const learnNudge = (n) => (n ? nudgeNeeds(n, learnLoad().stat[needsKey(n)]) : n);
export const _learnReset = (x) => { UNS = x || { log: [], stat: {} }; };
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
// Search time (measured): the last 50 reranker run times and the time this hook added to each search. When the
// reranker's median run is over the wait, waiting is wasted (it'd time out anyway): the search goes on at once and
// the scores are kept for the next request.
const SPEED = { rank: [], hook: [], gpu: [], queue: [] };
const speedAdd = (a, ms) => { a.push(ms); if (a.length > 50) a.shift(); };
export const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
export const rankWait = (runs) => { const m = median(runs); return m != null && runs.length >= 5 && m > RANK_WAIT_MS ? 0 : RANK_WAIT_MS; };
globalThis.__ctResults = async (result, query, params) => {
  const t0 = Date.now();
  try { await ctResults(result, query, params); } finally { speedAdd(SPEED.hook, Date.now() - t0); }
};
const ctResults = async (result, query, params) => {
  const type = String((params && params.type) || "web");
  if (!result || !Array.isArray(result.results) || !query || type === "videos") return;
  const q = String(query).trim().slice(0, 300);
  const rs = result.results.slice(0, 60);
  if (!rs.length || q.startsWith("!")) return;
  // Publisher names and the reranker run side by side (they used to add up)
  const doi = doiNames(result.results).then((n) => { if (n) result.ctPub = 1; }, () => {});
  try { await rankPart(result, q, rs, type); } finally { await doi; }
};
const rankPart = async (result, q, rs, type) => {
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
        const r0 = Date.now();
        const j = await vis("/rank", { q, docs: docs.concat(sents.map(([, x]) => x)) }, RANK_RUN_MS);
        if (j) { speedAdd(SPEED.rank, Date.now() - r0); if (typeof j.gpu === "number") { speedAdd(SPEED.gpu, j.gpu); speedAdd(SPEED.queue, j.wait); } }
        if (!j || !Array.isArray(j.s)) return null;
        const g = { rel: j.s.slice(0, docs.length), best: {} };
        sents.forEach(([i, x], k) => { const v = j.s[docs.length + k]; if (typeof v === "number" && (!g.best[i] || v > g.best[i].p)) g.best[i] = { s: x, p: v }; });
        AIC.set(key, g);
        if (AIC.size > 500) AIC.delete(AIC.keys().next().value);
        return g;
      })().finally(() => INFL.delete(key));
      INFL.set(key, run);
    }
    const wait = rankWait(SPEED.rank);
    got = !wait ? null : await Promise.race([run, new Promise((r) => { const t = setTimeout(() => r(null), wait); if (t.unref) t.unref(); })]);
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
    // One-look health for Claude (one JS call in the browser pane, since each pane action needs the user's approval):
    // {ver, pageMissing, ai, aiMs, flags, issue, up}
    method: "get",
    path: "/status",
    async handler() {
      let ver = "";
      try { const h = fs.readFileSync(PAGE_FILE, "utf8"); const m = /\/public\/ct\/(ct\.[0-9a-f]+\.js)/.exec(h); ver = (/\/\/ clean-titles (v[\w.-]+)/.exec(m ? fs.readFileSync(`/app/src/public/ct/${m[1]}`, "utf8").slice(0, 80) : h) || [])[1] || ""; } catch {}
      const t0 = Date.now();
      let ai = false;
      try { const r = await fetch(VIS + "/health", { signal: AbortSignal.timeout(1500) }); ai = r.ok; } catch {}
      const i = flagIssue();
      return jsonOut({ ver, pageMissing: PAGE_MISSING, ai, aiMs: Date.now() - t0, flags: flagOpen().length, issue: i ? i.text.split("\n").slice(0, 3).join(" | ").slice(0, 300) : "", up: Math.round(process.uptime()), speed: { hook: median(SPEED.hook), rank: median(SPEED.rank), gpu: median(SPEED.gpu), queue: median(SPEED.queue), n: SPEED.hook.length } });
    },
  },
  {
    // What this search needs: {n: {f, n, b, ms, cut}} (null when the AI is off); one batched GPU pass, cached per search
    method: "get",
    path: "/needs",
    async handler(req) {
      const q = String(new URL(req.url).searchParams.get("q") || "").trim().slice(0, 300), n = await needsFor(q);
      if (n && SHOW_LEARN()) learnSearch(q, n).catch(() => {}); // never waited on: the search goes on at once
      return jsonOut({ n: n ? { ...(SHOW_LEARN() ? learnNudge(n) : n), cut: cutNow() } : null });
    },
  },
  {
    // A link opened from the results (M5): {q, k: block kind} -> {ok}
    method: "get",
    path: "/seen",
    async handler(req) { const p = new URL(req.url).searchParams; return jsonOut({ ok: SHOW_LEARN() && learnOpen(String(p.get("q") || "").trim().slice(0, 300), String(p.get("k") || "")) }); },
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
    // Search time (self-check): median ms the hook added per search, the reranker's median run, the wait in use
    method: "get",
    path: "/speed",
    async handler() { return jsonOut({ hook: median(SPEED.hook), rank: median(SPEED.rank), gpu: median(SPEED.gpu), queue: median(SPEED.queue), n: SPEED.hook.length, wait: rankWait(SPEED.rank) }); },
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
      const j = await vis("/rank", { q: String(b.q || "").slice(0, 300), docs: Array.isArray(b.d) ? b.d.slice(0, 96).map(String) : [] }, 3000);
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
    path: "/product",
    // Product panel (M6): ?q=search&u=top result addresses (| separated, at most 6) -> {v: merged product or null}
    async handler(req) {
      const sp = new URL(req.url).searchParams, q = (sp.get("q") || "").trim().slice(0, 300);
      const us = (sp.get("u") || "").split("|").map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x)).slice(0, 6);
      return jsonOut({ v: q && us.length ? await productFor(q, us) : null });
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
    { key: "learnLayout", label: "Learn the layout from searches", type: "toggle", default: true, description: "Kept on this server only: when a search didn't give you what you needed (you searched again for the same thing), the kinds of boxes that did solve similar searches move up. Layout only, never sites or viewpoints." },
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
    SHOW = { sl: !off("showSitelinks"), forum: !off("showDiscussions"), video: !off("showVideos"), news: !off("showTopStories"), ans: !off("showAnswers"), kp: !off("showKnowledge"), img: !off("showImagesRow"), qv: !off("showQuickView"), arch: !off("showArchive"), mean: !off("showMeanings"), stars: !off("showStars"), plain: !off("plainLists"), pw: !off("showPaywall"), learn: !off("learnLayout") };
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
    if (!process.env.CT_NO_TIMERS) { aiSchedule(); fxSchedule(); trendSchedule(); const t = setTimeout(() => ensureData(), 90000); if (t.unref) t.unref();
      // First search after a restart: read the typo fixer's word lists now (off the request path) instead of on it
      const p = setTimeout(() => { try { load(); } catch {} }, 500); if (p.unref) p.unref(); }
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
// clean-titles v74
const CT_VER = "v74";
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
  // NeurIPS proceedings: the old nips.cc hosts and the PDF of a /paper/<id>-<slug> page are one paper (proceedings copy)
  if (/^(?:papers|proceedings)\.(?:neurips|nips)\.cc$/.test(h)) { const m = /^\/paper\/(\d+)-[^/]*?(?:\.pdf)?$/i.exec(u.pathname); if (m) return `neurips:${m[1]}`; }
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
const listCtx = (q, psl, prefs = {}) => ({ add: deduper(psl), copies: [], named: namedSites(q, psl), count: new Map(), prefs, cap: 2, docs: docsFor(q), docsDone: false, nav: navName(q), navDone: false });
// ===== Site searches ("asura scans", "asurascaxs") =====
// A search of 1-3 words whose letters, joined, are a site's name (its domain's first label), allowing 1-2 typos
// for longer names. The site with that name that has the most results on the page is the one meant: its top result
// goes first with the rest of it folded under it, and other sites with nearly the same name (copies, mirrors:
// asurascanz.com, asurascans.my) are folded under it too as "look-alike sites".
const navName = (q) => {
  const s = String(q || "").toLowerCase().trim();
  if (!s || /[?:]|^!|\bsite:/.test(s)) return "";
  const w = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!w.length || w.length > 3) return "";
  const j = w.join("");
  return j.length >= 4 && j.length <= 30 && /\p{L}/u.test(j) ? j : "";
};
const lev = (a, b) => {
  if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let k = 1; k <= b.length; k++) cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};
const navDist = (name, site) => {
  const l = String(site || "").toLowerCase().split(".")[0].replace(/-/g, "");
  if (!name || !l) return 9;
  if (l === name) return 0;
  return name.length >= 6 ? lev(name, l) : 9;
};

// ===== Same-shape results (spec 8) =====
// A search that names a type of result gets a plain list of that type: no boxes, rows, panels or AI on top.
const SHAPE_WORDS = [["pdf", /\b(?:pdf|pdfs)\b/], ["paper", /\b(?:paper|papers|arxiv|preprint)\b/], ["forum", /\b(?:reddit|forum|forums|thread|stackoverflow|stack overflow)\b/], ["docs", /\b(?:docs|documentation|api reference|reference manual)\b/], ["recipe", /\b(?:recipe|recipes)\b/], ["code", /\b(?:github|gitlab|repo|repository)\b/], ["lab", /\blab\b/], ["lecture", /\b(?:lecture|lectures|lecture notes)\b/], ["slides", /\b(?:slides|slide deck|ppt|pptx)\b/], ["video", /\b(?:video|videos|youtube)\b/]];
const shapeOf = (q) => { const s = String(q || "").toLowerCase(); const t = SHAPE_WORDS.find(([, re]) => re.test(s)); return t ? t[0] : ""; };
// A site named to filter by ("… reddit", "mdn …"): only well-known destination words, and only with other words
// beside it (a search that is just "reddit" or "steelers" is a navigation, not a filter). Returns the domain or "".
const FILTER_SITE = { reddit: "reddit.com", stackoverflow: "stackoverflow.com", github: "github.com", youtube: "youtube.com", wikipedia: "wikipedia.org", wiki: "wikipedia.org", quora: "quora.com", mdn: "mozilla.org", npm: "npmjs.com", pypi: "pypi.org", imdb: "imdb.com", amazon: "amazon.com", ebay: "ebay.com", etsy: "etsy.com", twitter: "x.com", hackernews: "ycombinator.com", arxiv: "arxiv.org", goodreads: "goodreads.com", letterboxd: "letterboxd.com", yelp: "yelp.com", tripadvisor: "tripadvisor.com" };
const filterSite = (q) => {
  const s = String(q || "").toLowerCase();
  if (/(?:^|\s)site:/.test(s)) return "";
  const words = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length < 2) return "";
  const w = words.find((x) => FILTER_SITE[x]);
  return w ? FILTER_SITE[w] : "";
};
// "Only reddit.com results ›" line: the named site has fewer than 3 of the first 10 results
const onlyLine = (q, sites) => { const d = filterSite(q); return d && sites.slice(0, 10).filter((x) => x === d).length < 3 ? d : ""; };
// The site: search the line runs when tapped: the named word is replaced by the operator
const onlyQuery = (q, d) => { const w = Object.keys(FILTER_SITE).find((k) => FILTER_SITE[k] === d && new RegExp(`\\b${k}\\b`, "i").test(q)); return `${String(q).replace(w ? new RegExp(`\\s*\\b${w}\\b\\s*`, "i") : /$^/, " ").trim()} site:${d}`; };
// Programming searches: the official docs result goes first. Keys are words of the search, values host suffixes.
const DOCS = { react: ["react.dev"], reactjs: ["react.dev"], javascript: ["developer.mozilla.org"], js: ["developer.mozilla.org"], css: ["developer.mozilla.org"], html: ["developer.mozilla.org"], dom: ["developer.mozilla.org"], python: ["docs.python.org"], typescript: ["typescriptlang.org"], ts: ["typescriptlang.org"], rust: ["doc.rust-lang.org", "docs.rs"], golang: ["go.dev", "pkg.go.dev"], nodejs: ["nodejs.org"], node: ["nodejs.org"], kotlin: ["kotlinlang.org"], django: ["docs.djangoproject.com"], flask: ["flask.palletsprojects.com"], vue: ["vuejs.org"], vuejs: ["vuejs.org"], angular: ["angular.dev"], svelte: ["svelte.dev"], nextjs: ["nextjs.org"], tailwind: ["tailwindcss.com"], numpy: ["numpy.org"], pandas: ["pandas.pydata.org"], git: ["git-scm.com"], docker: ["docs.docker.com"], kubernetes: ["kubernetes.io"], postgres: ["postgresql.org"], postgresql: ["postgresql.org"], sqlite: ["sqlite.org"], php: ["php.net"], csharp: ["learn.microsoft.com"], dotnet: ["learn.microsoft.com"], powershell: ["learn.microsoft.com"], bun: ["bun.sh", "bun.com"], deno: ["docs.deno.com"] };
// Only searches that also look like code (a known API-ish word or camelCase), so "python snake" or "rust removal" don't
const CODEY = /\p{Ll}\p{Lu}|\b(?:function|method|class|array|map|filter|reduce|string|list|dict|object|async|await|promise|hook|hooks|use\w+|component|props|state|import|export|module|install|syntax|error|exception|loop|for loop|while|lambda|regex|json|api|query|selector|flexbox|grid|type|types|interface|enum|struct|trait|macro|decorator|generator|iterator|cleanup|effect|ref|context|router|config|cli|command|tutorial|docs?|example)\b/u;
const docsFor = (q) => {
  const s = String(q || "");
  const words = s.toLowerCase().split(/[^a-z0-9#]+/).filter(Boolean);
  const k = words.find((w) => DOCS[w]);
  if (!k || words.length < 2 || !CODEY.test(s)) return null; // a bare "python" wants python.org, not its docs
  return DOCS[k];
};
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
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
  // Programming search: the official docs result goes first (first page only: later pages never move what's above)
  if (ctx.docs && !ctx.docsDone) {
    ctx.docsDone = true;
    const i = kept.findIndex((r) => { const h = hostOf(r.url); return ctx.docs.some((d) => h === d || h.endsWith(`.${d}`)); });
    if (i > 0 && ctx.prefs[kept[i].site] !== "lower") kept.unshift(kept.splice(i, 1)[0]);
  }
  // Site search (first page only): the site meant first, one result of it shown, its look-alikes folded under it
  let navSite = "", alike = new Set();
  if (ctx.nav && !ctx.navDone) {
    ctx.navDone = true;
    const m = new Map();
    kept.forEach((r, i) => { const d = navDist(ctx.nav, r.site); if (d <= 2 && ctx.prefs[r.site] !== "lower") { const x = m.get(r.site) || { d, n: 0, i }; x.n++; m.set(r.site, x); } });
    const best = [...m].sort((a, b) => b[1].n - a[1].n || a[1].d - b[1].d || a[1].i - b[1].i)[0];
    if (best) {
      navSite = best[0];
      alike = new Set([...m.keys()].filter((s) => s !== navSite));
      ctx.navSite = navSite;
      kept.unshift(kept.splice(best[1].i, 1)[0]);
    }
  }
  const shown = [], folds = new Map();
  for (const r of kept) {
    // Copies (M3): same title and snippet after normalizing (one contains the other), any site: folded under the
    // first one shown as "+N similar pages"; a copy of a result on an earlier page just goes (it's already above)
    const ck = copyKey(r), orig = ck && (ctx.copies || []).find((x) => sameCopy(x.ck, ck));
    if (orig) {
      ctx.copies.push({ ck, r: orig.r }); // a copy of a copy is the same page too
      if (shown.includes(orig.r)) { const k = `~sim:${orig.r.key}`; if (!folds.has(k)) folds.set(k, { after: orig.r, items: [], sim: true }); folds.get(k).items.push(r); }
      else dups.push(r);
      continue;
    }
    if (ck && ctx.copies) ctx.copies.push({ ck, r });
    if (navSite && alike.has(r.site)) {
      const head = shown.find((x) => x.site === navSite);
      if (head) { if (!folds.has("~alike")) folds.set("~alike", { after: head, items: [], label: "look-alike sites" }); folds.get("~alike").items.push(r); continue; }
    }
    const c = ctx.count.get(r.site) || 0;
    ctx.count.set(r.site, c + 1);
    if ((r.site === navSite ? c < 1 : c < ctx.cap || ctx.prefs[r.site] === "prefer" || siteNamed(r.site, ctx.named))) { shown.push(r); continue; }
    // Folds only under a result of the same page: one placed on an earlier page would push down what's on screen
    const lastHere = [...shown].reverse().find((x) => x.site === r.site);
    if (!lastHere) { capped.push(r); continue; }
    if (!folds.has(r.site)) folds.set(r.site, { after: lastHere, items: [] });
    folds.get(r.site).items.push(r);
  }
  return { shown, dups, hidden, capped, folds };
};

// Copy test (M3): title (titleKey) and snippet as plain lowercase words, a trailing "..." dropped; two results are
// copies when each part of one contains the same part of the other. Parts shorter than the same-title rule's 12
// characters can't tell pages apart, so they never match.
const plainWords = (t) => String(t || "").replace(/(?:\.\.\.|…)\s*$/, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const copyKey = (r) => { const t = titleKey(r && r.title), n = plainWords(r && r.snippet); return t.length >= 12 && n.length >= 12 ? { t, n } : null; };
const within = (a, b) => (a.length <= b.length ? b.includes(a) : a.includes(b));
const sameCopy = (a, b) => !!a && !!b && within(a.t, b.t) && within(a.n, b.n);
// Variety tie-break (M3, off until ⚑ "wrong order" reports measure the margin): among results whose AI scores are
// within margin of the best one left, the one least like those already placed (word overlap of title + snippet)
// goes next. margin null = off: the order is returned as is. No quotas, no novelty bonus.
const bag = (r) => new Set(plainWords(`${(r && r.title) || ""} ${(r && r.snippet) || ""}`).split(" ").filter(Boolean));
const jaccard = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; const u = a.size + b.size - n; return u ? n / u : 0; };
const varietyOrder = (items, margin = null) => {
  if (margin == null || !(margin > 0) || items.some((r) => typeof r.ai !== "number")) return items.slice();
  const left = items.map((r) => ({ r, b: bag(r) })), out = [];
  while (left.length) {
    const best = Math.max(...left.map((x) => x.r.ai));
    const near = left.filter((x) => best - x.r.ai <= margin);
    const like = (x) => (out.length ? Math.max(...out.map((o) => jaccard(x.b, o.b))) : 0);
    const pick = near.reduce((a, x) => (like(x) < like(a) ? x : a));
    out.push(pick); left.splice(left.indexOf(pick), 1);
  }
  return out.map((x) => x.r);
};
const VARIETY_MARGIN = null;

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
// doi.org links say nothing about where a paper is: the DOI's registrant prefix names the publisher
const DOI_PUB = { "10.1016": "Elsevier", "10.1007": "Springer", "10.1038": "Nature", "10.1126": "Science", "10.1002": "Wiley", "10.1111": "Wiley", "10.1080": "Taylor & Francis", "10.1177": "SAGE", "10.1093": "Oxford Academic", "10.1017": "Cambridge", "10.1371": "PLOS", "10.3390": "MDPI", "10.3389": "Frontiers", "10.1186": "BMC", "10.1136": "BMJ", "10.1056": "NEJM", "10.1001": "JAMA", "10.1073": "PNAS", "10.1021": "ACS", "10.1039": "RSC", "10.1103": "APS", "10.1088": "IOP", "10.1109": "IEEE", "10.1145": "ACM", "10.1101": "bioRxiv / medRxiv", "10.48550": "arXiv", "10.2139": "SSRN", "10.7554": "eLife", "10.1146": "Annual Reviews", "10.1037": "APA", "10.1097": "Wolters Kluwer", "10.1515": "De Gruyter", "10.1163": "Brill", "10.4324": "Routledge", "10.1057": "Palgrave", "10.1108": "Emerald", "10.2307": "JSTOR", "10.1353": "Project MUSE", "10.1155": "Hindawi", "10.1159": "Karger", "10.1055": "Thieme", "10.1128": "ASM", "10.1182": "ASH", "10.1161": "AHA", "10.1172": "JCI", "10.1083": "Rockefeller UP", "10.1242": "Company of Biologists", "10.1098": "Royal Society", "10.1063": "AIP", "10.1209": "EPL", "10.5281": "Zenodo", "10.6084": "figshare", "10.31234": "PsyArXiv", "10.31219": "OSF Preprints" };
const doiPublisher = (url) => { try { const u = new URL(url); if (!/^(?:dx\.)?doi\.org$/.test(u.hostname.replace(/^www\./, ""))) return ""; const m = /^\/(10\.\d{4,9})\//.exec(decodeURIComponent(u.pathname)); return (m && DOI_PUB[m[1]]) || ""; } catch { return ""; } };
// Stray spaces the engines leave where they bolded the search words: "slang ?" "( crazy )" " shit " "Schrödinger 's".
// Spaces go before , . ; : ! ? ) ] % and 's / n't, after ( [, and inside a quote pair ("…" “…” ‘…’). Straight
// double quotes are fixed only when they pair up (even count), so a stray inch mark is never touched.
// One clean-up for every title and description, so no result looks broken next to the others: entities the engine
// left encoded (&amp;), stray spaces around punctuation (below), runs of the same mark ("!!!!", ">>>>>>", five of
// the same emoji) shortened to one, "..." as one ellipsis. Works on one text piece at a time (a description keeps its
// bold words), so it never trims ends; tidyTitle also drops separators left dangling at a title's ends.
const tidyText = (s0) => {
  let t = String(s0 || "")
    .replace(/&(?:amp|#38);/g, "&").replace(/&(?:quot|#34);/g, '"').replace(/&(?:#39|apos);/g, "'").replace(/&(?:nbsp|#160);/g, " ").replace(/&(?:lt|#60);/g, "<").replace(/&(?:gt|#62);/g, ">")
    .replace(/([!?.,:;~*=_>#<-])\1{3,}/g, (m, c) => (c === "." ? "…" : c === "!" || c === "?" ? c : ""))
    .replace(/(\p{Extended_Pictographic}\uFE0F?)(?:\s*\1){2,}/gu, "$1")
    .replace(/\.\.\./g, "…")
    .replace(/[ \t]{2,}/g, " ");
  if (!/\s[,.;:!?)\]%’”]|[(\[“‘]\s|\s'(?:s|t|re|ve|ll|d|m)\b|\sn't\b|"/.test(t)) return t;
  t = t.replace(/(\S)\s+([,;:!?)\]%]+)(?=\s|$|["”’])/g, (m, a, b) => (/\d/.test(a) && b[0] === ":" ? m : `${a}${b}`))
    .replace(/(\S)\s+(\.)(?=\s|$|["”’])/g, "$1$2")
    .replace(/([(\[])\s+(?=\S)/g, "$1")
    .replace(/(\w)\s+('(?:s|t|re|ve|ll|d|m)|n't)\b/g, "$1$2")
    .replace(/“\s+/g, "“").replace(/\s+”/g, "”").replace(/‘\s+(?=[^’]*’)/g, "‘").replace(/(‘[^’]*?)\s+’/g, "$1’");
  // Straight quotes pair up left to right; an inch mark (2" pipe) is skipped. A quote with no space on either side
  // (a"b) is left alone. An odd last one (cut-off snippet) counts as opening.
  let open = true;
  t = t.replace(/(\s*)"(\s*)/g, (m, a, b, i, all) => {
    if (/\d$/.test(all.slice(0, i)) && !a) return m; // 2" = inches
    if (!a && !b && i > 0 && i + 1 < all.length) { open = !open; return m; }
    const r = open ? `${a}"` : `"${b}`;
    open = !open;
    return r;
  });
  return t;
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

// ===== News / Science / Forums tabs: each favours its own kind (user, 2026-11-23), from 64 recorded tab searches =====
// Nothing is hidden for being off-kind: it moves to the end of the batch it came in (before paint). Recorded cases:
// Science "best mechanical keyboard" -> 10 shopping posts (computerstationnation.com) ahead of the papers; News
// "something" -> crossword-clue answer pages and X posts; News "best mechanical keyboard" -> 6 rtings.com pages.
const SCHOLAR = /(?:^|\.)(?:doi\.org|ncbi\.nlm\.nih\.gov|nih\.gov|europepmc\.org|jstor\.org|springer\.com|springeropen\.com|tandfonline\.com|taylorfrancis\.com|oup\.com|cambridge\.org|semanticscholar\.org|ieee\.org|acm\.org|arxiv\.org|sciencedirect\.com|elsevier\.com|wiley\.com|nature\.com|science\.org|plos\.org|frontiersin\.org|mdpi\.com|biorxiv\.org|medrxiv\.org|ssrn\.com|researchgate\.net|degruyter\.com|degruyterbrill\.com|brill\.com|sagepub\.com|bmj\.com|thelancet\.com|nejm\.org|jamanetwork\.com|oed\.com|oxford[a-z]*\.com|britannica\.com|bsigroup\.com|openalex\.org|researchhub\.com|hal\.science|osf\.io|zenodo\.org|theconversation\.com|palgraveconnect\.com|jhu\.edu|annualreviews\.org|apa\.org|pnas\.org|cell\.com|acs\.org|rsc\.org|aps\.org|iop\.org|aip\.org|royalsocietypublishing\.org|biomedcentral\.com|hindawi\.com|karger\.com|thieme-connect\.com|mit\.edu|nii\.ac\.jp|cnrs\.fr|scielo\.[a-z.]+|core\.ac\.uk|dramaonlinelibrary\.com|[a-z0-9-]+\.edu|[a-z0-9-]+\.ac\.[a-z]{2})$/i;
const SHOP = /(?:^|\.)(?:amazon\.[a-z.]+|ebay\.[a-z.]+|walmart\.com|bestbuy\.com|aliexpress\.com|etsy\.com|newegg\.com|target\.com|temu\.com)$/i;
const COMMERCE = /^(?:the )?(?:\d+ )?(?:best|top \d+|cheapest)\b|\b(?:buying guide|deals?|coupons?|price comparison|reviews? \d{4}|for sale|shop now|buy now)\b/i;
const PUZZLE = /\b(?:crossword clue|clue answers?|wordle|quordle|connections (?:hints?|answers?)|strands (?:hints?|answers?)|krillion answers)\b/i;
const SOCIAL = /(?:^|\.)(?:x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|threads\.net|bsky\.app)$/i;
// tab: "news" | "science" | "forums" | ""; seen: Map host -> count so far in this search (updated here)
const tabLow = (tab, host, title, seen) => {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  const n = (seen.get(h) || 0) + 1;
  seen.set(h, n);
  // Science: only what is clearly shopping or buying advice from a non-scholarly site moves down (libraries,
  // repositories and small journals the list doesn't know stay where the engines put them)
  if (tab === "science") return !SCHOLAR.test(h) && (SHOP.test(h) || COMMERCE.test(String(title || "")));
  if (tab === "news") return PUZZLE.test(String(title || "")) || SOCIAL.test(h) || n > 2;
  return false;
};

// ===== Relevance (one rule for every topic; no lists, nothing to train or maintain) =====
// A result has to show it's about the search: it contains one of the search's words (title, address or
// description), or 2+ engines returned it (they agree), or the search is an identifier (15213, an ISBN, a tracking
// number: every word has a digit) and the result is in the engines' top 3 (they look identifiers up directly).
const REL_STOP = new Set("the and for with from what whats how who whos why when where which this that these those are was were you your can does did will about into than then there many much".split(" "));
// "15-213", "10.1038" are one token (digit groups joined); words match by shared start (love / loves / lover)
const relToks = (t) => String(t || "").toLowerCase().replace(/(\d)[-.\/](?=\d)/g, "$1").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// A model name split by a space ("dbr 12", "rtx 4090", "galaxy s 24") also counts written together ("dbr12")
const relWords = (q) => {
  const t = relToks(q), joined = [];
  for (let i = 0; i + 1 < t.length; i++) if (/^\p{L}+$/u.test(t[i]) && /^\d+$/.test(t[i + 1]) && t[i].length <= 6) joined.push(t[i] + t[i + 1]);
  return [...new Set([...t.filter((w) => (/\p{L}/u.test(w) ? w.length >= 3 && !REL_STOP.has(w) : w.length >= 4)), ...joined])];
};
const relIdent = (q) => { const t = relToks(q); return t.length > 0 && t.every((w) => /\d/.test(w)); };
const relHit = (w, t) => t === w || (w.length >= 4 && t.length >= 4 && (t.startsWith(w) || w.startsWith(t)));
const matchShare = (words, text) => {
  if (!words.length) return 1;
  const toks = [...new Set(relToks(text))];
  return words.filter((w) => toks.some((t) => relHit(w, t))).length / words.length;
};
// A search made mostly of common words (a quote, "who are you who do you work for") can't be judged by its words: no check
const relJudgeable = (q) => { const t = relToks(q); return t.length > 0 && relWords(q).length * 2 >= t.length; };
// Core words: the search's words that 40%+ of the first results share (at least 3 of them). Empty = no core (every
// result is judged as before). Words found in nearly every result but too common to say anything still qualify:
// they are then simply shared by the related results too.
const relCore = (words, texts) => {
  const n = (texts || []).length;
  if (n < 5 || !words.length) return [];
  const toks = texts.map((x) => [...new Set(relToks(x))]);
  const need = Math.max(3, Math.ceil(n * 0.4));
  return words.filter((w) => toks.filter((ts) => ts.some((t) => relHit(w, t))).length >= need);
};
const related = (words, ident, text, engines, pos) => matchShare(words, text) > 0 || engines >= 2 || (ident && pos < 3);
// Second look before a result is folded: words the related results share (in 15%+ of them, at least 3; one also in
// 2+ of their titles) are the topic of this search ("tracking", "package" for a UPS number; "attention", "encoder"
// for an arXiv id; "football", "pittsburgh" for steelers on Science). A result with 2+ of them stays: it uses other
// words for the same thing. Built from this page's own results each time: nothing stored, nothing to maintain.
const TOPIC_STOP = new Set("that this your with from have more about what when where which their there they them will been were into also just like only some than then these those other such most many much number word words meaning definition best free online official home page site http https html".split(" "));
const topicToks = (t) => relToks(t).filter((w) => w.length >= 4 && /\p{L}/u.test(w) && !TOPIC_STOP.has(w));
const topicOf = (rel, words) => {
  const df = new Map(), dt = new Map();
  for (const r of rel) {
    for (const t of new Set(topicToks(`${r.title} ${r.snippet || ""}`))) df.set(t, (df.get(t) || 0) + 1);
    for (const t of new Set(topicToks(r.title))) dt.set(t, (dt.get(t) || 0) + 1);
  }
  const need = Math.max(3, Math.ceil(rel.length * 0.15));
  const own = (t) => words.some((w) => relHit(w, t));
  const topic = new Set([...df].filter(([t, n]) => n >= need && !own(t)).map(([t]) => t));
  const titled = new Set([...dt].filter(([t, n]) => n >= 2 && topic.has(t)).map(([t]) => t));
  return (r) => { const hits = [...new Set(topicToks(`${r.title} ${r.snippet || ""}`))].filter((t) => topic.has(t)); return hits.length >= 2 && hits.some((t) => titled.has(t)); };
};
const tidyTitle = (t) => tidyText(t).replace(/^[\s|·•:,;–—-]+|[\s|·•:,;–—-]+$/g, "");


// ===== ⚑ Report: what can be wrong (multi-select chips in the ⚑ box; the note stays optional). Shared by the page
// (chips), the server (only these ids are kept) and the prompt. =====
const FLAG_CATS = [["offtopic", "Off-topic"], ["spam", "Spam / junk"], ["missing", "Missing what I wanted"], ["outdated", "Outdated"],
  ["order", "Wrong order"], ["layout", "Layout looks off"], ["broken", "Something's broken or slow"]];
const flagCats = (a) => { const ok = new Set(FLAG_CATS.map((c) => c[0])); return [...new Set((Array.isArray(a) ? a : []).map(String))].filter((c) => ok.has(c)); };
// Context sent with each flag, clipped to sane sizes: {vw, vh, dpr, phone, load: {name: ms}, boxes: [{box, n}]}
const flagCtxClean = (c) => {
  if (!c || typeof c !== "object") return null;
  const num = (v, max = 1e6) => (Number.isFinite(+v) ? Math.max(0, Math.min(max, Math.round(+v))) : null);
  const load = {};
  for (const [k, v] of Object.entries(c.load && typeof c.load === "object" ? c.load : {}).slice(0, 12)) { const n = num(v, 600000); if (n !== null) load[String(k).slice(0, 40)] = n; }
  const boxes = (Array.isArray(c.boxes) ? c.boxes : []).slice(0, 30).map((b) => ({ box: String((b && b.box) || "").slice(0, 60), n: num(b && b.n, 999) || 1 })).filter((b) => b.box);
  return { ver: String(c.ver || "").slice(0, 20), vw: num(c.vw, 10000), vh: num(c.vh, 10000), dpr: Number.isFinite(+c.dpr) ? Math.round(+c.dpr * 100) / 100 : null, phone: !!c.phone, load, boxes };
};

// ===== ⚑ Report: the text the Claude Code session opens with (Claude's link takes about 14,000 characters: snippets
// are dropped first, then the oldest waiting flags; the flag being reported always stays) =====
const flagPrompt = (flags, issue, max = 12000) => {
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

// ===== One scale for blocks and results (user, 2026-11-26). The needs call (server /needs) gives format shares f
// (video / image / text, sum 1). An item's worth = its format's share x its fit (AI score 0..1). A box is worth its
// format's share x the mean fit of its best 3 items and goes before the first result (never the top one) worth less.
const fmtShares = (p) => { if (!p) return null; const v = Math.max(0, +p.video || 0), i = Math.max(0, +p.image || 0), t = Math.max(0, +p.text || 0), n = v + i + t; return n ? { video: v / n, image: i / n, text: t / n } : null; };
const boxWorth = (fmt, rels, kind) => { const r = (rels || []).filter((x) => typeof x === "number").sort((a, b) => b - a).slice(0, 3); return fmt && r.length ? fmt[kind] * (r.reduce((a, b) => a + b, 0) / r.length) : null; };
// index (in the shown results) to insert the box before; resultRels.length = after the last; never 0 (the top result stays first)
const boxAt = (fmt, resultRels, worth, from = 1) => { for (let i = from; i < resultRels.length; i++) if (typeof resultRels[i] === "number" && fmt.text * resultRels[i] < worth) return i; return resultRels.length; };

// ===== M2: every block on the same scale. A block (forums, top stories, papers) is fetched only when its share for
// this search x the best possible fit (1.0) could beat the worth of the last result on the first screen; that cutoff
// is the running median the server keeps from recent searches (cutMedian). No samples yet = fetch (that's how the
// first samples are measured). Info panel and answer card use boxAt from 0: they may go first, or further down.
const cutMedian = (a) => { const v = (a || []).filter((x) => typeof x === "number" && isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const blockGo = (share, cut) => typeof share === "number" && (cut == null || share > cut);
// A block's share on the results' scale: the text share x how much better the block fits this search than a plain
// list of web pages (both rated in the same needs pass: needs b.web). null without the AI.
const blockShare = (fmt, b, kind) => (fmt && b && typeof b[kind] === "number" && b.web > 0 ? fmt.text * b[kind] / b.web : null);
// ===== M4: answer shape and contested check, from the needs call =====
// The shape the AI rated best, when it beats an even split of the shapes and isn't a plain paragraph ("" = plain)
const shapePick = (n) => {
  const s = n && n.s;
  if (!s || typeof s !== "object") return "";
  const e = Object.entries(s).filter(([, v]) => typeof v === "number").sort((a, b) => b[1] - a[1]);
  return e.length && e[0][0] !== "plain" && e[0][1] > 1 / e.length ? e[0][0] : "";
};
// A question-style search: a direct answer rated at least as needed as doing or knowing in general
const questionStyle = (n) => { const x = n && n.n; return !!x && typeof x.question === "number" && x.question >= Math.max(+x.doing || 0, +x.knowing || 0); };


// Product panel (M6): worth drawing only with something a plain result doesn't show (price, rating, release, specs)
const prodShow = (p) => !!(p && p.name && (p.price || p.rating || p.rel || (p.specs && p.specs.length >= 2)));

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

// ----- Knowledge panel (spec 3): which searches ask for one, and whether the results back it up -----
// Short name-like searches only: no question, task, shopping or command words (those want results or an answer)
const KP_NOT = /^(?:how|what|whats|why|when|where|who|whos|which|is|are|was|do|does|did|can|could|should|will|define|weather|time|best|top|cheap|buy|download|install|watch|play|login|log|sign|free|near|latest|new)\b|\b(?:vs|versus|or|near me|review|reviews|price|prices|deal|deals|stock|tutorial|login|error|errors|support|setup|fix|not working|lyrics|meaning|tickets|hours|menu|coupon|codes?|app|apk|wallpaper|jobs|careers|salary|today|tonight|score|schedule|news|recipe|pdf|reddit)\b/i;
// "X specs", "X price", "X release date"… ask for the panel about X (a product's panel has those facts)
const KP_ASK = / (?:specs|spec sheet|specifications|tech specs|price|msrp|launch price|release date|discontinued|end of production)$/i;
// Model numbers (ps5, s24, m1, rtx4090, a7iv) are names; other letter-digit words (tracking numbers, code) aren't
const KP_MODEL = /^\p{L}{1,4}\d{1,5}\p{L}{0,3}$/u;
const kpQuery = (q) => {
  const s = String(q || "").trim().replace(/\s+/g, " ").replace(KP_ASK, "");
  if (s.length < 2 || s.length > 60 || s.split(" ").length > 5) return null;
  if (!/^[\p{L}\d][\p{L}\d .'&-]*$/u.test(s) || /^[\d .-]+$/.test(s) || KP_NOT.test(s)) return null;
  // Code-like words (useEffect, 1Z999…) aren't names of things
  if (/\p{Ll}\p{Lu}/u.test(s) || s.split(" ").some((w) => /\d\p{L}|\p{L}\d/u.test(w) && !KP_MODEL.test(w))) return null;
  return s;
};
// Titles compared without case, underscores/hyphens or a "(qualifier)"
const kpNorm = (t) => String(t || "").toLowerCase().replace(/[_-]+/g, " ").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
// The panel shows only when a result is that same article: Wikipedia itself (that result is then hidden: the panel
// replaces it), or the same article on Wikiwand (a Wikipedia mirror) or Britannica (on the user's engines no
// Wikipedia result came back in 50 recorded searches; Britannica's article is the same evidence that this meaning
// is the one the results are about). Returns {ok, wiki: [indices of Wikipedia results]}.
// hosts: a product's own and its maker's official sites (apple.com for an iPhone): a result there backs it up too
const kpMatch = (title, urls, hosts = []) => {
  const t = kpNorm(title), wiki = [];
  let ok = false;
  if (!t) return { ok, wiki };
  (urls || []).forEach((h, i) => {
    let u;
    try { u = new URL(h); } catch { return; }
    let path;
    try { path = decodeURIComponent(u.pathname); } catch { path = u.pathname; }
    const host = u.hostname.replace(/^www\./, "");
    let m;
    if (/^en\.(?:m\.)?wikipedia\.org$/.test(host) && (m = /^\/wiki\/([^/]+)$/.exec(path)) && kpNorm(m[1]) === t) { ok = true; wiki.push(i); }
    else if (host === "wikiwand.com" && (m = /^\/en\/(?:articles\/)?([^/]+)$/.exec(path)) && kpNorm(m[1]) === t) ok = true;
    else if ((hosts || []).some((x) => host === x || host.endsWith(`.${x}`))) ok = true;
    else if (host === "britannica.com" && (m = /^\/(?:topic|biography|place|science|art|technology|event|animal|plant|money|sports|summary)\/([^/]+)/.exec(path)) && kpNorm(m[1]) === t) ok = true;
  });
  return { ok, wiki };
};
// Phone line: up to 3 facts, short ("Born Dec 13, 1989 · Height 330 m (1,083 ft)"); the page drops what doesn't fit
const kpLine = (facts) => (facts || []).slice(0, 4).map((f) => `${f.k} ${f.v}`);

// ----- Meaning line (spec 9): the search's words have several meanings (Wikidata's matches for them), and the
// results cover just one: "Also: snakes · Monty Python", each a search that adds the word. Results covering two or
// more meanings (mercury: planet, element, bank) get no line. Never reorders or interleaves results.
const MEAN_STOP = new Set("about after also american british from into known like main more most other over part such than that their them then there these they this used uses using very were what when where which while with within without world".split(" "));
const meanWords = (t) => new Set(String(t || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !MEAN_STOP.has(w)).map((w) => w.replace(/(?<=\w{3})s$/, "")));
const meaningLine = (q, alts, texts) => {
  const s = String(q || "").trim().toLowerCase();
  if (!s || !Array.isArray(alts) || alts.length < 2) return null;
  const qw = meanWords(s);
  const sets = alts.map((a) => { const w = meanWords(a.desc); for (const x of meanWords(a.label)) if (!qw.has(x)) w.add(x); for (const x of qw) w.delete(x); return w; });
  const count = new Map();
  for (const w of sets) for (const x of w) count.set(x, (count.get(x) || 0) + 1);
  const own = sets.map((w) => [...w].filter((x) => count.get(x) === 1));
  const docs = (texts || []).slice(0, 10).map((t) => meanWords(t));
  const cov = own.map((ws) => docs.filter((d) => ws.some((x) => d.has(x))).length);
  const top = cov.indexOf(Math.max(...cov));
  if (cov[top] < 3 || cov.some((c, i) => i !== top && c > 0)) return null;
  const chips = [];
  alts.forEach((a, i) => {
    if (i === top || !own[i].length || chips.length >= 3) return;
    const label = String(a.label).trim(), ll = label.toLowerCase();
    if (ll !== s && ` ${ll.replace(/[^\p{L}\p{N}]+/gu, " ")} `.includes(` ${s.replace(/[^\p{L}\p{N}]+/gu, " ")} `)) { if (!chips.some((c) => c.q === label)) chips.push({ text: label, q: label }); return; }
    // the description's last own word ("family of snakes" -> "snake", as the search would say it)
    const dw = String(a.desc).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => own[i].includes(w.replace(/(?<=\w{3})s$/, "")));
    const w = dw.length ? dw[dw.length - 1] : own[i][0];
    const nq = `${String(q).trim()} ${w}`;
    if (!chips.some((c) => c.q === nq)) chips.push({ text: w, q: nq });
  });
  return chips.length ? chips : null;
};

// ----- Images row (spec 12): searches that clearly want pictures, from their words -----
const VISUAL = /\b(?:pictures?|photos?|photographs?|images?|pics?|wallpapers?|logos?|aesthetic|tattoos?|outfits?|hairstyles?|haircuts?|drawings?|paintings?|memes?|gifs?|clipart|inspo|nail designs?|room ideas|decor ideas|cake ideas|what does .+ look like)\b/i;
// …but not tasks about image files ("image processing python", "resize photo", "logo generator")
const NOT_VISUAL = /\b(?:processing|python|javascript|java|css|html|api|upload|resize|crop|compress|convert|converter|format|size|editor|edit|search|generator|ai|dataset|recognition|classification|docker|file|files|link|url|tag|src|alt text|background remover|remove background|to pdf|to text|ocr)\b/i;
const visualQ = (q) => { const s = String(q || "").trim(); return !!s && !s.startsWith("!") && s.length <= 100 && VISUAL.test(s) && !NOT_VISUAL.test(s); };

// ----- !deepl (spec 14): "!deepl text" or "!deepl de text" -> DeepL's translator with that text (target English
// unless a DeepL target code comes first). URL form from knowledge (#source/target/text), not live-checked.
const DEEPL_TO = new Set(["ar", "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "he", "hu", "id", "it", "ja", "ko", "lt", "lv", "nb", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "th", "tr", "uk", "vi", "zh"]);
const deeplUrl = (q) => {
  const m = /^\s*!deepl(?:\s+([\s\S]*))?$/i.exec(String(q || ""));
  if (!m) return "";
  let text = (m[1] || "").trim(), to = "en";
  const w = /^([a-z]{2})\s+([\s\S]+)$/i.exec(text);
  if (w && DEEPL_TO.has(w[1].toLowerCase())) { to = w[1].toLowerCase(); text = w[2].trim(); }
  return text ? `https://www.deepl.com/translator#auto/${to}/${encodeURIComponent(text).replace(/%2F/g, "%5C%2F")}` : "https://www.deepl.com/translator";
};

// ----- The one local answer for a search, or null. CMU course numbers are left to the CMU card (network). -----
const answer = (q, now = Date.now(), data = {}) => {
  const s = String(q || "").trim();
  if (!s || s.length > 200 || s.startsWith("!")) return null;
  if (/^\d{2}-\d{3}\b/.test(s)) return null;
  return pattern(s) || convert(s) || currency(s, data.fx) || percent(s) || dateMath(s, now) || calc(s);
};

// ===== Featured snippet (spec 2): fact and how-to wording only, from a result's own snippet =====
// Picked from the results already on the page, so it's drawn in the same pass as them (never late). A sentence is
// used only if it reads as a whole statement that applies to everyone: starts like a sentence, ends in a full stop
// (not cut off with "..."), no I/you/we wording, no per-model/version steps, and names the subject (or, for a how-to,
// comes from a page whose title names it). How much/many/long/tall/old/far and when need a number or date in it.
// No topic is ever filtered (user's rule): wording and sentence shape are the only tests.
const SNIP_Q = /^(?:what(?:'s| is| are| was| were| does| do)?|who(?:'s| is| was| are| were)?|when(?: is| was| did| does| do| will)?|where(?: is| was| are| did| does)?|which|how (?:many|much|long|tall|old|far|big|deep|high|heavy|fast|often|to)|is|are|was|were|does|do|did|can|could)\b/i;
const SNIP_NEEDS_NUM = /^(?:how (?:many|much|long|tall|old|far|big|deep|high|heavy|fast|often)|when)\b/i;
const SNIP_STOP = new Set("a an the of to in on at for by from with and or is are was were be been do does did can could will would how what whats who whos when where which many much long tall old far big deep high heavy fast often there it its this that these those you your i me my we our they them he she his her".split(" "));
const NUM_WORDS = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion|dozen|half|infinite)\b/i;
const snipStem = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").replace(/(?<=\w{3})(?:es|s)$/, "");
const snipQuery = (q) => {
  const s = String(q || "").trim();
  if (!s || s.length > 120 || s.startsWith("!") || !SNIP_Q.test(s)) return null;
  const subj = [...new Set(s.split(/\s+/).map(snipStem).filter((w) => w.length >= 3 && !SNIP_STOP.has(w)))];
  if (!subj.length) return null;
  return { q: s, subj, howto: /^how to\b/i.test(s), num: SNIP_NEEDS_NUM.test(s), when: /^when\b/i.test(s) };
};
// A snippet -> its whole sentences (leading date / "N days ago" / "..." taken off; a first piece that starts
// mid-sentence and the last piece cut off by "..." are dropped)
const snipSentences = (text) => {
  let t = String(text || "").replace(/\s+/g, " ").replace(/\s*(?:\.\.\.|…)\s*/g, " … ").replace(/\s+([,.;:!?])/g, "$1").trim();
  let cut = false;
  const lead = /^(?:[A-Z][a-z]{2} \d{1,2}, \d{4}|\d+ (?:minutes?|hours?|days?|weeks?|months?|years?) ago)\s*(?:\.\.\.|…|—|-|·)\s*/.exec(t);
  if (lead) { t = t.slice(lead[0].length); cut = true; }
  if (/^(?:\.\.\.|…)/.test(t)) { t = t.replace(/^(?:\.\.\.|…)\s*/, ""); cut = true; }
  t = t.replace(/^(?:TIL|PSA|ELI5)\s*:?\s*(?:that\s+)?/i, "").replace(/"\s+([^"]*?)\s+"/g, '"$1"');
  // " ... " inside a snippet joins separate excerpts: each one after it may start mid-sentence
  const parts = [];
  t.split(/\s+(?:\.\.\.|…)\s+/).forEach((chunk, c) => chunk.split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/).forEach((p, i) => parts.push({ p, start: i === 0 && (c > 0 || cut) })));
  const out = [];
  parts.forEach(({ p, start }) => {
    p = p.trim();
    if (/(?:\.\.\.|…)$/.test(p) || !/[.!]["”')\]]?$/.test(p)) return; // cut off or a question
    if (/^\.+$/.test(p) || p.length < 25 || p.length > 320) return;
    if (!/^["“(]?[A-Z0-9]/.test(p)) return; // starts mid-sentence
    if (start && (/^[^(]*\)/.test(p) || /^\d/.test(p) && !/^\d[\d,.]* [a-z]/.test(p))) return; // "883–859 B.C.) moved…"
    out.push(p);
  });
  return out;
};
const PERSONAL = /\b(?:i|i'm|i've|i'd|me|my|mine|we|we're|our|us|you|you're|your|yours)\b/i;
const PER_MODEL = /\b(?:depending on (?:your|the) (?:model|version)|(?:your|this) model|for (?:older|newer) models?|version \d|model number|firmware)\b/i;
const HAS_NUM = (s) => /\d/.test(s) || NUM_WORDS.test(s);
const HAS_DATE = (s) => /\b(?:\d{3,4}|\d{1,2}(?:st|nd|rd|th))\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight)\b/i.test(s);
const mentions = (s, subj) => { const ws = new Set(String(s).split(/[^\p{L}\p{N}]+/u).map(snipStem)); return subj.filter((w) => ws.has(w)).length; };
// results: [{title, href, h, snippet}] in page order (first 6 looked at). -> {kind: "snippet", text, href, title, h}
const snipBlocked = (sq, results) => {
  // A how-to whose steps differ per model (AirPods: case button, Max, AirPods 4…) gets no snippet: the page that
  // has the per-model steps is shown first as a normal result instead (spec 2)
  if (sq.howto && (results || []).slice(0, 6).some((r) => r && /\b(?:(?:each|every|your|all|different|older|newer|which) models?|by model|(?:\d(?:st|nd|rd|th)|first|second|third|fourth) gen(?:eration)?|model numbers?)\b/i.test(`${r.title || ""} ${r.snippet || ""}`))) return true;
  // …or whose result titles name 2+ variants of the subject ("AirPods Pro", "AirPods Max", "AirPods Pro 3")
  if (sq.howto) {
    const vars = new Set();
    for (const r of (results || []).slice(0, 8)) {
      const ws = String((r && r.title) || "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      ws.forEach((w, i) => { if (sq.subj.includes(snipStem(w)) && /^(?:pro|max|mini|plus|ultra|se|lite|air|\d{1,2})$/i.test(ws[i + 1] || "")) vars.add(ws[i + 1].toLowerCase()); });
    }
    if (vars.size >= 2) return true;
  }
  return false;
};
// The answer AI's pick (server: each top result's best-answering sentence, scored 0..1): the highest-scoring sentence
// of the first 6 results that passes the same rules as below (no per-model how-to, no "you/your", no question, no
// video/social site); weak (< 0.5) -> no snippet. null when the AI didn't score these results.
const featuredSnippetAI = (q, results) => {
  const sq = typeof q === "string" ? snipQuery(q) : q;
  if (!(results || []).some((r) => r && r.best)) return null;
  if (sq && snipBlocked(sq, results)) return null;
  // Not worded as a question ("adderall loss of appetite length"): only a sentence the AI is sure answers it
  const min = sq ? 0.5 : 0.8;
  let top = null;
  for (const r of (results || []).slice(0, 6)) {
    const b = r && r.best;
    if (!b || /(?:^|\.)(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|x\.com|twitter\.com)$/.test(r.h || "")) continue;
    if (b.p < min || PERSONAL.test(b.s) || PER_MODEL.test(b.s) || /\?$/.test(b.s)) continue;
    if (!top || b.p > top.b.p) top = { r, b };
  }
  return top ? { kind: "snippet", text: top.b.s, href: top.r.href, title: top.r.title || "", h: top.r.h || "", p: top.b.p } : null;
};
const featuredSnippet = (q, results) => {
  const sq = typeof q === "string" ? snipQuery(q) : q;
  if (!sq) return null;
  const need = Math.max(1, Math.ceil(sq.subj.length / 2));
  if (snipBlocked(sq, results)) return null;
  for (const r of (results || []).slice(0, 6)) {
    if (!r || !r.snippet || /(?:^|\.)(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|x\.com|twitter\.com)$/.test(r.h || "")) continue;
    const ss = snipSentences(r.snippet);
    const titleHits = mentions(r.title || "", sq.subj);
    const ok = ss.map((s, i) => {
      if (PERSONAL.test(s) || PER_MODEL.test(s) || /\?$/.test(s)) return false;
      const near = mentions(s, sq.subj) + (i > 0 ? mentions(ss[i - 1], sq.subj) : 0);
      if (sq.howto) return near >= need || titleHits >= need;
      if (near < need) return false;
      if (sq.when) return HAS_DATE(s);
      if (sq.num) return HAS_NUM(s);
      return true;
    });
    let at = ok.indexOf(true);
    if (at < 0) continue;
    // A how-to keeps its consecutive steps (up to 3); a fact keeps one sentence (two if the first is short)
    let text = ss[at];
    if (sq.howto) { for (let k = at + 1; k < ss.length && k < at + 3 && ok[k]; k++) text += ` ${ss[k]}`; }
    else if (text.length < 70 && ss[at + 1] && ok[at + 1]) text += ` ${ss[at + 1]}`;
    return { kind: "snippet", text, href: r.href, title: r.title || "", h: r.h || "" };
  }
  return null;
};

// ----- People also ask: is a page about the question? -----
// A question's own words (not "why", "is", "my"…) must be in the page's title or description: at least one, and two
// once the question has three or more. Word stems compared (nostrils ~ nostril, hurts ~ hurt).
const QA_LEAD = /^(?:why|what|whats|how|who|whos|when|where|which|is|are|was|were|can|could|do|does|did|should|will|would)$/;
const QA_STOP = new Set("the and for with that this from your you my his her its our their they them about into over than then there what when where which while who why how are was were does did can could should would will have has had been being not too very so it is am be do of in on at to by or an a me i we us get got feel feels".split(" "));
const qaStem = (w) => w.replace(/(?:ies|es|s|ing|ed|ly)$/, "").slice(0, 6);
const qaAbout = (question, text) => {
  const ws = [...new Set(String(question || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])].filter((w) => w.length >= 3 && !QA_STOP.has(w)).map(qaStem);
  if (!ws.length) return true;
  const hay = new Set((String(text || "").toLowerCase().replace(/<[^>]+>/g, " ").match(/[\p{L}\p{N}]+/gu) || []).map(qaStem));
  const n = ws.filter((w) => hay.has(w)).length;
  return n >= (ws.length >= 3 ? 2 : 1);
};

return { pslParse, regDomain, shortTarget, arxivId, docKey, titleKey, deduper, dedupe, namedSites, capSites, listCtx, navName, navDist, shapeOf, filterSite, onlyLine, onlyQuery, docsFor, planPage, copyKey, sameCopy, jaccard, varietyOrder, VARIETY_MARGIN, SITE_SCORE, sitesFromLists, unblockText, CHEAT_SITES, seoSigns, SEO_MIN, seoVerdict, PAYWALL_SITES, paywalled, cleanSnippet, doiPublisher, tidyText, dateLabel, relDate, upsValid, isbnValid, cmuCourse, tabLow, relWords, relIdent, matchShare, relJudgeable, relCore, related, topicOf, tidyTitle, FLAG_CATS, flagCats, flagCtxClean, flagPrompt, fmtShares, boxWorth, boxAt, cutMedian, blockGo, blockShare, shapePick, questionStyle, prodShow, fmtNum, calc, convert, percent, dateMath, pattern, currency, eolQuery, eolAnswer, WD_PROP, wdQuery, wdAnswer, cmuAgg, cmuAnswer, sportsAnswer, kpQuery, kpMatch, kpLine, meaningLine, visualQ, deeplUrl, answer, snipQuery, snipSentences, featuredSnippetAI, featuredSnippet, QA_LEAD, qaAbout };
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
// The answer AI's verdicts ride along in degoog's own search answers (ctRel per result, ctBest = its best sentence):
// read here, before degoog draws the results, so relevance and the featured snippet use them in the same pass
const AIW = globalThis.__ctAIW || (globalThis.__ctAIW = new Map());
const PUBW = globalThis.__ctPUBW || (globalThis.__ctPUBW = new Map()); // doi.org result -> publisher name (server, Crossref)
const aiKey = (u) => { try { const x = new URL(u, location.href); return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/$/, "") + x.search).toLowerCase(); } catch { return String(u || ""); } };
window.fetch = async (input, init) => {
  let path = "", search = false;
  try {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (u.origin === location.origin && u.pathname.startsWith("/api/plugin/")) path = u.pathname + u.search;
    if (u.origin === location.origin && u.pathname === "/api/search" && !/^(images|videos)$/.test(u.searchParams.get("type") || "")) search = true;
  } catch {}
  if (search) {
    const r = await _fetch0(input, init);
    try {
      if (r.ok) {
        const j = await r.clone().json();
        if (j && (j.ctAi || j.ctPub) && Array.isArray(j.results)) for (const x of j.results) if (x && x.url) {
          if (typeof x.ctRel === "number") AIW.set(aiKey(x.url), { p: x.ctRel, best: x.ctBest || null });
          if (x.ctPub) PUBW.set(aiKey(x.url), String(x.ctPub));
        }
        if (AIW.size > 3000) for (const k of [...AIW.keys()].slice(0, 1000)) AIW.delete(k);
      }
    } catch {}
    return r;
  }
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
// Browser history: degoog's endless scroll rewrites the address with &loaded=2, 3, … as pages load, and Firefox-
// based browsers (Zen) record each rewrite as another history entry for the same search. Same search -> the address
// stays as it is; history.state still carries the page count, which back/forward restore from.
try {
  const rs = history.replaceState.bind(history);
  history.replaceState = function (st, t, url) {
    try {
      if (url != null) {
        const n = new URL(url, location.href), c = new URL(location.href);
        const strip = (u) => { const p = new URLSearchParams(u.search); p.delete("loaded"); return `${u.pathname}?${p}`; };
        if (n.origin === c.origin && strip(n) === strip(c)) return rs(st, t);
      }
    } catch {}
    return rs(st, t, url);
  };
} catch {}
const fadeIn = (e) => { e.classList.add("ct-in"); e.addEventListener("animationend", () => e.classList.remove("ct-in"), { once: true }); return e; };
// The tab row ends where the search bar ends (Tools sits under the bar's → button, in the same column as results)
const tabsEdge = () => {
  const bar = document.getElementById("results-search-bar"), tabs = document.getElementById("results-tabs");
  if (!bar || !tabs) return;
  // as right padding, not a max-width: centered mode pins the row's width (max-width !important), and the divider
  // stays edge to edge either way
  const pr = Math.round(tabs.getBoundingClientRect().right - bar.getBoundingClientRect().right);
  if (pr >= 0 && bar.getBoundingClientRect().width > 200) tabs.style.setProperty("--ct-tabs-pr", `${pr}px`);
  else tabs.style.removeProperty("--ct-tabs-pr");
  if (!tabsEdge.ro && window.ResizeObserver) { tabsEdge.ro = new ResizeObserver(() => requestAnimationFrame(tabsEdge)); tabsEdge.ro.observe(bar); tabsEdge.ro.observe(tabs); }
};
const lineUp = () => {
  tabsEdge();
  // Lined up with the content under it on every tab and screen size: a result's text, or the edge of the picture grid
  const main = document.getElementById("results-main");
  const c = main && [...main.querySelectorAll("#results-list .result-item .result-title, #results-list .image-card, #results-list .video-card")].find((e) => e.offsetParent);
  if (!c) return;
  // Measured from the box's own left edge, so whatever wraps it (main's padding, theme margins) can't add to it
  const fix = document.getElementById("ct-fix");
  if (!fix) return;
  const x = Math.round(c.getBoundingClientRect().left - fix.getBoundingClientRect().left);
  if (Number.isFinite(x) && x >= 0 && x < 80) fix.style.setProperty("--ct-x", `${x}px`);
};
addEventListener("resize", () => requestAnimationFrame(lineUp), { passive: true });
// Same search even if degoog tidied the address (e.g. dropped a #) meanwhile
// Which search a page address is, ignoring what endless scroll adds while you scroll (&loaded=2) and any #
const searchId = (h) => { try { const u = new URL(h); u.hash = ""; u.searchParams.delete("loaded"); return u.toString(); } catch { return String(h).split("#")[0]; } };
const sameSearch = (k) => searchId(location.href) === searchId(k);
// Same-shape results (spec 8): the search names a type of result (pdf, reddit, docs, recipe, video…) or a site to
// filter by: a plain list of that type, with no boxes, rows, panels, People also ask or AI on top.
const curQ = () => { try { return (new URL(location.href).searchParams.get("q") || "").trim(); } catch { return ""; } };
const shaped = (q = curQ()) => SHOW.plain !== false && !!(CT.shapeOf(q) || CT.filterSite(q) || /(?:^|\s)site:\S/i.test(q));


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
      m = t.match(/^(.+?)\s*:\s*r\/\s*([\w-]+)(?:\s*[-|–—]\s*Reddit)?$/i);
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

let href = "", webTab = true, wantsDict = true, qWords = [], qIdent = false;
// Dictionary, spelling and grammar pages only when the search is one word or asks about words (Bing adds them for
// any word of a search: "using dbr 12 on a pole" got "Useing or Using – Which Spelling Is Correct?")
const DICT = /(^|\.)(merriam-webster\.com|thefreedictionary\.com|dictionary\.cambridge\.org|dictionary\.com|collinsdictionary\.com|oxfordlearnersdictionaries\.com|vocabulary\.com|wordreference\.com|yourdictionary\.com|wiktionary\.org|urbandictionary\.com|thesaurus\.com|grammartribe\.com|grammarist\.com|grammarly\.com|writingexplained\.org|wordhippo\.com|ludwig\.guru|dictionary\.law\.com|macmillandictionary\.com|englishclub\.com|grammar-monster\.com|grammarbook\.com|differencebetween\.net|thecontentauthority\.com|onelook\.com|lexico\.com|definitions\.net|howtopronounce\.com|youglish\.com|sentencedict\.com)$/i;
const DICT_TITLE = /\b(?:which spelling|spelling|correct spelling|definition|definitions|meaning of|english meaning|synonyms?|antonyms?|how to pronounce|pronunciation|grammar rules?|in a sentence|use .{1,20} in a sentence)\b/i;
const readQuery = () => {
  if (location.href === href) return;
  href = location.href;
  try { qIdent = CT.relIdent(new URL(href).searchParams.get("q") || ""); } catch { qIdent = false; }
  try { webTab = !new URL(href).searchParams.get("type"); } catch { webTab = true; }
  try { qWords = CT.relWords(new URL(href).searchParams.get("q") || ""); } catch { qWords = []; }
  try {
    const q = (new URL(href).searchParams.get("q") || "").trim();
    wantsDict = q.split(/\s+/).length === 1 || /\b(define|definition|meaning|means?|synonyms?|antonyms?|pronounc\w*|spell\w*|dictionary|word|etymology|slang)\b/i.test(q);
  } catch { wantsDict = true; }
};
// Results the page never shows: dictionary pages for non-word searches (Bing adds them for words like "under")
const junk = (el) => {
  const a = el.querySelector("a.result-title");
  if (!a) return false;
  let h = "";
  try { h = new URL(a.href).hostname; } catch {}
  return !wantsDict && (DICT.test(h.replace(/^www\./, "")) || DICT_TITLE.test(a.textContent || ""));
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
// News / Science / Forums: off-kind results (core tabLow) move to the end of the batch degoog just inserted, before
// paint; the same title twice from one site shows once. Web keeps everything (listPass does its own ordering).
const tabPlanned = new WeakSet();
let TP = { key: "", seen: new Map(), titles: new Set() };
const tabPass = () => {
  if (webTab) return;
  let tab = "";
  try { const t = new URL(location.href).searchParams.get("type") || ""; tab = /news/.test(t) ? "news" : /science/.test(t) ? "science" : /forum/.test(t) ? "forums" : ""; } catch {}
  if (!tab) return;
  const list = document.getElementById("results-list");
  if (!list) return;
  const fresh = [...list.querySelectorAll(":scope > .result-item")].filter((el) => !tabPlanned.has(el));
  if (!fresh.length) return;
  const key = searchId(location.href);
  if (TP.key !== key) TP = { key, seen: new Map(), titles: new Set() };
  const low = [];
  for (const el of fresh) {
    tabPlanned.add(el);
    if (el.style.display === "none") continue;
    const a = el.querySelector("a.result-title");
    if (!a) continue;
    let h = "";
    try { h = new URL(el.dataset.resultUrl || a.href).hostname.replace(/^www\./, ""); } catch {}
    const t = (a.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (TP.titles.has(`${h}|${t}`)) { el.style.display = "none"; el.dataset.ctDup = "1"; continue; }
    TP.titles.add(`${h}|${t}`);
    // Off-kind for this tab, or about something else entirely (no word of the search anywhere in it): moves down
    if (CT.tabLow(tab, h, a.textContent, TP.seen)) low.push(el);
  }
  const last = fresh[fresh.length - 1];
  if (low.length && low.length < fresh.length) { let at = last; for (const el of low) { if (el !== at) at.after(el); at = el; } }
};
// Relevance, one rule for every topic and tab (core related): a result that shows no sign of being about the
// search (none of its words, one engine only, not an identifier lookup's top 3) goes to the end of the batch it came
// in, folded under "N unrelated results ⌄" (one tap shows them). Decided before paint; nothing is filtered by topic.
const relPlanned = new WeakSet();
const AI_LOW = 0.02; // answer AI: below this a result isn't about the search (first result always stays)
let RP = { key: "", n: 0, rel: [], core: null };
const relPass = () => {
  const list = document.getElementById("results-list");
  if (!list) return;
  const fresh = [...list.children].filter((el) => el.classList.contains("result-item") && !relPlanned.has(el));
  if (!fresh.length) return;
  const key = searchId(location.href);
  if (RP.key !== key) RP = { key, n: 0, rel: [], core: null };
  // Words of the corrected search too, when degoog searched a typo fix ("Showing results for …")
  const words = [...new Set([...qWords, ...CT.relWords(document.querySelector("#ct-fix a")?.textContent || "")])];
  let q0 = "";
  try { q0 = new URL(location.href).searchParams.get("q") || ""; } catch {}
  if (!CT.relJudgeable(q0)) { fresh.forEach((el) => relPlanned.add(el)); return; }
  // The search's core words: those most of the results share ("dbr12" for "using dbr 12 on a pole"). A result needs
  // one of them, even when it shares a common word ("using") or the answer AI gave it a weak yes
  if (!RP.core) { const txt = fresh.map((el) => `${el.dataset.resultUrl || el.querySelector("a.result-title")?.href || ""} ${el.querySelector("a.result-title")?.textContent || ""} ${el.querySelector(".result-snippet")?.textContent || ""}`); if (txt.length >= 5) RP.core = CT.relCore(words, txt); }
  const core = RP.core || [];
  let out = [];
  for (const el of fresh) {
    relPlanned.add(el);
    if (el.style.display === "none" || el.classList.contains("ct-grouped")) continue;
    const pos = RP.n++;
    const a = el.querySelector("a.result-title");
    if (!a) continue;
    const r = { title: a.textContent || "", snippet: el.querySelector(".result-snippet")?.textContent || "" };
    const anchor = el.nextElementSibling?.classList.contains("ct-fold"); // a fold's anchor stays put
    // The answer AI's verdict when it has one (reads meaning, not shared words); the word rule otherwise
    const ai = AIW.get(aiKey(el.dataset.resultUrl || a.href));
    if (ai) r.ai = true;
    const txt = `${el.dataset.resultUrl || a.href} ${r.title} ${r.snippet}`;
    const coreOk = CT.matchShare(core, txt) > 0;
    if (!coreOk) r.core = false;
    const ok = pos === 0 || (coreOk && (ai ? ai.p >= AI_LOW : CT.related(words, qIdent, txt, el.querySelectorAll(".result-engine-tag").length, pos)));
    if (anchor || ok) RP.rel.push(r);
    else out.push([el, r]);
  }
  // Second look: results that use other words for the same topic as the related ones stay (core topicOf)
  if (out.length) { const same = CT.topicOf(RP.rel, words); out = out.filter(([, r]) => (r.ai && r.core !== false) || !same(r)); }
  out = out.map(([el]) => el);
  const shown = fresh.filter((el) => !out.includes(el) && el.style.display !== "none" && !el.classList.contains("ct-grouped"));
  if (!out.length || !shown.length) return;
  for (const el of out) { el.style.display = "none"; el.dataset.ctUnrel = "1"; }
  const row = mk("div", "ct-fold");
  const b = mk("button", "ct-fold-b", `${out.length} unrelated result${out.length > 1 ? "s" : ""}`);
  b.type = "button";
  b.setAttribute("aria-expanded", "false");
  b.append(mk("span", "ct-chev", "⌄"));
  row.append(b);
  const last = fresh[fresh.length - 1];
  last.after(row);
  row.after(...out);
  b.addEventListener("click", () => { for (const el of out) { el.style.display = ""; delete el.dataset.ctUnrel; fadeIn(el); } row.remove(); }, { once: true });
};
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
    if (SHOW.plain === false) LP.ctx.docs = null; // "official docs first" is part of the plain-lists switch
  }
  const items = [];
  for (const el of fresh) {
    if (junk(el)) continue;
    const a = el.querySelector("a.result-title");
    if (a) items.push({ el, url: el.dataset.resultUrl || a.href, title: a.textContent || "", snippet: (() => { const sn = el.querySelector(".result-snippet"), d = sn && sn.querySelector(".result-date"); return sn ? (sn.textContent || "").replace(d ? d.textContent : "", "").replace(/^\s*·\s*/, "") : ""; })() });
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
  for (const f of p.folds.values()) f.items.forEach((r) => hide(r, f.sim ? "ctSim" : "ctCap")); // copies never become sitelinks
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
  for (const [site, f] of p.folds) { LP.pend.push({ site, label: f.label, sim: f.sim, after: f.after.el, els: f.items.map((r) => r.el) }); }
};
// Folds go in after the boxes (sitelinks, Discussions) took what they use, in the same pass, so counts are final
const foldPass = () => {
  if (!LP || !LP.pend.length) return;
  const pend = LP.pend;
  LP.pend = [];
  for (const f of pend) {
    const els = f.els.filter((el) => el.isConnected && !el.classList.contains("ct-grouped"));
    if (!els.length || !f.after.isConnected || f.after.classList.contains("ct-grouped") || f.after.dataset.ctUnrel) continue;
    const row = mk("div", "ct-fold");
    const b = mk("button", "ct-fold-b", f.sim ? `+${els.length} similar page${els.length > 1 ? "s" : ""}` : f.label ? `${els.length} more from ${f.label}` : `${els.length} more from ${f.site}`);
    b.type = "button";
    b.setAttribute("aria-expanded", "false");
    b.append(mk("span", "ct-chev", "⌄"));
    row.append(b);
    f.after.after(row);
    row.after(...els);
    // Tap: the folded results open in place, where the line was
    b.addEventListener("click", () => {
      for (const el of els) { el.style.display = ""; delete el.dataset.ctCap; delete el.dataset.ctSim; fadeIn(el); }
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
// Phone-style presentation (bottom sheet, sizes for reading at arm's length, tap targets) is for touch phones only; a
// desktop window squeezed narrow keeps the desktop look and only reflows what no longer fits (same query as custom.css)
const TOUCH = matchMedia("(max-width: 767px) and (pointer: coarse)");
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

// A picture's identity: the real address inside degoog's image proxy, without size/quality settings
const newsPics = new Map();
const picKey = (src) => {
  try {
    const u = new URL(src, location.href);
    const inner = new URL(u.pathname.includes("/api/proxy/image") ? u.searchParams.get("url") || "" : u.href);
    for (const p of ["w", "h", "qlt", "q", "quality", "width", "height", "pid", "c", "rs", "dpr", "o"]) inner.searchParams.delete(p);
    return inner.hostname + inner.pathname.replace(/\/rs:[^/]*\//, "/") + inner.search;
  } catch { return ""; }
};
// CJK opening brackets (「『（【《…) carry half a character of blank space before the mark, so a title or snippet
// that starts with one looks indented next to the others: pull that first mark back by its blank half (every browser;
// CSS text-spacing-trim isn't in Firefox/Zen)
const HANG = /^[\u3008\u300A\u300C\u300E\u3010\u3014\u3016\u3018\u301A\u301D\uFF08\uFF3B\uFF5B\uFF5F]/;
const hang = (box) => {
  if (!box || [...box.children].some((c) => c.classList.contains("ct-hang"))) return;
  let n = box.firstChild;
  while (n && n.nodeType === 3 && !n.data.trim()) n = n.nextSibling;
  if (!n || n.nodeType !== 3) return;
  n.data = n.data.replace(/^\s+/, "");
  if (!HANG.test(n.data)) return;
  const sp = mk("span", "ct-hang", n.data[0]);
  n.data = n.data.slice(1);
  box.insertBefore(sp, n);
};
const row = (el) => {
  const a = el.querySelector("a.result-title");
  if (!a) return;
  if (junk(el)) { el.style.display = "none"; return; }
  if (el.dataset.ctDup || el.dataset.ctHide) return; // never shown: no cleanup, no network work
  const text = a.textContent || "";
  let u = null;
  try { u = new URL(a.href); } catch {}
  // Engines leave spaces where they bolded the search words ("slang ?", "\" shit \""): core tidyText, every tab
  const out = CT.tidyTitle(cleanTitle(text, a.href) || text.replace(/\s+/g, " ").trim());
  if (out && out !== text.replace(/\s+/g, " ").trim()) { a.title = text.trim(); a.textContent = out; }
  // Link line: just the site name, like Google on phones (the full address shows on hover)
  const cite = el.querySelector(".result-cite");
  let site = "";
  try { site = new URL(el.dataset.resultUrl || a.href).hostname.replace(/^www\./, ""); } catch {}
  // Forum threads (any tab): the community is the source ("r/Jersey", "Stack Overflow"), not repeated in the title,
  // and Reddit's "Archived post. New comments cannot be posted..." filler is dropped from the description
  const pub = CT.doiPublisher(el.dataset.resultUrl || a.href) || PUBW.get(aiKey(el.dataset.resultUrl || a.href)) || "";
  if (pub) site = pub; // "Elsevier" instead of doi.org (the address still shows on hover)
  const fn = u ? forumName(u, site) : "";
  if (fn) {
    site = fn;
    const t2 = a.textContent.replace(/\s*[:|\-–—]\s*r\/[\w-]+\s*$/i, "").trim();
    if (t2 && t2 !== a.textContent.trim()) { a.title = a.title || a.textContent.trim(); a.textContent = t2; }
    const sp = el.querySelector(".result-snippet");
    if (sp) for (const n of sp.childNodes) if (n.nodeType === 3) n.data = n.data.replace(/\s*Archived post\.\s*New comments (cannot be posted|\.\.\.)[^.]*\.?(\s*and votes cannot be cast\.?)?/gi, " ").replace(/\s{2,}/g, " ");
  }
  if (cite && site && cite.textContent.trim() !== site) { cite.title = cite.textContent.trim(); cite.textContent = site; }
  hang(a);
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
    // Same stray-space fix in every text piece of the description (bold words stay bold)
    for (const n of p0.childNodes) if (n.nodeType === 3) n.data = CT.tidyText(n.data);
    p0.querySelectorAll("b, strong, em").forEach((b) => { const x = b.firstChild; if (x && x.nodeType === 3) x.data = CT.tidyText(x.data); });
    const label = dRaw ? CT.dateLabel(dRaw) : "";
    if (label && cite) { const d = mk("span", "ct-date", label); d.dataset.raw = dRaw; cite.after(d); }
    hang(p0);
  }
  // "Paywall": a word on the source line, drawn with the result (core PAYWALL_SITES)
  if (cite && u && SHOW.pw !== false && CT.paywalled(u.hostname, PSL())) { const t = mk("span", "ct-paywall", "Paywall"); (el.querySelector(".result-url-row .ct-date") || cite).after(t); }
  // "PDF" on the source line for PDF files (any search), like the Paywall word
  if (cite && u && (/\.pdf$/i.test(u.pathname) || /(^|\.)arxiv\.org$/.test(u.hostname) && /^\/pdf\//.test(u.pathname))) { const t = mk("span", "ct-paywall ct-pdf", "PDF"); (el.querySelector(".result-url-row .ct-paywall, .result-url-row .ct-date") || cite).after(t); }
  const img = el.querySelector(".result-thumbnail-wrap img");
  // News: the same picture twice is the same story told twice (one site's two write-ups, or a syndicated copy):
  // only the first is shown. Decided here, before paint, from the picture's address (sizes ignored).
  if (img && /[?&]type=news\b/.test(location.search)) {
    const k = picKey(img.getAttribute("src") || "");
    if (k) { const seen = newsPics.get(k); if (seen && seen !== el && seen.isConnected) { el.style.display = "none"; el.dataset.ctDup = "1"; return; } newsPics.set(k, el); }
  }
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
// Relevance on the Images and Videos tabs too (same one rule as Web, on the title and site): an image or video with
// none of the search's words and not on the topic the related ones share goes behind "N unrelated images ⌄" /
// "N unrelated videos ⌄" at the end ("graphic" in a search doesn't bring porn in). Decided before paint, a batch at a time.
// ===== Image AI (ct-vision on the PC's GPU, through this plugin's server) =====
// Each picture gets a 0..1 "shows the search" score from SigLIP 2. Pictures far below this page's typical score fold
// (a dick under "kalimba" folds even when its title says kalimba); pictures the words rule folded but the AI sees as
// on-topic come back. Cards wait for their score (at most 0.9 s, pictures hidden, nothing moves) before they show.
const origOf = (src) => { try { const u = new URL(src, location.href); return /\/proxy\/image$/.test(u.pathname) ? u.searchParams.get("url") || "" : u.href; } catch { return ""; } };
// Off for this page when the AI doesn't answer, and for 10 min in this browser (no waiting on a missing AI)
let VISON = (() => { try { return Date.now() - Number(localStorage.getItem("ct-visoff") || 0) > 600000; } catch { return true; } })();
const VS = { key: "", p: new Map(), q: [], t: 0 };
const visThr = () => {
  const v = [...VS.p.values()].filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (v.length < 6) return null;
  const med = v[Math.floor(v.length / 2)];
  return { low: Math.min(0.02, med * 0.05), mid: med };
};
const visAsk = (q, urls) => bridge("vis", {}, JSON.stringify({ q, u: urls })).then((j) => {
  if (!j || !Array.isArray(j.p)) { VISON = false; try { localStorage.setItem("ct-visoff", String(Date.now())); } catch {} return null; }
  urls.forEach((u, i) => VS.p.set(u, j.p[i]));
  return j;
}).catch(() => { VISON = false; return null; });
const visQueue = (el, kind) => {
  if (!VISON) return;
  visKey();
  const u = origOf(el.querySelector("img")?.getAttribute("src") || "");
  if (!u) return;
  el.dataset.ctV = u;
  el.classList.add("ct-vpend");
  VS.q.push([el, kind]);
  if (VS.q.length === 1) queueMicrotask(visFlush);
};
const visFlush = () => {
  const batch = VS.q.splice(0);
  if (!batch.length) return;
  let q0 = "";
  try { q0 = new URL(location.href).searchParams.get("q") || ""; } catch {}
  const show = () => batch.forEach(([el]) => el.classList.remove("ct-vpend"));
  const timer = setTimeout(show, 900);
  visAsk(q0, [...new Set(batch.map(([el]) => el.dataset.ctV))]).then(() => { clearTimeout(timer); visApply(); show(); });
};
const visKey = () => { const key = searchId(location.href); if (VS.key !== key) { VS.key = key; VS.p.clear(); VS.q = []; } };
// Web's Images row: pictures the AI sees as off-topic leave the row (also when the score comes after the row is drawn)
const visRow = () => {
  const th = visThr();
  if (!th) return;
  for (const a of document.querySelectorAll(".ct-imgs .ct-im[data-ct-v]")) { const p = VS.p.get(a.dataset.ctV); if (typeof p === "number" && p < th.low) a.remove(); }
};
const visApply = () => {
  const th = visThr();
  if (!th) return;
  for (const kind of ["image", "video"]) {
    const R = MR[kind];
    const fold = [], back = [];
    for (const el of document.querySelectorAll(`.${kind}-card[data-ct-v]`)) {
      const p = VS.p.get(el.dataset.ctV);
      if (typeof p !== "number" || el.dataset.ctAi) continue;
      if (p < th.low && !el.dataset.ctUnrel) fold.push(el);
      else if (p >= th.mid && el.dataset.ctUnrel && R && R.out.includes(el)) back.push(el);
    }
    for (const el of back) { R.out.splice(R.out.indexOf(el), 1); el.style.display = ""; delete el.dataset.ctUnrel; }
    if (fold.length) { for (const el of fold) { el.style.display = "none"; el.dataset.ctUnrel = "1"; } mediaFoldAdd(kind, fold); }
    else if (back.length && R) mediaFoldAdd(kind, []);
  }
  visRow();
};
const MR = {};
const mediaRel = (el, kind, text, title) => {
  readQuery();
  const key = searchId(location.href);
  let R = MR[kind];
  if (!R || R.key !== key) { R?.btn?.closest(".ct-fold")?.remove(); R = MR[kind] = { key, q: [], rel: [], btn: null, out: [] }; }
  let q0 = "";
  try { q0 = new URL(location.href).searchParams.get("q") || ""; } catch {}
  if (!CT.relJudgeable(q0)) return;
  const r = { title: text, snippet: "" };
  if (CT.related(qWords, qIdent, text, 0, 99)) { R.rel.push(r); return; }
  if ((String(title || "").match(/[\p{L}\p{N}]+/gu) || []).length < 3) return; // no real title ("Pin", none): nothing to judge, stays
  el.style.display = "none"; el.dataset.ctUnrel = "1";
  if (!R.q.length) queueMicrotask(() => mediaFold(kind));
  R.q.push([el, r]);
};
const mediaFold = (kind) => {
  const R = MR[kind];
  const same = CT.topicOf(R.rel, qWords);
  const out = [];
  for (const [el, r] of R.q.splice(0)) { if (same(r)) { el.style.display = ""; delete el.dataset.ctUnrel; } else out.push(el); }
  if (out.length) mediaFoldAdd(kind, out);
};
const mediaFoldAdd = (kind, out) => {
  const key = searchId(location.href);
  let R = MR[kind];
  if (!R || R.key !== key) R = MR[kind] = { key, q: [], rel: [], btn: null, out: [] };
  R.out.push(...out);
  const n = R.out.length;
  const first = R.out[0];
  if (!n) { R.btn?.closest(".ct-fold")?.remove(); R.btn = null; return; }
  const grid = first.closest(".image-grid, .video-grid") || first.parentElement;
  if (!grid) return;
  let row = R.btn?.closest(".ct-fold");
  if (!row) {
    row = mk("div", "ct-fold ct-fold-img");
    const b = mk("button", "ct-fold-b", "");
    b.type = "button"; b.setAttribute("aria-expanded", "false");
    row.append(b);
    b.addEventListener("click", () => { for (const x of R.out.splice(0)) { x.style.display = ""; delete x.dataset.ctUnrel; fadeIn(x); } row.remove(); R.btn = null; });
    R.btn = b;
  }
  const w = kind === "video" ? "video" : "image";
  R.btn.replaceChildren(`${n} unrelated ${w}${n > 1 ? "s" : ""}`, mk("span", "ct-chev", "⌄"));
  grid.after(row); // after the grid, so it stays at the end as more load
};
// Image/video preview panel: the picture and the title open the page in one tap (like Google; degoog's picture opened
// a zoom view and only the button visited), and its "more images" strip leaves out what the grid folded or hid
// Unsolved-search learning (M5): which kind of block a link you open sat in goes to the server (its own private
// log; no address is sent). Layout only: it nudges block shares for searches with the same needs profile.
const SEEN_KIND = [[".ct-forum", "forums"], [".ct-paper", "papers"], [".ct-news", "news"], [".ct-video", "video"], [".ct-imgs", "image"], [".ct-kp", "info"], [".ct-ans, .ct-ai, #at-a-glance", "answer"], [".result-item", "web"]];
document.addEventListener("click", (e) => {
  const a = e.target?.closest?.("a[href]");
  if (!a || !/^https?:/.test(a.href) || !a.closest("#results-list, #at-a-glance") || !webTab) return;
  const hit = SEEN_KIND.find(([sel]) => a.closest(sel));
  if (hit) bridge("seen", { q: curQ(), k: hit[1] }, "").catch(() => {});
}, true);
document.addEventListener("click", (e) => {
  if (!e.target?.closest?.("#media-preview-img")) return;
  const a = document.querySelector("#media-preview-info .media-preview-link");
  if (!a || !a.href) return;
  e.preventDefault(); e.stopPropagation();
  if (a.target === "_blank") window.open(a.href, "_blank", "noopener"); else location.href = a.href;
}, true);
const previewPass = () => {
  const info = document.getElementById("media-preview-info");
  const h = info?.querySelector("h3.media-preview-title");
  const src = info?.querySelector(".media-preview-link");
  if (h && src && !h.querySelector("a")) {
    const a = mk("a", "ct-pv-t", h.textContent);
    a.href = src.href; if (src.target) { a.target = src.target; a.rel = "noopener"; }
    h.replaceChildren(a);
  }
  relatedStrip();
};
// "More images" under the preview = images like the one you opened (degoog drew a random 15 of all results, folded
// ones included): the grid's shown images ranked by the words they share with the opened image's title beyond the
// search's own words (17-key, mahogany, cartoon…), then by matching the search; ties keep the engines' order
const relatedStrip = () => {
  const more = document.getElementById("media-preview-more");
  const g = more?.querySelector(".media-preview-more-grid");
  if (!g || g.dataset.ct) return;
  const sel = document.querySelector(".image-card.selected, .video-card.selected");
  if (!sel) return;
  const kind = sel.classList.contains("video-card") ? "video" : "image";
  const title = (c) => { const t = c.querySelector(`.${kind}-title`); return (t && (t.title || t.textContent)) || c.querySelector("img")?.alt || ""; };
  const own = new Set(qWords);
  const mine = CT.relWords(title(sel)).filter((w) => !own.has(w));
  const pool = [...document.querySelectorAll(`.${kind}-card`)].filter((c) => c !== sel && c.style.display !== "none" && !c.dataset.ctUnrel && !c.dataset.ctAi && c.querySelector("img")?.getAttribute("src"));
  const n = Math.max(g.children.length, Math.min(15, pool.length));
  const scored = pool.map((c, i) => {
    const t = `${title(c)} ${c.querySelector(`.${kind}-source`)?.textContent || ""}`;
    return { c, i, s: 2 * CT.matchShare(mine, t) * mine.length + (CT.matchShare(qWords, t) > 0 ? 1 : 0) };
  }).sort((a, b) => b.s - a.s || a.i - b.i);
  const grid = mk("div", "media-preview-more-grid");
  grid.dataset.ct = "1";
  const draw = (list) => {
    grid.replaceChildren();
    for (const c of list.slice(0, n)) {
      const b = mk("button", "media-preview-more-item"); b.type = "button";
      const im = mk("img", "media-preview-more-img"); im.loading = "lazy"; im.src = c.querySelector("img").getAttribute("src"); im.alt = title(c);
      im.onerror = () => { b.style.display = "none"; };
      b.append(im);
      b.addEventListener("click", () => { c.click(); c.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
      grid.append(b);
    }
  };
  const words = () => draw(scored.map((x) => x.c));
  // Image AI: the ones that look most like the opened picture (waits at most 0.6 s, hidden meanwhile, so the strip
  // never reshuffles in front of you); no AI answer -> the words order
  const me = origOf(sel.querySelector("img")?.getAttribute("src") || "");
  if (VISON && me && pool.length) {
    grid.style.visibility = "hidden";
    let done = false;
    const fin = (list) => { if (done) return; done = true; if (list) draw(list); else words(); grid.style.visibility = ""; };
    setTimeout(() => fin(null), 600);
    const us = pool.map((c) => origOf(c.querySelector("img").getAttribute("src")));
    bridge("near", {}, JSON.stringify({ u: me, us })).then((j) => {
      if (!j || !Array.isArray(j.sim)) return fin(null);
      fin(pool.map((c, i) => ({ c, v: typeof j.sim[i] === "number" ? j.sim[i] : -2, i })).sort((x, y) => y.v - x.v || x.i - y.i).map((x) => x.c));
    }).catch(() => fin(null));
  } else words();
  g.replaceWith(grid);
};
// Web's own rows (Images row, Videos box) use the same rule
const relOk = (title, url) => { readQuery(); let q0 = ""; try { q0 = new URL(location.href).searchParams.get("q") || ""; } catch {} return !CT.relJudgeable(q0) || CT.related(qWords, qIdent, `${url || ""} ${title || ""}`, 0, 99) || (String(title || "").match(/[\p{L}\p{N}]+/gu) || []).length < 3; };
const card = (el, isImage) => {
  const src = el.querySelector(isImage ? ".image-source" : ".video-source");
  const t = el.querySelector(isImage ? ".image-title" : ".video-title");
  const raw = (src && src.textContent || "").trim();
  const host = raw.toLowerCase().replace(/^www\./, "");
  const text = t && t.textContent || "";
  if (t && !t.dataset.ctTidy) { t.dataset.ctTidy = "1"; const x = CT.tidyTitle(text.replace(/\s+/g, " ").trim()); if (x !== text.trim()) t.textContent = x; }
  if (!isImage) { mediaRel(el, "video", `https://${host}/ ${text}`, text); visQueue(el, "video"); return; }
  if (aiImg(host)) { el.style.display = "none"; el.dataset.ctAi = "1"; return; }
  mediaRel(el, "image", `https://${host}/ ${text}`, text);
  visQueue(el, "image");
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
  bridge(route, params).then((j) => { e.data = j || null; if (route === "kp") safe("kp", kpPass); }, () => { e.data = null; });
};
const ready = (route, key) => { const e = early.get(route); return e && e.key === key ? e.data : undefined; };
let earlyFor = "";
const earlyStart = () => {
  const key = searchId(location.href);
  if (earlyFor === key) return;
  earlyFor = key;
  early.clear();
  newsPics.clear();
  let u;
  try { u = new URL(key); } catch { return; }
  const q = (u.searchParams.get("q") || "").trim();
  if (!q) return;
  // !deepl: straight to DeepL with the text (your search box, your action), before anything else is asked
  const dl = CT.deeplUrl(q);
  if (dl) { location.replace(dl); return; }
  const from = (u.searchParams.get("ct_from") || "").trim();
  if (u.searchParams.get("type") === "images" && !q.startsWith("!")) visualSeen.add(qHash(q));
  ask("fix", key, { q, ...(u.searchParams.has("ct_keep") ? { keep: 1 } : {}), ...(u.searchParams.has("ct_acc") && from ? { acc: from } : {}) });
  if (webTab && Number(u.searchParams.get("page") || 1) <= 1 && !q.startsWith("!")) {
    ask("qs", key, { q });
    // Versions / support (endoflife.date): only the product name is sent; drawn with the results if in hand by then
    const eq = SHOW.ans !== false && CT.eolQuery(q);
    if (eq) ask("eol", key, { p: eq.slug });
    // Facts (Wikidata): only the fact asked and the subject's name are sent
    const wq = SHOW.ans !== false && !eq && !CT.answer(q, Date.now(), { fx: FX }) && CT.wdQuery(q);
    if (wq) ask("wd", key, { f: wq.fact, s: wq.s, ...(wq.s2 ? { s2: wq.s2 } : {}) });
    // CMU course card: "15-213" (and "15213", which the server answers only if that course exists: it's also a ZIP)
    const cq = SHOW.ans !== false && cmuQ(q);
    if (cq && cq.level) ask("cmu", key, { id: cq.id });
    // A team's game (ESPN): short searches made of words only go to this server, which knows the team names
    if (SHOW.ans !== false && !eq && !wq && !cq && /^[a-z][a-z .'&-]*$/i.test(q) && q.split(/\s+/).length <= 6 && !CT.answer(q, Date.now(), { fx: FX })) ask("sports", key, { q });
    // Knowledge panel: only the name is sent (this server asks Wikidata/Wikipedia); shown only if the results agree
    if (!eq && !wq && !cq && (SHOW.kp !== false || SHOW.mean !== false) && kpWanted(q)) ask("kp", key, { q: CT.kpQuery(q) });
    // Images row (spec 12): the image search starts now, in parallel, for clearly visual searches: picture words, or
    // a search you opened the Images tab for in the last 12 h (degoog still has that image search cached)
    // ...or when the needs call (one GPU pass, asked now) says pictures serve this search better than an even split
    // of the formats (1 / number of formats). No AI answer: picture searches only, as before.
    const imgGo = () => {
      if (early.get("img")?.key === key) return;
      const e = { key, data: undefined };
      early.set("img", e);
      fetch(`/api/search?q=${encodeURIComponent(q)}&type=images`).then((x) => (x.ok ? x.json() : null))
        .then((j) => {
          e.data = j && Array.isArray(j.results) ? j : null;
          // Image AI scores the row's pictures now, in parallel with the web results
          if (e.data && VISON) { visKey(); visAsk(q, [...new Set(e.data.results.slice(0, 40).map((x) => origOf(x.thumbnail || "")).filter(Boolean))]).then(visRow); }
        }, () => { e.data = null; });
    };
    // One search of another degoog type (news, forums, science), kept for this page as early[name]
    const typeGo = (name, type) => {
      if (early.get(name)?.key === key) return;
      const e = { key, data: undefined };
      early.set(name, e);
      fetch(`/api/search?q=${encodeURIComponent(q)}&type=${type}`).then((x) => (x.ok ? x.json() : null))
        .then((j) => { e.data = j && Array.isArray(j.results) ? j : null; }, () => { e.data = null; });
    };
    const pic = SHOW.img !== false && !shaped(q) && (CT.visualQ(q) || visualSeen.has(qHash(q)));
    if (pic) imgGo();
    if (!shaped(q)) {
      const e = { key, data: undefined };
      early.set("needs", e);
      bridge("needs", { q }).then((j) => {
        e.data = j && j.n ? j.n : null;
        const f = e.data && CT.fmtShares(e.data.f);
        if (f && SHOW.img !== false && f.image > 1 / Object.keys(f).length) imgGo();
        // Forums, Top stories, papers (M2): fetched only when the block could beat the last result on the first
        // screen (share x a perfect fit > the server's measured cutoff, core blockGo)
        const go = (k) => CT.blockGo(CT.blockShare(f, e.data && e.data.b, k), e.data && e.data.cut);
        if (SHOW.forum !== false && go("forums")) typeGo("forums", "forums");
        if (SHOW.news !== false && go("news")) typeGo("news", "news");
        if (SHOW.papers !== false && go("papers")) typeGo("papers", "science");
      }, () => { e.data = null; });
    }
    // Top stories: the News search starts now, in parallel, only for a search that looked like news last time
    if (SHOW.news && !shaped(q) && newsy.has(qHash(q))) typeGo("news", "news");
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
  // Quick view (spec 11) and archived copy (spec 10): nothing is asked until you tap them
  if (SHOW.qv !== false) {
    const qv = mk("button", "degoog-menu-item ct-arch ct-qv-b", "Quick view");
    qv.type = "button";
    qv.setAttribute("role", "menuitem");
    menu.append(qv);
  }
  if (SHOW.arch !== false) {
    const ar = mk("button", "degoog-menu-item ct-arch", "Open archived copy");
    ar.type = "button";
    ar.setAttribute("role", "menuitem");
    menu.append(ar);
  }
};
// Tap: a new tab opens at once (so the browser allows it) and goes to the copy the server found: archive.today first
// for paywalled sites, else the Wayback Machine, else Ghostarchive; none -> archive.today's save page
document.addEventListener("click", async (e) => {
  const b = e.target.closest && e.target.closest(".ct-arch:not(.ct-qv-b)");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const el = b.closest(".result-item");
  const a = el && el.querySelector("a.result-title");
  const u = (el && el.dataset.resultUrl) || (a && a.href) || "";
  if (!u) return;
  let pw = false;
  try { pw = CT.paywalled(new URL(u).hostname, PSL()); } catch {}
  const menu = b.closest(".result-actions-menu");
  if (menu) menu.hidden = true;
  const w = window.open("", "_blank");
  if (w) { try { w.opener = null; w.document.title = "Archived copy"; w.document.body.textContent = "Finding an archived copy…"; } catch {} }
  const j = await bridge("arch", { u, ...(pw ? { pw: 1 } : {}) }).catch(() => null);
  const to = (j && j.a && /^https:\/\//.test(j.a.url) && j.a.url) || `https://archive.ph/?url=${encodeURIComponent(u)}`;
  if (w && !w.closed) w.location.replace(to); else location.assign(to);
}, true);
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
  else if (pref === "prefer") { const kpEl = [...list.children].find((x) => x.classList.contains("ct-kp")); if (kpEl) kpEl.after(...rows); else list.prepend(...rows); }
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
  if (!q || page > 1 || q.startsWith("!") || shaped(q)) return;
  ((j) => {
      // Not in hand when the results came (or none): dropped for this search
      if (!j || !Array.isArray(j.q)) return;
      if (j.q.length < 2) return;
      const box = document.createElement("div");
      box.id = "ct-qa";
      const h = document.createElement("h3");
      h.textContent = "People also ask";
      box.append(h);
      // Words written the way your results write them ("putty" -> "PuTTY", "paris" -> "Paris"): a form with capitals
      // inside it (PuTTY, iPhone, NASA) from titles or text, or a capitalised word the result text writes that way
      // mid-sentence most of the time (names); title case ("Day Old Tea") never counts
      const cased = new Map(), mid = new Map();
      const add = (m, k, w) => { const x = m.get(k) || new Map(); x.set(w, (x.get(w) || 0) + 1); m.set(k, x); };
      // ALL-CAPS in a title is shouting ("WHY - English meaning"), not how the word is spelled: titles teach only
      // mixed forms (PuTTY, iPhone); acronyms (NASA) are learned from the descriptions
      for (const r of document.querySelectorAll("#results-list .result-item :is(.result-title, .result-snippet)")) { const ttl = r.classList.contains("result-title"); for (const w of r.textContent.match(/[\p{L}\p{N}][\p{L}\p{N}'+.#-]*/gu) || []) if (/\p{Lu}/u.test(w.slice(1)) && !(ttl && w === w.toUpperCase())) add(cased, w.toLowerCase(), w); }
      for (const r of document.querySelectorAll("#results-list .result-item .result-snippet")) {
        const toks = r.textContent.split(/\s+/);
        for (let i = 1; i < toks.length; i++) { const w = toks[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""); if (w && !/[.!?:…]$/.test(toks[i - 1])) add(mid, w.toLowerCase(), w); }
      }
      const pick = (k) => {
        const c = cased.get(k);
        if (c) return [...c].sort((a, b) => b[1] - a[1])[0][0];
        const m = mid.get(k);
        if (!m) return null;
        const up = [...m].filter(([w]) => /^\p{Lu}/u.test(w)).reduce((n, [, v]) => n + v, 0), all = [...m].reduce((n, [, v]) => n + v, 0);
        return up >= 2 && up * 3 >= all * 2 ? k[0].toUpperCase() + k.slice(1) : null;
      };
      const fixCase = (t) => t.replace(/[\p{L}\p{N}][\p{L}\p{N}'+.#-]*/gu, (w, i) => {
        const k = w.toLowerCase(), m = mid.get(k);
        const lowMostly = m && [...m].filter(([x]) => x === k).reduce((n, [, v]) => n + v, 0) * 2 > [...m].reduce((n, [, v]) => n + v, 0);
        const best = pick(k) || (lowMostly ? k : w); // no evidence either way: as the suggestion wrote it
        if (i === 0 && CT.QA_LEAD.test(k)) return k[0].toUpperCase() + k.slice(1); // "Why", never "WHY"
        return i === 0 ? best[0].toUpperCase() + best.slice(1) : best;
      });
      // Answers are fetched as the box comes near the screen, so a tap shows one at once; a question no page answers
      // is taken out before you get to it (no "Search for" stand-ins); fewer than 2 left: no box
      const ans = new Map();
      // The answer: of the question's top 8 results, the passage the answer AI (a reranker on the PC's GPU) says answers it
      // best; too weak an answer = no answer. Without the AI: the first result with a description.
      const get = (text) => ans.get(text) || ans.set(text, fetch(`/api/search?q=${encodeURIComponent(text)}`).then((r) => (r.ok ? r.json() : null))
        .then(async (sj) => {
          // Only results about the question's own words ("nose", "dry"), not just its question word ("why")
          const c = (sj && Array.isArray(sj.results) ? sj.results : []).filter((x) => x && x.url && x.snippet).slice(0, 8).filter((x) => CT.qaAbout(text, `${x.title || ""} ${x.snippet}`));
          if (!c.length) return null;
          const strip = (t) => String(t || "").replace(/<[^>]+>/g, "").trim();
          const j = await bridge("rank", {}, JSON.stringify({ q: text, d: c.map((x) => `${strip(x.title)}. ${strip(x.snippet)}`) })).catch(() => null);
          if (!j || !Array.isArray(j.s)) return c[0];
          let bi = -1;
          j.s.forEach((v, i) => { if (typeof v === "number" && (bi < 0 || v > j.s[bi])) bi = i; });
          return bi >= 0 && j.s[bi] >= 0.02 ? c[bi] : null; // the best of them unless none is about the question at all
        }).catch(() => null)).get(text);
      // One page answers one question: a page already answering another question isn't repeated under this one
      const used = new Map();
      const own = (text) => (top) => { if (!top) return null; const u = used.get(top.url); if (u && u !== text) return null; used.set(top.url, text); return top; };
      const drop = (d) => { d.remove(); if (box.querySelectorAll("details").length < 2) { box.remove(); if (paaBox === box) paaBox = null; } }; // gone for good (not put back after a redraw)
      const items = [];
      for (const raw of j.q) {
        const text = fixCase(raw);
        const d = document.createElement("details");
        const s = document.createElement("summary");
        s.textContent = text;
        const body = document.createElement("div");
        body.className = "ct-qa-a";
        d.append(s, body);
        items.push([d, text]);
        d.addEventListener("toggle", () => {
          if (!d.open || body.dataset.done) return;
          body.dataset.done = "1";
          body.textContent = "Loading…";
          get(text).then(own(text)).then((top) => {
            body.textContent = "";
            if (!top) { drop(d); return; }
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
          });
        });
        box.append(d);
      }
      const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        for (const [d, text] of items) get(text).then(own(text)).then((top) => { if (!top && !d.open) drop(d); });
      }, { rootMargin: "600px 0px" }) : null;
      if (io) io.observe(box);
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
  tabsEdge();
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
    if (!TOUCH.matches) f.elements.all.focus();
  });
};


// ⚑ at the right end of the tab row (phone and PC): "What's wrong? (optional)" + Save keeps the search, your note and
// its top 10 results on your server. Nothing else shows (no count, no send link): the local model decides when they're
// worth a Claude session and the PC's hourly job sends them by itself. Anything about the box itself goes in the same box.
const flagTop = () => {
  const out = [];
  for (const el of document.querySelectorAll("#results-list .result-item, #results-list .image-card, #results-list .video-card")) {
    if (el.style.display === "none") continue;
    const a = el.querySelector("a.result-title") || el.querySelector("a[href]");
    const url = el.dataset.resultUrl || (a && a.href) || "";
    if (!/^https?:/.test(url)) continue;
    const ai = AIW.get(aiKey(url));
    out.push({ ai: ai && typeof ai.p === "number" ? Math.round(ai.p * 1000) / 1000 : null, url, title: (((el.querySelector("a.result-title, .image-title, .video-title") || a || {}).textContent) || "").trim().slice(0, 200), snippet: (el.querySelector(".result-snippet")?.textContent || "").trim().slice(0, 300) });
    if (out.length >= 10) break;
  }
  return out;
};
// Attached to every ⚑: viewport, load timings (page + each /api call, ms) and which blocks were showing (each visible
// child of the glance area and the results list, by its first class, with a count). Read from the page, no fixed list.
const flagCtx = () => {
  const load = {};
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) { load.page = nav.domContentLoadedEventEnd; load.pageLoad = nav.loadEventEnd; }
    for (const r of performance.getEntriesByType("resource")) {
      let u; try { u = new URL(r.name); } catch { continue; }
      if (u.origin !== location.origin || !/\/api\//.test(u.pathname)) continue;
      const k = u.pathname.replace(/^.*\/api\//, "").slice(0, 40);
      load[k] = Math.max(load[k] || 0, r.duration);
    }
  } catch {}
  const boxes = [];
  for (const id of ["at-a-glance", "results-list"]) {
    const root = document.getElementById(id);
    if (!root) continue;
    for (const el of root.children) {
      if (el.style.display === "none" || el.hidden || !el.getClientRects().length) continue;
      const k = `${id} > ${el.classList[0] || el.id || el.tagName.toLowerCase()}`;
      const last = boxes[boxes.length - 1];
      if (last && last.box === k) last.n++; else boxes.push({ box: k, n: 1 });
    }
  }
  return { ver: typeof CT_VER === "string" ? CT_VER : "", vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, phone: PHONE.matches, load, boxes };
};
const curType = () => { try { return new URL(location.href).searchParams.get("type") || tabNow || "web"; } catch { return tabNow || "web"; } };
const flagBox = (btn) => {
  let box = document.getElementById("ct-flagbox");
  // A floating card (popover under the ⚑ on PC, bottom sheet on phone): never pushes the results down
  const close = () => {
    document.getElementById("ct-flagbox")?.remove(); document.getElementById("ct-flagscrim")?.remove();
    btn.setAttribute("aria-expanded", "false"); removeEventListener("keydown", esc); removeEventListener("resize", place);
    if (vv) { vv.removeEventListener("resize", place); vv.removeEventListener("scroll", place); }
    document.documentElement.classList.remove("ct-sheet-open");
  };
  const esc = (e) => { if (e.key === "Escape") { close(); btn.focus(); } };
  const vv = window.visualViewport;
  const place = () => {
    const b = document.getElementById("ct-flagbox");
    if (!b) return;
    // Phone sheet: pinned to the part of the screen that's actually visible (visualViewport), so an open keyboard,
    // the browser's bars or iOS scrolling the page for the focused box never leave a gap or hide part of it
    if (TOUCH.matches) {
      b.style.top = b.style.left = "";
      if (vv) { b.style.bottom = `${Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))}px`; b.style.maxHeight = `${Math.round(vv.height - 8)}px`; }
      return;
    }
    b.style.bottom = b.style.maxHeight = "";
    const r = btn.getBoundingClientRect(), w = b.offsetWidth || 440;
    b.style.top = `${Math.round(r.bottom + scrollY + 6)}px`;
    b.style.left = `${Math.round(Math.max(12, Math.min(r.right - w, innerWidth - w - 12)) + scrollX)}px`;
  };
  if (box) { close(); return; }
  btn.setAttribute("aria-expanded", "true");
  box = document.createElement("form");
  box.id = "ct-flagbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Report a problem");
  const chips = mk("div", "ct-flag-cats", "");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "What's wrong?");
  for (const [id, name] of CT.FLAG_CATS) {
    const c = mk("button", "ct-flag-cat", name);
    c.type = "button"; c.dataset.cat = id; c.setAttribute("aria-pressed", "false");
    c.addEventListener("click", () => c.setAttribute("aria-pressed", c.getAttribute("aria-pressed") === "true" ? "false" : "true"));
    chips.append(c);
  }
  const l = mk("label", "", "");
  const t = document.createElement("textarea");
  t.rows = 2; t.maxLength = 1000; t.setAttribute("autocapitalize", "sentences");
  t.placeholder = "Anything else? (optional)"; t.setAttribute("aria-label", "Anything else? (optional)");
  l.append(t);
  const save = mk("button", "", "Save");
  save.type = "submit";
  const st = mk("span", "ct-flag-st", "");
  const acts = mk("div", "ct-flag-acts", "");
  // Which version this page runs (the auto-update installs new ones by itself): quiet, at the row's far end
  acts.append(save, st, mk("span", "ct-flag-ver", `clean-titles ${typeof CT_VER === "string" ? CT_VER : ""}`));
  const head = mk("div", "ct-flag-top", "");
  const x = mk("button", "ct-flag-x", "×");
  x.type = "button"; x.setAttribute("aria-label", "Close"); x.addEventListener("click", close);
  head.append(mk("span", "ct-flag-h", "What's wrong?"), x);
  box.append(head, chips, l, acts);
  box.addEventListener("submit", (e) => {
    e.preventDefault(); e.stopPropagation();
    save.disabled = true; st.textContent = "";
    const cats = [...chips.querySelectorAll('[aria-pressed="true"]')].map((c) => c.dataset.cat);
    bridge("flag", {}, JSON.stringify({ q: curQ(), type: curType(), cats, note: t.value.trim(), ctx: flagCtx(), top: flagTop() })).then((j) => {
      save.disabled = false;
      if (!j) { st.textContent = "Couldn't save. Try again."; return; }
      t.value = ""; chips.querySelectorAll(".ct-flag-cat").forEach((c) => c.setAttribute("aria-pressed", "false")); st.textContent = "Saved.";
      setTimeout(() => { if (box.isConnected) close(); }, 1200);
    }).catch(() => { save.disabled = false; st.textContent = "Couldn't save. Try again."; });
  });
  const scrim = mk("div", "", "");
  scrim.id = "ct-flagscrim";
  scrim.addEventListener("click", close);
  document.body.append(scrim, box);
  place();
  addEventListener("keydown", esc); addEventListener("resize", place);
  if (vv) { vv.addEventListener("resize", place); vv.addEventListener("scroll", place); }
  // the page behind stays still while the sheet is open (no scrolling the results under it)
  if (TOUCH.matches) document.documentElement.classList.add("ct-sheet-open");
  if (!TOUCH.matches) t.focus();
};
// ⚑ sits in the header right after the settings gear (same round button); its box still opens over the results
const flagPlace = () => {
  const f = document.getElementById("ct-flag"), g = document.getElementById("nav-settings-results");
  if (!f || !g) return;
  // phone: the gear is pinned to the header's top right, so ⚑ is pinned just left of it at the same height
  if (PHONE.matches) { f.style.top = `${g.offsetTop}px`; f.style.right = `${g.offsetParent ? g.offsetParent.clientWidth - g.offsetLeft : 0}px`; f.style.height = `${g.offsetHeight}px`; }
  else f.style.top = f.style.right = f.style.height = "";
};
const flagBtn = () => {
  const g = document.getElementById("nav-settings-results");
  if (!g || document.getElementById("ct-flag") || !curQ()) return;
  const f = document.createElement("button");
  f.type = "button";
  f.id = "ct-flag";
  f.title = "Report a problem with these results";
  f.setAttribute("aria-label", "Report a problem with these results");
  f.setAttribute("aria-expanded", "false");
  f.addEventListener("click", () => flagBox(f));
  f.textContent = "⚑";
  g.after(f);
  flagPlace();
  if (!flagPlace.on) { flagPlace.on = 1; PHONE.addEventListener("change", flagPlace); addEventListener("resize", flagPlace); }
};
// Gap from the tab row to the first thing under it (answer card, info panel or the first result's source line):
// measured, so empty or hidden blocks above the results can't add to it; the same on every tab and screen size
const topGap = () => {
  const tabs = document.getElementById("results-tabs"), lay = document.getElementById("results-layout");
  if (!tabs || !lay || lay.classList.contains("media-mode")) { lay?.style.removeProperty("--ct-top"); return; }
  let top = Infinity;
  for (const e of lay.querySelectorAll("#ct-fix, #at-a-glance > *, #sidebar-col > *, .result-item .result-url-row, .skeleton-card, .command-result")) {
    const r = e.getBoundingClientRect();
    if (r.height > 0 && r.top < top) top = r.top;
  }
  if (top === Infinity) return;
  const cur = parseFloat(lay.style.getPropertyValue("--ct-top")) || 0;
  const want = TOUCH.matches ? 16 : 20;
  const next = Math.round(cur + want - (top - tabs.getBoundingClientRect().bottom));
  if (Math.abs(next - cur) >= 1) lay.style.setProperty("--ct-top", `${next}px`);
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
// A YouTube link's video id (watch?v=, youtu.be/, shorts/, live/, embed/), else ""
const ytId = (u) => {
  try {
    const h = u.hostname.replace(/^(www|m|music)\./, "");
    const id = h === "youtu.be" ? u.pathname.slice(1) : h === "youtube.com" ? (u.searchParams.get("v") || (/^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(u.pathname) || [])[1] || "") : "";
    return /^[\w-]{11}$/.test(id) ? id : "";
  } catch { return ""; }
};
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
const hashStore = (KEY) => {
  let m = {};
  try { const c = JSON.parse(localStorage.getItem(KEY) || "{}"); if (c && typeof c === "object") m = c; } catch {}
  const now = Date.now();
  for (const k of Object.keys(m)) if (!(now - m[k] < 432e5)) delete m[k];
  return {
    has: (h) => h in m,
    add: (h) => {
      m[h] = Date.now();
      const ks = Object.keys(m); if (ks.length > 300) ks.sort((a, b) => m[a] - m[b]).slice(0, ks.length - 300).forEach((k) => delete m[k]);
      try { localStorage.setItem(KEY, JSON.stringify(m)); } catch {}
    },
  };
};
const newsy = hashStore(NEWSY_KEY);
// Searches you opened the Images tab for (same hash, 12 h = degoog's cache, so their image search is still cached)
const visualSeen = hashStore("ct-visual");
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
    const ai = AIW.get(aiKey(el.dataset.resultUrl || a.href));
    if (ai) { r.ai = ai.p; r.best = ai.best; }
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
  // YouTube results often come without a picture (or one that fails): your server signs the video's own still
  // (i.ytimg.com hqdefault, which every video has) so it loads through degoog's image proxy. It fades into the
  // box that is already there, so nothing moves.
  const yid = ytId(r.u);
  if (r.thumb || yid) {
    const i = mk("img"); i.alt = ""; i.loading = "lazy";
    let late = !r.thumb;
    const fill = () => { i.classList.add("ct-late"); i.onload = () => i.classList.add("ct-in"); bridge("yt", { id: yid }).then((j) => { if (j && j.to && i.isConnected) i.src = j.to; else i.remove(); }).catch(() => i.remove()); };
    i.onerror = () => { if (!late && yid) { late = true; fill(); } else i.remove(); };
    if (r.thumb) i.src = r.thumb; else fill();
    pic.append(i);
  }
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
let SHOW = { sl: true, forum: true, video: true, news: true, papers: true, ans: true, kp: true, img: true, qv: true, arch: true, mean: true, stars: true, plain: true, pw: true };
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
    G = { key, sl: null, slTop: null, forum: null, video: null, paper: null, news: false, img: false, cut: false };
  }
  for (const k of ["forum", "video", "paper", "sl"]) if (G[k] && !G[k].isConnected) G[k] = null; // degoog redrew the list
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
  // extra: items from a search of that kind fetched for this page (no element; only when the box is first drawn,
  // so a box never grows after paint because of them)
  const box = (kind, test, max, build, title, tab, label, isRow, at, extra) => {
    let c = rows.filter((r) => r !== top && test(r) && !used(r.el) && !r.el.dataset.ctUnrel);
    let s = G[kind];
    if (!s && extra && extra.length) {
      const have = new Set(rows.map((r) => r.href.split("#")[0]));
      c = c.concat(extra.filter((r) => !have.has(r.href.split("#")[0]) && have.add(r.href.split("#")[0])));
    }
    if (!s && c.length < 2) return;
    if (!s) {
      s = G[kind] = section(`ct-${kind}`, title);
      if (isRow) { const [wrap, row] = scroller(); s.append(wrap); s.row = row; s.wrap = wrap; } else { s.row = mk("div", "ct-list"); s.append(s.row); }
      const first = c.find((r) => r.el && r.el.style.display !== "none") || c.find((r) => r.el);
      if (at && at.before) at.before.before(s); else if (at && at.after) at.after.after(s); else if (first) first.el.before(s); else top.el.after(s);
      const m = moreBtn(label, tab); if (m) s.append(m);
    }
    const n = s.row.children.length;
    for (const r of c.slice(0, Math.max(0, max - n))) { s.row.append(build(r)); r.el?.classList.add("ct-grouped"); }
    s.wrap?.upd();
  };
  if (shaped()) return; // a plain list of the type asked for: no boxes or rows
  // Every box goes where it's worth more than the results (CT.boxAt): videos and images by the needs call's format
  // shares, forums / top stories / papers by their block share (CT.blockShare), each x how well its items fit.
  // Without the AI: degoog's own order, as before.
  const needs = ready("needs", key), fmt = CT.fmtShares(needs?.f);
  const bShare = (k) => CT.blockShare(fmt, needs?.b, k);
  const place = (worth) => {
    const v = [...list.querySelectorAll(".result-item")].filter((el) => shown(el) && !info(el)?.video && !used(el));
    if (!fmt || worth == null || !v.length) return null;
    const i = CT.boxAt(fmt, v.map((el) => info(el)?.ai), worth);
    return i >= v.length ? { after: v[v.length - 1] } : { before: v[i] };
  };
  const worthOf = (share, rels) => (share == null ? null : CT.boxWorth({ v: share }, rels, "v"));
  // A fetched search's results as box items (same shape as info()), the AI score riding along as ctRel
  const fetched = (name, forumOf) => {
    const j = ready(name, key);
    return (j && j.results || []).map((x) => {
      let u; try { u = new URL(x.url); } catch { return null; }
      const h = u.hostname.replace(/^(www|m|old)\./, "");
      return { u, h, href: x.url, title: cleanTitle(String(x.title || ""), x.url) || String(x.title || ""), snippet: String(x.snippet || ""), fav: x.favicon || "",
        w: x.publishedAt ? { t: Date.parse(`${x.publishedAt}T12:00:00Z`), exact: false } : null, ai: typeof x.ctRel === "number" ? x.ctRel : undefined, forum: forumOf(u, h) };
    }).filter((r) => r && r.title && relOk(r.title, r.href));
  };
  if (SHOW.forum) {
    const ex = G.forum ? [] : fetched("forums", (u, h) => forumName(u, h) || siteName(h));
    const fs = bShare("forums");
    box("forum", (r) => !!r.forum, 4, forumRow, "Discussions and forums", "forums", "More discussions", false,
      fs == null || G.forum ? null : place(worthOf(fs, rows.filter((r) => r.forum && r !== top).map((r) => r.ai).concat(ex.map((r) => r.ai)))), ex);
  }
  if (SHOW.papers !== false && !G.paper) {
    const ex = fetched("papers", (u, h) => siteName(h));
    const ps = bShare("papers");
    if (ps != null && ex.length >= 2) box("paper", () => false, 4, forumRow, "Research papers", "science", "More papers", false, place(worthOf(ps, ex.map((r) => r.ai))), ex);
  }
  // First-screen cutoff sample for the server (M2): the worth of the last result on screen, once per search,
  // measured after this pass is laid out, only while the page is still at the top
  if (fmt && !G.cut) {
    G.cut = true;
    requestAnimationFrame(() => {
      if (scrollY > 40 || searchId(location.href) !== key) return;
      const v = [...list.querySelectorAll(".result-item")].filter((el) => shown(el) && el.getBoundingClientRect().top < innerHeight);
      const r = v.length && info(v[v.length - 1]);
      if (r && typeof r.ai === "number") bridge("cut", { w: (fmt.text * r.ai).toFixed(4) }).catch(() => {});
    });
  }
  if (SHOW.video) box("video", (r) => r.video, 8, videoCard, "Videos", "videos", "More videos", true, place(CT.boxWorth(fmt, rows.filter((r) => r.video).map((r) => r.ai), "video")));

  // Images row: drawn after the first result in this same pass, only if the image search is already in hand
  if (!G.img) {
    G.img = true;
    const j = ready("img", key);
    const at = j && place(CT.boxWorth(fmt, (j.results || []).map((x) => x && x.ctRel), "image"));
    const t = j && [...list.querySelectorAll(".result-item")].find(shown);
    const th = visThr();
    const pics = j ? (j.results || []).filter((x) => x && x.thumbnail && x.url && relOk(x.title, x.url) && !(th && VS.p.get(origOf(x.thumbnail)) < th.low) && !aiImg((() => { try { return new URL(x.url).hostname.replace(/^www\./, ""); } catch { return ""; } })())).slice(0, 12) : [];
    if (t && pics.length >= 4) {
      const s = section("ct-imgs", "Images");
      const [wrap, row] = scroller();
      for (const x of pics) {
        const a = mk("a", "ct-im"); a.href = x.url; a.rel = "noopener"; a.dataset.ctV = origOf(x.thumbnail);
        a.title = String(x.title || "");
        const i = mk("img"); i.alt = String(x.title || ""); i.decoding = "async"; i.loading = "lazy";
        i.onload = () => i.classList.add("ct-on"); i.onerror = () => { i.style.visibility = "hidden"; };
        i.src = x.thumbnail;
        a.append(i); row.append(a);
      }
      s.append(wrap);
      const m = moreBtn("More images", "images"); if (m) s.append(m);
      if (at && at.before) at.before.before(s); else if (at) at.after.after(s); else t.after(s);
      wrap.upd();
    }
  }
  // Top stories: only when the results look like news (hot). Drawn in this same pass, before paint, and only if the
  // News answer started at page load is already in hand; otherwise nothing is added and the search is remembered,
  // so the next visit starts the News search early. Fresh stories only, one per outlet, none already shown.
  if (SHOW.news && !G.news) {
    const ns = bShare("news");
    if (ns == null && !hot(rows)) return;
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
      return { h, href: x.url, title: cleanTitle(String(x.title || ""), x.url) || String(x.title || ""), w, thumb: x.thumbnail || "", fav: x.favicon || "", ai: x.ctRel };
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
    const at = place(worthOf(ns, items.map((r) => r.ai)));
    if (at && at.before) at.before.before(s); else if (at) at.after.after(s); else t.after(s);
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
  // Every search gets the AI spot at the top unless something else fills it (an answer, a featured snippet, the
  // phone's knowledge panel card: they take its place) or the search wants a plain list (type words, site, shape)
  if (TYPE_WORDS.test(q) || shaped(q) || bangFor(q) || /\bbest buy\b/i.test(q)) return false;
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
const AIS = { key: "", got: false, fail: false, open: false, t: 0, shape: undefined, asked: false };
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
  if (AIS.key !== key) { clearTimeout(AIS.t); Object.assign(AIS, { key, got: false, fail: false, open: false, t: 0, shape: undefined, asked: false }); }
  // Answer shape (M4): decided by the needs call while ai-summary's panel hasn't come yet; the shaped answer fills
  // this same spot (same size, so nothing moves) and ai-summary's panel stays hidden. Text from ai-summary's model.
  if (aiVal && AIS.shape === undefined) { const nd = ready("needs", key); if (AIS.got || nd === null) AIS.shape = ""; else if (nd) AIS.shape = CT.shapePick(nd); }
  let n = 0;
  for (const p of g.querySelectorAll(".glance-ai")) {
    const w = [...g.children].find((c) => c.contains(p)) || p;
    // Not an AI search (or a second panel, or a shaped answer has the spot): never drawn
    if (!aiVal || AIS.shape || n++) { w.style.display = "none"; w.dataset.ctHid = "1"; w.classList.remove("ct-ai-panel"); continue; }
    if (w.dataset.ctHid) { delete w.dataset.ctHid; w.style.display = ""; } // shown again after a shaped answer fell through
    w.classList.add("ct-ai-panel");
    AIS.got = true;
    if (p.querySelector('.glance-ai-stream[data-state="error"]')) AIS.fail = true;
  }
  if (!aiVal) return;
  if (!AIS.shape && AIS.got && !n) AIS.fail = true; // ai-summary took its panel away ("hide on error")
  if (AIS.shape && !AIS.asked && document.querySelector("#results-list .result-item")) shapeAsk(g, key);
  if (!AIS.got && !AIS.t && drawnFor === key) AIS.t = setTimeout(() => { if (!AIS.got && AIS.key === key) { AIS.fail = true; const b = document.querySelector("#at-a-glance > .ct-ai"); if (b) b.classList.add("ct-ai-fail"); } }, 12000);
  let box = [...g.children].find((c) => c.classList.contains("ct-ai"));
  if (!box) { g.style.display = ""; box = aiBox(); g.prepend(box); }
  box.classList.toggle("ct-ai-fail", AIS.fail);
  box.classList.toggle("ct-ai-open", AIS.open && !AIS.fail);
  box.classList.toggle("ct-shape", !!AIS.shape);
  g.classList.toggle("ct-ai-opened", AIS.open && !AIS.fail && !AIS.shape);
};
// The top results as the model sees them (title, snippet, address)
const topRes = (n) => [...document.querySelectorAll("#results-list .result-item")].filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped")).slice(0, n).map(info).filter(Boolean)
  .map((r) => ({ t: r.title, s: r.snippet, u: r.href, h: r.h }));
const SHAPE_NAME = { steps: "Steps", compare: "Comparison", timeline: "Timeline", chart: "Chart" };
const shapeAsk = (g, key) => {
  AIS.asked = true;
  AIS.got = true; // the spot is ours now: ai-summary's timeout doesn't apply
  const q = curQ(), rs = topRes(6), k = AIS.shape;
  const back = () => { if (AIS.key !== key) return; AIS.shape = ""; AIS.got = false; clearTimeout(AIS.t); AIS.t = 0; aiPass(g, key); }; // no shaped answer: ai-summary's own text shows in the spot
  bridge("shape", {}, JSON.stringify({ q, k, r: rs })).then((j) => {
    if (AIS.key !== key) return;
    const a = j && j.a, box = [...g.children].find((c) => c.classList.contains("ct-ai"));
    if (!a || !box) return back();
    box.querySelector(".ct-ai-label").replaceChildren(mk("span", "ct-ai-star", "✦"), ` AI summary · ${SHAPE_NAME[a.k] || ""}`);
    box.querySelector(".ct-ai-text").append(shapeBody(a, rs));
    box.classList.add("ct-shaped");
  }, back);
};
const shapeBody = (a, rs) => {
  const body = mk("div", "ct-sh");
  if (a.k === "steps") { const ol = mk("ol", "ct-sh-steps"); a.steps.forEach((x) => ol.append(mk("li", "", x))); body.append(ol); }
  else if (a.k === "timeline") { const ol = mk("ol", "ct-sh-time"); a.events.forEach(([d, e]) => { const li = mk("li"); li.append(mk("span", "ct-sh-d", d), mk("span", "", e)); ol.append(li); }); body.append(ol); }
  else if (a.k === "compare") {
    const t = mk("table", "ct-sh-table"), hd = mk("tr");
    hd.append(mk("th"), ...a.cols.map((c) => mk("th", "", c)));
    t.append(hd);
    a.rows.forEach((r) => { const tr = mk("tr"); tr.append(mk("th", "", r[0]), ...r.slice(1).map((c) => mk("td", "", c))); t.append(tr); });
    body.append(t);
  } else if (a.k === "chart") {
    const max = Math.max(...a.bars.map((b) => b[1])) || 1, box = mk("div", "ct-sh-bars");
    a.bars.forEach(([l, v]) => { const row = mk("div", "ct-sh-bar"), tr = mk("span", "ct-sh-tr"), fill = mk("span", "ct-sh-fill"); fill.style.width = `${(100 * v) / max}%`; tr.append(fill); row.append(mk("span", "ct-sh-l", l), tr, mk("span", "ct-sh-v", `${v.toLocaleString()}${a.unit ? ` ${a.unit}` : ""}`)); box.append(row); });
    body.append(box);
  }
  const src = (a.src || []).map((i) => rs[i]).filter(Boolean);
  if (src.length) { const p = mk("div", "ct-sh-src"); p.append("From "); src.forEach((r, i) => { if (i) p.append(" · "); const l = mk("a", "", r.h); l.href = r.u; l.rel = "noopener"; p.append(l); }); body.append(p); }
  return body;
};

// ===== Contested check (M4): question-style searches only (needs call). ai-summary's model reads the top results;
// only when credible ones actually disagree, a both-sides panel goes in below the fold (never above what you see),
// waiting for a result below the screen if none is there yet. =====
const SD = { key: "", asked: false, d: null, done: false };
const sidesPass = () => {
  const key = searchId(location.href), list = document.getElementById("results-list");
  if (SD.key !== key) { Object.assign(SD, { key, asked: false, d: null, done: false }); document.querySelectorAll(".ct-sides").forEach((x) => x.remove()); }
  if (!webTab || SD.done || !list || shaped()) return;
  if (!SD.asked) {
    const nd = ready("needs", key);
    if (nd === undefined || !list.querySelector(".result-item")) return;
    SD.asked = true;
    let pg = 1; try { pg = Number(new URL(key).searchParams.get("page") || 1); } catch {}
    if (!nd || pg > 1 || !CT.questionStyle(nd)) { SD.done = true; return; }
    const rs = topRes(8);
    SD.rs = rs;
    bridge("sides", {}, JSON.stringify({ q: curQ(), r: rs })).then((j) => { if (SD.key !== key) return; SD.d = j && j.d; if (!SD.d || !SD.d.split) SD.done = true; else safe("sides", sidesPass); }, () => { SD.done = true; });
    return;
  }
  if (!SD.d) return;
  const v = [...list.querySelectorAll(".result-item")].filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped"));
  const below = v.find((el) => el.getBoundingClientRect().top >= innerHeight);
  if (!below) return; // wait for endless scroll to put a result below the screen
  SD.done = true;
  const s = section("ct-sides", "Sources disagree");
  const cols = mk("div", "ct-sides-cols");
  for (const side of [SD.d.a, SD.d.b]) {
    const c = mk("div", "ct-sides-c");
    c.append(mk("div", "ct-sides-claim", side.claim));
    const p = mk("div", "ct-sh-src");
    side.src.map((i) => SD.rs[i]).filter(Boolean).forEach((r, i) => { if (i) p.append(" · "); const l = mk("a", "", r.h); l.href = r.u; l.rel = "noopener"; p.append(l); });
    c.append(p);
    cols.append(c);
  }
  s.append(cols);
  below.before(s);
};
addEventListener("scroll", () => { if (SD.d && !SD.done) safe("sides", sidesPass); }, { passive: true });
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest(".ct-ai-more");
  if (!b || AIS.fail) return;
  const g = document.getElementById("at-a-glance");
  AIS.open = true;
  if (AIS.shape) { if (g) aiPass(g, AIS.key); return; } // a shaped answer just opens in place
  if (g) { aiPass(g, AIS.key); g.querySelector(".ct-ai-panel .glance-ai-expand")?.click(); } // ai-summary's own "read more": unclamps, opens its follow-up chat
});
const ansCard = (a) => {
  const box = mk("div", "ct-ans");
  box.dataset.kind = a.kind;
  if (a.copy) { box.tabIndex = 0; box.setAttribute("role", "button"); box.dataset.copy = a.copy; box.setAttribute("aria-label", `${a.value || a.title || a.copy}. Copy`); }
  const label = mk("div", "ct-ans-label");
  label.append(mk("span", "ct-ans-l", a.src ? `${a.label} · ${a.src}` : a.label), mk("span", "ct-ans-copied", "Copied"));
  box.append(label);
  if (a.kind === "snippet") {
    // The sentence as the page wrote it, then the page itself (title link, like a result)
    box.append(mk("div", "ct-ans-text", a.text));
    const t = mk("a", "ct-ans-src", a.title || a.h); t.href = a.href; t.rel = "noopener";
    box.append(t);
  } else if (a.href) { const t = mk("a", "ct-ans-title", a.title); t.href = a.href; t.rel = "noopener"; box.append(t); }
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
// Where a card goes on the one scale (answer card, info panel): before the first shown result worth less, or null =
// on top (also without the AI, or before the results are on the page)
const byWorth = (kind, fit) => {
  const list = document.getElementById("results-list"), key = searchId(location.href);
  const needs = ready("needs", key), fmt = CT.fmtShares(needs?.f), share = CT.blockShare(fmt, needs?.b, kind);
  if (!list || share == null) return null;
  const v = [...list.querySelectorAll(".result-item")].filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped") && !el.dataset.ctKp);
  if (!v.length) return null;
  const i = CT.boxAt(fmt, v.map((el) => info(el)?.ai), share * fit, 0);
  return i === 0 ? null : i >= v.length ? { after: v[v.length - 1] } : { before: v[i] };
};
const ansPass = () => {
  const g = document.getElementById("at-a-glance");
  if (!g) return;
  const key = searchId(location.href);
  if (ansFor !== key) {
    ansFor = key;
    let q = "", page = 1;
    try { const u = new URL(key); q = (u.searchParams.get("q") || "").trim(); page = Number(u.searchParams.get("page") || 1); } catch {}
    ansVal = webTab && page <= 1 && SHOW.ans !== false ? CT.answer(q, Date.now(), { fx: FX }) : null;
    aiVal = webTab && page <= 1 && !ansVal && aiWanted(q);
    g.querySelectorAll(".ct-ans, .ct-ai").forEach((x) => x.remove());
    document.querySelectorAll("#results-list > .ct-ans").forEach((x) => x.remove());
  }
  // Network answers (endoflife.date...): only in the pass that draws the results, and only if already in hand;
  // later than that they're dropped for this page (the server keeps them for the next search)
  if (!ansVal && drawnFor !== key && document.querySelector("#results-list .result-item")) {
    let q = "";
    try { q = new URL(key).searchParams.get("q") || ""; } catch {}
    const j = ready("eol", key), w = ready("wd", key), cm = ready("cmu", key);
    if (j && j.cycles) ansVal = CT.eolAnswer(CT.eolQuery(q), j.cycles);
    else if (w && w.d) ansVal = CT.wdAnswer(CT.wdQuery(q), w.d);
    else if (cm && cm.c) ansVal = CT.cmuAnswer(cmuQ(q), cm.c.course, cm.c.fces);
    else { const sp = ready("sports", key); if (sp && sp.g) { ansVal = CT.sportsAnswer(sp.g); if (ansVal && ansVal.live) livePoll(key, q); } }
    // Featured snippet (fact / how-to wording): a whole sentence from one of the first results now on the page,
    // drawn in this same pass. Not on page 2+, plain-list searches, or when an answer above came first.
    let pg = 1;
    try { pg = Number(new URL(key).searchParams.get("page") || 1); } catch {}
    // A shaped answer picked by the needs call (steps, table...) is the richer answer for the spot: no snippet then
    const shapeNext = aiVal && !!CT.shapePick(ready("needs", key));
    if (globalThis.CT_NOSNIP !== true && !ansVal && !shapeNext && SHOW.ans !== false && webTab && !TYPE_WORDS.test(q) && !shaped(q) && pg <= 1) {
      const rs = [...document.querySelectorAll("#results-list .result-item")].filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped")).slice(0, 6).map(info).filter(Boolean);
      const f = CT.featuredSnippetAI(q, rs) || (rs.some((r) => r.best) ? null : CT.featuredSnippet(q, rs));
      if (f) ansVal = { ...f, label: `From ${f.h}` };
    }
  }
  // An answer or snippet found in the results pass takes the AI spot (same pass, before paint: nothing moves)
  if (ansVal && aiVal) { aiVal = false; g.querySelectorAll(".ct-ai").forEach((x) => x.remove()); }
  aiPass(g, key);
  if (!ansVal || g.querySelector(".ct-ans") || document.querySelector("#results-list > .ct-ans")) return;
  const card = ansCard(ansVal);
  // Its place by worth (M2), when the results are already here (else on top, as before): the answer share x its fit
  // (the AI's score for a snippet's sentence; an exact answer fits fully). A live score stays on top (its updates find it there).
  const at = !ansVal.live && byWorth("answer", typeof ansVal.p === "number" ? ansVal.p : 1);
  if (at) { if (at.before) at.before.before(card); else at.after.after(card); }
  else { g.style.display = ""; g.prepend(card); }
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

// "Only reddit.com results ›": a search naming a site to filter by, where that site has few of the first results.
// Drawn above the results in the pass that draws them (never later); runs the site: search only when tapped.
let onlyKey = "";
const onlyPass = () => {
  const key = searchId(location.href), list = document.getElementById("results-list");
  if (!webTab || !list || onlyKey === key || drawnFor === key) return;
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none");
  if (!rows.length) return;
  onlyKey = key;
  document.querySelectorAll(".ct-only").forEach((x) => x.remove());
  let page = 1;
  try { page = Number(new URL(key).searchParams.get("page") || 1); } catch {}
  const q = curQ();
  if (page > 1) return;
  const d = CT.onlyLine(q, rows.map((x) => siteOf(rowHost(x))));
  if (!d) return;
  const a = mk("a", "ct-only", `Only ${d} results`);
  a.append(mk("span", "ct-chev", " ›"));
  const u = new URL(location.href);
  u.searchParams.set("q", CT.onlyQuery(q, d));
  u.searchParams.delete("page");
  a.href = u.pathname + u.search;
  const kpEl = [...list.children].find((x) => x.classList.contains("ct-kp"));
  if (kpEl) kpEl.after(a); else list.prepend(a);
};

// ===== Quick view (spec 11): your tap opens it under the result (it grows: your action), tap again to close =====
const QV_SHOW = { ingredients: 8, steps: 3, questions: 3 };
const qvBox = (v) => {
  const box = mk("div", "ct-qv");
  if (!v) { box.append(mk("div", "ct-qv-none", "No quick view for this page")); return box; }
  // Headline rating: number then 5 amber stars filled to the exact value (design system), count after
  const fl = mk("div", "ct-qv-facts ct-fit ct-fit-drop");
  for (const [k, x] of v.facts) {
    if (k === "Access") continue;
    const m = k === "Rating" && /^(\d+(?:\.\d)?) ★(.*)$/.exec(x);
    if (m) { const it = mk("span", "ct-it ct-rating", `${m[1]} `); const st = mk("span", "ct-stars", "★★★★★"); st.style.setProperty("--r", m[1]); st.setAttribute("aria-label", `${m[1]} out of 5`); it.append(st); if (m[2].trim()) it.append(m[2]); fl.append(it); continue; }
    fl.append(mk("span", "ct-it", k === "Total time" || k === "Time" ? x : `${k} ${x}`));
  }
  if (fl.children.length) box.append(fl);
  for (const l of v.lists) {
    if (l.para) { box.append(mk("p", "ct-qv-p", l.items[0])); continue; }
    const n = QV_SHOW[l.label] || 3;
    const ul = mk(l.ordered ? "ol" : "ul", `ct-qv-list${l.qa ? " ct-qv-qa" : ""}`);
    l.items.forEach((t, i) => {
      const li = mk("li");
      if (l.qa) { const [q, ...a] = t.split("\n"); li.append(mk("div", "ct-qv-q", q), mk("div", "ct-qv-a", a.join(" "))); } else li.textContent = t;
      if (i >= n) li.hidden = true;
      ul.append(li);
    });
    box.append(ul);
    if (l.items.length > n) {
      const more = mk("button", "ct-qv-more", `${l.items.length - n} more ${l.label} ⌄`);
      more.type = "button";
      more.onclick = () => { ul.querySelectorAll("li[hidden]").forEach((x) => { x.hidden = false; }); more.remove(); };
      box.append(more);
    }
  }
  v.text.slice(0, 3).forEach((t) => box.append(mk("p", "ct-qv-p", t)));
  return box;
};
document.addEventListener("click", async (e) => {
  const b = e.target.closest && e.target.closest(".ct-qv-b");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const el = b.closest(".result-item");
  const a = el && el.querySelector("a.result-title");
  const body = el && el.querySelector(".result-body");
  const u = (el && el.dataset.resultUrl) || (a && a.href) || "";
  const menu = b.closest(".result-actions-menu");
  if (menu) menu.hidden = true;
  if (!u || !body) return;
  const open = [...body.children].find((x) => x.classList.contains("ct-qv"));
  if (open) { open.remove(); b.textContent = "Quick view"; return; }
  const box = mk("div", "ct-qv"); box.append(mk("div", "ct-qv-none", "Loading quick view…"));
  body.append(box);
  b.textContent = "Close quick view";
  const j = await bridge("qv", { u }).catch(() => null);
  if (!box.isConnected) return;
  const v = j && j.v && Array.isArray(j.v.facts) && Array.isArray(j.v.lists) && Array.isArray(j.v.text) ? j.v : null;
  const nb = qvBox(v);
  box.replaceWith(nb);
  nb.querySelectorAll(".ct-fit").forEach(fitLine);
  if (fitRO) fitRO.observe(nb);
  // The page says it's for subscribers (isAccessibleForFree: false): the Paywall word joins the source line
  const cite = el.querySelector(".result-cite");
  if (v && v.facts.some(([k, x]) => k === "Access" && x === "Paywall") && cite && !el.querySelector(".result-url-row .ct-paywall:not(.ct-pdf)")) cite.after(mk("span", "ct-paywall", "Paywall"));
}, true);

// Inline "4.8 ★ · 45 min" on the source line of first-screen results for recipe and review searches (spec 11).
// Drawn before paint from this browser's copy (ct-qvs, 12 h); results not in it are asked for after the results are
// drawn (server reads their pages, skipping sites that block it) and kept for the next visit: never inserted late.
const QVS_KEY = "ct-qvs";
const qvs = (() => { let m = {}; try { const c = JSON.parse(localStorage.getItem(QVS_KEY) || "{}"); if (c && typeof c === "object") m = c; } catch {} const now = Date.now(); for (const k of Object.keys(m)) if (!(now - m[k][1] < 432e5)) delete m[k]; return m; })();
const starsWanted = (q) => CT.shapeOf(q) === "recipe" || /\b(?:reviews?|rating|ratings|rated)\b/i.test(q);
let starsKey = "";
const starsPass = () => {
  const key = searchId(location.href), list = document.getElementById("results-list");
  if (!webTab || !list || SHOW.stars === false || starsKey === key || drawnFor === key) return;
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none" && !x.classList.contains("ct-grouped")).slice(0, 6);
  if (!rows.length) return;
  starsKey = key;
  let page = 1;
  try { page = Number(new URL(key).searchParams.get("page") || 1); } catch {}
  if (page > 1 || !starsWanted(curQ())) return;
  const ask = [];
  for (const el of rows) {
    const a = el.querySelector("a.result-title"), u = (el.dataset.resultUrl || (a && a.href) || "");
    const c = u && qvs[qHash(u)], cite = el.querySelector(".result-cite");
    if (c && cite) {
      const t = mk("span", "ct-paywall ct-stars-l");
      const m = /^(\d+(?:\.\d)?) ★(.*)$/.exec(c[0]);
      if (m) { t.append(`${m[1]} `); const st = mk("span", "ct-stars", "★★★★★"); st.style.setProperty("--r", m[1]); st.setAttribute("aria-label", `${m[1]} out of 5`); t.append(st, m[2]); } else t.textContent = c[0];
      (el.querySelector(".result-url-row .ct-pdf, .result-url-row .ct-paywall, .result-url-row .ct-date") || cite).after(t);
    }
    else if (u && !c) ask.push(u);
  }
  if (ask.length) setTimeout(() => bridge("qvs", {}, JSON.stringify({ u: ask })).then((j) => {
    if (!j || !j.s || typeof j.s !== "object") return;
    for (const [u, t] of Object.entries(j.s)) if (typeof t === "string" && t.length < 60) qvs[qHash(u)] = [t, Date.now()];
    const ks = Object.keys(qvs); if (ks.length > 500) ks.sort((a, b) => qvs[a][1] - qvs[b][1]).slice(0, ks.length - 500).forEach((k) => delete qvs[k]);
    try { localStorage.setItem(QVS_KEY, JSON.stringify(qvs)); } catch {}
  }).catch(() => {}), 0);
};

// Meaning line (spec 9): "Also: snakes · Monty Python" above the results when the words have several meanings and
// the results cover one (CT.meaningLine, from the knowledge panel's answer). Results pass only, never later.
let meanKey = "";
const meanPass = () => {
  const key = searchId(location.href), list = document.getElementById("results-list");
  if (!webTab || !list || SHOW.mean === false || meanKey === key || drawnFor === key) return;
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none");
  if (!rows.length) return;
  meanKey = key;
  document.querySelectorAll(".ct-mean").forEach((x) => x.remove());
  const d = ready("kp", key), alts = d && d.kp && d.kp.alts;
  if (!alts) return;
  const q = curQ();
  const chips = CT.meaningLine(q, alts, rows.slice(0, 10).map((x) => `${x.querySelector("a.result-title")?.textContent || ""} ${x.querySelector(".result-snippet")?.textContent || ""}`));
  if (!chips) return;
  const line = mk("div", "ct-mean");
  line.append(mk("span", "ct-mean-l", "Also: "));
  chips.forEach((c, i) => { if (i) line.append(mk("span", "ct-mean-dot", " · ")); const a = mk("a", "ct-mean-a", c.text); a.href = goTo(c.q); line.append(a); });
  const after = [...list.children].find((x) => x.classList.contains("ct-kp") || x.classList.contains("ct-only"));
  if (after) after.after(line); else list.prepend(line);
};

// ===== Knowledge panel (spec 3) =====
// Asked at page load for short name-like searches that get no other answer, no AI and no plain type/site list.
// Shown only when the results hold the same article (CT.kpMatch); the Wikipedia result itself is then hidden, and
// degoog's own Wikipedia card is always hidden (CSS): this replaces it, and it arrived late on phones (sidebar on top).
// Wide screens: a right column top-aligned with the first result, laid out absolutely beside the list, so it moves
// nothing even when it arrives after the results. Narrower: a compact card (name, type, one line of facts, More ⌄)
// at the top of the list, drawn only in the pass that draws the results.
const KP_WIDE = "(min-width: 1180px)";
const kpWanted = (q) => {
  if (!webTab || !CT.kpQuery(q) || shaped(q) || bangFor(q) || TYPE_WORDS.test(q) || CT.answer(q, Date.now(), { fx: FX }) || AI_WORDS.test(q)) return false;
  try { if (CT.namedSites(q, PSL()).size) return false; } catch {}
  return true;
};
let kpKey = "";
const kpCard = (kp, wide) => {
  const box = mk("aside", `ct-kp${wide ? " ct-kp-wide" : ""}`);
  box.setAttribute("aria-label", `About ${kp.name}`);
  const wiki = `https://en.wikipedia.org/wiki/${encodeURIComponent(kp.title.replace(/ /g, "_"))}`;
  if (wide && kp.photo) {
    const ph = mk("div", `ct-kp-photo${kp.type === "person" ? " ct-kp-portrait" : ""}`);
    const im = new Image(); im.alt = ""; im.decoding = "async"; im.referrerPolicy = "no-referrer";
    im.onload = () => im.classList.add("ct-on"); im.onerror = () => { ph.style.visibility = "hidden"; };
    im.src = kp.photo; ph.append(im); box.append(ph);
  }
  const head = mk("div", "ct-kp-head");
  const name = mk("a", "ct-kp-name", kp.name); name.href = wiki; name.rel = "noopener";
  head.append(name);
  const type = kp.desc ? kp.desc.charAt(0).toUpperCase() + kp.desc.slice(1) : "";
  if (type) head.append(mk("div", "ct-kp-type", type));
  box.append(head);
  const ext = mk("p", "ct-kp-ext", kp.extract || "");
  const facts = mk("dl", "ct-kp-facts");
  for (const f of kp.facts || []) { const r = mk("div", "ct-kp-f"); r.append(mk("dt", "", f.k), mk("dd", "", f.v)); facts.append(r); }
  // Source line; its "Wikipedia" opens the article (the 2-line description is clamped, so the link lives here)
  const src = mk("div", "ct-kp-src");
  const wl = mk("a", "ct-kp-wl", "Wikipedia ↗"); wl.href = wiki; wl.rel = "noopener";
  src.append(wl, " · Wikidata");
  if (wide) { if (kp.extract) box.append(ext); if (kp.facts && kp.facts.length) box.append(facts); box.append(src); return box; }
  // Compact: one line of facts that never wraps (fitLine drops whole facts from the end), More ⌄ opens the rest here
  const line = mk("div", "ct-kp-line ct-fit ct-fit-drop");
  for (const t of CT.kpLine(kp.facts)) line.append(mk("span", "ct-it", t));
  if (line.children.length) box.append(line);
  const more = mk("div", "ct-kp-more");
  if (kp.extract) more.append(ext);
  if (kp.facts && kp.facts.length) more.append(facts);
  more.append(src);
  more.hidden = true;
  const b = mk("button", "ct-kp-open", "More ⌄"); b.type = "button"; b.setAttribute("aria-expanded", "false");
  box.append(more, b);
  return box;
};
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest(".ct-kp-open");
  if (!b) return;
  const more = b.parentElement.querySelector(".ct-kp-more"), open = more.hidden;
  more.hidden = !open; b.textContent = open ? "Less ⌃" : "More ⌄"; b.setAttribute("aria-expanded", String(open));
});
const kpPass = () => {
  const key = searchId(location.href), list = document.getElementById("results-list");
  if (kpKey !== key) { kpKey = key; document.querySelectorAll(".ct-kp").forEach((x) => x.remove()); }
  if (!list || !webTab || SHOW.kp === false || [...list.children].find((x) => x.classList.contains("ct-kp"))) return;
  const d = ready("kp", key), kp = d && d.kp;
  if (!kp || !kp.title || !kp.name) return;
  const late = drawnFor === key, wide = !!(window.matchMedia && matchMedia(KP_WIDE).matches);
  // Phones: on top of the list. Late (after the results are on screen) only in place of the AI spot, so the list
  // moves by the small difference in height instead of the whole card
  const spot = !wide ? document.querySelector("#at-a-glance > .ct-ai") : null;
  if (late && !wide && !spot) return;
  const rows = [...list.querySelectorAll(".result-item")];
  if (!rows.length) return;
  const m = CT.kpMatch(kp.title, rows.map((r) => r.querySelector("a.result-title")?.href || ""), kp.hosts);
  if (!m.ok) return;
  if (!late) for (const i of m.wiki) rows[i].dataset.ctKp = "1"; // the panel replaces that result (before paint only)
  const card = kpCard(kp, wide);
  // Phones: its place by worth (M2): the info share x the AI's score for the page it replaces. PC: the side column.
  const fit = Math.max(...m.wiki.map((i) => info(rows[i])?.ai).filter((x) => typeof x === "number"));
  const at = !wide && !late && isFinite(fit) && byWorth("info", fit);
  if (at) { if (at.before) at.before.before(card); else at.after.after(card); } else list.prepend(card);
  if (!wide && aiVal) { aiVal = false; document.querySelectorAll("#at-a-glance > .ct-ai").forEach((x) => x.remove()); const g = document.getElementById("at-a-glance"); if (g) aiPass(g, key); } // the panel is what's on top now
  card.querySelectorAll(".ct-fit").forEach(fitLine);
  if (fitRO) fitRO.observe(card);
};

// Product panel (M6): asked once the results are on the page, when the needs call says a product panel is worth more
// than the first-screen cutoff (core blockGo, the same rule as the other blocks). The server reads the top results'
// pages. Wide screens: the right column (under the info panel when there is one), so it moves nothing. Phones: it
// arrives after the results are on screen, so it goes in at the first result below the screen (moves nothing seen).
const PD = { key: "", asked: false, d: null, done: false };
const money = (n, cur) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n); } catch { return `${n} ${cur}`; } };
const prodCard = (p, wide) => {
  const box = mk("aside", `ct-prod${wide ? " ct-prod-wide" : ""}`);
  box.setAttribute("aria-label", `Product: ${p.name}`);
  if (p.img) {
    const ph = mk("div", "ct-prod-photo");
    const im = new Image(); im.alt = ""; im.decoding = "async"; im.referrerPolicy = "no-referrer";
    im.onload = () => im.classList.add("ct-on"); im.onerror = () => ph.remove();
    im.src = p.img; ph.append(im); box.append(ph);
  }
  const head = mk("div", "ct-kp-head");
  const name = mk("a", "ct-kp-name", p.name); if (/^https?:\/\//.test(p.url)) { name.href = p.url; name.rel = "noopener"; }
  head.append(name);
  if (p.brand) head.append(mk("div", "ct-kp-type", p.brand));
  box.append(head);
  const facts = mk("dl", "ct-kp-facts");
  const f = (k, v) => { if (!v) return; const r = mk("div", "ct-kp-f"); r.append(mk("dt", "", k), mk("dd", "", v)); facts.append(r); };
  if (p.price) f("Price", `${money(p.price.lo, p.price.cur)}${p.price.hi > p.price.lo ? ` – ${money(p.price.hi, p.price.cur)}` : ""}${p.price.sellers > 1 ? ` (${p.price.sellers} sellers)` : ""}`);
  if (p.rating) f("Rating", `${p.rating.v.toFixed(1)} ★${p.rating.n ? ` (${p.rating.n.toLocaleString("en-US")})` : ""}`);
  f("Released", p.rel);
  for (const [k, v] of p.specs || []) f(k, v);
  box.append(facts);
  if (p.from && p.from.length) box.append(mk("div", "ct-kp-src", `From ${[...new Set(p.from)].slice(0, 4).join(" · ")}`));
  return box;
};
const productPass = () => {
  const key = searchId(location.href), list = document.getElementById("results-list");
  if (PD.key !== key) { Object.assign(PD, { key, asked: false, d: null, done: false }); document.querySelectorAll(".ct-prod").forEach((x) => x.remove()); }
  if (!webTab || SHOW.kp === false || PD.done || !list) return;
  if (!PD.asked) {
    const nd = ready("needs", key);
    if (nd === undefined || !list.querySelector(".result-item")) return;
    PD.asked = true;
    let pg = 1; try { pg = Number(new URL(key).searchParams.get("page") || 1); } catch {}
    const share = nd ? CT.blockShare(CT.fmtShares(nd.f), nd.b, "product") : null;
    if (pg > 1 || !CT.blockGo(share, nd && nd.cut)) { PD.done = true; return; }
    const rs = topRes(6);
    bridge("product", { q: curQ(), u: rs.map((r) => r.u).join("|") }).then((j) => {
      if (PD.key !== key) return;
      PD.d = CT.prodShow(j && j.v) ? j.v : null;
      if (!PD.d) PD.done = true; else safe("prod", productPass);
    }, () => { PD.done = true; });
    return;
  }
  if (!PD.d) return;
  const wide = !!(window.matchMedia && matchMedia(KP_WIDE).matches);
  if (wide) {
    PD.done = true;
    const kp = [...list.children].find((x) => x.classList.contains("ct-kp-wide"));
    if (kp) { kp.append(prodCard(PD.d, true)); return; }
    const col = mk("aside", "ct-kp ct-kp-wide ct-prod-col");
    col.append(prodCard(PD.d, true));
    list.prepend(col);
    return;
  }
  const v = [...list.querySelectorAll(".result-item")].filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped"));
  const below = v.find((el) => el.getBoundingClientRect().top >= innerHeight);
  if (!below) return; // wait for endless scroll to put a result below the screen
  PD.done = true;
  below.before(prodCard(PD.d, false));
};
addEventListener("scroll", () => { if (PD.d && !PD.done) safe("prod", productPass); }, { passive: true });

// Tab row: degoog redraws its tabs when the page comes back into view (and when extensions are saved) and can leave a
// copy of a tab, no active tab or the wrong one. One tab per kind, exactly one underlined (the one you're on), and
// Tools then ⚑ last, after every redraw.
let tabNow = "";
const tabKind = (t) => { const d = t.dataset.type || ""; return d.startsWith("tab:engine:") ? d.slice(11) : d.startsWith("tab:") ? d.slice(4) : d; };
const tabKeep = () => {
  const row = document.getElementById("results-tabs");
  if (!row) return;
  const tabs = [...row.children].filter((t) => t.classList.contains("results-tab"));
  if (!tabs.length) return;
  const seen = new Map();
  for (const t of tabs) {
    const k = tabKind(t), had = seen.get(k);
    if (!had) { seen.set(k, t); continue; }
    if (t.classList.contains("active") && !had.classList.contains("active")) { had.remove(); seen.set(k, t); } else t.remove();
  }
  const act = [...seen.values()].filter((t) => t.classList.contains("active"));
  if (act.length === 1 && act[0].style.display !== "none") tabNow = tabKind(act[0]);
  else {
    let want = tabNow;
    try { want = want || new URL(location.href).searchParams.get("type") || ""; } catch {}
    if (!want && document.getElementById("results-layout")?.classList.contains("media-mode")) want = "images";
    want = want || "web";
    if (seen.has(want)) for (const [k, t] of seen) t.classList.toggle("active", k === want);
  }
  const tl = document.getElementById("ct-tools"), fl = document.getElementById("ct-flag");
  if (tl && tl.parentElement === row && tl.nextElementSibling && tl.nextElementSibling !== fl) row.append(tl);
  if (fl && fl.parentElement === row && fl.nextElementSibling) row.append(fl);
};
const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`clean-titles ${name}:`, e); } };
// A tab tapped while degoog's first search is still starting is ignored by degoog (it has no current search yet), so the
// page seemed stuck until it finished loading. The tap is kept and repeated until degoog takes it (its tab turns
// active); degoog then drops the search that was loading and opens the tab. A later tap on another tab cancels it.
let rescueId = 0, repeating = false;
const tabRescue = () => {
  document.addEventListener("click", (e) => {
    const tab = e.target && e.target.closest ? e.target.closest("#results-tabs .results-tab") : null;
    if (!tab || repeating) return; // our own repeated taps never start another rescue
    const id = ++rescueId;
    const t0 = Date.now();
    const tick = () => {
      if (id !== rescueId || !tab.isConnected || tab.classList.contains("active") || Date.now() - t0 > 12000) return;
      repeating = true; try { tab.click(); } finally { repeating = false; }
      setTimeout(tick, 450);
    };
    setTimeout(tick, 450);
  }, true);
};

const init = () => {
  // iOS zooms the page into any text box under 16px on focus; maximum-scale=1 stops that (iOS still allows
  // pinch zoom), so boxes can use the page's text size. iOS only: elsewhere it would block pinch zoom.
  if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
    const vp = document.querySelector('meta[name="viewport"]');
    if (vp && !/maximum-scale/.test(vp.content)) vp.content += ", maximum-scale=1";
  }
  safe("tabrescue", tabRescue);
  safe("query", readQuery);
  safe("early", earlyStart);
  safe("usage", () => noUsage(document.body));
  safe("card", glance);
  safe("answer", ansPass);
  safe("list", listPass);
  safe("tabs", tabPass);
  safe("rel", relPass);
  safe("scan", () => scan(document.body));
  safe("skeleton", () => skel(document.body));
  safe("extras", extras); safe("groups", groups); safe("folds", foldPass); safe("ask", paa); safe("tools", tools); safe("flag", flagBtn); safe("gap", topGap); safe("tabkeep", tabKeep);
  safe("kp", kpPass); safe("only", onlyPass); safe("mean", meanPass); safe("stars", starsPass); safe("sides", sidesPass); safe("prod", productPass);
  safe("drawn", markDrawn);
  // Runs right after degoog inserts results and before the screen updates; only looks inside what was added
  new MutationObserver((muts) => {
    safe("query", readQuery);
    safe("early", earlyStart);
    safe("answer", ansPass);
    safe("list", listPass);
    safe("tabs", tabPass);
    safe("rel", relPass);
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { safe("scan", () => scan(n)); safe("skeleton", () => skel(n)); safe("usage", () => noUsage(n)); }
    safe("extras", extras); safe("groups", groups); safe("folds", foldPass); safe("ask", paa); safe("tools", tools); safe("flag", flagBtn); safe("gap", topGap); safe("tabkeep", tabKeep); safe("card", glance);
    safe("kp", kpPass); safe("only", onlyPass); safe("mean", meanPass); safe("stars", starsPass); safe("preview", previewPass); safe("sides", sidesPass); safe("prod", productPass);
    safe("drawn", markDrawn);
    safe("ai", () => { const g = document.getElementById("at-a-glance"); if (g) aiPass(g, searchId(location.href)); });
  }).observe(document.body, { childList: true, subtree: true });
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
// ===== Load timing (for the self-check; no searches, no addresses, only milliseconds) =====
// Where the wait goes when degoog opens slowly: name lookup, connection, encryption, server, download, page work,
// and the first search request after the page opened. Kept on this server (last 60), printed by the installer.
(() => {
  const r = (x) => (Number.isFinite(x) && x >= 0 ? Math.round(x) : -1);
  const send = () => {
    try {
      const n = performance.getEntriesByType("navigation")[0];
      if (!n) return;
      const first = performance.getEntriesByType("resource").find((e) => /\/api\/(?:search|command)\b/.test(e.name) && !/cleantitles/.test(e.name));
      const ph = (x) => (x ? { wait: r(x.startTime), dns: r(x.domainLookupEnd - x.domainLookupStart), connect: r(x.connectEnd - x.connectStart), tls: r(x.secureConnectionStart > 0 ? x.connectEnd - x.secureConnectionStart : 0), server: r(x.responseStart - x.requestStart), download: r(x.responseEnd - x.responseStart), total: r(x.duration) } : null);
      const nav = ph(n);
      nav.ready = r(n.domContentLoadedEventEnd);
      nav.loaded = r(n.loadEventEnd);
      nav.type = n.type;
      nav.cached = n.transferSize === 0;
      bridge("perf", {}, JSON.stringify({ dev: PHONE.matches ? "phone" : "pc", nav, search: ph(first) })).catch(() => {});
    } catch {}
  };
  const go = () => setTimeout(send, 4000); // after the first search usually finished
  if (document.readyState === "complete") go(); else addEventListener("load", go, { once: true });
})();

// ===== DuckDuckGo on, once (measured on this server: 9-10 results in ~600 ms, while every search already waits
// for Startpage, so it adds results without adding time). degoog keeps engine switches in this browser's IndexedDB
// ("degoog" / "settings" / "engines"); this flips DuckDuckGo's web engine on one time per browser and never again,
// so switching it off later sticks.
(() => {
  try { if (localStorage.getItem("ct-ddg-on")) return; } catch { return; }
  try {
    const open = indexedDB.open("degoog");
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("settings")) return;
      const tx = db.transaction("settings", "readwrite"), st = tx.objectStore("settings"), get = st.get("engines");
      get.onsuccess = () => {
        const m = get.result && typeof get.result === "object" ? { ...get.result } : null;
        const id = m && Object.keys(m).find((k) => /(?:^|-)duckduckgo(?:-engine)?$/i.test(k));
        if (id && m[id] !== true) { m[id] = true; st.put(m, "engines"); }
        try { localStorage.setItem("ct-ddg-on", "1"); } catch {}
      };
    };
  } catch {}
})();

'@)
$c = docker ps -q | Where-Object { (docker inspect $_ --format '{{range .Mounts}}{{.Destination}} {{end}}') -match '/app/data' }
docker cp "$t\index.js" "${c}:/app/data/plugins/clean-titles/index.js"; docker exec $c rm -f /app/data/plugins/clean-titles/reports.json
# Typo fixer data (word lists, Wikipedia names) is fetched by the plugin itself the first time; names.js is its helper
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
docker cp "$t\names.js" "${c}:/app/data/plugins/clean-titles/names.js"

# Plugin page code goes inside degoog's page itself: no separate file, so no content blocker can stop it
[IO.File]::WriteAllText("$t\inline.js", @'
const fs = require("fs");
const crypto = require("crypto");
const f = "/app/src/public/themes/degoog-theme/layout.html";
let h = fs.readFileSync(f, "utf8");
const code = fs.readFileSync("/tmp/ct.js", "utf8");
const dir = "/app/src/public/ct";
fs.mkdirSync(dir, { recursive: true });
// Static files degoog serves with a 1-year immutable cache (/public/*.js), named by their content so a new version
// gets a new name. degoog doesn't compress pages, so these used to cost ~280 KB on every page load (the page script
// was inlined, 208 KB): as files the browser downloads them once and keeps them (and their compiled code).
const put = (name, body) => {
  const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 12);
  for (const old of fs.readdirSync(dir)) if (new RegExp(`^${name}\\.[0-9a-f]+\\.js$`).test(old) && old !== `${name}.${hash}.js`) fs.rmSync(`${dir}/${old}`);
  fs.writeFileSync(`${dir}/${name}.${hash}.js`, body);
  return `/public/ct/${name}.${hash}.js`;
};
// Public suffix list (which part of a host is the site: bbc.co.uk, user.github.io), then the page script; defer and
// module scripts run in page order, before results arrive. modulepreload starts the page script's download with the
// page's head instead of at its end.
const psl = fs.readFileSync("/tmp/psl.enc", "utf8").trim();
const pslUrl = put("psl", `window.CT_PSL=${JSON.stringify(psl)};\n`);
const ctUrl = put("ct", `const __PLUGIN_ID__="clean-titles";\n${code}\n`);
const block = `<script defer src="${pslUrl}" id="ct-psl"></script>\n<script type="module" src="${ctUrl}" id="ct-inline"></script>`;
const re = /(?:<script defer src="\/public\/ct\/psl\.[0-9a-f]+\.js" id="ct-psl"><\/script>\n)?(?:<script type="module" id="ct-inline">[\s\S]*?\n<\/script>|<script type="module" src="\/public\/ct\/ct\.[0-9a-f]+\.js" id="ct-inline"><\/script>)/;
h = re.test(h) ? h.replace(re, () => block) : h.replace("</body>", () => block + "\n</body>");
const pre = `<link rel="modulepreload" href="${ctUrl}" id="ct-pre">`;
const preRe = /<link rel="modulepreload" href="\/public\/ct\/ct\.[0-9a-f]+\.js" id="ct-pre">/;
h = preRe.test(h) ? h.replace(preRe, () => pre) : h.replace("</head>", () => `${pre}\n</head>`);
fs.writeFileSync(f, h);
console.log(`public suffix list: ${pslUrl} (${psl.length} chars)`);
console.log(`page script: ${ctUrl} (${code.length} chars, cached by the browser)`);
// Results hook: degoog's search step hands each search's results to clean-titles before sending them (the answer AI
// scores relevance and picks the featured snippet on the server, so nothing moves on the phone). Idempotent; when
// degoog's code doesn't match (an update changed it), nothing is patched and the page keeps its word rules.
try {
  const sf = "/app/src/server/routes/search/search-routes.ts";
  let s = fs.readFileSync(sf, "utf8");
  if (!s.includes("__ctResults")) {
    let n = 0;
    s = s.replace(/(const result = await handleSearch\(\{ query, \.\.\.(\w+) \}\);)/g, (m, all, p) => { n++; return `${all}\n    try { await (globalThis as any).__ctResults?.(result, query, ${p}); } catch {}`; });
    if (n) { fs.writeFileSync(sf, s); console.log(`results hook: patched ${n} search routes`); }
    else console.log("results hook: degoog's search route changed, not patched");
  } else console.log("results hook: in place");
} catch (e) { console.log(`results hook: not patched (${e.message})`); }

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
@media (max-width: 767px) and (pointer: coarse) { .result-url-row .ct-date { color: var(--text-secondary); } }
.result-url-row .ct-paywall { flex: none; margin-left: -4px; font-size: 13px; line-height: 18px; white-space: nowrap; color: var(--text-secondary); }
.result-url-row .ct-paywall::before { content: "·"; margin-right: 4px; }
/* "N more from site.com ⌄": blue = tappable, underline on hover only; tucked under the site's 2nd result
   (results carry 12px top/bottom padding, so -8px leaves 4px between) */
.ct-fold { margin: -8px 0 4px; }
.ct-fold-img { margin: 4px 0 24px; } /* Images tab: under the grid, left edge with the images */
.ct-fold-b { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0; border: 0; background: none; font: inherit; font-size: 14px; line-height: 20px; color: var(--text-link); cursor: pointer; }
.ct-fold-b:hover { text-decoration: underline; }
.ct-fold-b:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 4px; }
.ct-chev { color: var(--text-secondary); }
@media (max-width: 767px) and (pointer: coarse) { .ct-fold-b { min-height: 44px; } }
/* Other versions of one paper ("PDF · HTML · v7 latest"): small gray line, the links blue */
.ct-alts { margin-top: 4px; font-size: 13px; line-height: 18px; color: var(--text-cite); white-space: nowrap; overflow: hidden; }
.ct-alts a { color: var(--text-link); text-decoration: none; }
.ct-alts a:visited { color: var(--text-link-visited); }
.ct-alts a:hover { text-decoration: underline; }
/* Typo fix line above results (Google's "Showing results for") */
#ct-fix { margin: 0 0 4px; padding-left: var(--ct-x, 0px); font-size: 14px; line-height: 21px; color: var(--text-secondary); }
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
#results-layout:not(.media-mode) { margin-top: var(--ct-top, 0px) !important; }
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

  /* Header: search bar ends at the 44rem content edge; the gear sits right after it, same height, centred on the
     bar (page controls next to the search they change, not alone in the far corner of a wide screen) */
  #results-header .results-logo { flex: none !important; width: 6.5rem !important; }
  #results-header #results-search-bar { flex: none !important; width: 36.75rem !important; max-width: none !important; }
  #nav-settings-results {
    position: static !important;
    height: 2.75rem !important; width: 2.75rem !important; margin: 0 0 0 .25rem !important; padding: 0 !important;
    display: flex !important; align-items: center !important; justify-content: center !important;
    border-radius: 999px !important; color: var(--text-secondary) !important;
  }
  #nav-settings-results:hover { background: var(--bg-hover) !important; color: var(--text-primary) !important; }
  #nav-settings-results i { font-size: 1.15rem !important; }


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
  /* "Showing results for" first, above the answer card too (as on phones and Google) */
  #results-layout:not(.media-mode) #results-main > #ct-fix { order: 1; margin-bottom: 0; }
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
@media (max-width: 767px) and (pointer: coarse) { .result-item .result-title { white-space: normal !important; display: -webkit-box !important; -webkit-line-clamp: 2 !important; -webkit-box-orient: vertical; } }
/* Phones: title leads; summary and link line step back (smaller and greyer) so only the title asks for attention */
@media (max-width: 767px) and (pointer: coarse) {
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
  /* Same source line as Web (colour, size), and long paper titles get 2 lines instead of "…" */
  & .result-snippet { -webkit-line-clamp: 2 !important; }
  & .result-item .result-title { white-space: normal !important; display: -webkit-box !important; -webkit-line-clamp: 2 !important; -webkit-box-orient: vertical; }
  & .result-insecure-badge { display: none !important; }
}

/* Forums: shared look, no thumbnails, 2-line titles and snippets */
#results-page:is(:has(.results-tab.active[data-type="tab:engine:forums"]), :not(:has(.results-tab.active)):not(:has(.result-item:is([data-result-url*="doi.org/"], [data-result-url*="openalex.org/"], [data-result-url*="semanticscholar.org/"], [data-result-url*="ncbi.nlm.nih.gov/"], [data-result-url*="arxiv.org/"], [data-result-url*="researchhub.com/"]))):has(.result-item:is([data-result-url*="reddit.com/r/"], [data-result-url*="stackoverflow.com/"], [data-result-url*="stackexchange.com/"], [data-result-url*="superuser.com/"], [data-result-url*="serverfault.com/"], [data-result-url*="askubuntu.com/"], [data-result-url*="news.ycombinator.com/"]))) {
  & .results-tab[data-type="tab:engine:forums"] { color: var(--text-primary) !important; border-bottom-color: var(--text-primary) !important; }
  & .result-thumbnail-wrap { display: none !important; }
  & .result-snippet { -webkit-line-clamp: 2 !important; }
  /* Phones: forums keep the tighter 24px gaps (short results read better close together) */
  @media (max-width: 767px) and (pointer: coarse) {
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
  @media (max-width: 767px) and (pointer: coarse) {
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
  @media (max-width: 767px) and (pointer: coarse) {
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
@media (max-width: 767px) and (pointer: coarse) {
  :is(input[type="text"], input[type="search"], input:not([type]), textarea:not(#ct-flagbox textarea)) { font-size: 16px !important; }
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
@media (max-width: 767px) and (pointer: coarse) {
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
@media (max-width: 767px) and (pointer: coarse) {
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
@media (max-width: 767px) and (pointer: coarse) { .ct-seg { min-width: 300px; } .ct-seg-b { min-height: 44px; } }

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
@media (max-width: 767px) and (pointer: coarse) {
  #ct-qa h3 { font-size: 18px; line-height: 23px; }
  .ct-qa-text { font-size: var(--ct-desc-phone); line-height: 19px; color: var(--text-secondary); }
  .ct-qa-src { font-size: 18px; line-height: 23px; margin-top: 5px; }
}

/* Sitelinks, Discussions and forums, Videos, Top stories: same family as People also ask (heading, dividers)
   and your News cards (12px rounded tiles); every row is one big tap target */
.result-item.ct-grouped { display: none !important; }
/* Same gap above and below a box (12px here + a result's 12px padding = the 24px between two results) */
.ct-grp { margin: 12px 0; }
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
.ct-row { display: grid; grid-auto-flow: column; grid-auto-columns: max(calc((100% - 24px) / 3), 200px); gap: 12px; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none; overscroll-behavior-x: contain; }
.ct-row::-webkit-scrollbar { display: none; }
.ct-card { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding-bottom: 12px; border-radius: 12px; background: rgba(49, 50, 68, .45); overflow: hidden; text-decoration: none; scroll-snap-align: start; }
.ct-card:hover { background: rgba(69, 71, 90, .45); }
.ct-card > :not(.ct-pic) { margin: 0 12px; }
.ct-pic { position: relative; display: block; aspect-ratio: 16 / 9; background: var(--bg-light); overflow: hidden; }
.ct-pic img { display: block; width: 100%; height: 100%; object-fit: cover; }
.ct-pic img.ct-late { opacity: 0; transition: opacity .3s; }
.ct-pic img.ct-late.ct-in { opacity: 1; }
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
/* Narrow windows with a mouse: arrows stay inside the page (no sideways scroll) */
@media (max-width: 767px) { .ct-prev { left: 0; } .ct-next { right: 0; } }
@media (max-width: 767px) and (pointer: coarse) {
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
/* Tools lives with the search it changes: on wider screens the tab row ends where the search bar ends, and Tools
   sits at that edge, right under the bar's ✕ and → (one column: logo, bar, tabs, results). On phones it follows the
   last tab behind a thin divider, inside the scrolling tab row. Same size and baseline as the tabs. */
#ct-tools { position: relative; align-self: stretch; display: flex; align-items: center; background: none; border: 0; border-bottom: 3px solid transparent; padding: 0 12px 0 16px; margin-left: 4px; font: inherit; font-size: .8125rem; color: var(--text-secondary); cursor: pointer; flex: none; }
#ct-tools::before { content: ""; position: absolute; left: 0; top: 50%; height: 16px; margin-top: -8px; width: 1px; background: var(--border-light); }
@media (min-width: 768px) {
  #results-tabs:has(#ct-tools) { padding-right: var(--ct-tabs-pr, 0px) !important; }
  #results-tabs #ct-tools { margin-left: auto !important; padding: 0 14px; }
  #ct-tools::before { display: none; }
}
#ct-tools:hover { color: var(--text-primary); }
#ct-tools[aria-expanded="true"] { color: var(--text-primary); }
/* ⚑ Flag: right after the settings gear, the same round button (PC: in the header row; phone: pinned just left of the
   gear, placed by script.js flagPlace). Its box opens over the results under it. */
#ct-flag { display: flex; align-items: center; justify-content: center; flex: none; box-sizing: border-box; height: 2.75rem; width: 2.75rem; margin: 0; padding: 0; border: 0; border-radius: 999px; background: none; font: inherit; font-size: 1.15rem; line-height: 1; color: var(--text-secondary); cursor: pointer; }
#ct-flag:hover, #ct-flag[aria-expanded="true"] { background: var(--bg-hover); color: var(--text-primary); }
@media (min-width: 768px) {
  #results-header #ct-flag { margin-left: -.75rem; } /* the header's 1rem gap minus .25rem: as close to the gear as the gear is to the bar */
}
@media (max-width: 767px) {
  #ct-flag { position: absolute; width: 2.5rem; height: 2.5rem; }
}
#ct-flagscrim { position: fixed; inset: 0; z-index: 400; background: transparent; touch-action: none; }
html.ct-sheet-open, html.ct-sheet-open body { overflow: hidden; overscroll-behavior: none; }
#ct-flagbox { overscroll-behavior: contain; }
#ct-flagbox { position: absolute; z-index: 401; box-sizing: border-box; width: 440px; max-width: calc(100vw - 24px); display: grid; gap: 12px; padding: 14px 16px 16px; background: var(--bg); border: 1px solid var(--border-light); border-radius: 14px; box-shadow: 0 12px 32px rgba(0, 0, 0, .45); font-size: 13.5px; color: var(--text-secondary); }
.ct-flag-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: -4px; }
.ct-flag-h { font-weight: 600; font-size: 14.5px; color: var(--text-primary); }
.ct-flag-x { width: 32px; height: 32px; margin: -6px -8px -6px 0; padding: 0; border: 0; border-radius: 50%; background: none; color: var(--text-secondary); font-size: 22px; line-height: 1; cursor: pointer; }
.ct-flag-x:hover { background: var(--bg-light); color: var(--text-primary); }
#ct-flagbox label { display: grid; }
#ct-flagbox textarea { box-sizing: border-box; width: 100%; font: inherit; font-size: 13.5px; color: var(--text-primary); background: var(--bg-light); border: 1px solid var(--border-light); border-radius: 10px; padding: 8px 10px; outline: none; resize: vertical; min-height: 4.2em; }
#ct-flagbox textarea::placeholder { color: var(--text-secondary); opacity: .8; }
#ct-flagbox textarea:focus { border-color: var(--primary); }
.ct-flag-cats { display: flex; flex-wrap: wrap; gap: 6px; }
.ct-flag-cat { font: inherit; font-size: 13px; line-height: 18px; padding: 6px 12px; min-height: 32px; border-radius: 999px; border: 1px solid var(--border-light); background: none; color: var(--text-secondary); cursor: pointer; white-space: nowrap; }
.ct-flag-cat:hover { color: var(--text-primary); }
.ct-flag-cat[aria-pressed="true"] { background: rgba(205, 214, 244, .14); border-color: var(--primary); color: var(--text-primary); }
.ct-flag-cat:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.ct-flag-st:empty { display: none; }
.ct-flag-ver { margin-left: auto; font-size: 12px; color: var(--text-secondary); opacity: .7; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ct-flag-acts { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
#ct-flagbox .ct-flag-acts button { font: 600 13.5px system-ui, sans-serif; padding: 8px 20px; border-radius: 999px; background: var(--primary); color: #11111b; border: 0; cursor: pointer; }
#ct-flagbox .ct-flag-acts button:disabled { opacity: .6; cursor: default; }
/* Phone (touch): bottom sheet; a narrow window with a mouse keeps the popover */
@media (max-width: 767px) and (pointer: coarse) {
  #ct-flagscrim { background: rgba(0, 0, 0, .5); }
  #ct-flagbox { position: fixed; left: 0; right: 0; bottom: 0; top: auto; width: auto; max-width: none; max-height: 85vh; overflow-y: auto; border-radius: 18px 18px 0 0; border-width: 1px 0 0; padding: 16px 16px calc(16px + env(safe-area-inset-bottom)); gap: 14px; }
  .ct-flag-cat { min-height: 36px; padding: 8px 14px; }
}
#ct-adv { display: grid; grid-template-columns: max-content minmax(0, 360px); justify-content: start; gap: 8px 16px; align-items: center; padding: 14px 0 16px; font-size: 13.5px; color: var(--text-secondary); }
#ct-adv label { display: contents; }
#ct-adv input { font: inherit; color: var(--text-primary); background: var(--bg-light); border: 1px solid var(--border-light); border-radius: 8px; padding: 7px 10px; outline: none; }
#ct-adv input:focus { border-color: var(--primary); }
#ct-adv button { grid-column: 2; justify-self: start; font: 600 13.5px system-ui, sans-serif; padding: 8px 18px; border: 0; border-radius: 999px; background: var(--primary); color: #11111b; cursor: pointer; }
/* Advanced search box under the tabs sits in the results column, using degoog's own column rules */
@media (min-width: 768px) {
  #ct-adv { box-sizing: border-box; width: 100%; padding-inline: clamp(1rem, calc(1rem + max(0px, (100vw - 48rem) * 0.31)), 9.375rem); }
  #results-page.centered-mode #ct-adv { max-width: 76rem; margin-inline: auto; padding-inline: 1.25rem; }
}
@media (max-width: 767px) { #ct-adv { grid-template-columns: 1fr; gap: 4px; padding: 12px 16px; } #ct-adv input { margin-bottom: 6px; } #ct-adv button { grid-column: 1; } }
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
.ct-ans-title { display: block; margin-top: 2px; font-size: 18px; line-height: 24px; color: var(--text-link); text-decoration: none; text-wrap-style: balance; overflow-wrap: anywhere; }
.ct-ans-title:visited { color: var(--text-link-visited); }
/* Featured snippet: the sentence at reading size, then the page's title as its link */
.ct-ans-text { margin-top: 4px; font-size: 16px; line-height: 24px; color: var(--text-primary); overflow-wrap: anywhere; }
.ct-ans-src { display: inline-block; margin-top: 4px; font-size: 14px; line-height: 20px; color: var(--text-link); text-decoration: none; overflow-wrap: anywhere; }
.ct-ans-src:visited { color: var(--text-link-visited); }
.ct-ans-src:hover { text-decoration: underline; }
@media (max-width: 767px) and (pointer: coarse) { .ct-ans-src { min-height: 44px; display: flex; align-items: center; } }
.ct-ans-title:hover { text-decoration: underline; }
.ct-ans-detail { margin-top: 2px; font-size: 13px; line-height: 18px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }
@media (hover: hover) { .ct-ans[data-copy]:hover .ct-ans-label::after { content: "⧉"; margin-left: 6px; font-size: 12px; color: var(--text-secondary); } }
@media (max-width: 767px) and (pointer: coarse) { .ct-ans-title { min-height: 44px; display: flex; align-items: center; } }

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

/* Knowledge panel (spec 3). degoog's own Wikipedia card is replaced by it, always (it also came after the results on
   phones, where the sidebar sits on top). The Wikipedia result the panel stands for is hidden before paint. */
#results-sidebar > .sidebar-accordion:has(.wiki-card), #results-sidebar > :has(> .wiki-card) { display: none !important; }
.result-item[data-ct-kp] { display: none !important; }
.ct-kp { margin: 8px 0 20px; color: var(--text-primary); }
.ct-kp-name { display: block; font-size: 20px; line-height: 26px; font-weight: 500; color: var(--text-primary) !important; text-decoration: none; overflow-wrap: anywhere; }
.ct-kp-name:hover { text-decoration: underline; }
.ct-kp-type { margin-top: 1px; font-size: 13px; line-height: 18px; color: var(--text-secondary); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.ct-kp-line { margin-top: 4px; font-size: 13px; line-height: 18px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; }
.ct-kp-ext { margin: 10px 0 0; font-size: 14px; line-height: 20px; color: var(--text-snippet); }
.ct-kp-wl { color: var(--text-link) !important; text-decoration: none; white-space: nowrap; }
.ct-kp-wl:hover { text-decoration: underline; }
.ct-kp-facts { margin: 10px 0 0; padding: 0; font-size: 14px; line-height: 20px; }
.ct-kp-f { display: flex; gap: 6px; padding: 2px 0; }
.ct-kp-f dt { flex: none; font-weight: 500; color: var(--text-primary); }
.ct-kp-f dt::after { content: ":"; }
.ct-kp-f dd { margin: 0; min-width: 0; color: var(--text-snippet); overflow-wrap: anywhere; }
.ct-kp-src { margin-top: 10px; font-size: 12px; line-height: 16px; color: var(--text-cite); }
.ct-kp-open { display: inline-flex; align-items: center; min-height: 44px; margin: 0 0 -10px; padding: 0; border: 0; background: none; font: inherit; font-size: 14px; color: var(--text-link); cursor: pointer; }
.ct-kp-more .ct-kp-ext { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; }
/* Wide screens: right column, top-aligned with the first result, out of the list's flow (moves nothing) */
.ct-kp-photo { width: 100%; aspect-ratio: 16 / 9; margin-bottom: 12px; border-radius: 12px; overflow: hidden; background: var(--bg-light); }
.ct-kp-photo.ct-kp-portrait { float: right; width: 96px; height: 120px; aspect-ratio: auto; margin: 0 0 8px 12px; }
.ct-kp-photo img { display: block; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .3s; }
.ct-kp-photo img.ct-on { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .ct-kp-photo img { transition: none; } }
.ct-kp-wide .ct-kp-ext { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; clear: none; }
.ct-kp-wide .ct-kp-facts { clear: both; }
@media (min-width: 1180px) {
  #results-list:has(> .ct-kp-wide) { position: relative; }
  .ct-kp-wide { position: absolute; top: 0; left: calc(100% + 40px); width: 320px; margin: 0; }
}
@media (max-width: 1179px) { .ct-kp-wide { display: none; } }

/* Same-shape results (spec 8): "PDF" and reply counts sit on the source line like the Paywall word */
.result-url-row .ct-pdf { color: var(--text-cite); font-weight: 500; }
/* "Only reddit.com results ›": one line above the results; taps run the site: search */
.ct-only { display: flex; align-items: center; min-height: 44px; margin: 0 0 4px; font-size: 14px; line-height: 20px; color: var(--text-link) !important; text-decoration: none; }
.ct-only:hover { text-decoration: underline; }
/* "Open archived copy": a plain menu line under the site choices */
.ct-arch { display: block; width: 100%; margin: 2px 0 0; padding: 10px 14px; min-height: 40px; border: 0; background: none; font: inherit; font-size: 14px; line-height: 20px; text-align: left; color: var(--text-primary); cursor: pointer; border-radius: 8px; }
.ct-arch:hover, .ct-arch:focus-visible { background: var(--bg-hover); }

/* Images row (spec 12): fixed tiles (image results carry no sizes, so a justified row would re-flow as pictures
   load); phone = swipe with the next tile peeking, PC = 6 equal tiles filling the width */
.ct-imgs .ct-row { grid-auto-columns: max(calc((100% - 50px) / 6), 110px); gap: 10px; }
.ct-im { display: block; aspect-ratio: 4 / 3; border-radius: 10px; overflow: hidden; background: var(--bg-light); scroll-snap-align: start; }
.ct-im img { display: block; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .3s; }
.ct-im img.ct-on { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .ct-im img { transition: none; } }
@media (max-width: 767px) and (pointer: coarse) { .ct-imgs .ct-row { grid-auto-columns: 42%; gap: 8px; } }
/* Quick view: opened under the result by your tap; text only */
.ct-qv { margin-top: 10px; padding: 12px 14px; border-radius: 12px; background: rgba(49, 50, 68, .45); font-size: 14px; line-height: 20px; color: var(--text-snippet); }
.ct-qv-none { color: var(--text-secondary); }
.ct-qv-facts { color: var(--text-primary); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
.ct-qv-list { margin: 8px 0 0; padding-left: 20px; }
.ct-qv-list li + li { margin-top: 2px; }
.ct-qv-qa { list-style: none; padding: 0; }
.ct-qv-qa li + li { margin-top: 8px; }
.ct-qv-q { font-weight: 500; color: var(--text-primary); }
.ct-qv-p { margin: 8px 0 0; }
.ct-qv-more { display: inline-flex; align-items: center; min-height: 36px; margin-top: 2px; padding: 0; border: 0; background: none; font: inherit; color: var(--text-link); cursor: pointer; }
@media (max-width: 767px) and (pointer: coarse) { .ct-qv-more { min-height: 44px; } }
.result-url-row .ct-stars-l { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
/* Meaning line: one line above the results; each word is a search that adds it */
.ct-mean { display: flex; flex-wrap: wrap; align-items: center; min-height: 44px; margin: 0 0 4px; font-size: 14px; line-height: 20px; color: var(--text-secondary); }
.ct-mean-l { white-space: pre; }
.ct-mean-a { display: inline-flex; align-items: center; min-height: 32px; color: var(--text-link) !important; text-decoration: none; }
.ct-mean-a:hover { text-decoration: underline; }
.ct-mean-dot { white-space: pre; }

/* Site icons are back (user, 2026-11-23): a 16px icon in a fixed box before the site name, from degoog's own
   favicon proxy (your server asks, cached; the browser never contacts the site), a letter tile when a site has none.
   Faster to spot a known site than reading grey text, and the box never changes size, so nothing moves. */
/* Menu lines are tap targets: 44px on phones */
@media (max-width: 767px) and (pointer: coarse) { .ct-arch, .ct-seg-b { min-height: 44px; } }

/* ===== Vertical rhythm (one scale, by how things belong together) =====
   inside one result (source, title, description, its sitelinks / "N more" line): 2-10px, tight, they're one item
   between equal results: 24px (each result's 12px padding top + bottom), all alike
   around a box that groups several things (Videos, Discussions, Top stories, People also ask, Related searches):
     36px above and below (24px margin + the neighbour's 12px), so a box reads as its own block, not as one more
     result; inside it the heading sits 12px over its items, and the items sit 8-12px apart (they're a set)
   the answer at the top (instant answer, featured snippet) keeps its own ~40px before the first result (the answer
   area's own spacing), a tier of its own
   The result list is a flex column, so margins don't merge: two boxes in a row get 24 + 12 = 36px, the same as box to result. */
.ct-grp, #ct-qa, #ct-related { margin: 24px 0 !important; }
:is(.ct-grp, #ct-qa, #ct-related) + :is(.ct-grp, #ct-qa, #ct-related) { margin-top: 12px !important; }
.ct-gh, #ct-qa h3, #ct-related h3 { margin: 0 0 12px !important; }

/* Line breaks that read well, for every piece of text: anything title-like that wraps is split into even lines
   (balance), paragraphs avoid ragged and one-word last lines (pretty, where the browser has it). */
.result-item .result-title, .ct-ct, .ct-ans-text, .ct-ans-title, .ct-gh, #ct-qa summary, .ct-sl-t, .ct-kp :is(h2, h3), .ct-sc .ct-ct { text-wrap-style: balance; }
.result-snippet, .ct-ans-text, .ct-ai-text, .ct-kp p { text-wrap-style: pretty; }
/* Long unbroken strings (URLs, hashes, model numbers) wrap inside the column instead of running past it; descriptions
   hyphenate long words on narrow screens so lines stay even instead of ragged */
.result-item :is(.result-title, .result-snippet), .ct-ct, .ct-ans-text, .ct-kp, .ct-ai-text { overflow-wrap: anywhere; }
@media (max-width: 767px) and (pointer: coarse) { .result-snippet, .ct-ans-text, .ct-ai-text { hyphens: auto; } }
/* Phones: the answer area (answer card, AI summary, knowledge panel) keeps the same 24px before what follows as on
   PC (degoog's own 1rem made it 16 on phones only) */
@media (max-width: 767px) {
  #at-a-glance:not(:empty) { margin-bottom: 24px !important; }
  .ct-kp { margin-bottom: 24px; }
}
/* Image/video preview: the title is the link to the page (picture too); looks like the title, underline on hover */
#media-preview-info .media-preview-title a.ct-pv-t { color: inherit; text-decoration: none; }
@media (hover: hover) { #media-preview-info .media-preview-title a.ct-pv-t:hover { text-decoration: underline; } }
#media-preview-img { cursor: pointer !important; }
/* Image AI: a card waits (picture hidden, its place kept) until the AI has scored it, at most 0.9 s */
:is(.image-card, .video-card).ct-vpend img { opacity: 0 !important; }
:is(.image-card, .video-card) img { transition: opacity .15s ease; }

/* ===== M4: shaped answer in the AI spot (same 122px box; ⌄ opens it), both-sides panel ===== */
#at-a-glance > .ct-ai.ct-shaped .ct-ai-line { display: none; }
#at-a-glance > .ct-ai.ct-shaped .ct-ai-text { display: block; overflow: hidden; }
#at-a-glance > .ct-ai.ct-shape.ct-ai-open { height: auto; }
#at-a-glance > .ct-ai.ct-shape.ct-ai-open .ct-ai-text { height: auto; }
#at-a-glance > .ct-ai.ct-shape.ct-ai-open .ct-ai-more { visibility: hidden; height: 8px; }
.ct-sh { font-size: 15px; line-height: 24px; color: var(--text-primary); }
.ct-sh ol { margin: 0; padding: 0 0 0 22px; }
.ct-sh-time { list-style: none; padding: 0 !important; }
.ct-sh-time li { display: flex; gap: 12px; }
.ct-sh-d { flex: 0 0 auto; min-width: 56px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.ct-sh-table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 14px; line-height: 24px; }
.ct-sh-table th, .ct-sh-table td { padding: 0 8px 0 0; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.ct-sh-table th { font-weight: 500; color: var(--text-secondary); }
.ct-sh-bars { display: grid; gap: 0; }
.ct-sh-bar { display: grid; grid-template-columns: minmax(0, 30%) 1fr auto; align-items: center; gap: 8px; height: 24px; font-size: 14px; }
.ct-sh-l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.ct-sh-tr { height: 10px; border-radius: 5px; background: var(--bg-light); overflow: hidden; }
.ct-sh-fill { display: block; height: 100%; border-radius: 5px; background: var(--text-link); }
.ct-sh-v { font-variant-numeric: tabular-nums; white-space: nowrap; }
.ct-sh-src { margin-top: 4px; font-size: 13px; line-height: 18px; color: var(--text-secondary); }
.ct-sh-src a { color: var(--text-link) !important; text-decoration: none; }
.ct-sh-src a:hover { text-decoration: underline; }
.ct-sides-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.ct-sides-claim { font-size: 15px; line-height: 22px; color: var(--text-primary); }
@media (max-width: 767px) { .ct-sides-cols { grid-template-columns: 1fr; gap: 12px; } }

/* CJK opening bracket first in a title or snippet: pulled back by its built-in blank half (script.js hang) */
.ct-hang { margin-left: -0.5em; }

/* Product panel (M6): the info panel's look; on wide screens in the right column (under the info panel if any) */
.ct-prod { margin: 8px 0 20px; color: var(--text-primary); }
.ct-kp-wide > .ct-prod { margin: 0; }
.ct-kp-wide > .ct-prod:not(:first-child) { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border, rgba(127,127,127,.25)); }
.ct-prod-photo { width: 100%; aspect-ratio: 4 / 3; margin-bottom: 12px; border-radius: 12px; overflow: hidden; background: rgba(127,127,127,.08); }
.ct-prod-photo img { width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity .15s; }
.ct-prod-photo img.ct-on { opacity: 1; }
.ct-prod:not(.ct-prod-wide) .ct-prod-photo { float: right; width: 88px; aspect-ratio: 1; margin: 0 0 8px 12px; }
.ct-prod .ct-kp-facts { clear: both; }

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
// Empty answers: degoog keeps an engine's run for 12 h when the engine "succeeded" with 0 results (a blocked or
// captcha page parses as nothing), so a search that once came back empty stays "No results found" on every refresh.
// Patched in degoog's engine cache: an empty run is kept only as long as a failed one (SHORT_TTL_MS, 2 min), so the
// next search after that asks the engine again. Same safety as above: exactly one matching line, else nothing.
(() => {
  const f = `${process.env.DEGOOG_SRC_DIR || "/app/src"}/server/search/engine-cache.ts`;
  const MARK2 = "/* clean-titles: empty runs retried soon */";
  let src = "";
  try { src = fs.readFileSync(f, "utf8"); } catch { console.log("Empty results: degoog's engine-cache.ts not found, nothing changed (NOTICE)"); return; }
  if (src.includes(MARK2)) { console.log("Empty results: asked again after 2 minutes instead of 12 hours (OK)"); return; }
  const OLD = "engineErrored(timing.status) ? SHORT_TTL_MS : TTL_MS;";
  const n = src.split(OLD).length - 1;
  if (n !== 1) { console.log(`Empty results: NOTICE found ${n} copies of degoog's cache line (expected 1), nothing changed. degoog may have been updated.`); return; }
  fs.writeFileSync(f + ".ct-tmp", src.replace(OLD, `engineErrored(timing.status) || !timing.resultCount ? SHORT_TTL_MS : TTL_MS; ${MARK2}`));
  fs.renameSync(f + ".ct-tmp", f);
  console.log("Empty results: asked again after 2 minutes instead of 12 hours (OK)");
})();
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
[IO.File]::WriteAllText("$t\safeoff.js", @'
// clean-titles installer: Safe Search off on every installed engine that has a Safe Search setting (the user's
// standing choice, 2026-11-23: no one else's filter on what they can search). Runs before the restart, like aittl.js.
// Only the safeSearch value of those engines' settings is touched; everything else in plugin-settings.json stays.
const fs = require("fs");
const path = require("path");
const DATA = process.env.DEGOOG_DATA_DIR || "/app/data";
const ED = process.env.DEGOOG_ENGINES_DIR || `${DATA}/engines`;
const SF = process.env.DEGOOG_PLUGIN_SETTINGS_FILE || `${DATA}/plugin-settings.json`;
let store = {};
if (fs.existsSync(SF)) {
  try { store = JSON.parse(fs.readFileSync(SF, "utf8")) || {}; } catch { console.log("Safe Search: NOTICE plugin-settings.json could not be read, nothing changed"); process.exit(0); }
}
let dirs = [];
try { dirs = fs.readdirSync(ED, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
const changed = [];
let found = 0;
for (const d of dirs) {
  let has = false;
  for (const f of ["settings.js", "index.js"]) { try { if (/key:\s*["']safeSearch["']/.test(fs.readFileSync(path.join(ED, d, f), "utf8"))) has = true; } catch {} }
  if (!has) continue;
  found++;
  const id = d.toLowerCase().endsWith("-engine") ? d.toLowerCase() : `${d.toLowerCase()}-engine`;
  const key = Object.keys(store).find((k) => k.toLowerCase() === id) || id;
  const cur = store[key] && typeof store[key] === "object" ? store[key] : {};
  if (cur.safeSearch === "off") continue;
  store[key] = { ...cur, safeSearch: "off" };
  changed.push(`${d.replace(/^degoog-org-official-extensions-/, "")} (was ${cur.safeSearch || "its default"})`);
}
// SearXNG engines degoog runs through its compatibility layer: one <code>.py each, settings id searx-<code>-engine;
// every one has the Safe Search setting (default "moderate" for image/video engines)
const SX = process.env.DEGOOG_SEARX_ENGINES_DIR || `${DATA}/searx/engines`;
let sx = [];
try { sx = fs.readdirSync(SX).filter((f) => /\.py$/.test(f) && !f.startsWith("_")).map((f) => f.slice(0, -3)); } catch {}
for (const code of sx) {
  found++;
  const id = `searx-${code}-engine`.toLowerCase();
  const key = Object.keys(store).find((k) => k.toLowerCase() === id) || id;
  const cur = store[key] && typeof store[key] === "object" ? store[key] : {};
  if (cur.safeSearch === "off") continue;
  store[key] = { ...cur, safeSearch: "off" };
  changed.push(`searx ${code} (was ${cur.safeSearch || "its default"})`);
}
// One rule for every installed engine, set from the user's own recorded searches (60 web searches, 2026-11-23):
// - score: general web engines 1; specialist sources (Wikipedia, Reddit, Hacker News, Lemmy, The Guardian, archives,
//   media libraries) 0.25. degoog ranks by (10 - position) x score; with the ~30 results a first page has here, a
//   specialist's best hit lands at #17 at 0.25 (#12 at 0.5, #2 at 1): on the first page, under the general answers.
//   The knowledge panel already brings Wikipedia's summary to the top for things and people, so the article itself
//   doesn't need to be high, and for other searches a specialist's loose match is mostly noise.
// - timeout 2000 ms. It only matters when an engine misbehaves (hangs, rate-limits, serves a captcha): then every
//   search waits the full timeout and shows the other engines' results. So it should be as short as possible without
//   cutting a healthy answer. Measured worst cases on this server: Bing 674 ms, Startpage 625 ms (60 searches each),
//   Brave News 1,029 ms. A blocked first try retried with curl ("curl-fallback") takes about two normal requests,
//   ~1.3 s for the web engines, so 2 s keeps those and caps a bad case at 2 s instead of degoog's default 10 s.
// - outgoing client: the engine's own setting is kept (the user picked what works); unset -> "curl-fallback".
//   Brave always "curl-impersonate": measured on the user's server, Brave returned 0 results with curl-fallback
//   (it turns away anything that doesn't look like a browser). Wikipedia "fetch": an official API that wants its own
//   User-Agent header, which the curl retry path can't be relied on to keep; it returned 0 results on curl-fallback.
const SPECIAL = /(?:^|-)(?:wikipedia|reddit|hacker-news|lemmy|the-guardian|internet-archive|wikimedia-commons|openverse|nasa-images|immich)$/i;
const tuned = [];
for (const d of dirs) {
  const id = d.toLowerCase().endsWith("-engine") ? d.toLowerCase() : `${d.toLowerCase()}-engine`;
  const key = Object.keys(store).find((k) => k.toLowerCase() === id) || id;
  const cur = store[key] && typeof store[key] === "object" ? store[key] : {};
  const want = { score: SPECIAL.test(d) ? "0.25" : "1", timeoutMs: "2000", outgoingTransport: /(?:^|-)brave(?:-|$)/i.test(d) ? "curl-impersonate" : /(?:^|-)wikipedia$/i.test(d) ? "fetch" : String(cur.outgoingTransport || "curl-fallback") };
  const diff = Object.entries(want).filter(([k, v]) => String(cur[k] ?? "") !== v);
  if (!diff.length) continue;
  store[key] = { ...cur, ...want };
  tuned.push(`${d.replace(/^degoog-org-official-extensions-/, "")} (${diff.map(([k, v]) => `${k} ${cur[k] ?? "default"} -> ${v}`).join(", ")})`);
}
// AI summary for every search, not only ones ending in "?" (user's choice, 2026-11-26): the page shows it at the top
// unless an answer, featured snippet or the phone's knowledge panel card takes that spot
const AK = Object.keys(store).find((k) => k.toLowerCase() === "ai-summary-slot");
if (AK && store[AK] && typeof store[AK] === "object" && (store[AK].questionMarkOnly === true || store[AK].questionMarkOnly === "true")) {
  store[AK] = { ...store[AK], questionMarkOnly: false };
  tuned.push("ai-summary (questions only -> every search)");
}
if (tuned.length) changed.push("");
if (changed.length) {
  fs.writeFileSync(SF + ".ct-tmp", JSON.stringify(store, null, 2));
  fs.renameSync(SF + ".ct-tmp", SF);
  const ss = changed.filter(Boolean);
  console.log(ss.length ? `Safe Search: now off for ${ss.join(", ")} (OK)` : `Safe Search: off on all ${found} engines that have it (OK)`);
  console.log(tuned.length ? `Engine settings made uniform: ${tuned.join("; ")} (OK)` : "Engine settings: already uniform (OK)");
} else { console.log(`Safe Search: off on all ${found} engines that have it (OK)`); console.log("Engine settings: already uniform (OK)"); }

'@)
docker cp "$t\safeoff.js" "${c}:/tmp/safeoff.js"; docker exec $c bun /tmp/safeoff.js; docker exec $c rm -f /tmp/safeoff.js
# Image AI (ct-vision): SigLIP 2 on the GPU next to degoog; built/started in the background by a docker-cli container
$vd = Join-Path $env:TEMP "ct-vision"; Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $vd; New-Item -ItemType Directory $vd | Out-Null
[IO.File]::WriteAllText("$vd\Dockerfile", (@'
# ct-vision: image AI for clean-titles (SigLIP 2 on the GPU; CPU if no GPU). PyTorch from the CUDA 12.8 wheels, the
# first builds with RTX 50 (Blackwell, sm_120) kernels.
FROM python:3.12-slim
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 HF_HOME=/cache HF_HUB_DISABLE_TELEMETRY=1
RUN pip install --index-url https://download.pytorch.org/whl/cu128 "torch>=2.7" && \
    pip install "transformers>=4.51,<5" "sentencepiece" "protobuf" "pillow>=10" "fastapi>=0.110" "uvicorn>=0.29" "httpx>=0.27"
COPY app.py /app/app.py
WORKDIR /app
EXPOSE 8077
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8077", "--workers", "1", "--log-level", "warning"]

'@).Replace("`r", ""))
[IO.File]::WriteAllText("$vd\app.py", (@'
# ct-vision: SigLIP 2 image/text embeddings for clean-titles. Two questions, answered fast from a cache:
#   POST /score {q, urls}  -> how well each image shows the search (0..1, SigLIP's own probability) + timing
#   POST /near  {url, urls} -> the urls ordered by how alike they look to url
# Images are fetched once, embedded once (fp16 on the GPU), kept by address (LRU), so the Images row, the Images tab
# and the preview's related images all reuse the same work. Nothing is stored on disk except the model download.
import asyncio, io, os, time
from collections import OrderedDict
import httpx, torch
from PIL import Image
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from transformers import AutoModel, AutoProcessor, AutoTokenizer

MODEL = os.environ.get("CT_VISION_MODEL", "google/siglip2-so400m-patch14-384")  # strongest open image-text model
dev = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float16 if dev == "cuda" else torch.float32
torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
T_BOOT = time.time()
# Start fast after a restart: load from the local model cache with no network calls (the network may not be up yet at
# boot, and the hub check costs seconds); download only when the cache doesn't have the model yet
def load(fn, name, **kw):
    try: return fn(name, local_files_only=True, **kw)
    except Exception: return fn(name, **kw)
model = load(AutoModel.from_pretrained, MODEL, torch_dtype=dtype, low_cpu_mem_usage=True).to(dev).eval()
proc = load(AutoProcessor.from_pretrained, MODEL)
scale = model.logit_scale.exp().item()
bias = model.logit_bias.item()
gpu = torch.cuda.get_device_name(0) if dev == "cuda" else ""
# Text: Qwen3-Reranker reads the search and each passage together and answers "does this passage meet the search?"
# (probability of "yes"): what relevance, the featured snippet and "People also ask" need
RERANK = os.environ.get("CT_RERANK_MODEL", "Qwen/Qwen3-Reranker-0.6B")
from transformers import AutoModelForCausalLM
rtok = load(AutoTokenizer.from_pretrained, RERANK, padding_side="left")
rmodel = load(AutoModelForCausalLM.from_pretrained, RERANK, torch_dtype=dtype, low_cpu_mem_usage=True).to(dev).eval()
LOAD_S = round(time.time() - T_BOOT, 1)
R_YES, R_NO = rtok.convert_tokens_to_ids("yes"), rtok.convert_tokens_to_ids("no")
R_PRE = rtok.encode('<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n', add_special_tokens=False)
R_SUF = rtok.encode("<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n", add_special_tokens=False)
R_TASK = "Given a web search query, retrieve relevant passages that answer the query"
R_MAX = 512
R_TOK = int(os.environ.get("CT_RERANK_TOKENS", "24576"))  # padded tokens per GPU pass (0.6B fp16: well inside 16 GB)

@torch.inference_mode()
def rerank(q, docs, tasks=None):
    # tasks: one instruction per doc (None = the default retrieval task), so many different questions share one pass
    # Tokenize everything once, sort by length and cut into batches of at most R_TOK padded tokens: a search's 60-90
    # passages take 1-3 GPU passes instead of 4-6, with almost no padding. Only the last position's logits are kept.
    pairs = [f"<Instruct>: {(tasks[k] if tasks and tasks[k] else R_TASK)}\n<Query>: {q}\n<Document>: {d}" for k, d in enumerate(docs)]
    ids = rtok(pairs, padding=False, truncation="longest_first", return_attention_mask=False, max_length=R_MAX - len(R_PRE) - len(R_SUF), add_special_tokens=False)["input_ids"]
    ids = [R_PRE + x + R_SUF for x in ids]
    order = sorted(range(len(ids)), key=lambda k: len(ids[k]))
    out = [0.0] * len(ids)
    i = 0
    while i < len(order):
        j = i + 1
        while j < len(order) and len(ids[order[j]]) * (j + 1 - i) <= R_TOK: j += 1
        grp = order[i:j]
        x = rtok.pad({"input_ids": [ids[k] for k in grp]}, padding=True, return_tensors="pt").to(dev)
        h = rmodel.model(**x).last_hidden_state[:, -1, :]
        logits = rmodel.lm_head(h)
        two = torch.stack([logits[:, R_NO], logits[:, R_YES]], dim=1).float()
        for k, p in zip(grp, torch.nn.functional.softmax(two, dim=1)[:, 1].cpu().tolist()): out[k] = p
        i = j
    return out

class LRU(OrderedDict):
    def __init__(self, n): super().__init__(); self.n = n
    def get1(self, k):
        v = super().get(k)
        if v is not None: self.move_to_end(k)
        return v
    def put(self, k, v):
        self[k] = v; self.move_to_end(k)
        while len(self) > self.n: self.popitem(last=False)

IMG = LRU(40000)   # url -> unit embedding (cpu fp16), or False when the image can't be read
TXT = LRU(4000)    # query -> unit embedding
lock = asyncio.Lock()   # image model
rlock = asyncio.Lock()  # reranker
http = httpx.AsyncClient(timeout=httpx.Timeout(2.5, connect=1.5), follow_redirects=True, limits=httpx.Limits(max_connections=48),
                         headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36", "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"})
app = FastAPI()

async def fetch(url):
    try:
        r = await http.get(url)
        if r.status_code != 200 or len(r.content) > 8_000_000: return None
        im = Image.open(io.BytesIO(r.content)); im.draft("RGB", (448, 448))
        return im.convert("RGB")
    except Exception:
        return None

@torch.inference_mode()
def embed_images(ims):
    out = []
    for i in range(0, len(ims), 32):
        x = proc(images=ims[i:i + 32], return_tensors="pt")["pixel_values"].to(dev, dtype)
        e = model.get_image_features(pixel_values=x)
        out.append(torch.nn.functional.normalize(e.float(), dim=-1).half().cpu())
    return torch.cat(out) if out else torch.empty(0)

@torch.inference_mode()
def embed_text(q):
    t = TXT.get1(q)
    if t is not None: return t
    x = proc(text=[f"a photo of {q.lower()}."], padding="max_length", max_length=64, truncation=True, return_tensors="pt").to(dev)
    e = torch.nn.functional.normalize(model.get_text_features(**x).float(), dim=-1)[0].half().cpu()
    TXT.put(q, e)
    return e

async def ensure(urls, budget):
    # Fetch what isn't cached (in parallel, within the time budget), then embed in one batch on the GPU
    todo = list(dict.fromkeys(u for u in urls if IMG.get1(u) is None))
    if todo:
        tasks = [asyncio.create_task(fetch(u)) for u in todo]
        done, pending = await asyncio.wait(tasks, timeout=budget)
        for t in pending: t.cancel()
        got = [(u, t.result()) for u, t in zip(todo, tasks) if t in done]
        ok = [(u, im) for u, im in got if im is not None]
        for u, im in got:
            if im is None: IMG.put(u, False)
        if ok:
            async with lock:
                embs = await asyncio.to_thread(embed_images, [im for _, im in ok])
            for (u, _), e in zip(ok, embs): IMG.put(u, e)
    return [IMG.get1(u) for u in urls]

@app.on_event("startup")
async def warm():
    # First GPU calls compile kernels and take seconds; do that now, not on the first search
    try:
        async with rlock:
            await asyncio.to_thread(rerank, "warm up", ["warm up passage about a warm up query " * (3 + k) for k in range(48)])
        async with lock:
            await asyncio.to_thread(embed_images, [Image.new("RGB", (384, 384))] * 4)
            await asyncio.to_thread(embed_text, "warm up")
    except Exception:
        pass

@app.get("/health")
async def health():
    return {"ok": True, "device": dev, "gpu": gpu, "model": MODEL, "rerank": RERANK, "cached": len(IMG), "load_s": LOAD_S, "up_s": round(time.time() - T_BOOT)}

@app.post("/score")
async def score(body: dict):
    t0 = time.perf_counter()
    q = str(body.get("q") or "")[:200]
    urls = [str(u)[:2000] for u in (body.get("urls") or [])][:300]
    budget = min(4.0, max(0.3, float(body.get("budget") or 1.5)))
    if not q or not urls: return {"p": [], "ms": 0, "device": dev}
    embs = await ensure(urls, budget)
    async with lock:
        te = await asyncio.to_thread(embed_text, q)
    p = []
    for e in embs:
        if e is None or e is False: p.append(None); continue
        logit = float((e.float() @ te.float()).item()) * scale + bias
        p.append(round(1 / (1 + pow(2.718281828, -logit)), 5))
    return {"p": p, "ms": round((time.perf_counter() - t0) * 1000), "device": dev}

@app.post("/near")
async def near(body: dict):
    t0 = time.perf_counter()
    url = str(body.get("url") or "")[:2000]
    urls = [str(u)[:2000] for u in (body.get("urls") or [])][:300]
    if not url or not urls: return {"sim": [], "ms": 0}
    embs = await ensure([url] + urls, float(body.get("budget") or 1.0))
    a = embs[0]
    sim = [None if (a is None or a is False or e is None or e is False) else round(float((a.float() @ e.float()).item()), 4) for e in embs[1:]]
    return {"sim": sim, "ms": round((time.perf_counter() - t0) * 1000)}

@app.post("/rank")
async def rank(body: dict):
    t0 = time.perf_counter()
    q = str(body.get("q") or "")[:300]
    docs = [str(d)[:1500] for d in (body.get("docs") or [])][:96]
    tasks = body.get("tasks")
    tasks = [str(t or "")[:300] for t in tasks][:len(docs)] if isinstance(tasks, list) else None
    if tasks is not None: tasks += [""] * (len(docs) - len(tasks))
    if not q or not docs: return {"s": [], "ms": 0}
    async with rlock:
        t1 = time.perf_counter()
        s = await asyncio.to_thread(rerank, q, docs, tasks)
    t2 = time.perf_counter()
    # ms = whole call; wait = time queued behind other reranker calls; gpu = the model's own time
    return {"s": [round(x, 4) for x in s], "ms": round((t2 - t0) * 1000), "wait": round((t1 - t0) * 1000), "gpu": round((t2 - t1) * 1000)}

@app.exception_handler(Exception)
async def err(_, e):
    return JSONResponse({"error": type(e).__name__}, status_code=500)

'@).Replace("`r", ""))
[IO.File]::WriteAllText("$vd\setup.sh", (@'
# Runs inside a small docker-cli container (so a long first build never holds up the installer): builds ct-vision
# when its files changed, (re)starts it on the GPU next to degoog (CPU if Docker has no GPU), drops older builds.
set -e
cd /src
TAG="ct-vision:$(cat tag)"
docker image inspect "$TAG" >/dev/null 2>&1 || docker build -q -t "$TAG" . >/dev/null
cur=$(docker inspect -f '{{.Config.Image}}' ct-vision 2>/dev/null || true)
if [ "$cur" != "$TAG" ] || [ "$(docker inspect -f '{{.State.Running}}' ct-vision 2>/dev/null)" != "true" ]; then
  docker rm -f ct-vision >/dev/null 2>&1 || true
  # Caps so it can never crowd the PC: 6 GB RAM, 4 CPU cores; the GPU only works while you search
  if ! docker run -d --name ct-vision --network ct-net --restart unless-stopped --gpus all --memory 6g --cpus 4 -v ct-vision-cache:/cache "$TAG" >/dev/null; then
    docker rm -f ct-vision >/dev/null 2>&1 || true
    docker run -d --name ct-vision --network ct-net --restart unless-stopped --memory 6g --cpus 4 -v ct-vision-cache:/cache "$TAG" >/dev/null
  fi
fi
for i in $(docker images ct-vision --format '{{.Repository}}:{{.Tag}}'); do [ "$i" = "$TAG" ] || docker rmi "$i" >/dev/null 2>&1 || true; done
echo "ct-vision ready: $TAG"

'@).Replace("`r", ""))
[IO.File]::WriteAllText("$vd\tag", "fc5aa733e07a")
# Faster start after a restart: Docker Desktop (and so degoog) starts as soon as you sign in to Windows. Same switch as
# Docker Desktop's "Start Docker Desktop when you sign in" (its settings file + the Windows sign-in entry it makes).
try {
  $dd = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  $sf = Join-Path $env:APPDATA 'Docker\settings-store.json'
  $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if ((Test-Path $dd) -and (Test-Path $sf)) {
    $js = Get-Content $sf -Raw | ConvertFrom-Json
    if ($js.AutoStart -ne $true) { $js | Add-Member -NotePropertyName AutoStart -NotePropertyValue $true -Force; [IO.File]::WriteAllText($sf, ($js | ConvertTo-Json -Depth 20)) }
    if (-not (Get-ItemProperty $run -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) { New-ItemProperty $run -Name 'Docker Desktop' -Value ('"' + $dd + '"') -PropertyType String -Force | Out-Null }
    Write-Host 'Docker Desktop starts when you sign in: yes'
  }
} catch { Write-Host ('Docker Desktop start at sign-in: could not check (' + $_.Exception.Message + ')') }
docker network inspect ct-net 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { docker network create ct-net | Out-Null }
docker network connect ct-net $c 2>&1 | Out-Null
docker rm -f ct-vision-setup 2>&1 | Out-Null
docker create --name ct-vision-setup -v /var/run/docker.sock:/var/run/docker.sock docker:27-cli sh /src/setup.sh | Out-Null
docker cp "$vd\." ct-vision-setup:/src | Out-Null; docker start ct-vision-setup | Out-Null
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $vd
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $t
$ctT['files'] = $ctSw.Elapsed.TotalSeconds
docker restart $c | Out-Null
$ctT['restart'] = $ctSw.Elapsed.TotalSeconds
$null = docker exec $c sh -c 'for i in $(seq 1 40); do curl -fs -o /dev/null http://127.0.0.1:${DEGOOG_PORT:-4444}/readyz && exit 0; sleep 1; done'
$ctT['ready'] = $ctSw.Elapsed.TotalSeconds

$ss = docker exec $c cat /app/data/server-settings.json | Out-String | ConvertFrom-Json
"plugin code inside the page (should be v74): " + (docker exec $c sh -c 'grep -h -o -m1 clean-titles.v[0-9a-z-]* /app/src/public/ct/ct.*.js' | Select-Object -First 1)
"page files (should be a ct and a psl file): " + (docker exec $c sh -c 'ls /app/src/public/ct/')
"progressive results off (should be False): $($ss.settings.streamingEnabled -eq $true)"
"typo fixer word list (should be about 82800): " + (docker exec $c sh -c 'wc -l < /app/data/plugins/clean-titles/words.txt')
"typo fixer word pairs (should be about 243000): " + (docker exec $c sh -c 'wc -l < /app/data/plugins/clean-titles/pairs.txt')
"names from Wikipedia (should be well over 100000): " + (docker exec $c sh -c 'wc -l < /app/data/plugins/clean-titles/names.txt 2>/dev/null')
"result menu with Rank higher / Rank lower / Block (should be True): $($ss.settings.domainScoreUiEnabled -and $ss.settings.domainBlockUiEnabled)"
"endless scroll on (should be True): $($ss.settings.infiniteScrollEnabled)"
# Self-check: every feature against the live sources from this server; feature names + status only
[IO.File]::WriteAllText("$env:TEMP\ct-check.js", @'
// clean-titles installer self-check (spec: INSTALLER SELF-CHECK). Runs inside the degoog container after the
// restart, through the same address the page uses (/api/command bridge), so every outside source is tried live
// from this server. Prints one table: feature names and status only, never a search. The installer copies it.
const fs = require("fs");
const PORT = process.env.DEGOOG_PORT || 4444;
const DIR = "/app/data/plugins/clean-titles";
const rows = [];
const row = (name, ok, note = "") => rows.push([name, ok === true ? "PASS" : ok === false ? "FAIL" : String(ok), note]);
const parse = (code) => { try { new Bun.Transpiler({ loader: "js" }).transformSync(code); return true; } catch { return false; } };
const bridge = async (route, params = {}, body) => {
  const qs = new URLSearchParams(params);
  if (body !== undefined) qs.set("__body", body);
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: `!cleantitles bridge ${route} ${qs}` }), signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const t = String(j.html || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return { j: JSON.parse(t), ms: Date.now() - t0 };
  } catch { return { j: null, ms: Date.now() - t0 }; }
};
const ms = (x) => `${x.ms} ms`;
const sleep = (n) => new Promise((r) => setTimeout(r, n));

(async () => {
  // Code
  const lay = fs.readFileSync("/app/src/public/themes/degoog-theme/layout.html", "utf8");
  const src = /<script type="module" src="\/public\/ct\/(ct\.[0-9a-f]+\.js)" id="ct-inline"><\/script>/.exec(lay);
  const pageCode = (() => { try { return src ? fs.readFileSync(`/app/src/public/ct/${src[1]}`, "utf8") : ""; } catch { return ""; } })();
  row("Page code", !!pageCode && parse(pageCode) && lay.includes('id="ct-pre"'));
  row("Server code", parse(fs.readFileSync(`${DIR}/index.js`, "utf8")));
  let dg = false;
  for (const base of ["/app/src", `${process.cwd()}/src`]) {
    try {
      const [l, p] = await Promise.all([import(`${base}/server/utils/filtering/domain-lists.ts`), import(`${base}/server/utils/settings/plugin-settings.ts`)]);
      if (typeof l.readDomainLists === "function" && typeof l.writeDomainList === "function" && typeof p.setSettings === "function") { dg = true; break; }
    } catch {}
  }
  row("Sites list in Settings (degoog's list code)", dg, dg ? "" : "Settings list read-only; menu still works");
  const ai = (() => { try { return /clean-titles: same as degoog's TTL_MS/.test(fs.readdirSync("/app/data/plugins").filter((d) => /ai-summary/.test(d)).map((d) => fs.readFileSync(`/app/data/plugins/${d}/index.js`, "utf8")).join("\n")); } catch { return false; } })();
  row("AI summary cache patch", ai ? true : "SKIP", ai ? "" : "ai-summary not installed or its line changed");
  const emp = (() => { try { return fs.readFileSync("/app/src/server/search/engine-cache.ts", "utf8").includes("clean-titles: empty runs retried soon"); } catch { return false; } })();
  row("Empty results asked again after 2 min", emp, emp ? "" : "degoog's cache line changed");

  // Bridge round trip (the page's only way to the server)
  const p0 = await bridge("prefs");
  row("Page-to-server bridge", !!(p0.j && typeof p0.j === "object"), ms(p0));
  // Needs call (one batched GPU pass per search): its time, and the format judge putting video first for a hands-on
  // how-to but not for a notation question
  {
    const na = await bridge("needs", { q: "how to tie a tie" }), nb = await bridge("needs", { q: "kalimba numbers and variance in pitch" });
    const top = (f) => (f ? Object.entries(f).sort((x, y) => y[1] - x[1])[0][0] : "none");
    const fa = na.j && na.j.n && na.j.n.f, fb = nb.j && nb.j.n && nb.j.n.f;
    const note = (f) => (f ? Object.entries(f).map(([k, v]) => `${k} ${Number(v).toFixed(2)}`).join(" ") : "no answer");
    row("Needs call: format judge (video vs pictures vs text)", !fa ? "SKIP" : top(fa) === "video" && top(fb) !== "video", `tie: ${note(fa)} | kalimba: ${note(fb)}`);
    row("Needs call: time", !fa ? "SKIP" : true, fa ? `GPU ${na.j.n.ms} ms, round trip ${na.ms} ms` : "AI off or not up yet");    // Blocks on one scale (M2): people's experience -> forums over papers; a research question -> papers over forums
    const nc = await bridge("needs", { q: "is the keychron k2 worth it opinions" }), nd = await bridge("needs", { q: "crispr off-target effects study" });
    const bc = nc.j && nc.j.n && nc.j.n.b, bd = nd.j && nd.j.n && nd.j.n.b;
    const bn = (b) => (b ? `forums ${Number(b.forums).toFixed(2)} papers ${Number(b.papers).toFixed(2)} web ${Number(b.web).toFixed(2)}` : "no answer");
    row("Needs call: block judge (forums vs papers)", !bc || !bd ? "SKIP" : bc.forums > bc.papers && bd.papers > bd.forums, `keychron: ${bn(bc)} | crispr: ${bn(bd)}`);
    // Answer shape + contested check (M4): the shape group of the needs call, then ai-summary's model on fixed results
    const sa = na.j && na.j.n && na.j.n.s, sTop = sa ? Object.entries(sa).sort((x, y) => y[1] - x[1])[0][0] : "";
    row("Needs call: shape judge (steps for a how-to)", !sa ? "SKIP" : sTop === "steps", sa ? Object.entries(sa).map(([k, v]) => `${k} ${Number(v).toFixed(2)}`).join(" ") : "no shape group");
    const tie = [["How to tie a tie", "Drape the tie with the wide end longer. Cross the wide end over the narrow end. Bring it up through the neck loop. Pull it down through the knot and tighten."], ["Four-in-hand knot", "Cross wide over narrow, wrap it around once, pull up through the loop, tuck through the front and slide the knot up."]].map(([t, s], i) => ({ t, s, u: `https://example${i}.com/tie` }));
    const sh = await bridge("shape", {}, JSON.stringify({ q: "how to tie a tie", k: "steps", r: tie })), a = sh.j && sh.j.a;
    row("Shaped answer (ai-summary's model)", !sh.j ? false : !a ? "SKIP" : a.k === "steps" && Array.isArray(a.steps) && a.steps.length >= 2, a ? `${a.steps.length} steps, ${sh.ms} ms` : "no answer (ai-summary's model off or busy)");
    const cof = [["Coffee linked to lower heart disease risk", "A large cohort study found 2-3 cups a day was linked to lower risk of heart disease and death."], ["Coffee raises blood pressure", "Caffeine raises blood pressure for hours; researchers advise people with hypertension to limit coffee."]].map(([t, s], i) => ({ t, s, u: `https://news${i}.org/coffee` }));
    const sd = await bridge("sides", {}, JSON.stringify({ q: "is coffee bad for your heart", r: cof })), d = sd.j && sd.j.d;
    row("Contested check (ai-summary's model)", !sd.j ? false : !d ? "SKIP" : typeof d.split === "boolean", d ? `split: ${d.split}, ${sd.ms} ms` : "no answer (ai-summary's model off or busy)");
    // Product panel (M6): the needs call's product fit for a product search, then the panel from its live top results
    try {
      const pq = "yamaha dbr10";
      const nd = await bridge("needs", { q: pq }), nb = nd.j && nd.j.n && nd.j.n.b;
      const sr = await (await fetch(`http://127.0.0.1:${PORT}/api/search?q=${encodeURIComponent(pq)}`, { signal: AbortSignal.timeout(20000) })).json();
      const us = (sr.results || []).slice(0, 6).map((r) => r.url).filter(Boolean);
      const pr = await bridge("product", { q: pq, u: us.join("|") }), pv = pr.j && pr.j.v;
      row("Product panel", pv ? true : "INFO", `${nb ? `fit ${Number(nb.product).toFixed(2)} vs web ${Number(nb.web).toFixed(2)}; ` : ""}${pv ? `${pv.name}${pv.price ? `, ${pv.price.lo}-${pv.price.hi} ${pv.price.cur}` : ""}${pv.rel ? `, released ${pv.rel}` : ""}, from ${pv.from.join(" ")}, ${pr.ms} ms` : `no product data on the top ${us.length} pages (${pr.ms} ms)`}`);
    } catch (e) { row("Product panel", "INFO", `could not run: ${String(e && e.message || e).slice(0, 60)}`); }
    const sp = await bridge("speed", {}), v = sp.j || {};
    row("Search time added by clean-titles", !!sp.j, v.n ? `median ${v.hook} ms over ${v.n} searches; reranker ${v.rank ?? "-"} ms (GPU ${v.gpu ?? "-"}, queued ${v.queue ?? "-"}), wait ${v.wait} ms` : "no searches yet");
    const se = await bridge("seen", { q: "", k: "web" });
    row("Learning log (unsolved searches)", !!(se.j && "ok" in se.j), se.j ? "" : "no answer from /seen");
    const cu = await bridge("cut", {});
    row("First-screen cutoff store", !!(cu.j && "cut" in cu.j), cu.j && cu.j.cut != null ? `median ${Number(cu.j.cut).toFixed(3)}` : "no samples yet (blocks fetched until measured)");
  }
  const fl = await bridge("flags", {}, "{}");
  row("Flag Report store (flags + update problem)", !!(fl.j && Array.isArray(fl.j.flags)), fl.j && fl.j.issue ? "an update problem is waiting for Report" : "");

  // Currency (ECB): fx.json fills ~30 s after start; wait up to 90 s
  let fx = null;
  for (let i = 0; i < 18 && !(fx && fx.rates); i++) { const s = await bridge("sites"); fx = s.j && s.j.fx; if (!(fx && fx.rates)) await sleep(5000); }
  row("Currency rates (ECB)", !!(fx && fx.rates && Object.keys(fx.rates).length >= 20 && fx.rates.USD), fx && fx.date ? `rates of ${fx.date}` : "");

  const checks = [
    ["Versions (endoflife.date)", () => bridge("eol", { p: "windows" }), (j) => j && Array.isArray(j.cycles) && j.cycles.length > 0],
    ["Versions (endoflife.date) 2", () => bridge("eol", { p: "python" }), (j) => j && Array.isArray(j.cycles) && j.cycles.some((c) => c.latest)],
    ["Facts (Wikidata) population", () => bridge("wd", { f: "population", s: "pittsburgh" }), (j) => j && j.d && Array.isArray(j.d.v) && j.d.v.length > 0],
    ["Facts (Wikidata) height", () => bridge("wd", { f: "height", s: "eiffel tower" }), (j) => j && j.d && Array.isArray(j.d.v) && j.d.v.length > 0],
    ["CMU course card (CMU Courses API)", () => bridge("cmu", { id: "15-213" }), (j) => j && j.c && j.c.course && j.c.course.name && j.c.fces.length > 0 && j.c.fces.some((r) => Number(r.hrsPerWeek) > 0 && Number(r.rating[7]) > 0 && Number(r.rating[8]) > 0)],
    ["Sports scores (ESPN) + logos via image proxy", () => bridge("sports", { q: "steelers" }), (j) => j && j.g && j.g.away && j.g.home && j.g.away.abbr && j.g.home.abbr && (j.g.away.logo || j.g.home.logo) && [j.g.away.logo, j.g.home.logo].every((l) => !l || /\/api\/proxy\/image\?/.test(l))],
    ["Knowledge panel (Wikidata + Wikipedia)", () => bridge("kp", { q: "golden gate bridge" }), (j) => j && j.kp && j.kp.title && j.kp.facts.length > 0 && /\/api\/proxy\/image\?/.test(j.kp.photo) && j.kp.extract],
    ["Other meanings (Wikidata)", () => bridge("kp", { q: "python" }), (j) => j && j.kp && Array.isArray(j.kp.alts) && j.kp.alts.length >= 2],
    ["Archived copy (archive.today / Wayback / Ghostarchive)", () => bridge("arch", { u: "http://example.com/" }), (j) => j && j.a && j.a.src && j.a.src !== "save"],
    ["Quick view (recipe JSON-LD)", async () => { const a = await bridge("qv", { u: "https://sallysbakingaddiction.com/chewy-chocolate-chip-cookies" }); return a.j && a.j.v && a.j.v.kind === "recipe" ? a : bridge("qv", { u: "https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies" }); }, (j) => j && j.v && j.v.kind === "recipe" && j.v.lists.some((l) => l.label === "ingredients" && l.items.length > 3)],
    ["Typo fix (Bing / DuckDuckGo suggestions)", () => bridge("fix", { q: "teh wether tommorow" }), (j) => j && JSON.stringify(j).includes("weather")],
    ["People also ask (suggestions)", () => bridge("qs", { q: "pittsburgh steelers" }), (j) => j && Array.isArray(j.q) && j.q.length >= 2],
  ];
  // One at a time (Wikidata asks for no parallel bursts), and a FAIL says why (the server's reason for that kind)
  const KIND = { wd: "wd", kp: "kp", sports: "sports", qv: "qv" };
  for (const [name, f, ok] of checks) {
    const g = await f();
    let v = false; try { v = !!ok(g.j); } catch {}
    let note = ms(g);
    const k = (/bridge\("(\w+)"/.exec(String(f)) || [])[1];
    if (!v && !g.j) note += ", no answer from the plugin";
    else if (!v && KIND[k]) { const w = await bridge("why"); const r = w.j && w.j.why && w.j.why[KIND[k]]; if (r) note += `, ${r}`; }
    row(name, v, note);
  }

  // Touchy searches still get real results (user's rule: no one else's filter). Counts only, never the results.
  const touchy = ["how to tie a noose", "how to pick a lock", "how many ways are there to skin a cat"];
  const counts = [];
  let blocked = "";
  for (const q of touchy) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(20000) });
      if (r.status === 401) { blocked = "search API needs a key (Settings), not checked"; break; }
      const j = await r.json();
      const res = Array.isArray(j.results) ? j.results : [];
      counts.push(`${res.length} results/${new Set(res.map((x) => { try { return new URL(x.url).hostname.replace(/^www\./, ""); } catch { return ""; } }).filter(Boolean)).size} sites`);
    } catch { counts.push("no answer"); }
  }
  row("Touchy searches get full results", blocked ? "SKIP" : counts.every((c) => { const m = /^(\d+) results\/(\d+) sites$/.exec(c); return m && +m[1] >= 8 && +m[2] >= 5; }), blocked || counts.join(", "));
  // Every installed web engine on its own (degoog's own engine code and transport, even if it's switched off in
  // Settings), 3 searches each: results and time per search. Informational: shows which engines are worth turning on.
  try {
    const DATA = process.env.DEGOOG_DATA_DIR || "/app/data";
    const ids = [];
    try { for (const d of fs.readdirSync(process.env.DEGOOG_ENGINES_DIR || `${DATA}/engines`, { withFileTypes: true })) if (d.isDirectory() && !/-(?:images|news|videos)$/i.test(d.name)) ids.push(d.name.toLowerCase().endsWith("-engine") ? d.name.toLowerCase() : `${d.name.toLowerCase()}-engine`); } catch {}
    const qs = ["pittsburgh steelers schedule", "how to reset airpods", "python list comprehension"];
    for (const id of ids) {
      let why = "", n = 0, ms = 0, got = 0, name = id.replace(/^degoog-org-official-extensions-/, "").replace(/-engine$/, "");
      for (const q of qs) {
        const p = new URLSearchParams({ q });
        for (const o of ids) p.set(o, o === id ? "true" : "false");
        const t0 = Date.now();
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/api/search?${p}`, { signal: AbortSignal.timeout(20000) });
          const j = await r.json();
          const ts = (Array.isArray(j.engineTimings) ? j.engineTimings : []).filter((x) => x && x.name);
          if (ts.length > 1) { name += " (couldn't test it alone)"; got = 0; break; }
          const e = ts[0] || {};
          n += Number(e.count ?? (j.results || []).length) || 0; ms += Number(e.time) || (Date.now() - t0); got++;
          if (e.name) name = e.name;
          if (!Number(e.count ?? e.resultCount)) why = [e.status, e.httpStatus ? `http ${e.httpStatus}` : "", e.errorReason].filter((x) => x && x !== "ok").join(" ").slice(0, 60) || why;
        } catch { ms += Date.now() - t0; }
      }
      const avgN = got ? Math.round(n / qs.length) : 0, avgMs = Math.round(ms / qs.length);
      rows.push([`Engine: ${name}`, avgN >= 8 && avgMs <= 2500 ? "GOOD" : avgN === 0 ? "NONE" : "WEAK", `${avgN} results, ${avgMs} ms per search${!avgN && why ? `, ${why}` : ""}`]);
    }
  } catch {}
  // Wikipedia's API asked directly from this server, the way the Wikipedia engine asks it (its headers, its URL)
  {
    const t0 = Date.now();
    let note = "";
    let ok = false;
    try {
      const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=pittsburgh%20steelers&format=json&srlimit=15&sroffset=0&utf8=1", { headers: { "User-Agent": "degoog/1.0 (+https://github.com/degoog-org/degoog)", "Api-User-Agent": "degoog/1.0 (+https://github.com/degoog-org/degoog)" }, signal: AbortSignal.timeout(8000) });
      const txt = await r.text();
      let n = -1; try { n = (JSON.parse(txt).query?.search || []).length; } catch {}
      ok = r.status === 200 && n > 0;
      note = `http ${r.status}, ${n >= 0 ? `${n} results` : `not JSON: ${txt.slice(0, 40).replace(/\s+/g, " ")}`}, ${Date.now() - t0} ms`;
    } catch (e) { note = `no answer: ${String(e && e.message || e).slice(0, 50)}`; }
    rows.push(["Wikipedia API from this server", ok ? "PASS" : "INFO", note]);
  }
  // Image AI (ct-vision next to degoog): running on the GPU?, how fast, and what it would fold on a test image search
  {
    const V = "http://ct-vision:8077";
    let h = null;
    try { h = await (await fetch(`${V}/health`, { signal: AbortSignal.timeout(5000) })).json(); } catch {}
    if (!h) rows.push(["Image AI (ct-vision)", "INFO", "not answering yet: the first build downloads PyTorch + the model (a few GB, ~10 min) in the background"]);
    else {
      rows.push(["Image AI (ct-vision)", h.device === "cuda" ? "PASS" : "INFO", (h.device === "cuda" ? `GPU: ${h.gpu}` : "running on the CPU (GPU not available to Docker): slower") + (h.load_s != null ? `; models loaded in ${h.load_s} s at start` : "")]);
      try {
        const j = await (await fetch(`http://127.0.0.1:${PORT}/api/search?q=kalimba&type=images`, { signal: AbortSignal.timeout(20000) })).json();
        const res = (j.results || []).filter((x) => x && x.thumbnail).slice(0, 60);
        const orig = (t) => { try { const u = new URL(t, "http://x"); return /\/proxy\/image$/.test(u.pathname) ? u.searchParams.get("url") : u.href; } catch { return ""; } };
        const urls = res.map((x) => orig(x.thumbnail));
        const post = async (path, b) => { const t0 = Date.now(); const r = await (await fetch(V + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(15000) })).json(); return [r, Date.now() - t0]; };
        const [a, cold] = await post("/score", { q: "kalimba", urls, budget: 3 });
        const [, warm] = await post("/score", { q: "kalimba", urls, budget: 3 });
        const [nr, nearMs] = await post("/near", { url: urls[0], urls: urls.slice(1) });
        const ps = (a.p || []).map((p, i) => [p, res[i].title || ""]).filter(([p]) => typeof p === "number").sort((x, y) => x[0] - y[0]);
        const med = ps.length ? ps[Math.floor(ps.length / 2)][0] : 0, low = Math.min(0.02, med * 0.05);
        const folded = ps.filter(([p]) => p < low);
        rows.push(["Image AI speed (60 pictures)", cold <= 2500 && warm <= 300 ? "PASS" : "INFO", `first ${cold} ms (fetch + AI), again ${warm} ms, alike ${nearMs} ms; ${ps.length}/${urls.length} pictures read`]);
        rows.push(["Image AI on 'kalimba'", folded.length <= ps.length / 3 ? "PASS" : "INFO", `median ${med.toFixed(4)}, folds ${folded.length}: ${folded.slice(0, 4).map(([p, t]) => `${p.toFixed(5)} ${t.slice(0, 32)}`).join(" | ") || "none"}; top ${ps.slice(-2).map(([p, t]) => `${p.toFixed(3)} ${t.slice(0, 24)}`).join(" | ")}`]);
        if (!Array.isArray(nr.sim)) rows.push(["Image AI alike", "FAIL", "no answer"]);
      } catch (e) { rows.push(["Image AI test search", "INFO", `could not run: ${String(e && e.message || e).slice(0, 60)}`]); }
    }
  }
  // Answer AI in degoog's search step (results hook): every result scored, best sentence for the featured snippet
  try {
    const t0 = Date.now();
    const j = await (await fetch(`http://127.0.0.1:${PORT}/api/search?q=${encodeURIComponent("how tall is the eiffel tower")}`, { signal: AbortSignal.timeout(20000) })).json();
    const ms = Date.now() - t0, rs = j.results || [];
    const scored = rs.filter((r) => typeof r.ctRel === "number"), best = rs.map((r) => r.ctBest).filter(Boolean).sort((a, b) => b.p - a.p)[0];
    if (!j.ctAi) rows.push(["Answer AI in search", "INFO", "not active yet (AI still starting, or degoog's search code changed and the hook isn't in)"]);
    else rows.push(["Answer AI in search", "PASS", `${scored.length}/${rs.length} results scored, search ${ms} ms; low ${scored.filter((r) => r.ctRel < 0.02).length}; snippet ${best ? `${best.p.toFixed(2)} "${best.s.slice(0, 60)}"` : "none"}`]);
  } catch (e) { rows.push(["Answer AI in search", "INFO", `could not run: ${String(e && e.message || e).slice(0, 60)}`]); }
  // How degoog has been opening on each device (timings the page sent, last 60 loads): median and the slowest load,
  // split into where the time went
  try {
    const list = JSON.parse(fs.readFileSync(`${DIR}/perf.json`, "utf8"));
    const med = (a) => { const b = a.filter((x) => x >= 0).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : -1; };
    for (const dev of ["phone", "pc"]) {
      const L = list.filter((x) => x.dev === dev && x.nav);
      if (!L.length) continue;
      const worst = L.reduce((a, b) => ((b.nav.loaded || 0) > (a.nav.loaded || 0) ? b : a));
      const part = (x) => x ? `wait ${x.wait}, dns ${x.dns}, connect ${x.connect}, tls ${x.tls}, server ${x.server}, download ${x.download}` : "none";
      rows.push([`Page opens (${dev}, ${L.length})`, "INFO", `median ready ${med(L.map((x) => x.nav.ready))} ms, first search ${med(L.map((x) => x.search ? x.search.wait + x.search.total : -1))} ms after open`]);
      rows.push([`  slowest (${dev})`, "INFO", `ready ${worst.nav.ready} ms (${part(worst.nav)}); search: ${part(worst.search)}`]);
    }
  } catch {}
  // Safe Search off on every engine that has it (set by the installer just before the restart)
  let safe = [];
  try {
    const st = JSON.parse(fs.readFileSync(process.env.DEGOOG_PLUGIN_SETTINGS_FILE || "/app/data/plugin-settings.json", "utf8"));
    safe = Object.entries(st).filter(([k, v]) => /-engine$/.test(k) && v && typeof v.safeSearch === "string" && v.safeSearch !== "off").map(([k]) => k.replace(/^degoog-org-official-extensions-/, "").replace(/-engine$/, ""));
  } catch {}
  row("Safe Search off on all engines", safe.length === 0, safe.length ? `still on: ${safe.join(", ")}` : "");

  // AI-image list for the Images tab: first download ~60 s after start
  let n = 0;
  for (let i = 0; i < 12 && !n; i++) { try { n = (JSON.parse(fs.readFileSync(`${DIR}/ai-images.json`, "utf8")).list || []).length; } catch {} if (!n) await sleep(5000); }
  row("AI-image blocklist (Images tab)", n >= 300, n ? `${n} sites` : "");
  // DOI publisher names (Crossref prefix list) and trending names (Wikipedia's most-read articles; first refresh ~2 min after start)
  try { const r = await fetch("https://api.crossref.org/prefixes/10.1016", { headers: { Accept: "application/json", "User-Agent": "degoog-clean-titles/51 (+https://github.com/degoog-org/degoog)" }, signal: AbortSignal.timeout(8000) }); const j = await r.json(); row("DOI publisher names (Crossref)", /elsevier/i.test(String(j.message && j.message.name)), String(j.message && j.message.name || r.status)); } catch (e) { row("DOI publisher names (Crossref)", false, String(e.message || e).slice(0, 60)); }
  let tn = 0;
  for (let i = 0; i < 30 && !tn; i++) { try { tn = (JSON.parse(fs.readFileSync(`${DIR}/trend.json`, "utf8")).w || []).length; } catch {} if (!tn) await sleep(5000); }
  row("Trending names (Wikipedia)", tn >= 100, tn ? `${tn} words` : "no trend.json after 150 s");

  const w = Math.max(...rows.map((r) => r[0].length));
  console.log("");
  for (const [name, st, note] of rows) console.log(`${name.padEnd(w)}  ${st.padEnd(4)}${note ? `  ${note}` : ""}`);
  const bad = rows.filter((r) => r[1] === "FAIL").length;
  console.log(`\n${bad ? `${bad} FAIL` : "All PASS"} (clean-titles self-check)`);
})();

'@)
docker cp "$env:TEMP\ct-check.js" "${c}:/tmp/ct-check.js"; docker exec $c bun /tmp/ct-check.js; docker exec $c rm -f /tmp/ct-check.js; Remove-Item -Force "$env:TEMP\ct-check.js"
$ctT['check'] = $ctSw.Elapsed.TotalSeconds; $p0 = 0
"install timing (s): " + (($ctT.Keys | ForEach-Object { $v = $ctT[$_]; "$_ {0:N1}" -f ($v - $p0); $p0 = $v }) -join ", ") + ", total {0:N1}" -f $ctSw.Elapsed.TotalSeconds
} | Tee-Object -Variable o; $o | Out-String | Set-Clipboard
