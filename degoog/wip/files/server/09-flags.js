// ----- server/09-flags.js: ⚑ flags: storage, prompt, the local model's send verdict -----
// ===== ⚑ Flags: "what's wrong with these results?" from the ⚑ in the tab row =====
// Save in the ⚑ box keeps each flag (the search, the tab, your note, its top 10 results) in flags.json on this
// server only. The local model (flagJudge) decides when what's waiting is worth a Claude session; the PC's hourly job
// then sends it all in one (flagPrompt), plus the updater's last problem (update-issue.txt, sent at once).
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
    "Keep my searches out of the public repo.\n";
  const body = (fl, snip) => JSON.stringify({ flags: fl.map((f) => ({ at: new Date(f.t).toISOString(), q: f.q, tab: f.type, cats: f.cats || [], note: f.note, ctx: f.ctx || null, top: (f.top || []).map((r) => (snip ? { ai: r.ai ?? null, title: r.title, url: r.url, snippet: r.snippet } : { ai: r.ai ?? null, title: r.title, url: r.url })) })), updateIssue: issue || null });
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
// Is what's waiting worth a Claude session (which uses the user's weekly Claude usage)? The local model decides once
// per new set of reports; the PC's hourly job sends only on yes (or at once for an update breakage).
const JUDGE_SYS = "You decide whether a batch of user reports about their self-hosted search engine is worth sending to an expensive " +
  "coding assistant now, which uses up the user's limited weekly usage. Say send when the reports show real problems a code " +
  "change would fix (wrong, junk, missing or badly ordered results; a broken feature) and together they are enough work to " +
  "justify one session: several reports, or one serious or clearly systematic problem. Say wait when they are few and minor, " +
  "vague, or about one-off content no rule could fix, so more reports can join the batch. Reply with JSON only: " +
  '{"send": true or false, "why": "one short plain sentence for the user"}.';
export const judgeParse = (txt) => {
  const m = /\{[\s\S]*\}/.exec(String(txt || ""));
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return typeof j.send === "boolean" ? { send: j.send, why: String(j.why || "").replace(/\s+/g, " ").trim().slice(0, 200) } : null; } catch { return null; }
};
const flagHost = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
let _judging = null;
const flagJudge = () => (_judging ||= (async () => {
  const F = readFlags(), open = flagOpen();
  const key = open.map((f) => f.id).join(",");
  if (!open.length) return { send: false, why: "" };
  if (F.judge && F.judge.key === key) return F.judge;
  const list = open.map((f, i) => `${i + 1}. [${f.type}] "${f.q}"${(f.cats || []).length ? ` problems: ${f.cats.join(", ")}` : ""}${f.note ? ` note: ${f.note}` : " (no note)"}; top results: ${f.top.slice(0, 3).map((r) => `${flagHost(r.url)}: ${r.title}`).join(" | ")}`).join("\n");
  const v = judgeParse(await aiAsk([{ role: "system", content: JUDGE_SYS }, { role: "user", content: `Waiting reports (${open.length}):\n${list}` }]));
  F.judge = { key, send: v ? v.send : false, why: v ? v.why : "No local model answered (ai-summary's model), so these wait.", at: Date.now() };
  saveFlags();
  return F.judge;
})().finally(() => { _judging = null; }));
const judgeNow = () => { const F = readFlags(), key = flagOpen().map((f) => f.id).join(","); return F.judge && F.judge.key === key ? F.judge : null; };
const flagCount = () => flagOpen().length + (flagIssue() ? 1 : 0);

