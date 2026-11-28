// ----- server/01-base.js: setup: degoog's engines and plugin settings, the page-part check, Sites in Settings -----
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


// ===== Sites: degoog's own block/score lists, read by /sites, Settings and anti-SEO =====
// The lists' text -> {domain: "hide" | "prefer" | "lower"} (regex and uBlock lines are degoog's business; Hide wins)
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

