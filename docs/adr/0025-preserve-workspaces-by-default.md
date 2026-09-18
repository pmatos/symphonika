# Preserve workspaces by default

Symphonika v1 will not delete issue workspaces automatically. Full-permission agents can leave important implementation or forensic state in a workspace, so cleanup should be an explicit operator action through future CLI or UI commands rather than a background side effect of issue closure, failure, or Project removal.

ADR 0067 narrows this decision for terminal Routine Firing workspaces: outcome-aware,
service-configured age retention reclaims their registered worktrees after a forensic window while
preserving Run Store and state-root evidence. ADR 2026-09-18-0702 narrows it the same way for
terminal Issue Workspaces, with the branch ref itself left unreclaimed pending a future
publication-aware policy. Both narrowings apply only after their configured retention window; this
ADR continues to govern immediate lifecycle behavior and every workspace not yet past that window.
