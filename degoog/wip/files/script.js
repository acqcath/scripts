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
  const w = Math.round(bar.getBoundingClientRect().right - tabs.getBoundingClientRect().left + (parseFloat(getComputedStyle(tabs).paddingRight) || 0));
  if (w > 200) tabs.style.setProperty("--ct-tabs-w", `${w}px`);
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
// Dictionary pages only when the search is about a word (Bing adds them for words like "under" or "fix")
const DICT = /(^|\.)(merriam-webster\.com|thefreedictionary\.com|dictionary\.cambridge\.org|dictionary\.com|collinsdictionary\.com|oxfordlearnersdictionaries\.com|vocabulary\.com|wordreference\.com|yourdictionary\.com|wiktionary\.org|urbandictionary\.com)$/i;
const readQuery = () => {
  if (location.href === href) return;
  href = location.href;
  try { qIdent = CT.relIdent(new URL(href).searchParams.get("q") || ""); } catch { qIdent = false; }
  try { webTab = !new URL(href).searchParams.get("type"); } catch { webTab = true; }
  try { qWords = CT.relWords(new URL(href).searchParams.get("q") || ""); } catch { qWords = []; }
  try {
    const q = (new URL(href).searchParams.get("q") || "").trim();
    wantsDict = q.split(/\s+/).length <= 2 || /\b(define|definition|meaning|means?|synonyms?|antonyms?|pronounc\w*|spell\w*|dictionary|word|etymology|slang)\b/i.test(q);
  } catch { wantsDict = true; }
};
// Results the page never shows: dictionary pages for non-word searches (Bing adds them for words like "under")
const junk = (el) => {
  const a = el.querySelector("a.result-title");
  if (!a) return false;
  let h = "";
  try { h = new URL(a.href).hostname; } catch {}
  return !wantsDict && DICT.test(h.replace(/^www\./, ""));
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
let RP = { key: "", n: 0, rel: [] };
const relPass = () => {
  const list = document.getElementById("results-list");
  if (!list) return;
  const fresh = [...list.children].filter((el) => el.classList.contains("result-item") && !relPlanned.has(el));
  if (!fresh.length) return;
  const key = searchId(location.href);
  if (RP.key !== key) RP = { key, n: 0, rel: [] };
  // Words of the corrected search too, when degoog searched a typo fix ("Showing results for …")
  const words = [...new Set([...qWords, ...CT.relWords(document.querySelector("#ct-fix a")?.textContent || "")])];
  let q0 = "";
  try { q0 = new URL(location.href).searchParams.get("q") || ""; } catch {}
  if (!CT.relJudgeable(q0)) { fresh.forEach((el) => relPlanned.add(el)); return; }
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
    const ok = ai ? ai.p >= AI_LOW || pos === 0 : CT.related(words, qIdent, `${el.dataset.resultUrl || a.href} ${r.title} ${r.snippet}`, el.querySelectorAll(".result-engine-tag").length, pos);
    if (anchor || ok) RP.rel.push(r);
    else out.push([el, r]);
  }
  // Second look: results that use other words for the same topic as the related ones stay (core topicOf)
  if (out.length) { const same = CT.topicOf(RP.rel, words); out = out.filter(([, r]) => r.ai || !same(r)); }
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
    if (!els.length || !f.after.isConnected || f.after.classList.contains("ct-grouped") || f.after.dataset.ctUnrel) continue;
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
    if (SHOW.img !== false && !shaped(q) && (CT.visualQ(q) || visualSeen.has(qHash(q)))) {
      const e = { key, data: undefined };
      early.set("img", e);
      fetch(`/api/search?q=${encodeURIComponent(q)}&type=images`).then((x) => (x.ok ? x.json() : null))
        .then((j) => {
          e.data = j && Array.isArray(j.results) ? j : null;
          // Image AI scores the row's pictures now, in parallel with the web results
          if (e.data && VISON) { visKey(); visAsk(q, [...new Set(e.data.results.slice(0, 40).map((x) => origOf(x.thumbnail || "")).filter(Boolean))]).then(visRow); }
        }, () => { e.data = null; });
    }
    // Top stories: the News search starts now, in parallel, only for a search that looked like news last time
    if (SHOW.news && !shaped(q) && newsy.has(qHash(q))) {
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
      for (const r of document.querySelectorAll("#results-list .result-item :is(.result-title, .result-snippet)")) for (const w of r.textContent.match(/[\p{L}\p{N}][\p{L}\p{N}'+.#-]*/gu) || []) if (/\p{Lu}/u.test(w.slice(1))) add(cased, w.toLowerCase(), w);
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
        return i === 0 ? best[0].toUpperCase() + best.slice(1) : best;
      });
      // Answers are fetched as the box comes near the screen, so a tap shows one at once; a question no page answers
      // is taken out before you get to it (no "Search for" stand-ins); fewer than 2 left: no box
      const ans = new Map();
      // The answer: of the question's top 8 results, the passage the answer AI (a reranker on the PC's GPU) says answers it
      // best; too weak an answer = no answer. Without the AI: the first result with a description.
      const get = (text) => ans.get(text) || ans.set(text, fetch(`/api/search?q=${encodeURIComponent(text)}`).then((r) => (r.ok ? r.json() : null))
        .then(async (sj) => {
          const c = (sj && Array.isArray(sj.results) ? sj.results : []).filter((x) => x && x.url && x.snippet).slice(0, 8);
          if (!c.length) return null;
          const strip = (t) => String(t || "").replace(/<[^>]+>/g, "").trim();
          const j = await bridge("rank", {}, JSON.stringify({ q: text, d: c.map((x) => `${strip(x.title)}. ${strip(x.snippet)}`) })).catch(() => null);
          if (!j || !Array.isArray(j.s)) return c[0];
          let bi = -1;
          j.s.forEach((v, i) => { if (typeof v === "number" && (bi < 0 || v > j.s[bi])) bi = i; });
          return bi >= 0 && j.s[bi] >= 0.02 ? c[bi] : null; // the best of them unless none is about the question at all
        }).catch(() => null)).get(text);
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
          get(text).then((top) => {
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
        for (const [d, text] of items) get(text).then((top) => { if (!top && !d.open) drop(d); });
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
let SHOW = { sl: true, forum: true, video: true, news: true, ans: true, kp: true, img: true, qv: true, arch: true, mean: true, stars: true, plain: true, pw: true };
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
    G = { key, sl: null, slTop: null, forum: null, video: null, news: false, img: false };
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
    const c = rows.filter((r) => r !== top && test(r) && !used(r.el) && !r.el.dataset.ctUnrel);
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
  if (shaped()) return; // a plain list of the type asked for: no boxes or rows
  if (SHOW.forum) box("forum", (r) => !!r.forum, 4, forumRow, "Discussions and forums", "forums", "More discussions", false);
  if (SHOW.video) box("video", (r) => r.video, 8, videoCard, "Videos", "videos", "More videos", true);

  // Images row: drawn after the first result in this same pass, only if the image search is already in hand
  if (!G.img) {
    G.img = true;
    const j = ready("img", key);
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
      t.after(s);
      wrap.upd();
    }
  }
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
  if (!AI_WORDS.test(q) || TYPE_WORDS.test(q) || shaped(q) || /\bbest buy\b/i.test(q)) return false;
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
    // Featured snippet (fact / how-to wording): a whole sentence from one of the first results now on the page,
    // drawn in this same pass. Not on page 2+, plain-list searches, or when an answer above came first.
    let pg = 1;
    try { pg = Number(new URL(key).searchParams.get("page") || 1); } catch {}
    if (globalThis.CT_NOSNIP !== true && !ansVal && SHOW.ans !== false && webTab && !TYPE_WORDS.test(q) && !shaped(q) && pg <= 1) {
      const rs = [...document.querySelectorAll("#results-list .result-item")].filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped")).slice(0, 6).map(info).filter(Boolean);
      const f = CT.featuredSnippetAI(q, rs) || (rs.some((r) => r.best) ? null : CT.featuredSnippet(q, rs));
      if (f) ansVal = { ...f, label: `From ${f.h}` };
    }
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
  if (!webTab || !CT.kpQuery(q) || shaped(q) || bangFor(q) || TYPE_WORDS.test(q) || CT.answer(q, Date.now(), { fx: FX }) || aiWanted(q) || AI_WORDS.test(q)) return false;
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
  if (late && !wide) return; // on top of the list, after the results are on screen: would push them down
  const rows = [...list.querySelectorAll(".result-item")];
  if (!rows.length) return;
  const m = CT.kpMatch(kp.title, rows.map((r) => r.querySelector("a.result-title")?.href || ""));
  if (!m.ok) return;
  if (!late) for (const i of m.wiki) rows[i].dataset.ctKp = "1"; // the panel replaces that result (before paint only)
  const card = kpCard(kp, wide);
  list.prepend(card);
  card.querySelectorAll(".ct-fit").forEach(fitLine);
  if (fitRO) fitRO.observe(card);
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
  safe("extras", extras); safe("groups", groups); safe("folds", foldPass); safe("ask", paa); safe("tools", tools);
  safe("kp", kpPass); safe("only", onlyPass); safe("mean", meanPass); safe("stars", starsPass);
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
    safe("extras", extras); safe("groups", groups); safe("folds", foldPass); safe("ask", paa); safe("tools", tools); safe("card", glance);
    safe("kp", kpPass); safe("only", onlyPass); safe("mean", meanPass); safe("stars", starsPass); safe("preview", previewPass);
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
