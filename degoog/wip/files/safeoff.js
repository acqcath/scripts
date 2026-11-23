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
if (changed.length) {
  fs.writeFileSync(SF + ".ct-tmp", JSON.stringify(store, null, 2));
  fs.renameSync(SF + ".ct-tmp", SF);
  console.log(`Safe Search: now off for ${changed.join(", ")} (OK)`);
} else console.log(`Safe Search: off on all ${found} engines that have it (OK)`);
