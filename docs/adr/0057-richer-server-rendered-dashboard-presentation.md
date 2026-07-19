# Richer server-rendered dashboard presentation is v1 scope

The built-in web dashboard is the Bootstrap Slice's everyday observability surface, not an optional product shell. PR #241 established a cohesive terminal-native design system for that surface: system-adaptive light and dark themes, responsive layouts, semantic state styling, a self-hosted webfont pipeline, and product and design-system contracts in `PRODUCT.md` and `DESIGN.md`. The old `SPEC.md` §16 entry deferring "richer UI" was broad enough to exclude this shipped presentation work, while ADR-0010 still described the pages as "lightweight." Leaving those statements in place made the implementation contract contradict the accepted dashboard.

Richer presentation of the existing server-rendered operator pages is part of v1. The dashboard may use shared design tokens and components, bundled visual assets and fonts, responsive CSS, system-adaptive themes, restrained state animation, and accessibility work when they make Run Store evidence easier to scan and understand. `PRODUCT.md` and `DESIGN.md` define the current product and visual constraints; additions must remain proportionate to the focused operator surface rather than introducing unrelated application structure.

This presentation scope does not authorize a standalone frontend application, a client build pipeline, client-side routing, or a persistent client state layer. The server continues to produce the operator pages and their data. Client-side interactive evidence views remain governed separately by ADR-0056. Richer presentation also adds no browser mutation: active-run cancellation and manual poll-now remain the only mutating web actions, with all other operational mutations kept on the CLI under ADR-0027.

This decision amends ADR-0010 only by retiring its "lightweight" presentation qualifier; ADR-0010's server-rendered, no-separate-frontend posture remains in force. It leaves ADR-0027 unchanged and explicitly separates visual richness from operational capability. `SPEC.md` §14 now records the richer dashboard presentation within the Bootstrap Slice, and §16 no longer defers it. Any future expansion into a standalone frontend or additional web mutations requires its own scope decision.

The consequence is a larger CSS and asset maintenance surface inside the daemon. Dashboard changes must preserve semantic markup, keyboard access, contrast, reduced-motion behavior, self-contained font delivery, and the server-rendered architecture. Visual polish is in scope; a second application architecture is not.

## Numbering

ADR `0056` (embedded interactive operator visualizations) is the most recent number in tree; this ADR is `0057`.
