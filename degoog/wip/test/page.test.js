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
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Enough of degoog's template syntax for result.html: {{#if x}} {{^if x}} {{#each x}} {{ x }} {{t:...}}
const render = (tpl, c) => {
  tpl = tpl.replace(/\{\{#each (\w+)\}\}([\s\S]*?)\{\{\/each \1\}\}/g, (_, k, body) => (c[k] || []).map((x) => render(body, x)).join(""));
  for (let i = 0; i < 4; i++) tpl = tpl.replace(/\{\{([#^])if (\w+)\}\}([\s\S]*?)\{\{\/if \2\}\}/g, (_, s, k, body) => ((s === "#") === !!c[k] ? body : ""));
  return tpl.replace(/\{\{t:[^}]+\}\}/g, "x").replace(/\{\{ (\w+) \}\}/g, (_, k) => esc(c[k]));
};
const fmt = (iso) => (iso ? new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`)) : "");
const ctx = (r, i) => ({ index: i, title: r.title, url: r.url, cite_url: r.url.replace(/^https?:\/\//, ""), snippet: r.snippet, published_at: fmt(r.publishedAt),
  favicon_url: "", favicon_host: (() => { try { return new URL(r.url).hostname; } catch { return ""; } })(), thumbnail_url: r.thumbnail || "",
  sources: (r.sources || []).map((name) => ({ name })), duration: r.duration || "", is_video: !!r.duration, show_actions: true, action_block: true, action_score: true });

const run = async (q, opts = {}) => {
  const win = new Window({ url: `https://degoog.local/search?q=${encodeURIComponent(q)}` });
  const { document } = win;
  document.body.innerHTML = '<div id="at-a-glance"></div><div id="results-list"></div>';
  if (!opts.noPsl) win.CT_PSL = PSL;
  if (opts.sites) win.CT_DATA = { sites: opts.sites };
  win.fetch = async () => new win.Response("{}", { status: 404 }); // the server is not here: every bridge call fails
  win.IntersectionObserver = class { observe() {} unobserve() {} };
  win.eval(`const __PLUGIN_ID__="clean-titles";\n${CODE}`);
  const res = REC.searches.find((x) => x.q === q && !x.type || x.q === q && x.type === "web").results;
  document.getElementById("results-list").innerHTML = res.map((r, i) => render(TPL, ctx(r, i))).join("");
  await new Promise((r) => setTimeout(r, 30));
  const items = [...document.querySelectorAll("#results-list .result-item")];
  const visible = items.filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped"));
  return { win, document, res, items, visible, folds: [...document.querySelectorAll(".ct-fold")] };
};

test("page: real 'how to reset airpods' shows each document once and at most 2 per site", async () => {
  const { visible } = await run("how to reset airpods");
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
