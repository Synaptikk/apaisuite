// modules/digitalmetrics/lib/config.js
//
// The ONLY place a backend identity is named. Phase 3 (backend migration) is a
// diff to this file plus a rules/index deploy — nothing else in the module
// should ever mention a project id, an api key, or a host.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ Provisioned 2026-08-25. The legacy standalone project                │
// │ (digitalmetrics-fe0f3) is no longer referenced anywhere and its data │
// │ was deliberately NOT migrated — this database starts empty.          │
// │                                                                      │
// │ One project, one database per module. `apaisuite` also holds the     │
// │ (default) database with suite-wide telemetry; this module gets its   │
// │ own named database so a rules mistake in one cannot reach the other, │
// │ and so `stores` here can never collide with a future module's        │
// │ `stores`. Anonymous auth is per PROJECT, so both databases share one │
// │ Firebase identity and one token cache.                               │
// │                                                                      │
// │ Rules + indexes: modules/digitalmetrics/backend/, deployed from      │
// │ unified-extension-suite/backend/ — see the README there.             │
// └──────────────────────────────────────────────────────────────────────┘

export const BACKEND = {
  projectId: "apaisuite",

  // The module's own named database inside that project — NOT "(default)",
  // which holds suite-wide telemetry and whose rules deny everything else.
  // Pointing this at (default) would fail closed rather than corrupt anything,
  // but it would fail confusingly, so it is named here rather than inlined.
  databaseId: "digitalmetrics",

  // Public web apiKey. Not a secret — it identifies the project to Google's
  // REST endpoints and is safe in a client. It is NOT the name-encryption key;
  // that lives in crypto_config.js and is a different kind of thing entirely.
  apiKey: "AIzaSyAxRJ7qjWqm9XgGtNHr1hUyW8IJgcndj_s",

  get root() {
    return `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/${this.databaseId}/documents`;
  },
};

// Stamped on every document this module writes, so a later migration can tell
// suite-written rows from standalone-app-written rows without guessing.
// Mirrors the `analystSource` discriminator AurorBuddy uses.
export const WRITER_SOURCE = "suite";

// Bumped when the on-disk document shape changes. Readers use it to decide
// whether a row needs the legacy (plaintext-name) read path.
//   1 = legacy plaintext names, written by the standalone app
//   2 = tokenised + encrypted names, written by this module
export const SCHEMA_VERSION = 2;

// Kill switch. Set chrome.storage.sync["digitalmetrics.writerEnabled"] = false
// to stop all writes without uninstalling. Same escape hatch as aurorbuddy.
export const WRITER_ENABLED_KEY = "digitalmetrics.writerEnabled";
