# Daily job behind "degoog clean-titles update" (fetched fresh from GitHub each run, so fixes to it apply by
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
function SendReports {
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
      if (-not (Test-Path $nag) -or (Get-Item $nag).LastWriteTime -lt (Get-Date).AddHours(-20)) {
        Set-Content -Path $nag -Value (Get-Date -Format s)
        Notify "degoog has $($w.n) report(s) to send to Claude. One-time setup in PowerShell: winget install Git.Git; irm https://claude.ai/install.ps1 | iex; claude"
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
    } else {
      "$(Get-Date -Format s) reports not sent: $res" | Add-Content -Path $log
      if (-not (Test-Path $nag) -or (Get-Item $nag).LastWriteTime -lt (Get-Date).AddHours(-20)) {
        Set-Content -Path $nag -Value (Get-Date -Format s)
        Notify "degoog has $($w.n) report(s) waiting. To let them go to Claude by themselves, sign in once: open PowerShell, run claude"
      }
    }
  } catch {
    "reports check failed $(Get-Date -Format s): $($_.Exception.Message)" | Add-Content -Path $log
  } finally {
    Remove-Item -Force $js -ErrorAction SilentlyContinue
    if ($c) { docker exec $c rm -f /tmp/ct-flags.js 2>&1 | Out-Null }
  }
}
# Checks every hour (one small GitHub request; installs only when something changed), so a fix reaches the PC
# within the hour. The job switches its own task to hourly once.
try {
  $task = Get-ScheduledTask -TaskName 'degoog clean-titles update' -ErrorAction Stop
  $tr = $task.Triggers | Select-Object -First 1
  if (-not $tr -or -not $tr.Repetition -or $tr.Repetition.Interval -ne 'PT1H') {
    $nt = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(7)) -RepetitionInterval (New-TimeSpan -Hours 1)
    Set-ScheduledTask -TaskName 'degoog clean-titles update' -Trigger $nt -ErrorAction Stop | Out-Null
  }
} catch {}
try {
  $sha = (Invoke-RestMethod 'https://api.github.com/repos/acqcath/scripts/commits?path=degoog/install.ps1&sha=main&per_page=1' -ErrorAction Stop)[0].sha
  if (-not $sha) { return }
  if ((Test-Path $mark) -and ((Get-Content $mark -Raw).Trim() -eq $sha)) { return }
  $code = Invoke-RestMethod 'https://api.github.com/repos/acqcath/scripts/contents/degoog/install.ps1' -Headers @{Accept = 'application/vnd.github.raw'} -ErrorAction Stop
  $clip = $null; try { $clip = Get-Clipboard -Raw -ErrorAction Stop } catch {}
  $out = ''
  try { $out = & ([scriptblock]::Create($code)) *>&1 | Out-String -Width 200 } catch { $out = "installer error: $($_.Exception.Message)" }
  "$(Get-Date -Format s) version $sha`n$out" | Set-Content -Path $log -Encoding UTF8
  if ($null -ne $clip) { try { Set-Clipboard -Value $clip } catch {} }   # the installer copies its table; keep yours
  # The image/answer AI builds in the background on its first install: while the check says it isn't up yet, this
  # version isn't marked done, so tomorrow's run installs it again and records the AI's real numbers
  $aiPending = $out -match 'not answering yet|not active yet'
  if ($out -match 'All PASS \(clean-titles self-check\)') { if (-not $aiPending) { Set-Content -Path $mark -Value $sha }; Issue '' }
  elseif ($out -match '(\d+) FAIL \(clean-titles self-check\)') { $n = $Matches[1]; if (-not $aiPending) { Set-Content -Path $mark -Value $sha }; Issue "self-check after updating to ${sha}: $n FAIL`n$(Tail $out)"; Notify "$n check(s) failed after updating. In degoog: tap the flag, then Fix in Claude." }
  else { Issue "the update to $sha didn't finish`n$(Tail $out)"; Notify "The update didn't finish (it tries again next hour). In degoog: tap the flag, then Fix in Claude." }
} catch {
  "update check failed $(Get-Date -Format s): $($_.Exception.Message)" | Add-Content -Path $log
}
SendReports
