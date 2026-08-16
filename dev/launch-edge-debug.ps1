# dev/launch-edge-debug.ps1
#
# Launches Edge with --remote-debugging-port for CDP automation, using an
# ISOLATED profile with the unpacked suite preloaded.
#
# WHY NOT THE NORMAL PROFILE (this script used to, and it silently stopped
# working on 2026-08-16):
#   Chromium refuses to open the remote-debugging port when it is pointed at
#   the DEFAULT user-data-dir. The browser still launches, and the process
#   still carries --remote-debugging-port on its command line, but no
#   DevToolsActivePort file is written and nothing ever listens on the port —
#   so it looks like a policy block rather than a deliberate refusal.
#   Verified both ways: C:\temp\edge-debug opens the port immediately, the
#   default User Data dir never does.
#
#   It also meant this script force-closed every Edge window the user had
#   open, and exposed their real authenticated profile to CDP. The isolated
#   profile avoids both.
#
#   Cost: this profile has its own cookies, so Tableau/Workvivo need signing
#   in once. That is a one-time step and it persists in C:\temp\edge-debug.
#
# Run from the dev/ folder:  .\launch-edge-debug.ps1

$ErrorActionPreference = "Stop"

$EdgeExe     = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$ProfileDir  = if ($env:EDGE_DEBUG_PROFILE) { $env:EDGE_DEBUG_PROFILE } else { "C:\temp\edge-debug" }
$Port        = if ($env:EDGE_DEBUG_PORT) { $env:EDGE_DEBUG_PORT } else { 9222 }
$ExtensionPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not (Test-Path $EdgeExe)) { Write-Error "Edge not found at: $EdgeExe"; exit 1 }
if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null }

# Only stop the debug instance — never the user's real browser windows.
Write-Host "-> stopping any previous debug instance (leaving your normal Edge alone)..."
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like "*--user-data-dir=$ProfileDir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Write-Host "-> launching Edge  port=$Port  profile=$ProfileDir"
Write-Host "   loading unpacked extension: $ExtensionPath"
Start-Process -FilePath $EdgeExe -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$ProfileDir",
  "--load-extension=$ExtensionPath",
  "--no-first-run",
  "--no-default-browser-check"
)

# Probe with --noproxy so the corp proxy doesn't intercept loopback.
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  $probe = & curl.exe --noproxy "*" --ssl-no-revoke -s -o NUL -w "%{http_code}" "http://localhost:$Port/json/version" 2>$null
  if ($probe -eq "200") {
    Write-Host "OK  CDP is up on http://localhost:$Port" -ForegroundColor Green
    Write-Host "    APAISuite is loaded from $ExtensionPath"
    Write-Host "    First run: sign in to Tableau in this window once."
    exit 0
  }
}
Write-Host "FAIL CDP endpoint not responding on port $Port." -ForegroundColor Red
Write-Host "  If DevToolsActivePort is missing from $ProfileDir, Edge refused to open the port."
Write-Host "  Most common cause is pointing --user-data-dir at the DEFAULT Edge profile."
exit 1
