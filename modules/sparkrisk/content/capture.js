// modules/sparkrisk/content/capture.js
//
// MAIN-world content script for SparkRisk
// Captures network requests on gscope.walmartlabs.com to record
// OMS API calls with headers for order item fetching

(() => {
  if (window.__APAISUITE_SPARKRISK_CAP) return; // already installed

  const cap = [];
  window.__APAISUITE_SPARKRISK_CAP = cap;

  function record(entry) {
    cap.push(entry);
    if (cap.length > 200) cap.splice(0, cap.length - 200);
  }

  // Patch fetch
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const method = (init && init.method) || (input && input.method) || "GET";
    const headers = {};
    
    if (input && typeof input !== "string" && input.headers) {
      try { for (const [k, v] of input.headers.entries()) headers[k.toLowerCase()] = v; } catch (_) {}
    }
    if (init && init.headers) {
      const h = init.headers;
      try {
        if (h instanceof Headers) {
          for (const [k, v] of h.entries()) headers[k.toLowerCase()] = v;
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) headers[k.toLowerCase()] = v;
        } else {
          for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
        }
      } catch (_) {}
    }
    
    const body = init && init.body ? String(init.body).slice(0, 5000) : null;
    const entry = { via: "fetch", url, method, headers, body, ts: Date.now() };
    
    try {
      const response = await origFetch.call(this, input, init);
      entry.status = response.status;
      
      // Clone response to read text
      const cloned = response.clone();
      try {
        const text = await cloned.text();
        entry.responseText = text.length <= 10_000_000 ? text : text.slice(0, 10_000_000);
      } catch (_) {}
      
      record(entry);
      return response;
    } catch (err) {
      entry.error = String(err);
      record(entry);
      throw err;
    }
  };

  // Patch XMLHttpRequest — on the PROTOTYPE, never by replacing the
  // constructor. The original version of this file did
  // `window.XMLHttpRequest = function () { ... }`, which broke two things:
  //   1. Every other MAIN-world script that patches XMLHttpRequest.prototype
  //      (sparkfraud's capture.js, on the same gscope pages) landed its patch
  //      on the wrapper's empty prototype and captured nothing. SparkFraud's
  //      item lookup was dead from 2026-08-20 until this was found.
  //   2. Page code lost XMLHttpRequest.DONE/OPENED constants and
  //      `instanceof XMLHttpRequest`.
  // Prototype patches compose: whichever script runs last wraps the one
  // before it, and each records into its own buffer.
  const XHR = window.XMLHttpRequest;
  // If someone else already swapped the constructor for a wrapper, its
  // .prototype is not the real one — reach the real prototype through an
  // instance.
  let proto = XHR.prototype;
  if (typeof proto.open !== "function") {
    try { proto = Object.getPrototypeOf(new XHR()); } catch (_) {}
  }
  const origOpen = proto.open;
  const origSetRequestHeader = proto.setRequestHeader;
  const origSend = proto.send;

  proto.open = function (method, url) {
    this.__sparkrisk = { via: "xhr", ts: Date.now(), method, url, headers: {} };
    return origOpen.apply(this, arguments);
  };
  proto.setRequestHeader = function (k, v) {
    if (this.__sparkrisk) this.__sparkrisk.headers[String(k).toLowerCase()] = v;
    return origSetRequestHeader.apply(this, arguments);
  };
  proto.send = function (body) {
    const entry = this.__sparkrisk;
    if (entry) {
      entry.body = body ? String(body).slice(0, 5000) : null;
      this.addEventListener("load", () => {
        entry.status = this.status;
        try {
          entry.responseText = this.responseText.length <= 10_000_000
            ? this.responseText
            : this.responseText.slice(0, 10_000_000);
        } catch (_) {}
        record(entry);
      });
      this.addEventListener("error", () => {
        entry.error = "XHR error";
        record(entry);
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log("[SparkRisk] Network capture installed");
})();
