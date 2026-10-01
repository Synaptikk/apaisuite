// Can the service worker reach Medallia directly, with no tab at all?
// Needs two things to be true: the SW fetch must carry the SAML session cookies
// (host_permissions covers walmart.medallia.com), and the landing HTML must
// contain the csrfToken. If both hold, the entire anchor-tab mechanism — and
// every frozen-tab failure with it — can be deleted.
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const sw = targets.find(t => t.type === "service_worker" && t.url.includes(EXT));
if (!sw) { console.log("SW not running — open the shell first"); process.exit(1); }
const ws = new WebSocket(sw.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const call = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
await new Promise(r => { ws.onopen = r; });
await call("Runtime.enable");

const expr = `(async () => {
  const out = {};

  // 1. Does the SW see the session cookies at all?
  try {
    const cookies = await chrome.cookies.getAll({ domain: "walmart.medallia.com" });
    out.cookies = { count: cookies.length, names: cookies.map(c => c.name).slice(0, 12),
                    sameSite: [...new Set(cookies.map(c => c.sameSite))] };
  } catch (e) { out.cookies = { err: String(e && e.message) }; }

  // 2. Does a credentialed SW fetch of the landing page come back signed in,
  //    and does the HTML carry the csrfToken?
  try {
    const r = await fetch("https://walmart.medallia.com/sso/walmart/", { credentials: "include", redirect: "follow" });
    const html = await r.text();
    const m = /csrfToken:\s*"([^"]+)"/.exec(html);
    const role = /roleId[=:"\s]+(\d{4,8})/.exec(html);
    out.landing = { status: r.status, finalUrl: r.url.slice(0, 120), bytes: html.length,
                    hasCsrf: !!m, csrfLen: m ? m[1].length : 0, roleGuess: role ? role[1] : null,
                    looksLikeLogin: /samlRequest|ssoLoginRequest|logonSubmit|Sign in/i.test(html.slice(0, 4000)) };
    out.__csrf = m ? m[1] : null;
    out.__role = role ? role[1] : null;
  } catch (e) { out.landing = { err: String(e && e.message) }; }

  // 3. If we got a token, can the SW post the real query with it?
  if (out.__csrf && out.__role) {
    try {
      const body = { operationName: "ping", variables: {}, query: "query ping { __typename }" };
      const r2 = await fetch("https://walmart.medallia.com/api-comp/reporting/query?view_as_role=" + out.__role, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json",
                   "x-csrf-token": out.__csrf, "x-medallia-active-role-id": out.__role,
                   "x-medallia-reporting-query-data-view": "27" },
        body: JSON.stringify(body),
      });
      const t = await r2.text();
      out.post = { status: r2.status, body: t.slice(0, 300) };
    } catch (e) { out.post = { err: String(e && e.message) }; }
  }
  delete out.__csrf; delete out.__role;
  return out;
})()`;

const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
console.log(r.exceptionDetails ? ("THREW: " + r.exceptionDetails.text) : JSON.stringify(r.result.value, null, 1));
ws.close();
