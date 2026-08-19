# YAML error position formatting design

Issue #441 supplies the approved behavior: a located YAML syntax error must not report both the
parser's substring-relative position and Symphonika's offset-corrected position. This note records
the implementation choice at the existing `locatedYamlErrorMessage` public seam.

## Public interface

`locatedYamlErrorMessage(error, lineOffset)` remains the shared formatter for routine declaration
front matter, Workflow Contract front matter, and raw-FSM YAML. When the parser exposes `linePos`,
the returned message contains exactly one line/column annotation: Symphonika's canonical
`(line N, column N)` suffix, with `lineOffset` applied. Errors without `linePos` remain unchanged.

The formatter preserves the parser's human-readable reason and source snippet. It removes only the
parser-generated `at line N, column N:` clause that precedes that snippet, because this clause uses
the parser input's coordinate system and may contradict the corrected suffix.

## Approaches considered

### Normalize the message in `locatedYamlErrorMessage`

This is the selected approach. All current located YAML syntax-error paths already use the helper,
so central normalization fixes each caller and preserves their existing offsets without changing
the parser contract at multiple sites.

### Disable pretty errors at each YAML parse call

Each caller could pass `{ prettyErrors: false }` to `parse()`. This would avoid embedded positions,
but it duplicates parser configuration across three call sites and discards the useful source
snippet for every surfaced syntax error.

### Reconstruct the message from parser-specific fields

The formatter could ignore `error.message` and assemble output from `code`, `source`, and other
parser fields. This is more tightly coupled to the `yaml` error object's internal shape and would
need to recreate message wording that the parser already maintains.

## Test seam and success criteria

The behavior test calls exported `locatedYamlErrorMessage` with an actual `yaml` parser error. Its
known front-matter-style offset example asserts the complete coordinate outcome independently:
the result contains the corrected line once and contains no parser-style `at line ..., column ...`
annotation. Existing tests retain coverage for no-offset locations, offset arithmetic, errors
without `linePos`, and non-`Error` thrown values.

No specification, domain-language, or ADR update is required: this is a conformance fix to
SPEC section 14 and ADR-0076's existing located-error contract, not a new product or architecture
decision.
