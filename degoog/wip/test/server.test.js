// Server plugin (files/index.js) routes that need no network
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
