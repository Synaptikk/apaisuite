// shared/sparkInvestigation/input_detect.js
//
// Classifies a user's free-text lookup input as "orders" (one or more
// numeric IDs) or "driver" (name or free text). Extracted verbatim from
// modules/sparkfraud/view.js:1846-1852.
//
// Behavior contract (must not drift — SparkFraud UI depends on it):
//   - Empty / whitespace-only input → "empty"
//   - Every whitespace/comma-split token is entirely digits → "orders"
//   - Otherwise → "driver"
//
// Deliberately does NOT distinguish driver-ID from driver-name (SparkFraud
// treats them the same downstream — both go through the Dispatcher name
// search). A future variant could add "driver-id" if a stable ID pattern
// emerges from Walmart's schema.

export function detectQueryType(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return "empty";
  const tokens = trimmed.split(/[,\s]+/).filter(Boolean);
  if (tokens.every((t) => /^\d+$/.test(t))) return "orders";
  return "driver";
}
