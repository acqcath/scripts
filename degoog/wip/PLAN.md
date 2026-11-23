# v50 work order (overrides "Next" in HANDOFF.md)

The user checks a preview build on Tuesday morning before deeper work. Everything is ordered so nothing is built twice and each step unblocks the next.

## How to work (cuts wasted effort)
- Order: pure logic + unit test → wire into the page pass → check on recordings (rec/ct-recordings.json.gz). Run headless screenshots once per milestone, not per feature.
- Every page change goes into ONE synchronous pass in the MutationObserver, in this order: dedupe → site prefs → cap folds → snippet/title cleanup → answer/slot placeholders. Never add a second observer or a later fix-up.
- Batch all live web checks for a milestone into one run, done once.
- Reuse v49 code where it already meets the spec. Delete v49 code that breaks it, rather than patching around it.
- Before ending a run, leave the branch green: tests passing, files parsing.

## M1: Morning preview (target: before ~9 AM Tue)
Biggest visible wins and the base for everything else:
1. Wire core.js into script.js's pass: dedupe with "PDF · HTML · v7 latest" alt links; site cap 2 with "N more from site.com ⌄" expanding in place; snippet date moved to the source line, with junk ellipses removed.
2. Remove v49's after-paint jumps. Each one either gets space reserved at its exact size before paint or is dropped:
   - Did you mean
   - Related searches
   - People also ask
   - Sitelinks, forums and video boxes that move results
   - Top stories insert
   - fetched glance card
   - HD swap: becomes a same-size crossfade
3. PSL as a cached static file (/public/ct/psl.<hash>.js, defer). The installer writes it.
4. Preview installer: degoog/wip/install-preview.ps1. It is the v49 installer with the new files and prints "clean-titles v50-preview". Running main's installer restores v49. The user runs:
   `irm "https://api.github.com/repos/acqcath/scripts/contents/degoog/wip/install-preview.ps1?ref=v50-wip" -Headers @{Accept='application/vnd.github.raw'} | iex`
5. Check: replay the 54 recorded searches in jsdom (count merges and folds per search), plus headless Chrome at 390 and 1280 on 5 cases (react useEffect cleanup, attention is all you need pdf, how to reset airpods, best mechanical keyboard reddit, apple support). Layout shift must be 0.
6. Write degoog/wip/PREVIEW.md: what changed, what to look at, and how to roll back. Keep it short; the user reads it in the morning.

## After M1
Go straight on to M2 with no pause. After each milestone, update install-preview.ps1 and PREVIEW.md, so the user's morning preview includes whatever is finished by then, not just M1.

## M2: Sites control + anti-SEO
Replace Rank/Block with Prefer/Normal/Lower/Hide (menu + Settings, one list), then anti-SEO auto-Lower, the paywall tag, and the images-only blocklist.

## M3: Answer card base (local, no network)
Slot with reserved exact heights. Math, units, cooking, tip/percent, date math, patterns with checksums, CMU pattern gating. Then the ai-summary TTL patch and the AI 3-line clamp spot.

## M4: Network answers + CMU card + knowledge panel
Batch the live checks: CMU API + rating indexes, Wikidata, ECB, ESPN, endoflife.date. RAM cache.

## M5: Same-shape results, intent clarity, archive, quick view, images row, !deepl, carried-over values

## M6: Full test pass, installer self-check table, line-by-line audit → READY TO SHIP
