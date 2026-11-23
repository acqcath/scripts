# Records searches on the News, Science and Forums tabs from your own degoog (same shape as the first 50 recordings) and saves
# them in your Downloads folder as ct-tab-searches.json (never the Desktop). Only titles, links, snippets and engine names are kept.
$c = docker ps -q | Where-Object { (docker inspect $_ --format '{{range .Mounts}}{{.Destination}} {{end}}') -match '/app/data' }
if (-not $c) { Write-Host "degoog container not found (is it running?)"; return }
$c = @($c)[0]
$js = @'
const qs = [];
for (const type of ["news", "science", "forums"]) for (const q of ["shit", "something", "python", "climate change", "steelers", "how to tie a noose", "sleep deprivation", "best mechanical keyboard"]) qs.push([type, q]);
const PORT = process.env.DEGOOG_PORT || 4444;
const out = { at: new Date().toISOString(), searches: [] };
for (const [type, q] of qs) {
  try {
    // A tab is "news" or, for engine tabs, "tab:engine:<name>"; the first that answers with results is kept
    let r, j = {};
    for (const t of [type, `tab:engine:${type}`]) {
      r = await fetch(`http://127.0.0.1:${PORT}/api/search?type=${encodeURIComponent(t)}&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(30000) });
      if (r.status === 401) { console.log("degoog's search API needs a key (Settings > API), so nothing was recorded"); process.exit(0); }
      try { j = await r.json(); } catch { j = {}; }
      if ((j.results || []).length) break;
    }
    out.searches.push({ q, type, totalTime: String(j.totalTime ?? ""), engines: j.engineTimings ?? j.engines ?? [], results: (j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.snippet, sources: x.sources, thumbnail: x.thumbnail || "", publishedAt: x.publishedAt || "" })) });
    console.log(`${type} / ${q}: ${(j.results || []).length} results`);
  } catch (e) { console.log(`${q}: no answer`); out.searches.push({ q, type, results: [] }); }
}
require("fs").writeFileSync("/tmp/ct-rec.json", JSON.stringify(out));
'@
[IO.File]::WriteAllText("$env:TEMP\ct-rec.js", $js)
docker cp "$env:TEMP\ct-rec.js" "${c}:/tmp/ct-rec.js"
docker exec $c bun /tmp/ct-rec.js
$dest = Join-Path (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path 'ct-tab-searches.json'
docker cp "${c}:/tmp/ct-rec.json" $dest
docker exec $c rm -f /tmp/ct-rec.js /tmp/ct-rec.json
Remove-Item -Force "$env:TEMP\ct-rec.js"
Write-Host "Saved: $dest  (attach this file in the chat)"
