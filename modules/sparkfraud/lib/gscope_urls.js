// modules/sparkfraud/lib/gscope_urls.js
//
// Pure URL predicates for the gscope SSO chain. Extracted from service.js so
// they can be tested without a chrome stub — the readiness test is the single
// thing this module's auth flow turns on, and it was wrong for a long time in
// a way that read as a cookie problem.
//
// THE BUG THIS FILE EXISTS TO PREVENT:
//
//   SSO_START_URL = "https://pfedprod.wal-mart.com/idp/startSSO.ping
//                    ?PartnerSpId=https://gscope.walmartlabs.com/sp"
//
// The SP entity id is a gscope URL sitting in pfedprod's QUERY STRING. Both
// readiness tests in service.js used `url.includes("gscope.walmartlabs.com")`,
// so a tab parked on the FIRST hop of the chain tested as "already on gscope":
//
//   - driveGscopeAuthChain returned true the moment pfedprod finished loading,
//     long before any auth cookie could exist, and
//   - _foregroundIfStillStuck read the same stall as success and returned null,
//     so a chain waiting on MFA was never surfaced to the analyst.
//
// The user-visible result was "the SSO chain completed but gscope issued no
// auth cookies" on every attempt, plus a leaked tab each time.
//
// Rule: "is this tab on gscope" is a HOSTNAME comparison. Never a substring.

export const GSCOPE_HOST = "gscope.walmartlabs.com";

/** True only when `url`'s host IS gscope — not merely mentions it. */
export function isGscopeHost(url) {
  if (!url) return false;
  try { return new URL(url).hostname === GSCOPE_HOST; }
  catch { return false; }
}

// A gscope tab is "usable" only if it's on a normal content page. Tabs parked
// on intermediate SSO endpoints (/api/wmstoresso, /api/sso*, /login) can't run
// injected scripts and don't have the full auth-cookie set yet — they're
// transient stops in the SSO chain that got stuck.
//
// Note this deliberately answers `true` for a non-gscope url: it means "stuck
// or not yet arrived", and only ever runs paired with isGscopeHost. Use
// isUsableGscopeUrl unless you specifically want the path half.
export function isStuckGscopeUrl(url) {
  if (!url) return true;
  return url.includes("/api/wmstoresso")
      || url.includes("/api/sso")
      || url.includes("/login");
}

/** The readiness test: on gscope's host AND on a real content page. */
export function isUsableGscopeUrl(url) {
  return isGscopeHost(url) && !isStuckGscopeUrl(url);
}
