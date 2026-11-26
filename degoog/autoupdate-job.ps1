# Job behind "degoog clean-titles update" (fetched fresh from GitHub each run, so fixes to it apply by
# themselves). Installs only when degoog/install.ps1 on main changed. Silent when everything passes; a Windows
# notification only when something needs you. Log: %LOCALAPPDATA%\clean-titles\last-run.txt
$dir = Join-Path $env:LOCALAPPDATA 'clean-titles'
$mark = Join-Path $dir 'installed.txt'
$log = Join-Path $dir 'last-run.txt'
function Notify($text) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $t = $x.GetElementsByTagName('text')
    $t.Item(0).AppendChild($x.CreateTextNode('degoog update')) | Out-Null
    $t.Item(1).AppendChild($x.CreateTextNode($text)) | Out-Null
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))
  } catch {}
}
# A problem goes onto the degoog server (update-issue.txt in the plugin folder), where the flag box in degoog offers
# "Fix in Claude" with it filled in; an all-PASS update clears it
function Issue($text) {
  try {
    $c = docker ps -q | Where-Object { (docker inspect $_ --format '{{range .Mounts}}{{.Destination}} {{end}}') -match '/app/data' } | Select-Object -First 1
    if (-not $c) { return }
    if ($text) { $f = Join-Path $env:TEMP 'ct-issue.txt'; [IO.File]::WriteAllText($f, "$(Get-Date -Format s)`n$text"); docker cp $f "${c}:/app/data/plugins/clean-titles/update-issue.txt" | Out-Null; Remove-Item -Force $f }
    else { docker exec $c rm -f /app/data/plugins/clean-titles/update-issue.txt | Out-Null }
  } catch {}
}
function Tail($t) { if ($t.Length -gt 2800) { $t.Substring($t.Length - 2800) } else { $t } }
# Reports from the flag in degoog go to Claude by themselves, all in one Claude Code session (claude --cloud) on
# acqcath/scripts: an update problem (the update broke something) right away; the rest once the local model on the
# degoog server (ai-summary's) judges them worth a session, since each session uses weekly Claude usage. Needs Git and the Claude Code CLI, signed in once, on this PC (the user installs them:
# licenses are theirs to accept); until then a notification (at most daily) gives the one line and reports wait.
function SendReportsCore {
  $js = Join-Path $env:TEMP 'ct-flags.js'
  try {
    $c = docker ps -q | Where-Object { (docker inspect $_ --format '{{range .Mounts}}{{.Destination}} {{end}}') -match '/app/data' } | Select-Object -First 1
    if (-not $c) { return }
    [IO.File]::WriteAllText($js, @'
const port = process.env.DEGOOG_PORT || 4444;
const q = process.argv[2] === "sent" ? "!cleantitles bridge flags sent=1" : "!cleantitles bridge flags prompt=1";
const r = await fetch(`http://127.0.0.1:${port}/api/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }) });
const j = await r.json();
process.stdout.write(String(j.html || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
'@)
    docker cp $js "${c}:/tmp/ct-flags.js" | Out-Null
    $w = (docker exec $c bun /tmp/ct-flags.js | Out-String) | ConvertFrom-Json
    if (-not $w -or -not $w.n) { return }
    $stamp = Join-Path $dir 'reports-sent.txt'
    if (-not $w.send) { return }
    $env:Path = "$env:Path;$env:USERPROFILE\.local\bin;$env:ProgramFiles\Git\cmd"
    $nag = Join-Path $dir 'signin-nag.txt'
    $ready = (Get-Command git -ErrorAction SilentlyContinue) -and (Get-Command claude -ErrorAction SilentlyContinue)
    if (-not $ready) {
      # Installs what's missing by itself (the user asked for no manual installs), at most once a day
      if (-not (Test-Path $nag) -or (Get-Item $nag).LastWriteTime -lt (Get-Date).AddHours(-20)) {
        Set-Content -Path $nag -Value (Get-Date -Format s)
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) { winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null }
        if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { try { Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression 2>&1 | Out-Null } catch {} }
      }
      return
    }
    $repo = Join-Path $dir 'repo'
    if (-not (Test-Path (Join-Path $repo '.git'))) { git clone -q --depth 1 --filter=blob:none --sparse https://github.com/acqcath/scripts $repo 2>&1 | Out-Null; git -C $repo sparse-checkout set degoog 2>&1 | Out-Null }
    git -C $repo pull -q --ff-only 2>&1 | Out-Null
    $out = Join-Path $env:TEMP 'ct-claude.txt'
    $p = Start-Process claude -ArgumentList '--cloud', ('"' + $w.prompt + '"') -WorkingDirectory $repo -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
    if (-not $p.WaitForExit(300000)) { try { $p.Kill() } catch {} }
    $res = ((Get-Content $out -Raw -ErrorAction SilentlyContinue) + (Get-Content "$out.err" -Raw -ErrorAction SilentlyContinue))
    Remove-Item -Force $out, "$out.err" -ErrorAction SilentlyContinue
    if ($res -match 'session_\w+') {
      docker exec $c bun /tmp/ct-flags.js sent | Out-Null
      "$(Get-Date -Format s) sent $($w.n) report(s): $($Matches[0])" | Set-Content -Path $stamp
      # a fix is on its way: check every minute until it's installed (or 6 h pass), then back to hourly
      Set-Content -Path (Join-Path $dir 'watch-until.txt') -Value (Get-Date).AddHours(6).ToString('o')
    } else {
      "$(Get-Date -Format s) reports not sent: $res" | Add-Content -Path $log
      if (-not (Test-Path $nag) -or (Get-Item $nag).LastWriteTime -lt (Get-Date).AddHours(-20)) {
        Set-Content -Path $nag -Value (Get-Date -Format s)
        # Not signed in yet: open Claude's sign-in once a day; approving it in the browser is the only step left
        Start-Process powershell -ArgumentList '-NoExit', '-Command', 'claude'
        Notify "degoog: approve the Claude sign-in that just opened (one time)."
      }
    }
  } catch {
    "reports check failed $(Get-Date -Format s): $($_.Exception.Message)" | Add-Content -Path $log
  } finally {
    Remove-Item -Force $js -ErrorAction SilentlyContinue
    if ($c) { docker exec $c rm -f /tmp/ct-flags.js 2>&1 | Out-Null }
  }
}
# Log that never grows without end (a failed check can repeat every minute while a fix is on its way)
function Log($line) {
  try {
    Add-Content -Path $log -Value $line
    if ((Get-Item $log).Length -gt 200KB) { $k = Get-Content $log -Tail 200; Set-Content -Path $log -Value $k -Encoding UTF8 }
  } catch {}
}
# Files come from raw.githubusercontent.com, not GitHub's API: the API allows 60 requests an hour per internet
# address without sign-in, shared by everyone behind the same campus address. Each fetch is conditional (ETag), so an
# unchanged file is a tiny 304 answer and the body is reused from the cache next to it.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
function Get-Cond($url, $cache, $accept) {
  $req = [Net.HttpWebRequest]::Create($url)
  $req.UserAgent = 'degoog-clean-titles-updater'
  $req.Accept = $accept
  $req.Timeout = 30000
  if ((Test-Path $cache) -and (Test-Path "$cache.etag")) { $req.Headers.Add('If-None-Match', (Get-Content "$cache.etag" -Raw).Trim()) }
  try {
    $res = $req.GetResponse()
    $sr = New-Object IO.StreamReader($res.GetResponseStream(), [Text.Encoding]::UTF8)
    $body = $sr.ReadToEnd(); $sr.Close()
    $et = $res.Headers['ETag']; $res.Close()
    [IO.File]::WriteAllText($cache, $body, (New-Object Text.UTF8Encoding $true))
    if ($et) { Set-Content -Path "$cache.etag" -Value $et } else { Remove-Item "$cache.etag" -ErrorAction SilentlyContinue }
    return @{ changed = $true; body = $body }
  } catch {
    $e = $_.Exception; while ($e.InnerException -and -not ($e -is [Net.WebException])) { $e = $e.InnerException }
    if ($e -is [Net.WebException] -and $e.Response -and [int]$e.Response.StatusCode -eq 304) { $e.Response.Close(); return @{ changed = $false; body = [IO.File]::ReadAllText($cache) } }
    throw
  }
}
# The launcher the scheduled task runs: fetches this job only when it changed (conditional request), and runs the
# last good copy when GitHub can't be reached, so one failed download never skips a run
$launch = Join-Path $dir 'update.ps1'
$launcher = @'
# Asks GitHub which commit main is on (git ls-remote: instant, not cached, not the API's 60-an-hour limit), so a
# release is seen within a minute; files are then fetched at that exact commit, which no cache can serve stale.
$d = Join-Path $env:LOCALAPPDATA 'clean-titles'; $j = Join-Path $d 'job.ps1'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git -and (Test-Path "$env:ProgramFiles\Git\cmd\git.exe")) { $git = "$env:ProgramFiles\Git\cmd\git.exe" }
$env:CT_MAIN = ''
if ($git) { try { $env:GIT_TERMINAL_PROMPT = '0'; $l = & $git -c credential.helper= ls-remote https://github.com/acqcath/scripts refs/heads/main 2>$null | Out-String; if ($l -match '^([0-9a-f]{40})') { $env:CT_MAIN = $Matches[1] } } catch {} }
$have = if (Test-Path "$j.sha") { (Get-Content "$j.sha" -Raw).Trim() } else { '' }
if (-not $env:CT_MAIN -or $have -ne $env:CT_MAIN -or -not (Test-Path $j)) {
  try {
    $ref = if ($env:CT_MAIN) { $env:CT_MAIN } else { 'main' }
    $req = [Net.HttpWebRequest]::Create("https://raw.githubusercontent.com/acqcath/scripts/$ref/degoog/autoupdate-job.ps1")
    $req.UserAgent = 'degoog-clean-titles-updater'; $req.Timeout = 30000
    $res = $req.GetResponse(); $sr = New-Object IO.StreamReader($res.GetResponseStream(), [Text.Encoding]::UTF8)
    $b = $sr.ReadToEnd(); $sr.Close(); $res.Close()
    if ($b -match 'degoog') { [IO.File]::WriteAllText($j, $b, (New-Object Text.UTF8Encoding $true)); Set-Content -Path "$j.sha" -Value $env:CT_MAIN }
  } catch {}
}
if (Test-Path $j) { & $j } else { "job download failed $(Get-Date -Format s)" | Add-Content -Path (Join-Path $d 'last-run.txt') }
'@
try { if (-not (Test-Path $launch) -or (Get-Content $launch -Raw) -ne $launcher) { [IO.File]::WriteAllText($launch, $launcher, (New-Object Text.UTF8Encoding $true)) } } catch {}

$tried = Join-Path $dir 'tried.txt'
# The task itself, kept in its best shape by this job. How often: driven by your flag reports, not a fixed clock. Hourly
# while nothing is on its way (that run also picks up new flag reports and sends them); every minute from the moment a
# report is sent until its fix is installed (or 6 h), and while an installed version waits on its AI self-check.
# Daily trigger repeating for 1 day works on every Windows version, started through Windows 11's headless console so no window ever flashes
# (powershell -WindowStyle Hidden still flashes, and stays open when Windows Terminal is the default). The headless
# start is tested first (it must leave a marker file); if it fails, the plain hidden start stays and it's retried daily.
function Sync-Task {
try {
  $wf = Join-Path $dir 'watch-until.txt'
  $fast = (Test-Path $tried) -or ((Test-Path $wf) -and ([datetime](Get-Content $wf -Raw).Trim()) -gt (Get-Date))
  if (-not $fast) { Remove-Item $wf -ErrorAction SilentlyContinue }
  $want = if ($fast) { 'PT1M' } else { 'PT1H' }
  $task = Get-ScheduledTask -TaskName 'degoog clean-titles update' -ErrorAction Stop
  $tr = $task.Triggers | Select-Object -First 1
  $act = $task.Actions | Select-Object -First 1
  $ps = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launch`""
  $okTrig = $tr -and $tr.Repetition -and $tr.Repetition.Interval -eq $want -and $tr.Repetition.Duration -eq 'P1D' -and $tr.CimClass.CimClassName -eq 'MSFT_TaskDailyTrigger'
  $okAct = $act -and $act.Execute -match 'conhost' -and $act.Arguments -match [regex]::Escape($launch)
  $newAct = $null
  if (-not $okAct) {
    $failF = Join-Path $dir 'headless-failed.txt'
    if (-not (Test-Path $failF) -or (Get-Item $failF).LastWriteTime -lt (Get-Date).AddDays(-1)) {
      $m = Join-Path $dir 'headless-ok.txt'; Remove-Item $m -ErrorAction SilentlyContinue
      try { $p = Start-Process conhost.exe -ArgumentList @('--headless', 'powershell.exe', '-NoProfile', '-Command', "Set-Content -LiteralPath '$m' -Value ok") -PassThru -WindowStyle Hidden; [void]$p.WaitForExit(30000) } catch {}
      Start-Sleep -Milliseconds 500
      if (Test-Path $m) { Remove-Item $m; Remove-Item $failF -ErrorAction SilentlyContinue; $newAct = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless $ps" }
      else { Set-Content -Path $failF -Value (Get-Date -Format s); Log "headless start test failed $(Get-Date -Format s); keeping the hidden start" }
    }
    if (-not $newAct -and -not ($act.Execute -match 'powershell' -and $act.Arguments -match [regex]::Escape($launch))) { $newAct = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($ps -replace '^powershell\.exe ', '') }
  }
  if (-not $okTrig -or $newAct) {
    $nt = New-ScheduledTaskTrigger -Daily -At '00:00'
    $nt.Repetition = (New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval ([Xml.XmlConvert]::ToTimeSpan($want)) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
    $setArgs = @{ TaskName = 'degoog clean-titles update'; Trigger = $nt; ErrorAction = 'Stop' }
    if ($newAct) { $setArgs.Action = $newAct }
    Set-ScheduledTask @setArgs | Out-Null
    Log "$(Get-Date -Format s) task set: every $(if ($fast) { 'minute' } else { 'hour' })$(if ($newAct) { ", start: $($newAct.Execute)" })"
  }
} catch { Log "task update failed $(Get-Date -Format s): $($_.Exception.Message)" }
}
function SendReports { SendReportsCore; Sync-Task }
# Reads the installer's self-check output and records the outcome. The AI builds in the background on a first
# install: while the check says it isn't up yet, the version is "pending" and only the self-check is re-run (every
# 10 min, no reinstall, so degoog isn't restarted again). A failed install is retried at most hourly, not every run.
function Judge($sha, $out) {
  $aiPending = $out -match 'not answering yet|not active yet'
  if ($out -match 'All PASS \(clean-titles self-check\)') { $ok = $true; Issue '' }
  elseif ($out -match '(\d+) FAIL \(clean-titles self-check\)') { $ok = $true; Issue "self-check after updating to ${sha}: $($Matches[1]) FAIL`n$(Tail $out)" }
  else { $ok = $false; Issue "the update to $sha didn't finish`n$(Tail $out)" }
  if (-not $ok) { Set-Content -Path $tried -Value "$sha fail $(Get-Date -Format o)" }
  elseif ($aiPending) { Set-Content -Path $tried -Value "$sha pending $(Get-Date -Format o)" }
  else { Set-Content -Path $mark -Value $sha; Remove-Item $tried, (Join-Path $dir 'watch-until.txt') -ErrorAction SilentlyContinue }
}
try {
  # Version = a hash of the installer itself (raw files carry no commit id); unchanged file = 304, nothing to do
  $inst = Join-Path $dir 'installer.ps1'
  # main unchanged since the last look = nothing to do (one git ls-remote a minute, done by the launcher)
  $seen = Join-Path $dir 'main-seen.txt'
  $tPend = (Test-Path $tried) -and ((Get-Content $tried -Raw) -notmatch ' ok ')
  if ($env:CT_MAIN -and -not $tPend -and (Test-Path $seen) -and (Get-Content $seen -Raw).Trim() -eq $env:CT_MAIN -and (Test-Path $inst)) { SendReports; return }
  $code = if ($env:CT_MAIN) { (Invoke-WebRequest "https://raw.githubusercontent.com/acqcath/scripts/$($env:CT_MAIN)/degoog/install.ps1" -UseBasicParsing -UserAgent 'degoog-clean-titles-updater' -TimeoutSec 60 -ErrorAction Stop).Content } else { (Get-Cond 'https://raw.githubusercontent.com/acqcath/scripts/main/degoog/install.ps1' $inst '*/*').body }
  if ($env:CT_MAIN) { [IO.File]::WriteAllText($inst, $code, (New-Object Text.UTF8Encoding $true)); Set-Content -Path $seen -Value $env:CT_MAIN }
  if ($code -notmatch 'clean-titles') { SendReports; return }
  $sha = -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($code)) | Select-Object -First 8 | ForEach-Object { $_.ToString('x2') })
  if ((Test-Path $mark) -and ((Get-Content $mark -Raw).Trim() -eq $sha)) { SendReports; return }
  $t = if (Test-Path $tried) { (Get-Content $tried -Raw).Trim() -split ' ' } else { @() }
  $age = if ($t.Count -ge 3) { ((Get-Date) - [datetime]$t[2]).TotalMinutes } else { 1e9 }
  if ($t.Count -ge 3 -and $t[0] -eq $sha -and $t[1] -eq 'fail' -and $age -lt 60) { SendReports; return }
  if ($t.Count -ge 3 -and $t[0] -eq $sha -and $t[1] -eq 'pending') {
    if ($age -lt 10) { SendReports; return }
    # self-check only, from the installer already downloaded (no reinstall, no degoog restart)
    $m = [regex]::Match($code, "WriteAllText\(`"\`$env:TEMP\\ct-check\.js`", @'\r?\n([\s\S]*?)\r?\n'@\)")
    $c = docker ps -q | Where-Object { (docker inspect $_ --format '{{range .Mounts}}{{.Destination}} {{end}}') -match '/app/data' } | Select-Object -First 1
    if ($m.Success -and $c) {
      $f = Join-Path $env:TEMP 'ct-check.js'; [IO.File]::WriteAllText($f, $m.Groups[1].Value)
      docker cp $f "${c}:/tmp/ct-check.js" | Out-Null
      $out = docker exec $c bun /tmp/ct-check.js 2>&1 | Out-String -Width 200
      docker exec $c rm -f /tmp/ct-check.js | Out-Null; Remove-Item -Force $f
      "$(Get-Date -Format s) self-check again for $sha`n$out" | Set-Content -Path $log -Encoding UTF8
      Judge $sha $out
      SendReports; return
    }
  }
  $clip = $null; try { $clip = Get-Clipboard -Raw -ErrorAction Stop } catch {}
  $out = ''
  try { $out = & ([scriptblock]::Create($code)) *>&1 | Out-String -Width 200 } catch { $out = "installer error: $($_.Exception.Message)" }
  "$(Get-Date -Format s) version $sha`n$out" | Set-Content -Path $log -Encoding UTF8
  if ($null -ne $clip) { try { Set-Clipboard -Value $clip } catch {} }   # the installer copies its table; keep yours
  Judge $sha $out
} catch {
  Log "update check failed $(Get-Date -Format s): $($_.Exception.Message)"
}
SendReports
