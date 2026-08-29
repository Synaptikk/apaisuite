// shared/tests/suiteBackend.test.mjs
//
// Pins the suite's own Firestore client. Everything here is defending against
// a repeat of the bug it was written to fix: suite-wide telemetry wrote through
// aurorbuddy's client, which is pinned to the `aurorbuddy` project, while the
// rules for these collections deploy to `apaisuite`. Every write 403'd, the
// per-writer queues absorbed it, and the only outward sign was a repeating
// console error nobody had reason to read.
//
// What each assertion protects:
//   · the write URL names `apaisuite`, not any other project
//   · fields go up ENCODED ONCE — the caller passes a plain object
//   · a create is create-only, matching append-only rules
//   · one anonymous user per install: a cached refresh token is exchanged
//     rather than minting a fresh account on every cold worker
//   · a failed commit reports the server's reason, not a bare status

import test from "node:test";
import assert from "node:assert/strict";

// ── chrome stub ────────────────────────────────────────────────────────────
function installChrome() {
  const local = {}, session = {};
  const api = (bag) => ({
    get: async (k) => {
      const keys = Array.isArray(k) ? k : [k];
      const out = {};
      for (const key of keys) if (key in bag) out[key] = bag[key];
      return out;
    },
    set:    async (obj) => { Object.assign(bag, obj); },
    remove: async (k) => { for (const key of (Array.isArray(k) ? k : [k])) delete bag[key]; },
  });
  globalThis.chrome = { storage: { local: api(local), session: api(session) } };
  return { local, session };
}

// Records every fetch and replies from a queue of canned responses.
function installFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts, body: safeJson(opts.body) });
    const next = responses.shift() ?? { ok: true, status: 200, json: {} };
    return {
      ok:     next.ok !== false,
      status: next.status ?? 200,
      json:   async () => next.json ?? {},
      text:   async () => next.text ?? JSON.stringify(next.json ?? {}),
    };
  };
  return calls;
}

const safeJson = (b) => { try { return JSON.parse(b); } catch { return b; } };
const SIGNUP_OK  = { json: { idToken: "id-1", refreshToken: "rt-1" } };
const COMMIT_OK  = { json: { writeResults: [{}] } };

async function freshModule() {
  // Cache-bust so each test gets a module with no in-process state.
  return await import(`../suiteBackend.js?t=${Math.random()}`);
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("writes go to the apaisuite project, not aurorbuddy", async () => {
  installChrome();
  const calls = installFetch([SIGNUP_OK, COMMIT_OK]);
  const { commitCreateWithServerTimestamp } = await freshModule();

  await commitCreateWithServerTimestamp("suite_usage_events", "doc1", { a: 1 }, "timestamp");

  const commit = calls.find((c) => c.url.includes(":commit"));
  assert.ok(commit, "expected a :commit call");
  assert.match(commit.url, /projects\/apaisuite\/databases\/\(default\)/);
  // The whole point of the fix.
  assert.doesNotMatch(commit.url, /aurorbuddy/);
  assert.match(commit.body.writes[0].update.name, /projects\/apaisuite\//);
});

test("fields are encoded exactly once", async () => {
  installChrome();
  const calls = installFetch([SIGNUP_OK, COMMIT_OK]);
  const { commitCreateWithServerTimestamp } = await freshModule();

  await commitCreateWithServerTimestamp("c", "d", { name: "vizpick", count: 3 }, "timestamp");

  const fields = calls.find((c) => c.url.includes(":commit")).body.writes[0].update.fields;
  // Double encoding (the schema-drift caller used to pre-encode) turns each
  // value into { mapValue: { fields: { stringValue: ... } } } — accepted by
  // Firestore and stored as structurally wrong data.
  assert.deepEqual(fields.name, { stringValue: "vizpick" });
  assert.deepEqual(fields.count, { integerValue: "3" });
  assert.equal(fields.name.mapValue, undefined);
});

test("the timestamp field is server-stamped, not client-supplied", async () => {
  installChrome();
  const calls = installFetch([SIGNUP_OK, COMMIT_OK]);
  const { commitCreateWithServerTimestamp } = await freshModule();

  await commitCreateWithServerTimestamp("c", "d", { a: 1 }, "serverDetectedAt");

  const write = calls.find((c) => c.url.includes(":commit")).body.writes[0];
  assert.deepEqual(write.updateTransforms, [
    { fieldPath: "serverDetectedAt", setToServerValue: "REQUEST_TIME" },
  ]);
});

test("a create is create-only, matching the append-only rules", async () => {
  installChrome();
  const calls = installFetch([SIGNUP_OK, COMMIT_OK]);
  const { commitCreateWithServerTimestamp } = await freshModule();

  await commitCreateWithServerTimestamp("c", "d", { a: 1 }, "timestamp");

  const write = calls.find((c) => c.url.includes(":commit")).body.writes[0];
  assert.deepEqual(write.currentDocument, { exists: false });
});

test("a cached refresh token is exchanged instead of minting a new user", async () => {
  const { local } = installChrome();
  local["suite.fb_refreshToken"] = "rt-existing";
  const calls = installFetch([
    { json: { id_token: "id-2", refresh_token: "rt-2" } },
    COMMIT_OK,
  ]);
  const { commitCreateWithServerTimestamp } = await freshModule();

  await commitCreateWithServerTimestamp("c", "d", { a: 1 }, "timestamp");

  // Anonymous accounts accumulate in the project forever; one install must
  // keep one user across cold worker starts.
  assert.equal(calls.some((c) => c.url.includes("accounts:signUp")), false);
  assert.ok(calls[0].url.startsWith("https://securetoken.googleapis.com/"));
  assert.equal(local["suite.fb_refreshToken"], "rt-2", "rotated token is persisted");
});

test("a revoked refresh token falls back to a new anonymous sign-in", async () => {
  const { local } = installChrome();
  local["suite.fb_refreshToken"] = "rt-revoked";
  const calls = installFetch([
    { ok: false, status: 400, text: "TOKEN_EXPIRED" },
    SIGNUP_OK,
    COMMIT_OK,
  ]);
  const { commitCreateWithServerTimestamp } = await freshModule();

  await commitCreateWithServerTimestamp("c", "d", { a: 1 }, "timestamp");

  // Wedging telemetry permanently on a bad stored token would be worse.
  assert.ok(calls.some((c) => c.url.includes("accounts:signUp")));
  assert.equal(local["suite.fb_refreshToken"], "rt-1");
});

test("a cached id token skips auth entirely", async () => {
  const { session } = installChrome();
  session["suite.fb_idToken"]   = "id-cached";
  session["suite.fb_idTokenAt"] = Date.now();
  const calls = installFetch([COMMIT_OK]);
  const { commitCreateWithServerTimestamp } = await freshModule();

  await commitCreateWithServerTimestamp("c", "d", { a: 1 }, "timestamp");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.Authorization, "Bearer id-cached");
});

test("a failed commit carries the server's reason, not just a status", async () => {
  installChrome();
  installFetch([
    SIGNUP_OK,
    { ok: false, status: 403, text: '{"error":{"status":"PERMISSION_DENIED"}}' },
  ]);
  const { commitCreateWithServerTimestamp } = await freshModule();

  // A bare "403" cannot distinguish "rules deny this shape" from "rules were
  // never deployed to this project" — the ambiguity that hid the original bug.
  await assert.rejects(
    () => commitCreateWithServerTimestamp("c", "d", { a: 1 }, "timestamp"),
    /403.*PERMISSION_DENIED/s,
  );
});

test("a missing Anonymous provider says so", async () => {
  installChrome();
  installFetch([{ ok: false, status: 400, text: "ADMIN_ONLY_OPERATION" }]);
  const { commitCreateWithServerTimestamp } = await freshModule();

  // This is a manual console step the CLI cannot perform, so the error has to
  // name it or the next person re-derives it from a 400.
  await assert.rejects(
    () => commitCreateWithServerTimestamp("c", "d", { a: 1 }, "timestamp"),
    /Anonymous auth/i,
  );
});
