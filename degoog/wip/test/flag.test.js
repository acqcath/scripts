// ⚑ Report: the text the Claude session opens with
import { test, expect } from "bun:test";
import * as C from "../files/core.js";
import { flagPrompt, FLAG_CATS as SC, flagCats as sCats, flagCtxClean as sCtx } from "../files/index.js";
const mkF = (i) => ({ t: 0, q: `q${i}`, type: "web", note: "n", top: Array.from({ length: 10 }, () => ({ title: "t".repeat(150), url: "https://a.com/" + "p".repeat(100), snippet: "s".repeat(300) })) });

test("flag: prompt fits Claude's link, dropping snippets then older reports, never the current one", () => {
  const s = flagPrompt(Array.from({ length: 30 }, (_, i) => mkF(i)), "2 FAIL");
  expect(s.length).toBeLessThanOrEqual(12000);
  expect(s).toContain("QUICKSTART");
  expect(s).not.toContain("degoog-flags");
  expect(s).toContain("2 FAIL");
  expect(s).toContain('"q":"q29"');
  expect(JSON.parse(s.slice(s.indexOf("{")))).toBeTruthy();
  const one = flagPrompt([mkF(0)], "");
  expect(one).toContain('"snippet"');
});

// The ⚑ in the tab row: Save stores; the count shows on the ⚑; Send is a claude.ai/code link with everything waiting
import fs from "node:fs";
import { Window } from "happy-dom";
test("flag: ⚑ box saves; no count, no send link", async () => {
  const win = new Window({ url: "https://degoog.local/search?q=nike%20shoes" });
  const { document } = win;
  document.body.innerHTML = '<div id="results-header"><div id="results-search-bar"></div><a id="nav-settings-results" href="/settings"></a></div><div id="results-tabs"><div class="results-tab active" data-type="web">All</div></div><div id="results-list"><div class="result-item" data-result-url="https://www.nike.com/"><a class="result-title" href="https://www.nike.com/">Nike</a><p class="result-snippet">Just do it</p></div></div>';
  const calls = [], saved = [];
  win.fetch = async (url, init) => {
    const q = init && init.body ? JSON.parse(init.body).query || "" : "";
    calls.push(q);
    let out = { ok: 1 };
    if (/bridge flag __body/.test(q)) { saved.push(JSON.parse(new URLSearchParams(q.replace(/^!cleantitles bridge flag /, "")).get("__body"))); out = { n: saved.length }; }
    if (/bridge flags /.test(q)) out = /sent=1/.test(q) ? { flags: [], issue: "" } : { flags: saved.map((x) => ({ ...x, t: 0 })), issue: "2 FAIL", send: false, why: "one minor report" };
    if (/bridge sites /.test(q)) out = { sites: {}, flags: 3, flagDue: false };
    return new win.Response(JSON.stringify({ html: JSON.stringify(out).replace(/&/g, "&amp;").replace(/</g, "&lt;") }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  class MO { constructor() {} observe() {} disconnect() {} takeRecords() { return []; } }
  const scope = new Proxy(win, { has: () => true, get: (t, k) => { if (k === "MutationObserver") return MO; if (k === Symbol.unscopables) return undefined; if (!(k in t)) return globalThis[k]; const v = Reflect.get(t, k); return typeof v === "function" && typeof k === "string" && /^[a-z]/.test(k) ? v.bind(t) : v; }, set: (t, k, v) => { t[k] = v; return true; } });
  globalThis.__ctAIW = win.__ctAIW = new Map(); globalThis.__ctPUBW = win.__ctPUBW = new Map();
  new Function("scope", `with (scope) {\nconst __PLUGIN_ID__="clean-titles";\n${fs.readFileSync(new URL("../files/ct-page.js", import.meta.url), "utf8")}\n}`)(scope);
  await new Promise((r) => setTimeout(r, 30));
  const flag = document.getElementById("ct-flag");
  expect(document.getElementById("nav-settings-results").previousElementSibling.id).toBe("ct-flag"); // just before the gear, every screen size
  expect(flag.textContent).toBe("⚑"); // no waiting count (user asked)
  flag.click();
  const box = document.getElementById("ct-flagbox");
  expect(box.querySelectorAll(".ct-flag-cat").length).toBe(C.FLAG_CATS.length);
  expect(box.querySelector(".ct-flag-ver").textContent).toMatch(/^clean-titles v\d+/);
  box.querySelector('[data-cat="order"]').click();
  box.querySelector("textarea").value = "nike.com should be first";
  box.dispatchEvent(new win.Event("submit", { cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));
  expect(saved[0].q).toBe("nike shoes"); expect(saved[0].note).toBe("nike.com should be first"); expect(saved[0].cats).toEqual(["order"]);
  expect(saved[0].ctx && typeof saved[0].ctx.vw).toBe("number"); expect(Array.isArray(saved[0].ctx.boxes)).toBe(true); expect(saved[0].ctx.load).toBeTruthy(); expect(typeof saved[0].ctx.passes).toBe("object");
  expect(box.querySelector('[aria-pressed="true"]')).toBe(null); // chips reset after Save expect(saved[0].top[0].url).toBe("https://www.nike.com/");
  expect(box.querySelector("a")).toBe(null); // no manual send link: the PC job sends by itself
  expect(box.textContent).toContain("Saved.");
  expect(flag.textContent).toBe("⚑");
  expect(flag.classList.contains("ct-due")).toBe(false);
  await win.happyDOM.close();
});

import { judgeParse } from "../files/index.js";
test("flag: the local model's verdict is read safely", () => {
  expect(judgeParse('ok {"send": true, "why": "3 junk-ranking reports"}')).toEqual({ send: true, why: "3 junk-ranking reports" });
  expect(judgeParse('{"send": "yes"}')).toBe(null);
  expect(judgeParse("no idea")).toBe(null);
});

test("⚑ categories and context: server and page agree, junk dropped", () => {
  expect(SC).toEqual(C.FLAG_CATS);
  expect(sCats(["order", "x", "order", "spam"])).toEqual(["order", "spam"]);
  expect(sCats(null)).toEqual([]);
  const raw = { vw: 390.4, vh: 844, dpr: 3, phone: 1, load: { page: 812.6, results: "1500", bad: "x" }, boxes: [{ box: "results-list > result-item", n: 10 }, { box: "" }] };
  const want = { ver: "", vw: 390, vh: 844, dpr: 3, phone: true, load: { page: 813, results: 1500 }, boxes: [{ box: "results-list > result-item", n: 10 }], passes: { list: 12 }, batches: 4 };
  raw.passes = { list: 12.4, bad: "x" }; raw.batches = 4;
  const s = flagPrompt([{ t: 0, q: "a", type: "web", cats: ["order"], note: "", ctx: want, top: [] }], "");
  expect(s).toContain('"cats":["order"]');
  expect(s).toContain('"vw":390');
});

// CJK: a title/snippet starting with 「 is pulled back by the bracket's blank half (screenshot 2026-11-28, zhihu)
test("page: CJK opening bracket at the start of a title and snippet hangs", async () => {
  const win = new Window({ url: "https://degoog.local/search?q=kmfgvfxv" });
  const { document } = win;
  document.body.innerHTML = '<div id="results-tabs"><div class="results-tab active" data-type="web">All</div></div><div id="results-list"><div class="result-item" data-result-url="https://www.zhihu.com/question/1"><a class="result-title" href="https://www.zhihu.com/question/1">「ji、qi、xi」跟「gi、ki、hi」是否为尖团对立？ - 知乎</a><p class="result-snippet">「ji、qi、xi」跟「gi、ki、hi」</p></div><div class="result-item" data-result-url="https://a.com/"><a class="result-title" href="https://a.com/">KEEMO Fashion</a><p class="result-snippet">Find the latest</p></div></div>';
  win.fetch = async () => new win.Response(JSON.stringify({ html: "{}" }), { status: 200, headers: { "Content-Type": "application/json" } });
  class MO { constructor() {} observe() {} disconnect() {} takeRecords() { return []; } }
  const scope = new Proxy(win, { has: () => true, get: (t, k) => { if (k === "MutationObserver") return MO; if (k === Symbol.unscopables) return undefined; if (!(k in t)) return globalThis[k]; const v = Reflect.get(t, k); return typeof v === "function" && typeof k === "string" && /^[a-z]/.test(k) ? v.bind(t) : v; }, set: (t, k, v) => { t[k] = v; return true; } });
  globalThis.__ctAIW = win.__ctAIW = new Map(); globalThis.__ctPUBW = win.__ctPUBW = new Map();
  new Function("scope", `with (scope) {\nconst __PLUGIN_ID__="clean-titles";\n${fs.readFileSync(new URL("../files/ct-page.js", import.meta.url), "utf8")}\n}`)(scope);
  await new Promise((r) => setTimeout(r, 30));
  const [z, k] = document.querySelectorAll(".result-item");
  const zt = z.querySelector("a.result-title");
  expect(zt.firstElementChild && zt.firstElementChild.className).toBe("ct-hang");
  expect(zt.textContent.startsWith("「ji")).toBe(true);
  expect(z.querySelector(".result-snippet .ct-hang")).toBeTruthy();
  expect(k.querySelector(".ct-hang")).toBeNull();
});

// M6: product panel asked after the results when the needs call rates it over the cutoff; wide screens: right column
test("page: product panel in the right column", async () => {
  const win = new Window({ url: "https://degoog.local/search?q=yamaha%20dbr10%20release", width: 1400, height: 900 });
  const { document } = win;
  document.body.innerHTML = '<div id="results-tabs"><div class="results-tab active" data-type="web">All</div></div><div id="results-list"><div class="result-item" data-result-url="https://usa.yamaha.com/dbr10"><a class="result-title" href="https://usa.yamaha.com/dbr10">DBR10</a><p class="result-snippet">Powered speaker</p></div></div>';
  const asked = [];
  win.fetch = async (url, init) => {
    const q = init && init.body ? JSON.parse(init.body).query || "" : "";
    asked.push(q);
    let out = {};
    if (/bridge needs /.test(q)) out = { n: { f: { video: 0.1, image: 0.1, text: 0.8 }, n: {}, b: { web: 0.5, product: 0.9, info: 0.2 }, s: {}, cut: 0.2 } };
    if (/bridge product /.test(q)) out = { v: { name: "DBR10", brand: "Yamaha", img: "", url: "https://usa.yamaha.com/dbr10", price: { lo: 299, hi: 349, cur: "USD", sellers: 3 }, rating: null, specs: [], rel: "Jan 21, 2016", from: ["usa.yamaha.com"] } };
    return new win.Response(JSON.stringify({ html: JSON.stringify(out).replace(/&/g, "&amp;").replace(/</g, "&lt;") }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  win.matchMedia = (m) => ({ matches: /min-width: 1180px/.test(m), addEventListener() {}, removeEventListener() {} });
  const mos = [];
  class MO { constructor(cb) { mos.push(cb); } observe() {} disconnect() {} takeRecords() { return []; } }
  const scope = new Proxy(win, { has: () => true, get: (t, k) => { if (k === "MutationObserver") return MO; if (k === Symbol.unscopables) return undefined; if (!(k in t)) return globalThis[k]; const v = Reflect.get(t, k); return typeof v === "function" && typeof k === "string" && /^[a-z]/.test(k) ? v.bind(t) : v; }, set: (t, k, v) => { t[k] = v; return true; } });
  globalThis.__ctAIW = win.__ctAIW = new Map(); globalThis.__ctPUBW = win.__ctPUBW = new Map();
  new Function("scope", `with (scope) {\nconst __PLUGIN_ID__="clean-titles";\n${fs.readFileSync(new URL("../files/ct-page.js", import.meta.url), "utf8")}\n}`)(scope);
  for (let i = 0; i < 10 && !document.querySelector(".ct-prod"); i++) {
    await new Promise((r) => setTimeout(r, 30));
    mos.forEach((cb) => cb([])); // stands in for degoog's redraws
  }
  const card = document.querySelector(".ct-kp-wide .ct-prod");
  expect(asked.some((q) => /bridge product /.test(q))).toBe(true);
  expect(card).toBeTruthy();
  expect(card.textContent).toContain("$299 – $349 (3 sellers)");
  expect(card.textContent).toContain("Released");
});
