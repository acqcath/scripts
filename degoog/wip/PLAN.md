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
### M3: copies + variety
Copies fold into "+N similar pages" when title and snippet match after normalizing (one contains the other).
Variety tie-break by content similarity, built but off until ⚑ "wrong order" reports give the margin.
### M4: answer card shape + contested check
Shape (steps / X-vs-Y table / timeline / chart picture) from the needs call; text from ai-summary's model.
Contested check: ai-summary's model, question-style searches only (from the needs call); the both-sides panel is
inserted below the fold, so it never moves what is being read (the user agreed this beats reserved empty space).
### M5: unsolved-search learning
Private server log (search, time, last result opened). A next search within minutes -> ai-summary's model asks
"same need or next question?"; only "same need" marks the earlier one unsolved, and the last result opened before a
solved search is its solver. Nudges block shares for similar needs profiles. ⚑ notes fix general rules.

## Test budget
Unit tests + jsdom replay every milestone; headless layout-shift + screenshots at 390/1280 only at M1 and M5; the
self-check row is the live GPU check (the sandbox can't run the model).
