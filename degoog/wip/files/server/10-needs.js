// ----- server/10-needs.js: what a search needs (one batched reranker pass), block cutoffs, unsolved-search learning -----
// ===== What a search needs (user, 2026-11-26): ONE batched reranker pass per search, before the results arrive, so
// the page can fetch and place blocks (Videos, Images, Forums, Top stories, Papers, info panel, answer card) on one
// scale with the results. Each question is a described option scored with its own instruction; no word lists.
// Groups: f = format shares (sum 1), n = needs (each 0..1, independent), b = block fits (each 0..1). Cached per search.
const NEED_TASK = "Given a web search query, judge whether the searcher needs this to be satisfied";
const FMT_TASK = "Given a web search query, judge whether this kind of result is the best way to give the searcher what they need";
const SHAPE_TASK = "Given a web search query, judge whether an answer in this shape would serve the searcher best";
const BLOCK_TASK = "Given a web search query, judge whether this block of results would help the searcher";
export const NEEDS = {
  f: [FMT_TASK, { video: "A video that shows it being done or demonstrated, step by step, in motion", image: "Pictures, photos, diagrams or charts that show what it looks like", text: "A written web page that explains or answers it in words" }],
  n: [NEED_TASK, { fresh: "Recent information: what is new, current or happening now", depth: "An in-depth, thorough explanation rather than a quick fact", trust: "An authoritative, expert or official source the searcher can rely on",
    people: "First-hand experiences and opinions from real people who tried it", doing: "Instructions to do or make something", knowing: "Information or an answer to understand or know something",
    question: "A direct answer to a specific question" }],
  b: [BLOCK_TASK, { forums: "Forum and discussion threads where people share their own experience", news: "Top news stories reporting recent events", papers: "Scientific papers and research studies",
    info: "A fact panel about one person, place, organization or thing", answer: "A short direct answer shown above the results",
    product: "A product panel with one specific product's price, specs, rating and release date",
    web: "A list of ordinary web pages about it" }],
  s: [SHAPE_TASK, { steps: "Numbered steps to follow in order", compare: "A side-by-side table comparing two or more options", timeline: "A timeline of dates and events in order",
    chart: "A chart of numbers, amounts or shares", plain: "A short written summary paragraph" }],
};
export const needsParse = (s) => {
  let i = 0;
  const out = {};
  for (const [g, [, opts]] of Object.entries(NEEDS)) {
    out[g] = {};
    for (const k of Object.keys(opts)) { const v = s[i++]; if (typeof v !== "number") return null; out[g][k] = v; }
  }
  for (const g of ["f", "s"]) { const t = Object.values(out[g]).reduce((a, b) => a + b, 0); if (t > 0) for (const k of Object.keys(out[g])) out[g][k] /= t; }
  return out;
};
// First-screen cutoff (M2): the worth (text share x AI score) of the last result each page showed on its first screen,
// last 200 searches, kept in cut.json on this server. Its median decides which blocks are worth fetching (core blockGo).
const cutFile = () => `${DIR}/cut.json`;
let CUTS = null;
const readCuts = () => { if (CUTS) return CUTS; try { const j = JSON.parse(fs.readFileSync(cutFile(), "utf8")); CUTS = Array.isArray(j) ? j.filter((x) => typeof x === "number") : []; } catch { CUTS = []; } return CUTS; };
export const cutAdd = (w) => { w = +w; if (!Number.isFinite(w) || w < 0 || w > 1) return false; const c = readCuts(); c.push(Math.round(w * 1e4) / 1e4); if (c.length > 200) c.splice(0, c.length - 200); try { fs.writeFileSync(`${cutFile()}.tmp`, JSON.stringify(c)); fs.renameSync(`${cutFile()}.tmp`, cutFile()); } catch {} return true; };
export const cutNow = () => { const v = [...readCuts()].sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
export const _cutReset = () => { CUTS = null; };
const NEEDC = new Map(), NEEDI = new Map();

// ===== Unsolved-search learning (M5): layout only, keyed by the needs profile, never sites or viewpoints =====
// The profile of a search: its top format, top need and top answer shape from the needs call ("video|doing|steps")
const topOf = (o) => { if (!o || typeof o !== "object") return ""; const e = Object.entries(o).filter(([, v]) => typeof v === "number").sort((a, b) => b[1] - a[1]); return e.length ? e[0][0] : ""; };
export const needsKey = (n) => (n ? [topOf(n.f), topOf(n.n), topOf(n.s)].join("|") : "");
// Which block a tapped link sat in, by the page's own block classes (videos and pictures are formats, the rest blocks)
export const LEARN_KINDS = { video: "f", image: "f", text: "f", forums: "b", news: "b", papers: "b", info: "b", answer: "b", web: "b" };
// Each kind's factor = (searches it solved + 1) / (the mean solves per kind in that group + 1): no solves -> 1 for all;
// a kind that solved more than its share rises, one that solved less falls, by the measured counts only
export const learnFactors = (st, keys) => {
  const s = st || {}, tot = keys.reduce((a, k) => a + (+s[k] || 0), 0), mean = tot / (keys.length || 1);
  return Object.fromEntries(keys.map((k) => [k, ((+s[k] || 0) + 1) / (mean + 1)]));
};
// The needs call's shares, nudged by what solved searches with this profile; each group keeps its total
export const nudgeNeeds = (n, st) => {
  if (!n || !st) return n;
  const out = { ...n };
  for (const g of ["f", "b"]) {
    const o = n[g];
    if (!o || typeof o !== "object") continue;
    const keys = Object.keys(o).filter((k) => typeof o[k] === "number" && LEARN_KINDS[k] === g);
    if (!keys.length) continue;
    const fac = learnFactors(st, keys), sum = keys.reduce((a, k) => a + o[k], 0), raw = keys.map((k) => o[k] * fac[k]), rs = raw.reduce((a, x) => a + x, 0);
    out[g] = { ...o };
    keys.forEach((k, i) => { out[g][k] = rs > 0 ? (raw[i] * sum) / rs : o[k]; });
  }
  return out;
};

// The log (private, this server only): each search's time, words and profile, the block of the last link opened
// from it, and whether the next search was the same need. Words are kept 30 days, the per-profile counts for good.
const learnFile = () => `${DIR}/learn.json`;
let UNS = null;
const learnLoad = () => { if (!UNS) { try { UNS = JSON.parse(fs.readFileSync(learnFile(), "utf8")); } catch {} if (!UNS || !Array.isArray(UNS.log)) UNS = { log: [], stat: {} }; } return UNS; };
let _lsT = 0;
const learnSave = () => { clearTimeout(_lsT); _lsT = setTimeout(() => { try { fs.writeFileSync(`${learnFile()}.tmp`, JSON.stringify(UNS)); fs.renameSync(`${learnFile()}.tmp`, learnFile()); } catch {} }, 1000); if (_lsT.unref) _lsT.unref(); };
// "Within minutes" = shorter than the median gap between your searches (measured from the log; 5+ gaps needed)
export const learnWindow = (log) => { const g = []; for (let i = 1; i < log.length; i++) g.push(log[i].t - log[i - 1].t); return g.length >= 5 ? median(g) : null; };
const SAME_SYS = "Two searches by one person, a few minutes apart. Answer with one word: SAME if the second search " +
  "looks for the same thing as the first (the first didn't give it: reworded, narrowed, fixed), NEXT if it is a " +
  "different or follow-up question (the first was answered).";
export const sameParse = (t) => { const m = /\b(same|next)\b/i.exec(String(t || "")); return m ? m[1].toLowerCase() : null; };
const credit = (e) => { if (e && e.open && e.k && !e.done) { const st = (UNS.stat[e.k] ||= {}); st[e.open] = (st[e.open] || 0) + 1; e.done = 1; } };
// A new search: the one before it is judged (only inside the window, by ai-summary's model) and credited if solved
export const learnSearch = async (q, n, now = Date.now(), ask = aiAsk) => {
  const L = learnLoad(), k = needsKey(n);
  L.log = L.log.filter((e) => now - e.t < 30 * 86400000);
  const prev = L.log[L.log.length - 1];
  if (prev && prev.q.toLowerCase() === q.toLowerCase()) return; // the same page again (reload, endless scroll)
  const win = learnWindow(L.log), e = { t: now, q, k, open: "" };
  L.log.push(e);
  if (L.log.length > 2000) L.log.splice(0, L.log.length - 2000);
  if (prev && !prev.done) {
    if (win != null && now - prev.t < win) {
      const v = sameParse(await ask([{ role: "system", content: SAME_SYS }, { role: "user", content: `First: ${prev.q}\nSecond: ${q}` }], 5).catch(() => null));
      if (v === "same") prev.done = 1; // unsolved: what was opened from it gets no credit
      else if (v === "next") credit(prev);
    } else credit(prev);
  }
  learnSave();
};
// A link opened from a search's page: which block it sat in (the last one opened before the next search counts)
export const learnOpen = (q, kind) => {
  if (!LEARN_KINDS[kind]) return false;
  const L = learnLoad();
  for (let i = L.log.length - 1; i >= Math.max(0, L.log.length - 5); i--) if (L.log[i].q.toLowerCase() === q.toLowerCase()) { L.log[i].open = kind; learnSave(); return true; }
  return false;
};
const SHOW_LEARN = () => SHOW.learn !== false;
export const learnNudge = (n) => (n ? nudgeNeeds(n, learnLoad().stat[needsKey(n)]) : n);
export const _learnReset = (x) => { UNS = x || { log: [], stat: {} }; };
export const needsFor = async (q) => {
  q = String(q || "").trim().slice(0, 300);
  if (!q || q.startsWith("!")) return null;
  const k = q.toLowerCase();
  if (NEEDC.has(k)) return NEEDC.get(k);
  if (NEEDI.has(k)) return NEEDI.get(k);
  const run = (async () => {
    const docs = [], tasks = [];
    for (const [task, opts] of Object.values(NEEDS)) for (const d of Object.values(opts)) { docs.push(d); tasks.push(task); }
    const j = await vis("/rank", { q, docs, tasks }, 1500);
    const v = j && Array.isArray(j.s) && j.s.length === docs.length ? needsParse(j.s) : null;
    if (v) { v.ms = j.ms; NEEDC.set(k, v); if (NEEDC.size > 2000) NEEDC.delete(NEEDC.keys().next().value); }
    return v;
  })().finally(() => NEEDI.delete(k));
  NEEDI.set(k, run);
  return run;
};

