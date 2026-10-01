// dev/_omni-audit.mjs — scratch, not committed.
// Pull all events at store 1458, keep the omni-channel-typed ones, and dump
// full details for review (was it really third-party shopper/delivery theft?).
// Raw CDP (single target) — puppeteer attach hangs on frozen tabs.
import fs from "node:fs";

const SITE_TRAIT = "SITE: WALMART 1458 - 3040 BATTLEFIELD PKWY, FORT OGLETHORPE, GA";
const BASE = "https://app.us.auror.co/api/spa";
const OUT = new URL("./_omni-audit-out.json", import.meta.url);

const list = async () => (await fetch("http://127.0.0.1:9222/json/list")).json();

let targets = await list();
let tab = targets.find(t => t.type === "page" && t.url.startsWith("https://app.us.auror.co"));
let opened = false;
if (!tab) {
  const r = await fetch("http://127.0.0.1:9222/json/new?url=https://app.us.auror.co/", { method: "PUT" });
  tab = await r.json();
  opened = true;
  await new Promise(r2 => setTimeout(r2, 4000));
  targets = await list();
  tab = targets.find(t => t.id === tab.id) ?? tab;
}
console.error("Tab:", tab.id, tab.url);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
let jwt = null;
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  if (m.method === "Network.requestWillBeSent") {
    const a = m.params.request.headers?.Authorization || m.params.request.headers?.authorization;
    if (a && a.startsWith("Bearer ")) jwt = a;
  }
};
const send = (method, params = {}, timeout = 240000) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + " timed out")); } }, timeout);
});

await send("Network.enable");
await send("Runtime.enable");
await send("Page.enable").catch(() => {});
if (!tab.url.startsWith("https://app.us.auror.co")) {
  console.error("Navigating tab to Auror…");
  await send("Page.navigate", { url: "https://app.us.auror.co/" });
  await new Promise(r => setTimeout(r, 8000));
}

// Wait for a Bearer token from the SPA's own traffic; reload once to provoke it.
const t0 = Date.now();
let reloaded = false;
while (!jwt && Date.now() - t0 < 90000) {
  await new Promise(r => setTimeout(r, 1000));
  if (!jwt && !reloaded && Date.now() - t0 > 25000) {
    reloaded = true;
    await send("Page.reload").catch(() => {});
  }
}
if (!jwt) throw new Error("No Bearer token captured — is Auror signed in in the debug Edge?");
console.error("JWT captured.");

async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}
async function api(path, params) {
  const url = `${BASE}${path}` + (params ? "?" + new URLSearchParams(params) : "");
  const d = await evalJs(`(async () => {
    const r = await fetch(${JSON.stringify(url)}, { headers: { Authorization: ${JSON.stringify(jwt)}, "X-Requested-With": "XMLHttpRequest" } });
    if (!r.ok) return { __err: r.status, __body: (await r.text().catch(() => "")).slice(0, 300) };
    return r.json();
  })()`);
  return d;
}

// All events at 1458, all time (timeRangeFilter="" + empty dates), paged by 10.
const all = [];
let total = null;
for (let skip = 0; skip < 5000; skip += 10) {
  const d = await api("/GlobalSearch/globalSearch", {
    searchString: "", skip: String(skip), includeTotalResultCount: "true",
    intelTypeFilters: "Event", siteTraits: SITE_TRAIT,
    timeRangeFilter: "", startDate: "", endDate: "",
  });
  if (d.__err) throw new Error(`globalSearch HTTP ${d.__err}: ${d.__body}`);
  const rows = d.searchResults ?? [];
  all.push(...rows);
  total ??= d.totalResultCount;
  if (skip === 0) console.error(`server total: ${total}`);
  if (rows.length < 10 || all.length >= total) break;
  if (all.length % 100 === 0) process.stderr.write("|");
}
console.error(`\nEvents at 1458 fetched: ${all.length}`);

const typeCounts = {};
for (const r of all) typeCounts[r.eventType] = (typeCounts[r.eventType] || 0) + 1;
console.error("Event types:", JSON.stringify(typeCounts, null, 1));

const omni = all.filter(r => /omni/i.test(r.eventType || "") || /omni/i.test(r.primaryIdentifier || ""));
console.error(`Omni-typed events: ${omni.length}`);

const details = [];
for (const r of omni) {
  const id = String(r.resourceLocator || "").replace(/^e/, "");
  const p = await api(`/EventProfile/event/${id}`);
  if (p.__err) { details.push({ eventId: id, error: p.__err }); continue; }
  const res = p.eventProfileResult ?? {};
  const hero = p.eventHeroCardView ?? {};
  details.push({
    eventId: id,
    url: `https://app.us.auror.co/events/e${id}`,
    eventType: hero.eventType ?? r.eventType,
    occurredAt: hero.occurredAt ?? r.localOccurredAt,
    totalValue: r.totalValue,
    recovered: hero.totalRecoveredValue,
    title: r.primaryIdentifier,
    zoneOrRoom: hero.zoneOrRoom,
    additionalDetails: res.eventInternalInfo?.additionalDetails ?? null,
    reporter: res.eventInternalInfo?.reporterInfoView ?? null,
    products: (res.eventProducts ?? []).map(x => ({ name: x.name, qty: x.quantity, price: x.price })),
    people: (res.eventPersons ?? []).map(x => ({
      id: x.identityGroupId, name: x.identityGroupPrimaryIdentifier,
      fields: (x.personEventDetailsFields ?? []).map(f => `${f.key}=${f.value}${f.notes ? " / " + f.notes : ""}`),
    })),
    vehicles: (res.eventVehicles ?? []).map(v => ({ plate: v.identityGroupPrimaryIdentifier, make: v.make, color: v.color ?? v.vehicleColor, type: v.type ?? v.vehicleType })),
    police: res.policeInformation ?? null,
  });
  process.stderr.write(".");
}
console.error("");
fs.writeFileSync(OUT, JSON.stringify({ typeCounts, totalAt1458: all.length, omniCount: omni.length, details }, null, 1));
console.error(`Wrote ${OUT.pathname}`);

if (opened) await fetch(`http://127.0.0.1:9222/json/close/${tab.id}`).catch(() => {});
ws.close();
