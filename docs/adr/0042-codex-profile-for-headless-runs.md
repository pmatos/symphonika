# Codex profile for headless runs

Symphonika defaults the Codex provider command to `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server` so that headless runs use a named profile in `~/.codex/config.toml` instead of the operator's interactive defaults while still forcing full-permission app-server threads at process startup. Codex CLI 0.128.0 does not apply `--dangerously-bypass-approvals-and-sandbox` to new app-server threads by itself; Symphonika therefore sends `sandbox: "danger-full-access"` in `thread/start`, keeps `sandbox_mode = "danger-full-access"` and `approval_policy = "never"` in the profile contract, and repeats both settings with `-c` overrides in the default command. The profile must disable `memories` so the Codex memory-writing pipeline does not auto-inject a "Memory Writing Agent: Phase 2 (Consolidation)" turn after the assigned task; in run `1847a667-32b9-4aa2-a725-cb45e67f7c3a` that turn caused the agent to abandon issue #43 mid-implementation and rewrite `~/.codex/memories/MEMORY.md` instead, then exit cleanly. The profile should also disable `codex_hooks` (so operator lifecycle hooks do not fire on every Symphonika run), `image_generation`, and `analytics`, but **must keep `multi_agent = true`** so autonomous workers may still fan out to subagents when the task warrants it. Codex profiles cannot override `[plugins."…"]`, `[hooks]`, `[mcp_servers]`, `[skills]`, or the top-level `[memories]` subsystem table — a profile alone is therefore not full isolation; operators who need to fence Symphonika away from those should set a Symphonika-specific `CODEX_HOME` instead. The `doctor` command probes profile existence by running `codex -p <profile> features list` and then probes the actual app-server sandbox with `thread/start` plus `command/exec`, so operators upgrading past this default get actionable errors rather than a generic exit-code failure.

The app-server runtime sandbox probe uses the Node executable already running Symphonika for the `api.github.com` HEAD check instead of requiring `curl`, and its `command/exec` request has a dedicated timeout. Operators may override that runtime-network timeout with `SYMPHONIKA_CODEX_RUNTIME_PROBE_TIMEOUT_MS`; the faster profile/help probe timeout remains controlled by `SYMPHONIKA_CODEX_PROBE_TIMEOUT_MS`.

The minimum profile to paste into `~/.codex/config.toml`:

```toml
[profiles.symphonika]
analytics = { enabled = false }
sandbox_mode = "danger-full-access"
approval_policy = "never"

[profiles.symphonika.features]
memories         = false
multi_agent      = true
codex_hooks      = false
image_generation = false
```
