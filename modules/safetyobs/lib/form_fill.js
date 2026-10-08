// modules/safetyobs/lib/form_fill.js
//
// Fills the Safety Observation Survey in an open Microsoft Forms tab and,
// when asked, presses Submit. Runs in the page (chrome.scripting MAIN world),
// so FILL_FORM must stay self-contained: no imports, no outer variables.
//
// Driving the real page instead of POSTing to the forms API on purpose: the
// response API's body shape was never captured from a real submit, and a wrong
// guess would file a broken observation under the user's name. The UI path is
// exactly what a person does, and its branching is the form's own.
//
// Microsoft Forms renders every choice question here as a dropdown: a button
// inside [data-automation-id="questionItem"] that opens a [role=option] list.
// Text boxes are React-controlled, so the value goes through the native
// setter followed by an input event.

/**
 * @param {{questions: Array<{key,kind,title,onlyFor?}>, answers: object, submit: boolean}} arg
 * @returns {Promise<{ok:boolean, filled?:object, submitted?:boolean, error?:string, step?:string}>}
 */
export async function FILL_FORM(arg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const items = () => Array.from(document.querySelectorAll('[data-automation-id="questionItem"]'));
  const titleOf = (el) => {
    const t = el.querySelector('[data-automation-id="questionTitle"]');
    return norm(t ? t.innerText : el.innerText.split("\n").slice(0, 3).join(" "));
  };
  const findItem = (title) => items().find((el) => titleOf(el).includes(norm(title)));
  async function waitFor(fn, ms, step) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw Object.assign(new Error("timed out: " + step), { step });
      await sleep(200);
    }
  }
  function setText(el, value) {
    const input = el.querySelector("textarea, input[type=text], input:not([type])");
    if (!input) throw Object.assign(new Error("no text box"), { step: "text" });
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    return norm(input.value) === norm(value);
  }
  async function pick(el, value, title) {
    const btn = el.querySelector('[role="button"], [role="combobox"], button');
    if (!btn) throw Object.assign(new Error("no dropdown for " + title), { step: "dropdown" });
    if (norm(btn.innerText) === norm(value)) return true;
    btn.click();
    const opt = await waitFor(
      () => Array.from(document.querySelectorAll('[role="option"]')).find((o) => norm(o.innerText) === norm(value)),
      5000, "option " + value + " in " + title,
    );
    opt.click();
    await waitFor(() => norm(btn.innerText) === norm(value), 3000, "selected " + value);
    return true;
  }

  try {
    await waitFor(() => items().length >= 4 && findItem("Store Number"), 20000, "form load");
    const filled = {};
    for (const q of arg.questions) {
      if (q.onlyFor && q.onlyFor !== arg.answers.type) continue;
      const value = String(arg.answers[q.key] ?? "").trim();
      if (!value) return { ok: false, step: q.key, error: "no answer for " + q.title };
      // Branched questions appear only after the type pick re-renders.
      const el = await waitFor(() => findItem(q.title), 5000, "question " + q.title);
      if (q.kind === "text") {
        if (!setText(el, value)) return { ok: false, step: q.key, error: "text did not stick: " + q.title };
      } else {
        await pick(el, value, q.title);
      }
      filled[q.key] = value;
      await sleep(150);
    }
    if (!arg.submit) return { ok: true, filled, submitted: false };

    const submit = Array.from(document.querySelectorAll("button")).find((b) => norm(b.innerText) === "submit");
    if (!submit) return { ok: false, step: "submit", error: "no Submit button" };
    submit.click();
    // Thank-you page; an error banner (required field) keeps the form up.
    const done = await waitFor(() => {
      const t = norm(document.body.innerText);
      if (/your response was submitted|thanks!|thank you/.test(t) && !findItem("Store Number")) return "ok";
      const err = document.querySelector('[role="alert"]');
      if (err && norm(err.innerText)) return "err:" + err.innerText.trim().slice(0, 200);
      return null;
    }, 20000, "submit confirmation");
    if (done !== "ok") return { ok: false, step: "submit", error: done.slice(4), filled };
    return { ok: true, filled, submitted: true };
  } catch (e) {
    return { ok: false, step: e.step || "fill", error: String(e.message || e) };
  }
}
