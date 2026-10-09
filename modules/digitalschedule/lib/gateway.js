// modules/digitalschedule/lib/gateway.js
//
// The schedule assistant's model call: Claude through Walmart's AI gateway
// (puppy-backend.walmart.com, the Code Puppy backend). Runs in the service
// worker only. The token is the one the Cx module signs in with
// (cx.settings.v1 — read-only here); it never goes to the view.
//
// Same failure rules as modules/cx/lib/narrative.js: the gateway signals a
// version block and errors inside HTTP 200, so the body is always checked.

import { readSettings } from "../../cx/lib/store.js";
import { tokenStatus, DEFAULT_CLIENT_VERSION } from "../../cx/lib/narrative.js";

const ENDPOINT = "https://puppy-backend.walmart.com/anthropic/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const BLOCKED_RE = /out of date and has been temporarily blocked|update to the latest version from https:\/\/puppy\.walmart\.com/i;
export const MODELS = ["claude-opus-5", "claude-sonnet-5"];

export async function gatewayStatus() {
  const s = await readSettings();
  return tokenStatus(s.gatewayToken);
}

async function post(token, version, body) {
  let res;
  try {
    res = await fetch(ENDPOINT, { method: "POST", headers: {
      "content-type": "application/json", "X-Api-Key": token, "anthropic-version": ANTHROPIC_VERSION, "x-puppy-version": version,
    }, body: JSON.stringify(body) });
  } catch (e) { console.warn("[digitalschedule] gateway fetch failed", e); throw new Error("Couldn't reach the assistant. Try again."); }
  if (res.status === 401 || res.status === 403) { const e = new Error("The assistant sign-in has expired. Press “Sign in to assistant”."); e.code = "AUTH"; throw e; }
  if (!res.ok) { console.warn("[digitalschedule] gateway HTTP", res.status, (await res.text().catch(() => "")).slice(0, 300)); throw new Error("The assistant didn't answer. Try again."); }
  const json = await res.json().catch(() => null);
  const text = (json?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
  if (BLOCKED_RE.test(text)) { console.warn("[digitalschedule] gateway blocked this client version (update it under Cx settings)", text.slice(0, 300)); throw new Error("The assistant is unavailable right now."); }
  if (json?.type === "error" || json?.error) { console.warn("[digitalschedule] gateway error", json.error); throw new Error("The assistant hit an error. Try again."); }
  if (!Array.isArray(json?.content)) throw new Error("The assistant sent an empty reply. Try again.");
  return json;
}

/** One assistant turn. `req` = { model, system, messages, tools }. */
export async function chatTurn(req) {
  const s = await readSettings();
  const st = tokenStatus(s.gatewayToken);
  if (!st.ok) { const e = new Error("The assistant isn't signed in. Press “Sign in to assistant”."); e.code = "AUTH"; throw e; }
  const model = MODELS.includes(req.model) ? req.model : MODELS[0];
  const body = { model, max_tokens: 4000, thinking: { type: "disabled" }, system: req.system, messages: req.messages, tools: req.tools };
  let json = await post(s.gatewayToken, s.gatewayClientVersion || DEFAULT_CLIENT_VERSION, body);
  // The gateway sometimes spends the whole budget on thinking despite
  // thinking: disabled (Cx, 2026-09-25) — one retry with room to finish.
  const useful = json.content.some((b) => b.type === "text" && b.text.trim() || b.type === "tool_use");
  if (!useful && json.stop_reason === "max_tokens") json = await post(s.gatewayToken, s.gatewayClientVersion || DEFAULT_CLIENT_VERSION, { ...body, max_tokens: 12000 });
  // Only what the conversation needs goes back: thinking blocks are dropped.
  return { content: json.content.filter((b) => b.type === "text" || b.type === "tool_use"), stop_reason: json.stop_reason, model: json.model ?? model, usage: json.usage ?? null };
}
