// ----- server/09-flags.js: ⚑ flags: storage, prompt, the local model's send verdict -----
// The reports a release fixed, {flag id: version}: files/fixed.json, built in by build.py (CT_FIXED)
// ===== ⚑ Flags: "what's wrong with these results?" from the ⚑ in the tab row =====
// Save in the ⚑ box keeps each flag (the search, the tab, your note, its top 10 results) in flags.json on this
// server only. The PC's watcher sends what's waiting as soon as a ⚑ is saved, in one prompt (flagPrompt), plus the
// updater's last problem (update-issue.txt).
const flagsFile = () => `${DIR}/flags.json`, issueFile = () => `${DIR}/update-issue.txt`;
// The installer's last "install timing (s)" line (written by ../install.ps1 after its self-check), shown in status and reports
const installTiming = () => { try { return fs.readFileSync(`${DIR}/install-timing.txt`, "utf8").trim().slice(0, 300); } catch { return ""; } };
let FLAGS = null;
const readFlags = () => { if (FLAGS) return FLAGS; try { const j = JSON.parse(fs.readFileSync(flagsFile(), "utf8")); FLAGS = j && Array.isArray(j.list) ? j : { list: [], issueAt: 0 }; } catch { FLAGS = { list: [], issueAt: 0 }; } return FLAGS; };
const saveFlags = () => { try { fs.writeFileSync(`${flagsFile()}.tmp`, JSON.stringify(FLAGS)); fs.renameSync(`${flagsFile()}.tmp`, flagsFile()); } catch {} };
const flagIssue = () => { try { const st = fs.statSync(issueFile()); const t = st.mtimeMs; const text = fs.readFileSync(issueFile(), "utf8").trim(); return text && t > (readFlags().issueAt || 0) ? { t, text: text.slice(-3000) } : null; } catch { return null; } };
const flagOpen = () => readFlags().list.filter((f) => !f.handed);
// The ⚑ chips' ids (same list as core.js FLAG_CATS, which draws them: test/flag.test.js checks they agree)
export const FLAG_CATS = [["offtopic", "Off-topic"], ["spam", "Spam / junk"], ["missing", "Missing what I wanted"], ["outdated", "Outdated"],
  ["order", "Wrong order"], ["layout", "Layout looks off"], ["broken", "Something's broken or slow"]];
export const flagCats = (a) => { const ok = new Set(FLAG_CATS.map((c) => c[0])); return [...new Set((Array.isArray(a) ? a : []).map(String))].filter((c) => ok.has(c)); };
// Context sent with each flag, clipped to sane sizes: {vw, vh, dpr, phone, load: {name: ms}, boxes: [{box, n}],
// passes: {page pass: ms on this search}, batches: observer runs}
export const flagCtxClean = (c) => {
  if (!c || typeof c !== "object") return null;
  const num = (v, max = 1e6) => (Number.isFinite(+v) ? Math.max(0, Math.min(max, Math.round(+v))) : null);
  const load = {};
  for (const [k, v] of Object.entries(c.load && typeof c.load === "object" ? c.load : {}).slice(0, 12)) { const n = num(v, 600000); if (n !== null) load[String(k).slice(0, 40)] = n; }
  const boxes = (Array.isArray(c.boxes) ? c.boxes : []).slice(0, 30).map((b) => ({ box: String((b && b.box) || "").slice(0, 60), n: num(b && b.n, 999) || 1 })).filter((b) => b.box);
  const passes = {};
  for (const [k, v] of Object.entries(c.passes && typeof c.passes === "object" ? c.passes : {}).slice(0, 8)) { const n = num(v, 600000); if (n !== null) passes[String(k).slice(0, 20)] = n; }
  return { ver: String(c.ver || "").slice(0, 20), vw: num(c.vw, 10000), vh: num(c.vh, 10000), dpr: Number.isFinite(+c.dpr) ? Math.round(+c.dpr * 100) / 100 : null, phone: !!c.phone, load, boxes, passes, batches: num(c.batches, 1e6) };
};

// The prompt the PC job sends into the reports session (its link fits about 14,000 characters: snippets are dropped
// first, then the oldest waiting flags; the newest flag always stays)
export const flagPrompt = (flags, issue, max = 12000) => {
  const head = "degoog clean-titles: fix what my degoog reported. Read degoog/wip/QUICKSTART.md in acqcath/scripts first and follow its \"Flags\" steps: " +
    "fix the code so the searches below come out right, add tests, release and merge. " +
    "Put the id of every report the release fixes in degoog/wip/files/fixed.json (id: version), so my degoog tells me once it is in. " +
    "Keep my searches out of the public repo.\n";
  const body = (fl, snip) => JSON.stringify({ flags: fl.map((f) => ({ id: f.id, at: new Date(f.t).toISOString(), q: f.q, tab: f.type, cats: f.cats || [], note: f.note, ctx: f.ctx || null, top: (f.top || []).map((r) => (snip ? { ai: r.ai ?? null, title: r.title, url: r.url, snippet: r.snippet } : { ai: r.ai ?? null, title: r.title, url: r.url })) })), updateIssue: issue || null });
  let fl = (flags || []).slice(-20);
  for (;;) {
    for (const snip of [true, false]) { const s = head + body(fl, snip); if (s.length <= max || fl.length <= 1) { if (s.length <= max || !snip) return s.slice(0, max); } }
    if (fl.length <= 1) return (head + body(fl, false)).slice(0, max);
    fl = fl.slice(1);
  }
};
// The model ai-summary is set to (on this PC, free), called through ai-summary's own provider code, so every
// provider it supports works here with its URL, key and model. null when ai-summary isn't installed or has no model.
const aiAsk = async (messages, maxTokens = 1500) => {
  const data = process.env.DEGOOG_DATA_DIR || `${process.cwd()}/data`;
  let all = {};
  try { all = JSON.parse(fs.readFileSync(process.env.DEGOOG_PLUGIN_SETTINGS_FILE || `${data}/plugin-settings.json`, "utf8")) || {}; } catch { return null; }
  const k = Object.keys(all).find((x) => x.toLowerCase() === "ai-summary-slot") || Object.keys(all).find((x) => /ai-summary/i.test(x));
  const raw = k && all[k];
  if (!raw || !String(raw.model || "").trim()) return null;
  const root = DIR.replace(/\/[^/]+\/?$/, "");
  let dir = "";
  try { dir = fs.readdirSync(root).find((d) => /ai-summary/i.test(d) && fs.existsSync(`${root}/${d}/providers/index.js`) && fs.existsSync(`${root}/${d}/src/settings.js`)) || ""; } catch {}
  if (!dir) return null;
  let P, S;
  try { P = await import(`${root}/${dir}/providers/index.js`); S = await import(`${root}/${dir}/src/settings.js`); } catch { return null; }
  if (typeof P.pickAdapter !== "function" || typeof S.parseSettings !== "function") return null;
  const st = S.parseSettings(raw);
  const ad = P.pickAdapter(st.provider, st.openAICompatProvider);
  const ab = new AbortController();
  const t = setTimeout(() => ab.abort(), 90000);
  let out = "";
  try {
    for await (const ch of ad.stream({ baseUrl: st.baseUrl, model: st.model, apiKey: st.apiKey, extraHeaders: st.extraHeaders, sessionId: "degoog-ctflag" }, messages, { maxTokens, disableThinking: true, tokenParam: st.tokenParam, signal: ab.signal })) {
      if (ch.kind === "text") out += ch.text;
      else if (ch.kind === "error") return null;
    }
  } catch { return null; } finally { clearTimeout(t); }
  return out;
};
const flagCount = () => flagOpen().length + (flagIssue() ? 1 : 0);
// ===== Sending at once, "fixed" once, and what the PC's watcher sleeps on =====
// Sent as soon as anything waits: a ⚑ (the user's explicit ask) or the updater's last problem
export const flagDue = (open, issue) => !!issue || open.length > 0;
// Reports fixed by the installed version that haven't been told yet: told once, on whichever device opens degoog
// first (the server marks them, so the phone seeing it means the PC doesn't). -> [{ver, what}]
export const fixedNews = (list, fixed, now = Date.now()) => {
  const out = [];
  for (const f of list || []) {
    const ver = fixed && fixed[String(f.id)];
    if (!ver || f.told) continue;
    f.told = now; f.fixed = ver; f.handed = f.handed || now;
    out.push({ ver, what: (f.note || `"${f.q}"`).replace(/\s+/g, " ").trim().slice(0, 140) });
  }
  return out;
};
// pc.json, which the PC's watcher (../autoupdate-job.ps1 $watcher, through ct-wait.js inside this container) sleeps
// on: rev = what's waiting to be sent (changes with each new ⚑ or update problem; "" = nothing), last = when the last
// search ran, so an update never restarts degoog in the middle of a search
let LAST_SEARCH = 0, _pcT = null, _pcAt = 0;
const pcWrite = () => {
  const open = flagOpen(), i = flagIssue();
  const rev = flagDue(open, i) ? `${open.length ? Math.max(...open.map((f) => f.id)) : 0}|${i ? i.t : 0}` : "";
  const j = JSON.stringify({ rev, last: LAST_SEARCH });
  try { fs.writeFileSync(`${DIR}/pc.json.tmp`, j); fs.renameSync(`${DIR}/pc.json.tmp`, `${DIR}/pc.json`); } catch {}
  for (const c of PC_SOCKS) { try { c.write(j + "\n"); } catch {} }
  _pcAt = Date.now();
};
// ...and the same line pushed at once to ct-wait.js over a socket in the container's /tmp (a file change alone may not
// wake it on every kind of Docker volume)
export const PC_SOCK = "/tmp/ct-pc.sock";
const PC_SOCKS = new Set();
const pcListen = () => {
  try { fs.unlinkSync(PC_SOCK); } catch {}
  try {
    const srv = netServer((c) => { PC_SOCKS.add(c); c.on("close", () => PC_SOCKS.delete(c)); c.on("error", () => PC_SOCKS.delete(c)); });
    srv.on("error", () => {});
    srv.listen(PC_SOCK);
    if (srv.unref) srv.unref();
  } catch {}
};
// Each search or page call (degoog in use): written at most every 5 s, the last one always (a trailing write)
const searchSeen = () => {
  LAST_SEARCH = Date.now();
  if (Date.now() - _pcAt >= 5000) return pcWrite();
  if (!_pcT) { _pcT = setTimeout(() => { _pcT = null; pcWrite(); }, 5000); if (_pcT.unref) _pcT.unref(); }
};
