// Content script — runs inside the ClearSight Storms Wrapper SPA. Its only
// job is to focus the global Quick Search input when ClaimsBuddy asks, so
// the user can immediately Enter (or Ctrl+V Enter) the ref# that ClaimsBuddy
// already dropped on their clipboard.
//
// Why a content script and not just chrome.tabs.create with a URL:
//   - The SPA keeps every claim under the same URL (`…/Storms.Wrapper/#/`).
//     No URL deep-link is possible (confirmed via DevTools Protocol probing
//     of the Angular component — it intercepts navigation internally and
//     production builds expose no Angular dev hooks).
//   - Synthetic input + click events don't fire the search submit (Angular
//     ignores untrusted events in this code path).
//   - The only realistic shortcut is: focus the field, pre-fill the value
//     and try to nudge Angular's form model, let the user hit Enter (or
//     Ctrl+V Enter if pre-fill doesn't take).

const SEARCH_INPUT_ID = "quick-search-input-text";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action !== "focus_search") return;

  // The SPA may still be hydrating on a freshly-opened tab — poll briefly
  // for the input to appear before giving up.
  let tries = 0;
  const t = setInterval(() => {
    const inp = document.getElementById(SEARCH_INPUT_ID);
    if (inp) {
      clearInterval(t);
      inp.focus();
      if (msg.ref) {
        // Pre-fill via the native value setter so Angular's
        // ControlValueAccessor sees the change, then dispatch an input
        // event so the FormControl picks it up. If Angular's reactive
        // form accepts the synthetic input event, the user only needs to
        // press Enter — saving a keystroke vs. Ctrl+V Enter. If it
        // doesn't (synthetic events are sometimes filtered), the value
        // is still pre-selected so Ctrl+V cleanly replaces it.
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        ).set;
        setter.call(inp, msg.ref);
        inp.dispatchEvent(new Event("input",  { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }
      inp.select();  // either pre-selects the pre-fill OR any stale text
      sendResponse({ ok: true });
    } else if (++tries > 50) {  // ~5s
      clearInterval(t);
      sendResponse({ ok: false, error: "Quick Search input not found after 5s" });
    }
  }, 100);
  return true; // keep the message channel open for the async sendResponse
});
