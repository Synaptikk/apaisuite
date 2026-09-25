import puppeteer from "puppeteer-core";
import fs from "node:fs";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
let pages = await browser.pages();
let page = pages.find(p => /walmart\.medallia\.com/.test(p.url()));
if (!page) {
  page = await browser.newPage();
  await page.goto("https://walmart.medallia.com/sso/walmart/applications/ex_WEB-5/pages/4899?roleId=251254", { waitUntil: "domcontentloaded", timeout: 180000 });
  await new Promise(r => setTimeout(r, 15000));
}
console.log("page:", page.url().slice(0,80));

const CFG = await page.evaluate(() => {
  const c = window.CONFIGURATION || {};
  const html = document.documentElement.outerHTML;
  const m = /csrfToken:\s*"([^"]+)"/.exec(html);
  return { fromGlobal: c.csrfToken ? String(c.csrfToken).slice(0,25)+"…" : null,
           configKeys: Object.keys(c).slice(0,40),
           fromHtml: m ? m[1].slice(0,25)+"…" : null,
           roleFromGlobal: c.activeRoleId ?? c.roleId ?? null };
});
console.log("CSRF discovery:", JSON.stringify(CFG, null, 1));

const QUERY = fs.readFileSync("cx-comments-query.graphql", "utf8");
const COMMENT_FIELDS = [
  "q_walmart_voc_store_ovrl_exprc_cmt","q_walmart_voc_ogp_customer_comments_cmt",
  "q_walmart_voc_ogp_ltr_recommend_cmt","q_walmart_voc_ogp_what_went_wrong_cmt",
  "q_walmart_voc_store_rating_reason_cmt","q_walmart_voc_scan_go_ltr_trans_cmt",
  "q_walmart_voc_store_fin_service_osat_cmt","q_walmart_voc_store_fuel_osat_reason_cmt",
  "q_walmart_voc_store_ltr_auto_care_cntr_reason_cmt",
];
const DATE_FIELD = "k_walmart_voc_ltp_update_responsedate";
const mkVars = (dateFilter, limit) => ({
  limit, offset: null, dataView: { id: "27" }, dateField: DATE_FIELD,
  commentFieldIds: COMMENT_FIELDS,
  scoreFieldIds: ["a_overall_score_with_social_media_5_buckets"],
  journeyFieldId: "k_walmart_voc_journey_type_filter_alt",
  subjectFieldId: "k_walmart_voc_store_source_concat_txt",
  taFilter: [{ commentFields: COMMENT_FIELDS, level: 1, personas: [], tagpools: ["27","33","37"],
    topicType: "RULE", topics: [],
    sentiments: ["STRONGLY_POSITIVE","POSITIVE","MIXED_OPINION","NEGATIVE","STRONGLY_NEGATIVE","NO_OPINION"] }],
  filters: { and: [ dateFilter, { fieldIds: ["k_walmart_survey_has_comment_yn::seqnum"], in: ["1"] } ] },
});

const TESTS = [
  { name: "ISO dates",    f: { fieldIds: [DATE_FIELD], gte: "2026-09-01", lte: "2026-09-25" } },
  { name: "IntervalId",   f: { fieldIds: [DATE_FIELD], gte: "IntervalId: 10892", lte: "IntervalId: 11189" } },
  { name: "ISO datetime", f: { fieldIds: [DATE_FIELD], gte: "2026-09-18 00:00:00", lte: "2026-09-25 23:59:59" } },
];

const out = {};
for (const t of TESTS) {
  const res = await page.evaluate(async (query, variables) => {
    const html = document.documentElement.outerHTML;
    const csrf = (window.CONFIGURATION?.csrfToken) || (/csrfToken:\s*"([^"]+)"/.exec(html)?.[1]);
    const role = new URLSearchParams(location.search).get("roleId") || "";
    const r = await fetch(`/api-comp/reporting/query?view_as_role=${role}`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json", "accept": "application/json",
                 "x-csrf-token": csrf, "x-medallia-active-role-id": role,
                 "x-medallia-reporting-query-data-view": "27" },
      body: JSON.stringify({ operationName: "cxComments", variables, query }),
    });
    const raw = await r.text();
    let j; try { j = JSON.parse(raw); } catch { return { status: r.status, raw: raw.slice(0,800) }; }
    const fb = j.data?.feedback;
    return { status: r.status, errors: j.errors ? JSON.stringify(j.errors).slice(0,700) : null,
             raw: j.data ? null : raw.slice(0,800),
             totalCount: fb?.totalCount ?? null, n: fb?.nodes?.length ?? null,
             cursor: fb?.nextPages?.[0] ?? null, first: fb?.nodes?.[0] ?? null };
  }, QUERY, mkVars(t.f, 5));
  console.log("\n###", t.name, "→ status", res.status, "total", res.totalCount, "n", res.n);
  if (res.errors) console.log("  ERR", res.errors);
  if (res.raw) console.log("  RAW", res.raw);
  if (res.first) console.log("  first:", JSON.stringify({ ts: res.first.timestamp, j: res.first.journey, sc: res.first.scoreFieldData?.[0]?.values, txt: res.first.commentData?.[0]?.textsWithLanguage?.[0]?.text?.slice(0,80), topics: res.first.commentData?.[0]?.matchingTaggings?.topicRegions?.flatMap(r=>r.topics.map(x=>x.name)) }));
  if (res.cursor) console.log("  cursor:", JSON.stringify(res.cursor));
  out[t.name] = res;
}
fs.writeFileSync(process.env.OUT || "cx-replay2.json", JSON.stringify(out, null, 1));
await browser.disconnect();
