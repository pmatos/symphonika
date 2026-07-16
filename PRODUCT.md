# Product

## Register

product

## Users

Primary audience: **OSS self-hosters** — developers who cloned and installed Symphonika
and run it as a long-lived daemon (a systemd user service) against their own GitHub repos.
The surface in question is the daemon's built-in web dashboard (`/`, `/runs`, `/runs/:id`),
its observability window into an orchestrator that autonomously dispatches eligible issues to
Codex or Claude coding agents.

Context of use: at a desktop browser, glancing at the dashboard while the daemon works in the
background. The job to be done is answering, quickly: what is eligible, which Projects and
Routines are active, which Runs are in flight, and — when something goes wrong — why a Run
reached a terminal state (failed, stale, cancelled, cap-reached, no-progress). Operators then
drill into a Run's durable evidence: attempts, state transitions, provider events, artifacts,
and the expanded workflow graph.

These are expert users, but they routinely meet *this specific dashboard* cold — a first-time
self-hoster seeing it with no prior tour. The interface must read on first contact without
thinning the data a daily operator relies on.

## Product Purpose

Symphonika turns eligible GitHub issues into autonomous coding-agent runs; this dashboard is
its observability surface. It exists to give the operator trustworthy, at-a-glance visibility
into the orchestrator's decisions and its durable Run Store evidence — without dropping to the
SQLite database or log files. Success is when an operator can answer **"is it working, and if
not, why?"** directly from the dashboard.

## Brand Personality

Precise, calm, transparent. The voice is operator-to-operator: plain, exact, unhurried, and
respectful of the reader's expertise. The emotional goal is quiet confidence — the feeling of
a well-instrumented control surface, an extension of the CLI daemon behind it, not a product
being marketed to you.

## Anti-references

Concrete patterns this must **not** become:

- **Flashy SaaS marketing dashboard.** No gradient KPI hero for run/issue counts, no glowing
  big-number tiles, no decorative accent glow. A "runs today" counter is exactly where the
  banned hero-metric template creeps in — refuse it.
- **Heavy enterprise admin panel.** No collapsible multi-level nav tree for what is three
  pages, no corporate toolbar chrome, no settings sprawl. Match the chrome to the surface.
- **Toy / playful.** No bubbly oversized rounding, no emoji status glyphs, no gamified
  progress. This monitors autonomous agents doing real work against real repos.
- **Card-grid reflex.** The parallel Projects / Routines / Runs surfaces are tabular data;
  do not flatten them into an identical icon-heading-text card grid. Keep them legible tables,
  differentiated by their content, not by decoration.

## Design Principles

1. **The tool disappears into the task.** State carries the meaning; chrome recedes. An
   operator reads Run health at a glance and never fights the interface to find what failed.
2. **Rhyme with the machine it watches.** This is an operator's console for a CLI daemon, so
   it should feel continuous with that world — typographic discipline, density, and quiet
   restraint, not a web-app costume. That character is *structural*, so it must hold in both
   light and dark; it never depends on a dark skin to feel terminal-native.
3. **Legible cold, dense warm.** A first-time self-hoster meets it with zero context, yet a
   daily operator wants signal per pixel. Serve both: labels and empty states teach the domain
   (Runs, Routines, Reservations, terminal reasons) on first read, without diluting the data an
   expert depends on.
4. **Evidence over reassurance.** Symphonika's whole job is honest visibility into autonomous
   Runs. Show the real state — failed, stale, cap-reached, no-progress — plainly and
   specifically, never smoothed into a blanket green "all good." A debugging surface makes the
   failure path as first-class as the happy one.
5. **Honest to its size.** Three pages, a handful of tables. Don't dress a small, focused tool
   in the scaffolding of a large one. Ambition goes into precision and legibility, not into
   inventing structure the surface doesn't have.

## Accessibility & Inclusion

- **Real light and dark themes**, system-adaptive via `prefers-color-scheme`, each tuned on its
  own terms rather than one mechanically inverted from the other.
- **Contrast:** body text ≥4.5:1 against its background in both themes; state colors
  (queued / running / input_required, failed / cancelled / stale, succeeded) must clear contrast
  in both themes.
- **Never color-only state.** Pair every state color with its text label (as the current markup
  already does) so operators with color vision deficiency read Run state without relying on hue.
- **Reduced motion:** any motion added for state changes, feedback, or reveals must honor
  `prefers-reduced-motion: reduce` with a crossfade or instant fallback.
- **Semantic, keyboard-navigable markup.** The dashboard is server-rendered semantic HTML today;
  preserve that. Dense tables are the correct affordance for expert Run/event data — keep them
  scannable, don't trade legibility for decoration.
