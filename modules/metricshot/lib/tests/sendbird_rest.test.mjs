// Extract the in-page REST worker (IN_PAGE_SB) from sendbird.js and exercise
// it against a mock Sendbird REST API + mock config endpoint + mock WS
// handshake to validate the new (no-sniffer) auth flow end-to-end.
import fs from "fs";

const src = fs.readFileSync("modules/metricshot/lib/sendbird.js", "utf8");

// IN_PAGE_SB is not exported (it's shipped into the page via chrome.scripting),
// so re-derive it by eval'ing the module tail from the first `const` onward.
const start = src.indexOf("const WORKVIVO_URL");
let body = src.slice(start);
body = body.replace(/^export\s+/gm, "");
body += "\nglobalThis.__T = { IN_PAGE_SB, IN_PAGE_READ_CREDS, IN_PAGE_INTROSPECT };";

eval(body);
const T = globalThis.__T;

// ── Mock page environment ────────────────────────────────────────────────
globalThis.location = { href: "https://workvivo.walmart.com/chat" };
globalThis.document = { cookie: "XSRF-TOKEN=xsrf-abc; other=1" };
globalThis.v2 = { id: 2500686797, chatConfig: { app_id: "APPID", access_token: "ACCESS_TOK" } };
globalThis.atob = (b) => Buffer.from(b, "base64").toString("binary");
globalThis.Blob = class { constructor(p, o) { this.parts = p; this.type = o?.type; } };
globalThis.FormData = class { constructor() { this.d = {}; } append(k, v, n) { this.d[k] = n ? { name: n } : v; } };

// Mock Sendbird WebSocket: immediately emits a LOGI frame carrying the key.
let wsShouldFail = false;
globalThis.WebSocket = class {
  constructor(url) {
    this.url = url;
    setTimeout(() => {
      if (wsShouldFail) { this.onerror && this.onerror(new Error("ws fail")); return; }
      // access_token must be present in the URL (that's what mints the key).
      const hasToken = /access_token=ACCESS_TOK/.test(url);
      const key = hasToken ? "SESSIONKEY123" : "";
      this.onmessage && this.onmessage({ data: "LOGI" + JSON.stringify({ key, ekey: "e", user_id: "2500686797" }) });
    }, 0);
  }
  close() {}
};

let channels = [
  { name: "1458 Leadership", channel_url: "gc_lead", members: [{ user_id: "1" }, { user_id: "2500686797" }] },
];
let created = false;
let configShouldFail = false;

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";
  const ok = (obj, status = 200) => ({ ok: true, status, headers: { get: () => "application/json" }, json: async () => obj, text: async () => JSON.stringify(obj) });
  const err = (status, obj = {}) => ({ ok: false, status, headers: { get: () => "application/json" }, json: async () => obj, text: async () => JSON.stringify(obj) });

  // Workvivo config endpoint (Laravel).
  if (url.includes("/api/chat/config")) {
    if (configShouldFail) return err(401, { message: "Unauthenticated." });
    return ok({ app_id: "APPID", access_token: "ACCESS_TOK" });
  }

  // Everything else is the Sendbird REST API — requires our minted session key.
  const auth = opts.headers && opts.headers["Session-key"];
  if (auth !== "SESSIONKEY123") return err(401, { message: "bad key" });
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
assert(r1.ok && r1.channelUrl === "gc_lead", "resolve named channel (config→ws→rest)");

const r2 = await T.IN_PAGE_SB({ action: "resolve", channelName: "Nonexistent" });
assert(!r2.ok && r2.errorClass === "NOT_FOUND", "resolve missing channel → NOT_FOUND");

const r3 = await T.IN_PAGE_SB({ action: "text", channelName: "1458 Leadership", text: "hi" });
assert(r3.ok && r3.messageId === "5850000000", "post text to named channel");

const r4 = await T.IN_PAGE_SB({ action: "text", channelName: "@me", text: "self note" });
assert(r4.ok && r4.channelUrl === "gc_self" && created, "post text to @me (auto-create self)");

const r5 = await T.IN_PAGE_SB({ action: "file", channelName: "@me", pngBase64: Buffer.from("PNGDATA").toString("base64"), fileName: "s.png", caption: "cap" });
assert(!r5.ok && r5.errorClass === "INPUT", "file action removed from REST worker (images go via UI upload)");

// Config failure → NO_SESSION (no window.v2.chatConfig fallback either).
configShouldFail = true;
const savedCfg = globalThis.v2.chatConfig;
globalThis.v2.chatConfig = null;
const r6 = await T.IN_PAGE_SB({ action: "text", channelName: "@me", text: "x" });
assert(!r6.ok && r6.errorClass === "NO_SESSION", "config unavailable → NO_SESSION");
globalThis.v2.chatConfig = savedCfg;
configShouldFail = false;

// WS handshake failure → NO_SESSION.
wsShouldFail = true;
const r7 = await T.IN_PAGE_SB({ action: "text", channelName: "@me", text: "x" });
assert(!r7.ok && r7.errorClass === "NO_SESSION", "ws mint failure → NO_SESSION");
wsShouldFail = false;

// READ_CREDS returns appId/userId when signed in.
const rc = T.IN_PAGE_READ_CREDS();
assert(rc && rc.appId === "APPID" && rc.userId === "2500686797", "READ_CREDS reports signed-in state");

console.log("done");
