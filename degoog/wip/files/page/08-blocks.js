// ----- page/08-blocks.js: sitelinks, forums, videos, top stories -----
// Each step runs on its own: one error can't stop the others (errors go to the browser console)
// ===== Sitelinks, Discussions and forums, Videos, Top stories =====
// Built from the results already on the page (endless-scroll pages too), so they cost nothing: nothing is shown twice,
// nothing is lost (the per-site limit hides extra pages; these put them back to use), and each box sits where its
// best result ranked. Only Top stories asks for more, and only when the results themselves look like news.
// A YouTube link's video id (watch?v=, youtu.be/, shorts/, live/, embed/), else ""
const ytId = (u) => {
  try {
    const h = u.hostname.replace(/^(www|m|music)\./, "");
    const id = h === "youtu.be" ? u.pathname.slice(1) : h === "youtube.com" ? (u.searchParams.get("v") || (/^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(u.pathname) || [])[1] || "") : "";
    return /^[\w-]{11}$/.test(id) ? id : "";
  } catch { return ""; }
};
const VIDEO_URL = (u, h) => (/(^|\.)youtube\.com$/.test(h) && /^\/(watch|shorts\/|live\/)/.test(u.pathname)) || h === "youtu.be" ||
  (/(^|\.)vimeo\.com$/.test(h) && /^\/\d+/.test(u.pathname)) || (/(^|\.)dailymotion\.com$/.test(h) && u.pathname.startsWith("/video/")) ||
  (/(^|\.)twitch\.tv$/.test(h) && /\/(videos|clip)\//.test(u.pathname)) || (/(^|\.)tiktok\.com$/.test(h) && /\/video\//.test(u.pathname));
const SE = { "stackoverflow.com": "Stack Overflow", "superuser.com": "Super User", "serverfault.com": "Server Fault", "askubuntu.com": "Ask Ubuntu", "mathoverflow.net": "MathOverflow" };
const forumName = (u, h) => {
  const p = u.pathname;
  if (/(^|\.)reddit\.com$/.test(h) && /^\/r\/[^/]+\/comments\//.test(p)) return `r/${p.split("/")[2]}`;
  if (h === "news.ycombinator.com" && p === "/item") return "Hacker News";
  if (SE[h] && /^\/questions\/\d+/.test(p)) return SE[h];
  if (/\.stackexchange\.com$/.test(h) && /^\/questions\/\d+/.test(p)) return h.replace(/\.stackexchange\.com$/, "").replace(/^./, (c) => c.toUpperCase()) + " Stack Exchange";
  if (/(^|\.)quora\.com$/.test(h) && p.length > 1 && !/^\/(profile|topic|search)\b/.test(p)) return "Quora";
  if (/(^|\.)github\.com$/.test(h) && /^\/[^/]+\/[^/]+\/discussions\/\d+/.test(p)) return `GitHub · ${p.split("/")[2]}`;
  if ((h === "lobste.rs" && p.startsWith("/s/")) || (h === "tildes.net" && p.length > 1)) return h;
  if (/^(forums?|community|communities|discuss|discussions?|discourse|boards)\./.test(h) || /\/(forums?|threads?)\/[^/]|showthread\.php|viewtopic\.php|\/community\/[^/]+\/(td-p|m-p)\/|\/t\/[^/]+\/\d+/.test(p)) return h;
  return "";
};
// Dates: "3 hours ago" is exact; "Nov 20, 2026" only gives the day
const when = (t) => {
  t = String(t || "").replace(/·/g, " ").trim();
  if (!t) return null;
  const m = /(\d+)\s+(minute|hour|day|week|month)s?\s+ago/i.exec(t);
  if (m) return { t: Date.now() - Number(m[1]) * { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2].toLowerCase()], exact: /minute|hour/i.test(m[2]) };
  const d = Date.parse(t);
  return isNaN(d) ? null : { t: d, exact: false };
};
const ago = (w) => {
  if (!w) return "";
  const s = (Date.now() - w.t) / 1000;
  if (w.exact) return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : `${Math.round(s / 3600)} hours ago`;
  const d = new Date(w.t), day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - day.getTime()) / 864e5);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(days > 300 ? { year: "numeric" } : {}) });
};
const fresh = (w) => !!w && Date.now() - w.t < (w.exact ? 2 : 3) * 864e5;
// "Looks like news": 3+ different sites with an exact "N minutes/hours ago" stamp from the last 24 h. Measured on the
// 50 recorded web searches: only steelers and taylor swift pass. v49's rule (2+ sites dated within 2-3 days) also
// fired on time in tokyo, days until christmas and 100 usd to eur (pages stamped with today's date).
const hot = (rows) => new Set(rows.filter((r) => r.w && r.w.exact && Date.now() - r.w.t < 864e5).map((r) => r.h)).size >= 3;
// Searches that looked like news, kept in this browser as a short hash of the search (not the words) for 12 h,
// the same time degoog keeps engine answers. Only these start a News search early on the next visit.
const NEWSY_KEY = "ct-newsy";
const qHash = (q) => { let h = 2166136261; for (const c of String(q).trim().toLowerCase()) h = Math.imul(h ^ c.codePointAt(0), 16777619); return (h >>> 0).toString(36); };
const hashStore = (KEY) => {
  let m = {};
  try { const c = JSON.parse(localStorage.getItem(KEY) || "{}"); if (c && typeof c === "object") m = c; } catch {}
  const now = Date.now();
  for (const k of Object.keys(m)) if (!(now - m[k] < 432e5)) delete m[k];
  return {
    has: (h) => h in m,
    add: (h) => {
      m[h] = Date.now();
      const ks = Object.keys(m); if (ks.length > 300) ks.sort((a, b) => m[a] - m[b]).slice(0, ks.length - 300).forEach((k) => delete m[k]);
      try { localStorage.setItem(KEY, JSON.stringify(m)); } catch {}
    },
  };
};
const newsy = hashStore(NEWSY_KEY);
// Searches you opened the Images tab for (same hash, 12 h = degoog's cache, so their image search is still cached)
const visualSeen = hashStore("ct-visual");
const _info = new WeakMap();
const info = (el) => {
  if (_info.has(el)) return _info.get(el);
  let r = null;
  const a = el.querySelector("a.result-title");
  try {
    const u = new URL(a.href), h = u.hostname.replace(/^(www|m|old)\./, "");
    // The date: degoog's own (if row cleanup hasn't run), else the one cleanup moved to the source line (raw text kept)
    const p = el.querySelector(".result-snippet"), dEl = (p && p.querySelector(".result-date")) || el.querySelector(".result-url-row .ct-date");
    const raw = (a.textContent || "").replace(/\s+/g, " ").trim();
    r = {
      el, u, h, href: a.href, title: (el.dataset.ctCap ? cleanTitle(raw, a.href) : "") || raw,
      snippet: p ? (p.textContent || "").replace(dEl && p.contains(dEl) ? dEl.textContent : "", "").replace(/^\s*·\s*/, "").trim() : "",
      w: when(dEl ? dEl.dataset.raw || dEl.textContent : ""), thumb: el.querySelector(".result-thumbnail-wrap:not([style*='none']) img")?.src || "",
      fav: favOf(h, el.querySelector("img.result-favicon")?.src || ""), dur: el.querySelector(".degoog-result--video-duration")?.textContent.trim() || "",
    };
    r.video = VIDEO_URL(u, h) || !!el.querySelector(".degoog-result--thumb--video");
    const ai = AIW.get(aiKey(el.dataset.resultUrl || a.href));
    if (ai) { r.ai = ai.p; r.best = ai.best; }
    r.forum = r.video ? "" : forumName(u, h);
  } catch {}
  _info.set(el, r);
  return r;
};
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const favImg = (src) => {
  if (!src) return mk("span", "ct-fav ct-fav-x");
  const i = mk("img", "ct-fav"); i.alt = ""; i.loading = "lazy"; i.src = src;
  i.onerror = () => i.replaceWith(mk("span", "ct-fav ct-fav-x"));
  return i;
};
// "More" opens the matching tab exactly as tapping it would
const moreBtn = (label, type) => {
  const tab = document.querySelector(`.results-tab[data-type="tab:engine:${type}"], .results-tab[data-type="${type}"]`);
  if (!tab) return null;
  const b = mk("button", "ct-more", label);
  b.type = "button";
  b.onclick = () => { tab.click(); scrollTo({ top: 0 }); };
  return b;
};
// Sideways row (Videos, Top stories): swipe on phones, arrows on PC that only show when there's more to see
const scroller = () => {
  const wrap = mk("div", "ct-rowwrap"), row = mk("div", "ct-row");
  const prev = mk("button", "ct-arr ct-prev"), next = mk("button", "ct-arr ct-next");
  prev.type = next.type = "button"; prev.setAttribute("aria-label", "Back"); next.setAttribute("aria-label", "More");
  const upd = () => { wrap.classList.toggle("ct-can-prev", row.scrollLeft > 4); wrap.classList.toggle("ct-can-next", row.scrollLeft + row.clientWidth < row.scrollWidth - 4); };
  prev.onclick = () => row.scrollBy({ left: -row.clientWidth * 0.9, behavior: "smooth" });
  next.onclick = () => row.scrollBy({ left: row.clientWidth * 0.9, behavior: "smooth" });
  row.addEventListener("scroll", upd, { passive: true });
  wrap.append(prev, row, next);
  wrap.upd = () => requestAnimationFrame(upd);
  return [wrap, row];
};
const section = (cls, title) => { const s = fadeIn(mk("section", `ct-grp ${cls}`)); s.append(mk("h3", "ct-gh", title)); return s; };

const COUNT = /(\d[\d,.]*\s*[kK]?)\+?\s+(comments?|answers?|replies|reply|posts?|votes?)\b/i;
const forumRow = (r) => {
  const a = mk("a", "ct-fi"); a.href = r.href;
  const meta = mk("span", "ct-meta"); meta.append(favImg(r.fav), mk("span", "ct-src", r.forum));
  const n = COUNT.exec(r.snippet);
  const bits = [n ? `${n[1].trim()} ${n[2].toLowerCase()}` : "", ago(r.w)].filter(Boolean);
  if (bits.length) meta.append(mk("span", "ct-when", bits.join(" · ")));
  const snip = r.snippet.replace(new RegExp(`^\\s*${COUNT.source}[\\s.·:-]*`, "i"), "");
  // The community is already on the line above: drop it from the title (" : r/SteamDeck", " - Stack Overflow")
  const t = r.title.replace(/\s*[:|\-–—]\s*r\/[\w-]+\s*$/i, "").replace(new RegExp(`\\s*[-|–—:]\\s*${r.forum.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "") || r.title;
  a.append(meta, mk("span", "ct-ft", t));
  if (snip) a.append(mk("span", "ct-fs", snip));
  return a;
};
const siteName = (h) => (/youtu/.test(h) ? "YouTube" : h.replace(/\.(com|tv|net|org)$/, "").replace(/^./, (c) => c.toUpperCase()));
const videoCard = (r) => {
  const a = mk("a", "ct-card ct-vc"); a.href = r.href;
  const pic = mk("span", "ct-pic");
  // YouTube results often come without a picture (or one that fails): your server signs the video's own still
  // (i.ytimg.com hqdefault, which every video has) so it loads through degoog's image proxy. It fades into the
  // box that is already there, so nothing moves.
  const yid = ytId(r.u);
  if (r.thumb || yid) {
    const i = mk("img"); i.alt = ""; i.loading = "lazy";
    let late = !r.thumb;
    const fill = () => { i.classList.add("ct-late"); i.onload = () => i.classList.add("ct-in"); bridge("yt", { id: yid }).then((j) => { if (j && j.to && i.isConnected) i.src = j.to; else i.remove(); }).catch(() => i.remove()); };
    i.onerror = () => { if (!late && yid) { late = true; fill(); } else i.remove(); };
    if (r.thumb) i.src = r.thumb; else fill();
    pic.append(i);
  }
  pic.append(mk("span", "ct-play"));
  if (r.dur) pic.append(mk("span", "ct-dur", r.dur));
  const meta = mk("span", "ct-meta"); meta.append(favImg(r.fav), mk("span", "ct-src", siteName(r.h)));
  if (r.w) meta.append(mk("span", "ct-when", ago(r.w)));
  a.append(pic, mk("span", "ct-ct", r.title), meta);
  return a;
};
const storyCard = (r) => {
  const a = mk("a", "ct-card ct-sc"); a.href = r.href;
  if (r.thumb) { const pic = mk("span", "ct-pic"); const i = mk("img"); i.src = r.thumb; i.alt = ""; i.loading = "lazy"; i.onerror = () => { i.style.visibility = "hidden"; /* keeps its box: no shape change after paint */ }; pic.append(i); a.append(pic); }
  else a.classList.add("ct-nopic");
  const meta = mk("span", "ct-meta"); meta.append(favImg(r.fav), mk("span", "ct-src", r.h));
  a.append(meta, mk("span", "ct-ct", r.title), mk("span", "ct-when", ago(r.w)));
  return a;
};

let G = { key: "" };
// Your Settings switches for these boxes. Known before results arrive, so the boxes are built in the same pass as
// the results (v49 waited for the server, which could rebuild the list after it was on screen): the last answer is
// kept in this browser (switch values only), and a change applies from the next page load. Missing = on.
const SHOW_KEY = "ct-show";
let SHOW = { sl: true, forum: true, video: true, news: true, papers: true, ans: true, kp: true, img: true, qv: true, arch: true, mean: true, stars: true, plain: true, pw: true };
try { const c = JSON.parse(localStorage.getItem(SHOW_KEY) || "null"); if (c && typeof c === "object") SHOW = { ...SHOW, ...c }; } catch {}
bridge("prefs", {}).then((j) => { if (j && typeof j === "object") try { localStorage.setItem(SHOW_KEY, JSON.stringify(j)); } catch {} }).catch(() => {});
const used = (el) => el.classList.contains("ct-grouped");
const shown = (el) => el.style.display !== "none" && !used(el);
const groups = () => {
  if (!webTab || !SHOW) return;
  const list = document.getElementById("results-list");
  if (!list) return;
  const key = searchId();
  if (G.key !== key) {
    list.querySelectorAll(".ct-grp, .ct-sl").forEach((x) => x.remove());
    list.querySelectorAll(".ct-grouped").forEach((x) => x.classList.remove("ct-grouped"));
    G = { key, sl: null, slTop: null, forum: null, video: null, paper: null, news: false, img: false, cut: false };
  }
  for (const k of ["forum", "video", "paper", "sl"]) if (G[k] && !G[k].isConnected) G[k] = null; // degoog redrew the list
  const rows = [...list.querySelectorAll(".result-item")].filter((x) => x.style.display !== "none" || x.dataset.ctCap).map(info).filter(Boolean);
  const top = rows.find((r) => shown(r.el));
  if (!top) return;

  // Sitelinks: the top result's other pages from your results, under it (they leave the list, so no repeats)
  if (G.slTop !== top.el) { G.sl?.remove(); G.sl = null; G.slTop = top.el; }
  if (SHOW.sl && !top.video && !top.forum) {
    const base = top.href.split("#")[0];
    const same = rows.filter((r) => r !== top && r.h === top.h && !used(r.el) && !r.video && !r.forum && r.href.split("#")[0] !== base);
    const have = G.sl ? G.sl.children.length : 0;
    if (same.length && (G.sl || same.length >= 2) && have < 4) {
      if (!G.sl) { G.sl = fadeIn(mk("div", "ct-sl")); top.el.querySelector(".result-body")?.append(G.sl); }
      const brand = top.title.split(/\s[-|·:–—]\s/).pop();
      for (const r of same.slice(0, 4 - have)) {
        const a = mk("a", "ct-sl-i"); a.href = r.href;
        const t = r.title.split(/\s[-|·:–—]\s/).filter((x) => x !== brand).join(" - ") || r.title;
        a.append(mk("span", "ct-sl-t", t));
        if (r.snippet) a.append(mk("span", "ct-sl-d", r.snippet));
        G.sl.append(a);
        r.el.classList.add("ct-grouped");
      }
    }
  }
  // 2+ of a kind become one box, placed where the first of them ranked (the top result always stays a normal
  // result); up to 4 threads / 8 videos, joined by more as endless scroll loads them
  // extra: items from a search of that kind fetched for this page (no element; only when the box is first drawn,
  // so a box never grows after paint because of them)
  const box = (kind, test, max, build, title, tab, label, isRow, at, extra) => {
    let c = rows.filter((r) => r !== top && test(r) && !used(r.el) && !r.el.dataset.ctUnrel);
    let s = G[kind];
    if (!s && extra && extra.length) {
      const have = new Set(rows.map((r) => r.href.split("#")[0]));
      c = c.concat(extra.filter((r) => !have.has(r.href.split("#")[0]) && have.add(r.href.split("#")[0])));
    }
    if (!s && c.length < 2) return;
    if (!s) {
      s = G[kind] = section(`ct-${kind}`, title);
      if (isRow) { const [wrap, row] = scroller(); s.append(wrap); s.row = row; s.wrap = wrap; } else { s.row = mk("div", "ct-list"); s.append(s.row); }
      const first = c.find((r) => r.el && r.el.style.display !== "none") || c.find((r) => r.el);
      if (at && at.before) at.before.before(s); else if (at && at.after) endOf(at.after).after(s); else if (first) first.el.before(s); else top.el.after(s);
      const m = moreBtn(label, tab); if (m) s.append(m);
    }
    const n = s.row.children.length;
    for (const r of c.slice(0, Math.max(0, max - n))) { s.row.append(build(r)); r.el?.classList.add("ct-grouped"); }
    s.wrap?.upd();
  };
  if (shaped()) return; // a plain list of the type asked for: no boxes or rows
  // Every box goes where it's worth more than the results (CT.boxAt): videos and images by the needs call's format
  // shares, forums / top stories / papers by their block share (CT.blockShare), each x how well its items fit.
  // Without the AI: degoog's own order, as before.
  const needs = ready("needs", key), fmt = CT.fmtShares(needs?.f);
  const bShare = (k) => CT.blockShare(fmt, needs?.b, k);
  const place = (worth) => {
    const v = [...list.querySelectorAll(".result-item")].filter((el) => shown(el) && !info(el)?.video && !used(el));
    if (!fmt || worth == null || !v.length) return null;
    const i = CT.boxAt(fmt, v.map((el) => info(el)?.ai), worth);
    return i >= v.length ? { after: v[v.length - 1] } : { before: v[i] };
  };
  const worthOf = (share, rels) => (share == null ? null : CT.boxWorth({ v: share }, rels, "v"));
  // A fetched search's results as box items (same shape as info()), the AI score riding along as ctRel
  const fetched = (name, forumOf) => {
    const j = ready(name, key);
    return (j && j.results || []).map((x) => {
      let u; try { u = new URL(x.url); } catch { return null; }
      const h = u.hostname.replace(/^(www|m|old)\./, "");
      return { u, h, href: x.url, title: cleanTitle(String(x.title || ""), x.url) || String(x.title || ""), snippet: String(x.snippet || ""), fav: favOf(h, x.favicon || ""),
        w: x.publishedAt ? { t: Date.parse(`${x.publishedAt}T12:00:00Z`), exact: false } : null, ai: typeof x.ctRel === "number" ? x.ctRel : undefined, forum: forumOf(u, h) };
    }).filter((r) => r && r.title && relOk(r.title, r.href));
  };
  if (SHOW.forum) {
    const ex = G.forum ? [] : fetched("forums", (u, h) => forumName(u, h) || siteName(h));
    const fs = bShare("forums");
    box("forum", (r) => !!r.forum, 4, forumRow, "Discussions and forums", "forums", "More discussions", false,
      fs == null || G.forum ? null : place(worthOf(fs, rows.filter((r) => r.forum && r !== top).map((r) => r.ai).concat(ex.map((r) => r.ai)))), ex);
  }
  if (SHOW.papers !== false && !G.paper) {
    const ex = fetched("papers", (u, h) => siteName(h));
    const ps = bShare("papers");
    if (ps != null && ex.length >= 2) box("paper", () => false, 4, forumRow, "Research papers", "science", "More papers", false, place(worthOf(ps, ex.map((r) => r.ai))), ex);
  }
  // First-screen cutoff sample for the server (M2): the worth of the last result on screen, once per search,
  // measured after this pass is laid out, only while the page is still at the top
  if (fmt && !G.cut) {
    G.cut = true;
    requestAnimationFrame(() => {
      if (scrollY > 40 || searchId() !== key) return;
      const v = [...list.querySelectorAll(".result-item")].filter((el) => shown(el) && el.getBoundingClientRect().top < innerHeight);
      const r = v.length && info(v[v.length - 1]);
      if (r && typeof r.ai === "number") bridge("cut", { w: (fmt.text * r.ai).toFixed(4) }).catch(() => {});
    });
  }
  if (SHOW.video) box("video", (r) => r.video, 8, videoCard, "Videos", "videos", "More videos", true, place(CT.boxWorth(fmt, rows.filter((r) => r.video).map((r) => r.ai), "video")));

  // Images row: drawn after the first result in this same pass, only if the image search is already in hand
  if (!G.img) {
    G.img = true;
    const j = ready("img", key);
    const at = j && place(CT.boxWorth(fmt, (j.results || []).map((x) => x && x.ctRel), "image"));
    const t = j && [...list.querySelectorAll(".result-item")].find(shown);
    const th = visThr();
    const pics = j ? (j.results || []).filter((x) => x && x.thumbnail && x.url && relOk(x.title, x.url) && !(th && VS.p.get(origOf(x.thumbnail)) < th.low) && !aiImg((() => { try { return new URL(x.url).hostname.replace(/^www\./, ""); } catch { return ""; } })())).slice(0, 12) : [];
    if (t && pics.length >= 4) {
      const s = section("ct-imgs", "Images");
      const [wrap, row] = scroller();
      for (const x of pics) {
        const a = mk("a", "ct-im"); a.href = x.url; a.rel = "noopener"; a.dataset.ctV = origOf(x.thumbnail);
        a.title = String(x.title || "");
        const i = mk("img"); i.alt = String(x.title || ""); i.decoding = "async"; i.loading = "lazy";
        i.onload = () => i.classList.add("ct-on"); i.onerror = () => { i.style.visibility = "hidden"; };
        i.src = x.thumbnail;
        a.append(i); row.append(a);
      }
      s.append(wrap);
      const m = moreBtn("More images", "images"); if (m) s.append(m);
      if (at && at.before) at.before.before(s); else if (at) endOf(at.after).after(s); else t.after(s);
      wrap.upd();
    }
  }
  // Top stories: only when the results look like news (hot). Drawn in this same pass, before paint, and only if the
  // News answer started at page load is already in hand; otherwise nothing is added and the search is remembered,
  // so the next visit starts the News search early. Fresh stories only, one per outlet, none already shown.
  if (SHOW.news && !G.news) {
    const ns = bShare("news");
    if (ns == null && !hot(rows)) return;
    G.news = true;
    const q = new URLSearchParams(location.search).get("q") || "";
    if (!q) return;
    newsy.add(qHash(q));
    const j = ready("news", key);
    if (!j) return;
    const onPage = new Set(rows.map((r) => r.href.split("#")[0]));
    const seen = new Set();
    const items = (j.results || []).map((x) => {
      let u; try { u = new URL(x.url); } catch { return null; }
      const h = u.hostname.replace(/^(www|m)\./, "");
      const rel = /(\d+)\s+(minute|hour|day)s?\s+ago/i.exec(x.snippet || "");
      const w = rel ? when(rel[0]) : x.publishedAt ? { t: Date.parse(`${x.publishedAt}T12:00:00Z`), exact: false } : null;
      return { h, href: x.url, title: cleanTitle(String(x.title || ""), x.url) || String(x.title || ""), w, thumb: x.thumbnail || "", fav: favOf(h, x.favicon || ""), ai: x.ctRel };
    // Real News answers carry no date at all (recorded steelers/nvidia: 0 of 55 dated), so undated stories count as
    // current (a News search returns current news) and keep degoog's order; one dated older than fresh() is left out
    }).filter((r) => r && r.title && (!r.w || fresh(r.w)) && !onPage.has(r.href.split("#")[0]) && !seen.has(r.h) && seen.add(r.h)).slice(0, 8);
    if (items.length < 3) return;
    const t = [...list.querySelectorAll(".result-item")].find(shown);
    if (!t) return;
    const s = section("ct-news", "Top stories");
    const [wrap, row] = scroller();
    items.forEach((r) => row.append(storyCard(r)));
    s.append(wrap);
    const m = moreBtn("More news", "news"); if (m) s.append(m);
    const at = place(worthOf(ns, items.map((r) => r.ai)));
    if (at && at.before) at.before.before(s); else if (at) endOf(at.after).after(s); else t.after(s);
    wrap.upd();
  }
};

