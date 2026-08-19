# Design System

The shared visual language for APAISuite. Reconciles the three donors' palettes into one set of tokens, and standardizes on a small set of reusable components.

---

## Donor color comparison

| Token | AurorBuddy | ClosingList | SparkFraud | APAISuite (chosen) |
|---|---|---|---|---|
| Primary brand | `#1f6feb` (Auror blue) | `#0071CE` (Walmart blue) | `#0071dc` (Walmart blue) | `#0071CE` |
| Brand dark | `#1858c4` | `#004F9A` | `#005db0` | `#005AA8` |
| Brand darker / ink | `#0b4ea3` | `#041F41` | — | `#003E7A` |
| Accent yellow | `#ffc220` (Auror yellow) | `#FFC220` (Spark yellow) | — | `#FFC220` |
| Yellow dark | — | `#F5B800` | — | `#F5B800` |
| Success / green | `#16a34a` | `#1A5D2E` (text on `#E6F4EA`) | `#21a151` / `#1a7f37` | `#1A7F37` |
| Error / red | `#dc2626` | `#832222` (text on `#FDE8E8`) | `#cc3333` / `#b91c1c` | `#B91C1C` |
| Warn / amber | (red used) | (none) | `#d97706` | `#D97706` |
| Muted / slate | `#6b7280` | (varies) | `#6b7280` | `#6B7280` |
| Border | `#e5e7eb` | (varies) | `#e3e6ea` | `#E5E7EB` |
| Background | `#f3f4f6` | (varies) | `#f6f7f9` | `#F6F7F9` |
| Ink (body text) | `#1a1a1a` | `#1a1a1a` | `#1a1a1a` | `#1A1A1A` |

Three donors → one set. Walmart blue wins over Auror blue (used by 2 of 3 donors). Auror yellow ≈ Spark yellow ≈ `#FFC220` — same value, kept.

---

## Tokens

`styles/tokens.css` — the only file that defines color, spacing, and typography values. Everything else uses custom properties.

```css
:root {
  /* Color — brand */
  --apai-blue:        #0071CE;
  --apai-blue-dark:   #005AA8;
  --apai-blue-darker: #003E7A;
  --apai-yellow:      #FFC220;
  --apai-yellow-dark: #F5B800;

  /* Color — semantic */
  --apai-success:     #1A7F37;
  --apai-success-bg:  #E3F5E8;
  --apai-warn:        #D97706;
  --apai-warn-bg:     #FEF3C7;
  --apai-error:       #B91C1C;
  --apai-error-bg:    #FCEAEA;
  --apai-info:        #0071CE;
  --apai-info-bg:     #E8EEF9;

  /* Color — neutral */
  --apai-ink:         #1A1A1A;
  --apai-muted:       #6B7280;
  --apai-border:      #E5E7EB;
  --apai-bg:          #F6F7F9;
  --apai-bg-elev:     #FFFFFF;
  --apai-bg-soft:     #F9FAFB;

  /* Color — module accent (defaults to brand; overridden per-module) */
  --module-accent:        var(--apai-blue);
  --module-accent-dark:   var(--apai-blue-dark);
  --module-accent-darker: var(--apai-blue-darker);

  /* Spacing — 4px scale */
  --sp-0: 0;
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 20px;
  --sp-6: 24px;
  --sp-8: 32px;
  --sp-10: 40px;
  --sp-12: 48px;

  /* Radius */
  --rad-sm: 4px;
  --rad-md: 8px;
  --rad-lg: 12px;
  --rad-pill: 999px;

  /* Shadow */
  --shadow-1: 0 1px 2px rgba(0,0,0,0.04);
  --shadow-2: 0 4px 12px rgba(0,0,0,0.06);
  --shadow-3: 0 8px 24px rgba(0,0,0,0.08);

  /* Typography */
  --font-sans: 'Inter', 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
  --font-mono: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;

  --fs-xs:  11px;
  --fs-sm:  12px;
  --fs-md:  13px;
  --fs-base: 14px;
  --fs-lg:  16px;
  --fs-xl:  18px;
  --fs-2xl: 22px;

  --fw-regular: 400;
  --fw-medium:  500;
  --fw-semi:    600;
  --fw-bold:    700;

  --lh-tight: 1.25;
  --lh-base:  1.45;
  --lh-loose: 1.6;

  /* Motion */
  --duration-fast: 120ms;
  --duration-med:  200ms;
  --duration-slow: 300ms;
  --ease-out: cubic-bezier(0.2, 0.6, 0.2, 1);
}

/* Per-module accents — applied to .module-<id> root */
.module-aurorbuddy {
  --module-accent:        #FFC220;   /* Auror yellow */
  --module-accent-dark:   #F5B800;
  --module-accent-darker: #B7860E;
}
.module-closinglist {
  --module-accent:        var(--apai-blue);
  --module-accent-dark:   var(--apai-blue-dark);
  --module-accent-darker: var(--apai-blue-darker);
}
.module-sparkfraud {
  --module-accent:        var(--apai-blue);
  --module-accent-dark:   var(--apai-blue-dark);
  --module-accent-darker: var(--apai-blue-darker);
}
```

---

## Component inventory

### Buttons (`components.css::.btn`)

```html
<button class="btn btn-primary">Search</button>
<button class="btn btn-secondary">Cancel</button>
<button class="btn btn-ghost">Reset</button>
<button class="btn btn-danger">Delete</button>
<button class="btn btn-icon"><svg/></button>

<button class="btn btn-primary btn-pill">Find candidates</button>  <!-- rounded -->
<button class="btn btn-primary" disabled>Loading…</button>
<button class="btn btn-primary btn-sm">Small</button>
```

- Primary uses `--module-accent` background → modules pick their own accent
- Pill variant matches the rounded style used by all 3 donors

### Status pills / badges (`components.css::.pill`, `.badge`)

```html
<span class="pill pill-checking">Auror: checking…</span>
<span class="pill pill-ok">Auror: ok</span>
<span class="pill pill-fail">Secure: fail</span>

<span class="badge badge-success">VERIFIED</span>
<span class="badge badge-warn">LIKELY</span>
<span class="badge badge-muted">POSSIBLE</span>
<span class="badge badge-neutral">UNKNOWN</span>
<span class="badge badge-danger">CONFLICTING</span>
<span class="badge badge-home">HOME</span>
```

Confidence semantics borrowed from SparkFraud — these labels mean **lead quality only, never proof or guilt**. Documented in tooltips on hover.

### Status strip (`components.css::.status-strip`)

```html
<div class="status-strip">No results yet</div>
<div class="status-strip status-strip-ok">Collected 12 associates</div>
<div class="status-strip status-strip-error">IVR session timed out</div>
```

Left-border colored, light tinted background. Pattern lifted from ClosingList.

### Cards (`components.css::.card`)

```html
<section class="card">
  <h2 class="card-title"><span class="card-step">1</span> Configure</h2>
  <div class="card-body">...</div>
</section>
```

Plus `.card-block` (nested compact card, e.g., per-payment-card slabs in AurorBuddy results).

### Data tables (`components.css::.data-table`)

```html
<table class="data-table">
  <thead><tr><th>#</th><th>Name</th><th>Total</th></tr></thead>
  <tbody>
    <tr class="zebra"><td>1</td><td>...</td><td class="mono txt-right">$123.45</td></tr>
  </tbody>
</table>
```

Modifiers: `.data-table-compact`, `.data-table-bordered`. Generic enough for AurorBuddy suspects/txns, SparkFraud items, ClosingList previews.

### Form controls (`components.css::.field`, `.fieldset`)

```html
<label class="field">
  <span class="field-label">Home store #</span>
  <input type="text" class="input">
</label>

<fieldset class="fieldset">
  <legend>Delivery type</legend>
  <label class="check"><input type="checkbox"> Spark Shop &amp; Deliver</label>
</fieldset>

<div class="btn-group">
  <button class="btn-group-item is-active">30 days</button>
  <button class="btn-group-item">60 days</button>
</div>
```

### Modals / popovers (`components.css::.modal`)

```html
<dialog class="modal">
  <header class="modal-head">Title <button class="btn-icon">×</button></header>
  <div class="modal-body">...</div>
  <footer class="modal-foot"><button class="btn btn-secondary">Cancel</button><button class="btn btn-primary">Confirm</button></footer>
</dialog>
```

Uses native `<dialog>` element. Replaces AurorBuddy's `chrome.windows.create` popups where possible; for true OS-window popups (receipt viewer), continue using `chrome.windows.create`.

### Toasts (`components.css::.toast`)

For brief non-blocking messages. Stacks bottom-right.

### Spinners (`components.css::.spinner`)

```html
<span class="spinner"></span> Loading…
<span class="spinner spinner-lg"></span>
```

Lifted from SparkFraud.

### Progress bar (`components.css::.progress-bar`)

Two-layer text trick from AurorBuddy preserved — `--pct` custom property drives both fill width and white-text clip path.

```html
<div class="progress-bar" style="--pct:42%">
  <div class="progress-fill"></div>
  <span class="progress-text progress-text-empty">12 / 28 checked</span>
  <span class="progress-text progress-text-filled">12 / 28 checked</span>
</div>
```

### Search/filter bar (`components.css::.filter-bar`)

The compact horizontal toolbar pattern (filter inputs + primary action button), used by all three donors.

### Empty / loading / error states (`components.css::.state-empty`, `.state-loading`, `.state-error`)

```html
<div class="state-empty">No suspects matched.</div>
<div class="state-loading"><span class="spinner"></span> Searching Auror…</div>
<div class="state-error">Couldn't reach gscope — try Reset.</div>
```

---

## Layout

### Shell layout

`styles/layout.css`:
- `.shell` — full-viewport grid: header + (sidebar | viewport)
- `.shell-header` — 56px tall, brand on left, user pill on right
- `.shell-sidebar` — 220px wide, collapsible to 56px
- `.shell-viewport` — fluid, scrollable; `<main>` slot

### Module layout helpers

- `.stack`, `.cluster`, `.grid`, `.split` — basic flex/grid primitives. Optional — modules can use raw CSS too.

---

## Typography

- Body: 14px / 1.45 / Inter (or Segoe UI fallback — Walmart-managed Edge ships Segoe by default).
- Mono (numbers, IDs): SFMono-Regular / Consolas / Liberation Mono.
- Headings: `h1` 22px / 600, `h2` 18px / 600, `h3` 16px / 600. All `letter-spacing: -0.01em`.
- Numerals: `font-variant-numeric: tabular-nums` on `.mono` and `.txt-right` so totals align.

---

## Iconography

- SVG-only, inline.
- Single icon set — Heroicons (outline + solid) — chosen for ample coverage + open license.
- Module icons live in `modules/<slug>/icon.svg` (or `assets/icons/<slug>.svg`). 24×24 viewBox; uses `currentColor` so accent automatically flows.
- Spark / Walmart 6-petal yellow icon retained where used (header brand glyph).

---

## Accessibility baselines

- Color contrast ≥ 4.5:1 on body text; ≥ 3:1 on UI text (badge labels) — palette above meets both.
- Focus visible: 2px outline using `--module-accent`, inset by 1px on inputs. No `outline: none` without replacement.
- All buttons have accessible names (text or `aria-label`).
- Tables use `<th scope="col">` headers.

---

## Anti-patterns (do not do)

- ❌ Don't introduce a new color or font-size literal in a module. If you need one, add it to `tokens.css` first.
- ❌ Don't use Tailwind, Bootstrap, or any UI framework. Hand-written CSS only (matches all donor patterns; keeps the bundle tiny + CSP-clean).
- ❌ Don't use inline `style="..."` for anything beyond setting `--pct`-style custom properties. Class-based.
- ❌ Don't use `!important`.
- ❌ Don't ship a module-local copy of an existing component. Use the shared one and propose a variant if it doesn't fit.

---

## How a module overrides

Need a module-local tweak? Three options, in order of preference:

1. **Use `--module-accent`** — covers 80% of brand-color overrides
2. **Add a class variant under `.module-<id>`** in the module's `styles.css`
3. **Propose a new shared component variant** — open an issue against `DESIGN_SYSTEM.md`, add the variant to `components.css`, document here

Modules must not redefine `--apai-*` tokens. They may set new `--module-*` tokens locally.


---

## Dark theme — Foundry

The dark theme uses the **Foundry** palette, from `Synaptikk/Foundry`
(`docs/design/FOUNDRY_GUI_STYLE_GUIDE.md` + `desktop/renderer/tokens.css`,
themselves derived from `Foundry_Brand_Brief.pdf`, July 2026, page 4). The
light theme keeps the Walmart-blue palette described above — Foundry is a dark
system by design and does not have a light counterpart.

| Name | Hex | Role here |
|---|---|---|
| Forge Black | `#111820` | `--apai-bg`; the two raised tiers mix Workshop White into it |
| Molten Ember | `#FF7A1A` | `--apai-link`, `--module-accent`, `--apai-error` — the single action accent |
| Heat Gold | `#F5B642` | `--apai-warn`, `--apai-info`, AurorBuddy's accent |
| Steel | `#63717C` | rules, `--apai-muted`/`--apai-ink-soft` mixes, `--apai-success` |
| Workshop White | `#F7F8F6` | `--apai-ink`, `--apai-heading` |

Every other dark value is a `color-mix()` against Forge Black or Workshop
White. No arbitrary greys, per the brief.

### Two deliberate deviations

**Success is Steel, not Heat Gold.** The brief maps "positive" to Heat Gold —
the same hue as warning. This suite is a triage tool, and "posted" reading
identically to "needs attention" costs more than palette purity buys. Steel is
the brief's own neutral and reads as "done, nothing to do", so the five-colour
rule still holds; no sixth hue was introduced.

**Headings are Workshop White, not ember.** `--apai-heading` exists so headings
and actions can differ per theme. The brief reserves the ember hue for things
you can act on and gives headings a white treatment with an ember tick beneath,
so pointing section titles at the action colour would have inverted its most
identifiable mark. In the light theme both tokens are brand blue, preserving
the existing look.

### What the palette does not reach

`modules/vizpick/lib/charts.js` and `modules/metricshot/lib/render_card.js`
build SVG in JavaScript with their own hardcoded Walmart hexes. They are not
themed and do not follow Foundry:

- The **metric card** is correct as-is — it is posted into Workvivo, where
  Walmart colours are what the audience expects, and it renders on white
  regardless of the viewer's theme.
- The **VizPick gauges** do follow the app's theme visually and currently do
  not. They are the main visual of that module, so this is the obvious next
  step if Foundry should apply throughout.

### Enforcement

Foundry's own repo has a drift test refusing new hex literals outside
`tokens.css`. This repo has no equivalent yet; the closest thing is
`dev/audit-contrast.mjs`, which renders every module view plus Settings in both
themes and measures WCAG contrast for every visible text node. Both themes
currently report zero failures. Run it after any palette change:

    python3 -m http.server 8755 &
    node dev/audit-contrast.mjs           # dark
    node dev/audit-contrast.mjs --light   # light
