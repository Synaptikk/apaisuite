# vee_host.ps1 â€” ClaimsBuddy native messaging host for VEE log reading.
#
# Speaks Chrome's native-messaging stdio protocol: 4-byte little-endian
# length prefix + UTF-8 JSON body, both directions. One-shot per invocation
# (matches chrome.runtime.sendNativeMessage's connect-once semantics).
#
# Request shape:   { "store": "9999" }            // store filter (optional)
# Response shape:  { "ok": true, "store": "9999",
#                    "fetchedAt": "2026-...",
#                    "records": [ { evidenceId, currentStatus, ... }, ... ] }
# On failure:      { "ok": false, "error": "..." }
#
# Parser is a port of ClaimsDashboard/test_parser.ps1 â€” same regex
# state-machine, same field semantics.

$ErrorActionPreference = 'Stop'

# â”€â”€â”€ Debug log (stderr-safe: never touches stdout) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Writes to %TEMP%\ClaimsBuddy_debug.log. Safe to leave enabled â€” the log
# helps diagnose "Error when communicating" without corrupting the protocol.
$script:dbgLog = Join-Path $env:TEMP 'ClaimsBuddy_debug.log'
function Write-Log([string]$msg) {
    $ts = (Get-Date).ToString('HH:mm:ss.fff')
    try { "$ts $msg" | Out-File $script:dbgLog -Append -Encoding UTF8 } catch {}
}
Write-Log "=== host started (PID $PID) ==="

# â”€â”€â”€ Native-messaging stdio helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Use the raw byte streams via [Console] so we sidestep PowerShell's text
# encoding / newline conversions on stdin/stdout. Anything that writes to
# the console outside of these functions (Write-Host, errors, etc.) will
# corrupt the protocol â€” keep this script silent on stdout.

function Read-Message {
    Write-Log 'Read-Message: opening stdin'
    $stdin = [Console]::OpenStandardInput()
    $lenBuf = New-Object byte[] 4
    $read = 0
    while ($read -lt 4) {
        $n = $stdin.Read($lenBuf, $read, 4 - $read)
        if ($n -le 0) { return $null }    # parent closed pipe
        $read += $n
    }
    $len = [BitConverter]::ToUInt32($lenBuf, 0)
    if ($len -le 0 -or $len -gt 16777216) { return $null }   # 16 MB sanity cap
    $msgBuf = New-Object byte[] $len
    $read = 0
    while ($read -lt $len) {
        $n = $stdin.Read($msgBuf, $read, $len - $read)
        if ($n -le 0) { return $null }
        $read += $n
    }
    $json = [System.Text.Encoding]::UTF8.GetString($msgBuf)
    Write-Log "Read-Message: got $($msgBuf.Length) bytes: $json"
    return ($json | ConvertFrom-Json)
}

function Write-Message($obj) {
    $stdout = [Console]::OpenStandardOutput()
    $json   = $obj | ConvertTo-Json -Depth 12 -Compress
    $bytes  = [System.Text.Encoding]::UTF8.GetBytes($json)
    $lenBuf = [BitConverter]::GetBytes([uint32]$bytes.Length)
    $stdout.Write($lenBuf, 0, 4)
    $stdout.Write($bytes,  0, $bytes.Length)
    $stdout.Flush()
}

# â”€â”€â”€ Verint log parser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function Get-VeeRecords {
    param([string]$Store)

    $logRoot = 'C:\Program Files (x86)\Verint\EnhancedExport\ExportUI\Logs'
    $records = New-Object System.Collections.Generic.List[object]

    if (-not (Test-Path $logRoot)) { return ,@() }

    foreach ($dir in (Get-ChildItem $logRoot -Directory -ErrorAction SilentlyContinue)) {
        $userFolder   = $dir.Name
        $mainLog      = Join-Path $dir.FullName 'EnhancedExport.log'
        $progressLogs = Get-ChildItem $dir.FullName -Filter 'EnhancedExport.Progress*.log' -ErrorAction SilentlyContinue

        # GUID â†’ final status, scanned out of the Progress logs first so we
        # can attach a status to each block as it's emitted.
        $statusMap = @{}
        foreach ($plog in $progressLogs) {
            foreach ($line in (Get-Content $plog.FullName -ErrorAction SilentlyContinue)) {
                if ($line -match '\[Ending State\] Name=(\w+),\s*Export Id:\s+([0-9a-f-]{36})') {
                    $statusMap[$matches[2]] = $matches[1]
                }
            }
        }

        if (-not (Test-Path $mainLog)) { continue }

        $inBlock = $false
        $cur = $null

        foreach ($line in (Get-Content $mainLog -ErrorAction SilentlyContinue)) {
            $ts = $null
            if ($line -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})') { $ts = $matches[1] }

            if ($line -like '*Enqueuing an export job*') {
                $inBlock = $true
                $cur = @{ TS=$ts; Template=$null; GUID=$null; Case=$null; User=$null; Store=$null }
                continue
            }
            if ($line -like '*Closed the login window*') { $inBlock = $false; $cur = $null; continue }
            if (-not $inBlock -or -not $cur) { continue }

            if ($line -match '- INFO\s+- Template\s+:\s+(.+)')     { $cur.Template = $matches[1].Trim() }
            if ($line -match 'Export Id:\s+([0-9a-f-]{36})')       { if (-not $cur.GUID) { $cur.GUID = $matches[1] } }
            if ($line -match '- INFO\s+- Case number\s+:\s+(\S+)') { $cur.Case = $matches[1].Trim(); if ($ts) { $cur.TS = $ts } }
            if ($line -match '- INFO\s+- User\s+:\s+(.+)')         { $cur.User = $matches[1].Trim() }
            if ($line -match '- INFO\s+- Server\s+:\s+(\d+)')      { $cur.Store = $matches[1].Trim() }

            if ($cur.GUID -and $cur.Case -and $cur.User -and $cur.Store) {
                $status = if ($statusMap.ContainsKey($cur.GUID)) { $statusMap[$cur.GUID] } else { 'Unknown' }
                $records.Add([PSCustomObject]@{
                    evidenceId    = $cur.Case
                    currentStatus = $status
                    attempts      = 1
                    userName      = ($cur.User -replace '^US\\', '')
                    template      = $cur.Template
                    timestamp     = $cur.TS
                    exportId      = $cur.GUID
                    store         = $cur.Store
                })
                $cur.GUID = $null   # allow more records in the same block
            }
        }
    }

    if ($Store) {
        $filtered = $records | Where-Object { $_.store -eq $Store }
    } else {
        $filtered = $records
    }
    # Sort newest first so app.js's "first record wins per evidenceId" picks
    # the latest status.
    return ,@($filtered | Sort-Object timestamp -Descending)
}

# â”€â”€â”€ DataFile (xlsb) helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

# The browser extension fetches DataFile.xlsb from SharePoint directly
# (using its existing OAuth session), encodes it as base64, and includes
# it in the native message payload as 'xlsbData'.  The host simply decodes
# and writes to a temp file -- no SharePoint auth needed here.
#
# teams.wal-mart.com uses Azure AD / modern auth, not Windows-integrated
# auth, so PowerShell cannot authenticate to it directly.
function Get-DataXlsb {
    param([string]$XlsbData)
    $tmp = Join-Path $env:TEMP ('ClaimsBuddy_DataFile_' + [guid]::NewGuid().ToString() + '.xlsb')
    try {
        if (-not $XlsbData) {
            throw 'xlsbData not provided -- extension must fetch DataFile.xlsb and send it as base64.'
        }
        Write-Log ("Get-DataXlsb: decoding base64 (" + $XlsbData.Length + " chars)")
        [System.IO.File]::WriteAllBytes($tmp, [Convert]::FromBase64String($XlsbData))

        if (-not (Test-Path $tmp)) { throw 'Temp file missing after base64 decode' }

        # .xlsb is ZIP-based; magic bytes 50 4B ("PK") confirm it.
        $hdr = [System.IO.File]::ReadAllBytes($tmp)[0..3]
        if (-not ($hdr[0] -eq 0x50 -and $hdr[1] -eq 0x4B)) {
            $snip = [System.Text.Encoding]::UTF8.GetString($hdr).Trim()
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            throw "Decoded data is not a valid xlsb (starts with '$snip')"
        }

        Write-Log ("Get-DataXlsb: OK, " + (Get-Item $tmp).Length + " bytes")
        return $tmp
    } catch {
        if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
        throw "DataFile decode failed: $($_.Exception.Message)"
    }
}

function Read-XlsbSheet {
    param($Wb, [string]$Sheet, [string[]]$Cols)
    $ws   = $Wb.Worksheets.Item($Sheet)
    $used = $ws.UsedRange
    $vals = $used.Value2
    if (-not $vals) { return ,@() }
    $hdr = @{}
    for ($c = 1; $c -le $used.Columns.Count; $c++) {
        $h = $vals[1, $c]; if ($h) { $hdr[$h.Trim()] = $c }
    }
    $out = [System.Collections.Generic.List[hashtable]]::new()
    for ($r = 2; $r -le $used.Rows.Count; $r++) {
        $row = [ordered]@{}; $any = $false
        foreach ($col in $Cols) {
            $v = if ($hdr.ContainsKey($col)) { $vals[$r, $hdr[$col]] } else { $null }
            $row[$col] = $v
            if ($null -ne $v -and $v -ne '') { $any = $true }
        }
        if ($any) { $out.Add($row) }
    }
    return ,$out.ToArray()
}

function Get-XlsbUsers {
    param([string]$Path)
    $xl = New-Object -ComObject Excel.Application
    $xl.Visible = $false; $xl.DisplayAlerts = $false
    try {
        $wb = $xl.Workbooks.Open($Path, 0, $true)
        try {
            $rows = Read-XlsbSheet $wb 'User Data' @('Userid','Name','Title','Team','Phone Nbr','Email')
            $map  = @{}
            foreach ($r in $rows) {
                $v = $r['Userid']; $uid = if ($null -ne $v) { [string]$v } else { '' }
                if ($uid) { $map[$uid] = $r }
            }
            return $map
        } finally { $wb.Close($false) }
    } finally {
        $xl.Quit()
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null
        [System.GC]::Collect()
    }
}

function Get-XlsbClaims {
    param([string]$Path, [string]$Store)
    $xl = New-Object -ComObject Excel.Application
    $xl.Visible = $false; $xl.DisplayAlerts = $false
    try {
        $wb = $xl.Workbooks.Open($Path, 0, $true)
        try {
            $cols = @('Claim Nbr','Reference Nbr','Adjuster','Claim Type','Date of Loss','Store','State','Status')
            $rows = Read-XlsbSheet $wb 'Claim' $cols
            foreach ($r in $rows) {
                $dol = $r['Date of Loss']
                if ($dol -is [double]) { $r['Date of Loss'] = [DateTime]::FromOADate($dol).ToString('yyyy-MM-dd') }
                $s = $r['Store']
                if ($s -is [double]) { $r['Store'] = [int]$s }
            }
            $filtered = if ($Store) { @($rows | Where-Object { [string]$_['Store'] -eq $Store }) } else { $rows }
            return ,$filtered
        } finally { $wb.Close($false) }
    } finally {
        $xl.Quit()
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null
        [System.GC]::Collect()
    }
}

# â”€â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

try {
    $req = Read-Message
    if ($null -eq $req) {
        Write-Message @{ ok = $false; error = 'no request received on stdin' }
        exit 0
    }

    $action = if ($req.PSObject.Properties['action']) { [string]$req.action } else { 'vee' }
    Write-Log "action=$action store=$($req.store)"

    switch ($action) {
        'sync_users' {
            Write-Log 'branch: sync_users'
            $xlsbData = if ($req.PSObject.Properties['xlsbData']) { [string]$req.xlsbData } else { $null }
            $xlsb = Get-DataXlsb -XlsbData $xlsbData
            try {
                $users = Get-XlsbUsers -Path $xlsb
                Write-Message @{ ok = $true; fetchedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"); users = $users }
            } finally {
                if ($xlsb -and (Test-Path $xlsb)) { Remove-Item $xlsb -Force -ErrorAction SilentlyContinue }
            }
        }
        'get_claims' {
            Write-Log 'branch: get_claims'
            $xlsbData = if ($req.PSObject.Properties['xlsbData']) { [string]$req.xlsbData } else { $null }
            $xlsb = Get-DataXlsb -XlsbData $xlsbData
            try {
                $store  = if ($req.PSObject.Properties['store']) { [string]$req.store } else { $null }
                $claims = Get-XlsbClaims -Path $xlsb -Store $store
                Write-Message @{ ok = $true; store = $store; fetchedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"); claims = $claims }
            } finally {
                if ($xlsb -and (Test-Path $xlsb)) { Remove-Item $xlsb -Force -ErrorAction SilentlyContinue }
            }
        }
        'vee_realtime' {
            Write-Log 'branch: vee_realtime'
            $store = if ($req.PSObject.Properties['store']) { [string]$req.store } else { $null }
            if (-not $store) { throw 'vee_realtime: store is required' }

            # Address: explicit override OR per-store DNS template per
            # VEEReporter.exe.config (SiteTemplate = vsrv01.s[XXXXX].us.wal-mart.com).
            $address = if ($req.PSObject.Properties['address']) { [string]$req.address } else { $null }
            if (-not $address) {
                $padded = $store.PadLeft(5, '0')
                $address = "vsrv01.s$padded.us.wal-mart.com"
            }

            # Date range. Default last 2 years — wide enough to catch exports
            # for older claims that are still in active rotation. The extension
            # always passes explicit times via the cache layer, so this default
            # mostly serves manual/diagnostic calls.
            $endTime = if ($req.PSObject.Properties['endTime']) { [DateTime]$req.endTime } else { Get-Date }
            $startTime = if ($req.PSObject.Properties['startTime']) { [DateTime]$req.startTime } else { $endTime.AddDays(-730) }
            Write-Log "vee_realtime: address=$address range=$startTime..$endTime"

            # Resolve the bundled Verint client DLL folder. $PSScriptRoot is empty
            # when this script runs via Invoke-Expression (which the .cmd does to
            # bypass AllSigned), so vee_host.cmd exports CLAIMSBUDDY_NATIVE_DIR.
            $libDir = if ($env:CLAIMSBUDDY_NATIVE_DIR) {
                Join-Path $env:CLAIMSBUDDY_NATIVE_DIR 'lib'
            } else {
                Join-Path (Join-Path $env:LOCALAPPDATA 'ClaimsBuddy\NativeHost') 'lib'
            }
            if (-not (Test-Path $libDir)) { throw "vee_realtime: lib folder not found at $libDir" }

            Add-Type -Path (Join-Path $libDir 'ItemsAndInterfaces.dll')
            Add-Type -Path (Join-Path $libDir 'EnhancedExportReporterClientCommunication.dll')
            # Common.dll / Common.Logging.* / log4net.dll / Log4NetAppenders.dll /
            # LogManager.dll / ServiceInterfaces.dll / VEETransferCommon.dll are
            # auto-resolved by the CLR's assembly loader when first referenced
            # (they live in the same lib\ directory).

            # Build the status filter — pass every enum value so the server returns
            # all transfers regardless of state (mirrors VEEReporter's "all checked"
            # default that produced the successful queries in the log).
            $statuses = New-Object 'System.Collections.Generic.List[TransferStatus]'
            foreach ($name in [Enum]::GetNames([TransferStatus])) {
                $statuses.Add([TransferStatus]$name)
            }

            # Construct the WCF client. Timeouts roughly match VEEReporter.exe.config
            # EXCEPT ReceiveTimeout — VEEReporter sets that to ~infinity, which is
            # why the UI hangs forever off-VPN. We cap it at 60s so the native host
            # surfaces a real error to the extension instead of spinning.
            $client = New-Object CommunicationChannels.Client.EnhancedExportReporterServiceInstance @(
                $address,
                6061,
                [TimeSpan]'00:01:00',  # openTimeout
                [TimeSpan]'00:01:00',  # closeTimeout
                [TimeSpan]'00:01:00',  # sendTimeout (15min in VEEReporter — overkill for our use)
                [TimeSpan]'00:01:00',  # receiveTimeout
                2147483647             # maxMessageSize (int.MaxValue)
            )

            $summaries = $null
            $ok = $client.GetExportStatuses(
                [Nullable[DateTime]]$startTime,
                [Nullable[DateTime]]$endTime,
                $statuses,
                'All',  # template
                '',     # caseNumber filter (empty = no filter)
                '',     # notes filter
                '',     # userName filter
                [ref]$summaries
            )

            if (-not $ok) { throw "GetExportStatuses returned false (server reachable but query failed)" }
            if ($null -eq $summaries) { $summaries = New-Object 'System.Collections.Generic.List[ItemsAndInterfaces.DataObjects.ExportStatusSummary]' }

            $records = New-Object System.Collections.Generic.List[object]
            foreach ($s in $summaries) {
                $records.Add([ordered]@{
                    evidenceId              = [string]$s.EvidenceID
                    userName                = [string]$s.UserName
                    currentStatus           = [string]$s.CurrentStatus
                    numberAttempts          = [int]$s.NumberAttempts
                    template                = [string]$s.Template
                    plugin                  = [string]$s.Plugin
                    notes                   = [string]$s.Notes
                    name                    = [string]$s.Name
                    creationTimestampUtc    = $s.CreationTimestampUtc.ToString("yyyy-MM-ddTHH:mm:ssZ")
                    lastUpdatedTimestampUtc = $s.LastUpdatedTimestampUtc.ToString("yyyy-MM-ddTHH:mm:ssZ")
                })
            }
            Write-Log "vee_realtime: returning $($records.Count) record(s)"

            Write-Message @{
                ok        = $true
                store     = $store
                address   = $address
                fetchedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
                records   = $records.ToArray()
            }
        }
        default {
            Write-Log 'branch: vee'
            $store   = if ($req.PSObject.Properties['store']) { [string]$req.store } else { $null }
            $records = Get-VeeRecords -Store $store
            Write-Message @{ ok = $true; store = $store; fetchedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"); records = $records }
        }
    }
} catch {
    $errText = 'unknown error'
    try { $errText = [string]$_.Exception.Message } catch {}
    Write-Log "CATCH: $errText"
    # Write the error response.  A second try keeps us from crashing silently
    # if Write-Message itself fails (e.g. stdout pipe already closed).
    try {
        Write-Message @{ ok = $false; error = $errText }
        Write-Log 'CATCH: Write-Message succeeded'
    } catch {
        Write-Log "CATCH: Write-Message failed: $($_.Exception.Message)"
        # Last-resort: hand-craft the smallest valid native-message frame.
        try {
            $fb  = [System.Text.Encoding]::UTF8.GetBytes('{"ok":false,"error":"write-failed"}')
            $lb  = [BitConverter]::GetBytes([uint32]$fb.Length)
            $so  = [Console]::OpenStandardOutput()
            $so.Write($lb, 0, 4); $so.Write($fb, 0, $fb.Length); $so.Flush()
        } catch { Write-Log 'CATCH: fallback write also failed' }
    }
    exit 0
}
