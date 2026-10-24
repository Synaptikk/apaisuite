// modules/digitaldashboard/lib/phone_control.js
//
// Pause / resume the GIF Companion phone from the dashboard. The PC daemon
// (dev/gif-daemon.mjs) and the QRCallBox cloud copy (functions/src/http/gif/
// lib/dd/) both keep one control record and hand it to the phone in every
// ingest reply as `control`; the phone applies it when `seq` changes, so a
// pause set here also overrides a pause someone set on the phone, and a resume
// here clears one. Every pause ends on its own (at most MAX_PAUSE_MIN), so a
// forgotten pause can't leave the phone idle overnight.
//
// Control: { seq, pauseUntil (ms epoch, 0 = running), by, at }
// Phone status (what the phone reports back): status.pausedUntil, status.pauseReason

export const MAX_PAUSE_MIN = 240;

export function emptyControl() { return { seq: 0, pauseUntil: 0, by: null, at: 0 }; }

/** minutes > 0 pauses for that long (capped); 0 resumes. Returns a NEW control. */
export function setPause(control, minutes, by = "dashboard", now = Date.now()) {
  const c = control && Number.isFinite(control.seq) ? control : emptyControl();
  const min = Math.max(0, Math.min(MAX_PAUSE_MIN, Math.round(Number(minutes) || 0)));
  return { seq: c.seq + 1, pauseUntil: min ? now + min * 60_000 : 0, by: String(by || "dashboard").slice(0, 40), at: now };
}

/** The `control` field of an ingest reply (null until anyone has paused). */
export function controlReply(control) {
  return control && control.seq ? { seq: control.seq, pauseUntil: control.pauseUntil || 0, by: control.by || null } : null;
}

/** The phone's own pause as it last reported it: { until, reason } or null when running. */
export function phonePause(status, now = Date.now()) {
  const until = Number(status?.pausedUntil) || 0;
  return until > now ? { until, reason: status?.pauseReason || null } : null;
}
