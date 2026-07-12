# tools/

Developer + lead tooling for APAISuite. Not bundled with the extension; runs locally with Node + Firebase Admin credentials.

## `export_usage_metrics_report.mjs`

Emits AurorBuddy usage rollups from the live Firestore project. Spec: `../docs/USAGE_METRICS_MODEL.md` §8.

### Setup (once)

```bash
cd unified-extension-suite/tools
npm install
```

Service-account JSON for the `aurorbuddy` Firebase project must be exported as `GOOGLE_APPLICATION_CREDENTIALS`. Get the key from Firebase Console → Project settings → Service accounts → Generate new private key. Store it outside any git tree — don't commit.

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/aurorbuddy-sa.json
```

### Usage

```bash
# JSON to stdout, last 30 days (default)
node export_usage_metrics_report.mjs

# Last 7 days
node export_usage_metrics_report.mjs --days 7

# Write CSV files + report.json to ./out/
node export_usage_metrics_report.mjs --csv-dir ./out
```

Output shape:

- `storeTotals` — per home store: scans, events, distinct analysts (last N days).
- `userTotals` — per analyst email: scans, events, last-seen.
- `moduleTotals` — per module: opens count + distinct users (driven by `module_opened` action events).
- `workflowStatusCounts` — count of workflows per lifecycle status.
- `legacyValueWarnings` — count + $ sum of `tool_events` rows that still carry only `suspectTotalValue` (the legacy proxy) and no confirmed `finalEventValue`.
- `errors` — per-errorCode count from metric events with `result: "failure"`.
