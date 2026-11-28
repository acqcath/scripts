// ----- server/07-typo.js: typo fixer and related searches (word list, trends, learned names, Bing) -----
// ===== Typo fixing and related searches, without Google =====
// Typo fixes are worked out on your PC: an English word list (82,765 words with how common each is) plus words
// learned from your own results (names like "Asura Scans" or "RTINGS"), so it keeps getting better the more you
// search. Bing's suggestions (Bing already gets your searches as an engine) add a second opinion and the related
// searches. Words you keep with "Search instead" are never changed again.
const WORDS = new Map();
let TOTAL = 0, PTOTAL = 0; // all word / word-pair counts added up: how common one is = its count / total
// How well two words go together compared with chance (above 0: English puts them side by side, like "open a";
// below 0: it avoids that, like "a sell", an article before a verb); null when there's no data on the pair
const fit = (a, b) => { const c = PAIRS.get(`${a} ${b}`), x = WORDS.get(a), y = WORDS.get(b); return c && x && y ? Math.log2((c / PTOTAL) / ((x / TOTAL) * (y / TOTAL))) : null; };
// Small grammar words ("a", "to", "of", "the"): searches often leave them out on purpose ("does openai sell data"),
// so a word only becomes one when it's that word with two letters swapped or one key off ("ot" -> "to"), never a dropped letter
const isFunc = (w) => TOTAL > 0 && (WORDS.get(w) || 0) / TOTAL >= 0.001;
const funcOk = (w, c) => !isFunc(c) || (w.length === c.length && slip(w, c));
// Names: words your results write with a capital mid-title ("AI", "PuTTY", "Asura") are never treated as typos
// ...and names from Wikipedia's article titles ("openai", "asura", "ai"), so it knows them without learning anything
const NAMES = new Set();
// Trending names: Wikipedia's 1,000 most-read articles of the last day count as known words, refreshed twice a day, so a
// name that is suddenly everywhere (a new person, show, game, product) is never "corrected" into a dictionary word.
// Only words are kept (trend.json: words + the time), no counts and nothing about your searches.
const TREND = new Set();
let trendAt = 0, trendLoaded = false;
const trendLoad = () => { if (trendLoaded) return; trendLoaded = true; try { const j = JSON.parse(fs.readFileSync(`${DIR}/trend.json`, "utf8")); for (const w of j.w || []) TREND.add(w); trendAt = Number(j.at) || 0; } catch {} };
export const trendWords = (titles) => {
  const out = new Set();
  for (const t of titles) {
    if (!t || /^(?:Main_Page|Special:|Wikipedia:|Portal:|Help:|File:|Category:|Template:|Talk:)/.test(t)) continue;
    for (const p of String(t).replace(/_\([^)]*\)$/, "").split(/[^\p{L}\p{N}]+/u)) { if (p.length >= 3 && !/^\d+$/.test(p) || (p.length === 2 && p === p.toUpperCase() && /\p{L}/u.test(p))) out.add(p.toLowerCase()); }
  }
  return [...out].slice(0, 6000);
};
const trendRefresh = async () => {
  trendLoad();
  if (Date.now() - trendAt < 20 * 3600000) return;
  for (const back of [1, 2, 3]) {
    const d = new Date(Date.now() - back * 86400000), pad = (n) => String(n).padStart(2, "0");
    const r = await net(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`, { timeout: 10000, accept: "application/json", headers: WD_UA });
    let titles = [];
    try { titles = JSON.parse(r.text).items[0].articles.map((a) => a.article); } catch {}
    const w = trendWords(titles);
    if (w.length >= 100) {
      TREND.clear(); for (const x of w) TREND.add(x); trendAt = Date.now();
      try { fs.writeFileSync(`${DIR}/trend.json.tmp`, JSON.stringify({ at: trendAt, w })); fs.renameSync(`${DIR}/trend.json.tmp`, `${DIR}/trend.json`); } catch {}
      return;
    }
  }
};
const trendSchedule = () => { trendLoad(); const run = () => trendRefresh().catch(() => {}); const a = setTimeout(run, 120000), b = setInterval(run, 12 * 3600000); if (a.unref) a.unref(); if (b.unref) b.unref(); };
const isName = (w) => NAMES.has(w) || TREND.has(w) || (learned.cap && learned.cap[w] || 0) >= 2;
// Settings > Clean Titles > "Typo fixer: learn words from my results" (off: nothing about your searches is stored or used)
let LEARN = false;
// Settings > Clean Titles: which of Sitelinks / Discussions / Videos / Top stories to show (all on unless turned off)
let SHOW = { learn: true, sl: true, forum: true, video: true, news: true, ans: true, kp: true, img: true, qv: true, arch: true, mean: true, stars: true, plain: true, pw: true };
const EMPTY = () => ({ w: {}, b: {}, keep: {}, fix: {}, cap: {} });
const readLearned = () => { try { learned = Object.assign(EMPTY(), JSON.parse(fs.readFileSync(`${DIR}/learned.json`, "utf8"))); } catch { learned = EMPTY(); } };
const PAIRS = new Map();
let learned = { w: {}, b: {}, keep: {}, fix: {} };
let loaded = false, dirty = false;
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const toks = (s) => norm(s).replace(/[^\p{L}\p{N}' ]+/gu, " ").split(" ").filter((w) => w.length > 1 && w.length < 25);
const save = () => {
  if (!dirty || !LEARN) return;
  dirty = false;
  try {
    for (const k of ["w", "b"]) {
      const e = Object.entries(learned[k]);
      if (e.length > 40000) learned[k] = Object.fromEntries(e.sort((x, y) => y[1] - x[1]).slice(0, 30000));
    }
    fs.writeFileSync(`${DIR}/learned.json.tmp`, JSON.stringify(learned));
    fs.renameSync(`${DIR}/learned.json.tmp`, `${DIR}/learned.json`);
  } catch {}
};
// Typo fixer data, fetched by the plugin itself the first time it's missing (spec: no one-time setup in the
// installer): SymSpell's English words and word pairs, then names from Wikipedia's article titles, made by
// names.js (shipped next to this file) in its own bun process so degoog never waits on it. Retried a day later
// if a download fails. Nothing about searches is sent anywhere.
const SYMSPELL = "https://raw.githubusercontent.com/wolfgarbe/SymSpell/master/SymSpell";
const DATA_FILES = [["words.txt", `${SYMSPELL}/frequency_dictionary_en_82_765.txt`, 50000], ["pairs.txt", `${SYMSPELL}/frequency_bigramdictionary_en_243_342.txt`, 200000]];
const hasFile = (f) => { try { return fs.statSync(`${DIR}/${f}`).size > 0; } catch { return false; } };
let _dataRun = null;
export const ensureData = (spawn = (cmd) => Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" })) => (_dataRun ||= (async () => {
  let got = false;
  for (const [f, url, minLines] of DATA_FILES) {
    if (hasFile(f)) continue;
    const r = await net(url, { timeout: 120000, max: 20_000_000, accept: "text/plain" });
    if (r.status === 200 && r.text.split("\n").length >= minLines) { try { fs.writeFileSync(`${DIR}/${f}.tmp`, r.text); fs.renameSync(`${DIR}/${f}.tmp`, `${DIR}/${f}`); got = true; } catch {} }
  }
  if (got) { loaded = false; WORDS.clear(); PAIRS.clear(); TOTAL = 0; PTOTAL = 0; } // read again on next use
  if (hasFile("words.txt") && !hasFile("names.txt") && hasFile("names.js")) { try { await spawn(["bun", `${DIR}/names.js`]).exited; loaded = false; NAMES.clear(); } catch {} }
  const ok = DATA_FILES.every(([f]) => hasFile(f));
  if (!ok) setTimeout(() => { _dataRun = null; }, 86400000).unref?.();
  return ok;
})());
const load = () => {
  if (loaded) return;
  loaded = true;
  try {
    for (const line of fs.readFileSync(`${DIR}/words.txt`, "utf8").split("\n")) {
      const [w, n] = line.replace(/^﻿/, "").trim().split(" ");
      if (w && n) { WORDS.set(w, Number(n)); TOTAL += Number(n); }
    }
  } catch {}
  try {
    for (const line of fs.readFileSync(`${DIR}/pairs.txt`, "utf8").split("\n")) {
      const p = line.replace(/^﻿/, "").trim().split(" ");
      if (p.length === 3) { PAIRS.set(`${p[0]} ${p[1]}`, Number(p[2])); PTOTAL += Number(p[2]); }
    }
  } catch {}
  if (LEARN) readLearned();
  // Wikipedia also has titles that are common misspellings ("Teh ...", "Tommorow ..."): a name that is a common word
  // with two letters swapped or a letter doubled/undoubled is treated as the typo it looks like, not a name
  const dbl = (w) => w.replace(/(.)\1+/g, "$1"), swaps = new Set(), dbls = new Set();
  for (const [w, n] of WORDS) if (n >= 1000000) { dbls.add(dbl(w)); for (let i = 0; i + 1 < w.length; i++) if (w[i] !== w[i + 1]) swaps.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2)); }
  try { for (const w of fs.readFileSync(`${DIR}/names.txt`, "utf8").split("\n")) if (w && !swaps.has(w) && !dbls.has(dbl(w))) NAMES.add(w); } catch {}
  const t = setInterval(save, 60000);
  if (t && t.unref) t.unref();
};
// Learn from a page of results: each word or word pair counts once per search
const learn = (titles) => {
  if (!LEARN) return;
  load();
  const ws = new Set(), bs = new Set(), caps = new Set();
  for (const t of titles.slice(0, 20)) {
    const k = toks(t);
    k.forEach((w, i) => { ws.add(w); if (i) bs.add(`${k[i - 1]} ${w}`); });
    // Capitalised after the first word (or all capitals, like "AI"): a name
    String(t).split(/[^\p{L}\p{N}'+.#-]+/u).filter(Boolean).forEach((x, i) => { if ((i > 0 && /^\p{Lu}/u.test(x)) || (x.length >= 2 && x === x.toUpperCase() && /\p{L}/u.test(x))) caps.add(x.toLowerCase()); });
  }
  if (!learned.cap) learned.cap = {};
  for (const w of caps) learned.cap[w] = (learned.cap[w] || 0) + 1;
  for (const w of ws) learned.w[w] = (learned.w[w] || 0) + 1;
  for (const b of bs) learned.b[b] = (learned.b[b] || 0) + 1;
  dirty = true;
};
const keep = (q) => { if (!LEARN) return; load(); for (const w of toks(q)) { learned.keep[w] = 1; delete learned.fix[w]; } dirty = true; };
// You tapped "Did you mean": that fix is used straight away next time (per word, so it carries to other searches)
const accept = (typed, fixed) => {
  if (!LEARN) return;
  load();
  const a = norm(typed).split(" "), b = norm(fixed).split(" ");
  for (let i = 0, j = 0; i < a.length && j < b.length; i++, j++) {
    if (a[i] === b[j]) continue;
    const two = b[j + 1] !== undefined && b.length - j > a.length - i ? `${b[j]} ${b[j + 1]}` : null;
    if (/\d/.test(a[i]) || a[i].length < 2) { if (two) j++; continue; }
    if (two && a[i + 1] === b[j + 2]) { learned.fix[a[i]] = two; j++; } else learned.fix[a[i]] = b[j];
    delete learned.keep[a[i]];
  }
  dirty = true;
};

const dist = (a, b) => {
  if (Math.abs(a.length - b.length) > 6) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
};

// Bing's suggestions for a search (cached a day)
const _sug = new Map();
// Bing answering with nothing at all (204, blocked, error) means it's down for this server: skip it for a while,
// backing off exponentially from 1 minute (1, 2, 4 … capped at 1 hour), reset by the first good answer (spec 15)
let bingDownUntil = 0, bingDowns = 0;
export const bingBackoff = (n) => Math.min(60000 * 2 ** Math.max(0, n - 1), 3600000);
const suggestions = async (q) => {
  const key = norm(q);
  if (!key) return [];
  const hit = _sug.get(key);
  if (hit && Date.now() - hit.t < 86400000) return hit.s;
  let s = [];
  // Bing first; DuckDuckGo's suggestions (same answer format) when Bing gives nothing
  const urls = [`https://api.bing.com/osjson.aspx?query=${encodeURIComponent(key)}`, `https://duckduckgo.com/ac/?q=${encodeURIComponent(key)}&type=list`];
  // degoog's own outgoing fetch first, then a plain one (the plain one is what reached Bing in testing)
  // Bing answers some browser names with an empty page, so a Chrome one goes first (it worked in testing)
  const UAS = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"];
  let bingBad = 0, bingTries = 0;
  got: for (const url of urls) for (const ua of UAS) for (const f of _fetch ? [_fetch, fetch] : [fetch]) {
    const isBing = url === urls[0];
    if (isBing && Date.now() < bingDownUntil) continue;
    if (isBing) bingTries++;
    try {
      const r = await f(url, {
        headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9", Accept: "application/json, text/javascript, */*" },
        signal: AbortSignal.timeout(1500),
      });
      if (isBing && (!r.ok || r.status === 204)) bingBad++;
      if (r.ok && r.status !== 204) { const j = JSON.parse(await r.text()); if (Array.isArray(j) && Array.isArray(j[1])) { if (isBing) bingDowns = 0; s = j[1].filter((x) => typeof x === "string"); if (s.length) break got; } }
    } catch { if (isBing) bingBad++; }
    if (isBing && bingTries && bingBad === bingTries && bingTries >= 2 && Date.now() >= bingDownUntil) bingDownUntil = Date.now() + bingBackoff(++bingDowns);
  }
  if (s.length) { if (_sug.size > 2000) _sug.clear(); _sug.set(key, { s, t: Date.now() }); }
  return s;
};

const skip = (qn) => qn.length < 3 || qn.length > 80 || /["!:\/\\@#]|https?|(^| )-\S|^[\d\s.,+\-*x^%()=]+$/.test(qn);

// Opinion 1: a Bing suggestion that is the same search with a few letters off (never words added or dropped)
const bingFix = (qn, sl) => {
  load();
  const qw = qn.split(" "), qs = qn.replace(/ /g, "");
  const lim = Math.min(3, Math.max(1, Math.round(qs.length / 5)));
  const close = (x, pool) => !/\d/.test(x) && pool.some((y) => dist(x, y) <= Math.max(1, Math.round(x.length / 3)));
  let best = null, bd = 99;
  for (const s of sl.slice(0, 6)) {
    const w = s.split(" ");
    for (const k of [qw.length - 1, qw.length, qw.length + 1]) {
      if (k < 1 || k > w.length) continue;
      const cw = w.slice(0, k), cand = cw.join(" "), cs = cand.replace(/ /g, "");
      if (cand === qn) continue;
      const joined = cs === qs;
      const qOnly = qw.filter((x) => !cw.includes(x)), cOnly = cw.filter((x) => !qw.includes(x));
      // Missing space plus a typo in that word ("asurascxns" -> "asura scans"): all other words must match exactly
      const split = cw.length === qw.length + 1 && qw.some((x, p) => !/\d/.test(x) && x.length >= 5 && cw.slice(0, p).join(" ") === qw.slice(0, p).join(" ") && cw.slice(p + 2).join(" ") === qw.slice(p + 1).join(" ") && dist(x, cw[p] + cw[p + 1]) <= Math.max(1, Math.floor(x.length / 4)));
      if (!joined && !split && (cw.length !== qw.length || !qOnly.every((x) => x.length >= 3 && close(x, cOnly)) || !cOnly.every((x) => close(x, qOnly)))) continue;
      // A suggestion that still has a misspelled word ("the weather tommorow in cairo") loses to a fully correct one
      const d0 = joined ? 0.5 : dist(qs, cs);
      const score = d0 + 2 * cw.filter((x) => !/\d/.test(x) && !WORDS.has(x) && (learned.w[x] || 0) < 2).length;
      if (d0 > 0 && d0 <= lim && score < bd) { bd = score; best = cand; }
    }
  }
  return best;
};

// Opinion 2: word by word on your PC. A word is left alone if it's a real word, one your results use, one in
// Bing's suggestions, or one you kept. Otherwise the most likely word 1-2 letters away wins, judged by how common
// it is, how often your results use it, and whether it fits the words around it ("asura scnas" -> "asura scans")
const ABC = "abcdefghijklmnopqrstuvwxyz'";
const edits = (w) => {
  const out = new Set();
  for (let i = 0; i <= w.length; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (b) out.add(a + b.slice(1));
    if (b.length > 1) out.add(a + b[1] + b[0] + b.slice(2));
    for (const c of ABC) { if (b) out.add(a + c + b.slice(1)); out.add(a + c + b); }
  }
  out.delete(w);
  return out;
};
// Is word b one plausible slip away from a: swapped letters, a missing or extra letter, a vowel mix-up, or a
// neighbouring key. "vitamix" -> "vitamin" (x and n are far apart) is not, so a name like that is never
// changed before searching
const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const keyAt = {};
ROWS.forEach((r, y) => [...r].forEach((ch, x) => { keyAt[ch] = [x + y * 0.5, y]; }));
const slip = (a, b) => {
  if (a.length !== b.length) return Math.abs(a.length - b.length) === 1;
  const d = [...a].map((ch, i) => i).filter((i) => a[i] !== b[i]);
  if (d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]]) return true;
  if (d.length !== 1) return false;
  const x = a[d[0]], y = b[d[0]];
  if (/[aeiouy]/.test(x) && /[aeiouy]/.test(y)) return true;
  const p = keyAt[x], q = keyAt[y];
  return !!(p && q && Math.abs(p[0] - q[0]) <= 1.5 && Math.abs(p[1] - q[1]) <= 1);
};
const localFix = (qn, extra) => {
  load();
  const known = (w) => WORDS.has(w) || NAMES.has(w) || TREND.has(w) || (learned.w[w] || 0) >= 2 || !!learned.keep[w] || extra.has(w);
  const mine = (w) => (learned.w[w] || 0) >= 2 || extra.has(w);
  const pop = (w) => Math.log10((WORDS.get(w) || 0) + 10) + 4 * Math.log2((learned.w[w] || 0) + 1) + (extra.has(w) ? 4 : 0);
  // How well two words go together: common English pairs ("how to") and pairs from your results ("asura scans")
  const pair = (a, b) => (a && b ? 0.6 * Math.log10((PAIRS.get(`${a} ${b}`) || 0) + 1) + 3 * Math.log2((learned.b[`${a} ${b}`] || 0) + 1) : 0);
  const t0 = Date.now();
  // Space typed inside a word ("best blen der" -> "best blender"), when the halves aren't both real words
  const words = [];
  for (const w of qn.split(" ")) {
    const prev = words[words.length - 1], j = prev + w;
    if (prev && !/\d/.test(j) && (WORDS.get(j) || 0) >= 100000 && !(WORDS.has(prev) && WORDS.has(w) && (PAIRS.get(`${prev} ${w}`) || 0) > 0)) words[words.length - 1] = j;
    else words.push(w);
  }
  const unknown = [];
  const out = [];
  const fixWord = (w, i) => {
    const prev = i ? out[i - 1] : "", next = words[i + 1] || "";
    if (/\d/.test(w) || /^\W+$/.test(w)) return w;
    if (learned.fix[w]) return learned.fix[w];
    if (isName(w)) return w;
    if (w.length < 3 || known(w)) {
      // Real word in the wrong place ("how ot make", "the wether tomorrow"): a word 1 letter away that fits
      // its neighbours 300x better goes to the page check (never changed before searching)
      if ((WORDS.has(w) || w.length < 3) && (prev || next)) {
        const ctx = (x) => (prev ? Math.log10((PAIRS.get(`${prev} ${x}`) || 0) + 1) : 0) + (next ? Math.log10((PAIRS.get(`${x} ${next}`) || 0) + 1) : 0);
        let bc = null, bs = ctx(w) + 2.5;
        // ...and it must read as English on BOTH sides: no neighbour English avoids putting next to it ("open a sell")
        const fits = (c) => [prev && fit(prev, c), next && fit(c, next)].every((f) => f === null || f === "" || f >= 0);
        for (const c of edits(w)) if ((WORDS.get(c) || 0) >= (WORDS.get(w) || 0) && funcOk(w, c) && fits(c)) { const v = ctx(c); if (v > bs) { bs = v; bc = c; } }
        if (bc) unknown.push({ w, c: [bc] });
        // Real word that is one slip from a far more common one ("bets blender" -> "best blender"): the page
        // switches only if the results never use the typed word but keep using the common one
        else if (w.length >= 4 && !mine(w) && !learned.keep[w]) {
          const f = WORDS.get(w) || 0;
          const c = [...edits(w)].filter((x) => (WORDS.get(x) || 0) >= 20 * f && slip(w, x)).sort((x, y) => WORDS.get(y) - WORDS.get(x)).slice(0, 3);
          if (c.length) unknown.push({ w, c });
        }
      }
      // Short unknown word ("pro mx" -> "pro max"): the page picks whichever close word the results use
      if (w.length < 3 && !WORDS.has(w) && !unknown.some((u) => u.w === w)) {
        const c = [...edits(w)].filter((x) => WORDS.has(x) && funcOk(w, x)).sort((x, y) => WORDS.get(y) - WORDS.get(x)).slice(0, 8);
        if (c.length) unknown.push({ w, c });
      }
      return w;
    }
    const scored = new Map();
    const consider = (c, bonus, tier) => {
      const parts = c.split(" ");
      const s = Math.min(...parts.map(pop)) + pair(prev, parts[0]) + pair(parts[parts.length - 1], next) + (parts.length > 1 ? pair(parts[0], parts[1]) : 0) + bonus;
      const old = scored.get(c);
      if (!old || old.s < s) scored.set(c, { s, tier: Math.min(tier, old ? old.tier : 9) });
    };
    const e1 = [...edits(w)];
    for (const c of e1) if (known(c)) consider(c, 0, 1);
    // Two letters off ("definatly" -> "definitely", "restraunt" -> "restaurant"): a bit less likely than one
    if (w.length >= 5) for (const e of e1) { if (Date.now() - t0 > 250) break; for (const c of edits(e)) if (c !== w && known(c)) consider(c, -1.5, 2); }
    // Stuck keys ("bllendderr" -> "blender")
    const once = w.replace(/(.)\1+/g, "$1");
    if (once !== w && once.length >= 3) { if (known(once)) consider(once, -0.5, 1); for (const c of edits(once)) if (known(c)) consider(c, -1, 2); }
    // Missing space: "asurascans" -> "asura scans"
    for (let k = 2; k <= w.length - 2; k++) {
      const a = w.slice(0, k), b = w.slice(k);
      if (known(a) && known(b) && (a.length > 2 || WORDS.has(a)) && (b.length > 2 || WORDS.has(b))) consider(`${a} ${b}`, pair(a, b) > 0 ? 2 : -1.5, 1);
      // ...plus a typo in one half ("asurascxns" -> "asura scans")
      else if (w.length >= 7 && a.length >= 3 && b.length >= 3) {
        if (known(a)) { for (const c of edits(b)) if (known(c) && c.length > 2) consider(`${a} ${c}`, pair(a, c) > 0 ? 1 : -1.5, 2); }
        else if (known(b)) { for (const c of edits(a)) if (known(c) && c.length > 2) consider(`${c} ${b}`, pair(c, b) > 0 ? 1 : -1.5, 2); }
      }
    }
    if (!scored.size) { unknown.push({ w, c: soundAlike(w) }); return w; }
    const r = [...scored].sort((x, y) => y[1].s - x[1].s);
    const c = r.map((x) => x[0]).slice(0, 6);
    // Sure when the closest spelling clearly wins (10x more likely than any other equally close one, and not
    // beaten by a further one) and is a common word or one from your results
    const near1 = Math.min(...r.map((x) => x[1].tier));
    const tierR = r.filter((x) => x[1].tier === near1);
    const top = tierR[0][0].split(" ");
    const beaten = r.some((x) => x[1].tier > near1 && !x[0].includes(" ") && x[1].s > tierR[0][1].s - 1);
    // Long words are only fixed early to a very common word ("restraunt" could be "restaurant", so it waits)
    const common = top.length > 1 || (WORDS.get(top[0]) || 0) >= (w.length >= 8 ? 5000000 : 0);
    const typoLike = top.every(mine) || (common && (near1 > 1 ? w.length >= 8 && (WORDS.get(top[0]) || 0) >= 1000000 : top.length > 1 || slip(w, tierR[0][0])));
    const sure = typoLike && !beaten && r[0][0] === tierR[0][0] && (tierR.length === 1 || tierR[0][1].s - tierR[1][1].s >= 1) && top.every((x) => mine(x) || (WORDS.get(x) || 0) >= 100000) && (w.length >= 4 || tierR.length === 1 || tierR[0][1].s - tierR[1][1].s >= 1.5);
    if (sure) return c[0];
    unknown.push({ w, c });
    return w;
  };
  words.forEach((w, i) => out.push(fixWord(w, i)));
  // Sure words are fixed before searching. Unsure ones go to the page, which checks the results first and
  // only switches if they clearly use one of the candidates
  const fix = out.join(" ");
  // How common each candidate is in everyday English, so the page can tell "the results keep using it" from
  // "every text uses it" ("a", "the" are in any page, so seeing them proves nothing)
  const share = (x) => (TOTAL ? Math.min(...x.split(" ").map((y) => (WORDS.get(y) || 0) / TOTAL)) : 0);
  return { fix: fix !== qn ? fix : null, words: unknown.map((u) => ({ ...u, p: Object.fromEntries(u.c.map((x) => [x, share(x)])) })) };
};

// Sound-alike spellings ("chimminy" -> "chimney"): same consonant sounds, close in letters. Only offered
// through the page check (Did you mean), never changed before searching
const sk = (w) => {
  const s = w.toLowerCase().replace(/[^a-z]/g, "").replace(/^(kn|gn|pn|wr)/, (m) => m[1]).replace(/x/g, "ks").replace(/ph/g, "f").replace(/ck|q/g, "k").replace(/c(?=[eiy])/g, "s").replace(/ch|sh/g, "x").replace(/c/g, "k").replace(/dg|j/g, "g").replace(/gh/g, "").replace(/z/g, "s").replace(/th/g, "0").replace(/v/g, "f");
  return s ? s[0] + s.slice(1).replace(/[aeiouyhw]/g, "").replace(/(.)\1+/g, "$1") : "";
};
let SOUND = null;
const soundAlike = (w) => {
  if (w.length < 4) return [];
  if (!SOUND) {
    SOUND = new Map();
    for (const [x, n] of WORDS) if (n >= 20000 && x.length >= 3) { const k = sk(x); if (!SOUND.has(k)) SOUND.set(k, []); SOUND.get(k).push(x); }
  }
  return (SOUND.get(sk(w)) || []).filter((x) => dist(w, x) <= Math.max(3, Math.ceil(w.length / 2))).sort((a, b) => WORDS.get(b) - WORDS.get(a)).slice(0, 6);
};
// People also ask: question-style Bing suggestions for the search ("how ...", "what ...", "is ...")
const QW = /^(what|how|why|is|are|can|does|do|did|when|where|who|which|should|will|was)\b/;
// Search-box phrasing that isn't a real question ("what putty is used for", "how putty works"): skipped
const WH2 = /^(what|how|why|when|where|who|which) (?!(is|are|was|were|do|does|did|can|could|should|would|will|to|much|many|long|old|far|often|big|tall|fast|kind|type|types|size|happens|happened|causes|caused|makes|made|time|year|day|age|percent|color|colour|country|state|city|language|team|songs?|movies?|episode|season|i|you|we|they|he|she|it|my|your|a|an)\b)/;
const broken = (s) => WH2.test(s);
const questions = async (q) => {
  const qn = norm(q);
  const want = toks(qn).filter((w) => w.length >= 3);
  const lists = await Promise.all(["", "what ", "what is ", "what does ", "how ", "how to ", "how do ", "why ", "who is ", "when ", "is ", "can "].map((p) => suggestions(p + qn)));
  const out = [], seen = new Set();
  // Take turns between question forms (what, how, why, who, is...) so the list is varied like Google's
  const mixed = [];
  for (let i = 0; i < 8; i++) for (const l of lists) if (l[i]) mixed.push(l[i]);
  for (const s of mixed.map(norm)) {
    if (!QW.test(s) || seen.has(s) || s.split(" ").length < 3 || s === qn || broken(s)) continue;
    if (want.length && !want.some((w) => s.includes(w))) continue;
    // Same question in other words ("why are the steelers called that" / "why are they called steelers"): keep one
    const sw = new Set(s.split(" "));
    if (out.some((o) => { const ow = o.toLowerCase().replace(/\?$/, "").split(" "); return ow.filter((w) => sw.has(w)).length >= 0.7 * Math.max(ow.length, sw.size); })) continue;
    seen.add(s);
    out.push(s[0].toUpperCase() + s.slice(1) + (s.endsWith("?") ? "" : "?"));
    if (out.length >= 4) break;
  }
  return out;
};

// The fix for a search, or null. Both opinions agree on what's a real search: if Bing has suggestions that
// start with it, it's left alone
const _fix = new Map();
// The page now asks /fix at page load, while the search's own interceptor is working out the same fix: both share
// one run (one set of Bing suggestion requests), not two
const _fixRun = new Map();
const check = (q) => {
  const qn = norm(q);
  if (_fixRun.has(qn)) return _fixRun.get(qn);
  const p = check0(q).finally(() => _fixRun.delete(qn));
  _fixRun.set(qn, p);
  return p;
};
const check0 = async (q) => {
  const qn = norm(q);
  if (skip(qn)) return { fix: null, words: [] };
  if (_fix.has(qn)) return _fix.get(qn);
  const sl = (await suggestions(qn)).map(norm).filter(Boolean);
  let r = { fix: null, words: [] };
  if (!sl.some((s) => s.startsWith(qn))) {
    let b = bingFix(qn, sl);
    // Second look: Bing's suggestions for the fixed search often finish the job ("the weather tommorow" -> "the weather tomorrow")
    if (b && b.split(" ").some((x) => !/\d/.test(x) && !WORDS.has(x) && (learned.w[x] || 0) < 2)) { const b2 = bingFix(b, (await suggestions(b)).map(norm).filter(Boolean)); if (b2) b = b2; }
    if (b) r = { fix: b, words: [], via: "bing-suggest" };
    else { r = localFix(qn, new Set(sl.flatMap((s) => s.split(" ")))); r.via = "local"; }
  }
  // Sure enough to change the search only for clear slips. A short word changed by an added or missing letter
  // ("mx" -> "max") or a key-mash ("dfsdf") could be meant, so it's searched as typed with "Did you mean" instead
  if (r.fix && r.fix !== qn) {
    const qw = qn.split(" "), bw = r.fix.split(" ");
    const mash = (x) => x.length >= 4 && !/[aeiouy]/.test(x) && !WORDS.has(x) && !isName(x);
    const unsure = qw.length === bw.length && qw.some((x, i) => x !== bw[i] && !/\d/.test(x) && (mash(x) || (x.length <= 5 && (x.length !== bw[i].length || !slip(x, bw[i])))));
    if (unsure) r = { fix: null, words: r.words || [], dym: r.fix, via: r.via };
  }
  if (r.fix === qn) r.fix = null;
  // Only kept when Bing answered, so a slow moment never sticks
  if (sl.length) { if (_fix.size > 2000) _fix.clear(); _fix.set(qn, r); }
  return r;
};
const fixFor = async (q) => (await check(q)).fix;

export const interceptor = {
  name: "Clean Titles typo fixer",
  description: "Fixes typos before searching, like Google's 'Showing results for', and learns from your results.",
  init(ctx) {
    if (ctx && typeof ctx.fetch === "function" && !_fetch) _fetch = ctx.fetch;
    if (ctx && ctx.dir) DIR = ctx.dir;
    load();
  },
  async intercept(query, context) {
    if (!_fetch && context && typeof context.fetch === "function") _fetch = context.fetch;
    try { return { query: (await fixFor(query)) || query }; } catch { return { query }; }
  },
};

