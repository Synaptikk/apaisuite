// modules/safetyobs/lib/form_schema.js
//
// The "Safety Observation Survey" Microsoft Form behind the store's QR poster.
// Read live 2026-10-08 from the form's runtime definition
// (formapi …/runtimeFormsWithResponses('<id>')?$expand=questions($expand=choices)).
// Every question is required; every choice question is a single-select
// dropdown with no "Other" box.
//
// Branching (verified by clicking through the form, nothing submitted):
//   Engagement  → location, process, tool        (NO description box)
//   Recognition → description, location, process, tool
// So an Engagement keeps nothing of the sentence beyond the four picks.
//
// The form is not anonymous: it records the signed-in Microsoft account, so
// every submission counts as the user's own observation in Field_Dashboard.

export const FORM_URL =
  "https://forms.office.com/Pages/ResponsePage.aspx?id=08O8PE0JBkCYSQ0R1h9ITW3MOdjV9JJGhiIncXoFf7NUQ0lZTUdZOEJXVEdUSUFPSFhZQjhBM0FKMC4u&origin=QRCode";

export const ROLES = ["Store Manager", "Ops Manager (NHM)", "Coach", "Team Lead", "Academy Trainers (NHM)", "Market Leader", "Home Office"];
export const SHIFTS = ["First", "Second", "Third"];
export const TYPES = ["Engagement", "Recognition"];
export const LOCATIONS = [
  "Backroom", "Food", "Fresh", "Store Fulfillment", "Consumables", "Entertainment", "Fashion", "Action Alley",
  "Hardlines", "Front End", "Pharmacy", "Vision Center", "Parking Lot", "Fuel Station", "Seasonal", "ACC", "Home",
];
export const PROCESSES = [
  "Lifting", "Stretching", "Stocking", "Cleaning", "Cutting", "Equipment usage", "Climbing", "Working outside",
  "ACC service", "PPE Usage", "Customer assistance", "Compliance safety", "Teaching & training", "Safety routine/practice",
];
export const TOOLS = [
  "Box-case", "Fixture", "Manual equipment", "Powered equipment", "Box Cutter", "Cleaning supplies", "Ladder",
  "Cart (OPD, Topstock, etc.)", "Merchandise", "Personal Protective Equipment", "Shopping cart", "ACC equipment",
  "Backroom equipment", "Safety vest", "Spill station", "10ft Rule", "Associate Actions",
];

/**
 * Form order. `title` is matched as a prefix of the question's visible title
 * (the live titles carry trailing spaces and punctuation). `onlyFor` mirrors
 * the branch above: the field is skipped unless `type` matches.
 */
export const QUESTIONS = [
  { key: "store",       kind: "text",   title: "Store Number" },
  { key: "role",        kind: "choice", title: "Select your current role", choices: ROLES },
  { key: "shift",       kind: "choice", title: "During what shift", choices: SHIFTS },
  { key: "type",        kind: "choice", title: "Is this safety observation engagement or recognition", choices: TYPES },
  { key: "description", kind: "text",   title: "Description of the Safety Observation", onlyFor: "Recognition" },
  { key: "location",    kind: "choice", title: "Where is the location", choices: LOCATIONS },
  { key: "process",     kind: "choice", title: "What process is being observed", choices: PROCESSES },
  { key: "tool",        kind: "choice", title: "What tool is being used", choices: TOOLS },
];

/** Keys still empty that the form will demand for this answer set. */
export function missingAnswers(a = {}) {
  return QUESTIONS
    .filter((q) => !q.onlyFor || q.onlyFor === a.type)
    .filter((q) => {
      const v = String(a[q.key] ?? "").trim();
      return !v || (q.choices && !q.choices.includes(v));
    })
    .map((q) => q.key);
}

/** Shift for a local hour, store 1458 boundaries: 6a–2p / 2p–10p / 10p–6a. */
export function shiftForHour(h) {
  if (h >= 6 && h < 14) return "First";
  if (h >= 14 && h < 22) return "Second";
  return "Third";
}
