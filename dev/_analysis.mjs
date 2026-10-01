// dev/_analysis.mjs — scratch. (1) ThirdPartyAgentTheft events at 1458 by reporter,
// (2) evidenceLockerView samples for the new livedashboard auror source.
import fs from "node:fs";
import { targets, connect, sleep } from "./_cdp.mjs";

const SITE_TRAIT = "SITE: WALMART 1458 - 3040 BATTLEFIELD PKWY, FORT OGLETHORPE, GA";
const feed = (await targets()).find(t => t.url.includes("auror.co/feed") || (t.url.includes("auror.co") && !t.url.includes("/edit")));
if (!feed) throw new Error("no auror tab");
const c = await connect(feed.id);
await c.send("Runtime.enable");
await c.send("Network.enable");
let jwt = null;
c.on(m => {
  if (m.method === "Network.requestWillBeSent") {
    const a = m.params.request.headers?.Authorization || m.params.request.headers?.authorization;
    if (a && a.startsWith("Bearer ")) jwt = a;
  }
});
// Provoke traffic for a token. setWebLifecycleState unfreezes a frozen
// background tab so the reload + evals don't hang.
await c.send("Page.enable");
await c.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
await c.send("Page.reload");
const t0 = Date.now();
while (!jwt && Date.now() - t0 < 45000) await sleep(1000);
if (!jwt) throw new Error("no JWT");
console.error("jwt ok");

async function api(path, params) {
  const url = `https://app.us.auror.co/api/spa${path}` + (params ? "?" + new URLSearchParams(params) : "");
  return c.evalJs(`(async () => {
    const r = await fetch(${JSON.stringify(url)}, { headers: { Authorization: ${JSON.stringify(jwt)}, "X-Requested-With": "XMLHttpRequest" } });
    if (!r.ok) return { __err: r.status };
    return r.json();
  })()`);
}

// 1. All ThirdPartyAgentTheft events at 1458, all time.
const all = [];
let total = null;
for (let skip = 0; skip < 2000; skip += 10) {
  const d = await api("/GlobalSearch/globalSearch", {
    searchString: "", skip: String(skip), includeTotalResultCount: "true",
    intelTypeFilters: "Event", siteTraits: SITE_TRAIT,
    eventTypeFilters: "ThirdPartyAgentTheft",
    timeRangeFilter: "", startDate: "", endDate: "",
  });
  if (d.__err) throw new Error("globalSearch " + d.__err);
  const rows = d.searchResults ?? [];
  all.push(...rows);
  total ??= d.totalResultCount;
  if (rows.length < 10 || all.length >= total) break;
}
console.error(`third-party events at 1458: ${all.length}`);

const events = [];
for (const r2 of all) {
  const id = String(r2.resourceLocator || "").replace(/^e/, "");
  const p = await api(`/EventProfile/event/${id}`);
  if (p.__err) { events.push({ id, err: p.__err }); continue; }
  events.push({
    id,
    date: (p.eventHeroCardView?.occurredAt || "").slice(0, 10),
    reporter: p.eventProfileResult?.eventInternalInfo?.reporterInfoView?.name ?? null,
    people: (p.eventProfileResult?.eventPersons ?? []).map(x => ({ pid: x.identityGroupId, name: x.identityGroupPrimaryIdentifier })),
    value: r2.totalValue,
  });
  process.stderr.write(".");
}
console.error("");

// 2. Evidence locker samples from three recent events (any type).
const recent = await api("/GlobalSearch/globalSearch", {
  searchString: "", skip: "0", includeTotalResultCount: "true",
  intelTypeFilters: "Event", siteTraits: SITE_TRAIT,
  timeRangeFilter: "Last30days", startDate: "", endDate: "",
});
const lockerSamples = [];
for (const r3 of (recent.searchResults ?? []).slice(0, 4)) {
  const id = String(r3.resourceLocator || "").replace(/^e/, "");
  const p = await api(`/EventProfile/event/${id}`);
  lockerSamples.push({ id, type: r3.eventType, locker: p?.evidenceLockerView ?? null });
}

fs.writeFileSync(new URL("./_analysis-out.json", import.meta.url), JSON.stringify({ totalThirdParty: all.length, events, lockerSamples }, null, 1));
console.error("wrote dev/_analysis-out.json");
c.close();
