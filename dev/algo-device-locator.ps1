<#
  algo-device-locator.ps1 - locate Algo IP endpoints (8301 paging adapter, 8028 door
  phone, 8180/8186 speakers, ...) on a LAN and map a label MAC to a live IP.

  Stand-in for the vendor "Algo Device Locator" (algosolutions.com/resources/device-locator),
  whose only published build is a portable .zip; the corporate McAfee Web Gateway blocks it
  with "Block Types From Download Media Type Blocklist" (detected media type application/zip).
  Nothing to download here.

  How it identifies a device, strongest signal first:
    1. MAC in the neighbour (ARP) table carrying Algo's IEEE OUI 00:22:EE. On-link only --
       ARP does not cross a router, so this only resolves the scanner's own subnet.
    2. HTTP fingerprint of the Algo web UI on 80/443 -- works across subnets, which is how
       you find a device sitting on a VLAN other than your own.

  Usage:
    .\algo-device-locator.ps1                                   # this PC's own /24
    .\algo-device-locator.ps1 -Range 7.90.24.0/24,7.90.25.0/24
    .\algo-device-locator.ps1 -Range 7.90.24.20-7.90.24.90
    .\algo-device-locator.ps1 -Range 7.90.24.0/24 -Mac 00:22:EE:09:15:3D
    .\algo-device-locator.ps1 -Range 7.90.24.0/24 -All -Csv hosts.csv
#>
[CmdletBinding()]
param(
  [string[]]$Range,
  [string]$Mac,                       # label MAC to hunt for, any separator
  [int[]]$Ports = @(80,443),
  [int]$ConnectTimeoutMs = 600,
  [int]$HttpTimeoutMs = 4000,
  [int]$BatchSize = 254,
  [string]$Csv,
  [switch]$All,                       # report every web host, not just Algo matches
  [switch]$NoPing                     # skip the ARP-priming ping sweep
)

$ALGO_OUI = '00-22-ee'
$ALGO_RX  = 'algosolutions|Algo Communication|Algo\s?8\d{3}|realm="?Algo'

function Normalize-Mac([string]$m) {
  if (-not $m) { return $null }
  $h = ($m -replace '[^0-9A-Fa-f]','').ToLower()
  if ($h.Length -ne 12) { return $null }
  return (0..5 | ForEach-Object { $h.Substring($_*2,2) }) -join '-'
}

function IpToUInt([string]$ip) {
  $b = ([System.Net.IPAddress]::Parse($ip)).GetAddressBytes()
  [Array]::Reverse($b)
  return [System.BitConverter]::ToUInt32($b,0)
}

function UIntToIp([uint32]$n) {
  $b = [System.BitConverter]::GetBytes($n)
  [Array]::Reverse($b)
  return (New-Object System.Net.IPAddress(,$b)).IPAddressToString
}

function Expand-Range([string]$spec) {
  $spec = $spec.Trim()
  if ($spec -match '^(\d+\.\d+\.\d+\.\d+)/(\d{1,2})$') {
    $net = IpToUInt $Matches[1]
    $bits = [int]$Matches[2]
    if ($bits -lt 16 -or $bits -gt 32) { throw "prefix /$bits refused (use /16../32): $spec" }
    $mask = [uint32]([math]::Pow(2,32) - [math]::Pow(2,32-$bits))
    $first = $net -band $mask
    $last = $first -bor ((-bnot $mask) -band [uint32]::MaxValue)
    if ($bits -le 30) { $first = $first + 1; $last = $last - 1 }   # skip network + broadcast
    return ($first..$last | ForEach-Object { UIntToIp $_ })
  }
  if ($spec -match '^(\d+\.\d+\.\d+\.\d+)\s*-\s*(\d+\.\d+\.\d+\.\d+)$') {
    return ((IpToUInt $Matches[1])..(IpToUInt $Matches[2]) | ForEach-Object { UIntToIp $_ })
  }
  if ($spec -match '^(\d+\.\d+\.\d+)\.(\d+)\s*-\s*(\d+)$') {
    $prefix = $Matches[1]
    return ([int]$Matches[2]..[int]$Matches[3] | ForEach-Object { "$prefix.$_" })
  }
  if ($spec -match '^\d+\.\d+\.\d+\.\d+$') { return @($spec) }
  throw "unparsable range: $spec"
}

function Sweep-Ping($ips, [int]$timeoutMs) {
  $tasks = @()
  $pings = @()
  foreach ($ip in $ips) {
    $p = New-Object System.Net.NetworkInformation.Ping
    $pings += $p
    $tasks += $p.SendPingAsync($ip, $timeoutMs)
  }
  [void][System.Threading.Tasks.Task]::WaitAll($tasks, [math]::Max(5000, $timeoutMs * 4))
  $live = @()
  for ($i = 0; $i -lt $tasks.Count; $i++) {
    if ($tasks[$i].IsCompleted -and $tasks[$i].Result -and $tasks[$i].Result.Status -eq 'Success') { $live += $ips[$i] }
  }
  foreach ($p in $pings) { $p.Dispose() }
  return $live
}

function Sweep-Port($ips, [int]$port, [int]$timeoutMs) {
  $clients = @{}
  $handles = @{}
  foreach ($ip in $ips) {
    try {
      $c = New-Object System.Net.Sockets.TcpClient
      $clients[$ip] = $c
      $handles[$ip] = $c.BeginConnect($ip, $port, $null, $null)
    } catch { }
  }
  Start-Sleep -Milliseconds $timeoutMs
  $open = @()
  foreach ($ip in $ips) {
    if ($handles.ContainsKey($ip) -and $handles[$ip].IsCompleted) {
      try { $clients[$ip].EndConnect($handles[$ip]); $open += $ip } catch { }
    }
    if ($clients.ContainsKey($ip)) { $clients[$ip].Close() }
  }
  return $open
}

function Probe-Http([string]$ip, [int]$port, [int]$timeoutMs) {
  if ($port -eq 443) { $scheme = 'https' } else { $scheme = 'http' }
  $out = [ordered]@{ Scheme = $scheme; Status = $null; Server = $null; Realm = $null; Title = $null; Body = '' }
  $resp = $null
  try {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    $req = [System.Net.HttpWebRequest]::Create("${scheme}://${ip}:${port}/")
    $req.Timeout = $timeoutMs
    $req.ReadWriteTimeout = $timeoutMs
    $req.UserAgent = 'algo-device-locator/1.0'
    $req.AllowAutoRedirect = $true
    $req.Proxy = $null                 # corp proxy must not swallow a LAN probe
    $resp = $req.GetResponse()
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response      # a 401 from an Algo endpoint still carries the realm
    if (-not $resp) { return $null }
  } catch { return $null }
  try {
    $out.Status = [int]$resp.StatusCode
    $out.Server = $resp.Headers['Server']
    $out.Realm  = $resp.Headers['WWW-Authenticate']
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $buf = New-Object char[] 8192
    $n = $sr.Read($buf, 0, 8192)
    if ($n -gt 0) { $out.Body = (-join $buf[0..($n-1)]) }
    $sr.Close()
    if ($out.Body -match '(?is)<title>\s*(.*?)\s*</title>') { $out.Title = ($Matches[1] -replace '\s+',' ').Trim() }
  } catch { } finally { if ($resp) { $resp.Close() } }
  return $out
}

function Get-NeighborMap {
  $map = @{}
  try {
    Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.State -ne 'Unreachable' -and $_.LinkLayerAddress } |
      ForEach-Object { $map[$_.IPAddress] = $_.LinkLayerAddress.ToLower() }
  } catch {
    (arp -a) | ForEach-Object {
      if ($_ -match '^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F-]{17})') { $map[$Matches[1]] = $Matches[2].ToLower() }
    }
  }
  return $map
}

# ---- resolve the ranges ------------------------------------------------------
if (-not $Range) {
  $cfg = Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address } | Select-Object -First 1
  if (-not $cfg) { throw 'no active IPv4 interface; pass -Range' }
  $selfIp = $cfg.IPv4Address[0].IPAddress
  $selfLen = $cfg.IPv4Address[0].PrefixLength
  $Range = @("$selfIp/$selfLen")
  Write-Host "No -Range given; scanning this PC's own subnet $selfIp/$selfLen" -ForegroundColor DarkGray
}
$targets = @()
foreach ($r in $Range) { $targets += Expand-Range $r }
$targets = @($targets | Select-Object -Unique)
$wantMac = Normalize-Mac $Mac
if ($Mac -and -not $wantMac) { throw "not a MAC address: $Mac" }

$hunting = ''
if ($wantMac) { $hunting = ", hunting $wantMac" }
Write-Host ("Scanning {0} address(es) on port(s) {1}{2}" -f $targets.Count, ($Ports -join ','), $hunting) -ForegroundColor Cyan

# ---- pass 1: prime ARP (also finds on-link Algo MACs even if no web port) ----
if (-not $NoPing) {
  $live = @()
  for ($i = 0; $i -lt $targets.Count; $i += $BatchSize) {
    $chunk = $targets[$i..([math]::Min($i + $BatchSize - 1, $targets.Count - 1))]
    $live += Sweep-Ping $chunk 400
    Write-Host ("  ping {0}/{1} ... {2} alive" -f [math]::Min($i + $BatchSize, $targets.Count), $targets.Count, $live.Count) -ForegroundColor DarkGray
  }
}
$neigh = Get-NeighborMap

# ---- pass 2: TCP + HTTP fingerprint -----------------------------------------
$openByIp = @{}
foreach ($port in $Ports) {
  $found = @()
  for ($i = 0; $i -lt $targets.Count; $i += $BatchSize) {
    $chunk = $targets[$i..([math]::Min($i + $BatchSize - 1, $targets.Count - 1))]
    $o = Sweep-Port $chunk $port $ConnectTimeoutMs
    $found += $o
    foreach ($ip in $o) {
      if (-not $openByIp.ContainsKey($ip)) { $openByIp[$ip] = @() }
      $openByIp[$ip] += $port
    }
  }
  Write-Host ("  port {0}: {1} host(s) listening" -f $port, $found.Count) -ForegroundColor DarkGray
}

$results = @()
foreach ($ip in ($openByIp.Keys | Sort-Object { IpToUInt $_ })) {
  $mac = $neigh[$ip]
  $isAlgoMac = ($mac -and $mac.StartsWith($ALGO_OUI))
  $hit = $null
  foreach ($port in $openByIp[$ip]) {
    $h = Probe-Http $ip $port $HttpTimeoutMs
    if ($h) {
      $hit = $h
      if ("$($h.Title) $($h.Server) $($h.Realm) $($h.Body)" -match $ALGO_RX) { break }
    }
  }
  $blob = ''
  if ($hit) { $blob = "$($hit.Title) $($hit.Server) $($hit.Realm) $($hit.Body)" }
  $isAlgoWeb = ($blob -match $ALGO_RX)
  $model = $null
  if ($blob -match '(?i)\b(8\d{3})\b') { $model = 'Algo ' + $Matches[1] }
  $rdns = $null
  try { $rdns = [System.Net.Dns]::GetHostEntry($ip).HostName } catch { }
  $tag = ''
  if ($isAlgoMac) { $tag = 'MAC+OUI' } elseif ($isAlgoWeb) { $tag = 'web UI' }
  $macOut = '(off-link)'
  if ($mac) { $macOut = $mac.ToUpper() }
  $match = ''
  if ($wantMac -and $mac -eq $wantMac) { $match = 'YES' }
  $results += [pscustomobject]@{
    IP = $ip; MAC = $macOut; Algo = $tag; Model = $model; Ports = ($openByIp[$ip] -join ',')
    Title = $hit.Title; Server = $hit.Server; Hostname = $rdns; MacMatch = $match
  }
}

# on-link Algo MACs whose web port never answered still matter
foreach ($kv in $neigh.GetEnumerator()) {
  if ($kv.Value.StartsWith($ALGO_OUI) -and -not ($results.IP -contains $kv.Key)) {
    $match = ''
    if ($wantMac -and $kv.Value -eq $wantMac) { $match = 'YES' }
    $results += [pscustomobject]@{
      IP = $kv.Key; MAC = $kv.Value.ToUpper(); Algo = 'MAC+OUI'; Model = $null; Ports = '(no web)'
      Title = $null; Server = $null; Hostname = $null; MacMatch = $match
    }
  }
}

if ($All) { $shown = $results } else { $shown = $results | Where-Object { $_.Algo -or $_.MacMatch } }
if ($shown) {
  $shown | Sort-Object MacMatch -Descending | Format-Table IP,MAC,Algo,Model,Ports,Title,Hostname -AutoSize
} else {
  Write-Host 'No Algo endpoints found in that range (use -All to list every web host).' -ForegroundColor Yellow
}
if ($wantMac) {
  $m = $results | Where-Object { $_.MacMatch -eq 'YES' }
  if ($m) {
    Write-Host ("*** {0} is at {1} ***" -f $wantMac.ToUpper(), $m[0].IP) -ForegroundColor Green
  } else {
    Write-Host ("{0} not seen. ARP only resolves MACs on the scanner's own subnet -- if the device is on another VLAN, open the web UI of each Algo host listed above and read its MAC there." -f $wantMac.ToUpper()) -ForegroundColor Yellow
  }
}
if ($Csv) { $results | Export-Csv -NoTypeInformation -Path $Csv; Write-Host "wrote $Csv" -ForegroundColor DarkGray }
