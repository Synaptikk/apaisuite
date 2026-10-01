// Can this Medallia role see stores other than its own? Decisive for a
// market-wide comment view. Asks Medallia what the store field IS before
// trying to filter on it.
import puppeteer from "puppeteer-core";
const MARKET_120 = [658, 669, 756, 1089, 1215, 1458, 2988, 3660, 5151, 5173];
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 600000 });
let p = (await browser.pages()).find(x => /walmart\.medallia\.com/.test(x.url()));
if (!p) {
  p = await browser.newPage();
  await p.goto("https://walmart.medallia.com/sso/walmart/", { waitUntil: "domcontentloaded", timeout: 180000 });
  await new Promise(r => setTimeout(r, 15000));
}
console.log("anchor:", p.url().slice(0, 85));

const gql = (op, query, variables) => p.evaluate(async (o, q, v) => {
  const csrf = /csrfToken:\s*"([^"]+)"/.exec(document.documentElement.outerHTML)?.[1];
  const role = new URLSearchParams(location.search).get("roleId") || "";
  const r = await fetch(`/api-comp/reporting/query?view_as_role=${role}`, {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": csrf,
               "x-medallia-active-role-id": role, "x-medallia-reporting-query-data-view": "27" },
    body: JSON.stringify({ operationName: o, variables: v, query: q }),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 400) }; }
}, op, query, variables);

const err = (j) => j?.errors ? j.errors.map(e => e.message).join(" | ").slice(0, 220) : null;

console.log("\n=== 1. what kind of field is the store unit? ===");
const meta = await gql("fieldMeta", `
  query fieldMeta($dataView: DataView!) {
    fields(ids: ["e_walmart_voc_store_num_unit"], dataView: $dataView) {
      nodes { id name __typename
        ... on EnumField { options { id numericValue } }
      }
    }
  }`, { dataView: { id: "27" } });
const node = meta?.data?.fields?.nodes?.[0];
console.log(err(meta) ?? JSON.stringify({
  id: node?.id, name: node?.name, type: node?.__typename,
  optionCount: node?.options?.length ?? null,
  options: node?.options?.slice(0, 30).map(o => o.id) ?? null,
}));

console.log("\n=== 2. group the feedback BY store — what comes back? ===");
const grouped = await gql("byStore", `
  query byStore($dataView: DataView!, $filter: Filter) {
    aggregate(dataView: $dataView, filter: $filter,
      rowGroups: [{ segment: { field: { id: "e_walmart_voc_store_num_unit" } } }],
      columnGroups: [{ total: null }],
      metrics: [{ customCalculation: { name: "walmart_voc_Average", field: { id: "r_walmart_voc_count" } } }]
    ) { rows { key label values } }
  }`, {
  dataView: { id: "27" },
  filter: { fieldIds: ["k_walmart_voc_ltp_update_responsedate"], gte: "2026-09-01", lte: "2026-09-25" },
});
console.log(err(grouped) ?? JSON.stringify(grouped?.data ?? grouped).slice(0, 700));

console.log("\n=== 3. plain totalCount per store, label form ===");
const DF = "k_walmart_voc_ltp_update_responsedate";
for (const store of MARKET_120) {
  const res = await gql("cnt", `
    query cnt($filters: Filter, $dataView: DataView!) {
      feedback(filter: $filters, first: 1, dataView: $dataView) { totalCount }
    }`, {
    dataView: { id: "27" },
    filters: { and: [
      { fieldIds: [DF], gte: "2026-09-01", lte: "2026-09-25" },
      { fieldIds: ["e_walmart_voc_store_num_unit"], in: [String(store)] },
    ] },
  });
  console.log(`  ${store}: ${res?.data?.feedback?.totalCount ?? "ERR " + (err(res) ?? "?")}`);
}

console.log("\n=== 4. control: no store filter at all ===");
const ctl = await gql("cnt", `
  query cnt($filters: Filter, $dataView: DataView!) {
    feedback(filter: $filters, first: 1, dataView: $dataView) { totalCount }
  }`, { dataView: { id: "27" }, filters: { fieldIds: [DF], gte: "2026-09-01", lte: "2026-09-25" } });
console.log("  all visible:", ctl?.data?.feedback?.totalCount ?? err(ctl));

await browser.disconnect();
