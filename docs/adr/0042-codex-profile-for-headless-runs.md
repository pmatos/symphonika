# Codex profile for headless runs

Symphonika defaults the Codex provider command to `codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server` so that headless runs use a named profile in `~/.codex/config.toml` instead of the operator's interactive defaults. The profile must disable `memories` so the Codex memory-writing pipeline does not auto-inject a "Memory Writing Agent: Phase 2 (Consolidation)" turn after the assigned task; in run `1847a667-32b9-4aa2-a725-cb45e67f7c3a` that turn caused the agent to abandon issue #43 mid-implementation and rewrite `~/.codex/memories/MEMORY.md` instead, then exit cleanly. The profile should also disable `codex_hooks` (so operator lifecycle hooks do not fire on every Symphonika run), `image_generation`, and `analytics`, but **must keep `multi_agent = true`** so autonomous workers may still fan out to subagents when the task warrants it. Codex profiles cannot override `[plugins."…"]`, `[hooks]`, `[mcp_servers]`, `[skills]`, or the top-level `[memories]` subsystem table — a profile alone is therefore not full isolation; operators who need to fence Symphonika away from those should set a Symphonika-specific `CODEX_HOME` instead. The `doctor` command probes profile existence by running `codex -p <profile> features list` and surfaces the required `[profiles.<name>]` TOML snippet when the profile is missing, so operators upgrading past this default get an actionable error rather than a generic exit-code failure.

The minimum profile to paste into `~/.codex/config.toml`:

```toml
[profiles.symphonika]
analytics = { enabled = false }

[profiles.symphonika.features]
memories         = false
multi_agent      = true
codex_hooks      = false
image_generation = false
```
