# Oh My Pi (omp) as a third Agent Provider

Status: Proposed

## Context

Symphonika v1 supports exactly two Agent Providers: Codex (JSON-RPC `app-server`) and Claude
(stream-json). The provider set is closed in code, not just by convention:

- `AgentProviderName = "codex" | "claude"` (`src/provider.ts`).
- `providerNameSchema = z.enum(["codex", "claude"])` in `src/dispatch.ts`, `src/doctor.ts`,
  `src/issue-polling.ts`, and `src/reload.ts`; the `providers:` config object hardcodes the two
  command keys.
- The `providers:` object parses with `.passthrough()`, so an extra `omp:` key is accepted but
  **inert**: `reload.ts` reads only `providers.codex` and `providers.claude`, no adapter is
  registered, and a Project declaring `agent.provider: omp` fails schema validation.

Operators also run Oh My Pi (`omp`) as a local coding harness alongside Codex and Claude, and
want Symphonika to dispatch it side-by-side with the existing providers. omp ships a documented headless host protocol that
fits the `AgentProvider` seam:

- `omp --mode rpc` speaks newline-delimited JSON over stdio: a `ready` handshake frame,
  id-correlated request/response, and a streamed `AgentSessionEvent` vocabulary (`agent_start`,
  `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`,
  `tool_execution_start`, `tool_execution_update`, `tool_execution_end`). `prompt` commands are
  acked immediately and completion is observed via `agent_end`; `abort` cancels; closing stdin
  exits the process with code 0.
- RPC mode resets workflow-altering user settings (todo, task, memory, advisor, async, bash
  auto-background) to deterministic built-in defaults and disables automatic title generation —
  the right posture for autonomous orchestrated runs.
- `omp --auto-approve` skips all tool-approval prompts, matching the full-permission execution
  posture of SPEC §11.3.

## Decision

Adopt omp as the third Agent Provider. This ADR records the decision and the integration shape;
implementation (adapter, schema, doctor, init, SPEC amendment) lands in follow-up slices. Until
then omp is documented but not dispatched.

### Protocol: omp RPC mode

The omp adapter speaks `omp --mode rpc` over stdio. Rejected alternatives:

- `omp acp` (Agent Client Protocol): a generic editor-facing protocol; using it would make
  Symphonika an ACP client and force mapping ACP session updates onto the normalized vocabulary
  instead of omp's native, richer `AgentSessionEvent` stream.
- `omp -p --mode json` (print mode): one-shot output without streaming turn/tool granularity or an
  in-band cancel path, so the Watchdog would lose its liveness signals and §12 cancellation would
  degrade to process kill only.

The adapter launches the command from the Workspace cwd (per SPEC §12 dispatch), delivers the
rendered prompt via a `prompt` RPC command (argv and `@file` are rejected in RPC mode and prompts
exceed safe argv length), streams stdout frames into raw + normalized logs, implements `cancel` as
an `abort` RPC command followed by process kill on timeout, and treats stdin-close/exit 0 as the
clean terminal path.

### Default command

```text
omp --mode rpc --auto-approve
```

No session or title flags: RPC mode already disables title generation, and persisted omp sessions
remain useful post-mortem evidence alongside Symphonika's own run logs.

### Normalized event mapping (initial)

- `agent_start` → `session_started`
- `message_update` text/thinking deltas → `message`
- `tool_execution_start` → `tool_call`
- `turn_end` → `turn_completed`
- `agent_end` then process exit → `process_exit`
- usage-bearing events → `usage_updated`
- `extension_ui_request` (`confirm`, `input`, `select`) → `input_required`, failing the attempt
  per SPEC §11.4; headless runs with `--auto-approve` should not emit these, and the mapping is
  defense-in-depth.

For the Watchdog (SPEC §12.4): `turn_id_set_size` can advance if the adapter synthesizes turn ids
from `turn_start`/`turn_end`; otherwise `last_message_at`, `output_tokens_total`, and workspace
mtime signals apply unchanged.

### Schema and touchpoints

- `AgentProviderName` and all four `providerNameSchema` sites gain `"omp"`.
- The `providers:` object gains `omp: providerCommandSchema.optional()` — optional so existing
  two-provider configs remain valid; `reload.ts` and `dispatch.ts` thread it through only when
  present.
- `src/providers/omp.ts` implements `AgentProvider`; the daemon registry registers it when the
  `omp` binary and command validate.
- `doctor` validates the omp command for Routine Hosts and Dispatch Projects that select it:
  binary resolvable on PATH plus a ready-frame handshake probe.
- `symphonika init` scaffolds the `omp` block when the binary is on PATH;
  `add-routine --provider` and SPEC §11.3/§6 gain `omp` alongside `codex` and `claude` in the same
  implementing slice.

## Consequences

- Once implemented, operators declare `providers.omp.command` and route Dispatch Projects,
  Routine Hosts, and individual Routines with `agent.provider: omp` / routine `provider: omp`.
- The v1 requirement to support both Codex and Claude is preserved; omp is strictly additive.
- Until implementation lands, an `omp:` block under `providers:` in `symphonika.yml` parses
  cleanly but is ignored by reload and dispatch, and `agent.provider: omp` remains a validation
  error.
