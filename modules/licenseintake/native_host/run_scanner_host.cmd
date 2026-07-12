@echo off
:: APAISuite Scanner Host launcher.
:: Chrome native messaging requires a .exe or .cmd as the host path.
:: This wrapper finds Python and passes it the scanner_host.py script.
:: Do NOT close this window — Chrome keeps it open while the extension
:: is using the scanner. It closes automatically when Chrome is done.
python "%~dp0scanner_host.py"
