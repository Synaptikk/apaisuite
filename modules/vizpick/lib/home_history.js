// modules/vizpick/lib/home_history.js
//
// Intraday history of the user's HOME store: one entry per distinct Tableau
// update, every bin with its pick counts, so the day can be replayed.
//
// WHY THIS EXISTS
// ---------------
// The Today snapshot is replaced on every capture, and Location Details is a
// current-state table (each bin carries only its LAST scan). So two questions
// could not be answered from anything stored:
//
//   · Do suggested picks keep appearing after the 9am baseline? Tableau's
//     Metric Definitions changed recently; the stocking team that pulls picks
//     leaves at 2-3pm and the list visibly keeps growing after they are gone.
//   · Are the digital associates the Associates view blames actually leaving
//     picks behind, or did they merely scan a bin LAST, after the work that
//     should have pulled it had gone home? Attribution is last-scanner (see
//     parse_vizpick_stores_csv.js::parseLocationDetails), so a late scan
//     inherits whatever is outstanding.
//
// Keeping each update answers both: diffEntries() shows picks added and picks
// completed between updates, per bin, with the scanner and scan time as they
// stood at that moment.
//
// Storage: chrome.storage.local["vizpick.homeHistory.v1"]
//   { v: 1, days: { "YYYY-MM-DD": [entry, ...oldest first] } }
//   entry = { capturedAt, lastConfirmedAt, sourceKey, sourceIso, store,
//             totals: { seen, done, open, locations, binsOpen }, fp, bins }
//   bin   = { location, seen, done, win, lastSeenAt }
//
// Size: ~230 bins × ~70 bytes ≈ 16 KB per update; a dozen updates a day for
// MAX_DAYS days is a few MB, inside the suite's unlimitedStorage.
//
// Only home-store rows carry `locations.bins` (the capture asks for them only
// there), so recordFromRows() can be handed any batch of Today rows.

export const KEY = "vizpick.homeHistory.v1";
export const MAX_DAYS = 14;

/** Local YYYY-MM-DD. */
export function localDayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Order-independent identity of a bin list. Same data → same fingerprint. */
export function fingerprint(bins) {
  return [...(bins || [])]
    .map((b) => `${b.location}|${b.seen}|${b.done}|${b.win ?? ""}|${b.lastSeenAt ?? ""}|${b.seenToday ?? ""}|${b.casesExpected ?? ""}|${b.casesSeen ?? ""}`)
    .sort()
    .join("\n");
}

export function totalsOf(bins) {
  let seen = 0, done = 0, binsOpen = 0;
  for (const b of bins || []) {
    seen += b.seen || 0;
    done += b.done || 0;
    if ((b.seen || 0) > (b.done || 0)) binsOpen++;
  }
  return { seen, done, open: Math.max(0, seen - done), locations: (bins || []).length, binsOpen };
}

/**
 * Build a history entry from a Today row, or null when the row has no bins
 * (not the home store, or its location export failed).
 */
export function entryFromRow(row, { sourceUpdate, capturedAt }) {
  const bins = row?.locations?.bins;
  if (!Array.isArray(bins) || !bins.length) return null;
  const at = row.capturedAt || capturedAt || new Date().toISOString();
  // The row's OWN stamp first: stores publish on their own clocks, and the
  // crawl-level stamp is whichever store the primary tab was showing. It is
  // only the fallback for rows captured before per-store stamps existed.
  const stamp = row.sourceUpdate?.raw ? row.sourceUpdate : sourceUpdate;
  const numOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const clean = bins.map((b) => ({
    location: b.location,
    seen: Number(b.seen) || 0,
    done: Number(b.done) || 0,
    win: b.win || null,
    lastSeenAt: b.lastSeenAt || null,
    seenToday: typeof b.seenToday === "boolean" ? b.seenToday : null,
    casesExpected: numOrNull(b.casesExpected),
    casesSeen: numOrNull(b.casesSeen),
  }));
  // The store's department breakout at the same moment — lets the day be read
  // per department as well as per bin (a bin's leading segment is a bin GROUP,
  // not a department; see parseLocationDetails).
  const depts = Array.isArray(row.depts)
    ? row.depts.map((d) => ({
        dept: String(d.dept),
        suggested: Number(d.suggestedPicks) || 0,
        done: Number(d.suggestedPicksCompleted) || 0,
        casesSeen: Number(d.casesSeen) || 0,
        casesExpected: Number(d.casesExpected) || 0,
      }))
    : null;
  return {
    capturedAt: at,
    lastConfirmedAt: at,
    sourceKey: stamp?.raw ?? null,
    sourceIso: stamp?.iso ?? null,
    // "crawl" = a stand-in stamp (see isStandInStamp); anything else is how the
    // store's own stamp was read. addEntry only trusts the latter.
    stampVia: row.sourceUpdate?.raw ? (row.stampVia || "row") : (stamp?.raw ? "crawl" : null),
    store: String(row.store),
    totals: totalsOf(clean),
    fp: fingerprint(clean),
    bins: clean,
    depts,
  };
}

/**
 * Pure: fold one entry into a history object. An entry identical to the
 * newest one for that store and day only advances `lastConfirmedAt` — the
 * crawl re-writes the same row several times per run, and a re-capture of an
 * unchanged upstream is not a new update.
 *
 * Two things count as "the same update":
 *   1. the same Tableau stamp (sourceIso, else sourceKey). Tableau's Metric
 *      Definitions: the current-day data changes only when its "Updated"
 *      stamp does, so a re-crawl at an unchanged stamp is the same data even
 *      if a row differs in some detail — the tool must never show two
 *      timestamps of one update and diff them (analyst's rule, 2026-09-14);
 *   2. identical data (fingerprint) at a stamp we cannot read, or a stamp that
 *      moved while the numbers did not.
 * Either only advances `lastConfirmedAt`.
 *
 * (Before 2026-09-14 this was keyed on the data alone, because the stamp had
 * once been seen to stay put while the numbers moved — CURRENT_TASKS §10.
 * That observation came from a reused Tableau tab; the crawl opens its own
 * tab now.)
 */
export function addEntry(history, entry, { maxDays = MAX_DAYS } = {}) {
  const h = { v: 1, days: { ...(history?.days || {}) } };
  if (!entry) return { history: h, added: false };
  const day = localDayKey(entry.capturedAt);
  if (!day) return { history: h, added: false };

  const list = [...(h.days[day] || [])];
  const last = [...list].reverse().find((e) => e.store === entry.store);
  let added = false;
  let revised = null;
  const stampOf = (e) => e?.sourceIso || e?.sourceKey || null;
  const sameStamp = !!last && !!stampOf(last) && stampOf(last) === stampOf(entry);
  const kept = last ? list.lastIndexOf(last) : -1;
  // The same-stamp rule only holds for a stamp that was the store's OWN. An
  // entry kept before per-store stamps carries the crawl-level stamp, which is
  // whichever store the primary tab showed: on 2026-09-15 that filed 1458's
  // 2:03 PM data under 3:03 PM, and the real 3:03 PM update then folded into
  // it as "the same stamp" and was never kept.
  const ownStamp = !isStandInStamp(entry);
  const standInLast = !!last && isStandInStamp(last);
  if (last && sameStamp && last.fp !== entry.fp && standInLast && ownStamp) {
    // The store's own stamp reads the kept instant with different data, so the
    // kept label was not this store's. Keep both and flag the old one.
    if (!isSameStoreAsHistory(h, entry, day, last)) {
      return { history: h, added: false, day, rejected: { store: entry.store, capturedAt: entry.capturedAt, locations: entry.totals?.locations ?? null } };
    }
    list[kept] = { ...last, stampUnverified: true };
    list.push(entry);
    list.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
    added = true;
    revised = "unverified";
  } else if (last && (sameStamp || last.fp === entry.fp)) {
    // Identical data under the store's own EARLIER stamp: the kept label ran
    // ahead of this store's clock. Move it back, so the real later update is
    // not folded into it.
    const relabel = !sameStamp && standInLast && ownStamp
      && !!stampOf(entry) && !!stampOf(last) && stampOf(entry) < stampOf(last)
      && !list.some((e) => e !== last && e.store === entry.store && stampOf(e) === stampOf(entry));
    if (relabel) {
      list[kept] = {
        ...last, lastConfirmedAt: entry.capturedAt,
        sourceKey: entry.sourceKey, sourceIso: entry.sourceIso, stampVia: entry.stampVia,
        relabeledFrom: last.sourceKey ?? last.sourceIso ?? null,
      };
      revised = "relabeled";
    } else {
      list[kept] = {
        ...last, lastConfirmedAt: entry.capturedAt, sourceKey: last.sourceKey ?? entry.sourceKey,
        // Same instant, same data, now read under the store's own stamp: the label is right.
        ...(sameStamp && last.fp === entry.fp && standInLast && ownStamp ? { stampVia: entry.stampVia } : {}),
      };
    }
  } else if (!isSameStoreAsHistory(h, entry, day, last)) {
    // Wrong-store guard: a store's bins are physical locations, so its
    // location list barely moves between updates (149 bins every update on
    // 2026-09-14, 143-149 the next morning). A capture whose bins share less
    // than half of that list is another store's export filed under this one
    // — three of the four 2026-09-14 afternoon entries for 1458 were exactly
    // that (224- and 247-bin lists from Market 120 neighbours), and the
    // progression view diffed them against each other. Refused outright; the
    // capture side (vizpick_today_tableau.js, guard 0) is the real fix, this
    // keeps a slipped one out of the day's record.
    return { history: h, added: false, day, rejected: { store: entry.store, capturedAt: entry.capturedAt, locations: entry.totals?.locations ?? null } };
  } else {
    list.push(entry);
    list.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
    added = true;
  }
  h.days[day] = list;

  const keep = Object.keys(h.days).sort().reverse().slice(0, maxDays);
  for (const k of Object.keys(h.days)) if (!keep.includes(k)) delete h.days[k];
  return revised ? { history: h, added, day, revised } : { history: h, added, day };
}

/**
 * Was this entry's stamp a stand-in rather than the store's own? True for the
 * crawl-level fallback and for entries kept before `stampVia` was recorded.
 */
export function isStandInStamp(entry) {
  return !entry?.stampVia || entry.stampVia === "crawl";
}

/** Bins shared between two entries, over the bins either has (Jaccard). */
export function locationOverlap(aBins, bBins) {
  const a = new Set((aBins || []).map((b) => String(b.location)));
  const b = new Set((bBins || []).map((x) => String(x.location)));
  if (!a.size && !b.size) return 1;
  let both = 0;
  for (const l of a) if (b.has(l)) both++;
  return both / (a.size + b.size - both);
}

// Below this share of common bins an entry is treated as another store's.
// Genuine drift is a few bins appearing or vanishing over a day; a different
// store shares a handful of generic codes (001/002, 002/001) and nothing else
// (0.2-0.25 on the 2026-09-14 wrong-store entries).
export const MIN_LOCATION_OVERLAP = 0.5;

// How many of the store's newest entries (across days) a new entry may match.
const ANCHOR_ENTRIES = 3;

/**
 * Does this entry's bin list look like the store it claims to be? Matching
 * ANY of the store's newest few entries, today's or earlier days', is enough
 * — so a wrong-store entry that slipped in before this guard existed (the
 * 2026-09-14 afternoon, where three of four were wrong) cannot make the next
 * correct one look wrong, while a wrong one still has to coincide with a
 * recent entry of that same wrong store to get through. No history at all
 * for the store: nothing to compare with, accepted.
 */
export function isSameStoreAsHistory(history, entry, day, lastToday) {
  const anchors = [];
  const days = Object.keys(history?.days || {}).filter((d) => d <= day).sort().reverse();
  for (const d of days) {
    const own = (history.days[d] || []).filter((x) => x.store === entry.store && x !== entry).reverse();
    for (const e of own) { if (anchors.length < ANCHOR_ENTRIES) anchors.push(e); }
    if (anchors.length >= ANCHOR_ENTRIES) break;
  }
  if (lastToday && !anchors.includes(lastToday)) anchors.unshift(lastToday);
  if (!anchors.length) return true;
  return anchors.some((a) => locationOverlap(a.bins, entry.bins) >= MIN_LOCATION_OVERLAP);
}

/**
 * What changed between two updates, per bin.
 *
 * `added`     — suggested picks that appeared (seen went up, or a new bin).
 * `completed` — picks marked done since the previous update.
 * `removed`   — picks that dropped out without being completed (seen went
 *               down), which would mean the list is being trimmed, not worked.
 * Each changed bin carries its scanner and scan time as of `next`.
 */
export function diffEntries(prev, next) {
  const before = new Map((prev?.bins || []).map((b) => [b.location, b]));
  const bins = [];
  let added = 0, completed = 0, removed = 0, firstSeenBins = 0, picksOnFirstSeen = 0;
  for (const b of next?.bins || []) {
    const p = before.get(b.location);
    const dSeen = b.seen - (p?.seen || 0);
    const dDone = b.done - (p?.done || 0);
    const rescanned = !!p && (p.lastSeenAt || null) !== (b.lastSeenAt || null);
    // FIRST scan of the day: not scanned today at the previous update, scanned
    // now. The case the analyst suspects — picks appearing at the moment an
    // associate is first to scan a bin, and landing on that associate.
    // Only when both updates judged "scanned today" the same way: an entry kept
    // before the export's Seen Today flag was stored falls back to the scan
    // date, and comparing the two bases reported a placeholder bin (999/999,
    // no timestamp, flagged Yes) as a first scan on the 2026-09-14 live run.
    const sameBasis = !p || (p.seenToday == null) === (b.seenToday == null);
    const firstSeen = sameBasis && !(p && isScannedToday(p, prev)) && isScannedToday(b, next);
    const dCasesSeen = b.casesSeen != null && p?.casesSeen != null ? b.casesSeen - p.casesSeen : null;
    if (dSeen > 0) added += dSeen;
    if (dSeen < 0) removed += -dSeen;
    if (dDone > 0) completed += dDone;
    if (firstSeen) { firstSeenBins++; if (dSeen > 0) picksOnFirstSeen += dSeen; }
    if (dSeen || dDone || rescanned || firstSeen) {
      bins.push({
        location: b.location, seen: b.seen, done: b.done,
        dSeen, dDone, rescanned, isNew: !p, firstSeen, dCasesSeen,
        win: b.win, lastSeenAt: b.lastSeenAt,
        prevWin: p?.win ?? null,
      });
    }
    before.delete(b.location);
  }
  // Bins that vanished from the export entirely.
  for (const p of before.values()) {
    if (p.seen) removed += p.seen;
    bins.push({ location: p.location, seen: 0, done: 0, dSeen: -p.seen, dDone: 0, rescanned: false, gone: true, win: p.win, lastSeenAt: p.lastSeenAt, prevWin: p.win });
  }
  bins.sort((a, b) => Math.abs(b.dSeen) + b.dDone - (Math.abs(a.dSeen) + a.dDone) || a.location.localeCompare(b.location));
  return { added, completed, removed, firstSeenBins, picksOnFirstSeen, bins };
}

/**
 * Was this bin scanned on the day this entry describes? The export's own
 * "Seen Today" flag when captured; otherwise the last scan's calendar day.
 */
export function isScannedToday(bin, entry) {
  if (bin?.seenToday === true) return true;
  if (bin?.seenToday === false) return false;
  if (!bin?.lastSeenAt) return false;
  const a = localDayKey(bin.lastSeenAt);
  const b = localDayKey(entry?.sourceIso || entry?.capturedAt);
  return !!a && a === b;
}

/** Bins not scanned yet on this entry's day, with their bin group. */
export function unseenBins(entry) {
  return (entry?.bins || [])
    .filter((b) => !isScannedToday(b, entry))
    .map((b) => ({ ...b, group: String(b.location).split("/")[0] }))
    .sort((a, b) => b.seen - a.seen || String(a.location).localeCompare(String(b.location)));
}

/**
 * Every first scan of the day caught between two kept updates, oldest first.
 * Only visible when an earlier update saw the bin unscanned — so the first
 * full day of captures (from 5 AM) is the one that shows them all.
 */
export function firstSeenEvents(entries) {
  const out = [];
  for (const { entry, diff } of timeline(entries)) {
    if (!diff) continue;
    for (const b of diff.bins) {
      if (!b.firstSeen) continue;
      out.push({
        dataTime: entry.sourceIso || entry.capturedAt,
        location: b.location, dSeen: b.dSeen, seen: b.seen, done: b.done,
        dCasesSeen: b.dCasesSeen, win: b.win, lastSeenAt: b.lastSeenAt,
      });
    }
  }
  return out;
}

/**
 * Department breakout, `prev` against `next`. The "first" values are null
 * when `prev` carried no breakout (entries kept before depts were stored).
 */
export function diffDepts(prev, next) {
  const have = Array.isArray(prev?.depts) && prev.depts.length > 0;
  const before = new Map((prev?.depts || []).map((d) => [d.dept, d]));
  return (next?.depts || []).map((d) => {
    const p = before.get(d.dept) || null;
    const base = (k) => (have ? (p?.[k] ?? 0) : null);
    return {
      dept: d.dept,
      suggested: d.suggested, done: d.done, casesSeen: d.casesSeen, casesExpected: d.casesExpected,
      suggestedFirst: base("suggested"), doneFirst: base("done"), casesSeenFirst: base("casesSeen"),
      dSuggested: have ? d.suggested - (p?.suggested ?? 0) : null,
      dDone: have ? d.done - (p?.done ?? 0) : null,
      dCasesSeen: have ? d.casesSeen - (p?.casesSeen ?? 0) : null,
    };
  });
}

/** One row per update for a day, with deltas against the previous update. */
export function timeline(entries) {
  const out = [];
  let prev = null;
  for (const e of entries || []) {
    const d = prev ? diffEntries(prev, e) : null;
    out.push({ entry: e, diff: d });
    prev = e;
  }
  return out;
}

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Long-format CSV: one line per bin per update, so a spreadsheet pivot can
 * chart any bin or scanner over the day.
 *
 * `person(win)` → { name, job, shiftStart, shiftEnd } fills the associate
 * columns (see matchPerson). `names(win)` → name is the older, name-only form.
 */
export function toCsv(entries, { names, person } = {}) {
  const head = ["capture_time", "tableau_update", "store", "location", "picks_seen", "picks_done", "open",
    "seen_change", "done_change", "last_scanner_win", "last_scanner_name", "last_scanner_job",
    "last_scanner_shift_start", "last_scanner_shift_end", "last_scan_time",
    "scanned_today", "cases_expected", "cases_seen", "first_scan_today"];
  const lines = [head.join(",")];
  let prev = null;
  for (const e of entries || []) {
    const before = new Map((prev?.bins || []).map((b) => [b.location, b]));
    for (const b of e.bins) {
      const p = before.get(b.location);
      const who = b.win && typeof person === "function" ? (person(b.win) || {}) : {};
      const name = who.name ?? (b.win && typeof names === "function" ? names(b.win) : null);
      lines.push([
        e.capturedAt, e.sourceKey, e.store, b.location, b.seen, b.done, Math.max(0, b.seen - b.done),
        prev ? b.seen - (p?.seen || 0) : "", prev ? b.done - (p?.done || 0) : "",
        b.win, name, who.job, who.shiftStart, who.shiftEnd, b.lastSeenAt,
        isScannedToday(b, e) ? "yes" : "no", b.casesExpected, b.casesSeen,
        prev && (!p || (p.seenToday == null) === (b.seenToday == null))
          ? (!(p && isScannedToday(p, prev)) && isScannedToday(b, e) ? "yes" : "") : "",
      ].map(csvCell).join(","));
    }
    prev = e;
  }
  return lines.join("\r\n");
}

/**
 * Index a Digital Metrics schedule doc (get_schedule: { associates: [{ name,
 * jobName, shiftStart, shiftEnd }] }) for name matching.
 *
 * The directory's names come from Workvivo and the scheduler's from WFM, so
 * both sides go through the caller's `canonical` (digitalmetrics/lib/names.js)
 * rather than a second normaliser here. A first+last fallback catches middle
 * names and suffixes; a first+last shared by two scheduled people is dropped
 * from the fallback, because guessing between them would put the wrong job on
 * someone.
 */
export function indexSchedule(doc, canonical) {
  const exact = new Map(), firstLast = new Map(), dup = new Set();
  for (const a of doc?.associates || []) {
    if (!a?.name) continue;
    const rec = { job: a.jobName || null, shiftStart: a.shiftStart || null, shiftEnd: a.shiftEnd || null, scheduledName: a.name };
    const c = canonical(a.name);
    if (!c) continue;
    // Someone on two shifts keeps the first; the job is the same either way.
    if (!exact.has(c)) exact.set(c, rec);
    const fl = firstLastKey(c);
    if (fl) { if (firstLast.has(fl) && firstLast.get(fl) !== rec) dup.add(fl); else firstLast.set(fl, rec); }
  }
  for (const fl of dup) firstLast.delete(fl);
  return { exact, firstLast, size: exact.size };
}

function firstLastKey(c) {
  const parts = String(c).split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1]}` : null;
}

/** Scheduled job + shift for a directory name, or null when not on the schedule. */
export function matchPerson(index, name, canonical) {
  if (!index || !name) return null;
  const c = canonical(name);
  if (!c) return null;
  return index.exact.get(c) || index.firstLast.get(firstLastKey(c)) || null;
}

// ── scan ledger and business case ──────────────────────────────────────────
//
// The analyst's case to the VizPick report owner (2026-09-16): a digital
// associate scanning with the exception filter still adds suggested picks to
// the bins they scan, and those picks then count as open under their name.
// On 2026-09-15 a digital rescan added picks as often as a Stocking 1 rescan
// (51% vs 50%), bins nobody rescanned almost never gained any (0.7%), and in
// the 8:02 PM update every new scan in the backroom was one digital associate's
// and every one of those bins gained picks.
//
// Only a bin's LAST scan survives in each update, so a scan row carries the
// counts of the first update that showed it, and a second scanner inside the
// same update window is invisible. The windows where a single group did all
// the scanning are what rule that out.

/**
 * Every bin's day, oldest first: its state at the first update ("start"),
 * each new scan ("scan") and each count change with no new scan ("noscan").
 */
export function scanLedger(entries) {
  const list = entries || [];
  const maps = list.map((e) => new Map((e.bins || []).map((b) => [b.location, b])));
  const locations = new Set();
  for (const m of maps) for (const loc of m.keys()) locations.add(loc);
  const out = [];
  for (const location of [...locations].sort()) {
    const rows = [];
    let prev = null, prevEntry = null, hadPicks = false;
    list.forEach((e, i) => {
      const b = maps[i].get(location);
      if (!b) return;
      if (b.seen > 0 || b.done > 0) hadPicks = true;
      const at = e.sourceIso || e.capturedAt;
      if (!prev) {
        rows.push({ kind: "start", at, scanAt: b.lastSeenAt || null, win: b.win || null, due: b.seen, done: b.done, scannedToday: isScannedToday(b, e) });
      } else if ((prev.lastSeenAt || null) !== (b.lastSeenAt || null)) {
        rows.push({
          kind: "scan", at, scanAt: b.lastSeenAt || null, win: b.win || null, prevWin: prev.win || null,
          due: b.seen, done: b.done, dDue: b.seen - prev.seen, dDone: b.done - prev.done,
          carriedOpen: Math.max(0, prev.seen - prev.done), firstToday: !isScannedToday(prev, prevEntry),
        });
      } else if (b.seen !== prev.seen || b.done !== prev.done) {
        rows.push({ kind: "noscan", at, win: b.win || null, due: b.seen, done: b.done, dDue: b.seen - prev.seen, dDone: b.done - prev.done });
      }
      prev = b; prevEntry = e;
    });
    if (!prev) continue;
    out.push({
      location, hadPicks, due: prev.seen, done: prev.done, open: Math.max(0, prev.seen - prev.done), win: prev.win || null,
      scans: rows.filter((r) => r.kind === "scan").length,
      handedOver: rows.some((r) => r.kind === "scan" && r.prevWin && r.win && r.prevWin !== r.win && r.carriedOpen > 0),
      rows,
    });
  }
  return out;
}

/**
 * Do scans by each group add picks? `groupOf(win)` names a scanner's group
 * (e.g. "Digital", "Stocking 1"). Compares, per update transition:
 *   · rescans of bins already scanned that day, by group — picks went up how often
 *   · first scans of the day, by group
 *   · bins nobody rescanned — the baseline
 * and lists `windows`: updates where every new scan was by one group.
 */
export function scanImpact(entries, groupOf) {
  const list = entries || [];
  const nameOf = (win) => (win ? (groupOf(win) || "Unknown") : "Unknown");
  const groups = new Map();
  const bump = (group) => {
    let r = groups.get(group);
    if (!r) groups.set(group, r = { group, scans: 0, picksAdded: 0, rescans: 0, rescansGained: 0, rescanPicks: 0, firstScans: 0, firstScanPicks: 0, openAtClose: 0, binsOpenAtClose: 0 });
    return r;
  };
  const idle = { bins: 0, gained: 0, picks: 0 };
  const windows = [];
  // Each bin is compared with its OWN previous appearance, exactly as
  // scanLedger reads it, so an update missing a bin (a partial or foreign
  // capture) cannot break the chain and make these totals disagree with the
  // ledger (2026-09-16: 26 vs 78 picks on a merged day).
  const lastSeen = new Map();
  for (const x of list[0]?.bins || []) lastSeen.set(x.location, { bin: x, entry: list[0] });
  for (let i = 1; i < list.length; i++) {
    const b = list[i];
    const scans = [];
    let idleChanged = 0;
    let prevAt = null;
    for (const x of b.bins || []) {
      const prior = lastSeen.get(x.location);
      lastSeen.set(x.location, { bin: x, entry: b });
      if (!prior) continue;
      const p = prior.bin, a = prior.entry;
      if (!prevAt || String(a.sourceIso || a.capturedAt) > String(prevAt)) prevAt = a.sourceIso || a.capturedAt;
      const dDue = x.seen - p.seen;
      if ((p.lastSeenAt || null) === (x.lastSeenAt || null)) {
        idle.bins++;
        if (dDue > 0) { idle.gained++; idle.picks += dDue; }
        if (dDue || x.done !== p.done) idleChanged++;
        continue;
      }
      const group = nameOf(x.win);
      const r = bump(group);
      const added = Math.max(0, dDue);
      r.scans++; r.picksAdded += added;
      if (isScannedToday(p, a)) {
        r.rescans++;
        if (dDue > 0) { r.rescansGained++; r.rescanPicks += added; }
      } else {
        r.firstScans++; r.firstScanPicks += added;
      }
      scans.push({ location: x.location, win: x.win || null, prevWin: p.win || null, group, scanAt: x.lastSeenAt || null, dDue, dDone: x.done - p.done, due: x.seen, done: x.done });
    }
    if (scans.length && new Set(scans.map((s) => s.group)).size === 1) {
      windows.push({
        at: b.sourceIso || b.capturedAt, prevAt: prevAt || list[i - 1].sourceIso || list[i - 1].capturedAt, group: scans[0].group, scans,
        picksAdded: scans.reduce((n, s) => n + Math.max(0, s.dDue), 0),
        binsGained: scans.filter((s) => s.dDue > 0).length,
        otherBinsChanged: idleChanged,
      });
    }
  }
  const last = list[list.length - 1];
  for (const x of last?.bins || []) {
    const open = x.seen - x.done;
    if (open > 0 && x.win) { const r = bump(nameOf(x.win)); r.openAtClose += open; r.binsOpenAtClose++; }
  }
  const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  for (const r of groups.values()) r.rescanRate = rate(r.rescansGained, r.rescans);
  return {
    groups: [...groups.values()].sort((a, b) => b.scans - a.scans || a.group.localeCompare(b.group)),
    idle: { ...idle, rate: rate(idle.gained, idle.bins) },
    windows,
  };
}

/**
 * A day's updates made fit for the business case, oldest Tableau data first:
 *   · `foreign` — updates whose bins are not the store's (under half shared
 *     with the day's most typical bin list), e.g. wrong-store captures kept
 *     before the 2026-09-15 guards or merged in from another install;
 *   · `duplicates` — extra captures of the same Tableau update (same store and
 *     stamp); the most recently confirmed one is kept. Entries flagged
 *     `stampUnverified` are never folded, since their stamp is not trusted.
 * Order is by Tableau data time, not capture time: a merged day interleaves
 * captures made by two installs at different moments.
 */
export function cleanDay(entries) {
  const list = [...(entries || [])];
  if (list.length < 2) return { entries: list, foreign: [], duplicates: 0 };
  let ref = list[0], bestScore = -1;
  for (const e of list) {
    let score = 0;
    for (const o of list) if (o !== e) score += locationOverlap(e.bins, o.bins);
    if (score > bestScore) { bestScore = score; ref = e; }
  }
  const foreign = list.filter((e) => e !== ref && locationOverlap(e.bins, ref.bins) < MIN_LOCATION_OVERLAP);
  const byStamp = new Map();
  let duplicates = 0;
  for (const e of list) {
    if (foreign.includes(e)) continue;
    const stamp = e.sourceIso || e.sourceKey;
    const key = stamp && !e.stampUnverified ? `${e.store}|${stamp}` : `${e.store}|unfolded|${byStamp.size}`;
    const kept = byStamp.get(key);
    if (!kept) { byStamp.set(key, e); continue; }
    duplicates++;
    if (String(e.lastConfirmedAt || e.capturedAt) > String(kept.lastConfirmedAt || kept.capturedAt)) byStamp.set(key, e);
  }
  const time = (e) => { const t = Date.parse(e.sourceIso || e.capturedAt); return Number.isFinite(t) ? t : 0; };
  const out = [...byStamp.values()].sort((a, b) => time(a) - time(b) || String(a.capturedAt).localeCompare(String(b.capturedAt)));
  return { entries: out, foreign, duplicates };
}

/** CSV of scanLedger(): one line per bin event, for the report owner. */
export function ledgerCsv(ledger, { person } = {}) {
  const head = ["bin", "event", "tableau_update", "scan_time", "scanner_win", "scanner_name", "scanner_job",
    "previous_scanner_win", "previous_scanner_name", "picks_done", "picks_due", "due_change", "done_change", "open_carried_over", "first_scan_today"];
  const lines = [head.join(",")];
  const who = (win) => (win && typeof person === "function" ? (person(win) || {}) : {});
  for (const bin of ledger || []) {
    for (const r of bin.rows) {
      const p = who(r.win), q = who(r.prevWin);
      lines.push([
        bin.location, r.kind, r.at, r.scanAt ?? "", r.win ?? "", p.name ?? "", p.job ?? "",
        r.prevWin ?? "", q.name ?? "", r.done, r.due, r.dDue ?? "", r.dDone ?? "",
        r.kind === "scan" ? r.carriedOpen : "", r.kind === "scan" ? (r.firstToday ? "yes" : "no") : "",
      ].map(csvCell).join(","));
    }
  }
  return lines.join("\r\n");
}

// ── storage (service worker + view page) ───────────────────────────────────

let queue = Promise.resolve();

export async function read() {
  const got = await chrome.storage.local.get(KEY);
  const h = got[KEY];
  return h && h.v === 1 ? h : { v: 1, days: {} };
}

/**
 * Pure: drop every entry for `reference.store` whose bins are not that
 * store's, judged against a capture known to be right. Entries recorded
 * before the wrong-store guards existed (2026-09-14 afternoon: three of four
 * for 1458 were neighbours' bin lists) are removed; genuine ones stay.
 */
export function repairAgainst(history, reference) {
  const h = { v: 1, days: {} };
  const removed = [];
  for (const [day, list] of Object.entries(history?.days || {})) {
    const keep = [];
    for (const e of list || []) {
      const foreign = e.store === String(reference.store)
        && locationOverlap(e.bins, reference.bins) < MIN_LOCATION_OVERLAP;
      if (foreign) removed.push({ day, capturedAt: e.capturedAt, sourceKey: e.sourceKey ?? null, locations: e.totals?.locations ?? null });
      else keep.push(e);
    }
    if (keep.length) h.days[day] = keep;
  }
  return { history: h, removed };
}

// Set once the stored history has been checked against a guarded capture.
export const REPAIR_FLAG = "vizpick.homeHistory.repaired.v1";

/**
 * Repair the stored history against a capture made under the wrong-store
 * guards. Runs once per install unless `force`; the reference is the home
 * store's fresh entry ({ store, bins }). Never throws.
 */
export function repairOnce(reference, { force = false } = {}) {
  const run = async () => {
    try {
      if (!reference?.store || !Array.isArray(reference.bins) || !reference.bins.length) return { ran: false };
      const flag = (await chrome.storage.local.get(REPAIR_FLAG))[REPAIR_FLAG];
      if (flag && !force) return { ran: false };
      const h = await read();
      const { history, removed } = repairAgainst(h, reference);
      await chrome.storage.local.set({ [KEY]: history, [REPAIR_FLAG]: new Date().toISOString() });
      return { ran: true, removed };
    } catch (e) {
      return { ran: false, error: String(e?.message ?? e) };
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/**
 * Record every home-store row in a batch of Today rows. Never throws: history
 * is a side record and must not fail the capture that feeds it.
 */
export function recordFromRows(rows, meta) {
  const run = async () => {
    try {
      const entries = (rows || []).map((r) => entryFromRow(r, meta)).filter(Boolean);
      if (!entries.length) return { added: 0 };
      let h = await read();
      let added = 0;
      const rejected = [];
      const revised = [];
      for (const e of entries) {
        const res = addEntry(h, e);
        h = res.history;
        if (res.added) added++;
        if (res.rejected) rejected.push(res.rejected);
        if (res.revised) revised.push(res.revised);
      }
      await chrome.storage.local.set({ [KEY]: h });
      return { added, ...(rejected.length ? { rejected } : {}), ...(revised.length ? { revised } : {}) };
    } catch (e) {
      return { added: 0, error: String(e?.message ?? e) };
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// ── gaps and poll log ──────────────────────────────────────────────────────
//
// Tableau publishes the home store roughly hourly, on its own clock. A missing
// hour in the progression is either Tableau not publishing or a check that
// failed; the history alone cannot tell the two apart, so every home-store
// check is logged beside it under its own key (addEntry rebuilds the history
// object, so extra fields there would not survive).

// Longer than this between two kept updates' data times is shown as a gap.
export const GAP_MINUTES = 75;

/** Stretches of Tableau data time with no kept update, as { index, from, to, minutes }. */
export function updateGaps(entries, { gapMinutes = GAP_MINUTES } = {}) {
  const out = [];
  for (let i = 1; i < (entries || []).length; i++) {
    const from = entries[i - 1].sourceIso || entries[i - 1].capturedAt;
    const to = entries[i].sourceIso || entries[i].capturedAt;
    const ms = Date.parse(to) - Date.parse(from);
    if (Number.isFinite(ms) && ms > gapMinutes * 60_000) out.push({ index: i, from, to, minutes: Math.round(ms / 60_000) });
  }
  return out;
}

export const POLLS_KEY = "vizpick.homeHistory.polls.v1";
export const MAX_POLLS_PER_DAY = 96;

/** Pure: append one check to its local day, newest last, capped per day and by days. */
export function addPoll(log, poll, { maxPerDay = MAX_POLLS_PER_DAY, maxDays = MAX_DAYS } = {}) {
  const day = poll?.at ? localDayKey(poll.at) : null;
  if (!day) return log;
  const next = { v: 1, days: { ...(log?.days || {}) } };
  next.days[day] = [...(next.days[day] || []), poll].slice(-maxPerDay);
  const keep = Object.keys(next.days).sort().reverse().slice(0, maxDays);
  for (const k of Object.keys(next.days)) if (!keep.includes(k)) delete next.days[k];
  return next;
}

/** Log one home-store check ({ reason, ok, outcome, stamp, error, revised }). Never throws. */
export function recordPoll(poll) {
  const run = async () => {
    try {
      const got = (await chrome.storage.local.get(POLLS_KEY))[POLLS_KEY];
      const next = addPoll(got?.v === 1 ? got : null, { ...poll, at: poll?.at || new Date().toISOString() });
      if (next) await chrome.storage.local.set({ [POLLS_KEY]: next });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/** One day's logged checks, oldest first. */
export async function readPolls(day) {
  try {
    const got = (await chrome.storage.local.get(POLLS_KEY))[POLLS_KEY];
    return got?.v === 1 ? (got.days?.[day] || []) : [];
  } catch {
    return [];
  }
}

// ── history files (move days between installs) ─────────────────────────────
//
// Each Edge profile keeps its own history, so a day captured in one (the debug
// Edge, 2026-09-15) is missing from the other. A history file is the stored
// object itself: { v: 1, days: { "YYYY-MM-DD": [entry, ...] } }.

/** Is this a usable history file? Returns a reason when not. */
export function validateHistoryFile(obj) {
  if (!obj || typeof obj !== "object") return "not a history file";
  if (obj.v !== 1 || !obj.days || typeof obj.days !== "object") return "not a VizPick pick history file (expected v: 1 with days)";
  for (const [day, list] of Object.entries(obj.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(list)) return `day "${day}" is not a list of updates`;
    for (const e of list) if (!e?.store || !Array.isArray(e.bins) || !e.capturedAt) return `an update on ${day} has no store, bins or capture time`;
  }
  return null;
}

/**
 * Pure: merge `incoming` days into `base`. An update already kept (same store,
 * same Tableau stamp and same data) is not duplicated; everything else is added
 * and each day re-sorted by capture time. Returns per-day counts.
 */
export function mergeHistories(base, incoming, { maxDays = MAX_DAYS } = {}) {
  const h = { v: 1, days: { ...(base?.days || {}) } };
  const added = {};
  const idOf = (e) => `${e.store}|${e.sourceIso || e.sourceKey || e.capturedAt}|${e.fp ?? fingerprint(e.bins)}`;
  for (const [day, list] of Object.entries(incoming?.days || {})) {
    const kept = (h.days[day] || []).map((e) => (e.fp && e.totals ? e : { ...e, fp: e.fp ?? fingerprint(e.bins), totals: e.totals ?? totalsOf(e.bins) }));
    const seen = new Set(kept.map(idOf));
    let n = 0;
    for (const e of list) {
      const id = idOf(e);
      if (seen.has(id)) continue;
      seen.add(id);
      kept.push({ ...e, fp: e.fp ?? fingerprint(e.bins), totals: e.totals ?? totalsOf(e.bins) });
      n++;
    }
    kept.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
    h.days[day] = kept;
    added[day] = n;
  }
  const keep = Object.keys(h.days).sort().reverse().slice(0, maxDays);
  for (const k of Object.keys(h.days)) if (!keep.includes(k)) delete h.days[k];
  return { history: h, added };
}

/** Merge a history file into storage. Never throws. */
export function importHistory(file) {
  const run = async () => {
    try {
      const reason = validateHistoryFile(file);
      if (reason) return { ok: false, error: reason };
      const { history, added } = mergeHistories(await read(), file);
      await chrome.storage.local.set({ [KEY]: history });
      return { ok: true, added };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}
