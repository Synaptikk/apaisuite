// lib/auror_event.js — Auror /event/new auto-filler (UI-driven, extension side)
// ───────────────────────────────────────────────────────────────────────────
// Port of pipeline/auror_filler.py into a pair of service-worker + content-
// script functions:
//
//   1. The service worker (background.js) receives a `create_event` message,
//      shapes an AurorFillData from the APPRISS txn, opens a new tab on
//      /event/new, waits for it to load, then injects `driveForm` via
//      chrome.scripting.executeScript.
//
//   2. `driveForm` (exported below) runs in the Auror tab's isolated world.
//      It walks every selector documented in AUROR_FILLER_WIRING.md, typing
//      and clicking just like Playwright would. Takes ~30-45s per event
//      (same as the Python filler — the speed ceiling is Auror's own
//      render/hydrate).
//
// Why not a direct API POST yet? The endpoint + request body shape aren't
// in any file we have — we'd need a sniff first. This UI-driven path uses
// only selectors we've already validated (AUROR_FILLER_WIRING.md last
// updated 2026-04-15), so it ships today. When we do sniff and get the
// direct POST working, swap `driveForm` for `postEvent` and the button
// wiring upstream doesn't change.

// ─── Data shape (mirror of pipeline/auror_filler.py::AurorFillData) ────────

export function fromTransaction(txn, { store, suspectName = "", personId = "", storeDetails = "", licensePersonInfo = null } = {}) {
  const rawDt = String(txn?.datetime ?? "").trim();
  const [date, time] = parseDatetime(rawDt);
  const data = {
    store:        String(store ?? txn?.store ?? "").trim(),
    register:     String(txn?.register ?? "").trim(),
    date,                       // MM/DD/YYYY
    time,                       // h:MM AM/PM (no leading zero on hour)
    trans_no:     String(txn?.trans_no ?? "").trim(),
    amount:       String(txn?.amount ?? "").trim(),
    suspect_name: (suspectName ?? "").trim(),
    // Keep the P prefix — Auror's person lookup ranks exact P-number matches
    // first when the search term includes 'P' (e.g. P5376123 surfaces Tena
    // Baker as result #1; typing just 5376123 buries her in a longer list).
    // auror_scraper returns it as 'P<digits>'; pass it through unchanged.
    person_id:    String(personId ?? "").trim(),
    // e.g. 'Walmart 9999 - 100 EXAMPLE ST, ANYTOWN, ST'
    // Supplied by the UI from the scan's store list (app.js caches it).
    // Used in the description template.
    store_details: (storeDetails ?? "").trim() || `Walmart ${store ?? ""}`,
    // Defaults match pipeline/auror_filler.py::AurorFillData
    people_count:    1,
    vehicles_count:  0,
    products:        true,
    police_called:   false,
    use_my_details:  true,
    witnessed_label: "Observed video footage",
    // Optional: when set, driveForm runs the license-intake-specific flow:
    //   - skip event-type click (operator picks the right one later)
    //   - date = today, time = scanTime − 10 min
    //   - skip description / narrative ("not relevant for this tool")
    //   - fill Person 1 form fields DIRECTLY (no lookup-search step)
    //   - stop after Person 1 — operator finishes Next / submit
    license_person_info: licensePersonInfo || null,
  };
  data.description = generateDescription(data);

  // License-intake overrides — when caller passes licensePersonInfo, this
  // event represents a license capture, not a real transaction. Per spec:
  // date is "today", time is "scan time − 10 minutes" so the timestamp
  // sits a few minutes before the operator scanned the license at the
  // service desk, and the narrative is cleared (operator writes one).
  if (licensePersonInfo) {
    const scannedAt = typeof licensePersonInfo.scannedAt === "number"
      ? licensePersonInfo.scannedAt
      : Date.now();
    const adjusted = new Date(scannedAt - 10 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    data.date = `${pad(adjusted.getMonth() + 1)}/${pad(adjusted.getDate())}/${adjusted.getFullYear()}`;
    let hour = adjusted.getHours() % 12;
    if (hour === 0) hour = 12;
    const ampm = adjusted.getHours() >= 12 ? "PM" : "AM";
    data.time = `${hour}:${pad(adjusted.getMinutes())} ${ampm}`;
    data.description = "";  // not relevant for license intake
    data.register = "";     // no register involved
    data.trans_no = "";
    data.amount = "";
  }

  return data;
}

function parseDatetime(raw) {
  if (!raw) return ["", ""];
  // APPRISS normally returns "YYYY-MM-DD HH:MM:SS". We try a few formats
  // tolerantly — match pipeline/auror_filler.py::_parse_datetime.
  const iso  = raw.replace(" ", "T");
  const cand = [iso, raw, raw + ":00"];
  let dt = null;
  for (const c of cand) {
    const d = new Date(c);
    if (!isNaN(d.getTime())) { dt = d; break; }
  }
  if (!dt) return [raw, ""];
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${pad(dt.getMonth() + 1)}/${pad(dt.getDate())}/${dt.getFullYear()}`;
  // h:MM AM/PM — no leading zero on hour (Auror's placeholder is '1:15 PM')
  let hour = dt.getHours() % 12;
  if (hour === 0) hour = 12;
  const ampm = dt.getHours() >= 12 ? "PM" : "AM";
  const time = `${hour}:${pad(dt.getMinutes())} ${ampm}`;
  return [date, time];
}

// Structured narrative description matching the format the AP team uses.
// TWO [YOUR VALUE HERE] placeholders by design:
//   - theft amount: the transaction's $ value is the amount the suspect
//     *paid* at the register, NOT the amount they actually deprived the
//     company of. The real theft value is officer judgement (skipped
//     scans / pulled tags etc. aren't on the tender receipt).
//   - method: same reason as before — can't be inferred from tender data.
// Gender-neutral "they" because the suspect's gender isn't in the data.
function generateDescription(d) {
  const dateTime = [d.date, d.time].filter(Boolean).join(" at or around ") || "the transaction date";
  const store    = d.store_details || `Walmart ${d.store || "?"}`;
  const name     = d.suspect_name || "(unknown)";
  const register = d.register ? `self checkout register ${d.register}` : "a self checkout register";
  return (
    `On ${dateTime}, located at ${store}, an individual potentially ` +
    `identified as "${name}" was observed at ${register} where they ` +
    `deprived the company of approximately [YOUR VALUE HERE] by [YOUR VALUE HERE]. ` +
    `This theft was identified via an automated system that identifies ` +
    `high risk individuals who have multiple thefts at neighboring stores.`
  );
}

// ─── Public entry point called from background.js ──────────────────────────

export async function fillAurorEvent(data, { onLog } = {}) {
  const log = (m) => onLog?.(m);
  log(`Auror filler: store=${data.store} register=${data.register} trans=${data.trans_no}`);

  // License-intake mode: operator needs to see the form to review and
  // submit. Open the tab focused. For regular transaction fills,
  // background mode lets the officer keep working while we fill.
  const isLicenseIntake = !!data.license_person_info;

  const tab = await chrome.tabs.create({
    url: "https://app.us.auror.co/event/new",
    active: isLicenseIntake,
  });
  // For license-intake, also focus the window holding the tab — `active`
  // alone doesn't pull the window forward when Auror opens in a non-
  // focused window (e.g. operator's primary monitor vs. license-intake
  // overlay on secondary).
  if (isLicenseIntake && tab.windowId != null) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); }
    catch { /* ignore — not all platforms support this */ }
  }

  // Wait for initial load. We also add a short settle because Auror's
  // React app keeps hydrating after 'complete'.
  await waitForTabLoad(tab.id);
  await sleep(1200);

  // Inject the form driver into the tab's page context.
  let result;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: driveForm,
      args: [data],
      world: "MAIN"
    });
    result = injection?.result;
  } catch (e) {
    return { status: "error", error: `scripting.executeScript failed: ${e.message || e}` };
  }

  if (!result) return { status: "error", error: "Driver returned no result (did the page navigate away?)" };

  // License-intake mode: re-focus the tab + window after the fill stops.
  // The form is now pre-populated and ready for operator review — they
  // need to see it. (driveForm may have taken 10-30s, during which the
  // operator could have switched to another window.)
  if (isLicenseIntake) {
    try {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch { /* ignore — best-effort focus */ }
  }

  // Replay the per-step log captured inside driveForm so the operator
  // can see it in the SW console / fill_progress panel. driveForm runs
  // in the page's MAIN world and can't call onLog directly, so it
  // accumulates a `log` array we replay here.
  if (Array.isArray(result.log)) {
    for (const line of result.log) {
      try { onLog?.(line); } catch { /* ignore */ }
      console.log("[Auror filler]", line);
    }
  }

  if (result.error) return { status: "error", error: result.error, url: result.url, log: result.log };
  return { status: "filled", url: result.url, log: result.log };
}

// ─── Tab/timing helpers ────────────────────────────────────────────────────

async function waitForTabLoad(tabId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── The form driver (runs inside the Auror tab — world: "MAIN") ───────────
//
// Every selector here is copied from AUROR_FILLER_WIRING.md's selector map
// (validated 2026-04-15 against the live form). If Auror moves a selector,
// the filler breaks at that step and `log` will pinpoint which one.
//
// IMPORTANT: this function is serialised via chrome.scripting.executeScript
// so it CAN'T close over anything outside itself. All helpers are inline.

function driveForm(data) {
  const log = [];
  const note = (m) => log.push(m);

  const FIELD_TIMEOUT_MS        = 15_000;
  const SETTLE_SHORT_MS         = 600;
  const SETTLE_AFTER_LOCATION_MS = 2500;
  const SETTLE_FORM_NAV_MS      = 1500;
  const LOCATION_OPTION_TIMEOUT = 10_000;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function waitFor(selector, timeout = FIELD_TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null /* visible */) return el;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${selector}`);
  }

  async function safeClick(selector, timeout) {
    const el = await waitFor(selector, timeout);
    el.click();
  }

  // React-aware fill: set value via the property descriptor so React picks up
  // the change, then dispatch an input event so listeners run, then change.
  function setReactValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc  = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else                  el.value = value;
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Character-by-character typing — more reliable than bulk setReactValue for
  // debounced autocomplete components that listen for keydown/InputEvent.
  // Each char dispatches the full keydown → InputEvent → input → keyup sequence
  // a real keyboard produces, so React's synthetic event system picks it up.
  async function typeSlowly(el, text, { delayMs = 40 } = {}) {
    el.focus();
    // Clear first with native setter so React doesn't see a stale value.
    const proto = Object.getPrototypeOf(el);
    const desc  = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, "");
    else el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    let current = "";
    for (const char of text) {
      current += char;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      // InputEvent with inputType:'insertText' is what browsers actually emit.
      if (desc?.set) desc.set.call(el, current);
      else el.value = current;
      el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: char, bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup",   { key: char, bubbles: true }));
      await sleep(delayMs);
    }
  }

  async function safeFill(selector, value, timeout) {
    const el = await waitFor(selector, timeout);
    el.focus();
    setReactValue(el, value);
  }

  // Click the radio label for count n (0–5) on the People or Vehicles row.
  //
  // Auror renders these as <input type="radio"> + <label> pairs, NOT <button>
  // elements. Every label carries a stable data-locator attribute in the form:
  //   EventDetails-People-1   EventDetails-Vehicles-0   etc.
  // Using that attribute is far more robust than any text/DOM traversal.
  //
  // section: 'People' | 'Vehicles'
  async function clickCountLabel(section, n) {
    const locator  = `EventDetails-${section}-${n}`;
    const deadline = Date.now() + FIELD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const el = document.querySelector(`[data-locator="${locator}"]`);
      if (el && el.offsetParent !== null) { el.click(); return; }
      await sleep(150);
    }
    throw new Error(`[data-locator="${locator}"] not found after ${FIELD_TIMEOUT_MS}ms`);
  }

  // Person 1 lookup — after people_count is set to 1, Auror reveals a
  // 'Person 1' section with a 'Person lookup' search box that auto-
  // suggests existing people by name / ID / characteristics. Typing the
  // suspect's P-number (digits only — strip the 'p') and clicking the
  // autocomplete match auto-fills every field (name, photo, age etc.)
  // from the existing Auror person record. Skip silently if person_id
  // wasn't provided (so the fill still works for transactions we don't
  // have an Auror match for).
  async function lookupPerson1(personId, resolvedPersonName) {
    if (!personId) return;

    // Always search with the P prefix — Auror ranks P-number matches first.
    const searchTerm = /^p/i.test(personId) ? personId.toUpperCase() : `P${personId}`;
    const digitsOnly = searchTerm.replace(/^P/i, "");

    // ─── Find the lookup input (four strategies, first win) ─────────────
    // We can't verify the live DOM ahead of time, so we try multiple
    // approaches and log which one succeeds for future debugging.
    const deadline = Date.now() + FIELD_TIMEOUT_MS;
    let input  = null;
    let strategy = "none";

    while (Date.now() < deadline && !input) {
      // S1: data-locator attr containing 'lookup' or 'person' (Auror's
      //     data-locator pattern matches the People-1 button we already use).
      for (const el of document.querySelectorAll("[data-locator]")) {
        if (!el.offsetParent) continue;
        const loc = (el.getAttribute("data-locator") || "").toLowerCase();
        if (!loc.includes("person") && !loc.includes("lookup")) continue;
        const inp = el.matches("input") ? el : el.querySelector("input");
        if (inp?.offsetParent) { input = inp; strategy = `data-locator[${el.getAttribute("data-locator")}]`; break; }
      }
      if (input) break;

      // S2: placeholder or aria-label containing common person-search terms.
      for (const sel of [
        "input[placeholder*='person' i]",
        "input[placeholder*='subject' i]",
        "input[placeholder*='name' i]",
        "input[placeholder*='ID' i]",
        "input[placeholder*='lookup' i]",
        "input[aria-label*='person' i]",
        "input[aria-label*='lookup' i]",
      ]) {
        const el = document.querySelector(sel);
        if (el?.offsetParent) { input = el; strategy = `placeholder/aria: ${sel}`; break; }
      }
      if (input) break;

      // S3: find a visible element whose text includes 'person', then walk UP
      //     at most 8 ancestors to find a container that holds an input child.
      //     (Safer than closest("div") which stops at the first match.)
      for (const el of document.querySelectorAll("strong, b, h3, h4, label, span, p")) {
        const t = (el.textContent || "").trim();
        if (!/person/i.test(t) || t.length > 100 || !el.offsetParent) continue;
        let node = el.parentElement;
        for (let i = 0; i < 8 && node && node !== document.body; i++, node = node.parentElement) {
          const inp = node.querySelector("input:not([type='hidden'])");
          if (inp?.offsetParent) { input = inp; strategy = `label walk: "${t.slice(0, 40)}"`; break; }
        }
        if (input) break;
      }
      if (input) break;

      // S4: last resort — grab the last visible EMPTY text input on the page.
      //     By the time lookupPerson1() runs, Location + Register + Date +
      //     Time are already filled, so the only empty input left should be
      //     the person lookup.
      const empties = [...document.querySelectorAll("input:not([type='hidden'])")].filter(
        el => el.offsetParent !== null &&
              !el.value &&
              el.type !== "checkbox" &&
              el.type !== "radio"
      );
      if (empties.length) {
        input = empties[empties.length - 1];
        strategy = `last-empty-input (#${empties.length} empties)`;
      }

      if (!input) await sleep(200);
    }

    if (!input) {
      note(`! Person lookup input not found — all 4 strategies failed (${searchTerm})`);
      return;
    }
    note(`Person lookup input found via: ${strategy}`);

    // ─── Type the search term character-by-character ──────────────────
    // typeSlowly dispatches the full keydown → InputEvent → input → keyup
    // sequence per character, which reliably triggers debounced autocomplete
    // components that ignore bulk setReactValue calls.
    await typeSlowly(input, searchTerm);

    // ─── Wait for autocomplete options ──────────────────────────────
    // Match priority:
    //   1. resolvedPersonName (exact API-resolved display name from pre-resolve)
    //   2. searchTerm (P-number with prefix, e.g. 'P5376123')
    //   3. digitsOnly (bare number without P, in case Auror omits prefix)
    //   4. single option (the list narrowed to exactly one hit)
    const optDeadline = Date.now() + 6000;
    while (Date.now() < optDeadline) {
      await sleep(200);
      const opts = [...document.querySelectorAll(
        "[role='option'], [role='listbox'] li, [role='menu'] li, [role='listitem']"
      )].filter(o => o.offsetParent !== null);

      for (const opt of opts) {
        const txt = opt.textContent || "";
        const matchName  = resolvedPersonName && txt.toLowerCase().includes(resolvedPersonName.toLowerCase());
        const matchPnum  = txt.includes(searchTerm) || txt.includes(digitsOnly);
        if (matchName || matchPnum) {
          opt.click();
          const matchedBy = matchName ? `name:${resolvedPersonName}` : `pnum:${searchTerm}`;
          note(`Person 1 lookup → ${matchedBy}`);
          return;
        }
      }
      if (opts.length === 1) {
        opts[0].click();
        note(`Person 1 lookup → (single option) ${searchTerm}`);
        return;
      }
    }
    note(`! Person lookup: no autocomplete match for ${searchTerm} / ${resolvedPersonName ?? 'no resolved name'}`);
  }

  // Find first element matching selector whose visible text includes `text`.
  async function findByText(selector, text, timeout = FIELD_TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
    const needle = text.toLowerCase();
    while (Date.now() < deadline) {
      const list = document.querySelectorAll(selector);
      for (const el of list) {
        if ((el.textContent || "").toLowerCase().includes(needle) &&
            el.offsetParent !== null) return el;
      }
      await sleep(100);
    }
    throw new Error(`no ${selector} with text "${text}"`);
  }

  // Witness-section 'Use my details' checkbox. Only renders after one of
  // the witness tiles is selected (we click 'Observed video footage'
  // first). Different element type from the reporter's button — we look
  // specifically for an <input type='checkbox'> whose associated label
  // (either wrapping or via for=id) says 'Use my details'. Skips the
  // reporter's button even if it's still in the DOM.
  async function clickWitnessUseMyDetails() {
    const deadline = Date.now() + FIELD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      for (const cb of document.querySelectorAll("input[type='checkbox']")) {
        if (cb.offsetParent === null) continue;
        let labelText = "";
        // Wrapping <label>...<input>...</label>
        const wrapping = cb.closest("label");
        if (wrapping) labelText = (wrapping.textContent || "").trim();
        // <input id=x> + <label for=x>
        if (!labelText && cb.id) {
          const ext = document.querySelector(`label[for="${cb.id}"]`);
          if (ext) labelText = (ext.textContent || "").trim();
        }
        if (/^\s*use my details\s*$/i.test(labelText)) {
          if (cb.checked) return;  // already checked — avoid un-ticking
          cb.click();
          return;
        }
      }
      await sleep(150);
    }
    throw new Error("witness 'Use my details' checkbox not found");
  }

  // Poll for a location-picker option containing the store NUMBER.
  // Auror's location dropdown markup varies — try multiple selectors
  // and match on substring (the store # is the distinctive token,
  // not "Walmart" which appears on every option).
  async function waitForLocationOption(storeNumber, timeoutMs) {
    const num = String(storeNumber).trim();
    if (!num) return null;
    const deadline = Date.now() + timeoutMs;
    const selectors = [
      "[role='option']",
      "[role='listbox'] li",
      "[role='menu'] li",
      "[role='listitem']",
      "ul[class*='option'] li",
      "ul[class*='dropdown'] li",
      "div[class*='option']",
      "div[class*='suggestion']",
      "li",
    ];
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        const list = document.querySelectorAll(sel);
        for (const el of list) {
          if (el.offsetParent === null) continue;
          const t = (el.textContent || "").trim();
          if (!t || t.length > 200) continue;
          // Match: contains the store number as a whole digit run AND
          // the word "Walmart" (or at least "store" / a comma to look
          // address-shaped). Avoids matching unrelated numbers on page.
          const numRegex = new RegExp(`\\b${num}\\b`);
          if (!numRegex.test(t)) continue;
          const tl = t.toLowerCase();
          if (tl.includes("walmart") || tl.includes("store") || t.includes(",")) {
            return el;
          }
        }
      }
      await sleep(150);
    }
    return null;
  }

  // Fallback for People=1 when the data-locator EventDetails-People-1
  // isn't present (e.g. Shoplifting flow may use different attributes).
  // Walks: any visible element with text "1" inside a container whose
  // adjacent text says "Person" or "People" — robust to label variants.
  async function clickPeopleOneFallback() {
    const deadline = Date.now() + FIELD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Strategy 1: <label> with text exactly "1" inside a row whose
      // ancestor textContent mentions "People" or "Person".
      const labels = document.querySelectorAll("label, button, [role='button'], [role='radio']");
      for (const el of labels) {
        if (el.offsetParent === null) continue;
        const t = (el.textContent || "").trim();
        if (t !== "1") continue;
        // Walk up to 6 ancestors looking for "People"/"Person" text.
        let node = el.parentElement;
        for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
          const ancestorText = (node.textContent || "").trim();
          if (/\bpeople\b|\bperson\b/i.test(ancestorText) && ancestorText.length < 200) {
            el.click();
            note(`[license]   People=1 fallback: clicked "${t}" in "${ancestorText.slice(0, 40)}..."`);
            return;
          }
        }
      }
      // Strategy 2: radio input with value="1" near "People" text.
      const radios = document.querySelectorAll("input[type='radio'][value='1']");
      for (const r of radios) {
        if (r.offsetParent === null) continue;
        const ancestor = r.closest("fieldset, [role='radiogroup'], section, div");
        const aText = (ancestor?.textContent || "").toLowerCase();
        if (/people|person/.test(aText)) {
          r.click();
          note(`[license]   People=1 fallback: clicked radio[value=1]`);
          return;
        }
      }
      await sleep(150);
    }
    throw new Error("no People=1 control found");
  }

  // Auror's Person 1 panel may render collapsed by default with just a
  // "Person 1" header that the operator clicks to expand the inline form.
  // If the form fields are already visible, this is a no-op. If they're
  // not, find a "Person 1" header/summary/button and click it.
  async function expandPerson1IfCollapsed() {
    // If "Enter names here" is already visible, the panel is open.
    const already = document.querySelector("input[placeholder='Enter names here']");
    if (already && already.offsetParent !== null) {
      note(`[license]   Person 1 panel already expanded`);
      return;
    }
    // Look for a collapsed header — usually a heading/button/summary with
    // text matching "Person 1" exactly (or "Person 1 of N").
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const candidates = document.querySelectorAll(
        "button, summary, h2, h3, h4, [role='button'], [data-locator]"
      );
      for (const el of candidates) {
        if (el.offsetParent === null) continue;
        const t = (el.textContent || "").trim();
        if (/^Person\s*1(\s|$)/i.test(t) && t.length < 50) {
          el.click();
          note(`[license]   Expanded "${t}"`);
          // Wait briefly for the form to render.
          await sleep(600);
          const opened = document.querySelector("input[placeholder='Enter names here']");
          if (opened && opened.offsetParent !== null) return;
        }
      }
      await sleep(200);
    }
    note(`[license]   No "Person 1" header to expand — assuming auto-expanded`);
  }

  // License-intake Person 1 filler. After People=1 is clicked, Auror
  // reveals an inline Person 1 panel that contains the new-person form
  // directly — NO separate lookup-search step is needed (the lookup
  // bar at the top is for matching an EXISTING Auror person; we want
  // to create a new one with license-derived fields).
  //
  // Field placeholders we target (confirmed from Auror live form):
  //   - "Enter names here"          → first name (the panel splits names
  //                                   into a names field + last name field)
  //   - "Enter last name here"      → last name
  //   - "MM/DD/YYYY"                → DOB
  //   - "Start typing to search"    → Address autocomplete (type, pick 1st)
  //   - ID type select + "Enter ID here" → driver's license # under Identification
  //   - Gender select               → M/F/X from license `sex`
  //
  // Skipped (operator fills if needed): mobile, height, build, appearance,
  // behaviors, outcome, method, trespass, "estimated age" radios.
  //
  // Returns true so the caller short-circuits the rest of driveForm
  // (description, Next clicks, witness, etc.) — none of those apply to
  // the license-intake flow.
  async function fillPerson1FromLicense(licenseInfo) {
    if (!licenseInfo) return false;
    note(`License-first path: filling Person 1 form fields directly`);

    // Person 1 panel takes a moment to render after People=1 is clicked.
    // Wait specifically for the "Enter names here" placeholder to appear.
    const ready = await waitForAnyVisible([
      "input[placeholder='Enter names here']",
      "input[placeholder*='Enter names' i]",
    ], 8000);
    if (!ready) {
      note(`! Person 1 form did not render — 'Enter names here' input missing`);
      return false;
    }

    // First names ("Enter names here" — singular field that Auror treats
    // as "given names", we include middle if present so it lands in the
    // same place as on the license).
    const firstNames = [licenseInfo.firstName, licenseInfo.middleName]
      .filter(Boolean).join(" ");
    await fillByPlaceholder(["Enter names here"], firstNames, "First names");
    await fillByPlaceholder(["Enter last name here"], licenseInfo.lastName, "Last name");

    // DOB — Auror's date field commits on Tab. Use MM/DD/YYYY format.
    const dobFormats = formatDobCandidates(licenseInfo.dob);
    if (dobFormats.length) {
      await fillByPlaceholder(["MM/DD/YYYY"], dobFormats[0], "DOB");
    }

    // Address — Auror's address field is a Google-Places-style autocomplete.
    // Type the full address, poll up to ~3.5s for a dropdown to appear
    // directly below the input, then click the first suggestion. If no
    // suggestion appears, the typed text remains in the input for the
    // operator to commit manually.
    const streetLine = [licenseInfo.street, licenseInfo.city, licenseInfo.state, licenseInfo.postal]
      .filter(Boolean).join(", ");
    if (streetLine) {
      const addrInput = findInputByPlaceholders(["Start typing to search", "address"]);
      if (addrInput) {
        await typeSlowly(addrInput, streetLine, { delayMs: 25 });
        const opt = await pickAddressSuggestion(addrInput, 5000);
        if (opt) {
          // Click the suggestion. Some autocompletes need mousedown +
          // click (e.g. they cancel on blur, so a plain click can fire
          // AFTER the blur dismisses the dropdown). Send both.
          const r = opt.getBoundingClientRect();
          const evtInit = { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5, button: 0 };
          opt.dispatchEvent(new MouseEvent("mousedown", evtInit));
          opt.dispatchEvent(new MouseEvent("mouseup", evtInit));
          opt.click();
          await sleep(400);
          const newValue = (addrInput.value || "").trim();
          const expectedSnippet = (opt.textContent || "").trim().slice(0, 10);
          if (newValue && (newValue.includes(expectedSnippet) || newValue.length > streetLine.length / 2)) {
            note(`Address → selected suggestion "${(opt.textContent || "").trim().slice(0, 60)}"`);
          } else {
            note(`! Address → clicked suggestion but input value didn't update (value="${newValue.slice(0, 60)}")`);
          }
        } else {
          note(`! Address → no autocomplete suggestion appeared within 5s (typed text remains in input)`);
        }
      } else {
        note(`! Address field not found`);
      }
    }

    // Identification — pick "Driver License" / "Drivers License" from the
    // ID type select, then fill the number into the "Enter ID here" input.
    if (licenseInfo.licenseNumber) {
      const idTypeSel = findFieldByNeedles(["id type", "identification", "select id type"]);
      if (idTypeSel && idTypeSel.tagName === "SELECT") {
        // Match permissively against likely option labels.
        const ok = selectOptionMatching(idTypeSel, [
          "drivers license", "driver's license", "driver license",
          "drivers licence", "driver licence", "dl", "driver",
        ]);
        note(ok ? `ID type → driver's license` : `! ID type select had no driver-license option`);
        await sleep(400);
      } else {
        note(`! ID type select not found (may not be a <select>)`);
      }
      await fillByPlaceholder(["Enter ID here"], licenseInfo.licenseNumber, "License #");
    }

    // Gender — Auror uses data-locator="PersonDetails-Gender-{Male|Female|Other}"
    // on a <label for=id> wrapping the chip. Click the label or its
    // associated input directly. Locator path is far more reliable than
    // text matching.
    if (licenseInfo.sex) {
      const sexUpper = String(licenseInfo.sex).trim().toUpperCase();
      const value = sexUpper === "M" ? "Male"
                  : sexUpper === "F" ? "Female"
                  : "Other";
      const ok = clickAurorChipByLocator("Gender", value);
      note(ok ? `Gender → ${value}` : `! Gender: locator PersonDetails-Gender-${value} not found`);
    }

    // Height — Auror data-locator="PersonDetails-Height-{Short|Average|Tall|VeryTall|Unknown}".
    if (licenseInfo.heightInches) {
      const value = heightInchesToAurorValue(licenseInfo.heightInches);
      const ok = clickAurorChipByLocator("Height", value);
      note(ok
        ? `Height → ${licenseInfo.heightInches}in → ${value}`
        : `! Height: locator PersonDetails-Height-${value} not found`);
    }

    // Build — Auror data-locator="PersonDetails-Build-{Slender|Average|Athletic|Heavy|VeryHeavy|Unknown}".
    if (licenseInfo.weightPounds) {
      const value = buildToAurorValue(licenseInfo.weightPounds, licenseInfo.heightInches);
      const ok = clickAurorChipByLocator("Build", value);
      note(ok
        ? `Build → ${licenseInfo.weightPounds}lb @ ${licenseInfo.heightInches || "?"}in → ${value}`
        : `! Build: locator PersonDetails-Build-${value} not found`);
    }

    note(`License-first Person 1 fill complete — operator reviews & finalizes`);
    return true;
  }

  // Poll up to `timeoutMs` for an autocomplete suggestion to appear
  // BELOW the address input (within ~400px vertically). Filters by
  // position to avoid grabbing leftover dropdowns from earlier fields.
  // Tries semantic role selectors first, then any visible new element
  // with text below the input. Uses rect-based visibility (offsetParent
  // returns null for position:fixed dropdowns, which Places often uses).
  async function pickAddressSuggestion(addrInput, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(120);
      const ir = addrInput.getBoundingClientRect();
      // Semantic options first.
      const semantic = document.querySelectorAll(
        "[role='option'], [role='listbox'] li, [role='listitem'], [role='menuitem']"
      );
      const semanticHits = collectBelow(semantic, ir);
      if (semanticHits.length) return semanticHits[0];
      // Google-Places-style dropdowns often render as plain <div> with
      // suggestion classes. Try any visible div/li whose text contains
      // a digit (street number) AND is positioned below the input.
      const generic = document.querySelectorAll("li, .pac-item, [class*='suggestion'], [class*='autocomplete'] li, [class*='autocomplete'] div");
      const genericHits = collectBelow(generic, ir).filter((el) => {
        const t = (el.textContent || "").trim();
        return t.length > 4 && t.length < 200 && /\d/.test(t);
      });
      if (genericHits.length) return genericHits[0];
    }
    return null;
  }

  // Return all rect-visible elements positioned within ~400px below the
  // reference rect. Sorted by vertical proximity. Uses bounding-rect
  // visibility (handles position:fixed elements that offsetParent misses).
  function collectBelow(nodelist, refRect) {
    const hits = [];
    for (const el of nodelist) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.top < refRect.bottom - 5) continue;
      if (r.top > refRect.bottom + 400) continue;
      hits.push({ el, dy: r.top - refRect.bottom });
    }
    hits.sort((a, b) => a.dy - b.dy);
    return hits.map((h) => h.el);
  }

  // Click a radio chip / button under a heading. Three strategies in order:
  //
  //   STRATEGY A (geometry): find ALL visible text-bearing leaf elements
  //     positioned in the rectangle directly below the heading. Match by
  //     visible text, then walk up to a clickable ancestor (button / role
  //     button|radio / cursor:pointer) and click it. Works regardless of
  //     DOM/aria semantics — important because Auror's form has broken
  //     label-for-id links and missing form-field labels (DevTools warns).
  //
  //   STRATEGY B (radio groups): find <input type='radio'> groups by name
  //     attribute, pick the group nearest below the heading. Useful when
  //     Auror's radios actually have working label associations.
  //
  //   STRATEGY C (walk-up): original ancestor-walk + chip collection,
  //     for button-only chip groups with no radio inputs at all.
  //
  // On no-match, logs the option strings found so the next iteration
  // can refine the candidate-label arrays.
  function clickBucketUnderHeading(headingNeedles, candidateLabels) {
    const heading = findHeadingByNeedles(headingNeedles);
    if (!heading) {
      note(`  [no heading found for "${headingNeedles.join('/')}"]`);
      return false;
    }
    const lowsCand = candidateLabels.map((s) => s.toLowerCase());

    // ── Strategy A: geometry-based chip find ──────────────────────────
    const geomHit = findChipByGeometry(heading, lowsCand);
    if (geomHit) {
      clickAnythingHard(geomHit);
      return true;
    }

    // ── Strategy B: radio groups by `name` ────────────────────────────
    const groups = collectRadioGroups();
    const hRect = heading.getBoundingClientRect();
    let bestGroup = null;
    let bestDist = Infinity;
    for (const group of groups) {
      if (group.options.length < 2) continue;  // need a real chip group
      const firstRect = group.options[0].labelEl.getBoundingClientRect();
      const dist = firstRect.top - hRect.bottom;
      if (dist < -20 || dist > 300) continue;
      if (dist < bestDist) { bestDist = dist; bestGroup = group; }
    }
    if (bestGroup) {
      for (const opt of bestGroup.options) {
        const tl = opt.text.toLowerCase();
        if (lowsCand.some((c) => tl === c || tl.includes(c) || c.includes(tl))) {
          clickChipWithReactSignal({ el: opt.labelEl });
          return true;
        }
      }
      const sample = bestGroup.options.map((o) => `"${o.text}"`).join(", ");
      note(`  [heading "${(heading.textContent || "").trim().slice(0, 40)}"] radio group has: [${sample}]`);
      return false;
    }

    // ── Strategy C: walk-up chip collection ───────────────────────────
    let container = heading.parentElement;
    for (let i = 0; i < 10 && container && container !== document.body; i++, container = container.parentElement) {
      const visibleOpts = collectChipOptions(container);
      if (visibleOpts.length === 0) continue;
      for (const opt of visibleOpts) {
        const tl = opt.text.toLowerCase();
        if (lowsCand.some((c) => tl === c || tl.includes(c) || c.includes(tl))) {
          clickChipWithReactSignal(opt);
          return true;
        }
      }
      const sample = visibleOpts.slice(0, 12).map((o) => `"${o.text}"`).join(", ");
      note(`  [heading "${(heading.textContent || "").trim().slice(0, 40)}"] walkup options: [${sample}]`);
      return false;
    }
    note(`  [heading "${(heading.textContent || "").trim().slice(0, 40)}"] found, no chips matched`);
    return false;
  }

  // Geometry strategy. Find the candidate-matching text in the rect
  // directly below the heading, ignoring all DOM/aria semantics.
  // Returns the matched LEAF element (caller walks up to clickable).
  function findChipByGeometry(heading, lowsCand) {
    const hRect = heading.getBoundingClientRect();
    const region = {
      left: Math.max(0, hRect.left - 80),
      right: hRect.right + 500,
      top: hRect.bottom + 1,
      bottom: hRect.bottom + 220,
    };
    // First pass: collect everything visible in the region with non-empty
    // SHORT text. Prefer "leaf" elements (no children, or children with
    // no text of their own) so we don't pick up wrappers.
    const all = document.querySelectorAll("*");
    const found = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width < 18 || r.height < 14) continue;
      if (r.top < region.top || r.top > region.bottom) continue;
      if (r.right < region.left || r.left > region.right) continue;
      const text = (el.textContent || "").trim();
      if (!text || text.length > 40) continue;
      // Only consider elements whose OWN text (excluding children) is
      // the text, OR elements with no element children. This avoids
      // matching giant wrapper divs whose textContent is the chip text.
      const elementChildren = el.children.length;
      if (elementChildren > 0) {
        // Has element children — only accept if at least one child has
        // the same text (then we'll dedupe to the deepest). Skip wrappers
        // whose text is composed of MANY child texts.
        const childTexts = Array.from(el.children).map((c) => (c.textContent || "").trim());
        const childHasSameText = childTexts.some((t) => t === text);
        if (!childHasSameText) continue;
      }
      found.push({ el, text, rect: r });
    }
    // Dedupe by text — keep the smallest element (likely the chip's text node).
    const byText = new Map();
    for (const f of found) {
      const tl = f.text.toLowerCase();
      const cur = byText.get(tl);
      if (!cur || f.rect.width * f.rect.height < cur.rect.width * cur.rect.height) {
        byText.set(tl, f);
      }
    }
    // Match candidates.
    for (const [tl, f] of byText) {
      if (lowsCand.some((c) => tl === c || tl.includes(c) || c.includes(tl))) {
        // DIAGNOSTIC: log the chip's DOM around it so we can see the
        // actual interactive structure. Walk up 4 ancestors and log
        // each one's tagName + class + role + outerHTML(first 200ch).
        try {
          let n = f.el;
          for (let i = 0; i < 5 && n && n !== document.body; i++, n = n.parentElement) {
            const cls = (n.className && typeof n.className === "string" ? n.className : "").slice(0, 80);
            const role = n.getAttribute?.("role") || "";
            const cursor = (() => { try { return window.getComputedStyle(n).cursor; } catch { return "?"; } })();
            const ohtml = (n.outerHTML || "").replace(/\s+/g, " ").slice(0, 240);
            note(`  CHIP_DOM[L${i}] <${n.tagName.toLowerCase()} class="${cls}" role="${role}" cursor=${cursor}>: ${ohtml}`);
          }
        } catch { /* ignore */ }
        return f.el;
      }
    }
    // Log what was visible — caller's fallback strategies might succeed,
    // but if they all fail this is the diagnostic line we want.
    const seen = [...byText.keys()].slice(0, 15).map((t) => `"${t}"`).join(", ");
    note(`  [heading "${(heading.textContent || "").trim().slice(0, 40)}"] geom-scan saw: [${seen}]`);
    return null;
  }

  // Click an element by:
  //   1. Find the underlying radio/checkbox input near the leaf — Auror's
  //      chips wrap a hidden <input type='radio'>; native `.click()` on
  //      that input is the cleanest way to trigger React's onChange.
  //   2. Find the topmost ELEMENT FROM POINT at the chip's center pixel,
  //      walk up to a likely interactive ancestor (button / label / role
  //      button|radio|option|menuitem / cursor:pointer / data-locator).
  //   3. Dispatch a full pointerdown→mousedown→pointerup→mouseup→click
  //      sequence WITH view:window on the interactive ancestor, then
  //      native `.click()` on both the input and the ancestor.
  // The view:window field is critical — React 17+ checks for it and
  // ignores synthetic events without it.
  function clickAnythingHard(leafEl) {
    const r = leafEl.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    // Find the underlying radio/checkbox input near the leaf.
    let radio = null;
    let scope = leafEl;
    for (let i = 0; i < 6 && scope && scope !== document.body; i++, scope = scope.parentElement) {
      const r1 = scope.querySelector?.("input[type='radio'], input[type='checkbox']");
      if (r1) { radio = r1; break; }
    }

    // Find the topmost clickable target at the chip's center pixel.
    let hit = null;
    try { hit = document.elementFromPoint(cx, cy); } catch { /* ignore */ }
    if (!hit || hit === document.body || hit === document.documentElement) hit = leafEl;

    // Walk up from elementFromPoint to a likely interactive ancestor.
    let target = hit;
    for (let i = 0; i < 8 && target && target !== document.body; i++) {
      if (target.tagName === "BUTTON" || target.tagName === "LABEL") break;
      const role = (target.getAttribute && target.getAttribute("role")) || "";
      if (role === "button" || role === "radio" || role === "option" || role === "menuitem") break;
      if (target.getAttribute && target.getAttribute("data-locator")) break;
      try {
        const cs = window.getComputedStyle(target);
        if (cs && cs.cursor === "pointer") break;
      } catch { /* ignore */ }
      target = target.parentElement;
    }
    if (!target || target === document.body) target = hit;

    // Fire a synthetic click on the ancestor with full event sequence.
    fireFullClickSequence(target, cx, cy);

    // ALSO try native click on the radio input + commit checked state.
    // Native input.click() is the most reliable way to toggle radios.
    if (radio) {
      try { radio.click(); } catch { /* ignore */ }
      try {
        const proto = Object.getPrototypeOf(radio);
        const desc = Object.getOwnPropertyDescriptor(proto, "checked");
        if (desc?.set) desc.set.call(radio, true); else radio.checked = true;
      } catch { radio.checked = true; }
      radio.dispatchEvent(new Event("input",  { bubbles: true }));
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // Dispatch the full pointer + mouse + click sequence with view:window,
  // which React 17+ requires to accept synthetic events.
  function fireFullClickSequence(target, cx, cy) {
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: cx,
      clientY: cy,
    };
    const pointerInit = {
      ...base,
      pointerType: "mouse",
      pointerId: 1,
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: 0.5,
    };
    try { target.dispatchEvent(new PointerEvent("pointerover",  pointerInit)); } catch {}
    try { target.dispatchEvent(new PointerEvent("pointerenter", pointerInit)); } catch {}
    try { target.dispatchEvent(new PointerEvent("pointerdown",  pointerInit)); } catch {}
    try { target.dispatchEvent(new MouseEvent  ("mousedown",    base));        } catch {}
    try { target.dispatchEvent(new PointerEvent("pointerup",    { ...pointerInit, buttons: 0, pressure: 0 })); } catch {}
    try { target.dispatchEvent(new MouseEvent  ("mouseup",      { ...base, buttons: 0 }));                     } catch {}
    try { target.click();                                                                                       } catch {}
    try { target.dispatchEvent(new MouseEvent  ("click",        { ...base, buttons: 0 }));                     } catch {}
  }

  // Find a heading element. Prefer the SMALLEST element whose text
  // matches a needle — the actual label (e.g. <span>Gender</span>)
  // rather than a section wrapper whose concatenated text happens to
  // include the word ("GenderMaleFemaleUnknown..."). Tie-break by
  // longest needle match (more specific). This matters because Auror's
  // chip sections have NO semantic boundaries — every chip in the
  // section contributes to the wrapper's textContent, so naive matchers
  // would pick the wrapper and then look for chips OUTSIDE it.
  function findHeadingByNeedles(headingNeedles) {
    const lowsHead = headingNeedles.map((s) => s.toLowerCase());
    let heading = null;
    let bestText = null;
    let bestMatchLen = 0;
    for (const el of document.querySelectorAll(
      "label, h1, h2, h3, h4, h5, p, span, div, legend, strong, b"
    )) {
      if (el.offsetParent === null) continue;
      const t = (el.textContent || "").trim().toLowerCase();
      if (!t || t.length > 120) continue;
      const matched = lowsHead.find((n) => t.includes(n));
      if (!matched) continue;
      // Prefer shorter text (smaller, more specific element). Tie-break
      // on longer needle match.
      const isSmaller = bestText === null || t.length < bestText.length;
      const isMoreSpecific = !isSmaller && t.length === bestText.length && matched.length > bestMatchLen;
      if (isSmaller || isMoreSpecific) {
        heading = el;
        bestText = t;
        bestMatchLen = matched.length;
      }
    }
    return heading;
  }

  // Group all <input type='radio'> on the page by their `name` attribute.
  // Each group entry has { name, options: [{radio, labelEl, text}] }
  // where labelEl is the click target (associated label or aria-label
  // fallback). Skips radios with no associated label.
  function collectRadioGroups() {
    const byName = new Map();
    for (const r of document.querySelectorAll("input[type='radio']")) {
      const labelEl = getRadioLabel(r);
      if (!labelEl) continue;
      const text = (labelEl.textContent || r.getAttribute("aria-label") || "").trim();
      if (!text || text.length > 60) continue;
      const lr = labelEl.getBoundingClientRect();
      if (lr.width < 2 || lr.height < 2) continue;   // not visible
      const name = r.name || `__noname_${r.id || ""}`;
      if (!byName.has(name)) byName.set(name, { name, options: [] });
      byName.get(name).options.push({ radio: r, labelEl, text });
    }
    return Array.from(byName.values());
  }

  // Resolve the label element associated with a radio input. Checks
  // (in order): wrapping <label>, sibling <label for=id>, the radio
  // itself when it has an aria-label.
  function getRadioLabel(radio) {
    const wrapping = radio.closest("label");
    if (wrapping) return wrapping;
    if (radio.id) {
      const ext = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (ext) return ext;
    }
    if (radio.getAttribute("aria-label")) return radio;
    return null;
  }

  // Click a chip option. If the visible target is a label associated with
  // a radio input, also fire click+change on the radio so React handlers
  // attached to either element see the event.
  function clickChipWithReactSignal(opt) {
    const target = opt.el;
    // First, the natural click on the visible label/button — works for
    // most non-React forms and for labels bound to radios via for=id.
    target.click();
    // Find an associated radio input if any.
    let radio = null;
    if (target.tagName === "INPUT" && target.type === "radio") {
      radio = target;
    } else if (target.tagName === "LABEL") {
      const forId = target.getAttribute("for");
      if (forId) radio = document.getElementById(forId);
      if (!radio) radio = target.querySelector("input[type='radio']");
    } else {
      // Walk a couple ancestors for a radio sibling (chip wrapper case).
      let n = target.parentElement;
      for (let i = 0; i < 3 && n && !radio; i++, n = n.parentElement) {
        radio = n.querySelector("input[type='radio']");
        if (radio) break;
      }
    }
    if (radio) {
      // Use React-aware "checked" setter so React's controlled input picks
      // up the change (mirrors setReactValue but for the 'checked' prop).
      try {
        const proto = Object.getPrototypeOf(radio);
        const desc = Object.getOwnPropertyDescriptor(proto, "checked");
        if (desc?.set) desc.set.call(radio, true);
        else radio.checked = true;
      } catch { radio.checked = true; }
      radio.dispatchEvent(new Event("input",  { bubbles: true }));
      radio.dispatchEvent(new Event("change", { bubbles: true }));
      radio.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
  }

  // Collect all visible "chip" options inside `container`. Returns an
  // array of { el, text } where `el` is the click target (label if the
  // chip is a labeled radio, otherwise the chip itself).
  function collectChipOptions(container) {
    const out = [];
    const seenEls = new Set();
    const push = (el, text) => {
      if (!el || seenEls.has(el)) return;
      if (!text || text.length > 40) return;
      seenEls.add(el);
      out.push({ el, text });
    };
    // 1. Direct clickables.
    for (const c of container.querySelectorAll(
      "button, label, [role='button'], [role='radio'], [role='option']"
    )) {
      if (c.offsetParent === null) continue;
      const t = (c.textContent || "").trim();
      if (!t) continue;
      push(c, t);
    }
    // 2. <input type='radio'> with associated labels — click the label
    //    (more reliable than clicking the radio input, especially when
    //    the radio is visually hidden and the label is the styled chip).
    for (const r of container.querySelectorAll("input[type='radio']")) {
      let labelEl = null;
      let labelText = "";
      // Wrapping <label><input>...</label>
      const wrapping = r.closest("label");
      if (wrapping && wrapping.offsetParent !== null) {
        labelEl = wrapping;
        labelText = (wrapping.textContent || "").trim();
      }
      // Sibling <label for="id">
      if (!labelEl && r.id) {
        const ext = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
        if (ext && ext.offsetParent !== null) {
          labelEl = ext;
          labelText = (ext.textContent || "").trim();
        }
      }
      // Aria-label as final fallback (click the radio input itself).
      if (!labelEl) {
        const aria = (r.getAttribute("aria-label") || "").trim();
        if (aria && r.offsetParent !== null) {
          labelEl = r;
          labelText = aria;
        }
      }
      if (labelEl && labelText) push(labelEl, labelText);
    }
    return out;
  }

  // Click an Auror PersonDetails chip by its data-locator. Auror's chip
  // pattern (verified live, 2026-06-06):
  //   <label data-locator="PersonDetails-{Field}-{Value}"
  //          for="radio_group_item_NN"
  //          class="bootstrap-theme__btn TileInput__btn-selectable ...">
  //     <svg/> <div>{label text}</div>
  //   </label>
  //   <input type="checkbox" id="radio_group_item_NN" ...> (sibling in grid)
  //
  // Strategy: find the label by locator, follow for=id to the input,
  // click the input natively (auto-toggles checkbox state + fires
  // React onChange via React 17+ delegation), then commit checked
  // state + fire input/change for belt-and-suspenders.
  function clickAurorChipByLocator(field, value) {
    const locator = `PersonDetails-${field}-${value}`;
    const label = document.querySelector(`[data-locator="${locator}"]`);
    if (!label) return false;
    // Follow label.for → input.
    const forId = label.getAttribute("for");
    const input = forId ? document.getElementById(forId) : null;
    if (input) {
      try { input.click(); } catch { /* ignore */ }
      // Commit checked state via React-aware setter.
      try {
        const proto = Object.getPrototypeOf(input);
        const desc = Object.getOwnPropertyDescriptor(proto, "checked");
        if (desc?.set) desc.set.call(input, true); else input.checked = true;
      } catch { input.checked = true; }
      input.dispatchEvent(new Event("input",  { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // No associated input — fall back to clicking the label itself
      // with a full event sequence (rare; data-locator label without
      // for=id pairing).
      const r = label.getBoundingClientRect();
      fireFullClickSequence(label, r.left + r.width/2, r.top + r.height/2);
    }
    return true;
  }

  // Map license height (inches) → Auror chip value name.
  function heightInchesToAurorValue(inches) {
    if (inches < 63)  return "Short";       // < 5'3"  (under 1.60m)
    if (inches < 69)  return "Average";     // 5'3"–5'8" (1.60m–1.75m)
    if (inches < 74)  return "Tall";        // 5'9"–6'1" (1.76m–1.90m)
    return            "VeryTall";           // 6'2"+   (over 1.91m)
  }

  // Map license weight (and optional height for BMI) → Auror build chip value.
  function buildToAurorValue(lbs, inches) {
    if (inches) {
      const bmi = (lbs * 703) / (inches * inches);
      if (bmi < 18.5)  return "Slender";
      if (bmi < 25)    return "Average";
      if (bmi < 28)    return "Athletic";
      if (bmi < 32)    return "Heavy";
      return            "VeryHeavy";
    }
    if (lbs < 130)  return "Slender";
    if (lbs < 180)  return "Average";
    if (lbs < 220)  return "Athletic";
    if (lbs < 270)  return "Heavy";
    return          "VeryHeavy";
  }

  // Wait until any of the given CSS selectors matches a visible element.
  async function waitForAnyVisible(selectors, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return el;
      }
      await sleep(150);
    }
    return null;
  }

  // Exact-or-contains placeholder match (case-insensitive). Returns the
  // first visible <input> / <textarea> with a placeholder matching ANY
  // of the candidate strings.
  function findInputByPlaceholders(candidates) {
    const lows = candidates.map((c) => c.toLowerCase());
    const inputs = document.querySelectorAll("input, textarea");
    for (const el of inputs) {
      if (el.offsetParent === null) continue;
      const ph = (el.placeholder || "").toLowerCase();
      if (!ph) continue;
      if (lows.some((c) => ph === c || ph.includes(c))) return el;
    }
    return null;
  }

  // Fill input matched by placeholder. Date-shaped inputs commit on Tab;
  // everything else uses setReactValue for fast React-aware writes.
  async function fillByPlaceholder(placeholders, value, label) {
    if (!value) return;
    const el = findInputByPlaceholders(placeholders);
    if (!el) { note(`! ${label}: no input with placeholder ${placeholders.join("/")}`); return; }
    try {
      el.focus();
      const isDateish = /MM\/DD|YYYY|date|birth/i.test(el.placeholder || "");
      if (isDateish) {
        await typeSlowly(el, value, { delayMs: 20 });
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
        el.blur();
      } else {
        setReactValue(el, value);
      }
      note(`${label} → filled`);
    } catch (e) {
      note(`! ${label} fill threw: ${e.message || e}`);
    }
  }

  // Pick the first visible option in any [role="option"] / listbox /
  // combobox dropdown currently rendered on the page.
  function pickFirstVisibleOption() {
    const opts = document.querySelectorAll(
      "[role='option'], [role='listbox'] li, [role='menu'] li, [role='listitem']"
    );
    for (const o of opts) {
      if (o.offsetParent !== null) return o;
    }
    return null;
  }

  // Find a visible input/select where any of `needles` appears in
  // placeholder, aria-label, name, id, or the nearest <label>.
  function findFieldByNeedles(needles) {
    const inputs = document.querySelectorAll("input:not([type='hidden']), select, textarea");
    const lows = needles.map(n => n.toLowerCase());
    for (const el of inputs) {
      if (el.offsetParent === null) continue;
      if (el.type === "checkbox" || el.type === "radio" || el.type === "button" || el.type === "submit") continue;
      const haystack = (
        (el.placeholder || "") + " " +
        (el.getAttribute("aria-label") || "") + " " +
        (el.name || "") + " " +
        (el.id || "") + " " +
        labelTextForInput(el)
      ).toLowerCase();
      if (lows.some(n => haystack.includes(n))) return el;
    }
    return null;
  }

  function labelTextForInput(el) {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return lab.textContent || "";
    }
    const wrapping = el.closest("label");
    if (wrapping) return wrapping.textContent || "";
    return "";
  }

  function selectOptionMatching(select, values) {
    const lows = values.map(v => String(v).toLowerCase());
    for (const opt of select.options) {
      const t = (opt.text || opt.value || "").toLowerCase();
      if (lows.some(v => v && (t === v || t.startsWith(v) || v.startsWith(t)))) {
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  // ISO YYYY-MM-DD → [ISO, MM/DD/YYYY, DD/MM/YYYY]. Returns whatever the
  // input looks like if it doesn't match ISO.
  function formatDobCandidates(iso) {
    if (!iso) return [];
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return [String(iso)];
    const [, y, mo, d] = m;
    return [`${mo}/${d}/${y}`, iso, `${d}/${mo}/${y}`, `${mo}-${d}-${y}`];
  }

  return (async () => {
    try {
      // Spoof visibilityState so Chrome doesn't throttle setTimeout/sleep
      // calls in the background tab. Without this, our short sleep() waits
      // (150–500ms) get clamped to ~1s each by the browser's background
      // timer throttling policy, making the whole fill take 2–3x longer.
      Object.defineProperty(document, "visibilityState", {
        get: () => "visible", configurable: true
      });
      Object.defineProperty(document, "hidden", {
        get: () => false, configurable: true
      });
      document.addEventListener("visibilitychange",
        e => e.stopImmediatePropagation(), true);

      // ──────────────────────────────────────────────────────────────
      // LICENSE-INTAKE BRANCH
      // ──────────────────────────────────────────────────────────────
      // When license_person_info is set, this event represents a
      // license capture, not a real transaction. The operator wants:
      //   - event type = Shoplifting (Auror REQUIRES an event type
      //     before the Person 1 panel is revealed; Shoplifting is the
      //     common service-desk license-scan context)
      //   - location set to their store
      //   - date = today (already set in fromTransaction)
      //   - time = scan time − 10 min (already set in fromTransaction)
      //   - People = 1 → fill Person 1 fields DIRECTLY (no lookup-search)
      //   - NO description / additional info
      //   - NO Next clicks / police / witness / done
      // Operator finishes from there.
      if (data.license_person_info) {
        // Step L0 — Event type (required gate; Person 1 panel is hidden
        // until an event type is selected). Try a few label variants in
        // case Auror tweaks the button text.
        note(`[license] Event type → Shoplifting`);
        let eventTypeBtn = null;
        for (const label of ["Shoplifting", "Shop Lifting", "Shop-lifting", "Theft"]) {
          try {
            eventTypeBtn = await findByText("button", label, 3000);
            if (eventTypeBtn) { eventTypeBtn.click(); note(`[license]   clicked "${label}"`); break; }
          } catch { /* try next */ }
        }
        if (!eventTypeBtn) note(`! [license] No Shoplifting/Theft button found`);
        await sleep(SETTLE_SHORT_MS);

        // Step L1 — Location (still required so the form has a store).
        // Auror's store-picker option markup varies — try [role='option']
        // first, then li/div containing the store number. We match on the
        // store NUMBER (more distinctive than "Walmart") and don't require
        // an exact "Walmart NNNN" prefix since some entries include the
        // full address ("Walmart 1458 - 123 Main St, ...") that contains
        // the number but not necessarily as a leading word.
        if (data.store) {
          note(`[license] Location → 'Walmart ${data.store}'`);
          try {
            await safeFill("input[placeholder='Search locations']", `Walmart ${data.store}`);
            await sleep(SETTLE_SHORT_MS);
            const opt = await waitForLocationOption(data.store, LOCATION_OPTION_TIMEOUT);
            if (opt) {
              opt.click();
              note(`[license]   selected location: "${(opt.textContent || "").trim().slice(0, 60)}"`);
            } else {
              note(`! [license] No location option matching store ${data.store} appeared`);
            }
            await sleep(SETTLE_AFTER_LOCATION_MS);
          } catch (e) { note(`! [license] Location: ${e.message}`); }
        }

        // Step L2 — Date (today)
        if (data.date) {
          note(`[license] Date → ${data.date}`);
          try {
            await safeFill("input[placeholder='MM/DD/YYYY']", data.date);
            const dateEl = document.querySelector("input[placeholder='MM/DD/YYYY']");
            if (dateEl) {
              dateEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
              dateEl.blur();
            }
            await sleep(300);
          } catch (e) { note(`! [license] Date: ${e.message}`); }
        }

        // Step L3 — Time (scan − 10 min)
        if (data.time) {
          note(`[license] Time → ${data.time}`);
          try {
            const timeSelectors = [
              "input[placeholder*='1:15 PM']",
              "input[placeholder*='AM']", "input[placeholder*='PM']",
              "input[placeholder*='HH']", "input[placeholder*='hh']",
            ];
            let timeEl = null;
            for (const sel of timeSelectors) {
              timeEl = document.querySelector(sel);
              if (timeEl && timeEl.offsetParent !== null) break;
              timeEl = null;
            }
            if (timeEl) {
              timeEl.focus();
              setReactValue(timeEl, data.time);
              await sleep(200);
              timeEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
              timeEl.dispatchEvent(new KeyboardEvent("keyup",   { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
              timeEl.blur();
              await sleep(300);
            } else {
              note(`! [license] Time field not found`);
            }
          } catch (e) { note(`! [license] Time: ${e.message}`); }
        }

        // Step L4 — People = 1. Try the known data-locator first; if it
        // isn't present in the Shoplifting flow, fall back to clicking a
        // visible "1" radio/label inside the People row. Then verify the
        // Person 1 panel actually appeared.
        note(`[license] People = 1`);
        let peopleClicked = false;
        try { await clickCountLabel("People", 1); peopleClicked = true; }
        catch (e) { note(`! [license] People data-locator missed: ${e.message}`); }
        if (!peopleClicked) {
          try { await clickPeopleOneFallback(); peopleClicked = true; }
          catch (e) { note(`! [license] People fallback also failed: ${e.message}`); }
        }
        await sleep(1500);

        // Step L4b — Expand Person 1 section if Auror collapses it by
        // default. The Shoplifting flow renders Person 1 as a clickable
        // header that must be opened before the form fields are visible.
        try { await expandPerson1IfCollapsed(); }
        catch (e) { note(`! [license] Person 1 expand: ${e.message}`); }
        await sleep(800);

        // Step L5 — Fill Person 1 form fields directly from license data.
        try { await fillPerson1FromLicense(data.license_person_info); }
        catch (e) { note(`! [license] Person 1 fill: ${e.message}`); }

        note("[license] STOP — operator reviews remaining fields and submits.");
        return { url: location.href, log, stoppedForOperator: true };
      }

      // ──────────────────────────────────────────────────────────────
      // REGULAR TRANSACTION FLOW (event_type click → ... → done)
      // ──────────────────────────────────────────────────────────────

      // Step 2 — Event type: POS/SCO fraud
      note("Event type → POS/SCO");
      (await findByText("button", "POS/SCO")).click();
      await sleep(SETTLE_SHORT_MS);

      // Step 3 — Location
      note(`Location → 'Walmart ${data.store}'`);
      await safeFill("input[placeholder='Search locations']", `Walmart ${data.store}`);
      await sleep(SETTLE_SHORT_MS);
      (await findByText("[role='option']", `Walmart ${data.store}`, LOCATION_OPTION_TIMEOUT)).click();

      // Step 4 — Whereabouts (only renders after location)
      // Skip if register is empty (otherwise we'd fill 'POS ' which looks
      // broken). Empty register can happen for manually-typed txns that
      // never went through Secure.
      if (!data.register) {
        note(`! Whereabouts: register missing, skipping`);
      } else {
        note(`Whereabouts → 'POS ${data.register}'`);
        await sleep(SETTLE_AFTER_LOCATION_MS);
        const wb = await waitFor("input[placeholder*='Zone 16']");
        wb.focus();
        setReactValue(wb, `POS ${data.register}`);
        // Auror's Whereabouts field is an autocomplete combobox. Setting
        // .value + dispatching input/change isn't enough — the value
        // isn't 'committed' to the underlying form state until the user
        // either picks a dropdown option or presses Tab/Enter. Without
        // that step, the next field's focus() silently clears it (the
        // combobox treats the typed text as 'cancelled'). Enter-keydown
        // is the universal 'commit this free-text' gesture; then blur
        // so the subsequent field can focus cleanly.
        wb.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        wb.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        wb.blur();
        await sleep(150);
      }

      // Step 5 — Date & Time
      // Date: fill + Tab to commit before touching the time field.
      if (data.date) {
        note(`Date → ${data.date}`);
        await safeFill("input[placeholder='MM/DD/YYYY']", data.date);
        const dateEl = document.querySelector("input[placeholder='MM/DD/YYYY']");
        if (dateEl) {
          dateEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
          dateEl.blur();
        }
        await sleep(300);
      }
      if (data.time) {
        note(`Time → ${data.time}`);
        // Try the known placeholder first; fall back to any visible time-
        // shaped input (contains 'AM' or 'PM' hint) in case Auror tweaks
        // the placeholder text.
        const timeSelectors = [
          "input[placeholder*='1:15 PM']",
          "input[placeholder*='AM']",
          "input[placeholder*='PM']",
          "input[placeholder*='HH']",
          "input[placeholder*='hh']",
        ];
        let timeEl = null;
        for (const sel of timeSelectors) {
          timeEl = document.querySelector(sel);
          if (timeEl && timeEl.offsetParent !== null) break;
          timeEl = null;
        }
        if (timeEl) {
          timeEl.focus();
          setReactValue(timeEl, data.time);
          await sleep(200);
          // Commit the value: Tab closes any open combobox/picker and
          // moves focus to the next field so it doesn't block clicks.
          timeEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
          timeEl.dispatchEvent(new KeyboardEvent("keyup",   { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
          timeEl.blur();
          await sleep(400);
        } else {
          note(`! Time field not found (tried ${timeSelectors.length} selectors) — skipping`);
        }
      }

      // Step 6 — People count (this also reveals the Person 1 section
      // below, which we populate next)
      note(`People = ${data.people_count}`);
      try { await clickCountLabel("People", data.people_count); }
      catch (e) { note(`! People count: ${e.message}`); }
      // Give React time to mount the Person 1 section before the lookup.
      await sleep(1_800);

      // Step 6b — Person 1 lookup by Auror person_id. Safe no-op if
      // the scan didn't provide a person_id for this suspect.
      try { await lookupPerson1(data.person_id, data.resolvedPersonName); }
      catch (e) { note(`! Person lookup: ${e.message}`); }

      // (License-first path is handled at the very top of this try block —
      // when license_person_info is set, we never reach this point.)

      // Step 6c — Vehicles count (still on the Event Details card)
      note(`Vehicles = ${data.vehicles_count}`);
      try { await clickCountLabel("Vehicles", data.vehicles_count); }
      catch (e) { note(`! Vehicles count: ${e.message}`); }

      // Step 7 — Products involved
      if (data.products) {
        note("Products involved → check");
        try { (await findByText("label", "Products involved", 5_000)).click(); }
        catch (e) { note(`! Products checkbox: ${e.message}`); }
      }

      // Step 8 — Next → Additional information
      note("Next → Additional information");
      (await findByText("button", "Next")).click();
      await sleep(SETTLE_FORM_NAV_MS);

      // Step 9 — Description
      note("Description → fill");
      try {
        const expand = await findByText("button", "Additional information", 2_000).catch(() => null);
        if (expand) { expand.click(); await sleep(SETTLE_SHORT_MS); }
      } catch {}
      try {
        await safeFill("textarea[placeholder*='Describe what happened']", data.description);
      } catch (e) {
        note(`! Description fill: ${e.message}`);
      }

      // Step 10 — Next → Reporting details
      note("Next → Reporting details");
      (await findByText("button", "Next")).click();
      await sleep(SETTLE_FORM_NAV_MS);

      // Step 11 — Police, Reporter, Witnessed, Done
      if (!data.police_called) {
        note("Police → No");
        try { (await findByText("label", "No", 5_000)).click(); }
        catch (e) { note(`! Police No: ${e.message}`); }
      }

      if (data.use_my_details) {
        note("Reporter → Use my details");
        try { (await findByText("button", "Use my details", 5_000)).click(); }
        catch (e) { note(`! Use my details: ${e.message}`); }
      }

      note(`Witnessed → '${data.witnessed_label}'`);
      try { (await findByText("label", data.witnessed_label, 5_000)).click(); }
      catch (e) { note(`! Witnessed: ${e.message}`); }

      // After the witness tile is selected Auror reveals a sub-section
      // ('Observed video footage') with a 'Use my details' CHECKBOX that
      // copies the witness name/email/phone from the reporter row above.
      // Different from the reporter's 'Use my details' BUTTON clicked
      // earlier — this one is a checkbox inside the witness sub-section.
      if (data.use_my_details) {
        try { await clickWitnessUseMyDetails(); note("Witness → Use my details"); }
        catch (e) { note(`! Witness Use my details: ${e.message}`); }
      }

      note("Done");
      try {
        (await findByText("button", "Done", 5_000)).click();
        await sleep(SETTLE_FORM_NAV_MS);
      } catch (e) {
        note(`! Done click: ${e.message}`);
      }

      return { url: location.href, log };
    } catch (err) {
      return { error: String(err?.message ?? err), url: location.href, log };
    }
  })();
}
