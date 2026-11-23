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
// CT_CASES="a|b" picks other recorded searches (answer card, AI spot...). AI-worded ones get ai-summary "set up" and
// a panel arriving 300 ms after the results (then its text 300 ms later), like degoog's slot stream.
const CASES = process.env.CT_CASES ? process.env.CT_CASES.split("|") : ["react useEffect cleanup", "attention is all you need pdf", "how to reset airpods", "best mechanical keyboard reddit", "apple support"];
const AI_CASE = /^(why|.* vs .*|best laptop)/;
// The page as the server sends it, minus every script (degoog's app.js isn't here; results are inserted below),
// with its stylesheets inlined from the recording and this build's custom CSS
const page = (q) => {
  let h = String(REC.page).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  h = h.replace(/<link[^>]*rel="(?:modulepreload|preload|manifest|icon|search)"[^>]*>/gi, "");
  h = h.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/gi, (m, href) => (REC.css[href] ? `<style>${REC.css[href]}</style>` : ""));
  h = h.replace(/<style id="degoog-custom-css">[\s\S]*?<\/style>/, () => `<style id="degoog-custom-css">${CSS}</style>`);
  const ai = AI_CASE.test(q) ? `localStorage.setItem("ct-sites-auto", ${JSON.stringify(JSON.stringify({ auto: [], seo: false, ai: { on: true } }))});` : "";
  // A search the user opened the Images tab for (recorded image results exist for it): the images row case
  const qh = (x) => { let h = 2166136261; for (const c of x) h = Math.imul(h ^ c.codePointAt(0), 16777619); return (h >>> 0).toString(36); };
  const vis = REC.searches.some((x) => x.type === "images" && x.q === q) ? `localStorage.setItem("ct-visual", ${JSON.stringify(JSON.stringify({ [qh(q)]: Date.now() }))});` : "";
  const boot = `<script>window.CT_PSL=${JSON.stringify(PSL)};window.__cls=0;${ai}${vis}</script>`;
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
        if (u.pathname === "/api/search" && u.searchParams.get("type") === "images") { const ir = REC.searches.find((x) => x.type === "images" && x.q === u.searchParams.get("q")); return r.fulfill({ status: ir ? 200 : 404, contentType: "application/json", body: JSON.stringify(ir ? { results: ir.results } : {}) }); }
        // Bridge answers for network-card cases (CMU), as degoog's /api/command returns them
        const body = r.request().postData() || "";
        const fx = { sports: { g: { state: "in", detail: "Q3 4:12", date: "2026-11-23T18:00Z", league: "NFL", away: { abbr: "CLE", score: "17", record: "3-7", logo: "/logo-cle.png" }, home: { abbr: "PIT", score: "24", winner: false, record: "7-3", logo: "/logo-pit.png" } } }, cmu: { c: { course: { name: "Introduction to Computer Systems", units: "12", prereqs: "15-122 and 21-127" }, fces: [["RAILING, BRIAN", 140, 4.3], ["GIBBONS, PHILLIP", 120, 4.2], ["O'HALLARON, DAVID", 90, 4.5], ["KESDEN, GREGORY", 60, 3.9]].map(([instructor, n, t]) => ({ year: 2026, semester: "spring", instructor, numRespondents: n, responseRate: "55%", hrsPerWeek: 14.3, rating: [0, 0, 0, 0, 0, 0, 0, t, 4.0], location: "Pittsburgh" })) } } };
        fx.kp = { kp: q === "golden gate bridge" ? { qid: "Q44440", title: "Golden Gate Bridge", name: "Golden Gate Bridge", type: "structure", desc: "suspension bridge in San Francisco, California, US", extract: "The Golden Gate Bridge is a suspension bridge spanning the Golden Gate, the one-mile-wide strait connecting San Francisco Bay and the Pacific Ocean.", facts: [{ k: "Location", v: "San Francisco" }, { k: "Height", v: "227 m (746 ft)" }, { k: "Opened", v: "May 27, 1937" }, { k: "Architect", v: "Irving Morrow" }], photo: "/kp-ggb.png" } : { qid: "Q26876", title: "Taylor Swift", name: "Taylor Swift", type: "person", desc: "American singer-songwriter (born 1989)", extract: "Taylor Alison Swift is an American singer-songwriter. Known for her autobiographical songwriting, artistic versatility and cultural impact, Swift is one of the best-selling music artists of all time.", facts: [{ k: "Born", v: "Dec 13, 1989" }, { k: "Occupation", v: "singer-songwriter, record producer" }], photo: "/kp-ts.png" } };
        const m = /!cleantitles bridge (\w+)/.exec(body);
        if (u.pathname === "/api/command" && m && fx[m[1]]) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ html: JSON.stringify(fx[m[1]]).replace(/&/g, "&amp;").replace(/</g, "&lt;") }) });
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
      if (AI_CASE.test(q)) await p.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 300));
        const g = document.getElementById("at-a-glance");
        if ([...g.children].every((c) => c.getAttribute("data-slot-order") === null)) [...g.children].forEach((c) => { if (!c.classList.contains("ct-ai")) c.remove(); });
        const w = document.createElement("div");
        w.className = "results-slot-panel degoog-panel degoog-panel--slot degoog-panel--stack-item"; w.setAttribute("data-slot-order", "0");
        w.innerHTML = '<div class="results-slot-panel-body degoog-panel--slot-body degoog-panel--slot-body-padded"><div class="glance-ai degoog-panel degoog-panel--slot"><div class="glance-ai-head"><div class="glance-ai-title"><span>AI Summary</span></div></div><div class="glance-ai-summary-wrap"><div class="glance-ai-body glance-ai-body--clamped"><div class="glance-snippet glance-ai-stream degoog-text degoog-text--md" data-state="pending"><div class="skeleton-glance glance-ai-skeleton"><div class="skeleton-line"></div><div class="skeleton-line"></div></div></div></div><button class="glance-ai-expand" type="button">Read more</button></div><div class="glance-ai-chat" hidden></div></div></div>';
        g.append(w);
        await new Promise((r) => setTimeout(r, 300));
        const t = w.querySelector(".glance-ai-stream");
        t.dataset.state = "done";
        t.innerHTML = "<p>The sky looks blue because air molecules scatter short blue wavelengths of sunlight much more than long red ones (Rayleigh scattering). At sunset light crosses more air, so the blue is scattered away and reds and oranges remain.</p><ul><li>Rayleigh scattering</li><li>Violet is absorbed high up</li></ul>";
      });
      await p.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 200));
        const sb = document.getElementById("results-sidebar");
        if (sb) { const a = document.createElement("div"); a.className = "sidebar-accordion degoog-accordion open"; a.setAttribute("data-slot-order", "0"); a.innerHTML = '<div class="degoog-accordion-body"><div class="wiki-card"><div class="wiki-overview"><a class="wiki-title" href="#">Wiki</a><p class="wiki-desc">desc</p><p class="wiki-extract">Some long extract text that would take room.</p></div></div></div>'; sb.prepend(a); }
      });
      await p.waitForTimeout(1500);
      await p.mouse.wheel(0, 2500); await p.waitForTimeout(800);
      await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(300);
      const r = await p.evaluate(() => ({ cls: window.__cls, shown: [...document.querySelectorAll("#results-list .result-item")].filter((e) => e.offsetParent).length, folds: document.querySelectorAll(".ct-fold").length, alts: document.querySelectorAll(".ct-alts").length, kp: (() => { const k = document.querySelector(".ct-kp"); if (!k || !k.offsetParent) return `none sw${document.documentElement.scrollWidth}`; const b = k.getBoundingClientRect(), f = document.querySelector("#results-list .result-item:not([style*=none])").getBoundingClientRect(); return `${Math.round(b.left)}-${Math.round(b.right)} top${Math.round(b.top - f.top)} vw${innerWidth} sw${document.documentElement.scrollWidth}`; })(), dates: document.querySelectorAll(".ct-date").length, shifts: window.__shifts }));
      if (process.env.CT_WIDE) console.log(q, width, await p.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => { const b = e.getBoundingClientRect(); if (!(b.right > innerWidth + 0.5 && b.width > 0)) return false; for (let x = e.parentElement; x; x = x.parentElement) if (/auto|scroll|hidden|clip/.test(getComputedStyle(x).overflowX)) return false; return true; }).slice(0, 5).map((e) => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().right)}`)));
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
