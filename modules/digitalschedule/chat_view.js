// modules/digitalschedule/chat_view.js
//
// Schedule assistant panel: a chat with Claude through the AI gateway
// (service.js::chat → lib/gateway.js) that edits the page's queue through the
// tools in lib/assistant.js. The tool loop runs here, in the page, because the
// queue and the loaded week live here; the gateway token stays in the SW.
// Saving is never a tool — the manager presses Save.

import { buildSystem, TOOLS, runTool } from "./lib/assistant.js";

const MAX_ROUNDS = 12;
const LONG = { timeoutMs: 330_000 };

export function mountChat(host, root, ctl) {
  const esc = host.ui.escapeHtml;
  const $ = (id) => root.querySelector("#digitalschedule-chat-" + id);
  const els = { log: $("log"), form: $("form"), input: $("input"), send: $("send"), model: $("model"), reset: $("reset"), auth: $("auth"), state: $("state") };
  let messages = [];      // Anthropic-format conversation (text, tool_use, tool_result)
  let weekKey = null, busy = false, alive = true;

  host.storage.local.get("chatModel").then((m) => { if (m) els.model.value = m; }).catch(() => {});
  els.model.addEventListener("change", () => host.storage.local.set("chatModel", els.model.value).catch(() => {}));

  const scroll = () => { els.log.scrollTop = els.log.scrollHeight; };
  const fmtText = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\n/g, "<br>");
  function add(kind, html) { const d = document.createElement("div"); d.className = `ds-msg ${kind}`; d.innerHTML = html; els.log.appendChild(d); scroll(); return d; }
  function empty() {
    els.log.innerHTML = "";
    add("hint", `e.g. <i>“move Bobby's Saturday to 9–6, lunch at 1”</i> or <i>“fit Wednesday to guidance”</i>. Changes go to the queue; you press Submit changes.`);
  }
  empty();

  async function refreshAuth() {
    const r = await host.messaging.sendRaw("gateway_status").catch((e) => ({ ok: false, error: e.message }));
    const ok = r.ok && r.status?.ok;
    els.auth.hidden = ok;
    els.state.textContent = ok ? `assistant signed in until ${new Date(r.status.expiresAt).toLocaleDateString()}` : "assistant not signed in";
    return ok;
  }
  refreshAuth();

  els.auth.addEventListener("click", () => {
    els.auth.disabled = true; els.state.textContent = "signing in…";
    // The Cx module owns the gateway sign-in and the token; this module only borrows it.
    chrome.runtime.sendMessage({ module: "cx", type: "signInGateway" }, (r) => {
      els.auth.disabled = false;
      if (!alive) return;
      if (chrome.runtime.lastError || !r?.ok) { console.warn("[digitalschedule] sign-in failed", chrome.runtime.lastError?.message || r?.error || r?.reason); els.state.textContent = "sign-in failed — try again"; }
      else refreshAuth();
    });
  });

  els.reset.addEventListener("click", () => { if (!busy) { messages = []; empty(); } });

  function setBusy(on) { busy = on; els.send.disabled = on; els.input.disabled = on; els.send.textContent = on ? "Working…" : "Send"; }

  async function ask(text) {
    if (!ctl.data()) { add("error", "Load a week first."); return; }
    const key = ctl.weekKey();
    if (key !== weekKey) { if (messages.length) add("hint", "New week loaded — starting a fresh conversation."); messages = []; weekKey = key; }
    add("user", fmtText(text));
    const start = messages.length;
    messages.push({ role: "user", content: text });
    setBusy(true);
    const thinking = add("pending", "…");
    try {
      for (let round = 0; round < MAX_ROUNDS && alive; round++) {
        const r = await host.messaging.sendRaw("chat", { model: els.model.value, system: buildSystem(ctl), messages, tools: TOOLS }, LONG)
          .catch((e) => ({ ok: false, error: e.message }));
        if (!r.ok) {
          if (r.code === "AUTH") { els.auth.hidden = false; refreshAuth(); }
          messages.length = start; // drop the half-finished exchange so a retry starts clean
          throw new Error(r.error);
        }
        messages.push({ role: "assistant", content: r.content });
        const said = r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        const calls = r.content.filter((b) => b.type === "tool_use");
        if (said) els.log.insertBefore(Object.assign(document.createElement("div"), { className: "ds-msg bot", innerHTML: fmtText(said) }), thinking);
        if (!calls.length) break;
        const results = [];
        for (const c of calls) {
          let out;
          try { out = await runTool(c.name, c.input || {}, ctl); }
          catch (e) { console.warn("[digitalschedule] tool failed", c.name, e); out = { text: `Tool failed: ${e.message}`, activity: "a step failed" }; }
          els.log.insertBefore(Object.assign(document.createElement("div"), { className: "ds-msg tool", textContent: `↳ ${out.activity}` }), thinking);
          results.push({ type: "tool_result", tool_use_id: c.id, content: out.text });
        }
        messages.push({ role: "user", content: results });
        scroll();
        if (round === MAX_ROUNDS - 1) add("error", "Stopped after a dozen steps — ask again to continue.");
      }
    } catch (e) {
      add("error", esc(e.message));
    } finally {
      thinking.remove(); if (alive) setBusy(false); scroll();
    }
  }

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.input.value.trim(); if (!text || busy) return;
    els.input.value = ""; ask(text);
  });
  els.input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); els.form.requestSubmit(); } });

  return () => { alive = false; };
}
