// Read VEE data via the native-messaging companion installed by
// extension/native_host/"Do this first - Double-click me.cmd". The host now
// calls the per-store Enhanced Export Reporter WCF service directly (the
// same service VEEReporter.exe uses), instead of scraping local log files.
//
// Why: the log-scrape path only saw exports done on THIS machine, and only
// after the log buffer flushed. The WCF service knows store-wide status in
// real time, including who uploaded and when. Per the disassembly:
//   CommunicationChannels.Client.EnhancedExportReporterServiceInstance
//     bool GetExportStatuses(DateTime?, DateTime?, List<TransferStatus>,
//                            string template, string caseNumber, string notes,
//                            string userName, out List<ExportStatusSummary>)
// returning ExportStatusSummary { EvidenceID, UserName, CurrentStatus,
// LastUpdatedTimestampUtc, NumberAttempts, Template, … }.
//
// Local cache:
//   We persist every VEE record we've ever seen in chrome.storage.local,
//   keyed by evidenceId. Each Load only queries the server for a narrow
//   recent window (overlap with the last sync); the result is merged into
//   the cache (newest LastUpdatedTimestampUtc wins per ref), then the
//   dashboard sees the union of cached + fresh records. This way an
//   export done a year ago for a still-open claim stays known forever
//   without us paying the cost of a full 2-year query every Load.
//
// Setup (one-time): the user double-clicks the bundled "Do this first…"
// .cmd, which wraps setup.ps1 with -ExecutionPolicy Bypass so it runs
// regardless of the machine's PowerShell policy. setup.ps1 drops a 32-bit
// PowerShell host + the bundled Verint client DLLs into
// %LOCALAPPDATA%\ClaimsBuddy\NativeHost\ and adds HKCU registry entries
// for Chrome and Edge.
//
// Stable extension ID is locked by the `key` field in manifest.json
// (gfjcbckbahifacpeoecjnfnloaaejmcc) — that's the ID the setup script
// writes into the host's allowed_origins.

const HOST_NAME        = "com.shanesmith.claimsbuddy_vee";
const CACHE_KEY        = "vee_cache";
const COLD_START_DAYS  = 1825;  // 5 years on first sync of a store
const OVERLAP_DAYS     = 14;    // re-query last 2 weeks each Load to catch status updates

export async function fetchVeeReport(store) {
  const cache = await loadCache();
  const storeKey = store.padded5;

  // The Verint Enhanced Export Reporter WCF service is reachable only on
  // the user's home store network (vsrv01.s{home}.us.wal-mart.com resolves
  // / routes only from inside that store). For any other store the TCP
  // connect just times out. So once we've successfully reached one store,
  // lock it as the home and skip the WCF call for everything else — we
  // still hand back the cached records so cross-references work if any
  // happen to match.
  if (cache.homeStore && cache.homeStore !== storeKey) {
    console.log(`[ClaimsBuddy] VEE store ${storeKey}: skipping (home store is ${cache.homeStore}, not reachable from here)`);
    return {
      store:        storeKey,
      offHomeStore: true,
      homeStore:    cache.homeStore,
      fetchedAt:    cache.syncByStore[cache.homeStore] ?? null,
      records:      Object.values(cache.recordsById),
    };
  }

  const lastSyncForStore = cache.syncByStore[storeKey];
  const endTime = new Date();
  const startTime = lastSyncForStore
    ? new Date(new Date(lastSyncForStore).getTime() - OVERLAP_DAYS * 86_400_000)
    : new Date(endTime.getTime() - COLD_START_DAYS * 86_400_000);

  const mode = lastSyncForStore ? "incremental" : "cold-start";
  console.log(`[ClaimsBuddy] VEE store ${storeKey} (${mode}): querying ${startTime.toISOString()}..${endTime.toISOString()} (cache has ${Object.keys(cache.recordsById).length} record(s))`);

  let resp;
  try {
    resp = await chrome.runtime.sendNativeMessage(HOST_NAME, {
      action:    "vee_realtime",
      store:     storeKey,
      startTime: startTime.toISOString(),
      endTime:   endTime.toISOString(),
    });
  } catch (err) {
    // Common chrome.runtime.lastError messages:
    //   - "Specified native messaging host not found." → setup wasn't run, or
    //     registry entry was removed.
    //   - "Access to the specified native messaging host is forbidden."
    //     → registry entry exists but allowed_origins doesn't include THIS
    //     extension's ID. Happens when the donor's setup.ps1 was run (only
    //     lists donor ID) but the call came from the suite (different ID).
    //   - "Native host has exited." → .ps1 errored before writing a response.
    //     %TEMP%\ClaimsBuddy_debug.log has details.
    const msg = err?.message || String(err);
    if (/not found/i.test(msg)) {
      throw new Error('VEE host not installed — double-click "Do this first…" in modules/claimsbuddy/native_host (under the extension folder).');
    }
    if (/forbidden/i.test(msg)) {
      throw new Error('VEE host registered for a different extension ID — re-run modules/claimsbuddy/native_host/"Do this first - Double-click me.cmd" to add APAISuite to allowed_origins.');
    }
    throw new Error(`VEE host: ${msg}`);
  }

  if (!resp)              throw new Error("VEE host returned no response.");
  if (resp.ok === false)  throw new Error(`VEE host: ${resp.error || "unknown error"}`);

  const fresh = resp.records || [];
  const { added, updated } = mergeIntoCache(cache, fresh);
  cache.syncByStore[storeKey] = endTime.toISOString();
  if (!cache.homeStore) cache.homeStore = storeKey;  // first store that answered is "home"
  await saveCache(cache);
  console.log(`[ClaimsBuddy] VEE store ${storeKey}: ${fresh.length} fresh, ${added} new, ${updated} updated; cache now ${Object.keys(cache.recordsById).length}`);

  return {
    store:     resp.store     || store.short,
    address:   resp.address,
    fetchedAt: cache.syncByStore[storeKey],
    records:   Object.values(cache.recordsById),
  };
}

async function loadCache() {
  const { [CACHE_KEY]: c } = await chrome.storage.local.get(CACHE_KEY);
  if (!c || !c.recordsById) return { recordsById: {}, syncByStore: {} };
  // Migrate legacy global-lastSync caches by dropping that field — next
  // fetch per store is then treated as cold-start so we re-pull history
  // with the wider window. Cached records are preserved.
  return {
    recordsById: c.recordsById,
    syncByStore: c.syncByStore || {},
  };
}

async function saveCache(cache) {
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

// Merge fresh records into the cache. A record replaces the cached one if
// its LastUpdatedTimestampUtc is newer (catches status transitions like
// Initialized → Successful). Returns counts for diagnostic logging.
function mergeIntoCache(cache, fresh) {
  let added = 0, updated = 0;
  for (const r of fresh) {
    const id = String(r.evidenceId || "").trim();
    if (!id) continue;
    const existing = cache.recordsById[id];
    if (!existing) {
      cache.recordsById[id] = r;
      added++;
    } else {
      const a = String(existing.lastUpdatedTimestampUtc || "");
      const b = String(r.lastUpdatedTimestampUtc || "");
      if (b.localeCompare(a) > 0) {
        cache.recordsById[id] = r;
        updated++;
      }
    }
  }
  return { added, updated };
}
