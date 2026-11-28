// ----- server/08-vision.js: ct-vision (GPU reranker + image AI) calls, jsonOut, DOI publisher names -----
// Image AI (ct-vision container next to degoog, SigLIP 2 on the GPU): how well each image shows the search, and which
// images look alike. Down or missing -> null, and the page just keeps its word rule.
const VIS = process.env.CT_VISION_URL || "http://ct-vision:8077";
let visDownUntil = 0;
const vis = async (path, body, ms) => {
  if (Date.now() < visDownUntil) return null;
  try {
    const r = await fetch(VIS + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch (e) { if (!(e && e.name === "TimeoutError")) visDown(); return null; }
};
// ct-vision not answering (e.g. still loading after a restart): skip it, and check its /health every 3 s so the AI is
// back the moment it is up (was a blind 60 s pause, which kept the AI off for up to a minute after every start)
let visPoll = null;
const visDown = () => {
  visDownUntil = Date.now() + 3600000;
  if (visPoll) return;
  visPoll = setInterval(async () => {
    try { const r = await fetch(VIS + "/health", { signal: AbortSignal.timeout(2000) }); if (r.ok) { visDownUntil = 0; clearInterval(visPoll); visPoll = null; } } catch {}
  }, 3000);
  if (visPoll.unref) visPoll.unref();
};
const jsonOut = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// Results hook (installed into degoog's search step by inline.js): before a web/Forums/News/Science search is sent,
// the answer AI (reranker on the GPU) scores every result for how well it fits the search (ctRel, 0..1), and for
// question-like searches each top result's best sentence (ctBest {s, p}) for the featured snippet. 1.6 s wait (a slower answer is kept for the next request);
// no AI or too slow -> results go out unchanged and the page uses its word rules. Same search again: from memory.
const AIC = new Map();
const stripT = (t) => String(t || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const sentences = (t) => stripT(t).replace(/^[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}\s*(?:\.\.\.|…|·|-|—)\s*/, "").split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/).map((x) => x.trim()).filter((x) => x.length >= 25 && x.length <= 400 && !/(?:\.\.\.|…)$/.test(x));
const QLIKE = /\?\s*$|^(?:what|whats|what's|how|who|whom|whose|when|where|why|which|is|are|was|were|can|could|does|do|did|should|will|would)\b/i;
// doi.org results show the publisher, not "doi.org": the page knows ~40 big publishers by DOI prefix; any other prefix
// is looked up here in Crossref's prefix list (10.xxxx -> owner name), once per prefix, kept in doi-prefixes.json
// (prefix and name only) and added to the results (ctPub) before they leave the server, so it is there at first paint.
const DOIP = new Map(), DOI_MISS = new Map();
let doiLoaded = false;
const doiLoad = () => { if (doiLoaded) return; doiLoaded = true; try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(`${DIR}/doi-prefixes.json`, "utf8")))) if (typeof v === "string" && v) DOIP.set(k, v); } catch {} };
const doiSave = () => { try { fs.writeFileSync(`${DIR}/doi-prefixes.json.tmp`, JSON.stringify(Object.fromEntries(DOIP))); fs.renameSync(`${DIR}/doi-prefixes.json.tmp`, `${DIR}/doi-prefixes.json`); } catch {} };
export const doiNice = (n) => {
  let t = String(n || "").replace(/\s+/g, " ").trim();
  const a = /\(([A-Z][A-Za-z0-9&.-]{1,9})\)\s*$/.exec(t);
  if (a) return a[1];
  t = t.replace(/\s*\([^)]*\)\s*$/, "").replace(/[,\s]+(?:B\.?V\.?|Ltd\.?|Limited|Inc\.?|LLC|L\.L\.C\.|GmbH|AG|S\.?A\.?|Co\.?|Corp\.?|Corporation|Verlag)$/i, "").trim();
  return t.slice(0, 40);
};
export const doiPrefixOf = (url) => { try { const u = new URL(url); if (!/^(?:dx\.)?doi\.org$/.test(u.hostname.replace(/^www\./, ""))) return ""; const m = /^\/(10\.\d{4,9})\//.exec(decodeURIComponent(u.pathname)); return m ? m[1] : ""; } catch { return ""; } };
const doiAsk = async (p) => {
  if (DOIP.has(p) || (DOI_MISS.get(p) || 0) > Date.now()) return;
  const r = await net(`https://api.crossref.org/prefixes/${encodeURIComponent(p)}`, { timeout: 4000, accept: "application/json", headers: WD_UA });
  let name = "";
  try { name = doiNice(JSON.parse(r.text).message.name); } catch {}
  if (name) { DOIP.set(p, name); doiSave(); } else DOI_MISS.set(p, Date.now() + 3600000);
};
const doiNames = async (rs) => {
  doiLoad();
  const need = new Set();
  for (const r of rs) { const p = doiPrefixOf(r.url); if (p && !DOIP.has(p)) need.add(p); }
  if (need.size) await Promise.race([Promise.all([...need].slice(0, 12).map((p) => doiAsk(p).catch(() => {}))), new Promise((r) => { const t = setTimeout(r, 900); if (t.unref) t.unref(); })]);
  let n = 0;
  for (const r of rs) { const p = doiPrefixOf(r.url); if (p && DOIP.has(p)) { r.ctPub = DOIP.get(p); n++; } }
  return n;
};
