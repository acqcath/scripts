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
  expect(j).toEqual({ sites: { "pinterest.com": "hide", "wikipedia.org": "prefer", "w3schools.com": "lower" } });
  for (const [b, s] of [["a.com\n||b.com^\nC.org", "d.net|5\ne.io|-1\nf.com|0\ng|3"], ["", ""], ["x.com", "x.com|9"]]) expect(srv.sitesFromLists(b, s)).toEqual(core.sitesFromLists(b, s));
  // No lists file: falls back to the older place (server-settings.json), else nothing
  fs.rmSync(path.join(dir, "search"), { recursive: true });
  const k = await (await r.handler(new Request("http://local/sites"))).json();
  expect(k).toEqual({ sites: {} });
  delete process.env.DEGOOG_DATA_DIR;
});
