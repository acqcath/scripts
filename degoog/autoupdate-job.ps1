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
