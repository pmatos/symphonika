# Reuse issue workspaces across attempts

Symphonika will reuse the same deterministic issue branch and worktree across retries and continuations until explicit cleanup. Dirty worktrees are expected, branch conflicts are surfaced rather than auto-reset, and the rendered prompt tells the coding agent when it is entering a workspace from a previous attempt so it can inspect and continue from existing state.
