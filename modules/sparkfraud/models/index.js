// Models — normalized evidence shapes for SparkFraud.
//
// See models/README.md for the design and adoption sequence.
// MODEL-01 introduces these as pure functions; the result is currently
// invoked-but-ignored at app.js:runSearch to validate shape against live and
// replay data. Subsequent MODEL-* tasks switch real consumers (printTrip,
// renderTrips) to use these instead of raw response shapes.

export { toTrip, computeInStoreWindow } from "./trip.js";
export { toDriver }                    from "./driver.js";
export { toOrder, attachOmsItems }     from "./order.js";
export { toItem }                      from "./item.js";
export { toEvidence }                  from "./evidence.js";
export { toCandidateMatch, assessConfidence, CONFIDENCE } from "./candidate_match.js";
