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
$run = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
Remove-Item -LiteralPath $setup
if ($run.ExitCode -ne 0) { throw "The installer failed (exit $($run.ExitCode))." }
$dir = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Grove Companion').InstallLocation.Trim('"')
Start-Process -FilePath (Join-Path $dir 'agent-guild-companions.exe')
'Installed.'
```

It installs for this Windows user, starts the companion, and starts it at every sign-in. The person can turn that off with **Start at sign-in** in the tray menu, and installing again keeps their choice.

macOS:

```sh
set -e
app='/Applications/Grove Companion.app'
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/companion.dmg" https://github.com/oddessentials/agent-guild-companions/releases/latest/download/Grove-Companion-macos.dmg
if diskutil image attach --help >/dev/null 2>&1; then
  mkdir -p "$tmp/disk"
  diskutil image attach --nobrowse --readOnly --mountPoint "$tmp/disk" "$tmp/companion.dmg" >/dev/null
  detach='diskutil eject'
else
  hdiutil attach -nobrowse -readonly -mountpoint "$tmp/disk" "$tmp/companion.dmg" >/dev/null
  detach='hdiutil detach'
fi
pkill -f "$app/Contents/MacOS/" || true
for i in $(seq 30); do pgrep -f "$app/Contents/MacOS/" >/dev/null || break; sleep 1; done
rm -rf "$app"
ditto "$tmp/disk/Grove Companion.app" "$app"
$detach "$tmp/disk" >/dev/null
rm -rf "$tmp"
agent="$HOME/Library/LaunchAgents/com.oddessentials.agentguild.companion.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$agent" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.oddessentials.agentguild.companion</string>
  <key>AssociatedBundleIdentifiers</key><string>com.oddessentials.agentguild.companion</string>
  <key>ProgramArguments</key><array/>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
plutil -insert ProgramArguments.0 -string "$app/Contents/MacOS/agent-guild-companions" "$agent"
open "$app"
echo Installed.
```

It installs to `/Applications`, starts the companion, and starts it at every login. The person can turn that off with **Start at login** in the menu bar menu, and installing again keeps their choice. Dragging the app out of the disk image by hand installs it without starting it at login.

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

## Add a character

A character is a piece folder holding `piece.json` and `character.glb`. This checks it as **Add character…** in the tray or menu bar menu does, adds it and shows it. Set the `folder` line to the piece folder.

The companion must be running, and recent enough to take commands: each block says when to run Install first. It prints one line saying what happened, and fails when it didn't work.

Windows:

```powershell
$ErrorActionPreference = 'Stop'
$folder = 'C:\path\to\piece'
if (-not (Test-Path -LiteralPath (Join-Path $env:APPDATA 'com.oddessentials.agentguild.companion\control.json'))) { throw 'Grove Companion needs updating or starting first: run the Install block, then try again.' }
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$dir = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Grove Companion').InstallLocation.Trim('"')
& (Join-Path $dir 'agent-guild-companions.exe') add $folder | Write-Output
if ($LASTEXITCODE -ne 0) { throw 'The character was not added and shown.' }
```

macOS:

```sh
app='/Applications/Grove Companion.app'
folder='/path/to/piece'
if [ ! -f "$HOME/Library/Application Support/com.oddessentials.agentguild.companion/control.json" ]; then echo 'Grove Companion needs updating or starting first: run the Install block, then try again.'; exit 1; fi
"$app/Contents/MacOS/agent-guild-companions" add "$folder"
```

## Choose the spirit

Set the `spirit` line to Fox, Moss deer, Water spirit, Bird, Lantern or Hermit crab, or to an added character's title or id. The choice is kept, as it is from the menu. The same conditions apply as for adding a character.

Windows:

```powershell
$ErrorActionPreference = 'Stop'
$spirit = 'Fox'
if (-not (Test-Path -LiteralPath (Join-Path $env:APPDATA 'com.oddessentials.agentguild.companion\control.json'))) { throw 'Grove Companion needs updating or starting first: run the Install block, then try again.' }
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$dir = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Grove Companion').InstallLocation.Trim('"')
& (Join-Path $dir 'agent-guild-companions.exe') show $spirit | Write-Output
if ($LASTEXITCODE -ne 0) { throw 'The spirit was not changed.' }
```

macOS:

```sh
app='/Applications/Grove Companion.app'
spirit='Fox'
if [ ! -f "$HOME/Library/Application Support/com.oddessentials.agentguild.companion/control.json" ]; then echo 'Grove Companion needs updating or starting first: run the Install block, then try again.'; exit 1; fi
"$app/Contents/MacOS/agent-guild-companions" show "$spirit"
```

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
rm -f "$HOME/Library/LaunchAgents/com.oddessentials.agentguild.companion.plist"
launchctl enable "gui/$(id -u)/com.oddessentials.agentguild.companion" 2>/dev/null || true
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
