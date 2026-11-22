& {
$t = "$env:TEMP\ct-new"; New-Item -ItemType Directory -Force $t | Out-Null
[IO.File]::WriteAllText("$t\index.js", @'
import * as fs from "node:fs";

const INFO_HTML =
  `<div class="command-result"><p>Tidies result titles and loads sharper news/video thumbnails on every search page.</p></div>`;

let _sign = null;
let _fetch = null;

// Brave's image proxy (imgs.search.brave.com/<sig>/<options>/<base64 of original URL>) only
// sends 200x200 thumbnails. The original picture's address is inside it, so decode that.
const braveOriginal = (u) => {
  const segs = u.pathname.split("/").filter(Boolean);
  let last = -1;
  segs.forEach((s, i) => { if (i > 0 && s.includes(":")) last = i; });
  if (last < 1 || last >= segs.length - 1) return null;
  const rest = segs.slice(last + 1);
  let out = "";
  try {
    if (rest[0] === "plain") {
      out = decodeURIComponent(rest.slice(1).join("/")).replace(/@\w+$/, "");
    } else {
      const b64 = rest.join("").replace(/\.\w+$/, "").replace(/-/g, "+").replace(/_/g, "/");
      out = Buffer.from(b64, "base64").toString("utf8");
    }
  } catch { return null; }
  out = out.replace(/&amp;/g, "&").trim();
  return /^https?:\/\/[^\s]+$/i.test(out) ? out : null;
};

// Only these image hosts get upgraded, so this can never act as an open proxy
const upgrade = (raw, W) => {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase();
  // Bing's thumbnail service, on every host it uses (Bing News sends www.bing.com/th?id=...&w=234&h=132)
  if ((host === "th.bing.com" || host === "www.bing.com" || host === "bing.com" || /^tse\d*\.mm\.bing\.net$/.test(host)) && u.pathname.startsWith("/th")) {
    const w = parseInt(u.searchParams.get("w") || "0", 10);
    const h = parseInt(u.searchParams.get("h") || "0", 10);
    if (w && w >= W) return null;
    u.searchParams.set("w", String(W));
    if (w && h) u.searchParams.set("h", String(Math.round((W * h) / w)));
    else u.searchParams.delete("h");
    u.searchParams.set("qlt", "90");
    return u.toString();
  }
  const m = /^\/vi(_webp)?\/([\w-]{6,})\/(default|mqdefault|hqdefault|sddefault)\.(jpg|webp)$/.exec(u.pathname);
  if (/(^|\.)ytimg\.com$/.test(host) && m) {
    return `https://i.ytimg.com/vi/${m[2]}/hq720.jpg`;
  }
  if (host === "imgs.search.brave.com") return braveOriginal(u);
  return null;
};

// YouTube search often gives no description for a video. The video's own page has it, so fetch that
// (from this server, so the visitor's IP never reaches YouTube) and keep each answer for a day.
const _desc = new Map();
const ytText = (html) => {
  let m = /"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(html);
  let s = "";
  if (m) { try { s = JSON.parse(`"${m[1]}"`); } catch {} }
  if (!s) {
    m = /<meta\s+(?:name|property)="(?:og:)?description"\s+content="([^"]*)"/i.exec(html);
    if (m) s = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  // Drop link/affiliate lines ("AirPods Pro: $179 https://...") and keep the real text
  s = s.split("\n").filter((l) => !/https?:\/\/|www\./i.test(l)).join(" ").trim() || s;
  s = s.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return s.length > 320 ? `${s.slice(0, 317).trim()}…` : s;
};
const ytDesc = async (id) => {
  const hit = _desc.get(id);
  if (hit && Date.now() - hit.t < 86400000) return hit.s;
  const f = _fetch || fetch;
  let s = "";
  try {
    const r = await f(`https://www.youtube.com/watch?v=${id}&hl=en`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "CONSENT=YES+1; SOCS=CAI",
      },
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) {
      // Stop downloading as soon as the description has arrived (the rest of the ~1 MB page is not needed)
      let html = "";
      const rd = r.body && r.body.getReader ? r.body.getReader() : null;
      if (!rd) html = await r.text();
      else {
        const dec = new TextDecoder();
        let at = -1;
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          html += dec.decode(value, { stream: true });
          if (at < 0) at = html.indexOf('"shortDescription":"');
          if (at >= 0 && /^"shortDescription":"(?:[^"\\]|\\.)*"/.test(html.slice(at))) { rd.cancel().catch(() => {}); break; }
        }
      }
      s = ytText(html);
    }
  } catch {}
  if (_desc.size > 1000) _desc.clear();
  _desc.set(id, { s, t: Date.now() });
  return s;
};

// ===== Typo fixing and related searches, without Google =====
// Typo fixes are worked out on your PC: an English word list (82,765 words with how common each is) plus words
// learned from your own results (names like "Asura Scans" or "RTINGS"), so it keeps getting better the more you
// search. Bing's suggestions (Bing already gets your searches as an engine) add a second opinion and the related
// searches. Words you keep with "Search instead" are never changed again.
let DIR = "/app/data/plugins/clean-titles";
const WORDS = new Map();
const PAIRS = new Map();
let learned = { w: {}, b: {}, keep: {}, fix: {} };
let loaded = false, dirty = false;
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const toks = (s) => norm(s).replace(/[^\p{L}\p{N}' ]+/gu, " ").split(" ").filter((w) => w.length > 1 && w.length < 25);
const save = () => {
  if (!dirty) return;
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
const load = () => {
  if (loaded) return;
  loaded = true;
  try {
    for (const line of fs.readFileSync(`${DIR}/words.txt`, "utf8").split("\n")) {
      const [w, n] = line.replace(/^﻿/, "").trim().split(" ");
      if (w && n) WORDS.set(w, Number(n));
    }
  } catch {}
  try {
    for (const line of fs.readFileSync(`${DIR}/pairs.txt`, "utf8").split("\n")) {
      const p = line.replace(/^﻿/, "").trim().split(" ");
      if (p.length === 3) PAIRS.set(`${p[0]} ${p[1]}`, Number(p[2]));
    }
  } catch {}
  try { learned = Object.assign({ w: {}, b: {}, keep: {}, fix: {} }, JSON.parse(fs.readFileSync(`${DIR}/learned.json`, "utf8"))); } catch {}
  const t = setInterval(save, 60000);
  if (t && t.unref) t.unref();
};
// Learn from a page of results: each word or word pair counts once per search
const learn = (titles) => {
  load();
  const ws = new Set(), bs = new Set();
  for (const t of titles.slice(0, 20)) {
    const k = toks(t);
    k.forEach((w, i) => { ws.add(w); if (i) bs.add(`${k[i - 1]} ${w}`); });
  }
  for (const w of ws) learned.w[w] = (learned.w[w] || 0) + 1;
  for (const b of bs) learned.b[b] = (learned.b[b] || 0) + 1;
  dirty = true;
};
const keep = (q) => { load(); for (const w of toks(q)) { learned.keep[w] = 1; delete learned.fix[w]; } dirty = true; };
// You tapped "Did you mean": that fix is used straight away next time (per word, so it carries to other searches)
const accept = (typed, fixed) => {
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
const suggestions = async (q) => {
  const key = norm(q);
  if (!key) return [];
  const hit = _sug.get(key);
  if (hit && Date.now() - hit.t < 86400000) return hit.s;
  let s = [];
  const url = `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(key)}`;
  // degoog's own outgoing fetch first, then a plain one (the plain one is what reached Bing in testing)
  // Bing answers some browser names with an empty page, so a Chrome one goes first (it worked in testing)
  const UAS = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"];
  got: for (const ua of UAS) for (const f of _fetch ? [_fetch, fetch] : [fetch]) {
    try {
      const r = await f(url, {
        headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9", Accept: "application/json, text/javascript, */*" },
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) { const j = JSON.parse(await r.text()); if (Array.isArray(j) && Array.isArray(j[1])) { s = j[1].filter((x) => typeof x === "string"); break got; } }
    } catch {}
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
  const known = (w) => WORDS.has(w) || (learned.w[w] || 0) >= 2 || !!learned.keep[w] || extra.has(w);
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
    if (w.length < 3 || known(w)) {
      // Real word in the wrong place ("how ot make", "the wether tomorrow"): a word 1 letter away that fits
      // its neighbours 300x better goes to the page check (never changed before searching)
      if ((WORDS.has(w) || w.length < 3) && (prev || next)) {
        const ctx = (x) => (prev ? Math.log10((PAIRS.get(`${prev} ${x}`) || 0) + 1) : 0) + (next ? Math.log10((PAIRS.get(`${x} ${next}`) || 0) + 1) : 0);
        let bc = null, bs = ctx(w) + 2.5;
        for (const c of edits(w)) if ((WORDS.get(c) || 0) >= (WORDS.get(w) || 0)) { const v = ctx(c); if (v > bs) { bs = v; bc = c; } }
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
        const c = [...edits(w)].filter((x) => WORDS.has(x)).sort((x, y) => WORDS.get(y) - WORDS.get(x)).slice(0, 8);
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
  return { fix: fix !== qn ? fix : null, words: unknown };
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
const questions = async (q) => {
  const qn = norm(q);
  const want = toks(qn).filter((w) => w.length >= 3);
  const lists = await Promise.all(["", "what ", "what is ", "what does ", "how ", "how to ", "how do ", "why ", "who is ", "when ", "is ", "can "].map((p) => suggestions(p + qn)));
  const out = [], seen = new Set();
  // Take turns between question forms (what, how, why, who, is...) so the list is varied like Google's
  const mixed = [];
  for (let i = 0; i < 8; i++) for (const l of lists) if (l[i]) mixed.push(l[i]);
  for (const s of mixed.map(norm)) {
    if (!QW.test(s) || seen.has(s) || s.split(" ").length < 3 || s === qn) continue;
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
const check = async (q) => {
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

export const routes = [
  {
    method: "get",
    path: "/fix",
    async handler(req) {
      const u = new URL(req.url);
      const q = (u.searchParams.get("q") || "").slice(0, 200);
      if (u.searchParams.get("keep")) { keep(q); _fix.clear(); }
      if (u.searchParams.get("acc")) { accept(u.searchParams.get("acc").slice(0, 200), q); _fix.clear(); }
      const { fix, words, dym, via } = await check(q);
      const seen = new Set([norm(q), norm(fix || q)]);
      const related = (await suggestions(fix || q)).map(norm).filter((s) => s && !seen.has(s) && seen.add(s)).slice(0, 8);
      return new Response(JSON.stringify({ fix, words, dym, via, related }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  },
  {
    method: "get",
    path: "/qs",
    async handler(req) {
      const q = (new URL(req.url).searchParams.get("q") || "").slice(0, 200);
      let qs = [];
      try { if (!skip(norm(q))) qs = await questions(q); } catch {}
      return new Response(JSON.stringify({ q: qs }), { headers: { "Content-Type": "application/json", "Cache-Control": qs.length ? "private, max-age=3600" : "no-store" } });
    },
  },
  {
    method: "post",
    path: "/learn",
    async handler(req) {
      try {
        const j = await req.json();
        if (Array.isArray(j.t)) learn(j.t.filter((x) => typeof x === "string").map((x) => x.slice(0, 300)));
      } catch {}
      return new Response(null, { status: 204 });
    },
  },
  {
    method: "get",
    path: "/ytdesc",
    async handler(req) {
      const id = new URL(req.url).searchParams.get("v") || "";
      if (!/^[\w-]{11}$/.test(id)) return new Response("bad id", { status: 400 });
      const d = await ytDesc(id);
      return new Response(JSON.stringify({ d }), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } });
    },
  },
  {
    method: "get",
    path: "/hd",
    handler(req) {
      const src = new URL(req.url).searchParams.get("src") || "";
      let inner = src;
      let sig = "";
      if (src.includes("/api/proxy/image")) {
        const p = new URLSearchParams(src.split("?")[1] || "");
        inner = p.get("url") || "";
        sig = p.get("sig") || "";
      }
      if (!_sign) return new Response("not ready: restart degoog after enabling the plugin", { status: 503 });
      // Brave thumbnails can point anywhere, so only follow ones degoog itself signed for a real result
      if (/^https?:\/\/imgs\.search\.brave\.com\//i.test(inner)) {
        const want = new URLSearchParams((_sign(inner).split("?")[1]) || "").get("sig");
        if (!sig || sig !== want) return new Response("unsigned", { status: 403 });
      }
      const w = Math.min(1280, Math.max(160, parseInt(new URL(req.url).searchParams.get("w") || "1280", 10) || 1280));
      const better = upgrade(inner, w); // only as big as the picture is shown, so phones get small files
      if (!better) return new Response("no upgrade", { status: 404 });
      return new Response(null, { status: 302, headers: { Location: _sign(better), "Cache-Control": "public, max-age=86400" } });
    },
  },
];

export default {
  isClientExposed: false,
  name: "Clean Titles & HD Thumbnails",
  description: "Google-style result titles, and sharper news and video thumbnails.",
  trigger: "cleantitles",
  aliases: ["ct"],
  settingsSchema: [],

  init(ctx) {
    if (ctx && typeof ctx.signProxyUrl === "function") _sign = ctx.signProxyUrl;
    if (ctx && typeof ctx.fetch === "function") _fetch = ctx.fetch;
  },

  execute() {
    return { title: "Clean Titles & HD Thumbnails", html: INFO_HTML };
  },
};
'@)
[IO.File]::WriteAllText("$t\script.js", @'
// Status line (first, so it also catches startup errors), only with #ctdebug in the address: shows what People also ask did on this device
const dbg = { code: "v34", qs: "not asked", err: "none" };
let DBG = false;
try { DBG = /ctdebug/.test(location.href) || sessionStorage.getItem("ct-dbg") === "1"; if (DBG) sessionStorage.setItem("ct-dbg", "1"); } catch { DBG = /ctdebug/.test(location.href); }
addEventListener("error", (e) => { dbg.err = `page: ${e.message}`; dbgShow(); });
const dbgShow = () => {
  if (!DBG || !document.body) return;
  let el = document.getElementById("ct-dbg");
  if (!el) { el = document.createElement("div"); el.id = "ct-dbg"; el.style.cssText = "position:fixed;left:8px;right:8px;top:8px;z-index:99999;background:#000;color:#0f0;font:12px/1.4 monospace;padding:6px;border-radius:6px;white-space:pre-wrap"; document.body.append(el); }
  const b = document.getElementById("ct-qa");
  const st = b ? getComputedStyle(b) : null;
  const t = `code ${dbg.code} | questions request: ${dbg.qs} | box in page: ${!!b} | box height: ${b ? b.offsetHeight : "-"} | display: ${st ? st.display : "-"} | visibility: ${st ? st.visibility : "-"} | results: ${document.querySelectorAll("#results-list .result-item").length} | error: ${dbg.err}`;
  if (el.textContent !== t) el.textContent = t; // unchanged text = no page change, so no endless loop
};
// clean-titles: ONE pass per new result, run before the browser draws it (no timers, no re-scans).
// Network work (HD thumbnails, missing video descriptions) only starts for results near the screen.

// Leftover endings like " | Section | The Guardian" or " - Seoul Economic Daily", even when the site name
// doesn't match the address. " - " endings only go when they look like a name (short, capitalised, no numbers)
const SMALL = /^(of|the|and|for|on|in|at|de|la|le|du|&)$/i;
const nameLike = (s) => s.length <= 32 && !/\d/.test(s) && s.split(/\s+/).length <= 4 && s.split(/\s+/).every((w) => /^[A-Z&]/.test(w) || SMALL.test(w));
const stripTail = (t) => {
  for (let i = 0; i < 3; i++) {
    const m = /^(.+)\s+([|–—·-])\s+([^|–—·]+)$/.exec(t);
    if (!m) break;
    const head = m[1].trim(), tail = m[3].trim();
    if (m[2] === "|" ? tail.length <= 40 && head.length >= 12 : nameLike(tail) && head.length >= 20) t = head;
    else break;
  }
  return t;
};

const cleanTitle = (raw, href) => {
  try {
    const title = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!title) return raw;
    let host = "";
    try { host = new URL(href).hostname.toLowerCase().replace(/^www\./, ""); } catch {}
    let t = title.replace(/\s*[|–—·-]\s*(\.\.\.|…)$/, "").trim() || title;
    if (/(^|\.)reddit\.com$/.test(host)) {
      let m = t.match(/^r\/([\w-]+) on Reddit\s*[:\-–—]\s*(.+)$/i);
      if (m) return `${m[2].trim()} : r/${m[1]}`;
      m = t.match(/^(.+?)\s*:\s*r\/([\w-]+)(?:\s*[-|–—]\s*Reddit)?$/i);
      if (m) return `${m[1].trim()} : r/${m[2]}`;
      t = t.replace(/\s*[-|–—]\s*Reddit$/i, "");
      return t.length >= 6 ? t : title;
    }
    const seps = /\s+[|–—·]\s+|\s+-\s+/;
    let parts = t.split(seps);
    const SE = /(^|\.)(stackexchange\.com|stackoverflow\.com|superuser\.com|serverfault\.com|askubuntu\.com|mathoverflow\.net)$/;
    if (SE.test(host) && parts.length >= 2) {
      const siteLike = /stack ?exchange|stack ?overflow|super ?user|server ?fault|ask ?ubuntu|mathoverflow/i;
      if (siteLike.test(parts[parts.length - 1])) parts = parts.slice(0, -1);
      if (parts.length >= 2 && parts[0].length <= 40) parts = parts.slice(1);
      const out = parts.join(" - ").trim();
      return out.length >= 8 ? out : title;
    }
    if (parts.length >= 2 && host) {
      const labels = host.split(".");
      let core = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
      if (labels.length >= 3 && core.length <= 3) core = labels[labels.length - 3];
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const last = norm(parts[parts.length - 1]);
      const brandish = last.length >= 3 && (last.includes(core) || (core.includes(last) && last.length >= 4));
      if (brandish) {
        const out = parts.slice(0, -1).join(" - ").trim();
        if (out.length >= 12) return stripTail(out);
      }
    }
    return stripTail(t);
  } catch {
    return raw;
  }
};

// Adult results only when the search asks for them
const ADULT_HOST = /(porn|xvideos|xnxx|xhamster|redtube|youporn|spankbang|eporner|onlyfans|fansly|chaturbate|stripchat|camsoda|bongacams|livejasmin|rule34|hentai|motherless|txxx|brazzers|bangbros|realitykings|erome|thothub|fapello|nudostar|xxx)|(^|[.-])(sex|nsfw|nudes?|escorts?)([.-]|$)/i;
const ADULT_TEXT = /\b(xxx|nsfw|hentai|milfs?|blowjobs?|cumshots?|creampies?|gangbangs?|deepthroat|(?:free|hd|amateur) porn|porn (?:videos?|clips?|pics?|tube|stars?)|sex (?:videos?|tapes?|cams?|chat)|camgirls?|onlyfans leaks?|nudes? leak(?:ed|s)?)\b/i;
const WANTS_ADULT = /\b(porn\w*|sex\w*|nude\w*|naked|nsfw|xxx|hentai|onlyfans|erotic\w*|milfs?|boobs?|tits?|pussy|dick|cock|fap\w*|r34|rule ?34|lewd)\b/i;
let href = "", wantsAdult = false, webTab = true, wantsDict = true;
// Dictionary pages only when the search is about a word (Bing adds them for words like "under" or "fix")
const DICT = /(^|\.)(merriam-webster\.com|thefreedictionary\.com|dictionary\.cambridge\.org|dictionary\.com|collinsdictionary\.com|oxfordlearnersdictionaries\.com|vocabulary\.com|wordreference\.com|yourdictionary\.com|wiktionary\.org|urbandictionary\.com)$/i;
const perSite = new Map();
const readQuery = () => {
  if (location.href === href) return;
  href = location.href;
  perSite.clear();
  try { wantsAdult = WANTS_ADULT.test(new URL(href).searchParams.get("q") || ""); } catch { wantsAdult = false; }
  try { webTab = !new URL(href).searchParams.get("type"); } catch { webTab = true; }
  try {
    const q = (new URL(href).searchParams.get("q") || "").trim();
    wantsDict = q.split(/\s+/).length <= 2 || /\b(define|definition|meaning|means?|synonyms?|antonyms?|pronounc\w*|spell\w*|dictionary|word|etymology|slang)\b/i.test(q);
  } catch { wantsDict = true; }
};
const adult = (host, text) => !wantsAdult && (ADULT_HOST.test(host) || ADULT_TEXT.test(text));

// HD thumbnails: only for hosts the plugin can upgrade, swapped in only once the sharp copy has loaded
const HD_HOST = /(^|\.)(ytimg\.com|bing\.com|mm\.bing\.net|imgs\.search\.brave\.com)$/i;
const canHD = (src) => {
  try {
    const u = new URL(src, location.href);
    const inner = u.pathname.includes("/api/proxy/image") ? u.searchParams.get("url") || "" : u.href;
    return HD_HOST.test(new URL(inner).hostname);
  } catch { return false; }
};
// A picture that stays far below the size it's shown at gets class ct-lowres: your CSS then shows it as a
// small thumbnail beside the text instead of a blurry banner (any engine, any host)
const low = (img, w, need) => { if (w && w < need * 0.6) img.closest(".result-item")?.classList.add("ct-lowres"); };
const hdImg = (img) => {
  // Wait for the small picture so its real size is known
  if (!img.complete) { img.addEventListener("load", () => hdImg(img), { once: true }); img.addEventListener("error", () => hdImg(img), { once: true }); return; }
  const nw = img.naturalWidth, nh = img.naturalHeight;
  // Size the picture actually fills on this screen (object-fit: cover), in real pixels
  const need = nw ? Math.ceil(Math.max(img.clientWidth, nh ? img.clientHeight * nw / nh : 0) * (window.devicePixelRatio || 1)) : 640;
  if (nw && need <= nw * 1.15) return; // already sharp at this size: no request at all
  const orig = img.getAttribute("src") || "";
  if (!canHD(orig)) { low(img, nw, need); return; } // no bigger copy exists anywhere
  const probe = new Image();
  probe.onload = () => {
    if (probe.naturalWidth > nw && img.getAttribute("src") === orig) {
      img.src = probe.src;
      const wrap = img.parentElement; // degoog hides the frame if the small picture failed: the sharp one works
      if (wrap && wrap.style.display === "none") wrap.style.display = "";
    }
    low(img, Math.max(nw, probe.naturalWidth), need);
  };
  probe.onerror = () => low(img, nw, need);
  probe.src = `/api/plugin/${__PLUGIN_ID__}/hd?w=${Math.min(1280, Math.max(160, need))}&src=${encodeURIComponent(orig)}`;
};

// Missing YouTube description: fetched from the video page by the plugin, then faded in
const ytId = (u) => {
  const h = u.hostname.replace(/^(www\.|m\.)/, "");
  const id = h === "youtube.com" && u.pathname === "/watch" ? u.searchParams.get("v") || ""
    : h === "youtu.be" ? u.pathname.slice(1)
    : h === "youtube.com" && u.pathname.startsWith("/shorts/") ? u.pathname.split("/")[2] || "" : "";
  return /^[\w-]{11}$/.test(id) ? id : "";
};
// Your CSS hides video descriptions on phones (like Google mobile), so phones never fetch them
const PHONE = matchMedia("(max-width: 767px)");
const getDesc = (p, id) => {
  fetch(`/api/plugin/${__PLUGIN_ID__}/ytdesc?v=${id}`, { priority: "low" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j || !j.d || !p.isConnected) return;
      const s = document.createElement("span");
      s.textContent = j.d;
      s.style.opacity = "0";
      s.style.transition = "opacity .3s ease";
      p.append(s);
      requestAnimationFrame(() => requestAnimationFrame(() => { s.style.opacity = "1"; }));
    })
    .catch(() => {});
};

// One shared watcher: runs a result's network work once it comes within ~1.5 screens
const work = new WeakMap();
const near = new IntersectionObserver((list) => {
  for (const e of list) {
    if (!e.isIntersecting) continue;
    near.unobserve(e.target);
    const f = work.get(e.target);
    work.delete(e.target);
    if (f) f();
  }
}, { rootMargin: "800px 0px" });

const row = (el) => {
  const a = el.querySelector("a.result-title");
  if (!a) return;
  const text = a.textContent || "";
  let u = null;
  try { u = new URL(a.href); } catch {}
  if (adult(u ? u.hostname : "", text)) { el.style.display = "none"; return; }
  // Variety like Google: at most 2 results from one site per search (Web tab only)
  const h0 = (u ? u.hostname : "").replace(/^www\./, "");
  if (!wantsDict && DICT.test(h0)) { el.style.display = "none"; return; }
  if (webTab && h0) { const k = perSite.get(h0) || 0; perSite.set(h0, k + 1); if (k >= 2) { el.style.display = "none"; return; } }
  const out = cleanTitle(text, a.href);
  if (out && out !== text.replace(/\s+/g, " ").trim()) { a.title = text.trim(); a.textContent = out; }
  // Link line: just the site name, like Google on phones (the full address shows on hover)
  const cite = el.querySelector(".result-cite");
  let site = "";
  try { site = new URL(el.dataset.resultUrl || a.href).hostname.replace(/^www\./, ""); } catch {}
  if (cite && site && cite.textContent.trim() !== site) { cite.title = cite.textContent.trim(); cite.textContent = site; }
  // Date at the start of a description ("Feb 1, 2022 ... text"): dimmed, with a tidy dot instead of the dots/dash
  const p0 = el.querySelector(".result-snippet");
  const n0 = p0 && p0.firstChild && p0.firstChild.nodeType === 3 ? p0.firstChild : null;
  const dm = n0 && /^\s*((?:[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})|(?:\d{1,2} [A-Z][a-z]{2,8}\.? \d{4})|(?:\d+ (?:minutes?|hours?|days?|weeks?|months?) ago))\s*(?:\.\.\.|…|—|–|-|·)\s*/.exec(n0.data);
  if (dm && n0.data.length > dm[0].length) { n0.data = n0.data.slice(dm[0].length); const ds = document.createElement("span"); ds.className = "ct-date"; ds.textContent = `${dm[1]} · `; p0.prepend(ds); }
  // degoog already shows the date: drop the same date repeated at the start of the description
  const rd = p0 && p0.querySelector(".result-date");
  let tn = rd && rd.nextSibling;
  while (tn && tn.nodeType === 3 && !tn.data.trim()) tn = tn.nextSibling;
  const dup = tn && tn.nodeType === 3 ? /^\s*(?:·\s*)?(?:[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}|\d{1,2} [A-Z][a-z]{2,8}\.? \d{4}|\d+ (?:minutes?|hours?|days?|weeks?|months?) ago)\s*(?:\.\.\.|…|—|–|-|·)\s*/.exec(tn.data) : null;
  if (dup && tn.data.length > dup[0].length) tn.data = (/^\s*·/.test(tn.data) ? " · " : "") + tn.data.slice(dup[0].length);
  const img = el.querySelector(".result-thumbnail-wrap img");
  const hd = !!img;
  const p = el.querySelector(".result-snippet");
  const date = p && p.querySelector(".result-date");
  const id = u && p && !(p.textContent || "").replace(date ? date.textContent || "" : "", "").trim() ? ytId(u) : "";
  if (hd || id) {
    work.set(el, () => { if (hd) hdImg(img); if (id && !(PHONE.matches && el.querySelector(".degoog-result--thumb--video"))) getDesc(p, id); });
    near.observe(el);
  }
};

const card = (el, isImage) => {
  const src = el.querySelector(isImage ? ".image-source" : ".video-source");
  const t = el.querySelector(isImage ? ".image-title" : ".video-title");
  const raw = (src && src.textContent || "").trim();
  const host = raw.toLowerCase().replace(/^www\./, "");
  const text = t && t.textContent || "";
  if (adult(host, text)) { el.style.display = "none"; return; }
  if (!isImage) return;
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
    if (c.contains("result-item")) { row(el); rankItems(el); }
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
// Weather words anywhere ("weather in nyc tomorrow"): the leftover words are the place; no place = no card
const WX = /\b(weather|wether|forecast|temperature|temp)\b/i;
const WX_DROP = /\b(weather|wether|forecast|temperature|temp|today|tonight|tomorrow|tommorow|tmrw|now|current|currently|this|next|week|weekend|hourly|daily|10|day|radar|what'?s|whats|what|is|the|teh|how'?s|in|for|at|of|like|will|it|be)\b/gi;
const bangFor = (q) => {
  const t = String(q || "").trim();
  if (!t || /(^|\s)!\S+/.test(t)) return null;
  const low = t.toLowerCase();
  for (const [w, trig] of tails) {
    if (!low.endsWith(" " + w)) continue;
    const rest = t.slice(0, t.length - w.length).trim();
    if (!rest || CODE_TAIL.test(rest)) return null;
    if (/^((what'?s|whats|what|is|the|my|current|local|right|now)\s*)+$/i.test(rest)) return `!${trig}`;
    return `!${trig} ${rest}`;
  }
  if (WX.test(t)) {
    const place = t.replace(WX_DROP, " ").replace(/[?,.!]/g, " ").replace(/\s+/g, " ").trim();
    if (place) return `!weather ${place}`;
  }
  return null;
};
const cardCache = new Map();
const glance = () => {
  const g = document.getElementById("at-a-glance");
  if (!g || !webTab) return;
  let q = "";
  try { q = (new URL(location.href).searchParams.get("q") || "").trim(); } catch {}
  const bang = bangFor(q);
  if (!bang) return;
  const good = [...g.querySelectorAll(".command-result")].some((c) => c.style.display !== "none" && c.parentElement?.style.display !== "none" && !/^\s*Usage:/.test(c.textContent));
  if (good) return;
  const put = (html) => {
    if (!html || g.querySelector(".ct-card")) return;
    g.style.display = "";
    g.innerHTML = `<div class="command-result ct-card">${html}</div>`;
    g.querySelectorAll("script").forEach((o) => { const n = document.createElement("script"); n.textContent = o.textContent; g.appendChild(n); });
  };
  if (cardCache.has(bang)) return put(cardCache.get(bang));
  cardCache.set(bang, "");
  fetch(`/api/command?q=${encodeURIComponent(bang)}`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const html = d && d.html && !/Usage:|not found|could not|no results|error/i.test(d.html.replace(/<[^>]+>/g, " ")) ? d.html : "";
      cardCache.set(bang, html);
      put(html);
    })
    .catch(() => cardCache.delete(bang));
};

// Typo fix line above the results, related searches below them (Web tab), and learning from your results
const nearWord = (a, b) => {
  const lim = Math.max(1, Math.round(a.length / 3));
  if (Math.abs(a.length - b.length) > lim || a === b) return false;
  let p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const r = [i];
    for (let j = 1; j <= b.length; j++) r[j] = Math.min(p[j] + 1, r[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = r;
  }
  return p[b.length] <= lim;
};
const lower = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
let extrasFor = "";
const extras = () => {
  if (extrasFor === location.href) return;
  const list = document.getElementById("results-list");
  if (!list || !list.querySelector(".result-item, .image-card, .video-card")) return;
  const key = (extrasFor = location.href);
  document.querySelectorAll("#ct-fix, #ct-related").forEach((e) => e.remove());
  let q = "", from = "", keepIt = false, acc = false;
  try {
    const u = new URL(key);
    q = (u.searchParams.get("q") || "").trim();
    from = (u.searchParams.get("ct_from") || "").trim();
    keepIt = u.searchParams.has("ct_keep");
    acc = u.searchParams.has("ct_acc");
  } catch {}
  if (!q) return;
  const go = (text, extra) => {
    const u = new URL(key);
    u.searchParams.set("q", text);
    for (const k of ["page", "ct_from", "ct_keep", "ct_acc"]) u.searchParams.delete(k);
    for (const [k, v] of Object.entries(extra || {})) u.searchParams.set(k, v);
    return u.toString();
  };
  // What this page's results say: titles, descriptions and site addresses of the first 10 shown
  const rows = [...list.querySelectorAll(".result-item")].filter((r) => r.style.display !== "none").slice(0, 10);
  const text = ` ${rows.map((r) => `${r.textContent} ${(r.querySelector("a.result-title") || {}).href || ""}`).join(" ").toLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ")} `;
  const count = (w) => text.split(` ${w} `).length - 1;
  if (webTab && rows.length) {
    const t = rows.map((r) => (r.querySelector("a.result-title") || {}).textContent || "");
    fetch(`/api/plugin/${__PLUGIN_ID__}/learn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t }), keepalive: true }).catch(() => {});
  }
  fetch(`/api/plugin/${__PLUGIN_ID__}/fix?q=${encodeURIComponent(q)}${keepIt ? "&keep=1" : ""}${acc && from ? `&acc=${encodeURIComponent(from)}` : ""}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j || location.href !== key || !list.isConnected) return;
      // Fixes that weren't sure before searching, like Google's "Did you mean": offered (never forced) only when
      // the results never use the typed word but clearly use one of its candidates (so names your results
      // know, like "Vitamix", stay as typed). Tap it once and that fix happens by itself from then on
      let dym = null;
      if (!from && webTab && j.words && j.words.length) {
        const out = lower(j.fix || q).split(" ");
        let changed = false;
        for (const { w, c } of j.words) {
          if (count(w)) continue;
          let best = null, bn = 1;
          for (const x of c) { const n = count(x); if (n > bn) { bn = n; best = x; } }
          // ...or the word or word pair the results use most that is a couple of letters away (new names:
          // "asurascxns" -> "asura scans" when the results keep saying "Asura Scans")
          if (w.length >= 4) {
            const tk = text.trim().split(" "), seen = new Map();
            tk.forEach((x, k) => { for (const y of [x, k + 1 < tk.length ? `${x} ${tk[k + 1]}` : ""]) if (y) seen.set(y, (seen.get(y) || 0) + 1); });
            for (const [y, n] of seen) if (n > bn && !/\d/.test(y) && nearWord(w, y.replace(/ /g, ""))) { bn = n; best = y; }
          }
          if (best) { for (let k = 0; k < out.length; k++) if (out[k] === w) out[k] = best; changed = true; }
        }
        if (changed) dym = out.join(" ");
      }
      if (!dym && !from && webTab && j.dym) dym = lower(j.dym);
      const link = (s, href) => { const a = document.createElement("a"); a.href = href; a.textContent = s; return a; };
      // Like Google: the fixed words in bold italics, the rest plain
      const marked = (s, href) => {
        const a = document.createElement("a");
        a.href = href;
        const was = new Set(lower(q).split(" "));
        s.split(" ").forEach((w, k) => {
          if (k) a.append(" ");
          if (was.has(w)) a.append(w);
          else { const b = document.createElement("b"), i = document.createElement("i"); i.textContent = w; b.append(i); a.append(b); }
        });
        return a;
      };
      if (j.fix || dym) {
        const box = document.createElement("div");
        box.id = "ct-fix";
        const l1 = document.createElement("div");
        if (j.fix) {
          l1.append("Showing results for ", marked(j.fix, go(j.fix)));
          const l2 = document.createElement("div");
          l2.className = "ct-fix-alt";
          l2.append("Search instead for ", link(q, go(`"${q}"`, { ct_keep: "1" })));
          box.append(l1, l2);
        } else {
          l1.append("Did you mean: ", marked(dym, go(dym, { ct_from: q, ct_acc: "1" })));
          box.append(l1);
        }
        list.before(box);
      }
      if (webTab && j.related && j.related.length) {
        const box = document.createElement("div");
        box.id = "ct-related";
        const h = document.createElement("h3");
        h.textContent = "Related searches";
        const g = document.createElement("div");
        g.className = "ct-rel-grid";
        for (const r of j.related) g.append(link(r, go(r)));
        box.append(h, g);
        list.after(box);
      }
    })
    .catch(() => {});
};

// ===== Rank higher / Rank lower, People also ask, and search Tools =====
const goTo = (text) => {
  const u = new URL(location.href);
  u.searchParams.set("q", text);
  for (const k of ["page", "ct_from", "ct_keep", "ct_acc"]) u.searchParams.delete(k);
  return u.toString();
};
const rowHost = (x) => { const w = x.querySelector(".result-actions"); return w ? w.dataset.host || "" : ""; };
// One tap in each result's tiny menu, kept forever (degoog's own site scores, so new searches rank it too)
const rankItems = (el) => {
  const menu = el.querySelector(".result-actions-menu");
  if (!menu || menu.querySelector(".ct-rank") || !menu.querySelector('[id^="result-action-score-"]')) return;
  const mk = (label, n) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "result-actions-item degoog-menu-item ct-rank";
    b.setAttribute("role", "menuitem");
    b.dataset.ctScore = String(n);
    b.textContent = label;
    return b;
  };
  menu.prepend(mk("Rank higher", 15), mk("Rank lower", -15));
};
document.addEventListener("click", async (e) => {
  const b = e.target.closest && e.target.closest(".ct-rank");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const wrap = b.closest(".result-actions"), menu = b.closest(".result-actions-menu");
  const host = wrap ? wrap.dataset.host || "" : "", n = Number(b.dataset.ctScore);
  if (menu) menu.hidden = true;
  const tg = wrap && wrap.querySelector(".result-actions-toggle");
  if (tg) tg.setAttribute("aria-expanded", "false");
  if (!host) return;
  let tok = null;
  try { tok = sessionStorage.getItem("degoog-settings-token"); } catch {}
  const h = { "Content-Type": "application/json" };
  if (tok) h["x-settings-token"] = tok;
  const r = await fetch("/api/settings/domain-action", { method: "POST", headers: h, credentials: "same-origin", body: JSON.stringify({ kind: "score", source: host, score: n }) }).catch(() => null);
  const list = document.getElementById("results-list");
  if (!r || !r.ok || !list) return;
  // Move that site's results now too: to the top, or to the bottom
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => { const rh = rowHost(x); return rh === host || rh.endsWith(`.${host}`); });
  if (n > 0) list.prepend(...rows); else list.append(...rows);
  rows.forEach((x) => { x.classList.add("ct-moved"); setTimeout(() => x.classList.remove("ct-moved"), 1200); });
}, true);

// People also ask, after the 3rd result: tap a question to see the best answer degoog finds for it
let paaFor = "";
// 3rd visible result right now (degoog can redraw the list after People also ask was requested)
const paaAnchor = () => [...(document.getElementById("results-list")?.querySelectorAll(".result-item") || [])].filter((x) => x.style.display !== "none")[2];
let paaBox = null;

const paa = () => {
  if (!webTab) return;
  if (paaFor === location.href) {
    // list was redrawn and took the box with it: put it back
    if (paaBox && !paaBox.isConnected) paaAnchor()?.after(paaBox);
    return;
  }
  const list = document.getElementById("results-list");
  if (!list) return;
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none");
  if (rows.length < 4) return;
  const key = (paaFor = location.href);
  let q = "", page = 1;
  try { const u = new URL(key); q = (u.searchParams.get("q") || "").trim(); page = Number(u.searchParams.get("page") || 1); } catch {}
  const old = document.getElementById("ct-qa");
  if (old) old.remove();
  paaBox = null;
  if (!q || page > 1 || q.startsWith("!")) return;
  dbg.qs = "sent"; dbgShow();
  fetch(`/api/plugin/${__PLUGIN_ID__}/qs?q=${encodeURIComponent(q)}`)
    .then((r) => { dbg.qs = "HTTP " + r.status; return r.ok ? r.json() : null; })
    .then((j) => {
      dbg.qs += j && Array.isArray(j.q) ? `, ${j.q.length} questions` : ", no data"; setTimeout(dbgShow, 300);
      if (!j || !Array.isArray(j.q) || j.q.length < 2 || location.href !== key || !paaAnchor()) return;
      const box = document.createElement("div");
      box.id = "ct-qa";
      const h = document.createElement("h3");
      h.textContent = "People also ask";
      box.append(h);
      for (const text of j.q) {
        const d = document.createElement("details");
        const s = document.createElement("summary");
        s.textContent = text;
        const body = document.createElement("div");
        body.className = "ct-qa-a";
        d.append(s, body);
        d.addEventListener("toggle", () => {
          if (!d.open || body.dataset.done) return;
          body.dataset.done = "1";
          body.textContent = "Loading…";
          const more = document.createElement("a");
          more.className = "ct-qa-more";
          more.href = goTo(text);
          more.textContent = "Search for this";
          fetch(`/api/search?q=${encodeURIComponent(text)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((sj) => {
              body.textContent = "";
              const top = sj && Array.isArray(sj.results) ? sj.results.find((x) => x && x.url && x.snippet) : null;
              if (top) {
                const p = document.createElement("p");
                p.textContent = String(top.snippet).replace(/<[^>]+>/g, "");
                const site = document.createElement("span");
                site.className = "ct-qa-site";
                try { site.textContent = new URL(top.url).hostname.replace(/^www\./, ""); } catch {}
                const a = document.createElement("a");
                a.className = "ct-qa-src";
                a.href = top.url;
                a.textContent = cleanTitle(top.title || top.url, top.url);
                body.append(p, site, a);
              }
              body.append(more);
            })
            .catch(() => { body.textContent = ""; body.append(more); });
        });
        box.append(d);
      }
      paaBox = box;
      paaAnchor().after(box);
    })
    .catch((e) => { dbg.qs = "blocked/failed: " + (e && e.message); dbgShow(); if (paaFor === key) paaFor = ""; });
};

// Tools, like Google's advanced search: a small link beside the tabs opens the fields, filled from your search
const advParse = (q) => {
  const o = { all: "", exact: "", none: "", site: "", ft: "" };
  let s = ` ${q} `;
  s = s.replace(/\s"([^"]+)"/, (m, x) => { o.exact = x; return " "; });
  s = s.replace(/\ssite:(\S+)/i, (m, x) => { o.site = x; return " "; });
  s = s.replace(/\sfiletype:(\S+)/i, (m, x) => { o.ft = x; return " "; });
  const none = [];
  s = s.replace(/\s-(\S+)/g, (m, x) => { none.push(x); return " "; });
  o.none = none.join(" ");
  o.all = s.replace(/\s+/g, " ").trim();
  return o;
};
const tools = () => {
  const tabs = document.getElementById("results-tabs");
  if (!tabs || !tabs.firstElementChild || document.getElementById("ct-tools")) return;
  const t = document.createElement("button");
  t.type = "button";
  t.id = "ct-tools";
  t.textContent = "Tools";
  t.setAttribute("aria-expanded", "false");
  tabs.append(t);
  t.addEventListener("click", () => {
    let f = document.getElementById("ct-adv");
    if (f) { f.remove(); t.setAttribute("aria-expanded", "false"); return; }
    t.setAttribute("aria-expanded", "true");
    let q = "";
    try { q = new URL(location.href).searchParams.get("q") || ""; } catch {}
    const o = advParse(q);
    f = document.createElement("form");
    f.id = "ct-adv";
    for (const [k, label, ph] of [["all", "All these words"], ["exact", "This exact phrase"], ["none", "None of these words"], ["site", "Site or domain", "reddit.com"], ["ft", "File type", "pdf"]]) {
      const l = document.createElement("label");
      const sp = document.createElement("span");
      sp.textContent = label;
      const i = document.createElement("input");
      i.name = k;
      i.value = o[k];
      i.autocomplete = "off";
      i.setAttribute("autocapitalize", "off");
      if (ph) i.placeholder = ph;
      l.append(sp, i);
      f.append(l);
    }
    const btn = document.createElement("button");
    btn.type = "submit";
    btn.textContent = "Search";
    f.append(btn);
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const v = (k) => (f.elements[k].value || "").trim();
      const parts = [v("all")];
      if (v("exact")) parts.push(`"${v("exact").replace(/"/g, "")}"`);
      for (const w of v("none").split(/\s+/)) if (w) parts.push(`-${w.replace(/^-+/, "")}`);
      if (v("site")) parts.push(`site:${v("site").replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`);
      if (v("ft")) parts.push(`filetype:${v("ft").replace(/^\./, "")}`);
      const nq = parts.filter(Boolean).join(" ");
      if (nq) location.href = goTo(nq);
    });
    tabs.after(f);
    if (!PHONE.matches) f.elements.all.focus();
  });
};

// Image loading skeleton: degoog always draws 4 columns; match the real grid's 3/4/5/6 by width
const skel = (root) => {
  const g = root.matches?.(".skeleton-image-grid") ? root : root.querySelector?.(".skeleton-image-grid");
  if (!g) return;
  const w = g.clientWidth || innerWidth;
  const want = w <= 800 ? 3 : w <= 1100 ? 4 : w <= 1400 ? 5 : 6;
  const cols = [...g.children];
  cols.slice(want).forEach((c) => c.remove());
  for (let i = cols.length; i < want; i++) g.append(cols[i % cols.length].cloneNode(true));
};

// Weather card with no city ("Usage: !weather <city>") is noise: hide it (no default city on purpose)
const noUsage = (root) => {
  const list = root.matches?.(".command-result") ? [root] : [...(root.querySelectorAll?.(".command-result") || [])];
  for (const c of list) if (/^\s*Usage: !weather\b/.test(c.textContent)) {
    const box = c.parentElement?.children.length === 1 ? c.parentElement : c;
    box.style.display = "none";
  }
};

// Each step runs on its own: one error can't stop the others (errors show on the #ctdebug line)
const safe = (name, fn) => { try { fn(); } catch (e) { dbg.err = `${name}: ${e && e.message}`; dbgShow(); } };
const init = () => {
  dbgShow();
  safe("query", readQuery);
  safe("usage", () => noUsage(document.body));
  safe("card", glance);
  safe("scan", () => scan(document.body));
  safe("skeleton", () => skel(document.body));
  safe("extras", extras); safe("ask", paa); safe("tools", tools);
  // Runs right after degoog inserts results and before the screen updates; only looks inside what was added
  new MutationObserver((muts) => {
    safe("query", readQuery);
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { safe("scan", () => scan(n)); safe("skeleton", () => skel(n)); safe("usage", () => noUsage(n)); }
    safe("extras", extras); safe("ask", paa); safe("tools", tools); safe("card", glance);
    dbgShow();
  }).observe(document.body, { childList: true, subtree: true });
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
'@)
Get-ChildItem $t | ForEach-Object { "  $($_.Name) $($_.Length) bytes" }
$c = docker ps -q | Where-Object { (docker inspect $_ --format '{{range .Mounts}}{{.Destination}} {{end}}') -match '/app/data' }
docker exec $c sh -c 'rm -rf /app/data/backups/clean-titles /app/data/backups/*.before-* /app/data/backups/server-settings.before-css.json; rmdir /app/data/backups 2>/dev/null; true'
docker cp "$t\index.js" "${c}:/app/data/plugins/clean-titles/index.js"; docker exec -u 0 $c rm -f /app/data/plugins/clean-titles/script.js
# English word list for the typo fixer (82,765 words with how common each is; downloaded once)
if (-not (docker exec $c sh -c 'test -s /app/data/plugins/clean-titles/words.txt && echo y')) { Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/wolfgarbe/SymSpell/master/SymSpell/frequency_dictionary_en_82_765.txt' -OutFile "$t\words.txt"; docker cp "$t\words.txt" "${c}:/app/data/plugins/clean-titles/words.txt" }
# Common English word pairs for the typo fixer ("how to", "the weather"; downloaded once)
if (-not (docker exec $c sh -c 'test -s /app/data/plugins/clean-titles/pairs.txt && echo y')) { Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/wolfgarbe/SymSpell/master/SymSpell/frequency_bigramdictionary_en_243_342.txt' -OutFile "$t\pairs.txt"; docker cp "$t\pairs.txt" "${c}:/app/data/plugins/clean-titles/pairs.txt" }

# Plugin page code goes inside degoog's page itself: no separate file, so no content blocker can stop it
[IO.File]::WriteAllText("$t\inline.js", @'
const fs = require("fs");
const f = "/app/src/public/themes/degoog-theme/layout.html";
let h = fs.readFileSync(f, "utf8");
const code = fs.readFileSync("/tmp/ct.js", "utf8").replace(/<\/script/gi, "<\\/script");
const block = '<script type="module" id="ct-inline">const __PLUGIN_ID__="clean-titles";\n' + code + '\n</script>';
const re = /<script type="module" id="ct-inline">[\s\S]*?\n<\/script>/;
h = re.test(h) ? h.replace(re, () => block) : h.replace("</body>", () => block + "\n</body>");
fs.writeFileSync(f, h);
'@)
docker cp "$t\script.js" "${c}:/tmp/ct.js"; docker cp "$t\inline.js" "${c}:/tmp/inline.js"
docker exec -u 0 $c bun /tmp/inline.js; docker exec -u 0 $c rm -f /tmp/ct.js /tmp/inline.js

# Your custom CSS, saved into degoog's settings
[IO.File]::WriteAllText("$t\custom.css", @'
/* Catppuccin Mocha colors */
html:root {
  --bg: #1e1e2e !important;
  --bg-light: #313244 !important;
  --bg-hover: #45475a !important;
  --border: #585b70 !important;
  --border-light: #313244 !important;
  --text-primary: #cdd6f4 !important;
  --text-secondary: #a6adc8 !important;
  --text-snippet: #bac2de !important;
  --text-cite: #9399b2 !important;
  --text-link: #89b4fa !important;
  --text-link-visited: #cba6f7 !important;
  --primary: #89b4fa !important;
  --primary-hover: #74c7ec !important;
  --search-bar-bg: #313244 !important;
  --search-bar-bg-hover: #45475a !important;
  --btn-bg: #313244 !important;
  --modal-footer: #181825 !important;
}

/* DESCRIPTION SIZE: change these two numbers to resize the descriptions on every tab (PC, then iPhone) */
html:root { --ct-desc-pc: 15px; --ct-desc-phone: 13.5px; }
/* Dates at the start of a description: dimmer, so they read as a label */
.result-snippet .ct-date { color: var(--text-cite) !important; }
/* Typo fix line above results (Google's "Showing results for") */
#ct-fix { margin: 6px 0 10px; font-size: 14px; line-height: 21px; color: var(--text-secondary); }
#ct-fix a { color: var(--text-link) !important; font-weight: 400; }
#ct-fix a b { font-weight: 600; }
#ct-fix .ct-fix-alt { font-size: 13px; color: var(--text-cite); }
#ct-fix .ct-fix-alt a { font-weight: 400; }
/* Related searches under the results: compact pills, 2 per row on PC, 1 per row on phones */
#ct-related { margin: 16px 0 8px; }
#ct-related h3 { font-size: 17px; line-height: 22px; font-weight: 500; color: var(--text-primary); margin: 0 0 10px; }
#ct-related .ct-rel-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
#ct-related a { display: block; padding: 11px 16px; border-radius: 999px; background: var(--bg-light); color: var(--text-primary) !important; font-size: 14px; line-height: 18px; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (hover: hover) { #ct-related a:hover { background: var(--bg-hover); } }
@media (max-width: 767px) { #ct-related .ct-rel-grid { grid-template-columns: minmax(0, 1fr); } }

/* Google-style images */
.image-grid { gap: 12px !important; }
.image-column { gap: 16px !important; }
.image-card { overflow: visible !important; border-radius: 0 !important; }
.image-card:hover { opacity: 1 !important; }
.image-thumb-wrap { border-radius: 14px; background: var(--bg-light); }
/* Broken or still-loading pictures: plain tile, no alt text spilling over it */
.image-thumb { color: transparent !important; font-size: 0 !important; }
@media (hover: hover) {
  .image-card:hover .image-thumb { filter: brightness(0.85); }
}
.image-info {
  position: static !important; opacity: 1 !important; background: none !important;
  padding: 6px 2px 2px !important; gap: 2px !important;
}
.image-title { color: var(--text-primary) !important; font-size: 13.5px !important; font-weight: 500; }
.image-source { color: var(--text-secondary) !important; font-size: 12.5px !important; }

/* Images: title on one line, then the site name in grey, like Google Images */
.image-title, .image-source { display: block !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
.image-source { color: var(--text-cite) !important; }

/* Images tab: no side panel, full width */
#results-layout.media-mode #sidebar-col,
#results-layout.media-mode #image-filters-bar { display: none !important; }
#results-layout.media-mode #results-main { max-width: none !important; }

/* Cleaner web results */
.result-engines { display: none !important; }
#results-meta { display: none !important; }
#tools-bar { display: none !important; }
.engine-performance-panel { display: none !important; }
.result-snippet {
  display: -webkit-box !important;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.result-snippet:empty { display: none !important; }
/* Titles: one even weight (Google only highlights matches in the description) */
.result-title :is(b, strong, em, mark) { font-weight: inherit !important; font-style: inherit !important; background: none !important; color: var(--text-link) !important; }
/* Visited titles: highlighted words turn purple with the rest (plain "inherit" skips the visited colour in Safari) */
:is(a:visited, .result-title:visited) :is(b, strong, em, mark) { color: var(--text-link-visited) !important; }
/* Descriptions: matches brighter, not just heavier */
.result-snippet :is(b, strong, em, mark) { color: inherit !important; font-weight: inherit !important; font-style: inherit !important; background: none !important; }

/* Tabs: edge-to-edge divider, first label lines up with the logo */
#results-tabs {
  border-bottom: 1px solid transparent !important;
  border-image: linear-gradient(var(--border-light), var(--border-light)) 0 0 1 0 / 0 0 1px 0 / 0 100vw !important;
}
#results-tabs { scrollbar-width: none; }
@media (min-width: 768px) {
  #results-tabs .results-tab:first-child { margin-left: -1rem !important; }
}

/* Summary box */
#at-a-glance > * {
  margin: 16px 0 0 -16px !important;
  background: rgba(49, 50, 68, 0.85) !important;
  border: none !important; border-radius: 12px !important;
}

/* Wikipedia card: Google-size picture (tall photos like a phone no longer stretch the
   card into a big empty box) and plain body text instead of link blue */
.wiki-card .wiki-thumb { max-width: 36% !important; max-height: 180px !important; width: auto !important; height: auto !important; object-fit: contain !important; background: none !important; border-radius: 10px !important; margin: 0 0 8px 16px !important; }
.wiki-card .wiki-extract { color: var(--text-primary) !important; }
/* Never too long: every part has a ceiling. Description 5 lines (4 on phones), subtitle
   2 lines, title 2 lines, picture 180px (120px on phones), logo 60px; the full article
   is one tap away via the Wikipedia link. So the card tops out around 260px on PC */
.wiki-card .wiki-extract { display: -webkit-box !important; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden !important; margin: 0 !important; }
.wiki-card .wiki-desc { display: -webkit-box !important; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden !important; }
.wiki-card .wiki-title { display: -webkit-box !important; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden !important; }
.wiki-card .wiki-thumb--logo { max-height: 60px !important; }
@media (max-width: 767px) {
  .wiki-card .wiki-thumb { max-height: 120px !important; max-width: 34% !important; }
  .wiki-card .wiki-extract { -webkit-line-clamp: 4; }
}

/* Info panel: always open, no dropdown or duplicate title */
.degoog-accordion-toggle--sidebar { display: none !important; }
.sidebar-accordion .degoog-accordion-body { display: block !important; }

/* Phones: panel on top (degoog default), proper spacing, summary card below it */
@media (max-width: 767px) {
  .sidebar-accordion .degoog-accordion-body { padding-top: 16px !important; }
  #at-a-glance > * { margin: 12px 0 12px 0 !important; }
}

@media (min-width: 768px) {
  /* Image preview floats over the grid */
  #media-preview-panel {
    position: fixed !important; top: 0 !important; right: 0 !important;
    height: 100vh !important; z-index: 300 !important;
  }
  #media-preview-panel.open {
    width: 34vw !important; min-width: 360px !important;
    margin-inline-start: 0 !important;
    box-shadow: -8px 0 24px rgba(0,0,0,.5) !important;
  }

  /* Header: search bar ends at the 44rem content edge, gear in the corner */
  #results-header .results-logo { flex: none !important; width: 6.5rem !important; }
  #results-header #results-search-bar { flex: none !important; width: 36.75rem !important; max-width: none !important; }
  #nav-settings-results {
    position: absolute !important;
    top: 1rem !important; right: 1.25rem !important;
    height: 2.75rem !important; margin: 0 !important;
    display: flex !important; align-items: center !important;
  }

  /* One column like the phone: info panel, then AI summary, then results */
  #results-layout:not(.media-mode) {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr);
    row-gap: 0;
    align-items: start;
    max-width: 76rem;
  }
  #results-layout:not(.media-mode) #results-main { display: contents; }
  #results-layout:not(.media-mode) #results-main > * { grid-column: 1; order: 2; max-width: 44rem !important; }
  #results-layout:not(.media-mode) #at-a-glance { order: 1; }
  #results-layout:not(.media-mode) #sidebar-col {
    grid-column: 1; order: 0; width: auto !important;
    margin: 16px 0 0 -16px !important; max-width: calc(44rem + 16px) !important;
  }
  #results-layout:not(.media-mode) .skeleton-card,
  #results-layout:not(.media-mode) .command-result { max-width: none !important; }
  #results-page.centered-mode #results-header,
  #results-page.centered-mode #results-tabs,
  #results-page.centered-mode #results-layout:not(.media-mode) { max-width: 76rem !important; }
}

/* Hide the empty info-panel placeholders (results and AI summary still show loading) */
#results-layout:not(.media-mode) :is(.skeleton-sidebar, .skeleton-sidebar-panel) { display: none !important; }

/* Phones: degoog's own 3-column masonry (every picture keeps its real shape, no square
   cropping, no gaps), tight 4px gutters, rounded corners, and just the site name in
   small grey text under each picture. Titles stay on PC, where there is room */
@media (max-width: 767px) {
  /* Same 8px margin on both sides of the screen (the right column ran into the edge) */
  #results-layout.media-mode, #results-layout.media-mode #results-main { padding-inline: 0 !important; margin-inline: 0 !important; max-width: none !important; width: 100% !important; box-sizing: border-box !important; }
  .image-grid { gap: 4px !important; padding: 8px 8px 24px !important; margin: 0 !important; width: 100% !important; box-sizing: border-box !important; }
  .image-column { gap: 10px !important; }
  .image-thumb-wrap { background: var(--bg-light) !important; }
  .image-card { border-radius: 0 !important; overflow: visible !important; }
  .image-thumb-wrap { border-radius: 8px !important; overflow: hidden !important; }
  .image-thumb { height: auto !important; object-fit: contain !important; }
  .image-info { padding: 4px 2px 0 !important; gap: 2px !important; }
  .image-title { display: block !important; font-size: 12px !important; line-height: 15px !important; font-weight: 400 !important; color: var(--text-primary) !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
  .image-source { font-size: 11px !important; line-height: 14px !important; }
}

/* ===== Tabs ======================================================
   Sizes measured from Google's own pages (Nov 2026), in your Catppuccin theme.
   degoog bug: when the window regains focus it redraws the tab bar and forgets
   the active tab, so each tab's look also applies when the results on the page
   show which tab it is, and the tab underline is put back. */

/* Images: underline after the reset */
#results-page:not(:has(.results-tab.active)):has(#results-layout.media-mode) .results-tab[data-type="tab:engine:images"] { color: var(--text-primary) !important; border-bottom-color: var(--text-primary) !important; }

/* Every tab shares Google's web-result look (slim source line with a 16px favicon on top, flush with the title, 21px one-line title,
   15px snippet, 28px between results). Inside a result the lines sit tight so they read as one
   block; the bigger gap between results does the separating. Tab sections below only add differences */
.result-item { margin: 0 !important; padding: 12px 0 !important; border: 0 !important; }
/* First result sits a bit closer to the tabs */
.result-item:nth-child(1 of .result-item) { padding-top: 6px !important; }
.result-item .result-body { display: flex !important; flex-direction: column !important; }
.result-item .result-body > * { order: 4; }
.result-url-row { order: 0 !important; gap: 8px !important; margin-top: 0 !important; height: 18px !important; align-items: center !important; overflow: visible !important; min-width: 0 !important; }
.result-item :is(.result-favicon, .result-favicon-missing) { box-sizing: border-box !important; display: block !important; align-self: center !important; position: relative !important; top: 1.5px !important; margin: 0 0 0 1px !important; width: 16px !important; height: 16px !important; padding: 0 !important; border-radius: 4px !important; background: none !important; object-fit: contain; font-size: 9px !important; flex: none !important; }
.result-item .result-favicon-missing { border-radius: 4px !important; background: var(--bg-hover) !important; color: var(--text-primary) !important; font-size: 10px !important; font-weight: 600 !important; line-height: 1 !important; padding: 0 !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; }
/* Site icon that failed to load (degoog swaps in a letter): same grey 16px square as a missing icon, not a bare floating letter */
.result-item .result-favicon.result-favicon-fallback { border-radius: 4px !important; background: var(--bg-hover) !important; color: var(--text-primary) !important; font-size: 10px !important; font-weight: 600 !important; line-height: 1 !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; }
/* Link line stays calm: long URLs stop at ~Google's breadcrumb width instead of running the full column */
.result-item .result-cite { max-width: 440px !important; }
.result-item .result-cite { font-size: 13px !important; line-height: 18px !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; min-width: 0 !important; }
.result-item .result-title { order: 1 !important; margin-top: 4px !important; font-size: 21px !important; line-height: 26px !important; font-weight: 400 !important; display: block !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
@media (max-width: 767px) { .result-item .result-title { white-space: normal !important; display: -webkit-box !important; -webkit-line-clamp: 2 !important; -webkit-box-orient: vertical; } }
/* Phones: title leads; summary and link line step back (smaller and greyer) so only the title asks for attention */
@media (max-width: 767px) {
  .result-item .result-title { font-size: 18px !important; line-height: 23px !important; margin-top: 5px !important; letter-spacing: -0.1px; }
  /* .result-body raises priority: the shared rule further down would otherwise win on phones too */
  .result-item .result-body .result-snippet { font-size: var(--ct-desc-phone) !important; line-height: 19px !important; margin-top: 4px !important; color: var(--text-secondary) !important; }
  /* Web pictures: smaller, top lined up with the title (not the link line), so results stop looking like product ads */
  .result-item .result-item-inner .result-thumbnail-wrap { width: 76px !important; height: 76px !important; margin-top: 22px !important; border-radius: 8px !important; }
  .result-item .result-cite { font-size: 13px !important; color: var(--text-secondary) !important; }
  /* Results 24px apart, no lines (lines made them look like ad units) */
  .result-item { padding-block: 12px !important; }
}
.result-item .result-snippet { order: 3 !important; -webkit-line-clamp: 2 !important; margin-top: 3px !important; font-size: var(--ct-desc-pc) !important; line-height: calc(var(--ct-desc-pc) * 1.47) !important; color: var(--text-snippet) !important; }
.result-insecure-badge { border: 0 !important; background: none !important; padding: 0 !important; color: var(--text-cite) !important; font-size: 12px !important; font-weight: 400 !important; }
.result-date { color: var(--text-cite) !important; }
/* Thumbnails: Google's 92px rounded squares (Videos and News set their own) */
.result-item .result-thumbnail-wrap { width: 92px !important; height: 92px !important; border-radius: 8px !important; overflow: hidden !important; }
.result-item .result-thumbnail-wrap img { width: 100% !important; height: 100% !important; object-fit: cover !important; }
/* AI summary "Read more": filled grey pill, centred, no blue outline */
#at-a-glance :is(button, a):is([class*="more" i], [class*="expand" i]):not([hidden]) { border: 0 !important; outline: 0 !important; background: var(--bg-light) !important; color: var(--text-primary) !important; border-radius: 999px !important; width: auto !important; margin-inline: auto !important; padding: 8px 20px !important; display: flex !important; }

/* Science: shared look, plus Scholar's green source line */
#results-page:is(:has(.results-tab.active[data-type="tab:engine:science"]), :not(:has(.results-tab.active)):has(.result-item:is([data-result-url*="doi.org/"], [data-result-url*="openalex.org/"], [data-result-url*="semanticscholar.org/"], [data-result-url*="ncbi.nlm.nih.gov/"], [data-result-url*="arxiv.org/"], [data-result-url*="researchhub.com/"]))) {
  & .results-tab[data-type="tab:engine:science"] { color: var(--text-primary) !important; border-bottom-color: var(--text-primary) !important; }
  & .result-thumbnail-wrap { display: none !important; }
  & .result-cite { color: #9fc5a8 !important; }
  & .result-snippet { -webkit-line-clamp: 2 !important; }
  & .result-insecure-badge { display: none !important; }
}

/* Forums: shared look, no thumbnails, 2-line titles and snippets */
#results-page:is(:has(.results-tab.active[data-type="tab:engine:forums"]), :not(:has(.results-tab.active)):not(:has(.result-item:is([data-result-url*="doi.org/"], [data-result-url*="openalex.org/"], [data-result-url*="semanticscholar.org/"], [data-result-url*="ncbi.nlm.nih.gov/"], [data-result-url*="arxiv.org/"], [data-result-url*="researchhub.com/"]))):has(.result-item:is([data-result-url*="reddit.com/r/"], [data-result-url*="stackoverflow.com/"], [data-result-url*="stackexchange.com/"], [data-result-url*="superuser.com/"], [data-result-url*="serverfault.com/"], [data-result-url*="askubuntu.com/"], [data-result-url*="news.ycombinator.com/"]))) {
  & .results-tab[data-type="tab:engine:forums"] { color: var(--text-primary) !important; border-bottom-color: var(--text-primary) !important; }
  & .result-thumbnail-wrap { display: none !important; }
  & .result-snippet { -webkit-line-clamp: 2 !important; }
  /* Phones: forums keep the tighter 24px gaps (short results read better close together) */
  @media (max-width: 767px) {
    & .result-item { padding-block: 12px !important; }
    & .result-item:nth-child(1 of .result-item) { padding-top: 6px !important; }
  }
}

/* News = Google/Apple News cards: 2-column grid, image on top, bold headline; lead story full width */
#results-page:is(:has(.results-tab.active[data-type="tab:engine:news"]), :not(:has(.results-tab.active, #results-layout.media-mode, .degoog-result--thumb--video, .result-item:is([data-result-url*="doi.org/"], [data-result-url*="openalex.org/"], [data-result-url*="semanticscholar.org/"], [data-result-url*="ncbi.nlm.nih.gov/"], [data-result-url*="arxiv.org/"], [data-result-url*="researchhub.com/"]), .result-item:is([data-result-url*="reddit.com/r/"], [data-result-url*="stackoverflow.com/"], [data-result-url*="stackexchange.com/"], [data-result-url*="superuser.com/"], [data-result-url*="serverfault.com/"], [data-result-url*="askubuntu.com/"], [data-result-url*="news.ycombinator.com/"])))) {
  & .results-tab[data-type="tab:engine:news"] { color: var(--text-primary) !important; border-bottom-color: var(--text-primary) !important; }
  /* Cards: every picture is the same 16:9 frame; stories without a picture become full-width
     text cards, and pictured cards pack in pairs (dense), so no half-empty rows */
  & :has(> .result-item) { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; grid-auto-flow: row dense !important; gap: 16px !important; margin: 0 0 0 -16px !important; max-width: calc(44rem + 16px) !important; padding-top: 0 !important; }
  & :has(> .result-item) > :not(.result-item) { grid-column: 1 / -1 !important; }
  & .result-item { padding: 0 !important; border: 0 !important; border-radius: 12px !important; background: rgba(49, 50, 68, .45) !important; overflow: hidden !important; }
  & .result-item::before { inset: 0; border-radius: 12px; }
  & .result-item:hover::before { background-color: rgba(69, 71, 90, .35); }
  & .result-item-inner { display: flex !important; flex-direction: column !important; align-items: stretch !important; gap: 0 !important; height: 100% !important; }
  & .result-body { flex: 1 !important; min-width: 0 !important; width: auto !important; max-width: none !important; box-sizing: border-box !important; padding: 14px 16px 16px !important; }
  & .result-thumbnail-wrap {
    order: -1 !important; flex: none !important; float: none !important; margin: 0 !important; background: var(--bg-light) !important;
    width: 100% !important; height: auto !important; aspect-ratio: 16 / 9 !important; border-radius: 0 !important; align-self: stretch !important;
  }
  & .result-thumbnail-wrap img { width: 100% !important; height: 100% !important; object-fit: cover !important; }
  & .result-url-row { order: 0 !important; margin: 0 !important; height: 18px !important; }
  & .result-cite { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  & .result-title { margin-top: 8px !important; font-size: 18px !important; line-height: 24px !important; font-weight: 500 !important; white-space: normal !important; display: -webkit-box !important; -webkit-line-clamp: 3 !important; -webkit-box-orient: vertical; overflow: hidden; }
  & .result-snippet { margin-top: 6px !important; font-size: calc(var(--ct-desc-pc) - 1.5px) !important; line-height: calc((var(--ct-desc-pc) - 1.5px) * 1.48) !important; -webkit-line-clamp: 2 !important; }
  /* No picture (or one that failed to load: degoog then hides its frame with an inline
     display:none but leaves the img inside): full-width text card */
  & .result-item:not(:has(.result-thumbnail-wrap:not([style*="none"]) img)) { grid-column: 1 / -1 !important; }
  & .result-item:not(:has(.result-thumbnail-wrap:not([style*="none"]) img)) .result-thumbnail-wrap { display: none !important; }
  & .result-item:not(:has(.result-thumbnail-wrap:not([style*="none"]) img)) .result-title { -webkit-line-clamp: 2 !important; }
  /* Pictures too small for a banner (the plugin marks them ct-lowres after trying for a sharper copy):
     Google News style, a small sharp thumbnail beside the text instead of a blurry full-width banner */
  & .result-item.ct-lowres { grid-column: 1 / -1 !important; }
  & .result-item.ct-lowres .result-item-inner { flex-direction: row-reverse !important; align-items: flex-start !important; }
  & .result-item.ct-lowres .result-thumbnail-wrap { order: 0 !important; flex: none !important; width: 92px !important; height: 92px !important; aspect-ratio: auto !important; border-radius: 8px !important; margin: 14px 14px 14px 0 !important; align-self: flex-start !important; }
  /* Lead story (if it has a picture): full width, picture on the right */
  @media (min-width: 768px) {
    & .result-item:not(.ct-lowres):nth-child(1 of .result-item):has(.result-thumbnail-wrap:not([style*="none"]) img) { grid-column: 1 / -1 !important; }
    & .result-item:not(.ct-lowres):nth-child(1 of .result-item):has(.result-thumbnail-wrap:not([style*="none"]) img) .result-item-inner { flex-direction: row !important; }
    & .result-item:not(.ct-lowres):nth-child(1 of .result-item):has(.result-thumbnail-wrap:not([style*="none"]) img) .result-thumbnail-wrap { order: 2 !important; flex: 0 0 50% !important; width: 50% !important; aspect-ratio: 16 / 9 !important; align-self: center !important; }
    & .result-item:not(.ct-lowres):nth-child(1 of .result-item):has(.result-thumbnail-wrap:not([style*="none"]) img) .result-body { padding: 20px 20px 20px 16px !important; }
    & .result-item:not(.ct-lowres):nth-child(1 of .result-item):has(.result-thumbnail-wrap:not([style*="none"]) img) .result-title { font-size: 22px !important; line-height: 28px !important; -webkit-line-clamp: 2 !important; }
  }
  /* Phones: one card per row, Google News mobile style: every picture is a sharp 92px thumbnail beside
     the headline (news sources rarely have a sharp full-width copy, so big banners came out blurry) */
  @media (max-width: 767px) {
    & :has(> .result-item) { grid-template-columns: minmax(0, 1fr) !important; gap: 12px !important; margin: 0 !important; max-width: none !important; }
    & .result-title { font-size: 18px !important; line-height: 24px !important; }
    & .result-snippet { font-size: var(--ct-desc-phone) !important; line-height: calc(var(--ct-desc-phone) * 1.44) !important; }
    & .result-item-inner { flex-direction: row-reverse !important; align-items: flex-start !important; }
    & .result-thumbnail-wrap { order: 0 !important; flex: none !important; width: 92px !important; height: 92px !important; aspect-ratio: auto !important; border-radius: 8px !important; margin: 16px 16px 16px 0 !important; align-self: flex-start !important; }
    /* Like Google News on phones: source, headline beside the picture, date; no description, so every
       card is the same height, text never wraps into the empty space under the picture, and 16px padding all round */
    & .result-body { padding: 16px !important; }
    & .result-snippet { font-size: 0 !important; line-height: 0 !important; margin-top: 6px !important; }
    & .result-snippet:not(:has(.result-date)) { display: none !important; }
    & .result-snippet .result-date { display: inline-block !important; font-size: 12.5px !important; line-height: 18px !important; }
  }
}

/* Videos: Google's sizes, but the thumbnail sits beside the title so rows stay even
   when a video has no description (common in your results; Google always has one) */
#results-page:is(:has(.results-tab.active[data-type="tab:engine:videos"]), :not(:has(.results-tab.active)):has(.degoog-result--thumb--video)) {
  & .results-tab[data-type="tab:engine:videos"] { color: var(--text-primary) !important; border-bottom-color: var(--text-primary) !important; }
  /* Same link line, sizes and gaps as every other tab; the text block (18 + 4 + 26 + 3 + 44 = 95px)
     sits beside the 94px thumbnail, tops lined up */
  /* Non-video results: no empty thumbnail gap, text starts at the left edge */
  & .result-item:not(:has(.degoog-result--thumb--video)) .result-thumbnail-wrap { display: none !important; }
  /* Videos: thumbnail pinned left, text beside it; each row is as tall as the thumbnail
     (or the text, if longer), whatever else degoog puts inside the result */
  & .result-item:has(.degoog-result--thumb--video) {
    box-sizing: content-box !important; min-height: 94px !important; padding-left: 184px !important; padding-top: 12px !important;
    & .result-item-inner { display: block !important; }
    & .result-body { min-width: 0 !important; }
    & .result-body > :empty { display: none !important; }
    & .result-thumbnail-wrap {
      position: absolute !important; left: 0 !important; top: 12px !important; float: none !important;
      width: 168px !important; height: 94px !important; border-radius: 8px !important; margin: 0 !important;
    }
    & .result-snippet { -webkit-line-clamp: 2 !important; }
  }
  @media (max-width: 767px) {
    & .result-item:has(.degoog-result--thumb--video) { min-height: 72px !important; padding-left: 140px !important; padding-block: 12px !important; }
    & .result-item:has(.degoog-result--thumb--video) .result-thumbnail-wrap { width: 128px !important; height: 72px !important; top: 12px !important; }
    & .result-item .result-title { font-size: 16px !important; line-height: 21px !important; }
    & .result-item:has(.degoog-result--thumb--video) .result-snippet { display: none !important; }
  }
}

/* ===== Interaction (beyond Google) ================================
   The whole result is one big click/tap target with a soft highlight on hover,
   so you don't have to aim for the title. Thumbnails, the menu and links in
   the AI summary stay separately clickable. Keyboard focus is clearly visible. */
.result-item { position: relative !important; isolation: isolate; }
.result-item::before { content: ""; position: absolute; inset: 0 -16px; z-index: -1; border-radius: 12px; pointer-events: none; transition: background-color .15s; }
.result-item .result-title::after { content: ""; position: absolute; inset: 0; z-index: 1; }
.result-item :is(.result-thumbnail-wrap, .result-actions) { position: relative; z-index: 2; }
@media (hover: hover) {
  .result-item:hover { background-color: transparent !important; box-shadow: none !important; }
  .result-item:hover::before { background-color: rgba(49, 50, 68, .45); }
  .result-item:hover .result-title { text-decoration: underline; text-underline-offset: 3px; }
}
.result-title:focus-visible { outline: none; }
.result-item:has(.result-title:focus-visible)::before { background-color: rgba(49, 50, 68, .45); outline: 2px solid var(--primary); }
::selection { background: rgba(137, 180, 250, .3); }

/* ===== Platform polish ============================================ */

/* Mac: crisper light-on-dark text. iPhone: no font inflation in landscape,
   no grey flash when tapping, and the page colour shows when you over-scroll */
html { background: var(--bg) !important; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
:is(.results-tab, .result-item a, .result-thumbnail-wrap, .image-card) { -webkit-tap-highlight-color: transparent; }

/* iPhone: text boxes at 16px so Safari doesn't zoom in when you tap the search bar */
@media (max-width: 767px) {
  :is(input[type="text"], input[type="search"], input:not([type]), textarea) { font-size: 16px !important; }
  .results-tab { padding-block: 12px !important; }
}

/* AI summary: normal text colour and size, slim follow-up box */
.glance-ai :is(p, li, span:not(.glance-ai-sources-label)) { color: var(--text-primary) !important; }
.glance-ai :is(p, li) { font-size: 15px !important; line-height: 1.6 !important; }
/* AI summary sources, Google AI Overview style: a small link icon right after the sentence
   it supports (site name and details pop up on hover / tap), so the text reads cleanly and
   icons never wrap onto a line of their own. "+1" stays when a sentence has more sources */
.glance-ai .glance-ai-cite { background: rgba(69, 71, 90, .55) !important; border-radius: 999px !important; padding: 0 5px !important; margin: 0 0 0 3px !important; gap: 3px !important; height: 20px !important; min-width: 20px !important; max-width: none !important; justify-content: center !important; vertical-align: -3px !important; color: var(--text-secondary) !important; transition: background-color .15s; }
.glance-ai .glance-ai-cite .glance-ai-cite-host { display: none !important; }
.glance-ai .glance-ai-cite .glance-ai-cite-more { font-size: 11.5px !important; line-height: 18px !important; color: var(--text-secondary) !important; opacity: 1 !important; padding-right: 1px; }
.glance-ai .glance-ai-cite-favicon { width: 13px !important; height: 13px !important; border-radius: 3px !important; }
/* Show less: the plugin parks it half off the bottom edge of the card in the page colour,
   where it is nearly invisible; put it under the text as the same pill as Read more */
.glance-ai .glance-ai-collapse:not([hidden]) { position: static !important; transform: none !important; align-self: center !important; display: flex !important; margin: 12px auto 0 !important; padding: 8px 20px !important; border: 0 !important; border-radius: 999px !important; background: var(--bg-light) !important; color: var(--text-primary) !important; font-size: 13px !important; }
.glance-ai:has(.glance-ai-collapse:not([hidden])) { padding-bottom: 16px !important; margin-bottom: 0 !important; }
@media (hover: hover) { #at-a-glance :is(.glance-ai-expand, .glance-ai-collapse):hover { background: var(--bg-hover) !important; } }
@media (hover: hover) { .glance-ai .glance-ai-cite:hover { background: var(--bg-hover) !important; } }
.glance-ai .glance-ai-cite--open { background: var(--bg-hover) !important; }
/* Key phrases: bold like Google, no tinted box behind them */
.glance-ai .glance-ai-key { background: none !important; padding: 0 !important; color: var(--text-primary) !important; font-weight: 600 !important; }
.glance-ai textarea {
  min-height: 0 !important; height: 40px !important; resize: none !important;
  padding: 9px 14px !important; border-radius: 20px !important;
}

/* ===== Instant answers (define, time, weather, math, every ! command) ======
   Same card as the AI summary. degoog wraps each plugin's card in a second
   .command-result and both add 24px above and below with no side padding, so the
   outer one becomes one evenly padded, full-width card and the inner one goes flat.
   Boxes inside a card (buttons, tables, icon tiles) sit one shade darker so they
   don't vanish into the card, and lines use a visible grey. */
#at-a-glance > .command-result { width: auto !important; max-width: none !important; padding: 20px 24px 16px !important; }
#at-a-glance .command-result .command-result { padding: 0 !important; margin: 0 !important; max-width: none !important; width: auto !important; background: none !important; }
#at-a-glance .command-result :is(h3, h4):first-child { margin-top: 0 !important; }
#at-a-glance .command-result > :last-child, #at-a-glance .command-result .command-result > :last-child { margin-bottom: 0 !important; }
#at-a-glance :is(.weather-hero-icon, .weather-week-wrap, .math-calc-key, .math-calc-expr) { background: rgba(17, 17, 27, .45) !important; border: 0 !important; }
#at-a-glance :is(.weather-hero, .weather-week th, .weather-week td, .command-help-table th, .command-help-table td) { border-color: rgba(88, 91, 112, .45) !important; }
#at-a-glance .math-widget { background: none !important; }
@media (max-width: 767px) {
  #at-a-glance > .command-result { padding: 16px 18px 12px !important; }
}

/* Time: Google's clock card (big light time, date under it, place and zone in grey) */
#at-a-glance .time-place { font-size: 14px !important; line-height: 20px !important; font-weight: 400 !important; color: var(--text-secondary) !important; margin: 0 !important; }
#at-a-glance .time-time { font-size: 44px !important; line-height: 52px !important; font-weight: 400 !important; margin: 4px 0 2px !important; color: var(--text-primary) !important; font-variant-numeric: tabular-nums; }
#at-a-glance .time-date { font-size: 15px !important; line-height: 22px !important; color: var(--text-primary) !important; margin: 0 !important; }
#at-a-glance .time-zone { font-size: 13px !important; line-height: 18px !important; color: var(--text-cite) !important; margin: 4px 0 0 !important; }

/* Weather: Google's big light temperature; details 2 per row on phones */
#at-a-glance .weather-result { max-width: none !important; }
#at-a-glance .weather-location { font-size: 15px !important; font-weight: 500 !important; color: var(--text-secondary) !important; margin: 0 0 12px !important; }
#at-a-glance .weather-hero { margin-bottom: 16px !important; padding-bottom: 16px !important; }
#at-a-glance .weather-hero-icon { border-radius: 14px !important; }
#at-a-glance .weather-temp { font-size: 44px !important; line-height: 52px !important; font-weight: 400 !important; }
#at-a-glance .weather-desc { font-size: 15px !important; opacity: 1 !important; }
#at-a-glance .weather-now-grid { gap: 10px 16px !important; margin-bottom: 16px !important; }
#at-a-glance .weather-now-item { font-size: 13.5px !important; }
#at-a-glance .weather-week-wrap { border-radius: 12px !important; }
@media (max-width: 767px) {
  #at-a-glance .weather-now-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  #at-a-glance .weather-temp { font-size: 38px !important; line-height: 44px !important; }
  #at-a-glance .weather-hero-icon { width: 56px !important; height: 56px !important; }
}

/* Math: Google's calculator (light result, darker keys, blue equals) */
#at-a-glance .math-query { font-size: 15px !important; font-weight: 400 !important; letter-spacing: 0 !important; }
#at-a-glance .math-equals { display: none !important; }
#at-a-glance .math-result { font-size: 36px !important; line-height: 44px !important; font-weight: 400 !important; font-variant-numeric: tabular-nums; }
#at-a-glance .math-calc { max-width: none !important; }
#at-a-glance .math-calc-expr { font-weight: 400 !important; border-radius: 10px !important; }
#at-a-glance .math-calc-key { border-radius: 10px !important; }
@media (hover: hover) { #at-a-glance .math-calc-key:hover { background: var(--bg-hover) !important; } }
#at-a-glance .math-calc-eq { background: var(--primary) !important; color: #11111b !important; font-weight: 600 !important; }

/* Define (def / define word): Google's dictionary box */
#at-a-glance .define-result { padding: 0 !important; margin: 0 !important; max-width: none !important; width: auto !important; background: none !important; }
#at-a-glance .define-result .define-word { font-size: 28px !important; line-height: 36px !important; font-weight: 400 !important; margin: 0 !important; color: var(--text-primary) !important; }
#at-a-glance .define-phonetic { font-size: 14px !important; line-height: 20px !important; margin: 2px 0 14px !important; color: var(--text-secondary) !important; }
#at-a-glance .define-meaning { margin: 0 0 10px !important; }
#at-a-glance .define-pos { display: block !important; font-style: italic !important; font-size: 14px !important; line-height: 20px !important; color: var(--text-secondary) !important; margin-bottom: 6px !important; }
#at-a-glance .define-list { list-style: decimal !important; margin: 0 !important; padding-left: 22px !important; }
#at-a-glance .define-list li { font-size: 15px !important; line-height: 22px !important; margin: 0 0 8px !important; padding-left: 4px !important; color: var(--text-primary) !important; }
#at-a-glance .define-list li::marker { color: var(--text-secondary); }
#at-a-glance .define-example { display: block !important; font-size: 14px !important; line-height: 20px !important; margin-top: 2px !important; color: var(--text-secondary) !important; }
@media (max-width: 767px) {
  #at-a-glance > .command-result:has(.define-result) { padding: 16px 18px 8px !important; }
  #at-a-glance .define-result .define-word { font-size: 24px !important; line-height: 32px !important; }
}

/* PC: the hover box around a result ends where the AI summary box ends (it ran 16px past it) */
@media (min-width: 768px) { .result-item::before { right: 0 !important; } }

/* Result menu: a tiny faint dot button that brightens when used; only Rank higher / Rank lower / Block inside */
.result-actions-toggle { width: 16px !important; height: 16px !important; min-width: 0 !important; padding: 0 !important; margin: 0 0 0 4px !important; border: 0 !important; background: none !important; font-size: 12px !important; line-height: 16px !important; color: var(--text-cite) !important; opacity: .5; }
.result-actions-toggle:hover, .result-actions-toggle[aria-expanded="true"] { opacity: 1; }
[id^="result-action-score-"], [id^="result-action-refresh-"], [id^="result-action-replace-"] { display: none !important; }
.result-actions-menu .result-actions-item { font-size: 13px !important; padding: 6px 12px !important; }
.result-item.ct-moved { animation: ct-flash 1.2s ease; }
@keyframes ct-flash { from { background: rgba(137, 180, 250, .12); } to { background: transparent; } }

/* People also ask: Google's question list with thin lines between questions */
#ct-qa { margin: 4px 0 24px; }
#ct-qa h3 { font-size: 18px; line-height: 24px; font-weight: 500; margin: 0 0 6px; color: var(--text-primary); }
#ct-qa details { border-top: 1px solid rgba(88, 91, 112, .45); }
#ct-qa details:last-child { border-bottom: 1px solid rgba(88, 91, 112, .45); }
#ct-qa summary { list-style: none; cursor: pointer; padding: 12px 28px 12px 0; position: relative; font-size: 15px; line-height: 22px; color: var(--text-primary); }
#ct-qa summary::-webkit-details-marker { display: none; }
#ct-qa summary::after { content: "⌄"; position: absolute; right: 4px; top: 8px; font-size: 18px; color: var(--text-secondary); transition: transform .2s; }
#ct-qa details[open] summary::after { transform: rotate(180deg); }
.ct-qa-a { padding: 0 0 14px; font-size: 14px; line-height: 21px; color: var(--text-snippet); }
.ct-qa-a p { margin: 0 0 8px; }
.ct-qa-site { display: block; font-size: 12.5px; color: var(--text-cite); }
.ct-qa-src { display: block; font-size: 16px; line-height: 22px; color: var(--text-link); text-decoration: none; margin-bottom: 6px; }
.ct-qa-more { font-size: 13px; color: var(--text-link); }
@media (max-width: 767px) { #ct-qa h3 { font-size: 16px; } #ct-qa summary { font-size: 14.5px; } }

/* Tools: a small link beside the tabs, opening Google-style advanced search fields */
#ct-tools { background: none; border: 0; padding: 0 12px; font: inherit; font-size: 13.5px; color: var(--text-secondary); cursor: pointer; margin-left: auto; }
#ct-tools[aria-expanded="true"] { color: var(--text-primary); }
#ct-adv { display: grid; grid-template-columns: max-content minmax(0, 360px); gap: 8px 16px; align-items: center; padding: 14px 0 16px; max-width: 600px; font-size: 13.5px; color: var(--text-secondary); }
#ct-adv label { display: contents; }
#ct-adv input { font: inherit; color: var(--text-primary); background: var(--bg-light); border: 1px solid var(--border-light); border-radius: 8px; padding: 7px 10px; outline: none; }
#ct-adv input:focus { border-color: var(--primary); }
#ct-adv button { grid-column: 2; justify-self: start; font: 600 13.5px system-ui, sans-serif; padding: 8px 18px; border: 0; border-radius: 999px; background: var(--primary); color: #11111b; cursor: pointer; }
@media (max-width: 767px) { #ct-adv { grid-template-columns: 1fr; gap: 4px; padding: 12px 16px; } #ct-adv input { margin-bottom: 6px; font-size: 16px; } #ct-adv button { grid-column: 1; } }
'@)
[IO.File]::WriteAllText("$t\setcss.js", @'
const fs = require("fs");
const f = "/app/data/server-settings.json";
const s = JSON.parse(fs.readFileSync(f, "utf8"));
s.settings = s.settings || {};
s.settings.customCss = fs.readFileSync("/tmp/custom.css", "utf8");
// Result menu with Rank higher / Rank lower / Block, and endless scroll (both built into degoog)
s.settings.domainBlockUiEnabled = true;
s.settings.domainScoreUiEnabled = true;
s.settings.infiniteScrollEnabled = true;
fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2));
fs.renameSync(f + ".tmp", f);
console.log("custom CSS saved into degoog: " + s.settings.customCss.length + " chars");
'@)
docker cp "$t\custom.css" "${c}:/tmp/custom.css"; docker cp "$t\setcss.js" "${c}:/tmp/setcss.js"
docker exec $c bun /tmp/setcss.js; docker exec $c rm -f /tmp/custom.css /tmp/setcss.js
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $t
docker restart $c; "done, leftovers removed"
$null = docker exec $c sh -c 'for i in $(seq 1 40); do curl -fs -o /dev/null http://127.0.0.1:${DEGOOG_PORT:-4444}/readyz && exit 0; sleep 1; done'

$ss = docker exec $c cat /app/data/server-settings.json | Out-String | ConvertFrom-Json
"custom CSS in degoog: $("$($ss.settings.customCss)".Length) chars"
"plugin code inside the page (should be 1): " + (docker exec $c grep -c ct-inline /app/src/public/themes/degoog-theme/layout.html)
"separate script file gone (should be True): " + (-not (docker exec $c sh -c 'ls /app/data/plugins/clean-titles/script.js 2>/dev/null'))
"typo fixer word list (should be about 82800): " + (docker exec $c sh -c 'wc -l < /app/data/plugins/clean-titles/words.txt')
"typo fixer word pairs (should be about 243000): " + (docker exec $c sh -c 'wc -l < /app/data/plugins/clean-titles/pairs.txt')
"old backup copies left in degoog: " + (docker exec $c sh -c 'ls /app/data/backups 2>/dev/null | wc -l')
"result menu with Rank higher / Rank lower / Block (should be True): $($ss.settings.domainScoreUiEnabled -and $ss.settings.domainBlockUiEnabled)"
"endless scroll on (should be True): $($ss.settings.infiniteScrollEnabled)"
# Checks both code files for mistakes and tries the typo fixer and People also ask, from inside degoog
[IO.File]::WriteAllText("$env:TEMP\ct-check.js", @'
const fs = require("fs");
const test = (name, code) => {
  if (!code) return console.log(`${name}: MISSING`);
  try { new Bun.Transpiler({ loader: "js" }).transformSync(code); console.log(`${name}: OK`); }
  catch (e) { console.log(`${name}: ERROR ${(e.errors || [e]).slice(0, 3).map((x) => String(x.message || x).split("\n")[0]).join(" | ")}`); }
};
const m = /<script type="module" id="ct-inline">([\s\S]*?)\n<\/script>/.exec(fs.readFileSync("/app/src/public/themes/degoog-theme/layout.html", "utf8"));
test("page code check (should be OK)", m && m[1]);
test("server code check (should be OK)", fs.readFileSync("/app/data/plugins/clean-titles/index.js", "utf8"));
const base = `http://127.0.0.1:${process.env.DEGOOG_PORT || 4444}/api/plugin/clean-titles`;
for (const [name, path] of [["typo fix for 'teh wether tommorow'", "/fix?q=teh+wether+tommorow"], ["People also ask for 'pittsburgh steelers'", "/qs?q=pittsburgh+steelers"]]) {
  const s = Date.now();
  try { const r = await fetch(base + path, { signal: AbortSignal.timeout(10000) }); console.log(`${name}: ${(await r.text()).slice(0, 400)} (${Date.now() - s} ms)`); }
  catch (e) { console.log(`${name}: failed: ${e}`); }
}
'@)
docker cp "$env:TEMP\ct-check.js" "${c}:/tmp/ct-check.js"; docker exec $c bun /tmp/ct-check.js; docker exec $c rm -f /tmp/ct-check.js; Remove-Item -Force "$env:TEMP\ct-check.js"
} | Tee-Object -Variable o; $o | Out-String | Set-Clipboard
