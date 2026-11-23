// clean-titles installer: Safe Search off on every installed engine that has a Safe Search setting (the user's
// standing choice, 2026-11-23: no one else's filter on what they can search). Runs before the restart, like aittl.js.
// Only the safeSearch value of those engines' settings is touched; everything else in plugin-settings.json stays.
const fs = require("fs");
const path = require("path");
const DATA = process.env.DEGOOG_DATA_DIR || "/app/data";
const ED = process.env.DEGOOG_ENGINES_DIR || `${DATA}/engines`;
const SF = process.env.DEGOOG_PLUGIN_SETTINGS_FILE || `${DATA}/plugin-settings.json`;
let store = {};
if (fs.existsSync(SF)) {
  try { store = JSON.parse(fs.readFileSync(SF, "utf8")) || {}; } catch { console.log("Safe Search: NOTICE plugin-settings.json could not be read, nothing changed"); process.exit(0); }
}
let dirs = [];
try { dirs = fs.readdirSync(ED, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
const changed = [];
let found = 0;
for (const d of dirs) {
  let has = false;
  for (const f of ["settings.js", "index.js"]) { try { if (/key:\s*["']safeSearch["']/.test(fs.readFileSync(path.join(ED, d, f), "utf8"))) has = true; } catch {} }
  if (!has) continue;
  found++;
  const id = d.toLowerCase().endsWith("-engine") ? d.toLowerCase() : `${d.toLowerCase()}-engine`;
  const key = Object.keys(store).find((k) => k.toLowerCase() === id) || id;
  const cur = store[key] && typeof store[key] === "object" ? store[key] : {};
  if (cur.safeSearch === "off") continue;
  store[key] = { ...cur, safeSearch: "off" };
  changed.push(`${d.replace(/^degoog-org-official-extensions-/, "")} (was ${cur.safeSearch || "its default"})`);
}
// SearXNG engines degoog runs through its compatibility layer: one <code>.py each, settings id searx-<code>-engine;
// every one has the Safe Search setting (default "moderate" for image/video engines)
const SX = process.env.DEGOOG_SEARX_ENGINES_DIR || `${DATA}/searx/engines`;
let sx = [];
try { sx = fs.readdirSync(SX).filter((f) => /\.py$/.test(f) && !f.startsWith("_")).map((f) => f.slice(0, -3)); } catch {}
for (const code of sx) {
  found++;
  const id = `searx-${code}-engine`.toLowerCase();
  const key = Object.keys(store).find((k) => k.toLowerCase() === id) || id;
  const cur = store[key] && typeof store[key] === "object" ? store[key] : {};
  if (cur.safeSearch === "off") continue;
  store[key] = { ...cur, safeSearch: "off" };
  changed.push(`searx ${code} (was ${cur.safeSearch || "its default"})`);
}
// One rule for every installed engine, set from the user's own recorded searches (60 web searches, 2026-11-23):
// - score: general web engines 1; specialist sources (Wikipedia, Reddit, Hacker News, Lemmy, The Guardian, archives,
//   media libraries) 0.25. degoog ranks by (10 - position) x score; with the ~30 results a first page has here, a
//   specialist's best hit lands at #17 at 0.25 (#12 at 0.5, #2 at 1): on the first page, under the general answers.
//   The knowledge panel already brings Wikipedia's summary to the top for things and people, so the article itself
//   doesn't need to be high, and for other searches a specialist's loose match is mostly noise.
// - timeout 2000 ms. It only matters when an engine misbehaves (hangs, rate-limits, serves a captcha): then every
//   search waits the full timeout and shows the other engines' results. So it should be as short as possible without
//   cutting a healthy answer. Measured worst cases on this server: Bing 674 ms, Startpage 625 ms (60 searches each),
//   Brave News 1,029 ms. A blocked first try retried with curl ("curl-fallback") takes about two normal requests,
//   ~1.3 s for the web engines, so 2 s keeps those and caps a bad case at 2 s instead of degoog's default 10 s.
<<<<<<< HEAD
// - outgoing client: the engine's own setting is kept (the user picked what works); unset -> "curl-fallback".
//   Brave always "curl-impersonate": measured on the user's server, Brave returned 0 results with curl-fallback
//   (it turns away anything that doesn't look like a browser).
=======
// - outgoing client "curl-fallback" (plain fetch, retried with curl when a site answers 403/429/5xx)
>>>>>>> origin/main
const SPECIAL = /(?:^|-)(?:wikipedia|reddit|hacker-news|lemmy|the-guardian|internet-archive|wikimedia-commons|openverse|nasa-images|immich)$/i;
const tuned = [];
for (const d of dirs) {
  const id = d.toLowerCase().endsWith("-engine") ? d.toLowerCase() : `${d.toLowerCase()}-engine`;
  const key = Object.keys(store).find((k) => k.toLowerCase() === id) || id;
  const cur = store[key] && typeof store[key] === "object" ? store[key] : {};
<<<<<<< HEAD
  const want = { score: SPECIAL.test(d) ? "0.25" : "1", timeoutMs: "2000", outgoingTransport: /(?:^|-)brave(?:-|$)/i.test(d) ? "curl-impersonate" : String(cur.outgoingTransport || "curl-fallback") };
=======
  const want = { score: SPECIAL.test(d) ? "0.25" : "1", timeoutMs: "2000", outgoingTransport: "curl-fallback" };
>>>>>>> origin/main
  const diff = Object.entries(want).filter(([k, v]) => String(cur[k] ?? "") !== v);
  if (!diff.length) continue;
  store[key] = { ...cur, ...want };
  tuned.push(`${d.replace(/^degoog-org-official-extensions-/, "")} (${diff.map(([k, v]) => `${k} ${cur[k] ?? "default"} -> ${v}`).join(", ")})`);
}
if (tuned.length) changed.push("");
if (changed.length) {
  fs.writeFileSync(SF + ".ct-tmp", JSON.stringify(store, null, 2));
  fs.renameSync(SF + ".ct-tmp", SF);
  const ss = changed.filter(Boolean);
  console.log(ss.length ? `Safe Search: now off for ${ss.join(", ")} (OK)` : `Safe Search: off on all ${found} engines that have it (OK)`);
  console.log(tuned.length ? `Engine settings made uniform: ${tuned.join("; ")} (OK)` : "Engine settings: already uniform (OK)");
} else { console.log(`Safe Search: off on all ${found} engines that have it (OK)`); console.log("Engine settings: already uniform (OK)"); }
