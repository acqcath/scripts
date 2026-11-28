// ----- page/09-answers.js: answer card, AI summary spot, contested check, only-site line -----
// ===== Answer card, local answers (core answers.js: math, units, cooking, tip/percent, dates, patterns) =====
// Worked out from the search words alone, so it's drawn in the same pass that clears the panel area for a new
// search: in place before the results, nothing reserved, nothing late. While it's there, every other panel in the
// area (AI summary, math-slot...) is hidden by CSS (one answer per search; patterns and sums come first).
let ansFor = null, ansVal = null, aiVal = false;
// A course number, bare digits allowed here (the server knows whether that course exists)
const cmuQ = (q) => { const m = /^(\d{2})-?(\d{3})\b/.exec(String(q || "").trim()); return m ? CT.cmuCourse(q, new Set([`${m[1]}-${m[2]}`])) : null; };
// AI summary only where the wording asks for judgement or explanation (spec: best / vs / why / explain / compare);
// facts and how-tos get results (a snippet later). A search that names a site or a type gets a plain list, no AI.
const AI_WORDS = /^(?:why|how (?:does|do|did|is|are|can|come)|explain|what(?:'s| is| are) the (?:difference|best|point)|difference between|should i|is it worth)\b|\b(?:vs\.?|versus|compared? to|comparison|best|pros and cons|worth it|better than|or)\b/i;
const TYPE_WORDS = /\b(?:pdf|paper|reddit|docs|documentation|recipe|github|lab|lecture|slides|video|videos|youtube|wiki|wikipedia)\b/i;
const aiWanted = (q) => {
  if (!AI_ON.on || !q || q.startsWith("!") || (AI_ON.qmark && !q.trim().endsWith("?"))) return false;
  // Every search gets the AI spot at the top unless something else fills it (an answer, a featured snippet, the
  // phone's knowledge panel card: they take its place) or the search wants a plain list (type words, site, shape)
  if (TYPE_WORDS.test(q) || shaped(q) || bangFor(q) || /\bbest buy\b/i.test(q)) return false;
  if (CT.eolQuery(q) || CT.wdQuery(q)) return false; // a fact or version answer comes first
  try { if (CT.namedSites(q, PSL()).size) return false; } catch {}
  return true;
};
// The AI spot: label, 3 text lines and the ⌄ line, at its final size before the results are drawn. ai-summary's
// panel (it comes after the results) stays where degoog put it, so degoog's own panel bookkeeping keeps working
// (it clears and sweeps that area), but CSS lays it over the spot's 3 lines: it takes no room and its text covers
// the placeholder lines once it streams. It never grows by itself: ⌄ opens it (your tap). No panel within degoog's
// slot limit (SLOT_PLUGIN_TIMEOUT_MS 10 s, + 2 s for the trip) after the results, or a failed answer
// -> "AI summary unavailable" in the same space.
const AIS = { key: "", got: false, fail: false, open: false, t: 0, shape: undefined, asked: false };
const aiBox = () => {
  const box = mk("div", "ct-ai");
  const label = mk("div", "ct-ai-label");
  label.append(mk("span", "ct-ai-star", "✦"), " AI summary");
  const text = mk("div", "ct-ai-text");
  for (let i = 0; i < 3; i++) text.append(mk("span", "ct-ai-line"));
  text.append(mk("div", "ct-ai-err", "AI summary unavailable"));
  const more = mk("button", "ct-ai-more", "⌄");
  more.type = "button";
  more.setAttribute("aria-label", "Show the whole AI summary");
  box.append(label, text, more);
  return box;
};
const aiPass = (g, key) => {
  if (AIS.key !== key) { clearTimeout(AIS.t); Object.assign(AIS, { key, got: false, fail: false, open: false, t: 0, shape: undefined, asked: false }); }
  // Answer shape (M4): decided by the needs call while ai-summary's panel hasn't come yet; the shaped answer fills
  // this same spot (same size, so nothing moves) and ai-summary's panel stays hidden. Text from ai-summary's model.
  if (aiVal && AIS.shape === undefined) { const nd = ready("needs", key); if (AIS.got || nd === null) AIS.shape = ""; else if (nd) AIS.shape = CT.shapePick(nd); }
  let n = 0;
  for (const p of g.querySelectorAll(".glance-ai")) {
    const w = [...g.children].find((c) => c.contains(p)) || p;
    // Not an AI search (or a second panel, or a shaped answer has the spot): never drawn
    if (!aiVal || AIS.shape || n++) { w.style.display = "none"; w.dataset.ctHid = "1"; w.classList.remove("ct-ai-panel"); continue; }
    if (w.dataset.ctHid) { delete w.dataset.ctHid; w.style.display = ""; } // shown again after a shaped answer fell through
    w.classList.add("ct-ai-panel");
    AIS.got = true;
    if (p.querySelector('.glance-ai-stream[data-state="error"]')) AIS.fail = true;
  }
  if (!aiVal) return;
  if (!AIS.shape && AIS.got && !n) AIS.fail = true; // ai-summary took its panel away ("hide on error")
  if (AIS.shape && !AIS.asked && document.querySelector("#results-list .result-item")) shapeAsk(g, key);
  if (!AIS.got && !AIS.t && drawnFor === key) AIS.t = setTimeout(() => { if (!AIS.got && AIS.key === key) { AIS.fail = true; const b = document.querySelector("#at-a-glance > .ct-ai"); if (b) b.classList.add("ct-ai-fail"); } }, 12000);
  let box = [...g.children].find((c) => c.classList.contains("ct-ai"));
  if (!box) { g.style.display = ""; box = aiBox(); g.prepend(box); }
  box.classList.toggle("ct-ai-fail", AIS.fail);
  box.classList.toggle("ct-ai-open", AIS.open && !AIS.fail);
  box.classList.toggle("ct-shape", !!AIS.shape);
  g.classList.toggle("ct-ai-opened", AIS.open && !AIS.fail && !AIS.shape);
};
// The top results as the model sees them (title, snippet, address)
const topRes = (n) => [...document.querySelectorAll("#results-list .result-item")].filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped")).slice(0, n).map(info).filter(Boolean)
  .map((r) => ({ t: r.title, s: r.snippet, u: r.href, h: r.h }));
const SHAPE_NAME = { steps: "Steps", compare: "Comparison", timeline: "Timeline", chart: "Chart" };
const shapeAsk = (g, key) => {
  AIS.asked = true;
  AIS.got = true; // the spot is ours now: ai-summary's timeout doesn't apply
  const q = curQ(), rs = topRes(6), k = AIS.shape;
  const back = () => { if (AIS.key !== key) return; AIS.shape = ""; AIS.got = false; clearTimeout(AIS.t); AIS.t = 0; aiPass(g, key); }; // no shaped answer: ai-summary's own text shows in the spot
  bridge("shape", {}, JSON.stringify({ q, k, r: rs })).then((j) => {
    if (AIS.key !== key) return;
    const a = j && j.a, box = [...g.children].find((c) => c.classList.contains("ct-ai"));
    if (!a || !box) return back();
    box.querySelector(".ct-ai-label").replaceChildren(mk("span", "ct-ai-star", "✦"), ` AI summary · ${SHAPE_NAME[a.k] || ""}`);
    box.querySelector(".ct-ai-text").append(shapeBody(a, rs));
    box.classList.add("ct-shaped");
  }, back);
};
const shapeBody = (a, rs) => {
  const body = mk("div", "ct-sh");
  if (a.k === "steps") { const ol = mk("ol", "ct-sh-steps"); a.steps.forEach((x) => ol.append(mk("li", "", x))); body.append(ol); }
  else if (a.k === "timeline") { const ol = mk("ol", "ct-sh-time"); a.events.forEach(([d, e]) => { const li = mk("li"); li.append(mk("span", "ct-sh-d", d), mk("span", "", e)); ol.append(li); }); body.append(ol); }
  else if (a.k === "compare") {
    const t = mk("table", "ct-sh-table"), hd = mk("tr");
    hd.append(mk("th"), ...a.cols.map((c) => mk("th", "", c)));
    t.append(hd);
    a.rows.forEach((r) => { const tr = mk("tr"); tr.append(mk("th", "", r[0]), ...r.slice(1).map((c) => mk("td", "", c))); t.append(tr); });
    body.append(t);
  } else if (a.k === "chart") {
    const max = Math.max(...a.bars.map((b) => b[1])) || 1, box = mk("div", "ct-sh-bars");
    a.bars.forEach(([l, v]) => { const row = mk("div", "ct-sh-bar"), tr = mk("span", "ct-sh-tr"), fill = mk("span", "ct-sh-fill"); fill.style.width = `${(100 * v) / max}%`; tr.append(fill); row.append(mk("span", "ct-sh-l", l), tr, mk("span", "ct-sh-v", `${v.toLocaleString()}${a.unit ? ` ${a.unit}` : ""}`)); box.append(row); });
    body.append(box);
  }
  const src = (a.src || []).map((i) => rs[i]).filter(Boolean);
  if (src.length) { const p = mk("div", "ct-sh-src"); p.append("From "); src.forEach((r, i) => { if (i) p.append(" · "); const l = mk("a", "", r.h); l.href = r.u; l.rel = "noopener"; p.append(l); }); body.append(p); }
  return body;
};

// ===== Contested check (M4): question-style searches only (needs call). ai-summary's model reads the top results;
// only when credible ones actually disagree, a both-sides panel goes in below the fold (never above what you see),
// waiting for a result below the screen if none is there yet. =====
const SD = { key: "", asked: false, d: null, done: false };
const sidesPass = () => {
  const key = searchId(), list = document.getElementById("results-list");
  if (SD.key !== key) { Object.assign(SD, { key, asked: false, d: null, done: false }); document.querySelectorAll(".ct-sides").forEach((x) => x.remove()); }
  if (!webTab || SD.done || !list || shaped()) return;
  if (!SD.asked) {
    const nd = ready("needs", key);
    if (nd === undefined || !list.querySelector(".result-item")) return;
    SD.asked = true;
    let pg = 1; try { pg = Number(new URL(key).searchParams.get("page") || 1); } catch {}
    if (!nd || pg > 1 || !CT.questionStyle(nd)) { SD.done = true; return; }
    const rs = topRes(8);
    SD.rs = rs;
    bridge("sides", {}, JSON.stringify({ q: curQ(), r: rs })).then((j) => { if (SD.key !== key) return; SD.d = j && j.d; if (!SD.d || !SD.d.split) SD.done = true; else safe("sides", sidesPass); }, () => { SD.done = true; });
    return;
  }
  if (!SD.d) return;
  const v = [...list.querySelectorAll(".result-item")].filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped"));
  const below = v.find((el) => el.getBoundingClientRect().top >= innerHeight);
  if (!below) return; // wait for endless scroll to put a result below the screen
  SD.done = true;
  const s = section("ct-sides", "Sources disagree");
  const cols = mk("div", "ct-sides-cols");
  for (const side of [SD.d.a, SD.d.b]) {
    const c = mk("div", "ct-sides-c");
    c.append(mk("div", "ct-sides-claim", side.claim));
    const p = mk("div", "ct-sh-src");
    side.src.map((i) => SD.rs[i]).filter(Boolean).forEach((r, i) => { if (i) p.append(" · "); const l = mk("a", "", r.h); l.href = r.u; l.rel = "noopener"; p.append(l); });
    c.append(p);
    cols.append(c);
  }
  s.append(cols);
  below.before(s);
};
addEventListener("scroll", () => { if (SD.d && !SD.done) safe("sides", sidesPass); }, { passive: true });
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest(".ct-ai-more");
  if (!b || AIS.fail) return;
  const g = document.getElementById("at-a-glance");
  AIS.open = true;
  if (AIS.shape) { if (g) aiPass(g, AIS.key); return; } // a shaped answer just opens in place
  if (g) { aiPass(g, AIS.key); g.querySelector(".ct-ai-panel .glance-ai-expand")?.click(); } // ai-summary's own "read more": unclamps, opens its follow-up chat
});
const ansCard = (a) => {
  const box = mk("div", "ct-ans");
  box.dataset.kind = a.kind;
  if (a.copy) { box.tabIndex = 0; box.setAttribute("role", "button"); box.dataset.copy = a.copy; box.setAttribute("aria-label", `${a.value || a.title || a.copy}. Copy`); }
  const label = mk("div", "ct-ans-label");
  label.append(mk("span", "ct-ans-l", a.src ? `${a.label} · ${a.src}` : a.label), mk("span", "ct-ans-copied", "Copied"));
  box.append(label);
  if (a.kind === "snippet") {
    // The sentence as the page wrote it, then the page itself (title link, like a result)
    box.append(mk("div", "ct-ans-text", a.text));
    const t = mk("a", "ct-ans-src", a.title || a.h); t.href = a.href; t.rel = "noopener";
    box.append(t);
  } else if (a.href) { const t = mk("a", "ct-ans-title", a.title); t.href = a.href; t.rel = "noopener"; box.append(t); }
  else if (a.kind !== "sports") {
    const v = mk("div", "ct-ans-value");
    if (a.swatch) { const sw = mk("span", "ct-ans-sw"); sw.style.background = a.swatch; v.append(sw); }
    v.append(a.value);
    box.append(v);
  }
  if (a.detail && a.kind !== "sports") box.append(mk("div", "ct-ans-detail", a.detail));
  if (a.kind === "sports") {
    // Label line: "NFL · Final" or "NFL · ● Live · Q3 4:12" (pulsing red dot); then logos, teams and scores
    const l = box.querySelector(".ct-ans-l");
    l.textContent = `${a.label} · `;
    if (a.live) l.append(mk("span", "ct-live-dot"), "Live · ");
    l.append(mk("span", "ct-sp-status", a.status));
    const row = mk("div", "ct-sp");
    a.teams.forEach((t, i) => {
      const side = mk("span", `ct-sp-team${t.winner ? " ct-win" : ""}`);
      const logo = mk("span", "ct-sp-logo");
      if (t.logo) { const im = new Image(); im.alt = ""; im.decoding = "async"; im.onload = () => im.classList.add("ct-on"); im.src = t.logo; logo.append(im); }
      side.append(logo, mk("span", "ct-sp-abbr", t.abbr));
      if (a.showScore) side.append(mk("span", "ct-sp-score", t.score));
      if (i === 0) side.classList.add("ct-sp-away");
      row.append(side);
      if (i === 0) row.append(mk("span", "ct-sp-dash", a.showScore ? "–" : "at"));
    });
    box.append(row);
    if (a.detail) box.append(mk("div", "ct-ans-detail", a.detail));
  }
  if (a.kind === "cmu") {
    // Facts line: "12 units · 14.3 hrs/wk · 4.0 ★★★★☆ · prereq 15-122"; people line: "Spring 2026 · Railing 4.3 · +N"
    const facts = mk("div", "ct-ans-detail ct-fit ct-fit-drop");
    a.parts.forEach((p) => {
      if (typeof p === "string") { facts.append(mk("span", "ct-it", p)); return; }
      const r = mk("span", "ct-it ct-rating", `${p.stars.toFixed(1)} `);
      const st = mk("span", "ct-stars", "★★★★★");
      st.style.setProperty("--r", String(p.stars));
      st.setAttribute("aria-label", `${p.stars.toFixed(1)} out of 5`);
      r.append(st);
      facts.append(r);
    });
    const people = mk("div", "ct-ans-detail ct-fit");
    if (a.sem) people.append(mk("span", "", a.sem));
    for (const p of a.profs) { const it = mk("span", "ct-it"); it.append(mk("span", "ct-fn", `${p.full.slice(0, p.full.length - p.last.length)}`), `${p.last} ${p.r}`); people.append(it); }
    people.append(mk("span", "ct-plus"));
    if (a.prof) box.append(people, facts); else box.append(facts, people);
  }
  return box;
};
// Live game: score and status refreshed in place (same size: tabular digits, fixed logo boxes) while the game is on
// and this tab is visible, every 60 s: the server keeps a live game for 60 s, so asking more often gets the same.
let liveT = 0;
const livePoll = (key, q) => {
  clearTimeout(liveT);
  liveT = setTimeout(async () => {
    if (searchId() !== key) return;
    if (document.visibilityState !== "visible") { document.addEventListener("visibilitychange", () => livePoll(key, q), { once: true }); return; }
    const j = await bridge("sports", { q }).catch(() => null);
    const a = j && j.g && CT.sportsAnswer(j.g);
    const box = document.querySelector("#at-a-glance > .ct-ans[data-kind=sports]");
    if (!a || !box || searchId() !== key) return;
    ansVal = a;
    box.querySelectorAll(".ct-sp-score").forEach((el, i) => { el.textContent = a.teams[i].score; });
    box.querySelectorAll(".ct-sp-team").forEach((el, i) => el.classList.toggle("ct-win", !!a.teams[i].winner));
    const st = box.querySelector(".ct-sp-status");
    if (st) st.textContent = a.status;
    if (!a.live) box.querySelector(".ct-live-dot")?.remove(); else livePoll(key, q);
  }, 60000);
};
// One line, items never cut (re-measured when the width changes): people that don't fit fold into "+N"; mixed
// facts (units, hours, rating, prereq) that don't fit are dropped whole from the end, never a bare "+N"
const fitLine = (line) => {
  const its = [...line.querySelectorAll(".ct-it")], more = line.querySelector(".ct-plus");
  if (!its.length) return;
  its.forEach((x) => { x.hidden = false; });
  if (more) more.hidden = true;
  let hid = 0;
  while (line.scrollWidth > line.clientWidth + 1 && hid < its.length - 1) { its[its.length - 1 - hid].hidden = true; hid++; if (more) { more.hidden = false; more.textContent = `+${hid}`; } }
};
const fitRO = typeof ResizeObserver === "function" ? new ResizeObserver((es) => es.forEach((e) => e.target.querySelectorAll(".ct-fit").forEach(fitLine))) : null;
// Where a card goes on the one scale (answer card, info panel): before the first shown result worth less, or null =
// on top (also without the AI, or before the results are on the page)
// A result's whole group: the result plus what hangs under it (its "N more from…" fold rows and the folded or hidden
// results behind them). Boxes placed "after a result" go after the group, never inside it.
const endOf = (el) => {
  let n = el;
  for (let x = n.nextElementSibling; x && (x.classList.contains("ct-fold") || x.classList.contains("ct-grouped") || x.classList.contains("result-item") && (x.hidden || x.style.display === "none")); x = x.nextElementSibling) n = x;
  return n;
};
const byWorth = (kind, fit) => {
  const list = document.getElementById("results-list"), key = searchId();
  const needs = ready("needs", key), fmt = CT.fmtShares(needs?.f), share = CT.blockShare(fmt, needs?.b, kind);
  if (!list || share == null) return null;
  const v = [...list.querySelectorAll(".result-item")].filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped") && !el.dataset.ctKp);
  if (!v.length) return null;
  const i = CT.boxAt(fmt, v.map((el) => info(el)?.ai), share * fit, 0);
  return i === 0 ? null : i >= v.length ? { after: v[v.length - 1] } : { before: v[i] };
};
const ansPass = () => {
  const g = document.getElementById("at-a-glance");
  if (!g) return;
  const key = searchId();
  if (ansFor !== key) {
    ansFor = key;
    let q = "", page = 1;
    try { const u = new URL(key); q = (u.searchParams.get("q") || "").trim(); page = Number(u.searchParams.get("page") || 1); } catch {}
    ansVal = webTab && page <= 1 && SHOW.ans !== false ? CT.answer(q, Date.now(), { fx: FX }) : null;
    aiVal = webTab && page <= 1 && !ansVal && aiWanted(q);
    g.querySelectorAll(".ct-ans, .ct-ai").forEach((x) => x.remove());
    document.querySelectorAll("#results-list > .ct-ans").forEach((x) => x.remove());
  }
  // Network answers (endoflife.date...): only in the pass that draws the results, and only if already in hand;
  // later than that they're dropped for this page (the server keeps them for the next search)
  if (!ansVal && drawnFor !== key && document.querySelector("#results-list .result-item")) {
    let q = "";
    try { q = new URL(key).searchParams.get("q") || ""; } catch {}
    const j = ready("eol", key), w = ready("wd", key), cm = ready("cmu", key);
    if (j && j.cycles) ansVal = CT.eolAnswer(CT.eolQuery(q), j.cycles);
    else if (w && w.d) ansVal = CT.wdAnswer(CT.wdQuery(q), w.d);
    else if (cm && cm.c) ansVal = CT.cmuAnswer(cmuQ(q), cm.c.course, cm.c.fces);
    else { const sp = ready("sports", key); if (sp && sp.g) { ansVal = CT.sportsAnswer(sp.g); if (ansVal && ansVal.live) livePoll(key, q); } }
    // Featured snippet (fact / how-to wording): a whole sentence from one of the first results now on the page,
    // drawn in this same pass. Not on page 2+, plain-list searches, or when an answer above came first.
    let pg = 1;
    try { pg = Number(new URL(key).searchParams.get("page") || 1); } catch {}
    // A shaped answer picked by the needs call (steps, table...) is the richer answer for the spot: no snippet then
    const shapeNext = aiVal && !!CT.shapePick(ready("needs", key));
    if (globalThis.CT_NOSNIP !== true && !ansVal && !shapeNext && SHOW.ans !== false && webTab && !TYPE_WORDS.test(q) && !shaped(q) && pg <= 1) {
      const rs = [...document.querySelectorAll("#results-list .result-item")].filter((el) => el.style.display !== "none" && !el.classList.contains("ct-grouped")).slice(0, 6).map(info).filter(Boolean);
      const f = CT.featuredSnippetAI(q, rs) || (rs.some((r) => r.best) ? null : CT.featuredSnippet(q, rs));
      if (f) ansVal = { ...f, label: `From ${f.h}` };
    }
  }
  // An answer or snippet found in the results pass takes the AI spot (same pass, before paint: nothing moves)
  if (ansVal && aiVal) { aiVal = false; g.querySelectorAll(".ct-ai").forEach((x) => x.remove()); }
  aiPass(g, key);
  if (!ansVal || g.querySelector(".ct-ans") || document.querySelector("#results-list > .ct-ans")) return;
  const card = ansCard(ansVal);
  // Its place by worth (M2), when the results are already here (else on top, as before): the answer share x its fit
  // (the AI's score for a snippet's sentence; an exact answer fits fully). A live score stays on top (its updates find it there).
  const at = !ansVal.live && byWorth("answer", typeof ansVal.p === "number" ? ansVal.p : 1);
  if (at) { if (at.before) at.before.before(card); else endOf(at.after).after(card); }
  else { g.style.display = ""; g.prepend(card); }
  card.querySelectorAll(".ct-fit").forEach(fitLine);
  if (fitRO) fitRO.observe(card);
};
// Tap (or Enter) on an instant answer copies it; "Copied" shows in its label line for a moment (same line, no shift)
const ansCopy = (e) => {
  const box = e.target.closest && e.target.closest(".ct-ans[data-copy]");
  if (!box || e.target.closest("a")) return;
  if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  const done = () => { box.classList.add("ct-copied"); clearTimeout(box._t); box._t = setTimeout(() => box.classList.remove("ct-copied"), 1500); };
  try { navigator.clipboard.writeText(box.dataset.copy).then(done, () => {}); } catch {}
};
document.addEventListener("click", ansCopy);
document.addEventListener("keydown", ansCopy);

// "Only reddit.com results ›": a search naming a site to filter by, where that site has few of the first results.
// Drawn above the results in the pass that draws them (never later); runs the site: search only when tapped.
let onlyKey = "";
const onlyPass = () => {
  const key = searchId(), list = document.getElementById("results-list");
  if (!webTab || !list || onlyKey === key || drawnFor === key) return;
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none");
  if (!rows.length) return;
  onlyKey = key;
  document.querySelectorAll(".ct-only").forEach((x) => x.remove());
  let page = 1;
  try { page = Number(new URL(key).searchParams.get("page") || 1); } catch {}
  const q = curQ();
  if (page > 1) return;
  const d = CT.onlyLine(q, rows.map((x) => siteOf(rowHost(x))));
  if (!d) return;
  const a = mk("a", "ct-only", `Only ${d} results`);
  a.append(mk("span", "ct-chev", " ›"));
  const u = new URL(location.href);
  u.searchParams.set("q", CT.onlyQuery(q, d));
  u.searchParams.delete("page");
  a.href = u.pathname + u.search;
  const kpEl = [...list.children].find((x) => x.classList.contains("ct-kp"));
  if (kpEl) kpEl.after(a); else list.prepend(a);
};

