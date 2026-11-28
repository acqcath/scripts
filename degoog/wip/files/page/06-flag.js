// ----- page/06-flag.js: ⚑ Report box -----
// ⚑ at the right end of the tab row (phone and PC): "What's wrong? (optional)" + Save keeps the search, your note and
// its top 10 results on your server. Nothing else shows (no count, no send link): the PC's watcher sends it to the
// Report session as soon as it's saved. Anything about the box itself goes in the same box.
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
// ===== Layout snapshot: what the screen showed, as text, and anything that looks broken (any device) =====
// No picture (a page can't take one without asking each time, and iPhone can't at all). Instead: every visible
// thing on screen with its place, size and text, and checks that name a problem outright: something sticking out
// past the screen edge, text cut off, things overlapping, pictures that failed, placeholders still showing, recent
// jumps (layout shift), page errors, and the focused box hidden by the keyboard. Taken when ⚑ is tapped (box closed)
// and at Save (box open, keyboard as it is).
const SNAP_ERR = [];
addEventListener("error", (e) => { if (SNAP_ERR.length < 20) SNAP_ERR.push(`error: ${String(e.message || e.error || "").slice(0, 160)} @${String(e.filename || "").split("/").pop()}:${e.lineno || ""}`); });
addEventListener("unhandledrejection", (e) => { if (SNAP_ERR.length < 20) SNAP_ERR.push(`rejection: ${String((e.reason && e.reason.message) || e.reason || "").slice(0, 160)}`); });
const SNAP_SHIFT = [];
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.hadRecentInput || e.value < 0.001) continue; SNAP_SHIFT.push({ t: e.startTime, v: e.value, src: (e.sources || []).slice(0, 3).map((x) => `${snapName(x.node)} y${Math.round(x.previousRect.y)}->${Math.round(x.currentRect.y)} h${Math.round(x.previousRect.height)}->${Math.round(x.currentRect.height)}`) }); if (SNAP_SHIFT.length > 30) SNAP_SHIFT.shift(); } }).observe({ type: "layout-shift", buffered: true }); } catch {}
const snapName = (n) => {
  if (!n || n.nodeType !== 1) return n && n.parentElement ? snapName(n.parentElement) : "?";
  const c = typeof n.className === "string" ? n.className.trim().split(/\s+/).filter((x) => x && !/^(degoog|ct-in$)/.test(x)).slice(0, 2).join(".") : "";
  return `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${c ? "." + c : ""}`;
};
const snapTake = (state) => {
  const out = [], bugs = [], W = innerWidth, H = innerHeight, vv = window.visualViewport;
  const R = (r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  const own = (e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join(" ").replace(/\s+/g, " ").trim();
  const shown = [];
  const all = document.body.querySelectorAll("*");
  for (const e of all) {
    if (e.closest("script, style, svg, template")) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === "hidden" || +cs.opacity === 0) continue;
    const txt = own(e), media = /^(IMG|VIDEO|CANVAS|INPUT|TEXTAREA|BUTTON|SELECT)$/.test(e.tagName);
    const boxy = cs.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(cs.borderTopWidth) > 0 || cs.position === "fixed" || cs.position === "sticky";
    if (!txt && !media && !boxy) continue;
    shown.push([e, r, cs, txt]);
    // sticks out past the screen's right edge (and nothing above it scrolls or clips sideways)
    if (r.right > W + 1) { let clip = false; for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== "visible") { clip = true; break; } } if (!clip) bugs.push(`past the right edge by ${Math.round(r.right - W)}px: ${snapName(e)}`); }
    // text cut off without an ellipsis meant for it
    if (txt && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 2) && /hidden|clip/.test(cs.overflow) && cs.textOverflow !== "ellipsis" && !/-webkit-box/.test(cs.display)) bugs.push(`text cut off: ${snapName(e)} "${txt.slice(0, 40)}"`);
    if (e.tagName === "IMG" && e.complete && !e.naturalWidth && e.getAttribute("src")) bugs.push(`picture failed: ${snapName(e)} ${String(e.getAttribute("src")).slice(0, 80)}`);
  }
  // text on top of other text (not one inside the other, not the report box or a note floating over the page)
  const texty = shown.filter(([e, , cs, t]) => t && cs.position !== "fixed" && !e.closest("#ct-flagbox, #ct-fixed"));
  for (let i = 0; i < texty.length && bugs.length < 40; i++) for (let j = i + 1; j < texty.length; j++) {
    const [a, ra] = texty[i], [b, rb] = texty[j];
    if (a.contains(b) || b.contains(a)) continue;
    const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (ix > 4 && iy > 4 && ix * iy > 0.25 * Math.min(ra.width * ra.height, rb.width * rb.height)) bugs.push(`overlap: ${snapName(a)} "${texty[i][3].slice(0, 24)}" and ${snapName(b)} "${texty[j][3].slice(0, 24)}"`);
  }
  if (document.querySelector(".skeleton-card, .ct-skc, .ct-skimg, .skeleton-results") && performance.now() > 8000) bugs.push("loading placeholders still showing");
  const f = document.activeElement;
  if (f && f !== document.body && vv) { const r = f.getBoundingClientRect(); if (r.bottom > vv.offsetTop + vv.height + 1 || r.top < vv.offsetTop - 1) bugs.push(`focused ${snapName(f)} is outside the visible area (keyboard or bars): ${R(r)}, visible ${Math.round(vv.offsetTop)}..${Math.round(vv.offsetTop + vv.height)}`); }
  const tabs = document.getElementById("results-tabs"), first = document.querySelector("#results-list .result-item .result-url-row, #results-list .image-card, .no-results");
  const gap = tabs && first ? Math.round(first.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom) : null;
  const shifts = SNAP_SHIFT.filter((x) => performance.now() - x.t < 15000).map((x) => `${x.v.toFixed(3)} ${x.src.join(" | ")}`);
  const lines = shown.slice(0, 160).map(([e, r, cs, t]) => `${snapName(e)} ${R(r)}${cs.position === "fixed" || cs.position === "sticky" ? " " + cs.position : ""}${t ? ` "${t.slice(0, 50)}"` : ""}`);
  return { state, at: Math.round(performance.now()), view: `${W}x${H}${vv ? ` visible ${Math.round(vv.width)}x${Math.round(vv.height)}+${Math.round(vv.offsetTop)}` : ""} scroll ${Math.round(scrollY)} dpr ${devicePixelRatio}`,
    ua: navigator.userAgent.slice(0, 160), gap, bugs: [...new Set(bugs)].slice(0, 30), errors: SNAP_ERR.slice(-10), shifts: shifts.slice(-8), items: lines };
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
      if (vv) {
        b.style.setProperty("--ct-vis-h", `${Math.round(vv.height)}px`); b.style.setProperty("--ct-vis-b", `${Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))}px`);
        // keyboard open: the sheet sits right on it (the home-bar spacing under it left a strip of page showing)
        b.classList.toggle("ct-kb", vv.height < innerHeight * 0.8);
      }
      return;
    }
    const r = btn.getBoundingClientRect(), w = b.offsetWidth || 440;
    b.style.top = `${Math.round(r.bottom + scrollY + 6)}px`;
    b.style.left = `${Math.round(Math.max(12, Math.min(r.right - w, innerWidth - w - 12)) + scrollX)}px`;
  };
  if (box) { close(); return; }
  let snap0 = null; try { snap0 = snapTake("closed"); } catch {}
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
    let snap1 = null; try { snap1 = snapTake("open"); } catch {}
    bridge("flag", {}, JSON.stringify({ q: curQ(), type: curType(), cats, note: t.value.trim(), ctx: flagCtx(), top: flagTop(), snap: [snap0, snap1].filter(Boolean) })).then((j) => {
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
// ===== "Fixed" note: the first time degoog is opened anywhere after a release fixed your report =====
// The server tells each fix once (whichever device asks first), so seeing it on the phone means the PC won't show it.
// A small note at the bottom for a few seconds (fixed position: nothing on the page moves); a tap closes it.
const fixedNote = () => bridge("fixednews", {}, "").then((j) => {
  const items = j && Array.isArray(j.items) ? j.items.filter((x) => x && x.what) : [];
  if (!items.length || document.getElementById("ct-fixed")) return;
  const n = mk("div", "ct-fixed");
  n.id = "ct-fixed";
  n.setAttribute("role", "status");
  const vers = [...new Set(items.map((x) => x.ver))].join(", ");
  n.append(mk("b", "", items.length === 1 ? `Fixed in ${vers}` : `${items.length} of your reports fixed (${vers})`));
  for (const x of items.slice(0, 3)) n.append(mk("span", "ct-fixed-i", x.what));
  if (items.length > 3) n.append(mk("span", "ct-fixed-i", `+${items.length - 3} more`));
  const close = () => { n.classList.add("ct-out"); setTimeout(() => n.remove(), 300); };
  n.addEventListener("click", close);
  setTimeout(close, 8000);
  document.body.append(n);
}).catch(() => {});
