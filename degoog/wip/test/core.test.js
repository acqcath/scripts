import { test, expect } from "bun:test";
import fs from "node:fs";
import * as C from "../files/core.js";
const psl = C.pslParse(fs.readFileSync(new URL("../psl.enc", import.meta.url), "utf8"));
const R = (u, t = "x") => ({ url: u, title: t });

test("public suffix grouping", () => {
  const cases = { "www.bbc.co.uk": "bbc.co.uk", "news.bbc.co.uk": "bbc.co.uk", "foo.github.io": "foo.github.io", "a.b.example.com": "example.com",
    "example.com": "example.com", "city.kawasaki.jp": "city.kawasaki.jp", "x.y.kawasaki.jp": "x.y.kawasaki.jp", "blog.blogspot.com": "blog.blogspot.com",
    "docs.python.org": "python.org", "en.wikipedia.org": "wikipedia.org", "s3.amazonaws.com": "s3.amazonaws.com", "localhost": "localhost", "1.2.3.4": "1.2.3.4", "x.unknowntld": "x.unknowntld" };
  for (const [h, want] of Object.entries(cases)) expect([h, C.regDomain(h, psl)]).toEqual([h, want]);
});
test("dedupe: comment and pagination pages", () => {
  const out = C.dedupe([R("https://site.com/post/how-to-x", "How to X"), R("https://site.com/post/how-to-x/comment-page-2", "How to X - Comments"), R("https://site.com/post/how-to-x/page/3", "How to X"), R("http://m.site.com/post/how-to-x?amp=1", "How to X"), R("https://site.com/post/how-to-x/amp", "How to X")], psl);
  expect(out.length).toBe(1);
});
test("dedupe: arXiv versions with version links", () => {
  const out = C.dedupe([R("https://arxiv.org/abs/1706.03762v5", "Attention Is All You Need"), R("https://arxiv.org/pdf/1706.03762", "[1706.03762] Attention"), R("https://arxiv.org/abs/1706.03762v7"), R("https://ar5iv.labs.arxiv.org/html/1706.03762", "ar5iv")], psl);
  expect(out.length).toBe(1);
  expect(out[0].alts.map((a) => a.label)).toEqual(["PDF", "HTML", "v7 latest"]);
});
test("dedupe: Apple locales and legacy IDs", () => {
  const out = C.dedupe([R("https://support.apple.com/en-us/HT201295", "Reset AirPods"), R("https://support.apple.com/kb/HT201295", "Reset"), R("https://support.apple.com/HT201295", "r"), R("https://support.apple.com/de-de/HT201295", "AirPods zurücksetzen"), R("https://support.apple.com/en-gb/HT201295", "Reset AirPods"), R("https://support.apple.com/en-us/HT204087", "Other")], psl);
  expect(out.map((x) => x.url)).toEqual(["https://support.apple.com/en-us/HT201295", "https://support.apple.com/en-us/HT204087"]);
});
test("dedupe: react.dev mirrors", () => {
  const out = C.dedupe([R("https://react.dev/reference/react/useEffect", "useEffect – React"), R("https://zh-hans.react.dev/reference/react/useEffect", "useEffect – React 中文文档"), R("https://ja.react.dev/reference/react/useEffect/", "useEffect – React")], psl);
  expect(out.length).toBe(1);
});
test("dedupe: Wikipedia mirrors", () => {
  const out = C.dedupe([R("https://en.wikipedia.org/wiki/Eiffel_Tower", "Eiffel Tower - Wikipedia"), R("https://en.m.wikipedia.org/wiki/Eiffel_Tower"), R("https://www.wikiwand.com/en/articles/Eiffel_Tower"), R("https://www.wikiwand.com/en/Eiffel_Tower"), R("https://wikipedia.com/wiki/Eiffel_Tower"), R("https://www.wikipedia.org/wiki/Eiffel_Tower"), R("https://simple.wikipedia.org/wiki/Eiffel_Tower"), R("https://www.newworldencyclopedia.org/entry/Eiffel_Tower"), R("https://en.wikipedia.org/wiki/Paris", "Paris - Wikipedia")], psl);
  expect(out.length).toBe(2);
});
test("dedupe: short links and same title within site; different pages stay", () => {
  const out = C.dedupe([R("https://www.apple.com/airpods/", "AirPods - Apple"), R("https://apple.co/airpods", "AirPods - Apple"), R("https://site.com/a", "Best Mechanical Keyboards 2026"), R("https://site.com/b?x=1", "Best mechanical keyboards (2026)"), R("https://other.com/a", "Best Mechanical Keyboards 2026"), R("https://site.com/c", "Something else entirely here")], psl);
  expect(out.map((x) => x.url)).toEqual(["https://www.apple.com/airpods/", "https://site.com/a", "https://other.com/a", "https://site.com/c"]);
});
test("pagination tail is not a real page", () => {
  expect(C.docKey("https://site.com/my-article/2")).toBe(C.docKey("https://site.com/my-article"));
  expect(C.docKey("https://site.com/2")).not.toBe(C.docKey("https://site.com/"));
  expect(C.docKey("https://site.com/2024/11")).not.toBe(C.docKey("https://site.com/2024"));
});
test("site cap folds 3rd+, lifts when named", () => {
  const items = C.dedupe([R("https://www.reddit.com/r/a/comments/1/one", "one thread title"), R("https://www.reddit.com/r/b/comments/2/two", "two thread title"), R("https://old.reddit.com/r/c/comments/3/three", "three thread title"), R("https://x.com/1", "x post here")], psl);
  const c = C.capSites(items, "keyboards", psl);
  expect(c.shown.length).toBe(3); expect(c.folds.get("reddit.com").length).toBe(1);
  expect(C.capSites(items, "keyboards reddit", psl).shown.length).toBe(4);
  expect(C.capSites(items, "keyboards site:reddit.com", psl).folds.size).toBe(0);
});
test("checksums", () => {
  expect(C.upsValid("1Z999AA10123456784")).toBe(true);
  expect(C.upsValid("1Z999AA10123456785")).toBe(false);
  let ups = 0; for (let i = 0; i < 1000; i++) if (C.upsValid("1Z" + Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, "0") + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"))) ups++;
  expect(ups).toBeGreaterThan(50); expect(ups).toBeLessThan(160);
  expect(C.isbnValid("978-0-14-032872-1")).toBe(true);
  expect(C.isbnValid("9780140328722")).toBe(false);
  expect(C.isbnValid("0-306-40615-2")).toBe(true);
  expect(C.isbnValid("0306406153")).toBe(false);
  let hits = 0; for (let i = 0; i < 2000; i++) { const s = "978" + String(Math.floor(Math.random() * 1e10)).padStart(10, "0"); if (C.isbnValid(s)) hits++; }
  expect(hits).toBeGreaterThan(120); expect(hits).toBeLessThan(290); // ~1 in 10 random strings pass, as the math says
});
test("CMU patterns incl. 15213 zip collision", () => {
  const courses = new Set(["15-213", "15-122"]);
  expect(C.cmuCourse("15-213", courses)).toEqual({ id: "15-213", level: true, prof: false });
  expect(C.cmuCourse("15213", courses).id).toBe("15-213");
  expect(C.cmuCourse("15213", new Set())).toBe(null);
  expect(C.cmuCourse("15-213 workload", courses).level).toBe(true);
  expect(C.cmuCourse("15-213 professor", courses).prof).toBe(true);
  expect(C.cmuCourse("15-213 malloc lab", courses).level).toBe(false);
  expect(C.cmuCourse("152134", courses)).toBe(null);
});
test("snippet date cleanup", () => {
  expect(C.cleanSnippet("Mar 5, 2024 — The keyboard is great for typing.")).toEqual({ date: "Mar 5, 2024", text: "The keyboard is great for typing." });
  expect(C.cleanSnippet("3 days ago · New firmware fixes the bug for everyone.")).toEqual({ date: "3 days ago", text: "New firmware fixes the bug for everyone." });
  expect(C.cleanSnippet("... and then the result ... ...").text).toBe("and then the result …");
  expect(C.cleanSnippet("2024 was a big year for keyboards").date).toBe("");
  const now = Date.parse("2026-11-22T12:00:00");
  expect(C.relDate("2026-11-21T08:00:00", now)).toBe("yesterday");
  expect(C.relDate("2026-11-18T08:00:00", now)).toBe("4 days ago");
  expect(C.relDate("2026-11-01T08:00:00", now)).toBe("Nov 1, 2026");
});

// ===== Page plan, on real recorded searches from the user's server =====
import zlib from "node:zlib";
const REC = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL("../rec/ct-recordings.json.gz", import.meta.url))));
const rec = (q) => REC.searches.find((x) => x.q === q && (!x.type || x.type === "web")).results;
test("page plan: real 'how to reset airpods' merges copies and folds the 3rd+ per site", () => {
  const items = rec("how to reset airpods"), ctx = C.listCtx("how to reset airpods", psl);
  const p = C.planPage(items, ctx);
  // Locale copy, m. copy, and a same-title re-upload of the same video on one site
  expect(p.dups.map((x) => x.url).sort()).toEqual(["https://m.youtube.com/watch?v=D0LZz3Zxk00", "https://support.apple.com/en-gb/118531", "https://www.youtube.com/watch?v=8lnlUrHBqOE"]);
  expect(p.shown.length + p.dups.length + p.hidden.length + p.capped.length + [...p.folds.values()].reduce((n, f) => n + f.items.length, 0)).toBe(items.length);
  for (const [site, f] of p.folds) { expect(p.shown.filter((r) => r.site === site).length).toBe(2); expect(f.after.site).toBe(site); }
  expect(p.folds.get("youtube.com").items.length).toBe(3);
});
test("page plan: the search naming a site lifts its cap (mdn, npm, pip, site:)", () => {
  for (const q of ["mdn array map", "npm lodash"]) {
    const p = C.planPage(rec(q), C.listCtx(q, psl));
    const site = q.startsWith("mdn") ? "mozilla.org" : "npmjs.com";
    expect([q, p.folds.has(site)]).toEqual([q, false]);
    expect(p.shown.filter((r) => r.site === site).length).toBeGreaterThan(2);
  }
  const p = C.planPage(rec("mdn array map"), C.listCtx("array map site:developer.mozilla.org", psl));
  expect(p.folds.has("mozilla.org")).toBe(false);
});
test("page plan: site prefs hide, prefer (no cap, moved up), lower (moved down)", () => {
  const q = "how to reset airpods";
  const p = C.planPage(rec(q), C.listCtx(q, psl, { "youtube.com": "hide", "wikihow.com": "prefer", "apple.com": "lower" }));
  expect(p.shown.some((r) => r.site === "youtube.com")).toBe(false);
  expect(p.shown[0].site).toBe("wikihow.com");
  const sites = p.shown.map((r) => r.site);
  expect(sites.slice(-2)).toEqual(["apple.com", "apple.com"]);
});
test("page plan: endless-scroll pages share one search (copies on page 2 drop, no folds above)", () => {
  const items = rec("how to reset airpods"), ctx = C.listCtx("how to reset airpods", psl);
  C.planPage(items.slice(0, 10), ctx);
  const p2 = C.planPage(items.slice(10), ctx);
  expect(p2.dups.map((x) => x.url)).toContain("https://m.youtube.com/watch?v=D0LZz3Zxk00");
  for (const f of p2.folds.values()) expect(p2.shown).toContain(f.after);
});
test("no public suffix list: host minus www, never a bare suffix", () => {
  expect(C.regDomain("www.bbc.co.uk", null)).toBe("bbc.co.uk");
  expect(C.regDomain("news.bbc.co.uk", null)).toBe("news.bbc.co.uk");
});
test("date labels: relative kept, absolute within a week relative, else exact", () => {
  const now = Date.parse("2026-11-23T12:00:00");
  expect(C.dateLabel("3 days ago", now)).toBe("3 days ago");
  expect(C.dateLabel("Nov 22, 2026", now)).toBe("yesterday");
  expect(C.dateLabel("2026-11-20", now)).toBe("3 days ago");
  expect(C.dateLabel("Feb 1, 2022", now)).toBe("Feb 1, 2022");
  expect(C.dateLabel("", now)).toBe("");
});

test("sites: degoog's block/score lists -> one choice per site; Hide wins; patterns left to degoog", async () => {
  const { sitesFromLists, unblockText, SITE_SCORE } = await import("../files/core.js");
  const block = "pinterest.com\n/.*\\.spam\\..*/\n||quora.com^\n\nWWW.Example.org";
  const score = "wikipedia.org|40\nw3schools.com|-15\npinterest.com|10\nzero.com|0\nbad line\nreddit.com|x";
  expect(sitesFromLists(block, score)).toEqual({ "wikipedia.org": "prefer", "w3schools.com": "lower", "pinterest.com": "hide", "www.example.org": "hide" });
  expect(sitesFromLists("", "")).toEqual({});
  expect(unblockText(block, "example.org")).toBe("pinterest.com\n/.*\\.spam\\..*/\n||quora.com^\n");
  expect(unblockText(block, "pinterest.com").split("\n")[0]).toBe("/.*\\.spam\\..*/");
  expect(SITE_SCORE.prefer > 0 && SITE_SCORE.lower < 0 && SITE_SCORE.normal === 0).toBe(true);
});

test("anti-SEO signs: copies, bait, stale lists, AI tells, essay sites; not paper mirrors or forum titles", () => {
  const now = Date.parse("2026-11-23T05:00:00Z");
  const r = C.seoSigns([
    { url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map", title: "Array.prototype.map() - JavaScript | MDN", snippet: "The map() method of Array instances creates a new array populated with the results of calling a provided function on every element" },
    { url: "https://mdn2.netlify.app/en-us/docs/web/javascript/reference/global_objects/array/map", title: "Array.prototype.map() - JavaScript | MDN", snippet: "Mar 28, 2022 ... The map() method creates a new array populated with the results of calling a provided function on every element in the calling array." },
    { url: "https://time.savvycal.com/worldclock/Japan/Tokyo", title: "Current Local Time in Tokyo, Japan", snippet: "Tokyo, Japan is in the Japan Time time zone (JST), currently UTC+09:00. Tokyo stays at UTC" },
    { url: "https://www.thetimenow.com/japan/tokyo", title: "Current Local Time in Tokyo, Japan", snippet: "Tokyo uses the Asia/Tokyo time zone, currently JST (UTC+9). Does Tokyo observe daylight saving" },
    { url: "https://papers.nips.cc/paper/7181-attention-is-all-you-need", title: "Attention is All you Need - NIPS", snippet: "Abstract. The dominant sequence transduction models are based on complex recurrent" },
    { url: "https://proceedings.neurips.cc/paper/2017/file/x-Paper.pdf", title: "Attention is All you Need - NIPS", snippet: "The dominant sequence transduction models are based on complex recurrent or convolutional" },
    { url: "https://www.reddit.com/r/keyboards/comments/x/best_keyboard_2023/", title: "Best mechanical keyboard 2023?", snippet: "Looking for one" },
    { url: "https://bestlists.example.com/kb", title: "10 Best Mechanical Keyboards of 2024", snippet: "Our picks" },
    { url: "https://kw.example.net/x", title: "react hooks", snippet: "react hooks has a search volume of 12k and keyword difficulty 40" },
    { url: "https://ai.example.org/y", title: "React hooks guide", snippet: "In today's fast-paced digital world, we delve into hooks" },
    { url: "https://www.ukessays.com/essays/x", title: "Essay", snippet: "x" },
  ], psl, now);
  expect(r.hit).toEqual({ "mdn2.netlify.app": ["copy"], "example.com": ["stale"], "example.net": ["bait"], "example.org": ["ai"], "ukessays.com": ["cheat"] });
  expect(r.seen).toContain("thetimenow.com");
  expect(C.seoVerdict({ seen: 5, hits: 3 })).toBe(true);
  expect(C.seoVerdict({ seen: 4, hits: 4 })).toBe(false);
  expect(C.seoVerdict({ seen: 6, hits: 3 })).toBe(false);
});

test("paywall sites: whole site by registrable domain, no look-alikes", () => {
  expect(C.paywalled("www.wsj.com", psl)).toBe(true);
  expect(C.paywalled("cooking.nytimes.com", psl)).toBe(true);
  expect(C.paywalled("www.ft.com", psl)).toBe(true);
  expect(C.paywalled("nytimes.com.example.io", psl)).toBe(false);
  expect(C.paywalled("en.wikipedia.org", psl)).toBe(false);
});

test("same-shape results: type words, filter sites, the Only line, docs first", () => {
  expect(["attention is all you need pdf", "best mechanical keyboard reddit", "pasta carbonara recipe", "react docs", "lofi video", "15-213 malloc lab", "how to reset airpods"].map(C.shapeOf)).toEqual(["pdf", "forum", "recipe", "docs", "video", "lab", ""]);
  expect(C.filterSite("best mechanical keyboard reddit")).toBe("reddit.com");
  expect(C.filterSite("reddit")).toBe(""); // navigation, not a filter
  expect(C.filterSite("site:reddit.com keyboards")).toBe("");
  expect(C.onlyLine("best mechanical keyboard reddit", ["reddit.com", "reddit.com", "reddit.com", "rtings.com"])).toBe("");
  expect(C.onlyLine("best mechanical keyboard reddit", ["rtings.com", "reddit.com", "nytimes.com", "pcmag.com"])).toBe("reddit.com");
  expect(C.onlyQuery("best mechanical keyboard reddit", "reddit.com")).toBe("best mechanical keyboard site:reddit.com");
  expect(C.onlyQuery("mdn array map", "mozilla.org")).toBe("array map site:mozilla.org");
  expect(C.docsFor("react useEffect cleanup")).toEqual(["react.dev"]);
  expect(C.docsFor("python list comprehension")).toEqual(["docs.python.org"]);
  for (const q of ["python", "python snake", "rust removal", "go", "node"]) expect([q, C.docsFor(q)]).toEqual([q, null]);
  // planPage: react.dev's page goes first on the first page only, after dedupe
  const items = ["https://www.reddit.com/r/reactjs/a", "https://stackoverflow.com/q/1", "https://react.dev/reference/react/useEffect", "https://react.dev/learn"].map((url) => ({ url, title: url }));
  const ctx = C.listCtx("react useEffect cleanup", null, {});
  expect(C.planPage(items, ctx).shown.map((r) => r.url)[0]).toBe("https://react.dev/reference/react/useEffect");
  expect(C.planPage([{ url: "https://x.com/a", title: "a" }, { url: "https://react.dev/blog", title: "b" }], ctx).shown[0].url).toBe("https://x.com/a");
  // Lower wins over docs-first
  expect(C.planPage(items, C.listCtx("react useEffect cleanup", null, { "react.dev": "lower" })).shown[0].url).toBe("https://www.reddit.com/r/reactjs/a");
});
