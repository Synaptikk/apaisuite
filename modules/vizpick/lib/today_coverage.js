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
