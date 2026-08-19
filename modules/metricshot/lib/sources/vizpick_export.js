// modules/metricshot/lib/sources/vizpick_export.js
//
// Headless replay of Tableau's "Download → Crosstab" export for VizPick,
// reverse-engineered from the real request trace (see dev notes). The viz is
// server-side rendered, so its row data never lands in the bootstrap JSON —
// the ONLY way to get real rows is the crosstab-export endpoint the Download
// button drives. We replay that same request sequence in the tab's MAIN world
// so it reuses the user's live Tableau session (cookies + session id):
//
//   1. POST commands/tabsrv/export-crosstab-to-{excel|csv}server
//        body: sheetdocId=<GUID>&sendNotifications=true&telemetryCommandId=<rnd>
//        → response JSON carries genExportFilePresModel.resultKey + fileName
//   2. GET  tempfile/sessions/<SESSION>?key=<resultKey>&keepfile=yes&attachment=yes
//        → the actual file bytes (xlsx = ZIP, or csv = text)
//
// The <SESSION> id and the vizql base path are lifted live from any captured
// request URL in the ring buffer, so we never hard-code a stale session.
//
// This module only ORCHESTRATES (chrome.scripting + storage of bytes). The
// xlsx decode lives in xlsx_min.js; the row → follow-up mapping lives in
// parse_vizpick_export.js. Single responsibility, per SOLID.

import { parseXlsx } from "./xlsx_min.js";
import { mapLocationDetails, mapDepartmentBreakout,
         mapDonutHealth, mapDepartmentGroups } from "./parse_vizpick_export.js";

// The two worksheets that back the follow-up text, with the sheetdocId GUIDs
// captured from the export dialog response. If Tableau republishes the
// workbook these GUIDs can change — _resolveSheetIds() re-derives them live
// from the dialog when possible, falling back to these known-good defaults.
const SHEETS = {
  locationDetails: {
    name: "Download Location Details",
    sheetdocId: "{DE528639-7176-4925-BBC6-CD07ECC646F1}",
  },
  departmentBreakout: {
    name: "Download Department Breakout (Current Day)",
    sheetdocId: "{95A7AC48-BC4F-432B-9590-5A424FF72939}",
  },
  // The two sheets behind the eight dashboard rings. Names are confirmed from a
  // live export (docs/vizpick-headline-data-findings.md) but their GUIDs have
  // never been captured, so these depend entirely on _resolveSheetIds()
  // succeeding. sheetdocId:null means "live-resolve or skip" — a null must
  // never be sent to the export endpoint as if it were a GUID.
  donutHealth: {
    name: "VizPick Donut Health",
    sheetdocId: null,
  },
  departmentGroups: {
    name: "Department Groups Donuts Health",
    sheetdocId: null,
  },
};

const EXPORT_CMD = {
  excel: "export-crosstab-to-excel-server",
  csv: "export-crosstab-to-csvserver",
};

/**
 * Export one or both VizPick crosstab sheets to raw rows.
 * @param {object} [opts]
 * @param {number} [opts.tabId]   VizPick tab; auto-found if omitted.
 * @param {"excel"|"csv"} [opts.format="excel"]
 * @param {string[]} [opts.which] subset of Object.keys(SHEETS); default all.
 * @returns {Promise<{ ok: boolean, sheets?: Record<string,{rows:string[][]}>,
 *                     error?: string, errorClass?: string, debug?: object }>}
 */
export async function exportVizPickSheets(opts = {}) {
  const format = opts.format === "csv" ? "csv" : "excel";
  const which = Array.isArray(opts.which) && opts.which.length ? opts.which : Object.keys(SHEETS);

  const tabId = opts.tabId ?? (await _findVizPickTabId());
  if (!tabId) return { ok: false, errorClass: "NO_TAB", error: "no VizPick tab open" };

  const ctx = await _resolveSessionContext(tabId);
  if (!ctx.ok) return { ok: false, errorClass: "NO_SESSION", error: ctx.error, debug: ctx.debug };

  // Re-derive sheetdocIds live from the export dialog if we can; fall back to
  // the captured defaults. Best-effort — a failure here just uses defaults.
  const liveIds = await _resolveSheetIds(tabId, ctx).catch(() => null);

  const sheets = {};
  const errors = [];
  for (const key of which) {
    const def = SHEETS[key];
    if (!def) { errors.push(`unknown sheet key ${key}`); continue; }
    const sheetdocId = (liveIds && liveIds[def.name]) || def.sheetdocId;
    if (!sheetdocId) {
      // Known sheet, unknown GUID, and no live resolution — skip rather than
      // POST "null" and burn a request against a host that rate-limits.
      errors.push(`${def.name}: no sheetdocId (live resolution unavailable)`);
      continue;
    }
    const one = await _exportOne(tabId, ctx, sheetdocId, format);
    if (!one.ok) { errors.push(`${key}: ${one.error}`); continue; }

    let rows = null;
    if (format === "csv") {
      rows = _parseCsv(one.text);
    } else {
      const parsed = await parseXlsx(one.bytes);
      if (!parsed.ok) { errors.push(`${key}: xlsx parse — ${parsed.reason}`); continue; }
      rows = parsed.rows;
    }
    sheets[key] = { rows, fileName: one.fileName };
  }

  const ok = Object.keys(sheets).length > 0;
  return {
    ok,
    sheets,
    error: ok ? undefined : (errors.join("; ") || "no sheets exported"),
    errorClass: ok ? undefined : "EXPORT_FAILED",
    debug: { session: ctx.sessionId, base: ctx.base, usedLiveIds: !!liveIds, errors },
  };
}

// ── High-level: export + parse into follow-up row shapes ───────────────────

/**
 * Drop-in replacement for the old scrapeVizPick(): exports both crosstab
 * sheets and maps them into the { locationDetails, departmentBreakout } shape
 * that format_message.js consumes. Same result contract so callers don't care
 * how the data was obtained.
 *
 * @param {object} [opts]  passed through to exportVizPickSheets (format, tabId)
 * @returns {Promise<{ ok:boolean, locationDetails?:object[],
 *   departmentBreakout?:object[], error?:string, errorClass?:string,
 *   debug?:object }>}
 */
export async function getVizPickFollowUpData(opts = {}) {
  const res = await exportVizPickSheets(opts);
  if (!res.ok) {
    return { ok: false, errorClass: res.errorClass || "EXPORT_FAILED", error: res.error, debug: res.debug };
  }
  const locRows   = res.sheets.locationDetails?.rows || [];
  const deptRows  = res.sheets.departmentBreakout?.rows || [];
  const donutRows = res.sheets.donutHealth?.rows || [];
  const groupRows = res.sheets.departmentGroups?.rows || [];

  const locationDetails    = mapLocationDetails(locRows);
  const departmentBreakout = mapDepartmentBreakout(deptRows);
  const { health, metrics } = mapDonutHealth(donutRows);
  const deptRings          = mapDepartmentGroups(groupRows);

  return {
    // The card can render from the donut sheets alone, so having either the
    // headline rings OR the detail sheets counts as a usable capture.
    ok: locationDetails.length > 0 || departmentBreakout.length > 0
        || metrics.length > 0 || deptRings.length > 0,
    locationDetails,
    departmentBreakout,
    health,
    metrics,
    deptRings,
    debug: {
      ...res.debug,
      locRowCount: locRows.length,
      deptRowCount: deptRows.length,
      donutRowCount: donutRows.length,
      groupRowCount: groupRows.length,
    },
  };
}

// ── Low-level: raw sheet export ────────────────────────────────────────────

async function _exportOne(tabId, ctx, sheetdocId, format) {
  const cmd = EXPORT_CMD[format];
  const cmdUrl = `${ctx.base}/sessions/${ctx.sessionId}/commands/tabsrv/${cmd}`;

  // Step 1 — POST the export command (multipart/form-data, as Tableau does).
  const cmdRes = await _runInTab(tabId, async (url, sid) => {
    const boundary = "----apaisuite" + Math.random().toString(36).slice(2);
    const parts = [
      ["sheetdocId", sid],
      ["sendNotifications", "true"],
      ["telemetryCommandId", Math.random().toString(36).slice(2) + "$apai"],
    ];
    let body = "";
    for (const [name, val] of parts) {
      body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`;
    }
    body += `--${boundary}--\r\n`;
    const r = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const text = await r.text();
    return { status: r.status, text };
  }, [cmdUrl, sheetdocId]);

  if (!cmdRes || cmdRes.status !== 200) {
    return { ok: false, error: `export command HTTP ${cmdRes?.status ?? "?"}` };
  }
  const meta = _extractExportFileMeta(cmdRes.text);
  if (!meta) return { ok: false, error: "no resultKey in export response" };

  // Step 2 — GET the temp file. xlsx is binary → return base64; csv → text.
  const fileUrl = `${ctx.base}/tempfile/sessions/${ctx.sessionId}`
    + `?key=${encodeURIComponent(meta.resultKey)}&keepfile=yes&attachment=yes`;

  const fileRes = await _runInTab(tabId, async (url, wantBinary) => {
    const r = await fetch(url, { method: "GET", credentials: "include" });
    if (!r.ok) return { status: r.status, b64: null, text: null };
    if (wantBinary) {
      const buf = new Uint8Array(await r.arrayBuffer());
      // base64-encode in chunks to avoid arg-length blowups.
      let bin = "";
      const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      }
      return { status: r.status, b64: btoa(bin), text: null };
    }
    return { status: r.status, b64: null, text: await r.text() };
  }, [fileUrl, format !== "csv"]);

  if (!fileRes || fileRes.status !== 200) {
    return { ok: false, error: `tempfile HTTP ${fileRes?.status ?? "?"}` };
  }

  if (format === "csv") {
    return { ok: true, text: fileRes.text || "", fileName: meta.fileName };
  }
  const bytes = _b64ToBytes(fileRes.b64 || "");
  return { ok: true, bytes, fileName: meta.fileName };
}

// ── Session/base resolution from the capture ring ──────────────────────────

async function _resolveSessionContext(tabId) {
  // Pull any recent vizql request URL and slice out the base + session id.
  // Two URL shapes carry a session id, and the export commands must be built
  // against the base WITHOUT any interstitial segment:
  //   command:   .../v/VizPickDetails/sessions/<SID>/commands/...
  //   bootstrap: .../v/VizPickDetails/bootstrapSession/sessions/<SID>
  // During a Preview only the bootstrap URL is in the ring, so we must accept
  // an optional segment (e.g. "bootstrapSession") between the base and
  // "/sessions/". The captured base is always up to "/v/<view>".
  const urls = await _runInTab(tabId, () => {
    const cap = window.__APAISUITE_METRICSHOT_TABLEAU_CAP;
    if (!cap) return null;
    return cap.all().map((e) => e.url).filter(Boolean).slice(-40);
  }, []);
  if (!urls || !urls.length) {
    return { ok: false, error: "capture ring empty — reload VizPick tab", debug: { urls } };
  }
  // base = scheme://host/vizql/t/<site>/w/<wb>/v/<view>
  // then optionally /<something> (e.g. bootstrapSession) then /sessions/<sid>
  const re = /^(https:\/\/[^/]+\/vizql\/t\/[^/]+\/w\/[^/]+\/v\/[^/]+)(?:\/[^/]+)?\/sessions\/([^/?]+)/;
  for (let i = urls.length - 1; i >= 0; i--) {
    const m = re.exec(urls[i]);
    if (m) return { ok: true, base: m[1], sessionId: m[2] };
  }
  return { ok: false, error: "no vizql session URL found in ring", debug: { sample: urls.slice(-5) } };
}

// Optionally re-derive sheetdocIds from a fresh export-dialog command so we
// survive workbook republishes that rotate the GUIDs.
async function _resolveSheetIds(tabId, ctx) {
  const url = `${ctx.base}/sessions/${ctx.sessionId}/commands/tabsrv/export-crosstab-server-dialog`;
  const res = await _runInTab(tabId, async (u) => {
    const boundary = "----apaisuite" + Math.random().toString(36).slice(2);
    // This endpoint rejects a body carrying only telemetryCommandId with
    // `missing: thumbnail-uris`, which is why live sheet-id resolution has
    // never actually worked here — every call silently fell back to the two
    // hard-coded GUIDs, which is why only two sheets were ever reachable.
    // Sending the field empty is the obvious reading of that error and is
    // UNVERIFIED against the live host; if it is still wrong, behaviour is
    // unchanged from today (null → fall back / skip), not worse.
    const part = (name, value) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const body = part("telemetryCommandId", `${Math.random().toString(36).slice(2)}$apai`)
      + part("thumbnail-uris", "[]")
      + `--${boundary}--\r\n`;
    const r = await fetch(u, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    return { status: r.status, text: await r.text() };
  }, [url]);
  if (!res || res.status !== 200) return null;

  const map = {};
  const re = /"thumbnailUri":\s*"[^"]*","sheetName":\s*"([^"]+)","sheetdocId":\s*"(\{[0-9A-Fa-f-]+\})"/g;
  let m;
  while ((m = re.exec(res.text)) != null) map[m[1]] = m[2];
  return Object.keys(map).length ? map : null;
}

// ── helpers ────────────────────────────────────────────────────────────────

function _extractExportFileMeta(text) {
  const key = /"resultKey":\s*"([^"]+)"/.exec(text);
  if (!key) return null;
  const name = /"fileName":\s*"([^"]+)"/.exec(text);
  return { resultKey: key[1], fileName: name ? name[1] : null };
}

function _b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Minimal RFC-4180-ish CSV parser (quotes, escaped quotes, embedded newlines).
function _parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function _runInTab(tabId, func, args) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args,
      func,
    });
    for (const r of results || []) if (r?.result !== undefined) return r.result;
    return null;
  } catch (e) {
    return { __error: String(e?.message ?? e) };
  }
}

async function _findVizPickTabId() {
  const PATTERNS = [
    "https://stores.tableau.wal-mart.com/t/OnlineGrocery/views/VizPick/*",
    "https://stores.tableau.wal-mart.com/*VizPick*",
  ];
  for (const url of PATTERNS) {
    const tabs = await chrome.tabs.query({ url });
    const usable = tabs.filter((t) => typeof t.id === "number")
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    if (usable[0]) return usable[0].id;
  }
  return null;
}
