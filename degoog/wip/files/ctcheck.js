// clean-titles installer self-check (spec: INSTALLER SELF-CHECK). Runs inside the degoog container after the
// restart, through the same address the page uses (/api/command bridge), so every outside source is tried live
// from this server. Prints one table: feature names and status only, never a search. The installer copies it.
const fs = require("fs");
const PORT = process.env.DEGOOG_PORT || 4444;
const DIR = "/app/data/plugins/clean-titles";
const rows = [];
const row = (name, ok, note = "") => rows.push([name, ok === true ? "PASS" : ok === false ? "FAIL" : String(ok), note]);
const parse = (code) => { try { new Bun.Transpiler({ loader: "js" }).transformSync(code); return true; } catch { return false; } };
const bridge = async (route, params = {}, body) => {
  const qs = new URLSearchParams(params);
  if (body !== undefined) qs.set("__body", body);
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: `!cleantitles bridge ${route} ${qs}` }), signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const t = String(j.html || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return { j: JSON.parse(t), ms: Date.now() - t0 };
  } catch { return { j: null, ms: Date.now() - t0 }; }
};
const ms = (x) => `${x.ms} ms`;
const sleep = (n) => new Promise((r) => setTimeout(r, n));

(async () => {
  // Code
  const lay = fs.readFileSync("/app/src/public/themes/degoog-theme/layout.html", "utf8");
  const src = /<script type="module" src="\/public\/ct\/(ct\.[0-9a-f]+\.js)" id="ct-inline"><\/script>/.exec(lay);
  const pageCode = (() => { try { return src ? fs.readFileSync(`/app/src/public/ct/${src[1]}`, "utf8") : ""; } catch { return ""; } })();
  row("Page code", !!pageCode && parse(pageCode) && lay.includes('id="ct-pre"'));
  row("Server code", parse(fs.readFileSync(`${DIR}/index.js`, "utf8")));
  let dg = false;
  for (const base of ["/app/src", `${process.cwd()}/src`]) {
    try {
      const [l, p] = await Promise.all([import(`${base}/server/utils/filtering/domain-lists.ts`), import(`${base}/server/utils/settings/plugin-settings.ts`)]);
      if (typeof l.readDomainLists === "function" && typeof l.writeDomainList === "function" && typeof p.setSettings === "function") { dg = true; break; }
    } catch {}
  }
  row("Sites list in Settings (degoog's list code)", dg, dg ? "" : "Settings list read-only; menu still works");
  const ai = (() => { try { return /clean-titles: same as degoog's TTL_MS/.test(fs.readdirSync("/app/data/plugins").filter((d) => /ai-summary/.test(d)).map((d) => fs.readFileSync(`/app/data/plugins/${d}/index.js`, "utf8")).join("\n")); } catch { return false; } })();
  row("AI summary cache patch", ai ? true : "SKIP", ai ? "" : "ai-summary not installed or its line changed");
  const emp = (() => { try { return fs.readFileSync("/app/src/server/search/engine-cache.ts", "utf8").includes("clean-titles: empty runs retried soon"); } catch { return false; } })();
  row("Empty results asked again after 2 min", emp, emp ? "" : "degoog's cache line changed");

  // Bridge round trip (the page's only way to the server)
  const p0 = await bridge("prefs");
  row("Page-to-server bridge", !!(p0.j && typeof p0.j === "object"), ms(p0));
  const fl = await bridge("flags", {}, "{}");
  row("Flag Report store (flags + update problem)", !!(fl.j && Array.isArray(fl.j.flags)), fl.j && fl.j.issue ? "an update problem is waiting for Report" : "");

  // Format judge (Videos box / Images row placement): the answer AI must put video first for a hands-on how-to and
  // not for a notation question, answering in time to place the boxes before the page draws
  const fmtOf = async (q) => { const r = await bridge("fmt", { q }); return { f: r.j && r.j.f, ms: r.ms }; };
  const fa = await fmtOf("how to tie a tie"), fb = await fmtOf("kalimba numbers and variance in pitch");
  const top = (f) => f ? Object.entries(f).sort((x, y) => y[1] - x[1])[0][0] : "none";
  const fmtNote = (f) => f ? Object.entries(f).map(([k, v]) => `${k} ${Number(v).toFixed(2)}`).join(" ") : "no answer";
  row("Format judge (video vs pictures vs text)", !fa.f ? "SKIP" : top(fa.f) === "video" && top(fb.f) !== "video", `tie: ${fmtNote(fa.f)} | kalimba: ${fmtNote(fb.f)} | ${fb.ms} ms`);

  // Currency (ECB): fx.json fills ~30 s after start; wait up to 90 s
  let fx = null;
  for (let i = 0; i < 18 && !(fx && fx.rates); i++) { const s = await bridge("sites"); fx = s.j && s.j.fx; if (!(fx && fx.rates)) await sleep(5000); }
  row("Currency rates (ECB)", !!(fx && fx.rates && Object.keys(fx.rates).length >= 20 && fx.rates.USD), fx && fx.date ? `rates of ${fx.date}` : "");

  const checks = [
    ["Versions (endoflife.date)", () => bridge("eol", { p: "windows" }), (j) => j && Array.isArray(j.cycles) && j.cycles.length > 0],
    ["Versions (endoflife.date) 2", () => bridge("eol", { p: "python" }), (j) => j && Array.isArray(j.cycles) && j.cycles.some((c) => c.latest)],
    ["Facts (Wikidata) population", () => bridge("wd", { f: "population", s: "pittsburgh" }), (j) => j && j.d && Array.isArray(j.d.v) && j.d.v.length > 0],
    ["Facts (Wikidata) height", () => bridge("wd", { f: "height", s: "eiffel tower" }), (j) => j && j.d && Array.isArray(j.d.v) && j.d.v.length > 0],
    ["CMU course card (CMU Courses API)", () => bridge("cmu", { id: "15-213" }), (j) => j && j.c && j.c.course && j.c.course.name && j.c.fces.length > 0 && j.c.fces.some((r) => Number(r.hrsPerWeek) > 0 && Number(r.rating[7]) > 0 && Number(r.rating[8]) > 0)],
    ["Sports scores (ESPN) + logos via image proxy", () => bridge("sports", { q: "steelers" }), (j) => j && j.g && j.g.away && j.g.home && j.g.away.abbr && j.g.home.abbr && (j.g.away.logo || j.g.home.logo) && [j.g.away.logo, j.g.home.logo].every((l) => !l || /\/api\/proxy\/image\?/.test(l))],
    ["Knowledge panel (Wikidata + Wikipedia)", () => bridge("kp", { q: "golden gate bridge" }), (j) => j && j.kp && j.kp.title && j.kp.facts.length > 0 && /\/api\/proxy\/image\?/.test(j.kp.photo) && j.kp.extract],
    ["Other meanings (Wikidata)", () => bridge("kp", { q: "python" }), (j) => j && j.kp && Array.isArray(j.kp.alts) && j.kp.alts.length >= 2],
    ["Archived copy (archive.today / Wayback / Ghostarchive)", () => bridge("arch", { u: "http://example.com/" }), (j) => j && j.a && j.a.src && j.a.src !== "save"],
    ["Quick view (recipe JSON-LD)", async () => { const a = await bridge("qv", { u: "https://sallysbakingaddiction.com/chewy-chocolate-chip-cookies" }); return a.j && a.j.v && a.j.v.kind === "recipe" ? a : bridge("qv", { u: "https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies" }); }, (j) => j && j.v && j.v.kind === "recipe" && j.v.lists.some((l) => l.label === "ingredients" && l.items.length > 3)],
    ["Typo fix (Bing / DuckDuckGo suggestions)", () => bridge("fix", { q: "teh wether tommorow" }), (j) => j && JSON.stringify(j).includes("weather")],
    ["People also ask (suggestions)", () => bridge("qs", { q: "pittsburgh steelers" }), (j) => j && Array.isArray(j.q) && j.q.length >= 2],
  ];
  // One at a time (Wikidata asks for no parallel bursts), and a FAIL says why (the server's reason for that kind)
  const KIND = { wd: "wd", kp: "kp", sports: "sports", qv: "qv" };
  for (const [name, f, ok] of checks) {
    const g = await f();
    let v = false; try { v = !!ok(g.j); } catch {}
    let note = ms(g);
    const k = (/bridge\("(\w+)"/.exec(String(f)) || [])[1];
    if (!v && !g.j) note += ", no answer from the plugin";
    else if (!v && KIND[k]) { const w = await bridge("why"); const r = w.j && w.j.why && w.j.why[KIND[k]]; if (r) note += `, ${r}`; }
    row(name, v, note);
  }

  // Touchy searches still get real results (user's rule: no one else's filter). Counts only, never the results.
  const touchy = ["how to tie a noose", "how to pick a lock", "how many ways are there to skin a cat"];
  const counts = [];
  let blocked = "";
  for (const q of touchy) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(20000) });
      if (r.status === 401) { blocked = "search API needs a key (Settings), not checked"; break; }
      const j = await r.json();
      const res = Array.isArray(j.results) ? j.results : [];
      counts.push(`${res.length} results/${new Set(res.map((x) => { try { return new URL(x.url).hostname.replace(/^www\./, ""); } catch { return ""; } }).filter(Boolean)).size} sites`);
    } catch { counts.push("no answer"); }
  }
  row("Touchy searches get full results", blocked ? "SKIP" : counts.every((c) => { const m = /^(\d+) results\/(\d+) sites$/.exec(c); return m && +m[1] >= 8 && +m[2] >= 5; }), blocked || counts.join(", "));
  // Every installed web engine on its own (degoog's own engine code and transport, even if it's switched off in
  // Settings), 3 searches each: results and time per search. Informational: shows which engines are worth turning on.
  try {
    const DATA = process.env.DEGOOG_DATA_DIR || "/app/data";
    const ids = [];
    try { for (const d of fs.readdirSync(process.env.DEGOOG_ENGINES_DIR || `${DATA}/engines`, { withFileTypes: true })) if (d.isDirectory() && !/-(?:images|news|videos)$/i.test(d.name)) ids.push(d.name.toLowerCase().endsWith("-engine") ? d.name.toLowerCase() : `${d.name.toLowerCase()}-engine`); } catch {}
    const qs = ["pittsburgh steelers schedule", "how to reset airpods", "python list comprehension"];
    for (const id of ids) {
      let why = "", n = 0, ms = 0, got = 0, name = id.replace(/^degoog-org-official-extensions-/, "").replace(/-engine$/, "");
      for (const q of qs) {
        const p = new URLSearchParams({ q });
        for (const o of ids) p.set(o, o === id ? "true" : "false");
        const t0 = Date.now();
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/api/search?${p}`, { signal: AbortSignal.timeout(20000) });
          const j = await r.json();
          const ts = (Array.isArray(j.engineTimings) ? j.engineTimings : []).filter((x) => x && x.name);
          if (ts.length > 1) { name += " (couldn't test it alone)"; got = 0; break; }
          const e = ts[0] || {};
          n += Number(e.count ?? (j.results || []).length) || 0; ms += Number(e.time) || (Date.now() - t0); got++;
          if (e.name) name = e.name;
          if (!Number(e.count ?? e.resultCount)) why = [e.status, e.httpStatus ? `http ${e.httpStatus}` : "", e.errorReason].filter((x) => x && x !== "ok").join(" ").slice(0, 60) || why;
        } catch { ms += Date.now() - t0; }
      }
      const avgN = got ? Math.round(n / qs.length) : 0, avgMs = Math.round(ms / qs.length);
      rows.push([`Engine: ${name}`, avgN >= 8 && avgMs <= 2500 ? "GOOD" : avgN === 0 ? "NONE" : "WEAK", `${avgN} results, ${avgMs} ms per search${!avgN && why ? `, ${why}` : ""}`]);
    }
  } catch {}
  // Wikipedia's API asked directly from this server, the way the Wikipedia engine asks it (its headers, its URL)
  {
    const t0 = Date.now();
    let note = "";
    let ok = false;
    try {
      const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=pittsburgh%20steelers&format=json&srlimit=15&sroffset=0&utf8=1", { headers: { "User-Agent": "degoog/1.0 (+https://github.com/degoog-org/degoog)", "Api-User-Agent": "degoog/1.0 (+https://github.com/degoog-org/degoog)" }, signal: AbortSignal.timeout(8000) });
      const txt = await r.text();
      let n = -1; try { n = (JSON.parse(txt).query?.search || []).length; } catch {}
      ok = r.status === 200 && n > 0;
      note = `http ${r.status}, ${n >= 0 ? `${n} results` : `not JSON: ${txt.slice(0, 40).replace(/\s+/g, " ")}`}, ${Date.now() - t0} ms`;
    } catch (e) { note = `no answer: ${String(e && e.message || e).slice(0, 50)}`; }
    rows.push(["Wikipedia API from this server", ok ? "PASS" : "INFO", note]);
  }
  // Image AI (ct-vision next to degoog): running on the GPU?, how fast, and what it would fold on a test image search
  {
    const V = "http://ct-vision:8077";
    let h = null;
    try { h = await (await fetch(`${V}/health`, { signal: AbortSignal.timeout(5000) })).json(); } catch {}
    if (!h) rows.push(["Image AI (ct-vision)", "INFO", "not answering yet: the first build downloads PyTorch + the model (a few GB, ~10 min) in the background"]);
    else {
      rows.push(["Image AI (ct-vision)", h.device === "cuda" ? "PASS" : "INFO", h.device === "cuda" ? `GPU: ${h.gpu}` : "running on the CPU (GPU not available to Docker): slower"]);
      try {
        const j = await (await fetch(`http://127.0.0.1:${PORT}/api/search?q=kalimba&type=images`, { signal: AbortSignal.timeout(20000) })).json();
        const res = (j.results || []).filter((x) => x && x.thumbnail).slice(0, 60);
        const orig = (t) => { try { const u = new URL(t, "http://x"); return /\/proxy\/image$/.test(u.pathname) ? u.searchParams.get("url") : u.href; } catch { return ""; } };
        const urls = res.map((x) => orig(x.thumbnail));
        const post = async (path, b) => { const t0 = Date.now(); const r = await (await fetch(V + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(15000) })).json(); return [r, Date.now() - t0]; };
        const [a, cold] = await post("/score", { q: "kalimba", urls, budget: 3 });
        const [, warm] = await post("/score", { q: "kalimba", urls, budget: 3 });
        const [nr, nearMs] = await post("/near", { url: urls[0], urls: urls.slice(1) });
        const ps = (a.p || []).map((p, i) => [p, res[i].title || ""]).filter(([p]) => typeof p === "number").sort((x, y) => x[0] - y[0]);
        const med = ps.length ? ps[Math.floor(ps.length / 2)][0] : 0, low = Math.min(0.02, med * 0.05);
        const folded = ps.filter(([p]) => p < low);
        rows.push(["Image AI speed (60 pictures)", cold <= 2500 && warm <= 300 ? "PASS" : "INFO", `first ${cold} ms (fetch + AI), again ${warm} ms, alike ${nearMs} ms; ${ps.length}/${urls.length} pictures read`]);
        rows.push(["Image AI on 'kalimba'", folded.length <= ps.length / 3 ? "PASS" : "INFO", `median ${med.toFixed(4)}, folds ${folded.length}: ${folded.slice(0, 4).map(([p, t]) => `${p.toFixed(5)} ${t.slice(0, 32)}`).join(" | ") || "none"}; top ${ps.slice(-2).map(([p, t]) => `${p.toFixed(3)} ${t.slice(0, 24)}`).join(" | ")}`]);
        if (!Array.isArray(nr.sim)) rows.push(["Image AI alike", "FAIL", "no answer"]);
      } catch (e) { rows.push(["Image AI test search", "INFO", `could not run: ${String(e && e.message || e).slice(0, 60)}`]); }
    }
  }
  // Answer AI in degoog's search step (results hook): every result scored, best sentence for the featured snippet
  try {
    const t0 = Date.now();
    const j = await (await fetch(`http://127.0.0.1:${PORT}/api/search?q=${encodeURIComponent("how tall is the eiffel tower")}`, { signal: AbortSignal.timeout(20000) })).json();
    const ms = Date.now() - t0, rs = j.results || [];
    const scored = rs.filter((r) => typeof r.ctRel === "number"), best = rs.map((r) => r.ctBest).filter(Boolean).sort((a, b) => b.p - a.p)[0];
    if (!j.ctAi) rows.push(["Answer AI in search", "INFO", "not active yet (AI still starting, or degoog's search code changed and the hook isn't in)"]);
    else rows.push(["Answer AI in search", "PASS", `${scored.length}/${rs.length} results scored, search ${ms} ms; low ${scored.filter((r) => r.ctRel < 0.02).length}; snippet ${best ? `${best.p.toFixed(2)} "${best.s.slice(0, 60)}"` : "none"}`]);
  } catch (e) { rows.push(["Answer AI in search", "INFO", `could not run: ${String(e && e.message || e).slice(0, 60)}`]); }
  // How degoog has been opening on each device (timings the page sent, last 60 loads): median and the slowest load,
  // split into where the time went
  try {
    const list = JSON.parse(fs.readFileSync(`${DIR}/perf.json`, "utf8"));
    const med = (a) => { const b = a.filter((x) => x >= 0).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : -1; };
    for (const dev of ["phone", "pc"]) {
      const L = list.filter((x) => x.dev === dev && x.nav);
      if (!L.length) continue;
      const worst = L.reduce((a, b) => ((b.nav.loaded || 0) > (a.nav.loaded || 0) ? b : a));
      const part = (x) => x ? `wait ${x.wait}, dns ${x.dns}, connect ${x.connect}, tls ${x.tls}, server ${x.server}, download ${x.download}` : "none";
      rows.push([`Page opens (${dev}, ${L.length})`, "INFO", `median ready ${med(L.map((x) => x.nav.ready))} ms, first search ${med(L.map((x) => x.search ? x.search.wait + x.search.total : -1))} ms after open`]);
      rows.push([`  slowest (${dev})`, "INFO", `ready ${worst.nav.ready} ms (${part(worst.nav)}); search: ${part(worst.search)}`]);
    }
  } catch {}
  // Safe Search off on every engine that has it (set by the installer just before the restart)
  let safe = [];
  try {
    const st = JSON.parse(fs.readFileSync(process.env.DEGOOG_PLUGIN_SETTINGS_FILE || "/app/data/plugin-settings.json", "utf8"));
    safe = Object.entries(st).filter(([k, v]) => /-engine$/.test(k) && v && typeof v.safeSearch === "string" && v.safeSearch !== "off").map(([k]) => k.replace(/^degoog-org-official-extensions-/, "").replace(/-engine$/, ""));
  } catch {}
  row("Safe Search off on all engines", safe.length === 0, safe.length ? `still on: ${safe.join(", ")}` : "");

  // AI-image list for the Images tab: first download ~60 s after start
  let n = 0;
  for (let i = 0; i < 12 && !n; i++) { try { n = (JSON.parse(fs.readFileSync(`${DIR}/ai-images.json`, "utf8")).list || []).length; } catch {} if (!n) await sleep(5000); }
  row("AI-image blocklist (Images tab)", n >= 300, n ? `${n} sites` : "");
  // DOI publisher names (Crossref prefix list) and trending names (Wikipedia's most-read articles; first refresh ~2 min after start)
  try { const r = await fetch("https://api.crossref.org/prefixes/10.1016", { headers: { Accept: "application/json", "User-Agent": "degoog-clean-titles/51 (+https://github.com/degoog-org/degoog)" }, signal: AbortSignal.timeout(8000) }); const j = await r.json(); row("DOI publisher names (Crossref)", /elsevier/i.test(String(j.message && j.message.name)), String(j.message && j.message.name || r.status)); } catch (e) { row("DOI publisher names (Crossref)", false, String(e.message || e).slice(0, 60)); }
  let tn = 0;
  for (let i = 0; i < 30 && !tn; i++) { try { tn = (JSON.parse(fs.readFileSync(`${DIR}/trend.json`, "utf8")).w || []).length; } catch {} if (!tn) await sleep(5000); }
  row("Trending names (Wikipedia)", tn >= 100, tn ? `${tn} words` : "no trend.json after 150 s");

  const w = Math.max(...rows.map((r) => r[0].length));
  console.log("");
  for (const [name, st, note] of rows) console.log(`${name.padEnd(w)}  ${st.padEnd(4)}${note ? `  ${note}` : ""}`);
  const bad = rows.filter((r) => r[1] === "FAIL").length;
  console.log(`\n${bad ? `${bad} FAIL` : "All PASS"} (clean-titles self-check)`);
})();
