@echo off
:: Install Scanner Bridge — double-click to run.
:: Calls install_host.ps1 with ExecutionPolicy Bypass (no machine policy override needed).
powershell -ExecutionPolicy Bypass -File "%~dp0install_host.ps1"
pause
