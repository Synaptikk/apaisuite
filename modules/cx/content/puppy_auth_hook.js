// modules/cx/content/puppy_auth_hook.js
//
// MAIN world, document_start, on the AI gateway's sign-in page only.
//
// ── Why this exists instead of a webRequest listener ────────────────────
//
// The obvious approach — watch the token POST with `webRequest` and read
// `requestBody.formData` — cannot work here, and fails in a way that is easy to
// "verify" wrongly. The sign-in page is a public HTTPS origin posting to
// `http://localhost:8090`, which triggers **Private Network Access**: Chrome
// preflights, the preflight fails because nothing is listening, and the real
// POST is never sent. There is nothing on the network for a listener to see.
//
// Measured 2026-09-25, same fetch from two origins:
//   from chrome-extension://…/app.html  -> SW observed 1 POST with the field
//   from https://puppy.walmart.com/…    -> SW observed 0
//
// Extension pages are exempt from PNA, which is exactly why testing from one
// produced a false pass twice.
//
// So we intercept inside the page instead, wrapping `fetch` and `XMLHttpRequest`
// before the page's own script runs. Our wrapper sees the body it was handed;
// whether the request then dies at the network layer is irrelevant.
//
// ── What it does NOT do ─────────────────────────────────────────────────
//
// It reads one field, `puppy_token`, from requests to `/save_token` on this one
// host, and hands it to the extension's isolated-world relay. It does not touch
// any other request, and the service worker still discards the token unless the
// user started a sign-in from the Cx panel.

(() => {
  const TAG = "apaisuite-cx-puppy-token";
  const PATH = "/save_token";
  const FIELD = "puppy_token";

  const announce = (token) => {
    if (typeof token !== "string" || !token) return;
    // Same-origin target: this never leaves the page it was read in.
    window.postMessage({ __apaisuite: TAG, token }, window.location.origin);
  };

  const isCallback = (url) => {
    try { return String(url).includes(PATH); } catch { return false; }
  };

  /** Pull the field out of whatever body shape the page used. */
  const tokenFromBody = (body) => {
    try {
      if (!body) return null;
      if (typeof body === "string") return new URLSearchParams(body).get(FIELD);
      if (body instanceof URLSearchParams) return body.get(FIELD);
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const v = body.get(FIELD);
        return typeof v === "string" ? v : null;
      }
      return null;
    } catch { return null; }
  };

  // ── fetch ─────────────────────────────────────────────────────────────
  const realFetch = window.fetch;
  if (typeof realFetch === "function") {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : input?.url;
        if (isCallback(url)) announce(tokenFromBody(init?.body));
      } catch { /* never break the page's own auth */ }
      return realFetch.apply(this, arguments);
    };
  }

  // ── XMLHttpRequest ────────────────────────────────────────────────────
  // Belt and braces: the page uses fetch today ("Failed to fetch" in its log),
  // but a rewrite to XHR would silently break this otherwise.
  const realOpen = XMLHttpRequest.prototype.open;
  const realSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__apaisuiteCallback = isCallback(url); } catch { /* ignore */ }
    return realOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try { if (this.__apaisuiteCallback) announce(tokenFromBody(body)); } catch { /* ignore */ }
    return realSend.apply(this, arguments);
  };
})();
