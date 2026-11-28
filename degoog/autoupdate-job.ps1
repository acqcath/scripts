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
# Reports from the flag in degoog go to Claude by themselves, all into ONE standing Claude Code cloud session on
# acqcath/scripts (its id in reports-session.txt): an update problem right away; the rest once the local model on the
# degoog server judges them worth a session (each turn uses weekly Claude usage). Sending is non-interactive
# (`claude -p --cloud <id>`, prompt on stdin, JSON result); only CREATING a cloud session needs a terminal, so that
# happens once, inside a headless console (no window), and the id is read off that console. If that fails (sign-in
# or a question on screen), the same thing opens in a visible window at most once a day, with a notification.
# Git and the Claude CLI are installed by the job itself.
$sessF = Join-Path $dir 'reports-session.txt'
$sessRe = '(session_[A-Za-z0-9]{16,}|cse_[A-Za-z0-9]{16,})'
# Run inside a console: starts `claude --cloud "<prompt>"`, reads the console text every 2 s until a session id shows,
# saves it, then closes claude (the session keeps running in the cloud)
$newSessPs = @'
param($promptFile, $outFile, $repo, $waitSec)
Set-Location -LiteralPath $repo
$q = [IO.File]::ReadAllText($promptFile)
$p = Start-Process claude -ArgumentList '--cloud', ('"' + $q + '"') -NoNewWindow -PassThru
$re = '(session_[A-Za-z0-9]{16,}|cse_[A-Za-z0-9]{16,})'
$end = (Get-Date).AddSeconds([int]$waitSec); $id = $null
while (-not $id -and (Get-Date) -lt $end) {
  Start-Sleep -Seconds 2
  try {
    $r = $Host.UI.RawUI; $w = $r.BufferSize.Width; $h = [Math]::Min($r.BufferSize.Height, $r.CursorPosition.Y + 60)
    $cells = $r.GetBufferContents((New-Object Management.Automation.Host.Rectangle 0, 0, ($w - 1), ($h - 1)))
    # rows back into lines: a full-width row was wrapped, so it joins the next one without a break
    $sb = New-Object Text.StringBuilder
    for ($y = 0; $y -lt $h; $y++) { $row = -join (0..($w - 1) | ForEach-Object { $cells[$y, $_].Character }); [void]$sb.Append($row.TrimEnd()); if ($row[$w - 1] -eq ' ') { [void]$sb.Append("`n") } }
    $t = $sb.ToString()
    if ($t -match $re) { $id = $Matches[1] }
  } catch {}
  if ($p.HasExited -and -not $id) { Start-Sleep -Seconds 1; if ($p.HasExited) { $end = (Get-Date).AddSeconds(3) } }
}
if ($id) { Set-Content -LiteralPath $outFile -Value $id }
try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } } catch {}
'@
$newSessPrompt = 'Standing session for degoog clean-titles flag reports. Reports from the user''s update job arrive here as later messages; handle each one as degoog/wip/QUICKSTART.md says under Flags. Nothing to do yet: reply only with the word ready.'
function New-ReportsSession($repo) {
  $ps1 = Join-Path $dir 'new-session.ps1'; $pf = Join-Path $dir 'new-session-prompt.txt'; $of = Join-Path $dir 'new-session-id.txt'
  $take = { if (Test-Path $of) { $i = (Get-Content $of -Raw).Trim(); Remove-Item $of; if ($i -match "^$sessRe$") { Set-Content -Path $sessF -Value $i; Log "$(Get-Date -Format s) reports session created: $i"; return $i } } }
  $got = & $take; if ($got) { return $got }   # e.g. from the visible window of an earlier run
  # at most one attempt a day: a start whose id couldn't be read may still have made a cloud session
  $att = Join-Path $dir 'new-session-attempt.txt'
  if ((Test-Path $att) -and (Get-Item $att).LastWriteTime -gt (Get-Date).AddHours(-20)) { return $null }
  Set-Content -Path $att -Value (Get-Date -Format s)
  [IO.File]::WriteAllText($ps1, $newSessPs, (New-Object Text.UTF8Encoding $true)); [IO.File]::WriteAllText($pf, $newSessPrompt)
  $args0 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ps1`"", "`"$pf`"", "`"$of`"", "`"$repo`"")
  # headless console: claude sees a real terminal, nothing shows on screen
  try { $p = Start-Process conhost.exe -ArgumentList (@('--headless', 'powershell.exe') + $args0 + '200') -PassThru -WindowStyle Hidden; if (-not $p.WaitForExit(240000)) { try { $p.Kill() } catch {} } } catch {}
  $got = & $take; if ($got) { return $got }
  # didn't work hidden (sign-in or a question on screen): the same in a visible window; a later run picks the id up
  Start-Process conhost.exe -ArgumentList (@('powershell.exe') + $args0 + '900')
  Notify "degoog: a Claude window opened to start the reports session. If it asks you to sign in or confirm, do that once; it closes itself."
  Log "$(Get-Date -Format s) reports session: hidden start found no session id, opened a visible window"
  return $null
}
function Send-ToSession($id, $text) {
  $pf = Join-Path $env:TEMP 'ct-report.txt'; $out = Join-Path $env:TEMP 'ct-claude.txt'
  [IO.File]::WriteAllText($pf, $text, (New-Object Text.UTF8Encoding $false))
  $p = Start-Process claude -ArgumentList '-p', '--cloud', $id, '--output-format', 'json' -WorkingDirectory $dir -NoNewWindow -PassThru -RedirectStandardInput $pf -RedirectStandardOutput $out -RedirectStandardError "$out.err"
  if (-not $p.WaitForExit(120000)) { try { $p.Kill() } catch {} }
  $res = ((Get-Content $out -Raw -ErrorAction SilentlyContinue) + '' + (Get-Content "$out.err" -Raw -ErrorAction SilentlyContinue))
  Remove-Item -Force $pf, $out, "$out.err" -ErrorAction SilentlyContinue
  $j = $null; foreach ($l in ($res -split "`n")) { if ($l.Trim().StartsWith('{')) { try { $j = $l | ConvertFrom-Json } catch {} } }
  return @{ ok = [bool]($j -and $j.ok); text = $res.Trim() }
}
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
    if (-not $w -or -not $w.n -or -not $w.send) { return }
    $stamp = Join-Path $dir 'reports-sent.txt'
    $mg = Join-Path $dir 'mingit'
    $env:Path = "$env:Path;$env:USERPROFILE\.local\bin;$env:ProgramFiles\Git\cmd;$mg\cmd"
    $nag = Join-Path $dir 'signin-nag.txt'
    if (-not ((Get-Command git -ErrorAction SilentlyContinue) -and (Get-Command claude -ErrorAction SilentlyContinue))) {
      # Installs what's missing by itself (the user asked for no manual installs), at most once a day
      if (-not (Test-Path $nag) -or (Get-Item $nag).LastWriteTime -lt (Get-Date).AddHours(-20)) {
        Set-Content -Path $nag -Value (Get-Date -Format s)
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) { winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null }
        # No winget (debloated Windows) or it failed: portable MinGit from Git for Windows' own releases, no installer
        if (-not (Get-Command git -ErrorAction SilentlyContinue) -and -not (Test-Path "$mg\cmd\git.exe")) {
          try {
            $rel = Invoke-RestMethod https://api.github.com/repos/git-for-windows/git/releases/latest
            $a = $rel.assets | Where-Object { $_.name -match '^MinGit-[\d.]+-64-bit\.zip$' } | Select-Object -First 1
            $zip = Join-Path $env:TEMP 'mingit.zip'
            Invoke-WebRequest $a.browser_download_url -OutFile $zip -UseBasicParsing
            Expand-Archive $zip -DestinationPath $mg -Force
            Remove-Item -Force $zip -ErrorAction SilentlyContinue
          } catch { Log "mingit install failed $(Get-Date -Format s): $($_.Exception.Message)" }
        }
        if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { try { Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression 2>&1 | Out-Null } catch {} }
      }
      if (-not ((Get-Command git -ErrorAction SilentlyContinue) -and (Get-Command claude -ErrorAction SilentlyContinue))) { Log "$(Get-Date -Format s) reports waiting: git or claude not installed yet"; return }
    }
    $repo = Join-Path $dir 'repo'
    if (-not (Test-Path (Join-Path $repo '.git'))) { git clone -q --depth 1 --filter=blob:none --sparse https://github.com/acqcath/scripts $repo 2>&1 | Out-Null; git -C $repo sparse-checkout set degoog 2>&1 | Out-Null }
    git -C $repo pull -q --ff-only 2>&1 | Out-Null
    $id = if (Test-Path $sessF) { (Get-Content $sessF -Raw).Trim() } else { '' }
    if ($id -notmatch "^$sessRe$") { $id = New-ReportsSession $repo; if (-not $id) { return } }
    $r = Send-ToSession $id $w.prompt
    # archived or deleted session: start a new standing one and send there
    if (-not $r.ok -and $r.text -match 'not found|archived') { Remove-Item $sessF -ErrorAction SilentlyContinue; $id = New-ReportsSession $repo; if ($id) { $r = Send-ToSession $id $w.prompt } }
    if ($r.ok) {
      docker exec $c bun /tmp/ct-flags.js sent | Out-Null
      "$(Get-Date -Format s) sent $($w.n) report(s) to $id" | Set-Content -Path $stamp
      # a fix is on its way: the full job runs every minute until it's installed (or 6 h pass)
      Set-Content -Path (Join-Path $dir 'watch-until.txt') -Value (Get-Date).AddHours(6).ToString('o')
      Remove-Item (Join-Path $dir 'send-fail.txt') -ErrorAction SilentlyContinue
    } elseif ($id) {
      Log "$(Get-Date -Format s) reports not sent to ${id}: $(Tail $r.text)"
      $sf = Join-Path $dir 'send-fail.txt'
      if (-not (Test-Path $sf) -or (Get-Item $sf).LastWriteTime -lt (Get-Date).AddHours(-20)) {
        Set-Content -Path $sf -Value (Get-Date -Format s)
        if ($r.text -match 'auth login|sign-in|/login|Not logged in') { Start-Process conhost.exe -ArgumentList 'powershell.exe', '-NoProfile', '-Command', 'claude auth login'; Notify 'degoog: sign in to Claude in the window that just opened (one time), so reports can be sent.' }
        else { Notify "degoog: reports couldn't be sent to Claude. Details: $log" }
      }
    }
  } catch {
    Log "reports check failed $(Get-Date -Format s): $($_.Exception.Message)"
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
# Below normal priority, for this run and everything it starts (git, docker), so a game keeps the CPU first
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git -and (Test-Path "$env:ProgramFiles\Git\cmd\git.exe")) { $git = "$env:ProgramFiles\Git\cmd\git.exe" }
# Runs every minute, but the full job only when main moved (a new release), hourly for reports, or while a fix is on
# its way; otherwise it stops after one git ls-remote. Any push to the repo (a version branch goes up about a minute
# before its merge) switches to a check every 10 s for 15 min, so a merge installs within ~10 s; idle stays once a minute.
$seenF = Join-Path $d 'main-seen.txt'; $fullF = Join-Path $d 'last-full.txt'; $refsF = Join-Path $d 'refs-seen.txt'; $fastF = Join-Path $d 'fast-until.txt'
$stop = (Get-Date).AddSeconds(50)
while ($true) {
  $env:CT_MAIN = ''; $refs = ''
  if ($git) { try { $env:GIT_TERMINAL_PROMPT = '0'; $l = & $git -c credential.helper= ls-remote --heads https://github.com/acqcath/scripts 2>$null | Out-String; if ($l -match '(?m)^([0-9a-f]{40})\s+refs/heads/main\s*$') { $env:CT_MAIN = $Matches[1]; $refs = ($l -split "`n" | Sort-Object) -join '' } } catch {} }
  if ($refs) {
    $h = -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($refs)) | Select-Object -First 8 | ForEach-Object { $_.ToString('x2') })
    $old = if (Test-Path $refsF) { (Get-Content $refsF -Raw).Trim() } else { '' }
    if ($h -ne $old) { Set-Content -Path $refsF -Value $h; if ($old) { Set-Content -Path $fastF -Value (Get-Date).AddMinutes(15).ToString('o') } }
  }
  $seen = if (Test-Path $seenF) { (Get-Content $seenF -Raw).Trim() } else { '' }
  $recent = (Test-Path $fullF) -and (Get-Item $fullF).LastWriteTime -gt (Get-Date).AddMinutes(-55)
  $watch = (Test-Path (Join-Path $d 'tried.txt')) -or (Test-Path (Join-Path $d 'watch-until.txt'))
  if (-not ($recent -and -not $watch -and (-not $env:CT_MAIN -or $seen -eq $env:CT_MAIN))) { break } # no git yet: hourly, as before
  $fast = (Test-Path $fastF) -and ([datetime](Get-Content $fastF -Raw).Trim()) -gt (Get-Date)
  if (-not $fast -or (Get-Date).AddSeconds(10) -gt $stop) { exit }
  Start-Sleep -Seconds 10
}
# The heavy part (an install with its degoog restart, the self-check's GPU and live-source tests, the local model
# judging reports) waits while a full-screen app runs (a game, also borderless; a full-screen video or presentation):
# it landed in the middle of games as ~20 s lag spikes. Windows itself says when (the same signal that holds back
# notifications); the check runs only here, about once an hour or after a release, and the next minute retries.
try {
  Add-Type -Namespace Ct -Name Quns -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);' -ErrorAction Stop
  $qs = 0; if ([Ct.Quns]::SHQueryUserNotificationState([ref]$qs) -eq 0 -and $qs -in 2, 3, 4) { exit }
} catch {}
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
if (Test-Path $j) { & $j; if ($env:CT_MAIN) { Set-Content -Path $seenF -Value $env:CT_MAIN }; Set-Content -Path $fullF -Value (Get-Date -Format s) } else { "job download failed $(Get-Date -Format s)" | Add-Content -Path (Join-Path $d 'last-run.txt') }
'@
try { if (-not (Test-Path $launch) -or (Get-Content $launch -Raw) -ne $launcher) { [IO.File]::WriteAllText($launch, $launcher, (New-Object Text.UTF8Encoding $true)) } } catch {}

$tried = Join-Path $dir 'tried.txt'
# The task is registered in its final shape by setup-autoupdate.ps1 (every minute, headless start); this job never
# changes it (a task made from an admin terminal can't be changed by the job: "Access is denied"). It only checks the
# shape, and if it's old, says so once a day: rerun the setup line.
function Check-Task {
try {
  $task = Get-ScheduledTask -TaskName 'degoog clean-titles update' -ErrorAction Stop
  $tr = $task.Triggers | Select-Object -First 1; $act = $task.Actions | Select-Object -First 1
  $ok = $tr -and $tr.Repetition -and $tr.Repetition.Interval -eq 'PT1M' -and $act -and $act.Arguments -match [regex]::Escape($launch)
  $nf = Join-Path $dir 'task-nag.txt'
  if ($ok) { Remove-Item $nf -ErrorAction SilentlyContinue; return }
  if (-not (Test-Path $nf) -or (Get-Item $nf).LastWriteTime -lt (Get-Date).AddHours(-20)) {
    Set-Content -Path $nf -Value (Get-Date -Format s)
    Log "$(Get-Date -Format s) task is in an old shape (interval $($tr.Repetition.Interval)): rerun setup-autoupdate.ps1"
    Notify 'degoog: auto-update needs its setup line run once more (in PowerShell) to check every minute.'
  }
} catch { Log "task check failed $(Get-Date -Format s): $($_.Exception.Message)" }
}
function SendReports { SendReportsCore; Check-Task }
# Reads the installer's self-check output and records the outcome. The AI builds in the background on a first
# install: while the check says it isn't up yet, the version is "pending" and only the self-check is re-run (every
# 10 min, no reinstall, so degoog isn't restarted again). A failed install is retried at most hourly, not every run.
function Judge($sha, $out) {
  $aiPending = $out -match 'not answering yet|not active yet'
  if ($out -match 'All PASS \(clean-titles self-check\)') { $ok = $true; Issue '' }
  elseif ($out -match '(\d+) FAIL \(clean-titles self-check\)') { $ok = $true; Issue "self-check after updating to ${sha}: $($Matches[1]) FAIL`n$(Tail $out)" }
  else { $ok = $false; Issue "the update to $sha didn't finish`n$(Tail $out)" }
  if (-not $ok) { Set-Content -Path $tried -Value "$sha fail $(Get-Date -Format o)" }
  elseif ($aiPending) {
    # n-th check in a row that found the AI not up yet: the next one waits twice as long (10 min, 20, 40... up to 6 h)
    $n = 1; if (Test-Path $tried) { $p = (Get-Content $tried -Raw).Trim() -split ' '; if ($p.Count -ge 4 -and $p[0] -eq $sha -and $p[1] -eq 'pending') { $n = [int]$p[3] + 1 } }
    Set-Content -Path $tried -Value "$sha pending $(Get-Date -Format o) $n"
    if ($n -eq 6) { Notify 'degoog: the AI part still is not up after 5 checks; the next checks back off (up to every 6 h).'; Issue "the AI part (ct-vision) is still not up after 5 self-checks for ${sha}`n$(Tail $out)" }
  }
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
    $wait = [math]::Min(10 * [math]::Pow(2, [math]::Max(0, [int]$(if ($t.Count -ge 4) { $t[3] } else { 1 }) - 1)), 360)
    if ($age -lt $wait) { SendReports; return }
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
