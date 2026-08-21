# Doctor execution-environment reporting

Status: Accepted

## Context

`doctor` validates the Service Config, Project tracker access, Workflow Contracts, Routine
declarations, provider protocol shape, and installed systemd unit structure without dispatching
work. Those checks did not expose whether the process environment could resolve a selected provider
command, whether the Codex headless profile carried its required full-permission keys, whether the
local `gh` CLI was authenticated independently of a Project token, or whether the PATH frozen into
an installed unit could still resolve the tools the daemon launches.

The installed-unit distinction matters because `service install` captures PATH once. A manual
`doctor` run can resolve a newly installed runtime while the already-installed daemon still uses a
stale version-manager directory.

## Decision

`runDoctor` always adds a typed Doctor Execution Environment report to `DoctorReport`:

- For every distinct `agent.provider` selected by a configured Project, render the configured
  command through `renderProviderCommandTemplate`, parse it with the providers' shared command
  parser, and resolve the resulting executable under the invoking environment. An unresolved
  executable is an error because dispatch cannot start it.
- When a Project selects Codex, parse `~/.codex/config.toml` as TOML and report independent checks
  for `profiles.symphonika.sandbox_mode = "danger-full-access"` and
  `profiles.symphonika.approval_policy = "never"`. A missing file or profile therefore yields two
  actionable missing-key results rather than only a generic profile error. This complements ADR
  0042's provider probe: the adapter still validates the actual app-server behavior, while the
  environment report exposes the declared key values directly.
- Resolve `gh` under the invoking PATH and run `gh auth status`. The report distinguishes
  `not_installed`, `unauthenticated`, and `authenticated`. `doctor --offline` still resolves `gh`
  and performs every local check, but records `skipped_offline` instead of making the auth-status
  call.
- When `symphonika.service` is installed, read its effective `Environment=PATH=...` assignment and
  resolve every selected provider executable plus `gh` against that frozen value. Failures are
  warnings, because an operator may intentionally pin PATH and the invoking shell is not
  authoritative for the daemon. Each warning names the executable that is unavailable.
- `doctor --json` emits the same `DoctorReport` as one JSON value on stdout. It does not select a
  different check set; failure still produces a nonzero process exit status.

The check remains observational. It does not install binaries, authenticate `gh`, edit the Codex
profile, rewrite the systemd unit, or persist a capability manifest.

## Alternatives considered

- Reimplementing command tokenization in `doctor` was rejected because it could drift from the
  command that provider adapters actually spawn.
- Checking installed-unit tools against the invoking shell PATH was rejected because it would miss
  the version-manager drift this feature is intended to detect.
- Making frozen-unit PATH failures hard errors was rejected because the unit may intentionally pin
  a different environment and the daemon can remain healthy for unaffected providers.
- Persisting the report for other commands to consume was rejected until a concrete runtime
  consumer needs a capability manifest.

## Consequences

- A normal doctor run can fail before dispatch when a selected provider, Codex profile key, `gh`
  executable, or `gh` authentication is unavailable.
- Scripted and CI callers can consume stable structured evidence and can suppress only the
  network-backed `gh auth status` probe.
- Operators with a stale installed PATH get specific warnings while retaining the existing
  structural drift diagnostics from ADRs 0064 and 0065.
