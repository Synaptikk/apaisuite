// modules/market120/lib/sources/isa_powerbi.js
//
// Background-tab capture for Power BI ISA reports. One call visits two
// reports (ISA Detail + Backroom Adjustments) sequentially in the same
// hidden tab, since both live in the same Power BI app and reusing a tab
// avoids repeated Azure AD bootstrap overhead.
//
// KPIs extracted:
//   isa_total_adjusted_dollars   — ISA Detail Report card "Total Adjusted $"
//   isa_total_adjusted_qty       — ISA Detail Report card "Total Adjusted Qty"
//   stolen_adjusted_dollars      — Backroom Adjustments card "Stolen Adj $"

import { decodeDaxKpis } from "../parse_dax.js";

const APP_ID = "a185f4ed-8506-49a6-b135-743608a56ae6";
const CTID   = "3cbcc3d3-094d-4006-9849-0d11d61f484d";

const ISA_DETAIL = {
  id:   "isa_detail",
  reportId: "b4835e03-3718-4b95-919f-8934bc83542c",
  url:  `https://app.powerbi.com/groups/me/apps/${APP_ID}/reports/b4835e03-3718-4b95-919f-8934bc83542c/ReportSection86afef1c8628ab2fa9d0?ctid=${CTID}&experience=power-bi`,
  // Body-signature substrings we scan for. The ISA Detail's Total Adjusted
  // Qty / Total Adjusted $ KPI queries reference these entity + property
  // shapes (observed via CDP probe 2026-07-26).
  bodyMustContainAny: [
    'CountNonNull(ISA.Adj Qty)',
    'Sum(ISA.Adj Amt)',
    'Sum(ISA.adj_amt)',
    '"Entity":"ISA"',   // matches many DAX queries against ISA table
  ],
  // Measure names to extract from the DSR response. `parse_dax.js` matches
  // these against descriptor.Select[*].Name using an EXACT,
  // punctuation-preserving key. Order the real, exact names first. Confirmed
  // via CDP probe (dev/probe-isa-powerbi.mjs, 2026-07-28): the true Total
  // Adjusted $ measure is literally "ISA.Adj $" (≈-656048). Beware the decoy
  // "ISA.Adj $..." (≈-2837) and "ISA.Item $" (≈40) in the same response.
  measures: [
    "ISA.Adj $",                    // ← real Total Adjusted $ (exact)
    "CountNonNull(ISA.Adj Qty)",   // ← real Total Adjusted Qty (exact)
    "Min(ISA.Adj Date)",
    "Max(ISA.Adj Date)",
    "Sum(ISA.Adj Amt)",
    "Sum(ISA.adj_amt)",
    "Sum(ISA.Adj Retail)",
    "Sum(ISA.adj_retail)",
    "Sum(ISA.Adj Retail Amt)",
    "Total Adjusted $",
    "Total Adjusted Qty",
    "Total Adj $",
  ],
  // KPI cards arrive in SEPARATE QES responses that trickle in over time.
  // The poll must keep accumulating until every required measure is seen
  // (or timeout) — otherwise an early qty-only response ends the poll and
  // Total Adjusted $ is silently dropped. Each entry is an alias group;
  // the requirement is satisfied when ANY alias in the group is captured.
  requiredMeasures: [
    ["ISA.Adj $", "Sum(ISA.Adj Amt)", "Sum(ISA.adj_amt)", "Total Adjusted $"],
    ["CountNonNull(ISA.Adj Qty)", "Sum(ISA.Adj Qty)", "Total Adjusted Qty"],
  ],
};
const BACKROOM_ADJ = {
  id:   "backroom_adj",
  reportId: "c929bfda-c409-49f5-b2cb-732370411af3",
  url:  `https://app.powerbi.com/groups/me/apps/${APP_ID}/reports/c929bfda-c409-49f5-b2cb-732370411af3/ReportSection?ctid=${CTID}&experience=power-bi`,
  // CRITICAL: "Stolen" is NOT a measure name here — it's a DAX FILTER value.
  // Confirmed via CDP probe (dev/probe-backroom-powerbi.mjs, 2026-07-28): the
  // Stolen Adj $ card runs the SAME measure `Sum(BR Adjustments.Total Adj $)`
  // but with `WHERE 'BR Adjustments'[Adjustment Type] = 'Stolen'`. The
  // unfiltered card uses the identical descriptor, so response matching alone
  // cannot tell them apart — we MUST select by the REQUEST body's Stolen
  // filter (reqBodyMustContainAll below).
  bodyMustContainAny: [
    'Total Adj $',
    '"Entity":"BR Adjustments"',
    'Adjustment Type',
  ],
  // Only accept envelopes whose ORIGINATING QES request carried the Stolen
  // filter literal — that isolates the stolen-only aggregate from the
  // all-adjustments total (both share the Total Adj $ descriptor).
  reqBodyMustContainAll: ["'Stolen'"],
  measures: [
    "Sum(BR Adjustments.Total Adj $)",  // ← real measure; Stolen isolated via request filter
    "Total Adj $",
  ],
  requiredMeasures: [
    ["Sum(BR Adjustments.Total Adj $)", "Total Adj $"],
  ],
};

const CAPTURE_WAIT_MS = 30_000;
const CAPTURE_POLL_MS = 800;
const LOAD_TIMEOUT_MS = 30_000;

// One tab, two navigations. Reuses the same background tab for both ISA reports.
export async function fetchIsaPowerbi() {
  const opened = await openOrReuseTab(ISA_DETAIL.url);
  if (!opened) return { ok: false, errorClass: "TAB", error: "Could not open Power BI tab for ISA reports." };
  const { tab, didOpen } = opened;

  const results = { isa_detail: null, backroom_adj: null };
  const errors  = {};
  const debug   = {};

  try {
    results.isa_detail = await captureReport(tab.id, ISA_DETAIL);
  } catch (e) {
    errors.isa_detail = String(e?.message ?? e);
  }

  // Navigate the SAME tab to Backroom Adjustments Report.
  try {
    await chrome.tabs.update(tab.id, { url: BACKROOM_ADJ.url });
    await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);
    results.backroom_adj = await captureReport(tab.id, BACKROOM_ADJ);
  } catch (e) {
    errors.backroom_adj = String(e?.message ?? e);
  }

  if (didOpen) chrome.tabs.remove(tab.id).catch(() => {});

  // Merge KPI values. Missing values stay null. Real measure names observed
  // via CDP probe 2026-07-26: ISA Detail's Total-Adjusted-Qty card is
  // "CountNonNull(ISA.Adj Qty)"; Total-Adjusted-$ is "Sum(ISA.Adj Amt)" or
  // renders through "Adj $". Backroom Adjustments shows totals under
  // "Total Adj $" and per-type breakdowns under specific measure names.
  const kpis = {
    isa_total_adjusted_dollars: pickFirstNumeric(results.isa_detail?.values, [
      "ISA.Adj $", "Sum(ISA.Adj Amt)", "Sum(ISA.adj_amt)", "Sum(ISA.Adj Retail)",
      "Sum(ISA.adj_retail)", "Sum(ISA.Adj Retail Amt)", "Total Adjusted $", "Total Adj $",
    ]),
    isa_total_adjusted_qty: pickFirstNumeric(results.isa_detail?.values, [
      "CountNonNull(ISA.Adj Qty)", "Sum(ISA.Adj Qty)", "Total Adjusted Qty",
    ]),
    stolen_adjusted_dollars: pickFirstNumeric(results.backroom_adj?.values, [
      // Real measure name (Stolen isolated via the request-side filter, see
      // BACKROOM_ADJ.reqBodyMustContainAll). Legacy aliases kept as fallback.
      "Sum(BR Adjustments.Total Adj $)", "Total Adj $",
      "Stolen Adj $", "Sum(Stolen)", "Stolen_Adj_Amt",
    ]),
  };
  debug.isa_detail   = summarizeCapture(results.isa_detail);
  debug.backroom_adj = summarizeCapture(results.backroom_adj);

  const allNull = Object.values(kpis).every((v) => v === null);
  if (allNull) {
    return {
      ok: false,
      errorClass: "PARSE",
      error: "No ISA KPI values parsed from either report.",
      kpis,
      subErrors: errors,
      debug,
    };
  }

  return {
    ok: true,
    kpis,
    capturedAt: new Date().toISOString(),
    subErrors: Object.keys(errors).length ? errors : null,
    debug,
  };
}

async function captureReport(tabId, report) {
  const installed = await isCaptureInstalled(tabId);
  if (!installed) {
    await chrome.tabs.reload(tabId, { bypassCache: false });
    await waitForTabLoad(tabId, LOAD_TIMEOUT_MS);
  }

  const captured = await pollForCapture(tabId, report, CAPTURE_WAIT_MS, CAPTURE_POLL_MS);
  if (!captured || !captured.length) {
    const ringSummary = await dumpRingSummary(tabId);
    return {
      ok: false,
      reason: "no capture within timeout",
      values: null,
      respBodyPreview: null,
      ringSummary,
    };
  }

  // Power BI splits a report's KPI cards across MULTIPLE QES responses (e.g.
  // ISA Detail returns Total Adjusted $ and Total Adjusted Qty in different
  // responses that arrive at different times). pollForCapture has already
  // accumulated every matching envelope; merge their decoded values here
  // (first non-null per measure wins; aggregate cards beat grid rows).
  const mergedValues = decodeAccumulated(captured, report.measures);
  const mergedSeen = {};
  const capturedUrls = [];
  let anyOk = false;
  let lastReason = null;
  for (const env of captured) {
    const pr = decodeDaxKpis(env.respBody, report.measures);
    anyOk = anyOk || pr.ok;
    lastReason = pr.reason || lastReason;
    for (const [k, v] of Object.entries(pr.seen || {})) {
      if (!(k in mergedSeen)) mergedSeen[k] = v;
    }
    if (env.url) capturedUrls.push(env.url);
  }
  return {
    ok: anyOk,
    reason: anyOk ? undefined : lastReason,
    values: mergedValues,
    seen: mergedSeen,
    capturedUrl: capturedUrls[0] || null,
    capturedUrls,
    respBodyPreview: (captured[0].respBody || "").slice(0, 4096),
  };
}

async function dumpRingSummary(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      func:   () => {
        const cap = window.__APAISUITE_MARKET120_POWERBI_CAP;
        if (!cap) return { installed: false, url: location.href };
        const all = cap.all();
        return {
          installed: true,
          url: location.href,
          size: all.length,
          urls: all.slice(-20).map((e, i) => `[${i}] ${e.method} ${e.url} → ${e.status}`),
        };
      },
    });
    const frames = (results || []).map((r) => r?.result).filter(Boolean);
    return { frames: frames.length, installed: frames.some((f) => f.installed), byFrame: frames };
  } catch { return null; }
}

async function openOrReuseTab(url) {
  // Reuse ANY app.powerbi.com tab first — we'll navigate it to what we need.
  const existing = await chrome.tabs.query({ url: "https://app.powerbi.com/*" });
  if (existing.length) {
    const tab = existing[0];
    // Navigate it to the ISA Detail URL. If the user was viewing a different
    // report there, this would disrupt them — same tradeoff livedashboard's
    // register source makes.
    await chrome.tabs.update(tab.id, { url });
    await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);
    return { tab, didOpen: false };
  }
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab) return null;
  await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);
  return { tab, didOpen: true };
}

async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === "complete") return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

async function isCaptureInstalled(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      func:   () => !!window.__APAISUITE_MARKET120_POWERBI_CAP,
    });
    return (results || []).some((r) => r?.result === true);
  } catch { return false; }
}

async function pollForCapture(tabId, report, timeoutMs, pollMs) {
  // Accumulate matching envelopes across polls, de-duplicated. Return early
  // only once every requiredMeasures group is satisfied; otherwise keep
  // collecting until timeout so late-arriving KPI-card responses (e.g. Total
  // Adjusted $, which lands after Total Adjusted Qty) are not missed.
  const deadline = Date.now() + timeoutMs;
  const byKey = new Map();
  const required = report.requiredMeasures || [];

  const isComplete = () => {
    if (!required.length) return byKey.size > 0;
    // Decode what we have so far and check each required alias group.
    const values = decodeAccumulated([...byKey.values()], report.measures);
    return required.every((group) => group.some((m) => Number.isFinite(values[m])));
  };

  while (Date.now() < deadline) {
    const envs = await readCaptureForReport(tabId, report);
    for (const env of (envs || [])) {
      const key = `${env.requestId || ""}|${env.url || ""}|${(env.respBody || "").length}`;
      if (!byKey.has(key)) byKey.set(key, env);
    }
    if (byKey.size && isComplete()) return [...byKey.values()];
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return byKey.size ? [...byKey.values()] : null;
}

// Decode + merge a set of envelopes into { measure: value }. Shared by the
// completeness check (pollForCapture) and the final result build
// (captureReport) so both agree on what "captured" means.
function decodeAccumulated(envelopes, measures) {
  const merged = {};
  for (const env of envelopes) {
    const pr = decodeDaxKpis(env.respBody, measures);
    for (const [k, v] of Object.entries(pr.values || {})) {
      if ((merged[k] === undefined || merged[k] === null) && v !== null) merged[k] = v;
    }
  }
  return merged;
}

async function readCaptureForReport(tabId, report) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      args:   [report.bodyMustContainAny || [], report.measures || [], report.reqBodyMustContainAll || []],
      func:   (reqNeedles, respNeedles, reqMustAll) => {
        const cap = window.__APAISUITE_MARKET120_POWERBI_CAP;
        if (!cap) return null;
        // Collect ALL response envelopes whose body carries any measure
        // descriptor we care about — KPI cards are spread across responses.
        const found = cap.findAllByRespBodySubstr
          ? cap.findAllByRespBodySubstr(respNeedles)
          : [];
        // Also include the request-body match (the DAX grid query) as a
        // fallback so we never regress below the old single-hit behaviour.
        for (const n of reqNeedles) {
          const r = cap.findByReqBodySubstr(n);
          if (r && !found.includes(r)) found.push(r);
        }
        // When a report shares one descriptor across differently-FILTERED
        // queries (e.g. Backroom's Stolen card vs. the all-adjustments total,
        // both "Total Adj $"), keep only envelopes whose ORIGINATING request
        // carried every required filter literal. Otherwise the wrong (broader)
        // aggregate would win the merge.
        const filtered = reqMustAll.length
          ? found.filter((r) => {
              const body = (r && r.reqBody) || "";
              return reqMustAll.every((lit) => body.includes(lit));
            })
          : found;
        return filtered.length ? filtered : null;
      },
    });
    // Merge envelope arrays across frames, de-duplicated by requestId+url.
    const merged = [];
    const seenKeys = new Set();
    for (const r of (results || [])) {
      const arr = r?.result;
      if (!Array.isArray(arr)) continue;
      for (const env of arr) {
        const key = `${env.requestId || ""}|${env.url || ""}|${(env.respBody || "").length}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        merged.push(env);
      }
    }
    return merged.length ? merged : null;
  } catch { return null; }
}

function pickFirstNumeric(values, keys) {
  if (!values) return null;
  for (const k of keys) {
    const v = values[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function summarizeCapture(r) {
  if (!r) return null;
  return {
    ok: r.ok,
    reason: r.reason,
    valuesFound: r.values ? Object.entries(r.values).filter(([, v]) => v !== null).map(([k]) => k) : null,
    // All descriptor names the DSR decoder actually saw, matched or not.
    // When Total Adjusted $ is missing, look here for the real measure name
    // and add it to the pickFirstNumeric alias list below.
    seenDescriptors: r.seen || null,
    capturedUrl: r.capturedUrl,
  };
}
