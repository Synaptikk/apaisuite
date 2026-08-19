// Shared shell chrome for the store screenshots. Markup is copied from
// app.html / app.js so the screenshots match what the extension actually
// renders — only the data is synthetic.

const MODULES = [
  { id:"aurorbuddy",        name:"AurorBuddy",           v:"0.1.62", status:"active", desc:"Cross-reference Auror suspects against APPRISS/Secure activity, save evidence, and pre-fill Auror events." },
  { id:"orcmonitor",        name:"ORC Corridor Monitor", v:"0.1.0",  status:"active", desc:"Identifies approaching ORC threats by tracking their event history trajectory along interstate corridors toward a selected store." },
  { id:"sparkfraud",        name:"SparkFraud",           v:"0.1.0",  status:"active", desc:"Correlate register events to candidate Spark/Express delivery trips and order items." },
  { id:"closinglist",       name:"ClosingList",          v:"0.2.0",  status:"active", desc:"Closing-shift email draft from CaseVisibility schedule + IVR call-offs." },
  { id:"stockingplan",      name:"StockingPlan",         v:"0.1.0",  status:"active", desc:"Overnight stocking plan: freight from CaseVisibility → labour hours → associate assignments." },
  { id:"digitallocks",      name:"Digital Locks",        v:"0.1.0",  status:"beta",   desc:"Triage digital lock unlock events for daily AP review. Imports Power BI CSV/XLSX exports, scores events against configurable risk rules, and tracks per-event review status locally." },
  { id:"livedashboard",     name:"Live Dashboard",       v:"0.1.0",  status:"beta",   desc:"Daily AP operational dashboard: callouts, compliance, accident evidence, CVP, register exceptions." },
  { id:"claimsdisposition", name:"Claims Disposition",   v:"0.3.0",  status:"beta",   desc:"Live shrink-claims analytics: pulls per-store data on demand from the Looker Studio embed, caches up to 30 pulls in IndexedDB, exports per-store CSVs." },
  { id:"metricshot",        name:"Metric Shots",         v:"0.1.0",  status:"beta",   desc:"Scheduled store metric cards, rendered locally from VizPick data and posted to Workvivo channels using your existing authenticated tab." },
  { id:"workvivo",          name:"QRCallBox",            v:"0.2.0",  status:"beta",   desc:"Keeps QRCallBox notifications working by silently couriering your Workvivo/Sendbird token to qrcallbox.com once an hour while you have Workvivo open." },
  { id:"vizpick",           name:"VizPick Market Rollup",v:"0.1.0",  status:"alpha",  desc:"Every store's VizPick backroom health for a chosen market, pulled from Tableau — no per-store search required." },
];

const MODULE_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <rect x="3" y="3" width="6" height="6" rx="1"></rect>
    <rect x="11" y="3" width="6" height="6" rx="1"></rect>
    <rect x="3" y="11" width="6" height="6" rx="1"></rect>
    <rect x="11" y="11" width="6" height="6" rx="1"></rect>
  </svg>`;

function pillClass(s) {
  return s === "deprecated" ? "pill-fail" : s === "beta" || s === "alpha" ? "pill-warn" : "pill-ok";
}

function statusDot(s) {
  return s === "active" ? "" : `<span class="shell-nav-status ${s}"></span>`;
}

export function shell({ active, main }) {
  const nav = MODULES.map((m) => `
    <a href="#/${m.id}" class="shell-nav-item${m.id === active ? " is-active" : ""}" data-route="#/${m.id}">
      ${MODULE_ICON}<span>${m.name}</span>${statusDot(m.status)}
    </a>`).join("");

  document.body.innerHTML = `
<div class="shell">
  <header class="shell-header">
    <a href="#/home" class="shell-header-brand" data-route="#/home">
      <svg viewBox="-16 -16 32 32" aria-hidden="true">
        <path d="M0,-12 L10,-8 L10,4 C10,9 5,13 0,14 C-5,13 -10,9 -10,4 L-10,-8 Z"
              fill="none" stroke="#0071CE" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M0,-3.5 L0.79,-1.08 L3.33,-1.08 L1.27,0.41 L2.06,2.83 L0,1.34 L-2.06,2.83 L-1.27,0.41 L-3.33,-1.08 L-0.79,-1.08 Z"
              fill="#0071CE"/>
      </svg>
      <span>APAISuite</span>
    </a>
    <span class="shell-header-spacer"></span>
    <div class="shell-header-actions">
      <span class="pill" id="suite-version" title="APAISuite version">v0.9.2</span>
    </div>
  </header>
  <nav class="shell-sidebar" aria-label="Modules">
    <div class="shell-nav" id="shell-nav">${nav}</div>
    <div class="shell-sidebar-footer">
      <a href="#/settings" class="shell-nav-item" data-route="#/settings">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="10" cy="10" r="2.5"></circle>
          <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"></path>
        </svg>
        Settings
      </a>
      <a href="#/docs" class="shell-nav-item" data-route="#/docs">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M4 3h9l3 3v11H4z"></path><path d="M13 3v3h3"></path>
          <path d="M7 9h6M7 12h6M7 15h4"></path>
        </svg>
        Docs
      </a>
    </div>
  </nav>
  <section class="shell-viewport"><main id="shell-main">${main}</main></section>
  <footer class="shell-footer">© 2026 Shane Smith™ · APAISuite</footer>
</div>`;
}

export function homeMain() {
  const cards = MODULES.map((m) => `
    <div class="module-card">
      <div class="module-card-head">
        <span class="module-card-icon">${MODULE_ICON}</span>
        <div class="stack" style="gap:2px">
          <span class="module-card-name">${m.name}</span>
          <span class="muted tiny">v${m.v} · ${m.status}</span>
        </div>
      </div>
      <div class="module-card-desc">${m.desc}</div>
      <div class="module-card-foot">
        <span class="pill ${pillClass(m.status)}">${m.status}</span>
        <a href="#/${m.id}" class="btn btn-primary btn-sm btn-pill">Open</a>
      </div>
    </div>`).join("");

  return `
    <div class="stack-sm">
      <h1>Welcome to APAISuite</h1>
      <p class="muted">Asset Protection investigation tools, unified. ${MODULES.length} modules available.</p>
    </div>
    <div class="grid grid-cards">${cards}</div>`;
}
