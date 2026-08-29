// dev/save-diagnose.mjs
//
// Why does the Assignments tab say "save failed"?
//
//   node dev/save-diagnose.mjs [--id=<extension id>]
//
// READ-ONLY. It never writes an assignment document. The write path is
// exercised only as far as encode + the plaintext-name assertion, which run
// on-device; the only Firestore call it makes is a GET.
//
// saveAssignments() shows "save failed" only when call() returns null, and
// call() returns null only when the handler THREW — a returned {ok:false} gets
// wrapped as {ok:true,data:{ok:false}} and read as success. So the question is
// narrow: which of these throws?
//
//   · encodeAssignments -> identify() -> crypto   (placeholder master key)
//   · assertNoPlaintextNames                      (a name leaked into the doc)
//   · request()                                   (Firestore auth / rules)
//
// It attaches to a suite page the user already has open, over a raw CDP
// session: puppeteer's page abstraction does not surface extension pages, and
// Target.createTarget is refused in this browser context, so neither is used.

import puppeteer from "puppeteer-core";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const WANT = arg("id");

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const targets = browser.targets().filter((t) =>
  t.type() === "page" && t.url().startsWith("chrome-extension://") && t.url().includes("app.html"));

if (!targets.length) {
  console.error("no open suite page — open app.html in the debug browser first.");
  process.exit(1);
}
const target = targets.find((t) => !WANT || new URL(t.url()).host === WANT) || targets[0];
const extId = new URL(target.url()).host;
console.log(`attached to: ${target.url()}\n`);

const cdp = await target.createCDPSession();

// Runtime.evaluate with no contextId does not reliably land in an extension
// page's MAIN world — it came back with `chrome` undefined and module imports
// failing, which is the signature of an isolated world, not of a broken page.
// Enable Runtime and take the context flagged isDefault.
let ctxId = null;
cdp.on("Runtime.executionContextCreated", ({ context }) => {
  if (context?.auxData?.isDefault && ctxId === null) ctxId = context.id;
});
await cdp.send("Runtime.enable");
await new Promise((r) => setTimeout(r, 400));
console.log(ctxId === null ? "  (no default context reported; using implicit)" : `  default execution context: ${ctxId}`);
const evaluate = async (expression) => {
  const opts = { expression, awaitPromise: true, returnByValue: true };
  if (ctxId !== null) opts.contextId = ctxId;
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", opts);
  if (exceptionDetails) return { __threw: exceptionDetails.exception?.description || exceptionDetails.text };
  return result.value;
};
const show = (label, v) =>
  console.log(`${label}\n  ${typeof v === "string" ? v : JSON.stringify(v, null, 2).replace(/\n/g, "\n  ")}\n`);

// 1. Writer switch. Would not itself produce "save failed" (it returns rather
//    than throws) but it changes what the fix is, so rule it in or out.
show("writer flag (sync storage):", await evaluate(`(async () => {
  const all = await chrome.storage.sync.get(null);
  const keys = Object.keys(all).filter(k => /writer|enabled/i.test(k));
  return keys.length ? Object.fromEntries(keys.map(k => [k, all[k]])) : "none set - writer defaults ON";
})()`));

// 2. Crypto. A placeholder master key makes identify() throw, which surfaces
//    as exactly this failure.
show("crypto identify():", await evaluate(`(async () => {
  try {
    const m = await import("chrome-extension://${extId}/modules/digitalmetrics/lib/crypto.js");
    const fn = m.identify || m.tokenFor;
    if (!fn) return { ok: false, why: "no identify export", exports: Object.keys(m) };
    const out = await fn("TEST ASSOCIATE");
    return { ok: true, fields: Object.keys(out || {}), tokenLen: String(out?.t ?? "").length };
  } catch (e) { return { ok: false, threw: String(e?.message ?? e) }; }
})()`));

// 3. Read back through the same auth + rules path the write uses.
show("read via get_assignments (same auth/rules path):", await evaluate(`(async () => {
  const send = (type, payload) => new Promise(res => {
    chrome.runtime.sendMessage({ module: "digitalmetrics", type, ...payload }, r =>
      res(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r));
  });
  const st = await send("get_stores", {});
  const store = String((st?.data?.stores || st?.data || ["1458"])[0] ?? "1458");
  const date = new Date().toISOString().slice(0, 10);
  const got = await send("get_assignments", { store, date });
  return { store, date, envelopeOk: got?.ok ?? null, envelopeError: got?.error ?? null, gotDoc: !!got?.data };
})()`));

// 4. Exercise the ENCODE half of the write, without writing. This is where
//    assertNoPlaintextNames fires if a name leaked into the document.
show("encode an assignments doc (no write):", await evaluate(`(async () => {
  try {
    const codec = await import("chrome-extension://${extId}/modules/digitalmetrics/lib/codec.js");
    const doc = {
      associates: { "TEST ASSOCIATE": { slots: { 0: "PICK" }, status: "present", shiftStart: 0, shiftEnd: 4 } },
      date: "2026-08-26", day: "WED", updatedAt: new Date().toISOString(),
      store: "1458", finalized: false, finalizedAt: null,
    };
    const enc = await codec.encodeAssignments(doc);
    return { encoded: true, topLevel: Object.keys(enc),
             rosterEntries: Object.keys(enc.associates || {}).length,
             sampleKeyLooksTokenised: !/[A-Z]{3,}\\s+[A-Z]{3,}/.test(Object.keys(enc.associates || {})[0] || "") };
  } catch (e) { return { encoded: false, threw: String(e?.message ?? e) }; }
})()`));

// 5. What the page is showing right now — the pill says "save failed", but the
//    status line carries the actual message from call().
show("current on-screen status:", await evaluate(`(() => ({
  savePill: document.querySelector("#dm-asg-save")?.textContent?.trim() ?? null,
  status: [...document.querySelectorAll(".dm-status, .dm-status-group, .status-strip, .dm-toast")]
    .map(e => e.textContent.trim()).filter(Boolean).slice(0, 4),
}))()`));

await cdp.detach().catch(() => {});
browser.disconnect();
