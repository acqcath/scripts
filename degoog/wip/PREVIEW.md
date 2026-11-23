# clean-titles v50-preview

## Install (PowerShell on the PC that runs degoog)
```
irm "https://api.github.com/repos/acqcath/scripts/contents/degoog/wip/install-preview.ps1?ref=v50-wip" -Headers @{Accept='application/vnd.github.raw'} | iex
```
The first check line should say `clean-titles v50-preview`, and the next one should list a `psl.<code>.js` file.

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
A small answer at the top for searches that are a sum, a conversion or a paste: `12 x 350`, `5 mi in km`, `2 cups flour in grams`, `20% tip on 85`, `days until christmas`, a UPS number, an ISBN, a DOI, `CVE-2021-44228`, `#ff8800`, `pip requests`, `facebook/react`, `UA 123`. Tap the answer to copy it ("Copied" shows in its label line). While it shows, other panels (AI summary, math-slot) stay hidden, so there's one answer per search. Once v50 ships you can turn math-slot off: this replaces it without calling api.mathjs.org.

## Not in this preview yet
The Paywall tag's archive link (M5). Then answer cards (M3/M4) and the rest of the spec.
