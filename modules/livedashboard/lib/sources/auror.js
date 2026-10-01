// modules/livedashboard/lib/sources/auror.js
//
// Auror Exceptions — evidence completeness on the user's home-store events.
//
// Policy (user requirement, 2026-09-25): every event needs
//   - at least 1 evidence photo,
//   - a statement,
//   - at least 3 video clips (the theft, the door, the office).
// Events in the lookback window missing any of those are flagged.
//
// Data path (see dev/ORCMONITOR_AUROR_FINDINGS.md for endpoint notes):
//   1. JWT: captured declaratively by the shell from the user's own Auror
//      browsing (module.js webRequestFilters). Falls back to the
//      aurorbuddy/orcmonitor captures so any one of them suffices.
//   2. Site trait: Sites/searchable-sites?search=<store#> → siteId, then
//      SiteDashboard/{siteId}/profile → the exact "SITE: …" trait string.
//   3. Events: GlobalSearch/globalSearch with that trait, custom date range
//      (timeRangeFilter="" + YYYY-MM-DD, both inclusive; pages of 10).
//   4. Evidence: EventProfile/event/{id} → evidenceLockerView.
//
// GeneralIntel and DeniedEntry events are exempt — they document context,
// not prosecutable theft, so the video/photo/statement bar doesn't apply.

import { readCapturedHeader } from "../../../../shared/captured_headers.js";

const BASE = "https://app.us.auror.co/api/spa";
const LOOKBACK_DAYS = 30;
const REQUIRED_VIDEO_CLIPS = 3;
const MAX_EVENTS = 120;          // safety cap on EventProfile fan-out
const EXEMPT_TYPES = new Set(["GeneralIntel", "DeniedEntry", "PersonOfInterest", "BreachOfTrespass"]);

// Any capture from these modules works — the token is account-wide.
const JWT_KEYS = ["livedashboard.auror.jwt", "orcmonitor.auror.jwt", "aurorbuddy.auror.jwt"];
const JWT_TTL_MS = 20 * 60 * 1000;

async function getJwt() {
  // In-memory map first (same SW), then chrome.storage.session (SW re-wake).
  for (const key of JWT_KEYS) {
    const entry = readCapturedHeader(key);
    if (entry?.value && Date.now() - (entry.at ?? 0) <= JWT_TTL_MS) return entry.value;
  }
  const got = await chrome.storage.session.get(JWT_KEYS).catch(() => ({}));
  for (const key of JWT_KEYS) {
    const entry = got[key];
    if (entry?.value && Date.now() - (entry.at ?? 0) <= JWT_TTL_MS) return entry.value;
  }
  return null;
}

async function aurorFetch(jwt, path, params) {
  let url = `${BASE}${path}`;
  if (params) url += "?" + new URLSearchParams(params).toString();
  const resp = await fetch(url, {
    headers: { "Authorization": jwt, "X-Requested-With": "XMLHttpRequest" },
  });
  if (!resp.ok) throw new Error(`Auror HTTP ${resp.status} on ${path}`);
  return resp.json();
}

// Store number → the exact uppercase "SITE: …" trait globalSearch filters on.
async function resolveSiteTrait(jwt, storeNbr) {
  const found = await aurorFetch(jwt, `/Sites/organizations/12/searchable-sites`, { search: String(storeNbr) });
  const site = (found?.items ?? []).find((s) => String(s.primaryIdentifier) === String(storeNbr));
  if (!site) throw new Error(`Store ${storeNbr} not found in Auror sites`);
  const profile = await aurorFetch(jwt, `/SiteDashboard/${site.id}/profile`);
  const trait = (profile?.siteTraits ?? []).find((t) => t.key === "SITE");
  if (!trait?.value) throw new Error(`No SITE trait on Auror site ${site.id}`);
  return `SITE: ${trait.value}`.startsWith("SITE: SITE:") ? trait.value : `SITE: ${trait.value}`;
}

const ymd = (d) => d.toISOString().slice(0, 10);

async function listStoreEvents(jwt, siteTrait, days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const all = [];
  let total = null;
  for (let skip = 0; skip < MAX_EVENTS; skip += 10) {
    const d = await aurorFetch(jwt, "/GlobalSearch/globalSearch", {
      searchString: "", skip: String(skip), includeTotalResultCount: "true",
      intelTypeFilters: "Event", siteTraits: siteTrait,
      timeRangeFilter: "", startDate: ymd(start), endDate: ymd(end),
    });
    const rows = d?.searchResults ?? [];
    all.push(...rows);
    total ??= d?.totalResultCount ?? 0;
    if (rows.length < 10 || all.length >= total) break;
  }
  return all;
}

// ── Evidence classification ─────────────────────────────────────────
//
// evidenceLockerView shape (sampled 2026-09-25, events e50100115/e50124061):
//   { hasEvidenceLockerAccess, canManageFiles,
//     evidenceFiles: [ { fileName, fileType: "Image"|"Video"|"Pdf",
//       mimeType, evidenceType: "Other"|"NarrativeStatement", fileState } ] }
// The typed fields are authoritative; filename/MIME are fallbacks. A PDF
// with evidenceType "Other" (e.g. an uploaded receipt) is NOT a statement —
// only NarrativeStatement (Auror's "Generate statement") or a filename
// containing "statement" counts.

// The three required angles. Auror gives us no angle field -- the only
// per-clip signal is the file name -- so the angle has to be read out of that.
// A clip whose name matches nothing is still counted toward the 3, it just
// cannot be attributed, and the report says "could not tell" rather than
// guessing. Tighten these patterns once a real store naming sample disagrees.
export const VIDEO_ANGLES = [
  { key: "theft",  label: "the theft",
    re: /theft|steal|conceal|select|aisle|register|sco|self.?check|checkout|lane|pos|till|counter/i },
  { key: "door",   label: "exiting the building",
    re: /door|exit|entrance|entry|egress|vestibule|foyer|lobby|apron|front.?end|outside|parking|lot/i },
  { key: "office", label: "the office",
    re: /office|ap.?room|interview|holding|detention|bor/i },
];

export function classifyEvidence(files) {
  let videoCount = 0, photoCount = 0, statementCount = 0;
  const angles = { theft: 0, door: 0, office: 0 };
  let videoUnattributed = 0;
  for (const f of files || []) {
    const name = String(f.fileName ?? "");
    const mime = String(f.mimeType ?? "").toLowerCase();
    const type = String(f.fileType ?? "");
    if (String(f.evidenceType ?? "") === "NarrativeStatement" || /statement/i.test(name)) { statementCount++; continue; }
    if (type === "Video" || mime.startsWith("video/")) {
      videoCount++;
      // A name matching two angles ("front door register") proves neither, so
      // it counts as unattributed rather than crediting the wrong one.
      const hits = VIDEO_ANGLES.filter((a) => a.re.test(name));
      if (hits.length === 1) angles[hits[0].key]++;
      else videoUnattributed++;
      continue;
    }
    if (type === "Image" || mime.startsWith("image/")) { photoCount++; continue; }
  }
  return { videoCount, photoCount, statementCount, angles, videoUnattributed };
}

/**
 * Plain-English account of the video gap for one event, for the email export
 * and the drill's Missing cell. Never asserts an angle it cannot evidence.
 * @returns {{ have:string[], lack:string[], certain:boolean, text:string, short:string }}
 */
export function explainVideoGap(rec = {}) {
  const { videoCount = 0, angles = null } = rec;
  // A record cached before angle classification existed has no `angles` at all.
  // Absent is not the same as "no angle matched": treating it as zeros would
  // confidently report all three angles missing for an event that has clips.
  // Unknown means unknown, so every clip counts as unattributed.
  const known = angles != null;
  const videoUnattributed = known ? (rec.videoUnattributed ?? 0) : videoCount;
  const a = known ? angles : { theft: 0, door: 0, office: 0 };
  const have = VIDEO_ANGLES.filter((x) => a[x.key] > 0).map((x) => x.label);
  const lack = VIDEO_ANGLES.filter((x) => !a[x.key]).map((x) => x.label);
  const short2 = `${videoCount} of ${REQUIRED_VIDEO_CLIPS}`;
  if (videoCount >= REQUIRED_VIDEO_CLIPS && !lack.length) {
    return { have, lack, certain: true, text: `All ${REQUIRED_VIDEO_CLIPS} angles present.`, short: short2 };
  }
  // Unattributed clips mean an unnamed angle might in fact be covered, so the
  // gap can only be stated as a count, not as a named missing angle.
  if (videoUnattributed > 0) {
    const named = have.length ? ` The clips we could identify cover ${list(have)}.` : "";
    return {
      have, lack, certain: false,
      short: `${short2}, angles unclear`,
      text: `${short2} clips uploaded, but ${videoUnattributed === videoCount
        ? "the file names do not say which angles they are"
        : `${videoUnattributed === 1 ? "one of them has a file name that does" : `${videoUnattributed} of them have file names that do`} not say which angle it is`}` +
        `, so the missing angle cannot be named from Auror alone.${named}` +
        ` Required: ${list(VIDEO_ANGLES.map((x) => x.label))}.`,
    };
  }
  return {
    have, lack, certain: true,
    short: `${short2}, no ${lack.map((l) => l.replace(/^the /, "").replace("exiting the building", "door")).join("/")}`,
    text: `${short2} clips. ${have.length ? `Has ${list(have)}. ` : ""}Missing ${list(lack)}.`,
  };
}

function list(xs) {
  if (!xs.length) return "nothing";
  if (xs.length === 1) return xs[0];
  return xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
}

export function missingFor({ videoCount, photoCount, statementCount }) {
  const missing = [];
  if (photoCount < 1) missing.push("photo");
  if (statementCount < 1) missing.push("statement");
  if (videoCount < REQUIRED_VIDEO_CLIPS) missing.push("video");
  return missing;
}

// ── Main fetch ──────────────────────────────────────────────────────

export async function fetchAurorExceptions(storeNbr, { days = LOOKBACK_DAYS } = {}) {
  const jwt = await getJwt();
  if (!jwt) {
    return {
      ok: false, errorClass: "NO_JWT",
      error: "No Auror token — open any Auror page to refresh it",
    };
  }
  try {
    const siteTrait = await resolveSiteTrait(jwt, storeNbr);
    const events = await listStoreEvents(jwt, siteTrait, days);

    const records = [];
    for (const ev of events) {
      const eventType = ev.eventType || "";
      if (EXEMPT_TYPES.has(eventType)) continue;
      const id = String(ev.resourceLocator || "").replace(/^e/, "");
      if (!id) continue;
      let profile;
      try {
        profile = await aurorFetch(jwt, `/EventProfile/event/${id}`);
      } catch {
        continue;   // one bad event must not sink the whole pull
      }
      const files = extractLockerFiles(profile);
      const counts = classifyEvidence(files);
      const missing = missingFor(counts);
      const persons = profile?.eventProfileResult?.eventPersons ?? [];
      records.push({
        eventId: id,
        eventType,
        title: ev.primaryIdentifier || `e${id}`,
        occurredAt: ev.occurredAt || ev.localOccurredAt || "",
        totalValue: ev.totalValue ?? null,
        people: persons.map((p) => p.identityGroupPrimaryIdentifier).filter(Boolean).join("; "),
        fileCount: (files || []).length,
        ...counts,
        missing,
      });
    }
    return { ok: true, records, days, capturedAt: new Date().toISOString() };
  } catch (e) {
    const msg = String(e?.message ?? e);
    return {
      ok: false,
      errorClass: /HTTP 401|HTTP 403/.test(msg) ? "EXPIRED" : "FETCH",
      error: msg.slice(0, 160),
    };
  }
}

// The locker files live at evidenceLockerView.evidenceFiles (sampled shape);
// tolerate a flat array in case the SPA contract shifts.
export function extractLockerFiles(profile) {
  const v = profile?.evidenceLockerView;
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (Array.isArray(v.evidenceFiles)) return v.evidenceFiles;
  return [];
}

export function rollup(records) {
  let flagged = 0, missingPhoto = 0, missingStatement = 0, missingVideo = 0;
  for (const r of records) {
    if (r.missing.length) flagged++;
    if (r.missing.includes("photo")) missingPhoto++;
    if (r.missing.includes("statement")) missingStatement++;
    if (r.missing.includes("video")) missingVideo++;
  }
  return { total: records.length, flagged, missingPhoto, missingStatement, missingVideo };
}
