// ----- server/12-routes.js: routes: the one route table (every /bridge call lands here) -----
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
      F.list.push({ id: now, t: now, q, type: String(b.type || "web").slice(0, 40), cats: flagCats(b.cats), note: String(b.note || "").trim().slice(0, 1000), ctx: flagCtxClean(b.ctx), snap: flagSnapClean(b.snap),
        top: (Array.isArray(b.top) ? b.top : []).slice(0, 10).map((r) => ({ ai: r && Number.isFinite(+r.ai) && r.ai !== null ? Math.max(0, Math.min(1, +r.ai)) : null, title: String((r && r.title) || "").slice(0, 200), url: String((r && r.url) || "").slice(0, 500), snippet: String((r && r.snippet) || "").slice(0, 300) })).filter((r) => /^https?:\/\//.test(r.url)) });
      if (F.list.length > 500) F.list = F.list.slice(-500);
      saveFlags(); pcWrite();
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
        saveFlags(); pcWrite();
        return jsonOut({ flags: [], issue: "" });
      }
      // The PC's job (../autoupdate-job.ps1 SendReports): the prompt itself, with no " or \ in it, because
      // Windows PowerShell mangles those in arguments to programs
      const send = flagDue(open, i);
      if (new URL(req.url).searchParams.get("prompt") === "1") return jsonOut({ n: open.length + (i ? 1 : 0), issue: !!i, send, prompt: (flagPrompt(open, i ? i.text : "") + (installTiming() ? "\nLast install " + installTiming() : "")).replace(/["\\]/g, "'") });
      return jsonOut({ flags: open, issue: i ? i.text : "", send });
    },
  },
  {
    // "Fixed" note: reports the installed version fixed, told once (whichever device asks first) -> {items: [{ver, what}]}
    method: "post",
    path: "/fixednews",
    async handler() {
      const F = readFlags(), items = fixedNews(F.list, CT_FIXED);
      if (items.length) saveFlags();
      return jsonOut({ items });
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
    // {ver, pageMissing, ai, aiMs, flags, timing, issue, up}
    method: "get",
    path: "/status",
    async handler() {
      let ver = "";
      try { const h = fs.readFileSync(PAGE_FILE, "utf8"); const m = /\/public\/ct\/(ct\.[0-9a-f]+\.js)/.exec(h); ver = (/\/\/ clean-titles (v[\w.-]+)/.exec(m ? fs.readFileSync(`/app/src/public/ct/${m[1]}`, "utf8").slice(0, 80) : h) || [])[1] || ""; } catch {}
      const t0 = Date.now();
      let ai = false;
      try { const r = await fetch(VIS + "/health", { signal: AbortSignal.timeout(1500) }); ai = r.ok; } catch {}
      const i = flagIssue();
      return jsonOut({ ver, pageMissing: PAGE_MISSING, ai, aiMs: Date.now() - t0, flags: flagOpen().length, timing: installTiming(), issue: i ? i.text.split("\n").slice(0, 3).join(" | ").slice(0, 300) : "", up: Math.round(process.uptime()), speed: { hook: median(SPEED.hook), rank: median(SPEED.rank), gpu: median(SPEED.gpu), queue: median(SPEED.queue), n: SPEED.hook.length } });
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
      return new Response(JSON.stringify({ sites, auto: autoList().filter((d) => sites[d] === "lower"), seo: SEO_ON, ai: aiStatus(data), flags: flagCount(), flagDue: flagDue(flagOpen(), flagIssue()), fx: readFx().rates ? { date: FX.date, rates: FX.rates } : null }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
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
      const p = setTimeout(() => { try { load(); } catch {} }, 500); if (p.unref) p.unref();
      // pc.json at start, so reports waiting from before a restart are sent
      const w = setTimeout(() => { try { pcListen(); pcWrite(); } catch {} }, 1000); if (w.unref) w.unref(); }
  },

  // Bridge: the page reaches the routes above through degoog's command address (/api/command),
  // because iPhone content blockers reject /api/plugin/ addresses. "!cleantitles bridge <route> <query string>"
  async execute(args) {
    const m = /^bridge\s+(\w+)\s*([\s\S]*)$/.exec(String(args || ""));
    if (m && m[1] !== "flags") try { searchSeen(); } catch {} // a page in use (the PC job's own flags call isn't)
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