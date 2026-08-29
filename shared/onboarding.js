// shared/onboarding.js
//
// First-run setup: ask for role, store and market once, then point out the
// three things about the shell nobody discovers on their own.
//
// WHY IT EXISTS. Role, market and store already drive real behaviour —
// VizPick follows the home market, LiveDashboard and ClaimsDisposition seed
// from the home store, and the home-header strip is role-gated. Until now the
// only way to set them was Settings → Defaults, which a new analyst has no
// reason to visit. So the common first experience was a suite quietly
// defaulting to somebody else's store, which looks like the tools being wrong
// rather than unconfigured.
//
// COMPLETION LIVES IN SYNC STORAGE. It follows the person, not the machine:
// someone who reinstalls, or signs in on a second PC, has already answered
// these questions and being asked again reads as the tool forgetting them.
// The cost is that it cannot be re-triggered by clearing local state, which
// is exactly why resetOnboarding() and the #/setup route exist.
//
// No inline scripts and no innerHTML with interpolated values: MV3's default
// script-src blocks inline script suite-wide (see CURRENT_TASKS.md), and every
// value here is user-entered.

import { USER_ROLES, isValidRole,
         setUserRole, setUserHomeMarket, setUserHomeStoreOverride,
         getUserRole, getUserHomeMarket, getUserHomeStore } from "./userStore.js";

const DONE_KEY = "apai.onboardingCompletedAt";
const TIPS_KEY = "apai.onboardingTipsSeenAt";

// ── State ─────────────────────────────────────────────────────────────────

export async function needsOnboarding() {
  try {
    const got = await chrome.storage.sync.get(DONE_KEY);
    return !got[DONE_KEY];
  } catch {
    // Storage unavailable is not a reason to shove a wizard in someone's face
    // on every load; failing closed keeps the suite usable.
    return false;
  }
}

export async function completeOnboarding() {
  try { await chrome.storage.sync.set({ [DONE_KEY]: new Date().toISOString() }); } catch {}
}

export async function markTipsSeen() {
  try { await chrome.storage.sync.set({ [TIPS_KEY]: new Date().toISOString() }); } catch {}
}

/** Forget everything, so the next load runs setup again. Used by #/setup and Settings. */
export async function resetOnboarding() {
  try { await chrome.storage.sync.remove([DONE_KEY, TIPS_KEY]); } catch {}
}

// ── Small DOM helpers ─────────────────────────────────────────────────────

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) node.appendChild(kid);
  return node;
}

const digitsOnly = (s) => /^\d+$/.test(String(s ?? "").trim());

// ── Setup wizard ──────────────────────────────────────────────────────────

/**
 * Show the wizard. Resolves when it closes — true if completed, false if
 * skipped. Skipping still marks it done: asking again next load would make
 * "Skip" mean "ask me every time", which is not what anybody presses it for.
 */
export function runSetup({ force = false } = {}) {
  return new Promise((resolve) => {
    const state = { role: null, store: "", market: "" };

    const backdrop = el("div", { class: "ob-backdrop", role: "dialog", "aria-modal": "true",
                                 "aria-labelledby": "ob-title" });
    const card = el("div", { class: "ob-card" });
    backdrop.appendChild(card);

    const close = (completed) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(completed);
    };
    // Escape skips rather than traps. A setup dialog that cannot be dismissed
    // is the kind of thing people uninstall over.
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); skip(); } };
    document.addEventListener("keydown", onKey, true);

    async function skip() { await completeOnboarding(); close(false); }

    async function finish() {
      if (state.role)   await setUserRole(state.role);
      if (state.store)  await setUserHomeStoreOverride(state.store);
      if (state.market) await setUserHomeMarket(state.market);
      await completeOnboarding();
      close(true);
    }

    // ── Step 1: role ──────────────────────────────────────────────────────
    function stepRole() {
      card.replaceChildren();
      card.append(
        el("p", { class: "ob-step", text: "Step 1 of 3" }),
        el("h2", { id: "ob-title", text: "Welcome to APAISuite" }),
        el("p", { class: "ob-lead",
                  text: "Three quick questions so the tools open on your stores instead of somebody else's. You can change any of it later in Settings." }),
        el("p", { class: "ob-label", text: "Which best describes your role?" }),
      );

      const list = el("div", { class: "ob-choices" });
      for (const r of USER_ROLES) {
        const btn = el("button", {
          type: "button",
          class: "ob-choice" + (state.role === r.value ? " is-selected" : ""),
          onclick: () => { state.role = r.value; stepRole(); },
        },
          el("span", { class: "ob-choice-label", text: r.label }),
          el("span", { class: "ob-choice-hint",  text: r.hint }),
        );
        list.appendChild(btn);
      }
      card.appendChild(list);
      card.appendChild(actions({ next: stepStore, nextEnabled: !!state.role }));
    }

    // ── Step 2: store ─────────────────────────────────────────────────────
    function stepStore() {
      card.replaceChildren();
      const input = el("input", {
        type: "text", inputmode: "numeric", class: "ob-input",
        placeholder: "e.g. 1458", value: state.store, "aria-label": "Home store number",
      });
      const err = el("p", { class: "ob-error", hidden: "hidden" });

      card.append(
        el("p", { class: "ob-step", text: "Step 2 of 3" }),
        el("h2", { id: "ob-title", text: "Your home store" }),
        el("p", { class: "ob-lead",
                  text: "Used to highlight your store in market views and to seed the dashboards. Digits only, no leading zeros." }),
        input, err,
      );

      const next = () => {
        const v = input.value.trim();
        if (v && !digitsOnly(v)) {
          err.textContent = "Store number must be digits only.";
          err.hidden = false;
          return;
        }
        state.store = v;
        stepMarket();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") next(); });
      card.appendChild(actions({ back: stepRole, next, nextEnabled: true }));
      input.focus();
    }

    // ── Step 3: market ────────────────────────────────────────────────────
    function stepMarket() {
      card.replaceChildren();
      const input = el("input", {
        type: "text", inputmode: "numeric", class: "ob-input",
        placeholder: "e.g. 120", value: state.market, "aria-label": "Home market number",
      });
      const err = el("p", { class: "ob-error", hidden: "hidden" });

      card.append(
        el("p", { class: "ob-step", text: "Step 3 of 3" }),
        el("h2", { id: "ob-title", text: "Your market" }),
        el("p", { class: "ob-lead",
                  text: "VizPick and the market rollups follow this. Leaving it blank is fine — those modules simply will not refresh on their own until it is set." }),
        input, err,
      );

      const next = () => {
        const v = input.value.trim();
        if (v && !digitsOnly(v)) {
          err.textContent = "Market number must be digits only.";
          err.hidden = false;
          return;
        }
        state.market = v;
        finish();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") next(); });
      card.appendChild(actions({ back: stepStore, next, nextLabel: "Finish", nextEnabled: true }));
      input.focus();
    }

    function actions({ back, next, nextLabel = "Next", nextEnabled = true }) {
      const row = el("div", { class: "ob-actions" });
      row.appendChild(el("button", { type: "button", class: "ob-skip", text: "Skip setup", onclick: skip }));
      row.appendChild(el("span", { class: "ob-spacer" }));
      if (back) row.appendChild(el("button", { type: "button", class: "ob-btn ob-btn-ghost", text: "Back", onclick: back }));
      const nextBtn = el("button", { type: "button", class: "ob-btn", text: nextLabel, onclick: next });
      if (!nextEnabled) nextBtn.disabled = true;
      row.appendChild(nextBtn);
      return row;
    }

    // Prefill from whatever is already known. getUserHomeStore() derives the
    // store from the cached Auror JWT, so for most people step 2 is already
    // answered and just needs confirming.
    Promise.allSettled([getUserRole(), getUserHomeStore(), getUserHomeMarket()])
      .then(([role, store, market]) => {
        if (!force) {
          if (isValidRole(role.value)) state.role = role.value;
        }
        if (store.value)  state.store  = String(store.value);
        if (market.value) state.market = String(market.value);
      })
      .finally(() => {
        document.body.appendChild(backdrop);
        stepRole();
      });
  });
}

// ── Coach marks ───────────────────────────────────────────────────────────

const TIPS = [
  {
    selector: "#shell-nav",
    title: "Reorder your modules",
    body: "Drag any module in this list to move it. Put the ones you use daily at the top — the order is yours and it sticks.",
    place: "right",
  },
  {
    selector: "#shell-sidebar-toggle",
    title: "Collapse the sidebar",
    body: "Click here to shrink the nav to icons when you want more room. Your choice is remembered between sessions.",
    place: "right",
  },
  {
    selector: 'a[data-route="#/settings"]',
    title: "Everything is changeable",
    body: "Role, store, market and theme all live in Settings — along with a button to run this setup again.",
    place: "right",
  },
];

/** Show the floating tips in order. Resolves when dismissed or exhausted. */
export function runTips(tips = TIPS) {
  return new Promise((resolve) => {
    // Only tips whose target actually exists. A coach mark pointing at nothing
    // is worse than a missing one — it teaches a control that is not there.
    const live = tips.filter((t) => document.querySelector(t.selector));
    if (!live.length) { resolve(false); return; }

    let i = 0;
    const veil = el("div", { class: "ob-tip-veil" });
    const bubble = el("div", { class: "ob-tip", role: "dialog", "aria-live": "polite" });
    const ring = el("div", { class: "ob-tip-ring" });
    document.body.append(veil, ring, bubble);

    const done = async () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", onKey, true);
      veil.remove(); ring.remove(); bubble.remove();
      await markTipsSeen();
      resolve(true);
    };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); done(); } };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    veil.addEventListener("click", done);

    function place() {
      const t = live[i];
      const target = document.querySelector(t.selector);
      if (!target) { next(); return; }
      const r = target.getBoundingClientRect();

      ring.style.top    = `${r.top - 4}px`;
      ring.style.left   = `${r.left - 4}px`;
      ring.style.width  = `${r.width + 8}px`;
      ring.style.height = `${r.height + 8}px`;

      // Prefer the requested side, but never off-screen — the sidebar is
      // narrow and a bubble hanging off the left edge is unreadable.
      const gap = 14;
      let left = t.place === "right" ? r.right + gap : r.left;
      let top  = r.top;
      const bw = bubble.offsetWidth || 300;
      const bh = bubble.offsetHeight || 140;
      if (left + bw > window.innerWidth - 12) left = Math.max(12, r.left - bw - gap);
      if (top + bh > window.innerHeight - 12) top = Math.max(12, window.innerHeight - bh - 12);
      bubble.style.left = `${left}px`;
      bubble.style.top  = `${top}px`;
    }

    function next() {
      i += 1;
      if (i >= live.length) { done(); return; }
      render();
    }

    function render() {
      const t = live[i];
      bubble.replaceChildren(
        el("p", { class: "ob-tip-count", text: `Tip ${i + 1} of ${live.length}` }),
        el("h3", { class: "ob-tip-title", text: t.title }),
        el("p",  { class: "ob-tip-body",  text: t.body }),
        el("div", { class: "ob-tip-actions" },
          el("button", { type: "button", class: "ob-skip", text: "Dismiss", onclick: done }),
          el("button", { type: "button", class: "ob-btn",
                         text: i === live.length - 1 ? "Got it" : "Next", onclick: next }),
        ),
      );
      place();
    }

    render();
  });
}

/**
 * The whole first-run flow. Safe to call on every boot — it no-ops unless
 * setup has never been completed.
 */
export async function maybeRunOnboarding({ force = false } = {}) {
  if (!force && !(await needsOnboarding())) return false;
  await runSetup({ force });
  await runTips();
  return true;
}
