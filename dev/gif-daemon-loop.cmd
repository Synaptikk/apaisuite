@echo off
rem Keeps the GIF daemon running: restarts it 15 s after it exits for any reason.
rem Started minimized by the Startup-folder gif-daemon.cmd; closing this window stops it.
cd /d %USERPROFILE%\Desktop\APAISuite\unified-extension-suite
:loop
%USERPROFILE%\nodejs\node\node.exe dev\gif-daemon.mjs >> %USERPROFILE%\tools\android-sdk\gif-daemon.log 2>&1
echo %date% %time% daemon exited with code %errorlevel% - restarting in 15 s >> %USERPROFILE%\tools\android-sdk\gif-daemon.log
timeout /t 15 /nobreak > nul
goto loop
