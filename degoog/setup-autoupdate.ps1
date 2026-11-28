# One-time setup: keeps clean-titles up to date by itself (your user, no admin). Sets up one hidden watcher, started
# at logon from your Startup folder, that sleeps until something happens: a new release (a push ping, confirmed with
# git), a ⚑ report saved in degoog, or a retry the job asked for. It installs only after degoog has had 2 minutes
# without a search and no game or other full-screen app is running (degoog restarts for a few seconds). Rerunning
# this is safe; from an admin PowerShell it also removes the old every-minute task. Output of each run:
# %LOCALAPPDATA%\clean-titles\last-run.txt (never the Desktop); a Windows notification only if something fails.
# Remove: delete "degoog clean-titles watcher" from shell:startup and end the hidden powershell running watcher.ps1.
$dir = Join-Path $env:LOCALAPPDATA 'clean-titles'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
try { Unregister-ScheduledTask -TaskName 'degoog clean-titles update' -Confirm:$false -ErrorAction Stop; 'old every-minute task removed' } catch {}
# Windows 11's headless console starts the watcher with no window flash; plain hidden PowerShell if it doesn't work here
$m = Join-Path $dir 'headless-test.txt'; Remove-Item $m -ErrorAction SilentlyContinue
try { $p = Start-Process conhost.exe -ArgumentList @('--headless', 'powershell.exe', '-NoProfile', '-Command', "Set-Content -LiteralPath '$m' -Value ok") -PassThru -WindowStyle Hidden; [void]$p.WaitForExit(30000) } catch {}
Start-Sleep -Milliseconds 500
if (Test-Path $m) { Remove-Item $m; Set-Content -Path (Join-Path $dir 'headless-ok.txt') -Value ok } else { Remove-Item (Join-Path $dir 'headless-ok.txt') -ErrorAction SilentlyContinue }
# The job installs the newest version, writes the watcher and its Startup shortcut, and starts it
$j = Join-Path $dir 'job.ps1'
[IO.File]::WriteAllText($j, (Invoke-RestMethod 'https://raw.githubusercontent.com/acqcath/scripts/main/degoog/autoupdate-job.ps1' -ErrorAction Stop), (New-Object Text.UTF8Encoding $true))
Write-Host 'Installing the newest version now (degoog restarts for a few seconds)...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $j
$tail = (Get-Content (Join-Path $dir 'last-run.txt') -ErrorAction SilentlyContinue | Select-Object -Last 3) -join "`n"
"$tail"
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'degoog clean-titles watcher.lnk'
if (Test-Path $lnk) { "Auto-update on: the watcher installs each new version as soon as degoog is idle. Log: $dir\watcher.txt" } else { "Watcher setup failed: see $dir\last-run.txt" }
