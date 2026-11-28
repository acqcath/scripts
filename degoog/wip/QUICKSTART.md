# clean-titles: quickstart (read this instead of all of HANDOFF.md; grep HANDOFF.md for details)

## Every degoog chat, first: Flags
⚑ (degoog's tab row, every tab) saves reports on the server: the search, tab, chosen problem chips (core FLAG_CATS), optional note, context (viewport, load ms, visible blocks), top 10 results.
The ⚑ shows nothing else (no count, no send link: the user asked). The PC's update job (../autoupdate-job.ps1
`SendReports`) sends them into ONE standing cloud session with `claude -p --cloud <id> --output-format json` (prompt
on stdin; `claude --cloud "<task>"` fails from a background job: "requires an interactive terminal"). The id lives in
%LOCALAPPDATA%\clean-titles\reports-session.txt; `New-ReportsSession` makes it once (at most one try a day) by running
`claude --cloud` inside `conhost --headless` and reading the id off that console, else in a visible window with a
notification. Archived/not-found session = a new one. Everything waiting goes as soon as a ⚑ is saved (or the updater
hit a problem, `updateIssue`); the server marks them sent. Each report has an `id`: put the ids a release fixes in
files/fixed.json ({"id": "vNN"}); build.py builds it in (CT_FIXED) and the installed version shows the user one
"Fixed in vNN" note (page/06 `fixedNote`, route `/fixednews`), once, on whichever device opens degoog first. The job installs Git and the Claude CLI itself. No separate flags repo (the user won't
create one; add_repo for a new repo is refused): a Report session gets every flag in its prompt.
1. Fix each flag at the code level (core.js / files/page / files/server modules, see below: ranking, relevance, junk rules, or the ⚑ box itself),
   add a test from the flag where possible (no searches from flags in this public repo), release, merge.
   If the problem can happen elsewhere too (phone and PC, other tabs, other browsers), fix it there as well, not only
   where it was reported (the user, 2026-11-28).
2. `updateIssue` = the installer's self-check output after the auto-update: fix the FAIL rows like any other bug.
3. Live look at the server (degoog.tigon-cat.ts.net, built-in browser): the pane treats it as high-risk, so EVERY
   action (each load, each JS call) needs its own approval and "site" access is never saved. Read the code first. If a
   live look is still needed: tabs_context first (free) and reuse a pane tab already on the site, so the look is ONE
   javascript call (1 approval); only if none: one load of a search page, then ONE javascript call that does everything through
   same-origin fetches (no further loads): status first via the bridge, e.g.
   `const b=(r,p={})=>fetch("/api/command",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:"!cleantitles bridge "+r+" "+new URLSearchParams(p)})}).then(x=>x.json()).then(j=>{const t=document.createElement("textarea");t.innerHTML=j.html;return JSON.parse(t.value)}); await b("status")`
   -> {ver, pageMissing, ai, flags, issue}. CT_VER is module-scoped (not on window). Max 2 approvals per look (1 with a reused tab); never
   a third: ask the user instead. No screenshots.
   No live look right after a merge: the PC installs it as soon as degoog is idle and degoog restarts, so the look fails or shows the old version.

Where code lives: **[MAP.md](MAP.md)** (every section, function and route with file:line; rebuilt by build.py). Read
only those lines (`sed -n A,Bp files/x.js`).

## Where things are (degoog/wip/files)
Code is split by job into modules that build.py concatenates in NN order into ONE scope (no imports between them):
- server/NN-*.js -> index.js (the server plugin; generated, never edit it). 01 setup + Sites, 02 `net()` (every
  outside fetch), 03 card data (fx, eol, Wikidata, CMU, KP), 04 tap-fetched pages (archive, quick view, product),
  05 sports, 06 anti-SEO, 07 typo fixer (`check`, `TREND`, `NAMES`), 08 ct-vision calls, 09 ⚑ flags (`flagPrompt`,
  flags.json, update-issue.txt written by ../autoupdate-job.ps1 `Issue`), 10 `/needs` (`NEEDS`, `needsFor`: one
  batched reranker pass per search; vision `/rank` takes per-doc `tasks`) + cutoffs + learning, 11 shape/sides +
  the rank hook `__ctResults` (reranker scores, featured snippet, DOI names, 1.6 s wait), 12 `routes` (the one table).
- page/NN-*.js -> ct-page.js after core.js + answers.js (pure logic, exported as CT.*). 01 bridge + search identity,
  02 `row()` and the list/tab/relevance passes, 03 image AI + cards, 04 early answers + typo/related line, 05 site
  menu, PAA, Tools, 06 ⚑ (`flagBtn`/`flagBox`; chips from core `FLAG_CATS`), 07 top gap + skeletons, 08 blocks
  (forums, videos, top stories), 09 answer card, 10 quick view + panels, 11 tab repair + `init` (one observer pass
  runs listPass/tabPass/relPass/ansPass before paint; every pass goes through `safe(name, fn)`, which adds its ms up
  per search for the ⚑ context and the headless check).
- Page speed rules (v89): no layout reads in a pass unless it must measure before paint (topGap); a placement that can
  wait goes in the next frame (⚑ on phones); one-time parsing (public suffix list `PSL()`) at idle before results;
  `gapSkip` skips topGap when a batch only changed things after what it measured (endless-scroll pages, folds).
- Endless scroll (v90): the next page starts loading two screens early (custom.css `.degoog-infinite`); nothing
  already on screen changes when a page goes in (page/08 `painted`: sitelinks and boxes never grow from later pages);
  its history rewrite (`loaded`) is never a new search (page/01).
- Blocks are placed by core `fmtShares`/`boxWorth`/`boxAt`, each block's share by core `blockShare` x fit; fetch gate
  `blockGo` vs `/cut` median (cut.json). Plan + milestones: PLAN.md.
- Search identity (page/01): `searchId()` = address + a counter bumped by each degoog search start (its history
  entries {degoog:true,...}: every push, or a rewrite with a new query/page; popstate). Never key per-search state
  by the address alone (Web -> News -> Web -> News once hid all of News's results; fixed v84).
- Loading placeholders (page/07): `skel` redraws degoog's skeletons from shapes `skelLearn` measured on the last real
  results (localStorage ct-skel, per tab/device/50 px width); Images uses the real grid CSS + measured picture
  shapes; `picLoad`: shimmer until loaded, first 18 pictures eager.
- custom.css, vision/app.py (reranker + image AI on the GPU), ctcheck.js (installer self-check table).

## Build, test, release
1. `cd degoog/wip && bun install && CT_VERSION=vNN python3 build.py && bun test` (tests load the BUILT files/ct-page.js and files/index.js: rebuild after any module/core.js edit or the test runs old code; happy-dom has no `:scope`, use `[...g.children].find`) (46 tests skip: they need private recordings in rec/).
2. `CT_VERSION=vNN python3 build.py && python3 patch_installer.py vNN` writes ../install.ps1 and checks every embedded file round-trips.
3. Branch, push (`git -c push.negotiate=true push -u origin vNN`), open the PR with `gh api repos/acqcath/scripts/pulls -f title=... -f head=vNN -f base=main -f body=...` (`gh pr create` fails: GraphQL blocked). Each version branches from a fresh `git fetch --depth=5 origin main && git checkout -B vNN origin/main` (main is squash-merged, so a branch off the last version branch conflicts). Right after a push, merge can say "conflicts" while GitHub recomputes: wait ~10 s and retry once. Then merge it yourself as its own command: `gh api -X PUT repos/acqcath/scripts/pulls/N/merge -f merge_method=squash` (if the safety check blocks it, leave it open, build the next version on top, merge both with the next PR, and tell the user). The PC's watcher installs main right after the merge, once degoog has had 15 s without use and no full-screen app runs (see "PC watcher" below).

## Sandbox limits (save the time)
- Push 403 = the session lacks write access: call add_repo(acqcath, scripts, access="push") first, then push. The merge call can be refused by the auto-mode safety check: push + open the PR, then ask the user to approve the merge in chat.
- Headless check: `npm i playwright-core` in the scratchpad, then `CT_CHROME=/usr/bin/google-chrome CT_PW=<scratch>/node_modules/playwright-core node test/headless/run.cjs <outdir>` (~90 s). Without the private rec/ it runs on a stub page (degoog's ids, header and tabs, 30 made-up results on 9 sites, 20 with the search and 10 as endless scroll's page 2; no degoog base CSS, so layout shift is indicative, pass ms are real). Columns: cls (0), slow (5 slowest passes, ms per search), lost (0: nothing above endless scroll's page 2 went away), ahead (px before the end where the next page starts loading), page2 (its slowest passes). Exit 1 if cls, lost or errors aren't 0.
- Render check for page/CSS changes: the headless check's screenshots (390 and 1280 wide, one per search) in <outdir>.
- Fastest clone (~1 s, 3 MB, only degoog/): `git clone --depth 1 --filter=blob:none --sparse https://github.com/acqcath/scripts && git -C scripts sparse-checkout set degoog`. A full `git clone --depth 1` needs a ~10 min timeout. degoog's source: `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/degoog-org/degoog` (client: src/client; tabs modules/tabs/tabs.ts; search utils/search/actions/search-actions-perform.tsx).
- PC watcher (v93; the user: no checking on a timer, no backups, one silent sleeping watcher for everything):
  ../autoupdate-job.ps1 `$watcher` (written to %LOCALAPPDATA%\clean-titles\watcher.ps1 by `Setup-Watcher`, started
  hidden at logon from the Startup folder, single instance by a mutex, below normal priority, restarts itself when a
  release changes it). It sleeps inside `docker exec ... bun /tmp/ct-wait.js` (files/ct-wait.js), which returns only
  on: a release (ntfy.sh topic degoog-ct-acqcath-9f4k2x7q, pinged by .github/workflows/degoog-ping.yml on pushes to
  main under degoog/; confirmed with git ls-remote, so a stray ping is harmless), a ⚑ (pc.json `rev` from the server,
  pushed down /tmp/ct-pc.sock and seen by fs.watch), or the job's own retry time (next-run.txt: a failed install in
  1 h, "AI pending" 10 -> 20 -> ... 360 min). Installs and retries wait until 15 s after degoog was last used (a search or a page call; pc.json
  `last`) and while Windows reports a full-screen app (SHQueryUserNotificationState 2/3/4; the user saw ~20 s lag
  spikes from installs mid-game). Each job run is its own process, stopped after 30 min. Logs: watcher.txt (wakes), job.txt (reports sent or not, session, failures; last-run.txt is only the last install's output). Reports already waiting when the watcher starts are sent then (v97: they used to count as handled and never went).
  There is no scheduled task any more: the old every-minute task's last run empties its launcher (update.ps1) and starts
  the watcher; the watcher's first job run removes the task (if it was made from an admin terminal it can't: the user
  is notified once to rerun ../setup-autoupdate.ps1 as admin). Never add a timer, poll or fallback check: the user
  wants only this sleeping watcher (2026-11-28).
- The shell can't reach crossref/wikimedia/espn (403 CONNECT); WebFetch can reach some. No pwsh, no degoog container: live checks = the installer's self-check on the user's server.
- Engine: Docker or Podman. ../to-podman.ps1 (one-time move) writes %LOCALAPPDATA%\clean-titles\engine-podman.txt; then install.ps1 and autoupdate-job.ps1 route every `docker` call to podman.exe (a shim function at their top, `$ctPodman`). Podman-only parts in install.ps1: sign-in start (podman-start.ps1 via the Run key: machine start, CDI refresh, start containers with a restart policy) and ct-vision (setup.sh runs inside the machine via `podman machine ssh`, docker->podman shim maps `--gpus all` to CDI `--device nvidia.com/gpu=all`, tag localhost/ct-vision). Podman networks: only named networks resolve container names, so the installer puts degoog and ct-warp (degoog's WARP proxy, socks5h://ct-warp:1080) on ct-net (v97: after the move every engine failed with getaddrinfo ENOTFOUND). Keep new docker calls shim-compatible (plain CLI, no Docker-Desktop-only paths). The shim is a PowerShell function, so a program started directly (ProcessStartInfo, Start-Process) must use the engine name: the watcher's `$ENG` (v95: its waits went to docker.exe, so on Podman it never woke). to-podman.ps1 runs the job at the end so the new watcher.ps1 is written and started.
- Installer docker calls (v87): all embedded files go in with ONE `docker cp $t\. :/tmp/ct-inst`, then one root exec (plugin
  files, inline.js) and one default-user exec (setcss, aittl, safeoff); add new embedded files to those, not new calls.
- Never read install.ps1 or HANDOFF.md whole (540 KB / 72 KB): grep, or read the sources in files/.
- A clone with `-b <branch>` is single-branch: fetch main as `git fetch --depth=10 origin main:refs/remotes/origin/main`; cherry-picking WIP onto main needs depth past the shared parent (else every file conflicts as "both added").
- Name a release from main's newest version (`git log -3 origin/main`), not from the plan: a side PR can take the next number.
- Python/torch: `pip install --break-system-packages torch transformers` works from PyPI (download.pytorch.org and huggingface.co are blocked), so vision/app.py logic can be checked on a tiny random-config model: test/rerank_equiv.py.
- Reranker cost: never call the whole causal LM (`rmodel(**x).logits`): that's a vocab-sized row per token (GBs per pass). Use `rmodel.model(...).last_hidden_state[:, -1]` + `lm_head` (v69). /rank returns `gpu` and `wait` ms; status/speed show their medians.
