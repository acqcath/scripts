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
export const listCtx = (q, psl, prefs = {}) => ({ add: deduper(psl), named: namedSites(q, psl), count: new Map(), prefs, cap: 2, docs: docsFor(q), docsDone: false });

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
  const shown = [], folds = new Map();
  for (const r of kept) {
    const c = ctx.count.get(r.site) || 0;
    ctx.count.set(r.site, c + 1);
    if (c < ctx.cap || ctx.prefs[r.site] === "prefer" || siteNamed(r.site, ctx.named)) { shown.push(r); continue; }
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
