// modules/punchlookup/lib/onedrive.js
//
// Transport for shared cases: files in the case owner's OneDrive
// (my.wal-mart.com/personal/<owner>/Documents/Punch Lookup Cases/<case>/),
// reached with each user's own Walmart sign-in. Access is OneDrive's: only
// people the owner shared the folder with can read or write it.
//
// Probed live 2026-10-08:
//   • GETs (folder listings, file contents, currentuser) work straight from
//     the extension with the browser's SharePoint session — used for reading
//     and the live poll, no tab needed.
//   • POSTs are refused from the extension's origin (contextinfo → 403), so
//     every write runs INSIDE a my.wal-mart.com tab (/_layouts/15/blank.htm,
//     a near-empty page), like the GTA pulls do: contextinfo there → a 30-min
//     request digest → folders/add, Files/add(overwrite), recycle(), people
//     picker search, ShareObject.
//   • A folder must be emptied before recycle() takes it; recycled items go
//     to the OneDrive recycle bin (recoverable).

export const MY_ORIGIN = "https://my.wal-mart.com";
const HOST_URL = `${MY_ORIGIN}/_layouts/15/blank.htm`;
// blank.htm is served to anyone, signed in or not (checked 2026-10-08), so the
// tab is opened through Authenticate.aspx: signed out it goes through Walmart
// SSO first, signed in it lands on blank.htm straight away.
const AUTH_URL = `${MY_ORIGIN}/_layouts/15/Authenticate.aspx?Source=${encodeURIComponent("/_layouts/15/blank.htm")}`;
const SIGN_IN_MS = 90_000, FRONT_AFTER_MS = 8_000;
const ACCEPT = { Accept: "application/json;odata=nometadata" };
const SCRIPT_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const enc = (p) => encodeURIComponent(p).replace(/%2F/g, "/").replace(/'/g, "''");

// ── reads, from the service worker ────────────────────────────────────────────
//
// SharePoint answers 403 both when the case isn't shared with you AND when the
// browser has no my.wal-mart.com session (FedAuth cookie) yet — e.g. a profile
// that never opened OneDrive (seen 2026-10-08 on the user's own account). So
// the first 401/403 opens the my.wal-mart.com host tab, which signs in through
// SSO and sets the cookie, then retries once.
// If it's still refused after that, the profile isn't sending the cookie on
// the extension's own requests (seen in the user's normal Edge, 2026-10-08,
// while debug Edge was fine) — from then on reads run inside that tab, where
// they're first-party.
let signInTried = 0, reauthTried = 0, readViaTab = false;
async function odFetch(url, opts = {}) {
  const inTab = async () => {
    const out = await odWrite({ op: "get", url: MY_ORIGIN + url, headers: opts.headers || {} });
    return { status: out.status, ok: out.status >= 200 && out.status < 300, viaTab: true, json: async () => JSON.parse(out.text) };
  };
  if (readViaTab) return inTab();
  const go = () => fetch(MY_ORIGIN + url, { credentials: "include", ...opts });
  const refused = (x) => x.status === 401 || x.status === 403;
  let r = await go();
  if (refused(r) && Date.now() - signInTried > 60_000) {
    signInTried = Date.now();
    await hostTab();
    r = await go();
  }
  if (refused(r)) {
    let t = await inTab();
    // Still refused inside the tab: that tab may predate the sign-in (or was
    // opened signed out) — reopen it through Authenticate.aspx once.
    if (!t.ok && refused(t) && Date.now() - reauthTried > 60_000) {
      reauthTried = Date.now();
      await hostTab({ fresh: true });
      t = await inTab();
    }
    if (t.ok) readViaTab = true;
    return t;
  }
  return r;
}

async function getJson(url) {
  const r = await odFetch(url, { headers: ACCEPT });
  if (r.status === 401 || r.status === 403) {
    console.warn("[punchlookup] OneDrive", r.status, r.viaTab ? "in tab" : "", url.split("?")[0]);
    // "refused access" is matched below (getMyProperties fallback) — keep it.
    throw new Error("OneDrive refused access. If it's someone else's case, ask them to share it with you; otherwise sign in to OneDrive and try again.");
  }
  if (r.status === 404) throw new Error("That case folder was not found (moved, deleted, or not shared with you).");
  if (!r.ok) { console.warn("[punchlookup] OneDrive HTTP", r.status, url.split("?")[0]); throw new Error("Couldn't reach OneDrive — try again."); }
  return r.json();
}

/** Walmart display names carry the user id: "Ann Brown - abr001a.s01458" → "Ann Brown". */
export const displayName = (s) => String(s || "").replace(/\s+-\s+[\w.]+$/, "").trim();

/** The signed-in user: { name, login, email, site: "/personal/xxx" }. */
// The user-profile service (GetMyProperties) answered 403 in the user's normal
// Edge on 2026-10-08, even in-page, while plain SharePoint calls worked; so
// fall back to web/currentuser and derive the OneDrive path from the login —
// OneDrive's own rule: ses008s.s01458@us.wal-mart.com → /personal/ses008s_s01458_us_wal-mart_com.
export const personalSiteFor = (login) => `/personal/${String(login).split("|").pop().toLowerCase().replace(/[.@]/g, "_")}`;

export async function whoAmI() {
  try {
    const p = await getJson("/_api/SP.UserProfiles.PeopleManager/GetMyProperties?$select=PersonalUrl,DisplayName,AccountName,Email");
    if (p.PersonalUrl) {
      const site = new URL(p.PersonalUrl).pathname.replace(/\/$/, "");
      return { name: displayName(p.DisplayName), login: p.AccountName, email: p.Email || "", site };
    }
  } catch (e) {
    if (!/refused access/.test(e.message)) throw e;
  }
  const u = await getJson("/_api/web/currentuser?$select=Title,LoginName,Email");
  return { name: displayName(u.Title), login: u.LoginName, email: u.Email || "", site: personalSiteFor(u.LoginName) };
}

/** Files in a folder: [{ name, modified, etag }]. */
export async function listFiles(site, folder) {
  const j = await getJson(`${site}/_api/web/GetFolderByServerRelativeUrl('${enc(folder)}')/Files?$select=Name,TimeLastModified,ETag`);
  return (j.value || []).map((f) => ({ name: f.Name, modified: f.TimeLastModified, etag: f.ETag }));
}

/** Sub-folders: [{ name, path, modified }]; [] when the folder doesn't exist yet. */
export async function listFolders(site, folder) {
  try {
    const j = await getJson(`${site}/_api/web/GetFolderByServerRelativeUrl('${enc(folder)}')/Folders?$select=Name,ServerRelativeUrl,TimeLastModified`);
    return (j.value || []).map((f) => ({ name: f.Name, path: f.ServerRelativeUrl, modified: f.TimeLastModified }));
  } catch (e) {
    if (/not found/.test(e.message)) return [];
    throw e;
  }
}

export async function readJson(site, path) {
  const r = await odFetch(`${site}/_api/web/GetFileByServerRelativeUrl('${enc(path)}')/$value`);
  if (!r.ok) throw new Error(`could not read ${path.split("/").pop()} (${r.status})`);
  return r.json();
}

/**
 * A pasted case link → { site, folder }. Accepts the suite's own link (the
 * OneDrive web URL with ?id=<folder>), a OneDrive sharing link
 * (my.wal-mart.com/:f:/g/personal/…, followed to where it lands), or a bare
 * server-relative path.
 */
export async function resolveCaseLink(text) {
  let s = String(text || "").trim();
  if (!s) throw new Error("Paste the case link.");
  if (/^https:\/\/my\.wal-mart\.com\/:f:\//i.test(s)) {
    const r = await fetch(s, { credentials: "include", redirect: "follow" });
    s = r.url;
  }
  let folder = null;
  try {
    const u = new URL(s);
    folder = u.searchParams.get("id") || (u.pathname.includes("/Documents/") ? decodeURIComponent(u.pathname) : null);
  } catch { if (s.startsWith("/personal/")) folder = s; }
  if (!folder || !/^\/personal\/[^/]+\/Documents\//.test(folder)) throw new Error("That doesn't look like a Punch Lookup case link.");
  return { site: folder.match(/^\/personal\/[^/]+/)[0], folder: folder.replace(/\/$/, "") };
}

export const caseUrl = ({ site, folder }) => `${MY_ORIGIN}${site}/_layouts/15/onedrive.aspx?id=${encodeURIComponent(folder)}`;

// ── writes, inside a my.wal-mart.com tab ─────────────────────────────────────
/**
 * Runs IN the my.wal-mart.com page (MAIN world). Serialised: no closures.
 *   { op: "get", url, headers }                         → { status, text }  (reads, when the SW's own fetch is refused)
 *   { op: "ensureFolders", site, paths: [path…] }       → { ok }
 *   { op: "write", site, folder, name, text }           → { ok }
 *   { op: "recycle", site, files: [path], folders: [path] } → { ok }
 *   { op: "people", site, query }                       → { people: [...] }
 *   { op: "share", site, folder, keys: [claimKey] }     → { ok, result }
 */
export async function odInPage(req) {
  const H = { Accept: "application/json;odata=nometadata" };
  const e = (p) => encodeURIComponent(p).replace(/%2F/g, "/").replace(/'/g, "''");
  try {
    if (req.op === "get") {
      const r = await fetch(req.url, { headers: req.headers });
      return { status: r.status, text: await r.text() };
    }
    const ctx = await fetch(`${req.site}/_api/contextinfo`, { method: "POST", headers: H });
    if (!ctx.ok) return { error: `OneDrive refused the save (${ctx.status}). Has the case been shared with you with edit rights?` };
    const digest = (await ctx.json()).FormDigestValue;
    const post = (url, body, extra = {}) => fetch(`${req.site}/_api/${url}`, { method: "POST", headers: { ...H, "X-RequestDigest": digest, ...extra }, body });
    const fail = async (r, what) => {
      const t = await r.text();
      return { error: `${what} failed (${r.status}): ${(t.match(/"value":"([^"]*)"/) || [])[1] || t.slice(0, 120)}` };
    };

    if (req.op === "ensureFolders") {
      for (const p of req.paths) {
        const r = await post(`web/folders/add(url='${e(p)}')`);
        if (!r.ok) return fail(r, `Creating ${p.split("/").pop()}`);
      }
      return { ok: true };
    }
    if (req.op === "write") {
      const r = await post(`web/GetFolderByServerRelativeUrl('${e(req.folder)}')/Files/add(url='${e(req.name)}',overwrite=true)`, req.text);
      return r.ok ? { ok: true } : fail(r, `Saving ${req.name}`);
    }
    if (req.op === "recycle") {
      for (const f of req.files || []) {
        const r = await post(`web/GetFileByServerRelativeUrl('${e(f)}')/recycle()`);
        if (!r.ok && r.status !== 404) return fail(r, "Deleting a file");
      }
      for (const f of req.folders || []) {
        const r = await post(`web/GetFolderByServerRelativeUrl('${e(f)}')/recycle()`);
        if (!r.ok && r.status !== 404) return fail(r, "Deleting the folder");
      }
      return { ok: true };
    }
    if (req.op === "people") {
      const r = await post("SP.UI.ApplicationPages.ClientPeoplePickerWebServiceInterface.clientPeoplePickerSearchUser", JSON.stringify({
        queryParams: { __metadata: { type: "SP.UI.ApplicationPages.ClientPeoplePickerQueryParameters" },
          AllowEmailAddresses: false, AllowMultipleEntities: false, AllUrlZones: false, MaximumEntitySuggestions: 12,
          PrincipalSource: 15, PrincipalType: 1, QueryString: req.query },
      }), { "Content-Type": "application/json;odata=verbose" });
      if (!r.ok) return fail(r, "People search");
      const list = JSON.parse((await r.json()).value || "[]");
      return { people: list.map((p) => ({ key: p.Key, name: p.DisplayText, title: p.EntityData?.Title || "", department: p.EntityData?.Department || "", email: p.EntityData?.Email || "" })) };
    }
    if (req.op === "share") {
      // ShareObject: grants the people edit rights on the folder ("role:1073741827"
      // = Contribute) and sends OneDrive's own notification email.
      const url = `${location.origin}${req.folder}`;
      const r = await post("SP.Web.ShareObject", JSON.stringify({
        url, peoplePickerInput: JSON.stringify(req.keys.map((k) => ({ Key: k, IsResolved: true }))),
        roleValue: "role:1073741827", groupId: 0, propagateAcl: false, sendEmail: true, includeAnonymousLinkInEmail: false,
        emailSubject: "Punch Lookup case shared with you",
        emailBody: "Open APAISuite → Punch Lookup → Cases and paste this folder's link to work on the case.",
        useSimplifiedRoles: true,
      }), { "Content-Type": "application/json;odata=nometadata" });
      if (!r.ok) return fail(r, "Sharing");
      const res = await r.json();
      if (res.StatusCode && res.StatusCode !== 0) return { error: `Sharing failed: ${res.ErrorMessage || res.StatusCode}` };
      return { ok: true };
    }
    return { error: `unknown op ${req.op}` };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

// The host tab is opened when needed and closed after a short idle; an alarm
// in module.js calls closeIdleHostTab() so a sleeping service worker can't
// leave it behind (the VizPick tab leak, 2026-09-15).
const TAB_KEY = "punchlookup.odTab";
export const HOST_TAB_ALARM = "punchlookup.odTab";
const IDLE_MS = 3 * 60_000;

async function hostTab({ fresh = false } = {}) {
  const saved = (await chrome.storage.session.get(TAB_KEY))[TAB_KEY];
  if (saved?.id && fresh) {
    await chrome.tabs.remove(saved.id).catch(() => {});
    await chrome.storage.session.remove(TAB_KEY);
  } else if (saved?.id) {
    const t = await chrome.tabs.get(saved.id).catch(() => null);
    if (t && t.url?.startsWith(HOST_URL) && t.status === "complete" && !t.discarded) {
      await chrome.storage.session.set({ [TAB_KEY]: { id: t.id, at: Date.now() } });
      return t;
    }
  }
  const tab = await chrome.tabs.create({ url: AUTH_URL, active: false });
  await chrome.storage.session.set({ [TAB_KEY]: { id: tab.id, at: Date.now() } });
  chrome.alarms.create(HOST_TAB_ALARM, { periodInMinutes: 1 });
  const t0 = Date.now();
  let front = false;
  while (Date.now() - t0 < SIGN_IN_MS) {
    const cur = await chrome.tabs.get(tab.id).catch(() => null);
    if (!cur) throw new Error("The OneDrive tab was closed before sign-in finished. Try again.");
    if (cur.status === "complete" && cur.url?.startsWith(HOST_URL)) {
      await chrome.storage.session.set({ [TAB_KEY]: { id: tab.id, at: Date.now() } });
      return cur;
    }
    // Sign-in wants the user (account pick, MFA): show it.
    if (!front && Date.now() - t0 > FRONT_AFTER_MS) {
      front = true;
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    }
    await sleep(700);
  }
  if (!front) chrome.tabs.remove(tab.id).catch(() => {});
  throw new Error("OneDrive sign-in didn't finish. Finish signing in in the OneDrive tab (my.wal-mart.com), then try again.");
}

export async function closeIdleHostTab(force = false) {
  const saved = (await chrome.storage.session.get(TAB_KEY))[TAB_KEY];
  if (!saved?.id) { chrome.alarms.clear(HOST_TAB_ALARM); return; }
  if (!force && Date.now() - saved.at < IDLE_MS) return;
  await chrome.tabs.remove(saved.id).catch(() => {});
  await chrome.storage.session.remove(TAB_KEY);
  chrome.alarms.clear(HOST_TAB_ALARM);
}

/** Run one write-side op in the host tab. */
export async function odWrite(req) {
  const tab = await hostTab();
  let timer;
  try {
    const [res] = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: odInPage, args: [req] }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("OneDrive stopped answering. Try again.")), SCRIPT_MS); }),
    ]);
    const out = res?.result;
    if (!out) throw new Error("OneDrive did not answer.");
    if (out.error) throw new Error(out.error);
    return out;
  } finally {
    clearTimeout(timer);
    chrome.storage.session.set({ [TAB_KEY]: { id: tab.id, at: Date.now() } }).catch(() => {});
  }
}
