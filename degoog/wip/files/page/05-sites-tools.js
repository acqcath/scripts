// ----- page/05-sites-tools.js: site choices menu, People also ask, Tools (advanced search) -----
// ===== Site choices, People also ask, and search Tools =====
const goTo = (text) => {
  const u = new URL(location.href);
  u.searchParams.set("q", text);
  for (const k of ["page", "ct_from", "ct_keep", "ct_acc"]) u.searchParams.delete(k);
  return u.toString();
};
const rowHost = (x) => { const w = x.querySelector(".result-actions"); return w ? w.dataset.host || "" : ""; };
// ===== Sites: Prefer / Normal / Lower / Hide, one rounded group in each result's menu (replaces Rank / Block) =====
// Stored in degoog's own block and score lists (core SITE_SCORE), through degoog's Settings routes with your
// Settings sign-in, so degoog applies them on the server on every tab. This browser keeps a read-only copy
// (ct-sites, refreshed from the server each page load) for the parts the page does: Prefer skips the 2-per-site limit.
const SITE_CHOICES = [["prefer", "Prefer"], ["normal", "Normal"], ["lower", "Lower"], ["hide", "Hide"]];
const siteOf = (host) => { const h = String(host || "").toLowerCase().replace(/^www\./, ""); return (h && CT.regDomain(h, PSL())) || h; };
const siteItems = (el) => {
  const menu = el.querySelector(".result-actions-menu");
  const host = rowHost(el);
  if (!menu || !host || menu.querySelector(".ct-seg")) return;
  const cur = SITES[siteOf(host)] || "normal";
  const seg = mk("div", "ct-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", `Results from ${siteOf(host)}`);
  for (const [v, label] of SITE_CHOICES) {
    const b = mk("button", "ct-seg-b", label);
    b.type = "button";
    b.dataset.ctSite = v;
    b.setAttribute("aria-pressed", String(v === cur));
    seg.append(b);
  }
  menu.prepend(seg);
  if (cur === "lower" && SITES_AUTO.includes(siteOf(host))) seg.after(mk("div", "ct-seg-note", "Lowered automatically (SEO signs). Your choice here wins."));
  // Quick view (spec 11) and archived copy (spec 10): nothing is asked until you tap them
  if (SHOW.qv !== false) {
    const qv = mk("button", "degoog-menu-item ct-arch ct-qv-b", "Quick view");
    qv.type = "button";
    qv.setAttribute("role", "menuitem");
    menu.append(qv);
  }
  if (SHOW.arch !== false) {
    const ar = mk("button", "degoog-menu-item ct-arch", "Open archived copy");
    ar.type = "button";
    ar.setAttribute("role", "menuitem");
    menu.append(ar);
  }
};
// Tap: a new tab opens at once (so the browser allows it) and goes to the copy the server found: archive.today first
// for paywalled sites, else the Wayback Machine, else Ghostarchive; none -> archive.today's save page
document.addEventListener("click", async (e) => {
  const b = e.target.closest && e.target.closest(".ct-arch:not(.ct-qv-b)");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const el = b.closest(".result-item");
  const a = el && el.querySelector("a.result-title");
  const u = (el && el.dataset.resultUrl) || (a && a.href) || "";
  if (!u) return;
  let pw = false;
  try { pw = CT.paywalled(new URL(u).hostname, PSL()); } catch {}
  const menu = b.closest(".result-actions-menu");
  if (menu) menu.hidden = true;
  const w = window.open("", "_blank");
  if (w) { try { w.opener = null; w.document.title = "Archived copy"; w.document.body.textContent = "Finding an archived copy…"; } catch {} }
  const j = await bridge("arch", { u, ...(pw ? { pw: 1 } : {}) }).catch(() => null);
  const to = (j && j.a && /^https:\/\//.test(j.a.url) && j.a.url) || `https://archive.ph/?url=${encodeURIComponent(u)}`;
  if (w && !w.closed) w.location.replace(to); else location.assign(to);
}, true);
const settingsFetch = (path, body) => {
  let tok = null;
  try { tok = sessionStorage.getItem("degoog-settings-token"); } catch {}
  const h = body ? { "Content-Type": "application/json" } : {};
  if (tok) h["x-settings-token"] = tok;
  return fetch(path, body ? { method: "POST", headers: h, credentials: "same-origin", body: JSON.stringify(body) } : { headers: h, credentials: "same-origin" });
};
// Returns "" when saved, else what to tell the user
const saveSite = async (site, pref) => {
  try {
    if (SITES[site] === "hide" && pref !== "hide") {
      const g = await settingsFetch("/api/settings/general");
      if (g.status === 401) return "Sign in to Settings first";
      if (!g.ok) return "Couldn't save";
      const j = await g.json();
      // degoog leaves a very long list out of this answer: writing it back would erase it
      if (j.degoogOversizedFields && j.degoogOversizedFields.domainBlockList) return "Block list too long: change it in Settings";
      const w = await settingsFetch("/api/settings/field", { key: "domainBlockList", value: CT.unblockText(j.domainBlockList || "", site) });
      if (!w.ok) return w.status === 401 ? "Sign in to Settings first" : "Couldn't save";
    }
    const r = await settingsFetch("/api/settings/domain-action", pref === "hide" ? { kind: "block", source: site } : { kind: "score", source: site, score: CT.SITE_SCORE[pref] });
    return r.ok ? "" : r.status === 401 ? "Sign in to Settings first" : "Couldn't save";
  } catch { return "Couldn't save"; }
};
document.addEventListener("click", async (e) => {
  const b = e.target.closest && e.target.closest(".ct-seg-b");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const wrap = b.closest(".result-actions"), menu = b.closest(".result-actions-menu"), seg = b.closest(".ct-seg");
  const site = siteOf(wrap ? wrap.dataset.host : ""), pref = b.dataset.ctSite;
  if (!site || !seg || seg.dataset.busy) return;
  seg.dataset.busy = "1";
  const msg = await saveSite(site, pref);
  delete seg.dataset.busy;
  // Problem: said inside the menu, which stays open (fixed-height line, so the menu doesn't change size twice)
  let note = menu && menu.querySelector(".ct-seg-note");
  if (msg) { if (!note && menu) { note = mk("div", "ct-seg-note"); seg.after(note); } if (note) note.textContent = msg; return; }
  if (note) note.remove();
  if (pref === "normal") delete SITES[site]; else SITES[site] = pref;
  saveSites();
  // The server reads the lists again, so the Settings list shows this choice too
  bridge("sites", {}).then(takeSites).catch(() => {});
  if (menu) menu.hidden = true;
  const tg = wrap && wrap.querySelector(".result-actions-toggle");
  if (tg) tg.setAttribute("aria-expanded", "false");
  document.querySelectorAll(".ct-seg").forEach((g) => { const h = g.closest(".result-actions"); if (h && siteOf(h.dataset.host) === site) g.querySelectorAll(".ct-seg-b").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.ctSite === pref))); });
  // Your tap, so this page follows at once: Hide takes that site's results away, Prefer moves them up, Lower down
  const list = document.getElementById("results-list");
  if (!list || pref === "normal") return;
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => siteOf(rowHost(x)) === site);
  if (pref === "hide") rows.forEach((x) => { x.style.display = "none"; x.dataset.ctHide = "1"; });
  else if (pref === "prefer") { const kpEl = [...list.children].find((x) => x.classList.contains("ct-kp")); if (kpEl) kpEl.after(...rows); else list.prepend(...rows); }
  else list.append(...rows);
}, true);

// People also ask, after the 3rd result: tap a question to see the best answer degoog finds for it
let paaFor = "";
// 3rd visible result right now (degoog can redraw the list after People also ask was requested)
const paaAnchor = () => [...(document.getElementById("results-list")?.querySelectorAll(".result-item, .ct-grp") || [])].filter((x) => x.style.display !== "none" && !x.classList.contains("ct-grouped"))[2];
let paaBox = null;

const paa = () => {
  if (!webTab) return;
  if (paaFor === searchId()) {
    // list was redrawn and took the box with it: put it back
    if (paaBox && !paaBox.isConnected) paaAnchor()?.after(paaBox);
    return;
  }
  const list = document.getElementById("results-list");
  if (!list) return;
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none");
  if (rows.length < 4) return;
  const key = (paaFor = searchId());
  let q = "", page = 1;
  try { const u = new URL(key); q = (u.searchParams.get("q") || "").trim(); page = Number(u.searchParams.get("page") || 1); } catch {}
  const old = document.getElementById("ct-qa");
  if (old) old.remove();
  paaBox = null;
  if (!q || page > 1 || q.startsWith("!") || shaped(q)) return;
  ((j) => {
      // Not in hand when the results came (or none): dropped for this search
      if (!j || !Array.isArray(j.q)) return;
      if (j.q.length < 2) return;
      const box = document.createElement("div");
      box.id = "ct-qa";
      const h = document.createElement("h3");
      h.textContent = "People also ask";
      box.append(h);
      // Words written the way your results write them ("putty" -> "PuTTY", "paris" -> "Paris"): a form with capitals
      // inside it (PuTTY, iPhone, NASA) from titles or text, or a capitalised word the result text writes that way
      // mid-sentence most of the time (names); title case ("Day Old Tea") never counts
      const cased = new Map(), mid = new Map();
      const add = (m, k, w) => { const x = m.get(k) || new Map(); x.set(w, (x.get(w) || 0) + 1); m.set(k, x); };
      // ALL-CAPS in a title is shouting ("WHY - English meaning"), not how the word is spelled: titles teach only
      // mixed forms (PuTTY, iPhone); acronyms (NASA) are learned from the descriptions
      for (const r of document.querySelectorAll("#results-list .result-item :is(.result-title, .result-snippet)")) { const ttl = r.classList.contains("result-title"); for (const w of r.textContent.match(/[\p{L}\p{N}][\p{L}\p{N}'+.#-]*/gu) || []) if (/\p{Lu}/u.test(w.slice(1)) && !(ttl && w === w.toUpperCase())) add(cased, w.toLowerCase(), w); }
      for (const r of document.querySelectorAll("#results-list .result-item .result-snippet")) {
        const toks = r.textContent.split(/\s+/);
        for (let i = 1; i < toks.length; i++) { const w = toks[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""); if (w && !/[.!?:…]$/.test(toks[i - 1])) add(mid, w.toLowerCase(), w); }
      }
      const pick = (k) => {
        const c = cased.get(k);
        if (c) return [...c].sort((a, b) => b[1] - a[1])[0][0];
        const m = mid.get(k);
        if (!m) return null;
        const up = [...m].filter(([w]) => /^\p{Lu}/u.test(w)).reduce((n, [, v]) => n + v, 0), all = [...m].reduce((n, [, v]) => n + v, 0);
        return up >= 2 && up * 3 >= all * 2 ? k[0].toUpperCase() + k.slice(1) : null;
      };
      const fixCase = (t) => t.replace(/[\p{L}\p{N}][\p{L}\p{N}'+.#-]*/gu, (w, i) => {
        const k = w.toLowerCase(), m = mid.get(k);
        const lowMostly = m && [...m].filter(([x]) => x === k).reduce((n, [, v]) => n + v, 0) * 2 > [...m].reduce((n, [, v]) => n + v, 0);
        const best = pick(k) || (lowMostly ? k : w); // no evidence either way: as the suggestion wrote it
        if (i === 0 && CT.QA_LEAD.test(k)) return k[0].toUpperCase() + k.slice(1); // "Why", never "WHY"
        return i === 0 ? best[0].toUpperCase() + best.slice(1) : best;
      });
      // Answers are fetched as the box comes near the screen, so a tap shows one at once; a question no page answers
      // is taken out before you get to it (no "Search for" stand-ins); fewer than 2 left: no box
      const ans = new Map();
      // The answer: of the question's top 8 results, the passage the answer AI (a reranker on the PC's GPU) says answers it
      // best; too weak an answer = no answer. Without the AI: the first result with a description.
      const get = (text) => ans.get(text) || ans.set(text, fetch(`/api/search?q=${encodeURIComponent(text)}`).then((r) => (r.ok ? r.json() : null))
        .then(async (sj) => {
          // Only results about the question's own words ("nose", "dry"), not just its question word ("why")
          const c = (sj && Array.isArray(sj.results) ? sj.results : []).filter((x) => x && x.url && x.snippet).slice(0, 8).filter((x) => CT.qaAbout(text, `${x.title || ""} ${x.snippet}`));
          if (!c.length) return null;
          const strip = (t) => String(t || "").replace(/<[^>]+>/g, "").trim();
          const j = await bridge("rank", {}, JSON.stringify({ q: text, d: c.map((x) => `${strip(x.title)}. ${strip(x.snippet)}`) })).catch(() => null);
          if (!j || !Array.isArray(j.s)) return c[0];
          let bi = -1;
          j.s.forEach((v, i) => { if (typeof v === "number" && (bi < 0 || v > j.s[bi])) bi = i; });
          return bi >= 0 && j.s[bi] >= 0.02 ? c[bi] : null; // the best of them unless none is about the question at all
        }).catch(() => null)).get(text);
      // One page answers one question: a page already answering another question isn't repeated under this one
      const used = new Map();
      const own = (text) => (top) => { if (!top) return null; const u = used.get(top.url); if (u && u !== text) return null; used.set(top.url, text); return top; };
      const drop = (d) => { d.remove(); if (box.querySelectorAll("details").length < 2) { box.remove(); if (paaBox === box) paaBox = null; } }; // gone for good (not put back after a redraw)
      const items = [];
      for (const raw of j.q) {
        const text = fixCase(raw);
        const d = document.createElement("details");
        const s = document.createElement("summary");
        s.textContent = text;
        const body = document.createElement("div");
        body.className = "ct-qa-a";
        d.append(s, body);
        items.push([d, text]);
        d.addEventListener("toggle", () => {
          if (!d.open || body.dataset.done) return;
          body.dataset.done = "1";
          body.textContent = "Loading…";
          get(text).then(own(text)).then((top) => {
            body.textContent = "";
            if (!top) { drop(d); return; }
            // Same order and look as a result: answer, then site icon + name, then the page title
            const p = document.createElement("p");
            p.className = "ct-qa-text";
            let t = String(top.snippet).replace(/<[^>]+>/g, "").trim();
            const dm = /^([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\s*(?:\.\.\.|…|·|-|—)\s*/.exec(t);
            if (dm) { t = t.slice(dm[0].length); const ds = document.createElement("span"); ds.className = "result-date"; ds.textContent = `${dm[1]} · `; p.append(ds); }
            p.append(t);
            const row = document.createElement("div");
            row.className = "ct-qa-site";
            let host = "";
            try { host = new URL(top.url).hostname.replace(/^www\./, ""); } catch {}
            if (top.favicon) { const ic = document.createElement("img"); ic.src = top.favicon; ic.alt = ""; ic.onerror = () => ic.remove(); row.append(ic); }
            const cite = document.createElement("cite");
            cite.textContent = host;
            row.append(cite);
            const a = document.createElement("a");
            a.className = "ct-qa-src";
            a.href = top.url;
            a.textContent = cleanTitle(top.title || top.url, top.url);
            body.append(p, row, a);
          });
        });
        box.append(d);
      }
      const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        for (const [d, text] of items) get(text).then(own(text)).then((top) => { if (!top && !d.open) drop(d); });
      }, { rootMargin: "600px 0px" }) : null;
      if (io) io.observe(box);
      paaBox = fadeIn(box);
      paaAnchor()?.after(box);
    })(ready("qs", key));
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
    if (f) { f.remove(); t.setAttribute("aria-expanded", "false"); topGap(); return; }
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
    topGap();
    if (!TOUCH.matches) f.elements.all.focus();
  });
};


