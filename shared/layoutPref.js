// shared/layoutPref.js
//
// Validation for the optional Preview layout setting. Kept separate from the
// theme logic in app.js so layout and theme can never accidentally share a
// resolution path — they are independent settings, and a bug that made one
// fall back based on the other would violate that on day one.
//
// Storage shape: chrome.storage.sync["shell.layout"] = "current" | "preview",
// mirrored to localStorage["shell.layout"] for the pre-paint fast path in
// theme_boot.js (same pattern as "shell.theme").

export const LAYOUTS = Object.freeze({
  CURRENT: "current",
  PREVIEW: "preview",
});

const VALID = new Set(Object.values(LAYOUTS));

// Anything other than the literal string "preview" resolves to "current" —
// missing, null, malformed, or a value from some future/older build. The
// Current layout is the only safe default: it is what every existing user is
// already on, and this must never surprise someone into the unfinished UI.
export function resolveLayoutPref(raw) {
  return raw === LAYOUTS.PREVIEW ? LAYOUTS.PREVIEW : LAYOUTS.CURRENT;
}

export function isPreviewLayout(raw) {
  return resolveLayoutPref(raw) === LAYOUTS.PREVIEW;
}
