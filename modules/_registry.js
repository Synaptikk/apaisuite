// modules/_registry.js
//
// The single source of truth for which modules ship in APAISuite.
//
// To add a new module (see docs/MIGRATION_PLAN.md::Importing a new extension):
//   1. Add the module folder under modules/<slug>/
//   2. Add ONE line to the imports + ONE line to the exported array, below.
//   3. Run dev/build-manifest.js (or hand-edit manifest.json to union perms).
//
// Each module's default export must be an object with the shape documented
// in docs/ARCHITECTURE.md::2. The module contract:
//   { manifest: {...}, register: (host) => void }

// ── Module imports ──────────────────────────────────────────────
import closinglist       from "./closinglist/module.js";
import stockingplan      from "./stockingplan/module.js";
import aurorbuddy        from "./aurorbuddy/module.js";
import sparkfraud        from "./sparkfraud/module.js";
import sparkrisk         from "./sparkrisk/module.js";
import sparkscango       from "./sparkscango/module.js";
import claimsdisposition from "./claimsdisposition/module.js";
import digitallocks      from "./digitallocks/module.js";
import workvivo          from "./workvivo/module.js";
import livedashboard     from "./livedashboard/module.js";
import orcmonitor        from "./orcmonitor/module.js";
import market120         from "./market120/module.js";
import metricshot        from "./metricshot/module.js";
import vizpick           from "./vizpick/module.js";
import digitalrollup     from "./digitalrollup/module.js";
import digitalmetrics    from "./digitalmetrics/module.js";
// import assocpurchases    from "./assocpurchases/module.js";

// ── Registered modules ──────────────────────────────────────────
// Order in this array == order in the sidebar (for "fullpage" kinds).
// `livedashboard` uses kind: "home-header" — it's hidden from the
// sidebar and mounts above the module-card grid on the home screen.
// Keep it in the registry so its SW handlers + alarms load on SW boot.
export default [
  livedashboard,
  market120,         // Market 120 Clearance & ISA Review — Pass 1 skeleton
  metricshot,        // Scheduled screenshots → Workvivo
  vizpick,           // VizPick Market Rollup — every store in a market at once
  digitalrollup,     // Digital Market Rollup — live OPD fulfilment, same layout
  digitalmetrics,    // Digital Metrics — analytics, schedule import, task grid
  aurorbuddy,
  orcmonitor,        // ORC Corridor Intelligence Monitor
  sparkfraud,
  sparkrisk,         // Pre-checkout timing analysis
  sparkscango,       // Spark & Scan&Go exceptions/audits
  claimsdisposition,
  digitallocks,
  workvivo,
  closinglist,
  stockingplan,
  // assocpurchases,
];
