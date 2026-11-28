// ----- page/07-layout.js: top gap, loading skeletons in the real shape, picture loading -----
// Gap from the tab row to the first thing under it (answer card, info panel or the first result's source line):
// measured, so empty or hidden blocks above the results can't add to it; the same on every tab and screen size
let gapEl = null; // what topGap last found highest (the first result's source line, the answer card...)
const topGap = () => {
  gapEl = null;
  const tabs = document.getElementById("results-tabs"), lay = document.getElementById("results-layout");
  if (!tabs || !lay) return;
  // The answer area counts as empty when nothing in it is showing (hidden leftovers otherwise kept degoog's
  // "not empty" margin, an extra 24 px gap above the results)
  const g = document.getElementById("at-a-glance");
  if (g) g.classList.toggle("ct-blank", ![...g.children].some((e) => e.getClientRects().length));
  let top = Infinity;
  // Results, pictures and videos: only the first showing one of each list (or picture column) can be the highest, so
  // the rest (hundreds after a few endless-scroll pages) aren't measured
  const firsts = [];
  const first = (els) => { for (const e of els) if (e.getBoundingClientRect().height > 0) { firsts.push(e); return; } };
  first(lay.querySelectorAll(".result-item .result-url-row"));
  for (const c of lay.querySelectorAll(".image-column")) first(c.querySelectorAll(".image-card"));
  first(lay.querySelectorAll(".image-grid > .image-card"));
  first(lay.querySelectorAll(".video-card"));
  // "No results" is the same on every tab: its text starts where the tab labels' text starts, at the same gap under
  // the tabs (on Images it sat flush with the screen edge on phones and wasn't measured for the gap)
  const nr = lay.querySelector(".no-results");
  if (nr) {
    const lab = [...tabs.querySelectorAll(".results-tab")].find((t) => t.getClientRects().length);
    const tn = lab && [...lab.childNodes].find((n) => n.nodeType === 3 && n.data.trim());
    const tx = (() => { const n = [...nr.childNodes].find((x) => x.nodeType === 3 && x.data.trim()) || nr.firstChild; if (!n) return null; const r = document.createRange(); r.selectNodeContents(n); return r.getClientRects()[0] || null; })();
    if (tn && tx) {
      const r = document.createRange(); r.selectNodeContents(tn);
      const want = r.getClientRects()[0], pad = parseFloat(nr.style.paddingLeft) || 0;
      if (want) { const next = Math.max(0, Math.round(pad + want.left - tx.left)); if (Math.abs(next - pad) >= 1) nr.style.paddingLeft = `${next}px`; }
    }
  }
  for (const e of [...lay.querySelectorAll("#ct-fix, #at-a-glance > *, #sidebar-col > *, .skeleton-card, .ct-skc, .ct-skimg, .command-result, .no-results"), ...firsts]) {
    const r = e.getBoundingClientRect();
    if (!(r.height > 0) || r.top >= top) continue; // a box's text never starts above its top: no style read needed
    // a line of text starts where its letters start, not where its line spacing starts; a measured placeholder row
    // where its result's link line will start
    const t = e.dataset.ut != null ? r.top + +e.dataset.ut : textTop(e, r);
    if (t < top) { top = t; gapEl = e; }
  }
  if (top === Infinity) { gapEl = null; return; }
  const cur = parseFloat(lay.style.getPropertyValue("--ct-top")) || 0;
  const want = TOUCH.matches ? 16 : 20; // v98: the user found 12/16 too tight ("bump it ever so slightly")
  // measured from whatever sits right above the results: the tab row, or the open Tools fields under it (measuring from
  // the tabs alone pulled the results up under the open fields)
  const adv = document.getElementById("ct-adv"), above = Math.max(tabs.getBoundingClientRect().bottom, adv ? adv.getBoundingClientRect().bottom : 0);
  const next = Math.round(cur + want - (top - above));
  if (Math.abs(next - cur) >= 1) lay.style.setProperty("--ct-top", `${next}px`);
};

// topGap is needed again unless everything that changed sits after the thing it found highest, in the results list or
// endless scroll's line under it (a page going in under the results, its placeholder, a fold or sitelink row): then nothing above
// moved and measuring would only force the browser to lay out the new page in the middle of the pass (~6 ms a page)
const gapSkip = (muts) => {
  const e = gapEl, list = document.getElementById("results-list");
  if (!e || !list || !e.isConnected || e.closest(".result-item")?.style.display === "none") return false;
  const after = (n) => { const p = e.compareDocumentPosition(n); return n === e || (p & 4 && !(p & 8)); }; // 4 following, 8 contains e
  for (const m of muts) {
    // inside the list, endless scroll's "more" line under it, or the list's own box (that line going in)
    const t = m.target;
    if (m.type !== "childList" || !(list.contains(t) || t === list.parentElement || t.closest?.(".degoog-infinite"))) return false;
    if (t !== e && after(t)) continue; // the whole box that changed comes after it
    for (const n of m.addedNodes) if (!after(n)) return false;
    if (m.removedNodes.length && !(m.previousSibling && (after(m.previousSibling) || e.compareDocumentPosition(m.previousSibling) & 8))) return false;
  }
  return true;
};

// ===== Loading skeletons in the shape of what comes =====
// degoog's placeholders are generic (4 even columns of grey tiles; 4 text lines per result), so the page changed
// shape when the results came. Here each placeholder is drawn from what that tab really showed last time on this
// device and width: list tabs replay the measured boxes of the last real results (favicon, each text line at its
// real width, thumbnail, row heights and gaps); Images uses the real grid's own CSS and columns, with the measured
// picture shapes and the title/site lines under each. Nothing measured yet = degoog's own placeholder.
const SKEL = "ct-skel";
const skelGet = () => { try { return JSON.parse(localStorage.getItem(SKEL) || "{}") || {}; } catch { return {}; } };
const skelPut = (k, v) => { const all = skelGet(); all[k] = v; try { localStorage.setItem(SKEL, JSON.stringify(all)); } catch {} };
const skelKey = (w) => `${curType()}|${PHONE.matches ? "p" : "d"}|${Math.round(w / 50)}`;
// Where a box's text starts, as topGap measures it (letters, not line spacing), so a placeholder sits exactly where
// the results will
const textTop = (e, r = e.getBoundingClientRect()) => {
  const cs = getComputedStyle(e), lh = parseFloat(cs.lineHeight), fs = parseFloat(cs.fontSize);
  return r.top + parseFloat(cs.paddingTop || 0) + (lh > fs && e.childElementCount === 0 || e.id === "ct-fix" ? (lh - fs) / 2 : 0);
};
const skelBlock = (x, y, w, h, r) => { const b = document.createElement("span"); b.className = "ct-skb"; b.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:${r}px`; return b; };
// One result's boxes, relative to the result: pictures/favicons as they are, text as one bar per line at its width
const skelShape = (el) => {
  const R = el.getBoundingClientRect(), out = [], pics = [];
  for (const m of el.querySelectorAll("img, .result-thumbnail-wrap, .result-favicon-missing")) {
    if (pics.some((p) => p.contains(m))) continue;
    const r = m.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom > R.bottom + 1 || r.top < R.top - 1) continue;
    pics.push(m);
    out.push([r.left - R.left, r.top - R.top, r.width, r.height, Math.min(r.height / 2, parseFloat(getComputedStyle(m).borderTopLeftRadius) || 4)]);
  }
  const lines = new Map();
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode()) && lines.size < 12;) {
    const p = n.parentElement;
    if (!n.data.trim() || !p || pics.some((x) => x.contains(p)) || !p.getClientRects().length) continue;
    const fs = parseFloat(getComputedStyle(p).fontSize) || 14, rg = document.createRange();
    rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) {
      if (r.width < 2 || r.bottom > R.bottom + 1) continue;
      const k = Math.round((r.top + r.bottom) / 2 - R.top), l = lines.get(k);
      if (l) { l[0] = Math.min(l[0], r.left - R.left); l[1] = Math.max(l[1], r.right - R.left); l[2] = Math.max(l[2], fs); }
      else lines.set(k, [r.left - R.left, r.right - R.left, fs, k]);
    }
  }
  for (const [x0, x1, fs, mid] of lines.values()) { const h = Math.round(fs * 0.72); out.push([x0, mid - h / 2, x1 - x0, h, Math.min(4, h / 2)]); }
  const u = el.querySelector(".result-url-row");
  return { h: R.height, ut: u ? textTop(u) - R.top : null, b: out.map((a) => a.map((v) => Math.round(v * 10) / 10)) };
};
// After the results settle (idle time, once per search): keep the shapes of the first rows
let skelFor = "";
const skelLearn = () => {
  const key = searchId();
  if (skelFor === key) return;
  const list = document.getElementById("results-list");
  if (!list || list.querySelector(".skeleton-results, .skeleton-image-grid")) return;
  const imgs = [...list.querySelectorAll(".image-card")].filter((e) => e.style.display !== "none");
  const rows = [...list.children].filter((e) => e.classList.contains("result-item") && e.style.display !== "none" && !e.classList.contains("ct-grouped"));
  if (imgs.length < 6 && rows.length < 3) return;
  skelFor = key;
  const later = window.requestIdleCallback ? (f) => requestIdleCallback(f, { timeout: 2000 }) : (f) => setTimeout(f, 600);
  later(() => {
    if (searchId() !== key) return;
    const w = list.clientWidth;
    if (!w) return;
    if (imgs.length >= 6) {
      // Picture shapes (height per width of the picture box) of the first 24 pictures, in order
      const ar = imgs.slice(0, 24).map((e) => { const t = e.querySelector(".image-thumb-wrap") || e, r = t.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? Math.round((r.height / r.width) * 100) / 100 : 0; }).filter((x) => x > 0.2 && x < 4);
      if (ar.length >= 6) skelPut(skelKey(w), { ar });
      return;
    }
    const lt = list.getBoundingClientRect().top, picks = rows.slice(0, 6), shapes = [];
    for (let i = 0; i < picks.length; i++) {
      const s = skelShape(picks[i]), nx = picks[i + 1];
      s.gap = nx ? Math.max(0, Math.round(nx.getBoundingClientRect().top - picks[i].getBoundingClientRect().bottom)) : 0;
      if (i === 0) s.top = Math.round(picks[0].getBoundingClientRect().top - lt);
      shapes.push(s);
    }
    skelPut(skelKey(w), { rows: shapes });
  });
};
// degoog just drew a placeholder: redraw it in the shape of what comes, before the screen updates
const skel = (root) => {
  for (const g of root.matches?.(".skeleton-results, .skeleton-image-grid") ? [root] : root.querySelectorAll?.(".skeleton-results, .skeleton-image-grid") || []) {
    if (g.dataset.ctSkel) continue;
    g.dataset.ctSkel = "1";
    const w = g.clientWidth || document.getElementById("results-list")?.clientWidth || innerWidth;
    const t = skelGet()[skelKey(w)];
    if (g.classList.contains("skeleton-image-grid")) {
      // degoog's own column count for this width (render-media.tsx COLUMN_STEPS), the real grid's gaps (custom.css)
      const cols = w <= 800 ? 3 : w <= 1100 ? 4 : w <= 1400 ? 5 : 6;
      const ar = (t && t.ar) || [140, 100, 175, 115, 155, 90, 135, 105].map((h) => h / 200); // degoog's tiles at a 200px column
      const per = Math.max(3, Math.ceil(((innerHeight * 1.2) / (w / cols)) / (ar.reduce((a, b) => a + b, 0) / ar.length)));
      const line = (cls, pct) => { const s = document.createElement("span"); s.className = cls; const i = document.createElement("i"); i.className = "ct-skt"; i.style.width = `${pct}%`; s.append(i); return s; };
      const colsEl = [];
      for (let c = 0; c < cols; c++) {
        const col = document.createElement("div");
        col.className = "image-column";
        for (let r = 0; r < per; r++) {
          const k = c + r * cols, card = document.createElement("div");
          card.className = "ct-skimg";
          const th = document.createElement("div");
          th.className = "image-thumb-wrap ct-skb-in";
          th.style.aspectRatio = `1 / ${ar[k % ar.length]}`;
          const info = document.createElement("div");
          info.className = "image-info";
          info.append(line("image-title", 55 + ((k * 37) % 40)), line("image-source", 30 + ((k * 23) % 30)));
          card.append(th, info);
          col.append(card);
        }
        colsEl.push(col);
      }
      g.replaceChildren(...colsEl);
      continue;
    }
    if (!t || !t.rows || !t.rows.length) continue;
    // List tabs: the measured rows, repeated until the screen is full (the "more results" placeholder keeps its count)
    const more = g.classList.contains("skeleton-results--more"), n = more ? g.children.length || 3 : 0, cards = [];
    let y = 0;
    for (let i = 0; (more ? i < n : y < innerHeight * 1.2) && i < 30; i++) {
      const s = t.rows[i % t.rows.length], c = document.createElement("div");
      c.className = "ct-skc";
      c.style.height = `${s.h}px`;
      c.style.marginBottom = `${s.gap}px`;
      if (s.ut != null) c.dataset.ut = s.ut;
      for (const b of s.b) c.append(skelBlock(...b));
      cards.push(c);
      y += s.h + s.gap;
    }
    g.classList.add("ct-skel-m");
    if (!more && t.rows[0].top) g.style.paddingTop = `${t.rows[0].top}px`;
    g.replaceChildren(...cards);
  }
};
// Pictures shimmer in place (same tile as the placeholder) until they've loaded and the image AI has answered,
// then fade in; the first screen's pictures load first instead of waiting for the browser's lazy start
const picLoad = (el) => {
  const im = el.querySelector("img");
  if (!im) return;
  const idx = +el.dataset.idx;
  if (idx < 18) { im.loading = "eager"; im.fetchPriority = "high"; }
  im.decoding = "async";
  if (im.complete && im.naturalWidth) return;
  im.classList.add("ct-ld");
  const done = () => im.classList.remove("ct-ld");
  im.addEventListener("load", done, { once: true });
  im.addEventListener("error", done, { once: true });
};

// Weather card with no city ("Usage: !weather <city>") is noise: hide it (no default city on purpose)
const noUsage = (root) => {
  const list = root.matches?.(".command-result") ? [root] : [...(root.querySelectorAll?.(".command-result") || [])];
  for (const c of list) if (/^\s*Usage: !weather\b/.test(c.textContent)) {
    const box = c.parentElement?.children.length === 1 ? c.parentElement : c;
    box.style.display = "none";
  }
};

