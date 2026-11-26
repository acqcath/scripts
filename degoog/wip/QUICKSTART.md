# clean-titles: quickstart (read this instead of all of HANDOFF.md; grep HANDOFF.md for details)

## Every degoog chat, first: Flags
⚑ (degoog's tab row, every tab) saves reports on the server: the search, tab, chosen problem chips (core FLAG_CATS), optional note, context (viewport, load ms, visible blocks), top 10 results.
The ⚑ shows nothing else (no count, no send link: the user asked). The PC's update job (../autoupdate-job.ps1
`SendReports`) sends them with `claude --cloud`: an update breakage (`updateIssue`, the self-check output) at once,
the rest when the local model says they're worth a session; the server marks them sent. The job installs Git and the
Claude CLI itself and opens Claude's sign-in once a day until it's approved. No separate flags repo (the user won't
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

Where code lives: **[MAP.md](MAP.md)** (every section, function and route with file:line; rebuilt by build.py). Read
only those lines (`sed -n A,Bp files/x.js`).

## Where things are (degoog/wip/files)
- index.js `/needs` (`NEEDS`, `needsFor`): one batched reranker pass per search rating format shares, needs and block fits (vision `/rank` takes per-doc `tasks`); page places blocks by core `fmtShares`/`boxWorth`/`boxAt`. Plan + milestones: PLAN.md. Blocks (forums/news/papers/info/answer) placed by core `blockShare` x fit; fetch gate `blockGo` vs `/cut` median (cut.json).
- index.js: server plugin. Rank hook `__ctResults` (reranker scores + featured snippet, DOI names, 1.6 s wait), typo fixer (`check`, `TREND`, `NAMES`), routes (`routes`), `net()` fetch helper.
- script.js: page code. ⚑ Report: `flagBtn`/`flagBox` (link to claude.ai/code/new built before the tap); prompt text: core.js `flagPrompt`.
- index.js ⚑ routes: `/flag` (store + hand over), `/flags` (what's waiting); files flags.json, update-issue.txt (written by ../autoupdate-job.ps1 `Issue`).
- script.js (rest): `row()` cleans one result (title, source line, date), `listPass`/`tabPass`/`relPass`/`ansPass` run in one observer pass before paint, `tabRescue`, `init`.
- core.js + answers.js: pure logic (dedupe, caps, answers); built into ct-page.js by build.py.
- custom.css, vision/app.py (reranker + image AI on the GPU), ctcheck.js (installer self-check table).

## Build, test, release
1. `cd degoog/wip && bun install && bun test` (46 tests skip: they need private recordings in rec/).
2. `CT_VERSION=vNN python3 build.py && python3 patch_installer.py vNN` writes ../install.ps1 and checks every embedded file round-trips. (build_installer.py is obsolete: its v49 skeleton is gone.)
3. Branch, push (`git -c push.negotiate=true push -u origin vNN`), open the PR with `gh api repos/acqcath/scripts/pulls -f title=... -f head=vNN -f base=main -f body=...` (`gh pr create` fails: GraphQL blocked). Each version branches from a fresh `git fetch --depth=5 origin main && git checkout -B vNN origin/main` (main is squash-merged, so a branch off the last version branch conflicts). Right after a push, merge can say "conflicts" while GitHub recomputes: wait ~10 s and retry once. Then merge it yourself as its own command: `gh api -X PUT repos/acqcath/scripts/pulls/N/merge -f merge_method=squash` (if the safety check blocks it, leave it open, build the next version on top, merge both with the next PR, and tell the user). The PC's auto-update installs main within the hour, or within a minute while a sent flag's fix is pending (autoupdate-job.ps1 Sync-Task).

## Sandbox limits (save the time)
- Fastest clone (~1 s, 3 MB, only degoog/): `git clone --depth 1 --filter=blob:none --sparse https://github.com/acqcath/scripts && git -C scripts sparse-checkout set degoog`. A full `git clone --depth 1` needs a ~10 min timeout. degoog's source: `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/degoog-org/degoog` (client: src/client; tabs modules/tabs/tabs.ts; search utils/search/actions/search-actions-perform.tsx).
- The shell can't reach crossref/wikimedia/espn (403 CONNECT); WebFetch can reach some. No pwsh, no degoog container: live checks = the installer's self-check on the user's server.
- Never read installer.ps1 or HANDOFF.md whole (540 KB / 72 KB): grep, or read the sources in files/.
