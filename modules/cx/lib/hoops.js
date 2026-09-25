// modules/cx/lib/hoops.js
//
// The graded Cx numbers from the Hoops ops-portal: NPS, the eight 1-5
// sub-scores behind it, and the portal's own GenAI summary.
//
// Same transport as costinventory/lib/itr.js and livedashboard's cvp.js — the
// React portal draws every figure from tRPC procedures that answer plain
// cookie-authenticated GETs. First try is a direct fetch from the service
// worker; when the Hoops SSO cookies do not carry to the extension origin we
// replay the same GET from inside an ops-portal tab, which is the only thing
// the SAML session cookies attach to.
//
// Endpoint details and the timeType enum: dev/CX_FINDINGS.md section 1.

import { withSessionTabs, registerSessionTab } from "../../../shared/tabSessions.js";

const TRPC = "https://hoops.wal-mart.com/ops-portal/v1/trpc/";

// Direct ops-portal URL. An authenticated user lands straight on the app; an
// unauthenticated one is bounced to /soteria/login, which is why the tab
// filter below excludes that path.
const OPS_PORTAL_URL  = "https://hoops.wal-mart.com/ops-portal/";
const OPS_TAB_PATTERN = "https://hoops.wal-mart.com/ops-portal/*";
const LOGGED_OUT_RE   = /hoops\.wal-mart\.com\/(soteria|login)/i;

const BU_TYPE_STORE = 6;

/** timeType values the Cx procedures accept. NPS only populates from WEEK up. */
export const TIME_TYPE = Object.freeze({
  DAY: 100, WEEK: 202, MONTH: 302, QUARTER: 402, YEAR: 502,
});

export class HoopsError extends Error {
  constructor(message, errorClass = "HTTP") {
    super(message);
    this.name = "HoopsError";
    this.errorClass = errorClass;   // AUTH | TAB | HTTP | SHAPE
  }
}

// ── The three procedures ────────────────────────────────────────────────

/**
 * Weekly NPS, this year against last. 14 periods ending at the current one.
 *
 * `timeType` defaults to WEEK because that is the only granularity that
 * actually carries a number — DAY and the 201 variant return null for every
 * row (verified 2026-09-25), so offering "daily NPS" would draw an empty chart.
 */
export async function fetchNps(storeNbr, { timeType = TIME_TYPE.WEEK } = {}) {
  const grid = await callGrid("metric.cx.megaCard.nps", { buId: num(storeNbr), buType: BU_TYPE_STORE, timeType });
  return {
    periods: grid.rows.map((r) => ({
      key:       String(r[grid.idx.timeInt]),
      offset:    r[grid.idx.timeOffset],
      label:     r[grid.idx.timeTextShort],
      labelLong: r[grid.idx.timeTextLong],
      ty:        numOrNull(r[grid.idx.netPromotorScore_Ty454]),
      ly:        numOrNull(r[grid.idx.netPromotorScore_Ly454]),
    })),
    // pivotRows repeats the current period at every granularity, which is the
    // cheapest way to show "this week / this month / this quarter / this year"
    // without four more round-trips.
    pivots: pivotsOf(grid, { ty: "netPromotorScore_Ty454", ly: "netPromotorScore_Ly454" }),
    timeType,
  };
}

/**
 * The eight sub-scores behind NPS. Unlike NPS these DO publish daily, so the
 * caller may ask for TIME_TYPE.DAY.
 */
export const SUBSCORES = Object.freeze([
  { key: "assocInteractions",    label: "Associate interactions", scope: "store"   },
  { key: "checkoutSatisfaction", label: "Checkout satisfaction",  scope: "store"   },
  { key: "productAvailability",  label: "Product availability",   scope: "store"   },
  { key: "scoPinpad",            label: "SCO / pinpad",           scope: "store"   },
  { key: "pickupDelivery",       label: "OPD 5-star",             scope: "digital" },
  { key: "pickup",               label: "Pickup",                 scope: "digital" },
  { key: "delivery",             label: "Delivery",               scope: "digital" },
  { key: "overallSatisfaction",  label: "Overall satisfaction",   scope: "store"   },
]);

export async function fetchSubscores(storeNbr, { timeType = TIME_TYPE.WEEK } = {}) {
  const grid = await callGrid("metric.cx.megaCard.inStore", { buId: num(storeNbr), buType: BU_TYPE_STORE, timeType });

  const periods = grid.rows.map((r) => {
    const out = {
      key:       String(r[grid.idx.timeInt]),
      offset:    r[grid.idx.timeOffset],
      label:     r[grid.idx.timeTextShort],
      labelLong: r[grid.idx.timeTextLong],
      scores:    {},
    };
    for (const s of SUBSCORES) {
      out.scores[s.key] = {
        ty: numOrNull(r[grid.idx[`${s.key}_Score_Ty454`]]),
        ly: numOrNull(r[grid.idx[`${s.key}_Score_Ly454`]]),
      };
    }
    return out;
  });

  const pivotCols = {};
  for (const s of SUBSCORES) {
    pivotCols[`${s.key}_ty`] = `${s.key}_Score_Ty454`;
    pivotCols[`${s.key}_ly`] = `${s.key}_Score_Ly454`;
  }
  return { periods, pivots: pivotsOf(grid, pivotCols), timeType };
}

/**
 * The portal's own GenAI read of the store's comments.
 *
 * Returns `{ generatedAt, summary }` where summary is
 * `{ brief, positive[], negative[], suggestions[] }`.
 *
 * `generatedAt` matters more than the content: the copy served on 2026-09-25
 * was stamped 2026-01-31, so this is shown only under its own date and never
 * as the current read. That staleness is why the module computes its own
 * breakdown from Medallia.
 */
export async function fetchGenAiSummary(storeNbr) {
  const grid = await callGrid("metric.cx.genAiSummary", { buId: num(storeNbr), buType: BU_TYPE_STORE });
  const row = grid.rows[0];
  if (!row) return null;

  const b64 = row[grid.idx.summaryJsonBase64];
  const stamp = row[grid.idx.lastUpdatedTimestamp] ?? null;
  if (!b64) return null;

  let parsed;
  try {
    parsed = JSON.parse(await gunzipBase64(b64));
  } catch (e) {
    throw new HoopsError(`genAiSummary did not decode: ${e?.message ?? e}`, "SHAPE");
  }
  return {
    generatedAt: parsed?.timestampUTC ?? stamp,
    reportedAt:  stamp,
    summary:     parsed?.summary ?? null,
  };
}

/**
 * Hoops' own comment feed. FALLBACK ONLY — it is capped at 50 rows, ignores
 * timeType and trails roughly a week behind Medallia. It exists so the module
 * can still show verbatims for a user whose Medallia access is not set up.
 */
export async function fetchHoopsComments(storeNbr) {
  const grid = await callGrid("metric.cx.comments", { buId: num(storeNbr), buType: BU_TYPE_STORE });
  return grid.rows.map((r) => ({
    date:    r[grid.idx.businessDateFormatted],
    text:    r[grid.idx.commentText],
    journey: r[grid.idx.tripType],
    rating:  numOrNull(r[grid.idx.commentRating]),
  })).filter((c) => c.text);
}

// ── Transport ───────────────────────────────────────────────────────────

async function callGrid(proc, input) {
  const url = `${TRPC}${proc}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;

  // Direct first. Cheap when it works, and it does whenever the Hoops session
  // cookies are not SameSite-scoped away from the extension origin.
  const direct = await tryDirect(url);
  if (direct.ok) return toGrid(proc, direct.json);

  // Otherwise borrow a real ops-portal tab's cookies.
  const viaTab = await fetchInsideOpsPortalTab(url);
  return toGrid(proc, viaTab);
}

async function tryDirect(url) {
  try {
    const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false };
    const json = await res.json();
    // A tRPC error body still arrives with 200 in some paths.
    if (json?.error) return { ok: false };
    return { ok: true, json };
  } catch {
    return { ok: false };
  }
}

function fetchInsideOpsPortalTab(url) {
  return withSessionTabs("cx", () => fetchInsideOpsPortalTabImpl(url));
}

async function fetchInsideOpsPortalTabImpl(url) {
  let tabs = (await chrome.tabs.query({ url: OPS_TAB_PATTERN }))
    .filter((t) => !LOGGED_OUT_RE.test(t.url || ""));

  if (!tabs.length) {
    let opened;
    try {
      opened = await chrome.tabs.create({ url: OPS_PORTAL_URL, active: false });
    } catch (e) {
      throw new HoopsError(`Could not open a Hoops tab: ${e?.message ?? e}`, "TAB");
    }
    // Ours, and on the reaper's clock rather than left behind forever.
    await registerSessionTab("cx", opened.id);
    const landed = await waitForOpsPortalTab(25_000);
    if (!landed) {
      throw new HoopsError(
        "Hoops session is not active. Open hoops.wal-mart.com/ops-portal/, sign in, then refresh.",
        "AUTH",
      );
    }
    tabs = [landed];
  }

  const tabId = tabs[0].id;
  await waitForTabLoad(tabId, 15_000);

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (u) => {
        try {
          const r = await fetch(u, { credentials: "include", headers: { Accept: "application/json" } });
          if (!r.ok) return { __err: `HTTP ${r.status}` };
          return await r.json();
        } catch (e) {
          return { __err: String(e?.message ?? e) };
        }
      },
      args: [url],
    });
  } catch (e) {
    throw new HoopsError(`Could not run the fetch in the Hoops tab: ${e?.message ?? e}`, "TAB");
  }

  const out = results?.[0]?.result;
  if (!out) throw new HoopsError("The Hoops tab returned nothing.", "TAB");
  if (out.__err) throw new HoopsError(`Hoops fetch failed in-tab: ${out.__err}`, "HTTP");
  if (out.error) {
    throw new HoopsError(`Hoops rejected the query: ${out.error?.json?.message ?? "unknown"}`, "HTTP");
  }
  return out;
}

async function waitForOpsPortalTab(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(600);
    const tabs = (await chrome.tabs.query({ url: OPS_TAB_PATTERN }))
      .filter((t) => !LOGGED_OUT_RE.test(t.url || "") && t.status === "complete");
    if (tabs.length) return tabs[0];
  }
  return null;
}

async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    if (tab.status === "complete") return;
    await sleep(400);
  }
}

// ── Shaping ─────────────────────────────────────────────────────────────

// Hoops answers in "array mode": rows are positional and meta.columns is the
// only key to them, so every reader has to build the index first.
function toGrid(proc, json) {
  const payload = json?.result?.data?.json;
  const columns = payload?.meta?.columns;
  const rows    = payload?.rows;
  if (!Array.isArray(columns) || !Array.isArray(rows)) {
    throw new HoopsError(`${proc} returned no grid`, "SHAPE");
  }
  return {
    columns,
    rows,
    pivotRows: Array.isArray(payload.pivotRows) ? payload.pivotRows : [],
    idx: Object.fromEntries(columns.map((c, i) => [c, i])),
  };
}

// pivotRows shares the row shape but each row is a different granularity,
// identified by its own timeType column.
function pivotsOf(grid, colMap) {
  const byType = {};
  for (const r of grid.pivotRows) {
    const tt = r[grid.idx.timeType];
    const entry = { label: r[grid.idx.timeTextLong], key: String(r[grid.idx.timeInt]) };
    for (const [out, col] of Object.entries(colMap)) entry[out] = numOrNull(r[grid.idx[col]]);
    byType[tt] = entry;
  }
  return byType;
}

// Hoops ships the summary gzipped inside base64. DecompressionStream is
// available in MV3 service workers, so no vendored inflate is needed.
async function gunzipBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HoopsError(`store number must be numeric, got ${v}`, "SHAPE");
  return n;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
