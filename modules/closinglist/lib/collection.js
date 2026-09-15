// Keep diagnostics categorical: upstream errors can contain HTML or personal data.
export function failureKind(error) {
  const text = String(error?.message ?? error ?? "");
  if (/401|403|sign.?in|text\/html|content-type|sso/i.test(text)) return "auth";
  if (/viewstate|validation of viewstate mac/i.test(text)) return "viewstate";
  if (/timed?\s*out|timeout/i.test(text)) return "timeout";
  if (/receiving end|connection|fetch|network/i.test(text)) return "network";
  return "other";
}

// The real read is the session probe. Only an auth failure gets one recovery.
export async function collectSchedule({ collect, recover, emit = () => {} }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try { result = await collect(); }
    catch (error) { result = { ok: false, error: String(error?.message ?? error) }; }
    if (result?.ok) return result;
    const error = result?.error || "Unknown schedule response";
    const authFailure = result?.errorClass ? result.errorClass === "AUTH" : failureKind(error) === "auth";
    if (attempt || !authFailure) throw new Error(error);
    emit("schedule_auth_recovery", { attempt: 1 });
    await recover();
  }
}
