# clean-titles v50-preview

## Install (PowerShell on the PC that runs degoog)
```
irm "https://api.github.com/repos/acqcath/scripts/contents/degoog/wip/install-preview.ps1?ref=v50-wip" -Headers @{Accept='application/vnd.github.raw'} | iex
```
The first check line should say `clean-titles v50-preview`, and the next one should list a `psl.<code>.js` file. At the end the installer now tries every feature against its live source from your server (takes up to ~2 minutes) and prints one PASS/FAIL table (feature names only), copied to your clipboard. Paste it into the chat: any FAIL is fixed or cut before v50 ships.

## Roll back to v49
Run the normal installer from main, as usual. It puts v49 back. A leftover `/public/ct/psl…js` file stays, but it's harmless: v49 never reads it.

## What changed (M1)
- **Copies merged:** the same document from several places shows once. arXiv copies become one result with "PDF · HTML · v7 latest" links.
- **2 per site:** a site's 3rd and later results fold into "N more from site.com ⌄" under its 2nd result. Tap it and they open in place. A search that names a site (mdn, npm, pip, reddit…) keeps all of that site's results.
- **Dates:** the date moves from the snippet to the source line ("site · yesterday"). Junk "..." is gone from snippets.
- **Nothing jumps after the page is drawn.** Did you mean, Related searches, People also ask, the command card (e.g. "pittsburgh weather"), sitelinks, forums and video boxes are drawn with the results or not at all. HD thumbnails now fade in over the small picture in the same box.
- **Top stories** appears only when the results really look like news (3+ sites stamped "N hours ago"; on your recorded searches that's steelers and taylor swift). It shows from the **second** time you open such a search, because it never pops in after the page is drawn. v49's version could never have shown on your server: degoog's News answers carry no dates, and v49 required them.
- **News tab:** each card's layout (banner or small thumbnail) is set before paint, so cards don't re-arrange as pictures load.
- **Cut:** YouTube description fetching (it grew results after they were on screen).

## What to look at
1. `how to reset airpods`, `is windows 10 supported`: no duplicates, and microsoft.com folds into "6 more ⌄".
2. `attention is all you need pdf`: one arXiv result with version links.
3. `steelers` twice: the second time there's a Top stories row after the first result, and nothing moves.
4. Scroll fast on an image-heavy search: thumbnails sharpen without blinking or moving.
5. Any typo search (`teh wether tommorow`): if the fix shows, it shows together with the results.

## Sites: Prefer / Normal / Lower / Hide (M2, first part)
Each result's ⋮ menu now has one group of four: **Prefer · Normal · Lower · Hide** (it replaces Rank higher / Rank lower / Block). The choice is for the whole site (support.apple.com → apple.com) and is saved in degoog's own Block and Score lists, so degoog applies it on every tab. Prefer also lets that site show more than 2 results. Your old Block and Rank entries show up as Hide / Prefer / Lower.
- It needs your Settings sign-in, like degoog's own menu. If you aren't signed in, the menu says "Sign in to Settings first" and nothing changes.
- The same list is in Settings → Clean Titles → **Sites** (add a site, pick a choice, Save). Changes there and in the menu show up in both places.
- Try: Hide a site on one search, then search something else where it usually shows up.

## Anti-SEO auto-Lower (M2)
Each search's first page is checked for SEO signs (scraper copies of another result, "search volume" bait, stale "best … 2023" lists, AI-written wording, essay-writing services). A site with signs on most of the searches it's in (at least 5) is set to **Lower**, and its menu says "Lowered automatically". Only Lower, never Hide; any choice you make wins and stops it for that site. On your recorded searches it would lower nothing (the one scraper it spotted, an MDN copy, showed up once). Off switch: Settings → Clean Titles → "Lower SEO junk automatically".

## Paywall tag (M2)
Results from sites where most articles need a subscription (nytimes.com incl. Wirecutter and Cooking, wsj.com, ft.com, bloomberg.com, …) show a gray **Paywall** word on the source line. Try `$AAPL` or `best laptop 2026`.

## AI pictures on the Images tab (M2)
The Images tab hides pictures from AI-image sites (laylavish's AI blocklist, checked by your server once a day and downloaded only when it changes). Web results never use it. It starts working from the second Images search after install (the first one fetches the list).

## Instant answers (M3, first part)
A small answer at the top for searches that are a sum, a conversion or a paste: `12 x 350`, `5 mi in km`, `2 cups flour in grams`, `20% tip on 85`, `days until christmas`, a UPS number, an ISBN, a DOI, `CVE-2021-44228`, `#ff8800`, `pip requests`, `facebook/react`, `UA 123`, and currency (`100 usd to eur`, from the European Central Bank's daily rates, which your server fetches once after each publication), and versions from endoflife.date (`latest python`, `is windows 10 supported`; shows from the first search if it's quick, otherwise from the next one), and facts from Wikidata (`how tall is the eiffel tower`, `pittsburgh population`, `nvidia ceo`, `distance between pittsburgh and new york`; same timing), and the CMU course card for `15-213` (units, hours per week, rating with stars, prereqs, this semester's professors; `15-213 professor` puts the professors first; `15-213 malloc lab` gets no card), and a team's game for `steelers` (live score that updates every minute while you watch, else the last or next game). Tap the answer to copy it ("Copied" shows in its label line). While it shows, other panels (AI summary, math-slot) stay hidden, so there's one answer per search. Once v50 ships you can turn math-slot off: this replaces it without calling api.mathjs.org.

## AI summary spot (M3)
AI summaries now show only for searches that ask for judgement or an explanation (`why is the sky blue`, `iphone 16 vs iphone 17`, `best laptop 2026`), in a fixed 3-line spot under "✦ AI summary" that's there before the results, so nothing moves when the summary arrives. Tap ⌄ for the whole answer and the follow-up chat. If ai-summary fails, the spot says "AI summary unavailable". Other searches (facts, how-tos) no longer get an AI box that pops in late.

## AI summary cache
The installer now lets ai-summary keep its answers as long as degoog keeps search results (12 hours) instead of 2 minutes, so a repeated search gets its summary at once. Look for the line "AI summary cache: … (OK)" while it installs; a NOTICE line there means ai-summary changed and nothing was touched.

## Knowledge panel (M4)
For a name-like search (`taylor swift`, `golden gate bridge`) a panel about it: on a wide PC window it sits in a right column next to the first result (photo, name, what it is, 2 lines from Wikipedia, key facts, "Wikipedia ↗ · Wikidata"); on a phone or narrower window it's a small card at the top (name, what it is, one line of facts, More ⌄). It replaces degoog's Wikipedia card. It shows only when the results back it up: your engines never return a Wikipedia result (none in 50 recorded searches), so a Britannica or Wikiwand article with the same title also counts. `jaguar`, `mercury`, `python` get no panel (the results are about several things). On a phone it shows from the first search if it's quick, otherwise from the next one; on a wide PC it can also appear a moment later beside the results, without moving them.

## Plain lists for type and site searches (M5)
A search that names a kind of result (`… pdf`, `… reddit`, `… recipe`, `… docs`, `… video`, `… github`, `… lecture`, `… slides`) or a site to filter by (`mdn …`, `npm …`) gets a plain list: no Discussions/Videos boxes, Top stories, People also ask, knowledge panel or AI on top. PDF files say "PDF" on the source line. If you name a site (`… reddit`) but few results come from it, a line "Only reddit.com results ›" runs a `site:` search when tapped. Programming searches put the official docs first (`react useEffect cleanup` → react.dev).

## Quick view and archived copy (M5)
Each result's ⋮ menu has **Quick view** and **Open archived copy**. Quick view opens under the result: a recipe's rating, time, ingredients and steps; a how-to's steps; a product's rating (never prices); FAQ answers; an article's author, date and reading time (and the Paywall word if the page says it's for subscribers); otherwise the page's first paragraphs. Tap again to close. Archived copy opens a new tab with archive.today (paywalled sites) or the Wayback Machine (others), else Ghostarchive, else archive.today's save page. Nothing is fetched until you tap. Try: `chocolate chip cookie recipe` → Quick view on the first result; `$AAPL` → archived copy of a wsj.com result.
Recipe and review searches also show "4.9 ★ · 1 hr 15 min" on the source line of the first results, from the **second** time you search (it's looked up after the page is drawn and kept, so nothing pops in).

## Images row (M5)
Searches that clearly want pictures (`… photos`, `… wallpaper`, `… logo`, `… hairstyles`), or that you opened the Images tab for in the last 12 hours, get a row of 12 pictures after the first result (swipe on a phone). Try: open `golden gate bridge` on the Images tab, then go back to All.

## !deepl (M5)
`!deepl guten Morgen` opens DeepL with the text (to English); `!deepl de good morning` translates to German.

## Smaller changes (M5/M6)
The installer no longer downloads anything itself: if the typo fixer's word lists or Wikipedia names are ever missing, the plugin fetches them on its own a minute or two after degoog starts (you already have them, so nothing changes for you).
No site icons next to results any more (spec), and every new feature has its own switch in Settings → Clean Titles (all on).
Bing suggestions back off from 1 minute (doubling, up to an hour) when Bing stops answering, instead of a flat hour.

## Other meanings (M5)
When a search's words mean several things but all your results are about one of them, a line above the results offers the others: `python` → "Also: snakes · Monty Python" (tap to search that). `mercury` gets no line: its results already cover the planet, the element and the bank.

## Self-check (M6) — please paste it back
At the end the installer prints one table, "Feature  PASS|FAIL|SKIP  note", and copies it to your clipboard. It tries every outside source live from your server (currency, versions, Wikidata, CMU, ESPN, knowledge panel, archives, quick view, AI-image list). Paste it into the main chat: each FAIL gets fixed or cut before v50 ships.

## After a degoog update
A degoog image update replaces the page files this plugin adds (it can't write them back itself). If that happens, the plugin's entry in Settings starts with "Run the installer again"; running it puts everything back.

## Not in this preview yet
Featured snippet for fact/how-to searches (needs about 10 real "what is / how to / who is" searches recorded from your server first).
