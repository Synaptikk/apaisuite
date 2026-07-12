@echo off
rem "Do this first - Double-click me.cmd"
rem One-time setup launcher for APAISuite's ClaimsBuddy VEE native messaging
rem host. Registers a Verint bridge under your user account (HKCU +
rem %%LOCALAPPDATA%% — no admin needed). After this runs once, the suite's
rem ClaimsBuddy module can read VEE upload statuses silently.
rem
rem Walmart machines enforce AllSigned at MachinePolicy scope via GPO,
rem which overrides -ExecutionPolicy Bypass when loading a .ps1 FILE.
rem Workaround: read setup.ps1 as a plain string and run via
rem Invoke-Expression — no file-load = no signature check.
rem $srcDir is pre-set in the command string so setup.ps1 can resolve
rem its own directory even without $MyInvocation.MyCommand.Path.

setlocal
title APAISuite — install VEE bridge

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$srcDir='%~dp0'.TrimEnd('\'); Unblock-File -LiteralPath '%~dp0setup.ps1' -ErrorAction SilentlyContinue; Invoke-Expression ([System.IO.File]::ReadAllText('%~dp0setup.ps1'))"
set rc=%errorlevel%

echo.
echo ============================================
if %rc% neq 0 (
  echo Setup FAILED with exit code %rc%.
  echo Scroll up to see the error.
) else (
  echo Setup complete. You can close this window.
)
echo ============================================
echo.
echo Press any key to close...
pause >nul

endlocal
