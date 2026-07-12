// modules/aurorbuddy/lib/firestore_config.js
//
// Firebase project identifiers used by lib/firestore.js.
//
// These are NOT secrets. The projectId identifies which database to talk to;
// the apiKey is the public Web API key Firebase SDKs ship in their
// initializeApp() snippet. Access is enforced server-side by Firestore
// security rules (see docs/BACKEND_MIGRATION_PLAN.md), so embedding these
// in the extension is fine and standard.
//
// Project is shared with the shanesmith deployment so dashboard rollups
// at https://aurorbuddy.firebaseapp.com pick up suite writes alongside
// any remaining legacy shanesmith installs. See BACKEND_MIGRATION_PLAN.md
// for the cutover ordering.

export const FIREBASE_CONFIG = {
  projectId: "aurorbuddy",
  webApiKey: "AIzaSyBVbIuRW8qSXS_CVhpkKGlwrt-AFWTrWnw",
};

// Identifies the source extension on every write so the dashboard can
// segregate suite-written rows from legacy shanesmith rows during the
// migration window (BACKEND_DATA_MODEL.md §4 — common header).
export const ANALYST_SOURCE = "suite";
