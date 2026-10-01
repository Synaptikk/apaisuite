// dev/orcmonitor-cache-check.mjs
// Offline check of the orcmonitor incremental pull: runs service.js's
// analyzeThreats against a mock Auror (fetch + chrome.* stubs, fake-indexeddb)
// and counts the calls each run makes.
//
//   node dev/orcmonitor-cache-check.mjs
//
// Expect: run 1 fetches every event and person; run 2 fetches none; run 3
// (one new event for a known person) fetches that event and that person only.

import "fake-indexeddb/auto";

const iso = n => new Date(Date.now() - n * 86400000).toISOString();
const mem = { session: {}, local: {} };
const area = name => ({
  get: async k => {
    if (k == null) return { ...mem[name] };
    const out = {};
    for (const x of [].concat(k)) if (x in mem[name]) out[x] = mem[name][x];
    return out;
  },
  set: async o => { Object.assign(mem[name], o); },
  remove: async k => { for (const x of [].concat(k)) delete mem[name][x]; },
});
globalThis.chrome = {
  storage: { session: area("session"), local: area("local"), sync: area("local"), onChanged: { addListener() {} } },
  tabs: { query: async () => [], create: async () => ({ id: 1 }), get: async () => null, remove: async () => {}, reload: async () => {} },
  runtime: { getURL: p => p, sendMessage: async () => {} },
  scripting: { executeScript: async () => [] },
};
mem.session["orcmonitor.auror.jwt"] = { value: "Bearer test", at: Date.now() };
const { setCapturedHeader } = await import("../shared/captured_headers.js");
setCapturedHeader("orcmonitor.auror.jwt", "Bearer test", Date.now());

// ── Mock Auror ────────────────────────────────────────────────────────────────
// 3 events in region 12 (older than the 7-day re-check window), two people.
const events = [
  { id: "101", site: "669 - x, Dalton, GA", occ: iso(20), persons: ["p1", "p2"] },
  { id: "102", site: "1215 - x, Calhoun, GA", occ: iso(15), persons: ["p1"] },
  { id: "103", site: "3660 - x, Chattanooga, TN", occ: iso(10), persons: ["p3"] },
];
const SITES = { "669": [34.7675, -84.9304], "1215": [34.4794, -84.9457], "3660": [35.0155, -85.3765], "1458": [34.9362, -85.2152] };
const calls = {};
const hit = k => { calls[k] = (calls[k] ?? 0) + 1; };
const json = o => ({ ok: true, status: 200, json: async () => o });
globalThis.fetch = async url => {
  const u = new URL(url);
  const p = u.pathname.replace("/api/spa", "");
  if (p === "/GlobalSearch/globalSearch") {
    hit("search");
    const region = u.searchParams.get("siteTraits");
    const rows = region === "REGION: 12" ? events : [];
    const skip = Number(u.searchParams.get("skip"));
    return json({ totalResultCount: rows.length, searchResults: rows.slice(skip, skip + 10).map(e => ({
      resourceLocator: "e" + e.id, occurredAt: e.occ, description: "Walmart " + e.site })) });
  }
  if (p.startsWith("/EventProfile/event/")) {
    hit("eventProfile");
    const e = events.find(x => x.id === p.split("/").pop());
    return json({ eventProfileResult: { eventPersons: e.persons.map(id => ({ identityGroupId: id })) } });
  }
  if (p.startsWith("/PersonProfile/person/")) {
    hit("personProfile");
    const pid = p.split("/").pop();
    const mine = events.filter(e => e.persons.includes(pid));
    return json({
      heroCardView: { primaryIdentifier: "Person " + pid, totalCountOfEvents: mine.length, lastActivity: mine.at(-1).occ, totalMoneyValue: { value: 500 } },
      personLocationCardView: { eventsPerMarker: mine.map(e => { const n = e.site.split(" ")[0]; return { name: "Walmart " + e.site, latitude: String(SITES[n][0]), longitude: String(SITES[n][1]), eventCount: 1 }; }) },
      associatedPersons: [], associatedVehicles: [],
    });
  }
  if (p.startsWith("/ProfileFeed/p")) {
    hit("profileFeed");
    const pid = p.replace("/ProfileFeed/p", "");
    return json({ groups: [{ items: events.filter(e => e.persons.includes(pid)).map(e => ({
      activityType: "EventCreated", objectId: "e" + e.id,
      propsBag: { SiteName: "Walmart " + e.site, LocalOccurredAt: e.occ.slice(0, 19), EventType: "Shoptheft", TotalValue: "$100" } })) }] });
  }
  if (p.startsWith("/RegionDashboard/12/siteStats")) {
    hit("siteStats");
    return json(Object.entries(SITES).map(([n, [lat, lon]], i) => ({ siteId: String(i + 1), siteName: `Walmart ${n} - x, Town, ST`, siteLatitude: lat, siteLongitude: lon })));
  }
  if (p.startsWith("/SiteDashboard/")) { hit("siteProfile"); return json({ siteTraits: [{ key: "WALMART MARKET", value: "120" }] }); }
  throw new Error("unmocked " + url);
};

const { handlers } = await import("../modules/orcmonitor/service.js");
const run = async label => {
  for (const k of Object.keys(calls)) delete calls[k];
  const r = await handlers.analyzeThreats({ targetStore: "1458", days: 30 });
  const people = r.threats.map(t => t.personId).sort().join(",");
  console.log(`${label}: events ${r.eventsScanned}, people [${people}], fetched ${JSON.stringify(r.fetched)}, calls ${JSON.stringify(calls)}`);
  return r;
};

const r1 = await run("run 1 (empty cache)");
const r2 = await run("run 2 (nothing new)");
events.push({ id: "104", site: "669 - x, Dalton, GA", occ: iso(9), persons: ["p3"] });
const r3 = await run("run 3 (new event, known person)");
const r4 = await handlers.analyzeThreats({ targetStore: "1458", days: 30, full: true });
console.log(`run 4 (full refresh): fetched ${JSON.stringify(r4.fetched)}`);

const ok = r1.fetched.events === 3 && r1.fetched.people === 3
  && r2.fetched.events === 0 && r2.fetched.people === 0
  && r3.fetched.events === 1 && r3.fetched.people === 1
  && r4.fetched.events === 4 && r4.fetched.people === 3
  && r1.threats.length === r2.threats.length;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
