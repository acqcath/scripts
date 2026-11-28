# One-time setup: keeps clean-titles up to date by itself. Registers a Windows scheduled task (your user, no admin)
# that checks every minute (one quick git check; the full job hourly or while a fix is on its way) whether degoog/install.ps1 on main changed; only then it runs the installer (degoog
# restarts for a few seconds). Registered here in its final shape (headless start, no window flash); rerunning this is safe. The installer's output goes to
# %LOCALAPPDATA%\clean-titles\last-run.txt (never the Desktop); a Windows notification only if something fails. Remove with:
#   Unregister-ScheduledTask -TaskName 'degoog clean-titles update' -Confirm:$false
$dir = Join-Path $env:LOCALAPPDATA 'clean-titles'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$job = Join-Path $dir 'update.ps1'
# The job itself is fetched fresh from GitHub on every run, so improvements to it need no new setup
@'
try { & ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/acqcath/scripts/main/degoog/autoupdate-job.ps1' -ErrorAction Stop))) }
catch { "job download failed $(Get-Date -Format s): $($_.Exception.Message)" | Add-Content -Path (Join-Path $env:LOCALAPPDATA 'clean-titles\last-run.txt') }
'@ | Set-Content -Path $job -Encoding UTF8
# The task in its final shape, so the job never has to change it (it can't when this runs from an admin terminal):
# starts every minute (the launcher exits after one git check when there's nothing to do), through Windows 11's
# headless console so no window ever flashes; plain hidden PowerShell only if the headless start doesn't work here.
$ps = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$job`""
$m = Join-Path $dir 'headless-ok.txt'; Remove-Item $m -ErrorAction SilentlyContinue
try { $p = Start-Process conhost.exe -ArgumentList @('--headless', 'powershell.exe', '-NoProfile', '-Command', "Set-Content -LiteralPath '$m' -Value ok") -PassThru -WindowStyle Hidden; [void]$p.WaitForExit(30000) } catch {}
Start-Sleep -Milliseconds 500
if (Test-Path $m) { Remove-Item $m; $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe $ps" }
else { $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $ps }
$trigger = New-ScheduledTaskTrigger -Daily -At '00:00'
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'degoog clean-titles update' -Action $action -Trigger $trigger -Settings $settings -Description 'Updates the clean-titles degoog plugin when its installer on GitHub changes, and sends degoog flag reports to Claude' -Force | Out-Null
$t = Get-ScheduledTask -TaskName 'degoog clean-titles update'
"task: every $($t.Triggers[0].Repetition.Interval), start: $($t.Actions[0].Execute)"
# Run it once now, so you're on the newest version right away
Write-Host 'Installing the newest version now (degoog restarts for a few seconds)...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $job
$tail = (Get-Content (Join-Path $dir 'last-run.txt') -ErrorAction SilentlyContinue | Select-Object -Last 3) -join "`n"
"$tail"
"Auto-update on: checks every minute, installs within a minute of a new version. Log: $dir\last-run.txt"
