# The update job, run by the watcher ($watcher below; one hidden process started at logon) whenever something happens:
# a new release, a ⚑ report, or a retry this job asked for (next-run.txt). Fetched at main's exact commit each time, so
# fixes to it apply by themselves. Installs only when degoog/install.ps1 on main changed. Silent when everything
# passes; a Windows notification only when something needs you. Log: %LOCALAPPDATA%\clean-titles\last-run.txt
$dir = Join-Path $env:LOCALAPPDATA 'clean-titles'
$mark = Join-Path $dir 'installed.txt'
$log = Join-Path $dir 'last-run.txt'
# Container engine: Podman once degoog/to-podman.ps1 moved this PC (its marker file), else Docker; every docker call below goes through this
$ctPodman = (Test-Path (Join-Path $env:LOCALAPPDATA 'clean-titles\engine-podman.txt')) -and [bool](Get-Command podman.exe -ErrorAction SilentlyContinue)
if ($ctPodman) { function docker { & podman.exe @args } }
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
# acqcath/scripts (its id in reports-session.txt), as soon as a ⚑ is saved or the updater hit a problem. Sending is non-interactive
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
# Log that never grows without end
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
# The watcher (degoog's only background process on this PC): written from here, so a new version of this job brings
# its new copy, which it then restarts into. Started hidden at logon from the Startup folder (Setup-Watcher).
$watcher = @'
# degoog clean-titles watcher: written by autoupdate-job.ps1 (this is its $watcher), started hidden at logon from the
# Startup folder. Checks nothing on a timer: it sleeps inside one docker exec (ct-wait.js in the degoog container),
# which returns only when something happens: a release was pushed (ntfy ping from the repo's GitHub Action, then
# confirmed with git), a ⚑ was saved, or the job asked to run again at a set time. Installs wait until degoog has had
# 15 s without a search and no game or other full-screen app is running. Log: watcher.txt next to this file.
$d = Join-Path $env:LOCALAPPDATA 'clean-titles'; $j = Join-Path $d 'job.ps1'; $wjs = Join-Path $d 'ct-wait.js'
# Podman once degoog/to-podman.ps1 moved this PC (its marker file): every docker call below goes to podman.exe
# ($ENG too: First-Line starts the program itself, which a PowerShell function can't redirect)
$ENG = 'docker'
if ((Test-Path (Join-Path $d 'engine-podman.txt')) -and (Get-Command podman.exe -ErrorAction SilentlyContinue)) { $ENG = 'podman.exe'; function docker { & podman.exe @args } }
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}
$mx = New-Object Threading.Mutex($false, 'Local\degoog-clean-titles-watcher')
try { if (-not $mx.WaitOne(20000)) { exit } } catch [Threading.AbandonedMutexException] {}
$self = $PSCommandPath; $selfHash = (Get-FileHash -LiteralPath $self).Hash
$TOPIC = 'degoog-ct-acqcath-9f4k2x7q'
$DIRC = '/app/data/plugins/clean-titles'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
function WLog($t) {
  try {
    $f = Join-Path $d 'watcher.txt'; Add-Content -Path $f -Value "$(Get-Date -Format s) $t"
    if ((Get-Item $f).Length -gt 100KB) { $k = Get-Content $f -Tail 100; Set-Content -Path $f -Value $k -Encoding UTF8 }
  } catch {}
}
function Git-Exe {
  $g = (Get-Command git -ErrorAction SilentlyContinue).Source
  foreach ($p in @("$env:ProgramFiles\Git\cmd\git.exe", (Join-Path $d 'mingit\cmd\git.exe'))) { if (-not $g -and (Test-Path $p)) { $g = $p } }
  $g
}
# main's commit, straight from GitHub (git ls-remote: not cached)
function Main-Sha {
  $g = Git-Exe; if (-not $g) { return '' }
  try { $env:GIT_TERMINAL_PROMPT = '0'; $l = & $g -c credential.helper= ls-remote https://github.com/acqcath/scripts refs/heads/main 2>$null | Out-String; if ($l -match '([0-9a-f]{40})') { return $Matches[1] } } catch {}
  ''
}
function Fetch($url, $file) {
  try {
    $req = [Net.HttpWebRequest]::Create($url); $req.UserAgent = 'degoog-clean-titles-watcher'; $req.Timeout = 30000
    $res = $req.GetResponse(); $sr = New-Object IO.StreamReader($res.GetResponseStream(), [Text.Encoding]::UTF8)
    $b = $sr.ReadToEnd(); $sr.Close(); $res.Close()
    if ($b.Length -gt 100) { [IO.File]::WriteAllText($file, $b, (New-Object Text.UTF8Encoding $true)); return $true }
  } catch { WLog "download failed ${url}: $($_.Exception.Message)" }
  $false
}
# The job at that exact commit (no cache can serve it stale), run as its own process, so nothing it does can stop
# the watcher; ct-wait.js from the same commit
function Get-Files($sha) {
  # no git yet (the job installs it): main itself
  $ref = if ($sha) { $sha } else { 'main' }
  $have = if (Test-Path "$j.sha") { (Get-Content "$j.sha" -Raw).Trim() } else { '' }
  if (-not $sha -or $have -ne $sha -or -not (Test-Path $j) -or -not (Test-Path $wjs)) {
    $a = Fetch "https://raw.githubusercontent.com/acqcath/scripts/$ref/degoog/autoupdate-job.ps1" $j
    $b = Fetch "https://raw.githubusercontent.com/acqcath/scripts/$ref/degoog/wip/files/ct-wait.js" $wjs
    if ($a -and $b) { Set-Content -Path "$j.sha" -Value $ref }
  }
}
function Run-Job($sha) {
  Get-Files $sha
  if (-not (Test-Path $j)) { WLog 'no job to run yet'; return }
  $env:CT_MAIN = $sha; $env:CT_WATCHER = '1'
  $p = Start-Process powershell.exe -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$j`"" -WindowStyle Hidden -PassThru
  # a run that hangs (a stuck download or docker call) is stopped after 30 min, so the watcher always goes back to sleep
  if (-not $p.WaitForExit(1800000)) { try { $p.Kill() } catch {}; WLog "job for $sha ran over 30 min: stopped" } else { WLog "job ran for $sha (exit $($p.ExitCode))" }
}
# A game or other full-screen app (Windows' own signal, the one that holds back notifications): heavy work waits
try { Add-Type -Namespace Ct -Name Quns -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);' -ErrorAction Stop } catch {}
function Busy { try { $qs = 0; return ([Ct.Quns]::SHQueryUserNotificationState([ref]$qs) -eq 0 -and $qs -in 2, 3, 4) } catch { return $false } }
function Wait-NotBusy { $n = 0; while (Busy) { if ($n++ -eq 0) { WLog 'a full-screen app is running: the install waits for it to close' }; Start-Sleep -Seconds 60 } }
function Container {
  try { docker ps -q 2>$null | Where-Object { (docker inspect $_ --format '{{range .Mounts}}{{.Destination}} {{end}}' 2>$null) -match '/app/data' } | Select-Object -First 1 } catch { $null }
}
# Runs a program and returns its first line of output (blocks until it prints one or ends)
function First-Line($exe, $argline) {
  $psi = New-Object Diagnostics.ProcessStartInfo $exe, $argline
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  $p = [Diagnostics.Process]::Start($psi)
  $line = $p.StandardOutput.ReadLine()
  try { if (-not $p.HasExited) { $p.Kill() } } catch {}
  $line
}
# degoog isn't running: sleep until docker reports a container start (if docker itself isn't up yet, it comes up
# with Windows: look again in 30 s)
function Wait-Container { if ($null -eq (First-Line $ENG 'events --filter type=container --filter event=start')) { Start-Sleep -Seconds 30 } }
# What's waiting to be sent right now (pc.json rev; "" = nothing); $null when it can't be read
function Rev($c) { try { $t = docker exec $c cat "$DIRC/pc.json" 2>$null | Out-String; if ($t.Trim()) { return [string](($t | ConvertFrom-Json).rev) }; return '' } catch {}; $null }
function Ms-Until-Timer {
  $f = Join-Path $d 'next-run.txt'
  if (-not (Test-Path $f)) { return 0 }
  try { $ms = [int64](([datetime](Get-Content $f -Raw).Trim()) - (Get-Date)).TotalMilliseconds; return [math]::Max(1, $ms) } catch { return 0 }
}
$sinceF = Join-Path $d 'ntfy-since.txt'
$since = if (Test-Path $sinceF) { (Get-Content $sinceF -Raw).Trim() } else { '' }
$handled = $null
$sha = Main-Sha
$mode = 'idle'   # first: catch up on anything released while the PC was off, once degoog is idle
WLog "watcher started (main $sha)"
while ($true) {
  try {
    $c = Container
    if (-not $c) { Wait-Container; continue }
    if (-not (Test-Path $wjs)) { Get-Files $sha; if (-not (Test-Path $wjs)) { Start-Sleep -Seconds 60; continue } }
    docker cp $wjs "${c}:/tmp/ct-wait.js" 2>$null | Out-Null
    if ($null -eq $handled) { $handled = Rev $c; if ($null -eq $handled) { $handled = '' } }
    $h = if ($handled) { $handled } else { '-' }; $s = if ($since) { $since } else { '-' }
    $t0 = Get-Date
    $line = First-Line $ENG "exec $c bun /tmp/ct-wait.js $DIRC $TOPIC $s $h $(Ms-Until-Timer) $mode"
    $ev = $null; try { $ev = $line | ConvertFrom-Json } catch {}
    if (-not $ev) {
      # degoog restarted (an install) or the exec failed: look again; a quick failure waits a little first
      if (((Get-Date) - $t0).TotalSeconds -lt 10) { Start-Sleep -Seconds 10 }
      continue
    }
    WLog "woke: $($ev.kind)"
    if ($ev.kind -eq 'update') { $since = [string]$ev.id; Set-Content -Path $sinceF -Value $since }
    if ($ev.kind -ne 'reports') { $sha2 = Main-Sha; if ($sha2) { $sha = $sha2 }; Wait-NotBusy }
    $mode = 'wait'
    Run-Job $sha
    # handled = what was waiting after this run (a send that failed doesn't wake it again until a new ⚑); a timer
    # the job didn't move forward is dropped, so neither can repeat in a loop
    $c2 = Container; $r = if ($c2) { Rev $c2 } else { $null }
    if ($null -ne $r) { $handled = $r } elseif ($ev.kind -eq 'reports') { $handled = [string]$ev.rev }
    if ($ev.kind -eq 'timer' -and (Ms-Until-Timer) -le 1) { Remove-Item (Join-Path $d 'next-run.txt') -ErrorAction SilentlyContinue }
    # this watcher changed with that version: hand over to the new copy
    if ((Get-FileHash -LiteralPath $self).Hash -ne $selfHash) {
      WLog 'watcher updated: restarting it'
      $mx.ReleaseMutex()
      $exe = if (Test-Path (Join-Path $d 'headless-ok.txt')) { 'conhost.exe' } else { 'powershell.exe' }
      $al = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`""
      if ($exe -eq 'conhost.exe') { $al = "--headless powershell.exe $al" }
      Start-Process $exe -ArgumentList $al -WindowStyle Hidden
      exit
    }
  } catch { WLog "error: $($_.Exception.Message)"; Start-Sleep -Seconds 30 }
}
'@

$tried = Join-Path $dir 'tried.txt'
# When this job wants to run again by itself (a failed install: in an hour; the AI still building: 10, 20, 40... min):
# the watcher sleeps until then (ct-wait.js timer), no checking in between
$nextF = Join-Path $dir 'next-run.txt'
function NextRun($when) { Set-Content -Path $nextF -Value ([datetime]$when).AddSeconds(5).ToString('o') }
# The watcher in place: its file (this version's copy), a Startup-folder shortcut (your user, no admin), running now,
# and the old every-minute task gone. If that task was made from an admin terminal this user can't remove it: it then
# starts a launcher that does nothing, and one notification asks to run the setup line once in an admin PowerShell.
function Setup-Watcher {
  try {
    $wf = Join-Path $dir 'watcher.ps1'
    $changed = -not (Test-Path $wf) -or ([IO.File]::ReadAllText($wf)) -ne $watcher
    if ($changed) { [IO.File]::WriteAllText($wf, $watcher, (New-Object Text.UTF8Encoding $true)) }
    # run from setup or to-podman (not by the watcher): an older running copy is ended, so the new one starts below
    if ($changed -and -not $env:CT_WATCHER) { Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'clean-titles\\watcher\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 1 }
    $old = Get-ScheduledTask -TaskName 'degoog clean-titles update' -ErrorAction SilentlyContinue
    $hk = Join-Path $dir 'headless-ok.txt'
    if ($old -and ($old.Actions | Select-Object -First 1).Execute -match 'conhost') { Set-Content -Path $hk -Value ok }
    $al = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wf`""
    $exe = 'powershell.exe'; if (Test-Path $hk) { $exe = 'conhost.exe'; $al = "--headless powershell.exe $al" }
    $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'degoog clean-titles watcher.lnk'
    $sh = New-Object -ComObject WScript.Shell
    $cur = if (Test-Path $lnk) { $sh.CreateShortcut($lnk) } else { $null }
    if (-not $cur -or $cur.Arguments -ne $al) { $k = $sh.CreateShortcut($lnk); $k.TargetPath = (Join-Path $env:WINDIR "System32\$exe"); $k.Arguments = $al; $k.WindowStyle = 7; $k.Save() }
    if (-not $env:CT_WATCHER) {
      $m = $null
      if ([Threading.Mutex]::TryOpenExisting('Local\degoog-clean-titles-watcher', [ref]$m)) { $m.Dispose() } else { Start-Process $exe -ArgumentList $al -WindowStyle Hidden }
    }
    if ($old) {
      # the task's own run only empties its launcher; the watcher's first job run removes the task, from outside it
      [IO.File]::WriteAllText((Join-Path $dir 'update.ps1'), "# replaced by the watcher (watcher.ps1); this does nothing`r`n", (New-Object Text.UTF8Encoding $true))
      if ($env:CT_WATCHER) { try { Unregister-ScheduledTask -TaskName 'degoog clean-titles update' -Confirm:$false -ErrorAction Stop; Log "$(Get-Date -Format s) old every-minute task removed: the watcher does it all now" }
      catch {
        $nf = Join-Path $dir 'task-nag.txt'
        if (-not (Test-Path $nf) -or (Get-Item $nf).LastWriteTime -lt (Get-Date).AddHours(-20)) {
          Set-Content -Path $nf -Value (Get-Date -Format s)
          Log "$(Get-Date -Format s) the old every-minute task can't be removed by this user: $($_.Exception.Message)"
          Notify 'degoog: run the setup line once more in an admin PowerShell to remove the old every-minute task (the new watcher is already running).'
        }
      } }
    }
  } catch { Log "watcher setup failed $(Get-Date -Format s): $($_.Exception.Message)"; Notify "degoog: the update watcher couldn't be set up. Details: $log" }
}
function SendReports { SendReportsCore; Setup-Watcher }
# Reads the installer's self-check output and records the outcome. The AI builds in the background on a first
# install: while the check says it isn't up yet, the version is "pending" and only the self-check is re-run (every
# 10 min, no reinstall, so degoog isn't restarted again). A failed install is retried after an hour (next-run.txt).
function Judge($sha, $out) {
  $aiPending = $out -match 'not answering yet|not active yet'
  if ($out -match 'All PASS \(clean-titles self-check\)') { $ok = $true; Issue '' }
  elseif ($out -match '(\d+) FAIL \(clean-titles self-check\)') { $ok = $true; Issue "self-check after updating to ${sha}: $($Matches[1]) FAIL`n$(Tail $out)" }
  else { $ok = $false; Issue "the update to $sha didn't finish`n$(Tail $out)" }
  if (-not $ok) { Set-Content -Path $tried -Value "$sha fail $(Get-Date -Format o)"; NextRun (Get-Date).AddMinutes(60) }
  elseif ($aiPending) {
    # n-th check in a row that found the AI not up yet: the next one waits twice as long (10 min, 20, 40... up to 6 h)
    $n = 1; if (Test-Path $tried) { $p = (Get-Content $tried -Raw).Trim() -split ' '; if ($p.Count -ge 4 -and $p[0] -eq $sha -and $p[1] -eq 'pending') { $n = [int]$p[3] + 1 } }
    Set-Content -Path $tried -Value "$sha pending $(Get-Date -Format o) $n"
    NextRun (Get-Date).AddMinutes([math]::Min(10 * [math]::Pow(2, $n - 1), 360))
    if ($n -eq 6) { Notify 'degoog: the AI part still is not up after 5 checks; the next checks back off (up to every 6 h).'; Issue "the AI part (ct-vision) is still not up after 5 self-checks for ${sha}`n$(Tail $out)" }
  }
  else { Set-Content -Path $mark -Value $sha; Remove-Item $tried, (Join-Path $dir 'watch-until.txt'), $nextF -ErrorAction SilentlyContinue }
}
try {
  # Version = a hash of the installer itself (raw files carry no commit id); unchanged file = 304, nothing to do
  $inst = Join-Path $dir 'installer.ps1'
  # main unchanged since the last look = nothing to do but the reports (the watcher passes main's commit in CT_MAIN)
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
  if ($t.Count -ge 3 -and $t[0] -eq $sha -and $t[1] -eq 'fail' -and $age -lt 60) { NextRun ([datetime]$t[2]).AddMinutes(60); SendReports; return }
  if ($t.Count -ge 3 -and $t[0] -eq $sha -and $t[1] -eq 'pending') {
    $wait = [math]::Min(10 * [math]::Pow(2, [math]::Max(0, [int]$(if ($t.Count -ge 4) { $t[3] } else { 1 }) - 1)), 360)
    if ($age -lt $wait) { NextRun ([datetime]$t[2]).AddMinutes($wait); SendReports; return }
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
  NextRun (Get-Date).AddMinutes(10) # GitHub down or a download timed out: the watcher tries again then
}
SendReports
