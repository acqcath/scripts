// ----- server/06-seo.js: anti-SEO auto-Lower -----
// ===== Anti-SEO auto-Lower =====
// Each search's first page sends its signs (core seoSigns: copies, SEO-bait wording, stale "best 20XX" lists, AI
// tells, essay-writing services). Per site: searches it was in, and how many of those showed a sign. A site with
// signs on most of at least SEO_MIN searches is set to Lower in degoog's score list, marked auto. Only Lower, ever.
// A site you've set yourself is never counted, and changing an auto one yourself stops auto for it for good.
// Kept in sites-auto.json here: site names and two counts, nothing about the searches.
const SEO_MIN = 5;
let SEO_ON = true;
const autoFile = () => `${DIR}/sites-auto.json`;
let AUTO = null;
const readAuto = () => { if (AUTO) return AUTO; try { const j = JSON.parse(fs.readFileSync(autoFile(), "utf8")); AUTO = j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { AUTO = {}; } return AUTO; };
const autoList = () => Object.keys(readAuto()).filter((d) => AUTO[d].auto && !AUTO[d].off).sort();
let _seoHour = 0, _seoCount = 0;
export const seoReport = (raw) => queueSites(async () => {
  if (!SEO_ON) return;
  // At most 300 reports an hour (the bridge needs no sign-in)
  const hr = Math.floor(Date.now() / 3600000);
  if (hr !== _seoHour) { _seoHour = hr; _seoCount = 0; }
  if (++_seoCount > 300) return;
  let j = {};
  try { j = JSON.parse(raw); } catch { return; }
  const seen = (Array.isArray(j.seen) ? j.seen : []).map((d) => String(d).toLowerCase()).filter((d) => plainHost(d) && d.length < 100).slice(0, 60);
  const hit = j.hit && typeof j.hit === "object" ? j.hit : {};
  const dg = await degoog();
  let lists = null;
  try { lists = dg ? await dg.readDomainLists() : null; } catch {}
  const mine = lists ? sitesFromLists(lists.domainBlockList, lists.domainScoreList) : {};
  const A = readAuto(), lower = [];
  for (const d of new Set(seen)) {
    const t = (A[d] ||= { seen: 0, hits: 0 });
    if (t.off) continue;
    if (t.auto) { if (lists && mine[d] !== "lower") t.off = true; continue; } // you changed it: auto stops
    if (mine[d]) continue; // your own choice: not counted
    t.seen++;
    if (Array.isArray(hit[d]) && hit[d].length) t.hits++;
    if (t.seen >= SEO_MIN && t.hits * 2 > t.seen) lower.push(d);
  }
  if (lower.length && dg && lists) {
    const delta = Object.fromEntries(lower.map((d) => [d, "lower"]));
    const next = applySites(lists.domainBlockList, lists.domainScoreList, delta);
    await dg.writeDomainList("domainScoreList", next.score);
    for (const d of lower) A[d].auto = true;
  }
  // Sites seen once and clean are dropped after 5,000 entries, so the file stays small
  const keys = Object.keys(A);
  if (keys.length > 5000) for (const d of keys) if (!A[d].auto && !A[d].off && A[d].hits === 0 && A[d].seen <= 1) delete A[d];
  fs.writeFileSync(autoFile(), JSON.stringify(A));
  if (lower.length) { const now = await dg.readDomainLists(); await showSites(dg, sitesFromLists(now.domainBlockList, now.domainScoreList)); }
});
