# dev/launch-edge-debug.ps1
#
# PowerShell version of launch-edge-debug.sh. Closes Edge, relaunches it with
# --remote-debugging-port=9222 using your normal profile. Run from this dev/ folder.

$ErrorActionPreference = "Stop"

$EdgeExe = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$UserDataDir = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
$Port = if ($env:EDGE_DEBUG_PORT) { $env:EDGE_DEBUG_PORT } else { 9222 }

if (-not (Test-Path $EdgeExe)) {
  Write-Error "Edge not found at: $EdgeExe"
  exit 1
}

Write-Host "-> closing any running Edge..."
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Write-Host "-> launching Edge with --remote-debugging-port=$Port"
Write-Host "   profile dir: $UserDataDir"
# Use a single argument string with embedded quotes around the path. PowerShell's
# Start-Process -ArgumentList @(...) drops/strips quotes for args containing
# spaces, which causes Edge to interpret "User Data" as two args and silently
# launch into a fresh "User" profile with no extensions. Quoting the whole
# --user-data-dir=... value with `" makes Edge see the literal path.
$argLine = "--remote-debugging-port=$Port `"--user-data-dir=$UserDataDir`""
Start-Process -FilePath $EdgeExe -ArgumentList $argLine
Start-Sleep -Seconds 3

# Probe via curl with --noproxy so the corp proxy doesn't intercept localhost.
# Invoke-WebRequest respects the system proxy even for loopback, which on the
# corp profile reroutes 127.0.0.1 through sysproxy.wal-mart.com and fails.
$probe = & curl.exe --noproxy "*" --ssl-no-revoke -s -o NUL -w "%{http_code}" "http://localhost:$Port/json/version" 2>$null
if ($probe -eq "200") {
  Write-Host "OK Edge is up with CDP on http://localhost:$Port" -ForegroundColor Green
  Write-Host "   next: npm run debug:aurorbuddy"
  exit 0
} else {
  Write-Host "FAIL CDP endpoint not responding on port $Port (curl returned: $probe)." -ForegroundColor Red
  Write-Host "  Likely cause: Walmart group policy blocks remote-debugging."
  Write-Host "  Confirm by opening http://localhost:$Port/json/version inside Edge itself."
  exit 1
}
