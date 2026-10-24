// modules/digitaldashboard/lib/meal_hash.js
//
// Punched meals for the cloud break watch, pseudonymized (user, 2026-10-24:
// "obfuscate the lunches on the server"). The browser reads GTA punches; only
// the four numbers break_log.js uses leave it, keyed by an HMAC of the name:
//
//   { "<hash>": [clockOut, mealOut, mealIn, readAt], … }
//
// clockOut/mealOut/mealIn = minutes since the day's midnight (null when not
// punched), readAt = ms the punches were read (break_log's `_at`). No WIN, job,
// punch app, access point, GPS or PTO codes; no clock-in (nothing uses it).
//
// The hash covers the first and last word of the normalised name — exactly what
// gif_metrics.sameName compares — so a GIF name finds the same punch it would
// have found by name. The server hashes GIF names with the same per-user key to
// look meals up, so this is pseudonymization, not encryption: whoever holds the
// key and a name list can re-link them. The doc expires after two days.
//
// Pure apart from WebCrypto (browser SW and Node 20 both have crypto.subtle);
// the QRCallBox copy lives at functions/src/http/gif/lib/dd/meal_hash.js.

import { normName } from "./gif_metrics.js";

export const MEAL_HASH_HEX = 24;   // 96 bits: no collisions across a store's few hundred names

/** "first last" — the part of a name sameName compares. */
export function mealNameKey(name) {
  const t = normName(name).split(" ").filter(Boolean);
  return t.length ? `${t[0]} ${t[t.length - 1]}` : "";
}

const hexBytes = (hex) => Uint8Array.from(String(hex).match(/../g) || [], (h) => parseInt(h, 16));
const keyCache = new Map();
async function hmacKey(keyHex, subtle) {
  if (!keyCache.has(keyHex)) {
    keyCache.set(keyHex, subtle.importKey("raw", hexBytes(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
  }
  return keyCache.get(keyHex);
}

/** The hash a name is stored under, or "" for an empty name. */
export async function mealHash(keyHex, name, subtle = globalThis.crypto.subtle) {
  const k = mealNameKey(name);
  if (!k || !/^[0-9a-f]{32,}$/i.test(String(keyHex || ""))) return "";
  const sig = await subtle.sign("HMAC", await hmacKey(keyHex, subtle), new TextEncoder().encode(k));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, MEAL_HASH_HEX);
}

const numOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** break_log punch → stored row. */
export function mealRow(p) {
  return [numOrNull(p?.clockOut), numOrNull(p?.mealOut), numOrNull(p?.mealIn), numOrNull(p?._at) ?? 0];
}

/** stored row → break_log punch ({ clockOut, mealOut, mealIn, _at }). */
export function punchFromRow(row) {
  if (!Array.isArray(row)) return null;
  const [clockOut, mealOut, mealIn, at] = row;
  return { clockOut: numOrNull(clockOut), mealOut: numOrNull(mealOut), mealIn: numOrNull(mealIn), _at: numOrNull(at) ?? 0 };
}

/** { NAME: punch } → { hash: row }. A read that found no meal still goes: it is what releases a hold. */
export async function hashMeals(keyHex, punches, subtle = globalThis.crypto.subtle) {
  const out = {};
  for (const [name, p] of Object.entries(punches || {})) {
    const h = await mealHash(keyHex, name, subtle);
    if (h) out[h] = mealRow(p);
  }
  return out;
}

/** Stored { hash: row } → { name: punch } for just these names (in memory only, never stored). */
export async function mealsForNames(keyHex, meals, names, subtle = globalThis.crypto.subtle) {
  const out = {};
  if (!meals || !keyHex) return out;
  for (const name of new Set((names || []).filter(Boolean))) {
    const p = punchFromRow(meals[await mealHash(keyHex, name, subtle)]);
    if (p) out[name] = p;
  }
  return out;
}

/** A valid upload row: four numbers-or-nulls, minutes within a day, readAt a plausible epoch ms. */
export function validMealRow(row) {
  if (!Array.isArray(row) || row.length !== 4) return false;
  const [clockOut, mealOut, mealIn, at] = row;
  const minute = (v) => v === null || (Number.isInteger(v) && v >= 0 && v < 2 * 1440);
  return minute(clockOut) && minute(mealOut) && minute(mealIn) && Number.isFinite(at) && at >= 0;
}
