// modules/gnfr/lib/transport.js
//
// Transport for Supply Orders: MyGNFR (mygnfr.walmart.com), Walmart's store
// supply ordering site. Its data comes from SAP OData services behind
// harmony.iprocurement.walmart.com; requests run INSIDE a signed-in MyGNFR tab
// (MAIN world) so they carry the page's own session. Parsing happens in the SW.
//
// Probed live 2026-10-08:
//   • Every harmony call carries the headers the page builds from
//     sessionStorage: `usertoken` (sessionStorage.userToken), a
//     WM_SEC.AUTH_SIGNATURE + WM_CONSUMER.INTIMESTAMP pair that the site's own
//     backend signs (GET /api/authtoken with the PingFed bearer in
//     sessionStorage.session.pfedAccessToken → { token: { signature,
//     timestamp } }), a fixed consumer id, and `userid` (the JWT's userid).
//     The bearer lives 12 h; when it is gone or rejected the tab is reloaded
//     so SSO renews it.
//   • Store carts = ZMPU_C_IPRO_OT_RESULTS filtered on store + submitDate,
//     $expand=to_Details for the lines. Expanding is slow (210 carts / 100 days
//     ≈ 18 s) so the range is pulled a month at a time. History reaches back
//     at least to January 2025.
//   • Cart userID is the orderer's WIN; ZMPU_C_IPRO_USER_SEARCH/?search=<WIN>
//     names them. ZMPU_C_IPRO_APR_TRACK?$filter=purReq eq '<PR>' gives the
//     approver (name + job title), status, dates and the rejection comment.
//   • ZPUSPGL49_IPT_RB0936_V1Results is the home page's "operational
//     expenditures": per-GL-category invoiced last year (same month) and MTD.
//   • ZMPU_IPRO_MYGNFR_PO_SRV and ZMPU_IPRO_MYGNFR_F4_SRV answer 403 (service
//     not exposed to stores) — PO shipment history is NOT available; the
//     tracking number / carrier / dates on each line are all there is.

export const GNFR_ORIGIN = "https://mygnfr.walmart.com";
const LOAD_MS = 45_000;
const SCRIPT_MS = 120_000;
const SIGN_IN_MS = 90_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs IN the MyGNFR page (MAIN world). Serialised: no closures, no imports.
 *   { op: "ping" }                                 → { ready, user }
 *   { op: "boot" }                                 → { me, weeks, budget }
 *   { op: "carts", store, from, to }               → { carts: [raw OData cart] }
 *   { op: "users", wins: [] }                      → { users: { win: {name, sam} } }
 *   { op: "approvals", prs: [] }                   → { approvals: { pr: [raw rows] } }
 * Errors come back as { error, auth? } — `auth` means sign in / reload.
 */
export async function gnfrInPage(req) {
  const HARMONY = "https://harmony.iprocurement.walmart.com/iprocurement/api/gget/PF4/US/";
  const ss = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
  let session = null;
  try { session = JSON.parse(ss("session") || "null"); } catch { /* none */ }
  const bearer = session?.pfedAccessToken;
  const userToken = ss("userToken");
  if (req.op === "ping") return { ready: !!(bearer && userToken) };
  if (!bearer || !userToken) return { error: "MyGNFR is not signed in yet.", auth: true };

  let claims = {};
  try { claims = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* keep {} */ }
  if (claims.exp && claims.exp * 1000 < Date.now() + 60_000) return { error: "The MyGNFR sign-in has expired.", auth: true };

  let sig;
  try {
    const r = await fetch("/api/authtoken", { headers: { Authorization: `Bearer ${bearer}` } });
    if (!r.ok) { console.warn("[gnfr] authtoken status", r.status); const auth = r.status === 401 || r.status === 403; return { error: auth ? "Sign in to MyGNFR, then Refresh." : "MyGNFR didn't respond. Try again.", auth }; }
    sig = (await r.json()).token;
  } catch (e) { console.warn("[gnfr] authtoken:", e); return { error: "MyGNFR didn't respond. Try again." }; }

  const headers = () => ({
    "WM_CONSUMER.INTIMESTAMP": String(sig.timestamp), "WM_SEC.AUTH_SIGNATURE": sig.signature,
    "WM_SEC.KEY_VERSION": "1", "WM_CONSUMER.ID": "6b3f993c-062e-4c81-8ec8-579157a18abb",
    "WM_SVC.NAME": "IPT-HARMONY-GNFR", "WM_SVC.ENV": "prod", app_name: "mygnfr-web",
    usertoken: userToken, userid: claims.userid || "", correlationid: crypto.randomUUID(),
    Accept: "application/json",
  });
  // OData query strings: the site sends spaces as '+'.
  const q = (s) => encodeURIComponent(s).replace(/%20/g, "+");
  const get = async (path) => {
    const url = HARMONY + path + (path.includes("?") ? "&" : "?") + "$format=json&sap-language=EN";
    const r = await fetch(url, { headers: headers() });
    if (r.status === 401) { console.warn("[gnfr] 401 on", path); throw Object.assign(new Error("Sign in to MyGNFR, then Refresh."), { auth: true }); }
    if (!r.ok) { console.warn("[gnfr]", r.status, "on", path); throw new Error("MyGNFR didn't respond. Try again."); }
    return (await r.json())?.d;
  };
  const pool = async (items, n, fn) => {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
  };

  try {
    if (req.op === "boot") {
      const d = await get(`ZMPU_IPROCUREMENT_SRV/ZMPU_C_IPRO_BOOTSTRAP?$filter=${q("userID eq ''")}`);
      const b = d?.results?.[0] || {};
      const me = { win: b.winNo, name: [b.firstName, b.lastName].filter(Boolean).join(" "), job: b.jobDescription, store: b.store, sam: claims.userid || "" };
      let weeks = [], budget = [];
      try { weeks = (await get(`ZMPU_IPROCUREMENT_SRV/weekPeriodSelectionSet?$filter=${q("userId eq ''")}`))?.results || []; } catch { /* optional */ }
      try { budget = (await get(`ZPUSPGL49_IPT_RB0936_V1_SRV_01/ZPUSPGL49_IPT_RB0936_V1Results?$filter=${q(`store eq '${b.store}'`)}`))?.results || []; } catch { /* optional */ }
      return { me, weeks, budget };
    }

    if (req.op === "carts") {
      const filter = q(`store eq '${req.store}' and langu eq 'E' and(submitDate ge datetime'${req.from}T00:00:00' and submitDate le datetime'${req.to}T23:59:59')`);
      const carts = [];
      for (let skip = 0; skip < 5000; skip += 300) {
        const d = await get(`ZMPU_IPROCUREMENT_SRV/ZMPU_C_IPRO_OT_RESULTS?$top=300&$skip=${skip}&$filter=${filter}&$orderby=submitDate+desc,submitTime+desc&$expand=to_Details&$inlinecount=allpages`);
        const rows = d?.results || [];
        carts.push(...rows);
        if (rows.length < 300 || carts.length >= Number(d?.__count || 0)) break;
      }
      return { carts };
    }

    if (req.op === "users") {
      const users = {};
      await pool(req.wins || [], 4, async (win) => {
        try {
          const d = await get(`ZMPU_IPROCUREMENT_SRV/ZMPU_C_IPRO_USER_SEARCH/?search=${encodeURIComponent(win)}`);
          const u = (d?.results || []).find((x) => x.userID === win || x.wmIdentificationNumber === win) || d?.results?.[0];
          users[win] = u ? { name: u.name || "", sam: u.sAMAccountName || "" } : { name: "", sam: "" };
        } catch { /* leave unnamed; retried next pull */ }
      });
      return { users };
    }

    if (req.op === "approvals") {
      const approvals = {};
      await pool(req.prs || [], 4, async (pr) => {
        try { approvals[pr] = (await get(`ZMPU_IPROCUREMENT_SRV/ZMPU_C_IPRO_APR_TRACK?$filter=${q(`purReq eq '${pr}'`)}`))?.results || []; }
        catch { /* retried next pull */ }
      });
      return { approvals };
    }
    return { error: `unknown op ${req.op}` };
  } catch (e) {
    return { error: String(e?.message || e), auth: !!e?.auth };
  }
}

async function ping(tabId) {
  let timer;
  try {
    const [res] = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: gnfrInPage, args: [{ op: "ping" }] }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("asleep")), 3000); }),
    ]);
    return res?.result || null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function inPage(tabId, req) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("The MyGNFR tab stopped answering (it may be asleep). Click into it once, then try again.")), SCRIPT_MS); });
  try {
    const [res] = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: gnfrInPage, args: [req] }),
      timeout,
    ]);
    const out = res?.result;
    if (!out) throw new Error("The MyGNFR page did not answer.");
    if (out.error) throw Object.assign(new Error(out.error), { auth: !!out.auth });
    return out;
  } finally { clearTimeout(timer); }
}

/** Waits until the tab is on MyGNFR with a session in sessionStorage. */
async function waitReady(tabId, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const cur = await chrome.tabs.get(tabId).catch(() => null);
    if (!cur) throw new Error("The MyGNFR tab was closed.");
    if (cur.status === "complete" && cur.url?.startsWith(GNFR_ORIGIN) && (await ping(tabId))?.ready) return true;
    await sleep(1000);
  }
  return false;
}

/**
 * Run `fn(call)` against a MyGNFR tab (`call(req)` runs gnfrInPage there).
 * Reuses an open, awake MyGNFR tab; otherwise opens one in the background and
 * closes it afterwards. Not signed in → the tab comes to the front for SSO.
 */
export async function withGnfr(fn, { say = () => {} } = {}) {
  let tab = null, opened = false;
  for (const t of await chrome.tabs.query({ url: `${GNFR_ORIGIN}/*` })) {
    if (t.discarded || t.frozen || t.status !== "complete") continue;
    if ((await ping(t.id))?.ready) { tab = t; break; }
  }
  if (!tab) {
    say("Opening MyGNFR…");
    tab = await chrome.tabs.create({ url: `${GNFR_ORIGIN}/`, active: false });
    opened = true;
    if (!await waitReady(tab.id, LOAD_MS)) {
      say("MyGNFR needs a sign-in — finish it in the tab that just opened.");
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      if (!await waitReady(tab.id, SIGN_IN_MS)) throw new Error("Still not signed in to MyGNFR. Sign in at mygnfr.walmart.com, then refresh.");
      opened = false;   // the user signed in there; leave it open
    }
  }
  const call = async (req) => {
    try { return await inPage(tab.id, req); }
    catch (e) {
      if (!e.auth) throw e;
      // Session went stale: reload so SSO renews the PingFed token, then retry once.
      say("Renewing the MyGNFR session…");
      await chrome.tabs.reload(tab.id).catch(() => {});
      await sleep(1500);
      if (!await waitReady(tab.id, LOAD_MS)) {
        await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
        if (!await waitReady(tab.id, SIGN_IN_MS)) throw new Error("MyGNFR needs a sign-in. Sign in at mygnfr.walmart.com, then refresh.");
        opened = false;
      }
      return inPage(tab.id, req);
    }
  };
  try { return await fn(call); }
  finally { if (opened) chrome.tabs.remove(tab.id).catch(() => {}); }
}
