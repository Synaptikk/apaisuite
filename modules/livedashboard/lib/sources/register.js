// modules/livedashboard/lib/sources/register.js
//
// Register Long/Short — V1.5 (automated capture from Power BI).
//
// Pipeline:
//   1. Find/open background app.powerbi.com tab on the register report.
//   2. MAIN-world content script (powerbi_register_capture.js) has already
//      monkey-patched fetch+XHR; the report's own queries get ring-buffered.
//   3. Read the latest GRID query envelope (register×date×amount pivot) +
//      OPERATOR query envelope (per-shift dimensions) via executeScript
//      MAIN-world.
//   4. If the captured store filter differs from the dashboard's current
//      store, mutate the body's `Where → Contains → Right.Literal.Value`
//      and replay in-tab from MAIN world (carries cookies + tenant token).
//   5. Decode Power BI's DSR pivot format into RegisterDiscrepancy[].
//   6. Decode the OPERATOR query into a per-(register, date) shift list,
//      and merge into discrepancies as `operators[]`.
//   7. Run the matching engine (R1 unmatched, R2 nearby-offset, R3
//      bounceback) and compute flipConfidence for each match — the user
//      cares about THEFT, so high-confidence flips are noise to hide and
//      low-confidence flips are signals to surface.

import { classifyAuthResponse, isAuthFailureStatus, reloadTabAndWait } from "../../../../shared/auth.js";

const REPORT_ID    = "65c97d6a-7ad8-498d-b752-69028d408993";
const REPORT_URL   = `https://app.powerbi.com/groups/me/reports/${REPORT_ID}/ReportSection?ctid=3cbcc3d3-094d-4006-9849-0d11d61f484d&experience=power-bi`;
const TAB_PATTERN  = `https://app.powerbi.com/*${REPORT_ID}*`;

const CAPTURE_WAIT_MS = 25_000;   // SPA queries fire within ~15s of report load
const CAPTURE_POLL_MS = 600;

// Autonomous-reauth attempts when Power BI returns 401 or a login HTML
// body — usually because the captured bearer token expired (~1h
// lifetime). A tab reload re-runs the page's auth bootstrap and
// re-captures a fresh token via the content script.
const MAX_REAUTH_ATTEMPTS = 2;

// ── Public entry point ─────────────────────────────────────────────

export async function fetchRegister(storeNbr) {
  const opened = await findOrOpenReportTab();
  if (!opened) return { ok: false, errorClass: "TAB", error: "Could not open Power BI register report tab." };
  const { tab, didOpen } = opened;

  await waitForTabLoad(tab.id, 25_000);

  // After an extension reload, an existing tab's document_start content
  // scripts didn't run on the already-loaded page — reload so the
  // declared content script re-injects via document_start.
  const installed = await isCaptureInstalled(tab.id);
  if (!installed) {
    await chrome.tabs.reload(tab.id, { bypassCache: false });
    await waitForTabLoad(tab.id, 25_000);
  }

  // Run the capture → replay → decode pipeline. Wrap in an autonomous-
  // reauth loop: AUTH responses from a stale bearer trigger a tab reload
  // that re-runs Power BI's auth bootstrap silently.
  let result = await runRegisterPipeline(tab.id, storeNbr, didOpen);
  let reauthAttempts = 0;
  while (result && !result.ok && result.errorClass === "AUTH" && reauthAttempts < MAX_REAUTH_ATTEMPTS) {
    reauthAttempts++;
    console.log(`[livedashboard register] auth-shaped response; reloading tab (autonomous reauth ${reauthAttempts}/${MAX_REAUTH_ATTEMPTS})`);
    const reloaded = await reloadTabAndWait(tab.id, {
      settleMs: 4000,
      timeoutMs: 35_000,
      waitForReady: async (tabId) => {
        const t = await chrome.tabs.get(tabId).catch(() => null);
        return !!t?.url && t.url.includes("app.powerbi.com") && t.status === "complete";
      },
    });
    if (!reloaded.ok) {
      console.log(`[livedashboard register] reauth reload failed: ${reloaded.reason}`);
      break;
    }
    result = await runRegisterPipeline(tab.id, storeNbr, false);
  }

  if (reauthAttempts > 0 && result && typeof result === "object") {
    result.reauthAttempts = reauthAttempts;
  }
  return result;
}

async function runRegisterPipeline(tabId, storeNbr, didOpen) {
  // First wait for at least one capture to land.
  const grid     = await pollForCapture(tabId, CAPTURE_WAIT_MS, CAPTURE_POLL_MS, "findGrid");
  const operator = await pollForCapture(tabId, 2_000, 400, "findOperator");

  if (!grid) {
    return {
      ok: false, errorClass: "NO_GRID",
      error: "Register grid query not captured in time. Open the report once manually so the SPA fires its queries.",
    };
  }

  // If captured store differs from requested, replay with the new filter.
  let gridResp = grid.respBody;
  let operatorResp = operator?.respBody ?? null;
  let gridStatus = 200, gridContentType = "application/json";
  const capturedStore = extractStoreFilter(grid.reqBody);
  const replay = String(storeNbr) !== String(capturedStore);
  if (replay) {
    const newGridBody = swapStoreFilter(grid.reqBody, storeNbr);
    const gridReplay = await replayInTab(tabId, grid.url, newGridBody);
    if (gridReplay.ok) {
      gridResp        = gridReplay.body;
      gridStatus      = gridReplay.status ?? 200;
      gridContentType = gridReplay.contentType || gridContentType;
    } else {
      // Classify replay failures. 401/403 or 200-with-login-HTML means the
      // captured bearer expired; signal AUTH to the outer retry loop which
      // will reload the tab and re-attempt with a fresh token.
      const replayAuth = classifyAuthResponse({
        status: gridReplay.status ?? 0,
        contentType: gridReplay.contentType || "",
        body: gridReplay.body || "",
      });
      if (isAuthFailureStatus(replayAuth)) {
        return {
          ok: false, errorClass: "AUTH", authStatus: replayAuth,
          error: `Power BI register replay returned ${replayAuth} — autonomous reauth will retry.`,
        };
      }
      return { ok: false, errorClass: "REPLAY", error: `Grid replay failed: ${gridReplay.error || gridReplay.status}` };
    }
    if (operator) {
      const newOpBody = swapStoreFilter(operator.reqBody, storeNbr);
      const opReplay = await replayInTab(tabId, operator.url, newOpBody);
      if (opReplay.ok) operatorResp = opReplay.body;
    }
  }

  // Pre-decode auth check on the grid body. A stale capture could contain
  // login HTML even on a status-200 response.
  const gridAuth = classifyAuthResponse({
    status: gridStatus,
    contentType: gridContentType,
    body: gridResp || "",
  });
  if (isAuthFailureStatus(gridAuth)) {
    return {
      ok: false, errorClass: "AUTH", authStatus: gridAuth,
      error: `Power BI register grid body classifies as ${gridAuth} — autonomous reauth will retry.`,
    };
  }

  // Decode.
  const cells = decodeGridResponse(gridResp);
  if (!cells.length) {
    return { ok: false, errorClass: "EMPTY", error: "Decoded zero cells from grid response." };
  }
  const shifts = operatorResp ? decodeOperatorResponse(operatorResp) : [];

  // Build RegisterDiscrepancy[] with operator overlay.
  const importedAt = new Date().toISOString();
  const rows = cells.map((c) => ({
    storeNbr:       String(storeNbr),
    date:           c.date,
    registerNbr:    c.registerNbr,
    amountCents:    Math.round(c.amount * 100),
    type:           c.amount < 0 ? "short" : "over",
    amountAbsCents: Math.round(Math.abs(c.amount) * 100),
    operators:      operatorsFor(c.registerNbr, c.date, shifts),
    _source: {
      module:       "livedashboard",
      capturedAt:   importedAt,
      sourceMethod: replay ? "powerbi-replay" : "powerbi-capture",
      reportId:     REPORT_ID,
    },
  }));

  // We're done with the tab. Only close if WE opened it — leave alone any
  // pre-existing Power BI tab the user might still be using.
  if (didOpen) {
    chrome.tabs.remove(tabId).catch(() => { /* may already be gone */ });
  }

  return {
    ok: true,
    discrepancies: rows,
    capturedAt:    importedAt,
    capturedStore,
    replayed:      replay,
    cellCount:     cells.length,
    shiftCount:    shifts.length,
  };
}

// ── Tab management ─────────────────────────────────────────────────

async function findOrOpenReportTab() {
  const existing = await chrome.tabs.query({ url: TAB_PATTERN });
  if (existing.length) return { tab: existing[0], didOpen: false };
  const tab = await chrome.tabs.create({ url: REPORT_URL, active: false });
  return tab ? { tab, didOpen: true } : null;
}

async function waitForTabLoad(tabId, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === "complete") return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

async function pollForCapture(tabId, timeoutMs, pollMs, findFn) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const envelope = await readCapture(tabId, findFn);
    if (envelope) return envelope;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

async function isCaptureInstalled(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      func:   () => !!window.__APAISUITE_LIVEDASHBOARD_REGISTER_CAP,
    });
    return results?.[0]?.result === true;
  } catch {
    return false;
  }
}

async function readCapture(tabId, findFn) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      args:   [findFn],
      func:   (fn) => {
        const cap = window.__APAISUITE_LIVEDASHBOARD_REGISTER_CAP;
        if (!cap) return null;
        return cap[fn] ? cap[fn]() : null;
      },
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function replayInTab(tabId, url, body) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      args:   [url, body],
      func:   async (u, b) => {
        try {
          const r = await fetch(u, {
            method:      "POST",
            credentials: "include",
            headers:     { "Content-Type": "application/json;charset=UTF-8", "Accept": "application/json" },
            body:        b,
          });
          const contentType = r.headers.get("content-type") || "";
          const text = await r.text().catch(() => "");
          if (!r.ok) return { ok: false, status: r.status, contentType, body: text || null };
          return { ok: true, status: r.status, contentType, body: text };
        } catch (e) {
          return { ok: false, status: 0, error: String(e?.message ?? e) };
        }
      },
    });
    const out = results?.[0]?.result;
    if (!out) return { ok: false };
    return out;
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── Body editing (store filter swap) ───────────────────────────────

// The grid + operator queries include a Where → Contains → Right.Literal
// with the store number in single quotes, e.g. `"Value":"'1458'"`.
// We swap it without touching the rest of the body so the Power BI service
// accepts the same DAX shape.
function extractStoreFilter(body) {
  if (typeof body !== "string") return null;
  const m = body.match(/"Property":"Store_Nbr"[^}]*?\}[^"]*?"Right":\{"Literal":\{"Value":"'(\d+)'"/);
  if (m) return m[1];
  // Fallback: any "'NNNN'" near Store_Nbr
  const alt = body.match(/Store_Nbr[\s\S]{0,200}?"Value":"'(\d+)'"/);
  return alt ? alt[1] : null;
}
function swapStoreFilter(body, newStoreNbr) {
  if (typeof body !== "string") return body;
  return body.replace(/("Property":"Store_Nbr"[\s\S]{0,400}?"Right":\{"Literal":\{"Value":")'\d+'(")/g,
    `$1'${newStoreNbr}'$2`);
}

// ── DSR decoder: grid (register × date pivot of long_short_amt) ────

export function decodeGridResponse(respBody) {
  if (!respBody) return [];
  let resp;
  try { resp = JSON.parse(respBody); } catch { return []; }
  const data = resp?.results?.[0]?.result?.data;
  const ds   = data?.dsr?.DS?.[0];
  if (!ds) return [];

  // Date axis (SH[0].DM2)
  const dateEntries = ds.SH?.[0]?.DM2 || [];
  const dates = dateEntries
    .filter((e) => e && (e.G1 != null))
    .map((e) => epochToIsoDate(e.G1));

  // Per-register axis (PH[1].DM1 — the per-register entries; PH[0].DM0 is
  // the SubtotalMember which we ignore).
  const regGroups = ds.PH?.[1]?.DM1 || ds.PH?.[0]?.DM1 || [];
  const out = [];
  for (const entry of regGroups) {
    const reg = entry.G0;
    if (reg == null) continue;
    let curIdx = -1;
    for (const x of (entry.X || [])) {
      // Schema-only entries (with `S` and no `M0`) define the measure type;
      // they don't advance the index.
      if (x.M0 === undefined) continue;
      if (x.I !== undefined) curIdx = x.I;
      else                    curIdx = curIdx + 1;
      const isoDate = dates[curIdx];
      if (!isoDate) continue;
      const raw = x.M0;
      const amount = typeof raw === "string" ? Number(raw) : raw;
      if (!Number.isFinite(amount) || amount === 0) continue;
      out.push({ registerNbr: String(reg), date: isoDate, amount });
    }
  }
  return out;
}

// ── DSR decoder: operator/shift dimensions ─────────────────────────

export function decodeOperatorResponse(respBody) {
  if (!respBody) return [];
  let resp;
  try { resp = JSON.parse(respBody); } catch { return []; }
  const data = resp?.results?.[0]?.result?.data;
  const ds   = data?.dsr?.DS?.[0];
  if (!ds) return [];

  const dm    = ds.PH?.[0]?.DM0 || [];
  if (!dm.length) return [];
  const schema = dm[0].S;
  if (!schema) return [];
  const dicts  = ds.ValueDicts || {};

  const out = [];
  let prev = new Array(schema.length).fill(null);
  for (const e of dm) {
    const c = e.C || [];
    const r = e.R ?? 0;
    const row = new Array(schema.length);
    let ci = 0;
    for (let j = 0; j < schema.length; j++) {
      if ((r >> j) & 1) row[j] = prev[j];
      else              row[j] = ci < c.length ? c[ci++] : null;
    }
    prev = row;
    // Resolve dict refs & build a named record
    const rec = {};
    for (let j = 0; j < schema.length; j++) {
      const col = schema[j];
      const v   = row[j];
      let resolved = v;
      if (col.DN && typeof v === "number") resolved = dicts[col.DN]?.[v];
      // Index columns named like qryLongShortSignOn.<name> — strip prefix
      const name = String(col.N || "").replace(/^qryLongShortSignOn\./, "");
      rec[name] = resolved;
    }
    // Schema gives us G0..G5 names; descriptor.Select maps them to entity
    // properties. We do the same mapping here based on convention:
    //   G0=Store_Nbr, G1=register_nbr, G2=action_date,
    //   G3=Sign_On_Time, G4=Sign_Off_Time, G5=Operator_Nbr
    out.push({
      storeNbr:     String(rec.G0 ?? ""),
      registerNbr:  String(rec.G1 ?? ""),
      date:         typeof rec.G2 === "number" ? epochToIsoDate(rec.G2) : String(rec.G2 ?? "").slice(0, 10),
      signOnTime:   String(rec.G3 ?? ""),
      signOffTime:  String(rec.G4 ?? ""),
      operatorNbr:  String(rec.G5 ?? ""),
    });
  }
  return out;
}

function operatorsFor(registerNbr, dateIso, shifts) {
  const list = [];
  const seen = new Set();
  for (const s of shifts) {
    if (s.registerNbr !== registerNbr) continue;
    if (s.date !== dateIso) continue;
    if (!s.operatorNbr || s.operatorNbr === "No Data") continue;
    if (seen.has(s.operatorNbr)) continue;
    seen.add(s.operatorNbr);
    list.push({
      operatorId:   s.operatorNbr,
      operatorName: null,
      sourceVisual: "powerbi-shift-query",
      signOnTime:   s.signOnTime,
      signOffTime:  s.signOffTime,
    });
  }
  return list;
}

function epochToIsoDate(ms) {
  if (typeof ms !== "number") return null;
  return new Date(ms).toISOString().slice(0, 10);
}

// ── Matching engine — theft-focused (R1, R2, R3 + flipConfidence) ──

const DEFAULTS = {
  toleranceSmallCents:      500,    // ±$5
  toleranceSmallMaxAmt:     10000,  // applies when |amount| ≤ $100
  tolerancePct:             0.05,   // ±5% above $100
  // Drawer reconciliation patterns sometimes span the better part of a
  // week (counts go out for review, get corrected days later). 7 days
  // matches the typical AP-research window. The confidence curve below
  // weights longer gaps lower so 6-day-apart loose matches still surface
  // for review, while same-day exact matches stay hidden as obvious flips.
  timeWindowDays:           7,
  // Walmart register numbering isn't position-sequential — 68 and 78 are
  // easy to swap on the keypad even though they're 10 apart. Allow any
  // register within a wide range to be considered; the flipConfidence
  // scoring then weights distant-register matches lower so the user
  // still sees same-day exact matches across wide deltas as "likely
  // flip (hidden)" rather than "unmatched (theft)".
  nearbyRegisterRangeDelta: 99,
  // Confidence band that determines display
  trustFlipAt:              0.70,   // >= this: high-confidence flip → HIDE
  suspectFlipBelow:         0.40,   // < this: low-confidence flip → SURFACE
};

export function runMatching(discrepancies, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const findings = [];

  const shortages = discrepancies.filter((d) => d.type === "short");

  for (const primary of shortages) {
    const candidates = findCandidates(primary, discrepancies, cfg);
    const r3Cands = candidates.filter((c) => c.registerNbr === primary.registerNbr && c.date !== primary.date);
    const r2Cands = candidates.filter((c) => c.registerNbr !== primary.registerNbr && registerWithinNearby(primary, c, cfg));

    if (r3Cands.length) {
      const top = r3Cands[0];
      const conf = computeFlipConfidence(primary, top, r3Cands.length, cfg, /*sameRegister*/ true);
      findings.push(buildFinding(primary, [top], "same-register-bounceback", conf, cfg));
      continue;
    }
    if (r2Cands.length) {
      const top = r2Cands[0];
      const conf = computeFlipConfidence(primary, top, r2Cands.length, cfg, /*sameRegister*/ false);
      findings.push(buildFinding(primary, [top], "nearby-register-offset", conf, cfg));
      continue;
    }
    // No match → R1 unmatched (theft-likely)
    findings.push(buildFinding(primary, [], "none", 0, cfg));
  }
  return findings;
}

function findCandidates(primary, all, cfg) {
  const out = [];
  for (const c of all) {
    if (c === primary) continue;
    if (c.storeNbr !== primary.storeNbr) continue;
    if (Math.sign(c.amountCents) === Math.sign(primary.amountCents)) continue;
    const days = daysBetween(primary.date, c.date);
    if (days == null || days > cfg.timeWindowDays) continue;
    if (!withinTolerance(primary.amountCents, c.amountCents, cfg)) continue;
    out.push({ ...c, _daysApart: days });
  }
  out.sort((a, b) => {
    if (a._daysApart !== b._daysApart) return a._daysApart - b._daysApart;
    const pn = Number(primary.registerNbr) || 0;
    return Math.abs(Number(a.registerNbr) - pn) - Math.abs(Number(b.registerNbr) - pn);
  });
  return out;
}

function registerWithinNearby(primary, c, cfg) {
  const pn = Number(primary.registerNbr), cn = Number(c.registerNbr);
  if (!Number.isFinite(pn) || !Number.isFinite(cn)) return false;
  return Math.abs(pn - cn) <= cfg.nearbyRegisterRangeDelta;
}

function withinTolerance(primaryCents, candidateCents, cfg) {
  const sum  = Math.abs(primaryCents + candidateCents);  // ~0 = perfect match
  const absP = Math.abs(primaryCents);
  if (absP <= cfg.toleranceSmallMaxAmt) return sum <= cfg.toleranceSmallCents;
  return sum <= Math.round(absP * cfg.tolerancePct);
}

function daysBetween(aIso, bIso) {
  if (!aIso || !bIso) return null;
  const a = new Date(aIso + "T00:00:00Z").getTime();
  const b = new Date(bIso + "T00:00:00Z").getTime();
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round(Math.abs(b - a) / 86_400_000);
}

// flipConfidence ∈ [0, 1]. Geometric mean of four sub-factors so any one
// weak factor pulls the confidence down. Theft is the failure mode we're
// trying to NOT miss — so we err on the side of "not a flip" when any
// dimension is suspicious.
export function computeFlipConfidence(primary, match, candidateCount, cfg, sameRegister) {
  // Time proximity — same day is the strongest signal. Curve extends to
  // 7 days because drawer-reconciliation can span a week. Combined with
  // regF and amtF in a geometric mean, so a 4-day same-register exact
  // match still scores >0.7 (hidden as flip).
  const days = match._daysApart ?? 0;
  const timeF = days === 0 ? 1.00
              : days === 1 ? 0.85
              : days === 2 ? 0.70
              : days === 3 ? 0.55
              : days === 4 ? 0.45
              : days === 5 ? 0.35
              : days === 6 ? 0.28
              :              0.22;

  // Register proximity (1 = same register or close; lower for farther).
  // Walmart register numbering isn't position-sequential, so we don't
  // tank confidence too hard for wide deltas — a same-day, exact-amount
  // match at delta=10 is still likely a typo'd swap. Confidence is the
  // geometric mean of timeF * regF * amtF * ambF, so a moderate regF
  // combined with strong timeF + amtF still clears the trustFlipAt bar.
  let regF;
  if (sameRegister) {
    regF = 1.0;
  } else {
    const delta = Math.abs(Number(match.registerNbr) - Number(primary.registerNbr)) || 0;
    if      (delta === 1)  regF = 1.0;
    else if (delta === 2)  regF = 0.9;
    else if (delta === 3)  regF = 0.8;
    else if (delta <= 10)  regF = 0.6;     // common typo distance (e.g. 68↔78)
    else if (delta <= 30)  regF = 0.45;    // farther but still plausible
    else                   regF = 0.30;    // very wide — relies on amt+time
  }

  // Amount tightness — exact match = 1.0; falls off proportionally
  const sumOff = Math.abs(primary.amountCents + match.amountCents);
  const absP   = Math.abs(primary.amountCents);
  const slack  = Math.max(500, Math.round(absP * 0.10));    // 10% or $5 whichever bigger
  const amtF   = sumOff === 0 ? 1.0 : Math.max(0.1, 1 - sumOff / slack);

  // Ambiguity — single candidate = clean; multiple = "could be coincidence"
  const ambF = candidateCount === 1 ? 1.0
             : candidateCount === 2 ? 0.75
             : candidateCount === 3 ? 0.5
             : 0.35;

  // Geometric mean
  return Math.pow(timeF * regF * amtF * ambF, 0.25);
}

function buildFinding(primary, matched, matchType, flipConfidence, cfg) {
  let severity, reason;
  let displayPriority;   // "primary" = always show; "watch" = surface; "noise" = hide by default

  if (matchType === "none") {
    severity = primary.amountAbsCents >= 10000 ? "high"
             : primary.amountAbsCents >= 2500  ? "medium"
             : "low";
    reason = `Unmatched shortage — Register ${primary.registerNbr} short ${fmtMoney(primary.amountCents)} on ${primary.date}. No offset within ${cfg.timeWindowDays} days.`;
    displayPriority = "primary";
  } else {
    const m = matched[0];
    const labelMatch = matchType === "nearby-register-offset"
      ? `Register ${m.registerNbr} over ${fmtMoney(m.amountCents)} on ${m.date}`
      : `Register ${m.registerNbr} over ${fmtMoney(m.amountCents)} on ${m.date}`;
    if (flipConfidence >= cfg.trustFlipAt) {
      // High confidence flip — likely benign
      severity = "low";
      displayPriority = "noise";
      reason = `Likely ${matchType === "same-register-bounceback" ? "drawer-count fix" : "till flip"} — short ${fmtMoney(primary.amountCents)} on reg ${primary.registerNbr} (${primary.date}) matched by ${labelMatch}. Flip confidence ${pct(flipConfidence)}.`;
    } else if (flipConfidence < cfg.suspectFlipBelow) {
      // Low confidence flip — looks like an offset but barely
      // Possible concealed loss
      severity = primary.amountAbsCents >= 10000 ? "high" : "medium";
      displayPriority = "primary";
      reason = `LOW-confidence flip (${pct(flipConfidence)}) — short ${fmtMoney(primary.amountCents)} on reg ${primary.registerNbr} (${primary.date}) loosely matched by ${labelMatch}. Verify — could be concealed loss.`;
    } else {
      // Medium confidence — surface but not as headline
      severity = "medium";
      displayPriority = "watch";
      reason = `Probable flip (${pct(flipConfidence)}) — short ${fmtMoney(primary.amountCents)} on reg ${primary.registerNbr} (${primary.date}) matched by ${labelMatch}.`;
    }
  }
  return {
    id: `${primary.storeNbr}-${primary.date}-${primary.registerNbr}`,
    storeNbr:           primary.storeNbr,
    primaryDate:        primary.date,
    primaryRegister:    primary.registerNbr,
    primaryAmountCents: primary.amountCents,
    primaryOperators:   primary.operators || [],
    matchType,
    flipConfidence,
    matchedAgainst:     matched.map((m) => ({
      date:        m.date,
      registerNbr: m.registerNbr,
      amountCents: m.amountCents,
      deltaCents:  m.amountCents + primary.amountCents,
      daysApart:   m._daysApart ?? 0,
    })),
    severity,
    displayPriority,
    reason,
    dismissed:   false,
    dismissedAt: null,
    note:        null,
  };
}

function fmtMoney(cents) {
  const sign = cents < 0 ? "-" : "+";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
function pct(n) { return `${Math.round(n * 100)}%`; }

export function rollup(findings) {
  let r1 = 0, r2 = 0, r3 = 0;
  let high = 0, medium = 0, low = 0;
  let primaryCount = 0, watchCount = 0, noiseCount = 0;
  let suspectFlipCount = 0;
  let highestUnmatchedCents = 0;
  for (const f of findings) {
    if (f.matchType === "none")                          r1++;
    else if (f.matchType === "nearby-register-offset")   r2++;
    else if (f.matchType === "same-register-bounceback") r3++;
    if (f.severity === "high")   high++;
    else if (f.severity === "medium") medium++;
    else low++;
    if (f.displayPriority === "primary") primaryCount++;
    else if (f.displayPriority === "watch") watchCount++;
    else noiseCount++;
    if (f.matchType !== "none" && f.flipConfidence < 0.4) suspectFlipCount++;
    if (f.matchType === "none") {
      const amt = Math.abs(f.primaryAmountCents);
      if (amt > highestUnmatchedCents) highestUnmatchedCents = amt;
    }
  }
  return {
    total: findings.length,
    r1, r2, r3,
    high, medium, low,
    primaryCount, watchCount, noiseCount,
    suspectFlipCount,
    highestUnmatchedCents,
  };
}
