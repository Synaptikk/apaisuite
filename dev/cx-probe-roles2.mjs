// The dashboard URL carries `fi.segment-ranker=e_walmart_voc_store_num_unit` —
// a STORE ranker. If the role could see more than one store, ranking by store
// would return more than one row. That is the decisive test.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 200000 });
let p = (await browser.pages()).find(x => /walmart\.medallia\.com/.test(x.url()));
if (!p) {
  p = await browser.newPage();
  await p.goto("https://walmart.medallia.com/sso/walmart/", { waitUntil: "domcontentloaded", timeout: 180000 });
  await new Promise(r => setTimeout(r, 15000));
}

const gql = (op, query, variables = {}) => p.evaluate(async (o, q, v) => {
  const csrf = /csrfToken:\s*"([^"]+)"/.exec(document.documentElement.outerHTML)?.[1];
  const role = new URLSearchParams(location.search).get("roleId") || "";
  const r = await fetch(`/api-comp/reporting/query?view_as_role=${role}`, {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": csrf,
               "x-medallia-active-role-id": role, "x-medallia-reporting-query-data-view": "27" },
    body: JSON.stringify({ operationName: o, variables: v, query: q }),
  });
  const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 400) }; }
}, op, query, variables);
const err = (j) => j?.errors ? j.errors.map(e => e.message).join(" | ").slice(0, 260) : null;

console.log("=== rank the feedback BY store: how many stores come back? ===");
const ranked = await gql("byStore", `
  query byStore($dataView: DataView!, $filter: Filter) {
    feedback(filter: $filter, first: 0, dataView: $dataView) { totalCount }
    segments: fieldValues(
      dataView: $dataView
      fieldId: "e_walmart_voc_store_num_unit"
      filter: $filter
      first: 50
    ) { nodes { value label } }
  }`, {
  dataView: { id: "27" },
  filter: { fieldIds: ["k_walmart_voc_ltp_update_responsedate"], gte: "2026-09-01", lte: "2026-09-25" },
});
console.log(err(ranked) ?? JSON.stringify(ranked?.data ?? ranked).slice(0, 700));

console.log("\n=== who am I, per the app's own me query ===");
const me = await gql("meCheck", `query meCheck { me { id impersonator } }`);
console.log(err(me) ?? JSON.stringify(me?.data ?? me).slice(0, 400));
await browser.disconnect();
