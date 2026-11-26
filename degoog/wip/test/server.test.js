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

test("server: ai-summary status mirrors its trigger (model set, not off, questions only)", async () => {
  const srv = await import("../files/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-aist-"));
  const put = (v) => fs.writeFileSync(path.join(dir, "plugin-settings.json"), JSON.stringify(v));
  expect(srv.aiStatus(dir)).toEqual({ on: false });
  put({ "ai-summary-slot": { model: "llama3", questionMarkOnly: "false" } });
  expect(srv.aiStatus(dir)).toEqual({ on: true, qmark: false });
  put({ "ai-summary-slot": { model: "llama3", questionMarkOnly: "true" } });
  expect(srv.aiStatus(dir)).toEqual({ on: true, qmark: true });
  put({ "ai-summary-slot": { model: "llama3", disabled: "true" } });
  expect(srv.aiStatus(dir)).toEqual({ on: false });
  put({ "ai-summary-slot": { model: " " } });
  expect(srv.aiStatus(dir)).toEqual({ on: false });
});

test("server: ECB rates: parsed with a shape check, fetched only when a newer publication is due, kept on failure", async () => {
  const srv = await import("../files/index.js");
  const xml = `<?xml version="1.0"?><gesmes:Envelope><Cube><Cube time='2026-11-20'>${["USD|1.0512", "JPY|160.5", "GBP|0.8312", ...Array.from({ length: 27 }, (_, i) => `X${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}|${i + 1}`)].map((x) => `<Cube currency='${x.split("|")[0]}' rate='${x.split("|")[1]}'/>`).join("")}</Cube></Cube></gesmes:Envelope>`;
  expect(srv.parseEcb(xml).rates.USD).toBe(1.0512);
  expect(srv.parseEcb("<html>busy</html>")).toBe(null);
  // Due dates (Berlin time): Mon 2026-11-23 10:00 UTC = 11:00 CET -> Friday's; 16:30 CET -> today's; Sunday -> Friday's
  expect(srv.ecbDue(Date.parse("2026-11-23T10:00:00Z"))).toBe("2026-11-20");
  expect(srv.ecbDue(Date.parse("2026-11-23T15:30:00Z"))).toBe("2026-11-23");
  expect(srv.ecbDue(Date.parse("2026-11-22T20:00:00Z"))).toBe("2026-11-20");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-fx-"));
  let calls = 0, mode = "ok";
  srv._setDegoog(null, dir);
  srv.default.init({ id: "clean-titles", dir, fetch: async () => { calls++; if (mode === "down") throw new Error("x"); return new Response(xml, { headers: { etag: '"f1"' } }); } });
  const a = await srv.fxRefresh(Date.parse("2026-11-23T10:00:00Z"));
  expect(a.date).toBe("2026-11-20");
  expect(calls).toBe(1);
  await srv.fxRefresh(Date.parse("2026-11-23T12:00:00Z")); // nothing newer due: no request
  expect(calls).toBe(1);
  mode = "down";
  const b = await srv.fxRefresh(Date.parse("2026-11-23T16:00:00Z")); // due, ECB unreachable: old rates kept
  expect(calls).toBe(2);
  expect(b.date).toBe("2026-11-20");
});

test("server: endoflife.date cycles from either API shape, RAM-cached, failures hidden and retried soon", async () => {
  const srv = await import("../files/index.js");
  expect(srv.eolCycles([{ cycle: "3.14", releaseDate: "2025-10-07", eol: "2030-10-31", latest: "3.14.1", latestReleaseDate: "2026-11-18", lts: false }])).toEqual([{ cycle: "3.14", releaseDate: "2025-10-07", eol: "2030-10-31", latest: "3.14.1", latestReleaseDate: "2026-11-18" }]);
  expect(srv.eolCycles({ result: { releases: [{ name: "26", releaseDate: "2025-09-15", isEol: false, eolFrom: null, latest: { name: "26.1", date: "2026-11-03" } }] } })).toEqual([{ cycle: "26", releaseDate: "2025-09-15", eol: false, latest: "26.1", latestReleaseDate: "2026-11-03" }]);
  expect(srv.eolCycles({ error: "x" })).toBe(null);
  let calls = [];
  srv.default.init({ id: "clean-titles", fetch: async (u) => { calls.push(u); return u.includes("/api/ios.json") ? new Response("<html>moved</html>") : new Response(JSON.stringify({ result: { releases: [{ name: "26", latest: { name: "26.1", date: "2026-11-03" } }] } })); } });
  expect((await srv.eolFor("ios"))[0].latest).toBe("26.1");
  expect(calls.length).toBe(2); // v0 gave HTML, v1 answered
  await srv.eolFor("ios");
  expect(calls.length).toBe(2); // RAM cache
  expect(await srv.eolFor("../etc")).toBe(null);
  expect(calls.length).toBe(2);
});

test("server: Wikidata lookup sends only the subject, picks the current preferred claim, caches in RAM", async () => {
  const srv = await import("../files/index.js");
  const claim = (amount, rank, at, ended) => ({ rank, mainsnak: { snaktype: "value", datavalue: { value: { amount, unit: "1" } } }, qualifiers: { ...(at ? { P585: [{ datavalue: { value: { time: at } } }] } : {}), ...(ended ? { P582: [{}] } : {}) } });
  expect(srv.wdBest([claim("+1", "normal", "+2010-01-01T00:00:00Z"), claim("+2", "normal", "+2020-04-01T00:00:00Z"), claim("+3", "deprecated", "+2023-01-01T00:00:00Z")])[0].mainsnak.datavalue.value.amount).toBe("+2");
  const urls = [];
  srv.default.init({ id: "clean-titles", fetch: async (u, init) => {
    urls.push(u);
    expect(init.headers["User-Agent"]).toContain("degoog");
    const p = new URL(u).searchParams;
    if (p.get("action") === "wbsearchentities") return new Response(JSON.stringify({ search: [{ id: "Q1342", label: "Pittsburgh", description: "city in Pennsylvania" }] }));
    if (p.get("action") === "wbgetclaims") return new Response(JSON.stringify({ claims: { P1082: [claim("+300000", "normal", "+2010-04-01T00:00:00Z"), claim("+302971", "preferred", "+2020-04-01T00:00:00Z")] } }));
    return new Response("{}", { status: 500 });
  } });
  const d = await srv.wdFor("population", "pittsburgh");
  expect(d).toEqual({ label: "Pittsburgh", desc: "city in Pennsylvania", v: [{ amount: "+302971", unit: "1", asOf: "+2020-04-01T00:00:00Z" }] });
  expect(urls.length).toBe(2);
  expect(urls.every((u) => !u.includes("population"))).toBe(true); // the search words aren't sent, only the subject
  await srv.wdFor("population", "pittsburgh");
  expect(urls.length).toBe(2);
  expect(await srv.wdFor("shoe size", "pittsburgh")).toBe(null);
});

test("server: CMU course data cached in the plugin folder until the next semester; missing course -> null", async () => {
  const srv = await import("../files/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-cmu-"));
  const urls = [];
  srv._setDegoog(null, dir);
  srv.default.init({ id: "clean-titles", dir, fetch: async (u) => {
    urls.push(u);
    if (u.endsWith("/course/15-213")) return new Response(JSON.stringify({ course: { courseID: "15-213", name: "Introduction to Computer Systems", units: 12, prereqString: "15-122" } }));
    if (u.includes("/fces?courseID=15-213")) return new Response(JSON.stringify([{ year: 2026, semester: "spring", instructor: "RAILING, BRIAN", numRespondents: 100, responseRate: "50%", hrsPerWeek: 14, rating: [0, 0, 0, 0, 0, 0, 0, 4.4, 4.1], location: "Pittsburgh", extra: "x" }]));
    return new Response("not found", { status: 404 });
  } });
  const now = Date.parse("2026-11-23T10:00:00Z");
  const v = await srv.cmuFor("15-213", now);
  expect(v.course).toEqual({ name: "Introduction to Computer Systems", units: "12", prereqs: "15-122" });
  expect(v.fces[0].extra).toBeUndefined();
  expect(urls.length).toBe(2);
  expect(fs.existsSync(path.join(dir, "cmu-15-213.json"))).toBe(true);
  await srv.cmuFor("15-213", now + 30 * 86400000); // same semester: no request
  expect(urls.length).toBe(2);
  expect(await srv.cmuFor("15-999", now)).toBe(null); // the ZIP-code case: no such course
  const r = await (await srv.routes.find((x) => x.path === "/cmu").handler(new Request("http://l/cmu?id=15213"))).json();
  expect(r.c.course.name).toBe("Introduction to Computer Systems");
});

test("server: sports: team names from ESPN's lists (search stays here), live > recent > next game, logos signed", async () => {
  const srv = await import("../files/index.js");
  const teams = (arr) => ({ sports: [{ leagues: [{ teams: arr.map(([id, abbreviation, displayName, name, location]) => ({ team: { id, abbreviation, displayName, name, location } })) }] }] });
  const list = [...srv.espnTeams(teams([["23", "PIT", "Pittsburgh Steelers", "Steelers", "Pittsburgh"], ["19", "NYG", "New York Giants", "Giants", "New York"]]), "football/nfl", "NFL"), ...srv.espnTeams(teams([["26", "SF", "San Francisco Giants", "Giants", "San Francisco"]]), "baseball/mlb", "MLB")];
  expect(srv.teamFor("steelers", list).abbr).toBe("PIT");
  expect(srv.teamFor("pittsburgh steelers score", list).abbr).toBe("PIT");
  expect(srv.teamFor("giants", list)).toBe(null); // NFL and MLB: ambiguous
  expect(srv.teamFor("giants mlb", list).abbr).toBe("SF");
  expect(srv.teamFor("python", list)).toBe(null);
  const ev = (date, state, ps, os, detail) => ({ date, competitions: [{ status: { type: { state, shortDetail: detail } }, competitors: [{ homeAway: "home", winner: ps > os, score: { value: ps, displayValue: String(ps) }, team: { abbreviation: "PIT", shortDisplayName: "Steelers", logos: [{ href: "https://a.espncdn.com/i/teamlogos/nfl/500/pit.png" }] }, record: [{ displayValue: "7-3" }] }, { homeAway: "away", winner: os > ps, score: { value: os, displayValue: String(os) }, team: { abbreviation: "CLE", shortDisplayName: "Browns", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/cle.png" } }] }] });
  const now = Date.parse("2026-11-23T10:00:00Z");
  const evs = [ev("2026-11-16T18:00Z", "post", 20, 10, "Final"), ev("2026-11-22T18:00Z", "post", 24, 17, "Final"), ev("2026-11-30T18:00Z", "pre", 0, 0, "Sun 1:00 PM")];
  expect(srv.pickGame(evs, now).date).toBe("2026-11-22T18:00Z");
  expect(srv.pickGame(evs, Date.parse("2026-11-26T10:00:00Z")).date).toBe("2026-11-30T18:00Z");
  expect(srv.pickGame([...evs, ev("2026-11-23T09:00Z", "in", 7, 3, "Q2 4:12")], now).date).toBe("2026-11-23T09:00Z");
  const g = srv.espnGame(evs[1], (u) => `/api/proxy/image?url=${encodeURIComponent(u)}&sig=x`);
  expect(g).toMatchObject({ state: "post", detail: "Final", home: { abbr: "PIT", score: "24", winner: true, record: "7-3" }, away: { abbr: "CLE", score: "17", winner: false } });
  expect(g.home.logo.startsWith("/api/proxy/image?url=")).toBe(true);
});

test("server: knowledge panel data: type from P31, facts per type with labels, as-of, metric + imperial, signed photo", async () => {
  const srv = await import("../files/index.js");
  const snak = (value, extra = {}) => ({ rank: "normal", mainsnak: { snaktype: "value", datavalue: { value } }, ...extra });
  const item = (id) => snak({ "entity-type": "item", id });
  const eiffel = { claims: { P31: [item("Q12518")], P131: [item("Q90")], P2048: [snak({ amount: "+330", unit: "http://www.wikidata.org/entity/Q11573" })], P1619: [snak({ time: "+1889-03-31T00:00:00Z", precision: 11 })], P84: [item("Q20882")], P18: [snak("Tour Eiffel Wikimedia Commons.jpg")] }, sitelinks: { enwiki: { title: "Eiffel Tower" } } };
  const plan = srv.kpPlan(eiffel);
  expect(plan.type).toBe("structure");
  expect(plan.title).toBe("Eiffel Tower");
  expect(plan.rows.map((r) => [r.k, srv.kpText(r, { Q90: "Paris", Q20882: "Stephen Sauvestre" })])).toEqual([["Location", "Paris"], ["Height", "330 m (1,083 ft)"], ["Opened", "Mar 31, 1889"], ["Architect", "Stephen Sauvestre"]]);
  const pgh = { claims: { P31: [item("Q1093829")], P17: [item("Q30")], P1082: [snak({ amount: "+300000" }, { qualifiers: { P585: [{ datavalue: { value: { time: "+2010-04-01T00:00:00Z" } } }] } }), snak({ amount: "+302971" }, { qualifiers: { P585: [{ datavalue: { value: { time: "+2020-04-01T00:00:00Z" } } }] } })], P2046: [snak({ amount: "+151.1", unit: "http://www.wikidata.org/entity/Q712226" })] }, sitelinks: { enwiki: { title: "Pittsburgh" } } };
  const p2 = srv.kpPlan(pgh);
  expect(p2.rows.map((r) => srv.kpText(r, { Q30: "United States" }))).toEqual(["United States", "302,971 (2020)", "151.1 km² (58.3 sq mi)"]);
  expect(srv.kpPlan({ claims: { P31: [item("Q999999")] } }).rows).toEqual([]);
  // Whole lookup with a fake network: 4 requests on the first search, none on the next
  const urls = [];
  srv.default.init({ id: "clean-titles", signProxyUrl: (u) => `/api/proxy/image?url=${encodeURIComponent(u)}&sig=s`, fetch: async (u) => {
    urls.push(u);
    const q = new URL(u);
    if (q.hostname === "en.wikipedia.org") return new Response(JSON.stringify({ description: "tower in Paris", extract: "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France." }));
    const a = q.searchParams.get("action");
    if (a === "wbsearchentities") return new Response(JSON.stringify({ search: [{ id: "Q243", label: "Eiffel Tower", description: "tower in Paris, France" }] }));
    if (a === "wbgetentities" && q.searchParams.get("ids") === "Q243") return new Response(JSON.stringify({ entities: { Q243: eiffel } }));
    if (a === "wbgetentities") return new Response(JSON.stringify({ entities: { Q90: { labels: { en: { value: "Paris" } } }, Q20882: { labels: { en: { value: "Stephen Sauvestre" } } } } }));
    return new Response("", { status: 404 });
  } });
  const kp = await srv.kpFor("eiffel tower");
  expect(kp).toMatchObject({ qid: "Q243", title: "Eiffel Tower", name: "Eiffel Tower", type: "structure", desc: "tower in Paris, France" });
  expect(kp.facts[0]).toEqual({ k: "Location", v: "Paris" });
  expect(kp.extract.startsWith("The Eiffel Tower")).toBe(true);
  expect(kp.photo.startsWith("/api/proxy/image?url=")).toBe(true);
  expect(urls.length).toBe(4);
  await srv.kpFor("Eiffel Tower");
  expect(urls.length).toBe(4);
});

test("Bing suggestions: exponential backoff from 1 minute, capped at 1 hour", async () => {
  const srv = await import("../files/index.js");
  expect([1, 2, 3, 4, 6, 7, 20].map(srv.bingBackoff)).toEqual([60000, 120000, 240000, 480000, 1920000, 3600000, 3600000]);
});

test("archived copy: parallel lookup, paywall order, save page when none has it", async () => {
  const srv = await import("../files/index.js");
  const seen = [];
  const fake = (have) => async (u, init) => {
    seen.push(u);
    const q = new URL(u);
    if (q.hostname === "archive.ph") return have.today ? new Response(null, { status: 302, headers: { location: "https://archive.ph/AbC12" } }) : new Response("", { status: 404 });
    if (q.hostname === "archive.org") return new Response(JSON.stringify({ archived_snapshots: have.wb ? { closest: { available: true, url: "http://web.archive.org/web/20240101000000/https://x.com/a", timestamp: "20240101000000", status: "200" } } : {} }));
    if (q.hostname === "ghostarchive.org") return new Response(have.ghost ? '<a href="/archive/Zy9x1">x</a>' : "<p>No archives</p>");
    return new Response("", { status: 404 });
  };
  srv.default.init({ id: "clean-titles", fetch: fake({ today: true, wb: true, ghost: true }) });
  expect(await srv.archFind("https://www.nytimes.com/2026/1/a.html", true)).toEqual({ url: "https://archive.ph/AbC12", src: "archive.today" });
  expect(await srv.archFind("https://x.com/a", false)).toEqual({ url: "https://web.archive.org/web/20240101000000/https://x.com/a", src: "Wayback Machine" });
  const n = seen.length;
  await srv.archFind("https://x.com/a", false); // cached
  expect(seen.length).toBe(n);
  srv.default.init({ id: "clean-titles", fetch: fake({ ghost: true }) });
  expect(await srv.archFind("https://y.com/b", false)).toEqual({ url: "https://ghostarchive.org/archive/Zy9x1", src: "Ghostarchive" });
  srv.default.init({ id: "clean-titles", fetch: fake({}) });
  expect(await srv.archFind("https://z.com/c?d=1", true)).toEqual({ url: "https://archive.ph/?url=https%3A%2F%2Fz.com%2Fc%3Fd%3D1", src: "save" });
  expect(await srv.archFind("javascript:alert(1)", true)).toBeNull();
  // A redirect elsewhere (captcha page) is not a copy
  srv.default.init({ id: "clean-titles", fetch: async (u) => (new URL(u).hostname === "archive.ph" ? new Response(null, { status: 302, headers: { location: "https://archive.ph/challenge?x" } }) : new Response("{}")) });
  expect((await srv.archFind("https://w.com/e", true)).src).toBe("save");
});

test("quick view: JSON-LD recipe/FAQ/article/product, main text fallback, JS-only pages give nothing", async () => {
  const srv = await import("../files/index.js");
  expect(["PT1H30M", "PT45M", "P0DT2H", "PT0S", "bad", "P1D"].map(srv.isoDur)).toEqual(["1 hr 30 min", "45 min", "2 hr", "", "", "24 hr"]);
  const ld = (o) => `<html><head><script type="application/ld+json">${JSON.stringify(o)}</script></head><body><div id=app></div></body></html>`;
  const recipe = srv.qvFrom(ld({ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, { "@type": "Recipe", name: "Chewy Chocolate Chip Cookies", totalTime: "PT1H15M", recipeYield: ["24", "24 cookies"], aggregateRating: { ratingValue: "4.9", ratingCount: "3120" }, recipeIngredient: ["2 cups flour", "1 cup <b>butter</b>"], recipeInstructions: [{ "@type": "HowToSection", name: "Dough", itemListElement: [{ "@type": "HowToStep", text: "Whisk the flour." }, { "@type": "HowToStep", text: "Cream the butter &amp; sugar." }] }, "Bake 12 minutes."] }] }));
  expect(recipe.kind).toBe("recipe");
  expect(recipe.facts).toEqual([["Rating", "4.9 ★ (3,120)"], ["Total time", "1 hr 15 min"], ["Serves", "24"]]);
  expect(recipe.lists).toEqual([{ label: "ingredients", items: ["2 cups flour", "1 cup butter"] }, { label: "steps", items: ["Whisk the flour.", "Cream the butter & sugar.", "Bake 12 minutes."], ordered: true }]);
  const faq = srv.qvFrom(ld({ "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Is it free?", acceptedAnswer: { "@type": "Answer", text: "<p>Yes, always.</p>" } }] }));
  expect(faq.lists[0]).toEqual({ label: "questions", items: ["Is it free?\nYes, always."], qa: true });
  const prod = srv.qvFrom(ld({ "@type": "Product", name: "Keyboard", brand: { "@type": "Brand", name: "Keychron" }, offers: { price: "99.00", priceCurrency: "USD" }, aggregateRating: { ratingValue: 9, bestRating: 10, reviewCount: 12 } }));
  expect(prod.facts).toEqual([["Rating", "4.5 ★ (12)"], ["Brand", "Keychron"]]);
  expect(JSON.stringify(prod)).not.toContain("99");
  const para = "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France, named after Gustave Eiffel.";
  const art = srv.qvFrom(`<script type="application/ld+json">{"@type":"NewsArticle","headline":"Big news","author":[{"@type":"Person","name":"Ann Lee"}],"datePublished":"2026-11-20T10:00:00Z","wordCount":1150,"isAccessibleForFree":false}</script><article><p>${para}</p><p>Short.</p></article>`);
  expect(art.facts).toEqual([["By", "Ann Lee"], ["Published", "Nov 20, 2026"], ["Reading time", "5 min"], ["Access", "Paywall"]]);
  expect(art.text).toEqual([para]);
  expect(srv.qvFrom(`<main><p>${para}</p></main>`)).toEqual({ kind: "page", title: "", facts: [], lists: [], text: [para] });
  expect(srv.qvFrom('<div id="root"></div><script src="app.js"></script>')).toBeNull();
  expect(srv.qvFrom('<script type="application/ld+json">{bad json</script>')).toBeNull();
});

test("quick view: never fetches this server's own network; follows redirects with a check at every hop", async () => {
  const srv = await import("../files/index.js");
  for (const u of ["http://localhost/x", "http://127.0.0.1/", "http://192.168.1.5/admin", "http://[::1]/", "ftp://x.com/", "http://nas.local/", "http://user:pw@example.com/", "http://example.com:8080/"]) expect([u, await srv.publicUrl(u)]).toEqual([u, false]);
  const seen = [];
  srv.default.init({ id: "clean-titles", fetch: async (u) => {
    seen.push(u);
    if (u === "https://a.com/r") return new Response(null, { status: 301, headers: { location: "/final" } });
    if (u === "https://a.com/final") return new Response('<script type="application/ld+json">{"@type":"HowTo","name":"Reset","step":[{"@type":"HowToStep","text":"Hold the button."}]}</script>');
    if (u === "https://b.com/r") return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } });
    return new Response("", { status: 404 });
  } });
  const ok = (u) => Promise.resolve(!/10\.0\.0\.1/.test(u));
  expect((await srv.qvFor("https://a.com/r", ok)).lists[0].items).toEqual(["Hold the button."]);
  expect(await srv.qvFor("https://b.com/r", ok)).toBeNull();
  expect(seen).toEqual(["https://a.com/r", "https://a.com/final", "https://b.com/r"]);
});

test("inline stars: rating + time for recipes, rating for reviews; blocking sites skipped after 3 failures", async () => {
  const srv = await import("../files/index.js");
  expect(srv.starLine({ kind: "recipe", facts: [["Rating", "4.9 ★ (3,120)"], ["Total time", "1 hr 15 min"]] })).toBe("4.9 ★ · 1 hr 15 min");
  expect(srv.starLine({ kind: "product", facts: [["Rating", "4.5 ★ (12)"], ["Brand", "K"]] })).toBe("4.5 ★");
  expect(srv.starLine({ kind: "article", facts: [["By", "x"]] })).toBe("");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-qvs-"));
  let n = 0;
  srv.default.init({ id: "clean-titles", dir, fetch: async (u) => { n++; return /good\.com/.test(u) ? new Response('<script type="application/ld+json">{"@type":"Recipe","name":"x","totalTime":"PT30M","aggregateRating":{"ratingValue":4.8,"ratingCount":10}}</script>') : new Response("", { status: 403 }); } });
  const ok = () => Promise.resolve(true);
  expect(await srv.starsFor(["https://good.com/a", "https://blocker.com/1"], ok)).toEqual({ "https://good.com/a": "4.8 ★ · 30 min" });
  await srv.starsFor(["https://blocker.com/2"], ok);
  await srv.starsFor(["https://blocker.com/3"], ok);
  expect(srv.qvBlocked("blocker.com")).toBe(true);
  const before = n;
  await srv.starsFor(["https://blocker.com/4"], ok);
  expect(n).toBe(before); // not asked any more
  expect(srv.qvBlocked("good.com")).toBe(false);
});

test("typo fixer data is fetched by the plugin when missing (not by the installer); names made in a separate process", async () => {
  const srv = await import("../files/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-data-"));
  fs.writeFileSync(path.join(dir, "names.js"), "// helper");
  const asked = [], spawned = [];
  srv.default.init({ id: "clean-titles", dir, fetch: async (u) => { asked.push(u); return new Response(Array.from({ length: /bigram/.test(u) ? 200001 : 50001 }, (_, i) => `w${i} ${i}`).join("\n")); } });
  const ok = await srv.ensureData((cmd) => { spawned.push(cmd); fs.writeFileSync(path.join(dir, "names.txt"), "openai"); return { exited: Promise.resolve(0) }; });
  expect(ok).toBe(true);
  expect(asked.map((u) => u.split("/").pop())).toEqual(["frequency_dictionary_en_82_765.txt", "frequency_bigramdictionary_en_243_342.txt"]);
  expect(spawned[0]).toEqual(["bun", path.join(dir, "names.js")]);
  expect(fs.readFileSync(path.join(dir, "words.txt"), "utf8").split("\n").length).toBe(50001);
});

test("page part check: a degoog update that wiped layout.html's block or the psl file is reported in Settings", async () => {
  const srv = await import("../files/index.js");
  const ok = '<body>x<script defer src="/public/ct/psl.0123456789ab.js" id="ct-psl"></script>\n<script type="module" id="ct-inline">const a=1;\n</script>\n</body>';
  const yes = () => true, no = () => false;
  expect(srv.pagePartMissing(ok, yes)).toBe(false);
  expect(srv.pagePartMissing(ok, no)).toBe(true); // psl file gone
  expect(srv.pagePartMissing("<body>stock degoog page</body>", yes)).toBe(true);
  expect(srv.pagePartMissing('<script type="module" id="ct-inline">x\n</script>', yes)).toBe(true); // v49 block, no psl tag
  expect(srv.pagePartMissing(undefined, yes)).toBe(false); // unreadable: no warning
  // Same tags inline.js writes
  const inl = fs.readFileSync(new URL("../files/inline.js", import.meta.url), "utf8");
  expect(inl).toContain('id="ct-psl"></script>\\n<script type="module" src="${ctUrl}" id="ct-inline"></script>');
  // Page script as a cached file (current installs)
  const ext = '<head><link rel="modulepreload" href="/public/ct/ct.aaaaaaaaaaaa.js" id="ct-pre">\n</head><body><script defer src="/public/ct/psl.0123456789ab.js" id="ct-psl"></script>\n<script type="module" src="/public/ct/ct.aaaaaaaaaaaa.js" id="ct-inline"></script></body>';
  expect(srv.pagePartMissing(ext, yes)).toBe(false);
  expect(srv.pagePartMissing(ext, (p) => !p.includes("/ct.aaaa"))).toBe(true); // page script file gone
  expect(srv.PAGE_MISSING).toBe(false); // no layout.html in tests
  expect(srv.default.description.startsWith("Google-style")).toBe(true);
});

test("self-check fixes: subclass type (suspension bridge), Wikidata next item when the top one has no value, reasons", async () => {
  const srv = await import("../files/index.js");
  const snak = (value, extra = {}) => ({ rank: "normal", mainsnak: { snaktype: "value", datavalue: { value } }, ...extra });
  const item = (id) => snak({ "entity-type": "item", id });
  const ggb = { claims: { P31: [item("Q12570")], P131: [item("Q62")] }, sitelinks: { enwiki: { title: "Golden Gate Bridge" } } };
  expect(srv.kpPlan(ggb).type).toBe("");
  expect(srv.kpPlan(ggb, { Q12570: ["Q12280"] }).type).toBe("structure");
  // population: top hit has no P1082 and a qualifier without a value -> second hit answers
  const claim = { rank: "normal", mainsnak: { snaktype: "value", datavalue: { value: { amount: "+302971", unit: "1" } } }, qualifiers: { P585: [{ snaktype: "somevalue" }] } };
  srv.default.init({ id: "clean-titles", fetch: async (u) => {
    const p = new URL(u).searchParams;
    if (p.get("action") === "wbsearchentities") return new Response(JSON.stringify({ search: [{ id: "Q1", label: "Pittsburgh" }, { id: "Q1342", label: "Pittsburgh", description: "city" }] }));
    if (p.get("action") === "wbgetclaims") return new Response(JSON.stringify({ claims: p.get("entity") === "Q1342" ? { P1082: [claim] } : {} }));
    return new Response("", { status: 404 });
  } });
  const d = await srv.wdFor("population", "pittsburgh x");
  expect(d.v[0].amount).toBe("+302971");
  expect(d.v[0].asOf).toBeUndefined();
  srv.default.init({ id: "clean-titles", fetch: async () => new Response("", { status: 403 }) });
  expect(await srv.wdFor("population", "nowhere y")).toBe(null);
  expect(srv.WHY.wd).toContain("http 403");
});

test("video still for YouTube cards: only an 11-character id, signed for degoog's image proxy", async () => {
  const srv = await import("../files/index.js");
  srv.default.init({ id: "clean-titles", signProxyUrl: (u) => `/api/proxy/image?url=${encodeURIComponent(u)}&sig=s` });
  const r = await srv.default.execute("bridge yt id=8lnlUrHBqOE");
  expect(JSON.parse(r.html.replace(/&amp;/g, "&")).to).toBe("/api/proxy/image?url=https%3A%2F%2Fi.ytimg.com%2Fvi%2F8lnlUrHBqOE%2Fhqdefault.jpg&sig=s");
  const bad = await srv.default.execute("bridge yt id=..%2Fetc");
  expect(JSON.parse(bad.html).status).toBe(400);
});

test("net: a 403 is asked once more through degoog's curl-impersonate transport (only when asked for)", async () => {
  const srv = await import("../files/index.js");
  const seen = [];
  srv.default.init({ id: "clean-titles", fetch: async (u, init, transport) => { seen.push(transport || "fetch"); return transport === "curl-impersonate" ? new Response("ok") : new Response("", { status: 403 }); } });
  expect((await srv.net("https://x.test/", { imp: true })).text).toBe("ok");
  expect(seen).toEqual(["fetch", "curl-impersonate"]);
  expect((await srv.net("https://x.test/")).status).toBe(403);
  expect(seen.length).toBe(3);
});

test("load timings: only numbers kept, last 60, nothing else stored", async () => {
  const srv = await import("../files/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-perf-"));
  srv.default.init({ id: "clean-titles", dir });
  const body = JSON.stringify({ dev: "phone", nav: { wait: 0, dns: 12, ready: 340, type: "navigate", q: "secret search" }, search: { wait: 900, total: 420, url: "x" } });
  await srv.default.execute(`bridge perf ${new URLSearchParams({ __body: body })}`);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "perf.json"), "utf8"));
  expect(saved[0].dev).toBe("phone");
  expect(saved[0].nav).toEqual({ wait: 0, dns: 12, ready: 340, type: "navigate" });
  expect(JSON.stringify(saved)).not.toContain("secret");
});

test("server: DOI publisher names (Crossref prefix list), trending words, slow rank kept for the next request", async () => {
  const srv = await import("../files/index.js");
  expect(srv.doiNice("Elsevier BV")).toBe("Elsevier");
  expect(srv.doiNice("Institute of Electrical and Electronics Engineers (IEEE)")).toBe("IEEE");
  expect(srv.doiNice("Springer Science and Business Media LLC")).toBe("Springer Science and Business Media");
  expect(srv.doiPrefixOf("https://doi.org/10.9999/abc.1")).toBe("10.9999");
  expect(srv.doiPrefixOf("https://example.com/10.9999/abc")).toBe("");
  expect(srv.trendWords(["Main_Page", "Special:Search", "Kalimba", "Taylor_Swift", "AI", "2026_in_film", "Dune_(2021_film)"]).sort()).toEqual(["ai", "dune", "film", "kalimba", "swift", "taylor"].sort());
  // Fake network: Crossref answers at once; ct-vision answers after 2.2 s (longer than the 1.6 s wait)
  const real = globalThis.fetch; let ranks = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api.crossref.org/prefixes/10.9999")) return new Response(JSON.stringify({ message: { name: "Acme Press Ltd." } }));
    if (u.includes("/rank")) { ranks++; await new Promise((r) => setTimeout(r, 2200)); return new Response(JSON.stringify({ s: [0.9, 0.1], ms: 2200 })); }
    return new Response("", { status: 404 });
  };
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-doi-"));
  srv.default.init({ id: "clean-titles", dir: tdir, fetch: globalThis.fetch });
  try {
    const mk = () => ({ results: [{ url: "https://doi.org/10.9999/x.1", title: "A study of kalimba", snippet: "Kalimba tines vibrate." }, { url: "https://example.com/a", title: "B", snippet: "Other." }] });
    const a = mk(); await globalThis.__ctResults(a, "kalimba physics", { type: "science" });
    expect(a.results[0].ctPub).toBe("Acme Press");
    expect(a.ctPub).toBe(1);
    expect(a.ctAi).toBeUndefined(); // too slow for this response...
    await new Promise((r) => setTimeout(r, 1000));
    const b = mk(); await globalThis.__ctResults(b, "kalimba physics", { type: "science" });
    expect(b.ctAi).toBe(1); // ...but kept, so the same results one request later have it at once
    expect(b.results[0].ctRel).toBe(0.9);
    expect(ranks).toBe(1);
  } finally { globalThis.fetch = real; }
}, 15000);

test("server: product panel: manufacturer makes a product, dates to the month, launch price by currency label, infobox specs", async () => {
  const srv = await import("../files/index.js");
  const snak = (value) => ({ rank: "normal", mainsnak: { snaktype: "value", datavalue: { value } } });
  const item = (id) => snak({ "entity-type": "item", id });
  const ph = { claims: { P31: [item("Q19723451")], P176: [item("Q312")], P577: [snak({ time: "+2023-09-22T00:00:00Z", precision: 11 })], P2669: [snak({ time: "+2024-09-00T00:00:00Z", precision: 10 })], P2284: [snak({ amount: "+999", unit: "http://www.wikidata.org/entity/Q4917" })], P2928: [snak({ amount: "+8", unit: "http://www.wikidata.org/entity/Q79738" })], P856: [snak("https://www.apple.com/iphone-15-pro/")] }, sitelinks: { enwiki: { title: "iPhone 15 Pro" } } };
  const plan = srv.kpPlan(ph);
  expect(plan.type).toBe("product");
  expect(plan.site).toBe("https://www.apple.com/iphone-15-pro/");
  expect(plan.rows.map((r) => [r.k, srv.kpText(r, { Q312: "Apple", Q4917: "United States dollar", Q79738: "gigabyte" })])).toEqual([["Released", "Sep 22, 2023"], ["Discontinued", "Sep 2024"], ["Launch price", "$999"], ["Manufacturer", "Apple"], ["Memory", "8 GB"]]);
  // A company is still a company, not a product
  expect(srv.kpPlan({ claims: { P31: [item("Q4830453")], P1716: [item("Q1")] } }).type).toBe("company");
  const wt = `'''iPhone 15 Pro''' {{Infobox mobile phone
| name = iPhone 15 Pro
| released = {{Start date|2023|9|22}}<ref>{{cite web|url=x|title=y}}</ref>
| discontinued = {{End date|2024|9|9}}
| price = 15 Pro: {{US$|999}}<br />15 Pro Max: {{US$|1199}}
| soc = [[Apple A17 Pro|Apple A17 Pro]]
| memory = 8&nbsp;GB [[LPDDR5]]
| storage = {{ubl|128 GB|256 GB|512 GB|1 TB}}
| weight = {{convert|187|g|oz|abbr=on}}
| display = 6.1 in<!-- note -->
| colors = Black Titanium
}}
The iPhone 15 Pro is...`;
  expect(srv.kpInfobox(wt)).toEqual([{ k: "Released", v: "Sep 22, 2023" }, { k: "Discontinued", v: "Sep 9, 2024" }, { k: "Launch price", v: "15 Pro: $999, 15 Pro Max: $1199" }, { k: "Processor", v: "Apple A17 Pro" }, { k: "Memory", v: "8 GB LPDDR5" }, { k: "Storage", v: "128 GB, 256 GB, 512 GB, 1 TB" }, { k: "Weight", v: "187 g" }, { k: "Display", v: "6.1 in" }]);
  expect(srv.kpInfobox("no infobox here")).toEqual([]);
});

import { NEEDS, needsParse } from "../files/index.js";
test("needs: one batched pass parses into format shares, needs and block fits", () => {
  const n = Object.values(NEEDS).reduce((a, [, o]) => a + Object.keys(o).length, 0);
  const v = needsParse(Array.from({ length: n }, (_, i) => (i === 0 ? 0.6 : 0.2)));
  expect(v.f.video + v.f.image + v.f.text).toBeCloseTo(1);
  expect(v.f.video).toBeCloseTo(0.6);
  expect(Object.keys(v.n)).toContain("fresh");
  expect(Object.keys(v.b)).toContain("forums");
  expect(needsParse([0.1])).toBe(null);
});

test("M2: first-screen cutoff store keeps a running median", async () => {
  const fs2 = await import("node:fs"), os2 = await import("node:os"), path2 = await import("node:path");
  const srv2 = await import("../files/index.js");
  srv2._setDegoog({}, fs2.mkdtempSync(path2.join(os2.tmpdir(), "ct-cut-")));
  srv2._cutReset();
  expect(srv2.cutNow()).toBe(null);
  for (const w of [0.3, 0.1, 0.2]) expect(srv2.cutAdd(w)).toBe(true);
  expect(srv2.cutAdd("x")).toBe(false);
  expect(srv2.cutAdd(3)).toBe(false);
  expect(srv2.cutNow()).toBeCloseTo(0.2);
  const r = srv2.routes.find((x) => x.path === "/cut");
  const j = await (await r.handler(new Request("http://local/cut?w=0.4"))).json();
  expect(j.cut).toBeCloseTo(0.25);
  srv2._cutReset();
  expect(srv2.cutNow()).toBeCloseTo(0.25); // read back from cut.json
});
