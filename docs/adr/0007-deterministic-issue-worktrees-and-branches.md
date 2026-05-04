# Deterministic issue worktrees and branches

Symphonika will create deterministic Git worktrees and issue branches before launching a coding agent. This gives each run a predictable filesystem and Git identity for recovery, stale-claim inspection, cleanup, and PR linkage, instead of relying on each agent provider or workflow prompt to invent branch names independently.

Superseded in part by ADR-0044: the workspace mechanism is now a per-issue shared clone rather than a worktree; deterministic branch and path semantics carry over.
