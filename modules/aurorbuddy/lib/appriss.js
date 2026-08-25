// lib/appriss.js — APPRISS direct-JSON-API client (browser version)
// HTTP machinery → appriss_http.js | Data/name helpers → appriss_names.js
// ────────────────────────────────────────────────────────────────────────────
// Port of pipeline/appriss_api.py. Runs in the service worker so fetch()
// carries the user's live APPRISS session cookies and is exempt from CORS.
//
// Behaviour intentionally matches the Python module 1:1 so results between
// the two engines are comparable during the migration:
//   - Summary call filters by storeno = homeStore (so only cards with some
//     home-store activity are considered).
//   - Detail call OMITS storeno (APPRISS zeros out cards whose tender rows
//     live at neighbouring stores when it's passed), then we filter returned
//     rows to homeStore in JS. Matches the 2026-04-21 fix in appriss_api.py.
//   - Cards and suspects are NEVER pruned on empty-after-filter so summary
//     vs. detail disagreements stay visible.
//   - Name matcher: surname must be the last token of the APPRISS cardholder
//     name AND a first/middle token must match a candidate from the Auror
//     name.
import { postJson, SEARCH_URL, HEADERS, getSecureCongestionState } from "./appriss_http.js";
import { cell, dedupCards, dedupTransactions,
         firstNameCandidates, nameMatchesAny, surnameIsLastToken } from "./appriss_names.js";

import { APPRISS_BASE as BASE } from "../../../shared/appriss.js";
// URL formats from pipeline/appriss_scraper.py — APPRISS SPA's own viewer URLs.
// NOTE: on the new host `/video/react` bounces to a separate CCTV origin
// (web-prd-wus2-arp-cctv.azurewebsites.net/walmart-usa/video/...). That's fine —
// these are links the analyst clicks, opened as ordinary tabs, so no
// host_permission is involved.
const CCTV_BASE    = `${BASE}/video/react#/cameras?transactionId=`;
const RECEIPT_BASE = `${BASE}/platform/viewer?hidechrome=true#/store/ardm/event/`;

const SEARCH_PATH  = "/public/quick lookup/tender research/card holder name search.search";
const BUILDER_PATH = "/system/ebr/ardm/store/builder/ardm.builder";

const MAX_CARDS_PER_SUSPECT  = 10;
// Bumped 3 → 5 + delay bumped progressively to match Secure's 30s async baseline.
const DETAIL_EMPTY_RETRIES   = 5;
const DETAIL_RETRY_MS        = 6000;

const SUMMARY_FAST_EMPTY_THRESHOLD_MS = 5000;
const SUMMARY_EMPTY_RETRIES  = 2;
const SUMMARY_RETRY_MS       = 5000;

const BASE_BODY = {
  searchVirtualFilePath: SEARCH_PATH,
  builderVirtualFilePath: "",
  presentationType: "grid",
  startIndex: 0,
  sortColumn: "",
  // Secure interprets pageSize:0 as 'server default' (observed as 20
  // rows). For common surnames like HARRIS (526 rows) or SMITH, that
  // means the summary only returned the first 20 — so RICKY HARRIS
  // etc. were getting silently dropped because the target name fell
  // on page 2+ that we never fetched. Bumping to 2000 covers every
  // surname we've seen without needing real pagination logic (Secure
  // happily returns the full set in one response).
  pageSize: 2000,
  sortOrder: "none",
  disableDrill: false,
  filter: "",
  forceRun: false,
  showFullLoader: false,
  conditionsToSkip: [],
  preventRunningWhenNonRequiredParameterisedConditionsHaveMissingValues: true,
  canOfferRerun: true
};

// ─── Public entry point ─────────────────────────────────────────────────────

// concurrency = 5 matches pipeline/appriss_api.py::_API_CONCURRENCY. Bursting
// at 8 lookups in parallel (the extension's original default) put Secure's
// async backend into 'running: true' responses often enough that some cards
// returned 0 transactions after all retries — even when the summary call had
// confirmed activity. The CHANGELOG for appriss_api.py documents this.
export async function apprissLookupAll(suspects, homeStore, { concurrency = 5, onProgress, signal } = {}) {
  const total = suspects.length;
  const results = new Array(total).fill(null);
  const errors  = [];   // collected per-suspect failures, surfaced to the UI
  let completed = 0;
  let matched   = 0;
  // Latch: only fire the "Secure is congested" UI event once per scan even
  // if the sliding window keeps tripping the threshold throughout.
  let congestionAnnounced = false;

  // Prime the UI progress immediately so the user sees the total before the
  // first lookup finishes.
  onProgress?.({ phase: "start", completed: 0, total, matched: 0 });

  // Classic JS semaphore — pick N workers, each pulls the next index.
  const queue = suspects.map((s, i) => ({ i, s }));
  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);

  onProgress?.({ phase: "done", completed, total, matched, errors: errors.length });

  return {
    suspects: results.filter(r => r && r.appriss_cards?.length),
    errors
  };

  async function worker() {
    while (queue.length) {
      // Bail if a newer scan started — prevents us from continuing to
      // hammer Secure's async backend with stale work.
      if (signal?.aborted) return;
      const item = queue.shift();
      if (!item) return;
      let res;
      try {
        res = await doFullLookup(item.s, homeStore, signal);
      } catch (err) {
        // Thrown exceptions are converted into an error-shaped result so
        // the single post-assignment branch below owns the errors[] push.
        // Previously we pushed here AND in the branch, producing a
        // duplicate errors[] entry per thrown exception.
        const errMsg = String(err?.message ?? err);
        res = { ...item.s, appriss_cards: [], appriss_status: "error", appriss_error: errMsg };
      }
      if (res.appriss_status === "error") {
        errors.push({ name: res.name, error: res.appriss_error ?? "unknown" });
      }
      results[item.i] = res;
      completed++;
      const hasCards = !!res.appriss_cards?.length;
      if (hasCards) matched++;
      // When a suspect matches, include the full result so the UI can
      // append the row immediately — otherwise the analyst waits the full
      // 30-60s for all 39+ lookups to finish before seeing the first hit.
      onProgress?.({
        phase:    "tick",
        completed, total, matched,
        name:     res.name,
        status:   res.appriss_status,
        suspect:  hasCards ? res : null
      });

      // Congestion check — fire once when the sliding window of recent
      // HTTP timeouts in appriss_http.js crosses the threshold. Lets the UI
      // surface a "Secure is congested" notice without spamming.
      if (!congestionAnnounced) {
        const cs = getSecureCongestionState();
        if (cs.congested) {
          congestionAnnounced = true;
          onProgress?.({
            phase:    "congestion",
            timeouts: cs.timeouts,
            windowMs: cs.windowMs,
          });
        }
      }
    }
  }
}

// ─── Per-suspect lookup ─────────────────────────────────────────────────────

async function doFullLookup(suspect, homeStore, signal) {
  const last = suspect.last_name ?? "";
  if (!last) return { ...suspect, appriss_cards: [], appriss_status: "no_last_name" };

  // Retry-on-fast-empty loop. Manual Secure UI searches take ~30s end-to-end.
  // If our first summary call returns 0 rows in < SUMMARY_FAST_EMPTY_THRESHOLD_MS
  // that's almost always Secure's async backend accepting our request
  // without having actually computed it yet — so we re-fire after a wait.
  // Rationale in lib/appriss.js constants block. Does nothing when the
  // summary genuinely has no rows AND the response was slow (>threshold)
  // — that's a real empty, we trust it.
  let summary = await postJson(summaryBody(homeStore, last), { label: `summary ${suspect.name || last}`, signal });
  for (let i = 0; i < SUMMARY_EMPTY_RETRIES; i++) {
    if (!summary) break;            // genuine error — don't retry here (postJson already retried)
    const rows = summary.rows ?? [];
    const elapsed = summary.__elapsed_ms ?? Infinity;
    if (rows.length) break;         // got rows — stop
    if (elapsed >= SUMMARY_FAST_EMPTY_THRESHOLD_MS) break;  // slow-empty — trust it
    if (signal?.aborted) break;
    console.log(`[Secure] summary fast-empty (${elapsed}ms) for ${suspect.name || last} — retrying in ${SUMMARY_RETRY_MS}ms (${i + 1}/${SUMMARY_EMPTY_RETRIES})`);
    await new Promise(r => setTimeout(r, SUMMARY_RETRY_MS));
    summary = await postJson(summaryBody(homeStore, last), { label: `summary ${suspect.name || last} (retry)`, signal });
  }
  if (!summary) return { ...suspect, appriss_cards: [], appriss_status: "error", appriss_error: `summary call failed for ${last.toUpperCase()} (see service-worker console for details)` };

  const rawRows = summary.rows ?? [];
  // One-shot: dump the first SUMMARY row's keys on the first scan so we
  // can verify the field names are what we think they are. Helps catch
  // cases where Secure returns rows in a shape our mapper doesn't know
  // how to parse — we'd see the rows exist but cards[] come back empty.
  if (!_firstSummaryLogged && rawRows.length) {
    _firstSummaryLogged = true;
    console.log(`[Secure] summary row0 keys:`, Object.keys(rawRows[0] || {}));
    console.log(`[Secure] summary row0 sample:`, rawRows[0]);
  }
  // Diagnostic for 'missing suspects' reports. A summary call that
  // returns zero rows means Secure has nothing with this surname at
  // the home store in the searched window — useful to distinguish from
  // 'matched cards but no transactions'.
  if (rawRows.length === 0) {
    console.log(`[Secure] summary empty: ${suspect.name || last} (no cards matched by surname at store ${homeStore})`);
  }
  const parsed = rawRows.map(r => ({
    name:          cell(r, "tender_cardholdername"),
    account_hash:  cell(r, "tender_accountnumber"),
    card_masked:   cell(r, "tender_cardnumbermasked"),
    last4:         cell(r, "tender_cardnumberlast4"),
    count:         cell(r, "uniqueCountofAccountNumber") || "1"
  }));

  const candidates = firstNameCandidates(suspect);
  const cards = dedupCards(parsed.filter(r =>
    surnameIsLastToken(last, r.name) &&
    nameMatchesAny(candidates, r.name) &&
    r.last4 !== "0000"
  ));

  if (cards.length === 0) {
    // Match-reject diagnostic: if Secure returned summary rows but
    // our filter kept none, the matcher is likely too strict. Log
    // what came back vs. what we were looking for so the analyst can
    // see a concrete example of Auror→Secure name drift.
    if (parsed.length > 0) {
      console.log(
        `[Secure] match-reject: Auror suspect "${suspect.name}" → ${parsed.length} Secure row(s) all rejected. ` +
        `candidates=${JSON.stringify(candidates)} rejected_cardholders=${JSON.stringify(parsed.slice(0, 5).map(r => r.name))}`
      );
    }
    return { ...suspect, appriss_cards: [], appriss_status: "empty" };
  }

  // Fan-out detail calls across cards (same shape as appriss_api.py asyncio.gather)
  const taken = cards.slice(0, MAX_CARDS_PER_SUSPECT);
  if (signal?.aborted) return { ...suspect, appriss_cards: [], appriss_status: "cancelled" };
  await Promise.all(taken.map(async (card) => {
    card.transactions = await getTransactions(homeStore, card, suspect.name, signal);
  }));

  // Cross-card transaction dedup.
  //
  // Secure's detail endpoint returns a cardholder's entire transaction
  // set regardless of which last4 / account_hash we filter on in the
  // request body — we've now confirmed this from the SW console row-
  // shape dumps: detail rows only include 'tender_cardholdername_1',
  // NOT a per-row last4. That means when a cardholder has multiple
  // cards in Secure (Bao Long Hoang → ****1942, ****4702, ****8925),
  // each per-card detail call returns the SAME transaction set, and
  // we can't tell from the row which card actually paid.
  //
  // v0.1.27 tried to filter by a tender_last4 we hoped to pull off each
  // row — the field doesn't exist on detail rows, so the 'anyTagged'
  // fallback fired and we left the lists un-filtered. Result: the same
  // 16 txns under 3 cards. User confirmed only one card was actually
  // used per transaction.
  //
  // Fix: walk the cards in the order Secure returned them and dedup by
  // transaction_id across the whole suspect. Each txn appears under
  // exactly one card — the first one whose detail call reported it.
  // Subsequent cards that repeated the same txn just show nothing for
  // that row. Not perfect attribution (we can't know which card REALLY
  // paid), but it matches what the analyst wants: 'show the txns once,
  // not three times'.
  const seenTxnIds = new Set();
  for (const card of taken) {
    if (!card.transactions?.length) continue;
    card.transactions = card.transactions.filter(t => {
      // Prefer transaction_id; fall back to a composite if Secure ever
      // returns a row without one (should be very rare — we see them
      // consistently in the logs).
      const tid = t.transaction_id
        || `${t.store}|${t.register}|${t.trans_no}|${t.datetime}`;
      if (seenTxnIds.has(tid)) return false;
      seenTxnIds.add(tid);
      return true;
    });
  }

  return { ...suspect, appriss_cards: taken, appriss_status: "found" };
}

// Logged once per extension load so the service-worker console gets
// ONE row-shape dump regardless of how many detail/summary calls fire.
// Field-name hunting:
//   - 'which key holds the per-txn last4?' — my v0.1.27 fix assumed
//     tender_cardnumberlast4; duplicate-txn bug report suggests that
//     field's absent on the actual detail response. First run with this
//     build, paste the 'row0 keys' from the SW console so I can pick
//     the right key.
//   - summary dump lets us distinguish 'Secure returned nothing for
//     this surname' from 'Secure returned rows but our mapper produced
//     0 cards' for the 'missing suspects' bug reports.
let _firstDetailLogged  = false;
let _firstSummaryLogged = false;

async function getTransactions(homeStore, card, suspectName, signal) {
  const body = detailBody(card);
  let rawRows = [];
  let attemptsUsed = 0;
  for (let attempt = 0; attempt <= DETAIL_EMPTY_RETRIES; attempt++) {
    if (signal?.aborted) return [];
    attemptsUsed = attempt + 1;
    const data = await postJson(body, { label: `detail ${suspectName} ****${card.last4}`, signal });
    if (!data) {
      console.warn(`[Secure] detail failed: ${suspectName} ****${card.last4} attempt ${attemptsUsed}`);
      // postJson returns null on network error OR timeout. Don't bail
      // immediately — Secure is sometimes slow externally and a retry
      // after a short wait succeeds. Reuse the same DETAIL_EMPTY_RETRIES
      // budget since the root cause (Secure backend lag) is identical.
      if (signal?.aborted) return []; // scan cancelled — stop now
      if (attempt < DETAIL_EMPTY_RETRIES) {
        console.log(`[Secure] detail null-retry: ${suspectName} ****${card.last4} waiting ${DETAIL_RETRY_MS}ms (${attemptsUsed}/${DETAIL_EMPTY_RETRIES + 1})`);
        await new Promise(r => setTimeout(r, DETAIL_RETRY_MS));
        continue;
      }
      return [];
    }
    rawRows = data.rows ?? [];
    // Always log elapsed + row count per attempt so we can see on every
    // call whether it was a fast-empty (Secure's backend not ready) vs
    // slow-empty (genuinely no data). Helps pinpoint the 'retry gave up
    // even though Secure would have eventually returned data' case.
    const elapsed = data.__elapsed_ms ?? "?";
    console.log(`[Secure] detail ${suspectName} ****${card.last4} attempt ${attemptsUsed}/${DETAIL_EMPTY_RETRIES + 1} elapsed=${elapsed}ms rows=${rawRows.length}`);
    if (!_firstDetailLogged && rawRows.length) {
      _firstDetailLogged = true;
      const row0 = rawRows[0];
      console.log(`[Secure] row0 keys:`, Object.keys(row0 || {}));
      console.log(`[Secure] row0 sample:`, row0);
      // Look for anything that looks like a card/tender identifier
      const cardishKeys = Object.keys(row0 || {}).filter(k =>
        /card|tender|account|last4|number/i.test(k)
      );
      if (cardishKeys.length) {
        const cardishValues = Object.fromEntries(cardishKeys.map(k => [k, row0[k]]));
        console.log(`[Secure] row0 card-ish fields:`, cardishValues);
      }
    }
    if (rawRows.length) break;
    if (attempt < DETAIL_EMPTY_RETRIES) {
      // Still empty — Secure's async backend probably hasn't finished
      // computing for this card. Wait and re-ask.
      console.log(`[Secure] empty rows: ${suspectName} ****${card.last4} attempt ${attemptsUsed}/${DETAIL_EMPTY_RETRIES + 1}, retrying in ${DETAIL_RETRY_MS}ms`);
      await new Promise(r => setTimeout(r, DETAIL_RETRY_MS));
    }
  }
  if (!rawRows.length) {
    console.warn(`[Secure] gave up empty: ${suspectName} ****${card.last4} after ${attemptsUsed} attempts`);
  } else if (attemptsUsed > 1) {
    console.log(`[Secure] recovered: ${suspectName} ****${card.last4} got ${rawRows.length} rows on attempt ${attemptsUsed}`);
  }

  // Detail rows don't include tender_cardnumberlast4 (confirmed via
  // row0 keys dump 2026-04-22) — only tender_cardholdername_1. So we
  // can't tag each transaction with a last4 to bucket per-card. The
  // cross-card dedup in doFullLookup handles this by attributing each
  // unique transaction_id to whichever card reported it first.
  const txns = rawRows.map(r => {
    const tid = cell(r, "transactionid");
    return {
      store:          cell(r, "storeno"),
      cashier:        cell(r, "storecashierno"),
      register:       cell(r, "posno"),
      trans_no:       cell(r, "ticketno"),
      amount:         cell(r, "ticketamount"),
      datetime:       cell(r, "endtransdatetime").replace(".000", ""),
      cardholder:     cell(r, "tender_cardholdername_1"),
      transaction_id: tid,
      cctv_url:       tid ? `${CCTV_BASE}${tid}`    : null,
      receipt_url:    tid ? `${RECEIPT_BASE}${tid}` : null,
      // Flag set by the detail call, read by the UI to render a HOME badge
      // on txns that happened at the user's own store. Keeping the flag
      // instead of pre-filtering lets us surface cross-store activity for
      // cards whose detail window doesn't line up with their summary signal
      // (see SHRADER / RICKY HARRIS cases in CHANGELOG).
      at_home:        cell(r, "storeno") === String(homeStore)
    };
  });

  return dedupTransactions(txns);
}

// ─── Body builders ──────────────────────────────────────────────────────────

// ─── Auth probe (exported for background.js) ────────────────────────────────
// Hits the ACTUAL search API endpoint and checks the response Content-Type.
// The Angular SPA shell (/platform/explorer) always returns 200 HTML regardless
// of auth status, making it useless as an auth check. This endpoint only ever
// returns JSON when the session is valid — HTML means a login redirect.
export async function probeApprissApiAuth() {
  try {
    const r = await fetch(SEARCH_URL, {
      method: "POST",
      credentials: "include",
      headers: HEADERS,
      body: JSON.stringify({
        ...BASE_BODY,
        parameters: { builderPath: BUILDER_PATH, searchPath: SEARCH_PATH },
        rowData: {}
      }),
      signal: AbortSignal.timeout(12_000)
    });
    // 429 = rate-limited = authenticated. Any JSON content-type = authenticated.
    if (r.status === 429) return true;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    return ct.includes("json") || ct.includes("text/plain");
  } catch {
    return false;
  }
}

function summaryBody(homeStore, lastName) {
  return {
    ...BASE_BODY,
    parameters: {
      searchPath:  SEARCH_PATH,
      builderPath: BUILDER_PATH,
      storeno: String(homeStore),
      tender_cardholdername: lastName.toUpperCase()
    },
    rowData: {}
  };
}

function detailBody(card) {
  // NOTE: storeno intentionally omitted — see top-of-file comment + Python notes.
  return {
    ...BASE_BODY,
    parameters: {
      builderPath: BUILDER_PATH,
      searchPath:  SEARCH_PATH,
      deaggregate: "true",
      tender_cardholdername:    card.name,
      tender_accountnumber:     card.account_hash,
      tender_cardnumbermasked:  card.card_masked,
      tender_cardnumberlast4:   card.last4
    },
    rowData: { UniqueCountofAccountNumber: "1" }
  };
}

