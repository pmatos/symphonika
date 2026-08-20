# Oh My Pi provider implementation design

Status: Implemented

## Context

ADR 0066 selected Oh My Pi (`omp`) as Symphonika's third Agent Provider and selected native RPC mode,
but PR #335 deliberately stopped at the proposal. Before this implementation, provider types,
config schemas, command selection, workflow actions, Routine overrides, prompts, and the default
adapter registry were closed over Codex and Claude. A configured `providers.omp` entry was therefore
inert, and `agent.provider: omp` was rejected.

The installed OMP 17.1.8 CLI confirms that `omp --mode rpc --auto-approve` exposes the required
headless protocol. It starts in protocol v1 with a versioned `ready` frame, advertises supported
protocol versions and frame limits, accepts id-correlated commands, streams Agent Session events,
and supports protocol v2 chunking for large logical frames.

## Decision

Implement OMP as a native RPC Agent Provider. Preserve the existing Codex and Claude requirements;
OMP is strictly additive. Existing Service Configs may omit `providers.omp`, while newly generated
configs always include:

```yaml
omp:
  command: "omp --mode rpc --auto-approve"
```

Commands use normal `PATH` resolution. Symphonika does not persist a host-specific absolute OMP
binary path. The existing service installer remains responsible for capturing the operator's
working `PATH`, including Bun's binary directory when that is how OMP was installed.

## Public seams

The implementation and tests use three public seams:

- `AgentProvider` for command validation, attempt streaming, normalized events, cancellation, and
  process termination.
- Service configuration and CLI entry points for initialization, reload, doctor, dispatch,
  Workflow state routing, and Routine provider overrides.
- Operator-facing generated configuration and documentation, plus a bounded real OMP startup
  handshake that never sends a model prompt.

Private frame parsing and event-mapping helpers are tested only through `AgentProvider`.

## Adapter lifecycle

`src/providers/omp.ts` implements `AgentProvider` and follows the existing process-scope lifecycle:

1. Register an active-run placeholder before awaiting the provider-scope wrapper so cancellation
   cannot be lost during the asynchronous scope probe.
2. Spawn the configured command in the Workspace cwd with piped stdin, stdout, and stderr.
3. Read the versioned `ready` frame. Reject missing or unsupported protocol metadata.
4. If protocol v2 is advertised, send `negotiate_protocol` and require a successful correlated
   response. Otherwise continue with protocol v1.
5. Send `get_state`; emit `session_started` from its `sessionId`, model, and session-file data.
6. Send the rendered Autonomous Prompt with the `prompt` command and require its correlated
   acknowledgement. A response that reports `agentInvoked: false` is a deterministic turn failure
   because a Symphonika Run must execute the coding agent.
7. Stream Agent Session events until a terminal `agent_end`. An `agent_end` carrying
   `isTerminal: false` is non-terminal because asynchronous delivery will resume the session.
8. Close stdin after terminal completion. OMP drains accepted work, disposes the session, and exits;
   the adapter emits `process_exit` from the child close event.
9. Unconditionally stop the provider process scope in `finally`, including ordinary successful
   completion, so detached descendants cannot outlive the Run.

OMP protocol v2 `rpc_chunk` frames are reassembled in order from strict base64 chunks. The adapter
enforces the ready frame's advertised physical limit without applying the logical ceiling to that
advertisement. The effective logical limit is the smaller of its advertised logical limit and
Symphonika's fixed 64 MiB daemon-local ceiling. Advertising more remains compatible, but declaring
a logical frame above the effective limit is malformed. The adapter also rejects
interrupted, out-of-order, mismatched, invalid, or oversized sequences and parses the reconstructed
JSON object before event mapping. Protocol v1 remains supported when the ready frame advertises
only v1.

## Normalized events

The initial mapping is:

- successful `get_state` response -> `session_started`
- `message_update` with `text_delta` or `thinking_delta` -> `message`, preserving the delta and
  whether it is text or thinking
- `message_end` for an assistant message with usage -> `usage_updated`
- `tool_execution_start` -> `tool_call`
- `turn_end` -> `turn_completed`
- assistant error events, error notices, failed command responses, or prompt completion without an
  invoked agent -> `turn_failed`
- interactive `extension_ui_request` methods (`select`, `confirm`, `input`, `editor`, or
  `open_url`) -> `input_required`
- child-process or framing errors -> `turn_failed` or `malformed_event` as appropriate
- child close -> `process_exit`

Non-interactive UI notifications such as widget, status, title, editor-text, cancel, and notify
updates remain raw-only evidence. All protocol frames remain in the raw Provider Event Log even
when they have no normalized counterpart.

OMP does not expose a stable turn identifier in its current Agent Session events. The adapter does
not invent one. Watchdog progress is supplied by message timestamps, tool-call timestamps, token
usage, and Workspace mtime; `turn_id_set_size` remains unchanged for OMP.

## Cancellation and failures

`cancel(runId)` latches cancellation even before spawn. After spawn it sends a correlated `abort`
command, closes stdin so OMP drains the abort, and escalates to process termination after a short
bounded grace period. Cancellation during provider-scope probing emits a cancelled `process_exit`
without spawning OMP.

An input request or deterministic protocol failure stops the provider process and lets the existing
Run lifecycle classify the normalized terminal event. Non-zero exits and signals retain the shared
provider-exit classification. Cancellation, terminal failure, and success all run provider-scope
cleanup.

Stderr is drained to prevent child-process backpressure. It is included in validation error
messages where useful but is not mixed into the stdout JSON protocol stream.

## Configuration and validation

`AgentProviderName`, Workflow action types, prompt inputs, Routine declarations, all provider-name
schemas, CLI provider parsing, and runtime command lookup gain `omp`.

`providers.omp` is optional in service parsing and runtime snapshots so existing two-provider
configs continue to load. Dispatch fails with the existing `provider_command_missing: omp` reason
when a Project, Workflow state, or Routine selects OMP without configuring its command.
`symphonika init` always writes the default OMP command.

OMP validation:

- parses quoted and escaped command paths consistently with existing providers;
- requires `--mode rpc` or `--mode=rpc`;
- requires `--auto-approve` or `--approval-mode yolo`;
- rejects print mode, prompt arguments, and incompatible mode flags;
- launches a bounded startup probe, validates the versioned ready frame, and closes stdin without
  sending a prompt;
- reports executable, timeout, early-exit, stderr, and protocol-compatibility failures through
  `doctor`.

Doctor validates only providers selected by Projects or Routines, matching the existing behavior.
An unused optional OMP command does not make an otherwise valid Service Config depend on OMP being
installed.

## Documentation

Implementation updates:

- `SPEC.md` configuration, Agent Provider interface, default commands, CLI syntax, doctor behavior,
  bootstrap acceptance bar, and provider-specific watchdog wording;
- `CONTEXT.md` so Agent Provider vocabulary names Codex, Claude, and OMP;
- ADR 0066 from Proposed to Accepted and removes the not-implemented caveat;
- README and smoke documentation for OMP installation, service `PATH`, validation, and execution;
- the tutorial prerequisites, generated configuration, provider selection, setup, smoke run, and
  provider-switching section.

The tutorial explains that a Bun-installed OMP commonly resolves from `~/.bun/bin`, and that
`service install` must be run from a login environment whose `PATH` contains that directory.

## TDD sequence

Implementation proceeded in vertical red-green slices:

1. An OMP provider test drives a successful ready/negotiate/state/prompt/event/exit transcript.
2. Provider tests drive v1 fallback, v2 chunk reconstruction, malformed frames, failed responses,
   interactive input, cancellation before spawn, cancellation after spawn, and process-scope
   cleanup.
3. Validation tests drive accepted flags and executable, mode, permission, timeout, early-exit, and
   handshake failures.
4. Config and CLI tests drive optional legacy config loading, deterministic `init` output, doctor
   selection, dispatch, Workflow action routing, and Routine overrides.
5. A bounded local smoke probe launches the installed OMP command, observes a valid ready frame,
   and closes stdin without invoking a model.
6. Documentation and source-of-truth updates land after the executable behavior works.

Every test observes a public seam and uses fixed protocol fixtures as the independent expected
values. Fake OMP processes stand in only for the external CLI process boundary.

## Alternatives rejected

- OMP print/JSON mode is smaller but discards streaming liveness, granular tool evidence, and
  in-band cancellation.
- ACP would create a generic protocol client outside this feature's scope and would discard useful
  native OMP events.
- Requiring `providers.omp` in every existing config would turn an additive provider into a
  breaking configuration migration.
- Hardcoding `/home/pmatos/.bun/bin/omp` would make generated configs host-specific and bypass the
  service installer's established `PATH` contract.

## Success criteria

The change is complete when:

- Dispatch Projects, Workflow agent states, Routine Hosts, and individual Routines can select OMP.
- OMP attempts stream normalized evidence, update Watchdog signals, cancel reliably, and clean up
  their provider process scopes.
- Old configs without `providers.omp` remain valid, while `init` always scaffolds the OMP command.
- `doctor` provides deterministic diagnostics for usable and unusable OMP commands.
- SPEC, CONTEXT, ADR, README, smoke documentation, and tutorial describe working behavior rather
  than proposed future support.
- Focused tests, the bounded real handshake, formatting, lint, typecheck, the full test suite, and
  the production build pass.
