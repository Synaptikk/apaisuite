// shared/sparkInvestigation/auth.js
//
// Pure header-building for Dispatcher (swift.walmart.com) API calls.
//
// Given a gscope session cookie jar (as read by
// shared/auth.js:readCookiesViaTab), return the Dispatcher headers dict —
// or a diagnostic reason string on failure.
//
// Dedupes two verbatim copies that existed before this extraction:
//   - modules/sparkfraud/service.js:1298-1378 (_buildSwiftHeaders)
//   - modules/sparkfraud/view.js:793-854      (buildHeaders)
//
// The view.js copy additionally called setStatus() for the SparkFraud UI —
// that UI-side effect is kept in the view.js wrapper. This function is
// runtime-inert.
//
// Behavior contract (must not drift):
//   - Returns { ok: true, headers } when authtoken is present.
//   - Returns { ok: false, reason, message } otherwise. `reason` codes:
//       "auth-cookies-missing"  — no authtoken cookie
//   - Falls back to `wire-id` cookie for display/loginId when the legacy
//     `displayname`/`loginid` cookies are empty (Walmart's gscope changed
//     to send those as empty strings — parsing wire-id preserves behavior
//     the UI depends on for the "Signed in: <name>" badge).

export function buildSwiftHeaders(cookies) {
  if (!cookies || typeof cookies !== "object") {
    return { ok: false, reason: "no-cookies", message: "Cookie jar missing." };
  }

  // Lowercase keys for case-insensitive lookup — Walmart cookies are
  // inconsistently cased (`loginId` vs `loginid`, etc).
  const ci = {};
  for (const k of Object.keys(cookies)) ci[k.toLowerCase()] = cookies[k];
  if (!ci.authtoken) {
    return {
      ok: false,
      reason: "auth-cookies-missing",
      message: "gscope authToken cookie missing",
      have: Object.keys(cookies).sort(),
    };
  }

  let loginId = ci.loginid || "";
  let display = ci.displayname || "";
  // Walmart's gscope now ships displayname/loginid as EMPTY strings —
  // the canonical identity moved to wire-id ("Display Name - loginId").
  if ((!display || !loginId) && ci["wire-id"]) {
    const m = ci["wire-id"].match(/^(.*?)\s*-\s*([^-\s][^-]*?)\s*$/);
    if (m) {
      if (!display) display = m[1].trim();
      if (!loginId) loginId = m[2].trim();
    } else if (!display) {
      display = ci["wire-id"];
    }
  }
  const storeId      = ci["store-no"] || ci.storeno || "";
  const loggedDomain = ci.loggedindomain || "store";
  const loggedUser   = ci.loggedinusername || "";
  const firstName    = display.split(" ")[0] || "";
  const lastName     = display.split(" ").slice(1).join(" ") || "";

  return {
    ok: true,
    identity: { loginId, display, firstName, lastName, storeId, loggedDomain, loggedUser },
    headers: {
      "content-type":          "application/json",
      "x-authheader":          ci.authheader || "",
      "x-authtoken":           ci.authtoken  || "",
      "x-userid":              loginId,
      "x-username":            display,
      "x-firstname":           firstName,
      "x-lastname":            lastName,
      "x-loggedindomain":      loggedDomain,
      "x-loggedinusername":    loggedUser,
      "x-storeid":             storeId,
      "x-realmid":             "DISPATCHER_WEB_UI",
      "x-source":              "DISPATCHER",
      "x-sourceapp":           "DISPATCHER_WEB_UI",
      "x-channel":             "WEB",
      "x-domain":              "USLM",
      "x-tenant":              "WALMART_US",
      "x-tenantid":            "0",
      "tenantid":              "0",
      "wm_tenant_id":          "0",
      "wm_consumer.tenant_id": "0",
      "x-timezone":            "+00:00",
      "device_timezone":       "America/New_York",
      "installed_app":         "spark-dispatcher.us",
    },
  };
}
