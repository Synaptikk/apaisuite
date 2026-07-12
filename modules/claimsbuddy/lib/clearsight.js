// Fetch newly opened claims from Riskonnect ClearSight (legacy: STARS).
//
// Today: session detection + auto-SSO. When the .ASPXAUTH cookie is missing
// we open the wmlink SSO entry in a new tab and watch for the auth cookie to
// appear (Walmart IdP → ClearSight). If it lands within the timeout we close
// the SSO tab and report signed-in; otherwise we leave the tab open so the
// user can complete an interactive login (stale creds, MFA prompt, etc.) and
// re-click Load.
//
// Actual claims data is still TBD — the data-API endpoints aren't documented
// yet, so even with a live session there's nothing to fetch. Discovering them
// is a separate ticket (webRequest sniffing of the SPA's outgoing XHRs).
//
// SSO entry per CLEARSIGHT_STORMS_REFERENCE.md §3:
//   https://wmlink.wal-mart.com/WCSIncidentIntake
//
// Why .ASPXAUTH specifically: ASP.NET_SessionId can be present on anonymous
// visits, so a session cookie alone isn't proof of auth. The forms-auth
// ticket only exists once login succeeds.

const COOKIE_DOMAIN = "riskonnectclearsight.com";
const AUTH_COOKIE   = ".ASPXAUTH";
const SIGN_IN_URL   = "https://wmlink.wal-mart.com/WCSIncidentIntake";
const SSO_TIMEOUT_MS = 30_000;

export async function fetchClearSightOpenClaims(_store, onStatus) {
  let cookies;
  try {
    cookies = await chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
  } catch (err) {
    return {
      placeholder: true,
      claims: [],
      reason: "cookie-check-failed",
      note: `Couldn't check ClearSight session: ${err?.message || err}`,
    };
  }

  console.debug("[ClaimsBuddy] ClearSight cookies (pre-SSO):", cookies.map(summarizeCookie));
  let signedIn = isSignedIn(cookies);

  if (!signedIn) {
    onStatus?.("signing in…");
    const ssoResult = await attemptSsoAuth();
    console.debug("[ClaimsBuddy] ClearSight cookies (post-SSO):", ssoResult.cookies.map(summarizeCookie));
    cookies = ssoResult.cookies;
    signedIn = ssoResult.signedIn;
  }

  if (!signedIn) {
    return {
      placeholder: true,
      claims: [],
      reason: "no-session",
      signInUrl: SIGN_IN_URL,
      cookieNames: cookies.map((c) => c.name),
      note: "No active ClearSight session. Log in via wmlink then reload.",
    };
  }

  return {
    placeholder: true,
    claims: [],
    reason: "endpoints-undocumented",
    note: "Signed in. Data-API endpoints not yet discovered — needs webRequest sniffing of an authenticated session.",
  };
}

function summarizeCookie(c) {
  return { name: c.name, httpOnly: c.httpOnly, secure: c.secure, session: c.session, domain: c.domain };
}

// The exact ClearSight auth cookie name isn't documented. Default ASP.NET
// Forms Auth is .ASPXAUTH, but vendors routinely override the name. We
// accept several plausible candidates AND any HttpOnly cookie that isn't
// from a known anonymous tracker (Incapsula, etc.). If this still misses
// after login, the cookieNames list returned to the UI shows what's there
// so we can dial in the right name.
const KNOWN_ANON_PREFIXES = /^(incap_|visid_|nlbi_|_ga|_gid|reese84)/i;
function isSignedIn(cookies) {
  return cookies.some((c) => {
    if (c.name === AUTH_COOKIE) return true;
    if (/^\.?ASPX(FORMS)?AUTH$/i.test(c.name)) return true;
    if (c.httpOnly && !KNOWN_ANON_PREFIXES.test(c.name)) return true;
    return false;
  });
}

async function readAuthCookie() {
  const cookies = await chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
  return { cookies, signedIn: isSignedIn(cookies) };
}

// Open the SSO entry in a visible tab and wait for an auth cookie to appear.
// Resolves { signedIn, cookies } regardless of outcome so the caller can show
// what cookies (if any) ended up on the domain.
async function attemptSsoAuth() {
  let tabId;
  try {
    // Open in the background so we don't steal focus during silent SSO.
    // If creds/MFA are needed the timeout handler below will surface the tab
    // so the user knows where to interact.
    const tab = await chrome.tabs.create({ url: SIGN_IN_URL, active: false });
    tabId = tab.id;
    console.debug("[ClaimsBuddy] SSO tab opened (background):", { tabId, url: SIGN_IN_URL });
  } catch (err) {
    console.warn("[ClaimsBuddy] SSO tab open failed:", err);
    return { signedIn: false, cookies: [] };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = async (success) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      const { cookies, signedIn } = await readAuthCookie().catch(() => ({ cookies: [], signedIn: false }));
      console.debug("[ClaimsBuddy] SSO finish:", { success, signedIn, cookieCount: cookies.length });
      if (success && tabId != null) {
        chrome.tabs.remove(tabId).catch(() => { /* tab may already be gone */ });
      }
      resolve({ signedIn: signedIn || success, cookies });
    };

    // Re-check on every navigation step. SSO chains through Walmart's IdP and
    // may set the auth cookie at any redirect hop, not just on the final
    // ClearSight URL.
    const onUpdated = async (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      console.debug("[ClaimsBuddy] SSO tab update:", { url: tab?.url, status: changeInfo.status });
      if (!changeInfo.url && changeInfo.status !== "complete") return;
      try {
        const { signedIn } = await readAuthCookie();
        if (signedIn) finish(true);
      } catch { /* let timeout handle it */ }
    };

    const onRemoved = (closedTabId) => {
      if (closedTabId === tabId) {
        console.debug("[ClaimsBuddy] SSO tab closed by user");
        finish(false);
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const timer = setTimeout(() => {
      console.debug("[ClaimsBuddy] SSO timed out after", SSO_TIMEOUT_MS, "ms — surfacing tab");
      // Bring the SSO tab to the foreground so the user can see what it's
      // waiting on (credential prompt, MFA, network error, etc.) instead of
      // having to hunt for a silent background tab.
      if (tabId != null) {
        chrome.tabs.update(tabId, { active: true }).catch(() => { /* tab may have been closed */ });
      }
      finish(false);
    }, SSO_TIMEOUT_MS);
  });
}
