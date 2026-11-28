# clean-titles: quickstart (read this instead of all of HANDOFF.md; grep HANDOFF.md for details)

## Every degoog chat, first: Flags
⚑ (degoog's tab row, every tab) saves reports on the server: the search, tab, chosen problem chips (core FLAG_CATS), optional note, context (viewport, load ms, visible blocks), top 10 results.
The ⚑ shows nothing else (no count, no send link: the user asked). The PC's update job (../autoupdate-job.ps1
`SendReports`) sends them into ONE standing cloud session with `claude -p --cloud <id> --output-format json` (prompt
on stdin; `claude --cloud "<task>"` fails from a background job: "requires an interactive terminal"). The id lives in
%LOCALAPPDATA%\clean-titles\reports-session.txt; `New-ReportsSession` makes it once (at most one try a day) by running
`claude --cloud` inside `conhost --headless` and reading the id off that console, else in a visible window with a
notification. Archived/not-found session = a new one. An update breakage (`updateIssue`) goes at once, the rest when
the local model says they're worth it; the server marks them sent. The job installs Git and the Claude CLI itself. No separate flags repo (the user won't
create one; add_repo for a new repo is refused): a Report session gets every flag in its prompt.
1. Fix each flag at the code level (core.js / script.js / index.js: ranking, relevance, junk rules, or the ⚑ box itself),
   add a test from the flag where possible (no searches from flags in this public repo), release, merge.
2. `updateIssue` = the installer's self-check output after the auto-update: fix the FAIL rows like any other bug.
3. Live look at the server (degoog.tigon-cat.ts.net, built-in browser): the pane treats it as high-risk, so EVERY
   action (each load, each JS call) needs its own approval and "site" access is never saved. Read the code first. If a
   live look is still needed: tabs_context first (free) and reuse a pane tab already on the site, so the look is ONE
   javascript call (1 approval); only if none: one load of a search page, then ONE javascript call that does everything through
   same-origin fetches (no further loads): status first via the bridge, e.g.
   `const b=(r,p={})=>fetch("/api/command",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:"!cleantitles bridge "+r+" "+new URLSearchParams(p)})}).then(x=>x.json()).then(j=>{const t=document.createElement("textarea");t.innerHTML=j.html;return JSON.parse(t.value)}); await b("status")`
   -> {ver, pageMissing, ai, flags, issue}. CT_VER is module-scoped (not on window). Max 2 approvals per look (1 with a reused tab); never
   a third: ask the user instead. No screenshots.
   No live look right after a merge: the PC installs it within a minute and degoog restarts, so the look fails or shows the old version.

Where code lives: **[MAP.md](MAP.md)** (every section, function and route with file:line; rebuilt by build.py). Read
only those lines (`sed -n A,Bp files/x.js`).

## Where things are (degoog/wip/files)
- index.js `/needs` (`NEEDS`, `needsFor`): one batched reranker pass per search rating format shares, needs and block fits (vision `/rank` takes per-doc `tasks`); page places blocks by core `fmtShares`/`boxWorth`/`boxAt`. Plan + milestones: PLAN.md. Blocks (forums/news/papers/info/answer) placed by core `blockShare` x fit; fetch gate `blockGo` vs `/cut` median (cut.json).
- index.js: server plugin. Rank hook `__ctResults` (reranker scores + featured snippet, DOI names, 1.6 s wait), typo fixer (`check`, `TREND`, `NAMES`), routes (`routes`), `net()` fetch helper.
- script.js: page code. ⚑ Report: `flagBtn`/`flagBox` (link to claude.ai/code/new built before the tap); prompt text: index.js `flagPrompt`.
- index.js ⚑ routes: `/flag` (store + hand over), `/flags` (what's waiting); files flags.json, update-issue.txt (written by ../autoupdate-job.ps1 `Issue`).
- script.js (rest): `row()` cleans one result (title, source line, date), `listPass`/`tabPass`/`relPass`/`ansPass` run in one observer pass before paint, `tabRescue`, `init`.
- script.js search identity: `searchId()` = address + a counter bumped by each degoog search start (its history entries
  {degoog:true,...}: every push, or a rewrite with a new query/page; popstate). Never key per-search state by the
  address alone: Web -> News -> Web -> News then saw News's results as "already seen" and hid them all (fixed v84).
- script.js loading placeholders: `skel` redraws degoog's skeletons from shapes `skelLearn` measured on the last real
  results (localStorage ct-skel, per tab/device/50 px width); Images uses the real grid CSS + measured picture shapes;
  `picLoad`: shimmer until loaded, first 18 pictures eager.
- core.js + answers.js: pure logic (dedupe, caps, answers); built into ct-page.js by build.py.
- custom.css, vision/app.py (reranker + image AI on the GPU), ctcheck.js (installer self-check table).

## Build, test, release
1. `cd degoog/wip && bun install && CT_VERSION=vNN python3 build.py && bun test` (page tests load the BUILT files/ct-page.js: rebuild after any script.js/core.js edit or the test runs old code; happy-dom has no `:scope`, use `[...g.children].find`) (46 tests skip: they need private recordings in rec/).
2. `CT_VERSION=vNN python3 build.py && python3 patch_installer.py vNN` writes ../install.ps1 and checks every embedded file round-trips.
3. Branch, push (`git -c push.negotiate=true push -u origin vNN`), open the PR with `gh api repos/acqcath/scripts/pulls -f title=... -f head=vNN -f base=main -f body=...` (`gh pr create` fails: GraphQL blocked). Each version branches from a fresh `git fetch --depth=5 origin main && git checkout -B vNN origin/main` (main is squash-merged, so a branch off the last version branch conflicts). Right after a push, merge can say "conflicts" while GitHub recomputes: wait ~10 s and retry once. Then merge it yourself as its own command: `gh api -X PUT repos/acqcath/scripts/pulls/N/merge -f merge_method=squash` (if the safety check blocks it, leave it open, build the next version on top, merge both with the next PR, and tell the user). The PC's auto-update installs main within about a minute of the merge (the job runs every minute and `git ls-remote` spots the new main; hourly only while Git is missing). The task's shape (every minute, conhost --headless) is set only by ../setup-autoupdate.ps1: the job can't change it (task made from an admin terminal = "Access is denied"), it only checks it (`Check-Task`) and notifies.

## Sandbox limits (save the time)
- Push 403 = the session lacks write access: call add_repo(acqcath, scripts, access="push") first, then push. The merge call can be refused by the auto-mode safety check: push + open the PR, then ask the user to approve the merge in chat.
- test/headless/run.cjs needs private rec/ (not in this repo): for a quick layout check write a stub page instead (below). Push needs add_repo(push) at the start of every session: do it before the first push.
- Render check for page/CSS changes: playwright (python) + /usr/bin/google-chrome work; load custom.css + built ct-page.js into a stub page, screenshot 1584 and 390 wide.
- Fastest clone (~1 s, 3 MB, only degoog/): `git clone --depth 1 --filter=blob:none --sparse https://github.com/acqcath/scripts && git -C scripts sparse-checkout set degoog`. A full `git clone --depth 1` needs a ~10 min timeout. degoog's source: `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/degoog-org/degoog` (client: src/client; tabs modules/tabs/tabs.ts; search utils/search/actions/search-actions-perform.tsx).
- PC load: the update launcher runs below normal priority and skips the heavy part (install, self-check, report
  judging) while Windows reports a full-screen app (SHQueryUserNotificationState 2/3/4: games, also borderless); the
  "AI pending" self-check backs off 10 -> 20 -> ... 360 min (v84; the user saw ~20 s lag spikes).
- Render check stub for page changes: see /home/claude/rc pattern: http.server + a page with custom.css + ct-page.js,
  results rendered from test/fixtures with test/render.js (degoog's base CSS is absent, so compare placeholder vs real).
- The shell can't reach crossref/wikimedia/espn (403 CONNECT); WebFetch can reach some. No pwsh, no degoog container: live checks = the installer's self-check on the user's server.
- Never read installer.ps1 or HANDOFF.md whole (540 KB / 72 KB): grep, or read the sources in files/.
- A clone with `-b <branch>` is single-branch: fetch main as `git fetch --depth=10 origin main:refs/remotes/origin/main`; cherry-picking WIP onto main needs depth past the shared parent (else every file conflicts as "both added").
- Name a release from main's newest version (`git log -3 origin/main`), not from the plan: a side PR can take the next number.
- Python/torch: `pip install --break-system-packages torch transformers` works from PyPI (download.pytorch.org and huggingface.co are blocked), so vision/app.py logic can be checked on a tiny random-config model: test/rerank_equiv.py.
- Reranker cost: never call the whole causal LM (`rmodel(**x).logits`): that's a vocab-sized row per token (GBs per pass). Use `rmodel.model(...).last_hidden_state[:, -1]` + `lm_head` (v69). /rank returns `gpu` and `wait` ms; status/speed show their medians.
