// Definitive: sample responses with NO store filter and no has-comment filter,
// and look at the distinct subjects. If they are all 1458, the role is
// store-scoped and a market-wide comment view is impossible from this account.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 600000 });
let p = (await browser.pages()).find(x => /walmart\.medallia\.com/.test(x.url()));
if (!p) { p = await browser.newPage();
  await p.goto("https://walmart.medallia.com/sso/walmart/", { waitUntil: "domcontentloaded", timeout: 180000 });
  await new Promise(r => setTimeout(r, 15000)); }

const gql = (op, query, variables) => p.evaluate(async (o, q, v) => {
  const csrf = /csrfToken:\s*"([^"]+)"/.exec(document.documentElement.outerHTML)?.[1];
  const role = new URLSearchParams(location.search).get("roleId") || "";
  const r = await fetch(`/api-comp/reporting/query?view_as_role=${role}`, {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": csrf,
               "x-medallia-active-role-id": role, "x-medallia-reporting-query-data-view": "27" },
    body: JSON.stringify({ operationName: o, variables: v, query: q }),
  });
  const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; }
}, op, query, variables);

const DF = "k_walmart_voc_ltp_update_responsedate";
const res = await gql("scope", `
  query scope($filters: Filter, $dataView: DataView!, $limit: Int!) {
    feedback(filter: $filters, first: $limit, dataView: $dataView) {
      totalCount
      nodes {
        subject: fieldLabels(fieldId: "k_walmart_voc_store_source_concat_txt")
        storeNum: fieldLabels(fieldId: "e_walmart_voc_store_num_unit")
      }
    }
  }`, {
  dataView: { id: "27" }, limit: 1000,
  filters: { fieldIds: [DF], gte: "2026-09-01", lte: "2026-09-25" },
});

if (res?.errors) { console.log("ERR:", res.errors.map(e => e.message).join(" | ").slice(0, 400)); }
else {
  const nodes = res.data.feedback.nodes;
  console.log("totalCount (all Sept responses visible):", res.data.feedback.totalCount);
  console.log("sampled:", nodes.length);
  const subjects = new Map(), stores = new Map();
  for (const n of nodes) {
    for (const s of n.subject ?? []) subjects.set(s, (subjects.get(s) ?? 0) + 1);
    for (const s of n.storeNum ?? []) stores.set(s, (stores.get(s) ?? 0) + 1);
  }
  console.log("\ndistinct store numbers in the sample:", stores.size);
  for (const [k, v] of [...stores].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${String(v).padStart(5)}  ${k}`);
  console.log("\ndistinct subjects:", subjects.size);
  for (const [k, v] of [...subjects].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(v).padStart(5)}  ${k}`);
}
await browser.disconnect();
