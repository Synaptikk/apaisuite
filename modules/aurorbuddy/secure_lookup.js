// modules/aurorbuddy/secure_lookup.js
//
// Popup view for the "Secure" pill we inject onto Auror person cards.
//
// Receives ?name=<full name>&id=<auror person id> on the URL, defaults the
// home-store input from livedashboard.settings (already configured by the
// user once for the dashboard), and calls the existing appriss_lookup SW
// handler with a synthesised one-item suspects[] payload. Renders the
// returned cards + transactions in a compact card-grouped table.
//
// Why reuse appriss_lookup: it already handles Secure auth top-up, the
// surname summary call, the per-card detail calls + retries on Secure's
// async backend, and the same dedup/match heuristics that the in-shell
// AurorBuddy scan uses. A bespoke direct call here would diverge over
// time; passing through the SW handler keeps the two surfaces consistent.

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const NAME = (params.get("name") || "").trim();
const ID   = (params.get("id") || "").trim();

// Default store: read from livedashboard's settings if present (the dashboard
// asks the user for a store on first run, so this is usually populated).
async function defaultStore() {
  try {
    const got = await chrome.storage.sync.get("livedashboard.settings");
    const s = got?.["livedashboard.settings"]?.storeNbr;
    if (s) return String(s).replace(/\D/g, "");
  } catch { /* ignore */ }
  return "";
}

function splitName(full) {
  const tokens = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { first: "", last: "" };
  if (tokens.length === 1) return { first: "", last: tokens[0] };
  return { first: tokens.slice(0, -1).join(" "), last: tokens[tokens.length - 1] };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtAmount(a) { return String(a ?? ""); }
function fmtDateTime(dt) { return String(dt ?? ""); }

function setStatus(msg, isErr = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", !!isErr);
}

function renderHeader() {
  $("who-name").textContent = NAME || "Unknown person";
  $("who-id").textContent   = ID ? `p${ID.replace(/^p/i, "")}` : "";
  document.title = `Secure — ${NAME || "Unknown"}`;
}

function renderSuspect(suspect, homeStore, name) {
  const root = $("results");
  if (!suspect || !(suspect.appriss_cards?.length)) {
    root.innerHTML = `<div class="empty">No Secure cards found for <strong>${escapeHtml(name)}</strong> at store ${escapeHtml(homeStore)}.</div>`;
    return;
  }
  const cardsHtml = suspect.appriss_cards.map((card) => {
    const txns = (card.transactions || []).slice().sort((a, b) =>
      String(b.datetime || "").localeCompare(String(a.datetime || "")));
    const txnRows = txns.length
      ? txns.map((t) => {
          const home = String(t.store) === String(homeStore);
          const ccLink = t.cctv_url ? `<a href="${escapeHtml(t.cctv_url)}" target="_blank" rel="noopener">CCTV</a>` : "";
          const rcLink = t.receipt_url ? `<a href="${escapeHtml(t.receipt_url)}" target="_blank" rel="noopener">Receipt</a>` : "";
          const links  = [ccLink, rcLink].filter(Boolean).join(" · ");
          return `
            <tr class="${home ? "at-home" : ""}">
              <td class="dt">${escapeHtml(fmtDateTime(t.datetime))}</td>
              <td>${escapeHtml(t.store || "")}${home ? '<span class="pill home">home</span>' : ""}</td>
              <td>${escapeHtml(t.register || "")}</td>
              <td>${escapeHtml(t.cashier || "")}</td>
              <td>${escapeHtml(t.trans_no || "")}</td>
              <td class="amt">$${escapeHtml(fmtAmount(t.amount))}</td>
              <td>${links}</td>
            </tr>`;
        }).join("")
      : `<tr><td colspan="7" class="empty">No transactions returned for this card.</td></tr>`;
    return `
      <div class="card">
        <div class="ch">
          <div class="holder">${escapeHtml(card.name || "—")}</div>
          <div class="masked">${escapeHtml(card.card_masked || (card.last4 ? `••••${card.last4}` : ""))}</div>
        </div>
        <table class="txns">
          <thead>
            <tr><th>Date / time</th><th>Store</th><th>Reg</th><th>Cashier</th><th>Trans #</th><th>Amount</th><th></th></tr>
          </thead>
          <tbody>${txnRows}</tbody>
        </table>
      </div>`;
  }).join("");
  root.innerHTML = cardsHtml;
}

async function runLookup(name, homeStore) {
  name = (name || "").trim();
  if (!name) {
    setStatus("Enter a name and click Search.", true);
    $("name-input")?.focus();
    return;
  }
  if (!homeStore) {
    setStatus("Set a home store number above and click Search.", true);
    return;
  }
  const { first, last } = splitName(name);
  if (!last) {
    setStatus(`Couldn't extract a surname from "${name}".`, true);
    return;
  }
  const suspect = {
    person_id:  ID || "",
    name:       name,
    first_name: first,
    last_name:  last,
    photo_url:  "",
    auror_url:  ID ? `https://app.us.auror.co/person/${ID}` : "",
  };
  $("search-btn").disabled = true;
  setStatus(`Searching Secure for "${name}" at store ${homeStore}…`);
  $("results").innerHTML = "";
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      module:    "aurorbuddy",
      type:      "appriss_lookup",
      suspects:  [suspect],
      homeStore: String(homeStore),
    });
  } catch (e) {
    setStatus(`Lookup failed: ${e?.message || e}`, true);
    $("search-btn").disabled = false;
    return;
  } finally {
    $("search-btn").disabled = false;
  }
  if (!resp?.ok) {
    setStatus(`Secure lookup error: ${resp?.error || "unknown"}`, true);
    return;
  }
  const matched = resp.matched || [];
  const errors  = resp.errors  || [];
  const errLine = errors.length ? ` · ${errors.length} error(s)` : "";
  setStatus(`Secure matched ${matched.length} / 1 for "${name}" at store ${homeStore}.${errLine}`);
  renderSuspect(matched[0], homeStore, name);
}

(async function init() {
  renderHeader();
  const def = await defaultStore();
  $("store-input").value = def;
  $("name-input").value  = NAME;
  const currentName = () => $("name-input").value.trim();
  const currentStore = () => $("store-input").value.trim();
  $("search-btn").addEventListener("click", () => runLookup(currentName(), currentStore()));
  const onEnter = (ev) => { if (ev.key === "Enter") runLookup(currentName(), currentStore()); };
  $("store-input").addEventListener("keydown", onEnter);
  $("name-input").addEventListener("keydown", onEnter);
  // Auto-run only if we already have name + store; otherwise prompt.
  if (def && NAME) {
    runLookup(NAME, def);
  } else if (!NAME) {
    setStatus("Auror has no name on file for this person. Type a name above and click Search.");
    $("name-input").focus();
  } else {
    setStatus("Enter your home store and click Search.");
  }
})();
