// ----- page/01-base.js: bridge to the server, search identity, title cleaning helpers -----
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
// One icon per site across the page: the first favicon seen for a host is used for every later result from it
const FAVS = new Map();
const favOf = (h, f) => { if (!f) return FAVS.get(h) || ""; if (!FAVS.has(h)) FAVS.set(h, f); return FAVS.get(h); };
const lineUp = () => {
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
const urlId = (h) => { try { const u = new URL(h); u.hash = ""; u.searchParams.delete("loaded"); return u.toString(); } catch { return String(h).split("#")[0]; } };
// Each time degoog starts drawing a list (a search, a tab, a page; also back/forward, and the same search again) is its
// own search here, even at an address seen before: Web -> News -> Web -> News used to find News's results already
// "seen" from its first visit and hid them all as copies (no results after switching tabs). degoog marks its own
// history entries {degoog: true, query, type, page}: every new entry it pushes is a new search; a rewrite of the
// entry is one only when the query or page changed (endless scroll and a command's settled type keep both; the first
// load's rewrite only records it, so work started for that first search stays its own). Overlays (picture preview)
// push entries without the mark, so they never start a new search.
let SG = 0, SGk = "";
const sgKey = (st) => (st && st.degoog ? `${st.query}\u0001${st.page || 1}` : null);
for (const m of ["pushState", "replaceState"]) {
  const o = history[m];
  if (typeof o !== "function") continue;
  history[m] = function (st, ...rest) {
    const r = o.call(this, st, ...rest), k = sgKey(st);
    // endless scroll's rewrite (it carries loaded: N) is the same search even if it names it differently: a new search
    // there cleared every box, card and fold the page had drawn above the new page (v90)
    if (k !== null) { if (m === "pushState" || (SGk && k !== SGk && !(st.loaded > 0))) SG++; SGk = k; }
    return r;
  };
}
addEventListener("popstate", (e) => { SG++; SGk = sgKey(e.state) || ""; }, true);
const searchId = () => `${urlId(location.href)}|${SG}`;
const sameSearch = (k) => searchId() === k;
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

