// ----- page/02-list.js: list pass (Web): dedupe, site prefs, folds; tab/relevance passes; HD images; row() cleans one result -----
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
  const fresh = [...list.children].filter((el) => el.classList.contains("result-item") && !tabPlanned.has(el));
  if (!fresh.length) return;
  const key = searchId();
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
  const key = searchId();
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
  const key = searchId();
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
