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
