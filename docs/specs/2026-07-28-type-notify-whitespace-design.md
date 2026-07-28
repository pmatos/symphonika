# Type=notify drift-matcher whitespace design

Status: Approved for implementation

## Context

PR #328 changes the installed-systemd-unit drift check so an explanatory
comment containing `Type=notify` cannot satisfy the watchdog marker check.
The initial line-anchored matcher is byte-exact, however, and rejects active
directives that systemd accepts with indentation, trailing whitespace, or
whitespace around `=`.

## Decision

Match an active `Type=notify` directive with a line-anchored regular
expression that permits only horizontal whitespace around the key, separator,
and value:

```text
^[ \t]*Type[ \t]*=[ \t]*notify[ \t]*$
```

The matcher deliberately uses `[ \t]` instead of `\s`. In JavaScript, `\s`
also matches line terminators, which could allow a match to cross line
boundaries and weaken the active-line guarantee.

Lines beginning with `#` or `;` remain excluded because the first
non-whitespace token must be `Type`.

## Testing

Add a public `runDoctor` regression using an installed unit whose active
directive is `  Type = notify  `. The unit must not produce the watchdog
installation warning when all other watchdog markers are present.

Retain the existing regression where `Type=notify` appears only in a comment
beside an active `Type=simple` directive. That case must continue to produce
the warning.

## Alternatives considered

- Split the file into lines and normalize each line before matching. This is
  valid but adds iteration and normalization code for one structural marker.
- Introduce a general systemd-unit parser. This would be disproportionate to
  the narrow drift check and is outside PR #328.

## Scope and success criteria

Only `src/doctor.ts` and `tests/doctor.test.ts` need implementation changes.
No configuration, public API, specification, ADR, or generated unit changes
are required.

The change succeeds when:

- comment-only occurrences still trigger the watchdog drift warning;
- systemd-valid horizontal whitespace around `Type=notify` does not trigger
  the warning;
- the targeted doctor tests and repository quality checks pass.
