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
