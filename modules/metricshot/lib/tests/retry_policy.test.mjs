// modules/metricshot/lib/tests/retry_policy.test.mjs
//
// Run with: node --test modules/metricshot/lib/tests/retry_policy.test.mjs
//
// Regression cover for the 2026-08-21 retry storm. The original rule was
// "never record a failure, let the next tick retry" — correct-sounding, and
// catastrophic at a 1-minute tick with no attempt counter: one scheduled
// screenshot became ~39 captures over 65 minutes, each holding a Tableau tab
// for a 90s watchdog. The staleness window was the only thing that stopped it.
//
// The first test below is the storm itself, simulated minute by minute.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runDecision, failureEntry, backoffFor,
  RETRY_BACKOFF_MS, MAX_RUN_FAILURES,
} from "../retry_policy.js";

const MIN = 60_000;

test("a permanently-failing run is bounded, not unbounded", () => {
  // Simulate the real loop: tick every minute for 65 minutes, and whenever
  // the policy says "run", burn 4.5 min of attempts and record the failure.
  let entry;
  let runs = 0;
  let now = 0;
  const RUN_COST = 4.5 * MIN;

  while (now < 65 * MIN) {
    const d = runDecision(entry, now);
    if (d.run) {
      runs++;
      now += RUN_COST;
      entry = failureEntry(entry, now, { stage: "capture", error: "hung" });
    } else {
      now += MIN;
    }
  }

  assert.equal(runs, MAX_RUN_FAILURES,
    "must stop after MAX_RUN_FAILURES runs — the old behaviour ran ~13 times in this window");
  assert.equal(runDecision(entry, 65 * MIN).reason, "gave-up");
});

test("backoff grows and then holds at the last step", () => {
  assert.equal(backoffFor(1), RETRY_BACKOFF_MS[0]);
  assert.equal(backoffFor(2), RETRY_BACKOFF_MS[1]);
  assert.equal(backoffFor(3), RETRY_BACKOFF_MS[2]);
  assert.equal(backoffFor(99), RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
  // Guards against an off-by-one that would index [-1] and return undefined.
  assert.equal(backoffFor(0), RETRY_BACKOFF_MS[0]);
});

test("a run that has never been attempted always runs", () => {
  assert.deepEqual(runDecision(undefined, 0), { run: true, reason: "never-run" });
});

test("success and skipped-stale are terminal", () => {
  for (const status of ["ok", "skipped-stale"]) {
    const d = runDecision({ status }, Date.now());
    assert.equal(d.run, false, `${status} must not re-run`);
    assert.equal(d.reason, "already-posted");
  }
});

test("inside the backoff window it waits; on the boundary it runs", () => {
  const at = 1_000_000;
  const e = failureEntry(undefined, at, {});
  assert.equal(e.failures, 1);
  assert.equal(e.gaveUp, false);

  assert.equal(runDecision(e, at + 1).reason, "backoff");
  assert.equal(runDecision(e, e.nextRetryAt - 1).reason, "backoff");
  assert.equal(runDecision(e, e.nextRetryAt).run, true, "boundary is inclusive");
});

test("failure counts accumulate across runs", () => {
  let e;
  for (let i = 1; i <= 3; i++) {
    e = failureEntry(e, i * 1000, { stage: "capture", error: "hung" });
    assert.equal(e.failures, i);
  }
  assert.equal(e.gaveUp, true);
});

test("nextRetryAt is recorded even on the final failure", () => {
  // So the give-up is legible in storage rather than implied by a hole.
  const e = failureEntry({ failures: MAX_RUN_FAILURES - 1 }, 500, {});
  assert.equal(e.gaveUp, true);
  assert.ok(e.nextRetryAt > 500);
});

test("a stale-marked entry beats a pending backoff", () => {
  // tick() marks stale BEFORE consulting the policy, but if the two ever
  // disagree the terminal state must win — a stale slot should never post.
  assert.equal(runDecision({ status: "skipped-stale", nextRetryAt: 0 }, 10).run, false);
});

test("failure entries carry the diagnosis forward", () => {
  const e = failureEntry(undefined, 1, { stage: "capture", error: "capture hung > 90s" });
  assert.equal(e.stage, "capture");
  assert.equal(e.error, "capture hung > 90s");
  // And tolerate a status object with neither field.
  const bare = failureEntry(undefined, 1, {});
  assert.equal(bare.stage, null);
  assert.equal(bare.error, null);
});

// ── Post-once statuses (2026-10-24: duplicate scheduled posts across installs) ──

import { SENDING_STALE_MS, sendingEntry, postOutcomeUnknown } from "../retry_policy.js";

test("skipped-claimed is terminal, like ok", () => {
  const d = runDecision({ status: "skipped-claimed", at: 0, owner: "other" }, 10 * 60 * MIN);
  assert.equal(d.run, false);
  assert.equal(d.reason, "claimed-elsewhere");
});

test("skipped-store is terminal", () => {
  assert.equal(runDecision({ status: "skipped-store", at: 0 }, 60 * MIN).run, false);
});

test("a young 'sending' entry is in flight; an old one resumes", () => {
  const e = sendingEntry(undefined, 0, "cid");
  assert.deepEqual(runDecision(e, SENDING_STALE_MS - 1), { run: false, reason: "in-flight" });
  assert.deepEqual(runDecision(e, SENDING_STALE_MS + 1), { run: true, reason: "resume" });
});

test("a resumable 'sending' still honours the give-up ceiling", () => {
  const e = sendingEntry({ status: "failed", failures: MAX_RUN_FAILURES }, 0);
  assert.equal(runDecision(e, SENDING_STALE_MS + 1).reason, "gave-up");
});

test("sendingEntry keeps the failure count and delivered parts", () => {
  const prior = failureEntry({ failures: 1 }, 0, { stage: "post" });
  const e = sendingEntry({ ...prior, parts: { email: 5 } }, 10, "cid");
  assert.equal(e.status, "sending");
  assert.equal(e.failures, 2);
  assert.deepEqual(e.parts, { email: 5 });
  assert.equal(e.claimId, "cid");
  assert.equal(failureEntry(e, 20, {}).failures, 3, "failure after a sending entry keeps counting");
  assert.equal(sendingEntry({ status: "sending", at: 0 }, 1).resumed, true);
});

test("postOutcomeUnknown: watchdog / 5xx / threw are unknown; 4xx and pre-create failures are not", () => {
  assert.equal(postOutcomeUnknown({ ok: true }), false);
  assert.equal(postOutcomeUnknown({ ok: false, errorClass: "POST_HUNG" }), true);
  assert.equal(postOutcomeUnknown({ ok: false, errorClass: "SCRIPT_FAIL" }), true);
  assert.equal(postOutcomeUnknown({ ok: false, errorClass: "POST_FAIL", error: "message create threw: x" }), true);
  assert.equal(postOutcomeUnknown({ ok: false, errorClass: "POST_FAIL", error: "message create HTTP 502: x" }), true);
  assert.equal(postOutcomeUnknown({ ok: false, errorClass: "POST_FAIL", error: "message create HTTP 422: x" }), false);
  assert.equal(postOutcomeUnknown({ ok: false, errorClass: "REST_FAIL", error: "post 500: oops" }), true);
  assert.equal(postOutcomeUnknown({ ok: false, errorClass: "REST_FAIL", error: "post 400: bad" }), false);
  for (const cls of ["AUTH", "NOT_FOUND", "INPUT", "NO_CSRF", "S3_SIG_FAIL", "S3_UPLOAD_FAIL", "NO_TAB", "NO_SESSION"]) {
    assert.equal(postOutcomeUnknown({ ok: false, errorClass: cls, error: "x" }), false, cls);
  }
});
