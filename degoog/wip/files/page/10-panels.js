// ----- page/10-panels.js: quick view, inline stars, meaning line, knowledge panel, product panel -----
// ===== Quick view (spec 11): your tap opens it under the result (it grows: your action), tap again to close =====
const QV_SHOW = { ingredients: 8, steps: 3, questions: 3 };
const qvBox = (v) => {
  const box = mk("div", "ct-qv");
  if (!v) { box.append(mk("div", "ct-qv-none", "No quick view for this page")); return box; }
  // Headline rating: number then 5 amber stars filled to the exact value (design system), count after
  const fl = mk("div", "ct-qv-facts ct-fit ct-fit-drop");
  for (const [k, x] of v.facts) {
    if (k === "Access") continue;
    const m = k === "Rating" && /^(\d+(?:\.\d)?) ★(.*)$/.exec(x);
    if (m) { const it = mk("span", "ct-it ct-rating", `${m[1]} `); const st = mk("span", "ct-stars", "★★★★★"); st.style.setProperty("--r", m[1]); st.setAttribute("aria-label", `${m[1]} out of 5`); it.append(st); if (m[2].trim()) it.append(m[2]); fl.append(it); continue; }
    fl.append(mk("span", "ct-it", k === "Total time" || k === "Time" ? x : `${k} ${x}`));
  }
  if (fl.children.length) box.append(fl);
  for (const l of v.lists) {
    if (l.para) { box.append(mk("p", "ct-qv-p", l.items[0])); continue; }
    const n = QV_SHOW[l.label] || 3;
    const ul = mk(l.ordered ? "ol" : "ul", `ct-qv-list${l.qa ? " ct-qv-qa" : ""}`);
    l.items.forEach((t, i) => {
      const li = mk("li");
      if (l.qa) { const [q, ...a] = t.split("\n"); li.append(mk("div", "ct-qv-q", q), mk("div", "ct-qv-a", a.join(" "))); } else li.textContent = t;
      if (i >= n) li.hidden = true;
      ul.append(li);
    });
    box.append(ul);
    if (l.items.length > n) {
      const more = mk("button", "ct-qv-more", `${l.items.length - n} more ${l.label} ⌄`);
      more.type = "button";
      more.onclick = () => { ul.querySelectorAll("li[hidden]").forEach((x) => { x.hidden = false; }); more.remove(); };
      box.append(more);
    }
  }
  v.text.slice(0, 3).forEach((t) => box.append(mk("p", "ct-qv-p", t)));
  return box;
};
document.addEventListener("click", async (e) => {
  const b = e.target.closest && e.target.closest(".ct-qv-b");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const el = b.closest(".result-item");
  const a = el && el.querySelector("a.result-title");
  const body = el && el.querySelector(".result-body");
  const u = (el && el.dataset.resultUrl) || (a && a.href) || "";
  const menu = b.closest(".result-actions-menu");
  if (menu) menu.hidden = true;
  if (!u || !body) return;
  const open = [...body.children].find((x) => x.classList.contains("ct-qv"));
  if (open) { open.remove(); b.textContent = "Quick view"; return; }
  const box = mk("div", "ct-qv"); box.append(mk("div", "ct-qv-none", "Loading quick view…"));
  body.append(box);
  b.textContent = "Close quick view";
  const j = await bridge("qv", { u }).catch(() => null);
  if (!box.isConnected) return;
  const v = j && j.v && Array.isArray(j.v.facts) && Array.isArray(j.v.lists) && Array.isArray(j.v.text) ? j.v : null;
  const nb = qvBox(v);
  box.replaceWith(nb);
  nb.querySelectorAll(".ct-fit").forEach(fitLine);
  if (fitRO) fitRO.observe(nb);
  // The page says it's for subscribers (isAccessibleForFree: false): the Paywall word joins the source line
  const cite = el.querySelector(".result-cite");
  if (v && v.facts.some(([k, x]) => k === "Access" && x === "Paywall") && cite && !el.querySelector(".result-url-row .ct-paywall:not(.ct-pdf)")) cite.after(mk("span", "ct-paywall", "Paywall"));
}, true);

// Inline "4.8 ★ · 45 min" on the source line of first-screen results for recipe and review searches (spec 11).
// Drawn before paint from this browser's copy (ct-qvs, 12 h); results not in it are asked for after the results are
// drawn (server reads their pages, skipping sites that block it) and kept for the next visit: never inserted late.
const QVS_KEY = "ct-qvs";
const qvs = (() => { let m = {}; try { const c = JSON.parse(localStorage.getItem(QVS_KEY) || "{}"); if (c && typeof c === "object") m = c; } catch {} const now = Date.now(); for (const k of Object.keys(m)) if (!(now - m[k][1] < 432e5)) delete m[k]; return m; })();
const starsWanted = (q) => CT.shapeOf(q) === "recipe" || /\b(?:reviews?|rating|ratings|rated)\b/i.test(q);
let starsKey = "";
const starsPass = () => {
  const key = searchId(), list = document.getElementById("results-list");
  if (!webTab || !list || SHOW.stars === false || starsKey === key || drawnFor === key) return;
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none" && !x.classList.contains("ct-grouped")).slice(0, 6);
  if (!rows.length) return;
  starsKey = key;
  let page = 1;
  try { page = Number(new URL(key).searchParams.get("page") || 1); } catch {}
  if (page > 1 || !starsWanted(curQ())) return;
  const ask = [];
  for (const el of rows) {
    const a = el.querySelector("a.result-title"), u = (el.dataset.resultUrl || (a && a.href) || "");
    const c = u && qvs[qHash(u)], cite = el.querySelector(".result-cite");
    if (c && cite) {
      const t = mk("span", "ct-paywall ct-stars-l");
      const m = /^(\d+(?:\.\d)?) ★(.*)$/.exec(c[0]);
      if (m) { t.append(`${m[1]} `); const st = mk("span", "ct-stars", "★★★★★"); st.style.setProperty("--r", m[1]); st.setAttribute("aria-label", `${m[1]} out of 5`); t.append(st, m[2]); } else t.textContent = c[0];
      (el.querySelector(".result-url-row .ct-pdf, .result-url-row .ct-paywall, .result-url-row .ct-date") || cite).after(t);
    }
    else if (u && !c) ask.push(u);
  }
  if (ask.length) setTimeout(() => bridge("qvs", {}, JSON.stringify({ u: ask })).then((j) => {
    if (!j || !j.s || typeof j.s !== "object") return;
    for (const [u, t] of Object.entries(j.s)) if (typeof t === "string" && t.length < 60) qvs[qHash(u)] = [t, Date.now()];
    const ks = Object.keys(qvs); if (ks.length > 500) ks.sort((a, b) => qvs[a][1] - qvs[b][1]).slice(0, ks.length - 500).forEach((k) => delete qvs[k]);
    try { localStorage.setItem(QVS_KEY, JSON.stringify(qvs)); } catch {}
  }).catch(() => {}), 0);
};

// Meaning line (spec 9): "Also: snakes · Monty Python" above the results when the words have several meanings and
// the results cover one (CT.meaningLine, from the knowledge panel's answer). Results pass only, never later.
let meanKey = "";
const meanPass = () => {
  const key = searchId(), list = document.getElementById("results-list");
  if (!webTab || !list || SHOW.mean === false || meanKey === key || drawnFor === key) return;
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none");
  if (!rows.length) return;
  meanKey = key;
  document.querySelectorAll(".ct-mean").forEach((x) => x.remove());
  const d = ready("kp", key), alts = d && d.kp && d.kp.alts;
  if (!alts) return;
  const q = curQ();
  const chips = CT.meaningLine(q, alts, rows.slice(0, 10).map((x) => `${x.querySelector("a.result-title")?.textContent || ""} ${x.querySelector(".result-snippet")?.textContent || ""}`));
  if (!chips) return;
  const line = mk("div", "ct-mean");
  line.append(mk("span", "ct-mean-l", "Also: "));
  chips.forEach((c, i) => { if (i) line.append(mk("span", "ct-mean-dot", " · ")); const a = mk("a", "ct-mean-a", c.text); a.href = goTo(c.q); line.append(a); });
  const after = [...list.children].find((x) => x.classList.contains("ct-kp") || x.classList.contains("ct-only"));
  if (after) after.after(line); else list.prepend(line);
};

// ===== Knowledge panel (spec 3) =====
// Asked at page load for short name-like searches that get no other answer, no AI and no plain type/site list.
// Shown only when the results hold the same article (CT.kpMatch); the Wikipedia result itself is then hidden, and
// degoog's own Wikipedia card is always hidden (CSS): this replaces it, and it arrived late on phones (sidebar on top).
// Wide screens: a right column top-aligned with the first result, laid out absolutely beside the list, so it moves
// nothing even when it arrives after the results. Narrower: a compact card (name, type, one line of facts, More ⌄)
// at the top of the list, drawn only in the pass that draws the results.
const KP_WIDE = "(min-width: 1180px)";
const kpWanted = (q) => {
  if (!webTab || !CT.kpQuery(q) || shaped(q) || bangFor(q) || TYPE_WORDS.test(q) || CT.answer(q, Date.now(), { fx: FX }) || AI_WORDS.test(q)) return false;
  try { if (CT.namedSites(q, PSL()).size) return false; } catch {}
  return true;
};
let kpKey = "";
const kpCard = (kp, wide) => {
  const box = mk("aside", `ct-kp${wide ? " ct-kp-wide" : ""}`);
  box.setAttribute("aria-label", `About ${kp.name}`);
  const wiki = `https://en.wikipedia.org/wiki/${encodeURIComponent(kp.title.replace(/ /g, "_"))}`;
  if (wide && kp.photo) {
    const ph = mk("div", `ct-kp-photo${kp.type === "person" ? " ct-kp-portrait" : ""}`);
    const im = new Image(); im.alt = ""; im.decoding = "async"; im.referrerPolicy = "no-referrer";
    im.onload = () => im.classList.add("ct-on"); im.onerror = () => { ph.style.visibility = "hidden"; };
    im.src = kp.photo; ph.append(im); box.append(ph);
  }
  const head = mk("div", "ct-kp-head");
  const name = mk("a", "ct-kp-name", kp.name); name.href = wiki; name.rel = "noopener";
  head.append(name);
  const type = kp.desc ? kp.desc.charAt(0).toUpperCase() + kp.desc.slice(1) : "";
  if (type) head.append(mk("div", "ct-kp-type", type));
  box.append(head);
  const ext = mk("p", "ct-kp-ext", kp.extract || "");
  const facts = mk("dl", "ct-kp-facts");
  for (const f of kp.facts || []) { const r = mk("div", "ct-kp-f"); r.append(mk("dt", "", f.k), mk("dd", "", f.v)); facts.append(r); }
  // Source line; its "Wikipedia" opens the article (the 2-line description is clamped, so the link lives here)
  const src = mk("div", "ct-kp-src");
  const wl = mk("a", "ct-kp-wl", "Wikipedia ↗"); wl.href = wiki; wl.rel = "noopener";
  src.append(wl, " · Wikidata");
  if (wide) { if (kp.extract) box.append(ext); if (kp.facts && kp.facts.length) box.append(facts); box.append(src); return box; }
  // Compact: one line of facts that never wraps (fitLine drops whole facts from the end), More ⌄ opens the rest here
  const line = mk("div", "ct-kp-line ct-fit ct-fit-drop");
  for (const t of CT.kpLine(kp.facts)) line.append(mk("span", "ct-it", t));
  if (line.children.length) box.append(line);
  const more = mk("div", "ct-kp-more");
  if (kp.extract) more.append(ext);
  if (kp.facts && kp.facts.length) more.append(facts);
  more.append(src);
  more.hidden = true;
  const b = mk("button", "ct-kp-open", "More ⌄"); b.type = "button"; b.setAttribute("aria-expanded", "false");
  box.append(more, b);
  return box;
};
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest(".ct-kp-open");
  if (!b) return;
  const more = b.parentElement.querySelector(".ct-kp-more"), open = more.hidden;
  more.hidden = !open; b.textContent = open ? "Less ⌃" : "More ⌄"; b.setAttribute("aria-expanded", String(open));
});
const kpPass = () => {
  const key = searchId(), list = document.getElementById("results-list");
  if (kpKey !== key) { kpKey = key; document.querySelectorAll(".ct-kp").forEach((x) => x.remove()); }
  if (!list || !webTab || SHOW.kp === false || [...list.children].find((x) => x.classList.contains("ct-kp"))) return;
  const d = ready("kp", key), kp = d && d.kp;
  if (!kp || !kp.title || !kp.name) return;
  const late = drawnFor === key, wide = !!(window.matchMedia && matchMedia(KP_WIDE).matches);
  // Phones: on top of the list. Late (after the results are on screen) only in place of the AI spot, so the list
  // moves by the small difference in height instead of the whole card
  const spot = !wide ? document.querySelector("#at-a-glance > .ct-ai") : null;
  if (late && !wide && !spot) return;
  const rows = [...list.querySelectorAll(".result-item")];
  if (!rows.length) return;
  const m = CT.kpMatch(kp.title, rows.map((r) => r.querySelector("a.result-title")?.href || ""), kp.hosts);
  if (!m.ok) return;
  if (!late) for (const i of m.wiki) rows[i].dataset.ctKp = "1"; // the panel replaces that result (before paint only)
  const card = kpCard(kp, wide);
  // Phones: its place by worth (M2): the info share x the AI's score for the page it replaces. PC: the side column.
  const fit = Math.max(...m.wiki.map((i) => info(rows[i])?.ai).filter((x) => typeof x === "number"));
  const at = !wide && !late && isFinite(fit) && byWorth("info", fit);
  if (at) { if (at.before) at.before.before(card); else endOf(at.after).after(card); } else list.prepend(card);
  if (!wide && aiVal) { aiVal = false; document.querySelectorAll("#at-a-glance > .ct-ai").forEach((x) => x.remove()); const g = document.getElementById("at-a-glance"); if (g) aiPass(g, key); } // the panel is what's on top now
  card.querySelectorAll(".ct-fit").forEach(fitLine);
  if (fitRO) fitRO.observe(card);
};

// Product panel (M6): asked once the results are on the page, when the needs call says a product panel is worth more
// than the first-screen cutoff (core blockGo, the same rule as the other blocks). The server reads the top results'
// pages. Wide screens: the right column (under the info panel when there is one), so it moves nothing. Phones: it
// arrives after the results are on screen, so it goes in at the first result below the screen (moves nothing seen).
const PD = { key: "", asked: false, d: null, done: false };
const money = (n, cur) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n); } catch { return `${n} ${cur}`; } };
const prodCard = (p, wide) => {
  const box = mk("aside", `ct-prod${wide ? " ct-prod-wide" : ""}`);
  box.setAttribute("aria-label", `Product: ${p.name}`);
  if (p.img) {
    const ph = mk("div", "ct-prod-photo");
    const im = new Image(); im.alt = ""; im.decoding = "async"; im.referrerPolicy = "no-referrer";
    im.onload = () => im.classList.add("ct-on"); im.onerror = () => ph.remove();
    im.src = p.img; ph.append(im); box.append(ph);
  }
  const head = mk("div", "ct-kp-head");
  const name = mk("a", "ct-kp-name", p.name); if (/^https?:\/\//.test(p.url)) { name.href = p.url; name.rel = "noopener"; }
  head.append(name);
  if (p.brand) head.append(mk("div", "ct-kp-type", p.brand));
  box.append(head);
  const facts = mk("dl", "ct-kp-facts");
  const f = (k, v) => { if (!v) return; const r = mk("div", "ct-kp-f"); r.append(mk("dt", "", k), mk("dd", "", v)); facts.append(r); };
  if (p.price) f("Price", `${money(p.price.lo, p.price.cur)}${p.price.hi > p.price.lo ? ` – ${money(p.price.hi, p.price.cur)}` : ""}${p.price.sellers > 1 ? ` (${p.price.sellers} sellers)` : ""}`);
  if (p.rating) f("Rating", `${p.rating.v.toFixed(1)} ★${p.rating.n ? ` (${p.rating.n.toLocaleString("en-US")})` : ""}`);
  f("Released", p.rel);
  for (const [k, v] of p.specs || []) f(k, v);
  box.append(facts);
  if (p.from && p.from.length) box.append(mk("div", "ct-kp-src", `From ${[...new Set(p.from)].slice(0, 4).join(" · ")}`));
  return box;
};
const productPass = () => {
  const key = searchId(), list = document.getElementById("results-list");
  if (PD.key !== key) { Object.assign(PD, { key, asked: false, d: null, done: false }); document.querySelectorAll(".ct-prod").forEach((x) => x.remove()); }
  if (!webTab || SHOW.kp === false || PD.done || !list) return;
  if (!PD.asked) {
    const nd = ready("needs", key);
    if (nd === undefined || !list.querySelector(".result-item")) return;
    PD.asked = true;
    let pg = 1; try { pg = Number(new URL(key).searchParams.get("page") || 1); } catch {}
    // Asked on every first page (v98, the user: "any time I put the name of a product in"): whether there is a product
    // is decided by the real signal, product data on the top pages (CT.prodShow), not by the AI's block share, which
    // judged "yamaha dbr10 release" not worth a panel
    if (pg > 1 || shaped()) { PD.done = true; return; }
    const rs = topRes(6);
    bridge("product", { q: curQ(), u: rs.map((r) => r.u).join("|") }).then((j) => {
      if (PD.key !== key) return;
      PD.d = CT.prodShow(j && j.v) ? j.v : null;
      if (!PD.d) PD.done = true; else safe("prod", productPass);
    }, () => { PD.done = true; });
    return;
  }
  if (!PD.d) return;
  const wide = !!(window.matchMedia && matchMedia(KP_WIDE).matches);
  if (wide) {
    PD.done = true;
    const kp = [...list.children].find((x) => x.classList.contains("ct-kp-wide"));
    if (kp) { kp.append(prodCard(PD.d, true)); return; }
    const col = mk("aside", "ct-kp ct-kp-wide ct-prod-col");
    col.append(prodCard(PD.d, true));
    list.prepend(col);
    return;
  }
  const v = [...list.querySelectorAll(".result-item")].filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped"));
  const below = v.find((el) => el.getBoundingClientRect().top >= innerHeight);
  if (!below) return; // wait for endless scroll to put a result below the screen
  PD.done = true;
  below.before(prodCard(PD.d, false));
};
addEventListener("scroll", () => { if (PD.d && !PD.done) safe("prod", productPass); }, { passive: true });

// Tab row: degoog redraws its tabs when the page comes back into view (and when extensions are saved) and can leave a
// copy of a tab, no active tab or the wrong one. One tab per kind, exactly one underlined (the one you're on), and
// Tools then ⚑ last, after every redraw.
let tabNow = "";
