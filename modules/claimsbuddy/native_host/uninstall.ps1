# uninstall.ps1 — Remove ClaimsBuddy's VEE native messaging host.
$ErrorActionPreference = 'SilentlyContinue'

$hostName   = 'com.shanesmith.claimsbuddy_vee'
$installDir = Join-Path $env:LOCALAPPDATA 'ClaimsBuddy\NativeHost'

Remove-Item "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName" -Recurse
Remove-Item "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"  -Recurse
Remove-Item $installDir -Recurse -Force

Write-Host '✓ ClaimsBuddy VEE host removed.' -ForegroundColor Green
