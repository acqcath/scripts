# Results page shaped by what each search needs (approved by the user 2026-11-26; replaces the v50 work order)

Pacing: BUDGET.md. Each milestone is its own version: build, test, PR, merge per QUICKSTART (the user asked for
release + merge per step, so main moves every milestone; there is no long-lived WIP branch for this plan).
Status line for the scheduled runs: the first milestone below without [done] is next; all [done] = READY TO SHIP.

## Rules (from the user; never break)
- One scale: every block (web results, videos, pictures, forums, top stories, papers, info panel, answer card)
  competes by worth = its share for this search x how well its items fit. The AI rates the search's needs.
- Ruled out as the main method: hand-made word lists, fixed slots, magic thresholds, fixed category lists, hiding
  results, learning from raw taps, forced balance. Every constant is derived from data (measured) or the model.
- Learning tunes layout/format only, never sites or viewpoints; kept on the server; keyed by the needs profile.
- Variety: among results within the AI's measured margin, the one adding different content goes first. No quotas,
  no novelty bonus, no demotion for agreeing. Both sides only when credible sources actually disagree.
- Zero layout shift; phone and PC; never slows the core search.

## Milestones
### M1 = v61: needs call + media placement on one scale [done]
1. vision/app.py `/rank`: optional `tasks` (one instruction per doc) so many questions go in ONE batched pass.
2. index.js `/needs?q=`: one GPU call per search (cached): format (video / pictures / text), freshness, depth,
   trust, people's experience, doing vs knowing, plus each block's fit. Each is a described option scored by the
   reranker with its own instruction; shares normalized within each group. Returns {f, n, b, ms}.
3. Port media-wip: core fmtShares / boxWorth / boxAt; page places Videos box + Images row by them; images fetched
   when the pictures share beats an even split. Drop tapBias and the per-browser tap counts (raw taps: ruled out).
4. ⚑ flagTop also saves each result's AI score (ctRel) and the block order, so "wrong order" reports measure the
   tie margin.
5. ctcheck.js row "Needs call": times it, and checks the format judge (how-to-tie-a-tie -> video first; a notation
   question -> not video).
### M2 = v63: all blocks on one scale [done]
Forums, top stories, papers fetched (degoog types) only when share x 1.0 could beat the AI score of the last result
on the first screen; that cutoff = running median kept on the server from recent searches. Info panel and answer
card take their place by worth too.
Built: needs b gained `web` (plain web pages); a block's share = text share x b[kind] / b.web (core blockShare), so
blocks, videos and results share one scale. Cutoff: page sends the worth of the last first-screen result (`/cut`),
server keeps 200 in cut.json, `/needs` returns the median as `cut`; no samples = fetch. Papers = degoog type
science. Answer card / phone info panel: core boxAt from 0 via script.js byWorth (live sports and early exact
answers stay on top). Self-check rows: "Needs call: block judge", "First-screen cutoff store".
### M3 = v64: copies + variety [done]
Copies fold into "+N similar pages" when title and snippet match after normalizing (one contains the other).
Variety tie-break by content similarity, built but off until ⚑ "wrong order" reports give the margin.
Built: core copyKey/sameCopy in planPage (any site, transitive, ctx.copies across endless-scroll pages; fold key
`~sim:<doc key>`, page flag ctSim). core varietyOrder(items, margin) + VARIETY_MARGIN = null (off): to turn on, set
it from the ⚑ "order" flags' ai tie margins and call it on the shown items in listPass.
### M4 = v65: answer card shape + contested check [done]
Built: server /shape + /sides + needs group s; page shapeAsk/shapeBody/sidesPass + CSS. A shape picked by the needs
call keeps the word-match featured snippet out of the spot (the shaped answer is the richer answer). Self-check rows:
"Needs call: shape judge", "Shaped answer", "Contested check". Search time: DOI names and the reranker run side by
side (were serial: up to 0.9 s saved), the 1.6 s reranker wait is skipped once its measured median run is over it;
/speed + self-check row "Search time added by clean-titles" (median ms per search).
Shape (steps / X-vs-Y table / timeline / chart picture) from the needs call; text from ai-summary's model.
Contested check: ai-summary's model, question-style searches only (from the needs call); the both-sides panel is
inserted below the fold, so it never moves what is being read (the user agreed this beats reserved empty space).
### M5 = v67: unsolved-search learning [done]
Private server log (search, time, last result opened). A next search within minutes -> ai-summary's model asks
"same need or next question?"; only "same need" marks the earlier one unsolved, and the last result opened before a
solved search is its solver. Nudges block shares for similar needs profiles. ⚑ notes fix general rules.
Built: page sends only the block kind of a link you open (/seen, no address); /needs logs each search in learn.json
(30 days of words, counts per needs profile kept) without waiting; "within minutes" = under the median gap between
your searches (5+ gaps); ai-summary's model says SAME or NEXT. Factor per kind = (solves + 1) / (mean solves + 1),
each group's total kept (index.js nudgeNeeds). Settings switch "Learn the layout from searches". Self-check row
"Learning log". Headless layout check not run: needs the private rec/ recordings.

## Test budget
Unit tests + jsdom replay every milestone; headless layout-shift + screenshots at 390/1280 only at M1 and M5; the
self-check row is the live GPU check (the sandbox can't run the model).
### M6 = v70: product panel (from ⚑ 2026-11-28, "yamaha dbr10 release") [done]
User: a product info section whenever the search names a product, with all the needed info.
Plan: needs call gains a "product" fit; when it wins, read schema.org Product JSON-LD (+ og: tags) from the
top results already fetched for Quick view (maker page first, then retailers): name, picture, brand, price range
across sellers, rating, key specs (additionalProperty), release date (releaseDate / earliest dated result).
Placed by worth like the info panel; zero layout shift (reserved spot like the answer card).
Self-check row "Product panel" on a fixed product search.
Built: needs b gained `product`; page productPass asks /product (top 6 result addresses) once the results are drawn,
when core blockGo(blockShare(product), cut). Server productFrom (JSON-LD Product/ProductGroup + og:/product: meta),
productMerge (AI-best name leads the match; same product = same gtin/mpn or word-subset names; maker page = host
carries the brand, leads name/picture/specs; price range in the most common currency; rating with most reviews;
earliest releaseDate). Wide: right column (inside the info panel if shown). Phone: arrives late, so it goes in at
the first result below the screen (zero shift). Release date only from releaseDate (no "earliest dated result"
guess: a page date isn't a release date). Switch: the Knowledge panel setting. Self-check row "Product panel".

### Endless scroll (user, 2026-11-28: "the loading for when i scroll down is terrible ... keep [what's] at the top") [v90]
- The next page starts loading two screens before the end of the list (custom.css `.degoog-infinite`; was 320 px).
- What's already on screen never changes when a page goes in (page/08 `painted`): the top result's sitelinks and the
  forum/video boxes don't take results from later pages (they grew, so everything under them jumped), a box only a later
  page has enough for goes among that page's results; endless scroll's history rewrite is never a new search
  (page/01 `sgKey`, `loaded`), which would clear every box, card and fold above.
- Headless check (stub): `lost` 0, cls 0 with page 2, `ahead` 2120 px at 900 px tall.

### M7: notes match the code; clean, readable code; smoother page (user, 2026-11-28) [1-3 done (v85, v86); 4: v87 install batching, v88 pass timing in ⚑ ctx + headless stub (worst: list ~25 ms, gap ~15 ms, flag up to 24 ms per search), v89 cut them (list: public suffix list parsed at idle before the results, ~13 ms of it, and a faster parser; flag: phone placement in the next frame, no forced layout in the pass; gap: measures only the first showing result/picture/video, and skips batches that only change things below what it measured, so endless-scroll pages cost no gap pass; headless stub: realistic titles/sites + an endless-scroll page 2 with page2 ms and lost); next: 5]
User's words: every note must match the code (a stale note made Claude say updates install hourly; they install
~1 min after a merge); optimize and smooth everything; no spaghetti: code Claude can read, change and understand.
Each step is its own version; tests (`bun test`) stay green; behavior unchanged unless a step says so.
1. Notes audit: QUICKSTART, HANDOFF, PLAN, SPEC, PREVIEW, BUDGET, MAP, code comments and the user's degoog memory
   file, each claim checked against the code (grep the file:line), stale ones fixed or deleted. HANDOFF becomes
   history only; QUICKSTART + MAP are the source of truth.
2. script.js (2.7k lines) split by job into modules built by build.py (header/tabs, results rows, blocks/cards,
   ⚑ report, Tools, layout/gap, init); one observer pass calls them in a fixed order; dead code removed (e.g.
   tabsEdge's --ct-tabs-pr, unused since v82).
3. index.js (2.4k lines) split the same way (rank hook, typo fixer, routes, flags, AI calls, net); one route table.
4. Smoothness: measure layout shift and per-pass ms in the headless check (stub page when rec/ is absent), cut the
   worst passes (batch DOM reads before writes, no repeated getComputedStyle in loops); install: batch the ~30 docker
   calls before the restart.
5. MAP.md rebuilt; QUICKSTART updated with the new file layout.
