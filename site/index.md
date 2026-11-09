# Set up Agent Guild: Grove Companion

Grove Companion puts a Grove spirit on the desktop that reacts to the person's Agent Guild sessions. It runs on Windows 10 or 11 and macOS, and needs nothing connected to you.

Agent Guild itself: [agentguild.oddessentials.ai/agents](https://agentguild.oddessentials.ai/agents/).

Run each Windows block in PowerShell. If your shell isn't PowerShell, save the block as a `.ps1` file and run `powershell -NoProfile -ExecutionPolicy Bypass -File <file>`. Run each macOS block with `sh`, as one command.

## Install

Windows:

```powershell
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$setup = Join-Path $env:TEMP 'Grove-Companion-windows-setup.exe'
Invoke-WebRequest 'https://github.com/oddessentials/agent-guild-companions/releases/latest/download/Grove-Companion-windows-setup.exe' -OutFile $setup
$run = Start-Process -FilePath $setup -ArgumentList '/S', '/R' -Wait -PassThru
Remove-Item -LiteralPath $setup
if ($run.ExitCode -ne 0) { throw "The installer failed (exit $($run.ExitCode))." }
'Installed.'
```

It installs for this Windows user, starts the companion, and starts it at every sign-in.

macOS:

```sh
set -e
app='/Applications/Grove Companion.app'
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/companion.dmg" https://github.com/oddessentials/agent-guild-companions/releases/latest/download/Grove-Companion-macos.dmg
hdiutil attach -nobrowse -readonly -mountpoint "$tmp/disk" "$tmp/companion.dmg" >/dev/null
pkill -f "$app/Contents/MacOS/" || true
for i in $(seq 30); do pgrep -f "$app/Contents/MacOS/" >/dev/null || break; sleep 1; done
rm -rf "$app"
ditto "$tmp/disk/Grove Companion.app" "$app"
hdiutil detach "$tmp/disk" >/dev/null
rm -rf "$tmp"
open "$app"
echo Installed.
```

If the person named a folder, or the companion is already somewhere else (`mdfind "kMDItemCFBundleIdentifier == 'com.oddessentials.agentguild.companion'"`), change the `app=` line in every macOS block to that path.

## Check

Windows:

```powershell
for ($i = 0; $i -lt 30 -and -not (Get-Process agent-guild-companions -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
if (Get-Process agent-guild-companions -ErrorAction SilentlyContinue) { 'Grove Companion is running.' } else { 'Grove Companion is not running.' }
```

macOS:

```sh
app='/Applications/Grove Companion.app'
for i in $(seq 30); do pgrep -f "$app/Contents/MacOS/" >/dev/null && break; sleep 1; done
pgrep -f "$app/Contents/MacOS/" >/dev/null && echo 'Grove Companion is running.' || echo 'Grove Companion is not running.'
```

Once it is running, the spirit is on the desktop and reacts while Agent Guild runs. The person can drag it anywhere, and choose a spirit or add their own characters from its tray or menu bar icon.

## Update

Run the Install block again. It closes the companion, replaces it, and starts it again. The spirit's place, the chosen spirit and added characters are kept.

## Uninstall

Windows:

```powershell
$ErrorActionPreference = 'Stop'
$dir = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Grove Companion').InstallLocation.Trim('"')
$app = Join-Path $dir 'agent-guild-companions.exe'
$run = Start-Process -FilePath (Join-Path $dir 'uninstall.exe') -ArgumentList '/S' -Wait -PassThru
if ($run.ExitCode -ne 0) { throw "The uninstaller failed (exit $($run.ExitCode))." }
for ($i = 0; $i -lt 60 -and (Test-Path -LiteralPath $app); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path -LiteralPath $app) { throw 'The uninstaller did not finish.' }
'Uninstalled.'
```

macOS:

```sh
app='/Applications/Grove Companion.app'
pkill -f "$app/Contents/MacOS/" || true
for i in $(seq 30); do pgrep -f "$app/Contents/MacOS/" >/dev/null || break; sleep 1; done
rm -rf "$app"
echo Uninstalled.
```

Both close the companion first. They keep the spirit's place, the chosen spirit and added characters, for a later install.

## Remove its saved data

Only if the person asks to remove everything, after uninstalling:

Windows:

```powershell
Remove-Item -LiteralPath (Join-Path $env:APPDATA 'com.oddessentials.agentguild.companion'), (Join-Path $env:LOCALAPPDATA 'com.oddessentials.agentguild.companion') -Recurse -Force -ErrorAction SilentlyContinue
'Removed.'
```

macOS:

```sh
rm -rf "$HOME/Library/Application Support/com.oddessentials.agentguild.companion" "$HOME/Library/WebKit/com.oddessentials.agentguild.companion" "$HOME/Library/Caches/com.oddessentials.agentguild.companion"
echo Removed.
```
