// dev/orcmonitor-harness.mjs
// Writes dev/_orc-harness.html: the real orcmonitor view.js mounted with a fake
// host and made-up crews, so the UI can be checked in any browser without
// Auror or the extension. Serve the suite folder and open the page:
//
//   node dev/orcmonitor-harness.mjs
//   python -m http.server 8766 --bind 127.0.0.1     (from unified-extension-suite/)
//   http://localhost:8766/dev/_orc-harness.html
//
// The generated page is scratch: delete it when done (it is not committed).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const d = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const pt = (n, lat, lon, site, id) => ({ date: d(n), lat, lon, site, eventId: id });
const person = (id, name, risk, pts, why) => ({
  personId: id, name, riskScore: risk, riskWhy: why,
  lastOffenceDays: Math.round((Date.now() - Date.parse(pts.at(-1).date)) / 864e5), lastOffenceDate: pts.at(-1).date,
  aurorUrl: "#", photos: [], physicalDesc: "Male · Average build", totalValue: 2400, eventCount: pts.length,
  primaryMo: "Shoplifting", peakHours: "4pm", hourCounts: Array(24).fill(0).map((_, h) => (h > 13 && h < 19 ? 3 : 0)),
  moBreakdown: { Shoplifting: 3 }, products: [{ name: "Power tools", count: 4 }], vehicles: [],
  lat: pts.at(-1).lat, lon: pts.at(-1).lon, lastSeenStore: pts.at(-1).site, currentDist: 30, corridor: "I-75",
  storeHistory: pts.map(p => ({ store: p.site, lat: p.lat, lon: p.lon, date: p.date, dist: 30 })), timedPoints: pts,
});
const threats = [
  person("1", "Test Crew Lead", 78, [pt(12, 33.829, -84.366, "Walmart 2065 - x, Atlanta, GA", "e1"), pt(8, 34.4794, -84.9457, "Walmart 1215 - x, Calhoun, GA", "e2"), pt(4, 34.7675, -84.9304, "Walmart 669 - x, Dalton, GA", "e3")], ["Last offence 4d ago (×1)"]),
  person("2", "Name Unknown", 60, [pt(4, 34.7675, -84.9304, "Walmart 669 - x, Dalton, GA", "e3")], ["Last offence 4d ago (×1)"]),
  person("3", "Test Traveler", 52, [pt(24, 28.0395, -81.95, "Walmart 3347 - x, Winter Haven, FL", "f1"), pt(20, 28.54, -81.38, "Walmart 908 - x, Orlando, FL", "f2"), pt(9, 35.37, -83.22, "Walmart 2440 - x, Sylva, NC", "f3")], ["Last offence 9d ago (×0.9)"]),
  person("4", "Stale Person", 15, [pt(80, 35.0155, -85.3765, "Walmart 3660 - x, Chattanooga, TN", "g1"), pt(70, 35.0404, -85.2032, "Walmart 1469 - x, Chattanooga, TN", "g2")], ["Last offence 70d ago (×0.25)"]),
];
const result = {
  target: { store: "1458", lat: 34.9362, lon: -85.2152 }, threats, links: [["1", "2"]], sites: [],
  eventsScanned: 40, totalPersons: 12, days: 30,
  market: { number: "120", stores: ["3660", "1215", "2988", "658", "5173", "756", "1089", "1458", "669", "5151"] },
};

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>orc harness</title>
<link rel="stylesheet" href="../styles/tokens.css"><link rel="stylesheet" href="../styles/base.css">
<link rel="stylesheet" href="../styles/components.css"><link rel="stylesheet" href="../styles/layout.css">
<style>body{margin:0;padding:12px;background:var(--apai-bg,#F6F7F9);font-family:system-ui}</style></head><body>
<div id="root" class="module-orcmonitor"></div>
<script>
const mem = {};
const area = { get: async k => { if (k == null) return { ...mem }; const o = {}; for (const x of [].concat(k)) if (x in mem) o[x] = mem[x]; return o; },
               set: async o => Object.assign(mem, o), remove: async k => { for (const x of [].concat(k)) delete mem[x]; } };
window.chrome = { storage: { session: area, local: area, sync: area, onChanged: { addListener() {}, removeListener() {} } },
                  runtime: { getURL: p => "/" + p }, tabs: { create: async () => { window.__reportOpened = true; } } };
window.addEventListener("error", e => (window.__errors ??= []).push(String(e.message)));
window.addEventListener("unhandledrejection", e => (window.__errors ??= []).push("rejection: " + String(e.reason?.stack ?? e.reason)));
</script>
<script type="module">
import { mount } from "../modules/orcmonitor/view.js";
const RESULT = ${JSON.stringify(result)};
const host = { url: p => "../modules/orcmonitor/" + p, usage: { record() {} },
  storage: { local: { get: async k => mem["orcmonitor." + k], set: async (k, v) => { mem["orcmonitor." + k] = v; } } },
  messaging: { sendRaw: async type => type === "getStatus" ? { tokenReady: true }
                                    : type === "storeCoords" ? { coords: [34.9362, -85.2152] } : RESULT } };
await mount(host, document.getElementById("root"));
document.querySelector("#om-store").value = "1458";
document.querySelector("#om-btn-analyze").click();
</script></body></html>`;
fs.writeFileSync(path.join(here, "_orc-harness.html"), html);
console.log("wrote dev/_orc-harness.html");
