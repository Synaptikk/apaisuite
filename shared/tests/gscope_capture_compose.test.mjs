// shared/tests/gscope_capture_compose.test.mjs
//
// Run with: node --test shared/tests/gscope_capture_compose.test.mjs
//
// Three MAIN-world content scripts patch fetch/XHR on gscope.walmartlabs.com
// (sparkrisk, digitallocks, sparkfraud). They must compose: every one of
// them has to see every request no matter which ran first. On 2026-08-20
// sparkrisk's script replaced the XMLHttpRequest constructor, sparkfraud's
// prototype patch landed on the wrapper's empty prototype, and SparkFraud's
// item lookup silently captured nothing for two weeks. This test runs the
// real scripts against a fake window in both orders and checks both buffers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPARKRISK  = readFileSync(join(ROOT, "modules/sparkrisk/content/capture.js"), "utf8");
const SPARKFRAUD = readFileSync(join(ROOT, "modules/sparkfraud/content/capture.js"), "utf8");

// The smallest window that lets the scripts install: a real-looking XHR
// class with prototype methods, a fetch, Headers, and HTMLIFrameElement
// with a contentWindow getter.
function makeWindow() {
  class FakeXHR {
    static get DONE() { return 4; }
    open(method, url) { this._method = method; this._url = url; this._headers = {}; }
    setRequestHeader(k, v) { this._headers[k] = v; }
    send(body) { this._body = body; }
    // Several scripts each add their own "load" listener — keep them all,
    // like the real thing does.
    addEventListener(type, fn) { ((this._listeners ||= {})[type] ||= []).push(fn); }
    fire(type) { for (const fn of this._listeners?.[type] || []) fn.call(this); }
  }
  class FakeHeaders {
    constructor(init) { this._m = new Map(Object.entries(init || {})); }
    entries() { return this._m.entries(); }
    forEach(fn) { for (const [k, v] of this._m) fn(v, k); }
  }
  const fetchCalls = [];
  const nativeFetch = async function (input, init) {
    fetchCalls.push({ input, init });
    return {
      status: 200,
      clone() { return { text: async () => '{"payload":[]}' }; },
    };
  };
  const win = {
    XMLHttpRequest: FakeXHR,
    Headers: FakeHeaders,
    fetch: nativeFetch,
    Request: class {},
    HTMLIFrameElement: class {},
    Date, Object, Array, String, Promise, Map, Set, RegExp, Error,
    console: { log() {}, warn() {}, error() {} },
    __fetchCalls: fetchCalls,
  };
  Object.defineProperty(win.HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get() { return this._child; },
  });
  Object.defineProperty(win.HTMLIFrameElement.prototype, "contentDocument", {
    configurable: true,
    get() { return { defaultView: this._child }; },
  });
  win.window = win;
  vm.createContext(win);
  return win;
}

function run(win, src, name) {
  vm.runInContext(src, win, { filename: name });
}

function doXhr(win, url, headers) {
  const xhr = new win.XMLHttpRequest();
  xhr.open("GET", url);
  for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
  xhr.send(null);
  xhr.status = 200;
  xhr.responseText = '{"payload":[{"orderNo":"1"}]}';
  xhr.fire("load");
  return xhr;
}

const OMS = "https://gscope.walmartlabs.com/api/gateway/provider-oms/orders?orderNo=1";
const HDRS = { "X-Auth-Token": "t", Authorization: "Bearer x", currentMarket: "US" };

for (const order of [["sparkrisk", "sparkfraud"], ["sparkfraud", "sparkrisk"]]) {
  test(`XHR is captured by both scripts when installed ${order.join(" then ")}`, () => {
    const win = makeWindow();
    for (const name of order) run(win, name === "sparkrisk" ? SPARKRISK : SPARKFRAUD, name);

    doXhr(win, OMS, HDRS);

    const sf = win.__APAISUITE_SPARKFRAUD_CAP.filter((e) => e.url === OMS);
    const sr = win.__APAISUITE_SPARKRISK_CAP.filter((e) => e.url === OMS);
    assert.equal(sf.length, 1, "sparkfraud buffer has the OMS request");
    assert.equal(sr.length, 1, "sparkrisk buffer has the OMS request");

    // Headers arrive lower-cased with the response attached — that is what
    // driveOrderResolution replays on the fast path.
    assert.equal(sf[0].headers["x-auth-token"], "t");
    assert.equal(sf[0].headers["authorization"], "Bearer x");
    assert.equal(sf[0].responseStatus, 200);
    assert.match(sf[0].responseText, /orderNo/);
    assert.equal(sr[0].headers["x-auth-token"], "t");
    assert.equal(sr[0].status, 200);
  });
}

test("neither script replaces the XMLHttpRequest constructor", () => {
  const win = makeWindow();
  const Original = win.XMLHttpRequest;
  run(win, SPARKRISK, "sparkrisk");
  run(win, SPARKFRAUD, "sparkfraud");
  assert.equal(win.XMLHttpRequest, Original, "constructor identity kept (instanceof, DONE, etc.)");
  assert.equal(win.XMLHttpRequest.DONE, 4);
  assert.equal(typeof win.XMLHttpRequest.prototype.open, "function");
});

test("sparkfraud still captures when a page script has swapped the constructor for a wrapper", () => {
  const win = makeWindow();
  const Real = win.XMLHttpRequest;
  // The shape sparkrisk used to install, and that any page script might.
  win.XMLHttpRequest = function () { return new Real(); };
  run(win, SPARKFRAUD, "sparkfraud");

  doXhr(win, OMS, HDRS);
  const sf = win.__APAISUITE_SPARKFRAUD_CAP.filter((e) => e.url === OMS);
  assert.equal(sf.length, 1);
  assert.equal(sf[0].headers["currentmarket"], "US");
});

test("fetch through a same-origin iframe's window is recorded in the top buffer", async () => {
  const win = makeWindow();
  run(win, SPARKFRAUD, "sparkfraud");

  // A hidden child window with its own pristine fetch, reached via the
  // contentWindow getter the way Quantum Metric does it.
  const childCalls = [];
  const child = {
    fetch: async function (input, init) {
      childCalls.push(input);
      return { status: 200, clone() { return { text: async () => "{}" }; } };
    },
    Headers: win.Headers,
    XMLHttpRequest: class { open() {} setRequestHeader() {} send() {} addEventListener() {} },
  };
  const iframe = new win.HTMLIFrameElement();
  iframe._child = child;

  const grabbed = iframe.contentWindow.fetch;      // page grabs the reference
  await grabbed(OMS, { headers: { "x-auth-token": "t" } });

  assert.equal(childCalls.length, 1, "the child's own fetch still ran");
  const sf = win.__APAISUITE_SPARKFRAUD_CAP.filter((e) => e.url === OMS);
  assert.equal(sf.length, 1, "recorded once, in the TOP buffer");
  assert.equal(sf[0].via, "fetch-iframe");
  assert.equal(sf[0].headers["x-auth-token"], "t");

  // Reaching the same child again must not double-wrap it.
  void iframe.contentDocument.defaultView;
  await iframe.contentWindow.fetch(OMS);
  assert.equal(win.__APAISUITE_SPARKFRAUD_CAP.filter((e) => e.url === OMS).length, 2);
  assert.equal(childCalls.length, 2);
});

test("the top-window fetch patch records headers and the response", async () => {
  const win = makeWindow();
  run(win, SPARKRISK, "sparkrisk");
  run(win, SPARKFRAUD, "sparkfraud");
  await win.fetch(OMS, { method: "GET", headers: new win.Headers({ "X-Auth-Token": "t" }) });
  // responseText is filled from a clone asynchronously.
  await new Promise((r) => setTimeout(r, 0));
  const sf = win.__APAISUITE_SPARKFRAUD_CAP.find((e) => e.url === OMS);
  assert.ok(sf);
  assert.equal(sf.via, "fetch");
  assert.equal(sf.headers["x-auth-token"], "t");
  assert.equal(sf.responseStatus, 200);
  assert.equal(win.__fetchCalls.length, 1, "native fetch ran exactly once");
});
