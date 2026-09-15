// Rows captured before this revision can contain zeroes from Tableau's Null
// placeholders. Re-read them once even when the upstream timestamp is unchanged.
export const TODAY_DATA_REVISION = 2;

export function isTodayRowComplete(row) {
  return row?.dataRevision === TODAY_DATA_REVISION && row.hasHealth === true
    && ["casesSeenPct", "locationPct", "pickPct", "overstockPct", "vizpick"]
      .every((key) => Number.isFinite(row[key]))
    && Array.isArray(row.deptGroups) && row.deptGroups.length > 0
    && row.locations != null && Array.isArray(row.locations.gaps);
}

// Preserve successful sections only within the same source version. A failed
// retry must neither erase good location data nor keep a known-bad old revision.
export function mergeTodayRow(old, next) {
  if (!old) return next;
  if (old.dataRevision !== next.dataRevision) {
    if (next.dataRevision === TODAY_DATA_REVISION) return next;
    if (old.dataRevision === TODAY_DATA_REVISION) return old;
  }
  const merged = { ...next };
  if (old.hasHealth && !next.hasHealth) {
    for (const key of ["casesSeenPct", "locationPct", "pickPct", "overstockPct", "vizpick", "hasHealth"]) {
      merged[key] = old[key];
    }
  }
  merged.locations = next.locations ?? old.locations;
  merged.deptGroups = next.deptGroups ?? old.deptGroups;
  return merged;
}

// ── Wrong-store guard ───────────────────────────────────────────────────────
// Nothing in the per-store exports names the store: the Store parameter is
// set, the sheets are exported, and the rows are filed under the store that
// was ASKED for. If the parameter silently failed to take, a store receives
// the previous store's bins and scanners, labelled as its own — associate
// names under the wrong store, with nothing in the output to show it. Two
// stores never share bins-with-scanners, so identical location detail on two
// rows is proof that one of them is wrong. Used at capture (per lane, against
// the previous store) and in the view (across the stored snapshot).

/** "location|scanner" lines of the row's gaps, sorted; "" when there are none. */
export function locationSignature(row) {
  const gaps = row?.locations?.gaps;
  if (!Array.isArray(gaps) || !gaps.length) return "";
  return gaps.map((g) => `${g.location ?? ""}|${String(g.win ?? "").toLowerCase()}`).sort().join("\n");
}

/**
 * Rows with location detail identical to another row's get it withheld
 * (locations: null, locationsWithheld: { store }) — both sides, because the
 * data cannot say which store it really belongs to. Pure; returns new rows.
 */
export function withholdDuplicateLocations(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const bySig = new Map();
  for (const r of list) { const s = locationSignature(r); if (s) bySig.set(s, [...(bySig.get(s) || []), String(r.store)]); }
  return list.map((r) => {
    const s = locationSignature(r);
    const others = s ? (bySig.get(s) || []).filter((st) => st !== String(r.store)) : [];
    if (!others.length) return r;
    return { ...r, locations: null, locationsWithheld: { store: others[0] } };
  });
}
