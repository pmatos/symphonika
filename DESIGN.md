<!-- SEED: re-run $impeccable document once there's code to capture the actual tokens and components. -->
---
name: Symphonika
description: Operator console for the Symphonika orchestrator daemon — terminal-native, mono-forward, system-adaptive light + dark.
---

# Design System: Symphonika

## 1. Overview

**Creative North Star: "The Calm Terminal"**

Symphonika's dashboard is an operator's console for a CLI daemon, so it should feel continuous
with that world — a refined terminal rather than a raw one. The anchor is the Charm / Bubble Tea
family of TUIs (gum, glow, soft-serve): monospace throughout, restrained color, generous spacing,
state that reads at a glance. Not htop's maximal density and not a web app wearing terminal
paint — a quiet, legible instrument you trust because it never dresses itself up.

The character is **structural, not chromatic**. It rhymes with the machine through fixed-width
type, aligned columns, hairline rules, and disciplined rhythm — never through a dark skin. That
is the point of shipping real light and dark themes: the terminal feel has to survive both. Color
is spent almost entirely on meaning. The amber / red / green Run-state triad is reserved for Run
state and nothing else; a single cool accent handles links, selection, and primary actions.
Everything else is neutral.

This system explicitly rejects the flashy SaaS marketing dashboard (no gradient KPI hero for run
counts, no glowing metric tiles), the heavy enterprise admin panel (no collapsible nav tree for
three pages, no corporate chrome), and the toy (no bubbly rounding, no emoji status, no
gamification). It is honest to its size: three pages and a handful of tables, dressed as exactly
that.

**Key Characteristics:**
- Mono-forward: monospace carries data, IDs, timestamps, labels, and most UI.
- Restrained color: one cool accent + a reserved amber/red/green state triad, over neutrals.
- Flat by default: depth from tonal layering and hairline borders, not shadow.
- System-adaptive: real light and dark themes, each tuned on its own terms.
- Motion only conveys state; no entrance choreography.
- Legible cold to a first-time self-hoster, dense enough for a daily operator.

## 2. Colors

A near-neutral surface where the only saturated color carries meaning — Run state or a single
cool accent. Palette expressed in OKLCH; exact values resolved during implementation.

### Primary
- **Cool Accent** (cool cyan/blue family — *exact value to be resolved during implementation*):
  links, current selection, focus rings, and the primary action (e.g. Cancel run). Deliberately
  **not** green or amber, so it never competes with the Run-state triad. Product-register accent:
  actions and selection only, never decoration.

### Neutral
- **Surface / Ink ramp** (near-neutral, faintly cool-tinted toward the accent hue —
  *values to be resolved during implementation*): page background, a second slightly-shifted layer
  for the header/nav, body ink, table hairlines, and dividers. Body ink holds ≥4.5:1 against its
  surface in both themes.

### Semantic — Run state (reserved)
- **Amber family** — in-progress states: `queued`, `preparing_workspace`, `running`,
  `input_required`.
- **Red family** — failure states: `failed`, `cancelled`, `stale`.
- **Green family** — success: `succeeded`.

*(These map the current `state-*` classes in `src/http/pages.ts`. Exact tokens resolve at
implementation; each must clear contrast in both light and dark.)*

### Named Rules
**The Reserved-Signal Rule.** Amber, red, and green belong to Run state and nothing else. The
accent never borrows those hues; decoration never borrows any of them. If a color appears, it
means something.

**The One-Accent Rule.** Exactly one cool accent, on ≤10% of any screen. Its rarity is what makes
selection and primary actions obvious.

## 3. Typography

**Display Font:** *[monospace family to be chosen at implementation]*
**Body Font:** *[same monospace; a clean sans reserved for long prose only, to be chosen at implementation]*

**Character:** Mono-forward. A single well-tuned monospace carries data, run IDs, timestamps,
labels, and most UI chrome; the fixed-width grid *is* the terminal character. A neutral sans is
the exception, used only where genuine running prose appears (empty-state guidance, longer
descriptions). Fixed rem scale, not fluid `clamp()` — this is product UI viewed at consistent DPI.
Tight scale ratio (~1.125–1.2), since there are many type elements and exaggerated contrast would
read as noise.

### Hierarchy
- **Display** (mono, largest step): page/run title only — e.g. "Symphonika", "Run <id>".
- **Headline** (mono, section step): section headers — Projects, Routines, Recent runs.
- **Title** (mono, emphasized): table captions, run-summary field emphasis.
- **Body** (mono): table cells, field values, run IDs, branch names. Sans for prose, capped
  65–75ch; dense tabular data may run wider.
- **Label** (mono, small): column headers, state text, metadata keys. State text always
  accompanies the state color — never color alone.

### Named Rules
**The Monospace-First Rule.** Data, IDs, timestamps, and state read in monospace by default. Reach
for the sans only when the content is genuine prose. Fixed-width alignment is the whole aesthetic;
don't trade it away for a "friendlier" proportional face.

## 4. Elevation

Flat by default. Motion and depth are both restrained: surfaces sit at rest with no drop shadows.
Depth is conveyed through **tonal layering** (the header/nav on a slightly shifted neutral from the
content surface) and **hairline borders** (1px table rules and dividers), not elevation. Any shadow
that appears later should be a response to state (focus, an open dialog), never ambient decoration.

### Named Rules
**The Flat Rule.** Surfaces are flat. If depth is needed, shift the tone or add a hairline — do not
reach for a shadow. Never pair a 1px border with a soft wide drop shadow on the same element.

## 5. Components

*No target components are specified yet — this is a seed. The redesign will define them, and a
scan-mode `$impeccable document` re-run will capture their real tokens and states.* The canonical
primitives this surface needs, to be specified then:

- **Data tables** (Projects, Routines, Stale issues, Runs, Attempts, Transitions, Events): the
  core affordance. Legible tables differentiated by content — never flattened into a card grid.
- **Run-state pill / label**: monospace state text + reserved state color, together, with
  contrast in both themes.
- **Navigation**: a single flat top bar (Dashboard · Runs). No nav tree.
- **Run summary**: a definition-list of run fields (project, issue, state, provider, branch,
  workspace, terminal reason, cap context).
- **Empty states**: teach the domain on first read ("No runs yet" explains what a Run is / how one
  starts), not a bare "nothing here."
- **Actions**: the Cancel-run control — a single restrained button in the accent, with hover /
  focus-visible / disabled states.

### Named Rules
**The Table-Not-Card Rule.** Tabular data stays a table. The Projects / Routines / Runs surfaces
are never reworked into identical icon-heading-text cards.

## 6. Do's and Don'ts

### Do:
- **Do** carry every Run state as monospace text *and* color together; state must be readable
  without relying on hue (color vision deficiency, and honest to the CLI it mirrors).
- **Do** keep the accent cool (cyan/blue) and reserve amber / red / green strictly for Run state.
- **Do** use a fixed rem type scale, mono-forward; no fluid `clamp()` headings in product UI.
- **Do** keep surfaces flat — convey depth with tonal layering and hairline borders.
- **Do** ship real light and dark themes via `prefers-color-scheme`, each tuned on its own terms,
  and make the terminal character hold in light mode.
- **Do** write empty states that teach the domain (Runs, Routines, Reservations, terminal reasons).
- **Do** keep motion to state changes only (150–250 ms) with a `prefers-reduced-motion` fallback.

### Don't:
- **Don't** build a flashy SaaS marketing dashboard: no gradient KPI hero for run/issue counts, no
  glowing big-number tiles, no decorative accent glow. The hero-metric template is forbidden.
- **Don't** build a heavy enterprise admin panel: no collapsible multi-level nav tree for what is
  three pages, no corporate toolbar chrome, no settings sprawl.
- **Don't** go toy / playful: no bubbly oversized rounding, no emoji status glyphs, no gamified
  progress. This monitors autonomous agents doing real work against real repos.
- **Don't** flatten the Projects / Routines / Runs tables into an identical icon-heading-text card
  grid.
- **Don't** lean on a dark skin to feel terminal-native — the character is structural and must
  survive light mode.
- **Don't** use green or amber as a brand or accent color; they are reserved Run-state signals.
- **Don't** use side-stripe borders (`border-left`/`right` > 1px as an accent), gradient text, or
  glassmorphism; and never round cards past 12–16px.
