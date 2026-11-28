// clean-titles v99
const CT_VER = "v99";
const CT = (() => {
// clean-titles core: pure functions (no DOM), shared by the page script and the tests.
// Everything here runs synchronously before first paint, so it only uses data already in the page.

// ===== Sites: registrable domain via the public suffix list =====
// The list arrives compiled as a tree string (reversed labels): "uk(co,org,...),jp(ac,...)", "!" = also a rule itself
const pslParse = (enc) => {
  const root = {}, stack = [];
  let cur = root, last = null, s = 0;
  // Small hand parser: one pass over char codes, names cut with slice (no per-character string building, no regex)
  for (let i = 0, n = enc.length; i <= n; i++) {
    const c = i < n ? enc.charCodeAt(i) : 44; // 44 "," 40 "(" 41 ")" 33 "!"
    if (c !== 44 && c !== 40 && c !== 41) continue;
    if (i > s) {
      const also = enc.charCodeAt(i - 1) === 33, k = enc.slice(s, also ? i - 1 : i);
      const node = cur[k] || (cur[k] = {});
      if (c !== 40 || also) node.$ = 1;
      last = node;
    }
    if (c === 40) { stack.push(cur); cur = last; }
    else if (c === 41) cur = stack.pop();
    s = i + 1;
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


// ===== ⚑ Report: what can be wrong (multi-select chips in the ⚑ box; the note stays optional). The page draws the
// chips from this list; the server keeps only these ids (index.js FLAG_CATS, same list: test/flag.test.js) =====
const FLAG_CATS = [["offtopic", "Off-topic"], ["spam", "Spam / junk"], ["missing", "Missing what I wanted"], ["outdated", "Outdated"],
  ["order", "Wrong order"], ["layout", "Layout looks off"], ["broken", "Something's broken or slow"]];

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

return { pslParse, regDomain, shortTarget, arxivId, docKey, titleKey, deduper, dedupe, namedSites, capSites, listCtx, navName, navDist, shapeOf, filterSite, onlyLine, onlyQuery, docsFor, planPage, copyKey, sameCopy, jaccard, varietyOrder, VARIETY_MARGIN, SITE_SCORE, unblockText, CHEAT_SITES, seoSigns, SEO_MIN, seoVerdict, PAYWALL_SITES, paywalled, cleanSnippet, doiPublisher, tidyText, dateLabel, relDate, upsValid, isbnValid, cmuCourse, tabLow, relWords, relIdent, matchShare, relJudgeable, relCore, related, topicOf, tidyTitle, FLAG_CATS, fmtShares, boxWorth, boxAt, cutMedian, blockGo, blockShare, shapePick, questionStyle, prodShow, fmtNum, calc, convert, percent, dateMath, pattern, currency, eolQuery, eolAnswer, WD_PROP, wdQuery, wdAnswer, cmuAgg, cmuAnswer, sportsAnswer, kpQuery, kpMatch, kpLine, meaningLine, visualQ, deeplUrl, answer, snipQuery, snipSentences, featuredSnippetAI, featuredSnippet, QA_LEAD, qaAbout };
})();
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

// ----- page/02-list.js: list pass (Web): dedupe, site prefs, folds; tab/relevance passes; HD images; row() cleans one result -----
// ===== List pass (Web tab): dedupe -> site prefs -> 2 per site with folds, planned by core.js before paint =====
// Public suffix list: /public/ct/psl.<hash>.js, loaded with defer before this module, sets window.CT_PSL.
// If it failed to load, sites are whole host names (never a guessed suffix).
let PSL0;
const PSL = () => (PSL0 !== undefined ? PSL0 : (PSL0 = typeof window.CT_PSL === "string" && window.CT_PSL ? CT.pslParse(window.CT_PSL) : null));
// Parsed while the page waits for degoog's first results (idle time), not in the first results pass (~5-13 ms there)
(window.requestIdleCallback ? (f) => requestIdleCallback(f, { timeout: 1500 }) : (f) => setTimeout(f, 50))(() => { try { PSL(); } catch {} });
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
// ----- page/03-images.js: image AI, media folds, image preview + related strip, result cards -----
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
const visKey = () => { const key = searchId(); if (VS.key !== key) { VS.key = key; VS.p.clear(); VS.q = []; } };
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
  const key = searchId();
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
  const key = searchId();
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
  picLoad(el);
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
// ----- page/04-early.js: weather/bang glance, early answers fetched before results, typo line + related searches -----
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
const markDrawn = () => { if (document.querySelector("#results-list .result-item, #results-list .image-card, #results-list .video-card")) drawnFor = searchId(); };
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
  const key = searchId();
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
  const key = searchId();
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
  if (extrasFor === searchId()) return;
  const list = document.getElementById("results-list");
  if (!list || !list.querySelector(".result-item, .image-card, .video-card")) return;
  const key = (extrasFor = searchId());
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

// ----- page/05-sites-tools.js: site choices menu, People also ask, Tools (advanced search) -----
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
  if (paaFor === searchId()) {
    // list was redrawn and took the box with it: put it back
    if (paaBox && !paaBox.isConnected) paaAnchor()?.after(paaBox);
    return;
  }
  const list = document.getElementById("results-list");
  if (!list) return;
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none");
  if (rows.length < 4) return;
  const key = (paaFor = searchId());
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
  t.addEventListener("click", () => {
    let f = document.getElementById("ct-adv");
    if (f) { f.remove(); t.setAttribute("aria-expanded", "false"); topGap(); return; }
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
    topGap();
    if (!TOUCH.matches) f.elements.all.focus();
  });
};


// ----- page/06-flag.js: ⚑ Report box -----
// ⚑ at the right end of the tab row (phone and PC): "What's wrong? (optional)" + Save keeps the search, your note and
// its top 10 results on your server. Nothing else shows (no count, no send link): the PC's watcher sends it to the
// Report session as soon as it's saved. Anything about the box itself goes in the same box.
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
  // the 8 passes that took longest on this search (ms, all runs added up) and how many observer runs it took
  const passes = Object.fromEntries([...PASS_MS].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  return { ver: typeof CT_VER === "string" ? CT_VER : "", vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, phone: PHONE.matches, load, boxes, passes, batches: BATCHES };
};
// ===== Layout snapshot: what the screen showed, as text, and anything that looks broken (any device) =====
// No picture (a page can't take one without asking each time, and iPhone can't at all). Instead: every visible
// thing on screen with its place, size and text, and checks that name a problem outright: something sticking out
// past the screen edge, text cut off, things overlapping, pictures that failed, placeholders still showing, recent
// jumps (layout shift), page errors, and the focused box hidden by the keyboard. Taken when ⚑ is tapped (box closed)
// and at Save (box open, keyboard as it is).
const SNAP_ERR = [];
addEventListener("error", (e) => { if (SNAP_ERR.length < 20) SNAP_ERR.push(`error: ${String(e.message || e.error || "").slice(0, 160)} @${String(e.filename || "").split("/").pop()}:${e.lineno || ""}`); });
addEventListener("unhandledrejection", (e) => { if (SNAP_ERR.length < 20) SNAP_ERR.push(`rejection: ${String((e.reason && e.reason.message) || e.reason || "").slice(0, 160)}`); });
const SNAP_SHIFT = [];
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.hadRecentInput || e.value < 0.001) continue; SNAP_SHIFT.push({ t: e.startTime, v: e.value, src: (e.sources || []).slice(0, 3).map((x) => `${snapName(x.node)} y${Math.round(x.previousRect.y)}->${Math.round(x.currentRect.y)} h${Math.round(x.previousRect.height)}->${Math.round(x.currentRect.height)}`) }); if (SNAP_SHIFT.length > 30) SNAP_SHIFT.shift(); } }).observe({ type: "layout-shift", buffered: true }); } catch {}
const snapName = (n) => {
  if (!n || n.nodeType !== 1) return n && n.parentElement ? snapName(n.parentElement) : "?";
  const c = typeof n.className === "string" ? n.className.trim().split(/\s+/).filter((x) => x && !/^(degoog|ct-in$)/.test(x)).slice(0, 2).join(".") : "";
  return `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${c ? "." + c : ""}`;
};
const snapTake = (state) => {
  const out = [], bugs = [], W = innerWidth, H = innerHeight, vv = window.visualViewport;
  const R = (r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  const own = (e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join(" ").replace(/\s+/g, " ").trim();
  const shown = [];
  const all = document.body.querySelectorAll("*");
  for (const e of all) {
    if (e.closest("script, style, svg, template")) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === "hidden" || +cs.opacity === 0) continue;
    const txt = own(e), media = /^(IMG|VIDEO|CANVAS|INPUT|TEXTAREA|BUTTON|SELECT)$/.test(e.tagName);
    const boxy = cs.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(cs.borderTopWidth) > 0 || cs.position === "fixed" || cs.position === "sticky";
    if (!txt && !media && !boxy) continue;
    shown.push([e, r, cs, txt]);
    // sticks out past the screen's right edge (and nothing above it scrolls or clips sideways)
    if (r.right > W + 1) { let clip = false; for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== "visible") { clip = true; break; } } if (!clip) bugs.push(`past the right edge by ${Math.round(r.right - W)}px: ${snapName(e)}`); }
    // text cut off without an ellipsis meant for it
    if (txt && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 2) && /hidden|clip/.test(cs.overflow) && cs.textOverflow !== "ellipsis" && !/-webkit-box/.test(cs.display)) bugs.push(`text cut off: ${snapName(e)} "${txt.slice(0, 40)}"`);
    if (e.tagName === "IMG" && e.complete && !e.naturalWidth && e.getAttribute("src")) bugs.push(`picture failed: ${snapName(e)} ${String(e.getAttribute("src")).slice(0, 80)}`);
  }
  // text on top of other text (not one inside the other, not the report box or a note floating over the page)
  const texty = shown.filter(([e, , cs, t]) => t && cs.position !== "fixed" && !e.closest("#ct-flagbox, #ct-fixed"));
  for (let i = 0; i < texty.length && bugs.length < 40; i++) for (let j = i + 1; j < texty.length; j++) {
    const [a, ra] = texty[i], [b, rb] = texty[j];
    if (a.contains(b) || b.contains(a)) continue;
    const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (ix > 4 && iy > 4 && ix * iy > 0.25 * Math.min(ra.width * ra.height, rb.width * rb.height)) bugs.push(`overlap: ${snapName(a)} "${texty[i][3].slice(0, 24)}" and ${snapName(b)} "${texty[j][3].slice(0, 24)}"`);
  }
  if (document.querySelector(".skeleton-card, .ct-skc, .ct-skimg, .skeleton-results") && performance.now() > 8000) bugs.push("loading placeholders still showing");
  const f = document.activeElement;
  if (f && f !== document.body && vv) { const r = f.getBoundingClientRect(); if (r.bottom > vv.offsetTop + vv.height + 1 || r.top < vv.offsetTop - 1) bugs.push(`focused ${snapName(f)} is outside the visible area (keyboard or bars): ${R(r)}, visible ${Math.round(vv.offsetTop)}..${Math.round(vv.offsetTop + vv.height)}`); }
  const tabs = document.getElementById("results-tabs"), first = document.querySelector("#results-list .result-item .result-url-row, #results-list .image-card, .no-results");
  const gap = tabs && first ? Math.round(first.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom) : null;
  const shifts = SNAP_SHIFT.filter((x) => performance.now() - x.t < 15000).map((x) => `${x.v.toFixed(3)} ${x.src.join(" | ")}`);
  const lines = shown.slice(0, 160).map(([e, r, cs, t]) => `${snapName(e)} ${R(r)}${cs.position === "fixed" || cs.position === "sticky" ? " " + cs.position : ""}${t ? ` "${t.slice(0, 50)}"` : ""}`);
  return { state, at: Math.round(performance.now()), view: `${W}x${H}${vv ? ` visible ${Math.round(vv.width)}x${Math.round(vv.height)}+${Math.round(vv.offsetTop)}` : ""} scroll ${Math.round(scrollY)} dpr ${devicePixelRatio}`,
    ua: navigator.userAgent.slice(0, 160), gap, bugs: [...new Set(bugs)].slice(0, 30), errors: SNAP_ERR.slice(-10), shifts: shifts.slice(-8), items: lines };
};
const curType = () => { try { return new URL(location.href).searchParams.get("type") || tabNow || "web"; } catch { return tabNow || "web"; } };
const flagBox = (btn) => {
  let box = document.getElementById("ct-flagbox");
  // A floating card (popover under the ⚑ on PC, bottom sheet on phone): never pushes the results down
  const close = () => {
    document.getElementById("ct-flagbox")?.remove(); document.removeEventListener("click", outside, true);
    btn.setAttribute("aria-expanded", "false"); removeEventListener("keydown", esc); removeEventListener("resize", place);
    if (vv) { vv.removeEventListener("resize", place); vv.removeEventListener("scroll", place); }
  };
  const esc = (e) => { if (e.key === "Escape") { close(); btn.focus(); } };
  const vv = window.visualViewport;
  const outside = (e) => { const b = document.getElementById("ct-flagbox"); if (!b || b.contains(e.target) || btn.contains(e.target)) return; e.preventDefault(); e.stopPropagation(); close(); };
  const place = () => {
    const b = document.getElementById("ct-flagbox");
    if (!b) return;
    // Phone sheet: pinned to the part of the screen that's actually visible (visualViewport), so an open keyboard,
    // the browser's bars or iOS scrolling the page for the focused box never leave a gap or hide part of it
    if (TOUCH.matches) {
      b.style.top = b.style.left = "";
      if (vv) {
        b.style.setProperty("--ct-vis-h", `${Math.round(vv.height)}px`); b.style.setProperty("--ct-vis-b", `${Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))}px`);
        // keyboard open: the sheet sits right on it (the home-bar spacing under it left a strip of page showing)
        b.classList.toggle("ct-kb", vv.height < innerHeight * 0.8);
      }
      return;
    }
    const r = btn.getBoundingClientRect(), w = b.offsetWidth || 440;
    b.style.top = `${Math.round(r.bottom + scrollY + 6)}px`;
    b.style.left = `${Math.round(Math.max(12, Math.min(r.right - w, innerWidth - w - 12)) + scrollX)}px`;
  };
  if (box) { close(); return; }
  let snap0 = null; try { snap0 = snapTake("closed"); } catch {}
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
    let snap1 = null; try { snap1 = snapTake("open"); } catch {}
    bridge("flag", {}, JSON.stringify({ q: curQ(), type: curType(), cats, note: t.value.trim(), ctx: flagCtx(), top: flagTop(), snap: [snap0, snap1].filter(Boolean) })).then((j) => {
      save.disabled = false;
      if (!j) { st.textContent = "Couldn't save. Try again."; return; }
      t.value = ""; chips.querySelectorAll(".ct-flag-cat").forEach((c) => c.setAttribute("aria-pressed", "false")); st.textContent = "Saved.";
      setTimeout(() => { if (box.isConnected) close(); }, 1200);
    }).catch(() => { save.disabled = false; st.textContent = "Couldn't save. Try again."; });
  });
  // No overlay: the results stay scrollable behind the box (a report is about them). A tap outside only closes the
  // box; it doesn't also follow a link, so a half-typed note isn't lost by accident.
  document.body.append(box);
  setTimeout(() => document.addEventListener("click", outside, true));
  place();
  addEventListener("keydown", esc); addEventListener("resize", place);
  if (vv) { vv.addEventListener("resize", place); vv.addEventListener("scroll", place); }
  if (!TOUCH.matches) t.focus();
};
// ⚑ sits in the header right after the settings gear (same round button); its box still opens over the results
const flagPlace = () => {
  const f = document.getElementById("ct-flag"), g = document.getElementById("nav-settings-results");
  if (!f || !g) return;
  // phone: the gear is pinned to the header's top right, so ⚑ is pinned just left of it at the same height (same order as PC)
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
  g.before(f); // ⚑ then gear on every screen size (the gear keeps degoog's own outer-edge spot)
  // Phone: placed in the next frame, when the browser lays the page out anyway (reading the gear's spot here forced
  // an extra layout in the middle of the results pass); hidden until then so it never shows in the wrong spot
  if (PHONE.matches) { f.style.visibility = "hidden"; requestAnimationFrame(() => { flagPlace(); f.style.visibility = ""; }); }
  if (!flagPlace.on) { flagPlace.on = 1; PHONE.addEventListener("change", flagPlace); addEventListener("resize", flagPlace); }
};
// ===== "Fixed" note: the first time degoog is opened anywhere after a release fixed your report =====
// The server tells each fix once (whichever device asks first), so seeing it on the phone means the PC won't show it.
// A small note at the bottom for a few seconds (fixed position: nothing on the page moves); a tap closes it.
const fixedNote = () => bridge("fixednews", {}, "").then((j) => {
  const items = j && Array.isArray(j.items) ? j.items.filter((x) => x && x.what) : [];
  if (!items.length || document.getElementById("ct-fixed")) return;
  const n = mk("div", "ct-fixed");
  n.id = "ct-fixed";
  n.setAttribute("role", "status");
  const vers = [...new Set(items.map((x) => x.ver))].join(", ");
  n.append(mk("b", "", items.length === 1 ? `Fixed in ${vers}` : `${items.length} of your reports fixed (${vers})`));
  for (const x of items.slice(0, 3)) n.append(mk("span", "ct-fixed-i", x.what));
  if (items.length > 3) n.append(mk("span", "ct-fixed-i", `+${items.length - 3} more`));
  const close = () => { n.classList.add("ct-out"); setTimeout(() => n.remove(), 300); };
  n.addEventListener("click", close);
  setTimeout(close, 8000);
  document.body.append(n);
}).catch(() => {});
// ----- page/07-layout.js: top gap, loading skeletons in the real shape, picture loading -----
// Gap from the tab row to the first thing under it (answer card, info panel or the first result's source line):
// measured, so empty or hidden blocks above the results can't add to it; the same on every tab and screen size
let gapEl = null; // what topGap last found highest (the first result's source line, the answer card...)
const topGap = () => {
  gapEl = null;
  const tabs = document.getElementById("results-tabs"), lay = document.getElementById("results-layout");
  if (!tabs || !lay) return;
  // The answer area counts as empty when nothing in it is showing (hidden leftovers otherwise kept degoog's
  // "not empty" margin, an extra 24 px gap above the results)
  const g = document.getElementById("at-a-glance");
  if (g) g.classList.toggle("ct-blank", ![...g.children].some((e) => e.getClientRects().length));
  let top = Infinity;
  // Results, pictures and videos: only the first showing one of each list (or picture column) can be the highest, so
  // the rest (hundreds after a few endless-scroll pages) aren't measured
  const firsts = [];
  const first = (els) => { for (const e of els) if (e.getBoundingClientRect().height > 0) { firsts.push(e); return; } };
  first(lay.querySelectorAll(".result-item .result-url-row"));
  for (const c of lay.querySelectorAll(".image-column")) first(c.querySelectorAll(".image-card"));
  first(lay.querySelectorAll(".image-grid > .image-card"));
  first(lay.querySelectorAll(".video-card"));
  // "No results" is the same on every tab: its text starts where the tab labels' text starts, at the same gap under
  // the tabs (on Images it sat flush with the screen edge on phones and wasn't measured for the gap)
  const nr = lay.querySelector(".no-results");
  if (nr) {
    const lab = [...tabs.querySelectorAll(".results-tab")].find((t) => t.getClientRects().length);
    const tn = lab && [...lab.childNodes].find((n) => n.nodeType === 3 && n.data.trim());
    const tx = (() => { const n = [...nr.childNodes].find((x) => x.nodeType === 3 && x.data.trim()) || nr.firstChild; if (!n) return null; const r = document.createRange(); r.selectNodeContents(n); return r.getClientRects()[0] || null; })();
    if (tn && tx) {
      const r = document.createRange(); r.selectNodeContents(tn);
      const want = r.getClientRects()[0], pad = parseFloat(nr.style.paddingLeft) || 0;
      if (want) { const next = Math.max(0, Math.round(pad + want.left - tx.left)); if (Math.abs(next - pad) >= 1) nr.style.paddingLeft = `${next}px`; }
    }
  }
  for (const e of [...lay.querySelectorAll("#ct-fix, #at-a-glance > *, #sidebar-col > *, .skeleton-card, .ct-skc, .ct-skimg, .command-result, .no-results"), ...firsts]) {
    const r = e.getBoundingClientRect();
    if (!(r.height > 0) || r.top >= top) continue; // a box's text never starts above its top: no style read needed
    // a line of text starts where its letters start, not where its line spacing starts; a measured placeholder row
    // where its result's link line will start
    const t = e.dataset.ut != null ? r.top + +e.dataset.ut : textTop(e, r);
    if (t < top) { top = t; gapEl = e; }
  }
  if (top === Infinity) { gapEl = null; return; }
  const cur = parseFloat(lay.style.getPropertyValue("--ct-top")) || 0;
  const want = TOUCH.matches ? 16 : 20; // v98: the user found 12/16 too tight ("bump it ever so slightly")
  // measured from whatever sits right above the results: the tab row, or the open Tools fields under it (measuring from
  // the tabs alone pulled the results up under the open fields)
  const adv = document.getElementById("ct-adv"), above = Math.max(tabs.getBoundingClientRect().bottom, adv ? adv.getBoundingClientRect().bottom : 0);
  const next = Math.round(cur + want - (top - above));
  if (Math.abs(next - cur) >= 1) lay.style.setProperty("--ct-top", `${next}px`);
};

// topGap is needed again unless everything that changed sits after the thing it found highest, in the results list or
// endless scroll's line under it (a page going in under the results, its placeholder, a fold or sitelink row): then nothing above
// moved and measuring would only force the browser to lay out the new page in the middle of the pass (~6 ms a page)
const gapSkip = (muts) => {
  const e = gapEl, list = document.getElementById("results-list");
  if (!e || !list || !e.isConnected || e.closest(".result-item")?.style.display === "none") return false;
  const after = (n) => { const p = e.compareDocumentPosition(n); return n === e || (p & 4 && !(p & 8)); }; // 4 following, 8 contains e
  for (const m of muts) {
    // inside the list, endless scroll's "more" line under it, or the list's own box (that line going in)
    const t = m.target;
    if (m.type !== "childList" || !(list.contains(t) || t === list.parentElement || t.closest?.(".degoog-infinite"))) return false;
    if (t !== e && after(t)) continue; // the whole box that changed comes after it
    for (const n of m.addedNodes) if (!after(n)) return false;
    if (m.removedNodes.length && !(m.previousSibling && (after(m.previousSibling) || e.compareDocumentPosition(m.previousSibling) & 8))) return false;
  }
  return true;
};

// ===== Loading skeletons in the shape of what comes =====
// degoog's placeholders are generic (4 even columns of grey tiles; 4 text lines per result), so the page changed
// shape when the results came. Here each placeholder is drawn from what that tab really showed last time on this
// device and width: list tabs replay the measured boxes of the last real results (favicon, each text line at its
// real width, thumbnail, row heights and gaps); Images uses the real grid's own CSS and columns, with the measured
// picture shapes and the title/site lines under each. Nothing measured yet = degoog's own placeholder.
const SKEL = "ct-skel";
const skelGet = () => { try { return JSON.parse(localStorage.getItem(SKEL) || "{}") || {}; } catch { return {}; } };
const skelPut = (k, v) => { const all = skelGet(); all[k] = v; try { localStorage.setItem(SKEL, JSON.stringify(all)); } catch {} };
const skelKey = (w) => `${curType()}|${PHONE.matches ? "p" : "d"}|${Math.round(w / 50)}`;
// Where a box's text starts, as topGap measures it (letters, not line spacing), so a placeholder sits exactly where
// the results will
const textTop = (e, r = e.getBoundingClientRect()) => {
  const cs = getComputedStyle(e), lh = parseFloat(cs.lineHeight), fs = parseFloat(cs.fontSize);
  return r.top + parseFloat(cs.paddingTop || 0) + (lh > fs && e.childElementCount === 0 || e.id === "ct-fix" ? (lh - fs) / 2 : 0);
};
const skelBlock = (x, y, w, h, r) => { const b = document.createElement("span"); b.className = "ct-skb"; b.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:${r}px`; return b; };
// One result's boxes, relative to the result: pictures/favicons as they are, text as one bar per line at its width
const skelShape = (el) => {
  const R = el.getBoundingClientRect(), out = [], pics = [];
  for (const m of el.querySelectorAll("img, .result-thumbnail-wrap, .result-favicon-missing")) {
    if (pics.some((p) => p.contains(m))) continue;
    const r = m.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom > R.bottom + 1 || r.top < R.top - 1) continue;
    pics.push(m);
    out.push([r.left - R.left, r.top - R.top, r.width, r.height, Math.min(r.height / 2, parseFloat(getComputedStyle(m).borderTopLeftRadius) || 4)]);
  }
  const lines = new Map();
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode()) && lines.size < 12;) {
    const p = n.parentElement;
    if (!n.data.trim() || !p || pics.some((x) => x.contains(p)) || !p.getClientRects().length) continue;
    const fs = parseFloat(getComputedStyle(p).fontSize) || 14, rg = document.createRange();
    rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) {
      if (r.width < 2 || r.bottom > R.bottom + 1) continue;
      const k = Math.round((r.top + r.bottom) / 2 - R.top), l = lines.get(k);
      if (l) { l[0] = Math.min(l[0], r.left - R.left); l[1] = Math.max(l[1], r.right - R.left); l[2] = Math.max(l[2], fs); }
      else lines.set(k, [r.left - R.left, r.right - R.left, fs, k]);
    }
  }
  for (const [x0, x1, fs, mid] of lines.values()) { const h = Math.round(fs * 0.72); out.push([x0, mid - h / 2, x1 - x0, h, Math.min(4, h / 2)]); }
  const u = el.querySelector(".result-url-row");
  return { h: R.height, ut: u ? textTop(u) - R.top : null, b: out.map((a) => a.map((v) => Math.round(v * 10) / 10)) };
};
// After the results settle (idle time, once per search): keep the shapes of the first rows
let skelFor = "";
const skelLearn = () => {
  const key = searchId();
  if (skelFor === key) return;
  const list = document.getElementById("results-list");
  if (!list || list.querySelector(".skeleton-results, .skeleton-image-grid")) return;
  const imgs = [...list.querySelectorAll(".image-card")].filter((e) => e.style.display !== "none");
  const rows = [...list.children].filter((e) => e.classList.contains("result-item") && e.style.display !== "none" && !e.classList.contains("ct-grouped"));
  if (imgs.length < 6 && rows.length < 3) return;
  skelFor = key;
  const later = window.requestIdleCallback ? (f) => requestIdleCallback(f, { timeout: 2000 }) : (f) => setTimeout(f, 600);
  later(() => {
    if (searchId() !== key) return;
    const w = list.clientWidth;
    if (!w) return;
    if (imgs.length >= 6) {
      // Picture shapes (height per width of the picture box) of the first 24 pictures, in order
      const ar = imgs.slice(0, 24).map((e) => { const t = e.querySelector(".image-thumb-wrap") || e, r = t.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? Math.round((r.height / r.width) * 100) / 100 : 0; }).filter((x) => x > 0.2 && x < 4);
      if (ar.length >= 6) skelPut(skelKey(w), { ar });
      return;
    }
    const lt = list.getBoundingClientRect().top, picks = rows.slice(0, 6), shapes = [];
    for (let i = 0; i < picks.length; i++) {
      const s = skelShape(picks[i]), nx = picks[i + 1];
      s.gap = nx ? Math.max(0, Math.round(nx.getBoundingClientRect().top - picks[i].getBoundingClientRect().bottom)) : 0;
      if (i === 0) s.top = Math.round(picks[0].getBoundingClientRect().top - lt);
      shapes.push(s);
    }
    skelPut(skelKey(w), { rows: shapes });
  });
};
// degoog just drew a placeholder: redraw it in the shape of what comes, before the screen updates
const skel = (root) => {
  for (const g of root.matches?.(".skeleton-results, .skeleton-image-grid") ? [root] : root.querySelectorAll?.(".skeleton-results, .skeleton-image-grid") || []) {
    if (g.dataset.ctSkel) continue;
    g.dataset.ctSkel = "1";
    const w = g.clientWidth || document.getElementById("results-list")?.clientWidth || innerWidth;
    const t = skelGet()[skelKey(w)];
    if (g.classList.contains("skeleton-image-grid")) {
      // degoog's own column count for this width (render-media.tsx COLUMN_STEPS), the real grid's gaps (custom.css)
      const cols = w <= 800 ? 3 : w <= 1100 ? 4 : w <= 1400 ? 5 : 6;
      const ar = (t && t.ar) || [140, 100, 175, 115, 155, 90, 135, 105].map((h) => h / 200); // degoog's tiles at a 200px column
      const per = Math.max(3, Math.ceil(((innerHeight * 1.2) / (w / cols)) / (ar.reduce((a, b) => a + b, 0) / ar.length)));
      const line = (cls, pct) => { const s = document.createElement("span"); s.className = cls; const i = document.createElement("i"); i.className = "ct-skt"; i.style.width = `${pct}%`; s.append(i); return s; };
      const colsEl = [];
      for (let c = 0; c < cols; c++) {
        const col = document.createElement("div");
        col.className = "image-column";
        for (let r = 0; r < per; r++) {
          const k = c + r * cols, card = document.createElement("div");
          card.className = "ct-skimg";
          const th = document.createElement("div");
          th.className = "image-thumb-wrap ct-skb-in";
          th.style.aspectRatio = `1 / ${ar[k % ar.length]}`;
          const info = document.createElement("div");
          info.className = "image-info";
          info.append(line("image-title", 55 + ((k * 37) % 40)), line("image-source", 30 + ((k * 23) % 30)));
          card.append(th, info);
          col.append(card);
        }
        colsEl.push(col);
      }
      g.replaceChildren(...colsEl);
      continue;
    }
    if (!t || !t.rows || !t.rows.length) continue;
    // List tabs: the measured rows, repeated until the screen is full (the "more results" placeholder keeps its count)
    const more = g.classList.contains("skeleton-results--more"), n = more ? g.children.length || 3 : 0, cards = [];
    let y = 0;
    for (let i = 0; (more ? i < n : y < innerHeight * 1.2) && i < 30; i++) {
      const s = t.rows[i % t.rows.length], c = document.createElement("div");
      c.className = "ct-skc";
      c.style.height = `${s.h}px`;
      c.style.marginBottom = `${s.gap}px`;
      if (s.ut != null) c.dataset.ut = s.ut;
      for (const b of s.b) c.append(skelBlock(...b));
      cards.push(c);
      y += s.h + s.gap;
    }
    g.classList.add("ct-skel-m");
    if (!more && t.rows[0].top) g.style.paddingTop = `${t.rows[0].top}px`;
    g.replaceChildren(...cards);
  }
};
// Pictures shimmer in place (same tile as the placeholder) until they've loaded and the image AI has answered,
// then fade in; the first screen's pictures load first instead of waiting for the browser's lazy start
const picLoad = (el) => {
  const im = el.querySelector("img");
  if (!im) return;
  const idx = +el.dataset.idx;
  if (idx < 18) { im.loading = "eager"; im.fetchPriority = "high"; }
  im.decoding = "async";
  if (im.complete && im.naturalWidth) return;
  im.classList.add("ct-ld");
  const done = () => im.classList.remove("ct-ld");
  im.addEventListener("load", done, { once: true });
  im.addEventListener("error", done, { once: true });
};

// Weather card with no city ("Usage: !weather <city>") is noise: hide it (no default city on purpose)
const noUsage = (root) => {
  const list = root.matches?.(".command-result") ? [root] : [...(root.querySelectorAll?.(".command-result") || [])];
  for (const c of list) if (/^\s*Usage: !weather\b/.test(c.textContent)) {
    const box = c.parentElement?.children.length === 1 ? c.parentElement : c;
    box.style.display = "none";
  }
};

// ----- page/08-blocks.js: sitelinks, forums, videos, top stories -----
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
      fav: favOf(h, el.querySelector("img.result-favicon")?.src || ""), dur: el.querySelector(".degoog-result--video-duration")?.textContent.trim() || "",
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
  const key = searchId();
  if (G.key !== key) {
    list.querySelectorAll(".ct-grp, .ct-sl").forEach((x) => x.remove());
    list.querySelectorAll(".ct-grouped").forEach((x) => x.classList.remove("ct-grouped"));
    G = { key, sl: null, slTop: null, forum: null, video: null, paper: null, news: false, img: false, cut: false, old: new WeakSet(), mark: false };
  }
  for (const k of ["forum", "video", "paper", "sl"]) if (G[k] && !G[k].isConnected) G[k] = null; // degoog redrew the list
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none" || x.dataset.ctCap).map(info).filter(Boolean);
  const top = rows.find((r) => shown(r.el));
  if (!top) return;
  // Endless scroll: what's already on screen never changes when the next page goes in (v90: the top result grew by
  // a sitelink row and the boxes above took results from the new page, so everything under them jumped while you
  // read further down). Painted = drawn in an earlier frame: those results stay as they are and painted boxes don't
  // grow; a box that only the new page has enough for goes among the new page's results.
  const painted = (x) => !!x && G.old.has(x);
  if (!G.mark) {
    G.mark = true;
    requestAnimationFrame(() => { G.mark = false; if (G.key === key) for (const el of list.querySelectorAll(".result-item, .ct-grp, .ct-sl")) G.old.add(el); });
  }
  const late = rows.some((r) => painted(r.el));

  // Sitelinks: the top result's other pages from your results, under it (they leave the list, so no repeats)
  if (G.slTop !== top.el) { G.sl?.remove(); G.sl = null; G.slTop = top.el; }
  if (SHOW.sl && !top.video && !top.forum && !painted(G.sl || top.el)) {
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
  // result); up to 4 threads / 8 videos, all from the page it was drawn with (later pages keep theirs, see painted)
  // extra: items from a search of that kind fetched for this page (no element; only when the box is first drawn,
  // so a box never grows after paint because of them)
  const box = (kind, test, max, build, title, tab, label, isRow, at, extra) => {
    let s = G[kind];
    if (painted(s)) return; // on screen already: never grows
    let c = rows.filter((r) => r !== top && test(r) && !used(r.el) && !r.el.dataset.ctUnrel && !painted(r.el));
    if (!s && extra && extra.length) {
      const have = new Set(rows.map((r) => r.href.split("#")[0]));
      c = c.concat(extra.filter((r) => !have.has(r.href.split("#")[0]) && have.add(r.href.split("#")[0])));
    }
    if (!s && c.length < 2) return;
    if (!s) {
      const first = c.find((r) => r.el && r.el.style.display !== "none") || c.find((r) => r.el);
      if (late && !first) return; // nowhere to go below what's on screen
      s = G[kind] = section(`ct-${kind}`, title);
      if (isRow) { const [wrap, row] = scroller(); s.append(wrap); s.row = row; s.wrap = wrap; } else { s.row = mk("div", "ct-list"); s.append(s.row); }
      if (late) first.el.before(s); else if (at && at.before) at.before.before(s); else if (at && at.after) endOf(at.after).after(s); else if (first) first.el.before(s); else top.el.after(s);
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
      return { u, h, href: x.url, title: cleanTitle(String(x.title || ""), x.url) || String(x.title || ""), snippet: String(x.snippet || ""), fav: favOf(h, x.favicon || ""),
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
      if (scrollY > 40 || searchId() !== key) return;
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
      if (at && at.before) at.before.before(s); else if (at) endOf(at.after).after(s); else t.after(s);
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
      return { h, href: x.url, title: cleanTitle(String(x.title || ""), x.url) || String(x.title || ""), w, thumb: x.thumbnail || "", fav: favOf(h, x.favicon || ""), ai: x.ctRel };
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
    if (at && at.before) at.before.before(s); else if (at) endOf(at.after).after(s); else t.after(s);
    wrap.upd();
  }
};

// ----- page/09-answers.js: answer card, AI summary spot, contested check, only-site line -----
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
  const key = searchId(), list = document.getElementById("results-list");
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
    if (searchId() !== key) return;
    if (document.visibilityState !== "visible") { document.addEventListener("visibilitychange", () => livePoll(key, q), { once: true }); return; }
    const j = await bridge("sports", { q }).catch(() => null);
    const a = j && j.g && CT.sportsAnswer(j.g);
    const box = document.querySelector("#at-a-glance > .ct-ans[data-kind=sports]");
    if (!a || !box || searchId() !== key) return;
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
// A result's whole group: the result plus what hangs under it (its "N more from…" fold rows and the folded or hidden
// results behind them). Boxes placed "after a result" go after the group, never inside it.
const endOf = (el) => {
  let n = el;
  for (let x = n.nextElementSibling; x && (x.classList.contains("ct-fold") || x.classList.contains("ct-grouped") || x.classList.contains("result-item") && (x.hidden || x.style.display === "none")); x = x.nextElementSibling) n = x;
  return n;
};
const byWorth = (kind, fit) => {
  const list = document.getElementById("results-list"), key = searchId();
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
  const key = searchId();
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
  if (at) { if (at.before) at.before.before(card); else endOf(at.after).after(card); }
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
  const key = searchId(), list = document.getElementById("results-list");
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

// ----- page/10-panels.js: quick view, inline stars, meaning line, knowledge panel, product panel -----
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
  const key = searchId(), list = document.getElementById("results-list");
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
  const key = searchId(), list = document.getElementById("results-list");
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
  const key = searchId(), list = document.getElementById("results-list");
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
  if (at) { if (at.before) at.before.before(card); else endOf(at.after).after(card); } else list.prepend(card);
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
  const key = searchId(), list = document.getElementById("results-list");
  if (PD.key !== key) { Object.assign(PD, { key, asked: false, d: null, done: false }); document.querySelectorAll(".ct-prod").forEach((x) => x.remove()); }
  if (!webTab || SHOW.kp === false || PD.done || !list) return;
  if (!PD.asked) {
    const nd = ready("needs", key);
    if (nd === undefined || !list.querySelector(".result-item")) return;
    PD.asked = true;
    let pg = 1; try { pg = Number(new URL(key).searchParams.get("page") || 1); } catch {}
    // Asked on every first page (v98, the user: "any time I put the name of a product in"): whether there is a product
    // is decided by the real signal, product data on the top pages (CT.prodShow), not by the AI's block share, which
    // judged "yamaha dbr10 release" not worth a panel
    if (pg > 1 || shaped()) { PD.done = true; return; }
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
// ----- page/11-init.js: tab row repair, init (the one observer pass), load timing, DuckDuckGo once -----
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
// Every pass runs through safe(): an error in one never stops the others, and its time is added up per search
// (PASS_MS: name -> ms, BATCHES: observer runs), so each ⚑ says which passes cost the most on that device
const PASS_MS = new Map();
let passFor = "", BATCHES = 0;
const passReset = () => { const id = searchId(); if (id !== passFor) { passFor = id; PASS_MS.clear(); BATCHES = 0; } BATCHES++; };
globalThis.__ctPass = () => ({ batches: BATCHES, ms: Object.fromEntries(PASS_MS) }); // read by test/headless/run.cjs
const safe = (name, fn) => { const t = performance.now(); try { fn(); } catch (e) { console.error(`clean-titles ${name}:`, e); } PASS_MS.set(name, (PASS_MS.get(name) || 0) + performance.now() - t); };
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
  safe("fixed", fixedNote);
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
    passReset();
    safe("query", readQuery);
    safe("early", earlyStart);
    safe("answer", ansPass);
    safe("list", listPass);
    safe("tabs", tabPass);
    safe("rel", relPass);
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { safe("scan", () => scan(n)); safe("skeleton", () => skel(n)); safe("usage", () => noUsage(n)); }
    safe("extras", extras); safe("groups", groups); safe("folds", foldPass); safe("ask", paa); safe("tools", tools); safe("flag", flagBtn); if (!gapSkip(muts)) safe("gap", topGap); safe("tabkeep", tabKeep); safe("card", glance);
    safe("kp", kpPass); safe("only", onlyPass); safe("mean", meanPass); safe("stars", starsPass); safe("preview", previewPass); safe("sides", sidesPass); safe("prod", productPass);
    safe("drawn", markDrawn); safe("skellearn", skelLearn);
    safe("ai", () => { const g = document.getElementById("at-a-glance"); if (g) aiPass(g, searchId()); });
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
