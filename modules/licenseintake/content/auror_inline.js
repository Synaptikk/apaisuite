// modules/licenseintake/content/auror_inline.js
//
// Injects a "Scan License" tab into Auror's main header navigation
// (alongside Feed / Search / Insights / Investigate / Detections).
//
// Clicking the tab opens the suite's app.html#licenseintake in a new
// tab — the operator sees the full LicenseIntake UI (current session,
// parsed person, Auror search results, APPRISS card / transaction
// table, "use existing person" + "create new person draft" actions).
//
// PII rules: this script reads nothing PII. It only adds a navigation
// element and forwards click events to the SW.

(() => {
  if (window.__LI_AUROR_NAV_TAB_INSTALLED__) return;
  window.__LI_AUROR_NAV_TAB_INSTALLED__ = true;

  const TAB_ID = "li-auror-nav-tab";
  // Auror's main nav tabs we look for to anchor our injection.
  const KNOWN_TAB_TEXTS = ["Feed", "Search", "Insights", "Investigate", "Detections"];

  function tryMount() {
    if (document.getElementById(TAB_ID)) return;

    // Find an existing tab by its visible text. The clickable might be
    // an <a>, <button>, or any element with role="tab" / "link".
    const anchorTab = findExistingTab("Detections")
      || findExistingTab("Investigate")
      || findExistingTab("Insights")
      || findExistingTab("Search")
      || findExistingTab("Feed");
    if (!anchorTab) return;

    // Clone the existing tab to inherit its styling, then rewrite text
    // + href + click handler. Cloning is the most robust way to match
    // whatever Auror's nav looks like today.
    const ourTab = cloneTab(anchorTab);
    if (!ourTab) return;
    ourTab.id = TAB_ID;
    setTabLabel(ourTab, "Scan License");
    rewireClick(ourTab);

    // Insert after the anchor (Detections). Walk up to the LI/wrapper
    // if the anchor is itself wrapped — clone the same wrapper to match.
    const wrapper = anchorTab.closest("li, [role='tab'], [role='link']");
    if (wrapper && wrapper !== anchorTab) {
      const ourWrap = wrapper.cloneNode(false);          // empty clone of wrapper
      ourWrap.id = TAB_ID + "-wrap";
      // The cloned tab we built is the inner element; nest it.
      ourWrap.appendChild(ourTab);
      wrapper.parentNode.insertBefore(ourWrap, wrapper.nextSibling);
    } else {
      anchorTab.parentNode.insertBefore(ourTab, anchorTab.nextSibling);
    }

    console.info(
      "[licenseintake/auror_nav_tab] mounted next to:",
      (anchorTab.textContent || "").trim(),
    );
  }

  function findExistingTab(text) {
    const lower = text.toLowerCase();
    // Constrain to plausible nav containers to avoid matching random
    // page-body links that happen to say "Detections".
    const navs = document.querySelectorAll("nav, header, [role='navigation'], [role='tablist']");
    for (const nav of navs) {
      const clickables = nav.querySelectorAll("a, button, [role='tab'], [role='link']");
      for (const el of clickables) {
        const t = (el.textContent || "").trim().toLowerCase();
        if (t === lower) return el;
      }
    }
    // Fallback: any link whose text matches exactly.
    const all = document.querySelectorAll("a, button, [role='tab']");
    for (const el of all) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (t === lower) {
        // Skip page-body matches: only accept if there's a sibling that
        // matches another known tab (indicates we're in the nav cluster).
        const parent = el.parentElement;
        if (!parent) continue;
        const siblingTexts = [...parent.children]
          .map((c) => (c.textContent || "").trim())
          .filter(Boolean);
        const hasNavSibling = siblingTexts.some((s) =>
          KNOWN_TAB_TEXTS.some((k) => k.toLowerCase() === s.toLowerCase() && k !== text),
        );
        if (hasNavSibling) return el;
      }
    }
    return null;
  }

  function cloneTab(anchorTab) {
    try {
      const clone = anchorTab.cloneNode(true);   // deep clone (includes spans/svgs)
      // Strip ids inside the clone so we don't duplicate.
      for (const el of clone.querySelectorAll("[id]")) el.removeAttribute("id");
      clone.removeAttribute("id");
      // Strip data-locator / aria-current / hreflang that React might use
      // to identify "current page" highlighting.
      for (const attr of ["aria-current", "aria-selected", "data-active", "data-current"]) {
        clone.removeAttribute(attr);
        for (const el of clone.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
      }
      return clone;
    } catch {
      return null;
    }
  }

  function setTabLabel(el, label) {
    // Replace text content of the deepest text-only descendant — preserves
    // any icon / span structure Auror uses for nav items.
    const textNodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if ((n.textContent || "").trim()) textNodes.push(n);
    }
    if (textNodes.length === 1) {
      textNodes[0].textContent = label;
    } else if (textNodes.length > 1) {
      // Replace the longest text node (the label is usually the dominant text).
      textNodes.sort((a, b) => (b.textContent || "").length - (a.textContent || "").length);
      textNodes[0].textContent = label;
      // Wipe the rest so we don't have leftover text from the cloned tab.
      for (let i = 1; i < textNodes.length; i++) textNodes[i].textContent = "";
    } else {
      // No text found — set textContent directly (wipes children).
      el.textContent = label;
    }
  }

  // ── In-Auror embedded view ──────────────────────────────────────
  //
  // Click the "Scan License" tab and our content takes over Auror's
  // main content area (the slot where Feed / Search / Insights normally
  // render). Auror's own header tabs + sidebar stay visible — feels
  // like a native Auror page.
  //
  // We position the iframe directly below the existing nav and to the
  // right of any sidebar, by reading their bounding boxes at click time
  // (and on resize/scroll/Auror navigation).
  const OVERLAY_ID = "li-auror-overlay";
  const IFRAME_ID = "li-auror-overlay-iframe";

  let overlayInstalled = false;

  function openOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.style.display = "block";
      positionOverlay(overlay);
      return;
    }
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    // We position this `fixed` so it covers the content slot but not
    // the header/sidebar. Geometry is recomputed by positionOverlay().
    Object.assign(overlay.style, {
      position: "fixed",
      zIndex: "9999",                     // above content, below browser modals
      background: "var(--apai-bg, #f7f7f8)",
      display: "block",
      overflow: "hidden",
    });

    const iframe = document.createElement("iframe");
    iframe.id = IFRAME_ID;
    iframe.src = chrome.runtime.getURL("modules/licenseintake/embed.html");
    Object.assign(iframe.style, {
      width: "100%",
      height: "100%",
      border: "0",
      background: "transparent",
      display: "block",
    });
    iframe.setAttribute("allow", "camera; clipboard-write");
    // Once the iframe finishes loading, ship Auror's palette over so
    // the embed can re-skin itself to match. Sampling Auror's real
    // computed styles is more robust than hardcoding a brand color.
    iframe.addEventListener("load", () => {
      try {
        iframe.contentWindow?.postMessage(
          { type: "li_apply_theme", theme: sampleAurorTheme() },
          "*",
        );
      } catch (err) {
        console.warn("[licenseintake/auror_nav_tab] theme postMessage failed:", err?.message || err);
      }
    });
    overlay.appendChild(iframe);

    // Tiny close affordance in the top-right of the overlay so the
    // operator can dismiss without clicking another Auror tab. (Clicking
    // any other tab also dismisses via the route observer below.)
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "× Close License Intake";
    Object.assign(closeBtn.style, {
      position: "absolute",
      top: "8px",
      right: "12px",
      zIndex: "10000",
      padding: "4px 10px",
      borderRadius: "4px",
      border: "1px solid var(--apai-border, #d8d9de)",
      background: "var(--apai-bg-elev, #fff)",
      color: "var(--apai-fg, #1f2024)",
      font: "12px/1 -apple-system,'Segoe UI',sans-serif",
      cursor: "pointer",
    });
    closeBtn.addEventListener("click", () => { overlay.style.display = "none"; });
    overlay.appendChild(closeBtn);

    document.documentElement.appendChild(overlay);
    positionOverlay(overlay);

    if (!overlayInstalled) {
      overlayInstalled = true;
      // Recompute on resize/scroll/Auror SPA navigation.
      window.addEventListener("resize", () => positionOverlay(overlay));
      window.addEventListener("hashchange", () => {
        // Auror navigated → hide our overlay. They go back to whatever
        // Feed/Search/etc tab they clicked.
        overlay.style.display = "none";
      });
      // Hide overlay when any non-Scan-License tab is clicked.
      document.addEventListener("click", (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        // Our own tab click is OK — don't hide.
        if (target.id === TAB_ID || target.closest(`#${TAB_ID}, #${OVERLAY_ID}`)) return;
        // Any other clickable in a nav probably means "go elsewhere".
        const inNav = target.closest("nav, [role='navigation'], [role='tablist'], header");
        const isClickable = target.matches("a, button, [role='tab'], [role='link']") || target.closest("a, button, [role='tab'], [role='link']");
        if (inNav && isClickable && overlay.style.display !== "none") {
          overlay.style.display = "none";
        }
      }, true);
    }
  }

  /**
   * Sample Auror's real palette + typography from currently-rendered
   * elements. Returns a theme object the embed page can apply as CSS
   * custom properties so the licenseintake UI looks like a native
   * Auror panel rather than a generic extension surface.
   */
  function sampleAurorTheme() {
    const bodyCs = window.getComputedStyle(document.body);
    const fontFamily = bodyCs.fontFamily;
    const bg = bodyCs.backgroundColor && bodyCs.backgroundColor !== "rgba(0, 0, 0, 0)"
      ? bodyCs.backgroundColor : "#ffffff";
    const fg = bodyCs.color || "#1f2024";

    // Pick a visible "elevated" surface — a card-ish container near
    // the main content. Fall back to white.
    let bgElev = "#ffffff";
    const candCard = document.querySelector("[class*='card'], [class*='panel'], main, [role='main']");
    if (candCard) {
      const c = window.getComputedStyle(candCard).backgroundColor;
      if (c && c !== "rgba(0, 0, 0, 0)") bgElev = c;
    }

    // Borders + muted text from typical secondary surfaces.
    let border = "#d8d9de";
    const candBorder = document.querySelector("hr, [class*='border'], table, [class*='divider']");
    if (candBorder) {
      const c = window.getComputedStyle(candBorder).borderColor || window.getComputedStyle(candBorder).backgroundColor;
      if (c && c !== "rgba(0, 0, 0, 0)") border = c;
    }
    let fgMuted = "#5a5d66";
    const candMuted = document.querySelector("small, [class*='muted'], [class*='secondary'], [class*='subtitle']");
    if (candMuted) {
      const c = window.getComputedStyle(candMuted).color;
      if (c) fgMuted = c;
    }

    // Primary accent — pick a filled button in nav/header.
    let accent = "#1565d8";
    let accentFg = "#ffffff";
    const candAccent = pickFilledButton();
    if (candAccent) {
      const cs = window.getComputedStyle(candAccent);
      if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") {
        accent = cs.backgroundColor;
        accentFg = cs.color || "#ffffff";
      }
    }

    return {
      bg,
      bgElev,
      fg,
      fgMuted,
      border,
      accent,
      accentFg,
      fontFamily,
    };
  }

  function pickFilledButton() {
    const cs = document.querySelectorAll("button, [role='button'], a[class*='btn']");
    let best = null;
    let bestArea = 0;
    for (const el of cs) {
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 22 || r.height > 60) continue;
      const style = window.getComputedStyle(el);
      if (style.backgroundColor === "rgba(0, 0, 0, 0)" || style.backgroundColor === "transparent") continue;
      // Prefer the largest button in the header / top portion of the page.
      if (r.top < 200 && r.width * r.height > bestArea) {
        bestArea = r.width * r.height;
        best = el;
      }
    }
    return best;
  }

  /**
   * Snap the overlay to whatever rectangle Auror's main content area
   * currently occupies — below the header nav, right of the sidebar.
   * Walks Auror's DOM landmarks instead of hardcoding pixel offsets.
   */
  function positionOverlay(overlay) {
    if (!overlay) return;
    // Find the bottom of Auror's header by walking up from our tab
    // (the cloned header element).
    const tab = document.getElementById(TAB_ID);
    const headerEl = tab ? (tab.closest("header, nav, [role='navigation']") || tab.parentElement) : null;
    const headerRect = headerEl ? headerEl.getBoundingClientRect() : { bottom: 56 };

    // Find left edge of content area (right of any sidebar). Look for
    // <aside> / <nav> on the left of viewport.
    let leftEdge = 0;
    const sides = document.querySelectorAll("aside, nav[role='navigation'], [data-locator='sidebar'], [class*='sidebar']");
    for (const s of sides) {
      const r = s.getBoundingClientRect();
      // It's a left sidebar if it's narrow vs tall AND starts at the
      // left edge AND its bottom is well below the header.
      if (r.left < 10 && r.width < 320 && r.bottom > headerRect.bottom + 100) {
        leftEdge = Math.max(leftEdge, r.right);
      }
    }

    overlay.style.top = `${Math.round(headerRect.bottom)}px`;
    overlay.style.left = `${Math.round(leftEdge)}px`;
    overlay.style.right = "0";
    overlay.style.bottom = "0";
  }

  function rewireClick(el) {
    // Strip the original href so Auror's router doesn't try to navigate
    // to a templated URL. We handle the click ourselves.
    el.removeAttribute("href");
    el.style.cursor = "pointer";

    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openOverlay();
    }, true);
  }

  // Initial mount + observe for Auror's rerenders.
  tryMount();
  const mo = new MutationObserver(() => tryMount());
  mo.observe(document.body, { childList: true, subtree: true });

  console.info("[licenseintake/auror_nav_tab] installed");
})();
