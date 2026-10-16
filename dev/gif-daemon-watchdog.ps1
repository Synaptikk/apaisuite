# Runs every 5 min from the "APAISuite GIF daemon watchdog" scheduled task.
# If nothing answers on 127.0.0.1:8770/health AND the restart loop isn't running
# (it may be inside its 15 s restart gap), start the loop launcher again.
$log = Join-Path $env:USERPROFILE 'tools\android-sdk\gif-daemon.log'
try {
  $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri 'http://127.0.0.1:8770/health'
  if ($r.StatusCode -eq 200) { exit 0 }
} catch {}
$loop = Get-CimInstance Win32_Process -Filter "name='cmd.exe'" | Where-Object { $_.CommandLine -like '*gif-daemon-loop*' }
if ($loop) { exit 0 }
Add-Content -Path $log -Value ("{0} watchdog: daemon not answering and loop not running - starting it" -f (Get-Date -Format 'h:mm:ss tt'))
Start-Process -FilePath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\gif-daemon.cmd') -WindowStyle Minimized
