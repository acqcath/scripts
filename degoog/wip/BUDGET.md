# Run budget (each run reads this and logs to it; Claude in the main chat recalibrates the caps from the user's real usage)

## Caps (recalibrated 2026-11-23 05:58 UTC from the user's usage page; these override the run prompt)
- Measured 05:45 -> 05:58 UTC (13 min; this run worked ~6 of them, the main chat ran too): session 69% -> 79%, weekly 42% -> 44%. That's ~0.77% session and ~0.15% weekly per minute, combined. The weekly figure has +-1% rounding, so plan on the worse end: ~0.18% weekly per work-minute.
- ET = UTC-5 (EST, until 2027-03-14).
- NIGHT = a run starting 1:00-9:59 AM ET (06:00-14:59 UTC). The user is asleep: use as much of each session as it allows. No per-window limit. Each run: at most 90 work-minutes (keeps the context fresh), then end cleanly; the next hourly fire carries on. Getting cut off by the session limit is expected and fine.
- DAY = any other start time. The user keeps ~30% of each session for themselves: work-minutes logged in the trailing 5 hours (count overlap) must stay <= 100. That's ~70% of a session at ~0.7%/min (a guess; recalibrate). Each day run: at most min(60, 100 - trailing-5h minutes).
- Weekly: the window resets Wednesday 12:00 PM ET (17:00 UTC). The user keeps 10% of the week (lowered from 20% on 2026-11-23 at their request), so runs may use up to 90% - 44% = 46% more. That's ~255 more work-minutes, so the cap is 270 logged work-minutes in total since the last reset (~15 were logged before this recalibration). After the reset: 400/week until the main chat recalibrates.

## Rule for each run (the schedule fires hourly; fires that exit should take seconds)
1. If LOCK is fresh → exit.
2. If READY TO SHIP → exit.
3. Sum the logged work minutes since the last Wednesday 12:00 PM ET. If >= the weekly cap → exit.
4. If it's DAY and the trailing-5h work minutes are >= 100 → exit.
5. Otherwise work until the run's limit (NIGHT 90; DAY as above) or the weekly cap, whichever comes first. Add a log line at the start. After EVERY commit, update its work minutes (a run cut off by the session limit still has to count), and finish it at the end.

## Log (UTC start, UTC end, setup min, work min, items done)
- 2026-11-23 05:10, 05:30, ~5, ~15, M1 item 1 + most of item 2 (first run, old instructions)
- 2026-11-23 05:52, 06:11, ~2, ~21, M1 done (items 2-6: Top stories, News layout, PSL file, preview installer, headless CLS 0, PREVIEW.md); M2 site choices menu built; Settings-list design notes
