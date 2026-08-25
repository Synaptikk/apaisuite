// modules/digitalmetrics/lib/crypto_config.js
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THREAT MODEL — read this before trusting the word "encrypted".       │
// │                                                                      │
// │ This key ships inside a sideloaded extension. Every install has a    │
// │ copy. It is therefore NOT a secret from anyone holding the           │
// │ extension, and it never will be.                                     │
// │                                                                      │
// │ What this protects against:                                          │
// │   • a compromised or misconfigured Firestore                         │
// │   • anyone reading the database directly (console, REST, exports)    │
// │   • associate names sitting at rest on Google infrastructure         │
// │                                                                      │
// │ What it does NOT protect against:                                    │
// │   • a person who has the extension (they can decrypt everything)     │
// │   • traffic analysis: tokens are deterministic, so equality and      │
// │     frequency of associates leak. Accepted deliberately — the        │
// │     module cannot join a week of history without it.                 │
// │                                                                      │
// │ Rotating the key re-encrypts display names but MUST NOT change the   │
// │ token derivation, or every historical join breaks. See names.js.     │
// └──────────────────────────────────────────────────────────────────────┘

// 32 bytes, base64. Replace before distribution — this is a placeholder so the
// module runs in development, and it is committed, which means it is public.
export const MASTER_SECRET_B64 = "REPLACE_ME_WITH_32_RANDOM_BYTES_BASE64_ENCODED==";

// Domain-separation labels for HKDF. Changing TOKEN_INFO orphans every
// historical record; changing DISPLAY_INFO only requires re-encrypting names.
export const TOKEN_INFO   = "digitalmetrics/associate-token/v1";
export const DISPLAY_INFO = "digitalmetrics/associate-display/v1";
