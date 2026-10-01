// Two questions, both decisive for a market-wide Cx view:
//   1. Which stores can this Medallia ROLE see? (store scoping is implicit in
//      the role, so if it is store-scoped there is nothing to aggregate.)
//   2. Does Hoops answer for other stores' buIds, and is there a market buType?
import puppeteer from "puppeteer-core";

const MARKET_120 = [658, 669, 756, 1089, 1215, 1458, 2988, 3660, 5151, 5173];
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 600000 });

// ── 1. Medallia role scope ──────────────────────────────────────────────
let mp = (await browser.pages()).find(p => /walmart\.medallia\.com/.test(p.url()));
if (!mp) {
  mp = await browser.newPage();
  await mp.goto("https://walmart.medallia.com/sso/walmart/", { waitUntil: "domcontentloaded", timeout: 180000 });
  await new Promise(r => setTimeout(r, 15000));
}
console.log("medallia anchor:", mp.url().slice(0, 80));

const gql = (page, op, query, variables) => page.evaluate(async (o, q, v) => {
  const csrf = /csrfToken:\s*"([^"]+)"/.exec(document.documentElement.outerHTML)?.[1];
  const role = new URLSearchParams(location.search).get("roleId") || "";
  const r = await fetch(`/api-comp/reporting/query?view_as_role=${role}`, {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": csrf,
               "x-medallia-active-role-id": role, "x-medallia-reporting-query-data-view": "27" },
    body: JSON.stringify({ operationName: o, variables: v, query: q }),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; }
}, op, query, variables);

console.log("\n=== which store values does the role expose? ===");
const opts = await gql(mp, "storeOptions", `
  query storeOptions($id: ID!, $dataView: DataView!) {
    fields(ids: [$id], dataView: $dataView) {
      nodes { id ... on EnumField { options { id } } }
    }
  }`, { id: "e_walmart_voc_store_num_unit", dataView: { id: "27" } });
const optionIds = opts?.data?.fields?.nodes?.[0]?.options?.map(o => o.id) ?? null;
console.log(optionIds ? `options visible: ${optionIds.length}` : JSON.stringify(opts).slice(0, 400));
if (optionIds) console.log("  sample:", optionIds.slice(0, 25).join(", "));

console.log("\n=== does a comment query for OTHER market-120 stores return anything? ===");
const DF = "k_walmart_voc_ltp_update_responsedate";
for (const store of MARKET_120) {
  const res = await gql(mp, "storeCount", `
    query storeCount($filters: Filter, $dataView: DataView!) {
      feedback(filter: $filters, first: 1, dataView: $dataView) { totalCount }
    }`, {
    dataView: { id: "27" },
    filters: { and: [
      { fieldIds: [DF], gte: "2026-08-01", lte: "2026-09-25" },
      { fieldIds: ["e_walmart_voc_store_num_unit"], in: [String(store)] },
    ] },
  });
  const n = res?.data?.feedback?.totalCount;
  console.log(`  store ${store}: ${n ?? "ERR " + JSON.stringify(res?.errors ?? res).slice(0, 120)}`);
}

// ── 2. Hoops per-store + market buType ──────────────────────────────────
const hp = await browser.newPage();
await hp.goto("https://hoops.wal-mart.com/ops-portal/metrics/overview?bu=1458&buType=6", { waitUntil: "domcontentloaded", timeout: 120000 });
await new Promise(r => setTimeout(r, 9000));

console.log("\n=== Hoops NPS for every market-120 store (buType 6) ===");
const hoops = await hp.evaluate(async (stores) => {
  const call = async (proc, json) => {
    const u = `/ops-portal/v1/trpc/${proc}?input=${encodeURIComponent(JSON.stringify({ json }))}`;
    const r = await fetch(u, { credentials: "include", headers: { accept: "application/json" } });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 160) }; }
  };
  const out = { stores: [], marketProbe: [] };
  for (const s of stores) {
    const j = await call("metric.cx.megaCard.nps", { buId: s, buType: 6, timeType: 202 });
    const g = j?.result?.data?.json;
    const rows = g?.rows ?? [];
    const cols = g?.meta?.columns ?? [];
    const ty = cols.indexOf("netPromotorScore_Ty454"), ly = cols.indexOf("netPromotorScore_Ly454");
    const last = [...rows].reverse().find(r => r[ty] != null);
    out.stores.push({ store: s, ok: !!g, weeks: rows.length,
                      latest: last ? { period: last[4], ty: last[ty], ly: last[ly] } : null,
                      err: j?.error?.json?.message?.slice(0, 90) ?? null });
  }
  // Is market 120 itself addressable? Try the plausible buTypes.
  for (const bt of [1, 2, 3, 4, 5, 7, 8]) {
    const j = await call("metric.cx.megaCard.nps", { buId: 120, buType: bt, timeType: 202 });
    const rows = j?.result?.data?.json?.rows ?? [];
    const cols = j?.result?.data?.json?.meta?.columns ?? [];
    const ty = cols.indexOf("netPromotorScore_Ty454");
    const last = [...rows].reverse().find(r => r[ty] != null);
    out.marketProbe.push({ buType: bt, rows: rows.length, latestTy: last ? last[ty] : null,
                           err: j?.error?.json?.message?.slice(0, 70) ?? null });
  }
  return out;
}, MARKET_120);

for (const s of hoops.stores) {
  console.log(`  ${s.store}: ${s.ok ? `${s.weeks}w  latest ${s.latest ? s.latest.period + " TY " + s.latest.ty + " / LY " + s.latest.ly : "(no data)"}` : "FAILED " + s.err}`);
}
console.log("\n=== is market 120 addressable as one buId? ===");
for (const m of hoops.marketProbe) console.log(`  buType ${m.buType}: rows=${m.rows} latestTy=${m.latestTy} ${m.err ?? ""}`);

await hp.close();
await browser.disconnect();
