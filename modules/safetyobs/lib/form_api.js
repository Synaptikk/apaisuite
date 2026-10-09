// modules/safetyobs/lib/form_api.js
//
// Direct submit: the one POST the Forms page itself makes, without a tab.
// Captured 2026-10-08 by pausing the page's own Submit with CDP Fetch and
// failing it, so nothing was recorded:
//
//   POST https://forms.cloud.microsoft/formapi/api/<tenant>/groups/<group>/forms('<groupFormId>')/responses
//   headers  __RequestVerificationToken, X-UserSessionId, x-ms-form-muid,
//            x-ms-form-request-ring: business, x-ms-form-request-source: ms-formweb,
//            odata-version 4.0, empty Authorization, + the Microsoft cookies
//   body     { startDate, submitDate, answers: "<JSON [{questionId, answer1}]>", submitLanguage }
//
// The poster's QR id is a user-owned form; on load the page swaps to this
// group-owned id, which is what /responses is posted to. The verification
// token and session id are printed into the ResponsePage HTML as
// "antiForgeryToken" / "serverSessionId", fresh on every load.

export const TENANT = "3cbcc3d3-094d-4006-9849-0d11d61f484d";
export const GROUP = "4b0d7a34-f9b3-42ae-847d-8800fc223f7e";
export const GROUP_FORM_ID = "08O8PE0JBkCYSQ0R1h9ITTR6DUuz-a5ChH2IAPwiP35UQ0lZTUdZOEJXVEdUSUFPSFhZQjhBM0FKMCQlQCN0PWcu";
export const PAGE_URL = `https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${GROUP_FORM_ID}&origin=QRCode`;
export const RESPONSES_URL = `https://forms.cloud.microsoft/formapi/api/${TENANT}/groups/${GROUP}/forms('${GROUP_FORM_ID}')/responses`;

// Question ids from the live form definition, same order as QUESTIONS.
export const QUESTION_IDS = {
  store:       "r671716f5a3de45d7bfbdddfd52a32410",
  role:        "r6eeb57010613448d99f92091c032406f",
  shift:       "re0b4a8163f104636addcd423cf3f2a05",
  type:        "r181b93c8512f43cd81dfa96c559c3adb",
  description: "r101726c00cbc4c7998424384b5657cac",
  location:    "r8ffe7e3fe03146bea2388c49583cbcd7",
  process:     "rb670dc547a8a4bc6bae16fd9c8d4cee9",
  tool:        "ra2379a07a2e64b278efae4667942ed93",
};

// The page's own "signInLinkSilent". The Forms login cookie (OIDCAuth.forms)
// lives one hour; once it lapses the ResponsePage still renders, but
// anonymously (empty UserId), and /responses answers 401 "Required user
// login" (code 701). Loading this link in a tab renews it:
//   GET oidcLogin → login.microsoftonline.com authorize (prompt=none)
//   → auto-submit POST forms.cloud.microsoft/landing → SilentSignInComplete.aspx
export const SILENT_SIGNIN_URL = "https://forms.cloud.microsoft/oidcLogin?IdentityProvider=aad&ru=%2FPages%2FSilentSignInComplete.aspx&prompt=none";
export const FORMS_LOGIN_COOKIE = "OIDCAuth.forms";

/**
 * antiForgeryToken + serverSessionId out of the ResponsePage HTML, plus
 * whether the page saw a signed-in user and their display name; null when the
 * tokens are missing.
 */
export function readPageTokens(html) {
  const get = (k) => {
    const m = String(html || "").match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`));
    return m ? m[1] : null;
  };
  const antiForgeryToken = get("antiForgeryToken");
  const serverSessionId = get("serverSessionId");
  if (!antiForgeryToken || !serverSessionId) return null;
  // DisplayName is the signed-in account's name as the survey records it
  // (seen 2026-10-08); it is how a submission from here is credited to a leader.
  return { antiForgeryToken, serverSessionId, signedIn: !!get("UserId"), displayName: get("DisplayName") || null };
}

/**
 * The request body. `questions` is form_schema QUESTIONS; branch-hidden
 * questions (description on an Engagement) are left out, as the page does.
 */
export function buildResponseBody(questions, answers, { startDate, submitDate = new Date() } = {}) {
  const list = questions
    .filter((q) => !q.onlyFor || q.onlyFor === answers.type)
    .map((q) => ({ questionId: QUESTION_IDS[q.key], answer1: String(answers[q.key] ?? "").trim() }));
  const iso = (d) => new Date(d).toISOString();
  return {
    startDate: iso(startDate || new Date(new Date(submitDate).getTime() - 20_000)),
    submitDate: iso(submitDate),
    answers: JSON.stringify(list),
    submitLanguage: JSON.stringify({ localeId: "en-us", localeName: "English (United States)" }),
  };
}

export function responseHeaders({ antiForgeryToken, serverSessionId, muid }) {
  return {
    "accept": "application/json",
    "content-type": "application/json",
    "authorization": "",
    "__RequestVerificationToken": antiForgeryToken,
    "X-UserSessionId": serverSessionId,
    ...(muid ? { "x-ms-form-muid": muid } : {}),
    "x-ms-form-request-ring": "business",
    "x-ms-form-request-source": "ms-formweb",
    "x-correlationid": crypto.randomUUID(),
    "odata-version": "4.0",
    "odata-maxverion": "4.0",   // sic: the page's own spelling
  };
}
