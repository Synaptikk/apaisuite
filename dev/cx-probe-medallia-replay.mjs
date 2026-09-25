// Can we run our OWN slim getComments query from inside a Medallia tab,
// and does the date filter accept plain dates instead of IntervalId?
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const PAGE = "https://walmart.medallia.com/sso/walmart/applications/ex_WEB-5/pages/4899?roleId=251254";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 180000 });
await new Promise(r => setTimeout(r, 12000));
console.log("URL:", page.url());

const QUERY = `query cxComments($filters: Filter, $limit: Int!, $offset: ID, $dataView: DataView!,
  $dateField: ID!, $commentFieldIds: [ID!]!, $scoreFieldIds: [ID!]!, $journeyFieldId: ID!,
  $subjectFieldId: ID!, $taFilter: TaggingFilter!) {
  feedback(filter: $filters, after: $offset, first: $limit, dataView: $dataView,
           orderBy: [{fieldId: $dateField, direction: DESC}]) {
    totalCount
    nodes {
      id
      timestamp: fieldValue(fieldId: $dateField)
      journey: fieldLabels(fieldId: $journeyFieldId)
      subject: fieldLabels(fieldId: $subjectFieldId)
      scoreFieldData: fieldDataList(fieldIds: $scoreFieldIds, filterUnanswered: true) {
        field { id }
        values
      }
      commentData: fieldDataList(fieldIds: $commentFieldIds, filterUnanswered: true) {
        field { id name }
        ... on CommentFieldData {
          textsWithLanguage { text }
          matchingTaggings(filter: $taFilter) {
            sentimentRegions { startIndex endIndex sentiment }
            topicRegions { startIndex endIndex topics { id name } }
          }
          sentimentTaggings { sentiment regions { startIndex endIndex } }
        }
      }
    }
    nextPages(n: 1) { hasNextPage endCursor }
  }
}`;

const COMMENT_FIELDS = [
  "q_walmart_voc_store_ovrl_exprc_cmt",
  "q_walmart_voc_ogp_customer_comments_cmt",
  "q_walmart_voc_ogp_ltr_recommend_cmt",
  "q_walmart_voc_ogp_what_went_wrong_cmt",
  "q_walmart_voc_store_rating_reason_cmt",
  "q_walmart_voc_scan_go_ltr_trans_cmt",
  "q_walmart_voc_store_fin_service_osat_cmt",
  "q_walmart_voc_store_fuel_osat_reason_cmt",
  "q_walmart_voc_store_ltr_auto_care_cntr_reason_cmt",
];

const DATE_FIELD = "k_walmart_voc_ltp_update_responsedate";

function vars(dateFilter, limit) {
  return {
    limit, offset: null,
    dataView: { id: "27" },
    dateField: DATE_FIELD,
    commentFieldIds: COMMENT_FIELDS,
    scoreFieldIds: ["a_overall_score_with_social_media_5_buckets"],
    journeyFieldId: "k_walmart_voc_journey_type_filter_alt",
    subjectFieldId: "k_walmart_voc_store_source_concat_txt",
    taFilter: {
      commentFields: COMMENT_FIELDS, level: 1, personas: [], tagpools: ["27","33","37"],
      topicType: "RULE", topics: [],
      sentiments: ["STRONGLY_POSITIVE","POSITIVE","MIXED_OPINION","NEGATIVE","STRONGLY_NEGATIVE","NO_OPINION"],
    },
    filters: {
      and: [
        dateFilter,
        { fieldIds: ["k_walmart_survey_has_comment_yn::seqnum"], in: ["1"] },
      ],
    },
  };
}

const TESTS = [
  { name: "plain ISO dates",   f: { fieldIds: [DATE_FIELD], gte: "2026-09-01", lte: "2026-09-25" } },
  { name: "IntervalId as seen",f: { fieldIds: [DATE_FIELD], gte: "IntervalId: 10892", lte: "IntervalId: 11189" } },
  { name: "relative lastNDays",f: { fieldIds: [DATE_FIELD], gte: "2026-08-01", lte: "2026-09-25T23:59:59" } },
];

const out = {};
for (const t of TESTS) {
  const res = await page.evaluate(async (query, variables) => {
    try {
      const r = await fetch("/api-comp/reporting/query?view_as_role=251254", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationName: "cxComments", variables, query }),
      });
      const raw = await r.text();
      let j; try { j = JSON.parse(raw); } catch { return { status: r.status, raw: raw.slice(0, 1500) }; }
      return { status: r.status, errors: j.errors ?? null, raw: j.data ? null : raw.slice(0, 1500),
               totalCount: j.data?.feedback?.totalCount ?? null,
               n: j.data?.feedback?.nodes?.length ?? null,
               first: j.data?.feedback?.nodes?.[0] ?? null,
               cursor: j.data?.feedback?.nextPages?.[0] ?? null };
    } catch (e) { return { err: String(e) }; }
  }, QUERY, vars(t.f, 5));
  console.log("\n### " + t.name);
  console.log("  status", res.status, "totalCount", res.totalCount, "n", res.n);
  if (res.errors) console.log("  ERRORS", JSON.stringify(res.errors).slice(0, 900));
  if (res.first) console.log("  first:", JSON.stringify({ ts: res.first.timestamp, journey: res.first.journey, subject: res.first.subject, score: res.first.scoreFieldData?.[0]?.values, text: res.first.commentData?.[0]?.textsWithLanguage?.[0]?.text?.slice(0,90), topics: res.first.commentData?.[0]?.matchingTaggings?.topicRegions?.flatMap(r=>r.topics.map(t=>t.name)) }));
  if (res.cursor) console.log("  cursor:", JSON.stringify(res.cursor));
  out[t.name] = res;
}
fs.writeFileSync(process.env.OUT || "cx-medallia-replay.json", JSON.stringify(out, null, 1));
await page.close(); await browser.disconnect();
