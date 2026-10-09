// shared/outlook_send.js
//
// Send an email from the user's own Outlook on the web session — no
// credentials, no Graph token, no SMTP. Used by metricshot's scheduled email
// jobs (closing list, VizPick reports).
//
// HOW (verified live against outlook.cloud.microsoft, 2026-10-08)
// ----------------------------------------------------------------
//   1. Open the compose deeplink in a background tab:
//        https://outlook.office.com/mail/deeplink/compose?to=…&subject=…
//      It redirects to outlook.cloud.microsoft and fills To + Subject. (The
//      deeplink's own `body=` is plain text and capped by URL length, so the
//      body goes in by paste instead.)
//   2. In the page (MAIN world), paste into the "Message body" editor with a
//      synthetic ClipboardEvent: the text as text/html, then each PNG as a
//      File. OWA's own paste handler takes both and inlines the images.
//   3. Click the "Send" button. A deeplink compose window closes itself once
//      the send is accepted; that close (or the editor going away) is
//      success.
//
// Typing an address into the To well by script does NOT make a recipient
// chip, so recipients only ever go in through the deeplink `to=` parameter.

const COMPOSE_URL = "https://outlook.office.com/mail/deeplink/compose";
const LOAD_TIMEOUT_MS = 60_000;
const SEND_TIMEOUT_MS = 45_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "a@x.com; b@y.com" | ["a@x.com"] → ["a@x.com", "b@y.com"] */
export function parseRecipients(to) {
  const list = Array.isArray(to) ? to : String(to || "").split(/[;,\s]+/);
  return [...new Set(list.map((s) => String(s).trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)))];
}

/** Plain text → HTML paragraphs OWA keeps as typed. */
export function textToHtml(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return String(text || "").split("\n").map((l) => `<div>${l ? esc(l) : "<br>"}</div>`).join("");
}

/**
 * @param {object} p
 * @param {string|string[]} p.to
 * @param {string} p.subject
 * @param {string} [p.text]     plain-text body (line breaks kept)
 * @param {{base64:string, name:string}[]} [p.images]  PNGs, inlined in order after the text
 * @param {(step:string, extra?:object)=>void} [p.onStep]
 * @returns {Promise<{ok:boolean, error?:string, errorClass?:string}>}
 */
export async function sendOutlookMail({ to, subject, text = "", images = [], onStep = () => {} }) {
  const recipients = parseRecipients(to);
  if (!recipients.length) return { ok: false, errorClass: "CONFIG", error: "no valid recipient" };
  const url = `${COMPOSE_URL}?to=${encodeURIComponent(recipients.join(";"))}&subject=${encodeURIComponent(subject || "")}`;

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    onStep("compose-opened");

    const filled = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: IN_PAGE_FILL,
      args: [{ html: textToHtml(text), images, timeoutMs: LOAD_TIMEOUT_MS }],
    }).then((r) => r?.[0]?.result), LOAD_TIMEOUT_MS + 30_000, { ok: false, errorClass: "TIMEOUT", error: "compose fill hung" });
    if (!filled?.ok) return { ok: false, errorClass: filled?.errorClass || "COMPOSE", error: filled?.error || "compose fill failed" };
    onStep("compose-filled", { images: filled.images });

    // Fire-and-forget click: the page closes itself on success, which would
    // reject an awaited executeScript and look like a failure.
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: IN_PAGE_CLICK_SEND })
      .catch(() => {});
    onStep("send-clicked");

    const started = Date.now();
    while (Date.now() - started < SEND_TIMEOUT_MS) {
      await sleep(1000);
      const alive = await chrome.tabs.get(tabId).then(() => true, () => false);
      if (!alive) { tabId = null; return { ok: true }; }
      const st = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: IN_PAGE_SEND_STATE })
        .then((r) => r?.[0]?.result, () => null);
      if (st?.sent) return { ok: true };
      if (st?.error) return { ok: false, errorClass: "SEND", error: st.error };
    }
    return { ok: false, errorClass: "TIMEOUT", error: "Outlook did not confirm the send" };
  } catch (e) {
    return { ok: false, errorClass: "EXCEPTION", error: String(e?.message ?? e) };
  } finally {
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
  }
}

function withTimeout(p, ms, fallback) {
  return Promise.race([p.catch((e) => ({ ok: false, error: String(e?.message ?? e) })), sleep(ms).then(() => fallback)]);
}

// ── In-page functions (serialized into the Outlook tab; must stay pure) ──

async function IN_PAGE_FILL({ html, images, timeoutMs }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  let body = null;
  while (Date.now() - t0 < timeoutMs) {
    if (/login\.microsoftonline\.com|\/login/i.test(location.href)) {
      return { ok: false, errorClass: "AUTH", error: "Outlook is not signed in" };
    }
    body = document.querySelector('[aria-label="Message body"][contenteditable="true"]');
    if (body) break;
    await sleep(300);
  }
  if (!body) return { ok: false, errorClass: "COMPOSE", error: "compose editor never appeared" };
  await sleep(1500);   // let OWA finish wiring the editor

  // The deeplink's recipients resolve into chips a moment after the editor
  // mounts. Never send until at least one is showing.
  const toWell = document.querySelector('[aria-label="To"][contenteditable="true"]');
  const chips = () => toWell ? toWell.querySelectorAll('[class*="_EType_RECIPIENT_ENTITY"]').length : 0;
  const tTo = Date.now();
  while (!chips() && Date.now() - tTo < 15_000) await sleep(500);
  if (!chips()) return { ok: false, errorClass: "COMPOSE", error: "recipients never appeared in To" };
  const toText = [...toWell.querySelectorAll('[class*="_EType_RECIPIENT_ENTITY"]')].map((c) => c.getAttribute("aria-label") || "").join("; ");

  const caretToEnd = () => {
    body.focus();
    const sel = getSelection();
    const rg = document.createRange();
    rg.selectNodeContents(body);
    rg.collapse(false);
    sel.removeAllRanges();
    sel.addRange(rg);
  };
  const paste = (dt) => body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));

  if (html) {
    caretToEnd();
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    dt.setData("text/plain", html.replace(/<[^>]+>/g, "\n"));
    paste(dt);
    await sleep(800);
  }
  for (const img of images || []) {
    const bin = atob(img.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    caretToEnd();
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], img.name || "image.png", { type: "image/png" }));
    paste(dt);
    await sleep(2500);
  }
  const want = (images || []).length;
  const t1 = Date.now();
  while (body.querySelectorAll("img").length < want && Date.now() - t1 < 20_000) await sleep(500);
  const got = body.querySelectorAll("img").length;
  if (got < want) return { ok: false, errorClass: "COMPOSE", error: `only ${got} of ${want} images landed in the body` };
  if (html && !body.innerText.trim()) return { ok: false, errorClass: "COMPOSE", error: "body text did not land" };
  await sleep(2000);   // inline uploads
  return { ok: true, images: got, toText: toText.slice(0, 200) };
}

function IN_PAGE_CLICK_SEND() {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").trim() === "Send");
  if (!btn) return { ok: false };
  btn.click();
  return { ok: true };
}

function IN_PAGE_SEND_STATE() {
  const editor = document.querySelector('[aria-label="Message body"][contenteditable="true"]');
  const alerts = [...document.querySelectorAll('[role="alert"], [role="alertdialog"], [role="dialog"]')]
    .map((d) => d.innerText.trim()).filter(Boolean);
  const bad = alerts.find((t) => /couldn.t|can.t be sent|didn.t send|not sent|error|check the address|recipient/i.test(t));
  if (bad) return { error: bad.slice(0, 200) };
  return { sent: !editor };
}

// For dev harnesses that drive the same page code over CDP.
export const __inPage = { IN_PAGE_FILL, IN_PAGE_CLICK_SEND, IN_PAGE_SEND_STATE };
