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
  if ($out -match 'All PASS \(clean-titles self-check\)') { Set-Content -Path $mark -Value $sha }
  elseif ($out -match '(\d+) FAIL \(clean-titles self-check\)') { Set-Content -Path $mark -Value $sha; Notify "$($Matches[1]) check(s) failed after updating. Paste $log into the chat." }
  else { Notify "The update didn't finish (it will try again tomorrow). Details: $log" }
} catch {
  "update check failed $(Get-Date -Format s): $($_.Exception.Message)" | Add-Content -Path $log
}
