// The built page script (core + script.js) on real recorded results, rendered with degoog 1.2.0's own result
// template (test/fixtures/result.html, degoog-org/degoog e006d50) into a DOM (happy-dom). Checks what the user sees
// once the observer pass ran: copies merged, 2 per site with "N more" folds, dates on the source line.
import { test, expect } from "bun:test";
import fs from "node:fs";
import zlib from "node:zlib";
import { Window } from "happy-dom";
const REC = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL("../rec/ct-recordings.json.gz", import.meta.url))));
const TPL = fs.readFileSync(new URL("./fixtures/result.html", import.meta.url), "utf8");
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
  new Function("scope", `with (scope) {\nconst __PLUGIN_ID__="clean-titles";\n${CODE}\n}`)(scope);
  const fire = (nodes) => { for (const m of mos) m.cb([{ type: "childList", addedNodes: nodes }], m); };
  const res = REC.searches.find((x) => x.q === q && (opts.type ? x.type === opts.type : !x.type || x.type === "web")).results;
  // The page script starts at page load, before any results (as in degoog: results come from a later fetch)
  if (document.readyState === "loading") await new Promise((r) => document.addEventListener("DOMContentLoaded", r, { once: true }));
  await new Promise((r) => setTimeout(r, opts.engines || 0)); // the engines' time, while early answers arrive
  const list = document.getElementById("results-list");
  list.innerHTML = res.map((r, i) => render(TPL, ctx(r, i))).join("");
  fire([...list.children]);
  const items = [...document.querySelectorAll("#results-list .result-item")];
  const visible = items.filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped"));
  return { win, document, res, items, visible, errors, fire, folds: [...document.querySelectorAll(".ct-fold")] };
};

test("page: real 'how to reset airpods' shows each document once and at most 2 per site", async () => {
  const { visible, errors } = await run("how to reset airpods");
  expect(errors).toEqual([]);
  const urls = visible.map((el) => el.querySelector("a.result-title").href);
  expect(urls).not.toContain("https://support.apple.com/en-gb/118531");
  expect(urls).not.toContain("https://m.youtube.com/watch?v=D0LZz3Zxk00");
  const per = {};
  for (const u of urls) { const h = new URL(u).hostname.split(".").slice(-2).join("."); per[h] = (per[h] || 0) + 1; }
  expect(Math.max(...Object.values(per))).toBeLessThanOrEqual(2);
});
test("page: real 'is windows 10 supported' folds the 3rd+ microsoft.com results under the 2nd; tap opens in place", async () => {
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
test("page: dates move from the snippet to the source line; snippet text keeps no leading date", async () => {
  const { items, res } = await run("steelers");
  let moved = 0;
  items.forEach((el, i) => {
    const d = el.querySelector(".result-url-row .ct-date");
    if (res[i].publishedAt && el.style.display !== "none") { expect(d).not.toBeNull(); moved++; }
    expect(el.querySelector(".result-snippet .result-date")).toBeNull();
  });
  expect(moved).toBeGreaterThan(0);
});
test("page: a search naming the site keeps all its results (mdn array map)", async () => {
  const { visible, folds } = await run("mdn array map");
  expect(visible.filter((el) => /developer\.mozilla\.org/.test(el.querySelector("a.result-title").href)).length).toBeGreaterThan(2);
  expect(folds.some((f) => /mozilla/.test(f.textContent))).toBe(false);
});
test("page: site prefs from the server (Hide, Prefer) apply before paint", async () => {
  const { visible } = await run("how to reset airpods", { sites: { "youtube.com": "hide", "wikihow.com": "prefer" } });
  expect(new URL(visible[0].querySelector("a.result-title").href).hostname).toBe("www.wikihow.com");
  expect(visible.some((el) => /youtube/.test(el.querySelector("a.result-title").href))).toBe(false);
});
test("page: public suffix file missing -> still works, sites = host names", async () => {
  const { visible } = await run("how to reset airpods", { noPsl: true });
  expect(visible.length).toBeGreaterThan(10);
});
test("page: arXiv copies merge into one result with version links", async () => {
  const { visible, document } = await run("attention is all you need pdf");
  const ax = visible.filter((el) => /arxiv\.org/.test(el.querySelector("a.result-title").href));
  expect(ax.length).toBe(1);
  expect(document.querySelectorAll(".ct-alts").length).toBeGreaterThan(0);
});
test("page: all recorded web searches replay without a single page-script error; merges and folds counted", async () => {
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
test("page: typo line, related searches and People also ask drawn with the results when their answers came first", async () => {
  const { document, win } = await run("python", { engines: 40, bridge: { fix: { data: FIX, delay: 5 }, qs: { data: QS, delay: 5 } } });
  expect(document.getElementById("ct-related")).not.toBeNull();
  expect(document.getElementById("ct-qa")).not.toBeNull();
  expect(document.getElementById("ct-qa").querySelectorAll("details").length).toBe(2);
  win.close();
});
test("page: the same answers arriving after the results are dropped (nothing inserted later)", async () => {
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
test("page: a command card (weather at the end of the search) goes in only before the results are drawn", async () => {
  const card = { html: '<div class="wx">Pittsburgh 41°F</div>' };
  const a = await run("weather pittsburgh", { engines: 40, command: { ...card, delay: 5 } });
  expect(a.document.querySelector("#at-a-glance .ct-card")).not.toBeNull();
  a.win.close();
  const b = await run("weather pittsburgh", { engines: 0, command: { ...card, delay: 60 } });
  await new Promise((r) => setTimeout(r, 120));
  const d = b.document.createElement("div");
  b.document.getElementById("results-list").append(d);
  b.fire([d]);
  expect(b.document.querySelector("#at-a-glance .ct-card")).toBeNull();
  b.win.close();
});

test("page: Top stories only for news-like results, drawn before paint, never inserted later", async () => {
  // Not news-like (v49's rule fired here): nothing remembered, no News search
  const calm = await run("time in tokyo", { news: {} });
  expect(calm.win.localStorage.getItem("ct-newsy")).toBeNull();
  // First visit to a news-like search: no News search was started, so nothing is added; the search is remembered
  const a = await run("steelers", { news: {} });
  expect(a.errors).toEqual([]);
  expect(a.document.querySelector(".ct-news")).toBeNull();
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
  expect(c.document.querySelector(".ct-news")).toBeNull();
});

test("page: News tab layout is decided before paint; recorded News pictures (upgradable hosts) keep the banner", async () => {
  for (const q of ["steelers", "nvidia"]) {
    const { items, errors } = await run(q, { type: "news" });
    expect(errors).toEqual([]);
    expect(items.length).toBeGreaterThan(40);
    expect(items.filter((el) => el.classList.contains("ct-lowres")).length).toBe(0);
  }
});

test("page: site choices in the result menu: one group of four, saved in degoog's lists, applied on the page", async () => {
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
test("page: un-hiding never writes back a block list degoog left out for being too long", async () => {
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

test("page: anti-SEO signs go to the server once per search, after the pass; auto-lowered sites say so in the menu", async () => {
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
