# Run budget (each run reads this and logs to it)

## The user's limits
- Daytime (10 AM-10 PM ET): keep at least 20% of the session for them. Other hours: use it all.
- Weekly: keep the last 10% for them. The week resets Wednesday 12:00 PM ET.

## How to decide
- Cost per work-minute = measured, not assumed: (the user's latest usage reading - an earlier one) / work-minutes logged between them, over the longest span available. Latest: weekly 44% (2026-11-23 05:58 UTC) -> 70% (~16:25 UTC) over ~180 logged minutes = at most 0.145% weekly/min. Session cost per minute: unknown until two session readings span the same run; until then stop a daytime run after 60 work-minutes.
- A run's limit = whatever keeps both reserves, at most 90 minutes. Update with each new reading the user shares.

## Rule for each run
1. Exit if LOCK is fresh (< 100 min), HANDOFF says READY TO SHIP, or WAITING exists.
2. Exit if the limit above is under 10 minutes.
3. Otherwise log a start line, work, update the line after every commit, finish it at the end.

## Log (UTC start, UTC end, setup min, work min, items done)
- 2026-11-23 05:10, 05:30, ~5, ~15, M1 item 1 + most of item 2 (first run, old instructions)
- 2026-11-23 05:52, 06:11, ~2, ~21, M1 done (items 2-6: Top stories, News layout, PSL file, preview installer, headless CLS 0, PREVIEW.md); M2 site choices menu built; Settings-list design notes
- 2026-11-23 06:17, (cut off, no commits after lock), ~1, ~0, none
- 2026-11-23 09:17, 10:05, ~2, ~46, M2 done (Sites list in Settings, anti-SEO auto-Lower, Paywall tag, Images-tab AI list, shared fetch helper); M3 done (local answer card, ai-summary TTL patch, AI spot); M4 currency, endoflife.date, Wikidata facts, CMU card, sports, knowledge panel server part (took over stale 06:16 LOCK)
- 2026-11-23 10:16, 10:56, ~2, ~38, M4 knowledge panel page UI; preview installer + PREVIEW.md for M4; M5 same-shape results, !deepl, carried-over values, archive, images row, quick view + inline stars, meaning line (M5 done); preview installer + PREVIEW.md; M6 installer self-check table, per-feature Settings switches, design audit fixes, NeurIPS dedupe, line-by-line audit, installer downloads moved into the plugin
- 2026-11-23 11:16, 11:18, ~1, ~2, page-part notice after degoog updates; PREVIEW self-check note
- 2026-11-23 14:48, 16:06, ~3, ~80 (live with the user), tab skew, READY TO SHIP; adult-by-relevance, record-tabs.ps1, all-PASS round 3, install.ps1 v50 built; look pass (spaces, icons, header, rhythm, news, science); featured snippet; round 2: Wikidata throttling, curl-impersonate retry, searx safe search; video stills for YouTube cards; self-check round 1: KP subclass fix, Wikidata hardening, FAIL reasons (/why), sequential self-check, Safe Search off (safeoff.js), touchy-search check; PREVIEW + preview installer
