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
- test/core.test.js: 12 tests pass (`cd degoog/wip && bun test`).
- Still to do for core: repost (same title + author), translations beyond locale paths, proceedings copies. Also check "18 → 6" on real recorded results. FedEx check digit is not implemented: find a verified algorithm and a known-valid number before shipping, or require "fedex" in the search.

## Next
- Step 3: wire core into script.js's MutationObserver pass, in this order: dedupe → site prefs (Prefer/Normal/Lower/Hide) → cap folds → snippet cleanup → title cleanup. Then fix every after-paint item above.
- Live source report from the helper: see SOURCES.md (if missing, rerun that check).
