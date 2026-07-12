# install_host.ps1 — One-time setup for APAISuite's flatbed scanner native host.
#
# Run this by double-clicking "Install Scanner Bridge.cmd" in this same folder.
# No admin needed — writes only to HKCU and %LOCALAPPDATA%.
#
# What it does:
#   1. Copies scanner_host.py + run_scanner_host.cmd to
#      %LOCALAPPDATA%\APAISuite\ScannerHost\
#   2. Writes the Chrome native-messaging manifest JSON there.
#   3. Registers it in HKCU for Chrome AND Edge.
#
# After this runs, the extension can call:
#   chrome.runtime.sendNativeMessage('com.apaisuite.scanner_host', …)

$ErrorActionPreference = 'Stop'

$hostName   = 'com.apaisuite.scanner_host'
$suiteExtId = 'ckomcaimhnehdkhnngahpiboigbklpml'   # APAISuite ID from edge://extensions

$srcDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = Join-Path $env:LOCALAPPDATA 'APAISuite\ScannerHost'

# 1. Stage host files
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}
Copy-Item (Join-Path $srcDir 'scanner_host.py')      (Join-Path $installDir 'scanner_host.py')      -Force
Copy-Item (Join-Path $srcDir 'run_scanner_host.cmd') (Join-Path $installDir 'run_scanner_host.cmd') -Force

# 2. Write the native-messaging manifest
$hostCmd = Join-Path $installDir 'run_scanner_host.cmd'
$manifest = [ordered]@{
    name            = $hostName
    description     = 'APAISuite Canon flatbed scanner bridge (WIA + PDF417 decode)'
    path            = $hostCmd
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$suiteExtId/")
}
$manifestPath = Join-Path $installDir "$hostName.json"
$manifest | ConvertTo-Json -Depth 4 | Out-File -FilePath $manifestPath -Encoding utf8 -Force

# 3. Register for Chrome and Edge (HKCU — no admin)
foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
    $key = "HKCU:\Software\$browser\NativeMessagingHosts\$hostName"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name '(Default)' -Value $manifestPath
}

Write-Host ''
Write-Host '=== APAISuite Scanner Host installed ===' -ForegroundColor Green
Write-Host "Manifest:   $manifestPath"
Write-Host "Host cmd:   $hostCmd"
Write-Host "Extension:  $suiteExtId"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Power-cycle the Canon printer (hold power button → off → on).'
Write-Host '  2. Reload APAISuite at edge://extensions.'
Write-Host '  3. Open License Intake and click "Scan with Canon".'
Write-Host ''
Write-Host 'If the extension ID changed, edit $suiteExtId at the top of this'
Write-Host 'script and re-run.'
