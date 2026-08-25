// shared/appriss.js — the one place that knows where Secure/APPRISS lives.
// ─────────────────────────────────────────────────────────────────────────────
// Appriss moved the Walmart tenant off `wmtus.apprissretailcloud.com` onto a
// shared multi-tenant host: `apps.apprissretail.com/walmart-usa/...`. The app
// itself is unchanged — every path we already used exists on the new host with
// the tenant prefix in front of it:
//
//   old  https://wmtus.apprissretailcloud.com/platform/cpf/searchlite/...
//   new  https://apps.apprissretail.com/walmart-usa/platform/cpf/searchlite/...
//
// The prefix is MANDATORY. Verified 2026-08-23: the same path without
// `/walmart-usa` returns 403, not a redirect — so a half-migrated caller fails
// hard rather than silently hitting someone else's tenant. That's why BASE
// carries the prefix and every call site concatenates onto BASE, never onto
// ORIGIN.
//
// This is a CUTOVER, not a dual-run. The old host's edge still answers with a
// redirect to its own sign-in page, so probing it looks healthy — but the
// tenant behind it is gone (confirmed by the analyst 2026-08-23). Its
// host_permission has been removed; don't re-add it as a "fallback", because a
// fallback that can never succeed only turns a clear failure into a slow one.
//
// ORIGIN (no prefix) is still needed on its own for two things that are
// host-scoped rather than path-scoped: the cookie domain and `tabs.query`
// match patterns.
//
// Before this file the origin was copy-pasted across five files in two modules
// (aurorbuddy + assocpurchases). It has now been renamed once; assume it will
// be renamed again.
export const APPRISS_DOMAIN = "apps.apprissretail.com";
export const APPRISS_ORIGIN = `https://${APPRISS_DOMAIN}`;
export const APPRISS_TENANT = "/walmart-usa";
export const APPRISS_BASE   = `${APPRISS_ORIGIN}${APPRISS_TENANT}`;

// `tabs.query` / host_permissions pattern — host-scoped, no tenant prefix.
export const APPRISS_TAB_PATTERN = `${APPRISS_ORIGIN}/*`;

// Direct SP-initiated SAML entry. Going straight here skips the sign-in page
// and its "Sign In" button: when AAD/SSO is cached the chain completes
// silently and lands on the portal. Verified live 2026-08-23 — 302s to
// pfedprod `/idp/SSO.saml2` exactly as the old host did.
//
// RelayState is TENANT-RELATIVE (`/platform/portal`, not
// `/walmart-usa/platform/portal`) — the server re-prefixes it itself.
export const APPRISS_HOME = `${APPRISS_BASE}/secure/sso/saml2?RelayState=/platform/portal`;

// Sign-in-page detection. The new host renamed the page: `/secure/cpf/auth/logon`
// 302s to `/walmart-usa/signin`. Callers that only tested for `logon`/`login`
// read that page as "signed in" — which is worse than reading it as signed out,
// because it makes a failed reauth report success.
export const isApprissSignInUrl = (url) =>
  /\/(logon|login|signin)\b/i.test(url ?? "");
