# Run budget (each run reads this and logs to it; Claude in the main chat recalibrates the caps from the user's real usage)

## Caps (from real data, 2026-11-23 ~05:45 UTC; these override the run prompt)
- Measured: weekly 37% -> 41% and session 40% -> 65% over ~35 min, during which the first run (~25 min of work) and the main planning chat (large context) both ran. Cost per work-minute isn't separable yet, so assume the worst: ~0.12% weekly per minute.
- Weekly window resets Wednesday 12:00 PM America/New_York. The user keeps 20%, so runs may use up to 80% - 41% = 39% before then. That's about 250 work-minutes total until the reset; count the logged work minutes.
- Each run: at most 60 work-minutes. At most 2 working runs per 5-hour session window. The user's sessions reset at 4:00 AM ET, then every 5 h. This leaves the user room in their own sessions.
- After the Wednesday reset, the cap is 400 work-minutes per week until the main chat recalibrates.

## Rule for each run (the schedule fires hourly; most fires should exit in seconds)
1. If LOCK is fresh → exit.
2. If READY TO SHIP → exit.
3. Sum the logged work minutes since the last Wednesday 12:00 PM ET. If >= the weekly cap → exit.
4. If 2 working runs have already started in the current 5-hour session window → exit.
5. Otherwise work, stopping at 60 work-minutes or the weekly cap, whichever comes first. Add a log line at the start and update it at the end.

## Log (UTC start, UTC end, setup min, work min, items done)
- 2026-11-23 05:10, 05:30, ~5, ~15, M1 item 1 + most of item 2 (first run, old instructions)
