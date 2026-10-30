// modules/gifphone/service.js
//
// Pairing and phone health come from the Digital Dashboard's handlers, so a
// phone paired here is the same one the dashboard reads (store, key, source).
// The QRCallBox key behind them is the Workvivo module's.

import { handlers as dd } from "../digitaldashboard/service.js";
import { qrcallboxApiKey } from "../workvivo/service.js";

export const handlers = {
  "prereqs":     async () => ({ ok: true, hasKey: !!(await qrcallboxApiKey().catch(() => "")) }),
  "pair_phone":  () => dd.pair_phone(),
  "pair_status": () => dd.pair_status(),
  "health":      () => dd.health(),
};
