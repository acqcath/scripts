// ----- page/03-images.js: image AI, media folds, image preview + related strip, result cards -----
// Relevance on the Images and Videos tabs too (same one rule as Web, on the title and site): an image or video with
// none of the search's words and not on the topic the related ones share goes behind "N unrelated images ⌄" /
// "N unrelated videos ⌄" at the end ("graphic" in a search doesn't bring porn in). Decided before paint, a batch at a time.
// ===== Image AI (ct-vision on the PC's GPU, through this plugin's server) =====
// Each picture gets a 0..1 "shows the search" score from SigLIP 2. Pictures far below this page's typical score fold
// (a dick under "kalimba" folds even when its title says kalimba); pictures the words rule folded but the AI sees as
// on-topic come back. Cards wait for their score (at most 0.9 s, pictures hidden, nothing moves) before they show.
const origOf = (src) => { try { const u = new URL(src, location.href); return /\/proxy\/image$/.test(u.pathname) ? u.searchParams.get("url") || "" : u.href; } catch { return ""; } };
// Off for this page when the AI doesn't answer, and for 10 min in this browser (no waiting on a missing AI)
let VISON = (() => { try { return Date.now() - Number(localStorage.getItem("ct-visoff") || 0) > 600000; } catch { return true; } })();
const VS = { key: "", p: new Map(), q: [], t: 0 };
const visThr = () => {
  const v = [...VS.p.values()].filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (v.length < 6) return null;
  const med = v[Math.floor(v.length / 2)];
  return { low: Math.min(0.02, med * 0.05), mid: med };
};
const visAsk = (q, urls) => bridge("vis", {}, JSON.stringify({ q, u: urls })).then((j) => {
  if (!j || !Array.isArray(j.p)) { VISON = false; try { localStorage.setItem("ct-visoff", String(Date.now())); } catch {} return null; }
  urls.forEach((u, i) => VS.p.set(u, j.p[i]));
  return j;
}).catch(() => { VISON = false; return null; });
const visQueue = (el, kind) => {
  if (!VISON) return;
  visKey();
  const u = origOf(el.querySelector("img")?.getAttribute("src") || "");
  if (!u) return;
  el.dataset.ctV = u;
  el.classList.add("ct-vpend");
  VS.q.push([el, kind]);
  if (VS.q.length === 1) queueMicrotask(visFlush);
};
const visFlush = () => {
  const batch = VS.q.splice(0);
  if (!batch.length) return;
  let q0 = "";
  try { q0 = new URL(location.href).searchParams.get("q") || ""; } catch {}
  const show = () => batch.forEach(([el]) => el.classList.remove("ct-vpend"));
  const timer = setTimeout(show, 900);
  visAsk(q0, [...new Set(batch.map(([el]) => el.dataset.ctV))]).then(() => { clearTimeout(timer); visApply(); show(); });
};
const visKey = () => { const key = searchId(); if (VS.key !== key) { VS.key = key; VS.p.clear(); VS.q = []; } };
// Web's Images row: pictures the AI sees as off-topic leave the row (also when the score comes after the row is drawn)
const visRow = () => {
  const th = visThr();
  if (!th) return;
  for (const a of document.querySelectorAll(".ct-imgs .ct-im[data-ct-v]")) { const p = VS.p.get(a.dataset.ctV); if (typeof p === "number" && p < th.low) a.remove(); }
};
const visApply = () => {
  const th = visThr();
  if (!th) return;
  for (const kind of ["image", "video"]) {
    const R = MR[kind];
    const fold = [], back = [];
    for (const el of document.querySelectorAll(`.${kind}-card[data-ct-v]`)) {
      const p = VS.p.get(el.dataset.ctV);
      if (typeof p !== "number" || el.dataset.ctAi) continue;
      if (p < th.low && !el.dataset.ctUnrel) fold.push(el);
      else if (p >= th.mid && el.dataset.ctUnrel && R && R.out.includes(el)) back.push(el);
    }
    for (const el of back) { R.out.splice(R.out.indexOf(el), 1); el.style.display = ""; delete el.dataset.ctUnrel; }
    if (fold.length) { for (const el of fold) { el.style.display = "none"; el.dataset.ctUnrel = "1"; } mediaFoldAdd(kind, fold); }
    else if (back.length && R) mediaFoldAdd(kind, []);
  }
  visRow();
};
const MR = {};
const mediaRel = (el, kind, text, title) => {
  readQuery();
  const key = searchId();
  let R = MR[kind];
  if (!R || R.key !== key) { R?.btn?.closest(".ct-fold")?.remove(); R = MR[kind] = { key, q: [], rel: [], btn: null, out: [] }; }
  let q0 = "";
  try { q0 = new URL(location.href).searchParams.get("q") || ""; } catch {}
  if (!CT.relJudgeable(q0)) return;
  const r = { title: text, snippet: "" };
  if (CT.related(qWords, qIdent, text, 0, 99)) { R.rel.push(r); return; }
  if ((String(title || "").match(/[\p{L}\p{N}]+/gu) || []).length < 3) return; // no real title ("Pin", none): nothing to judge, stays
  el.style.display = "none"; el.dataset.ctUnrel = "1";
  if (!R.q.length) queueMicrotask(() => mediaFold(kind));
  R.q.push([el, r]);
};
const mediaFold = (kind) => {
  const R = MR[kind];
  const same = CT.topicOf(R.rel, qWords);
  const out = [];
  for (const [el, r] of R.q.splice(0)) { if (same(r)) { el.style.display = ""; delete el.dataset.ctUnrel; } else out.push(el); }
  if (out.length) mediaFoldAdd(kind, out);
};
const mediaFoldAdd = (kind, out) => {
  const key = searchId();
  let R = MR[kind];
  if (!R || R.key !== key) R = MR[kind] = { key, q: [], rel: [], btn: null, out: [] };
  R.out.push(...out);
  const n = R.out.length;
  const first = R.out[0];
  if (!n) { R.btn?.closest(".ct-fold")?.remove(); R.btn = null; return; }
  const grid = first.closest(".image-grid, .video-grid") || first.parentElement;
  if (!grid) return;
  let row = R.btn?.closest(".ct-fold");
  if (!row) {
    row = mk("div", "ct-fold ct-fold-img");
    const b = mk("button", "ct-fold-b", "");
    b.type = "button"; b.setAttribute("aria-expanded", "false");
    row.append(b);
    b.addEventListener("click", () => { for (const x of R.out.splice(0)) { x.style.display = ""; delete x.dataset.ctUnrel; fadeIn(x); } row.remove(); R.btn = null; });
    R.btn = b;
  }
  const w = kind === "video" ? "video" : "image";
  R.btn.replaceChildren(`${n} unrelated ${w}${n > 1 ? "s" : ""}`, mk("span", "ct-chev", "⌄"));
  grid.after(row); // after the grid, so it stays at the end as more load
};
// Image/video preview panel: the picture and the title open the page in one tap (like Google; degoog's picture opened
// a zoom view and only the button visited), and its "more images" strip leaves out what the grid folded or hid
// Unsolved-search learning (M5): which kind of block a link you open sat in goes to the server (its own private
// log; no address is sent). Layout only: it nudges block shares for searches with the same needs profile.
const SEEN_KIND = [[".ct-forum", "forums"], [".ct-paper", "papers"], [".ct-news", "news"], [".ct-video", "video"], [".ct-imgs", "image"], [".ct-kp", "info"], [".ct-ans, .ct-ai, #at-a-glance", "answer"], [".result-item", "web"]];
document.addEventListener("click", (e) => {
  const a = e.target?.closest?.("a[href]");
  if (!a || !/^https?:/.test(a.href) || !a.closest("#results-list, #at-a-glance") || !webTab) return;
  const hit = SEEN_KIND.find(([sel]) => a.closest(sel));
  if (hit) bridge("seen", { q: curQ(), k: hit[1] }, "").catch(() => {});
}, true);
document.addEventListener("click", (e) => {
  if (!e.target?.closest?.("#media-preview-img")) return;
  const a = document.querySelector("#media-preview-info .media-preview-link");
  if (!a || !a.href) return;
  e.preventDefault(); e.stopPropagation();
  if (a.target === "_blank") window.open(a.href, "_blank", "noopener"); else location.href = a.href;
}, true);
const previewPass = () => {
  const info = document.getElementById("media-preview-info");
  const h = info?.querySelector("h3.media-preview-title");
  const src = info?.querySelector(".media-preview-link");
  if (h && src && !h.querySelector("a")) {
    const a = mk("a", "ct-pv-t", h.textContent);
    a.href = src.href; if (src.target) { a.target = src.target; a.rel = "noopener"; }
    h.replaceChildren(a);
  }
  relatedStrip();
};
// "More images" under the preview = images like the one you opened (degoog drew a random 15 of all results, folded
// ones included): the grid's shown images ranked by the words they share with the opened image's title beyond the
// search's own words (17-key, mahogany, cartoon…), then by matching the search; ties keep the engines' order
const relatedStrip = () => {
  const more = document.getElementById("media-preview-more");
  const g = more?.querySelector(".media-preview-more-grid");
  if (!g || g.dataset.ct) return;
  const sel = document.querySelector(".image-card.selected, .video-card.selected");
  if (!sel) return;
  const kind = sel.classList.contains("video-card") ? "video" : "image";
  const title = (c) => { const t = c.querySelector(`.${kind}-title`); return (t && (t.title || t.textContent)) || c.querySelector("img")?.alt || ""; };
  const own = new Set(qWords);
  const mine = CT.relWords(title(sel)).filter((w) => !own.has(w));
  const pool = [...document.querySelectorAll(`.${kind}-card`)].filter((c) => c !== sel && c.style.display !== "none" && !c.dataset.ctUnrel && !c.dataset.ctAi && c.querySelector("img")?.getAttribute("src"));
  const n = Math.max(g.children.length, Math.min(15, pool.length));
  const scored = pool.map((c, i) => {
    const t = `${title(c)} ${c.querySelector(`.${kind}-source`)?.textContent || ""}`;
    return { c, i, s: 2 * CT.matchShare(mine, t) * mine.length + (CT.matchShare(qWords, t) > 0 ? 1 : 0) };
  }).sort((a, b) => b.s - a.s || a.i - b.i);
  const grid = mk("div", "media-preview-more-grid");
  grid.dataset.ct = "1";
  const draw = (list) => {
    grid.replaceChildren();
    for (const c of list.slice(0, n)) {
      const b = mk("button", "media-preview-more-item"); b.type = "button";
      const im = mk("img", "media-preview-more-img"); im.loading = "lazy"; im.src = c.querySelector("img").getAttribute("src"); im.alt = title(c);
      im.onerror = () => { b.style.display = "none"; };
      b.append(im);
      b.addEventListener("click", () => { c.click(); c.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
      grid.append(b);
    }
  };
  const words = () => draw(scored.map((x) => x.c));
  // Image AI: the ones that look most like the opened picture (waits at most 0.6 s, hidden meanwhile, so the strip
  // never reshuffles in front of you); no AI answer -> the words order
  const me = origOf(sel.querySelector("img")?.getAttribute("src") || "");
  if (VISON && me && pool.length) {
    grid.style.visibility = "hidden";
    let done = false;
    const fin = (list) => { if (done) return; done = true; if (list) draw(list); else words(); grid.style.visibility = ""; };
    setTimeout(() => fin(null), 600);
    const us = pool.map((c) => origOf(c.querySelector("img").getAttribute("src")));
    bridge("near", {}, JSON.stringify({ u: me, us })).then((j) => {
      if (!j || !Array.isArray(j.sim)) return fin(null);
      fin(pool.map((c, i) => ({ c, v: typeof j.sim[i] === "number" ? j.sim[i] : -2, i })).sort((x, y) => y.v - x.v || x.i - y.i).map((x) => x.c));
    }).catch(() => fin(null));
  } else words();
  g.replaceWith(grid);
};
// Web's own rows (Images row, Videos box) use the same rule
const relOk = (title, url) => { readQuery(); let q0 = ""; try { q0 = new URL(location.href).searchParams.get("q") || ""; } catch {} return !CT.relJudgeable(q0) || CT.related(qWords, qIdent, `${url || ""} ${title || ""}`, 0, 99) || (String(title || "").match(/[\p{L}\p{N}]+/gu) || []).length < 3; };
const card = (el, isImage) => {
  const src = el.querySelector(isImage ? ".image-source" : ".video-source");
  const t = el.querySelector(isImage ? ".image-title" : ".video-title");
  const raw = (src && src.textContent || "").trim();
  const host = raw.toLowerCase().replace(/^www\./, "");
  const text = t && t.textContent || "";
  if (t && !t.dataset.ctTidy) { t.dataset.ctTidy = "1"; const x = CT.tidyTitle(text.replace(/\s+/g, " ").trim()); if (x !== text.trim()) t.textContent = x; }
  picLoad(el);
  if (!isImage) { mediaRel(el, "video", `https://${host}/ ${text}`, text); visQueue(el, "video"); return; }
  if (aiImg(host)) { el.style.display = "none"; el.dataset.ctAi = "1"; return; }
  mediaRel(el, "image", `https://${host}/ ${text}`, text);
  visQueue(el, "image");
  if (src && host !== raw) src.textContent = host;
  if (t && host) {
    const out = cleanTitle(text, `https://${host}/`);
    if (out && out !== text) { t.title = text.trim(); t.textContent = out; }
  }
};

const SEL = ".result-item, .image-card, .video-card";
const done = new WeakSet();
const handle = (el) => {
  if (done.has(el)) return;
  done.add(el);
  try {
    const c = el.classList;
    if (c.contains("result-item")) { row(el); siteItems(el); }
    else card(el, c.contains("image-card"));
  } catch (e) { console.warn("[clean-titles]", e); }
};
const scan = (n) => {
  if (n.matches(SEL)) handle(n);
  if (n.firstElementChild) n.querySelectorAll(SEL).forEach(handle);
};

// Command word at the END works like at the start ("ephemeral def", "boston weather", "tokyo time"), for every
// command with natural language on; the search stays as typed, the command's card goes on top, results below (like Google)
const CODE_TAIL = /\b(python|py|ruby|scala|elixir|groovy|kotlin|swift|lisp|clojure|julia|crystal|nim|js|javascript|ts|typescript|java|go|golang|rust|php|bash|sql|c\+\+|c#|csharp)$/i;
let tails = [["def", "define"], ["define", "define"], ["definition", "define"], ["meaning", "define"]];
fetch("/api/commands", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => {
    const add = [];
    for (const c of (j && j.commands) || []) {
      if (!c.naturalLanguage || !c.trigger) continue;
      for (const w of [c.trigger, ...(c.aliases || []), ...(c.naturalLanguagePhrases || [])]) if (w) add.push([String(w).toLowerCase(), c.trigger]);
    }
    tails = [...tails, ...add].sort((x, y) => y[0].length - x[0].length);
    glance();
  })
  .catch(() => {});
