// clean-titles core: pure functions (no DOM), shared by the page script and the tests.
// Everything here runs synchronously before first paint, so it only uses data already in the page.

// ===== Sites: registrable domain via the public suffix list =====
// The list arrives compiled as a tree string (reversed labels): "uk(co,org,...),jp(ac,...)", "!" = also a rule itself
export const pslParse = (enc) => {
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
export const regDomain = (host, psl) => {
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
export const shortTarget = (host) => SHORT[host] || "";
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
export const arxivId = (h, path) => {
  if (!/(^|\.)(arxiv\.org|ar5iv\.org|ar5iv\.labs\.arxiv\.org|alphaxiv\.org)$/.test(h)) return null;
  const m = /^\/(?:abs|pdf|html|papers?|overview)\/((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)?(?:\.pdf)?\/?$/i.exec(path);
  return m ? { id: m[1].toLowerCase(), v: m[2] ? Number(m[2].slice(1)) : 0, kind: /^\/pdf\//.test(path) ? "PDF" : /^\/html\//.test(path) || /ar5iv/.test(h) ? "HTML" : "abs" } : null;
};
// Pagination and comment pages that belong to the same article
// (a bare "/2" counts only after a word-like segment: "/my-article/2", never "/2" or "/2024/11")
const PAGE_TAIL = /\/(?:page|comment-page|p)-?\d+\/?$|\/(?:page|comments?|amp|all|print)\/?\d*\/?$|(?<=\/[a-z][^/]*[a-z][^/]*)\/\d{1,2}\/?$/i;
const DROP_PARAMS = /^(page|p|pg|start|comments?|cpage|amp|output|view|print|lang|hl|locale|ref|src|from|utm_\w+|fbclid|gclid|share|s|sh|via)$/i;
export const docKey = (raw) => {
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
export const titleKey = (t) => String(t || "").toLowerCase()
  .replace(/\s*[|–—·:-]\s*(?:page|part)\s*\d+(?:\s*of\s*\d+)?\s*$/, "").replace(/\((?:page|part)\s*\d+\)/g, "")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Merge results: same document key, then same title within the same site. Input: [{url, title, ...}] in rank
// order. Output: kept items (first = best ranked), each with .alts = [{url, label}] for its other versions.
// Incremental form (endless scroll adds pages to the same search): add(item) -> {rec} for a new document,
// {dup: rec} for another copy of one already kept
export const deduper = (psl) => {
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
export const dedupe = (items, psl) => {
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
export const namedSites = (q, psl) => {
  const s = new Set();
  const m = /(?:^|\s)site:(\S+)/i.exec(q);
  if (m) s.add(regDomain(m[1].replace(/^https?:\/\//, "").replace(/\/.*$/, ""), psl));
  return { set: s, words: new Set(String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3)) };
};
// Search words that name a site without being its domain's first label (seen in the recorded searches
// "mdn array map", "npm lodash", "pip requests")
const SITE_WORD = { mdn: "mozilla.org", npm: "npmjs.com", pip: "pypi.org", pypi: "pypi.org" };
const siteNamed = (site, named) => named.set.has(site) || named.words.has(site.split(".")[0]) || [...named.words].some((w) => SITE_WORD[w] === site);
export const capSites = (items, q, psl, cap = 2) => {
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
export const listCtx = (q, psl, prefs = {}) => ({ add: deduper(psl), named: namedSites(q, psl), count: new Map(), prefs, cap: 2, docs: docsFor(q), docsDone: false, nav: navName(q), navDone: false });
// ===== Site searches ("asura scans", "asurascaxs") =====
// A search of 1-3 words whose letters, joined, are a site's name (its domain's first label), allowing 1-2 typos
// for longer names. The site with that name that has the most results on the page is the one meant: its top result
// goes first with the rest of it folded under it, and other sites with nearly the same name (copies, mirrors:
// asurascanz.com, asurascans.my) are folded under it too as "look-alike sites".
export const navName = (q) => {
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
export const navDist = (name, site) => {
  const l = String(site || "").toLowerCase().split(".")[0].replace(/-/g, "");
  if (!name || !l) return 9;
  if (l === name) return 0;
  return name.length >= 6 ? lev(name, l) : 9;
};

// ===== Same-shape results (spec 8) =====
// A search that names a type of result gets a plain list of that type: no boxes, rows, panels or AI on top.
const SHAPE_WORDS = [["pdf", /\b(?:pdf|pdfs)\b/], ["paper", /\b(?:paper|papers|arxiv|preprint)\b/], ["forum", /\b(?:reddit|forum|forums|thread|stackoverflow|stack overflow)\b/], ["docs", /\b(?:docs|documentation|api reference|reference manual)\b/], ["recipe", /\b(?:recipe|recipes)\b/], ["code", /\b(?:github|gitlab|repo|repository)\b/], ["lab", /\blab\b/], ["lecture", /\b(?:lecture|lectures|lecture notes)\b/], ["slides", /\b(?:slides|slide deck|ppt|pptx)\b/], ["video", /\b(?:video|videos|youtube)\b/]];
export const shapeOf = (q) => { const s = String(q || "").toLowerCase(); const t = SHAPE_WORDS.find(([, re]) => re.test(s)); return t ? t[0] : ""; };
// A site named to filter by ("… reddit", "mdn …"): only well-known destination words, and only with other words
// beside it (a search that is just "reddit" or "steelers" is a navigation, not a filter). Returns the domain or "".
const FILTER_SITE = { reddit: "reddit.com", stackoverflow: "stackoverflow.com", github: "github.com", youtube: "youtube.com", wikipedia: "wikipedia.org", wiki: "wikipedia.org", quora: "quora.com", mdn: "mozilla.org", npm: "npmjs.com", pypi: "pypi.org", imdb: "imdb.com", amazon: "amazon.com", ebay: "ebay.com", etsy: "etsy.com", twitter: "x.com", hackernews: "ycombinator.com", arxiv: "arxiv.org", goodreads: "goodreads.com", letterboxd: "letterboxd.com", yelp: "yelp.com", tripadvisor: "tripadvisor.com" };
export const filterSite = (q) => {
  const s = String(q || "").toLowerCase();
  if (/(?:^|\s)site:/.test(s)) return "";
  const words = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length < 2) return "";
  const w = words.find((x) => FILTER_SITE[x]);
  return w ? FILTER_SITE[w] : "";
};
// "Only reddit.com results ›" line: the named site has fewer than 3 of the first 10 results
export const onlyLine = (q, sites) => { const d = filterSite(q); return d && sites.slice(0, 10).filter((x) => x === d).length < 3 ? d : ""; };
// The site: search the line runs when tapped: the named word is replaced by the operator
export const onlyQuery = (q, d) => { const w = Object.keys(FILTER_SITE).find((k) => FILTER_SITE[k] === d && new RegExp(`\\b${k}\\b`, "i").test(q)); return `${String(q).replace(w ? new RegExp(`\\s*\\b${w}\\b\\s*`, "i") : /$^/, " ").trim()} site:${d}`; };
// Programming searches: the official docs result goes first. Keys are words of the search, values host suffixes.
const DOCS = { react: ["react.dev"], reactjs: ["react.dev"], javascript: ["developer.mozilla.org"], js: ["developer.mozilla.org"], css: ["developer.mozilla.org"], html: ["developer.mozilla.org"], dom: ["developer.mozilla.org"], python: ["docs.python.org"], typescript: ["typescriptlang.org"], ts: ["typescriptlang.org"], rust: ["doc.rust-lang.org", "docs.rs"], golang: ["go.dev", "pkg.go.dev"], nodejs: ["nodejs.org"], node: ["nodejs.org"], kotlin: ["kotlinlang.org"], django: ["docs.djangoproject.com"], flask: ["flask.palletsprojects.com"], vue: ["vuejs.org"], vuejs: ["vuejs.org"], angular: ["angular.dev"], svelte: ["svelte.dev"], nextjs: ["nextjs.org"], tailwind: ["tailwindcss.com"], numpy: ["numpy.org"], pandas: ["pandas.pydata.org"], git: ["git-scm.com"], docker: ["docs.docker.com"], kubernetes: ["kubernetes.io"], postgres: ["postgresql.org"], postgresql: ["postgresql.org"], sqlite: ["sqlite.org"], php: ["php.net"], csharp: ["learn.microsoft.com"], dotnet: ["learn.microsoft.com"], powershell: ["learn.microsoft.com"], bun: ["bun.sh", "bun.com"], deno: ["docs.deno.com"] };
// Only searches that also look like code (a known API-ish word or camelCase), so "python snake" or "rust removal" don't
const CODEY = /\p{Ll}\p{Lu}|\b(?:function|method|class|array|map|filter|reduce|string|list|dict|object|async|await|promise|hook|hooks|use\w+|component|props|state|import|export|module|install|syntax|error|exception|loop|for loop|while|lambda|regex|json|api|query|selector|flexbox|grid|type|types|interface|enum|struct|trait|macro|decorator|generator|iterator|cleanup|effect|ref|context|router|config|cli|command|tutorial|docs?|example)\b/u;
export const docsFor = (q) => {
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
export const planPage = (items, ctx) => {
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

// ===== Sites: Prefer / Normal / Lower / Hide, stored in degoog's own lists =====
// Hide = a line in domainBlockList; Prefer / Lower = "domain|N" in domainScoreList (N added to each result's score
// on the server, where a top result scores about 60). So degoog applies them itself on every tab, before render.
export const SITE_SCORE = { prefer: 40, lower: -40, normal: 0 };
const plainHost = (l) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l);
// The lists' text -> {domain: "hide" | "prefer" | "lower"} (regex and uBlock lines are degoog's business; Hide wins)
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
// Block list without this site's own line (other lines, comments and patterns untouched)
export const unblockText = (block, domain) => {
  const d = String(domain).toLowerCase();
  return String(block || "").split("\n").filter((l) => { const t = l.trim().toLowerCase(); return t !== d && t !== `www.${d}`; }).join("\n");
};

// ===== Anti-SEO: signs on one search's web results (the server adds them up per site) =====
// Essay-writing services (contract cheating). From well-known names, not a fetched list.
export const CHEAT_SITES = new Set(["ukessays.com", "essaypro.com", "edubirdie.com", "papersowl.com", "studybay.com", "99papers.com", "grademiners.com", "essayshark.com", "writemypaper4me.org", "myassignmenthelp.com", "paperhelp.org", "speedypaper.com", "essaywriter.org", "ivoryresearch.com", "assignmentexpert.com"]);
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
export const seoSigns = (items, psl, now = Date.now()) => {
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
export const SEO_MIN = 5;
export const seoVerdict = (t) => !!t && t.seen >= SEO_MIN && t.hits * 2 > t.seen;

// ===== Paywall tag =====
// Sites where most articles need a subscription (hard or tight metered paywalls). Hand-kept, well-known names only;
// a "Paywall" word on the source line, nothing hidden or moved.
export const PAYWALL_SITES = new Set(["nytimes.com", "wsj.com", "ft.com", "economist.com", "bloomberg.com", "washingtonpost.com", "theatlantic.com", "newyorker.com", "wired.com", "thetimes.co.uk", "thetimes.com", "telegraph.co.uk", "barrons.com", "hbr.org", "theinformation.com", "latimes.com", "bostonglobe.com", "businessinsider.com", "foreignaffairs.com", "foreignpolicy.com", "nymag.com", "vanityfair.com", "technologyreview.com", "scientificamerican.com", "newscientist.com", "chicagotribune.com", "sfchronicle.com", "seekingalpha.com", "theathletic.com", "thestar.com", "theglobeandmail.com", "afr.com", "spectator.co.uk", "marketwatch.com", "lemonde.fr", "spiegel.de", "nzz.ch", "haaretz.com"]);
// The Athletic lives under nytimes.com/athletic/ but nytimes.com itself is listed anyway
export const paywalled = (host, psl) => PAYWALL_SITES.has(regDomain(String(host || "").toLowerCase(), psl));

// ===== Snippet cleanup =====
const MON = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
const DATE_RE = new RegExp(`^\\s*(${MON} \\d{1,2},? \\d{4}|\\d{1,2} ${MON},? \\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4}|\\d+ (?:sec|second|min|minute|hour|hr|day|week|month|year)s? ago|yesterday|today)\\s*(?:\\.\\.\\.|…|—|–|-|·|:)\\s*`, "i");
// Returns {date, text}: leading date moved out, junk ellipses removed, whitespace tidied
export const cleanSnippet = (s) => {
  let t = String(s || "").replace(/\s+/g, " ").trim();
  let date = "";
  const m = DATE_RE.exec(t);
  if (m && t.length > m[0].length + 8) { date = m[1]; t = t.slice(m[0].length); }
  t = t.replace(/^(?:\.\.\.|…)\s*/, "").replace(/\s*(?:\.\.\.|…)\s*(?:\.\.\.|…)+/g, " … ").replace(/\s+(?:\.\.\.|…)$/, "…").replace(/\.\.\./g, "…").trim();
  return { date, text: t };
};
// doi.org links say nothing about where a paper is: the DOI's registrant prefix names the publisher
const DOI_PUB = { "10.1016": "Elsevier", "10.1007": "Springer", "10.1038": "Nature", "10.1126": "Science", "10.1002": "Wiley", "10.1111": "Wiley", "10.1080": "Taylor & Francis", "10.1177": "SAGE", "10.1093": "Oxford Academic", "10.1017": "Cambridge", "10.1371": "PLOS", "10.3390": "MDPI", "10.3389": "Frontiers", "10.1186": "BMC", "10.1136": "BMJ", "10.1056": "NEJM", "10.1001": "JAMA", "10.1073": "PNAS", "10.1021": "ACS", "10.1039": "RSC", "10.1103": "APS", "10.1088": "IOP", "10.1109": "IEEE", "10.1145": "ACM", "10.1101": "bioRxiv / medRxiv", "10.48550": "arXiv", "10.2139": "SSRN", "10.7554": "eLife", "10.1146": "Annual Reviews", "10.1037": "APA", "10.1097": "Wolters Kluwer", "10.1515": "De Gruyter", "10.1163": "Brill", "10.4324": "Routledge", "10.1057": "Palgrave", "10.1108": "Emerald", "10.2307": "JSTOR", "10.1353": "Project MUSE", "10.1155": "Hindawi", "10.1159": "Karger", "10.1055": "Thieme", "10.1128": "ASM", "10.1182": "ASH", "10.1161": "AHA", "10.1172": "JCI", "10.1083": "Rockefeller UP", "10.1242": "Company of Biologists", "10.1098": "Royal Society", "10.1063": "AIP", "10.1209": "EPL", "10.5281": "Zenodo", "10.6084": "figshare", "10.31234": "PsyArXiv", "10.31219": "OSF Preprints" };
export const doiPublisher = (url) => { try { const u = new URL(url); if (!/^(?:dx\.)?doi\.org$/.test(u.hostname.replace(/^www\./, ""))) return ""; const m = /^\/(10\.\d{4,9})\//.exec(decodeURIComponent(u.pathname)); return (m && DOI_PUB[m[1]]) || ""; } catch { return ""; } };
// Stray spaces the engines leave where they bolded the search words: "slang ?" "( crazy )" " shit " "Schrödinger 's".
// Spaces go before , . ; : ! ? ) ] % and 's / n't, after ( [, and inside a quote pair ("…" “…” ‘…’). Straight
// double quotes are fixed only when they pair up (even count), so a stray inch mark is never touched.
// One clean-up for every title and description, so no result looks broken next to the others: entities the engine
// left encoded (&amp;), stray spaces around punctuation (below), runs of the same mark ("!!!!", ">>>>>>", five of
// the same emoji) shortened to one, "..." as one ellipsis. Works on one text piece at a time (a description keeps its
// bold words), so it never trims ends; tidyTitle also drops separators left dangling at a title's ends.
export const tidyText = (s0) => {
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
export const dateLabel = (raw, now = Date.now()) => {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/ago$|^(?:today|yesterday)$/i.test(s)) return s.toLowerCase();
  return relDate(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s, now) || s;
};
// "yesterday", "3 days ago" within about a week; otherwise the exact date. now injectable for tests
export const relDate = (d, now = Date.now()) => {
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
export const upsValid = (s) => {
  const m = /^1Z([0-9A-Z]{15})(\d)$/.exec(String(s).toUpperCase().replace(/\s/g, ""));
  if (!m) return false;
  let sum = 0;
  [...m[1]].forEach((c, i) => { const v = /\d/.test(c) ? +c : (c.charCodeAt(0) - 63) % 10; sum += i % 2 ? v * 2 : v; });
  return (10 - (sum % 10)) % 10 === +m[2];
};
export const isbnValid = (s) => {
  const x = String(s).toUpperCase().replace(/[\s-]/g, "");
  if (/^\d{9}[\dX]$/.test(x)) { let t = 0; for (let i = 0; i < 10; i++) t += (x[i] === "X" ? 10 : +x[i]) * (10 - i); return t % 11 === 0; }
  if (/^97[89]\d{10}$/.test(x)) { let t = 0; for (let i = 0; i < 13; i++) t += +x[i] * (i % 2 ? 3 : 1); return t % 10 === 0; }
  return false;
};
// CMU course numbers: "15-213" always looks like a course; bare "15213" only when that course exists
export const cmuCourse = (q, courses) => {
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
export const tabLow = (tab, host, title, seen) => {
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
export const relWords = (q) => {
  const t = relToks(q), joined = [];
  for (let i = 0; i + 1 < t.length; i++) if (/^\p{L}+$/u.test(t[i]) && /^\d+$/.test(t[i + 1]) && t[i].length <= 6) joined.push(t[i] + t[i + 1]);
  return [...new Set([...t.filter((w) => (/\p{L}/u.test(w) ? w.length >= 3 && !REL_STOP.has(w) : w.length >= 4)), ...joined])];
};
export const relIdent = (q) => { const t = relToks(q); return t.length > 0 && t.every((w) => /\d/.test(w)); };
const relHit = (w, t) => t === w || (w.length >= 4 && t.length >= 4 && (t.startsWith(w) || w.startsWith(t)));
export const matchShare = (words, text) => {
  if (!words.length) return 1;
  const toks = [...new Set(relToks(text))];
  return words.filter((w) => toks.some((t) => relHit(w, t))).length / words.length;
};
// A search made mostly of common words (a quote, "who are you who do you work for") can't be judged by its words: no check
export const relJudgeable = (q) => { const t = relToks(q); return t.length > 0 && relWords(q).length * 2 >= t.length; };
// Core words: the search's words that 40%+ of the first results share (at least 3 of them). Empty = no core (every
// result is judged as before). Words found in nearly every result but too common to say anything still qualify:
// they are then simply shared by the related results too.
export const relCore = (words, texts) => {
  const n = (texts || []).length;
  if (n < 5 || !words.length) return [];
  const toks = texts.map((x) => [...new Set(relToks(x))]);
  const need = Math.max(3, Math.ceil(n * 0.4));
  return words.filter((w) => toks.filter((ts) => ts.some((t) => relHit(w, t))).length >= need);
};
export const related = (words, ident, text, engines, pos) => matchShare(words, text) > 0 || engines >= 2 || (ident && pos < 3);
// Second look before a result is folded: words the related results share (in 15%+ of them, at least 3; one also in
// 2+ of their titles) are the topic of this search ("tracking", "package" for a UPS number; "attention", "encoder"
// for an arXiv id; "football", "pittsburgh" for steelers on Science). A result with 2+ of them stays: it uses other
// words for the same thing. Built from this page's own results each time: nothing stored, nothing to maintain.
const TOPIC_STOP = new Set("that this your with from have more about what when where which their there they them will been were into also just like only some than then these those other such most many much number word words meaning definition best free online official home page site http https html".split(" "));
const topicToks = (t) => relToks(t).filter((w) => w.length >= 4 && /\p{L}/u.test(w) && !TOPIC_STOP.has(w));
export const topicOf = (rel, words) => {
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
export const tidyTitle = (t) => tidyText(t).replace(/^[\s|·•:,;–—-]+|[\s|·•:,;–—-]+$/g, "");


// ===== ⚑ Report: the text the Claude Code session opens with (Claude's link takes about 14,000 characters: snippets
// are dropped first, then the oldest waiting flags; the flag being reported always stays) =====
export const flagPrompt = (flags, issue, max = 12000) => {
  const head = "degoog clean-titles: fix what my degoog reported. Read degoog/wip/QUICKSTART.md in acqcath/scripts first and follow its \"Flags\" steps: " +
    "commit the flags below to the private repo acqcath/degoog-flags, then fix the code so these searches come out right, release and merge. " +
    "Keep my searches out of the public repo.\n";
  const body = (fl, snip) => JSON.stringify({ flags: fl.map((f) => ({ at: new Date(f.t).toISOString(), q: f.q, tab: f.type, note: f.note, top: (f.top || []).map((r) => (snip ? { title: r.title, url: r.url, snippet: r.snippet } : { title: r.title, url: r.url })) })), updateIssue: issue || null });
  let fl = (flags || []).slice(-20);
  for (;;) {
    for (const snip of [true, false]) { const s = head + body(fl, snip); if (s.length <= max || fl.length <= 1) { if (s.length <= max || !snip) return s.slice(0, max); } }
    if (fl.length <= 1) return (head + body(fl, false)).slice(0, max);
    fl = fl.slice(1);
  }
};
