# Run budget (each run reads this and logs to it; Claude in the main chat recalibrates the caps from the user's real usage)

## Caps (set from real data; change only when the main chat updates them)
- Weekly window: resets Wednesday 12:00 PM America/New_York.
- Working runs allowed per weekly window: 10. Tentative: per-run cost is not measured yet. The user keeps 20% of the week, so the target is the weekly bar at 80% or less at reset.
- At most 2 working runs per 5-hour session window. The user's session resets at 4:00 AM ET, then every 5 h (9, 14, 19, 0). This leaves the user room in their own sessions.

## Rule for each run (the schedule fires hourly; most fires should exit in seconds)
1. If LOCK is fresh → exit.
2. If READY TO SHIP → exit.
3. Count the log lines since the last Wednesday 12:00 PM ET. If >= the weekly cap → exit.
4. Count the log lines in the current 5-hour session window. If >= 2 → exit.
5. Otherwise work. Add a log line at the start and update it at the end.

## Log (UTC start, UTC end, setup min, work min, items done)
- 2026-11-23 05:10, 05:3x, ~5, ~20+, M1 item 1 + most of item 2 (first run, old instructions)
