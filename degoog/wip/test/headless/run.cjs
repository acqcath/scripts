// Headless Chrome check (M1/M6 only): the user's real search page (rec `page`) with its real CSS (rec `css`) and
// the built page script; recorded results are inserted the way degoog does (one innerHTML), then layout shift is
// summed with a PerformanceObserver for everything AFTER that insert (must be 0). Screenshots go to argv[2].
// Run: node test/headless/run.cjs <outdir>
const fs = require("fs"), zlib = require("zlib"), path = require("path");
const { chromium } = require("playwright");
const { render, ctx } = require("../render.js");
const W = path.join(__dirname, "..", "..");
const REC = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(W, "rec/ct-recordings.json.gz"))));
const TPL = fs.readFileSync(path.join(W, "test/fixtures/result.html"), "utf8");
const CODE = fs.readFileSync(path.join(W, "files/ct-page.js"), "utf8");
const CSS = fs.readFileSync(path.join(W, "files/custom.css"), "utf8");
const PSL = fs.readFileSync(path.join(W, "psl.enc"), "utf8").trim();
const out = process.argv[2] || ".";
// Pictures (thumbnails, favicons) answer with a real 200x120 PNG: this sandbox can't reach the user's image proxy,
// and a failing picture makes degoog's own onerror hide its frame, which is a shift this check isn't about
const PNG = (() => {
  const w = 200, h = 120, raw = Buffer.alloc((w * 3 + 1) * h, 0x70);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
})();
const CASES = ["react useEffect cleanup", "attention is all you need pdf", "how to reset airpods", "best mechanical keyboard reddit", "apple support"];
// The page as the server sends it, minus every script (degoog's app.js isn't here; results are inserted below),
// with its stylesheets inlined from the recording and this build's custom CSS
const page = (q) => {
  let h = String(REC.page).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  h = h.replace(/<link[^>]*rel="(?:modulepreload|preload|manifest|icon|search)"[^>]*>/gi, "");
  h = h.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/gi, (m, href) => (REC.css[href] ? `<style>${REC.css[href]}</style>` : ""));
  h = h.replace(/<style id="degoog-custom-css">[\s\S]*?<\/style>/, () => `<style id="degoog-custom-css">${CSS}</style>`);
  const boot = `<script>window.CT_PSL=${JSON.stringify(PSL)};window.__cls=0;</script>`;
  const mod = `<script type="module">const __PLUGIN_ID__="clean-titles";\n${CODE.replace(/<\/script/gi, "<\\/script")}\n</script>`;
  return h.replace("</body>", () => `${boot}${mod}</body>`);
};
(async () => {
  const browser = await chromium.launch();
  const rows = [];
  for (const width of [390, 1280]) {
    for (const q of CASES) {
      const ctxB = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      const p = await ctxB.newPage();
      const errors = [];
      p.on("pageerror", (e) => errors.push(String(e)));
      p.on("console", (m) => { if (m.type() === "error" && /clean-titles/.test(m.text())) errors.push(m.text()); });
      await p.route("**/*", (r) => {
        const u = new URL(r.request().url());
        if (u.pathname === "/search") return r.fulfill({ status: 200, contentType: "text/html", body: page(q) });
        if (r.request().resourceType() === "image") return r.fulfill({ status: 200, contentType: "image/png", body: PNG });
        return r.fulfill({ status: 404, body: "" }); // bridge, commands, fonts: unavailable
      });
      await p.goto(`https://degoog.local/search?q=${encodeURIComponent(q)}`);
      const res = REC.searches.find((x) => x.q === q && !x.type).results;
      const html = res.map((r, i) => render(TPL, ctx(r, i))).join("");
      // Results view on (app.js would do this), then the one insert degoog makes
      const n = await p.evaluate(async (html) => {
        document.querySelectorAll("#results-page, #search-results, .results-page").forEach((e) => { e.style.display = ""; e.hidden = false; });
        document.body.classList.add("has-results");
        // Fonts settle first (they 404 here; the browser would otherwise swap to the fallback mid-check and every
        // line of text would re-flow, which is a font effect, not the plugin's)
        await Promise.all([...document.fonts].map((f) => f.load().catch(() => {})));
        await document.fonts.ready;
        document.getElementById("results-list").innerHTML = html;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        window.__shifts = [];
        const t0 = performance.now();
        const name = (n) => !n ? "?" : n.nodeType !== 1 ? `#text in ${name(n.parentElement)}` : `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${n.className && typeof n.className === "string" ? "." + n.className.trim().split(/\s+/).join(".") : ""}`;
        new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__cls += e.value; window.__shifts.push(`${Math.round(e.startTime - t0)}ms ${e.value.toFixed(5)} ${e.sources.map((s) => `${name(s.node)} ${s.previousRect.y}->${s.currentRect.y} h${s.previousRect.height}->${s.currentRect.height}`).join(" | ")}`); } }).observe({ type: "layout-shift" });
        return document.querySelectorAll("#results-list .result-item").length;
      }, html);
      await p.waitForTimeout(1500);
      await p.mouse.wheel(0, 2500); await p.waitForTimeout(800);
      await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(300);
      const r = await p.evaluate(() => ({ cls: window.__cls, shown: [...document.querySelectorAll("#results-list .result-item")].filter((e) => e.offsetParent).length, folds: document.querySelectorAll(".ct-fold").length, alts: document.querySelectorAll(".ct-alts").length, dates: document.querySelectorAll(".ct-date").length, shifts: window.__shifts }));
      if (r.shifts.length) console.log(width, q, "\n  " + r.shifts.slice(0, 6).join("\n  "));
      delete r.shifts;
      const file = path.join(out, `${width}-${q.replace(/\W+/g, "_")}.png`);
      await p.screenshot({ path: file, fullPage: false });
      rows.push({ width, q, results: n, ...r, errors: errors.length ? errors.slice(0, 2) : 0 });
      await ctxB.close();
    }
  }
  await browser.close();
  console.table(rows);
  process.exitCode = rows.every((r) => r.cls === 0 && !r.errors) ? 0 : 1;
})();
