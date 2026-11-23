// Server plugin (files/index.js) routes that need no network
process.env.CT_NO_TIMERS = "1";
import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("server: /sites reads degoog's lists file (domains only) and agrees with core", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  fs.mkdirSync(path.join(dir, "search"));
  fs.writeFileSync(path.join(dir, "search", "search-lists.json"), JSON.stringify({ domainBlockList: "pinterest.com\n/x/", domainScoreList: "wikipedia.org|40\nw3schools.com|-15", domainReplaceList: "" }));
  process.env.DEGOOG_DATA_DIR = dir;
  const srv = await import("../files/index.js");
  const core = await import("../files/core.js");
  const r = srv.routes.find((x) => x.path === "/sites");
  const j = await (await r.handler(new Request("http://local/sites"))).json();
  expect(j.sites).toEqual({ "pinterest.com": "hide", "wikipedia.org": "prefer", "w3schools.com": "lower" });
  expect(j.auto).toEqual([]);
  for (const [b, s] of [["a.com\n||b.com^\nC.org", "d.net|5\ne.io|-1\nf.com|0\ng|3"], ["", ""], ["x.com", "x.com|9"]]) expect(srv.sitesFromLists(b, s)).toEqual(core.sitesFromLists(b, s));
  // No lists file: falls back to the older place (server-settings.json), else nothing
  fs.rmSync(path.join(dir, "search"), { recursive: true });
  const k = await (await r.handler(new Request("http://local/sites"))).json();
  expect(k.sites).toEqual({});
  delete process.env.DEGOOG_DATA_DIR;
});

test("server: Sites in Settings mirror degoog's lists, and only rows changed there are written back", async () => {
  const srv = await import("../files/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-sites-"));
  const lists = { domainBlockList: "pinterest.com\n/.*\\.spam\\..*/\nwww.example.org", domainScoreList: "wikipedia.org|40\nw3schools.com|-15", domainReplaceList: "" };
  const stored = {}, writes = [];
  srv._setDegoog({
    readDomainLists: async () => ({ ...lists }),
    writeDomainList: async (k, v) => { writes.push(k); lists[k] = v; },
    setSettings: async (id, v) => { stored[id] = { ...(stored[id] || {}), ...v }; },
  }, dir);
  const cmd = srv.default;
  cmd.init({ id: "clean-titles", dir });
  // First start: nothing stored yet -> the setting is filled from the lists, nothing written to them
  cmd.configure({});
  await srv._sitesIdle();
  expect(writes).toEqual([]);
  const shown = JSON.parse(stored["clean-titles-command"].sites);
  expect(shown).toEqual([{ site: "pinterest.com", choice: "hide" }, { site: "w3schools.com", choice: "lower" }, { site: "wikipedia.org", choice: "prefer" }, { site: "www.example.org", choice: "hide" }]);
  // Start-up / unrelated save with the same rows: lists untouched
  cmd.configure({ sites: stored["clean-titles-command"].sites, showVideos: "false" });
  await srv._sitesIdle();
  expect(writes).toEqual([]);
  // You edit in Settings: pinterest -> Normal (row deleted), w3schools -> Hide, add a typed address as Prefer
  const edited = JSON.stringify([{ site: "w3schools.com", choice: "hide" }, { site: "wikipedia.org", choice: "prefer" }, { site: "www.example.org", choice: "hide" }, { site: "https://developer.mozilla.org/en-US/", choice: "prefer" }]);
  cmd.configure({ sites: edited });
  await srv._sitesIdle();
  expect(lists.domainBlockList).toBe("/.*\\.spam\\..*/\nwww.example.org\nw3schools.com");
  expect(lists.domainScoreList).toBe("wikipedia.org|40\ndeveloper.mozilla.org|40");
  expect(JSON.parse(stored["clean-titles-command"].sites).map((r) => r.site)).toEqual(["developer.mozilla.org", "w3schools.com", "wikipedia.org", "www.example.org"]);
  // A change made from a result's menu (lists changed elsewhere) reaches Settings through /sites, and a start-up
  // afterwards with the old stored rows would be stale -- but rows were refreshed, so nothing is undone
  lists.domainScoreList += "\nreddit.com|40";
  fs.mkdirSync(path.join(dir, "search"), { recursive: true });
  fs.writeFileSync(path.join(dir, "search", "search-lists.json"), JSON.stringify(lists));
  process.env.DEGOOG_DATA_DIR = dir;
  await srv.routes.find((x) => x.path === "/sites").handler(new Request("http://local/sites"));
  await srv._sitesIdle();
  delete process.env.DEGOOG_DATA_DIR;
  expect(stored["clean-titles-command"].sites).toContain("reddit.com");
  const n = writes.length;
  cmd.configure({ sites: stored["clean-titles-command"].sites });
  await srv._sitesIdle();
  expect(writes.length).toBe(n);
  expect(lists.domainScoreList).toContain("reddit.com|40");
  // Bad value: lists untouched, the setting is shown again from the lists
  cmd.configure({ sites: "{not json" });
  await srv._sitesIdle();
  expect(writes.length).toBe(n);
  expect(srv.applySites("a.com\n", "b.com|5\n", { "b.com": "normal", "c.com": "lower" })).toEqual({ block: "a.com", score: "c.com|-40" });
});

test("server: anti-SEO lowers a site with signs on most of 5+ searches; your choice wins and stops it", async () => {
  const srv = await import("../files/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-seo-"));
  const lists = { domainBlockList: "", domainScoreList: "mine.com|40", domainReplaceList: "" };
  const stored = {};
  srv._setDegoog({ readDomainLists: async () => ({ ...lists }), writeDomainList: async (k, v) => { lists[k] = v; }, setSettings: async (id, v) => { stored[id] = v; } }, dir);
  srv.default.init({ id: "clean-titles", dir });
  srv.default.configure({});
  const send = async (seen, hit) => { await srv.routes.find((x) => x.path === "/seo").handler(new Request("http://l/seo", { method: "POST", body: JSON.stringify({ seen, hit }) })); await srv._sitesIdle(); };
  // junk.com: signs on 3 of 5 searches -> Lower after the 5th; ok.com: 1 of 5 -> nothing; mine.com (yours) never counted
  for (let i = 0; i < 5; i++) await send(["junk.com", "ok.com", "mine.com"], i < 3 ? { "junk.com": ["copy"], "mine.com": ["ai"] } : i === 4 ? { "ok.com": ["stale"] } : {});
  expect(lists.domainScoreList).toBe("mine.com|40\njunk.com|-40");
  const auto = JSON.parse(fs.readFileSync(path.join(dir, "sites-auto.json"), "utf8"));
  expect(auto["junk.com"]).toEqual({ seen: 5, hits: 3, auto: true });
  expect(auto["mine.com"]).toEqual({ seen: 0, hits: 0 });
  expect(JSON.parse(stored["clean-titles-command"].sites)).toContainEqual({ site: "junk.com", choice: "lower" });
  // You set junk.com to Normal: auto stops for it for good, even with more signs
  lists.domainScoreList = "mine.com|40";
  for (let i = 0; i < 6; i++) await send(["junk.com"], { "junk.com": ["copy"] });
  expect(lists.domainScoreList).toBe("mine.com|40");
  expect(JSON.parse(fs.readFileSync(path.join(dir, "sites-auto.json"), "utf8"))["junk.com"].off).toBe(true);
  // Switched off in Settings: nothing counted
  srv.default.configure({ autoLower: "false" });
  await send(["new.com"], { "new.com": ["ai"] });
  expect(JSON.parse(fs.readFileSync(path.join(dir, "sites-auto.json"), "utf8"))["new.com"]).toBeUndefined();
  srv.default.configure({});
});

test("server: shared fetch helper survives slow, empty, malformed and error answers", async () => {
  const srv = await import("../files/index.js");
  const answers = {
    "https://t/slow": (init) => new Promise((r, no) => { const t = setTimeout(() => r(new Response("late")), 300); init.signal.addEventListener("abort", () => { clearTimeout(t); no(init.signal.reason); }); }),
    "https://t/empty": () => new Response(""),
    "https://t/500": () => new Response("x", { status: 500 }),
    "https://t/throw": () => { throw new Error("dns"); },
    "https://t/etag": (init) => (init.headers["If-None-Match"] === '"v1"' ? new Response(null, { status: 304 }) : new Response("body", { headers: { etag: '"v1"' } })),
    "https://t/big": () => new Response("x".repeat(3000)),
  };
  srv.default.init({ id: "clean-titles", fetch: async (u, init) => answers[u](init) });
  expect((await srv.net("https://t/slow", { timeout: 50 })).status).toBe(0);
  expect(await srv.net("https://t/empty")).toEqual({ status: 200, text: "", etag: "" });
  expect((await srv.net("https://t/500")).status).toBe(500);
  expect((await srv.net("https://t/throw")).status).toBe(0);
  expect(await srv.net("https://t/etag")).toEqual({ status: 200, text: "body", etag: '"v1"' });
  expect((await srv.net("https://t/etag", { etag: '"v1"' })).status).toBe(304);
  expect((await srv.net("https://t/big", { max: 1000 })).status).toBe(0);
});

test("server: AI-image list: every list format parsed; downloaded again only when changed; a bad download keeps the old list", async () => {
  const srv = await import("../files/index.js");
  expect(srv.aiDomains("! comment\n*://*.aiart.com/*\n*://pics.gen.io/*\n0.0.0.0 www.fake.net\n||slop.org^\ngoogle.com##.g:has(a[href*=\"aislop.co\"])\nplain.ai\n# x\n[Adblock]")).toEqual(["aiart.com", "aislop.co", "fake.net", "pics.gen.io", "plain.ai", "slop.org"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-ai-"));
  const big = Array.from({ length: 1116 }, (_, i) => `*://*.ai${i}.com/*`).join("\n");
  let calls = [], mode = "ok";
  srv._setDegoog(null, dir);
  srv.default.init({ id: "clean-titles", dir, fetch: async (u, init) => {
    calls.push([u, init.headers["If-None-Match"] || ""]);
    if (mode === "down") throw new Error("offline");
    if (mode === "tiny") return new Response("<html>rate limited</html>", { headers: { etag: '"t"' } });
    if (init.headers["If-None-Match"] === '"e1"') return new Response(null, { status: 304 });
    return new Response(big, { headers: { etag: '"e1"' } });
  } });
  const a = await srv.aiRefresh();
  expect(a.list.length).toBe(1116);
  expect(calls.length).toBe(1);
  const route = srv.routes.find((x) => x.path === "/aiimg");
  const full = await (await route.handler(new Request("http://l/aiimg?v="))).json();
  expect(full.list.length).toBe(1116);
  expect(await (await route.handler(new Request(`http://l/aiimg?v=${full.v}`))).json()).toEqual({ v: full.v });
  calls = [];
  await srv.aiRefresh();
  expect(calls).toEqual([[a.url, '"e1"']]); // unchanged: one small request, nothing downloaded
  for (mode of ["down", "tiny"]) { await srv.aiRefresh(); expect(JSON.parse(fs.readFileSync(path.join(dir, "ai-images.json"), "utf8")).list.length).toBe(1116); }
});

test("installer: ai-summary's 2-minute cache line becomes degoog's TTL_MS (exactly one match; 0 or many -> untouched + notice)", () => {
  const { execFileSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-ai-ttl-"));
  const plug = path.join(dir, "degoog-org-official-extensions-ai-summary");
  fs.mkdirSync(plug);
  // The three lines recorded from the user's server (rec: plugins[...ai-summary].ttl), in a file around them
  const real = "const A = 1;\nconst SHORT_TTL_MS = 2 * 60 * 1000;\nfunction x(ctx) {\n    return ctx.useCache(SUMMARY_NAMESPACE, SHORT_TTL_MS);\n    const sync = ctx.createCache(SHORT_TTL_MS);\n}\n";
  fs.writeFileSync(path.join(plug, "index.js"), real);
  const run = (env = {}) => execFileSync("bun", [path.join(import.meta.dir, "../files/aittl.js")], { env: { ...process.env, DEGOOG_PLUGINS_DIR: dir, ...env } }).toString();
  expect(run()).toContain("now keeps answers as long as search results");
  const out = fs.readFileSync(path.join(plug, "index.js"), "utf8");
  expect(out.split("\n")[1]).toContain("DEGOOG_CACHE_TTL_MS");
  expect(out.replace(out.split("\n")[1], "")).toBe(real.replace(real.split("\n")[1], ""));
  // The patched line evaluates to 12 h, or to DEGOOG_CACHE_TTL_MS when set
  const val = (env) => execFileSync("bun", ["-e", `${out.split("\n")[1]}; console.log(SHORT_TTL_MS)`], { env: { ...process.env, ...env } }).toString().trim();
  expect(val({ DEGOOG_CACHE_TTL_MS: "" })).toBe(String(12 * 3600 * 1000));
  expect(val({ DEGOOG_CACHE_TTL_MS: "60000" })).toBe("60000");
  expect(run()).toContain("already");
  fs.writeFileSync(path.join(plug, "index.js"), real + real);
  expect(run()).toContain("found 2 copies");
  expect(fs.readFileSync(path.join(plug, "index.js"), "utf8")).toBe(real + real);
  fs.writeFileSync(path.join(plug, "index.js"), "const SHORT_TTL_MS = 5 * 60 * 1000;\n");
  expect(run()).toContain("found 0 copies");
});
