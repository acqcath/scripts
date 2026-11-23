# One-time setup: keeps clean-titles up to date by itself. Registers a Windows scheduled task (your user, no admin)
# that runs every day at 4:17 AM, or as soon as the PC is on after that. It checks whether degoog/install.ps1 on
# main changed; only then it runs the installer (degoog restarts for a few seconds). The installer's output goes to
# %LOCALAPPDATA%\clean-titles\last-run.txt (never the Desktop); a Windows notification only if something fails. Remove with:
#   Unregister-ScheduledTask -TaskName 'degoog clean-titles update' -Confirm:$false
$dir = Join-Path $env:LOCALAPPDATA 'clean-titles'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$job = Join-Path $dir 'update.ps1'
# The job itself is fetched fresh from GitHub on every run, so improvements to it need no new setup
@'
try { & ([scriptblock]::Create((Invoke-RestMethod 'https://api.github.com/repos/acqcath/scripts/contents/degoog/autoupdate-job.ps1' -Headers @{Accept = 'application/vnd.github.raw'} -ErrorAction Stop))) }
catch { "job download failed $(Get-Date -Format s): $($_.Exception.Message)" | Add-Content -Path (Join-Path $env:LOCALAPPDATA 'clean-titles\last-run.txt') }
'@ | Set-Content -Path $job -Encoding UTF8
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$job`""
$trigger = New-ScheduledTaskTrigger -Daily -At '4:17AM'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'degoog clean-titles update' -Action $action -Trigger $trigger -Settings $settings -Description 'Updates the clean-titles degoog plugin when its installer on GitHub changes' -Force | Out-Null
# Run it once now, so you're on the newest version right away
Write-Host 'Installing the newest version now (degoog restarts for a few seconds)...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $job
$tail = (Get-Content (Join-Path $dir 'last-run.txt') -ErrorAction SilentlyContinue | Select-Object -Last 3) -join "`n"
"$tail"
"Auto-update on: daily 4:17 AM (or when the PC is next on), only when there's a new version. Log: $dir\last-run.txt"
