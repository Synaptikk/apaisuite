// shared/identity_probe.js
//
// Actively looks for the user's name instead of waiting for a module to
// stumble on it. shared/identity.js only learns a display name as a side
// effect (a Spark Fraud search reading gscope cookies), so "open gscope" was
// not enough: nothing read the cookie until a search ran. On 2026-10-19 an AP
// associate did exactly that and Door Catches still sent no name.
//
// checkIdentity() asks every name source directly, records what it finds via
// observeIdentity, and returns a per-source report so a page can show WHY no
// name was found rather than one generic hint.
//
//   gscope    `wire-id` cookie ("Display Name - loginId") and `store-no`.
//             Managed Edge's cookies API returns only loggedInDomain and
//             authHeader for gscope (checked 2026-10-19), so the name comes
//             from an open gscope tab (document.cookie, or the store-select
//             form's hidden wireId); with none open, gscope's SSO is started
//             in a background tab, read and closed (see backgroundGscopeJar).
//   auror     the name claim AurorBuddy cached from the Auror sign-in token
//             (aurorbuddy.fb_aurorIdentity; read-only here).

import { getIdentity, observeIdentity, parseWireId, winFromAurorSub } from "./identity.js";

const GSCOPE_ORIGINS = ["https://gscope.walmartlabs.com", "https://gscope.walmart.com"];
const AUROR_IDENTITY_KEY = "aurorbuddy.fb_aurorIdentity";
const TAB_TIMEOUT_MS = 3000;
const OPEN_WAIT_MS = 20_000;
const SSO_START_URL = "https://pfedprod.wal-mart.com/idp/startSSO.ping?PartnerSpId=https://gscope.walmartlabs.com/sp";

/** "Cody J Howard" yes; "chowar1", "c.howard@x.com", "" no. */
export function looksLikePersonName(s) {
  const v = String(s || "").trim();
  if (!v || /[@\d]/.test(v)) return false;
  return v.split(/[\s,]+/).filter((w) => /[A-Za-z]/.test(w)).length >= 2;
}

function decode(v) {
  try { return decodeURIComponent(String(v).replace(/\+/g, " ")); } catch { return String(v); }
}

/** Cookie jar (any case) → { displayName, win, store } from gscope's cookies. */
export function gscopeIdentityFromCookies(jar) {
  const ci = {};
  for (const [k, v] of Object.entries(jar || {})) ci[k.toLowerCase()] = decode(v);
  const { displayName, win } = parseWireId(ci["wire-id"]);
  const legacy = ci.displayname || ci.loggedinusername || "";
  const storeRaw = String(ci["store-no"] || ci.storeno || "").trim();
  return {
    displayName: looksLikePersonName(displayName) ? displayName : looksLikePersonName(legacy) ? legacy : "",
    win: win || ci.loginid || ci.win || "",
    store: /^\d{1,5}$/.test(storeRaw) ? String(parseInt(storeRaw, 10)) : "",
  };
}

async function cookiesApiJar() {
  const jar = {};
  for (const url of GSCOPE_ORIGINS) {
    const got = await chrome.cookies.getAll({ url }).catch(() => []);
    for (const c of got || []) jar[c.name] = c.value;
  }
  return jar;
}

async function gscopeTabs() {
  const tabs = [];
  for (const o of GSCOPE_ORIGINS) tabs.push(...(await chrome.tabs.query({ url: `${o}/*` }).catch(() => [])));
  return tabs;
}

// document.cookie of a gscope tab, plus gscope's store-select form
// (/api/wmstoresso) when the tab is parked on it: that form carries the same
// identity in hidden inputs (wireId "Name - loginId", storeno) before Go is
// pressed, so nothing is submitted to read it.
async function tabJar(tabId) {
  const run = chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const form = {};
      for (const name of ["wireId", "storeno"]) {
        const el = document.querySelector(`input[name="${name}"]`);
        if (el?.value) form[name] = el.value;
      }
      return { cookie: document.cookie, form };
    },
  });
  const res = await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TAB_TIMEOUT_MS))]);
  const got = res?.[0]?.result || {};
  const jar = {};
  for (const part of String(got.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  if (got.form?.wireId && !jar["wire-id"]) jar["wire-id"] = got.form.wireId;
  if (got.form?.storeno && !jar["store-no"]) jar["store-no"] = got.form.storeno;
  return jar;
}

// With no gscope tab open, start gscope's SSO in a background tab just long
// enough to read the name, then close it. With the browser signed in to
// Walmart, PingFederate lands on the store-select form in ~1.5 s (checked
// 2026-10-19); an already-live session lands on gscope itself. Opening
// gscope's home page instead never signs in on its own. Returns { jar, url }
// — url is where the tab ended (a pfedprod/login page = needs a sign-in).
async function backgroundGscopeJar() {
  const tab = await chrome.tabs.create({ url: SSO_START_URL, active: false });
  let url = "", jar = {};
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < OPEN_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 1000));
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t) break;
      url = t.url || t.pendingUrl || "";
      if (t.status !== "complete" || !GSCOPE_ORIGINS.some((o) => url.startsWith(o))) continue;
      jar = await tabJar(tab.id).catch(() => jar);
      if (gscopeIdentityFromCookies(jar).displayName) break;
    }
    return { jar, url };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function probeGscope({ openTab = true } = {}) {
  let found = gscopeIdentityFromCookies(await cookiesApiJar());
  const tabs = found.displayName ? [] : await gscopeTabs();
  for (const t of tabs) {
    if (found.displayName) break;
    try {
      const fromTab = gscopeIdentityFromCookies(await tabJar(t.id));
      found = { displayName: fromTab.displayName || found.displayName, win: fromTab.win || found.win, store: fromTab.store || found.store };
    } catch { /* frozen or non-HTML tab */ }
  }
  let opened = null;
  if (!found.displayName && openTab) {
    try {
      opened = await backgroundGscopeJar();
      const fromTab = gscopeIdentityFromCookies(opened.jar);
      found = { displayName: fromTab.displayName || found.displayName, win: fromTab.win || found.win, store: fromTab.store || found.store };
    } catch { opened = { jar: {}, url: "" }; }
  }
  if (found.displayName || found.win || found.store) {
    await observeIdentity({ source: "gscope_session", ...found }).catch(() => {});
  }
  const detail = found.displayName ? `signed in as ${found.displayName}`
    : found.win ? "signed in, but gscope didn't give a name"
    : opened && opened.url && !GSCOPE_ORIGINS.some((o) => opened.url.startsWith(o)) ? "gscope needs you to sign in: open gscope, finish signing in, then check again"
    : tabs.length || opened ? "gscope opened but isn't signed in: open gscope, finish signing in, then check again"
    : "no gscope sign-in in this browser";
  return { id: "gscope", label: "gscope", ok: !!found.displayName, name: found.displayName, detail };
}

async function probeAuror() {
  const got = (await chrome.storage.local.get(AUROR_IDENTITY_KEY).catch(() => ({})))[AUROR_IDENTITY_KEY] || {};
  const name = looksLikePersonName(got.name) ? String(got.name).trim() : "";
  if (name || got.aurorUserId) {
    await observeIdentity({ source: "auror_jwt", win: winFromAurorSub(got.aurorUserId), displayName: name }).catch(() => {});
  }
  const detail = name ? `signed in as ${name}`
    : got.aurorUserId ? "signed in, but Auror didn't give a full name"
    : "Auror hasn't been opened through the suite in this browser";
  return { id: "auror", label: "Auror", ok: !!name, name, detail };
}

/**
 * Look everywhere for the user's name. Never throws. `openTab: false` skips
 * opening a background gscope tab when none is open.
 * @returns {Promise<{ displayName: string, win: string, store: string, sources: Array<{id,label,ok,name,detail}> }>}
 */
export async function checkIdentity({ openTab = true } = {}) {
  const run = async (probe, opts) => {
    try { return await probe(opts); }
    catch (err) { return { id: probe.name, label: probe.name, ok: false, name: "", detail: `check failed: ${err?.message || err}` }; }
  };
  // Auror is a storage read; only open a gscope tab when it gave no name.
  const auror = await run(probeAuror);
  const gscope = await run(probeGscope, { openTab: openTab && !auror.ok });
  const sources = [gscope, auror];
  const me = await getIdentity();
  return { displayName: me.displayName || "", win: me.win || "", store: me.store || "", sources };
}
