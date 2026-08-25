// modules/digitalmetrics/lib/config.js
//
// The ONLY place a backend identity is named. Phase 3 (backend migration) is a
// diff to this file plus a rules/index deploy — nothing else in the module
// should ever mention a project id, an api key, or a host.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ INTERIM TARGET — NOT the project this module will ship against.      │
// │                                                                      │
// │ The migrated version uses a different Firebase project, not yet      │
// │ provisioned. This points at the legacy standalone project purely so  │
// │ the port can be built and exercised against real data.               │
// │                                                                      │
// │ Consequence worth planning around: anything this module WRITES here  │
// │ before the real project exists has to be migrated twice. Prefer      │
// │ read-only use of the legacy project until the target is known —      │
// │ see WRITER_ENABLED_KEY below, which turns writes off wholesale.      │
// └──────────────────────────────────────────────────────────────────────┘

export const BACKEND = {
  // INTERIM. Swap this (and apiKey) for the real project — it is the only
  // place either value appears anywhere in the module.
  projectId: "digitalmetrics-fe0f3",

  // Public web apiKey. Not a secret — it identifies the project to Google's
  // REST endpoints and is safe in a client. It is NOT the name-encryption key;
  // that lives in crypto_config.js and is a different kind of thing entirely.
  apiKey: "AIzaSyCHPePjy-jHsFnywlp3U8_zJy6r_zsC7GA",

  get root() {
    return `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents`;
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
