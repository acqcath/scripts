// ----- server/11-rank.js: answer shape + contested check (aiAsk), the results hook __ctResults (reranker scores, featured snippet) -----
// ===== M4: the answer card's shape and the contested check, both written by ai-summary's model (aiAsk) =====
// The needs call picks the shape (s: steps / compare / timeline / chart / plain); /shape asks the model to answer
// in that shape from the top results only (JSON, checked here); /sides asks whether credible results disagree.
const SHAPE_SYS = {
  steps: 'Answer with the steps to do it, in order, each one short imperative sentence, at most 8. JSON only: {"steps": ["...", "..."], "src": [result numbers used]}',
  compare: 'Answer with a comparison table of the options the search names (2 to 4 columns), at most 6 rows of aspects, each cell a few words. JSON only: {"cols": ["Option A", "Option B"], "rows": [["aspect", "A value", "B value"]], "src": [result numbers used]}',
  timeline: 'Answer with the key dates and events in time order, at most 8, each event a few words. JSON only: {"events": [["date", "event"]], "src": [result numbers used]}',
  chart: 'Answer with the numbers asked about as a bar chart, at most 8 bars, all in one unit. JSON only: {"unit": "unit", "bars": [["label", number]], "src": [result numbers used]}',
};
const SHAPE_HEAD = "You answer a web search using ONLY the numbered search results given. Never add facts they don't state. If they don't contain what the shape needs, reply {}. ";
const cell = (x, n = 80) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, n);
export const shapeParse = (k, txt, nres) => {
  const m = /\{[\s\S]*\}/.exec(String(txt || ""));
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const src = (Array.isArray(j.src) ? j.src : []).map((i) => Math.round(+i) - 1).filter((i) => i >= 0 && i < nres).slice(0, 4);
  if (k === "steps") { const a = (Array.isArray(j.steps) ? j.steps : []).map((x) => cell(x, 160)).filter(Boolean).slice(0, 8); return a.length >= 2 ? { k, steps: a, src } : null; }
  if (k === "compare") {
    const cols = (Array.isArray(j.cols) ? j.cols : []).map((x) => cell(x, 40)).filter(Boolean).slice(0, 4);
    const rows = (Array.isArray(j.rows) ? j.rows : []).filter((r) => Array.isArray(r) && r.length === cols.length + 1).map((r) => r.map((x) => cell(x))).slice(0, 6);
    return cols.length >= 2 && rows.length >= 2 ? { k, cols, rows, src } : null;
  }
  if (k === "timeline") { const e = (Array.isArray(j.events) ? j.events : []).filter((r) => Array.isArray(r) && r.length >= 2).map((r) => [cell(r[0], 30), cell(r[1], 120)]).filter((r) => r[0] && r[1]).slice(0, 8); return e.length >= 2 ? { k, events: e, src } : null; }
  if (k === "chart") { const b = (Array.isArray(j.bars) ? j.bars : []).filter((r) => Array.isArray(r) && r.length >= 2 && Number.isFinite(+r[1]) && +r[1] >= 0).map((r) => [cell(r[0], 40), +r[1]]).filter((r) => r[0]).slice(0, 8); return b.length >= 2 && b.some((r) => r[1] > 0) ? { k, unit: cell(j.unit, 20), bars: b, src } : null; }
  return null;
};
const SIDES_SYS = "You check whether credible sources disagree about the answer to a search question. Use ONLY the numbered search results given. " +
  "Say split only when at least one credible result (an expert, official, scientific or established news source) on EACH side clearly states a conflicting answer; " +
  "different emphasis, extra detail or one fringe page is not a split. JSON only: {\"split\": false} or " +
  '{"split": true, "a": {"claim": "one short sentence", "src": [result numbers]}, "b": {"claim": "one short sentence", "src": [result numbers]}}';
export const sidesParse = (txt, nres) => {
  const m = /\{[\s\S]*\}/.exec(String(txt || ""));
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  if (j.split !== true) return { split: false };
  const side = (x) => { const src = [...new Set((x && Array.isArray(x.src) ? x.src : []).map((i) => Math.round(+i) - 1).filter((i) => i >= 0 && i < nres))].slice(0, 3); const claim = cell(x && x.claim, 200); return claim && src.length ? { claim, src } : null; };
  const a = side(j.a), b = side(j.b);
  return a && b && !a.src.some((i) => b.src.includes(i)) ? { split: true, a, b } : { split: false };
};
const resText = (rs) => rs.map((r, i) => `${i + 1}. ${cell(r.t, 200)} (${(() => { try { return new URL(r.u).hostname.replace(/^www\./, ""); } catch { return ""; } })()}): ${cell(r.s, 400)}`).join("\n");
const resIn = (b) => (Array.isArray(b.r) ? b.r : []).slice(0, 8).map((r) => ({ t: String((r && r.t) || ""), s: String((r && r.s) || ""), u: /^https?:\/\//.test(String((r && r.u) || "")) ? String(r.u) : "" })).filter((r) => r.t && r.u);
const SHC = new Map();
const cached = (k, run) => { if (SHC.has(k)) return SHC.get(k); const p = run().then((v) => { if (v === undefined) SHC.delete(k); return v; }); SHC.set(k, p); if (SHC.size > 500) SHC.delete(SHC.keys().next().value); return p; };
export const shapeFor = (q, k, rs) => (!SHAPE_SYS[k] || rs.length < 2 ? Promise.resolve(null) : cached(`s|${k}|${q.toLowerCase()}|${rs.map((r) => r.u).join("|")}`, async () => {
  const t = await aiAsk([{ role: "system", content: SHAPE_HEAD + SHAPE_SYS[k] }, { role: "user", content: `Search: ${q}\n\nResults:\n${resText(rs)}` }], 700);
  return t == null ? undefined : shapeParse(k, t, rs.length); // no model answer: not cached
}));
export const sidesFor = (q, rs) => (rs.length < 2 ? Promise.resolve(null) : cached(`b|${q.toLowerCase()}|${rs.map((r) => r.u).join("|")}`, async () => {
  const t = await aiAsk([{ role: "system", content: SIDES_SYS }, { role: "user", content: `Search: ${q}\n\nResults:\n${resText(rs)}` }], 400);
  return t == null ? undefined : sidesParse(t, rs.length);
}));

// A slow answer is never thrown away: the rank call keeps running past the wait below and fills AIC when it lands, so
// the very next request for the same results (a tab switch, a reload) already has it. Same request twice at once
// shares one run (INFL).
const INFL = new Map();
const RANK_WAIT_MS = 1600, RANK_RUN_MS = 6000;
// Search time (measured): the last 50 reranker run times and the time this hook added to each search. When the
// reranker's median run is over the wait, waiting is wasted (it'd time out anyway): the search goes on at once and
// the scores are kept for the next request.
const SPEED = { rank: [], hook: [], gpu: [], queue: [] };
const speedAdd = (a, ms) => { a.push(ms); if (a.length > 50) a.shift(); };
export const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
export const rankWait = (runs) => { const m = median(runs); return m != null && runs.length >= 5 && m > RANK_WAIT_MS ? 0 : RANK_WAIT_MS; };
globalThis.__ctResults = async (result, query, params) => {
  const t0 = Date.now();
  try { await ctResults(result, query, params); } finally { speedAdd(SPEED.hook, Date.now() - t0); }
};
const ctResults = async (result, query, params) => {
  const type = String((params && params.type) || "web");
  if (!result || !Array.isArray(result.results) || !query || type === "videos") return;
  const q = String(query).trim().slice(0, 300);
  const rs = result.results.slice(0, 60);
  if (!rs.length || q.startsWith("!")) return;
  // Publisher names and the reranker run side by side (they used to add up)
  const doi = doiNames(result.results).then((n) => { if (n) result.ctPub = 1; }, () => {});
  try { await rankPart(result, q, rs, type); } finally { await doi; }
};
const rankPart = async (result, q, rs, type) => {
  const key = `${type}|${q}|${rs.map((r) => r.url).join("|")}`;
  let got = AIC.get(key);
  if (!got) {
    let run = INFL.get(key);
    if (!run) {
      const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
      const docs = rs.map((r) => (type === "images" ? `${stripT(r.title)}. Picture from ${host(r.url)}` : `${stripT(r.title)}. ${stripT(r.snippet)}`).slice(0, 1200));
      const sents = [];
      if (type === "web" && (QLIKE.test(q) || q.split(/\s+/).length >= 2)) rs.slice(0, 6).forEach((r, i) => sentences(r.snippet).slice(0, 4).forEach((x) => sents.push([i, x])));
      run = (async () => {
        const r0 = Date.now();
        const j = await vis("/rank", { q, docs: docs.concat(sents.map(([, x]) => x)) }, RANK_RUN_MS);
        if (j) { speedAdd(SPEED.rank, Date.now() - r0); if (typeof j.gpu === "number") { speedAdd(SPEED.gpu, j.gpu); speedAdd(SPEED.queue, j.wait); } }
        if (!j || !Array.isArray(j.s)) return null;
        const g = { rel: j.s.slice(0, docs.length), best: {} };
        sents.forEach(([i, x], k) => { const v = j.s[docs.length + k]; if (typeof v === "number" && (!g.best[i] || v > g.best[i].p)) g.best[i] = { s: x, p: v }; });
        AIC.set(key, g);
        if (AIC.size > 500) AIC.delete(AIC.keys().next().value);
        return g;
      })().finally(() => INFL.delete(key));
      INFL.set(key, run);
    }
    const wait = rankWait(SPEED.rank);
    got = !wait ? null : await Promise.race([run, new Promise((r) => { const t = setTimeout(() => r(null), wait); if (t.unref) t.unref(); })]);
    if (!got) return;
  }
  rs.forEach((r, i) => { if (typeof got.rel[i] === "number") r.ctRel = got.rel[i]; if (got.best[i]) r.ctBest = got.best[i]; });
  result.ctAi = 1;
};

