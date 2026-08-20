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

  // Patch XMLHttpRequest
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    const entry = { via: "xhr", ts: Date.now(), headers: {} };
    
    const origOpen = xhr.open;
    xhr.open = function (method, url, ...args) {
      entry.method = method;
      entry.url = url;
      return origOpen.call(this, method, url, ...args);
    };
    
    const origSetRequestHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function (k, v) {
      entry.headers[k.toLowerCase()] = v;
      return origSetRequestHeader.call(this, k, v);
    };
    
    const origSend = xhr.send;
    xhr.send = function (body) {
      entry.body = body ? String(body).slice(0, 5000) : null;
      
      xhr.addEventListener("load", () => {
        entry.status = xhr.status;
        try {
          entry.responseText = xhr.responseText.length <= 10_000_000 
            ? xhr.responseText 
            : xhr.responseText.slice(0, 10_000_000);
        } catch (_) {}
        record(entry);
      });
      
      xhr.addEventListener("error", () => {
        entry.error = "XHR error";
        record(entry);
      });
      
      return origSend.call(this, body);
    };
    
    return xhr;
  };
  
  console.log("[SparkRisk] Network capture installed");
})();
