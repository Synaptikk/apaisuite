// lib/db.js — DataFile bridge.
//
// Talks to the native host (vee_host.ps1) to pull adjuster roster and
// per-store claim records out of DataFile.xlsb.
//
// Fetch responsibility lives in the extension, not the host: teams.wal-mart.com
// uses Azure AD / modern auth, which PowerShell's -UseDefaultCredentials can't
// satisfy. The extension is already authenticated to SharePoint in the user's
// Chrome session, so we download the xlsb with credentials:"include", base64-
// encode it, and pass it to the host as `xlsbData`. The host decodes, parses
// via Excel COM, and returns rows.
//
// Adjuster roster is cached in chrome.storage.local; claims are pulled
// fresh per Load.
//
// Actions handled by the host:
//   sync_users  → reads the "User Data" sheet from the supplied xlsbData
//   get_claims  → reads the "Claim" sheet from the supplied xlsbData, filtered by store
//
// Join key:  CAS referenceNbr  ↔  DataFile "Reference Nbr"
// Adjuster:  DataFile "Adjuster" (userId)  ↔  User Data "Userid"

const HOST          = "com.shanesmith.claimsbuddy_vee";
const KEY_USERS     = "db_users";
const KEY_META      = "db_meta";
const DATAFILE_URL  = "https://teams.wal-mart.com/sites/AlignmentID/Shared%20Documents/DataFile.xlsb";

// ─── DataFile fetch (extension-side) ───────────────────────────────────────

async function fetchDataFileBase64() {
  let res;
  try {
    res = await fetch(DATAFILE_URL, { credentials: "include" });
  } catch (err) {
    throw new Error(`DataFile network error: ${err?.message || err}`);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`DataFile HTTP ${res.status} — sign in to teams.wal-mart.com in another tab, then reload.`);
    }
    throw new Error(`DataFile HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  // Sanity: xlsb is a ZIP, first 2 bytes are "PK". Catches the common case
  // where SharePoint returns an HTML login page instead of the file.
  if (buf.byteLength < 4) throw new Error("DataFile empty response");
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0x50 || head[1] !== 0x4B) {
    throw new Error("DataFile fetch returned non-xlsb (probably an SSO redirect — sign in to teams.wal-mart.com and reload).");
  }
  return arrayBufferToBase64(buf);
}

function arrayBufferToBase64(buf) {
  // Chunked to avoid call-stack overflow on large files (apply() arg limit).
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ─── Native host calls ──────────────────────────────────────────────────────

async function nativeCall(msg) {
  let resp;
  try {
    resp = await chrome.runtime.sendNativeMessage(HOST, msg);
  } catch (err) {
    const m = err?.message || String(err);
    if (/not found/i.test(m)) {
      throw new Error('Native host not installed — run "Do this first" in native_host/.');
    }
    throw new Error(`Native host: ${m}`);
  }
  if (!resp?.ok) throw new Error(resp?.error || "Native host returned no response.");
  return resp;
}

// ─── User roster ────────────────────────────────────────────────────────────

/** Pull the User Data sheet from DataFile.xlsb and cache it locally. */
export async function syncUsers() {
  const xlsbData = await fetchDataFileBase64();
  const resp = await nativeCall({ action: "sync_users", xlsbData });
  const meta = {
    lastSync:  resp.fetchedAt,
    userCount: Object.keys(resp.users ?? {}).length,
  };
  await chrome.storage.local.set({ [KEY_USERS]: resp.users, [KEY_META]: meta });
  return meta;
}

/** Look up a single adjuster by their Walmart user ID (e.g. "B0U00C5"). */
export async function getUser(userId) {
  if (!userId) return null;
  const { [KEY_USERS]: users } = await chrome.storage.local.get(KEY_USERS);
  return users?.[userId] ?? null;
}

/** Return { lastSync, userCount } or null if never synced. */
export async function getDbMeta() {
  const { [KEY_META]: meta } = await chrome.storage.local.get(KEY_META);
  return meta ?? null;
}

/** True if user data is already cached (doesn't re-fetch). */
export async function hasUsers() {
  const { [KEY_USERS]: u } = await chrome.storage.local.get(KEY_USERS);
  return !!u && Object.keys(u).length > 0;
}

// ─── Claim lookup ───────────────────────────────────────────────────────────

/**
 * Fetch claims for a store from DataFile.xlsb (not cached — always fresh).
 * Returns an array of claim objects keyed by "Reference Nbr".
 * Also returns a Map<referenceNbr, claim> for O(1) joins with CAS data.
 */
export async function getClaimsForStore(storeNbr) {
  const xlsbData = await fetchDataFileBase64();
  const resp = await nativeCall({ action: "get_claims", store: String(storeNbr), xlsbData });
  const claims = resp.claims ?? [];
  const byRef  = new Map(
    claims.map((c) => [String(c["Reference Nbr"] ?? "").trim(), c])
  );
  return { claims, byRef };
}

// ─── Enrichment ─────────────────────────────────────────────────────────────

/**
 * Given a CAS row and the byRef Map from getClaimsForStore(), return a merged
 * object with adjuster details resolved from the cached user roster.
 *
 * @returns {{ dbClaim, adjuster }} — either may be null if no match found.
 */
export async function enrichCasRow(casRow, byRef) {
  const dbClaim  = byRef.get(String(casRow.referenceNbr ?? "").trim()) ?? null;
  const adjuster = dbClaim ? await getUser(dbClaim["Adjuster"]) : null;
  return { dbClaim, adjuster };
}
