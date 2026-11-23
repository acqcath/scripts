// Run by the installer inside degoog (bun): ai-summary keeps its answers as long as degoog keeps the search results
// (TTL_MS, 12 h unless DEGOOG_CACHE_TTL_MS says otherwise), instead of its hard-coded 2 minutes. RAM/valkey cache
// only, like the results. Exactly one matching line is changed; 0 or several -> nothing changed, and it says so.
const fs = require("fs");
// Empty answers: degoog keeps an engine's run for 12 h when the engine "succeeded" with 0 results (a blocked or
// captcha page parses as nothing), so a search that once came back empty stays "No results found" on every refresh.
// Patched in degoog's engine cache: an empty run is kept only as long as a failed one (SHORT_TTL_MS, 2 min), so the
// next search after that asks the engine again. Same safety as above: exactly one matching line, else nothing.
(() => {
  const f = `${process.env.DEGOOG_SRC_DIR || "/app/src"}/server/search/engine-cache.ts`;
  const MARK2 = "/* clean-titles: empty runs retried soon */";
  let src = "";
  try { src = fs.readFileSync(f, "utf8"); } catch { console.log("Empty results: degoog's engine-cache.ts not found, nothing changed (NOTICE)"); return; }
  if (src.includes(MARK2)) { console.log("Empty results: asked again after 2 minutes instead of 12 hours (OK)"); return; }
  const OLD = "engineErrored(timing.status) ? SHORT_TTL_MS : TTL_MS;";
  const n = src.split(OLD).length - 1;
  if (n !== 1) { console.log(`Empty results: NOTICE found ${n} copies of degoog's cache line (expected 1), nothing changed. degoog may have been updated.`); return; }
  fs.writeFileSync(f + ".ct-tmp", src.replace(OLD, `engineErrored(timing.status) || !timing.resultCount ? SHORT_TTL_MS : TTL_MS; ${MARK2}`));
  fs.renameSync(f + ".ct-tmp", f);
  console.log("Empty results: asked again after 2 minutes instead of 12 hours (OK)");
})();
const root = process.env.DEGOOG_PLUGINS_DIR || "/app/data/plugins";
const MARK = "/* clean-titles: same as degoog's TTL_MS */";
const LINE = /^const SHORT_TTL_MS = 2 \* 60 \* 1000;[ \t]*$/gm;
const NEW = `${MARK} const SHORT_TTL_MS = (() => { const n = Number.parseInt(process.env.DEGOOG_CACHE_TTL_MS || "", 10); return Number.isFinite(n) && n > 0 ? n : 12 * 60 * 60 * 1000; })();`;
let dirs = [];
try { dirs = fs.readdirSync(root).filter((d) => /ai-summary/i.test(d)); } catch {}
if (!dirs.length) { console.log("AI summary cache: ai-summary not installed, nothing to do"); process.exit(0); }
for (const d of dirs) {
  const f = `${root}/${d}/index.js`;
  let src = "";
  try { src = fs.readFileSync(f, "utf8"); } catch { console.log(`AI summary cache: ${d} has no index.js, skipped`); continue; }
  if (src.includes(MARK)) { console.log(`AI summary cache: ${d} already keeps answers as long as search results (OK)`); continue; }
  const n = (src.match(LINE) || []).length;
  if (n !== 1) { console.log(`AI summary cache: NOTICE ${d}: found ${n} copies of the 2-minute line (expected 1), so nothing was changed. ai-summary may have been updated.`); continue; }
  const out = src.replace(LINE, NEW);
  fs.writeFileSync(f + ".ct-tmp", out);
  fs.renameSync(f + ".ct-tmp", f);
  console.log(`AI summary cache: ${d} now keeps answers as long as search results (OK)`);
}
