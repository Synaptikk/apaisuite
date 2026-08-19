// Extract the in-page REST worker (IN_PAGE_SB) from sendbird.js and exercise
// it against a mock Sendbird REST API to validate the flow end-to-end.
import fs from "fs";

const src = fs.readFileSync("modules/metricshot/lib/sendbird.js", "utf8");

// IN_PAGE_SB is not exported (it's shipped into the page via chrome.scripting),
// so re-derive it by eval'ing the module tail from 'const SBKEY_GLOBAL' onward.
const start = src.indexOf("const SBKEY_GLOBAL");
let body = src.slice(start);
body = body.replace(/^export\s+/gm, "");
body += "\nglobalThis.__T = { IN_PAGE_SB, IN_PAGE_READ_CREDS, IN_PAGE_INTROSPECT };";

eval(body);
const T = globalThis.__T;

// ── Mock page environment ────────────────────────────────────────────────
globalThis.location = { href: "https://workvivo.walmart.com/chat" };
globalThis.__APAISUITE_METRICSHOT_SBKEY = { sessionKey: "KEY123", appId: "APPID", userId: "2500686797", ts: Date.now() };
globalThis.__APAISUITE_METRICSHOT_SBKEY_INSTALLED = true;
globalThis.v2 = { id: 2500686797, chatConfig: { app_id: "APPID" } };
globalThis.atob = (b) => Buffer.from(b, "base64").toString("binary");
globalThis.Blob = class { constructor(p, o) { this.parts = p; this.type = o?.type; } };
globalThis.FormData = class { constructor() { this.d = {}; } append(k, v, n) { this.d[k] = n ? { name: n } : v; } };

let channels = [
  { name: "1458 Leadership", channel_url: "gc_lead", members: [{ user_id: "1" }, { user_id: "2500686797" }] },
];
let created = false;

// Test-controlled mock behaviour.
let calls = [];          // every request seen since the last reset
let rotateArmed = false; // next message POST 401s and rotates the sniffer key
let floodChannels = false; // channel list never ends, to exercise the page cap

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";
  const h = opts.headers || {};
  calls.push({ url, method, headers: h, body: opts.body });
  const auth = h["Session-key"];
  const ok = (obj, status = 200) => ({ ok: true, status, json: async () => obj, text: async () => JSON.stringify(obj) });
  const err = (status, obj = {}) => ({ ok: false, status, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (!auth) return err(401, { message: "no key" });
  if (url.includes("/my_group_channels")) {
    if (floodChannels) {
      const page = Array.from({ length: 100 }, (_, i) => ({ name: "ch" + i, channel_url: "gc" + i, members: [] }));
      return ok({ channels: page, next: "more" });
    }
    return ok({ channels, next: "" });
  }
  if (url.endsWith("/group_channels") && method === "POST") {
    created = true;
    const ch = { name: "MetricShot (me)", channel_url: "gc_self", members: [{ user_id: "2500686797" }] };
    channels.push(ch);
    return ok(ch);
  }
  if (url.includes("/messages") && method === "POST") {
    // Simulate the Session-key rotating out from under an in-flight post: the
    // SDK refreshes its key, so the sniffer global carries a newer one.
    if (rotateArmed && auth === "KEY123") {
      rotateArmed = false;
      globalThis.__APAISUITE_METRICSHOT_SBKEY = { sessionKey: "KEY456", appId: "APPID", userId: "2500686797", ts: Date.now() };
      return err(401, { message: "session key expired" });
    }
    return ok({ message_id: 5850000000, message: "posted" });
  }
  return err(404, { message: "unmatched " + url });
};

// ── Run tests ────────────────────────────────────────────────────────────
function assert(cond, label) { console.log((cond ? "PASS" : "FAIL") + " — " + label); if (!cond) process.exitCode = 1; }

// The header recipe below is what makes Sendbird accept these calls at all
// (see the module header in sendbird.js). Assert it on every request, or a
// regression that drops one header sails through the rest of the suite.
function assertRecipe(label, expectedKey = "KEY123") {
  const bad = calls.filter((r) =>
    r.headers["Session-key"] !== expectedKey ||
    r.headers["App-Id"] !== "APPID" ||
    r.headers["SendBird"] !== "JS,web,4.22.0,APPID" ||
    r.headers["SB-User-Agent"] !== "JS/c4.22.0///oweb");
  assert(calls.length > 0 && bad.length === 0, label + " (" + calls.length + " requests)");
}
function reset() { calls = []; }

reset();
const r1 = await T.IN_PAGE_SB({ action: "resolve", channelName: "1458 Leadership" });
assert(r1.ok && r1.channelUrl === "gc_lead", "resolve named channel");
assertRecipe("resolve sends the full header recipe");

reset();
const r2 = await T.IN_PAGE_SB({ action: "resolve", channelName: "Nonexistent" });
assert(!r2.ok && r2.errorClass === "NOT_FOUND", "resolve missing channel → NOT_FOUND");

reset();
const r3 = await T.IN_PAGE_SB({ action: "text", channelName: "1458 Leadership", text: "hi" });
assert(r3.ok && r3.messageId === "5850000000", "post text to named channel");
assertRecipe("text post sends the full header recipe");
const textPost = calls.find((r) => r.url.includes("/messages"));
assert(textPost.headers["Content-Type"] === "application/json; charset=utf-8", "text post sets JSON Content-Type");
assert(JSON.parse(textPost.body).message_type === "MESG", "text post body is a MESG");
assert(JSON.parse(textPost.body).user_id === "2500686797", "text post attributes to the sniffed user");

reset();
const r4 = await T.IN_PAGE_SB({ action: "text", channelName: "@me", text: "self note" });
assert(r4.ok && r4.channelUrl === "gc_self" && created, "post text to @me (auto-create self)");

reset();
const r5 = await T.IN_PAGE_SB({ action: "file", channelName: "@me", pngBase64: Buffer.from("PNGDATA").toString("base64"), fileName: "s.png", caption: "cap" });
assert(r5.ok && r5.messageId === "5850000000", "post file to @me");
assertRecipe("file post sends the full header recipe");
const filePost = calls.find((r) => r.url.includes("/messages"));
assert(!("Content-Type" in filePost.headers), "file post omits Content-Type so the browser sets the multipart boundary");

// A key that rotates mid-post must not lose the message: sbFetch picks up the
// newer key from the sniffer and replays the request once.
reset();
rotateArmed = true;
const r7 = await T.IN_PAGE_SB({ action: "text", channelName: "1458 Leadership", text: "after rotation" });
assert(r7.ok && r7.messageId === "5850000000", "401 mid-post → replays with the rotated key");
const replay = calls.filter((r) => r.url.includes("/messages"));
assert(replay.length === 2, "rotation replay sends the message exactly twice");
assert(replay[0].headers["Session-key"] === "KEY123" && replay[1].headers["Session-key"] === "KEY456",
  "replay carries the rotated key, not the stale one");

// Restore the baseline key for the remaining cases.
globalThis.__APAISUITE_METRICSHOT_SBKEY = { sessionKey: "KEY123", appId: "APPID", userId: "2500686797", ts: Date.now() };

// A 401 with no newer key available must surface, not spin.
reset();
rotateArmed = false;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes("/messages") && (opts.method || "GET") === "POST") {
    calls.push({ url, method: "POST", headers: opts.headers || {} });
    return { ok: false, status: 401, json: async () => ({ message: "expired" }), text: async () => "{}" };
  }
  return origFetch(url, opts);
};
const r8 = await T.IN_PAGE_SB({ action: "text", channelName: "1458 Leadership", text: "doomed" });
assert(!r8.ok && r8.errorClass === "AUTH", "401 with no rotation available → AUTH");
assert(calls.filter((r) => r.url.includes("/messages")).length === 1, "no newer key → does not replay");
assert(typeof r8.keyAgeMs === "number", "auth failure reports key age for diagnosis");
globalThis.fetch = origFetch;

// Hitting the pagination cap must not masquerade as "you aren't in that channel".
reset();
floodChannels = true;
const r9 = await T.IN_PAGE_SB({ action: "resolve", channelName: "Nonexistent" });
assert(!r9.ok && r9.errorClass !== "NOT_FOUND", "truncated channel list → not reported as NOT_FOUND");
assert(/first 1000/.test(r9.error), "truncated channel list error names the cap");
floodChannels = false;

// No-creds case: creds are read fresh from window on each call, so nulling the
// global mid-run is enough to exercise the NO_SESSION guard.
globalThis.__APAISUITE_METRICSHOT_SBKEY = null;
const r6 = await T.IN_PAGE_SB({ action: "text", channelName: "@me", text: "x" });
assert(!r6.ok && r6.errorClass === "NO_SESSION", "no session-key → NO_SESSION");

console.log("done");
