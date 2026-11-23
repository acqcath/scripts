# Records the featured-snippet test searches from your own degoog (same shape as the first 50 recordings) and saves
# them in your Downloads folder as ct-snippet-searches.json (never the Desktop). Only titles, links, snippets and engine names are kept.
$c = docker ps -q | Where-Object { (docker inspect $_ --format '{{range .Mounts}}{{.Destination}} {{end}}') -match '/app/data' }
if (-not $c) { Write-Host "degoog container not found (is it running?)"; return }
$c = @($c)[0]
$js = @'
const qs = (process.env.CT_QS || "").split("|").filter(Boolean); // the searches to record, passed in when run
const PORT = process.env.DEGOOG_PORT || 4444;
const out = { at: new Date().toISOString(), searches: [] };
for (const q of qs) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(30000) });
    if (r.status === 401) { console.log("degoog's search API needs a key (Settings > API), so nothing was recorded"); process.exit(0); }
    const j = await r.json();
    out.searches.push({ q, type: "", totalTime: String(j.totalTime ?? ""), engines: j.engineTimings ?? j.engines ?? [], results: (j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.snippet, sources: x.sources })) });
    console.log(`${q}: ${(j.results || []).length} results`);
  } catch (e) { console.log(`${q}: no answer`); out.searches.push({ q, results: [] }); }
}
require("fs").writeFileSync("/tmp/ct-rec.json", JSON.stringify(out));
'@
[IO.File]::WriteAllText("$env:TEMP\ct-rec.js", $js)
docker cp "$env:TEMP\ct-rec.js" "${c}:/tmp/ct-rec.js"
docker exec $c bun /tmp/ct-rec.js
$dest = Join-Path (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path 'ct-snippet-searches.json'
docker cp "${c}:/tmp/ct-rec.json" $dest
docker exec $c rm -f /tmp/ct-rec.js /tmp/ct-rec.json
Remove-Item -Force "$env:TEMP\ct-rec.js"
Write-Host "Saved: $dest  (attach this file in the chat)"
