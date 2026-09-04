# `isDefinitelyInvalidSystemdMemoryValue` scope freeze

Status: Accepted

## Context

`isDefinitelyInvalidSystemdMemoryValue` (`src/doctor.ts`) exists for one job:
`winningByteSizeAssignment` uses it to decide whether a later `MemoryMax=` drop-in is text systemd
itself would reject and ignore. When it is, the doctor's provider build-memory capacity check
(`checkProviderBuildMemoryCapacity`, `SPEC.md:2430`) must fall back to the last assignment still in
force instead of reading a ceiling from dead text. It is a fallback-eligibility classifier, not the
capacity check's value parser — `parseSystemdByteSize`, unchanged throughout this history, is the
parser, and its scope is exactly what `SPEC.md:2430` documents: "`MemoryMax=` (bytes or a K/M/G/T
suffix)". A form the classifier recognizes as effective-but-unparseable (a percentage, `1024B`, `2P`,
`1G 500M`) is deliberately never computed into a byte count; it just stops the fallback from skipping
past it.

That classifier has been narrowed three times over issues #644 → #658 → #665 → PR #673, each round
triggered by an automated reviewer finding a real, `systemd-analyze verify`-confirmed form the
classifier misjudged. #658 explicitly deferred the signed (`+64G`) and compact-compound (`64G512M`)
gap, on the record that closing it "needs a full tokenizer... disproportionate to SPEC.md's
documented scope... for a doctor warning whose job is deciding which line to read a ceiling from, not
fully re-implementing systemd's memory-value grammar," filed to be revisited "if it turns out to
matter in practice... without blocking on chasing every remaining systemd grammar corner." PR #673,
opened to close that deferred gap, went considerably further across ~11 commits — full
percent/permille/permyriad support, hex/octal/binary integer-literal parsing, native-uint64-wraparound
arithmetic, UTF-8 BOM stripping, and whitespace-class edge cases — each commit a direct response to a
fresh `claude[bot]`/`chatgpt-codex-connector` finding of a real, empirically-confirmed systemd
behavior the classifier still misjudged. Every one of those findings was real; none was invented. But
`claude[bot]` also flagged, twice, that the PR's cumulative shape was scope creep against both #665's
minimal ask and CLAUDE.md's "prefer small vertical slices" guidance — the same conclusion #658's own
deferral had already reached about this exact predicate. This is a structural loop: an automated
reviewer's job is to find the next real gap, and a near-complete grammar has near-infinite real gaps
left to find (the newest, filed as #694, is `+0o1%`/`-0o0.01%`/`+0b1%` being accepted when real
systemd rejects them, because `mangle_base()`'s `0b`/`0o` prefix check runs before sign consumption).
Following that loop indefinitely turns a "which drop-in line wins" classifier into a permanent,
open-ended reimplementation of `parse_size()`/`percent-util.c`.

#694 asked the maintainer to choose one of: (1) keep chasing full grammar parity, (2) trim the
classifier back to #665's original two forms and treat the rest as known gaps, or (3) freeze scope now
and only extend it further from evidence of real operator impact.

## Decision

**Option 3.** PR #673's already-shipped fidelity is kept as-is — reverting tested, empirically-verified
correctness (option 2) would reintroduce false-positive fallbacks for percentage/compound forms real
`MemoryMax=` configs do use, trading a known-correct behavior for a narrower but less accurate one, for
no benefit beyond a smaller diff. But the trajectory stops here: **grammar-fidelity findings against
`isDefinitelyInvalidSystemdMemoryValue` — a form this classifier misjudges relative to real systemd
behavior, discovered by an automated reviewer or by manual `systemd-analyze verify` probing — are
DEFER by default, not fixed on discovery.** Record the gap (a comment at the call site or a tracking
issue is enough) and move on. The one exception already in flight when this ADR was written — the
`+0o1%`/`-0o0.01%`/`+0b1%` signed-prefix bug #694 itself surfaced — is fixed alongside this ADR because
it was already confirmed and scoped before the freeze decision was made, not as a precedent for fixing
the next one the same way.

A finding only overrides the default and justifies a fix when there is **evidence of practical
impact**: an operator's real `MemoryMax=` drop-in observed to hit the gap, not a synthetic probe
against `systemd-analyze verify` constructed to prove the classifier's grammar is incomplete somewhere
(it always is; `parse_size()`/`percent-util.c` is large and this classifier is not attempting to be
its complete reimplementation).

Byte-value parsing (`parseSystemdByteSize`) is unaffected by this freeze and stays scoped to
`SPEC.md:2430`'s "bytes or a K/M/G/T suffix" — this ADR only concerns the separate
fallback-eligibility classifier, which by design already recognizes forms `parseSystemdByteSize` can't
compute.

## Consequences

- The next automated-reviewer round against this predicate (near-certain, per the last three rounds'
  pattern) should cite this ADR and defer, not fix — including from the run that opens the PR closing
  #694. Fixing it anyway reproduces the exact scope-creep loop this ADR exists to stop.
- `SPEC.md:2430` continues to document only the K/M/G/T byte-parsing scope; it is not being widened to
  describe the classifier's now-frozen, broader-than-K/M/G/T grammar recognition. This ADR is that
  documentation instead, addressing `claude[bot]`'s repeated "SPEC.md wasn't updated" finding on PR
  #673 without re-scoping SPEC.md itself.
- If a real operator-observed gap does surface later, the fix should be scoped to that one gap (as
  #694's signed-prefix fix was), not treated as license to resume general grammar-parity work.
