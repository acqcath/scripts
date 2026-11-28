# HISTORY ONLY: the original v50 brief (2026-11-23). Not kept up to date; QUICKSTART.md, PLAN.md and MAP.md are the source of truth.

Build clean-titles v50 for my degoog now. Everything below is decided and tested; don't re-plan or ask me to re-approve. Ask only if something is impossible or contradicts itself, and say exactly what.

=== SETUP ===
- degoog 1.2.0, Docker on my Windows 11 PC, compose in C:\Users\Alex\Degoog; container = the one with an /app/data mount.
- Browsers: PC + Mac = Zen (Firefox-based); iPhone 15 Pro = Safari with a content blocker I keep on (never ask me to toggle it). It rejects /api/plugin/ addresses and GET /api/command.
- Engines installed: bing, brave, duckduckgo, startpage (+ -images/-news/-videos), wikipedia, forums-web.js. Plugins: clean-titles (mine, v49), ai-summary, define, math-slot, time, weather.
- Source: github.com/degoog-org/degoog, github.com/degoog-org/official-extensions. Read real code before touching anything.

=== BUILD + SHIP ===
1. add_repo acqcath/scripts (push access), clone. Master = degoog/install.ps1 with embedded @' '@ files: extract by name, edit with python exact-match replaces (handle 0/1/many), re-embed. bun-parse index.js, script.js, ct-check.js, names.js after every edit.
2. Run every test in TESTS yourself. Never ask me to test.
3. Bump to v50 ("// clean-titles v50"; installer prints it). Commit, push to main, confirm via the API URL.
4. Reply: short list of what changed + this line in a code block:
irm https://api.github.com/repos/acqcath/scripts/contents/degoog/install.ps1 -Headers @{Accept='application/vnd.github.raw'} | iex
Commands: copy their own output to my clipboard; no " inside args to docker/curl from PowerShell; multi-line wrapped in & { }; clean up after themselves; no backups or one-time setup inside the installer.

=== HOW DEGOOG WORKS HERE (verified) ===
- No server-side result-transform hook in 1.2.0 (types/extension.ts: slots, commands, tabs, middleware). clean-titles edits results in the page via a MutationObserver that runs before paint. All reorder/merge/cap/demote/cleanup must be synchronous there; any data it needs (blocklists, strikes, CMU course list, paywall list) is compiled into the plugin's page script by the server ahead of time, never fetched at search time.
- All page→server requests: POST /api/command {query:"!cleantitles bridge <route> <qs>"}; other plugins' failed /api/plugin/ calls retried via bridge /relay.
- Images from other sites: PluginContext.signProxyUrl → /api/proxy/image (private, not /api/plugin/).
- Slots: SlotPlugin with position "at-a-glance" (where ai-summary and math-slot render), trigger(), execute() returning html, timeoutMs, waitForResults. Check in degoog's client whether slots render with results or after; if after, reserve each card type's exact height.
- degoog caches engine results 12 h (TTL_MS, env DEGOOG_CACHE_TTL_MS); result fields: title,url,snippet,source,thumbnail,imageUrl,duration,publishedAt; ScoredResult.sources[] = engines that returned it. degoog already strips tracking params (ClearURLs) and merges www.
- ai-summary: at-a-glance slot; hard-coded const SHORT_TTL_MS = 2 min in its index.js.

=== RULES FOR EVERYTHING ===
- Never slower than v49 to first results. Extremely cheap: lazy, cached, fewest outside requests. Private: never store/log searches; stored data = domains, counts, status.
- Excellent or cut. Test each feature on real searches before shipping; cut anything that only sounds useful.
- One design on PC and phone. One toggle per feature in Settings (default on). No arbitrary numbers: derive from viewport/source update rate/measured data; comment the reason.
- Verify every outside service live (fetch tool; your shell can't reach them); design around its limits; if it fails, the feature hides itself cleanly. Verify anything checkable yourself instead of guessing.

=== LOADING (invisible) ===
- Reorder/rewrite before first paint; a shown result never moves or changes text.
- Late items only into space reserved at exact final size; if not sure to arrive, reserve nothing and drop it.
- Placeholders shaped like the final thing; one fade (ct-in = degoog resultFadeIn .3s), new content drawn under the placeholder first; images shown only once decoded; HD thumbs swap as same-size crossfade; inline additions nowrap, never change line height.
- Audit v49's title cleanup and HD thumbnails for after-paint swaps; fix.

=== DESIGN SYSTEM (approved from real screenshots) ===
- Answers look like rich results, not boxes: small gray source/label line → answer (24px for instant answers, 18px blue title for result-like answers) → gray dot-line details (13px). One layout on PC and phone.
- Eye order: answer → image anchors (team logos, right-side result thumbnails, panel photo) → blue links → gray details. One focal point per screen.
- Detail lines: "·" separators, exactly one line, items never cut; only same-kind lists (professors, prereqs) collapse into "+N"; a mixed fact that doesn't fit is dropped whole, never a bare "+N"; fit re-measured with ResizeObserver; long prereqs → "prereqs 15-122 +2"; titles text-wrap: balance.
- Icons (only these): ★ ratings (number then stars, partial fill to the exact value, amber; headline rating only — ratings inside lists are plain numbers); ✦ before "AI summary"; pulsing red dot before "Live"; › navigates, ⌄ expands in place. No other icons; "Paywall" is a word tag; no site icons/favicons.
- Color = meaning only: blue clickable, amber rating, red live; everything else gray/white. Visited links a slightly different shade.
- Info: imperial next to metric for physical facts; relative time within about a week ("yesterday"), else exact date, everywhere; headline answers rounded, exact value + parsed input on the detail line.
- Touches: tap an instant answer to copy ("Copied" in its label line; PC hover shows a small gray copy icon); underline on hover only; visible focus rings; ≥44px tap targets on phone; prefers-reduced-motion disables pulse/fades; tabular digits, en dashes, thousands separators, "…" character. No team-color bars, celebrations or colored badges.
- Judge every screen yourself from real headless-Chrome screenshots at 390 and 1280 with degoog's compiled SCSS + my custom CSS, longest real cases included; fix anything off before shipping.

=== FEATURES ===
1. ANSWER CARD (slot, top of All tab, max one per search). Priority: exact pattern > calculation > live > fact > featured snippet > AI summary.
- Local (instant): math (replaces math-slot's call to api.mathjs.org; tell me to disable math-slot after shipping), units incl. cooking, currency (ECB rates update ~16:00 CET each working day; fetch once after), time zones (yield to time plugin where it covers), date math, tip/percent.
- Patterns ("paste anything"): UPS 1Z (check digit verified), FedEx, USPS (format only), Amazon TBA → carrier link; flight numbers → status; ISBN-13/10 (checksum) → Open Library; DOI/arXiv → paper; CVE-YYYY-NNNN+ → NVD; Windows 0x error codes → Microsoft page; owner/repo; pip/npm package names; IP; hex color swatch; $ticker; "days until …". CMU: "15-213" always; bare "15213" only if the course exists (15213 is also CMU's zip code).
- Network (run parallel with engines, dropped if not ready): Wikidata facts ("how tall is X", population "as of", born/died/founded/CEO/release date, distance between cities); sports (ESPN public JSON: competitors[].team.logo/abbreviation, record, score, winner, status period/clock; poll only while live + tab visible, at the feed's own refresh interval); versions via endoflife.date ("latest ios", "is windows 10 supported").
- Yields to define, weather, time where they answer.
2. FEATURED SNIPPET vs AI: wording decides (fact/how-to → snippet; best/vs/why/explain/compare → AI). Snippet only from a sentence that applies to everyone; pages with per-model/version steps (e.g. Apple's AirPods reset) → show that page first as a normal result instead. Never both; same spot; AI height reserved; ✦ label. Installer patches ai-summary's SHORT_TTL_MS to TTL_MS (handle 0/1/many matches; skip + print notice if the line changed). This differs from "engine cache TTL changes", which stays ruled out.
3. KNOWLEDGE PANEL (approved): PC right column top-aligned with the first result: one lead photo (shape follows subject), name, type, 2-line Wikipedia description with link, label/value facts per entity type, "as of" on changing facts, source "Wikipedia · Wikidata". Phone: name, type, one dot-line of facts, "More ⌄". Only when results include that Wikipedia article; replaces degoog's Wikipedia card; hides the duplicate Wikipedia result. No "People also search for".
4. CMU CARD (only for course-level searches: "15-213", "15-213 workload/professor/reviews"; course + specific topic like "malloc lab" → no card, cmu.edu results first).
- Data: https://course.apis.scottylabs.org (verified no login): /fces?courseID=15-213 (hrsPerWeek, rating[], instructor, semester, year, responseRate, numRespondents, location), /course/:id, /courses/all, /schedules, /instructors. Cache locally, refresh per semester.
- Numbers = CMU Courses' method (ScottyLabs/course-tool apps/frontend/src/app/fce.ts aggregateFCEs + user.ts defaults): drop 0% response rate, fall+spring only, most recent 2 counted semesters, respondent-weighted means; rating index 7 = teaching, 8 = course (0-based; verify against raw JSON on the server). Plus: Pittsburgh location only, merge exact-duplicate rows, "LAST, FIRST" → "First Last" (phone: last names). 1 decimal.
- Layout (rich result): source "CMU Courses" → blue title "15-213 Introduction to Computer Systems" (link to CMU Courses) → "12 units · 14.3 hrs/wk · 4.0 ★★★★☆ · prereq 15-122" → "Fall 2026 · Railing 4.3 · Gibbons 4.2 · +N". Instructor version for professor searches.
5. SITES (one list, one control): per site Prefer / Normal / Lower / Hide — four evenly spaced options in one rounded group, set from each result's menu (replaces Rank/Block) or Settings (same list). Prefer = moved up, no cap. Anti-SEO only sets Lower, marked "auto"; my setting wins and stops auto checks for that site.
- Anti-SEO (web results): per-search checks — scraper copies (same title as a result from the original site), SEO-bait wording (search volume / keyword data), stale "best … 20XX" lists, AI tells in snippets; a domain → Lower when it trips checks on most searches it appears in, after a minimum sample set from data; contract-cheating sites → Lower. laylavish AI blocklist (1,116 domains, AI-image sites; tested 0 hits on web junk) → Images tab only, checked daily, downloaded only if changed. Lists/strikes compiled into the page script.
- "Content farm" tag only for curated-list sites.
6. SITE CAP: 2 per site (matches Google). Site = registrable domain via the public suffix list (tested). 3rd+ results fold into "N more from site.com ⌄" (tap expands in place). Cap lifts when the search names the site. Discussions threads never repeat in main results.
7. DEDUPE (top priority; tested 18 → 6 on real results): merge pagination/comment pages, m./AMP/http-https, regional/locale copies (support.apple.com/<locale>, *.react.dev mirrors), translations, reposts (same title + same author), short links (apple.co etc.), paper versions (arXiv vN/abs/pdf/ar5iv, proceedings copy), Wikipedia mirrors (wikiwand, wikipedia.com, www.wikipedia.org, simple.wikipedia, offline mirrors, newworldencyclopedia); then same-title-within-site merge. Extra versions show as small links on the one result ("PDF · HTML · v7 latest").
8. SAME-SHAPE RESULTS: if the search names a type (pdf, paper, reddit, docs, recipe, github, lab, lecture, slides, video) or a site: plain uniform list of that type with its own touches (PDF tag, thread info, stars/time); no images/videos/Top stories/panel/AI/People also ask on top. Named site with few results from it → one line drawn with the results, "Only reddit.com results ›", which runs a site: search only when tapped. Programming searches: official docs first (react.dev, MDN, python docs…).
9. INTENT CLARITY: no answer card when the search has several meanings and the results don't favor one. Meaning line (tap adds the word) only when Wikipedia disambiguation lists several meanings and results cover just one (e.g. "mercury"). Never interleave results by meaning. Sections only with evidence from this search.
10. ARCHIVE: "Paywall" tag from a public paywall-domain list (compiled into the page). "Open archived copy" in every result's menu; on tap the server checks archive.today, Wayback, Ghostarchive in parallel (archive.today first for paywalls, Wayback first for dead pages); fallback = archive.today save page. Nothing fetched before the tap.
11. QUICK VIEW (tap only): server fetches the page, reads schema.org JSON-LD: recipe (ingredients, steps), how-to, product (stars, no store prices), FAQ, event, app, movie/book, local business, article (author, date, reading time, isAccessibleForFree → paywall tag). Fallback: Mozilla Readability; JS-only pages stay links. Lists end with "N more … ⌄". Inline stars + time on the source line only for first-screen recipe/review results, per-domain success counts skip blockers.
12. IMAGES ROW (All tab, clearly visual searches only): uses the same cached image search; phone = swipe with the next image peeking; PC = justified row filling the width.
13. SNIPPET CLEANUP: strip leading dates / "N days ago —" (tested) and junk ellipses; move dates to the source line. Wikipedia results use the article's opening sentence.
14. !deepl bang → DeepL.
15. CARRIED-OVER VALUES: 2 per site kept (+ rules above); .3s fade kept; Bing suggestions 204 → exponential backoff from 1 minute, reset on first success; Top stories "2+ fresh" → define "fresh" and the threshold from real news searches and report the choice.

=== TESTS (you run all; ship only when all pass) ===
- Code tests: dedupe (comment pages, arXiv versions, Apple locales + legacy IDs, react.dev mirrors, Wikipedia mirrors), public-suffix grouping, checksums (valid / wrong digit / random), CMU patterns incl. 15213 zip collision, units incl. nonsense input, snippet date cleanup, intent rules.
- Real searches through a mini bun server standing in for degoog with recorded engine results: jaguar, mercury, python, react useEffect cleanup, best mechanical keyboard reddit, 15-213, 15-213 malloc lab, chocolate chip cookie recipe, how to reset airpods, attention is all you need pdf, eiffel tower height, 5 mi in km, 100 usd to eur, a UPS number, steelers, latest python, plus ~25 more covering every feature. Check each feature fires only when it helps.
- Every outside source fed good/slow/empty/malformed/erroring responses: features hide cleanly; results never wait.
- Chrome headless at 390 and 1280, throttled network: layout shift exactly 0; filmstrip checked frame by frame; screenshots reviewed against the design system, longest real cases included.
- Live fetch-tool check of each source (CMU API, Wikidata, ECB, ESPN, endoflife.date, archives, blocklists, paywall list); failures fixed or the feature cut, and tell me which.
- Audit v50 line by line against this handoff and list any miss.

=== INSTALLER SELF-CHECK ===
After installing, the installer runs every feature against the live sources from my server (CMU API incl. rating indexes, Wikidata, ECB, ESPN logos through /api/proxy/image, endoflife.date, archives, blocklists, recipe JSON-LD on a known page, ai-summary patch status, slot timing), prints one pass/fail table (feature names + status only, never searches) and copies it to my clipboard. Any fail = fix or cut next version.

=== RULED OUT (never add) ===
bold query words, time filters, streaming, video timeouts <1500, iPhone video descriptions, Brave web, Safe Search, site icons, centered image titles, custom !g/!m bangs, autocomplete UI, j/k shortcuts, engine cache TTL changes, News past-week default, backup copies, disabling the content blocker, Google for anything, big round-favicon source line, default weather city, 2-letter typo exception, Asura Scans investigation, People also search for, navigational-query feature, prefetch, translate box, auto-open Quick view, store prices, interleaving results by meaning, forced result-type mixing.

=== LATER (not v50) ===
Tools right after the last tab in tab style; Videos dedupe/Shorts badge/length+date; Science journal/year/PDF tag beyond feature 7; Images hide duplicates and tiny thumbnails.