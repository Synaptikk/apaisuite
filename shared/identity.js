// shared/identity.js
//
// One place for "who is this analyst and which store are they at", fed
// OPPORTUNISTICALLY by whichever module happens to observe a credential.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// Before this, the home store came from exactly two places: a manual override,
// or a WIN parsed out of the Auror JWT that AurorBuddy caches on first auth.
// That made identity a SIDE EFFECT OF ONE MODULE. Someone who opens the suite,
// skips the setup wizard and uses only LiveDashboard could never be identified,
// however much they used the suite — and their usage rows carried an empty
// storeNumber forever. That is exactly what the 2026-08-31 "Unknown store"
// telemetry row was.
//
// The fix is not a better single source. It is noticing that the suite is
// already swimming in credentials that carry the user's WIN, and that any one
// of them is enough:
//
//   · gscope's `store-no` cookie      (sparkfraud/sparkrisk sessions)
//   · gscope's `wire-id` cookie       ("Display Name - loginId")
//   · the Power BI MWCToken           (digitallocks pulls; UPN in workloadClaims)
//   · the Auror JWT                   (aurorbuddy — the original source)
//   · the browser profile's account   (chrome.identity, optional permission)
//
// Each alone is module-specific and unreliable. The union covers essentially
// anyone who does anything real in the suite.
//
// ── HIRE store vs SESSION store ───────────────────────────────────────────
//
// These are different numbers and the distinction is deliberate here.
//
// A WIN like `ses008s.s01458` encodes the store the person was HIRED at. It is
// stable, and wrong for anyone who has since transferred. gscope's `store-no`
// cookie is the store their CURRENT SESSION is scoped to — what Walmart's own
// systems think they are working today.
//
// For usage telemetry the question is "where is this person working", so the
// session store outranks every WIN-derived one. The old code preferred the
// WIN-derived value because it was the only one it had. `storeSource` records
// which won, so a disagreement is visible instead of silently resolved.
//
// ── Privacy boundary (load-bearing) ───────────────────────────────────────
//
// WIN, UPN and display name are stored LOCALLY ONLY. They exist to derive a
// store number and to label the UI. `shared/usage_metrics.js::buildUsageRow`
// sends storeNumber / marketNumber / role and an installationId — never the
// WIN, never the UPN, never a name. Do not add them to a telemetry row: the
// suite's usage reporting is deliberately store-level, not person-level, and
// that is the difference between a usage dashboard and surveillance of the
// analysts using it.

const IDENTITY_KEY = "apai.identity";

// Confidence ranking. Higher wins when two sources disagree about a field.
// Ranked by how directly the source answers "which store TODAY":
//   manual         — the user typed it; nothing may override a human.
//   gscope_session — Walmart's own session store. The only non-derived answer.
//   profile_email  — browser profile account; a UPN, so a hire store.
//   powerbi_token  — UPN out of a captured MWCToken. Same derivation.
//   auror_jwt      — WIN out of the Auror sub claim. Same derivation.
//   workvivo       — weakest; present mostly for completeness.
export const SOURCE_RANK = Object.freeze({
  manual:         100,
  gscope_session:  80,
  profile_email:   60,
  powerbi_token:   50,
  auror_jwt:       50,
  workvivo:        40,
});

export const SOURCES = Object.freeze(Object.keys(SOURCE_RANK));

// WIN format observed across Auror subs, gscope wire-ids and AAD UPNs:
// "<wid>.s<NNNNN>", where the trailing 3–5 digits are the hire store.
const WID_STORE_RE = /\.s(\d{3,5})\b/i;

/** "samlp|wm-us|ses008s.s01458" → "ses008s.s01458". Passes a bare WIN through. */
export function winFromAurorSub(sub) {
  if (!sub) return "";
  const s = String(sub).trim();
  const m = s.match(/\|([^|]+)$/);
  return (m ? m[1] : s).trim();
}

/** "ses008s.s01458@us.wal-mart.com" → "ses008s.s01458". */
export function winFromUpn(upn) {
  if (!upn) return "";
  const s = String(upn).trim();
  const at = s.indexOf("@");
  return (at === -1 ? s : s.slice(0, at)).trim();
}

/** "ses008s.s01458" → "1458". Leading zeros stripped — store ids carry none. */
export function storeFromWin(win) {
  if (!win) return "";
  const m = String(win).match(WID_STORE_RE);
  return m ? String(parseInt(m[1], 10)) : "";
}

/** gscope's wire-id cookie: "Display Name - loginId". */
export function parseWireId(wireId) {
  if (!wireId) return { displayName: "", win: "" };
  const s = String(wireId).trim();
  const m = s.match(/^(.*?)\s*-\s*([^-\s][^-]*?)\s*$/);
  if (!m) return { displayName: s, win: "" };
  return { displayName: m[1].trim(), win: m[2].trim() };
}

/**
 * Pull a UPN out of a JWT without verifying it.
 *
 * NOT a security boundary — we are reading a token the browser already holds
 * to learn which store to default a dashboard to. Nothing is authorised on the
 * strength of it, so an unverified decode is appropriate and a signature check
 * would be theatre.
 *
 * Handles Power BI's MWCToken shape too: its payload carries `workloadClaims`
 * as an embedded JSON STRING whose `qes.user` is the UPN.
 */
export function upnFromJwt(token) {
  if (!token) return "";
  const raw = String(token).replace(/^\s*(Bearer|MWCToken)\s+/i, "").trim();
  const parts = raw.split(".");
  if (parts.length < 2) return "";
  let payload;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    payload = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
  } catch { return ""; }

  for (const claim of ["upn", "unique_name", "preferred_username", "email"]) {
    const v = payload?.[claim];
    if (typeof v === "string" && v.includes("@")) return v.trim();
  }
  // Power BI MWCToken: workloadClaims is a JSON string, not an object.
  try {
    const wc = typeof payload?.workloadClaims === "string"
      ? JSON.parse(payload.workloadClaims)
      : payload?.workloadClaims;
    const user = wc?.qes?.user;
    if (typeof user === "string" && user.includes("@")) return user.trim();
  } catch { /* not an MWCToken */ }
  return "";
}

// ── Store ────────────────────────────────────────────────────────────────

export async function getIdentity() {
  try {
    const got = await chrome.storage.local.get(IDENTITY_KEY);
    return got?.[IDENTITY_KEY] || {};
  } catch {
    return {};
  }
}

/**
 * Record whatever a module just learned. Every field is optional — pass what
 * you have. Higher-ranked sources overwrite lower-ranked ones PER FIELD, so a
 * source that knows the WIN but not the store cannot clear a better store.
 *
 * Safe to call on every request; it writes only when something actually
 * changes, so this can sit in a hot path.
 *
 * @param {object}  o
 * @param {string}  o.source       one of SOURCES
 * @param {string} [o.win]         "ses008s.s01458"
 * @param {string} [o.store]       session store, digits
 * @param {string} [o.upn]         "…@us.wal-mart.com"
 * @param {string} [o.displayName]
 * @returns {Promise<object>} the merged record
 */
export async function observeIdentity({ source, win, store, upn, displayName } = {}) {
  const rank = SOURCE_RANK[source];
  if (rank == null) throw new Error(`Unknown identity source: ${source}`);

  const cur = await getIdentity();
  const next = { ...cur };
  let changed = false;

  // A source that carries a UPN also carries a WIN; derive rather than making
  // every caller do it.
  const resolvedWin = win || winFromUpn(upn);
  // Only WIN-derived when the source did not give us a real session store.
  const resolvedStore = store || storeFromWin(resolvedWin);

  const put = (field, value, sourceField) => {
    if (!value) return;
    const prevRank = SOURCE_RANK[next[sourceField]] ?? -1;
    // `>=` so a repeat observation from the same source refreshes a changed
    // value (a transfer moves the session store) rather than pinning the first
    // one seen forever.
    if (rank < prevRank) return;
    if (next[field] === value && next[sourceField] === source) return;
    next[field] = value;
    next[sourceField] = source;
    changed = true;
  };

  put("store", resolvedStore, "storeSource");
  put("win", resolvedWin, "winSource");
  put("upn", upn, "upnSource");
  put("displayName", displayName, "displayNameSource");

  if (!changed) return cur;
  next.updatedAt = Date.now();
  try {
    await chrome.storage.local.set({ [IDENTITY_KEY]: next });
  } catch { /* storage full or unavailable — identity is a nicety, not a gate */ }
  return next;
}

/** Convenience for the common "I just captured a bearer token" case. */
export async function observeIdentityFromJwt(source, token) {
  const upn = upnFromJwt(token);
  if (!upn) return null;
  return observeIdentity({ source, upn });
}

/** Test/debug escape hatch. Not called in normal operation. */
export async function clearIdentity() {
  try { await chrome.storage.local.remove(IDENTITY_KEY); } catch { /* ignore */ }
}

// ── Browser-profile account (optional permission) ────────────────────────

/**
 * The signed-in browser profile's email — the ONLY source that identifies
 * someone who opens the suite and does nothing, since it needs no site session
 * and no user input.
 *
 * Gated behind an OPTIONAL permission on purpose: `identity` is a privacy
 * disclosure on a Chrome Web Store listing, and the store build has just been
 * trimmed of `debugger` for exactly that kind of reason. Nothing requests it
 * automatically — the user opts in from Settings.
 *
 * UNVERIFIED ON MANAGED EDGE. Edge implements chrome.identity, but whether a
 * managed AAD profile returns the corporate address here has not been tested
 * on a real machine. `probeProfileEmail()` exists to answer that; treat a
 * `reason` of "no-email" as "this route does not work here", not as "the user
 * is signed out".
 *
 * @returns {Promise<{ok: boolean, email?: string, reason?: string}>}
 */
export async function probeProfileEmail() {
  if (!chrome?.identity?.getProfileUserInfo) {
    return { ok: false, reason: "no-api" };
  }
  const granted = await chrome.permissions
    .contains({ permissions: ["identity"] })
    .catch(() => false);
  if (!granted) return { ok: false, reason: "not-granted" };

  try {
    const info = await new Promise((resolve, reject) => {
      chrome.identity.getProfileUserInfo((i) => {
        const err = chrome.runtime.lastError;
        return err ? reject(new Error(err.message)) : resolve(i);
      });
    });
    const email = String(info?.email || "").trim();
    if (!email) return { ok: false, reason: "no-email" };
    return { ok: true, email };
  } catch (e) {
    return { ok: false, reason: `error: ${e?.message ?? e}` };
  }
}

/** Request the optional permission, then record what it yields. */
export async function enableProfileEmailIdentity() {
  const granted = await chrome.permissions
    .request({ permissions: ["identity"] })
    .catch(() => false);
  if (!granted) return { ok: false, reason: "denied" };
  const probe = await probeProfileEmail();
  if (!probe.ok) return probe;
  await observeIdentity({ source: "profile_email", upn: probe.email });
  return probe;
}
