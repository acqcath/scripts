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

## Not in this preview yet
Prefer/Normal/Lower/Hide for sites (M2). Until then the old Rank higher / Rank lower / Block menu is still there. Answer cards (M3/M4) and the rest of the spec come after that.
