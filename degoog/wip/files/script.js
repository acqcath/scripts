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