// modules/closinglist/view.js
//
// UI controller for the ClosingList module. Mounted by the shell when the
// user navigates to #/closinglist. Loads view.html + styles.css into the
// shell viewport, wires up inputs, drives the collect → render → email
// flow.
//
// Adapted from ClosingList donor (extension/popup/popup.js). Changes:
//   - Becomes an ES module exporting mount(host, container) per the suite
//     contract (docs/ARCHITECTURE.md::2)
//   - All `chrome.storage.sync.*` calls go through host.storage.sync.*
//     (which auto-prefixes "closinglist.")
//   - Tab management → host.tabs.findOrOpen + host.tabs.waitForLoad
//   - Content-script messaging → host.messaging.sendToTab with re-inject
//     fallback baked in
//   - Background RPC → host.messaging.send
//   - Styles injected via host.url("styles.css") on mount, removed on cleanup
//   - Element IDs prefixed with cl- to match view.html

import * as Parse from "./lib/parse.js";
import { uploadAssociatesToFirestore } from "./lib/firebaseUpload.js";
import { SSO_SELECTORS } from "../../shared/auth.js";

const DEFAULTS = {
  storeNbr: "",
  recipient: "",
  startHour: 13,
  endHour: 17,
  excludeOvernight: true,
  excludeJobs:
    "Stocking 2, Digital, AP Service, Auto Care, Cake Decorator, Deli/Bakery, " +
    "Dual Licensed Opt, Front End, In Home Delivery, Optician, Rx",
  includeIvr: true,
  showJobTitles: false,
};

// Older versions shipped narrower defaults. If a user still has one of these
// saved exactly, upgrade them silently to the latest default.
const KNOWN_OLD_EXCLUDE_DEFAULTS = ["Stocking 2, Digital"];

const HOST_MATCH      = /^https:\/\/radapps3\.wal-mart\.com\/Protected\/CaseVisibility\//;
const CV_URL          = "https://radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html";

export async function mount(host, container) {
  // 1. Inject this module's stylesheet (removed on cleanup).
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  document.head.appendChild(link);

  // 2. Load the markup.
  try {
    const resp = await fetch(host.url("view.html"));
    container.innerHTML = await resp.text();
  } catch (e) {
    container.innerHTML = `<div class="state-error">Failed to load ClosingList view: ${String(e?.message ?? e)}</div>`;
    return () => { link.remove(); };
  }

  // 3. Convenience selectors scoped to the container.
  const $ = (id) => container.querySelector("#" + id);

  // 4. Load saved preferences. host.storage.sync auto-prefixes "closinglist."
  const stored = await host.storage.sync.get();   // get-all-for-this-namespace
  // One-time auto-migration of outdated exclude defaults.
  if (stored.excludeJobs && KNOWN_OLD_EXCLUDE_DEFAULTS.includes(stored.excludeJobs.trim())) {
    stored.excludeJobs = DEFAULTS.excludeJobs;
    host.storage.sync.set("excludeJobs", DEFAULTS.excludeJobs).catch(() => {});
  }
  $("cl-storeNbr").value         = stored.storeNbr ?? DEFAULTS.storeNbr;
  $("cl-businessDate").value     = todayIso();
  $("cl-recipient").value        = stored.recipient ?? DEFAULTS.recipient;
  $("cl-startHour").value        = stored.startHour ?? DEFAULTS.startHour;
  $("cl-endHour").value          = stored.endHour ?? DEFAULTS.endHour;
  $("cl-excludeOvernight").checked = stored.excludeOvernight ?? DEFAULTS.excludeOvernight;
  $("cl-excludeJobs").value      = stored.excludeJobs ?? DEFAULTS.excludeJobs;
  $("cl-includeIvr").checked     = stored.includeIvr ?? DEFAULTS.includeIvr;
  $("cl-showJobTitles").checked  = stored.showJobTitles ?? DEFAULTS.showJobTitles;

  async function saveDefaults() {
    await host.storage.sync.set({
      storeNbr:         $("cl-storeNbr").value.trim() || DEFAULTS.storeNbr,
      recipient:        $("cl-recipient").value.trim(),
      startHour:        Number($("cl-startHour").value) || DEFAULTS.startHour,
      endHour:          Number($("cl-endHour").value)   || DEFAULTS.endHour,
      excludeOvernight: $("cl-excludeOvernight").checked,
      excludeJobs:      $("cl-excludeJobs").value,
      includeIvr:       $("cl-includeIvr").checked,
      showJobTitles:    $("cl-showJobTitles").checked,
    });
  }

  // 5. Status helper.
  const $status = $("cl-status");
  function setStatus(text, kind /* "ok" | "error" | "" */) {
    $status.textContent = text;
    $status.className = "status-strip" + (kind ? ` status-strip-${kind}` : "");
  }

  // 6. Tab management — find or open the CaseVisibility tab, verify URL.
  //    Background-only: if the tab lands on an SSO redirect, auto-click the
  //    company-SSO button and poll for the redirect back to CaseVisibility.
  //    User never has to leave APAISuite as long as their SSO is cached.
  //    Shared SSO_SELECTORS list lives in shared/auth.js so adding a new
  //    Walmart-corp-SSO button variant is a single edit.
  async function findOrOpenCaseVisibilityTab() {
    const existing = await host.tabs.query({
      url: "https://radapps3.wal-mart.com/Protected/CaseVisibility/*",
    });
    if (existing.length) return existing[0];

    setStatus("Opening CaseVisibility (background)…");
    const created = await host.tabs.create({ url: CV_URL, active: false });
    const loaded = await host.tabs.waitForLoad(created.id, 30_000);
    if (!loaded) throw new Error("CaseVisibility tab load timed out.");

    let finalTab = await host.tabs.get(created.id);
    if (HOST_MATCH.test(finalTab.url || "")) return finalTab;

    // Off CaseVisibility — tab is on the SSO redirect. Try to auto-click.
    setStatus("Signing in to CaseVisibility…");
    await host.auth.clickSso(created.id, SSO_SELECTORS);

    // Poll for redirect back to CaseVisibility (SSO round-trip may bounce
    // through Okta + MFA, so allow up to 45s — typical cached-creds path
    // finishes in 2-5s).
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      finalTab = await host.tabs.get(created.id).catch(() => null);
      if (!finalTab) throw new Error("CaseVisibility tab was closed mid sign-in.");
      if (HOST_MATCH.test(finalTab.url || "")) return finalTab;
    }
    throw new Error(
      "Couldn't auto-sign in to CaseVisibility. The tab is open in the " +
      "background — finish the sign-in there (incl. MFA if prompted), then click Collect again."
    );
  }

  // 7. The Collect flow.
  async function onCollect() {
    // Collect IS the module. Recorded at the click, not on completion, so a
    // run that fails still counts as used — see shared/host.js::usage.
    host.usage.record("collect");
    const $collect = $("cl-collect");
    $collect.disabled = true;
    setStatus("Finding CaseVisibility tab…");
    try {
      await saveDefaults();
      const storeNbr         = $("cl-storeNbr").value.trim() || DEFAULTS.storeNbr;
      const businessDate     = $("cl-businessDate").value || todayIso();
      const startHour        = Number($("cl-startHour").value) || DEFAULTS.startHour;
      const endHour          = Number($("cl-endHour").value)   || DEFAULTS.endHour;
      const excludeOvernight = $("cl-excludeOvernight").checked;
      const excludeJobs      = $("cl-excludeJobs").value;
      const includeIvr       = $("cl-includeIvr").checked;
      const showJobTitles    = $("cl-showJobTitles").checked;

      const tab = await findOrOpenCaseVisibilityTab();
      setStatus("Calling CaseVisibility…");
      const resp = await host.messaging.sendToTab(
        tab.id,
        "collect-schedule",
        { storeNbr, businessDate },
        {
          fallbackScripts: [
            { file: `modules/${host.id}/content/casevisibility.js` },
          ],
        }
      );
      if (!resp || !resp.ok) throw new Error(resp?.error || "Unknown response");

      let ivrRows = [];
      let ivrStatus = "";
      if (includeIvr) {
        setStatus("Collecting IVR call-offs (this opens an IVR tab, ~5-15s)…");
        // host.messaging.send rejects on { ok: false }, so the catch is the
        // only failure path here. ivrResp on the happy path always has ok:true.
        try {
          const ivrResp = await host.messaging.send("collect-ivr-absences");
          ivrRows   = ivrResp.rows || [];
          ivrStatus = `, ${ivrRows.length} IVR rows`;
        } catch (e) {
          ivrStatus = `, IVR failed: ${e?.message ?? e}`;
        }
      }

      const model = Parse.build(resp.data, {
        cutoff: { startHour, endHour },
        excludeOvernight,
        excludeJobs,
        ivrRows,
      });
      const text = Parse.render(model, { storeNbr, businessDate, showJobTitles });
      $("cl-email").value = text;
      const calledOffCount = model.associates.filter((a) => a.calledOff).length;

      // Best-effort push to the Closing Manager Checklist Firestore so the
      // webapp (any device, same store-date) picks the list up live. Skipped
      // automatically when nothing changed since the last upload.
      let cloudStatus = "";
      try {
        const cloud = await uploadAssociatesToFirestore(model, {
          storeNbr, businessDate, uploadedBy: "extension",
        });
        if (cloud.ok && cloud.skipped) cloudStatus = ", cloud: unchanged";
        else if (cloud.ok)              cloudStatus = ", cloud: synced";
        else                            cloudStatus = `, cloud: ${cloud.error}`;
      } catch (e) {
        cloudStatus = `, cloud: ${e?.message ?? e}`;
      }

      setStatus(
        `Done. ${model.includedCount} of ${model.totalScheduled} ` +
          `(skipped: cutoff=${model.skipped.skippedNotAfternoon}, overnight=${model.skipped.skippedOvernight}, ` +
          `jobs=${model.skipped.skippedByJobFilter}, no-name=${model.skipped.skippedNoName})` +
          `; ${calledOffCount} marked CALLED OFF` + ivrStatus + cloudStatus,
        "ok"
      );
    } catch (e) {
      setStatus(String(e?.message ?? e), "error");
    } finally {
      // Use the captured reference — $("cl-collect") would return null if the
      // user navigated away mid-collect (container detached). Setting .disabled
      // on a detached node is a safe no-op.
      $collect.disabled = false;
    }
  }

  async function onCopy() {
    const text = $("cl-email").value;
    if (!text) { setStatus("Email is empty.", "error"); return; }
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied to clipboard.", "ok");
    } catch (e) {
      setStatus("Copy failed: " + (e?.message ?? e), "error");
    }
  }

  function onOpenOutlook() {
    const text = $("cl-email").value;
    const recipient    = $("cl-recipient").value.trim();
    const storeNbr     = $("cl-storeNbr").value.trim() || DEFAULTS.storeNbr;
    const businessDate = $("cl-businessDate").value || todayIso();
    if (!text) { setStatus("Generate the draft first.", "error"); return; }
    const subject = `Closing List — Store ${storeNbr} — ${businessDate}`;
    const url =
      `https://outlook.office.com/mail/deeplink/compose` +
      `?to=${encodeURIComponent(recipient)}` +
      `&subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(text)}`;
    if (url.length > 8000) {
      setStatus(
        "Body too long for URL deeplink — use Copy and paste into a new Outlook draft.",
        "error"
      );
      return;
    }
    host.tabs.create({ url });
  }

  function onResetExcludeJobs() {
    $("cl-excludeJobs").value = DEFAULTS.excludeJobs;
    host.storage.sync.set("excludeJobs", DEFAULTS.excludeJobs).catch(() => {});
    setStatus("Exclude list reset to default.", "ok");
  }

  // 8. Wire listeners.
  $("cl-collect").addEventListener("click", onCollect);
  $("cl-copy").addEventListener("click", onCopy);
  $("cl-openOutlook").addEventListener("click", onOpenOutlook);
  $("cl-resetExcludeJobs").addEventListener("click", onResetExcludeJobs);

  // 9. Cleanup function — invoked (awaited) by the shell on route change.
  // Async so future teardown (unsubscribing from host.messaging.on listeners,
  // cancelling in-flight ops) can be added without changing the contract.
  return async () => {
    link.remove();
    // Future: any host.messaging.on() unsubscribe handles go here.
  };
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
