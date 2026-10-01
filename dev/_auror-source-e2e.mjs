// dev/_auror-source-e2e.mjs — scratch. Validate the auror source's data path
// over CDP with the module's own pure functions (trait resolution, listing,
// classification), since the SW can't run outside the extension.
import { targets, connect, sleep } from "./_cdp.mjs";
import { classifyEvidence, missingFor, extractLockerFiles } from "../modules/livedashboard/lib/sources/auror.js";

const STORE = process.argv[2] || "1458";
const DAYS = 30;
const tab = (await targets()).find(t => t.url.includes("auror.co") && !t.url.includes("/edit"));
const c = await connect(tab.id);
await c.send("Runtime.enable");
await c.send("Network.enable");
await c.send("Page.enable");
let jwt = null;
c.on(m => {
  if (m.method === "Network.requestWillBeSent") {
    const a = m.params.request.headers?.Authorization || m.params.request.headers?.authorization;
    if (a && a.startsWith("Bearer ")) jwt = a;
  }
});
await c.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
await c.send("Page.reload");
const t0 = Date.now();
while (!jwt && Date.now() - t0 < 45000) await sleep(1000);
if (!jwt) throw new Error("no JWT");

async function api(path, params) {
  const url = `https://app.us.auror.co/api/spa${path}` + (params ? "?" + new URLSearchParams(params) : "");
  const r = await c.evalJs(`(async () => {
    const r = await fetch(${JSON.stringify(url)}, { headers: { Authorization: ${JSON.stringify(jwt)}, "X-Requested-With": "XMLHttpRequest" } });
    if (!r.ok) return { __err: r.status };
    return r.json();
  })()`);
  if (r?.__err) throw new Error(`HTTP ${r.__err} ${path}`);
  return r;
}

// 1. trait resolution exactly as the source does it
const found = await api(`/Sites/organizations/12/searchable-sites`, { search: STORE });
const site = (found?.items ?? []).find(s => String(s.primaryIdentifier) === STORE);
console.log("site:", site?.id, site?.name);
const profile = await api(`/SiteDashboard/${site.id}/profile`);
const trait = (profile?.siteTraits ?? []).find(t => t.key === "SITE");
const siteTrait = `SITE: ${trait.value}`;
console.log("trait:", JSON.stringify(siteTrait));

// 2. events, custom window
const ymd = d => d.toISOString().slice(0, 10);
const end = new Date(), start = new Date(end.getTime() - DAYS * 86400000);
const all = [];
let total = null;
for (let skip = 0; skip < 120; skip += 10) {
  const d = await api("/GlobalSearch/globalSearch", {
    searchString: "", skip: String(skip), includeTotalResultCount: "true",
    intelTypeFilters: "Event", siteTraits: siteTrait,
    timeRangeFilter: "", startDate: ymd(start), endDate: ymd(end),
  });
  const rows = d?.searchResults ?? [];
  all.push(...rows);
  total ??= d?.totalResultCount ?? 0;
  if (rows.length < 10 || all.length >= total) break;
}
console.log(`events in ${DAYS}d:`, all.length, "(server total", total + ")");

// 3. per-event evidence
const EXEMPT = new Set(["GeneralIntel", "DeniedEntry", "PersonOfInterest", "BreachOfTrespass"]);
const flagged = [];
let checked = 0;
for (const ev of all) {
  if (EXEMPT.has(ev.eventType)) continue;
  const id = String(ev.resourceLocator || "").replace(/^e/, "");
  const p = await api(`/EventProfile/event/${id}`).catch(() => null);
  if (!p) continue;
  checked++;
  const counts = classifyEvidence(extractLockerFiles(p));
  const missing = missingFor(counts);
  if (missing.length) flagged.push({ id, type: ev.eventType, date: (ev.occurredAt || "").slice(0, 10), ...counts, missing: missing.join("+") });
}
console.log(`checked ${checked}, flagged ${flagged.length}`);
for (const f of flagged) console.log(" ", f.date, "e" + f.id, f.type, `v${f.videoCount}/p${f.photoCount}/s${f.statementCount}`, "missing:", f.missing);
c.close();
