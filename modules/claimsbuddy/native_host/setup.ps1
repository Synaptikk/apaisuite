# setup.ps1 — One-time setup for APAISuite's VEE native messaging host.
#
# Don't run this directly — double-click "Install VEE bridge - Double-click
# me.cmd" in this same folder. The wrapper invokes PowerShell with
# -ExecutionPolicy Bypass so this script runs regardless of machine policy.
#
# What this does (HKCU + LocalAppData only — no admin needed):
#   1. Copies vee_host.ps1 + vee_host.cmd + lib\*.dll into
#      %LOCALAPPDATA%\APAISuite\NativeHost\
#   2. Writes the native-messaging manifest JSON pointing at the .cmd.
#      allowed_origins includes BOTH the donor ClaimsBuddy extension ID
#      AND the APAISuite extension ID, so whichever extension makes the
#      sendNativeMessage call gets through.
#   3. Registers it for Chrome AND Edge under
#      HKCU\Software\{Google\Chrome,Microsoft\Edge}\NativeMessagingHosts\
#      using the donor's host name (com.shanesmith.claimsbuddy_vee) so
#      the donor's vee.js library (HOST_NAME constant) keeps working
#      unchanged when used from inside the suite.
#
# After this runs once, the suite's ClaimsBuddy module can call
#   chrome.runtime.sendNativeMessage('com.shanesmith.claimsbuddy_vee', …)
# silently, with no further prompts.
#
# If the user later re-runs the DONOR's setup.ps1, that one writes a
# manifest with only the donor's ID — the suite stops working until this
# script is re-run. The standalone donor is unaffected either way.
#
# To uninstall: run uninstall.ps1 next to this file. That removes the
# APAISuite copy and the registry entry; if the donor is still installed
# you may want to re-run its setup to restore donor-only registration.

$ErrorActionPreference = 'Stop'

$hostName     = 'com.shanesmith.claimsbuddy_vee'
# Donor ClaimsBuddy extension ID (locked via manifest.json `key` field).
# Keeping it in allowed_origins means the donor still works if it's
# installed alongside the suite — important during the verification
# window when the user has both loaded.
$donorExtId   = 'gfjcbckbahifacpeoecjnfnloaaejmcc'
# APAISuite extension ID. CURRENT VALUE (no `key` in manifest yet, so this
# is whatever Edge assigned when the unpacked folder was first loaded).
# If the suite is reloaded from a different path, this ID changes and the
# script must be edited + re-run.
$suiteExtId   = 'ckomcaimhnehdkhnngahpiboigbklpml'

$installDir   = Join-Path $env:LOCALAPPDATA 'APAISuite\NativeHost'
$srcDir       = if ($srcDir) { $srcDir } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

# 1. Stage host files (.cmd + .ps1).
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}
$hostPs1 = Join-Path $installDir 'vee_host.ps1'
$hostCmd = Join-Path $installDir 'vee_host.cmd'
Copy-Item (Join-Path $srcDir 'vee_host.ps1') $hostPs1 -Force
Copy-Item (Join-Path $srcDir 'vee_host.cmd') $hostCmd -Force

# 1b. Stage bundled Verint client DLLs (used by the vee_realtime action to
#     call the per-store Enhanced Export Reporter WCF service directly).
$srcLib = Join-Path $srcDir 'lib'
if (Test-Path $srcLib) {
    $dstLib = Join-Path $installDir 'lib'
    if (-not (Test-Path $dstLib)) {
        New-Item -ItemType Directory -Path $dstLib -Force | Out-Null
    }
    Copy-Item (Join-Path $srcLib '*') $dstLib -Force
}

# 2. Write the native-messaging manifest with the absolute path baked in.
#    allowed_origins lists BOTH extension IDs so the donor (if installed)
#    and the suite can both call this host.
$manifest = [ordered]@{
    name            = $hostName
    description     = 'APAISuite / ClaimsBuddy VEE log reader'
    path            = $hostCmd
    type            = 'stdio'
    allowed_origins = @(
        "chrome-extension://$donorExtId/",
        "chrome-extension://$suiteExtId/"
    )
}
$manifestPath = Join-Path $installDir "$hostName.json"
$manifest | ConvertTo-Json -Depth 4 |
    Out-File -FilePath $manifestPath -Encoding utf8 -Force

# 3. Register for both browsers. Registry key value = absolute path to the
#    manifest JSON. This OVERWRITES any prior registration (e.g. donor's
#    pointing at %LOCALAPPDATA%\ClaimsBuddy\NativeHost\). Donor still works
#    because its ID is in our manifest's allowed_origins.
$registryPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)
foreach ($key in $registryPaths) {
    if (-not (Test-Path $key)) {
        New-Item -Path $key -Force | Out-Null
    }
    Set-Item -Path $key -Value $manifestPath
}

Write-Host ''
Write-Host '=== APAISuite VEE host installed ===' -ForegroundColor Green
Write-Host ('Manifest:     {0}' -f $manifestPath)
Write-Host ('Host script:  {0}' -f $hostCmd)
Write-Host  'Registered:   Chrome, Edge (HKCU)'
Write-Host  'Allowed IDs:  ' -NoNewline
Write-Host  $donorExtId      -ForegroundColor Cyan -NoNewline
Write-Host  ' (donor), '     -NoNewline
Write-Host  $suiteExtId      -ForegroundColor Cyan -NoNewline
Write-Host  ' (suite)'
Write-Host ''
Write-Host  'Next steps:'
Write-Host  '  1. Reload the APAISuite extension at edge://extensions.'
Write-Host  '  2. Open ClaimsBuddy in the suite, enter a store, hit Load.'
Write-Host  '     The VEE pill should turn green within a few seconds.'
Write-Host ''
Write-Host  'If the VEE pill still shows "forbidden" after reload:'
Write-Host  '  - Confirm the SUITE extension ID at edge://extensions matches'
Write-Host ('    ' + $suiteExtId)
Write-Host  '  - If it doesn''t, edit $suiteExtId at the top of this script'
Write-Host  '    to the new value and re-run the .cmd.'
