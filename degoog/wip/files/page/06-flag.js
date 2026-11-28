// ----- page/06-flag.js: ⚑ Report box -----
// ⚑ at the right end of the tab row (phone and PC): "What's wrong? (optional)" + Save keeps the search, your note and
// its top 10 results on your server. Nothing else shows (no count, no send link): the local model decides when they're
// worth a Claude session and the PC's hourly job sends them by itself. Anything about the box itself goes in the same box.
const flagTop = () => {
  const out = [];
  for (const el of document.querySelectorAll("#results-list .result-item, #results-list .image-card, #results-list .video-card")) {
    if (el.style.display === "none") continue;
    const a = el.querySelector("a.result-title") || el.querySelector("a[href]");
    const url = el.dataset.resultUrl || (a && a.href) || "";
    if (!/^https?:/.test(url)) continue;
    const ai = AIW.get(aiKey(url));
    out.push({ ai: ai && typeof ai.p === "number" ? Math.round(ai.p * 1000) / 1000 : null, url, title: (((el.querySelector("a.result-title, .image-title, .video-title") || a || {}).textContent) || "").trim().slice(0, 200), snippet: (el.querySelector(".result-snippet")?.textContent || "").trim().slice(0, 300) });
    if (out.length >= 10) break;
  }
  return out;
};
// Attached to every ⚑: viewport, load timings (page + each /api call, ms) and which blocks were showing (each visible
// child of the glance area and the results list, by its first class, with a count). Read from the page, no fixed list.
const flagCtx = () => {
  const load = {};
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) { load.page = nav.domContentLoadedEventEnd; load.pageLoad = nav.loadEventEnd; }
    for (const r of performance.getEntriesByType("resource")) {
      let u; try { u = new URL(r.name); } catch { continue; }
      if (u.origin !== location.origin || !/\/api\//.test(u.pathname)) continue;
      const k = u.pathname.replace(/^.*\/api\//, "").slice(0, 40);
      load[k] = Math.max(load[k] || 0, r.duration);
    }
  } catch {}
  const boxes = [];
  for (const id of ["at-a-glance", "results-list"]) {
    const root = document.getElementById(id);
    if (!root) continue;
    for (const el of root.children) {
      if (el.style.display === "none" || el.hidden || !el.getClientRects().length) continue;
      const k = `${id} > ${el.classList[0] || el.id || el.tagName.toLowerCase()}`;
      const last = boxes[boxes.length - 1];
      if (last && last.box === k) last.n++; else boxes.push({ box: k, n: 1 });
    }
  }
  // the 8 passes that took longest on this search (ms, all runs added up) and how many observer runs it took
  const passes = Object.fromEntries([...PASS_MS].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  return { ver: typeof CT_VER === "string" ? CT_VER : "", vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, phone: PHONE.matches, load, boxes, passes, batches: BATCHES };
};
const curType = () => { try { return new URL(location.href).searchParams.get("type") || tabNow || "web"; } catch { return tabNow || "web"; } };
const flagBox = (btn) => {
  let box = document.getElementById("ct-flagbox");
  // A floating card (popover under the ⚑ on PC, bottom sheet on phone): never pushes the results down
  const close = () => {
    document.getElementById("ct-flagbox")?.remove(); document.removeEventListener("click", outside, true);
    btn.setAttribute("aria-expanded", "false"); removeEventListener("keydown", esc); removeEventListener("resize", place);
    if (vv) { vv.removeEventListener("resize", place); vv.removeEventListener("scroll", place); }
  };
  const esc = (e) => { if (e.key === "Escape") { close(); btn.focus(); } };
  const vv = window.visualViewport;
  const outside = (e) => { const b = document.getElementById("ct-flagbox"); if (!b || b.contains(e.target) || btn.contains(e.target)) return; e.preventDefault(); e.stopPropagation(); close(); };
  const place = () => {
    const b = document.getElementById("ct-flagbox");
    if (!b) return;
    // Phone sheet: pinned to the part of the screen that's actually visible (visualViewport), so an open keyboard,
    // the browser's bars or iOS scrolling the page for the focused box never leave a gap or hide part of it
    if (TOUCH.matches) {
      b.style.top = b.style.left = "";
      if (vv) { b.style.setProperty("--ct-vis-h", `${Math.round(vv.height)}px`); b.style.setProperty("--ct-vis-b", `${Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))}px`); }
      return;
    }
    const r = btn.getBoundingClientRect(), w = b.offsetWidth || 440;
    b.style.top = `${Math.round(r.bottom + scrollY + 6)}px`;
    b.style.left = `${Math.round(Math.max(12, Math.min(r.right - w, innerWidth - w - 12)) + scrollX)}px`;
  };
  if (box) { close(); return; }
  btn.setAttribute("aria-expanded", "true");
  box = document.createElement("form");
  box.id = "ct-flagbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Report a problem");
  const chips = mk("div", "ct-flag-cats", "");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "What's wrong?");
  for (const [id, name] of CT.FLAG_CATS) {
    const c = mk("button", "ct-flag-cat", name);
    c.type = "button"; c.dataset.cat = id; c.setAttribute("aria-pressed", "false");
    c.addEventListener("click", () => c.setAttribute("aria-pressed", c.getAttribute("aria-pressed") === "true" ? "false" : "true"));
    chips.append(c);
  }
  const l = mk("label", "", "");
  const t = document.createElement("textarea");
  t.rows = 2; t.maxLength = 1000; t.setAttribute("autocapitalize", "sentences");
  t.placeholder = "Anything else? (optional)"; t.setAttribute("aria-label", "Anything else? (optional)");
  l.append(t);
  const save = mk("button", "", "Save");
  save.type = "submit";
  const st = mk("span", "ct-flag-st", "");
  const acts = mk("div", "ct-flag-acts", "");
  // Which version this page runs (the auto-update installs new ones by itself): quiet, at the row's far end
  acts.append(save, st, mk("span", "ct-flag-ver", `clean-titles ${typeof CT_VER === "string" ? CT_VER : ""}`));
  const head = mk("div", "ct-flag-top", "");
  const x = mk("button", "ct-flag-x", "×");
  x.type = "button"; x.setAttribute("aria-label", "Close"); x.addEventListener("click", close);
  head.append(mk("span", "ct-flag-h", "What's wrong?"), x);
  box.append(head, chips, l, acts);
  box.addEventListener("submit", (e) => {
    e.preventDefault(); e.stopPropagation();
    save.disabled = true; st.textContent = "";
    const cats = [...chips.querySelectorAll('[aria-pressed="true"]')].map((c) => c.dataset.cat);
    bridge("flag", {}, JSON.stringify({ q: curQ(), type: curType(), cats, note: t.value.trim(), ctx: flagCtx(), top: flagTop() })).then((j) => {
      save.disabled = false;
      if (!j) { st.textContent = "Couldn't save. Try again."; return; }
      t.value = ""; chips.querySelectorAll(".ct-flag-cat").forEach((c) => c.setAttribute("aria-pressed", "false")); st.textContent = "Saved.";
      setTimeout(() => { if (box.isConnected) close(); }, 1200);
    }).catch(() => { save.disabled = false; st.textContent = "Couldn't save. Try again."; });
  });
  // No overlay: the results stay scrollable behind the box (a report is about them). A tap outside only closes the
  // box; it doesn't also follow a link, so a half-typed note isn't lost by accident.
  document.body.append(box);
  setTimeout(() => document.addEventListener("click", outside, true));
  place();
  addEventListener("keydown", esc); addEventListener("resize", place);
  if (vv) { vv.addEventListener("resize", place); vv.addEventListener("scroll", place); }
  if (!TOUCH.matches) t.focus();
};
// ⚑ sits in the header right after the settings gear (same round button); its box still opens over the results
const flagPlace = () => {
  const f = document.getElementById("ct-flag"), g = document.getElementById("nav-settings-results");
  if (!f || !g) return;
  // phone: the gear is pinned to the header's top right, so ⚑ is pinned just left of it at the same height (same order as PC)
  if (PHONE.matches) { f.style.top = `${g.offsetTop}px`; f.style.right = `${g.offsetParent ? g.offsetParent.clientWidth - g.offsetLeft : 0}px`; f.style.height = `${g.offsetHeight}px`; }
  else f.style.top = f.style.right = f.style.height = "";
};
const flagBtn = () => {
  const g = document.getElementById("nav-settings-results");
  if (!g || document.getElementById("ct-flag") || !curQ()) return;
  const f = document.createElement("button");
  f.type = "button";
  f.id = "ct-flag";
  f.title = "Report a problem with these results";
  f.setAttribute("aria-label", "Report a problem with these results");
  f.setAttribute("aria-expanded", "false");
  f.addEventListener("click", () => flagBox(f));
  f.textContent = "⚑";
  g.before(f); // ⚑ then gear on every screen size (the gear keeps degoog's own outer-edge spot)
  // Phone: placed in the next frame, when the browser lays the page out anyway (reading the gear's spot here forced
  // an extra layout in the middle of the results pass); hidden until then so it never shows in the wrong spot
  if (PHONE.matches) { f.style.visibility = "hidden"; requestAnimationFrame(() => { flagPlace(); f.style.visibility = ""; }); }
  if (!flagPlace.on) { flagPlace.on = 1; PHONE.addEventListener("change", flagPlace); addEventListener("resize", flagPlace); }
};
