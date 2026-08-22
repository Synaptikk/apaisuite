// modules/vizpick/lib/sources/tableau_export_replay.js
//
// Export a Tableau crosstab by replaying its two HTTP calls, instead of
// driving the Download → Crosstab dialog through the DOM.
//
// WHY
// ---
// Captured live 2026-08-21 (dev/VIZPICK_EXPORT_FINDINGS.md): the export the UI
// performs is really just
//
//   1. POST …/sessions/<sid>/commands/tabsrv/export-crosstab-to-excel-server
//      multipart body: sheetdocId, sendNotifications, telemetryCommandId
//      → { resultKey, fileName, mimeType }
//   2. GET  …/sessions/<sid>?key=<resultKey>&keepfile=yes&attachment=yes
//      → the file bytes
//
// The POST measured 200 ms on a live session. The DOM route to the same bytes
// is: hover the visual, click the per-visual More-options button, wait for the
// dialog, match the sheet thumbnail BY NAME, select a radio, click Export, poll
// for the blob — and then wait DIALOG_SETTLE_MS (20 s) for the toolbar to come
// back before the next sheet. Twice per store, ten stores per market.
//
// THE ONE THING THAT CANNOT BE DERIVED: sheetdocId
// ------------------------------------------------
// It is a workbook-scoped GUID and is not in the bootstrap payload (checked —
// the GUIDs there are zone and image ids, sitting next to "Navigation" and
// "zoom-icon 1.png"). The dialog command that would list sheets rejects the
// arguments we know how to send.
//
// So it is LEARNED, not guessed: run the DOM export once, and read the GUID
// out of the request the page itself made. content/tableau_capture.js already
// records reqBody on every patched fetch, so the multipart body carrying
// sheetdocId is already sitting in the ring — no new instrumentation. One DOM
// dialog per market instead of two per store.
//
// SAFETY
// ------
// Every failure path falls back to the DOM export. A 410 means the session
// died; the caller forgets the learned context and re-learns. Nothing here is
// allowed to make a capture fail that would otherwise have succeeded — the
// worst case is that we did some wasted work and then took the slow road.

/** Multipart body Tableau's own export command sends. Pure — testable. */
export function buildExportBody(sheetdocId, boundary, telemetryId) {
  const part = (name, value) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  return (
    part("sheetdocId", sheetdocId) +
    part("sendNotifications", "true") +
    part("telemetryCommandId", telemetryId) +
    `--${boundary}--\r\n`
  );
}

/** Pull the export result out of the command response. */
export function parseExportResponse(text) {
  const key = (String(text || "").match(/"resultKey"\s*:\s*"(\d+)"/) || [])[1] || null;
  const fileName = (String(text || "").match(/"fileName"\s*:\s*"([^"]+)"/) || [])[1] || null;
  if (!key) {
    // Tableau answers 200 with a validation error rather than an HTTP error,
    // so "no resultKey" is the real failure signal, not the status code.
    const err = (String(text || "").match(/"errorMessage"\s*:\s*"([^"]*)"/) || [])[1] || null;
    return { ok: false, reason: err ? `command rejected: ${err}` : "no resultKey in response" };
  }
  return { ok: true, resultKey: key, fileName };
}

/**
 * Learn sheet name → sheetdocId from the capture ring.
 *
 * Pairs each export command REQUEST (which carries sheetdocId) with its
 * RESPONSE (which names the file). Pure, so the pairing logic is testable
 * without a browser.
 *
 * @param {Array<{url:string, reqBody?:string, respBody?:string}>} ring
 * @returns {Object<string,string>}  lowercased fileName (no extension) → GUID
 */
export function learnSheetIds(ring) {
  const out = {};
  for (const entry of ring || []) {
    if (!String(entry?.url || "").includes("export-crosstab-to-excel-server")) continue;
    const guid = (String(entry.reqBody || "").match(/name="sheetdocId"\r?\n\r?\n(\{[^}]+\})/) || [])[1];
    const fileName = (String(entry.respBody || "").match(/"fileName"\s*:\s*"([^"]+)"/) || [])[1];
    if (!guid || !fileName) continue;
    out[normaliseSheetName(fileName)] = guid;
  }
  return out;
}

/**
 * Say what actually happened during a failed DOM export, from the ring.
 *
 * "no CSV captured" was the entire failure message, which cannot distinguish
 * between four very different situations — and the difference decides whether
 * the fix is a longer timeout, a retry, a selector change, or nothing at all
 * because the store genuinely has no rows. The ring already holds the
 * evidence; this reads it out.
 *
 * Returns a short human phrase, meant to be interpolated into the reason
 * string and read in the debug feed. Never throws: a diagnostic that can fail
 * is worse than none, because it masks the failure it was added to explain.
 */
export function summariseExportAttempt(ring, needle) {
  try {
    const entries = Array.isArray(ring) ? ring : [];
    const cmds = entries.filter((e) =>
      String(e?.url || "").includes("export-crosstab-to-excel-server"));
    const blobs = entries.filter((e) => e?.via === "blob");

    if (!cmds.length) {
      // The dialog was driven but the page never posted the command. A
      // selector/timing problem in exportDriverFn, not a slow server.
      return blobs.length
        ? `export command never sent; ${blobs.length} unrelated download(s)`
        : "export command never sent";
    }

    const bad = cmds.find((c) => Number(c.status) >= 400);
    if (bad) return `export command returned ${bad.status}`;

    if (!blobs.length) {
      // Command accepted, no file. Almost always the 45 s wait expiring on a
      // slow store rather than an error.
      return `export command sent (${cmds.length}), no file arrived`;
    }

    // A file DID arrive and simply did not contain what we were looking for.
    // Blob captures have no filename — the download name lives on the
    // synthetic <a>, not the Blob — so identify them by their HEADER ROW,
    // which is both the most diagnostic line and the only one safe to log: it
    // is column names, never anybody's data. A wrong sheet, a renamed column
    // (which has broken this crawl before) and an empty store all look
    // different here, where they were previously identical.
    const heads = blobs.slice(-2).map((b) => {
      const first = String(b.respBody || "").split(/\r?\n/)[0] || "(empty)";
      return first.length > 120 ? `${first.slice(0, 120)}…` : first;
    }).join(" | ");
    return `${blobs.length} file(s) downloaded but none contained ${JSON.stringify(needle)}; headers: ${heads}`;
  } catch {
    return "ring unreadable";
  }
}

/** "Download Department Breakout (Current Day).xlsx" → a stable lookup key. */
export function normaliseSheetName(name) {
  // Trim BEFORE stripping the extension: the `$` anchor does not match when a
  // trailing space follows ".csv", so the other order leaves the extension on
  // and the learned key silently fails to match the sheet matcher — every
  // store then pays the DOM route with nothing to show it went wrong.
  return String(name || "")
    .trim()
    .replace(/\.(xlsx|csv)$/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Read the live vizql session + workbook path from the page.
 *
 * allFrames because the portal URL renders the viz inside an iframe while the
 * ?:embed=y URL does not — tsConfig is absent from the top frame in the first
 * case. Composed from page config rather than hardcoded: the summary and
 * details views live at different paths.
 */
export async function readVizqlContext(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        const cfg = window.tsConfig;
        const sid = cfg && (cfg.sessionid || cfg.sessionId);
        if (!sid || !cfg.repositoryUrl || !cfg.site_root) return null;
        const [workbook, view] = String(cfg.repositoryUrl).split("/");
        if (!workbook || !view) return null;
        return {
          sessionId: sid,
          base: `${location.origin}/vizql${cfg.site_root}/w/${workbook}/v/${view}/sessions/${sid}`,
        };
      },
    });
    for (const r of results || []) if (r?.result) return r.result;
  } catch { /* fall through */ }
  return null;
}

/**
 * Do the export by replay. Runs IN the page so the request carries the same
 * session cookies the UI would send.
 *
 * @returns {{ok:true, base64:string, fileName:string, isZip:boolean, ms:number}
 *          |{ok:false, reason:string, status?:number, sessionDead?:boolean}}
 */
export async function replayExport(tabId, { base, sheetdocId }) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      args: [base, sheetdocId],
      func: async (baseUrl, sheetId) => {
        const t0 = performance.now();
        const bnd = "----apai" + Math.random().toString(36).slice(2);
        const part = (nm, v) =>
          "--" + bnd + '\r\nContent-Disposition: form-data; name="' + nm + '"\r\n\r\n' + v + "\r\n";
        const body =
          part("sheetdocId", sheetId) +
          part("sendNotifications", "true") +
          part("telemetryCommandId", "apai" + Date.now().toString(36)) +
          "--" + bnd + "--\r\n";

        const post = await fetch(baseUrl + "/commands/tabsrv/export-crosstab-to-excel-server", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "multipart/form-data; boundary=" + bnd },
          body,
        });
        // 410 Gone is what a dead session returns — verified live. Reported
        // distinctly so the caller re-learns instead of falling back forever.
        if (post.status === 410) return { ok: false, reason: "session gone (410)", status: 410, sessionDead: true };
        const txt = await post.text();
        const key = (txt.match(/"resultKey"\s*:\s*"(\d+)"/) || [])[1];
        const fileName = (txt.match(/"fileName"\s*:\s*"([^"]+)"/) || [])[1] || "";
        if (!key) {
          const err = (txt.match(/"errorMessage"\s*:\s*"([^"]*)"/) || [])[1];
          return { ok: false, reason: err ? "command rejected: " + err : "no resultKey", status: post.status };
        }

        // /tempfile/sessions/, NOT /sessions/ — verified live 2026-08-22; the
        // plain session path answers 404 with an HTML error body, which would
        // otherwise have been handed to the parser as if it were a sheet.
        const fileUrl = baseUrl.replace(/\/sessions\//, "/tempfile/sessions/")
          + "?key=" + key + "&keepfile=yes&attachment=yes";
        const get = await fetch(fileUrl, { credentials: "include" });
        if (!get.ok) return { ok: false, reason: "file fetch " + get.status, status: get.status };
        const buf = await get.arrayBuffer();
        if (!buf.byteLength) return { ok: false, reason: "empty file" };

        // Base64 because executeScript results must be JSON-serialisable —
        // an ArrayBuffer would arrive as {}.
        let bin = "";
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000;   // avoid blowing the argument limit on apply()
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return {
          ok: true,
          base64: btoa(bin),
          fileName,
          // PK\x03\x04 — xlsx. Otherwise treat as text (CSV/TSV).
          isZip: bytes[0] === 0x50 && bytes[1] === 0x4B,
          ms: Math.round(performance.now() - t0),
        };
      },
    });
    for (const r of results || []) if (r?.result) return r.result;
    return { ok: false, reason: "no frame answered" };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/** base64 → Uint8Array, for handing xlsx bytes to the reader. */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64 → text, for a CSV/TSV response. */
export function base64ToText(b64) {
  const bytes = base64ToBytes(b64);
  // Tableau's crosstab text is UTF-16LE with a BOM when it arrives as bytes;
  // the Blob path decoded it for us, this one has to do it itself.
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}
