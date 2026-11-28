// ----- server/03-data.js: outside data for cards: AI-image blocklist, ECB rates, endoflife.date, Wikidata, CMU courses, knowledge panel -----
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

