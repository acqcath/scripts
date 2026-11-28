// ----- server/05-sports.js: sports card (ESPN) and whether ai-summary will answer -----
// ===== Sports (ESPN's public site API): a team's live, last or next game =====
// Team names come from ESPN's team lists (fetched once a day, only when a short search could be a team), so the
// search itself never leaves this server; a match costs one schedule request (RAM 60 s while live, else 10 min).
const ESPN = "https://site.api.espn.com/apis/site/v2/sports";
const LEAGUES = [["football/nfl", "NFL"], ["basketball/nba", "NBA"], ["baseball/mlb", "MLB"], ["hockey/nhl", "NHL"]];
let _teams = { t: 0, list: [] };
const normT = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
export const espnTeams = (j, league, tag) => {
  const ts = j && j.sports && j.sports[0] && j.sports[0].leagues && j.sports[0].leagues[0] && j.sports[0].leagues[0].teams;
  return (Array.isArray(ts) ? ts : []).map((x) => x && x.team).filter((t) => t && t.id && t.displayName)
    .map((t) => ({ id: String(t.id), league, tag, abbr: String(t.abbreviation || ""), name: String(t.displayName), nick: String(t.name || t.shortDisplayName || ""), place: String(t.location || "") }));
};
const teamsList = async () => {
  if (_teams.list.length && Date.now() - _teams.t < 86400000) return _teams.list;
  const all = await Promise.all(LEAGUES.map(async ([l, tag]) => { const r = await net(`${ESPN}/${l}/teams`, { timeout: 4000, max: 3_000_000, accept: "application/json", headers: QV_UA, imp: true }); if (r.status !== 200) teamsList.last = r.status ? `http ${r.status}` : "no answer"; try { return r.status === 200 ? espnTeams(JSON.parse(r.text), l, tag) : []; } catch { teamsList.last = "not JSON"; return []; } }));
  const list = all.flat();
  _teams = { t: list.length ? Date.now() : Date.now() - 86400000 + 600000, list: list.length ? list : _teams.list };
  return _teams.list;
};
// "steelers", "pittsburgh steelers score", "steelers game", "lakers last night", "penguins nhl" -> one team, or null
export const teamFor = (q, list) => {
  let s = normT(q).replace(/\b(score|scores|game|games|schedule|result|results|today|tonight|last night|yesterday|next game|live)\b/g, " ").replace(/\s+/g, " ").trim();
  const lg = /\b(nfl|nba|mlb|nhl)\b/.exec(s);
  if (lg) s = s.replace(lg[0], "").trim();
  if (!s || s.split(" ").length > 4) return null;
  const hits = list.filter((t) => (!lg || t.tag.toLowerCase() === lg[1]) && [t.name, t.nick, `${t.place} ${t.nick}`].map(normT).includes(s));
  return hits.length === 1 ? hits[0] : null;
};
const scoreOf = (c) => (c && c.score != null ? (typeof c.score === "object" ? String(c.score.displayValue ?? c.score.value ?? "") : String(c.score)) : "");
// One schedule event -> the card's data
export const espnGame = (ev, sign) => {
  const comp = ev && Array.isArray(ev.competitions) && ev.competitions[0];
  if (!comp || !Array.isArray(comp.competitors) || comp.competitors.length !== 2) return null;
  const st = (comp.status || ev.status || {}).type || {};
  const side = (c) => ({ abbr: String((c.team && c.team.abbreviation) || ""), name: String((c.team && (c.team.shortDisplayName || c.team.displayName)) || ""), logo: (() => { const t = c.team || {}; const l = t.logo || (Array.isArray(t.logos) && t.logos[0] && t.logos[0].href) || ""; return l && sign ? sign(l) : ""; })(), score: scoreOf(c), winner: c.winner === true, record: Array.isArray(c.record) ? String((c.record[0] && (c.record[0].displayValue || c.record[0].summary)) || "") : Array.isArray(c.records) ? String((c.records[0] && c.records[0].summary) || "") : "", home: c.homeAway === "home" });
  const [a, b] = comp.competitors.map(side);
  return { state: String(st.state || ""), detail: String(st.shortDetail || st.detail || ""), date: String(ev.date || comp.date || ""), away: a.home ? b : a, home: a.home ? a : b };
};
// Live game first; else the last game if it ended within 2 days; else the next one; else the last one
export const pickGame = (events, now = Date.now()) => {
  const evs = (Array.isArray(events) ? events : []).map((e) => ({ e, st: ((((e.competitions || [])[0] || {}).status || e.status || {}).type || {}).state, t: Date.parse(e.date) })).filter((x) => Number.isFinite(x.t));
  const live = evs.find((x) => x.st === "in");
  if (live) return live.e;
  const past = evs.filter((x) => x.st === "post").sort((a, b) => b.t - a.t)[0];
  const next = evs.filter((x) => x.st === "pre" && x.t >= now - 6 * 3600000).sort((a, b) => a.t - b.t)[0];
  if (past && now - past.t < 2 * 86400000) return past.e;
  return (next || past || {}).e || null;
};
const _games = new Map();
export const sportsFor = async (q, now = Date.now()) => {
  const words = normT(q);
  if (!words || words.split(" ").length > 6) return null;
  const list = await teamsList();
  if (!list.length) return why("sports", `ESPN team lists ${teamsList.last || "empty"}`);
  const t = teamFor(words, list);
  if (!t) return why("sports", "no single team matched");
  const hit = _games.get(t.id + t.league);
  if (hit && now - hit.t < (hit.v && hit.v.state === "in" ? 60000 : 600000)) return hit.v;
  const r = await net(`${ESPN}/${t.league}/teams/${t.id}/schedule`, { timeout: 4000, max: 5_000_000, accept: "application/json", headers: QV_UA, imp: true });
  let v = null;
  try {
    const evs = r.status === 200 ? JSON.parse(r.text).events : null;
    const ev = evs ? pickGame(evs, now) : null;
    const g = ev && espnGame(ev, _sign);
    if (g) v = { ...g, league: t.tag, team: t.abbr };
    why("sports", r.status !== 200 ? `ESPN schedule ${r.status ? `http ${r.status}` : "no answer"}` : !Array.isArray(evs) ? "schedule has no events list" : !ev ? `no game among ${evs.length} events` : !g ? "game has no two teams" : !(g.away.logo || g.home.logo) ? (_sign ? "no team logos" : "no image signer") : "ok");
  } catch (e) { why("sports", `error: ${String(e && e.message || e).slice(0, 80)}`); }
  _games.set(t.id + t.league, { t: now, v });
  return v;
};

// ===== Will ai-summary answer? (so the page reserves its spot only when the summary is sure to come) =====
// Mirrors its slot trigger(): a model is set, it isn't switched off, and "only for questions" (a search ending in
// "?") if that's on. Read from degoog's plugin-settings.json; only these two yes/no values leave the server.
export const aiStatus = (data) => {
  try {
    const all = JSON.parse(fs.readFileSync(process.env.DEGOOG_PLUGIN_SETTINGS_FILE || `${data}/plugin-settings.json`, "utf8"));
    const a = all && all["ai-summary-slot"];
    const yes = (v) => v === true || v === "true";
    if (!a || !String(a.model || "").trim() || yes(a.disabled)) return { on: false };
    return { on: true, qmark: yes(a.questionMarkOnly) };
  } catch { return { on: false }; }
};

