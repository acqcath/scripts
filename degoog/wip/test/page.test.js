// The built page script (core + script.js) on real recorded results, rendered with degoog 1.2.0's own result
// template (test/fixtures/result.html, degoog-org/degoog e006d50) into a DOM (happy-dom). Checks what the user sees
// once the observer pass ran: copies merged, 2 per site with "N more" folds, dates on the source line.
import { test, expect } from "bun:test";
import { existsSync as __ex } from "node:fs";
const HAS_RECS = __ex(new URL("../rec/ct-recordings.json.gz", import.meta.url)); // recordings are private: kept with the user, not in the repo
import fs from "node:fs";
import zlib from "node:zlib";
import { Window } from "happy-dom";
const REC_FILE = new URL("../rec/ct-recordings.json.gz", import.meta.url);
const HAS_REC = fs.existsSync(REC_FILE); // recordings are private: kept with the user, not in the repo
const REC = HAS_REC ? JSON.parse(zlib.gunzipSync(fs.readFileSync(REC_FILE))) : { searches: [], page: "", css: {} };
const TPL = fs.readFileSync(new URL("./fixtures/result.html", import.meta.url), "utf8");
const IMG_TPL = fs.readFileSync(new URL("./fixtures/image-card.html", import.meta.url), "utf8");
const PSL = fs.readFileSync(new URL("../psl.enc", import.meta.url), "utf8");
const CODE = fs.readFileSync(new URL("../files/ct-page.js", import.meta.url), "utf8");
const { render, ctx } = require("./render.js");

const run = async (q, opts = {}) => {
  const win = new Window({ url: `https://degoog.local/search?q=${encodeURIComponent(q)}${opts.type ? `&type=${opts.type}` : ""}` });
  const { document } = win;
  document.body.innerHTML = '<div id="at-a-glance"></div><div id="results-list"></div>';
  if (!opts.noPsl) win.CT_PSL = PSL;
  if (opts.sites) win.localStorage.setItem("ct-sites", JSON.stringify(opts.sites));
  for (const [k, v] of Object.entries(opts.store || {})) win.localStorage.setItem(k, v);
  // The server: every bridge call fails, unless the test answers a route (opts.bridge[route] = {data, delay ms})
  win.fetch = async (url, init) => {
    // degoog's Settings routes (site choices): opts.settings(url, body) -> {status, json}
    if (String(url).startsWith("/api/settings/")) {
      const a = opts.settings ? opts.settings(String(url), init && init.body ? JSON.parse(init.body) : null, init && init.headers) : { status: 404 };
      return new win.Response(JSON.stringify(a.json || {}), { status: a.status || 200, headers: { "Content-Type": "application/json" } });
    }
    // The News search (Top stories): opts.news = {delay}, answered with the recorded news results for this search
    if (/^\/api\/search\?.*type=news/.test(String(url))) {
      const nr = opts.news && REC.searches.find((x) => x.type === "news" && q.includes(x.q));
      if (!nr) return new win.Response("{}", { status: 404 });
      await new Promise((r) => setTimeout(r, opts.news.delay || 0));
      return new win.Response(JSON.stringify({ results: nr.results }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // The Images search (images row): opts.images = {delay}, answered with the recorded image results for this search
    if (/^\/api\/search\?.*type=images/.test(String(url))) {
      if (opts.imgCalls) opts.imgCalls.push(String(url));
      const ir = opts.images && REC.searches.find((x) => x.type === "images" && q.includes(x.q));
      if (!ir) return new win.Response("{}", { status: 404 });
      await new Promise((r) => setTimeout(r, opts.images.delay || 0));
      return new win.Response(JSON.stringify({ results: ir.results }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const query = init && init.body ? JSON.parse(init.body).query : "";
    const m = /^!cleantitles bridge (\w+)/.exec(query);
    // Another command (a card the page asks for, like "!weather pittsburgh"): opts.command = {html, delay}
    if (!m && opts.command && query.startsWith("!")) {
      await new Promise((r) => setTimeout(r, opts.command.delay || 0));
      return new win.Response(JSON.stringify({ html: opts.command.html }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (m && opts.calls) opts.calls.push({ route: m[1], params: new URLSearchParams(query.replace(/^!cleantitles bridge \w+ ?/, "")) });
    const a = m && opts.bridge && opts.bridge[m[1]];
    if (!a) return new win.Response("{}", { status: 404 });
    await new Promise((r) => setTimeout(r, a.delay || 0));
    const html = JSON.stringify(a.data).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return new win.Response(JSON.stringify({ html }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  win.IntersectionObserver = class { observe() {} unobserve() {} };
  const errors = [];
  win.console.error = (...a) => errors.push(a.join(" "));
  win.console.warn = (...a) => errors.push(a.join(" "));
  win.addEventListener("error", (e) => errors.push(String(e.error && e.error.stack || e.message)));
  // Run it against this window's globals (document, location...), not the test runner's. MutationObserver is
  // replaced by one the test fires itself: browsers deliver records as a microtask right after the DOM change
  // (before paint), while happy-dom uses timers that sometimes never fire here
  const mos = [];
  class MO { constructor(cb) { this.cb = cb; mos.push(this); } observe() {} disconnect() {} takeRecords() { return []; } }
  const scope = new Proxy(win, {
    has: () => true,
    get: (t, k) => {
      if (k === "MutationObserver") return MO;
      if (k === Symbol.unscopables) return undefined;
      if (!(k in t)) return globalThis[k];
      const v = Reflect.get(t, k);
      return typeof v === "function" && typeof k === "string" && /^[a-z]/.test(k) ? v.bind(t) : v;
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  globalThis.__ctAIW = win.__ctAIW = opts.aiw ? new Map(opts.aiw) : new Map(); // the page reads globalThis (the window, in a browser)
  new Function("scope", `with (scope) {\nconst __PLUGIN_ID__="clean-titles";\n${CODE}\n}`)(scope);
  const fire = (nodes) => { for (const m of mos) m.cb([{ type: "childList", addedNodes: nodes }], m); };
  const res = opts.res || REC.searches.find((x) => x.q === q && (opts.type ? x.type === opts.type : !x.type || x.type === "web")).results;
  // The page script starts at page load, before any results (as in degoog: results come from a later fetch)
  if (document.readyState === "loading") await new Promise((r) => document.addEventListener("DOMContentLoaded", r, { once: true }));
  await new Promise((r) => setTimeout(r, opts.engines || 0)); // the engines' time, while early answers arrive
  const list = document.getElementById("results-list");
  // Images tab: degoog's own image-card.html in a .image-card each (render-media.tsx _mediaCard), host without www.
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  list.innerHTML = opts.type === "videos" ? `<div class="video-grid">${res.map((r, i) => `<div class="video-card" data-idx="${i}"><span class="video-title">${r.title}</span><span class="video-source">${host(r.url)}</span></div>`).join("")}</div>`
    : opts.type === "images"
    ? res.map((r, i) => `<div class="image-card" data-idx="${i}">${render(IMG_TPL, { title: r.title, url: r.url, thumbnail_url: r.thumbnail || "", fallback_url: r.thumbnail || "", hostname: (() => { try { return new URL(r.url).hostname.replace(/^www\./, ""); } catch { return ""; } })() })}</div>`).join("")
    : res.map((r, i) => render(TPL, ctx(r, i))).join("");
  fire([...list.children]);
  const items = [...document.querySelectorAll("#results-list .result-item")];
  const visible = items.filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped"));
  return { win, document, res, items, visible, errors, fire, folds: [...document.querySelectorAll(".ct-fold")] };
};

(HAS_RECS ? test : test.skip)("page: real 'how to reset airpods' shows each document once and at most 2 per site", async () => {
  const { visible, errors } = await run("how to reset airpods");
  expect(errors).toEqual([]);
  const urls = visible.map((el) => el.querySelector("a.result-title").href);
  expect(urls).not.toContain("https://support.apple.com/en-gb/118531");
  expect(urls).not.toContain("https://m.youtube.com/watch?v=D0LZz3Zxk00");
  const per = {};
  for (const u of urls) { const h = new URL(u).hostname.split(".").slice(-2).join("."); per[h] = (per[h] || 0) + 1; }
  expect(Math.max(...Object.values(per))).toBeLessThanOrEqual(2);
});
(HAS_RECS ? test : test.skip)("page: real 'is windows 10 supported' folds the 3rd+ microsoft.com results under the 2nd; tap opens in place", async () => {
  const { folds, document } = await run("is windows 10 supported");
  expect(folds.length).toBe(1);
  const f = folds[0];
  expect(f.textContent).toBe("6 more from microsoft.com⌄");
  expect(f.previousElementSibling.querySelector("a.result-title").href).toBe("https://www.microsoft.com/en-us/windows/end-of-support");
  f.querySelector("button").click();
  expect(document.querySelectorAll(".ct-fold").length).toBe(0);
  const after = [...document.querySelectorAll("#results-list .result-item")];
  const i = after.findIndex((el) => el.querySelector("a.result-title").href === "https://www.microsoft.com/en-us/windows/end-of-support");
  const next6 = after.slice(i + 1, i + 7);
  expect(next6.every((el) => el.style.display === "" && /microsoft\.com/.test(new URL(el.querySelector("a.result-title").href).hostname))).toBe(true);
});
(HAS_RECS ? test : test.skip)("page: dates move from the snippet to the source line; snippet text keeps no leading date", async () => {
  const { items, res } = await run("steelers");
  let moved = 0;
  items.forEach((el, i) => {
    const d = el.querySelector(".result-url-row .ct-date");
    if (res[i].publishedAt && el.style.display !== "none") { expect(d).not.toBeNull(); moved++; }
    expect(el.querySelector(".result-snippet .result-date")).toBeNull();
  });
  expect(moved).toBeGreaterThan(0);
});
(HAS_RECS ? test : test.skip)("page: a search naming the site keeps all its results (mdn array map)", async () => {
  const { visible, folds } = await run("mdn array map");
  expect(visible.filter((el) => /developer\.mozilla\.org/.test(el.querySelector("a.result-title").href)).length).toBeGreaterThan(2);
  expect(folds.some((f) => /mozilla/.test(f.textContent))).toBe(false);
});
(HAS_RECS ? test : test.skip)("page: site prefs from the server (Hide, Prefer) apply before paint", async () => {
  const { visible } = await run("how to reset airpods", { sites: { "youtube.com": "hide", "wikihow.com": "prefer" } });
  expect(new URL(visible[0].querySelector("a.result-title").href).hostname).toBe("www.wikihow.com");
  expect(visible.some((el) => /youtube/.test(el.querySelector("a.result-title").href))).toBe(false);
});
(HAS_RECS ? test : test.skip)("page: public suffix file missing -> still works, sites = host names", async () => {
  const { visible } = await run("how to reset airpods", { noPsl: true });
  expect(visible.length).toBeGreaterThan(10);
});
(HAS_RECS ? test : test.skip)("page: arXiv copies merge into one result with version links", async () => {
  const { visible, document } = await run("attention is all you need pdf");
  const ax = visible.filter((el) => /arxiv\.org/.test(el.querySelector("a.result-title").href));
  expect(ax.length).toBe(1);
  expect(document.querySelectorAll(".ct-alts").length).toBeGreaterThan(0);
});
(HAS_RECS ? test : test.skip)("page: all recorded web searches replay without a single page-script error; merges and folds counted", async () => {
  const rows = [];
  for (const s of REC.searches.filter((x) => !x.type || x.type === "web")) {
    const { win, items, visible, folds, errors: errs } = await run(s.q);
    // safe() reports every step's error through console.error / console.warn
    const dups = items.filter((el) => el.dataset.ctDup).length, capped = items.filter((el) => el.dataset.ctCap).length;
    rows.push(`${s.q.padEnd(34)} ${String(items.length).padStart(2)} in · ${String(dups).padStart(2)} merged · ${String(visible.length).padStart(2)} shown · ${folds.length} fold lines`);
    win.close();
    expect(errs).toEqual([]);
  }
  if (process.env.CT_REPORT) console.log(rows.join("\n"));
  expect(rows.length).toBe(50);
}, 60000);

// Early answers: in hand when results arrive -> drawn in the same pass; late -> never drawn
const FIX = { fix: null, words: [], dym: "pyhton tutorial", related: ["python download", "python tutorial"] };
const QS = { q: ["What is Python used for?", "Is Python hard to learn?"] };
(HAS_RECS ? test : test.skip)("page: typo line, related searches and People also ask drawn with the results when their answers came first", async () => {
  const { document, win } = await run("python", { engines: 40, bridge: { fix: { data: FIX, delay: 5 }, qs: { data: QS, delay: 5 } } });
  expect(document.getElementById("ct-related")).not.toBeNull();
  expect(document.getElementById("ct-qa")).not.toBeNull();
  expect(document.getElementById("ct-qa").querySelectorAll("details").length).toBe(2);
  win.close();
});
(HAS_RECS ? test : test.skip)("page: the same answers arriving after the results are dropped (nothing inserted later)", async () => {
  const { document, win, fire } = await run("python", { engines: 0, bridge: { fix: { data: FIX, delay: 60 }, qs: { data: QS, delay: 60 } } });
  await new Promise((r) => setTimeout(r, 120));
  const d = document.createElement("div");
  document.getElementById("results-list").append(d);
  fire([d]); // another pass after they came
  expect(document.getElementById("ct-related")).toBeNull();
  expect(document.getElementById("ct-qa")).toBeNull();
  expect(document.getElementById("ct-fix")).toBeNull();
  win.close();
});
(HAS_RECS ? test : test.skip)("page: a command card (weather at the end of the search) goes in only before the results are drawn", async () => {
  const card = { html: '<div class="wx">Pittsburgh 41°F</div>' };
  const a = await run("weather pittsburgh", { engines: 40, command: { ...card, delay: 5 } });
  expect(a.document.querySelector("#at-a-glance .ct-card")).not.toBeNull();
  a.win.close();
  const b = await run("weather pittsburgh", { engines: 0, command: { ...card, delay: 60 } });
  await new Promise((r) => setTimeout(r, 120));
  const d = b.document.createElement("div");
  b.document.getElementById("results-list").append(d);
  b.fire([d]);
  expect(!!b.document.querySelector("#at-a-glance .ct-card")).toBe(false);
  b.win.close();
});

(HAS_RECS ? test : test.skip)("page: Top stories only for news-like results, drawn before paint, never inserted later", async () => {
  // Not news-like (v49's rule fired here): nothing remembered, no News search
  const calm = await run("time in tokyo", { news: {} });
  expect(calm.win.localStorage.getItem("ct-newsy")).toBeNull();
  // First visit to a news-like search: no News search was started, so nothing is added; the search is remembered
  const a = await run("steelers", { news: {} });
  expect(a.errors).toEqual([]);
  expect(!!a.document.querySelector(".ct-news")).toBe(false);
  const store = { "ct-newsy": a.win.localStorage.getItem("ct-newsy") };
  expect(store["ct-newsy"]).not.toContain("steelers"); // a hash, not the words
  // Next visit: the News search starts at page load; in hand before the results -> drawn in the same pass
  const b = await run("steelers", { news: { delay: 0 }, store, engines: 20 });
  expect(b.errors).toEqual([]);
  const box = b.document.querySelector(".ct-news");
  expect(box).not.toBeNull();
  expect(box.previousElementSibling.classList.contains("result-item")).toBe(true);
  // News answer slower than the engines: dropped, and nothing appears after the results are on screen
  const c = await run("steelers", { news: { delay: 60 }, store, engines: 0 });
  await new Promise((r) => setTimeout(r, 120));
  c.fire([]);
  expect(!!c.document.querySelector(".ct-news")).toBe(false);
});

(HAS_RECS ? test : test.skip)("page: News tab layout is decided before paint; recorded News pictures (upgradable hosts) keep the banner", async () => {
  for (const q of ["steelers", "nvidia"]) {
    const { items, errors } = await run(q, { type: "news" });
    expect(errors).toEqual([]);
    expect(items.length).toBeGreaterThan(40);
    expect(items.filter((el) => el.classList.contains("ct-lowres")).length).toBe(0);
  }
});

(HAS_RECS ? test : test.skip)("page: site choices in the result menu: one group of four, saved in degoog's lists, applied on the page", async () => {
  const calls = [];
  const lists = { domainBlockList: "example.org\nyoutube.com", domainScoreList: "" };
  const settings = (url, body, headers) => { calls.push([url, body, headers && headers["x-settings-token"]]); return url.endsWith("/general") ? { json: lists } : { json: { ok: true } }; };
  const { document, win, errors } = await run("how to reset airpods", { settings });
  win.sessionStorage.setItem("degoog-settings-token", "tok");
  expect(errors).toEqual([]);
  const yt = [...document.querySelectorAll("#results-list .result-item")].find((el) => /youtube\.com/.test(el.querySelector(".result-actions")?.dataset.host || ""));
  const seg = yt.querySelector(".result-actions-menu .ct-seg");
  expect([...seg.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Prefer", "Normal", "Lower", "Hide"]);
  expect(seg.querySelector('[aria-pressed="true"]').textContent).toBe("Normal");
  // Hide: degoog's block list gets the site (not the subdomain); its results leave this page
  seg.querySelector('[data-ct-site="hide"]').click();
  await new Promise((r) => setTimeout(r, 20));
  expect(calls.at(-1)).toEqual(["/api/settings/domain-action", { kind: "block", source: "youtube.com" }, "tok"]);
  const ytRows = [...document.querySelectorAll("#results-list .result-item")].filter((el) => /youtube\.com/.test(el.querySelector(".result-actions")?.dataset.host || ""));
  expect(ytRows.every((el) => el.style.display === "none")).toBe(true);
  expect(JSON.parse(win.localStorage.getItem("ct-sites"))["youtube.com"]).toBe("hide");
  // Back to Prefer: the block line goes (other lines kept), then a +score line
  calls.length = 0;
  seg.querySelector('[data-ct-site="prefer"]').click();
  await new Promise((r) => setTimeout(r, 20));
  expect(calls.map((c) => c[0])).toEqual(["/api/settings/general", "/api/settings/field", "/api/settings/domain-action"]);
  expect(calls[1][1]).toEqual({ key: "domainBlockList", value: "example.org" });
  expect(calls[2][1]).toEqual({ kind: "score", source: "youtube.com", score: 40 });
  // Not signed in to Settings: nothing changes, the menu says why
  const b = await run("how to reset airpods", { settings: () => ({ status: 401 }) });
  const s2 = b.document.querySelector(".result-actions-menu .ct-seg");
  s2.querySelector('[data-ct-site="lower"]').click();
  await new Promise((r) => setTimeout(r, 20));
  expect(s2.parentElement.querySelector(".ct-seg-note").textContent).toBe("Sign in to Settings first");
  expect(b.win.localStorage.getItem("ct-sites")).toBeNull();
});
(HAS_RECS ? test : test.skip)("page: un-hiding never writes back a block list degoog left out for being too long", async () => {
  const calls = [];
  const settings = (url, body) => { calls.push(url); return url.endsWith("/general") ? { json: { domainBlockList: "", degoogOversizedFields: { domainBlockList: { chars: 70000, lines: 5000 } } } } : { json: { ok: true } }; };
  const { document } = await run("how to reset airpods", { settings, sites: { "youtube.com": "hide" } });
  const yt = [...document.querySelectorAll("#results-list .result-item")].find((el) => /youtube\.com/.test(el.querySelector(".result-actions")?.dataset.host || ""));
  const seg = yt.querySelector(".result-actions-menu .ct-seg");
  expect(seg.querySelector('[aria-pressed="true"]').textContent).toBe("Hide");
  seg.querySelector('[data-ct-site="normal"]').click();
  await new Promise((r) => setTimeout(r, 20));
  expect(calls).toEqual(["/api/settings/general"]);
  expect(seg.parentElement.querySelector(".ct-seg-note").textContent).toMatch(/too long/);
});

(HAS_RECS ? test : test.skip)("page: anti-SEO signs go to the server once per search, after the pass; auto-lowered sites say so in the menu", async () => {
  const calls = [];
  const { document, errors } = await run("mdn array map", { calls, store: { "ct-sites-auto": JSON.stringify({ auto: ["w3schools.com"], seo: true }) }, sites: { "w3schools.com": "lower" } });
  expect(calls.filter((c) => c.route === "seo").length).toBe(0); // not inside the pass
  await new Promise((r) => setTimeout(r, 10));
  const seo = calls.filter((c) => c.route === "seo");
  expect(seo.length).toBe(1);
  const body = JSON.parse(seo[0].params.get("__body"));
  expect(body.hit["mdn2.netlify.app"]).toEqual(["copy"]);
  expect(body.seen).toContain("mozilla.org");
  const w3 = [...document.querySelectorAll(".result-item")].find((el) => (el.querySelector(".result-actions")?.dataset.host || "").includes("w3schools"));
  expect(w3 && w3.querySelector(".ct-seg-note")?.textContent).toBe("Lowered automatically (SEO signs). Your choice here wins.");
  expect(errors).toEqual([]);
  // Checks off in Settings: nothing sent
  const c2 = [];
  await run("mdn array map", { calls: c2, store: { "ct-sites-auto": JSON.stringify({ auto: [], seo: false }) } });
  await new Promise((r) => setTimeout(r, 10));
  expect(c2.filter((c) => c.route === "seo").length).toBe(0);
});

(HAS_RECS ? test : test.skip)("page: real '$AAPL' results from wsj.com carry the Paywall word on the source line, others don't", async () => {
  const { items, errors } = await run("$AAPL");
  const host = (el) => { try { return new URL(el.querySelector("a.result-title").href).hostname; } catch { return ""; } };
  const tagged = items.filter((el) => el.querySelector(".result-url-row .ct-paywall"));
  expect(tagged.length).toBeGreaterThan(0);
  for (const el of tagged) expect(/(^|\.)(wsj|marketwatch)\.com$/.test(host(el))).toBe(true);
  expect(tagged[0].querySelector(".ct-paywall").textContent).toBe("Paywall");
  expect(items.filter((el) => el.style.display !== "none" && /(^|\.)wsj\.com$/.test(host(el))).every((el) => el.querySelector(".ct-paywall"))).toBe(true);
  expect(errors).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: Images tab hides AI-image sites from the server's list before paint; the Web tab never uses it", async () => {
  const store = { "ct-aiimg": JSON.stringify({ v: "a1", list: ["canva.com", "magnific.com"] }) };
  const calls = [];
  const { document, errors } = await run("eiffel tower", { type: "images", store, calls });
  const cards = [...document.querySelectorAll(".image-card")];
  const src = (c) => c.querySelector(".image-source").textContent;
  expect(cards.filter((c) => c.style.display === "none").map(src).sort()).toEqual(cards.map(src).filter((h) => /(^|\.)(canva|magnific)\.com$/.test(h)).sort());
  expect(cards.some((c) => src(c) === "unsplash.com" && c.style.display !== "none")).toBe(true);
  expect(calls.find((c) => c.route === "aiimg").params.get("v")).toBe("a1");
  expect(errors).toEqual([]);
  const w = await run("how to reset airpods", { store, calls: [] });
  expect(w.errors).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: Images tab folds images with none of the search's words ('graphic' doesn't bring porn in); on-topic ones stay", async () => {
  const R = (title, url) => ({ title, url, thumbnail: "" });
  const res = [
    R("Inductive Sensor Proximity Sensor", "https://favpng.com/a"), R("Photo computer graphic video card", "https://www.freepik.com/b"),
    R("Researchers have created a bendable transparent display", "https://newatlas.com/c"), R("Proximity Sensor - Sensor Clipart", "https://flyclipart.com/d"),
    R("Gigi Rivera Cum Drenched Bukkake", "https://ge.xhamster.desi/e"), R("Cum drenched Foto Porno", "https://es.eporner.com/f"),
    R("A semi-transparent Sony camera", "https://petapixel.com/g"), R("Q26 Clear Object Detection Sensor", "https://www.bannerengineering.com/h"),
  ];
  const { document, errors } = await run("sensors graphic transparent", { type: "images", res });
  const cards = [...document.querySelectorAll(".image-card")];
  const hidden = cards.filter((c) => c.style.display === "none").map((c) => c.querySelector(".image-source").textContent).sort();
  expect(hidden).toEqual(["es.eporner.com", "ge.xhamster.desi"]);
  const b = document.querySelector(".ct-fold-img .ct-fold-b");
  expect(b.textContent).toContain("2 unrelated images");
  b.click();
  expect(cards.every((c) => c.style.display !== "none")).toBe(true);
  expect(document.querySelector(".ct-fold-img")).toBe(null);
  expect(errors).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: Videos tab folds videos with none of the search's words, same rule as Images", async () => {
  const R = (title, url) => ({ title, url });
  const res = [R("How ultrasonic sensors work", "https://youtube.com/a"), R("Transparent graphic design tutorial", "https://vimeo.com/b"),
    R("Hot cum drenched compilation video", "https://xvideos.com/c"), R("Sensor basics explained simply", "https://youtube.com/d")];
  const { document, errors } = await run("sensors graphic transparent", { type: "videos", res });
  const hidden = [...document.querySelectorAll(".video-card")].filter((c) => c.style.display === "none").map((c) => c.querySelector(".video-source").textContent);
  expect(hidden).toEqual(["xvideos.com"]);
  expect(document.querySelector(".ct-fold-img .ct-fold-b").textContent).toContain("1 unrelated video");
  expect(errors).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: image preview: picture and title open the page; 'more images' are the ones like the opened image, folded ones never", async () => {
  const R = (title, url, th) => ({ title, url, thumbnail: th });
  const res = [
    R("Fame FK-1 Mahogany Kalimba 17 keys", "https://musicstore.de/a", "/t/a"), R("Download Big Black Cock", "https://pngkit.com/b", "/t/b"),
    R("50+ Easy Kalimba Songs For Beginners", "https://carvedculture.com/c", "/t/c"), R("Kalimba 17 keys mahogany wood thumb piano", "https://amazon.com/d", "/t/d"),
    R("KALIMBA or calimba - Musical Instrument", "https://kaypacha.com.ar/e", "/t/e"), R("Mahogany 17 keys kalimba with hammer", "https://seeds.com/f", "/t/f"),
  ];
  const { document, win, fire, errors } = await run("kalimba", { type: "images", res });
  const cards = [...document.querySelectorAll(".image-card")];
  cards[0].classList.add("selected");
  const panel = document.createElement("div");
  panel.innerHTML = `<img id="media-preview-img" src="/big"><div id="media-preview-info"><h3 class="media-preview-title">Fame FK-1 Mahogany Kalimba 17 keys</h3><a class="media-preview-link" href="https://musicstore.de/a">musicstore.de</a></div><div id="media-preview-more"><div class="media-preview-more-grid">${cards.slice(1).map((c) => `<button class="media-preview-more-item"><img src="${c.querySelector("img").getAttribute("src")}"></button>`).join("")}</div></div>`;
  document.body.append(panel);
  fire([panel]);
  await new Promise((r) => setTimeout(r, 30)); // the AI isn't there (bridge fails): words order
  const strip = [...document.querySelectorAll("#media-preview-more .media-preview-more-img")].map((i) => i.getAttribute("src"));
  expect(strip.slice(0, 2).sort()).toEqual(["/t/d", "/t/f"]); // same 17 keys / mahogany first
  expect(strip).not.toContain("/t/b"); // folded (no "kalimba") never shown
  const a = document.querySelector("#media-preview-info .media-preview-title a");
  expect(a.getAttribute("href")).toBe("https://musicstore.de/a");
  expect(errors).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: image AI folds pictures that don't show the search (even titled with it), brings back ones the words rule folded, orders related images by look", async () => {
  const R = (title, url, th) => ({ title, url, thumbnail: th });
  const res = [
    R("Kalimba 17 keys mahogany", "https://a.com/1", "/t/1"), R("Kalimba thumb piano beginner", "https://b.com/2", "/t/2"),
    R("kalimba kalimba kalimba hot pics", "https://spam.com/3", "/t/3"), R("Kalimba songs for beginners", "https://c.com/4", "/t/4"),
    R("IMG 2231 wooden instrument photo", "https://d.com/5", "/t/5"), R("Kalimba with hammer and bag", "https://e.com/6", "/t/6"),
    R("Kalimba tuning chart", "https://f.com/7", "/t/7"),
  ];
  const p = [0.31, 0.22, 0.0002, 0.18, 0.4, 0.27, 0.12];
  const { document, fire, errors } = await run("kalimba", { type: "images", res, bridge: { vis: { data: { p }, delay: 5 }, near: { data: { sim: [0.9, 0.5, 0.8, 0.1, 0.2] }, delay: 5 } } });
  const cards = [...document.querySelectorAll(".image-card")];
  expect(cards.every((c) => c.classList.contains("ct-vpend") || c.style.display === "none")).toBe(true); // waiting, picture hidden
  await new Promise((r) => setTimeout(r, 40));
  const src = (c) => c.querySelector(".image-source").textContent;
  expect(cards.filter((c) => c.style.display === "none").map(src)).toEqual(["spam.com"]); // its title says kalimba, its picture doesn't
  expect(cards.find((c) => src(c) === "d.com").style.display).toBe(""); // words rule folded it, the AI sees a kalimba
  expect(cards.some((c) => c.classList.contains("ct-vpend"))).toBe(false);
  expect(document.querySelector(".ct-fold-img .ct-fold-b").textContent).toContain("1 unrelated image");
  cards[0].classList.add("selected");
  const panel = document.createElement("div");
  panel.innerHTML = `<div id="media-preview-info"></div><div id="media-preview-more"><div class="media-preview-more-grid"><button class="media-preview-more-item"><img src="/x"></button></div></div>`;
  document.body.append(panel);
  fire([panel]);
  await new Promise((r) => setTimeout(r, 30));
  const strip = [...document.querySelectorAll("#media-preview-more .media-preview-more-img")].map((i) => i.getAttribute("src"));
  expect(strip.slice(0, 3)).toEqual(["/t/2", "/t/5", "/t/4"]); // most alike first (by the AI's similarity)
  expect(strip).not.toContain("/t/3");
  expect(errors).toEqual([]);
});

const aiKeyT = (u) => { try { const x = new URL(u); return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/$/, "") + x.search).toLowerCase(); } catch { return u; } };
(HAS_RECS ? test : test.skip)("page: answer AI's verdicts (from the server, in degoog's search answer) decide relevance and the featured snippet", async () => {
  const rec = REC.searches.find((x) => x.q === "how tall is the eiffel tower" && !x.type).results;
  const off = rec[5].url;
  const best = { s: "The Eiffel Tower is 330 metres (1,083 ft) tall, about the same height as an 81-storey building.", p: 0.93 };
  const aiw = rec.map((r, i) => [aiKeyT(r.url), { p: r.url === off ? 0.001 : 0.6, best: i === 2 ? best : i === 0 ? { s: "Visit the tower every day of the year.", p: 0.2 } : null }]);
  const { document, items, errors, win } = await run("how tall is the eiffel tower", { aiw, engines: 40 });
  const hidden = items.filter((el) => el.dataset.ctUnrel).map((el) => el.dataset.resultUrl || el.querySelector("a.result-title").href);
  expect(hidden.map(aiKeyT)).toEqual([aiKeyT(off)]); // only the one the AI scored as off-topic folds
  const card = document.querySelector("#at-a-glance .ct-ans");
  expect(card && card.textContent).toContain("330 metres"); // the AI's best-answering sentence, not the word rule's pick
  expect(errors).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: AI snippet on a search not worded as a question only when the AI is sure (>= 0.8)", async () => {
  const rec = REC.searches.find((x) => x.q === "golden gate bridge" && !x.type).results;
  const mk = (p) => rec.map((r, i) => [aiKeyT(r.url), { p: 0.6, best: i === 1 ? { s: "The Golden Gate Bridge is a suspension bridge spanning the Golden Gate strait in San Francisco.", p } : null }]);
  let { document } = await run("golden gate bridge", { aiw: mk(0.92), engines: 40 });
  expect(document.querySelector("#at-a-glance .ct-ans")?.textContent || "").toContain("suspension bridge spanning");
  ({ document } = await run("golden gate bridge", { aiw: mk(0.6), engines: 40 }));
  expect(document.querySelector("#at-a-glance .ct-ans")?.textContent || "").not.toContain("suspension bridge spanning");
});

(HAS_RECS ? test : test.skip)("page: local answer card is in the panel area in the same pass as the results; back after degoog clears it; none on other searches", async () => {
  const { document, win, fire, errors } = await run("5 mi in km");
  const g = document.getElementById("at-a-glance");
  const card = g.querySelector(".ct-ans");
  expect(card && card.querySelector(".ct-ans-value").textContent).toBe("8.04672 km");
  expect(card.querySelector(".ct-ans-label").textContent).toContain("Unit converter");
  expect(card.dataset.copy).toBe("8.04672");
  expect(g.firstElementChild).toBe(card);
  // degoog clears the panel area at the start of each search: the card is put back in the same pass
  g.innerHTML = "";
  fire([]);
  expect(g.querySelector(".ct-ans .ct-ans-value").textContent).toBe("8.04672 km");
  // Pattern answer: a blue title link
  const p = await run("CVE-2021-44228");
  expect(p.document.querySelector("#at-a-glance .ct-ans a.ct-ans-title").getAttribute("href")).toBe("https://nvd.nist.gov/vuln/detail/CVE-2021-44228");
  const n = await run("how to reset airpods");
  expect(!!n.document.querySelector(".ct-ans")).toBe(false);
  // Tap copies and says so in the label line
  let copied = "";
  win.navigator.clipboard.writeText = async (t) => { copied = t; };
  g.querySelector(".ct-ans .ct-ans-value").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 5));
  expect(copied).toBe("8.04672");
  expect(g.querySelector(".ct-ans").classList.contains("ct-copied")).toBe(true);
  expect(errors).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: AI spot kept at its final size before the results on AI-worded searches; ai-summary's panel laid over it; failure says so in place", async () => {
  const store = { "ct-sites-auto": JSON.stringify({ auto: [], seo: false, ai: { on: true } }) };
  const { document, fire, errors } = await run("why is the sky blue", { store });
  const g = document.getElementById("at-a-glance");
  expect(g.firstElementChild.className).toBe("ct-ai");
  expect(g.querySelectorAll(".ct-ai .ct-ai-line").length).toBe(3);
  expect(g.querySelector(".ct-ai-label").textContent).toBe("✦ AI summary");
  // degoog places the panel after the results: first panel clears the area (search-utils _placeGlancePanel)
  const panel = () => { const w = document.createElement("div"); w.className = "results-slot-panel degoog-panel"; w.setAttribute("data-slot-order", "0"); w.innerHTML = '<div class="results-slot-panel-body"><div class="glance-ai" data-stream="1"><div class="glance-ai-summary-wrap"><div class="glance-ai-body glance-ai-body--clamped"><div class="glance-ai-stream" data-state="pending"></div></div><button class="glance-ai-expand">Read more</button></div></div></div>'; return w; };
  g.innerHTML = "";
  const w = panel();
  g.append(w);
  fire([w]);
  expect([...g.children].some((c) => c.classList.contains("ct-ai"))).toBe(true);
  expect(w.classList.contains("ct-ai-panel")).toBe(true);
  expect(w.style.display).toBe("");
  // degoog's sweep at the end removes what it didn't place (our spot): put back in the same pass
  g.querySelector(".ct-ai").remove();
  fire([]);
  expect([...g.children].some((c) => c.classList.contains("ct-ai"))).toBe(true);
  // The answer fails: same spot says so
  w.querySelector(".glance-ai-stream").dataset.state = "error";
  fire([]);
  expect(g.querySelector(".ct-ai").classList.contains("ct-ai-fail")).toBe(true);
  expect(errors).toEqual([]);
  // A how-to search: no spot, and ai-summary's panel is never drawn
  const h = await run("how to reset airpods", { store });
  const hg = h.document.getElementById("at-a-glance");
  expect(hg.querySelector(".ct-ai")).toBeNull();
  const w2 = panel();
  hg.append(w2);
  h.fire([w2]);
  expect(w2.style.display).toBe("none");
  // ai-summary not set up: nothing reserved even on an AI-worded search
  const off = await run("why is the sky blue");
  expect(off.document.querySelector(".ct-ai")).toBeNull();
  // ⌄ opens it (user's tap): ai-summary's own read-more is pressed
  const o = await run("iphone 16 vs iphone 17", { store });
  const og = o.document.getElementById("at-a-glance");
  const w3 = panel(); let pressed = 0; w3.querySelector(".glance-ai-expand").addEventListener("click", () => pressed++);
  og.append(w3); o.fire([w3]);
  og.querySelector(".ct-ai-more").dispatchEvent(new o.win.MouseEvent("click", { bubbles: true }));
  expect(pressed).toBe(1);
  expect(og.classList.contains("ct-ai-opened")).toBe(true);
});

(HAS_RECS ? test : test.skip)("page: endoflife.date answer drawn with the results when in hand; dropped when it comes later", async () => {
  const win = [{ cycle: "10-22h2-w", eol: "2025-10-14", latest: "10.0.19045" }];
  const calls = [];
  const a = await run("is windows 10 supported", { engines: 40, calls, bridge: { eol: { data: { cycles: win }, delay: 5 } } });
  expect(calls.find((c) => c.route === "eol").params.get("p")).toBe("windows");
  expect(a.document.querySelector("#at-a-glance .ct-ans .ct-ans-value").textContent).toBe("No");
  expect(a.document.querySelector("#at-a-glance .ct-ans .ct-ans-l").textContent).toBe("Windows 10 support · endoflife.date");
  const b = await run("is windows 10 supported", { engines: 0, bridge: { eol: { data: { cycles: win }, delay: 60 } } });
  await new Promise((r) => setTimeout(r, 80));
  b.fire([]);
  // The late answer is dropped; what's there is the featured snippet, drawn with the results in the same pass
  expect(b.document.querySelector(".ct-ans")?.dataset.kind ?? "none").toBe("snippet");
  expect(b.document.querySelector(".ct-ans .ct-ans-text").textContent).toContain("Windows 10");
  expect(a.errors.concat(b.errors)).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: Wikidata fact drawn with the results when in hand (pittsburgh population)", async () => {
  const calls = [];
  const d = { label: "Pittsburgh", desc: "city in Pennsylvania", v: [{ amount: "+302971", asOf: "+2020-04-01T00:00:00Z" }] };
  const a = await run("pittsburgh population", { engines: 40, calls, bridge: { wd: { data: { d }, delay: 5 } } });
  const c = calls.find((x) => x.route === "wd");
  expect([c.params.get("f"), c.params.get("s")]).toEqual(["population", "pittsburgh"]);
  expect(a.document.querySelector("#at-a-glance .ct-ans .ct-ans-value").textContent).toBe("302,971");
  expect(a.document.querySelector("#at-a-glance .ct-ans .ct-ans-l").textContent).toBe("Pittsburgh · population · Wikidata");
  expect(a.errors).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: CMU card for '15-213' and '15213' (server says the course exists), none for '15-213 malloc lab'", async () => {
  const c = { course: { name: "Introduction to Computer Systems", units: "12", prereqs: "15-122" }, fces: [{ year: 2026, semester: "spring", instructor: "RAILING, BRIAN", numRespondents: 100, responseRate: "50%", hrsPerWeek: 14.3, rating: [0, 0, 0, 0, 0, 0, 0, 4.3, 4.0], location: "Pittsburgh" }] };
  for (const q of ["15-213", "15213"]) {
    const calls = [];
    const a = await run(q, { engines: 40, calls, bridge: { cmu: { data: { c }, delay: 5 } } });
    expect(calls.find((x) => x.route === "cmu").params.get("id")).toBe("15-213");
    const card = a.document.querySelector("#at-a-glance .ct-ans");
    expect(card.querySelector("a.ct-ans-title").textContent).toBe("15-213 Introduction to Computer Systems");
    expect([...card.querySelectorAll(".ct-ans-detail")[0].children].map((x) => x.textContent)).toEqual(["12 units", "14.3 hrs/wk", "4.0 ★★★★★", "prereq 15-122"]);
    expect(card.querySelector(".ct-stars").style.getPropertyValue("--r")).toBe("4");
    expect(card.querySelectorAll(".ct-fit")[1].textContent).toContain("Spring 2026");
    expect(card.querySelectorAll(".ct-fit")[1].querySelector(".ct-it").textContent).toBe("Brian Railing 4.3");
    expect(a.errors).toEqual([]);
  }
  const calls = [];
  const m = await run("15-213 malloc lab", { engines: 40, calls, bridge: { cmu: { data: { c }, delay: 5 } } });
  expect(calls.some((x) => x.route === "cmu")).toBe(false);
  expect(!!m.document.querySelector(".ct-ans")).toBe(false);
});

(HAS_RECS ? test : test.skip)("page: sports card for 'steelers' drawn with the results when in hand: logos boxed, scores, winner, status", async () => {
  const g = { state: "post", detail: "Final", date: "2026-11-22T18:00Z", league: "NFL", away: { abbr: "CLE", score: "17", record: "3-7", logo: "/api/proxy/image?url=x&sig=1" }, home: { abbr: "PIT", score: "24", winner: true, record: "7-3", logo: "/api/proxy/image?url=y&sig=2" } };
  const calls = [];
  const a = await run("steelers", { engines: 40, calls, bridge: { sports: { data: { g }, delay: 5 } } });
  expect(calls.find((x) => x.route === "sports").params.get("q")).toBe("steelers");
  const card = a.document.querySelector("#at-a-glance .ct-ans[data-kind=sports]");
  expect(card.querySelector(".ct-ans-l").textContent).toBe("NFL · Final");
  expect([...card.querySelectorAll(".ct-sp-team")].map((x) => x.textContent)).toEqual(["CLE17", "PIT24"]);
  expect(card.querySelectorAll(".ct-sp-logo").length).toBe(2);
  expect(card.querySelector(".ct-win .ct-sp-abbr").textContent).toBe("PIT");
  expect(card.querySelector(".ct-ans-value")).toBeNull();
  expect(card.querySelectorAll(".ct-ans-detail").length).toBe(1);
  expect(a.errors).toEqual([]);
  // A word that isn't a team: asked (the server knows team names) but no card
  const b = await run("python", { engines: 40, bridge: { sports: { data: { g: null }, delay: 5 } } });
  expect(!!b.document.querySelector(".ct-ans")).toBe(false);
});

(HAS_RECS ? test : test.skip)("page: knowledge panel for real 'taylor swift' (Britannica article in the results), compact on narrow screens; dropped when late; none without the article", async () => {
  const kp = { qid: "Q26876", title: "Taylor Swift", name: "Taylor Swift", type: "person", desc: "American singer-songwriter (born 1989)", extract: "Taylor Alison Swift is an American singer-songwriter.", facts: [{ k: "Born", v: "Dec 13, 1989" }, { k: "Occupation", v: "singer-songwriter, record producer" }], photo: "/api/proxy/image?url=x&sig=1" };
  const calls = [];
  const a = await run("taylor swift", { engines: 40, calls, bridge: { kp: { data: { kp }, delay: 5 } } });
  expect(calls.find((x) => x.route === "kp").params.get("q")).toBe("taylor swift");
  const card = a.document.querySelector("#results-list > .ct-kp");
  expect(card).not.toBeNull();
  expect(a.document.querySelector("#results-list").firstElementChild).toBe(card);
  expect(card.querySelector(".ct-kp-name").textContent).toBe("Taylor Swift");
  expect(card.querySelector(".ct-kp-name").getAttribute("href")).toBe("https://en.wikipedia.org/wiki/Taylor_Swift");
  expect(card.querySelector(".ct-kp-type").textContent).toBe("American singer-songwriter (born 1989)");
  expect([...card.querySelectorAll(".ct-kp-line .ct-it")].map((x) => x.textContent)).toEqual(["Born Dec 13, 1989", "Occupation singer-songwriter, record producer"]);
  expect(card.querySelector(".ct-kp-more").hidden).toBe(true);
  expect(card.querySelector(".ct-kp-photo")).toBeNull(); // compact: no photo
  card.querySelector(".ct-kp-open").click();
  expect(card.querySelector(".ct-kp-more").hidden).toBe(false);
  expect(card.querySelector(".ct-kp-src").textContent).toBe("Wikipedia ↗ · Wikidata");
  expect(a.errors).toEqual([]);
  // Same answer after the results are on screen: not put on top of them
  const b = await run("taylor swift", { engines: 0, bridge: { kp: { data: { kp }, delay: 60 } } });
  await new Promise((r) => setTimeout(r, 80));
  b.fire([]);
  expect(!!b.document.querySelector(".ct-kp")).toBe(false);
  // Real 'jaguar': no Jaguar article in the results (cars first) -> no panel; how-to searches never ask
  const c = await run("jaguar", { engines: 40, bridge: { kp: { data: { kp: { ...kp, title: "Jaguar", name: "Jaguar" } }, delay: 5 } } });
  expect(!!c.document.querySelector(".ct-kp")).toBe(false);
  const calls2 = [];
  await run("how to reset airpods", { engines: 0, calls: calls2 });
  expect(calls2.some((x) => x.route === "kp")).toBe(false);
});

(HAS_RECS ? test : test.skip)("page: same-shape results on real searches: reddit threads as plain results (no boxes, no PAA), PDF word, react.dev first", async () => {
  const r = await run("best mechanical keyboard reddit", { engines: 0 });
  expect(r.document.querySelectorAll(".ct-grp").length).toBe(0); // no Discussions / Videos box
  expect(r.document.getElementById("ct-qa")).toBeNull();
  expect(r.errors).toEqual([]);
  const p = await run("attention is all you need pdf", { engines: 0 });
  const pdfs = [...p.document.querySelectorAll(".result-item")].filter((el) => el.querySelector(".ct-pdf"));
  expect(pdfs.length).toBeGreaterThan(0);
  for (const el of pdfs) { const u = new URL(el.querySelector("a.result-title").href); expect(/\.pdf$/i.test(u.pathname) || /arxiv\.org$/.test(u.hostname)).toBe(true); }
  expect(p.document.querySelectorAll(".ct-grp").length).toBe(0);
  const d = await run("react useEffect cleanup", { engines: 0 });
  expect(new URL(d.visible[0].querySelector("a.result-title").href).hostname).toBe("react.dev");
  expect(!!d.document.querySelector(".ct-only")).toBe(false);
  // Not shaped: boxes still come (airpods has Discussions + Videos)
  const a = await run("how to reset airpods", { engines: 0 });
  expect(a.document.querySelectorAll(".ct-grp").length).toBeGreaterThan(0);
  expect(p.errors.concat(d.errors, a.errors)).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: 'Open archived copy' in each result's menu asks the server only on tap and opens what it found", async () => {
  const calls = [];
  const r = await run("$AAPL", { engines: 0, calls, bridge: { arch: { data: { a: { url: "https://archive.ph/AbC12", src: "archive.today" } }, delay: 5 } } });
  const items = [...r.document.querySelectorAll("#results-list .result-item")];
  expect(items.filter((el) => el.querySelector(".result-actions-menu .ct-arch")).length).toBe(items.filter((el) => el.querySelector(".result-actions-menu")).length);
  expect(calls.some((c) => c.route === "arch")).toBe(false); // nothing asked before the tap
  const wsj = items.find((el) => /(^|\.)wsj\.com$/.test(new URL(el.querySelector("a.result-title").href).hostname));
  const opened = [];
  r.win.open = () => { const w = { closed: false, document: { body: {} }, location: { replace: (u) => opened.push(u) } }; return w; };
  wsj.querySelector(".ct-arch:not(.ct-qv-b)").click();
  await new Promise((res) => setTimeout(res, 30));
  const c = calls.find((x) => x.route === "arch");
  expect(c.params.get("u")).toBe(wsj.querySelector("a.result-title").href);
  expect(c.params.get("pw")).toBe("1");
  expect(opened).toEqual(["https://archive.ph/AbC12"]);
  expect(r.errors).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: images row for a search you opened the Images tab for (real 'golden gate bridge' pictures), drawn with the results or not at all", async () => {
  const qh = (q) => { let h = 2166136261; for (const c of q) h = Math.imul(h ^ c.codePointAt(0), 16777619); return (h >>> 0).toString(36); };
  const store = { "ct-visual": JSON.stringify({ [qh("golden gate bridge")]: Date.now() }) };
  const imgCalls = [];
  const a = await run("golden gate bridge", { engines: 40, store, imgCalls, images: { delay: 5 } });
  expect(imgCalls.length).toBe(1);
  const sec = a.document.querySelector(".ct-imgs");
  expect(sec).not.toBeNull();
  expect(sec.querySelectorAll(".ct-im").length).toBe(12);
  expect(sec.previousElementSibling.classList.contains("result-item")).toBe(true); // after the first result
  expect(a.errors).toEqual([]);
  // Late: dropped
  const b = await run("golden gate bridge", { engines: 0, store, images: { delay: 60 } });
  await new Promise((r) => setTimeout(r, 80));
  b.fire([]);
  expect(!!b.document.querySelector(".ct-imgs")).toBe(false);
  // Not visual (no picture words, never opened the Images tab): no image search at all
  const c = [];
  await run("golden gate bridge", { engines: 0, imgCalls: c, images: { delay: 0 } });
  expect(c.length).toBe(0);
});

(HAS_RECS ? test : test.skip)("page: Quick view opens under the result on tap (recipe: facts, 8 ingredients + 'N more', 3 steps), closes on a second tap", async () => {
  const calls = [];
  const v = { kind: "recipe", title: "Cookies", facts: [["Rating", "4.9 ★ (3,120)"], ["Total time", "1 hr 15 min"], ["Serves", "24"]], lists: [{ label: "ingredients", items: Array.from({ length: 11 }, (_, i) => `item ${i + 1}`) }, { label: "steps", items: ["a", "b", "c", "d"], ordered: true }], text: [] };
  const r = await run("chocolate chip cookie recipe", { engines: 0, calls, bridge: { qv: { data: { v }, delay: 5 } } });
  expect(calls.some((c) => c.route === "qv")).toBe(false);
  const el = r.visible[0];
  el.querySelector(".ct-qv-b").click();
  await new Promise((res) => setTimeout(res, 30));
  expect(calls.find((c) => c.route === "qv").params.get("u")).toBe(el.querySelector("a.result-title").href);
  const box = el.querySelector(".result-body > .ct-qv");
  expect([...box.querySelector(".ct-qv-facts").children].map((x) => x.textContent)).toEqual(["4.9 ★★★★★ (3,120)", "1 hr 15 min", "Serves 24"]);
  expect(box.querySelector(".ct-qv-facts .ct-stars").style.getPropertyValue("--r")).toBe("4.9");
  const [ing, st] = box.querySelectorAll(".ct-qv-list");
  expect([...ing.children].filter((x) => !x.hidden).length).toBe(8);
  expect(box.querySelector(".ct-qv-more").textContent).toBe("3 more ingredients ⌄");
  expect(st.tagName).toBe("OL");
  box.querySelector(".ct-qv-more").click();
  expect([...ing.children].filter((x) => !x.hidden).length).toBe(11);
  el.querySelector(".ct-qv-b").click();
  expect(el.querySelectorAll(".ct-qv").length).toBe(0);
  // A page with nothing readable says so
  const r2 = await run("chocolate chip cookie recipe", { engines: 0, bridge: { qv: { data: { v: null }, delay: 1 } } });
  r2.visible[1].querySelector(".ct-qv-b").click();
  await new Promise((res) => setTimeout(res, 20));
  expect(r2.visible[1].querySelector(".ct-qv").textContent).toBe("No quick view for this page");
  expect(r.errors.concat(r2.errors)).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: recipe search: stars + time on the source line from this browser's copy before paint; others asked after and kept for next time", async () => {
  const qh = (q) => { let h = 2166136261; for (const c of String(q).trim().toLowerCase()) h = Math.imul(h ^ c.codePointAt(0), 16777619); return (h >>> 0).toString(36); };
  const res = REC.searches.find((x) => x.q === "chocolate chip cookie recipe" && !x.type).results;
  const first = res[0].url;
  const store = { "ct-qvs": JSON.stringify({ [qh(first)]: ["4.9 ★ · 1 hr 15 min", Date.now()] }) };
  const calls = [];
  const r = await run("chocolate chip cookie recipe", { engines: 0, store, calls, bridge: { qvs: { data: { s: { [res[1].url]: "4.7 ★ · 40 min" } }, delay: 1 } } });
  const lines = [...r.document.querySelectorAll(".ct-stars-l")].map((x) => x.textContent);
  expect(lines).toEqual(["4.9 ★★★★★ · 1 hr 15 min"]);
  await new Promise((res2) => setTimeout(res2, 30));
  const c = calls.find((x) => x.route === "qvs");
  expect(c).toBeTruthy();
  expect(r.document.querySelectorAll(".ct-stars-l").length).toBe(1); // nothing added after paint
  expect(JSON.parse(r.win.localStorage.getItem("ct-qvs"))[qh(res[1].url)][0]).toBe("4.7 ★ · 40 min");
  // Not a recipe/review search: nothing asked
  const calls2 = [];
  await run("how to reset airpods", { engines: 0, calls: calls2 });
  await new Promise((res2) => setTimeout(res2, 10));
  expect(calls2.some((x) => x.route === "qvs")).toBe(false);
  expect(r.errors).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: meaning line on real 'python' results (all about the language), none on real 'mercury'", async () => {
  const alts = [{ label: "Python", desc: "general-purpose programming language" }, { label: "Pythonidae", desc: "family of snakes" }, { label: "Monty Python", desc: "British comedy troupe" }];
  const a = await run("python", { engines: 40, bridge: { kp: { data: { kp: { alts } }, delay: 5 } } });
  const line = a.document.querySelector("#results-list > .ct-mean");
  expect(line && line.textContent).toBe("Also: snakes · Monty Python");
  expect(new URL(line.querySelector("a").href).searchParams.get("q")).toBe("python snakes");
  expect(a.document.querySelectorAll(".ct-kp").length).toBe(0); // alts only: no panel
  const m = await run("mercury", { engines: 40, bridge: { kp: { data: { kp: { alts: [{ label: "Mercury", desc: "planet closest to the Sun" }, { label: "mercury", desc: "chemical element with symbol Hg" }] } }, delay: 5 } } });
  expect(m.document.querySelectorAll(".ct-mean").length).toBe(0);
  expect(a.errors.concat(m.errors)).toEqual([]);
});

(HAS_RECS ? test : test.skip)("page: each feature's Settings switch turns it off (instant answers, quick view, paywall word)", async () => {
  const store = { "ct-show": JSON.stringify({ ans: false, qv: false, pw: false }) };
  const a = await run("5 mi in km", { engines: 0, store });
  expect(a.document.querySelectorAll(".ct-ans").length).toBe(0);
  expect(a.document.querySelectorAll(".ct-qv-b").length).toBe(0);
  expect(a.document.querySelectorAll(".ct-arch").length).toBeGreaterThan(0); // archive stays on
  const p = await run("$AAPL", { engines: 0, store });
  expect(p.document.querySelectorAll(".ct-paywall:not(.ct-pdf)").length).toBe(0);
  expect(a.errors.concat(p.errors)).toEqual([]);
});
