// shared/associateDirectory.js
//
// One permanent local directory of associates, keyed by WIN, shared by every
// module that resolves a user id to a person. Replaces three separate caches
// (digitallocks 24 h, claimsdisposition 30 d, assocpurchases 30 d) that each
// re-pulled the same people on their own schedule and never saw each other's
// results.
//
// The rule: a WIN we have already resolved is NEVER fetched again. New hires
// and anyone we have not seen before are the only reason to hit the network.
//
// ── Why tenure is stored as a hire date ────────────────────────────────────
//
// Workday reports "Length of Service: 13 year(s), 4 month(s), 4 day(s)" — a
// value that is only true on the day it was read. Cache that forever and it
// silently rots: an associate stays "13 years 4 months" indefinitely, and the
// new-hire threshold that reads it stops firing correctly.
//
// So we convert once, at write time, to the fact that does NOT change:
//
//     hireDateApprox = today - lengthOfService
//
// and recompute elapsed tenure on every read. That is what makes "pull once,
// keep forever" correct rather than a staleness bug. It is `Approx` because
// Workday's own figure is rounded to whole days and says nothing about breaks
// in service — good to a day or so, which is all any consumer needs.
//
// ── Hits are permanent, misses are not ─────────────────────────────────────
//
// A resolved record is a fact and never expires. A MISS is not a fact — it is
// usually a failure (auth wall, page not rendered yet, ambiguous search). If
// misses were permanent, one bad afternoon would blacklist a real associate
// forever. Misses therefore get a short TTL and are stored separately.
//
// ── Storage layout ─────────────────────────────────────────────────────────
//
//   chrome.storage.local["apai.assoc.<win>"]      → record (permanent)
//   chrome.storage.local["apai.assoc.miss.<win>"] → { at } (1 h)
//
// Record shape (every field optional except win/updatedAt — modules fill in
// whichever half they can resolve, and merge() never blanks a known field
// with a null from a source that didn't know it):
//
//   { win, name, title, store, hireDateApprox: "YYYY-MM-DD",
//     sources: { name: "workvivo", tenure: "workday" },
//     firstSeenAt, updatedAt }
//
// Uses raw chrome.storage.local, not host.storage: this runs in the service
// worker too, where `host` does not exist.

const PREFIX      = "apai.assoc.";
const MISS_PREFIX = "apai.assoc.miss.";
const MISS_TTL_MS = 60 * 60 * 1000;   // 1 h — a miss is a failure, not a fact

const DAY_MS = 86_400_000;

// Workday's own rounding constants, used in both directions so a value that
// round-trips (duration → hire date → duration) lands back on itself.
const DAYS_PER_YEAR  = 365.25;
const DAYS_PER_MONTH = 30.44;

/**
 * Normalise a person's name for display.
 *
 * The sources disagree: Workvivo returns some names ALL CAPS and others all
 * lowercase, and both look wrong next to each other in a list. Applied on the
 * way IN so every consumer gets the same string — formatting it per-view means
 * every new view re-solves it, and one of them forgets.
 *
 * Deliberately conservative, because a name is not a word:
 *   · Only reshapes strings that are entirely one case. A name already in
 *     mixed case ("McDonald", "van der Berg", "DeSoto") is left ALONE — it is
 *     more likely to be correct than anything this function would produce.
 *   · Keeps internal punctuation and capitalises after it: "o'brien" →
 *     "O'Brien", "smith-jones" → "Smith-Jones".
 *   · Leaves a lone suffix like "II" or "III" uppercase.
 *
 * Round-trip safe: titleCaseName(titleCaseName(x)) === titleCaseName(x).
 */
export function titleCaseName(name) {
  const raw = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  // Mixed case already — trust the source over a guess.
  const letters = raw.replace(/[^A-Za-z]/g, "");
  if (letters && letters !== letters.toUpperCase() && letters !== letters.toLowerCase()) return raw;

  const SUFFIXES = new Set(["II", "III", "IV", "JR", "SR"]);
  return raw
    .split(" ")
    .map((word) => {
      const bare = word.replace(/[^A-Za-z]/g, "").toUpperCase();
      if (SUFFIXES.has(bare)) return bare.length <= 3 && /^[IV]+$/.test(bare) ? bare : bare[0] + bare.slice(1).toLowerCase();
      // Capitalise the first letter of each punctuation-delimited part.
      return word.toLowerCase().replace(/(^|[^A-Za-z])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
    })
    .join(" ");
}

export function normalizeWin(win) {
  return String(win ?? "").trim().toLowerCase();
}

function key(win)     { return PREFIX + normalizeWin(win); }
function missKey(win) { return MISS_PREFIX + normalizeWin(win); }

/**
 * Parse a Workday "Length of Service" string into whole days.
 * Tolerates "13 year(s), 4 month(s), 4 day(s)", "7 months", "14 days".
 * Returns null when nothing numeric is found.
 */
export function parseLengthOfService(text) {
  const s = String(text ?? "");
  const y = Number(s.match(/(\d+)\s*year/i)?.[1] ?? 0);
  const m = Number(s.match(/(\d+)\s*month/i)?.[1] ?? 0);
  const d = Number(s.match(/(\d+)\s*day/i)?.[1] ?? 0);
  if (!y && !m && !d) return null;
  return Math.round(y * DAYS_PER_YEAR + m * DAYS_PER_MONTH + d);
}

/** Days → "YYYY-MM-DD" hire date, counted back from `asOf` (default now). */
export function hireDateFromTenureDays(tenureDays, asOf = Date.now()) {
  if (!Number.isFinite(tenureDays)) return null;
  return new Date(asOf - tenureDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Elapsed tenure in days for a stored record, computed fresh on every call.
 * Null when the record has no hire date. This is the only supported way to
 * read tenure — never persist the number it returns.
 */
export function tenureDaysFor(record, asOf = Date.now()) {
  if (!record?.hireDateApprox) return null;
  const t = Date.parse(`${record.hireDateApprox}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((asOf - t) / DAY_MS));
}

/** Human "13y 4m" style label, derived — never stored. */
export function tenureLabelFor(record, asOf = Date.now()) {
  const days = tenureDaysFor(record, asOf);
  if (days == null) return null;
  const years  = Math.floor(days / DAYS_PER_YEAR);
  const months = Math.floor((days - years * DAYS_PER_YEAR) / DAYS_PER_MONTH);
  if (!years)  return months ? `${months}m` : `${days}d`;
  return months ? `${years}y ${months}m` : `${years}y`;
}

/** Read one record. Permanent — no freshness check. Null when unknown. */
export async function get(win) {
  const w = normalizeWin(win);
  if (!w) return null;
  try {
    const got = await chrome.storage.local.get(key(w));
    return presentable(got?.[key(w)] ?? null);
  } catch {
    return null;
  }
}

/**
 * Apply display normalisation on the way OUT as well as on the way in.
 *
 * merge() fixes casing for everything written from now on, but the store is
 * permanent and already holds names cached before that existed. Doing it here
 * too means those read back correctly without a migration or making anyone
 * forget() their whole directory — and titleCaseName is idempotent, so a name
 * already fixed passes through untouched.
 *
 * Not written back: a read is not a good reason to touch storage, and the next
 * merge() will persist it anyway.
 */
function presentable(rec) {
  if (!rec) return rec;
  const name = titleCaseName(rec.name);
  const title = titleCaseName(rec.title);
  if (name === rec.name && title === rec.title) return rec;
  return { ...rec, ...(rec.name ? { name } : {}), ...(rec.title ? { title } : {}) };
}

/**
 * Does this record actually carry a display name?
 *
 * A record EXISTING is not the same as a name being known, and conflating the
 * two is a live bug this directory has already caused once: digitallocks
 * writes title/tenure from Workday for associates a reviewer opened, and those
 * records carry no `name` field at all. A caller that gates its resolver on
 * "is there a record?" therefore skips exactly the people other tools have
 * already touched, and renders their WIN forever — the nameless record
 * survives a reload, so it never self-corrects.
 *
 * Gate on this, not on `get()`/`getMany()` returning something.
 */
export function hasName(rec) {
  return typeof rec?.name === "string" && rec.name.trim().length > 0;
}

/** Read many at once — one storage round trip. Returns a Map(win → record). */
export async function getMany(wins) {
  const uniq = Array.from(new Set((wins || []).map(normalizeWin).filter(Boolean)));
  if (!uniq.length) return new Map();
  try {
    const got = await chrome.storage.local.get(uniq.map(key));
    const out = new Map();
    for (const w of uniq) {
      const rec = got?.[key(w)];
      if (rec) out.set(w, presentable(rec));
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * True when this WIN has been resolved before and must NOT be fetched again.
 * Callers should gate their network path on this.
 */
export async function isKnown(win) {
  return (await get(win)) != null;
}

/**
 * True when a recent lookup failed for this WIN, so a caller can back off
 * without re-hammering a source that just said no.
 */
export async function isRecentMiss(win, asOf = Date.now()) {
  const w = normalizeWin(win);
  if (!w) return false;
  try {
    const got = await chrome.storage.local.get(missKey(w));
    const at = got?.[missKey(w)]?.at;
    return Number.isFinite(at) && asOf - at < MISS_TTL_MS;
  } catch {
    return false;
  }
}

/** Record a failed lookup. Short-lived by design — see the header. */
export async function markMiss(win, asOf = Date.now()) {
  const w = normalizeWin(win);
  if (!w) return;
  try { await chrome.storage.local.set({ [missKey(w)]: { at: asOf } }); } catch { /* best effort */ }
}

/**
 * Merge fields into a record, creating it if new. Returns the stored record.
 *
 * Merge semantics: a null/undefined/empty incoming field never overwrites a
 * known value. Workvivo resolves names but not tenure; Workday resolves both.
 * Whichever runs second must not blank what the first one learned.
 *
 * Pass `lengthOfService` (the raw Workday string) or `tenureDays` and the
 * hire date is derived here — callers never compute or store it themselves.
 */
export async function merge(win, fields = {}, asOf = Date.now()) {
  const w = normalizeWin(win);
  if (!w) return null;

  const prev = (await get(w)) ?? { win: w, firstSeenAt: asOf };

  const tenureDays = Number.isFinite(fields.tenureDays)
    ? fields.tenureDays
    : parseLengthOfService(fields.lengthOfService);

  const next = {
    ...prev,
    win: w,
    updatedAt: asOf,
    sources: { ...(prev.sources ?? {}), ...(fields.sources ?? {}) },
  };

  for (const f of ["name", "title", "store"]) {
    let v = typeof fields[f] === "string" ? fields[f].trim() : fields[f];
    // Casing is fixed here, once, rather than in each view. Workvivo returns
    // some names ALL CAPS and others all lowercase; a list showing both reads
    // as broken even though every name in it is correct.
    if ((f === "name" || f === "title") && typeof v === "string") v = titleCaseName(v);
    if (v != null && v !== "") next[f] = v;
  }

  // Only set the hire date if we don't have one. Re-deriving it from a fresh
  // "length of service" on every sighting would make it drift by the rounding
  // error each time, and the earliest reading is the least-rounded one.
  if (!next.hireDateApprox && tenureDays != null) {
    next.hireDateApprox = hireDateFromTenureDays(tenureDays, asOf);
  }

  try {
    await chrome.storage.local.set({ [key(w)]: next });
    await chrome.storage.local.remove(missKey(w));   // resolved — clear any miss
  } catch { /* best effort; the in-memory return value is still correct */ }

  return next;
}

/**
 * Drop a record so the next lookup re-fetches it. This is the transfer /
 * name-change / promotion path — there is no TTL that would catch those,
 * and guessing one would mean re-pulling everybody on the off chance.
 */
export async function forget(win) {
  const w = normalizeWin(win);
  if (!w) return;
  try { await chrome.storage.local.remove([key(w), missKey(w)]); } catch { /* best effort */ }
}

/** Every stored record, for a "known associates" admin view or an export. */
export async function listAll() {
  try {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith(PREFIX) && !k.startsWith(MISS_PREFIX))
      .map(([, v]) => v)
      .filter((v) => v && typeof v === "object");
  } catch {
    return [];
  }
}
