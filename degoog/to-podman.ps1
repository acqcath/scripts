# One-time move of degoog from Docker Desktop to Podman (run in an admin PowerShell; rerunning is safe).
# Waits for a running clean-titles update, pauses the auto-update watcher, sets up a Podman machine (rootful, GPU via CDI),
# copies every running container (except ct-vision, which the installer rebuilds) with its image, settings and volumes,
# checks degoog answers, then switches the installer/auto-update to Podman and runs the installer once.
# Anything fails -> Docker containers are started again and nothing is switched. Docker's copies stay (stopped) until
# you uninstall Docker Desktop yourself.
& {
$ErrorActionPreference = 'Continue'  # PS 5: 'Stop' turns any stderr line of a native tool into an error
$task = 'degoog clean-titles update'
$dir = Join-Path $env:LOCALAPPDATA 'clean-titles'
$marker = Join-Path $dir 'engine-podman.txt'
$mv = Join-Path $env:ProgramData 'ct-move'
New-Item -ItemType Directory -Force $dir, $mv | Out-Null
function Say($s) { Write-Host ('[to-podman] ' + $s) }
function Vm($p) { '/mnt/' + $p.Substring(0, 1).ToLower() + ($p.Substring(2) -replace '\\', '/') }
function Native { param([string]$exe, [string[]]$a) $o = & $exe @a 2>&1 | Out-String; if ($LASTEXITCODE -ne 0) { throw "$exe $($a -join ' ') failed: $o" }; $o }

# 1. let a running update finish, then pause the watcher (and the old every-minute task, if it's still there)
function CtProcs($pat) { @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match $pat }) }
$n = 0; while ((CtProcs 'clean-titles\\job\.ps1|clean-titles\\update\.ps1').Count -and $n -lt 360) { if ($n -eq 0) { Say 'waiting for the running update to finish...' }; Start-Sleep 5; $n++ }
CtProcs 'clean-titles\\(watcher|job|update)\.ps1' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$t = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
if ($t) { Disable-ScheduledTask -TaskName $task | Out-Null }
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'degoog clean-titles watcher.lnk'
function Resume { if ($t) { Enable-ScheduledTask -TaskName $task | Out-Null }; if (Test-Path $lnk) { Start-Process $lnk } }
Say 'auto-update paused'
$moved = @(); $oldPolicy = @{}
try {
  # 2. podman + its machine
  if (-not (Get-Command podman.exe -ErrorAction SilentlyContinue)) {
    Say 'installing podman...'
    winget install -e --id RedHat.Podman --accept-source-agreements --accept-package-agreements --silent | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command podman.exe -ErrorAction SilentlyContinue)) { throw 'podman did not install (winget RedHat.Podman)' }
  }
  if (-not ((& podman.exe machine list --format '{{.Name}}') 2>$null)) { Say 'creating the podman machine...'; Native podman.exe @('machine', 'init', '--rootful') | Out-Null }
  & podman.exe machine start 2>&1 | Out-Null
  Native podman.exe @('info', '--format', '{{.Host.Arch}}') | Out-Null
  if (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue) {
    Say 'GPU support for containers (nvidia container toolkit)...'
    [IO.File]::WriteAllText("$mv\gpu.sh", "set -e`ncommand -v nvidia-ctk >/dev/null || { curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo -o /etc/yum.repos.d/nvidia-container-toolkit.repo; dnf install -y -q nvidia-container-toolkit; }`nmkdir -p /etc/cdi; nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml >/dev/null`n")
    Native podman.exe @('machine', 'ssh', 'sudo', 'sh', ((Vm $mv) + '/gpu.sh')) | Out-Null
  }

  # 3. copy the containers
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'docker.exe not found: nothing to move' }
  & docker.exe info 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Say 'starting Docker Desktop...'; Start-Process (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'); $n = 0; do { Start-Sleep 3; & docker.exe info 2>&1 | Out-Null; $n++ } while ($LASTEXITCODE -ne 0 -and $n -lt 60) }
  $all = @((& docker.exe ps -q) | Where-Object { $_ } | ForEach-Object { (& docker.exe inspect $_ | Out-String | ConvertFrom-Json)[0] } | Where-Object { $_.Name.TrimStart('/') -notin 'ct-vision', 'ct-vision-setup' })
  if (-not ($all | Where-Object { ($_.Mounts | ForEach-Object Destination) -contains '/app/data' })) { throw 'no running degoog container (nothing mounted at /app/data) in Docker' }
  $all = @($all | Sort-Object { if ($_.HostConfig.NetworkMode -like 'container:*') { 1 } else { 0 } })
  $names = @{}; foreach ($x in $all) { $names[$x.Id] = $x.Name.TrimStart('/') }
  foreach ($x in $all) { $oldPolicy[$x.Name.TrimStart('/')] = $x.HostConfig.RestartPolicy.Name }
  Say ('stopping in Docker: ' + (($all | ForEach-Object { $_.Name.TrimStart('/') }) -join ', '))
  foreach ($x in $all) { & docker.exe update --restart no $x.Id | Out-Null; & docker.exe stop -t 10 $x.Id | Out-Null }
  foreach ($x in $all) {
    $nm = $x.Name.TrimStart('/'); Say "moving $nm..."
    # image: the exact one Docker has (save/load), run by its id
    $img = $x.Image
    & podman.exe image exists $img 2>$null
    if ($LASTEXITCODE -ne 0) { $tar = "$mv\image.tar"; Native docker.exe @('save', '-o', $tar, $x.Config.Image) | Out-Null; Native podman.exe @('load', '-q', '-i', $tar) | Out-Null; Remove-Item -Force $tar }
    & podman.exe image exists $img 2>$null; if ($LASTEXITCODE -ne 0) { $img = $x.Config.Image }
    $a = @('create', '--name', $nm)
    $rp = $oldPolicy[$nm]; if ($rp -and $rp -ne 'no') { $a += @('--restart', $rp) }
    $ef = "$mv\$nm.env"; [IO.File]::WriteAllLines($ef, [string[]]@($x.Config.Env | Where-Object { $_ })); $a += @('--env-file', $ef)
    if ($x.HostConfig.PortBindings) { foreach ($p in $x.HostConfig.PortBindings.PSObject.Properties) { foreach ($b in $p.Value) { $h = if ($b.HostIp) { $b.HostIp + ':' + $b.HostPort } else { $b.HostPort }; $a += @('-p', "${h}:$($p.Name)") } } }
    foreach ($m in $x.Mounts) {
      $ro = if ($m.RW) { '' } else { ':ro' }
      if ($m.Type -eq 'volume') {
        $v = $m.Name; & podman.exe volume exists $v 2>$null
        if ($LASTEXITCODE -ne 0) {
          Native podman.exe @('volume', 'create', $v) | Out-Null
          Native docker.exe @('run', '--rm', '-v', "${v}:/d", '-v', "${mv}:/o", 'alpine', 'tar', '-C', '/d', '-cf', "/o/$v.tar", '.') | Out-Null
          Native podman.exe @('run', '--rm', '-v', "${v}:/d", '-v', "${mv}:/i", 'docker.io/library/alpine', 'tar', '-C', '/d', '-xf', "/i/$v.tar") | Out-Null
          Remove-Item -Force "$mv\$v.tar"
        }
        $a += @('-v', "${v}:$($m.Destination)$ro")
      } elseif ($m.Type -eq 'bind') {
        $s = $m.Source
        if ($s -match '^/(run/desktop/mnt/host|host_mnt|mnt/host)/([a-z])(/.*)?$') { $s = $Matches[2].ToUpper() + ':' + ($Matches[3] -replace '/', '\'); if ($s.Length -eq 2) { $s += '\' } }
        if ($s -match '^[A-Za-z]:') { $a += @('-v', "${s}:$($m.Destination)$ro") }
        elseif ($s -match 'docker\.sock$') { Say "  skipped the Docker socket mount on $nm" }
        else { Say "  skipped bind mount $s (it lived inside Docker Desktop's own VM)" }
      }
    }
    $nmode = [string]$x.HostConfig.NetworkMode
    if ($nmode -like 'container:*') { $ref = $nmode.Substring(10); if ($names[$ref]) { $ref = $names[$ref] }; $a += @('--network', "container:$ref") }
    elseif ($nmode -eq 'host') { $a += @('--network', 'host') }
    elseif ($nmode -notin '', 'default', 'bridge') {
      & podman.exe network exists $nmode 2>$null; if ($LASTEXITCODE -ne 0) { Native podman.exe @('network', 'create', $nmode) | Out-Null }
      $a += @('--network', $nmode)
    }
    foreach ($c in @($x.HostConfig.CapAdd)) { if ($c) { $a += @('--cap-add', $c) } }
    foreach ($d in @($x.HostConfig.Devices)) { if ($d) { $a += @('--device', "$($d.PathOnHost):$($d.PathInContainer)") } }
    if ($x.HostConfig.Privileged) { $a += '--privileged' }
    if ($x.HostConfig.ShmSize -and $x.HostConfig.ShmSize -ne 67108864) { $a += @('--shm-size', [string]$x.HostConfig.ShmSize) }
    $ii = (& docker.exe image inspect $x.Image | Out-String | ConvertFrom-Json)[0].Config
    if ((@($x.Config.Entrypoint) -join "`n") -ne (@($ii.Entrypoint) -join "`n")) { Say "  note: $nm had its own entrypoint; using the image's" }
    $a += $img
    if ((@($x.Config.Cmd) -join "`n") -ne (@($ii.Cmd) -join "`n")) { $a += @($x.Config.Cmd) }
    Native podman.exe $a | Out-Null; $moved += $nm
    Remove-Item -Force $ef
    Native podman.exe @('start', $nm) | Out-Null
  }

  # 4. degoog answers in podman?
  $c = (& podman.exe ps -q --filter volume=/app/data) | Select-Object -First 1
  if (-not $c) { $c = (& podman.exe ps -q) | Where-Object { (& podman.exe inspect $_ --format '{{range .Mounts}}{{.Destination}} {{end}}') -match '/app/data' } | Select-Object -First 1 }
  if (-not $c) { throw 'degoog did not start in podman' }
  & podman.exe exec $c sh -c 'for i in $(seq 1 300); do curl -fs -o /dev/null http://127.0.0.1:${DEGOOG_PORT:-4444}/readyz && exit 0; sleep 0.2; done; exit 1' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'degoog in podman did not answer /readyz' }
  $deg = (& podman.exe inspect $c | Out-String | ConvertFrom-Json)[0]
  $hp = $null; if ($deg.HostConfig.PortBindings) { $hp = @($deg.HostConfig.PortBindings.PSObject.Properties)[0].Value[0].HostPort }
  if ($hp) { $ok = $false; foreach ($i in 1..30) { try { Invoke-WebRequest "http://127.0.0.1:$hp/readyz" -UseBasicParsing -TimeoutSec 3 | Out-Null; $ok = $true; break } catch { Start-Sleep 1 } }; if (-not $ok) { throw "degoog runs in podman but this PC can't reach it on port $hp" } }
  Say 'degoog answers in podman'
} catch {
  Say ('FAILED: ' + $_.Exception.Message)
  Say 'rolling back: Docker containers start again, nothing switched'
  foreach ($nm in $moved) { & podman.exe rm -f $nm 2>&1 | Out-Null }
  foreach ($k in $oldPolicy.Keys) { & docker.exe update --restart $oldPolicy[$k] $k 2>&1 | Out-Null; & docker.exe start $k 2>&1 | Out-Null }
  Remove-Item -Force -ErrorAction SilentlyContinue $marker
  Resume
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $mv
  'to-podman: FAIL (rolled back) - ' + $_.Exception.Message | Set-Clipboard
  Say 'the error is on your clipboard: paste it to Claude'
  return
}

# 5. switch: installer + auto-update use podman from now on; Docker Desktop no longer starts at sign-in
[IO.File]::WriteAllText($marker, "podman since $(Get-Date -Format s)")
try {
  Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Docker Desktop' -ErrorAction SilentlyContinue
  $sf = Join-Path $env:APPDATA 'Docker\settings-store.json'
  if (Test-Path $sf) { $js = Get-Content $sf -Raw | ConvertFrom-Json; $js | Add-Member -NotePropertyName AutoStart -NotePropertyValue $false -Force; [IO.File]::WriteAllText($sf, ($js | ConvertTo-Json -Depth 20)) }
} catch {}
& docker.exe rm -f ct-vision ct-vision-setup 2>&1 | Out-Null
Get-Process 'Docker Desktop', 'com.docker.backend' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $mv
Say 'switched to podman. installing clean-titles into it now (degoog restarts for a few seconds)...'
$o = & ([scriptblock]::Create((Invoke-RestMethod https://api.github.com/repos/acqcath/scripts/contents/degoog/install.ps1 -Headers @{Accept = 'application/vnd.github.raw'}))) 2>&1 | Out-String -Width 200
$o
# the job writes this version's watcher (an older copy on disk would still call docker.exe) and starts it
try {
  $jf = Join-Path $dir 'job.ps1'
  [IO.File]::WriteAllText($jf, (Invoke-RestMethod https://api.github.com/repos/acqcath/scripts/contents/degoog/autoupdate-job.ps1 -Headers @{Accept = 'application/vnd.github.raw'}), (New-Object Text.UTF8Encoding $true))
  Get-ChildItem $dir -Filter 'job.ps1.sha' -ErrorAction SilentlyContinue | Remove-Item -Force
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $jf | Out-Null
} catch { Say ('watcher update failed: ' + $_.Exception.Message) }
Resume
("to-podman: moved " + ($moved -join ', ') + "`n" + $o) | Set-Clipboard
Say 'done. the installer output is on your clipboard: paste it to Claude'
}
