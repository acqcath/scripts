# clean-titles: quickstart (read this instead of all of HANDOFF.md; grep HANDOFF.md for details)

## Where things are (degoog/wip/files)
- index.js: server plugin. Rank hook `__ctResults` (reranker scores + featured snippet, DOI names, 1.6 s wait), typo fixer (`check`, `TREND`, `NAMES`), routes (`routes`), `net()` fetch helper.
- script.js: page code. `row()` cleans one result (title, source line, date), `listPass`/`tabPass`/`relPass`/`ansPass` run in one observer pass before paint, `tabRescue`, `init`.
- core.js + answers.js: pure logic (dedupe, caps, answers); built into ct-page.js by build.py.
- custom.css, vision/app.py (reranker + image AI on the GPU), ctcheck.js (installer self-check table).

## Build, test, release
1. `cd degoog/wip && bun install && bun test` (46 tests skip: they need private recordings in rec/).
2. `CT_VERSION=vNN python3 build.py && python3 patch_installer.py vNN` writes ../install.ps1 and checks every embedded file round-trips. (build_installer.py is obsolete: its v49 skeleton is gone.)
3. Branch, push (`git -c push.negotiate=true push -u origin vNN`), open the PR with `gh api repos/acqcath/scripts/pulls -f title=... -f head=vNN -f base=main -f body=...` (`gh pr create` fails: GraphQL blocked). The merge was denied to the session: the user merges; the hourly auto-update then installs main.

## Sandbox limits (save the time)
- `git clone --depth 1` needs a ~10 min timeout. degoog's source: `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/degoog-org/degoog` (client: src/client; tabs modules/tabs/tabs.ts; search utils/search/actions/search-actions-perform.tsx).
- The shell can't reach crossref/wikimedia/espn (403 CONNECT); WebFetch can reach some. No pwsh, no degoog container: live checks = the installer's self-check on the user's server.
- Never read installer.ps1 or HANDOFF.md whole (540 KB / 72 KB): grep, or read the sources in files/.
