// modules/cx/content/puppy_auth_relay.js
//
// ISOLATED world, on the sign-in page only. The MAIN-world hook cannot reach
// `chrome.runtime`; this is the one line of plumbing that carries the token
// from the page into the service worker.
//
// It forwards, it does not decide: the service worker discards the token unless
// the user actually started a sign-in from the Cx panel.

(() => {
  const TAG = "apaisuite-cx-puppy-token";

  window.addEventListener("message", (event) => {
    // Only messages this page posted to itself, from our hook.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__apaisuite !== TAG || typeof data.token !== "string") return;

    chrome.runtime.sendMessage(
      { module: "cx", type: "puppyTokenSeen", token: data.token },
      () => void chrome.runtime.lastError,
    );
  });
})();
