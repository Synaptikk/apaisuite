import puppeteer from "puppeteer-core";
import fs from "node:fs";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
let page = (await browser.pages()).find(p => /walmart\.medallia\.com/.test(p.url()));
if (!page) { page = await browser.newPage();
  await page.goto("https://walmart.medallia.com/sso/walmart/", { waitUntil: "domcontentloaded", timeout: 180000 });
  await new Promise(r => setTimeout(r, 14000)); }
const QUERY = fs.readFileSync("cx-comments-query.graphql", "utf8");
const CF = ["q_walmart_voc_store_ovrl_exprc_cmt","q_walmart_voc_ogp_customer_comments_cmt",
  "q_walmart_voc_ogp_ltr_recommend_cmt","q_walmart_voc_ogp_what_went_wrong_cmt",
  "q_walmart_voc_store_rating_reason_cmt","q_walmart_voc_scan_go_ltr_trans_cmt",
  "q_walmart_voc_store_fin_service_osat_cmt","q_walmart_voc_store_fuel_osat_reason_cmt",
  "q_walmart_voc_store_ltr_auto_care_cntr_reason_cmt"];
const DF = "k_walmart_voc_ltp_update_responsedate";
for (const limit of [200, 500, 1000, 2000]) {
  const t0 = Date.now();
  const r = await page.evaluate(async (query, variables) => {
    const csrf = /csrfToken:\s*"([^"]+)"/.exec(document.documentElement.outerHTML)?.[1];
    const role = new URLSearchParams(location.search).get("roleId") || "";
    const res = await fetch(`/api-comp/reporting/query?view_as_role=${role}`, { method: "POST", credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": csrf,
                 "x-medallia-active-role-id": role, "x-medallia-reporting-query-data-view": "27" },
      body: JSON.stringify({ operationName: "cxComments", variables, query }) });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { return { raw: t.slice(0,300) }; }
    return { errors: j.errors ? JSON.stringify(j.errors).slice(0,300) : null,
             n: j.data?.feedback?.nodes?.length ?? null, total: j.data?.feedback?.totalCount ?? null, bytes: t.length };
  }, QUERY, {
    limit, offset: null, dataView: { id: "27" }, dateField: DF, commentFieldIds: CF,
    scoreFieldIds: ["a_overall_score_with_social_media_5_buckets"],
    journeyFieldId: "k_walmart_voc_journey_type_filter_alt",
    subjectFieldId: "k_walmart_voc_store_source_concat_txt",
    taFilter: [{ commentFields: CF, level: 1, personas: [], tagpools: ["27","33","37"], topicType: "RULE", topics: [],
      sentiments: ["STRONGLY_POSITIVE","POSITIVE","MIXED_OPINION","NEGATIVE","STRONGLY_NEGATIVE","NO_OPINION"] }],
    filters: { and: [ { fieldIds: [DF], gte: "2025-09-25", lte: "2026-09-25" }, { fieldIds: ["k_walmart_survey_has_comment_yn::seqnum"], in: ["1"] } ] },
  });
  console.log(`limit ${String(limit).padStart(5)} → n=${r.n} total=${r.total} bytes=${r.bytes} ${Date.now()-t0}ms ${r.errors||""}${r.raw||""}`);
}
await browser.disconnect();
