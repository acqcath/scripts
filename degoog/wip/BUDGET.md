# Run budget (each run reads this and logs to it; Claude in the main chat recalibrates the caps from the user's real usage)

## Caps (recalibrated 2026-11-23 05:58 UTC from the user's usage page; these override the run prompt)
- Measured 05:45 -> 05:58 UTC (13 min; this run worked ~6 of them, the main chat ran too): session 69% -> 79%, weekly 42% -> 44%. That's ~0.77% session and ~0.15% weekly per minute, combined. The weekly figure has +-1% rounding, so plan on the worse end: ~0.18% weekly per work-minute.
- ET = UTC-5 (EST, until 2027-03-14).
- User's rule (2026-11-23 01:15 ET, live): "keep building, make the most of the credits, but I need at least 20% session credits during 10am-10pm ET; any other time I don't care."
- Session windows are anchored by the user's "limit breaker" task (fires 7:32 AM, 12:32 PM, 5:32 PM ET = 12:32, 17:32, 22:32 UTC). The three windows that touch 10 AM-10 PM ET are DAY windows: A 7:32 AM-12:32 PM, B 12:32-5:32 PM, C 5:32-10:32 PM ET (12:32-17:32, 17:32-22:32, 22:32-03:32 UTC).
- DAY window: runs together may log at most 100 work-minutes inside it (~0.77%/min -> ~77%, leaving >= 20% for the user). Count each run's minutes that fall inside the window (a night run spilling past 7:32 AM ET counts its spill). A run's limit = min(90, 100 - minutes already logged in the window); if that's < 10, exit at the gate.
- NIGHT = everything else (10:32 PM-7:32 AM ET = 03:32-12:32 UTC): no per-window limit, use it all. Each run at most 90 work-minutes (fresh context), then end cleanly; the next hourly fire carries on. Being cut off by the session limit is expected and fine.
- Weekly: the window resets Wednesday 12:00 PM ET (17:00 UTC). The user keeps 10% of the week (lowered from 20% on 2026-11-23 at their request; kept so daytime is never locked out by the weekly limit), so runs may use up to 90% - 44% = 46% more. That's ~255 more work-minutes, so the cap is 270 logged work-minutes in total since the last reset (~15 were logged before this recalibration). After the reset: 400/week until the main chat recalibrates.

## Rule for each run (the schedule fires hourly; fires that exit should take seconds)
1. If LOCK is fresh → exit.
2. If READY TO SHIP → exit.
3. Sum the logged work minutes since the last Wednesday 12:00 PM ET. If >= the weekly cap → exit.
4. If now is inside a DAY window and the run limit (100 - minutes logged in that window, max 90) is < 10 → exit.
5. Otherwise work until the run's limit (NIGHT 90; DAY window as above) or the weekly cap, whichever comes first. Add a log line at the start. After EVERY commit, update its work minutes (a run cut off by the session limit still has to count), and finish it at the end.

## Log (UTC start, UTC end, setup min, work min, items done)
- 2026-11-23 05:10, 05:30, ~5, ~15, M1 item 1 + most of item 2 (first run, old instructions)
- 2026-11-23 05:52, 06:11, ~2, ~21, M1 done (items 2-6: Top stories, News layout, PSL file, preview installer, headless CLS 0, PREVIEW.md); M2 site choices menu built; Settings-list design notes
- 2026-11-23 06:17, (cut off, no commits after lock), ~1, ~0, none
- 2026-11-23 09:17, (running), ~2, ~21, M2 done (Settings list, anti-SEO, paywall tag, AI-images list, shared fetch helper); M3 local answer card (in progress; took over stale 06:16 LOCK)
