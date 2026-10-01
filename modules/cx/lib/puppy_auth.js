// modules/cx/lib/puppy_auth.js
//
// Sign in to the Walmart AI gateway from inside the extension, with no paste.
//
// ── How Code Puppy's own auth works ─────────────────────────────────────
//
// `code_puppy/plugins/walmart_specific/auth.py` opens
// `https://puppy.walmart.com/authenticate_puppy` in a browser and starts a
// local HTTP server to receive the result. When the user finishes SSO the auth
// site **POSTs** the token to that server: `http_server.py` answers
// `@app.post("/save_token")` with `puppy_token: str = Form(...)`.
//
// ── Why a webRequest listener cannot do it ──────────────────────────────
//
// The obvious approach is to watch the POST with `webRequest` and read
// `requestBody.formData`. It does not work, and it fails in a way that is easy
// to "verify" wrongly — which is exactly what happened here twice.
//
// The sign-in page is a public HTTPS origin posting to `http://localhost:8090`.
// That triggers **Private Network Access**: Chrome preflights the request, the
// preflight fails because nothing is listening, and the real POST is never sent.
// There is nothing on the network for a listener to observe. Measured
// 2026-09-25, the same fetch from two origins:
//
//   from chrome-extension://…/app.html  ->  SW observed 1 POST, field present
//   from https://puppy.walmart.com/…    ->  SW observed 0
//
// Extension pages are exempt from PNA. Every earlier test posted from one, so
// they all passed while the real flow captured nothing.
//
// ── What does work ──────────────────────────────────────────────────────
//
// Intercept inside the page, before the network layer gets a chance to fail:
// `content/puppy_auth_hook.js` runs in the MAIN world at document_start and
// wraps `fetch` / `XMLHttpRequest`, and `content/puppy_auth_relay.js` carries
// what it finds to the service worker. Both are scoped to this one host.
//
// ── The one rule ────────────────────────────────────────────────────────
//
// The relay forwards; this module decides. A token is only kept while a flow the
// user started in the Cx panel is armed. Quietly keeping the credential when
// someone runs `/puppy_auth` in their terminal would be taking something they
// did not offer.

/** The gateway's own sign-in page. */
const AUTH_BASE = "https://puppy.walmart.com/authenticate_puppy";

/** Session keys. `session`, not `local`: an armed flow must not outlive the browser. */
const ARMED_KEY = "cx.puppyAuth.armed";
const RESULT_KEY = "cx.puppyAuth.result";
/**
 * A short log of what the page hook reported during a sign-in.
 *
 * The two ways this fails look identical from the panel — the status sits on
 * "waiting" — and they need opposite fixes: either the page never told us
 * anything (the hook did not run, or the page changed shape) or it did and we
 * rejected it (no token, flow not armed). Metadata only: never the token.
 */
const LOG_KEY = "cx.puppyAuth.log";
const LOG_MAX = 20;

/** How long the user gets to finish SSO before we stop waiting. */
const AUTH_TIMEOUT_MS = 5 * 60_000;

export class PuppyAuthError extends Error {
  constructor(message, errorClass = "AUTH") {
    super(message);
    this.name = "PuppyAuthError";
    this.errorClass = errorClass;   // AUTH | TAB | TIMEOUT | CANCELLED
  }
}

/**
 * Accept a token the page hook saw, if the user asked for one.
 *
 * Returns a small, logged verdict rather than a boolean: when a sign-in does not
 * complete, "we never heard from the page" and "we heard and said no" need
 * opposite fixes and look identical from the panel.
 */
export async function acceptRelayedToken(token) {
  const got = await chrome.storage.session.get([ARMED_KEY, LOG_KEY]);
  const armed = got[ARMED_KEY];
  const fresh = !!armed?.at && Date.now() - armed.at <= AUTH_TIMEOUT_MS;

  const note = { at: Date.now(), tokenLen: typeof token === "string" ? token.length : null, armed: !!armed, fresh };
  await chrome.storage.session.set({ [LOG_KEY]: [...(got[LOG_KEY] ?? []), note].slice(-LOG_MAX) });

  if (!token || typeof token !== "string") return { accepted: false, reason: "EMPTY" };
  if (!fresh) return { accepted: false, reason: "NOT_ARMED" };

  await chrome.storage.session.set({ [RESULT_KEY]: { token, at: Date.now(), nonce: armed.nonce } });
  await chrome.storage.session.remove(ARMED_KEY);
  return { accepted: true };
}

/** What the page hook reported during the last sign-in. Metadata only. */
export async function readAuthLog() {
  const got = await chrome.storage.session.get([LOG_KEY, ARMED_KEY]);
  return { observed: got[LOG_KEY] ?? [], armed: !!got[ARMED_KEY] };
}

/**
 * Run the sign-in.
 *
 * Opens the auth page in a foreground tab — the user has to see it to complete
 * SSO — and resolves with the token once the page posts it back.
 *
 * @param {object} opts
 * @param {function} opts.onStage  ("opening" | "waiting" | "done") => void
 * @returns {Promise<{ token: string }>}
 */
export async function runPuppyAuth({ onStage = null } = {}) {
  const nonce = crypto.randomUUID();
  await chrome.storage.session.set({ [ARMED_KEY]: { at: Date.now(), nonce } });
  await chrome.storage.session.remove(RESULT_KEY);
  // Only ever describes the attempt in progress.
  await chrome.storage.session.remove(LOG_KEY);

  // No callback parameter: the deployed page ignores it and uses its own
  // default, and steering it away from that default only guarantees the CLI
  // handshake fails. We read the token off the wire either way.
  const url = AUTH_BASE;

  onStage?.("opening");
  let tab;
  try {
    // Foreground: this is an SSO prompt, and a background tab would look like
    // nothing happened.
    tab = await chrome.tabs.create({ url, active: true });
  } catch (e) {
    await chrome.storage.session.remove(ARMED_KEY);
    throw new PuppyAuthError(`Could not open the sign-in page: ${e?.message ?? e}`, "TAB");
  }

  onStage?.("waiting");
  try {
    const token = await waitForToken(nonce, tab.id);
    onStage?.("done");
    return { token };
  } finally {
    await chrome.storage.session.remove(ARMED_KEY);
    await chrome.storage.session.remove(RESULT_KEY);
    // The auth page has nothing left to show once it has posted.
    try { await chrome.tabs.remove(tab.id); } catch { /* user closed it */ }
  }
}

async function waitForToken(nonce, tabId) {
  const deadline = Date.now() + AUTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(700);

    const got = await chrome.storage.session.get(RESULT_KEY);
    const result = got[RESULT_KEY];
    if (result?.token && result.nonce === nonce) return result.token;

    // The user closing the tab is a cancellation, not a failure to report.
    let alive = true;
    try { await chrome.tabs.get(tabId); } catch { alive = false; }
    if (!alive) {
      // A tab closed after the token was posted is a success we just missed by
      // a poll; check once more before calling it a cancellation.
      const last = await chrome.storage.session.get(RESULT_KEY);
      if (last[RESULT_KEY]?.token && last[RESULT_KEY].nonce === nonce) return last[RESULT_KEY].token;
      throw new PuppyAuthError("Sign-in was cancelled.", "CANCELLED");
    }
  }
  throw new PuppyAuthError(await explainFailure("Timed out waiting for the sign-in to finish."), "TIMEOUT");
}

/**
 * Turn "it did not work" into something actionable, using what the listener
 * actually saw rather than a generic retry message.
 */
async function explainFailure(prefix) {
  const { observed } = await readAuthLog();
  if (!observed.length) {
    return `${prefix} The sign-in page never handed a token to the extension. `
      + "If the page said it generated one, reload the extension (its page hook is a content "
      + "script, and a newly added one only applies to pages loaded after a reload) and try "
      + "again — or use “Paste a token instead” below.";
  }
  if (!observed.some((o) => o.tokenLen)) {
    return `${prefix} The page hook fired but carried no token, so the page has changed shape.`;
  }
  if (!observed.some((o) => o.fresh)) {
    return `${prefix} A token arrived but this sign-in was no longer active. Try again.`;
  }
  return `${prefix} A token arrived but could not be stored.`;
}

/** Exposed for the settings panel so it can explain where the token comes from. */
export const AUTH_DETAILS = Object.freeze({ authUrl: AUTH_BASE });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
