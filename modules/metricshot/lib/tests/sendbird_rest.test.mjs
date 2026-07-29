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

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";
  const auth = opts.headers && opts.headers["Session-key"];
  const ok = (obj, status = 200) => ({ ok: true, status, json: async () => obj, text: async () => JSON.stringify(obj) });
  const err = (status, obj = {}) => ({ ok: false, status, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (!auth) return err(401, { message: "no key" });
  if (url.includes("/my_group_channels")) return ok({ channels, next: "" });
  if (url.endsWith("/group_channels") && method === "POST") {
    created = true;
    const ch = { name: "MetricShot (me)", channel_url: "gc_self", members: [{ user_id: "2500686797" }] };
    channels.push(ch);
    return ok(ch);
  }
  if (url.includes("/messages") && method === "POST") {
    return ok({ message_id: 5850000000, message: "posted" });
  }
  return err(404, { message: "unmatched " + url });
};

// ── Run tests ────────────────────────────────────────────────────────────
function assert(cond, label) { console.log((cond ? "PASS" : "FAIL") + " — " + label); if (!cond) process.exitCode = 1; }

const r1 = await T.IN_PAGE_SB({ action: "resolve", channelName: "1458 Leadership" });
assert(r1.ok && r1.channelUrl === "gc_lead", "resolve named channel");

const r2 = await T.IN_PAGE_SB({ action: "resolve", channelName: "Nonexistent" });
assert(!r2.ok && r2.errorClass === "NOT_FOUND", "resolve missing channel → NOT_FOUND");

const r3 = await T.IN_PAGE_SB({ action: "text", channelName: "1458 Leadership", text: "hi" });
assert(r3.ok && r3.messageId === "5850000000", "post text to named channel");

const r4 = await T.IN_PAGE_SB({ action: "text", channelName: "@me", text: "self note" });
assert(r4.ok && r4.channelUrl === "gc_self" && created, "post text to @me (auto-create self)");

const r5 = await T.IN_PAGE_SB({ action: "file", channelName: "@me", pngBase64: Buffer.from("PNGDATA").toString("base64"), fileName: "s.png", caption: "cap" });
assert(r5.ok && r5.messageId === "5850000000", "post file to @me");

// No-creds case: creds are read fresh from window on each call, so nulling the
// global mid-run is enough to exercise the NO_SESSION guard.
globalThis.__APAISUITE_METRICSHOT_SBKEY = null;
const r6 = await T.IN_PAGE_SB({ action: "text", channelName: "@me", text: "x" });
assert(!r6.ok && r6.errorClass === "NO_SESSION", "no session-key → NO_SESSION");

console.log("done");
