import puppeteer from "puppeteer-core";
import fs from "node:fs";
const FROM = process.argv[2] || "2026-06-28";
const TO   = process.argv[3] || "2026-09-25";
const PAGE_SIZE = 200;

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
let page = (await browser.pages()).find(p => /walmart\.medallia\.com/.test(p.url()));
if (!page) { page = await browser.newPage();
  await page.goto("https://walmart.medallia.com/sso/walmart/applications/ex_WEB-5/pages/4899?roleId=251254", { waitUntil: "domcontentloaded", timeout: 180000 });
  await new Promise(r => setTimeout(r, 15000)); }

const QUERY = fs.readFileSync("cx-comments-query.graphql", "utf8");
const CF = ["q_walmart_voc_store_ovrl_exprc_cmt","q_walmart_voc_ogp_customer_comments_cmt",
  "q_walmart_voc_ogp_ltr_recommend_cmt","q_walmart_voc_ogp_what_went_wrong_cmt",
  "q_walmart_voc_store_rating_reason_cmt","q_walmart_voc_scan_go_ltr_trans_cmt",
  "q_walmart_voc_store_fin_service_osat_cmt","q_walmart_voc_store_fuel_osat_reason_cmt",
  "q_walmart_voc_store_ltr_auto_care_cntr_reason_cmt"];
const DF = "k_walmart_voc_ltp_update_responsedate";

const all = []; let cursor = null, total = null, pages = 0;
do {
  const res = await page.evaluate(async (query, variables) => {
    const csrf = /csrfToken:\s*"([^"]+)"/.exec(document.documentElement.outerHTML)?.[1];
    const role = new URLSearchParams(location.search).get("roleId") || "";
    const r = await fetch(`/api-comp/reporting/query?view_as_role=${role}`, { method: "POST", credentials: "include",
      headers: { "content-type": "application/json", "accept": "application/json", "x-csrf-token": csrf,
                 "x-medallia-active-role-id": role, "x-medallia-reporting-query-data-view": "27" },
      body: JSON.stringify({ operationName: "cxComments", variables, query }) });
    const j = await r.json();
    if (j.errors) return { errors: JSON.stringify(j.errors).slice(0,500) };
    return { fb: j.data.feedback };
  }, QUERY, {
    limit: PAGE_SIZE, offset: cursor, dataView: { id: "27" }, dateField: DF,
    commentFieldIds: CF, scoreFieldIds: ["a_overall_score_with_social_media_5_buckets"],
    journeyFieldId: "k_walmart_voc_journey_type_filter_alt",
    subjectFieldId: "k_walmart_voc_store_source_concat_txt",
    taFilter: [{ commentFields: CF, level: 1, personas: [], tagpools: ["27","33","37"], topicType: "RULE", topics: [],
      sentiments: ["STRONGLY_POSITIVE","POSITIVE","MIXED_OPINION","NEGATIVE","STRONGLY_NEGATIVE","NO_OPINION"] }],
    filters: { and: [ { fieldIds: [DF], gte: FROM, lte: TO }, { fieldIds: ["k_walmart_survey_has_comment_yn::seqnum"], in: ["1"] } ] },
  });
  if (res.errors) { console.log("ERR", res.errors); break; }
  total ??= res.fb.totalCount;
  all.push(...res.fb.nodes);
  cursor = res.fb.nextPages?.[0]?.hasNextPage ? res.fb.nextPages[0].endCursor : null;
  pages++;
  process.stdout.write(`\rpage ${pages} · ${all.length}/${total}`);
} while (cursor && pages < 30);
console.log("");

fs.writeFileSync(process.env.OUT || "cx-pull.json", JSON.stringify({ from: FROM, to: TO, total, all }, null, 1));
console.log("pulled", all.length, "of", total, "in", pages, "pages");

// ---- aggregate ----
const subjects = new Map(), journeys = new Map(), topicSent = new Map(), fields = new Map(), scores = new Map();
let withTopics = 0, withSent = 0;
for (const n of all) {
  for (const s of n.subject || []) subjects.set(s, (subjects.get(s)||0)+1);
  for (const j of n.journey || []) journeys.set(j, (journeys.get(j)||0)+1);
  const sc = n.scoreFieldData?.[0]?.values?.[0]; if (sc) scores.set(sc, (scores.get(sc)||0)+1);
  let ht = false, hs = false;
  for (const c of n.commentData || []) {
    fields.set(c.field.name, (fields.get(c.field.name)||0)+1);
    const text = c.textsWithLanguage?.[0]?.text || "";
    const sentRegions = c.matchingTaggings?.sentimentRegions || [];
    const topicRegions = c.matchingTaggings?.topicRegions || [];
    if (topicRegions.length) ht = true;
    if (sentRegions.length || c.sentimentTaggings?.length) hs = true;
    for (const tr of topicRegions) {
      // sentiment of the region that overlaps this topic region
      const ov = sentRegions.find(s => tr.startIndex < s.endIndex && s.startIndex < tr.endIndex);
      const sent = ov?.sentiment || (c.sentimentTaggings?.[0]?.sentiment) || "UNSPECIFIED";
      for (const t of tr.topics) {
        const k = t.name + " :: " + sent;
        topicSent.set(k, (topicSent.get(k)||0)+1);
      }
    }
  }
  if (ht) withTopics++; if (hs) withSent++;
}
const top = (m, n=40) => [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n);
console.log("\n--- subjects ---"); for (const [k,v] of top(subjects,8)) console.log(String(v).padStart(5), k);
console.log("\n--- journeys ---"); for (const [k,v] of top(journeys,20)) console.log(String(v).padStart(5), k);
console.log("\n--- comment fields ---"); for (const [k,v] of top(fields,20)) console.log(String(v).padStart(5), k);
console.log("\n--- score buckets ---"); for (const [k,v] of [...scores.entries()].sort()) console.log(String(v).padStart(5), k);
console.log(`\ncomments with topic tags: ${withTopics}/${all.length}   with sentiment: ${withSent}/${all.length}`);
console.log("\n--- topic :: sentiment (top 45) ---"); for (const [k,v] of top(topicSent,45)) console.log(String(v).padStart(5), k);
await browser.disconnect();
