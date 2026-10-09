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
import { collectSchedule, failureKind } from "./lib/collection.js";
import { uploadAssociatesToFirestore } from "./lib/firebaseUpload.js";
import { SSO_SELECTORS } from "../../shared/auth.js";
import { withWeekday } from "../../shared/dates.js";

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
  // Job-titles appendix: checkbox removed from the UI; always off (code path kept).

  async function saveDefaults() {
    await host.storage.sync.set({
      storeNbr:         $("cl-storeNbr").value.trim() || DEFAULTS.storeNbr,
      recipient:        $("cl-recipient").value.trim(),
      startHour:        Number($("cl-startHour").value) || DEFAULTS.startHour,
      endHour:          Number($("cl-endHour").value)   || DEFAULTS.endHour,
      excludeOvernight: $("cl-excludeOvernight").checked,
      excludeJobs:      $("cl-excludeJobs").value,
      includeIvr:       $("cl-includeIvr").checked,
      showJobTitles:    false,
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
  async function findOrOpenCaseVisibilityTab(onCreated, forceFresh = false) {
    const existing = await host.tabs.query({
      url: "https://radapps3.wal-mart.com/Protected/CaseVisibility/*",
    });
    if (!forceFresh && existing.length) return existing[0];

    setStatus("Loading schedule…");
    const created = await host.tabs.create({ url: CV_URL, active: false });
    onCreated(created.id);
    const loaded = await host.tabs.waitForLoad(created.id, 30_000);
    if (!loaded) throw new Error("Schedule timed out. Try again.");

    let finalTab = await host.tabs.get(created.id);
    if (HOST_MATCH.test(finalTab.url || "")) return finalTab;

    // Off CaseVisibility — tab is on the SSO redirect. Try to auto-click.
    setStatus("Signing in…");
    await host.auth.clickSso(created.id, SSO_SELECTORS);

    // Poll for redirect back to CaseVisibility (SSO round-trip may bounce
    // through Okta + MFA, so allow up to 45s — typical cached-creds path
    // finishes in 2-5s).
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      finalTab = await host.tabs.get(created.id).catch(() => null);
      if (!finalTab) throw new Error("Sign-in tab was closed. Try again.");
      if (HOST_MATCH.test(finalTab.url || "")) return finalTab;
    }
    onCreated(null); // Leave the sign-in tab available for manual MFA.
    throw new Error(
      "Couldn't sign in to CaseVisibility automatically. Finish the sign-in " +
      "in the tab that opened, then click Collect again."
    );
  }

  // 7. The Collect flow.
  async function onCollect() {
    // Collect IS the module. Recorded at the click, not on completion, so a
    // run that fails still counts as used — see shared/host.js::usage.
    host.usage.record("collect");
    const $collect = $("cl-collect");
    $collect.disabled = true;
    setStatus("Loading schedule…");
    let ownedTabId = null;
    const startedAt = Date.now();
    let stage = "schedule";
    const emit = (event, payload) => host.logging.emit(event, payload);
    emit("collect_started", {});
    try {
      await saveDefaults();
      const storeNbr         = $("cl-storeNbr").value.trim() || DEFAULTS.storeNbr;
      const businessDate     = $("cl-businessDate").value || todayIso();
      const startHour        = Number($("cl-startHour").value) || DEFAULTS.startHour;
      const endHour          = Number($("cl-endHour").value)   || DEFAULTS.endHour;
      const excludeOvernight = $("cl-excludeOvernight").checked;
      const excludeJobs      = $("cl-excludeJobs").value;
      const includeIvr       = $("cl-includeIvr").checked;
      const showJobTitles    = false; // checkbox removed from the UI; appendix kept off

      let tab = await findOrOpenCaseVisibilityTab((id) => { ownedTabId = id; });
      setStatus("Loading schedule…");
      const resp = await collectSchedule({
        emit,
        recover: async () => {
          setStatus("Signing in…");
          if (ownedTabId != null) await host.tabs.remove(ownedTabId).catch(() => {});
          ownedTabId = null;
          tab = await findOrOpenCaseVisibilityTab((id) => { ownedTabId = id; }, true);
        },
        collect: () => host.messaging.sendToTab(
        tab.id,
        "collect-schedule",
        { storeNbr, businessDate },
        {
          fallbackScripts: [
            { file: `modules/${host.id}/content/casevisibility.js` },
          ],
        }
      )
      });
      emit("schedule_succeeded", { durationMs: Date.now() - startedAt });
      if (ownedTabId != null) {
        await host.tabs.remove(ownedTabId).catch(() => {});
        ownedTabId = null;
      }

      let ivrRows = [];
      let ivrStatus = "";
      if (includeIvr) {
        stage = "ivr";
        setStatus("Checking call-offs…");
        // host.messaging.send rejects on { ok: false }, so the catch is the
        // only failure path here. ivrResp on the happy path always has ok:true.
        try {
          const ivrResp = await host.messaging.send("collect-ivr-absences");
          ivrRows   = ivrResp.rows || [];
          emit("ivr_succeeded", { rowCount: ivrRows.length });
          ivrStatus = `, ${ivrRows.length} IVR rows`;
        } catch (e) {
          emit("ivr_failed", { kind: failureKind(e) });
          console.warn("[closinglist] IVR call-offs failed:", e);
          ivrStatus = `, IVR failed: ${e?.message ?? e}`;
        }
      }

      stage = "render";
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
        if (!cloud.ok) {
          console.warn("[closinglist] checklist sync failed:", cloud.error);
          cloudStatus = " Checklist sync failed.";
        }
      } catch (e) {
        console.warn("[closinglist] checklist sync failed:", e);
        cloudStatus = " Checklist sync failed.";
      }

      emit("collect_finished", { durationMs: Date.now() - startedAt, schedule: "ok", ivr: includeIvr ? (ivrStatus.includes("IVR failed") ? "failed" : "ok") : "skipped", rowCount: model.includedCount });
      const ivrFailedNote = ivrStatus.includes("IVR failed") ? " Couldn't check call-offs." : "";
      setStatus(
        `Done: ${model.includedCount} closer${model.includedCount === 1 ? "" : "s"}, ${calledOffCount} called off.` +
          ivrFailedNote + cloudStatus,
        "ok"
      );
      $status.title =
        `${model.includedCount} of ${model.totalScheduled} scheduled. Left out: ` +
        `${model.skipped.skippedNotAfternoon} before the cutoff, ${model.skipped.skippedOvernight} overnight, ` +
        `${model.skipped.skippedByJobFilter} excluded jobs, ${model.skipped.skippedNoName} without a name.`;
      return { ok: true, storeNbr, businessDate, count: model.includedCount, calledOff: calledOffCount, ivrFailed: ivrStatus.includes("IVR failed") };
    } catch (e) {
      emit("collect_failed", { stage, kind: failureKind(e), durationMs: Date.now() - startedAt });
      setStatus(String(e?.message ?? e), "error");
      return { ok: false, error: String(e?.message ?? e) };
    } finally {
      // Use the captured reference — $("cl-collect") would return null if the
      // user navigated away mid-collect (container detached). Setting .disabled
      // on a detached node is a safe no-op.
      $collect.disabled = false;
      if (ownedTabId != null) await host.tabs.remove(ownedTabId).catch(() => {});
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
    if (!text) { setStatus("Click Collect first.", "error"); return; }
    const subject = `Closing List — Store ${storeNbr} — ${withWeekday(businessDate)}`;
    const url =
      `https://outlook.office.com/mail/deeplink/compose` +
      `?to=${encodeURIComponent(recipient)}` +
      `&subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(text)}`;
    if (url.length > 8000) {
      setStatus(
        "Too long to open in Outlook. Use Copy and paste.",
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

  // Persist preferences as soon as they change. Previously they were only
  // saved when Collect ran, so an edited recipient followed by Copy / Open
  // Outlook / navigating away silently reverted to the last saved value on
  // the next mount.
  const PREF_IDS = [
    "cl-storeNbr", "cl-recipient", "cl-startHour", "cl-endHour",
    "cl-excludeOvernight", "cl-excludeJobs", "cl-includeIvr",
  ];
  const onPrefChange = () => { saveDefaults().catch(() => {}); };
  for (const id of PREF_IDS) $(id)?.addEventListener("change", onPrefChange);

  // 8b. Headless job. metricshot opens app.html?clReport=<json>#/closinglist in
  // a background tab at its scheduled time; Collect runs exactly as the button
  // does (saved prefs, today's date) and the email text goes back through
  // storage. Business date is always today: it is a list of who closes today.
  (async () => {
    let job = null;
    try { job = JSON.parse(new URLSearchParams(location.search).get("clReport") || "null"); } catch { /* not a job */ }
    if (!job?.id) return;
    const res = await onCollect();
    const text = $("cl-email")?.value || "";
    const storeNbr = res?.storeNbr || $("cl-storeNbr")?.value.trim() || "";
    const businessDate = res?.businessDate || todayIso();
    const out = res?.ok && text
      ? { ok: true, text, storeNbr, businessDate, count: res.count, calledOff: res.calledOff, ivrFailed: !!res.ivrFailed,
          subject: `Closing List — Store ${storeNbr} — ${withWeekday(businessDate)}` }
      : { ok: false, error: res?.error || "Collect produced no list" };
    await chrome.storage.local.set({ [`metricshot.reportJob.${job.id}`]: { ...out, at: Date.now() } }).catch(() => {});
  })();

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
