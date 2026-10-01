// modules/digitalmetrics/lib/sources/daily_board_source.js
//
// Fetch the store's Daily Board workbook from OneDrive/SharePoint. Runs in the
// service worker. Transport only — board_sync.js decides what it means.
//
// No tab: the SharePoint REST API and download.aspx both answer a plain
// credentialed fetch once the browser holds a SharePoint session (FedAuth
// cookie), which any visit to OneDrive leaves behind. Verified 2026-09-23
// against my.wal-mart.com. Without a session SharePoint redirects to
// login.microsoftonline.com, which is detected rather than parsed as a file.

import { parseXlsxAllSheets } from "../../vendor/xlsx_min.js";

const TIMEOUT_MS = 60_000;

const SIGN_IN = "not signed in to OneDrive — open the Daily Board link once in this browser, then sync again";
const REFRESH_MS = 45_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is this the "no SharePoint session" failure (the one a visit can fix)? */
export function isSignInError(e) {
  return String(e?.message ?? e) === SIGN_IN;
}

/**
 * Renew the SharePoint session by visiting the site in a background tab.
 *
 * The FedAuth cookie the plain fetch rides on expires after a while, and
 * when it does every 30-minute sync fails with SIGN_IN until someone happens
 * to open OneDrive — which is how store 1458's board went unsynced from
 * 09-24 to 09-27. A navigation bounces through login.microsoftonline.com,
 * where corporate SSO completes without a prompt and lands back on the
 * site with a fresh cookie; measured 2026-09-27, well under 10 s. The tab
 * opens on the file's metadata endpoint (JSON), NOT download.aspx, which
 * would drop the workbook into the user's Downloads.
 *
 * Resolves true once the tab is back on the site's host, false when the
 * sign-in needs a person (the tab stays on the login page) — the caller
 * then reports SIGN_IN as before. Always closes its tab.
 */
export async function refreshSession({ site, uniqueId }, { timeoutMs = REFRESH_MS } = {}) {
  const host = new URL(site).host;
  const url = `${site}/_api/web/GetFileById('${uniqueId}')?$select=Name`;
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1000);
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t) return false;
      let landed = null;
      try { landed = new URL(t.url || t.pendingUrl || "").host; } catch { /* about:blank */ }
      if (t.status === "complete" && landed === host) return true;
    }
    return false;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function get(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: "include", headers, signal: ctl.signal });
    if (new URL(res.url).host !== new URL(url).host) throw new Error(SIGN_IN);
    if (res.status === 401 || res.status === 403) throw new Error(SIGN_IN);
    if (res.status === 404) throw new Error("the Daily Board file was not found — has it been moved, or the link changed?");
    if (!res.ok) throw new Error(`OneDrive answered HTTP ${res.status}`);
    return res;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("OneDrive did not answer within 60 s");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{site: string, uniqueId: string}} source  parseShareLink() output
 * @returns {{ name, modifiedAt, sheets }}
 */
export async function fetchDailyBoard({ site, uniqueId }) {
  const meta = await get(
    `${site}/_api/web/GetFileById('${uniqueId}')?$select=Name,TimeLastModified`,
    { accept: "application/json;odata=nometadata" });
  if (!/json/.test(meta.headers.get("content-type") || "")) throw new Error(SIGN_IN);
  const info = await meta.json();

  const file = await get(`${site}/_layouts/15/download.aspx?UniqueId=${uniqueId}`);
  if (/text\/html/.test(file.headers.get("content-type") || "")) throw new Error(SIGN_IN);

  const parsed = await parseXlsxAllSheets(new Uint8Array(await file.arrayBuffer()));
  if (!parsed.ok) throw new Error(`the Daily Board could not be read: ${parsed.reason}`);

  return { name: info.Name, modifiedAt: info.TimeLastModified, sheets: parsed.sheets };
}
