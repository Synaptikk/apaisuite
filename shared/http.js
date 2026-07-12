// shared/http.js
//
// HTTP helpers — stub in Phase 1. Generalized from AurorBuddy's
// lib/appriss_http.js in Phase 4, once a second consumer exists.
//
// Planned signature:
//   postJson(url, body, {
//     headers, label, signal, timeout = 90_000,
//     retries: { rateLimit: 3, server: 2, transient: 2 },
//     isTransientResponse: (payload) => bool,
//     isAuthWall: (response, text) => bool,
//   }) => data | null
//
// For now, modules that need bespoke HTTP behavior (AurorBuddy) keep their
// own implementation in modules/<id>/lib/. This file is the future home of
// the shared version.

export function createHttp(/* moduleId */) {
  return {
    postJson: async (...args) => stub("postJson", args),
    getJson:  async (...args) => stub("getJson", args),
  };
}

function stub(name, _args) {
  throw new Error(
    `[APAISuite http] ${name} not yet implemented — generalized from ` +
    `AurorBuddy's appriss_http.js during Phase 4 consolidation.`
  );
}
