// modules/vizpick/lib/store_stamp.js
//
// Per-store "Updated" stamps for the current-day (Today) view.
//
// WHY THE STAMP IS PER STORE
// --------------------------
// VizPickDetails shows ONE store at a time, chosen by its Store parameter, and
// the "Updated <timestamp>" it prints is for that store. Stores publish their
// current-day numbers on their own clocks, so one store's stamp says nothing
// about its neighbours'. Until 2026-09-15 the market crawl read the stamp once
// — on the primary tab, before any Store parameter was set — compared it to
// the stored snapshot, and skipped the whole market when it matched. A store
// that HAD republished was skipped whenever the default store had not, and
// every row was filed under that one stamp.
//
// Now every requested store is visited, its own stamp is read once the viz is
// showing it, and only a store whose stamp moved (or whose stored row is
// incomplete or too old) pays for the exports. Everything here is pure so the
// decision can be pinned by tests; the tab driving lives in
// sources/vizpick_today_tableau.js.

import { isTodayRowComplete } from "./today_coverage.js";

/**
 * Same Tableau instant? Compared on the normalised iso when both sides have
 * one — the stamp can come from the dashboard text or the Last-update sheet,
 * which render the same instant differently ("2026-08-22 07:04:54" vs
 * "8/22/2026 7:04:54 AM") — else on the raw string.
 */
export function stampsMatch(a, b) {
  if (!a || !b) return false;
  if (a.iso && b.iso) return a.iso === b.iso;
  return !!a.raw && a.raw === b.raw;
}

/**
 * Does this store need its exports re-run?
 *
 * @param {object} p
 * @param {{raw?:string,iso?:string,capturedAt?:string}|null} p.known  What the
 *   snapshot holds for this store: its stamp and when its row was exported.
 * @param {{raw?:string,iso?:string}|null} p.read  The stamp just read off the
 *   dashboard with the Store parameter set to this store.
 * @param {number} p.maxAgeMs  Past this age the row is re-read whatever the
 *   stamp says (the stamp has been seen stale from a reused session).
 * @param {boolean} [p.force]
 * @param {number} [p.now]
 * @returns {{skip:boolean, reason:string}}  skip = the stored row stands.
 */
export function decideStoreExports({ known, read, maxAgeMs, force = false, now = Date.now() }) {
  if (force) return { skip: false, reason: "forced" };
  if (!known) return { skip: false, reason: "no stored row" };
  if (!read) return { skip: false, reason: "stamp unreadable" };
  if (!stampsMatch(known, read)) return { skip: false, reason: "stamp moved" };
  const at = known.capturedAt ? new Date(known.capturedAt).getTime() : NaN;
  const age = Number.isFinite(at) ? now - at : Infinity;
  if (!(age <= maxAgeMs)) return { skip: false, reason: "stored row too old" };
  return { skip: true, reason: "unchanged" };
}

/** A row's own stamp, else the snapshot's (rows written before per-store stamps). */
export function rowSourceUpdate(row, today) {
  return row?.sourceUpdate?.raw ? row.sourceUpdate : (today?.sourceUpdate ?? null);
}

/**
 * The stamps the crawl should check against: one per COMPLETE row of the
 * snapshot, when the snapshot is for this market. An incomplete row is left
 * out so it is re-read; another market's snapshot yields nothing, so every
 * store is read and the caller replaces the snapshot.
 *
 * @returns {Record<string, {raw:string|null, iso:string|null, capturedAt:string|null}>}
 */
export function knownStoreStamps(today, market) {
  const out = {};
  if (!today?.rows?.length) return out;
  if (market != null && today.market != null && String(today.market) !== String(market)) return out;
  for (const r of today.rows) {
    if (!isTodayRowComplete(r)) continue;
    const su = rowSourceUpdate(r, today);
    if (!su?.raw) continue;
    out[String(r.store)] = {
      raw: su.raw ?? null,
      iso: su.iso ?? null,
      capturedAt: r.capturedAt ?? today.capturedAt ?? null,
    };
  }
  return out;
}

/**
 * Newest and oldest per-store stamps across a snapshot's rows, for the
 * header: it can only honestly show one time if every store shares it.
 *
 * @returns {{newest:object|null, oldest:object|null, differ:boolean, stamped:number}}
 */
export function stampSpread(rows) {
  let newest = null, oldest = null, stamped = 0;
  for (const r of rows || []) {
    const su = r?.sourceUpdate;
    if (!su?.iso) continue;
    stamped++;
    if (!newest || su.iso > newest.iso) newest = su;
    if (!oldest || su.iso < oldest.iso) oldest = su;
  }
  return { newest, oldest, differ: !!newest && !!oldest && newest.iso !== oldest.iso, stamped };
}
