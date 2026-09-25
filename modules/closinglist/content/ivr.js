// modules/closinglist/content/ivr.js
//
// Content script — runs on IVR ATT Cloud pages. Auto-progresses the multi-
// page WebForms flow while the background flow flag is active, then scrapes
// the final absence table and reports back to the service handler.
//
// Adapted from ClosingList donor (extension/content/ivr.js). Changes:
//   - Storage key reads/writes namespaced to "closinglist.ivrFlowState"
//     (matches the prefix the suite's shared/storage.js wrapper uses)
//   - Outbound message carries module="closinglist"
//   - Inbound message filter narrowed to module="closinglist"

(() => {
  if (window.__CLOSINGLIST_IVR_INSTALLED__) return;
  window.__CLOSINGLIST_IVR_INSTALLED__ = true;

  const MODULE_ID       = "closinglist";
  const FLOW_KEY        = "closinglist.ivrFlowState";
  const FLOW_TIMEOUT_MS = 180 * 1000;   // 3 min — accommodates MAC-error retries
  const MAX_MAC_RETRIES = 5;
  const MAX_CRITERIA_RETRIES = 3;
  const IVR_ROOT_URL    = "https://ivrattcloud-prod.wal-mart.com/";

  function isFlowActive(s) {
    return s && s.active && (Date.now() - (s.startedAt || 0) < FLOW_TIMEOUT_MS);
  }

  function clickIfPresent(selector) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.click();
    return true;
  }

  // Radio-button check that survives ASP.NET WebForms postback validation.
  // Plain .click() on an <input type=radio> works in most pages but a few
  // WebForms forms (IVR's /ailAbsence.aspx is one) need the change event to
  // fire too, otherwise the server-side handler reports "you selected no
  // option" even though the UI shows the radio as checked. We:
  //   1. set checked = true explicitly (covers cases where .click() races a
  //      page-script's own change handler),
  //   2. fire click(),
  //   3. dispatch change + input events so postback validators see it.
  // Returns whether the element was found.
  function selectRadio(selector) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.checked = true;
    el.click();
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    return true;
  }

  function pageState() {
    // IVR ATT Cloud runs on a web farm with AutoGenerate machineKey and no
    // session affinity — POSTs frequently land on a different server than
    // the GET that rendered the form, and ASP.NET responds with a server
    // error page titled "Validation of viewstate MAC failed...". Detect
    // that page first so we can retry from the root instead of mistaking
    // it for an unknown state.
    if (/Validation of viewstate MAC failed/i.test(document.title)) return "mac-error";
    if (document.querySelector("#rdoMenu_0"))     return "menu";
    if (document.querySelector("#rdoCriteria_0")) return "criteria";
    if (document.querySelector("#ailTable_1"))    return "absence-table";
    // The criteria form posted back with nothing selected. IVR answers with a
    // bare page: one red line and a Back button, still on ailAbsence.aspx, and
    // carrying none of the markers above — so without this case pageState()
    // returned "unknown", the state machine did nothing, and the flow sat there
    // until the 3-minute timeout with no explanation.
    //
    // Checked LAST on purpose: if that wording ever also appears as an
    // instruction on the criteria form itself, the form's own markers win and
    // we drive it, rather than mistaking it for a rejection and looping.
    if (/at least one option for the report/i.test(document.body?.innerText || "")) return "criteria-rejected";
    return "unknown";
  }

  // Inventory of the criteria form's controls. Stashed on the flow state while
  // we are on that page so that if the server still rejects the submit we can
  // say what the page actually contained, instead of reporting "stuck" and
  // leaving the next person to guess at the markup.
  function criteriaInventory() {
    return [...document.querySelectorAll("input, select")]
      .filter((e) => !/^(hidden|submit|image)$/i.test(e.type || ""))
      .slice(0, 40)
      .map((e) => ({
        id:      e.id || null,
        name:    e.name || null,
        type:    (e.type || e.tagName).toLowerCase(),
        checked: e.checked === true,
        label:   (e.labels?.[0]?.innerText || "").trim().slice(0, 40) || null,
      }));
  }

  function describeInventory(inv) {
    if (!Array.isArray(inv) || !inv.length) return "(no control inventory captured)";
    return inv
      .map((c) => `${c.type} ${c.id || c.name || "?"}${c.label ? " [" + c.label + "]" : ""}${c.checked ? " CHECKED" : ""}`)
      .join("; ");
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Poll until the radio reports checked. Submitting on a fixed timer is what
  // let an unselected form reach the server in the first place.
  async function waitForChecked(selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.querySelector(selector)?.checked) return true;
      await sleep(100);
    }
    return !!document.querySelector(selector)?.checked;
  }

  function scrapeAbsenceTable() {
    const tbl = document.querySelector("#ailTable_1");
    if (!tbl) return { ok: false, error: "absence table not found" };
    const rows = [];
    tbl.querySelectorAll("tbody > tr").forEach((tr) => {
      const cells = [...tr.querySelectorAll("td")].map((td) => (td.innerText || "").trim());
      if (cells.length < 7) return;
      rows.push({
        associate:      cells[0],
        absence_date:   cells[1],
        dept:           cells[2],
        job:            cells[3],
        call_date_time: cells[4],
        absence_type:   cells[5],
        absence_reason: cells[6],
        confirmation:   cells[7] || null,
        source:         cells[8] || null,
      });
    });
    return { ok: true, rows, capturedAt: new Date().toISOString() };
  }

  async function progressIfFlowActive() {
    let state;
    try {
      const stored = await chrome.storage.local.get(FLOW_KEY);
      state = stored[FLOW_KEY];
    } catch (_) {
      return;
    }
    if (!isFlowActive(state)) return;

    const where = pageState();
    console.debug("[closinglist] ivr progress: page state =", where, "url =", location.href);

    if (where === "mac-error") {
      // Walmart IVR cluster's web-farm config rejects ~50% of POSTs with a
      // ViewState MAC error (no session affinity + AutoGenerate machineKey).
      // Diagnosed live via Playwright: same intermittent failure happens in
      // a vanilla browser with no extension involvement. Only client-side
      // recovery is to restart the flow from the root and try again.
      const retries = state.macErrorRetries || 0;
      if (retries >= MAX_MAC_RETRIES) {
        console.error(`[closinglist] ivr: MAC error after ${MAX_MAC_RETRIES} retries — giving up`);
        try {
          await chrome.runtime.sendMessage({
            module:     MODULE_ID,
            type:       "ivr-absences-collected",
            ok:         false,
            error:      `IVR server returned ViewState MAC errors on ${MAX_MAC_RETRIES} consecutive attempts — Walmart IT load-balancer issue (AutoGenerate machineKey in a web farm). Try Collect again in a moment.`,
            rows:       [],
            sourceUrl:  location.href,
          });
        } catch (_) {}
        try { await chrome.storage.local.set({ [FLOW_KEY]: { active: false } }); } catch (_) {}
        return;
      }
      console.warn(`[closinglist] ivr: MAC error from server, restarting from root (attempt ${retries + 1}/${MAX_MAC_RETRIES})`);
      try {
        await chrome.storage.local.set({
          [FLOW_KEY]: { ...state, macErrorRetries: retries + 1 },
        });
      } catch (_) {}
      // Restart from root — the state machine will redrive through menu +
      // criteria. Each round-trip is a fresh roll of the LB dice; with
      // ~50% per-submit success, MAX_MAC_RETRIES gives us ~97% end-to-end.
      location.href = IVR_ROOT_URL;
      return;
    }

    if (where === "criteria-rejected") {
      const tries = state.criteriaRetries || 0;
      if (tries >= MAX_CRITERIA_RETRIES) {
        const inv = describeInventory(state.criteriaControls);
        console.error("[closinglist] ivr: criteria rejected", MAX_CRITERIA_RETRIES, "times; page offered:", inv);
        try {
          await chrome.runtime.sendMessage({
            module:    MODULE_ID,
            type:      "ivr-absences-collected",
            ok:        false,
            error:
              `IVR rejected the report criteria ${MAX_CRITERIA_RETRIES} times ("You select at least one option for the report"). ` +
              `The criteria page offered: ${inv}. If the option we tick (#rdoCriteria_0) is not in that list, IVR has changed the form.`,
            rows:      [],
            sourceUrl: location.href,
          });
        } catch (_) {}
        try { await chrome.storage.local.set({ [FLOW_KEY]: { active: false } }); } catch (_) {}
        return;
      }
      console.warn(`[closinglist] ivr: criteria rejected, restarting from root (attempt ${tries + 1}/${MAX_CRITERIA_RETRIES})`);
      try {
        await chrome.storage.local.set({ [FLOW_KEY]: { ...state, criteriaRetries: tries + 1 } });
      } catch (_) {}
      location.href = IVR_ROOT_URL;
      return;
    }

    // Forward progress: we're on a real flow page, so the last submit's LB
    // roll succeeded. Reset the MAC-retry budget — otherwise scattered
    // transient blips across a single session accumulate and falsely trip
    // the give-up threshold even though we keep advancing. The budget is
    // meant to cap *consecutive* failures, not lifetime ones.
    if ((where === "menu" || where === "criteria" || where === "absence-table") && state.macErrorRetries) {
      try {
        await chrome.storage.local.set({ [FLOW_KEY]: { ...state, macErrorRetries: 0 } });
        state = { ...state, macErrorRetries: 0 };
      } catch (_) {}
    }
    // Reaching the report clears the criteria budget too — it caps consecutive
    // rejections, not lifetime ones.
    if (where === "absence-table" && state.criteriaRetries) {
      try {
        await chrome.storage.local.set({ [FLOW_KEY]: { ...state, criteriaRetries: 0 } });
        state = { ...state, criteriaRetries: 0 };
      } catch (_) {}
    }

    if (where === "menu") {
      // Menu page: the "AIL Absences and Tardies" radio has AutoPostBack
      // wired to its onclick — a plain .click() fires the postback that
      // re-renders the page with the Next button enabled. Dispatching a
      // synthetic `change` event on top of that fires AutoPostBack twice
      // and races the second submit with a stale __VIEWSTATE, which the
      // server rejects with "Validation of viewstate MAC failed". So just
      // .click() here, then click Next once the page has settled.
      if (clickIfPresent("#rdoMenu_0")) {
        console.debug("[closinglist] ivr: selected menu option, waiting for AutoPostBack then clicking Next");
        // 600ms covers the partial-postback round-trip on this page. The
        // page state machine will retry on the next page load if Next
        // ends up firing before the postback completes — at worst we lose
        // one tick.
        setTimeout(() => clickIfPresent("#btnNext"), 600);
      } else {
        console.warn("[closinglist] ivr: menu radio #rdoMenu_0 not found");
      }
    } else if (where === "criteria") {
      // Criteria page. Two things used to go wrong here, both of which ended
      // as "You select at least one option for the report":
      //
      //   1. We submitted on a fixed 600ms timer without ever checking that
      //      the radio had actually taken. If it hadn't, the POST carried no
      //      selection and the server rejected it — and the rejection page
      //      wasn't a state we recognised, so the flow just stopped.
      //   2. selectRadio() dispatches change + input unconditionally. On the
      //      menu page that is exactly what fires AutoPostBack twice and gets
      //      the second submit rejected for a stale __VIEWSTATE (see above).
      //      If this radio is ever wired the same way, forcing the events is
      //      the bug rather than the fix — so check before doing it.
      //
      // Stash the control inventory first: if this still fails, the error we
      // report should name what the page offered.
      try {
        await chrome.storage.local.set({
          [FLOW_KEY]: { ...state, criteriaControls: criteriaInventory() },
        });
      } catch (_) {}

      const radio = document.querySelector("#rdoCriteria_0");
      if (!radio) {
        const seen = describeInventory(criteriaInventory());
        console.warn("[closinglist] ivr: criteria radio #rdoCriteria_0 not found; page offered:", seen);
      } else if (radio.checked) {
        // Already selected — either we ticked it before an AutoPostBack round
        // trip, or the page defaults to it. Just submit.
        console.debug("[closinglist] ivr: criteria already selected, clicking Display Report");
        clickIfPresent("#btnDisplayReport");
      } else if (/__doPostBack/i.test(radio.getAttribute("onclick") || "")) {
        // Let the page's own postback do the work; we come back round on the
        // reload with radio.checked true and submit then.
        console.debug("[closinglist] ivr: criteria radio has AutoPostBack, clicking and waiting for reload");
        radio.click();
      } else {
        // Plain .click() first — that is all the donor extension ever did here
        // (ClosingList/extension/content/ivr.js), and it worked. Forcing
        // change + input on top of it is the thing that can double-fire a
        // WebForms handler, so it is an escalation, not the default.
        radio.click();
        let took = await waitForChecked("#rdoCriteria_0", 1200);
        if (!took) {
          console.debug("[closinglist] ivr: plain click did not take, forcing checked + change/input");
          selectRadio("#rdoCriteria_0");
          took = await waitForChecked("#rdoCriteria_0", 1800);
        }
        if (!took) {
          console.warn("[closinglist] ivr: criteria radio would not stay checked — not submitting a blank form");
        } else {
          console.debug("[closinglist] ivr: selected criteria 'Current Day', clicking Display Report");
          clickIfPresent("#btnDisplayReport");
        }
      }
    } else if (where === "absence-table") {
      const result = scrapeAbsenceTable();
      try {
        await chrome.runtime.sendMessage({
          module:     MODULE_ID,
          type:       "ivr-absences-collected",
          ok:         result.ok,
          error:      result.error || null,
          rows:       result.rows || [],
          capturedAt: result.capturedAt || null,
          sourceUrl:  location.href,
        });
      } catch (_) {}
      try {
        await chrome.storage.local.set({ [FLOW_KEY]: { active: false } });
      } catch (_) {}
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.module !== MODULE_ID) return false;
    if (msg.type === "ivr-ping") {
      sendResponse({ ok: true, where: pageState(), pageUrl: location.href });
      return true;
    }
    if (msg.type === "ivr-progress-now") {
      progressIfFlowActive().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === "ivr-scrape-now") {
      sendResponse(scrapeAbsenceTable());
      return true;
    }
    return false;
  });

  // On every load while the flow is active, take the next step.
  progressIfFlowActive();
})();
