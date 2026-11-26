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

// The ⚑ in the tab row: one Report link, built before the tap, that carries this search and its results
import fs from "node:fs";
import { Window } from "happy-dom";
test("flag: ⚑ opens the box; Report is a claude.ai/code link with the search, note and results; it saves the flag", async () => {
  const win = new Window({ url: "https://degoog.local/search?q=nike%20shoes" });
  const { document } = win;
  document.body.innerHTML = '<div id="results-tabs"><div class="results-tab active" data-type="web">All</div></div><div id="results-list"><div class="result-item" data-result-url="https://www.nike.com/"><a class="result-title" href="https://www.nike.com/">Nike</a><p class="result-snippet">Just do it</p></div></div>';
  const calls = [];
  win.fetch = async (url, init) => {
    const q = init && init.body ? JSON.parse(init.body).query || "" : "";
    calls.push(q);
    const out = /bridge flags /.test(q) ? { flags: [], issue: "2 FAIL" } : { ok: 1 };
    return new win.Response(JSON.stringify({ html: JSON.stringify(out).replace(/&/g, "&amp;").replace(/</g, "&lt;") }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  class MO { constructor() {} observe() {} disconnect() {} takeRecords() { return []; } }
  const scope = new Proxy(win, { has: () => true, get: (t, k) => { if (k === "MutationObserver") return MO; if (k === Symbol.unscopables) return undefined; if (!(k in t)) return globalThis[k]; const v = Reflect.get(t, k); return typeof v === "function" && typeof k === "string" && /^[a-z]/.test(k) ? v.bind(t) : v; }, set: (t, k, v) => { t[k] = v; return true; } });
  globalThis.__ctAIW = win.__ctAIW = new Map(); globalThis.__ctPUBW = win.__ctPUBW = new Map();
  new Function("scope", `with (scope) {\nconst __PLUGIN_ID__="clean-titles";\n${fs.readFileSync(new URL("../files/ct-page.js", import.meta.url), "utf8")}\n}`)(scope);
  await new Promise((r) => setTimeout(r, 20));
  const flag = document.getElementById("ct-flag");
  expect(flag).toBeTruthy();
  expect(document.getElementById("results-tabs").lastElementChild.id).toBe("ct-flag"); // right end, after Tools
  flag.click();
  const box = document.getElementById("ct-flagbox");
  expect(box).toBeTruthy();
  expect(box.querySelectorAll("button").length).toBe(0); // one action: the Report link
  await new Promise((r) => setTimeout(r, 20));
  const ta = box.querySelector("textarea");
  ta.value = "nike.com should be first"; ta.dispatchEvent(new win.Event("input"));
  const go = box.querySelector("a.ct-flag-go");
  const u = new URL(go.href);
  expect(u.origin + u.pathname).toBe("https://claude.ai/code/new");
  expect(u.searchParams.get("repo")).toBe("acqcath/scripts");
  const p = u.searchParams.get("q");
  expect(p).toContain("nike shoes"); expect(p).toContain("nike.com should be first"); expect(p).toContain("https://www.nike.com/"); expect(p).toContain("2 FAIL");
  expect(box.textContent).toContain("update problem");
  go.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(calls.some((c) => /bridge flag /.test(c) && c.includes("nike"))).toBe(true);
  await win.happyDOM.close();
});
