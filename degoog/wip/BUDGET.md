# Run budget (each run reads this and logs to it; Claude in the main chat recalibrates the caps from the user's real usage)

## Caps (recalibrated 2026-11-23 05:58 UTC from the user's usage page; these override the run prompt)
- Measured 05:45 -> 05:58 UTC (13 min; this run worked ~6 of them, the main chat ran too): session 69% -> 79%, weekly 42% -> 44%. That's ~0.77% session and ~0.15% weekly per minute, combined. The weekly figure has +-1% rounding, so plan on the worse end: ~0.18% weekly per work-minute.
- Weekly window resets Wednesday 12:00 PM America/New_York (17:00 UTC). The user keeps 20%, so runs may use up to 80% - 44% = 36% more. That's ~200 more work-minutes, so the weekly cap is 220 logged work-minutes in total since the last reset (including the ~15 already logged before this recalibration).
- The session limit (resets 4:00 AM ET, then every 5 h) cuts a run off after ~25-30 min when it starts near 70%. That's fine: commit after every item, and the next fire picks it up.
- Each run: at most 60 work-minutes. At most 2 working runs per 5-hour session window.
- After the Wednesday reset, the cap is 400 work-minutes per week until the main chat recalibrates.

## Rule for each run (the schedule fires hourly; most fires should exit in seconds)
1. If LOCK is fresh → exit.
2. If READY TO SHIP → exit.
3. Sum the logged work minutes since the last Wednesday 12:00 PM ET. If >= the weekly cap → exit.
4. If 2 working runs have already started in the current 5-hour session window → exit.
5. Otherwise work, stopping at 60 work-minutes or the weekly cap, whichever comes first. Add a log line at the start and update it at the end.

## Log (UTC start, UTC end, setup min, work min, items done)
- 2026-11-23 05:10, 05:30, ~5, ~15, M1 item 1 + most of item 2 (first run, old instructions)
- 2026-11-23 05:52, (running), ~2, -, (in progress; 2nd run in 05:00-10:00 UTC window)
