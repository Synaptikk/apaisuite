// modules/cx/lib/medallia_query.js
//
// The GraphQL contract for Medallia's comment feed, kept in one file so the
// query text and the field ids that fill it cannot drift apart.
//
// This is a slim rewrite of the reporting app's own `getComments` (its version
// is 9 KB and asks for social scores, alerts, PII taggings, keyword highlights
// and enhanced-filtering flags we never render). Two shapes are easy to get
// wrong and cost a GRAPHQL_VALIDATION_FAILED each — see dev/CX_FINDINGS.md:
//   · matchingTaggings takes `filters:` — PLURAL.
//   · $taFilter is [TaggingFilter!]! — a LIST, even for one filter.

/** Medallia data view the store reporting app runs on. */
export const DATA_VIEW = "27";

/** Tag pools carrying the rule-topic taxonomies (in-store + OPD + social). */
export const TAG_POOLS = ["27", "33", "37"];

export const FIELD = Object.freeze({
  responseDate: "k_walmart_voc_ltp_update_responsedate",
  hasComment:   "k_walmart_survey_has_comment_yn::seqnum",
  scoreBucket:  "a_overall_score_with_social_media_5_buckets",
  journey:      "k_walmart_voc_journey_type_filter_alt",
  subject:      "k_walmart_voc_store_source_concat_txt",
});

/**
 * Every comment body field the store programme uses. A record answers exactly
 * one of them, so they are all requested and whichever is populated wins.
 * `filterUnanswered: true` on the server keeps the response from carrying
 * thirteen nulls per record.
 */
export const COMMENT_FIELDS = Object.freeze([
  "q_walmart_voc_store_ovrl_exprc_cmt",                 // in-store "Comment"
  "q_walmart_voc_ogp_customer_comments_cmt",            // OPD "Customer Comments" — the biggest field
  "q_walmart_voc_ogp_ltr_recommend_cmt",
  "q_walmart_voc_ogp_what_went_wrong_cmt",
  "q_walmart_voc_store_rating_reason_cmt",
  "q_walmart_voc_scan_go_ltr_trans_cmt",
  "q_walmart_voc_store_fin_service_osat_cmt",
  "q_walmart_voc_store_fuel_osat_reason_cmt",
  "q_walmart_voc_store_ltr_auto_care_cntr_reason_cmt",
]);

const ALL_SENTIMENTS = Object.freeze([
  "STRONGLY_POSITIVE", "POSITIVE", "MIXED_OPINION",
  "NEGATIVE", "STRONGLY_NEGATIVE", "NO_OPINION",
]);

export const COMMENTS_QUERY = `query cxComments(
  $filters: Filter, $limit: Int!, $offset: ID, $dataView: DataView!,
  $dateField: ID!, $commentFieldIds: [ID!]!, $scoreFieldIds: [ID!]!,
  $journeyFieldId: ID!, $subjectFieldId: ID!, $taFilter: [TaggingFilter!]!
) {
  feedback(
    filter: $filters
    after: $offset
    first: $limit
    dataView: $dataView
    orderBy: [{ fieldId: $dateField, direction: DESC }]
  ) {
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
          matchingTaggings(filters: $taFilter) {
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

/**
 * Variables for one page.
 *
 * The date filter takes plain ISO days. The reporting app sends Medallia's
 * opaque "IntervalId: NNNNN" tokens instead, whose id space mixes
 * granularities in one range (10892 is a MONTH), so ISO is both simpler and
 * unambiguous. Verified to bracket correctly against four windows.
 *
 * There is deliberately no store filter: scoping comes from the role the
 * request is made under, and `subject` on every record confirms which store
 * answered.
 */
export function commentsVariables({ from, to, limit, cursor = null }) {
  const taFilter = [{
    commentFields: [...COMMENT_FIELDS],
    level: 1,
    personas: [],
    tagpools: [...TAG_POOLS],
    topicType: "RULE",
    topics: [],
    sentiments: [...ALL_SENTIMENTS],
  }];

  return {
    limit,
    offset: cursor,
    dataView: { id: DATA_VIEW },
    dateField: FIELD.responseDate,
    commentFieldIds: [...COMMENT_FIELDS],
    scoreFieldIds: [FIELD.scoreBucket],
    journeyFieldId: FIELD.journey,
    subjectFieldId: FIELD.subject,
    taFilter,
    filters: {
      and: [
        { fieldIds: [FIELD.responseDate], gte: from, lte: to },
        { fieldIds: [FIELD.hasComment], in: ["1"] },
      ],
    },
  };
}
