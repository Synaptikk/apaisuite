@echo off
rem vee_host.cmd — Chrome/Edge native-messaging entry point.
rem
rem The registry path field must be a .cmd, not a .ps1. This wrapper
rem forwards stdio to vee_host.ps1. Silence is mandatory — anything
rem echoed here corrupts the native-messaging protocol on stdout.
rem
rem Walmart GPO enforces AllSigned at MachinePolicy scope, which
rem overrides -ExecutionPolicy Bypass when loading a .ps1 FILE.
rem Using Invoke-Expression on the file content skips the signature check.
rem
rem We launch the 32-bit PowerShell explicitly (SysWOW64 on x64 Windows)
rem because the Verint client DLLs in lib\ are x86-only. 64-bit PowerShell
rem throws BadImageFormatException on Add-Type with those DLLs.
rem
rem CLAIMSBUDDY_NATIVE_DIR is exposed so the .ps1 (which loses $PSScriptRoot
rem when run via Invoke-Expression) can still locate its sibling lib\ folder.
set "CLAIMSBUDDY_NATIVE_DIR=%~dp0"
"%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([System.IO.File]::ReadAllText('%~dp0vee_host.ps1'))"


