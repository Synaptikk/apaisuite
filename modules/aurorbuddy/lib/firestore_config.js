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

// ── Cutover switch ───────────────────────────────────────────────────────
// These three values are the ONLY thing tying this module to a Firebase
// project. `(default)` used to be hardcoded in seven places across two
// files, which would have made the migration a scatter of edits instead of
// one reviewable line.
//
// Migrating to the apaisuite project means:
//     projectId:  "apaisuite"
//     databaseId: "aurorbuddy"        (a NAMED database, as digitalmetrics is)
//     webApiKey:  <apaisuite web key>
//
// Do NOT flip these before the data is copied and the rules are deployed:
// the module would start writing into an empty database while the
// dashboard still reads the old one.
export const FIREBASE_CONFIG = {
  projectId:  "aurorbuddy",
  databaseId: "(default)",
  webApiKey:  "AIzaSyBVbIuRW8qSXS_CVhpkKGlwrt-AFWTrWnw",
};

// Identifies the source extension on every write so the dashboard can
// segregate suite-written rows from legacy shanesmith rows during the
// migration window (BACKEND_DATA_MODEL.md §4 — common header).
export const ANALYST_SOURCE = "suite";
