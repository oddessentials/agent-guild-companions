# Does what a person does: installs the app silently, starts what was installed, and uninstalls it. With
# -Publisher, also checks that the installed app and uninstaller are signed and timestamped by that publisher.
#   ./scripts/windows/check-install.ps1 -Installer <setup.exe> -Screenshot <screen.png> [-Publisher <certificate subject>]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$Screenshot, [string]$Publisher)
$ErrorActionPreference = 'Stop'

$dir = Join-Path $env:LOCALAPPDATA 'Grove Companion'
$app = Join-Path $dir 'agent-guild-companions.exe'
$uninstaller = Join-Path $dir 'uninstall.exe'
$startup = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$entry = 'Grove Companion'

$install = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "The installer exited with code $($install.ExitCode)." }
foreach ($file in $app, $uninstaller) {
  if (-not (Test-Path -LiteralPath $file)) { throw "The installer did not put $file in place." }
  if ($Publisher) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate -or $signature.SignerCertificate.Subject -ne $Publisher) {
      throw "$file is not signed and timestamped by $Publisher ($($signature.Status), $($signature.SignerCertificate.Subject))."
    }
  }
}

$starts = (Get-ItemProperty -Path $startup -Name $entry -ErrorAction SilentlyContinue).$entry
if ($starts -ne "`"$app`"") { throw "The installer should start `"$app`" at sign-in, not: $starts" }

node (Join-Path $PSScriptRoot '..\smoke.mjs') $app $Screenshot
if ($LASTEXITCODE -ne 0) { throw "The installed app failed its start check with exit code $LASTEXITCODE." }

# The uninstaller copies itself and returns at once, so wait for the app to go.
$remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
if ($remove.ExitCode -ne 0) { throw "The uninstaller exited with code $($remove.ExitCode)." }
for ($i = 0; $i -lt 60 -and (Test-Path -LiteralPath $app); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path -LiteralPath $app) { throw "The uninstaller left $app behind." }
if ((Get-ItemProperty -Path $startup -Name $entry -ErrorAction SilentlyContinue).$entry) { throw 'The uninstaller left the app starting at sign-in.' }
Write-Output 'Installed, started, checked and uninstalled.'
