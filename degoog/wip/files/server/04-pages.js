// ----- server/04-pages.js: pages fetched on your tap: archived copy, quick view, product panel, stars -----
// ===== Archived copy (spec 10): asked only when you tap "Open archived copy" in a result's menu =====
// archive.today, the Wayback Machine and Ghostarchive are asked in parallel; the first that has the page in this
// order wins: archive.today first for paywalled sites (it keeps the full text), else Wayback first (dead pages).
// None has it -> archive.today's save page for that address. Endpoints from knowledge, NOT live-checked here.
const ARCH_UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36" };
export const archSave = (u) => `https://archive.ph/?url=${encodeURIComponent(u)}`;
const _arch = new Map();
export const archFind = async (u, paywall) => {
  let url;
  try { url = new URL(u); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || u.length > 2000) return null;
  const key = createHash("sha256").update(`arch\n${u}`).digest("hex").slice(0, 24);
  const hit = _arch.get(key);
  if (hit && Date.now() - hit.t < (hit.v.src === "save" ? 600000 : TTL)) return hit.v;
  const today = async () => {
    const r = await net(`https://archive.ph/newest/${u}`, { timeout: 4000, redirect: "manual", headers: ARCH_UA, max: 400000 });
    const loc = r.location || "";
    return r.status >= 300 && r.status < 400 && /^https:\/\/archive\.(?:ph|today|is|li|vn|fo|md)\/(?:[A-Za-z0-9]{4,6}$|\d{14}\/|\d{4}\.\d{2}\.\d{2}-\d{6}\/)/.test(loc) ? loc : "";
  };
  const wayback = async () => {
    const r = await net(`https://archive.org/wayback/available?url=${encodeURIComponent(u)}`, { timeout: 4000, accept: "application/json", max: 100000 });
    try { const c = JSON.parse(r.text).archived_snapshots.closest; return c && c.available && /^https?:\/\/web\.archive\.org\/web\/\d+/.test(c.url) ? c.url.replace(/^http:/, "https:") : ""; } catch { return ""; }
  };
  const ghost = async () => {
    const r = await net(`https://ghostarchive.org/search?term=${encodeURIComponent(u)}`, { timeout: 4000, headers: ARCH_UA, max: 600000 });
    const m = /href="(\/archive\/[A-Za-z0-9]+)"/.exec(r.text || "");
    return m ? `https://ghostarchive.org${m[1]}` : "";
  };
  const [a, w, g] = await Promise.all([today(), wayback(), ghost()]);
  const order = paywall ? [[a, "archive.today"], [w, "Wayback Machine"], [g, "Ghostarchive"]] : [[w, "Wayback Machine"], [a, "archive.today"], [g, "Ghostarchive"]];
  const f = order.find(([x]) => x);
  const v = f ? { url: f[0], src: f[1] } : { url: archSave(u), src: "save" };
  if (_arch.size > 500) _arch.clear();
  _arch.set(key, { t: Date.now(), v });
  return v;
};

// ===== Quick view (spec 11): asked only when you tap "Quick view" in a result's menu =====
// The server fetches the page once and reads its schema.org JSON-LD (recipe, how-to, product, FAQ, event, app,
// movie/book, local business, article); else the page's main text (a small Readability-like pass); JS-only pages
// give nothing and stay links. Only text goes back to the page (drawn with textContent), never the page's HTML.
const ldStrip = (h) => String(h == null ? "" : h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " "; })
  .replace(/[ \t\r\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const ld1 = (x) => (Array.isArray(x) ? x[0] : x);
const ldTxt = (x, n = 300) => { const v = ld1(x); const t = ldStrip(typeof v === "object" && v ? v.name || v["@value"] || v.text || "" : v); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const ldTypes = (o) => [].concat(o && o["@type"] || []).map(String);
// "2026-11-20T10:00:00Z" -> "Nov 20, 2026" (a bare year stays a year)
const ldDay = (x) => { const t = ldTxt(x, 40); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); if (!m) return /^\d{4}$/.test(t) ? t : ""; return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); };
// ISO 8601 duration -> "1 hr 30 min"
export const isoDur = (d) => {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:\d+(?:\.\d+)?S)?)?$/i.exec(String(d || "").trim());
  if (!m) return "";
  const mins = Math.round((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0));
  if (!mins) return "";
  const h = Math.floor(mins / 60), r = mins % 60;
  return h ? `${h} hr${r ? ` ${r} min` : ""}` : `${r} min`;
};
const ldRating = (o) => { const a = o && ld1(o.aggregateRating); const v = a && Number(a.ratingValue), best = a && Number(a.bestRating || 5); const n = a && Number(a.ratingCount || a.reviewCount || 0); return v > 0 && best > 0 ? { v: Math.round((v / best) * 50) / 10, n: Number.isFinite(n) ? n : 0 } : null; };
const ldSteps = (ins) => {
  const out = [];
  const walk = (x) => {
    if (out.length >= 60 || x == null) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === "string") { ldStrip(x).split(/\n+/).map((t) => t.trim()).filter(Boolean).forEach((t) => out.push(t.slice(0, 600))); return; }
    if (typeof x === "object") {
      if (x.itemListElement) { walk(x.itemListElement); return; }
      const t = ldStrip(x.text || x.name || "");
      if (t) out.push(t.slice(0, 600));
    }
  };
  walk(ins);
  return out;
};
const ORDER = ["Recipe", "HowTo", "Product", "FAQPage", "Event", "SoftwareApplication", "MobileApplication", "WebApplication", "Movie", "TVSeries", "Book", "LocalBusiness", "Restaurant", "Store", "Article", "NewsArticle", "BlogPosting", "Report", "TechArticle"];
const LOCAL = /(?:LocalBusiness|Restaurant|Store|Cafe|CafeOrCoffeeShop|Bakery|BarOrPub|Hotel|Dentist|Physician|AutoRepair|Museum|TouristAttraction)$/;
// All JSON-LD objects of a page (arrays and @graph flattened), parse failures skipped
export const ldObjects = (html) => {
  const out = [];
  const re = /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 200) {
    let j;
    try { j = JSON.parse(m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "").trim()); } catch { continue; }
    const add = (x) => { if (Array.isArray(x)) x.forEach(add); else if (x && typeof x === "object") { out.push(x); if (x["@graph"]) add(x["@graph"]); } };
    add(j);
  }
  return out;
};
// The quick view for one page's HTML: {kind, title, facts: [[label, value]], lists: [{label, items}], text: [...]}
export const qvFrom = (html, base = "") => {
  const objs = ldObjects(html);
  const pick = ORDER.map((t) => objs.find((o) => ldTypes(o).some((x) => x === t || (t === "LocalBusiness" && LOCAL.test(x))))).find(Boolean);
  const facts = [], lists = [];
  const fact = (k, v) => { if (v) facts.push([k, String(v)]); };
  const star = (r) => (r ? `${r.v.toFixed(1)} ★${r.n ? ` (${r.n.toLocaleString("en-US")})` : ""}` : "");
  if (pick) {
    const t = ldTypes(pick).find((x) => ORDER.includes(x) || LOCAL.test(x)) || "";
    const title = ldTxt(pick.name || pick.headline, 200);
    let kind = "page";
    if (t === "Recipe") {
      kind = "recipe";
      fact("Rating", star(ldRating(pick))); fact("Total time", isoDur(pick.totalTime) || isoDur(pick.cookTime)); fact("Serves", ldTxt(pick.recipeYield, 40));
      const ing = [].concat(pick.recipeIngredient || pick.ingredients || []).map((x) => ldStrip(x)).filter(Boolean).slice(0, 80);
      if (ing.length) lists.push({ label: "ingredients", items: ing });
      const st = ldSteps(pick.recipeInstructions);
      if (st.length) lists.push({ label: "steps", items: st, ordered: true });
    } else if (t === "HowTo") {
      kind = "howto";
      fact("Time", isoDur(pick.totalTime));
      const st = ldSteps(pick.step);
      if (st.length) lists.push({ label: "steps", items: st, ordered: true });
    } else if (t === "Product") {
      kind = "product"; // no store prices (spec)
      fact("Rating", star(ldRating(pick))); fact("Brand", ldTxt(pick.brand, 80));
      const d = ldTxt(pick.description, 400); if (d) lists.push({ label: "", items: [d], para: true });
    } else if (t === "FAQPage") {
      kind = "faq";
      const qa = [].concat(pick.mainEntity || []).map((x) => x && `${ldTxt(x.name, 200)}\n${ldTxt(x.acceptedAnswer && (ld1(x.acceptedAnswer).text || ld1(x.acceptedAnswer)), 600)}`.trim()).filter((x) => x && x.includes("\n"));
      if (qa.length) lists.push({ label: "questions", items: qa, qa: true });
    } else if (t === "Event") {
      kind = "event";
      const loc = ld1(pick.location);
      fact("When", ldDay(pick.startDate)); fact("Where", loc && (ldTxt(loc.name, 120) || ldTxt(loc.address, 160)));
    } else if (/Application$/.test(t)) {
      kind = "app";
      fact("Rating", star(ldRating(pick))); fact("Runs on", ldTxt(pick.operatingSystem, 80)); fact("Category", ldTxt(pick.applicationCategory, 60));
    } else if (t === "Movie" || t === "TVSeries" || t === "Book") {
      kind = t === "Book" ? "book" : "movie";
      fact("Rating", star(ldRating(pick))); fact(t === "Book" ? "Author" : "Director", ldTxt(pick.author || pick.director, 120)); fact("Released", ldDay(pick.datePublished || pick.dateCreated)); fact(t === "Book" ? "Pages" : "Running time", t === "Book" ? ldTxt(pick.numberOfPages, 10) : isoDur(pick.duration));
    } else if (LOCAL.test(t)) {
      kind = "place";
      const a = ld1(pick.address);
      fact("Rating", star(ldRating(pick))); fact("Address", a && typeof a === "object" ? [a.streetAddress, a.addressLocality, a.addressRegion].map((x) => ldTxt(x, 80)).filter(Boolean).join(", ") : ldTxt(a, 200)); fact("Phone", ldTxt(pick.telephone, 40));
      const oh = [].concat(pick.openingHours || []).map((x) => ldTxt(x, 60)).filter(Boolean);
      if (oh.length) fact("Hours", oh.slice(0, 3).join("; "));
    } else {
      kind = "article";
      const words = Number(pick.wordCount);
      fact("By", ldTxt(pick.author, 80)); fact("Published", ldDay(pick.datePublished)); fact("Reading time", words > 0 ? `${Math.max(1, Math.round(words / 230))} min` : "");
      if (pick.isAccessibleForFree === false || String(pick.isAccessibleForFree).toLowerCase() === "false") fact("Access", "Paywall");
    }
    if (facts.length || lists.length) return { kind, title, facts, lists, text: kind === "article" ? mainText(html) : [] };
  }
  const text = mainText(html);
  return text.length ? { kind: "page", title: "", facts, lists, text } : null;
};
// Readability-like: paragraphs of real sentences from <article>/<main> (else the whole body), the first few
export const mainText = (html) => {
  const body = (/<article\b[\s\S]*?<\/article>/i.exec(html) || /<main\b[\s\S]*?<\/main>/i.exec(html) || [html])[0];
  const ps = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(body)) && ps.length < 4) { const t = ldStrip(m[1]).replace(/\s+/g, " "); if (t.length >= 80 && /[.!?]["')\]]?$/.test(t) && !/cookie|subscribe|sign up|javascript/i.test(t)) ps.push(t.length > 700 ? `${t.slice(0, 699).trimEnd()}…` : t); }
  return ps;
};
// Never fetch this server's own network: the bridge has no sign-in, so a quick view could otherwise be pointed at
// the LAN. Every hop of a redirect is checked.
const privateIp = (ip) => /^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|::$|f[cd]|fe80|::ffff:(?:127|10|192\.168|169\.254)\.)/i.test(ip);
export const publicUrl = async (u) => {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) return false;
  const h = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(?:localhost|.*\.local|.*\.internal|.*\.lan|.*\.home)$/i.test(h)) return false;
  try { const a = await lookup(h, { all: true }); return a.length > 0 && a.every((x) => !privateIp(x.address)); } catch { return false; }
};
const _qv = new Map();
const QV_UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" };
export const qvFor = async (u, check = publicUrl) => {
  const key = createHash("sha256").update(`qv\n${u}`).digest("hex").slice(0, 24);
  const hit = _qv.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  let v = null, at = u;
  for (let hop = 0; hop < 4; hop++) {
    if (!(await check(at))) { why("qv", "address not public (DNS)"); at = ""; break; }
    const r = await net(at, { timeout: 6000, max: 3_000_000, accept: "text/html,application/xhtml+xml", headers: QV_UA, redirect: "manual", imp: true });
    if (r.status >= 300 && r.status < 400 && r.location) { try { at = new URL(r.location, at).toString(); } catch { at = ""; break; } continue; }
    if (r.status === 200 && r.text) { v = qvFrom(r.text, at); why("qv", v ? `ok (${v.kind})` : "page has nothing to show"); }
    else why("qv", r.status >= 300 && r.status < 400 ? "redirect without address" : r.status ? `page http ${r.status}` : "no answer");
    break;
  }
  if (_qv.size > 300) _qv.clear();
  _qv.set(key, { t: v ? Date.now() : Date.now() - TTL + 600000, v });
  return v;
};

// ===== M6: product panel (⚑ 2026-11-28 "yamaha dbr10 release"): when the needs call rates a product panel, the
// top results' pages are read for schema.org Product data (+ og:/product: meta tags) and merged into one panel:
// name, picture, brand, price range across sellers, rating, key specs, release date. The maker's page leads.
const ldNum = (x) => { const n = Number(String(x == null ? "" : x).replace(/[^\d.]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
const metaTag = (html, k) => { const m = new RegExp(`<meta[^>]+(?:property|name)=["']${k.replace(/[.:]/g, "\\$&")}["'][^>]*>`, "i").exec(html); const c = m && /content=["']([^"']*)["']/i.exec(m[0]); return c ? ldStrip(c[1]) : ""; };
const ldImg = (x) => { const v = ld1(x); const u = typeof v === "string" ? v : v && (v.url || v.contentUrl || v["@id"]); return /^https?:\/\//.test(String(u || "")) ? String(u) : ""; };
// Offers of any shape (Offer, AggregateOffer with lowPrice/highPrice, nested offers, priceSpecification)
const ldOffers = (x, out = []) => {
  if (!x || out.length >= 40) return out;
  if (Array.isArray(x)) { x.forEach((o) => ldOffers(o, out)); return out; }
  if (typeof x !== "object") return out;
  const spec = ld1(x.priceSpecification) || {};
  const cur = String(x.priceCurrency || spec.priceCurrency || "").toUpperCase().slice(0, 3);
  const seller = ldTxt(x.seller, 60);
  for (const v of [x.price, spec.price, x.lowPrice, x.highPrice]) { const n = ldNum(v); if (n && cur) out.push({ p: n, cur, seller }); }
  if (x.offers) ldOffers(x.offers, out);
  return out;
};
// One page -> its product, or null: {name, brand, img, offers: [{p, cur, seller}], rating: {v, n}, specs: [[k, v]], rel, id}
export const productFrom = (html, url = "") => {
  const objs = ldObjects(html);
  const o = objs.find((x) => ldTypes(x).some((t) => /^(?:Product|ProductGroup|IndividualProduct|ProductModel|Vehicle|Car)$/.test(t)));
  const og = { name: metaTag(html, "og:title"), img: metaTag(html, "og:image"), price: metaTag(html, "product:price:amount") || metaTag(html, "og:price:amount"), cur: (metaTag(html, "product:price:currency") || metaTag(html, "og:price:currency")).toUpperCase().slice(0, 3), brand: metaTag(html, "product:brand") };
  const isProd = o || /product/i.test(metaTag(html, "og:type")) || (og.price && og.cur);
  if (!isProd) return null;
  const v = o || {};
  const offers = ldOffers(v.offers);
  if (!offers.length && og.price && og.cur && ldNum(og.price)) offers.push({ p: ldNum(og.price), cur: og.cur, seller: "" });
  const specs = [];
  for (const a of [].concat(v.additionalProperty || [])) { const k = ldTxt(a && a.name, 40), val = ldTxt(a && (a.value ?? a.description), 80); if (k && val && specs.length < 16) specs.push([k, a.unitText ? `${val} ${ldTxt(a.unitText, 12)}` : val]); }
  for (const [k, f] of [["Color", "color"], ["Model", "model"], ["Weight", "weight"], ["Material", "material"]]) { const val = ldTxt(v[f] && (ld1(v[f]).value ?? v[f]), 60); if (val && !specs.some(([a]) => a.toLowerCase() === k.toLowerCase())) specs.push([k, val]); }
  const name = ldTxt(v.name, 160) || og.name;
  if (!name) return null;
  let host = ""; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
  return { name, brand: ldTxt(v.brand || v.manufacturer, 60) || og.brand, img: ldImg(v.image) || (/^https?:\/\//.test(og.img) ? og.img : ""), offers, rating: ldRating(v), specs,
    rel: ldDay(v.releaseDate || v.productionDate), id: ldTxt(v.gtin13 || v.gtin12 || v.gtin || v.mpn || v.sku, 40), url, host };
};
const nameKey = (t) => String(t || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Merge the pages' products into one panel. score[i] = the AI's fit of page i's product name to the search (or null):
// the best-fitting product is the panel; another page joins it when it is the same product (same gtin/mpn, or every
// word of one name is in the other). The maker's own page (host carries the brand) leads name, picture, specs.
export const productMerge = (items, score = []) => {
  const xs = items.map((p, i) => p && { ...p, s: typeof score[i] === "number" ? score[i] : null }).filter(Boolean);
  if (!xs.length) return null;
  const best = xs.reduce((a, b) => ((b.s ?? -1) > (a.s ?? -1) ? b : a));
  // Same product: same gtin/mpn, or every word of the shorter name is in the longer one ("DBR10 Powered Speaker" in
  // "Yamaha DBR10 10\" Powered Speaker")
  const words = (t) => new Set(nameKey(t).split(" ").filter(Boolean)), w0 = words(best.name);
  const sub = (a, b) => a.size > 0 && [...a].every((w) => b.has(w));
  const same = xs.filter((p) => (best.id && p.id && p.id === best.id) || (() => { const w = words(p.name); return sub(w, w0) || sub(w0, w); })());
  const bk = nameKey(best.brand).split(" ")[0];
  const maker = bk && same.find((p) => p.host.replace(/[^a-z0-9]/g, "").includes(bk));
  const lead = maker || best;
  const offers = same.flatMap((p) => p.offers.map((o) => ({ ...o, host: p.host })));
  const curs = {}; offers.forEach((o) => { curs[o.cur] = (curs[o.cur] || 0) + 1; });
  const cur = Object.keys(curs).sort((a, b) => curs[b] - curs[a])[0];
  const ps = offers.filter((o) => o.cur === cur).map((o) => o.p).sort((a, b) => a - b);
  const sellers = new Set(offers.filter((o) => o.cur === cur).map((o) => o.seller || o.host));
  const rated = same.filter((p) => p.rating).sort((a, b) => (b.rating.n || 0) - (a.rating.n || 0))[0];
  const specs = [];
  for (const p of [lead, ...same.filter((x) => x !== lead)]) for (const [k, v] of p.specs) if (specs.length < 10 && !specs.some(([a]) => a.toLowerCase() === k.toLowerCase())) specs.push([k, v]);
  const rels = same.map((p) => p.rel).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { name: lead.name, brand: lead.brand || best.brand, img: lead.img || (same.find((p) => p.img) || {}).img || "", url: lead.url,
    price: ps.length ? { lo: ps[0], hi: ps[ps.length - 1], cur, sellers: sellers.size } : null, rating: rated ? rated.rating : null, specs, rel: rels[0] || "", from: same.map((p) => p.host) };
};
const PROD_HOPS = 4;
const pageHtml = async (u, check = publicUrl) => {
  let at = u;
  for (let hop = 0; hop < PROD_HOPS; hop++) {
    if (!(await check(at))) return null;
    const r = await net(at, { timeout: 4000, max: 3_000_000, accept: "text/html,application/xhtml+xml", headers: QV_UA, redirect: "manual", imp: true });
    if (r.status >= 300 && r.status < 400 && r.location) { try { at = new URL(r.location, at).toString(); } catch { return null; } continue; }
    return r.status === 200 && r.text ? { html: r.text, url: at } : null;
  }
  return null;
};
const _prod = new Map();
export const productFor = async (q, urls, check = publicUrl) => {
  const key = `${q.toLowerCase()}\n${urls.join("\n")}`;
  const hit = _prod.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const us = urls.filter((u) => { try { return !qvBlocked(new URL(u).hostname.replace(/^www\./, "")); } catch { return false; } }).slice(0, 6);
  const items = await Promise.all(us.map(async (u) => {
    const pg = await pageHtml(u, check).catch(() => null);
    let d = ""; try { d = new URL(u).hostname.replace(/^www\./, ""); } catch {}
    const p = pg ? productFrom(pg.html, pg.url) : null;
    if (d) qvCount(d, !!pg);
    return p;
  }));
  const got = items.filter(Boolean);
  let v = null;
  if (got.length) {
    // The AI rates each product's name against the search (same reranker pass as everything else); without it, the
    // first page's product leads
    const j = await vis("/rank", { q, docs: got.map((p) => [p.brand, p.name].filter(Boolean).join(" ")) }, 2000);
    v = productMerge(got, j && Array.isArray(j.s) ? j.s : got.map((_, i) => -i));
  }
  if (_prod.size > 300) _prod.clear();
  _prod.set(key, { t: v ? Date.now() : Date.now() - TTL + 600000, v });
  return v;
};

// Inline stars + time for first-screen recipe/review results (spec 11): "4.8 ★ · 45 min" from the same quick view.
// Asked by the page after the results are drawn, kept by the page for the next visit (never inserted late).
// Per-domain success counts (qv-domains.json: domain -> {ok, fail}) skip sites that block servers.
export const starLine = (v) => {
  if (!v) return "";
  const f = Object.fromEntries(v.facts);
  const r = f.Rating ? f.Rating.replace(/\s*\(.*\)$/, "") : "";
  return [r, v.kind === "recipe" ? f["Total time"] || "" : ""].filter(Boolean).join(" · ");
};
let _qd = null;
const qvDomains = () => { if (!_qd) { try { _qd = JSON.parse(fs.readFileSync(`${DIR}/qv-domains.json`, "utf8")) || {}; } catch { _qd = {}; } } return _qd; };
export const qvBlocked = (d) => { const c = qvDomains()[d]; return !!c && c.fail >= 3 && !c.ok; };
let _qdT = 0;
const qvCount = (d, ok) => {
  const m = qvDomains(), c = m[d] || (m[d] = { ok: 0, fail: 0 });
  if (ok) c.ok++; else c.fail++;
  const ks = Object.keys(m); if (ks.length > 2000) delete m[ks[0]];
  clearTimeout(_qdT); _qdT = setTimeout(() => { try { fs.writeFileSync(`${DIR}/qv-domains.json`, JSON.stringify(m)); } catch {} }, 2000);
};
export const starsFor = async (urls, check = publicUrl) => {
  const out = {};
  await Promise.all([...new Set(urls)].slice(0, 6).map(async (u) => {
    let d = "";
    try { d = new URL(u).hostname.replace(/^www\./, ""); } catch { return; }
    if (qvBlocked(d)) return;
    const v = await qvFor(u, check);
    qvCount(d, !!v);
    const line = starLine(v);
    if (line) out[u] = line;
  }));
  return out;
};

