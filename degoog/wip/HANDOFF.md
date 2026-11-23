# clean-titles v50: build notes (branch v50-wip)

**Read PLAN.md first: its work order overrides the "Next" section below. M1 (morning preview) comes first.**

The spec is the user's handoff text (they paste it into each new chat). These notes cover only what has been decided or verified since then.

## Decisions (made with the user)
- AI spot: reserve a fixed 3-line clamp + ⌄ expand; if the AI fails, the same box shows "AI summary unavailable" (same size, so no shift).
- Network answers (Wikidata, ESPN, endoflife.date): cache them in RAM only, under a hashed key, with the same 12 h TTL as degoog's engine cache. Never written to disk; gone on restart. This is so repeat searches have the answer ready before paint.
- Public suffix list: 76 KB even in tree form (data/psl.enc via enc.py), and degoog doesn't compress pages. So it ships as a versioned static file loaded with `defer` before the ct-inline module, cached immutable; it is not inlined. Before using it, verify which public path degoog serves statically (check src/server for serveStatic or a public dir). The user's blocker only rejects /api/plugin/ and GET /api/command.
- v50 ships to main once, when every test passes. WIP lives on branch v50-wip under degoog/wip/.
- Parallel help: only self-contained research goes to background helpers. All code stays in the main chat, for consistency.

## Verified in degoog 1.2.0 source (degoog-org/degoog @ 2026-11-22)
- Results render once: renderResults sets `#results-list.innerHTML` from state.currentResults (search-templates/result.html). The MutationObserver runs before paint, so reorder/merge there.
  - Progressive streaming exists (performStreamingSearch, `streamsProgressively(config)`). The user ruled streaming out; the installer self-check must confirm streaming is off in server settings.
- Slots: prepareResultsUi() calls streamSlotPanels(query) and streamGlancePanels(query) at search start, before results. renderSearchResponse calls them again with results (waitForResults plugins).
  - Glance panels go into #at-a-glance; others go into slot containers by order (render-slots.ts placeByOrder).
  - So slot cards can land after results paint: reserve exact height only for cards that are sure to arrive.
- Result DOM: `.result-item > .result-item-inner > [.result-thumbnail-wrap] + .result-body > .result-url-row (favicon, cite, .result-actions[data-host] menu with #result-action-block/score-N) + a.result-title + p.result-snippet (.result-date first) + .result-engines (sources)`.
- layout.html is re-read on every page load (render.tsx getLayout uses Bun.file). So the server plugin can rewrite the data/ct-inline block, e.g. when a list changes daily, and it takes effect on the next page load.
- v49 has after-paint insertions that v50's rules forbid. Fix each one:
  - extras(): Did you mean, Related searches
  - paa(): People also ask, after the 3rd result
  - groups(): sitelinks, forums and video boxes moving results
  - Top stories: an async /api/search?type=news insert after result 1
  - glance(): fetched card
  - hdImg swap (needs a same-size crossfade)
  - getDesc text append (iPhone video descriptions are ruled out: check this is phone-gated; PC only)
- v49 installer does one-time downloads (words/pairs/names) inside the installer. The spec says no one-time setup in the installer, so move these to the plugin's lazy init.

## Real data from the user's server (recorded 2026-11-23)
- degoog/wip/rec/ct-recordings.json.gz holds 54 real searches through their degoog: 50 web, plus images for eiffel tower and golden gate bridge, and news for steelers and nvidia. Fields: title, url, snippet, sources, publishedAt, thumbnail, imageUrl, duration, plus engine timings.
  - It also has their real page HTML (`page`), their real compiled CSS (`css`: theme style.css, /api/plugins/styles.css, fontawesome) for headless screenshots, non-secret server settings, and the installed plugins.
  - Use these for every "real search" test. Never invent results.
- Settings confirmed: streamingEnabled = false (progressive rendering is off: results render once). domainBlock/Score/Replace are enabled, as is infiniteScroll.
- Static files: the page loads /public/themes/degoog-theme/style.css?v=1.2.0, so degoog serves /public/* statically from /app/src/public. Ship the PSL as /public/ct/psl.<hash>.js there (written by the installer and the server plugin), loaded with defer.
- ai-summary is installed as plugins/degoog-org-official-extensions-ai-summary. `const SHORT_TTL_MS = 2 * 60 * 1000;` appears exactly once (plus 2 uses). Patch only the const line.
- Installed plugins: clean-titles, ai-summary, define, math-slot, time, weather.

## Done
- files/core.js: pslParse, regDomain, docKey, titleKey, dedupe (+arXiv PDF/HTML/vN alts), capSites, namedSites, cleanSnippet, relDate, upsValid, isbnValid, cmuCourse.
- Run 2026-11-23 05:10 UTC (step 3, part 1):
  - core.js: `deduper` (incremental, for endless-scroll pages), `listCtx` + `planPage` (dedupe -> site prefs -> 2 per site with folds, one pure plan the page applies), `dateLabel`, regDomain without a PSL (host minus www./m., never a guessed suffix), site words that name a site (mdn -> mozilla.org, npm -> npmjs.com, pip/pypi -> pypi.org; from the recorded searches).
  - script.js wired: `listPass` runs first in every observer pass (Web tab), then `scan` (row cleanup), then groups, then `foldPass` ("N more from site ⌄" under the site's last shown result on the same page; tap opens the results in place where the line was). Hidden results carry data-ct-dup / data-ct-hide / data-ct-cap (cap ones stay usable as sitelinks, as in v49). v49's per-host cap (perSite) is gone.
  - Snippet cleanup: core cleanSnippet on the first text node; degoog's `.result-date` (else the leading date from the text) moves to the source line as `span.ct-date` ("site · yesterday"), via dateLabel.
  - After-paint fixes: groups() no longer waits for the prefs bridge (switches read from localStorage "ct-show", switch values only; a change applies from the next page load; missing = on). HD thumbnails: same-size opacity-only crossfade (decoded overlay `img.ct-hd`), no more src swap, and a frame degoog hid stays hidden. YouTube description append cut (page + server /ytdesc route + ytDesc).
  - Build: `python3 build.py` -> files/ct-page.js = core.js wrapped as `CT` + script.js. The installer must embed ct-page.js as its script.js (layout.html inlines one module, so no imports).
  - Tests: 25 pass. New test/page.test.js runs the built page script in happy-dom on real recorded results rendered with degoog's own result.html (test/fixtures/result.html, degoog e006d50). Needs `bun install` in degoog/wip first (package.json, happy-dom 15.11.7; node_modules ignored).

## Verified this run
- Real recordings, dedupe -> cap (results in -> after dedupe -> shown): airpods 29 -> 26 -> 21; mdn array map 28 -> 28 -> 17 before the site-word fix (mozilla.org 10 folded), now uncapped; is windows 10 supported 28 -> 28 -> 22 (6 microsoft.com folded under end-of-support). No recorded search reproduces "18 -> 6"; that figure came from an earlier hand-picked set. Real numbers are in the tests instead.
- On airpods, sitelinks + Discussions + Videos boxes take every capped result, so no fold line appears: correct (nothing shown twice).
- Same-title-within-site merges two different YouTube IDs with the same title (8lnlUrHBqOE vs D0LZz3Zxk00, re-uploads): kept as intended (spec: reposts).
- degoog's resultFadeIn also slides 8px (_results.scss), so the image crossfade uses its own opacity-only keyframes (ctXfade, same .3s).

## Assumptions (this run)
- Prefer/Lower reorder only within one endless-scroll page; a fold is only made under a result on the same page (one above would move what's on screen). Later-page extras are just hidden.
- Site prefs come from `window.CT_DATA.sites` ({domain: "prefer"|"lower"|"hide"}), compiled into the inline block by the server. Not built yet: until then every site is Normal.
- PSL is read from `window.CT_PSL` (string), set by /public/ct/psl.<hash>.js loaded with defer before the module (defer and module scripts run in document order).
## Next
- Step 3, part 2 (after-paint items still open):
  - News tab `ct-lowres`: the class is added once the picture loads and switches the card layout (banner -> 92px thumb) after paint. Fix: decide before paint from URL size hints (Bing th?w=&h=, Brave), else always the thumb layout on that tab. Measure on the recorded news searches (steelers, nvidia) first.
  - Top stories: the /api/search?type=news insert after result 1 lands after paint and isn't sure to arrive. It can't be reserved, so the choices are: drop it unless ready before paint, or cut it. Running a news search for every query breaks "cheap". Suggested: keep the "newsy" test (spec item 15: set "fresh" and the threshold from the recorded news searches) and only use news results already in degoog's cache. If that isn't possible in 1.2.0, cut it and write down why.
  - extras() (Did you mean, Related), paa(), glance() fetched card: check each for after-paint inserts; reserve exact size or drop.
  - Title cleanup audit (cleanTitle runs in row() before paint: OK; check nothing else rewrites titles later).
- Site prefs UI (Prefer/Normal/Lower/Hide in the result menu and Settings) + server compiling CT_DATA.sites into the inline block.
- Headless Chrome check of fold line, date on source line, crossfade at 390/1280 with the recorded CSS (rec `css`), CLS = 0.
- Still to do for core: repost (same title + author), translations beyond locale paths, proceedings copies. FedEx check digit is not implemented: find a verified algorithm and a known-valid number before shipping, or require "fedex" in the search.
- Live source report: SOURCES.md does not exist yet. Rerun that check (WebFetch, one fetch per source).

## Cuts (with reasons)
- YouTube description fetch (PC too, not just phones): it appended text to a result already on screen, which grows it and moves everything below, and it isn't sure to arrive, so no space can be reserved. The rules forbid both. Removed from the page script and from the server (/ytdesc).
