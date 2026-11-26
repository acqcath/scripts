// ⚑ Report: the text the Claude session opens with
import { test, expect } from "bun:test";
import * as C from "../files/core.js";
const mkF = (i) => ({ t: 0, q: `q${i}`, type: "web", note: "n", top: Array.from({ length: 10 }, () => ({ title: "t".repeat(150), url: "https://a.com/" + "p".repeat(100), snippet: "s".repeat(300) })) });

test("flag: prompt fits Claude's link, dropping snippets then older reports, never the current one", () => {
  const s = C.flagPrompt(Array.from({ length: 30 }, (_, i) => mkF(i)), "2 FAIL");
  expect(s.length).toBeLessThanOrEqual(12000);
  expect(s).toContain("QUICKSTART");
  expect(s).toContain("2 FAIL");
  expect(s).toContain('"q":"q29"');
  expect(JSON.parse(s.slice(s.indexOf("{")))).toBeTruthy();
  const one = C.flagPrompt([mkF(0)], "");
  expect(one).toContain('"snippet"');
});

// The ⚑ in the tab row: Save stores; the count shows on the ⚑; Send is a claude.ai/code link with everything waiting
import fs from "node:fs";
import { Window } from "happy-dom";
test("flag: ⚑ box saves; no count, no send link", async () => {
  const win = new Window({ url: "https://degoog.local/search?q=nike%20shoes" });
  const { document } = win;
  document.body.innerHTML = '<div id="results-tabs"><div class="results-tab active" data-type="web">All</div></div><div id="results-list"><div class="result-item" data-result-url="https://www.nike.com/"><a class="result-title" href="https://www.nike.com/">Nike</a><p class="result-snippet">Just do it</p></div></div>';
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
  expect(document.getElementById("results-tabs").lastElementChild.id).toBe("ct-flag"); // right end
  expect(flag.textContent).toBe("⚑"); // no waiting count (user asked)
  flag.click();
  const box = document.getElementById("ct-flagbox");
  expect(box.querySelectorAll(".ct-flag-cat").length).toBe(C.FLAG_CATS.length);
  box.querySelector('[data-cat="order"]').click();
  box.querySelector("textarea").value = "nike.com should be first";
  box.dispatchEvent(new win.Event("submit", { cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));
  expect(saved[0].q).toBe("nike shoes"); expect(saved[0].note).toBe("nike.com should be first"); expect(saved[0].cats).toEqual(["order"]);
  expect(saved[0].ctx && typeof saved[0].ctx.vw).toBe("number"); expect(Array.isArray(saved[0].ctx.boxes)).toBe(true); expect(saved[0].ctx.load).toBeTruthy();
  expect(box.querySelector('[aria-pressed="true"]')).toBe(null); // chips reset after Save expect(saved[0].top[0].url).toBe("https://www.nike.com/");
  expect(box.querySelector("a")).toBe(null); // no manual send link: the PC job sends by itself
  expect(box.textContent).toContain("Saved.");
  expect(flag.textContent).toBe("⚑");
  expect(flag.classList.contains("ct-due")).toBe(false);
  await win.happyDOM.close();
});

import { flagPromptS } from "../files/index.js";
test("flag: server and page build the same prompt", () => {
  const fl = Array.from({ length: 25 }, (_, i) => mkF(i));
  expect(flagPromptS(fl, "x FAIL")).toBe(C.flagPrompt(fl, "x FAIL"));
  expect(flagPromptS([mkF(1)], "")).toBe(C.flagPrompt([mkF(1)], ""));
});

import { judgeParse } from "../files/index.js";
test("flag: the local model's verdict is read safely", () => {
  expect(judgeParse('ok {"send": true, "why": "3 junk-ranking reports"}')).toEqual({ send: true, why: "3 junk-ranking reports" });
  expect(judgeParse('{"send": "yes"}')).toBe(null);
  expect(judgeParse("no idea")).toBe(null);
});

import { FLAG_CATS as SC, flagCats as sCats, flagCtxClean as sCtx } from "../files/index.js";
test("⚑ categories and context: server and page agree, junk dropped", () => {
  expect(SC).toEqual(C.FLAG_CATS);
  expect(sCats(["order", "x", "order", "spam"])).toEqual(["order", "spam"]);
  expect(C.flagCats(null)).toEqual([]);
  const raw = { vw: 390.4, vh: 844, dpr: 3, phone: 1, load: { page: 812.6, results: "1500", bad: "x" }, boxes: [{ box: "results-list > result-item", n: 10 }, { box: "" }] };
  const want = { vw: 390, vh: 844, dpr: 3, phone: true, load: { page: 813, results: 1500 }, boxes: [{ box: "results-list > result-item", n: 10 }] };
  expect(C.flagCtxClean(raw)).toEqual(want);
  expect(sCtx(raw)).toEqual(want);
  const s = C.flagPrompt([{ t: 0, q: "a", type: "web", cats: ["order"], note: "", ctx: want, top: [] }], "");
  expect(s).toContain('"cats":["order"]');
  expect(s).toContain('"vw":390');
});
