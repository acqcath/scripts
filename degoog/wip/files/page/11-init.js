// ----- page/11-init.js: tab row repair, init (the one observer pass), load timing, DuckDuckGo once -----
const tabKind = (t) => { const d = t.dataset.type || ""; return d.startsWith("tab:engine:") ? d.slice(11) : d.startsWith("tab:") ? d.slice(4) : d; };
const tabKeep = () => {
  const row = document.getElementById("results-tabs");
  if (!row) return;
  const tabs = [...row.children].filter((t) => t.classList.contains("results-tab"));
  if (!tabs.length) return;
  const seen = new Map();
  for (const t of tabs) {
    const k = tabKind(t), had = seen.get(k);
    if (!had) { seen.set(k, t); continue; }
    if (t.classList.contains("active") && !had.classList.contains("active")) { had.remove(); seen.set(k, t); } else t.remove();
  }
  const act = [...seen.values()].filter((t) => t.classList.contains("active"));
  if (act.length === 1 && act[0].style.display !== "none") tabNow = tabKind(act[0]);
  else {
    let want = tabNow;
    try { want = want || new URL(location.href).searchParams.get("type") || ""; } catch {}
    if (!want && document.getElementById("results-layout")?.classList.contains("media-mode")) want = "images";
    want = want || "web";
    if (seen.has(want)) for (const [k, t] of seen) t.classList.toggle("active", k === want);
  }
  const tl = document.getElementById("ct-tools"), fl = document.getElementById("ct-flag");
  if (tl && tl.parentElement === row && tl.nextElementSibling && tl.nextElementSibling !== fl) row.append(tl);
  if (fl && fl.parentElement === row && fl.nextElementSibling) row.append(fl);
};
// Every pass runs through safe(): an error in one never stops the others, and its time is added up per search
// (PASS_MS: name -> ms, BATCHES: observer runs), so each ⚑ says which passes cost the most on that device
const PASS_MS = new Map();
let passFor = "", BATCHES = 0;
const passReset = () => { const id = searchId(); if (id !== passFor) { passFor = id; PASS_MS.clear(); BATCHES = 0; } BATCHES++; };
globalThis.__ctPass = () => ({ batches: BATCHES, ms: Object.fromEntries(PASS_MS) }); // read by test/headless/run.cjs
const safe = (name, fn) => { const t = performance.now(); try { fn(); } catch (e) { console.error(`clean-titles ${name}:`, e); } PASS_MS.set(name, (PASS_MS.get(name) || 0) + performance.now() - t); };
// A tab tapped while degoog's first search is still starting is ignored by degoog (it has no current search yet), so the
// page seemed stuck until it finished loading. The tap is kept and repeated until degoog takes it (its tab turns
// active); degoog then drops the search that was loading and opens the tab. A later tap on another tab cancels it.
let rescueId = 0, repeating = false;
const tabRescue = () => {
  document.addEventListener("click", (e) => {
    const tab = e.target && e.target.closest ? e.target.closest("#results-tabs .results-tab") : null;
    if (!tab || repeating) return; // our own repeated taps never start another rescue
    const id = ++rescueId;
    const t0 = Date.now();
    const tick = () => {
      if (id !== rescueId || !tab.isConnected || tab.classList.contains("active") || Date.now() - t0 > 12000) return;
      repeating = true; try { tab.click(); } finally { repeating = false; }
      setTimeout(tick, 450);
    };
    setTimeout(tick, 450);
  }, true);
};

const init = () => {
  // iOS zooms the page into any text box under 16px on focus; maximum-scale=1 stops that (iOS still allows
  // pinch zoom), so boxes can use the page's text size. iOS only: elsewhere it would block pinch zoom.
  if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
    const vp = document.querySelector('meta[name="viewport"]');
    if (vp && !/maximum-scale/.test(vp.content)) vp.content += ", maximum-scale=1";
  }
  safe("tabrescue", tabRescue);
  safe("query", readQuery);
  safe("early", earlyStart);
  safe("usage", () => noUsage(document.body));
  safe("card", glance);
  safe("answer", ansPass);
  safe("list", listPass);
  safe("tabs", tabPass);
  safe("rel", relPass);
  safe("scan", () => scan(document.body));
  safe("skeleton", () => skel(document.body));
  safe("extras", extras); safe("groups", groups); safe("folds", foldPass); safe("ask", paa); safe("tools", tools); safe("flag", flagBtn); safe("gap", topGap); safe("tabkeep", tabKeep);
  safe("kp", kpPass); safe("only", onlyPass); safe("mean", meanPass); safe("stars", starsPass); safe("sides", sidesPass); safe("prod", productPass);
  safe("drawn", markDrawn);
  // Runs right after degoog inserts results and before the screen updates; only looks inside what was added
  new MutationObserver((muts) => {
    passReset();
    safe("query", readQuery);
    safe("early", earlyStart);
    safe("answer", ansPass);
    safe("list", listPass);
    safe("tabs", tabPass);
    safe("rel", relPass);
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { safe("scan", () => scan(n)); safe("skeleton", () => skel(n)); safe("usage", () => noUsage(n)); }
    safe("extras", extras); safe("groups", groups); safe("folds", foldPass); safe("ask", paa); safe("tools", tools); safe("flag", flagBtn); if (!gapSkip(muts)) safe("gap", topGap); safe("tabkeep", tabKeep); safe("card", glance);
    safe("kp", kpPass); safe("only", onlyPass); safe("mean", meanPass); safe("stars", starsPass); safe("preview", previewPass); safe("sides", sidesPass); safe("prod", productPass);
    safe("drawn", markDrawn); safe("skellearn", skelLearn);
    safe("ai", () => { const g = document.getElementById("at-a-glance"); if (g) aiPass(g, searchId()); });
  }).observe(document.body, { childList: true, subtree: true });
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
// ===== Load timing (for the self-check; no searches, no addresses, only milliseconds) =====
// Where the wait goes when degoog opens slowly: name lookup, connection, encryption, server, download, page work,
// and the first search request after the page opened. Kept on this server (last 60), printed by the installer.
(() => {
  const r = (x) => (Number.isFinite(x) && x >= 0 ? Math.round(x) : -1);
  const send = () => {
    try {
      const n = performance.getEntriesByType("navigation")[0];
      if (!n) return;
      const first = performance.getEntriesByType("resource").find((e) => /\/api\/(?:search|command)\b/.test(e.name) && !/cleantitles/.test(e.name));
      const ph = (x) => (x ? { wait: r(x.startTime), dns: r(x.domainLookupEnd - x.domainLookupStart), connect: r(x.connectEnd - x.connectStart), tls: r(x.secureConnectionStart > 0 ? x.connectEnd - x.secureConnectionStart : 0), server: r(x.responseStart - x.requestStart), download: r(x.responseEnd - x.responseStart), total: r(x.duration) } : null);
      const nav = ph(n);
      nav.ready = r(n.domContentLoadedEventEnd);
      nav.loaded = r(n.loadEventEnd);
      nav.type = n.type;
      nav.cached = n.transferSize === 0;
      bridge("perf", {}, JSON.stringify({ dev: PHONE.matches ? "phone" : "pc", nav, search: ph(first) })).catch(() => {});
    } catch {}
  };
  const go = () => setTimeout(send, 4000); // after the first search usually finished
  if (document.readyState === "complete") go(); else addEventListener("load", go, { once: true });
})();

// ===== DuckDuckGo on, once (measured on this server: 9-10 results in ~600 ms, while every search already waits
// for Startpage, so it adds results without adding time). degoog keeps engine switches in this browser's IndexedDB
// ("degoog" / "settings" / "engines"); this flips DuckDuckGo's web engine on one time per browser and never again,
// so switching it off later sticks.
(() => {
  try { if (localStorage.getItem("ct-ddg-on")) return; } catch { return; }
  try {
    const open = indexedDB.open("degoog");
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("settings")) return;
      const tx = db.transaction("settings", "readwrite"), st = tx.objectStore("settings"), get = st.get("engines");
      get.onsuccess = () => {
        const m = get.result && typeof get.result === "object" ? { ...get.result } : null;
        const id = m && Object.keys(m).find((k) => /(?:^|-)duckduckgo(?:-engine)?$/i.test(k));
        if (id && m[id] !== true) { m[id] = true; st.put(m, "engines"); }
        try { localStorage.setItem("ct-ddg-on", "1"); } catch {}
      };
    };
  } catch {}
})();
