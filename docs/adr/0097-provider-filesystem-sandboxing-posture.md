# Provider filesystem sandboxing posture

Status: Accepted

## Context

ADR-0015 makes full-permission execution the default for Codex, Claude, and Oh My Pi, while allowing
operators to author different provider commands. It also puts future sandboxing outside providers.
That left two plausible interim directions: make Claude's provider-specific `--permission-mode auto`
the default even though Codex and OMP have no equivalent, or wrap every provider in an OS-level
filesystem sandbox such as `bwrap`.

The sibling `pewpew` project provides concrete evidence about the second option. Its read-only-host
`bwrap` boundary had to keep discovering and granting mutable provider state paths under
`~/.claude`, including session and task state, while keeping global settings, credentials, hooks,
and `~/.claude.json` protected. A missing writable path failed an otherwise valid provider launch;
widening the writable bind to the whole state directory required a growing read-only denylist and
weakened the simplicity of the boundary. `pewpew` ultimately moved Claude to
`--permission-mode auto` while retaining `bwrap` for Codex and OMP. That is useful implementation
experience, but its interactive session-manager threat model does not require Symphonika to adopt
the same provider-specific default.

## Decision

- Keep ADR-0015's full-permission provider defaults unchanged.
- Do not make Claude's `--permission-mode auto` an interim Symphonika default. It remains a valid
  operator-authored command override under ADR-0015, and static provider validation continues to
  check wire-protocol compatibility rather than allowlist permission-policy values.
- Defer `bwrap` filesystem sandboxing. The `pewpew` experience does not rule it out permanently,
  but it shows that a safe default needs an explicit state-path and compatibility contract rather
  than a growing set of reactive bind exceptions.
- Any future filesystem sandbox belongs outside the Agent Provider boundary. Its policy should
  apply consistently to Codex, Claude, and OMP even when the wrapper needs provider-specific path
  discovery. A provider-specific permission mode is not a substitute for that provider-neutral
  host boundary.

Revisit the decision when the risk calculus changes or an implementation can identify and validate
the writable authentication, configuration, session, cache, temporary, Git, and workspace paths for
every supported provider; preserve required read access without making credentials or global
execution settings writable; compose with the existing process-scope and PID-isolation wrappers;
and expose unsupported hosts or degraded fallback behavior to operators.

## Alternatives considered

- **Claude `auto` by default now:** rejected because it creates a provider-specific default,
  changes ADR-0015's posture for only one provider, and is provider-mediated permission behavior
  rather than filesystem isolation. Operators may still choose it explicitly.
- **`bwrap` now:** rejected because the writable-path inventory is not yet a stable contract. A
  narrow inventory makes valid provider behavior fail as paths evolve; broad home or state-directory
  binds make the apparent boundary misleading.
- **Treat the `pewpew` result as proof that `bwrap` can never work:** rejected because Codex and OMP
  still run successfully under its wrapper. The evidence justifies deferral and explicit entry
  criteria, not a permanent ban.

## Consequences

- Generated commands and runtime behavior do not change in this decision slice.
- Codex, Claude, and OMP continue to run with full local filesystem access by default; that risk is
  explicit and remains governed by the repository workflow and host credentials.
- Provider PID isolation remains an adjacent process-visibility boundary and does not imply
  filesystem isolation or a provider permission-policy change.
- A future sandbox proposal must define the host boundary and provider state-path contract before
  changing defaults; parity means consistent policy and degradation semantics, not identical argv
  or identical state directories.
