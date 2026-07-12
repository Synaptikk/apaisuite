// modules/aurorbuddy/content/secure_pill.js
//
// Injects a small icon-only "Secure" pill onto Auror's UI in two places:
//   1. Anywhere on the site that has a `button[data-locator="Tray-Linker"]`
//      ("Add to tray") for a person — search results, event details, etc.
//      We anchor on the Tray-Linker itself (not a card-wrapper locator) and
//      walk up to find the enclosing element with a `/person/<id>` link.
//      Tray + pill are wrapped in an inline-flex span so they sit side-by-
//      side, pill to the right of the tray button.
//   2. Person-Card page header — when the route is `/person/<id>`, the
//      `<h1 data-locator="ProfileHeader-Title">` already exposes an empty
//      `<div class="fx-self-center fx-flex fx-flex-wrap fx-gap-2">` slot
//      specifically for inline badges; we drop the pill in there.
//
// Clicking the pill posts an `aurorbuddy.open_secure_lookup` message to
// the SW with `{ name, personId }`. The SW opens a chrome.windows popup
// pointed at our `secure_lookup.html` which calls the existing
// appriss_lookup handler with a synthesised one-item suspects[] and
// renders the cards/transactions.

(() => {
  if (window.__AB_SECURE_PILL_INSTALLED__) return;
  window.__AB_SECURE_PILL_INSTALLED__ = true;

  const PILL_MARKER_ATTR     = "data-ab-secure-pill";
  const TRAY_PAIRED_ATTR     = "data-ab-secure-pill-paired";
  const WRAP_MARKER_ATTR     = "data-ab-secure-pill-wrap";
  const TRAY_BTN_SELECTOR    = 'button[data-locator="Tray-Linker"]';
  const PROFILE_TITLE_SELECT = '[data-locator="ProfileHeader-Title"]';
  const PROFILE_BADGES_SLOT  = 'div.fx-self-center.fx-flex.fx-flex-wrap.fx-gap-2';
  const ICON_URL = chrome.runtime.getURL("modules/aurorbuddy/assets/secure.ico");

  // ── Pill construction ──────────────────────────────────────────────
  // Small circular icon-only button. Self-styled (no Auror class
  // inheritance) so it stays visually consistent across the SPA wherever
  // a Tray-Linker shows up.
  function buildIconOnlyPill({ title }) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute(PILL_MARKER_ATTR, "1");
    btn.setAttribute("title", title);
    btn.setAttribute("aria-label", title);
    btn.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "width:28px",
      "height:28px",
      "padding:0",
      "border-radius:9999px",
      "border:1px solid #e0c200",
      "background:#ffd60a",
      "cursor:pointer",
      "box-shadow:0 1px 0 rgba(0,0,0,.04)",
      "flex:0 0 auto",
    ].join(";");
    btn.innerHTML =
      `<img src="${ICON_URL}" alt="" aria-hidden="true" ` +
      `style="width:16px;height:16px;display:block;">`;
    btn.addEventListener("mouseenter", () => { btn.style.background = "#ffe34a"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "#ffd60a"; });
    return btn;
  }

  // ── Data extraction ────────────────────────────────────────────────
  function extractCardInfo(card) {
    const link = card.querySelector('a[href^="/person/"]');
    const href = link?.getAttribute("href") || "";
    const personId = href.match(/\/person\/(\d+)/)?.[1] || "";
    let name = "";
    if (link) {
      // The first heading inside the link wraps `Name <span> pXXXXX</span>`.
      // Auror's image alt is just `pXXXXX` (not the name), so heading is the
      // only reliable source. Clone, strip the ID span/small, take what's left.
      const heading = link.querySelector("h1, h2, h3, h4, h5, h6");
      if (heading) {
        const clone = heading.cloneNode(true);
        clone.querySelectorAll('span, small, [data-locator*="ResourceId"]').forEach(el => el.remove());
        let raw = (clone.textContent || "").replace(/\s+/g, " ").trim();
        if (personId) raw = raw.replace(new RegExp(`\\bp${personId}\\b`, "i"), "").trim();
        if (raw && !/^unknown\b/i.test(raw)) name = raw;
      }
    }
    return { name, personId };
  }

  function extractProfileInfo() {
    const title = document.querySelector(PROFILE_TITLE_SELECT);
    if (!title) return null;
    const resource = title.querySelector('[data-locator="ProfileHeader-ResourceId"]');
    const personId = (resource?.textContent || "").replace(/^p/i, "").trim() || null;
    // Title node combines name + "<small>p<id></small>" — strip the ID
    // and "Unknown person" wording to isolate the real name (if any).
    const raw = (title.textContent || "").trim();
    const resourceTxt = (resource?.textContent || "").trim();
    let name = raw.replace(resourceTxt, "").trim();
    if (/^unknown\s+person\b/i.test(name) || !name) name = "";
    return { name, personId };
  }

  // ── Click handler ──────────────────────────────────────────────────
  function attachClick(pill, getInfo) {
    pill.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const info = getInfo() || {};
      try {
        chrome.runtime.sendMessage({
          module:   "aurorbuddy",
          type:     "open_secure_lookup",
          name:     info.name || "",
          personId: info.personId || "",
        });
      } catch (e) {
        console.warn("[secure-pill] sendMessage failed:", e?.message);
      }
    }, { capture: true });
  }

  // ── Injection: anywhere with a Tray-Linker for a person ───────────
  // Walks up from the tray button until it finds an ancestor element
  // that exposes a `/person/<id>` link — that ancestor is the "card"
  // we extract name + personId from. If we never find one (e.g., tray
  // is for a vehicle/site), we skip injection.
  function findPersonCardFor(tray) {
    let el = tray.parentElement;
    while (el && el !== document.body) {
      if (el.querySelector('a[href^="/person/"]')) return el;
      el = el.parentElement;
    }
    return null;
  }

  function injectNextToTray(tray) {
    if (!tray || tray.hasAttribute(TRAY_PAIRED_ATTR)) return;
    const card = findPersonCardFor(tray);
    if (!card) return;
    // Skip Unknown persons — no name to search Appriss with.
    // Deliberately NOT marking with TRAY_PAIRED_ATTR so that if Auror
    // updates the card with a name (via React re-render), the next scan
    // will re-evaluate and inject.
    const info = extractCardInfo(card);
    if (!info.name) return;

    const pill = buildIconOnlyPill({
      title: `Search "${info.name}" on Secure / Appriss`,
    });

    // Wrap tray + pill in an inline-flex span so they sit side-by-side
    // regardless of the parent's flex-direction (search-result tiles
    // stack the tray button vertically below the name; this forces
    // horizontal layout for the pair only).
    const wrap = document.createElement("span");
    wrap.setAttribute(WRAP_MARKER_ATTR, "1");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;";
    tray.parentNode.insertBefore(wrap, tray);
    wrap.appendChild(tray);
    wrap.appendChild(pill);

    attachClick(pill, () => extractCardInfo(card));
    tray.setAttribute(TRAY_PAIRED_ATTR, "1");
  }

  // ── Injection: Person Card page header ─────────────────────────────
  function injectForProfile() {
    const title = document.querySelector(PROFILE_TITLE_SELECT);
    if (!title) return;
    const slot = title.querySelector(PROFILE_BADGES_SLOT);
    if (!slot) return;
    if (slot.querySelector(`[${PILL_MARKER_ATTR}]`)) return;   // already present
    const info = extractProfileInfo();
    if (!info?.name) return;   // skip Unknown persons
    const pill = buildIconOnlyPill({
      title: `Search "${info.name}" on Secure / Appriss`,
    });
    slot.appendChild(pill);
    attachClick(pill, extractProfileInfo);
  }

  // ── Scan + observe ─────────────────────────────────────────────────
  function scan() {
    document.querySelectorAll(TRAY_BTN_SELECTOR).forEach(injectNextToTray);
    injectForProfile();
  }

  const obs = new MutationObserver(() => {
    // Debounce via microtask coalescing — scan is cheap (querySelectorAll
    // + a `.hasAttribute` short-circuit per card) and Auror's grid renders
    // in batches.
    scheduleScan();
  });
  let scanPending = false;
  function scheduleScan() {
    if (scanPending) return;
    scanPending = true;
    queueMicrotask(() => { scanPending = false; scan(); });
  }
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // Initial pass after document is ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan, { once: true });
  } else {
    scan();
  }

  console.info("[aurorbuddy/secure-pill] installed");
})();
