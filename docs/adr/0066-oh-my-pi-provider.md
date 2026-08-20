# Oh My Pi (omp) as a third Agent Provider

Status: Accepted

## Context

Symphonika originally supported Codex through JSON-RPC `app-server` mode and Claude through its
`stream-json` CLI mode. Operators also use Oh My Pi (`omp`) as a local coding harness and need to
dispatch it from Projects, Workflow states, and Routines without losing streaming evidence or
in-band cancellation.

OMP exposes a native headless protocol that fits the existing `AgentProvider` boundary:

- `omp --mode rpc` speaks newline-delimited JSON over stdio, beginning with a versioned `ready`
  frame and continuing with id-correlated commands and streamed Agent Session events.
- Protocol v2 adds bounded `rpc_chunk` frames for logical messages that exceed the physical frame
  limit; protocol v1 remains usable when v2 is not advertised.
- `prompt` starts agent work, `abort` cancels it, terminal `agent_end` drains the session, and
  closing stdin disposes the RPC host.
- `omp --auto-approve` prevents tool-approval prompts and matches Symphonika's full-permission,
  unattended execution posture.

## Decision

Adopt OMP as the third Agent Provider using its native RPC protocol. Codex and Claude remain
supported; OMP is additive.

### Protocol

The adapter:

1. launches OMP from the Workspace cwd;
2. validates the `ready` frame and negotiates protocol v2 when advertised;
3. sends `get_state` and records the session id, session file, and model;
4. delivers the rendered Autonomous Prompt with `prompt`;
5. streams raw frames and normalized events until a terminal `agent_end`;
6. closes stdin, records the child exit, and unconditionally stops the provider process scope.

Protocol v2 chunks are decoded as strict base64, checked against the advertised physical limit and
the effective logical limit, reassembled in order, and retained as raw evidence alongside the
reconstructed logical frame. The effective logical limit is the smaller of OMP's advertised
`maxReassembledFrameBytes` and a fixed daemon-local 64 MiB ceiling. A larger advertisement remains
compatible, but a chunk declaring a logical frame above the effective limit is malformed. Missing,
mismatched, out-of-order, invalid, or oversized chunks are malformed provider events. The advertised
physical `maxFrameBytes` remains the independently enforced limit for individual frames and is not
subject to the daemon-local logical-frame ceiling; a larger physical advertisement remains
compatible, including for a v1-only OMP that never negotiates chunking.

The initial normalized mapping is:

- successful `get_state` response -> `session_started`
- text and thinking `message_update` deltas -> `message`
- assistant `message_end` usage -> `usage_updated`
- `tool_execution_start` -> `tool_call`
- `turn_end` -> `turn_completed`
- assistant errors, error notices, failed commands, or `agentInvoked: false` -> `turn_failed`
- interactive `extension_ui_request` methods -> `input_required`
- child close -> `process_exit`

OMP does not expose a stable turn id in Agent Session events, so the adapter does not synthesize
one. Message, token-usage, tool-call, and Workspace-mtime signals still advance the Watchdog.

### Default command

```text
omp --mode rpc --auto-approve
```

The command uses normal `PATH` resolution. Generated configuration must not persist a
machine-specific path such as `~/.bun/bin/omp`. Operators who install OMP through Bun must run
`symphonika service install` from a login shell whose `PATH` contains Bun's bin directory.

Provider validation requires RPC mode (`--mode rpc`, selected exactly once), rejects print mode, and
performs a bounded ready-frame probe without sending a model prompt. It does not require
`--auto-approve`/`--approval-mode yolo` specifically: which approval policy the command runs under is
the operator's own choice, not a value Symphonika's static validation enforces (see ADR-0015's
amendment note and SPEC.md §11.3). The default command above still carries `--auto-approve` as
Symphonika's recommended posture.

### Configuration

`AgentProviderName`, Project schemas, Workflow actions and provider inputs, Routine declarations,
CLI parsing, and runtime command selection include `omp`.

`providers.omp` is optional so existing two-provider Service Configs remain valid. Newly generated
configs always include:

```yaml
providers:
  omp:
    command: "omp --mode rpc --auto-approve"
```

Selecting OMP without configuring `providers.omp.command` is a deterministic
`provider_command_missing: omp` failure. `doctor` validates OMP only when a Project or Routine
selects it, just as it validates the other selected providers.

### Cancellation

Cancellation is latched before the asynchronous process-scope setup so a pre-spawn cancellation
cannot be lost. Once spawned, cancellation sends a correlated `abort`, closes stdin, and escalates
to `SIGTERM` after a short grace period. Successful, failed, and cancelled attempts all stop their
provider process scope.

## Alternatives rejected

- OMP print/JSON mode loses streaming liveness, tool evidence, and in-band cancellation.
- ACP would add a generic editor protocol client while discarding useful native OMP events.
- Requiring `providers.omp` in all existing configs would make an additive provider a breaking
  migration.
- Hardcoding the current user's OMP path would make generated configuration host-specific and
  bypass the service installer's established `PATH` contract.

## Consequences

- Dispatch Projects, Workflow agent states, Routine Hosts, and individual Routines can select OMP.
- Raw logs preserve physical RPC frames; normalized logs expose provider-neutral lifecycle events.
- OMP may advertise a larger logical-frame limit, but one Run can never negotiate more than the
  daemon-local 64 MiB reassembly ceiling.
- OMP input requests fail unattended runs rather than waiting forever for an operator.
- Existing configs without an OMP block continue to load.
- The service environment must expose `omp`, including `~/.bun/bin` for common Bun installations.
